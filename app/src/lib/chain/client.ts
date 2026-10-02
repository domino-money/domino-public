/**
 * A chain's public RPC, asked from the browser, for any chain of the registry (2026-10-01, the chain2 workstream, audit
 * item G4).
 *
 * Why: the page's router to Robinhood Chain (lib/chain/browser.ts and failover.ts, retired 2026-10-01) fixed that chain's
 * RPC URL, chain id, pace and log limits. The second chain (Elysium Testnet, 99801) is read from the browser (its RPC
 * allows CORS from any origin), so this module takes all of that from the chain's record (config/chains.ts): the
 * endpoint and its budget, the chain id it must say it is, the log window, whether a toBlock past the head is refused,
 * the batch size, whether the provider counts every item of a batch, and the rest after a refusal. Since 2026-10-01
 * (RPC-SPEC, the owner's rule: nothing is read from a public RPC) Robinhood Chain is read at the edge only, so the
 * Elysium section is this module's one user.
 *
 * What it guarantees:
 * - It reaches only the chain's own RPC URLs, with no credentials and no referrer, and nothing is kept in storage.
 * - Before its first call it asks eth_chainId once, and refuses every call (`wrong_chain`) when the endpoint is another
 *   chain. A failed check is asked again at the next call, never trusted.
 * - Paced: at least `gapMs` between requests, at most `perMinute / 60` calls a second (every item of a batch counted
 *   where the provider counts them) and `inFlight` requests at once; batches of at most `batchMax` calls.
 * - A refusal for rate (HTTP 429 or 503, -32017, -32005, the words of a rate limit, a whole reply or one item of a batch)
 *   rests the whole client `firstRestMs`, doubled at each refusal in a row up to `maxRestMs`; the refused calls are
 *   asked again after it, at most RATE_ATTEMPTS times. No call is ever sent twice otherwise.
 * - Every reply is read within a byte cap and checked as JSON-RPC: one envelope per call, ids matched, no extra result.
 * - Logs are read window by window (`logs.window` blocks), clamped to the head, a window the RPC finds too large split
 *   in two down to MIN_LOG_WINDOW, and a read past MAX_LOGS logs refused rather than cut short.
 *
 * Node-safe and pure: the network call, the clock and the pause are handed in (tests/chain-client.test.mjs).
 */
import type { ChainConfig } from '../../config/chainKit'

/*
 * Three helpers copied from functions/_lib/owned.ts (classifyRpcError's words, bodyWithin, timeoutSignal), held equal to
 * them by tests/chain-client.test.mjs: owned.ts lives in Robinhood Chain's lazy chunk, and importing it here would make
 * the bundler split it out of that chunk for the second chain's section. Part B may move owned.ts onto these instead.
 */
const RATE_WORDS = /rate.?limit|too many requests|throttl/i
const RANGE_WORDS = /exceed|more than \d+|block range|range (?:is )?too (?:large|wide|big)|too many (?:logs|results)|query returned more/i
const BUSY_WORDS = /\brate\b|capacity|busy/i
/** A time-out stops; it is never a range to split (owned.ts, changed on purpose 2026-10-02: rugged97's rule 7). */
const TIMEOUT_WORDS = /timed? ?out|timeout/i

/** What an RPC error means: wait and ask again, split the range, or stop. Words decide before codes (owned.ts). */
export function classifyRpcError(code: unknown, message: string): 'rate' | 'range' | 'fatal' {
  if (RATE_WORDS.test(message)) return 'rate'
  if (code === -32002 || TIMEOUT_WORDS.test(message)) return 'fatal'
  if (RANGE_WORDS.test(message)) return 'range'
  if (code === 429 || code === -32005 || BUSY_WORDS.test(message)) return 'rate'
  return 'fatal'
}

/** A reply's body as text, read no further than `limit` bytes: null past it (owned.ts bodyWithin). */
export async function bodyWithin(message: Request | Response, limit: number): Promise<{ text: string | null; bytes: number }> {
  if (!message.body) {
    const text = await message.text()
    return { text: text.length > limit ? null : text, bytes: text.length }
  }
  const reader = message.body.getReader()
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

/** AbortSignal.timeout(ms), or the same signal made by hand where the runtime has none (owned.ts timeoutSignal). */
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
  const controller = new AbortController()
  setTimeout(() => controller.abort(new DOMException('The call took too long', 'TimeoutError')), ms)
  return controller.signal
}

/** What the client takes from its context: its one network call, its clock and its pause. */
export interface ClientRuntime {
  send(url: string, init: RequestInit): Promise<Response>
  now(): number
  pause(ms: number, signal?: AbortSignal): Promise<void>
}

