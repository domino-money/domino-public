/**
 * The chain helpers behind the site's own reads of Robinhood Chain: the
 * wallet's Domino positions (functions/_lib/walletPositions.ts) and the fees
 * relay (functions/_lib/fees.ts). Since 2026-09-25 the page itself imports
 * them and asks the public RPC from the browser (src/lib/chain/browser.ts):
 * the RPC answers 429 to every call from Cloudflare's shared egress, so the
 * same-origin routes (POST /api/owned/v2/positions, /api/fees/v1/*) failed
 * in production. The routes stay, tested, and nothing on the page asks them.
 * Nothing here may name the DOM, a build flag or a Workers-only API at module
 * level: the same file runs in a Pages Function, a page and a Web Worker.
 *
 * Here: the pins, the hand-written ABI encoding of Multicall3's aggregate3 and
 * its results, Keccak-256, the bounded RPC call (a cap on calls, bytes and
 * time; a 429 waited out with a growing pause), the strict same-origin
 * {"owner"} request, and the per-owner answer cache (an answer kept 30
 * seconds, 5 for a fresh question, a failure 12), so a loop of questions is
 * not a loop of scans.
 *
 * What this is not: a general RPC proxy. The endpoint, every method, contract,
 * topic, block range and calldata are fixed by the routes that use it. No
 * secret is involved: the RPC is the chain's public one, and every answer is
 * public chain data about a public address, which is why the owner travels in
 * a POST body, never in a URL.
 *
 * The ABI encoding is written by hand (a Function carries no viem), and
 * tests/owned.test.mjs checks every selector, encoding and the Keccak below
 * against viem.
 */

export const RPC_URL = 'https://rpc.mainnet.chain.robinhood.com'
export const CHAIN_ID = 4663
/** Uniswap v4 PositionManager on Robinhood Chain; the same pin as app/src/finance/pin.ts. */
export const POSITION_MANAGER = '0x58daec3116aae6d93017baaea7749052e8a04fa7'
/** DominoSetupV1; the same pin as app/src/finance/pin.ts SETUP_CONTRACT. */
export const SETUP_CONTRACT = '0x676f449fcfcd0f5ce4c7a1db2d98c7d6565dd37a'
/** Multicall3 at its canonical address, deployed on Robinhood Chain. */
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
/** The block of the PositionManager's first Transfer (the mint of NFT 1): nothing before it can name an NFT. */
export const FIRST_TRANSFER_BLOCK = 9506
/** keccak256('Transfer(address,address,uint256)'). */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/**
 * The block DominoSetupV1 was deployed in (transaction 0xa5e96b18…a21a8, read
 * from chain on 2026-09-24: its receipt names this contract at this block, and
 * docs/deployments/v1-robinhood-mainnet-2026-09-21 records the same): no
 * SetupMinted can be older.
 */
export const SETUP_DEPLOY_BLOCK = 69_249_061
/** keccak256('SetupMinted(bytes32,address,uint256,uint128,uint128,uint128)'): contracts/src/DominoSetup.sol, owner indexed as topic 2. */
export const SETUP_MINTED_TOPIC = '0xbe9f53385653b534d15ec3cb50f69cebc58346b3279852d27cab1dce0dfd3d9f'
/** The most RPC calls one answer may cost, retries and splits included. */
export const MAX_RPC_CALLS = 48
/**
 * The most log bytes one answer reads, over all its eth_getLogs replies. A
 * SetupMinted log is under 1 kB as this RPC sends it, and the RPC refuses a
 * query matching more than 10,000 logs, so one full reply fits. No range is
 * asked once this is read, and a reply that would pass it is not read to its
 * end: the walk stops there, with the newer ids it has.
 */
export const MAX_LOG_BYTES = 8 * 1024 * 1024
/** The most bytes any other reply may have (an aggregate3 of 150 sub-calls is well under 100 kB). */
export const MAX_REPLY_BYTES = 1024 * 1024
/** How many times a rate-limited call is asked, and the wait before each repeat (× attempt). */
export const RATE_ATTEMPTS = 4
export const BACKOFF_MS = 1500
/** A log range is not split below this many blocks. */
export const MIN_SPLIT_BLOCKS = 2000
/**
 * The owner's most recent setup operations that are read, for the deposits still held in them. Changed on purpose
 * (2026-09-25, audit of 754014c): it was 8, and a deposit older than the owner's last 8 operations was left out with
 * nothing to say so, its Refund to wallet gone while the funds stayed in DominoSetupV1. Every operation is read now, up
 * to this many (two sub-calls each, batched into the Multicall3 reads the scan already makes).
 */
