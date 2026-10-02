"""position-plan-v1 producer fixtures: the real service over recorded chain answers. No network, no Anvil.

The answers in fixtures/position-plan/recordings.json were recorded from the
local chains tests/v2_s1_chain.py builds (the same chains
test_v2_position_plan_evm.py executes plans on): Base (8453) with the vendored
v4 core and periphery, Base's deployed v3 bytecode, Base's quoters, Base's own
GasPriceOracle and L1Block state, Permit2 and the V2 stack at its CREATE3
addresses; and Robinhood (4663, Nitro) with its deployed PoolManager. The
Robinhood plan's NodeInterface answer is the own Robinhood node's for the same
call at a pinned block (the local chain only has a stand-in); its block is in
the scenario's `nodeInterface`, and fixtures/position-plan/nitro-l1-answers.json
keeps it beside a real Arbitrum One answer for the same call. Each scenario is
the planner's exact JSON-RPC traffic
for one request, in order; replaying it reproduces the service's answer byte
for byte, and a request that drifts from the recording fails instead of
guessing. Code proofs are pre-seeded in the replay (the EVM tests prove the
code); each chain's profile and manifest are the local chain's, the Base one
admitted by v2_manifest as a local test.

Re-record after a planner change with an Anvil and contracts/out present:

    DOMINO_TEST_EVM=1 backend/.venv/bin/python backend/tests/position_plan_contract_fixtures.py --record \
        [--robinhood-rpc http://127.0.0.1:<the own node's tunnel>] [--arbitrum-rpc https://arb1.arbitrum.io/rpc]

then run scripts/export-position-plan-contract.py and commit both. Without
--robinhood-rpc the Robinhood chain and scenario are kept as recorded (their
answer must come from the own node, never the public Robinhood RPC); without
--arbitrum-rpc the Arbitrum answer is kept. Both nodes are only read: the
chain id, the head, one eth_call pinned to it, and the head again.
"""
from copy import deepcopy
import json
from pathlib import Path
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from discovery import parse_block  # noqa: E402
from v2_chains import ChainProfile  # noqa: E402
from v2_head import Head  # noqa: E402
from v2_manifest import Deployment, checked_deployment  # noqa: E402
from v2_position_plan import PositionPlanner  # noqa: E402
from v2_position_plan_models import ERROR_STATUS_BY_CODE  # noqa: E402
from v2_position_plan_service import PositionPlanService  # noqa: E402
from v2_rpc import ChainEndpoints, Endpoint  # noqa: E402

RECORDINGS = Path(__file__).resolve().parent / 'fixtures/position-plan/recordings.json'
NITRO_ANSWERS = Path(__file__).resolve().parent / 'fixtures/position-plan/nitro-l1-answers.json'
NODE_INTERFACE = '0x00000000000000000000000000000000000000c8'
SESSION, CSRF, CLIENT = 's' * 43, 'c' * 43, '192.0.2.1'
NONCE_WORD = 0x5151
MAIN = 'create-permit2'


class FakeAuth:
    def __init__(self, owner):
        self.owner = owner

    def begin(self, client, session, csrf):
        return {'owner': self.owner, 'session': session, 'csrf': csrf}

    def finish(self, context):
        pass


class Replay:
    """The recorded JSON-RPC exchanges of one scenario, answered in order."""

    def __init__(self, exchanges):
        self.exchanges, self.index = exchanges, 0

    def __call__(self, _url, body):
        if self.index >= len(self.exchanges):
            raise AssertionError('position plan replay: more requests than recorded')
        recorded = self.exchanges[self.index]
        self.index += 1
        if _strip(body) != recorded['request']:
            raise AssertionError(f'position plan replay: request {self.index} drifted from the recording')
        return _restore(body, recorded['response'])


def _strip(body):
    """A request without its JSON-RPC ids, which depend on the client's count."""
    if isinstance(body, list):
        return [_strip(item) for item in body]
    return {key: value for key, value in body.items() if key != 'id'}


def _restore(body, response):
    if isinstance(body, list):
        return [dict(item, id=request['id']) for request, item in zip(body, response)]
    return dict(response, id=body['id'])


class Recorder:
    def __init__(self, send):
        self.send, self.exchanges = send, []

    def __call__(self, url, body):
        response = self.send(url, body)
        stripped = (_strip(response) if not isinstance(response, list)
                    else [{k: v for k, v in item.items() if k != 'id'} for item in response])
        self.exchanges.append({'request': _strip(body), 'response': stripped})
        return response


class ChainHead:
    """The head through the planner's own transport (recorded with everything else)."""

    def __init__(self, endpoints):
        self.endpoints = endpoints

    def head(self):
        raw = self.endpoints.read_rpc(max_requests=2).request('eth_getBlockByNumber', ['latest', False])
        return Head(self.endpoints.chain.chainId, parse_block(raw), None, 0.0)


