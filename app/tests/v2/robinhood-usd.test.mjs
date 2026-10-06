/**
 * Added 2026-10-06 (the owner, on production's New position, step 3: "USD estimate unavailable" for ETH/CASHCAT, AI/PONS and
 * CASHCAT/AI on Robinhood Chain; "when it is two coins that are not USD, USDG, ETH and the like, the price isn't fetched"):
 * a Robinhood Chain pool without USDG is valued at the qualified prices Domino's service reads for its pair (read-v6
 * chain-pools, the owner's decision #22: src/v2in/journey/poolPrices.ts), by the rule a pool on Base or Arbitrum One is
 * (src/components/create/valuation.ts usdOf):
 *   - both currencies priced: each at its own price;
 *   - one priced: both amounts in that one at the pool's own price (sqrtPriceX96), then at its price, the rule a USDG pair
 *     is valued by (1 USDG = $1); only the priced side's decimals are needed, and a side holding nothing needs nothing;
 *   - none priced, or a decimals count the value needs unknown: no figure at all, never a zero;
 *   - a USDG pair: as before, whatever prices it may carry.
 * And the prices themselves, in pool order, from a chain-pools answer about the pair (model/chainReads.ts pricesOf).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src/';
const valuation = require(`${BUILD}components/create/valuation.js`);
const { usdgValue } = require(`${BUILD}lib/format/usd.js`);
const chainReads = require(`${BUILD}v2in/journey/model/chainReads.js`);

const ZERO = '0x0000000000000000000000000000000000000000';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const AI = '0x00000000000000000000000000000000000000a1';
const CASHCAT = '0x00000000000000000000000000000000000000c7';
const PONS = '0x00000000000000000000000000000000000000f0';
const Q96 = 1n << 96n;
const E18 = 10n ** 18n;
const token = (address, symbol, decimals) => ({ origin: 'read', chainId: 4663, address, symbol, decimals, readStatus: 'available', artwork: null });
/** A Robinhood Chain pool at a raw price of 4 (sqrtPriceX96 = 2·2⁹⁶): one raw unit of currency0 is worth 4 of currency1. */
const pool = (currencies, usdPrices) => ({ currencies, sqrtPriceX96: String(2n * Q96), ...(usdPrices === undefined ? {} : { usdPrices }) });

test('both currencies priced: each at its own qualified price, rounded down', () => {
  const both = pool([token(AI, 'AI', 18), token(PONS, 'PONS', 18)], ['3.000000000000000000', '1.500000000000000000']);
  // 1 AI at $3 and 2 PONS at $1.50: the pool's own price plays no part.
  assert.equal(valuation.usdOf(both, [E18, 2n * E18]), '6.000000000000000000');
  assert.equal(valuation.usdOfSide(both, 1, String(2n * E18)), '3.000000000000000000');
});

test('one priced, an ETH pair: the other side at this pool\'s own price in ETH, then at ETH\'s price', () => {
  // ETH/TOKEN, ETH at Chainlink's US$4,000.12345678, the token unpriced (no deep pool): 1 ETH = 4 TOKEN here.
  const eth = pool([token(ZERO, 'ETH', 18), token(CASHCAT, 'CASHCAT', 18)], ['4000.123456780000000000', null]);
  // 0.5 ETH + 2 CASHCAT = 0.5 + 0.5 = 1 ETH's worth.
  assert.equal(valuation.usdOf(eth, [E18 / 2n, 2n * E18]), '4000.123456780000000000');
  // The token's own panel: 4 CASHCAT = 1 ETH.
  assert.equal(valuation.usdOfSide(eth, 1, String(4n * E18)), '4000.123456780000000000');
  // A side holding nothing needs no price, as before.
  assert.equal(valuation.usdOfSide(eth, 0, String(E18)), '4000.123456780000000000');
});

test('one priced, a pair without ETH or the dollar: the unpriced side at the pool\'s price in the priced one', () => {
  // AI/CASHCAT, CASHCAT priced through its own deep pool (US$0.50), AI with none: 1 AI = 4 CASHCAT here.
  const pair = pool([token(AI, 'AI', 18), token(CASHCAT, 'CASHCAT', 18)], [null, '0.500000000000000000']);
  assert.equal(valuation.usdOf(pair, [E18, E18]), '2.500000000000000000', '1 AI = 4 CASHCAT, + 1 CASHCAT = 5 × $0.50');
  assert.equal(valuation.usdOfSide(pair, 0, String(E18)), '2.000000000000000000');
  // Other decimals: AI with 6, at a raw price of 4 (one raw AI is 4 raw CASHCAT): 1 AI (10⁶ raw) is 4·10⁶ raw CASHCAT.
  const six = pool([token(AI, 'AI', 6), token(CASHCAT, 'CASHCAT', 18)], [null, '0.500000000000000000']);
  assert.equal(valuation.usdOf(six, [1_000_000n, 0n]), '0.000000000002000000');
});

