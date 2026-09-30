/**
 * The fees relay: two same-origin Functions over the chain's public RPC that
 * give the browser what it needs to rebuild one position NFT's fee history
 * exactly (DESIGN-V2 §15; fees-evolution.md §3 and §7).
 *
 *   POST /api/fees/v1/state  {"tokenIds": [...]}   up to 8 positions read at one block
 *                                                   (head − 2): range, liquidity, price,
 *                                                   fee growth and the exact unclaimed fees
 *   POST /api/fees/v1/logs   {"kind": ..., ...}     one pool's or one NFT's event logs, in
 *                                                   fixed units, validated, compacted, cached
 *
 * What this is not: a general RPC proxy. The caller chooses a kind and a pool
 * id, a token id, or block numbers on a fixed grid; the endpoint, every
 * method (eth_blockNumber, eth_call to Multicall3, eth_getLogs,
 * eth_getBlockByNumber), contract, topic and calldata are fixed here. Every
 * answer is capped in RPC calls, RPC bytes and time, and what it reads is kept
 * in the Workers cache under a versioned key: a unit of logs whose last block
 * is SAFE_DEPTH below the head can no longer change, so it is kept for a year
 * and a busy pool's logs are read once per data centre, not once per viewer.
 * Every RPC body is parsed and validated before it is used or kept; a body
 * that does not validate is an RPC failure and is never kept.
 *
 * The gate middleware runs first, as for every /api path, and sets no-store,
 * no-transform and the API CSP on the way out. No secret is involved: the RPC
 * is the chain's public one and every answer is public chain data.
 *
 * 2026-09-25: the RPC answers 429 to every call from Cloudflare's shared
 * egress, so the page and the replay worker now run these same reads
 * themselves, against the public RPC from the browser (stateOnChain and
 * logsOnChain below, through src/lib/fees/client.ts), with an in-memory cache
 * in place of the Workers cache. The two routes stay, tested; nothing on the
 * page asks them.
 */
import {
  BACKOFF_MS,
  FIRST_TRANSFER_BLOCK,
  LOG_BLOCKS_MANY,
  LOG_BLOCKS_ONE,
  MIN_SPLIT_BLOCKS,
  MULTICALL3,
  POSITION_MANAGER,
  RATE_ATTEMPTS,
  RPC_URL,
  bodyWithin,
  classifyRpcError,
  decodeAggregate3,
  encodeAggregate3,
  keccak256,
  timeoutSignal,
} from './owned'
import { automationsOf, subscriberCall, subscriberOf, vaultCalls, vaultsOf } from './automation'
import type { CompactEvent, CompactLog, LogsRequest, LogsResponse, LogsUnit, RelayAnswer, StateCurrency, StatePosition, StateResponse } from '../../src/lib/fees/types'

// ---------------------------------------------------------------------------
// Pins (checked against viem and the deployment profile in tests/fees-topics.test.mjs)
// ---------------------------------------------------------------------------

/** Uniswap v4 PoolManager on Robinhood Chain (docs/deployments/v1-robinhood-mainnet-2026-09-21/deployment.json). */
export const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
/** Uniswap v4 StateView on Robinhood Chain (the same profile; app/src/finance/pin.ts STATE_VIEW). */
export const STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'

export const TOPIC = {
  Transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  Initialize: '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438',
  ModifyLiquidity: '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec',
  Swap: '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
  Donate: '0x29ef05caaff9404b7cb6d1c0e9bbae9eaa7ab2541feba1a9c4248594c08156cb',
  ProtocolFeeUpdated: '0xe9c42593e71f84403b84352cd168d693e2c9fcd1fdbcc3feb21d92b43e6696f9',
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
} as const

/** Per event: its compact code, its topic count (topic0 included) and its data words. */
const EVENTS: Readonly<Record<string, { code: CompactEvent; topics: number; words: number }>> = {
  [TOPIC.Initialize]: { code: 0, topics: 4, words: 5 },
  [TOPIC.ModifyLiquidity]: { code: 1, topics: 3, words: 4 },
  [TOPIC.ProtocolFeeUpdated]: { code: 2, topics: 2, words: 1 },
  [TOPIC.Swap]: { code: 3, topics: 3, words: 6 },
  [TOPIC.Donate]: { code: 4, topics: 3, words: 2 },
  [TOPIC.Transfer]: { code: 5, topics: 4, words: 0 },
}

// ---------------------------------------------------------------------------
// Sizes and limits
// ---------------------------------------------------------------------------

export const HOUR_SPAN = 36_000
export const DAY_SPAN = 864_000
export const EPOCH_SPAN = 3_600_000
/** A unit ending at least this far below the head is final (about 30 minutes at ~9.9 blocks/s). */
export const SAFE_DEPTH = 18_000
/** The most RPC calls one answer may cost, retries and splits included. */
export const MAX_RPC_CALLS = 32
/** The most raw RPC bytes one answer may read (the isolate has 128 MB and shares it). */
export const MAX_BYTES = 8 * 1024 * 1024
/** The most compact log bytes one answer carries: days stop there (the first day is always carried). */
export const MAX_ANSWER_BYTES = 8 * 1024 * 1024
/** A whole day is first asked in one call and read no further than this; a busier day is asked by the hour. */
export const DAY_ATTEMPT_BYTES = 2 * 1024 * 1024
/** A whole pool epoch likewise; a busier one (a pool whose positions are rebalanced all day) is asked in parts. */
export const EPOCH_ATTEMPT_BYTES = 4 * 1024 * 1024
/** One part of a busy pool epoch: a tenth of it (about 10 hours). */
export const EPOCH_PART_SPAN = 360_000
/** Below this many bytes spent, an hour that does not fit is too large for any answer. */
const FRESH_BUDGET_BYTES = 64 * 1024
export const DEADLINE_MS = 25_000
const CALL_TIMEOUT_MS = 10_000
export const MAX_STATE_IDS = 8
export const MAX_DAYS = 7
export const MAX_HEADERS = 50
/** swapBefore: the first window's size, its growth per try, and the most windows asked (the last reaches block 0). */
export const BEFORE_FIRST_SPAN = 3_000
export const BEFORE_GROWTH = 4
export const BEFORE_TRIES = 8
/**
 * probe (2026-09-25): the most blocks one probe covers (an hour, one HOUR_SPAN), and the most bytes its reply may take. A
 * position page's replay asks it before any of the pool's history, to tell a history it can plausibly verify from one
 * it never can, from one small read: more than that many bytes in an hour is more than any budget of the page. An hour,
 * not six minutes: PONS/USDG's pool, 47 logs in one six-minute window, showed 2 in another on the same morning.
 */
