#!/usr/bin/env python3
"""One reviewed network-only adoption/revocation for the installed dev OFF lane.

Reader/gateway remain OFF. No provider profile, admission, token, SQL, production
service or source is changed. The only installed changes are one dev nft file,
three hosts files and three network drop-ins. Revocation loads the exact OFF nft
transaction before draining dev processes; expired authorization never blocks it.
"""
from datetime import datetime, timezone
import argparse
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys

import dev_native_install as n

NATIVE_SHA = '34d237636b9cb158b95064f15f1f3d916277afdf5761b4edc19d37d26e9cd319'
OFF_MANIFEST_SHA = '5b706f74740677b65274d29a3081a0dc3aaab0e99472c774fa35a3bc6fe3f39c'
RENDERER_SHA = '3837be3d12e6df16648d21057841072f3b97f38bddec1b9cf596684ecc71e61a'
SHARED_SHA = '86327dc5efe6e55b75705d7ed9695deaabf0dddee0388c80dbb9b8a48bd48357'
POLICY = '/etc/domino/dev/off-policy.nft'
ROLES = n.infra.ROLES
EXTRA = {f'/etc/domino/dev/{role}/hosts' for role in ROLES} | {
    f'/etc/systemd/system/{n.infra.USERS[role]}.service.d/50-dev-egress.conf' for role in ROLES}
TARGETS = EXTRA | {POLICY}


def renderer():
    here = Path(__file__).resolve().parent
    for name, digest in [('egress_policy', SHARED_SHA), ('dev_egress_policy', RENDERER_SHA)]:
        path = here / (name + '.py')
        n.need(n.sha(n.read(path)) == digest, 'network_renderer_source_drift')
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules['dev_egress_policy']


def load(directory, digest):
    directory = Path(directory)
    s = directory.lstat()
    n.parents(directory / 'result.json')
    n.need(stat.S_ISDIR(s.st_mode) and (s.st_uid, stat.S_IMODE(s.st_mode)) == (0, 0o700), 'network_directory_not_private')
    n.need(n.HEX.fullmatch(digest) is not None, 'invalid_result_hash')
    result = n.checked_document(directory / 'result.json', digest)
    source = renderer()
    snapshot = source.parse(n.read(directory / 'snapshot.json', mode=0o600, maximum=source.MAX_BYTES))
    generated = datetime.fromisoformat(result['generatedAt'])
    n.need(n.encode(source.render(snapshot, now=generated)) == n.encode(result), 'network_result_not_rederived')
    n.need(result['profile'] == 'continuous_operator_pins' and result['offManifestSha256'] == OFF_MANIFEST_SHA
           and set(result['artifacts']) == TARGETS and set(result['artifactMetadata']) == TARGETS,
           'network_scope_mismatch')
    for path, text in result['artifacts'].items():
        n.need(result['artifactSha256'][path] == n.sha(text.encode()) and result['artifactMetadata'][path]
               == {'uid': 0, 'gid': 0, 'mode': 0o600 if path == POLICY else 0o644}, 'network_artifact_mismatch')
    return {'path': directory, 'digest': digest, 'result': result, 'snapshot': snapshot, 'renderer': source}


def authorization(bundle, *, adoption=True):
    current = n.parse(n.read(bundle['path'] / 'authorization.json', mode=0o600, maximum=4096))
    n.need(current == bundle['snapshot']['operatorAuthorization'] and current['revoked'] is False,
           'network_authorization_changed')
    now = datetime.now(timezone.utc)
    stamp = lambda value: datetime.fromisoformat(value.replace('Z', '+00:00'))
    n.need(stamp(current['grantedAt']) <= now < stamp(current['expiresAt']), 'network_authorization_expired')
    if adoption:
        # DNS freshness gates initial selection only; the selected continuous
        # pins subsequently remain bounded by the operator's absolute expiry.
        bundle['renderer'].validate(bundle['snapshot'], now)