export type RpcFailure =
  /** The provider's rate limit, still refused after the client's rests. */
  | 'rate'
  /** A log range the provider will not serve, even split down. */
  | 'range'
  /** The call reverted: its own answer, for the caller. */
  | 'revert'
  /** Any other JSON-RPC error. */
  | 'refused'
  /** No answer: the network, a timeout, a gateway's page. */
  | 'unreachable'
  /** An answer that is not what was asked: bad JSON, a missing or extra envelope, a reply past its byte cap. */
  | 'invalid'
  /** The endpoint is not this chain. */
  | 'wrong_chain'
  /** Nobody wants the answer any more. */
  | 'aborted'

export class RpcError extends Error {
  constructor(
    readonly kind: RpcFailure,
    message: string,
    readonly code?: unknown,
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

export interface RpcCall {
  method: string
  params: readonly unknown[]
}

export type RpcOutcome = { ok: true; result: unknown } | { ok: false; error: RpcError }

export interface RawLog {
  address: string
  topics: string[]
  data: string
  blockNumber: number
  blockHash: string
  transactionHash: string
  transactionIndex: number
  logIndex: number
}

export interface LogFilter {
  address: string | readonly string[]
  topics: ReadonlyArray<string | readonly string[] | null>
}

export interface Head {
  number: number
  timestamp: number
  hash: string
}

export interface ChainClient {
  readonly chain: ChainConfig
  /** One call: its result, or an RpcError. */
  call(method: string, params: readonly unknown[], signal?: AbortSignal): Promise<unknown>
  /** Several calls, sent in batches of the chain's size; one outcome per call, in order. */
  batch(calls: readonly RpcCall[], signal?: AbortSignal): Promise<RpcOutcome[]>
  /** The head block: its number, time and hash. */
  head(signal?: AbortSignal): Promise<Head>
  /** Every log of `filter` in [from, to] (to: 'latest' is the head), oldest first. */
  logs(filter: LogFilter, from: number, to: number | 'latest', signal?: AbortSignal): Promise<RawLog[]>
  /** How long before the client asks anything again (0: at once). */
  resting(): number
  /** For tests: what the client spent and knows. */
  state(): { requests: number; calls: number; rests: number; trusted: boolean }
}

/** How many times a refused call is asked, rests between included. */
export const RATE_ATTEMPTS = 3
/** One request's own deadline. */
export const CALL_TIMEOUT_MS = 10_000
/** The most bytes one reply may have: logs, and anything else. */
export const MAX_LOG_REPLY_BYTES = 4 * 1024 * 1024
export const MAX_REPLY_BYTES = 1024 * 1024
/** A log window is not split below this many blocks. */
export const MIN_LOG_WINDOW = 1_000
/** The most logs one read takes: past it, the read is refused rather than cut short. */
export const MAX_LOGS = 20_000

const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i
const HEX = /^0x(?:[0-9a-f]{2})*$/i
const ADDRESS = /^0x[0-9a-f]{40}$/i
const WORD = /^0x[0-9a-f]{64}$/i
const RATE_CODES = new Set<unknown>([429, -32017])
const REVERT = /revert/i

const hex = (n: number) => `0x${n.toString(16)}`

function quantity(value: unknown, what: string): number {
  if (typeof value !== 'string' || !QUANTITY.test(value)) throw new RpcError('invalid', `invalid_${what}`)
  const n = Number(BigInt(value))
  if (!Number.isSafeInteger(n)) throw new RpcError('invalid', `invalid_${what}`)
  return n
}

/**
 * A JSON-RPC error object as an RpcError: its rate, a range, a revert or a refusal. A code that only ever means a rate
 * limit (429, Conduit's -32017) decides at once; otherwise the words decide before the code, as functions/_lib/owned.ts
 * classifyRpcError reads them (-32005 is a rate limit at one provider and "more than 10000 results" at another).
 */
function errorOf(raw: unknown): RpcError {
  const error = (raw ?? {}) as { code?: unknown; message?: unknown; data?: unknown }
  const inner = error.data && typeof error.data === 'object' ? (error.data as { message?: unknown }).message : undefined
  const message = [error.message, inner].filter((part): part is string => typeof part === 'string').join(' ').slice(0, 200)
  if (RATE_CODES.has(error.code)) return new RpcError('rate', message || 'rate_limited', error.code)
  if (REVERT.test(message) || error.code === 3) return new RpcError('revert', message || 'execution_reverted', error.code)
  const kind = classifyRpcError(error.code, message)
  return new RpcError(kind === 'rate' ? 'rate' : kind === 'range' ? 'range' : 'refused', message || 'rpc_error', error.code)
}

/** A signal that aborts when either does; `drop()` lets go of both. */
function joined(a: AbortSignal | undefined, b: AbortSignal): { signal: AbortSignal; drop: () => void } {
  if (!a) return { signal: b, drop: () => undefined }
  const controller = new AbortController()
  const abort = () => controller.abort(a.aborted ? a.reason : b.reason)
  const drop = () => {
    a.removeEventListener('abort', abort)
    b.removeEventListener('abort', abort)
  }
  if (a.aborted || b.aborted) abort()
  else {
    a.addEventListener('abort', abort, { once: true })
    b.addEventListener('abort', abort, { once: true })
  }
  return { signal: controller.signal, drop }
}

const aborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new RpcError('aborted', 'aborted')
}

/** `work`, shared, as one caller waits for it: that caller stops waiting when its own signal aborts, the work goes on. */
export function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(new RpcError('aborted', 'aborted'))
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new RpcError('aborted', 'aborted'))
    signal.addEventListener('abort', stop, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', stop)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop)
        reject(error)
      },
    )
  })
}