export const PROBE_SPAN = 36_000
export const PROBE_BYTES = 64 * 1024
/**
 * A pool epoch asked in parts from the start (`parts: true`, 2026-09-25): the most bytes one part's reply may take; a
 * part past it ends the answer as too large. The replay in a visitor's browser asks a pool whose probe projects a large
 * epoch this way, so no single reply is large: USDG/DELTA's epochs came back whole at 1 and 1.7 MB, and the public RPC
 * refuses an address's next reads after a reply of a few hundred kB.
 */
export const PART_REPLY_BYTES = 256 * 1024
/** How long a /state answer and a unit that can still change are kept. */
export const SHORT_SECONDS = 10
/** How long a day not yet final stays marked as busy (asked by the hour). */
export const BUSY_SECONDS = 3_600
/** How long a final unit is kept. */
export const FINAL_SECONDS = 31_536_000
/** How long a failure is kept, so a loop of questions is not a loop of RPC calls. */
export const FAILURE_SECONDS = 5
export const STATE_BODY_BYTES = 512
export const LOGS_BODY_BYTES = 1024
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
  /**
   * 2026-09-25: a runtime that paces its calls to the RPC's per-IP limit (the
   * page's replay worker, src/lib/chain/browser.ts chainLane) waits here for
   * its turn before each call, and says how long it waited: that wait is not
   * the answer's own time, and the call's time-out starts after it. A
   * Function has none.
   */
  turn?: () => Promise<number>
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

/** A request the relay refuses once it knows the head (a header block off the grid and not recent). */
class Refused extends Error {}

/** What one answer has spent. */
export interface Budget {
  calls: number
  bytes: number
  started: number
  retryAfterMs: number
}

export const newBudget = (rt: FeesRuntime): Budget => ({ calls: 0, bytes: 0, started: rt.deps.now(), retryAfterMs: 0 })

/** Simultaneous questions for one key in this isolate share one read. */
const inflight = new Map<string, Promise<unknown>>()

function shared<T>(key: string, work: () => Promise<T>): Promise<T> {
  const running = inflight.get(key) as Promise<T> | undefined
  if (running) return running
  const started = work().finally(() => inflight.delete(key))
  inflight.set(key, started)
  return started
}

/** The head as this isolate last read it, reused for one second. */
let lastHead: { block: number; at: number } | null = null

/**
 * 2026-09-28 (speed wave B, item 39): a head this context learned elsewhere (the replay worker: the block of the state
 * its run replays up to, read by the page a moment ago), taken as read now when it is past the one remembered.
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
const DATA = /^0x(?:[0-9a-f]{64})*$/
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
  // No control characters and no line or paragraph separators: a symbol is one short run of text.
  return [...text].some((ch) => { const code = ch.codePointAt(0) ?? 0; return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 }) ? null : text
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
  if (rt.deps.turn) {
    // A paced runtime's wait for its turn moves the answer's start, so the deadline counts only the RPC's own time.
    budget.started += await rt.deps.turn()
    if (rt.deps.cancelled?.()) throw new RelayError('fatal', 'cancelled')
  }
  if (rt.deps.now() - budget.started > DEADLINE_MS) throw new RelayError('deadline', 'deadline')
  budget.calls += 1
  // A call that took too long is, for a log range, a range too large; any other call fails.
  const slow = (error: unknown) => {
    const name = error instanceof Error ? error.name : ''
    return name === 'TimeoutError' || name === 'AbortError' ? new RelayError(logs ? 'range' : 'fatal', 'rpc_timeout') : null
  }
  let response: Response
  try {
    response = await rt.deps.fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: timeoutSignal(CALL_TIMEOUT_MS),
    })
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
  const limit = Math.min(byteLimit, MAX_BYTES - budget.bytes)
  let read: { text: string | null; bytes: number }
  try {
    read = await bodyWithin(response, limit)
  } catch (error) {
    throw slow(error) ?? new RelayError('fatal', 'rpc_read_failed')
  }
  // A reply cut at its limit costs the answer that limit (the rest was never read; at most one chunk arrived past it).
  budget.bytes += Math.min(read.bytes, limit)
  if (read.text === null) throw new RelayError('bytes', byteLimit < MAX_BYTES ? 'attempt_cap' : 'byte_cap')
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
 * The head, read at most once a second; 2026-09-27: a request that names the blocks it reads up to (`atLeast` > 0: a
 * replay's pool epochs, swap days, probes, headers and Swap before its mint, all up to its state block) is served by any
 * head this context has read at or past them, however old, as feesPath.ts's reads are: the head only grows, and an older
 * one only says less is final. The replay worker asked one eth_blockNumber before most of its requests (six of 27 in the
 * owner's USDG/UFG history, a round trip and a turn in its lane each, measured live that day).
 */
export async function headBlock(rt: FeesRuntime, budget: Budget, atLeast: number): Promise<number> {
  const now = rt.deps.now()
  if (lastHead && lastHead.block >= atLeast && (atLeast > 0 || (now >= lastHead.at && now - lastHead.at < 1000))) return lastHead.block
  const block = quantity(await call(rt, budget, 'eth_blockNumber', []))
  // 2026-09-28 (speed wave B, item 39): dated when it was read, after any wait for its turn (the replay worker's lane),
  // so the next request within the second takes it.
  lastHead = { block, at: rt.deps.now() }
  return block
}

