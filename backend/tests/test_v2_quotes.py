"""v2_quotes: the calls outside the F0 exports are the deployed contracts' own, and paths encode as the zap reads them."""
import json
from pathlib import Path
import sys
import unittest

from eth_abi import decode, encode
from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import Block  # noqa: E402
import v2_quotes as quotes  # noqa: E402
from v2_chains import chain  # noqa: E402
from v2_uniswap import PoolRef  # noqa: E402

RUNTIMES = Path(__file__).resolve().parent / 'fixtures/v2-base-plan-runtimes.json'
ZERO = '0x' + '00' * 20
A, B, C = '0x' + '0a' * 20, '0x' + '0b' * 20, '0x' + '0c' * 20
BASE = chain('base-8453')


def dispatches(runtime, selector):
    """The function dispatcher compares the call's selector with PUSH4 <selector>."""
    return '63' + selector[2:] in runtime


class PublishedSelectorTests(unittest.TestCase):
    def test_the_fixtures_are_the_base_profile_code(self):
        for record in json.loads(RUNTIMES.read_text())['contracts']:
            with self.subTest(contract=record['name']):
                runtime = bytes.fromhex(record['runtime'][2:])
                self.assertEqual('0x' + keccak(runtime).hex(), BASE.verified_codehash(record['address']))

    def test_each_called_function_is_in_the_deployed_dispatcher(self):
        runtimes = {r['name']: r['runtime'] for r in json.loads(RUNTIMES.read_text())['contracts']}
        published = quotes.published_selectors()
        for name in ('QuoterV2', 'V4Quoter', 'Multicall3'):
            for signature, selector in published[name].items():
                with self.subTest(contract=name, function=signature):
                    self.assertEqual(selector, '0x' + keccak(signature.encode())[:4].hex())
                    self.assertTrue(dispatches(runtimes[name], selector))
        self.assertEqual(published['V4Quoter'], {
            'quoteExactInputSingle(((address,address,uint24,int24,address),bool,uint128,bytes))': '0xaa9d21cb',
            'quoteExactInput((address,(address,uint24,int24,address,bytes)[],uint128))': '0xca253dc9'})
        self.assertEqual(published['QuoterV2'], {'quoteExactInput(bytes,uint256)': '0xcdca1753'})


class PathTests(unittest.TestCase):
    def test_a_v3_path_is_packed_token_fee_token(self):
        first, second = PoolRef(3, A, B, 3000, 60), PoolRef(3, B, C, 500, 10)
        path = quotes.Path(3, A, (first, second))
        self.assertEqual(path.tokens, (A, B, C))
        self.assertEqual(path.leg_kind, 2)
        self.assertEqual(path.leg_data(), A + '000bb8' + B[2:] + '0001f4' + C[2:])

    def test_a_v4_path_is_abi_encoded_pool_refs(self):
        first = PoolRef(4, ZERO, A, 3000, 60)
        path = quotes.Path(4, A, (first,))
        self.assertEqual(path.token_out, ZERO)
        self.assertEqual(path.leg_kind, 3)
        decoded, = decode(['(uint8,address,address,uint24,int24,address)[]'], bytes.fromhex(path.leg_data()[2:]))
        self.assertEqual(decoded, ((4, ZERO, A, 3000, 60, ZERO),))

    def test_invalid_paths_are_refused(self):
        for dex, token, hops in ((3, A, (PoolRef(3, B, C, 3000, 60),)), (4, A, ()),
                                 (3, A, (PoolRef(4, A, B, 3000, 60),)), (4, A, (PoolRef(4, A, B, 1, 1),) * 5)):
            with self.subTest(dex=dex, hops=len(hops)), self.assertRaisesRegex(quotes.QuoteError, 'quote_path'):
                quotes.Path(dex, token, hops)

    def test_candidates_are_the_profile_tiers_and_the_standard_v4_keys(self):
        paths = quotes.candidate_paths(BASE, B, A)
        self.assertEqual([(p.dex, p.hops[0].fee, p.hops[0].tick_spacing) for p in paths],
                         [(3, 100, 1), (3, 500, 10), (3, 3000, 60), (3, 10000, 200),
                          (4, 100, 1), (4, 500, 10), (4, 3000, 60), (4, 10000, 200)])
        own = PoolRef(4, A, B, 2500, 50)
        named = quotes.candidate_paths(BASE, A, B, named=(own,), exclude=(PoolRef(3, A, B, 100, 1),))
        self.assertIn(own, [p.hops[0] for p in named])
        self.assertNotIn(PoolRef(3, A, B, 100, 1), [p.hops[0] for p in named])
        native = quotes.candidate_paths(BASE, ZERO, A)
        self.assertTrue(all(p.dex == 4 for p in native))


