/**
 * Reads from the same-origin bridge at /api/read/v1/*.
 *
 * Off unless the build enables live data: a disabled source answers every read
 * with `disabled` and never calls fetch. When on, it asks the bridge's
 * capabilities at most once a minute while reads continue, sends only routes the deployment lists, and sends each
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
 * or whose deadline passes, settles at once, and its own request is
 * cancelled. The shared capabilities GET is not: it runs to its end (20 s an
 * attempt, up to 60 s on a validated 429, BRIDGE_RETRY) and a good answer is
 * kept, but a read joins it only for its first CAPABILITIES_JOIN_MS (changed
 * 2026-10-30, INST-1b). A read whose deadline has already passed sends
 * nothing at all, not even the capabilities GET.
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
/** `hit` from a Pages Function that answered from its edge cache (functions/_lib/featuredEdge.ts, publicEdge.ts). */
export const EDGE_CACHE_HEADER = 'X-Domino-Edge-Cache'
/** How old, in ms, a kept answer was when it left the edge (functions/_lib/publicEdge.ts, 2026-10-01). */
export const EDGE_AGE_HEADER = 'X-Domino-Edge-Age'
/**
 * The oldest an edge answer can honestly be: anything else is no age at all. Changed on purpose 2026-10-30 (launch
 * capacity, item 4): an hour, the featured list's stand-in at the edge (functions/_lib/featuredEdge.ts ERROR_SECONDS),
 * so a list kept past its 15 minutes through an outage is dated by its real age, not by when it arrived.
 */
const EDGE_AGE_MAX_MS = 60 * 60_000

/** The edge's age header as ms, when it is a plain whole number within EDGE_AGE_MAX_MS; undefined otherwise. */
export function edgeAgeOf(value: string | null): number | undefined {
  if (value === null || !/^\d{1,9}$/.test(value)) return undefined
  const ms = Number(value)
  return ms <= EDGE_AGE_MAX_MS ? ms : undefined
}
/** Revalidate on the next read, with no polling timer or provider/RPC read. */
export const CAPABILITIES_REUSE_MS = 60_000
/**
 * (2026-10-15, pack 7): how long a good answer that lists routes is kept: five minutes, was CAPABILITIES_REUSE_MS. A page
 * that reads each minute (a position page's chart, Markets' table) asked the capabilities again with every read. An answer
 * that lists nothing keeps CAPABILITIES_REUSE_MS, so a route switched on is seen as soon as before; a read of a listed
 * route refused as not there (route_not_available) or as another contract brings the kept answer back to
 * CAPABILITIES_REUSE_MS from when it came, so the next GET is never sooner than it was.
 */
export const CAPABILITIES_KEEP_MS = 300_000
/**
 * How long a capabilities GET still in flight is joined by a read that comes (2026-10-30, INST-1b review). The Worker
 * answers it itself, in well under a second; one still out after this has stalled (a phone changing networks, say), and
 * the read asks afresh rather than wait out the rest of its attempt. The stalled one still runs, and a good answer it
 * brings later is kept.
 */
export const CAPABILITIES_JOIN_MS = 5_000

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
    ...(response.headers.get(EDGE_CACHE_HEADER) === 'hit' ? { edgeHit: true as const } : {}),
    ...(edgeAgeOf(response.headers.get(EDGE_AGE_HEADER)) !== undefined ? { edgeAgeMs: edgeAgeOf(response.headers.get(EDGE_AGE_HEADER)) } : {}),
    body: opaqueRedirect ? { kind: 'text', text: '' } : await boundedBody(response, isJson(contentType) ? MAX_RESPONSE_BYTES : MAX_PAGE_BYTES, signal),
  }
}

