#!/usr/bin/env python3
"""Render an expiring development egress candidate from non-secret stdin.

No resolution, HTTP, credentials, native commands, file writes or installation.
The separate operator transaction must bind this candidate to the actual OFF
manifest, mounted host pins, source and full host policy before activation.
"""
from datetime import datetime, timedelta, timezone
import ipaddress
import json
import math
import re
import sys

import dev_infrastructure as off
import egress_policy as shared


InvalidSnapshot = shared.InvalidSnapshot
parse = shared.parse
require = shared.require
exact = shared.exact
MAX_BYTES = shared.MAX_BYTES
MAX_WINDOW_SECONDS = shared.MAX_WINDOW_SECONDS
MIN_REMAINING_SECONDS = shared.MIN_REMAINING_SECONDS
MAX_AUTHORIZATION_SECONDS = 7 * 24 * 60 * 60
SHORT_PROFILE = 'dns_expiring_qualification'
CONTINUOUS_PROFILE = 'continuous_operator_pins'
EDGE_ADDRESSES = shared.EDGE_ADDRESSES
RPC_HOSTS = frozenset(('rpc.mainnet.chain.robinhood.com', 'robinhood-mainnet.g.alchemy.com',
                       'rpc.domino.money'))
INVENTORY_HOST = 'robinhood-mainnet.g.alchemy.com'
ANALYTICS_HOSTS = frozenset(('api.geckoterminal.com', 'api.dexscreener.com'))
ISSUER = re.compile(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com')
NFT_TARGET = off.ROOT + '/off-policy.nft'
DROPIN = '50-dev-egress.conf'
FIELDS = ('version', 'observedAt', 'expiresAt', 'offManifestSha256',
          'rpcHosts', 'inventoryHost', 'accessIssuer', 'tunnel', 'hosts')


def validate(snapshot, now):
    require(type(snapshot) is dict, 'invalid_snapshot_fields')
    profile = snapshot.get('profile', SHORT_PROFILE)
    require(type(profile) is str and profile in (SHORT_PROFILE, CONTINUOUS_PROFILE), 'invalid_profile')
    extra = ('profile',) if 'profile' in snapshot else ()
    if profile == CONTINUOUS_PROFILE:
        extra += ('operatorAuthorization',)
    exact(snapshot, FIELDS + extra, 'invalid_snapshot_fields')
    require(type(snapshot['version']) is int and snapshot['version'] == 1, 'invalid_snapshot_version')
    require(type(snapshot['offManifestSha256']) is str and
            re.fullmatch(r'[a-f0-9]{64}', snapshot['offManifestSha256']) is not None,
            'invalid_off_manifest_digest')
    require(isinstance(now, datetime) and now.tzinfo is not None and now.utcoffset() is not None,
            'invalid_clock')
    observed, expires = shared.timestamp(snapshot['observedAt']), shared.timestamp(snapshot['expiresAt'])
    require(observed <= now < expires, 'expired_or_future_snapshot')
    require((expires - now).total_seconds() >= MIN_REMAINING_SECONDS, 'insufficient_remaining_window')
    begin, authorization = observed, None
    if profile == SHORT_PROFILE:
        require(0 < (expires - observed).total_seconds() <= MAX_WINDOW_SECONDS, 'window_too_long')
    else:
        authorization = snapshot['operatorAuthorization']
        exact(authorization, ('authorizationId', 'grantedAt', 'expiresAt', 'revoked'), 'invalid_operator_authorization')
        authorization = dict(authorization)
        require(type(authorization['authorizationId']) is str and
                off.HEX64.fullmatch(authorization['authorizationId']) is not None and
                authorization['revoked'] is False, 'invalid_operator_authorization')
        granted = shared.timestamp(authorization['grantedAt'])
        authorized_end = shared.timestamp(authorization['expiresAt'])
        require(granted <= now < authorized_end and authorized_end == expires and
                0 < (authorized_end - granted).total_seconds() <= MAX_AUTHORIZATION_SECONDS,
                'invalid_operator_authorization_period')
        begin = max(observed, granted)

    rpc = snapshot['rpcHosts']
    require(type(rpc) is list and 1 <= len(rpc) <= len(RPC_HOSTS) and
            all(type(host) is str and host in RPC_HOSTS for host in rpc), 'invalid_rpc_hosts')
    require(len(set(rpc)) == len(rpc), 'duplicate_rpc_host')
    inventory = snapshot['inventoryHost']
    require(inventory is None or type(inventory) is str and inventory == INVENTORY_HOST,
            'invalid_inventory_host')
    issuer = snapshot['accessIssuer']
    require(type(issuer) is str and ISSUER.fullmatch(issuer) is not None, 'invalid_access_issuer')
    tunnel = snapshot['tunnel']
    require(type(tunnel) is dict and set(tunnel) <= {'dnsStub', 'accessJwks'} and
            all(type(flag) is bool for flag in tunnel.values()), 'invalid_tunnel_permissions')
    dns, tunnel_jwks = tunnel.get('dnsStub', False), tunnel.get('accessJwks', False)

    role_hosts = {'reader': set(rpc) | ANALYTICS_HOSTS | ({inventory} if inventory else set()),
                  'gateway': {issuer},
                  'tunnel': set(EDGE_ADDRESSES) | ({issuer} if tunnel_jwks else set())}
    expected = role_hosts['reader'] | {issuer} | set(EDGE_ADDRESSES)
    records = snapshot['hosts']
    require(type(records) is list and len(records) == len(expected), 'invalid_host_inventory')
    pins, adoption_deadline = {}, expires
    for item in records:
        exact(item, ('hostname', 'addresses', 'observedAt', 'expiresAt'), 'invalid_host_fields')
        hostname = item['hostname']
        require(type(hostname) is str and hostname in expected, 'unapproved_hostname')
        require(hostname not in pins, 'duplicate_hostname')
        if profile == SHORT_PROFILE:
            shared.freshness(item, observed, expires)
        else:
            source_observed = shared.timestamp(item['observedAt'])
            source_expires = shared.timestamp(item['expiresAt'])
            require(source_observed <= observed <= now < source_expires, 'invalid_adoption_observation')
            # DNS validity gates initial adoption, not the operator's held-pin
            # permission deadline. Stale inputs cannot produce a new candidate.
            adoption_deadline = min(adoption_deadline, source_expires,
                                    source_observed + timedelta(seconds=MAX_WINDOW_SECONDS))
        selected = shared.addresses(item['addresses'])
        if hostname in EDGE_ADDRESSES:
            require(set(selected) <= EDGE_ADDRESSES[hostname], 'unapproved_edge_address')
        pins[hostname] = selected
    require(set(pins) == expected, 'incomplete_host_inventory')
    require((adoption_deadline - now).total_seconds() >= MIN_REMAINING_SECONDS,
            'insufficient_adoption_window')
    return begin, expires, pins, role_hosts, dns, tunnel_jwks, profile, authorization, adoption_deadline


def ordered(values):
    return sorted(set(values), key=ipaddress.IPv4Address)


def render(snapshot, *, now=None):
    """Pure, bounded renderer. An injected clock is only for offline callers."""
    now = datetime.now(timezone.utc) if now is None else now
    begins, expires, pins, role_hosts, dns, tunnel_jwks, profile, authorization, adoption_deadline = validate(snapshot, now)
    timeout = math.floor((expires - now).total_seconds())
    begin, end = int(begins.timestamp()), int(expires.timestamp())
    scope = 'inet ' + off.POLICY
    gate = f'meta time >= {begin} meta time < {end} '
    addresses = {role: ordered(address for host in names for address in pins[host])
                 for role, names in role_hosts.items()}
    reader_https = addresses['reader']
    gateway_https = pins[snapshot['accessIssuer']]
    edge = ordered(address for host in EDGE_ADDRESSES for address in pins[host])
    sets = {'reader_https': reader_https, 'gateway_https': gateway_https, 'tunnel_edges': edge}
    if tunnel_jwks:
        sets['tunnel_jwks'] = gateway_https

    # A permissive second table cannot override OFF's final drop. Replace only
    # the existing dev table in one nft transaction, after the external baseline
    # check. First adoption or changed pins require a dev drain/restart; an
    # independently authorized renewal with unchanged pins needs only nft.
    lines = ['# Candidate only: exact baseline and independent review required.',
             '# First adoption or pin changes require a dev drain; unchanged pins permit a guarded nft-only renewal.',
             '# Every original-direction permission expires, including established connections.',
             '# Relative set TTLs cannot extend the absolute UTC UNIX deadline below.',
             'add table ' + scope, 'delete table ' + scope, 'add table ' + scope,
             f'add chain {scope} output {{ type filter hook output priority 11; policy accept; }}']
    for name, values in sets.items():
        elements = ', '.join(address + f' timeout {timeout}s' for address in values)
        lines.append(f'add set {scope} {name} {{ type ipv4_addr; flags timeout; size {len(values)}; '
                     f'elements = {{ {elements} }}; }}')
    for role, (uid, listener) in off.ROLES.items():
        lines += [f'add chain {scope} {role}', f'add counter {scope} denied_{role}',
                  f'add rule {scope} output meta skuid {uid} jump {role}']
        prefix = f'add rule {scope} {role} '
        lines.append(prefix + 'oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 '
                     f'tcp sport {listener} ct direction reply ct state established '
                     'counter accept comment "loopback listener reply"')
        if role in ('reader', 'gateway'):
            lines.append(prefix + gate + f'oifname != "lo" ip daddr @{role}_https tcp dport 443 '
                         'ct direction original counter accept comment "window HTTPS"')
        if role == 'tunnel':
            for protocol in ('tcp', 'udp'):
                lines.append(prefix + gate + f'oifname != "lo" ip daddr @tunnel_edges {protocol} dport 7844 '
                             'ct direction original counter accept comment "window edge"')
            if tunnel_jwks:
                lines.append(prefix + gate + 'oifname != "lo" ip daddr @tunnel_jwks tcp dport 443 '
                             'ct direction original counter accept comment "window connector JWKS"')
            if dns:
                for protocol in ('tcp', 'udp'):
                    lines.append(prefix + gate + f'oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.53 '
                                 f'{protocol} dport 53 ct direction original counter accept '
                                 'comment "window connector DNS stub"')
        if role in ('gateway', 'tunnel'):
            origin = 8890 if role == 'gateway' else 8891
            lines.append(prefix + gate + 'oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 '
                         f'tcp dport {origin} ct direction original counter accept comment "window local origin"')
        lines.append(prefix + f'counter name denied_{role} drop')

    artifacts = {NFT_TARGET: '\n'.join(lines) + '\n'}
    for role in off.ROLES:
        hosts_target = off.ROOT + '/' + role + '/hosts'
        hosts = ['# Pinned development destinations; changed pins require the matching policy and service restart.',
                 '127.0.0.1 localhost']
        for hostname in sorted(role_hosts[role]):
            hosts.extend(address + ' ' + hostname for address in pins[hostname])
        artifacts[hosts_target] = '\n'.join(hosts) + '\n'
        dropin = ['# Candidate only: the matching nft absolute expiry supplies port and time restrictions.',
                  '# File host binds pin an inode; drain/restart dev roles only when pins or these files change.',
                  '[Service]', 'IPAddressAllow=', 'IPAddressDeny=', 'IPAddressDeny=any',
                  'IPAddressAllow=127.0.0.1/32']
        if role == 'tunnel' and dns:
            dropin.append('IPAddressAllow=127.0.0.53/32')
        dropin += ['IPAddressAllow=' + address + '/32' for address in addresses[role]]
        # Do not reset BindReadOnlyPaths: preserve the OFF private-directory bind.
        dropin.append(f'BindReadOnlyPaths={hosts_target}:/etc/hosts')
        artifacts['/etc/systemd/system/' + off.USERS[role] + '.service.d/' + DROPIN] = '\n'.join(dropin) + '\n'

    hashes = {path: off.sha(value.encode()) for path, value in artifacts.items()}
    pin_scope = {'hosts': {role: {host: pins[host] for host in sorted(names)}
                           for role, names in role_hosts.items()},
                 'tunnel': {'dnsStub': dns, 'accessJwks': tunnel_jwks}}
    off_policy = off.policy().decode()
    identities = {role: {'user': off.USERS[role], 'realUid': uid, 'effectiveUid': uid, 'gid': uid,
                         'supplementaryGids': [988] if role == 'reader' else [],
                         'unit': off.USERS[role] + '.service',
                         'cgroup': '/dominodev.slice/' + off.USERS[role] + '.service'}
                  for role, (uid, _) in off.ROLES.items()}
    return {'version': 1, 'kind': 'domino-development-egress-window',
            'applied': False, 'policyQualified': False, 'activationSelected': False,
            'profile': profile, 'operatorAuthorization': authorization,
            'observedAt': snapshot['observedAt'], 'expiresAt': snapshot['expiresAt'],
            'adoptionDeadline': adoption_deadline.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'effectivePermissionExpiry': snapshot['expiresAt'], 'pinSetSha256': off.sha(off.canonical(pin_scope)),
            'generatedAt': now.astimezone(timezone.utc).isoformat(), 'remainingSeconds': timeout,
            'offManifestSha256': snapshot['offManifestSha256'], 'snapshotSha256': off.sha(off.canonical(snapshot)),
            'identities': identities, 'tunnelPermissions': {'dnsStub': dns, 'accessJwks': tunnel_jwks},
            'artifacts': artifacts, 'artifactSha256': hashes,
            'artifactMetadata': {path: {'uid': 0, 'gid': 0, 'mode': 0o600 if path == NFT_TARGET else 0o644}
                                 for path in artifacts},
            'rollback': {'offManifestSha256': snapshot['offManifestSha256'],
                         'offPolicyTarget': NFT_TARGET, 'offPolicySha256': off.sha(off_policy.encode()),
                         'restoreArtifacts': {NFT_TARGET: off_policy},
                         'removeArtifacts': {path: digest for path, digest in hashes.items() if path != NFT_TARGET}}}


def main():
    if len(sys.argv) != 1:
        print(json.dumps({'ok': False, 'error': 'stdin_only_no_arguments'}))
        return 2
    try:
        result = render(parse(sys.stdin.buffer.read(MAX_BYTES + 1)))
    except InvalidSnapshot as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        return 2
    print(json.dumps(result, sort_keys=True, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
