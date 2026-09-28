import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const geometry = require('../.test-build/app/src/lib/geometry.js');
const markets = require('../.test-build/app/src/lib/markets.js');
const relative = require('../.test-build/app/src/lib/scenario.js');
const { previewPosition } = require('../.test-build/web/lib/position.js');
const { previewCompound, moneyUnits, moneyString, MICRO, SERVICE_BPS } = require('../.test-build/web/lib/compound.js');

const { clampLower, clampUpper, domainFor, positionOf, priceAt, round2 } = geometry;

// ---------------------------------------------------------------------------
// Drag regression. Reported on #11: while dragging one edge of the range, the
// other edge crept, because the chart re-derived its domain from the bounds on
// every pointer event. A fixed pointer position must mean the same price for
// the whole gesture, so the flow freezes the domain on pointerdown.
// ---------------------------------------------------------------------------

test('a fixed pointer x holds a stable price for the whole gesture', () => {
  const lower = 0.7;
  let upper = 1.5;
  const held = domainFor(lower, upper); // captured once, on pointerdown

  const X = 612;
  const first = priceAt(X, 100, 800, held);

  // The gesture drags the upper edge far to the right. Each move rewrites the
  // bounds, which is what used to move the domain underneath the pointer.
  for (const next of [1.8, 2.4, 3.1, 4.0, 6.5]) {
    upper = clampUpper(next);
    assert.equal(
      priceAt(X, 100, 800, held),
      first,
      `x=${X} moved when the upper bound reached ${upper}`,
    );
  }
  assert.equal(lower, 0.7, 'the untouched edge must not move');
});

test('the frozen domain is what makes it stable, not the arithmetic', () => {
  // Guards the test above: without the freeze the same x really does drift, so
  // a passing suite proves the fix rather than a tautology.
  const X = 612;
  const live = (upper) => priceAt(X, 100, 800, domainFor(0.7, upper));
  assert.notEqual(live(6.5), live(1.5));
});

test('a gesture that never moves reports the price it started on', () => {
  const held = domainFor(0.7, 1.5);
  const start = priceAt(400, 100, 800, held);
  assert.equal(priceAt(400, 100, 800, held), start);
});

test('pointer positions outside the chart clamp to the domain', () => {
  const d = domainFor(0.7, 1.5);
  assert.equal(priceAt(-5000, 100, 800, d), d[0]);
  assert.equal(priceAt(5000, 100, 800, d), d[1]);
});

test('a zero-width chart cannot produce NaN', () => {
  const d = domainFor(0.7, 1.5);
  const p = priceAt(300, 100, 0, d);
  assert.ok(Number.isFinite(p), 'price must stay a number when the box is unmeasured');
  assert.equal(p, d[0]);
});

test('bounds clamp so the band always straddles the start price', () => {
  assert.equal(clampLower(5), 0.99);
  assert.equal(clampLower(-3), 0.01);
  assert.equal(clampUpper(0.2), 1.01);
  assert.equal(clampUpper(9999), 100);
  assert.ok(clampLower(0.5) < 1 && clampUpper(1.5) > 1);
});

test('clamped bounds are rounded to cents, never to a long float', () => {
  for (const v of [0.1234, 0.815, 0.005, 0.1 + 0.2]) {
    assert.equal(clampLower(v), round2(Math.min(0.99, Math.max(0.01, v))));
    assert.equal(clampUpper(v), round2(Math.max(1.01, Math.min(100, v))));
  }
});

test('the domain always contains the bounds and the start price', () => {
  for (const [lo, hi] of [[0.7, 1.5], [0.5, 2], [0.01, 100], [0.98, 1.02]]) {
    const [dlo, dhi] = domainFor(lo, hi);
    assert.ok(dlo > 0, 'a price domain cannot start at or below zero');
    assert.ok(dlo <= lo, `${dlo} must sit at or below the lower bound ${lo}`);
    assert.ok(dhi >= hi, `${dhi} must sit at or above the upper bound ${hi}`);
    assert.ok(dlo < 1 && dhi > 1, 'the start price must be visible');
  }
});

