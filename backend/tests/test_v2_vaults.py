"""What the V2 automation reads: discovery, a vault's proof, the v3 TWAP, fee growth, native prices and the L1 fee."""
from fractions import Fraction
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from eth_abi import encode

from discovery import DataError, parse_block
from v2_abi import event, function
from v2_chains import chain as profile
from v2_manifest import checked_deployment
from v2_planner import Limits, returnable
from v2_rpc import ChainEndpoints, Endpoint
from v2_scan_state import REORG_MARGIN, ScanState
from v2_uniswap import PoolRef, v3_fee_growth_inside, v3_pool_address
from v2_vaults import (L1_UPPER_BOUND, OP_GAS_PRICE_ORACLE, TX_OVERHEAD_BYTES, WIRING_SELECTOR, PriceReference,
                       VaultDiscovery, VaultRecord, VaultReader, clone_code, fee_growth_inside, l1_fee,
                       reference_prices, twap_price, twap_window)
from v2_fixtures import HEAD, FakeChain
from test_v2_manifest import manifest_document

ROOT = Path(__file__).resolve().parents[2]
BASE, ARBITRUM = profile('base-8453'), profile('arbitrum-42161')
WETH = BASE.wrappedNative.address
USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
ZERO = '0x' + '00' * 20
BLOCK = parse_block(HEAD)


def client(fake, chain=BASE):
    endpoint = Endpoint('fake', 'fake.invalid', 'https://fake.invalid/', None, 100, None, None)
    endpoints = ChainEndpoints(chain, (endpoint,), 'test', send=fake)
    return endpoints.read_rpc(anchor=BLOCK, batch_reads=True)


class AnchorAndGrowthTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeChain(8453)
        self.deployment = checked_deployment(manifest_document(), BASE)

    def test_the_twap_window_is_what_the_vaults_anchor_accepts(self):
        limits = Limits(100, 100, 300, 1000)
        self.assertEqual(twap_window(limits, 60, 600), 300)
        self.assertEqual(twap_window(limits, 60, 120), 120)
        with self.assertRaisesRegex(DataError, '^v2_twap_window_unavailable$'):
            twap_window(Limits(100, 100, 30, 1000), 60, 600)

    def test_the_twap_is_the_anchors_own_reading(self):
        pool = PoolRef(3, WETH, USDC, 500, 10)
        seen = []
        self.fake.on(self.deployment.price_anchor, function('IDominoPriceAnchor', 'twapSqrtPrice'),
                     lambda ref, window: seen.append((ref, window)) or (2**96 + 7,))
        self.assertEqual(twap_price(client(self.fake), self.deployment, pool, 600, BLOCK), 2**96 + 7)
        self.assertEqual(seen, [((3, WETH, USDC, 500, 10, ZERO), 600)])

    def test_v4_fee_growth_comes_from_the_state_view(self):
        pool = PoolRef(4, ZERO, USDC, 3000, 60)
        self.fake.on(BASE.uniswap.v4.stateView, function('IV4StateViewMinimal', 'getFeeGrowthInside'),
                     lambda pool_id, lower, upper: (pool_id == bytes.fromhex(pool.pool_id[2:]) and (lower, upper) ==
                                                    (-600, 600) and 11 or 0, 22))
        self.assertEqual(fee_growth_inside(BASE, client(self.fake), pool, -600, 600, BLOCK), (11, 22))

    def test_v3_fee_growth_is_the_pools_inside_growth(self):
        pool = PoolRef(3, WETH, USDC, 500, 10)
        target = v3_pool_address(BASE, WETH, USDC, 500)
        tick = 5
        globals_ = (10**30, 3 * 10**29)
        outside = {-600: (10**28, 2 * 10**28), 600: (4 * 10**28, 5 * 10**27)}
        self.fake.on(target, function('IUniswapV3PoolMinimal', 'slot0'), lambda: (2**96, tick, 0, 1, 1, 0, True))
        self.fake.on(target, function('IUniswapV3PoolMinimal', 'feeGrowthGlobal0X128'), lambda: (globals_[0],))
        self.fake.on(target, function('IUniswapV3PoolMinimal', 'feeGrowthGlobal1X128'), lambda: (globals_[1],))
        self.fake.on(target, function('IUniswapV3PoolMinimal', 'ticks'),
                     lambda t: (1, 1, outside[t][0], outside[t][1], 0, 0, 0, True))
        expected = tuple(v3_fee_growth_inside(tick, -600, 600, globals_[i], outside[-600][i], outside[600][i])
                         for i in (0, 1))
        self.assertEqual(fee_growth_inside(BASE, client(self.fake), pool, -600, 600, BLOCK), expected)


