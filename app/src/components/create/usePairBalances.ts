import { useEffect, useRef, useState } from 'react'
import { budgetFields, pairBalances, pairTokens, type BudgetFields, type CurrencyBalance } from '../../lib/create/budgets'
import { poolOnOtherChain, type OtherChains } from '../../lib/create/otherChains'
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

/**
 * Changed on purpose 2026-10-05 (New position on Base and Arbitrum One, lib/create/otherChains.ts): a pool on another
 * network is read there, through the wallet (`others.balances`), never through the read service, whose wallet read is
 * Robinhood Chain's (it would answer Robinhood Chain's ETH for Base's). Everything else is as before.
 */
export function usePairBalances(source: ReadSource | null, pool: PoolOption | null, others: OtherChains | null = null): PairBalancesState {
  const identity = useWalletIdentity()
  const connected = identity.kind === 'connected' ? identity.address : null
  const parsed = connected === null ? null : parseAddressInput(connected)
  const wallet = parsed?.ok ? parsed.wire : null
  const poolKey = pool?.key ?? null
  const tokensKey = pool ? pairTokens(pool).join(',') : ''
  const network = pool && poolOnOtherChain(pool) ? pool.currencies[0].chainId : null
  // Keyed by what the read was about: a page for another wallet or pool is never shown (another network's, with its chain).
  const target = network === null ? `${wallet ?? ''}|${poolKey ?? ''}|${tokensKey}` : `${wallet ?? ''}|${network}|${poolKey ?? ''}|${tokensKey}`
  const [page, setPage] = useState<{ target: string; snapshot: WalletSnapshot | null } | null>(null)
  const [read, setRead] = useState<{ target: string; balances: readonly [CurrencyBalance, CurrencyBalance] | null } | null>(null)
  // The pool as of the last draw, for the other network's read, which goes by the keys above, not by each new pool value.
  const latest = useRef(pool)
  useEffect(() => {
    latest.current = pool
  })

  useEffect(() => {
    const current = latest.current
    if (network === null || !others || wallet === null || poolKey === null || tokensKey === '' || !current) return
    const controller = new AbortController()
    const at = `${wallet}|${network}|${poolKey}|${tokensKey}`
    void others.balances(current, wallet, controller.signal).then(
      (balances) => {
        if (!controller.signal.aborted) setRead({ target: at, balances })
      },
      () => {
        if (!controller.signal.aborted) setRead({ target: at, balances: null })
      },
    )
    return () => controller.abort()
  }, [others, network, wallet, poolKey, tokensKey])

  useEffect(() => {
    if (!source || wallet === null || poolKey === null || tokensKey === '' || network !== null) return
    const controller = new AbortController()
    const at = `${wallet}|${poolKey}|${tokensKey}`
    const settle = (snapshot: WalletSnapshot | null) => {
      if (!controller.signal.aborted) setPage({ target: at, snapshot })
    }
    const session = createWalletSession(source, { wallet, tokens: tokensKey.split(','), discover: false })
    // A read that could not even answer settles as answering nothing, never as a
    // wait without an end: what waits on a budget must be able to go on without one.
    void session
      .first(controller.signal)
      .then(settle)
      .catch(() => settle(null))
    return () => controller.abort()
  }, [source, wallet, poolKey, tokensKey, network])

  if (connected === null || wallet === null) return { ...NOTHING, status: 'disconnected' }
  if (network !== null) {
    if (!others || !pool) return NOTHING
    if (read?.target !== target) return { ...NOTHING, status: 'loading' }
    return { status: 'ready', balances: read.balances, budgets: read.balances ? budgetFields(read.balances) : {} }
  }
  if (!source || !pool) return NOTHING
  if (page?.target !== target) return { ...NOTHING, status: 'loading' }
  const balances = page.snapshot ? pairBalances(page.snapshot, pool) : null
  return { status: 'ready', balances, budgets: balances ? budgetFields(balances) : {} }
}
