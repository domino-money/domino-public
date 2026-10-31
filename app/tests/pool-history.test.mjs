import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { ratioGeometry, ratioText, ratioCandleText } = require('../.test-build/app/src/lib/read/ratioSeries.js')
const { watchPublicHistory } = require('../.test-build/app/src/lib/read/historyRead.js')
const flush = () => new Promise(resolve => setImmediate(resolve))
const poolId = '0x' + 'a'.repeat(64), currency = '0x' + '1'.repeat(40), quote = '0x' + '2'.repeat(40)
const candle = (timestamp, close, complete = true) => ({ startTimestamp: timestamp, open: close, high: close, low: close, close, swapCount: 1, complete })
const history = (extra = {}) => ({ schemaVersion: 1, chainId: 4663, poolId, currency, quoteCurrency: quote,
  source: 'robinhood_pool_swap_logs', methodology: 'pool_ratio_v1', unit: 'quote_per_base', status: 'partial', reason: 'history_acquisition_pending',
  requestedWindow: { startTimestamp: 0, endTimestamp: 86400 }, resolutionSeconds: 3600,
  snapshot: { number: 100, hash: '0x' + 'b'.repeat(64), timestamp: 86400 }, covered: [{ startTimestamp: 0, endTimestamp: 14400 }],
  gaps: [{ startTimestamp: 14400, endTimestamp: 86400 }], candles: [candle(0, '1'), candle(3600, '2'), candle(10800, '3')], acquisitionAccepted: true, ...extra })

function lazyHistory(error = null) {
  const React = require('react'), ts = require('typescript')
  const { renderToStaticMarkup } = require('react-dom/server')
  let loader, imports = 0, recoveries = 0
  const Shared = () => null
  const code = ts.transpileModule(readFileSync(new URL('../src/components/read/screens/LazyPoolHistoryChart.tsx', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', code)(name => {
    if (name === 'react') return { ...React, lazy: start => { loader = start; return () => null } }
    if (name === 'react/jsx-runtime') return require(name)
    if (name.endsWith('/staleRelease')) return { isMissingChunk: value => value?.missingChunk === true, recoverWhenSafe: () => recoveries++ }
    if (name.endsWith('/ui')) return { Skeleton: props => React.createElement('span', { ...props, 'data-skeleton': '' }) }
    if (name === './PoolHistoryChart') { imports++; if (error) throw error; return { PoolHistoryChart: Shared } }
    throw new Error(`Unexpected dependency ${name}`)
  }, mod, mod.exports)
  return { ...mod.exports, load: () => loader(), Shared, render: renderToStaticMarkup,
    get imports() { return imports }, get recoveries() { return recoveries } }
}

test('the pool history boundary waits for mount and passes the current props to the shared chart', async () => {
  const screen = lazyHistory(), first = { source: {}, option: {}, market: {}, loading: true, compact: true }
  assert.equal(screen.imports, 0, 'opening wallet or position reads does not load this chart module')
  const waiting = screen.PoolHistoryChart(first)
  const markup = screen.render(waiting.props.fallback)
  assert.match(markup, /dm-pool-chart--compact/)
  assert.match(markup, /Loading price history/)
  assert.match(markup, /dm-pool-chart-foot/, 'the denomination row reserves its final height')
  const loaded = await screen.load()
  assert.equal(screen.imports, 1)
  assert.equal(loaded.default, screen.Shared, 'the page and popup load the same reader/rendering component')
  const current = { ...first, market: { updated: true }, loading: false }
  const visible = screen.PoolHistoryChart(current)
  assert.deepEqual(visible.props.children.props, current, 'a snapshot captured before the module loaded is never substituted')
})

test('a missing or failed chart chunk keeps the pool card visible and only schedules safe release recovery', async () => {
  for (const error of [{ missingChunk: true }, new Error('Offline')]) {
    const screen = lazyHistory(error), loaded = await screen.load()
    const markup = screen.render(loaded.default({ compact: true }))
    assert.equal(screen.recoveries, error.missingChunk ? 1 : 0, 'a stale chunk requests safe recovery rather than reloading under a modal')
    // changed on purpose 2026-10-15 (pack 7, owner: no status notices): the dash, no longer "Price history is temporarily unavailable."
    assert.doesNotMatch(markup, /temporarily unavailable/)
    assert.match(markup, /<div class="dm-pool-plot dm-pool-plot-empty"><span class="text-fg-subtle">—<\/span><\/div>/)
    assert.match(markup, /dm-pool-chart--compact/)
    assert.doesNotMatch(markup, /data-skeleton|data-pool-history-loading|Loading price history|Reload/)
  }
})

test('ratio plot leaves missing candles and acquisition gaps disconnected', () => {
  const data = history()
  const plot = ratioGeometry(data)
  assert.equal(plot.paths.length, 2)
  assert.equal(plot.points.length, 3)
  assert.match(plot.paths[0], / L/)
  assert.doesNotMatch(plot.paths[1], / L/)
  assert.ok(plot.points.at(-1).x < plot.width / 4, 'a few hours never stretch across the whole requested day')
  assert.ok(plot.gaps[0].width > 0)
  assert.equal(plot.points[0].candle, data.candles[0], 'exact source values are retained')
})
test('partial candles and explicit gaps cannot be joined even at adjacent timestamps', () => {
  assert.equal(ratioGeometry(history({ candles: [candle(0, '1'), candle(3600, '2', false)] })).paths.length, 2)
  assert.equal(ratioGeometry(history({ candles: [candle(0, '1'), candle(3600, '2')], gaps: [{ startTimestamp: 1000, endTimestamp: 2000 }] })).paths.length, 2)
})
test('huge and tiny exact ratios produce finite geometry without USD or zero formatting', () => {
  const tiny = '0.' + '0'.repeat(150) + '123456789'
  const high = '9'.repeat(150)
  assert.match(ratioText(tiny), /10\^-151/)
  assert.match(ratioText(high), /10\^149/)
  assert.equal(ratioText('1.25'), '1.25')
  assert.equal(ratioText('0'), '—')
  const plot = ratioGeometry(history({ candles: [candle(0, tiny), candle(3600, high)] }))
  assert.ok(plot.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)))
  assert.ok(ratioCandleText(candle(0, tiny)).includes(tiny))
  assert.doesNotMatch(ratioCandleText(candle(0, tiny)), /USD|\$/)
  assert.equal(ratioGeometry(history({ candles: [] })), null)
})

