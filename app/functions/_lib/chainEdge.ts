/**
 * Domino V2's two public chain reads at the edge: POST /api/read/v6/chain-pools (a token's pools on a chain) and POST
 * /api/read/v6/chain-tokens (the tokens Domino knows on Base and Arbitrum One matching a query), answered by the read
 * Worker through the fixed forwarder, an answer kept a few seconds (publicEdge.ts has the rules). Added 2026-11-07 (edge
 * hardening, after rugged97's attack test of the open site): both reached the VM on every request, and chain-pools reads
 * Base's and Arbitrum's hosted RPC, billed per call, 1.7 to 3 s a read.
 *
 * Why they may be kept: neither reads a wallet. chain-pools answers the same pools for every visitor who asks about a
 * token (and a paired token), read at the chain's head; chain-tokens answers the same tokens for every visitor who asks
 * the same query. The producer writes `servedAt`, and chain-pools' freshness from its snapshot's block time, anew on
 * every answer it gives, its cached ones too (`stamped`). The edge does exactly that with what it keeps (`serve`):
 * `servedAt` is the moment the answer leaves the edge (never earlier than the producer wrote), and chain-pools' age is
 * that moment less the snapshot's block time, `fresh` within read-v6's 60 s, as read-v6's runtime requires and checks,
 * on every answer served here, against the very request. So the page dates every pool row by its snapshot as it always
 * did (v2in/journey/model/chainReads.ts: received less `ageSeconds`), never younger than it is.
 *
 * What the edge's copy adds to the producer's own (review of 2026-11-07: they add up, they do not nest). The producer
 * keeps a chain-pools answer 15 s (backend/v2_chain_reads.py), and only the activity index's part of chain-tokens 60 s:
 * the tokens it lists or has looked up are read live. So a chain-pools snapshot served here is at most POOLS_SECONDS
 * older than one the VM itself would have served, about 20 s in all, the page's own reuse of a chain-pools answer
 * (chainReads.ts POOLS_REUSE_MS), its age always the snapshot's; and a token the VM has just looked up (an address
 * pasted) shows in a name search through the edge at most TOKENS_STALE_SECONDS later.
 *
 * Never kept: chain-balances, portfolio, activity and position-fees, which are about a wallet; no route of this module
 * answers them, and no key here names a wallet. They reach the Worker exactly as before (functions/api/[[path]].ts).
 *
 * chain-pools, for how long: POOLS_SECONDS as it is, and never past it: no stale answer, and no kept answer standing in
 * for a failure (review of 2026-11-07). Its answer is a live price, and when the VM fails the page reads the pool through
 * the wallet's own chain connection (v2in/journey/otherChains.ts), fresher than any copy kept here, so a failure reaches
 * the page exactly as before. No wait is cut short: a slow chain read is waited for, as before, and a request that joins
 * one on its way waits for it as long as it takes (publicEdge.ts: a route with no bound), so the VM is asked once and
 * every one of them gets that read's answer. The key is the version asked (the producer answers in it), the chain, the
 * token and the paired token.
 *
 * chain-tokens, for how long: TOKENS_SECONDS as it is, then up to TOKENS_STALE_SECONDS in all while the request that
 * found it older refreshes it behind, and up to TOKENS_ERROR_SECONDS it stands in for a failure (a 408, a 5xx; a 429 only
 * for the visitor it was given to) or for an answer slower than TOKENS_ERROR_WAIT_MS. The key is the version, the chain,
 * the query in its one spelling (searchEdge.ts searchQuery: the producer cuts the spaces around a query and folds its
 * case, `strip().casefold()`; the edge cuts the very spaces Python's strip() cuts and folds the ASCII letters, a part of
 * what casefold() folds) and the limit (read-v6's default, 20, when left out). The answer echoes the query as asked, so a
 * kept one is served with the asker's own query in it.
 *
 * The runtime comes in as `contract`, so this module compiles for node --test without it; functions/api/read/v6/
 * chain-pools.ts and chain-tokens.ts hand in the real one.
 */
import { APP_ORIGIN, type BridgeEnv } from './bridge'
import { answerFromEdge, type EdgeRuntime } from './publicEdge'
import { searchQuery } from './searchEdge'

type ChainRoute = 'chain-pools' | 'chain-tokens'

/** What these routes need from api-contracts/read-v6/runtime.mjs. */
export interface ChainContract {
  CONTRACT_VERSION: string
  CONTRACT_VERSIONS: readonly string[]
  validateRequest(route: ChainRoute, value: unknown): boolean
  validateResponse(route: ChainRoute, value: unknown): boolean
  validateExchange(route: ChainRoute, request: unknown, response: unknown): boolean
}

export interface ChainRuntime extends EdgeRuntime {
  contract: ChainContract
}

export const CHAIN_POOLS_PATH = '/api/read/v6/chain-pools'
export const CHAIN_TOKENS_PATH = '/api/read/v6/chain-tokens'
/** How long a kept chain-pools answer is served as it is; never past it, not even for a failure (review of 2026-11-07). */
export const POOLS_SECONDS = 5
/** How long a kept chain-tokens answer is served as it is (review of 2026-11-07: 30 s before). */
export const TOKENS_SECONDS = 10
/** How long a kept chain-tokens answer is served at once, refreshed behind once it is no longer fresh (60 s before). */
export const TOKENS_STALE_SECONDS = 30
/** How long a kept chain-tokens answer stands in for a failure of the VM's (stale-if-error), in all. */
export const TOKENS_ERROR_SECONDS = 15 * 60
/** The longest a request whose kept chain-tokens answer is past TOKENS_STALE_SECONDS waits for the VM before it stands in. */
export const TOKENS_ERROR_WAIT_MS = 1_000
/** read-v6's chain-tokens `limit` when a request names none (its request schema's default). */
export const TOKENS_DEFAULT_LIMIT = 20
/** read-v6's live reads are `fresh` this long after their snapshot's block (the producer's LIVE_FRESH_SECONDS). */
export const LIVE_FRESH_SECONDS = 60

