/**
 * The Markets cards' reads. One capabilities check decides which series every
 * card on the page asks for, from the answer the page already holds (never a
 * POST), and is asked again each minute while it says `provider`, which costs
 * a GET only while the check itself keeps failing (followCardMode). Then each
 * card runs its own loop through the app's one scheduled source, so the queue
 * paces and orders them all.
 *
 * `chain`: the pool's stored price history (read-v3 `history`, the stored
 * lane: no provider slot and no provider budget), asked once and then every
 * minute while the page can be seen, with the pool chart's own rules.
 *
 * `provider`: where `history` is not listed, the read-v1 hourly USD candles.
 * A provider read is costly and shared, so a card asks again only as
 * cardSeries.ts providerAgain allows: when drawn candles expire, twice at
 * most for provider_unavailable (that answer is the provider's, as for a pool
 * whose provider rows repeat an hour), and a few times with a doubling wait
 * for capacity refusals.
 *
 * A card coming back to the page draws what the browser kept for it at once and
 * keeps that answer's rhythm (cardSeries.ts keptWaitMs): going back and forth
 * between pages never costs a read per visit. A failed read, final ones too,
 * is asked again by a later visit once its wait is over, a minute at the
 * soonest, so a service that recovers draws the card again without a reload.
 */
import type { PoolMarketResponse } from 'api-contracts/read-v1/types'
import type { HistoryResponse } from 'api-contracts/read-v3/types'
import type { Instant } from '../markets'
import { jittered } from '../jitter'
import { CARD_CACHE, CARD_RESOLUTION_SECONDS, CARD_WINDOW_SECONDS, FAILURE_WAIT_MS, FIRST_TALLY, keptWaitMs, providerAgain, type CardAnswer, type CardAsk, type CardCache, type CardSource } from './cardSeries'
import { followPublicHistory, pageShown } from './historyRead'
import { realClock, type Clock } from './pipeline'
import { failureText, type ScreenFailure } from './screens/copy'
import { isTransient, transientWaitSeconds, type TransientCandidate } from './screens/transient'
import { quietRetryDelay, readWithin, type PageVisibility, type ScreenOutcome } from './screens/screenRead'
import type { ReadSource } from './types'

/** Which series this page's cards ask for; `none` when the capabilities themselves failed (the site's access check, say). */
export type CardMode = CardSource | 'none'

/** The mode the source's one shared capabilities answer gives, and the failure behind a `none` that can pass by itself. */
async function checkedMode(source: ReadSource, signal: AbortSignal): Promise<{ mode: CardMode; passing: TransientCandidate | null }> {
  try {
    const check = await source.routeEnabled?.('history', { signal })
    if (!check || check.state === 'not_enabled') return { mode: 'provider', passing: null }
    if (check.state === 'enabled') return { mode: 'chain', passing: null }
    return { mode: 'none', passing: isTransient(check.outcome) ? check.outcome : null }
  } catch {
    return { mode: 'none', passing: null }
  }
}

/** Whether `history` is listed, from the source's one shared capabilities answer. */
export async function cardMode(source: ReadSource, signal: AbortSignal): Promise<CardMode> {
  return (await checkedMode(source, signal)).mode
}

/** How long cards on the provider path wait before the page asks the capabilities again. */
export const CARD_MODE_RECHECK_MS = 60_000

export interface ModeWatch {
  signal: AbortSignal
  clock?: Clock
  page?: PageVisibility | null
}

/**
 * The page's card series: decided at once and, while it is `provider`, again
 * every minute the page can be seen. A passing failure of the read-v3
 * capabilities GET (a dropped connection, a 502 edge page) comes back as "not
 * listed" (publicSource.ts), and it must not keep every card on the costlier
 * provider path for the visit once the check answers again, as the table
 * does at its own next refresh. A kept check costs nothing to ask; a failed
 * one costs its GET, once a minute at most. `chain` and `none` stand: the
 * check that listed `history` is kept for the document, and `none` is the
 * site's access check, which only signing in ends. `emit` hears each change.
 *
 * Changed 2026-09-28 (speed wave, item 3): a check that still fails in passing
 * after publicSource.ts asked it again says so now, rather than "not listed";
 * it decides nothing yet, and is asked again as transient.ts allows before it
 * is taken for `none`.
 */
