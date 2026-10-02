/**
 * Domino's own Robinhood Chain node, as the site's Pages Functions read it (RPC-SPEC §2.3; the owner's rule of
 * 2026-10-01: the site reads nothing from a public RPC). rugged97's node answers at https://rpc.domino.money/<token>/
 * (docs/LOCAL_RPC_SOURCE.md): a pruned Arbitrum Nitro node that keeps every log and header and about 25 minutes (some
 * 15,000 blocks) of state. Its URL, token included, is the Pages secret LOCAL_RPC_URL, which the owner types: it never
 * reaches the browser, and never an answer, a header or a log line of this site.
 *
 * Server only, and not a general JSON-RPC proxy. The chain code (owned.ts, walletPositions.ts, fees.ts, feesLedger.ts,
 * automation.ts, vaultRecord.ts) asks its fixed sentinel, owned.ts RPC_URL, and chooses every method, contract, topic
 * and block range itself; this transport is its `fetch`, and forwards only:
 *
 *   eth_blockNumber       []
 *   eth_call              [{to: Multicall3, data: aggregate3(≤ 50 calls)}, 'latest' | block]   (no state override)
 *   eth_getLogs           [{address (1..8), fromBlock, toBlock, topics}]   (topic0 one of LOG_TOPICS; the PoolManager's: one block)
 *   eth_getBlockByNumber  [block, false]
 *   eth_simulateV1        one fixed shape, for the simulate route alone (each call's gas bounded, never to Multicall3)
 *
 * and, of those, only the methods its purpose (the route that made it) reads. Anything else is refused before a byte is
 * sent. Its own eth_chainId check runs before the first call of an isolate and every ten minutes after.
 *
 * rugged97's rules for the site's token (C:/dwt/rpc-plan/RUGGED_RPC_SITE_2026-10-02.md, binding), as this transport holds
 * them for every route:
 * - no log is read below LOCAL_RPC_LOG_FLOOR (rule 3): a range that starts below it is cut to start there, and one that
 *   ends below it is answered empty with no call;
 * - a log range wider than one node call serves (LOCAL_RPC_LOG_BLOCKS) is asked in windows, oldest first, and merged back
 *   into one answer under the caller's id; calls go in batches of at most LOCAL_RPC_BATCH_ITEMS per POST, and a multicall
 *   carries at most LOCAL_RPC_BATCH_ITEMS calls (rule 5);
 * - a call whose log windows cover more than LOCAL_RPC_WIDE.blocks is a wide scan (rule 1): one at a time per isolate,
 *   paid for in blocks scanned (all of the call's windows, before its first POST, so a turn refused costs the node
 *   nothing), waited for briefly, else a 429;
 * - within one invocation, a log window the node answered is never asked again (the chain code's paced retry after a
 *   429 asks only the windows still missing);
 * - the node's own time-out (-32002) rests every POST of the isolate for the longest rest, and is never split and asked
 *   again (rule 7); our own time-out, which comes first, rests it too, staged: the transport's (one POST's, a wide
 *   call's) or the chain code's own per-call signal (owned.ts, fees.ts), whichever ends a POST at the node first;
 * - a wide call ends within its turn's life: all its waits and POSTs within one time-out from its turn's start, so it
 *   holds its turn (and the site gate's lease) until it settles, and no second wide scan starts beside it;
 * - a 429 or a 503 (nginx's answer past the token's limit) rests every POST for a staged while (rule 1 of §1).
 * One invocation makes at most LOCAL_RPC_POSTS_PER_INVOCATION POSTs. Per isolate: a token bucket paces the POSTs; a node
 * that cannot be reached is let alone for a growing while; a refused token is let alone for a minute; a node on another
 * chain is not asked for ten minutes. Each is told to the chain code the way it already understands (a 429 to wait out, a
 * 502 to stop, a thrown error), and the route reads health() to answer the browser with the calm "source unavailable".
 */
import { CHAIN_ID, MULTICALL3, REPLY_CUT, RPC_URL, SELECTOR, SETUP_DEPLOY_BLOCK, SETUP_MINTED_TOPIC, bodyWithin, hex } from './owned'
import { POOL_MANAGER, TOPIC } from './fees'
import { BUDGET_APPLIED, FEES_REALIZED } from './feesLedger'
import { EXECUTION_COMPLETED } from './vaultRecord'
import { outlast } from './sharedWork'
import { SIMULATE_CALLS, simulateGas } from './simulate'
import type { SiteGate } from './wideGate'

export const LOCAL_RPC_HOST = 'rpc.domino.money'
/**
 * The widest eth_getLogs one node call may cover, any filter. Changed on purpose 2026-10-02 (rugged97's answer to Q1: the
 * node has no block ceiling, only its 30 s time-out, and a log read costs about 11 µs of its CPU per thousand blocks, so a
 * wider window costs it no more): 1,000,000, was 100,000, ten times fewer calls for the same blocks.
 *
 * Changed on purpose 2026-10-02 (review of the rules, finding 7: a scan since the deploy grows by some 860,000 blocks a
 * day, and in windows of a million its calls, and the POSTs carrying them, grew with it): 10,000,000, about 110 ms of the
 * node's CPU for a filtered window; the cost is the blocks either way (LOCAL_RPC_WIDE counts them), not the calls.
 */
export const LOCAL_RPC_LOG_BLOCKS = 10_000_000
export const LOCAL_RPC_BATCH_ITEMS = 50 // Q2 and rugged's rule 5: JSON-RPC items per POST, and calls per multicall
/** Our own time-out of one POST: under the node's 30 s, nginx's 60 s and Cloudflare's 100 s. */
export const LOCAL_RPC_POST_TIMEOUT_MS = 10_000
/**
 * One question's guard on its node work. Changed on purpose 2026-10-02 (the account is on Workers Paid, which allows at
 * least 1,000 subrequests an invocation): it is no longer the Free plan's 50 subrequests that bounds it, but what one
 * visitor's question may cost the node.
 */
