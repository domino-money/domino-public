/**
 * The Markets cards (added 2026-09-24): what a card draws (lib/read/cardSeries.ts),
 * how a card asks (lib/read/cardReads.ts), and what the card itself shows for
 * each series (components/markets/MarketCard.tsx, transpiled over stubs). The
 * owner's report: none of the six cards showed its chart, and some took very
 * long. Every card now ends on a line, bars or its 24h figure, never an empty
 * frame, and waits only for its first answer.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const built = (name) => require(`../.test-build/app/src/lib/read/${name}.js`)
const { pickSeries, cardAsk, inAskOrder, mergeAnswer, providerAgain, keptWaitMs, createCardCache, FIRST_TALLY, PROVIDER_REASKS, CHAIN_KEEP_MS, CARD_PLOT, CARD_LINE_PAD } = built('cardSeries')
const { watchCard, cardMode, followCardMode, CARD_MODE_RECHECK_MS } = built('cardReads')
const { carriedHistory } = built('chart')
const { ratioGeometry } = built('ratioSeries')
const flush = () => new Promise((done) => setImmediate(done))

const addr = (c) => `0x${c.repeat(40)}`
const POOL = `0x${'a'.repeat(64)}`
/** The hour the window ends on, in seconds, and this test's wall clock just after it. */
const END = 1_790_110_800
const NOW = { wall: END * 1000 + 30_000, monotonic: 50_000 }
const token = (c, symbol) => ({ origin: 'read', chainId: 4663, address: addr(c), symbol, decimals: 18, readStatus: 'available', artwork: null })
const volume = { value: '1234.5', state: 'provider', source: 'geckoterminal' }
const market = (extra = {}) => ({
  key: `4663:${POOL}`, poolId: POOL, base: 'AAA', quote: 'BBB', tokens: { base: token('1', 'AAA'), quote: token('2', 'BBB') }, feePips: 3000, protocol: 'v4',
  tvlUsd: volume, volume24hUsd: volume, feeAprPercent: { value: null, state: 'unavailable', reason: 'x' },
  // The provider's orientation is the other way round, as on the live WETH/USDG pool: its quote is the pool's currency0.
  chartTokens: { base: addr('2'), quote: addr('1') },
  poolState: { sqrtPriceX96: '79228162514264337593543950336', tick: 0, tickSpacing: 60, block: 1, currency0: addr('1'), currency1: addr('2') },
  ...extra,
})
const ratioCandle = (hoursBefore, close, complete = true) => ({ startTimestamp: END - hoursBefore * 3600, open: close, high: close, low: close, close, swapCount: 3, complete })
const history = (extra = {}) => ({
  schemaVersion: 1, chainId: 4663, poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951', poolId: POOL, currency: addr('1'), quoteCurrency: addr('2'),
  source: 'robinhood_pool_swap_logs', methodology: 'pool_ratio_v1', unit: 'quote_per_base', status: 'available', reason: null,
  requestedWindow: { startTimestamp: END - 86400, endTimestamp: END }, resolutionSeconds: 3600, snapshot: { number: 9, hash: `0x${'b'.repeat(64)}`, timestamp: END },
  covered: [{ startTimestamp: END - 86400, endTimestamp: END }], gaps: [],
  candles: [ratioCandle(3, '2689.5'), ratioCandle(2, '2701.25'), ratioCandle(1, '2695', false)], acquisitionAccepted: true, executionAvailable: false, ...extra,
})
const KEY = `chain:${POOL}:${addr('1')}:3600`
const chain = (data = history(), extra = {}) => ({ source: 'chain', key: KEY, data, receivedAt: END * 1000, failure: null, code: null, ...extra })
const usdCandle = (hoursBefore, volumeUsd) => ({ startTimestamp: END - hoursBefore * 3600, openUsd: '1', highUsd: '1', lowUsd: '1', closeUsd: '1', volumeUsd, closed: hoursBefore > 1 })
/** A read-v1 pool-market answer, only the fields the card reads, with its history as the provider oriented it. */
const poolMarket = (priceHistory) => ({ poolId: POOL, market: { data: { baseToken: addr('2'), quoteToken: addr('1') } }, priceHistory })
const available = (extra = {}) => ({
  status: 'available', reason: null,
  cache: { status: 'hit', ageSeconds: 5, freshForSeconds: 60, maxStaleSeconds: 300, scope: 'process_local', providerUpdateTimeKnown: false },
  data: { selectedToken: 'quote', currency: addr('1'), baseToken: addr('2'), quoteToken: addr('1'), intervalSeconds: 3600, candles: [usdCandle(3, '10'), usdCandle(2, '20')], coverage: { returnedCandles: 2 } },
  ...extra,
})
const refused = (reason) => ({ status: 'unavailable', reason, data: null, cache: null })
const PROVIDER_KEY = `provider:${POOL}:${addr('1')}:3600`
const provider = (priceHistory, extra = {}) => ({ source: 'provider', key: PROVIDER_KEY, side: 'quote', data: poolMarket(priceHistory), receivedAt: NOW.wall - 1000, receivedMonotonic: NOW.monotonic - 1000, failure: null, code: null, ...extra })
const pick = (input) => pickSeries({ market: market(), settled: true, answer: undefined, expecting: false, now: NOW, ...input })

test('a card asks for the pool’s own ratio by its first currency, or for the provider side the pool page asks for', () => {
  assert.deepEqual(cardAsk(market(), 'chain'), { key: KEY, poolId: POOL, source: 'chain', currency: addr('1'), side: 'quote' })
  assert.deepEqual(cardAsk(market(), 'provider'), { key: PROVIDER_KEY, poolId: POOL, source: 'provider', currency: addr('1'), side: 'quote' })
  // The chain needs no provider orientation at all: a row the provider could not describe still gets a line.
  assert.equal(cardAsk(market({ chartTokens: undefined }), 'chain').currency, addr('1'))
  assert.equal(cardAsk(market({ chartTokens: undefined }), 'provider'), null)
  assert.deepEqual(inAskOrder(['a', 'b', 'c', 'd'].map((poolId) => ({ poolId })), new Set(['c', 'b'])).map((ask) => ask.poolId), ['b', 'c', 'a', 'd'], 'in view first, each group in rail order')
})

