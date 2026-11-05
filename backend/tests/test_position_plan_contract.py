"""position-plan-v1: the committed exports are current, the Python and browser validators agree, the
service binds the session's wallet, and the private listener keeps the authenticated boundary."""
from contextlib import redirect_stderr
from copy import deepcopy
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from position_plan_contract_fixtures import (CSRF, NITRO_ANSWERS, SESSION, FakeAuth, build_fixtures,  # noqa: E402
                                             build_variants, recordings, replay_service, replayed)
from discovery import DataError, RpcIntrinsicGas  # noqa: E402
from v2_position_plan import PlanError  # noqa: E402
from v2_position_plan_models import CONTRACT_VERSION, PositionPlanError, validate_request, validate_response  # noqa: E402
from v2_position_plan_service import PositionPlanService, plan_failure  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DEST = ROOT / 'api-contracts/position-plan-v1'
OTHER = '0x' + '99' * 20


def load_exporter():
    spec = importlib.util.spec_from_file_location('export_position_plan_contract',
                                                  ROOT / 'scripts/export-position-plan-contract.py')
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
    add = lambda kind, value, valid=False: rows.append({'kind': kind, 'route': 'plan', 'value': value, 'valid': valid})
    request, response = requests['plan'], responses['plan']
    add('request', request, True)
    add('response', response, True)
    for _, body in build_variants().values():
        add('response', body, True)
    for field in ('owner', 'recipient', 'zap', 'feeToken'):
        add('request', {**request, field: OTHER})
    for field, values in (('slippageBps', [9, 501, '50', True]), ('chainId', [1, '8453', 4664]),
                          ('consent', ['relayed', 'signature']), ('action', ['exit', 'collect'])):
        for value in values:
            add('request', {**request, field: value})
    add('request', {**request, 'inputs': [{'token': OTHER, 'amountRaw': '0'}]})
    add('request', {**request, 'position': {'dex': 4, 'tokenId': '1'}})
    add('response', {**response, 'contractVersion': '2.0.0'})
    plan = ['plan', 'zapPlan']
    for path, value in (([*plan, 'intent', 'recipient'], OTHER), ([*plan, 'intent', 'feeBps'], 64),
                        ([*plan, 'intent', 'minLiquidity'], '1'), ([*plan, 'legs', 0, 'minAmountOut'], '1'),
                        (['plan', 'fee', 'amountRaw'], '1'), (['plan', 'fee', 'ranks', 0, 'rank'], 0),
                        (['plan', 'expiresAt'], response['plan']['requestedAt'] + 600), (['plan', 'deadline'], '1'),
                        (['plan', 'signature', 'permit', 'nonce'], '1'), (['plan', 'signature', 'digest'], '0x' + '00' * 32),
                        (['plan', 'signature', 'typedData', 'message', 'spender'], OTHER),
                        (['plan', 'intentHash'], '0x' + '11' * 32), (['plan', 'routesHash'], '0x' + '22' * 32),
                        (['plan', 'call', 'function'], 'create'), (['plan', 'readiness', 'account', 'kind'], 'contract'),
                        (['plan', 'readiness', 'steps', 0, 'data'], '0x'), (['plan', 'simulation', 'status'], 'not_run')):
        add('response', edit(response, path, value))
    return rows