async function aggregate(rt: FeesRuntime, budget: Budget, calls: { target: string; data: string }[], block: number) {
  const result = await call(rt, budget, 'eth_call', [{ to: MULTICALL3, data: encodeAggregate3(calls) }, hex(block)])
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

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** A kept JSON value and its age. The age is checked here, so the rules do not depend on the cache's own max-age. */
async function kept<T>(rt: FeesRuntime, url: string): Promise<{ value: T; ageMs: number } | null> {
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

async function keep(rt: FeesRuntime, url: string, value: unknown, seconds: number): Promise<void> {
  if (!rt.cache) return
  const entry = new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${seconds}`, [STORED_AT]: String(rt.deps.now()) },
  })
  const stored = rt.cache.put(new Request(url), entry).catch(() => undefined)
  if (rt.waitUntil) rt.waitUntil(stored)
  else await stored
}

// ---------------------------------------------------------------------------
// Logs: validation and compaction
// ---------------------------------------------------------------------------

export interface LogFilter {
  address: string
  topic0: readonly string[]
  /** topic1 must equal this (a pool id). */
  topic1?: string
  /** topic3 must equal this (a token id word, for `transfer`). */
  topic3?: string
}

/** One RPC log, checked against the filter and the range asked, as a CompactLog; any mismatch fails the whole reply. */
export function compact(raw: unknown, filter: LogFilter, from: number, to: number): CompactLog {
  if (!raw || typeof raw !== 'object') throw new RelayError('fatal', 'invalid_log')
  const log = raw as { address?: unknown; topics?: unknown; data?: unknown; blockNumber?: unknown; logIndex?: unknown; transactionHash?: unknown; removed?: unknown }
  if (log.removed === true) throw new RelayError('fatal', 'removed_log')
  if (typeof log.address !== 'string' || log.address.toLowerCase() !== filter.address) throw new RelayError('fatal', 'invalid_log_address')
  if (!Array.isArray(log.topics) || log.topics.some((topic) => typeof topic !== 'string' || !HASH.test(topic.toLowerCase()))) throw new RelayError('fatal', 'invalid_log_topics')
  const topics = (log.topics as string[]).map((topic) => topic.toLowerCase())
  const event = EVENTS[topics[0]]
  if (!event || !filter.topic0.includes(topics[0]) || topics.length !== event.topics) throw new RelayError('fatal', 'invalid_log_topics')
  if (filter.topic1 !== undefined && topics[1] !== filter.topic1) throw new RelayError('fatal', 'invalid_log_topics')
  if (filter.topic3 !== undefined && topics[3] !== filter.topic3) throw new RelayError('fatal', 'invalid_log_topics')
  const block = quantity(log.blockNumber)
  if (block < from || block > to) throw new RelayError('fatal', 'log_out_of_range')
  const index = quantity(log.logIndex)
  if (typeof log.transactionHash !== 'string' || !HASH.test(log.transactionHash.toLowerCase())) throw new RelayError('fatal', 'invalid_log_tx')
  if (typeof log.data !== 'string') throw new RelayError('fatal', 'invalid_log_data')
  const data = log.data.toLowerCase()
  if (!DATA.test(data) || (data.length - 2) / 64 !== event.words) throw new RelayError('fatal', 'invalid_log_data')
  return [block, index, event.code, log.transactionHash.toLowerCase(), topics.slice(1), data]
}

const byPosition = (a: CompactLog, b: CompactLog) => a[0] - b[0] || a[1] - b[1]

/** The kinds the relay answers: every LogsRequest but the price path's (2026-09-25, feesPath.ts, the replay worker's own). */
export type RelayRequest = Exclude<LogsRequest, { kind: 'span' | 'settlements' | 'modifies' }>

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

/**
 * 2026-09-28 (owned.ts LOG_BLOCKS_MANY): the events a read of `blocks` blocks asks per filter: all of them in one below
 * that width, else one each (the filters of one batch). `topicOf0` is a filter's first topic for them.
 */
export const eachEvent = (topic0: readonly string[], blocks: number): (readonly string[])[] => (topic0.length > 1 && blocks > LOG_BLOCKS_MANY ? topic0.map((topic) => [topic]) : [topic0])
export const topicOf0 = (topic0: readonly string[]): string | readonly string[] => (topic0.length === 1 ? topic0[0] : topic0)

/**
 * eth_getLogs over [from, to], validated and compacted, in chain order. A
 * range the RPC refuses as too large or too slow is halved down to
 * MIN_SPLIT_BLOCKS, unless the call is a first try with its own byte limit
 * (a whole day), whose refusal the caller answers by asking hour by hour.
 * 2026-09-28 (owned.ts LOG_BLOCKS_ONE): a range wider than the RPC serves at all is asked in windows of that width,
 * oldest first, rather than refused first and halved; and several events over more than LOG_BLOCKS_MANY blocks are
 * asked as one filter per event, in one batch (one POST, one reply whose bytes count as the one reply did), each
 * event's logs checked against its own filter.
 */
async function rangeLogs(rt: FeesRuntime, budget: Budget, filter: LogFilter, from: number, to: number, byteLimit?: number): Promise<CompactLog[]> {
  if (byteLimit === undefined && to - from >= LOG_BLOCKS_ONE) return [...(await rangeLogs(rt, budget, filter, from, from + LOG_BLOCKS_ONE - 1)), ...(await rangeLogs(rt, budget, filter, from + LOG_BLOCKS_ONE, to))]
  const parts = eachEvent(filter.topic0, to - from + 1)
  const filters = parts.map((topic0) => ({ address: filter.address, fromBlock: hex(from), toBlock: hex(to), topics: [topicOf0(topic0), ...(filter.topic1 === undefined ? [] : [filter.topic1]), ...(filter.topic3 === undefined ? [] : [null, null, filter.topic3])] }))
  let results: unknown[]
  try {
    results = parts.length > 1 ? await logsBatch(rt, budget, filters, byteLimit) : [await call(rt, budget, 'eth_getLogs', filters, byteLimit)]
  } catch (error) {
    if (error instanceof RelayError && error.kind === 'range' && byteLimit === undefined && to - from + 1 >= 2 * MIN_SPLIT_BLOCKS) {
      const middle = from + Math.floor((to - from) / 2)
      return [...(await rangeLogs(rt, budget, filter, from, middle)), ...(await rangeLogs(rt, budget, filter, middle + 1, to))]
    }
    throw error
  }
  return results
    .flatMap((result, i) => {
      if (!Array.isArray(result)) throw new RelayError('fatal', 'invalid_logs')
      const own: LogFilter = { ...filter, topic0: parts[i] }
      return result.map((raw) => compact(raw, own, from, to))
    })
    .sort(byPosition)
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }

type ErrorCode = 'bad_request' | 'rate_limited' | 'rpc_unavailable' | 'too_large'

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
async function bodyOf(request: Request, url: URL, maxBytes: number): Promise<Record<string, unknown> | Response> {
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

/** A /logs body as a LogsRequest, or null unless it is exactly one (exact keys, safe integers, lowercase hex). */
export function logsRequestOf(body: Record<string, unknown>): RelayRequest | null {
  switch (body.kind) {
    case 'transfer': {
      // 2026-09-27: `until` too, a window [since, until] never backwards.
      const { since, until } = body
      if (!keysAre(body, ['kind', 'tokenId'], ['since', 'until']) || !tokenIdOk(body.tokenId) || [since, until].some((block) => block !== undefined && !blockNumber(block)) || (until as number) < (since as number)) return null
      return { kind: 'transfer', tokenId: body.tokenId, ...(since === undefined ? {} : { since: since as number }), ...(until === undefined ? {} : { until: until as number }) }
    }
    case 'initialize':
      return keysAre(body, ['kind', 'poolId']) && poolIdOk(body.poolId) ? { kind: 'initialize', poolId: body.poolId } : null
    case 'pool': {
      if (!keysAre(body, ['kind', 'poolId', 'epoch'], ['until', 'parts']) || !poolIdOk(body.poolId) || !blockNumber(body.epoch) || (body.epoch + 1) * EPOCH_SPAN > Number.MAX_SAFE_INTEGER) return null
      if (body.until !== undefined && !blockNumber(body.until)) return null
      if (body.parts !== undefined && body.parts !== true) return null
      const base = { kind: 'pool' as const, poolId: body.poolId, epoch: body.epoch, ...(body.parts === true ? { parts: true as const } : {}) }
      return body.until === undefined ? base : { ...base, until: body.until as number }
    }
    case 'swaps': {
      if (!keysAre(body, ['kind', 'poolId', 'day', 'count'], ['until']) || !poolIdOk(body.poolId) || !blockNumber(body.day) || (body.day + MAX_DAYS) * DAY_SPAN > Number.MAX_SAFE_INTEGER) return null
      if (typeof body.count !== 'number' || !Number.isSafeInteger(body.count) || body.count < 1 || body.count > MAX_DAYS) return null
      if (body.until !== undefined && !blockNumber(body.until)) return null
      const base = { kind: 'swaps' as const, poolId: body.poolId, day: body.day, count: body.count }
      return body.until === undefined ? base : { ...base, until: body.until as number }
    }
    case 'swapBefore': {
      if (!keysAre(body, ['kind', 'poolId', 'block'], ['since']) || !poolIdOk(body.poolId) || !blockNumber(body.block) || body.block <= 0) return null
      if (body.since === undefined) return { kind: 'swapBefore', poolId: body.poolId, block: body.block }
      return blockNumber(body.since) && body.since < body.block ? { kind: 'swapBefore', poolId: body.poolId, block: body.block, since: body.since } : null
    }
    case 'probe':
      return keysAre(body, ['kind', 'poolId', 'from', 'to']) && poolIdOk(body.poolId) && blockNumber(body.from) && blockNumber(body.to) && body.from <= body.to && body.to - body.from < PROBE_SPAN
        ? { kind: 'probe', poolId: body.poolId, from: body.from, to: body.to }
        : null
    case 'headers': {
      if (!keysAre(body, ['kind', 'blocks']) || !Array.isArray(body.blocks) || body.blocks.length < 1 || body.blocks.length > MAX_HEADERS) return null
      const blocks: unknown[] = body.blocks
      if (!blocks.every(blockNumber) || new Set(blocks).size !== blocks.length) return null
      // Grid blocks, plus at most one other (the state block a client pins to), so the cache keys stay few.
      if (blocks.filter((block) => block % HOUR_SPAN !== 0).length > 1) return null
      return { kind: 'headers', blocks: [...blocks] }
    }
    default:
      return null
  }
}

/** The ids of a /state body in ascending order, or null unless it is exactly {"tokenIds": [1..8 distinct decimal ids]}. */
export function stateIdsOf(body: Record<string, unknown>): bigint[] | null {
  if (!keysAre(body, ['tokenIds']) || !Array.isArray(body.tokenIds)) return null
  const ids: unknown[] = body.tokenIds
  if (ids.length < 1 || ids.length > MAX_STATE_IDS || !ids.every(tokenIdOk) || new Set(ids).size !== ids.length) return null
  return ids.map((id) => BigInt(id)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

type Outcome = 'rate_limited' | 'rpc_unavailable'

const outcomeOf = (error: unknown): Outcome => (error instanceof RelayError && error.kind === 'rate' ? 'rate_limited' : 'rpc_unavailable')

function failure(outcome: Outcome, retryAfterMs: number): Response {
  const seconds = String(Math.max(1, Math.ceil(Math.max(retryAfterMs, FAILURE_SECONDS * 1000) / 1000)))
  return outcome === 'rate_limited' ? refusal('rate_limited', 429, { 'Retry-After': seconds }) : refusal('rpc_unavailable', 502, { 'Retry-After': seconds })
}

// ---------------------------------------------------------------------------
// POST /api/fees/v1/state
// ---------------------------------------------------------------------------

/**
 * The positions `ids` at head − 2, as a StateResponse: three RPC calls (the head and two aggregate3 at one block).
 * `automation` (the page's, 2026-09-28, speed wave B, item 17): each id's feature too, in the same two aggregates
 * (automation.ts), as `automation`.
 */
export async function readState(rt: FeesRuntime, budget: Budget, ids: readonly bigint[], automation = false): Promise<StateResponse> {
  const head = await headBlock(rt, budget, 0)
  const block = Math.max(0, head - 2)
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
      { target: MULTICALL3, data: SELECTOR.getCurrentBlockTimestamp },
    ],
    block,
  )
  let subscribers: string[] = []
  try {
    subscribers = automation ? first.slice(3 * ids.length, 4 * ids.length).map(subscriberOf) : []
  } catch {
    // A subscriber that does not read as an address says nothing of the feature; the state stands.
  }
  const stamp = first[first.length - 1]
  if (!stamp.success) throw new RelayError('fatal', 'no_timestamp')
  const timestamp = Number(bounded(words(stamp.data, 1)[0], 48n))

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
  const second =
    known.length === 0
      ? []
      : await aggregate(
          rt,
          budget,
          [
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
          ],
          block,
        )
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
  return { v: 1, block, timestamp, positions, ...(known.length && subscribers.length ? { automation: automationsOf(ids, subscribers, second.slice(vaultsAt)) } : {}) }
}

type StateKept = { outcome: 'answer'; text: string } | { outcome: Outcome }

/** POST /api/fees/v1/state: up to 8 positions at one block; kept 10 s per id set, a failure 5 s. */
export async function answerState(request: Request, rt: FeesRuntime): Promise<Response> {
  const url = new URL(request.url)
  const body = await bodyOf(request, url, STATE_BODY_BYTES)
  if (body instanceof Response) return body
  const ids = stateIdsOf(body)
  if (!ids) return bad()
  const key = cacheUrl(url.origin, 'state', await sha256(ids.join(',')), 0)
  const hit = await kept<StateKept>(rt, key)
  if (hit?.value.outcome === 'answer' && hit.ageMs < SHORT_SECONDS * 1000) return answer(hit.value.text, request)
  if (hit && hit.value.outcome !== 'answer' && hit.ageMs < FAILURE_SECONDS * 1000) return failure(hit.value.outcome, FAILURE_SECONDS * 1000 - hit.ageMs)
  const budget = newBudget(rt)
  const outcome = await shared(key, async (): Promise<StateKept> => {
    try {
      const done: StateKept = { outcome: 'answer', text: JSON.stringify(await readState(rt, budget, ids)) }
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
// POST /api/fees/v1/logs
// ---------------------------------------------------------------------------

/** A kept unit: its first block, its last block as read (`to`, the cut on the head side), whether it is final, and its logs. */
interface KeptUnit {
  from: number
  to: number
  final: boolean
  logs: CompactLog[]
}

const POOL_EVENTS = [TOPIC.Initialize, TOPIC.ModifyLiquidity, TOPIC.ProtocolFeeUpdated]
export const SWAP_EVENTS = [TOPIC.Swap, TOPIC.Donate]

export const poolFilter = (poolId: string, topic0: readonly string[]): LogFilter => ({ address: POOL_MANAGER, topic0, topic1: poolId })

/** A kept unit as it was up to `cut`. */
function trimmed(unit: KeptUnit, cut: number): KeptUnit {
  if (unit.to <= cut) return unit
  return { from: unit.from, to: cut, final: false, logs: unit.logs.filter((log) => log[0] <= cut) }
}

interface UnitSpec {
  /** The cache key. */
  url: string
  /** The unit's own range. */
  from: number
  to: number
}

/**
 * A unit's logs from its first block to `cut` (≤ its last): a kept entry that
 * reaches `cut` (final, or younger than SHORT_SECONDS), else `read` and keep
 * it: for a year when the whole unit is SAFE_DEPTH below the head, else for
 * SHORT_SECONDS with the block it was cut at.
 */
async function unitLogs(rt: FeesRuntime, head: number, spec: UnitSpec, cut: number, read: () => Promise<CompactLog[]>): Promise<KeptUnit> {
  const hit = await kept<KeptUnit>(rt, spec.url)
  if (hit && (hit.value.final || (hit.value.to >= cut && hit.ageMs < SHORT_SECONDS * 1000))) return trimmed(hit.value, cut)
  return shared(`${spec.url}#${cut}`, async () => {
    const logs = await read()
    const final = cut === spec.to && spec.to <= head - SAFE_DEPTH
    const unit: KeptUnit = { from: spec.from, to: cut, final, logs }
    await keep(rt, spec.url, unit, final ? FINAL_SECONDS : SHORT_SECONDS)
    return unit
  })
}

