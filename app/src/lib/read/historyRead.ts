import type { HistoryRequest } from 'api-contracts/read-v3/types'
import { realClock, type Clock } from './pipeline'
import { HISTORY_REUSE_MS } from './publicMetadataCache'
import type { ReadSource } from './types'
import { readWithin, quietRetryDelay, type PageVisibility, type ScreenOutcome } from './screens/screenRead'

export type HistoryEvent = { state: 'not_enabled' | 'capability_failed' | 'reading' } |
  { state: 'answer'; outcome: ScreenOutcome<'history'> }

/** Resolves once the page can be seen, or at once when it can or the signal has ended. */
export async function pageShown(page: PageVisibility | null, signal: AbortSignal): Promise<void> {
  if (!page?.hidden || signal.aborted) return
  await new Promise<void>(resolve => {
    const done = () => { page.removeEventListener('visibilitychange', shown); signal.removeEventListener('abort', done); resolve() }
    const shown = () => { if (!page.hidden) done() }
    page.addEventListener('visibilitychange', shown)
    signal.addEventListener('abort', done, { once: true })
    if (signal.aborted || !page.hidden) done()
  })
}

export interface HistoryWatch {
  signal: AbortSignal
  clock?: Clock
  page?: PageVisibility | null
  /**
   * How long after an answer the next read goes, ms: HISTORY_EVERY_MS, the pool chart's minute, unless given. The Markets
   * cards give their own (cardSeries.ts CHAIN_REFRESH_MS, added 2026-10-30, QA round 2, N104). A history still being
   * built (`not_built`) is asked again at the minute at the latest, whatever is given: its first request started the
   * build, and the series can be drawn as soon as the build is done.
   */
  everyMs?: number
}

/** The pool chart's rhythm: a read a minute after each answer. */
export const HISTORY_EVERY_MS = 60_000

/**
 * The history loop once the route is known to be listed: serial reads, each
 * only while the page can be seen, a minute after an answer (`everyMs`), and
 * failures asked again only as transient.ts allows. The Markets cards run it
 * too (lib/read/cardReads.ts), after one capabilities check for all of them,
 * every five minutes: a card draws 24 hours at one point an hour. A history
 * still being built keeps the minute (`not_built`, N104 review, 2026-10-30).
 * The minute counts from when the answer was read (changed 2026-09-28, speed
 * wave, item 6): one another screen read a moment ago (publicMetadataCache.ts)
 * is asked again on its own rhythm, so it is never shown longer than a fresh one.
 */
export async function followPublicHistory(source: ReadSource, request: HistoryRequest, emit: (event: HistoryEvent) => void,
  { signal, clock = realClock, page = typeof document === 'undefined' ? null : document, everyMs = HISTORY_EVERY_MS }: HistoryWatch) {
  let attempts = 0
  while (!signal.aborted) {
    await pageShown(page, signal)
    if (signal.aborted) return
    emit({ state: 'reading' })
    const outcome = await readWithin(source, 'history', request, { signal, clock })
    if (signal.aborted || outcome.state === 'aborted') return
    emit({ state: 'answer', outcome })
    // At most the reuse window earlier (publicMetadataCache.ts HISTORY_REUSE_MS): never a loop of reads.
    const read = (outcome as { provenance?: { receivedMonotonic?: number } }).provenance?.receivedMonotonic
    const every = outcome.state === 'ok' && outcome.data.status === 'not_built' ? Math.min(everyMs, HISTORY_EVERY_MS) : everyMs
    const delay = outcome.state === 'ok' ? every - (read === undefined ? 0 : Math.min(HISTORY_REUSE_MS, Math.max(0, clock.monotonic() - read))) : quietRetryDelay(outcome, attempts++)
    if (delay === null) return
    if (outcome.state === 'ok') attempts = 0
    await clock.sleep(delay, signal)
  }
}

/**
 * Capability first, serial reads, no hidden-tab polling and bounded failure retries. A capabilities check that failed
 * in passing is asked again as transient.ts allows (changed 2026-09-28, speed wave, item 3: such a failure used to send
 * the chart to the provider's candles; publicSource.ts now says it failed).
 */
export async function watchPublicHistory(source: ReadSource, request: HistoryRequest, emit: (event: HistoryEvent) => void, options: HistoryWatch) {
  const { signal, clock = realClock, page = typeof document === 'undefined' ? null : document } = options
  try {
    for (let attempt = 0; !signal.aborted; attempt += 1) {
      const check = await source.routeEnabled?.('history', { signal })
      if (signal.aborted) return
      if (!check || check.state === 'not_enabled') { emit({ state: 'not_enabled' }); return }
      if (check.state === 'enabled') break
      emit({ state: 'capability_failed' })
      const delay = check.outcome ? quietRetryDelay(check.outcome, attempt) : null
      if (delay === null) return
      await clock.sleep(delay, signal)
      await pageShown(page, signal)
    }
    if (!signal.aborted) await followPublicHistory(source, request, emit, options)
  } catch {
    if (!signal.aborted) emit({ state: 'capability_failed' })
  }
}
