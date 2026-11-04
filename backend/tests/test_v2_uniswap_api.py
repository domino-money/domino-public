"""Router legs from the Uniswap Trading API: what is asked, and every answer field that must match.

The answers are synthetic, in the shape V1's recorded answers had (29 Sep
2026, tests/test_swap_route.py), with the zap as swapper and recipient and no
integrator fee. No key, network or chain.
"""
from copy import deepcopy
from decimal import Decimal
from pathlib import Path
import sys
import unittest
from unittest import mock

from eth_abi import encode

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import (KEEPALIVE_OPENER, TRADING_QUOTE_ENDPOINT, TRADING_QUOTE_HEADERS, TRADING_SWAP_ENDPOINT,  # noqa: E402
                       DataError)
from v2_chains import chain  # noqa: E402
import v2_uniswap_api  # noqa: E402
from v2_uniswap_api import EXECUTE_SELECTOR, MSG_SENDER, TradingApiLegs  # noqa: E402

BASE = chain('base-8453')
ROUTER = BASE.uniswap.universalRouter.address
ZAP = '0x' + 'd0' * 20
USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
WETH = '0x4200000000000000000000000000000000000006'
ZERO = '0x' + '00' * 20
KEY = 'synthetic-uniswap-offline-key'
NOW = 1_790_720_000
DEADLINE = NOW + 300
POOL_ID = '0x' + '5a' * 32


def v4_swap(deadline=NOW + 1800, commands=bytes([0x10]), recipient=None):
    inputs = []
    for command in commands:
        if command == 0x10:
            inputs.append(b'\x01' * 64)
        elif command == 0x00:
            inputs.append(encode(['address', 'uint256', 'uint256', 'bytes', 'bool'],
                                 [recipient or MSG_SENDER, 10**9, 1, b'\x00' * 43, True]))
        elif command in (0x04,):
            inputs.append(encode(['address', 'address', 'uint256'], [USDC, recipient or MSG_SENDER, 0]))
        else:
            inputs.append(encode(['address', 'uint256'], [recipient or MSG_SENDER, 0]))
    return EXECUTE_SELECTOR + encode(['bytes', 'bytes[]', 'uint256'], [bytes(commands), inputs, deadline]).hex()


def quote_answer(amount=10**9, out=4 * 10**17, token_in=USDC, token_out=WETH):
    minimum = out * 995 // 1000
    hop = {'type': 'v4-pool', 'address': POOL_ID, 'tokenIn': {'address': token_in, 'chainId': 8453},
           'tokenOut': {'address': token_out, 'chainId': 8453}, 'fee': '500', 'tickSpacing': '10', 'hooks': ZERO,
           'amountIn': str(amount), 'amountOut': str(out)}
    return {'routing': 'CLASSIC', 'requestId': 'r-1', 'permitData': None,
            'quote': {'chainId': 8453, 'swapper': ZAP, 'tradeType': 'EXACT_INPUT', 'quoteId': 'q-1',
                      'input': {'token': token_in, 'amount': str(amount)},
                      'output': {'token': token_out, 'amount': str(out), 'recipient': ZAP, 'minimumAmount': str(minimum)},
                      'slippage': Decimal('0.5'), 'priceImpact': Decimal('0.12'),
                      'aggregatedOutputs': [{'token': token_out, 'amount': str(out), 'recipient': ZAP, 'bps': 10000,
                                             'minAmount': str(minimum)}],
                      'route': [[hop]]}}


def swap_answer(data=None, value='0x00', to=ROUTER):
    return {'requestId': 'r-2', 'swap': {'to': to, 'from': ZAP, 'chainId': 8453, 'data': data or v4_swap(),
                                         'value': value, 'gasLimit': '650000'}}


