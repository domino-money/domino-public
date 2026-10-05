/**
 * `position-plan-v1` over same-origin HTTP (spec F7 rev2 §2.4): `POST /api/position-plan/v1/plan`, a JSON body, the
 * session cookie (the browser's business), `X-Domino-CSRF` and `X-Domino-Position-Plan-Contract: 1.0.0-rc.2`.
 * Changed on purpose (data) 2026-10-02 (Domino V2 integration, the base agent's item 5): wired by src/finance/v2/http.ts
 * (`livePlanTransport`: the page's POST and the signed-in session's CSRF, through `createSessionPlanTransport` below),
 * which src/v2in/transports.ts uses under the gate's `live` only, and only while the route's capabilities say it serves
 * (src/v2/routes.ts). The route is the bridge's (bridge/src/position-plan-worker.mjs), off until its flag.
 *
 * The POST itself is injected, as src/v2/crosschain/httpTransport.ts does: lib/http/rawReply.ts's `fetchRaw` bound to
 * the page's fetch and clock, which sends with `mode: 'same-origin'`, `credentials: 'same-origin'` and
 * `redirect: 'manual'`, and reads a bounded body. A reply without the contract header did not come from the plan route
 * (the beta gate, the SPA's fallback, a missing route): its body is never read as the contract's. Sending a request
 * never sends a wallet transaction.
 */
import { S1_PLAN_CONTRACT_VERSION, S1_PLAN_HEADER, S1_PLAN_PATH, type S1PlanTransport } from './types'

/**
 * lib/http/rawReply.ts's reply shapes, restated structurally (src/v2 may not import the consumer directories, nor S2's
 * own modules: tests/consumer.guard.test.mjs, tests/v2/crosschain-source.test.mjs), as src/v2/crosschain/transport.ts
 * restates them for itself.
 */
export type RawBody = { kind: 'text'; text: string } | { kind: 'too_large' } | { kind: 'undecodable' }
export interface RawReply {
  status: number
  opaqueRedirect: boolean
  contentType: string | null
  /** `X-Domino-Position-Plan-Contract`. */
  contractHeader: string | null
  requestIdHeader: string | null
  retryAfterHeader: string | null
  body: RawBody
}
export type TransportResult = { kind: 'reply'; reply: RawReply } | { kind: 'network' } | { kind: 'timeout' } | { kind: 'aborted' }

export const CSRF_HEADER = 'X-Domino-CSRF'
const JSON_MEDIA = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i

/** The JSON body of a reply, or null when it has none this route could have sent. */
function jsonBody(reply: RawReply): unknown {
  if (reply.contentType === null || !JSON_MEDIA.test(reply.contentType) || reply.body.kind !== 'text') return null
  try {
    return JSON.parse(reply.body.text) as unknown
  } catch {
    return null
  }
}

/** The service's own limits (§2.4): an 8 KiB body, an answer up to 384 KiB, 20 s per request (the Worker's budget just above). */
export const S1_PLAN_MAX_REQUEST_BYTES = 8 * 1024
export const S1_PLAN_MAX_RESPONSE_BYTES = 384 * 1024
export const S1_PLAN_TIMEOUT_MS = 22_000

/** lib/http/rawReply.ts `fetchRaw` without its fetch and clock arguments. */
export type RawPost = (
  url: string,
  init: { headers: Record<string, string>; body: string },
  options: { contractHeader: string; maxBytes: number; timeoutMs: number; signal?: AbortSignal },
) => Promise<TransportResult>

export function createHttpS1PlanTransport({ post, csrf }: { post: RawPost; csrf: () => string | null }): S1PlanTransport {
  return {
    kind: 'http',
    async plan(request) {
      const token = csrf()
      if (!token) throw new Error('session_required')
      const body = JSON.stringify(request)
      if (new TextEncoder().encode(body).length > S1_PLAN_MAX_REQUEST_BYTES) throw new Error('request_too_large')
      const result = await post(
        S1_PLAN_PATH,
        {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            [S1_PLAN_HEADER]: S1_PLAN_CONTRACT_VERSION,
            [CSRF_HEADER]: token,
          },
          body,
        },
        { contractHeader: S1_PLAN_HEADER, maxBytes: S1_PLAN_MAX_RESPONSE_BYTES, timeoutMs: S1_PLAN_TIMEOUT_MS },
      )
      if (result.kind !== 'reply') throw new Error(result.kind)
      const reply = result.reply
      // Not the plan route's: no contract body to read.
      if (reply.contractHeader !== S1_PLAN_CONTRACT_VERSION) return { status: reply.status, body: null }
      return { status: reply.status, body: jsonBody(reply) }
    },
  }
}

/**
 * The V1 session the plan's CSRF is lent by (session/port.ts SessionPort, as much of it as this uses, restated: src/v2
 * may not import the session's modules). `epoch()` is the signed-in session's epoch, or null; `withCsrf` runs `fn` with
 * the CSRF only while that session is still the signed-in one, and says `{ ok: false }` (nothing run) otherwise.
 */
export interface PlanSession {
  readonly csrfAccess: boolean
  epoch(): number | null
  withCsrf<T>(epoch: number, fn: (csrf: string) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }>
}

/**
 * The plan transport with the signed-in session's CSRF, lent for one request and never kept. Refused unsent
 * (`session_required`, which the plan client says as unavailable) without a signed-in session, without CSRF access, or
 * when the session changed before the request could be made.
 */
export function createSessionPlanTransport({ post, session }: { post: RawPost; session: PlanSession }): S1PlanTransport {
  return {
    kind: 'http',
    async plan(request) {
      const epoch = session.epoch()
      if (epoch === null || !session.csrfAccess) throw new Error('session_required')
      const lent = await session.withCsrf(epoch, (csrf) => createHttpS1PlanTransport({ post, csrf: () => csrf }).plan(request))
      if (!lent.ok) throw new Error('session_required')
      return lent.value
    },
  }
}