class ContractTests(unittest.TestCase):
    def test_committed_exports_are_current(self):
        exporter = load_exporter()
        for name, text in exporter.build().items():
            with self.subTest(path=name):
                self.assertEqual((DEST / name).read_text(), text, 'run scripts/export-position-plan-contract.py and commit')

    def test_python_and_browser_validators_agree(self):
        rows = cases()
        for row in rows:
            with self.subTest(kind=row['kind'], value=repr(row['value'])[:100]):
                try:
                    (validate_request if row['kind'] == 'request' else validate_response)(row['route'], row['value'])
                    valid = True
                except PositionPlanError:
                    valid = False
                self.assertEqual(valid, row['valid'])
        if shutil.which('node') is None:
            self.skipTest('node is not installed')
        script = """
import {readFileSync} from 'node:fs';
import {validateRequest, validateResponse} from './api-contracts/position-plan-v1/runtime.mjs';
const cases = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(cases.map(c => (c.kind === 'request' ? validateRequest : validateResponse)(c.route, c.value))));
"""
        result = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT, input=json.dumps(rows),
                                text=True, capture_output=True, timeout=60, check=True)
        self.assertEqual(json.loads(result.stdout), [row['valid'] for row in rows])

    def test_the_consumer_suite_passes(self):
        if shutil.which('node') is None:
            self.skipTest('node is not installed')
        result = subprocess.run(['node', '--test', 'api-contracts/position-plan-v1/consumer.test.mjs'], cwd=ROOT,
                                text=True, capture_output=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout[-2000:] + result.stderr[-2000:])

    def test_the_chains_are_the_enabled_profiles_as_the_packages_chains_are(self):
        # Chain and CONSTANTS.chains both follow api-contracts/v2/chains: enabling a profile regenerates this package.
        from typing import get_args
        from v2_chains import default_registry
        from v2_position_plan_models import Chain
        enabled = tuple(profile.chainId for profile in default_registry().chains)
        self.assertEqual(get_args(Chain), enabled)
        request = json.loads((ROOT / 'api-contracts/position-plan-v1/schemas/plan.request.schema.json').read_text())
        self.assertEqual(request['properties']['chainId']['enum'], list(enabled))

    def test_every_nested_response_object_is_closed(self):
        _, responses, _ = build_fixtures()
        body = responses['plan']

        def paths(value, path=()):
            if isinstance(value, dict):
                yield path
                for key, child in value.items():
                    yield from paths(child, (*path, key))
            elif isinstance(value, list):
                for index, child in enumerate(value):
                    yield from paths(child, (*path, index))
        for path in paths(body):
            changed = deepcopy(body)
            target = changed
            for key in path:
                target = target[key]
            target['signedTransaction'] = '0x00'
            with self.subTest(path=path), self.assertRaisesRegex(PositionPlanError, 'upstream_contract_mismatch'):
                validate_response('plan', changed)


