"""read-v6's live chain reads (v2_chain_reads): the pools the app reads through the wallet, in one Multicall3 call;
balances per chain; and search over the tokens Domino knows, curated first, learning from use."""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest import mock

from fractions import Fraction
import time

from eth_abi import decode, encode
from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import v2_chain_reads as reads  # noqa: E402
from discovery import ZERO, Block, DataError  # noqa: E402
from read_deadline import check_read_deadline  # noqa: E402
from v2_chains import default_registry  # noqa: E402
from v2_read_contract import validate_v6_request_response  # noqa: E402
from v2_uniswap import PoolRef, PoolState, v3_pool_address  # noqa: E402
from v4_math import sqrt_at_tick  # noqa: E402

REGISTRY = default_registry()
BASE, ARBITRUM, ROBINHOOD = REGISTRY.chain(8453), REGISTRY.chain(42161), REGISTRY.chain(4663)
TOKEN = '0x' + '11' * 20
USDC, WETH = BASE.chargeCurrencies[0].address, BASE.wrappedNative.address
WALLET = '0x' + 'aa' * 20
BLOCK = Block(1000, '0x' + 'cd' * 32, 1_800_000_000)


def selector(signature):
    return keccak(signature.encode())[:4].hex()


class FakeChain:
    """Multicall3 over scripted answers: {(target, selector hex, argument bytes): (ok, return bytes)}. Anything else
    answers as an address without code: success with no data."""

    def __init__(self, answers=None, fail=False, delay=0):
        self.answers, self.fail, self.delay = dict(answers or {}), fail, delay
        self.requests, self.subcalls, self.batches = [], [], []

    def request(self, method, params):
        if self.fail:
            raise DataError('http_503')
        if self.delay:
            time.sleep(self.delay)
            check_read_deadline()  # as the real transports do before each call
        self.requests.append((method, params))
        calls, = decode(['(address,bool,bytes)[]'], bytes.fromhex(params[0]['data'][10:]))
        self.batches.append(len(calls))
        rows = []
        for target, _, data in calls:
            key = (target.lower(), data[:4].hex(), bytes(data[4:]))
            self.subcalls.append(key)
            rows.append(self.answers.get(key, (True, b'')))
        return '0x' + encode(['(bool,bytes)[]'], [rows]).hex()


class Follower:
    class Head:
        block = BLOCK

    def head(self):
        return self.Head()


class Endpoints:
    def __init__(self, rpc, urls=()):
        self.rpc, self.endpoints = rpc, tuple(type('E', (), {'url': url})() for url in urls)

    def read_rpc(self, *, anchor, max_requests):
        assert anchor == BLOCK and max_requests == 8
        return self.rpc


def source(chain, rpc, urls=()):
    return reads.ChainSource(chain, Endpoints(rpc, urls), Follower())


class Clock:
    def __init__(self, now=1_800_000_005.0):
        self.now = now

    def __call__(self):
        return self.now


def v4_answers(ref, sqrt, tick, liquidity, *, protocol=0, lp=None):
    pool_id = bytes.fromhex(ref.pool_id[2:])
    view = BASE.uniswap.v4.stateView
    return {(view, selector('getSlot0(bytes32)'), pool_id):
            (True, encode(['uint160', 'int24', 'uint24', 'uint24'], [sqrt, tick, protocol, ref.fee if lp is None else lp])),
            (view, selector('getLiquidity(bytes32)'), pool_id): (True, encode(['uint128'], [liquidity]))}


def v3_answers(chain, ref, sqrt, tick, liquidity, spacing=None, fee_protocol=0):
    pool = v3_pool_address(chain, ref.currency0, ref.currency1, ref.fee)
    factory = chain.uniswap.v3.factory
    return {(pool, selector('slot0()'), b''):
            (True, encode(['uint160', 'int24', 'uint16', 'uint16', 'uint16', 'uint8', 'bool'],
                          [sqrt, tick, 0, 1, 1, fee_protocol, True])),
            (pool, selector('liquidity()'), b''): (True, encode(['uint128'], [liquidity])),
            (factory, selector('feeAmountTickSpacing(uint24)'), encode(['uint24'], [ref.fee])):
            (True, encode(['int24'], [ref.tick_spacing if spacing is None else spacing]))}


ROUND = ['uint80', 'int256', 'uint256', 'uint256', 'uint80']
SNAPSHOT = {'number': BLOCK.number, 'hash': BLOCK.hash, 'timestamp': BLOCK.timestamp}


def feed_answers(chain=BASE, *, usd=4000, age=60, answer=None, up=0, up_for=86_400):
    """The profile's Chainlink ETH/USD `age` seconds old at BLOCK, and its sequencer's status (0 up) for `up_for`."""
    feed = chain.gasPrice.chainlinkEthUsd
    value = usd * 10 ** feed.decimals if answer is None else answer
    out = {(feed.proxy.lower(), selector('latestRoundData()'), b''):
           (True, encode(ROUND, [9, value, BLOCK.timestamp - age, BLOCK.timestamp - age, 9]))}
    if feed.sequencerUptimeFeed is not None:
        started = BLOCK.timestamp - up_for
        out[(feed.sequencerUptimeFeed.lower(), selector('latestRoundData()'), b'')] = (
            True, encode(ROUND, [3, up, started, started, 3]))
    return out


def eth_entry(chain=BASE, usd='4000.000000000000000000', age=60):
    return {'feed': chain.gasPrice.chainlinkEthUsd.proxy.lower(), 'usd': usd, 'roundId': '9',
            'updatedAt': BLOCK.timestamp - age}


def band_answers(chain, ref, sqrt, tick, subject, nets=None):
    """The pool's bitmap words within the band as `subject` is sold into it, `nets` ({tick: liquidityNet}) set in them,
    and those ticks' liquidity."""
    nets = nets or {}
    partner = ref.currency1 if ref.currency0 == subject else ref.currency0
    low, high = reads.band_ticks(sqrt, tick, ref.tick_spacing, partner == ref.currency1)
    bits = {}
    for initialized in nets:
        compressed = initialized // ref.tick_spacing
        bits[compressed >> 8] = bits.get(compressed >> 8, 0) | 1 << (compressed & 255)
    v3 = None if ref.dex == 4 else v3_pool_address(chain, ref.currency0, ref.currency1, ref.fee)
    pool_id = bytes.fromhex(ref.pool_id[2:]) if v3 is None else None
    out = {}
    for position in range(low >> 8, (high >> 8) + 1):
        key = ((chain.uniswap.v4.stateView, selector('getTickBitmap(bytes32,int16)'),
                encode(['bytes32', 'int16'], [pool_id, position])) if v3 is None else
               (v3, selector('tickBitmap(int16)'), encode(['int16'], [position])))
        out[key] = (True, encode(['uint256'], [bits.get(position, 0)]))
    for initialized, net in nets.items():
        if v3 is None:
            out[(chain.uniswap.v4.stateView, selector('getTickLiquidity(bytes32,int24)'),
                 encode(['bytes32', 'int24'], [pool_id, initialized]))] = (True, encode(['uint128', 'int128'], [abs(net), net]))
        else:
            out[(v3, selector('ticks(int24)'), encode(['int24'], [initialized]))] = (True, encode(
                ['uint128', 'int128', 'uint256', 'uint256', 'int56', 'uint160', 'uint32', 'bool'],
                [abs(net), net, 0, 0, 0, 0, 0, True]))
    return out


def metadata(token, decimals=18, symbol='TKN', name='Token'):
    return {(token, selector('decimals()'), b''): (True, encode(['uint8'], [decimals])),
            (token, selector('symbol()'), b''): (True, encode(['string'], [symbol])),
            (token, selector('name()'), b''): (True, encode(['string'], [name]))}


