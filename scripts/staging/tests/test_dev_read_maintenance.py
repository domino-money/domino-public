"""Offline regressions for renewing the three development admission controls."""
from contextlib import ExitStack
from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import ssl
import tempfile
import unittest
from unittest.mock import MagicMock, patch


SOURCE = Path(__file__).resolve().parents[1] / 'dev_read_maintenance.py'
SPEC = importlib.util.spec_from_file_location('dev_read_maintenance_tests_subject', SOURCE)
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
NOW, OLD_EXPIRY = 2_000_000_000, 2_000_086_400
CONTROL = {'version': 1, 'enabled': True, 'authorization': 'test owner authorization',
           'leaseSeconds': 604800, 'renewBeforeSeconds': 259200}
PINS = {'reader': {'rpc.example.test': ['1.1.1.1']},
        'gateway': {'issuer.example.test': ['8.8.8.8']},
        'tunnel': {'region1.v2.argotunnel.com': ['198.41.192.1'],
                   'region2.v2.argotunnel.com': ['198.41.200.1']}}


def policy(expiry=OLD_EXPIRY):
    lines = ['# Keep this operator policy comment.', 'add table inet domino_dev_off',
             'delete table inet domino_dev_off', 'add table inet domino_dev_off',
             'add chain inet domino_dev_off output { type filter hook output priority 11; policy accept; }']
    for role, name in zip(m.ROLES, ('reader_https', 'gateway_https', 'tunnel_edges')):
        addresses = sorted({a for values in PINS[role].values() for a in values})
        elements = ', '.join(a + ' timeout 86400s' for a in addresses)
        lines.append(f'add set inet domino_dev_off {name} {{ type ipv4_addr; flags timeout; size {len(addresses)}; elements = {{ {elements} }}; }}')
    routes = [('reader', 'tcp', '443'), ('gateway', 'tcp', '443'),
              ('tunnel', 'tcp', '7844'), ('tunnel', 'udp', '7844'),
              ('tunnel', 'tcp', '53'), ('tunnel', 'udp', '53'),
              ('gateway', 'tcp', '8890'), ('tunnel', 'tcp', '8891')]
    for role, protocol, port in routes:
        lines.append(f'add rule inet domino_dev_off {role} meta time >= 1999900000 meta time < {expiry} {protocol} dport {port} counter accept')
    lines.extend(['add rule inet domino_dev_off reader oifname "lo" tcp sport 8890 ct direction reply ct state established accept',
                  'add rule inet domino_dev_off reader counter drop',
                  'add rule inet domino_dev_off gateway counter drop',
                  'add rule inet domino_dev_off tunnel counter drop'])
    return '\n'.join(lines) + '\n'


def profiles(expiry=OLD_EXPIRY):
    return ({'enabled': True, 'quotaQualification': {'approved': True, 'expiresAt': expiry,
                                                   'receiptSha256': 'a' * 64}},
            {'version': 1, 'enabled': True, 'serviceId': 'synthetic.access', 'expiresAt': expiry})