export interface BridgeOptions {
  /** Closed same-origin namespaces; never supplied by a request or URL parameter. */
  namespace?: 'v1' | 'v2' | 'v3' | 'v5'
  /** CAPABILITIES.liveDataEnabled. False means no request is ever made. */
  enabled: boolean
  /**
   * False: a read is POSTed without asking the capabilities first, and its own answer (route_not_available when the
   * route is off) says whether it is on. read-v5's featured list only (lib/read/featuredList.ts, 2026-09-26): one
   * request on Home's critical path instead of two. Absent or true: the capabilities are asked, as before.
   */
  askCapabilities?: boolean
  validators: ReadValidators
  fetch?: FetchLike
  /**
   * A reply already on its way for an attempt, taken instead of sending one: the featured list's and read-v3's
   * capabilities, which the page's boot script (functions/_lib/boot.ts) sent before the app started (lib/read/earlyList.ts, 2026-09-28),
   * and since 2026-10-01 (audit A7 b) the stored overview of the list's pools, taken only by a request with that very
   * body. Null: the attempt is sent. One that fails to arrive sends the attempt after all.
   */
  first?: (path: string, method: string, body?: string) => Promise<Response> | null
  clock?: Clock
  policy?: RetryPolicy
}

type CapabilityCheck = { ok: true; enabledReads: ReadonlySet<ReadRoute> } | { ok: false; failure: FailedOutcome<'capabilities'> }

/** The capabilities GET in flight or kept. */
interface SharedCheck {
  result: Promise<CapabilityCheck>
  settled: boolean
  /** When it was sent, on the monotonic clock: a read joins it while it is unsettled for CAPABILITIES_JOIN_MS at most. */
  startedAt: number
  expiresAt: number
  /** The answer, once settled: what a read past its minute may still use for a route it lists (A22). */
  value?: CapabilityCheck
  /** When a good answer came (2026-10-15, pack 7): CAPABILITIES_REUSE_MS is counted from it when a read is refused. */
  answeredAt?: number
}

/** A bridge source always answers the capabilities question. */
export type BridgeSource = ReadSource & Required<Pick<ReadSource, 'routeEnabled'>>

