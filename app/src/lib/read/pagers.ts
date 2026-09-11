/**
 * Lists that come in pages: wallet assets and the pool catalogue.
 *
 * The continuation handle lives inside the pager and nowhere else. It is the
 * value the last validated page returned, sent back byte for byte, and never
 * parsed, displayed, stored, logged or put in a URL; the view a pager returns
 * has no field that could carry it. Rows merge by chain plus address or pool
 * id, and each keeps the page and the time it came from.
 *
 * When the bridge says the handle expired (400) or the catalogue changed
 * (409), the pager restarts from the first page once, keeps what it had
 * marked as old, and replaces those rows as they are seen again. The restart
 * is still the same read: it spends what is left of that read's 60 s (R-1).
 */
import type { CatalogueRequest, WalletAssetsRequest, WalletAssetsResponse, WalletItem } from 'api-contracts/read-v1/types'
import { formatUnits } from './decimal'
import { reasonText } from './describe'
import { freshnessLines, identityKey, projectCatalogue, tokenDisplay, unreadToken, type Fact, type ItemView } from './project'
import type { FailedOutcome, OpaqueCursor, ReadOutcome, ReadRequests, ReadRoute, ReadSource, TokenDisplay } from './types'

export interface PageStep<V> {
  view: V
  /** What stopped this step, if anything. Rows already loaded stay. */
  failure: FailedOutcome | null
  /** Rows this step added that were not on screen before. */
  added: number
}

function amountFact(item: WalletItem): Fact {
  const units = formatUnits(item.amountRaw, item.decimals)
  if (units === null) return { label: 'Balance', text: 'Unavailable', state: 'unavailable' }
  if (item.amountRaw === '0') return { label: 'Balance', text: '0', state: 'zero' }
  if (units.kind === 'raw') return { label: 'Balance', text: `${units.text} (raw units, decimals unknown)`, state: 'raw' }
  return { label: 'Balance', text: units.text, state: 'value' }
}

function inventoryNote(inventory: WalletAssetsResponse['inventory']): string {
  switch (inventory.status) {
    case 'not_configured':
      return 'Inventory discovery is not configured, so only the requested tokens are shown.'
    case 'not_requested':
      return 'Inventory discovery was not requested, so only the requested tokens are shown.'
    case 'unavailable':
      return `Partial list: inventory unavailable (${reasonText(inventory.reason)}). Only the requested tokens are shown.`
    case 'page_received':
      return inventory.hasMore ? 'One page of the provider’s inventory. More are available.' : 'All pages loaded.'
    default:
      return inventory satisfies never
  }
}

export interface WalletRow {
  key: string
  token: TokenDisplay
  amount: Fact
  page: number
  /** Unix seconds this row's page was retrieved, as the payload says. */
  pageRetrievedAt: number
  old: boolean
}

export interface WalletView {
  rows: WalletRow[]
  unavailable: ItemView[]
  notes: string[]
  freshness: string[]
  pages: number
  hasMore: boolean
  restarted: boolean
}

export interface Pager<V> {
  first(signal?: AbortSignal): Promise<PageStep<V>>
  more(signal?: AbortSignal): Promise<PageStep<V>>
  view(): V
}

export function createWalletPager(source: ReadSource, request: WalletAssetsRequest): Pager<WalletView> {
  const base: WalletAssetsRequest = { ...request }
  delete base.cursor
  let cursor: OpaqueCursor | null = null
  let pages = 0
  let restarted = false
  const rows = new Map<string, WalletRow>()
  let unavailable: ItemView[] = []
  let notes: string[] = []
  let freshness: string[] = []

  const view = (): WalletView => ({ rows: [...rows.values()], unavailable, notes, freshness, pages, hasMore: cursor !== null, restarted })

  function absorb(outcome: Extract<ReadOutcome<'wallet-assets'>, { state: 'ok' }>, page: number): number {
    const d = outcome.data
    const retrievedAt = d.inventory.status === 'page_received' ? d.inventory.retrievedAt : d.snapshot.timestamp
    let added = 0
    for (const item of d.items) {
      const key = identityKey(item.address)
      if (!rows.has(key) || rows.get(key)?.old) added += 1
      rows.set(key, { key, token: tokenDisplay(item), amount: amountFact(item), page, pageRetrievedAt: retrievedAt, old: false })
    }
    unavailable = d.unavailableAssets.map((asset) => ({
      key: identityKey(asset.currency),
      title: { label: 'Token', text: '', state: 'unavailable', tokens: [unreadToken(asset.currency)] },
      facts: [{ label: 'Balance', text: `Unavailable: ${reasonText(asset.reason)}`, state: 'unavailable' }],
    }))
    notes = [inventoryNote(d.inventory), 'Balances at the snapshot block. Not proof of wallet control.']
    freshness = freshnessLines(outcome.observation)
    const inventory = d.inventory
    cursor = inventory.status === 'page_received' && inventory.hasMore && inventory.nextCursor !== null ? (inventory.nextCursor as OpaqueCursor) : null
    pages = page
    return added
  }

  async function first(signal?: AbortSignal, deadlineAt?: number): Promise<PageStep<WalletView>> {
    const outcome = await source.read('wallet-assets', base, { signal, deadlineAt })
    if (outcome.state !== 'ok') return { view: view(), failure: outcome, added: 0 }
    const added = absorb(outcome, 1)
    return { view: view(), failure: null, added }
  }

  async function more(signal?: AbortSignal): Promise<PageStep<WalletView>> {
    if (cursor === null) return { view: view(), failure: null, added: 0 }
    const outcome = await source.read('wallet-assets', { ...base, cursor }, { signal })
    if (outcome.state === 'ok') {
      const added = absorb(outcome, pages + 1)
      return { view: view(), failure: null, added }
    }
    if (outcome.state === 'restart_required' && outcome.code === 'invalid_or_expired_cursor' && !restarted) {
      restarted = true
      cursor = null
      for (const row of rows.values()) row.old = true
      return first(signal, outcome.provenance.deadlineAt)
    }
    // Keep the handle: the same page can be asked for again before it expires.
    return { view: view(), failure: outcome, added: 0 }
  }

  return { first, more, view }
}

