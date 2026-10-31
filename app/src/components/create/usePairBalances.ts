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
 *
 * Changed on purpose 2026-10-30 (launch capacity, item 9a): `tick` reads the
 * same balances again in the background. Until its answer is in, the last
 * answer stays (still `ready`, with `refreshing`), so nothing on screen flips
 * back to loading and Continue is not held. Its review: a background answer
 * replaces the last one only when it read both balances, or when the last one
 * had not; one that read nothing keeps the balances on screen, and the next
 * tick asks again. A new `revision` is a deliberate read again, which shows as
 * loading until it answers and then shows whatever it answered, as before.
 */
export interface PairBalancesState {
  status: 'disconnected' | 'waiting' | 'loading' | 'ready'
  /** In pool order, once a page answered; null when the read could not answer at all. */
  balances: readonly [CurrencyBalance, CurrencyBalance] | null
  /** The optional preview fields these balances support; empty until then. */
  budgets: BudgetFields
  /** A background read of the same balances is out (launch capacity 9a): what is shown stays until it answers. */
  refreshing?: boolean
}

const NOTHING: PairBalancesState = { status: 'waiting', balances: null, budgets: {} }

type Balances = readonly [CurrencyBalance, CurrencyBalance]

/** Both balances read to a figure (zero included): what a background read must bring to replace one that had them. */
const readBoth = (balances: Balances | null): boolean => balances !== null && balances.every((side) => side.raw !== null)

/**
 * Changed on purpose 2026-10-05 (New position on Base and Arbitrum One, lib/create/otherChains.ts): a pool on another
 * network is read there, through the wallet (`others.balances`), never through the read service, whose wallet read is
 * Robinhood Chain's (it would answer Robinhood Chain's ETH for Base's). Everything else is as before.
 */
export function usePairBalances(
  source: ReadSource | null,
  pool: PoolOption | null,
  others: OtherChains | null = null,
  /**
   * Added 2026-10-05 (the owner: a deposit from another network should finish by itself): a new number reads the
   * balances again, as when funds arrived from another network. 0 by default: read once, as before.
   */
  revision = 0,
  /** A new number reads them again in the background, keeping the last answer on screen meanwhile (launch capacity 9a). */
  tick = 0,
): PairBalancesState {
  const identity = useWalletIdentity()
  const connected = identity.kind === 'connected' ? identity.address : null
  const parsed = connected === null ? null : parseAddressInput(connected)
  const wallet = parsed?.ok ? parsed.wire : null
  const poolKey = pool?.key ?? null
  const tokensKey = pool ? pairTokens(pool).join(',') : ''
  const network = pool && poolOnOtherChain(pool) ? pool.currencies[0].chainId : null
  // Keyed by what the read was about: a page for another wallet or pool is never shown (another network's, with its chain).
  // Not by `tick`: a background read's answer stands for the same target, and the one it answered for (`tick`) says whether
  // a background read is still out.
  const target = `${network === null ? `${wallet ?? ''}|${poolKey ?? ''}|${tokensKey}` : `${wallet ?? ''}|${network}|${poolKey ?? ''}|${tokensKey}`}#${revision}`
  const [page, setPage] = useState<{ target: string; tick: number; snapshot: WalletSnapshot | null } | null>(null)
  const [read, setRead] = useState<{ target: string; tick: number; balances: Balances | null } | null>(null)
  // The pool as of the last draw, for the other network's read, which goes by the keys above, not by each new pool value.
  const latest = useRef(pool)
  useEffect(() => {
    latest.current = pool
  })

  useEffect(() => {
    const current = latest.current
    if (network === null || !others || wallet === null || poolKey === null || tokensKey === '' || !current) return
    const controller = new AbortController()
    const at = `${wallet}|${network}|${poolKey}|${tokensKey}#${revision}`
    // A background read that read nothing keeps the balances the last one read (the class comment).
    const settle = (balances: Balances | null) => {
      if (controller.signal.aborted) return
      setRead((was) => ({ target: at, tick, balances: was?.target === at && readBoth(was.balances) && !readBoth(balances) ? was.balances : balances }))
    }
    void others.balances(current, wallet, controller.signal).then(settle, () => settle(null))
    return () => controller.abort()
  }, [others, network, wallet, poolKey, tokensKey, revision, tick])

  useEffect(() => {
    if (!source || wallet === null || poolKey === null || tokensKey === '' || network !== null) return
    const controller = new AbortController()
    const at = `${wallet}|${poolKey}|${tokensKey}#${revision}`
    const readable = (snapshot: WalletSnapshot | null) => snapshot !== null && latest.current !== null && readBoth(pairBalances(snapshot, latest.current))
    // A background read that read nothing keeps the page the last one read (the class comment).
    const settle = (snapshot: WalletSnapshot | null) => {
      if (controller.signal.aborted) return
      setPage((was) => ({ target: at, tick, snapshot: was?.target === at && readable(was.snapshot) && !readable(snapshot) ? was.snapshot : snapshot }))
    }
    const session = createWalletSession(source, { wallet, tokens: tokensKey.split(','), discover: false })
    // A read that could not even answer settles as answering nothing, never as a
    // wait without an end: what waits on a budget must be able to go on without one.
    void session
      .first(controller.signal)
      .then(settle)
      .catch(() => settle(null))
    return () => controller.abort()
  }, [source, wallet, poolKey, tokensKey, network, revision, tick])

  if (connected === null || wallet === null) return { ...NOTHING, status: 'disconnected' }
  if (network !== null) {
    if (!others || !pool) return NOTHING
    if (read?.target !== target) return { ...NOTHING, status: 'loading' }
    return { status: 'ready', balances: read.balances, budgets: read.balances ? budgetFields(read.balances) : {}, refreshing: read.tick !== tick }
  }
  if (!source || !pool) return NOTHING
  if (page?.target !== target) return { ...NOTHING, status: 'loading' }
  const balances = page.snapshot ? pairBalances(page.snapshot, pool) : null
  return { status: 'ready', balances, budgets: balances ? budgetFields(balances) : {}, refreshing: page.tick !== tick }
}