export const RECENT_OPERATIONS = 128
const CALL_TIMEOUT_MS = 10_000
const DEADLINE_MS = 25_000
/** How long an answer is kept per owner. */
export const CACHE_SECONDS = 30
/** How long a chain_busy or chain_unavailable is kept per owner, for every question, fresh or not. */
export const FAILURE_SECONDS = 12
/** A fresh question gets the kept answer while it is younger than this, rather than a new scan. */
export const FRESH_AFTER_MS = 5_000
const MAX_BODY_BYTES = 512

/** Function selectors, each checked against viem in tests/owned.test.mjs. */
export const SELECTOR = {
  ownerOf: '6352211e',
  getPositionLiquidity: '1efeed33',
  getPoolAndPositionInfo: '7ba03aad',
  aggregate3: '82ad56cb',
  ownerNonce: 'e8ad29b4',
  operation: '47da73be',
  recoveryStarted: '20698983',
} as const

/**
 * AbortSignal.timeout(ms), or the same signal made by hand where the runtime
 * has no AbortSignal.timeout (Safari before 16): since 2026-09-25 the page
 * runs this file too, and there every call would otherwise throw at once and
 * the list would never be read.
 */
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
  const controller = new AbortController()
  setTimeout(() => controller.abort(new DOMException('The call took too long', 'TimeoutError')), ms)
  return controller.signal
}

/** What the scan needs from the runtime; tests hand in fakes. */
export interface OwnedDeps {
  fetch: (input: string, init: RequestInit) => Promise<Response>
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** True once nobody wants the answer any more (the page left): no further call is made. Optional; a Function has none. */
  cancelled?: () => boolean
}

/** Wait and ask again; split the range; stop; or (logs only) the answer's log bytes are used up. */
type Failure = 'rate' | 'range' | 'fatal' | 'bytes'

export class ChainError extends Error {
  constructor(
    readonly kind: Failure,
    message: string,
  ) {
    super(message)
  }
}

const RATE_WORDS = /rate.?limit|too many requests|throttl/i
const RANGE_WORDS = /exceed|more than \d+|block range|range (?:is )?too (?:large|wide|big)|too many (?:logs|results)|query returned more|timed? ?out|timeout/i
const BUSY_WORDS = /\brate\b|capacity|busy/i

/**
 * What an RPC error means for the scan: wait and ask again, split the range,
 * or stop. Words decide before codes: -32005 means a rate limit at one
 * provider and "more than 10000 results" at another.
 */
export function classifyRpcError(code: unknown, message: string): Failure {
  if (RATE_WORDS.test(message)) return 'rate'
  if (RANGE_WORDS.test(message)) return 'range'
  if (code === 429 || code === -32005 || BUSY_WORDS.test(message)) return 'rate'
  return 'fatal'
}

// ---------------------------------------------------------------------------
// Hex and ABI, by hand
// ---------------------------------------------------------------------------

export const hex = (n: number | bigint) => `0x${n.toString(16)}`
/** A uint256 (or a negative int, two's complement) as one ABI word. */
export const word = (n: bigint) => BigInt.asUintN(256, n).toString(16).padStart(64, '0')
export const addressWord = (address: string) => address.slice(2).toLowerCase().padStart(64, '0')

/** One aggregate3 call: its target and its calldata without 0x. */
export interface SubCall {
  target: string
  data: string
}

/** aggregate3((address target, bool allowFailure, bytes callData)[]) calldata, every call allowed to fail. */
export function encodeAggregate3(calls: readonly SubCall[]): string {
  const tuples = calls.map(({ target, data }) => {
    const padded = data.padEnd(Math.ceil(data.length / 64) * 64, '0')
    return addressWord(target) + word(1n) + word(0x60n) + word(BigInt(data.length / 2)) + padded
  })
  let offset = BigInt(calls.length * 32)
  const offsets: string[] = []
  for (const tuple of tuples) {
    offsets.push(word(offset))
    offset += BigInt(tuple.length / 2)
  }
  return `0x${SELECTOR.aggregate3}${word(0x20n)}${word(BigInt(calls.length))}${offsets.join('')}${tuples.join('')}`
}

