/**
 * Domino V2's read API, the app's side: `read-v6` `1.1.0-rc.1` (spec F7 rev2 §6.2; api-contracts/read-v6, main #305;
 * qualified USD since 1.1.0-rc.1, 0xdecimal's item 4).
 * Two routes, `portfolio` ({wallet}) and `activity` ({wallet, limit?, cursor?}): one wallet's V2 state and receipts on
 * Robinhood Chain, Base and Arbitrum One, read from the V2 index. Every answer passes the package's own validator
 * (runtime.mjs `validateResponse` and `validateExchange`: about the wallet asked, a page no longer than asked) before
 * anything is drawn; an error body passes `validateError`. There is never a partial answer: an error is `unavailable`
 * with its code, a malformed body `invalid`, and either draws a dash, never a zero.
 *
 * The answer carries no USD, APR or price (every token `price: null`, `priceReason: "no_qualified_price_source"`),
 * nothing summed across chains, `symbol` as untrusted text and `decimals` null when unread: the screens keep it so.
 *
 * The Worker route (`/api/read/v6/portfolio`, `/api/read/v6/activity`, header `X-Domino-Read-Contract: 1.1.0-rc.1`)
 * does not exist yet (the bridge side's); until it does, only the v2-test build's screens read, through a fixture
 * transport serving the package's own fixtures. This module imports no runtime: the caller hands it in (as
 * src/v2/crosschain does), so the node tests load api-contracts/read-v6/runtime.mjs themselves.
 *
 * Added 2026-11-04 (launch round P3, docs/v2/V2_FEES.md): `position-fees`, 1.2.0-rc.1's one new route, asked in that
 * version alone. Every other read stays 1.1.0-rc.1 until the window closes; an answer may carry either version.
 */
import type {
  ActivityResponse, ChainBalancesResponse, ChainPoolsResponse, ChainStatus, ChainTokensResponse, FeePositionRef, PortfolioResponse,
  PositionFeesResponse, ReadV6ErrorCode, ReadV6NextRoute,
} from 'api-contracts/read-v6/types'
import { ARBITRUM_ID, ARBITRUM_NAME, BASE_ID, BASE_NAME, ROBINHOOD_ID, ROBINHOOD_NAME, V2_CHAIN_IDS } from '../../config/chainIdentity'
import { ELYSIUM_LIVE, ELYSIUM_NAME, ELYSIUM_V2_ID } from '../../lib/elysiumIdentity'

export const READ_V6_CONTRACT_VERSION = '1.1.0-rc.1' as const
/** `position-fees`' version, and every version an answer may carry while the package's window is open. */
export const READ_V6_NEXT_CONTRACT_VERSION = '1.2.0-rc.1' as const
export const READ_V6_ANSWER_VERSIONS: readonly string[] = Object.freeze([READ_V6_CONTRACT_VERSION, READ_V6_NEXT_CONTRACT_VERSION])
export const READ_V6_HEADER = 'X-Domino-Read-Contract' as const

/** The package's validators (api-contracts/read-v6/runtime.mjs), handed in. */
export interface ReadV6Validators {
  readonly CONTRACT_VERSION: string
  readonly ERROR_STATUS_BY_CODE: Readonly<Record<string, number>>
  validateRequest(route: ReadV6NextRoute, value: unknown): boolean
  validateResponse(route: ReadV6NextRoute, value: unknown): boolean
  validateExchange(route: ReadV6NextRoute, request: unknown, response: unknown): boolean
  validateError(status: number, value: unknown): boolean
}

/**
 * One exchange with the read API: the status and the JSON body; throws for a network failure. Added 2026-10-06 (rugged's
 * answer of 6 Oct, §1): `retryAfter`, the reply's Retry-After header as sent, where the transport has one.
 */
export interface ReadV6Transport {
  readonly kind: 'fixture' | 'http'
  post(route: ReadV6NextRoute, body: unknown): Promise<{ status: number; body: unknown; retryAfter?: string | null }>
}

