/**
 * points-v1 over same-origin HTTP (added 2026-11-07, the owner's Points page, Season 1; rugged97's PR #467,
 * api-contracts/points-v1 1.0.0-rc.1): the Points page's three exchanges with the points service, the way
 * v2/plan/httpTransport.ts makes the plan's.
 *
 *   - GET  /api/points/v1/capabilities  no session: whether the routes are on (`dataMode` "live" or "disabled"); the
 *                                       points Worker answers it itself (bridge/src/points-worker.mjs)
 *   - POST /api/points/v1/points  {}    the signed-in wallet's season, latest count and points
 *   - POST /api/points/v1/link    {referrer, issuedAt, signature}  the wallet's referrer, signed by the wallet
 *
 * Each POST carries the session cookie (the browser's business), `X-Domino-CSRF` (lent per request by the caller) and
 * `X-Domino-Points-Contract: 1.0.0-rc.1`. A reply without that header did not come from the points route (the
 * forwarder's 404 while no Worker is bound, the beta gate, the site's own page): its body is never read as the
 * contract's, and the route reads as off. A reply with it is held to the contract's runtime (validateResponse,
 * validateError) before anything of it is used; one that fails is `contract`, never shown.
 *
 * The request itself is injected (`RawPost`, `RawGet`: lib/http/rawReply.ts's fetchRaw bound to the page's fetch and
 * clock, same-origin, no redirect followed, a bounded body), and so is the runtime, so this module stays pure: no
 * fetch, no storage, no wallet (finance/points.ts binds it to the page). tests/points-transport.test.mjs drives it with
 * the contract's own fixtures.
 */

export const POINTS_CONTRACT_VERSION = '1.0.0-rc.1'
export const POINTS_HEADER = 'X-Domino-Points-Contract'
export const CSRF_HEADER = 'X-Domino-CSRF'
export const POINTS_PATHS = Object.freeze({
  capabilities: '/api/points/v1/capabilities',
  points: '/api/points/v1/points',
  link: '/api/points/v1/link',
})
/** The service's own limits (bridge/src/points-worker.mjs POINTS_LIMITS): a 1 KiB body, an 8 KiB answer, 21 s at the edge. */
export const POINTS_MAX_REQUEST_BYTES = 1024
export const POINTS_MAX_RESPONSE_BYTES = 8192
export const POINTS_TIMEOUT_MS = 22_000
/** A capabilities answer is a few dozen bytes; asked with no session, answered by the Worker itself. */
export const POINTS_CAPABILITIES_MAX_BYTES = 4096
export const POINTS_CAPABILITIES_TIMEOUT_MS = 10_000

/** lib/http/rawReply.ts's reply shapes, restated structurally (as v2/plan/httpTransport.ts restates them). */
export type RawBody = { kind: 'text'; text: string } | { kind: 'too_large' } | { kind: 'undecodable' }
export interface RawReply {
  status: number
  opaqueRedirect: boolean
  contentType: string | null
  /** `X-Domino-Points-Contract`. */
  contractHeader: string | null
  requestIdHeader: string | null
  retryAfterHeader: string | null
  body: RawBody
}
export type TransportResult = { kind: 'reply'; reply: RawReply } | { kind: 'network' } | { kind: 'timeout' } | { kind: 'aborted' }

interface Bounds {
  contractHeader: string
  maxBytes: number
  timeoutMs: number
  signal?: AbortSignal
}
/** lib/http/rawReply.ts `fetchRaw` without its fetch and clock. */
export type RawPost = (url: string, init: { headers: Record<string, string>; body: string }, options: Bounds) => Promise<TransportResult>
/** One same-origin GET read the same way. */
export type RawGet = (url: string, options: Bounds & { headers: Record<string, string> }) => Promise<TransportResult>

/** api-contracts/points-v1/runtime.mjs, as much of it as this uses. */
export interface PointsRuntime {
  readonly CONTRACT_VERSION: string
  validateRequest(route: 'points' | 'link', value: unknown): boolean
  validateResponse(route: 'points' | 'link', value: unknown): boolean
  validateError(status: number, value: unknown): boolean
}

/**
 * Whether the points routes answer: `live` (both on), `off` (the Worker says disabled, or no Worker answers the path),
 * `unavailable` (it cannot be told now: the network, the deadline, a broken binding, an answer outside the contract),
 * `aborted` (the caller gave the question up).
 */
export type PointsService = 'live' | 'off' | 'unavailable' | 'aborted'

/**
 * An exchange's end: the contract's answer, or a refusal by its code. Besides the contract's codes (errors.json and the
 * Worker's), the transport's own: `network`, `timeout`, `contract` (an answer outside the contract), `off` (no points
 * route answered), `session_required` (nothing was sent: no signed-in session to lend a CSRF).
 */
export type Exchange<T> = { kind: 'ok'; value: T } | { kind: 'refused'; code: string; status: number; retryAfterSeconds?: number } | { kind: 'aborted' }

const JSON_MEDIA = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i

