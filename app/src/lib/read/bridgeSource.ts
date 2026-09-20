/**
 * Reads from the same-origin bridge at /api/read/v1/*.
 *
 * Off unless the build enables live data: a disabled source answers every read
 * with `disabled` and never calls fetch. When on, it asks the bridge's
 * capabilities once, sends only routes the deployment lists, and sends each
 * request as a same-origin JSON POST. A screen may also ask whether a route is
 * listed at all (`routeEnabled`), from that same answer and without a POST,
 * before it spends a place in the queue on it. The app adds no credential of its own:
 * no wallet, session, CSRF or Authorization header, and no SIWE, because
 * public reads never need a signature. The browser still attaches every
 * same-origin cookie whose Path covers /api/read/v1/, which includes session-v1's
 * session and preauth cookies once #14 creates them (a __Host- cookie must be
 * Path=/). They go no further than the beta gate: functions/_middleware.ts
 * passes a public read on with no Cookie header at all, and the read bridge
 * would drop one anyway.
 *
 * The URL is a constant prefix plus a route from the contract's closed list.
 * Nothing from a payload or from the page ever selects where a request goes.
 *
 * Every wait here is bounded by R-1's deadlines (pipeline.ts): the shared
 * capabilities answer, each fetch and each body. A read whose caller aborts,
 * or whose deadline passes, settles at once, and what it was waiting for is
 * cancelled unless another read still waits for it. A read whose deadline
 * has already passed sends nothing at all, not even the capabilities GET.
 */
import { MAX_PAGE_BYTES, MAX_RESPONSE_BYTES } from './interpret'
import { REQUEST_READ_CONTRACT } from './pin'
import { BRIDGE_RETRY, realClock, runRead, settleBy, type Clock, type RetryPolicy, type Settled, type Transport } from './pipeline'
import { requestIdOf } from './requestId'
import {
  reroute,
  type FailedOutcome,
  type Provenance,
  type RawBody,
  type RawReply,
  type ReadOptions,
  type ReadOutcome,
  type ReadRequests,
  type ReadRoute,
  type ReadSource,
  type ReadValidators,
  type RequestOf,
  type RouteCheck,
} from './types'

export const READ_PREFIX = '/api/read/v1/'
export const CONTRACT_HEADER = 'X-Domino-Read-Contract'

/** The only headers a read sends. Cookies are the browser's business, not ours. */
export const READ_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  [CONTRACT_HEADER]: REQUEST_READ_CONTRACT,
}

/** The request options of every read, POST and capabilities GET alike. */
export const READ_INIT = {
  mode: 'same-origin',
  // Same-origin only: the beta cookie must reach the gate, and nothing is sent cross-origin.
  // This attaches every cookie whose Path covers the read route; the app cannot pick one out.
  credentials: 'same-origin',
  // A redirect is Access or an edge login, never data. Seen, not followed.
  redirect: 'manual',
  cache: 'no-store',
  referrerPolicy: 'same-origin',
} as const satisfies RequestInit

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/** Closes a body nobody will read. */
function discard(response: Response) {
  try {
    void response.body?.cancel().catch(() => undefined)
  } catch {
    // Locked or already closed: nothing left to release.
  }
}

/**
 * The body, read no further than the bound and no longer than `signal`
 * allows. A declared length over the bound is refused without reading; an
 * undeclared one is counted while streaming. An abort cancels the stream, and
 * a body cut short is never handed on as if it were whole.
 */
async function boundedBody(response: Response, limit: number, signal?: AbortSignal): Promise<RawBody> {
  const declared = response.headers.get('Content-Length')
  if (declared !== null && (!/^\d{1,16}$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel().catch(() => undefined)
    return { kind: 'too_large' }
  }
  if (!response.body) return { kind: 'text', text: '' }
  const reader = response.body.getReader()
  const stop = () => {
    void reader.cancel().catch(() => undefined)
  }
  if (signal?.aborted) {
    stop()
    throw signal.reason
  }
  signal?.addEventListener('abort', stop, { once: true })
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      // A cancelled stream reads as finished; what came before it is not the body.
      if (signal?.aborted) throw signal.reason
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => undefined)
        return { kind: 'too_large' }
      }
      chunks.push(value)
    }
  } finally {
    signal?.removeEventListener('abort', stop)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  } catch {
    return { kind: 'undecodable' }
  }
}

