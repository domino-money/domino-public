/**
 * What one Markets card draws, decided from real answers only, and this tab's
 * memory of those answers.
 *
 * A card draws the first of these it has: hourly USD candles its own row
 * already carried (a stored overview, once the collector keeps them; none do
 * yet), then the pool's own price over the last 24 hours from Robinhood Chain
 * swaps (read-v3 `history`, at least two hours of it), then hourly USD volume
 * from a read-v1 provider read (only where `history` is not listed), and
 * otherwise the row's own 24h volume figure. It waits only until its first
 * answer; no frame is ever left empty. Nothing here reads, sleeps or looks at
 * a clock: `now` is the caller's.
 */
import type { Candle, PoolMarketResponse } from 'api-contracts/read-v1/types'
import type { HistoryResponse } from 'api-contracts/read-v3/types'
import type { CarriedHistory, Instant, Market, Metric } from '../markets'
import { chartMatches } from './chart'
import { plainBase } from './marketPrice'
import { reasonText } from './describe'
import { volumeGeometry } from './priceSeries'
import { ratioGeometry, type RatioPad } from './ratioSeries'
import { transientWaitSeconds, type TransientCandidate } from './screens/transient'
import type { TokenDisplay } from './types'
import { ROBINHOOD_ID } from '../../config/chainIdentity'
import { chainKey, movedScoped } from '../chainStorage'
import { jittered } from '../jitter'

export type Side = 'base' | 'quote'
/** Which series a card asks for: the chain's stored ratio, or a provider's USD candles. */
export type CardSource = 'chain' | 'provider'

export const CARD_WINDOW_SECONDS = 86400
export const CARD_RESOLUTION_SECONDS = 3600
/** The card plot's own box, and the room its line keeps from the edges. */
export const CARD_PLOT = { width: 240, height: 96 } as const
export const CARD_LINE_PAD: RatioPad = { left: 4, right: 4, top: 8, bottom: 8 }
/** A stored series more than one of its hours old is no longer the last 24 hours, so it is not drawn. */
export const CHAIN_KEEP_MS = 3_600_000
/** The pool chart's rule: stored history whose snapshot is older than this is stale. */
const CHAIN_STALE_SECONDS = 120

/** What one card asks for. The key names the series: source, pool, currency and resolution. */
export interface CardAsk {
  key: string
  poolId: string
  source: CardSource
  /** Chain: the ratio's base currency. Provider: the token whose USD candles are asked for. */
  currency: string
  side: Side
}

interface Settled {
  key: string
  /** Wall ms when `data` arrived, or the failure did when there is no data. */
  receivedAt: number
  /** This document's monotonic ms for the same moment; never kept across documents. */
  receivedMonotonic?: number
  /** Why the latest read gave nothing to draw, for a title only; null when it answered. */
  failure: string | null
  /** The same, as a short code for a data attribute. */
  code: string | null
  /**
   * For a failure, how long after it a card coming back may ask again: the
   * wait it asked for, a minute at the least; FAILURE_WAIT_MS when absent.
   */
  retryAfterMs?: number
  /** For a series kept through a failed refresh: when that failure came, wall ms. */
  failedAt?: number
  /** The same moment on this document's monotonic clock. */
  failedMonotonic?: number
}

/** One card's latest settled read. `data` is its last good answer, kept through a failed refresh. */
export type CardAnswer =
  | (Settled & { source: 'chain'; data: HistoryResponse | null })
  | (Settled & { source: 'provider'; side: Side; data: PoolMarketResponse | null })

export type CardSeries =
  /** No answer yet: the plot shows only its baseline. */
  | { kind: 'waiting' }
  /** The pool's price over the last 24 hours, from its own swaps. */
  | { kind: 'line'; history: HistoryResponse; base: TokenDisplay; quote: TokenDisplay; stale: boolean; title: string }
  /** Hourly USD volume a market data provider reported. */
  | { kind: 'bars'; candles: readonly Candle[]; intervalSeconds: number; returned: number; stale: boolean; title: string }
  /**
   * The row's own 24h volume figure, or a dash without a row; `code` and `title` say why there is no chart, as data.
   * Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the card no longer draws `title` as a hover
   * title (MarketCard); it stays here for tests and diagnostics.
   */
  | { kind: 'figure'; metric: Metric | null; code: string; title: string }

const WAITING: CardSeries = { kind: 'waiting' }

