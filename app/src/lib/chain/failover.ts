/**
 * The page's route to Robinhood Chain when the chain's own RPC cannot be reached (2026-09-28): see lib/chain/endpoints.ts
 * for why (a large Brazilian ISP's DNS answers NXDOMAIN for every host under chain.robinhood.com) and for what each
 * endpoint serves. lib/chain/browser.ts sends every chain read through one router of this module, per page and per fees
 * worker; the chain code (functions/_lib/*) still names the chain's own RPC, checks every reply as strictly as before,
 * and never knows which endpoint answered.
 *
 * - The primary first, always, while it can be reached. A call to it that fails at the network (a fetch TypeError) is
 *   not taken for unreachable at once: the chain's own 429 carries `access-control-allow-origin: *,*`, which a browser
 *   refuses to read, so the page sees that refusal as the same TypeError (2026-09-25). The router decides with a probe:
 *   a no-cors GET to the same URL, which a browser answers (opaquely) whenever the server was reached at all, and
 *   rejects only when it was not (a name that does not resolve, a connection refused). Reached: the TypeError goes back
 *   to the caller, which takes it for the RPC's 429 as it always did (its own re-ask, rest and waits). Not reached: the
 *   primary is marked unreachable for FIRST_DOWN_MS and the call goes to a fallback at once.
 * - While it is marked so, the calls go to the fallbacks, and once that period has passed a quiet probe (one
 *   eth_blockNumber, whose answer nobody waits for) asks it again: any reply brings every later call back to it; none
 *   doubles the period, up to DOWN_MS. 2026-09-28 (review): a call only the primary serves (a wide range of logs, an
 *   archive read with the archive away, or any call while nothing else answers) probes it at once, at most every
 *   NEEDED_PROBE_MS, and goes to it if it answers: a moment's blip (a phone changing networks) keeps no such read from it.
 * - A fallback is trusted only after it said it is chain 4663 (eth_chainId), and again after it was unreachable. One
 *   that fails the check in any other way (a 403, a WAF's page, a method it refuses, silence) is left alone as an
 *   unreachable one is, FALLBACK_DOWN_MS doubled at each time in a row: never asked again at every call.
 * - A fallback's reply that is not JSON-RPC with a 2xx (a gateway's 502, an HTML page), or that refuses a call at the
 *   head, is that endpoint failing, not the call: it is left alone the same way, and the call goes to the next.
 * - Each call goes to the first fallback, in the order its need names (endpoints.ts ORDER), that can serve all of it: a
 *   read at the head anywhere, a numbered read where that block's state is kept, logs where one call (or a few windows,
 *   endpoints.ts logWindows) covers the range. A read of the page keeps to the endpoint that last served it, so a scan
 *   pinned to one head reads its state where that head was read.
 * - A range of logs wider than a fallback's window is asked window by window, in order, and answered as one reply. None
 *   can serve it: the call answers that it cannot be served (a JSON-RPC error the chain code takes as a failure, not a
 *   rate limit nor a range to split), with no request made to a fallback (the primary's needed probe aside).
 * - Budgets: every fallback has its own, per page and per worker (endpoints.ts gapMs, perMinute, inFlight); a call that
 *   would wait more than BUDGET_WAIT_MS for it goes to the next one. A read (a session) takes no more requests than
 *   its chain code's own call cap, windows included, nor more than SESSION_BYTES. A fallback that refuses for its rate
 *   (HTTP 429 or 503, -32005, "busy", "rate limit") rests, REST_MS doubled at each refusal in a row, up to MAX_REST_MS;
 *   one that refuses what it was thought to serve (an archive read, a range, a method) is not asked it again, and the
 *   call goes to the next. When every fallback that could serve a call rests, the caller gets a 429 of its own and
 *   waits as it waits for the RPC's: the fees lanes' pace and rest stay on top of all this.
 *
 * Node-safe and pure: the network call, the clock and the pause are handed in, so tests/rpc-failover.test.mjs runs it
 * against fake endpoints and a fake clock.
 */
import { CHAIN_ID, bodyWithin, classifyRpcError, hex, timeoutSignal } from '../../../functions/_lib/owned'
import { FALLBACKS, ORDER, PRIMARY, type Endpoint, type Need } from './endpoints'

