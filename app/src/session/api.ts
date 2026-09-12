import type {
  SessionErrorCode,
  SessionRequests,
  SessionResponses,
  SessionRoute,
} from 'api-contracts/session-v1/types'

/**
 * The browser side of session-v1: request building and response
 * classification for /api/session/v1/*.
 *
 * Pure apart from the fetch it is given. The contract runtime is injected
 * rather than imported so node tests can drive this with the package's own
 * validators; contract.ts wires the real one for the app.
 *
 * Responses are classified strictly in this order:
 *
 *   1. No response at all            → network_error, timeout or aborted.
 *   2. No session contract header    → not from the session service. The
 *      closed-beta gate (401 beta_access_required, 503 for broken config)
 *      answers this way, and so does the static SPA fallback wherever the
 *      session Worker is not routed. None of these is a session state.
 *   3. Wrong contract version, content type or JSON → contract_mismatch.
 *   4. 200 validated by validateResponse, anything else by validateError.
 */

export type { SessionErrorCode, SessionRoute }

export const SESSION_PATH = '/api/session/v1/'
export const CONTRACT_HEADER = 'X-Domino-Session-Contract'
export const CSRF_HEADER = 'X-Domino-CSRF'
/** The service caps responses at 16 KiB; anything longer did not come from it. */
export const RESPONSE_LIMIT_BYTES = 16384
/** The service gives up at 20 s. A little longer here, so its own 504 arrives first. */
export const CLIENT_TIMEOUT_MS = 25_000

/** The subset of api-contracts/session-v1/runtime.mjs this client uses. */
export interface SessionRuntime {
  readonly CONTRACT_VERSION: string
  readonly ERROR_STATUS_BY_CODE: Readonly<Record<SessionErrorCode, number>>
  validateRequest(route: SessionRoute, value: unknown): boolean
  validateResponse(route: SessionRoute, value: unknown): boolean
  validateError(status: number, value: unknown): boolean
}

export type MismatchDetail = 'version' | 'content_type' | 'json' | 'body' | 'error_body'

export type TransportFailure =
  | { kind: 'session_error'; status: number; code: SessionErrorCode; retryAfterS: number | null }
  | { kind: 'gate_required' }
  | { kind: 'gate_unavailable' }
  | { kind: 'not_routed'; status: number }
  | { kind: 'contract_mismatch'; detail: MismatchDetail }
  /** The contract runtime itself threw, e.g. on a browser without String#isWellFormed. */
  | { kind: 'runtime_error' }
  | { kind: 'network_error' }
  | { kind: 'timeout' }
  | { kind: 'aborted' }

export type RouteOutcome<R extends SessionRoute> =
  | { ok: true; route: R; body: SessionResponses[R]; serverTime: number | null }
  | { ok: false; route: R; failure: TransportFailure; serverTime: number | null }

export type ApiOutcome = { [R in SessionRoute]: RouteOutcome<R> }[SessionRoute]

/** Thrown before anything is sent when a request body fails the contract. */
export class OutgoingContractError extends Error {
  readonly route: SessionRoute
  constructor(route: SessionRoute) {
    super(`The ${route} request does not match session-v1, so it was not sent`)
    this.name = 'OutgoingContractError'
    this.route = route
  }
}

export interface SessionApi {
  bootstrap(signal: AbortSignal): Promise<RouteOutcome<'bootstrap'>>
  challenge(
    body: SessionRequests['challenge'],
    preauthCsrf: string,
    signal: AbortSignal,
  ): Promise<RouteOutcome<'challenge'>>
  verify(body: SessionRequests['verify'], preauthCsrf: string, signal: AbortSignal): Promise<RouteOutcome<'verify'>>
  me(signal: AbortSignal): Promise<RouteOutcome<'me'>>
  refresh(sessionCsrf: string, signal: AbortSignal): Promise<RouteOutcome<'refresh'>>
  /** The session CSRF signs a session out; the preauth CSRF abandons a login. */
  logout(csrf: string, signal: AbortSignal): Promise<RouteOutcome<'logout'>>
}

export interface SessionApiOptions {
  fetch: (input: string, init: RequestInit) => Promise<Response>
  runtime: SessionRuntime
  timeoutMs?: number
}

const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i

/** The body the Pages gate sends to a request without the beta cookie. */
function isGateRefusal(text: string | null): boolean {
  if (text === null) return false
  try {
    const value: unknown = JSON.parse(text)
    return (
      typeof value === 'object' &&
      value !== null &&
      Object.keys(value).length === 1 &&
      (value as { error?: unknown }).error === 'beta_access_required'
    )
  } catch {
    return false
  }
}

