/**
 * Domino's own chain routes (RPC-SPEC §2.4–2.5; the owner's rule of 2026-10-01: the site reads nothing from a public
 * RPC). Fixed same-origin POSTs, each with one purpose, answered by the site's Pages Functions from Domino's own
 * Robinhood Chain node (functions/_lib/localRpc.ts, the Pages secret LOCAL_RPC_URL), with the chain code the page ran
 * until now (owned.ts, walletPositions.ts, fees.ts, automation.ts), the fees ledger and the record and simulation reads:
 *
 *   POST /api/owned/v2/positions     a wallet's Domino positions, held deposits, features and mint blocks
 *   POST /api/fees/v1/state          up to 8 positions at one block
 *   POST /api/fees/v2/ledger         up to 8 positions' own ledgers of settlements (feesLedger.ts)
 *   POST /api/automation/v1/state    plain, Auto-compound or Domino-compound; paused or active
 *   POST /api/automation/v1/record   an automation vault's executions and its payments
 *   POST /api/chain/v1/simulate      eth_simulateV1 for a wallet without it, behind LOCAL_RPC_SIMULATE (on)
 *   POST /api/chain/v1/confirmation a transaction's canonical receipt or the finalized block
 *
 * Each route file is one line over answerChainRoute. The beta gate runs first (functions/_middleware.ts): a request
 * without the access cookie never arrives, and an admitted one arrives with no cookie at all. Then, in order: the
 * method, the origin, the content type, the body's size and exact shape; the visitor's rate (per isolate, by a salted
 * digest of the address Cloudflare names, never the address itself); the node's secret (none, or not the node's exact
 * shape: a calm 503 at once, nothing read); the edge cache and the questions in flight; and only then the node, through
 * a transport made for this one invocation. A source that is away (the wrong chain, a refused token, the node out of
 * reach) is the same calm 503. One log line per invocation names the route, the outcome and what the node cost (and,
 * since 2026-10-02, a ledger answer's verdicts as fixed codes and counts; since 2026-10-14, a refusal's limit, which the
 * answer's Server-Timing names too: Limiter); never the visitor, the address, the ids, the body or the node.
 */
import { answerOwnerAsked, bodyWithin, ownerFrom, refuse, type AnswerCache, type EdgeDeps, type OwnedDeps, type OwnerScan } from './owned'
import { scanWallet } from './walletPositions'
import { idsFrom, scanAutomation } from './automation'
import { STATE_BODY_BYTES, bodyOf, resetRelayMemory, stateAnswer, stateRequestOf, type FeesRuntime } from './fees'
import { LEDGER_BODY_BYTES, ledgerAnswer, ledgerHintKey, ledgerRequestOf } from './feesLedger'
import { EDGE_LOG_LIMITS, createLocalRpc, localRpcEndpoint, localRpcMemory, resetLocalRpcMemory, type LocalRpc, type LocalRpcMemory, type TransportLimit } from './localRpc'
import { resetMintWalks, walkMints } from './ownedMints'
import { SHARED_STALE_MS, outlast } from './sharedWork'
import { RECORD_BODY_BYTES, recordAnswer, recordRequestOf } from './vaultRecord'
import { SIMULATE_BODY_BYTES, simulateEnabled, simulateOnNode, simulateRequestOf } from './simulate'
import { CONFIRMATION_CHAINS, confirmationMemory, confirmationOnNode, confirmationRequestOf, notServed, secondShape, type ConfirmationMemory } from './confirmation'
import { resetSiteGate, siteGateOf } from './wideGate'
import type { AutomationAnswer } from '../../src/lib/automationState'
import type { LedgerWhy } from '../../src/lib/fees/types'

export interface ChainRouteEnv {
  LOCAL_RPC_URL?: string
  LOCAL_RPC_SIMULATE?: string
  /**
   * The site-wide gate of wide log scans (2026-10-02, review of rugged97's rules, finding 2): a Durable Object binding to
   * the Worker domino-wide-gate (bridge/src/wide-gate-worker.mjs), which the owner deploys and binds (RPC-SPEC §11.5).
   * Without it, each isolate's own pace alone (localRpc.ts LOCAL_RPC_WIDE).
   */
  WIDE_GATE?: unknown
}
export interface ChainRouteContext {
  request: Request
  env: ChainRouteEnv
  waitUntil?: (work: Promise<unknown>) => void
}
export type ChainRouteName = 'owned' | 'state' | 'ledger' | 'automation' | 'record' | 'simulate' | 'confirmation'
export interface ChainRouteRuntime {
  upstream?: (url: string, init: RequestInit) => Promise<Response> // tests: the fake node
  cache?: AnswerCache | null // default caches.default
  now?: () => number
  /** Tests: the transport's wait for its bucket (setTimeout otherwise). */
  sleep?: (ms: number) => Promise<void>
  /** Tests: an isolate of their own (chainRouteMemory()); the isolate's otherwise. */
  memory?: ChainRouteMemory
  /** Where the log lines go (console.log otherwise). */
  log?: (line: string) => void
  /** Tests: how long an owned answer waits for its mint walk (ownedMints.ts MINT_WALK_WAIT_MS otherwise). */
  mintWaitMs?: number
}