test('none priced, no prices read, or a decimals count the value needs unknown: no figure at all, never a zero', () => {
  const none = pool([token(AI, 'AI', 18), token(PONS, 'PONS', 18)], [null, null]);
  assert.equal(valuation.usdOf(none, [E18, E18]), null);
  assert.equal(valuation.usdOf(pool([token(AI, 'AI', 18), token(PONS, 'PONS', 18)]), [E18, E18]), null, 'a pool that carries no prices');
  // One priced, ITS decimals unknown: the amounts cannot be said in whole tokens of it, so not at its price either.
  assert.equal(valuation.usdOf(pool([token(AI, 'AI', 18), token(CASHCAT, 'CASHCAT', null)], [null, '0.5']), [E18, E18]), null);
  assert.equal(valuation.usdOfSide(pool([token(AI, 'AI', 18), token(CASHCAT, 'CASHCAT', null)], [null, '0.5']), 0, String(E18)), null);
  // Both priced, a side with an amount and no decimals.
  assert.equal(valuation.usdOf(pool([token(AI, 'AI', null), token(PONS, 'PONS', 18)], ['1', '1']), [1n, E18]), null);
  // A price that is not one: no price.
  assert.equal(valuation.usdOf(pool([token(AI, 'AI', 18), token(PONS, 'PONS', 18)], ['0', 'not a price']), [E18, E18]), null);
});

// Changed on purpose 2026-10-06 (the review: a Base ETH/XYZ row whose XYZ decimals could not be read lost the figure its ETH
// panel had shown): only the decimals of the side valued INTO are needed (lib/format/price.ts valueIn converts the other
// side in raw units at the pool's price), and a side holding nothing needs neither a price nor its decimals.
test('the unpriced side\'s own decimals are never needed: in raw units at the pool\'s price; holding nothing, not at all', () => {
  // ETH priced, AI's decimals unread: ETH's own panel is valued as before.
  const eth = pool([token(ZERO, 'ETH', 18), token(AI, 'AI', null)], ['4000', null]);
  assert.equal(valuation.usdOf(eth, [E18, 0n]), '4000.000000000000000000');
  assert.equal(valuation.usdOfSide(eth, 0, String(E18)), '4000.000000000000000000');
  // CASHCAT priced, AI's decimals unread: 10¹⁸ raw AI is 4·10¹⁸ raw CASHCAT here, + 10¹⁸ raw CASHCAT = 5 CASHCAT × $0.50.
  const pair = pool([token(AI, 'AI', null), token(CASHCAT, 'CASHCAT', 18)], [null, '0.5']);
  assert.equal(valuation.usdOf(pair, [E18, E18]), '2.500000000000000000');
  assert.equal(valuation.usdOfSide(pair, 1, String(E18)), '0.500000000000000000', 'and the priced side alone, directly');
});

// Added 2026-10-06 (the amount paid with one other token, src/components/create/PairedAmounts.tsx): its USD value at the
// qualified price Domino's service read for it, by the same arithmetic.
test('an amount of one token at its qualified price: rounded down; no price, no decimals or a price of zero: none', () => {
  assert.equal(valuation.usdAt(String(E18 / 2n), 18, '4000.123456780000000000'), '2000.061728390000000000');
  assert.equal(valuation.usdAt('250500000', 6, '1'), '250.500000000000000000');
  assert.equal(valuation.usdAt(String(E18), null, '4000'), null);
  assert.equal(valuation.usdAt(String(E18), 18, null), null);
  assert.equal(valuation.usdAt(String(E18), 18, '0'), null);
});

test('a USDG pair is valued as before, at its own price with 1 USDG = $1, whatever prices it carries', () => {
  const usdg = { currencies: [token(ZERO, 'ETH', 18), token(USDG, 'USDG', 6)], sqrtPriceX96: '3926780305788164395585478' };
  const amounts = [E18 / 10n, 250_000_000n];
  const expected = usdgValue({ amounts, decimals: [18, 6], usdgIndex: 1, sqrtPriceX96: BigInt(usdg.sqrtPriceX96) });
  assert.equal(valuation.usdOf(usdg, amounts), expected);
  assert.equal(valuation.usdOf({ ...usdg, usdPrices: ['1', null] }, amounts), expected, 'never the pool\'s prices in place of USDG\'s own');
});

test('the prices a chain-pools answer about the pair gives, in pool order; a currency it does not price, none', () => {
  const answer = JSON.parse(readFileSync(new URL('../../../api-contracts/read-v6/fixtures/valid/chain-pools-paired.json', import.meta.url), 'utf8'));
  const weth = '0x4200000000000000000000000000000000000006';
  const live = '0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e';
  assert.deepEqual(chainReads.pricesOf(answer, { currency0: weth, currency1: live }), ['4000.123456780000000000', '1000.030864195000000000']);
  assert.deepEqual(chainReads.pricesOf(answer, { currency0: live.toUpperCase().replace('0X', '0x'), currency1: weth }), ['1000.030864195000000000', '4000.123456780000000000'], 'by address, any case');
  const unpriced = structuredClone(answer);
  Object.assign(unpriced.tokens.find((t) => t.address === live), { price: null, priceReason: 'pool_depth_below_floor' });
  assert.deepEqual(chainReads.pricesOf(unpriced, { currency0: weth, currency1: live }), ['4000.123456780000000000', null]);
  assert.deepEqual(chainReads.pricesOf(answer, { currency0: weth, currency1: AI }), ['4000.123456780000000000', null], 'a currency the answer does not name');
});
