/**
 * A wallet listing on a read screen: slice A's wallet pager, with the rules a
 * screen adds on top. The continuation handle stays inside A's pager; nothing
 * here can reach it.
 *
 * - At most 5 pages, then "Showing the first 5 pages".
 * - After a failed page, Load more asks for the same page again while the
 *   handle can still be alive (300 s from the last good page, less a margin);
 *   after that, it starts the list again rather than send a dead handle.
 * - A's pager restarts once on an expired handle (400). A second 400 is
 *   `restart_exhausted`: restarting again is the person's choice, never a loop.
 * - A full cursor table is a 429, which is `busy`.
 * - A finished list that shows no token the address holds, when no token
 *   addresses were given, gets a hint to add some. Native ETH is on every page
 *   whatever the provider listed and a zero balance holds nothing, so neither
 *   counts: a server without inventory discovery lists only what it is asked
 *   about, and a provider page can list nothing for an address that holds a lot.
 * - A page that skipped provider candidates (InventoryPage.candidatesSkipped)
 *   cannot be completed by paging: the skipped addresses are not in the reply,
 *   and the next handle starts after them (backend/read_service.py). So the
 *   tokens the app already knows by address (the selected pools') that the
 *   list lacks are checked once, by exact address and without discovery, and
 *   only balances someone holds are added. Nothing about it is said on screen.
 *   A check already on the wire is joined, never asked for twice.
 */
import type { WalletAssetsRequest } from 'api-contracts/read-v1/types'
import { createWalletPager, type PageStep, type WalletPager, type WalletView } from '../pagers'
import { identityKey } from '../project'
import type { FailedOutcome, ReadOutcome, ReadSource } from '../types'
import { NATIVE_CURRENCY } from './identity'
import { failureCode } from './quietRead'
import { withReadBudget } from './screenRead'

export interface WalletContext {
  /** Exactly as typed, validated. */
  wallet: string
  /** Exactly as typed, validated, at most 10. */
  tokens: string[]
  /**
   * Addresses to check once, by exact address, when a page skipped candidates:
   * the skipped addresses are not in the reply, and the next page's handle
   * starts after them. The selected pools' tokens, where a screen has them.
   */
  fallbackTokens?: readonly string[]
  /** Previously held addresses omitted by discovery, checked even when no candidates were reported skipped. */
  rememberedTokens?: readonly string[]
  /**
   * Whether the provider should list what else the wallet holds.
   *
   * True is right for a LISTING, where finding the holdings is the point.
   * It is wrong for a by-address check — "how much of this one token does
   * this wallet have" — where it makes the service page the whole wallet to
   * answer about one address. rugged measured that: a twenty-token page is
   * about 90 local RPC items in 17 HTTP requests plus 2 Alchemy calls, where
   * the single address alone is about 12 items in 7 requests
   * (reports/capacity-2026-09-20). The Create flow asked the expensive way
   * for every balance line it drew.
   *
   * Defaults to true, so a listing that says nothing keeps discovering.
   */
  discover?: boolean
}

export const WALLET_PAGE_CAP = 5
export const HANDLE_RETRY_WINDOW_MS = 300_000 - 15_000
/** The request schema's bound on `tokens`. */
export const WALLET_TOKENS_MAX = 10
/** Bounded by the Wallet card's memory; at most twenty exact-address batches, and stop on the first failure. */
export const WALLET_RECHECK_MAX = 200

export type WalletStatus = 'idle' | 'loading' | 'ready' | 'failed' | 'busy' | 'restart_exhausted' | 'handle_expired'

export interface WalletSnapshot {
  view: WalletView
  status: WalletStatus
  failure: FailedOutcome | null
  /** The failure's closed code, for a data attribute; null with no failure. Never printed. */
  reason: string | null
  capped: boolean
  /** More pages exist and Load more may ask for one. */
  canLoadMore: boolean
  /** The list is finished, no token addresses were given, and it shows no token the address holds (see listsHeldTokens). */
  emptyHint: boolean
  /** The pager restarted after an expired handle, or the list was started again. */
  restarted: boolean
  /** Omitted remembered holdings or skipped-candidate fallbacks remain unchecked: check() would read. */
  pendingCheck: boolean
}