test('a card draws, in order: candles its row carried, the chain line, provider bars, and otherwise its 24h figure', () => {
  const carried = carriedHistory(poolMarket(available()), { receivedAt: NOW.wall - 1000 })
  assert.ok(carried, 'a stored answer carrying candles bound to its own currencies')
  assert.equal(pick({ market: market({ providerHistory: carried }), answer: chain() }).kind, 'bars', 'carried candles cost no read and come first')
  const expired = carriedHistory(poolMarket(available()), { receivedAt: NOW.wall - 600_000 })
  assert.equal(pick({ market: market({ providerHistory: expired }), answer: chain() }).kind, 'line', 'carried candles past the limit give way to the chain line')
  const line = pick({ answer: chain() })
  assert.equal(line.kind, 'line')
  assert.equal(line.base.address, addr('1')); assert.equal(line.quote.address, addr('2'))
  assert.equal(pick({ answer: provider(available()) }).kind, 'bars', 'the provider path, where history is not listed')
  const figure = pick({})
  assert.equal(figure.kind, 'figure')
  assert.equal(figure.metric, market().volume24hUsd, 'the row’s own 24h volume')
  assert.equal(pick({ expecting: true }).kind, 'waiting', 'waiting only while an answer is on its way')
  assert.equal(pick({ market: undefined, settled: false }).kind, 'waiting')
  const none = pick({ market: undefined, settled: true })
  assert.deepEqual([none.kind, none.metric, none.code], ['figure', null, 'no-figures'])
  // carriedHistory binds by address: candles whose currency is not the side they claim are not carried.
  assert.equal(carriedHistory(poolMarket(available({ data: { ...available().data, currency: addr('9') } })), { receivedAt: 0 }), null)
  assert.equal(carriedHistory(poolMarket({ status: 'not_requested', reason: null, data: null, cache: null }), { receivedAt: 0 }), null)
})

test('a chain answer for other currencies, not built yet, with fewer than two hours or over an hour old draws the 24h figure instead', () => {
  const code = (data, extra) => { const series = pick({ answer: chain(data, extra) }); return series.kind === 'figure' ? series.code : series.kind }
  assert.equal(code(history({ currency: addr('3') })), 'mismatch')
  assert.equal(code(history({ quoteCurrency: addr('3') })), 'mismatch')
  assert.equal(code(history({ poolId: `0x${'c'.repeat(64)}` })), 'mismatch')
  assert.equal(code(history({ status: 'not_built', reason: 'history_acquisition_pending', candles: [], snapshot: null })), 'not_built')
  assert.equal(code(history({ status: 'unavailable', candles: [] })), 'unavailable')
  assert.equal(code(history({ candles: [ratioCandle(1, '2')] })), 'few-hours')
  assert.equal(code(history(), { receivedAt: NOW.wall - CHAIN_KEEP_MS - 1 }), 'expired')
  assert.equal(code(history({ candles: [ratioCandle(2, '0'), ratioCandle(1, '0')] })), 'unreadable')
  assert.equal(code(history({ status: 'partial', gaps: [{ startTimestamp: END - 86400, endTimestamp: END - 7200 }] })), 'line', 'a partial window with two hours is drawn')
  assert.equal(code(history({ quoteCurrency: null })), 'line', 'a quote not yet known is not a mismatch')
  const failed = pick({ answer: { ...chain(), data: null, failure: 'Unavailable. No response', code: 'offline' } })
  assert.deepEqual([failed.kind, failed.code], ['figure', 'offline'])
  assert.match(failed.title, /^Price chart unavailable: Unavailable\. No response\.$/)
})

test('a line is stale by its own snapshot age or a failed refresh, and says so in its title only; no token text reaches a title', () => {
  const fresh = pick({ answer: chain() })
  assert.equal(fresh.stale, false)
  assert.doesNotMatch(fresh.title, /stale/i)
  const old = pick({ answer: chain(history({ snapshot: { number: 9, hash: `0x${'b'.repeat(64)}`, timestamp: END - 600 } })) })
  assert.equal(old.stale, true)
  assert.match(old.title, /Stale, not current\./)
  const kept = mergeAnswer(chain(), { ...chain(), data: null, failure: 'Unavailable. No response', code: 'offline' })
  assert.deepEqual(kept.data, history(), 'a failed refresh keeps the last good series')
  assert.equal(pick({ answer: kept }).stale, true)
  assert.equal(mergeAnswer(undefined, { ...chain(), data: null, failure: 'x', code: 'y' }).data, null)
  for (const series of [fresh, old]) assert.doesNotMatch(series.title, /AAA|BBB/, 'symbols are untrusted text: React text only, never an attribute')
  assert.match(pick({ answer: chain(history({ status: 'partial', gaps: [{ startTimestamp: END - 86400, endTimestamp: END - 7200 }] })) }).title, /Some hours are not collected yet\./)
})

test('provider bars keep the existing rules: bound to the side asked, dropped past the service’s limit, stale by age', () => {
  const other = pick({ answer: provider(available({ data: { ...available().data, selectedToken: 'base', currency: addr('2') } })) })
  assert.deepEqual([other.kind, other.code], ['figure', 'mismatch'])
  const late = pick({ answer: provider(available(), { receivedAt: NOW.wall - 400_000, receivedMonotonic: NOW.monotonic - 400_000 }) })
  assert.deepEqual([late.kind, late.code], ['figure', 'expired'])
  const aging = pick({ answer: provider(available(), { receivedMonotonic: NOW.monotonic - 90_000 }) })
  assert.equal(aging.kind, 'bars'); assert.equal(aging.stale, true)
  assert.match(aging.title, /Reported by a market data provider, retrieved 95 s ago\. Not reconciled by Domino\. Stale, not current\./)
  // USDG/MARLIN: the provider repeats an hour and the service refuses the series. The card shows its figure, never a bare dash.
  const marlin = pick({ answer: provider(refused('provider_unavailable')) })
  assert.deepEqual([marlin.kind, marlin.code, marlin.metric], ['figure', 'unavailable', volume])
  assert.equal(pick({ answer: provider({ status: 'not_requested', reason: null, data: null, cache: null }) }).code, 'not-requested')
})