export type ReadV6Reply<T> =
  | { kind: 'ok'; body: T }
  /**
   * The API said it cannot answer now (its error code), or the network failed (`network`): a dash, with the reason.
   * `retryAfterSeconds` (added 2026-10-06, rugged's answer of 6 Oct, §1: the gateway's Retry-After is now the real time to
   * the lane's next token): on a busy reader's 429 (`read_capacity_busy`), the whole seconds it asked to wait (1 to 60, as
   * the read Worker relays them) before the same read is asked again; absent when it named none.
   */
  | { kind: 'unavailable'; reason: ReadV6ErrorCode | 'network' | 'unexpected_status'; retryAfterSeconds?: number }
  /** The body broke the contract: nothing of it is drawn. */
  | { kind: 'invalid'; detail: 'request' | 'response' | 'exchange' | 'error_body' }

const ADDRESS = /^0x[0-9a-f]{40}$/

/** A Retry-After in whole seconds, 1 to 60 (the read Worker relays no other: bridge/src/worker.mjs retryAfter); else none. */
export function retryAfterSeconds(header: string | null | undefined): number | undefined {
  if (typeof header !== 'string' || !/^[0-9]{1,3}$/.test(header.trim())) return undefined
  const seconds = Number(header.trim())
  return seconds >= 1 && seconds <= 60 ? seconds : undefined
}

async function exchange<T>(transport: ReadV6Transport, runtime: ReadV6Validators, route: ReadV6NextRoute, request: Record<string, unknown>): Promise<ReadV6Reply<T>> {
  if (runtime.CONTRACT_VERSION !== READ_V6_CONTRACT_VERSION) return { kind: 'invalid', detail: 'response' }
  if (!runtime.validateRequest(route, request)) return { kind: 'invalid', detail: 'request' }
  let answer: { status: number; body: unknown; retryAfter?: string | null }
  try {
    answer = await transport.post(route, request)
  } catch {
    return { kind: 'unavailable', reason: 'network' }
  }
  if (answer.status === 200) {
    let body = answer.body
    // Changed on purpose 2026-11-07 (the read-v6 version skew, docs/ELYSIUM_DAY9.md "Order"): an answer the package refuses
    // whole, and that names chains this app does not serve, is checked again without them (servedOnly); every rule of the
    // package still holds on what is left, and nothing of those chains is ever read. The read Worker does the same with
    // its own package's chains (bridge/src/worker.mjs ownChains), so a read gateway whose read-v6 names one chain more
    // under the same version blanks nothing on the chains served. An answer the package takes is read exactly as before.
    if (!runtime.validateResponse(route, body)) {
      body = servedOnly(route, body)
      if (body === answer.body || !runtime.validateResponse(route, body)) return { kind: 'invalid', detail: 'response' }
    }
    if (!runtime.validateExchange(route, request, body)) return { kind: 'invalid', detail: 'exchange' }
    return { kind: 'ok', body: servedOnly(route, body) as T }
  }
  if (!runtime.validateError(answer.status, answer.body)) return { kind: 'invalid', detail: 'error_body' }
  const code = (answer.body as { error: ReadV6ErrorCode }).error
  if (runtime.ERROR_STATUS_BY_CODE[code] !== answer.status) return { kind: 'unavailable', reason: 'unexpected_status' }
  // Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, §1): a busy reader's 429 keeps the wait it named.
  const wait = answer.status === 429 ? retryAfterSeconds(answer.retryAfter) : undefined
  return wait === undefined ? { kind: 'unavailable', reason: code } : { kind: 'unavailable', reason: code, retryAfterSeconds: wait }
}

/** The lists of a portfolio or activity answer whose entries each name their chain (`chainId`). */
const PER_CHAIN = ['chains', 'tokens', 'vaults', 'positions', 'mandates', 'credits', 'items'] as const