/** How long the primary is left alone once found unreachable, before a quiet probe asks it again; doubled at each probe it does not answer, up to DOWN_MS. */
export const FIRST_DOWN_MS = 20_000
export const DOWN_MS = 5 * 60_000
/** A fallback's own, after it could not be reached or failed; doubled at each time in a row, up to MAX_REST_MS. */
export const FALLBACK_DOWN_MS = 60_000
/** While a call only the primary serves is asked (or nothing else answers), the primary is probed at most this often. */
export const NEEDED_PROBE_MS = 15_000
/** How long a probe that reached the primary vouches for it: a TypeError meanwhile is its unreadable 429. */
// A reach check distinguishes an unreadable 429 from an outage, but says little about a phone after it changes
// networks. Reuse it only across the immediate 400 ms re-ask, not for a minute of failed reads.
export const REACHED_MS = 1_000
export const REACH_TIMEOUT_MS = 4_000
export const PROBE_TIMEOUT_MS = 5_000
export const REST_MS = 30_000
export const MAX_REST_MS = 5 * 60_000
/** How long a fallback's chain id is trusted before it is asked again. */
export const TRUST_MS = 30 * 60_000
/** The longest a call waits for a fallback's budget before it tries the next. */
export const BUDGET_WAIT_MS = 3_000
/** The most reply bytes one read takes from the fallbacks (functions/_lib/owned.ts MAX_LOG_BYTES, fees.ts MAX_BYTES). */
export const SESSION_BYTES = 8 * 1024 * 1024
/** The narrowest window a fallback's refusals can teach. */
const MIN_WINDOW = 10
/** About how many blocks the chain makes per millisecond (9.9 a second, as functions/_lib/fees.ts SAFE_DEPTH counts). */
const BLOCKS_PER_MS = 0.0099

/** What the router takes from its context (lib/chain/browser.ts): its one network call, its clock and its pause. */
export interface RouterRuntime {
  send(url: string, init: RequestInit): Promise<Response>
  now(): number
  pause(ms: number, signal?: AbortSignal): Promise<void>
  /** Whether the browser says it has no network at all: nothing is anyone's fault then. */
  offline(): boolean
}

/** The endpoints, for tests; the registry's otherwise. */
export interface RouterOptions {
  primary?: Endpoint
  fallbacks?: readonly Endpoint[]
  order?: Readonly<Record<Need, readonly Endpoint[]>>
}

/** One read's account with the fallbacks (a chainDeps, one piece of a lane's work): the endpoint it keeps to, and what it spent. */
export interface Session {
  prefer: string | null
  calls: number
  bytes: number
  readonly maxCalls: number
}

export interface Router {
  /** One POST of the chain code (a call or a batch): to the primary, or to the fallbacks while it is unreachable. */
  send(init: RequestInit, session?: Session): Promise<Response>
  /** A read's own session, with its chain code's call cap. */
  session(maxCalls: number): Session
  /** Whether calls go to the chain's own RPC (false while it is unreachable, until a probe finds it again). */
  primaryUp(): boolean
  /** 2026-09-28 (speed wave B, item 23): a head a read learned otherwise than by eth_blockNumber, as one it answered. */
  learn(block: number): void
  /** For tests: the quiet probe on its way, if any. */
  probing(): Promise<void> | null
  /** For tests: what the router knows of each endpoint. */
  state(): RouterState
  /** For tests: forget everything. */
  reset(): void
}

export interface RouterState {
  primary: { down: boolean; downFor: number; nextProbe: number; lastProbe: number; reachedAt: number }
  head: number | null
  /** Per fallback URL, once asked: when it may be asked again (unreachable or failing, resting), its trust, what it was taught, its budget's starts. */
  fallbacks: Record<string, { downUntil: number; downs: number; restUntil: number; rests: number; trustedUntil: number; distrusted: boolean; window: number; simulate: boolean; starts: number[] }>
}

interface Call {
  id: unknown
  method: string
  params: unknown[]
}
interface Parsed {
  batch: boolean
  calls: Call[]
}
/** What one call needs, and the blocks it names. */
interface Asked {
  need: Need
  block?: number
  from?: number | 'head'
  to?: number | 'head'
}

