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

test('rendered ratio chart names its denomination, real coverage and exact values', () => {
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server'), ts = require('typescript')
  const data = history(), key = `${poolId}:${currency}:day`
  const values = ['chain', 'zero', 'day', { key, state: 'answer', data, failed: false }, null]
  let index = 0
  const hooks = { useState: () => [values[index++], () => {}], useEffect() {}, useId: () => 'test' }
  const code = ts.transpileModule(readFileSync(new URL('../src/components/read/screens/PoolHistoryChart.tsx', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const mod = { exports: {} }, dependencies = { watchPublicHistory() {}, ratioGeometry, ratioText, ratioCandleText, useNow: () => ({ wall: 86400000 }),
    Segmented: () => null, Skeleton: () => null, PoolPriceChart: () => null,
    PoolTokenLabel: ({ token }) => React.createElement('span', null, token.symbol), Address: ({ value }) => React.createElement('span', null, value) }
  new Function('require', 'module', 'exports', code)(name => name === 'react' ? hooks : name === 'react/jsx-runtime' ? require(name) : dependencies, mod, mod.exports)
  const tree = mod.exports.PoolHistoryChart({ source: {}, option: { key: poolId, currencies: [{ address: currency, symbol: 'BASE' }, { address: quote, symbol: 'QUOTE' }] }, market: null, loading: false })
  const markup = renderToStaticMarkup(tree)
  assert.match(markup, /quote_per_base/)
  assert.match(markup, /QUOTE<\/span> per <span>BASE/)
  assert.match(markup, /Partial coverage/)
  assert.match(markup, /prices are never filled forward/)
  assert.match(markup, /role="slider"/)
  assert.match(markup, /close 3/)
})