test('a legacy card stops after two provider_unavailable answers and backs off capacity refusals, at most four times', () => {
  const ok = (priceHistory) => ({ state: 'ok', data: poolMarket(priceHistory) })
  let step = providerAgain(ok(refused('provider_unavailable')), FIRST_TALLY)
  assert.equal(step.delay, 60_000)
  step = providerAgain(ok(refused('provider_unavailable')), step.tally)
  assert.equal(step.delay, null, 'no third read after two provider_unavailable answers')
  const delays = []
  let tally = FIRST_TALLY
  for (let i = 0; i < 6; i++) {
    const next = providerAgain(ok(refused(i % 2 ? 'provider_rate_limited' : 'provider_capacity_busy')), tally)
    delays.push(next.delay); tally = next.tally
  }
  assert.deepEqual(delays, [60_000, 120_000, 240_000, 480_000, null, null], `doubling from a minute, ${PROVIDER_REASKS} re-asks at most`)
  assert.equal(providerAgain(ok(available()), FIRST_TALLY).delay, 295_000, 'drawn candles are asked again when they pass the limit')
  assert.equal(providerAgain(ok({ status: 'not_requested', reason: null, data: null, cache: null }), FIRST_TALLY).delay, null)
  assert.equal(providerAgain(ok(refused('provider_currency_or_pool_mismatch')), FIRST_TALLY).delay, null, 'an answer that will not change is final')
  assert.equal(providerAgain({ state: 'disabled', reason: 'route_not_enabled' }, FIRST_TALLY).delay, null)
  assert.equal(providerAgain({ state: 'busy', retryAfterSeconds: 90 }, FIRST_TALLY).delay, 90_000, 'never sooner than a busy service asked')
})

test('a card coming back keeps its answer’s rhythm, and one whose answer stands for the visit asks nothing more', () => {
  assert.equal(keptWaitMs(provider(available()), NOW), 294_000, 'drawn candles: until they pass the limit')
  assert.equal(keptWaitMs(provider(refused('provider_unavailable')), NOW), 59_000, 'a refusal that can pass: a minute from when it came')
  assert.equal(keptWaitMs(provider(refused('provider_currency_or_pool_mismatch')), NOW), null)
  assert.equal(keptWaitMs(provider({ status: 'not_requested', reason: null, data: null, cache: null }), NOW), null, 'the bridge fixture’s answer: final, never asked again on return')
  assert.equal(keptWaitMs(chain(), NOW), 30_000, 'a chain series keeps its minute')
  assert.equal(keptWaitMs(chain(history(), { receivedAt: NOW.wall - 600_000 }), NOW), 0, 'one kept from an earlier visit is asked for at once')
  const failed = { ...chain(), data: null, failure: 'Busy. Later', code: 'busy', receivedAt: NOW.wall - 10_000 }
  assert.equal(keptWaitMs({ ...failed, retryAfterMs: 60_000 }, NOW), 50_000, 'a failure that can pass: its own wait from when it came')
  // Changed 2026-09-24 (review): a failure that named no wait, a final one too, is asked again a minute on, never kept for the document.
  assert.equal(keptWaitMs(failed, NOW), 50_000, 'a failure that named no wait: a minute from when it came')
})

// Review of 2026-09-24: mergeAnswer kept the series' own time and dropped the failure's, so a card that came back five
// seconds after a busy refresh read at once, into a service that had asked for time, on every return.
test('a failed refresh over a kept series carries its own time and wait, and a card coming back waits it out', () => {
  const good = chain(history(), { receivedAt: NOW.wall - 65_000, receivedMonotonic: NOW.monotonic - 65_000 })
  const busy = { ...chain(), data: null, failure: 'Busy. Later', code: 'busy', receivedAt: NOW.wall - 4_000, receivedMonotonic: NOW.monotonic - 4_000, retryAfterMs: 60_000 }
  const merged = mergeAnswer(good, busy)
  assert.deepEqual(merged.data, history(), 'the series stays')
  assert.deepEqual([merged.receivedAt, merged.receivedMonotonic], [good.receivedAt, good.receivedMonotonic], 'still dated as it was read')
  assert.deepEqual([merged.failedAt, merged.failedMonotonic, merged.retryAfterMs, merged.code], [busy.receivedAt, busy.receivedMonotonic, 60_000, 'busy'], 'with the failure’s own time and wait')
  assert.equal(keptWaitMs(good, NOW), 0, 'the series alone would be asked for at once')
  assert.equal(keptWaitMs(merged, NOW), 56_000, 'the failure asked for a minute four seconds ago')
  // The failure's wait is measured from when it came, never from the series' time.
  assert.equal(keptWaitMs(merged, { wall: NOW.wall + 56_000, monotonic: NOW.monotonic + 56_000 }), 0)
  // A later failure replaces the earlier one's time and wait; a good answer clears both.
  const later = mergeAnswer(merged, { ...busy, receivedAt: NOW.wall, receivedMonotonic: NOW.monotonic, retryAfterMs: 90_000 })
  assert.deepEqual([later.failedAt, later.retryAfterMs], [NOW.wall, 90_000])
  const plain = mergeAnswer(later, { ...busy, receivedAt: NOW.wall, receivedMonotonic: undefined, retryAfterMs: undefined })
  assert.equal('failedMonotonic' in plain || 'retryAfterMs' in plain, false, 'nothing of an earlier failure is left behind')
  const fresh = mergeAnswer(later, chain())
  assert.equal(fresh.failure, null); assert.equal('failedAt' in fresh, false)
  // Provider candles past their limit are drawn as expired, and still wait out the refresh that failed.
  const candles = provider(available(), { receivedAt: NOW.wall - 400_000, receivedMonotonic: NOW.monotonic - 400_000 })
  const refused = mergeAnswer(candles, { ...candles, data: null, failure: 'Busy. Later', code: 'busy', receivedAt: NOW.wall - 10_000, receivedMonotonic: NOW.monotonic - 10_000, retryAfterMs: 120_000 })
  assert.equal(keptWaitMs(refused, NOW), 110_000)
  assert.equal(pick({ answer: refused }).code, 'expired')
})

function memoryStorage() {
  const items = new Map()
  return { items, getItem: (key) => items.get(key) ?? null, setItem: (key, value) => { items.set(key, String(value)) }, removeItem: (key) => { items.delete(key) } }
}

// Changed on purpose 2026-10-01 (the chain2 workstream, part B, audit item G10): a series is kept under a name that names
// its chain, domino-card-v2:4663:<series>; under domino-card:<series> before.
const STORED = 'domino-card-v2:4663:'

