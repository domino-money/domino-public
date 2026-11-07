/**
 * Whether Domino V2's three API routes are switched on (2026-10-02, the bridge side of spec F7 §2.4, §3.2 and §6.2), for
 * the V2 transports to decide between the live route and their package fixtures, and for the S2 gate (./gate.ts). Mounted
 * nowhere in V1: nothing here runs unless a V2 module asks.
 *
 * Each route's Worker answers a capabilities GET of its own, locally (no upstream call, no session):
 *   - read-v6 `1.0.0-rc.1`, POST /api/read/v6/portfolio and /api/read/v6/activity: GET /api/read/v6/capabilities, the
 *     read Worker's (bridge/src/worker.mjs) `{ contractVersion, dataMode: 'live_read_only' | 'disabled', chainIds:
 *     [4663, 8453, 42161], enabledReads, walletAuthentication: false, privateAccounts: false, ownerTransactions: false,
 *     automation: false }`;
 *   - position-plan-v1 `1.0.0-rc.2`, POST /api/position-plan/v1/plan (session and CSRF): GET
 *     /api/position-plan/v1/capabilities, the plan Worker's (bridge/src/position-plan-worker.mjs) `{ contractVersion,
 *     dataMode: 'live' | 'disabled', enabledRoutes }`;
 *   - crosschain-v1 `1.1.0-rc.1` (Changed on purpose (data) 2026-10-02 (S2 wired); Changed on purpose (data) 2026-10-06:
 *     1.0.0-rc.1 -> 1.1.0-rc.1, quoting by output, ./crosschain/version.ts), POST /api/crosschain/v1/origins,
 *     /quote and /status (session and CSRF): GET /api/crosschain/v1/capabilities, the crosschain Worker's
 *     (bridge/src/crosschain-worker.mjs), in the plan Worker's shape.
 *
 * What the probe can meet, and what each means (`V2RouteOff`):
 *   - `disabled`: the route's Worker answered and it is switched off (a 404 `route_not_available` from it says the
 *     same). The screens read it as "off": a dash with its reason under the gate's `live`, the package fixtures under
 *     `preview`.
 *   - `not_deployed`: no Worker of this contract answers the path: a 404 or 405 without the contract header (the
 *     forwarder's `not_found` while the family or its binding does not exist, which is the plan route's state until
 *     its Worker is deployed and bound), a 404 from an older Worker that does not know the protocol, or the page's own
 *     HTML. Also "off".
 *   - `gate_required`: the beta gate's 401 (no access cookie on this page).
 *   - `unavailable`: it cannot be told now (the forwarder's 503 `bridge_unavailable`, a Worker's 503 for a broken
 *     configuration, another refusal, a redirect, the network, this page's deadline). Not "on".
 *   - `invalid`: an answer that carries the contract's header but not its capabilities shape. Never read as "on".
 *   - `aborted`: the caller gave the question up.
 * Only a capabilities answer with the exact version and `dataMode` live is "on", with the routes it names.
 *
 * Added 2026-11-06 (read-v6 1.2.0-rc.1's window, docs/v2/V2_FEES.md): the read route's capabilities are asked in
 * 1.2.0-rc.1 first. Its answer stands only in that version (header and body); any other answer of the Worker (today's
 * refuses the version with a 502) is asked again in 1.1.0-rc.1, read exactly as before, and the probe asks 1.1.0-rc.1
 * alone for the rest of the page load. No Worker's answer at all (no reply, a reply without the contract header) is the
 * same in either version: said at once, with no second GET (review F2, 2026-11-06). `position-fees` is on only from a 1.2.0-rc.1 answer; named in a 1.1.0-rc.1 one it is known (so
 * it never turns the reads off) and dropped. A route this app does not know is still refused as `invalid`.
 *
 * The GET itself is injected (`RawGet`), as src/v2/plan/httpTransport.ts takes its POST: src/v2 may not import the
 * consumer directories (tests/consumer.guard.test.mjs), and only the reviewed clients send requests
 * (tests/read.test.mjs). A V2 transport hands in lib/http's reading of a same-origin GET (rawReplyOf over the page's
 * request with REQUEST_INIT and method GET); the shapes below restate lib/http/rawReply.ts's.
 *
 * Pure: no wallet, no storage, no clock of its own (the probe's memory takes one).
 */