test('position on the chart is monotonic across the domain', () => {
  const d = domainFor(0.7, 1.5);
  let previous = -Infinity;
  for (let i = 0; i <= 20; i++) {
    const price = d[0] + ((d[1] - d[0]) * i) / 20;
    const at = positionOf(price, d);
    assert.ok(at > previous, 'a higher price must sit further right');
    previous = at;
  }
  assert.equal(Math.round(positionOf(d[0], d)), 0);
  assert.equal(Math.round(positionOf(d[1], d)), 100);
});

// ---------------------------------------------------------------------------
// Gas and available-fees boundaries. The engine is rugged97's; these pin the
// exact edges the interface has to render, so a change of policy shows up here
// as a failing expectation rather than as a silently different screen.
// ---------------------------------------------------------------------------

const scenario = (fees, gas, capital = '1000') =>
  previewCompound({ availableFeesUsd: fees, positionValueUsd: capital, gasUsd: gas });

test('exactly at the minimum fee the decision flips to eligible', () => {
  const gas = '0.50';
  const minimum = scenario('0', gas).minimumFeesUsd;

  const at = scenario(minimum, gas);
  assert.equal(at.decision, 'eligible');
  assert.equal(at.reason, 'ready');

  const below = scenario(moneyString(moneyUnits(minimum) - 1n), gas);
  assert.equal(below.decision, 'wait');
  assert.equal(below.reason, 'gas_too_high');
});

test('the published minimum is the true threshold at several gas prices', () => {
  for (const gas of ['0.01', '0.5', '1', '7.77', '100']) {
    const minimum = scenario('0', gas).minimumFeesUsd;
    assert.equal(scenario(minimum, gas).decision, 'eligible', `gas=${gas}`);
    assert.equal(scenario(moneyString(moneyUnits(minimum) - 1n), gas).decision, 'wait', `gas=${gas}`);
  }
});

test('no fees waits for a reason other than gas', () => {
  const none = scenario('0', '0.50');
  assert.equal(none.decision, 'wait');
  assert.equal(none.reason, 'no_fees');
  assert.equal(none.reserveReason, 'none', 'nothing is held back when nothing is owed');
});

test('free gas still needs a fee to act on', () => {
  assert.equal(scenario('0', '0').decision, 'wait');
  assert.equal(scenario('0.000001', '0').decision, 'eligible');
});

test('a waiting decision holds the whole balance and charges nothing', () => {
  const wait = scenario('1', '100');
  assert.equal(wait.decision, 'wait');
  assert.equal(wait.consumedFeesUsd, '0.000000');
  assert.equal(wait.serviceFeeUsd, '0.000000');
  assert.equal(wait.reinvestedUsd, '0.000000');
  assert.equal(wait.reserveUsd, '1.000000');
  assert.equal(wait.reserveReason, 'network_cost');
});

test('the service cut is two percent of consumed fees and never touches principal', () => {
  const act = scenario('500', '1', '250000');
  assert.equal(act.decision, 'eligible');
  assert.equal(
    moneyUnits(act.serviceFeeUsd),
    (moneyUnits(act.consumedFeesUsd) * SERVICE_BPS) / 10_000n,
  );
  assert.ok(moneyUnits(act.serviceFeeUsd) < moneyUnits(act.availableFeesUsd));
});

test('available always equals reinvested plus service plus reserve', () => {
  // The same invariant the workbench fuzzes, applied over the edges the screen
  // can actually reach.
  for (const fees of ['0', '0.000001', '0.05', '1', '57.25', '1000', '1000000']) {
    for (const gas of ['0', '0.000001', '0.01', '1', '1000']) {
      const d = scenario(fees, gas, '1000000');
      assert.equal(
        moneyUnits(d.reinvestedUsd) + moneyUnits(d.serviceFeeUsd) + moneyUnits(d.reserveUsd),
        moneyUnits(d.availableFeesUsd),
        `fees=${fees} gas=${gas}`,
      );
    }
  }
});