export const LOCAL_RPC_POSTS_PER_INVOCATION = 40
export const LOCAL_RPC_REQUEST_BYTES = 262_144 // one POST's body
export const LOCAL_RPC_REPLY_BYTES = 8 * 1024 * 1024 // one POST's reply, and one logical call's merged reply
/**
 * Per isolate. Changed on purpose 2026-10-02 (rugged97's answer to Q3: the site's own token allows 1,000 requests a second,
 * a burst of 2,000 and 64 connections for the whole site; past it nginx answers 503): 50 a second, a twentieth of the
 * token, with a burst of 20, so one isolate stays well under the 64 connections; it was 5 a second for a limit per address.
 */
export const LOCAL_RPC_RATE = { perSecond: 50, burst: 20, waitMs: 1_000 } as const
export const LOCAL_RPC_REST = { firstMs: 2_000, maxMs: 30_000 } as const // after the node's 429/503, or its -32002
export const LOCAL_RPC_DOWN = { firstMs: 15_000, maxMs: 300_000 } as const // after the tunnel/node is unreachable
export const LOCAL_RPC_REFUSED_MS = 60_000 // after 401/403/404 (token refused)
export const LOCAL_RPC_TRUST_MS = 600_000 // the chain id check's life
/**
 * rugged97's rule 3 (2026-10-02): never a log below block 69,249,061 (DominoSetupV1's deploy). The node's log index begins
 * near block 69 million, and below it a read costs 3 to 5 s per million blocks.
 */
export const LOCAL_RPC_LOG_FLOOR = SETUP_DEPLOY_BLOCK
/**
 * rugged97's rule 1 (2026-10-02): wide log scans (since the deploy, say) at most 10 a second and 4 at once for the whole
 * site, about one core of his node: some 11 µs of CPU per thousand blocks, so about 90,000,000 blocks a second. A call
 * whose log windows cover more than `blocks` is one: per isolate one at a time, paid for in the blocks it scans from a
 * bucket of `blocksPerSecond` with a burst of `burstBlocks` (a call wider than the burst waits for a full bucket and leaves
 * the rest owed), waiting up to `waitMs` for its turn, else a 429 before anything is sent. A read that goes on from a kept
 * block (a few thousand blocks) is never one.
 *
 * Changed on purpose 2026-10-02 (review of the rules, findings 2, 12 and 13): it was one turn per POST, a second, burst 2,
 * whatever the POST's fifty windows covered (one POST was about five scans since the deploy), taken POST by POST, so a
 * refused turn threw away the windows already answered. Per isolate, about a ninth of the site's budget: nine isolates
 * scanning without a pause stay within its rate, four at once within its parallel limit. A strict site-wide limit is a
 * Durable Object every isolate asks (Workers Paid allows it): a Worker of its own (RPC-SPEC §11.5).
 */
export const LOCAL_RPC_WIDE = { blocks: 1_000_000, blocksPerSecond: 10_000_000, burstBlocks: 30_000_000, waitMs: 5_000 } as const
/**
 * The logical log window the chain code is told to use at the edge: one logical call ≤ one POST. Pinned on purpose
 * 2026-10-02 at 5,000,000 blocks (it was LOCAL_RPC_LOG_BLOCKS × LOCAL_RPC_BATCH_ITEMS, the same then): the record route's
 * units are kept under that width (vaultRecord.ts), and every one kept stays valid.
 */
export const EDGE_LOG_LIMITS = { one: 5_000_000, many: 5_000_000 } as const

export type Purpose = 'owned' | 'state' | 'ledger' | 'automation' | 'record' | 'simulate'
export type SourceHealth = 'ok' | 'wrong_chain' | 'refused' | 'down'
export interface LocalRpc {
  /** OwnedDeps/FeesDeps.fetch: `input` must be functions/_lib/owned.ts RPC_URL (the chain code's fixed name). */
  fetch(input: string, init: RequestInit): Promise<Response>
  /** This invocation's account, for logs and Server-Timing. */
  spent(): { posts: number; items: number; ms: number }
  /** The isolate's view of the node after the last call. */
  health(): SourceHealth
  /** Whether a call of this invocation was refused for its visitor's spent share of the node (LocalRpcOptions.reserve). */
  refused(): boolean
}

/**
 * The six events a log read may ask for (topic0): fees.ts TOPIC (Transfer, ModifyLiquidity), owned.ts SETUP_MINTED_TOPIC,
 * vaultRecord.ts EXECUTION_COMPLETED, feesLedger.ts FEES_REALIZED and BUDGET_APPLIED. Changed on purpose 2026-10-02
 * (rugged97's rule 2: never a pool's whole history): a pool's Initialize, Swap, Donate and ProtocolFeeUpdated, which only
 * the retired fees replay read, are refused; and the PoolManager's logs (ModifyLiquidity) are read one block at a time.
 */
export const LOG_TOPICS: readonly string[] = Object.freeze([TOPIC.Transfer, TOPIC.ModifyLiquidity, SETUP_MINTED_TOPIC, EXECUTION_COMPLETED, FEES_REALIZED, BUDGET_APPLIED])

/** What each purpose (each route) may ask of the node; the simulation's method for its own route alone. */
export const PURPOSE_METHODS: Readonly<Record<Purpose, readonly string[]>> = Object.freeze({
  owned: ['eth_blockNumber', 'eth_call', 'eth_getLogs'],
  state: ['eth_blockNumber', 'eth_call'],
  ledger: ['eth_call', 'eth_getLogs', 'eth_getBlockByNumber'],
  automation: ['eth_blockNumber', 'eth_call'],
  // 2026-10-02 (review of the rules, finding 16): and eth_call, the factory's isVault of the vault asked for.
  record: ['eth_blockNumber', 'eth_call', 'eth_getLogs'],
  simulate: ['eth_simulateV1'],
})