import { CROSSCHAIN_CONTRACT, CROSSCHAIN_HEADER } from './crosschain/version'
import { S1_PLAN_CONTRACT_VERSION, S1_PLAN_HEADER } from './plan/types'
import { READ_V6_CONTRACT_VERSION, READ_V6_HEADER, READ_V6_NEXT_CONTRACT_VERSION } from './read/v6'

export type V2Route = 'readV6' | 'plan' | 'crosschain'

export type V2RouteOff = 'disabled' | 'not_deployed' | 'gate_required' | 'unavailable' | 'invalid' | 'aborted'

export type V2RouteState =
  | { readonly on: true; readonly routes: readonly string[] }
  | { readonly on: false; readonly reason: V2RouteOff }

/** lib/http/rawReply.ts's reply shapes, restated structurally. */
export type RawBody = { kind: 'text'; text: string } | { kind: 'too_large' } | { kind: 'undecodable' }
export interface RawReply {
  status: number
  opaqueRedirect: boolean
  contentType: string | null
  /** The route's own contract header: X-Domino-Read-Contract, X-Domino-Position-Plan-Contract or X-Domino-Crosschain-Contract. */
  contractHeader: string | null
  requestIdHeader: string | null
  retryAfterHeader: string | null
  body: RawBody
}
export type TransportResult = { kind: 'reply'; reply: RawReply } | { kind: 'network' } | { kind: 'timeout' } | { kind: 'aborted' }

/** One same-origin GET of `path`, its reply read within `maxBytes` and `timeoutMs`. Never throws. */
export type RawGet = (
  path: string,
  options: { headers: Record<string, string>; contractHeader: string; maxBytes: number; timeoutMs: number; signal?: AbortSignal },
) => Promise<TransportResult>

/**
 * A version a route's Worker may speak beside its own while a package's window is open (read-v6 1.2.0-rc.1, launch round
 * P3; asked this way since 2026-11-06, the owner: nothing pending on our side). The probe asks it first; an answer that is
 * not this version's own capabilities (today's Worker refuses the version with a 502, a body that fails the shape below,
 * an answer in the older version) is asked again in `version`, exactly as before the window; no Worker's answer (no
 * reply, a reply without the contract header) is not (askV2Route).
 */
interface NextVersion {
  readonly version: string
  /** The routes its capabilities may name. */
  readonly known: readonly string[]
  /** The routes it alone serves: an answer in the route's own version may name one, and it is never on from that answer. */
  readonly only: readonly string[]
}

interface RouteSpec {
  readonly path: string
  readonly header: string
  readonly version: string
  /** The routes the capabilities may name, in the Worker's order. */
  readonly known: readonly string[]
  readonly next?: NextVersion
}

const READ_V6_ROUTES = Object.freeze(['portfolio', 'activity', 'chain-pools', 'chain-balances', 'chain-tokens', 'position-fees'])

export const V2_ROUTE_SPECS: Readonly<Record<V2Route, RouteSpec>> = Object.freeze({
  readV6: Object.freeze({
    path: '/api/read/v6/capabilities', header: READ_V6_HEADER, version: READ_V6_CONTRACT_VERSION, known: READ_V6_ROUTES,
    next: Object.freeze({ version: READ_V6_NEXT_CONTRACT_VERSION, known: READ_V6_ROUTES, only: Object.freeze(['position-fees']) }),
  }),
  plan: Object.freeze({ path: '/api/position-plan/v1/capabilities', header: S1_PLAN_HEADER, version: S1_PLAN_CONTRACT_VERSION, known: Object.freeze(['plan']) }),
  crosschain: Object.freeze({ path: '/api/crosschain/v1/capabilities', header: CROSSCHAIN_HEADER, version: CROSSCHAIN_CONTRACT, known: Object.freeze(['origins', 'quote', 'status']) }),
})

/** read-v6's three chains, in the order every answer lists them (Robinhood Chain, Base, Arbitrum One). */
const V6_CHAIN_IDS = [4663, 8453, 42161] as const

/**
 * Whether a capabilities answer's `chainIds` are read-v6's: the three, all of them, in their order, as before. Changed on
 * purpose 2026-11-07 (Elysium as a fourth V2 chain): beside them, other chains, each a distinct positive integer: read-v6
 * names Elysium (99901) from rugged97's day-9 version, which a Worker may answer before or after this app serves Elysium,
 * and a forced test build serves Elysium against a Worker that does not name it yet. Those ids are ignored here: whether a
 * chain is read is each answer's own per-chain status (./read/v6.ts), as on the three, so an answer naming a chain this
 * app does not serve no longer turns every read off, and one without Elysium leaves Elysium's reads "not available yet".
 */
