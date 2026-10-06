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
 */
import type {
  ActivityResponse, ChainBalancesResponse, ChainPoolsResponse, ChainStatus, ChainTokensResponse, PortfolioResponse,
  ReadV6ErrorCode, ReadV6Route,
} from 'api-contracts/read-v6/types'
import { ARBITRUM_ID, ARBITRUM_NAME, BASE_ID, BASE_NAME, ROBINHOOD_ID, ROBINHOOD_NAME } from '../../config/chainIdentity'

export const READ_V6_CONTRACT_VERSION = '1.1.0-rc.1' as const
export const READ_V6_HEADER = 'X-Domino-Read-Contract' as const

/** The package's validators (api-contracts/read-v6/runtime.mjs), handed in. */
export interface ReadV6Validators {
  readonly CONTRACT_VERSION: string
  readonly ERROR_STATUS_BY_CODE: Readonly<Record<string, number>>
  validateRequest(route: ReadV6Route, value: unknown): boolean
  validateResponse(route: ReadV6Route, value: unknown): boolean
  validateExchange(route: ReadV6Route, request: unknown, response: unknown): boolean
  validateError(status: number, value: unknown): boolean
}

/** One exchange with the read API: the status and the JSON body; throws for a network failure. */
export interface ReadV6Transport {
  readonly kind: 'fixture' | 'http'
  post(route: ReadV6Route, body: unknown): Promise<{ status: number; body: unknown }>
}

export type ReadV6Reply<T> =
  | { kind: 'ok'; body: T }
  /** The API said it cannot answer now (its error code), or the network failed (`network`): a dash, with the reason. */
  | { kind: 'unavailable'; reason: ReadV6ErrorCode | 'network' | 'unexpected_status' }
  /** The body broke the contract: nothing of it is drawn. */
  | { kind: 'invalid'; detail: 'request' | 'response' | 'exchange' | 'error_body' }

const ADDRESS = /^0x[0-9a-f]{40}$/

async function exchange<T>(transport: ReadV6Transport, runtime: ReadV6Validators, route: ReadV6Route, request: Record<string, unknown>): Promise<ReadV6Reply<T>> {
  if (runtime.CONTRACT_VERSION !== READ_V6_CONTRACT_VERSION) return { kind: 'invalid', detail: 'response' }
  if (!runtime.validateRequest(route, request)) return { kind: 'invalid', detail: 'request' }
  let answer: { status: number; body: unknown }
  try {
    answer = await transport.post(route, request)
  } catch {
    return { kind: 'unavailable', reason: 'network' }
  }
  if (answer.status === 200) {
    if (!runtime.validateResponse(route, answer.body)) return { kind: 'invalid', detail: 'response' }
    if (!runtime.validateExchange(route, request, answer.body)) return { kind: 'invalid', detail: 'exchange' }
    return { kind: 'ok', body: answer.body as T }
  }
  if (!runtime.validateError(answer.status, answer.body)) return { kind: 'invalid', detail: 'error_body' }
  const code = (answer.body as { error: ReadV6ErrorCode }).error
  return { kind: 'unavailable', reason: runtime.ERROR_STATUS_BY_CODE[code] === answer.status ? code : 'unexpected_status' }
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

/**
 * The names §6.3's sentence uses ("Showing Base and Arbitrum. Robinhood Chain is unavailable right now."). Changed on
 * purpose 2026-10-06 (the owner: one name for one network, never two on one screen): each network as the registry names
 * it (config/chainIdentity.ts), so "Arbitrum One" here as on every other screen, not the spec example's "Arbitrum".
 */
const CHAIN_NAMES: Readonly<Record<number, string>> = { [ROBINHOOD_ID]: ROBINHOOD_NAME, [BASE_ID]: BASE_NAME, [ARBITRUM_ID]: ARBITRUM_NAME }

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
  const out = chains.filter((c) => c.status === 'unavailable').map((c) => CHAIN_NAMES[c.chainId])
  const shown = chains.filter((c) => c.status !== 'unavailable').map((c) => CHAIN_NAMES[c.chainId])
  if (out.length === 0) return null
  const list = (names: string[]) => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)
  const verb = out.length === 1 ? 'is' : 'are'
  return shown.length === 0 ? `${list(out)} ${verb} unavailable right now.` : `Showing ${list(shown)}. ${list(out)} ${verb} unavailable right now.`
}