function fakeClock() {
  const sleeps = []
  return { sleeps, now: () => 1000, monotonic: () => 0, random: () => 0.5, timer: () => () => {},
    sleep(ms, signal) {
      return new Promise((resolve, reject) => {
        const row = { ms, signal, cancelled: false, resolve: () => { signal?.removeEventListener('abort', stop); resolve() } }
        const stop = () => { row.cancelled = true; reject(new Error('aborted')) }
        if (signal?.aborted) return stop()
        signal?.addEventListener('abort', stop, { once: true }); sleeps.push(row)
      })
    },
  }
}
const request = { poolId, currency, windowSeconds: 86400, resolutionSeconds: 3600 }
test('disabled or failed capabilities never fan out a history or legacy data request', async () => {
  for (const check of [undefined, { state: 'not_enabled' }, { state: 'failed' }]) {
    const events = [], calls = []
    const source = { transport: 'bridge', routeEnabled: async route => (calls.push(route), check), read: () => { throw new Error('must not read') } }
    await watchPublicHistory(source, request, event => events.push(event), { signal: new AbortController().signal })
    assert.deepEqual(calls, ['history'])
    assert.equal(events[0].state, check?.state === 'failed' ? 'capability_failed' : 'not_enabled')
  }
})
// Added 2026-09-28 (speed wave, item 3): a capabilities check still failing in passing after publicSource.ts asked it
// again is a failure now, not "not listed" (which sent the chart to the provider's candles): asked again as transient.ts
// allows, then the history is read.
test('a capabilities check that failed in passing is asked again quietly, then the history is read', async () => {
  const clock = fakeClock(), controller = new AbortController(), events = [], checks = []
  const answers = [{ state: 'failed', outcome: { state: 'unavailable', cause: { kind: 'edge', status: 502 }, retryable: false } }, { state: 'enabled' }]
  const reads = []
  const source = { transport: 'bridge', routeEnabled: async (route) => (checks.push(route), answers.shift()),
    read: async (...args) => { reads.push(args); return new Promise(() => {}) } }
  void watchPublicHistory(source, request, event => events.push(event), { signal: controller.signal, clock, page: null })
  await flush()
  assert.deepEqual(events.map((event) => event.state), ['capability_failed'])
  assert.equal(reads.length, 0)
  const wait = clock.sleeps.find((row) => !row.cancelled)
  assert.ok(wait.ms >= 3000 && wait.ms <= 5000, `about 4 s (${wait.ms})`)
  wait.resolve(); await flush()
  assert.deepEqual(checks, ['history', 'history'])
  assert.deepEqual(events.map((event) => event.state), ['capability_failed', 'reading'])
  assert.equal(reads.length, 1)
  // A final failure is not asked again.
  const final = [], finalChecks = []
  await watchPublicHistory({ transport: 'bridge', routeEnabled: async () => (finalChecks.push(1), { state: 'failed', outcome: { state: 'gate_required' } }) }, request, (event) => final.push(event), { signal: new AbortController().signal, clock: fakeClock(), page: null })
  assert.deepEqual([final.map((event) => event.state), finalChecks.length], [['capability_failed'], 1])
  controller.abort()
})

