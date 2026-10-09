/**
 * Domino's own chain routes, as the page asks them (RPC-SPEC, the switch to rugged97's node): fixed
 * same-origin POSTs to this site, each with one fixed purpose, answered by the site's Pages Functions from Domino's own
 * Robinhood Chain node. The browser never speaks JSON-RPC to a server and never learns where the node is: no host, no
 * token and no method name is in this module (the owner's rule of 2026-10-01: nothing is read from a public RPC).
 *
 * The routes sit under /api behind the beta gate, so every request carries this site's cookies (credentials
 * 'same-origin'). An answer is handed on as it came, its JSON parsed and its
 * size measured; each caller checks it field by field with its own parser. A refusal is one of four failures, with the
 * wait the route named (Retry-After, at most five minutes): a calm state for the screens, never a fault.
 *
 * Pure and small: no DOM, no storage, no build flag; the network call is handed in by tests (RouteOptions.fetch).
 */
import type { AutomationAnswer } from '../automationState'
import type { LedgerMintHint, RelayAnswer } from '../fees/types'
import type { WalletAnswer } from '../walletPositions'

export const ROUTES = Object.freeze({
  owned: '/api/owned/v2/positions',
  state: '/api/fees/v1/state',
  ledger: '/api/fees/v2/ledger',
  automation: '/api/automation/v1/state',
  record: '/api/automation/v1/record',
  simulate: '/api/chain/v1/simulate',
  confirmation: '/api/chain/v1/confirmation',
} as const)
export type RouteName = keyof typeof ROUTES

/** The most bytes each route's answer may take; past it the answer is `unavailable`. */
export const REPLY_BYTES: Readonly<Record<RouteName, number>> = Object.freeze({ owned: 1_048_576, state: 262_144, ledger: 4_194_304, automation: 262_144, record: 2_097_152, simulate: 262_144, confirmation: 262_144 })
/** The longest wait a refusal may name (Retry-After), and the one assumed for a rate refusal that names none. */
export const MAX_RETRY_MS = 300_000
export const RATE_RETRY_MS = 5_000

/** An NFT's SetupMinted log: its mint's block and transaction (functions/_lib/walletPositions.ts MintedAt). */
export interface MintedAt {
  id: string
  block: number
  tx: string
}
/** POST /api/owned/v2/positions's answer (RPC-SPEC §2.5.1). */
export interface OwnedPositionsResponse {
  v: 1
  answer: WalletAnswer
  automation: AutomationAnswer | null
  mints: MintedAt[]
  capped: boolean
}
/** One log as the node sent it, trimmed to these fields (POST /api/automation/v1/record). */
export interface RawLog {
  address: string
  topics: string[]
  data: string
  blockNumber: string
  transactionHash: string
  logIndex: string
}
export interface VaultRecordRequest {
  vault: string
  tokenId: string
  currencies: readonly [string, string]
  from: number
  to: number
}
export type VaultRecordResponse = { v: 1; head: number; executions: RawLog[]; transfers: RawLog[] | null } | { v: 1; behind: true }
export interface SimulateCall {
  to: string
  data: string
  value: string
}
export interface SimulateRequest {
  owner: string
  calls: readonly SimulateCall[]
}
export type SimulateAnswer = { ok: true; result: unknown } | { ok: false; reason: 'not_enabled' | 'unsupported' | 'failed' | 'unavailable' | 'rate_limited' | 'bad_request' }

export interface RouteOptions {
  signal?: AbortSignal
  /** Tests only: the network call. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>
}

type Failure = Extract<RelayAnswer<never>, { ok: false }>
const fail = (failure: Failure['failure'], retryAfterMs = 0): Failure => ({ ok: false, failure, retryAfterMs })

/** The wait an answer's Retry-After names, bounded; `fallback` when it names none. */
function retryAfter(response: Response, fallback: number): number {
  const seconds = Number(response.headers.get('Retry-After') ?? Number.NaN)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(MAX_RETRY_MS, seconds * 1000) : fallback
}

/** A body read no further than `limit` bytes: its text, or null past it (a WebView with no body stream reads it whole). */
async function textWithin(response: Response, limit: number): Promise<string | null> {
  if (!response.body) {
    const text = await response.text()
    return text.length > limit ? null : text
  }
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > limit) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    parts.push(value)
  }
  const joined = new Uint8Array(bytes)
  let at = 0
  for (const part of parts) {
    joined.set(part, at)
    at += part.byteLength
  }
  return new TextDecoder().decode(joined)
}

