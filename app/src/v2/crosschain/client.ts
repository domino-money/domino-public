/**
 * The browser side of crosschain-v1 (spec F7 §3.2-§3.4, §3.7, §3.8): origins, quote and status, each one POST, and one
 * interpretation of the reply in this order (the tests fail if two steps swap):
 *
 *   1. The request: the injected runtime's `validateRequest` and the service's 4096-byte ceiling. A refused request
 *      sends nothing.
 *   2. The transport: an abort, this page's deadline, a network failure, a redirect.
 *   3. No `X-Domino-Crosschain-Contract` header: the beta gate's 401 and 503, a missing route (404, 405, the SPA's
 *      HTML), anything else. None of these is a crosschain answer, and no validator sees them.
 *   4. A header other than exactly the pinned version (./version.ts: 1.1.0-rc.1).
 *   5. JSON media and parsing.
 *   6. 2xx: `validateResponse(route, body)`, then the echo: the answer is about the request this page sent, and
 *      `quote.request.owner` / `status.request.owner` is the connected wallet the caller names (lowercase compare).
 *      The runtime cannot know the wallet, and an answer with the owner rewritten passes it, so this check is what
 *      keeps another wallet's quote or deposit off the screen. A quote that arrived already past its deadline is not
 *      usable either.
 *   7. Anything else: `validateError(status, body)` checks code and status together, then ./errors.ts. A denial goes
 *      to the session's `reportDenial`.
 *
 * Any failure returns no data at all: a reply the validator refused never reaches ./steps.ts, so no wallet step can
 * come from it. Nothing here retries, stores or logs a body; ./polling.ts decides when to ask again.
 */
import { CROSSCHAIN_ERROR_UI } from './errors'
import { classifyHeaderless, CROSSCHAIN_ROUTES, jsonBody, MAX_REQUEST_BYTES, parseRetryAfter, type CrosschainTransport, type TransportResult } from './transport'
import type {
  CrosschainClock,
  CrosschainErrorCode,
  CrosschainRequests,
  CrosschainResponses,
  CrosschainRoute,
  CrosschainSession,
  CrosschainValidators,
  QuotePlan,
} from './types'
import { CROSSCHAIN_CONTRACT } from './version'

export type ContractDetail =
  | 'version'
  | 'header_missing'
  | 'not_json'
  | 'too_large'
  | 'invalid_json'
  | 'response'
  | 'error_body'
  | 'owner'
  | 'echo'
  | 'redirect'
  | 'runtime'

export type CrosschainFailure =
  | { kind: 'error'; code: CrosschainErrorCode; status: number; retryAfterS?: number }
  | { kind: 'gate_required' }
  | { kind: 'gate_unavailable' }
  | { kind: 'not_deployed' }
  | { kind: 'contract'; detail: ContractDetail }
  /** A quote whose deadline had passed when it arrived. */
  | { kind: 'expired' }
  | { kind: 'request_invalid' }
  | { kind: 'network' }
  | { kind: 'timeout' }
  | { kind: 'aborted' }
  | { kind: 'session_gone' }

/** When this page sent the request and read the reply, on its own monotonic clock. */
export interface Timing {
  sentMono: number
  receivedMono: number
}

export type CrosschainOutcome<R extends CrosschainRoute> =
  | { ok: true; route: R; data: CrosschainResponses[R]; timing: Timing; source: CrosschainTransport['kind'] }
  | { ok: false; route: R; failure: CrosschainFailure }

export interface CallOptions {
  /** The wallet connected and signed in, the one every answer must be about. */
  owner: string
  signal?: AbortSignal
}