/** A bounds-checked reader over ABI-encoded return data. */
export function reader(data: string) {
  const body = data.startsWith('0x') ? data.slice(2) : data
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(body)) throw new ChainError('fatal', 'invalid_return_data')
  const bytes = body.length / 2
  const at = (byte: bigint | number): bigint => {
    const start = Number(byte)
    if (!Number.isSafeInteger(start) || start < 0 || start + 32 > bytes) throw new ChainError('fatal', 'invalid_return_data')
    return BigInt(`0x${body.slice(start * 2, start * 2 + 64)}`)
  }
  const slice = (byte: bigint | number, length: bigint | number): string => {
    const start = Number(byte)
    const size = Number(length)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || size < 0 || start + size > bytes) throw new ChainError('fatal', 'invalid_return_data')
    return body.slice(start * 2, (start + size) * 2)
  }
  return { at, slice, bytes }
}

/** aggregate3's (bool success, bytes returnData)[], as returned. */
export function decodeAggregate3(data: string): { success: boolean; data: string }[] {
  const r = reader(data)
  const base = r.at(0) // offset of the array
  const count = r.at(base)
  if (count > 10_000n) throw new ChainError('fatal', 'invalid_return_data')
  const head = base + 32n
  const out: { success: boolean; data: string }[] = []
  for (let i = 0n; i < count; i++) {
    const tuple = head + r.at(head + 32n * i)
    const flag = r.at(tuple)
    if (flag > 1n) throw new ChainError('fatal', 'invalid_return_data')
    const at = tuple + r.at(tuple + 32n)
    out.push({ success: flag === 1n, data: r.slice(at + 32n, r.at(at)) })
  }
  return out
}

/** A 32-byte word as an address, refusing anything with bits above 160. */
export function asAddress(value: bigint): string {
  if (value >> 160n !== 0n) throw new ChainError('fatal', 'invalid_return_data')
  return `0x${value.toString(16).padStart(40, '0')}`
}

/** int24 from its two's-complement word. */
export function asInt24(value: bigint): number {
  const signed = value >> 255n === 1n ? value - (1n << 256n) : value
  if (signed < -(1n << 23n) || signed >= 1n << 23n) throw new ChainError('fatal', 'invalid_return_data')
  return Number(signed)
}

/** DominoSetupV1.operation(id): the Operation struct, a static tuple of 11 words. */
export function decodeOperation(data: string) {
  const r = reader(data)
  if (r.bytes < 11 * 32) throw new ChainError('fatal', 'invalid_return_data')
  const w = (i: number) => r.at(i * 32)
  const fee = w(3)
  const bounded = (value: bigint, bits: bigint) => {
    if (value >> bits !== 0n) throw new ChainError('fatal', 'invalid_return_data')
    return value
  }
  return {
    owner: asAddress(w(0)),
    currency0: asAddress(w(1)),
    currency1: asAddress(w(2)),
    fee: Number(bounded(fee, 24n)),
    tickSpacing: asInt24(w(4)),
    hooks: asAddress(w(5)),
    balance0: bounded(w(6), 128n),
    balance1: bounded(w(7), 128n),
    swapped: bounded(w(8), 1n) === 1n,
    closed: bounded(w(9), 1n) === 1n,
    tokenId: w(10),
  }
}

// ---------------------------------------------------------------------------
// Keccak-256 (the original Keccak padding, as Solidity's keccak256), on 64-bit lanes
// ---------------------------------------------------------------------------

const MASK64 = (1n << 64n) - 1n
const ROUND_CONSTANTS = [
  '0000000000000001', '0000000000008082', '800000000000808a', '8000000080008000', '000000000000808b', '0000000080000001',
  '8000000080008081', '8000000000008009', '000000000000008a', '0000000000000088', '0000000080008009', '000000008000000a',
  '000000008000808b', '800000000000008b', '8000000000008089', '8000000000008003', '8000000000008002', '8000000000000080',
  '000000000000800a', '800000008000000a', '8000000080008081', '8000000000008080', '0000000080000001', '8000000080008008',
].map((value) => BigInt(`0x${value}`))
const ROTATIONS = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44].map(BigInt)
const LANES = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1]

const rotl = (x: bigint, n: bigint) => ((x << n) | (x >> (64n - n))) & MASK64

function permute(state: bigint[]) {
  const c: bigint[] = [0n, 0n, 0n, 0n, 0n]
  for (const constant of ROUND_CONSTANTS) {
    for (let x = 0; x < 5; x++) c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20]
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1n)
      for (let y = 0; y < 25; y += 5) state[y + x] ^= d
    }
    let carried = state[1]
    for (let i = 0; i < 24; i++) {
      const lane = LANES[i]
      const next = state[lane]
      state[lane] = rotl(carried, ROTATIONS[i])
      carried = next
    }
    for (let y = 0; y < 25; y += 5) {
      const row = state.slice(y, y + 5)
      for (let x = 0; x < 5; x++) state[y + x] = row[x] ^ (~row[(x + 1) % 5] & MASK64 & row[(x + 2) % 5])
    }
    state[0] ^= constant
  }
}