/**
 * Whether a list shows a token the address holds, or may hold: a row whose
 * balance is not zero, or an asset whose balance could not be read. Native
 * ETH is left out: the service reads it for every address, whatever the
 * provider listed, so it says nothing about the tokens.
 */
export function listsHeldTokens(view: WalletView): boolean {
  const native = identityKey(NATIVE_CURRENCY)
  return view.rows.some((row) => row.key !== native && row.amount.state !== 'zero') || view.unavailable.some((item) => item.key !== native)
}

/** Fixed key order: the scheduler coalesces by the request's JSON. */
export function walletRequest(context: WalletContext): WalletAssetsRequest {
  const autoDiscover = context.discover !== false
  return context.tokens.length > 0 ? { wallet: context.wallet, tokens: [...context.tokens], autoDiscover } : { wallet: context.wallet, autoDiscover }
}

/**
 * The next by-address check for omitted remembered holdings or skipped candidates: the
 * fallback tokens not listed, not unavailable, not already asked for and not
 * native (native ETH is on every page), in their own order, at most 10; no
 * discovery and no handle. Null when no remembered/skipped candidate is left
 * to check. Fixed key order: the scheduler coalesces by the request's JSON.
 */
export function fallbackRequest(context: WalletContext, view: WalletView): WalletAssetsRequest | null {
  if (view.skipped === 0 && !context.rememberedTokens?.length) return null
  const known = new Set([
    ...view.rows.filter((row) => !row.old).map((row) => row.key),
    ...view.unavailable.map((item) => item.key),
    ...context.tokens.map((token) => identityKey(token)),
    identityKey(NATIVE_CURRENCY),
  ])
  const tokens: string[] = []
  for (const token of [...(context.rememberedTokens ?? []).slice(0, WALLET_RECHECK_MAX), ...(view.skipped > 0 ? context.fallbackTokens ?? [] : [])]) {
    const key = identityKey(token)
    if (known.has(key)) continue
    known.add(key)
    tokens.push(token)
  }
  return tokens.length > 0 ? { wallet: context.wallet, tokens: tokens.slice(0, WALLET_TOKENS_MAX), autoDiscover: false } : null
}

export interface WalletSession {
  first(signal?: AbortSignal): Promise<WalletSnapshot>
  more(signal?: AbortSignal): Promise<WalletSnapshot>
  /** A fresh list, by choice, after the restart was exhausted. */
  restart(signal?: AbortSignal): Promise<WalletSnapshot>
  /**
   * The by-address check a partial list is owed, once per list: silent,
   * whatever it answers. A call while the check is on the wire joins it and
   * sends nothing. An aborted check is owed again; any answer settles it.
   * Status and failure are never changed by it, and a page read meanwhile
   * leaves it running: give it a signal that only leaving the list aborts.
   */
  check(signal?: AbortSignal): Promise<WalletSnapshot>
  snapshot(): WalletSnapshot
}

