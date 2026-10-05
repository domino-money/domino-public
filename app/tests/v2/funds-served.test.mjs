/**
 * The bring-funds offer on the balances Domino's service reads (2026-10-06, rugged97's delta of 5 Oct, item 3: read-v6's
 * chain-balances), what is pure of it (src/v2in/funds/model.ts): what is asked (the other networks' ETH, WETH and stable,
 * never the destination's), and an answer read as the wallet's own read gives it (the network's own symbols and decimals,
 * only what is above zero, an unread balance never a zero, a network not read none at all); and New position's USD for a
 * pool on another network at its qualified prices (src/components/create/valuation.ts usdOf, read-v6 1.1.0-rc.1).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src/';
const model = require(`${BUILD}v2in/funds/model.js`);
const { CANDIDATE_ORIGINS } = require(`${BUILD}finance/v2/holdings.js`);
const valuation = require(`${BUILD}components/create/valuation.js`);

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../../api-contracts/read-v6/fixtures/valid/${name}.json`, import.meta.url), 'utf8'));
const ZERO = '0x0000000000000000000000000000000000000000';
const candidate = (chainId) => CANDIDATE_ORIGINS.find((c) => c.chainId === chainId);

test('what is asked: every source network\'s ETH, WETH and stable, never the destination\'s', () => {
  const asked = model.balancesRequest(4663, [4663, 8453, 42161]);
  assert.deepEqual(asked.map((t) => t.chainId), [8453, 8453, 8453, 42161, 42161, 42161]);
  assert.deepEqual(asked.slice(0, 3).map((t) => t.address), [ZERO, '0x4200000000000000000000000000000000000006', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913']);
  assert.deepEqual(model.balancesRequest(8453, [4663, 8453, 42161]).map((t) => t.chainId), [4663, 4663, 4663, 42161, 42161, 42161]);
});

test('an answer as the wallet\'s own read: the network\'s own symbols, what is above zero, unread never zero, a network not read none', () => {
  const answer = fixture('chain-balances');
  // Base read: USDC 2.5 and ETH 0.1; its WETH unavailable.
  const base = model.holdingsFromChainBalances(answer, candidate(8453));
  assert.deepEqual(base.holdings.map((h) => [h.token, h.symbol, h.decimals, h.raw]), [[ZERO, 'ETH', 18, 100000000000000000n], ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'USDC', 6, 2500000n]]);
  assert.deepEqual(base.unread, ['WETH']);
  assert.equal(model.holdingsFromChainBalances(answer, candidate(42161)), null, 'Arbitrum One not read: the wallet\'s own read is the way');
  // The answer's own symbol is never shown: a token named otherwise there is still the network's own currency.
  const renamed = structuredClone(answer);
  renamed.chains[1].balances[0].symbol = 'FREE MONEY';
  assert.equal(model.holdingsFromChainBalances(renamed, candidate(8453)).holdings[1].symbol, 'USDC');
  assert.equal(model.totalUsdOn(answer, 8453), null, 'not every balance valued there: no total');
  assert.equal(model.totalUsdOn(fixture('chain-balances-asked'), 8453), '7400.228394');
  assert.equal(model.totalUsdOn(answer, 42161), null);
});

test('New position\'s USD for a pool on another network: its currencies at their qualified prices; a missing price is none, never zero', () => {
  const token = (address, symbol, decimals) => ({ origin: 'read', chainId: 8453, address, symbol, decimals, readStatus: 'available', artwork: null });
  const pool = {
    currencies: [token(ZERO, 'ETH', 18), token('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'USDC', 6)],
    sqrtPriceX96: '3926780305788164395585478',
    usdPrices: ['4000.123456780000000000', '1.000000000000000000'],
  };
  // 0.5 ETH and 1,000 USDC: 2,000.06172839 + 1,000.
  assert.equal(valuation.usdOf(pool, [500000000000000000n, 1000000000n]), '3000.061728390000000000');
  assert.equal(valuation.usdOfSide(pool, 1, '2500000'), '2.500000000000000000');
  assert.equal(valuation.usdOf({ ...pool, usdPrices: ['4000.123456780000000000', null] }, [1n, 1n]), null, 'a side without a price: no figure at all');
  assert.equal(valuation.usdOf({ ...pool, usdPrices: ['4000.123456780000000000', null] }, [10n ** 18n, 0n]), '4000.123456780000000000', 'a side holding nothing needs no price');
  const { usdPrices, ...plain } = pool;
  assert.equal(usdPrices.length, 2);
  assert.equal(valuation.usdOf(plain, [1n, 1n]), null, 'a pool read through the wallet carries no prices: no USD');
});