/** One log as the RPC writes it, checked; a removed (reorged) log is refused. */
function logOf(value: unknown): RawLog {
  const log = (value ?? {}) as Record<string, unknown>
  if (log.removed === true) throw new RpcError('invalid', 'removed_log')
  if (typeof log.address !== 'string' || !ADDRESS.test(log.address)) throw new RpcError('invalid', 'invalid_log')
  if (!Array.isArray(log.topics) || log.topics.length > 4 || !log.topics.every((topic) => typeof topic === 'string' && WORD.test(topic))) throw new RpcError('invalid', 'invalid_log')
  if (typeof log.data !== 'string' || !HEX.test(log.data)) throw new RpcError('invalid', 'invalid_log')
  if (typeof log.blockHash !== 'string' || !WORD.test(log.blockHash) || typeof log.transactionHash !== 'string' || !WORD.test(log.transactionHash)) throw new RpcError('invalid', 'invalid_log')
  return {
    address: log.address.toLowerCase(),
    topics: (log.topics as string[]).map((topic) => topic.toLowerCase()),
    data: log.data.toLowerCase(),
    blockNumber: quantity(log.blockNumber, 'log'),
    blockHash: log.blockHash.toLowerCase(),
    transactionHash: log.transactionHash.toLowerCase(),
    transactionIndex: quantity(log.transactionIndex, 'log'),
    logIndex: quantity(log.logIndex, 'log'),
  }
}