/** The body as text, or null once it passes the limit. Never buffers more. */
async function readLimited(response: Response, limit: number): Promise<string | null> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function retryAfter(headers: Headers): number | null {
  const value = headers.get('Retry-After')
  return value !== null && /^\d{1,5}$/.test(value) ? Number(value) : null
}

/** The server's clock from the Date header, used only to place the expiry timer. */
function serverTimeOf(headers: Headers): number | null {
  const value = headers.get('Date')
  if (value === null) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

export function createSessionApi({ fetch: send, runtime, timeoutMs = CLIENT_TIMEOUT_MS }: SessionApiOptions): SessionApi {
  function classify<R extends SessionRoute>(route: R, response: Response, text: string | null): RouteOutcome<R> {
    const serverTime = serverTimeOf(response.headers)
    const failed = (failure: TransportFailure): RouteOutcome<R> => ({ ok: false, route, failure, serverTime })

    const version = response.headers.get(CONTRACT_HEADER)
    if (version === null) {
      if (response.status === 401 && isGateRefusal(text)) return failed({ kind: 'gate_required' })
      if (response.status === 503) return failed({ kind: 'gate_unavailable' })
      return failed({ kind: 'not_routed', status: response.status })
    }
    if (version !== runtime.CONTRACT_VERSION) return failed({ kind: 'contract_mismatch', detail: 'version' })
    if (!JSON_TYPE.test(response.headers.get('Content-Type') ?? '')) {
      return failed({ kind: 'contract_mismatch', detail: 'content_type' })
    }
    if (text === null) return failed({ kind: 'contract_mismatch', detail: 'json' })
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      return failed({ kind: 'contract_mismatch', detail: 'json' })
    }

    try {
      if (response.status === 200) {
        if (!runtime.validateResponse(route, data)) return failed({ kind: 'contract_mismatch', detail: 'body' })
        return { ok: true, route, body: data as SessionResponses[R], serverTime }
      }
      if (!runtime.validateError(response.status, data)) {
        return failed({ kind: 'contract_mismatch', detail: 'error_body' })
      }
    } catch {
      return failed({ kind: 'runtime_error' })
    }
    const code = (data as { error: SessionErrorCode }).error
    return failed({ kind: 'session_error', status: response.status, code, retryAfterS: retryAfter(response.headers) })
  }

  async function call<R extends SessionRoute>(
    route: R,
    body: SessionRequests[R],
    csrf: string | null,
    outer: AbortSignal,
  ): Promise<RouteOutcome<R>> {
    // Refuse to send anything the contract would reject. This is also where a
    // malformed wallet signature stops, before it leaves the page.
    let valid: boolean
    try {
      valid = runtime.validateRequest(route, body)
    } catch {
      return { ok: false, route, failure: { kind: 'runtime_error' }, serverTime: null }
    }
    if (!valid) throw new OutgoingContractError(route)

    const get = route === 'me'
    const headers: Record<string, string> = { [CONTRACT_HEADER]: runtime.CONTRACT_VERSION }
    if (!get) headers['Content-Type'] = 'application/json'
    if (csrf !== null) headers[CSRF_HEADER] = csrf

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const onAbort = () => controller.abort()
    if (outer.aborted) controller.abort()
    else outer.addEventListener('abort', onAbort, { once: true })
    const interrupted = (): RouteOutcome<R> => ({
      ok: false,
      route,
      failure: { kind: timedOut ? 'timeout' : outer.aborted ? 'aborted' : 'network_error' },
      serverTime: null,
    })

    try {
      let response: Response
      try {
        response = await send(SESSION_PATH + route, {
          method: get ? 'GET' : 'POST',
          headers,
          body: get ? undefined : JSON.stringify(body),
          credentials: 'same-origin',
          mode: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          signal: controller.signal,
        })
      } catch {
        return interrupted()
      }
      let text: string | null
      try {
        text = await readLimited(response, RESPONSE_LIMIT_BYTES)
      } catch {
        return interrupted()
      }
      return classify(route, response, text)
    } finally {
      clearTimeout(timer)
      outer.removeEventListener('abort', onAbort)
    }
  }

  return {
    bootstrap: (signal) => call('bootstrap', {}, null, signal),
    challenge: (body, preauthCsrf, signal) => call('challenge', body, preauthCsrf, signal),
    verify: (body, preauthCsrf, signal) => call('verify', body, preauthCsrf, signal),
    // GET me carries no CSRF and no body: it is the read-only recovery route,
    // and a CSRF header there would only be something for the service to reject.
    me: (signal) => call('me', {}, null, signal),
    refresh: (sessionCsrf, signal) => call('refresh', {}, sessionCsrf, signal),
    logout: (csrf, signal) => call('logout', {}, csrf, signal),
  }
}