test('the operator margin covers the gas whenever the engine acts', () => {
  for (const [fees, gas] of [['100', '1'], ['57.25', '0.5'], ['1000', '10']]) {
    const d = scenario(fees, gas, '100000');
    assert.equal(d.decision, 'eligible', `fees=${fees} gas=${gas}`);
    assert.ok(
      moneyUnits(d.serviceFeeUsd) >= moneyUnits(d.gasUsd),
      'gas must come out of the service fee, never out of the owner a second time',
    );
    assert.equal(
      moneyUnits(d.operatorMarginUsd),
      moneyUnits(d.serviceFeeUsd) - moneyUnits(d.gasUsd),
    );
  }
});

test('scenarios outside the engine limits are rejected, not approximated', () => {
  assert.throws(() => scenario('1', '1000.000001'), /supported amount limits/);
  assert.throws(() => scenario('1000000.000001', '1'), /supported amount limits/);
  assert.throws(() => scenario('1', '1', '9.999999'), /supported amount limits/);
  assert.throws(() => scenario('1', '1', '1000000.000001'), /supported amount limits/);
});

test('the limits themselves are accepted', () => {
  assert.doesNotThrow(() => scenario('1000000', '1000', '1000000'));
  assert.doesNotThrow(() => scenario('0', '0', '10'));
});

// ---------------------------------------------------------------------------
// The explanatory sections speak in multiples of the start price and shares
// of the starting value: never a dollar figure, a named pair or an amount.
// ---------------------------------------------------------------------------

test('the scenario is relative: multiples, shares and signed changes, never a dollar figure', () => {
  assert.equal(relative.times(1.2), '1.20×');
  assert.equal(relative.times(0.4), '0.40×');
  assert.equal(relative.ofStart(0.98423), '98.4%');
  assert.equal(relative.change(-0.0162), '−1.62%');
  assert.equal(relative.change(0.0249), '+2.49%');
  assert.equal(relative.change(0), '0.00%');
  assert.equal(relative.change(-0.00001), '0.00%', 'a change too small to show is no change, never −0.00%');
  for (const range of Object.values(relative.RANGES)) {
    assert.match(range.hint, /^\d\.\d\d× to \d\.\d\d× the start price$/, range.key);
    assert.ok(range.lower < 1 && range.upper > 1, 'the range straddles the start');
  }
  assert.equal('PAIR' in relative, false, 'no named pair');
  assert.ok(relative.UNIT >= 10 && relative.UNIT <= 1_000_000, 'a size previewPosition accepts');
});

test('what the sections show does not depend on the size the maths runs on', () => {
  const at = (amount, scenarioPrice) => previewPosition({ amount, lower: 0.7, upper: 1.5, startingPrice: 1, scenarioPrice });
  for (const price of [0.5, 0.9, 1, 1.3, 2]) {
    const small = at(relative.UNIT, price);
    const large = at(relative.UNIT * 1000, price);
    assert.equal(relative.ofStart(small.value / relative.UNIT), relative.ofStart(large.value / (relative.UNIT * 1000)), `value at ${price}`);
    assert.equal(relative.change(small.difference / relative.UNIT), relative.change(large.difference / (relative.UNIT * 1000)), `change at ${price}`);
    assert.equal(Math.round(small.tokenShare * 100), Math.round(large.tokenShare * 100), `share at ${price}`);
  }
});

