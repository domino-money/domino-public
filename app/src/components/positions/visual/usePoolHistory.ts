import { useEffect, useMemo, useState } from 'react'
import type { HistoryResponse } from 'api-contracts/read-v3/types'
import { HISTORY_RESOLUTION_SECONDS, HISTORY_WINDOW_SECONDS } from '../../../lib/chart/priceRange'
import { watchPublicHistory, type HistoryEvent } from '../../../lib/read/historyRead'
import { useReadSource } from '../../../lib/read/screens/readContext'

/** What the Price range chart asks for: the pool, the token the page prices, and the one it is priced in (lowercase). */
export interface PoolHistoryAsk {
  poolId: string
  base: string
  quote: string
}

export type PoolHistory =
  /** Nothing is asked: a pool the read service keeps no history for (another chain, Uniswap v3), or no read source. */
  | { phase: 'off' }
  | { phase: 'reading' }
  /** The deployment does not list read-v3 `history`. */
  | { phase: 'not_listed' }
  /** The read failed and nothing was drawn before; it is asked again as historyRead.ts allows. */
  | { phase: 'failed' }
  /** An answer, and when it arrived (wall ms): the last good one is kept through a failed refresh. */
  | { phase: 'answered'; data: HistoryResponse; at: number }

type Answer = { key: string; state: HistoryEvent['state']; data: HistoryResponse | null; at: number; failed: boolean }

/**
 * Added 2026-10-03 (the owner's point 10: the Price range chart "doesn't show the history"): the pool's stored hourly
 * prices over the last 7 days, from the read service (read-v3 `history`, the pool chart's and the Markets cards' own
 * source: the read service builds it from the pool's Swaps on Robinhood Chain; the page reads no node and no log for
 * it, rugged97's rule 2). Through the app's one scheduled read source (lib/read/buildMode.ts), so its queue and budget
 * pace it with every other read: the capabilities first (asked once for the document), then one read, then one a
 * minute while the page can be seen, and a failure asked again only as transient.ts allows (lib/read/historyRead.ts,
 * the pool chart's loop). The edge keeps an answer 20 s for every visitor (functions/_lib/historyEdge.ts).
 */
export function usePoolHistory(ask: PoolHistoryAsk | null): PoolHistory {
  const source = useReadSource()
  const [answer, setAnswer] = useState<Answer | null>(null)
  const poolId = ask?.poolId.toLowerCase() ?? null
  const base = ask?.base.toLowerCase() ?? null
  const quote = ask?.quote.toLowerCase() ?? null
  const key = poolId && base && quote ? `${poolId}:${base}:${quote}` : null

  useEffect(() => {
    if (!source || !poolId || !base || !key) return
    const controller = new AbortController()
    const heard = (event: HistoryEvent) => {
      if (controller.signal.aborted) return
      const at = Date.now()
      setAnswer((prior) => {
        const kept = prior?.key === key ? prior : null
        const received = event.state === 'answer' && event.outcome.state === 'ok' ? event.outcome.data : null
        const failed = event.state === 'capability_failed' || (event.state === 'answer' && event.outcome.state !== 'ok')
        return {
          key,
          state: event.state,
          data: received ?? kept?.data ?? null,
          at: received ? at : (kept?.at ?? at),
          failed: event.state === 'reading' ? kept?.failed === true : failed,
        }
      })
    }
    void watchPublicHistory(source, { poolId, currency: base, windowSeconds: HISTORY_WINDOW_SECONDS, resolutionSeconds: HISTORY_RESOLUTION_SECONDS }, heard, { signal: controller.signal })
    return () => controller.abort()
  }, [source, poolId, base, key])

  // One object per answer, so what the chart derives from it is derived once.
  const asked = ask !== null
  return useMemo<PoolHistory>(() => {
    if (!key || !source) return { phase: asked && !source ? 'reading' : 'off' }
    const current = answer?.key === key ? answer : null
    if (!current) return { phase: 'reading' }
    if (current.data) return { phase: 'answered', data: current.data, at: current.at }
    if (current.state === 'not_enabled') return { phase: 'not_listed' }
    if (current.failed) return { phase: 'failed' }
    return { phase: 'reading' }
  }, [key, source, asked, answer])
}