def scope(c, bundle):
    profile = n.parse(c['files']['/etc/domino/dev/gateway/profile.json']['bytes'])
    snapshot = bundle['snapshot']
    n.need(snapshot['accessIssuer'] == profile['issuer'].removeprefix('https://'), 'network_issuer_not_installed')
    # The existing reviewed operator manifest is the configured host inventory;
    # the renderer's larger public allowlist alone does not grant another RPC.
    approved = set(c['baseline']['manifest']['pins']) & bundle['renderer'].RPC_HOSTS
    n.need(bool(snapshot['rpcHosts']) and set(snapshot['rpcHosts']) <= approved
           and (snapshot['inventoryHost'] is None or snapshot['inventoryHost'] in approved),
           'network_rpc_not_operator_configured')


def table_shape(value, *, expired=False):
    """Discard runtime counters/handles and TTL countdown, never rule semantics."""
    def clean(v):
        if isinstance(v, list): return [clean(x) for x in v]
        if isinstance(v, dict):
            out = {k: clean(x) for k, x in v.items() if k not in ('handle', 'packets', 'bytes', 'expires')
                   and not (expired and k == 'elem')}
            # nft sets have no element order; rule/expression list order matters.
            if isinstance(out.get('elem'), list): out['elem'] = sorted(out['elem'], key=n.encode)
            return out
        return v
    return clean(n.clean_kernel(value))


def prepared(bundle, c):
    root = bundle['path'] / 'prepared'
    root.mkdir(mode=0o700)
    for target, text in bundle['result']['artifacts'].items():
        path = root / target.lstrip('/')
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        n.write_new(path, text.encode())
    n.write_new(root / 'off.nft', c['files'][POLICY]['bytes'])
    return root


def namespace_shape(host, path):
    # Actual loads are isolated. Two loads cover replacement of the existing table.
    code = ('import json,subprocess,sys\n'
            'for _ in range(2): subprocess.run(["/usr/sbin/nft","-f",sys.argv[1]],check=True,capture_output=True)\n'
            'print(subprocess.check_output(["/usr/sbin/nft","-j","list","table","inet","domino_dev_off"]).decode())')
    return n.parse(host.run(['/usr/bin/unshare', '--net', '--', '/usr/bin/python3', '-I', '-B', '-c', code, str(path)]).encode())


def table_guard(host, expected, *, expired=False):
    actual = n.parse(host.run(['/usr/sbin/nft', '-j', 'list', 'table', 'inet', 'domino_dev_off']).encode())
    n.need(table_shape(actual, expired=expired) == table_shape(expected, expired=expired), 'dev_network_table_drift')


