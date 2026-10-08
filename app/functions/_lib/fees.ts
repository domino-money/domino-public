/**
 * A position NFT's state at one block, at the edge: POST /api/fees/v1/state, over Domino's own Robinhood Chain node
 * (functions/_lib/localRpc.ts), and the runtime, RPC, cache and request helpers the other chain routes share
 * (feesLedger.ts, vaultRecord.ts).
 *
 *   POST /api/fees/v1/state  {"tokenIds": [...]}   up to 8 positions read at one block: range, liquidity, price,
 *                                                   fee growth and the exact unclaimed fees
 *
 * What this is not: a general RPC proxy. The caller names token ids; the endpoint, every method (eth_call to
 * Multicall3), contract and calldata are fixed here. Every answer is capped in RPC calls, RPC bytes and time, and what
 * it reads is kept in the Workers cache under a versioned key. Every RPC body is parsed and validated before it is used
 * or kept; a body that does not validate is an RPC failure and is never kept.
 *
 * The gate middleware runs first, as for every /api path, and sets the API CSP on the way out. Every answer is public
 * chain data; the node's address and token are a Cloudflare secret that only the transport reads.
 *
 * Changed on purpose 2026-10-02 (rugged97's rules for the site's token, RUGGED_RPC_SITE_2026-10-02.md, rule 2: never a
 * pool's whole history per request): POST /api/fees/v1/logs, the fees replay's pool epochs, swap days, probes and the
 * price path's spans, is gone with the replay. A position's fees history is its own ledger now (feesLedger.ts,
 * POST /api/fees/v2/ledger): our own events and eth_call, never a pool's ModifyLiquidity or Swap history.
 */
import {
  BACKOFF_MS,
  MULTICALL3,
  POSITION_MANAGER,
  RATE_ATTEMPTS,
  REPLY_CUT,
  RPC_URL,
  bodyWithin,
  classifyRpcError,
  decodeAggregate3,
  encodeAggregate3,
  keccak256,
  timeoutSignal,
  type ChainInit,
} from './owned'
import { SHARED_STALE_MS, outlast } from './sharedWork'
import { automationsOf, subscriberCall, subscriberOf, vaultCalls, vaultsOf } from './automation'
import { ROBINHOOD_POOL_MANAGER, ROBINHOOD_STATE_VIEW } from '../../src/config/chainIdentity'
import type { StateCurrency, StatePosition, StateResponse } from '../../src/lib/fees/types'

// ---------------------------------------------------------------------------
// Pins (checked against viem and the deployment profile in tests/fees-topics.test.mjs)
// ---------------------------------------------------------------------------

/**
 * Uniswap v4 PoolManager on Robinhood Chain (docs/deployments/v1-robinhood-mainnet-2026-09-21/deployment.json).
 * Changed on purpose 2026-10-01 (the chain2 workstream, part B, audit item G3): this and STATE_VIEW are the chain
 * registry's (config/chainIdentity.ts), no longer copies.
 */
export const POOL_MANAGER = ROBINHOOD_POOL_MANAGER
/** Uniswap v4 StateView on Robinhood Chain (the same profile; app/src/finance/pin.ts STATE_VIEW). */
export const STATE_VIEW = ROBINHOOD_STATE_VIEW

export const TOPIC = {
  Transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  ModifyLiquidity: '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec',
} as const

export const SELECTOR = {
  getPoolAndPositionInfo: '7ba03aad',
  getPositionLiquidity: '1efeed33',
  ownerOf: '6352211e',
  getSlot0: 'c815641c',
  getFeeGrowthInside: '53e9c1fb',
  getPositionInfo: 'dacf1d2f',
  symbol: '95d89b41',
  decimals: '313ce567',
  getCurrentBlockTimestamp: '0f28c97d',
  /** 2026-10-01 (item D5): PositionManager.nextTokenId(), so a page tells an id never minted from a burned one. */
  nextTokenId: '75794a3c',
} as const

/**
 * Arbitrum's ArbSys precompile: arbBlockNumber() is the chain's own (L2) block a call at 'latest' ran at
 * (walletPositions.ts keeps its own copy; 2026-10-01, item A21: the page's state read learns its block in its first call).
 */
const ARB_SYS = '0x0000000000000000000000000000000000000064'
const ARB_BLOCK_NUMBER = 'a3b1b31d'

// ---------------------------------------------------------------------------
// Sizes and limits
// ---------------------------------------------------------------------------

/** A block at least this far below the head is final (about 30 minutes at ~9.9 blocks/s); what ends there is kept a year. */
export const SAFE_DEPTH = 18_000
/** The most RPC calls one answer may cost, retries and splits included. */
export const MAX_RPC_CALLS = 32
/** The most raw RPC bytes one answer may read (the isolate has 128 MB and shares it). */
export const MAX_BYTES = 8 * 1024 * 1024
export const DEADLINE_MS = 25_000
const CALL_TIMEOUT_MS = 10_000
export const MAX_STATE_IDS = 8
/** The most block headers one POST asks (feesLedger.ts). */
export const MAX_HEADERS = 50
/**
 * The most calls one multicall carries (rugged97's rule 5, 2026-10-02; functions/_lib/localRpc.ts refuses more): the state
 * read's second aggregate is cut in parts of this many, all at the same block.
 */
