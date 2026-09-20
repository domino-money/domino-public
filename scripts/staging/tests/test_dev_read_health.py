"""Operational regression checks, without network or system mutation."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location('dev_read_health', Path(__file__).parents[1] / 'dev_read_health.py')
health = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(health)
NOW = 1_800_000_000


def healthy_sample():
    return {'errors': [], 'units': dict.fromkeys(health.UNITS, 'active'),
            'readerEnabled': True, 'gatewayEnabled': True, 'managerEnabled': True,
            'deadlines': dict.fromkeys(('reader', 'gateway', 'lease', 'savedFirewall', 'effectiveFirewall'), NOW + 604800),
            'readerHealth': {'httpStatus': 200, 'state': 'ready'}, 'readerUptimeSeconds': 300,
            'gatewayDenial': True, 'haConnections': 4,
            'lastTokenProbeAt': NOW, 'tokenProbe': {'at': NOW, 'ok': True, 'snapshotNumber': 123},
            'external': {'state': 'verified', 'httpStatus': 200}}


def nft_document(deadline='2027-01-15 08:00:00'):
    return {'nftables': [{'rule': {'family': 'inet', 'table': 'domino_dev_off', 'chain': role,
             'expr': [{'match': {'op': '<', 'left': {'meta': {'key': 'time'}}, 'right': deadline}},
                      {'accept': None}]}} for role in ('reader', 'gateway', 'tunnel')]}


def token_body():
    return {'mode': 'public_token_read_only', 'chainId': 4663, 'liveExecution': False,
            'asset': {'address': health.WETH, 'readStatus': 'available'}, 'snapshot': {'number': 123}}


class HealthTests(unittest.TestCase):
    def codes(self, sample, previous=None, now=NOW):
        report, state = health.assess(sample, previous or {}, now)
        return {row['code'] for row in report['issues']}, report, state

    def test_deadlines_expiry_warning_boundaries_and_mismatch(self):
        for seconds, expected in ((172801, None), (172800, 'lease_expires_within_48h'),
                                  (86400, 'lease_expires_within_24h'), (3600, 'lease_expires_within_1h'),
                                  (0, 'lease_expired'), (-1, 'lease_expired')):
            with self.subTest(seconds=seconds):
                sample = healthy_sample()
                sample['deadlines'] = dict.fromkeys(sample['deadlines'], NOW + seconds)
                codes, report, _ = self.codes(sample)
                self.assertEqual(codes, {expected} if expected else set())
                self.assertEqual(report['severity'], 'critical' if seconds <= 0 else 'warning' if expected else 'healthy')
        sample = healthy_sample()
        sample['deadlines']['effectiveFirewall'] -= 1
        self.assertIn('deadline_mismatch', self.codes(sample)[0])
        del sample['deadlines']['effectiveFirewall']
        self.assertIn('deadline_evidence_incomplete', self.codes(sample)[0])

    def test_effective_nft_dates_use_utc_and_require_each_permission_gated(self):
        self.assertEqual(health.nft_deadline(nft_document()), NOW)
        for change in ('remove_role', 'remove_gate', 'different_deadline'):
            document = nft_document()
            if change == 'remove_role':
                document['nftables'].pop()
            elif change == 'remove_gate':
                document['nftables'][0]['rule']['expr'].pop(0)
            else:
                document['nftables'][0]['rule']['expr'][0]['match']['right'] = NOW - 1
            with self.subTest(change=change), self.assertRaises(ValueError):
                health.nft_deadline(document)

    def test_zero_and_degraded_connections_track_duration_and_recover(self):
        sample = healthy_sample()
        sample['haConnections'] = 0
        codes, _, state = self.codes(sample)
        self.assertNotIn('tunnel_disconnected', codes)
        self.assertNotIn('tunnel_disconnected', self.codes(sample, state, NOW + 59)[0])
        self.assertIn('tunnel_disconnected', self.codes(sample, state, NOW + 60)[0])
        sample['haConnections'] = 3
        self.assertNotIn('tunnel_degraded', self.codes(sample, state, NOW + 119)[0])
        self.assertIn('tunnel_degraded', self.codes(sample, state, NOW + 120)[0])
        sample['haConnections'] = 4
        codes, _, recovered = self.codes(sample, state, NOW + 121)
        self.assertNotIn('tunnel_degraded', codes)
        self.assertNotIn('zeroConnectionsSince', recovered)
        self.assertNotIn('degradedConnectionsSince', recovered)

    def test_reader_cooldown_is_only_expected_for_first_90_seconds(self):
        sample = healthy_sample()
        sample['readerHealth'] = {'httpStatus': 503, 'state': 'cooldown'}
        sample['readerUptimeSeconds'] = 90
        self.assertEqual(self.codes(sample)[0], {'reader_startup_cooldown'})
        sample['readerUptimeSeconds'] = 91
        self.assertIn('reader_not_ready', self.codes(sample)[0])
        sample['readerProfileAfterStart'] = True
        self.assertIn('reader_profile_newer_than_process', self.codes(sample)[0])

    def test_external_missing_is_warning_and_never_claims_verified(self):
        sample = healthy_sample()
        sample['external'] = {'state': 'credential_missing'}
        codes, report, _ = self.codes(sample)
        self.assertEqual(report['severity'], 'warning')
        self.assertEqual(report['externalVerification']['state'], 'credential_missing')
        self.assertEqual(codes, {'external_not_verified_access_credential_missing'})

    def test_transaction_age_is_reported(self):
        sample = healthy_sample()
        sample['transactionAgeSeconds'] = 179
        self.assertEqual(self.codes(sample)[0], {'maintenance_in_progress'})
        sample['transactionAgeSeconds'] = 180
        self.assertEqual(self.codes(sample)[0], {'maintenance_transaction_stale'})

    def test_fresh_transaction_suppresses_expected_transients_but_preserves_raw_evidence(self):
        sample = healthy_sample()
        sample.update(transactionAgeSeconds=120, readerProfileAfterStart=True,
                      readerHealth={'httpStatus': 503, 'state': 'cooldown'})
        sample['units'][health.UNITS[0]] = 'inactive'
        sample['deadlines']['reader'] = NOW - 1
        _, report, _ = self.codes(sample)
        self.assertEqual(report['severity'], 'healthy')
        self.assertTrue(all(item['severity'] == 'info' for item in report['issues']))
        self.assertEqual(report['deadlines']['reader'], NOW - 1)
        self.assertTrue(report['checks']['readerProfileAfterStart'])
        self.assertEqual(report['checks']['units'][health.UNITS[0]], 'inactive')
        sample['gatewayDenial'] = False
        self.assertEqual(self.codes(sample)[1]['severity'], 'critical')
        sample['gatewayDenial'] = True
        sample['transactionAgeSeconds'] = 180
        self.assertEqual(self.codes(sample)[1]['severity'], 'critical')

    def test_manager_failure_warns_and_escalates_when_lease_has_less_than_one_hour(self):
        sample = healthy_sample()
        sample['managerFailure'] = {'at': NOW, 'code': 'pin_drift'}
        codes, report, _ = self.codes(sample)
        self.assertEqual(codes, {'renewal_blocked'})
        self.assertEqual(report['severity'], 'warning')
        self.assertEqual(report['checks']['managerFailure']['code'], 'pin_drift')
        sample['deadlines'] = dict.fromkeys(sample['deadlines'], NOW + 3599)
        self.assertEqual(self.codes(sample)[1]['severity'], 'critical')

    def test_functional_token_requires_expected_chain_identity_available_and_snapshot(self):
        self.assertTrue(health.valid_token(200, token_body()))
        cases = [None, {}, {**token_body(), 'chainId': 1}, {**token_body(), 'snapshot': {'number': '123'}},
                 {**token_body(), 'snapshot': {'number': True}}, {**token_body(), 'liveExecution': True}]
        for body in cases:
            self.assertFalse(health.valid_token(200, body))
        for key, value in (('address', '0x' + '00' * 20), ('address', 123), ('readStatus', 'partial')):
            body = token_body()
            body['asset'][key] = value
            self.assertFalse(health.valid_token(200, body))
        self.assertFalse(health.valid_token(503, token_body()))

    def test_functional_429_is_warning_and_keeps_attempt_time_for_quota_bound(self):
        sample = healthy_sample()
        sample['tokenProbe'] = {'at': NOW, 'ok': False, 'httpStatus': 429}
        codes, report, state = self.codes(sample)
        self.assertEqual(codes, {'functional_token_probe_rate_limited'})
        self.assertEqual(report['severity'], 'warning')
        self.assertEqual(state['lastTokenProbeAt'], NOW)
        self.assertEqual(state['tokenProbe']['httpStatus'], 429)
        sample['tokenProbe']['httpStatus'] = 503
        self.assertEqual(self.codes(sample)[1]['severity'], 'critical')

    def test_access_credentials_accept_launcher_version_one_and_reject_bad_versions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'off-policy.nft').write_text('meta time < ' + str(NOW + 604800))
            credential = {'clientId': 'test-client-id', 'clientSecret': 'test-client-secret'}
            def read_json(path, **kwargs):
                if path == root / 'access.json':
                    self.assertTrue(kwargs.get('credential'))
                    return credential
                if path.name == 'profile.json':
                    return {'enabled': True, 'quotaQualification': {'approved': True, 'expiresAt': NOW + 604800}}
                return {'enabled': True, 'expiresAt': NOW + 604800}
            public_requests = []
            def http(url, **kwargs):
                if url == health.PUBLIC_STATUS:
                    public_requests.append(kwargs)
                    return 200, {'schemaVersion': 1, 'environment': 'development', 'authenticated': True,
                                 'readEnabled': True, 'readerConnection': {'state': 'ready'}}
                if url.endswith('/health'):
                    return 200, {'status': 'ok', 'mode': 'local_read_only', 'devAdmission': {'state': 'ready'}}
                if url.endswith('/ready'):
                    return 200, {'readyConnections': 4}
                return 403, {}
            def cmd(argv):
                return (json.dumps(nft_document(NOW + 604800)) if argv[0].endswith('/nft')
                        else 'ActiveState=active\nActiveEnterTimestampMonotonic=0\n')
            with patch.object(health, 'ROOT', root), patch.object(health, 'CONTROL', root / 'control.json'), \
                    patch.object(health, 'ACCESS', root / 'access.json'), patch.object(health, 'read_json', read_json), \
                    patch.object(health, 'command', cmd), patch.object(health, 'http_json', http):
                previous = {'lastTokenProbeAt': NOW, 'tokenProbe': {'at': NOW, 'ok': True}}
                for version in (None, 1, 2, True, '1'):
                    with self.subTest(version=version):
                        credential.pop('version', None)
                        if version is not None:
                            credential['version'] = version
                        public_requests.clear()
                        sample = health.collect(root, previous, NOW)
                        accepted = version is None or type(version) is int and version == 1
                        self.assertEqual(sample['external']['state'], 'verified' if accepted else 'credential_invalid')
                        self.assertEqual(len(public_requests), 1 if accepted else 0)
                        if accepted:
                            self.assertEqual(public_requests[0]['headers'], {
                                'CF-Access-Client-Id': 'test-client-id',
                                'CF-Access-Client-Secret': 'test-client-secret'})
                        self.assertNotIn('test-client-secret', json.dumps(sample))
                        self.assertNotIn('test-client-id', json.dumps(sample))

    def test_atomic_status_private_and_journal_only_on_transition(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(health.os, 'geteuid', return_value=0), \
                    patch.object(health, 'collect', return_value=healthy_sample()), \
                    patch.object(health.time, 'time', return_value=NOW), \
                    patch('builtins.print') as journal:
                # The test runner need not be root; production ownership is still checked.
                original = Path.lstat
                def root_stat(path):
                    result = original(path)
                    if path == root:
                        values = list(result)
                        values[4] = 0
                        return os.stat_result(values)
                    return result
                with patch.object(Path, 'lstat', root_stat):
                    self.assertEqual(health.main(['--state-dir', directory]), 0)
                    self.assertEqual(health.main(['--state-dir', directory]), 0)
            self.assertEqual(journal.call_count, 1)
            self.assertEqual((root / 'status.json').stat().st_mode & 0o777, 0o600)
            self.assertEqual((root / 'health-state.json').stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads((root / 'status.json').read_text())['severity'], 'healthy')

    def test_collector_token_probe_is_bounded_to_once_per_15_minutes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for folder in ('reader', 'gateway'):
                (root / folder).mkdir()
            (root / 'reader/profile.json').write_text(json.dumps({'enabled': True,
                'quotaQualification': {'approved': True, 'expiresAt': NOW + 604800}}))
            (root / 'gateway/admission.json').write_text(json.dumps({'enabled': True, 'expiresAt': NOW + 604800}))
            (root / 'control.json').write_text('{"enabled":true}')
            (root / 'lease.json').write_text(json.dumps({'expiresAt': NOW + 604800}))
            (root / 'off-policy.nft').write_text('meta time < ' + str(NOW + 604800))
            requests = []
            def http(url, **kwargs):
                requests.append(url)
                if url.endswith('/health'):
                    return 200, {'status': 'ok', 'mode': 'local_read_only', 'devAdmission': {'state': 'ready'}}
                if url.endswith('/ready'):
                    return 200, {'readyConnections': 4}
                if url.endswith('/token'):
                    return 200, token_body()
                return 403, {}
            def cmd(argv):
                if argv[0].endswith('/nft'):
                    return json.dumps(nft_document(NOW + 604800))
                return 'ActiveState=active\nActiveEnterTimestampMonotonic=1\n'
            with patch.object(health, 'ROOT', root), patch.object(health, 'CONTROL', root / 'control.json'), \
                    patch.object(health, 'ACCESS', root / 'missing-access.json'), \
                    patch.object(health, 'command', cmd), patch.object(health, 'http_json', http):
                previous = {'lastTokenProbeAt': NOW - 899, 'tokenProbe': {'at': NOW - 899, 'ok': True}}
                health.collect(root, previous, NOW)
                self.assertFalse(any(url.endswith('/token') for url in requests))
                result = health.collect(root, previous, NOW + 1)
                self.assertEqual(sum(url.endswith('/token') for url in requests), 1)
                self.assertTrue(result['tokenProbe']['ok'])
                self.assertEqual(result['external']['state'], 'credential_missing')


if __name__ == '__main__':
    unittest.main()
