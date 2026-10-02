"""The V2 v4 reader against the official v4 contracts on a local chain.

A real PoolManager, PositionManager and StateView (the vendored official
sources), a real position and real swaps: the fees the reader reports as owed
are exactly what the position manager pays the owner when the owner collects,
and the custody facts are the ones the owner set. The chain profile is
Robinhood's with these local deployments and their runtime code hashes in
place of the mainnet ones.
"""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from eth_abi import encode
from eth_hash.auto import keccak
from eth_utils import to_checksum_address

from discovery import ZERO
from evm_harness import EvmHarness as Harness, KEY_TYPE, calldata
from v2_chains import DEX_V4
from v2_rpc import ChainEndpoints, Endpoint
from v2_uniswap import PoolRef, PositionRef, UniswapReader
from v2_fixtures import documents, write_registry

LIQUIDITY = 10**18
DECREASE_LIQUIDITY, TAKE_PAIR = 0x01, 0x11  # v4-periphery Actions


@unittest.skipUnless(os.environ.get('DOMINO_TEST_EVM') == '1', 'requires isolated local Anvil')
class V4ReaderEvmTests(unittest.TestCase):
    setUpClass = classmethod(Harness.setUpClass.__func__)
    stop = classmethod(Harness.stop.__func__)
    send = Harness.send
    deploy = Harness.deploy
    call = Harness.call

    def setUp(self):
        manager = self.deploy('PoolManager.sol', 'PoolManager', ['address'], [self.owner])
        self.positions = self.deploy('PositionManager.sol', 'PositionManager',
                                     ['address', 'address', 'uint256', 'address', 'address'],
                                     [manager, '0x' + '11' * 20, 100000, '0x' + '22' * 20, '0x' + '33' * 20])
        self.state = self.deploy('StateView.sol', 'StateView', ['address'], [manager])
        self.controller = self.deploy('OfficialV4Fixture.sol', 'OfficialV4Controller', ['address', 'address'],
                                      [manager, self.positions])
        self.trader = self.deploy('OfficialV4Fixture.sol', 'OfficialV4SwapDriver', ['address'], [manager])
        self.tokens = sorted(self.deploy('OfficialV4Fixture.sol', 'OfficialFixtureToken') for _ in range(2))
        self.key = (*self.tokens, 3000, 60, ZERO)
        for token in self.tokens:
            for holder in (self.controller, self.trader):
                self.send(token, calldata('mint(address,uint256)', ['address', 'uint256'], [holder, 10**24]))
        self.send(manager, calldata('initialize(' + KEY_TYPE + ',uint160)', [KEY_TYPE, 'uint160'], [self.key, 2**96]))
        self.send(self.controller, calldata('seed(' + KEY_TYPE + ',uint128)', [KEY_TYPE, 'uint128'], [self.key, LIQUIDITY]))
        self.token_id = self.call(self.controller, 'tokenId()', ['uint256'])[0]
        self.reader = UniswapReader(*self.local_chain(manager))

    def local_chain(self, manager):
        """Robinhood's profile with the local v4 deployment and its code hashes."""
        docs = documents()
        document = docs['robinhood-4663.json']
        v4 = document['uniswap']['v4']
        local = {'poolManager': manager, 'positionManager': self.positions, 'stateView': self.state}
        text = json.dumps(document)
        for name, address in local.items():
            text = text.replace(v4[name], to_checksum_address(address))
        document = docs['robinhood-4663.json'] = json.loads(text)
        for record in document['verification']['contracts']:
            if record['address'].lower() in local.values():
                code = self.rpc.request('eth_getCode', [record['address'], 'latest'])
                record['codehash'] = '0x' + keccak(bytes.fromhex(code[2:])).hex()
        directory = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, directory)
        chain = write_registry(directory, docs).chain('robinhood-4663')
        url = self.rpc.url

        def anvil(_, body):
            request = urllib.request.Request(url, json.dumps(body).encode(), {'Content-Type': 'application/json'})
            with urllib.request.urlopen(request, timeout=10) as response:
                return json.load(response)
        endpoint = Endpoint('local', 'anvil.invalid', 'https://anvil.invalid/', None, 100, None, None)
        endpoints = ChainEndpoints(chain, (endpoint,), 'test', send=anvil)
        return chain, endpoints.read_rpc(batch_reads=True)

    def swaps(self, rounds):
        for _ in range(rounds):
            for direction in (True, False):
                self.send(self.trader, calldata('swap(' + KEY_TYPE + ',bool,uint256)', [KEY_TYPE, 'bool', 'uint256'],
                                                [self.key, direction, 10**16]))

    def balances(self):
        return [self.call(token, 'balanceOf(address)', ['uint256'], ['address'], [self.owner])[0]
                for token in self.tokens]

    def collect(self):
        actions = bytes([DECREASE_LIQUIDITY, TAKE_PAIR])
        params = [encode(['uint256', 'uint256', 'uint128', 'uint128', 'bytes'], [self.token_id, 0, 0, 0, b'']),
                  encode(['address', 'address', 'address'], [*self.tokens, self.owner])]
        unlock = encode(['bytes', 'bytes[]'], [actions, params])
        self.send(self.positions, calldata('modifyLiquidities(bytes,uint256)', ['bytes', 'uint256'], [unlock, 2**63]))

    def read(self):
        reader = self.reader
        return reader.position(PositionRef(DEX_V4, self.positions, self.token_id), reader.head())

    def test_fees_owed_are_what_the_position_manager_pays_on_collect(self):
        self.swaps(3)
        state = self.read()
        self.assertEqual((state.owner, state.approved, state.subscriber), (self.owner.lower(), ZERO, ZERO))
        self.assertEqual(state.pool.pool, PoolRef(DEX_V4, *self.key))
        self.assertEqual((state.tick_lower, state.tick_upper, state.liquidity), (-600, 600, LIQUIDITY))
        self.assertTrue(all(fee > 0 for fee in state.fees_owed))
        before = self.balances()
        self.collect()
        paid = [after - prior for after, prior in zip(self.balances(), before)]
        self.assertEqual(tuple(paid), state.fees_owed)
        self.assertEqual(self.read().fees_owed, (0, 0))

    def test_the_pool_state_is_the_state_views(self):
        self.swaps(1)
        block = self.reader.head()
        state = self.reader.pool(PoolRef(DEX_V4, *self.key), block)
        pool_id = bytes.fromhex(state.pool_id[2:])
        sqrt_price, tick, protocol, lp_fee = self.call(self.state, 'getSlot0(bytes32)',
                                                       ['uint160', 'int24', 'uint24', 'uint24'], ['bytes32'], [pool_id])
        liquidity = self.call(self.state, 'getLiquidity(bytes32)', ['uint128'], ['bytes32'], [pool_id])[0]
        self.assertEqual((state.sqrt_price_x96, state.tick, state.protocol_fee, state.fee_pips, state.liquidity),
                         (sqrt_price, tick, protocol, lp_fee, liquidity))
        self.assertEqual(state.swap_fee_pips(True), 3000)
        self.assertEqual(state.liquidity, LIQUIDITY)

    def test_custody_is_the_approval_and_subscription_the_owner_gave(self):
        self.send(self.positions, calldata('approve(address,uint256)', ['address', 'uint256'],
                                           [self.controller, self.token_id]))
        self.send(self.controller, calldata('subscribe()'))
        state = self.read()
        self.assertEqual((state.approved, state.subscriber), (self.controller, self.controller))


if __name__ == '__main__':
    unittest.main()
