import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { loadCase, stateOfCase } from './support/fees/relay-fixture.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = readFileSync(new URL('../src/components/positions/visual/PriceVsRange.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(`${source}\nexport { PriceChart };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const mod = { exports: {} };
const local = (name) => {
  if (name === 'react') return { createContext: () => null, useContext: () => null, useMemo: (run) => run(), useCallback: (run) => run };
  if (name === 'react/jsx-runtime') return require(name);
  if (name.endsWith('/useMediaQuery')) return { useMediaQuery: () => false };
  if (name.endsWith('/ChartFrame')) return { ChartFrame: 'chart-frame' };
  if (/^\.\.\/\.\.\/\.\.\/lib\/(format\/|read\/orientation$)/.test(name)) return require(`../.test-build/app/src/lib/${name.slice('../../../lib/'.length)}.js`);
  return {};
};
new Function('require', 'module', 'exports', compiled)(local, mod, mod.exports);
const { PriceChart } = mod.exports;
const { state } = stateOfCase(loadCase('3136705'));
/**
 * A line of the pool's prices as PriceChart takes it. Changed on purpose 2026-10-02 (RPC-SPEC §11.4): no hook builds one
 * from a fees history any more (the replay's reads of the pool's Swaps are gone, rugged97's rule 2); the chart keeps its
 * `series` for a later source, and draws the range and the price now without one.
 */
const series = (quality) => ({
  points: [2, 1, 0].map((ago) => ({ t: state.timestamp - ago * 3_600, price: 120 + ago, text: String(120 + ago), inRange: true })),
  gapAt: -1,
  state,
  quality,
});
const facts = { base: {}, quote: {}, lower: 0, upper: Infinity, lowerText: null, upperText: null, now: 123, nowText: '123', where: 'inside', block: state.block + 10 };

test('the module builds no price line from a fees history any more: no hook, and without a series the legend names the range and no line', () => {
  assert.equal(mod.exports.usePriceSeries, undefined);
  assert.equal(mod.exports.usePriceMissing, undefined);
  const chart = PriceChart({ series: null, facts, missing: false });
  const frame = chart.props.children.find((child) => child?.type === 'chart-frame');
  assert.ok(frame, 'the chart’s frame stands, with the range and the price now');
  const legend = JSON.stringify(chart.props.children[2].props.children);
  assert.match(legend, /Your range/);
  assert.doesNotMatch(legend, /"Price"|no-price|isn’t available/);
});

test('an older historical endpoint is never rewritten with the current price at its old timestamp', () => {
  for (const quality of ['verified', 'cached']) {
    const got = series(quality);
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