const logsBytes = (logs: CompactLog[]) => JSON.stringify(logs).length

/**
 * One unit of logs up to `cut`, asked whole first (read no further than
 * `attemptBytes`); a unit too busy for that (too many logs, too many bytes) is
 * marked busy and asked in parts of `partSpan` blocks, each part kept on its
 * own, so an answer that runs out of calls or bytes midway leaves its complete
 * parts for the next. Used by busy swap days (parts = hours) and busy pool
 * epochs (parts = tenths).
 */
interface PartedUnit {
  kind: 'swaps' | 'pool'
  partKind: 'swapsHour' | 'poolPart'
  busyKind: 'swapsBusy' | 'poolBusy'
  poolId: string
  unit: number
  from: number
  to: number
  partSpan: number
  attemptBytes: number
  filter: LogFilter
  /** Asked in parts from the start, each part's reply at most this many bytes (the pool's `parts` request). */
  partBytes?: number
}

async function partedLogs(rt: FeesRuntime, budget: Budget, origin: string, head: number, spec: PartedUnit, cut: number): Promise<KeptUnit> {
  const { from, to, filter, poolId } = spec
  const busy = cacheUrl(origin, spec.busyKind, poolId, spec.unit)
  return unitLogs(rt, head, { url: cacheUrl(origin, spec.kind, poolId, spec.unit), from, to }, cut, async () => {
    if (spec.partBytes === undefined && !(await kept<{ busy: true }>(rt, busy))) {
      try {
        return await rangeLogs(rt, budget, filter, from, cut, spec.attemptBytes)
      } catch (error) {
        if (!(error instanceof RelayError) || (error.kind !== 'range' && error.kind !== 'bytes')) throw error
        // Busy stays busy: the unit is asked in parts from now on, even before it is final.
        await keep(rt, busy, { busy: true }, cut === to && to <= head - SAFE_DEPTH ? FINAL_SECONDS : BUSY_SECONDS)
        if (budget.bytes >= MAX_BYTES) throw error
      }
    }
    const logs: CompactLog[] = []
    for (let part = Math.floor(from / spec.partSpan); part * spec.partSpan <= cut; part++) {
      const start = Math.max(from, part * spec.partSpan)
      const last = Math.min(to, part * spec.partSpan + spec.partSpan - 1)
      const end = Math.min(last, cut)
      const spent = budget.bytes
      const got = await unitLogs(rt, head, { url: cacheUrl(origin, spec.partKind, poolId, part), from: start, to: last }, end, async () => {
        try {
          return await rangeLogs(rt, budget, filter, start, end, spec.partBytes)
        } catch (error) {
          // A part that does not fit in an answer that had spent almost nothing fits in no answer; a part past its own
          // cap (or one the RPC refuses as too large, which a capped read does not split) is too large too.
          const capped = spec.partBytes !== undefined && error instanceof RelayError && (error.kind === 'bytes' || error.kind === 'range')
          if (capped || (error instanceof RelayError && error.kind === 'bytes' && spent < FRESH_BUDGET_BYTES)) throw new RelayError('fatal', 'part_too_large')
          throw error
        }
      })
      logs.push(...got.logs)
    }
    return logs
  })
}

