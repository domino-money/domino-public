"""read-v6's live chain reads (v2_chain_reads): the pools the app reads through the wallet, in one Multicall3 call;
balances per chain; and search over the tokens Domino knows, curated first, learning from use."""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import unittest
from unittest import mock

from fractions import Fraction
import time

from eth_abi import decode, encode
from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import v2_chain_reads as reads  # noqa: E402
import discovery  # noqa: E402
from discovery import SNAPSHOT_LOOPBACK_RPC, ZERO, Block, DataError  # noqa: E402
from read_deadline import check_read_deadline, current_read_deadline, read_deadline  # noqa: E402
from v2_chains import default_balance_registry, default_registry  # noqa: E402
from v2_read_contract import validate_v6_request_response  # noqa: E402
from v2_uniswap import PoolRef, PoolState, v3_pool_address  # noqa: E402
from v4_math import sqrt_at_tick, tick_at_sqrt  # noqa: E402

REGISTRY = default_registry()
BASE, ARBITRUM, ROBINHOOD = REGISTRY.chain(8453), REGISTRY.chain(42161), REGISTRY.chain(4663)
ETHEREUM, OPTIMISM = default_balance_registry().chain(1), default_balance_registry().chain(10)
TOKEN = '0x' + '11' * 20
USDC, WETH = BASE.chargeCurrencies[0].address, BASE.wrappedNative.address
WALLET = '0x' + 'aa' * 20
BLOCK = Block(1000, '0x' + 'cd' * 32, 1_800_000_000)


def selector(signature):
    return keccak(signature.encode())[:4].hex()


class FakeChain:
    """Multicall3 over scripted answers: {(target, selector hex, argument bytes): (ok, return bytes)}. Anything else
    answers as an address without code: success with no data. `fail_from`: the requests from that many on fail.
    `barrier`: the first request waits there for the other chains' (threading.Barrier), so chains read in turn fail."""

    def __init__(self, answers=None, fail=False, delay=0, fail_from=None, barrier=None):
        self.answers, self.fail, self.delay, self.fail_from = dict(answers or {}), fail, delay, fail_from
        self.barrier = barrier
        self.requests, self.subcalls, self.batches = [], [], []

    def request(self, method, params):
        if self.barrier is not None:
            barrier, self.barrier = self.barrier, None
            barrier.wait(timeout=5)
        if self.fail or (self.fail_from is not None and len(self.requests) >= self.fail_from):
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


class Budgeted:
    """A read client's request budget as discovery.ReadRpc keeps it: its own for each read, refused past it."""

    def __init__(self, rpc, max_requests):
        self.rpc, self.max_requests, self.count = rpc, max_requests, 0

    def request(self, method, params):
        if self.count >= self.max_requests:
            raise DataError('request_budget_exhausted')
        self.count += 1
        return self.rpc.request(method, params)


class Endpoints:
    def __init__(self, rpc, urls=()):
        self.rpc, self.endpoints = rpc, tuple(type('E', (), {'url': url})() for url in urls)

    def read_rpc(self, *, anchor, max_requests):
        assert anchor == BLOCK and max_requests == reads.CHAIN_READ_REQUESTS == 8
        return Budgeted(self.rpc, max_requests)


def source(chain, rpc, urls=()):
    return reads.ChainSource(chain, Endpoints(rpc, urls), Follower())


class Clock:
    def __init__(self, now=1_800_000_005.0):
        self.now = now

    def __call__(self):
        return self.now


def v4_answers(ref, sqrt, tick, liquidity, *, protocol=0, lp=None, chain=BASE):
    pool_id = bytes.fromhex(ref.pool_id[2:])
    view = chain.uniswap.v4.stateView
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