type Outcome = { kind: 'response'; response: Response } | { kind: 'resting' } | { kind: 'next' }

const HEADERS = { 'Content-Type': 'application/json' }
const QUANTITY = /^0x[0-9a-f]+$/i
/** A refusal of what an endpoint was thought to serve: an old block's state, a range, a method, a plan's limit. */
const CAPABILITY = /archive|unknown state|first available|personal token|api key|free plan|ranges? over|not (?:supported|available)|method not found|does not exist/i
/** The order needs are weighed in when a batch mixes them: the rarest first. */
const STRONGEST: readonly Need[] = ['archive', 'logs', 'state', 'simulate', 'headers', 'latest']

/** The JSON-RPC calls of a POST body, or null when it is not one this router can read. */
function parse(body: unknown): Parsed | null {
  if (typeof body !== 'string') return null
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return null
  }
  const list = Array.isArray(value) ? value : [value]
  if (list.length === 0) return null
  const calls: Call[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') return null
    const { id, method, params } = item as { id?: unknown; method?: unknown; params?: unknown }
    if (typeof method !== 'string') return null
    calls.push({ id: id ?? null, method, params: Array.isArray(params) ? params : [] })
  }
  return { batch: Array.isArray(value), calls }
}

/** A block parameter: a number, the head ('latest', 'pending' or none), or null for any other tag. */
function blockOf(value: unknown): number | 'head' | null {
  if (value === undefined || value === 'latest' || value === 'pending') return 'head'
  if (typeof value !== 'string' || !QUANTITY.test(value)) return null
  const block = Number(BigInt(value))
  return Number.isSafeInteger(block) ? block : null
}

/** The state reads, each with its block parameter's place. */
const STATE_READS: Readonly<Record<string, number>> = { eth_call: 1, eth_getBalance: 1, eth_getCode: 1 }
/** Only these existing, side-effect-free reads may be replayed at a different endpoint. State methods share one registry. */
const SAFE_READS = new Set([...Object.keys(STATE_READS), 'eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getLogs', 'eth_simulateV1'])
const safeRead = (parsed: Parsed | null): parsed is Parsed => parsed !== null && parsed.calls.every((call) => SAFE_READS.has(call.method))

/** What a call needs: the head, a numbered block's state, an archive, headers, a simulation or a range of logs. */
function needOf({ method, params }: Call): Asked {
  if (method === 'eth_simulateV1') return { need: 'simulate' }
  if (method === 'eth_getBlockByNumber') return { need: 'headers' }
  if (method === 'eth_getLogs') {
    const filter = (params[0] ?? {}) as { fromBlock?: unknown; toBlock?: unknown; blockHash?: unknown }
    if (filter.blockHash !== undefined) return { need: 'logs', from: 0, to: 0 }
    const [from, to] = [blockOf(filter.fromBlock), blockOf(filter.toBlock)]
    return from === null || to === null ? { need: 'archive' } : { need: 'logs', from, to }
  }
  const block = method in STATE_READS ? blockOf(params[STATE_READS[method]]) : 'head'
  return block === 'head' ? { need: 'latest' } : block === null ? { need: 'archive' } : { need: 'state', block }
}

/** A reply of the router's own, for every call of a POST: the chain code reads its message as it reads an RPC's. */
function refusal(parsed: Parsed, message: string): Response {
  const one = (call: Call) => ({ jsonrpc: '2.0', id: call.id, error: { code: -32000, message } })
  return new Response(JSON.stringify(parsed.batch ? parsed.calls.map(one) : one(parsed.calls[0])), { status: 200, headers: HEADERS })
}
/** No reachable endpoint serves this call (a wide range of logs, an archive read with the archive away). Not a rate limit, not a range to split. */
const outOfReach = (parsed: Parsed) => refusal(parsed, 'not served by any reachable endpoint')
/** The read's own budget with the fallbacks is spent. */
const spent = (parsed: Parsed) => refusal(parsed, 'fallback budget used up')
/** A reply past the read's bytes: for logs, a range the chain code halves, as it does the RPC's "query returned more than". */
const tooLarge = (parsed: Parsed) => refusal(parsed, 'query returned more than this read takes')
/** Every endpoint that could serve the call rests: the caller waits, as for the RPC's own 429. */
const resting = () => new Response(null, { status: 429 })

