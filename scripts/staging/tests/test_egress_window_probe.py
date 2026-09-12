"""Socket-free tests only: no VM, network, root, TLS peer or firewall qualification."""
import errno
import importlib.util
import json
from pathlib import Path
import stat
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, mock_open, patch


SCRIPT = Path(__file__).resolve().parents[1] / 'probe_egress_window.py'
SPEC = importlib.util.spec_from_file_location('probe_egress_window', SCRIPT)
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)
NOW = 1_789_135_200


def plan(role='read'):
    https = [{'ip': '1.1.1.1', 'tlsName': 'rpc.example.com'}] if role in {'read', 'gateway'} else []
    return {
        'version': 1, 'role': role, 'uid': 2000, 'gid': 3000,
        'supplementaryGids': [4000], 'cgroup': f'/system.slice/domino-{role}.service',
        'expiresAtUnix': NOW + 40, 'permittedHttps': https,
        'edgeIps': ['198.41.192.167'] if role == 'tunnel' else [],
        'dnsName': 'rpc.example.com',
        'localAllowedPorts': [8876] if role == 'gateway' else [8878, 8879, 8880] if role == 'tunnel' else [],
        'negativeTargets': {'allowedIpv4': '1.1.1.1', 'unlistedIpv4': '8.8.8.8',
                            'externalDnsIpv4': '9.9.9.9', 'globalIpv6': None},
    }


class FakeQuicSocket:
    def __init__(self, mode):
        self.mode = mode
        self.connected = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def connect(self, target):
        self.connected = target

    def settimeout(self, timeout):
        pass

    def send(self, payload):
        assert len(payload) == 1200
        self.payload = payload
        return len(payload)

    def recv(self, size):
        if self.mode == 'timeout':
            raise TimeoutError()
        dcid, scid = self.payload[6:22], self.payload[23:39]
        if self.mode == 'nonce_mismatch':
            scid = bytes(16)
        version = bytes(4) if self.mode != 'nonzero_version' else b'\x00\x00\x00\x01'
        supported = b'\x0a\x0a\x0a\x0a' if self.mode == 'offered_version_echoed' else b'\x00\x00\x00\x01'
        return b'\x80' + version + b'\x10' + scid + b'\x10' + dcid + supported


