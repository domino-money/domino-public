#!/usr/bin/env python3
"""Install the services host's end of the path to the Robinhood node. Starts only the proxy.

The node runs on clawber at home. Every service reaches it at 127.0.0.1:18547
(backend/discovery.py SNAPSHOT_LOOPBACK_RPC), never through a public RPC. On the
first VM that address was the listener of a reverse SSH tunnel clawber opened
into the VM over its private bridge (23 Sep 2026). A cloud host reaches clawber
over the tailnet instead, ~130 ms away, and the backend opens one connection per
call, which through the SSH tunnel cost three round trips per read (3 Oct 2026
measurement: 387 ms). So on this host 127.0.0.1:18547 is a keep-alive HTTP proxy:

- primary: direct TCP to clawber's tailnet address (a socket clawber admits from
  this host only; docs/FRESH_HOST_INSTALL.md has its unit), one round trip per
  read, p95 133 ms;
- backup: the reverse SSH tunnel, now listening on 127.0.0.1:18548, for the user
  this installs: key-only, from the peer address only, remote forwarding of that
  one port only, no shell, no TTY.

Errors the proxy generates close the connection without a response, so callers
see the transport failure they saw when the tunnel was down (network_unavailable)
and keep falling back as before; node responses pass unchanged.

`--verify` compares an installed endpoint with what `--apply` would write.
"""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prepare_disabled as install

require = install.require
USER = 'domino-rpc-tunnel'
HOME = Path('/var/lib') / USER
KEYS = HOME / '.ssh/authorized_keys'
SSHD = Path('/etc/ssh/sshd_config')
ORIGINAL = Path('/etc/domino/rpc-tunnel-vm/sshd_config.original')
HAPROXY = Path('/etc/haproxy/haproxy.cfg')
PROXY_PORT = 18547
TUNNEL_PORT = 18548
BEGIN = '# BEGIN DOMINO NODE RPC TUNNEL (install_node_rpc_endpoint.py)'
END = '# END DOMINO NODE RPC TUNNEL'
KEY = re.compile(r'ssh-ed25519 [A-Za-z0-9+/]{68}')


def key_line(peer, key):
    return (f'from="{peer}",restrict,port-forwarding,permitlisten="127.0.0.1:{TUNNEL_PORT}" '
            f'{key} {USER}\n')


def sshd_block(peer):
    return '\n'.join([
        '', f'AllowUsers {USER}@{peer}', '', BEGIN, f'Match User {USER} Address {peer}',
        '    AllowTcpForwarding remote', f'    PermitListen 127.0.0.1:{TUNNEL_PORT}', '    GatewayPorts no',
        '    MaxSessions 0', '    PasswordAuthentication no', '    KbdInteractiveAuthentication no',
        '    AllowAgentForwarding no', '    X11Forwarding no', '    PermitTTY no', END]) + '\n'


def haproxy_config(peer, direct_port):
    check = ('http-check send meth POST uri / ver HTTP/1.1 hdr Host 127.0.0.1 hdr Content-Type application/json '
             'body "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"method\\":\\"eth_chainId\\",\\"params\\":[]}"')
    return f"""# Keep-alive proxy in front of the Robinhood node (install_node_rpc_endpoint.py).
#   services -> 127.0.0.1:{PROXY_PORT} (this proxy)
#     primary: {peer}:{direct_port}, direct TCP over the tailnet to the node on clawber
#     backup:  127.0.0.1:{TUNNEL_PORT}, the reverse SSH tunnel clawber opens into this host
global
    log /dev/log local0 warning
    chroot /var/lib/haproxy
    stats socket /run/haproxy/admin.sock mode 600 level admin
    user haproxy
    group haproxy
    daemon
    maxconn 1024
    # One thread keeps a single idle-connection pool, so a call always finds a warm upstream connection.
    nbthread 1

defaults
    log global
    mode http
    option httplog
    option dontlog-normal
    timeout connect 3s
    timeout client 90s
    timeout server 90s
    timeout queue 10s
    timeout http-request 10s
    timeout http-keep-alive 60s
    retries 2
    option redispatch
    # Errors the proxy generates close the connection without a response: callers see
    # a transport failure (network_unavailable), never an HTTP status.
    errorfile 502 /dev/null
    errorfile 503 /dev/null
    errorfile 504 /dev/null

frontend node_rpc
    bind 127.0.0.1:{PROXY_PORT}
    maxconn 512
    tcp-request connection reject if {{ nbsrv(clawber_node) lt 1 }}
    default_backend clawber_node

backend clawber_node
    http-reuse always
    option httpchk
    {check}
    http-check expect string 0x1237
    server direct {peer}:{direct_port} check inter 2s fall 2 rise 2 maxconn 128 pool-purge-delay 30s observe layer4 error-limit 1 on-error mark-down
    server tunnel 127.0.0.1:{TUNNEL_PORT} check inter 2s fall 2 rise 1 maxconn 128 pool-purge-delay 30s backup
"""


