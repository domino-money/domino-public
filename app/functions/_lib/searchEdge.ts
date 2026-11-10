/**
 * Token search at the edge: POST /api/read/v3/search, answered by the read Worker through the fixed forwarder, an answer
 * kept a few seconds, then served stale behind (publicEdge.ts has the rules). Added 2026-11-07 (edge hardening, after
 * rugged97's attack test of the open site: search was the read that reached the VM most often, 222 times, since nothing
 * kept it; every answer was one more of the VM's eight stored lanes, for any address that asked).
 *
 * Why it may be kept: search reads the catalogue of known verified tokens only (backend/public_observations.py search),
 * the same for every visitor; it reads no wallet and starts no collection (backend/public_data_service.py search: one
 * stored read). The catalogue changes when a token is verified, which takes minutes; the page keeps what each search
 * answered for itself already (lib/read/screens/searchAnswers.ts).
 *
 * The question, in one spelling (searchQuery): the producer cuts the spaces around a query and compares it with each
 * token's address and symbol case-blind (`strip()`, then ILIKE on a prefix), so a query told apart only by the spaces
 * strip() cuts around it or by the case of its ASCII letters is answered with the same tokens; only those are joined. A query of
 * other letters keeps its own case (no folding of letters the producer and this edge might fold apart). The limit is
 * the request's, or read-v3's default, 20 (what the page sends: SEARCH_LIMIT). The answer echoes the query as asked
 * (`query`, which read-v3's matchesRequest holds to the request), so a kept answer is served with the asker's own query
 * in it (`serve`), and checked with the runtime against the very request before it leaves, like every kept answer.
 *
 * For how long: SEARCH_SECONDS as it is, then up to SEARCH_STALE_SECONDS in all while the request that found it older
 * refreshes it behind, and up to SEARCH_ERROR_SECONDS it stands in for a failure of the VM's, or for an answer slower than
 * SEARCH_ERROR_WAIT_MS (stale-if-error; publicEdge.ts; a 429 stands in only for the visitor it was given to). Every valid
 * answer is kept, one that lists no token too: a query that finds nothing is asked again just as often.
 *
 * What it adds (review of 2026-11-07): the producer keeps no copy of a search, but the page keeps each answer 60 s from
 * when it came (lib/read/screens/searchAnswers.ts), so a token verified a moment ago may be missing from a search for up
 * to SEARCH_STALE_SECONDS plus the page's 60 s, about two minutes; a token's verification itself takes minutes.
 *
 * Unchanged for the page: the same body, the same headers (an answer from the edge says `X-Domino-Edge-Cache: hit` and
 * its age, as the overview's and the history's do, which the page already reads), the same refusals (a request the
 * Worker would refuse is forwarded to it and answered by it, never kept).
 *
 * The runtime comes in as `contract`, so this module compiles for node --test without it; functions/api/read/v3/
 * search.ts hands in the real one.
 */
import { APP_ORIGIN, type BridgeEnv } from './bridge'
import { answerFromEdge, type EdgeRuntime } from './publicEdge'

/** What this route needs from api-contracts/read-v3/runtime.mjs. */
export interface SearchContract {
  CONTRACT_VERSION: string
  validateRequest(route: 'search', value: unknown): boolean
  validateResponse(route: 'search', value: unknown): boolean
  matchesRequest(route: 'search', request: never, response: never): boolean
}

export interface SearchRuntime extends EdgeRuntime {
  contract: SearchContract
}

export const SEARCH_PATH = '/api/read/v3/search'
/** read-v3's search `limit` when a request names none (its request schema's default; the page's SEARCH_LIMIT too). */
export const SEARCH_DEFAULT_LIMIT = 20
/** How long a kept answer is served as it is. */
export const SEARCH_SECONDS = 20
/** How long a kept answer is served at once, refreshed behind once it is no longer fresh. */
export const SEARCH_STALE_SECONDS = 60
/** How long a kept answer stands in for a failure of the VM's (stale-if-error), in all. */
export const SEARCH_ERROR_SECONDS = 15 * 60
/** The longest a request whose kept answer is past SEARCH_STALE_SECONDS waits for the VM before that answer stands in. */
export const SEARCH_ERROR_WAIT_MS = 1_000

/**
 * The spaces around a query that Python's str.strip() cuts (every character str.isspace() holds a space, Python 3.12:
 * the ASCII ones, the separators U+001C to U+001F, U+0085, the no-break space and the Unicode spaces and line and
 * paragraph separators), so a query cut of them here reads to the producer as the query itself did. Review of 2026-11-07:
 * the ASCII ones alone before, so a query with a no-break space around it was one more question for the VM. Not
 * U+FEFF, which strip() keeps (and JavaScript's trim() cuts): such a query stays a question of its own.
 */
// oxlint-disable-next-line no-control-regex -- U+001C to U+001F are spaces to Python's strip(): cut here on purpose
const AROUND = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g
const ASCII_UPPER = /[A-Z]/g

/**
 * A query in the one spelling its answer has: without the spaces strip() cuts around it, its ASCII letters in lower case. Two
 * queries with one spelling are answered with the same tokens by the producer (see the header); no other two are joined.
 */
export function searchQuery(query: string): string {
  return query.replace(AROUND, '').replace(ASCII_UPPER, (letter) => letter.toLowerCase())
}

interface Asked { query: string; limit?: number }

/** The synthetic GET names the validated app origin, the contract version and the question in its one spelling. */
export const searchKey = (version: string, asked: Asked, origin = APP_ORIGIN) =>
  `${origin}/api/read/v3/cache/${encodeURIComponent(version)}/search/${encodeURIComponent(JSON.stringify([searchQuery(asked.query), asked.limit ?? SEARCH_DEFAULT_LIMIT]))}`

/** A kept answer with the asker's own query in it; the same text when it already has it. */
export function servedSearch(body: unknown, text: string): string | null {
  const query = (body as Asked | null)?.query
  if (typeof query !== 'string') return null
  const data = JSON.parse(text) as { query?: unknown } | null
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  return data.query === query ? text : JSON.stringify({ ...data, query })
}

export function answerSearch(request: Request, env: BridgeEnv, rt: SearchRuntime): Promise<Response> {
  const { contract } = rt
  const answers = (body: unknown, text: string) => {
    try {
      const data = JSON.parse(text)
      return contract.validateResponse('search', data) && contract.matchesRequest('search', body as never, data as never)
    } catch {
      return false
    }
  }
  return answerFromEdge(request, env, rt, {
    path: SEARCH_PATH,
    version: contract.CONTRACT_VERSION,
    // A query of spaces alone is the producer's refusal (it cuts them first): asked of the Worker, never kept.
    keyOf: (body, origin) => (contract.validateRequest('search', body) && searchQuery((body as Asked).query) !== '' ? searchKey(contract.CONTRACT_VERSION, body as Asked, origin) : null),
    answers,
    serve: (body, text) => servedSearch(body, text),
    freshSeconds: SEARCH_SECONDS,
    staleSeconds: SEARCH_STALE_SECONDS,
    errorSeconds: SEARCH_ERROR_SECONDS,
    errorWaitMs: SEARCH_ERROR_WAIT_MS,
  })
}