/**
 * The visitor classes (RPC-SPEC §2.4): a burst, and how many a minute refill it. Changed on purpose 2026-10-02 (rugged97's
 * answer to Q3: the site's own token allows 1,000 requests a second for the whole site, and a visitor is a network, so
 * several people behind one carrier's address, common on Brazilian mobile networks, share one): about five times what
 * they were. A cache hit counts here too and costs the node nothing; what a visitor may cost the node is VISITOR_NODE.
 *
 * Changed on purpose 2026-10-14 (incident C4, the 429 on the confirmation route of 2026-10-13): one class more, `confirm`,
 * for that route's second shape (a burst of 30, 90 a minute). Its first shape, which tabs opened before the deploy still
 * send every few seconds, stays in `state` (CLASS_OF), so those tabs cannot starve the new client, and neither shares the
 * new client's turns with the page's own figures (/api/fees/v1/state, /api/automation/v1/state). The four classes that
 * were here are what they were, and so is VISITOR_NODE: what a visitor may cost the node did not grow.
 * Release order (C4 review, 2026-10-14): `confirm` is sized for the page after incident package C3, whose screens stop
 * asking at inclusion and whose wait for inclusion never locks on a refused read. Before C3 a done screen asks every
 * 1.5 s until the block is final (about 16 minutes on Robinhood Chain), two or three of them behind one address spend
 * this class, and a refused read locks the step. So this ships with C3 or after it, never alone; it is not enlarged.
 */
export const VISITOR_CLASSES = Object.freeze({
  owned: { burst: 30, perMinute: 60 },
  state: { burst: 60, perMinute: 240 },
  history: { burst: 240, perMinute: 1200 },
  simulate: { burst: 6, perMinute: 12 },
  confirm: { burst: 30, perMinute: 90 },
} as const)
export const CLASS_OF: Readonly<Record<ChainRouteName, keyof typeof VISITOR_CLASSES>> = Object.freeze({ owned: 'owned', state: 'state', automation: 'state', ledger: 'history', record: 'history', simulate: 'simulate', confirmation: 'state' })
/**
 * What refused a question (2026-10-14, incident C4). Pages Functions logs are read by a live tail only, so the evidence
 * travels in the answer itself, as `limit;desc="…"` in Server-Timing, and in the log line's `limiter`. The four limits
 * that can refuse any route:
 *   class  the visitor's questions of this class (VISITOR_CLASSES)
 *   bill   the visitor's share of the node (VISITOR_NODE)
 *   rest   the isolate resting after the node's 429/503 or a time-out (localRpc.ts LOCAL_RPC_REST)
 *   pace   the isolate's own pace of POSTs (localRpc.ts LOCAL_RPC_RATE)
 * and, so that no refusal is left unnamed or given a name that is not its own:
 *   wide   a wide log scan's turn, the isolate's or the site's (localRpc.ts LOCAL_RPC_WIDE)
 *   node   no limit of ours: the node's own JSON-RPC error in a 200 reply, which the chain code read as "busy"
 *   kept   no limit met by this question: a refusal another question met moments ago, kept at the edge or shared in flight
 */
export type Limiter = 'class' | 'bill' | TransportLimit | 'node' | 'kept'
/**
 * What a visitor's questions may cost the node, across every route (2026-10-02, review finding 5: the classes count
 * questions, and one question may cost the node up to LOCAL_RPC_POSTS_PER_INVOCATION POSTs, so one visitor could keep
 * the isolate's whole node budget, LOCAL_RPC_RATE, for itself): a burst of 240 POSTs, refilled at 480 a minute (8 a
 * second, a sixth of the isolate's 50), and a reserve of 8, so a full bill has at most 30 reads at the node at once.
 *
 * Changed on purpose 2026-10-02 (rugged97's answer to Q3, the site's token allows 1,000 requests a second): it was a
 * burst of 120, 120 a minute and a reserve of 15 (8 reads at once), sized for a limit of 25 a second per address. Several
 * people behind one carrier's address now open their pages cold at once without waiting on one another.
 *
 * Changed on purpose 2026-10-02 (RPC fix round 2: the bill was checked before the edge cache, so a spent visitor's cache
 * hits were refused too; and its 'running' slots, freed only by the question's own frame, leaked when a visitor who had
 * joined another's read left). A question without enough of the bill is answered from the edge's cache alone
 * (localRpc.ts reserve): a cache hit, or a read already on its way, is answered as for anyone, and only a read that
 * would reach the node is a 429 with the wait until the bill is back. Such a question keeps nothing in the cache, and
 * no question that joined its read takes its refusal (shared), so one visitor's spent bill never reaches another's.
 *
 * Changed on purpose 2026-10-02 (RPC fix round 2.1: with the bill read once per question and charged only as POSTs went,
 * questions started together all saw a full bill, so one visitor could hold some 146 at the node at once and keep the
 * isolate's pace from everyone else): each question pays `reserve` POSTs of the bill, so a full bill has at most
 * burst / reserve at the node at once (8 then, as the old slots did), with nothing held for good. Past its reserve, each POST
 * is billed as it goes (localRpc.ts onPost) and owed in full.
 *
 * Changed on purpose 2026-10-02 (RPC fix round 2.2: the reserve was paid at the door, so a cache hit or a join paid it
 * while it waited, and one address shared by many people, or one slow popular read, got cold reads refused while the node
 * did nothing): a question takes its reserve only when it starts a node read of its own, at its first call to the node
 * (nodeBill, localRpc.ts reserve), after the cache missed and with no read on its way to join. Cache hits and joiners
 * hold nothing. What it did not use is given back once all of its node work has ended, its read and a mint walk going
 * on after the answer included, chained into waitUntil so a visitor who leaves cannot skip it.
 */
export const VISITOR_NODE = Object.freeze({ burst: 240, perMinute: 480, reserve: 8 } as const)
const NODE_RATE = VISITOR_NODE.perMinute / 60_000
/**
 * The most visitors one isolate remembers; the least recently seen go first. A node bill is remembered only while it is
 * below a full burst (a reserve held, or POSTs owed; one back to full is forgotten), and the refill pays back what a
 * visitor's questions can owe within a few minutes of its last POST; so forgetting one that still owes takes 5,000 other
 * networks reading the node in that time, which already have 5,000 bursts of their own (the isolate's pace,
 * localRpc.ts LOCAL_RPC_RATE, bounds them all together).
 */