export function createChainClient(chain: ChainConfig, runtime: ClientRuntime): ChainClient {
  const endpoint = chain.rpc.primary
  const urls = new Set([endpoint.url])
  const perSecond = endpoint.perMinute / 60
  let lastStart = -Infinity
  let starts: { at: number; calls: number }[] = []
  let inFlight = 0
  let restUntil = 0
  let restsInRow = 0
  let lastRestEnd = -Infinity
  let requests = 0
  let calls = 0
  let rests = 0
  let trusted = false
  let checking: Promise<void> | null = null
  let nextId = 1

  /** A place in the endpoint's budget for a request of `count` calls: waited for, never skipped. */
  async function acquire(count: number, signal?: AbortSignal): Promise<void> {
    const weight = chain.pace.batchItemsCount ? count : 1
    for (;;) {
      aborted(signal)
      const at = runtime.now()
      starts = starts.filter((start) => at - start.at < 1_000)
      const used = starts.reduce((sum, start) => sum + start.calls, 0)
      const rest = Math.max(0, restUntil - at)
      const gap = Math.max(0, lastStart + endpoint.gapMs - at)
      const rate = used > 0 && used + weight > perSecond ? starts[0].at + 1_000 - at : 0
      if (rest === 0 && gap === 0 && rate <= 0 && inFlight < endpoint.inFlight) {
        inFlight += 1
        lastStart = at
        starts.push({ at, calls: weight })
        return
      }
      await runtime.pause(Math.max(rest, gap, rate, inFlight >= endpoint.inFlight ? 25 : 1), signal)
    }
  }

  /** A refusal for rate: the whole client rests, longer at each one in a row. */
  function refused(): void {
    const at = runtime.now()
    restsInRow = at < lastRestEnd + chain.pace.maxRestMs ? restsInRow + 1 : 0
    const ms = Math.min(chain.pace.maxRestMs, chain.pace.firstRestMs * 2 ** restsInRow)
    restUntil = Math.max(restUntil, at + ms)
    lastRestEnd = restUntil
    rests += 1
  }

  /** One POST of `items` (one call, or a batch), its envelopes in the items' order. */
  async function post(items: readonly RpcCall[], logs: boolean, signal?: AbortSignal): Promise<RpcOutcome[]> {
    await acquire(items.length, signal)
    const ids = items.map(() => nextId++)
    // One call travels as one object, several as a batch.
    const body = JSON.stringify(items.length === 1
      ? { jsonrpc: '2.0', id: ids[0], method: items[0].method, params: items[0].params }
      : items.map((item, i) => ({ jsonrpc: '2.0', id: ids[i], method: item.method, params: item.params })))
    const deadline = joined(signal, timeoutSignal(CALL_TIMEOUT_MS))
    let response: Response
    let read: { text: string | null; bytes: number }
    requests += 1
    calls += items.length
    try {
      if (!urls.has(endpoint.url)) throw new RpcError('unreachable', 'not_this_chain_rpc')
      response = await runtime.send(endpoint.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: deadline.signal, credentials: 'omit', referrerPolicy: 'no-referrer' })
      read = await bodyWithin(response, logs ? MAX_LOG_REPLY_BYTES : MAX_REPLY_BYTES)
    } catch (error) {
      if (signal?.aborted) throw new RpcError('aborted', 'aborted')
      if (error instanceof RpcError) throw error
      throw new RpcError('unreachable', error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'unreachable')
    } finally {
      deadline.drop()
      inFlight -= 1
    }
    if (response.status === 429 || response.status === 503) {
      refused()
      return items.map(() => ({ ok: false, error: new RpcError('rate', `http_${response.status}`, response.status) }))
    }
    if (read.text === null) throw new RpcError(logs ? 'range' : 'invalid', 'reply_too_large')
    let value: unknown
    try {
      value = JSON.parse(read.text)
    } catch {
      throw new RpcError(response.ok ? 'invalid' : 'unreachable', response.ok ? 'invalid_json' : `http_${response.status}`)
    }
    const envelopes = Array.isArray(value) ? value : [value]
    if (!response.ok && envelopes.every((one) => !(one instanceof Object && 'error' in one))) throw new RpcError('unreachable', `http_${response.status}`)
    // An envelope with an error and no id of this request (a provider's refusal of the whole request, often `id: null`)
    // answers every call that has no envelope of its own. Any other stray or repeated envelope is not an answer.
    const byId = new Map<unknown, Record<string, unknown>>()
    let whole: RpcError | null = null
    for (const one of envelopes) {
      if (!(one instanceof Object) || Array.isArray(one)) throw new RpcError('invalid', 'invalid_envelope')
      const envelope = one as Record<string, unknown>
      if (!ids.includes(envelope.id as number)) {
        if (envelope.error === undefined || whole) throw new RpcError('invalid', 'unexpected_envelope')
        whole = errorOf(envelope.error)
        continue
      }
      if (byId.has(envelope.id)) throw new RpcError('invalid', 'unexpected_envelope')
      byId.set(envelope.id, envelope)
    }
    let rated = false
    const outcomes = ids.map((id): RpcOutcome => {
      const envelope = byId.get(id)
      if (!envelope) {
        if (whole?.kind === 'rate') rated = true
        return { ok: false, error: whole ?? new RpcError('invalid', 'missing_envelope') }
      }
      if (envelope.error !== undefined) {
        const error = errorOf(envelope.error)
        if (error.kind === 'rate') rated = true
        return { ok: false, error }
      }
      if (!('result' in envelope)) return { ok: false, error: new RpcError('invalid', 'missing_result') }
      return { ok: true, result: envelope.result }
    })
    if (rated) refused()
    return outcomes
  }

  /** `items` sent in the chain's batch size; the calls refused for rate asked again after the rest. */
  async function send(items: readonly RpcCall[], logs: boolean, signal?: AbortSignal): Promise<RpcOutcome[]> {
    const out: (RpcOutcome | undefined)[] = items.map(() => undefined)
    let pending = items.map((_, i) => i)
    for (let attempt = 1; pending.length > 0; attempt++) {
      const rated: number[] = []
      for (let at = 0; at < pending.length; at += chain.pace.batchMax) {
        const slice = pending.slice(at, at + chain.pace.batchMax)
        const outcomes = await post(slice.map((i) => items[i]), logs, signal)
        outcomes.forEach((outcome, k) => {
          if (!outcome.ok && outcome.error.kind === 'rate' && attempt < RATE_ATTEMPTS) rated.push(slice[k])
          else out[slice[k]] = outcome
        })
      }
      pending = rated
    }
    return out as RpcOutcome[]
  }

  /**
   * The endpoint says it is this chain: asked once, shared by every call meanwhile; a failure is asked again later. The
   * check is no one caller's: it runs under its own deadline, so a caller that leaves does not fail the others waiting
   * on it, and each caller stops waiting as soon as its own signal aborts.
   */
  function ensureChain(signal?: AbortSignal): Promise<void> {
    if (trusted) return Promise.resolve()
    if (signal?.aborted) return Promise.reject(new RpcError('aborted', 'aborted'))
    checking ??= (async () => {
      const [outcome] = await send([{ method: 'eth_chainId', params: [] }], false)
      if (!outcome.ok) throw outcome.error
      if (quantity(outcome.result, 'chain_id') !== chain.id) throw new RpcError('wrong_chain', 'wrong_chain')
      trusted = true
    })().finally(() => {
      checking = null
    })
    return untilAborted(checking, signal)
  }

  async function call(method: string, params: readonly unknown[], signal?: AbortSignal): Promise<unknown> {
    await ensureChain(signal)
    const [outcome] = await send([{ method, params }], method === 'eth_getLogs', signal)
    if (!outcome.ok) throw outcome.error
    return outcome.result
  }

  async function head(signal?: AbortSignal): Promise<Head> {
    const block = (await call('eth_getBlockByNumber', ['latest', false], signal)) as Record<string, unknown> | null
    if (!block || typeof block.hash !== 'string' || !WORD.test(block.hash)) throw new RpcError('invalid', 'invalid_block')
    return { number: quantity(block.number, 'block'), timestamp: quantity(block.timestamp, 'block'), hash: block.hash.toLowerCase() }
  }

  /** One window's logs; one the RPC finds too large is split in two (down to MIN_LOG_WINDOW), in order. */
  async function window(filter: LogFilter, from: number, to: number, out: RawLog[], signal?: AbortSignal): Promise<void> {
    try {
      const result = await call('eth_getLogs', [{ address: filter.address, topics: filter.topics, fromBlock: hex(from), toBlock: hex(to) }], signal)
      if (!Array.isArray(result)) throw new RpcError('invalid', 'invalid_logs')
      if (out.length + result.length > MAX_LOGS) throw new RpcError('range', 'too_many_logs')
      for (const raw of result) {
        const log = logOf(raw)
        if (log.blockNumber < from || log.blockNumber > to) throw new RpcError('invalid', 'log_outside_range')
        out.push(log)
      }
    } catch (error) {
      if (!(error instanceof RpcError) || error.kind !== 'range' || error.message === 'too_many_logs' || to - from + 1 <= MIN_LOG_WINDOW) throw error
      const middle = from + Math.floor((to - from) / 2)
      await window(filter, from, middle, out, signal)
      await window(filter, middle + 1, to, out, signal)
    }
  }

  async function logs(filter: LogFilter, from: number, to: number | 'latest', signal?: AbortSignal): Promise<RawLog[]> {
    if (!Number.isSafeInteger(from) || from < 0 || (to !== 'latest' && (!Number.isSafeInteger(to) || to < from))) throw new RpcError('range', 'invalid_range')
    let end = to
    if (end === 'latest' || chain.logs.refusesPastHead) {
      const top = (await head(signal)).number
      end = end === 'latest' ? top : Math.min(end, top)
    }
    const out: RawLog[] = []
    const width = Math.max(MIN_LOG_WINDOW, Math.min(chain.logs.window, chain.logs.maxSpan))
    for (let start = from; start <= end; start += width) await window(filter, start, Math.min(end, start + width - 1), out, signal)
    out.sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex)
    return out
  }

  return {
    chain,
    call,
    async batch(items, signal) {
      await ensureChain(signal)
      return send(items, items.some((item) => item.method === 'eth_getLogs'), signal)
    },
    head,
    logs,
    resting: () => Math.max(0, restUntil - runtime.now()),
    state: () => ({ requests, calls, rests, trusted }),
  }
}

/**
 * A pause that ends as soon as the read is no longer wanted: the clock half of a page's runtime. The network half is the
 * page's one admitted transport for the chain (part B: src/chains/elysium/transport.ts), handed in with it.
 */
export function pauseFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal?.aborted) return done()
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      done()
    }
    signal?.addEventListener('abort', finish, { once: true })
  })
}
