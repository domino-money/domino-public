/**
 * Reads served from rugged97's package fixtures, through the real pipeline.
 *
 * Each reply is dressed the way the bridge would send it: a gateway fixture as
 * a 200 with the contract header, an error fixture with the status the fixture
 * index gives it, and the gate's own 401 and 503 bytes exactly as
 * functions/_middleware.ts writes them. The pipeline then treats it like any
 * other reply, so a fixture passes the same gate, header and runtime checks a
 * live read would, including the ones that must fail.
 *
 * A script is a list of replies per route. A reply may name the exact request
 * it answers; the replies that fit a request are served in order, one per
 * attempt, the last repeating. A request no reply fits gets the bridge's 422,
 * which is how a test proves a pagination cursor went back exactly as received.
 */
import { GATE_PAGE_MARKER, GATE_REFUSAL } from './interpret'
import { REQUEST_READ_CONTRACT } from './pin'
import { BRIDGE_RETRY, realClock, runRead, type Clock, type RetryPolicy } from './pipeline'
import type { RawReply, ReadOptions, ReadOutcome, ReadRequests, ReadRoute, ReadSource, ReadValidators, RequestOf } from './types'

/** The package's fixture index plus every fixture's text, keyed by package-relative path. */
export interface FixtureCatalog {
  index: { contractVersion: string; fixtures: Array<{ file: string; kind: string; route: string; status: number; valid: boolean }>; requests: Array<{ file: string; route: string }> }
  text: (path: string) => string
}

/** Replies no fixture file describes: the gate, the edge and broken transports. */
export type Transport =
  | 'gate401'
  | 'gate503'
  | 'edgeHtml502'
  | 'spaHtml200'
  | 'opaqueRedirect'
  | 'network'
  | 'headerMissing'
  | 'headerRc2'
  | 'notJson'
  | 'malformedJson'
  | 'tooLarge'

export interface ReplyScript {
  /** Package-relative path, e.g. `fixtures/gateway/token.success.json`. */
  fixture?: string
  /** Changes a parsed clone of the fixture before it is sent. */
  mutate?: (body: unknown) => unknown
  transport?: Transport
  retryAfter?: string
  /** The exact request this reply answers; any other gets the bridge's 422. */
  expectRequest?: unknown
}

export type RouteScript = Partial<Record<ReadRoute, ReplyScript[]>>

/** The gate's 503 page, reduced to what identifies it. The real bytes are tested against the real middleware. */
const GATE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8" />${GATE_PAGE_MARKER}</head><body><h1>Access is paused.</h1></body></html>`

const reply = (status: number, contentType: string | null, text: string, contract: string | null = REQUEST_READ_CONTRACT, retryAfter: string | null = null): RawReply => ({
  status,
  opaqueRedirect: false,
  contentType,
  contractHeader: contract,
  requestIdHeader: null,
  retryAfterHeader: retryAfter,
  body: { kind: 'text', text },
})

const JSON_TYPE = 'application/json; charset=utf-8'

/** JSON with object keys sorted, so two requests compare by content, never by key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const sameJson = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b)

export interface FixtureOptions {
  catalog: FixtureCatalog
  validators: ReadValidators
  script: RouteScript
  clock?: Clock
  /** Retry as the bridge would; defaults to one attempt with no waiting. */
  policy?: RetryPolicy
}

export interface FixtureSource extends ReadSource {
  /** Every request received, in order, for tests to inspect. */
  readonly requests: Array<{ route: ReadRoute; request: unknown }>
}

const ONE_ATTEMPT: RetryPolicy = { ...BRIDGE_RETRY, maxAttempts: 1 }

export function createFixtureSource({ catalog, validators, script, clock = realClock, policy = ONE_ATTEMPT }: FixtureOptions): FixtureSource {
  const statusOf = new Map(catalog.index.fixtures.map((entry) => [entry.file, entry.status]))
  const served = new Map<string, number>()
  const requests: Array<{ route: ReadRoute; request: unknown }> = []

  function build(step: ReplyScript | null): RawReply {
    // No reply fits this request: what the bridge says to a body it refuses.
    if (step === null) return reply(422, JSON_TYPE, '{"error":"invalid_request"}')
    switch (step.transport) {
      case 'gate401':
        return reply(401, 'application/json; charset=utf-8', GATE_REFUSAL, null)
      case 'gate503':
        return reply(503, 'text/html; charset=utf-8', GATE_PAGE, null)
      case 'edgeHtml502':
        return reply(502, 'text/html; charset=UTF-8', '<html><body>Bad gateway</body></html>', null)
      case 'spaHtml200':
        return reply(200, 'text/html; charset=utf-8', '<!doctype html><div id="root"></div>', null)
      case 'opaqueRedirect':
        return { ...reply(0, null, '', null), opaqueRedirect: true }
      case 'network':
        throw new TypeError('Failed to fetch')
      default:
        break
    }
    if (!step.fixture) throw new Error('A reply script needs a fixture or a transport')
    const status = statusOf.get(step.fixture)
    if (status === undefined) throw new Error(`${step.fixture} is not in the fixture index`)
    let text = catalog.text(step.fixture)
    if (step.mutate) text = JSON.stringify(step.mutate(JSON.parse(text)))
    switch (step.transport) {
      case 'headerMissing':
        return reply(status, JSON_TYPE, text, null)
      case 'headerRc2':
        return reply(status, JSON_TYPE, text, '1.1.0-rc.2')
      case 'notJson':
        return reply(status, 'text/plain; charset=utf-8', text)
      case 'malformedJson':
        return reply(status, JSON_TYPE, text.trimEnd().slice(0, -1))
      case 'tooLarge':
        return { ...reply(status, JSON_TYPE, ''), body: { kind: 'too_large' } }
      default:
        return reply(status, JSON_TYPE, text, REQUEST_READ_CONTRACT, step.retryAfter ?? null)
    }
  }

  return {
    transport: 'fixture',
    requests,
    async read<R extends ReadRoute>(route: R, request: ReadRequests[R], opts: ReadOptions = {}): Promise<ReadOutcome<R>> {
      requests.push({ route, request })
      const steps = script[route]
      const provenance = { transport: 'fixture' as const, contract: null, receivedAt: clock.now(), attempts: 0 }
      // The bridge validates requests too; a fixture must not accept what it would refuse.
      if (!validators.validateRequest(route, request)) return { route, provenance, state: 'invalid', reason: 'request_contract' }
      if (!steps || steps.length === 0) return { route, provenance, state: 'disabled', reason: 'route_not_enabled' }
      const fitting = steps.filter((step) => step.expectRequest === undefined || sameJson(step.expectRequest, request))
      const key = `${route} ${canonicalJson(request)}`
      const pick = (): ReplyScript | null => {
        if (fitting.length === 0) return null
        const n = served.get(key) ?? 0
        served.set(key, n + 1)
        return fitting[Math.min(n, fitting.length - 1)]
      }
      const chosen: Array<ReplyScript | null> = []
      return runRead({
        route,
        request: request as RequestOf<R>,
        transport: async () => {
          const step = pick()
          chosen.push(step)
          return build(step)
        },
        validators,
        policy,
        clock,
        signal: opts.signal,
        deadlineAt: opts.deadlineAt,
        onAttempt: opts.onAttempt,
        label: { transport: 'fixture', fixture: (attempt) => chosen[attempt - 1]?.fixture?.replace(/^fixtures\//, '') },
      })
    },
  }
}
