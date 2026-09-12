#!/usr/bin/env python3
"""Bounded, credential-free egress observations; NEVER reports policy qualified.

Run Python >= 3.12 with -I -B and one absolute path to a nonsecret plan. Every
path component must be root-owned and not group/other-writable, without links.
JSON exact keys (no extra values):
 version: 1; role: read/gateway/tunnel/auth/onboarding/deposit;
 uid, gid: positive integer IDs; supplementaryGids: exact sorted set of IDs;
 cgroup: /system.slice/domino-<role>.service (actual membership is verified);
 expiresAtUnix: integer, > now + 12 and <= now + 65;
 permittedHttps: [{ip: approved public IPv4 literal, tlsName: approved DNS name}];
 edgeIps: [official edge public IPv4 literals]; dnsName: approved DNS name;
 localAllowedPorts: gateway [8876], tunnel [8878,8879,8880], others [];
 negativeTargets: {allowedIpv4, unlistedIpv4, externalDnsIpv4, globalIpv6};
 globalIpv6 may be null, meaning no IPv6 reachability qualification.
 HTTPS/edge lists are empty for deny-only roles. Only tunnel has edges.
 The plan's authorization is an operator assertion, not proved by this program.

Only coordinated fixed PING/PONG listeners on each role's 127.0.0.1 port are
started. No credentials, URLs, application config, subprocesses, file writes,
privilege changes, or firewall changes. System CA bundle is the only TLS trust
source; no environment-based trust overrides. OS identity and cgroup are read.

Per-probe observations are concurrent; an external controller must isolate the
UID, record nft counters/BPF attachment and correlate phases/timestamps. UDP
kernel send acceptance is NEVER reachability/denial evidence. The reserved QUIC
version probe only establishes a nonce-correlated response, not authentication:
https://www.rfc-editor.org/rfc/rfc9000.html#section-6.3
https://www.rfc-editor.org/rfc/rfc9000.html#section-17.2.1
No tunnel connector or successful QUIC connection is created.

Existing TLS sends after expiry only report local kernel acceptance and whether
any response byte was observed. They do not prove delivery or firewall denial.
The fixed local listeners stay available through expiry. The controller must
establish counterpart availability/positive controls. Source-port bind failure
is explicitly untested; no listener is closed to manufacture an apparent deny.
After all phases the process holds at most 10 seconds for cgroup BPF inspection; an
independent hard 90-second alarm bounds the entire lifetime.
"""
from __future__ import annotations

import concurrent.futures
import errno
import ipaddress
import json
import os
import re
import signal
import socket
import ssl
import stat
import struct
import sys
import threading
import time

PREFIX = 'DOMINO_EGRESS_PROBE '
LOCK = threading.Lock()
ROLES = {'read', 'gateway', 'tunnel', 'auth', 'onboarding', 'deposit'}
ENABLED = {'read', 'gateway', 'tunnel'}
PORTS = [8876, 8878, 8879, 8880, 8881, 22, 20241]
SERVER_PORT = {'read': 8876, 'gateway': 8878, 'auth': 8879, 'onboarding': 8880, 'deposit': 8881, 'tunnel': 20241}
EDGE_IPS = {f'198.41.192.{n}' for n in [167, 67, 57, 107, 27, 7, 227, 47, 37, 77]} | {f'198.41.200.{n}' for n in [13, 193, 33, 233, 53, 63, 113, 73, 43, 23]}
START = time.monotonic()
PLAN = None
HELD = []
LISTENER = None
LISTENER_STOP = threading.Event()
RUN_INVALID = threading.Event()
PING = b'DOMINO_EGRESS_PING\n'
PONG = b'DOMINO_EGRESS_PONG\n'


def emit(event, **fields):
    with LOCK:
        print(PREFIX + json.dumps({'event': event, 'unixTime': round(time.time(), 6), 'elapsed': round(time.monotonic() - START, 3), 'policyQualified': False, **fields}, separators=(',', ':'), sort_keys=True), flush=True)


def fail(code):
    raise ValueError(code)


def integer(value, low=1, high=2**31-1):
    return type(value) is int and low <= value <= high


