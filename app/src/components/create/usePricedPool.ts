import { useEffect, useMemo, useRef, useState } from 'react'
import { poolOnOtherChain } from '../../lib/create/otherChains'
import { useKeyedRead, usePoolPrices, type PayFacts } from '../../lib/create/poolPrices'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import type { TokenDisplay } from '../../lib/read/types'
import { useWalletIdentity } from '../../lib/walletIdentity'
import { usdgSide } from './valuation'

/**
 * Added 2026-10-06 (the owner: "USD estimate unavailable" for ETH/CASHCAT, AI/PONS and CASHCAT/AI on Robinhood Chain):
 * whether the chosen pool's USD needs its currencies' qualified prices read: a Robinhood Chain pool that is not a USDG
 * pair (a USDG pair is valued at its own price, 1 USDG = $1) and carries none yet (Base's and Arbitrum One's rows come
 * with theirs).
 */
export const wantsPrices = (pool: PoolOption): boolean => !poolOnOtherChain(pool) && usdgSide(pool) === null && pool.usdPrices === undefined

/**
 * The chosen pool with its currencies' qualified USD prices (PoolOption `usdPrices`), read once for it by Domino's service
 * where this page offers that read (lib/create/poolPrices.ts), so the amount step, the preview and Review value its
 * amounts (./valuation.ts usdOf). The pool itself while nothing is to be read, until the prices arrive, or when they could
 * not be read: nothing is shown in their place ("USD estimate unavailable", as before). Keyed by the pool's id (its two
 * currencies are part of it), never by the pool's value (a price read again hands a new one), so a pool read again keeps
 * its prices.
 */
export function usePricedPool(pool: PoolOption | null): PoolOption | null {
  const prices = usePoolPrices()
  // Read only for a key, which says there is a pool and a reader.
  const usd = useKeyedRead(pool && prices && wantsPrices(pool) ? pool.key : null, (signal) => prices!.read(pool!, signal))
  return useMemo(() => (pool && pool.usdPrices === undefined && usd ? { ...pool, usdPrices: usd } : pool), [pool, usd])
}

/**
 * Added 2026-10-06 (the owner, on production: AI/PONS and CASHCAT/AI short on Robinhood Chain, and no offer at all, since
 * neither token is one a deposit from another network delivers): what paying the chosen pool's deposit with one other
 * token would be for the connected wallet (lib/create/poolPrices.ts PayFacts), read once per pool, wallet and `revision`
 * (funds that arrived read it again); null where none is offered, undefined while it is read or with nothing to read.
 */
export function usePayFacts(pool: PoolOption | null, revision: number, selected: TokenDisplay | null = null): PayFacts | null | undefined {
  const prices = usePoolPrices()
  const identity = useWalletIdentity()
  const owner = identity.kind === 'connected' ? identity.address : null
  // Read only for a key, which says there is a pool, a reader and a wallet; said again when a later read changes it.
  return useKeyedRead(prices && pool && owner ? `${pool.currencies[0].chainId}|${pool.key}|${owner}|${selected?.address ?? 'offer'}|${revision}` : null, (signal, later) => prices!.pay(pool!, owner!, signal, later, selected))
}

/** Visible Amount keeps its price current. The caller preserves the typed token, amount and ticks. */
export function useLivePoolPrice(pool: PoolOption | null, active: boolean, revision: number, onPool: (pool: PoolOption) => void): boolean {
  const prices = usePoolPrices()
  const latest = useRef({ pool, onPool })
  const [pending, setPending] = useState(false)
  useEffect(() => { latest.current = { pool, onPool } })
  const key = pool ? `${pool.currencies[0].chainId}|${pool.key}` : null
  useEffect(() => {
    if (!key || !active || !prices?.refresh) return
    const controller = new AbortController()
    let busy = false
    let last = 0
    const read = async () => {
      if (document.hidden || busy || controller.signal.aborted || Date.now() - last < 20_000) return
      const current = latest.current.pool
      if (!current) return
      busy = true
      last = Date.now()
      setPending(true)
      try {
        const fresh = await prices.refresh!(current, controller.signal)
        if (fresh && !controller.signal.aborted) latest.current.onPool(fresh)
      } catch { /* The previous dated price remains; the next bounded read can recover. */ }
      finally { busy = false; if (!controller.signal.aborted) setPending(false) }
    }
    void read()
    const timer = setInterval(() => void read(), 30_000)
    const wake = () => { void read() }
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', wake)
    return () => {
      controller.abort()
      clearInterval(timer)
      window.removeEventListener('focus', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [key, active, revision, prices])
  return active && key !== null && prices?.refresh !== undefined && pending
}
