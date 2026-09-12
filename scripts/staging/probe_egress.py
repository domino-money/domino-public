#!/usr/bin/env python3
"""Credential-free TCP/TLS observations; never installs policy or starts services.

Default mode only validates stdin. --execute requires the intended non-root UID
and exact cgroup v2 path. A denial is an observation, not firewall attestation.
"""
import argparse
import errno
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import ssl
import sys
import time

MAX_BYTES = 16384
MAX_PROBES = 12
BUDGET_SECONDS = 40
HOST = re.compile(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}')


def require(condition, code):
    if not condition:
        raise ValueError(code)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate_key')
        result[key] = value
    return result


def manifest(raw):
    require(len(raw) <= MAX_BYTES, 'input_limit')
    try:
        value = json.loads(raw, object_pairs_hook=unique_object)
    except (ValueError, UnicodeError, RecursionError):
        raise ValueError('invalid_json') from None
    require(type(value) is dict and set(value) == {'version', 'probes'}, 'invalid_manifest')
    require(type(value['version']) is int and value['version'] == 1, 'invalid_version')
    rows = value['probes']
    require(type(rows) is list and 1 <= len(rows) <= MAX_PROBES, 'invalid_probe_count')
    labels = set()
    for row in rows:
        require(type(row) is dict and set(row) in (
            {'id', 'address', 'port', 'expect'},
            {'id', 'address', 'port', 'expect', 'tlsName'}), 'invalid_probe')
        label = row['id']
        require(type(label) is str and re.fullmatch('[a-z][a-z0-9-]{0,39}', label)
                and label not in labels, 'invalid_probe_id')
        labels.add(label)
        try:
            address = ipaddress.ip_address(row['address'])
        except (ValueError, TypeError):
            raise ValueError('invalid_address') from None
        require(type(row['address']) is str and str(address) == row['address']
                and not address.is_multicast and not address.is_unspecified
                and '%' not in row['address'], 'invalid_address')
        require(type(row['port']) is int and 1 <= row['port'] <= 65535, 'invalid_port')
        require(row['expect'] in ('connect', 'deny'), 'invalid_expectation')
        if 'tlsName' in row:
            name = row['tlsName']
            require(type(name) is str and len(name) <= 253 and HOST.fullmatch(name)
                    and row['expect'] == 'connect', 'invalid_tls_name')
    return rows


def identity(expected_uid, expected_cgroup):
    require(type(expected_uid) is int and expected_uid > 0, 'nonroot_uid_required')
    require(type(expected_cgroup) is str and expected_cgroup.startswith('/')
            and len(expected_cgroup) <= 512 and '..' not in expected_cgroup.split('/')
            and all(33 <= ord(char) <= 126 for char in expected_cgroup), 'invalid_cgroup')
    require(os.geteuid() == expected_uid, 'uid_mismatch')
    lines = Path('/proc/self/cgroup').read_text().splitlines()
    groups = [line[3:] for line in lines if line.startswith('0::')]
    require(groups == [expected_cgroup], 'cgroup_mismatch')


def observe(row, deadline):
    address = ipaddress.ip_address(row['address'])
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return 'budget_exhausted'
    try:
        # Numeric sockaddr prevents getaddrinfo, proxy use and DNS-induced hangs.
        family = socket.AF_INET if address.version == 4 else socket.AF_INET6
        with socket.socket(family, socket.SOCK_STREAM) as connection:
            connection.settimeout(min(3, remaining))
            connection.connect((row['address'], row['port']))
            if 'tlsName' not in row:
                return 'connected'
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return 'budget_exhausted'
            connection.settimeout(min(3, remaining))
            # Default CA and hostname validation; sends no HTTP, JWT or key.
            with ssl.create_default_context().wrap_socket(
                    connection, server_hostname=row['tlsName']):
                return 'tls_verified'
    except ssl.SSLError:
        return 'tls_failed'
    except OSError as error:
        if error.errno in (errno.EPERM, errno.EACCES):
            return 'permission_denied'
        if error.errno == errno.ECONNREFUSED:
            return 'connection_refused'
        if isinstance(error, TimeoutError):
            return 'timed_out'
        return 'network_error'


def result(row, observed):
    expected = ('permission_denied' if row['expect'] == 'deny' else
                'tls_verified' if 'tlsName' in row else 'connected')
    if observed == expected:
        status = 'observed'
    elif observed in ('connected', 'tls_verified', 'permission_denied', 'tls_failed'):
        status = 'mismatch'
    else:
        # Timeout/refusal/no-route are not evidence that our policy blocked it.
        status = 'inconclusive'
    return {'id': row['id'], 'expect': row['expect'], 'observed': observed, 'status': status}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--expected-uid', type=int)
    parser.add_argument('--expected-cgroup')
    args = parser.parse_args(argv)
    try:
        rows = manifest(sys.stdin.buffer.read(MAX_BYTES + 1))
        if not args.execute:
            print(json.dumps({'mode': 'validation-only', 'probes': len(rows),
                              'networkPerformed': False, 'policyQualified': False}))
            return 0
        identity(args.expected_uid, args.expected_cgroup)
        deadline = time.monotonic() + BUDGET_SECONDS
        observations = [result(row, observe(row, deadline)) for row in rows]
        print(json.dumps({'mode': 'tcp-tls-observation', 'identityMatched': True,
                          'policyQualified': False, 'results': observations}))
        return 0 if all(row['status'] == 'observed' for row in observations) else 1
    except (ValueError, OSError, TypeError):
        # No input, URL, library diagnostic, private path or traceback escapes.
        print(json.dumps({'mode': 'error', 'code': 'probe_rejected', 'policyQualified': False}))
        return 2


if __name__ == '__main__':
    sys.exit(main())