def chain_reads(sources, *, learned=None, index_tokens=None, clock=None, monotonic=None, token_list=None):
    listed = token_list or ({'name': 'Uniswap Labs Default', 'version': '22.24.0', 'sha256': 'ab' * 32},
                            {8453: [('0x' + '22' * 20, 'AERO', 'Aerodrome Finance', 18),
                                    ('0x' + '33' * 20, 'cbBTC', 'Coinbase Wrapped BTC', 8),
                                    (USDC, 'USDC', 'USD Coin', 6)], 42161: []})
    return reads.ChainReads(sources, token_list=listed, learned=learned or reads.LearnedTokens(),
                            index_tokens=index_tokens, clock=clock or Clock(),
                            monotonic=monotonic or Clock(0.0), registry=REGISTRY)


class PoolTests(unittest.TestCase):
    def test_the_apps_pools_in_one_multicall_listed_priced_and_with_liquidity_partners_first(self):
        eth = PoolRef(4, ZERO, TOKEN, 3000, 60)
        usdc_empty = PoolRef(4, TOKEN, USDC, 500, 10)
        weth_v3 = PoolRef(3, TOKEN, WETH, 500, 10) if TOKEN < WETH else PoolRef(3, WETH, TOKEN, 500, 10)
        extra = PoolRef(3, *sorted((TOKEN, WETH)), 300, 6)
        disabled = PoolRef(3, *sorted((TOKEN, WETH)), 400, 8)
        usdc_v3 = PoolRef(3, *sorted((TOKEN, USDC)), 3000, 60)
        answers = {**v4_answers(eth, 2**96, 0, 500, protocol=(300 << 12) | 200),
                   **v4_answers(usdc_empty, 2**96, 0, 0),
                   **v3_answers(BASE, weth_v3, 2**96, 5, 900, fee_protocol=0x44), **v3_answers(BASE, extra, 2**96, 5, 50),
                   **v3_answers(BASE, disabled, 2**96, 5, 70, spacing=0),
                   **v3_answers(BASE, usdc_v3, 2**96, 7, 10_000), **metadata(TOKEN), **feed_answers()}
        for ref, tick in ((eth, 0), (weth_v3, 5), (extra, 5), (usdc_v3, 7)):
            answers.update(band_answers(BASE, ref, 2**96, tick, TOKEN))
        chain = FakeChain(answers)
        learned = reads.LearnedTokens()
        answer = chain_reads({8453: source(BASE, chain)}, learned=learned).pools(8453, TOKEN)
        validate_v6_request_response('chain-pools', {'chainId': 8453, 'token': TOKEN, 'pairedToken': None}, answer)
        # The first call: 26 pools (two reads each), 7 tiers' spacings, the token's metadata, the feed and its
        # sequencer; then the listed pools' bitmap words within the band (no initialized tick, so no third).
        self.assertEqual(chain.batches[0], 26 * 2 + 7 + 3 + 2)
        self.assertEqual(len(chain.requests), 2)
        self.assertEqual(chain.requests[0][1][0]['to'], BASE.multicall3)
        listed = [(p['pool']['dex'], p['pool']['fee'], p['liquidity']) for p in answer['pools']]
        # ETH and WETH partners first (by liquidity), then the stable: empty, unpriced and disabled tiers left out.
        self.assertEqual(listed, [(3, 500, '900'), (4, 3000, '500'), (3, 300, '50'), (3, 3000, '10000')])
        v4 = answer['pools'][1]
        self.assertEqual((v4['id'], v4['address'], v4['lpFeePips'], v4['protocolFee']),
                         (eth.pool_id, None, 3000, (300 << 12) | 200))
        state = PoolState(eth, BLOCK, None, eth.pool_id, 2**96, 0, 500, 3000, (300 << 12) | 200)
        self.assertEqual(v4['swapFeePips'], {'zeroForOne': state.swap_fee_pips(True), 'oneForZero': state.swap_fee_pips(False)})
        v3 = answer['pools'][0]
        # v3's protocol fee (4 bits a side) is a share of the LP fee: a swap pays the tier.
        self.assertEqual((v3['id'], v3['address'], v3['protocolFee'], v3['swapFeePips']),
                         (None, v3_pool_address(BASE, *sorted((TOKEN, WETH)), 500), 0x44, {'zeroForOne': 500, 'oneForZero': 500}))
        # Each listed pool measured against its partner; all too shallow to price the token.
        self.assertEqual([(p['market']['status'], p['market']['reference']) for p in answer['pools']],
                         [('measured', WETH), ('measured', ZERO), ('measured', WETH), ('measured', USDC)])
        prices = {t['address']: (t['price'] and t['price']['source'], t['priceReason']) for t in answer['tokens']}
        self.assertEqual(prices, {ZERO: ('chainlink_eth_usd', None), WETH: ('chainlink_eth_usd', None),
                                  USDC: ('chain_stable', None), TOKEN: (None, 'pool_depth_below_floor')})
        self.assertEqual(answer['snapshot'], {'number': 1000, 'hash': BLOCK.hash, 'timestamp': BLOCK.timestamp})
        self.assertEqual((answer['servedAt'], answer['freshness']), (1_800_000_005, {'ageSeconds': 5, 'status': 'fresh'}))
        tokens = {t['address']: (t['symbol'], t['decimals'], t['status']) for t in answer['tokens']}
        self.assertEqual(tokens, {ZERO: ('ETH', 18, 'available'), TOKEN: ('TKN', 18, 'available'),
                                  USDC: ('USDC', 6, 'available'), WETH: ('WETH', 18, 'available')})
        self.assertEqual([t['address'] for t in answer['tokens']], sorted(tokens))
        # Priced pools found: the token becomes searchable on Base.
        self.assertEqual(learned.tokens(8453), [(TOKEN, 'TKN', 'Token', 18)])

    def test_a_paired_token_native_eth_and_pools_out_of_shape(self):
        chain = FakeChain({**metadata(TOKEN, symbol='ok')})
        reader = chain_reads({8453: source(BASE, chain)})
        answer = reader.pools(8453, TOKEN, USDC)
        validate_v6_request_response('chain-pools', {'chainId': 8453, 'token': TOKEN, 'pairedToken': USDC}, answer)
        # Its pools against USDC alone; then the token priced by the pricer, from all its pools against the base
        # currencies (its decimals already read).
        self.assertEqual(chain.batches, [(4 + 7) * 2 + 7 + 3 + 2, 26 * 2 + 7 + 2])
        self.assertEqual((answer['pairedToken'], answer['pools'], answer['truncated']), (USDC, [], False))
        # ETH itself: v4 only, its pairs ETH/WETH skipped.
        native = FakeChain()
        chain_reads({8453: source(BASE, native)}).pools(8453, ZERO)
        self.assertEqual(len(native.subcalls), 4 * 2 + 2)  # and the feed with its sequencer
        # A v4 protocol fee or LP fee out of range, or a price outside the range, is no listed pool.
        refs = [PoolRef(4, ZERO, TOKEN, fee, spacing) for fee, spacing in ((100, 1), (500, 10), (3000, 60), (10000, 200))]
        bad = FakeChain({**v4_answers(refs[0], 2**96, 0, 5, protocol=1001), **v4_answers(refs[1], 2**96, 0, 5, lp=10**6 + 1),
                         **v4_answers(refs[2], 0, 0, 5), **v4_answers(refs[3], 2**96, 900_000, 5), **metadata(TOKEN)})
        self.assertEqual(chain_reads({8453: source(BASE, bad)}).pools(8453, TOKEN, ZERO)['pools'], [])

    def test_answers_are_cached_a_few_seconds_and_a_chain_without_endpoints_is_unavailable(self):
        chain, monotonic = FakeChain(metadata(TOKEN)), Clock(0.0)
        reader = chain_reads({8453: source(BASE, chain)}, monotonic=monotonic)
        reader.pools(8453, TOKEN)
        monotonic.now = reads.POOLS_CACHE_SECONDS
        reader.pools(8453, TOKEN)
        self.assertEqual(len(chain.requests), 1)
        monotonic.now = reads.POOLS_CACHE_SECONDS + 0.5
        reader.pools(8453, TOKEN)
        self.assertEqual(len(chain.requests), 2)
        with self.assertRaisesRegex(DataError, '^upstream_unavailable$'):
            reader.pools(42161, TOKEN)

    def test_a_readable_token_without_pools_is_not_learned(self):
        learned = reads.LearnedTokens()
        chain_reads({8453: source(BASE, FakeChain(metadata(TOKEN)))}, learned=learned).pools(8453, TOKEN)
        self.assertEqual(learned.tokens(8453), [])

    def test_freshness_is_the_blocks_age_fresh_up_to_a_minute(self):
        clock = Clock(BLOCK.timestamp + reads.FRESH_SECONDS)
        reader = chain_reads({8453: source(BASE, FakeChain(metadata(TOKEN)))}, clock=clock)
        self.assertEqual(reader.pools(8453, TOKEN)['freshness'], {'ageSeconds': 60, 'status': 'fresh'})
        clock.now += 1
        self.assertEqual(reader.pools(8453, TOKEN)['freshness'], {'ageSeconds': 61, 'status': 'stale'})
        clock.now = BLOCK.timestamp - 3  # a block stamped ahead of this clock is age 0, never negative
        self.assertEqual(reader.pools(8453, TOKEN)['freshness'], {'ageSeconds': 0, 'status': 'fresh'})

    def test_a_token_with_pools_but_unreadable_metadata_is_not_learned(self):
        ref = PoolRef(4, ZERO, TOKEN, 3000, 60)
        for missing in ('symbol()', 'decimals()'):
            answers = {**v4_answers(ref, 2**96, 0, 500), **metadata(TOKEN)}
            answers[(TOKEN, selector(missing), b'')] = (False, b'')
            learned = reads.LearnedTokens()
            answer = chain_reads({8453: source(BASE, FakeChain(answers))}, learned=learned).pools(8453, TOKEN)
            with self.subTest(missing=missing):
                self.assertEqual(len(answer['pools']), 1)
                self.assertEqual(next(t for t in answer['tokens'] if t['address'] == TOKEN)['status'], 'partial')
                self.assertEqual(learned.tokens(8453), [])

    def test_more_pools_than_the_contract_carries_are_cut_and_said_so(self):
        refs = [PoolRef(4, ZERO, TOKEN, fee, spacing) for fee, spacing in ((100, 1), (500, 10), (3000, 60))]
        answers = {**metadata(TOKEN)}
        for liquidity, ref in enumerate(refs, 1):
            answers.update(v4_answers(ref, 2**96, 0, liquidity))
        with mock.patch.object(reads, 'MAX_CHAIN_POOLS', 2):
            answer = chain_reads({8453: source(BASE, FakeChain(answers))}).pools(8453, TOKEN, ZERO)
        validate_v6_request_response('chain-pools', {'chainId': 8453, 'token': TOKEN, 'pairedToken': ZERO}, answer)
        self.assertEqual(([p['liquidity'] for p in answer['pools']], answer['truncated']), (['3', '2'], True))

    def test_unreadable_metadata_is_unavailable_and_nothing_is_learned_without_pools(self):
        chain = FakeChain({(TOKEN, selector('decimals()'), b''): (True, encode(['uint8'], [6])),
                           (TOKEN, selector('symbol()'), b''): (True, encode(['string'], [' padded']))})
        learned = reads.LearnedTokens()
        answer = chain_reads({8453: source(BASE, chain)}, learned=learned).pools(8453, TOKEN)
        token = next(t for t in answer['tokens'] if t['address'] == TOKEN)
        self.assertEqual((token['decimals'], token['symbol'], token['status']), (6, None, 'partial'))
        self.assertEqual(learned.tokens(8453), [])