def hostname(value):
    return isinstance(value, str) and len(value) <= 253 and value == value.lower() and len(value.split('.')) >= 2 and all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in value.split('.'))


def public_ip(value, version):
    if not isinstance(value, str):
        return False
    try:
        ip = ipaddress.ip_address(value)
        return ip.version == version and str(ip) == value and ip.is_global and not ip.is_multicast and not ip.is_reserved
    except ValueError:
        return False


def secure_read(path):
    if not isinstance(path, str) or not path.startswith('/') or len(path) > 1024:
        fail('invalid_plan_path')
    parts = path.split('/')[1:]
    if any(part in {'', '.', '..'} for part in parts):
        fail('invalid_plan_path')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for index, part in enumerate(parts):
            flags = os.O_RDONLY | os.O_NOFOLLOW
            if index < len(parts) - 1:
                flags |= os.O_DIRECTORY
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
            meta = os.fstat(fd)
            if meta.st_uid != 0 or meta.st_mode & 0o022:
                fail('plan_not_root_controlled')
        meta = os.fstat(fd)
        if not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1 or not 1 <= meta.st_size <= 32768:
            fail('invalid_plan_file')
        data = os.read(fd, 32769)
        if len(data) > 32768:
            fail('plan_too_large')
        return data
    finally:
        os.close(fd)


def unique_object(items):
    result = {}
    for key, value in items:
        if key in result:
            fail('duplicate_plan_key')
        result[key] = value
    return result


def validate(plan):
    keys = {'version', 'role', 'uid', 'gid', 'supplementaryGids', 'cgroup', 'expiresAtUnix', 'permittedHttps', 'edgeIps', 'dnsName', 'localAllowedPorts', 'negativeTargets'}
    if type(plan) is not dict or set(plan) != keys or type(plan['version']) is not int or plan['version'] != 1:
        fail('invalid_plan_schema')
    role = plan['role']
    if type(role) is not str or role not in ROLES or not integer(plan['uid']) or not integer(plan['gid']) or plan['uid'] == 65534 or plan['gid'] == 65534:
        fail('invalid_identity_plan')
    groups = plan['supplementaryGids']
    if type(groups) is not list or len(groups) > 16 or not all(integer(g) for g in groups) or groups != sorted(set(groups)):
        fail('invalid_groups_plan')
    if plan['cgroup'] != f'/system.slice/domino-{role}.service':
        fail('invalid_cgroup_plan')
    if type(plan['expiresAtUnix']) is not int or not 12 < plan['expiresAtUnix'] - time.time() <= 65:
        fail('invalid_expiry_budget')
    https = plan['permittedHttps']
    if type(https) is not list or len(https) > 8:
        fail('invalid_https_plan')
    for target in https:
        if type(target) is not dict or set(target) != {'ip', 'tlsName'} or not public_ip(target['ip'], 4) or not hostname(target['tlsName']):
            fail('invalid_https_target')
    if len({(t['ip'], t['tlsName']) for t in https}) != len(https) or (https and role not in {'read', 'gateway'}):
        fail('invalid_role_https')
    if role in {'read', 'gateway'} and not https:
        fail('missing_https_target')
    edges = plan['edgeIps']
    if type(edges) is not list or len(edges) > 20 or any(type(ip) is not str or ip not in EDGE_IPS for ip in edges) or len(set(edges)) != len(edges) or (edges and role != 'tunnel') or (role == 'tunnel' and not edges):
        fail('invalid_edge_plan')
    if not hostname(plan['dnsName']):
        fail('invalid_dns_name')
    expected_ports = [8876] if role == 'gateway' else [8878, 8879, 8880] if role == 'tunnel' else []
    if plan['localAllowedPorts'] != expected_ports:
        fail('invalid_local_targets')
    neg = plan['negativeTargets']
    if type(neg) is not dict or set(neg) != {'allowedIpv4', 'unlistedIpv4', 'externalDnsIpv4', 'globalIpv6'} or not all(public_ip(neg[key], 4) for key in ['allowedIpv4', 'unlistedIpv4', 'externalDnsIpv4']):
        fail('invalid_negative_targets')
    if neg['unlistedIpv4'] in {t['ip'] for t in https} | set(edges) | {neg['allowedIpv4']}:
        fail('unlisted_target_is_listed')
    if neg['globalIpv6'] is not None and not public_ip(neg['globalIpv6'], 6):
        fail('invalid_ipv6_target')
    return plan