export const MAX_VISITORS = 5_000
/** How long the browser is told to wait when the node's secret is missing, and when the node is away. */
export const SOURCE_OFF_RETRY_SECONDS = 300
export const SOURCE_AWAY_RETRY_SECONDS = 60
/**
 * (2026-10-30, launch capacity study, item 7) The wait when the node is merely out of reach for this isolate (localRpc.ts
 * LOCAL_RPC_DOWN): what is left of its window, within these bounds. It was SOURCE_AWAY_RETRY_SECONDS, a minute that
 * outlasted the window several times over. Another chain or a refused token still waits SOURCE_AWAY_RETRY_SECONDS.
 */
export const SOURCE_DOWN_RETRY_SECONDS = { min: 5, max: 15 } as const
/** automation/v1/state: an answer is kept this long per set of ids, a failure FAILURE_SECONDS. */
export const AUTOMATION_SECONDS = 15
export const AUTOMATION_FAILURE_SECONDS = 5
const AUTOMATION_BODY_BYTES = 8192

/** One finished answer, as the questions that shared it each get it again. */
interface Done {
  status: number
  headers: [string, string][]
  text: string
}
const doneOf = async (response: Response): Promise<Done> => ({ status: response.status, headers: [...response.headers], text: await response.text() })

/** What one isolate keeps between invocations: its salt, its visitors, the reads in flight and its view of the node. */
export interface ChainRouteMemory {
  salt: string | null
  visitors: Map<string, { tokens: number; at: number }>
  /** Per visitor whose bill is below a full burst (VISITOR_NODE): its POSTs left (below zero: owed), as of `at`. */
  nodes: Map<string, { tokens: number; at: number }>
  inflight: Map<string, Inflight>
  told: Set<string>
  node: LocalRpcMemory
  /** The confirmation route's own (confirmation.ts): the refresh of the finalized block on its way. */
  confirmation: ConfirmationMemory
}

/**
 * A read the questions of one key share: its answer, the questions' own signals, when it began (sharedWork.ts), and
 * whether its own question was refused the node for its visitor's bill (then no joiner takes its answer). `limited`
 * (2026-10-14): the limit its own question's transport met, so a joiner's refusal names it too.
 */
interface Inflight {
  done: Promise<Done>
  signals: AbortSignal[]
  started: number
  refused: () => boolean
  limited: () => TransportLimit | null
}

export const chainRouteMemory = (): ChainRouteMemory => ({ salt: null, visitors: new Map(), nodes: new Map(), inflight: new Map(), told: new Set(), node: localRpcMemory(), confirmation: confirmationMemory() })

let isolate: ChainRouteMemory | null = null

/** Tests: forget the isolate's visitors, its reads in flight, its view of the node and the chain code's module memory. */
export function resetChainRouteMemory(): void {
  isolate = null
  resetLocalRpcMemory()
  resetRelayMemory()
  resetMintWalks()
  resetSiteGate()
}

const JSON_TYPE = 'application/json; charset=utf-8'
/** The routes whose errors are {"error"} (as owned.ts and automation.ts always answered); the others' are {"v":1,"error"}. */
const PLAIN: ReadonlySet<ChainRouteName> = new Set(['owned', 'automation'])

type Outcome = 'answer' | 'busy' | 'unavailable' | 'source_off' | 'bad_request' | 'limited'
type CacheTag = 'hit' | 'miss' | 'coalesced' | 'none'

/** One log line: the service, then fixed codes and numbers only (never the visitor, the address, the ids, the body or the node). */
function logLine(runtime: ChainRouteRuntime, fields: Record<string, string | number>): void {
  const line = JSON.stringify({ service: 'chain-routes', ...fields })
  if (runtime.log) runtime.log(line)
  else console.log(line)
}

/** An error of `name`'s shape: {"error"} for the plain routes, {"v":1,"error"} for the others. */
function failed(name: ChainRouteName, code: string, status: number, retryAfterSeconds = 0): Response {
  const headers: Record<string, string> = retryAfterSeconds > 0 ? { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) } : {}
  if (PLAIN.has(name)) return refuse(code, status, headers)
  return new Response(JSON.stringify({ v: 1, error: code }), { status, headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': 'no-store', ...headers } })
}

async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The Workers cache where the runtime has one (the repo compiles functions/ with the DOM lib and no workers types). */
function defaultCache(): AnswerCache | null {
  const storage = (globalThis as unknown as { caches?: { default?: AnswerCache } }).caches
  return storage?.default ?? null
}

/**
 * The network a visitor's address stands for (2026-10-02, review finding 5): an IPv4 address itself; an IPv6 address its
 * /48. An IPv4 address written as IPv6 (::ffff:a.b.c.d) is that IPv4 address. Lowercase; anything else as given.
 *
 * Changed on purpose 2026-10-02 (RPC fix round 2): it was the /64, but a subscriber is routinely delegated a /56 (256
 * /64s) or a /48 (65,536), and a cloud host hands out /48s, so changing /64 gave one client fresh bursts without end. A
 * /48 is coarse on purpose: the limiter is per network, not per person (as an IPv4 address behind a carrier's NAT is),
 * and the isolate's own pace (localRpc.ts LOCAL_RPC_RATE) is what bounds the node whatever the addresses.
 */
export function visitorNetwork(address: string): string {
  const raw = address.trim().toLowerCase()
  if (!raw.includes(':')) return raw
  const mapped = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw)
  if (mapped) return mapped[1]
  const halves = raw.split('::')
  if (halves.length > 2) return raw
  // An IPv4 tail ("…:1.2.3.4") holds two groups.
  const groups = (part: string) => (part === '' ? [] : part.split(':').flatMap((group) => (group.includes('.') ? ['0', '0'] : [group])))
  const left = groups(halves[0])
  const right = halves.length === 2 ? groups(halves[1]) : []
  const all = halves.length === 2 ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left
  if (all.length < 3 || !all.slice(0, 3).every((group) => /^[0-9a-f]{1,4}$/.test(group))) return raw
  return `${all
    .slice(0, 3)
    .map((group) => group.replace(/^0+(?=[0-9a-f])/, ''))
    .join(':')}::/48`
}

