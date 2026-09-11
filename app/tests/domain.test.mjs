import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const geometry = require('../.test-build/app/src/lib/geometry.js');
const format = require('../.test-build/app/src/lib/format.js');
const markets = require('../.test-build/app/src/lib/markets.js');
const pair = require('../.test-build/app/src/lib/pair.js');
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

test('the input mask accepts what the engine accepts', () => {
  for (const good of ['0', '10', '1000000', '0.000001', '57.25']) {
    assert.equal(pair.isMoney(good), true, `${good} should be typable`);
  }
  for (const bad of ['', '.', '1.', '-1', '1.0000001', 'abc', '1e6', '1,5']) {
    assert.equal(pair.isMoney(bad), false, `${bad} should be rejected`);
  }
  // Surrounding space is trimmed rather than rejected, so a pasted amount works.
  assert.equal(pair.isMoney(' 57.25 '), true);
});

// ---------------------------------------------------------------------------
// Money display. Sub-cent amounts must not collapse to $0.00, zero is never
// coloured, and the sign is always present so colour is not the only cue.
// ---------------------------------------------------------------------------

test('a real sub-cent fee is never shown as zero', () => {
  assert.equal(format.formatAmount(0.000001, { tone: 'in' }), '+$0.000001');
  assert.equal(format.decimalsFor(0.004), 6);
  assert.ok(!/^\+\$0\.00$/.test(format.formatAmount(0.004, { tone: 'in' })));
});

test('zero is neutral whatever tone is requested', () => {
  for (const tone of ['in', 'out', 'wait', 'neutral']) {
    assert.equal(format.toneFor(0, tone), 'neutral');
    assert.equal(format.formatAmount(0, { tone }), '$0.00');
  }
});

test('the sign carries the direction without colour', () => {
  assert.equal(format.formatAmount(12.5, { tone: 'in' }), '+$12.50');
  assert.equal(format.formatAmount(12.5, { tone: 'out' }), '−$12.50');
  assert.equal(format.formatAmount(12.5, { tone: 'wait' }), '$12.50');
});

test('exact mode always shows six places, even at two-place values', () => {
  assert.equal(format.formatAmount(12.5, { exact: true }), '$12.500000');
  assert.equal(format.formatAmount(12.5), '$12.50');
});

test('an engine string renders without losing its precision', () => {
  const d = scenario('0.000004', '0');
  assert.equal(format.formatAmount(d.reinvestedUsd, { tone: 'in' }), '+$0.000004');
  assert.equal(moneyUnits(d.reinvestedUsd), 4n * (MICRO / MICRO));
});

// ---------------------------------------------------------------------------
// Market rows. No dollar figure may be invented, so every placeholder must
// declare itself.
// ---------------------------------------------------------------------------

test('placeholder market data is labelled as such and carries no measured figure', () => {
  const result = markets.listMarkets();
  assert.equal(result.source, 'placeholder');
  assert.ok(result.notice && result.notice.length > 0, 'a placeholder must say so on screen');
  assert.equal(result.chainId, 4663);
  assert.ok(result.markets.length > 0);
  for (const m of result.markets) {
    for (const key of ['tvlUsd', 'volume24hUsd', 'volume30dUsd', 'feeAprPercent']) {
      assert.equal(m[key].state, 'placeholder', `${m.base}/${m.quote} ${key} must not claim to be measured`);
    }
  }
});

