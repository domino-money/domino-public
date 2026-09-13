"""Shared Python/browser collection-card boundary and generated provenance."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT/'backend'), str(ROOT/'backend/tests')]
from performance_models import PerformanceError, validate_request, validate_response
from performance_contract_fixtures import build_fixtures, build_variants


def replace(value, path, replacement):
    result = deepcopy(value)
    target = result
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = replacement
    return result


def boundary_cases():
    requests, responses, _ = build_fixtures()
    request, response = requests['cards'], responses['cards']
    cases = []

    def add(kind, value, valid=False, route='cards'):
        cases.append({'kind': kind, 'route': route, 'value': deepcopy(value), 'valid': valid})

    add('request', request, True)
    add('response', response, True)
    for body in build_variants().values():
        add('response', body, True)
    eight = ['0x'+f'{i:064x}' for i in range(1, 9)]
    add('request', {'epochIds': eight}, True)
    for values in ([], eight+[eight[0]], [eight[0]]*2, ['0x'+'0'*64], [eight[0].upper()],
                   [eight[0]+'\n'], ['0x'+'1'*63], [12], [None], eight[0]):
        add('request', {'epochIds': values})
    for kind, body in (('request', request), ('response', response)):
        add(kind, body, route='sign')
        for field in ('tenant', 'session', 'provider', 'rawReceipt', 'evidence', 'calldata'):
            add(kind, {**body, field: 'private-canary'})
        for value in (None, [], 1, True):
            add(kind, value)
    add('request', {**request, 'owner': '0x'+'22'*20})
    for field, values in (
        ('contractVersion', ['1.0.0', '2.0.0', None]),
        ('owner', ['0x'+'0'*40, '0x'+'A'*40, '0x'+'1'*40+'\n', None]),
        ('chainId', [True, '4663', 1, None]), ('refreshAfterSeconds', [0, 31, '30', True, None]),
        ('executionAvailable', [True, 0, 1, None])):
        for value in values:
            add('response', {**response, field: value})
    for field, values in (
        ('kind', ['available', 'not_found', None]),
        ('epochId', ['0x'+'0'*64, '0x'+'A'*64, None]),
        ('vault', ['0x'+'0'*40, None]), ('positionManager', ['0x'+'0'*40]),
        ('rootTokenId', ['0', '01', '-1', str(2**256), '1\n', 1, None]),
        ('revision', [0, -1, 2**53, True, '1']), ('replayGeneration', [0, 2**53, False]),
        ('observedSeconds', [61, -1, 2**53, None]), ('snapshotAgeSeconds', [121, -1, 2**53, True]),
        ('performanceStatus', ['available', 'measuring', None]),
        ('performanceReasons', [[], ['event_time_valuation_required', 'financial_receipt_adapter_required'],
                                ['financial_receipt_adapter_required']*2]),
        ('complete24h', [True, 0]), ('executionAvailable', [True, 0])):
        for value in values:
            add('response', replace(response, ['cards', 0, field], value))
    for name in response['cards'][0]['metrics']:
        for amount in ('0', 0, False):
            add('response', replace(response, ['cards', 0, 'metrics', name], amount))
    for path, value in (
        (['cards', 0, 'snapshot', 'blockNumber'], 99),
        (['cards', 0, 'snapshot', 'timestamp'], 999),
        (['cards', 0, 'snapshot', 'blockHash'], '0x'+'0'*64),
        (['cards', 0, 'observations', 'pages'], 0),
        (['cards', 0, 'observations', 'receipts'], 0),
        (['cards', 0, 'observations', 'events'], -1),
        (['cards', 0, 'collectionStatus'], 'available'),
        (['cards', 0, 'collectionReason'], 'snapshot_stale')):
        add('response', replace(response, path, value))
    duplicate = deepcopy(response); duplicate['cards'] *= 2; add('response', duplicate)
    empty = deepcopy(response); empty['cards'] = []; add('response', empty)
    maximum = deepcopy(response); maximum['cards'] = []
    for epoch in eight:
        card = deepcopy(response['cards'][0]); card['epochId'] = epoch; maximum['cards'].append(card)
    add('response', maximum, True)
    maximum['cards'].append(deepcopy(maximum['cards'][0])); add('response', maximum)
    no_progress = deepcopy(response)
    no_progress['cards'][0].update(snapshot=deepcopy(response['cards'][0]['baseline']), observedSeconds=0,
        snapshotAgeSeconds=10, observations={'pages': 0, 'receipts': 0, 'events': 0})
    add('response', no_progress, True)
    inconsistent_time = deepcopy(no_progress)
    inconsistent_time['cards'][0]['snapshot']['timestamp'] += 1
    inconsistent_time['cards'][0]['observedSeconds'] = 1
    add('response', inconsistent_time)
    inconsistent_hash = deepcopy(no_progress)
    inconsistent_hash['cards'][0]['snapshot']['blockHash'] = '0x'+'99'*32
    add('response', inconsistent_hash)
    for age, status, reason in ((120, 'measuring', 'forward_observations_only'),
                                (121, 'stale', 'snapshot_stale')):
        valid = deepcopy(response)
        valid['cards'][0].update(snapshotAgeSeconds=age, collectionStatus=status, collectionReason=reason)
        add('response', valid, True)
    add('response', replace(response, ['cards', 0, 'rootTokenId'], str(2**256-1)), True)
    missing = build_variants()['unknown-or-foreign-epoch']
    add('response', replace(missing, ['cards', 0, 'snapshot'], response['cards'][0]['snapshot']))
    return cases


class PerformanceContractTests(unittest.TestCase):
    def test_python_browser_parity_for_all_states_and_monetary_denials(self):
        cases = boundary_cases()
        for index, case in enumerate(cases):
            try:
                (validate_request if case['kind'] == 'request' else validate_response)(case['route'], case['value'])
                valid = True
            except PerformanceError:
                valid = False
            self.assertEqual(valid, case['valid'], (index, case))
        script = """