// Added 2026-09-28 (speed wave, item 6): an answer another screen read a moment ago (the Markets card's, kept 30 s,
// publicMetadataCache.ts) is asked again on its own rhythm, so it is never shown longer than a fresh one would be.
test('the next read counts its minute from when the answer was read, 30 s earlier at the most', async () => {
  const clock = fakeClock(), controller = new AbortController()
  let at = 20_000
  clock.monotonic = () => at
  const answers = [0, -1e9]
  const source = { transport: 'bridge', routeEnabled: async () => ({ state: 'enabled' }),
    read: async () => ({ state: 'ok', data: history(), provenance: { receivedMonotonic: answers.shift() ?? at, receivedAt: 0 } }) }
  void watchPublicHistory(source, request, () => {}, { signal: controller.signal, clock, page: null })
  await flush()
  assert.ok(clock.sleeps.some((row) => row.ms === 40_000), 'read 20 s ago: asked again 40 s on')
  clock.sleeps.find((row) => row.ms === 40_000).resolve(); await flush()
  assert.ok(clock.sleeps.some((row) => row.ms === 30_000), 'never more than 30 s early')
  controller.abort()
})

test('history refresh is serial, keeps the same request, and aborts on unmount', async () => {
  const clock = fakeClock(), controller = new AbortController(), calls = [], events = []
  let finish
  const source = { transport: 'bridge', routeEnabled: async () => ({ state: 'enabled' }),
    read: async (...args) => { calls.push(args); return new Promise(resolve => { finish = resolve }) } }
  const running = watchPublicHistory(source, request, event => events.push(event), { signal: controller.signal, clock })
  await flush()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].slice(0, 2), ['history', request])
  // While the first read is pending only its 60s deadline exists; the
  // successful-refresh interval must not be scheduled until it settles.
  assert.equal(clock.sleeps.filter(x => !x.cancelled && x.ms === 60000).length, 1)
  const initialDeadline = clock.sleeps.find(x => !x.cancelled && x.ms === 60000)
  finish({ state: 'ok', data: history() }); await flush()
  assert.equal(events.at(-1).state, 'answer')
  const interval = clock.sleeps.find(x => !x.cancelled && x.ms === 60000)
  assert.ok(interval)
  assert.notEqual(interval, initialDeadline)
  interval.resolve(); await flush()
  assert.equal(calls.length, 2)
  controller.abort(); finish({ state: 'aborted' }); await running
  assert.equal(calls[1][2].signal.aborted, true)
  assert.equal(events.filter(x => x.state === 'answer').length, 1)
})
test('a hidden tab waits for visibility and never starts a data POST', async () => {
  const listeners = new Set(), controller = new AbortController(), clock = fakeClock(), reads = []
  const page = { hidden: true, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) }
  const source = { transport: 'bridge', routeEnabled: async () => ({ state: 'enabled' }), read: async () => { reads.push('history'); return { state: 'disabled' } } }
  const running = watchPublicHistory(source, request, () => {}, { signal: controller.signal, clock, page })
  await flush(); assert.equal(reads.length, 0)
  page.hidden = false; for (const fn of listeners) fn()
  await running; assert.equal(reads.length, 1)
  assert.equal(listeners.size, 0)
})
test('permanent refusals do not poll and Retry-After bounds transient retries', async () => {
  const controller = new AbortController(), clock = fakeClock(), events = []
  await watchPublicHistory({ transport: 'bridge', routeEnabled: async () => ({ state: 'enabled' }), read: async () => ({ state: 'disabled' }) }, request, e => events.push(e), { signal: controller.signal, clock })
  assert.equal(clock.sleeps.filter(x => !x.cancelled).length, 0)
  const pending = watchPublicHistory({ transport: 'bridge', routeEnabled: async () => ({ state: 'enabled' }), read: async () => ({ state: 'busy', retryAfterSeconds: 30 }) }, request, () => {}, { signal: controller.signal, clock })
  await flush()
  assert.ok(clock.sleeps.some(x => !x.cancelled && x.ms >= 30000))
  controller.abort(); await pending
})