/** One day of Swap and Donate logs up to `cut`: kept, or in one call, or (a busy day) hour by hour. */
function swapDay(rt: FeesRuntime, budget: Budget, origin: string, head: number, poolId: string, day: number, cut: number): Promise<KeptUnit> {
  const from = day * DAY_SPAN
  return partedLogs(rt, budget, origin, head, { kind: 'swaps', partKind: 'swapsHour', busyKind: 'swapsBusy', poolId, unit: day, from, to: from + DAY_SPAN - 1, partSpan: HOUR_SPAN, attemptBytes: DAY_ATTEMPT_BYTES, filter: poolFilter(poolId, SWAP_EVENTS) }, cut)
}

/** One pool epoch of Initialize, ModifyLiquidity and ProtocolFeeUpdated logs up to `cut`: kept, or in one call, or (a busy epoch) in tenths. */
function poolEpoch(rt: FeesRuntime, budget: Budget, origin: string, head: number, poolId: string, epoch: number, cut: number, parts = false): Promise<KeptUnit> {
  const from = epoch * EPOCH_SPAN
  return partedLogs(rt, budget, origin, head, { kind: 'pool', partKind: 'poolPart', busyKind: 'poolBusy', poolId, unit: epoch, from, to: from + EPOCH_SPAN - 1, partSpan: EPOCH_PART_SPAN, attemptBytes: EPOCH_ATTEMPT_BYTES, filter: poolFilter(poolId, POOL_EVENTS), ...(parts ? { partBytes: PART_REPLY_BYTES } : {}) }, cut)
}