class PriceTests(unittest.TestCase):
    class Reader:
        def __init__(self, price):
            self.price = price

        def pool(self, pool, block):
            return type('State', (), {'sqrt_price_x96': self.price})()

    def test_native_prices_come_from_pools_paired_with_the_wrapped_native_token(self):
        # WETH/USDC with WETH as currency0: 2,500 USDC (6 decimals) per ETH, a raw ratio of 2.5e-9.
        price = 3961408125713216879677197  # sqrt(2.5e-9) × 2^96
        reference = PriceReference(USDC, PoolRef(3, WETH, USDC, 500, 10))
        prices = reference_prices(BASE, self.Reader(price), [reference], BLOCK)
        self.assertEqual((prices[ZERO], prices[WETH]), (1, 1))
        expected = 1 / Fraction(price * price, 1 << 192)
        self.assertEqual(prices[USDC], expected)
        self.assertAlmostEqual(float(prices[USDC]), 10**18 / (2500 * 10**6), delta=1)
        with self.assertRaisesRegex(DataError, '^v2_price_reference_invalid$'):
            reference_prices(BASE, self.Reader(price), [PriceReference(USDC, PoolRef(3, USDC, '0x' + 'ff' * 20, 500,
                                                                                         10))], BLOCK)


class L1FeeTests(unittest.TestCase):
    def test_op_stack_asks_the_gas_price_oracle_for_the_transactions_size(self):
        fake = FakeChain(8453)
        seen = []
        original = fake.answer

        def answer(url, body):
            if body['method'] == 'eth_call' and body['params'][0]['to'] == OP_GAS_PRICE_ORACLE:
                seen.append(body['params'][0]['data'])
                return {'jsonrpc': '2.0', 'id': body['id'], 'result': '0x' + encode(['uint256'], [12345]).hex()}
            return original(url, body)
        fake.answer = answer
        self.assertEqual(l1_fee(BASE, client(fake), 1000, BLOCK), 12345)
        self.assertEqual(seen, [L1_UPPER_BOUND + encode(['uint256'], [1000 + TX_OVERHEAD_BYTES]).hex()])

    def test_nitro_folds_it_into_gas(self):
        fake = FakeChain(42161)
        self.assertEqual(l1_fee(ARBITRUM, client(fake, ARBITRUM), 1000, BLOCK), 0)
        self.assertEqual(fake.calls('eth_call'), [])


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.deployment = checked_deployment(manifest_document(), BASE)
        self.created = event('IDominoVaultFactory', 'VaultCreated')

    def log(self, factory, vault, dex, block):
        return {'address': factory, 'blockNumber': hex(block),
                'topics': [self.created.topic, '0x' + encode(['address'], ['0x' + '0b' * 20]).hex(),
                           '0x' + encode(['address'], [vault]).hex(), '0x' + encode(['uint256'], [7]).hex()],
                'data': '0x' + encode(['uint8', 'uint256'], [dex, 0]).hex()}

    def test_both_factories_are_read_from_their_deployment_blocks(self):
        start3, start4 = self.deployment.start_block('vaultFactory.v3'), self.deployment.start_block('vaultFactory.v4')
        logs = {self.deployment.factory(4): [self.log(self.deployment.factory(4), '0x' + 'a4' * 20, 4, start4 + 1)],
                self.deployment.factory(3): [self.log(self.deployment.factory(3), '0x' + 'a3' * 20, 3, start3 + 2),
                                             # A log whose dex is not the factory's proposes nothing.
                                             self.log(self.deployment.factory(3), '0x' + 'a5' * 20, 4, start3 + 3)]}
        reads = []

        class Index:
            def request(self, method, params):
                query = params[0]
                reads.append((query['address'], query['fromBlock'], query['toBlock']))
                return [log for log in logs[query['address']]
                        if int(query['fromBlock'], 16) <= int(log['blockNumber'], 16) <= int(query['toBlock'], 16)]
        head = parse_block({'number': hex(start4 + 10), 'hash': '0x' + '11' * 32, 'timestamp': '0x10'})
        records = VaultDiscovery(self.deployment).scan(Index(), head)
        self.assertEqual([(r.vault, r.dex, r.root_token_id) for r in records],
                         [('0x' + 'a3' * 20, 3, 7), ('0x' + 'a4' * 20, 4, 7)])
        self.assertEqual({read[0] for read in reads}, {self.deployment.factory(3), self.deployment.factory(4)})

    def test_a_log_from_another_address_is_refused(self):
        class Index:
            def request(inner, method, params):
                return [self.log('0x' + 'ee' * 20, '0x' + 'a4' * 20, 4, int(params[0]['fromBlock'], 16))]
        head = parse_block({'number': hex(self.deployment.start_block('vaultFactory.v4') + 1), 'hash': '0x' + '11' * 32,
                            'timestamp': '0x10'})
        with self.assertRaisesRegex(DataError, '^v2_log_address_mismatch$'):
            VaultDiscovery(self.deployment).scan(Index(), head)