/**
 * The token whose USD candles the pool page asks for, asked for the same way
 * here, so both send the identical read and share the read service's cache.
 */
export const chartSide = (market: Market): Side => (market.chartTokens?.quote === market.tokens.base.address ? 'quote' : 'base')

/** The pool's two currencies in the pool's own order, lowercase. */
function currencies(market: Market): [string, string] {
  const state = market.poolState
  return state ? [state.currency0, state.currency1] : [market.tokens.base.address.toLowerCase(), market.tokens.quote.address.toLowerCase()]
}

/** What a card with this row asks for from `source`, or null when there is nothing it can ask. */
export function cardAsk(market: Market, source: CardSource): CardAsk | null {
  const side = chartSide(market)
  const poolId = market.poolId.toLowerCase()
  let currency: string
  if (source === 'chain') {
    // The token the row's price is of, so the card's line and its figure read as the table's price does ("1 cbBTC =
    // 84,367 USDG", marketPrice.ts, 2026-09-27); without one, the same base the provider chart would use, which is the
    // pool's first currency whenever it is one of the pair.
    const pool = currencies(market)
    const chart = market.chartTokens?.[side]?.toLowerCase()
    currency = plainBase(market) ?? (chart !== undefined && pool.includes(chart) ? chart : pool[0])
  } else {
    if (!market.chartTokens) return null
    currency = market.chartTokens[side]
  }
  return { key: `${source}:${poolId}:${currency.toLowerCase()}:${CARD_RESOLUTION_SECONDS}`, poolId, source, currency, side }
}

/** Visible cards first, each group in rail order. */
export function inAskOrder<T extends { poolId: string }>(asks: readonly T[], visible: ReadonlySet<string>): T[] {
  return [...asks.filter((ask) => visible.has(ask.poolId)), ...asks.filter((ask) => !visible.has(ask.poolId))]
}

/**
 * A new answer over the last one: a failure keeps the last good series, now
 * marked by that failure, with the failure's own time and wait, so a card
 * coming back honours the failure as well as the series (keptWaitMs).
 */
export function mergeAnswer(prior: CardAnswer | undefined, next: CardAnswer): CardAnswer {
  if (next.data !== null || !prior || prior.data === null || prior.source !== next.source) return next
  const merged: CardAnswer = { ...prior, failure: next.failure, code: next.code, failedAt: next.receivedAt }
  delete merged.failedMonotonic
  delete merged.retryAfterMs
  if (next.receivedMonotonic !== undefined) merged.failedMonotonic = next.receivedMonotonic
  if (next.retryAfterMs !== undefined) merged.retryAfterMs = next.retryAfterMs
  return merged
}

const elapsedMs = (since: { receivedAt: number; receivedMonotonic?: number }, now: Instant) =>
  Math.max(0, since.receivedMonotonic !== undefined && now.monotonic !== undefined ? now.monotonic - since.receivedMonotonic : now.wall - since.receivedAt)

/**
 * The least wait after a failed read before a card coming back asks again.
 * Every failure has one, a final one too: an edge page during a redeploy, a
 * producer refusal or a runtime skew ends, and a card must not keep its 24h
 * figure for the rest of the document because of one.
 */
export const FAILURE_WAIT_MS = 60_000

/**
 * How much longer the failure an answer carries, alone or over a series it
 * kept, asks a card coming back to wait: its own wait from when it came, a
 * minute when it named none; 0 for an answer with no failure.
 */
function failureWaitMs(answer: CardAnswer, now: Instant): number {
  if (answer.failure === null && answer.data !== null) return 0
  const since = answer.data === null || answer.failedAt === undefined ? answer : { receivedAt: answer.failedAt, receivedMonotonic: answer.failedMonotonic }
  return Math.max(0, (answer.retryAfterMs ?? FAILURE_WAIT_MS) - elapsedMs(since, now))
}

/** Seconds since provider candles were retrieved: the age reported with them plus their time on this page. */
function providerAge(reported: number | null, received: { receivedAt: number; receivedMonotonic?: number }, now: Instant) {
  const onScreen = Math.floor(elapsedMs(received, now) / 1000)
  return reported === null ? { seconds: onScreen, known: false } : { seconds: reported + onScreen, known: true }
}

/**
 * Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the basis only. Dropped: the retrieval time
 * (", retrieved N s ago" / ", retrieval time unknown") and " Stale, not current.". A series' `stale` stays as data.
 */
