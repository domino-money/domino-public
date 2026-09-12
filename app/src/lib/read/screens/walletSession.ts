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
 * - An empty list when no token addresses were given gets a hint to add some:
 *   a server without inventory discovery lists only what it is asked about.
 */
import type { WalletAssetsRequest } from 'api-contracts/read-v1/types'
import { createWalletPager, type PageStep, type Pager, type WalletView } from '../pagers'
import type { FailedOutcome, ReadSource } from '../types'
import { withReadBudget } from './screenRead'

export interface WalletContext {
  /** Exactly as typed, validated. */
  wallet: string
  /** Exactly as typed, validated, at most 10. */
  tokens: string[]
}

export const WALLET_PAGE_CAP = 5
export const HANDLE_RETRY_WINDOW_MS = 300_000 - 15_000

export type WalletStatus = 'idle' | 'loading' | 'ready' | 'failed' | 'busy' | 'restart_exhausted' | 'handle_expired'

export interface WalletSnapshot {
  view: WalletView
  status: WalletStatus
  failure: FailedOutcome | null
  capped: boolean
  /** More pages exist and Load more may ask for one. */
  canLoadMore: boolean
  emptyHint: boolean
  /** The pager restarted after an expired handle, or the list was started again. */
  restarted: boolean
}

/** Fixed key order: the scheduler coalesces by the request's JSON. */
export function walletRequest(context: WalletContext): WalletAssetsRequest {
  return context.tokens.length > 0 ? { wallet: context.wallet, tokens: [...context.tokens], autoDiscover: true } : { wallet: context.wallet, autoDiscover: true }
}

export interface WalletSession {
  first(signal?: AbortSignal): Promise<WalletSnapshot>
  more(signal?: AbortSignal): Promise<WalletSnapshot>
  /** A fresh list, by choice, after the restart was exhausted. */
  restart(signal?: AbortSignal): Promise<WalletSnapshot>
  snapshot(): WalletSnapshot
}

export function createWalletSession(source: ReadSource, context: WalletContext, now: () => number = () => Date.now()): WalletSession {
  // Every page of this list is a screen read: first, more and each restart are
  // bounded by the same 60 s budget, time spent queued included. The pager
  // reads through the source it is handed, so the bound goes on the source.
  const budgeted = withReadBudget(source)
  let pager: Pager<WalletView> = createWalletPager(budgeted, walletRequest(context))
  let view = pager.view()
  let status: WalletStatus = 'idle'
  let failure: FailedOutcome | null = null
  let lastOkAt: number | null = null
  let startedAgain = false

  const expired = () => failure !== null && lastOkAt !== null && now() >= lastOkAt + HANDLE_RETRY_WINDOW_MS

  const snapshot = (): WalletSnapshot => {
    const shownStatus: WalletStatus = status === 'failed' && expired() ? 'handle_expired' : status
    const capped = view.pages >= WALLET_PAGE_CAP && view.hasMore
    return {
      view,
      status: shownStatus,
      failure,
      capped,
      canLoadMore: view.hasMore && !capped && status !== 'loading' && status !== 'restart_exhausted',
      emptyHint: status === 'ready' && view.rows.length === 0 && view.unavailable.length === 0 && context.tokens.length === 0,
      restarted: view.restarted || startedAgain,
    }
  }

  function absorb(step: PageStep<WalletView>, before: WalletStatus): WalletSnapshot {
    view = step.view
    const f = step.failure
    if (f === null) {
      failure = null
      status = 'ready'
      lastOkAt = now()
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
    status = 'idle'
    return first(signal)
  }

  return { first, more, restart, snapshot }
}