export const CALLS_PER_AGGREGATE = 50
/** How long a /state answer is kept. */
export const SHORT_SECONDS = 10
/** How long something final is kept. */
export const FINAL_SECONDS = 31_536_000
/** How long a failure is kept, so a loop of questions is not a loop of RPC calls. */
export const FAILURE_SECONDS = 5
export const STATE_BODY_BYTES = 512
/** The cache format; bumping it retires every entry. */
export const CACHE_VERSION = 'c1'
/**
 * Off until the preview measurement DESIGN-V2 §15.1 asks for: the gate's
 * no-transform switches off Cloudflare's own compression, and whether the
 * gate's copy of a manually encoded answer keeps its encoding is what the
 * measurement has to show before this is turned on.
 */
export const SEND_GZIP = false

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/** What the relay needs from the runtime; tests hand in fakes. */
export interface FeesDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** True once nobody wants the answer any more (the page's read was dropped): no further call is made. A Function has none. */
  cancelled?: () => boolean
  /** 2026-10-01 (RPC-SPEC §2.6): the runtime's log windows (owned.ts LogLimits); the chain RPC's without it. */
  logLimits?: { one: number; many: number }
}

/** The part of the Workers cache the relay uses: caches.default in production, absent in tests. */
export interface FeesCache {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

export interface FeesRuntime {
  deps: FeesDeps
  cache: FeesCache | null
  waitUntil?: (work: Promise<unknown>) => void
  /** Internal metrics only: callers emit fixed event codes/counts, never chain payloads or provider messages. */
  onDiagnostic?: (fields: Record<string, string | number>) => void
  /**
   * Whether this question was refused the node for its visitor's spent share (functions/_lib/chainRoutes.ts, localRpc.ts
   * refused()). A unit it offered (shared) is then never taken by a question that joined it: the node refused this
   * visitor only.
   *
   * Changed on purpose 2026-10-02 (RPC fix round 2.2): it was `solo`, decided before the question read anything, and such
   * a question offered no unit at all. A question now learns that its share is spent only at its first call to the node.
   */
  refused?: () => boolean
}

/** Wait and ask again; split the range; the answer's bytes, calls or time are spent; or stop. */
type Failure = 'rate' | 'range' | 'bytes' | 'calls' | 'deadline' | 'fatal'

export class RelayError extends Error {
  constructor(
    readonly kind: Failure,
    message: string,
    readonly retryAfterMs = 0,
  ) {
    super(message)
  }
}

/** What one answer has spent. */
export interface Budget {
  calls: number
  bytes: number
  started: number
  retryAfterMs: number
}

export const newBudget = (rt: FeesRuntime): Budget => ({ calls: 0, bytes: 0, started: rt.deps.now(), retryAfterMs: 0 })

/** Simultaneous questions for one key in this isolate share one read: the read, when it began, and its question's refusal. */
const inflight = new Map<string, { work: Promise<unknown>; started: number; refused?: () => boolean }>()

/**
 * `work`'s value, shared by the questions of `key` in this isolate while it runs. 2026-10-02 (review finding 3,
 * sharedWork.ts): the read is handed to its first question's waitUntil (`rt.waitUntil`), so it goes on when that visitor
 * leaves, and clears its own slot when it settles; one older than SHARED_STALE_MS is never joined, and a question that
 * joins one waits for it no longer than that, on a timer of its own.
 *
 * Changed on purpose 2026-10-02 (RPC fix round 2.2): a joiner whose wait ran out, or whose read was refused the node for
 * its own question's visitor (FeesRuntime.refused), looks at the slot again instead of reading at once. The first to find
 * it empty reads, and the others join that read, so joiners whose waits end together make one read, not one each.
 */
export async function shared<T>(rt: FeesRuntime, key: string, work: () => Promise<T>): Promise<T> {
  for (let running = inflight.get(key); running && rt.deps.now() - running.started <= SHARED_STALE_MS; running = inflight.get(key)) {
    let joined: { value: T } | null = null
    try {
      joined = await outlast(running.work as Promise<T>, running.started + SHARED_STALE_MS - rt.deps.now())
    } catch (error) {
      if (!running.refused?.()) throw error
    }
    if (joined && !running.refused?.()) return joined.value
    if (inflight.get(key) === running) inflight.delete(key)
  }
  const entry = { work: work() as Promise<unknown>, started: rt.deps.now(), refused: rt.refused }
  inflight.set(key, entry)
  const clear = () => {
    if (inflight.get(key) === entry) inflight.delete(key)
  }
  void entry.work.then(clear, clear)
  rt.waitUntil?.(entry.work.catch(() => undefined))
  return entry.work as Promise<T>
}

/** The head as this isolate last read it, reused for one second. */
let lastHead: { block: number; at: number } | null = null

/**
 * 2026-09-28 (speed wave B, item 39): a head this context learned elsewhere (since 2026-10-02 the state read's own
 * block, the ledger's head), taken as read now when it is past the one remembered.
 */
export function knownHead(block: number, at: number): void {
  if (!lastHead || block > lastHead.block) lastHead = { block, at }
}

/** For tests: forget every in-flight read and the remembered head. */
export function resetRelayMemory(): void {
  inflight.clear()
  lastHead = null
}

// ---------------------------------------------------------------------------
// Hex and ABI
// ---------------------------------------------------------------------------

const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i
export const HASH = /^0x[0-9a-f]{64}$/
const DECIMAL_ID = /^(?:0|[1-9][0-9]{0,77})$/
const U256 = (1n << 256n) - 1n

export const hex = (n: number | bigint) => `0x${n.toString(16)}`
const word = (n: bigint) => BigInt.asUintN(256, n).toString(16).padStart(64, '0')
export const addressWord = (address: string) => address.slice(2).toLowerCase().padStart(64, '0')

export function quantity(value: unknown): number {
  if (typeof value !== 'string' || !QUANTITY.test(value)) throw new RelayError('fatal', 'invalid_quantity')
  const n = Number(BigInt(value))
  if (!Number.isSafeInteger(n)) throw new RelayError('fatal', 'invalid_quantity')
  return n
}

/** The first `count` 32-byte words of ABI return data. */
function words(data: string, count: number): bigint[] {
  const body = data.startsWith('0x') ? data.slice(2) : data
  if (body.length < count * 64 || !/^[0-9a-fA-F]*$/.test(body)) throw new RelayError('fatal', 'invalid_return_data')
  const out: bigint[] = []
  for (let i = 0; i < count; i++) out.push(BigInt(`0x${body.slice(i * 64, i * 64 + 64)}`))
  return out
}

function asAddress(value: bigint): string {
  if (value >> 160n !== 0n) throw new RelayError('fatal', 'invalid_return_data')
  return `0x${value.toString(16).padStart(40, '0')}`
}

/** An ABI-encoded int24 (sign-extended to 256 bits). */
function asInt24(value: bigint): number {
  const signed = BigInt.asIntN(256, value)
  if (signed < -(1n << 23n) || signed >= 1n << 23n) throw new RelayError('fatal', 'invalid_return_data')
  return Number(signed)
}

/** A 24-bit field of a packed word, as a signed number. */
const int24Field = (value: bigint) => Number(BigInt.asIntN(24, value))

function bounded(value: bigint, bits: bigint): bigint {
  if (value >> bits !== 0n) throw new RelayError('fatal', 'invalid_return_data')
  return value
}

/** PoolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks)). */
export function poolIdOf(key: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }): string {
  return keccak256(addressWord(key.currency0) + addressWord(key.currency1) + word(BigInt(key.fee)) + word(BigInt(key.tickSpacing)) + addressWord(key.hooks))
}

