import type { HistoryRequest } from 'api-contracts/read-v3/types'
import { realClock, type Clock } from './pipeline'
import type { ReadSource } from './types'
import { readWithin, quietRetryDelay, type PageVisibility, type ScreenOutcome } from './screens/screenRead'

export type HistoryEvent = { state: 'not_enabled' | 'capability_failed' | 'reading' } |
  { state: 'answer'; outcome: ScreenOutcome<'history'> }

async function visible(page: PageVisibility | null, signal: AbortSignal): Promise<void> {
  if (!page?.hidden || signal.aborted) return
  await new Promise<void>(resolve => {
    const done = () => { page.removeEventListener('visibilitychange', shown); signal.removeEventListener('abort', done); resolve() }
    const shown = () => { if (!page.hidden) done() }
    page.addEventListener('visibilitychange', shown)
    signal.addEventListener('abort', done, { once: true })
    if (signal.aborted || !page.hidden) done()
  })
}

/** Capability first, serial reads, no hidden-tab polling and bounded failure retries. */
export async function watchPublicHistory(source: ReadSource, request: HistoryRequest, emit: (event: HistoryEvent) => void,
  { signal, clock = realClock, page = typeof document === 'undefined' ? null : document }:
  { signal: AbortSignal; clock?: Clock; page?: PageVisibility | null }) {
  try {
    if (signal.aborted) return
    const check = await source.routeEnabled?.('history', { signal })
    if (signal.aborted) return
    if (!check || check.state === 'not_enabled') { emit({ state: 'not_enabled' }); return }
    if (check.state !== 'enabled') { emit({ state: 'capability_failed' }); return }
    let attempts = 0
    while (!signal.aborted) {
      await visible(page, signal)
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
  } catch {
    if (!signal.aborted) emit({ state: 'capability_failed' })
  }
}