interface PoolsAsked { chainId: number; token: string; pairedToken?: string | null }
interface TokensAsked { chainId: number; query: string; limit?: number }

/** The version a request is answered in: the one it named, else the route's first (bridge/src/worker.mjs). */
const answeredIn = (contract: ChainContract, asked: string | null) => asked ?? contract.CONTRACT_VERSION

/** The synthetic GET names the validated app origin, the version asked, the chain, the token and the paired token. */
export const chainPoolsKey = (version: string, asked: PoolsAsked, origin = APP_ORIGIN) =>
  `${origin}/api/read/v6/cache/${encodeURIComponent(version)}/chain-pools/${encodeURIComponent(JSON.stringify([asked.chainId, asked.token, asked.pairedToken ?? null]))}`

/** The synthetic GET names the validated app origin, the version asked, the chain, the query in its one spelling and the limit. */
export const chainTokensKey = (version: string, asked: TokensAsked, origin = APP_ORIGIN) =>
  `${origin}/api/read/v6/cache/${encodeURIComponent(version)}/chain-tokens/${encodeURIComponent(JSON.stringify([asked.chainId, searchQuery(asked.query), asked.limit ?? TOKENS_DEFAULT_LIMIT]))}`

type Answer = Record<string, unknown> & { servedAt?: unknown; snapshot?: { timestamp?: unknown } }

function parsed(text: string): Answer | null {
  const data = JSON.parse(text) as unknown
  return data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Answer) : null
}

/** When an answer leaving now is served: now, in whole seconds as the producer counts them, never before it said. */
function servedNow(data: Answer, nowMs: number): number | null {
  if (!Number.isSafeInteger(data.servedAt)) return null
  return Math.max(Math.floor(nowMs / 1000), data.servedAt as number)
}

/** A kept chain-pools answer as served now: `servedAt` now, and its age the snapshot's, as the producer stamps its own. */
export function servedPools(text: string, nowMs: number): string | null {
  const data = parsed(text)
  const at = data === null ? null : servedNow(data, nowMs)
  const block = data?.snapshot?.timestamp
  if (data === null || at === null || !Number.isSafeInteger(block)) return null
  const age = Math.max(0, at - (block as number))
  return JSON.stringify({ ...data, servedAt: at, freshness: { ageSeconds: age, status: age <= LIVE_FRESH_SECONDS ? 'fresh' : 'stale' } })
}

/** A kept chain-tokens answer as served now, to this body: its query the asker's own, `servedAt` now. */
export function servedTokens(body: unknown, text: string, nowMs: number): string | null {
  const query = (body as TokensAsked | null)?.query
  const data = parsed(text)
  const at = data === null ? null : servedNow(data, nowMs)
  if (typeof query !== 'string' || data === null || at === null) return null
  return JSON.stringify({ ...data, query, servedAt: at })
}

function answersOf(contract: ChainContract, route: ChainRoute) {
  return (body: unknown, text: string) => {
    try {
      const data = JSON.parse(text)
      return contract.validateResponse(route, data) && contract.validateExchange(route, body, data)
    } catch {
      return false
    }
  }
}

export function answerChainPools(request: Request, env: BridgeEnv, rt: ChainRuntime): Promise<Response> {
  const { contract } = rt
  return answerFromEdge(request, env, rt, {
    path: CHAIN_POOLS_PATH,
    version: contract.CONTRACT_VERSION,
    versions: contract.CONTRACT_VERSIONS,
    keyOf: (body, origin, asked) => (contract.validateRequest('chain-pools', body) ? chainPoolsKey(answeredIn(contract, asked), body as PoolsAsked, origin) : null),
    answers: answersOf(contract, 'chain-pools'),
    serve: (_body, text, nowMs) => servedPools(text, nowMs),
    freshSeconds: POOLS_SECONDS,
    staleSeconds: POOLS_SECONDS,
  })
}

export function answerChainTokens(request: Request, env: BridgeEnv, rt: ChainRuntime): Promise<Response> {
  const { contract } = rt
  return answerFromEdge(request, env, rt, {
    path: CHAIN_TOKENS_PATH,
    version: contract.CONTRACT_VERSION,
    versions: contract.CONTRACT_VERSIONS,
    // A query of spaces alone is the runtime's refusal (its trim() first): asked of the Worker, never kept.
    keyOf: (body, origin, asked) => (contract.validateRequest('chain-tokens', body) && searchQuery((body as TokensAsked).query) !== '' ? chainTokensKey(answeredIn(contract, asked), body as TokensAsked, origin) : null),
    answers: answersOf(contract, 'chain-tokens'),
    serve: (body, text, nowMs) => servedTokens(body, text, nowMs),
    freshSeconds: TOKENS_SECONDS,
    staleSeconds: TOKENS_STALE_SECONDS,
    errorSeconds: TOKENS_ERROR_SECONDS,
    errorWaitMs: TOKENS_ERROR_WAIT_MS,
  })
}