/** keccak256 of the bytes `data` (hex, with or without 0x), as 0x-prefixed lowercase hex. */
export function keccak256(data: string): string {
  const body = data.startsWith('0x') ? data.slice(2) : data
  const bytes: number[] = []
  for (let i = 0; i < body.length; i += 2) bytes.push(Number.parseInt(body.slice(i, i + 2), 16))
  const rate = 136
  bytes.push(0x01)
  while (bytes.length % rate !== 0) bytes.push(0)
  bytes[bytes.length - 1] |= 0x80
  const state: bigint[] = Array.from({ length: 25 }, () => 0n)
  for (let block = 0; block < bytes.length; block += rate) {
    for (let lane = 0; lane < rate / 8; lane++) {
      let value = 0n
      for (let b = 7; b >= 0; b--) value = (value << 8n) | BigInt(bytes[block + lane * 8 + b])
      state[lane] ^= value
    }
    permute(state)
  }
  let out = ''
  for (let lane = 0; lane < 4; lane++) {
    for (let b = 0; b < 8; b++) out += Number((state[lane] >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, '0')
  }
  return `0x${out}`
}

/** A setup operation's id: keccak256(abi.encode(uint256 4663, address setup, address owner, uint64 nonce)). */
export const operationId = (owner: string, nonce: bigint) =>
  keccak256(word(BigInt(CHAIN_ID)) + addressWord(SETUP_CONTRACT) + addressWord(owner) + word(nonce))

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/** What one answer has spent: RPC calls, and bytes of eth_getLogs replies. */
export interface Budget {
  calls: number
  started: number
  logBytes: number
}

/**
 * A reply's body as text, read no further than `limit` bytes: null past it.
 * The RPC sends its replies chunked, with no length, so the size is known
 * only by reading.
 */
async function bodyWithin(response: Response, limit: number): Promise<{ text: string | null; bytes: number }> {
  if (!response.body) return { text: '', bytes: 0 }
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > limit) {
      await reader.cancel().catch(() => undefined)
      return { text: null, bytes }
    }
    parts.push(value)
  }
  const joined = new Uint8Array(bytes)
  let at = 0
  for (const part of parts) {
    joined.set(part, at)
    at += part.byteLength
  }
  return { text: new TextDecoder().decode(joined), bytes }
}

async function rpc(deps: OwnedDeps, budget: Budget, method: string, params: unknown[]): Promise<unknown> {
  if (deps.cancelled?.()) throw new ChainError('fatal', 'cancelled')
  budget.calls += 1
  if (budget.calls > MAX_RPC_CALLS) throw new ChainError('fatal', 'rpc_call_cap')
  if (deps.now() - budget.started > DEADLINE_MS) throw new ChainError('fatal', 'deadline')
  const logs = method === 'eth_getLogs'
  // A call that took too long is, for a log range, a range too large; any other call stops the scan.
  const slow = (error: unknown) => {
    const name = error instanceof Error ? error.name : ''
    return name === 'TimeoutError' || name === 'AbortError' ? new ChainError(logs ? 'range' : 'fatal', 'rpc_timeout') : null
  }
  let response: Response
  try {
    response = await deps.fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: budget.calls, method, params }),
      signal: timeoutSignal(CALL_TIMEOUT_MS),
    })
  } catch (error) {
    throw slow(error) ?? new ChainError('fatal', 'rpc_unreachable')
  }
  if (response.status === 429 || response.status === 503) throw new ChainError('rate', `http_${response.status}`)
  if (!response.ok) throw new ChainError('fatal', `http_${response.status}`)
  let read: { text: string | null; bytes: number }
  try {
    read = await bodyWithin(response, logs ? MAX_LOG_BYTES - budget.logBytes : MAX_REPLY_BYTES)
  } catch (error) {
    throw slow(error) ?? new ChainError('fatal', 'rpc_read_failed')
  }
  if (logs) budget.logBytes += read.bytes
  if (read.text === null) throw logs ? new ChainError('bytes', 'log_byte_cap') : new ChainError('fatal', 'reply_too_large')
  let body: unknown
  try {
    body = JSON.parse(read.text)
  } catch {
    throw new ChainError('fatal', 'rpc_invalid_json')
  }
  if (!body || typeof body !== 'object') throw new ChainError('fatal', 'rpc_invalid_envelope')
  const envelope = body as { result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } }
  if (envelope.error) {
    const inner = envelope.error.data && typeof envelope.error.data === 'object' ? (envelope.error.data as { message?: unknown }).message : undefined
    const message = [envelope.error.message, inner].filter((part): part is string => typeof part === 'string').join(' ')
    throw new ChainError(classifyRpcError(envelope.error.code, message), message.slice(0, 120) || 'rpc_error')
  }
  if (!('result' in envelope)) throw new ChainError('fatal', 'rpc_missing_result')
  return envelope.result
}