export interface CrosschainClient {
  readonly transportKind: CrosschainTransport['kind']
  origins(request: CrosschainRequests['origins'], options: CallOptions): Promise<CrosschainOutcome<'origins'>>
  quote(request: CrosschainRequests['quote'], options: CallOptions): Promise<CrosschainOutcome<'quote'>>
  status(request: CrosschainRequests['status'], options: CallOptions): Promise<CrosschainOutcome<'status'>>
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const lower = (value: string) => value.toLowerCase()
const sameText = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && lower(a) === lower(b)

/**
 * When a quote stops being usable, on this page's monotonic clock (onboarding/expiry.ts's rule):
 *
 *   deadline = min( sent     + (expiresAt − requestedAt) · 1000,
 *                   received + (expiresAt − retrievedAt) · 1000 )
 *
 * Both terms are durations the service measured, applied from moments this page observed, so a device clock that
 * runs fast or slow can neither expire a quote early nor keep one alive. `expiresAt = requestedAt + 120` (runtime).
 */
export function quoteDeadlineMono(quote: Pick<QuotePlan, 'requestedAt' | 'retrievedAt' | 'expiresAt'>, timing: Timing): number {
  return Math.min(timing.sentMono + (quote.expiresAt - quote.requestedAt) * 1000, timing.receivedMono + (quote.expiresAt - quote.retrievedAt) * 1000)
}

/** The answer is about the request sent and the connected wallet. Exported for the tests. */
export function echoes<R extends CrosschainRoute>(route: R, sent: CrosschainRequests[R], data: CrosschainResponses[R], owner: string): 'ok' | 'owner' | 'echo' {
  if (route === 'origins') {
    const list = (data as CrosschainResponses['origins']).origins
    const asked = sent as CrosschainRequests['origins']
    return list.destinationChainId === asked.destinationChainId && sameText(list.destinationToken, asked.destinationToken) ? 'ok' : 'echo'
  }
  const echoed = (route === 'quote' ? (data as CrosschainResponses['quote']).quote.request : (data as CrosschainResponses['status']).status.request) as unknown as Record<string, unknown>
  if (!sameText(echoed.owner, owner)) return 'owner'
  const asked = sent as unknown as Record<string, unknown>
  const keys = Object.keys(echoed).filter((key) => key !== 'owner')
  if (keys.length !== Object.keys(asked).length || !keys.every((key) => Object.hasOwn(asked, key))) return 'echo'
  const ok = keys.every((key) => {
    const want = asked[key]
    const got = echoed[key]
    return typeof want === 'string' && typeof got === 'string' ? lower(want) === lower(got) : want === got
  })
  return ok ? 'ok' : 'echo'
}

/** One reply (or the lack of one) as an outcome. Pure; exported for the tests. */
export function interpretCrosschain<R extends CrosschainRoute>(
  route: R,
  sent: CrosschainRequests[R],
  result: TransportResult,
  runtime: CrosschainValidators,
  owner: string,
  timing: Timing,
  source: CrosschainTransport['kind'],
): CrosschainOutcome<R> {
  const fail = (failure: CrosschainFailure): CrosschainOutcome<R> => ({ ok: false, route, failure })
  switch (result.kind) {
    case 'aborted':
      return fail({ kind: 'aborted' })
    case 'timeout':
      return fail({ kind: 'timeout' })
    case 'network':
      return fail({ kind: 'network' })
    case 'reply':
      break
  }
  const reply = result.reply
  if (reply.opaqueRedirect) return fail({ kind: 'contract', detail: 'redirect' })
  if (reply.contractHeader === null) {
    switch (classifyHeaderless(reply)) {
      case 'gate_required':
        return fail({ kind: 'gate_required' })
      case 'gate_unavailable':
        return fail({ kind: 'gate_unavailable' })
      case 'feature_unavailable':
        return fail({ kind: 'not_deployed' })
      case 'unrecognised':
        return fail({ kind: 'contract', detail: 'header_missing' })
    }
  }
  if (reply.contractHeader !== CROSSCHAIN_CONTRACT) return fail({ kind: 'contract', detail: 'version' })
  const body = jsonBody(reply)
  if (!body.ok) return fail({ kind: 'contract', detail: body.reason })
  try {
    if (runtime.CONTRACT_VERSION !== CROSSCHAIN_CONTRACT) return fail({ kind: 'contract', detail: 'runtime' })
    if (reply.status >= 200 && reply.status < 300) {
      if (reply.status !== 200 || !runtime.validateResponse(route, body.value)) return fail({ kind: 'contract', detail: 'response' })
      const data = body.value as CrosschainResponses[R]
      const echo = echoes(route, sent, data, owner)
      if (echo !== 'ok') return fail({ kind: 'contract', detail: echo })
      if (route === 'quote' && quoteDeadlineMono((data as CrosschainResponses['quote']).quote, timing) <= timing.receivedMono) return fail({ kind: 'expired' })
      return { ok: true, route, data, timing, source }
    }
    if (!runtime.validateError(reply.status, body.value)) return fail({ kind: 'contract', detail: 'error_body' })
  } catch {
    return fail({ kind: 'contract', detail: 'runtime' })
  }
  const code = (body.value as { error: CrosschainErrorCode }).error
  const retry = reply.status === 429 || reply.status === 503 ? { retryAfterS: parseRetryAfter(reply.retryAfterHeader) } : {}
  return fail({ kind: 'error', code, status: reply.status, ...retry })
}

export function createCrosschainClient({
  transport,
  runtime,
  session,
  clock,
}: {
  transport: CrosschainTransport
  runtime: CrosschainValidators
  session: CrosschainSession
  clock: CrosschainClock
}): CrosschainClient {
  async function call<R extends CrosschainRoute>(route: R, request: CrosschainRequests[R], { owner, signal }: CallOptions): Promise<CrosschainOutcome<R>> {
    const fail = (failure: CrosschainFailure): CrosschainOutcome<R> => ({ ok: false, route, failure })
    let valid: boolean
    try {
      valid = CROSSCHAIN_ROUTES.includes(route) && typeof owner === 'string' && ADDRESS.test(owner) && runtime.validateRequest(route, request)
    } catch {
      valid = false
    }
    const body = JSON.stringify(request)
    if (!valid || new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) return fail({ kind: 'request_invalid' })
    const sentMono = clock.monoMs()
    let lent: { lent: true; value: TransportResult } | { lent: false }
    try {
      lent = await session.withCsrf((csrf) => transport.send(route, body, { csrf, signal }))
    } catch {
      lent = { lent: true, value: { kind: 'network' } }
    }
    if (!lent.lent) return fail({ kind: 'session_gone' })
    const outcome = interpretCrosschain(route, request, lent.value, runtime, owner, { sentMono, receivedMono: clock.monoMs() }, transport.kind)
    if (!outcome.ok && outcome.failure.kind === 'error') {
      const denial = CROSSCHAIN_ERROR_UI[outcome.failure.code].denial
      if (denial) session.reportDenial(denial)
    }
    return outcome
  }

  return {
    transportKind: transport.kind,
    origins: (request, options) => call('origins', request, options),
    quote: (request, options) => call('quote', request, options),
    status: (request, options) => call('status', request, options),
  }
}