def rendered(peer, key, direct_port):
    address = ipaddress.IPv4Address(peer)
    require(address.is_private or address in ipaddress.IPv4Network('100.64.0.0/10'), 'peer_must_be_private')
    require(KEY.fullmatch(key) is not None, 'peer_key_must_be_one_ed25519_key')
    require(1024 <= direct_port <= 65535 and direct_port not in (PROXY_PORT, TUNNEL_PORT), 'invalid_direct_port')
    return {'keys': key_line(peer, key), 'sshd': sshd_block(peer), 'haproxy': haproxy_config(peer, direct_port)}


def peer_key(path):
    fields = Path(path).read_text().split()
    require(len(fields) >= 2, 'peer_key_must_be_one_ed25519_key')
    return f'{fields[0]} {fields[1]}'


def plan(texts):
    require(Path('/usr/sbin/haproxy').is_file(), 'haproxy_missing')
    for path in (HOME, ORIGINAL):
        require(not os.path.lexists(path), 'endpoint_exists')
    require(BEGIN not in SSHD.read_text(), 'endpoint_exists')
    return {'mode': 'node-rpc-endpoint', 'proxy': f'127.0.0.1:{PROXY_PORT}', 'tunnel': f'127.0.0.1:{TUNNEL_PORT}',
            'files': [str(KEYS), str(SSHD), str(HAPROXY)],
            'notPerformed': ['clawber-side units (docs/FRESH_HOST_INSTALL.md)', 'firewall change']}


def apply(texts, planned, peer):
    require(os.geteuid() == 0, 'root_required')
    install.run(['/usr/sbin/useradd', '--system', '--home-dir', str(HOME), '--create-home',
                 '--shell', '/usr/sbin/nologin', USER])
    account = pwd.getpwnam(USER)
    os.chmod(HOME, 0o750)
    (HOME / '.ssh').mkdir(mode=0o700)
    os.chown(HOME / '.ssh', account.pw_uid, account.pw_gid)
    install.exclusive_file(KEYS, texts['keys'].encode(), 0o600, account.pw_uid, account.pw_gid)
    ORIGINAL.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    install.exclusive_file(ORIGINAL, SSHD.read_bytes(), 0o600)
    with open(SSHD, 'a') as stream:
        stream.write(texts['sshd'])
    install.run(['/usr/sbin/sshd', '-t'])
    install.run(['/usr/bin/systemctl', 'reload-or-restart', 'ssh.service'])
    dist = HAPROXY.with_name('haproxy.cfg.dist')
    if not dist.exists():
        shutil.copy2(HAPROXY, dist)
    HAPROXY.write_text(texts['haproxy'])
    install.run(['/usr/sbin/haproxy', '-c', '-f', str(HAPROXY)])
    install.run(['/usr/bin/systemctl', 'enable', '--now', 'haproxy.service'])
    install.run(['/usr/bin/systemctl', 'reload', 'haproxy.service'])
    return {**planned, **verify(texts, peer)}


def verify(texts, peer):
    """The installed endpoint is exactly what --apply writes."""
    require(KEYS.read_text() == texts['keys'], 'authorized_key_differs')
    require(SSHD.read_text().endswith(texts['sshd']), 'sshd_block_differs')
    require(HAPROXY.read_text() == texts['haproxy'], 'haproxy_config_differs')
    effective = install.run(['/usr/sbin/sshd', '-T', '-C',
                             f'user={USER},addr={peer},host=peer,laddr=127.0.0.1,lport=22']).decode()
    require(f'permitlisten 127.0.0.1:{TUNNEL_PORT}' in effective and 'allowtcpforwarding remote' in effective,
            'sshd_match_not_effective')
    return {'ok': True, 'verified': ['authorized key', 'sshd block', 'haproxy config', 'effective sshd match']}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--peer', required=True, help="clawber's tailnet IPv4 address")
    parser.add_argument('--peer-key', type=Path, required=True, help="clawber's tunnel public key file")
    parser.add_argument('--direct-port', type=int, default=18549)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--inspect', action='store_true')
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--verify', action='store_true')
    args = parser.parse_args(argv)
    try:
        texts = rendered(args.peer, peer_key(args.peer_key), args.direct_port)
        if args.verify:
            result = verify(texts, args.peer)
        else:
            planned = plan(texts)
            result = apply(texts, planned, args.peer) if args.apply else {**planned, 'ok': True, 'installed': False}
        print(json.dumps(result, indent=2))
        return 0
    except Exception as error:
        reason = str(error) if isinstance(error, ValueError) else type(error).__name__
        print(json.dumps({'ok': False, 'reason': reason}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
