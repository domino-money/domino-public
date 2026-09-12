#!/usr/bin/env python3
"""One operator-bound enable/revoke for the already adopted development lane.

The private package is reviewed by its external SHA256. No credentials, provider
responses or configuration contents reach output. Revoke closes admission and
loads the exact OFF policy before stopping the known development units.
"""
import argparse
from datetime import datetime, timezone
import importlib.util
import os
from pathlib import Path
import re
import stat
import sys
import time
from urllib.parse import urlsplit

import dev_native_install as n

NETWORK_SHA = '096a3c4f1a3f42b17272b55e6e733cd851142c6f6a67e13dc08ad53f5809e82d'
SERVICE_ID = '9cb8a2a315832dcfcc768e7774a054ae.access'
ISSUER = 'https://ordio-hq.cloudflareaccess.com'
AUDIENCE = '3a33330dbc1b9c80d0e39246aaccdf4eaaba3115ff01b070f53f81ee9cb004f4'
READER = '/etc/domino/dev/reader/profile.json'
GATEWAY = '/etc/domino/dev/gateway/profile.json'
ADMISSION = '/etc/domino/dev/gateway/admission.json'
TUNNEL = '/etc/domino/dev/tunnel/config.yml'
TOKEN = '/etc/domino/dev/tunnel-private/token'
MARKER = '/run/domino-dev-connector.reviewed'
ROLES = n.infra.ROLES
DROPINS = {r: '/etc/systemd/system/' + n.infra.USERS[r] + '.service.d/60-enable.conf' for r in ROLES}
TARGETS = {READER, GATEWAY, ADMISSION, TUNNEL, *DROPINS.values()}
STAGES = frozenset({'drain', 'install_artifacts', 'verify_units', 'verify_configuration',
                    'start_readers', 'start_connector', 'await_identity', 'final_checks', 'complete'})
FAILURE_CODES = frozenset({
    'enable_start_timeout', 'enable_process_uid_drift', 'enable_effective_identity_drift',
    'enable_effective_cgroup_drift', 'enable_effective_command_drift', 'enable_effective_boundary_drift',
    'enable_installed_artifact_drift', 'enable_installed_artifact_missing', 'enable_loaded_unit_drift',
    'enable_network_artifact_drift', 'enable_network_artifact_missing', 'enable_role_directory_drift',
    'enable_override_directory_drift', 'enable_override_directory_missing', 'unknown_enable_override',
    'runtime_development_override', 'unexpected_enable_override', 'connector_marker_drift',
    'connector_marker_missing', 'connector_credential_metadata', 'connector_credential_binding',
    'network_authorization_changed', 'network_authorization_expired', 'dev_network_table_drift',
    'native_command_failed', 'native_output_limit', 'dev_not_stopped', 'dev_cgroup_not_empty',
    'development_process_present', 'development_port_busy', 'unsafe_parent', 'unsafe_file',
    'file_changed_during_read', 'production_manifest_drift', 'production_file_drift',
    'production_unit_drift', 'production_not_active', 'production_process_or_unit_bytes_drift',
    'production_kernel_drift', 'enable_unclassified_failure'})