class LeaseRules(unittest.TestCase):
    def test_standing_authorization_retains_finite_seven_day_lease(self):
        self.assertEqual(m.controls(deepcopy(CONTROL)), CONTROL)
        for key, value in [('leaseSeconds', 604801), ('leaseSeconds', True),
                           ('renewBeforeSeconds', 604800), ('renewBeforeSeconds', 0),
                           ('authorization', ''), ('enabled', 1)]:
            with self.subTest(key=key, value=value), self.assertRaises(m.Refused):
                m.controls(dict(CONTROL, **{key: value}))
        with self.assertRaisesRegex(m.Refused, 'invalid_control'):
            m.controls(dict(CONTROL, allowProduction=True))

    def test_revoked_standing_authorization_is_never_renewed(self):
        with self.assertRaisesRegex(m.Refused, 'authorization_revoked'):
            m.controls(dict(CONTROL, enabled=False))

    def test_all_three_admission_deadlines_must_agree(self):
        reader, admission = profiles()
        self.assertEqual(m.synchronized_expiry(policy(), reader, admission), OLD_EXPIRY)
        for side in ('reader', 'gateway', 'nft'):
            r, a = profiles()
            p = policy()
            if side == 'reader':
                r['quotaQualification']['expiresAt'] += 1
            elif side == 'gateway':
                a['expiresAt'] += 1
            else:
                p = policy(OLD_EXPIRY + 1)
            with self.subTest(side=side), self.assertRaisesRegex(m.Refused, 'expiry_mismatch'):
                m.synchronized_expiry(p, r, a)

    def test_missing_window_or_revocation_prevents_snapshot(self):
        reader, admission = profiles()
        with self.assertRaisesRegex(m.Refused, 'unexpected_policy_windows'):
            m.synchronized_expiry(policy().replace('meta time <', 'meta time <=', 1), reader, admission)
        admission['enabled'] = False
        with self.assertRaisesRegex(m.Refused, 'admission_revoked'):
            m.synchronized_expiry(policy(), reader, admission)

    def test_renewal_changes_time_and_addresses_without_changing_ports_or_denials(self):
        pins = deepcopy(PINS)
        pins['reader']['rpc.example.test'] = ['1.0.0.1', '1.1.1.1']
        original = policy()
        rendered = m.render_policy(original, pins, NOW, CONTROL['leaseSeconds']).decode()
        self.assertEqual(re.findall(r'meta time < (\d+)', rendered), [str(NOW + 604800)] * 8)
        self.assertIn('1.0.0.1 timeout 604799s', rendered)
        def invariant(text):
            text = re.sub(r'^add set .*$', '', text, flags=re.MULTILINE)
            return re.sub(r'meta time >= \d+ meta time < \d+', '<time>', text)
        self.assertEqual(invariant(rendered), invariant(original))
        self.assertNotIn('604800s', rendered)

    def test_other_table_is_not_a_renewal_target(self):
        with self.assertRaisesRegex(m.Refused, 'policy_scope'):
            m.render_policy(policy() + 'delete table inet domino_continuous_reads\n', PINS, NOW, 604800)


