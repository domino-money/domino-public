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

from eth_abi import decode, encode
from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import v2_chain_reads as reads  # noqa: E402
from discovery import ZERO, Block, DataError  # noqa: E402
from v2_chains import default_registry  # noqa: E402
from v2_read_contract import validate_v6_request_response  # noqa: E402
from v2_uniswap import PoolRef, PoolState, v3_pool_address  # noqa: E402

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

    def __init__(self, answers=None, fail=False):
        self.answers, self.fail, self.requests, self.subcalls = dict(answers or {}), fail, [], []

    def request(self, method, params):
        if self.fail:
            raise DataError('http_503')
        self.requests.append((method, params))
        calls, = decode(['(address,bool,bytes)[]'], bytes.fromhex(params[0]['data'][10:]))
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
                   **v3_answers(BASE, usdc_v3, 2**96, 7, 10_000), **metadata(TOKEN)}
        chain = FakeChain(answers)
        learned = reads.LearnedTokens()
        answer = chain_reads({8453: source(BASE, chain)}, learned=learned).pools(8453, TOKEN)
        validate_v6_request_response('chain-pools', {'chainId': 8453, 'token': TOKEN, 'pairedToken': None}, answer)
        # One billed call: 26 pools (two reads each), 7 tiers' spacings, the token's metadata.
        self.assertEqual(len(chain.requests), 1)
        self.assertEqual(len(chain.subcalls), 26 * 2 + 7 + 3)
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
        self.assertEqual(v3['market'], {'status': 'unavailable', 'reason': 'no_qualified_price_source'})
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
        self.assertEqual(len(chain.subcalls), (4 + 7) * 2 + 7 + 3)
        self.assertEqual((answer['pairedToken'], answer['pools'], answer['truncated']), (USDC, [], False))
        # ETH itself: v4 only, its pairs ETH/WETH skipped.
        native = FakeChain()
        chain_reads({8453: source(BASE, native)}).pools(8453, ZERO)
        self.assertEqual(len(native.subcalls), 4 * 2)
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
        self.assertEqual(len(base.requests), 1)
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
                         [{'address': TOKEN, 'symbol': 'WBTC', 'decimals': 8, 'balanceRaw': '3', 'status': 'read'}])
        self.assertEqual(answer['coverage'], 'complete')
        reader.balances(WALLET, [(8453, TOKEN)])
        self.assertEqual(len(chain.requests), 1)
        monotonic.now = reads.BALANCES_CACHE_SECONDS + 1
        reader.balances(WALLET, [(8453, TOKEN)])
        self.assertEqual(len(chain.requests), 2)


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