// Changed on purpose (2026-09-27, round 6, the pool page for beginners): the chart has no source switch any more (the
// provider's USD chart stands in only where history is not listed), so its useState order is side, window, answer,
// inspection; the unit reads "QUOTE for 1 BASE"; missing hours are said in plain words; and the exact candles are each
// point's accessible text, with no list of them on the page.
test('rendered ratio chart names its denomination, real coverage and exact values', () => {
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server'), ts = require('typescript')
  const data = history(), key = `${poolId}:${currency}:day`
  const values = ['zero', 'day', { key, state: 'answer', data, failed: false }, null]
  let index = 0
  const hooks = { useState: () => [values[index++], () => {}], useEffect() {}, useId: () => 'test' }
  const code = ts.transpileModule(readFileSync(new URL('../src/components/read/screens/PoolHistoryChart.tsx', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  // 2026-09-24 (V2 P2, R-5): the chart draws its area with areaUnder and its runs with linePath/curveFor
  // (lib/chart/paths.ts), and the header change with percentChange (lib/format/change.ts); the hook set and the
  // 5-useState order are unchanged.
  const { areaUnder, curveFor, linePath } = require('../.test-build/app/src/lib/chart/paths.js'), { percentChange } = require('../.test-build/app/src/lib/format/change.js')
  // 2026-09-24 (V2 final polish): the time axis adds interior ticks with timeTicks (lib/chart/scale.ts) labelled by
  // axisLabel (lib/format/time.ts); numbers only, and the hook set and the 5-useState order are unchanged.
  const { timeTicks } = require('../.test-build/app/src/lib/chart/scale.js'), { axisLabel } = require('../.test-build/app/src/lib/format/time.js')
  const mod = { exports: {} }, dependencies = { watchPublicHistory() {}, useLoadMilestone() {}, ratioGeometry, ratioText, ratioCandleText, areaUnder, curveFor, linePath, percentChange, timeTicks, axisLabel, plainClose: require('../.test-build/app/src/lib/read/marketPrice.js').plainClose, useNow: () => ({ wall: 86400000 }),
    Segmented: () => null, Skeleton: () => null, PoolPriceChart: () => null, daySpan: () => null,
    PoolTokenLabel: ({ token }) => React.createElement('span', null, token.symbol), Address: ({ value }) => React.createElement('span', null, value) }
  new Function('require', 'module', 'exports', code)(name => name === 'react' ? hooks : name === 'react/jsx-runtime' ? require(name) : dependencies, mod, mod.exports)
  const tree = mod.exports.PoolHistoryChart({ source: {}, option: { key: poolId, currencies: [{ address: currency, symbol: 'BASE' }, { address: quote, symbol: 'QUOTE' }] }, market: null, loading: false })
  const markup = renderToStaticMarkup(tree)
  assert.match(markup, /quote_per_base/)
  assert.match(markup, /QUOTE<\/span> for 1 <span>BASE/)
  assert.match(markup, /Some hours are missing: they are shaded\./)
  // Changed on purpose 2026-10-30 (QA round 2, N16): the header's price has no title (it read the raw close, "Prices from
  // swaps on Robinhood Chain." and "Verified through block N."), and the slider says the hour in the screen's own figures.
  assert.doesNotMatch(markup, /Prices from swaps on Robinhood Chain|Verified through block|complete interval|partial interval/)
  assert.match(markup, /role="slider"/)
  // N2 (2026-10-30, one price format): the screen writes a price of 1 or more with two decimals at least, as the pool page.
  assert.match(markup, /aria-valuetext="\d{2}-\d{2} \d{2}:\d{2} UTC, close 3\.00 QUOTE, high 3\.00, low 3\.00, \d+ swaps?"/)
})

// Added 2026-10-30 (QA round 2, final review read-4): at rest the header writes the pool's own price (N9) and measures its
// change to that price unrounded, never to the four significant digits written below 1: a pool at the tick nearest
// 0.00012914 whose first close was 0.00012914 has not moved, so it reads a flat 0.00% (against "0.0001291" it read a red
// 0.03%).
test('at rest the header’s change is measured to the pool price unrounded: a pool that did not move reads a flat 0.00%', () => {
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server'), ts = require('typescript')
  const { sqrtPriceAtTick } = require('../.test-build/app/src/lib/read/screens/poolRange.js')
  const { marketPoolPrice, plainClose } = require('../.test-build/app/src/lib/read/marketPrice.js')
  const { areaUnder, curveFor, linePath } = require('../.test-build/app/src/lib/chart/paths.js'), { percentChange } = require('../.test-build/app/src/lib/format/change.js')
  const { timeTicks } = require('../.test-build/app/src/lib/chart/scale.js'), { axisLabel } = require('../.test-build/app/src/lib/format/time.js')
  const code = ts.transpileModule(readFileSync(new URL('../src/components/read/screens/PoolHistoryChart.tsx', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const tick = -89551
  const market = { poolState: { sqrtPriceX96: sqrtPriceAtTick(tick).toString(), tick, tickSpacing: 1, block: 100, currency0: currency, currency1: quote },
    tokens: { base: { address: currency, symbol: 'BASE', decimals: 18, readStatus: 'available' }, quote: { address: quote, symbol: 'QUOTE', decimals: 18, readStatus: 'available' } } }
  const data = history({ status: 'complete', reason: null, gaps: [], covered: [{ startTimestamp: 0, endTimestamp: 86400 }], candles: [candle(0, '0.00012914'), candle(3600, '0.00012914')] })
  const values = ['zero', 'day', { key: `${poolId}:${currency}:day`, state: 'answer', data, failed: false }, null]
  let index = 0
  const hooks = { useState: () => [values[index++], () => {}], useEffect() {}, useId: () => 'test' }
  const mod = { exports: {} }, dependencies = { watchPublicHistory() {}, useLoadMilestone() {}, ratioGeometry, ratioText, ratioCandleText, areaUnder, curveFor, linePath, percentChange, timeTicks, axisLabel, plainClose, marketPoolPrice, useNow: () => ({ wall: 86400000 }),
    Segmented: () => null, Skeleton: () => null, PoolPriceChart: () => null, daySpan: () => null,
    PoolTokenLabel: ({ token }) => React.createElement('span', null, token.symbol), Address: ({ value }) => React.createElement('span', null, value) }
  new Function('require', 'module', 'exports', code)(name => name === 'react' ? hooks : name === 'react/jsx-runtime' ? require(name) : dependencies, mod, mod.exports)
  const markup = renderToStaticMarkup(mod.exports.PoolHistoryChart({ source: {}, option: { key: poolId, currencies: [{ address: currency, symbol: 'BASE' }, { address: quote, symbol: 'QUOTE' }] }, market, loading: false }))
  assert.equal(marketPoolPrice(market, { wall: 0 }).text, '0.0001291')
  assert.match(markup, /data-chart-price="pool">0\.0001291<\/p>/)
  assert.match(markup, /<span class="dm-delta dm-delta--md" data-sign="0" data-variant="text"><span class="dm-delta-arrow" aria-hidden="true"><\/span>0\.00%<\/span>/)
})

// 2026-09-27 (round 6, finishing the pool page): nothing half-configured under an empty chart. With nothing drawn in the
// page's own direction there is nothing to flip, so the "Price of" switch is not shown; while the chart is read it holds
// its place, and once a person has flipped it, it stays, so the way back is always there.
test('the price switch shows only while the chart is read, once a line is drawn, or once the chart was flipped', () => {
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server'), ts = require('typescript')
  const { areaUnder, curveFor, linePath } = require('../.test-build/app/src/lib/chart/paths.js'), { percentChange } = require('../.test-build/app/src/lib/format/change.js')
  const { timeTicks } = require('../.test-build/app/src/lib/chart/scale.js'), { axisLabel } = require('../.test-build/app/src/lib/format/time.js')
  const code = ts.transpileModule(readFileSync(new URL('../src/components/read/screens/PoolHistoryChart.tsx', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const option = { key: poolId, currencies: [{ address: currency, symbol: 'BASE' }, { address: quote, symbol: 'QUOTE' }] }
  const draw = (side, answer) => {
    const values = [side, 'day', answer, null]
    let index = 0
    const hooks = { useState: () => [values[index++], () => {}], useEffect() {}, useId: () => 'test' }
    const mod = { exports: {} }, dependencies = { watchPublicHistory() {}, useLoadMilestone() {}, ratioGeometry, ratioText, ratioCandleText, areaUnder, curveFor, linePath, percentChange, timeTicks, axisLabel, plainClose: require('../.test-build/app/src/lib/read/marketPrice.js').plainClose, useNow: () => ({ wall: 86400000 }),
      Segmented: ({ label }) => React.createElement('span', { 'data-switch': label }), Skeleton: () => null, PoolPriceChart: () => null, daySpan: () => null,
      PoolTokenLabel: ({ token }) => React.createElement('span', null, token.symbol) }
    new Function('require', 'module', 'exports', code)(name => name === 'react' ? hooks : name === 'react/jsx-runtime' ? require(name) : dependencies, mod, mod.exports)
    return renderToStaticMarkup(mod.exports.PoolHistoryChart({ source: {}, option, market: null, loading: false }))
  }
  const keyOf = (side) => `${poolId}:${side === 'zero' ? currency : quote}:day`
  const failed = (side) => ({ key: keyOf(side), state: 'answer', data: null, failed: true })
  const empty = draw('zero', failed('zero'))
  // changed on purpose 2026-10-15 (pack 7, owner: no status notices): the dash, no longer "Price history is temporarily unavailable."
  assert.doesNotMatch(empty, /temporarily unavailable/)
  assert.match(empty, /<div class="dm-pool-plot dm-pool-plot-empty"><span class="text-fg-subtle">—<\/span><\/div>/)
  assert.doesNotMatch(empty, /data-switch="Price of"/, 'no switch under an empty chart')
  assert.match(empty, /data-switch="History window"/, 'the window switch stays: another window may have prices')
  assert.match(draw('one', failed('one')), /data-switch="Price of"/, 'flipped, the way back stays')
  assert.match(draw('zero', null), /data-switch="Price of"/, 'while read, it holds its place')
  assert.match(draw('zero', { key: keyOf('zero'), state: 'answer', data: history(), failed: false }), /data-switch="Price of"/, 'with a line drawn')
})

// Added 2026-10-31 (QA round 2 follow-ups, Q24 and R37): the "Price of" switch lists the two tokens in the order it is
// handed them, the priced one first, so the pool page and the figures sheet, which both hand them in the order the pool's
// name is written (PoolWorkspace, PoolFiguresDialog), read "PRIORS | USDG" under "PRIORS / USDG"; and the slider's
// accessible name says the step it takes, a day on 30d, an hour otherwise.
test('the price switch puts the priced token first, and the slider says whether it steps by hour or by day', () => {
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server'), ts = require('typescript')
  const { areaUnder, curveFor, linePath } = require('../.test-build/app/src/lib/chart/paths.js'), { percentChange } = require('../.test-build/app/src/lib/format/change.js')
  const { timeTicks } = require('../.test-build/app/src/lib/chart/scale.js'), { axisLabel } = require('../.test-build/app/src/lib/format/time.js')
  const code = ts.transpileModule(readFileSync(new URL('../src/components/read/screens/PoolHistoryChart.tsx', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const draw = ({ currencies, quote: quoteIndex, side, window = 'day', answer = null }) => {
    const values = [side, window, answer, null]
    let index = 0
    const hooks = { useState: () => [values[index++], () => {}], useEffect() {}, useId: () => 'test' }
    const mod = { exports: {} }, dependencies = { watchPublicHistory() {}, useLoadMilestone() {}, ratioGeometry, ratioText, ratioCandleText, areaUnder, curveFor, linePath, percentChange, timeTicks, axisLabel, plainClose: require('../.test-build/app/src/lib/read/marketPrice.js').plainClose, useNow: () => ({ wall: 2592000000 }),
      Segmented: ({ label, items, value }) => React.createElement('span', { 'data-switch': label, 'data-value': value }, items.map((item) => React.createElement('b', { key: item.key, 'data-key': item.key }, item.label))),
      Skeleton: () => null, PoolPriceChart: () => null, daySpan: () => null,
      PoolTokenLabel: ({ token }) => React.createElement('span', null, token.symbol) }
    new Function('require', 'module', 'exports', code)(name => name === 'react' ? hooks : name === 'react/jsx-runtime' ? require(name) : dependencies, mod, mod.exports)
    return renderToStaticMarkup(mod.exports.PoolHistoryChart({ source: {}, option: { key: poolId, currencies }, market: null, loading: false, quote: quoteIndex }))
  }
  const priceOf = (markup) => [...markup.slice(markup.indexOf('data-switch="Price of"')).matchAll(/<b data-key="(\w+)"><span>(\w+)<\/span><\/b>/g)].map(([, key, symbol]) => `${key}:${symbol}`)
  // PRIORS/USDG as the pool page hands it (base, then quote, whatever the pool's own order): PRIORS first, and chosen.
  const named = [{ address: currency, symbol: 'PRIORS' }, { address: quote, symbol: 'USDG' }]
  assert.deepEqual(priceOf(draw({ currencies: named, quote: 1, side: 'zero' })), ['zero:PRIORS', 'one:USDG'])
  assert.match(draw({ currencies: named, quote: 1, side: 'zero' }), /data-switch="Price of" data-value="zero"/, 'the priced token is the one chosen')
  // Flipped, the order stays: the way back is where it was.
  assert.deepEqual(priceOf(draw({ currencies: named, quote: 1, side: 'one' })), ['zero:PRIORS', 'one:USDG'])

  const drawn = (window, resolutionSeconds) => {
    const span = window === 'month' ? 2592000 : 86400
    const data = history({ status: 'complete', reason: null, gaps: [], requestedWindow: { startTimestamp: 0, endTimestamp: span }, covered: [{ startTimestamp: 0, endTimestamp: span }],
      resolutionSeconds, snapshot: { number: 100, hash: '0x' + 'b'.repeat(64), timestamp: span }, candles: [candle(0, '1'), candle(resolutionSeconds, '2'), candle(2 * resolutionSeconds, '3')] })
    return draw({ currencies: named, quote: 1, side: 'zero', window, answer: { key: `${poolId}:${currency}:${window}`, state: 'answer', data, failed: false } })
  }
  assert.match(drawn('day', 3600), /role="slider" aria-label="Inspect the pool’s price by hour"/)
  assert.match(drawn('week', 3600), /aria-label="Inspect the pool’s price by hour"/)
  assert.match(drawn('month', 86400), /role="slider" aria-label="Inspect the pool’s price by day"/, '30d steps a day at a time')
  assert.doesNotMatch(drawn('month', 86400), /by hour/)
})

// The popup shares the pool page's reader and address-based denomination; a live row replaces the opened snapshot.
function figuresRenderer() {
  const React = require('react'), ts = require('typescript')
  const { renderToStaticMarkup } = require('react-dom/server')
  const markets = require('../.test-build/app/src/lib/markets.js')
  const orientation = require('../.test-build/app/src/lib/read/orientation.js')
  const identity = require('../.test-build/app/src/lib/read/screens/identity.js')
  const presentation = require('../.test-build/app/src/lib/read/poolAprPresentation.js')
  const describe = require('../.test-build/app/src/lib/read/describe.js')
  const figures = require('../.test-build/app/src/lib/read/screens/figures.js')
  const transpile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const load = (code, dependencies) => {
    const mod = { exports: {} }
    new Function('require', 'module', 'exports', code)(name => name === 'react/jsx-runtime' ? require(name) : dependencies, mod, mod.exports)
    return mod.exports
  }
  const components = load(transpile('../src/components/explore/MetricCell.tsx'), { ...markets, ...describe, ...figures,
    cx: (...classes) => classes.filter(Boolean).join(' '), Skeleton: () => null })
  let live = null, chart = null, source = {}
  const dependencies = { ...markets, ...orientation, ...identity, ...presentation, ...components,
    useEffect() {}, useRef: () => ({ current: null }), useDialog: () => null,
    useNow: () => ({ wall: 1_000_000 }), useReadSource: () => source, useFeatured: () => ({ entries: [] }),
    useMarkets: () => ({ state: { result: { markets: live ? [live] : [] } } }), shownResult: state => state.result,
    useFallbackRows: rows => rows, TokenLabel: ({ token }) => React.createElement('span', null, token.symbol),
    TokenMarkPair: () => null, IconClose: () => null,
    FigureDash: ({ reason }) => React.createElement('span', { title: reason }, '—'),
    IconButton: ({ label, onClick }) => React.createElement('button', { 'aria-label': label, onClick }),
    Skeleton: () => null, PoolAprEstimate: () => React.createElement('span', null, '—'), FallbackApr: () => null,
    PoolHistoryChart: props => (chart = props, React.createElement('section', { 'data-shared-history': '' }, 'Price history')),
    // 2026-10-30 (QA round 2): the fee as every chip writes it and what it is (Q28), and the network's name (Q23).
    ...require('../.test-build/app/src/lib/networkName.js'), FEE_VENUE: 'Uniswap', feeWords: (fee) => `${fee} fee`, FEE_MEANING: 'What the fee is.' }
  const module = load(transpile('../src/components/read/screens/PoolFiguresDialog.tsx'), dependencies)
  return { ...module, render(opened, current = null, readSource = {}, action = undefined) {
    live = current; source = readSource; chart = null
    const markup = renderToStaticMarkup(module.PoolFiguresDialog({ market: opened, onClose() {}, action }))
    return { markup, chart }
  } }
}
const figuresMarket = (extra = {}) => ({ key: `4663:${poolId}`, poolId, feePips: 3000,
  tokens: { base: { address: currency, symbol: 'BASE' }, quote: { address: quote, symbol: 'QUOTE' } },
  tvlUsd: { state: 'qualified', value: '10' }, volume24hUsd: { state: 'qualified', value: '20' },
  feeAprPercent: { state: 'qualified', value: '158' }, ...extra })

test('the compact figures popup uses the live selected row and opens the shared history outside Details', () => {
  const screen = figuresRenderer(), opened = figuresMarket()
  const source = { kind: 'local-shared' }
  const current = figuresMarket({ tvlUsd: { state: 'qualified', value: '80' }, feeAprPercent: { state: 'qualified', value: '200' } })
  const { markup, chart } = screen.render(opened, current, source)
  assert.match(markup, /200%/)
  assert.match(markup, /\$80\.00/)
  assert.doesNotMatch(markup, /158%|\$10\.00|The same figures shown|Complete 24h pool history|Provider figures|Pool figures and sources/)
  assert.doesNotMatch(markup, new RegExp(poolId))
  assert.equal(chart.source, source)
  assert.equal(chart.option.key, poolId)
  assert.deepEqual(chart.option.currencies.map(token => token.address), [currency, quote])
  assert.equal(chart.compact, true)
  assert.ok(markup.indexOf('data-shared-history') < markup.indexOf('<details'), 'the chart is visible on open')
  assert.match(markup, /<summary tabindex="0">Details<\/summary>/, 'Details participates in the dialog focus trap')
  assert.equal(chart.market, current, 'the chart receives the live market rather than the opening snapshot')
  // Added 2026-10-30 (QA round 2, Q19): the caller's way onward ends the sheet, after Details; none without one.
  assert.doesNotMatch(markup, /dm-pool-figures-foot/)
  const opened2 = screen.render(opened, current, source, require('react').createElement('a', { 'data-pool-figures-open': '' }, 'Open pool')).markup
  assert.match(opened2, /<\/details><div class="dm-pool-figures-foot"><a data-pool-figures-open="">Open pool<\/a><\/div>/)
})

// Added 2026-10-30 (QA round 2, final review read-1, Q28): Details says what the pool fee is in words, under the fee, where
// a tap and the keyboard reach it (the header's hover title reaches neither).
test('the popup’s Details say what the pool fee is in words, under the fee', () => {
  const { markup } = figuresRenderer().render(figuresMarket())
  assert.match(markup, /<div><dt>Pool fee<\/dt><dd>0\.30%<\/dd><dd class="dm-pool-figures-fact-note" data-fee-meaning="">What the fee is\.<\/dd><\/div>/)
  assert.ok(markup.indexOf('data-fee-meaning') > markup.indexOf('<details'), 'inside the collapsed Details, never on the sheet’s face')
})

test('the popup keeps missing, pending and observed zero figures distinct', () => {
  const screen = figuresRenderer()
  const missing = figuresMarket({ tvlUsd: { state: 'unavailable', value: '99', reason: 'not_observed' },
    volume24hUsd: { state: 'absent', value: null }, feeAprPercent: { state: 'unavailable', value: null } })
  const unavailable = screen.render(missing).markup
  // changed on purpose 2026-10-15 (pack 7, owner: no status notices): missing figures are dashes, their state as data,
  // never "Unavailable" or "Not reported".
  assert.match(unavailable, /data-metric="unavailable">—</)
  assert.match(unavailable, /data-metric="absent">—</)
  assert.doesNotMatch(unavailable, /Unavailable|Not reported/)
  assert.doesNotMatch(unavailable, /\$99|\$0\.00|158%/)
  const pending = screen.render({ ...missing, figuresPending: true }).markup
  assert.match(pending, /TVL loading/)
  assert.match(pending, /Estimated APR loading/)
  const zero = screen.render(figuresMarket({ tvlUsd: { state: 'qualified', value: '0' }, volume24hUsd: { state: 'qualified', value: '0' } })).markup
  assert.equal((zero.match(/\$0\.00/g) ?? []).length, 2)
  assert.doesNotMatch(zero, /Unavailable/)
})

test('popup history preserves the pool page denomination by address and refuses a missing pool identity', () => {
  const screen = figuresRenderer(), { USDG } = require('../.test-build/app/src/config/mainTokens.js')
  const stableFirst = figuresMarket({ tokens: { base: { address: USDG.toUpperCase().replace('0X', '0x'), symbol: 'untrusted' }, quote: { address: currency, symbol: 'USDG' } } })
  assert.deepEqual(screen.figuresHistoryOption(stableFirst).currencies.map(token => token.address), [currency, USDG])
  assert.equal(screen.figuresHistoryOption(figuresMarket({ poolId: 'not-a-pool' })), null)
  assert.equal(screen.figuresHistoryOption(figuresMarket({ tokens: { base: { address: 'not-an-address' }, quote: { address: quote } } })), null)
  assert.equal(screen.figuresHistoryOption(figuresMarket({ tokens: { base: { address: currency }, quote: { address: currency.toUpperCase() } } })), null)
})