def _deployment(profile, entry):
    """The chain's v2_manifest Deployment: a #302 manifest admitted as a local test,
    or the router chain's direct one (tests/v2_s1_chain.py: no v3 there)."""
    if entry['admission'] == 'local-test':
        return checked_deployment(entry['manifest'], profile, admission='local-test')
    return Deployment(profile, entry['manifest'])


def _refuse(_url, _body):
    raise AssertionError('position plan replay: a chain the scenario does not use was read')


def _service(chains, chain_id, send, owner, clock):
    """The service with a planner per recorded chain; only `chain_id`'s reads go to `send`."""
    endpoint = Endpoint('local', 'anvil.invalid', 'https://anvil.invalid/', None, 100, None, None)
    planners = {}
    for key, entry in chains.items():
        profile = entry['profile'] if isinstance(entry['profile'], ChainProfile) else \
            ChainProfile.model_validate_json(json.dumps(entry['profile']))
        endpoints = ChainEndpoints(profile, (endpoint,), 'fixture', send=send if int(key) == chain_id else _refuse)
        for contract, codehash in _code_hashes(profile, entry['manifest']).items():
            endpoints.code.record(contract, codehash, 0)
        planners[profile.chainId] = PositionPlanner(profile, endpoints, ChainHead(endpoints),
                                                    _deployment(profile, entry), clock=lambda: clock,
                                                    nonce_word=lambda: NONCE_WORD)
    return PositionPlanService(FakeAuth(owner), planners, clock=lambda: clock,
                               private_values=('uniswap-offline-key-canary',))


def _code_hashes(profile, manifest):
    hashes = {address: manifest['runtimeCodeHashes'][name] for name, address in manifest['contracts'].items()}
    uniswap = profile.uniswap
    for contract in (uniswap.v3.factory, uniswap.v3.positionManager, uniswap.v4.positionManager, uniswap.v4.stateView):
        if profile.verified_codehash(contract):
            hashes[contract] = profile.verified_codehash(contract)
    return hashes


def recordings():
    return json.loads(RECORDINGS.read_text())


def replay_service(name, data=None, *, auth=None):
    """(service, request, replay) for one recorded scenario: the real service, its chain recorded."""
    data = data or recordings()
    scenario = data['scenarios'][name]
    replay = Replay(scenario['exchanges'])
    service = _service(data['chains'], scenario['request']['chainId'], replay, scenario['owner'], scenario['clock'])
    if auth is not None:
        service.auth = auth
    return service, deepcopy(scenario['request']), replay


def replayed(name, data=None):
    """(request, response) of one recorded scenario, answered by the real service."""
    service, request, replay = replay_service(name, data)
    response = service.execute('plan', deepcopy(request), client=CLIENT, session=SESSION, csrf=CSRF)
    if replay.index != len(replay.exchanges):
        raise AssertionError('position plan replay: fewer requests than recorded')
    return request, response


def build_fixtures():
    data = recordings()
    request, response = replayed(MAIN, data)
    errors = {code: {'status': status, 'body': {'error': code}} for code, status in sorted(ERROR_STATUS_BY_CODE.items())}
    return {'plan': request}, {'plan': response}, errors


def build_variants():
    data = recordings()
    return {'plan.' + name: ('plan', replayed(name, data)[1]) for name in sorted(data['scenarios']) if name != MAIN}


# ------------------------------------------------------------------ record
def _node(url, method, params):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
    # arb1.arbitrum.io refuses requests without a User-Agent.
    request = urllib.request.Request(url, body, {'Content-Type': 'application/json',
                                                 'User-Agent': 'domino-position-plan-fixtures'})
    with urllib.request.urlopen(request, timeout=30) as response:
        reply = json.load(response)
    if 'error' in reply:
        raise AssertionError(f'{method}: {reply["error"]}')
    return reply['result']


def capture_node_interface(url, chain_id, call, source):
    """A real Nitro node's NodeInterface answer for `call`, pinned to its head:
    the chain id first, then the head, the call at that block, and the block
    again (unchanged, or the capture is refused). Read only."""
    if _node(url, 'eth_chainId', []) != hex(chain_id):
        raise AssertionError('the node is not chain ' + str(chain_id))
    if call.get('to') != NODE_INTERFACE:
        raise AssertionError('not a NodeInterface call')
    head = _node(url, 'eth_getBlockByNumber', ['latest', False])
    result = _node(url, 'eth_call', [call, head['number']])
    if _node(url, 'eth_getBlockByNumber', [head['number'], False])['hash'] != head['hash']:
        raise AssertionError('the block changed during the capture')
    return {'source': source, 'chainId': chain_id, 'block': int(head['number'], 16), 'blockHash': head['hash'],
            'request': call, 'result': result}


