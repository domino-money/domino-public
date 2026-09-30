/**
 * A pool's stored 24h (or 7d, 30d) price history at the edge: POST /api/read/v3/history, answered by the read Worker
 * through the fixed forwarder, a built answer kept for 20 seconds (publicEdge.ts has the rules). Added 2026-09-28
 * (speed wave, item 45): the Markets cards and a pool's chart ask the very same question of the gateway for every
 * visitor, and each answer is the same for all of them.
 *
 * Kept: only an answer read-v3's runtime accepts, for the question asked, whose history is `available`. One not built
 * yet, partial or stale is passed on and never kept, so a pool whose history is being built shows it as soon as it is.
 * Never served past 20 seconds (HISTORY_SECONDS), and never in the background: the chart counts a snapshot older than
 * two minutes as stale, and 20 seconds more than the store's own age keeps every chart as it was.
 *
 * The runtime comes in as `contract`, so this module compiles for node --test without it; functions/api/read/v3/
 * history.ts hands in the real one.
 */
import { APP_ORIGIN, type BridgeEnv } from './bridge'
import { answerFromEdge, type EdgeRuntime } from './publicEdge'

/** What this route needs from api-contracts/read-v3/runtime.mjs. */
export interface HistoryContract {
  CONTRACT_VERSION: string
  validateRequest(route: 'history', value: unknown): boolean
  validateResponse(route: 'history', value: unknown): boolean
  matchesRequest(route: 'history', request: never, response: never): boolean
}

export interface HistoryRuntime extends EdgeRuntime {
  contract: HistoryContract
}

export const HISTORY_PATH = '/api/read/v3/history'
export const HISTORY_SECONDS = 20

interface Asked { poolId: string; currency: string; windowSeconds?: number; resolutionSeconds?: number }

/** The synthetic GET names the validated app origin, contract version and question, in one order. */
export const historyKey = (version: string, asked: Asked, origin = APP_ORIGIN) =>
  `${origin}/api/read/v3/cache/${encodeURIComponent(version)}/history/${encodeURIComponent(JSON.stringify([asked.poolId.toLowerCase(), asked.currency.toLowerCase(), asked.windowSeconds ?? null, asked.resolutionSeconds ?? null]))}`

export function answerHistory(request: Request, env: BridgeEnv, rt: HistoryRuntime): Promise<Response> {
  const { contract } = rt
  const answer = (body: unknown, text: string) => {
    try {
      const data = JSON.parse(text)
      return contract.validateResponse('history', data) && contract.matchesRequest('history', body as never, data as never) ? (data as { status: string }) : null
    } catch {
      return null
    }
  }
  return answerFromEdge(request, env, rt, {
    path: HISTORY_PATH,
    version: contract.CONTRACT_VERSION,
    keyOf: (body, origin) => (contract.validateRequest('history', body) ? historyKey(contract.CONTRACT_VERSION, body as Asked, origin) : null),
    answers: (body, text) => answer(body, text) !== null,
    keep: (text) => {
      try {
        return (JSON.parse(text) as { status?: unknown }).status === 'available'
      } catch {
        return false
      }
    },
    freshSeconds: HISTORY_SECONDS,
  })
}
