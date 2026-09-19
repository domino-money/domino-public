import { useEffect, useState } from 'react'
import { budgetFields, pairBalances, pairTokens, type BudgetFields, type CurrencyBalance } from '../../lib/create/budgets'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import { parseAddressInput } from '../../lib/read/screens/identity'
import { createWalletSession } from '../../lib/read/screens/walletSession'
import type { ReadSource } from '../../lib/read/types'
import { useWalletIdentity } from '../../lib/walletIdentity'

/**
 * The connected wallet's balance of both of a pool's currencies, from one
 * wallet read that asks for exactly those two addresses.
 *
 * A deposit is funded with both currencies, so both are read together: the
 * one the person chose and the one the service will derive. One read per
 * wallet and pool, cancelled when either changes and when the caller leaves.
 * The wallet is known only through the published identity — an address the
 * header's control reports, which proves nothing about who controls it — and
 * a balance is public chain data at one block. Nothing here signs, approves
 * or moves anything.
 *
 * A read that fails is not asked again from here: the caller shows what it
 * has, and the figures that depend on a budget stay as they are without one.
 */
export interface PairBalancesState {
  status: 'disconnected' | 'waiting' | 'loading' | 'ready'
  /** In pool order, once a page answered. */
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
  // Keyed by what the read was about: a page for another wallet or pool is never shown.
  const [settled, setSettled] = useState<{ target: string; state: PairBalancesState } | null>(null)
  const target = `${wallet ?? ''}|${poolKey ?? ''}`

  useEffect(() => {
    if (!source || wallet === null || !pool) return
    const controller = new AbortController()
    const at = `${wallet}|${pool.key}`
    const session = createWalletSession(source, { wallet, tokens: pairTokens(pool) })
    void session
      .first(controller.signal)
      .then((snapshot) => {
        if (controller.signal.aborted) return
        const balances = pairBalances(snapshot, pool)
        setSettled({ target: at, state: { status: 'ready', balances, budgets: budgetFields(balances) } })
      })
      // A read that could not even answer settles as answering nothing, never as
      // a wait without an end: what waits on a budget must be able to go on
      // without one, exactly as it did before budgets were sent at all.
      .catch(() => {
        if (controller.signal.aborted) return
        setSettled({ target: at, state: { status: 'ready', balances: null, budgets: {} } })
      })
    return () => controller.abort()
  }, [source, wallet, pool, poolKey])

  if (connected === null || wallet === null) return { ...NOTHING, status: 'disconnected' }
  if (!source || !pool) return NOTHING
  if (settled?.target !== target) return { ...NOTHING, status: 'loading' }
  return settled.state
}
