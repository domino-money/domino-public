"""The automation configuration generator: the real release record, the committed
pilot profile, and the refusals that keep a private configuration honest."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import configure_automation as generator
from automation_config import load_config, validate_config
from automation_fixtures import sample_config
from execution_signer import ExecutionError

REPO = Path(__file__).resolve().parents[2]
RELEASE = REPO / 'docs/deployments/v1-robinhood-mainnet-2026-09-21'
PILOT = RELEASE / 'automation-pilot-v1.json'
OWNER, VAULT = '0x' + '11' * 20, '0x' + '22' * 20
WORKER = '6f1c2a55-0d8e-4c1b-9a3e-5b7d2f4e8c10'


def fixture_profile(**changes):
    """The fixture's test numbers in profile form; never production values."""
    config = sample_config()
    profile = {'schemaVersion': 1, 'kind': generator.PROFILE_KIND, 'configVersion': 'fixture-profile-1',
               'releaseTag': 'v1-release-2026-09-21', 'operatorPolicy': config['operator']['policy'],
               'publisher': {k: v for k, v in config['publisher'].items() if k != 'keyFile'},
               **{name: config[name] for name in ('planner', 'pricing', 'swapCap', 'gas', 'destinations',
                                                  'history', 'plan', 'finality', 'ledger', 'paused')},
               'scheduling': {k: v for k, v in config['scheduling'].items() if k != 'workerId'}}
    # The sample's signers could pay a publication and then refuse the execution
    # for its balance, and its swap units under-price a successor's mint: raised
    # to the generator's own consistency rules.
    profile['gas'] = {**profile['gas'], 'operatorMinimumBalanceWei': 10**16, 'publisherMinimumBalanceWei': 4 * 10**15,
                      'executeGasUnits': {**profile['gas']['executeGasUnits'], 'swap': 1900000}}
    profile.update(changes)
    profile['planner'] = {**profile['planner'], 'version': generator.planner_version(profile['planner'])}
    return profile