class BalanceTests(unittest.TestCase):
    def test_each_chains_base_currencies_by_default_one_call_a_chain(self):
        base, arbitrum = FakeChain({
            (BASE.multicall3, selector('getEthBalance(address)'), encode(['address'], [WALLET])): (True, encode(['uint256'], [7])),
            (USDC, selector('balanceOf(address)'), encode(['address'], [WALLET])): (True, encode(['uint256'], [5])),
            (WETH, selector('balanceOf(address)'), encode(['address'], [WALLET])): (False, b'')}), FakeChain(fail=True)
        answer = chain_reads({8453: source(BASE, base), 42161: source(ARBITRUM, arbitrum)}).balances(WALLET)
        validate_v6_request_response('chain-balances', {'wallet': WALLET, 'tokens': None}, answer)
        self.assertEqual([c['chainId'] for c in answer['chains']], [4663, 8453, 42161])
        robinhood, on_base, on_arbitrum = answer['chains']
        self.assertEqual((robinhood['status'], robinhood['reason']), ('unavailable', 'chain_not_configured'))
        self.assertEqual((on_arbitrum['status'], on_arbitrum['reason']), ('unavailable', 'chain_read_failed'))
        self.assertTrue(all(b['balanceRaw'] is None and b['status'] == 'unavailable' for b in on_arbitrum['balances']))
        # One call for the balances, one for their prices (the base currencies need the feed alone).
        self.assertEqual(base.batches, [3, 2])
        rows = {b['address']: (b['symbol'], b['decimals'], b['balanceRaw'], b['status']) for b in on_base['balances']}
        self.assertEqual(rows, {USDC: ('USDC', 6, '5', 'read'), ZERO: ('ETH', 18, '7', 'read'),
                                WETH: ('WETH', 18, None, 'unavailable')})
        self.assertEqual([b['address'] for b in on_base['balances']], [USDC, ZERO, WETH])  # the base currencies' order
        self.assertEqual((answer['coverage'], answer['wallet']), ('partial', WALLET))

    def test_a_failed_chain_read_is_never_cached(self):
        chain, monotonic = FakeChain(fail=True), Clock(0.0)
        reader = chain_reads({8453: source(BASE, chain)}, monotonic=monotonic)
        self.assertEqual(reader.balances(WALLET, [(8453, TOKEN)])['chains'][0]['reason'], 'chain_read_failed')
        chain.fail = False
        self.assertEqual(reader.balances(WALLET, [(8453, TOKEN)])['chains'][0]['status'], 'current')

    def test_asked_tokens_with_their_metadata_cached_while_current(self):
        chain, monotonic = FakeChain({
            (TOKEN, selector('balanceOf(address)'), encode(['address'], [WALLET])): (True, encode(['uint256'], [3])),
            **metadata(TOKEN, decimals=8, symbol='WBTC')}), Clock(0.0)
        reader = chain_reads({8453: source(BASE, chain)}, monotonic=monotonic)
        answer = reader.balances(WALLET, [(8453, TOKEN), (8453, TOKEN)])
        validate_v6_request_response('chain-balances', {'wallet': WALLET, 'tokens': [{'chainId': 8453, 'address': TOKEN}]},
                                     answer)
        self.assertEqual(answer['chains'][0]['balances'],
                         [{'address': TOKEN, 'symbol': 'WBTC', 'decimals': 8, 'balanceRaw': '3', 'status': 'read',
                           'price': None, 'priceReason': 'no_pool', 'valueUsd': None}])
        self.assertEqual((answer['coverage'], answer['chains'][0]['totalUsd'], answer['totalUsd']), ('complete', None, None))
        reader.balances(WALLET, [(8453, TOKEN)])
        self.assertEqual(len(chain.requests), 2)  # the balances and the token's price
        monotonic.now = reads.BALANCES_CACHE_SECONDS + 1
        reader.balances(WALLET, [(8453, TOKEN)])
        self.assertEqual(len(chain.requests), 3)  # the balances again; the price kept


