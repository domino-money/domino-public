#!/usr/bin/env python3
"""Render the whole continuous egress policy, and each unit's activation, from
operator pins on stdin.

The live policy at /etc/domino/continuous-reads/policy.nft was assembled by
hand, one role at a time, and it describes only the identities that existed
when each piece was written: the four financial identities installed on
13 September have no chain and fall through to the table's accept. This
renders the table for every production identity, gives a family its external
destinations and the tunnel a way to reach its listener only when that family
is named in `enabled`, and writes the matching per-unit drop-in, hosts file
and target so that the three layers cannot disagree.

Nothing is resolved, read from the host, written, or applied. The output is a
candidate for the procedure in docs/CONTINUOUS_EGRESS.md.
"""
import hashlib
import ipaddress
import json
import re
import sys

import egress_policy as shared
import upgrade_financial as financial

TABLE = 'domino_continuous_reads'
TARGET = 'domino-continuous-reads.target'
EGRESS_UNIT = 'domino-continuous-egress.service'
ROOT = '/etc/domino/continuous-reads'
READY = '/run/domino-continuous-reads.ready'
DROPIN = '60-continuous-reads.conf'
UNIT_DIR = '/etc/systemd/system/'
# Render order. The nine identities the live table already carries keep their
# order; the four financial identities of 13 September follow deposit.
ROLES = ('read', 'gateway', 'auth', 'onboarding', 'deposit', 'performance',
         'performance-collector', 'execution-status', 'execution-signer',
         'tunnel', 'write', 'operator', 'admin')
# Identities with no single service unit: the indexer role runs two
# timer-driven units whose systemd layer is not this file's, and the two
# accounts never run a service at all.
NO_UNIT = ('write', 'operator', 'admin')
LISTENERS = {'read': 8876, 'gateway': 8878, 'auth': 8879, 'onboarding': 8880,
             'deposit': 8881, 'performance': 8900, 'execution-status': 8901,
             'tunnel': 20241}
RPC_HOSTS = frozenset(('rpc.mainnet.chain.robinhood.com', 'robinhood-mainnet.g.alchemy.com',
                       'rpc.domino.money'))
