"""S1 plans executed end to end on a local chain with the real zap and real Uniswap code.

Every journey asks the planner for a plan, checks the answer against the
closed contract (models and rules), does the wallet's steps the answer lists
(exact approvals, the NFT's approval to the zap), signs the typed data with the
owner's key when the consent path needs it, sends the zap call, and compares
the receipt with the plan: the liquidity minted, the fee charged (FeeCharged),
the swaps (SwapLegExecuted) and the refunds.

Chains (tests/v2_s1_chain.py): `vendored` runs the vendored official v4 core
and periphery (contracts/out) and Base's deployed v3 code; `deployed` runs
Base's deployed v3 and v4 bytecode at Base's addresses (F1c's fixtures) with
the real Base chain profile. The Domino contracts are deployed by that test
fixture, not by #301's deploy-local.mjs, whose offline mode has synthetic
Uniswap code that cannot swap.

FeeRuleParityEvmTests runs the Python fee rule (v2_fee_rule) against the
deployed zap's own DominoFeeRules over random routes and ranks: the zap
accepts the Python selection and refuses every other token with FeeMismatch.

Run after the contract build with DOMINO_TEST_EVM=1.
"""
import json
import os
from pathlib import Path
import random
import sys
import time
from types import SimpleNamespace
import unittest
from unittest import mock

from eth_abi import decode, encode
from eth_account import Account
from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from discovery import parse_block  # noqa: E402
import v2_fee_rule as fee_rule  # noqa: E402
import v2_l1_fee as l1_fee  # noqa: E402
import v2_liquidity as liq  # noqa: E402
import v2_plan_codec as codec  # noqa: E402
from v2_head import Head  # noqa: E402
import v2_position_plan  # noqa: E402
from v2_position_plan import PlanError, PositionPlanner, decode_revert  # noqa: E402
from v2_position_plan_models import CONTRACT_VERSION, PlanRequest, PlanResponse  # noqa: E402
from v4_math import tick_at_sqrt  # noqa: E402

EVM = os.environ.get('DOMINO_TEST_EVM') == '1'
L1_FEE = Path(__file__).resolve().parent / 'fixtures/v2-base-l1-fee.json'
ZERO = '0x' + '00' * 20
PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
U128 = 2**128 - 1
Q96 = 1 << 96
TOPICS = {name: '0x' + keccak(signature.encode()).hex() for name, signature in {
    'PositionActionExecuted': 'PositionActionExecuted(uint8,address,uint256,uint256,uint128,bytes32)',
    'FeeCharged': 'FeeCharged(uint8,address,address,uint256,bytes32)',
    'SwapLegExecuted': 'SwapLegExecuted(uint8,address,address,address,uint256,uint256)',
    'Refunded': 'Refunded(address,address,uint256)',
    'InputPulled': 'InputPulled(bytes32,address,address,uint256)'}.items()}


def liq_pool_id(pool):
    """The v4 pool id of a pool dict: keccak of its PoolKey."""
    return '0x' + keccak(encode(['address', 'address', 'uint24', 'int24', 'address'],
                                [pool['currency0'], pool['currency1'], pool['fee'], pool['tickSpacing'],
                                 pool['hooks']])).hex()


def topic_address(topic):
    return '0x' + topic[-40:]


class LatestHead:
    """The planner's head: the local chain's latest block, read on demand."""

    def __init__(self, chain):
        self.chain = chain

    def head(self):
        raw = self.chain.request('eth_getBlockByNumber', ['latest', False])
        return Head(self.chain.chain_id, parse_block(raw), None, time.time())


