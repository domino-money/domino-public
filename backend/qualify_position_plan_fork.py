"""Qualify the S1 plan API on a fork of a chain where V2 is deployed (docs/v2/V2_S1_PLAN_API.md).

Forks the chain from a loopback JSON-RPC port (for Robinhood, the own node's SSH-forwarded port) and loads the
chain's verified production manifest. The production planner (`v2_position_plan.PositionPlanner`) then makes one
plan of each kind on real pools, with the deployed zaps, registry and fee rule:

  v4: create with a swap (direct, and through a Permit2 signature sent by someone else), create with native ETH,
      increase, change range, exit to both tokens, exit converted to one token, a relayed exit, and a new pool
      created at the owner's price;
  v3: create with a swap, increase, change range and exit converted, when the chain has a v3 pool for the pair.

Each plan must pass the closed response contract. A synthetic owner then executes it on the fork: Anvil
impersonation, with ETH from Anvil and USDG from the v4 pool manager. The receipt must be the plan:
- the action and the owner's intent hash;
- every swap leg's input, and its output exactly as planned;
- the 0.65% fee by the zap's own rule;
- the liquidity added;
- what returned to the wallet.

Once, for the first plan executed, the live node answers NodeInterface's L1 component for the plan's own
transaction. That is a read at the upstream, never a send: Anvil has no NodeInterface, so on the fork the plan
reports its L1 data fee as unavailable. One more plan is made against the live node itself, for an account that
holds ETH there (the deployer by default), so its quotes and its eth_simulateV1 run on the node, not on Anvil. It
is never sent.

Not covered: router legs from the Uniswap Trading API (they need the owner's key), and the Worker, session and
Access checks in front of the listener (the bridge's side). Nothing is signed by a real key. No provider credential
enters this process, which accepts only a loopback upstream, and the fork is discarded.

    python -B backend/qualify_position_plan_fork.py --upstream http://127.0.0.1:18547 --out <report.json>
"""
import argparse
import hashlib
import json
import random
import re
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from eth_abi import decode, encode
from eth_account import Account
from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parent))
import local_anvil  # noqa: E402
import v2_fee_rule as fee_rule  # noqa: E402
import v2_l1_fee as l1_fee  # noqa: E402
import v2_plan_codec as codec  # noqa: E402
from discovery import DataError, parse_block  # noqa: E402
from v2_chains import default_registry  # noqa: E402
from v2_head import Head  # noqa: E402
from v2_manifest import load_deployment  # noqa: E402
from v2_position_plan import PlanError, PositionPlanner  # noqa: E402
from v2_position_plan_models import CONTRACT_VERSION, PlanRequest, PlanResponse  # noqa: E402
from v2_rpc import ChainEndpoints, ChainReadRpc, Endpoint  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
MANIFESTS = {'robinhood-4663': ROOT / 'docs/deployments/v2-robinhood-4663-2026-10-04/deployment.json'}
ZERO = '0x' + '00' * 20
USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
# The chain's two deepest v4 pools for the pair (qualify_deposit_fork.POOLS): WETH/USDG and native ETH/USDG.
V4_POOLS = {'weth-usdg': {'dex': 4, 'currency0': WETH, 'currency1': USDG, 'fee': 200, 'tickSpacing': 4, 'hooks': ZERO},
            'eth-usdg': {'dex': 4, 'currency0': ZERO, 'currency1': USDG, 'fee': 87, 'tickSpacing': 1, 'hooks': ZERO}}
V3_SPACING = {100: 1, 500: 10, 3000: 60, 10000: 200}
NEW_POOL_TIERS = ((10000, 200), (5000, 100), (2500, 50), (7000, 140))
TOPICS = {name: '0x' + keccak(signature.encode()).hex() for name, signature in {
    'PositionActionExecuted': 'PositionActionExecuted(uint8,address,uint256,uint256,uint128,bytes32)',
    'FeeCharged': 'FeeCharged(uint8,address,address,uint256,bytes32)',
    'SwapLegExecuted': 'SwapLegExecuted(uint8,address,address,address,uint256,uint256)',
    'Refunded': 'Refunded(address,address,uint256)'}.items()}