ANALYTICS_HOSTS = frozenset(('api.geckoterminal.com', 'api.dexscreener.com'))
# The quote gateway (onboarding and deposit quotes) and the liquidity API the
# position preview and pool-info reads post to (backend/uniswap_position.py,
# backend/uniswap_liquidity.py): a listener that reaches one reaches the other.
UNISWAP_HOSTS = frozenset(('trade-api.gateway.uniswap.org', 'liquidity.api.uniswap.org'))
EDGE_HOSTS = frozenset(shared.EDGE_ADDRESSES)
ISSUER = re.compile(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com')
# What each identity's own code reaches for, by hostname class. `jwks` is the
# Access issuer every listener verifies assertions against; `rpc` is the
# PlainEoaChecker / quote / signer path; `uniswap` is the trade API onboarding
# and deposit quote through. Nothing here is a grant: a class is rendered only
# for an enabled role and only for the hostnames the operator pinned.
CLASSES = {'read': ('rpc', 'analytics'), 'gateway': ('jwks',),
           'auth': ('rpc', 'jwks'), 'onboarding': ('rpc', 'jwks', 'uniswap'),
           'deposit': ('rpc', 'jwks', 'uniswap'), 'performance': ('rpc', 'jwks'),
           'performance-collector': ('rpc',), 'execution-status': (),
           'execution-signer': ('rpc',), 'tunnel': ('edges', 'jwks'),
           'write': ('rpc',), 'operator': (), 'admin': ()}
# A class an enabled role cannot run without. Analytics is optional for the
# reader: the market provider is a fallback, not the read path.
REQUIRED = {'rpc', 'jwks', 'uniswap', 'edges'}
# Who originates a loopback connection to whose listener. The tunnel fronts
# every listener behind an Access hostname; the gateway fronts the reader.
ORIGINS = {'gateway': ('read',),
           'tunnel': ('gateway', 'auth', 'onboarding', 'deposit', 'performance', 'execution-status')}
# Identities that resolve names at runtime. Every other enabled unit reads a
# pinned hosts file bound over /etc/hosts and never needs the stub resolver.
DNS_STUB = ('tunnel', 'write')
# Every listener refuses to start enabled without its private operator file:
# session_api.load_session_rpc_config raises session_rpc_config_required when
# --rpc-config is absent, and onboarding and deposit call the same loader. The
# file lives in the family's private directory, bound read-only at the config
# path the installer's unit already names.
def private_config(component, name):
    return f'/run/domino-financial-{component}-config/{name}'


ENABLE_ARGUMENTS = {
    'auth': f'--enable --rpc-config {private_config("auth", "rpc.json")}',
    'onboarding': f'--enable --rpc-config {private_config("onboarding", "rpc.json")}',
    'deposit': f'--enable --rpc-config {private_config("deposit", "rpc.json")}',
    'performance': f'--enable --profile {private_config("performance", "profile.json")}',
    'execution-status': f'--enable --config {private_config("execution-status", "profile.json")}'}
UNSET = ('UnsetEnvironment=HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy '
         'all_proxy no_proxy SSL_CERT_FILE SSL_CERT_DIR REQUESTS_CA_BUNDLE CURL_CA_BUNDLE '
         'PYTHONPATH PYTHONHOME')
FIELDS = ('version', 'resolver', 'accessIssuer', 'enabled', 'identities', 'hosts')

InvalidSnapshot = shared.InvalidSnapshot
require = shared.require
exact = shared.exact
parse = shared.parse


def unit_of(role):
    return None if role in NO_UNIT else 'domino-' + role + '.service'


def nft_name(role):
    """nft identifiers admit no hyphen; unit and account names keep theirs."""
    return role.replace('-', '_')


def classes_of(hostname, issuer):
    result = set()
    if hostname in RPC_HOSTS: result.add('rpc')
    if hostname in ANALYTICS_HOSTS: result.add('analytics')
    if hostname in UNISWAP_HOSTS: result.add('uniswap')
    if hostname in EDGE_HOSTS: result.add('edges')
    if hostname == issuer: result.add('jwks')
    return result


def validate(snapshot):
    exact(snapshot, FIELDS, 'invalid_snapshot_fields')
    require(type(snapshot['version']) is int and snapshot['version'] == 1, 'invalid_snapshot_version')
    require(snapshot['resolver'] == '127.0.0.53', 'invalid_resolver')
    issuer = snapshot['accessIssuer']
    require(type(issuer) is str and ISSUER.fullmatch(issuer) is not None, 'invalid_access_issuer')
    enabled = snapshot['enabled']
    require(type(enabled) is list and all(type(role) is str for role in enabled)
            and len(set(enabled)) == len(enabled), 'invalid_enabled_roles')
    require(all(role in ROLES and role not in ('operator', 'admin') for role in enabled),
            'unknown_enabled_role')
    enabled = tuple(role for role in ROLES if role in enabled)
    exact(snapshot['identities'], ROLES, 'invalid_identity_roles')
    seen_uids = set()
    for role in ROLES:
        identity = snapshot['identities'][role]
        if role == 'admin' and identity is None:
            continue
        exact(identity, ('user', 'realUid', 'effectiveUid', 'gid', 'supplementaryGids',
                         'unit', 'cgroup'), 'invalid_identity_fields')
        require(identity['user'] == 'domino-' + role, 'invalid_identity_user')
        for field in ('realUid', 'effectiveUid', 'gid'):
            shared.positive_id(identity[field])
        require(identity['realUid'] == identity['effectiveUid'], 'identity_uid_mismatch')
        require(identity['realUid'] not in seen_uids, 'duplicate_uid')
        seen_uids.add(identity['realUid'])
        groups = identity['supplementaryGids']
        require(type(groups) is list and len(groups) <= 16, 'invalid_group_count')
        for group in groups:
            shared.positive_id(group)
        require(len(set(groups)) == len(groups), 'duplicate_group')
        unit = unit_of(role)
        if unit is None:
            require(identity['unit'] is None and identity['cgroup'] is None, 'unexpected_service_unit')
        else:
            require(identity['unit'] == unit, 'invalid_service_unit')
            require(identity['cgroup'] == '/system.slice/' + unit, 'invalid_service_cgroup')
    records = snapshot['hosts']
    require(type(records) is list and len(records) <= 16, 'invalid_host_inventory')
    pins = {}
    for item in records:
        exact(item, ('hostname', 'addresses'), 'invalid_host_fields')
        hostname = item['hostname']
        require(type(hostname) is str and shared.HOST.fullmatch(hostname), 'invalid_hostname')
        require(hostname not in pins, 'duplicate_hostname')
        selected = shared.addresses(item['addresses'])
        if hostname in EDGE_HOSTS:
            require(set(selected) <= shared.EDGE_ADDRESSES[hostname], 'unapproved_edge_address')
        pins[hostname] = selected
    role_hosts = {}
    for role in ROLES:
        wanted = set(CLASSES[role]) if role in enabled else set()
        role_hosts[role] = sorted(host for host in pins if classes_of(host, issuer) & wanted)
        for kind in wanted & REQUIRED:
            present = {host for host in pins if kind in classes_of(host, issuer)}
            if kind == 'edges':
                require(present == EDGE_HOSTS, 'incomplete_host_inventory')
            else:
                require(present, 'incomplete_host_inventory')
    used = {host for hosts in role_hosts.values() for host in hosts}
    require(used == set(pins), 'unapproved_hostname')
    return issuer, enabled, pins, role_hosts


def ordered(values):
    return sorted(set(values), key=ipaddress.IPv4Address)


def enable_command(role):
    """The installer's exact ExecStart for this component, plus its enable flags."""
    text = financial.unit_text(role, '0' * 40)
    command = next(line for line in text.splitlines() if line.startswith('ExecStart='))
    return command + ' ' + ENABLE_ARGUMENTS[role]


def render(snapshot):
    issuer, enabled, pins, role_hosts = validate(snapshot)
    identities = snapshot['identities']
    scope = f'inet {TABLE}'
    lines = ['# Explicit continuous operator pins; no DNS-TTL qualification claim.',
             f'add table {scope}', f'delete table {scope}', f'add table {scope}',
             f'add chain {scope} output {{ type filter hook output priority 10; policy accept; }}']
    for role in ROLES:
        identity = identities[role]
        if identity is None:
            continue
        chain = nft_name(role)
        lines += [f'add chain {scope} {chain}', f'add counter {scope} denied_{chain}',
                  f'add rule {scope} output meta skuid {identity["realUid"]} jump {chain}']
        prefix = f'add rule {scope} {chain} '
        if role in LISTENERS:
            lines.append(prefix + 'oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 '
                         f'tcp sport {LISTENERS[role]} ct direction reply ct state established '
                         'counter accept comment "exact listener reply"')
        if role in enabled:
            hosts = role_hosts[role]
            if role == 'tunnel':
                groups = (('tunnel_ipv4', [h for h in hosts if h in EDGE_HOSTS],
                           (('tcp', 7844), ('udp', 7844)), 'operator pinned external'),
                          ('tunnel_jwks_ipv4', [h for h in hosts if h == issuer],
                           (('tcp', 443),), 'Access middleware JWKS'))
            elif role == 'write':
                groups = (('write_ipv4', hosts, (('tcp', 443),), 'indexer provider egress'),)
            else:
                groups = ((f'{chain}_ipv4', hosts, (('tcp', 443),), 'operator pinned external'),)
            if role == 'write':
                for protocol in ('udp', 'tcp'):
                    lines.append(prefix + f'oifname "lo" ip daddr 127.0.0.53 {protocol} dport 53 '
                                 'counter accept comment "queue worker resolver"')
            for name, group_hosts, ports, comment in groups:
                elements = ordered(a for h in group_hosts for a in pins[h])
                if not elements:
                    continue
                lines.append(f'add set {scope} {name} {{ type ipv4_addr; elements = '
                             '{ ' + ', '.join(elements) + ' }; }')
                for protocol, port in ports:
                    lines.append(prefix + f'oifname != "lo" ip daddr @{name} {protocol} dport {port} '
                                 f'counter accept comment "{comment}"')
            if role == 'tunnel':
                for protocol in ('tcp', 'udp'):
                    lines.append(prefix + f'oifname "lo" ip daddr 127.0.0.53 {protocol} dport 53 '
                                 'counter accept comment "tunnel DNS stub"')
            for target in ORIGINS.get(role, ()):
                if target in enabled:
                    # The reader and its gateway are one read path; the live
                    # table names that hop "read origin" from either side.
                    name = 'read' if target in ('read', 'gateway') else target
                    lines.append(prefix + 'oifname "lo" ip saddr 127.0.0.1 ip daddr 127.0.0.1 '
                                 f'tcp dport {LISTENERS[target]} ct direction original counter accept '
                                 f'comment "exact {name} origin"')
        lines.append(prefix + f'counter name denied_{chain} drop')
    artifacts = {ROOT + '/policy.nft': '\n'.join(lines) + '\n'}
    metadata = {ROOT + '/policy.nft': {'uid': 0, 'gid': 0, 'mode': 0o600}}
    units = []
    for role in enabled:
        unit = unit_of(role)
        if unit is None:
            continue
        units.append(unit)
        # The hosts file pins what the application resolves through /etc/hosts.
        # The connector resolves the edge names itself through the stub; the
        # nft set is what bounds where those answers may lead.
        hosts = [h for h in role_hosts[role] if h not in EDGE_HOSTS]
        hosts_path = None
        if hosts:
            hosts_path = f'{ROOT}/{role}.hosts'
            text = ['127.0.0.1 localhost', '::1 localhost ip6-localhost ip6-loopback']
            text += [f'{address} {host}' for host in hosts for address in ordered(pins[host])]
            artifacts[hosts_path] = '\n'.join(text) + '\n'
            metadata[hosts_path] = {'uid': 0, 'gid': 0, 'mode': 0o644}
        dropin = ['# Explicit continuous read activation; fail closed behind the scoped nft policy.',
                  '[Unit]', f'BindsTo={EGRESS_UNIT}', f'After={EGRESS_UNIT} network-online.target',
                  'Wants=network-online.target', f'PartOf={TARGET}',
                  'ConditionPathExists=', f'ConditionPathExists={READY}']
        if role == 'gateway' and 'read' in enabled:
            dropin += ['Requires=domino-read.service', 'After=domino-read.service']
        dropin += ['[Service]', 'IPAddressAllow=', 'IPAddressDeny=', 'IPAddressDeny=any',
                   'IPAddressAllow=127.0.0.1/32']
        if role in DNS_STUB:
            dropin.append('IPAddressAllow=127.0.0.53/32')
        dropin += [f'IPAddressAllow={a}/32' for a in ordered(a for h in role_hosts[role] for a in pins[h])]
        dropin.append(UNSET)
        if hosts_path:
            dropin.append(f'BindReadOnlyPaths={hosts_path}:/etc/hosts')
        if role == 'gateway':
            dropin.append(f'EnvironmentFile={ROOT}/gateway.env')
        if role in ENABLE_ARGUMENTS:
            dropin += ['ExecStart=', enable_command(role)]
        path = f'{UNIT_DIR}{unit}.d/{DROPIN}'
        artifacts[path] = '\n'.join(dropin) + '\n'
        metadata[path] = {'uid': 0, 'gid': 0, 'mode': 0o644}
    members = ' '.join([EGRESS_UNIT, *units])
    target = ['[Unit]', 'Description=Domino continuously supervised token and pool-market reads',
              f'Requires={members}', f'After=network-online.target {members}',
              'Wants=network-online.target', '', '[Install]', 'WantedBy=multi-user.target']
    artifacts[UNIT_DIR + TARGET] = '\n'.join(target) + '\n'
    metadata[UNIT_DIR + TARGET] = {'uid': 0, 'gid': 0, 'mode': 0o644}
    digest = lambda text: hashlib.sha256(text.encode()).hexdigest()
    pin_scope = json.dumps({'issuer': issuer, 'enabled': enabled, 'pins': pins}, sort_keys=True)
    return {'version': 1, 'kind': 'domino-continuous-egress-v1', 'applied': False,
            'policyQualified': False, 'enabled': list(enabled),
            'roleHosts': {role: hosts for role, hosts in role_hosts.items() if hosts},
            'units': units, 'pinSetSha256': digest(pin_scope),
            'artifacts': artifacts, 'artifactSha256': {p: digest(t) for p, t in artifacts.items()},
            'artifactMetadata': metadata,
            'notPerformed': ['name resolution', 'host inspection', 'file write',
                             'daemon-reload', 'service start or restart', 'Access application',
                             'tunnel route', 'Worker flag', 'environment or profile contents']}


def main():
    if len(sys.argv) != 1:
        print(json.dumps({'ok': False, 'error': 'stdin_only_no_arguments'}))
        return 2
    try:
        result = render(parse(sys.stdin.buffer.read(shared.MAX_BYTES + 1)))
    except InvalidSnapshot as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        return 2
    print(json.dumps(result, sort_keys=True, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