class DiscoveryStateTests(unittest.TestCase):
    """Where the scans stopped, kept per window and across processes (v2_scan_state)."""

    def setUp(self):
        self.deployment = checked_deployment(manifest_document(), BASE)
        self.created = event('IDominoVaultFactory', 'VaultCreated')
        self.folder = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.folder)
        self.path = self.folder / 'v2-scans-base-8453.json'
        self.start3 = self.deployment.start_block('vaultFactory.v3')
        self.start4 = self.deployment.start_block('vaultFactory.v4')
        self.logs = {self.deployment.factory(3): [], self.deployment.factory(4): [
            {'address': self.deployment.factory(4), 'blockNumber': hex(self.start4 + 3),
             'topics': [self.created.topic, '0x' + encode(['address'], ['0x' + '0b' * 20]).hex(),
                        '0x' + encode(['address'], ['0x' + 'a4' * 20]).hex(), '0x' + encode(['uint256'], [7]).hex()],
             'data': '0x' + encode(['uint8', 'uint256'], [4, 0]).hex()}]}

    def index(self, budget=None):
        logs, reads = self.logs, []

        class Index:
            def request(inner, method, params):
                if budget is not None and len(reads) >= budget:
                    raise DataError('request_budget_exhausted')
                query = params[0]
                reads.append((query['address'], int(query['fromBlock'], 16), int(query['toBlock'], 16)))
                return [log for log in logs[query['address']]
                        if int(query['fromBlock'], 16) <= int(log['blockNumber'], 16) <= int(query['toBlock'], 16)]
        return Index(), reads

    def head(self, number):
        return parse_block({'number': hex(number), 'hash': '0x' + '11' * 32, 'timestamp': '0x10'})

    def test_a_window_read_moves_the_scan_on_when_a_later_one_runs_out_of_budget(self):
        discovery = VaultDiscovery(self.deployment, max_blocks_per_read=4)
        end = max(self.start3, self.start4) + 40
        index, reads = self.index(budget=3)
        with self.assertRaisesRegex(DataError, '^request_budget_exhausted$'):
            discovery.scan(index, self.head(end))
        self.assertEqual(discovery.next_block[3], self.start3 + 12)
        # The next pass goes on from there, it does not start over.
        index, reads = self.index()
        discovery.scan(index, self.head(end))
        self.assertEqual(reads[0][1:], (self.start3 + 12, self.start3 + 15))

    def test_where_the_scan_stopped_and_what_it_found_outlive_the_process(self):
        end = max(self.start3, self.start4) + 200
        index, _ = self.index()
        first = VaultDiscovery(self.deployment, max_blocks_per_read=50, state=ScanState(self.path, self.deployment))
        self.assertEqual([r.vault for r in first.scan(index, self.head(end))], ['0x' + 'a4' * 20])
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)
        again = VaultDiscovery(self.deployment, max_blocks_per_read=50, state=ScanState(self.path, self.deployment))
        # It starts REORG_MARGIN blocks before the head it saw, with the vault it found.
        self.assertEqual(again.next_block, {3: end + 1 - REORG_MARGIN, 4: end + 1 - REORG_MARGIN})
        index, reads = self.index()
        self.assertEqual([(r.vault, r.owner, r.root_token_id, r.dex, r.block_number)
                          for r in again.scan(index, self.head(end + 10))],
                         [('0x' + 'a4' * 20, '0x' + '0b' * 20, 7, 4, self.start4 + 3)])
        # Nothing before that is read again.
        self.assertEqual(min(read[1] for read in reads), end + 1 - REORG_MARGIN)

    def test_a_scan_that_stops_on_its_budget_keeps_its_progress_on_disk(self):
        end = max(self.start3, self.start4) + 400
        index, _ = self.index(budget=2)
        discovery = VaultDiscovery(self.deployment, max_blocks_per_read=50, state=ScanState(self.path, self.deployment))
        with self.assertRaises(DataError):
            discovery.scan(index, self.head(end))
        saved = json.loads(self.path.read_text())['scans']['vaultFactory.v3']
        self.assertEqual(saved['next'], self.start3 + 100)
        self.assertEqual(VaultDiscovery(self.deployment, state=ScanState(self.path, self.deployment)).next_block[3],
                         self.start3 + 100)

    def test_a_state_for_another_deployment_is_ignored(self):
        index, _ = self.index()
        VaultDiscovery(self.deployment, state=ScanState(self.path, self.deployment)).scan(
            index, self.head(max(self.start3, self.start4) + 500))
        saved = json.loads(self.path.read_text())
        saved['identity']['vaultFactory.v4'] = '0x' + 'ee' * 20
        self.path.write_text(json.dumps(saved))
        fresh = VaultDiscovery(self.deployment, state=ScanState(self.path, self.deployment))
        self.assertEqual((fresh.next_block, fresh.records), ({3: self.start3, 4: self.start4}, {}))

    def test_the_state_is_private_to_the_automation(self):
        os.chmod(self.folder, 0o755)
        with self.assertRaisesRegex(DataError, '^v2_scan_state_directory_not_private$'):
            ScanState(self.path, self.deployment)
        os.chmod(self.folder, 0o700)
        self.path.write_text('{}')
        os.chmod(self.path, 0o644)
        with self.assertRaisesRegex(DataError, '^v2_scan_state_file_not_private$'):
            ScanState(self.path, self.deployment)

    def test_a_window_with_a_foreign_log_counts_nothing(self):
        # A valid v3 vault, then, in the same window, a log from another address.
        valid = {**self.logs[self.deployment.factory(4)][0], 'address': self.deployment.factory(3),
                 'blockNumber': hex(self.start3),
                 'topics': [self.created.topic, '0x' + encode(['address'], ['0x' + '0b' * 20]).hex(),
                            '0x' + encode(['address'], ['0x' + 'a3' * 20]).hex(), '0x' + encode(['uint256'], [7]).hex()],
                 'data': '0x' + encode(['uint8', 'uint256'], [3, 0]).hex()}
        self.logs[self.deployment.factory(3)] += [valid, {**self.logs[self.deployment.factory(4)][0],
                                                          'blockNumber': hex(self.start3 + 1)}]
        discovery = VaultDiscovery(self.deployment, max_blocks_per_read=4,
                                   state=ScanState(self.path, self.deployment))
        index, _ = self.index()
        with self.assertRaisesRegex(DataError, '^v2_log_address_mismatch$'):
            discovery.scan(index, self.head(max(self.start3, self.start4) + 40))
        self.assertEqual((discovery.next_block[3], discovery.records), (self.start3, {}))