const USER_AGENT = 'DominoChainRoutes/1'
const TOKEN_PATH = /^\/[A-Za-z0-9_-]{16,256}\/?$/
const ADDRESS = /^0x[0-9a-f]{40}$/
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/
const WORD = /^0x[0-9a-f]{64}$/
const DATA = /^0x(?:[0-9a-f]{2})*$/
const AGGREGATE3 = `0x${SELECTOR.aggregate3}`
const CHAIN_ID_HEX = hex(CHAIN_ID)
/** The most envelopes one fetch of the chain code may carry, and the most calls one simulation may name. */
const MAX_ENVELOPES = 200
const MAX_SIMULATE_CALLS = SIMULATE_CALLS
const MAX_SIMULATE_DATA = 32_770
/** A time-out, ours or the chain code's (AbortSignal.timeout's reason), as opposed to a visitor's drop (an AbortError). */
const isTimeout = (reason: unknown): boolean => !!reason && typeof reason === 'object' && (reason as { name?: unknown }).name === 'TimeoutError'
const tookTooLong = () => new DOMException('The node took too long', 'TimeoutError')
/** The longest message of a node's error handed back to the chain code (its `data` is dropped). */
const ERROR_MESSAGE_CHARS = 200
/** How much longer than its own time-out a shared chain id check may run before a later invocation stops waiting on it. */
const CHECK_MARGIN_MS = 2_000
/**
 * What one node call's envelope adds to its result in a reply ({"jsonrpc":"2.0","id":n,"result":…} and a comma), at
 * most: a reply this much per call past the caller's limit is surely past it once its windows are joined (finding 11).
 */
export const REPLY_SLACK_BYTES = 64
/** The node's own time-out of a call (rugged97's rule 7): `-32002 request timed out`, after 30 s of its work. */
export const NODE_TIMEOUT = -32002

/**
 * The node's URL from the Pages secret, or null when it is missing or anything but exactly https://rpc.domino.money/
 * and one token-shaped path segment (backend/rpc_config.py's shape): no port, no user, no query, no fragment. Always
 * with a trailing slash.
 */