/** A call asked again after a growing wait while the RPC says it is rate limited. */
export async function paced(deps: OwnedDeps, budget: Budget, method: string, params: unknown[]): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rpc(deps, budget, method, params)
    } catch (error) {
      if (!(error instanceof ChainError) || error.kind !== 'rate' || attempt >= RATE_ATTEMPTS) throw error
      await deps.sleep(BACKOFF_MS * attempt)
    }
  }
}

const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i
export const HASH = /^0x[0-9a-f]{64}$/i

export function quantity(value: unknown): number {
  if (typeof value !== 'string' || !QUANTITY.test(value)) throw new ChainError('fatal', 'invalid_quantity')
  const n = Number(BigInt(value))
  if (!Number.isSafeInteger(n)) throw new ChainError('fatal', 'invalid_quantity')
  return n
}

/** One Multicall3 aggregate3 eth_call at `block`, every sub-call allowed to fail; its results, one per call. */
export async function aggregate(deps: OwnedDeps, budget: Budget, calls: SubCall[], block: number) {
  const result = await paced(deps, budget, 'eth_call', [{ to: MULTICALL3, data: encodeAggregate3(calls) }, hex(block)])
  if (typeof result !== 'string') throw new ChainError('fatal', 'invalid_call_result')
  const decoded = decodeAggregate3(result)
  if (decoded.length !== calls.length) throw new ChainError('fatal', 'invalid_call_result')
  return decoded
}

/** A 32-byte result word, or null for a failed or short sub-call. */
export const resultWord = (call: { success: boolean; data: string }): bigint | null => (call.success && call.data.length >= 64 ? BigInt(`0x${call.data.slice(0, 64)}`) : null)

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/** The part of the Workers cache this route uses; caches.default in production, absent in tests. */
export interface AnswerCache {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
/** Present, as "true", on an answer whose log walk stopped early (the scan's `capped`). */
export const CAPPED = 'X-Owned-Capped'

export const refuse = (error: string, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error }), { status, headers: { ...JSON_HEADERS, ...headers } })

const OWNER = /^0x[0-9a-fA-F]{40}$/
/** Every burn is a Transfer to it, and no wallet holds anything there: never scanned. */
const ZERO_OWNER = /^0x0{40}$/

/**
 * The owner from a POST body of exactly {"owner": "0x…"}, lowercase, or the
 * refusal. {"owner": "0x…", "fresh": true} is the same question asked right
 * after the page changed the answer (a refund, a close): it skips a kept
 * answer older than FRESH_AFTER_MS and replaces it, but never a kept failure.
 */
export async function ownerFrom(request: Request, url: URL): Promise<{ owner: string; fresh: boolean } | Response> {
  if (request.method !== 'POST') return refuse('method_not_allowed', 405, { Allow: 'POST' })
  const origin = request.headers.get('Origin')
  const site = request.headers.get('Sec-Fetch-Site')
  if ((origin !== null && origin !== url.origin) || (site !== null && site !== 'same-origin')) return refuse('origin_not_allowed', 403)
  if (!(request.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json')) return refuse('json_required', 415)
  if (Number(request.headers.get('Content-Length') ?? '0') > MAX_BODY_BYTES) return refuse('request_too_large', 413)
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) return refuse('request_too_large', 413)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return refuse('invalid_request', 400)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse('invalid_request', 400)
  const keys = Object.keys(body).sort().join()
  const { owner, fresh } = body as { owner?: unknown; fresh?: unknown }
  if ((keys !== 'owner' && keys !== 'fresh,owner') || (keys === 'fresh,owner' && fresh !== true)) return refuse('invalid_request', 400)
  if (typeof owner !== 'string' || !OWNER.test(owner) || ZERO_OWNER.test(owner)) return refuse('invalid_owner', 400)
  return { owner: owner.toLowerCase(), fresh: fresh === true }
}

/**
 * The cache key for an owner under a route's `version` ('v2'): a digest of the address, so the address itself is never
 * part of a URL, even an internal one.
 */
async function cacheKey(url: URL, version: string, owner: string): Promise<Request> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`owned/${version}|${owner}`)))
  const name = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
  return new Request(`${url.origin}/api/owned/${version}/cache/${name}`)
}