def guard(c, bundle, host, state, *, positive=False, partial=False):
    host.production(c, dev=True, extra=state['productionExtra'])
    n.need(state['phase'] == 'installed_off', 'native_off_not_installed')
    # These exact bytes preserve the OFF flags, admission and credential boundary.
    for path, item in c['files'].items():
        raw = n.read(path, mode=item['mode'], uid=item['uid'], gid=item['gid'], parent_owners=(0, item['uid']))
        values = [item['bytes']]
        if path == POLICY and positive and not partial:
            values = [bundle['result']['artifacts'][path].encode()]
        elif path == POLICY and partial:
            values.append(bundle['result']['artifacts'][path].encode())
        n.need(raw in values, 'off_artifact_drift')
    for unit in n.UNITS:
        loaded = host.properties(unit, ('FragmentPath', 'DropInPaths', 'MainPID', 'ActiveState'))
        is_role = unit in {n.infra.USERS[r] + '.service' for r in ROLES}
        dropin = f'/etc/systemd/system/{unit}.d/50-dev-egress.conf'
        allowed = [dropin] if positive and not partial else ['', dropin] if partial else ['']
        n.need(loaded['FragmentPath'] == '/etc/systemd/system/' + unit and loaded['DropInPaths']
               in (allowed if is_role else ['']), 'network_loaded_unit_drift')
        if unit == n.infra.USERS['tunnel'] + '.service':
            n.need(loaded.get('MainPID', '0') == '0' and loaded['ActiveState'] == 'inactive', 'connector_not_inactive')
    for role, (uid, _) in ROLES.items():
        unit = n.infra.USERS[role] + '.service'
        dropin = f'/etc/systemd/system/{unit}.d/50-dev-egress.conf'
        for path in (f'/etc/domino/dev/{role}/hosts', dropin):
            if os.path.lexists(path):
                n.need(positive or partial, 'network_artifact_already_present')
                n.need(n.read(path, mode=0o644, parent_owners=(0, uid)) == bundle['result']['artifacts'][path].encode(),
                       'unknown_network_artifact')
            else:
                n.need(not positive or partial, 'network_artifact_missing')
        folder = Path(dropin).parent
        if folder.exists():
            n.need(positive or partial, 'network_dropin_directory_present')
            s = folder.lstat()
            n.need(stat.S_ISDIR(s.st_mode) and (s.st_uid, s.st_gid, stat.S_IMODE(s.st_mode)) == (0, 0, 0o755)
                   and {p.name for p in folder.iterdir()} <= {'50-dev-egress.conf'}, 'unknown_network_dropin_directory')
    n.need(not os.path.lexists('/run/domino-dev-connector.reviewed'), 'connector_marker_present')


def install_files(bundle):
    for path, text in bundle['result']['artifacts'].items():
        if path == POLICY: continue
        target = Path(path)
        if '.service.d' in path:
            target.parent.mkdir(mode=0o755); os.chmod(target.parent, 0o755)
        uid = next(uid for role, (uid, _) in ROLES.items() if path == f'/etc/domino/dev/{role}/hosts') if path.endswith('/hosts') else 0
        n.parents(target, (0, uid))
        n.archive.exclusive_file(target, text.encode(), 0o644, 0, 0)
        n.archive.fsync_directory(target.parent)
    n.replace(POLICY, bundle['result']['artifacts'][POLICY].encode())


def revoke(c, bundle, host, state, *, recovery=False):
    info = state.get('network', {})
    n.need(info.get('resultSha256') == bundle['digest'], 'network_journal_binding')
    n.need(info.get('phase') in ('adopting', 'revoking', 'positive_network_off_apps'), 'network_journal_phase')
    guard(c, bundle, host, state, positive=True, partial=recovery)
    root = bundle['path'] / 'prepared'
    n.need(n.read(root / 'off.nft', mode=0o600) == c['files'][POLICY]['bytes'], 'off_rollback_source_drift')
    expected = info.get('positiveKernel')
    n.need(expected is not None and info.get('offKernel') is not None, 'network_kernel_journal_missing')
    # Expiring elements may disappear. After the absolute rule deadline only,
    # element inventory is irrelevant to permission; all chains/rules still match.
    expired = datetime.now(timezone.utc) >= datetime.fromisoformat(bundle['result']['expiresAt'].replace('Z', '+00:00'))
    if recovery:
        actual = n.parse(host.run(['/usr/sbin/nft', '-j', 'list', 'table', 'inet', 'domino_dev_off']).encode())
        n.need(table_shape(actual) == table_shape(info['offKernel']) or
               table_shape(actual, expired=expired) == table_shape(expected, expired=expired), 'unknown_recovery_table')
    else:
        table_guard(host, expected, expired=expired)
    info['phase'] = 'revoking'; n.journal(c, state)
    # Revoke FIRST, even for established flows. No service drain can delay it.
    host.run(['/usr/sbin/nft', '-f', str(root / 'off.nft')])
    try:
        n.replace(POLICY, c['files'][POLICY]['bytes'])
    finally:
        host.drain()
    table_guard(host, info['offKernel'])
    for path in EXTRA:
        target = Path(path)
        if os.path.lexists(target):
            uid = next(uid for role, (uid, _) in ROLES.items() if path == f'/etc/domino/dev/{role}/hosts') if path.endswith('/hosts') else 0
            n.need(n.read(target, mode=0o644, parent_owners=(0, uid)) == bundle['result']['artifacts'][path].encode(), 'unknown_network_artifact')
            target.unlink(); n.archive.fsync_directory(target.parent)
        if '.service.d' in path and target.parent.exists():
            n.need(not list(target.parent.iterdir()), 'unknown_network_dropin_directory')
            target.parent.rmdir(); n.archive.fsync_directory(target.parent.parent)
    host.run(['/usr/bin/systemctl', 'daemon-reload'])
    n.installed_known(c, host)
    host.production(c, dev=True, extra=state['productionExtra'])
    info['phase'] = 'revoked_off_stopped'; n.journal(c, state)