/** An ERC-20 symbol() return: an ABI string, or a bytes32; null when it is neither or not one short run of clean text. Untrusted either way. */
export function decodeSymbol(data: string): string | null {
  const body = data.startsWith('0x') ? data.slice(2) : data
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(body) || body.length < 64) return null
  let bytes: string
  if (body.length === 64) {
    bytes = body.replace(/(?:00)+$/, '')
  } else {
    if (body.length < 128 || BigInt(`0x${body.slice(0, 64)}`) !== 32n) return null
    const length = BigInt(`0x${body.slice(64, 128)}`)
    if (length > 64n || body.length < 128 + Number(length) * 2) return null
    bytes = body.slice(128, 128 + Number(length) * 2)
  }
  if (bytes.length === 0) return null
  const raw = new Uint8Array(bytes.length / 2)
  for (let i = 0; i < raw.length; i++) raw[i] = Number.parseInt(bytes.slice(i * 2, i * 2 + 2), 16)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    return null
  }
  // No control characters (Cc: below 0x20, 0x7f to 0x9f) and no line or paragraph separators (Zl, Zp: 0x2028, 0x2029): a
  // symbol is one short run of text. No format character either (Cf, audit I2, 2026-10-01): a bidirectional control in a
  // symbol reorders the amounts drawn beside it. One expression, so the chain code stays within its 20,000 B budget.
  return /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text) ? null : text
}

// ---------------------------------------------------------------------------
// The RPC
// ---------------------------------------------------------------------------

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get('Retry-After') ?? Number.NaN)
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 30) * 1000 : 0
}

