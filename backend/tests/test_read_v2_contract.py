"""Public estimate contract checks; no live provider, credentials or private DB."""
from contextlib import redirect_stdout
from copy import deepcopy
from decimal import Decimal, localcontext
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'backend'), str(ROOT / 'backend/tests')]
from pool_apr import PoolAprEstimate
from pool_apr_contract import (CONTRACT_VERSION, BridgeCapabilities, ErrorResponse,
    build_pool_market_estimate, validate_request, validate_response)
from read_v2_contract_fixtures import build_fixtures, market_evidence


def generator():
    spec = importlib.util.spec_from_file_location('read_v2_export_test', ROOT / 'scripts/export-read-v2-contract.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ReadV2ContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = build_fixtures()
        cls.available = cls.files['fixtures/responses/pool-market.json']

    def test_entire_producer_and_invalid_corpus_matches_python_boundary(self):
        for entry in self.files['fixtures/index.json']['fixtures']:
            with self.subTest(file=entry['file']):
                payload = self.files[entry['file']]
                before = deepcopy(payload)
                if entry['valid']:
                    self.assertIs(validate_response(entry['route'], payload), payload)
                else:
                    with self.assertRaises(ValueError):
                        validate_response(entry['route'], payload)
                self.assertEqual(payload, before)

    def test_requests_have_one_canonical_lowercase_identity_and_no_metric_inputs(self):
        for entry in self.files['fixtures/request-boundaries.json']:
            with self.subTest(name=entry['name']):
                before = deepcopy(entry['payload'])
                if entry['valid']:
                    self.assertIs(validate_request(entry['route'], entry['payload']), entry['payload'])
                else:
                    with self.assertRaises((ValueError, KeyError)):
                        validate_request(entry['route'], entry['payload'])
                self.assertEqual(entry['payload'], before)

    def test_caps_and_errors_preserve_version_route_and_literal_types(self):
        self.assertEqual(CONTRACT_VERSION, '2.0.0-rc.1')
        disabled = self.files['fixtures/capabilities.disabled.json']
        for changes in ({'contractVersion': '1.1.0-rc.3'}, {'dataMode': 'live_read_only'},
                        {'enabledReads': ['pool-market']}, {'enabledReads': ['token']}, {'automation': 0}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                BridgeCapabilities.model_validate({**disabled, **changes})
        for entry in self.files['fixtures/errors.json']:
            ErrorResponse.model_validate(entry['payload'])
        with self.assertRaises(ValueError):
            ErrorResponse.model_validate({'error': 'provider-secret-url'})

    def test_arithmetic_disagreement_passes_shape_but_not_the_wrapper(self):
        changed = deepcopy(self.available)
        changed['estimate']['feeAprEstimate24hPercent'] = '10.950000000000000001'
        PoolAprEstimate.model_validate(changed['estimate'])
        with self.assertRaisesRegex(ValueError, 'pool_estimate_evidence_mismatch'):
            validate_response('pool-market', changed)
        self.assertEqual(self.available['estimate']['feeAprEstimate24hPercent'], '10.95')
        precise = self.files['fixtures/producer/pool-market.precise.json']
        with localcontext() as context:
            context.prec = 100
            independent = str(Decimal('9007199254740993.125') * Decimal('0.01095'))
        self.assertEqual(precise['estimate']['feeAprEstimate24hPercent'], independent)

    def test_no_chart_or_second_observation_is_needed_to_wrap_one_completed_read(self):
        market = market_evidence()
        before = deepcopy(market)
        with (patch('socket.socket', side_effect=AssertionError('network')),
              patch('subprocess.Popen', side_effect=AssertionError('process')),
              patch('builtins.open', side_effect=AssertionError('file'))):
            payload = build_pool_market_estimate(market, now=1010, requested_pool_id=market['poolId'])
        self.assertIs(payload['market'], market)
        self.assertEqual(market, before)
        self.assertEqual(market['priceHistory'], {'status': 'not_requested', 'reason': None, 'data': None, 'cache': None})
        self.assertIsNone(market['feeApr24h'])
        self.assertFalse(payload['executionAvailable'])

    def test_request_identity_and_chart_boundary_fail_without_repair(self):
        market = market_evidence()
        with self.assertRaisesRegex(ValueError, '^pool_estimate_request_mismatch$'):
            build_pool_market_estimate(market, now=1010, requested_pool_id='0x' + 'f' * 64)
        market['priceHistory'] = {'status': 'unavailable', 'reason': 'provider_unavailable', 'data': None, 'cache': None}
        with self.assertRaisesRegex(ValueError, 'pool_estimate_evidence_mismatch'):
            build_pool_market_estimate(market, now=1010, requested_pool_id=market['poolId'])

    def test_zero_missing_unsupported_and_expired_never_converge_to_false_zero(self):
        zero = self.files['fixtures/producer/pool-market.zero-volume.json']
        self.assertEqual((zero['estimate']['status'], zero['estimate']['feeAprEstimate24hPercent']), ('available', '0'))
        for name in ('zero-tvl', 'missing-volume', 'missing-tvl', 'invalid-protocol-fee',
                     'dynamic', 'hooked', 'expired', 'snapshot-expired', 'rejected-currencies'):
            with self.subTest(name=name):
                estimate = self.files[f'fixtures/producer/pool-market.{name}.json']['estimate']
                self.assertEqual(estimate['status'], 'unavailable')
                self.assertIsNone(estimate['feeAprEstimate24hPercent'])
        rejected = self.files['fixtures/producer/pool-market.rejected-currencies.json']['estimate']
        self.assertIn('market_identity_mismatch', rejected['reasons'])
        self.assertNotIn('missing_reported_tvl', rejected['reasons'])
        # Equal directional protocol fees are adjusted, not refused (T1.4).
        adjusted = self.files['fixtures/producer/pool-market.protocol-fee.json']['estimate']
        self.assertEqual(adjusted['status'], 'available')
        self.assertEqual(adjusted['reasons'], [])
        self.assertLess(float(adjusted['feeAprEstimate24hPercent']), 10.95)

    def test_dates_are_retained_across_fresh_stale_and_expired_boundaries(self):
        for name, status, cache_age in (('cache-59', 'available', 59), ('stale', 'stale', 60),
                                      ('cache-300', 'stale', 300), ('expired', 'unavailable', 301)):
            with self.subTest(name=name):
                result = self.files[f'fixtures/producer/pool-market.{name}.json']
                self.assertEqual(result['estimate']['status'], status)
                self.assertEqual(result['estimate']['provenance']['cacheAgeSeconds'], cache_age)
                if status != 'unavailable':
                    self.assertEqual(result['estimate']['provenance']['retrievedAt'], 1010)
                    self.assertEqual(result['estimate']['provenance']['snapshot']['timestamp'], 1000)
        for name, status in (('snapshot-120', 'stale'), ('snapshot-121', 'stale'),
                             ('snapshot-300', 'stale'), ('snapshot-expired', 'unavailable')):
            self.assertEqual(self.files[f'fixtures/producer/pool-market.{name}.json']['estimate']['status'], status)

    def test_python_proves_pool_key_hash_while_browser_does_not_claim_crypto_qualification(self):
        bad = deepcopy(self.available)
        bad['market']['pool']['poolKey']['tick_spacing'] = 10
        with self.assertRaisesRegex(ValueError, 'pool_estimate_evidence_mismatch'):
            validate_response('pool-market', bad)
        denied = build_pool_market_estimate(bad['market'], now=1010, requested_pool_id=bad['poolId'])
        self.assertEqual(denied['estimate']['status'], 'unavailable')
        self.assertIsNone(denied['estimate']['feeAprEstimate24hPercent'])
        self.assertIn('pool_identity_mismatch', denied['estimate']['reasons'])
        script = "import fs from 'node:fs'; import {validateResponse} from './api-contracts/read-v2/runtime.mjs'; const v=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(JSON.stringify(v.map(p=>validateResponse('pool-market',p))));"
        result = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT,
                                input=json.dumps([bad, denied]), capture_output=True, text=True, timeout=30, check=True)
        # The first result intentionally documents the narrower client boundary;
        # transport must trust the reviewed producer, which rejects this body.
        self.assertEqual(json.loads(result.stdout), [True, True])

    def test_generated_bytes_and_manifest_reproduce_the_current_sources(self):
        module = generator()
        files = module.build_files()
        for name, content in files.items():
            with self.subTest(file=name):
                self.assertEqual((module.DEST / name).read_bytes(), content.encode('utf-8'))
        manifest = json.loads(files['manifest.json'])
        for record in manifest['files']:
            self.assertEqual(hashlib.sha256((module.DEST / record['path']).read_bytes()).hexdigest(), record['sha256'])

    def test_check_detects_crlf_byte_drift_without_rewriting_files(self):
        module = generator()
        with tempfile.TemporaryDirectory(prefix='domino-read-v2-check-') as temporary:
            copied = Path(temporary) / 'read-v2'
            shutil.copytree(module.DEST, copied)
            target = copied / 'types.ts'
            target.write_bytes(target.read_bytes().replace(b'\n', b'\r\n'))
            before = target.read_bytes()
            with patch.object(module, 'DEST', copied), redirect_stdout(io.StringIO()):
                self.assertEqual(module.main(['--check']), 1)
            self.assertEqual(target.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
