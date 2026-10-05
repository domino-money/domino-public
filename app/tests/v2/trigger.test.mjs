/**
 * Domino V2's auto-exit trigger translation (spec F7 §4.2, §4.3, §7.5): a typed human price, in either orientation,
 * becomes exactly the sqrtPriceX96 the ExitMandate signs, in the right field, and the integer reads back as a price
 * that translates to the same integer. Exact BigInt arithmetic throughout; every vector of §4.3 both ways.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const trigger = require('../../.test-build/app/src/v2/trigger.js');
const chains = require('../../.test-build/app/src/v2/chains.js');

const Q96 = 1n << 96n;
const Q192 = 1n << 192n;
const { MIN_SQRT_PRICE, MAX_SQRT_PRICE } = trigger;
const ETH = '0x0000000000000000000000000000000000000000';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const X = '0xfe00000000000000000000000000000000000001';

/** JSON.parse, but integers too wide for a double stay exact. */
const exact = (text) => JSON.parse(text.replace(/(:\s*)(-?\d{16,})(\s*[,}\]])/g, '$1"#big:$2"$3'), (_key, value) =>
  (typeof value === 'string' && value.startsWith('#big:') ? BigInt(value.slice(5)) : value));
const GOLDENS = exact(readFileSync(new URL('../../../api-contracts/v2/eip712-goldens.json', import.meta.url), 'utf8'));

/** An independent check of floor(sqrt(raw) × 2^96): s² ≤ raw × 2^192 < (s + 1)², raw = num/den exactly. */
function isFloorSqrt(s, num, den) {
  return s * s * den <= num * Q192 && num * Q192 < (s + 1n) * (s + 1n) * den;
}
/** The raw token1-per-token0 price of a decimal string, as num/den. */
function rawOf(text, d0, d1, orientation) {
  const [integer, fraction = ''] = text.split('.');
  let num = BigInt(integer + fraction);
  let den = 10n ** BigInt(fraction.length);
  if (orientation === 'token0PerToken1') [num, den] = [den, num];
  return d1 >= d0 ? { num: num * 10n ** BigInt(d1 - d0), den } : { num, den: den * 10n ** BigInt(d0 - d1) };
}
const translate = (price, d0, d1, orientation = 'token1PerToken0') => trigger.sqrtPriceX96FromPrice(price, { decimals0: d0, decimals1: d1 }, orientation);
/** The smallest decimal with `places` decimals that is ≥ num/den (strictly > when `open`). */
function ceilDecimal(num, den, places, open = false) {
  const scale = 10n ** BigInt(places);
  let m = (num * scale) / den;
  if (m * den < num * scale || (open && m * den === num * scale)) m += 1n;
  const digits = m.toString().padStart(places + 1, '0');
  const text = `${digits.slice(0, digits.length - places)}.${digits.slice(digits.length - places)}`.replace(/0+$/, '').replace(/\.$/, '');
  return text;
}

// ---------------------------------------------------------------------------
// §4.3's vectors
// ---------------------------------------------------------------------------

const ETH_USDG = { decimals0: 18, decimals1: 6 }; // currency0 = ETH (address(0)), currency1 = USDG
const USDG_X = { decimals0: 6, decimals1: 18 }; // currency0 = USDG, currency1 = X

test('§4.3: ETH/USDG v4 on Robinhood, a stop-loss at 2,000 USDG per ETH is triggerBelow 3543191142285914205922034', () => {
  const result = trigger.translateTrigger({ price: '2000', orientation: 'token1PerToken0', move: 'falls', ...ETH_USDG });
  assert.deepEqual(result, { ok: true, field: 'triggerBelowSqrtPriceX96', sqrtPriceX96: 3543191142285914205922034n });
  // The same order said the other way round: ETH per USDG rises to 0.0005 (1 / 2000 exactly), the same field and integer.
  assert.deepEqual(trigger.translateTrigger({ price: '0.0005', orientation: 'token0PerToken1', move: 'rises', ...ETH_USDG }), result);
  // Back: the integer reads as 2000 (and 0.0005), and those translate to it again.
  assert.equal(trigger.priceFromSqrtPriceX96(3543191142285914205922034n, ETH_USDG, 'token1PerToken0'), '2000');
  assert.equal(trigger.roundTripPrice(3543191142285914205922034n, ETH_USDG, 'token1PerToken0'), '2000');
  assert.equal(trigger.roundTripPrice(3543191142285914205922034n, ETH_USDG, 'token0PerToken1'), '0.0005');
});

