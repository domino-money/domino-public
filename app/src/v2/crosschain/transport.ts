/**
 * How a crosschain-v1 request leaves the page (spec F7 §3.2): `POST /api/crosschain/v1/<route>`, a JSON body, the
 * session cookie, `X-Domino-CSRF` and `X-Domino-Crosschain-Contract: 1.0.0-rc.1`. Two kinds:
 *
 *   fixture  scripted replies from the package fixtures (./fixtureTransport.ts), for the node tests and a future lab.
 *            Nothing leaves the page.
 *   http     same-origin POSTs through the forwarder (./httpTransport.ts). Changed on purpose (data) 2026-10-02 (S2
 *            wired): wired by src/finance/v2/http.ts for the inline offer; the forwarder's family and the Worker exist,
 *            the Worker's deployment and binding are the dashboard's (./forwarder.ts).
 *
 * The reply shapes are lib/http/rawReply.ts's, restated structurally (src/v2 may not import the consumer directories,
 * tests/consumer.guard.test.mjs GUARD-5), with the three reading rules the client applies before any validator:
 * the header-less classification, the JSON body and Retry-After. PHASE B can swap these for lib/http's own once the
 * guard admits src/v2/crosschain (see the module report).
 */
import type { CrosschainRoute } from './types'

export const CROSSCHAIN_PREFIX = '/api/crosschain/v1/'
export const CSRF_HEADER = 'X-Domino-CSRF'
/** Just above the Worker's 25 s budget (bridge/src/onboarding-worker.mjs, which the crosschain Worker will mirror), so its own 504 is what is seen. */
export const CROSSCHAIN_TIMEOUT_MS = 27_000
/** The service's own request ceiling: crosschain_models.MAX_BODY = 4096. */
export const MAX_REQUEST_BYTES = 4096
/** The service's own reply ceiling: crosschain_models.MAX_RESPONSE = 262144. */
export const MAX_RESPONSE_BYTES = 256 * 1024
export const CROSSCHAIN_ROUTES: readonly CrosschainRoute[] = Object.freeze(['origins', 'quote', 'status'])

export type RawBody = { kind: 'text'; text: string } | { kind: 'too_large' } | { kind: 'undecodable' }

/** lib/read/types.ts `RawReply`, field for field. */
export interface RawReply {
  status: number
  opaqueRedirect: boolean
  contentType: string | null
  /** `X-Domino-Crosschain-Contract`. */
  contractHeader: string | null
  requestIdHeader: string | null
  retryAfterHeader: string | null
  body: RawBody
}

/** lib/http/rawReply.ts `TransportResult`, case for case. */
export type TransportResult =
  | { kind: 'reply'; reply: RawReply }
  | { kind: 'network' }
  | { kind: 'timeout' }
  | { kind: 'aborted' }

export interface CrosschainTransport {
  readonly kind: 'fixture' | 'http'
  send(route: CrosschainRoute, body: string, options: { csrf: string; signal?: AbortSignal }): Promise<TransportResult>
}

/** The gate's JSON refusal, byte for byte as functions/_middleware.ts sends it. */
export const GATE_REFUSAL = '{"error":"beta_access_required"}'
const JSON_MEDIA = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i
const SAFE_SECONDS = /^(0|[1-9]\d{0,15})$/

/**
 * A reply without the contract header did not come from the crosschain Worker: the beta gate's 401 JSON, the gate's
 * 503 page, a missing route (404, 405, or the SPA's HTML fallback), or anything else.
 */
export function classifyHeaderless(reply: RawReply): 'gate_required' | 'gate_unavailable' | 'feature_unavailable' | 'unrecognised' {
  const text = reply.body.kind === 'text' ? reply.body.text : null
  const json = reply.contentType !== null && /^application\/json\b/i.test(reply.contentType)
  if (reply.status === 401 && text === GATE_REFUSAL) return 'gate_required'
  if (reply.status === 503 && !json) return 'gate_unavailable'
  if (reply.status === 404 || reply.status === 405) return 'feature_unavailable'
  if (reply.status === 200 && reply.contentType !== null && /^text\/html\b/i.test(reply.contentType)) return 'feature_unavailable'
  return 'unrecognised'
}

/** `Retry-After` in whole seconds, 1 to 60; anything else means 60. */
export function parseRetryAfter(header: string | null): number {
  if (header === null || !SAFE_SECONDS.test(header)) return 60
  const seconds = Number(header)
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 60 ? seconds : 60
}

/** The JSON body of a reply, or why there is none. */
export function jsonBody(reply: RawReply): { ok: true; value: unknown } | { ok: false; reason: 'not_json' | 'too_large' | 'invalid_json' } {
  if (reply.contentType === null || !JSON_MEDIA.test(reply.contentType)) return { ok: false, reason: 'not_json' }
  if (reply.body.kind === 'too_large') return { ok: false, reason: 'too_large' }
  if (reply.body.kind === 'undecodable') return { ok: false, reason: 'invalid_json' }
  try {
    return { ok: true, value: JSON.parse(reply.body.text) as unknown }
  } catch {
    return { ok: false, reason: 'invalid_json' }
  }
}
