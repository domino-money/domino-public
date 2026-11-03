"""eth_call gas on Nitro, where a call's gas must first cover its L1 data cost.

On 29 Oct 2026, at the blocks of 20:59-21:31 and 22:22-22:28 UTC, an L1 price
spike made that cost alone pass 5M gas (Robinhood's L2 base fee is
0.021 gwei): every eth_call capped at MAX_READ_CALL_GAS (500,000) failed with
"err: intrinsic gas too low (supplied gas 500000)", on the node and on the
hosted provider alike, while 30M passed. The read path answered 503 rpc_error
(pools, nft-positions, wallet-assets, pool-activity), and four queue requests
kept failing at the same chunk end block, whose span the unrecognized error
never shrank (ATIVIDADE_E_FILA.md section 2.2, CARGA_DO_NO.md section 5).

The node here is synthetic: it refuses, as Nitro does, every eth_call whose gas
is below the block's intrinsic cost, and answers the rest.
"""
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

from eth_abi import encode
from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from activity_indexer import ActivityIndexer  # noqa: E402
from catalogue_indexer import IndexRpc  # noqa: E402
from discovery import (CHAIN_ID, MAX_READ_CALL_GAS, POOL_MANAGER, POSITION_MANAGER, STATE_VIEW,  # noqa: E402
                       TRUSTED_READ_CALL_GAS, Block, DataError, DiscoveryReader, PoolKey, ReadRpc, RpcIntrinsicGas,
                       rpc_error_code, rpc_failure)
from indexer_io import AdaptiveSpan  # noqa: E402
from rpc_failover import FailoverReadRpc  # noqa: E402
from test_discovery import KEY, POOL, TOKEN  # noqa: E402

LOCAL = 'https://rpc.domino.money/TEST_LOCAL_TOKEN_0123456/'
ARCHIVE = 'https://robinhood-mainnet.g.alchemy.com/v2/test-fallback'
HEAD = 2000
SPIKE = 5_265_600  # the block's L1 data cost in L2 gas: more than 5M, as measured
MISSING = {'code': -32000, 'message': 'missing trie node ' + 'a' * 64 + ' (path 00) state unavailable'}


def selector(signature):
    return '0x' + keccak(signature.encode())[:4].hex()


ANSWERS = {selector('poolManager()'): encode(['address'], [POOL_MANAGER]),
           selector('poolKeys(bytes25)'): encode(['address', 'address', 'uint24', 'int24', 'address'], list(KEY)),
           selector('getSlot0(bytes32)'): encode(['uint160', 'int24', 'uint24', 'uint24'], [2**96, 0, 0, 3000]),
           selector('getLiquidity(bytes32)'): encode(['uint128'], [10**18]),
           selector('getFeeGrowthGlobals(bytes32)'): encode(['uint256', 'uint256'], [7, 9]),
           selector('decimals()'): encode(['uint8'], [6]),
           selector('symbol()'): encode(['string'], ['TOKEN'])}


def header(number):
    return {'number': hex(number), 'hash': '0x' + f'{number:064x}', 'timestamp': hex(1000 + number)}


class NitroNode:
    """Every route of a chain at a spike: an eth_call whose gas is below `intrinsic` is refused before it runs.
    `pruned`: routes that refuse old state (the own node), as the queue worker meets them."""
    def __init__(self, intrinsic=SPIKE, pruned=()):
        self.intrinsic, self.pruned, self.calls = intrinsic, set(pruned), []

    def __call__(self, url, body):
        return [self.one(url, item) for item in body] if isinstance(body, list) else self.one(url, body)

    def one(self, url, body):
        method, params = body['method'], body['params']
        self.calls.append((url, method, params))
        reply = {'jsonrpc': '2.0', 'id': body['id']}
        if method == 'eth_chainId':
            reply['result'] = hex(CHAIN_ID)
        elif method == 'eth_getBlockByNumber':
            reply['result'] = header(HEAD if params[0] == 'latest' else int(params[0], 16))
        elif method == 'eth_getCode':
            reply['result'] = '0x6000'
        elif method == 'eth_call':
            call, block = params
            gas = int(call['gas'], 16)
            if url in self.pruned and int(block, 16) < HEAD - 100:
                reply['error'] = MISSING
            elif gas < self.intrinsic:
                reply['error'] = {'code': -32000, 'message': f'err: intrinsic gas too low (supplied gas {gas})'}
            else:
                reply['result'] = '0x' + ANSWERS[call['data'][:10]].hex()
        else:
            raise AssertionError(method)
        return reply

    def eth_calls(self):
        return [(url, params[0]['to'], int(params[0]['gas'], 16)) for url, method, params in self.calls
                if method == 'eth_call']


