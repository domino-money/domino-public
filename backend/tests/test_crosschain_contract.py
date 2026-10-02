"""crosschain-v1: the committed exports are current, and the Python and browser validators agree."""
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import unittest

from crosschain_support import OTHER, OWNER, ZERO  # noqa: F401  (puts backend on sys.path)
from crosschain_contract_fixtures import build_fixtures, build_variants
from crosschain_models import CrosschainError, validate_request, validate_response

ROOT = Path(__file__).resolve().parents[2]
DEST = ROOT / 'api-contracts/crosschain-v1'


def load_exporter():
    spec = importlib.util.spec_from_file_location('export_crosschain_contract', ROOT / 'scripts/export-crosschain-contract.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def edit(value, path, replacement):
    result = deepcopy(value)
    target = result
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = replacement
    return result


def cases():
    requests, responses, _ = build_fixtures()
    rows = []
    add = lambda kind, route, value, valid=False: rows.append({'kind': kind, 'route': route, 'value': value, 'valid': valid})
    for route in requests:
        add('request', route, requests[route], True)
        add('response', route, responses[route], True)
        for field in ('owner', 'recipient', 'refundTo', 'feeRecipient', 'apiKey'):
            add('request', route, {**requests[route], field: OTHER})
        add('response', route, {**responses[route], 'contractVersion': '2.0.0'})
    for route, body in build_variants().values():
        add('response', route, body, True)
    quote = requests['quote']
    for field, values in (('amountRaw', ['0', '01', '-1', 100, str(2**128)]), ('slippageBps', [9, 501, '50', True]),
                          ('originChainId', [4663, 0, '42161', True]), ('destinationChainId', [1, 10]),
                          ('destinationGas', [1, 'false', None])):
        for value in values:
            add('request', 'quote', {**quote, field: value})
    q = responses['quote']
    steps = ['quote', 'steps']
    for path, value in ((['quote', 'decision'], 'across'), ([*steps, 1, 'transaction', 'to'], OTHER),
                        ([*steps, 0, 'approval', 'spender'], OTHER), ([*steps, 0, 'approval', 'amountRaw'], '1'),
                        ([*steps, 1, 'transaction', 'valueRaw'], '1'), (['quote', 'candidates', 0, 'refund', 'recipient'], OTHER),
                        (['quote', 'comparison', 'advantageBps'], 1), (['quote', 'feeRecipient'], OWNER),
                        (['quote', 'expiresAt'], q['quote']['requestedAt'] + 600), (['quote', 'appFeeBps'], 65),
                        (['quote', 'candidates', 1, 'status'], 'unsafe')):
        add('response', 'quote', edit(q, path, value))
    s = responses['status']
    for path, value in ((['status', 'state'], 'pending'), (['status', 'terminal'], False), (['status', 'nextCheckSeconds'], 10),
                        (['status', 'request', 'previousState'], 'refunded'), (['status', 'fee', 'amountRaw'], '0'),
                        (['status', 'recovery'], {'kind': 'refunded', 'chainId': 42161, 'recipient': OWNER}),
                        (['status', 'providerStatus'], None)):
        add('response', 'status', edit(s, path, value))
    o = responses['origins']
    for path, value in ((['origins', 'chains', 0, 'chainId'], 4663), (['origins', 'chains', 0, 'name'], 'Not Ethereum'),
                        (['origins', 'providers', 0, 'reason'], 'x'), (['origins', 'chains', 0, 'tokens', 0, 'providers'], ['across', 'relay'])):
        add('response', 'origins', edit(o, path, value))
    return rows


class CrosschainContractTests(unittest.TestCase):
    def test_committed_exports_are_current(self):
        exporter = load_exporter()
        for name, text in exporter.build().items():
            with self.subTest(path=name):
                self.assertEqual((DEST / name).read_text(), text, 'run scripts/export-crosschain-contract.py and commit the result')

    def test_python_and_browser_validators_agree(self):
        rows = cases()
        for row in rows:
            with self.subTest(kind=row['kind'], route=row['route'], value=repr(row['value'])[:120]):
                try:
                    (validate_request if row['kind'] == 'request' else validate_response)(row['route'], row['value'])
                    valid = True
                except CrosschainError:
                    valid = False
                self.assertEqual(valid, row['valid'])
        if shutil.which('node') is None:
            self.skipTest('node is not installed')
        script = """
import {readFileSync} from 'node:fs';
import {validateRequest, validateResponse} from './api-contracts/crosschain-v1/runtime.mjs';
const cases = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(cases.map(c => (c.kind === 'request' ? validateRequest : validateResponse)(c.route, c.value))));
"""
        result = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT, input=json.dumps(rows),
                                text=True, capture_output=True, timeout=30, check=True)
        self.assertEqual(json.loads(result.stdout), [row['valid'] for row in rows])

    def test_the_consumer_suite_passes(self):
        if shutil.which('node') is None:
            self.skipTest('node is not installed')
        result = subprocess.run(['node', '--test', 'api-contracts/crosschain-v1/consumer.test.mjs'], cwd=ROOT,
                                text=True, capture_output=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout[-2000:] + result.stderr[-2000:])

    def test_every_nested_response_object_is_closed(self):
        _, responses, _ = build_fixtures()

        def paths(value, path=()):
            if isinstance(value, dict):
                yield path
                for key, child in value.items():
                    yield from paths(child, (*path, key))
            elif isinstance(value, list):
                for index, child in enumerate(value):
                    yield from paths(child, (*path, index))
        for route, body in responses.items():
            for path in paths(body):
                changed = deepcopy(body)
                target = changed
                for key in path:
                    target = target[key]
                target['signedTransaction'] = '0x00'
                with self.subTest(route=route, path=path), self.assertRaisesRegex(CrosschainError, 'upstream_contract_mismatch'):
                    validate_response(route, changed)


if __name__ == '__main__':
    unittest.main()