class FakeRpc:
    """Answers one aggregate3 eth_call with scripted (success, return data) rows."""

    def __init__(self, rows):
        self.rows, self.calls = rows, []

    def request(self, method, params):
        self.calls.append((method, params))
        payload = bytes.fromhex(params[0]['data'][10:])
        calls, = decode(['(address,bool,bytes)[]'], payload)
        self.assertion = len(calls)
        rows = self.rows[:len(calls)]
        self.rows = self.rows[len(calls):]
        return '0x' + encode(['(bool,bytes)[]'], [rows]).hex()


class QuoterTests(unittest.TestCase):
    def test_one_round_quotes_every_path_and_failures_are_none(self):
        block = Block(100, '0x' + 'ab' * 32, 1)
        v3 = quotes.Path(3, A, (PoolRef(3, A, B, 3000, 60),))
        v4 = quotes.Path(4, A, (PoolRef(4, A, B, 3000, 60),))
        rpc = FakeRpc([(True, encode(['uint256', 'uint160[]', 'uint32[]', 'uint256'], [77, [2**96], [1], 90000])),
                       (False, b''), (True, encode(['uint256', 'uint256'], [55, 80000]))])
        quoter = quotes.PoolQuoter(BASE, rpc, block)
        three = quotes.Path(4, A, (PoolRef(4, A, C, 500, 10),))
        out = quoter.quote([v3, three, v4], 1000)
        self.assertEqual(len(rpc.calls), 1)
        self.assertEqual(rpc.calls[0][1][0]['to'], BASE.multicall3)
        self.assertEqual(rpc.calls[0][1][1], block.tag)
        self.assertEqual((out[0].amount_out, out[0].sqrt_prices_after, out[0].source), (77, (2**96,), 'quoter_v2'))
        self.assertIsNone(out[1])
        self.assertEqual((out[2].amount_out, out[2].source), (55, 'v4_quoter'))
        self.assertEqual(quotes.best(out), out[0])

    def test_a_round_asked_again_at_the_block_is_answered_from_the_first(self):
        # 3 Nov 2026: a token split between two pool tokens through the same hubs asked for its first hops twice.
        block = Block(100, '0x' + 'ab' * 32, 1)
        v4 = quotes.Path(4, A, (PoolRef(4, A, B, 3000, 60),))
        rpc = FakeRpc([(True, encode(['uint256', 'uint256'], [55, 80000]))])
        quoter = quotes.PoolQuoter(BASE, rpc, block)
        first = quoter.quote([v4], 1000)
        self.assertEqual((quoter.quote([v4], 1000), quoter.quote_each([(v4, 1000)])), (first, first))
        self.assertEqual((len(rpc.calls), quoter.rounds), (1, 1))
        # Another amount is another round.
        rpc.rows = [(True, encode(['uint256', 'uint256'], [66, 80000]))]
        self.assertEqual(quoter.quote([v4], 2000)[0].amount_out, 66)
        self.assertEqual((len(rpc.calls), quoter.rounds), (2, 2))

    def test_the_quoter_calls_target_the_profile_quoters(self):
        v3 = quotes.Path(3, A, (PoolRef(3, A, B, 3000, 60),))
        target, data = quotes.quote_call(BASE, v3, 5)
        self.assertEqual((target, data[:10]), (BASE.uniswap.v3.quoterV2, '0xcdca1753'))
        v4 = quotes.Path(4, B, (PoolRef(4, A, B, 3000, 60),))
        target, data = quotes.quote_call(BASE, v4, 5)
        self.assertEqual((target, data[:10]), (BASE.uniswap.v4.quoter, '0xaa9d21cb'))
        (key, zero_for_one, amount, _), = decode(['((address,address,uint24,int24,address),bool,uint128,bytes)'],
                                                 bytes.fromhex(data[10:]))
        self.assertEqual((key[0], zero_for_one, amount), (A, False, 5))
        two = quotes.Path(4, A, (PoolRef(4, A, B, 3000, 60), PoolRef(4, B, C, 500, 10)))
        target, data = quotes.quote_call(BASE, two, 5)
        self.assertEqual(data[:10], '0xca253dc9')
        (currency, keys, amount), = decode(['(address,(address,uint24,int24,address,bytes)[],uint128)'],
                                           bytes.fromhex(data[10:]))
        self.assertEqual((currency, [k[0] for k in keys], amount), (A, [B, C], 5))


if __name__ == '__main__':
    unittest.main()
