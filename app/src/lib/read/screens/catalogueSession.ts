/**
 * Issue #3: the stored pool catalogue, paged, and a way to verify one of its
 * candidates at the latest block before anyone can pick it.
 *
 * Slice A's catalogue pager holds `afterPoolId` and `revision` and restarts
 * once on 409 `catalogue_revision_changed`, keeping earlier rows marked old.
 * This caps the list at 5 pages. A catalogue candidate is not verified at any
 * block; `verifyCandidate` asks the pools route about exactly that pool id and
 * only a pool it returns becomes an option.
 */
import type { CatalogueRequest, PoolsRequest } from 'api-contracts/read-v1/types'
import type { Clock } from '../pipeline'
import { createCataloguePager, type CatalogueView, type PageStep } from '../pagers'
import type { FailedOutcome, ReadSource } from '../types'
import { poolIdKey, type AddressKey, type PoolIdKey } from './identity'
import { projectPoolsView, type PoolOption } from './poolsList'
import { readWithin, withReadBudget, type ScreenOutcome } from './screenRead'

export const CATALOGUE_PAGE_CAP = 5

export function catalogueRequest(token: AddressKey, paired: AddressKey | null): CatalogueRequest {
  return paired ? { token, pairedToken: paired, limit: 20 } : { token, limit: 20 }
}

export function verifyRequest(token: AddressKey, paired: AddressKey | null, poolId: PoolIdKey): PoolsRequest {
  return paired ? { token, pairedToken: paired, maxPools: 1, poolIds: [poolId] } : { token, maxPools: 1, poolIds: [poolId] }
}

/** A catalogue row's pool id, from its `4663:<poolId>` key. */
export const cataloguePoolId = (itemKey: string) => poolIdKey(itemKey.slice(itemKey.indexOf(':') + 1))

export interface CatalogueSnapshot {
  view: CatalogueView
  failure: FailedOutcome | null
  loading: boolean
  capped: boolean
  canLoadMore: boolean
}

export interface CatalogueSession {
  first(signal?: AbortSignal): Promise<CatalogueSnapshot>
  more(signal?: AbortSignal): Promise<CatalogueSnapshot>
  snapshot(): CatalogueSnapshot
}

export function createCatalogueSession(source: ReadSource, token: AddressKey, paired: AddressKey | null): CatalogueSession {
  // As with the wallet list: each page is a screen read, bounded including the
  // time it spends waiting behind other reads on the shared queue.
  const pager = createCataloguePager(withReadBudget(source), catalogueRequest(token, paired))
  let view = pager.view()
  let failure: FailedOutcome | null = null
  let loading = false

  const snapshot = (): CatalogueSnapshot => {
    const capped = view.pages >= CATALOGUE_PAGE_CAP && view.hasMore
    return { view, failure, loading, capped, canLoadMore: view.hasMore && !capped && !loading }
  }
  const absorb = (step: PageStep<CatalogueView>) => {
    view = step.view
    loading = false
    if (step.failure?.state !== 'aborted') failure = step.failure
    return snapshot()
  }
  return {
    async first(signal) {
      loading = true
      return absorb(await pager.first(signal))
    },
    async more(signal) {
      if (loading || view.pages >= CATALOGUE_PAGE_CAP) return snapshot()
      loading = true
      return absorb(await pager.more(signal))
    },
    snapshot,
  }
}

export interface Verification {
  /** Null when the read worked. */
  failure: Exclude<ScreenOutcome<'pools'>, { state: 'ok' }> | null
  /** The verified pool, or null when the reply did not include it. */
  option: PoolOption | null
  restarted: boolean
}

/** Reads the pools route for one catalogue pool id, restarting once if the catalogue changed. */
export async function verifyCandidate(
  source: ReadSource,
  token: AddressKey,
  paired: AddressKey | null,
  poolId: PoolIdKey,
  options: { signal: AbortSignal; clock?: Clock },
): Promise<Verification> {
  const request = verifyRequest(token, paired, poolId)
  let outcome = await readWithin(source, 'pools', request, options)
  let restarted = false
  if (outcome.state === 'restart_required' && outcome.code === 'catalogue_revision_changed') {
    restarted = true
    // The restart belongs to the same logical read, so it inherits the first
    // attempt's deadline. Without this it would be handed a fresh screen
    // budget and could answer past the deadline the read began with.
    const deadlineAt = outcome.provenance.deadlineAt
    outcome = await readWithin(source, 'pools', request, { ...options, deadlineAt })
  }
  if (outcome.state !== 'ok') return { failure: outcome, option: null, restarted }
  const option = projectPoolsView(outcome.data, outcome.provenance.receivedAt).options.find((candidate) => candidate.key === poolId) ?? null
  return { failure: null, option, restarted }
}