import {readFileSync} from 'node:fs';
import {validateRequest,validateResponse} from './api-contracts/performance-v1/runtime.mjs';
const cases=JSON.parse(readFileSync(0,'utf8'));
process.stdout.write(JSON.stringify(cases.map(c=>(c.kind==='request'?validateRequest:validateResponse)(c.route,c.value))));
"""
        result = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT,
            input=json.dumps(cases), text=True, capture_output=True, check=True, timeout=20)
        self.assertEqual(json.loads(result.stdout), [case['valid'] for case in cases])

    def test_every_nested_object_is_closed_on_both_sides(self):
        _, responses, _ = build_fixtures()
        variants = [responses['cards'], *build_variants().values()]
        cases = []

        def paths(value, path=()):
            if isinstance(value, dict):
                yield path
                for key, child in value.items():
                    yield from paths(child, (*path, key))
            elif isinstance(value, list):
                for index, child in enumerate(value):
                    yield from paths(child, (*path, index))

        for value in variants:
            for path in paths(value):
                changed = deepcopy(value); target = changed
                for key in path:
                    target = target[key]
                target['rawReceipt'] = 'private-canary'
                with self.assertRaises(PerformanceError):
                    validate_response('cards', changed)
                cases.append(changed)
        script = """
import {readFileSync} from 'node:fs';
import {validateResponse} from './api-contracts/performance-v1/runtime.mjs';
process.stdout.write(JSON.stringify(JSON.parse(readFileSync(0,'utf8')).map(v=>validateResponse('cards',v))));
"""
        result = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT,
            input=json.dumps(cases), text=True, capture_output=True, check=True, timeout=20)
        self.assertEqual(json.loads(result.stdout), [False]*len(cases))

    def test_all_errors_match_http_status_without_private_details(self):
        _, _, errors = build_fixtures()
        script = """
import {readFileSync} from 'node:fs';
import {validateError} from './api-contracts/performance-v1/runtime.mjs';
const rows=JSON.parse(readFileSync(0,'utf8'));
process.stdout.write(JSON.stringify(rows.map(r=>[validateError(r.status,r.body),validateError(r.status+1,r.body),validateError(r.status,{...r.body,session:'private'})])));
"""
        result = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT,
            input=json.dumps(errors), text=True, capture_output=True, check=True, timeout=20)
        self.assertEqual(json.loads(result.stdout), [[True, False, False] for _ in errors])
        unknown = PerformanceError('secret-provider-detail')
        self.assertEqual((unknown.status, unknown.code), (503, 'upstream_unavailable'))

    def test_browser_rejects_sparse_accessor_symbol_and_nonfinite_objects(self):
        script = """
import {readFileSync} from 'node:fs';
import {validateRequest,validateResponse,validateError} from './api-contracts/performance-v1/runtime.mjs';
const response=JSON.parse(readFileSync('api-contracts/performance-v1/fixtures/responses/cards.json','utf8'));
const epoch=response.cards[0].epochId; let reads=0;
const sparse={epochIds:new Array(1)};
const extra={epochIds:[epoch]}; extra.epochIds.secret='private';
const accessor={}; Object.defineProperty(accessor,'epochIds',{enumerable:true,get(){reads++;return[epoch]}});
const symbol={epochIds:[epoch]}; symbol[Symbol('private')]='secret';
const bad=structuredClone(response); bad.cards[0].snapshotAgeSeconds=NaN;
const infinity=structuredClone(response); infinity.cards[0].snapshotAgeSeconds=Infinity;
const negativeZero=structuredClone(response); negativeZero.cards[0].snapshotAgeSeconds=-0;
const constAccessor=structuredClone(response); Object.defineProperty(constAccessor.cards[0].performanceReasons,'0',{get(){reads++;return'financial_receipt_adapter_required'}});
const error={};Object.defineProperty(error,'error',{value:'session_required'});
const results=[sparse,extra,accessor,symbol].map(v=>validateRequest('cards',v));
results.push(...[bad,infinity,negativeZero,constAccessor].map(v=>validateResponse('cards',v)),validateError(401,error));
process.stdout.write(JSON.stringify({results,reads}));
"""
        result = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT,
            text=True, capture_output=True, check=True, timeout=20)
        self.assertEqual(json.loads(result.stdout), {'results': [False]*9, 'reads': 0})

    def test_python_rejects_float_lexemes_before_exported_values(self):
        _, responses, _ = build_fixtures()
        for path, value in ((['refreshAfterSeconds'], 30.0), (['chainId'], 4663.0),
                            (['cards', 0, 'revision'], 3.0)):
            with self.assertRaises(PerformanceError):
                validate_response('cards', replace(responses['cards'], path, value))

    def test_manifest_pins_files_and_sources_and_export_is_current(self):
        manifest = json.loads((ROOT/'api-contracts/performance-v1/manifest.json').read_text())
        for category, prefix in (('sources', ROOT), ('files', ROOT/'api-contracts/performance-v1')):
            for item in manifest[category]:
                self.assertEqual(hashlib.sha256((prefix/item['path']).read_bytes()).hexdigest(), item['sha256'], item['path'])
        result = subprocess.run([sys.executable, 'scripts/export-performance-contract.py', '--check'],
            cwd=ROOT, text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)


if __name__ == '__main__':
    unittest.main()