const PROVIDER_TITLE = 'Reported by a market data provider. Not reconciled by Domino.'

function figure(market: Market | undefined, code: string, why: string): CardSeries {
  return { kind: 'figure', metric: market?.volume24hUsd ?? null, code, title: `Price chart unavailable: ${why}.` }
}

function carriedBars(history: CarriedHistory, now: Instant): CardSeries | null {
  const age = providerAge(history.ageSeconds, history, now)
  if (age.seconds > history.maxStaleSeconds) return null
  if (!volumeGeometry(history.candles, history.intervalSeconds, CARD_PLOT.width, CARD_PLOT.height, { top: 0, right: 0, bottom: 0, left: 0 }, 0)) return null
  const stale = history.status === 'stale' || age.seconds >= history.freshForSeconds
  return { kind: 'bars', candles: history.candles, intervalSeconds: history.intervalSeconds, returned: history.returned, stale, title: PROVIDER_TITLE }
}

function chainLine(market: Market, answer: Extract<CardAnswer, { source: 'chain' }>, now: Instant): CardSeries {
  const data = answer.data
  if (!data) return figure(market, answer.code ?? 'failed', answer.failure ?? 'the price history did not answer')
  const ask = cardAsk(market, 'chain')
  const [first, second] = currencies(market)
  const quote = ask?.currency === first ? second : first
  if (!ask || data.poolId.toLowerCase() !== ask.poolId || data.currency.toLowerCase() !== ask.currency || (data.quoteCurrency !== null && data.quoteCurrency.toLowerCase() !== quote)) {
    return figure(market, 'mismatch', 'the price history answered for other currencies')
  }
  if (data.status !== 'available' && data.status !== 'partial' && data.status !== 'stale') {
    return figure(market, data.status, data.status === 'not_built' ? 'this pool’s price history is still being collected' : 'this pool’s price history is unavailable')
  }
  if (data.candles.length < 2) return figure(market, 'few-hours', 'fewer than two hours of swaps in the last 24 hours')
  if (now.wall - answer.receivedAt > CHAIN_KEEP_MS || answer.receivedAt - now.wall > 60_000) return figure(market, 'expired', 'the price history read is more than an hour old')
  if (!ratioGeometry(data, CARD_PLOT.width, CARD_PLOT.height, CARD_LINE_PAD)) return figure(market, 'unreadable', 'the reported prices could not be read')
  const aged = data.snapshot !== null && now.wall / 1000 - data.snapshot.timestamp > CHAIN_STALE_SECONDS
  const stale = data.status === 'stale' || aged || answer.failure !== null
  const inOrder = ask.currency === market.tokens.base.address.toLowerCase()
  // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the basis only; " Some hours are not collected
  // yet." and " Stale, not current." are no longer added.
  const title = 'Pool price from Robinhood Chain swaps: hourly closes over the last 24 hours, in the pool’s quote token, not USD.'
  return { kind: 'line', history: data, base: inOrder ? market.tokens.base : market.tokens.quote, quote: inOrder ? market.tokens.quote : market.tokens.base, stale, title }
}

function providerBars(market: Market, answer: Extract<CardAnswer, { source: 'provider' }>, now: Instant): CardSeries {
  const data = answer.data
  if (!data) return figure(market, answer.code ?? 'failed', answer.failure ?? 'the hourly volume did not answer')
  const history = data.priceHistory
  if (history.status === 'not_requested') return figure(market, 'not-requested', 'no hourly volume was reported')
  if (history.status !== 'available' && history.status !== 'stale') return figure(market, 'unavailable', reasonText(history.reason))
  if (!market.chartTokens || !chartMatches(data, market.chartTokens[answer.side], answer.side)) return figure(market, 'mismatch', reasonText('provider_chart_currency_mismatch'))
  const age = providerAge(history.cache.ageSeconds, answer, now)
  if (age.seconds > history.cache.maxStaleSeconds) return figure(market, 'expired', 'the hourly volume is older than the read service’s five-minute limit')
  const candles = history.data.candles
  if (candles.length === 0) return figure(market, 'unavailable', 'no candles reported')
  if (!volumeGeometry(candles, history.data.intervalSeconds, CARD_PLOT.width, CARD_PLOT.height, { top: 0, right: 0, bottom: 0, left: 0 }, 0)) {
    return figure(market, 'unavailable', 'the reported volumes could not be read')
  }
  const stale = history.status === 'stale' || age.seconds >= history.cache.freshForSeconds || answer.failure !== null
  return { kind: 'bars', candles, intervalSeconds: history.data.intervalSeconds, returned: history.data.coverage.returnedCandles, stale, title: PROVIDER_TITLE }
}