export function localRpcEndpoint(env: { LOCAL_RPC_URL?: string }): string | null {
  const raw = env.LOCAL_RPC_URL
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname !== LOCAL_RPC_HOST || url.port !== '' || url.username !== '' || url.password !== '') return null
  if (url.search !== '' || url.hash !== '' || raw.includes('?') || raw.includes('#') || !TOKEN_PATH.test(url.pathname)) return null
  return `https://${LOCAL_RPC_HOST}${url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`}`
}

// ---------------------------------------------------------------------------
// The isolate's memory of the node
// ---------------------------------------------------------------------------

type Verdict = { kind: 'trusted' } | { kind: 'wrong' } | { kind: 'reply'; status: number; retryAfter: string | null } | { kind: 'throw'; error: unknown }

/**
 * The chain id check on its way, and when it began (2026-10-02, review finding 3): shared by every invocation that needs
 * it, cleared by its own settling, and never joined once older than its time-out and a margin (sharedWork.ts).
 */
export interface Checking {
  verdict: Promise<Verdict>
  started: number
}

/** What one isolate knows of the node: shared by every invocation it serves (tests make their own). */
export interface LocalRpcMemory {
  trustedUntil: number
  checking: Checking | null
  wrongUntil: number
  refusedUntil: number
  downUntil: number
  downMs: number
  restUntil: number
  restMs: number
  /** The token bucket, as the theoretical arrival time of the next POST (GCRA). */
  tat: number
  /** The wide scans' own bucket (LOCAL_RPC_WIDE), likewise: the time it is full again, each call adding its blocks' worth. */
  wideTat: number
  /** The wide scan on its way, if any: when it settles, and when it began (one older than a call's life no longer counts). */
  wideBusy: { done: Promise<void>; started: number } | null
}

export const localRpcMemory = (): LocalRpcMemory => ({ trustedUntil: 0, checking: null, wrongUntil: 0, refusedUntil: 0, downUntil: 0, downMs: 0, restUntil: 0, restMs: 0, tat: 0, wideTat: 0, wideBusy: null })

const isolate = localRpcMemory()

/** Tests: forget trust, rest, down, refusal and the bucket (the isolate's, or `memory`). */
export function resetLocalRpcMemory(memory: LocalRpcMemory = isolate): void {
  Object.assign(memory, localRpcMemory())
}

/** One log line of a fixed event code and numbers, and nothing taken from a request, the node or the secret. */
const eventLine = (name: string, extra: Record<string, number> = {}) => JSON.stringify({ service: 'chain-routes', event: name, ...extra })

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

interface Envelope {
  jsonrpc: '2.0'
  id: number
  method: string
  params: unknown[]
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((key) => own.includes(key))
}

const quantity = (value: unknown): number | null => (typeof value === 'string' && QUANTITY.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null)
/** A call's wei value: any hex quantity of at most 256 bits (2^53 wei is only about 0.009 ETH, so no Number here). */
const isWei = (value: unknown): boolean => typeof value === 'string' && QUANTITY.test(value) && value.length <= 66
const list = <T>(value: unknown, max: number, each: (item: unknown) => item is T): value is T[] => Array.isArray(value) && value.length >= 1 && value.length <= max && value.every(each)
const isAddress = (value: unknown): value is string => typeof value === 'string' && ADDRESS.test(value)
const isWord = (value: unknown): value is string => typeof value === 'string' && WORD.test(value)
const isEvent = (value: unknown): value is string => typeof value === 'string' && LOG_TOPICS.includes(value)

/** An eth_getLogs filter the chain code may send, with its range, or null. */
function logFilter(params: unknown[]): { filter: Record<string, unknown>; from: number; to: number } | null {
  if (params.length !== 1 || !isObject(params[0])) return null
  const filter = params[0]
  if (!exactKeys(filter, ['address', 'fromBlock', 'toBlock', 'topics'])) return null
  if (!isAddress(filter.address) && !list(filter.address, 8, isAddress)) return null
  const from = quantity(filter.fromBlock)
  const to = quantity(filter.toBlock)
  if (from === null || to === null || from > to) return null
  // rugged97's rule 2 (2026-10-02): the PoolManager's logs only one block at a time, at a block our own events name; never
  // a range of a pool's history.
  const addresses: unknown[] = Array.isArray(filter.address) ? filter.address : [filter.address]
  if (addresses.includes(POOL_MANAGER) && to !== from) return null
  const topics = filter.topics
  if (!Array.isArray(topics) || topics.length < 1 || topics.length > 4) return null
  if (!isEvent(topics[0]) && !list(topics[0], 8, isEvent)) return null
  if (!topics.slice(1).every((topic) => topic === null || isWord(topic) || list(topic, 8, isWord))) return null
  return { filter, from, to }
}

/**
 * eth_simulateV1's one shape (RPC-SPEC §2.5.6): one block of 1..SIMULATE_CALLS calls from one owner, no validation, at the
 * head. Changed on purpose 2026-10-02 (review of rugged97's rules, finding 15): each call names its gas, at most its share
 * (simulate.ts simulateGas), and none is to Multicall3 (rule 5: at most fifty calls a multicall).
 */
function simulation(params: unknown[]): boolean {
  if (params.length !== 2 || params[1] !== 'latest' || !isObject(params[0])) return false
  const options = params[0]
  if (!exactKeys(options, ['blockStateCalls', 'validation']) || options.validation !== false) return false
  const blocks = options.blockStateCalls
  if (!Array.isArray(blocks) || blocks.length !== 1 || !isObject(blocks[0]) || !exactKeys(blocks[0], ['calls'])) return false
  const calls = blocks[0].calls
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > MAX_SIMULATE_CALLS) return false
  const from = isObject(calls[0]) ? calls[0].from : null
  const gas = simulateGas(calls.length)
  return calls.every(
    (call) =>
      isObject(call) &&
      exactKeys(call, ['from', 'to', 'data', 'value', 'gas']) &&
      call.from === from &&
      isAddress(call.from) &&
      isAddress(call.to) &&
      call.to !== MULTICALL3 &&
      quantity(call.gas) !== null &&
      (quantity(call.gas) as number) <= gas &&
      typeof call.data === 'string' &&
      DATA.test(call.data) &&
      call.data.length <= MAX_SIMULATE_DATA &&
      isWei(call.value),
  )
}

/** Whether one envelope is a read `purpose` may ask, exactly as the chain code asks it. */
function permitted(envelope: Envelope, purpose: Purpose): boolean {
  if (!PURPOSE_METHODS[purpose].includes(envelope.method)) return false
  const params = envelope.params
  switch (envelope.method) {
    case 'eth_blockNumber':
      return params.length === 0
    case 'eth_call': {
      if (params.length !== 2 || !isObject(params[0]) || !exactKeys(params[0], ['to', 'data'])) return false
      const { to, data } = params[0]
      // rugged97's rule 5 (2026-10-02): at most LOCAL_RPC_BATCH_ITEMS calls in one multicall (the word after the
      // selector's offset is aggregate3's array length).
      return to === MULTICALL3 && typeof data === 'string' && DATA.test(data) && data.startsWith(AGGREGATE3) && data.length >= 138 && BigInt(`0x${data.slice(74, 138)}`) <= BigInt(LOCAL_RPC_BATCH_ITEMS) && (params[1] === 'latest' || quantity(params[1]) !== null)
    }
    case 'eth_getLogs':
      return logFilter(params) !== null
    case 'eth_getBlockByNumber':
      return params.length === 2 && quantity(params[0]) !== null && params[1] === false
    case 'eth_simulateV1':
      return simulation(params)
    default:
      return false
  }
}

const refusedBody = () => new TypeError('local_rpc_refused_method')

/** The chain code's body as envelopes (one, or a batch of 1..200 with distinct ids), each permitted, or the refusal. */
function envelopesOf(body: unknown, purpose: Purpose): { envelopes: Envelope[]; batch: boolean } {
  if (typeof body !== 'string') throw refusedBody()
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw refusedBody()
  }
  const batch = Array.isArray(parsed)
  const all: unknown[] = batch ? (parsed as unknown[]) : [parsed]
  if (all.length < 1 || all.length > MAX_ENVELOPES) throw refusedBody()
  const ids = new Set<number>()
  const envelopes = all.map((item) => {
    if (!isObject(item) || !exactKeys(item, ['jsonrpc', 'id', 'method', 'params']) || item.jsonrpc !== '2.0') throw refusedBody()
    const { id, method, params } = item
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || ids.has(id) || typeof method !== 'string' || !Array.isArray(params)) throw refusedBody()
    ids.add(id)
    const envelope: Envelope = { jsonrpc: '2.0', id, method, params }
    if (!permitted(envelope, purpose)) throw refusedBody()
    return envelope
  })
  return { envelopes, batch }
}

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

/** One node call (a window of a log read, or a call as asked), under the internal id it is sent with. */
interface Item {
  logical: number
  logs: boolean
  method: string
  params: unknown[]
  bytes: number
  /** The blocks a log window covers (LOCAL_RPC_WIDE); 0 for any other call. */
  span: number
}

type Reply = { result: unknown } | { error: { code: number; message: string } }

/** What one POST came to, short of an error thrown: the node's text, a reply past the byte cap, or an answer for the chain code. */
type Posted = { kind: 'text'; text: string; bytes: number } | { kind: 'oversize' } | { kind: 'response'; response: Response }

const reply502 = () => new Response(null, { status: 502 })
/** The caller's reply limit passed (ChainInit.replyBytes): nothing more is read or sent, and the chain code reads it as its own cut read. */
const replyCut = () => new Response(null, { status: 200, headers: { [REPLY_CUT]: '1' } })

/** The caller's reply limit (owned.ts ChainInit), or null when it names none. */
function replyLimitOf(init: RequestInit): number | null {
  const value = (init as { replyBytes?: unknown }).replyBytes
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}
const reply429 = (seconds: number) => new Response(null, { status: 429, headers: { 'Retry-After': String(Math.max(1, Math.ceil(seconds))) } })

/** A JSON-RPC error as the chain code receives it: its code and the first characters of its message; no data. */
function trimmedError(value: unknown): { code: number; message: string } {
  const error = isObject(value) ? value : {}
  return { code: typeof error.code === 'number' && Number.isFinite(error.code) ? error.code : -32603, message: typeof error.message === 'string' ? error.message.slice(0, ERROR_MESSAGE_CHARS) : 'error' }
}

/** A Retry-After in seconds as milliseconds, bounded to `max`; null when there is none. */
function retryAfterMs(value: string | null, max: number): number | null {
  const seconds = Number(value ?? Number.NaN)
  return value !== null && Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, max) : null
}

export interface LocalRpcOptions {
  purpose: Purpose
  upstream?: (url: string, init: RequestInit) => Promise<Response>
  now?: () => number
  /** Tests: the wait for a token of the bucket (setTimeout otherwise). */
  sleep?: (ms: number) => Promise<void>
  /** Tests: an isolate of their own (localRpcMemory()); the isolate's otherwise. */
  memory?: LocalRpcMemory
  /** Tests: a shorter time-out than LOCAL_RPC_POST_TIMEOUT_MS. */
  timeoutMs?: number
  /** Where the event lines go (console.log otherwise). */
  log?: (line: string) => void
  /**
   * The invocation's waitUntil (2026-10-02, review finding 3): the chain id check that several invocations share is handed
   * to it, so it settles even when the visitor who started it leaves (Cloudflare cancels such a request's tasks).
   */
  keepAlive?: (work: Promise<unknown>) => void
  /**
   * The invocation's visitor's node bill (chainRoutes.ts VISITOR_NODE), asked before every call that would reach the node,
   * before the chain id check. The first such call takes the question's reserve. When the bill holds none, the hook says
   * false: the call is refused here at once, as a thrown error the chain code does not retry, and refused() says so;
   * nothing is sent. A question answered from the edge's cache never gets here, so it never needs a reserve.
   *
   * Changed on purpose 2026-10-02 (RPC fix round 2.2): it was `cacheOnly`, decided at the route's door, where a cache hit
   * or a join paid a reserve while it waited.
   */
  reserve?: () => boolean
  /** Called once for each POST that goes to the node, the chain id check's included: the visitor's bill (chainRoutes.ts). */
  onPost?: () => void
  /**
   * The site-wide gate of wide scans (wideGate.ts, 2026-10-02, review of the rules, finding 2), asked after the isolate's
   * own turn when the deployment binds it; none: the isolate's own pace alone.
   */
  siteGate?: SiteGate | null
}

export function createLocalRpc(endpoint: string, options: LocalRpcOptions): LocalRpc {
  const { purpose } = options
  const upstream = options.upstream ?? ((url: string, init: RequestInit) => fetch(url, init))
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const memory = options.memory ?? isolate
  const timeoutMs = options.timeoutMs ?? LOCAL_RPC_POST_TIMEOUT_MS
  const log = options.log ?? ((line: string) => console.log(line))
  const event = (name: string, extra: Record<string, number> = {}) => log(eventLine(name, extra))
  const spent = { posts: 0, items: 0, ms: 0 }
  let refusals = 0
  /** The log windows this invocation's node answered, by their exact call: never asked again (finding 3). */
  const answered = new Map<string, Reply>()
  const windowKey = (item: Item) => `${item.method}|${JSON.stringify(item.params)}`

  function health(): SourceHealth {
    const at = now()
    if (memory.wrongUntil > at) return 'wrong_chain'
    if (memory.refusedUntil > at) return 'refused'
    if (memory.downUntil > at) return 'down'
    return 'ok'
  }

  function markDown(): void {
    memory.downMs = memory.downMs > 0 ? Math.min(memory.downMs * 2, LOCAL_RPC_DOWN.maxMs) : LOCAL_RPC_DOWN.firstMs
    memory.downUntil = now() + memory.downMs
    event('local_rpc_down', { ms: memory.downMs })
  }

  /** The node said 429 or 503: every POST of the isolate rests, staged ×4 per refusal in a row, or as long as it asked (≤ 30 s). */
  function rest(asked: number | null): Response {
    const staged = memory.restMs > 0 ? Math.min(memory.restMs * 4, LOCAL_RPC_REST.maxMs) : LOCAL_RPC_REST.firstMs
    memory.restMs = staged
    const ms = Math.min(LOCAL_RPC_REST.maxMs, Math.max(staged, asked ?? 0))
    memory.restUntil = now() + ms
    event('local_rpc_rest', { ms })
    return reply429(ms / 1000)
  }

  /**
   * One POST of `body` to the node, within the invocation's budget, the isolate's states and its bucket, under its own
   * time-out, the caller's signal and (a wide call's) `cut`, its reply read no further than `limit`. Its outcome as the
   * chain code must see it.
   */
  async function post(body: string, signal: AbortSignal | null | undefined, limit = LOCAL_RPC_REPLY_BYTES, cut: AbortSignal | null = null): Promise<Posted> {
    if (spent.posts >= LOCAL_RPC_POSTS_PER_INVOCATION) throw new TypeError('local_rpc_budget')
    const at = now()
    if (memory.wrongUntil > at) throw new TypeError('local_rpc_wrong_chain')
    if (memory.refusedUntil > at) return { kind: 'response', response: reply502() }
    if (memory.downUntil > at) throw new TypeError('local_rpc_down')
    if (memory.restUntil > at) return { kind: 'response', response: reply429((memory.restUntil - at) / 1000) }
    // The bucket (GCRA): a POST may go once the burst's tolerance allows; one that would wait longer than waitMs is a 429.
    const interval = 1000 / LOCAL_RPC_RATE.perSecond
    const tolerance = (LOCAL_RPC_RATE.burst - 1) * interval
    const tat = Math.max(memory.tat, at)
    const wait = Math.max(0, tat - tolerance - at)
    if (wait > LOCAL_RPC_RATE.waitMs) return { kind: 'response', response: reply429(2) }
    memory.tat = tat + interval
    if (wait > 0) await sleep(wait)
    if (signal?.aborted) throw signal.reason ?? new DOMException('The read was dropped', 'AbortError')
    // A wide call past its life before this POST went: nothing was at the node, so nothing rests.
    if (cut?.aborted) throw tookTooLong()
    spent.posts += 1
    options.onPost?.()
    const controller = new AbortController()
    let timedOut = false
    const timeUp = () => {
      timedOut = true
      controller.abort(tookTooLong())
    }
    const timer = setTimeout(timeUp, timeoutMs)
    cut?.addEventListener('abort', timeUp, { once: true })
    const forward = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', forward, { once: true })
    const started = now()
    // A failure while asking or reading: a time-out, the caller's drop, or a node that cannot be reached.
    // Changed on purpose 2026-10-02 (review of the rules, finding 6): our own time-out comes before the node's 30 s
    // (-32002), so a call the node is slow on rests the isolate too, staged as a 429 or a 503 is; it rested nothing, and
    // the same slow call was sent again by the next question.
    // Changed on purpose 2026-10-02 (review of the rules, round 4): the chain code's own per-call signal (owned.ts and
    // fees.ts CALL_TIMEOUT_MS, 10 s from its call, so before this POST's own 10 s) is our time-out too, and rests the
    // isolate the same way; it was taken as the caller's drop, so the rest almost never ran. A visitor's drop (an
    // AbortError, the simulation's request signal) rests nothing.
    const failed = (error: unknown): never => {
      if (timedOut || (signal?.aborted && isTimeout(signal.reason))) {
        rest(null)
        throw tookTooLong()
      }
      if (signal?.aborted) throw signal.reason ?? error
      markDown()
      throw new TypeError('local_rpc_down')
    }
    try {
      let response: Response
      try {
        response = await upstream(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT }, body, redirect: 'manual', signal: controller.signal })
      } catch (error) {
        return failed(error)
      }
      const status = response.status
      if (status !== 200) await response.body?.cancel().catch(() => undefined)
      if (status === 429 || status === 503) return { kind: 'response', response: rest(retryAfterMs(response.headers.get('Retry-After'), LOCAL_RPC_REST.maxMs)) }
      memory.restMs = 0
      if (status === 502 || status === 504 || (status >= 520 && status <= 530)) {
        markDown()
        throw new TypeError('local_rpc_down')
      }
      memory.downMs = 0
      if (status === 401 || status === 403 || status === 404) {
        memory.refusedUntil = now() + LOCAL_RPC_REFUSED_MS
        event('local_rpc_refused', { status })
        return { kind: 'response', response: reply502() }
      }
      if (status !== 200) return { kind: 'response', response: reply502() }
      let read: { text: string | null; bytes: number }
      try {
        read = await bodyWithin(response, limit)
      } catch (error) {
        if (timedOut || signal?.aborted) return failed(error)
        return { kind: 'response', response: reply502() }
      }
      return read.text === null ? { kind: 'oversize' } : { kind: 'text', text: read.text, bytes: read.bytes }
    } finally {
      clearTimeout(timer)
      cut?.removeEventListener('abort', timeUp)
      signal?.removeEventListener('abort', forward)
      spent.ms += Math.max(0, now() - started)
    }
  }

  /**
   * The chain id check, once per isolate (and per LOCAL_RPC_TRUST_MS); concurrent invocations share one. Under its own
   * time-out only: one caller dropping its read does not fail the others' check.
   */
  async function check(): Promise<Verdict> {
    let posted: Posted
    try {
      posted = await post(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'eth_chainId', params: [] }), null)
    } catch (error) {
      return { kind: 'throw', error }
    }
    if (posted.kind === 'response') return { kind: 'reply', status: posted.response.status, retryAfter: posted.response.headers.get('Retry-After') }
    if (posted.kind === 'oversize') return { kind: 'reply', status: 502, retryAfter: null }
    let value: unknown
    try {
      value = JSON.parse(posted.text)
    } catch {
      return { kind: 'reply', status: 502, retryAfter: null }
    }
    if (!isObject(value) || typeof value.result !== 'string') return { kind: 'reply', status: 502, retryAfter: null }
    if (value.result.toLowerCase() === CHAIN_ID_HEX) {
      memory.trustedUntil = now() + LOCAL_RPC_TRUST_MS
      return { kind: 'trusted' }
    }
    memory.wrongUntil = now() + LOCAL_RPC_TRUST_MS
    memory.trustedUntil = 0
    event('local_rpc_wrong_chain')
    return { kind: 'wrong' }
  }

  /** A check's whole life: its own time-out and as long again (at most two seconds more), after which it is taken as cut off. */
  const checkLife = timeoutMs + Math.min(CHECK_MARGIN_MS, timeoutMs)
  /**
   * A wide call's life, likewise: one time-out and a margin. The call itself ends within the time-out (fetchChain's `cut`,
   * round 4), so it settles, and gives its turn back, before its life is over; the life only frees a turn whose call was
   * cut off with its invocation and never settled.
   */
  const wideLife = checkLife

  /**
   * The check this invocation waits on: the one on its way when it is younger than its life, else a new one, handed to
   * the invocation's waitUntil and cleared from the isolate's slot by its own settling (never by this frame).
   */
  function checkFor(at: number): Checking {
    const running = memory.checking
    if (running && at - running.started <= checkLife) return running
    const entry: Checking = { verdict: check(), started: at }
    memory.checking = entry
    void entry.verdict.then(() => {
      if (memory.checking === entry) memory.checking = null
    })
    options.keepAlive?.(entry.verdict)
    return entry
  }

  /** null once the node is trusted; else what the chain code gets instead (a Response, or a thrown error). */
  async function trusted(): Promise<Response | null> {
    let verdict: Verdict | null = null
    // Waited on with a timer of this invocation's own: a check whose request was cut off before it settled is let go
    // once its life is over, and this invocation asks one of its own unless another found the node meanwhile (once; a
    // second that never settles is a time-out).
    for (let round = 0; verdict === null; round++) {
      if (memory.trustedUntil > now()) return null
      const entry = checkFor(now())
      const waited = await outlast(entry.verdict, entry.started + checkLife - now())
      if (waited) verdict = waited.value
      else {
        if (memory.checking === entry) memory.checking = null
        if (round > 0) verdict = { kind: 'throw', error: new DOMException('The node took too long', 'TimeoutError') }
      }
    }
    if (verdict.kind === 'trusted') return null
    if (verdict.kind === 'wrong') throw new TypeError('local_rpc_wrong_chain')
    if (verdict.kind === 'throw') throw verdict.error
    return new Response(null, { status: verdict.status, headers: verdict.retryAfter ? { 'Retry-After': verdict.retryAfter } : {} })
  }

  /**
   * A wide scan's turn (LOCAL_RPC_WIDE, rugged97's rule 1) for a call of `blocks` blocks: first the wide call before it in
   * this isolate, waited for up to waitMs; then its blocks from the bucket, waited for within what is left of waitMs. A
   * longer wait is a 429 that took nothing from the bucket, and its place in line passes on only once the call before it
   * has ended, so two wide calls never run at once. Never stuck: a wide call older than its life no longer counts. The
   * release to call once the call has ended, or the 429.
   *
   * Changed on purpose 2026-10-02 (review of the rules, finding 13): the bucket was taken first, so a turn then refused for
   * the call before it had still used its slot, and its place was let go at once, so the next ran beside that call.
   */
  async function wideTurn(blocks: number, signal: AbortSignal | null | undefined): Promise<(() => void) | Response> {
    const started = now()
    const before = memory.wideBusy
    let settle = () => {}
    const mine = { done: new Promise<void>((done) => (settle = done)), started }
    memory.wideBusy = mine
    const release = () => {
      settle()
      if (memory.wideBusy === mine) memory.wideBusy = null
    }
    const running = before !== null && started - before.started < wideLife
    if (running && !(await outlast(before.done, LOCAL_RPC_WIDE.waitMs))) {
      // Refused while the call before it still runs: the one after it waits for that call, not for this refusal.
      void outlast(before.done, Math.max(0, before.started + wideLife - now())).then(release, release)
      return reply429(LOCAL_RPC_WIDE.waitMs / 1000)
    }
    // The bucket (GCRA, in blocks): a call may go once the burst holds its blocks, or, wider than the burst, once it is
    // full; it then owes the rest.
    const perMs = LOCAL_RPC_WIDE.blocksPerSecond / 1000
    const at = now()
    const tat = Math.max(memory.wideTat, at)
    const wait = Math.max(0, tat - at - Math.max(0, LOCAL_RPC_WIDE.burstBlocks - blocks) / perMs)
    if (wait > LOCAL_RPC_WIDE.waitMs - (at - started)) {
      release()
      return reply429(wait / 1000)
    }
    memory.wideTat = tat + blocks / perMs
    if (wait > 0) await sleep(wait)
    if (signal?.aborted) {
      release()
      throw signal.reason ?? new DOMException('The read was dropped', 'AbortError')
    }
    return release
  }

  /** The node's text for one POST of `sent` (internal ids), checked: one reply per id, each a result or an error. */
  function repliesOf(text: string, sent: readonly number[], batch: boolean): Map<number, Reply> | null {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return null
    }
    if (Array.isArray(value) !== batch) return null
    const all: unknown[] = batch ? (value as unknown[]) : [value]
    if (all.length !== sent.length) return null
    const out = new Map<number, Reply>()
    for (const envelope of all) {
      if (!isObject(envelope)) return null
      const id = envelope.id
      if (typeof id !== 'number' || !sent.includes(id) || out.has(id)) return null
      if (envelope.error !== undefined && envelope.error !== null) out.set(id, { error: trimmedError(envelope.error) })
      else if ('result' in envelope) out.set(id, { result: envelope.result })
      else return null
    }
    return out
  }

  async function fetchChain(input: string, init: RequestInit): Promise<Response> {
    if (input !== RPC_URL) throw new TypeError('not the chain RPC')
    const { envelopes, batch } = envelopesOf(init.body, purpose)
    const signal = init.signal
    // 2026-10-02 (review finding 11): how much of the reply the caller reads. The node is read no further than that
    // (with REPLY_SLACK_BYTES per call for the envelopes the join drops); past it nothing more is read or sent.
    const callerLimit = replyLimitOf(init)
    let readBytes = 0
    let sentItems = 0
    // Every logical call becomes its node calls: a log range wider than one call serves, in windows, oldest first. No log is
    // read below LOCAL_RPC_LOG_FLOOR (rugged97's rule 3): a range that starts below it starts there, and one that ends below
    // it is answered empty with no call at all.
    const items: Item[] = []
    const empty = new Set<number>()
    for (const [logical, envelope] of envelopes.entries()) {
      const logs = envelope.method === 'eth_getLogs'
      const asked = logs ? logFilter(envelope.params) : null
      if (asked && asked.to < LOCAL_RPC_LOG_FLOOR) {
        empty.add(logical)
        continue
      }
      const range = asked && { ...asked, from: Math.max(asked.from, LOCAL_RPC_LOG_FLOOR) }
      if (asked && range && (range.from !== asked.from || range.to - range.from + 1 > LOCAL_RPC_LOG_BLOCKS)) {
        for (let lo = range.from; lo <= range.to; lo += LOCAL_RPC_LOG_BLOCKS) {
          const hi = Math.min(range.to, lo + LOCAL_RPC_LOG_BLOCKS - 1)
          const params = [{ ...range.filter, fromBlock: hex(lo), toBlock: hex(hi) }]
          items.push({ logical, logs, method: envelope.method, params, bytes: JSON.stringify(params).length + 64, span: hi - lo + 1 })
        }
      } else {
        items.push({ logical, logs, method: envelope.method, params: envelope.params, bytes: JSON.stringify(envelope.params).length + 64, span: range ? range.to - range.from + 1 : 0 })
      }
    }
    if (items.some((item) => item.bytes + 2 > LOCAL_RPC_REQUEST_BYTES)) throw refusedBody()
    if (signal?.aborted) throw signal.reason ?? new DOMException('The read was dropped', 'AbortError')
    // 2026-10-02 (review of the rules, finding 3): a window this invocation's node already answered is not asked again,
    // so the chain code's paced retry after a 429 asks only what is still missing.
    const replies: Array<Reply | undefined> = items.map((item) => (item.logs ? answered.get(windowKey(item)) : undefined))
    const missing = items.filter((_, id) => replies[id] === undefined)
    // Nothing to ask the node (every log range below the floor, or answered already): no reserve, no check, no POST.
    if (missing.length > 0) {
      // The visitor's bill holds no reserve for this question: answered from the cache alone (LocalRpcOptions.reserve).
      if (options.reserve && !options.reserve()) {
        refusals += 1
        throw new TypeError('local_rpc_visitor_spent')
      }

      const refusal = await trusted()
      if (refusal) return refusal
      if (signal?.aborted) throw signal.reason ?? new DOMException('The read was dropped', 'AbortError')
    }

    // A wide scan (rugged97's rule 1) waits for its turn once, for every window it still needs, before its first POST: a
    // turn refused has cost the node nothing. Changed on purpose 2026-10-02 (review of the rules, findings 3 and 13): it
    // was a turn per POST, so a later POST's refusal threw away what the earlier ones had cost the node.
    const blocks = missing.reduce((sum, item) => sum + item.span, 0)
    const waitedFrom = now()
    const turn = blocks > LOCAL_RPC_WIDE.blocks ? await wideTurn(blocks, signal) : null
    if (turn instanceof Response) return turn
    // A wide call's own time-out (review of the rules, round 4: a call of several POSTs, each with its own time-out, could
    // outlive its turn's life and the site gate's lease, and a second wide scan then started beside it): one time-out from
    // its turn's start for all its waits and POSTs, so it settles, and gives back its turn and its lease, while both hold
    // (wideLife; bridge/src/wide-gate-worker.mjs SITE_WIDE.leaseMs). A POST it cuts is our time-out: the isolate rests.
    const cut = turn ? new AbortController() : null
    const cutTimer = cut ? setTimeout(() => cut.abort(tookTooLong()), Math.max(0, waitedFrom + timeoutMs - now())) : undefined
    let site: (() => void) | null = null
    const failedLogical = new Set<number>()
    try {
      // And the site's turn (rule 1 is for the whole site): the gate every isolate asks, when the deployment binds it
      // (wideGate.ts), within what is left of the wait; refused, nothing is sent.
      if (turn && options.siteGate) {
        const granted = await options.siteGate.take(blocks, LOCAL_RPC_WIDE.waitMs - (now() - waitedFrom))
        if ('retryAfterMs' in granted) return reply429(granted.retryAfterMs / 1000)
        site = granted.release
        if (granted.waitMs > 0) await sleep(granted.waitMs)
        if (signal?.aborted) throw signal.reason ?? new DOMException('The read was dropped', 'AbortError')
        if (cut?.signal.aborted) throw tookTooLong()
      }
      let next = 0
      while (next < items.length) {
        // The next POST: up to LOCAL_RPC_BATCH_ITEMS calls and LOCAL_RPC_REQUEST_BYTES, past the calls of a failed log read
        // and the windows answered already.
        const sent: number[] = []
        let bytes = 2
        while (next < items.length && sent.length < LOCAL_RPC_BATCH_ITEMS) {
          if (failedLogical.has(items[next].logical) || replies[next] !== undefined) {
            next += 1
            continue
          }
          if (sent.length > 0 && bytes + items[next].bytes > LOCAL_RPC_REQUEST_BYTES) break
          bytes += items[next].bytes
          sent.push(next)
          next += 1
        }
        if (sent.length === 0) break
        const one = sent.length === 1
        const payload = sent.map((id) => ({ jsonrpc: '2.0', id, method: items[id].method, params: items[id].params }))
        spent.items += sent.length
        sentItems += sent.length
        const allowed = callerLimit === null ? LOCAL_RPC_REPLY_BYTES : Math.min(LOCAL_RPC_REPLY_BYTES, callerLimit + REPLY_SLACK_BYTES * sentItems - readBytes)
        const posted = await post(JSON.stringify(one ? payload[0] : payload), signal, Math.max(0, allowed), cut?.signal ?? null)
        if (posted.kind === 'response') return posted.response
        // Past the caller's own limit (not the transport's): what it would have cut, it gets cut, and nothing more is asked.
        if (posted.kind === 'oversize' && allowed < LOCAL_RPC_REPLY_BYTES) return replyCut()
        if (posted.kind === 'oversize') {
          // A reply past the cap: a log read has its range refused as too large (the chain code splits it); anything else stops.
          if (sent.some((id) => !items[id].logs)) return reply502()
          for (const id of sent) {
            replies[id] = { error: { code: -32005, message: 'response size exceeded' } }
            failedLogical.add(items[id].logical)
          }
          continue
        }
        readBytes += posted.bytes
        const got = repliesOf(posted.text, sent, !one)
        if (!got) return reply502()
        // The node's own time-out (-32002, rugged97's rule 7): the call cost it 30 s of work, so it is never split and asked
        // again; every POST of the isolate rests for the longest rest, and the chain code waits it out as a 429.
        if (sent.some((id) => { const reply = got.get(id); return !!reply && 'error' in reply && reply.error.code === NODE_TIMEOUT })) return rest(LOCAL_RPC_REST.maxMs)
        for (const id of sent) {
          const reply = got.get(id) as Reply
          replies[id] = reply
          if ('error' in reply) failedLogical.add(items[id].logical)
          else if (items[id].logs) answered.set(windowKey(items[id]), reply)
        }
      }
    } finally {
      clearTimeout(cutTimer)
      site?.()
      turn?.()
    }

    // One answer per logical call, under the caller's id: a log read's windows joined in block order, or its first error.
    const byLogical: number[][] = envelopes.map(() => [])
    items.forEach((item, id) => byLogical[item.logical].push(id))
    const answers = envelopes.map((envelope, logical): string => {
      if (empty.has(logical)) return JSON.stringify({ jsonrpc: '2.0', id: envelope.id, result: [] })
      const own = byLogical[logical]
      const failure = own.map((id) => replies[id]).find((reply): reply is { error: { code: number; message: string } } => !!reply && 'error' in reply)
      if (failure) return JSON.stringify({ jsonrpc: '2.0', id: envelope.id, error: failure.error })
      if (!items[own[0]].logs) return JSON.stringify({ jsonrpc: '2.0', id: envelope.id, result: (replies[own[0]] as { result: unknown }).result })
      const logs: unknown[] = []
      for (const id of own) {
        const reply = replies[id] as { result: unknown } | undefined
        if (!reply || !Array.isArray(reply.result)) return ''
        logs.push(...(reply.result as unknown[]))
      }
      const text = JSON.stringify({ jsonrpc: '2.0', id: envelope.id, result: logs })
      return text.length > LOCAL_RPC_REPLY_BYTES ? JSON.stringify({ jsonrpc: '2.0', id: envelope.id, error: { code: -32005, message: 'response size exceeded' } }) : text
    })
    if (answers.some((text) => text === '')) return reply502()
    return new Response(batch ? `[${answers.join(',')}]` : answers[0], { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  return {
    fetch: fetchChain,
    spent: () => ({ ...spent }),
    health,
    refused: () => refusals > 0,
  }
}
