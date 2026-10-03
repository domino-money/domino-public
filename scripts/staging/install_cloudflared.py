#!/usr/bin/env python3
"""Install the reviewed cloudflared connector, its unit and transport drop-in. Starts nothing.

docs/CLOUDFLARED_STAGING.md describes this installation as a manual procedure;
this performs it. The binary is the operator-downloaded release asset, checked
against scripts/cloudflared/release.json (size and SHA256) and never executed
here. The unit and connector configuration are the reviewed files beside that
manifest. The 40 drop-in is the first VM's transport allow-list: loopback, the
stub resolver and the official edge inventory egress_policy.py carries.

The token is not touched: the unit loads it from /etc/domino/credentials, which
the owner provides in the secrets phase. The same token on two hosts makes two
connectors share the traffic, so this unit is started only at cutover.

`--sealed-token` also writes the 45 drop-in, which hands the unit the token as a
credential sealed to this host (`systemd-creds encrypt --with-key=host+tpm2
--name=cloudflared-token`) under the same id, instead of the plain file the first
VM used. The empty assignment drops the base unit's plain LoadCredential.
"""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import platform
import pwd
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import egress_policy
import prepare_disabled as install

require = install.require
SOURCES = Path(__file__).resolve().parents[1] / 'cloudflared'
ROOT = install.BASE / 'cloudflared'
UNIT = install.UNIT_DIR / 'domino-tunnel.service'
DROP_IN = install.UNIT_DIR / 'domino-tunnel.service.d/40-connector-transport.conf'
SEALED_DROP_IN = install.UNIT_DIR / 'domino-tunnel.service.d/45-sealed-token.conf'
SEALED_TOKEN = Path('/etc/domino/credentials/cloudflared-token.cred')
SEALED_TEXT = f'[Service]\nLoadCredential=\nLoadCredentialEncrypted=cloudflared-token:{SEALED_TOKEN}\n'


def transport_drop_in():
    edges = sorted((address for addresses in egress_policy.EDGE_ADDRESSES.values() for address in addresses),
                   key=ipaddress.IPv4Address)
    return '\n'.join([
        '# Owner-authorized connector transport only; application services remain stopped.',
        '# Static official Cloudflare edge inventory, not provider DNS/TTL qualification.',
        '[Unit]', 'ConditionPathExists=/run/domino-tunnel-transport.ready',
        '[Service]', 'IPAddressAllow=', 'IPAddressDeny=', 'IPAddressDeny=any',
        'IPAddressAllow=127.0.0.1/32', 'IPAddressAllow=127.0.0.53/32',
        *(f'IPAddressAllow={address}/32' for address in edges)]) + '\n'


def plan(binary, sealed=False):
    release = json.loads((SOURCES / 'release.json').read_text())
    require(release['platform'] == 'linux-amd64' and platform.machine() == 'x86_64', 'platform_mismatch')
    payload = Path(binary).read_bytes()
    require(len(payload) == release['size'] and hashlib.sha256(payload).hexdigest() == release['sha256'],
            'cloudflared_asset_mismatch')
    version = ROOT / release['version']
    for path in (ROOT, UNIT, DROP_IN.parent):
        require(not os.path.lexists(path), 'tunnel_installation_exists')
    pwd.getpwnam('domino-tunnel')
    return {'mode': 'cloudflared', 'version': release['version'], 'sha256': release['sha256'],
            'binary': str(version / 'cloudflared'), 'config': str(version / 'connector.yml'),
            'unit': str(UNIT), 'dropIn': str(DROP_IN), 'sealedToken': str(SEALED_TOKEN) if sealed else None,
            'notPerformed': ['binary execution', 'token or credential', 'unit enable or start', 'tunnel login']}


def apply(binary, planned):
    require(os.geteuid() == 0, 'root_required')
    install.trusted_parents(install.BASE)
    version = Path(planned['binary']).parent
    ROOT.mkdir(mode=0o755)
    os.chmod(ROOT, 0o755)
    version.mkdir(mode=0o755)
    install.exclusive_file(version / 'cloudflared', Path(binary).read_bytes(), 0o555)
    install.exclusive_file(version / 'connector.yml', (SOURCES / 'connector.yml').read_bytes(), 0o444)
    os.chmod(version, 0o555)
    install.exclusive_file(UNIT, (SOURCES / 'domino-tunnel.service').read_bytes(), 0o644)
    DROP_IN.parent.mkdir(mode=0o755)
    os.chmod(DROP_IN.parent, 0o755)
    install.exclusive_file(DROP_IN, transport_drop_in().encode(), 0o644)
    if planned['sealedToken']:
        install.exclusive_file(SEALED_DROP_IN, SEALED_TEXT.encode(), 0o644)
    require(hashlib.sha256((version / 'cloudflared').read_bytes()).hexdigest() == planned['sha256'],
            'installed_binary_changed')
    install.run(['/usr/bin/systemctl', 'daemon-reload'])
    return {**planned, 'ok': True, 'installed': True, 'next': 'the token in the secrets phase; start at cutover'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True, help='the downloaded release asset')
    parser.add_argument('--sealed-token', action='store_true', help='load the token sealed to this host')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--inspect', action='store_true')
    mode.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    try:
        planned = plan(args.binary, args.sealed_token)
        result = apply(args.binary, planned) if args.apply else {**planned, 'ok': True, 'installed': False}
        print(json.dumps(result, indent=2))
        return 0
    except Exception as error:
        reason = str(error) if isinstance(error, ValueError) else type(error).__name__
        print(json.dumps({'ok': False, 'reason': reason, 'action': 'nothing started; inspect partial paths'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