/** What an answer other than a 200 stands for: a rate refusal, a request too large, one refused, or the source away. */
async function failureOf(response: Response): Promise<Failure> {
  const text = await textWithin(response, 4096).catch(() => null)
  let code: unknown = null
  try {
    code = text ? (JSON.parse(text) as { error?: unknown } | null)?.error : null
  } catch {
    code = null
  }
  const status = response.status
  if (status === 429 || (status === 502 && code === 'chain_busy')) return fail('rate_limited', retryAfter(response, RATE_RETRY_MS))
  if (status === 413) return fail('too_large')
  if (status === 400 || status === 403 || status === 405 || status === 415) return fail('bad_request')
  return fail('unavailable', retryAfter(response, 0))
}

/** The module's one network call: a same-origin POST of `body` to `route`'s fixed path, with this site's cookies; null when it could not be made. */
async function send(route: RouteName, body: unknown, options: RouteOptions): Promise<Response | null> {
  const init: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: options.signal }
  try {
    return await (options.fetch ? options.fetch(ROUTES[route], init) : fetch(ROUTES[route], init))
  } catch {
    return null
  }
}

/** One POST of `body` to `route`: its JSON and its size, or why there is none. */
export async function postRoute(route: RouteName, body: unknown, options: RouteOptions = {}): Promise<RelayAnswer<unknown>> {
  const response = await send(route, body, options)
  if (!response) return fail('unavailable')
  try {
    if (response.status !== 200) return await failureOf(response)
    if (!/^application\/json\b/i.test(response.headers.get('Content-Type') ?? '')) return fail('unavailable')
    const text = await textWithin(response, REPLY_BYTES[route])
    return text === null ? fail('unavailable') : { ok: true, value: JSON.parse(text) as unknown, bytes: text.length }
  } catch {
    return fail('unavailable')
  }
}

/** The connected wallet's Domino positions, held deposits, features and mint blocks (RPC-SPEC §2.5.1). */
export const postOwnedPositions = (owner: string, fresh = false, options?: RouteOptions) => postRoute('owned', fresh ? { owner, fresh: true } : { owner }, options)
/**
 * Up to eight positions at one block, each with its feature when `automation` (RPC-SPEC §2.5.2). `fresh` (2026-10-01, the
 * switch's integration): right after the owner's action, so the route takes no answer it kept from before it.
 */
export const postState = (tokenIds: readonly string[], automation = false, options?: RouteOptions, fresh = false) =>
  postRoute('state', { tokenIds: [...tokenIds], ...(automation ? { automation: true } : {}), ...(fresh ? { fresh: true } : {}) }, options)
/**
 * Up to eight positions' own ledgers of settlements (RPC-SPEC §11.4, functions/_lib/feesLedger.ts), each with its state at
 * the answer's block. `fresh`: the page saw a settlement its ledger does not hold yet, so the route takes no answer it kept
 * from before it.
 */
export const postLedger = (tokenIds: readonly string[], fresh = false, options?: RouteOptions, mintHints?: readonly LedgerMintHint[]) => postRoute('ledger', { tokenIds: [...tokenIds], ...(fresh ? { fresh: true } : {}), ...(mintHints?.length ? { mintHints } : {}) }, options)
/** Plain, Auto-compound or Domino-compound, paused or active, for up to 100 positions (RPC-SPEC §2.5.4). */
export const postAutomation = (tokenIds: readonly string[], options?: RouteOptions) => postRoute('automation', { tokenIds: [...tokenIds] }, options)
/** An automation vault's executions and the transfers out of it in their blocks (RPC-SPEC §2.5.5). */
export const postVaultRecord = (request: VaultRecordRequest, options?: RouteOptions) =>
  postRoute('record', { vault: request.vault, tokenId: request.tokenId, currencies: [request.currencies[0], request.currencies[1]], from: request.from, to: request.to }, options)

/** A batch simulated on Domino's node for a wallet that cannot (RPC-SPEC §2.5.6); off unless the deployment turns it on. */
export async function postSimulate(request: SimulateRequest, options: RouteOptions = {}): Promise<SimulateAnswer> {
  const response = await send('simulate', { owner: request.owner, calls: request.calls.map(({ to, data, value }) => ({ to, data, value })) }, options)
  if (!response) return { ok: false, reason: 'unavailable' }
  try {
    if (response.status === 200) {
      const text = await textWithin(response, REPLY_BYTES.simulate)
      const value = text === null ? null : (JSON.parse(text) as { v?: unknown; result?: unknown } | null)
      return value && value.v === 1 && 'result' in value ? { ok: true, result: value.result } : { ok: false, reason: 'unavailable' }
    }
    if (response.status === 404) return { ok: false, reason: 'not_enabled' }
    if (response.status === 501) return { ok: false, reason: 'unsupported' }
    if (response.status === 422) return { ok: false, reason: 'failed' }
    const { failure } = await failureOf(response)
    return { ok: false, reason: failure === 'rate_limited' ? 'rate_limited' : failure === 'bad_request' ? 'bad_request' : 'unavailable' }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}