test('the tab keeps chain series across a reload, only as wall time, and never shows one past its limits as current', () => {
  const storage = memoryStorage()
  const first = createCardCache(() => storage)
  first.put(chain(history(), { receivedMonotonic: 12 }))
  first.put(provider(available()))
  first.put({ ...chain(), key: `${KEY}x`, data: null, failure: 'x', code: 'y' })
  assert.deepEqual([...storage.items.keys()], [`${STORED}${KEY}`], 'one chain series stored; provider answers and failures are not')
  assert.doesNotMatch(storage.items.get(`${STORED}${KEY}`), /receivedMonotonic/, 'another document’s monotonic clock means nothing')
  assert.equal(first.get(PROVIDER_KEY, NOW).source, 'provider', 'provider candles are kept in memory for the document')
  assert.equal(first.get(`${KEY}x`, NOW).code, 'y', 'and so is a failure, for a card that comes back')
  first.put({ ...chain(), data: null, failure: 'Busy. Later', code: 'busy' })
  assert.deepEqual([first.get(KEY, NOW).data, first.get(KEY, NOW).code], [history(), 'busy'], 'a failed refresh keeps the last good series in memory too')
  assert.doesNotMatch(storage.items.get(`${STORED}${KEY}`), /Busy/, 'failures never reach storage')
  const reloaded = createCardCache(() => storage)
  const revived = reloaded.get(KEY, NOW)
  assert.deepEqual(revived.data, history())
  assert.equal(revived.receivedAt, END * 1000)
  assert.equal(reloaded.get(PROVIDER_KEY, NOW), null)
  assert.equal(createCardCache(() => storage).get(KEY, { wall: END * 1000 + CHAIN_KEEP_MS + 1 }), null, 'past an hour it is gone')
  assert.equal(storage.items.size, 0, 'and removed')
  for (const text of ['{', JSON.stringify({ v: 1, source: 'chain', key: 'other', receivedAt: END * 1000, data: history() }), JSON.stringify({ v: 1, source: 'chain', key: KEY, receivedAt: END * 1000, data: { ...history(), candles: [{ close: 1 }] } })]) {
    for (const name of [`${STORED}${KEY}`, `domino-card:${KEY}`]) {
      storage.items.clear()
      storage.items.set(name, text)
      assert.equal(createCardCache(() => storage).get(KEY, NOW), null, 'anything not in the shape this page kept is dropped, under either name')
    }
  }
})

// 2026-10-01 (the chain2 workstream, part B, audit item G10): a series kept under the old name is Robinhood Chain's, and
// moves to its new name the first time a card asks for it, drawn the same.
test('a series kept under the name before moves to the chain’s name when it is first asked for, and is drawn the same', () => {
  assert.equal(built('cardSeries').STORED, STORED)
  assert.equal(built('cardSeries').LEGACY_STORED, 'domino-card:')
  const before = memoryStorage()
  createCardCache(() => before).put(chain(history()))
  const text = before.items.get(`${STORED}${KEY}`)
  const old = memoryStorage()
  old.items.set(`domino-card:${KEY}`, text)
  const revived = createCardCache(() => old).get(KEY, NOW)
  assert.deepEqual([revived.data, revived.receivedAt], [history(), END * 1000])
  assert.deepEqual([...old.items.keys()], [`${STORED}${KEY}`], 'moved: the old name is gone')
  assert.equal(old.items.get(`${STORED}${KEY}`), text, 'as it was')
  assert.equal(createCardCache(() => old).get(`chain:${'0x'.padEnd(66, '1')}:x:3600`, NOW), null, 'a series kept under neither name is none')
})

// Added 2026-09-27 (r6/marketsdata): the cards' memory is the browser's localStorage, so a new tab draws the six cards at
// once instead of waiting about 4 s behind the tab's read budget; a document's first kept series lets go of the old ones.
test('the cards’ memory is the browser’s, shared by its tabs, and old series are let go of so nothing piles up', () => {
  const source = readFileSync(new URL('../src/lib/read/cardSeries.ts', import.meta.url), 'utf8')
  assert.match(source, /export const CARD_CACHE = createCardCache\(\(\) => \(typeof localStorage === 'undefined' \? null : localStorage\)\)/)
  const items = new Map([
    ['domino-card:chain:old', JSON.stringify({ v: 1, receivedAt: NOW.wall - CHAIN_KEEP_MS - 1 })],
    ['domino-card:chain:recent', JSON.stringify({ v: 1, receivedAt: NOW.wall - 60_000 })],
    ['domino-card:chain:garbled', '{'],
    ['domino-markets:v1', '{'],
  ])
  const listed = { ...memoryStorage(), get length() { return items.size }, key: (index) => [...items.keys()][index] ?? null }
  Object.assign(listed, { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => { items.set(key, String(value)) }, removeItem: (key) => { items.delete(key) } })
  const cache = createCardCache(() => listed, () => NOW.wall)
  cache.put(chain())
  // Changed on purpose 2026-10-01 (part B, G10): the new series goes under its chain's name; the old names are swept alike.
  assert.deepEqual([...items.keys()].sort(), ['domino-card:chain:recent', `${STORED}${KEY}`, 'domino-markets:v1'].sort(), 'past an hour, or not this page’s, is let go; other keys are not touched')
  items.set('domino-card:chain:old', JSON.stringify({ v: 1, receivedAt: 0 }))
  cache.put(chain())
  assert.ok(items.has('domino-card:chain:old'), 'once a document')
})

test('storage that throws on every access, or is missing, costs nothing but the reload copy', () => {
  const boom = () => { throw new Error('SecurityError') }
  const caches = [
    createCardCache(boom),
    createCardCache(() => ({ getItem: boom, setItem: boom, removeItem: boom })),
    createCardCache(() => null),
  ]
  for (const cache of caches) {
    assert.equal(cache.get(KEY, NOW), null)
    assert.doesNotThrow(() => cache.put(chain()))
    assert.deepEqual(cache.get(KEY, NOW).data, history(), 'the memory copy carries on')
  }
})

// ---------------------------------------------------------------------------
// The reads
// ---------------------------------------------------------------------------

/** Virtual time: sleeps and timers fire only as the test advances. */
function virtualClock() {
  let t = 0
  const pending = []
  const later = (ms, fire) => { const row = { at: t + ms, fire, cancelled: false }; pending.push(row); return row }
  return {
    now: () => END * 1000 + t,
    monotonic: () => t,
    random: () => 0.5,
    timer: (ms, fire) => { const row = later(ms, fire); return () => { row.cancelled = true } },
    sleep: (ms, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'))
      const stop = () => { row.cancelled = true; reject(new Error('aborted')) }
      const row = later(ms, () => { signal?.removeEventListener('abort', stop); resolve() })
      signal?.addEventListener('abort', stop, { once: true })
    }),
    async advance(ms) {
      const end = t + ms
      for (;;) {
        await flush()
        const due = pending.filter((row) => !row.cancelled && row.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        due.cancelled = true
        t = due.at
        due.fire()
      }
      t = end
      await flush()
    },
  }
}
const okHistory = (data = history()) => ({ route: 'history', state: 'ok', data, provenance: { transport: 'bridge', contract: null, receivedAt: END * 1000, receivedMonotonic: 0, attempts: 1 } })
const okMarket = (priceHistory) => ({ route: 'pool-market', state: 'ok', data: poolMarket(priceHistory), provenance: { transport: 'bridge', contract: null, receivedAt: END * 1000, receivedMonotonic: 0, attempts: 1 } })
function fakeSource(answer) {
  const reads = []
  return { reads, transport: 'bridge', routeEnabled: async () => ({ state: 'enabled' }), read: async (route, request, options) => { reads.push({ route, request, options }); return answer(route, request, reads.length) } }
}
const emptyCache = () => createCardCache(() => null)