// Added 2026-09-27 (owner, round 6: Home's simulator redone for newcomers). Its one control runs on a log scale around
// the start; the price reads as a whole-percent move, never a multiple, and the range is the Closer range.
test('the Home simulator: a log scale around the start, moves in whole percent, and the Closer range', () => {
  const { SIM, simPrice, simAt, moved } = relative;
  assert.deepEqual([SIM.lower, SIM.upper], [relative.RANGES.standard.lower, relative.RANGES.standard.upper], 'the Closer range');
  assert.equal(simPrice(0), 1, 'the middle notch is the start price');
  assert.equal(simAt(1), 0.5, 'the start sits in the middle');
  assert.equal(simAt(simPrice(-SIM.reach)), 0);
  assert.equal(simAt(simPrice(SIM.reach)), 1);
  for (const notch of [-1.1, -0.52, 0, 0.3, 0.85]) assert.ok(Math.abs(simAt(simPrice(notch)) - (notch + SIM.reach) / (2 * SIM.reach)) < 1e-12, `notch ${notch}`);
  // A fall of a third and a rise of a half sit about as far from the start: the range is roughly centred.
  const low = 0.5 - simAt(SIM.lower);
  const high = simAt(SIM.upper) - 0.5;
  assert.ok(low > 0.2 && high > 0.2 && Math.abs(low - high) < 0.05, `range at ${simAt(SIM.lower)} to ${simAt(SIM.upper)}`);
  assert.ok(simAt(SIM.lower) > 0.2 && simAt(SIM.upper) < 0.8, 'both sides of the range leave room for the zones outside it');
  assert.equal(moved(SIM.lower), '−30%');
  assert.equal(moved(SIM.upper), '+50%');
  assert.equal(moved(1), '0%');
  assert.equal(moved(simPrice(0.01)), '+1%');
  assert.equal(moved(simPrice(-0.01)), '−1%', 'a real minus sign');
  assert.equal(moved(simPrice(-SIM.reach)), '−53%');
  assert.equal(moved(simPrice(SIM.reach)), '+114%');
  for (const v of [SIM.reach, SIM.step]) assert.ok(Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, `${v} is a whole number of notches`);
});

test('the Home simulator says what a position holds: both tokens inside the range, one token outside it', () => {
  const { SIM, simPrice, UNIT } = relative;
  const at = (notch) => previewPosition({ amount: UNIT, lower: SIM.lower, upper: SIM.upper, startingPrice: 1, scenarioPrice: simPrice(notch) });
  const read = (notch) => [at(notch).status, Math.round(at(notch).tokenShare * 100)];
  assert.deepEqual(read(0), ['inside', 53], 'about half and half at the start');
  assert.deepEqual(read(0.3), ['inside', 28], 'less ETH as it rises');
  assert.deepEqual(read(-SIM.reach), ['below', 100], 'only ETH below the range');
  assert.deepEqual(read(-0.8), ['below', 100]);
  assert.deepEqual(read(0.85), ['above', 0], 'only USDG above it');
  assert.deepEqual(read(SIM.reach), ['above', 0]);
  // The edges: the first notch under −30% is outside, the last one under +50% still inside.
  assert.equal(at(-0.52).status, 'below');
  assert.equal(at(-0.51).status, 'inside');
  assert.equal(at(0.58).status, 'inside');
  assert.equal(at(0.59).status, 'above');
});

// ---------------------------------------------------------------------------
// Market rows. No dollar figure may be invented: a figure nobody observed is
// unavailable, and there are no sample rows to fall back on.
// ---------------------------------------------------------------------------

/** A market row as the read adapter builds one, with test figures of its own. */
const ROW = {
  key: `4663:0x${'cd'.repeat(32)}`,
  poolId: `0x${'cd'.repeat(32)}`,
  base: 'TKA',
  quote: 'TKB',
  tokens: {
    base: { origin: 'read', chainId: 4663, address: `0x${'1'.repeat(40)}`, symbol: 'TKA', decimals: 18, readStatus: 'available', artwork: null },
    quote: { origin: 'read', chainId: 4663, address: `0x${'2'.repeat(40)}`, symbol: 'TKB', decimals: 6, readStatus: 'available', artwork: null },
  },
  feePips: 3000,
  protocol: 'v4',
  tvlUsd: { value: '1000', state: 'provider', source: 'GeckoTerminal' },
  volume24hUsd: { value: '500', state: 'provider', source: 'GeckoTerminal' },
  feeAprPercent: { value: null, state: 'unavailable', reason: 'fee_apr_not_provided' },
};

test('an unavailable metric says so instead of showing a number, and there is no sample to show instead', () => {
  const missing = { value: null, state: 'unavailable', reason: 'no_qualified_price' };
  assert.equal(markets.compactUsd(missing), 'Unavailable');
  assert.equal(markets.compactUsd({ value: 'not a number', state: 'provider' }), 'Unavailable');
  assert.equal(markets.turnover({ ...ROW, tvlUsd: missing }).kind, 'unavailable');
  assert.equal(markets.turnover({ ...ROW, volume24hUsd: missing }).kind, 'unavailable');
  assert.equal('listMarkets' in markets, false, 'no sample rows exist to fall back on');
  assert.equal(markets.aprLabel(ROW.feeAprPercent).kind, 'unavailable', 'an APR nobody provides is not a figure');
});