def walk_ticks(sqrt, tick, spacing, zero_for_one):
    """The compressed ticks a walk from `tick` can cross, both ends included, from featured_pools' own bound."""
    from featured_pools import band_bound
    bound = tick_at_sqrt(band_bound(sqrt, Fraction(1, 10), zero_for_one=zero_for_one)) // spacing
    return tuple(sorted((tick // spacing, bound)))


def walk_words(low, high):
    """The bitmap words such a walk reads: its own, and the next one up for a rising walk that ends a word early."""
    return range(low >> 8, (high >> 8) + 2)


def band_answers(chain, ref, sqrt, tick, subject, nets=None):
    """The pool's bitmap words within the band as `subject` is sold into it, `nets` ({tick: liquidityNet}) set in them,
    and those ticks' liquidity."""
    nets = nets or {}
    partner = ref.currency1 if ref.currency0 == subject else ref.currency0
    low, high = walk_ticks(sqrt, tick, ref.tick_spacing, partner == ref.currency1)
    bits = {}
    for initialized in nets:
        compressed = initialized // ref.tick_spacing
        bits[compressed >> 8] = bits.get(compressed >> 8, 0) | 1 << (compressed & 255)
    v3 = None if ref.dex == 4 else v3_pool_address(chain, ref.currency0, ref.currency1, ref.fee)
    pool_id = bytes.fromhex(ref.pool_id[2:]) if v3 is None else None
    out = {}
    for position in walk_words(low, high):
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

    def balance_file(self, chains, *, text=None, mode=0o600, url=True):
        entry = {'name': 'stack', 'host': 'stack.example.invalid', 'archive': True, 'maxBatchItems': 50,
                 'maxLogBlocks': 10000, 'requestsPerSecond': None, **({'url': 'https://stack.example.invalid/k'} if url else {})}
        path = self.directory / 'balance-chain-rpc.json'
        path.write_text(text if text is not None else json.dumps({
            'schemaVersion': 1, 'kind': 'domino-v2-chain-rpc', 'chains': {key: {'endpoints': [entry]} for key in chains}}))
        path.chmod(mode)
        return str(path)

    def build(self, balance_file):
        import contextlib
        import io
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            built = reads.build_chain_reads(provider_config=None, chain_rpc_file=self.chain_rpc_file(('base-8453',)),
                                            balance_chain_rpc_file=balance_file, learned_path=None, registry=REGISTRY)
        return built, [json.loads(line) for line in stderr.getvalue().splitlines() if line.strip()]

    def test_the_balance_chains_come_from_their_own_file(self):
        built, logged = self.build(self.balance_file(('ethereum-1', 'optimism-10')))
        self.assertEqual((sorted(built.sources), logged), ([1, 10, 8453], []))
        self.assertEqual([built.sources[chain_id].endpoints.chain.key for chain_id in (1, 10)], ['ethereum-1', 'optimism-10'])
        self.assertEqual(built.sources[10].follower.max_age, reads.HEAD_MAX_AGE_SECONDS)
        self.assertEqual(sorted(self.build(self.balance_file(('optimism-10',)))[0].sources), [10, 8453])
        self.assertEqual(sorted(self.build(None)[0].sources), [8453])

    def test_a_fault_in_the_balance_file_costs_only_the_balance_chains(self):
        for case, path, code in (
                ('absent', lambda: str(self.directory / 'absent.json'), 'v2_chain_rpc_config_unreadable'),
                ('readable by others', lambda: self.balance_file(('ethereum-1',), mode=0o644),
                 'v2_chain_rpc_config_unreadable'),
                ('not JSON', lambda: self.balance_file((), text='{'), 'invalid_v2_chain_rpc_config'),
                ('a sealed URL missing', lambda: self.balance_file(('ethereum-1', 'optimism-10'), url=False),
                 'v2_rpc_url_missing'),
                ("a Domino chain's endpoints", lambda: self.balance_file(('ethereum-1', 'base-8453')), 'v2_chain_unknown')):
            with self.subTest(case=case):
                built, logged = self.build(path())
                self.assertEqual(sorted(built.sources), [8453])
                self.assertEqual([(entry['mode'], entry['reason']) for entry in logged],
                                 [('balance_chains_unavailable', code)])
                self.assertNotIn(str(self.directory), json.dumps(logged))
                answer = built.balances(WALLET, [(1, ZERO), (10, ZERO)])
                self.assertEqual([(c['chainId'], c['reason']) for c in answer['chains']],
                                 [(1, 'chain_not_configured'), (10, 'chain_not_configured')])
        # Any other fault is named by a fixed code: its text may carry a path.
        with mock.patch.object(reads, 'default_balance_registry', side_effect=OSError(f'{self.directory}: denied')):
            built, logged = self.build(self.balance_file(('ethereum-1',)))
        self.assertEqual((sorted(built.sources), [entry['reason'] for entry in logged]), ([8453], ['balance_chains_unconfigured']))
        self.assertNotIn(str(self.directory), json.dumps(logged))



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
        low, high = walk_ticks(sqrt, tick, 10, True)
        self.assertEqual(reads.band_ticks(sqrt, tick, 10, True), (low, high))
        # Initialized just past either end, in words the walk reads: past the bound, and on the price's other side.
        outside = {(low - 1) * 10: 10**18, (high + 1) * 10: 10**18}
        self.assertTrue(all(at // 10 >> 8 in walk_words(low - 256, high) for at in outside))
        inside = tick - 300
        answers = {**self.token_answers(),
                   **band_answers(BASE, self.WETH_POOL, sqrt, tick, TOKEN, {inside: 10**18, **outside})}
        answers.update(v4_answers(self.USDC_POOL, sqrt_at_tick(-269_390), -269_390, 0))
        pricer, fake = self.pricer(answers)
        self.assertIsNone(pricer.prices([(8453, TOKEN, 18)])[(8453, TOKEN)][1])
        read = {decode(['int24'], key[2])[0] for key in fake.subcalls if key[1] == selector('ticks(int24)')}
        self.assertEqual(read, {inside})
        broken = {key: value for key, value in answers.items() if key[1] != selector('ticks(int24)')}
        self.assertEqual(self.pricer(broken)[0].prices([(8453, TOKEN, 18)])[(8453, TOKEN)],
                         (None, 'pool_depth_unmeasurable'))

    def test_ticks_initialized_around_the_band_never_count_against_the_walk(self):
        # 5 Oct 2026: Base's deepest USDC pools, initialized at almost every spacing around their price, came out
        # unmeasurable: the ticks of a word of margin each side counted against MAX_STEPS. Only the walk's count.
        tick = -76_010
        sqrt = sqrt_at_tick(tick)
        low, high = walk_ticks(sqrt, tick, 10, True)
        around = {**{(high + step) * 10: -10**15 for step in range(1, 201)},
                  **{(low - step) * 10: 10**15 for step in range(1, 151)}}
        self.assertGreater(len(around), reads.MAX_STEPS)
        answers = {**self.token_answers(), **band_answers(BASE, self.WETH_POOL, sqrt, tick, TOKEN, around)}
        answers.update(v4_answers(self.USDC_POOL, sqrt_at_tick(-269_390), -269_390, 0))
        pricer, fake = self.pricer(answers)
        price, reason = pricer.prices([(8453, TOKEN, 18)])[(8453, TOKEN)]
        self.assertIsNone(reason)
        depth = Fraction(featured_depth(self.WETH_POOL, sqrt, tick, 6_500 * 10**18, TOKEN, around), 10**18) * 4000
        self.assertEqual(price['depthUsd'], reads.decimal_text(depth, reads.USD_SCALE))
        self.assertEqual(len(fake.requests), 2)  # no tick to read: none is crossed

    def test_a_walk_too_long_or_an_unreadable_word_is_unmeasured(self):
        tick = -76_010
        sqrt = sqrt_at_tick(tick)
        # Three ticks below the price, which the token sold into the pool crosses on its way down.
        nets = {tick - 10 * step: 10**17 for step in range(1, 4)}
        answers = {**self.token_answers(), **band_answers(BASE, self.WETH_POOL, sqrt, tick, TOKEN, nets)}
        answers.update(v4_answers(self.USDC_POOL, sqrt_at_tick(-269_390), -269_390, 0))
        self.assertIsNone(self.pricer(answers)[0].prices([(8453, TOKEN, 18)])[(8453, TOKEN)][1])
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


class ReadBudgetTests(unittest.TestCase):
    """A read at a chain's head stays within CHAIN_READ_REQUESTS whatever the chain holds (5 Oct 2026: Base's 13 USDC
    pools needed 11 calls of 64 reads, and the reader refused chain-pools at the 9th, a 503)."""

    # TOKEN at about US$ 2: 2,000 a ETH (ETH sorts below it), a two-thousandth of a WETH and 2 USDC (both above it).
    TICKS = {ZERO: 76_010, WETH: -76_010, USDC: -269_390}

    def crowded(self, ticks_each=120):
        """All 26 of TOKEN's candidate pools on Base, each with up to `ticks_each` initialized ticks (net 0) the walk
        crosses, active liquidity growing with the pool's place: {PoolRef: (sqrt, tick, liquidity, nets)}."""
        pools = {}
        for place, ref in enumerate(reads.pool_candidates(BASE, TOKEN), 1):
            partner = ref.currency1 if ref.currency0 == TOKEN else ref.currency0
            tick = self.TICKS[partner]
            sqrt = sqrt_at_tick(tick)
            low, high = walk_ticks(sqrt, tick, ref.tick_spacing, partner == ref.currency1)
            nets = {position * ref.tick_spacing: 0 for position in range(low + 1, high)[:ticks_each]}
            # The deepest, by far: v3's WETH tier of 200, late among the candidates and with many ticks to cross.
            scale = 1_000 if (ref.dex, ref.fee, partner) == (3, 200, WETH) else place
            pools[ref] = (sqrt, tick, scale * (10**18 if partner == USDC else 2_000 * 10**18), nets)
        return pools

    def answers(self, pools):
        out = {**metadata(TOKEN), **feed_answers()}
        for ref, (sqrt, tick, liquidity, nets) in pools.items():
            out.update(v4_answers(ref, sqrt, tick, liquidity) if ref.dex == 4 else
                       v3_answers(BASE, ref, sqrt, tick, liquidity))
            out.update(band_answers(BASE, ref, sqrt, tick, TOKEN, nets))
        return out

    @staticmethod
    def depth_usd(ref, pool):
        sqrt, tick, liquidity, nets = pool
        partner = ref.currency1 if ref.currency0 == TOKEN else ref.currency0
        raw = featured_depth(ref, sqrt, tick, liquidity, TOKEN, nets)
        return Fraction(raw, 10**6) if partner == USDC else Fraction(raw, 10**18) * 4000

    def test_a_crowded_chain_is_read_in_four_calls_its_deepest_pools_measured_first(self):
        pools = self.crowded()
        self.assertEqual(len(pools), 26)
        self.assertGreater(sum(len(pool[3]) for pool in pools.values()), reads.DEPTH_TICKS)
        chain = FakeChain(self.answers(pools))
        answer = chain_reads({8453: source(BASE, chain)}).pools(8453, TOKEN)
        validate_v6_request_response('chain-pools', {'chainId': 8453, 'token': TOKEN, 'pairedToken': None}, answer)
        # The pools, their words, their ticks in two: within the budget, a failover's room to spare.
        self.assertEqual(len(chain.requests), 4)
        self.assertEqual(chain.batches[0], 26 * 2 + 7 + 3 + 2)
        self.assertLessEqual(chain.batches[1], reads.DEPTH_WORDS)
        self.assertLessEqual(chain.batches[2] + chain.batches[3], reads.DEPTH_TICKS)
        self.assertLessEqual(len(chain.requests) + 2 * 2, reads.CHAIN_READ_REQUESTS)
        markets = {(p['pool']['dex'], p['pool']['currency0'], p['pool']['currency1'], p['pool']['fee']): p['market']
                   for p in answer['pools']}
        self.assertEqual(len(markets), 26)
        depths = {ref: self.depth_usd(ref, pool) for ref, pool in pools.items()}
        measured = {ref for ref in pools if markets[(ref.dex, ref.currency0, ref.currency1, ref.fee)]['status'] == 'measured'}
        skipped = set(pools) - measured
        self.assertTrue(measured and skipped)
        self.assertEqual({markets[(ref.dex, ref.currency0, ref.currency1, ref.fee)]['reason'] for ref in skipped},
                         {'pool_depth_unmeasurable'})
        for ref in measured:
            self.assertEqual(markets[(ref.dex, ref.currency0, ref.currency1, ref.fee)]['depthUsd'],
                             reads.decimal_text(depths[ref], reads.USD_SCALE))
        # Deepest first: a skipped pool is shallower than every pool measured before the reads ran out.
        deepest = max(depths, key=depths.get)
        self.assertEqual((deepest.dex, deepest.fee), (3, 200))
        self.assertIn(deepest, measured)
        first_skipped = max(depths[ref] for ref in skipped)
        self.assertEqual(sum(depths[ref] > first_skipped for ref in measured),
                         sum(depths[ref] > first_skipped for ref in pools))
        token = next(t for t in answer['tokens'] if t['address'] == TOKEN)
        self.assertEqual((token['price']['pool'], token['price']['depthUsd']),
                         (reads.pool_wire(deepest), reads.decimal_text(depths[deepest], reads.USD_SCALE)))

    def two_pools(self, deep_ticks):
        """TOKEN's deeper pool (WETH, spacing 1: many words) with `deep_ticks` ticks to cross, and a shallow one against
        USDC (spacing 60) below the floor."""
        deep, shallow = PoolRef(3, *sorted((TOKEN, WETH)), 100, 1), PoolRef(4, *sorted((TOKEN, USDC)), 3000, 60)
        pools = self.crowded()
        deep_pool = (*pools[deep][:2], 6_500 * 10**18, dict(list(pools[deep][3].items())[:deep_ticks]))
        shallow_pool = (*pools[shallow][:2], 10**15, {})
        return deep, shallow, {deep: deep_pool, shallow: shallow_pool}

    def test_a_pool_past_the_reads_left_is_unmeasured_and_the_token_waits_for_another_pass(self):
        deep, shallow, pools = self.two_pools(deep_ticks=5)
        deep_words = len(walk_words(*walk_ticks(*pools[deep][:2], 1, True)))
        shallow_words = len(walk_words(*walk_ticks(*pools[shallow][:2], 60, True)))
        self.assertLess(shallow_words, deep_words)
        for case, constant, value in (('ticks', 'DEPTH_TICKS', 4), ('words', 'DEPTH_WORDS', deep_words - 1)):
            with self.subTest(case=case), mock.patch.object(reads, constant, value):
                chain = FakeChain(self.answers(pools))
                reader = chain_reads({8453: source(BASE, chain)})
                answer = reader.pools(8453, TOKEN)
                validate_v6_request_response('chain-pools', {'chainId': 8453, 'token': TOKEN, 'pairedToken': None},
                                             answer)
                markets = {p['pool']['fee']: p['market'] for p in answer['pools']}
                self.assertEqual((markets[100]['reason'], markets[3000]['status']),
                                 ('pool_depth_unmeasurable', 'measured'))
                self.assertLess(Fraction(markets[3000]['depthUsd']), reads.FLOOR_USD)
                # The unmeasured pool might qualify: not "below the floor", and not kept.
                token = next(t for t in answer['tokens'] if t['address'] == TOKEN)
                self.assertEqual((token['price'], token['priceReason']), (None, 'pricing_limit_reached'))
                self.assertIsNone(reader.pricer.cache.get((8453, TOKEN)))
        # With the reads to measure it, the deep pool prices the token.
        chain = FakeChain(self.answers(pools))
        token = next(t for t in chain_reads({8453: source(BASE, chain)}).pools(8453, TOKEN)['tokens']
                     if t['address'] == TOKEN)
        self.assertEqual(token['price']['pool'], reads.pool_wire(deep))

    def test_a_failed_depth_call_leaves_the_pools_listed_and_their_depths_unread(self):
        deep, shallow, pools = self.two_pools(deep_ticks=5)
        for case, fail_from, shallow_status in (('words', 1, 'unavailable'), ('ticks', 2, 'measured')):
            with self.subTest(case=case):
                chain = FakeChain(self.answers(pools), fail_from=fail_from)
                reader = chain_reads({8453: source(BASE, chain)})
                answer = reader.pools(8453, TOKEN)
                validate_v6_request_response('chain-pools', {'chainId': 8453, 'token': TOKEN, 'pairedToken': None},
                                             answer)
                markets = {p['pool']['fee']: p['market'] for p in answer['pools']}
                self.assertEqual(markets[100]['reason'], 'price_read_failed')
                # A pool with no tick to cross needs no tick call.
                self.assertEqual(markets[3000]['status'], shallow_status)
                prices = {t['address']: t['priceReason'] for t in answer['tokens']}
                self.assertEqual(prices, {TOKEN: 'price_read_failed', ZERO: None, WETH: None, USDC: None})
                self.assertIsNone(reader.pricer.cache.get((8453, TOKEN)))
        # The pools' own call failing still fails the read: there is nothing to list.
        with self.assertRaisesRegex(DataError, '^http_503$'):
            chain_reads({8453: source(BASE, FakeChain(self.answers(pools), fail_from=0))}).pools(8453, TOKEN)
        # A pass pricing two tokens: the tick call failing leaves unread only the token whose pool had ticks to cross.
        other = '0x' + '12' * 20
        other_pool = PoolRef(4, *sorted((other, USDC)), 3000, 60)
        tick = -269_390
        answers = {**self.answers({deep: pools[deep]}), **v4_answers(other_pool, sqrt_at_tick(tick), tick, 10**15),
                   **band_answers(BASE, other_pool, sqrt_at_tick(tick), tick, other)}
        pricer = reads.Pricer({8453: source(BASE, FakeChain(answers, fail_from=2))}, monotonic=Clock(0.0))
        got = pricer.prices([(8453, TOKEN, 18), (8453, other, 18)])
        self.assertEqual((got[(8453, TOKEN)], got[(8453, other)]),
                         ((None, 'price_read_failed'), (None, 'pool_depth_below_floor')))

    def test_a_pass_prices_the_tokens_whose_pools_fit_one_call_and_says_so_for_the_rest(self):
        tokens = sorted('0x' + f'{n:02x}' * 20 for n in range(0x20, 0x2c))
        # The feed, its sequencer's and the 7 tiers' spacings, then 26 pools (two reads each) a token: 9 tokens.
        self.assertEqual((reads.SURVEY_CALLS - 2 - 7) // (26 * 2), 9)
        # A call of 529 reads fits 10 tokens whose decimals are known, 9 whose metadata it reads too (three more).
        for calls, decimals, fits in ((reads.SURVEY_CALLS, 18, 9), (529, 18, 10), (529, None, 9)):
            with self.subTest(calls=calls, decimals=decimals), mock.patch.object(reads, 'SURVEY_CALLS', calls):
                fake = FakeChain(feed_answers())
                pricer = reads.Pricer({8453: source(BASE, fake)}, monotonic=Clock(0.0))
                got = pricer.prices([(8453, token, decimals) for token in tokens])
                self.assertEqual([got[(8453, token)][1] for token in tokens],
                                 ['decimals_unknown' if decimals is None else 'no_pool'] * fits
                                 + ['pricing_limit_reached'] * (len(tokens) - fits))
                self.assertEqual(fake.batches, [2 + 7 + fits * (26 * 2 + (3 if decimals is None else 0))])


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


def wallet_balances(chain, holdings):
    """The wallet's balances on `chain` as Multicall3 answers them: {token: raw}, ETH as the zero address."""
    out = {}
    for token, amount in holdings.items():
        target = chain.multicall3 if token == ZERO else token
        call = 'getEthBalance(address)' if token == ZERO else 'balanceOf(address)'
        out[(target, selector(call), encode(['address'], [WALLET]))] = (True, encode(['uint256'], [amount]))
    return out


# Ethereum's and OP Mainnet's own, as Circle and Chainlink publish them (the profiles are held to them in
# test_v2_chain_profiles): each chain's USDC and its Chainlink ETH / USD proxy with its heartbeat.
ETHEREUM_USDC, OPTIMISM_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0x0b2c639c533813f4aa9d7837caf62653d097ff85'
FEEDS = {1: ('0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419', 3600), 10: ('0x13e3ee699d1909e989722e753853ae30b17e08c5', 1200)}


class BalanceChainTests(unittest.TestCase):
    """chain-balances on the balance chains (Ethereum, OP Mainnet; the owner's decision of 6 Oct 2026): read only when
    named, each priced by its own stable, feed and pools, by the rules Domino's chains keep."""

    def test_they_answer_only_when_named_each_with_its_own_stable_and_feed(self):
        ethereum = FakeChain({**wallet_balances(ETHEREUM, {ETHEREUM_USDC: 2_500_000, ZERO: 10**17}),
                              **feed_answers(ETHEREUM, usd=3000)})
        optimism = FakeChain({**wallet_balances(OPTIMISM, {OPTIMISM_USDC: 7_000_000, ZERO: 2 * 10**17}),
                              **feed_answers(OPTIMISM, usd=3100)})
        base = FakeChain({**wallet_balances(BASE, {USDC: 5_000_000}), **feed_answers()})
        reader = chain_reads({1: source(ETHEREUM, ethereum), 10: source(OPTIMISM, optimism), 8453: source(BASE, base)})
        default = reader.balances(WALLET)
        validate_v6_request_response('chain-balances', {'wallet': WALLET, 'tokens': None}, default)
        self.assertEqual([c['chainId'] for c in default['chains']], [4663, 8453, 42161])
        self.assertEqual((ethereum.requests, optimism.requests), ([], []))
        asked = [(10, OPTIMISM_USDC), (10, ZERO), (1, ETHEREUM_USDC), (1, ZERO), (8453, USDC)]
        answer = reader.balances(WALLET, asked)
        validate_v6_request_response('chain-balances', {'wallet': WALLET, 'tokens': [
            {'chainId': chain_id, 'address': token} for chain_id, token in asked]}, answer)
        self.assertEqual([(c['chainId'], c['status'], c['totalUsd']) for c in answer['chains']],
                         [(1, 'current', '302.500000'), (10, 'current', '627.000000'), (8453, 'current', '5.000000')])
        self.assertEqual(answer['totalUsd'], '934.500000')
        on = {c['chainId']: {b['address']: b for b in c['balances']} for c in answer['chains']}
        for chain_id, stable, eth_value, usd in ((1, ETHEREUM_USDC, '300.000000', '3000.000000000000000000'),
                                                (10, OPTIMISM_USDC, '620.000000', '3100.000000000000000000')):
            with self.subTest(chain=chain_id):
                self.assertEqual((on[chain_id][stable]['symbol'], on[chain_id][stable]['price']['source']),
                                 ('USDC', 'chain_stable'))
                eth = on[chain_id][ZERO]
                self.assertEqual((eth['symbol'], eth['valueUsd'], eth['price']['usd'], eth['price']['ethUsd']['feed']),
                                 ('ETH', eth_value, usd, FEEDS[chain_id][0]))
        # Another chain's stable is no stable here: Base's USDC on Ethereum is a token like any other.
        stranger = chain_reads({1: source(ETHEREUM, FakeChain({**wallet_balances(ETHEREUM, {USDC: 1}), **metadata(USDC, 6, 'USDC'),
                                                                **feed_answers(ETHEREUM)}))}).balances(WALLET, [(1, USDC)])
        self.assertEqual(stranger['chains'][0]['balances'][0]['priceReason'], 'no_pool')

    def test_eth_counts_within_its_own_chains_heartbeat(self):
        for chain in (ETHEREUM, OPTIMISM):
            proxy, heartbeat = FEEDS[chain.chainId]
            for age, reason in ((heartbeat, None), (heartbeat + 1, 'eth_usd_stale')):
                fake = FakeChain(feed_answers(chain, age=age))
                pricer = reads.Pricer({chain.chainId: source(chain, fake)}, monotonic=Clock(0.0))
                with self.subTest(chain=chain.chainId, age=age):
                    price, got = pricer.prices([(chain.chainId, ZERO, None)])[(chain.chainId, ZERO)]
                    self.assertEqual(got, reason)
                    self.assertEqual(price and price['ethUsd']['feed'], None if reason else proxy)
                    # The feed's round, and on OP Mainnet its sequencer's: Ethereum has none.
                    self.assertEqual(fake.batches, [1 if chain.chainId == 1 else 2])

    def test_op_mainnets_sequencer_gates_its_prices_as_base_and_arbitrums_do(self):
        grace = reads.SEQUENCER_GRACE_SECONDS
        self.assertEqual(grace, 3600)
        for case, answers, reason in (('up past its grace', feed_answers(OPTIMISM, up_for=3601), None),
                                      ('up for its grace only', feed_answers(OPTIMISM, up_for=3600), 'sequencer_down'),
                                      ('down', feed_answers(OPTIMISM, up=1), 'sequencer_down')):
            pricer = reads.Pricer({10: source(OPTIMISM, FakeChain(answers))}, monotonic=Clock(0.0))
            with self.subTest(case=case):
                got = pricer.prices([(10, ZERO, None), (10, OPTIMISM_USDC, None)])
                self.assertEqual(got[(10, ZERO)][1], reason)
                self.assertEqual(got[(10, OPTIMISM_USDC)][0]['usd'], '1.000000000000000000')  # the stable keeps US$ 1

    def test_a_token_there_is_priced_by_its_deepest_pool_there(self):
        # CREATE2 on each chain's own factory: the WETH/USDC 0.05% pools its getPool named on 6 Oct 2026.
        self.assertEqual(v3_pool_address(ETHEREUM, *sorted((ETHEREUM.wrappedNative.address, ETHEREUM_USDC)), 500),
                         '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640')
        self.assertEqual(v3_pool_address(OPTIMISM, *sorted((OPTIMISM.wrappedNative.address, OPTIMISM_USDC)), 500),
                         '0x1fb3cf6e48f1e7b10213e7b6d87d4c073c7fdb7b')
        weth = ETHEREUM.wrappedNative.address
        deep, shallow = PoolRef(3, *sorted((TOKEN, weth)), 500, 10), PoolRef(4, *sorted((TOKEN, ETHEREUM_USDC)), 500, 10)
        weth_tick, usdc_tick = -76_010, -269_390
        answers = {**v3_answers(ETHEREUM, deep, sqrt_at_tick(weth_tick), weth_tick, 6_500 * 10**18),
                   **v4_answers(shallow, sqrt_at_tick(usdc_tick), usdc_tick, 10**15, chain=ETHEREUM),
                   **band_answers(ETHEREUM, deep, sqrt_at_tick(weth_tick), weth_tick, TOKEN),
                   **band_answers(ETHEREUM, shallow, sqrt_at_tick(usdc_tick), usdc_tick, TOKEN),
                   **feed_answers(ETHEREUM)}
        price, reason = reads.Pricer({1: source(ETHEREUM, FakeChain(answers))}, monotonic=Clock(0.0)).prices(
            [(1, TOKEN, 18)])[(1, TOKEN)]
        self.assertIsNone(reason)
        depth = Fraction(featured_depth(deep, sqrt_at_tick(weth_tick), weth_tick, 6_500 * 10**18, TOKEN), 10**18) * 4000
        usd = spot(deep, sqrt_at_tick(weth_tick), TOKEN, 18, 18) * 4000
        self.assertEqual((price['pool'], price['usd'], price['depthUsd'], price['ethUsd']['feed']),
                         (reads.pool_wire(deep), reads.decimal_text(usd, reads.PRICE_SCALE),
                          reads.decimal_text(depth, reads.USD_SCALE), FEEDS[1][0]))
        self.assertTrue(depth >= 10_000 and Fraction(199, 100) < usd < Fraction(201, 100))

    def test_a_balance_chain_has_no_chain_pools(self):
        reader = chain_reads({1: source(ETHEREUM, FakeChain(metadata(TOKEN)))})
        with self.assertRaisesRegex(DataError, '^upstream_unavailable$'):
            reader.pools(1, TOKEN)


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

class AtOnceTests(unittest.TestCase):
    """The chains of one answer are read at once, each within the read's deadline (5 Oct 2026: chain-balances read
    Robinhood, Base and Arbitrum in turn, 2.8 s at the flip)."""

    def sources(self, **options):
        return {chain_id: source(REGISTRY.chain(chain_id), FakeChain(feed_answers(REGISTRY.chain(chain_id)), **options))
                for chain_id in (4663, 8453, 42161)}

    def test_balances_read_every_chain_at_once(self):
        sources = self.sources(barrier=threading.Barrier(3))
        answer = chain_reads(sources).balances(WALLET)
        validate_v6_request_response('chain-balances', {'wallet': WALLET, 'tokens': None}, answer)
        self.assertEqual([(c['chainId'], c['status']) for c in answer['chains']],
                         [(4663, 'current'), (8453, 'current'), (42161, 'current')])

    def test_a_pass_prices_its_chains_at_once(self):
        pricer = reads.Pricer(self.sources(barrier=threading.Barrier(3)), monotonic=Clock(0.0))
        got = pricer.prices([(chain_id, ZERO, None) for chain_id in (42161, 4663, 8453)])
        self.assertEqual({key: (price['source'], reason) for key, (price, reason) in got.items()},
                         {(chain_id, ZERO): ('chainlink_eth_usd', None) for chain_id in (4663, 8453, 42161)})

    def test_the_reads_deadline_bounds_every_chain(self):
        reader = chain_reads(self.sources(delay=0.2))
        with self.assertRaisesRegex(DataError, '^read_deadline_exceeded$'):  # the budget, spent, says so on the way out
            with read_deadline(0.05):
                answer = reader.balances(WALLET)
        self.assertEqual([c['reason'] for c in answer['chains']], ['chain_read_failed'] * 3)

    def test_each_chain_in_order_with_the_callers_deadline_and_failures_after_all(self):
        seen = {}

        def work(chain_id):
            seen[chain_id] = (current_read_deadline(), threading.current_thread())
            return chain_id * 2
        with read_deadline(5):
            outer = current_read_deadline()
            self.assertEqual(reads.each_chain(work, [8453, 4663, 42161]), [16906, 9326, 84322])
        self.assertTrue(all(deadline is outer for deadline, _ in seen.values()))
        self.assertEqual(len({thread for _, thread in seen.values()} - {threading.current_thread()}), 3)
        # One chain alone needs no thread.
        self.assertEqual(reads.each_chain(work, [4663]), [9326])
        self.assertIs(seen[4663][1], threading.current_thread())
        ran = []

        def failing(chain_id):
            ran.append(chain_id)
            if chain_id != 4663:
                raise ValueError(chain_id)
            return chain_id
        with self.assertRaises(ValueError) as caught:
            reads.each_chain(failing, [4663, 8453, 42161])
        self.assertEqual((caught.exception.args, sorted(ran)), ((8453,), [4663, 8453, 42161]))


class KeptConnectionTests(unittest.TestCase):
    """Chain reads over kept HTTPS connections (5 Oct 2026, from the VM: Chainstack 360 ms a call on a new one, 118 ms
    on a kept one); the own node's loopback hop as it was."""

    def test_every_chain_reads_through_kept_rpc(self):
        import v2_rpc
        built = []

        def recording(chain, **kwargs):
            built.append((chain.chainId, kwargs['send']))
            endpoint = v2_rpc.Endpoint('stack', 'stack.example.invalid', 'https://stack.example.invalid/k', None, 50,
                                       None, None)
            return v2_rpc.ChainEndpoints(chain, (endpoint,), 'test', send=kwargs['send'])
        directory = Path(tempfile.mkdtemp(prefix='domino-kept-')).resolve()
        self.addCleanup(shutil.rmtree, directory)
        os.chmod(directory, 0o700)
        path = directory / 'chain-rpc.json'
        endpoint = {'name': 'stack', 'host': 'stack.example.invalid', 'url': 'https://stack.example.invalid/k',
                    'archive': True, 'maxBatchItems': 50, 'maxLogBlocks': 10000, 'requestsPerSecond': None}
        path.write_text(json.dumps({'schemaVersion': 1, 'kind': 'domino-v2-chain-rpc',
                                    'chains': {'base-8453': {'endpoints': [endpoint]}}}))
        path.chmod(0o600)
        balances = directory / 'balance-chain-rpc.json'
        balances.write_text(json.dumps({'schemaVersion': 1, 'kind': 'domino-v2-chain-rpc', 'chains': {
            'ethereum-1': {'endpoints': [endpoint]}, 'optimism-10': {'endpoints': [endpoint]}}}))
        balances.chmod(0o600)
        with mock.patch('v2_rpc.configured_endpoints', side_effect=recording):
            reads.build_chain_reads(provider_config={'any': 'provider file'}, chain_rpc_file=str(path),
                                    balance_chain_rpc_file=str(balances), learned_path=None, registry=REGISTRY)
        self.assertEqual(built, [(4663, reads.kept_rpc), (8453, reads.kept_rpc), (1, reads.kept_rpc),
                                 (10, reads.kept_rpc)])

    def test_kept_rpc_is_rpc_http_on_the_kept_opener_within_the_reads_budget(self):
        with mock.patch.object(reads, 'rpc_http', return_value={'result': '0x1'}) as sent:
            with read_deadline(5):
                self.assertEqual(reads.kept_rpc('https://node.example.invalid/k', {'id': 1}), {'result': '0x1'})
            reads.kept_rpc('https://node.example.invalid/k', {'id': 2})
        (first, second) = sent.call_args_list
        self.assertEqual(first.args, ('https://node.example.invalid/k', {'id': 1}))
        self.assertIs(first.kwargs['opener'], discovery.KEEPALIVE_OPENER)
        self.assertLessEqual(first.kwargs['timeout'], 5)
        self.assertEqual((second.kwargs['timeout'], second.kwargs['opener']), (12, discovery.KEEPALIVE_OPENER))

    def test_the_own_nodes_loopback_hop_never_takes_a_kept_connection(self):
        answer = {'jsonrpc': '2.0', 'id': 1, 'result': '0x1'}
        with mock.patch('discovery.snapshot_loopback_http', return_value=answer) as loopback, \
                mock.patch.object(reads, 'KEEPALIVE_OPENER', side_effect=AssertionError('kept opener')) as kept:
            with read_deadline(5):
                self.assertEqual(reads.kept_rpc(SNAPSHOT_LOOPBACK_RPC, {'id': 1}), answer)
        loopback.assert_called_once()
        kept.assert_not_called()


class HelperTests(unittest.TestCase):
    def test_a_survey_call_answers_every_read_or_is_refused(self):
        class Rpc:
            def __init__(self, raw):
                self.raw, self.sent = raw, []

            def request(self, method, params):
                self.sent.append(params)
                return self.raw
        calls = [(USDC, '0x313ce567')] * 3
        good = '0x' + encode(['(bool,bytes)[]'], [[(True, b'')] * 3]).hex()
        rpc = Rpc(good)
        self.assertEqual(reads.aggregate(rpc, BASE, BLOCK, calls), [(True, b'')] * 3)
        self.assertEqual([(params[0]['to'], params[0]['gas'], params[1]) for params in rpc.sent],
                         [(BASE.multicall3, hex(30_000_000), BLOCK.tag)])
        for case, raw in (('not text', None), ('no 0x', '00' + good[2:]), ('not hex', '0xzz'),
                          ('a read short', '0x' + encode(['(bool,bytes)[]'], [[(True, b'')] * 2]).hex())):
            with self.subTest(case=case), self.assertRaisesRegex(DataError, '^quote_multicall_invalid$'):
                reads.aggregate(Rpc(raw), BASE, BLOCK, calls)

    def test_symbols_are_strings_or_legacy_bytes32_and_never_unsafe(self):
        self.assertEqual(reads.raw_text(True, encode(['string'], ['DAI']), 40), 'DAI')
        self.assertEqual(reads.raw_text(True, b'MKR'.ljust(32, b'\x00'), 40), 'MKR')
        for ok, payload in ((False, encode(['string'], ['X'])), (True, b''), (True, encode(['string'], ['a' * 41])),
                            (True, encode(['string'], ['tab\t'])), (True, b'\xff' * 32), (True, b'\x01')):
            self.assertIsNone(reads.raw_text(ok, payload, 40))

    def test_the_url_list_names_every_endpoint(self):
        reader = chain_reads({8453: source(BASE, FakeChain(), ('https://a.example.invalid/k',))})
        self.assertEqual(reads.endpoint_urls(reader), ('https://a.example.invalid/k',))


def hype_chain(**options):
    """v2_hype_chain's synthetic HYPE chain without Chainlink, loaded beside the live profiles."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import v2_hype_chain as hype
    directory = tempfile.mkdtemp(prefix='domino-hype-')
    try:
        return hype, hype.registry(directory, **options).chain(hype.CHAIN_ID)
    finally:
        shutil.rmtree(directory)


class NativePoolPriceTests(unittest.TestCase):
    """A chain Chainlink does not serve (Elysium's HYPE; v2_hype_chain): HYPE and WHYPE at the pool its profile names,
    qualified as any pool price is, and whatever only they value priced through them, with no feed's round anywhere."""

    @classmethod
    def setUpClass(cls):
        cls.hype, cls.chain = hype_chain()
        _, cls.v4_chain = hype_chain(v4=True)
        cls.id = cls.chain.chainId
        cls.usdc, cls.whype = cls.hype.USDC.lower(), cls.hype.WHYPE.lower()
        cls.native, _, _ = reads.native_pool_of(cls.chain)
        cls.token_pool = PoolRef(3, *sorted((TOKEN, cls.whype)), 3000, 60)

    def native_answers(self, liquidity=10**18, *, usd=40, chain=None, ref=None, currency=None):
        """The native pool at about `usd` a HYPE, no tick initialized within its band: (answers, its sqrt price, its
        depth in USD)."""
        chain, ref = chain or self.chain, ref or self.native
        currency = currency or self.whype
        raw = Fraction(usd * 10**6, 10**18)  # stable per native, raw
        tick = tick_at_sqrt(isqrt_price(raw if ref.currency0 == currency else 1 / raw))
        sqrt = sqrt_at_tick(tick)
        answers = (v4_answers(ref, sqrt, tick, liquidity, chain=chain) if ref.dex == 4
                   else v3_answers(chain, ref, sqrt, tick, liquidity))
        answers.update(band_answers(chain, ref, sqrt, tick, currency))
        depth = Fraction(featured_depth(ref, sqrt, tick, liquidity, currency), 10**6)
        return answers, sqrt, depth

    def pricer(self, answers, chain=None, **options):
        chain = chain or self.chain
        fake = FakeChain(answers, **options)
        return reads.Pricer({chain.chainId: source(chain, fake)}, monotonic=Clock(0.0)), fake

    def expected(self, sqrt, depth, ref=None, currency=None):
        ref, currency = ref or self.native, currency or self.whype
        usd = spot(ref, sqrt, currency, 18, 6)
        return {'usd': reads.decimal_text(usd, reads.PRICE_SCALE), 'source': 'pool', 'snapshot': SNAPSHOT, 'ethUsd': None,
                'pool': reads.pool_wire(ref), 'depthUsd': reads.decimal_text(depth, reads.USD_SCALE)}, usd

    def test_hype_and_whype_are_the_profile_pools_spot_and_no_feed_is_read(self):
        answers, sqrt, depth = self.native_answers()
        pricer, fake = self.pricer(answers)
        got = pricer.prices([(self.id, self.usdc, None), (self.id, ZERO, None), (self.id, self.whype, None)])
        price, usd = self.expected(sqrt, depth)
        self.assertEqual(got[(self.id, ZERO)], (price, None))
        self.assertEqual(got[(self.id, self.whype)], (price, None))
        self.assertEqual(got[(self.id, self.usdc)][0]['source'], 'chain_stable')
        self.assertTrue(Fraction(39) < usd < Fraction(41) and depth >= reads.FLOOR_USD, (usd, depth))
        # One call for the pool's state, one for its words within the band (no tick initialized there to read); no
        # Chainlink round asked anywhere.
        pool = self.hype.v3_pool(self.chain.uniswap.v3.factory, self.chain.uniswap.v3.poolInitCodeHash, self.whype,
                                 self.usdc, 500).lower()
        self.assertEqual(len(fake.batches), 2)
        self.assertEqual(fake.subcalls[:2], [(pool, selector('slot0()'), b''), (pool, selector('liquidity()'), b'')])
        self.assertEqual({call[:2] for call in fake.subcalls[2:]}, {(pool, selector('tickBitmap(int16)'))})
        self.assertNotIn(selector('latestRoundData()'), {call[1] for call in fake.subcalls})

    def test_a_token_against_whype_is_valued_through_that_price_and_carries_no_round(self):
        answers, sqrt, depth = self.native_answers()
        tick = -76_010  # about 0.0005 WHYPE a TOKEN: US$ 0.02
        answers.update({**v3_answers(self.chain, self.token_pool, sqrt_at_tick(tick), tick, 2 * 10**25),
                        **band_answers(self.chain, self.token_pool, sqrt_at_tick(tick), tick, TOKEN)})
        price, reason = self.pricer(answers)[0].prices([(self.id, TOKEN, 18)])[(self.id, TOKEN)]
        _, native_usd = self.expected(sqrt, depth)
        self.assertIsNone(reason)
        self.assertEqual((price['source'], price['ethUsd'], price['pool']), ('pool', None, reads.pool_wire(self.token_pool)))
        self.assertEqual(price['usd'], reads.decimal_text(spot(self.token_pool, sqrt_at_tick(tick), TOKEN, 18, 18)
                                                          * native_usd, reads.PRICE_SCALE))
        token_depth = Fraction(featured_depth(self.token_pool, sqrt_at_tick(tick), tick, 2 * 10**25, TOKEN), 10**18)
        self.assertEqual(price['depthUsd'], reads.decimal_text(token_depth * native_usd, reads.USD_SCALE))

    def test_a_native_pool_short_of_the_floor_or_absent_says_why_and_what_needs_it_has_no_source(self):
        tick = -76_010
        token = {**v3_answers(self.chain, self.token_pool, sqrt_at_tick(tick), tick, 2 * 10**25),
                 **band_answers(self.chain, self.token_pool, sqrt_at_tick(tick), tick, TOKEN)}
        shallow, _, depth = self.native_answers(10**12)
        self.assertLess(depth, reads.FLOOR_USD)
        for case, answers, reason in (('shallow', {**shallow, **token}, 'pool_depth_below_floor'),
                                      ('no pool', token, 'no_pool')):
            with self.subTest(case=case):
                got = self.pricer(answers)[0].prices([(self.id, ZERO, None), (self.id, self.whype, None),
                                                      (self.id, TOKEN, 18), (self.id, self.usdc, None)])
                self.assertEqual([got[(self.id, token)] for token in (ZERO, self.whype, TOKEN)],
                                 [(None, reason), (None, reason), (None, 'no_qualified_price_source')])
                self.assertEqual(got[(self.id, self.usdc)][0]['usd'], '1.000000000000000000')

    def test_the_floor_is_the_one_every_pool_price_meets(self):
        answers, _, depth = self.native_answers()
        for floor, priced in ((depth, True), (depth + Fraction(1, 10**30), False)):
            with self.subTest(floor=float(floor)), mock.patch.object(reads, 'FLOOR_USD', floor):
                price, reason = self.pricer(answers)[0].prices([(self.id, ZERO, None)])[(self.id, ZERO)]
                self.assertEqual((price is not None, reason), (priced, None if priced else 'pool_depth_below_floor'))

    def test_a_failed_depth_round_is_a_failed_read_kept_for_no_one(self):
        answers, _, _ = self.native_answers()
        tick = -76_010
        answers.update({**v3_answers(self.chain, self.token_pool, sqrt_at_tick(tick), tick, 2 * 10**25),
                        **band_answers(self.chain, self.token_pool, sqrt_at_tick(tick), tick, TOKEN)})
        pricer, fake = self.pricer(answers, fail_from=1)
        got = pricer.prices([(self.id, ZERO, None), (self.id, TOKEN, 18)])
        self.assertEqual(got[(self.id, ZERO)], (None, 'price_read_failed'))
        self.assertEqual(got[(self.id, TOKEN)], (None, 'price_read_failed'))
        fake.fail_from = None
        self.assertEqual(pricer.prices([(self.id, ZERO, None)])[(self.id, ZERO)][0]['source'], 'pool')

    def test_a_failed_tick_round_of_the_native_pool_is_a_failed_read_for_what_needs_it(self):
        # The native pool has a tick to cross within its band, the token's pool none: the third round, the ticks, fails,
        # so HYPE is unread while the token's own walk is complete. What only HYPE could value says the read failed, so
        # a later pass tries again, never that it has no source.
        answers, sqrt, _ = self.native_answers()
        currency = self.whype
        partner = self.native.currency1 if self.native.currency0 == currency else self.native.currency0
        low, high = walk_ticks(sqrt, tick_at_sqrt(sqrt), self.native.tick_spacing, partner == self.native.currency1)
        inside = (low + 1) * self.native.tick_spacing
        answers.update(band_answers(self.chain, self.native, sqrt, tick_at_sqrt(sqrt), currency, {inside: 10**15}))
        tick = -76_010
        answers.update({**v3_answers(self.chain, self.token_pool, sqrt_at_tick(tick), tick, 2 * 10**25),
                        **band_answers(self.chain, self.token_pool, sqrt_at_tick(tick), tick, TOKEN)})
        found = reads.survey(self.chain, FakeChain(answers, fail_from=2), BLOCK, [self.token_pool],
                             {self.token_pool: TOKEN})
        self.assertEqual((found.native, found.depths[self.token_pool]), ((None, 'price_read_failed'),
                                                                         (None, 'price_read_failed')))
        self.assertEqual((found.price(TOKEN, 18), found.unread, found.skipped), ((None, 'price_read_failed'), set(), set()))
        pricer, fake = self.pricer(answers, fail_from=2)
        self.assertEqual(pricer.prices([(self.id, TOKEN, 18)])[(self.id, TOKEN)], (None, 'price_read_failed'))

    def test_the_native_pools_walk_is_read_first_and_in_its_own_direction(self):
        # Room for either pool's band words but not both: the native pool's are read, and the listed pool, however
        # deep, waits for another pass. Its walk sells the native currency for the stable: its depth is that stable.
        answers, sqrt, depth = self.native_answers()
        tick = -76_010
        answers.update({**v3_answers(self.chain, self.token_pool, sqrt_at_tick(tick), tick, 2 * 10**25),
                        **band_answers(self.chain, self.token_pool, sqrt_at_tick(tick), tick, TOKEN)})

        def words(sqrt, tick, ref, sold):
            partner = ref.currency1 if ref.currency0 == sold else ref.currency0
            return len(reads.band_words(*reads.band_ticks(sqrt, tick, ref.tick_spacing, partner == ref.currency1)))
        native = words(sqrt, tick_at_sqrt(sqrt), self.native, self.whype)
        token = words(sqrt_at_tick(tick), tick, self.token_pool, TOKEN)
        self.assertLess(max(native, token), native + token)
        with mock.patch.object(reads, 'DEPTH_WORDS', max(native, token)):
            found = reads.survey(self.chain, FakeChain(answers), BLOCK, [self.token_pool], {self.token_pool: TOKEN})
        self.assertEqual(found.native, self.expected(sqrt, depth)[:1] + (None,))
        self.assertEqual((found.depths[self.token_pool], found.skipped), ((None, 'pool_depth_unmeasurable'),
                                                                          {self.token_pool}))

    def test_a_pools_market_against_whype_is_at_the_native_price_or_has_no_qualified_reference(self):
        from v2_read_contract import MARKET_REASONS
        tick = -76_010
        token = {**v3_answers(self.chain, self.token_pool, sqrt_at_tick(tick), tick, 2 * 10**25),
                 **band_answers(self.chain, self.token_pool, sqrt_at_tick(tick), tick, TOKEN)}
        deep, sqrt, depth = self.native_answers()
        shallow, _, _ = self.native_answers(10**12)
        refs = [self.token_pool]
        found = reads.survey(self.chain, FakeChain({**deep, **token}), BLOCK, refs, {self.token_pool: TOKEN})
        _, native_usd = self.expected(sqrt, depth)
        token_depth = Fraction(featured_depth(self.token_pool, sqrt_at_tick(tick), tick, 2 * 10**25, TOKEN), 10**18)
        self.assertEqual(found.depths[self.token_pool], (token_depth * native_usd, None))
        # The native pool's walk and the listed pool's share the two depth rounds: no call more.
        fake = FakeChain({**shallow, **token})
        found = reads.survey(self.chain, fake, BLOCK, refs, {self.token_pool: TOKEN})
        self.assertEqual(found.depths[self.token_pool], (None, 'no_qualified_reference'))
        self.assertIn('no_qualified_reference', MARKET_REASONS)
        self.assertEqual(len(fake.requests), 2)
        # No native pool at all: the same, its reason the native currency's own.
        found = reads.survey(self.chain, FakeChain(token), BLOCK, refs, {self.token_pool: TOKEN})
        self.assertEqual((found.depths[self.token_pool], found.native), ((None, 'no_qualified_reference'),
                                                                         (None, 'no_pool')))

    def test_a_v4_pool_of_native_hype_prices_hype_and_whype(self):
        native, _, currency = reads.native_pool_of(self.v4_chain)
        self.assertEqual((native.dex, native.currency0 if native.currency0 == ZERO else native.currency1, currency),
                         (4, ZERO, ZERO))
        answers, sqrt, depth = self.native_answers(chain=self.v4_chain, ref=native, currency=ZERO)
        got = self.pricer(answers, chain=self.v4_chain)[0].prices([(self.id, ZERO, None), (self.id, self.whype, None)])
        price, usd = self.expected(sqrt, depth, ref=native, currency=ZERO)
        self.assertEqual((got[(self.id, ZERO)], got[(self.id, self.whype)]), ((price, None), (price, None)))
        self.assertEqual(price['pool']['dex'], 4)
        self.assertTrue(Fraction(39) < usd < Fraction(41))

    def test_read_v6_admits_these_prices_under_the_chains_price_profile_and_nothing_at_a_feed(self):
        import v2_read_contract as contract
        profile = reads.price_profile(self.chain)
        self.assertEqual(profile, {'stable': self.usdc, 'wrapped': self.whype, 'feed': None, 'heartbeatSeconds': None,
                                   'nativePool': reads.pool_wire(self.native)})
        answers, sqrt, depth = self.native_answers()
        tick = -76_010
        answers.update({**v3_answers(self.chain, self.token_pool, sqrt_at_tick(tick), tick, 2 * 10**25),
                        **band_answers(self.chain, self.token_pool, sqrt_at_tick(tick), tick, TOKEN)})
        got = self.pricer(answers)[0].prices([(self.id, t, 18 if t == TOKEN else None)
                                              for t in (self.usdc, ZERO, self.whype, TOKEN)])

        def admitted(token, price, reason):
            contract.priced(self.id, token, None if price is None else contract.TokenPrice.model_validate(price), reason)
        with mock.patch.dict(contract.PRICE_PROFILES, {self.id: profile}):
            for (_, token), (price, reason) in got.items():
                with self.subTest(token=token):
                    admitted(token, price, reason)
            native = got[(self.id, ZERO)][0]
            for case, change in (('another pool', lambda p: p['pool'].update(fee=3000)),
                                 ('a feed round', lambda p: p.update(ethUsd=eth_entry(usd=p['usd'], age=0))),
                                 ('a feed source', lambda p: p.update(source='chainlink_eth_usd', pool=None, depthUsd=None,
                                                                      ethUsd=eth_entry(usd=p['usd'], age=0)))):
                with self.subTest(case=case), self.assertRaises(ValueError):
                    defect = json.loads(json.dumps(native))
                    change(defect)
                    admitted(ZERO, defect, None)
            with self.assertRaises(ValueError):
                admitted(TOKEN, {**got[(self.id, TOKEN)][0], 'ethUsd': eth_entry(age=0)}, None)
        # Every Domino chain read-v6 prices has its entry by the same rule, Chainlink's on the three live ones.
        served = {chain_id: entry for chain_id, entry in contract.PRICE_PROFILES.items() if chain_id in REGISTRY_IDS}
        self.assertEqual(served, {chain_id: reads.price_profile(REGISTRY.chain(chain_id)) for chain_id in served})
        self.assertTrue(all(served[chain_id]['feed'] for chain_id in (4663, 8453, 42161)))


REGISTRY_IDS = tuple(chain.chainId for chain in REGISTRY.chains)


def isqrt_price(raw):
    """sqrtPriceX96 of a raw currency1-per-currency0 price."""
    from math import isqrt
    return isqrt(raw.numerator * 2**192 // raw.denominator)


if __name__ == '__main__':
    unittest.main()