class SearchTests(unittest.TestCase):
    def reader(self, **options):
        return chain_reads({8453: source(BASE, FakeChain())}, **options)

    def test_exact_symbol_then_prefix_then_a_name_word_then_anywhere_curated_first(self):
        learned = reads.LearnedTokens()
        learned.learn(8453, '0x' + '44' * 20, 'AEROX', 'Aerox', 18)
        learned.learn(8453, '0x' + '55' * 20, 'XYZ', 'Not Aero', 18)
        answer = self.reader(learned=learned).tokens(8453, ' aero ', 20)
        validate_v6_request_response('chain-tokens', {'chainId': 8453, 'query': ' aero ', 'limit': 20}, answer)
        self.assertEqual([(t['symbol'], t['sources']) for t in answer['tokens']],
                         [('AERO', ['uniswap_default_list']), ('AEROX', ['looked_up']), ('XYZ', ['looked_up'])])
        self.assertEqual((answer['query'], answer['coverage'], answer['truncated']), (' aero ', 'known_tokens_only', False))
        self.assertEqual(answer['tokenList'], {'name': 'Uniswap Labs Default', 'version': '22.24.0', 'sha256': 'ab' * 32})
        coin = self.reader().tokens(8453, 'coin', 20)['tokens']
        # Both by a word of the name: the profile's USDC before the list's cbBTC.
        self.assertEqual([t['symbol'] for t in coin], ['USDC', 'cbBTC'])
        # The profile's USDC is the list's too; one entry, both sources, the profile first.
        usdc, = self.reader().tokens(8453, 'usdc', 20)['tokens']
        self.assertEqual((usdc['address'], usdc['sources'], usdc['name']), (USDC, ['profile', 'uniswap_default_list'], 'USD Coin'))
        self.assertEqual(self.reader().tokens(8453, 'btc', 20)['tokens'][0]['symbol'], 'cbBTC')  # anywhere

    def test_a_better_match_ranks_first_whatever_its_source(self):
        learned = reads.LearnedTokens()
        learned.learn(8453, '0x' + '44' * 20, 'AER', 'Other', 18)  # exact, looked up
        learned.learn(8453, '0x' + '45' * 20, 'ZZZ', 'Drome Aerial', 18)  # a word of its name, looked up
        found = self.reader(learned=learned).tokens(8453, 'aer', 20)['tokens']
        self.assertEqual([t['symbol'] for t in found], ['AER', 'AERO', 'ZZZ'])
        # A word of a name (ZZZ, looked up) before a match anywhere (AERO's "Aerodrome", from the list).
        self.assertEqual([t['symbol'] for t in self.reader(learned=learned).tokens(8453, 'drome', 20)['tokens']],
                         ['ZZZ', 'AERO'])

    def test_an_address_matches_exactly_the_limit_truncates_and_index_failures_are_skipped(self):
        by_address = self.reader().tokens(8453, '0x' + '22' * 20, 20)['tokens']
        self.assertEqual([t['symbol'] for t in by_address], ['AERO'])
        self.assertEqual(self.reader().tokens(8453, '0x' + '99' * 20, 20)['tokens'], [])
        answer = self.reader().tokens(8453, 'e', 2)
        self.assertEqual((len(answer['tokens']), answer['truncated']), (2, True))
        asked = []

        def index(chain_id, limit):
            asked.append((chain_id, limit))
            # Each row past the first would match, but is out of shape: the address, the symbol, the decimals.
            return [('0x' + '66' * 20, 18, 'IDX'), ('0X' + '88' * 20, 18, 'IDXA'), ('0x' + '77' * 20, 18, 'IDX\n'),
                    ('0x' + '79' * 20, 256, 'IDXB'), ('0x' + '7a' * 20, True, 'IDXC')]
        reader = self.reader(index_tokens=index)
        answer = reader.tokens(8453, 'idx', 20)
        validate_v6_request_response('chain-tokens', {'chainId': 8453, 'query': 'idx', 'limit': 20}, answer)
        found = answer['tokens']
        self.assertEqual([(t['symbol'], t['sources']) for t in found], [('IDX', ['v2_activity'])])
        reader.tokens(8453, 'idx', 20)
        self.assertEqual(asked, [(8453, reads.MAX_INDEX_TOKENS)])  # cached

        def broken(chain_id, limit):
            raise DataError('catalogue_database_unavailable')
        self.assertEqual([t['symbol'] for t in self.reader(index_tokens=broken).tokens(8453, 'aero', 20)['tokens']],
                         ['AERO'])


class CacheTests(unittest.TestCase):
    def test_entries_expire_after_their_seconds_and_the_oldest_go_past_the_bound(self):
        clock = Clock(0.0)
        cache = reads.TimedCache(10, clock=clock, limit=2)
        cache.put('a', 1)
        cache.put('b', 2)
        cache.get('a')
        cache.put('c', 3)
        self.assertEqual((cache.get('a'), cache.get('b'), cache.get('c')), (None, 2, 3))  # put order, not use
        clock.now = 10
        self.assertEqual(cache.get('c'), 3)
        clock.now = 10.5
        self.assertIsNone(cache.get('c'))


class LearnedTokenTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix='domino-learned-')).resolve()
        self.addCleanup(shutil.rmtree, self.directory)
        self.path = self.directory / 'v2-learned-tokens.json'

    def test_kept_across_restarts_the_least_recent_first_out(self):
        learned = reads.LearnedTokens(self.path, limit=2)
        for index in range(3):
            learned.learn(8453, '0x' + f'{index + 1:02x}' * 20, f'T{index}', None, 18)
        learned.learn(8453, '0x' + '02' * 20, 'T1', 'One', 18)  # seen again: the most recent now
        learned.learn(4663, '0x' + '09' * 20, 'RH', None, 18)  # not a search chain
        self.assertEqual([entry[0] for entry in learned.tokens(8453)], ['0x' + '03' * 20, '0x' + '02' * 20])
        self.assertEqual(len(json.loads(self.path.read_text())['8453']), 2)
        again = reads.LearnedTokens(self.path, limit=2)
        self.assertEqual(again.tokens(8453), [('0x' + '03' * 20, 'T2', None, 18), ('0x' + '02' * 20, 'T1', 'One', 18)])
        self.assertEqual(again.tokens(4663), [])
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)

    def test_an_unreadable_or_tampered_file_is_ignored_entry_by_entry(self):
        self.path.write_text('{')
        self.assertEqual(reads.LearnedTokens(self.path).tokens(8453), [])
        self.path.write_text(json.dumps({'8453': [['0x' + '01' * 20, 'OK', None, 6], ['0x' + '02' * 20, '\x00', None, 6],
                                                  ['0X' + '03' * 20, 'UP', None, 6], ['0x' + '04' * 20, 'D', None, 256]]}))
        self.assertEqual(reads.LearnedTokens(self.path).tokens(8453), [('0x' + '01' * 20, 'OK', None, 6)])
        # A file kept under a larger bound: its most recent entries.
        self.path.write_text(json.dumps({'8453': [['0x' + f'{i:02x}' * 20, f'T{i}', None, 6] for i in (1, 2, 3)]}))
        self.assertEqual([entry[0] for entry in reads.LearnedTokens(self.path, limit=2).tokens(8453)],
                         ['0x' + '02' * 20, '0x' + '03' * 20])


