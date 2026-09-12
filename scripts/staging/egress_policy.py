#!/usr/bin/env python3
"""Render a single, expiring staging egress candidate from sanitized stdin only.

No network, subprocess, service/config/credential inspection, or application.
The operator must independently verify the snapshot and both enforcement layers.
"""
from datetime import datetime, timezone
import ipaddress
import json
import math
import re
import sys


MAX_BYTES = 65536
MAX_WINDOW_SECONDS = 600
# A 60s DNS TTL necessarily has less than 60s left after collection/transit.
# This is only an artifact handoff margin, not approval of a runtime test budget.
MIN_REMAINING_SECONDS = 10
MAX_ADDRESSES = 64
TABLE = 'domino_egress_window'
ROLES = ('read', 'gateway', 'auth', 'onboarding', 'deposit', 'tunnel',
         'write', 'operator', 'admin')
ENABLED = ('read', 'gateway', 'tunnel')
NO_UNIT = ('write', 'operator', 'admin')
LISTENERS = {'read': 8876, 'gateway': 8878, 'auth': 8879,
             'onboarding': 8880, 'deposit': 8881, 'tunnel': 20241}
LOCAL_ORIGINS = {'gateway': (8876,), 'tunnel': (8878, 8879, 8880)}
# Official global-region inventory, checked 2026-09-11. This is not a CIDR grant.
# https://developers.cloudflare.com/cloudflare-one/networks/connectors/
# cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/
EDGE_ADDRESSES = {
    'region1.v2.argotunnel.com': frozenset('198.41.192.' + str(i) for i in
        (167, 67, 57, 107, 27, 7, 227, 47, 37, 77)),
    'region2.v2.argotunnel.com': frozenset('198.41.200.' + str(i) for i in
        (13, 193, 33, 233, 53, 63, 113, 73, 43, 23)),
}
HOST = re.compile(r'(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+'
                  r'[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\Z')