def identity():
    if os.getuid() != PLAN['uid'] or os.geteuid() != PLAN['uid'] or os.getgid() != PLAN['gid'] or os.getegid() != PLAN['gid'] or sorted(os.getgroups()) != PLAN['supplementaryGids']:
        fail('runtime_identity_mismatch')
    with open('/proc/self/cgroup', 'rt', encoding='ascii') as stream:
        lines = stream.read(4097)
    if len(lines) > 4096 or lines.splitlines() != ['0::' + PLAN['cgroup']]:
        fail('runtime_cgroup_mismatch')


def error_code(exc):
    if isinstance(exc, ssl.SSLCertVerificationError):
        return 'tls_certificate_rejected'
    if isinstance(exc, ssl.SSLError):
        return 'tls_error'
    if isinstance(exc, TimeoutError):
        return 'timeout'
    mapping = {errno.EACCES: 'eacces', errno.EPERM: 'eperm', errno.ECONNREFUSED: 'refused', errno.ENETUNREACH: 'network_unreachable', errno.EHOSTUNREACH: 'host_unreachable', errno.EADDRINUSE: 'source_port_in_use', errno.EADDRNOTAVAIL: 'address_unavailable', errno.ECONNRESET: 'reset', errno.EPIPE: 'broken_pipe'}
    return mapping.get(getattr(exc, 'errno', None), 'socket_error')


def remaining(deadline):
    result = deadline - time.monotonic()
    if result <= 0:
        raise TimeoutError()
    return result


def fresh_socket(ip, kind, deadline):
    if RUN_INVALID.is_set():
        fail('run_already_invalid')
    identity()  # Immediately before every socket; no names are resolved.
    sock = socket.socket(socket.AF_INET6 if ':' in ip else socket.AF_INET, kind)
    sock.settimeout(remaining(deadline))
    return sock


def tcp(ip, port, tls_name=None, retain=False, source_port=None, local_http=False):
    deadline = time.monotonic() + 3
    sock = fresh_socket(ip, socket.SOCK_STREAM, deadline)
    try:
        if source_port is not None:
            sock.bind(('127.0.0.1', source_port))
        sock.connect((ip, port))
        if tls_name:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            context.load_verify_locations(cafile='/etc/ssl/certs/ca-certificates.crt')
            sock.settimeout(remaining(deadline))
            sock = context.wrap_socket(sock, server_hostname=tls_name)
        result = {'observation': 'tls_verified' if tls_name else 'tcp_connected'}
        if local_http:
            sock.settimeout(remaining(deadline))
            sock.sendall(PING)
            response = read_exact(sock, len(PONG), deadline)
            result['fixedPongObserved'] = response == PONG
        if retain:
            with LOCK:
                HELD.append((sock, tls_name, ip, port))
            sock = None
            result['heldForExpiry'] = True
        return result
    finally:
        if sock is not None:
            sock.close()


def start_listener():
    global LISTENER
    role = PLAN['role']
    if role not in SERVER_PORT:
        emit('listener_absent', role=role, reason='no_installed_service_port')
        return
    identity()
    listener = fresh_socket('127.0.0.1', socket.SOCK_STREAM, time.monotonic() + 3)
    try:
        listener.bind(('127.0.0.1', SERVER_PORT[role]))
        listener.listen(32)
        listener.settimeout(0.2)
    except Exception:
        listener.close()
        raise
    LISTENER = listener
    def serve():
        while not LISTENER_STOP.is_set() and time.monotonic() - START < 88:
            try:
                connection, peer = listener.accept()
            except TimeoutError:
                continue
            except OSError:
                break
            with connection:
                try:
                    identity()
                    deadline = time.monotonic() + 1
                    data = read_exact(connection, len(PING), deadline)
                    if peer[0] == '127.0.0.1' and data == PING:
                        connection.settimeout(remaining(deadline))
                        connection.sendall(PONG)
                        emit('listener_pong_written', role=role, localPort=SERVER_PORT[role], kernelAcceptedOnly=True)
                except ValueError:
                    RUN_INVALID.set()
                    emit('invalid_run', role=role, code='listener_identity_mismatch')
                    break
                except OSError:
                    pass
        emit('listener_stopped', role=role)
    threading.Thread(target=serve, daemon=True).start()
    emit('listener_ready', role=role, localPort=SERVER_PORT[role], bindAddress='127.0.0.1')


