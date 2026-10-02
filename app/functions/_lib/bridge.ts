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
 *   functions/api/read/v5/       the featured pools list's one path, which
 *     featured-pools.ts          hands its request to forward() too and
 *                                keeps a valid answer at the edge: 60 s
 *                                fresh, then up to 15 min served while it
 *                                is read again behind (since 2026-09-28)
 *   functions/api/read/v3/       a pool's stored history, which does the
 *     history.ts                 same and keeps a built answer for 20 s
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
 *   1. An origin other than production or the explicitly enabled exact
 *      preview alias's families → 404 not_found. Other Pages deployments,
 *      and a family the preview has not been given, never reach a binding.
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
 * off in source defaults. The exact preview alias gets its families by
 * explicit opt-in only: the public reads (PREVIEW_PUBLIC_READS) and, since
 * 2026-10-01 (H7), each other family named in PREVIEW_FAMILIES. A public
 * family (the reads, the setup release) has its browser boundary checked here
 * and is translated to the Worker's canonical origin, with no cookie. A
 * private family (session, onboarding, deposit, performance, execution) goes
 * on exactly as the browser sent it, its own cookies included, to the binding
 * the preview environment names: that must be a Worker deployed for the
 * preview alias (its APP_ORIGIN), never production's. The beta cookie never
 * crosses. See docs/PREVIEW_PUBLIC_READS.md.
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
  PREVIEW_PUBLIC_READS?: string
  /**
   * The families other than the public reads the exact preview alias may use, by name, comma-separated: setup,
   * session, onboarding, deposit, performance, execution (2026-10-01, H7). Unset or empty: none, as before.
   */
  PREVIEW_FAMILIES?: string
  READ_BRIDGE?: unknown
  SESSION_BRIDGE?: unknown
  ONBOARDING_BRIDGE?: unknown
  DEPOSIT_BRIDGE?: unknown
  PERFORMANCE_BRIDGE?: unknown
  SETUP_BRIDGE?: unknown
  EXECUTION_BRIDGE?: unknown
}

/** The Workers' APP_ORIGIN, exactly: the only origin whose API calls are forwarded. */
export const APP_ORIGIN = 'https://domino.money'
/** The single gated preview alias, never a wildcard for Pages deployments. */
export const PREVIEW_ORIGIN = 'https://preview.domino-app-e65.pages.dev'

interface Family {
  /** Its name in PREVIEW_FAMILIES; the public reads are opted in by PREVIEW_PUBLIC_READS instead. */
  name: string
  prefix: string
  binding: keyof BridgeEnv
  contract: string
  csrf: boolean
  /** The only cookies this family's Worker reads (session-worker.mjs, authenticated-worker.mjs). */
  cookies: readonly string[]
  /**
   * On the preview alias: `public` is translated to the canonical origin, as the reads always were (no cookie, public
   * data, a Worker that answers only https://domino.money); `private` goes on as sent, to a preview Worker of its own.
   */
  preview: 'public' | 'private'
}

const FAMILIES: readonly Family[] = [
  // The setup release: public deployment identities (contract addresses and code hashes), GET only, no cookie.
  { name: 'setup', prefix: '/api/setup/v1/', binding: 'SETUP_BRIDGE', contract: 'x-domino-setup-contract', csrf: false, cookies: [], preview: 'public' },
  { name: 'execution', prefix: '/api/execution/v1/', binding: 'EXECUTION_BRIDGE', contract: 'x-domino-execution-contract', csrf: true, cookies: ['__Host-domino-session'], preview: 'private' },
  { name: 'performance', prefix: '/api/performance/v2/', binding: 'PERFORMANCE_BRIDGE', contract: 'x-domino-performance-contract', csrf: true, cookies: ['__Host-domino-session'], preview: 'private' },
  { name: 'read', prefix: '/api/read/v1/', binding: 'READ_BRIDGE', contract: 'x-domino-read-contract', csrf: false, cookies: [], preview: 'public' },
  { name: 'read', prefix: '/api/read/v2/', binding: 'READ_BRIDGE', contract: 'x-domino-read-contract', csrf: false, cookies: [], preview: 'public' },
  { name: 'read', prefix: '/api/read/v3/', binding: 'READ_BRIDGE', contract: 'x-domino-read-contract', csrf: false, cookies: [], preview: 'public' },
  { name: 'read', prefix: '/api/read/v4/', binding: 'READ_BRIDGE', contract: 'x-domino-read-contract', csrf: false, cookies: [], preview: 'public' },
  // The featured pools list. Its one route, featured-pools, is answered by
  // functions/api/read/v5/featured-pools.ts, which calls forward() itself.
  { name: 'read', prefix: '/api/read/v5/', binding: 'READ_BRIDGE', contract: 'x-domino-read-contract', csrf: false, cookies: [], preview: 'public' },
  {
    name: 'session',
    prefix: '/api/session/v1/',
    binding: 'SESSION_BRIDGE',
    contract: 'x-domino-session-contract',
    csrf: true,
    cookies: ['__Host-domino-preauth', '__Host-domino-session'],
    preview: 'private',
  },
  {
    name: 'onboarding',
    prefix: '/api/onboarding/v1/',
    binding: 'ONBOARDING_BRIDGE',
    contract: 'x-domino-onboarding-contract',
    csrf: true,
    cookies: ['__Host-domino-session'],
    preview: 'private',
  },
  {
    name: 'deposit',
    prefix: '/api/deposit/v1/',
    binding: 'DEPOSIT_BRIDGE',
    contract: 'x-domino-deposit-contract',
    csrf: true,
    cookies: ['__Host-domino-session'],
    preview: 'private',
  },
]

