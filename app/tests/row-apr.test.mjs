/**
 * The pool row's fee APR estimate (src/lib/read/screens/rowApr.ts).
 *
 * The figure the list works out has to be the figure the service would have
 * published for the same pool — same method, same arithmetic, same refusals —
 * or two screens disagree about one pool. These check it against the
 * producer's formula computed independently, and check that every input the
 * producer refuses on is refused here too, by name.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { rowApr, rowAprReasonText } = require('../.test-build/app/src/lib/read/screens/rowApr.js');

const attributed = (raw, stale = false) => ({
  state: stale ? 'attributed_stale' : 'attributed',
  value: `$${raw}`,
  raw,
  zero: Number(raw) === 0,
  provider: 'dexscreener',
  retrievedAt: 0,
  cacheAgeSeconds: null,
  ...(stale ? { refreshReason: null } : {}),
});

const pool = (extra = {}) => ({
  integration: 'hookless_fixed_fee',
  currentLpFeePips: 3000,
  protocolFeeRaw: 0,
  liquidity: attributed('500000'),
  volume: attributed('1000000'),
  ...extra,
});

/** The producer's method, written out independently: fixed LP fee × 24h volume over reported TVL, annualised 365. */
const expected = (volume, tvl, lpPips, protocolPips = 0) => ((volume * (lpPips * (1_000_000 - protocolPips)) / 1e12) / tvl) * 365 * 100;

test('the estimate is the producer’s method on the producer’s inputs', () => {
  const result = rowApr(pool());
  assert.equal(result.kind, 'estimate');
  assert.equal(result.stale, false);
  assert.equal(result.text, expected(1_000_000, 500_000, 3000).toFixed(2).replace(/\.?0+$/, ''));
  assert.equal(result.text, '219');
  // A tenth of the volume is a tenth of the estimate.
  assert.equal(rowApr(pool({ volume: attributed('100000') })).text, '21.9');
  // Twice the liquidity is half the estimate.
  assert.equal(rowApr(pool({ liquidity: attributed('1000000') })).text, '109.5');
  // The fee tier scales it directly.
  assert.equal(rowApr(pool({ currentLpFeePips: 500 })).text, '36.5');
});

test('the protocol fee leaves the input first, exactly as the producer takes it', () => {
  // A protocol fee is only described when it is the same both ways: the low
  // twelve bits are zero-for-one, the high twelve one-for-zero.
  const both = (pips) => pips + (pips << 12);
  const tenth = rowApr(pool({ protocolFeeRaw: both(1000) }));
  assert.equal(tenth.kind, 'estimate');
  assert.equal(tenth.text, expected(1_000_000, 500_000, 3000, 1000).toFixed(2).replace(/\.?0+$/, ''));
  assert.equal(tenth.text, '218.78');
  // It takes from the input before the LP fee, so it lowers the estimate.
  assert.ok(Number(tenth.text) < Number(rowApr(pool()).text));
  // A fee charged one way only is not the same fee: the producer refuses it rather than apportioning.
  assert.deepEqual(rowApr(pool({ protocolFeeRaw: 1000 })), { kind: 'none', reason: 'protocol_fee_directional_unsupported' });
});

test('a pool the producer cannot describe is refused, by its own reason', () => {
  const none = (extra) => rowApr(pool(extra));
  assert.deepEqual(none({ integration: 'requires_separate_adapter' }), { kind: 'none', reason: 'pool_integration_unsupported' });
  assert.deepEqual(none({ protocolFeeRaw: 1001 }), { kind: 'none', reason: 'invalid_protocol_fee' }, 'above the 1000-pip ceiling');
  assert.deepEqual(none({ protocolFeeRaw: 500 + (250 << 12) }), { kind: 'none', reason: 'protocol_fee_directional_unsupported' });
  assert.deepEqual(none({ liquidity: { state: 'not_reported', provider: 'dexscreener' } }), { kind: 'none', reason: 'missing_reported_tvl' });
  assert.deepEqual(none({ volume: { state: 'unavailable', provider: 'dexscreener', reason: 'no_provider_figures' } }), { kind: 'none', reason: 'missing_volume24h' });
  assert.deepEqual(none({ liquidity: attributed('0') }), { kind: 'none', reason: 'zero_reported_tvl' });
  // Too small to show at two places is said, never rounded down to a zero that looks like a figure.
  // The reason is OURS, not the producer's: it renders eighteen places, so its own
  // floor is 10^16 times smaller and means something else entirely.
  assert.deepEqual(none({ volume: attributed('0.0001') }), { kind: 'none', reason: 'estimate_rounds_to_zero' });
  // A pool that genuinely traded nothing has a zero APR, and zero is a figure:
  // the producer prints it (pool_apr.py `_render` refuses only when value > 0).
  assert.deepEqual(rowApr(pool({ volume: attributed('0') })), { kind: 'estimate', text: '0', stale: false });
});

test('a retained observation still answers, and says it is retained', () => {
  const result = rowApr(pool({ volume: attributed('1000000', true) }));
  assert.equal(result.kind, 'estimate');
  assert.equal(result.text, '219');
  assert.equal(result.stale, true, 'one stale operand makes the estimate stale');
  assert.equal(rowApr(pool({ liquidity: attributed('500000', true) })).stale, true);
});

test('every refusal has words of our own, and they name the missing input', () => {
  for (const reason of ['pool_integration_unsupported', 'invalid_protocol_fee', 'protocol_fee_directional_unsupported', 'missing_reported_tvl', 'zero_reported_tvl', 'missing_volume24h', 'estimate_rounds_to_zero', 'estimate_out_of_bounds']) {
    const text = rowAprReasonText(reason);
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 20 && text.endsWith('.'), `${reason}: ${text}`);
    assert.doesNotMatch(text, /GeckoTerminal|DexScreener/, 'a provider is never named on screen');
  }
});

// Added 2026-09-20. The rounding was half-to-even; the producer's `_render` is
// `units += int(remainder * 2 >= value.denominator)` — half away from zero. They
// disagree on every exact half, which is the one case a rounding rule exists for.
test('an exact half rounds away from zero, as the producer rounds it', () => {
  // 0.125% of a year: volume x lpShare / tvl chosen so the estimate lands on 16.125,
  // whose third place is an exact half at two places. Half-up gives 16.13; banker's
  // rounding would give 16.12 because 2 is even.
  const half = rowApr(pool({ currentLpFeePips: 3000, volume: attributed('73.6301369863013698630136986301369863'), liquidity: attributed('1000') }));
  assert.equal(half.kind, 'estimate');
  assert.ok(/^\d+(\.\d{1,2})?$/.test(half.text), half.text);
  // Directly: 1.005 -> 1.01 under half-up, 1.00 under banker's.
  const exact = (v) => rowApr(pool({ currentLpFeePips: 1_000_000, protocolFeeRaw: 0, volume: attributed(v), liquidity: attributed('36500') })).text;
  assert.equal(exact('1.005'), '1.01', 'an exact half goes up, never to the even neighbour');
  assert.equal(exact('1.015'), '1.02', 'and again where banker’s rounding would agree');
});

test('an estimate too large to be a figure is refused, not printed', () => {
  const huge = rowApr(pool({ volume: attributed('1'.padEnd(90, '0')), liquidity: attributed('0.000000000001') }));
  assert.deepEqual(huge, { kind: 'none', reason: 'estimate_out_of_bounds' });
});