class ProbeTests(unittest.TestCase):
    def setUp(self):
        probe.PLAN = plan()
        probe.RUN_INVALID.clear()
        probe.LISTENER_STOP.clear()
        probe.LISTENER = None
        probe.HELD.clear()
        self.clock = patch.object(probe.time, 'time', return_value=NOW)
        self.clock.start()
        self.addCleanup(self.clock.stop)
        # Any unintended actual socket immediately fails this offline suite.
        self.no_socket = patch.object(probe.socket, 'socket', side_effect=AssertionError('unexpected real socket'))
        self.socket_mock = self.no_socket.start()
        self.addCleanup(self.no_socket.stop)

    def reject(self, key, value):
        data = plan()
        data[key] = value
        with self.assertRaises(ValueError):
            probe.validate(data)

    def test_valid_plan(self):
        self.assertEqual(probe.validate(plan()), plan())

    def test_root_uid_rejected(self):
        self.reject('uid', 0)

    def test_boolean_uid_rejected(self):
        self.reject('uid', True)

    def test_root_gid_rejected(self):
        self.reject('gid', 0)

    def test_nobody_gid_rejected(self):
        self.reject('gid', 65534)

    def test_non_string_role_rejected(self):
        self.reject('role', [])

    def test_root_cgroup_rejected(self):
        self.reject('cgroup', '/')

    def test_cross_service_cgroup_rejected(self):
        self.reject('cgroup', '/system.slice/domino-gateway.service')

    def test_duplicate_groups_rejected(self):
        self.reject('supplementaryGids', [4000, 4000])

    def test_unsorted_groups_rejected(self):
        self.reject('supplementaryGids', [4001, 4000])

    def test_overlong_expiry_rejected(self):
        self.reject('expiresAtUnix', NOW + 100)

    def test_expired_plan_rejected(self):
        self.reject('expiresAtUnix', NOW - 1)

    def test_insufficient_expiry_budget_rejected(self):
        self.reject('expiresAtUnix', NOW + 12)

    def test_wrong_edge_ip_rejected(self):
        self.reject('edgeIps', ['1.1.1.1'])

    def test_private_https_ip_rejected(self):
        self.reject('permittedHttps', [{'ip': '127.0.0.1', 'tlsName': 'rpc.example.com'}])

    def test_url_in_tls_name_rejected(self):
        self.reject('permittedHttps', [{'ip': '1.1.1.1', 'tlsName': 'https://rpc.example.com'}])

    def test_role_local_permission_drift_rejected(self):
        self.reject('localAllowedPorts', [8876])

    def test_duplicate_json_keys_rejected(self):
        with self.assertRaisesRegex(ValueError, 'duplicate_plan_key'):
            probe.unique_object([('role', 'read'), ('role', 'gateway')])

    def test_all_deny_only_roles_have_only_denied_probes(self):
        for role in ['auth', 'onboarding', 'deposit']:
            with self.subTest(role=role):
                probe.PLAN = probe.validate(plan(role))
                self.assertTrue(all(item[1] == 'deny' for item in probe.phase_jobs('before_expiry')))

    def test_uid_only_accounts_cannot_invent_service_cgroups(self):
        for role in ['write', 'operator', 'admin']:
            with self.subTest(role=role), self.assertRaisesRegex(ValueError, 'invalid_identity_plan'):
                probe.validate(plan(role))

    def test_post_expiry_probes_expect_no_outbound_permission(self):
        for role in ['read', 'gateway', 'tunnel']:
            with self.subTest(role=role):
                probe.PLAN = probe.validate(plan(role))
                self.assertTrue(all(item[1] == 'deny' for item in probe.phase_jobs('after_expiry')))

    def test_live_origin_probes_schedule_first(self):
        probe.PLAN = plan('tunnel')
        self.assertEqual([entry[0] for entry in probe.phase_jobs('before_expiry')[:3]],
                         ['local_allowed_8878', 'local_allowed_8879', 'local_allowed_8880'])

    def test_no_ipv6_target_does_not_invent_probe(self):
        self.assertNotIn('global_ipv6', [entry[0] for entry in probe.phase_jobs('before_expiry')])

    def test_unlisted_ipv4_cannot_equal_allowed_target(self):
        data = plan()
        data['negativeTargets']['unlistedIpv4'] = '1.1.1.1'
        with self.assertRaisesRegex(ValueError, 'unlisted_target_is_listed'):
            probe.validate(data)

    def quic(self, mode):
        fake = FakeQuicSocket(mode)
        with patch.object(probe, 'fresh_socket', return_value=fake):
            result = probe.quic('198.41.192.167', 7844)
        self.assertEqual(fake.connected, ('198.41.192.167', 7844))
        return result

    def test_quic_matching_version_zero_is_unauthenticated_round_trip(self):
        result = self.quic('valid')
        self.assertTrue(result['nonceMatched'])
        self.assertTrue(result['reachabilityProved'])
        self.assertFalse(result['peerAuthenticated'])

    def test_quic_mismatched_nonce_not_reachable(self):
        result = self.quic('nonce_mismatch')
        self.assertFalse(result['nonceMatched'])
        self.assertFalse(result['reachabilityProved'])

    def test_quic_nonzero_version_not_reachable(self):
        self.assertFalse(self.quic('nonzero_version')['reachabilityProved'])

    def test_quic_offered_version_echo_not_reachable(self):
        self.assertFalse(self.quic('offered_version_echoed')['reachabilityProved'])

    def test_udp_send_acceptance_with_timeout_is_not_reachability(self):
        result = self.quic('timeout')
        self.assertEqual(result['udpKernelAcceptedBytes'], 1200)
        self.assertEqual(result['observation'], 'timeout')
        self.assertFalse(result['reachabilityProved'])

    def test_source_port_in_use_is_explicitly_untested(self):
        failing = Mock(side_effect=OSError(errno.EADDRINUSE, 'not logged'))
        with patch.object(probe, 'emit') as emit:
            probe.observed('source_port_negative', 'source_port_binding_bypass', 'deny', failing, source_port=8876)
        outcome = emit.call_args.kwargs
        self.assertEqual(outcome['observation'], 'source_port_in_use')
        self.assertTrue(outcome['untested'])
        self.assertFalse(outcome['conclusive'])
        self.assertFalse(outcome['packetAttempted'])
        self.assertFalse(probe.RUN_INVALID.is_set())

    def test_identity_error_invalidates_entire_run(self):
        with patch.object(probe, 'emit'):
            probe.observed('before_expiry', 'test', 'permit', Mock(side_effect=ValueError('identity mismatch')))
        self.assertTrue(probe.RUN_INVALID.is_set())
        with self.assertRaisesRegex(ValueError, 'run_already_invalid'):
            probe.fresh_socket('1.1.1.1', probe.socket.SOCK_STREAM, 1)
        self.socket_mock.assert_not_called()

    def test_internal_error_invalidates_entire_run(self):
        with patch.object(probe, 'emit'):
            probe.observed('before_expiry', 'test', 'permit', Mock(side_effect=RuntimeError('not logged')))
        self.assertTrue(probe.RUN_INVALID.is_set())

    def test_phase_propagates_invalid_result(self):
        jobs = [('bad', 'permit', Mock(side_effect=ValueError('mismatch')), (), {})]
        with patch.object(probe, 'identity'), patch.object(probe, 'phase_jobs', return_value=jobs), patch.object(probe, 'emit'):
            with self.assertRaisesRegex(ValueError, 'probe_phase_invalid'):
                probe.run_phase('before_expiry')
        self.assertTrue(probe.RUN_INVALID.is_set())

    def test_cli_invalid_result_nonzero_without_complete(self):
        with patch.object(probe, 'main', side_effect=ValueError('probe_phase_invalid')), patch.object(probe, 'emit') as emit:
            self.assertEqual(probe.run_cli(), 2)
        self.assertEqual(emit.call_args.args[0], 'invalid_run')
        self.assertFalse(any(call.args[0] == 'complete' for call in emit.call_args_list))

    def test_runtime_identity_checks_real_effective_primary_and_supplementary(self):
        actual = {'getuid': 2000, 'geteuid': 2000, 'getgid': 3000, 'getegid': 3000, 'getgroups': [4000]}
        for changed, value in [('getuid', 2001), ('geteuid', 2001), ('getgid', 3001), ('getegid', 3001), ('getgroups', [4000, 4001])]:
            with self.subTest(changed=changed):
                patches = {key: Mock(return_value=value if key == changed else original) for key, original in actual.items()}
                with patch.multiple(probe.os, **patches), patch('builtins.open', mock_open(read_data='0::/system.slice/domino-read.service\n')):
                    with self.assertRaisesRegex(ValueError, 'runtime_identity_mismatch'):
                        probe.identity()

    def test_runtime_cgroup_must_match_exact_single_unified_path(self):
        actual = {key: Mock(return_value=value) for key, value in {'getuid': 2000, 'geteuid': 2000, 'getgid': 3000, 'getegid': 3000, 'getgroups': [4000]}.items()}
        with patch.multiple(probe.os, **actual), patch('builtins.open', mock_open(read_data='0::/system.slice/other.service\n')):
            with self.assertRaisesRegex(ValueError, 'runtime_cgroup_mismatch'):
                probe.identity()

    def test_root_controlled_reader_rejects_writable_parent(self):
        with patch.object(probe.os, 'open', side_effect=[10, 11]), patch.object(probe.os, 'close'), patch.object(probe.os, 'fstat', return_value=SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | 0o777)):
            with self.assertRaisesRegex(ValueError, 'plan_not_root_controlled'):
                probe.secure_read('/tmp/plan.json')

    def test_root_controlled_reader_rejects_path_traversal(self):
        with self.assertRaisesRegex(ValueError, 'invalid_plan_path'):
            probe.secure_read('/run/../tmp/plan.json')

    def test_listeners_remain_live_during_expiry_and_close_only_on_cli_cleanup(self):
        elapsed = [0.0]
        listening = [False]
        phases = []

        def sleep(seconds):
            elapsed[0] += seconds

        def start():
            listening[0] = True

        def stop():
            listening[0] = False

        def phase(name):
            self.assertTrue(listening[0], name)
            phases.append(name)
            if name == 'after_expiry':
                self.assertGreaterEqual(NOW + elapsed[0], plan()['expiresAtUnix'])

        with patch.object(probe.sys, 'version_info', (3, 12)), patch.object(probe.sys, 'platform', 'linux'), patch.object(probe.sys, 'argv', ['probe', '/run/plan.json']), patch.object(probe.signal, 'signal'), patch.object(probe.signal, 'setitimer'), patch.object(probe, 'secure_read', return_value=json.dumps(plan())), patch.object(probe, 'identity'), patch.object(probe, 'START', 0), patch.object(probe.time, 'time', side_effect=lambda: NOW + elapsed[0]), patch.object(probe.time, 'monotonic', side_effect=lambda: elapsed[0]), patch.object(probe.time, 'sleep', side_effect=sleep), patch.object(probe, 'start_listener', side_effect=start), patch.object(probe, 'stop_listener', side_effect=stop), patch.object(probe, 'run_phase', side_effect=phase), patch.object(probe, 'observed'), patch.object(probe, 'emit'):
            self.assertEqual(probe.run_cli(), 0)
        self.assertEqual(phases, ['before_expiry', 'after_expiry'])
        self.assertFalse(listening[0])
        self.socket_mock.assert_not_called()

    def test_hard_deadline_exits_even_when_stdout_is_full(self):
        with patch.object(probe.os, 'set_blocking') as nonblocking, patch.object(probe.os, 'write', side_effect=BlockingIOError(errno.EAGAIN, 'full')), patch.object(probe.os, '_exit') as exit_process:
            probe.hard_stop(None, None)
        nonblocking.assert_called_once_with(1, False)
        exit_process.assert_called_once_with(124)

    def test_complete_record_always_unqualified(self):
        with patch('builtins.print') as output:
            probe.emit('complete', observationsOnly=True, qualified=False)
        data = json.loads(output.call_args.args[0][len(probe.PREFIX):])
        self.assertFalse(data['policyQualified'])
        self.assertFalse(data['qualified'])


if __name__ == '__main__':
    unittest.main()