class Sandbox(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.base, self.state = self.root/'dev', self.root/'state'
        self.state.mkdir()
        self.config = self.root/'control.json'
        self.config.write_bytes(m.encoded(CONTROL))
        for role in m.ROLES:
            (self.base/role).mkdir(parents=True)
            (self.base/role/'hosts').write_text('127.0.0.1 localhost\n' + ''.join(
                f'{ip} {host}\n' for host, ips in PINS[role].items() for ip in ips))
        self.policy, self.reader, self.admission = self.base/'off-policy.nft', self.base/'reader/profile.json', self.base/'gateway/admission.json'
        self.policy.write_text(policy())
        reader, admission = profiles()
        self.reader.write_bytes(m.encoded(reader))
        self.admission.write_bytes(m.encoded(admission))
        self.managed = (self.policy, self.reader, self.admission)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        for name, value in [('BASE', self.base), ('STATE', self.state), ('CONFIG', self.config), ('POLICY', self.policy),
                            ('READER', self.reader), ('ADMISSION', self.admission), ('MANAGED', self.managed)]:
            self.stack.enter_context(patch.object(m, name, value))
        self.stack.enter_context(patch.object(m, 'tracked_files', return_value=list(self.managed)))
        self.stack.enter_context(patch.object(m, 'private', side_effect=lambda path: json.loads(Path(path).read_bytes())))
        self.stack.enter_context(patch.object(m, 'unit_hashes', return_value={'dev': 'known'}))
        self.stack.enter_context(patch.object(m.time, 'time', return_value=NOW))
        original_atomic = m.atomic
        self.stack.enter_context(patch.object(m, 'atomic', side_effect=lambda path, data, uid=0, gid=0, mode=0o600:
            original_atomic(path, data, os.getuid(), os.getgid(), mode)))
        self.lease = m.snapshot()
        (self.state/'lease.json').write_bytes(m.encoded(self.lease))

    def test_hosts_exclude_localhost_but_preserve_role_separation(self):
        self.assertEqual(m.pins_from_hosts(), PINS)

    def test_private_loopback_and_ipv6_pins_are_refused(self):
        for address in ('127.0.0.1', '10.0.0.1', '192.168.0.1', '::1', '2606:4700:4700::1111'):
            (self.base/'reader/hosts').write_text(f'{address} rpc.example.test\n')
            with self.subTest(address=address), self.assertRaisesRegex(m.Refused, 'nonpublic_pin'):
                m.pins_from_hosts()

    def test_empty_role_pinset_is_refused(self):
        (self.base/'reader/hosts').write_text('127.0.0.1 localhost\n')
        with self.assertRaisesRegex(m.Refused, 'missing_host_pins'):
            m.pins_from_hosts()

    def test_guard_detects_changed_file_even_when_deadline_is_unchanged(self):
        self.policy.write_text(self.policy.read_text() + '# unexpected edit\n')
        with self.assertRaisesRegex(m.Refused, 'installed_file_drift'):
            m.guard(self.lease)

    def test_guard_detects_unit_drift_and_pending_reload(self):
        with patch.object(m, 'unit_hashes', return_value={'dev': 'changed'}):
            with self.assertRaisesRegex(m.Refused, 'unit_drift'):
                m.guard(self.lease)
        with patch.object(m, 'command', return_value=b'yes\n'):
            with self.assertRaisesRegex(m.Refused, 'unit_reload_pending'):
                m.guard(self.lease)

    def test_revocation_refuses_ensure_before_network_or_service_work(self):
        self.config.write_bytes(m.encoded(dict(CONTROL, enabled=False)))
        with patch.object(m.os, 'geteuid', return_value=0), patch.object(m, 'command') as command:
            with self.assertRaisesRegex(m.Refused, 'authorization_revoked'):
                m.run('ensure')
            command.assert_not_called()

    def test_unsynchronized_clock_cannot_extend_a_lease(self):
        before = {p: p.read_bytes() for p in self.managed}
        with patch.object(m.os, 'geteuid', return_value=0), patch.object(m, 'command', return_value=b'no\n'), \
                patch.object(m, 'fresh_pins') as fresh:
            with self.assertRaisesRegex(m.Refused, 'clock_not_synchronized'):
                m.run('renew')
            fresh.assert_not_called()
        self.assertEqual({p: p.read_bytes() for p in self.managed}, before)

    def test_successful_renewal_updates_three_controls_before_publishing_lease(self):
        calls = []
        def assert_synchronized_grant_before_commit():
            admission = json.loads(self.admission.read_bytes())
            self.assertTrue(admission['enabled'])
            self.assertEqual(m.synchronized_expiry(self.policy.read_text(), json.loads(self.reader.read_bytes()),
                                                  admission), NOW + 604800)
            self.assertEqual(json.loads((self.state/'lease.json').read_bytes()), self.lease)
            self.assertTrue((self.state/'transaction.json').exists())
        def command(*args, **kwargs):
            calls.append(args)
            if args == ('systemctl', 'start', 'domino-dev-gateway.service'):
                # Gateway startup refuses disabled admission. The completed
                # lease must still describe the previous verified deployment.
                assert_synchronized_grant_before_commit()
            return b''
        def ready():
            assert_synchronized_grant_before_commit()
        with patch.object(m, 'command', side_effect=command), patch.object(m, 'ready', side_effect=ready), \
                patch.object(m, 'production_fingerprint', return_value={'unchanged': True}):
            result = m.renew(CONTROL, self.lease, PINS)
        self.assertEqual(result['expiresAt'], NOW + 604800)
        self.assertEqual(m.synchronized_expiry(self.policy.read_text(), json.loads(self.reader.read_bytes()),
                                              json.loads(self.admission.read_bytes())), NOW + 604800)
        self.assertFalse((self.state/'transaction.json').exists())
        self.assertEqual(json.loads((self.state/'lease.json').read_bytes())['expiresAt'], NOW + 604800)
        self.assertNotIn(('systemctl', 'restart', 'domino-dev-egress.service'), calls)
        self.assertIn(('systemctl', 'start', 'domino-dev-gateway.service'), calls)

    def test_partial_apply_failure_blocks_network_then_restores_all_backups(self):
        before = {p: p.read_bytes() for p in self.managed}
        events = []
        def command(*args, **kwargs):
            events.append(args)
            if args == ('nft', '-f', str(self.policy)) and str(NOW + 604800) in self.policy.read_text():
                raise m.Refused('injected_nft_failure')
            if args[0:2] == ('nft', '-f') and args[2].endswith('/closed.nft'):
                self.assertIn('meta time >= 0 meta time < 1', Path(args[2]).read_text())
            return b''
        with patch.object(m, 'command', side_effect=command), patch.object(m, 'ready') as ready, \
                patch.object(m, 'production_fingerprint', return_value={'unchanged': True}):
            with self.assertRaisesRegex(m.Refused, 'injected_nft_failure'):
                m.renew(CONTROL, self.lease, PINS)
        self.assertEqual({p: p.read_bytes() for p in self.managed}, before)
        ready.assert_called_once()  # Restored, still-valid old lease is restarted.
        closed_index = next(i for i, c in enumerate(events) if c[0:2] == ('nft', '-f') and c[2].endswith('/closed.nft'))
        stop_index = next(i for i, c in enumerate(events) if c[0:2] == ('systemctl', 'stop'))
        self.assertLess(closed_index, stop_index)
        self.assertFalse((self.state/'transaction.json').exists())
        self.assertEqual(json.loads((self.state/'lease.json').read_bytes()), self.lease)

    def test_readiness_failure_restores_previous_admission_and_lease(self):
        with patch.object(m, 'command', return_value=b''), \
                patch.object(m, 'ready', side_effect=[m.Refused('readiness_timeout'), None]), \
                patch.object(m, 'production_fingerprint', return_value={'unchanged': True}):
            with self.assertRaisesRegex(m.Refused, 'readiness_timeout'):
                m.renew(CONTROL, self.lease, PINS)
        self.assertEqual(json.loads(self.admission.read_bytes())['expiresAt'], OLD_EXPIRY)
        self.assertEqual(json.loads((self.state/'lease.json').read_bytes()), self.lease)

    def test_corrupt_backup_is_refused_before_any_native_command_or_write(self):
        directory = self.state/'transaction-corruption-test'
        directory.mkdir()
        transaction = {'version': 1, 'directory': directory.name,
                       'files': [{'path': str(p), 'metadata': m.metadata(p)} for p in self.managed]}
        (directory/'lease.json').write_bytes(m.encoded(self.lease))
        # Validate every backup before applying even the first nft transaction;
        # corruption in a later file must not permit partial rollback effects.
        for corrupt_index in range(len(self.managed)):
            for index, path in enumerate(self.managed):
                (directory/str(index)).write_bytes(path.read_bytes())
            (directory/str(corrupt_index)).write_bytes(b'corrupted backup')
            with self.subTest(corrupt_index=corrupt_index), patch.object(m, 'command') as command, \
                    patch.object(m, 'atomic') as atomic:
                with self.assertRaisesRegex(m.Refused, 'backup_corrupt'):
                    m.restore(transaction)
                command.assert_not_called()
                atomic.assert_not_called()

    def test_production_change_rejects_commit_and_rolls_back_dev(self):
        with patch.object(m, 'command', return_value=b''), patch.object(m, 'ready'), \
                patch.object(m, 'production_fingerprint', side_effect=[{'pid': 1}, {'pid': 2}]):
            with self.assertRaisesRegex(m.Refused, 'production_changed'):
                m.renew(CONTROL, self.lease, PINS)
        self.assertEqual(json.loads((self.state/'lease.json').read_bytes()), self.lease)


class NetworkAndAtomicity(unittest.TestCase):
    def answers(self, host, *args):
        address = next(ips[0] for hosts in PINS.values() for name, ips in hosts.items() if name == host)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (address, 0))]

    def test_dns_answers_are_checked_with_hostname_tls_verification(self):
        context = MagicMock()
        with patch.object(m.socket, 'getaddrinfo', side_effect=self.answers), \
                patch.object(m.socket, 'create_connection', return_value=MagicMock()) as connection, \
                patch.object(m.ssl, 'create_default_context', return_value=context):
            self.assertEqual(m.fresh_pins(PINS), PINS)
        self.assertEqual({c.kwargs['server_hostname'] for c in context.wrap_socket.call_args_list},
                         {'rpc.example.test', 'issuer.example.test'})
        self.assertEqual({c.args[0][1] for c in connection.call_args_list}, {443})

    def test_private_or_empty_dns_answers_are_refused_before_connecting(self):
        for answers in ([], [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('10.0.0.2', 0))]):
            with self.subTest(answers=answers), patch.object(m.socket, 'getaddrinfo', return_value=answers), \
                    patch.object(m.socket, 'create_connection') as connect:
                with self.assertRaisesRegex(m.Refused, 'invalid_dns_answers'):
                    m.fresh_pins(PINS)
                connect.assert_not_called()

    def test_dns_failure_never_silently_reuses_stale_pins(self):
        with patch.object(m.socket, 'getaddrinfo', side_effect=socket.gaierror('synthetic lookup failure')):
            with self.assertRaises(socket.gaierror):
                m.fresh_pins(PINS)

    def test_tunnel_address_outside_its_inventory_is_refused(self):
        pins = {'tunnel': PINS['tunnel']}
        with patch.object(m.socket, 'getaddrinfo', return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('1.1.1.1', 0))]):
            with self.assertRaisesRegex(m.Refused, 'tunnel_inventory_changed'):
                m.fresh_pins(pins)

    def test_tls_failure_does_not_adopt_new_dns_addresses(self):
        context = MagicMock()
        context.wrap_socket.side_effect = ssl.SSLCertVerificationError('synthetic certificate mismatch')
        with patch.object(m.socket, 'getaddrinfo', side_effect=self.answers), \
                patch.object(m.socket, 'create_connection', return_value=MagicMock()), \
                patch.object(m.ssl, 'create_default_context', return_value=context):
            with self.assertRaises(ssl.SSLCertVerificationError):
                m.fresh_pins(PINS)

    def test_atomic_replace_failure_preserves_original_and_removes_temp_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'profile.json'
            path.write_bytes(b'old')
            with patch.object(m.os, 'replace', side_effect=OSError('synthetic replacement failure')):
                with self.assertRaises(OSError):
                    m.atomic(path, b'new', os.getuid(), os.getgid())
            self.assertEqual(path.read_bytes(), b'old')
            self.assertEqual(list(Path(directory).iterdir()), [path])
            m.atomic(path, b'new', os.getuid(), os.getgid(), 0o600)
            self.assertEqual(path.read_bytes(), b'new')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_busy_operator_lock_never_enters_transaction_and_closes_fd(self):
        with patch.object(m.os, 'open', return_value=123), patch.object(m.os, 'close') as close, \
                patch.object(m.fcntl, 'flock', side_effect=BlockingIOError):
            with self.assertRaisesRegex(m.Refused, 'operator_busy'):
                with m.locked():
                    self.fail('Busy lock entered the mutation boundary')
        close.assert_called_once_with(123)


if __name__ == '__main__':
    unittest.main()
