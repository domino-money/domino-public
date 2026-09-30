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
  const mod = { exports: {} }, dependencies = { watchPublicHistory() {}, useLoadMilestone() {}, ratioGeometry, ratioText, ratioCandleText, areaUnder, curveFor, linePath, percentChange, timeTicks, axisLabel, useNow: () => ({ wall: 86400000 }),
    Segmented: () => null, Skeleton: () => null, PoolPriceChart: () => null, daySpan: () => null,
    PoolTokenLabel: ({ token }) => React.createElement('span', null, token.symbol), Address: ({ value }) => React.createElement('span', null, value) }
  new Function('require', 'module', 'exports', code)(name => name === 'react' ? hooks : name === 'react/jsx-runtime' ? require(name) : dependencies, mod, mod.exports)
  const tree = mod.exports.PoolHistoryChart({ source: {}, option: { key: poolId, currencies: [{ address: currency, symbol: 'BASE' }, { address: quote, symbol: 'QUOTE' }] }, market: null, loading: false })
  const markup = renderToStaticMarkup(tree)
  assert.match(markup, /quote_per_base/)
  assert.match(markup, /QUOTE<\/span> for 1 <span>BASE/)
  assert.match(markup, /Some hours are missing: they are shaded\./)
  assert.match(markup, /Prices from swaps on Robinhood Chain\./)
  assert.match(markup, /role="slider"/)
  assert.match(markup, /close 3/)
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
    const mod = { exports: {} }, dependencies = { watchPublicHistory() {}, useLoadMilestone() {}, ratioGeometry, ratioText, ratioCandleText, areaUnder, curveFor, linePath, percentChange, timeTicks, axisLabel, useNow: () => ({ wall: 86400000 }),
      Segmented: ({ label }) => React.createElement('span', { 'data-switch': label }), Skeleton: () => null, PoolPriceChart: () => null, daySpan: () => null,
      PoolTokenLabel: ({ token }) => React.createElement('span', null, token.symbol) }
    new Function('require', 'module', 'exports', code)(name => name === 'react' ? hooks : name === 'react/jsx-runtime' ? require(name) : dependencies, mod, mod.exports)
    return renderToStaticMarkup(mod.exports.PoolHistoryChart({ source: {}, option, market: null, loading: false }))
  }
  const keyOf = (side) => `${poolId}:${side === 'zero' ? currency : quote}:day`
  const failed = (side) => ({ key: keyOf(side), state: 'answer', data: null, failed: true })
  const empty = draw('zero', failed('zero'))
  assert.match(empty, /Price history is temporarily unavailable\./)
  assert.doesNotMatch(empty, /data-switch="Price of"/, 'no switch under an empty chart')
  assert.match(empty, /data-switch="History window"/, 'the window switch stays: another window may have prices')
  assert.match(draw('one', failed('one')), /data-switch="Price of"/, 'flipped, the way back stays')
  assert.match(draw('zero', null), /data-switch="Price of"/, 'while read, it holds its place')
  assert.match(draw('zero', { key: keyOf('zero'), state: 'answer', data: history(), failed: false }), /data-switch="Price of"/, 'with a line drawn')
})