test('§4.3: a take-profit at 3,500 USDG per ETH is triggerAbove 4687201305027700927646043', () => {
  const result = trigger.translateTrigger({ price: '3500', orientation: 'token1PerToken0', move: 'rises', ...ETH_USDG });
  assert.deepEqual(result, { ok: true, field: 'triggerAboveSqrtPriceX96', sqrtPriceX96: 4687201305027700927646043n });
  assert.equal(trigger.roundTripPrice(4687201305027700927646043n, ETH_USDG, 'token1PerToken0'), '3500');
  assert.equal(trigger.priceFromSqrtPriceX96(4687201305027700927646043n, ETH_USDG, 'token1PerToken0', { significant: 12 }), '3500');
  // 1/3500 has no finite decimal: the inverted read back is the shortest decimal that signs the same integer.
  const inverted = trigger.roundTripPrice(4687201305027700927646043n, ETH_USDG, 'token0PerToken1');
  assert.ok(inverted.startsWith('0.000285714285714'), inverted);
  assert.deepEqual(translate(inverted, 18, 6, 'token0PerToken1'), { ok: true, sqrtPriceX96: 4687201305027700927646043n });
});

test('§4.3: the reference price 2,500 USDG per ETH is 3961408125713216879677197', () => {
  assert.deepEqual(translate('2500', 18, 6), { ok: true, sqrtPriceX96: 3961408125713216879677197n });
  assert.deepEqual(translate('0.0004', 18, 6, 'token0PerToken1'), { ok: true, sqrtPriceX96: 3961408125713216879677197n });
  assert.equal(trigger.roundTripPrice(3961408125713216879677197n, ETH_USDG, 'token1PerToken0'), '2500');
  assert.equal(trigger.roundTripPrice(3961408125713216879677197n, ETH_USDG, 'token0PerToken1'), '0.0004');
});

test('§4.3: USDG as currency0 and X as currency1, "exit if X falls below 0.50 USDG" is X per USDG rising above 2 → triggerAbove 112045541949572279837463876454916343', () => {
  const pool = { currency0: USDG, currency1: X };
  assert.deepEqual(trigger.sortCurrencies(X, USDG), [USDG, X]);
  // The person thinks in "X's price in USDG": X is currency1, so that is token0 per token1.
  const orientation = trigger.orientationOf(pool, X);
  assert.equal(orientation, 'token0PerToken1');
  const said = trigger.translateTrigger({ price: '0.50', orientation, move: 'falls', ...USDG_X });
  assert.deepEqual(said, { ok: true, field: 'triggerAboveSqrtPriceX96', sqrtPriceX96: 112045541949572279837463876454916343n });
  // The pool's own orientation: X per USDG rises to 2. The same field, the same integer.
  assert.equal(trigger.orientationOf(pool, USDG), 'token1PerToken0');
  assert.deepEqual(trigger.translateTrigger({ price: '2', orientation: 'token1PerToken0', move: 'rises', ...USDG_X }), said);
  // Back, both ways round.
  assert.equal(trigger.roundTripPrice(112045541949572279837463876454916343n, USDG_X, 'token0PerToken1'), '0.5');
  assert.equal(trigger.roundTripPrice(112045541949572279837463876454916343n, USDG_X, 'token1PerToken0'), '2');
  assert.equal(trigger.priceFromSqrtPriceX96(112045541949572279837463876454916343n, USDG_X, 'token0PerToken1'), '0.5');
});

test('§4.3 golden: 2^96 is the raw price 1, whatever the decimals say in human units', () => {
  assert.equal(Q96, 79228162514264337593543950336n);
  assert.deepEqual(translate('1', 0, 0), { ok: true, sqrtPriceX96: 79228162514264337593543950336n });
  assert.deepEqual(translate('1', 18, 18), { ok: true, sqrtPriceX96: Q96 });
  assert.deepEqual(translate('1', 6, 6, 'token0PerToken1'), { ok: true, sqrtPriceX96: Q96 });
  // Raw 1 with 18/6 decimals is 10^12 token1 per token0 in human units, and 10^-12 with 6/18.
  assert.deepEqual(translate('1000000000000', 18, 6), { ok: true, sqrtPriceX96: Q96 });
  assert.deepEqual(translate('0.000000000001', 6, 18), { ok: true, sqrtPriceX96: Q96 });
  assert.equal(trigger.priceFromSqrtPriceX96(Q96, ETH_USDG, 'token1PerToken0'), '1000000000000');
  assert.equal(trigger.roundTripPrice(Q96, { decimals0: 0, decimals1: 0 }, 'token1PerToken0'), '1');
  // The ExitMandate golden (§4.2) signs exactly this integer as its below trigger.
  assert.equal(BigInt(GOLDENS.fixtures.ExitMandate.triggerBelowSqrtPriceX96), Q96);
  assert.equal(trigger.checkMandateTriggers(BigInt(GOLDENS.fixtures.ExitMandate.triggerBelowSqrtPriceX96), BigInt(GOLDENS.fixtures.ExitMandate.triggerAboveSqrtPriceX96)), null);
});

