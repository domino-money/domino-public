/**
 * The fixed API forwarder: the one place a browser request is handed to a
 * bridge Worker.
 *
 * rugged97 accepted this ingress on #45: Pages gate → fixed API forwarder →
 * private service binding. In code:
 *
 *   functions/_middleware.ts     beta gate, host allowlist, response headers
 *   functions/api/[[path]].ts    every /api/* request the gate admits, but
 *                                one with an empty segment, which the
 *                                middleware hands to forward() itself
 *   forward() below              one fixed prefix → one fixed binding
 *   env.<SVC>_BRIDGE.fetch()     that family's Worker from bridge/src
 *
 * The request chooses nothing but its family. The Worker gets the original
 * URL, method and body, because its own checks compare url.origin with its
 * APP_ORIGIN, and a header set rebuilt from an allowlist: the beta cookie,
 * credentials meant for anything else and forwarding headers never leave.
 *
 * Refusals, in this order. Each is JSON and none carries an
 * X-Domino-*-Contract header, so an outside check can always tell this
 * forwarder from a Worker:
 *
 *   1. An origin other than https://domino.money  → 404 not_found. First on
 *      purpose: a preview or pages.dev host never reaches a binding, even one
 *      bound there by mistake.
 *   2. No family owns the path. None owns a path   → 404 not_found.
 *      with an empty segment, such as
 *      /api/read/v1//capabilities
 *   3. A CF-Worker header                          → 403 worker_subrequest_refused.
 *   4. The family's binding is missing or is not   → 503 bridge_unavailable.
 *      a service binding
 *   5. The binding throws or answers no Response   → 503 bridge_unavailable.
 *
 * The four bindings are production's only: app/wrangler.toml declares them
 * as [[env.production.services]], one per family below, each naming its
 * bridge Worker (domino-read-bridge, domino-session-bridge,
 * domino-onboarding-bridge, domino-deposit-bridge), deployed with every flag
 * off. A preview has none, and its API calls end at refusal 1.
 * tests/forwarder.test.mjs checks that the names looked up here are the names
 * wrangler.toml binds.
 */

/** What a service binding offers its caller. */
export interface Fetcher {
  fetch(request: Request): Promise<Response>
}

/**
 * One binding per family. Typed unknown because a deployment can put anything
 * under these names (a text variable, an unrelated binding, nothing at all);
 * forward() checks what it finds before calling it.
 */
export interface BridgeEnv {
  READ_BRIDGE?: unknown
  SESSION_BRIDGE?: unknown
  ONBOARDING_BRIDGE?: unknown
  DEPOSIT_BRIDGE?: unknown
}

/** The Workers' APP_ORIGIN, exactly: the only origin whose API calls are forwarded. */
const APP_ORIGIN = 'https://domino.money'

interface Family {
  prefix: string
  binding: keyof BridgeEnv
  contract: string
  csrf: boolean
  /** The only cookies this family's Worker reads (session-worker.mjs, authenticated-worker.mjs). */
  cookies: readonly string[]
}

const FAMILIES: readonly Family[] = [
  { prefix: '/api/read/v1/', binding: 'READ_BRIDGE', contract: 'x-domino-read-contract', csrf: false, cookies: [] },
  { prefix: '/api/read/v2/', binding: 'READ_BRIDGE', contract: 'x-domino-read-contract', csrf: false, cookies: [] },
  {
    prefix: '/api/session/v1/',
    binding: 'SESSION_BRIDGE',
    contract: 'x-domino-session-contract',
    csrf: true,
    cookies: ['__Host-domino-preauth', '__Host-domino-session'],
  },
  {
    prefix: '/api/onboarding/v1/',
    binding: 'ONBOARDING_BRIDGE',
    contract: 'x-domino-onboarding-contract',
    csrf: true,
    cookies: ['__Host-domino-session'],
  },
  {
    prefix: '/api/deposit/v1/',
    binding: 'DEPOSIT_BRIDGE',
    contract: 'x-domino-deposit-contract',
    csrf: true,
    cookies: ['__Host-domino-session'],
  },
]