class TokenListTests(unittest.TestCase):
    def test_the_pinned_list_loads_with_its_provenance(self):
        source, listed = reads.load_token_list()
        self.assertEqual(source['name'], 'Uniswap Labs Default')
        self.assertTrue(listed[8453] and listed[42161])
        document = json.loads(reads.TOKEN_LIST.read_text())
        self.assertEqual(document['source']['license'], 'GPL-3.0')
        self.assertTrue((reads.TOKEN_LIST.parent / document['source']['licenseFile']).is_file())

    def test_a_list_out_of_shape_is_refused(self):
        document = json.loads(reads.TOKEN_LIST.read_text())
        directory = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, directory)
        token = document['tokens'][0]
        cases = {'kind': {**document, 'kind': 'x'}, 'license': {**document, 'source': {**document['source'], 'license': 'MIT'}},
                 'chains': {**document, 'chains': [8453]},
                 'symbol': {**document, 'tokens': [{**token, 'symbol': 'a\nb'}]},
                 'duplicate': {**document, 'tokens': [token, token]},
                 'decimals': {**document, 'tokens': [{**token, 'decimals': True}]},
                 'address': {**document, 'tokens': [{**token, 'address': token['address'].upper()}]}}
        for name, case in cases.items():
            path = directory / f'{name}.json'
            path.write_text(json.dumps(case))
            with self.subTest(case=name), self.assertRaisesRegex(DataError, '^token_list_invalid$'):
                reads.load_token_list(path)


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix='domino-build-')).resolve()
        self.addCleanup(shutil.rmtree, self.directory)
        os.chmod(self.directory, 0o700)

    def chain_rpc_file(self, chains):
        entry = {'name': 'stack', 'host': 'stack.example.invalid', 'url': 'https://stack.example.invalid/k', 'archive': True,
                 'maxBatchItems': 50, 'maxLogBlocks': 10000, 'requestsPerSecond': None}
        path = self.directory / 'chain-rpc.json'
        path.write_text(json.dumps({'schemaVersion': 1, 'kind': 'domino-v2-chain-rpc',
                                    'chains': {key: {'endpoints': [entry]} for key in chains}}))
        path.chmod(0o600)
        return str(path)

    def test_each_chain_with_endpoints_and_robinhood_only_with_the_provider_file(self):
        built = reads.build_chain_reads(provider_config=None, chain_rpc_file=self.chain_rpc_file(('base-8453',)),
                                        learned_path=self.directory / 'learned.json', registry=REGISTRY)
        self.assertEqual(sorted(built.sources), [8453])
        self.assertEqual(built.sources[8453].endpoints.chain.chainId, 8453)
        self.assertEqual(built.sources[8453].follower.max_age, reads.HEAD_MAX_AGE_SECONDS)
        none = reads.build_chain_reads(provider_config=None, chain_rpc_file=None, learned_path=None, registry=REGISTRY)
        self.assertEqual(none.sources, {})
        with self.assertRaises(DataError):
            reads.build_chain_reads(provider_config=None, chain_rpc_file=str(self.directory / 'absent.json'),
                                    learned_path=None, registry=REGISTRY)



ROBINHOOD_STABLE = ROBINHOOD.chargeCurrencies[0].address


def featured_depth(ref, sqrt, tick, liquidity, subject, nets=None):
    """The featured pools' own walk (featured_pools.reference_depth), the rule these prices reuse."""
    from featured_pools import reference_depth
    nets = nets or {}
    partner = ref.currency1 if ref.currency0 == subject else ref.currency0
    bits = {}
    for initialized in nets:
        compressed = initialized // ref.tick_spacing
        bits[compressed >> 8] = bits.get(compressed >> 8, 0) | 1 << (compressed & 255)
    return reference_depth(lambda position: bits.get(position, 0), lambda at: nets[at], sqrt_price=sqrt, tick=tick,
                           liquidity=liquidity, tick_spacing=ref.tick_spacing,
                           reference_is_currency1=partner == ref.currency1, band=Fraction(1, 10), max_steps=300)


def spot(ref, sqrt, token, decimals, partner_decimals):
    ratio = Fraction(sqrt * sqrt, 1 << 192)
    return (ratio if ref.currency0 == token else 1 / ratio) * Fraction(10 ** decimals, 10 ** partner_decimals)