export function createBridgeSource(options: BridgeOptions): BridgeSource {
  const { enabled, validators, policy = BRIDGE_RETRY, clock = realClock } = options
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init))
  let capabilities: SharedCheck | null = null
  /** A check asked behind a good answer past its minute (A22), until it settles. */
  let renewing: SharedCheck | null = null
  const prefix = options.namespace ? `/api/read/${options.namespace}/` : READ_PREFIX
  const headers = { ...READ_HEADERS, [CONTRACT_HEADER]: validators.CONTRACT_VERSION }

  const transport =
    (path: string, init: RequestInit): Transport =>
    async (_attempt, signal) => {
      const send = () => fetchImpl(path, { ...READ_INIT, ...init, signal })
      const early = options.first?.(path, init.method ?? 'GET', typeof init.body === 'string' ? init.body : undefined) ?? null
      const response = await (early ? early.catch(send) : send())
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
   * read that needed it. A good answer is kept for one minute; a failed one is asked again.
   * The Worker answers it itself, so it is not paced and the POST follows at
   * once. Like any attempt it has 20 s.
   */
  function startCheck(): SharedCheck {
    const result = runRead({
      route: 'capabilities',
      request: null,
      transport: transport(`${prefix}capabilities`, { method: 'GET', headers: { Accept: 'application/json', [CONTRACT_HEADER]: validators.CONTRACT_VERSION } }),
      validators,
      policy,
      clock,
      label: { transport: 'bridge' },
    }).then((outcome): CapabilityCheck => {
      check.settled = true
      if (outcome.state === 'ok') {
        const reads = outcome.data.dataMode === 'live_read_only' ? outcome.data.enabledReads : []
        // (2026-10-15, pack 7): five minutes for an answer that lists routes, the minute for one that lists none.
        check.answeredAt = clock.monotonic()
        check.expiresAt = check.answeredAt + (reads.length > 0 ? CAPABILITIES_KEEP_MS : CAPABILITIES_REUSE_MS)
        check.value = { ok: true, enabledReads: new Set(reads) }
        // A check a later read stopped joining (CAPABILITIES_JOIN_MS) that answers well after all: kept while no answer
        // is, so the next read uses it instead of waiting for the one asked after it.
        if (capabilities !== check && (capabilities === null || !capabilities.settled)) capabilities = check
        return check.value
      }
      if (capabilities === check) capabilities = null
      return { ok: false, failure: outcome }
    })
    const check: SharedCheck = { result, settled: false, startedAt: clock.monotonic(), expiresAt: 0 }
    return check
  }

  /**
   * The shared check, waited for only as long as this read may: its own abort
   * or deadline settles it at once and leaves the check running. The check
   * runs to its end even when the last read waiting leaves, bounded by its own
   * attempts (20 s each, up to 60 s on a validated 429, BRIDGE_RETRY): the
   * Worker answers it without the VM, a good answer is kept for the reads that
   * follow, and a read that comes within CAPABILITIES_JOIN_MS of its start
   * joins it. A read that comes later, while it is still out, has it stalled:
   * that read sends a fresh GET, which the reads after it join, and the old one
   * runs on (a good answer it brings first is still kept). Changed 2026-10-30
   * (instability study, INST-1b; revised after review the same day):
   * cancelling it when its last waiter left meant a page that kept leaving (a
   * hidden tab's aborted refresh, a screen changed mid-read) never kept an
   * answer and sent a new GET, and a new cancelled request, every time; joining
   * a stalled one without limit held the next screen's reads for the rest of
   * its attempt, where the cancelled one's successor got through at once.
   */
  async function capabilitiesFor(signal: AbortSignal | undefined, deadlineAt: number, route?: ReadRoute): Promise<Settled<CapabilityCheck>> {
    // (2026-10-15, pack 7): an answer is past its time at CAPABILITIES_KEEP_MS for a route it lists, but still at its minute
    // (CAPABILITIES_REUSE_MS, as before) for a route it does not list, so a route switched on is seen as soon as before.
    const at = clock.monotonic()
    const unlisted = route === undefined || !(capabilities?.value?.ok && capabilities.value.enabledReads.has(route))
    const minuteOld = capabilities?.answeredAt !== undefined && at >= capabilities.answeredAt + CAPABILITIES_REUSE_MS
    const stale = capabilities?.settled && (at >= capabilities.expiresAt || (unlisted && minuteOld)) ? capabilities : null
    if (stale && route !== undefined && stale.value?.ok && stale.value.enabledReads.has(route)) {
      // Changed 2026-10-01 (audit A22): an answer past its minute that lists the route asked for is used at once while a
      // new check runs behind, instead of holding this read 100 to 200 ms for it; a route it lists that was switched off
      // since answers route_not_available to the read itself, which says so as before. One that does not list it is
      // asked again first, as before, so a route switched on is used at once. The check behind replaces the kept one
      // when it is good, and a failure there leaves nothing kept: the next read asks afresh and waits, as before.
      const kept = stale
      if (renewing === null) {
        const next = startCheck()
        renewing = next
        void next.result.then((check) => {
          if (renewing === next) renewing = null
          if (capabilities === kept) capabilities = check.ok ? next : null
        })
      }
      return settleBy(clock, kept.result, deadlineAt, signal)
    }
    if (stale) capabilities = null
    if (capabilities && !capabilities.settled && at - capabilities.startedAt > CAPABILITIES_JOIN_MS) capabilities = null
    capabilities ??= startCheck()
    return settleBy(clock, capabilities.result, deadlineAt, signal)
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
    const waited = await capabilitiesFor(signal, deadlineAt, route)
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

      if (options.askCapabilities !== false) {
        const listed = await listedReads(route, opts.signal, deadlineAt)
        if (!listed.ok) return listed.outcome
        if (!listed.reads.has(route)) return { route, provenance: stamp(deadlineAt), state: 'disabled', reason: 'route_not_enabled' }
      } else if (opts.signal?.aborted) return { route, provenance: stamp(deadlineAt), state: 'aborted' }

      const outcome = await runRead({
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
      // (2026-10-15, pack 7): the bridge refused a route its kept capabilities list (route_not_available), or answered as
      // another contract: that answer stands no longer than CAPABILITIES_REUSE_MS from when it came, as before.
      if ((outcome.state === 'disabled' && outcome.reason === 'route_not_enabled') || outcome.state === 'incompatible') {
        const kept = capabilities
        if (kept?.settled && kept.answeredAt !== undefined) kept.expiresAt = Math.min(kept.expiresAt, kept.answeredAt + CAPABILITIES_REUSE_MS)
      }
      return outcome
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