test('the page decides the cards’ series from the capabilities it already holds, and never reads to decide', async () => {
  const checked = []
  const listing = (check) => ({ transport: 'bridge', routeEnabled: async (route) => (checked.push(route), check), read: () => { throw new Error('no read to decide') } })
  const signal = new AbortController().signal
  assert.equal(await cardMode(listing({ state: 'enabled' }), signal), 'chain')
  assert.equal(await cardMode(listing({ state: 'not_enabled' }), signal), 'provider')
  assert.equal(await cardMode(listing({ state: 'failed', outcome: { state: 'gate_required' } }), signal), 'none')
  assert.equal(await cardMode({ transport: 'bridge', read: () => { throw new Error('no read') } }, signal), 'provider', 'a source without capabilities keeps the older read')
  assert.equal(await cardMode({ transport: 'bridge', routeEnabled: async () => { throw new Error('x') } }, signal), 'none')
  assert.deepEqual(checked, ['history', 'history', 'history'])
})

// Review of 2026-09-24: a passing failure of the read-v3 capabilities GET comes back as "not listed", and the rail used
// to decide once per mount, so every card stayed on the provider reads for the visit.
test('the cards’ series is asked again each minute the page can be seen while it says provider, and stands once it says chain', async () => {
  const clock = virtualClock(), controller = new AbortController(), modes = []
  const answers = [{ state: 'not_enabled' }, { state: 'not_enabled' }, { state: 'enabled' }]
  const checked = []
  const listeners = new Set()
  const page = { hidden: false, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) }
  const source = { transport: 'bridge', routeEnabled: async (route) => (checked.push([route, clock.monotonic()]), answers.shift() ?? { state: 'enabled' }), read: () => { throw new Error('no read to decide') } }
  const running = followCardMode(source, (mode) => modes.push([mode, clock.monotonic()]), { signal: controller.signal, clock, page })
  await clock.advance(0)
  assert.deepEqual(modes, [['provider', 0]], 'decided at once')
  await clock.advance(CARD_MODE_RECHECK_MS - 1)
  assert.equal(checked.length, 1)
  await clock.advance(1)
  assert.deepEqual(checked.map(([, at]) => at), [0, 60_000], 'asked again a minute on')
  assert.deepEqual(modes, [['provider', 0]], 'the same answer is not handed on again')
  page.hidden = true
  await clock.advance(120_000)
  assert.equal(checked.length, 2, 'a hidden page asks nothing')
  page.hidden = false; for (const fn of [...listeners]) fn()
  await clock.advance(0)
  assert.deepEqual(modes, [['provider', 0], ['chain', 180_000]], 'history is listed again: the cards move to the chain line')
  await clock.advance(3_600_000)
  assert.equal(checked.length, 3, 'a chain decision stands')
  await running

  // `none` is the site's access check, and a source with no capabilities never changes: neither is asked again.
  for (const other of [
    { transport: 'bridge', routeEnabled: async () => (checked.push(['gate']), { state: 'failed', outcome: { state: 'gate_required' } }) },
    { transport: 'bridge', read: () => { throw new Error('no read') } },
  ]) {
    const seen = []
    const done = followCardMode(other, (mode) => seen.push(mode), { signal: new AbortController().signal, clock, page: null })
    await clock.advance(600_000)
    await done
    assert.equal(seen.length, 1)
  }
  assert.equal(checked.filter(([route]) => route === 'gate').length, 1)
  // Leaving the page ends the loop, its sleep included.
  const leaving = new AbortController(), heard = []
  const loop = followCardMode({ transport: 'bridge', routeEnabled: async () => ({ state: 'not_enabled' }) }, (mode) => heard.push(mode), { signal: leaving.signal, clock, page: null })
  await clock.advance(0)
  leaving.abort(); await loop
  await clock.advance(600_000)
  assert.deepEqual(heard, ['provider'])
})

// Added 2026-09-28 (speed wave, item 3): a check still failing in passing after publicSource.ts asked it again says so
// now, rather than "not listed". It decides nothing yet: the cards wait, it is asked again as transient.ts allows, and
// only a final answer is taken for `none`.
test('a capabilities check that failed in passing decides nothing: asked again quietly, and the cards move once it answers', async () => {
  const clock = virtualClock(), modes = [], checked = []
  const passing = { state: 'failed', outcome: { state: 'unavailable', cause: { kind: 'edge', status: 502 }, retryable: false } }
  const answers = [passing, passing, { state: 'enabled' }]
  const source = { transport: 'bridge', routeEnabled: async () => (checked.push(clock.monotonic()), answers.shift()), read: () => { throw new Error('no read to decide') } }
  const running = followCardMode(source, (mode) => modes.push([mode, clock.monotonic()]), { signal: new AbortController().signal, clock, page: null })
  await clock.advance(0)
  assert.deepEqual(modes, [], 'nothing decided on a passing failure')
  await clock.advance(30_000)
  assert.equal(checked.length, 3, 'asked again twice, about 4 s and 8 s on')
  assert.equal(modes.length, 1)
  assert.equal(modes[0][0], 'chain')
  await running
  // A failure asked again as often as transient.ts allows is taken for `none` at last.
  const always = { transport: 'bridge', routeEnabled: async () => passing, read: () => { throw new Error('no read') } }
  const seen = []
  const done = followCardMode(always, (mode) => seen.push(mode), { signal: new AbortController().signal, clock, page: null })
  await clock.advance(600_000)
  await done
  assert.deepEqual(seen, ['none'])
})