/** Whether a failure only means this answer's calls, bytes or time are spent (the next answer goes further). */
const spent = (error: unknown) => error instanceof RelayError && (error.kind === 'calls' || error.kind === 'deadline' || error.kind === 'bytes') && error.message !== 'part_too_large'

/**
 * The last Swap strictly before `block`: windows ending at block − 1, 3,000 blocks first, ×4 each try, the last reaching
 * `since` (block 0 unless given). 2026-09-25: a replay names its pool's Initialize block as `since`, since no Swap is
 * older: for a pool with no Swap before the mint, the last window was a scan of the whole chain (2.2 s measured that
 * day, the kind of cold scan after which the RPC refuses the visitor's next reads).
 */
async function lastSwapBefore(rt: FeesRuntime, budget: Budget, poolId: string, block: number, since = 0): Promise<CompactLog | null> {
  const filter = poolFilter(poolId, [TOPIC.Swap])
  let hi = block - 1
  let span = BEFORE_FIRST_SPAN
  for (let attempt = 1; attempt <= BEFORE_TRIES && hi >= since; attempt++, span *= BEFORE_GROWTH) {
    const lo = attempt === BEFORE_TRIES ? since : Math.max(since, hi - span + 1)
    const logs = await rangeLogs(rt, budget, filter, lo, hi)
    if (logs.length > 0) return logs[logs.length - 1]
    hi = lo - 1
  }
  return null
}