/** The visitor's key in this isolate: a salted digest of its network (visitorNetwork), never the address; null without one. */
async function visitorOf(memory: ChainRouteMemory, request: Request): Promise<string | null> {
  const address = request.headers.get('CF-Connecting-IP')
  if (address === null) return null
  if (memory.salt === null) memory.salt = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
  return (await digest(`${memory.salt}${visitorNetwork(address)}`)).slice(0, 16)
}

/** Keeps at most MAX_VISITORS entries in `map`, the oldest going first. */
function bounded(map: Map<string, unknown>): void {
  while (map.size > MAX_VISITORS) map.delete(map.keys().next().value as string)
}

/**
 * The visitor's turn in `cls`: 0 when admitted (a token taken), else the milliseconds until one is free. A request
 * without CF-Connecting-IP (a local server, a test) is not limited, as the gate's login limiter does.
 */
function admitted(memory: ChainRouteMemory, visitor: string | null, cls: keyof typeof VISITOR_CLASSES, now: number): number {
  if (visitor === null) return 0
  const key = `${cls}|${visitor}`
  const { burst, perMinute } = VISITOR_CLASSES[cls]
  const rate = perMinute / 60_000
  const kept = memory.visitors.get(key)
  const tokens = kept ? Math.min(burst, kept.tokens + Math.max(0, now - kept.at) * rate) : burst
  memory.visitors.delete(key)
  const admit = tokens >= 1
  memory.visitors.set(key, { tokens: admit ? tokens - 1 : tokens, at: now })
  bounded(memory.visitors)
  return admit ? 0 : Math.ceil((1 - tokens) / rate)
}

/** The visitor's node POSTs left at `now` (VISITOR_NODE): a full burst for one not remembered; below `reserve`, cache only. */
function nodeLeft(memory: ChainRouteMemory, visitor: string, now: number): number {
  const kept = memory.nodes.get(visitor)
  return kept ? Math.min(VISITOR_NODE.burst, kept.tokens + Math.max(0, now - kept.at) * NODE_RATE) : VISITOR_NODE.burst
}

/** The visitor's bill set to `tokens` POSTs left at `now`; one back to a full burst is forgotten (a stranger's is full). */
function nodeBilled(memory: ChainRouteMemory, visitor: string, tokens: number, now: number): void {
  memory.nodes.delete(visitor)
  if (tokens >= VISITOR_NODE.burst) return
  memory.nodes.set(visitor, { tokens, at: now })
  bounded(memory.nodes)
}

/**
 * One question's share of the node (RPC fix round 2.2). `reserve` is asked by the transport (localRpc.ts) before every
 * call that would reach the node. The first charges VISITOR_NODE.reserve POSTs at once, with no await between looking
 * at the bill and charging it, so reads that start together each see the reserves of the ones before, and a full bill
 * has at most burst / reserve reads at the node. With less than a reserve left it says false, then and for the rest of
 * the question. A question answered from the cache, or by a read it joined, never asks, so it never pays. `onPost`
 * bills each POST past the reserve as it goes, owed in full (no floor: a question makes at most
 * LOCAL_RPC_POSTS_PER_INVOCATION, and none starts while the bill is below the reserve). `settle` gives back the part of
 * the reserve the question did not use, once; a POST after it is billed one by one.
 */
function nodeBill(memory: ChainRouteMemory, visitor: string, now: () => number): { reserve: () => boolean; onPost: () => void; settle: () => void } {
  let state: 'none' | 'held' | 'refused' = 'none'
  let prepaid = 0
  return {
    reserve: () => {
      if (state === 'none') {
        const left = nodeLeft(memory, visitor, now())
        state = left < VISITOR_NODE.reserve ? 'refused' : 'held'
        if (state === 'held') {
          prepaid = VISITOR_NODE.reserve
          nodeBilled(memory, visitor, left - prepaid, now())
        }
      }
      return state === 'held'
    },
    onPost: () => {
      if (prepaid > 0) prepaid -= 1
      else nodeBilled(memory, visitor, nodeLeft(memory, visitor, now()) - 1, now())
    },
    settle: () => {
      if (prepaid > 0) nodeBilled(memory, visitor, nodeLeft(memory, visitor, now()) + prepaid, now())
      prepaid = 0
    },
  }
}

/**
 * `work`'s answer, shared by every question of `key` in this isolate while it runs (each gets its own copy). `signal`
 * joins the question's own drop to the shared read's: it is cancelled only once every question was dropped.
 *
 * 2026-10-02 (review finding 3, sharedWork.ts): the read is handed to the first question's waitUntil (`keepAlive`), so it
 * goes on when that visitor leaves, and it clears its own slot when it settles. A read older than SHARED_STALE_MS is
 * never joined, and a question that joins one waits for it no longer than that, on a timer of its own.
 *
 * Changed on purpose 2026-10-02 (RPC fix round 2.2): a joiner whose wait ran out, or whose read was refused the node for
 * its own question's visitor (`refused`, that question's localRpc.ts refused()), looks at the slot again instead of
 * reading at once. The first to find it empty reads, and the others join that read: joiners whose waits end together make
 * one read, not one each, and a visitor whose bill is spent never hands its refusal to anyone (it replaces `solo`).
 */