/** The family names PREVIEW_FAMILIES may list: every family but the public reads, which have their own opt-in. */
export const PREVIEW_FAMILY_NAMES: readonly string[] = [...new Set(FAMILIES.map((family) => family.name).filter((name) => name !== 'read'))]

/**
 * Whether the exact preview alias may use `family` in `env`: the public reads by PREVIEW_PUBLIC_READS === "true", any
 * other by its exact name in PREVIEW_FAMILIES (a comma-separated list; spaces around names are ignored, anything else
 * in it names nothing).
 */
function previewAllows(env: BridgeEnv, family: Family): boolean {
  if (family.name === 'read') return env.PREVIEW_PUBLIC_READS === 'true'
  if (typeof env.PREVIEW_FAMILIES !== 'string') return false
  return env.PREVIEW_FAMILIES.split(',').map((name) => name.trim()).includes(family.name)
}

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

type Refusal = 'not_found' | 'origin_not_allowed' | 'worker_subrequest_refused' | 'bridge_unavailable'

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

/** Check the real browser BEFORE translating this fixed public alias.
 * Mirrors the read and setup Workers' browser checks: a foreign Origin/Host or
 * a cross-site navigation must never become an admitted request by remapping.
 * A GET may omit Origin where those Workers allow it (the read capabilities,
 * the setup release); a POST must name the preview alias.
 */
function isPreviewBrowserRead(request: Request, url: URL, family: Family): boolean {
  const host = request.headers.get('host')
  if (host !== null && host !== url.host) return false
  const capability = request.method === 'GET' && (/^\/api\/read\/v[1-5]\/capabilities$/.test(url.pathname) || family.binding === 'SETUP_BRIDGE')
  const origin = request.headers.get('origin')
  if ((!capability || origin !== null) && origin !== PREVIEW_ORIGIN) return false
  for (const [name, accepted] of [
    ['sec-fetch-site', ['same-origin']],
    ['sec-fetch-mode', ['cors', 'same-origin']],
    ['sec-fetch-dest', ['empty']],
  ] as const) {
    const value = request.headers.get(name)
    if (value !== null && !(accepted as readonly string[]).includes(value)) return false
  }
  return !request.headers.has('sec-fetch-user')
}

export async function forward(request: Request, env: BridgeEnv): Promise<Response> {
  const url = new URL(request.url)
  const preview = url.origin === PREVIEW_ORIGIN
  if (url.origin !== APP_ORIGIN && !preview) return refuse('not_found', 404)
  const family = familyOf(url.pathname)
  if (!family) return refuse('not_found', 404)
  if (preview && !previewAllows(env, family)) return refuse('not_found', 404)
  // A public family is translated below, so its browser is checked first; a private one keeps its own origin, which
  // its preview Worker checks itself, as production's do.
  const translate = preview && family.preview === 'public'
  if (translate && !isPreviewBrowserRead(request, url, family)) return refuse('origin_not_allowed', 403)

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

  // Only a validated, fixed public alias is translated. There is no
  // caller-supplied target, no credential forwarding and no private family.
  if (translate) {
    headers.set('host', new URL(APP_ORIGIN).host)
    if (headers.has('origin')) headers.set('origin', APP_ORIGIN)
  }

  let response: unknown
  try {
    const forwarded = new Request(request, { headers })
    // Production stays on its existing path. Preview keeps its path, query,
    // method, body, signal and contract, changing only the vetted origin.
    response = await bridge.fetch(translate
      ? new Request(`${APP_ORIGIN}${url.pathname}${url.search}`, forwarded)
      : forwarded)
  } catch {
    return refuse('bridge_unavailable', 503)
  }
  // Set-Cookie and every other header of the Worker's answer pass through.
  return response instanceof Response ? response : refuse('bridge_unavailable', 503)
}
