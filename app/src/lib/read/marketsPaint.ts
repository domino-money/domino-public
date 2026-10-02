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
 *
 * Added 2026-10-01 (audit A7 a): past its 15 minutes, and up to a day, the copy
 * still names the pools the page last showed (`prefetch`). Nothing of it is
 * shown then: the page only asks those pools' figures beside the list's first
 * read instead of after it, which the list then confirms or not (the list
 * changes once a day). A returning visitor's first figures came about 0.6 s
 * later than with a copy, every visit after a quarter of an hour.
 */
import type { OverviewResponse } from 'api-contracts/read-v3/types'
import { ROBINHOOD_ID } from '../../config/chainIdentity'
import { chainKey, movedScoped } from '../chainStorage'
import type { StorageLike } from './cardSeries'
import type { Provenance } from './types'

/**
 * The copy's one key, which names the chain it is of (2026-10-01, the chain2 workstream, part B, audit item G10):
 * `domino-markets-v2:4663`, so a second chain's Markets never paints this one's list. A copy kept under LEGACY_PAINT_KEY
 * is Robinhood Chain's, and moves here the first time it is read (lib/chainStorage.ts movedScoped). The page's boot
 * script reads the same key (functions/_lib/boot.ts).
 */
export const PAINT_KEY = chainKey('domino-markets-v2', ROBINHOOD_ID)
/** The name the copy was kept under until 2026-10-01, with no chain in it. */
export const LEGACY_PAINT_KEY = 'domino-markets:v1'
export const PAINT_MAX_AGE_MS = 15 * 60_000
/** How long the copy still names the pools to ask first, showing nothing (A7 a). */
export const PREFETCH_MAX_AGE_MS = 24 * 3_600_000

/** An overview answer as the provider projects it: its payload and when it arrived. */
export interface PaintedOverview {
  data: OverviewResponse
  provenance: Provenance
}

export interface PaintMemory {
  /** The copy, while it stands; null otherwise. */
  load(): PaintedOverview | null
  save(overview: PaintedOverview): void
  /** The pools a copy up to PREFETCH_MAX_AGE_MS old names, to ask first while nothing of it is shown (A7 a); null otherwise. */
  prefetch?(): readonly string[] | null
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
  /**
   * The copy as last read, checked, by the text it was read from (2026-09-28, speed wave): the markets provider, the
   * featured list and a pool's page each ask for it as the app starts, and the same text is not parsed and checked
   * against the runtime again. Its age is counted afresh at every ask.
   */
  let last: { raw: string; copy: PaintedOverview | null } | null = null
  /** The copy as kept and checked, whatever its age; null when there is none or it does not pass. */
  const read = (): PaintedOverview | null => {
    const raw = movedScoped(store(), PAINT_KEY, LEGACY_PAINT_KEY)
    if (raw === null) return null
    if (last?.raw !== raw) {
      const kept = JSON.parse(raw)
      const valid = kept.v === 1 && kept.contract === runtime.CONTRACT_VERSION && Number.isFinite(kept.receivedAt) && runtime.validateResponse('overview', kept.data)
      last = { raw, copy: valid ? { data: kept.data, provenance: { transport: 'bridge', contract: kept.contract, receivedAt: kept.receivedAt, attempts: 0 } } : null }
    }
    return last.copy
  }
  return {
    load() {
      try {
        const copy = read()
        const age = copy ? now() - copy.provenance.receivedAt : NaN
        return copy && age >= 0 && age < PAINT_MAX_AGE_MS ? copy : null
      } catch {
        return null
      }
    },
    prefetch() {
      try {
        const copy = read()
        const age = copy ? now() - copy.provenance.receivedAt : NaN
        return copy && age >= 0 && age < PREFETCH_MAX_AGE_MS && copy.data.requestedPoolIds.length > 0 ? copy.data.requestedPoolIds : null
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
