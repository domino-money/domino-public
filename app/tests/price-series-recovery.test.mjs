import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { CASES, historyFor } from './support/price-range-cases.mjs';

/**
 * The Price range chart (components/positions/visual/PriceVsRange.tsx) rendered as plain elements, its React and its
 * frame stubbed. Changed on purpose 2026-10-02 (RPC-SPEC §11.4): no hook builds a line from a fees history any more (the
 * replay's reads of the pool's Swaps are gone, rugged97's rule 2). Changed on purpose 2026-10-03 (the owner's point 10:
 * "it doesn't show the history"): the line is the pool's stored hourly closes from the read service (read-v3 `history`,
 * usePoolHistory.ts, stubbed here with an answer), and a retained history is never rewritten with the page's price now:
 * its last point is its own last close, and the price now is the chip and the dot apart from it. The card's status, unit
 * and box are RangeStatus.tsx's, which loads with the page while the chart is a chunk of its own.
 */
const require = createRequire(import.meta.url);
const ts = require('typescript');
let answer = { phase: 'reading' };
let status = null;
/** The imports of the two modules: React and the frame stubbed, the pure modules from the unit build. */
const LIB = /^\.\.\/\.\.\/\.\.\/lib\/(format\/|chart\/|read\/orientation$)/;
const local = (name) => {
  if (name === 'react') return { createContext: () => null, useContext: () => null, useMemo: (run) => run(), useCallback: (run) => run };
  if (name === 'react/jsx-runtime') return require(name);
  if (name.endsWith('/useMediaQuery')) return { useMediaQuery: () => false };
  // 2026-10-03 (the density change): labels are placed in rem, 16 design px to the rem (lib/rootScale.ts).
  if (name.endsWith('/rootScale')) return { rem: (px) => `${Number((px / 16).toFixed(5))}rem`, rootScale: () => 1, useRootScale: () => 1 };
  if (name.endsWith('/ChartFrame')) return { ChartFrame: 'chart-frame' };
  if (name.endsWith('/series')) return { useSvgId: (prefix) => prefix, Crosshair: 'crosshair' };
  if (name === './usePoolHistory') return { usePoolHistory: () => answer };
  if (name === './RangeStatus') return (status ??= load('RangeStatus.tsx'));
  if (LIB.test(name)) return require(`../.test-build/app/src/lib/${name.slice('../../../lib/'.length)}.js`);
  return {};
};
/** A .tsx module of components/positions/visual, transpiled and run with `local` for its imports. */
function load(file, extra = '') {
  const source = readFileSync(new URL(`../src/components/positions/visual/${file}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(`${source}\n${extra}`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(local, module, module.exports);
  return module.exports;
}
const mod = { exports: load('PriceVsRange.tsx', 'export { PriceChart };') };
const { PriceChart } = mod.exports;

const item = CASES.inside;
const facts = { base: item.base, quote: item.quote, lower: 0.0018, upper: 0.0035, lowerText: '0.0018', upperText: '0.0035', now: 0.0025, nowText: '0.0025', where: 'inside', block: 74_000_010 };
const ask = { poolId: item.poolId, base: item.base.address, quote: item.quote.address };
const END = 1_790_000_000;
/** Every element of a rendered tree, depth first, the card's own components (RangeHead) drawn as React would. */
function* walk(node) {
  if (Array.isArray(node)) for (const child of node) yield* walk(child);
  else if (node && typeof node === 'object' && node.props) {
    yield node;
    if (typeof node.type === 'function') yield* walk(node.type(node.props));
    else yield* walk(node.props.children);
  }
}
const text = (node) => (node == null || typeof node === 'boolean' ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.props?.children));

test('the module builds no price line from a fees history: no hook of its own, and without a history the legend names the range and the price now, and says why', () => {
  assert.equal(mod.exports.usePriceSeries, undefined);
  assert.equal(mod.exports.usePriceMissing, undefined);
  answer = { phase: 'not_listed' };
  const chart = PriceChart({ openedAt: END - 8 * 86_400, facts, ask });
  const nodes = [...walk(chart)];
  const frame = nodes.find((node) => node.type === 'chart-frame');
  assert.ok(frame, 'the chart’s frame stands, with the range and the price now');
  assert.equal(frame.props.points, 0, 'nothing to inspect without a line');
  assert.equal(chart.props['data-pvr-line'], undefined);
  const legend = nodes.find((node) => node.props.className === 'dm-pvr-legend');
  assert.equal(text(legend), 'Your rangePrice nowPrice history isn’t available yet.');
});

test('a history is drawn as it was stored: its last point is its own last close, never the page’s price now at its old time', () => {
  const data = historyFor(item, { poolId: item.poolId, currency: item.base.address, windowSeconds: 604_800, resolutionSeconds: 3_600 }, { end: END });
  const before = structuredClone(data);
  answer = { phase: 'answered', data, at: END * 1000 };
  // The page's read a little later than the history's snapshot: the price moved since.
  const later = { ...facts, now: 0.00262, nowText: '0.00262' };
  const chart = PriceChart({ openedAt: END - 8 * 86_400, facts: later, ask });
  const frame = [...walk(chart)].find((node) => node.type === 'chart-frame');
  assert.equal(chart.props['data-pvr-line'], '');
  assert.equal(frame.props.points, data.candles.length, 'every hourly close can be inspected');
  const last = data.candles.at(-1);
  const exact = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 }).format(Number(last.close));
  assert.ok(frame.props.valueText(data.candles.length - 1).includes(`, ${exact}, `), frame.props.valueText(data.candles.length - 1));
  assert.notEqual(exact, later.nowText, 'the last close is not the price now, so the check above means something');
  assert.ok(!frame.props.valueText(data.candles.length - 1).includes(later.nowText), 'the price now is not written into the line');
  assert.deepEqual(data, before, 'the stored answer is left as it came');
});

test('an open position writes the current price exactly as the key figures, with the range ends beside it', () => {
  answer = { phase: 'reading' };
  const chart = PriceChart({ openedAt: END - 8 * 86_400, facts: { ...facts, now: 7.10148e-7, nowText: '0.000000710148', lower: 3.66503e-7, upper: 7.99485e-7, lowerText: '0.000000366503', upperText: '0.000000799485', where: 'inside' }, ask });
  const frame = [...walk(chart)].find((node) => node.type === 'chart-frame');
  const plot = { width: 600, height: 242, left: 0, right: 500, top: 16, bottom: 212 };
  const overlay = [...walk(frame.props.overlay(plot, null))];
  const chip = overlay.find((node) => node.props['data-pvr-now'] === '');
  assert.equal(text(chip), '0.0₆710148');
  assert.equal(chip.props['data-pvr-price'], '0.000000710148');
  assert.deepEqual(overlay.filter((node) => node.props['data-pvr-end']).map((node) => node.props['data-pvr-end']), ['max', 'min']);
  assert.equal(text([...walk(chart)].find((node) => node.props.className === 'dm-pvr-says')), 'Earning fees — the price is inside your range');
});

test('while the chart’s code loads, its place holds the same status and a box of the chart’s own height, and nothing that reads as the chart', () => {
  const { RangeChartWaiting, PAD_TOP, PAD_BOTTOM, PLOT_HEIGHT } = local('./RangeStatus');
  const waiting = RangeChartWaiting({ facts: { ...facts, where: 'over', now: 0.0025, upper: 0.0018 } });
  const nodes = [...walk(waiting)];
  assert.equal(waiting.props['data-pvr-where'], undefined, 'the suites wait for [data-pvr-where]: the chart itself');
  assert.equal(text(nodes.find((node) => node.props.className === 'dm-pvr-says')), 'Not earning — the price is above your range');
  assert.equal(text(nodes.find((node) => node.props.className === 'dm-pvr-move')), 'It must fall 28% to come back into your range.');
  // In rem since the density change, as ChartFrame sizes the chart that replaces it (16 design px to the rem).
  assert.equal(nodes.find((node) => node.props.className === 'dm-pvr').props.style.height, `${Number(((PAD_TOP + PLOT_HEIGHT + PAD_BOTTOM) / 16).toFixed(5))}rem`);
});