class ServiceTests(unittest.TestCase):
    def run_service(self, name='create-permit2', **changes):
        service, request, _ = replay_service(name)
        request.update(changes)
        return service.execute('plan', request, client='192.0.2.1', session=SESSION, csrf=CSRF)

    def test_the_session_wallet_is_the_owner_and_receives_everything(self):
        data = recordings()
        owner = data['scenarios']['create-permit2']['owner']
        result = self.run_service()
        plan = result['plan']
        self.assertEqual(result['contractVersion'], CONTRACT_VERSION)
        self.assertEqual((plan['owner'], plan['zapPlan']['intent']['recipient'], plan['request']['owner']),
                         (owner, owner, owner))
        self.assertEqual(plan['signature']['typedData']['message']['witness']['recipient'], owner)

    def test_a_request_naming_an_owner_is_refused_before_the_session(self):
        auth = Mock()
        service, request, _ = replay_service('create-permit2', auth=auth)
        with self.assertRaisesRegex(PositionPlanError, 'invalid_request'):
            service.execute('plan', {**request, 'owner': OTHER}, client='192.0.2.1', session=SESSION, csrf=CSRF)
        auth.begin.assert_not_called()

    def test_failures_map_to_contract_codes(self):
        self.assertEqual(plan_failure(PlanError('position_plan_no_route')).code, 'position_plan_no_route')
        self.assertEqual(plan_failure(DataError('read_deadline_exceeded')).code, 'request_timeout')
        self.assertEqual(plan_failure(DataError('http_503')).code, 'upstream_unavailable')
        self.assertEqual(plan_failure(DataError('v2_rpc_endpoints_cooling')).code, 'upstream_unavailable')
        self.assertEqual(plan_failure(DataError('invalid_abi_response')).code, 'upstream_invalid_response')
        # A call refused before it ran (an L1 price spike on Nitro) is a provider not answering now, as it was while
        # it read as rpc_error; one that ran out of gas stays an invalid answer.
        self.assertEqual(plan_failure(RpcIntrinsicGas('rpc_call_gas_limit')).code, 'upstream_unavailable')
        self.assertEqual(plan_failure(DataError('rpc_call_gas_limit')).code, 'upstream_invalid_response')
        service = PositionPlanService(FakeAuth(OTHER), {}, clock=lambda: 1)
        with self.assertRaisesRegex(PositionPlanError, 'position_plan_chain_unavailable'):
            service.execute('plan', recordings()['scenarios']['create-permit2']['request'], client='192.0.2.1',
                            session=SESSION, csrf=CSRF)

    def test_robinhoods_l1_data_fee_is_the_own_nodes_zero(self):
        """The recorded Robinhood plan carries the own node's NodeInterface answer for
        its call: zero L1 gas today, a fee of 0 with its source and block, not a gap."""
        from eth_abi import decode
        _, response = replayed('create-robinhood-direct')
        provenance = recordings()['scenarios']['create-robinhood-direct']['nodeInterface']
        self.assertEqual((provenance['source'], provenance['chainId']), ('the own Robinhood node', 4663))
        answer = json.loads(NITRO_ANSWERS.read_text())['robinhood-4663']
        self.assertEqual((answer['block'], answer['blockHash']), (provenance['block'], provenance['blockHash']))
        _, base_fee, _ = decode(['uint64', 'uint256', 'uint256'], bytes.fromhex(answer['result'][2:]))
        plan = response['plan']
        self.assertEqual(plan['l1DataFee'], {'status': 'ok', 'source': 'nitro_node_interface',
                                             'block': plan['block']['number'], 'weiRaw': '0',
                                             'upperBoundWeiRaw': None, 'l1GasUnits': '0',
                                             'l2BaseFeeWei': str(base_fee), 'transactionBytes': None})

    def test_an_expired_plan_or_a_leaked_secret_is_never_delivered(self):
        service, request, _ = replay_service('create-permit2')
        service.clock = lambda: 10**10
        with self.assertRaisesRegex(PositionPlanError, 'preview_expired'):
            service.execute('plan', request, client='192.0.2.1', session=SESSION, csrf=CSRF)
        service, request, _ = replay_service('create-permit2')
        zap = recordings()['chains']['8453']['manifest']['contracts']['zap.v4']
        service.private_values = (zap,)
        with self.assertRaisesRegex(PositionPlanError, 'upstream_invalid_response'):
            service.execute('plan', request, client='192.0.2.1', session=SESSION, csrf=CSRF)


ORIGIN = 'https://domino.money'
HEADERS = {'CF-Access-Jwt-Assertion': 'synthetic-service-assertion', 'X-Domino-Client-Id': '192.0.2.1',
           'X-Domino-Browser-Origin': ORIGIN, 'X-Domino-Position-Plan-Contract': CONTRACT_VERSION,
           'X-Domino-Session': SESSION, 'X-Domino-CSRF': CSRF}