function v6Chains(chains: unknown): boolean {
  if (!Array.isArray(chains) || chains.some((id) => !Number.isSafeInteger(id) || (id as number) < 1) || new Set(chains).size !== chains.length) return false
  const ours = chains.filter((id) => (V6_CHAIN_IDS as readonly unknown[]).includes(id))
  return ours.length === V6_CHAIN_IDS.length && ours.every((id, index) => id === V6_CHAIN_IDS[index])
}
/** A capabilities answer is a few hundred bytes. */
export const V2_ROUTE_MAX_BYTES = 4 * 1024
export const V2_ROUTE_TIMEOUT_MS = 10_000
/** A settled answer is kept this long by a probe (as lib/read/bridgeSource.ts keeps the read capabilities). */
export const V2_ROUTE_REUSE_MS = 60_000
/**
 * (2026-10-15, pack 7): how long a probe keeps the read route's (`readV6`) answer that it is on: five minutes. Every
 * portfolio and activity read older than a minute asked it again, so an idle list asked it each minute. Only this answer:
 * a route that is off (so a route switched on is seen as soon as before) and the plan and crosschain routes, whose answers
 * open or lock money screens, keep V2_ROUTE_REUSE_MS. A read of the route refused as not there (404, 405) brings it back
 * to V2_ROUTE_REUSE_MS from its answer (`shorten`), so the probe never asks sooner than it did before.
 */
export const V2_READ_ROUTE_REUSE_MS = 300_000

/** The beta gate's JSON refusal, byte for byte as functions/_middleware.ts sends it. */
const GATE_REFUSAL = '{"error":"beta_access_required"}'
const JSON_MEDIA = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i

const off = (reason: V2RouteOff): V2RouteState => Object.freeze({ on: false, reason })

