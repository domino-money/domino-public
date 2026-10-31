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
  /** Current price of this pool through read services; never changes wallet networks. */
  refresh?: (pool: PoolOption, signal: AbortSignal) => Promise<PoolOption | null>
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
   * Changed on purpose 2026-10-30 (launch capacity, item 9a, its review): `background` is true for the journey's read
   * again on Amount's tick, where an implementation may reuse what it already read for this visit (Ethereum's and OP
   * Mainnet's holdings); false or left out for the first read and every deliberate read again (funds arrived, Review's
   * re-reads), which ask everything again.
   */
  pay: (pool: PoolOption, owner: string, signal: AbortSignal, later: (facts: PayFacts | null) => void, selected?: TokenDisplay | null, background?: boolean) => Promise<PayFacts | null>
}

/** An observed payment asset and its qualified price. Null balances remain unknown, never zero. */
export interface PayOption {
  token: TokenDisplay
  raw: bigint | null
  /** Native balance on the destination, independent of the selected wallet network. */
  nativeRaw?: bigint | null
  usd: string | null
  /** Networks with observed eligible source funds; a route still needs a quote. */
  origins?: readonly number[]
  /** Retained for display after an unread refresh; cannot authorize Review until read again. */
  stale?: boolean
}

export interface PayFacts extends PayOption {
  alternatives?: readonly PayOption[]
  /** Destination tokens actually read, including confirmed zero balances. */
  observedTokens?: readonly string[]
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
 * Changed on purpose 2026-10-30 (launch capacity, item 9a): `everyMs` is optional. Without it nothing is read on a timer
 * or on focus: a new `revision` asks again, keeping the key's answer until the new one is in. Its review: and a new
 * `tick` (the caller's one tick) asks again in the background, without cutting short a read already out (it is then left
 * to finish, and the tick asks nothing). `read` hears whether it is such a background read (a timer's, a focus' or a
 * tick's) or the first read of a key or `revision`.
 */
export function useKeyedRead<T>(key: string | null, read: (signal: AbortSignal, later: (value: T) => void, background: boolean) => Promise<T>, refresh?: { everyMs?: number; revision: number; tick?: number; reconcile?: (previous: T | undefined, next: T) => T; onError?: (previous: T | undefined) => T }): T | undefined {
  const [got, setGot] = useState<{ key: string; value: T } | null>(null)
  const latest = useRef(read)
  const reconcile = useRef(refresh?.reconcile)
  const unavailable = useRef(refresh?.onError)
  const refreshMs = refresh?.everyMs
  const refreshRevision = refresh?.revision
  const refreshTick = refresh?.tick ?? 0
  // The running effect's ask, for the caller's tick.
  const asker = useRef<((background: boolean) => void) | null>(null)
  useEffect(() => {
    latest.current = read
    reconcile.current = refresh?.reconcile
    unavailable.current = refresh?.onError
  })
  useEffect(() => {
    if (key === null) return
    const controller = new AbortController()
    let busy = false
    let last = -Infinity
    let generation = 0
    const keep = (value: T) => {
      const merge = reconcile.current
      if (!controller.signal.aborted) setGot((previous) => ({ key, value: merge ? merge(previous?.key === key ? previous.value : undefined, value) : value }))
    }
    const ask = (background: boolean) => {
      if (busy || controller.signal.aborted || (refreshMs !== undefined && document.hidden) || Date.now() - last < 10_000) return
      busy = true
      last = Date.now()
      const mine = ++generation
      const publish = (value: T) => { if (mine === generation) keep(value) }
      let replaced = false
      void latest.current(controller.signal, (value) => {
        replaced = true
        publish(value)
      }, background).then((value) => { if (!replaced) publish(value) }, () => {
        const retain = unavailable.current
        if (!replaced && !controller.signal.aborted && mine === generation && retain) {
          setGot((previous) => ({ key, value: retain(previous?.key === key ? previous.value : undefined) }))
        }
      }).finally(() => { busy = false })
    }
    const again = () => ask(true)
    asker.current = ask
    ask(false)
    const timer = refreshMs !== undefined ? setInterval(again, refreshMs) : null
    if (refreshMs !== undefined) {
      window.addEventListener('focus', again)
      document.addEventListener('visibilitychange', again)
    }
    return () => {
      if (asker.current === ask) asker.current = null
      controller.abort()
      if (timer !== null) clearInterval(timer)
      window.removeEventListener('focus', again)
      document.removeEventListener('visibilitychange', again)
    }
  }, [key, refreshMs, refreshRevision])
  // Declared after the effect above, so a tick drawn with a new key or revision finds that read already out and asks nothing.
  useEffect(() => {
    if (refreshTick > 0) asker.current?.(true)
  }, [refreshTick])
  return got !== null && got.key === key ? got.value : undefined
}