test('a chain card draws what the tab kept at once, reads its 24h hourly history, and asks again a minute after each answer', async () => {
  const clock = virtualClock(), controller = new AbortController(), answers = []
  const cache = emptyCache()
  cache.put(chain(history({ candles: [ratioCandle(5, '1'), ratioCandle(4, '2')] }), { receivedAt: END * 1000 - 60_000 }))
  const source = fakeSource(() => okHistory())
  const running = watchCard(source, cardAsk(market(), 'chain'), (answer) => answers.push(answer), { signal: controller.signal, clock, page: null, cache })
  assert.equal(answers.length, 0, 'nothing lands inside the caller’s own effect')
  await clock.advance(0)
  assert.equal(answers[0].data.candles.length, 2, 'the kept series first')
  assert.deepEqual(source.reads.map(({ route, request }) => ({ route, request })), [{ route: 'history', request: { poolId: POOL, currency: addr('1'), windowSeconds: 86400, resolutionSeconds: 3600 } }])
  assert.equal(answers[1].data.candles.length, 3, 'then its own answer')
  assert.equal(cache.get(KEY, NOW).data.candles.length, 3, 'which the tab keeps')
  await clock.advance(59_000)
  assert.equal(source.reads.length, 1)
  await clock.advance(1_000)
  assert.equal(source.reads.length, 2, 'a minute after an answer')
  controller.abort(); await running
  await clock.advance(600_000)
  assert.equal(source.reads.length, 2, 'nothing after the card is gone')
})

test('a chain card coming back within its minute draws what it had and reads when the minute is up', async () => {
  const clock = virtualClock(), controller = new AbortController(), answers = []
  const cache = emptyCache()
  cache.put(chain(history(), { receivedAt: END * 1000 - 20_000 }))
  const source = fakeSource(() => okHistory())
  const running = watchCard(source, cardAsk(market(), 'chain'), (answer) => answers.push(answer), { signal: controller.signal, clock, page: null, cache })
  await clock.advance(39_000)
  assert.equal(answers.length, 1, 'the kept line at once')
  assert.equal(source.reads.length, 0)
  await clock.advance(1_000)
  assert.equal(source.reads.length, 1)
  controller.abort(); await running
})

test('a chain card waits for a hidden page, and a failed read is asked again only as the shared rule allows', async () => {
  const clock = virtualClock(), controller = new AbortController(), answers = []
  const listeners = new Set()
  const page = { hidden: true, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) }
  const source = fakeSource((_route, _request, count) => (count === 1 ? { route: 'history', state: 'unavailable', cause: { kind: 'network' }, retryable: true, provenance: { receivedAt: 0, attempts: 1 } } : okHistory()))
  const running = watchCard(source, cardAsk(market(), 'chain'), (answer) => answers.push(answer), { signal: controller.signal, clock, page, cache: emptyCache() })
  await clock.advance(10_000)
  assert.equal(source.reads.length, 0, 'a hidden tab reads nothing')
  page.hidden = false; for (const fn of [...listeners]) fn()
  await clock.advance(0)
  assert.equal(source.reads.length, 1)
  assert.equal(answers[0].data, null); assert.equal(answers[0].code, 'unavailable')
  await clock.advance(6_000)
  assert.equal(source.reads.length, 2, 'a dropped connection is asked again after a few seconds')
  assert.equal(answers[1].data.status, 'available')
  controller.abort(); await running
})

test('a legacy card: no third provider read after two provider_unavailable answers, however long the page stays open', async () => {
  const clock = virtualClock(), controller = new AbortController(), answers = []
  const source = fakeSource(() => okMarket(refused('provider_unavailable')))
  const running = watchCard(source, cardAsk(market(), 'provider'), (answer) => answers.push(answer), { signal: controller.signal, clock, page: null, cache: emptyCache() })
  await clock.advance(0)
  assert.deepEqual(source.reads.map(({ route, request }) => ({ route, request })), [{ route: 'pool-market', request: { poolId: POOL, includePriceHistory: true, priceToken: 'quote' } }])
  await clock.advance(60_000)
  assert.equal(source.reads.length, 2)
  await running
  await clock.advance(3_600_000)
  assert.equal(source.reads.length, 2)
  assert.deepEqual(answers.map((answer) => pickSeries({ market: market(), settled: true, answer, expecting: false, now: NOW }).kind), ['figure', 'figure'])
  controller.abort()
})

test('a legacy card whose kept candles are still drawn waits for them to expire before it asks', async () => {
  const clock = virtualClock(), controller = new AbortController()
  const cache = emptyCache()
  cache.put(provider(available(), { receivedAt: END * 1000, receivedMonotonic: 0 }))
  const source = fakeSource(() => okMarket(available()))
  const running = watchCard(source, cardAsk(market(), 'provider'), () => {}, { signal: controller.signal, clock, page: null, cache })
  await clock.advance(294_000)
  assert.equal(source.reads.length, 0)
  await clock.advance(1_000)
  assert.equal(source.reads.length, 1)
  controller.abort(); await running
})

test('a chain card coming back after a failed refresh keeps the failure’s wait, not only the series’ minute', async () => {
  const clock = virtualClock(), controller = new AbortController(), answers = []
  const cache = emptyCache()
  // A good answer 65 s ago, then the minute refresh came back busy 4 s ago (at least a minute before asking again).
  cache.put(chain(history(), { receivedAt: END * 1000 - 65_000, receivedMonotonic: -65_000 }))
  cache.put({ ...chain(), data: null, failure: 'Busy. Later', code: 'busy', receivedAt: END * 1000 - 4_000, receivedMonotonic: -4_000, retryAfterMs: 60_000 })
  const source = fakeSource(() => okHistory())
  const running = watchCard(source, cardAsk(market(), 'chain'), (answer) => answers.push(answer), { signal: controller.signal, clock, page: null, cache })
  await clock.advance(55_999)
  assert.equal(answers[0].data.candles.length, 3, 'the kept line at once')
  assert.equal(pickSeries({ market: market(), settled: true, answer: answers[0], expecting: false, now: NOW }).stale, true, 'marked by its failed refresh')
  assert.equal(source.reads.length, 0, 'no read into a service that asked for time')
  await clock.advance(1)
  assert.equal(source.reads.length, 1)
  controller.abort(); await running
})

test('a legacy card coming back to expired candles and a failed refresh waits out the failure', async () => {
  const clock = virtualClock(), controller = new AbortController()
  const cache = emptyCache()
  cache.put(provider(available(), { receivedAt: END * 1000 - 400_000, receivedMonotonic: -400_000 }))
  cache.put({ source: 'provider', key: PROVIDER_KEY, side: 'quote', data: null, receivedAt: END * 1000 - 10_000, receivedMonotonic: -10_000, failure: 'Busy. Later', code: 'busy', retryAfterMs: 120_000 })
  const source = fakeSource(() => okMarket(available()))
  const running = watchCard(source, cardAsk(market(), 'provider'), () => {}, { signal: controller.signal, clock, page: null, cache })
  await clock.advance(109_999)
  assert.equal(source.reads.length, 0, 'the costly provider read is not sent at once')
  await clock.advance(1)
  assert.equal(source.reads.length, 1)
  controller.abort(); await running
})