/** One POST to the RPC (one call or a batch), within the answer's caps; its body parsed as JSON. */
export async function post(rt: FeesRuntime, budget: Budget, payload: unknown, logs: boolean, byteLimit = MAX_BYTES): Promise<unknown> {
  if (rt.deps.cancelled?.()) throw new RelayError('fatal', 'cancelled')
  if (budget.calls >= MAX_RPC_CALLS) throw new RelayError('calls', 'rpc_call_cap')
  if (rt.deps.now() - budget.started > DEADLINE_MS) throw new RelayError('deadline', 'deadline')
  budget.calls += 1
  // A call that took too long fails. Changed on purpose 2026-10-02 (rugged97's rule 7): a log range that took too long was
  // split and asked again, paying the node's work once more for each half; it is never split now. `logs` stays in the
  // signature for the callers.
  void logs
  const slow = (error: unknown) => {
    const name = error instanceof Error ? error.name : ''
    return name === 'TimeoutError' || name === 'AbortError' ? new RelayError('fatal', 'rpc_timeout') : null
  }
  const limit = Math.min(byteLimit, MAX_BYTES - budget.bytes)
  // 2026-10-02 (review finding 11): the limit goes with the call, so the edge's node transport stops reading at it.
  const init: ChainInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: timeoutSignal(CALL_TIMEOUT_MS),
    replyBytes: Math.max(0, limit),
  }
  let response: Response
  try {
    response = await rt.deps.fetch(RPC_URL, init)
  } catch (error) {
    throw slow(error) ?? new RelayError('fatal', 'rpc_unreachable')
  }
  if (response.status === 429 || response.status === 503) {
    await response.body?.cancel().catch(() => undefined)
    throw new RelayError('rate', `http_${response.status}`, retryAfterMs(response))
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new RelayError('fatal', `http_${response.status}`)
  }
  let read: { text: string | null; bytes: number }
  if (response.headers.get(REPLY_CUT) !== null) {
    // The transport read the node no further than the limit: the reply is past it, as a read cut here would be.
    await response.body?.cancel().catch(() => undefined)
    read = { text: null, bytes: limit + 1 }
  } else {
    try {
      read = await bodyWithin(response, limit)
    } catch (error) {
      throw slow(error) ?? new RelayError('fatal', 'rpc_read_failed')
    }
  }
  // A reply cut at its limit costs the answer that limit (the rest was never read; at most one chunk arrived past it).
  budget.bytes += Math.min(read.bytes, limit)
  // Changed on purpose 2026-10-02 (review of the rules, round 4): a reply cut because the answer's own budget had less left
  // than this call's cap is `budget_spent`, never the call's own `attempt_cap`: what ran out is the question's, not the
  // read's (feesLedger.ts kept it as the NFT's verdict for a month).
  if (read.text === null) throw new RelayError('bytes', limit < byteLimit ? 'budget_spent' : byteLimit < MAX_BYTES ? 'attempt_cap' : 'byte_cap')
  try {
    return JSON.parse(read.text) as unknown
  } catch {
    throw new RelayError('fatal', 'rpc_invalid_json')
  }
}

/** A JSON-RPC envelope's result, or the failure its error names (error bodies are short; only their first 2 kB are read). */
export function resultOf(envelope: unknown): unknown {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new RelayError('fatal', 'rpc_invalid_envelope')
  const body = envelope as { result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } }
  if (body.error) {
    const inner = body.error.data && typeof body.error.data === 'object' ? (body.error.data as { message?: unknown }).message : undefined
    const message = [body.error.message, inner].filter((part): part is string => typeof part === 'string').join(' ').slice(0, 2048)
    throw new RelayError(classifyRpcError(body.error.code, message), message.slice(0, 120) || 'rpc_error')
  }
  if (!('result' in body)) throw new RelayError('fatal', 'rpc_missing_result')
  return body.result
}

/** A read asked again after a growing wait (BACKOFF_MS × attempt, or the RPC's Retry-After when longer) while it is rate limited. */
export async function paced<T>(rt: FeesRuntime, budget: Budget, ask: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ask()
    } catch (error) {
      if (!(error instanceof RelayError) || error.kind !== 'rate') throw error
      budget.retryAfterMs = Math.max(budget.retryAfterMs, error.retryAfterMs, BACKOFF_MS)
      if (attempt >= RATE_ATTEMPTS) throw error
      const wait = Math.max(BACKOFF_MS * attempt, error.retryAfterMs)
      if (rt.deps.now() + wait - budget.started > DEADLINE_MS) throw error
      await rt.deps.sleep(wait)
    }
  }
}

const call = (rt: FeesRuntime, budget: Budget, method: string, params: unknown[], byteLimit?: number) =>
  paced(rt, budget, async () => resultOf(await post(rt, budget, { jsonrpc: '2.0', id: budget.calls + 1, method, params }, method === 'eth_getLogs', byteLimit)))

/**
 * The head, read at most once a second; a request that names the blocks it reads up to (`atLeast` > 0) is served by any
 * head this context has read at or past them, however old: the head only grows, and an older one only says less is final.
 */
export async function headBlock(rt: FeesRuntime, budget: Budget, atLeast: number): Promise<number> {
  const now = rt.deps.now()
  if (lastHead && lastHead.block >= atLeast && (atLeast > 0 || (now >= lastHead.at && now - lastHead.at < 1000))) return lastHead.block
  const block = quantity(await call(rt, budget, 'eth_blockNumber', []))
  // 2026-09-28 (speed wave B, item 39): dated when it was read, after any wait for its turn (the transport's pace),
  // so the next request within the second takes it.
  lastHead = { block, at: rt.deps.now() }
  return block
}

