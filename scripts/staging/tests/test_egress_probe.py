"""Offline checks for diagnostic false positives and identity/secret boundaries."""
import errno
import importlib.util
import io
import json
from pathlib import Path
import socket
import unittest
from types import SimpleNamespace
from unittest.mock import patch, MagicMock

SPEC = importlib.util.spec_from_file_location(
    'probe_egress', Path(__file__).resolve().parents[1] / 'probe_egress.py')
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class EgressProbeTests(unittest.TestCase):
    def row(self, **changes):
        return {'id': 'control', 'address': '192.0.2.1', 'port': 443,
                'expect': 'connect', **changes}

    def payload(self, rows):
        return json.dumps({'version': 1, 'probes': rows}).encode()

    def test_bounded_manifest_accepts_ipv4_ipv6_and_tls(self):
        rows = [self.row(tlsName='provider.example'),
                self.row(id='ipv6', address='2001:db8::1', expect='deny')]
        self.assertEqual(probe.manifest(self.payload(rows)), rows)

    def test_rejects_secret_fields_urls_and_bad_socket_inputs(self):
        for changes in ({'url': 'https://key.example/SECRET'}, {'headers': {}},
                        {'address': 'provider.example'}, {'address': 123},
                        {'address': 'fe80::1%eth0'}, {'address': '0.0.0.0'},
                        {'address': '224.0.0.1'}, {'port': True}, {'port': 65536},
                        {'tlsName': 'https://example.com/SECRET'},
                        {'tlsName': 'provider.example', 'expect': 'deny'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                probe.manifest(self.payload([self.row(**changes)]))

    def test_rejects_duplicate_keys_ids_and_limits(self):
        for raw in (b'{"version":1,"version":1,"probes":[]}',
                    self.payload([self.row(), self.row()]), self.payload([]),
                    self.payload([self.row(id=f'p{i}') for i in range(13)]),
                    b' ' * (probe.MAX_BYTES + 1)):
            with self.subTest(raw_length=len(raw)), self.assertRaises(ValueError):
                probe.manifest(raw)

    def test_identity_requires_real_uid_and_exact_v2_cgroup(self):
        with patch.object(probe.os, 'geteuid', return_value=1234), \
                patch.object(probe.Path, 'read_text', return_value='0::/system.slice/probe.service\n'):
            probe.identity(1234, '/system.slice/probe.service')
            for uid, group in ((0, '/system.slice/probe.service'),
                               (1235, '/system.slice/probe.service'),
                               (1234, '/system.slice/other.service'),
                               (1234, '/system.slice/probe.service/child')):
                with self.subTest(uid=uid, group=group), self.assertRaises(ValueError):
                    probe.identity(uid, group)

    def test_refusal_timeout_and_no_route_never_pass_negative(self):
        row = self.row(expect='deny')
        for observed in ('timed_out', 'connection_refused', 'network_error', 'budget_exhausted'):
            self.assertEqual(probe.result(row, observed)['status'], 'inconclusive')
        self.assertEqual(probe.result(row, 'connected')['status'], 'mismatch')
        self.assertEqual(probe.result(row, 'permission_denied')['status'], 'observed')

    def test_tcp_success_does_not_qualify_tls(self):
        row = self.row(tlsName='provider.example')
        self.assertEqual(probe.result(row, 'connected')['status'], 'mismatch')
        self.assertEqual(probe.result(row, 'tls_verified')['status'], 'observed')

    def test_numeric_connection_uses_no_dns_no_http_and_closes(self):
        connection = MagicMock()
        with patch.object(probe.socket, 'socket') as create, \
                patch.object(probe.socket, 'getaddrinfo', side_effect=AssertionError('DNS called')), \
                patch.object(probe.time, 'monotonic', return_value=1):
            create.return_value.__enter__.return_value = connection
            self.assertEqual(probe.observe(self.row(), 10), 'connected')
            create.assert_called_once_with(socket.AF_INET, socket.SOCK_STREAM)
            connection.connect.assert_called_once_with(('192.0.2.1', 443))
            connection.send.assert_not_called()
            connection.sendall.assert_not_called()
            create.return_value.__exit__.assert_called_once()

    def test_errors_are_sanitized_and_denial_requires_permission_errno(self):
        for failure, expected in ((PermissionError(errno.EPERM, 'SECRET'), 'permission_denied'),
                                  (ConnectionRefusedError(errno.ECONNREFUSED, 'SECRET'), 'connection_refused'),
                                  (TimeoutError('SECRET'), 'timed_out'),
                                  (OSError(errno.ENETUNREACH, 'SECRET'), 'network_error')):
            with self.subTest(expected=expected), patch.object(probe.socket, 'socket') as create, \
                    patch.object(probe.time, 'monotonic', return_value=1):
                create.return_value.__enter__.return_value.connect.side_effect = failure
                self.assertEqual(probe.observe(self.row(), 10), expected)

    def test_expired_budget_never_opens_socket(self):
        with patch.object(probe.socket, 'socket') as create, \
                patch.object(probe.time, 'monotonic', return_value=10):
            self.assertEqual(probe.observe(self.row(), 9), 'budget_exhausted')
            create.assert_not_called()

    def test_default_cli_validates_without_identity_or_network(self):
        output = io.StringIO()
        with patch.object(probe.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(self.payload([self.row()])))), \
                patch.object(probe.sys, 'stdout', output), patch.object(probe, 'identity') as identity, \
                patch.object(probe.socket, 'socket') as create:
            self.assertEqual(probe.main([]), 0)
            identity.assert_not_called()
            create.assert_not_called()
        self.assertFalse(json.loads(output.getvalue())['networkPerformed'])

    def test_cli_wrong_identity_rejects_before_network_without_error_text(self):
        output = io.StringIO()
        with patch.object(probe.sys, 'stdin', SimpleNamespace(buffer=io.BytesIO(self.payload([self.row()])))), \
                patch.object(probe.sys, 'stdout', output), \
                patch.object(probe, 'identity', side_effect=ValueError('PRIVATE')), \
                patch.object(probe.socket, 'socket') as create:
            self.assertEqual(probe.main(['--execute']), 2)
            create.assert_not_called()
        self.assertNotIn('PRIVATE', output.getvalue())
        self.assertEqual(json.loads(output.getvalue())['code'], 'probe_rejected')

    def test_tls_uses_default_context_and_expected_hostname(self):
        with patch.object(probe.socket, 'socket') as create, \
                patch.object(probe.ssl, 'create_default_context') as context, \
                patch.object(probe.time, 'monotonic', return_value=1):
            self.assertEqual(probe.observe(self.row(tlsName='provider.example'), 10), 'tls_verified')
            context.assert_called_once_with()
            context.return_value.wrap_socket.assert_called_once_with(
                create.return_value.__enter__.return_value, server_hostname='provider.example')


if __name__ == '__main__':
    unittest.main()
