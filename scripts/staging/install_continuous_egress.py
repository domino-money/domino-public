#!/usr/bin/env python3
"""Collect the continuous egress inputs on this host, and install a rendered candidate. Starts nothing.

continuous_egress_policy.py renders the policy, hosts files, 60 drop-ins and the
target from operator pins, and resolves or writes nothing (docs/CONTINUOUS_EGRESS.md).
On the first VM the pins were gathered and the artifacts copied by hand, and the
egress service itself was a hand-written unit. On a fresh host:

1. `--collect` prints the renderer's input: each of the thirteen identities as the
   accounts and units on this host define them, and the current IPv4 addresses
   of every hostname the enabled roles' classes need, resolved here;
2. continuous_egress_policy.py < pins.json > candidate.json, reviewed;
3. `--candidate candidate.json --apply` writes every artifact with its rendered
   owner and mode, plus the egress service, checks the policy with `nft -c` and
   reloads systemd. It loads no table and starts no unit: the egress service
   applies the policy when domino-continuous-reads.target starts at cutover.

Pins age: when a provider moves, collect and render again (the same procedure).
"""
import argparse
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import socket
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import continuous_egress_policy as policy
import egress_policy
import prepare_disabled as install

require = install.require
EGRESS_SERVICE = install.UNIT_DIR / policy.EGRESS_UNIT
# The first VM's hand-written unit, byte for byte.
EGRESS_SERVICE_TEXT = f"""[Unit]
Description=Domino continuous read egress (explicit operator IPv4 pins)
Before=domino-read.service domino-gateway.service domino-tunnel.service
PartOf={policy.TARGET}

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f {policy.ROOT}/policy.nft
ExecStartPost=/usr/bin/touch {policy.READY}
ExecStop=/usr/bin/rm -f {policy.READY}
# Retain the restrictive kernel table when stopped; never flush host rules.
UMask=0077
ProtectSystem=strict
ReadWritePaths=/run
ProtectHome=yes
PrivateTmp=yes
NoNewPrivileges=yes
CapabilityBoundingSet=CAP_NET_ADMIN
RestrictAddressFamilies=AF_NETLINK
"""
CLASS_HOSTS = {'rpc': policy.RPC_HOSTS, 'analytics': policy.ANALYTICS_HOSTS,
               'uniswap': policy.UNISWAP_HOSTS, 'edges': policy.EDGE_HOSTS}


def identity(role):
    """One role as its account and unit define it; the services need not be running."""
    try:
        account = pwd.getpwnam('domino-' + role)
    except KeyError:
        return None
    unit = policy.unit_of(role)
    groups = set(os.getgrouplist(account.pw_name, account.pw_gid)) - {account.pw_gid}
    if unit is not None:
        value = install.run(['/usr/bin/systemctl', 'show', unit, '-p', 'SupplementaryGroups', '--value'])
        groups |= {grp.getgrnam(name).gr_gid for name in value.decode().split()}
    return {'user': account.pw_name, 'realUid': account.pw_uid, 'effectiveUid': account.pw_uid,
            'gid': account.pw_gid, 'supplementaryGids': sorted(groups), 'unit': unit,
            'cgroup': None if unit is None else '/system.slice/' + unit}


def needed_hosts(enabled, issuer, collectors):
    classes = {kind for role in enabled for kind in policy.CLASSES[role]}
    if collectors:
        classes.add('analytics')
    hosts = {host for kind in classes if kind in CLASS_HOSTS for host in CLASS_HOSTS[kind]}
    if 'jwks' in classes:
        hosts.add(issuer)
    return sorted(hosts)


def resolve(hostname):
    found = {info[4][0] for info in socket.getaddrinfo(hostname, 443, socket.AF_INET, socket.SOCK_STREAM)}
    if hostname in egress_policy.EDGE_ADDRESSES:
        found &= egress_policy.EDGE_ADDRESSES[hostname]
    require(found, 'host_did_not_resolve')
    return sorted(found)