async function shared(memory: ChainRouteMemory, key: string, signal: AbortSignal | null, work: (cancelled: () => boolean) => Promise<Response>, now: () => number, keepAlive: ((work: Promise<unknown>) => void) | undefined, refused: () => boolean, limited: () => TransportLimit | null): Promise<{ done: Done; joined: boolean; limited: TransportLimit | null }> {
  for (let running = memory.inflight.get(key); running && now() - running.started <= SHARED_STALE_MS; running = memory.inflight.get(key)) {
    if (signal) running.signals.push(signal)
    const joined = await outlast(running.done, running.started + SHARED_STALE_MS - now())
    if (joined && !running.refused()) return { done: joined.value, joined: true, limited: running.limited() }
    if (memory.inflight.get(key) === running) memory.inflight.delete(key)
  }
  const entry: Inflight = { done: Promise.resolve({ status: 0, headers: [], text: '' }), signals: signal ? [signal] : [], started: now(), refused, limited }
  const cancelled = () => entry.signals.length > 0 && entry.signals.every((one) => one.aborted)
  entry.done = work(cancelled).then(doneOf)
  memory.inflight.set(key, entry)
  const clear = () => {
    if (memory.inflight.get(key) === entry) memory.inflight.delete(key)
  }
  void entry.done.then(clear, clear)
  keepAlive?.(entry.done.catch(() => undefined))
  return { done: await entry.done, joined: false, limited: limited() }
}