def apply(c, bundle, host, state):
    n.need('network' not in state, 'network_adoption_already_journaled')
    authorization(bundle)
    guard(c, bundle, host, state)
    host.off_health()
    root = prepared(bundle, c)
    positive_path = root / POLICY.lstrip('/')
    host.run(['/usr/sbin/nft', '--check', '-f', str(positive_path)])
    off_kernel, positive_kernel = namespace_shape(host, root / 'off.nft'), namespace_shape(host, positive_path)
    table_guard(host, off_kernel)
    authorization(bundle)
    state['network'] = {'resultSha256': bundle['digest'], 'phase': 'adopting',
                        'offKernel': off_kernel, 'positiveKernel': positive_kernel}
    n.journal(c, state)
    try:
        host.drain()
        install_files(bundle)
        host.run(['/usr/bin/systemd-analyze', 'verify', *['/etc/systemd/system/' + n.infra.USERS[r] + '.service' for r in ROLES]])
        host.run(['/usr/bin/systemctl', 'daemon-reload'])
        guard(c, bundle, host, state, positive=True)
        authorization(bundle)
        # Only dev policy + the two unchanged OFF services are dependencies.
        host.run(['/usr/sbin/nft', '-f', str(positive_path)])
        host.run(['/usr/bin/systemctl', 'start', 'domino-dev-off.target'])
        host.off_health()
        authorization(bundle, adoption=False)
        guard(c, bundle, host, state, positive=True)
        table_guard(host, positive_kernel)
        state['network']['phase'] = 'positive_network_off_apps'
        n.journal(c, state)
    except BaseException:
        try: revoke(c, bundle, host, state, recovery=True)
        except BaseException: raise n.Refused('network_adoption_failed_cleanup_incomplete') from None
        raise n.Refused('network_adoption_failed_revoked') from None


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('mode', choices=('apply', 'revoke'))
    p.add_argument('--native-candidate', type=Path, required=True)
    p.add_argument('--network', type=Path, required=True)
    p.add_argument('--result-sha256', required=True)
    args = p.parse_args()
    try:
        n.need(os.geteuid() == 0 and not sys.flags.optimize, 'root_without_optimization_required')
        os.umask(0o077)
        c = n.candidate(args.native_candidate, NATIVE_SHA)
        n.need(c['plan']['manifestSha256'] == OFF_MANIFEST_SHA, 'off_manifest_mismatch')
        bundle = load(args.network, args.result_sha256)
        scope(c, bundle)
        with n.locked():
            state = n.journal(c); host = n.Native()
            if args.mode == 'apply': apply(c, bundle, host, state)
            else: revoke(c, bundle, host, state,
                         recovery=state.get('network', {}).get('phase') in ('adopting', 'revoking'))
        print(json.dumps({'ok': True, 'mode': args.mode, 'resultSha256': bundle['digest'],
                          'liveEnabled': False, 'connectorSelected': False, 'nativeBoundaryQualified': False}))
    except (OSError, ValueError, TypeError, KeyError):
        p.exit(1, 'Development network operation refused; inspect the private journal.\n')


if __name__ == '__main__': main()
