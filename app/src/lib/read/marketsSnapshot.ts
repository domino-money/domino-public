/**
 * The read service's stored markets snapshot, as the markets table uses it.
 *
 * The store holds the last verified pool state and provider observation of
 * every pool someone read on demand, and serves them all in one answer that
 * takes no provider read. The table asks it first, when this page's
 * capabilities list the route, and turns every stored entry into a row at
 * once. It then reads on demand only the pools the store could not answer
 * for well enough:
 *
 *   absent         never stored, or evicted
 *   not built      the store is empty (a restart)
 *   stale          the whole store has not been refreshed for its 300 s, or
 *                  this entry or its provider figures are past the contract's
 *                  300 s (`maxStaleSeconds`) by the payload's own times
 *   unavailable    stored without provider figures
 *
 * A stale entry stays on screen while its read runs: its figures are drawn as
 * stale, in normal type, the reason in titles and data only. A rejected
 * provider observation is not read again inside the window: an identity
 * mismatch does not clear in minutes.
 *
 * A snapshot answer that is not `ok` is never shown or said. It sends the
 * table back to its own market reads for five minutes, counted on the
 * monotonic clock, and only in memory.
 */
import type { MarketsSnapshotResponse, SnapshotPoolEntry } from 'api-contracts/read-v1/types'
import { storedAges } from './project'

/** How long a failed snapshot answer keeps the table on its own market reads. */
export const SNAPSHOT_RETRY_MS = 300_000
/** The contract's bound on the pool ids one snapshot request may name. */
export const SNAPSHOT_MAX_POOLS = 24

/** When the snapshot last failed, for the provider's life. */
export interface SnapshotMemo {
  /** Whether the snapshot may be asked now: never failed, or failed at least SNAPSHOT_RETRY_MS ago. */
  allows(): boolean
  failed(): void
  succeeded(): void
}

export function createSnapshotMemo(monotonic: () => number = () => performance.now()): SnapshotMemo {
  let failedAt: number | null = null
  return {
    allows: () => failedAt === null || monotonic() - failedAt >= SNAPSHOT_RETRY_MS,
    failed: () => {
      failedAt = monotonic()
    },
    succeeded: () => {
      failedAt = null
    },
  }
}

export interface SnapshotPlan {
  /** The stored entries that become rows now, by lowercase pool id. */
  entries: Map<string, SnapshotPoolEntry>
  /** The pools, in table order, that are read on demand after the snapshot: absent, not built, stale or unavailable. */
  refresh: string[]
}

export function planSnapshot(d: MarketsSnapshotResponse, poolIds: readonly string[]): SnapshotPlan {
  const stored = new Map(d.pools.map((entry) => [entry.poolId.toLowerCase(), entry]))
  const entries = new Map<string, SnapshotPoolEntry>()
  const refresh: string[] = []
  const storeStale = d.status === 'stale' || d.stale
  for (const poolId of poolIds) {
    const key = poolId.toLowerCase()
    const entry = d.status === 'not_built' ? undefined : stored.get(key)
    const ages = entry ? storedAges(d, entry) : null
    if (!entry || !ages) {
      refresh.push(poolId)
      continue
    }
    entries.set(key, entry)
    const limit = entry.market.cache.maxStaleSeconds
    const providerExpired = ages.providerAgeSeconds !== null && ages.providerAgeSeconds > limit
    if (storeStale || ages.servedAgeSeconds > limit || providerExpired || entry.market.status === 'unavailable') refresh.push(poolId)
  }
  return { entries, refresh }
}