/** The JSON body of a reply, or undefined when it has none the route could have sent. */
function jsonOf(reply: RawReply): unknown {
  if (reply.contentType === null || !JSON_MEDIA.test(reply.contentType) || reply.body.kind !== 'text') return undefined
  try {
    return JSON.parse(reply.body.text) as unknown
  } catch {
    return undefined
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The capabilities answer as the Worker writes it: exactly its three keys. */
function capabilitiesOf(value: unknown): PointsService {
  if (!isRecord(value) || value.contractVersion !== POINTS_CONTRACT_VERSION) return 'unavailable'
  const keys = Object.keys(value)
  if (keys.length !== 3 || !['contractVersion', 'dataMode', 'enabledRoutes'].every((key) => Object.hasOwn(value, key))) return 'unavailable'
  const routes = value.enabledRoutes
  if (!Array.isArray(routes) || routes.some((route) => route !== 'points' && route !== 'link') || new Set(routes).size !== routes.length) return 'unavailable'
  if (value.dataMode === 'disabled') return routes.length === 0 ? 'off' : 'unavailable'
  if (value.dataMode !== 'live') return 'unavailable'
  return routes.includes('points') && routes.includes('link') ? 'live' : 'off'
}

/** GET capabilities: whether the points routes are on. Never throws. */
export async function askCapabilities(get: RawGet, signal?: AbortSignal): Promise<PointsService> {
  const result = await get(POINTS_PATHS.capabilities, {
    headers: { Accept: 'application/json', [POINTS_HEADER]: POINTS_CONTRACT_VERSION },
    contractHeader: POINTS_HEADER,
    maxBytes: POINTS_CAPABILITIES_MAX_BYTES,
    timeoutMs: POINTS_CAPABILITIES_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  })
  if (result.kind === 'aborted') return 'aborted'
  if (result.kind !== 'reply') return 'unavailable'
  const reply = result.reply
  // No points Worker behind the path: the forwarder's 404 (declared ahead, nothing bound), the gate, the site's page. A
  // broken binding is the forwarder's 503: it cannot be told now.
  if (reply.contractHeader !== POINTS_CONTRACT_VERSION) return reply.status === 503 ? 'unavailable' : 'off'
  if (reply.status === 200) return capabilitiesOf(jsonOf(reply))
  const body = jsonOf(reply)
  return isRecord(body) && body.error === 'route_not_available' ? 'off' : 'unavailable'
}

/** Seconds from a Retry-After header, when it says some. */
function retryAfter(header: string | null): number | undefined {
  if (header === null || !/^\d{1,6}$/.test(header)) return undefined
  return Number(header)
}

/**
 * One POST of the contract's, with the CSRF the caller lends. The request is held to the contract before it is sent, the
 * answer before it is returned.
 */
async function exchange<T>(route: 'points' | 'link', post: RawPost, csrf: string, runtime: PointsRuntime, request: unknown, signal?: AbortSignal): Promise<Exchange<T>> {
  if (runtime.CONTRACT_VERSION !== POINTS_CONTRACT_VERSION || !runtime.validateRequest(route, request)) return { kind: 'refused', code: 'invalid_request', status: 0 }
  const body = JSON.stringify(request)
  if (new TextEncoder().encode(body).length > POINTS_MAX_REQUEST_BYTES) return { kind: 'refused', code: 'request_too_large', status: 0 }
  const result = await post(
    POINTS_PATHS[route],
    {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        [POINTS_HEADER]: POINTS_CONTRACT_VERSION,
        [CSRF_HEADER]: csrf,
      },
      body,
    },
    { contractHeader: POINTS_HEADER, maxBytes: POINTS_MAX_RESPONSE_BYTES, timeoutMs: POINTS_TIMEOUT_MS, ...(signal ? { signal } : {}) },
  )
  if (result.kind === 'aborted') return { kind: 'aborted' }
  if (result.kind !== 'reply') return { kind: 'refused', code: result.kind, status: 0 }
  const reply = result.reply
  if (reply.contractHeader !== POINTS_CONTRACT_VERSION) return { kind: 'refused', code: reply.status === 503 ? 'upstream_unavailable' : 'off', status: reply.status }
  const value = jsonOf(reply)
  if (reply.status === 200) return runtime.validateResponse(route, value) ? { kind: 'ok', value: value as T } : { kind: 'refused', code: 'contract', status: 200 }
  if (!runtime.validateError(reply.status, value)) return { kind: 'refused', code: 'contract', status: reply.status }
  const wait = retryAfter(reply.retryAfterHeader)
  return { kind: 'refused', code: (value as { error: string }).error, status: reply.status, ...(wait === undefined ? {} : { retryAfterSeconds: wait }) }
}

/** The signed-in wallet's season, latest count and points (`points` answers only for the session's own wallet). */
export function askPoints<T>(post: RawPost, csrf: string, runtime: PointsRuntime, signal?: AbortSignal): Promise<Exchange<T>> {
  return exchange<T>('points', post, csrf, runtime, {}, signal)
}

/** The wallet's referrer, signed by the wallet over points-v1's referralText. Sent once per click, never retried here. */
export function askLink<T>(post: RawPost, csrf: string, runtime: PointsRuntime, request: { referrer: string; issuedAt: number; signature: string }, signal?: AbortSignal): Promise<Exchange<T>> {
  return exchange<T>('link', post, csrf, runtime, request, signal)
}