class ProofTests(unittest.TestCase):
    def test_the_clone_is_the_factorys_eip1167_runtime(self):
        source = (ROOT / 'contracts/src/v2/vault/DominoV2VaultFactory.sol').read_text()
        prefix, suffix = re.search(r'hex"3d602d80600a3d3981f3([0-9a-f]+)", implementation, hex"([0-9a-f]+)"',
                                   source).groups()
        implementation = '0x' + '12' * 20
        self.assertEqual(clone_code(implementation), '0x' + prefix + implementation[2:] + suffix)
        self.assertEqual(len(bytes.fromhex(clone_code(implementation)[2:])), 45)

    def test_a_vault_that_is_not_the_manifests_clone_or_wiring_is_refused(self):
        deployment = checked_deployment(manifest_document(), BASE)
        vault = '0x' + 'a4' * 20
        fake = FakeChain(8453)
        fake.codes[vault] = clone_code(deployment.address('vault.v3'))  # another implementation's clone
        fake.on(deployment.factory(4), function('IDominoVaultFactory', 'isVault'), lambda account: (True,))
        reader = VaultReader(BASE, deployment, client(fake), uniswap=None)
        with self.assertRaisesRegex(DataError, '^v2_vault_not_a_clone$'):
            reader.prove(vault, 4, BLOCK)
        fake.codes[vault] = clone_code(deployment.address('vault.v4'))
        wiring = [deployment.factory(4), deployment.registry, deployment.price_anchor, BASE.uniswap.v4.positionManager,
                  deployment.address('vaultSwap'), '0x' + 'ee' * 20]  # another auto-exit
        original = fake.answer

        def answer(url, body):
            if body['method'] == 'eth_call' and body['params'][0]['data'] == WIRING_SELECTOR:
                return {'jsonrpc': '2.0', 'id': body['id'],
                        'result': '0x' + encode(['(address,address,address,address,address,address)'],
                                                [tuple(wiring)]).hex()}
            return original(url, body)
        fake.answer = answer
        with self.assertRaisesRegex(DataError, '^v2_vault_wiring_mismatch$'):
            reader.prove(vault, 4, BLOCK)
        wiring[5] = deployment.auto_exit
        fake.on(deployment.factory(4), function('IDominoVaultFactory', 'isVault'), lambda account: (False,))
        with self.assertRaisesRegex(DataError, '^v2_vault_wiring_mismatch$'):
            reader.prove(vault, 4, BLOCK)  # a clone the factory does not know
        fake.on(deployment.factory(4), function('IDominoVaultFactory', 'isVault'), lambda account: (True,))
        reader.prove(vault, 4, BLOCK)
        self.assertIn((vault, 4), reader._proven)