/**
 * The error signal a reply carries, if any: the endpoint's rate, or a refusal of what it was thought to serve. Its words
 * are read as the chain code reads them (functions/_lib/owned.ts classifyRpcError), its data's message included; a
 * revert is the call's own answer, for the chain code. 2026-09-28 (review): a 401 or 403 is a refusal only in those
 * words (publicnode's archive refusal is a 403); bare, it is the endpoint failing (askOnce).
 */
function signalOf(status: number, envelopes: readonly unknown[]): 'rate' | 'capability' | null {
  if (status === 429 || status === 503) return 'rate'
  let found: 'capability' | null = null
  for (const envelope of envelopes) {
    const error = (envelope as { error?: { code?: unknown; message?: unknown; data?: { message?: unknown } } } | null)?.error
    if (!error || typeof error !== 'object') continue
    const message = [error.message, error.data?.message].filter((part) => typeof part === 'string').join(' ')
    const kind = classifyRpcError(error.code, message)
    if (kind === 'rate') return 'rate'
    if (!/revert/i.test(message) && (kind === 'range' || error.code === -32601 || CAPABILITY.test(message))) found = 'capability'
  }
  return found
}

/** One JSON-RPC reply: an object with a result or an error. */
const envelope = (item: unknown): boolean => item instanceof Object && ('result' in item || (item as { error?: unknown }).error instanceof Object)

/** The error an aborted call is: the signal's own reason (the chain code's TimeoutError, an AbortError), or an AbortError where a browser gives none. */
const abortedBy = (signal: AbortSignal): unknown => (signal.reason instanceof Object ? signal.reason : new DOMException('The call was aborted', 'AbortError'))

interface Health {
  downUntil: number
  downs: number
  restUntil: number
  rests: number
  trustedUntil: number
  distrusted: boolean
  checking: Promise<true | false | 'rest'> | null
  window: number
  simulate: boolean
  lastStart: number
  starts: number[]
  inFlight: number
}