def stop_listener():
    LISTENER_STOP.set()
    if LISTENER is not None:
        LISTENER.close()


def dns_packet(name):
    nonce = os.urandom(2)
    question = b''.join(bytes([len(label)]) + label.encode('ascii') for label in name.split('.')) + b'\x00\x00\x01\x00\x01'
    return nonce, struct.pack('!HHHHHH', int.from_bytes(nonce, 'big'), 0x0100, 1, 0, 0, 0) + question


def read_exact(sock, count, deadline):
    data = b''
    while len(data) < count:
        sock.settimeout(remaining(deadline))
        part = sock.recv(count - len(data))
        if not part:
            raise ConnectionResetError()
        data += part
    return data


def dns(ip, transport):
    deadline = time.monotonic() + 3
    nonce, query = dns_packet(PLAN['dnsName'])
    with fresh_socket(ip, socket.SOCK_DGRAM if transport == 'udp' else socket.SOCK_STREAM, deadline) as sock:
        sock.connect((ip, 53))
        sock.sendall(query if transport == 'udp' else struct.pack('!H', len(query)) + query)
        sock.settimeout(remaining(deadline))
        if transport == 'udp':
            data = sock.recv(4096)
        else:
            size = int.from_bytes(read_exact(sock, 2, deadline), 'big')
            if not 12 <= size <= 4096:
                return {'observation': 'invalid_dns_response'}
            data = read_exact(sock, size, deadline)
        if len(data) < 12 or data[:2] != nonce or not data[2] & 0x80:
            return {'observation': 'invalid_dns_response'}
        flags = int.from_bytes(data[2:4], 'big')
        return {'observation': 'dns_response', 'rcode': flags & 15, 'answerCount': int.from_bytes(data[6:8], 'big'), 'truncated': bool(flags & 0x200), 'peerAuthenticated': False}


def quic(ip, port):
    # Reserved 0x?a?a?a?a version; no authenticated QUIC handshake or retry.
    deadline = time.monotonic() + 3
    version = 0x0A0A0A0A
    dcid, scid = os.urandom(16), os.urandom(16)
    header = b'\xc0' + struct.pack('!I', version) + bytes([len(dcid)]) + dcid + bytes([len(scid)]) + scid
    payload = header + bytes(1200 - len(header))
    with fresh_socket(ip, socket.SOCK_DGRAM, deadline) as sock:
        sock.connect((ip, port))  # Kernel filters the source tuple of replies.
        sent = sock.send(payload)
        sock.settimeout(remaining(deadline))
        try:
            data = sock.recv(2048)
        except OSError as exc:
            return {'observation': error_code(exc), 'udpKernelAcceptedBytes': sent, 'reachabilityProved': False}
        valid = len(data) >= 7 and data[0] & 0x80 and data[1:5] == bytes(4)
        if valid:
            dlen = data[5]
            offset = 6 + dlen
            valid = offset < len(data) and data[6:offset] == scid
            if valid:
                slen = data[offset]
                versions_offset = offset + 1 + slen
                valid = data[offset + 1:versions_offset] == dcid and len(data) >= versions_offset + 4 and (len(data) - versions_offset) % 4 == 0
                if valid:
                    versions = [int.from_bytes(data[i:i+4], 'big') for i in range(versions_offset, len(data), 4)]
                    valid = version not in versions and 0 not in versions
        return {'observation': 'quic_version_negotiation_nonce_match' if valid else 'unvalidated_udp_response', 'udpKernelAcceptedBytes': sent, 'responseBytes': len(data), 'nonceMatched': bool(valid), 'peerAuthenticated': False, 'reachabilityProved': bool(valid)}


