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
 * The GET itself is injected (`RawGet`), as src/v2/plan/httpTransport.ts takes its POST: src/v2 may not import the
 * consumer directories (tests/consumer.guard.test.mjs), and only the reviewed clients send requests
 * (tests/read.test.mjs). A V2 transport hands in lib/http's reading of a same-origin GET (rawReplyOf over the page's
 * request with REQUEST_INIT and method GET); the shapes below restate lib/http/rawReply.ts's.
 *
 * Pure: no wallet, no storage, no clock of its own (the probe's memory takes one).
 */
import { CROSSCHAIN_CONTRACT, CROSSCHAIN_HEADER } from './crosschain/version'
import { S1_PLAN_CONTRACT_VERSION, S1_PLAN_HEADER } from './plan/types'
import { READ_V6_CONTRACT_VERSION, READ_V6_HEADER } from './read/v6'

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

interface RouteSpec {
  readonly path: string
  readonly header: string
  readonly version: string
  /** The routes the capabilities may name, in the Worker's order. */
  readonly known: readonly string[]
}

export const V2_ROUTE_SPECS: Readonly<Record<V2Route, RouteSpec>> = Object.freeze({
  readV6: Object.freeze({ path: '/api/read/v6/capabilities', header: READ_V6_HEADER, version: READ_V6_CONTRACT_VERSION, known: Object.freeze(['portfolio', 'activity', 'chain-pools', 'chain-balances', 'chain-tokens']) }),
  plan: Object.freeze({ path: '/api/position-plan/v1/capabilities', header: S1_PLAN_HEADER, version: S1_PLAN_CONTRACT_VERSION, known: Object.freeze(['plan']) }),
  crosschain: Object.freeze({ path: '/api/crosschain/v1/capabilities', header: CROSSCHAIN_HEADER, version: CROSSCHAIN_CONTRACT, known: Object.freeze(['origins', 'quote', 'status']) }),
})

/** read-v6's three chains, in the order every answer lists them (Robinhood Chain, Base, Arbitrum One). */
const V6_CHAIN_IDS = [4663, 8453, 42161] as const
/** A capabilities answer is a few hundred bytes. */
export const V2_ROUTE_MAX_BYTES = 4 * 1024
export const V2_ROUTE_TIMEOUT_MS = 10_000
/** A settled answer is kept this long by a probe (as lib/read/bridgeSource.ts keeps the read capabilities). */
export const V2_ROUTE_REUSE_MS = 60_000

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

/** The capabilities answer, read: on with its routes, `disabled`, or null when it is not the contract's shape. */
function capabilitiesOf(route: V2Route, value: unknown): V2RouteState | null {
  const spec = V2_ROUTE_SPECS[route]
  if (!isRecord(value) || value.contractVersion !== spec.version) return null
  if (route === 'readV6') {
    if (!exactKeys(value, ['contractVersion', 'dataMode', 'chainIds', 'enabledReads', 'walletAuthentication', 'privateAccounts', 'ownerTransactions', 'automation'])) return null
    if (value.walletAuthentication !== false || value.privateAccounts !== false || value.ownerTransactions !== false || value.automation !== false) return null
    const chains = value.chainIds
    if (!Array.isArray(chains) || chains.length !== V6_CHAIN_IDS.length || chains.some((id, index) => id !== V6_CHAIN_IDS[index])) return null
    const reads = routeList(value.enabledReads, spec.known)
    if (reads === null) return null
    if (value.dataMode === 'disabled') return reads.length === 0 ? off('disabled') : null
    return value.dataMode === 'live_read_only' && reads.length > 0 ? Object.freeze({ on: true, routes: reads }) : null
  }
  if (!exactKeys(value, ['contractVersion', 'dataMode', 'enabledRoutes'])) return null
  const routes = routeList(value.enabledRoutes, spec.known)
  if (routes === null) return null
  if (value.dataMode === 'disabled') return routes.length === 0 ? off('disabled') : null
  return value.dataMode === 'live' && routes.length > 0 ? Object.freeze({ on: true, routes }) : null
}

/** What one capabilities exchange says about `route` (see the module comment for each reason). */
export function routeStateOf(route: V2Route, result: TransportResult): V2RouteState {
  if (result.kind === 'aborted') return off('aborted')
  if (result.kind !== 'reply') return off('unavailable')
  const reply = result.reply
  const spec = V2_ROUTE_SPECS[route]
  if (reply.opaqueRedirect) return off('unavailable')
  const ours = reply.contractHeader === spec.version
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
  return capabilitiesOf(route, jsonOf(reply)) ?? off('invalid')
}

/** Ask once: one capabilities GET of `route`, read. */
export async function askV2Route(route: V2Route, get: RawGet, signal?: AbortSignal): Promise<V2RouteState> {
  const spec = V2_ROUTE_SPECS[route]
  let result: TransportResult
  try {
    result = await get(spec.path, {
      headers: { Accept: 'application/json', [spec.header]: spec.version },
      contractHeader: spec.header,
      maxBytes: V2_ROUTE_MAX_BYTES,
      timeoutMs: V2_ROUTE_TIMEOUT_MS,
      signal,
    })
  } catch {
    result = { kind: 'network' }
  }
  return routeStateOf(route, result)
}

/** Whether `state` serves `name` (a read-v6 read: 'portfolio' or 'activity'; the plan route: 'plan'; the crosschain route: 'origins', 'quote' or 'status'). */
export const routeServes = (state: V2RouteState, name: string): boolean => state.on && state.routes.includes(name)

export interface V2RouteProbe {
  /** The route's state: a settled answer (on, `disabled`, `not_deployed`) kept for a minute, one question at a time. */
  state(route: V2Route): Promise<V2RouteState>
  /** Forget what was kept (a session or page change that may change the answer). */
  forget(): void
}

/**
 * A probe for the page: each route asked at most once a minute while its answer is settled, and concurrent askers
 * share one GET. Anything else (unavailable, gate_required, invalid, aborted) is not kept, so the next ask asks again;
 * nothing retries by itself.
 */
export function createV2RouteProbe({ get, now }: { get: RawGet; now: () => number }): V2RouteProbe {
  const kept = new Map<V2Route, { state: V2RouteState; until: number }>()
  const asking = new Map<V2Route, Promise<V2RouteState>>()
  return {
    state(route) {
      const memo = kept.get(route)
      if (memo && now() < memo.until) return Promise.resolve(memo.state)
      const pending = asking.get(route)
      if (pending) return pending
      const question = askV2Route(route, get).then((state) => {
        asking.delete(route)
        const settled = state.on || state.reason === 'disabled' || state.reason === 'not_deployed'
        if (settled) kept.set(route, { state, until: now() + V2_ROUTE_REUSE_MS })
        else kept.delete(route)
        return state
      })
      asking.set(route, question)
      return question
    },
    forget() {
      kept.clear()
    },
  }
}