class ClassificationTests(unittest.TestCase):
    def test_the_refusal_of_a_call_that_never_ran_is_a_gas_limit(self):
        for message in ('err: intrinsic gas too low (supplied gas 500000)',  # what the node and the provider said
                        'ERR: Intrinsic gas too low (supplied gas 5000000)',
                        'intrinsic gas too low: have 500000, want 5265600',
                        'err: intrinsic gas too low: have 21000, want 53000 (supplied gas 21000)',
                        'intrinsic gas too low'):
            with self.subTest(message=message):
                error = {'code': -32000, 'message': message}
                self.assertEqual(rpc_error_code('eth_call', error), 'rpc_call_gas_limit')
                refusal = rpc_failure('eth_call', error)
                self.assertIsInstance(refusal, RpcIntrinsicGas)
                self.assertEqual(str(refusal), 'rpc_call_gas_limit')
                self.assertEqual(rpc_error_code('eth_getBalance', error), 'rpc_error')
        for message in ('err: intrinsic gas too low (supplied gas 500000) via /SECRET',
                        'err: insufficient funds for gas * price + value (supplied gas 500000)',
                        'intrinsic gas too low: have many'):
            with self.subTest(message=message):
                self.assertEqual(rpc_error_code('eth_call', {'code': -32000, 'message': message}), 'rpc_error')
        # A call that ran out of gas did run: the same public code, not the never-ran signal.
        ran = rpc_failure('eth_call', {'code': -32000, 'message': 'out of gas'})
        self.assertEqual(str(ran), 'rpc_call_gas_limit')
        self.assertNotIsInstance(ran, RpcIntrinsicGas)
        # Revert data still wins over words.
        self.assertEqual(rpc_error_code('eth_call', {'code': -32000, 'message': 'intrinsic gas too low',
                                                     'data': '0x08c379a0'}), 'rpc_call_reverted')


class TrustedGasTests(unittest.TestCase):
    def test_the_fixed_uniswap_contracts_carry_the_trusted_ceiling_and_any_other_the_profile(self):
        for profile in (MAX_READ_CALL_GAS, 150_000):
            rpc = ReadRpc(LOCAL, call_gas_limit=profile)

            def gas(target):
                return int(rpc.call_params(target, 'poolManager()', block='0x1')[0]['gas'], 16)
            self.assertEqual({target: gas(target) for target in (STATE_VIEW, POSITION_MANAGER, POOL_MANAGER, TOKEN)},
                             {STATE_VIEW: TRUSTED_READ_CALL_GAS, POSITION_MANAGER: TRUSTED_READ_CALL_GAS,
                              POOL_MANAGER: profile, TOKEN: profile})
            # A checksummed spelling is the same contract.
            self.assertEqual(gas('0x' + STATE_VIEW[2:].upper()), TRUSTED_READ_CALL_GAS)
            self.assertEqual(rpc.call_gas_limit, profile)

    def test_a_batch_admits_the_trusted_ceiling_for_those_contracts_only(self):
        rpc = ReadRpc(LOCAL, batch_reads=True)

        def spec(target, gas):
            return ('eth_call', [{'to': target, 'data': selector('poolManager()'), 'gas': hex(gas)}, '0x1'])
        self.assertEqual(len(rpc._batch_specs([spec(STATE_VIEW, TRUSTED_READ_CALL_GAS),
                                               spec(POSITION_MANAGER, TRUSTED_READ_CALL_GAS),
                                               spec(TOKEN, MAX_READ_CALL_GAS)])), 3)
        for target, gas in ((TOKEN, MAX_READ_CALL_GAS + 1), (POOL_MANAGER, TRUSTED_READ_CALL_GAS),
                            (STATE_VIEW, TRUSTED_READ_CALL_GAS + 1)):
            with self.subTest(target=target, gas=gas), self.assertRaisesRegex(DataError,
                                                                             '^invalid_read_call_gas_limit$'):
                rpc._batch_specs([spec(target, gas)])