class PriceTests(unittest.TestCase):
    """Qualified USD (0xdecimal's item 4): the owner's decision #22 of 2 Oct 2026 and answers of 5 Oct 2026."""

    def pricer(self, answers, chain=BASE, **options):
        fake = FakeChain(answers, **options)
        return reads.Pricer({chain.chainId: source(chain, fake)}, monotonic=Clock(0.0)), fake

    # A token against USDC (v4) and WETH (v3), both near US$ 2; the WETH pool the deeper.
    USDC_POOL = PoolRef(4, *sorted((TOKEN, USDC)), 500, 10)
    WETH_POOL = PoolRef(3, *sorted((TOKEN, WETH)), 500, 10)

    def token_answers(self, usdc_liquidity=2 * 10**17, weth_liquidity=6_500 * 10**18, feed=None):
        usdc_tick, weth_tick = -269_390, -76_010
        out = {**v4_answers(self.USDC_POOL, sqrt_at_tick(usdc_tick), usdc_tick, usdc_liquidity),
               **v3_answers(BASE, self.WETH_POOL, sqrt_at_tick(weth_tick), weth_tick, weth_liquidity),
               **band_answers(BASE, self.USDC_POOL, sqrt_at_tick(usdc_tick), usdc_tick, TOKEN),
               **band_answers(BASE, self.WETH_POOL, sqrt_at_tick(weth_tick), weth_tick, TOKEN),
               **(feed_answers() if feed is None else feed)}
        return out

    def test_the_stable_is_a_dollar_and_eth_and_weth_the_feed(self):
        pricer, fake = self.pricer(feed_answers())
        got = pricer.prices([(8453, USDC, None), (8453, ZERO, None), (8453, WETH, None)])
        self.assertEqual(got[(8453, USDC)], ({'usd': '1.000000000000000000', 'source': 'chain_stable', 'snapshot': None,
                                              'ethUsd': None, 'pool': None, 'depthUsd': None}, None))
        for token in (ZERO, WETH):
            self.assertEqual(got[(8453, token)], ({'usd': '4000.000000000000000000', 'source': 'chainlink_eth_usd',
                                                   'snapshot': SNAPSHOT, 'ethUsd': eth_entry(), 'pool': None,
                                                   'depthUsd': None}, None))
        self.assertEqual(fake.batches, [2])  # the feed and its sequencer, nothing else

    def test_the_feed_within_its_heartbeat_positive_and_readable(self):
        heartbeat = BASE.gasPrice.chainlinkEthUsd.heartbeatSeconds
        unreadable = {key: value for key, value in feed_answers().items()
                      if key[0] != BASE.gasPrice.chainlinkEthUsd.proxy.lower()}
        for case, answers, reason in (('at its heartbeat', feed_answers(age=heartbeat), None),
                                      ('past its heartbeat', feed_answers(age=heartbeat + 1), 'eth_usd_stale'),
                                      ('ahead of the block', feed_answers(age=-1), 'eth_usd_stale'),
                                      ('zero', feed_answers(answer=0), 'eth_usd_stale'),
                                      ('negative', feed_answers(answer=-1), 'eth_usd_stale'),
                                      ('unreadable', unreadable, 'price_read_failed')):
            with self.subTest(case=case):
                self.assertEqual(self.pricer(answers)[0].prices([(8453, WETH, None)])[(8453, WETH)][1], reason)

    def test_the_sequencer_up_past_its_grace_or_only_the_stable_keeps_a_price(self):
        grace = reads.SEQUENCER_GRACE_SECONDS
        unreadable = {key: value for key, value in feed_answers().items()
                      if key[0] != BASE.gasPrice.chainlinkEthUsd.sequencerUptimeFeed.lower()}
        for case, answers, reason in (('up past its grace', feed_answers(up_for=grace + 1), None),
                                      ('up for its grace only', feed_answers(up_for=grace), 'sequencer_down'),
                                      ('down', feed_answers(up=1), 'sequencer_down'),
                                      ('never started', feed_answers(up_for=BLOCK.timestamp), 'sequencer_down'),
                                      ('unreadable', unreadable, 'price_read_failed')):
            with self.subTest(case=case):
                self.assertEqual(self.pricer(answers)[0].prices([(8453, ZERO, None)])[(8453, ZERO)][1], reason)
        # Down: a token whose pools would price it has no price, the stable keeps US$ 1.
        pricer, _ = self.pricer(self.token_answers(feed=feed_answers(up=1)))
        got = pricer.prices([(8453, TOKEN, 18), (8453, USDC, None)])
        self.assertEqual(got[(8453, TOKEN)], (None, 'sequencer_down'))
        self.assertEqual(got[(8453, USDC)][0]['usd'], '1.000000000000000000')
        only_stable = {**self.token_answers(feed=feed_answers(up=1))}
        only_stable.update(v3_answers(BASE, self.WETH_POOL, sqrt_at_tick(-76_010), -76_010, 0))
        self.assertEqual(self.pricer(only_stable)[0].prices([(8453, TOKEN, 18)])[(8453, TOKEN)], (None, 'sequencer_down'))
        # Robinhood publishes no uptime feed: its feed alone decides.
        robinhood, _ = self.pricer(feed_answers(ROBINHOOD), chain=ROBINHOOD)
        price, reason = robinhood.prices([(4663, ZERO, None)])[(4663, ZERO)]
        self.assertEqual((price['ethUsd']['feed'], reason), (ROBINHOOD.gasPrice.chainlinkEthUsd.proxy.lower(), None))

    def test_a_token_at_its_deepest_pool_above_the_floor(self):
        pricer, fake = self.pricer(self.token_answers())
        price, reason = pricer.prices([(8453, TOKEN, 18)])[(8453, TOKEN)]
        sqrt = sqrt_at_tick(-76_010)
        depth = Fraction(featured_depth(self.WETH_POOL, sqrt, -76_010, 6_500 * 10**18, TOKEN), 10**18) * 4000
        usd = spot(self.WETH_POOL, sqrt, TOKEN, 18, 18) * 4000
        self.assertIsNone(reason)
        self.assertEqual(price, {'usd': reads.decimal_text(usd, reads.PRICE_SCALE), 'source': 'pool', 'snapshot': SNAPSHOT,
                                 'ethUsd': eth_entry(), 'pool': reads.pool_wire(self.WETH_POOL),
                                 'depthUsd': reads.decimal_text(depth, reads.USD_SCALE)})
        self.assertTrue(29_000 < depth < 31_000 and Fraction(199, 100) < usd < Fraction(201, 100))
        # Three rounds: the pools, their words within the band, nothing initialized to read in them.
        self.assertEqual(len(fake.requests), 2)
        # The deeper pool against the stable instead: no feed round in its price.
        pricer, _ = self.pricer(self.token_answers(usdc_liquidity=2 * 10**18))
        price, _ = pricer.prices([(8453, TOKEN, 18)])[(8453, TOKEN)]
        self.assertEqual((price['pool'], price['ethUsd']), (reads.pool_wire(self.USDC_POOL), None))
        usd = spot(self.USDC_POOL, sqrt_at_tick(-269_390), TOKEN, 18, 6)
        self.assertEqual(price['usd'], reads.decimal_text(usd, reads.PRICE_SCALE))
        self.assertTrue(Fraction(199, 100) < usd < Fraction(201, 100))

    def test_a_token_above_its_partner_in_the_pool_is_priced_the_other_way_round(self):
        # HIGH sorts above USDC, so it is currency1: the pool's price is HIGH per USDC, and a HIGH is about US$ 3.
        high = '0x' + 'f1' * 20
        ref = PoolRef(4, USDC, high, 500, 10)
        tick = 265_180
        answers = {**v4_answers(ref, sqrt_at_tick(tick), tick, 3 * 10**17),
                   **band_answers(BASE, ref, sqrt_at_tick(tick), tick, high), **feed_answers()}
        price, reason = self.pricer(answers)[0].prices([(8453, high, 18)])[(8453, high)]
        self.assertIsNone(reason)
        usd = spot(ref, sqrt_at_tick(tick), high, 18, 6)
        self.assertEqual(price['usd'], reads.decimal_text(usd, reads.PRICE_SCALE))
        self.assertTrue(Fraction(29, 10) < usd < Fraction(32, 10), price['usd'])  # about US$ 3, not its inverse
        self.assertTrue(Fraction(price['depthUsd']) >= reads.FLOOR_USD)

    def test_a_pool_at_the_floor_exactly_prices(self):
        sqrt = sqrt_at_tick(-76_010)
        depth = Fraction(featured_depth(self.WETH_POOL, sqrt, -76_010, 6_500 * 10**18, TOKEN), 10**18) * 4000
        answers = self.token_answers()
        answers.update(v4_answers(self.USDC_POOL, sqrt_at_tick(-269_390), -269_390, 0))
        for floor, priced in ((depth, True), (depth + Fraction(1, 10**30), False)):
            with self.subTest(floor=float(floor)), mock.patch.object(reads, 'FLOOR_USD', floor):
                price, reason = self.pricer(answers)[0].prices([(8453, TOKEN, 18)])[(8453, TOKEN)]
                self.assertEqual(price is not None, priced, reason)

    def test_without_a_pool_above_the_floor_a_token_says_why(self):
        heartbeat = BASE.gasPrice.chainlinkEthUsd.heartbeatSeconds
        shallow = self.token_answers(usdc_liquidity=10**15, weth_liquidity=10**18)
        only_weth = {key: value for key, value in self.token_answers(feed=feed_answers(age=heartbeat + 1)).items()}
        only_weth.update(v4_answers(self.USDC_POOL, sqrt_at_tick(-269_390), -269_390, 0))  # the stable's pool empty
        for case, answers, reason in (('shallow pools', shallow, 'pool_depth_below_floor'),
                                      ('only a WETH pool, the feed stale', only_weth, 'eth_usd_stale'),
                                      ('no pool', feed_answers(), 'no_pool')):
            with self.subTest(case=case):
                self.assertEqual(self.pricer(answers)[0].prices([(8453, TOKEN, 18)])[(8453, TOKEN)], (None, reason))
        # Unknown decimals: read here; unreadable, no price.
        pricer, fake = self.pricer({**self.token_answers(), **metadata(TOKEN)})
        self.assertIsNone(pricer.prices([(8453, TOKEN, None)])[(8453, TOKEN)][1])
        self.assertIn((TOKEN, selector('decimals()'), b''), fake.subcalls)
        pricer, _ = self.pricer(self.token_answers())
        self.assertEqual(pricer.prices([(8453, TOKEN, None)])[(8453, TOKEN)], (None, 'decimals_unknown'))

    def test_a_price_below_a_billionth_of_a_billionth_is_none(self):
        tick = -690_800
        answers = {**v4_answers(self.USDC_POOL, sqrt_at_tick(tick), tick, 3 * 10**26),
                   **band_answers(BASE, self.USDC_POOL, sqrt_at_tick(tick), tick, TOKEN), **feed_answers()}
        self.assertEqual(self.pricer(answers)[0].prices([(8453, TOKEN, 0)])[(8453, TOKEN)], (None, 'price_below_precision'))

    def test_initialized_ticks_within_the_band_are_walked_as_the_featured_pools_walk_them(self):
        tick = -76_010
        sqrt = sqrt_at_tick(tick)
        # The token, currency0, sold into the pool moves its price down; a position starting 300 ticks lower leaves
        # the pool there (crossed downward, its net comes off): past it, a tenth of the liquidity.
        nets = {tick - 300: 5_850 * 10**18}
        answers = {**self.token_answers(), **band_answers(BASE, self.WETH_POOL, sqrt, tick, TOKEN, nets)}
        answers.update(v4_answers(self.USDC_POOL, sqrt_at_tick(-269_390), -269_390, 0))
        pricer, fake = self.pricer(answers)
        price, reason = pricer.prices([(8453, TOKEN, 18)])[(8453, TOKEN)]
        walked = featured_depth(self.WETH_POOL, sqrt, tick, 6_500 * 10**18, TOKEN, nets)
        flat = featured_depth(self.WETH_POOL, sqrt, tick, 6_500 * 10**18, TOKEN)
        self.assertLess(walked, flat)
        self.assertEqual(price['depthUsd'] if price else reason,
                         reads.decimal_text(Fraction(walked, 10**18) * 4000, reads.USD_SCALE)
                         if Fraction(walked, 10**18) * 4000 >= reads.FLOOR_USD else 'pool_depth_below_floor')
        self.assertEqual(len(fake.requests), 3)  # the third round read the initialized tick

    def test_the_walk_is_the_featured_pools_own(self):
        cases = []
        for spacing, tick, nets in ((60, 1_020, {1_200: -10**20, 1_500: 3 * 10**19, 600: 2 * 10**19}),
                                    (10, -5_000, {-5_400: -10**19, -4_700: 10**19}),
                                    (1, 0, {}), (200, 887_000, {})):
            for zero_for_one in (True, False):
                cases.append((spacing, tick, nets, zero_for_one))
        from featured_pools import reference_depth
        for spacing, tick, nets, zero_for_one in cases:
            bits = {}
            for initialized in nets:
                compressed = initialized // spacing
                bits[compressed >> 8] = bits.get(compressed >> 8, 0) | 1 << (compressed & 255)
            sqrt = sqrt_at_tick(tick)
            ours = reads.reference_depth(lambda position: bits.get(position, 0), lambda at: nets[at], sqrt_price=sqrt,
                                         tick=tick, liquidity=4 * 10**20, spacing=spacing, zero_for_one=zero_for_one)
            theirs = reference_depth(lambda position: bits.get(position, 0), lambda at: nets[at], sqrt_price=sqrt,
                                     tick=tick, liquidity=4 * 10**20, tick_spacing=spacing,
                                     reference_is_currency1=zero_for_one, band=Fraction(1, 10), max_steps=300)
            with self.subTest(spacing=spacing, tick=tick, zero_for_one=zero_for_one):
                self.assertEqual(ours, theirs)

    def test_the_walk_stops_past_its_steps_exactly(self):
        # No tick initialized: each step is a word of the map (spacing 1, so several words within the band).
        sqrt, tick = sqrt_at_tick(-76_000), -76_000
        from featured_pools import reference_depth
        needed = next(steps for steps in range(1, 50) if reference_depth(
            lambda position: 0, lambda at: 0, sqrt_price=sqrt, tick=tick, liquidity=10**20, tick_spacing=1,
            reference_is_currency1=True, band=Fraction(1, 10), max_steps=steps) is not None)
        self.assertGreater(needed, 2)
        for limit, measured in ((needed - 1, False), (needed, True)):
            with self.subTest(limit=limit), mock.patch.object(reads, 'MAX_STEPS', limit):
                walked = reads.reference_depth(lambda position: 0, lambda at: 0, sqrt_price=sqrt, tick=tick,
                                               liquidity=10**20, spacing=1, zero_for_one=True)
                self.assertEqual(walked is not None, measured)

    def test_only_the_ticks_the_walk_can_cross_are_read_and_an_unreadable_one_unmeasures(self):
        tick = -76_010
        sqrt = sqrt_at_tick(tick)
        low, high = reads.band_ticks(sqrt, tick, 10, True)
        outside = (low - 1) * 10 if (low - 1) >> 8 == low >> 8 else (high + 1) * 10  # in a word read, out of range
        inside = tick - 300
        answers = {**self.token_answers(),
                   **band_answers(BASE, self.WETH_POOL, sqrt, tick, TOKEN, {inside: 10**18, outside: 10**18})}
        answers.update(v4_answers(self.USDC_POOL, sqrt_at_tick(-269_390), -269_390, 0))
        pricer, fake = self.pricer(answers)
        self.assertIsNone(pricer.prices([(8453, TOKEN, 18)])[(8453, TOKEN)][1])
        read = {decode(['int24'], key[2])[0] for key in fake.subcalls if key[1] == selector('ticks(int24)')}
        self.assertEqual(read, {inside})
        broken = {key: value for key, value in answers.items() if key[1] != selector('ticks(int24)')}
        self.assertEqual(self.pricer(broken)[0].prices([(8453, TOKEN, 18)])[(8453, TOKEN)],
                         (None, 'pool_depth_unmeasurable'))

    def test_a_walk_too_long_or_an_unreadable_word_is_unmeasured(self):
        tick = -76_010
        sqrt = sqrt_at_tick(tick)
        nets = {tick + 10 * step: -10**18 for step in range(1, 4)}
        answers = {**self.token_answers(), **band_answers(BASE, self.WETH_POOL, sqrt, tick, TOKEN, nets)}
        answers.update(v4_answers(self.USDC_POOL, sqrt_at_tick(-269_390), -269_390, 0))
        with mock.patch.object(reads, 'MAX_STEPS', 2):
            self.assertEqual(self.pricer(answers)[0].prices([(8453, TOKEN, 18)])[(8453, TOKEN)],
                             (None, 'pool_depth_unmeasurable'))
        broken = {key: value for key, value in answers.items() if key[1] != selector('tickBitmap(int16)')}
        self.assertEqual(self.pricer(broken)[0].prices([(8453, TOKEN, 18)])[(8453, TOKEN)],
                         (None, 'pool_depth_unmeasurable'))

    def test_prices_are_kept_a_while_failures_never_and_a_pass_is_bounded(self):
        pricer, fake = self.pricer(feed_answers())
        clock = pricer.cache.clock
        pricer.prices([(8453, WETH, None)])
        pricer.prices([(8453, WETH, None)])
        self.assertEqual(len(fake.requests), 1)
        clock.now = reads.PRICES_CACHE_SECONDS + 0.5
        pricer.prices([(8453, WETH, None)])
        self.assertEqual(len(fake.requests), 2)
        failing, broken = self.pricer({}, fail=True)
        self.assertEqual(failing.prices([(8453, WETH, None)])[(8453, WETH)], (None, 'price_read_failed'))
        broken.fail = False
        broken.answers.update(feed_answers())
        self.assertIsNone(failing.prices([(8453, WETH, None)])[(8453, WETH)][1])
        # Another read's price is kept; a failed one is not.
        pricer.offer(8453, TOKEN, (None, 'price_read_failed'))
        pricer.offer(8453, '0x' + '12' * 20, (None, 'no_pool'))
        self.assertEqual((pricer.cache.get((8453, TOKEN)), pricer.cache.get((8453, '0x' + '12' * 20))),
                         (None, (None, 'no_pool')))
        # At most MAX_PRICED tokens a pass; the rest say so and are not kept.
        with mock.patch.object(reads, 'MAX_PRICED', 1):
            pricer, _ = self.pricer(feed_answers())
            got = pricer.prices([(8453, '0x' + '13' * 20, 18), (8453, '0x' + '14' * 20, 18)])
        self.assertEqual([got[(8453, '0x' + '13' * 20)][1], got[(8453, '0x' + '14' * 20)][1]],
                         ['no_pool', 'pricing_limit_reached'])
        self.assertIsNone(pricer.cache.get((8453, '0x' + '14' * 20)))
        # A slow endpoint costs the pass its prices, within the budget.
        with mock.patch.object(reads, 'PRICING_BUDGET_SECONDS', 0.001):
            slow, _ = self.pricer(feed_answers(), delay=0.01)
            self.assertEqual(slow.prices([(8453, WETH, None)])[(8453, WETH)], (None, 'price_read_failed'))
        # A chain without endpoints prices nothing.
        self.assertEqual(reads.Pricer({}).prices([(42161, ZERO, None)])[(42161, ZERO)],
                         (None, 'no_qualified_price_source'))