def network_module():
    path = Path(__file__).resolve().with_name('dev_network_off.py')
    n.need(n.sha(n.read(path)) == NETWORK_SHA, 'network_operation_source_drift')
    spec = importlib.util.spec_from_file_location('dev_network_off', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def enable_dropin(role):
    # Derive the exact reviewed base argv instead of maintaining another CLI.
    unit = n.infra.unit(role, n.RELEASE).decode()
    command = next(line for line in unit.splitlines() if line.startswith('ExecStart='))
    if role == 'reader':
        command += ' --enable --profile /run/domino-dev-reader-config/profile.json'
    elif role == 'gateway':
        command += ' --enable'
    return ('[Service]\nExecStart=\n' + command + '\n').encode()


def metadata(path):
    uid = 974 if path == READER else 975 if path in (GATEWAY, ADMISSION) else 976 if path == TUNNEL else 0
    return {'uid': uid, 'gid': uid, 'mode': 0o644 if path in DROPINS.values() else 0o600}


def stamp(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    n.need(parsed.tzinfo is not None and parsed.utcoffset() is not None, 'invalid_enable_expiry')
    return parsed


def endpoint(value, hosts):
    n.need(type(value) is str and len(value) <= 1536, 'invalid_reader_endpoint')
    parts = urlsplit(value)
    n.need(all(33 <= ord(c) <= 126 for c in value) and '\\' not in value and
           parts.scheme == 'https' and parts.netloc == parts.hostname and parts.hostname in hosts
           and not parts.query and not parts.fragment, 'invalid_reader_endpoint')
    pattern = r'/v2/[A-Za-z0-9_-]{1,128}' if parts.hostname == 'robinhood-mainnet.g.alchemy.com' else r'/?'
    n.need(re.fullmatch(pattern, parts.path) is not None, 'invalid_reader_endpoint')


def reader_profile(raw, bundle, expires):
    value = n.parse(raw, 8192)
    n.need(type(value) is dict and set(value) == {'version', 'kind', 'enabled', 'runtimeDirectory',
           'rpcUrls', 'inventoryUrl', 'catalogue', 'quotaQualification'} and type(value['version']) is int
           and value['version'] == 1 and value['kind'] == 'domino-development-reader'
           and value['enabled'] is True and value['runtimeDirectory'] == '/var/lib/domino-dev/reader',
           'reader_profile_scope')
    urls = value['rpcUrls']
    n.need(type(urls) is list and 1 <= len(urls) <= 3 and all(type(u) is str for u in urls)
           and len(set(urls)) == len(urls), 'reader_endpoint_inventory')
    for url in urls: endpoint(url, set(bundle['snapshot']['rpcHosts']))
    inventory = value['inventoryUrl']
    if inventory is not None:
        n.need(bundle['snapshot']['inventoryHost'] == 'robinhood-mainnet.g.alchemy.com', 'inventory_not_admitted')
        endpoint(inventory, {'robinhood-mainnet.g.alchemy.com'})
    q = value['quotaQualification']
    n.need(type(q) is dict and set(q) == {'approved', 'expiresAt', 'receiptSha256'} and q['approved'] is True
           and type(q['expiresAt']) is int and q['expiresAt'] == expires
           and type(q['receiptSha256']) is str and n.HEX.fullmatch(q['receiptSha256']), 'qualification_not_bound')
    n.need(value['catalogue'] is None or value['catalogue'] ==
           {'host': '/run/postgresql-domino', 'port': 8877, 'dbname': 'domino_catalogue'}, 'catalogue_scope')


def load(directory, digest, c, bundle):
    directory = Path(directory)
    n.parents(directory / 'package.json')
    info = directory.lstat()
    n.need(stat.S_ISDIR(info.st_mode) and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode))
           == (0, 0, 0o700) and n.HEX.fullmatch(digest), 'enable_package_not_private')
    document = n.checked_document(directory / 'package.json', digest, maximum=65536)
    n.need(type(document) is dict and set(document) == {'version', 'kind', 'nativeCandidateSha256',
           'networkResultSha256', 'releaseCommit', 'authorizationId', 'expiresAt', 'tokenSha256', 'artifacts'}
           and type(document['version']) is int and document['version'] == 1
           and document['kind'] == 'domino-dev-enable-v1' and document['nativeCandidateSha256'] == c['digest']
           and document['networkResultSha256'] == bundle['digest'] and document['releaseCommit'] == n.RELEASE,
           'enable_package_binding')
    n.need(type(document['tokenSha256']) is str and n.HEX.fullmatch(document['tokenSha256']), 'invalid_token_binding')
    auth = bundle['snapshot']['operatorAuthorization']
    n.need(document['authorizationId'] == auth['authorizationId'] and document['expiresAt'] == auth['expiresAt']
           and 0 < (stamp(auth['expiresAt']) - stamp(auth['grantedAt'])).total_seconds() <= 7*24*3600,
           'enable_authorization_binding')
    expires = int(stamp(document['expiresAt']).timestamp())
    n.need(stamp(document['expiresAt']).timestamp() == expires, 'enable_expiry_not_integral')
    artifacts = document['artifacts']
    n.need(type(artifacts) is dict and set(artifacts) == TARGETS, 'enable_artifact_inventory')
    files = {}
    for target, item in artifacts.items():
        n.need(type(item) is dict and set(item) == {'text', 'sha256', 'uid', 'gid', 'mode'}
               and type(item['text']) is str and len(item['text'].encode()) <= 8192
               and all(type(item[k]) is int for k in ('uid', 'gid', 'mode'))
               and {k: item[k] for k in ('uid', 'gid', 'mode')} == metadata(target)
               and item['sha256'] == n.sha(item['text'].encode()), 'enable_artifact_mismatch')
        files[target] = {**metadata(target), 'bytes': item['text'].encode()}
    expected_gateway = n.parse(c['files'][GATEWAY]['bytes'])
    n.need(expected_gateway['issuer'] == ISSUER and expected_gateway['audience'] == AUDIENCE
           and expected_gateway['serviceId'] == 'pending-dev-provisioning', 'off_identity_mismatch')
    expected_gateway['serviceId'] = SERVICE_ID
    n.need(n.encode(n.parse(files[GATEWAY]['bytes'])) == n.encode(expected_gateway), 'gateway_identity_change_scope')
    n.need(n.encode(n.parse(files[ADMISSION]['bytes'])) == n.encode({'version': 1, 'enabled': True,
           'serviceId': SERVICE_ID, 'expiresAt': expires}), 'admission_not_bound')
    n.need(files[TUNNEL]['bytes'] == c['files'][TUNNEL]['bytes'], 'tunnel_configuration_changed')
    for role, target in DROPINS.items():
        n.need(files[target]['bytes'] == enable_dropin(role), 'enable_command_mismatch')
    reader_profile(files[READER]['bytes'], bundle, expires)
    return {'path': directory, 'digest': digest, 'document': document, 'files': files}


