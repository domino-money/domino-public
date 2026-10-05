/**
 * Domino V2's chains (spec F7 §1.2, §1.4): the profiles of api-contracts/v2/chains are what src/v2/chains.ts serves,
 * Elysium stays out, Base carries its extra fee tiers, and nothing names an RPC or a Domino contract.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const chains = require('../../.test-build/app/src/v2/chains.js');
const profile = (name) => JSON.parse(readFileSync(new URL(`../../../api-contracts/v2/chains/${name}.json`, import.meta.url), 'utf8'));

test('Robinhood, Base and Arbitrum One, in that order, with their hex ids; Elysium is not one of them', () => {
  assert.deepEqual(chains.V2_CHAINS.map((c) => [c.chainId, c.hex, c.slug, c.name]), [
    [4663, '0x1237', 'robinhood', 'Robinhood Chain'],
    [8453, '0x2105', 'base', 'Base'],
    [42161, '0xa4b1', 'arbitrum', 'Arbitrum One'],
  ]);
  assert.equal(chains.ELYSIUM_HIDDEN, true);
  assert.equal(profile('elysium').enabled, false);
  assert.equal(chains.V2_CHAINS.some((c) => /elysium/i.test(c.name) || c.chainId === 99801), false);
  assert.throws(() => chains.v2Chain(99801), /chain_not_supported/);
  assert.throws(() => chains.v2Chain(1), /chain_not_supported/);
});

test('every address is the profile\'s, lowercase (spec §1.2 tables)', () => {
  const expected = {
    4663: { v3f: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa', npm: '0x73991a25c818bf1f1128deaab1492d45638de0d3', pm4: '0x8366a39cc670b4001a1121b8f6a443a643e40951', pos4: '0x58daec3116aae6d93017baaea7749052e8a04fa7', sv: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b', ur: '0x204faca1764b154221e35c0d20abb3c525710498', weth: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', stable: ['USDG', '0x5fc5360d0400a0fd4f2af552add042d716f1d168'] },
    8453: { v3f: '0x33128a8fc17869897dce68ed026d694621f6fdfd', npm: '0x03a520b32c04bf3beef7beb72e919cf822ed34f1', pm4: '0x498581ff718922c3f8e6a244956af099b2652b2b', pos4: '0x7c5f5a4bbd8fd63184577525326123b519429bdc', sv: '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71', ur: '0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40', weth: '0x4200000000000000000000000000000000000006', stable: ['USDC', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'] },
    42161: { v3f: '0x1f98431c8ad98523631ae4a59f267346ea31f984', npm: '0xc36442b4a4522e871399cd717abdd847ab11fe88', pm4: '0x360e68faccca8ca495c1b759fd9eee466db9fb32', pos4: '0xd88f38f930b7952f2db2432cb002e7abbf3dd869', sv: '0x76fd297e2d437cd7f76d50f01afe6160f86e9990', ur: '0x2d01411773c8c24805306e89a41f7855c3c4fe65', weth: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', stable: ['USDC', '0xaf88d065e77c8cc2239327c5edb3a432268e5831'] },
  };
  for (const chain of chains.V2_CHAINS) {
    const e = expected[chain.chainId];
    assert.equal(chain.uniswap.v3.factory, e.v3f);
    assert.equal(chain.uniswap.v3.positionManager, e.npm);
    assert.equal(chain.uniswap.v4.poolManager, e.pm4);
    assert.equal(chain.uniswap.v4.positionManager, e.pos4);
    assert.equal(chain.uniswap.v4.stateView, e.sv);
    assert.equal(chain.uniswap.universalRouter.address, e.ur);
    assert.equal(chain.uniswap.universalRouter.version, '2.1.2');
    assert.equal(chain.permit2, '0x000000000022d473030f116ddee9f6b43ac78ba3');
    assert.equal(chain.wrappedNative.address, e.weth);
    assert.equal(chain.uniswap.v3.poolInitCodeHash, '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54');
    // Charge currencies: the stable at rank 1, ETH (address 0) and WETH at rank 2.
    assert.deepEqual(chain.chargeCurrencies.map((c) => [c.rank, c.symbol, c.address, c.decimals, c.native]), [
      [1, e.stable[0], e.stable[1], 6, false],
      [2, 'ETH', '0x0000000000000000000000000000000000000000', 18, true],
      [2, 'WETH', e.weth, 18, false],
    ]);
    assert.equal(chains.profileRank(chain, e.stable[1].toUpperCase().replace('0X', '0x')), 1);
    assert.equal(chains.profileRank(chain, '0x0000000000000000000000000000000000000000'), 2);
    assert.equal(chains.profileRank(chain, e.weth), 2);
    assert.equal(chains.profileRank(chain, '0x00000000000000000000000000000000000000aa'), 0);
  }
});

test('Base has the extra v3 tiers 200/300/400 → 4/6/8; the others the four standard ones; an unknown tier is read from the factory', () => {
  const base = chains.v2Chain(8453), robinhood = chains.v2Chain(4663), arbitrum = chains.v2Chain(42161);
  assert.deepEqual(base.uniswap.v3.tickSpacingByFee, { 100: 1, 200: 4, 300: 6, 400: 8, 500: 10, 3000: 60, 10000: 200 });
  for (const chain of [robinhood, arbitrum]) assert.deepEqual(chain.uniswap.v3.tickSpacingByFee, { 100: 1, 500: 10, 3000: 60, 10000: 200 });
  assert.equal(chains.v3TickSpacing(base, 300), 6);
  assert.equal(chains.v3TickSpacing(robinhood, 300), null);
  assert.equal(chains.v3TickSpacing(base, 20000), null);
});

test('finality and ordering per stack: Base orders by priority fee and reports an L1 fee; Nitro orders by arrival', () => {
  const [robinhood, base, arbitrum] = chains.V2_CHAINS;
  assert.deepEqual([robinhood.ordering, base.ordering, arbitrum.ordering], ['arrival', 'priority-fee', 'arrival']);
  assert.deepEqual([robinhood.l1FeeInReceipt, base.l1FeeInReceipt, arbitrum.l1FeeInReceipt], [false, true, false]);
  assert.deepEqual([robinhood.finality.aboutMinutes, base.finality.aboutMinutes, arbitrum.finality.aboutMinutes], [13, 20, 13]);
  assert.equal(chains.addChainCopy(base), 'Add Base to your wallet, then try again.');
});

test('the chains module names no RPC and no Domino contract', () => {
  const source = readFileSync(new URL('../../src/v2/chains.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /https?:\/\//, 'no URL of any kind');
  assert.doesNotMatch(source, /rpc/i.test(source) ? /rpcUrl|http\(|fallback\(/ : /$^/);
  for (const chain of chains.V2_CHAINS) assert.equal('rpc' in chain, false);
});