def observed(phase, name, expected, fn, *args, **kwargs):
    emit('probe_started', role=PLAN['role'], phase=phase, probe=name, expected=expected)
    try:
        result = fn(*args, **kwargs)
    except ValueError:
        RUN_INVALID.set()
        result = {'observation': 'runtime_identity_mismatch', 'invalidRun': True}
    except OSError as exc:
        result = {'observation': error_code(exc)}
        if getattr(exc, 'errno', None) == errno.EADDRINUSE and kwargs.get('source_port') is not None:
            result.update(untested=True, conclusive=False, packetAttempted=False)
    except Exception:
        RUN_INVALID.set()
        result = {'observation': 'internal_probe_error', 'invalidRun': True}
    emit('probe_observed', role=PLAN['role'], phase=phase, probe=name, expected=expected, **result)


def phase_jobs(phase):
    active = phase == 'before_expiry'
    role = PLAN['role']
    jobs = []
    expectation = 'permit' if active and role in ENABLED else 'deny'
    # Schedule origin request/reply probes first while all coordinated units listen.
    for port in PLAN['localAllowedPorts']:
        jobs.append((f'local_allowed_{port}', expectation, tcp, ('127.0.0.1', port), {'local_http': True}))
    for i, target in enumerate(PLAN['permittedHttps']):
        jobs.append((f'https_{i}', expectation, tcp, (target['ip'], 443), {'tls_name': target['tlsName'], 'retain': active and i == 0}))
    for i, ip in enumerate(PLAN['edgeIps']):
        jobs.extend([(f'edge_tcp_{i}', expectation, tcp, (ip, 7844), {}), (f'edge_udp_{i}', expectation, quic, (ip, 7844), {})])
    for transport in ['udp', 'tcp']:
        jobs.append((f'stub_dns_{transport}', expectation, dns, ('127.0.0.53', transport), {}))
    if not active:
        return jobs
    neg = PLAN['negativeTargets']
    for port in [80, 22, 8443]:
        jobs.append((f'wrong_tcp_port_{port}', 'deny', tcp, (neg['allowedIpv4'], port), {}))
    jobs.append(('wrong_udp_port_443', 'deny', quic, (neg['allowedIpv4'], 443), {}))
    jobs.append(('unlisted_ipv4', 'deny', tcp, (neg['unlistedIpv4'], 443), {}))
    for transport in ['udp', 'tcp']:
        jobs.append((f'external_dns_{transport}', 'deny', dns, (neg['externalDnsIpv4'], transport), {}))
    jobs.append(('external_dns_tls', 'deny', tcp, (neg['externalDnsIpv4'], 853), {}))
    if role not in ENABLED:
        jobs.append(('otherwise_allowed_tcp443', 'deny', tcp, (neg['allowedIpv4'], 443), {}))
    if neg['globalIpv6'] is not None:
        jobs.append(('global_ipv6', 'deny', tcp, (neg['globalIpv6'], 443), {}))
    for port in PORTS:
        if port not in PLAN['localAllowedPorts']:
            jobs.append((f'local_denied_{port}', 'deny', tcp, ('127.0.0.1', port), {}))
    return jobs


def run_phase(phase):
    identity()
    emit('phase_started', role=PLAN['role'], phase=phase)
    with concurrent.futures.ThreadPoolExecutor(max_workers=24) as pool:
        futures = [pool.submit(observed, phase, name, expected, fn, *args, **kwargs) for name, expected, fn, args, kwargs in phase_jobs(phase)]
        for future in futures:
            future.result()
    emit('phase_finished', role=PLAN['role'], phase=phase)
    if RUN_INVALID.is_set():
        fail('probe_phase_invalid')


