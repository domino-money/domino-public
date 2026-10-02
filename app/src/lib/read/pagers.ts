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

/** A balance as a fact. Exported (2026-09-27) for the Wallet card's remembered rows (lib/walletMemory.ts). */
export function amountFact(item: Pick<WalletItem, 'amountRaw' | 'decimals'>): Fact {
  const units = formatUnits(item.amountRaw, item.decimals)
  if (units === null) return { label: 'Balance', text: 'Unavailable', state: 'unavailable' }
  if (item.amountRaw === '0') return { label: 'Balance', text: '0', state: 'zero' }
  if (units.kind === 'raw') return { label: 'Balance', text: `${units.text} (raw units, decimals unknown)`, state: 'raw' }
  return { label: 'Balance', text: units.text, state: 'value' }
}

/** What the list's inventory says about itself; null when nothing true can be said in one sentence. */
function inventoryNote(inventory: WalletAssetsResponse['inventory']): string | null {
  switch (inventory.status) {
    case 'not_configured':
      return 'Inventory discovery is not configured, so only the requested tokens are shown.'
    case 'not_requested':
      return 'Inventory discovery was not requested, so only the requested tokens are shown.'
    case 'unavailable':
      return `Partial list: inventory unavailable (${reasonText(inventory.reason)}). Only the requested tokens are shown.`
    case 'page_received':
      // A provider page lists what the provider indexes and nothing more (coverage
      // provider_page_only), and a page of no rows can stand for an address that
      // holds plenty. The last page ends the pages, never the holdings, so no
      // sentence calls the list complete.
      return inventory.hasMore ? 'One page of the provider’s inventory. More are available.' : null
    default:
      return inventory satisfies never
  }
}

export interface WalletRow {
  key: string
  token: TokenDisplay
  amount: Fact
  /** The balance's raw integer, exactly as the payload has it. */
  raw: string
  page: number
  /** Unix seconds this row's page was retrieved, as the payload says. */
  pageRetrievedAt: number
  old: boolean
  /** A page of the list, or a by-address check made because a page skipped candidates. */
  via: 'page' | 'address'
  /** Snapshot block of the read that produced this row. */
  block: number
}

export interface WalletView {
  rows: WalletRow[]
  unavailable: ItemView[]
  notes: string[]
  freshness: string[]
  pages: number
  hasMore: boolean
  restarted: boolean
  /**
   * Provider candidates the service checked on this list's pages
   * (InventoryPage.candidatesProbed, summed; reset on page 1), or null while
   * no page has said: an older producer leaves the field out. Never rendered as text.
   */
  probed: number | null
  /** Provider candidates the service skipped on this list's pages (InventoryPage.candidatesSkipped, summed; reset on page 1). Absent or null counts as none. Never rendered as text. */
  skipped: number
  /** Last non-null skippedReason of those pages: a closed contract code, for data attributes only. */
  skippedReason: string | null
}

export interface Pager<V> {
  first(signal?: AbortSignal): Promise<PageStep<V>>
  more(signal?: AbortSignal): Promise<PageStep<V>>
  view(): V
}

export interface WalletPager extends Pager<WalletView> {
  /**
   * Adds the held balances a by-address check (autoDiscover: false) found for
   * `asked`: non-zero amounts only, for addresses asked about only. Never
   * touches the handle, the notes, the freshness lines, the page count or the
   * unavailable list. A later page that lists the same token replaces the row.
   */
  adopt(outcome: Extract<ReadOutcome<'wallet-assets'>, { state: 'ok' }>, asked: readonly string[]): WalletView
}

export function createWalletPager(source: ReadSource, request: WalletAssetsRequest): WalletPager {
  const base: WalletAssetsRequest = { ...request }
  delete base.cursor
  let cursor: OpaqueCursor | null = null
  let pages = 0
  let restarted = false
  const rows = new Map<string, WalletRow>()
  let unavailable: ItemView[] = []
  let notes: string[] = []
  let freshness: string[] = []
  let probed: number | null = null
  let skipped = 0
  let skippedReason: string | null = null

  const view = (): WalletView => ({ rows: [...rows.values()], unavailable, notes, freshness, pages, hasMore: cursor !== null, restarted, probed, skipped, skippedReason })

  function absorb(outcome: Extract<ReadOutcome<'wallet-assets'>, { state: 'ok' }>, page: number): number {
    const d = outcome.data
    const inventory = d.inventory
    const retrievedAt = inventory.status === 'page_received' ? inventory.retrievedAt : d.snapshot.timestamp
    if (page === 1) {
      probed = null
      skipped = 0
      skippedReason = null
    }
    if (inventory.status === 'page_received') {
      if (typeof inventory.candidatesProbed === 'number') probed = (probed ?? 0) + inventory.candidatesProbed
      const here = inventory.candidatesSkipped ?? 0
      if (here > 0) {
        skipped += here
        skippedReason = inventory.skippedReason ?? skippedReason
      }
    }
    let added = 0
    for (const item of d.items) {
      const key = identityKey(item.address)
      if (!rows.has(key) || rows.get(key)?.old) added += 1
      rows.set(key, { key, token: tokenDisplay(item), amount: amountFact(item), raw: item.amountRaw, page, pageRetrievedAt: retrievedAt, old: false, via: 'page', block: d.snapshot.number })
    }
    unavailable = d.unavailableAssets.map((asset) => ({
      key: identityKey(asset.currency),
      title: { label: 'Token', text: '', state: 'unavailable', tokens: [unreadToken(asset.currency)] },
      facts: [{ label: 'Balance', text: `Unavailable: ${reasonText(asset.reason)}`, state: 'unavailable' }],
    }))
    notes = [inventoryNote(inventory), 'Balances read from the chain at one block. Anyone can see them; they don’t prove who controls the wallet.'].filter((note): note is string => note !== null)
    freshness = freshnessLines(outcome.observation)
    cursor = inventory.status === 'page_received' && inventory.hasMore && inventory.nextCursor !== null ? (inventory.nextCursor as OpaqueCursor) : null
    pages = page
    return added
  }

  function adopt(outcome: Extract<ReadOutcome<'wallet-assets'>, { state: 'ok' }>, asked: readonly string[]): WalletView {
    const d = outcome.data
    const wanted = new Set(asked.map((address) => identityKey(address)))
    for (const item of d.items) {
      const key = identityKey(item.address)
      // Only what was asked about, and only a balance someone holds: a zero or the native row adds nothing.
      if (!wanted.has(key) || item.amountRaw === '0') continue
      const existing = rows.get(key)
      if (existing && !existing.old) continue
      rows.set(key, { key, token: tokenDisplay(item), amount: amountFact(item), raw: item.amountRaw, page: Math.max(pages, 1), pageRetrievedAt: d.snapshot.timestamp, old: false, via: 'address', block: d.snapshot.number })
    }
    return view()
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

  return { first, more, view, adopt }
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