class ValueTests(unittest.TestCase):
    def balance_answers(self, eth=10**17, usdc=2_500_000, weth=0):
        def balance(token, amount):
            target = BASE.multicall3 if token == ZERO else token
            call = 'getEthBalance(address)' if token == ZERO else 'balanceOf(address)'
            return {(target, selector(call), encode(['address'], [WALLET])): (True, encode(['uint256'], [amount]))}
        return {**balance(ZERO, eth), **balance(USDC, usdc), **balance(WETH, weth), **feed_answers()}

    def test_each_balance_at_its_price_each_chain_summed_and_chains_only_when_all_are(self):
        reader = chain_reads({8453: source(BASE, FakeChain(self.balance_answers()))})
        answer = reader.balances(WALLET, [(8453, USDC), (8453, ZERO), (8453, WETH)])
        validate_v6_request_response('chain-balances', {'wallet': WALLET, 'tokens': [
            {'chainId': 8453, 'address': token} for token in (USDC, ZERO, WETH)]}, answer)
        base, = answer['chains']
        self.assertEqual([b['valueUsd'] for b in base['balances']], ['2.500000', '400.000000', '0.000000'])
        self.assertEqual((base['totalUsd'], answer['totalUsd']), ('402.500000', '402.500000'))
        # Every chain by default: Robinhood and Arbitrum have no endpoints here, so no answer-wide total.
        answer = reader.balances(WALLET)
        validate_v6_request_response('chain-balances', {'wallet': WALLET, 'tokens': None}, answer)
        self.assertEqual([c['totalUsd'] for c in answer['chains']], [None, '402.500000', None])
        self.assertIsNone(answer['totalUsd'])

    def test_a_zero_balance_needs_no_price_an_unread_one_leaves_the_total_unknown(self):
        answers = {**self.balance_answers(), (TOKEN, selector('balanceOf(address)'), encode(['address'], [WALLET])):
                   (True, encode(['uint256'], [0])), **metadata(TOKEN)}
        reader = chain_reads({8453: source(BASE, FakeChain(answers))})
        answer = reader.balances(WALLET, [(8453, USDC), (8453, TOKEN)])
        validate_v6_request_response('chain-balances', {'wallet': WALLET, 'tokens': [
            {'chainId': 8453, 'address': USDC}, {'chainId': 8453, 'address': TOKEN}]}, answer)
        usdc, token = answer['chains'][0]['balances']
        self.assertEqual((token['priceReason'], token['valueUsd']), ('no_pool', None))
        self.assertEqual(answer['chains'][0]['totalUsd'], '2.500000')
        unread = {key: value for key, value in self.balance_answers().items() if key[0] != USDC}
        answer = chain_reads({8453: source(BASE, FakeChain(unread))}).balances(WALLET, [(8453, USDC), (8453, ZERO)])
        self.assertEqual((answer['chains'][0]['balances'][0]['status'], answer['chains'][0]['totalUsd']),
                         ('unavailable', None))