class SpikeTests(unittest.TestCase):
    """The reads of 29 Oct at a block of the spike, through the clients that made them."""

    def test_the_read_path_snapshot_and_pool_read_answer_and_a_token_fails_once(self):
        node = NitroNode()
        rpc = FailoverReadRpc((LOCAL, ARCHIVE), transport=node, batch_reads=True)
        reader = DiscoveryReader(rpc, clock=lambda: 1000 + HEAD)
        # Every route's snapshot checks both Uniswap contracts' links with eth_calls: they failed the route before.
        block = reader.snapshot()
        pool = reader.pool({'poolId': POOL, 'poolKey': None, 'currencies': None, 'providerMetrics': None}, block)
        self.assertEqual((pool['sqrtPriceX96'], pool['currentLpFeePips']), (str(2**96), 3000))
        before = len(node.eth_calls())
        token = reader.token_lookup(TOKEN, block)
        self.assertEqual((token['readStatus'], token['reason']), ('unavailable', 'rpc_call_gas_limit'))
        # One refused read at the profile, nothing re-sent, no other route asked, the read still usable.
        self.assertEqual(node.eth_calls()[before:], [(LOCAL, TOKEN, MAX_READ_CALL_GAS)])
        self.assertEqual({url for url, _, _ in node.calls}, {LOCAL})
        self.assertIsNone(rpc.failure)
        self.assertTrue(all(gas == TRUSTED_READ_CALL_GAS for _, target, gas in node.eth_calls()
                            if target in (STATE_VIEW, POSITION_MANAGER)))

    def test_the_queue_reconciliation_reads_the_chunk_end_on_the_archive(self):
        # The own node has pruned the chunk end's state; the archive provider is at the spike.
        node = NitroNode(pruned={LOCAL})
        rpc = IndexRpc((LOCAL, ARCHIVE), transport=node)
        rpc.request('eth_getBlockByNumber', ['latest', False])
        end = Block(HEAD - 1000, header(HEAD - 1000)['hash'], 1000 + HEAD - 1000)
        state = ActivityIndexer(SimpleNamespace(catalogue=None), rpc).read_state(POOL, end, PoolKey.checked(KEY, POOL))
        self.assertEqual((state['sqrtPriceX96'], state['activeLiquidityRaw'], state['feeGrowthGlobalX128']),
                         (str(2**96), str(10**18), ['7', '9']))
        archive = [gas for url, target, gas in node.eth_calls() if url == ARCHIVE]
        self.assertEqual(archive, [TRUSTED_READ_CALL_GAS] * 3)

    def test_an_arbitrary_contract_at_the_spike_fails_fast_on_each_route_once(self):
        node = NitroNode(pruned={LOCAL})
        rpc = IndexRpc((LOCAL, ARCHIVE), transport=node)
        rpc.request('eth_getBlockByNumber', ['latest', False])
        with self.assertRaises(RpcIntrinsicGas):
            rpc.call(TOKEN, 'decimals()', outputs=['uint8'], block=hex(HEAD - 1000))
        # The node refused the state, the archive the gas: two calls, no retry, no gas escalation.
        self.assertEqual(node.eth_calls(), [(LOCAL, TOKEN, MAX_READ_CALL_GAS), (ARCHIVE, TOKEN, MAX_READ_CALL_GAS)])