/** Block timestamps, kept per block once final, else from one batched eth_getBlockByNumber. */
async function headerTimes(rt: FeesRuntime, budget: Budget, origin: string, head: number, blocks: number[]): Promise<Array<[number, number]>> {
  const known = new Map<number, number>()
  const missing: number[] = []
  for (const block of blocks) {
    const hit = await kept<{ t: number }>(rt, cacheUrl(origin, 'header', '0', block))
    if (hit && Number.isSafeInteger(hit.value.t)) known.set(block, hit.value.t)
    else missing.push(block)
  }
  if (missing.length > 0) {
    const reply = await paced(rt, budget, () => post(rt, budget, missing.map((block, id) => ({ jsonrpc: '2.0', id, method: 'eth_getBlockByNumber', params: [hex(block), false] })), false))
    if (!Array.isArray(reply) || reply.length !== missing.length) throw new RelayError('fatal', 'invalid_batch')
    for (const envelope of reply) {
      const id = (envelope as { id?: unknown } | null)?.id
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || id >= missing.length || known.has(missing[id])) throw new RelayError('fatal', 'invalid_batch')
      const header = resultOf(envelope)
      if (!header || typeof header !== 'object') throw new RelayError('fatal', 'missing_header')
      const block = missing[id]
      const { number, timestamp } = header as { number?: unknown; timestamp?: unknown }
      if (quantity(number) !== block) throw new RelayError('fatal', 'invalid_header')
      const t = quantity(timestamp)
      known.set(block, t)
      if (block <= head - SAFE_DEPTH) await keep(rt, cacheUrl(origin, 'header', '0', block), { t }, FINAL_SECONDS)
    }
  }
  return blocks.map((block): [number, number] => [block, known.get(block) as number])
}

const toUnit = (unit: number | null, logs: KeptUnit): LogsUnit => ({ unit, from: logs.from, to: logs.to, final: logs.final, logs: logs.logs })

/** The answer to one LogsRequest. */
async function readLogs(rt: FeesRuntime, budget: Budget, origin: string, asked: RelayRequest): Promise<LogsResponse> {
  const until = 'until' in asked && asked.until !== undefined ? asked.until : null
  // The last block the request names (2026-09-27): a head read at or past it serves (headBlock).
  const named = asked.kind === 'probe' ? asked.to : asked.kind === 'headers' ? Math.max(0, ...asked.blocks) : asked.kind === 'swapBefore' ? asked.block : (until ?? 0)
  const head = await headBlock(rt, budget, named)
  const behind: LogsResponse = { v: 1, kind: asked.kind, behind: true }
  if (until !== null && head < until) return behind
  const top = until === null ? head : until
  switch (asked.kind) {
    case 'transfer': {
      const filter: LogFilter = { address: POSITION_MANAGER, topic0: [TOPIC.Transfer], topic3: `0x${word(BigInt(asked.tokenId))}` }
      // From `since` when asked (2026-09-25: a replay looks for a mint only as far back as one that can still verify; the
      // whole chain was a scan of 72 million blocks, up to 1.2 s measured that day, after which the RPC refuses the
      // visitor's next reads), else from the first Transfer ever.
      // 2026-09-27: to `until` when asked (`top`), else to the head.
      const from = Math.min(top, Math.max(FIRST_TRANSFER_BLOCK, asked.since ?? 0))
      const spec = { url: cacheUrl(origin, 'transfer', asked.tokenId, asked.since === undefined ? 0 : from), from, to: Number.MAX_SAFE_INTEGER }
      const unit = await unitLogs(rt, head, spec, top, () => rangeLogs(rt, budget, filter, from, top))
      return { v: 1, kind: 'transfer', head, units: [toUnit(null, unit)], next: null }
    }
    case 'initialize': {
      const url = cacheUrl(origin, 'initialize', asked.poolId, 0)
      const hit = await kept<KeptUnit>(rt, url)
      if (hit?.value.final) return { v: 1, kind: 'initialize', head, units: [toUnit(null, hit.value)], next: null }
      // 2026-09-28 (owned.ts LOG_BLOCKS_ONE): the whole chain is more than one read may cover, and a pool is initialized
      // once: its windows are asked newest first, and the first that holds it is the last asked (live, the owner's
      // USDG/UFG pool: 2 reads, not the 8 windows of the whole chain, a burst the RPC refused the next call after).
      const logs = await shared(url, async () => {
        const filter = poolFilter(asked.poolId, [TOPIC.Initialize])
        for (let top = head; top >= 0; top -= LOG_BLOCKS_ONE) {
          const found = await rangeLogs(rt, budget, filter, Math.max(0, top - LOG_BLOCKS_ONE + 1), top)
          if (found.length > 0) return found
        }
        return []
      })
      // A pool is initialized once: found and final, the answer can no longer change.
      const final = logs.length > 0 && logs[0][0] <= head - SAFE_DEPTH
      const unit: KeptUnit = { from: 0, to: head, final, logs }
      await keep(rt, url, unit, final ? FINAL_SECONDS : SHORT_SECONDS)
      return { v: 1, kind: 'initialize', head, units: [toUnit(null, unit)], next: null }
    }
    case 'pool': {
      const from = asked.epoch * EPOCH_SPAN
      if (from > top) return behind
      const cut = Math.min(from + EPOCH_SPAN - 1, top)
      try {
        const unit = await poolEpoch(rt, budget, origin, head, asked.poolId, asked.epoch, cut, asked.parts === true)
        return { v: 1, kind: 'pool', head, units: [toUnit(asked.epoch, unit)], next: null }
      } catch (error) {
        // A busy epoch not finished within one answer: its complete parts are kept, and the next answer goes on.
        if (!spent(error)) throw error
        return { v: 1, kind: 'pool', head, units: [], next: asked.epoch }
      }
    }
    case 'swaps': {
      if (asked.day * DAY_SPAN > top) return behind
      const units: LogsUnit[] = []
      let bytes = 0
      let next: number | null = null
      for (let day = asked.day; day < asked.day + asked.count && day * DAY_SPAN <= top; day++) {
        let unit: KeptUnit
        try {
          unit = await swapDay(rt, budget, origin, head, asked.poolId, day, Math.min(day * DAY_SPAN + DAY_SPAN - 1, top))
        } catch (error) {
          // The answer's calls, bytes or time are spent: the complete days so far, and where to go on. The hours of an
          // incomplete day are kept one by one, so the next answer starts further in (an answer with no day at all
          // still makes that progress).
          if (!spent(error)) throw error
          next = day
          break
        }
        const size = logsBytes(unit.logs)
        if (units.length > 0 && bytes + size > MAX_ANSWER_BYTES) {
          next = day
          break
        }
        bytes += size
        units.push(toUnit(day, unit))
      }
      return { v: 1, kind: 'swaps', head, units, next }
    }
    case 'swapBefore': {
      if (asked.block > top) return behind
      const url = cacheUrl(origin, 'swapBefore', asked.poolId, asked.block)
      const hit = await kept<{ log: CompactLog | null; final: boolean }>(rt, url)
      if (hit && (hit.value.final || hit.ageMs < SHORT_SECONDS * 1000)) return { v: 1, kind: 'swapBefore', head, log: hit.value.log }
      const log = await shared(url, () => lastSwapBefore(rt, budget, asked.poolId, asked.block, asked.since))
      const final = asked.block <= head - SAFE_DEPTH
      await keep(rt, url, { log, final }, final ? FINAL_SECONDS : SHORT_SECONDS)
      return { v: 1, kind: 'swapBefore', head, log }
    }
    case 'probe': {
      if (asked.to > head) return behind
      let logs: CompactLog[]
      try {
        logs = await rangeLogs(rt, budget, poolFilter(asked.poolId, [...POOL_EVENTS, ...SWAP_EVENTS]), asked.from, asked.to, PROBE_BYTES)
      } catch (error) {
        // More than a probe may take, or more than the RPC answers in one reply: far more history than any budget.
        if (error instanceof RelayError && (error.kind === 'bytes' || error.kind === 'range')) throw new RelayError('fatal', 'part_too_large')
        throw error
      }
      return { v: 1, kind: 'probe', head, units: [{ unit: null, from: asked.from, to: asked.to, final: false, logs }], next: null }
    }
    case 'headers': {
      if (asked.blocks.some((block) => block > head)) return behind
      // The one block off the grid a client may name is its state block: recent, and never kept.
      if (asked.blocks.some((block) => block % HOUR_SPAN !== 0 && block < head - SAFE_DEPTH)) throw new Refused('off_grid_header')
      return { v: 1, kind: 'headers', head, headers: await headerTimes(rt, budget, origin, head, asked.blocks) }
    }
  }
}

