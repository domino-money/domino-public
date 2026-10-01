import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { loadCase, stateOfCase } from './support/fees/relay-fixture.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
let view;
const source = readFileSync(new URL('../src/components/positions/visual/PriceVsRange.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(`${source}\nexport { PriceChart };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const mod = { exports: {} };
const local = (name) => {
  if (name === 'react') return { createContext: () => null, useContext: () => null, useMemo: (run) => run(), useCallback: (run) => run };
  if (name === 'react/jsx-runtime') return require(name);
  if (name.endsWith('/useFeeHistory')) return { useFeeHistory: () => view };
  if (name.endsWith('/useMediaQuery')) return { useMediaQuery: () => false };
  if (name.endsWith('/ChartFrame')) return { ChartFrame: 'chart-frame' };
  if (/^\.\.\/\.\.\/\.\.\/lib\/(format\/|read\/orientation$)/.test(name)) return require(`../.test-build/app/src/lib/${name.slice('../../../lib/'.length)}.js`);
  return {};
};
new Function('require', 'module', 'exports', compiled)(local, mod, mod.exports);
const { usePriceSeries, PriceChart } = mod.exports;
const { state } = stateOfCase(loadCase('3136705'));
const prices = { hours: [2, 1].map((ago) => ({ anchor: state.block - ago * 36_000, t: state.timestamp - ago * 3_600, sqrtPriceX96Close: state.sqrtPriceX96, tickClose: state.tick })) };
const series = (phase, extra = {}) => {
  view = { phase, state, prices, ...extra };
  return usePriceSeries('3136705');
};
const facts = { base: {}, quote: {}, lower: 0, upper: Infinity, lowerText: null, upperText: null, now: 123, nowText: '123', where: 'inside', block: state.block + 10 };

test('qualified estimated and cached price series are immediately reused without becoming verified', () => {
  for (const quality of ['verified', 'estimated', 'cached']) {
    const got = series(quality);
    assert.ok(got, quality);
    assert.equal(got.quality, quality);
    assert.equal(view.phase, quality, 'presentation never changes the accounting qualification');
    assert.equal(got.points.at(-1).t, state.timestamp);
    assert.equal(got.gapAt >= 0, quality === 'estimated', 'a cached completed replay keeps its coverage; an estimate retains its gap');
  }
  const { owner: _owner, ...publicState } = state;
  assert.ok(series('cached', { state: publicState }), 'a public cached series needs no owner or wallet session');
});

test('missing decimals, absent hours and unavailable history do not invent a price series', () => {
  for (const quality of ['verified', 'estimated', 'cached', 'unclaimed-only']) {
    assert.equal(series(quality, { state: { ...state, currencies: [{ ...state.currencies[0], decimals: null }, state.currencies[1]] } }), null);
    assert.equal(series(quality, { prices: { hours: [] } }), null);
  }
  for (const phase of ['idle', 'loading', 'unavailable']) assert.equal(series(phase), null);
  assert.equal(series('unclaimed-only', { prices: null }), null);
});

test('an older historical endpoint is never rewritten with the current price at its old timestamp', () => {
  for (const quality of ['verified', 'estimated', 'cached']) {
    const got = series(quality);
    assert.ok(got, quality);
    const original = structuredClone(got.points);
    const chart = PriceChart({ series: got, facts });
    const frame = chart.props.children.find((child) => child?.type === 'chart-frame');
    assert.ok(frame);
    assert.ok(frame.props.valueText(got.points.length - 1).endsWith(`, ${got.points.at(-1).text}`));
    assert.deepEqual(got.points, original, 'the reusable source series is immutable');
    assert.equal(chart.props['data-pvr-quality'], quality);
    assert.equal(frame.props.label.includes(quality), quality !== 'verified');
    assert.ok(chart.props.children[2].props.children[1].props.children.includes('Price'), 'the visible legend is unchanged; qualification stays in chart semantics');
  }
});

test('the same snapshot still writes the current endpoint exactly as the header does', () => {
  const got = series('verified');
  const chart = PriceChart({ series: got, facts: { ...facts, block: state.block } });
  const frame = chart.props.children.find((child) => child?.type === 'chart-frame');
  assert.ok(frame.props.valueText(got.points.length - 1).endsWith(', 123'));
});