test('a measured zero is shown as zero, never as unavailable', () => {
  assert.equal(markets.compactUsd({ value: '0', state: 'qualified' }), '$0.00');
});

test('compact money keeps its magnitude legible', () => {
  const q = (value) => markets.compactUsd({ value, state: 'qualified' });
  assert.equal(q('12000000000'), '$12.00B');
  assert.equal(q('10500000'), '$10.5M');
  assert.equal(q('582710'), '$582.7K');
  assert.equal(q('42.5'), '$42.50');
});

test('a fee tier reads as a percentage, never as raw pips', () => {
  assert.equal(markets.feeTierLabel(10000), '1.00%');
  assert.equal(markets.feeTierLabel(3000), '0.30%');
  assert.equal(markets.feeTierLabel(500), '0.05%');

});

// ---------------------------------------------------------------------------
// Metric presentation. A retained value must never pass as a current one.
// ---------------------------------------------------------------------------

test('an unavailable metric that still carries a value is shown as unavailable', () => {
  const retained = { value: '10450000', state: 'unavailable', reason: 'provider_unavailable', asOf: 1_700_000_000 };
  const shown = markets.presentMetric(retained);
  assert.equal(shown.kind, 'unavailable');
  assert.equal(shown.reason, 'provider_unavailable');
});

test('a stale metric keeps its value and its original time, and says it is stale', () => {
  const shown = markets.presentMetric({ value: '10450000', state: 'stale', asOf: 1_700_000_000 });
  assert.equal(shown.kind, 'value');
  assert.equal(shown.stale, true);
  assert.equal(shown.asOf, 1_700_000_000);
  assert.equal(shown.text, markets.compactUsd({ value: '10450000', state: 'stale' }));
});

test('a qualified metric is current and not stale', () => {
  const shown = markets.presentMetric({ value: '42.5', state: 'qualified' });
  assert.deepEqual(shown, { kind: 'value', text: '$42.50', stale: false, asOf: undefined });
});

test('a null value is unavailable whatever the state', () => {
  for (const state of ['qualified', 'stale', 'provider', 'unavailable']) {
    assert.equal(markets.presentMetric({ value: null, state }).kind, 'unavailable', state);
  }
});

test('the presentation rule is decided by state, not by value nullness', () => {
  // Same value, four states, four different outcomes.
  const kinds = ['qualified', 'stale', 'provider', 'unavailable'].map((state) => {
    const p = markets.presentMetric({ value: '5', state, ...(state === 'provider' ? { source: 'GeckoTerminal' } : {}) });
    return p.kind === 'unavailable' ? 'unavailable' : p.stale ? 'stale' : p.source ? 'provider' : 'current';
  });
  assert.deepEqual(kinds, ['current', 'stale', 'provider', 'unavailable']);
});

// ---------------------------------------------------------------------------
// Derived figures inherit their inputs' states. Asked for on #1: turnover and
// the ticker APR must not present a retained or stale value as current.
// ---------------------------------------------------------------------------

const metric = (value, state = 'qualified', asOf) => ({ value, state, asOf });
const pool = (volume, tvl) => ({ ...ROW, volume24hUsd: volume, tvlUsd: tvl });

test('turnover of two current figures is current', () => {
  const shown = markets.turnover(pool(metric('500'), metric('1000')));
  assert.deepEqual(shown, { kind: 'value', text: '0.50', stale: false, asOf: undefined });
});

test('an unavailable operand makes turnover unavailable even when it keeps a value', () => {
  for (const [volume, tvl] of [
    [metric('500', 'unavailable'), metric('1000')],
    [metric('500'), metric('1000', 'unavailable')],
    [metric('500', 'unavailable'), metric('1000', 'stale', 1_700_000_000)],
  ]) {
    const shown = markets.turnover(pool(volume, tvl));
    assert.equal(shown.kind, 'unavailable', `${volume.state}/${tvl.state}`);
  }
});

