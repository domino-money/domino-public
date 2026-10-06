import { useMemo } from 'react'
import { poolOnOtherChain } from '../../lib/create/otherChains'
import { useKeyedRead, usePoolPrices, type PayFacts } from '../../lib/create/poolPrices'
import type { PoolOption } from '../../lib/read/screens/poolsList'
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
  return useMemo(() => (pool && usd ? { ...pool, usdPrices: usd } : pool), [pool, usd])
}

/**
 * Added 2026-10-06 (the owner, on production: AI/PONS and CASHCAT/AI short on Robinhood Chain, and no offer at all, since
 * neither token is one a deposit from another network delivers): what paying the chosen pool's deposit with one other
 * token would be for the connected wallet (lib/create/poolPrices.ts PayFacts), read once per pool, wallet and `revision`
 * (funds that arrived read it again); null where none is offered, undefined while it is read or with nothing to read.
 */
export function usePayFacts(pool: PoolOption | null, revision: number): PayFacts | null | undefined {
  const prices = usePoolPrices()
  const identity = useWalletIdentity()
  const owner = identity.kind === 'connected' ? identity.address : null
  // Read only for a key, which says there is a pool, a reader and a wallet; said again when a later read changes it.
  return useKeyedRead(prices && pool && owner ? `${pool.key}|${owner}|${revision}` : null, (signal, later) => prices!.pay(pool!, owner!, signal, later))
}
