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
from crosschain_models import CrosschainError, approve_data, validate_request, validate_response

ROOT = Path(__file__).resolve().parents[2]
DEST = ROOT / 'api-contracts/crosschain-v1'
RELAY, ACROSS = ['quote', 'candidates', 0], ['quote', 'candidates', 1]
NO_COMPARISON = {'basis': 'expected_output_per_input_after_all_fees', 'advantageRaw': None, 'advantageBps': None}


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


def edits(value, *changes):
    for path, replacement in changes:
        value = edit(value, path, replacement)
    return value


def approval_for(body, amount):
    """The quote's approval step for `amount`, its calldata rebuilt to match."""
    spender = body['quote']['steps'][0]['approval']['spender']
    return edits(body, (['quote', 'steps', 0, 'approval', 'amountRaw'], amount),
                 (['quote', 'steps', 0, 'transaction', 'data'], approve_data(spender, int(amount))))


def comparison(winner, other):
    """The margin of `winner` (output, input) over `other`, worked out here and not by the models: the extra output it
    delivers for the other's input, floor(E_w·I_o / I_w) − E_o, and (E_w·I_o − E_o·I_w) · 10000 // (E_o·I_w)."""
    (out_w, in_w), (out_o, in_o) = winner, other
    return {'basis': 'expected_output_per_input_after_all_fees', 'advantageRaw': str(out_w * in_o // in_w - out_o),
            'advantageBps': (out_w * in_o - out_o * in_w) * 10000 // (out_o * in_w)}


def output_rows(add, quote, variants):
    """Quotes by output (1.1.0-rc.1): every rule of the request, the candidate, the cap, the rate and the steps, on the
    package's own variants, in Python and in the browser's runtime alike."""
    out, above, native = (variants[name][1] for name in ('quote.output', 'quote.output-above-max', 'quote.output-native'))
    gas, none, base = variants['quote.destination-gas'][1], variants['quote.none'][1], build_fixtures()[1]['quote']
    # Requests: maxInputRaw with output only, both raws below 2^128, every key required.
    by_output = {**quote, 'amountKind': 'output', 'maxInputRaw': '150000000'}
    add('request', 'quote', by_output, True)
    add('request', 'quote', {**by_output, 'maxInputRaw': str(2**128 - 1)}, True)
    for change in ({'maxInputRaw': None}, {'maxInputRaw': str(2**128)}, {'maxInputRaw': '0'}, {'maxInputRaw': 150000000},
                   {'amountKind': 'exact_output'}, {'amountKind': None}, {'amountRaw': str(2**128)}):
        add('request', 'quote', {**by_output, **change})
    add('request', 'quote', {**quote, 'maxInputRaw': '150000000'})
    for key in ('amountKind', 'maxInputRaw'):
        add('request', 'quote', {name: value for name, value in quote.items() if name != key})
    # A candidate is priced exactly when it says what its deposit takes.
    add('response', 'quote', edit(gas, [*ACROSS, 'inputRaw'], None))
    add('response', 'quote', edit(none, [*RELAY, 'inputRaw'], '100000000'))
    # Exact input: a priced candidate takes exactly the amount asked (Across here is priced but not eligible).
    add('response', 'quote', edit(gas, [*ACROSS, 'inputRaw'], '100000001'))
    # By output: every price guarantees the amount asked (Relay here is priced but above the cap).
    add('response', 'quote', edit(above, [*RELAY, 'minimumOutputRaw'], '99999999'))
    # The cap: quoted only within it, input_above_max only above it and only by output; a cap equal to the input holds it.
    add('response', 'quote', edit(out, ['quote', 'request', 'maxInputRaw'], '100910000'))
    add('response', 'quote', edit(above, ['quote', 'request', 'maxInputRaw'], '150000000'))
    add('response', 'quote', edit(out, ['quote', 'request', 'maxInputRaw'], '100916974'), True)
    add('response', 'quote', edits(base, ([*ACROSS, 'status'], 'input_above_max'), ([*ACROSS, 'reason'], 'input_above_max'),
                                   (['quote', 'reason'], 'only_quote'), (['quote', 'comparison'], NO_COMPARISON)))
    # Destination gas is judged first: a candidate above the cap served the gas asked for.
    gas_above = edits(above, (['quote', 'request', 'destinationGas'], True), ([*ACROSS, 'status'], 'destination_gas_unsupported'),
                      ([*ACROSS, 'reason'], 'destination_gas_unsupported'), (['quote', 'decision'], None),
                      (['quote', 'reason'], 'no_quote'), (['quote', 'comparison'], NO_COMPARISON), (['quote', 'steps'], []))
    add('response', 'quote', gas_above)
    add('response', 'quote', edit(gas_above, [*RELAY, 'destinationGas'], {'deliveredRaw': '1'}), True)
    # The decision is the better rate, and the margin the winner's for the other's input.
    add('response', 'quote', edit(out, ['quote', 'decision'], 'across'))
    add('response', 'quote', edit(out, ['quote', 'comparison', 'advantageRaw'], '14510'))
    add('response', 'quote', edit(out, ['quote', 'comparison', 'advantageBps'], 2))
    add('response', 'quote', edit(out, ['quote', 'comparison', 'basis'], 'expected_output_after_all_fees'))
    add('response', 'quote', edit(out, ['quote', 'comparison'], comparison((100502513, 100916974), (100473291, 100902201))), True)
    # More output at a worse rate (Across: 100.6 for 101.1) does not win.
    add('response', 'quote', edits(out, ([*ACROSS, 'outputRaw'], '100600000'), ([*ACROSS, 'minimumOutputRaw'], '100600000'),
                                   ([*ACROSS, 'inputRaw'], '101100000'),
                                   (['quote', 'comparison'], comparison((100502513, 100916974), (100600000, 101100000)))), True)
    # Equal rates go to the smaller input (Relay twice Across'), then to the shorter wait, then to Relay.
    across_steps = above['quote']['steps']
    add('response', 'quote', edits(out, (['quote', 'request', 'maxInputRaw'], '250000000'), ([*RELAY, 'outputRaw'], '200946582'),
                                   ([*RELAY, 'inputRaw'], '201804402'), (['quote', 'decision'], 'across'),
                                   (['quote', 'comparison'], comparison((100473291, 100902201), (200946582, 201804402))),
                                   (['quote', 'steps'], across_steps)), True)
    same = edits(out, ([*RELAY, 'outputRaw'], '100473291'), ([*RELAY, 'inputRaw'], '100902201'),
                 (['quote', 'comparison'], comparison((100473291, 100902201), (100473291, 100902201))))
    add('response', 'quote', edits(same, ([*ACROSS, 'etaSeconds'], 0), (['quote', 'decision'], 'across'),
                                   (['quote', 'steps'], across_steps)), True)
    add('response', 'quote', approval_for(same, '100902201'), True)
    # The wallet sends the winner's input: the approval (not the need), a native deposit's value (not the need).
    add('response', 'quote', approval_for(out, '100000000'))
    add('response', 'quote', approval_for(out, '100916974'), True)
    add('response', 'quote', edit(native, ['quote', 'steps', 0, 'transaction', 'valueRaw'], '50000000000000000'))


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
        # One version per package: the window's 1.0.0-rc.1 is the listener's own (crosschain_models_rc1.py).
        add('response', route, {**responses[route], 'contractVersion': '1.0.0-rc.1'})
    variants = build_variants()
    for route, body in variants.values():
        add('response', route, body, True)
    quote = requests['quote']
    output_rows(add, quote, variants)
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