test('one stale operand makes turnover stale, dated to that observation', () => {
  const shown = markets.turnover(pool(metric('500', 'stale', 1_700_000_000), metric('1000')));
  assert.equal(shown.kind, 'value');
  assert.equal(shown.stale, true, 'a mix of stale and current must not read as current');
  assert.equal(shown.asOf, 1_700_000_000);
});

test('two stale operands date turnover to the older observation', () => {
  const shown = markets.turnover(pool(metric('500', 'stale', 1_700_000_900), metric('1000', 'stale', 1_700_000_000)));
  assert.equal(shown.stale, true);
  assert.equal(shown.asOf, 1_700_000_000);
});

test('a stale operand without a time gives a stale turnover without an invented time', () => {
  const shown = markets.turnover(pool(metric('500', 'stale'), metric('1000', 'stale', 1_700_000_000)));
  assert.equal(shown.stale, true);
  assert.equal(shown.asOf, undefined);
});


test('a measured zero volume is 0.00, and a zero TVL has no turnover', () => {
  assert.equal(markets.turnover(pool(metric('0'), metric('1000'))).text, '0.00');
  assert.equal(markets.turnover(pool(metric('1'), metric('1000'))).text, '<0.01');
  assert.equal(markets.turnover(pool(metric('0'), metric('0'))).kind, 'unavailable');
  assert.equal(markets.turnover(pool(metric('5'), metric('0'))).kind, 'unavailable');
});

test('the ticker APR follows the same state rule', () => {
  assert.equal(markets.aprLabel(metric('150.924')).text, '150.92% APR');
  assert.equal(markets.aprLabel(metric('150.92', 'unavailable')).kind, 'unavailable', 'retained APR shown as current');
  const stale = markets.aprLabel(metric('150.92', 'stale', 1_700_000_000));
  assert.equal(stale.stale, true);
  assert.equal(stale.asOf, 1_700_000_000);

  assert.equal(markets.aprLabel(metric(null, 'qualified')).kind, 'unavailable');
});

// ---------------------------------------------------------------------------
// The states the read adapter adds (#1). Each has its own words on screen, and
// none of them may pass as a current figure.
// ---------------------------------------------------------------------------

test('absent, not current and rejected are distinct from unavailable, and none of them shows a number', () => {
  const absent = markets.presentMetric({ value: null, state: 'absent', reason: 'provider_not_reported' });
  assert.deepEqual(absent, { kind: 'absent', reason: 'provider_not_reported' });
  const reference = markets.presentMetric({ value: '158.06', state: 'reference', reason: 'reference_analytics_only' });
  assert.deepEqual(reference, { kind: 'not_current', reason: 'reference_analytics_only', basis: 'reference' });
  const partial = markets.presentMetric({ value: '0.1', state: 'partial' });
  assert.equal(partial.kind, 'not_current');
  const rejected = markets.presentMetric({ value: '12345', state: 'rejected', reason: 'provider_currency_or_pool_mismatch' });
  assert.deepEqual(rejected, { kind: 'unavailable', reason: 'provider_currency_or_pool_mismatch', rejected: true });
  for (const shown of [absent, reference, partial, rejected]) assert.equal('text' in shown, false, `${shown.kind} carries a figure`);
});

test('a null a provider reported is not reported by that provider, by name, and still carries no figure', () => {
  const shown = markets.presentMetric({ value: null, state: 'absent', reason: 'provider_not_reported', source: 'GeckoTerminal' });
  assert.deepEqual(shown, { kind: 'absent', reason: 'provider_not_reported', source: 'GeckoTerminal' });
});

test('a provider figure names its provider and is never presented as qualified', () => {
  const shown = markets.presentMetric({ value: '12345.67', state: 'provider', source: 'GeckoTerminal', asOf: 1010 });
  assert.deepEqual(shown, { kind: 'value', text: '$12.3K', stale: false, asOf: 1010, source: 'GeckoTerminal' });
});