def source_and_identities(c, host):
    directories = {n.SOURCE: (0, 0, 0o555)}
    files = {}
    for name, (raw, executable) in c['source'].items():
        path = n.SOURCE / name
        files[path] = {'bytes': raw, 'mode': 0o555 if executable else 0o444, 'uid': 0, 'gid': 0}
        for parent in path.parents:
            if parent == n.SOURCE: break
            directories[parent] = (0, 0, 0o555)
    n.exact_tree(n.SOURCE, directories, files)
    host.staged_identities()
    host.binaries(c)
    host.check_peers(c, states=('new',))


def token_metadata(package):
    # Read only to compare the private operator-bound hash; never decode/output.
    n.parents(TOKEN)
    parent = Path(TOKEN).parent.lstat()
    info = Path(TOKEN).lstat()
    n.need((parent.st_uid, parent.st_gid, stat.S_IMODE(parent.st_mode)) == (0, 0, 0o700)
           and stat.S_ISREG(info.st_mode) and info.st_nlink == 1
           and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (0, 0, 0o600)
           and 1 <= info.st_size <= 8192, 'connector_credential_metadata')
    n.need(n.sha(n.read(TOKEN, uid=0, gid=0, mode=0o600, maximum=8192)) ==
           package['document']['tokenSha256'], 'connector_credential_binding')


def installed_file(path, item):
    return n.read(path, mode=item['mode'], uid=item['uid'], gid=item['gid'], parent_owners=(0, item['uid']))


def effective_unit(host, role, bundle, *, enabled):
    unit = n.infra.USERS[role] + '.service'
    actual = host.properties(unit, ('ExecStart', 'User', 'Group', 'WorkingDirectory', 'Slice',
                                   'IPAddressDeny', 'IPAddressAllow', 'ProtectSystem', 'ReadWritePaths'))
    raw = enable_dropin(role) if enabled else n.infra.unit(role, n.RELEASE)
    command = next(line.removeprefix('ExecStart=') for line in raw.decode().splitlines()
                   if line.startswith('ExecStart=') and line != 'ExecStart=')
    argv = re.findall(r'argv\[\]=(.*?) ; ignore_errors=no(?: ;| \})', actual['ExecStart'])
    n.need(argv == [command] and actual['ExecStart'].count('path=') == 1, 'enable_effective_command_drift')
    network_dropin = bundle['result']['artifacts']['/etc/systemd/system/' + unit + '.d/50-dev-egress.conf']
    addresses = {line.split('=', 1)[1] for line in network_dropin.splitlines()
                 if line.startswith('IPAddressAllow=') and line != 'IPAddressAllow='}
    n.need(actual['User'] == n.infra.USERS[role] and actual['Group'] == n.infra.USERS[role]
           and actual['WorkingDirectory'] == str(n.SOURCE) and actual['Slice'] == 'dominodev.slice'
           and set(actual['IPAddressDeny'].split()) == {'0.0.0.0/0', '::/0'}
           and set(actual['IPAddressAllow'].split()) == addresses and actual['ProtectSystem'] == 'strict'
           and actual['ReadWritePaths'] == '/var/lib/domino-dev/' +
               ('dev-read-gateway' if role == 'gateway' else role), 'enable_effective_boundary_drift')


