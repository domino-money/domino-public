"""Setup's assisted swap routed where it returns more: the Uniswap route
adapter's checks, the 0.5% decision against the pool, its fallbacks and the
closed contract. No key, network, wallet or database needed."""
from copy import deepcopy
from decimal import Decimal
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import CHAIN_ID, ZERO, DataError, KEY_TYPES, PoolKey, TRADING_QUOTE_HEADERS, encode, keccak
from onboarding_models import CONTRACT_VERSION, OnboardingError, validate_response
from onboarding_service import OnboardingService
from swap_route import ADVANTAGE_CAP_BPS, MULTICALL3, THRESHOLD_BPS, V4_QUOTER, SwapRoute
from uniswap_route import (ENDPOINT, EXECUTE_SELECTOR, FEE_BPS, FEE_RECIPIENT, MAX_DEADLINE_SECONDS, PERMIT2,
                           PERMIT2_APPROVE_SELECTOR, SWAP_ENDPOINT, UNIVERSAL_ROUTER, UniswapRoute, exact_permit)

OWNER = '0x' + '11' * 20
A, B = '0x' + '0a' * 20, '0x' + '0b' * 20
KEY_RAW = (A, B, 40000, 400, ZERO)
POOL_ID = '0x' + keccak(encode(KEY_TYPES, KEY_RAW)).hex()
KEY = PoolKey.checked(KEY_RAW, POOL_ID)
NATIVE_KEY_RAW = (ZERO, B, 3000, 60, ZERO)
NATIVE_POOL_ID = '0x' + keccak(encode(KEY_TYPES, NATIVE_KEY_RAW)).hex()
NATIVE_KEY = PoolKey.checked(NATIVE_KEY_RAW, NATIVE_POOL_ID)
NOW = 1_790_720_000
GROSS = 1_000_000_000
SWAP_PROXY = '0x02e5be68d46dac0b524905bff209cf47ee6db2a9'
KEY_TEXT = 'synthetic-route-provider-key'
SESSION, CSRF = 'synthetic-session-' + 'q' * 32, 'synthetic-csrf-' + 'w' * 32


DEADLINE = NOW + 1800
UINT160_MAX = (1 << 160) - 1


def permit_data(token=A, spender=UNIVERSAL_ROUTER, amount=GROSS, expiration=DEADLINE):
    return PERMIT2_APPROVE_SELECTOR + encode(['address', 'address', 'uint160', 'uint48'],
                                             [token, spender, amount, expiration]).hex()


def execute_data(deadline=DEADLINE):
    """The router call as the API answered on 29 Sep 2026: V4 swap, the fee's portion, two sweeps."""
    return EXECUTE_SELECTOR + encode(['bytes', 'bytes[]', 'uint256'],
                                     [bytes.fromhex('10070404'), [b'\x01' * 64] * 4, deadline]).hex()


