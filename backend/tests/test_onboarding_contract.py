"""Producer/browser parity and closed preview-only contract regression tests."""
from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
from onboarding_models import OnboardingError, validate_request, validate_response
from onboarding_contract_fixtures import build_fixtures, build_variants


def replace(value, path, replacement):
    result = deepcopy(value)
    target = result
    for key in path[:-1]: target = target[key]
    target[path[-1]] = replacement
    return result


def boundary_cases():
    requests, responses, _ = build_fixtures()
    cases = []
    def add(kind, route, value, valid=False):
        cases.append({'kind': kind, 'route': route, 'value': value, 'valid': valid})
    for route in requests:
        add('request', route, requests[route], True)
        add('response', route, responses[route], True)
        for field in ('owner', 'recipient', 'tenant', 'session', 'apiKey', 'calldata'):
            add('request', route, {**requests[route], field: 'untrusted'})
            add('response', route, {**responses[route], field: 'untrusted'})
        for field, values in [('chainId', [True, '4663', 1, None]),
                              ('amountRaw', ['0', '01', '-1', '1e18', str(2**256), 10, True, '1\n']),
                              ('slippageBps', [-1, 10000, True, '50'])]:
            for value in values: add('request', route, {**requests[route], field: value})
        for field in ('executionAvailable',):
            for value in (0, 1, True, None): add('response', route, replace(responses[route], ['preview', field], value))
        for field, value in [('contractVersion', '2.0.0')]: add('response', route, {**responses[route], field: value})
        for field, value in [('expiresAt', 1029), ('requestedAt', -1), ('retrievedAt', 1030),
                             ('retrievedAt', 999), ('requestFingerprint', 'a'*64+'\n'), ('chainId', '4663')]:
            add('response', route, replace(responses[route], ['preview', field], value))
    position = requests['position-preview']
    for field, values in [('tickLower', [-119, 180, True]), ('tickUpper', [-120, 887273]),
                           ('independentToken', ['0x'+'f'*40]), ('nativeBalanceRaw', [None]), ('budget0Raw', ['99'])]:
        for value in values: add('request', 'position-preview', {**position, field: value})
    for field, value in [('hooks', '0x'+'1'*40), ('fee_pips', 8388608), ('tick_spacing', 0),
                         ('currency0', position['poolKey']['currency1'])]:
        add('request', 'position-preview', replace(position, ['poolKey', field], value))
    minimal = {k: v for k, v in position.items() if k not in ('budget0Raw','budget1Raw','nativeBalanceRaw','nativeGasReserveRaw')}
    add('request', 'position-preview', minimal, True)
    add('request', 'swap-preview', {**requests['swap-preview'], 'tokenOut': requests['swap-preview']['tokenIn']})
    for field, value in [('recipient', '0x'+'f'*40), ('tickUpper', 240), ('mintLiquidityRaw', str(2**127))]:
        add('response', 'position-preview', replace(responses['position-preview'], ['preview', 'position', field], value))
    for field, value in [('expectedDepositRaw', '111'), ('maximumDebitRaw', str(2**128)),
                         ('estimatedUnspentBudgetRaw', '0'), ('selectedBudgetRaw', '111'), ('budgetStatus', 'unknown')]:
        add('response', 'position-preview', replace(responses['position-preview'], ['preview','position','tokens',0,field], value))
    for field, value in [('depositMaximumRaw','1'), ('reportedBalanceRaw','999'), ('selectedGasReserveRaw','299')]:
        add('response', 'position-preview', replace(responses['position-preview'], ['preview','nativeFunding',field], value))
    for path, value in [(['preview','position','adjustedPrices','min'],'0'),
                         (['preview','preparedDeadline'],2199),
                         (['preview','previewChecks','reasons'],['native_balance_unknown']),
                         (['preview','gas','source'],'provider_estimate')]:
        add('response','position-preview',replace(responses['position-preview'],path,value))
    for path, value in [(['preview','quote','dexInputAmountRaw'],'999'),
                         (['preview','quote','policyMinimumOutputRaw'],'1989'),
                         (['preview','quote','outputAfterProviderFeeRaw'],None),
                         (['preview','quote','routes',0,0,'amountInRaw'],'999'),
                         (['preview','previewChecks','reasons'],['invented_reason']),
                         (['preview','simulation','status'],'unknown'),
                         (['preview','provenance','endpoint'],'https://evil.invalid')]:
        add('response','swap-preview',replace(responses['swap-preview'],path,value))
    for _, (route, value) in build_variants().items(): add('response', route, value, True)
    return cases


class OnboardingContractTests(unittest.TestCase):
    def test_python_and_browser_boundary_parity(self):
        cases = boundary_cases()
        for case in cases:
            with self.subTest(kind=case['kind'], route=case['route'], value=repr(case['value'])[:100]):
                try:
                    (validate_request if case['kind'] == 'request' else validate_response)(case['route'], case['value'])
                    valid = True
                except OnboardingError: valid = False
                self.assertEqual(valid, case['valid'])
        script = """
import {readFileSync} from 'node:fs';
import {validateRequest, validateResponse} from './api-contracts/onboarding-v1/runtime.mjs';
const cases = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(cases.map(c => (c.kind === 'request' ? validateRequest : validateResponse)(c.route, c.value))));
"""
        result = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT,
            input=json.dumps(cases), text=True, capture_output=True, timeout=20, check=True)
        self.assertEqual(json.loads(result.stdout), [case['valid'] for case in cases])

    def test_python_refuses_coercion_before_provider(self):
        requests, _, _ = build_fixtures()
        for route, body in requests.items():
            for field, value in [('chainId',4663.0), ('slippageBps',50.0)]:
                with self.subTest(route=route,field=field), self.assertRaises(OnboardingError):
                    validate_request(route, {**body,field:value})

    def test_backend_alone_recomputes_pool_hash(self):
        requests, _, _ = build_fixtures()
        for field,value in [('poolId','0x'+'f'*64), ('poolKey',{**requests['position-preview']['poolKey'],'fee_pips':500})]:
            with self.subTest(field=field), self.assertRaisesRegex(OnboardingError,'invalid_request'):
                validate_request('position-preview',{**requests['position-preview'],field:value})

    def test_every_nested_response_object_is_closed(self):
        _, responses, _ = build_fixtures()
        def paths(value,path=()):
            if isinstance(value,dict):
                yield path
                for key,child in value.items(): yield from paths(child,(*path,key))
            elif isinstance(value,list):
                for index,child in enumerate(value): yield from paths(child,(*path,index))
        for route, body in responses.items():
            for path in paths(body):
                changed=deepcopy(body); target=changed
                for key in path: target=target[key]
                target['transaction']='private-provider-canary'
                with self.subTest(route=route,path=path), self.assertRaisesRegex(OnboardingError,'upstream_contract_mismatch'):
                    validate_response(route,changed)

    def test_unknown_errors_are_sanitized(self):
        error=OnboardingError('provider-key-must-never-escape')
        self.assertEqual((error.code,error.status,str(error)),('upstream_unavailable',503,'upstream_unavailable'))

    def test_export_is_current(self):
        result=subprocess.run([sys.executable,'scripts/export-onboarding-contract.py','--check'],cwd=ROOT,
                              text=True,capture_output=True,timeout=20)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)


if __name__ == '__main__': unittest.main()