export interface CardInput {
  /** The card's verified row; absent while the markets load has not given one. */
  market: Market | undefined
  /** The markets load has settled, so a missing row will not come. */
  settled: boolean
  /** The card's latest settled read of the series it asks for. */
  answer: CardAnswer | undefined
  /** A read of the card's series is on its way. */
  expecting: boolean
  now: Instant
}

/** What one card's plot shows now. */
export function pickSeries({ market, settled, answer, expecting, now }: CardInput): CardSeries {
  if (!market) return settled ? figure(undefined, 'no-figures', 'this pool’s figures didn’t load') : WAITING
  const carried = market.providerHistory ? carriedBars(market.providerHistory, now) : null
  if (carried) return carried
  if (answer?.source === 'chain') return chainLine(market, answer, now)
  if (answer?.source === 'provider') return providerBars(market, answer, now)
  return expecting ? WAITING : figure(market, 'not-asked', 'no hourly series is available for this pool')
}

// ---------------------------------------------------------------------------
// Asking a provider again (the read-v1 path, only where `history` is not listed)
// ---------------------------------------------------------------------------

/** Re-asks per card per visit, whatever the reason. */
export const PROVIDER_REASKS = 4
/** The first wait before a re-ask; each capacity refusal doubles it. */
export const PROVIDER_WAIT_MS = 60_000

export interface ProviderTally {
  reasks: number
  /** provider_unavailable answers in a row. Two end the card's asking: that answer is the provider's. */
  unavailable: number
  /** Capacity refusals and transient failures so far, which set the doubling wait. */
  waits: number
}

export const FIRST_TALLY: ProviderTally = { reasks: 0, unavailable: 0, waits: 0 }

/**
 * How often a chain card asks again after an answer. Was the pool chart's minute (historyRead.ts); five minutes since
 * 2026-10-30 (QA round 2, N104): a card draws 24 hours at one point an hour, so a minute changed nothing on screen and an
 * idle Markets sent six history reads a minute.
 */
export const CHAIN_REFRESH_MS = 300_000
/**
 * How often a chain card whose history is still being built (`not_built`) asks again: the minute, as before 2026-10-30
 * (N104 review). Its first request started the build, and the line can be drawn as soon as it is done
 * (historyRead.ts HISTORY_EVERY_MS).
 */
export const CHAIN_BUILDING_MS = 60_000
const PROVIDER_PASSING = new Set(['provider_capacity_busy', 'provider_rate_limited', 'provider_unavailable'])

/**
 * How long a card coming back to the page waits before its first read, from
 * what the browser kept for it; null when that answer stands for this visit. A
 * chain series keeps its five-minute rhythm (CHAIN_REFRESH_MS), a history still
 * being built its minute (CHAIN_BUILDING_MS); provider candles still drawn wait
 * for the read service's limit; a provider refusal that can pass waits a
 * minute from when it came; any other provider answer is final. A failed
 * read waits out its own wait, a minute at the least, and is then asked
 * again, whatever the failure; a series kept through a failed refresh waits
 * out that failure too, from when the failure came: a service that asked for
 * time is not asked at once.
 */
export function keptWaitMs(answer: CardAnswer, now: Instant): number | null {
  const failed = failureWaitMs(answer, now)
  if (answer.data === null) return failed
  const since = elapsedMs(answer, now)
  if (answer.source === 'chain') return Math.max(0, (answer.data.status === 'not_built' ? CHAIN_BUILDING_MS : CHAIN_REFRESH_MS) - since, failed)
  const history = answer.data.priceHistory
  if (history.status === 'available' || history.status === 'stale') {
    return Math.max(0, (history.cache.maxStaleSeconds - providerAge(history.cache.ageSeconds, answer, now).seconds) * 1000, failed)
  }
  if (history.reason !== null && PROVIDER_PASSING.has(history.reason)) return Math.max(0, PROVIDER_WAIT_MS - since, failed)
  return null
}