STAMP = re.compile(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\Z')


class InvalidSnapshot(ValueError):
    """The message is a fixed code, never the supplied value."""


def require(condition, code):
    if not condition:
        raise InvalidSnapshot(code)


def exact(obj, keys, code):
    require(type(obj) is dict and set(obj) == set(keys), code)


def timestamp(value):
    require(type(value) is str and STAMP.fullmatch(value), 'invalid_timestamp')
    try:
        result = datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
    except ValueError:
        raise InvalidSnapshot('invalid_timestamp') from None
    require(0 < result.timestamp() < 2**32, 'timestamp_out_of_range')
    return result


def positive_id(value):
    require(type(value) is int and 0 < value < 2**31 and value != 65534,
            'invalid_identity_number')


def addresses(values):
    require(type(values) is list and 1 <= len(values) <= MAX_ADDRESSES,
            'invalid_address_count')
    result = []
    for value in values:
        require(type(value) is str, 'invalid_address')
        try:
            address = ipaddress.IPv4Address(value)
        except ipaddress.AddressValueError:
            raise InvalidSnapshot('invalid_address') from None
        require(str(address) == value and address.is_global and not address.is_multicast
                and not address.is_reserved, 'non_global_address')
        result.append(value)
    require(len(set(result)) == len(result), 'duplicate_address')
    return sorted(result, key=ipaddress.IPv4Address)


def freshness(record, observed, expires):
    source_observed = timestamp(record['observedAt'])
    source_expires = timestamp(record['expiresAt'])
    require(source_observed <= observed < source_expires, 'invalid_source_observation')
    require((observed - source_observed).total_seconds() <= MAX_WINDOW_SECONDS,
            'source_observation_too_old')
    require(expires <= source_expires, 'window_exceeds_source_expiry')


def validate(snapshot, now):
    exact(snapshot, ('version', 'observedAt', 'expiresAt', 'resolver', 'identities',
                     'https', 'edges'), 'invalid_snapshot_fields')
    require(type(snapshot['version']) is int and snapshot['version'] == 1,
            'invalid_snapshot_version')
    require(snapshot['resolver'] == '127.0.0.53', 'invalid_resolver')
    require(isinstance(now, datetime) and now.tzinfo is not None and now.utcoffset() is not None,
            'invalid_clock')
    observed, expires = timestamp(snapshot['observedAt']), timestamp(snapshot['expiresAt'])
    require(observed <= now < expires, 'expired_or_future_snapshot')
    require(0 < (expires - observed).total_seconds() <= MAX_WINDOW_SECONDS,
            'window_too_long')
    require((expires - now).total_seconds() >= MIN_REMAINING_SECONDS,
            'insufficient_remaining_window')
    exact(snapshot['identities'], ROLES, 'invalid_identity_roles')
    seen_uids = set()
    for role in ROLES:
        identity = snapshot['identities'][role]
        # Explicit absence is allowed only for the administrative account.
        if role == 'admin' and identity is None:
            continue
        exact(identity, ('user', 'realUid', 'effectiveUid', 'gid', 'supplementaryGids',
                         'unit', 'cgroup'), 'invalid_identity_fields')
        require(identity['user'] == 'domino-' + role, 'invalid_identity_user')
        for field in ('realUid', 'effectiveUid', 'gid'):
            positive_id(identity[field])
        require(identity['realUid'] == identity['effectiveUid'], 'identity_uid_mismatch')
        require(identity['realUid'] not in seen_uids, 'duplicate_uid')
        seen_uids.add(identity['realUid'])
        groups = identity['supplementaryGids']
        require(type(groups) is list and len(groups) <= 16, 'invalid_group_count')
        for group in groups:
            positive_id(group)
        require(len(set(groups)) == len(groups), 'duplicate_group')
        if role in NO_UNIT:
            require(identity['unit'] is None and identity['cgroup'] is None,
                    'unexpected_service_unit')
        else:
            unit = 'domino-' + role + '.service'
            require(identity['unit'] == unit, 'invalid_service_unit')
            require(identity['cgroup'] == '/system.slice/' + unit, 'invalid_service_cgroup')
    https = snapshot['https']
    require(type(https) is list and 2 <= len(https) <= 6, 'invalid_https_count')
    destinations = {role: set() for role in ENABLED}
    names = set()
    counts = {'rpc': 0, 'analytics': 0, 'jwks': 0}
    for item in https:
        exact(item, ('role', 'kind', 'hostname', 'addresses', 'observedAt', 'expiresAt'),
              'invalid_https_fields')
        role, kind, hostname = item['role'], item['kind'], item['hostname']
        require(type(hostname) is str and HOST.fullmatch(hostname), 'invalid_hostname')
        require(type(role) is str and type(kind) is str, 'invalid_https_role')
        require((role, kind) in (('read', 'rpc'), ('read', 'analytics'), ('gateway', 'jwks')),
                'invalid_https_role')
        require((role, hostname) not in names, 'duplicate_hostname')
        names.add((role, hostname))
        if kind == 'analytics':
            require(hostname == 'api.geckoterminal.com', 'unapproved_analytics_hostname')
        if kind == 'jwks':
            require(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
                                 r'\.cloudflareaccess\.com', hostname), 'invalid_jwks_hostname')
        # RPC hostname authorization is an operator review requirement. Paths,
        # keys, query strings, userinfo and URLs are intentionally not accepted.
        counts[kind] += 1
        freshness(item, observed, expires)
        destinations[role].update(addresses(item['addresses']))
    require(1 <= counts['rpc'] <= 4 and counts['analytics'] <= 1 and counts['jwks'] == 1,
            'invalid_https_purposes')
    edges = snapshot['edges']
    require(type(edges) is list and len(edges) == 2, 'invalid_edge_count')
    seen_edges = set()
    for item in edges:
        exact(item, ('hostname', 'addresses', 'observedAt', 'expiresAt'), 'invalid_edge_fields')
        hostname = item['hostname']
        require(type(hostname) is str and hostname in EDGE_ADDRESSES and hostname not in seen_edges,
                'invalid_edge_hostname')
        seen_edges.add(hostname)
        selected = set(addresses(item['addresses']))
        require(selected <= EDGE_ADDRESSES[hostname], 'unapproved_edge_address')
        freshness(item, observed, expires)
        destinations['tunnel'].update(selected)
    return observed, expires, destinations


