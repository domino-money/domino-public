/**
 * This browser's copy of the last stored overview behind Home and Markets
 * (added 2026-09-27, r6/marketsdata, the owner: the pool figures sometimes
 * took very long to appear). The next visit paints its rows at once, while
 * the live read is on its way, and the live answer replaces them.
 *
 * Display only, and short-lived:
 *   - one localStorage key, kept PAINT_MAX_AGE_MS from the answer's arrival;
 *   - read back only while it still passes read-v3's own runtime, the
 *     contract this build speaks; anything else is dropped;
 *   - never the source of the featured list (featured pools v1: localStorage
 *     only paints provisional rows): its pools are the first ones the page
 *     asks for, and only the rows the list on screen names are shown;
 *   - dated as they were: every figure keeps its own retrieval age, counted
 *     on from the copy's arrival, so a painted figure is as old on screen as
 *     it is, and the APR estimate keeps its own five-minute limit.
 * Every storage access may throw (a private window, blocked site data), and
 * none is needed.
 */
import type { OverviewResponse } from 'api-contracts/read-v3/types'
import type { StorageLike } from './cardSeries'
import type { Provenance } from './types'

export const PAINT_KEY = 'domino-markets:v1'
export const PAINT_MAX_AGE_MS = 15 * 60_000

/** An overview answer as the provider projects it: its payload and when it arrived. */
export interface PaintedOverview {
  data: OverviewResponse
  provenance: Provenance
}

export interface PaintMemory {
  /** The copy, while it stands; null otherwise. */
  load(): PaintedOverview | null
  save(overview: PaintedOverview): void
}

export function createPaintMemory(
  storage: () => StorageLike | null,
  runtime: { CONTRACT_VERSION: string; validateResponse(route: 'overview', payload: unknown): boolean },
  now: () => number = Date.now,
): PaintMemory {
  const store = () => {
    try {
      return storage()
    } catch {
      return null
    }
  }
  return {
    load() {
      try {
        const kept = JSON.parse(store()?.getItem(PAINT_KEY) ?? 'null')
        const age = now() - kept.receivedAt
        if (kept.v !== 1 || kept.contract !== runtime.CONTRACT_VERSION || !(age >= 0 && age < PAINT_MAX_AGE_MS) || !runtime.validateResponse('overview', kept.data)) return null
        return { data: kept.data, provenance: { transport: 'bridge', contract: kept.contract, receivedAt: kept.receivedAt, attempts: 0 } }
      } catch {
        return null
      }
    },
    save({ data, provenance }) {
      try {
        store()?.setItem(PAINT_KEY, JSON.stringify({ v: 1, contract: runtime.CONTRACT_VERSION, receivedAt: provenance.receivedAt, data }))
      } catch {
        // Full or blocked: the next visit reads live, as it always did.
      }
    },
  }
}