/** Whether a legacy card asks again after this outcome, and when; `delay` null when it does not. */
export function providerAgain(outcome: TransientCandidate & { data?: PoolMarketResponse }, tally: ProviderTally): { delay: number | null; tally: ProviderTally } {
  const stop = { delay: null, tally }
  if (tally.reasks >= PROVIDER_REASKS) return stop
  // (2026-10-15, pack 8, Q3): a wait after a busy or refusing answer, plus 0 to 25% at random (../jitter.ts), never less.
  const backoff = (floorMs = 0) => ({ delay: jittered(Math.max(floorMs, PROVIDER_WAIT_MS * 2 ** tally.waits)), tally: { reasks: tally.reasks + 1, unavailable: 0, waits: tally.waits + 1 } })
  if (outcome.state !== 'ok' || !outcome.data) {
    const wait = transientWaitSeconds(outcome)
    return wait === null ? stop : backoff(wait * 1000)
  }
  const history = outcome.data.priceHistory
  if (history.status === 'available' || history.status === 'stale') {
    // Drawn: asked again only once the candles pass the read service's limit.
    const left = (history.cache.maxStaleSeconds - (history.cache.ageSeconds ?? 0)) * 1000
    return { delay: Math.max(PROVIDER_WAIT_MS, left), tally: { reasks: tally.reasks + 1, unavailable: 0, waits: 0 } }
  }
  if (history.status === 'not_requested') return stop
  if (history.reason === 'provider_unavailable') {
    if (tally.unavailable + 1 >= 2) return { delay: null, tally: { ...tally, unavailable: tally.unavailable + 1 } }
    return { delay: PROVIDER_WAIT_MS, tally: { reasks: tally.reasks + 1, unavailable: tally.unavailable + 1, waits: tally.waits } }
  }
  if (history.reason === 'provider_capacity_busy' || history.reason === 'provider_rate_limited') return backoff()
  return stop
}

// ---------------------------------------------------------------------------
// This browser's memory of the answers
// ---------------------------------------------------------------------------

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  /** Where the storage can list its keys (the browser's always can), so old series can be let go. */
  readonly length?: number
  key?(index: number): string | null
}

export interface CardCache {
  /** The answer kept for `key` that still stands now, or null. */
  get(key: string, now: Instant): CardAnswer | null
  /** Keeps an answer over the last one as mergeAnswer does; only good chain series reach the browser's storage. */
  put(answer: CardAnswer): void
}

/**
 * The prefix a series is kept under, which names its chain (2026-10-01, the chain2 workstream, part B, audit item G10):
 * `domino-card-v2:4663:<series key>`. A series kept under LEGACY_STORED (until then) is Robinhood Chain's, and moves
 * to its new name the first time it is asked for; the sweep ages both alike.
 */
export const STORED = `${chainKey('domino-card-v2', ROBINHOOD_ID)}:`
/** The prefix until 2026-10-01, with no chain in it. */
export const LEGACY_STORED = 'domino-card:'
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isInterval = (value: unknown) => isRecord(value) && typeof value.startTimestamp === 'number' && typeof value.endTimestamp === 'number'
const isRatioCandle = (value: unknown) => isRecord(value) && typeof value.startTimestamp === 'number' && typeof value.swapCount === 'number' &&
  typeof value.complete === 'boolean' && ['open', 'high', 'low', 'close'].every((field) => typeof value[field] === 'string')

/** A stored chain answer, only in the shape this page itself kept: anything else is dropped. */
function revive(value: unknown, key: string): CardAnswer | null {
  if (!isRecord(value) || value.v !== 1 || value.key !== key || value.source !== 'chain' || typeof value.receivedAt !== 'number' || !Number.isFinite(value.receivedAt)) return null
  const data = value.data
  if (!isRecord(data) || typeof data.poolId !== 'string' || typeof data.currency !== 'string' || !(data.quoteCurrency === null || typeof data.quoteCurrency === 'string') ||
    typeof data.status !== 'string' || typeof data.resolutionSeconds !== 'number' || !isInterval(data.requestedWindow) ||
    !(data.snapshot === null || (isRecord(data.snapshot) && typeof data.snapshot.timestamp === 'number')) ||
    !Array.isArray(data.gaps) || !data.gaps.every(isInterval) || !Array.isArray(data.candles) || !data.candles.every(isRatioCandle)) return null
  return { source: 'chain', key, data: data as unknown as HistoryResponse, receivedAt: value.receivedAt, failure: null, code: null }
}