def payload(owner_out=450_000, fee=None, token_in=A, token_out=B, amount=GROSS):
    fee = (owner_out * FEE_BPS) // (10000 - FEE_BPS) if fee is None else fee
    gross = owner_out + fee
    native = token_in == ZERO
    return {
        'routing': 'CLASSIC', 'requestId': 'r-1', 'isTokenApprovalApplicable': not native,
        'quote': {'chainId': CHAIN_ID, 'swapper': OWNER, 'tradeType': 'EXACT_INPUT', 'quoteId': 'q-1',
                  'input': {'token': token_in, 'amount': str(amount)},
                  'output': {'token': token_out, 'amount': str(gross), 'recipient': OWNER, 'minimumAmount': str(gross * 995 // 1000)},
                  'slippage': Decimal('0.5'), 'priceImpact': Decimal('3.43'), 'txFailureReasons': [],
                  'aggregatedOutputs': [
                      {'token': token_out, 'amount': str(owner_out), 'recipient': OWNER, 'bps': 10000 - FEE_BPS,
                       'minAmount': str(owner_out * 995 // 1000)},
                      {'token': token_out, 'amount': str(fee), 'recipient': FEE_RECIPIENT, 'bps': FEE_BPS,
                       'fee': 'INTEGRATOR', 'minAmount': str(fee * 995 // 1000)}]},
        # For an owner who holds the input, Uniswap's own simulation fails before the
        # allowance exists and the quote carries no router call (29 Sep 2026).
        'swapTransaction': None,
        # What the API sends for generatePermitAsTransaction: the maximum uint160 for 30 days.
        'permitData': None,
        'permitTransaction': None if native else {'to': PERMIT2, 'from': OWNER, 'chainId': CHAIN_ID, 'value': '0x00',
                                                  'data': permit_data(token=token_in, amount=UINT160_MAX, expiration=NOW + 30 * 86400)},
    }


def built(token_in=A, amount=GROSS, deadline=DEADLINE):
    """/swap's answer for a quote: the router call, unsimulated (a fixed gas limit), and the API's signature."""
    return {'requestId': 'r-2', 'gasFee': '22636500000', 'signature': '0x' + 'ee' * 65, 'publicKeyId': 'k-1',
            'swap': {'to': UNIVERSAL_ROUTER, 'from': OWNER, 'chainId': CHAIN_ID, 'data': execute_data(deadline),
                     'value': hex(amount) if token_in == ZERO else '0x00', 'gasLimit': '650000',
                     'maxFeePerGas': '34815000', 'maxPriorityFeePerGas': '0'}}


class Transport:
    """/quote answers `answer`; /swap answers `swap` (by default the call built for the quote's input)."""
    def __init__(self, answer, swap=None):
        self.answer, self.swap, self.calls = answer, swap, []

    def __call__(self, url, body, *, timeout, headers):
        self.calls.append((url, deepcopy(body), headers))
        answer = self.answer if url == ENDPOINT else self.swap
        if url == SWAP_ENDPOINT and answer is None:
            token_in = self.answer['quote']['input']['token']
            answer = built(token_in=token_in, amount=int(self.answer['quote']['input']['amount']))
        if isinstance(answer, Exception):
            raise answer
        return deepcopy(answer)


def adapter(answer, swap=None):
    transport = Transport(answer, swap)
    return UniswapRoute(KEY_TEXT, transport=transport, clock=lambda: NOW), transport


def quote(answer, swap=None, **kwargs):
    route, _ = adapter(answer, swap)
    return route.quote(owner=OWNER, token_in=kwargs.get('token_in', A), token_out=kwargs.get('token_out', B),
                       amount_raw=str(kwargs.get('amount', GROSS)), slippage_bps=50)


class RouteAdapterTests(unittest.TestCase):
    def assertRefused(self, code, answer, swap=None, **kwargs):
        with self.assertRaises(DataError) as refused:
            quote(answer, swap, **kwargs)
        self.assertEqual(str(refused.exception), code)

    def test_one_fixed_request_with_domino_s_fee_hooks_admitted_and_an_exact_permit(self):
        route, transport = adapter(payload())
        route.quote(owner=OWNER, token_in=A, token_out=B, amount_raw=str(GROSS), slippage_bps=50)
        (url, body, headers), (swap_url, swap_body, swap_headers) = transport.calls
        self.assertEqual((url, swap_url), (ENDPOINT, SWAP_ENDPOINT))
        # /swap gets the quote as it came, its Decimal numbers as JSON numbers again, and builds without simulating.
        self.assertEqual(swap_body, {'quote': {**payload()['quote'], 'slippage': 0.5, 'priceImpact': 3.43},
                                     'simulateTransaction': False})
        self.assertEqual(swap_headers, headers)
        self.assertEqual(body['integratorFees'], [{'recipient': FEE_RECIPIENT, 'bips': 65}])
        self.assertEqual((body['protocols'], body['hooksOptions']), (['V2', 'V3', 'V4'], 'V4_HOOKS_INCLUSIVE'))
        self.assertEqual(body['generatePermitAsTransaction'], True)
        self.assertNotIn('permitAmount', body)
        self.assertEqual((body['swapper'], body['recipient'], body['slippageTolerance']), (OWNER, OWNER, 0.5))
        self.assertEqual(headers, {'x-api-key': KEY_TEXT, **TRADING_QUOTE_HEADERS})
        self.assertEqual(headers['x-universal-router-version'], '2.1.2')

    def test_a_valid_route_is_the_owner_s_output_the_fee_leg_and_the_two_transactions(self):
        result = quote(payload())
        self.assertEqual((result['amountOutRaw'], result['feeRaw']), ('450000', str(450000 * 65 // 9935)))
        self.assertEqual(result['swapTransaction']['to'], UNIVERSAL_ROUTER)
        self.assertEqual(result['swapTransaction'], {'to': UNIVERSAL_ROUTER, 'data': execute_data(), 'valueRaw': '0'})
        self.assertEqual(result['permitTransaction'], exact_permit(A, GROSS, DEADLINE))

    def test_a_swap_to_anything_but_the_pinned_router_is_refused(self):
        for target in (SWAP_PROXY, '0x8876789976decbfcbbbe364623c63652db8c0904'):
            swap = built()
            swap['swap']['to'] = target
            with self.subTest(target=target):
                self.assertRefused('uniswap_route_transaction_invalid', payload(), swap)
        # Another selector with a valid router call's arguments: only the selector is wrong.
        for field, value in (('data', '0x2894adf9' + execute_data()[10:]), ('from', '0x' + '44' * 20), ('chainId', 1),
                             ('value', hex(GROSS))):
            swap = built()
            swap['swap'][field] = value
            with self.subTest(field=field):
                self.assertRefused('uniswap_route_transaction_invalid', payload(), swap)
        for swap in ({'requestId': 'r-2'}, None, []):
            with self.subTest(swap=swap):
                self.assertRefused('uniswap_route_transaction_invalid', payload(), swap if swap is not None else {'swap': None})

    def test_swap_is_asked_only_for_a_valid_quote_and_its_failures_are_named(self):
        answer = payload()
        answer['routing'] = 'DUTCH_V3'
        route, transport = adapter(answer)
        with self.assertRaises(DataError):
            route.quote(owner=OWNER, token_in=A, token_out=B, amount_raw=str(GROSS), slippage_bps=50)
        self.assertEqual([call[0] for call in transport.calls], [ENDPOINT])
        for error, code in ((DataError('http_400'), 'uniswap_route_rejected'), (DataError('read_deadline_exceeded'), 'uniswap_route_unavailable'),
                            (OSError('reset'), 'uniswap_route_unavailable')):
            with self.subTest(code=code):
                self.assertRefused(code, payload(), error)

    def test_the_only_fee_is_domino_s_65_bps_to_domino_s_recipient(self):
        answer = payload()
        answer['quote']['aggregatedOutputs'].pop()
        self.assertRefused('uniswap_route_fee_invalid', answer)
        answer = payload()
        answer['quote']['aggregatedOutputs'][1]['recipient'] = '0x' + '22' * 20
        self.assertRefused('uniswap_route_fee_invalid', answer)
        answer = payload()
        answer['quote']['aggregatedOutputs'][1]['bps'] = 50
        self.assertRefused('uniswap_route_fee_invalid', answer)
        # Domino's leg must be the integrator fee, and the owner's leg no fee at all.
        for leg, kind in ((1, 'PORTION'), (1, None), (0, 'INTEGRATOR')):
            answer = payload()
            answer['quote']['aggregatedOutputs'][leg]['fee'] = kind
            with self.subTest(leg=leg, kind=kind):
                self.assertRefused('uniswap_route_fee_invalid', answer)
        answer = payload(fee=100)
        self.assertRefused('uniswap_route_fee_invalid', answer)
        answer = payload()
        answer['quote']['aggregatedOutputs'].append(dict(answer['quote']['aggregatedOutputs'][1], recipient='0x' + '33' * 20))
        self.assertRefused('uniswap_route_fee_invalid', answer)

    def test_the_permit_is_built_here_exact_until_the_swap_s_deadline_whatever_the_provider_sends(self):
        expected = exact_permit(A, GROSS, DEADLINE)
        self.assertEqual(expected['data'], permit_data())
        for permit in (payload()['permitTransaction'], None,
                       {'to': SWAP_PROXY, 'from': OWNER, 'chainId': CHAIN_ID, 'data': permit_data(spender=SWAP_PROXY), 'value': '0x00'}):
            answer = payload()
            answer['permitTransaction'] = permit
            with self.subTest(permit=None if permit is None else permit['data'][:80]):
                self.assertEqual(quote(answer)['permitTransaction'], expected)
        # A permit to sign would have to be inside the swap: refused.
        answer = payload()
        answer['permitData'] = {'domain': {}, 'values': {}}
        self.assertRefused('uniswap_route_permit_invalid', answer)

    def test_the_router_call_s_deadline_is_after_now_and_within_the_hour(self):
        for deadline in (NOW, NOW + MAX_DEADLINE_SECONDS + 1):
            with self.subTest(deadline=deadline - NOW):
                self.assertRefused('uniswap_route_transaction_invalid', payload(), built(deadline=deadline))
        swap = built()
        swap['swap']['data'] = EXECUTE_SELECTOR + '00' * 3
        self.assertRefused('uniswap_route_transaction_invalid', payload(), swap)
        self.assertEqual(quote(payload(), built(deadline=NOW + MAX_DEADLINE_SECONDS))['permitTransaction'],
                         exact_permit(A, GROSS, NOW + MAX_DEADLINE_SECONDS))

    def test_the_provider_s_own_simulation_does_not_decide(self):
        # It runs before the allowance this route adds: for an owner holding the
        # input it reports SIMULATION_ERROR (29 Sep 2026). The node's simulation decides.
        for reasons in (['SIMULATION_ERROR'], None):
            answer = payload()
            if reasons is None:
                answer['quote'].pop('txFailureReasons')
            else:
                answer['quote']['txFailureReasons'] = reasons
            with self.subTest(reasons=reasons):
                self.assertEqual(quote(answer)['amountOutRaw'], '450000')

    def test_identity_routing_and_native_value_are_checked(self):
        answer = payload()
        answer['quote']['swapper'] = '0x' + '44' * 20
        self.assertRefused('uniswap_route_invalid', answer)
        answer = payload()
        answer['routing'] = 'DUTCH_V3'
        self.assertRefused('uniswap_route_invalid', answer)
        native = payload(token_in=ZERO)
        self.assertEqual(quote(native, token_in=ZERO)['swapTransaction']['valueRaw'], str(GROSS))
        swap = built(token_in=ZERO)
        swap['swap']['value'] = '0x00'
        self.assertRefused('uniswap_route_transaction_invalid', native, swap, token_in=ZERO)
        # Native input needs no allowance, whatever the provider sends.
        native = payload(token_in=ZERO)
        native['permitTransaction'] = {'to': PERMIT2, 'from': OWNER, 'chainId': CHAIN_ID, 'data': permit_data(), 'value': '0x00'}
        self.assertIsNone(quote(native, token_in=ZERO)['permitTransaction'])

    def test_provider_failures_are_named_without_detail(self):
        for error, code in ((DataError('http_404'), 'uniswap_route_unavailable'), (DataError('http_400'), 'uniswap_route_rejected'),
                            (DataError('read_deadline_exceeded'), 'uniswap_route_unavailable'), (OSError('reset'), 'uniswap_route_unavailable')):
            with self.subTest(code=code):
                self.assertRefused(code, error)


class Chain:
    """The node: head, the V4 quoter for the pool, and eth_simulateV1 of the owner's sequence."""
    def __init__(self, pool_out, *, owner_gain=None, fee_gain=None, status='0x1'):
        self.pool_out, self.owner_gain, self.fee_gain, self.status = pool_out, owner_gain, fee_gain, status
        self.calls = []

    def __call__(self):
        return self

    def request(self, method, params=()):
        self.calls.append((method, deepcopy(params)))
        if method == 'eth_chainId':
            return hex(CHAIN_ID)
        if method == 'eth_getBlockByNumber':
            return {'number': hex(100), 'hash': '0x' + 'ab' * 32, 'timestamp': hex(NOW - 1)}
        if method == 'eth_simulateV1':
            calls = params[0]['blockStateCalls'][0]['calls']
            word = lambda value: '0x' + '%064x' % value
            results = [{'status': '0x1', 'returnData': word(1_000), 'gasUsed': '0x1'} for _ in calls]
            results[-2]['returnData'] = word(1_000 + self.owner_gain)
            results[-1]['returnData'] = word(1_000 + self.fee_gain)
            results[-3]['status'] = self.status
            return [{'calls': results}]
        raise AssertionError(method)

    def call(self, target, signature, inputs, values, outputs, *, block):
        self.calls.append(('quote', target, values[0][2]))
        if target != V4_QUOTER:
            raise AssertionError(target)
        if isinstance(self.pool_out, Exception):
            raise self.pool_out
        return (self.pool_out, 90_000)


class Uniswap:
    def __init__(self, answer):
        self.answer, self.asked = answer, []

    def quote(self, **kwargs):
        self.asked.append(kwargs)
        if isinstance(self.answer, Exception):
            raise self.answer
        return deepcopy(self.answer)


def routed(owner_out, fee=None, **kwargs):
    return quote(payload(owner_out, fee, **kwargs), **{k: v for k, v in kwargs.items() if k in ('token_in', 'token_out')})


def plan(pool_out, answer, chain=None, *, token_in=A, key=KEY, pool_id=POOL_ID):
    chain = chain or Chain(pool_out)
    route = SwapRoute(Uniswap(answer), chain, clock=lambda: NOW)
    result = route.plan(owner=OWNER, pool_id=pool_id, key=key, token_in=token_in, amount_raw=str(GROSS), slippage_bps=50)
    validate_response('swap-route', {'contractVersion': CONTRACT_VERSION, 'preview': result})
    return result, chain


class RouteDecisionTests(unittest.TestCase):
    def test_uniswap_is_chosen_when_it_returns_more_than_half_a_percent_after_the_same_fee(self):
        pool_out = 440_000
        result, chain = plan(pool_out, routed(450_000), Chain(pool_out, owner_gain=449_000, fee_gain=2_930))
        self.assertEqual((result['decision'], result['reason']), ('uniswap', 'uniswap_better_by_threshold'))
        self.assertEqual(result['pool'], {'source': 'v4_quoter', 'amountInRaw': str(GROSS), 'feeRaw': str(GROSS * 65 // 10000),
                                          'netInputRaw': str(GROSS - GROSS * 65 // 10000), 'amountOutRaw': str(pool_out)})
        self.assertEqual(result['advantageBps'], (449_000 - pool_out) * 10000 // pool_out)
        uniswap = result['uniswap']
        self.assertEqual((uniswap['simulatedAmountOutRaw'], uniswap['simulatedFeeRaw']), ('449000', '2930'))
        self.assertEqual(uniswap['approval'], {'token': A, 'spender': PERMIT2, 'amountRaw': str(GROSS)})
        self.assertEqual((uniswap['permitTransaction']['to'], uniswap['swapTransaction']['to']), (PERMIT2, UNIVERSAL_ROUTER))
        # The pool quote is Setup's net input, and the sequence is simulated on the same block.
        self.assertEqual([c[2] for c in chain.calls if c[0] == 'quote'], [GROSS - GROSS * 65 // 10000])
        simulate, = [c[1] for c in chain.calls if c[0] == 'eth_simulateV1']
        self.assertEqual(simulate[1], '0x' + 'ab' * 32)
        steps = simulate[0]['blockStateCalls'][0]['calls']
        self.assertEqual([step['to'] for step in steps], [B, B, A, PERMIT2, UNIVERSAL_ROUTER, B, B])
        # A generous limit whatever /swap said: its fixed 650,000 reverts a large route (715,000 used).
        self.assertEqual(steps[4]['gas'], hex(3_000_000))
        self.assertEqual(simulate[0]['blockStateCalls'][0]['blockOverrides'], {'time': hex(NOW)})

    def test_exactly_half_a_percent_keeps_the_pool_without_simulating(self):
        pool_out = 440_000
        result, chain = plan(pool_out, routed(pool_out * (10000 + THRESHOLD_BPS) // 10000))
        self.assertEqual((result['decision'], result['reason'], result['advantageBps']), ('pool', 'pool_within_threshold', 50))
        self.assertNotIn('eth_simulateV1', [c[0] for c in chain.calls])
        self.assertEqual({name: result['uniswap'][name] for name in ('approval', 'permitTransaction', 'swapTransaction')},
                         {'approval': None, 'permitTransaction': None, 'swapTransaction': None})
        result, _ = plan(pool_out, routed(pool_out * (10000 + THRESHOLD_BPS) // 10000 + 1),
                         Chain(pool_out, owner_gain=pool_out * (10000 + THRESHOLD_BPS) // 10000 + 1, fee_gain=3_000))
        self.assertEqual(result['decision'], 'uniswap')

    def test_the_pool_is_kept_when_uniswap_does_not_answer_or_its_answer_is_refused(self):
        for error, reason in ((DataError('uniswap_route_unavailable'), 'uniswap_quote_unavailable'),
                              (DataError('uniswap_route_rejected'), 'uniswap_quote_rejected'),
                              (DataError('uniswap_route_fee_invalid'), 'uniswap_quote_invalid')):
            with self.subTest(reason=reason):
                result, _ = plan(440_000, error)
                self.assertEqual((result['decision'], result['reason'], result['uniswap'], result['advantageBps']),
                                 ('pool', reason, None, None))

    def test_the_pool_is_kept_when_the_owner_s_sequence_does_not_simulate_to_the_quote(self):
        pool_out = 440_000
        for chain, reason in ((Chain(pool_out, owner_gain=449_000, fee_gain=2_930, status='0x0'), 'uniswap_simulation_failed'),
                              (Chain(pool_out, owner_gain=440_000, fee_gain=2_930), 'uniswap_simulation_failed'),
                              (Chain(pool_out, owner_gain=449_000, fee_gain=0), 'uniswap_simulation_failed')):
            with self.subTest(reason=reason, gain=chain.owner_gain, status=chain.status):
                result, _ = plan(pool_out, routed(450_000), chain)
                self.assertEqual((result['decision'], result['reason']), ('pool', reason))
                self.assertIsNone(result['uniswap']['swapTransaction'])
        # The quote beats the pool by more than half a percent, but the owner's
        # own simulation, above the quote's minimum, does not.
        result, _ = plan(446_000, routed(450_000), Chain(446_000, owner_gain=448_000, fee_gain=2_930))
        self.assertEqual((result['decision'], result['reason'], result['uniswap']['simulatedAmountOutRaw']),
                         ('pool', 'pool_within_threshold', '448000'))

    def test_a_pool_that_cannot_fill_returns_nothing_and_any_simulated_route_beats_it(self):
        # The quoter reverts when the pool cannot take the whole net input.
        reverted = DataError('rpc_call_reverted')
        result, _ = plan(None, routed(450_000), Chain(reverted, owner_gain=449_000, fee_gain=2_930))
        self.assertEqual((result['decision'], result['pool']['amountOutRaw'], result['advantageBps']),
                         ('uniswap', '0', ADVANTAGE_CAP_BPS))
        # With no Uniswap answer the plan keeps the pool and says it returns nothing.
        result, _ = plan(None, DataError('uniswap_route_unavailable'), Chain(reverted))
        self.assertEqual((result['decision'], result['reason'], result['pool']['amountOutRaw']),
                         ('pool', 'uniswap_quote_unavailable', '0'))
        # Any other chain failure is not a pool that cannot fill.
        with self.assertRaises(DataError):
            plan(None, routed(450_000), Chain(DataError('rpc_error')))

    def test_the_advantage_over_a_nearly_empty_pool_is_capped(self):
        result, _ = plan(1, routed(450_000), Chain(1, owner_gain=449_000, fee_gain=2_930))
        self.assertEqual((result['decision'], result['advantageBps']), ('uniswap', min(448_999 * 10000, ADVANTAGE_CAP_BPS)))
        result, _ = plan(10, routed(450_000), Chain(10, owner_gain=449_000, fee_gain=2_930))
        self.assertEqual(result['advantageBps'], (449_000 - 10) * 10000 // 10)

    def test_native_input_is_sent_as_value_with_no_approval_or_permit(self):
        pool_out = 440_000
        chain = Chain(pool_out, owner_gain=449_000, fee_gain=2_930)
        result, _ = plan(pool_out, routed(450_000, token_in=ZERO), chain, token_in=ZERO, key=NATIVE_KEY, pool_id=NATIVE_POOL_ID)
        uniswap = result['uniswap']
        self.assertEqual((uniswap['approval'], uniswap['permitTransaction'], uniswap['swapTransaction']['valueRaw']), (None, None, str(GROSS)))
        steps = [c for c in chain.calls if c[0] == 'eth_simulateV1'][0][1][0]['blockStateCalls'][0]['calls']
        self.assertEqual([step['to'] for step in steps], [B, B, UNIVERSAL_ROUTER, B, B])

    def test_a_native_output_is_read_through_multicall(self):
        chain = Chain(440_000, owner_gain=449_000, fee_gain=2_930)
        result, _ = plan(440_000, routed(450_000, token_in=B, token_out=ZERO), chain, token_in=B, key=NATIVE_KEY, pool_id=NATIVE_POOL_ID)
        self.assertEqual(result['decision'], 'uniswap')
        steps = [c for c in chain.calls if c[0] == 'eth_simulateV1'][0][1][0]['blockStateCalls'][0]['calls']
        self.assertEqual([step['to'] for step in steps], [MULTICALL3, MULTICALL3, B, PERMIT2, UNIVERSAL_ROUTER, MULTICALL3, MULTICALL3])

    def test_the_contract_refuses_a_plan_whose_fields_disagree(self):
        pool_out = 440_000
        good, _ = plan(pool_out, routed(450_000), Chain(pool_out, owner_gain=449_000, fee_gain=2_930))
        for change in (lambda p: p['uniswap']['swapTransaction'].update(to=SWAP_PROXY),
                       lambda p: p['uniswap'].update(swapTransaction=None),
                       lambda p: p.update(decision='pool', reason='pool_within_threshold'),
                       lambda p: p['pool'].update(feeRaw='0'),
                       lambda p: p.update(advantageBps=p['advantageBps'] + 1),
                       lambda p: p['uniswap']['approval'].update(amountRaw='1'),
                       lambda p: p['uniswap'].update(simulatedAmountOutRaw=str(pool_out)),
                       lambda p: p['uniswap']['permitTransaction'].update(data=permit_data(token=B)),
                       lambda p: p['uniswap']['permitTransaction'].update(data=permit_data(spender=SWAP_PROXY)),
                       lambda p: p['uniswap']['permitTransaction'].update(data=permit_data(amount=GROSS + 1)),
                       lambda p: p['uniswap']['permitTransaction'].update(data=permit_data(expiration=NOW)),
                       lambda p: p['uniswap']['permitTransaction'].update(data=permit_data(expiration=NOW + 30 + MAX_DEADLINE_SECONDS + 1)),
                       lambda p: p['uniswap'].update(permitTransaction=None),
                       lambda p: p['uniswap']['permitTransaction'].update(to=SWAP_PROXY),
                       lambda p: p['uniswap']['swapTransaction'].update(data='0x2894adf9' + '00' * 96)):
            broken = deepcopy(good)
            change(broken)
            with self.subTest(change=change), self.assertRaises(OnboardingError):
                validate_response('swap-route', {'contractVersion': CONTRACT_VERSION, 'preview': broken})
        pool, _ = plan(pool_out, DataError('uniswap_route_unavailable'))
        pool['uniswap'] = good['uniswap']
        with self.assertRaises(OnboardingError):
            validate_response('swap-route', {'contractVersion': CONTRACT_VERSION, 'preview': pool})
        # A pool decision never carries a transaction the wallet could sign.
        within, _ = plan(pool_out, routed(pool_out * (10000 + THRESHOLD_BPS) // 10000))
        for name in ('approval', 'permitTransaction', 'swapTransaction'):
            carried = deepcopy(within)
            carried['uniswap'][name] = good['uniswap'][name]
            with self.subTest(carried=name), self.assertRaises(OnboardingError):
                validate_response('swap-route', {'contractVersion': CONTRACT_VERSION, 'preview': carried})


class RouteServiceTests(unittest.TestCase):
    BODY = {'chainId': CHAIN_ID, 'poolId': POOL_ID,
            'poolKey': {'currency0': A, 'currency1': B, 'fee_pips': 40000, 'tick_spacing': 400, 'hooks': ZERO},
            'tokenIn': A, 'amountRaw': str(GROSS), 'slippageBps': 50}

    def service(self, route):
        auth = Mock()
        auth.begin.return_value = {'owner': OWNER}
        return OnboardingService(auth, Mock(), Mock(), route=route, clock=lambda: NOW, private_values=(KEY_TEXT,)), auth

    def test_the_session_s_owner_asks_and_the_plan_is_delivered_through_the_closed_contract(self):
        chain = Chain(440_000, owner_gain=449_000, fee_gain=2_930)
        uniswap = Uniswap(routed(450_000))
        service, auth = self.service(SwapRoute(uniswap, chain, clock=lambda: NOW))
        result = service.execute('swap-route', dict(self.BODY), client='c', session=SESSION, csrf=CSRF)
        self.assertEqual(result['contractVersion'], CONTRACT_VERSION)
        self.assertEqual((result['preview']['decision'], result['preview']['request']['owner']), ('uniswap', OWNER))
        self.assertEqual(uniswap.asked[0]['owner'], OWNER)
        auth.finish.assert_called_once()

    def test_a_browser_supplied_owner_or_a_foreign_currency_is_an_invalid_request(self):
        service, _ = self.service(SwapRoute(Uniswap(routed(450_000)), Chain(440_000), clock=lambda: NOW))
        for body in (dict(self.BODY, owner=OWNER), dict(self.BODY, tokenIn='0x' + '0c' * 20)):
            with self.subTest(body=sorted(body)), self.assertRaises(OnboardingError) as refused:
                service.execute('swap-route', body, client='c', session=SESSION, csrf=CSRF)
            self.assertEqual(refused.exception.code, 'invalid_request')

    def test_without_a_route_service_the_route_is_not_available_and_a_chain_failure_is_upstream(self):
        service, _ = self.service(None)
        with self.assertRaises(OnboardingError) as refused:
            service.execute('swap-route', dict(self.BODY), client='c', session=SESSION, csrf=CSRF)
        self.assertEqual(refused.exception.code, 'route_not_available')
        broken = Chain(440_000)
        broken.call = Mock(side_effect=DataError('rpc_error'))
        service, _ = self.service(SwapRoute(Uniswap(routed(450_000)), broken, clock=lambda: NOW))
        with self.assertRaises(OnboardingError) as refused:
            service.execute('swap-route', dict(self.BODY), client='c', session=SESSION, csrf=CSRF)
        self.assertEqual(refused.exception.code, 'upstream_unavailable')


def fixture_plan(kind):
    """The contract's synthetic examples: Uniswap chosen (also for native input, and over a pool that cannot
    fill, or past the advantage cap), the pool within the threshold, ahead of Uniswap or kept when the owner's
    sequence simulates short of the quote, and no provider answer."""
    simulated = {'owner_gain': 449_000, 'fee_gain': 2_930}
    if kind == 'uniswap':
        return plan(440_000, routed(450_000), Chain(440_000, **simulated))[0]
    if kind == 'native':
        return plan(440_000, routed(450_000, token_in=ZERO), Chain(440_000, **simulated),
                    token_in=ZERO, key=NATIVE_KEY, pool_id=NATIVE_POOL_ID)[0]
    if kind == 'unfilled':
        return plan(None, routed(450_000), Chain(DataError('rpc_call_reverted'), **simulated))[0]
    if kind == 'pool':
        return plan(440_000, routed(440_000 * (10000 + THRESHOLD_BPS) // 10000))[0]
    if kind == 'behind':
        return plan(440_000, routed(439_000))[0]
    if kind == 'short':
        return plan(440_000, routed(450_000), Chain(440_000, owner_gain=440_000, fee_gain=2_930))[0]
    if kind == 'capped':
        return plan(1, routed(200_000_000), Chain(1, owner_gain=199_000_000, fee_gain=1_308_505))[0]
    return plan(440_000, DataError('uniswap_route_unavailable'))[0]


if __name__ == '__main__':
    unittest.main()
