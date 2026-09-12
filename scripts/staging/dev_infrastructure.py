#!/usr/bin/env python3
"""Render a development-only OFF bundle. Never installs, executes, or enables it.

Inputs contain only reviewed release and non-secret Access identity metadata.
Provider credentials, connector tokens and approved quota receipts are deliberately
absent. The existing production supervisor and manifest are not rewritten.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re

VERSION = 1
ROOT = '/etc/domino/dev'
STATE = '/var/lib/domino-dev'
CODE = '/opt/domino/dev/releases'
PYTHON = '/opt/domino/backend-venv/bin/python3.14'
CLOUDFLARED = '/opt/domino/cloudflared/2026.9.0/cloudflared'
POLICY = 'domino_dev_off'
ROLES = {'reader': (974, 8890), 'gateway': (975, 8891), 'tunnel': (976, 20242)}
USERS = {'reader': 'domino-dev-read', 'gateway': 'domino-dev-gateway', 'tunnel': 'domino-dev-tunnel'}
READS = ('token', 'pools', 'pool-market', 'wallet-assets', 'nft-positions', 'catalogue', 'pool-activity')
FIELDS = {'version', 'releaseCommit', 'contractManifestSha256', 'issuer', 'audience', 'serviceId'}
HEX40 = re.compile(r'[a-f0-9]{40}')
HEX64 = re.compile(r'[a-f0-9]{64}')


class InvalidPlan(ValueError):
    pass


def need(ok):
    if not ok:
        raise InvalidPlan('invalid_development_off_plan')


def canonical(value):
    return (json.dumps(value, indent=2, sort_keys=True) + '\n').encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def checked(value):
    need(type(value) is dict and set(value) == FIELDS)
    need(type(value['version']) is int and value['version'] == VERSION)
    need(all(type(value[k]) is str for k in FIELDS - {'version'}))
    need(HEX40.fullmatch(value['releaseCommit']) is not None)
    need(HEX64.fullmatch(value['contractManifestSha256']) is not None)
    need(HEX64.fullmatch(value['audience']) is not None)
    need(re.fullmatch(r'https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com', value['issuer']) is not None)
    need(re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', value['serviceId']) is not None)
    return dict(value)


def policy():
    scope = 'inet ' + POLICY
    lines = ['# OFF: only the three new UIDs; no provider, DNS or edge permissions.',
             'add table ' + scope, 'delete table ' + scope, 'add table ' + scope,
             f'add chain {scope} output {{ type filter hook output priority 11; policy accept; }}']
    for role, (uid, listener) in ROLES.items():
        lines += [f'add chain {scope} {role}', f'add counter {scope} denied_{role}',
                  f'add rule {scope} output meta skuid {uid} jump {role}']
        prefix = f'add rule {scope} {role} '
        lines.append(prefix + 'oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 '
                     f'tcp sport {listener} ct direction reply ct state established counter accept')
        if role == 'gateway':
            lines.append(prefix + 'oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 '
                         'tcp dport 8890 ct direction original counter accept')
        # Even the independent connector has no origin/edge admission in OFF.
        lines.append(prefix + f'counter name denied_{role} drop')
    return ('\n'.join(lines) + '\n').encode()


def unit(role, release):
    user = USERS[role]
    code = CODE + '/' + release
    runtime = STATE + ('/dev-read-gateway' if role == 'gateway' else '/' + role)
    maximum = {'reader': '512M', 'gateway': '192M', 'tunnel': '128M'}[role]
    command = {
        'reader': f'{PYTHON} -B {code}/backend/dev_read_service.py',
        'gateway': f'{PYTHON} -B {code}/backend/dev_read_gateway.py --profile {ROOT}/gateway/profile.json --runtime-dir {runtime} --port 8891 --reader-port 8890',
        'tunnel': f'{CLOUDFLARED} tunnel --config {ROOT}/tunnel/config.yml --no-autoupdate --loglevel info --metrics 127.0.0.1:20242 --grace-period 20s --management-diagnostics=false run --token-file ${{CREDENTIALS_DIRECTORY}}/dev-tunnel-token',
    }[role]
    # Keep sibling imports used by the backend, with no inherited proxy/token
    # environment and no per-user Python site packages.
    command = '/usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 PYTHONNOUSERSITE=1 ' + command
    lines = ['[Unit]', f'Description=Domino development {role} (OFF candidate)',
             'BindsTo=domino-dev-egress.service', 'After=domino-dev-egress.service',
             'PartOf=domino-dev-off.target', 'ConditionPathExists=/run/domino-dev-off.ready']
    if role == 'gateway':
        lines += ['Requires=domino-dev-read.service', 'After=domino-dev-read.service']
    if role == 'tunnel':
        # This marker is not emitted or created by any unit in this bundle.
        lines.append('ConditionPathExists=/run/domino-dev-connector.reviewed')
    lines += ['StartLimitIntervalSec=120', 'StartLimitBurst=3', '', '[Service]',
              'Type=simple', f'User={user}', f'Group={user}', 'Slice=dominodev.slice',
              f'WorkingDirectory={code}', f'ExecStart={command}', 'Restart=no',
              'UMask=0077', 'NoNewPrivileges=yes', 'CapabilityBoundingSet=',
              'AmbientCapabilities=', 'ProtectSystem=strict', 'ProtectHome=yes',
              'PrivateTmp=yes', 'PrivateDevices=yes', 'ProtectKernelTunables=yes',
              'ProtectKernelModules=yes', 'ProtectControlGroups=yes',
              'ProtectKernelLogs=yes', 'ProtectClock=yes', 'RestrictSUIDSGID=yes',
              'RestrictNamespaces=yes', 'LockPersonality=yes', 'RestrictRealtime=yes',
              'RestrictAddressFamilies=AF_UNIX AF_INET', 'IPAddressDeny=any',
              'IPAddressAllow=127.0.0.1/32', 'ProtectProc=invisible',
              'ProcSubset=pid', 'LimitNOFILE=512', 'TasksMax=32',
              f'MemoryMax={maximum}', 'MemorySwapMax=0', 'TimeoutStopSec=30',
              'KillMode=control-group', 'SendSIGKILL=yes',
              'UnsetEnvironment=HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy SSL_CERT_FILE SSL_CERT_DIR REQUESTS_CA_BUNDLE CURL_CA_BUNDLE PYTHONPATH PYTHONHOME',
              f'ReadWritePaths={runtime}',
              # Directory bind makes the operator's atomic file replacement
              # visible while denying a compromised service write access.
              f'BindReadOnlyPaths={ROOT}/{role}',
              'InaccessiblePaths=/opt/domino/releases /etc/domino/continuous-reads /etc/domino/credentials /etc/domino/dev/tunnel-private /root /home',
              'LimitCORE=0', 'SystemCallArchitectures=native']
    if role == 'tunnel':
        lines.append('LoadCredential=dev-tunnel-token:/etc/domino/dev/tunnel-private/token')
    for other in ROLES:
        if other != role:
            lines.append(f'InaccessiblePaths={ROOT}/{other}')
    if role == 'reader':
        lines += ['SupplementaryGroups=domino-db', 'ReadOnlyPaths=/run/postgresql-domino']
    else:
        lines.append('InaccessiblePaths=/run/postgresql-domino')
    return ('\n'.join(lines) + '\n').encode()


def generate(spec):
    spec = checked(spec)
    files = {}

    def add(path, raw, mode=0o644, uid=0, gid=0):
        need(path not in files and path.startswith(('/etc/domino/dev/', '/etc/systemd/system/')))
        files[path] = {'bytes': raw, 'mode': mode, 'uid': uid, 'gid': gid}

    add(ROOT + '/off-policy.nft', policy(), 0o600)
    add('/etc/systemd/system/dominodev.slice', b'''[Unit]
Description=Bounded development read resources

[Slice]
CPUQuota=50%
CPUWeight=10
IOWeight=10
MemoryHigh=768M
MemoryMax=1G
MemorySwapMax=0
TasksMax=64
''')
    add('/etc/systemd/system/domino-dev-egress.service', b'''[Unit]
Description=Development OFF egress only
Before=domino-dev-read.service domino-dev-gateway.service domino-dev-tunnel.service
PartOf=domino-dev-off.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/domino/dev/off-policy.nft
ExecStartPost=/usr/bin/touch /run/domino-dev-off.ready
ExecStop=/usr/bin/rm -f /run/domino-dev-off.ready
# Stopping retains the restrictive table; never flush host or production rules.
UMask=0077
ProtectSystem=strict
ReadWritePaths=/run
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
CapabilityBoundingSet=CAP_NET_ADMIN
RestrictAddressFamilies=AF_NETLINK
''')
    add('/etc/systemd/system/domino-dev-off.target', b'''[Unit]
Description=Explicitly started development OFF reader and gateway
Requires=domino-dev-egress.service domino-dev-read.service domino-dev-gateway.service
After=domino-dev-egress.service domino-dev-read.service domino-dev-gateway.service
# No Install section, connector dependency, timer, or automatic startup.
''')
    for role in ROLES:
        add('/etc/systemd/system/' + USERS[role] + '.service', unit(role, spec['releaseCommit']))
    gateway = {'version': 1, 'issuer': spec['issuer'], 'audience': spec['audience'],
               'serviceId': spec['serviceId'], 'gatewayPort': 8891, 'readerPort': 8890,
               'readerCommit': spec['releaseCommit'], 'gatewayCommit': spec['releaseCommit'],
               'contractManifestSha256': spec['contractManifestSha256'],
               'requestsPerMinute': 6, 'burst': 2}
    add(ROOT + '/gateway/profile.json', canonical(gateway), 0o600, 975, 975)
    add(ROOT + '/gateway/admission.json', canonical({'version': 1, 'enabled': False,
        'serviceId': spec['serviceId'], 'expiresAt': 0}), 0o600, 975, 975)
    add(ROOT + '/tunnel/config.yml', b'# Deliberately empty: reviewed remote ingress is a separate gate.\n{}\n', 0o600, 976, 976)
    # No provider URLs, quota approval, connector token or Windows Access secret.
    requirements = {
        'reader': {'profile': ROOT + '/reader/profile.json', 'writtenBy': 'operator_only',
                   'runtimeDirectory': STATE + '/reader', 'ownerUid': 974, 'fileMode': 0o600,
                   'notEmitted': True, 'requiredOnlyForSeparatelyReviewedEnable': True},
        'tunnel': {'config': ROOT + '/tunnel/config.yml', 'token': ROOT + '/tunnel-private/token',
                   'tokenOwnerUid': 0, 'fileMode': 0o600, 'tokenNotEmitted': True,
                   'credentialMechanism': 'systemd_LoadCredential_restart_on_rotation'},
        'windowsServiceSecret': {'vmStorageAllowed': False},
    }
    directories = [{'path': ROOT, 'mode': 0o755, 'uid': 0, 'gid': 0},
                   {'path': STATE, 'mode': 0o755, 'uid': 0, 'gid': 0},
                   {'path': ROOT + '/tunnel-private', 'mode': 0o700, 'uid': 0, 'gid': 0}]
    for role, (uid, _) in ROLES.items():
        directories += [{'path': ROOT + '/' + role, 'mode': 0o700, 'uid': uid, 'gid': uid},
                        {'path': STATE + ('/dev-read-gateway' if role == 'gateway' else '/' + role),
                         'mode': 0o700, 'uid': uid, 'gid': uid}]
    manifest = {'version': 1, 'kind': 'domino-development-infrastructure-off',
        'releaseCommit': spec['releaseCommit'], 'contractManifestSha256': spec['contractManifestSha256'],
        'enabled': False, 'connectorSelected': False, 'providerPermissions': [],
        'productionChanges': [], 'installationPerformed': False,
        'roles': {r: {'user': USERS[r], 'uid': u, 'gid': u, 'port': p,
                     'shell': '/usr/sbin/nologin', 'homeDirectory': '/nonexistent',
                     'systemAccount': True, 'lockedPassword': True,
                     'supplementaryGroups': ['domino-db'] if r == 'reader' else []}
                  for r, (u, p) in ROLES.items()},
        'directories': directories, 'privateInputs': requirements,
        'files': [{'target': p, 'mode': v['mode'], 'uid': v['uid'], 'gid': v['gid'],
                   'sha256': sha(v['bytes'])} for p, v in sorted(files.items())]}
    return files, manifest


def procedure(manifest):
    """Hashed review instructions, not a live or generic installer."""
    return {'version': 1, 'kind': 'domino-dev-off-apply-rollback-review-plan',
        'manifestSha256': sha(canonical(manifest)),
        'liveApplyImplemented': False,
        'productionBaseline': {
            'manifestSha256': 'd11a98ff236d6b7088d3a2ade1fdec932286180a9130ee94fc3f319a0a36e659',
            'readerCommit': '0aebebc184355c8168fab67e9241c91765301840',
            'gatewayCommit': '807afe399fd250a6db83a4014aadf64d7e9af543',
            'table': 'domino_continuous_reads', 'target': 'domino-continuous-reads.target'},
        'applyOrder': [
            'Independent review of exact backend and this generated manifest; no implicit approval from metadata.',
            'Native read-only preflight of baseline, unused identities/ports/targets, full unit dependencies, source/venv/binary hashes, DB inventory, and all host firewall chains.',
            'Bind a private operator candidate to baseline snapshot, source/archive hashes, new file hashes/modes, SQL snapshot and rollback guard. Do not reuse an old production installer.',
            'Stage absent root-controlled source/config/runtime paths and system users; install only the declared OFF files with exact target ownership/modes.',
            'Privileged role and peer changes require the separately reviewed snapshot-pinned SQL/peer plan and old/private identity negatives. Ordinary production upgrade guards stay strict.',
            'Run static systemd merged-unit verification and nft validation in a disposable network namespace before starting services.',
            'If authorized to qualify OFF listeners, start only the new OFF target and bounded diagnostic children. Inspect actual cgroup BPF and mounts; check disabled responses, RO directory mount and atomic admission visibility, sibling-secret/production-port denials.',
            'Record unchanged production files/PIDs/restarts/policy and new installed hashes. No connector, provider egress, enable flag, timer, boot enablement or Access mapping is selected by this plan.'],
        'rollbackOrder': [
            'Atomically set development gateway admission disabled; revoke dedicated Access service identity if it was ever provisioned. Never modify production admission.',
            'Stop only domino-dev-off.target, domino-dev-read.service, domino-dev-gateway.service, domino-dev-tunnel.service and domino-dev-egress.service; prove their cgroups empty.',
            'Retain the restrictive domino_dev_off table for the fixed dev UIDs; never flush shared or production rules.',
            'Restore the exact reviewed prior peer bytes and use matched dev SQL rollback only with zero active dev sessions and an exact known post-state; no CASCADE or private data cleanup.',
            'Retain inert files and receipts for assessment. Refuse unknown operator changes; do not delete or rewind databases, credentials, production units or source/runtime.'],
        'remainingBeforeEnable': ['provider quota reservation and expiry receipt',
            'dedicated Access issuer/AUD/service and revocation proof',
            'separate exact-path dev Tunnel mapping and token delivery',
            'reviewed positive network policy, hostname pins and new connector origin/edge/JWKS permissions',
            'native same-UID/cgroup/mount positive and negative probes',
            'new private reader profile and reviewed explicit enable selection',
            'Windows same-origin HMR with actual supported data and secret/artifact/revocation negatives']}


def write_bundle(spec, output):
    files, manifest = generate(spec)
    output = Path(output)
    # Exclusive creation; never treat existing operator output as disposable.
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    for target, data in files.items():
        path = output / 'rootfs' / target.lstrip('/')
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with path.open('xb') as stream:
            stream.write(data['bytes'])
        path.chmod(0o600)  # Packaging permissions, not claimed installed ownership.
    raw = canonical(manifest)
    with (output / 'manifest.json').open('xb') as stream:
        stream.write(raw)
    (output / 'manifest.json').chmod(0o600)
    plan_raw = canonical(procedure(manifest))
    with (output / 'procedure.json').open('xb') as stream:
        stream.write(plan_raw)
    (output / 'procedure.json').chmod(0o600)
    return {'generated': True, 'installed': False, 'enabled': False,
            'files': len(files), 'manifestSha256': sha(raw), 'procedureSha256': sha(plan_raw)}


def load_spec(path):
    raw = Path(path).read_bytes()
    need(len(raw) <= 4096)
    def pairs(items):
        result = {}
        for key, value in items:
            need(key not in result)
            result[key] = value
        return result
    return checked(json.loads(raw, object_pairs_hook=pairs))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--spec', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(write_bundle(load_spec(args.spec), args.output)))
    except (OSError, ValueError, TypeError):
        parser.exit(1, 'Development OFF generation refused; check non-secret spec and new output path.\n')


if __name__ == '__main__':
    main()