LOOPBACK = re.compile(r'^http://127\.0\.0\.1:([1-9][0-9]{0,4})/?$')


class QualificationError(Exception):
    pass


def loopback(url):
    """The upstream: a loopback port only, so no provider credential can be in it."""
    match = LOOPBACK.match(url or '')
    if not match or not 1 <= int(match.group(1)) <= 65535:
        raise QualificationError('upstream_must_be_loopback')
    return url.rstrip('/')


def around(tick, spacing, width):
    """A range of about ±width ticks around `tick`, on the pool's spacing."""
    return (tick - width) // spacing * spacing, -((-(tick + width)) // spacing) * spacing


def topic_address(topic):
    return '0x' + topic[-40:]


def events(receipt, name):
    return [log for log in receipt['logs'] if log['topics'][0] == TOPICS[name]]


def refunds(receipt):
    total = {}
    for log in events(receipt, 'Refunded'):
        amount, = decode(['uint256'], bytes.fromhex(log['data'][2:]))
        if amount:
            token = topic_address(log['topics'][2])
            total[token] = total.get(token, 0) + amount
    return total


def check_receipt(body, receipt):
    """The receipt against the plan; each failed check by name (empty when it is the plan)."""
    failed = []

    def need(condition, name):
        if not condition:
            failed.append(name)
    need(receipt.get('status') == '0x1', 'reverted')
    executed = events(receipt, 'PositionActionExecuted')
    need(len(executed) == 1, 'one_action_event')
    if failed:
        return failed, None
    log = executed[0]
    need(int(log['topics'][1], 16) == codec.ACTIONS[body['action']], 'action')
    need(topic_address(log['topics'][2]) == body['owner'], 'owner')
    _, liquidity, intent_hash = decode(['uint256', 'uint128', 'bytes32'], bytes.fromhex(log['data'][2:]))
    need('0x' + intent_hash.hex() == body['intentHash'], 'intent_hash')
    swaps = events(receipt, 'SwapLegExecuted')
    need(len(swaps) == len(body['legs']), 'leg_count')
    outs = []
    for swap, leg in zip(swaps, body['legs']):
        amount_in, amount_out = decode(['address', 'uint256', 'uint256'], bytes.fromhex(swap['data'][2:]))[1:]
        need(str(amount_in) == leg['amountInRaw'], 'leg_input')
        need(str(amount_out) == leg['expectedOutRaw'], 'leg_output_as_planned')
        need(amount_out >= int(leg['minAmountOutRaw']), 'leg_minimum')
        outs.append(amount_out)
    charged = events(receipt, 'FeeCharged')
    if body['legs']:
        need(len(charged) == 1, 'one_fee')
        if len(charged) == 1:
            amount, ref = decode(['uint256', 'bytes32'], bytes.fromhex(charged[0]['data'][2:]))
            rows = [fee_rule.LegTokens(l['tokenIn'], l['tokenOut'], int(l['amountInRaw'])) for l in body['legs']]
            need(topic_address(charged[0]['topics'][2]) == body['fee']['token'], 'fee_token')
            need(amount == fee_rule.fee_of(fee_rule.swapped_amount(rows, outs, body['fee']['token']), 65), 'fee_rule')
            need(str(amount) == body['fee']['amountRaw'], 'fee_as_planned')
            need('0x' + ref.hex() == body['intentHash'], 'fee_reference')
    else:
        need(charged == [], 'no_fee_without_swap')
    if body['action'] != 'exit':
        need(liquidity >= int(body['minimums']['liquidity']), 'liquidity_minimum')
        need(str(liquidity) == body['expected']['liquidity'], 'liquidity_as_planned')
    returned = refunds(receipt)
    if body['action'] == 'exit' and not body['legs']:
        need(returned == {}, 'exit_paid_by_the_manager')
    else:
        need(returned == {item['token']: int(item['amountRaw']) for item in body['expected']['returned']},
             'returned_as_planned')
    return failed, int(log['topics'][3], 16)