class PoolMarketTests(unittest.TestCase):
    def test_a_token_priced_by_its_own_read_is_kept_for_the_other_routes(self):
        tick = -76_010
        answers = {**PriceTests.token_answers(PriceTests()), **metadata(TOKEN)}
        chain = FakeChain(answers)
        reader = chain_reads({8453: source(BASE, chain)})
        answer = reader.pools(8453, TOKEN)
        validate_v6_request_response('chain-pools', {'chainId': 8453, 'token': TOKEN, 'pairedToken': None}, answer)
        token = next(t for t in answer['tokens'] if t['address'] == TOKEN)
        self.assertEqual((token['price']['source'], token['price']['pool']), ('pool', reads.pool_wire(PriceTests.WETH_POOL)))
        weth_pool = next(p for p in answer['pools'] if p['pool']['dex'] == 3)
        self.assertEqual((weth_pool['market']['status'], weth_pool['market']['reference'], weth_pool['market']['depthUsd']),
                         ('measured', WETH, token['price']['depthUsd']))
        requests = len(chain.requests)
        self.assertEqual(reader.pricer.prices([(8453, TOKEN, 18)])[(8453, TOKEN)], (token['price'], None))
        self.assertEqual(len(chain.requests), requests)  # kept from chain-pools' own read
        self.assertEqual(tick, -76_010)

    def test_a_pair_without_a_base_currency_is_not_measured(self):
        other = '0x' + '77' * 20
        ref = PoolRef(4, *sorted((TOKEN, other)), 3000, 60)
        answers = {**v4_answers(ref, 2**96, 0, 10**20), **metadata(TOKEN), **metadata(other, symbol='OTH'), **feed_answers()}
        answer = chain_reads({8453: source(BASE, FakeChain(answers))}).pools(8453, TOKEN, other)
        validate_v6_request_response('chain-pools', {'chainId': 8453, 'token': TOKEN, 'pairedToken': other}, answer)
        self.assertEqual(answer['pools'][0]['market'], {'status': 'unavailable', 'reference': None, 'depthUsd': None,
                                                        'reason': 'no_qualified_reference'})
        # Both tokens priced from their own pools against the base currencies (none here).
        self.assertEqual({t['address']: t['priceReason'] for t in answer['tokens']}, {TOKEN: 'no_pool', other: 'no_pool'})

    def test_a_stopped_sequencer_leaves_even_a_pool_against_the_stable_unmeasured(self):
        ref = PoolRef(4, *sorted((TOKEN, USDC)), 500, 10)
        answers = {**v4_answers(ref, 2**96, 0, 10**20), **metadata(TOKEN), **feed_answers(up=1),
                   **band_answers(BASE, ref, 2**96, 0, TOKEN)}
        answer = chain_reads({8453: source(BASE, FakeChain(answers))}).pools(8453, TOKEN, USDC)
        validate_v6_request_response('chain-pools', {'chainId': 8453, 'token': TOKEN, 'pairedToken': USDC}, answer)
        self.assertEqual(answer['pools'][0]['market']['reason'], 'sequencer_down')

    def test_against_eth_a_stale_feed_or_a_stopped_sequencer_leaves_the_pool_unmeasured(self):
        ref = PoolRef(4, ZERO, TOKEN, 3000, 60)
        for case, feed, reason in (('stale', feed_answers(age=10_000), 'eth_usd_stale'),
                                   ('down', feed_answers(up=1), 'sequencer_down')):
            answers = {**v4_answers(ref, 2**96, 0, 10**20), **metadata(TOKEN), **feed}
            answer = chain_reads({8453: source(BASE, FakeChain(answers))}).pools(8453, TOKEN, ZERO)
            with self.subTest(case=case):
                validate_v6_request_response('chain-pools', {'chainId': 8453, 'token': TOKEN, 'pairedToken': ZERO},
                                             answer)
                self.assertEqual(answer['pools'][0]['market']['reason'], reason)

class HelperTests(unittest.TestCase):
    def test_symbols_are_strings_or_legacy_bytes32_and_never_unsafe(self):
        self.assertEqual(reads.raw_text(True, encode(['string'], ['DAI']), 40), 'DAI')
        self.assertEqual(reads.raw_text(True, b'MKR'.ljust(32, b'\x00'), 40), 'MKR')
        for ok, payload in ((False, encode(['string'], ['X'])), (True, b''), (True, encode(['string'], ['a' * 41])),
                            (True, encode(['string'], ['tab\t'])), (True, b'\xff' * 32), (True, b'\x01')):
            self.assertIsNone(reads.raw_text(ok, payload, 40))

    def test_the_url_list_names_every_endpoint(self):
        reader = chain_reads({8453: source(BASE, FakeChain(), ('https://a.example.invalid/k',))})
        self.assertEqual(reads.endpoint_urls(reader), ('https://a.example.invalid/k',))


if __name__ == '__main__':
    unittest.main()