export interface CatalogueView {
  facts: Fact[]
  items: ItemView[]
  notes: string[]
  freshness: string[]
  pages: number
  hasMore: boolean
  restarted: boolean
}

export function createCataloguePager(source: ReadSource, request: CatalogueRequest): Pager<CatalogueView> {
  const base: CatalogueRequest = { ...request }
  delete base.afterPoolId
  delete base.revision
  let next: { afterPoolId: string; revision: number } | null = null
  let pages = 0
  let restarted = false
  const items = new Map<string, ItemView>()
  let facts: Fact[] = []
  let notes: string[] = []
  let freshness: string[] = []

  const view = (): CatalogueView => ({ facts, items: [...items.values()], notes, freshness, pages, hasMore: next !== null, restarted })

  function absorb(outcome: Extract<ReadOutcome<'catalogue'>, { state: 'ok' }>, page: number): number {
    const projected = projectCatalogue(outcome.data)
    let added = 0
    for (const item of projected.items) {
      if (!items.has(item.key) || items.get(item.key)?.old) added += 1
      items.set(item.key, { ...item, old: false })
    }
    facts = projected.facts
    notes = items.size === 0 ? projected.notes : []
    freshness = freshnessLines(outcome.observation)
    const d = outcome.data
    next = d.hasMore && d.nextAfterPoolId !== null ? { afterPoolId: d.nextAfterPoolId, revision: d.revision } : null
    pages = page
    return added
  }

  async function first(signal?: AbortSignal, deadlineAt?: number): Promise<PageStep<CatalogueView>> {
    const outcome = await source.read('catalogue', base, { signal, deadlineAt })
    if (outcome.state !== 'ok') return { view: view(), failure: outcome, added: 0 }
    const added = absorb(outcome, 1)
    return { view: view(), failure: null, added }
  }

  async function more(signal?: AbortSignal): Promise<PageStep<CatalogueView>> {
    if (next === null) return { view: view(), failure: null, added: 0 }
    const outcome = await source.read('catalogue', { ...base, afterPoolId: next.afterPoolId, revision: next.revision }, { signal })
    if (outcome.state === 'ok') {
      const added = absorb(outcome, pages + 1)
      return { view: view(), failure: null, added }
    }
    if (outcome.state === 'restart_required' && outcome.code === 'catalogue_revision_changed' && !restarted) {
      // Same filters, no old position, and a fresh revision from the new first page.
      restarted = true
      next = null
      for (const [key, item] of items) items.set(key, { ...item, old: true })
      return first(signal, outcome.provenance.deadlineAt)
    }
    return { view: view(), failure: outcome, added: 0 }
  }

  return { first, more, view }
}

/**
 * A single read that restarts once when the catalogue changed under it: the
 * pools route answers 409 when its catalogue revision moved mid-request.
 */
export async function readRestartingOnce<R extends ReadRoute>(
  source: ReadSource,
  route: R,
  request: ReadRequests[R],
  signal?: AbortSignal,
): Promise<{ outcome: ReadOutcome<R>; restarted: boolean }> {
  const outcome = await source.read(route, request, { signal })
  if (outcome.state === 'restart_required' && outcome.code === 'catalogue_revision_changed') {
    // Once, and inside the same read's 60 s (R-1).
    return { outcome: await source.read(route, request, { signal, deadlineAt: outcome.provenance.deadlineAt }), restarted: true }
  }
  return { outcome, restarted: false }
}