/**
 * Whether a kept answer still stands: chain series for an hour, provider
 * candles within the read service's limit. A failure stands while its wait
 * runs, so a card coming back keeps its rhythm instead of asking at once, and
 * then for an hour at most, like a chain series, drawn at once while the card
 * asks again. A series kept through a failed refresh stands while that
 * failure's wait runs, even past the series' own limit (it is then drawn as
 * expired, never as current).
 */
function keepable(answer: CardAnswer, now: Instant): boolean {
  if (failureWaitMs(answer, now) > 0) return true
  if (answer.data === null) return elapsedMs(answer, now) <= CHAIN_KEEP_MS
  if (answer.source === 'chain') return now.wall - answer.receivedAt <= CHAIN_KEEP_MS && answer.receivedAt - now.wall <= 60_000
  const history = answer.data.priceHistory
  return (history.status !== 'available' && history.status !== 'stale') || providerAge(history.cache.ageSeconds, answer, now).seconds <= history.cache.maxStaleSeconds
}

/**
 * Answers by key, in memory for the document and, for good chain series, in
 * the browser's storage too, so a reload, or another tab, draws the last
 * series at once and replaces it when the next answer lands, and keeps its
 * one-minute rhythm instead of asking again at once (changed 2026-09-27,
 * r6/marketsdata, from this tab's sessionStorage to localStorage: a new tab
 * waited about 4 s for its six cards behind the tab's read budget). Only
 * wall time is kept there (another document's monotonic clock means
 * nothing), and every read of it applies the same limits as a fresh answer,
 * so nothing old is shown as current; the first series kept in a document
 * lets go of every kept series past CHAIN_KEEP_MS, so pools a list no longer
 * names do not pile up. Provider answers and failures stay in memory only:
 * candles expire within five minutes, and a failure says nothing to another
 * document. Every storage access may throw (a private window, blocked site
 * data), and none is needed: the memory copy carries on without it.
 */
export function createCardCache(storage: () => StorageLike | null, wall: () => number = Date.now): CardCache {
  const memory = new Map<string, CardAnswer>()
  const store = (): StorageLike | null => {
    try {
      return storage()
    } catch {
      return null
    }
  }
  const forget = (key: string) => {
    memory.delete(key)
    try {
      store()?.removeItem(STORED + key)
      store()?.removeItem(LEGACY_STORED + key)
    } catch {
      // Nothing to do: the memory copy is gone either way.
    }
  }
  let swept = false
  /** Once a document: every kept series past CHAIN_KEEP_MS, or not in this page's shape, goes. */
  const sweep = (kept: StorageLike) => {
    swept = true
    const names: string[] = []
    for (let index = 0; index < (kept.length ?? 0); index++) {
      const name = kept.key?.(index)
      if (name?.startsWith(STORED) || name?.startsWith(LEGACY_STORED)) names.push(name)
    }
    for (const name of names) {
      let at = Number.NaN
      try {
        at = JSON.parse(kept.getItem(name) ?? 'null')?.receivedAt
      } catch {
        // Not this page's: let go below.
      }
      if (!(wall() - at <= CHAIN_KEEP_MS)) kept.removeItem(name)
    }
  }
  return {
    get(key, now) {
      let answer = memory.get(key) ?? null
      if (!answer && key.startsWith('chain:')) {
        try {
          // A series still under its name from before (part B, G10) moves to its new name, as it is.
          const text = movedScoped(store(), STORED + key, LEGACY_STORED + key)
          answer = text ? revive(JSON.parse(text), key) : null
          if (text && !answer) forget(key)
        } catch {
          answer = null
        }
      }
      if (!answer) return null
      if (!keepable(answer, now)) {
        forget(key)
        return null
      }
      memory.set(key, answer)
      return answer
    },
    put(answer) {
      memory.set(answer.key, mergeAnswer(memory.get(answer.key), answer))
      if (answer.source !== 'chain' || answer.data === null || answer.failure !== null) return
      try {
        const kept = store()
        if (kept && !swept) sweep(kept)
        kept?.setItem(STORED + answer.key, JSON.stringify({ v: 1, source: 'chain', key: answer.key, receivedAt: answer.receivedAt, data: answer.data }))
      } catch {
        // Full or blocked: the memory copy is enough for this document.
      }
    },
  }
}

/** This page's one card memory, kept in the browser for the next tab (see createCardCache). */
export const CARD_CACHE = createCardCache(() => (typeof localStorage === 'undefined' ? null : localStorage))