export async function followCardMode(source: ReadSource, emit: (mode: CardMode) => void,
  { signal, clock = realClock, page = typeof document === 'undefined' ? null : document }: ModeWatch): Promise<void> {
  let last: CardMode | null = null
  let attempt = 0
  try {
    while (!signal.aborted) {
      const { mode, passing } = await checkedMode(source, signal)
      if (signal.aborted) return
      const delay = passing ? quietRetryDelay(passing, attempt++) : null
      if (delay !== null) {
        await clock.sleep(delay, signal)
        await pageShown(page, signal)
        continue
      }
      if (mode !== last) emit(mode)
      last = mode
      // A source with no capabilities to ask never changes its answer.
      if (mode !== 'provider' || !source.routeEnabled) return
      await clock.sleep(CARD_MODE_RECHECK_MS, signal)
      await pageShown(page, signal)
    }
  } catch {
    // A sleep ended by the signal: the page is gone.
  }
}

export interface CardWatch {
  signal: AbortSignal
  clock?: Clock
  page?: PageVisibility | null
  cache?: CardCache
}

type Answered<R extends 'history' | 'pool-market'> = Exclude<ScreenOutcome<R>, { state: 'aborted' }>

/** A settled read as a card's answer, on the times it arrived. */
function answerOf(ask: CardAsk, outcome: Answered<'history'> | Answered<'pool-market'>, clock: Clock): CardAnswer {
  if (outcome.state === 'ok') {
    const { receivedAt, receivedMonotonic } = outcome.provenance
    const times = { key: ask.key, receivedAt, ...(receivedMonotonic === undefined ? {} : { receivedMonotonic }), failure: null, code: null }
    return ask.source === 'chain'
      ? { ...times, source: 'chain', data: outcome.data as HistoryResponse }
      : { ...times, source: 'provider', side: ask.side, data: outcome.data as PoolMarketResponse }
  }
  const said = failureText(outcome as ScreenFailure, 'pools')
  // Kept for a card that comes back, which asks again a minute on at the soonest, never sooner than the failure asked.
  // A failure this visit does not ask again (an edge page during a redeploy, a runtime skew) is asked again then too.
  const asked = transientWaitSeconds(outcome) ?? 0
  const times = { key: ask.key, receivedAt: clock.now(), receivedMonotonic: clock.monotonic(), failure: `${said.title}. ${said.detail}`, code: said.code,
    // (2026-10-15, pack 8, Q3): the wait asked for plus 0 to 25% at random (../jitter.ts), never less than it.
    retryAfterMs: Math.max(jittered(asked * 1000), FAILURE_WAIT_MS) }
  return ask.source === 'chain' ? { ...times, source: 'chain', data: null } : { ...times, source: 'provider', side: ask.side, data: null }
}

/**
 * One card's reads until `signal` ends: what this browser kept for it first (a
 * microtask after the call, so it lands as an update, never inside the
 * caller's own effect), then its own reads. Every answer goes to `emit`.
 */
export async function watchCard(source: ReadSource, ask: CardAsk, emit: (answer: CardAnswer) => void,
  { signal, clock = realClock, page = typeof document === 'undefined' ? null : document, cache = CARD_CACHE }: CardWatch): Promise<void> {
  const now = (): Instant => ({ wall: clock.now(), monotonic: clock.monotonic() })
  try {
    await Promise.resolve()
    if (signal.aborted) return
    const kept = cache.get(ask.key, now())
    if (kept) emit(kept)
    // A card coming back keeps its answer's rhythm, and one whose answer stands for the visit asks nothing.
    let wait = kept ? keptWaitMs(kept, now()) : 0
    if (wait === null) return
    if (ask.source === 'chain') {
      if (wait > 0) await clock.sleep(wait, signal)
      const request = { poolId: ask.poolId, currency: ask.currency, windowSeconds: CARD_WINDOW_SECONDS, resolutionSeconds: CARD_RESOLUTION_SECONDS } as const
      await followPublicHistory(source, request, (event) => {
        if (event.state !== 'answer' || event.outcome.state === 'aborted' || signal.aborted) return
        const answer = answerOf(ask, event.outcome, clock)
        cache.put(answer)
        emit(answer)
      }, { signal, clock, page })
      return
    }
    let tally = FIRST_TALLY
    while (!signal.aborted) {
      if (wait > 0) await clock.sleep(wait, signal)
      await pageShown(page, signal)
      if (signal.aborted) return
      const outcome = await readWithin(source, 'pool-market', { poolId: ask.poolId, includePriceHistory: true, priceToken: ask.side }, { signal, clock })
      if (signal.aborted || outcome.state === 'aborted') return
      const answer = answerOf(ask, outcome, clock)
      cache.put(answer)
      emit(answer)
      const next = providerAgain(outcome, tally)
      if (next.delay === null) return
      tally = next.tally
      wait = next.delay
    }
  } catch {
    // A sleep ended by the signal: the card is gone, and there is nothing to say.
  }
}