export function createWalletSession(source: ReadSource, context: WalletContext, now: () => number = () => Date.now()): WalletSession {
  // Every page of this list is a screen read: first, more and each restart are
  // bounded by the same 60 s budget, time spent queued included. The pager
  // reads through the source it is handed, so the bound goes on the source.
  const budgeted = withReadBudget(source)
  let pager: WalletPager = createWalletPager(budgeted, walletRequest(context))
  let view = pager.view()
  let status: WalletStatus = 'idle'
  let failure: FailedOutcome | null = null
  let lastOkAt: number | null = null
  let startedAgain = false
  // The by-address check of this list has been answered.
  let checked = false
  // The check on the wire, and the pager of the list it was asked for.
  let checking: { pager: WalletPager; answer: Promise<WalletSnapshot> } | null = null

  const expired = () => failure !== null && lastOkAt !== null && now() >= lastOkAt + HANDLE_RETRY_WINDOW_MS
  const checkRunning = () => checking !== null && checking.pager === pager

  const snapshot = (): WalletSnapshot => {
    const shownStatus: WalletStatus = status === 'failed' && expired() ? 'handle_expired' : status
    const capped = view.pages >= WALLET_PAGE_CAP && view.hasMore
    return {
      view,
      status: shownStatus,
      failure,
      reason: failure ? failureCode(failure) : null,
      capped,
      canLoadMore: view.hasMore && !capped && status !== 'loading' && status !== 'restart_exhausted',
      emptyHint: status === 'ready' && !view.hasMore && context.tokens.length === 0 && !listsHeldTokens(view),
      restarted: view.restarted || startedAgain,
      pendingCheck: status === 'ready' && !checked && !checkRunning() && fallbackRequest(context, view) !== null,
    }
  }

  function absorb(step: PageStep<WalletView>, before: WalletStatus): WalletSnapshot {
    view = step.view
    const f = step.failure
    if (f === null) {
      failure = null
      status = 'ready'
      lastOkAt = now()
      // A list the pager started again from its first page is a new list: its check is owed again.
      if (view.pages === 1) checked = false
    } else if (f.state === 'aborted') {
      status = before
    } else {
      failure = f
      status = f.state === 'busy' ? 'busy' : f.state === 'restart_required' ? 'restart_exhausted' : 'failed'
    }
    return snapshot()
  }

  async function first(signal?: AbortSignal) {
    const before = status
    status = 'loading'
    return absorb(await pager.first(signal), before === 'loading' ? 'idle' : before)
  }

  async function more(signal?: AbortSignal) {
    if (status === 'loading' || status === 'restart_exhausted') return snapshot()
    if (view.pages >= WALLET_PAGE_CAP) return snapshot()
    if (expired()) {
      // A handle this old may be gone: start the list again instead of sending it.
      pager = createWalletPager(budgeted, walletRequest(context))
      startedAgain = true
      lastOkAt = null
      checked = false
      return first(signal)
    }
    const before = status
    status = 'loading'
    return absorb(await pager.more(signal), before)
  }

  async function restart(signal?: AbortSignal) {
    pager = createWalletPager(budgeted, walletRequest(context))
    view = pager.view()
    failure = null
    lastOkAt = null
    startedAgain = true
    checked = false
    status = 'idle'
    return first(signal)
  }

  async function answerCheck(reading: WalletPager, request: WalletAssetsRequest, signal?: AbortSignal): Promise<WalletSnapshot> {
    const attempted = new Set<string>()
    let next: WalletAssetsRequest | null = request
    let interrupted = false
    try {
      while (next !== null) {
        const outcome: ReadOutcome<'wallet-assets'> = await budgeted.read('wallet-assets', next, { signal })
        // An aborted check is owed again. A new list must never receive the previous one's answer.
        if (outcome.state === 'aborted' || reading !== pager) {
          interrupted = true
          break
        }
        for (const token of next.tokens ?? []) attempted.add(identityKey(token))
        if (outcome.state !== 'ok') break
        view = pager.adopt(outcome, next.tokens ?? [], Boolean(context.rememberedTokens?.length))
        // Selected-pool fallback remains one batch. Remembered holdings can span several batches;
        // each address is checked once even when a successful response cannot read its balance.
        next = fallbackRequest({ ...context, fallbackTokens: [], rememberedTokens: context.rememberedTokens?.slice(0, WALLET_RECHECK_MAX).filter((token) => !attempted.has(identityKey(token))) }, view)
      }
      if (!interrupted) checked = true
    } finally {
      if (checking?.pager === reading) checking = null
    }
    return snapshot()
  }

  function check(signal?: AbortSignal): Promise<WalletSnapshot> {
    // One check per list on the wire: a second call waits for the same answer.
    if (checking !== null && checking.pager === pager) return checking.answer
    if (status !== 'ready' || checked) return Promise.resolve(snapshot())
    const request = fallbackRequest(context, view)
    if (request === null) return Promise.resolve(snapshot())
    const entry = { pager, answer: answerCheck(pager, request, signal) }
    // answerCheck is still waiting for the read here, so this lands before it can clear the entry.
    checking = entry
    return entry.answer
  }

  return { first, more, restart, check, snapshot }
}