test('a legacy card coming back to an answer that stands asks nothing: the bridge fixture’s refused history, or a refusal that cannot pass', async () => {
  for (const kept of [
    provider(refused('provider_currency_or_pool_mismatch'), { receivedAt: END * 1000, receivedMonotonic: 0 }),
    provider({ status: 'not_requested', reason: null, data: null, cache: null }, { receivedAt: END * 1000, receivedMonotonic: 0 }),
  ]) {
    const clock = virtualClock(), controller = new AbortController(), answers = []
    const cache = emptyCache()
    cache.put(kept)
    const source = fakeSource(() => okMarket(available()))
    await watchCard(source, cardAsk(market(), 'provider'), (answer) => answers.push(answer), { signal: controller.signal, clock, page: null, cache })
    await clock.advance(3_600_000)
    assert.equal(source.reads.length, 0)
    assert.equal(answers.length, 1, 'it shows what it had')
  }
})

// Review of 2026-09-24: a final failure (an edge 404 while a Worker route is redeployed, a producer refusal that is not
// retryable, an `invalid` reply during a runtime skew) was kept with no wait, so every later visit drew the 24h figure and
// asked nothing until a reload, long after the service had recovered.
test('a card whose read failed for good asks again on a later visit, a minute after the failure at the soonest', async () => {
  const finals = [
    { route: 'history', state: 'invalid', reason: 'identity_mismatch', provenance: { receivedAt: 0, attempts: 1 } },
    { route: 'history', state: 'unavailable', cause: { kind: 'edge', status: 404 }, retryable: false, provenance: { receivedAt: 0, attempts: 1 } },
    { route: 'history', state: 'unavailable', cause: { kind: 'producer', code: 'upstream_invalid_response', status: 503 }, retryable: false, provenance: { receivedAt: 0, attempts: 1 } },
  ]
  for (const final of finals) {
    const clock = virtualClock(), cache = emptyCache()
    const source = fakeSource((_route, _request, count) => (count === 1 ? final : okHistory()))
    const first = new AbortController(), seen = []
    const visit = watchCard(source, cardAsk(market(), 'chain'), (answer) => seen.push(answer), { signal: first.signal, clock, page: null, cache })
    await clock.advance(600_000)
    assert.equal(source.reads.length, 1, `${final.state}: not asked again in the same visit`)
    assert.equal(seen[0].data, null)
    assert.equal(seen[0].retryAfterMs, 60_000, `${final.state}: kept with a minute’s wait`)
    first.abort(); await visit
    // The person goes to a pool page and back ten minutes later: the card asks again, once.
    const second = new AbortController(), again = []
    const back = watchCard(source, cardAsk(market(), 'chain'), (answer) => again.push(answer), { signal: second.signal, clock, page: null, cache })
    await clock.advance(0)
    assert.equal(again[0].code, seen[0].code, 'the kept failure is drawn at once')
    assert.equal(source.reads.length, 2, `${final.state}: asked again once its minute is over`)
    assert.equal(pickSeries({ market: market(), settled: true, answer: again[1], expecting: false, now: { wall: clock.now(), monotonic: clock.monotonic() } }).kind, 'line', 'and the recovered service draws the line')
    second.abort(); await back
  }
})

test('a card coming back within a minute of a final failure waits out that minute, and a failure is kept an hour at most', async () => {
  const clock = virtualClock(), cache = emptyCache()
  const source = fakeSource((_route, _request, count) => (count === 1 ? { route: 'pool-market', state: 'invalid', reason: 'identity_mismatch', provenance: { receivedAt: 0, attempts: 1 } } : okMarket(available())))
  const first = new AbortController()
  await watchCard(source, cardAsk(market(), 'provider'), () => {}, { signal: first.signal, clock, page: null, cache })
  await clock.advance(3_600_000 - 1)
  assert.equal(source.reads.length, 1, 'a legacy card does not ask again in the same visit')
  assert.ok(cache.get(PROVIDER_KEY, { wall: clock.now(), monotonic: clock.monotonic() }), 'kept for an hour')
  await clock.advance(2)
  assert.equal(cache.get(PROVIDER_KEY, { wall: clock.now(), monotonic: clock.monotonic() }), null, 'and dropped after it')
  // One kept 30 s ago: the card coming back draws it and reads 30 s later, never at once.
  const recent = emptyCache()
  recent.put({ source: 'provider', key: PROVIDER_KEY, side: 'quote', data: null, receivedAt: clock.now() - 30_000, receivedMonotonic: clock.monotonic() - 30_000, failure: 'Wrong answer. x', code: 'invalid', retryAfterMs: 60_000 })
  const second = new AbortController()
  const back = watchCard(source, cardAsk(market(), 'provider'), () => {}, { signal: second.signal, clock, page: null, cache: recent })
  await clock.advance(29_999)
  assert.equal(source.reads.length, 1)
  await clock.advance(1)
  assert.equal(source.reads.length, 2)
  second.abort(); await back
})

test('the card line fits the card’s own plot', () => {
  const plot = ratioGeometry(history(), CARD_PLOT.width, CARD_PLOT.height, CARD_LINE_PAD)
  assert.equal(plot.points.length, 3)
  assert.ok(plot.points.every((point) => point.x >= CARD_LINE_PAD.left && point.x <= CARD_PLOT.width - CARD_LINE_PAD.right && point.y >= CARD_LINE_PAD.top && point.y <= CARD_PLOT.height - CARD_LINE_PAD.bottom))
  assert.equal(plot.paths.length, 2, 'the open hour is not joined to the closed ones')
})

// ---------------------------------------------------------------------------
// What the card shows
// ---------------------------------------------------------------------------