/**
 * Request headers the Workers read, copied as they arrived. Everything else
 * stays here: Authorization, Accept-Encoding, X-Forwarded-*, Forwarded,
 * X-Real-IP, CF-Access-*, Cf-Access-Jwt-Assertion, every other X-Domino-*.
 *
 * Content-Encoding and Transfer-Encoding stay here too. No browser compresses
 * a fetch() body, and every Worker refuses a Content-Encoding other than
 * identity (worker.mjs, session-worker.mjs, authenticated-worker.mjs).
 * Without the header a Worker takes the bytes it is given as identity, and no
 * other reader of this body exists: the Worker sends its own upstream request
 * with its own headers, never the browser's. So there is no second
 * interpretation of the body to play against the first, and the Worker's
 * strict UTF-8 and JSON parsing refuses compressed bytes. Transfer-Encoding is
 * framing between the edge and this function; the runtime frames the
 * forwarded body itself.
 */
const PASS = [
  'content-type',
  'content-length',
  'origin',
  'host',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
] as const

type Refusal = 'not_found' | 'worker_subrequest_refused' | 'bridge_unavailable'

function refuse(code: Refusal, status: number): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    },
  })
}

function isFetcher(value: unknown): value is Fetcher {
  return typeof value === 'object' && value !== null && 'fetch' in value && typeof value.fetch === 'function'
}

/** A cookie part's name, read exactly the way the Workers read it. */
function cookieName(part: string): string {
  const index = part.indexOf('=')
  return (index < 0 ? part : part.slice(0, index)).trim()
}

/**
 * The Cookie header a family may see: its own cookie parts only, verbatim and
 * in order, or null when none is left. A duplicate stays a duplicate, so the
 * Worker's own "exactly one" check still refuses it. The beta cookie and every
 * unrelated cookie stay here, and the read family never gets a Cookie header.
 */
function familyCookies(raw: string | null, names: readonly string[]): string | null {
  if (raw === null || names.length === 0) return null
  const kept = raw
    .split(';')
    .filter((part) => names.includes(cookieName(part)))
    .map((part) => part.trim())
  return kept.length > 0 ? kept.join('; ') : null
}

/**
 * The family that owns a path: the one whose prefix starts it. No family owns
 * a path with an empty segment. Pages' route for functions/api/[[path]].ts
 * never matches one, so the middleware sends such a path here itself, and it
 * is refused like any other path no family owns: a Worker is never handed a
 * path Pages would not have routed to the forwarder.
 */
function familyOf(pathname: string): Family | undefined {
  if (pathname.includes('//')) return undefined
  return FAMILIES.find((family) => pathname.startsWith(family.prefix))
}

export async function forward(request: Request, env: BridgeEnv): Promise<Response> {
  const url = new URL(request.url)
  if (url.origin !== APP_ORIGIN) return refuse('not_found', 404)
  const family = familyOf(url.pathname)
  if (!family) return refuse('not_found', 404)

  // Cloudflare adds CF-Worker, naming the calling Worker's zone, to every
  // subrequest a Worker sends with fetch(). Such a request is not a browser's,
  // and in a same-zone subrequest CF-Connecting-IP is whatever the calling
  // script put in x-real-ip, so its client IP proves nothing. This refusal is
  // defense in depth only: the primary control is the owner's WAF rule on
  // cf.worker.upstream_zone, which the edge fills in itself and applies before
  // Pages runs. A header check cannot replace it.
  if (request.headers.has('CF-Worker')) return refuse('worker_subrequest_refused', 403)

  const bridge = env[family.binding]
  if (!isFetcher(bridge)) return refuse('bridge_unavailable', 503)

  const headers = new Headers()
  for (const name of [...PASS, family.contract, ...(family.csrf ? ['x-domino-csrf'] : [])]) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  // The client address the edge wrote on this request. The Worker hands it to
  // its gateway as the caller's identity for rate limits; a binding cannot
  // vouch for it, which is why a Worker's subrequest was refused above.
  const ip = request.headers.get('CF-Connecting-IP')
  if (ip !== null) headers.set('CF-Connecting-IP', ip)
  const cookie = familyCookies(request.headers.get('Cookie'), family.cookies)
  if (cookie !== null) headers.set('Cookie', cookie)

  let response: unknown
  try {
    // The original URL, method and body. Only the headers are rebuilt.
    response = await bridge.fetch(new Request(request, { headers }))
  } catch {
    return refuse('bridge_unavailable', 503)
  }
  // Set-Cookie and every other header of the Worker's answer pass through.
  return response instanceof Response ? response : refuse('bridge_unavailable', 503)
}