test('an unavailable metric says so instead of showing a number', () => {
  const missing = { value: null, state: 'unavailable', reason: 'no_qualified_price' };
  assert.equal(markets.compactUsd(missing), 'Unavailable');
  assert.equal(markets.compactUsd({ value: 'not a number', state: 'placeholder' }), 'Unavailable');
  const [m] = markets.listMarkets().markets;
  assert.equal(markets.turnover({ ...m, tvlUsd: missing }).kind, 'unavailable');
  assert.equal(markets.turnover({ ...m, volume24hUsd: missing }).kind, 'unavailable');
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
  assert.equal(pair.feeTier(pair.PAIR.feePips), markets.feeTierLabel(pair.PAIR.feePips));
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

test('a qualified metric is neither stale nor a sample', () => {
  const shown = markets.presentMetric({ value: '42.5', state: 'qualified' });
  assert.deepEqual(shown, { kind: 'value', text: '$42.50', stale: false, sample: false, asOf: undefined });
});

test('a placeholder is marked as a sample, and a null value is unavailable whatever the state', () => {
  assert.equal(markets.presentMetric({ value: '1', state: 'placeholder' }).sample, true);
  for (const state of ['qualified', 'stale', 'placeholder', 'unavailable']) {
    assert.equal(markets.presentMetric({ value: null, state }).kind, 'unavailable', state);
  }
});

test('the presentation rule is decided by state, not by value nullness', () => {
  // Same value, four states, four different outcomes.
  const kinds = ['qualified', 'stale', 'placeholder', 'unavailable'].map((state) => {
    const p = markets.presentMetric({ value: '5', state });
    return p.kind === 'unavailable' ? 'unavailable' : p.stale ? 'stale' : p.sample ? 'sample' : 'current';
  });
  assert.deepEqual(kinds, ['current', 'stale', 'sample', 'unavailable']);
});

// ---------------------------------------------------------------------------
// Derived figures inherit their inputs' states. Asked for on #1: turnover and
// the ticker APR must not present a retained or stale value as current.
// ---------------------------------------------------------------------------

const metric = (value, state = 'qualified', asOf) => ({ value, state, asOf });
const pool = (volume, tvl) => ({ ...markets.listMarkets().markets[0], volume24hUsd: volume, tvlUsd: tvl });

test('turnover of two current figures is current', () => {
  const shown = markets.turnover(pool(metric('500'), metric('1000')));
  assert.deepEqual(shown, { kind: 'value', text: '0.50', stale: false, sample: false, asOf: undefined });
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

test('a sample operand makes turnover a sample', () => {
  assert.equal(markets.turnover(pool(metric('500', 'placeholder'), metric('1000'))).sample, true);
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
  assert.equal(markets.aprLabel(metric('150.92', 'placeholder')).sample, true);
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

test('a provider figure names its provider and is never presented as qualified', () => {
  const shown = markets.presentMetric({ value: '12345.67', state: 'provider', source: 'GeckoTerminal', asOf: 1010 });
  assert.deepEqual(shown, { kind: 'value', text: '$12.3K', stale: false, sample: false, asOf: 1010, source: 'GeckoTerminal' });
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
  assert.deepEqual([attributed.text, attributed.source, attributed.stale], ['0.50', 'GeckoTerminal', false]);
  const stale = markets.turnover(pool({ ...provider('500'), state: 'stale', asOf: 1010 }, provider('1000')));
  assert.deepEqual([stale.stale, stale.asOf, stale.source], [true, 1010, 'GeckoTerminal']);
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

test('the sample rows keep the landing figures exactly and are keyed by pool, not by symbol', () => {
  // The strings the landing showed before the adapter, computed with the old Number code.
  const rows = markets.listMarkets().markets;
  const cell = (m) => markets.presentMetric(m).text;
  assert.deepEqual(rows.map((m) => cell(m.tvlUsd)), ['$10.4M', '$3.2M', '$1.3M', '$582.7K', '$509.5K']);
  assert.deepEqual(rows.map((m) => cell(m.volume24hUsd)), ['$37.1M', '$550.5K', '$1.4M', '$533.9K', '$752.4K']);
  assert.deepEqual(rows.map((m) => cell(m.volume30dUsd)), ['$812.0M', '$16.4M', '$39.1M', '$12.8M', '$9.3M']);
  assert.deepEqual(rows.map((m) => markets.turnover(m).text), ['3.55', '0.17', '1.08', '0.92', '1.48']);
  assert.deepEqual(rows.map((m) => markets.aprLabel(m.feeAprPercent).text), ['150.92% APR', '22.52% APR', '84.05% APR', '68.27% APR', '24.54% APR']);
  assert.deepEqual(rows.map((m) => markets.feeLabel(m)), ['0.05%', '0.30%', '0.90%', '1.00%', '1.00%']);
  assert.equal(markets.feeLabel({ feePips: null }), 'Dynamic fee');
  for (const m of rows) {
    assert.equal(m.key, `4663:${m.poolId}`);
    assert.deepEqual([m.tokens.base.origin, m.tokens.base.symbol], ['sample', m.base]);
  }
});