/** POST /api/fees/v1/logs: one pool's or one NFT's logs, in fixed cached units. */
export async function answerLogs(request: Request, rt: FeesRuntime): Promise<Response> {
  const url = new URL(request.url)
  const body = await bodyOf(request, url, LOGS_BODY_BYTES)
  if (body instanceof Response) return body
  const asked = logsRequestOf(body)
  if (!asked) return bad()
  const failKey = cacheUrl(url.origin, 'fail', await sha256(JSON.stringify(asked)), 0)
  const recent = await kept<{ outcome: Outcome }>(rt, failKey)
  if (recent && recent.ageMs < FAILURE_SECONDS * 1000) return failure(recent.value.outcome, FAILURE_SECONDS * 1000 - recent.ageMs)
  const budget = newBudget(rt)
  try {
    return answer(JSON.stringify(await readLogs(rt, budget, url.origin, asked)), request)
  } catch (error) {
    if (error instanceof Refused) return bad()
    if (error instanceof RelayError && error.message === 'part_too_large') return refusal('too_large', 413)
    const outcome = outcomeOf(error)
    await keep(rt, failKey, { outcome }, FAILURE_SECONDS)
    return failure(outcome, budget.retryAfterMs)
  }
}

// ---------------------------------------------------------------------------
// The same reads, answered in process (the page and the replay worker, 2026-09-25)
// ---------------------------------------------------------------------------

/** A failed read as the page's client used to receive it from a route: the kind, and the wait the route's Retry-After named. */
export function failedRead(error: unknown, budget: Budget): RelayAnswer<never> {
  if (error instanceof Refused) return { ok: false, failure: 'bad_request', retryAfterMs: 0 }
  if (error instanceof RelayError && error.message === 'part_too_large') return { ok: false, failure: 'too_large', retryAfterMs: 0 }
  const retryAfterMs = Math.min(60, Math.ceil(Math.max(budget.retryAfterMs, FAILURE_SECONDS * 1000) / 1000)) * 1000
  return { ok: false, failure: outcomeOf(error) === 'rate_limited' ? 'rate_limited' : 'unavailable', retryAfterMs }
}

/**
 * POST /api/fees/v1/state's read without the route: the same id check, the
 * same three RPC calls at head − 2, as a RelayAnswer. `bytes` is the size of
 * the answer's JSON, as the route's reply measured it. `automation`: the page's
 * own (2026-09-28, speed wave B, item 17), each position's feature with it.
 */
export async function stateOnChain(rt: FeesRuntime, tokenIds: readonly string[], automation = false): Promise<RelayAnswer<StateResponse>> {
  const ids = stateIdsOf({ tokenIds: [...tokenIds] })
  if (!ids) return { ok: false, failure: 'bad_request', retryAfterMs: 0 }
  const budget = newBudget(rt)
  try {
    const value = await readState(rt, budget, ids, automation)
    return { ok: true, value, bytes: JSON.stringify(value).length }
  } catch (error) {
    return failedRead(error, budget)
  }
}

/**
 * POST /api/fees/v1/logs's read without the route: the same request check,
 * units, splits, caps and cache rules, with `rt.cache` the caller's own (the
 * worker's memory) and `origin` only the prefix of its keys.
 */
export async function logsOnChain(rt: FeesRuntime, origin: string, request: LogsRequest): Promise<RelayAnswer<LogsResponse>> {
  const asked = logsRequestOf({ ...request })
  if (!asked) return { ok: false, failure: 'bad_request', retryAfterMs: 0 }
  const budget = newBudget(rt)
  try {
    const value = await readLogs(rt, budget, origin, asked)
    return { ok: true, value, bytes: JSON.stringify(value).length }
  } catch (error) {
    return failedRead(error, budget)
  }
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