function jsonOf(reply: RawReply): unknown {
  if (reply.contentType === null || !JSON_MEDIA.test(reply.contentType) || reply.body.kind !== 'text') return undefined
  try {
    return JSON.parse(reply.body.text) as unknown
  } catch {
    return undefined
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

/** The routes a capabilities list names: distinct, each a route of this contract, or null. */
function routeList(value: unknown, known: readonly string[]): readonly string[] | null {
  if (!Array.isArray(value) || value.some((route) => typeof route !== 'string' || !known.includes(route))) return null
  return new Set(value).size === value.length ? Object.freeze([...(value as string[])]) : null
}

/** Which of a route's versions was asked: its own (`version`), or the one its package's window adds (`next`). */
export type V2RouteVersion = 'version' | 'next'

/** The version asked, the routes its answer may name, and those it may name but never serves (the next version's own). */
function versionOf(route: V2Route, asked: V2RouteVersion): { version: string; known: readonly string[]; dropped: readonly string[] } {
  const spec = V2_ROUTE_SPECS[route]
  if (asked === 'next' && spec.next) return { version: spec.next.version, known: spec.next.known, dropped: [] }
  return { version: spec.version, known: spec.known, dropped: spec.next?.only ?? [] }
}

/** The capabilities answer, read: on with its routes, `disabled`, or null when it is not the contract's shape. */
function capabilitiesOf(route: V2Route, value: unknown, asked: V2RouteVersion): V2RouteState | null {
  const { version, known, dropped } = versionOf(route, asked)
  if (!isRecord(value) || value.contractVersion !== version) return null
  if (route === 'readV6') {
    if (!exactKeys(value, ['contractVersion', 'dataMode', 'chainIds', 'enabledReads', 'walletAuthentication', 'privateAccounts', 'ownerTransactions', 'automation'])) return null
    if (value.walletAuthentication !== false || value.privateAccounts !== false || value.ownerTransactions !== false || value.automation !== false) return null
    if (!v6Chains(value.chainIds)) return null
    const named = routeList(value.enabledReads, known)
    if (named === null) return null
    if (value.dataMode === 'disabled') return named.length === 0 ? off('disabled') : null
    if (value.dataMode !== 'live_read_only' || named.length === 0) return null
    // A route the window's version alone serves, named in this version: known, so never a reason to turn the reads off,
    // and never on from here (2026-11-06: `position-fees` is asked in 1.2.0-rc.1 only).
    const reads = Object.freeze(named.filter((name) => !dropped.includes(name)))
    return reads.length > 0 ? Object.freeze({ on: true, routes: reads }) : off('disabled')
  }
  if (!exactKeys(value, ['contractVersion', 'dataMode', 'enabledRoutes'])) return null
  const routes = routeList(value.enabledRoutes, known)
  if (routes === null) return null
  if (value.dataMode === 'disabled') return routes.length === 0 ? off('disabled') : null
  return value.dataMode === 'live' && routes.length > 0 ? Object.freeze({ on: true, routes }) : null
}

/**
 * What one capabilities exchange says about `route` (see the module comment for each reason). `asked` (2026-11-06): the
 * version the GET named, whose header and `contractVersion` the answer must carry.
 */
export function routeStateOf(route: V2Route, result: TransportResult, asked: V2RouteVersion = 'version'): V2RouteState {
  if (result.kind === 'aborted') return off('aborted')
  if (result.kind !== 'reply') return off('unavailable')
  const reply = result.reply
  const { version } = versionOf(route, asked)
  if (reply.opaqueRedirect) return off('unavailable')
  const ours = reply.contractHeader === version
  if (reply.contractHeader === null && reply.status === 401 && reply.body.kind === 'text' && reply.body.text === GATE_REFUSAL) return off('gate_required')
  if (reply.status === 404 || reply.status === 405) {
    // Without this contract's header: the forwarder's not_found, an older Worker that does not know the protocol.
    if (!ours) return off('not_deployed')
    const body = jsonOf(reply)
    return isRecord(body) && exactKeys(body, ['error']) && body.error === 'route_not_available' ? off('disabled') : off('unavailable')
  }
  if (reply.contractHeader === null) {
    // The page's own HTML (the SPA's fallback): nothing serves this path.
    if (reply.status === 200 && reply.contentType !== null && /^text\/html\b/i.test(reply.contentType)) return off('not_deployed')
    return off('unavailable')
  }
  if (!ours) return off('invalid')
  if (reply.status !== 200) return off('unavailable')
  return capabilitiesOf(route, jsonOf(reply), asked) ?? off('invalid')
}

/** One capabilities GET of `route` in `version`. Never throws. */
async function getCapabilities(route: V2Route, version: string, get: RawGet, signal?: AbortSignal): Promise<TransportResult> {
  const spec = V2_ROUTE_SPECS[route]
  try {
    return await get(spec.path, {
      headers: { Accept: 'application/json', [spec.header]: version },
      contractHeader: spec.header,
      maxBytes: V2_ROUTE_MAX_BYTES,
      timeoutMs: V2_ROUTE_TIMEOUT_MS,
      signal,
    })
  } catch {
    return { kind: 'network' }
  }
}

/**
 * Whether the answer to the next version stands (2026-11-06): the Worker's own word in that version (its header, and not
 * a body that fails its shape), the caller giving up, or the beta gate, which refuses every version alike. Anything else
 * is not that version's answer, and the route's own version is asked.
 */
function nextStands(route: V2Route, result: TransportResult, state: V2RouteState): boolean {
  if (!state.on && (state.reason === 'aborted' || state.reason === 'gate_required')) return true
  const next = V2_ROUTE_SPECS[route].next
  return next !== undefined && result.kind === 'reply' && result.reply.contractHeader === next.version && (state.on || state.reason !== 'invalid')
}

/**
 * Whether a Worker answered at all (review F2, 2026-11-06): a reply that carries the route's contract header. The read
 * Worker puts its header on every answer, its own failures included (bridge/src/worker.mjs); no reply (the network, the
 * GET's deadline), an opaque redirect, and a reply without the header (the forwarder's own refusals, which never carry
 * one and never read the version asked: functions/_lib/bridge.ts; the edge's or the page's HTML) say nothing about a
 * version, so the route's own version would get the very same.
 */
const workerAnswered = (result: TransportResult): boolean => result.kind === 'reply' && !result.reply.opaqueRedirect && result.reply.contractHeader !== null

export interface V2AskOptions {
  /** false: ask the route's own version alone (the probe learned this page load that its Worker does not speak the next one). */
  next?: boolean
  /**
   * Told when the route's Worker does not speak the next version: it refused it in the route's own version, or the next
   * version was not answered and the route's own version was, settled (on or `disabled`).
   */
  refused?: () => void
}

/**
 * Ask once: one capabilities GET of `route`, read. Changed on purpose 2026-11-06 (read-v6's 1.2.0-rc.1 window): a route
 * with a next version asks it first, and asks again in its own version, as before, when that answer does not stand.
 * Changed on purpose 2026-11-06 (review F2): only when a Worker answered it. No reply, an opaque redirect or a reply
 * without the contract header is the answer for either version, said at once with no second GET (an outage cost two GETs
 * and up to twice V2_ROUTE_TIMEOUT_MS per ask); and a Worker that refused the next version in the route's own version is
 * known not to speak it, whatever its own version then answers.
 */
export async function askV2Route(route: V2Route, get: RawGet, signal?: AbortSignal, options: V2AskOptions = {}): Promise<V2RouteState> {
  const spec = V2_ROUTE_SPECS[route]
  if (spec.next && options.next !== false) {
    const result = await getCapabilities(route, spec.next.version, get, signal)
    const state = routeStateOf(route, result, 'next')
    if (nextStands(route, result, state) || !workerAnswered(result)) return state
    if (result.kind === 'reply' && result.reply.contractHeader === spec.version) options.refused?.()
    const own = routeStateOf(route, await getCapabilities(route, spec.version, get, signal))
    if (own.on || own.reason === 'disabled') options.refused?.()
    return own
  }
  return routeStateOf(route, await getCapabilities(route, spec.version, get, signal))
}

/** Whether `state` serves `name` (a read-v6 read: 'portfolio' or 'activity'; the plan route: 'plan'; the crosschain route: 'origins', 'quote' or 'status'). */
export const routeServes = (state: V2RouteState, name: string): boolean => state.on && state.routes.includes(name)

export interface V2RouteProbe {
  /**
   * The route's state: a settled answer (on, `disabled`, `not_deployed`) kept for a minute (the read route said on: five,
   * 2026-10-15, pack 7), one question at a time.
   */
  state(route: V2Route): Promise<V2RouteState>
  /** Forget what was kept (a session or page change that may change the answer). */
  forget(): void
  /**
   * (2026-10-15, pack 7): a read of `route` was refused as not there (404, 405): its kept answer stands no longer than
   * V2_ROUTE_REUSE_MS from when it came, as every answer did before. Asks nothing by itself.
   */
  shorten?(route: V2Route): void
  /** The answer kept for `route` now, asking nothing; null when none is. */
  known?(route: V2Route): V2RouteState | null
}

/**
 * A probe for the page: each route asked at most once a minute while its answer is settled (the read route said on: once
 * per V2_READ_ROUTE_REUSE_MS, 2026-10-15, pack 7), and concurrent askers
 * share one GET. Anything else (unavailable, gate_required, invalid, aborted) is not kept, so the next ask asks again;
 * nothing retries by itself.
 */
export function createV2RouteProbe({ get, now }: { get: RawGet; now: () => number }): V2RouteProbe {
  // `at`: when the answer came (2026-10-15, pack 7: `shorten` counts the minute from it).
  const kept = new Map<V2Route, { state: V2RouteState; until: number; at: number }>()
  const asking = new Map<V2Route, Promise<V2RouteState>>()
  // (2026-11-06) The routes whose Worker answered their own version but not the next one: for this page load, asked in
  // their own version alone, as before the window (one GET, never a refused one first). forget() asks the next again.
  const ownOnly = new Set<V2Route>()
  return {
    state(route) {
      const memo = kept.get(route)
      if (memo && now() < memo.until) return Promise.resolve(memo.state)
      const pending = asking.get(route)
      if (pending) return pending
      const question = askV2Route(route, get, undefined, { next: !ownOnly.has(route), refused: () => ownOnly.add(route) }).then((state) => {
        asking.delete(route)
        const settled = state.on || state.reason === 'disabled' || state.reason === 'not_deployed'
        // (2026-10-15, pack 7): the read route said on is kept V2_READ_ROUTE_REUSE_MS; every other settled answer its minute.
        if (settled) kept.set(route, { state, at: now(), until: now() + (route === 'readV6' && state.on ? V2_READ_ROUTE_REUSE_MS : V2_ROUTE_REUSE_MS) })
        else kept.delete(route)
        return state
      })
      asking.set(route, question)
      return question
    },
    forget() {
      kept.clear()
      ownOnly.clear()
    },
    known(route) {
      const memo = kept.get(route)
      return memo && now() < memo.until ? memo.state : null
    },
    shorten(route) {
      const memo = kept.get(route)
      if (memo) memo.until = Math.min(memo.until, memo.at + V2_ROUTE_REUSE_MS)
    },
  }
}
