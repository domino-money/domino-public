import type { HistoryRequest } from 'api-contracts/read-v3/types'
import { realClock, type Clock } from './pipeline'
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

export interface HistoryWatch { signal: AbortSignal; clock?: Clock; page?: PageVisibility | null }

/**
 * The history loop once the route is known to be listed: serial reads, each
 * only while the page can be seen, a minute after an answer, and failures
 * asked again only as transient.ts allows. The Markets cards run it too
 * (lib/read/cardReads.ts), after one capabilities check for all of them.
 */
export async function followPublicHistory(source: ReadSource, request: HistoryRequest, emit: (event: HistoryEvent) => void,
  { signal, clock = realClock, page = typeof document === 'undefined' ? null : document }: HistoryWatch) {
  let attempts = 0
  while (!signal.aborted) {
    await pageShown(page, signal)
    if (signal.aborted) return
    emit({ state: 'reading' })
    const outcome = await readWithin(source, 'history', request, { signal, clock })
    if (signal.aborted || outcome.state === 'aborted') return
    emit({ state: 'answer', outcome })
    const delay = outcome.state === 'ok' ? 60_000 : quietRetryDelay(outcome, attempts++)
    if (delay === null) return
    if (outcome.state === 'ok') attempts = 0
    await clock.sleep(delay, signal)
  }
}

/** Capability first, serial reads, no hidden-tab polling and bounded failure retries. */
export async function watchPublicHistory(source: ReadSource, request: HistoryRequest, emit: (event: HistoryEvent) => void, options: HistoryWatch) {
  const { signal } = options
  try {
    if (signal.aborted) return
    const check = await source.routeEnabled?.('history', { signal })
    if (signal.aborted) return
    if (!check || check.state === 'not_enabled') { emit({ state: 'not_enabled' }); return }
    if (check.state !== 'enabled') { emit({ state: 'capability_failed' }); return }
    await followPublicHistory(source, request, emit, options)
  } catch {
    if (!signal.aborted) emit({ state: 'capability_failed' })
  }
}