def render(snapshot, *, now=None):
    """Pure renderer; injected aware clock is only for offline callers/tests."""
    now = datetime.now(timezone.utc) if now is None else now
    observed, expires, destinations = validate(snapshot, now)
    timeout = math.floor((expires - now).total_seconds())
    end = int(expires.timestamp())
    begin = int(observed.timestamp())
    scope = 'inet ' + TABLE
    lines = ['# Candidate only. Never apply without independent review and a drained VM.',
             '# Absolute UTC UNIX time guards prevent delayed installation extending validity.',
             'create table ' + scope,
             f'add chain {scope} output {{ type filter hook output priority 10; policy accept; }}']
    for role in ROLES:
        identity = snapshot['identities'][role]
        if identity is None:
            continue
        lines.extend((f'add chain {scope} {role}',
                      f'add counter {scope} denied_{role}',
                      f'add rule {scope} output meta skuid {identity["realUid"]} jump {role}'))
        prefix = f'add rule {scope} {role} '
        # UID originated socket + reply direction + exact listener are essential:
        # a client cannot gain egress by binding a permitted server source port.
        if role in LISTENERS:
            lines.append(prefix + 'oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 '
                         f'tcp sport {LISTENERS[role]} ct direction reply ct state established '
                         'counter accept comment "loopback listener reply"')
        gate = f'meta time >= {begin} meta time < {end} '
        if role in ENABLED:
            selected = sorted(destinations[role], key=ipaddress.IPv4Address)
            elements = ', '.join(address + f' timeout {timeout}s' for address in selected)
            lines.append(f'add set {scope} {role}_ipv4 {{ type ipv4_addr; flags timeout; '
                         f'size {len(selected)}; elements = {{ {elements} }}; }}')
            ports = (('tcp', 7844), ('udp', 7844)) if role == 'tunnel' else (('tcp', 443),)
            for protocol, port in ports:
                lines.append(prefix + gate + f'oifname != "lo" ip daddr @{role}_ipv4 '
                             f'{protocol} dport {port} counter accept comment "window external"')
            for protocol in ('tcp', 'udp'):
                lines.append(prefix + gate + 'oifname "lo" ip daddr 127.0.0.53 '
                             f'{protocol} dport 53 counter accept comment "window DNS stub"')
        for port in LOCAL_ORIGINS.get(role, ()):
            lines.append(prefix + gate + 'oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 '
                         f'tcp dport {port} ct direction original counter accept '
                         'comment "window local origin"')
        lines.append(prefix + f'counter name denied_{role} drop')
    artifacts = {'domino-egress-window.nft': '\n'.join(lines) + '\n'}
    for role in ROLES:
        identity = snapshot['identities'][role]
        if identity is None or identity['unit'] is None:
            continue
        allowed = ['127.0.0.1/32']
        if role in ENABLED:
            allowed.append('127.0.0.53/32')
            allowed.extend(address + '/32' for address in
                           sorted(destinations[role], key=ipaddress.IPv4Address))
        dropin = ['# Reviewed candidate only; requires the matching expiring nft table.',
                  '# Does not alter User, Group, ExecStart, flags or startup policy.',
                  '[Service]', 'IPAddressAllow=', 'IPAddressDeny=', 'IPAddressDeny=any']
        dropin.extend('IPAddressAllow=' + address for address in allowed)
        artifacts[identity['unit'] + '.d/40-egress-window.conf'] = '\n'.join(dropin) + '\n'
    return {'version': 1, 'applied': False, 'policyQualified': False,
            'observedAt': snapshot['observedAt'], 'expiresAt': snapshot['expiresAt'],
            'generatedAt': now.astimezone(timezone.utc).isoformat(),
            'remainingSeconds': timeout, 'identities': snapshot['identities'],
            'artifacts': artifacts}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate_json_key')
        result[key] = value
    return result


def parse(raw):
    require(type(raw) is bytes and len(raw) <= MAX_BYTES, 'snapshot_size_limit')
    try:
        result = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object,
                            parse_constant=invalid_constant)
    except (UnicodeError, ValueError, RecursionError):
        raise InvalidSnapshot('invalid_json') from None
    pending = [(result, 0)]
    while pending:
        value, depth = pending.pop()
        require(depth <= 8, 'json_depth_limit')
        if type(value) is dict:
            pending.extend((child, depth + 1) for child in value.values())
        elif type(value) is list:
            pending.extend((child, depth + 1) for child in value)
    return result


def invalid_constant(_):
    raise InvalidSnapshot('invalid_json')


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