def guard(c, bundle, package, host, state, *, phase):
    """Only the exact old/new transaction bytes, never a network-only OFF guard."""
    n.need(state['phase'] == 'installed_off' and state['network']['resultSha256'] == bundle['digest'],
           'enable_native_journal_binding')
    host.production(c, dev=True, extra=state['productionExtra'])
    partial = phase == 'partial'
    enabled = phase == 'enabled'
    all_files = {**c['files'], **package['files']}
    for path, item in all_files.items():
        old = c['files'].get(path)
        new = package['files'].get(path)
        if path == '/etc/domino/dev/off-policy.nft':
            values = [bundle['result']['artifacts'][path].encode()]
            if partial: values.append(old['bytes'])
        elif new:
            values = ([old['bytes']] if old else []) if phase == 'off' else [new['bytes']]
            if partial and old: values.append(old['bytes'])
        else: values = [item['bytes']]
        if os.path.lexists(path):
            n.need(installed_file(path, item) in values, 'enable_installed_artifact_drift')
        else:
            n.need(not old and (phase == 'off' or partial), 'enable_installed_artifact_missing')
    for role, (uid, _) in ROLES.items():
        for folder in ('/etc/domino/dev/' + role, '/var/lib/domino-dev/' +
                       ('dev-read-gateway' if role == 'gateway' else role)):
            info = Path(folder).lstat(); n.parents(Path(folder) / 'probe', (0, uid))
            n.need(stat.S_ISDIR(info.st_mode) and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode))
                   == (uid, uid, 0o700), 'enable_role_directory_drift')
    for path in bundle['result']['artifacts']:
        if path.endswith('.nft'): continue
        uid = next((uid for role, (uid, _) in ROLES.items() if path == '/etc/domino/dev/' + role + '/hosts'), 0)
        if os.path.lexists(path):
            n.need(n.read(path, mode=0o644, parent_owners=(0, uid)) ==
                   bundle['result']['artifacts'][path].encode(), 'enable_network_artifact_drift')
        else: n.need(partial, 'enable_network_artifact_missing')
    for unit in n.UNITS:
        role = next((r for r in ROLES if unit == n.infra.USERS[r] + '.service'), None)
        prefix = '/etc/systemd/system/' + unit
        n.need(not os.path.lexists('/run/systemd/system/' + unit + '.d'), 'runtime_development_override')
        expected = []
        if role:
            expected = [prefix + '.d/50-dev-egress.conf']
            if enabled: expected.append(DROPINS[role])
            folder = Path(prefix + '.d')
            if folder.exists():
                info = folder.lstat()
                n.need(stat.S_ISDIR(info.st_mode) and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode))
                       == (0, 0, 0o755), 'enable_override_directory_drift')
                names = {p.name for p in folder.iterdir()}
                allowed = {'50-dev-egress.conf', '60-enable.conf'} if enabled or partial else {'50-dev-egress.conf'}
                n.need(names <= allowed and (partial or names == allowed), 'unknown_enable_override')
            else: n.need(partial, 'enable_override_directory_missing')
        else: n.need(not os.path.lexists(prefix + '.d'), 'unexpected_enable_override')
        actual = host.properties(unit, ('FragmentPath', 'DropInPaths', 'MainPID', 'ActiveState'))
        loaded = actual['DropInPaths'].split()
        n.need(actual['FragmentPath'] == prefix and (set(loaded) <=
               {prefix + '.d/50-dev-egress.conf', prefix + '.d/60-enable.conf'} if partial and role
               else loaded == expected), 'enable_loaded_unit_drift')
        if role and not partial:
            effective_unit(host, role, bundle, enabled=enabled)
        if phase == 'off' and role == 'tunnel':
            n.need(actual['MainPID'] == '0' and actual['ActiveState'] == 'inactive', 'connector_already_running')
    if os.path.lexists(MARKER):
        n.need(phase != 'off' and n.read(MARKER, mode=0o600) == b'', 'connector_marker_drift')
    else: n.need(not enabled, 'connector_marker_missing')


def kernel_guard(network, bundle, host, state, *, partial=False):
    info = state['network']
    n.need(info.get('offKernel') is not None and info.get('positiveKernel') is not None, 'enable_kernel_journal_missing')
    expired = datetime.now(timezone.utc) >= stamp(bundle['result']['expiresAt'])
    if partial:
        actual = n.parse(host.run(['/usr/sbin/nft', '-j', 'list', 'table', 'inet', 'domino_dev_off']).encode())
        n.need(network.table_shape(actual) == network.table_shape(info['offKernel']) or
               network.table_shape(actual, expired=expired) == network.table_shape(info['positiveKernel'], expired=expired),
               'enable_recovery_kernel_drift')
    else: network.table_guard(host, info['positiveKernel'], expired=expired)