class ApiTests(unittest.TestCase):
    def client(self, name='create-permit2'):
        from fastapi.testclient import TestClient
        from v2_position_plan_api import PositionPlanGateway, create_position_plan_app
        service, request, _ = replay_service(name)
        service.clock = lambda: recordings()['scenarios'][name]['clock']
        self.verifier = SimpleNamespace(verify=Mock())
        gateway = PositionPlanGateway(service=service, verifier=self.verifier, origin=ORIGIN, enabled=True,
                                      clock=lambda: 0.0)
        client = TestClient(create_position_plan_app(gateway), client=('127.0.0.1', 43100),
                            base_url='http://127.0.0.1:8911')
        client.__enter__()
        self.addCleanup(client.__exit__, None, None, None)
        return client, request

    def post(self, client, body, headers=None, route='plan'):
        return client.post('/internal/position-plan/v1/' + route, content=json.dumps(body),
                           headers={'content-type': 'application/json',
                                    **{k.lower(): v for k, v in (headers or HEADERS).items()}})

    def test_a_plan_is_served_with_the_contract_header_and_one_safe_record(self):
        client, request = self.client()
        with redirect_stderr(io.StringIO()) as printed:
            response = self.post(client, request)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers['X-Domino-Position-Plan-Contract'], CONTRACT_VERSION)
        self.assertIn('no-store', response.headers['cache-control'])
        self.assertEqual(response.json()['plan']['action'], 'create')
        self.verifier.verify.assert_called_once()
        records = [json.loads(line) for line in printed.getvalue().splitlines() if line]
        self.assertEqual([(r['service'], r['route'], r['status']) for r in records],
                         [('internal-position-plan-v1', 'plan', 200)])
        self.assertIsNone(re.search(r'0x[0-9a-fA-F]{40}', printed.getvalue()))
        for value in (SESSION, CSRF):
            self.assertNotIn(value, printed.getvalue())

    def test_the_admission_boundary(self):
        client, request = self.client()
        self.assertEqual(self.post(client, {**request, 'owner': OTHER}).json(), {'error': 'invalid_request'})
        self.assertEqual(self.post(client, request, {**HEADERS, 'X-Domino-Position-Plan-Contract': '0.9.0'}).json(),
                         {'error': 'upstream_contract_mismatch'})
        self.assertEqual(self.post(client, request, route='quote').status_code, 404)
        self.assertEqual(self.post(client, request, {**HEADERS, 'X-Domino-Browser-Origin': 'https://evil.example'}).json(),
                         {'error': 'origin_not_allowed'})
        self.assertEqual(client.get('/internal/position-plan/v1/plan').status_code, 405)

    def test_a_disabled_listener_serves_nothing(self):
        from fastapi.testclient import TestClient
        from v2_position_plan_api import create_position_plan_app
        with TestClient(create_position_plan_app(), client=('127.0.0.1', 43000)) as client:
            response = client.post('/internal/position-plan/v1/plan', content='{}',
                                   headers={'content-type': 'application/json'})
        self.assertEqual((response.status_code, response.json()), (404, {'error': 'route_not_available'}))


class LauncherTests(unittest.TestCase):
    def test_disabled_launch_reads_no_configuration(self):
        import v2_position_plan_api as api
        from session_api import acquire_session_lock
        with tempfile.TemporaryDirectory() as temporary:
            fd = acquire_session_lock(Path(temporary) / 'runtime')
            with patch('session_api.acquire_session_lock', return_value=fd), patch.dict(os.environ, {}, clear=True), \
                 patch.object(sys, 'argv', ['v2_position_plan_api.py']), \
                 patch('session_api.load_session_rpc_config') as rpc, patch('uvicorn.run') as server:
                api.main()
                rpc.assert_not_called()
                self.assertFalse(server.call_args.args[0].state.gateway.enabled)
                self.assertEqual((server.call_args.kwargs['host'], server.call_args.kwargs['port']), ('127.0.0.1', 8911))

    def test_an_enabled_launch_without_chains_names_the_setting(self):
        import v2_position_plan_api as api
        from session_api import acquire_session_lock
        with tempfile.TemporaryDirectory() as temporary:
            fd = acquire_session_lock(Path(temporary) / 'runtime')
            stderr = io.StringIO()
            with patch('session_api.acquire_session_lock', return_value=fd), \
                 patch.dict(os.environ, {'DOMINO_UNISWAP_API_KEY': 'key-canary-value'}, clear=True), \
                 patch.object(sys, 'argv', ['v2_position_plan_api.py', '--enable']), patch('uvicorn.run') as server, \
                 redirect_stderr(stderr), self.assertRaises(SystemExit) as exit_:
                api.main()
            self.assertEqual(exit_.exception.code, 2)
            server.assert_not_called()
            self.assertIn('position_plan_config_chains', stderr.getvalue())
            self.assertNotIn('key-canary-value', stderr.getvalue())

    def test_reserved_ports_and_workers_are_refused(self):
        import v2_position_plan_api as api
        for argv, env in ((['v2_position_plan_api.py', '--port', '8910'], {}),
                          (['v2_position_plan_api.py'], {'WEB_CONCURRENCY': '2'})):
            with self.subTest(argv=argv), patch.dict(os.environ, env, clear=True), patch.object(sys, 'argv', argv), \
                 patch('session_api.acquire_session_lock') as lock, redirect_stderr(io.StringIO()), \
                 self.assertRaises(SystemExit):
                api.main()
            lock.assert_not_called()


if __name__ == '__main__':
    unittest.main()