class ClosedRootTests(unittest.TestCase):
    """A root its owner burned no longer exists: the reader sees a closed root,
    so the vault's reserves can still go back to the owner (returnReserves)."""

    VAULT, OWNER, ROOT_ID, CHILD_ID = '0x' + 'a4' * 20, '0x' + 'b0' * 20, 7, 9

    class Positions:
        """v2_uniswap.UniswapReader's two reads: the root's fails with `error`."""

        def __init__(self, error, pool, *, gone=(7,)):
            self.error, self.ref, self.gone = error, PoolRef(*pool), gone

        def position(self, ref, block):
            if ref.token_id in self.gone:
                raise DataError(self.error)
            return type('Position', (), {'pool': self.pool(self.ref, block), 'tick_lower': -600, 'tick_upper': 600,
                                         'liquidity': 10**18, 'fees_owed': (0, 0)})()

        def pool(self, ref, block):
            return type('State', (), {'pool': self.ref, 'sqrt_price_x96': 2**96, 'liquidity': 10**18,
                                      'swap_fee_pips': lambda self, zero_for_one: 3000})()

    def reader(self, dex, error, *, members=(7,), gone=(7,), quote=USDC):
        deployment = checked_deployment(manifest_document(), BASE)
        fake = FakeChain(8453)
        manager = BASE.uniswap.v3.positionManager if dex == 3 else BASE.uniswap.v4.positionManager
        pool = (dex, WETH, USDC, 3000, 60, ZERO) if dex == 3 else (dex, ZERO, USDC, 3000, 60, ZERO)
        views = {'owner': (self.OWNER,), 'pool': (pool,), 'root': ((dex, manager, self.ROOT_ID),),
                 'positions': (list(members),), 'policy': ((2, 500, 2000, 600, 3),),
                 'limits': ((100, 100, 300, 5000),), 'paused': (False,), 'rootArmed': (False,), 'stateNonce': (9,)}
        for name, value in views.items():
            fake.on(self.VAULT, function('IDominoVault', name), lambda value=value: value)
        fake.on(self.VAULT, function('IDominoVault', 'reserves'),
                lambda token: (1000 if token == pool[1] else 3,))
        fake.on(self.VAULT, function('IDominoVaultLedger', 'lastExecutionAt'), lambda: (0,))
        fake.on(self.VAULT, function('IDominoVaultLedger', 'quoteCurrency'), lambda: (quote,))
        fake.on(self.VAULT, function('IDominoVaultLedger', 'member'),
                lambda token_id: ((True, 0, 0, -600, 600) if token_id == self.ROOT_ID
                                  else (True, self.ROOT_ID, 0, 600, 4200),))
        fake.on(self.VAULT, function('IDominoVaultLedger', 'lot'), lambda token_id, token: ((5, 6),))
        fake.on(deployment.registry, function('IDominoRegistry', 'automationHalted'), lambda: (False,))
        reader = VaultReader(BASE, deployment, client(fake), self.Positions(error, pool, gone=gone),
                             proven={(self.VAULT, dex)})
        return reader, VaultRecord(self.VAULT, self.OWNER, self.ROOT_ID, dex, 1)

    def test_the_quote_currency_sets_the_orientation_and_must_be_the_pools(self):
        # USDC sorts above WETH and native ETH: the quote is currency1, prices read upright.
        reader, record = self.reader(4, 'v2_position_not_found')
        self.assertFalse(reader.read(record, BLOCK).inverse)
        reader, record = self.reader(4, 'v2_position_not_found', quote=ZERO)
        self.assertTrue(reader.read(record, BLOCK).inverse)
        reader, record = self.reader(4, 'v2_position_not_found', quote='0x' + 'cd' * 20)
        with self.assertRaisesRegex(DataError, '^v2_vault_state_invalid$'):
            reader.read(record, BLOCK)

    def test_a_burned_root_reads_as_closed_on_both_dexes(self):
        for dex, error in ((4, 'v2_position_not_found'), (3, 'rpc_call_reverted')):
            with self.subTest(dex=dex):
                reader, record = self.reader(dex, error)
                state = reader.read(record, BLOCK)
                root, = state.members
                self.assertEqual((root.token_id, root.liquidity, root.fees_owed, root.lots),
                                 (self.ROOT_ID, 0, (0, 0), ((5, 6), (5, 6))))
                self.assertEqual((root.tick_lower, root.tick_upper), (-600, 600))
                self.assertTrue(returnable(state))
                self.assertEqual(reader.reserves(state, BLOCK), (1000, 3))

    def test_any_other_failure_still_refuses_the_read(self):
        reader, record = self.reader(4, 'v4_position_pool_mismatch')
        with self.assertRaisesRegex(DataError, '^v4_position_pool_mismatch$'):
            reader.read(record, BLOCK)
        # Only the root can be gone: a successor the vault holds cannot.
        reader, record = self.reader(4, 'v2_position_not_found', members=(7, 9), gone=(9,))
        with self.assertRaisesRegex(DataError, '^v2_position_not_found$'):
            reader.read(record, BLOCK)


if __name__ == '__main__':
    unittest.main()