/**
 * A portfolio or activity answer as the screens may draw it (added 2026-11-07, Elysium as a fourth V2 chain): checked
 * whole by the package's own validator first, then without the entries of a chain this app does not serve, its coverage
 * then the served chains' own ("complete" when each of them is current, as the package's rule reads it). read-v6 names
 * Elysium (99901) from rugged97's day-9 version, which the app may bundle before its switch serves Elysium (a piece still
 * missing: scripts/elysium-switch.mjs); until then no screen meets a chain it holds no name, route or contract for. An
 * answer that names only served chains, every answer today, is returned as it is. Every other route asks about one chain
 * the app chose, or about exactly the chains it lists.
 *
 * Changed on purpose 2026-11-07 (the read-v6 version skew): also run on an answer the package refused (exchange above), so
 * it reads nothing it does not have to: the chains left out are those the answer's own `chains` lists beyond the served
 * ones, and only when they are distinct chain ids and the answer's coverage is its own chains' (else it is returned as it
 * is, and refused); an entry naming any other chain stays, for the package to refuse.
 */
function servedOnly(route: ReadV6NextRoute, body: unknown): unknown {
  const chains = (body as { chains?: unknown } | null)?.chains
  if ((route !== 'portfolio' && route !== 'activity') || !Array.isArray(chains)) return body
  const answer = body as Record<string, unknown>
  const current = (list: { status?: unknown }[]) => list.every((chain) => chain?.status === 'current')
  const ids = chains.map((chain) => chain?.chainId)
  const out = ids.filter((id) => !V2_CHAIN_IDS.includes(id))
  if (!out.length || new Set(ids).size < ids.length || !out.every((id) => Number.isSafeInteger(id) && id > 0) ||
    (answer.coverage === 'complete') !== current(chains)) return body
  const kept: Record<string, unknown> = { ...answer }
  for (const key of PER_CHAIN) if (Array.isArray(answer[key])) kept[key] = (answer[key] as { chainId?: unknown }[]).filter((entry) => !out.includes(entry?.chainId))
  kept.coverage = current(kept.chains as { status: string }[]) ? 'complete' : 'partial'
  return kept
}

/** The wallet's V2 portfolio on the three chains. `wallet` is sent in lower case, as the contract requires. */
export function readPortfolio(transport: ReadV6Transport, runtime: ReadV6Validators, wallet: string): Promise<ReadV6Reply<PortfolioResponse>> {
  const lower = String(wallet).toLowerCase()
  if (!ADDRESS.test(lower)) return Promise.resolve({ kind: 'invalid', detail: 'request' })
  return exchange<PortfolioResponse>(transport, runtime, 'portfolio', { wallet: lower })
}

/** One page of the wallet's receipts, newest first: `limit` 1–50 (the API's default 20), `cursor` from `nextCursor`. */
export function readActivity(transport: ReadV6Transport, runtime: ReadV6Validators, wallet: string, page: { limit?: number; cursor?: string } = {}): Promise<ReadV6Reply<ActivityResponse>> {
  const lower = String(wallet).toLowerCase()
  if (!ADDRESS.test(lower)) return Promise.resolve({ kind: 'invalid', detail: 'request' })
  const request: Record<string, unknown> = { wallet: lower }
  if (page.limit !== undefined) request.limit = page.limit
  if (page.cursor !== undefined) request.cursor = page.cursor
  return exchange<ActivityResponse>(transport, runtime, 'activity', request)
}

/**
 * The live chain reads (api-contracts/read-v6 README, "Chain reads"): read at each chain's head by the backend, so the
 * app lists pools and balances without moving the wallet to another network; it still moves it to sign (§1.3).
 */

/** A token's pools on a chain: against the chain's base currencies, or against `pairedToken` alone. */
export function readChainPools(transport: ReadV6Transport, runtime: ReadV6Validators, chainId: number, token: string, pairedToken?: string): Promise<ReadV6Reply<ChainPoolsResponse>> {
  const request: Record<string, unknown> = { chainId, token: String(token).toLowerCase() }
  if (pairedToken !== undefined) request.pairedToken = String(pairedToken).toLowerCase()
  return exchange<ChainPoolsResponse>(transport, runtime, 'chain-pools', request)
}

/** A wallet's balances on each chain: every chain's base currencies, or exactly `tokens` (at most 24, in that order). */
export function readChainBalances(transport: ReadV6Transport, runtime: ReadV6Validators, wallet: string, tokens?: readonly { chainId: number; address: string }[]): Promise<ReadV6Reply<ChainBalancesResponse>> {
  const lower = String(wallet).toLowerCase()
  if (!ADDRESS.test(lower)) return Promise.resolve({ kind: 'invalid', detail: 'request' })
  const request: Record<string, unknown> = { wallet: lower }
  if (tokens !== undefined) request.tokens = tokens.map((t) => ({ chainId: t.chainId, address: String(t.address).toLowerCase() }))
  return exchange<ChainBalancesResponse>(transport, runtime, 'chain-balances', request)
}