class Transport:
    def __init__(self, quote, swap):
        self.quote, self.swap, self.calls = quote, swap, []

    def __call__(self, url, body, *, timeout, headers):
        self.calls.append((url, deepcopy(body), headers))
        answer = self.quote if url == TRADING_QUOTE_ENDPOINT else self.swap
        if isinstance(answer, Exception):
            raise answer
        return deepcopy(answer)


def leg(quote=None, swap=None, *, token_in=USDC, token_out=WETH, amount=10**9):
    transport = Transport(quote_answer(amount=amount, token_in=token_in, token_out=token_out) if quote is None else quote,
                          swap_answer() if swap is None else swap)
    legs = TradingApiLegs(KEY, transport=transport, clock=lambda: NOW)
    return legs.leg(chain=BASE, zap=ZAP, token_in=token_in, token_out=token_out, amount_in=amount, slippage_bps=50,
                    deadline=DEADLINE), transport


class RouterLegTests(unittest.TestCase):
    def assertRefused(self, code, quote=None, swap=None, **kwargs):
        with self.assertRaisesRegex(DataError, '^uniswap_api_' + code + '$'):
            leg(quote, swap, **kwargs)

    def test_the_zap_is_swapper_and_recipient_with_no_fee_and_v3_v4_only(self):
        result, transport = leg()
        (url, body, headers), (swap_url, swap_body, _) = transport.calls
        self.assertEqual((url, swap_url), (TRADING_QUOTE_ENDPOINT, TRADING_SWAP_ENDPOINT))
        self.assertEqual((body['swapper'], body['recipient']), (ZAP, ZAP))
        self.assertNotIn('integratorFees', body)
        self.assertEqual(body['protocols'], ['V3', 'V4'])
        self.assertEqual((body['generatePermitAsTransaction'], body['routingPreference']), (True, 'BEST_PRICE'))
        self.assertEqual(headers, {'x-api-key': KEY, **TRADING_QUOTE_HEADERS})
        self.assertEqual(headers['x-universal-router-version'], '2.1.2')
        self.assertEqual(swap_body['simulateTransaction'], False)
        self.assertEqual((result['kind'], result['router'], result['amountIn'], result['expectedOut']),
                         (1, ROUTER, 10**9, 4 * 10**17))
        self.assertEqual(result['minAmountOut'], 4 * 10**17 * 995 // 1000)
        self.assertEqual(result['paths'][0]['pools'][0]['id'], POOL_ID)
        self.assertEqual(result['routerDeadline'], NOW + 1800)

    def test_the_quote_must_be_the_request(self):
        for path, value, code in ((('routing',), 'DUTCH_V2', 'route_unsupported'),
                                  (('quote', 'swapper'), '0x' + '11' * 20, 'quote_mismatch'),
                                  (('quote', 'chainId'), 42161, 'quote_mismatch'),
                                  (('quote', 'input', 'amount'), '999', 'quote_mismatch'),
                                  (('quote', 'output', 'recipient'), '0x' + '11' * 20, 'quote_mismatch'),
                                  (('quote', 'output', 'minimumAmount'), '1', 'minimum_mismatch'),
                                  (('permitData',), {'domain': {}}, 'route_unsupported')):
            answer = quote_answer()
            target = answer
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            with self.subTest(path=path):
                self.assertRefused(code, answer)

    def test_no_fee_output_and_no_portion(self):
        answer = quote_answer()
        answer['quote']['aggregatedOutputs'].append({'token': WETH, 'amount': '1', 'recipient': '0x' + '22' * 20,
                                                     'bps': 1, 'minAmount': '1', 'fee': 'INTEGRATOR'})
        self.assertRefused('fee_output_unsupported', answer)
        answer = quote_answer()
        answer['quote']['portionBips'] = 25
        self.assertRefused('fee_output_unsupported', answer)

    def test_the_route_is_v3_and_v4_pools_connected_in_order(self):
        answer = quote_answer()
        answer['quote']['route'][0][0]['type'] = 'v2-pool'
        self.assertRefused('route_unsupported', answer)
        answer = quote_answer()
        answer['quote']['route'][0][0]['tokenIn']['address'] = '0x' + '33' * 20
        self.assertRefused('route_disconnected', answer)
        answer = quote_answer()
        answer['quote']['route'][0][0]['amountOut'] = '5'
        self.assertRefused('route_amount_mismatch', answer)

    def test_a_hooked_v4_pool_with_a_dynamic_fee_is_admitted_and_shown_as_the_flag(self):
        # The API's best WETH -> USDG route on Robinhood, 4 Oct 2026: a v4 pool whose hook sets each swap's fee.
        hooks = '0x64e9ae1066c47ac4a3cc0a5bd7b135908590e088'
        answer = quote_answer()
        answer['quote']['route'][0][0].update(fee='8388608', tickSpacing='1', hooks=hooks)
        result, _ = leg(answer)
        pool = result['paths'][0]['pools'][0]
        self.assertEqual((pool['fee'], pool['tickSpacing'], pool['hooks']), (0x800000, 1, hooks))
        # Only the flag itself, and only on v4: any other value above a rate is still refused.
        for kind, fee in (('v4-pool', '1000001'), ('v4-pool', '8388609'), ('v3-pool', '8388608')):
            answer = quote_answer()
            answer['quote']['route'][0][0].update(type=kind, fee=fee)
            if kind == 'v3-pool':
                answer['quote']['route'][0][0]['address'] = '0x' + '44' * 20
            with self.subTest(kind=kind, fee=fee):
                self.assertRefused('quote_invalid', answer)

    def test_native_eth_and_weth_join_through_the_router_s_wrap_and_unwrap(self):
        # USDG -> ETH on Robinhood, 4 Oct 2026: the route ended in WETH and the router unwrapped it.
        answer = quote_answer(token_out=ZERO)
        answer['quote']['route'][0][0]['tokenOut']['address'] = WETH
        result, _ = leg(answer, swap_answer(data=v4_swap(commands=bytes([0x10, 0x0c]))), token_out=ZERO)
        self.assertEqual((result['tokenOut'], result['paths'][0]['pools'][0]['tokenOut']), (ZERO, WETH))
        # ETH in, a route starting from WETH: the router wraps the value it was sent.
        answer = quote_answer(token_in=ZERO)
        answer['quote']['route'][0][0]['tokenIn']['address'] = WETH
        result, _ = leg(answer, swap_answer(data=v4_swap(commands=bytes([0x0b, 0x10])), value=hex(10**9)),
                        token_in=ZERO)
        self.assertEqual(result['paths'][0]['pools'][0]['tokenIn'], WETH)
        # Between two hops too: WETH out of a v3 pool, unwrapped, into a native ETH v4 pool.
        other = '0x' + '77' * 20
        answer = quote_answer(token_in=USDC, token_out=other)
        first = answer['quote']['route'][0][0]
        first.update(type='v3-pool', address='0x' + '44' * 20, tokenOut={'address': WETH, 'chainId': 8453},
                     amountOut='7')
        second = {**deepcopy(first), 'type': 'v4-pool', 'address': '0x' + '6b' * 32,
                  'tokenIn': {'address': '0x' + '55' * 20, 'chainId': 8453},
                  'tokenOut': {'address': other, 'chainId': 8453}, 'amountIn': '7',
                  'amountOut': answer['quote']['output']['amount']}
        answer['quote']['route'][0] = [first, second]
        unwrapped = swap_answer(data=v4_swap(commands=bytes([0x00, 0x0c, 0x10])))
        self.assertRefused('route_disconnected', answer, unwrapped, token_out=other)
        second['tokenIn'] = {'address': ZERO, 'chainId': 8453}
        result, _ = leg(answer, unwrapped, token_out=other)
        self.assertEqual([(pool['tokenIn'], pool['tokenOut']) for pool in result['paths'][0]['pools']],
                         [(USDC, WETH), (ZERO, other)])
        # Any other token never joins WETH.
        answer = quote_answer()
        answer['quote']['route'][0][0]['tokenIn']['address'] = WETH
        self.assertRefused('route_disconnected', answer)

    def test_the_call_goes_to_the_profiles_router_2_1_2_and_carries_allowed_commands_only(self):
        self.assertRefused('router_mismatch', swap=swap_answer(to='0x' + '44' * 20))
        self.assertRefused('calldata_invalid', swap=swap_answer(data='0x12345678' + '00' * 64))
        self.assertRefused('value_mismatch', swap=swap_answer(value='0x01'))
        for command in (0x0a, 0x02, 0x05, 0x06, 0x07, 0x21, 0x90):
            with self.subTest(command=hex(command)):
                self.assertRefused('command_unsupported', swap=swap_answer(data=v4_swap(commands=bytes([0x10, command]))))
        self.assertRefused('recipient_invalid', swap=swap_answer(
            data=v4_swap(commands=bytes([0x00]), recipient='0x' + '55' * 20)))
        result, _ = leg(swap=swap_answer(data=v4_swap(commands=bytes([0x00, 0x04]))))
        self.assertEqual(result['kind'], 1)

    def test_the_router_deadline_covers_the_plan_and_stays_within_the_hour(self):
        self.assertRefused('deadline_unsuitable', swap=swap_answer(data=v4_swap(deadline=DEADLINE - 1)))
        self.assertRefused('deadline_unsuitable', swap=swap_answer(data=v4_swap(deadline=NOW + 7200)))

    def test_native_input_is_sent_as_value(self):
        native = quote_answer(token_in=ZERO, token_out=USDC)
        result, _ = leg(native, swap_answer(data=v4_swap(commands=bytes([0x0b, 0x10])), value=hex(10**9)),
                        token_in=ZERO, token_out=USDC)
        self.assertEqual(result['tokenIn'], ZERO)
        self.assertRefused('command_unsupported', quote_answer(), swap_answer(data=v4_swap(commands=bytes([0x0b, 0x10]))))

    def test_provider_failures_are_named_without_detail(self):
        for error, code in ((DataError('http_404'), 'no_route'), (DataError('http_429'), 'rate_limited'),
                            (DataError('http_401'), 'credentials_rejected'), (DataError('network_unavailable'), 'unavailable'),
                            (RuntimeError(KEY), 'unavailable')):
            with self.subTest(code=code):
                transport = Transport(error, swap_answer())
                legs = TradingApiLegs(KEY, transport=transport, clock=lambda: NOW)
                with self.assertRaises(DataError) as raised:
                    legs.leg(chain=BASE, zap=ZAP, token_in=USDC, token_out=WETH, amount_in=10**9, slippage_bps=50,
                             deadline=DEADLINE)
                self.assertEqual(str(raised.exception), 'uniswap_api_' + code)
                self.assertNotIn(KEY, str(raised.exception))

    def test_the_api_is_asked_over_kept_connections(self):
        # 3 Nov 2026: a leg's /quote and /swap, and a plan's legs, share kept HTTPS connections to the API's host.
        self.assertIs(TradingApiLegs(KEY)._transport, v2_uniswap_api.kept_json_http)
        headers = {'x-api-key': KEY, **TRADING_QUOTE_HEADERS}
        with mock.patch.object(v2_uniswap_api, 'json_http', return_value={'ok': True}) as sent:
            self.assertEqual(v2_uniswap_api.kept_json_http(TRADING_SWAP_ENDPOINT, {'quote': {}}, timeout=6,
                                                           headers=headers), {'ok': True})
        self.assertEqual(sent.call_args.args, (TRADING_SWAP_ENDPOINT, {'quote': {}}))
        self.assertEqual(sent.call_args.kwargs, {'opener': KEEPALIVE_OPENER, 'timeout': 6, 'headers': headers})


if __name__ == '__main__':
    unittest.main()
