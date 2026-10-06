import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { PoolOption } from '../read/screens/poolsList'
import type { TokenDisplay } from '../read/types'

/**
 * Added 2026-10-06 (the owner, on production's New position, step 3: "USD estimate unavailable" for ETH/CASHCAT, AI/PONS
 * and CASHCAT/AI, "when it is two coins that are not USD, USDG, ETH and the like, the price isn't fetched"): the qualified
 * USD prices of a Robinhood Chain pool that is not a USDG pair, as Domino's service reads them (read-v6 chain-pools, the
 * owner's decision #22, F7 §6.3: USDG at $1, ETH and WETH at Chainlink's ETH/USD, any other token through its deepest pool
 * against those with at least US$10K of depth; otherwise none, with its reason), for the amount step, the preview and
 * Review to value its amounts (components/create/valuation.ts usdOf). V1 declares the shape here and imports nothing of
 * V2; a build that carries V2 hands an implementation in around today's journey (src/v2in/journey/NewPositionV2.tsx)
 * while a network's S1 gate is live. Without one nothing is read, and every step is exactly as before.
 * Changed on purpose 2026-10-06 (the owner: AI/PONS short on Robinhood Chain and nothing offered): and what paying with
 * one other token would be (`pay`), read the same way.
 */
export interface PoolPrices {
  /**
   * The pool's two currencies' USD prices (18 decimals), in pool order, null for one without a qualified price; null when
   * none could be read (the read route off, a refusal, or a failure that did not pass after a few quiet tries).
   */
  read: (pool: PoolOption, signal: AbortSignal) => Promise<readonly [string | null, string | null] | null>
  /**
   * Added 2026-10-06: the one other token `owner` may pay the deposit with on the pool's network (`PayFacts`), which Domino
   * V2's zap swaps for the pool's two (position-plan-v1: "the pool's tokens, or exactly one other token"); null where none
   * is offered: a token of the pool is one a deposit from another network delivers (that offer stands, as before), or the
   * network's S1 gate is not live.
   * Changed on purpose 2026-10-06 (the review of rugged97's #379: it waited for a read of other networks' holdings): the
   * answer comes as soon as the pool's network's own read is in; `later` hears the offer again when a read that answers
   * after it changes it, and replaces that answer (useKeyedRead).
   */
  pay: (pool: PoolOption, owner: string, signal: AbortSignal, later: (facts: PayFacts | null) => void) => Promise<PayFacts | null>
}

/**
 * Added 2026-10-06: the token "Pay with … instead" names (the network's ETH, or its stable when the wallet holds more
 * value in dollars, there and on the other networks), with the wallet's balance of it on the pool's network, raw, and its
 * qualified USD price per whole token (18 decimals), as Domino's service read them; each null when it was not read (never
 * a zero in its place).
 */
export interface PayFacts {
  token: TokenDisplay
  raw: bigint | null
  usd: string | null
}

export const PoolPricesContext = createContext<PoolPrices | null>(null)

/** The prices reader this page offers, or null where there is none (every V1 path). */
export const usePoolPrices = (): PoolPrices | null => useContext(PoolPricesContext)

/**
 * Added 2026-10-06: what `read` answered for `key` (null: nothing to read), once in; undefined while it is read, and for
 * another key, so an answer is never shown for what it was not about. Keyed by text, never by an object a draw rebuilds;
 * `read` is the one of the last draw.
 * Changed on purpose 2026-10-06 (the review of rugged97's #379): what `read` hands `later` (a read that answered after
 * the first changed it) replaces its answer for the same key, whichever of the two arrives first.
 */
export function useKeyedRead<T>(key: string | null, read: (signal: AbortSignal, later: (value: T) => void) => Promise<T>): T | undefined {
  const [got, setGot] = useState<{ key: string; value: T } | null>(null)
  const latest = useRef(read)
  useEffect(() => {
    latest.current = read
  })
  useEffect(() => {
    if (key === null) return
    const controller = new AbortController()
    let replaced = false
    const keep = (value: T) => {
      if (!controller.signal.aborted) setGot({ key, value })
    }
    void latest.current(controller.signal, (value) => {
      replaced = true
      keep(value)
    }).then(
      (value) => {
        if (!replaced) keep(value)
      },
      () => undefined,
    )
    return () => controller.abort()
  }, [key])
  return got !== null && got.key === key ? got.value : undefined
}
