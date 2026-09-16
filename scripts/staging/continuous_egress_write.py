#!/usr/bin/env python3
"""Render the queue-worker egress fragment for the continuous policy file.

The continuous policy (/etc/domino/continuous-reads/policy.nft) is an operator
artifact, applied by domino-continuous-egress.service with an explicit flush and
re-add, so a runtime `nft insert` disappears on the next apply. This renders the
exact lines an operator must fold into that file, from sanitized stdin only: no
network, no host access, no file writes, no service call.

Input: {"resolver": "127.0.0.53", "providerIpv4": ["40.160.64.137", ...]}
Output: the `add set` and three `add rule` lines, in the order the chain needs
them (accepts before the existing drop).
"""
import ipaddress
import json
import re
import sys

MAX_INPUT_BYTES = 8192
MAX_ADDRESSES = 64
SET_NAME = 'write_ipv4'
TABLE = 'domino_continuous_reads'
IPV4 = re.compile(r'^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$')


def checked(payload):
    if not isinstance(payload, dict) or set(payload) != {'resolver', 'providerIpv4'}:
        raise ValueError('invalid_input')
    resolver = payload['resolver']
    if not isinstance(resolver, str) or not IPV4.fullmatch(resolver):
        raise ValueError('invalid_resolver')
    resolver = ipaddress.IPv4Address(resolver)
    if not resolver.is_loopback:
        raise ValueError('resolver_must_be_loopback')
    addresses = payload['providerIpv4']
    if not isinstance(addresses, list) or not 1 <= len(addresses) <= MAX_ADDRESSES:
        raise ValueError('invalid_provider_addresses')
    checked_addresses = []
    for value in addresses:
        if not isinstance(value, str) or not IPV4.fullmatch(value):
            raise ValueError('invalid_provider_addresses')
        address = ipaddress.IPv4Address(value)
        if not address.is_global:
            raise ValueError('provider_address_not_public')
        if str(address) not in checked_addresses:
            checked_addresses.append(str(address))
    return str(resolver), checked_addresses


def render(resolver, addresses):
    return [
        f'add set inet {TABLE} {SET_NAME} {{ type ipv4_addr; elements = '
        '{ ' + ', '.join(addresses) + ' }; }',
        f'add rule inet {TABLE} write oifname "lo" ip daddr {resolver} udp dport 53 '
        'counter accept comment "queue worker resolver"',
        f'add rule inet {TABLE} write oifname "lo" ip daddr {resolver} tcp dport 53 '
        'counter accept comment "queue worker resolver"',
        f'add rule inet {TABLE} write oifname != "lo" ip daddr @{SET_NAME} tcp dport 443 '
        'counter accept comment "indexer provider egress"',
    ]


def main():
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        print('invalid_input', file=sys.stderr)
        return 1
    try:
        resolver, addresses = checked(json.loads(raw))
    except (ValueError, TypeError, json.JSONDecodeError):
        print('invalid_input', file=sys.stderr)
        return 1
    for line in render(resolver, addresses):
        print(line)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