/** The tokens Domino knows on Base or Arbitrum One that match `query` (known tokens only; Robinhood's search is read-v3's). */
export function readChainTokens(transport: ReadV6Transport, runtime: ReadV6Validators, chainId: number, query: string, limit?: number): Promise<ReadV6Reply<ChainTokensResponse>> {
  const request: Record<string, unknown> = { chainId, query }
  if (limit !== undefined) request.limit = limit
  return exchange<ChainTokensResponse>(transport, runtime, 'chain-tokens', request)
}

/** Up to 8 positions' stored fee history on one chain (`position-fees`): raw amounts, in the order asked. */
export function readPositionFees(transport: ReadV6Transport, runtime: ReadV6Validators, chainId: number, positions: readonly FeePositionRef[]): Promise<ReadV6Reply<PositionFeesResponse>> {
  return exchange<PositionFeesResponse>(transport, runtime, 'position-fees', { chainId, positions: positions.map(({ dex, tokenId }) => ({ dex, tokenId })) })
}

const ELYSIUM_ROW: Record<number, string> = ELYSIUM_LIVE ? { [ELYSIUM_V2_ID]: ELYSIUM_NAME } : {}

/**
 * The names §6.3's sentence uses ("Showing Base and Arbitrum. Robinhood Chain is unavailable right now."). Changed on
 * purpose 2026-10-06 (the owner: one name for one network, never two on one screen): each network as the registry names
 * it (config/chainIdentity.ts), so "Arbitrum One" here as on every other screen, not the spec example's "Arbitrum".
 * Changed on purpose 2026-11-06 (the Elysium surface): Elysium too, by its mainnet id, in a build where it is live
 * (lib/elysiumIdentity.ts ELYSIUM_LIVE), so a read-v6 answer that names it never leaves a blank in the sentence.
 */
const CHAIN_NAMES: Readonly<Record<number, string>> = { [ROBINHOOD_ID]: ROBINHOOD_NAME, [BASE_ID]: BASE_NAME, [ARBITRUM_ID]: ARBITRUM_NAME, ...ELYSIUM_ROW }

/**
 * What the answer's per-chain status means for the screens (§6.2, §6.3): `current` shows as is; `stale` shows with
 * the stale badge and its age; `unavailable` is a dash for that chain only, never zeros, and never empties the others.
 */
export function chainState(chain: ChainStatus): { chainId: number; state: 'current' | 'stale' | 'unavailable'; reason: string | null; lagSeconds: number | null } {
  return { chainId: chain.chainId, state: chain.status, reason: chain.reason, lagSeconds: chain.lagSeconds }
}

/**
 * The partial-coverage sentence of §6.3 ("Showing Base and Arbitrum. Robinhood Chain is unavailable right now."), or
 * null when every chain is current or stale (a stale chain is shown, with its badge).
 */
export function coverageNote(chains: readonly ChainStatus[]): string | null {
  // Changed on purpose 2026-11-07 (review finding D): a chain this app holds no name for (one it does not serve, which
  // servedOnly already leaves out of portfolio and activity) is left out here too, on any path, never drawn as a blank.
  const named = chains.filter((c) => Object.hasOwn(CHAIN_NAMES, c.chainId))
  const out = named.filter((c) => c.status === 'unavailable').map((c) => CHAIN_NAMES[c.chainId])
  const shown = named.filter((c) => c.status !== 'unavailable').map((c) => CHAIN_NAMES[c.chainId])
  if (out.length === 0) return null
  const list = (names: string[]) => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)
  const verb = out.length === 1 ? 'is' : 'are'
  return shown.length === 0 ? `${list(out)} ${verb} unavailable right now.` : `Showing ${list(shown)}. ${list(out)} ${verb} unavailable right now.`
}