export function failover(runtime: RouterRuntime, options: RouterOptions = {}): Router {
  const primary = options.primary ?? PRIMARY
  const fallbacks = options.fallbacks ?? FALLBACKS
  const order = options.order ?? ORDER
  const { now } = runtime
  const fresh = () => ({ down: false, downFor: FIRST_DOWN_MS, nextProbe: 0, lastProbe: -Infinity, reachedAt: -Infinity, reaching: null as Promise<boolean> | null, probe: null as Promise<void> | null })
  let p = fresh()
  let head: { block: number; at: number } | null = null
  let health = new Map<string, Health>()

  const healthOf = (endpoint: Endpoint): Health => {
    let found = health.get(endpoint.url)
    if (!found) {
      found = { downUntil: 0, downs: 0, restUntil: 0, rests: 0, trustedUntil: 0, distrusted: false, checking: null, window: endpoint.logWindow, simulate: endpoint.simulate, lastStart: -Infinity, starts: [], inFlight: 0 }
      health.set(endpoint.url, found)
    }
    return found
  }
  /** The head as last read from a fallback, moved on by the time since. */
  const headNow = () => (head ? head.block + Math.floor((now() - head.at) * BLOCKS_PER_MS) : null)

  /** Whether `endpoint` can serve `asked` (as learned so far): one call of a batch takes no windows. */
  function capable(endpoint: Endpoint, asked: Asked, batch: boolean): boolean {
    const h = healthOf(endpoint)
    const top = headNow()
    switch (asked.need) {
      case 'latest':
        return true
      case 'headers':
        return endpoint.headers
      case 'simulate':
        return h.simulate
      case 'archive':
        return endpoint.stateDepth === Infinity
      case 'state':
        return endpoint.stateDepth === Infinity || (top !== null && (asked.block as number) >= top - endpoint.stateDepth)
      case 'logs': {
        if (top === null && (asked.from === 'head' || asked.to === 'head')) return false
        const from = asked.from === 'head' ? (top as number) : (asked.from as number)
        const to = asked.to === 'head' ? (top as number) : (asked.to as number)
        if (endpoint.logDepth !== Infinity && (top === null || from < top - endpoint.logDepth)) return false
        return to - from + 1 <= h.window * (batch ? 1 : endpoint.logWindows)
      }
    }
  }

  // --- The fallbacks' budgets and health ------------------------------------------------------------------------------

  /** A place in `endpoint`'s budget, waited for up to BUDGET_WAIT_MS; false when that is not enough. */
  async function acquire(endpoint: Endpoint, signal?: AbortSignal | null): Promise<boolean> {
    const h = healthOf(endpoint)
    let waited = 0
    for (;;) {
      if (signal?.aborted) throw abortedBy(signal)
      const at = now()
      h.starts = h.starts.filter((start) => at - start < 60_000)
      const paced = Math.max(0, h.lastStart + endpoint.gapMs - at, h.starts.length >= endpoint.perMinute ? h.starts[0] + 60_000 - at : 0)
      if (h.inFlight < endpoint.inFlight && paced === 0) {
        h.inFlight += 1
        h.lastStart = at
        h.starts.push(at)
        return true
      }
      const wait = h.inFlight >= endpoint.inFlight ? Math.max(paced, 25) : paced
      if (waited + wait > BUDGET_WAIT_MS) return false
      waited += wait
      await runtime.pause(wait, signal ?? undefined)
    }
  }
  const release = (endpoint: Endpoint) => void (healthOf(endpoint).inFlight -= 1)
  /** Unreachable or failing: left alone FALLBACK_DOWN_MS, doubled at each time in a row (a call it serves starts them over), and its chain asked again after. */
  function goDown(endpoint: Endpoint): void {
    const h = healthOf(endpoint)
    h.downUntil = now() + Math.min(MAX_REST_MS, FALLBACK_DOWN_MS * 2 ** h.downs++)
    h.trustedUntil = 0
  }
  function rest(endpoint: Endpoint): void {
    const h = healthOf(endpoint)
    h.rests += 1
    h.restUntil = now() + Math.min(MAX_REST_MS, REST_MS * 2 ** (h.rests - 1))
  }
  /** What a refusal of `asked` teaches about `endpoint`: a narrower window, no simulation. A numbered read teaches nothing (the head moves). */
  function learn(endpoint: Endpoint, asked: Asked): void {
    const h = healthOf(endpoint)
    if (asked.need === 'simulate') h.simulate = false
    if (asked.need === 'logs' && typeof asked.from === 'number' && typeof asked.to === 'number') h.window = Math.max(MIN_WINDOW, Math.floor(Math.min(h.window, asked.to - asked.from + 1) / 2))
  }
  function learnHead(parsed: Parsed, envelopes: readonly unknown[]): void {
    parsed.calls.forEach((call, i) => {
      if (call.method !== 'eth_blockNumber') return
      const result = (envelopes[i] as { result?: unknown } | undefined)?.result
      if (typeof result === 'string' && QUANTITY.test(result)) seeHead(Number(BigInt(result)))
    })
  }
  function seeHead(block: number): void {
    if (Number.isSafeInteger(block) && block >= (headNow() ?? 0)) head = { block, at: now() }
  }

  /** One POST to a fallback, read whole (within the read's bytes), and what it says. */
  async function askOnce(endpoint: Endpoint, body: string, parsed: Parsed, asked: readonly Asked[], signal: AbortSignal | null | undefined, session: Session): Promise<Outcome> {
    if (!(await acquire(endpoint, signal))) return { kind: 'resting' }
    let response: Response
    let read: { text: string | null; bytes: number }
    try {
      session.calls += 1
      response = await runtime.send(endpoint.url, { method: 'POST', headers: HEADERS, body, ...(signal ? { signal } : {}) })
      read = await bodyWithin(response, Math.max(0, SESSION_BYTES - session.bytes))
    } catch (error) {
      if (signal?.aborted || !(error instanceof TypeError) || runtime.offline()) throw error
      goDown(endpoint)
      return { kind: 'next' }
    } finally {
      release(endpoint)
    }
    session.bytes += read.bytes
    if (read.text === null) return { kind: 'response', response: tooLarge(parsed) }
    let value: unknown
    try {
      value = JSON.parse(read.text)
    } catch {
      value = undefined
    }
    const envelopes = value === undefined ? [] : Array.isArray(value) ? value : [value]
    const signalled = signalOf(response.status, envelopes)
    if (signalled === 'rate') {
      rest(endpoint)
      return { kind: 'resting' }
    }
    // A refusal of what it was thought to serve (an old block's state, a range, a simulation): learned, and the call goes on.
    if (signalled && asked.some((one) => one.need !== 'latest')) {
      asked.forEach((one) => learn(endpoint, one))
      return { kind: 'next' }
    }
    // 2026-09-28 (review): anything else but JSON-RPC with a 2xx, one reply per call (a gateway's 502, a WAF's page, a
    // refusal of a call at the head or of its chain-id check), is the endpoint failing, not this call: it is left alone
    // and the call goes to the next that can serve it, rather than to the chain code as the read's failure.
    if (signalled || !response.ok || !(parsed.batch ? Array.isArray(value) && value.length === parsed.calls.length && value.every(envelope) : envelope(value))) {
      goDown(endpoint)
      return { kind: 'next' }
    }
    healthOf(endpoint).rests = 0
    learnHead(parsed, envelopes)
    // A 2xx: the chain code reads it as the RPC's 200.
    return { kind: 'response', response: new Response(read.text, { headers: HEADERS }) }
  }

  /** One eth_getLogs over [from, to] asked window by window, the logs answered as one reply; a narrower window learned meanwhile starts it again, once. */
  async function askWindows(endpoint: Endpoint, parsed: Parsed, from: number, to: number, signal: AbortSignal | null | undefined, session: Session): Promise<Outcome> {
    const h = healthOf(endpoint)
    const call = parsed.calls[0]
    const filter = (call.params[0] ?? {}) as Record<string, unknown>
    for (let attempt = 0; attempt < 2; attempt++) {
      const width = h.window
      if (Math.ceil((to - from + 1) / width) > endpoint.logWindows) return { kind: 'next' }
      const logs: unknown[] = []
      let narrower = false
      for (let start = from; start <= to; start += width) {
        if (session.calls >= session.maxCalls) return { kind: 'response', response: spent(parsed) }
        const end = Math.min(to, start + width - 1)
        const part: Parsed = { batch: false, calls: [{ ...call, params: [{ ...filter, fromBlock: hex(start), toBlock: hex(end) }] }] }
        const outcome = await askOnce(endpoint, JSON.stringify({ jsonrpc: '2.0', ...part.calls[0] }), part, [{ need: 'logs', from: start, to: end }], signal, session)
        if (outcome.kind === 'next' && h.window < width) {
          narrower = true
          break
        }
        if (outcome.kind !== 'response') return outcome
        const text = await outcome.response.clone().text()
        let result: unknown
        try {
          result = (JSON.parse(text) as { result?: unknown }).result
        } catch {
          return outcome
        }
        // An error or anything but a list of logs: that reply as it is, for the chain code to refuse.
        if (!Array.isArray(result)) return outcome
        logs.push(...result)
      }
      if (!narrower) return { kind: 'response', response: new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: logs }), { status: 200, headers: HEADERS }) }
    }
    return { kind: 'next' }
  }

  /** Whether `endpoint` says it is chain 4663: asked once per TRUST_MS (and after it was unreachable), shared by every call meanwhile. */
  function trust(endpoint: Endpoint): Promise<true | false | 'rest'> {
    const h = healthOf(endpoint)
    if (h.distrusted) return Promise.resolve(false)
    if (h.trustedUntil > now()) return Promise.resolve(true)
    h.checking ??= (async (): Promise<true | false | 'rest'> => {
      const check: Parsed = { batch: false, calls: [{ id: 1, method: 'eth_chainId', params: [] }] }
      const outcome = await askOnce(endpoint, JSON.stringify({ jsonrpc: '2.0', ...check.calls[0] }), check, [{ need: 'latest' }], timeoutSignal(PROBE_TIMEOUT_MS), session(Infinity)).catch((): Outcome => ({ kind: 'next' }))
      if (outcome.kind === 'resting') return 'rest'
      let result: unknown
      try {
        if (outcome.kind === 'response') result = (JSON.parse(await outcome.response.text()) as { result?: unknown }).result
      } catch {
        result = undefined
      }
      if (typeof result === 'string' && QUANTITY.test(result)) {
        if (BigInt(result) === BigInt(CHAIN_ID)) {
          h.trustedUntil = now() + TRUST_MS
          return true
        }
        // Another chain: never asked again by this page or worker.
        h.distrusted = true
        return false
      }
      // No chain id at all: refused (a 403, a WAF's page, a method it refuses), broken, silent or unreachable. Left alone
      // as an unreachable one is (askOnce already did so for most), then asked again; 2026-09-28 (review): never at
      // every call.
      if (h.downUntil <= now()) goDown(endpoint)
      return false
    })().finally(() => {
      h.checking = null
    })
    return h.checking
  }

  /** The fallbacks, for one POST. `none`: every one that could serve it is unreachable or not this chain. */
  async function viaFallbacks(body: string, parsed: Parsed, signal: AbortSignal | null | undefined, session: Session): Promise<Outcome | { kind: 'out' } | { kind: 'none' }> {
    const asked = parsed.calls.map(needOf)
    const need = STRONGEST.find((one) => asked.some((a) => a.need === one)) ?? 'latest'
    const known = new Set(fallbacks.map((endpoint) => endpoint.url))
    const candidates = order[need].filter((endpoint) => known.has(endpoint.url) && asked.every((a) => capable(endpoint, a, parsed.batch)))
    if (candidates.length === 0) return { kind: 'out' }
    const kept = candidates.findIndex((endpoint) => endpoint.url === session.prefer)
    if (kept > 0) candidates.unshift(...candidates.splice(kept, 1))
    let rests = false
    let reachable = false
    for (const endpoint of candidates) {
      const h = healthOf(endpoint)
      if (h.distrusted || now() < h.downUntil) continue
      if (now() < h.restUntil) {
        rests = true
        continue
      }
      if (session.calls >= session.maxCalls || session.bytes >= SESSION_BYTES) return { kind: 'response', response: spent(parsed) }
      const trusted = await trust(endpoint)
      if (trusted !== true) {
        if (trusted === 'rest') rests = true
        continue
      }
      // Reached, and this chain: past here a call it cannot serve is one no endpoint serves, not a network gone.
      reachable = true
      // Capable, but only in windows: a single eth_getLogs wider than one of them.
      const logs = asked[0]
      const top = headNow()
      const windowed = !parsed.batch && logs.need === 'logs' && typeof logs.from !== 'undefined'
      const from = logs.from === 'head' ? top : (logs.from as number)
      const to = logs.to === 'head' ? top : (logs.to as number)
      const outcome =
        windowed && from !== null && to !== null && to - from + 1 > h.window
          ? await askWindows(endpoint, parsed, from, to, signal, session)
          : await askOnce(endpoint, body, parsed, asked, signal, session)
      if (outcome.kind === 'response') {
        h.downs = 0
        session.prefer = endpoint.url
        return outcome
      }
      if (outcome.kind === 'resting') rests = true
    }
    if (rests) return { kind: 'resting' }
    return reachable ? { kind: 'out' } : { kind: 'none' }
  }
  // --- The primary ----------------------------------------------------------------------------------------------------

  /** Whether the primary answers at all: a no-cors GET resolves (opaquely) whenever the server was reached. */
  function reached(): Promise<boolean> {
    if (now() - p.reachedAt < REACHED_MS) return Promise.resolve(true)
    p.reaching ??= runtime
      .send(primary.url, { method: 'GET', mode: 'no-cors', cache: 'no-store', signal: timeoutSignal(REACH_TIMEOUT_MS) })
      .then(
        (response) => {
          void response.body?.cancel().catch(() => undefined)
          p.reachedAt = now()
          return true
        },
        () => false,
      )
      .finally(() => {
        p.reaching = null
      })
    return p.reaching
  }
  /** Unreachable (its call and the reach probe both failed, which count as its last probe): left alone FIRST_DOWN_MS. */
  function goDownPrimary(): void {
    p.down = true
    p.downFor = FIRST_DOWN_MS
    p.lastProbe = now()
    p.nextProbe = now() + FIRST_DOWN_MS
    p.reachedAt = -Infinity
  }
  /**
   * The probe: one eth_blockNumber, any reply to which brings every later call back. Quiet (nobody waits for it) once the
   * primary's down period has passed; `needed` (a call only it serves) at most every NEEDED_PROBE_MS. One it does not
   * answer doubles the period, up to DOWN_MS.
   */
  function probe(needed: boolean): void {
    if (!p.down || p.probe || runtime.offline()) return
    if (now() < (needed ? Math.min(p.nextProbe, p.lastProbe + NEEDED_PROBE_MS) : p.nextProbe)) return
    p.lastProbe = now()
    const state = p
    state.probe = (async () => {
      let back: boolean
      try {
        const response = await runtime.send(primary.url, { method: 'POST', headers: HEADERS, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }), signal: timeoutSignal(PROBE_TIMEOUT_MS) })
        await response.body?.cancel().catch(() => undefined)
        // An HTTP gateway failure is reachable but not a recovered RPC. Do not bounce every next read back to it.
        back = response.ok
      } catch (error) {
        back = error instanceof TypeError && !runtime.offline() && (await reached())
      }
      if (state !== p) return
      if (back) {
        p.down = false
        p.reachedAt = now()
      } else p.nextProbe = now() + (p.downFor = Math.min(DOWN_MS, p.downFor * 2))
    })().finally(() => {
      state.probe = null
    })
  }

  function session(maxCalls: number): Session {
    return { prefer: null, calls: 0, bytes: 0, maxCalls }
  }

  /** One POST to the primary; one it cannot reach marks it so and goes to the fallbacks (`retry`: and back to it, once, if a needed probe finds it). */
  async function viaPrimary(init: RequestInit, current: Session, retry: boolean): Promise<Response> {
    const eligible = safeRead(parse(init.body))
    try {
      const response = await runtime.send(primary.url, init)
      if (!eligible || ![502, 503, 504].includes(response.status) || runtime.offline() || init.signal?.aborted) return response
      await response.body?.cancel().catch(() => undefined)
      if (!p.down) goDownPrimary()
      return fallback(init, current, new TypeError('primary temporarily unavailable'), retry)
    } catch (error) {
      const timeout = error instanceof Error && error.name === 'TimeoutError'
      if (eligible && timeout && !runtime.offline()) {
        if (!p.down) goDownPrimary()
        // Keep the caller's deadline: a timed-out signal cannot be renewed to make a second request. The next read
        // can use the fallbacks immediately. A transport timeout with time left can use them in this read.
        if (!init.signal?.aborted) return fallback(init, current, error, retry)
      }
      if (!(error instanceof TypeError) || runtime.offline() || init.signal?.aborted) throw error
      // Reached: the RPC's own refusal, which a browser cannot read. The caller takes it as it always did.
      if (await reached()) throw error
      if (!p.down) goDownPrimary()
      return fallback(init, current, error, retry)
    }
  }

  /** The fallbacks' answer to a call the primary is not asked, or the router's own. */
  async function fallback(init: RequestInit, current: Session, failure: unknown, retry: boolean): Promise<Response> {
    const parsed = parse(init.body)
    if (!safeRead(parsed)) throw failure instanceof Error ? failure : new TypeError('not a supported chain read')
    // A fallback gets exactly the body the primary would have: the chain code's own calls.
    const routed = await viaFallbacks(init.body as string, parsed, init.signal, current)
    if (routed.kind === 'response') return routed.response
    if (routed.kind === 'resting') return resting()
    // 2026-09-28 (review): only the primary serves this call (no reachable fallback does, or none is reachable at all).
    // It is probed now, at most every NEEDED_PROBE_MS, and the call goes to it if it answers: a blip's down period does
    // not keep a fees history's pool logs from it until the fees store has stopped asking.
    if (retry) {
      probe(true)
      await p.probe
      if (!p.down) return viaPrimary(init, current, false)
    }
    if (routed.kind === 'out' && parsed) return outOfReach(parsed)
    throw failure instanceof TypeError ? failure : new TypeError('no reachable endpoint')
  }

  return {
    session,
    learn: seeHead,
    primaryUp: () => !p.down,
    probing: () => p.probe,
    send(init, current = session(Infinity)) {
      if (!p.down) return viaPrimary(init, current, true)
      probe(false)
      return fallback(init, current, null, true)
    },
    state: () => ({ primary: p, head: headNow(), fallbacks: Object.fromEntries(health) }),
    reset() {
      p = fresh()
      head = null
      health = new Map()
    },
  }
}
