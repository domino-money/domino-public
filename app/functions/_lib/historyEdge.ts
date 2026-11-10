/**
 * A pool's stored 24h (or 7d, 30d) price history at the edge: POST /api/read/v3/history, answered by the read Worker
 * through the fixed forwarder, a built answer kept for 20 seconds (publicEdge.ts has the rules). Added 2026-09-28
 * (speed wave, item 45): the Markets cards and a pool's chart ask the very same question of the gateway for every
 * visitor, and each answer is the same for all of them.
 *
 * Kept: only an answer read-v3's runtime accepts, for the question asked, whose history is `available`. One not built
 * yet, partial or stale is passed on and never kept, so a pool whose history is being built shows it as soon as it is.
 * Changed on purpose 2026-10-15 (pack 7: every viewer of a young pool reached rugged97's gateway on every view): one not
 * built yet, partial, stale or unavailable is kept too, but briefly (publicEdge.ts `brief`): served as it is for
 * HISTORY_SECONDS and never past it, so a pool that becomes ready shows within 20 s. A refusal, an error or an answer the
 * runtime does not accept for the question is still never kept.
 * Served as it is for 20 seconds (HISTORY_SECONDS). Changed 2026-10-01 (audit A14, the owner's OK on more edge caching):
 * past that, and up to HISTORY_STALE_SECONDS (one minute in all), a kept answer is still served at once while the request
 * that found it refreshes it behind, and says how old it is (X-Domino-Edge-Age), so the chart dates it by when the edge
 * received it. The chart counts a snapshot older than two minutes as stale; a minute at the most keeps every chart as it
 * was. Before, the fifth and sixth Markets cards waited 4 to 6 s for the per-visitor budget behind misses.
 *
 * Added 2026-10-30 (launch capacity study, item 4): stale-if-error. Past its minute and up to HISTORY_ERROR_SECONDS, a
 * kept built history is no longer served at once, but it stands in for the gateway's answer when that is a failure (a
 * 408, a 429, a 5xx; publicEdge.ts), or none within HISTORY_ERROR_WAIT_MS, so a VM or tunnel outage, or a slow VM,
 * leaves the chart that was there, dated, rather than none. One not built yet (kept briefly) never stands in: it lapses
 * at HISTORY_SECONDS as before.
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
/** How long a kept history is served at all, refreshed behind once HISTORY_SECONDS old (A14, 2026-10-01). Below the chart's two minutes. */
export const HISTORY_STALE_SECONDS = 60
/** (2026-10-30) How long a kept built history stands in for a failure of the gateway's (stale-if-error), in all. */
export const HISTORY_ERROR_SECONDS = 15 * 60
/**
 * (2026-10-30, review) The longest a request whose kept history is past HISTORY_STALE_SECONDS waits for the gateway before
 * that history stands in for it (publicEdge.ts `errorWaitMs`; no extra upstream request, and the answer, when it comes,
 * is kept behind). Without it a slow VM held the chart for the read Worker's own 20 s. The stale-while-revalidate minute
 * is untouched: a history younger than HISTORY_STALE_SECONDS is served at once, as before.
 */
export const HISTORY_ERROR_WAIT_MS = 1_000

interface Asked { poolId: string; currency: string; windowSeconds?: number; resolutionSeconds?: number }

/** The history statuses read-v3 answers (api-contracts/read-v3 history.response `status`): `available`, and the not-ready ones. */
const STATUSES: ReadonlySet<unknown> = new Set(['available', 'not_built', 'partial', 'stale', 'unavailable'])

/** A valid answer's status, when it is one of those; null otherwise (2026-10-15, pack 7). */
function statusOf(text: string): string | null {
  try {
    const status = (JSON.parse(text) as { status?: unknown }).status
    return STATUSES.has(status) ? (status as string) : null
  } catch {
    return null
  }
}

/** read-v3's history window and resolution when a request names none (its request schema's defaults). */
export const HISTORY_DEFAULT_WINDOW_SECONDS = 86_400
export const HISTORY_DEFAULT_RESOLUTION_SECONDS = 3_600

/**
 * The synthetic GET names the validated app origin, contract version and question, in one order. Changed on purpose
 * 2026-11-07 (edge hardening): a window or resolution left out is the schema's default, the very question the producer
 * and read-v3's runtime read it as, so leaving it out or naming it is one question, not two reads of the VM. Every screen
 * names both (lib/read/cardReads.ts, components/read/screens/PoolHistoryChart.tsx, components/positions/visual/
 * usePoolHistory.ts), so the app's own keys are the same as before.
 */
export const historyKey = (version: string, asked: Asked, origin = APP_ORIGIN) =>
  `${origin}/api/read/v3/cache/${encodeURIComponent(version)}/history/${encodeURIComponent(JSON.stringify([asked.poolId.toLowerCase(), asked.currency.toLowerCase(), asked.windowSeconds ?? HISTORY_DEFAULT_WINDOW_SECONDS, asked.resolutionSeconds ?? HISTORY_DEFAULT_RESOLUTION_SECONDS]))}`

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
    keep: (text) => statusOf(text) !== null,
    brief: (text) => statusOf(text) !== 'available',
    freshSeconds: HISTORY_SECONDS,
    staleSeconds: HISTORY_STALE_SECONDS,
    errorSeconds: HISTORY_ERROR_SECONDS,
    errorWaitMs: HISTORY_ERROR_WAIT_MS,
  })
}