class ChunkEndTests(unittest.TestCase):
    def test_a_chunk_whose_end_reads_at_a_spike_moves_its_end_and_succeeds(self):
        # The four queue requests of 29 Oct: next block 101,108,303, a 100k span ending at 101,208,302, inside
        # the spike of 101,197,500-101,208,302; the span never shrank for the unrecognized error.
        start, spike = 101_108_303, range(101_197_500, 101_208_303)
        span = AdaptiveSpan(100_000, floor=1_000, ceiling=100_000, growth_passes=1)
        ends = []

        def step(value):
            end = start + value - 1
            ends.append(end)
            if end in spike:
                raise RpcIntrinsicGas('rpc_call_gas_limit')
            return {'status': 'indexed', 'through': end}
        self.assertEqual(span.run(step), {'status': 'indexed', 'through': 101_133_302})
        self.assertEqual(ends, [101_208_302, 101_133_302])
        self.assertEqual(span.shrinks, 1)


class V2EnrichmentTests(unittest.TestCase):
    """The V2 index keeps a token's metadata once, and a vault's or a position's read until the next one. A call
    refused before it ran read as rpc_error, which the enrichment takes as transient (the pass stops and reads
    it again); as rpc_call_gas_limit it must stay transient, never be kept. One that ran out of gas is kept."""
    BLOCK = Block(HEAD, header(HEAD)['hash'], 1000 + HEAD)

    class Calls:
        """A batching client: a refused item comes back in its place, as ReadRpc.batch(item_errors=True)."""
        batch_reads, call_gas_limit, MAX_BATCH_ITEMS = True, MAX_READ_CALL_GAS, 100

        def __init__(self, failures):
            self.failures = failures

        def batch(self, specs, *, item_errors):
            assert item_errors
            return [self.failures.get(params[0]['data'], '0x' + ANSWERS[params[0]['data']].hex())
                    for _, params in specs]

    def test_a_token_read_refused_at_a_spike_is_not_kept(self):
        import v2_snapshots
        for name in ('decimals()', 'symbol()'):
            with self.subTest(read=name), self.assertRaises(RpcIntrinsicGas):
                v2_snapshots.read_tokens(self.Calls({selector(name): RpcIntrinsicGas('rpc_call_gas_limit')}),
                                         self.BLOCK, [TOKEN])
        ran = v2_snapshots.read_tokens(self.Calls({selector('decimals()'): DataError('rpc_call_gas_limit')}),
                                       self.BLOCK, [TOKEN])
        self.assertEqual(ran, {TOKEN: (None, 'TOKEN', 'partial', {'decimals': 'rpc_call_gas_limit'})})

    def test_a_position_read_refused_at_a_spike_is_not_kept(self):
        from unittest.mock import patch
        import v2_snapshots
        from v2_chains import default_registry
        chain = default_registry().chain('robinhood-4663')
        for failure, kept in ((RpcIntrinsicGas('rpc_call_gas_limit'), None), (DataError('rpc_call_gas_limit'),
                                                                                ('unavailable', 'rpc_call_gas_limit'))):
            reader = SimpleNamespace(position=lambda *args, failure=failure: (_ for _ in ()).throw(failure))
            with self.subTest(failure=type(failure).__name__), patch.object(v2_snapshots, 'UniswapReader',
                                                                            lambda *args: reader):
                if kept is None:
                    with self.assertRaises(RpcIntrinsicGas):
                        v2_snapshots.read_position(None, chain, self.BLOCK, 4, 7, HEAD)
                else:
                    status, _, _, reason = v2_snapshots.read_position(None, chain, self.BLOCK, 4, 7, HEAD)
                    self.assertEqual((status, reason), kept)


if __name__ == '__main__':
    unittest.main()