def collect(issuer, enabled, loopback, collectors):
    identities = {role: identity(role) for role in policy.ROLES}
    hosts = [{'hostname': host, 'addresses': resolve(host)}
             for host in needed_hosts(enabled, issuer, collectors)]
    snapshot = {'version': 1, 'resolver': '127.0.0.53', 'accessIssuer': issuer, 'enabled': enabled,
                'identities': identities, 'hosts': hosts}
    if loopback:
        snapshot['sequenceSnapshotLoopback'] = True
    if collectors:
        snapshot['publicDataCollectors'] = True
    policy.validate(snapshot)
    return snapshot


def allowed(path):
    """Only what the renderer may write: its directory, the 60 drop-ins and the target."""
    return (path.startswith(policy.ROOT + '/') and path.count('/') == policy.ROOT.count('/') + 1
            or path == policy.UNIT_DIR + policy.TARGET
            or path.startswith(policy.UNIT_DIR + 'domino-') and path.endswith('.service.d/' + policy.DROPIN))


def plan(candidate):
    require(candidate.get('kind') == 'domino-continuous-egress-v1' and candidate.get('version') == 1
            and candidate.get('applied') is False, 'not_a_continuous_egress_candidate')
    artifacts, metadata = candidate['artifacts'], candidate['artifactMetadata']
    require(set(artifacts) == set(metadata) == set(candidate['artifactSha256']), 'candidate_incomplete')
    for path, text in artifacts.items():
        require(allowed(path), 'candidate_path_not_allowed')
        require(hashlib.sha256(text.encode()).hexdigest() == candidate['artifactSha256'][path],
                'candidate_artifact_changed')
        require(metadata[path]['uid'] == 0 and metadata[path]['gid'] == 0
                and metadata[path]['mode'] in (0o600, 0o644), 'candidate_metadata_unexpected')
        require(not os.path.lexists(path), 'egress_artifact_exists')
    require(not os.path.lexists(EGRESS_SERVICE), 'egress_service_exists')
    return {'mode': 'continuous-egress', 'pinSetSha256': candidate['pinSetSha256'],
            'enabled': candidate['enabled'], 'artifacts': sorted(artifacts) + [str(EGRESS_SERVICE)],
            'notPerformed': ['nft table load', 'unit enable or start', 'gateway.env (secrets phase)']}


def apply(candidate, planned):
    require(os.geteuid() == 0, 'root_required')
    root = Path(policy.ROOT)
    if not root.exists():
        install.trusted_parents(root.parent)
        root.mkdir(mode=0o755)
    for path, text in sorted(candidate['artifacts'].items()):
        target = Path(path)
        target.parent.mkdir(mode=0o755, exist_ok=True)
        install.exclusive_file(target, text.encode(), candidate['artifactMetadata'][path]['mode'])
    install.exclusive_file(EGRESS_SERVICE, EGRESS_SERVICE_TEXT.encode(), 0o644)
    install.run(['/usr/sbin/nft', '-c', '-f', str(root / 'policy.nft')])
    install.run(['/usr/bin/systemctl', 'daemon-reload'])
    return {**planned, 'ok': True, 'installed': True, 'policyChecked': True,
            'next': 'gateway.env in the secrets phase; domino-continuous-reads.target at cutover'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--collect', action='store_true')
    mode.add_argument('--inspect', action='store_true')
    mode.add_argument('--apply', action='store_true')
    parser.add_argument('--access-issuer')
    parser.add_argument('--enabled', help='comma-separated roles, e.g. read,gateway,tunnel,write')
    parser.add_argument('--sequence-snapshot-loopback', action='store_true')
    parser.add_argument('--public-data-collectors', action='store_true')
    parser.add_argument('--candidate', type=Path)
    args = parser.parse_args(argv)
    try:
        if args.collect:
            require(args.access_issuer and args.enabled, 'issuer_and_enabled_required')
            result = collect(args.access_issuer, args.enabled.split(','), args.sequence_snapshot_loopback,
                             args.public_data_collectors)
        else:
            require(args.candidate is not None, 'candidate_required')
            candidate = json.loads(args.candidate.read_text())
            planned = plan(candidate)
            result = apply(candidate, planned) if args.apply else {**planned, 'ok': True, 'installed': False}
        print(json.dumps(result, indent=2))
        return 0
    except Exception as error:
        reason = str(error) if isinstance(error, ValueError) else type(error).__name__
        print(json.dumps({'ok': False, 'reason': reason, 'action': 'no table loaded and nothing started'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