test('every vector is the exact floor of the square root, checked without the module\'s own isqrt', () => {
  for (const [price, d0, d1, orientation] of [['2000', 18, 6], ['3500', 18, 6], ['2500', 18, 6], ['2', 6, 18], ['0.5', 6, 18, 'token0PerToken1'], ['0.0005', 18, 6, 'token0PerToken1']]) {
    const result = translate(price, d0, d1, orientation);
    const { num, den } = rawOf(price, d0, d1, orientation ?? 'token1PerToken0');
    assert.ok(result.ok && isFloorSqrt(result.sqrtPriceX96, num, den), price);
  }
});

// ---------------------------------------------------------------------------
// Fields, orientation and token order
// ---------------------------------------------------------------------------

test('falls/rises map to below/above in the pool\'s orientation, and flip in the inverted one', () => {
  assert.equal(trigger.triggerField('token1PerToken0', 'falls'), 'triggerBelowSqrtPriceX96');
  assert.equal(trigger.triggerField('token1PerToken0', 'rises'), 'triggerAboveSqrtPriceX96');
  assert.equal(trigger.triggerField('token0PerToken1', 'falls'), 'triggerAboveSqrtPriceX96');
  assert.equal(trigger.triggerField('token0PerToken1', 'rises'), 'triggerBelowSqrtPriceX96');
  assert.throws(() => trigger.triggerField('usd', 'falls'), /invalid_orientation/);
  assert.throws(() => trigger.triggerField('token1PerToken0', 'crosses'), /invalid_move/);
});