export async function aggregate(rt: FeesRuntime, budget: Budget, calls: { target: string; data: string }[], block: number | 'latest') {
  const result = await call(rt, budget, 'eth_call', [{ to: MULTICALL3, data: encodeAggregate3(calls) }, block === 'latest' ? block : hex(block)])
  if (typeof result !== 'string') throw new RelayError('fatal', 'invalid_call_result')
  let decoded: { success: boolean; data: string }[]
  try {
    decoded = decodeAggregate3(result)
  } catch {
    throw new RelayError('fatal', 'invalid_call_result')
  }
  if (decoded.length !== calls.length) throw new RelayError('fatal', 'invalid_call_result')
  return decoded
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

const STORED_AT = 'X-Fees-Stored-At'

/** `${origin}/api/fees/v1/cache/c1/{kind}/{id}/{unit}`, on the request's own origin. */
export const cacheUrl = (origin: string, kind: string, id: string, unit: string | number) => `${origin}/api/fees/v1/cache/${CACHE_VERSION}/${kind}/${id}/${unit}`

export async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** A kept JSON value and its age. The age is checked here, so the rules do not depend on the cache's own max-age. */
export async function kept<T>(rt: FeesRuntime, url: string): Promise<{ value: T; ageMs: number } | null> {
  if (!rt.cache) return null
  const entry = await rt.cache.match(new Request(url)).catch(() => undefined)
  if (!entry) return null
  const at = Number(entry.headers.get(STORED_AT))
  if (!Number.isSafeInteger(at)) return null
  try {
    return { value: (await entry.json()) as T, ageMs: Math.max(0, rt.deps.now() - at) }
  } catch {
    return null
  }
}

export async function keep(rt: FeesRuntime, url: string, value: unknown, seconds: number): Promise<void> {
  if (!rt.cache) return
  const entry = new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${seconds}`, [STORED_AT]: String(rt.deps.now()) },
  })
  const stored = rt.cache.put(new Request(url), entry).catch(() => undefined)
  if (rt.waitUntil) rt.waitUntil(stored)
  else await stored
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

/** One batch of eth_getLogs (one POST), each envelope's result in the order asked (a list of logs each, unchecked). */
export async function logsBatch(rt: FeesRuntime, budget: Budget, filters: unknown[], byteLimit?: number): Promise<unknown[]> {
  const reply = await paced(rt, budget, () => post(rt, budget, filters.map((filter, id) => ({ jsonrpc: '2.0', id, method: 'eth_getLogs', params: [filter] })), true, byteLimit))
  if (!Array.isArray(reply) || reply.length !== filters.length) throw new RelayError('fatal', 'invalid_batch')
  const out: unknown[] = Array.from({ length: filters.length })
  const seen = new Set<number>()
  for (const envelope of reply) {
    const id = (envelope as { id?: unknown } | null)?.id
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || id >= filters.length || seen.has(id)) throw new RelayError('fatal', 'invalid_batch')
    seen.add(id)
    const result = resultOf(envelope)
    if (!Array.isArray(result)) throw new RelayError('fatal', 'invalid_logs')
    out[id] = result
  }
  return out
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }

type ErrorCode = 'bad_request' | 'rate_limited' | 'rpc_unavailable' | 'too_large' | 'source_unavailable'

export function refusal(error: ErrorCode, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ v: 1, error }), { status, headers: { ...JSON_HEADERS, ...headers } })
}

const bad = (status = 400, headers: Record<string, string> = {}) => refusal('bad_request', status, headers)

/** An answer's JSON; gzip-encoded by the Function itself only when SEND_GZIP is on and the page accepts it. */
export function answer(text: string, request: Request): Response {
  const accepts = /\bgzip\b/i.test(request.headers.get('Accept-Encoding') ?? '')
  if (!SEND_GZIP || !accepts || text.length < 1024) return new Response(text, { status: 200, headers: JSON_HEADERS })
  const body = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Response(body, { status: 200, headers: { ...JSON_HEADERS, 'Content-Encoding': 'gzip' }, encodeBody: 'manual' } as ResponseInit)
}

/** The JSON object body of a same-origin POST, checked as owned.ts's ownerFrom checks it, or the refusal. */
export async function bodyOf(request: Request, url: URL, maxBytes: number): Promise<Record<string, unknown> | Response> {
  if (request.method !== 'POST') return bad(405, { Allow: 'POST' })
  const origin = request.headers.get('Origin')
  const site = request.headers.get('Sec-Fetch-Site')
  if ((origin !== null && origin !== url.origin) || (site !== null && site !== 'same-origin')) return bad(403)
  if (!(request.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json')) return bad(415)
  if (Number(request.headers.get('Content-Length') ?? '0') > maxBytes) return bad()
  let text: string | null
  try {
    text = (await bodyWithin(request, maxBytes)).text
  } catch {
    return bad()
  }
  if (text === null) return bad()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return bad()
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad()
  return body as Record<string, unknown>
}

export const keysAre = (body: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) => {
  const keys = Object.keys(body)
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key))
}
export const blockNumber = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
export const tokenIdOk = (value: unknown): value is string => typeof value === 'string' && DECIMAL_ID.test(value) && BigInt(value) <= U256
export const poolIdOk = (value: unknown): value is string => typeof value === 'string' && HASH.test(value)

/** The ids of a /state body in ascending order, or null unless it is exactly {"tokenIds": [1..8 distinct decimal ids]}. */
export function stateIdsOf(body: Record<string, unknown>): bigint[] | null {
  if (!keysAre(body, ['tokenIds']) || !Array.isArray(body.tokenIds)) return null
  const ids: unknown[] = body.tokenIds
  if (ids.length < 1 || ids.length > MAX_STATE_IDS || !ids.every(tokenIdOk) || new Set(ids).size !== ids.length) return null
  return ids.map((id) => BigInt(id)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * A /state body as its ids (ascending) and whether each one's feature is asked too: exactly {"tokenIds": [1..8]}, or
 * with "automation": true and no other value (2026-10-01, RPC-SPEC §2.5.2); null for anything else.
 * 2026-10-01 (the RPC switch's integration): and "fresh": true (no other value), the question a page asks right after
 * its owner's action (a Collect, a Close, a new mint not shown yet): it takes a kept answer only within FRESH_STATE_MS,
 * so the page shows the action's result at once rather than an answer kept from before it (the page's read ran in the
 * browser, uncached, until the switch).
 */
export function stateRequestOf(body: Record<string, unknown>): StateQuestion | null {
  if ('automation' in body && body.automation !== true) return null
  if ('fresh' in body && body.fresh !== true) return null
  const { automation, fresh, ...rest } = body
  const ids = stateIdsOf(rest)
  return ids ? { ids, automation: automation === true, fresh: fresh === true } : null
}

/** A checked /state question. */
export interface StateQuestion {
  ids: bigint[]
  automation: boolean
  /** Right after the owner's action: a kept answer counts only within FRESH_STATE_MS. Absent: false. */
  fresh?: boolean
}
/** How young a kept /state answer must be for a fresh question (2026-10-01): never one from before the action. */
export const FRESH_STATE_MS = 2_000

type Outcome = 'rate_limited' | 'rpc_unavailable'

export const outcomeOf = (error: unknown): Outcome => (error instanceof RelayError && error.kind === 'rate' ? 'rate_limited' : 'rpc_unavailable')

/**
 * How long a log route keeps a failure that our own time-out of a call ended (rpc_timeout): a minute, so the same slow
 * read is not sent to the node again by the next question (review of the rules, finding 6: kept FAILURE_SECONDS, it was
 * sent again every five seconds, while the node may still have been working on the last one).
 */
export const SLOW_FAILURE_SECONDS = 60
export const failureSeconds = (error: unknown): number => (error instanceof RelayError && error.message === 'rpc_timeout' ? SLOW_FAILURE_SECONDS : FAILURE_SECONDS)

export function failure(outcome: Outcome, retryAfterMs: number): Response {
  const seconds = String(Math.max(1, Math.ceil(Math.max(retryAfterMs, FAILURE_SECONDS * 1000) / 1000)))
  return outcome === 'rate_limited' ? refusal('rate_limited', 429, { 'Retry-After': seconds }) : refusal('rpc_unavailable', 502, { 'Retry-After': seconds })
}

// ---------------------------------------------------------------------------
// POST /api/fees/v1/state
// ---------------------------------------------------------------------------

/**
 * The positions `ids` at one block, as a StateResponse. Changed on purpose 2026-10-01 (item A21): two RPC calls, where it
 * was three (the head, then two aggregate3 at head − 2, one after the other): the first aggregate3 runs at 'latest' and
 * says which block that was (ArbSys.arbBlockNumber, as the wallet's scan reads its head), the second reads that same
 * block. Every figure is still from one block. With `nextTokenId` (item D5). `automation` (the page's, 2026-09-28, speed
 * wave B, item 17): each id's feature too, in the same two aggregates (automation.ts), as `automation`.
 */
export async function readState(rt: FeesRuntime, budget: Budget, ids: readonly bigint[], automation = false): Promise<StateResponse> {
  const first = await aggregate(
    rt,
    budget,
    [
      ...ids.flatMap((id) => [
        { target: POSITION_MANAGER, data: SELECTOR.getPoolAndPositionInfo + word(id) },
        { target: POSITION_MANAGER, data: SELECTOR.getPositionLiquidity + word(id) },
        { target: POSITION_MANAGER, data: SELECTOR.ownerOf + word(id) },
      ]),
      ...(automation ? ids.map(subscriberCall) : []),
      { target: POSITION_MANAGER, data: SELECTOR.nextTokenId },
      { target: ARB_SYS, data: ARB_BLOCK_NUMBER },
      { target: MULTICALL3, data: SELECTOR.getCurrentBlockTimestamp },
    ],
    'latest',
  )
  let subscribers: string[] = []
  try {
    subscribers = automation ? first.slice(3 * ids.length, 4 * ids.length).map(subscriberOf) : []
  } catch {
    // A subscriber that does not read as an address says nothing of the feature; the state stands.
  }
  const [next, at, stamp] = first.slice(-3)
  if (!stamp.success || !at.success) throw new RelayError('fatal', 'no_timestamp')
  const timestamp = Number(bounded(words(stamp.data, 1)[0], 48n))
  const block = Number(bounded(words(at.data, 1)[0], 48n))
  if (block <= 0) throw new RelayError('fatal', 'no_block')
  knownHead(block, rt.deps.now())
  const nextTokenId = next.success ? words(next.data, 1)[0].toString() : null

  interface Known {
    id: bigint
    owner: string
    poolId: string
    key: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }
    tickLower: number
    tickUpper: number
    liquidity: bigint
  }
  const known: Known[] = []
  const failures = new Map<bigint, 'not_found' | 'rpc_unavailable' | 'hooked_pool'>()
  ids.forEach((id, i) => {
    const [info, liquidityCall, ownerCall] = [first[3 * i], first[3 * i + 1], first[3 * i + 2]]
    // ownerOf reverts for an id never minted and for a burned one.
    if (!ownerCall.success) return void failures.set(id, 'not_found')
    if (!info.success || !liquidityCall.success) return void failures.set(id, 'rpc_unavailable')
    const w = words(info.data, 6)
    const key = { currency0: asAddress(w[0]), currency1: asAddress(w[1]), fee: Number(bounded(w[2], 24n)), tickSpacing: asInt24(w[3]), hooks: asAddress(w[4]) }
    if (key.tickSpacing <= 0) return void failures.set(id, 'not_found')
    if (BigInt(key.hooks) !== 0n) return void failures.set(id, 'hooked_pool')
    const poolId = poolIdOf(key)
    // The packed position info carries the pool id's top 25 bytes: they must match the key read with it.
    if (BigInt(poolId) >> 56n !== w[5] >> 56n) return void failures.set(id, 'rpc_unavailable')
    known.push({
      id,
      owner: asAddress(words(ownerCall.data, 1)[0]),
      poolId,
      key,
      tickLower: int24Field(w[5] >> 8n),
      tickUpper: int24Field(w[5] >> 32n),
      liquidity: bounded(words(liquidityCall.data, 1)[0], 128n),
    })
  })

  const pools = [...new Set(known.map((p) => p.poolId))]
  const currencies = [...new Set(known.flatMap((p) => [p.key.currency0, p.key.currency1]))].filter((address) => BigInt(address) !== 0n)
  const tick = (value: number) => word(BigInt(value))
  // A node behind the one that answered 'latest' may not have that block yet: asked once more a moment later. (2026-10-01,
  // the live trace on a Vivo line: 'latest' answered by a fallback, that block then asked of the chain's own RPC, which
  // said "unsupported block number".)
  const atBlock = async (calls: { target: string; data: string }[]) => {
    try {
      return await aggregate(rt, budget, calls, block)
    } catch (error) {
      if (!(error instanceof RelayError) || !/header not found|unknown block|block not found|missing trie node|unsupported block number/i.test(error.message)) throw error
      await rt.deps.sleep(400)
      return aggregate(rt, budget, calls, block)
    }
  }
  // 2026-10-02 (rugged97's rule 5): at most CALLS_PER_AGGREGATE calls in one multicall, every part at the same block
  // (eight positions of eight pools ask 8 + 16 + 32 + the vaults' calls).
  const secondCalls = [
    ...pools.map((poolId) => ({ target: STATE_VIEW, data: SELECTOR.getSlot0 + poolId.slice(2) })),
    ...known.flatMap((p) => [
      { target: STATE_VIEW, data: SELECTOR.getFeeGrowthInside + p.poolId.slice(2) + tick(p.tickLower) + tick(p.tickUpper) },
      { target: STATE_VIEW, data: SELECTOR.getPositionInfo + p.poolId.slice(2) + addressWord(POSITION_MANAGER) + tick(p.tickLower) + tick(p.tickUpper) + word(p.id) },
    ]),
    ...currencies.flatMap((address) => [
      { target: address, data: SELECTOR.symbol },
      { target: address, data: SELECTOR.decimals },
    ]),
    ...vaultCalls(vaultsOf(subscribers)),
  ]
  const second: { success: boolean; data: string }[] = []
  if (known.length > 0) for (let i = 0; i < secondCalls.length; i += CALLS_PER_AGGREGATE) second.push(...(await atBlock(secondCalls.slice(i, i + CALLS_PER_AGGREGATE))))
  const slot0 = new Map<string, { sqrtPriceX96: bigint; tick: number; protocolFee: number } | null>()
  pools.forEach((poolId, i) => {
    const result = second[i]
    if (!result.success) return void slot0.set(poolId, null)
    const [price, current, protocol] = words(result.data, 3)
    slot0.set(poolId, price === 0n ? null : { sqrtPriceX96: bounded(price, 160n), tick: asInt24(current), protocolFee: Number(bounded(protocol, 24n)) })
  })
  const tokenAt = pools.length + known.length * 2
  const tokens = new Map<string, StateCurrency>()
  currencies.forEach((address, i) => {
    const [symbolCall, decimalsCall] = [second[tokenAt + 2 * i], second[tokenAt + 2 * i + 1]]
    const decimals = decimalsCall.success && decimalsCall.data.length >= 64 ? BigInt(`0x${decimalsCall.data.slice(0, 64)}`) : null
    tokens.set(address, { address, symbol: symbolCall.success ? decodeSymbol(symbolCall.data) : null, decimals: decimals !== null && decimals <= 255n ? Number(decimals) : null })
  })
  const currency = (address: string): StateCurrency => (BigInt(address) === 0n ? { address, symbol: 'ETH', decimals: 18 } : (tokens.get(address) ?? { address, symbol: null, decimals: null }))

  const answered = new Map<bigint, StatePosition>()
  known.forEach((p, i) => {
    const [insideCall, lastCall] = [second[pools.length + 2 * i], second[pools.length + 2 * i + 1]]
    const pool = slot0.get(p.poolId)
    if (!pool || !insideCall.success || !lastCall.success) return void answered.set(p.id, { tokenId: p.id.toString(), ok: false, reason: 'rpc_unavailable' })
    const inside = words(insideCall.data, 2)
    const [coreLiquidity, last0, last1] = words(lastCall.data, 3)
    // The PositionManager's liquidity and the core position's are one number; two answers mean a misread.
    if (coreLiquidity !== p.liquidity) return void answered.set(p.id, { tokenId: p.id.toString(), ok: false, reason: 'rpc_unavailable' })
    // v4's own figure: L × ((inside − last) mod 2^256) / 2^128.
    const owed = (now: bigint, before: bigint) => (((now - before) & U256) * coreLiquidity) >> 128n
    answered.set(p.id, {
      tokenId: p.id.toString(),
      ok: true,
      owner: p.owner,
      poolId: p.poolId,
      poolKey: p.key,
      currencies: [currency(p.key.currency0), currency(p.key.currency1)],
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      liquidity: p.liquidity.toString(),
      sqrtPriceX96: pool.sqrtPriceX96.toString(),
      tick: pool.tick,
      feeGrowthInside0X128: inside[0].toString(),
      feeGrowthInside1X128: inside[1].toString(),
      feeGrowthInside0LastX128: last0.toString(),
      feeGrowthInside1LastX128: last1.toString(),
      unclaimed0: owed(inside[0], last0).toString(),
      unclaimed1: owed(inside[1], last1).toString(),
      protocolFee: pool.protocolFee,
    })
  })
  const positions = ids.map((id): StatePosition => answered.get(id) ?? { tokenId: id.toString(), ok: false, reason: failures.get(id) ?? 'rpc_unavailable' })
  const vaultsAt = tokenAt + currencies.length * 2
  return { v: 1, block, timestamp, positions, ...(nextTokenId !== null ? { nextTokenId } : {}), ...(known.length && subscribers.length ? { automation: automationsOf(ids, subscribers, second.slice(vaultsAt)) } : {}) }
}

type StateKept = { outcome: 'answer'; text: string } | { outcome: Outcome }

/**
 * POST /api/fees/v1/state: up to 8 positions at one block; kept 10 s per id set, a failure 5 s. 2026-10-01 (RPC-SPEC
 * §2.5.2): with "automation": true, each position's feature too, kept under its own key.
 */
export async function answerState(request: Request, rt: FeesRuntime): Promise<Response> {
  const url = new URL(request.url)
  const body = await bodyOf(request, url, STATE_BODY_BYTES)
  if (body instanceof Response) return body
  const asked = stateRequestOf(body)
  if (!asked) return bad()
  return stateAnswer(request, rt, asked)
}

/** answerState once its request is checked (the edge route checks it, the visitor's rate and the node's secret first). */
export async function stateAnswer(request: Request, rt: FeesRuntime, asked: StateQuestion): Promise<Response> {
  const url = new URL(request.url)
  const { ids, automation } = asked
  const fresh = asked.fresh === true
  const key = cacheUrl(url.origin, 'state', await sha256(ids.join(',') + (automation ? '|a' : '')), 0)
  const hit = await kept<StateKept>(rt, key)
  // A fresh question takes a kept answer only when it is younger than FRESH_STATE_MS, and replaces it; a kept failure
  // stands for every question, fresh or not, so asking fresh in a loop is not a loop of node reads.
  if (hit?.value.outcome === 'answer' && hit.ageMs < (fresh ? FRESH_STATE_MS : SHORT_SECONDS * 1000)) return answer(hit.value.text, request)
  if (hit && hit.value.outcome !== 'answer' && hit.ageMs < FAILURE_SECONDS * 1000) return failure(hit.value.outcome, FAILURE_SECONDS * 1000 - hit.ageMs)
  const budget = newBudget(rt)
  // A fresh read never joins one that started before it (it may predate the action); both keep their answer under `key`.
  const outcome = await shared(rt, fresh ? `${key}#fresh` : key, async (): Promise<StateKept> => {
    try {
      const done: StateKept = { outcome: 'answer', text: JSON.stringify(await readState(rt, budget, ids, automation)) }
      await keep(rt, key, done, SHORT_SECONDS)
      return done
    } catch (error) {
      const code: StateKept = { outcome: outcomeOf(error) }
      await keep(rt, key, code, FAILURE_SECONDS)
      return code
    }
  })
  return outcome.outcome === 'answer' ? answer(outcome.text, request) : failure(outcome.outcome, budget.retryAfterMs)
}

// ---------------------------------------------------------------------------
// The Pages runtime
// ---------------------------------------------------------------------------

/** The Workers cache where the runtime has one (typed here: the repo compiles functions/ with the DOM lib and no workers types). */
export function defaultCache(): FeesCache | null {
  const storage = (globalThis as unknown as { caches?: { default?: FeesCache } }).caches
  return storage?.default ?? null
}

/** The runtime a Pages Function context gives. */
export function runtimeOf(context: { waitUntil?: (work: Promise<unknown>) => void }): FeesRuntime {
  return {
    deps: { fetch: (input, init) => fetch(input, init), sleep: (ms) => new Promise((done) => setTimeout(done, ms)), now: () => Date.now() },
    cache: defaultCache(),
    waitUntil: context.waitUntil ? (work) => context.waitUntil?.(work) : undefined,
  }
}
