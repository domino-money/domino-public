import { useEffect, useMemo, useRef, useState } from 'react'
import { poolOnOtherChain } from '../../lib/create/otherChains'
import { useKeyedRead, usePoolPrices, type PayFacts } from '../../lib/create/poolPrices'
import { reconcilePayFacts, unavailablePayFacts } from '../../lib/create/payFunding'
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

/** Observed funding alternatives, refreshed with each new `revision` (the journey's deliberate reads again: funds arrived,
 * Review's re-reads) and each new `tick` (Amount's background read again). Background reads retain the current
 * owner/token facts; changing wallet or payment token immediately invalidates the previous scope. Changed on purpose
 * 2026-10-30 (launch capacity, item 9a): no timer or focus read of its own (it read every 30 s on every step, and again on
 * each focus); the journey's one tick asks it. Its review: the tick apart from `revision`, so the reader hears which kind
 * of read it is asked (PoolPrices `pay`'s `background`). */
export function usePayFacts(pool: PoolOption | null, revision: number, selected: TokenDisplay | null = null, tick = 0): PayFacts | null | undefined {
  const prices = usePoolPrices()
  const identity = useWalletIdentity()
  const owner = identity.kind === 'connected' ? identity.address : null
  // Read only for a key, which says there is a pool, a reader and a wallet; said again when a later read changes it.
  return useKeyedRead(prices && pool && owner ? `${pool.currencies[0].chainId}|${pool.key}|${owner}|${selected?.address ?? 'offer'}` : null, (signal, later, background) => prices!.pay(pool!, owner!, signal, later, selected, background), { revision, tick, reconcile: reconcilePayFacts, onError: unavailablePayFacts })
}

/**
 * Visible Amount keeps its price current. The caller preserves the typed token, amount and ticks. Changed on purpose
 * 2026-10-30 (QA round 2, N18): read once as soon as `active` (Range on, so Amount's first figure is paired on a fresh
 * price); the reads again only while `repeat` (Amount, as before). Switching `repeat` restarts nothing, so the
 * read already asked is neither cut short nor asked twice. Its review: when `repeat` turns on (Amount opens), the price
 * is read again at once unless the last read is under 20 s old, so time spent on Range never leaves Amount on an old
 * price until the next tick.
 * Changed on purpose 2026-10-30 (launch capacity, item 9a): the reads again come from the journey's one tick (`tick`),
 * with no timer or focus read of their own, and they are background reads: the price on screen stays until the new one
 * is in, and the returned flag (which holds Continue as "Checking the price…") is raised only by the first read of an
 * activation or of a new `revision`, never by a read again.
 */
export function useLivePoolPrice(pool: PoolOption | null, active: boolean, revision: number, onPool: (pool: PoolOption) => void, repeat = true, tick = 0): boolean {
  const prices = usePoolPrices()
  const latest = useRef({ pool, onPool, repeat })
  const [pending, setPending] = useState(false)
  useEffect(() => { latest.current = { pool, onPool, repeat } })
  // The running read of the effect below, for the moment `repeat` turns on.
  const reader = useRef<((again?: boolean) => Promise<void>) | null>(null)
  const key = pool ? `${pool.currencies[0].chainId}|${pool.key}` : null
  useEffect(() => {
    if (!key || !active || !prices?.refresh) return
    const controller = new AbortController()
    let busy = false
    let last = 0
    const read = async (again = false) => {
      if (again && !latest.current.repeat) return
      if (document.hidden || busy || controller.signal.aborted || Date.now() - last < 20_000) return
      const current = latest.current.pool
      if (!current) return
      busy = true
      last = Date.now()
      // A read again keeps the price on screen and Continue as it is; only the first read is waited for. Any read that
      // ends clears the flag, so one left by a read cut short never outlasts the next answer.
      if (!again) setPending(true)
      try {
        const fresh = await prices.refresh!(current, controller.signal)
        if (fresh && !controller.signal.aborted) latest.current.onPool(fresh)
      } catch { /* The previous dated price remains; the next bounded read can recover. */ }
      finally { busy = false; if (!controller.signal.aborted) setPending(false) }
    }
    reader.current = read
    void read()
    return () => {
      if (reader.current === read) reader.current = null
      controller.abort()
      // A first read cut short holds nothing: the next run asks its own, or none.
      setPending(false)
    }
  }, [key, active, revision, prices])
  // Declared after the effect above, so on a first render with both on, its own read is already out and this one waits.
  useEffect(() => {
    if (repeat) void reader.current?.(true)
  }, [repeat])
  // The journey's tick (launch capacity 9a): a read again in the background, while `repeat`.
  useEffect(() => {
    if (tick > 0) void reader.current?.(true)
  }, [tick])
  return active && key !== null && prices?.refresh !== undefined && pending
}