def restore(c, bundle, package, host):
    # Profiles return to their exact OFF bytes; the reader profile did not exist.
    for path, item in package['files'].items():
        target = Path(path)
        if path in c['files']:
            old = c['files'][path]
            n.replace(path, old['bytes'], uid=old['uid'], gid=old['gid'], mode=old['mode'], parent_owners=(0, old['uid']))
        elif os.path.lexists(target):
            target.unlink(); n.archive.fsync_directory(target.parent)
    if os.path.lexists(MARKER):
        Path(MARKER).unlink(); n.archive.fsync_directory(Path(MARKER).parent)
    for path in bundle['result']['artifacts']:
        if path.endswith('.nft'): continue
        target = Path(path)
        if os.path.lexists(target): target.unlink(); n.archive.fsync_directory(target.parent)
    for role in ROLES:
        folder = Path(DROPINS[role]).parent
        if folder.exists():
            n.need(not list(folder.iterdir()), 'enable_cleanup_override_drift')
            folder.rmdir(); n.archive.fsync_directory(folder.parent)
    host.run(['/usr/bin/systemctl', 'daemon-reload'])
    n.installed_known(c, host)


def revoke(c, bundle, package, network, host, state, *, recovery=False):
    info = state.get('enable', {})
    n.need(info.get('packageSha256') == package['digest'] and
           info.get('phase') in ('enabling', 'enabled', 'revoking') and
           state['network']['phase'] == 'enabled_apps', 'enable_revoke_journal_binding')
    guard(c, bundle, package, host, state, phase='partial' if recovery else 'enabled')
    kernel_guard(network, bundle, host, state, partial=recovery)
    off_path = bundle['path'] / 'prepared/off.nft'
    n.need(n.read(off_path, mode=0o600) == c['files'][network.POLICY]['bytes'], 'enable_off_source_drift')
    info['phase'] = 'revoking'
    # Both independent controls close before drain, even after authorization expiry.
    off_admission = c['files'][ADMISSION]
    try:
        n.journal(c, state)
    finally:
        try:
            try:
                n.replace(ADMISSION, off_admission['bytes'], uid=975, gid=975, parent_owners=(0, 975))
            finally:
                host.run(['/usr/sbin/nft', '-f', str(off_path)])
        finally:
            try:
                n.replace(network.POLICY, c['files'][network.POLICY]['bytes'])
            finally:
                host.drain()
    network.table_guard(host, state['network']['offKernel'])
    restore(c, bundle, package, host)
    host.production(c, dev=True, extra=state['productionExtra'])
    info['phase'] = 'revoked_off_stopped'
    state['network']['phase'] = 'revoked_off_stopped'
    n.journal(c, state)


def running(host):
    deadline = time.monotonic() + 15
    while True:
        ready = True
        for role, (uid, _) in ROLES.items():
            unit = n.infra.USERS[role] + '.service'
            remaining = deadline - time.monotonic()
            n.need(remaining > 0, 'enable_start_timeout')
            # Bound each systemctl call by the same total startup deadline.
            raw = host.run(['/usr/bin/systemctl', 'show', unit, '-p',
                            'MainPID,ActiveState,User,Group,ControlGroup'], timeout=min(3, remaining))
            actual = dict(line.split('=', 1) for line in raw.splitlines())
            n.need(actual['User'] == n.infra.USERS[role] and actual['Group'] == n.infra.USERS[role], 'enable_effective_identity_drift')
            if actual['ActiveState'] != 'active' or int(actual['MainPID']) <= 1:
                ready = False; continue
            n.need(actual['ControlGroup'] == '/dominodev.slice/' + unit, 'enable_effective_cgroup_drift')
            try:
                status = Path('/proc/' + actual['MainPID'] + '/status').read_text()
            except (FileNotFoundError, ProcessLookupError):
                ready = False; continue
            ids = next((line.split()[1:] for line in status.splitlines() if line.startswith('Uid:')), [])
            n.need(len(ids) == 4 and all(value in ('0', str(uid)) for value in ids), 'enable_process_uid_drift')
            # Type=simple reports active after fork, before setuid/exec. Root is
            # only a bounded setup state; no service is ready until all IDs match.
            if ids != [str(uid)] * 4: ready = False
        remaining = deadline - time.monotonic()
        n.need(remaining > 0, 'enable_start_timeout')
        if ready: return
        time.sleep(min(0.2, remaining))