class GeneratorTests(unittest.TestCase):
    def setUp(self):
        # Resolved: the service's loader walks the path without following links (macOS /var).
        self.temp = Path(tempfile.mkdtemp(prefix='domino-configure-automation-')).resolve()
        self.addCleanup(shutil.rmtree, self.temp)
        self.release = generator.load_release(RELEASE)
        self.expiry = self.release[1]['expiresAt'] - 1
        self.now = self.release[1]['expiresAt'] - 86400

    def compose(self, profile=None, sequences=((OWNER, VAULT),), **kwargs):
        options = {'expires_at': self.expiry, 'worker_id': WORKER, 'now': self.now, **kwargs}
        return generator.compose(self.release, profile or fixture_profile(), list(sequences), **options)

    def test_three_peer_files_from_the_real_release(self):
        documents = self.compose()
        self.assertEqual(set(documents), {'automation', 'gas-reservation', 'gas-settlement'})
        config = documents['automation']
        pinned = json.loads((RELEASE / 'sequence-release.json').read_text())['deployment']
        self.assertEqual(config['deployment'], pinned)
        self.assertEqual(config['sequences'], [{'owner': OWNER, 'vault': VAULT, 'expiresAt': self.expiry, 'suspended': False}])
        # The owner's choice (26 Sep 2026): encrypted keystores, their passwords systemd credentials of the unit.
        for role in ('operator', 'publisher'):
            self.assertEqual(config[role]['keystore'], f'/run/domino-financial-automation-config/{role}.keystore.json')
            self.assertEqual(config[role]['passwordCredential'], f'{role}-keystore-password')
            self.assertNotIn('keyFile', config[role])
        self.assertEqual(config['scheduling']['workerId'], WORKER)
        self.assertEqual(config['database'], {'host': '/run/postgresql-domino', 'port': 8877, 'dbname': 'domino_catalogue'})
        self.assertEqual(config['rpcEndpoint'], 'http://127.0.0.1:18547/')
        validate_config(config)
        for directory, kind in (('gas-reservation', 'domino-gas-reservation'), ('gas-settlement', 'domino-gas-settlement')):
            self.assertEqual(documents[directory], {'schemaVersion': 1, 'kind': kind, 'database': config['database'],
                                                    'rpcEndpoint': config['rpcEndpoint']})

    def test_the_committed_pilot_profile_is_a_complete_configuration(self):
        profile = generator.load_profile(PILOT)
        config = self.compose(profile)['automation']
        parsed = validate_config(config)
        self.assertEqual(parsed.configVersion, profile['configVersion'])
        self.assertLessEqual(parsed.scheduling.evaluationIntervalSeconds, generator.READINESS_MAX_INTERVAL_SECONDS)
        # Not a fixture: no section of the pilot equals the test sample's.
        sample = fixture_profile()
        for name in ('operatorPolicy', 'publisher', 'planner', 'gas', 'destinations', 'plan', 'scheduling'):
            self.assertNotEqual(profile[name], sample[name], name)

    def test_a_release_that_does_not_agree_with_its_record_is_refused(self):
        copy_dir = self.temp / 'release'
        shutil.copytree(RELEASE, copy_dir)
        profile_path = copy_dir / 'sequence-release.json'
        pinned = json.loads(profile_path.read_text())
        pinned['deployment']['operator'] = '0x' + '33' * 20
        raw = json.dumps(pinned).encode()
        profile_path.write_bytes(raw)
        with self.assertRaisesRegex(generator.ConfigurationError, 'sequence_profile_digest_mismatch'):
            generator.load_release(copy_dir)
        # Re-pinned to the tampered file, the profile still disagrees with the release's roles.
        record = json.loads((copy_dir / 'deployment.json').read_text())
        record['profileFiles']['sequence']['sha256'] = generator.hashlib.sha256(raw).hexdigest()
        (copy_dir / 'deployment.json').write_text(json.dumps(record))
        with self.assertRaisesRegex(generator.ConfigurationError, 'sequence_profile_disagrees_with_release'):
            generator.load_release(copy_dir)
        pinned['deployment']['operator'] = record['roles']['operator']
        pinned['deployment']['codeHashes']['engine'] = '0x' + '44' * 32
        raw = json.dumps(pinned).encode()
        profile_path.write_bytes(raw)
        record['profileFiles']['sequence']['sha256'] = generator.hashlib.sha256(raw).hexdigest()
        (copy_dir / 'deployment.json').write_text(json.dumps(record))
        with self.assertRaisesRegex(generator.ConfigurationError, 'sequence_profile_disagrees_with_release'):
            generator.load_release(copy_dir)

    def test_a_profile_names_neither_keys_nor_worker_nor_another_release(self):
        path = self.temp / 'profile.json'
        for label, profile in (
                ('key file', fixture_profile(publisher={**fixture_profile()['publisher'], 'keyFile': '/tmp/k'})),
                ('worker', fixture_profile(scheduling={**fixture_profile()['scheduling'], 'workerId': WORKER})),
                ('extra section', {**fixture_profile(), 'sequences': []}),
                ('missing section', {k: v for k, v in fixture_profile().items() if k != 'ledger'}),
                ('kind', fixture_profile(kind='domino-automation-cycle'))):
            path.write_text(json.dumps(profile))
            with self.subTest(label), self.assertRaisesRegex(generator.ConfigurationError, 'automation_profile_invalid'):
                generator.load_profile(path)
        with self.assertRaisesRegex(generator.ConfigurationError, 'automation_profile_for_another_release'):
            self.compose(fixture_profile(releaseTag='v2-release'))
        # A planner number changed without a new version is a different profile under the old name.
        changed = fixture_profile()
        changed['planner'] = {**changed['planner'], 'forecastHaircutBps': 2500}
        path.write_text(json.dumps(changed))
        with self.assertRaisesRegex(generator.ConfigurationError, 'planner_version_mismatch'):
            generator.load_profile(path)
        changed['planner']['version'] = generator.planner_version(changed['planner'])
        path.write_text(json.dumps(changed))
        self.assertEqual(generator.load_profile(path)['planner']['forecastHaircutBps'], 2500)

    def test_sequence_admission_is_explicit_and_within_the_release(self):
        with self.assertRaisesRegex(generator.ConfigurationError, 'sequence_required'):
            self.compose(sequences=())
        for expiry in (self.release[1]['expiresAt'] + 1, self.now, str(self.expiry)):
            with self.subTest(expiry), self.assertRaisesRegex(generator.ConfigurationError, 'sequence_expiry_invalid'):
                self.compose(expires_at=expiry)
        self.assertEqual(self.compose(expires_at=self.release[1]['expiresAt'])['automation']['sequences'][0]['expiresAt'],
                         self.release[1]['expiresAt'])
        for text in (OWNER + VAULT, OWNER + ':0x12', 'owner:vault'):
            with self.subTest(text), self.assertRaisesRegex(generator.ConfigurationError, 'sequence_invalid'):
                generator.parse_sequence(text)
        self.assertEqual(generator.parse_sequence(OWNER.upper().replace('0X', '0x') + ':' + VAULT), (OWNER, VAULT))
        with self.assertRaisesRegex(generator.ConfigurationError, 'worker_id_invalid'):
            self.compose(worker_id=WORKER.upper())

    def test_discovery_admits_the_factorys_vaults_from_the_releases_first_block(self):
        first = generator.first_block(RELEASE)
        record = json.loads((RELEASE / 'deployment.json').read_text())
        self.assertEqual(first, min(receipt['blockNumber'] for receipt in record['receipts']))
        automation = self.compose(sequences=(), discover_from=first)['automation']
        self.assertEqual(automation['discovery'], {'fromBlock': first, 'expiresAt': self.expiry, **generator.DISCOVERY})
        self.assertEqual(automation['sequences'], [])
        # Beside named sequences too; never with neither.
        self.assertEqual(len(self.compose(discover_from=first)['automation']['sequences']), 1)
        self.assertNotIn('discovery', self.compose()['automation'])
        with self.assertRaisesRegex(generator.ConfigurationError, 'sequence_required'):
            self.compose(sequences=())
        # The ceilings measured: two seconds below the head, the configuration's own 256 vaults.
        self.assertEqual(generator.DISCOVERY, {'confirmations': 20, 'maxBlocksPerScan': 100000, 'maxSequences': 256})

    def test_the_cli_discovers_without_a_named_sequence(self):
        path = self.temp / 'profile.json'
        path.write_text(json.dumps(fixture_profile()))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = generator.main(['--release', str(RELEASE), '--profile', str(path), '--discover',
                                   '--sequence-expires-at', str(self.expiry), '--worker-id', WORKER,
                                   '--out', str(self.temp / 'discovering')])
        summary = json.loads(out.getvalue())
        self.assertEqual((code, summary['sequences'], summary['discovery']['fromBlock']),
                         (0, [], generator.first_block(RELEASE)))
        self.assertEqual(load_config(self.temp / 'discovering/automation/config.json').discovery.maxSequences, 256)

    def test_turn_on_outlasts_a_compound_and_a_full_pass(self):
        # A compound holds serve's loop up to its cycle budget, and the next heartbeat
        # of every vault waits at most one more evaluation interval behind it.
        from execution_status import READINESS_FRESH_SECONDS
        pilot = json.loads(PILOT.read_text())['scheduling']
        self.assertEqual(READINESS_FRESH_SECONDS, 120)
        self.assertGreaterEqual(READINESS_FRESH_SECONDS,
                                pilot['cycleBudgetSeconds'] + generator.READINESS_MAX_INTERVAL_SECONDS)

    def test_the_pilot_does_not_count_publications(self):
        # 27 September 2026: three publications per chained 24 hours held a sequence
        # ready to compound for 45 minutes, and the owner lifted the count. The
        # planner's economics and the shared daily gas cap bound compounding.
        pilot = json.loads(PILOT.read_text())['scheduling']
        self.assertEqual((pilot['publicationWindowSeconds'], pilot['maxPublicationsPerWindow']), (86400, 1000000))

    def test_the_first_block_comes_from_the_release_receipts(self):
        copy_dir = self.temp / 'release'
        shutil.copytree(RELEASE, copy_dir)
        record = json.loads((copy_dir / 'deployment.json').read_text())
        for receipts in ([], None, [{'blockNumber': '69239633'}], [{'blockNumber': 0}], [{}], [{'blockNumber': 5}, {}]):
            (copy_dir / 'deployment.json').write_text(json.dumps({**record, 'receipts': receipts}))
            with self.subTest(receipts=receipts), self.assertRaisesRegex(generator.ConfigurationError, 'release_record_invalid'):
                generator.first_block(copy_dir)
        # The earliest receipt, in whatever order the record lists them.
        (copy_dir / 'deployment.json').write_text(json.dumps({**record, 'receipts': [{'blockNumber': 20}, {'blockNumber': 10}]}))
        self.assertEqual(generator.first_block(copy_dir), 10)

    def test_the_heartbeat_must_stay_fresh_enough_for_the_app(self):
        scheduling = {**fixture_profile()['scheduling'], 'evaluationIntervalSeconds': 16, 'maximumBackoffSeconds': 60}
        with self.assertRaisesRegex(generator.ConfigurationError, 'evaluation_interval_above_readiness'):
            self.compose(fixture_profile(scheduling=scheduling))
        scheduling['evaluationIntervalSeconds'] = 15
        self.compose(fixture_profile(scheduling=scheduling))

    def test_numbers_that_would_stop_or_overspend_in_silence_are_refused(self):
        base = fixture_profile()
        def changed(section, **values):
            return fixture_profile(**{section: {**base[section], **values}})
        gas = base['gas']
        cases = (
            ('minimum_balance_below_envelope', changed('gas', operatorMinimumBalanceWei=10**16 - 1)),
            ('minimum_balance_below_envelope', changed('gas', publisherMinimumBalanceWei=4 * 10**15 - 1)),
            ('swap_units_below_mint', changed('gas', executeGasUnits={**gas['executeGasUnits'], 'swap': 1899999})),
            # interval 1 + backoff 60 x (1 + 0) + budget 300 = 361 seconds between samples at worst.
            ('sample_gap_below_waiting_cadence', changed('history', maximumSampleGapSeconds=361)),
            # 1 + 200 x 1.5 + 300 = 601: the jitter's stretch counts (without it, 501 < 600).
            ('sample_gap_below_waiting_cadence', changed('scheduling', maximumBackoffSeconds=200, jitterBps=5000)),
            ('measurement_window_too_short', changed('planner', minimumSamples=21)),
            ('measurement_window_too_short', changed('planner', minimumSampleSeconds=7200 - 361 + 1)),
            ('sample_age_below_interval', changed('history', sampleIntervalSeconds=120, maximumSampleGapSeconds=900)),
        )
        for code, profile in cases:
            with self.subTest(code), self.assertRaisesRegex(generator.ConfigurationError, code):
                self.compose(profile)
        # Each boundary itself is admitted.
        for profile in (changed('gas', operatorMinimumBalanceWei=10**16, publisherMinimumBalanceWei=4 * 10**15),
                        changed('gas', executeGasUnits={**gas['executeGasUnits'], 'swap': 1900000}),
                        changed('history', maximumSampleGapSeconds=362),
                        changed('scheduling', maximumBackoffSeconds=200, jitterBps=0),
                        changed('planner', minimumSamples=20, minimumSampleSeconds=7200 - 361),
                        changed('planner', maximumSampleAgeSeconds=2)):
            self.compose(profile)

    def test_the_pilot_fits_the_limits_the_app_writes_on_a_new_vault(self):
        # app/src/lib/create/sequenceDefaults.ts: 1% slippage, 20% overlap, 5-minute
        # observations, 168-hour horizon, 0.005 ETH gas per run.
        profile = generator.load_profile(PILOT)
        self.assertGreaterEqual(profile['planner']['maximumForecastSeconds'], 168 * 3600)
        self.assertLessEqual(profile['destinations']['quoteSlippageBps'], 100)
        self.assertLessEqual(max(profile['planner']['overlapChoicesBps']), 2000)
        self.assertEqual(min(profile['planner']['overlapChoicesBps']), 0)
        self.assertLessEqual(profile['plan']['deadlineSeconds'], 5 * 60)
        self.assertLessEqual(profile['plan']['maxGasCostWei'], 5 * 10**15)
        operator = profile['operatorPolicy']
        # The worst envelope fits the service's caps, so a gas spike waits instead of refusing at publication.
        self.assertLessEqual(operator['max_gas'] * operator['max_fee_per_gas'],
                             min(operator['max_total_cost'], profile['plan']['maxGasCostWei']))
        self.assertGreaterEqual(operator['max_gas'], max(profile['gas']['executeGasUnits'].values()))

    def test_only_the_loopback_or_https_rpc(self):
        for endpoint in ('http://10.204.0.1:8547/', 'http://rpc.domino.money/', 'ftp://127.0.0.1/'):
            with self.subTest(endpoint), self.assertRaisesRegex(ExecutionError, 'execution_rpc_configuration'):
                self.compose(rpc_endpoint=endpoint)

    def run_cli(self, *extra, profile=None):
        path = self.temp / 'profile.json'
        path.write_text(json.dumps(profile or fixture_profile()))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = generator.main(['--release', str(RELEASE), '--profile', str(path), '--sequence', f'{OWNER}:{VAULT}',
                                   '--sequence-expires-at', str(self.expiry), *extra])
        return code, json.loads(out.getvalue())

    def test_the_cli_writes_private_files_the_service_loads(self):
        target = self.temp / 'out'
        code, summary = self.run_cli('--out', str(target), '--worker-id', WORKER)
        self.assertEqual(code, 0)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o700)
        self.assertEqual(sorted(p.name for p in target.iterdir()), ['automation', 'gas-reservation', 'gas-settlement'])
        for folder in target.iterdir():
            self.assertEqual(stat.S_IMODE(folder.stat().st_mode), 0o700)
            for path in folder.iterdir():
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                self.assertEqual(summary['files'][str(path)], generator.hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual(sorted(p.name for p in (target / 'automation').iterdir()), ['40-keystore-credentials.conf', 'config.json'])
        # The drop-in hands the unit exactly the two credentials its configuration names, from the private directory.
        self.assertEqual((target / 'automation/40-keystore-credentials.conf').read_text().splitlines()[2:], [
            '[Service]',
            'LoadCredentialEncrypted=operator-keystore-password:/etc/domino/financial/automation/operator-keystore-password.cred',
            'LoadCredentialEncrypted=publisher-keystore-password:/etc/domino/financial/automation/publisher-keystore-password.cred'])
        # The service's own loader, with its private-file rules, accepts the result.
        parsed = load_config(target / 'automation/config.json')
        self.assertEqual(str(parsed.scheduling.workerId), WORKER)
        self.assertEqual(summary['workerId'], WORKER)
        code, summary = self.run_cli('--out', str(target))
        self.assertEqual((code, summary), (1, {'error': 'output_exists'}))

    def test_the_cli_makes_a_worker_id_and_names_what_it_refuses(self):
        code, summary = self.run_cli('--out', str(self.temp / 'fresh'))
        self.assertEqual(code, 0)
        self.assertEqual(str(uuid.UUID(summary['workerId'])), summary['workerId'])
        broken = fixture_profile(gas={**fixture_profile()['gas'], 'publishGasUnits': 0})
        code, summary = self.run_cli('--out', str(self.temp / 'broken'), profile=broken)
        self.assertEqual((code, summary), (1, {'error': 'automation_configuration_invalid', 'fields': ['gas.publishGasUnits']}))
        self.assertFalse((self.temp / 'broken').exists())
        code, summary = self.run_cli('--out', str(self.temp / 'twice'), '--sequence', f'{OWNER}:{VAULT}')
        self.assertEqual((code, summary), (1, {'error': 'sequence_duplicate'}))


if __name__ == '__main__':
    unittest.main()