def held_send(sock, tls_name, ip, port):
    deadline = time.monotonic() + 3
    try:
        identity()
        sock.settimeout(remaining(deadline))
        payload = f'GET / HTTP/1.0\r\nHost: {tls_name}\r\n\r\n'.encode('ascii')
        sent = sock.send(payload)
        response = False
        read_code = 'no_response'
        try:
            sock.settimeout(remaining(deadline))
            response = bool(sock.recv(1))
            read_code = 'response_byte' if response else 'peer_closed'
        except OSError as exc:
            read_code = error_code(exc)
        return {'observation': 'existing_tls_kernel_write_accepted', 'kernelAcceptedBytes': sent, 'deliveryProved': False, 'responseByteObserved': response, 'readObservation': read_code}
    finally:
        sock.close()


def hard_stop(signum, frame):
    try:
        os.set_blocking(1, False)
        os.write(1, (PREFIX + '{"event":"hard_deadline","policyQualified":false}\n').encode('ascii'))
    except OSError:
        pass
    finally:
        os._exit(124)


def main():
    global PLAN
    if sys.version_info < (3, 12) or sys.platform != 'linux' or len(sys.argv) != 2:
        fail('unsupported_runtime_or_arguments')
    signal.signal(signal.SIGALRM, hard_stop)
    signal.setitimer(signal.ITIMER_REAL, 90)
    PLAN = validate(json.loads(secure_read(sys.argv[1]), object_pairs_hook=unique_object))
    identity()
    emit('identity_verified', role=PLAN['role'], uid=os.getuid(), gid=os.getgid(), supplementaryGids=sorted(os.getgroups()), cgroup=PLAN['cgroup'], expiresAtUnix=PLAN['expiresAtUnix'])
    wall_start, mono_start = time.time(), time.monotonic()
    start_listener()
    time.sleep(2)
    run_phase('before_expiry')
    if time.time() >= PLAN['expiresAtUnix']:
        emit('invalid_run', code='positive_phase_crossed_expiry')
        return 2
    emit('waiting_for_expiry', role=PLAN['role'], heldConnections=len(HELD))
    # Do not close a positive counterpart to run a source-port attempt. With a
    # bound fixed listener the bind can be EADDRINUSE; record it as untested.
    emit('phase_started', role=PLAN['role'], phase='source_port_negative')
    if PLAN['role'] in SERVER_PORT:
        destination = 8876 if PLAN['role'] == 'tunnel' else 8881
        observed('source_port_negative', 'source_port_binding_bypass', 'deny', tcp, '127.0.0.1', destination, source_port=SERVER_PORT[PLAN['role']])
    emit('phase_finished', role=PLAN['role'], phase='source_port_negative')
    if RUN_INVALID.is_set():
        fail('source_probe_invalid')
    if time.time() >= PLAN['expiresAtUnix']:
        fail('source_phase_crossed_expiry')
    while time.time() < PLAN['expiresAtUnix'] + 0.5:
        time.sleep(min(0.2, max(0.01, PLAN['expiresAtUnix'] + 0.5 - time.time())))
        if abs((time.time() - wall_start) - (time.monotonic() - mono_start)) > 0.25:
            fail('wall_clock_drift')
    identity()
    emit('expiry_reached', role=PLAN['role'])
    for index, held in enumerate(HELD):
        observed('after_expiry_existing', f'held_tls_{index}', 'deny', held_send, *held)
    if RUN_INVALID.is_set():
        fail('existing_socket_probe_invalid')
    run_phase('after_expiry')
    emit('inspection_hold', role=PLAN['role'], seconds=10, ipv6Qualified=False, controllerCorrelationRequired=True)
    time.sleep(min(10, max(0, 88 - (time.monotonic() - START))))
    if RUN_INVALID.is_set():
        fail('run_invalid_during_inspection')
    emit('complete', role=PLAN['role'], observationsOnly=True, qualified=False)
    return 0


def run_cli():
    try:
        code = main()
    except ValueError as exc:
        known = str(exc)
        emit('invalid_run', code=known if re.fullmatch(r'[a-z_]{1,80}', known) else 'invalid_plan')
        code = 2
    except Exception:
        emit('invalid_run', code='unhandled_runtime_error')
        code = 2
    stop_listener()
    for held in HELD:
        try:
            held[0].close()
        except OSError:
            pass
    return code


if __name__ == '__main__':
    sys.exit(run_cli())