/** A plain route's body ({"tokenIds": …}), checked as automation.ts always checked it, or the refusal. */
async function plainBody(request: Request, url: URL, maxBytes: number): Promise<unknown | Response> {
  if (request.method !== 'POST') return refuse('method_not_allowed', 405, { Allow: 'POST' })
  const origin = request.headers.get('Origin')
  const site = request.headers.get('Sec-Fetch-Site')
  if ((origin !== null && origin !== url.origin) || (site !== null && site !== 'same-origin')) return refuse('origin_not_allowed', 403)
  if (!(request.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json')) return refuse('json_required', 415)
  if (Number(request.headers.get('Content-Length') ?? '0') > maxBytes) return refuse('request_too_large', 413)
  // 2026-10-02 (review finding 6): read no further than the limit, whatever Content-Length said (a chunked body has none).
  let text: string | null
  try {
    text = (await bodyWithin(request, maxBytes)).text
  } catch {
    return refuse('invalid_request', 400)
  }
  if (text === null) return refuse('request_too_large', 413)
  try {
    return JSON.parse(text) as unknown
  } catch {
    return refuse('invalid_request', 400)
  }
}

/** An automation answer kept for the same ids, in the order this question asked them; null when it does not hold them. */
function reordered(text: string, ids: readonly bigint[]): string | null {
  try {
    const kept = JSON.parse(text) as AutomationAnswer
    const byId = new Map(kept.positions.map((entry) => [entry.tokenId, entry]))
    const positions = ids.map((id) => byId.get(id.toString()))
    return positions.some((entry) => !entry) ? null : JSON.stringify({ block: kept.block, positions })
  } catch {
    return null
  }
}

const STORED_AT = 'X-Automation-Stored-At'
const OUTCOME = 'X-Automation-Outcome'

/**
 * POST /api/automation/v1/state's read: per set of ids, an answer kept AUTOMATION_SECONDS and a failure
 * AUTOMATION_FAILURE_SECONDS; a rate-limited chain is chain_busy (RPC-SPEC §2.5.4), anything else chain_unavailable.
 */
async function automationAnswer(url: URL, ids: readonly bigint[], deps: OwnedDeps, cache: AnswerCache | null, waitUntil?: (work: Promise<unknown>) => void): Promise<Response> {
  const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const key = cache ? new Request(`${url.origin}/api/automation/v1/cache/${await digest(`automation/v1|${sorted.join(',')}`)}`) : null
  if (cache && key) {
    const kept = await cache.match(key).catch(() => undefined)
    const at = Number(kept?.headers.get(STORED_AT))
    if (kept && Number.isSafeInteger(at)) {
      const age = Math.max(0, deps.now() - at)
      const outcome = kept.headers.get(OUTCOME)
      if (outcome === 'answer' && age < AUTOMATION_SECONDS * 1000) {
        const text = reordered(await kept.text(), ids)
        if (text) return new Response(text, { status: 200, headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': 'no-store' } })
      } else if ((outcome === 'chain_busy' || outcome === 'chain_unavailable') && age < AUTOMATION_FAILURE_SECONDS * 1000) {
        return refuse(outcome, 502, { 'Retry-After': String(Math.max(1, Math.ceil((AUTOMATION_FAILURE_SECONDS * 1000 - age) / 1000))) })
      }
    }
  }
  let text: string | null = null
  let outcome: 'answer' | 'chain_busy' | 'chain_unavailable' = 'answer'
  try {
    text = JSON.stringify(await scanAutomation(deps, ids))
  } catch (error) {
    outcome = (error as { kind?: unknown } | null)?.kind === 'rate' ? 'chain_busy' : 'chain_unavailable'
  }
  if (cache && key) {
    const seconds = outcome === 'answer' ? AUTOMATION_SECONDS : AUTOMATION_FAILURE_SECONDS
    const entry = new Response(text ?? JSON.stringify({ error: outcome }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${seconds}`, [STORED_AT]: String(deps.now()), [OUTCOME]: outcome } })
    const stored = cache.put(key, entry).catch(() => undefined)
    if (waitUntil) waitUntil(stored)
    else await stored
  }
  return text !== null ? new Response(text, { status: 200, headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': 'no-store' } }) : refuse(outcome, 502, { 'Retry-After': String(AUTOMATION_FAILURE_SECONDS) })
}

/** What a route's question is, once it passed its checks: its coalescing key and the read that answers it. */
interface Asked {
  key: string
  read: (rpc: LocalRpc, cancelled: () => boolean) => Promise<Response>
  /**
   * 2026-10-14 (incident C4), the confirmation route's second shape only. `cls`: the visitor class the question draws
   * from when it is not its route's (CLASS_OF). `direct`: an answer that needs no node (a chain this edge does not read),
   * given after the visitor's turn and before the source is looked at. `own`: the question's own answer drawn from the
   * read it shares with the route's first shape (one key, one read of the node for both), and whether that answer is
   * the calm "busy"; null: the read's answer stands as it is.
   */
  cls?: keyof typeof VISITOR_CLASSES
  direct?: () => Response
  own?: (done: Done) => { response: Response; busy: boolean } | null
}

/** One invocation, before its log line and headers: the answer, and what it was. */
interface Handled {
  response: Response
  outcome?: Outcome
  cache: CacheTag
  rpc: LocalRpc | null
  /** A ledger answer's verdicts, for its log line (ledgerVerdicts). */
  verdicts?: string
  /** The limit that refused the question, when it is one of ours (Limiter); a refusal that names none is `node` or `kept`. */
  limiter?: Limiter | null
}

/** The codes a ledger answer's verdicts may log (a `why` or a position's reason): nothing else from the answer is. */
const VERDICT_CODES: ReadonlySet<string> = new Set<string>(['reading', 'before_floor', 'manual', 'shared', 'native', 'liquidity', 'unseen', 'too_many', 'not_found', 'rpc_unavailable', 'hooked_pool'] satisfies Array<LedgerWhy | 'not_found' | 'rpc_unavailable' | 'hooked_pool'>)
/** Past this many characters a ledger answer's verdicts are not counted: its log line says `large`. */
const VERDICT_TEXT_MAX = 1_048_576

/**
 * 2026-10-02 (review of the chart's tabs, finding 1: a tail of the preview showed the ledger's requests, never what they
 * answered): a ledger answer's verdicts for its log line, as fixed codes and counts, sorted, e.g. "exact:1,manual:1".
 * Each position is `exact`, its `why` when it is not, or the reason it was not read; never its id.
 */
export function ledgerVerdicts(text: string): string {
  if (text.length > VERDICT_TEXT_MAX) return 'large'
  let positions: unknown
  try {
    positions = (JSON.parse(text) as { positions?: unknown } | null)?.positions
  } catch {
    return 'unparsed'
  }
  if (!Array.isArray(positions)) return 'unparsed'
  const counts = new Map<string, number>()
  for (const one of positions as unknown[]) {
    const p = (one && typeof one === 'object' ? one : {}) as { ok?: unknown; exact?: unknown; why?: unknown; reason?: unknown }
    const named = (code: unknown, otherwise: string) => (typeof code === 'string' && VERDICT_CODES.has(code) ? code : otherwise)
    const code = p.ok === true ? (p.exact === true ? 'exact' : named(p.why, 'inexact')) : named(p.reason, 'other')
    counts.set(code, (counts.get(code) ?? 0) + 1)
  }
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([code, n]) => `${code}:${n}`).join(',') || 'none'
}

/** The route's checks of method, origin, type, size and shape (in that order): the question, or the refusal. */
async function askedOf(name: ChainRouteName, request: Request, url: URL, waitUntil: ((work: Promise<unknown>) => void) | undefined, runtime: Required<Pick<ChainRouteRuntime, 'now' | 'sleep'>> & { cache: AnswerCache | null; mintWaitMs?: number; log?: ChainRouteRuntime['log']; confirmation: ConfirmationMemory }): Promise<Asked | Response> {
  const { now, sleep, cache } = runtime
  const fees = (rpc: LocalRpc): FeesRuntime => ({ deps: { fetch: rpc.fetch, sleep, now, logLimits: EDGE_LOG_LIMITS }, cache, waitUntil, refused: rpc.refused, onDiagnostic: (fields) => logLine(runtime, fields) })
  switch (name) {
    case 'confirmation': {
      const body = await bodyOf(request, url, 256)
      if (body instanceof Response) return body
      const asked = confirmationRequestOf(body)
      if (!asked) return failed(name, 'bad_request', 400)
      // Changed on purpose 2026-10-14 (incident C4): the read keeps what is final and the finalized block at the edge
      // (confirmation.ts), and both shapes of the question share it under one key, each with its own answer of it.
      // A chain this edge has no node for: said at once; this node is never asked about another chain's transaction.
      if ('v' in asked && !CONFIRMATION_CHAINS.includes(asked.chainId)) return { key: '', cls: 'confirm', direct: notServed, read: async () => notServed() }
      const read: Asked['read'] = (rpc, cancelled) => confirmationOnNode(rpc.fetch, asked, { origin: url.origin, cache, now, sleep, waitUntil, memory: runtime.confirmation, cancelled })
      const key = 'hash' in asked ? asked.hash : 'finality'
      return 'v' in asked ? { key, cls: 'confirm', own: (done) => secondShape(asked, done), read } : { key, read }
    }
    case 'owned': {
      const asked = await ownerFrom(request, url)
      if (asked instanceof Response) return asked
      return {
        key: `owned|${asked.owner}|${asked.fresh ? 'fresh' : ''}`,
        read: (rpc, cancelled) => {
          const deps: EdgeDeps = { fetch: rpc.fetch, sleep, now, cancelled, wideLogs: () => false, logLimits: EDGE_LOG_LIMITS }
          // The list from DominoSetupV1's state (D4), then, best effort, each listed position's mint (ownedMints.ts).
          const scan = async (scanDeps: OwnedDeps, owner: string): Promise<OwnerScan> => {
            const found = await scanWallet(scanDeps, owner, null, true)
            const listed = new Set(found.body.positions.map((position) => position.tokenId))
            // 2026-10-02 (review finding 12): the walk is waited for briefly; past that it goes on under waitUntil (ownedMints.ts),
            // after the answer has left: so not tied to the question's drop, which may come with the answer's end. Its own
            // deadline and the invocation's POST budget bound it.
            const walkDeps: OwnedDeps = { ...scanDeps, cancelled: () => false }
            const walk = listed.size > 0 ? await walkMints(walkDeps, owner, found.body.block, cache, url.origin, waitUntil, runtime.mintWaitMs, listed) : { mints: [], capped: false }
            const capped = found.capped || walk.capped
            return { body: { v: 1, answer: found.body, automation: found.automation ?? null, mints: walk.mints.filter((mint) => listed.has(mint.id)), capped }, capped }
          }
          return answerOwnerAsked(asked, url, deps, 'v2.1', scan, cache, waitUntil)
        },
      }
    }
    case 'automation': {
      const body = await plainBody(request, url, AUTOMATION_BODY_BYTES)
      if (body instanceof Response) return body
      const ids = idsFrom(body)
      if (!ids) return refuse('invalid_request', 400)
      return {
        key: `automation|${ids.join(',')}`,
        read: (rpc) => automationAnswer(url, ids, { fetch: rpc.fetch, sleep, now }, cache, waitUntil),
      }
    }
    case 'state': {
      const body = await bodyOf(request, url, STATE_BODY_BYTES)
      if (body instanceof Response) return body
      const asked = stateRequestOf(body)
      if (!asked) return failed(name, 'bad_request', 400)
      return { key: `state|${asked.ids.join(',')}|${asked.automation ? 'a' : ''}|${asked.fresh ? 'fresh' : ''}`, read: (rpc) => stateAnswer(request, fees(rpc), asked) }
    }
    case 'ledger': {
      const body = await bodyOf(request, url, LEDGER_BODY_BYTES)
      if (body instanceof Response) return body
      const asked = ledgerRequestOf(body)
      if (!asked) return failed(name, 'bad_request', 400)
      return { key: `ledger|${asked.ids.join(',')}|${asked.fresh ? 'fresh' : ''}|${ledgerHintKey(asked)}`, read: (rpc) => ledgerAnswer(request, fees(rpc), asked) }
    }
    case 'record': {
      const body = await bodyOf(request, url, RECORD_BODY_BYTES)
      if (body instanceof Response) return body
      const asked = recordRequestOf(body)
      if (!asked) return failed(name, 'bad_request', 400)
      return { key: `record|${JSON.stringify(asked)}`, read: (rpc) => recordAnswer(request, fees(rpc), asked, EDGE_LOG_LIMITS.one) }
    }
    case 'simulate': {
      const body = await bodyOf(request, url, SIMULATE_BODY_BYTES)
      if (body instanceof Response) return body
      const asked = simulateRequestOf(body)
      if (!asked) return failed(name, 'bad_request', 400)
      return {
        key: '',
        read: async (rpc) => {
          const simulated = await simulateOnNode(rpc.fetch, asked, request.signal ?? undefined)
          if (simulated instanceof Response) return simulated.status === 429 ? failed(name, 'rate_limited', 429, Number(simulated.headers.get('Retry-After') ?? 2)) : failed(name, 'rpc_unavailable', 502, 5)
          if (simulated.kind === 'unsupported') return failed(name, 'simulate_unsupported', 501)
          if (simulated.kind === 'failed') return failed(name, 'simulation_failed', 422)
          if (simulated.kind === 'invalid') return failed(name, 'rpc_unavailable', 502, 5)
          return new Response(JSON.stringify({ v: 1, result: simulated.result }), { status: 200, headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': 'no-store' } })
        },
      }
    }
  }
}

/** The route's answer with no log line yet: its refusals, the visitor's turn, the source check, then the shared read. */
async function handle(name: ChainRouteName, context: ChainRouteContext, runtime: ChainRouteRuntime, memory: ChainRouteMemory): Promise<Handled> {
  const { request, env } = context
  const now = runtime.now ?? (() => Date.now())
  const sleep = runtime.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  const cache = runtime.cache === undefined ? defaultCache() : runtime.cache
  // The simulation's own switch comes before anything else: off, the route is not there.
  if (name === 'simulate' && !simulateEnabled(env)) return { response: failed(name, 'not_enabled', 404), outcome: 'source_off', cache: 'none', rpc: null }
  const url = new URL(request.url)
  // The question's node bill (nodeBill; none without a visitor) and the work it hands to waitUntil (its read, the chain id
  // check, cache puts, a mint walk going on after the answer). What it did not use of its reserve is given back once all
  // of that work has ended, chained into waitUntil itself, so a visitor who leaves cannot skip it (Cloudflare drops the
  // request's own frame, never what it handed to waitUntil); and, when nothing is handed on, as the frame ends.
  let bill: ReturnType<typeof nodeBill> | null = null
  let handed = 0
  const settleIfIdle = () => {
    if (handed === 0) bill?.settle()
  }
  const keepAlive = context.waitUntil
    ? (work: Promise<unknown>) => {
        handed += 1
        context.waitUntil?.(
          work.finally(() => {
            handed -= 1
            settleIfIdle()
          }),
        )
      }
    : undefined
  // A question refused the node for its visitor's bill keeps nothing in the cache (a failure that refusal caused is never
  // kept for anyone else).
  let rpc: LocalRpc | null = null
  const routeCache: AnswerCache | null = cache && { match: (key) => cache.match(key), put: (key, value) => (rpc?.refused() ? Promise.resolve() : cache.put(key, value)) }
  const asked = await askedOf(name, request, url, keepAlive, { now, sleep, cache: routeCache, mintWaitMs: runtime.mintWaitMs, log: runtime.log, confirmation: memory.confirmation })
  if (asked instanceof Response) return { response: asked, outcome: 'bad_request', cache: 'none', rpc: null }
  const visitor = await visitorOf(memory, request)
  const wait = admitted(memory, visitor, asked.cls ?? CLASS_OF[name], now())
  if (wait > 0) return { response: failed(name, 'rate_limited', 429, wait / 1000), outcome: 'limited', limiter: 'class', cache: 'none', rpc: null }
  if (asked.direct) return { response: asked.direct(), outcome: 'answer', cache: 'none', rpc: null }
  const endpoint = localRpcEndpoint(env)
  if (endpoint === null) {
    if (!memory.told.has('not_configured')) {
      memory.told.add('not_configured')
      logLine(runtime, { event: 'local_rpc_not_configured' })
    }
    return { response: failed(name, 'source_unavailable', 503, SOURCE_OFF_RETRY_SECONDS), outcome: 'source_off', cache: 'none', rpc: null }
  }
  // The visitor's share of the node (VISITOR_NODE): a reserve taken at the question's first call to the node (none for a
  // cache hit or a join), each POST past it billed as it goes; without a reserve left, the cache alone answers.
  bill = visitor === null ? null : nodeBill(memory, visitor, now)
  try {
    const siteGate = siteGateOf(env.WIDE_GATE, keepAlive, now, (event) => logLine(runtime, { event }))
    const transport = createLocalRpc(endpoint, { purpose: name, upstream: runtime.upstream, now, sleep: runtime.sleep, memory: memory.node, log: runtime.log, keepAlive, reserve: bill?.reserve, onPost: bill?.onPost, siteGate })
    rpc = transport
    // A failure while the node is away (another chain, a refused token, out of reach) is the calm source_unavailable.
    const read = async (cancelled: () => boolean) => {
      let response: Response
      try {
        response = await asked.read(transport, cancelled)
      } catch {
        response = failed(name, PLAIN.has(name) ? 'chain_unavailable' : 'rpc_unavailable', 502, 5)
      }
      const health = transport.health()
      if (response.status >= 500 && response.status !== 501 && health !== 'ok') {
        await response.body?.cancel().catch(() => undefined)
        // Merely out of reach (2026-10-30): asked again as the window ends, not a minute later.
        const down = Math.min(SOURCE_DOWN_RETRY_SECONDS.max, Math.max(SOURCE_DOWN_RETRY_SECONDS.min, Math.ceil(transport.downForMs() / 1000)))
        return failed(name, 'source_unavailable', 503, health === 'down' ? down : SOURCE_AWAY_RETRY_SECONDS)
      }
      return response
    }
    const simulated = async () => {
      const work = read(() => false)
      keepAlive?.(work)
      return { done: await doneOf(await work), joined: false, limited: transport.limited() }
    }
    const { done, joined, limited } = name === 'simulate' ? await simulated() : await shared(memory, `${name}#${asked.key}`, request.signal ?? null, read, now, keepAlive, transport.refused, transport.limited)
    // Refused the node for its visitor's bill, and the cache did not hold it: the wait until the bill holds a reserve again.
    if (!joined && done.status !== 200 && transport.refused() && visitor !== null) {
      const short = VISITOR_NODE.reserve - nodeLeft(memory, visitor, now())
      return { response: failed(name, 'rate_limited', 429, Math.max(1, short / NODE_RATE / 1000)), outcome: 'limited', limiter: 'bill', cache: 'none', rpc: transport }
    }
    // The question's own answer of the read (the confirmation route's second shape), after the visitor's own refusals
    // above, which stay a 429 in every shape; its calm "busy" is a 200 whose log line still says `busy`.
    const own = asked.own?.(done) ?? null
    const response = own ? own.response : new Response(done.text, { status: done.status, headers: done.headers })
    const verdicts = name === 'ledger' && done.status === 200 ? ledgerVerdicts(done.text) : undefined
    return { response, ...(own?.busy ? { outcome: 'busy' as const } : {}), limiter: limited, cache: joined ? 'coalesced' : name === 'simulate' ? 'none' : transport.spent().posts > 0 ? 'miss' : 'hit', rpc: transport, ...(verdicts ? { verdicts } : {}) }
  } finally {
    settleIfIdle()
  }
}

/** A read's outcome for the log line: an answer, the node busy, the source away, a request it refused, or none. */
async function outcomeOf(response: Response): Promise<Outcome> {
  if (response.status === 200) return 'answer'
  if (response.status === 503) return 'source_off'
  if (response.status === 429) return 'busy'
  if (response.status === 400) return 'bad_request'
  if (response.status === 502 && /"chain_busy"/.test(await response.clone().text().catch(() => ''))) return 'busy'
  return 'unavailable'
}

/**
 * Answers one of the six chain routes (RPC-SPEC §2.4): the checks, the visitor's turn, the source, the cache and the
 * node, in that order; then the answer leaves as JSON, never stored, with Server-Timing, after one log line.
 */
export async function answerChainRoute(name: ChainRouteName, context: ChainRouteContext, runtime: ChainRouteRuntime = {}): Promise<Response> {
  const now = runtime.now ?? (() => Date.now())
  const started = now()
  const memory = runtime.memory ?? (isolate ??= chainRouteMemory())
  let handled: Handled
  try {
    handled = await handle(name, context, runtime, memory)
  } catch {
    handled = { response: failed(name, PLAIN.has(name) ? 'chain_unavailable' : 'rpc_unavailable', 502, 5), outcome: 'unavailable', cache: 'none', rpc: null }
  }
  const { response, cache, rpc } = handled
  const outcome = handled.outcome ?? (await outcomeOf(response))
  // 2026-10-14 (incident C4): every refusal names what made it, in the answer and in its log line (Limiter). One that met
  // no limit of ours is the node's own word when its replies to this question held one, and a kept refusal otherwise.
  const limiter: Limiter | null = outcome === 'limited' || outcome === 'busy' ? (handled.limiter ?? (rpc?.erred() ? 'node' : 'kept')) : null
  const spent = rpc?.spent() ?? { posts: 0, items: 0, ms: 0 }
  const out = new Response(response.body, { status: response.status, headers: response.headers })
  out.headers.set('Content-Type', JSON_TYPE)
  out.headers.set('Cache-Control', 'no-store')
  out.headers.set('Server-Timing', `edge;desc="${cache}", node;dur=${Math.round(spent.ms)};desc="${spent.posts} posts"${limiter ? `, limit;desc="${limiter}"` : ''}`)
  logLine(runtime, { route: name, status: out.status, outcome, cache, posts: spent.posts, items: spent.items, nodeMs: Math.round(spent.ms), ms: Math.max(0, Math.round(now() - started)), ...(limiter ? { limiter } : {}), ...(handled.verdicts ? { verdicts: handled.verdicts } : {}) })
  return out
}
