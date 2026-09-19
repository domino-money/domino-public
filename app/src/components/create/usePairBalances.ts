import { useEffect, useState } from 'react'
import { budgetFields, pairBalances, pairTokens, type BudgetFields, type CurrencyBalance } from '../../lib/create/budgets'
import { parseAddressInput } from '../../lib/read/screens/identity'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import { createWalletSession, type WalletSnapshot } from '../../lib/read/screens/walletSession'
import type { ReadSource } from '../../lib/read/types'
import { useWalletIdentity } from '../../lib/walletIdentity'

/**
 * The connected wallet's balance of both of a pool's currencies, from one
 * wallet read that asks for exactly those two addresses.
 *
 * A position holds both currencies, so both are read together: the one an
 * amount is typed in and the one the service derives. The wallet is known
 * only through the published identity — an address the header's control
 * reports, which proves nothing about who controls it — and a balance is
 * public chain data at one block. Nothing here signs, approves or moves
 * anything.
 *
 * **What the read is keyed by, and why it matters.** The pool *value* is
 * rebuilt every time its price is read again (`useStalePriceRead` hands the
 * page a fresh `PoolOption`), so keying the read on that object restarts it
 * on every re-read and it never finishes. It is keyed on the wallet, the pool
 * id and the two addresses — all strings — and the page it answers is kept as
 * it arrived. The balances are derived from it with the *current* pool at
 * render, so decimals and symbols are always the ones on screen.
 *
 * A read that fails is not asked again from here: the caller shows what it
 * has, and what depends on a budget goes on without one.
 */
export interface PairBalancesState {
  status: 'disconnected' | 'waiting' | 'loading' | 'ready'
  /** In pool order, once a page answered; null when the read could not answer at all. */
  balances: readonly [CurrencyBalance, CurrencyBalance] | null
  /** The optional preview fields these balances support; empty until then. */
  budgets: BudgetFields
}

const NOTHING: PairBalancesState = { status: 'waiting', balances: null, budgets: {} }

export function usePairBalances(source: ReadSource | null, pool: PoolOption | null): PairBalancesState {
  const identity = useWalletIdentity()
  const connected = identity.kind === 'connected' ? identity.address : null
  const parsed = connected === null ? null : parseAddressInput(connected)
  const wallet = parsed?.ok ? parsed.wire : null
  const poolKey = pool?.key ?? null
  const tokensKey = pool ? pairTokens(pool).join(',') : ''
  // Keyed by what the read was about: a page for another wallet or pool is never shown.
  const target = `${wallet ?? ''}|${poolKey ?? ''}|${tokensKey}`
  const [page, setPage] = useState<{ target: string; snapshot: WalletSnapshot | null } | null>(null)

  useEffect(() => {
    if (!source || wallet === null || poolKey === null || tokensKey === '') return
    const controller = new AbortController()
    const at = `${wallet}|${poolKey}|${tokensKey}`
    const settle = (snapshot: WalletSnapshot | null) => {
      if (!controller.signal.aborted) setPage({ target: at, snapshot })
    }
    const session = createWalletSession(source, { wallet, tokens: tokensKey.split(',') })
    // A read that could not even answer settles as answering nothing, never as a
    // wait without an end: what waits on a budget must be able to go on without one.
    void session
      .first(controller.signal)
      .then(settle)
      .catch(() => settle(null))
    return () => controller.abort()
  }, [source, wallet, poolKey, tokensKey])

  if (connected === null || wallet === null) return { ...NOTHING, status: 'disconnected' }
  if (!source || !pool) return NOTHING
  if (page?.target !== target) return { ...NOTHING, status: 'loading' }
  const balances = page.snapshot ? pairBalances(page.snapshot, pool) : null
  return { status: 'ready', balances, budgets: balances ? budgetFields(balances) : {} }
}