test('currency0 is the lower address: ETH first, and WETH before the stable on all three chains (spec §4.3)', () => {
  assert.deepEqual(trigger.sortCurrencies(USDG, ETH), [ETH, USDG]);
  for (const chain of chains.V2_CHAINS) {
    const stable = chain.chargeCurrencies.find((c) => c.rank === 1).address;
    assert.deepEqual(trigger.sortCurrencies(stable, chain.wrappedNative.address), [chain.wrappedNative.address, stable], chain.name);
  }
  assert.deepEqual(trigger.sortCurrencies('0x5FC5360D0400A0FD4F2AF552ADD042D716F1D168', '0x0BD7D308F8E1639FAB988DF18A8011F41EACAD73'),
    ['0x0bd7d308f8e1639fab988df18a8011f41eacad73', USDG]);
  assert.throws(() => trigger.sortCurrencies(USDG, USDG.toUpperCase().replace('0X', '0x')), /identical_currencies/);
  assert.throws(() => trigger.sortCurrencies(USDG, '0x123'), /invalid_address/);
  assert.throws(() => trigger.orientationOf({ currency0: ETH, currency1: USDG }, X), /token_not_in_pool/);
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

/** A deterministic generator (mulberry32), so a failure names its case. */
function generator(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const DECIMAL_PAIRS = [[18, 6], [6, 18], [18, 18], [6, 6], [8, 18], [18, 8], [0, 0], [18, 0], [0, 18], [2, 9], [24, 6]];
/** A random plain decimal: 1 to 8 integer digits (no leading zero) or 0.x, 0 to 12 decimals, never zero. */
function randomPrice(next) {
  const digit = () => String(Math.floor(next() * 10));
  const integerDigits = Math.floor(next() * 9);
  let integer = integerDigits === 0 ? '0' : String(1 + Math.floor(next() * 9));
  for (let i = 1; i < integerDigits; i += 1) integer += digit();
  const places = Math.floor(next() * 13);
  let fraction = '';
  for (let i = 0; i < places; i += 1) fraction += digit();
  fraction = fraction.replace(/0+$/, '');
  if (integer === '0' && !/[1-9]/.test(fraction)) fraction = `${fraction}7`;
  return fraction ? `${integer}.${fraction}` : integer;
}
const places = (text) => (text.includes('.') ? text.split('.')[1].length : 0);

test('round trip: for many prices, decimal pairs and both orientations, the price read back translates to the same integer', () => {
  const next = generator(4663);
  let checked = 0;
  for (let i = 0; i < 1200; i += 1) {
    const [d0, d1] = DECIMAL_PAIRS[i % DECIMAL_PAIRS.length];
    const orientation = i % 2 === 0 ? 'token1PerToken0' : 'token0PerToken1';
    const price = randomPrice(next);
    const forward = translate(price, d0, d1, orientation);
    if (!forward.ok) {
      assert.ok(['price_too_low', 'price_too_high'].includes(forward.code), `${price} ${d0}/${d1} ${orientation}: ${forward.code}`);
      continue;
    }
    const { num, den } = rawOf(price, d0, d1, orientation);
    assert.ok(isFloorSqrt(forward.sqrtPriceX96, num, den), `${price} ${d0}/${d1} ${orientation}`);
    const back = trigger.roundTripPrice(forward.sqrtPriceX96, { decimals0: d0, decimals1: d1 }, orientation);
    assert.ok(back !== null, `${price} ${d0}/${d1} ${orientation}`);
    assert.deepEqual(translate(back, d0, d1, orientation), forward, `${price} → ${back}`);
    // The typed price is in the integer's preimage, so the shortest one never needs more decimals than it.
    assert.ok(places(back) <= places(price), `${price} → ${back}`);
    // The rounded display, with enough digits for the exact price in the pool's orientation, rounds to it.
    assert.match(trigger.priceFromSqrtPriceX96(forward.sqrtPriceX96, { decimals0: d0, decimals1: d1 }, orientation, { significant: 8 }), /^(0|[1-9]\d*)(\.\d*[1-9])?$/);
    checked += 1;
  }
  assert.ok(checked > 1000, `checked ${checked}`);
});

test('round trip from the integer side: random sqrt prices across the whole TickMath range come back exactly', () => {
  const next = generator(42161);
  let found = 0;
  let nulls = 0;
  for (let i = 0; i < 400; i += 1) {
    const [d0, d1] = [[18, 6], [6, 18], [18, 18], [0, 0]][i % 4];
    const orientation = i % 3 === 0 ? 'token0PerToken1' : 'token1PerToken0';
    // log-uniform between the bounds
    const bits = 33 + Math.floor(next() * 127);
    let s = 1n << BigInt(bits - 1);
    for (let b = 0; b < bits - 1; b += 1) if (next() < 0.5) s |= 1n << BigInt(b);
    if (s < MIN_SQRT_PRICE || s >= MAX_SQRT_PRICE) continue;
    const back = trigger.roundTripPrice(s, { decimals0: d0, decimals1: d1 }, orientation);
    if (back === null) {
      // Only when no decimal with 36 places lies in the integer's preimage (checked here independently).
      assert.equal(hasPoint(preimage(s, d0, d1, orientation), 36), false, `${s} ${d0}/${d1} ${orientation}`);
      nulls += 1;
      continue;
    }
    assert.deepEqual(translate(back, d0, d1, orientation), { ok: true, sqrtPriceX96: s }, `${s} → ${back}`);
    if (places(back) > 0) assert.equal(hasPoint(preimage(s, d0, d1, orientation), places(back) - 1), false, `${s} → ${back} is not the shortest`);
    found += 1;
  }
  assert.ok(found > 200 && nulls > 0, `${found} found, ${nulls} null`);
});

/**
 * The prices whose translation is s, independently of the module: in the pool's orientation [s², (s+1)²)·A/B, inverted
 * (B/((s+1)²·A), B/(s²·A)], with A = 10^max(0, d0−d1) and B = 2^192·10^max(0, d1−d0).
 */
function preimage(s, d0, d1, orientation) {
  const A = 10n ** BigInt(Math.max(0, d0 - d1));
  const B = Q192 * 10n ** BigInt(Math.max(0, d1 - d0));
  return orientation === 'token1PerToken0'
    ? { lower: [s * s * A, B], upper: [(s + 1n) * (s + 1n) * A, B], lowerOpen: false, upperOpen: true }
    : { lower: [B, (s + 1n) * (s + 1n) * A], upper: [B, s * s * A], lowerOpen: true, upperOpen: false };
}
/** Whether a decimal with at most `places` decimals (places < 0: none) lies in the interval. */
function hasPoint(interval, places) {
  if (places < 0) places = 0;
  const scale = 10n ** BigInt(places);
  const [ln, ld] = interval.lower;
  const [un, ud] = interval.upper;
  let m = (ln * scale) / ld;
  if (m * ld < ln * scale || (interval.lowerOpen && m * ld === ln * scale)) m += 1n;
  const left = m * ud;
  const right = un * scale;
  return interval.upperOpen ? left < right : left <= right;
}

test('monotone: a higher price never gives a lower integer in the pool\'s orientation, nor a higher one inverted', () => {
  const next = generator(8453);
  for (const [d0, d1] of [[18, 6], [6, 18], [18, 18]]) {
    const prices = Array.from({ length: 300 }, () => randomPrice(next));
    const value = (text) => { const [i, f = ''] = text.split('.'); return BigInt(i + f.padEnd(13, '0')); };
    prices.sort((a, b) => (value(a) < value(b) ? -1 : value(a) > value(b) ? 1 : 0));
    let previous = { pool: 0n, inverted: null };
    for (const price of prices) {
      const pool = translate(price, d0, d1, 'token1PerToken0');
      const inverted = translate(price, d0, d1, 'token0PerToken1');
      if (pool.ok) {
        assert.ok(pool.sqrtPriceX96 >= previous.pool, `${price} ${d0}/${d1}`);
        previous.pool = pool.sqrtPriceX96;
      }
      if (inverted.ok) {
        assert.ok(previous.inverted === null || inverted.sqrtPriceX96 <= previous.inverted, `${price} ${d0}/${d1} inverted`);
        previous.inverted = inverted.sqrtPriceX96;
      }
    }
  }
  // Strict where the prices are far enough apart.
  assert.ok(translate('2000', 18, 6).sqrtPriceX96 < translate('2000.000001', 18, 6).sqrtPriceX96);
  assert.ok(translate('2000', 18, 6, 'token0PerToken1').sqrtPriceX96 > translate('2000.000001', 18, 6, 'token0PerToken1').sqrtPriceX96);
});

test('isqrt is the exact floor square root', () => {
  const next = generator(1);
  for (const n of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, (1n << 320n) - 1n, 1n << 320n, Q192, Q192 - 1n]) {
    const r = trigger.isqrt(n);
    assert.ok(r * r <= n && n < (r + 1n) * (r + 1n), String(n));
  }
  for (let i = 0; i < 300; i += 1) {
    let n = 0n;
    const bits = 1 + Math.floor(next() * 500);
    for (let b = 0; b < bits; b += 1) if (next() < 0.5) n |= 1n << BigInt(b);
    const r = trigger.isqrt(n);
    assert.ok(r * r <= n && n < (r + 1n) * (r + 1n), String(n));
  }
  assert.throws(() => trigger.isqrt(-1n), /isqrt_negative/);
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test('malformed input is refused with a closed code, never coerced', () => {
  const cases = {
    price_empty: [''],
    price_negative: ['-1', '-0.5', '-'],
    price_exponent: ['1e3', '1E3', '2.5e-3'],
    price_malformed: [' 1', '1 ', '1,000', '+1', '01', '00.5', '1.', '.5', '1..2', '1.2.3', 'abc', '0x10', 'NaN', 'Infinity', '１', '1_000', '2000\n'],
    price_too_many_digits: ['9'.repeat(79), `1${'0'.repeat(78)}.5`],
    price_too_many_decimals: [`0.${'1'.repeat(37)}`, `1.${'0'.repeat(36)}1`],
    price_zero: ['0', '0.0', '0.000000'],
  };
  for (const [code, inputs] of Object.entries(cases)) {
    for (const input of inputs) {
      assert.deepEqual(trigger.parsePrice(input), { ok: false, code }, JSON.stringify(input));
      assert.deepEqual(translate(input, 18, 6), { ok: false, code }, JSON.stringify(input));
    }
  }
  for (const value of [2000, 2000n, null, undefined, {}, ['2000']]) assert.deepEqual(trigger.parsePrice(value), { ok: false, code: 'price_malformed' });
  // The limits themselves are accepted.
  assert.equal(trigger.parsePrice('9'.repeat(78)).ok, true);
  assert.equal(trigger.parsePrice(`0.${'0'.repeat(35)}1`).ok, true);
  assert.deepEqual(trigger.parsePrice('2000.50'), { ok: true, ratio: { num: 200050n, den: 100n } });
});

test('decimals are never guessed', () => {
  for (const decimals of [{ decimals0: null, decimals1: 6 }, { decimals0: 18, decimals1: undefined }, { decimals1: 6 }]) {
    assert.deepEqual(trigger.sqrtPriceX96FromPrice('2000', decimals, 'token1PerToken0'), { ok: false, code: 'decimals_unknown' });
  }
  for (const bad of [-1, 1.5, 256, Number.NaN, '18']) {
    assert.deepEqual(trigger.sqrtPriceX96FromPrice('2000', { decimals0: bad, decimals1: 6 }, 'token1PerToken0'), { ok: false, code: 'decimals_invalid' }, String(bad));
  }
  assert.throws(() => trigger.priceFromSqrtPriceX96(Q96, { decimals0: null, decimals1: 6 }, 'token1PerToken0'), /decimals_unknown/);
});

test('TickMath bounds: MIN_SQRT_PRICE and MAX_SQRT_PRICE − 1 pass, one unit beyond is refused, said in the typed orientation', () => {
  assert.equal(MIN_SQRT_PRICE, 4295128739n);
  assert.equal(MAX_SQRT_PRICE, 1461446703485210103287273052203988822378723970342n);
  const low = { decimals0: 18, decimals1: 0 };
  // The lowest usable integer reads back, and translates to itself.
  const atMin = trigger.roundTripPrice(MIN_SQRT_PRICE, low, 'token1PerToken0');
  assert.deepEqual(translate(atMin, 18, 0), { ok: true, sqrtPriceX96: MIN_SQRT_PRICE });
  // A price in MIN − 1's preimage: [ (MIN−1)², MIN² ) × 10^18 / 2^192, rounded up to 36 places.
  const belowMin = ceilDecimal((MIN_SQRT_PRICE - 1n) ** 2n * 10n ** 18n, Q192, 36);
  assert.deepEqual(translate(belowMin, 18, 0), { ok: false, code: 'price_too_low' }, belowMin);
  // The same integer said inverted: the typed price is the one that is too high.
  const belowMinInverted = ceilDecimal(Q192, (MIN_SQRT_PRICE) ** 2n * 10n ** 18n, 0, true);
  assert.deepEqual(translate(belowMinInverted, 18, 0, 'token0PerToken1'), { ok: false, code: 'price_too_high' }, belowMinInverted);
  // At the top: MAX − 1 is usable, MAX is not (the bound is exclusive).
  const top = { decimals0: 0, decimals1: 0 };
  const atMaxMinusOne = trigger.roundTripPrice(MAX_SQRT_PRICE - 1n, top, 'token1PerToken0');
  assert.deepEqual(translate(atMaxMinusOne, 0, 0), { ok: true, sqrtPriceX96: MAX_SQRT_PRICE - 1n });
  const atMax = ceilDecimal(MAX_SQRT_PRICE ** 2n, Q192, 36);
  assert.deepEqual(translate(atMax, 0, 0), { ok: false, code: 'price_too_high' }, atMax);
  assert.equal(trigger.roundTripPrice(MAX_SQRT_PRICE, top, 'token1PerToken0'), null);
  assert.equal(trigger.roundTripPrice(MIN_SQRT_PRICE - 1n, top, 'token1PerToken0'), null);
  // Far outside: in the orientation typed, a tiny price is too low and a huge one too high, whichever way round.
  assert.deepEqual(translate(`0.${'0'.repeat(29)}1`, 18, 0), { ok: false, code: 'price_too_low' });
  assert.deepEqual(translate(`0.${'0'.repeat(29)}1`, 0, 18, 'token0PerToken1'), { ok: false, code: 'price_too_low' });
  assert.deepEqual(translate(`1${'0'.repeat(60)}`, 0, 18), { ok: false, code: 'price_too_high' });
  assert.deepEqual(translate(`1${'0'.repeat(60)}`, 0, 18, 'token0PerToken1'), { ok: false, code: 'price_too_high' });
  assert.deepEqual(trigger.translateTrigger({ price: `1${'0'.repeat(60)}`, orientation: 'token1PerToken0', move: 'rises', decimals0: 0, decimals1: 18 }), { ok: false, code: 'price_too_high' });
});

test('the mandate\'s triggers (§4.2): at least one, both inside TickMath, and below under above', () => {
  const s2000 = 3543191142285914205922034n;
  const s3500 = 4687201305027700927646043n;
  assert.equal(trigger.checkMandateTriggers(s2000, s3500), null);
  assert.equal(trigger.checkMandateTriggers(s2000, 0n), null);
  assert.equal(trigger.checkMandateTriggers(0n, s3500), null);
  assert.equal(trigger.checkMandateTriggers(0n, 0n), 'trigger_missing');
  assert.equal(trigger.checkMandateTriggers(s3500, s2000), 'trigger_order');
  assert.equal(trigger.checkMandateTriggers(s2000, s2000), 'trigger_order');
  assert.equal(trigger.checkMandateTriggers(MIN_SQRT_PRICE, MAX_SQRT_PRICE - 1n), null);
  assert.equal(trigger.checkMandateTriggers(MIN_SQRT_PRICE - 1n, 0n), 'trigger_out_of_range');
  assert.equal(trigger.checkMandateTriggers(0n, MAX_SQRT_PRICE), 'trigger_out_of_range');
  assert.equal(trigger.checkMandateTriggers(1n << 160n, 0n), 'trigger_out_of_range');
  assert.equal(trigger.checkMandateTriggers(-1n, 0n), 'trigger_out_of_range');
  assert.equal(trigger.checkMandateTriggers(2000, 0n), 'trigger_out_of_range');
});

// ---------------------------------------------------------------------------
// The display
// ---------------------------------------------------------------------------

test('display rounding: half-even by default, down on request, with a carry into one more digit', () => {
  const f = (num, den, sig, rounding) => trigger.formatRatio({ num, den }, sig, rounding);
  assert.equal(f(25n, 10n, 1), '2');
  assert.equal(f(35n, 10n, 1), '4');
  assert.equal(f(251n, 100n, 1), '3');
  assert.equal(f(299n, 100n, 1, 'down'), '2');
  assert.equal(f(996n, 100n, 2), '10');
  assert.equal(f(999999n, 1n, 3), '1000000');
  assert.equal(f(123456n, 1000000000n, 3), '0.000123');
  assert.equal(f(123456789n, 1n, 3), '123000000');
  assert.equal(f(1n, 3n, 6), '0.333333');
  assert.equal(f(2n, 3n, 6), '0.666667');
  assert.equal(f(2n, 3n, 6, 'down'), '0.666666');
  assert.equal(f(1n, 8n, 2), '0.12');
  assert.equal(f(3n, 8n, 2), '0.38');
  assert.throws(() => f(0n, 1n, 6), /invalid_ratio/);
  assert.throws(() => f(1n, 1n, 0), /invalid_significant_digits/);
  assert.throws(() => f(1n, 1n, 6, 'up'), /invalid_rounding/);
});

test('the review\'s figures for 2,000 USDG per ETH: rounded, truncated, exact enough, and the integer the wallet shows', () => {
  const s = 3543191142285914205922034n;
  assert.equal(trigger.priceFromSqrtPriceX96(s, ETH_USDG, 'token1PerToken0'), '2000');
  // Truncated, the floor shows: the signed integer is a hair under 2000, never over it.
  assert.equal(trigger.priceFromSqrtPriceX96(s, ETH_USDG, 'token1PerToken0', { significant: 30, rounding: 'down' }), '1999.99999999999999999999963511');
  assert.equal(trigger.priceFromSqrtPriceX96(s, ETH_USDG, 'token0PerToken1', { significant: 6 }), '0.0005');
  assert.throws(() => trigger.priceFromSqrtPriceX96(0n, ETH_USDG, 'token1PerToken0'), /invalid_sqrt_price/);
  assert.throws(() => trigger.priceFromSqrtPriceX96(1n << 160n, ETH_USDG, 'token1PerToken0'), /invalid_sqrt_price/);
  // A chain value outside TickMath (someone else's mandate) is still shown as it is.
  // 2^-192 = 1.593…e-58.
  assert.equal(trigger.priceFromSqrtPriceX96(1n, { decimals0: 0, decimals1: 0 }, 'token1PerToken0', { significant: 2 }), `0.${'0'.repeat(57)}16`);
});