function cardModule() {
  const React = require('react'), ts = require('typescript')
  const code = ts.transpileModule(readFileSync(new URL('../src/components/markets/MarketCard.tsx', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const markets = require('../.test-build/app/src/lib/markets.js')
  const span = (name) => (props) => React.createElement('span', { 'data-stub': name, ...Object.fromEntries(Object.entries(props).filter(([key]) => key.startsWith('data-') || key === 'title')) })
  const dependencies = {
    ...markets, ...require('../.test-build/app/src/lib/read/cardSeries.js'), ...require('../.test-build/app/src/lib/read/decimal.js'), ...require('../.test-build/app/src/lib/read/ratioSeries.js'),
    // 2026-09-24 (V2 P2, R-4): the card's price row shows the window's change with percentChange (lib/format/change.ts).
    ...require('../.test-build/app/src/lib/format/change.js'),
    // 2026-09-25 (r3 charts): the caption's hour is lib/format/time.ts shortTime, as the tooltip's.
    ...require('../.test-build/app/src/lib/format/time.js'),
    // 2026-09-27 (r6/marketsdata): the card writes its closes as the table writes a price (marketPrice.ts plainClose).
    ...require('../.test-build/app/src/lib/read/marketPrice.js'),
    // 2026-10-01 (audit E21): the card names its pair as its price is written, and its fee as every chip writes it.
    ...require('../.test-build/app/src/lib/read/orientation.js'), ...require('../.test-build/app/src/lib/format/fee.js'),
    unreadToken: (address) => ({ address }), poolHref: (id) => `#/pool/${id}`,
    // 2026-09-25 (r3 charts): the stub also shows the tone the card gives its line, and whether it draws the level.
    PriceLineSvg: (props) => React.createElement('svg', { 'data-price-line': '', 'data-tone': props.tone, 'data-level': props.level ? '' : undefined, title: props.title }),
    VolumeBarsSvg: (props) => React.createElement('svg', { 'data-volume-bars': '', title: props.title }),
    MetricCell: ({ metric }) => React.createElement('span', { 'data-metric': metric.state }, `$${metric.value}`),
    FigureDash: ({ reason }) => React.createElement('span', { 'data-figure': 'none', title: reason }, '—'),
    PoolTokenLabel: ({ token }) => React.createElement('span', null, token.symbol),
    TokenIcon: span('icon'), TokenMark: span('mark'), TokenMarkPair: span('pair'),
  }
  const mod = { exports: {} }
  new Function('require', 'module', 'exports', code)((name) => (name === 'react' ? { useState: (initial) => [initial, () => {}] } : name === 'react/jsx-runtime' ? require(name) : dependencies), mod, mod.exports)
  return mod.exports.MarketCard
}

test('each series draws something in the plot: a line with its caption, the 24h figure, or only a baseline while waiting', () => {
  const { renderToStaticMarkup } = require('react-dom/server')
  const MarketCard = cardModule()
  const draw = (series, listing = { poolId: POOL, market: market() }) => renderToStaticMarkup(MarketCard({ listing, index: 0, now: NOW, series }))
  const line = draw(pickSeries({ market: market(), settled: true, answer: chain(), expecting: false, now: NOW }))
  assert.match(line, /data-price-line/)
  assert.match(line, /<p class="dm-mkt-card-caption"><span>Price · 24h<\/span><\/p>/)
  assert.match(line, /data-card-series="line"/)
  const figure = draw(pickSeries({ market: market(), settled: true, answer: chain(history({ status: 'not_built', candles: [], snapshot: null })), expecting: false, now: NOW }))
  assert.match(figure, /data-chart-unavailable="not_built"/)
  assert.match(figure, /class="dm-mkt-plot-figure"[^>]*><span data-metric="provider">\$1234\.5<\/span>/, 'the row’s 24h volume, large, in the plot')
  assert.match(figure, /<span>24h volume<\/span>/)
  assert.match(figure, /title="Price chart unavailable: this pool’s price history is still being collected\."/)
  const waiting = draw({ kind: 'waiting' })
  assert.match(waiting, /class="dm-mkt-baseline"/)
  assert.match(waiting, /<p class="dm-mkt-card-caption"><\/p>/, 'no words while waiting')
  const rowless = draw(pickSeries({ market: undefined, settled: true, answer: undefined, expecting: false, now: NOW }), { poolId: POOL })
  assert.match(rowless, /data-chart-unavailable="no-figures"[^>]*><span data-figure="none" title="24h volume unavailable">—<\/span>/)
  assert.doesNotMatch(rowless, /data-metric/, 'no figure before any answer')
  for (const markup of [line, figure, waiting, rowless]) assert.doesNotMatch(markup, /Reading|Retry|unavailable<\/|sample|practice/i)
})

// Added 2026-09-25 (r3 charts): the line's colour and the change badge tell the same story.
test('the line takes the direction of the change the card shows at rest, and no direction without one', () => {
  const { renderToStaticMarkup } = require('react-dom/server')
  const MarketCard = cardModule()
  const draw = (candles) => renderToStaticMarkup(MarketCard({ listing: { poolId: POOL, market: market() }, index: 0, now: NOW,
    series: pickSeries({ market: market(), settled: true, answer: chain(history({ candles })), expecting: false, now: NOW }) }))
  const down = draw([ratioCandle(24, '2701.25'), ratioCandle(2, '2695'), ratioCandle(1, '2689.5', false)])
  assert.match(down, /data-tone="down"/)
  assert.match(down, /data-level=""/, 'the dashed level of the first close, beside the change it measures')
  assert.match(down, /class="dm-delta dm-mkt-card-delta" data-sign="-1"/)
  const up = draw([ratioCandle(24, '2689.5'), ratioCandle(2, '2695'), ratioCandle(1, '2701.25', false)])
  assert.match(up, /data-tone="up"/)
  assert.match(up, /class="dm-delta dm-mkt-card-delta" data-sign="1"/)
  const level = draw([ratioCandle(24, '2695'), ratioCandle(1, '2695', false)])
  assert.match(level, /data-tone="flat"/)
  // The first hour does not open the window: no change is shown, and the line keeps the chart accent.
  const partial = draw([ratioCandle(3, '2689.5'), ratioCandle(2, '2701.25'), ratioCandle(1, '2695', false)])
  assert.doesNotMatch(partial, /data-tone=|dm-mkt-card-delta/)
  assert.doesNotMatch(partial, /data-level/, 'no level for a change the card does not show')
})

// Added 2026-09-27 (r6/marketsdata, the owner: prices plain for beginners wherever pools are listed): the card's price
// row writes its close as the table writes a price, whole units from 10,000 ("84,367", not "84,367.4").
test('the card writes its latest close as the table writes a price', () => {
  const { renderToStaticMarkup } = require('react-dom/server')
  const MarketCard = cardModule()
  const draw = (candles) => renderToStaticMarkup(MarketCard({ listing: { poolId: POOL, market: market() }, index: 0, now: NOW,
    series: pickSeries({ market: market(), settled: true, answer: chain(history({ candles })), expecting: false, now: NOW }) }))
  assert.match(draw([ratioCandle(24, '84100.9'), ratioCandle(1, '84367.4', false)]), /class="dm-mkt-card-close dm-fig-lg">84,367<\/span>/)
  assert.match(draw([ratioCandle(24, '2689.5'), ratioCandle(1, '2701.25', false)]), /class="dm-mkt-card-close dm-fig-lg">2,701.25<\/span>/)
  assert.match(draw([ratioCandle(24, '0.57'), ratioCandle(1, '0.573917', false)]), /class="dm-mkt-card-close dm-fig-lg">0.5739<\/span>/)
})