test('zero inside a usable observation is a value; the same zero in an unavailable one is not shown', () => {
  assert.equal(markets.presentMetric({ value: '0', state: 'provider', source: 'GeckoTerminal' }).text, '$0.00');
  assert.equal(markets.presentMetric({ value: '0', state: 'unavailable' }).kind, 'unavailable');
  assert.equal(markets.compactUsd({ value: '0.000020026865830513', state: 'qualified' }), '$0.000020', 'sub-cent keeps six places, as formatAmount does');
});

test('turnover needs two usable operands on one basis', () => {
  const provider = (value, source = 'GeckoTerminal') => ({ value, state: 'provider', source });
  for (const bad of [metric('1000', 'reference'), metric('1000', 'partial'), { value: null, state: 'absent' }, metric('1000', 'rejected'), metric('1000', 'unavailable')]) {
    assert.equal(markets.turnover(pool(metric('500'), bad)).kind, 'unavailable', `TVL ${bad.state}`);
    assert.equal(markets.turnover(pool(bad, metric('1000'))).kind, 'unavailable', `volume ${bad.state}`);
  }
  assert.deepEqual(markets.turnover(pool(provider('500'), metric('1000'))), { kind: 'unavailable', reason: 'mixed_basis' });
  assert.deepEqual(markets.turnover(pool(provider('500'), provider('1000', 'DexScreener'))), { kind: 'unavailable', reason: 'mixed_basis' });
  const attributed = markets.turnover(pool(provider('500'), provider('1000')));
  assert.deepEqual([attributed.text, attributed.calculatedFrom, attributed.stale], ['0.50', 'GeckoTerminal', false]);
  const stale = markets.turnover(pool({ ...provider('500'), state: 'stale', asOf: 1010 }, provider('1000')));
  assert.deepEqual([stale.stale, stale.asOf, stale.calculatedFrom], [true, 1010, 'GeckoTerminal']);
});

test('turnover of two GeckoTerminal figures is calculated by Domino from them, never a figure GeckoTerminal reported', () => {
  const reported = (value) => ({ value, state: 'provider', source: 'GeckoTerminal' });
  const shown = markets.turnover(pool(reported('500'), reported('1000')));
  assert.deepEqual(shown, { kind: 'value', text: '0.50', stale: false, asOf: undefined, calculatedFrom: 'GeckoTerminal' });
  assert.equal('source' in shown, false, 'GeckoTerminal reported the volume and the TVL, not their ratio');
  // Unavailable when either input is null, however its observation is labelled.
  for (const missing of [{ value: null, state: 'provider', source: 'GeckoTerminal' }, { value: null, state: 'absent', reason: 'provider_not_reported', source: 'GeckoTerminal' }]) {
    assert.equal(markets.turnover(pool(missing, reported('1000'))).kind, 'unavailable', `volume null (${missing.state})`);
    assert.equal(markets.turnover(pool(reported('500'), missing)).kind, 'unavailable', `TVL null (${missing.state})`);
  }
});

test('turnover divides the decimal strings exactly, whatever their size', () => {
  const huge = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
  assert.equal(markets.turnover(pool(metric(huge), metric(huge))).text, '1.00');
  assert.equal(markets.turnover(pool(metric('1'), metric('3'))).text, '0.33');
});

test('the ticker APR says not current or not reported in words, never with the number', () => {
  assert.equal(markets.aprLabel({ value: '158.06', state: 'reference' }).kind, 'not_current');
  assert.equal(markets.aprLabel({ value: null, state: 'absent' }).kind, 'absent');
  assert.equal(markets.aprLabel({ value: '158.060469175186043958', state: 'qualified' }).text, '158.06% APR');
});

test('a row shows its fee as a fixed tier or as dynamic, and is keyed by pool, never by symbol', () => {
  assert.deepEqual([500, 3000, 9000, 10000].map((feePips) => markets.feeLabel({ feePips })), ['0.05%', '0.30%', '0.90%', '1.00%']);
  assert.equal(markets.feeLabel({ feePips: null }), 'Dynamic fee');
  assert.equal(ROW.key, `4663:${ROW.poolId}`);
  assert.equal(ROW.tokens.base.origin, 'read', 'every token on a row comes from a read');
});