class Fork:
    """A discarded Anvil fork of the upstream, at its head."""

    def __init__(self, upstream, chain_id):
        self.upstream, self.chain_id = upstream, chain_id
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            self.port = probe.getsockname()[1]
        self.url = f'http://127.0.0.1:{self.port}'
        self.process = None

    def __enter__(self):
        self.process = local_anvil.start(['--fork-url', self.upstream, '--chain-id', str(self.chain_id),
                                          '--port', str(self.port), '--host', '127.0.0.1', '--no-storage-caching'],
                                         root=ROOT)
        for _ in range(240):
            try:
                if int(self.request('eth_chainId'), 16) == self.chain_id:
                    return self
            except (OSError, QualificationError):
                pass
            time.sleep(0.5)
        raise QualificationError('fork_start_failed')

    def __exit__(self, *exc):
        if self.process is not None:
            local_anvil.stop(self.process)

    def post(self, body, url=None):
        request = urllib.request.Request(url or self.url, json.dumps(body).encode(), {'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.load(response)

    def request(self, method, params=(), url=None):
        answer = self.post({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': list(params)}, url)
        if 'error' in answer:
            raise QualificationError(f"{method}: {answer['error'].get('message', 'error')}")
        return answer['result']

    def call(self, to, data, block='latest'):
        return self.request('eth_call', [{'to': to, 'data': data}, block])

    def send(self, sender, to, data, value=0):
        self.request('anvil_impersonateAccount', [sender])
        try:
            tx = self.request('eth_sendTransaction', [{'from': sender, 'to': to, 'data': data, 'value': hex(value)}])
            for attempt in range(120):
                receipt = self.request('eth_getTransactionReceipt', [tx])
                if receipt:
                    return receipt
                if attempt == 2:
                    self.request('evm_mine')
                time.sleep(0.25)
            raise QualificationError('receipt_unavailable')
        finally:
            self.request('anvil_stopImpersonatingAccount', [sender])


class ForkHead:
    def __init__(self, fork):
        self.fork = fork

    def head(self):
        return Head(self.fork.chain_id, parse_block(self.fork.request('eth_getBlockByNumber', ['latest', False])),
                    None, time.time())


class Qualification:
    def __init__(self, fork, profile_key):
        self.fork, self.profile = fork, default_registry().chain(profile_key)
        manifest = MANIFESTS[profile_key]
        self.manifest_sha256 = hashlib.sha256(manifest.read_bytes()).hexdigest()
        self.dependencies = json.loads(manifest.read_text())['dependencies']
        self.deployment = load_deployment(manifest, self.profile, admission='production')
        endpoint = Endpoint('local', 'anvil.invalid', 'https://anvil.invalid/', None, 100, None, None)
        self.endpoints = ChainEndpoints(self.profile, (endpoint,), 'fork', send=lambda _url, body: fork.post(body))
        self.planner = PositionPlanner(self.profile, self.endpoints, ForkHead(fork), self.deployment,
                                       clock=time.time, nonce_word=lambda: random.SystemRandom().getrandbits(248))
        self.journeys, self.live_l1 = [], None
        self.submitter = Account.create().address.lower()
        fork.request('anvil_setBalance', [self.submitter, hex(10**19)])

    # ------------------------------------------------------------ chain reads
    def v4_slot0(self, pool):
        pool_id = keccak(encode(['address', 'address', 'uint24', 'int24', 'address'],
                                [pool['currency0'], pool['currency1'], pool['fee'], pool['tickSpacing'], pool['hooks']]))
        raw = self.fork.call(self.dependencies['v4StateView'], '0xc815641c' + pool_id.hex())
        return decode(['uint160', 'int24', 'uint24', 'uint24'], bytes.fromhex(raw[2:]))[:2]

    def v3_pool(self, a, b):
        """The deepest initialized v3 pool for the pair, or None."""
        best = None
        for fee, spacing in V3_SPACING.items():
            raw = self.fork.call(self.dependencies['v3Factory'],
                                 '0x1698ee82' + encode(['address', 'address', 'uint24'], [a, b, fee]).hex())
            address = '0x' + raw[-40:]
            if int(address, 16) == 0:
                continue
            liquidity, = decode(['uint128'], bytes.fromhex(self.fork.call(address, '0x1a686502')[2:]))
            if liquidity and (best is None or liquidity > best[0]):
                _, tick = decode(['uint160', 'int24'], bytes.fromhex(self.fork.call(address, '0x3850c7bd')[2:130]))
                c0, c1 = sorted((a, b))
                best = (liquidity, {'dex': 3, 'currency0': c0, 'currency1': c1, 'fee': fee, 'tickSpacing': spacing,
                                    'hooks': ZERO}, tick)
        return best

    # ----------------------------------------------------------------- owner
    def owner(self, usdg):
        account = Account.create()
        address = account.address.lower()
        self.fork.request('anvil_setBalance', [address, hex(10**20)])
        if usdg:
            manager = self.dependencies['v4PoolManager']
            self.fork.request('anvil_setBalance', [manager, hex(10**18)])
            receipt = self.fork.send(manager, USDG, '0xa9059cbb' + encode(['address', 'uint256'], [address, usdg]).hex())
            if receipt.get('status') != '0x1':
                raise QualificationError('owner_funding_failed')
        return account, address

    # ------------------------------------------------------------- one plan
    def run(self, name, request, account, *, sender=None):
        owner = account.address.lower()
        entry = {'name': name, 'request': {k: v for k, v in request.items() if k != 'chainId'}}
        started = time.time()
        calls_before = sum(self.endpoints.calls().values())
        try:
            body = self.planner.plan(PlanRequest.model_validate(request).model_dump(), owner)
            PlanResponse.model_validate({'contractVersion': CONTRACT_VERSION, 'plan': body})
        except PlanError as error:
            entry.update(ok=False, failed=[f'plan_refused:{error.code}'])
            self.journeys.append(entry)
            return None
        entry.update(planSeconds=round(time.time() - started, 2),
                     planCalls=sum(self.endpoints.calls().values()) - calls_before,
                     consent=body['consent'], legs=[{'source': leg.get('source'), 'tokenIn': leg['tokenIn'],
                                                      'tokenOut': leg['tokenOut'], 'amountInRaw': leg['amountInRaw'],
                                                      'expectedOutRaw': leg['expectedOutRaw']} for leg in body['legs']],
                     fee=body['fee'], simulation=body['simulation']['status'], l1DataFee=body['l1DataFee']['status'],
                     steps=[step['kind'] for step in body['readiness']['steps']])
        for step in body['readiness']['steps'][:-1]:
            if step['kind'] in ('approve_token', 'approve_position'):
                receipt = self.fork.send(owner, step['to'], step['data'])
                if receipt.get('status') != '0x1':
                    entry.update(ok=False, failed=[f"step_reverted:{step['kind']}"])
                    self.journeys.append(entry)
                    return None
        call = body['call']
        if body['consent'] == 'direct':
            data = call['data']
        else:
            signed = Account.sign_typed_data(account.key, full_message=body['signature']['typedData'])
            if '0x' + signed.message_hash.hex().removeprefix('0x') != body['signature']['digest']:
                entry.update(ok=False, failed=['signature_digest'])
                self.journeys.append(entry)
                return None
            data = codec.call_data(body['action'], body['consent'], body['zapPlan'], permit=body['signature'].get('permit'),
                                   signature='0x' + signed.signature.hex().removeprefix('0x'))
        if self.live_l1 is None:
            self.live_l1 = self.l1_on_the_live_node(call['to'], data)
        receipt = self.fork.send(sender or owner, call['to'], data, int(call['valueRaw']))
        failed, token_id = check_receipt(body, receipt)
        entry.update(ok=not failed, failed=failed, gasUsed=int(receipt['gasUsed'], 16), tokenId=str(token_id),
                     sentBy='submitter' if sender else 'owner')
        self.journeys.append(entry)
        return token_id

    def l1_on_the_live_node(self, to, data):
        """NodeInterface's L1 component for this transaction, read at the upstream (the live node)."""
        if self.profile.stack != 'arbitrum-nitro':
            return {'status': 'not_nitro'}
        block = parse_block(self.fork.request('eth_getBlockByNumber', ['latest', False], url=self.fork.upstream))
        endpoint = Endpoint('local', 'node.invalid', 'https://node.invalid/', None, 100, None, None)
        live = ChainEndpoints(self.profile, (endpoint,), 'upstream',
                              send=lambda _url, body: self.fork.post(body, self.fork.upstream))
        try:
            return l1_fee.nitro_estimate(self.profile, ChainReadRpc(live, anchor=block, max_requests=2), block, to, data)
        except DataError as error:
            return {'status': 'unavailable', 'reason': str(error)}

    # -------------------------------------------------------------- journeys
    def journeys_v4(self):
        weth_usdg, eth_usdg = V4_POOLS['weth-usdg'], V4_POOLS['eth-usdg']
        _, tick = self.v4_slot0(weth_usdg)
        lower, upper = around(tick, 4, 2000)
        account, owner = self.owner(1_000 * 10**6)
        created = self.run('v4 create with a swap (direct)', {
            'chainId': self.profile.chainId, 'action': 'create', 'consent': 'direct', 'pool': weth_usdg,
            'tickLower': lower, 'tickUpper': upper, 'inputs': [{'token': USDG, 'amountRaw': str(100 * 10**6)}]}, account)
        signer, _ = self.owner(1_000 * 10**6)
        permitted = self.run('v4 create through Permit2, sent by another account', {
            'chainId': self.profile.chainId, 'action': 'create', 'consent': 'permit2', 'pool': weth_usdg,
            'tickLower': lower, 'tickUpper': upper, 'inputs': [{'token': USDG, 'amountRaw': str(100 * 10**6)}]},
            signer, sender=self.submitter)
        _, eth_tick = self.v4_slot0(eth_usdg)
        native_account, _ = self.owner(0)
        native = self.run('v4 create with native ETH', {
            'chainId': self.profile.chainId, 'action': 'create', 'consent': 'direct', 'pool': eth_usdg,
            'tickLower': around(eth_tick, 1, 2000)[0], 'tickUpper': around(eth_tick, 1, 2000)[1],
            'inputs': [{'token': ZERO, 'amountRaw': str(5 * 10**16)}]}, native_account)
        if created:
            self.run('v4 increase with a swap', {
                'chainId': self.profile.chainId, 'action': 'increase', 'consent': 'direct',
                'position': {'dex': 4, 'tokenId': str(created)},
                'inputs': [{'token': USDG, 'amountRaw': str(50 * 10**6)}]}, account)
            moved = self.run('v4 change range', {
                'chainId': self.profile.chainId, 'action': 'changeRange', 'consent': 'direct',
                'position': {'dex': 4, 'tokenId': str(created)}, 'tickLower': around(tick, 4, 1000)[0],
                'tickUpper': around(tick, 4, 3000)[1], 'liquidityToRemove': 'all', 'burn': True}, account)
            if moved:
                self.run('v4 relayed exit, converted to WETH', {
                    'chainId': self.profile.chainId, 'action': 'exit', 'consent': 'relayed',
                    'position': {'dex': 4, 'tokenId': str(moved)}, 'liquidityToRemove': 'all', 'burn': True,
                    'receive': {'mode': 'converted', 'token': WETH}}, account, sender=self.submitter)
        if permitted:
            self.run('v4 exit converted to USDG', {
                'chainId': self.profile.chainId, 'action': 'exit', 'consent': 'direct',
                'position': {'dex': 4, 'tokenId': str(permitted)}, 'liquidityToRemove': 'all', 'burn': True,
                'receive': {'mode': 'converted', 'token': USDG}}, signer)
        if native:
            self.run('v4 exit to both tokens', {
                'chainId': self.profile.chainId, 'action': 'exit', 'consent': 'direct',
                'position': {'dex': 4, 'tokenId': str(native)}, 'liquidityToRemove': 'all', 'burn': False,
                'receive': {'mode': 'both'}}, native_account)
        self.new_pool(weth_usdg)

    def new_pool(self, existing):
        """A WETH/USDG v4 pool at a tier nobody initialized, at the existing pool's price (USDG per WETH)."""
        sqrt_price, tick = self.v4_slot0(existing)
        price = (sqrt_price / 2**96) ** 2 * 10 ** (18 - 6)
        for fee, spacing in NEW_POOL_TIERS:
            pool = {**existing, 'fee': fee, 'tickSpacing': spacing}
            if self.v4_slot0(pool)[0] == 0:
                break
        else:
            self.journeys.append({'name': 'v4 new pool at the owner\'s price', 'ok': False,
                                  'failed': ['no_uninitialized_tier']})
            return
        account, _ = self.owner(1_000 * 10**6)
        self.run("v4 new pool at the owner's price", {
            'chainId': self.profile.chainId, 'action': 'create', 'consent': 'direct', 'pool': pool,
            'tickLower': around(tick, spacing, 4000)[0], 'tickUpper': around(tick, spacing, 4000)[1],
            'inputs': [{'token': USDG, 'amountRaw': str(100 * 10**6)}],
            'initialPrice': {'price': f'{price:.6f}', 'baseToken': WETH, 'decimals0': 18, 'decimals1': 6}}, account)

    def live_plan(self, owner):
        """A native ETH create planned on the live node itself (quotes and eth_simulateV1 there); never sent."""
        endpoint = Endpoint('local', 'node.invalid', 'https://node.invalid/', None, 100, None, None)
        live = ChainEndpoints(self.profile, (endpoint,), 'upstream',
                              send=lambda _url, body: self.fork.post(body, self.fork.upstream))

        class LiveHead:
            def head(inner):
                raw = self.fork.request('eth_getBlockByNumber', ['latest', False], url=self.fork.upstream)
                return Head(self.fork.chain_id, parse_block(raw), None, time.time())
        planner = PositionPlanner(self.profile, live, LiveHead(), self.deployment, clock=time.time,
                                  nonce_word=lambda: random.SystemRandom().getrandbits(248))
        pool = V4_POOLS['eth-usdg']
        _, tick = self.v4_slot0(pool)
        request = {'chainId': self.profile.chainId, 'action': 'create', 'consent': 'direct', 'pool': pool,
                   'tickLower': around(tick, 1, 2000)[0], 'tickUpper': around(tick, 1, 2000)[1],
                   'inputs': [{'token': ZERO, 'amountRaw': str(10**15)}]}
        entry = {'name': 'live node: plan only (quotes and eth_simulateV1 on the node), never sent',
                 'request': {k: v for k, v in request.items() if k != 'chainId'}, 'owner': owner}
        started = time.time()
        try:
            body = planner.plan(PlanRequest.model_validate(request).model_dump(), owner)
            PlanResponse.model_validate({'contractVersion': CONTRACT_VERSION, 'plan': body})
        except PlanError as error:
            entry.update(ok=False, failed=[f'plan_refused:{error.code}'])
        else:
            entry.update(ok=body['simulation']['status'] == 'ok', planSeconds=round(time.time() - started, 2),
                         planCalls=sum(live.calls().values()), consent=body['consent'],
                         legs=[{'source': leg.get('source'), 'amountInRaw': leg['amountInRaw'],
                                'expectedOutRaw': leg['expectedOutRaw']} for leg in body['legs']],
                         fee=body['fee'], simulation=body['simulation']['status'], l1DataFee=body['l1DataFee'],
                         failed=[] if body['simulation']['status'] == 'ok' else ['simulation_not_ok'])
        self.journeys.append(entry)

    def journeys_v3(self):
        found = self.v3_pool(WETH, USDG)
        if found is None:
            self.journeys.append({'name': 'v3 journeys', 'ok': True, 'skipped': 'no initialized v3 WETH/USDG pool'})
            return
        _, pool, tick = found
        account, _ = self.owner(1_000 * 10**6)
        spacing = pool['tickSpacing']
        created = self.run('v3 create with a swap', {
            'chainId': self.profile.chainId, 'action': 'create', 'consent': 'direct', 'pool': pool,
            'tickLower': around(tick, spacing, 3000)[0], 'tickUpper': around(tick, spacing, 3000)[1],
            'inputs': [{'token': USDG, 'amountRaw': str(100 * 10**6)}]}, account)
        if not created:
            return
        self.run('v3 increase', {
            'chainId': self.profile.chainId, 'action': 'increase', 'consent': 'direct',
            'position': {'dex': 3, 'tokenId': str(created)}, 'inputs': [{'token': USDG, 'amountRaw': str(50 * 10**6)}]},
            account)
        moved = self.run('v3 change range', {
            'chainId': self.profile.chainId, 'action': 'changeRange', 'consent': 'direct',
            'position': {'dex': 3, 'tokenId': str(created)}, 'tickLower': around(tick, spacing, 1500)[0],
            'tickUpper': around(tick, spacing, 4500)[1], 'liquidityToRemove': 'all', 'burn': True}, account)
        if moved:
            self.run('v3 exit converted to USDG', {
                'chainId': self.profile.chainId, 'action': 'exit', 'consent': 'direct',
                'position': {'dex': 3, 'tokenId': str(moved)}, 'liquidityToRemove': 'all', 'burn': True,
                'receive': {'mode': 'converted', 'token': USDG}}, account)


def source_commit():
    try:
        return subprocess.run(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], capture_output=True, text=True,
                              check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--upstream', required=True, help='loopback JSON-RPC of the chain (the own node for Robinhood)')
    parser.add_argument('--chain', default='robinhood-4663', choices=sorted(MANIFESTS))
    parser.add_argument('--out', required=True, type=Path, help='the report, written once (never overwritten)')
    parser.add_argument('--live-owner', help='an account holding ETH on the chain, for the live plan (default: '
                        'the deployment\'s deployer)')
    args = parser.parse_args(argv)
    try:
        upstream = loopback(args.upstream)
        if args.out.exists():
            raise QualificationError('report_exists')
        profile = default_registry().chain(args.chain)
        with Fork(upstream, profile.chainId) as fork:
            block = int(fork.request('eth_blockNumber'), 16)
            qualification = Qualification(fork, args.chain)
            qualification.journeys_v4()
            qualification.journeys_v3()
            owner = (args.live_owner or json.loads(MANIFESTS[args.chain].read_text())['roles']['deployer']).lower()
            if not re.fullmatch('0x[0-9a-f]{40}', owner):
                raise QualificationError('invalid_live_owner')
            qualification.live_plan(owner)
        failed = [j['name'] for j in qualification.journeys if not j.get('ok')]
        report = {'schemaVersion': 1, 'kind': 'domino-v2-position-plan-fork-qualification', 'chain': args.chain,
                  'contractVersion': CONTRACT_VERSION, 'sourceCommit': source_commit(),
                  'manifestSha256': qualification.manifest_sha256, 'forkBlock': block, 'upstream': 'loopback',
                  'checkedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                  'liveL1DataFee': qualification.live_l1, 'journeys': qualification.journeys,
                  'passed': len(qualification.journeys) - len(failed), 'failed': failed}
        with open(args.out, 'x') as stream:
            json.dump(report, stream, indent=1)
            stream.write('\n')
        print(json.dumps({'ok': not failed, 'passed': report['passed'], 'failed': failed, 'report': str(args.out)}))
        return 0 if not failed else 1
    except (QualificationError, DataError, OSError) as error:
        print(json.dumps({'ok': False, 'reason': str(error) or type(error).__name__}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