/** What one scan came to: its answer, or the code of its failure. */
type Outcome = 'answer' | 'chain_busy' | 'chain_unavailable'

/** On a kept entry: when it was stored (ms since the epoch), and its Outcome. */
const STORED_AT = 'X-Owned-Stored-At'
const OUTCOME = 'X-Owned-Outcome'

const failed = (code: Outcome, leftMs: number) => refuse(code, 502, { 'Retry-After': String(Math.max(1, Math.ceil(leftMs / 1000))) })
const cappedHeader = (capped: boolean): Record<string, string> => (capped ? { [CAPPED]: 'true' } : {})

/**
 * What a kept entry answers at `now`, or null when it is too old for this
 * question (or was not stored with these headers). The cache's own max-age
 * drops it too; the age is checked here so the rule does not depend on it.
 */
function fromKept(kept: Response, now: number, fresh: boolean): Response | null {
  const at = Number(kept.headers.get(STORED_AT))
  const outcome = kept.headers.get(OUTCOME)
  if (!Number.isSafeInteger(at)) return null
  const age = Math.max(0, now - at)
  if (outcome === 'chain_busy' || outcome === 'chain_unavailable') {
    const left = FAILURE_SECONDS * 1000 - age
    return left > 0 ? failed(outcome, left) : null
  }
  if (outcome !== 'answer' || age >= CACHE_SECONDS * 1000 || (fresh && age >= FRESH_AFTER_MS)) return null
  return new Response(kept.body, { status: 200, headers: { ...JSON_HEADERS, ...cappedHeader(kept.headers.get(CAPPED) === 'true') } })
}

/** One scan's answer for an owner: the JSON body, and whether its log walk stopped early (sent as X-Owned-Capped). */
export interface OwnerScan {
  body: unknown
  capped: boolean
}

/**
 * A POST of {"owner": "0x…"} answered by `scan`, as JSON. A chain that cannot
 * be read fully is a 502, never a partial list presented as the whole. Per
 * owner, under a digest and the route's `version`, the last outcome is kept:
 * an answer for CACHE_SECONDS (a fresh question takes it only within
 * FRESH_AFTER_MS), a failure for FAILURE_SECONDS whatever the question, so
 * asking in a loop cannot make every question a scan of the public RPC.
 */
export async function answerOwner(
  request: Request,
  deps: OwnedDeps,
  version: string,
  scan: (deps: OwnedDeps, owner: string) => Promise<OwnerScan>,
  cache: AnswerCache | null = null,
  waitUntil?: (work: Promise<unknown>) => void,
): Promise<Response> {
  const url = new URL(request.url)
  const asked = await ownerFrom(request, url)
  if (asked instanceof Response) return asked
  const { owner, fresh } = asked
  const key = cache ? await cacheKey(url, version, owner) : null
  if (cache && key) {
    const kept = await cache.match(key).catch(() => undefined)
    const answered = kept ? fromKept(kept, deps.now(), fresh) : null
    if (answered) return answered
  }
  let outcome: Outcome = 'answer'
  let text = ''
  let capped = false
  try {
    const scanned = await scan(deps, owner)
    text = JSON.stringify(scanned.body)
    capped = scanned.capped
  } catch (error) {
    outcome = error instanceof ChainError && error.kind === 'rate' ? 'chain_busy' : 'chain_unavailable'
  }
  if (cache && key) {
    const seconds = outcome === 'answer' ? CACHE_SECONDS : FAILURE_SECONDS
    const entry = new Response(outcome === 'answer' ? text : JSON.stringify({ error: outcome }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${seconds}`, [STORED_AT]: String(deps.now()), [OUTCOME]: outcome, ...cappedHeader(capped) },
    })
    const stored = cache.put(key, entry).catch(() => undefined)
    if (waitUntil) waitUntil(stored)
    else await stored
  }
  return outcome === 'answer' ? new Response(text, { status: 200, headers: { ...JSON_HEADERS, ...cappedHeader(capped) } }) : failed(outcome, FAILURE_SECONDS * 1000)
}
