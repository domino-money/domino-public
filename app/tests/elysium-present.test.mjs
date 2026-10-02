/**
 * The second chain's words (src/chains/elysium/present.ts, 2026-10-01, the chain2 workstream): exact amounts written
 * short, never a dollar; prices "1 BASE = X QUOTE" the registry's way round; ranges as two prices; where and when every
 * figure was read; and beginner sentences for what is not available yet.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const present = require('../.test-build/app/src/chains/elysium/present.js');
const { ELYSIUM } = require('../.test-build/app/src/config/chains.js');

const USDC = { address: ELYSIUM.stables[0], symbol: 'USDC', decimals: 6 };
const WHYPE = { address: ELYSIUM.wrapped, symbol: 'WHYPE', decimals: 18 };
const TKA = { address: '0x0337b5a6798e3bf57c262b56039afae357d57b5d', symbol: null, decimals: 18 };
const TKB = { address: '0x43695abf7df462d534bc738803cd9cd63154c190', symbol: 'TKB', decimals: 18 };

test('amounts: exact digits, six significant at most, grouped, a dust amount as a bound, nothing without decimals', () => {
  assert.equal(present.exactAmount(1_500_000n, 6), '1.5');
  assert.equal(present.exactAmount(10n ** 18n, 18), '1');
  assert.equal(present.amountText(1_234_567_891_234n, 6), '1,234,567');
  assert.equal(present.amountText(1_500_000n, 6), '1.5');
  assert.equal(present.amountText(123_456_789n, 9), '0.123456');
  assert.equal(present.amountText(3n, 18), '<0.000001');
  assert.equal(present.amountText(0n, 18), '0');
  assert.equal(present.amountText(5n, null), null);
});

test('fee tiers in percent', () => {
  assert.equal(present.feeTierText(3000), '0.3%');
  assert.equal(present.feeTierText(500), '0.05%');
  assert.equal(present.feeTierText(10000), '1%');
  assert.equal(present.feeTierText(100), '0.01%');
});

test('a price is "1 BASE = X QUOTE", the quote the registry\'s: USDC, then WHYPE, else the pool\'s own order', () => {
  // A WHYPE/USDC pool: the pool orders its tokens by address (USDC's is the lower), the page by the registry's ranks.
  const [t0, t1] = [WHYPE, USDC].sort((a, b) => (a.address < b.address ? -1 : 1));
  assert.equal(t0, USDC);
  const line = present.priceLine(ELYSIUM, { token0: t0, token1: t1, sqrtPriceX96: 1n << 96n });
  assert.equal(line.quote.symbol, 'USDC', 'value is counted in USDC');
  assert.equal(line.base.symbol, 'WHYPE');
  const own = present.priceLine(ELYSIUM, { token0: TKA, token1: TKB, sqrtPriceX96: 2n << 96n });
  assert.equal(own.base, TKA);
  assert.equal(own.quote, TKB);
  assert.equal(own.text, '4');
  assert.equal(present.priceLine(ELYSIUM, { token0: { ...TKA, decimals: null }, token1: TKB, sqrtPriceX96: 1n << 96n }).text, null);
});

test('a range is two prices, 0 and ∞ at the pool\'s limits, the right way round', () => {
  // 1.0001^±6932, six significant digits (the app's tickPriceText).
  const six = (value) => new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 }).format(value);
  const [LOW, HIGH] = [six(Math.pow(1.0001, -6932)), six(Math.pow(1.0001, 6932))];
  assert.deepEqual([LOW, HIGH], ['0.499991', '2.00004']);
  const range = present.rangeLine(ELYSIUM, { token0: TKA, token1: TKB, tickLower: -6932, tickUpper: 6932, tickSpacing: 1 });
  assert.equal(range.low, LOW);
  assert.equal(range.high, HIGH);
  const full = present.rangeLine(ELYSIUM, { token0: TKA, token1: TKB, tickLower: -887220, tickUpper: 887220, tickSpacing: 60 });
  assert.deepEqual([full.low, full.high], ['0', '∞']);
  // A pool whose first token is the quote (USDC token0 vs a token above it) is written the other way round.
  const usdcFirst = { address: '0x0000000000000000000000000000000000000001', symbol: 'USDC', decimals: 6 };
  const chain = { ...ELYSIUM, quoteRanks: { [usdcFirst.address]: 2 } };
  const flipped = present.rangeLine(chain, { token0: usdcFirst, token1: { ...TKB, decimals: 6 }, tickLower: -6932, tickUpper: 6932, tickSpacing: 1 });
  assert.equal(flipped.base.symbol, 'TKB');
  assert.equal(flipped.quote.symbol, 'USDC');
  // The pool's upper tick is the low price of TKB in USDC, and its lower tick the high one.
  assert.deepEqual([flipped.low, flipped.high], [LOW, HIGH]);
});

test('when and where: "Read from Elysium Testnet at block N, 3 min ago", or the service\'s', () => {
  const now = 1_790_100_000 * 1000;
  assert.equal(present.agoText(1_790_100_000, now), 'just now');
  assert.equal(present.agoText(1_790_099_960, now), '40 s ago');
  assert.equal(present.agoText(1_790_099_800, now), '3 min ago');
  assert.equal(present.agoText(1_790_092_800, now), '2 h ago');
  assert.equal(present.agoText(1_790_013_600, now), '1 day ago');
  assert.equal(present.provenanceText({ source: 'chain', block: 1_588_970, timestamp: 1_790_099_800 }, ELYSIUM, now), 'Read from Elysium Testnet at block 1,588,970, 3 min ago');
  assert.equal(present.provenanceText({ source: 'service', block: 1000, timestamp: 1_790_100_000 }, ELYSIUM, now), 'From the Elysium Testnet service at block 1,000, just now');
});

test('names: a token\'s own symbol, or its address shortened; steps and events in plain words', () => {
  assert.equal(present.tokenLabel(TKA), '0x0337…7b5d');
  assert.equal(present.tokenLabel(TKB), 'TKB');
  assert.equal(present.stepText('approve-token0', TKA, TKB), 'Allow your vault to use 0x0337…7b5d');
  assert.equal(present.stepText('open', TKA, TKB), 'Create the position');
  assert.equal(present.historyText('Compounded'), 'Fees added back');
  assert.equal(present.historyText('Something new'), 'Vault activity');
});

test('the sentences say what is not available and why, in plain words, without jargon', () => {
  const jargon = /\b(bps|tick|nonce|sqrt|calldata|draft|liquidity|RPC|API|ABI|wei|gwei)\b/i;
  for (const reason of ['section-off', 'service-off', 'deployment-unqualified', 'service-says-no', 'no-signer']) {
    const text = present.actionsReasonText(reason, ELYSIUM);
    assert.ok(text.length > 10 && !jargon.test(text), `${reason}: ${text}`);
  }
  for (const reason of ['service', 'draft_changed', 'state_changed', 'expired', 'wallet', 'reverted', 'replaced']) {
    const text = present.stopText(reason);
    assert.ok(text.length > 10 && !jargon.test(text), `${reason}: ${text}`);
  }
});

test('the most a step\'s network fee can be, in HYPE', () => {
  // 92,549 gas × 25,546,839 wei = 2,364,334,402,611 wei.
  assert.equal(present.maxNetworkFee(ELYSIUM, { gasLimitRaw: '92549', maxFeePerGasWeiRaw: '25546839' }), '0.00000236433 HYPE');
  assert.equal(present.maxNetworkFee(ELYSIUM, { gasLimitRaw: 'x', maxFeePerGasWeiRaw: '1' }), null);
});