const isJson = (type: string | null) => type !== null && /^application\/json\b/i.test(type)

/** A fetch Response as the pipeline sees it, its body read within `signal`. Exported for the gate tests. */
export async function rawReplyFrom(response: Response, signal?: AbortSignal): Promise<RawReply> {
  const contentType = response.headers.get('Content-Type')
  const opaqueRedirect = response.type === 'opaqueredirect'
  return {
    status: response.status,
    opaqueRedirect,
    contentType,
    contractHeader: response.headers.get(CONTRACT_HEADER),
    requestIdHeader: requestIdOf(response.headers.get('X-Domino-Request-Id')),
    retryAfterHeader: response.headers.get('Retry-After'),
    body: opaqueRedirect ? { kind: 'text', text: '' } : await boundedBody(response, isJson(contentType) ? MAX_RESPONSE_BYTES : MAX_PAGE_BYTES, signal),
  }
}

export interface BridgeOptions {
  /** Closed same-origin namespaces; never supplied by a request or URL parameter. */
  namespace?: 'v1' | 'v2' | 'v3'
  /** CAPABILITIES.liveDataEnabled. False means no request is ever made. */
  enabled: boolean
  validators: ReadValidators
  fetch?: FetchLike
  clock?: Clock
  policy?: RetryPolicy
}

type CapabilityCheck = { ok: true; enabledReads: ReadonlySet<ReadRoute> } | { ok: false; failure: FailedOutcome<'capabilities'> }

/** The capabilities GET in flight or kept, and how many reads wait for it. */
interface SharedCheck {
  result: Promise<CapabilityCheck>
  controller: AbortController
  waiters: number
  settled: boolean
}

/** A bridge source always answers the capabilities question. */
export type BridgeSource = ReadSource & Required<Pick<ReadSource, 'routeEnabled'>>

