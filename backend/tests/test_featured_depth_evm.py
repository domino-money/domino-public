"""The reference-depth walk against a real v4 pool: it counts what a swap takes out.

A position spans ticks -600..600 around the price. Selling one side moves the
price until the position's edge, where the pool runs dry; the other side a
swap takes out up to there is exactly the depth the walk reads through the
StateView, because both step through the same initialized ticks with the
same rounding. The 10% band lies beyond either edge, so the edge decides.
"""
import os
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eth_abi import decode

from discovery import Block, STATE_VIEW
from evm_harness import EvmHarness as Harness, KEY_TYPE, calldata
import execution_models as m
from featured_evidence import active_liquidity, depth
from featured_pools import load_policy
from v4_math import amount_delta, sqrt_at_tick

POLICY = load_policy()
LIQUIDITY = 10**18


class AnvilReads:
    """The read surface featured_evidence uses, over the harness's local node."""
    def __init__(self, rpc):
        self.rpc = rpc

    def request(self, method, params):
        return self.rpc.request(method, params)

    def call(self, target, signature, inputs=(), values=(), outputs=(), *, block):
        raw = self.rpc.request('eth_call', [{'to': target, 'data': calldata(signature, inputs, values)}, block])
        return decode(outputs, bytes.fromhex(raw[2:]))


@unittest.skipUnless(os.environ.get('DOMINO_TEST_EVM') == '1', 'requires isolated local Anvil')
class ReferenceDepthEvmTests(unittest.TestCase):
    setUpClass = classmethod(Harness.setUpClass.__func__)
    stop = classmethod(Harness.stop.__func__)
    send = Harness.send
    deploy = Harness.deploy
    call = Harness.call

    def pool(self):
        manager = self.deploy('PoolManager.sol', 'PoolManager', ['address'], [self.owner])
        positions = self.deploy('PositionManager.sol', 'PositionManager',
            ['address', 'address', 'uint256', 'address', 'address'],
            [manager, '0x'+'11'*20, 100000, '0x'+'22'*20, '0x'+'33'*20])
        state = self.deploy('StateView.sol', 'StateView', ['address'], [manager])
        # The selector reads the production StateView address; put this one there.
        self.rpc.request('anvil_setCode', [STATE_VIEW, self.rpc.request('eth_getCode', [state, 'latest'])])
        controller = self.deploy('OfficialV4Fixture.sol', 'OfficialV4Controller',
                                 ['address', 'address'], [manager, positions])
        trader = self.deploy('OfficialV4Fixture.sol', 'OfficialV4SwapDriver', ['address'], [manager])
        tokens = sorted(self.deploy('OfficialV4Fixture.sol', 'OfficialFixtureToken') for _ in range(2))
        key = (*tokens, 3000, 60, m.ZERO)
        for token in tokens:
            for holder in (controller, trader):
                self.send(token, calldata('mint(address,uint256)', ['address', 'uint256'], [holder, 10**24]))
        self.send(manager, calldata('initialize('+KEY_TYPE+',uint160)', [KEY_TYPE, 'uint160'], [key, 2**96]))
        self.send(controller, calldata('seed('+KEY_TYPE+',uint128)', [KEY_TYPE, 'uint128'], [key, LIQUIDITY]))
        pool_id = m.PoolKey(currency0=tokens[0], currency1=tokens[1], fee_pips=3000, tick_spacing=60,
                            hooks=m.ZERO).pool_id()
        return key, pool_id, trader, tokens

    def observed(self, pool_id):
        head = self.rpc.request('eth_getBlockByNumber', ['latest', False])
        block = Block(int(head['number'], 16), head['hash'], int(head['timestamp'], 16))
        reads = AnvilReads(self.rpc)
        price, tick = reads.call(STATE_VIEW, 'getSlot0(bytes32)', ['bytes32'], [bytes.fromhex(pool_id[2:])],
                                 ['uint160', 'int24', 'uint24', 'uint24'], block=block.tag)[:2]
        pool = {'poolId': pool_id, 'poolKey': {'tick_spacing': 60}, 'sqrtPriceX96': str(price), 'tick': tick}
        return reads, pool, block

    def swapped_out(self, key, trader, token, zero_for_one):
        before = self.call(token, 'balanceOf(address)', ['uint256'], ['address'], [trader])[0]
        self.send(trader, calldata('swap('+KEY_TYPE+',bool,uint256)', [KEY_TYPE, 'bool', 'uint256'],
                                   [key, zero_for_one, 10**21]))
        return self.call(token, 'balanceOf(address)', ['uint256'], ['address'], [trader])[0] - before

    def test_selling_currency0_takes_out_the_currency1_depth(self):
        key, pool_id, trader, tokens = self.pool()
        reads, pool, block = self.observed(pool_id)
        liquidity = active_liquidity(reads, pool_id, block)
        self.assertEqual(liquidity, LIQUIDITY)
        amount, spent = depth(reads, pool, block, POLICY, liquidity=liquidity, reference_is_currency1=True)
        self.assertEqual(amount, amount_delta(sqrt_at_tick(-600), 2**96, LIQUIDITY, 1, False))
        self.assertGreater(spent, 1)
        self.assertEqual(self.swapped_out(key, trader, tokens[1], True), amount)

    def test_selling_currency1_takes_out_the_currency0_depth(self):
        key, pool_id, trader, tokens = self.pool()
        reads, pool, block = self.observed(pool_id)
        amount, _ = depth(reads, pool, block, POLICY, liquidity=LIQUIDITY, reference_is_currency1=False)
        self.assertEqual(amount, amount_delta(2**96, sqrt_at_tick(600), LIQUIDITY, 0, False))
        self.assertEqual(self.swapped_out(key, trader, tokens[0], False), amount)


if __name__ == '__main__':
    unittest.main()