def shifted(sqrt_price, slippage, half_steps):
    """The sqrt price of the price × (1 + half_steps × s / 2): band_sqrt_price past the band."""
    from math import isqrt
    return isqrt(sqrt_price * sqrt_price * (20_000 + half_steps * slippage) // 20_000)


def events(receipt, name):
    return [log for log in receipt['logs'] if log['topics'][0] == TOPICS[name]]


def refunds(receipt):
    """Token -> amount of the receipt's nonzero Refunded events."""
    total = {}
    for log in events(receipt, 'Refunded'):
        amount, = decode(['uint256'], bytes.fromhex(log['data'][2:]))
        if amount:
            token = topic_address(log['topics'][2])
            total[token] = total.get(token, 0) + amount
    return total


@unittest.skipUnless(EVM, 'requires isolated local Anvil')
class S1JourneyEvmTests(unittest.TestCase):
    FLAVOR = 'vendored'

    @classmethod
    def setUpClass(cls):
        from v2_s1_chain import S1Fixture
        fx = cls.fx = S1Fixture(cls.FLAVOR)
        cls.addClassCleanup(fx.close)
        cls.local = fx.chain
        cls.usd, cls.tka, cls.tkb = fx.tokens(3)
        fx.deploy_domino([(cls.usd, 1), (ZERO, 2), (fx.weth, 2)])
        cls.deployment = fx.deployment
        cls.planner = PositionPlanner(fx.profile, fx.endpoints(), LatestHead(cls.local), cls.deployment,
                                      clock=time.time, nonce_word=lambda: 0x5151)
        cls.lp = cls.local.account('liquidity provider').address.lower()
        for token in (cls.usd, cls.tka, cls.tkb):
            fx.mint(token, cls.lp, 10**30)
            for zap in (fx.zap_v3, fx.zap_v4):
                fx.approve(cls.lp, token, zap, 2**256 - 1)
        cls.p1 = cls.seed(4, cls.tka, cls.usd, 3000, 60, Q96)
        cls.p2 = cls.seed(4, ZERO, cls.usd, 3000, 60, int(2000 ** 0.5 * Q96))
        cls.p3 = cls.seed(3, cls.tka, cls.usd, 3000, 60, Q96)
        cls.p4 = cls.seed(4, cls.tka, cls.tkb, 500, 10, Q96)
        cls.p5 = cls.seed(4, cls.tkb, cls.usd, 3000, 60, Q96)

    # ---------------------------------------------------------------- helpers
    @classmethod
    def seed(cls, dex, a, b, fee, spacing, sqrt_price):
        """A deep pool, created and seeded through the zap's own create with an initial price."""
        c0, c1 = sorted((a, b))
        pool = {'dex': dex, 'currency0': c0, 'currency1': c1, 'fee': fee, 'tickSpacing': spacing, 'hooks': ZERO}
        width = 887272 // spacing * spacing
        inputs = [{'token': token, 'amount': str(10**25 if token != ZERO else 10**23)} for token in (c0, c1)]
        intent = {'action': 1, 'pool': pool, 'tokenId': '0', 'tickLower': -width, 'tickUpper': width,
                  'minLiquidity': '1', 'feeBps': 0, 'feeToken': ZERO, 'routesHash': codec.routes_hash([]),
                  'recipient': cls.lp, 'nonce': '0', 'deadline': str(int(time.time()) + 3600)}
        plan = {'intent': intent, 'inputs': inputs, 'legs': [], 'amount0Max': str(U128), 'amount1Max': str(U128),
                'initSqrtPriceX96': str(sqrt_price)}
        zap = cls.fx.zap_v3 if dex == 3 else cls.fx.zap_v4
        if c0 == ZERO:
            cls.local.fund(cls.lp, 10**26)
        cls.local.send(cls.lp, zap, codec.call_data('create', 'direct', plan), codec.direct_value(plan))
        return pool

    def owner(self, label):
        account = self.local.account(label)
        return account, account.address.lower()

    def plan(self, request, owner):
        validated = PlanRequest.model_validate(request).model_dump()
        body = self.planner.plan(validated, owner)
        # The closed contract, models and rules, accepts it as the service would send it.
        PlanResponse.model_validate({'contractVersion': CONTRACT_VERSION, 'plan': body})
        return body

    def execute(self, body, account, *, sender=None):
        """The wallet's steps, then the action (signed when the path needs it)."""
        owner = account.address.lower()
        for step in body['readiness']['steps'][:-1]:
            if step['kind'] in ('approve_token', 'approve_position'):
                self.local.send(owner, step['to'], step['data'])
        call = body['call']
        if body['consent'] == 'direct':
            data = call['data']
        else:
            signed = Account.sign_typed_data(account.key, full_message=body['signature']['typedData'])
            self.assertEqual('0x' + signed.message_hash.hex().removeprefix('0x'), body['signature']['digest'])
            signature = '0x' + signed.signature.hex().removeprefix('0x')
            data = codec.call_data(body['action'], body['consent'], body['zapPlan'],
                                   permit=(body['signature']['permit']), signature=signature)
            self.assertEqual(data[:10], call['selector'])
        return self.local.send(sender or owner, call['to'], data, int(call['valueRaw']))

    def assertExecutedAsPlanned(self, body, receipt):
        """The receipt is the plan: action, fee, swaps and (when it adds) the liquidity."""
        executed, = events(receipt, 'PositionActionExecuted')
        self.assertEqual(int(executed['topics'][1], 16), codec.ACTIONS[body['action']])
        self.assertEqual(topic_address(executed['topics'][2]), body['owner'])
        _, liquidity, intent_hash = decode(['uint256', 'uint128', 'bytes32'], bytes.fromhex(executed['data'][2:]))
        self.assertEqual('0x' + intent_hash.hex(), body['intentHash'])
        swaps = events(receipt, 'SwapLegExecuted')
        self.assertEqual(len(swaps), len(body['legs']))
        outs = []
        for log, leg in zip(swaps, body['legs']):
            amount_in, amount_out = decode(['address', 'uint256', 'uint256'], bytes.fromhex(log['data'][2:]))[1:]
            self.assertEqual(str(amount_in), leg['amountInRaw'])
            self.assertGreaterEqual(amount_out, int(leg['minAmountOutRaw']))
            outs.append(amount_out)
        charged = events(receipt, 'FeeCharged')
        if body['legs']:
            charge, = charged
            self.assertEqual(topic_address(charge['topics'][2]), body['fee']['token'])
            amount, ref = decode(['uint256', 'bytes32'], bytes.fromhex(charge['data'][2:]))
            rows = [fee_rule.LegTokens(l['tokenIn'], l['tokenOut'], int(l['amountInRaw'])) for l in body['legs']]
            self.assertEqual(amount, fee_rule.fee_of(fee_rule.swapped_amount(rows, outs, body['fee']['token']), 65))
            self.assertEqual('0x' + ref.hex(), body['intentHash'])
            # Nothing else traded between the plan and the call: the swaps
            # delivered exactly what the plan expected, and so did the fee.
            self.assertEqual([str(o) for o in outs], [leg['expectedOutRaw'] for leg in body['legs']])
            self.assertEqual(str(amount), body['fee']['amountRaw'])
        else:
            self.assertEqual(charged, [])
        if body['action'] != 'exit':
            self.assertGreaterEqual(liquidity, int(body['minimums']['liquidity']))
            self.assertEqual(str(liquidity), body['expected']['liquidity'])
        if body['simulation']['status'] == 'ok':
            self.assertEqual(body['simulation']['result']['liquidity'], str(liquidity))
        # What returns to the wallet is what the plan said: the zap's refunds,
        # or, for an exit without legs, the position manager's own payment.
        refunded = refunds(receipt)
        if body['action'] == 'exit' and not body['legs']:
            self.assertEqual(refunded, {})
        else:
            self.assertEqual(refunded, {item['token']: int(item['amountRaw']) for item in body['expected']['returned']})
        return liquidity

    def new_position(self, label, pool, *, inputs, ticks=(-1200, 1200)):
        account, owner = self.owner(label)
        for item in inputs:
            self.fx.mint(item['token'], owner, int(item['amountRaw']) * 2)
        body = self.plan({'chainId': 8453, 'action': 'create', 'consent': 'direct', 'pool': pool,
                          'tickLower': ticks[0], 'tickUpper': ticks[1], 'inputs': inputs}, owner)
        receipt = self.execute(body, account)
        self.assertExecutedAsPlanned(body, receipt)
        executed, = events(receipt, 'PositionActionExecuted')
        return account, owner, int(executed['topics'][3], 16)

    # -------------------------------------------------------------- journeys
    def test_create_with_a_swap_signed_through_permit2(self):
        account, owner = self.owner('permit2 create')
        self.fx.mint(self.usd, owner, 10**22)
        body = self.plan({'chainId': 8453, 'action': 'create', 'consent': 'permit2', 'pool': self.p1,
                          'tickLower': -1200, 'tickUpper': 1200,
                          'inputs': [{'token': self.usd, 'amountRaw': str(10**21)}]}, owner)
        self.assertEqual((body['fee']['token'], body['fee']['place']), (self.usd, 'input'))
        self.assertEqual([s['kind'] for s in body['readiness']['steps']], ['approve_token', 'sign_permit2', 'send_action'])
        self.assertEqual(body['readiness']['approvals'][0]['spender'], PERMIT2)
        # Anyone may submit the signed plan; the NFT and refunds go to the signer.
        relayer = self.local.account('submitter').address.lower()
        receipt = self.execute(body, account, sender=relayer)
        self.assertExecutedAsPlanned(body, receipt)
        executed, = events(receipt, 'PositionActionExecuted')
        manager = self.fx.v4['positionManager']
        self.assertEqual(self.local.call(manager, 'ownerOf(uint256)', ['address'], ['uint256'],
                                         [int(executed['topics'][3], 16)])[0].lower(), owner)

    def test_increase_with_a_swap_direct(self):
        account, owner, token_id = self.new_position('increase', self.p1, inputs=[
            {'token': self.usd, 'amountRaw': str(10**20)}, {'token': self.tka, 'amountRaw': str(10**20)}])
        self.fx.mint(self.tka, owner, 10**21)
        body = self.plan({'chainId': 8453, 'action': 'increase', 'consent': 'direct',
                          'position': {'dex': 4, 'tokenId': str(token_id)},
                          'inputs': [{'token': self.tka, 'amountRaw': str(5 * 10**20)}]}, owner)
        kinds = [s['kind'] for s in body['readiness']['steps']]
        self.assertEqual(kinds, ['approve_token', 'approve_position', 'send_action'])
        self.assertEqual(len(body['legs']), 1)
        receipt = self.execute(body, account)
        self.assertExecutedAsPlanned(body, receipt)

    def test_a_v4_increase_refunds_the_fees_earned_before_and_by_its_own_swap(self):
        """F7 §2.6.2: a v4 increase credits the position's uncollected fees and
        the zap refunds them. Others trade through the pool first (fees in both
        tokens), then the increase's own leg pays the position more; the plan
        predicts the refund to the wei (assertExecutedAsPlanned)."""
        pool = self.seed(4, self.tka, self.usd, 3000, 60, Q96)
        account, owner, token_id = self.new_position('fees then increase', pool, inputs=[
            {'token': self.usd, 'amountRaw': str(10**21)}, {'token': self.tka, 'amountRaw': str(10**21)}])
        for label, token in (('fee payer usd', self.usd), ('fee payer tka', self.tka)):
            self.new_position(label, pool, inputs=[{'token': token, 'amountRaw': str(10**23)}])
        self.fx.mint(self.tka, owner, 10**22)
        body = self.plan({'chainId': 8453, 'action': 'increase', 'consent': 'direct',
                          'position': {'dex': 4, 'tokenId': str(token_id)},
                          'inputs': [{'token': self.tka, 'amountRaw': str(5 * 10**21)}]}, owner)
        self.assertTrue(all(int(body['position'][f'feesOwed{side}Raw']) > 0 for side in '01'))
        leg, = body['legs']
        self.assertEqual(leg['source'], 'local_simulation')
        returned = {item['token']: int(item['amountRaw']) for item in body['expected']['returned']}
        # The own leg sells tka, so the position earns more tka than it had owed.
        self.assertGreater(returned[self.tka], int(body['position']['feesOwed0Raw' if self.tka < self.usd
                                                                       else 'feesOwed1Raw']))
        self.assertExecutedAsPlanned(body, self.execute(body, account))

    def test_change_range_burns_the_old_position_and_mints_the_new_range(self):
        account, owner, token_id = self.new_position('change range', self.p1, inputs=[
            {'token': self.usd, 'amountRaw': str(3 * 10**20)}, {'token': self.tka, 'amountRaw': str(10**20)}])
        body = self.plan({'chainId': 8453, 'action': 'changeRange', 'consent': 'direct',
                          'position': {'dex': 4, 'tokenId': str(token_id)}, 'tickLower': 600, 'tickUpper': 3000,
                          'liquidityToRemove': 'all', 'burn': True}, owner)
        receipt = self.execute(body, account)
        self.assertExecutedAsPlanned(body, receipt)
        executed, = events(receipt, 'PositionActionExecuted')
        self.assertNotEqual(int(executed['topics'][3], 16), token_id)

    def test_exit_converted_to_one_token(self):
        account, owner, token_id = self.new_position('exit converted', self.p1, inputs=[
            {'token': self.usd, 'amountRaw': str(2 * 10**20)}, {'token': self.tka, 'amountRaw': str(2 * 10**20)}])
        before = self.fx.balance(self.usd, owner)
        body = self.plan({'chainId': 8453, 'action': 'exit', 'consent': 'direct',
                          'position': {'dex': 4, 'tokenId': str(token_id)}, 'liquidityToRemove': 'all',
                          'burn': True, 'receive': {'mode': 'converted', 'token': self.usd}}, owner)
        self.assertEqual((body['fee']['token'], body['fee']['place']), (self.usd, 'output'))
        receipt = self.execute(body, account)
        self.assertExecutedAsPlanned(body, receipt)
        received = self.fx.balance(self.usd, owner) - before
        expected = next(int(r['amountRaw']) for r in body['expected']['returned'] if r['token'] == self.usd)
        self.assertEqual(received, expected)

    def test_exit_to_both_tokens_charges_nothing(self):
        account, owner, token_id = self.new_position('exit both', self.p1, inputs=[
            {'token': self.usd, 'amountRaw': str(10**20)}, {'token': self.tka, 'amountRaw': str(10**20)}])
        body = self.plan({'chainId': 8453, 'action': 'exit', 'consent': 'direct',
                          'position': {'dex': 4, 'tokenId': str(token_id)}, 'liquidityToRemove': 'all',
                          'burn': False, 'receive': {'mode': 'both'}}, owner)
        self.assertEqual((body['fee']['bps'], body['legs']), (0, []))
        self.assertExecutedAsPlanned(body, self.execute(body, account))

    def test_a_relayed_exit_signed_by_the_owner(self):
        account, owner, token_id = self.new_position('relayed exit', self.p1, inputs=[
            {'token': self.usd, 'amountRaw': str(10**20)}, {'token': self.tka, 'amountRaw': str(10**20)}])
        body = self.plan({'chainId': 8453, 'action': 'exit', 'consent': 'relayed',
                          'position': {'dex': 4, 'tokenId': str(token_id)}, 'liquidityToRemove': 'all',
                          'burn': True, 'receive': {'mode': 'converted', 'token': self.tka}}, owner)
        self.assertEqual(body['signature']['typedData']['message']['amount0Max'], '0')
        relayer = self.local.account('relayer').address.lower()
        self.assertExecutedAsPlanned(body, self.execute(body, account, sender=relayer))

    def test_v3_create_with_a_swap_and_exit_converted(self):
        account, owner = self.owner('v3 journey')
        self.fx.mint(self.usd, owner, 10**22)
        body = self.plan({'chainId': 8453, 'action': 'create', 'consent': 'direct', 'pool': self.p3,
                          'tickLower': -1800, 'tickUpper': 1800,
                          'inputs': [{'token': self.usd, 'amountRaw': str(10**21)}]}, owner)
        receipt = self.execute(body, account)
        self.assertExecutedAsPlanned(body, receipt)
        executed, = events(receipt, 'PositionActionExecuted')
        token_id = int(executed['topics'][3], 16)
        exit_body = self.plan({'chainId': 8453, 'action': 'exit', 'consent': 'direct',
                               'position': {'dex': 3, 'tokenId': str(token_id)}, 'liquidityToRemove': 'all',
                               'burn': True, 'receive': {'mode': 'converted', 'token': self.tka}}, owner)
        self.assertExecutedAsPlanned(exit_body, self.execute(exit_body, account))

    def test_v3_increase_needs_no_approval_and_v3_change_range_burns(self):
        account, owner, token_id = self.new_position('v3 increase', self.p3, inputs=[
            {'token': self.usd, 'amountRaw': str(10**20)}, {'token': self.tka, 'amountRaw': str(10**20)}],
            ticks=(-1800, 1800))
        self.fx.mint(self.usd, owner, 10**21)
        body = self.plan({'chainId': 8453, 'action': 'increase', 'consent': 'direct',
                          'position': {'dex': 3, 'tokenId': str(token_id)},
                          'inputs': [{'token': self.usd, 'amountRaw': str(3 * 10**20)}]}, owner)
        # v3's increaseLiquidity is open: no NFT approval, only the ERC-20 one.
        self.assertIsNone(body['readiness']['positionApproval'])
        self.assertEqual([s['kind'] for s in body['readiness']['steps']], ['approve_token', 'send_action'])
        self.assertExecutedAsPlanned(body, self.execute(body, account))
        body = self.plan({'chainId': 8453, 'action': 'changeRange', 'consent': 'direct',
                          'position': {'dex': 3, 'tokenId': str(token_id)}, 'tickLower': -600, 'tickUpper': 2400,
                          'liquidityToRemove': 'all', 'burn': True}, owner)
        self.assertEqual(body['readiness']['steps'][0]['kind'], 'approve_position')
        self.assertExecutedAsPlanned(body, self.execute(body, account))

    def test_native_eth_create_is_direct_with_value(self):
        account, owner = self.owner('native create')
        body = self.plan({'chainId': 8453, 'action': 'create', 'consent': 'direct', 'pool': self.p2,
                          'tickLower': 75000, 'tickUpper': 76980,
                          'inputs': [{'token': ZERO, 'amountRaw': str(10**18)}]}, owner)
        self.assertEqual(body['call']['valueRaw'], str(10**18))
        self.assertEqual(body['readiness']['account']['consents'], ['direct'])
        self.assertEqual((body['fee']['token'], body['fee']['place']), (self.usd, 'output'))
        self.assertExecutedAsPlanned(body, self.execute(body, account))
        # Permit2 cannot carry native ETH (owner decision 4 of F2).
        with self.assertRaises(PlanError) as refused:
            self.plan({'chainId': 8453, 'action': 'create', 'consent': 'permit2', 'pool': self.p2, 'tickLower': 75000,
                       'tickUpper': 76980, 'inputs': [{'token': ZERO, 'amountRaw': str(10**18)}]}, owner)
        self.assertEqual(refused.exception.code, 'position_plan_consent_unsupported')

    def test_a_token_outside_the_pool_is_split_between_its_tokens(self):
        account, owner = self.owner('foreign input')
        self.fx.mint(self.usd, owner, 10**22)
        body = self.plan({'chainId': 8453, 'action': 'create', 'consent': 'direct', 'pool': self.p4,
                          'tickLower': -500, 'tickUpper': 500,
                          'inputs': [{'token': self.usd, 'amountRaw': str(10**21)}]}, owner)
        self.assertEqual({leg['tokenOut'] for leg in body['legs']}, {self.tka, self.tkb})
        self.assertEqual((body['fee']['token'], body['fee']['place']), (self.usd, 'input'))
        self.assertExecutedAsPlanned(body, self.execute(body, account))

    def test_two_legs_crossing_one_pool_are_planned_from_what_the_call_delivers(self):
        # A token whose only pool is against ETH, paying a pool of two other tokens each paired with ETH: both
        # legs run through the token's ETH pool, then a hop out of ETH. Quoted alone, the second leg misses the
        # first one's trade (the Robinhood fork qualification of 4 Oct 2026: a router leg and a pool leg both
        # through PONS/USDG). The plan takes both outputs from its simulated call, and executes exactly.
        tkc, tkd, tke = self.fx.tokens(3)
        for token in (tkc, tkd, tke):
            self.fx.mint(token, self.lp, 10**30)
            self.fx.approve(self.lp, token, self.fx.zap_v4, 2**256 - 1)
        crossed = self.seed(4, ZERO, tkc, 3000, 60, Q96)
        for token in (tkd, tke):
            self.seed(4, ZERO, token, 3000, 60, Q96)
        target = self.seed(4, tkd, tke, 500, 10, Q96)
        account, owner = self.owner('two legs one pool')
        self.fx.mint(tkc, owner, 10**22)
        request = {'chainId': 8453, 'action': 'create', 'consent': 'direct', 'pool': target,
                   'tickLower': -500, 'tickUpper': 500, 'inputs': [{'token': tkc, 'amountRaw': str(10**21)}]}
        with mock.patch.object(v2_position_plan, 'MAX_CORRECTIONS', 0):
            quoted = self.plan(request, owner)
        body = self.plan(request, owner)
        self.assertEqual([leg['pools'][0]['id'] for leg in body['legs']], [liq_pool_id(crossed)] * 2)
        self.assertEqual([leg['amountInRaw'] for leg in quoted['legs']], [leg['amountInRaw'] for leg in body['legs']])
        self.assertNotEqual([leg['expectedOutRaw'] for leg in quoted['legs']],
                            [leg['expectedOutRaw'] for leg in body['legs']])
        self.assertExecutedAsPlanned(body, self.execute(body, account))

    def test_eth_pays_a_v3_weth_pool_and_the_rest_returns_as_weth(self):
        """F2, F7 §2.7: on a v3 WETH pool native ETH is the WETH side. Selling
        part of it runs through a v4 ETH pool (a v3 leg spends ERC-20s only);
        the zap wraps the rest before it adds, and what is left returns as WETH."""
        weth = self.fx.weth
        self.local.fund(self.lp, 10**27)
        self.local.send(self.lp, weth, codec.selector('deposit()'), 2 * 10**25)
        self.fx.approve(self.lp, weth, self.fx.zap_v3, 2**256 - 1)
        weth_first = weth < self.usd
        pool = self.seed(3, weth, self.usd, 3000, 60, int((2000 if weth_first else 1 / 2000) ** 0.5 * Q96))
        ticks = (75000, 76980) if weth_first else (-76980, -75000)
        for label, inputs, sold in (('eth only', [{'token': ZERO, 'amountRaw': str(10**18)}], ZERO),
                                    ('eth and usd', [{'token': ZERO, 'amountRaw': str(10**17)},
                                                     {'token': self.usd, 'amountRaw': str(10**21)}], self.usd)):
            with self.subTest(inputs=label):
                account, owner = self.owner('v3 weth pool ' + label)
                self.local.fund(owner, 10**19)
                if len(inputs) > 1:
                    self.fx.mint(self.usd, owner, 10**22)
                body = self.plan({'chainId': 8453, 'action': 'create', 'consent': 'direct', 'pool': pool,
                                  'tickLower': ticks[0], 'tickUpper': ticks[1], 'inputs': inputs}, owner)
                leg, = body['legs']
                self.assertEqual(leg['tokenIn'], sold)
                if sold == ZERO:
                    self.assertEqual((leg['tokenOut'], leg['kind']), (self.usd, 'v4_pool'))
                else:
                    self.assertEqual(leg['tokenOut'], weth)
                self.assertEqual(body['call']['valueRaw'], inputs[0]['amountRaw'])
                self.assertEqual(body['readiness']['account']['consents'], ['direct'])
                receipt = self.execute(body, account)
                self.assertExecutedAsPlanned(body, receipt)  # the refunds included
                # What is left of the ETH comes back as WETH, never as ETH.
                self.assertLessEqual(set(refunds(receipt)), {weth, self.usd})
        with self.assertRaises(PlanError) as refused:
            self.plan({'chainId': 8453, 'action': 'create', 'consent': 'direct', 'pool': pool, 'tickLower': ticks[0],
                       'tickUpper': ticks[1], 'inputs': [{'token': ZERO, 'amountRaw': '1000'},
                                                         {'token': weth, 'amountRaw': '1000'}]}, owner)
        self.assertEqual(refused.exception.code, 'position_plan_inputs_unsupported')

    # ------------------------------------------- minimums at the band (rc.2)
    def set_v4_price(self, pool, sqrt_price):
        """A v4 pool's slot0 at `sqrt_price` and its tick. The pools these tests move
        hold full-range liquidity only, so nothing else in the pool changes."""
        pool_id = keccak(encode(['address', 'address', 'uint24', 'int24', 'address'],
                                [pool['currency0'], pool['currency1'], pool['fee'], pool['tickSpacing'],
                                 pool['hooks']]))
        slot = '0x' + keccak(pool_id + (6).to_bytes(32, 'big')).hex()  # StateLibrary.POOLS_SLOT
        manager = self.fx.v4['poolManager']
        word = int(self.local.request('eth_getStorageAt', [manager, slot, 'latest']), 16)
        word = (word >> 184 << 184) | ((tick_at_sqrt(sqrt_price) & 0xffffff) << 160) | sqrt_price
        self.local.request('anvil_setStorageAt', [manager, slot, '0x' + word.to_bytes(32, 'big').hex()])

    def attempt(self, body, account):
        """The wallet's steps, then the direct action: (receipt, None), or (None, the revert's name)."""
        owner = account.address.lower()
        for step in body['readiness']['steps'][:-1]:
            if step['kind'] in ('approve_token', 'approve_position'):
                self.local.send(owner, step['to'], step['data'])
        call = body['call']
        tx = {'from': owner, 'to': call['to'], 'data': call['data'], 'value': hex(int(call['valueRaw']))}
        reply = self.local.transport({'jsonrpc': '2.0', 'id': 1, 'method': 'eth_call', 'params': [tx, 'latest']})
        if 'error' in reply:
            return None, decode_revert(reply['error'].get('data') or '')['name']
        return self.local.send(owner, call['to'], call['data'], int(call['valueRaw'])), None

    def at_price(self, pool, sqrt_price, body, account):
        """attempt() with the pool moved to `sqrt_price`, then the chain put back."""
        snapshot = self.local.request('evm_snapshot', [])
        try:
            self.set_v4_price(pool, sqrt_price)
            return self.attempt(body, account)
        finally:
            self.local.request('evm_revert', [snapshot])

    def fresh_pair(self):
        """Two new tokens the liquidity provider holds and approved: pools of them
        change no other test's routes."""
        pair = self.fx.tokens(2)
        for token in pair:
            self.fx.mint(token, self.lp, 10**30)
            for zap in (self.fx.zap_v3, self.fx.zap_v4):
                self.fx.approve(self.lp, token, zap, 2**256 - 1)
        return pair

    @staticmethod
    def minted(receipt):
        executed, = events(receipt, 'PositionActionExecuted')
        return decode(['uint256', 'uint128', 'bytes32'], bytes.fromhex(executed['data'][2:]))[1]

    def test_a_mint_executes_anywhere_in_the_band_and_reverts_past_it(self):
        """minLiquidity is the least the held amounts buy within ±s: at every
        point of the band the zap mints exactly that formula's liquidity, at
        the worse edge exactly the minimum, and past the edges it reverts. A
        ±1% range tolerates the same ±0.5% price move as a ±10% one."""
        s = 50
        for label, fee, spacing, ticks in (('narrow ±1%', 100, 1, (-100, 100)), ('wide ±10%', 500, 10, (-1000, 1000))):
            with self.subTest(range=label):
                pair = self.fresh_pair()
                pool = self.seed(4, *pair, fee, spacing, Q96)
                account, owner = self.owner('band mint ' + label)
                for token in pair:
                    self.fx.mint(token, owner, 10**22)
                body = self.plan({'chainId': 8453, 'action': 'create', 'consent': 'direct', 'pool': pool,
                                  'tickLower': ticks[0], 'tickUpper': ticks[1], 'slippageBps': s,
                                  'inputs': [{'token': token, 'amountRaw': str(10**20)} for token in sorted(pair)]},
                                 owner)
                self.assertEqual(body['legs'], [])
                minimum = int(body['zapPlan']['intent']['minLiquidity'])
                sqrt_a, sqrt_b = liq.range_prices(*ticks)
                buys = lambda price: liq.liquidity_for_amounts(price, sqrt_a, sqrt_b, 10**20, 10**20)  # noqa: E731
                center = int(body['expected']['sqrtPriceX96After'])
                points = {step: liq.band_sqrt_price(center, s, step) for step in liq.BAND_STEPS}
                self.assertEqual(body['minimums']['mintBand'], {'lowerSqrtPriceX96': str(points[-2]),
                                                                'upperSqrtPriceX96': str(points[2])})
                self.assertEqual(minimum, min(buys(points[-2]), buys(points[2])))
                for step, price in points.items():
                    receipt, error = self.at_price(pool, price, body, account)
                    self.assertIsNone(error, step)
                    self.assertEqual(self.minted(receipt), buys(price))
                worse = min((-1, 1), key=lambda sign: buys(points[2 * sign]))
                receipt, error = self.at_price(pool, shifted(center, s, 3 * worse), body, account)
                self.assertEqual(error, 'InsufficientLiquidity(uint128,uint128)')
                # The better side's limit lies past its edge: where the formula falls below the minimum.
                beyond = next(half for half in range(3, 400) if buys(shifted(center, s, -half * worse)) < minimum)
                self.assertIsNone(self.at_price(pool, shifted(center, s, -(beyond - 1) * worse), body, account)[1])
                self.assertEqual(self.at_price(pool, shifted(center, s, -beyond * worse), body, account)[1],
                                 'InsufficientLiquidity(uint128,uint128)')

    def test_a_withdrawal_executes_anywhere_in_the_band_and_reverts_past_either_edge(self):
        """The removal minima are what removing pays at the band's edges
        (burnAmountsWithSlippage): within ±s an exit executes, at the upper
        edge currency0 arrives exactly at its minimum and at the lower edge
        currency1, and one step past either edge it reverts. A converted exit
        of a ±1% position executes after a move inside the band too."""
        s = 50
        pair = self.fresh_pair()
        pool = self.seed(4, *pair, 100, 1, Q96)
        account, owner = self.owner('band exit')
        for token in pair:
            self.fx.mint(token, owner, 10**22)
        created = self.plan({'chainId': 8453, 'action': 'create', 'consent': 'direct', 'pool': pool,
                             'tickLower': -100, 'tickUpper': 100,
                             'inputs': [{'token': token, 'amountRaw': str(10**20)} for token in pair]}, owner)
        receipt = self.execute(created, account)
        token_id = int(events(receipt, 'PositionActionExecuted')[0]['topics'][3], 16)
        request = {'chainId': 8453, 'action': 'exit', 'consent': 'direct', 'position': {'dex': 4, 'tokenId': str(token_id)},
                   'liquidityToRemove': 'all', 'burn': True, 'receive': {'mode': 'both'}, 'slippageBps': s}
        body = self.plan(request, owner)
        minima = int(body['zapPlan']['amount0MinRemoved']), int(body['zapPlan']['amount1MinRemoved'])
        center = int(body['pool']['sqrtPriceX96'])
        c0, c1 = pool['currency0'], pool['currency1']
        for step in liq.BAND_STEPS:
            before = self.fx.balance(c0, owner), self.fx.balance(c1, owner)
            snapshot = self.local.request('evm_snapshot', [])
            try:
                self.set_v4_price(pool, liq.band_sqrt_price(center, s, step))
                receipt, error = self.attempt(body, account)
                self.assertIsNone(error, step)
                paid = self.fx.balance(c0, owner) - before[0], self.fx.balance(c1, owner) - before[1]
            finally:
                self.local.request('evm_revert', [snapshot])
            self.assertGreaterEqual(paid[0], minima[0])
            self.assertGreaterEqual(paid[1], minima[1])
            if step == 2:
                self.assertEqual(paid[0], minima[0])
            if step == -2:
                self.assertEqual(paid[1], minima[1])
        for half in (-3, 3):
            receipt, error = self.at_price(pool, shifted(center, s, half), body, account)
            self.assertEqual(error, 'MinimumAmountInsufficient(uint128,uint128)', half)  # v4 PositionManager
        converted = self.plan({**request, 'receive': {'mode': 'converted', 'token': pair[1]}}, owner)
        self.assertEqual(len(converted['legs']), 1)
        for step in (-1, 1):
            receipt, error = self.at_price(pool, liq.band_sqrt_price(center, s, step), converted, account)
            self.assertIsNone(error, step)

    # ---------------------------------------------------------- L1 data fee
    def test_the_l1_data_fee_is_bases_oracle_pricing_the_transaction(self):
        """Base's GasPriceOracle, with the L1 state captured from Base, prices the
        plan's unsigned transaction inside the readiness Multicall3: no call of its own."""
        oracle = l1_fee.OP_GAS_PRICE_ORACLE
        sample = json.loads(L1_FEE.read_text())['samples'][0]
        transaction = bytes.fromhex(sample['transaction'][2:])
        self.assertEqual(str(self.local.call(oracle, 'getL1Fee(bytes)', ['uint256'], ['bytes'], [transaction])[0]),
                         sample['getL1Fee'])
        self.assertEqual(str(self.local.call(oracle, 'getL1FeeUpperBound(uint256)', ['uint256'], ['uint256'],
                                             [len(transaction)])[0]), sample['getL1FeeUpperBound'])
        account, owner = self.owner('l1 data fee')
        self.fx.mint(self.usd, owner, 10**22)
        self.local.sent.clear()
        body = self.plan({'chainId': 8453, 'action': 'create', 'consent': 'permit2', 'pool': self.p1,
                          'tickLower': -1200, 'tickUpper': 1200,
                          'inputs': [{'token': self.usd, 'amountRaw': str(10**21)}]}, owner)
        data = codec.call_data('create', 'permit2', body['zapPlan'], permit=body['signature']['permit'],
                               signature='0x' + '11' * 65)
        priced = l1_fee.unsigned_transaction(8453, body['zap'], 0, data)
        fee = body['l1DataFee']
        self.assertEqual((fee['status'], fee['source'], fee['block'], fee['transactionBytes']),
                         ('ok', 'op_gas_price_oracle', body['block']['number'], len(priced)))
        self.assertEqual(fee['weiRaw'], str(self.local.call(oracle, 'getL1Fee(bytes)', ['uint256'], ['bytes'],
                                                            [priced])[0]))
        self.assertEqual(fee['upperBoundWeiRaw'], str(self.local.call(
            oracle, 'getL1FeeUpperBound(uint256)', ['uint256'], ['uint256'], [len(priced)])[0]))
        self.assertLess(int(fee['weiRaw']), int(fee['upperBoundWeiRaw']))
        self.assertFalse(any(call.get('method') == 'eth_call' and call['params'][0].get('to') == oracle
                             for call in self.local.sent))

    def test_a_new_v4_pool_is_created_at_the_owners_price(self):
        account, owner = self.owner('new v4 pool')
        self.fx.mint(self.usd, owner, 10**22)
        c0, c1 = sorted((self.tkb, self.usd))
        pool = {'dex': 4, 'currency0': c0, 'currency1': c1, 'fee': 10000, 'tickSpacing': 200, 'hooks': ZERO}
        body = self.plan({'chainId': 8453, 'action': 'create', 'consent': 'direct', 'pool': pool,
                          'tickLower': -4000, 'tickUpper': 4000,
                          'inputs': [{'token': self.usd, 'amountRaw': str(10**21)}],
                          'initialPrice': {'price': '1.25', 'baseToken': self.tkb, 'decimals0': 18, 'decimals1': 18}},
                         owner)
        self.assertFalse(body['pool']['initialized'])
        self.assertFalse(body['initialPrice']['decimalsVerified'])
        self.assertNotEqual(body['zapPlan']['initSqrtPriceX96'], '0')
        self.assertTrue(all(leg['pools'][0]['id'] != body['pool']['id'] for leg in body['legs']))
        self.assertExecutedAsPlanned(body, self.execute(body, account))
        state = self.local.call(self.fx.v4['stateView'], 'getSlot0(bytes32)', ['uint160', 'int24', 'uint24', 'uint24'],
                                ['bytes32'], [bytes.fromhex(body['pool']['id'][2:])])
        self.assertEqual(str(state[0]), body['initialPrice']['sqrtPriceX96'])
        # The pool now has a price: asking to create it again is refused.
        with self.assertRaises(PlanError) as refused:
            self.plan({'chainId': 8453, 'action': 'create', 'consent': 'direct', 'pool': pool, 'tickLower': -4000,
                       'tickUpper': 4000, 'inputs': [{'token': self.usd, 'amountRaw': '1000'}],
                       'initialPrice': {'price': '1', 'baseToken': self.tkb, 'decimals0': 18, 'decimals1': 18}}, owner)
        self.assertEqual(refused.exception.code, 'position_plan_pool_initialized')

    def test_a_new_v3_pool_is_created_through_the_position_manager(self):
        account, owner = self.owner('new v3 pool')
        c0, c1 = sorted((self.tkb, self.usd))
        for token in (c0, c1):
            self.fx.mint(token, owner, 10**22)
        pool = {'dex': 3, 'currency0': c0, 'currency1': c1, 'fee': 500, 'tickSpacing': 10, 'hooks': ZERO}
        with self.assertRaises(PlanError) as refused:
            self.plan({'chainId': 8453, 'action': 'create', 'consent': 'direct', 'pool': pool, 'tickLower': -100,
                       'tickUpper': 100, 'inputs': [{'token': self.usd, 'amountRaw': '1000'}]}, owner)
        self.assertEqual(refused.exception.code, 'position_plan_pool_not_initialized')
        body = self.plan({'chainId': 8453, 'action': 'create', 'consent': 'direct', 'pool': pool,
                          'tickLower': -1000, 'tickUpper': 1000,
                          'inputs': [{'token': c0, 'amountRaw': str(10**20)}, {'token': c1, 'amountRaw': str(10**20)}],
                          'initialPrice': {'price': '1', 'baseToken': c0, 'decimals0': 18, 'decimals1': 18}}, owner)
        self.assertEqual(body['legs'], [])
        self.assertExecutedAsPlanned(body, self.execute(body, account))

    def test_refusals(self):
        account, owner, token_id = self.new_position('refusals', self.p1, inputs=[
            {'token': self.usd, 'amountRaw': str(10**20)}, {'token': self.tka, 'amountRaw': str(10**20)}])
        stranger = self.local.account('stranger').address.lower()
        cases = [
            ({'chainId': 8453, 'action': 'increase', 'consent': 'direct', 'position': {'dex': 4, 'tokenId': str(token_id)},
              'inputs': [{'token': self.tka, 'amountRaw': '1000'}]}, stranger, 'position_plan_not_owner'),
            ({'chainId': 8453, 'action': 'create', 'consent': 'direct',
              'pool': {**self.p1, 'hooks': '0x' + '00' * 18 + '0aa0'}, 'tickLower': -60, 'tickUpper': 60,
              'inputs': [{'token': self.usd, 'amountRaw': '1000'}]}, owner, 'position_plan_hooked_pool'),
            ({'chainId': 8453, 'action': 'create', 'consent': 'direct', 'pool': self.p1, 'tickLower': -61,
              'tickUpper': 60, 'inputs': [{'token': self.usd, 'amountRaw': '1000'}]}, owner,
             'position_plan_range_invalid'),
            ({'chainId': 8453, 'action': 'exit', 'consent': 'direct', 'position': {'dex': 4, 'tokenId': str(token_id)},
              'liquidityToRemove': '1', 'burn': True, 'receive': {'mode': 'both'}}, owner,
             'position_plan_burn_needs_all'),
            ({'chainId': 8453, 'action': 'exit', 'consent': 'direct', 'position': {'dex': 4, 'tokenId': '999999'},
              'liquidityToRemove': 'all', 'burn': True, 'receive': {'mode': 'both'}}, owner,
             'position_plan_position_not_found'),
        ]
        for request, who, code in cases:
            with self.subTest(code=code), self.assertRaises(PlanError) as refused:
                self.plan(request, who)
            self.assertEqual(refused.exception.code, code)

    def test_a_delegated_account_gets_the_direct_path_only(self):
        account, owner = self.owner('eip-7702 owner')
        self.fx.mint(self.usd, owner, 10**22)
        self.local.request('anvil_setCode', [owner, '0xef0100' + '77' * 20])
        request = {'chainId': 8453, 'action': 'create', 'consent': 'permit2', 'pool': self.p1, 'tickLower': -1200,
                   'tickUpper': 1200, 'inputs': [{'token': self.usd, 'amountRaw': str(10**20)}]}
        with self.assertRaises(PlanError) as refused:
            self.plan(request, owner)
        self.assertEqual(refused.exception.code, 'position_plan_consent_unsupported')
        body = self.plan({**request, 'consent': 'direct'}, owner)
        self.assertEqual(body['readiness']['account'], {'kind': 'eip7702', 'delegate': '0x' + '77' * 20,
                                                        'consents': ['direct']})
        self.local.request('anvil_setCode', [owner, '0x'])

    def test_the_local_swap_crosses_initialized_ticks_exactly(self):
        """v2_liquidity.simulate_exact_in over ticks read from the chain against
        the chain's own quoters, on fresh pools whose liquidity changes at every
        range boundary: the same output (and on v3 the same price after) both
        ways, across several initialized ticks and bitmap words."""
        from v2_liquidity import simulate_exact_in
        from v2_quotes import Path as QuotePath, PoolQuoter, pool_snapshot
        from v2_uniswap import PoolRef, UniswapReader
        ranges = ((-1200, 600), (-6000, 6000), (600, 12000), (-30000, -600), (2400, 36000), (-180000, 180000),
                  (-600, 0))
        for dex, fee, spacing in ((4, 2500, 60), (3, 10000, 200)):
            c0, c1 = sorted((self.tka, self.tkb))
            pool = {'dex': dex, 'currency0': c0, 'currency1': c1, 'fee': fee, 'tickSpacing': spacing, 'hooks': ZERO}
            for index, (lower, upper) in enumerate(ranges):
                amount = str(10**20 * (index + 1))
                intent = {'action': 1, 'pool': pool, 'tokenId': '0', 'tickLower': lower, 'tickUpper': upper,
                          'minLiquidity': '1', 'feeBps': 0, 'feeToken': ZERO, 'routesHash': codec.routes_hash([]),
                          'recipient': self.lp, 'nonce': '0', 'deadline': str(int(time.time()) + 3600)}
                plan = {'intent': intent, 'inputs': [{'token': c0, 'amount': amount}, {'token': c1, 'amount': amount}],
                        'legs': [], 'amount0Max': str(U128), 'amount1Max': str(U128),
                        'initSqrtPriceX96': str(Q96 if index == 0 else 0)}
                self.local.send(self.lp, self.fx.zap_v3 if dex == 3 else self.fx.zap_v4,
                                codec.call_data('create', 'direct', plan))
            head = LatestHead(self.local).head()
            rpc = self.fx.endpoints().read_rpc(anchor=head.block, batch_reads=True)
            ref = PoolRef(dex, c0, c1, fee, spacing)
            state = UniswapReader(self.fx.profile, rpc).pool(ref, head.block)
            snapshot = pool_snapshot(self.fx.profile, rpc, head.block, state)
            quoter = PoolQuoter(self.fx.profile, rpc, head.block)
            for zero_for_one in (True, False):
                for amount in (10**15, 3 * 10**19, 2 * 10**20, 6 * 10**20, 10**21):
                    with self.subTest(dex=dex, zero_for_one=zero_for_one, amount=amount):
                        local = simulate_exact_in(snapshot, zero_for_one, amount)
                        token_in = c0 if zero_for_one else c1
                        quote, = quoter.quote([QuotePath(dex, token_in, (ref,))], amount)
                        self.assertEqual(local.amount_out, quote.amount_out)
                        if dex == 3:
                            self.assertEqual(local.sqrt_price, quote.sqrt_prices_after[0])
                        if amount == 10**21:
                            self.assertGreaterEqual(local.ticks_crossed, 3)
            # Without the position at (-6000, 6000): the swap meets what a
            # withdrawal in the same transaction leaves (as a change of range does).
            thinner = snapshot.without_position(-6000, 6000, int(state.liquidity) // 3)
            self.assertLess(simulate_exact_in(thinner, True, 6 * 10**20).amount_out,
                            simulate_exact_in(snapshot, True, 6 * 10**20).amount_out)

    def test_a_plan_spends_few_calls(self):
        _, owner = self.owner('call count')
        self.fx.mint(self.usd, owner, 10**22)
        self.local.calls = 0
        self.plan({'chainId': 8453, 'action': 'create', 'consent': 'permit2', 'pool': self.p1, 'tickLower': -1200,
                   'tickUpper': 1200, 'inputs': [{'token': self.usd, 'amountRaw': str(10**21)}]}, owner)
        # Head, pool and code proofs, ranks + nonce + account, ticks, quotes,
        # readiness and the simulation: each billed call on a hosted endpoint.
        self.assertLessEqual(self.local.calls, 24)


@unittest.skipUnless(EVM, 'requires isolated local Anvil')
class S1JourneyDeployedEvmTests(S1JourneyEvmTests):
    """The same journeys on Base's deployed v3 and v4 bytecode, with the real Base profile."""
    FLAVOR = 'deployed'


class LegOutputTests(unittest.TestCase):
    """What a simulated call delivered is read only from the zap's own receipt lines, one per leg, in order."""

    ZAP = '0x' + 'a0' * 20
    LEGS = [{'tokenIn': '0x' + '01' * 20, 'tokenOut': '0x' + '02' * 20, 'amountIn': '100'},
            {'tokenIn': '0x' + '01' * 20, 'tokenOut': '0x' + '03' * 20, 'amountIn': '200'}]

    def line(self, leg, out, *, emitter=None, topic=None):
        return {'address': emitter or self.ZAP,
                'topics': [topic or TOPICS['SwapLegExecuted'], '0x' + '00' * 31 + '03',
                           '0x' + '00' * 12 + leg['tokenIn'][2:], '0x' + '00' * 12 + leg['tokenOut'][2:]],
                'data': '0x' + encode(['address', 'uint256', 'uint256'], [ZERO, int(leg['amountIn']), out]).hex()}

    def outputs(self, logs):
        context = SimpleNamespace(zap=self.ZAP)
        return v2_position_plan._Context._leg_outputs(context, logs, {'legs': self.LEGS})

    def test_one_line_per_leg_in_order(self):
        other = {'address': self.ZAP, 'topics': [TOPICS['Refunded']], 'data': '0x'}
        lines = [self.line(self.LEGS[0], 7), other, self.line(self.LEGS[1], 9)]
        self.assertEqual(self.outputs(lines), [7, 9])
        self.assertEqual(v2_position_plan.SWAP_LEG_TOPIC, TOPICS['SwapLegExecuted'])

    def test_anything_but_a_one_for_one_match_keeps_the_quotes(self):
        first, second = self.line(self.LEGS[0], 7), self.line(self.LEGS[1], 9)
        swapped = {**self.LEGS[1], 'amountIn': '201'}
        for name, logs in (('missing', [first]), ('extra', [first, second, second]), ('order', [second, first]),
                           ('input', [first, self.line(swapped, 9)]), ('foreign emitter',
                            [first, self.line(self.LEGS[1], 9, emitter='0x' + 'b0' * 20)]),
                           ('not a list', None)):
            with self.subTest(name=name):
                self.assertIsNone(self.outputs(logs))


# ----------------------------------------------------------- router legs

class FakeTradingApi:
    """The Uniswap Trading API's two answers for a zap leg, computed on the local chain.

    The route is a hidden pool (a v4 key the planner never tries), its output
    that pool's exact local swap, and /swap's call is V4_SWAP with
    SWAP_EXACT_IN_SINGLE, SETTLE_ALL from the caller and TAKE_ALL to it, the
    encoding F1b runs through Universal Router 2.1.2 (testAV4SwapThroughTheDeployedRouter).
    `route_id` overrides the pool id the route names (to name the position's pool)."""

    def __init__(self, fixture, pool, route_id=None, bias_bps=0):
        self.fixture, self.pool, self.route_id, self.calls = fixture, pool, route_id, []
        self.bias_bps = bias_bps  # a quote off the plan's block: the API's state, not the chain's at the block

    def output(self, token_in, amount):
        from v2_liquidity import simulate_exact_in
        from v2_quotes import pool_snapshot
        from v2_uniswap import UniswapReader
        head = LatestHead(self.fixture.chain).head()
        rpc = self.fixture.endpoints().read_rpc(anchor=head.block, batch_reads=True)
        state = UniswapReader(self.fixture.profile, rpc).pool(self.pool, head.block)
        return simulate_exact_in(pool_snapshot(self.fixture.profile, rpc, head.block, state),
                                 token_in == self.pool.currency0, amount).amount_out

    def __call__(self, url, body, *, timeout, headers):
        from discovery import TRADING_QUOTE_ENDPOINT
        self.calls.append(url)
        if url == TRADING_QUOTE_ENDPOINT:
            token_in, token_out, amount = body['tokenIn'], body['tokenOut'], int(body['amount'])
            out = self.output(token_in, amount) * (10000 + self.bias_bps) // 10000
            bps = round(body['slippageTolerance'] * 100)
            minimum = out * (10000 - bps) // 10000
            hop = {'type': 'v4-pool', 'address': self.route_id or self.pool.pool_id,
                   'tokenIn': {'address': token_in, 'chainId': 4663}, 'tokenOut': {'address': token_out, 'chainId': 4663},
                   'fee': str(self.pool.fee), 'tickSpacing': str(self.pool.tick_spacing), 'hooks': ZERO,
                   'amountIn': str(amount), 'amountOut': str(out)}
            from decimal import Decimal
            return {'routing': 'CLASSIC', 'permitData': None, 'quote': {
                'chainId': 4663, 'swapper': body['swapper'], 'tradeType': 'EXACT_INPUT', 'quoteId': 'local-1',
                'input': {'token': token_in, 'amount': str(amount)},
                'output': {'token': token_out, 'amount': str(out), 'recipient': body['recipient'],
                           'minimumAmount': str(minimum)},
                'slippage': Decimal(bps) / 100, 'priceImpact': Decimal('0.01'),
                'aggregatedOutputs': [{'token': token_out, 'amount': str(out), 'recipient': body['recipient'],
                                       'bps': 10000, 'minAmount': str(minimum)}],
                'route': [[hop]]}}
        quote = body['quote']
        token_in, token_out, amount = quote['input']['token'], quote['output']['token'], int(quote['input']['amount'])
        key = (self.pool.currency0, self.pool.currency1, self.pool.fee, self.pool.tick_spacing, self.pool.hooks)
        params = [encode(['((address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)'],
                         [(key, token_in == self.pool.currency0, amount, 0, 0, b'')]),
                  encode(['address', 'uint256'], [token_in, amount]), encode(['address', 'uint256'], [token_out, 0])]
        swap_input = encode(['bytes', 'bytes[]'], [bytes([0x06, 0x0c, 0x0f]), params])
        data = '0x3593564c' + encode(['bytes', 'bytes[]', 'uint256'], [b'\x10', [swap_input], int(time.time()) + 1800]).hex()
        return {'swap': {'to': self.fixture.router, 'from': quote['swapper'], 'chainId': 4663, 'data': data,
                         'value': hex(amount) if token_in == ZERO else '0x0'}}


@unittest.skipUnless(EVM, 'requires isolated local Anvil')
class S1RouterLegEvmTests(unittest.TestCase):
    """A router leg from the Trading API, run by the zap through Robinhood's deployed Universal Router 2.1.2."""

    @classmethod
    def setUpClass(cls):
        from v2_s1_chain import S1Fixture
        from v2_uniswap import PoolRef
        fx = cls.fx = S1Fixture('router')
        cls.addClassCleanup(fx.close)
        cls.local = fx.chain
        cls.usd, cls.tka = fx.tokens(2)
        fx.deploy_domino([(cls.usd, 1), (ZERO, 2)], routers=[fx.router])
        cls.deployment = fx.deployment
        cls.lp = cls.local.account('router liquidity provider').address.lower()
        for token in (cls.usd, cls.tka):
            fx.mint(token, cls.lp, 10**30)
            fx.approve(cls.lp, token, fx.zap_v4, 2**256 - 1)
        cls.own = S1JourneyEvmTests.seed.__func__(cls, 4, cls.tka, cls.usd, 3000, 60, Q96)
        c0, c1 = sorted((cls.tka, cls.usd))
        cls.hidden = PoolRef(4, c0, c1, 50, 1)
        S1JourneyEvmTests.seed.__func__(cls, 4, cls.tka, cls.usd, 50, 1, Q96)

    def planner(self, api):
        from v2_uniswap_api import TradingApiLegs
        legs = TradingApiLegs('synthetic-offline-key', transport=api, clock=time.time)
        return PositionPlanner(self.fx.profile, self.fx.endpoints(), LatestHead(self.local), self.deployment,
                               router_legs=legs, clock=time.time, nonce_word=lambda: 0x77)

    def test_a_better_router_leg_runs_through_router_2_1_2(self):
        account = self.local.account('router owner')
        owner = account.address.lower()
        self.fx.mint(self.usd, owner, 10**22)
        api = FakeTradingApi(self.fx, self.hidden)
        request = PlanRequest.model_validate({'chainId': 4663, 'action': 'create', 'consent': 'permit2',
                                              'pool': self.own, 'tickLower': -1200, 'tickUpper': 1200,
                                              'inputs': [{'token': self.usd, 'amountRaw': str(10**21)}]}).model_dump()
        body = self.planner(api).plan(request, owner)
        PlanResponse.model_validate({'contractVersion': CONTRACT_VERSION, 'plan': body})
        self.assertEqual(body['routing']['router'], {'status': 'chosen', 'reason': None})
        leg, = body['legs']
        self.assertEqual((leg['kind'], leg['source'], leg['pools'][0]['id']),
                         ('universal_router', 'uniswap_trading_api', self.hidden.pool_id))
        self.assertEqual(body['zapPlan']['legs'][0]['router'], self.fx.router)
        self.assertEqual(body['simulation']['status'], 'ok')
        case = S1JourneyEvmTests('test_create_with_a_swap_signed_through_permit2')
        case.local, case.fx = self.local, self.fx
        receipt = case.execute(body, account)
        case.assertExecutedAsPlanned(body, receipt)
        swap, = events(receipt, 'SwapLegExecuted')
        venue = decode(['address', 'uint256', 'uint256'], bytes.fromhex(swap['data'][2:]))[0]
        self.assertEqual(venue.lower(), self.fx.router)
        # Nothing stays approved: not to Permit2, not to the router through Permit2.
        allowance, = self.local.call(self.usd, 'allowance(address,address)', ['uint256'], ['address', 'address'],
                                     [self.fx.zap_v4, PERMIT2])
        self.assertEqual(allowance, 0)

    def test_a_router_leg_quoted_off_the_block_is_planned_from_what_it_delivers(self):
        # The API quotes its own latest state, not the plan's block. Within the slippage the first simulation
        # shows what the leg delivers; past it the call stops on the leg's own minimum, and the legs are measured
        # with their minimums at the floor. Either way the plan executes exactly.
        for bias, uncorrected in ((20, 'ok'), (200, 'reverted')):
            with self.subTest(bias=bias):
                account = self.local.account(f'router off the block {bias}')
                owner = account.address.lower()
                self.fx.mint(self.usd, owner, 10**22)
                api = FakeTradingApi(self.fx, self.hidden, bias_bps=bias)
                request = PlanRequest.model_validate({'chainId': 4663, 'action': 'create', 'consent': 'direct',
                                                      'pool': self.own, 'tickLower': -1200, 'tickUpper': 1200,
                                                      'inputs': [{'token': self.usd, 'amountRaw': str(10**21)}]}).model_dump()
                with mock.patch.object(v2_position_plan, 'MAX_CORRECTIONS', 0):
                    quoted = self.planner(api).plan(request, owner)
                self.assertEqual(quoted['simulation']['status'], uncorrected)
                body = self.planner(api).plan(request, owner)
                PlanResponse.model_validate({'contractVersion': CONTRACT_VERSION, 'plan': body})
                leg, = body['legs']
                self.assertEqual((leg['source'], body['simulation']['status'], body['warnings']),
                                 ('uniswap_trading_api', 'ok', []))
                self.assertEqual(leg['expectedOutRaw'], str(api.output(self.usd, int(leg['amountInRaw']))))
                self.assertNotEqual(leg['expectedOutRaw'], quoted['legs'][0]['expectedOutRaw'])
                case = S1JourneyEvmTests('test_create_with_a_swap_signed_through_permit2')
                case.local, case.fx = self.local, self.fx
                case.assertExecutedAsPlanned(body, case.execute(body, account))

    def test_the_l1_data_fee_on_nitro_is_node_interfaces_estimate(self):
        """On Nitro the plan asks NodeInterface once (here its stand-in: 16 L2 gas per
        byte at a 0.01 gwei base fee) and prices the L1 gas at the L2 base fee; a
        node without it leaves the fee unavailable and the plan intact."""
        from v2_s1_chain import NODE_INTERFACE, NODE_INTERFACE_BASE_FEE, NODE_INTERFACE_RUNTIME
        account = self.local.account('nitro l1 fee')
        owner = account.address.lower()
        self.fx.mint(self.usd, owner, 10**22)
        planner = PositionPlanner(self.fx.profile, self.fx.endpoints(), LatestHead(self.local), self.deployment,
                                  clock=time.time, nonce_word=lambda: 0x77)
        request = PlanRequest.model_validate({'chainId': 4663, 'action': 'create', 'consent': 'direct',
                                              'pool': self.own, 'tickLower': -1200, 'tickUpper': 1200,
                                              'inputs': [{'token': self.usd, 'amountRaw': str(10**21)}]}).model_dump()
        self.local.sent.clear()
        body = planner.plan(request, owner)
        PlanResponse.model_validate({'contractVersion': CONTRACT_VERSION, 'plan': body})
        fee, size = body['l1DataFee'], (len(body['call']['data']) - 2) // 2
        self.assertEqual((fee['status'], fee['source'], fee['l1GasUnits'], fee['l2BaseFeeWei'], fee['weiRaw']),
                         ('ok', 'nitro_node_interface', str(size * 16), str(NODE_INTERFACE_BASE_FEE),
                          str(size * 16 * NODE_INTERFACE_BASE_FEE)))
        asked = [call for call in self.local.sent if call.get('method') == 'eth_call'
                 and call['params'][0].get('to') == NODE_INTERFACE]
        self.assertEqual(len(asked), 1)
        self.local.request('anvil_setCode', [NODE_INTERFACE, '0x'])
        try:
            body = planner.plan(request, owner)
        finally:
            self.local.request('anvil_setCode', [NODE_INTERFACE, '0x' + NODE_INTERFACE_RUNTIME])
        PlanResponse.model_validate({'contractVersion': CONTRACT_VERSION, 'plan': body})
        self.assertEqual((body['l1DataFee']['status'], body['l1DataFee']['weiRaw']), ('unavailable', None))
        self.assertEqual(body['simulation']['status'], 'ok')

    def test_a_router_route_through_the_position_pool_is_refused(self):
        _, owner = self.local.account('router refused').address.lower(), None
        account = self.local.account('router refused')
        owner = account.address.lower()
        self.fx.mint(self.usd, owner, 10**22)
        from v2_uniswap import PoolRef
        own = PoolRef(4, self.own['currency0'], self.own['currency1'], 3000, 60)
        api = FakeTradingApi(self.fx, self.hidden, route_id=own.pool_id)
        request = PlanRequest.model_validate({'chainId': 4663, 'action': 'create', 'consent': 'direct',
                                              'pool': self.own, 'tickLower': -1200, 'tickUpper': 1200,
                                              'inputs': [{'token': self.usd, 'amountRaw': str(10**21)}]}).model_dump()
        body = self.planner(api).plan(request, owner)
        self.assertEqual(body['routing']['router'], {'status': 'refused', 'reason': 'router_route_uses_position_pool'})
        self.assertNotEqual(body['legs'][0]['kind'], 'universal_router')


# ------------------------------------------------------------- fee parity

FEE_MISMATCH = codec.selector('FeeMismatch()')
INVALID_PLAN = codec.selector('InvalidPlan()')


@unittest.skipUnless(EVM, 'requires isolated local Anvil')
class FeeRuleParityEvmTests(unittest.TestCase):
    """v2_fee_rule against the zap's compiled DominoFeeRules.

    create() checks the intent's fee terms against the legs before any leg
    runs (requireAssistedSwapTerms), after the plan checks and an empty pull.
    With an unadmitted router on every leg, the right terms pass that check
    and the leg then reverts InvalidPlan; any other token reverts FeeMismatch.
    The ranks are written into the registry's chargeCurrencyRank mapping and
    read back through the registry before each route.
    """

    @classmethod
    def setUpClass(cls):
        from v2_s1_chain import S1Fixture
        fx = cls.fx = S1Fixture('vendored')
        cls.addClassCleanup(fx.close)
        cls.local = fx.chain
        cls.tokens = [ZERO, *fx.tokens(5)]
        fx.deploy_domino([(cls.tokens[1], 1)])
        cls.router = cls.tokens[2]  # any address with code that the registry does not admit
        cls.caller = cls.local.account('fee parity caller').address.lower()

    def rank_slot(self, token):
        # DominoRegistry: chargeCurrencyRank is the mapping at slot 8 (checked by reading it back).
        return '0x' + keccak(encode(['address', 'uint256'], [token, 8])).hex()

    def set_ranks(self, ranks):
        for token, rank in ranks.items():
            self.local.request('anvil_setStorageAt', [self.fx.registry, self.rank_slot(token),
                                                      '0x' + rank.to_bytes(32, 'big').hex()])
            read, = self.local.call(self.fx.registry, 'chargeCurrencyRank(address)', ['uint8'], ['address'], [token])
            self.assertEqual(read, rank)

    def revert(self, legs, fee_bps, fee_token):
        pool = {'dex': 4, 'currency0': self.tokens[1], 'currency1': self.tokens[2], 'fee': 3000, 'tickSpacing': 60,
                'hooks': ZERO}
        intent = {'action': 1, 'pool': pool, 'tokenId': '0', 'tickLower': -60, 'tickUpper': 60, 'minLiquidity': '1',
                  'feeBps': fee_bps, 'feeToken': fee_token, 'routesHash': codec.routes_hash(legs),
                  'recipient': self.caller, 'nonce': '0', 'deadline': str(int(time.time()) + 3600)}
        plan = {'intent': intent, 'inputs': [{'token': self.tokens[1], 'amount': '1'}], 'legs': legs,
                'amount0Max': '0', 'amount1Max': '0', 'initSqrtPriceX96': '0'}
        self.fx.mint(self.tokens[1], self.caller, 10)
        self.fx.approve(self.caller, self.tokens[1], self.fx.zap_v4, 10)
        reply = self.local.transport({'jsonrpc': '2.0', 'id': 1, 'method': 'eth_call', 'params': [
            {'from': self.caller, 'to': self.fx.zap_v4, 'data': codec.call_data('create', 'direct', plan)}, 'latest']})
        return ((reply.get('error') or {}).get('data') or '')[:10]

    def leg(self, a, b):
        return {'kind': 1, 'router': self.router, 'tokenIn': a, 'tokenOut': b, 'amountIn': '100', 'minAmountOut': '1',
                'data': '0x'}

    def test_the_python_rule_is_the_zaps_rule(self):
        generator = random.Random(20261002)
        checked = 0
        for round_ in range(12):
            ranks = {token: generator.randrange(4) for token in self.tokens}
            self.set_ranks(ranks)
            rank = fee_rule.ranks_from_mapping(ranks)
            for _ in range(8):
                count = 1 + generator.randrange(5)
                legs = [self.leg(*generator.sample(self.tokens, 2)) for _ in range(count)]
                bps, token, _ = fee_rule.assisted_swap_terms(legs, rank)
                with self.subTest(round=round_, legs=[(l['tokenIn'][-4:], l['tokenOut'][-4:]) for l in legs]):
                    self.assertEqual(self.revert(legs, bps, token), INVALID_PLAN)
                    for other in sorted(set(self.tokens) - {token}):
                        self.assertEqual(self.revert(legs, bps, other), FEE_MISMATCH)
                    self.assertEqual(self.revert(legs, 64, token), FEE_MISMATCH)
                checked += 1
        self.assertEqual(checked, 96)

    def test_f1b_table_on_the_zap(self):
        usd, weth, tsla, many, nvda = self.tokens[1], self.tokens[2], self.tokens[3], self.tokens[4], self.tokens[5]
        eth = ZERO
        self.set_ranks({usd: 1, eth: 2, weth: 2, tsla: 0, many: 0, nvda: 0})
        rank = fee_rule.ranks_from_mapping({usd: 1, eth: 2, weth: 2})
        table = [[(usd, many)], [(many, usd)], [(tsla, usd), (usd, many)], [(tsla, many)], [(weth, usd)],
                 [(eth, many)], [(eth, weth)], [(tsla, weth), (weth, many), (nvda, eth)]]
        expected = [usd, usd, usd, tsla, usd, eth, eth, eth]
        for route, token in zip(table, expected):
            legs = [self.leg(a, b) for a, b in route]
            self.assertEqual(fee_rule.assisted_swap_terms(legs, rank)[1], token)
            self.assertEqual(self.revert(legs, 65, token), INVALID_PLAN)


if __name__ == '__main__':
    unittest.main()