export function createBridgeSource(options: BridgeOptions): BridgeSource {
  const { enabled, validators, policy = BRIDGE_RETRY, clock = realClock } = options
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init))
  let capabilities: SharedCheck | null = null
  const prefix = options.namespace ? `/api/read/${options.namespace}/` : READ_PREFIX
  const headers = { ...READ_HEADERS, [CONTRACT_HEADER]: validators.CONTRACT_VERSION }

  const transport =
    (path: string, init: RequestInit): Transport =>
    async (_attempt, signal) => {
      const response = await fetchImpl(path, { ...READ_INIT, ...init, signal })
      // A fetch that answered after its attempt was given up: the body is closed unread.
      if (signal.aborted) {
        discard(response)
        throw signal.reason
      }
      return rawReplyFrom(response, signal)
    }

  /**
   * GET capabilities through the same pipeline, validated as the capabilities
   * response. A refusal here, the gate's included, is reported against the
   * read that needed it. A good answer is kept; a failed one is asked again.
   * The Worker answers it itself, so it is not paced and the POST follows at
   * once. Like any attempt it has 20 s.
   */
  function startCheck(): SharedCheck {
    const controller = new AbortController()
    const result = runRead({
      route: 'capabilities',
      request: null,
      transport: transport(`${prefix}capabilities`, { method: 'GET', headers: { Accept: 'application/json', [CONTRACT_HEADER]: validators.CONTRACT_VERSION } }),
      validators,
      policy,
      clock,
      signal: controller.signal,
      label: { transport: 'bridge' },
    }).then((outcome): CapabilityCheck => {
      check.settled = true
      if (outcome.state === 'ok') {
        const reads = outcome.data.dataMode === 'live_read_only' ? outcome.data.enabledReads : []
        return { ok: true, enabledReads: new Set(reads) }
      }
      if (capabilities === check) capabilities = null
      return { ok: false, failure: outcome }
    })
    const check: SharedCheck = { result, controller, waiters: 0, settled: false }
    return check
  }

  /**
   * The shared check, waited for only as long as this read may: its own abort
   * or deadline settles it at once and leaves the check running for the other
   * reads. When the last read waiting leaves, the check is cancelled and
   * forgotten, so the next read asks afresh instead of joining a cancelled one.
   */
  async function capabilitiesFor(signal: AbortSignal | undefined, deadlineAt: number): Promise<Settled<CapabilityCheck>> {
    capabilities ??= startCheck()
    const check = capabilities
    check.waiters += 1
    const settled = await settleBy(clock, check.result, deadlineAt, signal)
    check.waiters -= 1
    if (check.waiters === 0 && !check.settled) {
      if (capabilities === check) capabilities = null
      check.controller.abort()
    }
    return settled
  }

  const stamp = (deadlineAt: number): Provenance => ({ transport: 'bridge', contract: null, receivedAt: clock.now(), receivedMonotonic: clock.monotonic(), attempts: 0, deadlineAt })

  /**
   * The routes this deployment lists, once live reads are on: the shared
   * capabilities answer, or what a read of `route` comes back as without it.
   * Past its deadline nothing is asked, the capabilities GET included:
   * whatever it started would only be abandoned.
   */
  async function listedReads<R extends ReadRoute>(route: R, signal: AbortSignal | undefined, deadlineAt: number): Promise<{ ok: true; reads: ReadonlySet<ReadRoute> } | { ok: false; outcome: FailedOutcome<R> }> {
    const failed = (outcome: FailedOutcome<R>) => ({ ok: false as const, outcome })
    const late = (): FailedOutcome<R> => ({ route, provenance: stamp(deadlineAt), state: 'unavailable', cause: { kind: 'read_deadline', limit: 'read' }, retryable: true })
    if (signal?.aborted) return failed({ route, provenance: stamp(deadlineAt), state: 'aborted' })
    if (clock.monotonic() >= deadlineAt) return failed(late())
    const waited = await capabilitiesFor(signal, deadlineAt)
    if (waited.kind === 'aborted') return failed({ route, provenance: stamp(deadlineAt), state: 'aborted' })
    if (waited.kind === 'deadline') return failed(late())
    const check = waited.value
    if (!check.ok) return failed(reroute(check.failure, route))
    if (check.enabledReads.size === 0) return failed({ route, provenance: stamp(deadlineAt), state: 'disabled', reason: 'bridge_data_mode_disabled' })
    return { ok: true, reads: check.enabledReads }
  }

  return {
    transport: 'bridge',
    async read<R extends ReadRoute>(route: R, request: ReadRequests[R], opts: ReadOptions = {}): Promise<ReadOutcome<R>> {
      const deadlineAt = opts.deadlineAt ?? clock.monotonic() + policy.totalMs
      if (!enabled) return { route, provenance: stamp(deadlineAt), state: 'disabled', reason: 'live_data_disabled' }
      if (!validators.validateRequest(route, request)) return { route, provenance: stamp(deadlineAt), state: 'invalid', reason: 'request_contract' }

      const listed = await listedReads(route, opts.signal, deadlineAt)
      if (!listed.ok) return listed.outcome
      if (!listed.reads.has(route)) return { route, provenance: stamp(deadlineAt), state: 'disabled', reason: 'route_not_enabled' }

      return runRead({
        route,
        request: request as RequestOf<R>,
        transport: transport(`${prefix}${route}`, { method: 'POST', headers, body: JSON.stringify(request) }),
        validators,
        policy,
        clock,
        signal: opts.signal,
        deadlineAt,
        onAttempt: opts.onAttempt,
        label: { transport: 'bridge' },
      })
    },

    /**
     * The same capabilities answer a read would wait for, and nothing more: no
     * POST, and the answer is kept for the next read, so asking first costs no
     * second GET. A refusal comes back as the outcome a read would have had.
     */
    async routeEnabled(route: ReadRoute, opts: Pick<ReadOptions, 'signal' | 'deadlineAt'> = {}): Promise<RouteCheck> {
      const deadlineAt = opts.deadlineAt ?? clock.monotonic() + policy.totalMs
      if (!enabled) return { state: 'failed', outcome: { route, provenance: stamp(deadlineAt), state: 'disabled', reason: 'live_data_disabled' } }
      const listed = await listedReads(route, opts.signal, deadlineAt)
      if (!listed.ok) return { state: 'failed', outcome: listed.outcome }
      return { state: listed.reads.has(route) ? 'enabled' : 'not_enabled' }
    },
  }
}