def _node_interface_exchange(scenario):
    found = [exchange for exchange in scenario['exchanges'] if not isinstance(exchange['request'], list)
             and exchange['request']['method'] == 'eth_call'
             and exchange['request']['params'][0].get('to') == NODE_INTERFACE]
    if len(found) != 1:
        raise AssertionError('one NodeInterface call expected in the Robinhood scenario')
    return found[0]


def record(*, robinhood_rpc=None, arbitrum_rpc=None):
    from test_v2_position_plan_evm import S1JourneyEvmTests, S1RouterLegEvmTests
    base, router = S1JourneyEvmTests, S1RouterLegEvmTests
    if arbitrum_rpc and not robinhood_rpc:
        raise SystemExit('--arbitrum-rpc prices the Robinhood scenario\'s call: re-record it with --robinhood-rpc')
    if robinhood_rpc and urllib.parse.urlparse(robinhood_rpc).hostname not in ('127.0.0.1', 'localhost', '::1'):
        raise SystemExit('Robinhood is read only through the own node\'s loopback tunnel, never a public RPC')
    previous = recordings() if RECORDINGS.exists() else None
    if not robinhood_rpc and (previous is None or 'create-robinhood-direct' not in previous['scenarios']):
        raise SystemExit('no recorded Robinhood scenario to keep: pass --robinhood-rpc (the own node)')
    base.setUpClass()
    if robinhood_rpc:
        router.setUpClass()
    try:
        chains = {}
        for suite in ((base, router) if robinhood_rpc else (base,)):
            fx = suite.fx
            profile_doc = json.loads((fx.directory / 'chains' / f'{fx.profile.key}.json').read_text())
            chains[str(fx.profile.chainId)] = {'profile': profile_doc, 'manifest': fx.manifest,
                                               'admission': 'local-test' if fx.manifest_path else None}
        if not robinhood_rpc:
            chains['4663'] = previous['chains']['4663']
        out = {'note': 'Recorded by backend/tests/position_plan_contract_fixtures.py --record from the local chains '
                       'of tests/v2_s1_chain.py: Base (vendored v4, Base v3 bytecode, Base quoters, Base\'s '
                       'GasPriceOracle and L1Block state, Permit2, the V2 stack at its CREATE3 addresses) and '
                       'Robinhood (its PoolManager, the registry and zap.v4), whose NodeInterface answer is the '
                       'own Robinhood node\'s for the same call (the scenario\'s nodeInterface). '
                       'Synthetic tokens and accounts.',
               'chains': chains, 'scenarios': {}}
        live = {str(base.fx.profile.chainId): base.local}
        if robinhood_rpc:
            live[str(router.fx.profile.chainId)] = router.local
        case = base('test_create_with_a_swap_signed_through_permit2')

        def run(name, request, account):
            owner = account.address.lower()
            local = live[str(request['chainId'])]
            recorder = Recorder(lambda url, body: local.transport(body))
            clock = int(local.head()['timestamp'], 16) + 1
            service = _service(chains, request['chainId'], recorder, owner, clock)
            body = service.execute('plan', deepcopy(request), client=CLIENT, session=SESSION, csrf=CSRF)
            out['scenarios'][name] = {'owner': owner, 'clock': clock, 'request': request,
                                      'exchanges': recorder.exchanges}
            return body

        def position(label, inputs):
            account, owner, token_id = case.new_position(label, base.p1, inputs=inputs)
            return account, token_id

        fx = base.fx
        usd, tka, tkb = base.usd, base.tka, base.tkb
        account, owner = case.owner('fixture permit2 create')
        fx.mint(usd, owner, 10**22)
        run('create-permit2', {'chainId': 8453, 'action': 'create', 'consent': 'permit2', 'pool': base.p1,
                               'tickLower': -1200, 'tickUpper': 1200,
                               'inputs': [{'token': usd, 'amountRaw': str(10**21)}], 'slippageBps': 50}, account)
        account, token_id = position('fixture increase', [{'token': usd, 'amountRaw': str(10**20)},
                                                          {'token': tka, 'amountRaw': str(10**20)}])
        fx.mint(tka, account.address.lower(), 10**21)
        run('increase-direct', {'chainId': 8453, 'action': 'increase', 'consent': 'direct',
                                'position': {'dex': 4, 'tokenId': str(token_id)},
                                'inputs': [{'token': tka, 'amountRaw': str(5 * 10**20)}]}, account)
        account, token_id = position('fixture change range', [{'token': usd, 'amountRaw': str(3 * 10**20)},
                                                              {'token': tka, 'amountRaw': str(10**20)}])
        run('change-range-direct', {'chainId': 8453, 'action': 'changeRange', 'consent': 'direct',
                                    'position': {'dex': 4, 'tokenId': str(token_id)}, 'tickLower': 600,
                                    'tickUpper': 3000, 'liquidityToRemove': 'all', 'burn': True}, account)
        account, token_id = position('fixture exit', [{'token': usd, 'amountRaw': str(2 * 10**20)},
                                                      {'token': tka, 'amountRaw': str(2 * 10**20)}])
        run('exit-converted-direct', {'chainId': 8453, 'action': 'exit', 'consent': 'direct',
                                      'position': {'dex': 4, 'tokenId': str(token_id)}, 'liquidityToRemove': 'all',
                                      'burn': True, 'receive': {'mode': 'converted', 'token': usd}}, account)
        run('exit-relayed', {'chainId': 8453, 'action': 'exit', 'consent': 'relayed',
                             'position': {'dex': 4, 'tokenId': str(token_id)}, 'liquidityToRemove': 'all',
                             'burn': False, 'receive': {'mode': 'both'}}, account)
        account, owner = case.owner('fixture native')
        run('create-native-direct', {'chainId': 8453, 'action': 'create', 'consent': 'direct', 'pool': base.p2,
                                     'tickLower': 75000, 'tickUpper': 76980,
                                     'inputs': [{'token': '0x' + '00' * 20, 'amountRaw': str(10**18)}]}, account)
        account, owner = case.owner('fixture new pool')
        fx.mint(usd, owner, 10**22)
        c0, c1 = sorted((tkb, usd))
        run('create-new-pool-direct', {'chainId': 8453, 'action': 'create', 'consent': 'direct',
                                       'pool': {'dex': 4, 'currency0': c0, 'currency1': c1, 'fee': 10000,
                                                'tickSpacing': 200, 'hooks': '0x' + '00' * 20},
                                       'tickLower': -4000, 'tickUpper': 4000,
                                       'inputs': [{'token': usd, 'amountRaw': str(10**21)}],
                                       'initialPrice': {'price': '1.25', 'baseToken': tkb, 'decimals0': 18,
                                                        'decimals1': 18}}, account)
        account, owner = case.owner('fixture v3 split')
        fx.mint(usd, owner, 10**22)
        run('create-split-v4', {'chainId': 8453, 'action': 'create', 'consent': 'direct', 'pool': base.p4,
                                'tickLower': -500, 'tickUpper': 500,
                                'inputs': [{'token': usd, 'amountRaw': str(10**21)}]}, account)
        if robinhood_rpc:
            # Robinhood (Nitro): the plan's own call priced by the own node's NodeInterface.
            account = router.local.account('fixture robinhood create')
            router.fx.mint(router.usd, account.address.lower(), 10**22)
            run('create-robinhood-direct', {'chainId': 4663, 'action': 'create', 'consent': 'direct',
                                            'pool': router.own, 'tickLower': -1200, 'tickUpper': 1200,
                                            'inputs': [{'token': router.usd, 'amountRaw': str(10**21)}]}, account)
            scenario = out['scenarios']['create-robinhood-direct']
            exchange = _node_interface_exchange(scenario)
            call = exchange['request']['params'][0]
            answers = json.loads(NITRO_ANSWERS.read_text()) if NITRO_ANSWERS.exists() else {}
            answers['robinhood-4663'] = capture_node_interface(robinhood_rpc, 4663, call, 'the own Robinhood node')
            exchange['response']['result'] = answers['robinhood-4663']['result']
            scenario['nodeInterface'] = {key: answers['robinhood-4663'][key]
                                         for key in ('source', 'chainId', 'block', 'blockHash')}
            if arbitrum_rpc:
                answers['arbitrum-42161'] = capture_node_interface(arbitrum_rpc, 42161, call,
                                                                   'Arbitrum One public RPC, read only')
            NITRO_ANSWERS.write_text(json.dumps(answers, indent=1, sort_keys=True) + '\n')
        else:
            out['scenarios']['create-robinhood-direct'] = previous['scenarios']['create-robinhood-direct']
        RECORDINGS.parent.mkdir(parents=True, exist_ok=True)
        RECORDINGS.write_text(json.dumps(out, indent=0, sort_keys=True) + '\n')
        print(f'Recorded {len(out["scenarios"])} scenarios to {RECORDINGS}')
    finally:
        base.doClassCleanups()
        if robinhood_rpc:
            router.doClassCleanups()


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='position-plan-v1 fixtures')
    parser.add_argument('--record', action='store_true')
    parser.add_argument('--robinhood-rpc', help='the own Robinhood node (never the public RPC)')
    parser.add_argument('--arbitrum-rpc')
    args = parser.parse_args()
    if args.record:
        record(robinhood_rpc=args.robinhood_rpc, arbitrum_rpc=args.arbitrum_rpc)
    else:
        print(__doc__)