def stage(c, state, value):
    n.need(value in STAGES, 'invalid_enable_stage')
    state['enable']['stage'] = value
    n.journal(c, state)


def failure_code(error):
    value = error.args[0] if type(error) is n.Refused and len(error.args) == 1 else None
    return value if type(value) is str and value in FAILURE_CODES else 'enable_unclassified_failure'


def apply(c, bundle, package, network, host, state):
    n.need('enable' not in state and state['network']['phase'] == 'positive_network_off_apps', 'enable_already_selected')
    network.authorization(bundle, adoption=False)
    guard(c, bundle, package, host, state, phase='off')
    kernel_guard(network, bundle, host, state)
    source_and_identities(c, host)
    n.need(host.snapshot_sql() == c['sql']['expectedAfter'], 'enable_sql_post_state_drift')
    token_metadata(package)
    host.off_health()
    state['enable'] = {'packageSha256': package['digest'], 'phase': 'enabling', 'stage': 'drain'}
    state['network']['phase'] = 'enabled_apps'
    n.journal(c, state)
    try:
        host.drain()
        host.listener_free()
        stage(c, state, 'install_artifacts')
        for path, item in package['files'].items():
            n.replace(path, item['bytes'], uid=item['uid'], gid=item['gid'], mode=item['mode'], parent_owners=(0, item['uid']))
        n.write_new(MARKER, b'')
        stage(c, state, 'verify_units')
        host.run(['/usr/bin/systemd-analyze', 'verify', *['/etc/systemd/system/' + n.infra.USERS[r] + '.service' for r in ROLES]])
        host.run(['/usr/bin/systemctl', 'daemon-reload'])
        stage(c, state, 'verify_configuration')
        guard(c, bundle, package, host, state, phase='enabled')
        network.authorization(bundle, adoption=False)
        token_metadata(package)
        stage(c, state, 'start_readers')
        host.run(['/usr/bin/systemctl', 'start', 'domino-dev-off.target'])
        stage(c, state, 'start_connector')
        host.run(['/usr/bin/systemctl', 'start', 'domino-dev-tunnel.service'])
        stage(c, state, 'await_identity')
        running(host)
        stage(c, state, 'final_checks')
        network.authorization(bundle, adoption=False)
        guard(c, bundle, package, host, state, phase='enabled')
        kernel_guard(network, bundle, host, state)
        state['enable']['phase'] = 'enabled'; stage(c, state, 'complete')
    except BaseException as error:
        state['enable']['failureCode'] = failure_code(error)
        try:
            # Even a failed diagnostic write must not prevent exact revocation.
            try: n.journal(c, state)
            finally: revoke(c, bundle, package, network, host, state, recovery=True)
        except BaseException: raise n.Refused('enable_failed_cleanup_incomplete') from None
        raise n.Refused('enable_failed_revoked') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('apply', 'revoke'))
    parser.add_argument('--native-candidate', type=Path, required=True)
    parser.add_argument('--network', type=Path, required=True)
    parser.add_argument('--result-sha256', required=True)
    parser.add_argument('--enable-package', type=Path, required=True)
    parser.add_argument('--package-sha256', required=True)
    args = parser.parse_args()
    try:
        n.need(os.geteuid() == 0 and not sys.flags.optimize, 'root_without_optimization_required')
        os.umask(0o077)
        network = network_module()
        c = n.candidate(args.native_candidate, network.NATIVE_SHA)
        n.need(c['plan']['manifestSha256'] == network.OFF_MANIFEST_SHA, 'enable_off_manifest_mismatch')
        bundle = network.load(args.network, args.result_sha256)
        network.scope(c, bundle)
        package = load(args.enable_package, args.package_sha256, c, bundle)
        with n.locked():
            state = n.journal(c); host = n.Native()
            if args.mode == 'apply': apply(c, bundle, package, network, host, state)
            else: revoke(c, bundle, package, network, host, state,
                         recovery=state.get('enable', {}).get('phase') in ('enabling', 'revoking'))
        print(n.encode({'ok': True, 'mode': args.mode, 'packageSha256': package['digest'],
                        'liveEnabled': args.mode == 'apply', 'providerHealth': 'not_probed',
                        'readerStartupCooldownSeconds': 60, 'nativeBoundaryQualified': False}).decode().strip())
    except (OSError, ValueError, TypeError, KeyError):
        parser.exit(1, 'Development enable operation refused; inspect the private journal.\n')


if __name__ == '__main__': main()
