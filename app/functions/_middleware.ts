/**
 * Runs before every request the deployment receives: pages, assets and /api/*.
 *
 * See functions/_lib/gate.ts for why the gate exists and what it proves.
 * The rules, in order:
 *
 *   0. Production only: a host other than   → 404, as JSON.
 *      domino.money or www.domino.money
 *   1. Missing or weak configuration        → 503 for everything.
 *   2. www.domino.money                     → 301 to the apex.
 *   3. POST /__beta/login                   → set the access cookie, or 401.
 *   4. POST /__beta/logout                  → clear it.
 *   5. Valid access cookie                  → the app, with security headers.
 *      A public read (/api/read/*) is passed on without any cookie.
 *   6. Anything else                        → 401: the access page for a
 *      navigation, a JSON error for assets and API calls.
 *
 * Rule 0 holds where CANONICAL_HOSTS_ONLY is "true", which wrangler.toml sets
 * for production only. A production deployment then answers on its own hosts
 * and none of its pages.dev or hash URLs is an entrance; previews keep the gate.
 *
 * An API call that passes rule 5 goes on to the fixed forwarder:
 *
 *   /api/* → functions/api/[[path]].ts → forward() in functions/_lib/bridge.ts
 *          → the family's private service binding → its bridge Worker
 *
 * The one exception is a path with an empty segment, such as /api//x: Pages'
 * route never hands it to functions/api/[[path]].ts, so this middleware hands
 * it to forward() itself (see onward()), and forward() refuses it.
 *
 * Whatever comes back, the Worker's answer or the forwarder's refusal, leaves
 * with Cache-Control "no-store, no-transform" and a CSP that renders nothing.
 */
import { forward, type BridgeEnv } from './_lib/bridge'
import {
  PAGE_CSP,
  accessPage,
  clearCookie,
  hasValidCookie,
  isPassword,
  issueCookie,
  readConfig,
  type BetaConfig,
  type BetaEnv,
  type PageState,
} from './_lib/gate'

/** The part of Cloudflare's Pages Functions context the gate uses. */
export interface GateContext {
  request: Request
  env: BetaEnv
  /** The rest of the deployment; given a request, it serves that one instead. */
  next: (request?: Request) => Promise<Response>
}

export const LOGIN_PATH = '/__beta/login'
export const LOGOUT_PATH = '/__beta/logout'
/** Public reads. The read bridge serves /api/read/v1/*; any later version sits under the same prefix. */
export const PUBLIC_READ_PREFIX = '/api/read/'
const CANONICAL_HOST = 'domino.money'
const MAX_FORM_BYTES = 1024

/**
 * Optional decorative token metadata/images use only the two explicitly
 * authorized public DEX Screener hosts. No Domino credentials are forwarded.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: https://cdn.dexscreener.com",
  "connect-src 'self' https://api.dexscreener.com",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ')

/** The CSP for an API answer: JSON that renders nothing and frames nowhere. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'"

/**
 * The /api paths: /api itself and everything under /api/, in any case. Pages
 * hands every one of them to functions/api/[[path]].ts but a path with an
 * empty segment; see onward().
 */
const API_PATH = /^\/api(?:\/|$)/i

/**
 * Browser capabilities the site never uses, switched off so nothing injected
 * into a page can reach them. USB, HID, serial and Bluetooth are deliberately
 * left alone: hardware wallets reach the browser through them, and the wallet
 * connection will need them when it exists.
 */
export const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'browsing-topics=()',
  'camera=()',
  'display-capture=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
].join(', ')

const BASE_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow',
  'Permissions-Policy': PERMISSIONS_POLICY,
  // Severs any cross-origin page that opens this one, while still letting a
  // future wallet popup opened *by* this page talk back to it.
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  // Our responses may only be loaded by our own pages.
  'Cross-Origin-Resource-Policy': 'same-origin',
}

function page(state: PageState, status: number): Response {
  return new Response(accessPage(state), {
    status,
    headers: {
      ...BASE_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': PAGE_CSP,
    },
  })
}

function json(code: string, status: number): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: {
      ...BASE_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': API_CSP,
    },
  })
}

function seeOther(location: string, cookie: string): Response {
  return new Response(null, {
    status: 303,
    headers: { ...BASE_HEADERS, Location: location, 'Cache-Control': 'no-store', 'Set-Cookie': cookie },
  })
}

/** A page navigation, as opposed to a script, image or API call. */
function wantsPage(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  const mode = request.headers.get('Sec-Fetch-Mode')
  if (mode !== null) return mode === 'navigate'
  return (request.headers.get('Accept') ?? '').includes('text/html')
}

/** A form post from this site's own page, when the browser says where it came from. */
function sameOriginPost(request: Request, url: URL): boolean {
  const origin = request.headers.get('Origin')
  if (origin !== null && origin !== url.origin) return false
  const site = request.headers.get('Sec-Fetch-Site')
  return site === null || site === 'same-origin' || site === 'none'
}

/** The request body as text, or null once it passes the limit. Never buffers more. */
async function readForm(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get('Content-Length') ?? '0')
  if (declared > MAX_FORM_BYTES) return null
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_FORM_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

async function login(request: Request, url: URL, config: BetaConfig): Promise<Response> {
  if (request.method !== 'POST') return seeOther('/', clearCookie())
  if (!sameOriginPost(request, url)) return json('origin_not_allowed', 403)
  const type = (request.headers.get('Content-Type') ?? '').toLowerCase()
  if (!type.startsWith('application/x-www-form-urlencoded')) return json('form_required', 415)
  const body = await readForm(request)
  if (body === null) return json('request_too_large', 413)
  const password = new URLSearchParams(body).get('password') ?? ''
  if (!(await isPassword(config, password))) return page('wrong', 401)
  return seeOther('/', await issueCookie(config, Date.now()))
}

function logout(request: Request, url: URL): Response {
  if (request.method !== 'POST' || !sameOriginPost(request, url)) return json('method_not_allowed', 405)
  return seeOther('/', clearCookie())
}

/**
 * A public read as it goes on past the gate: the same request with no Cookie
 * header at all.
 *
 * The browser sends every same-origin cookie whose Path covers the read, and
 * session-v1's `__Host-domino-session` and `__Host-domino-preauth` must be
 * `Path=/` (the `__Host-` prefix requires it). The beta cookie has done its
 * job once the gate has checked it, and a public read needs no other, so none
 * of them reaches the read bridge or anything behind it. This holds whatever
 * the bridge does with cookies, and costs a read nothing: no read route takes
 * a credential.
 */
function withoutCookies(request: Request): Request {
  const headers = new Headers(request.headers)
  headers.delete('Cookie')
  return new Request(request, { headers })
}

/** The app's own response, with the security headers every page must carry. */
function secured(response: Response, url: URL): Response {
  const out = new Response(response.body, response)
  for (const [name, value] of Object.entries(BASE_HEADERS)) out.headers.set(name, value)
  out.headers.append('Vary', 'Cookie')
  const type = out.headers.get('Content-Type') ?? ''
  if (API_PATH.test(url.pathname)) {
    // Never stored, never transformed on the way, never rendered as a page,
    // whatever the Worker or the forwarder sent. A Worker's no-store is kept
    // and tightened, never relaxed to the app's private, no-cache.
    out.headers.set('Cache-Control', 'no-store, no-transform')
    out.headers.set('Content-Security-Policy', API_CSP)
  } else if (type.includes('text/html')) {
    out.headers.set('Content-Security-Policy', APP_CSP)
    out.headers.set('Cache-Control', 'private, no-cache')
  } else if (url.pathname.startsWith('/assets/')) {
    // Content-hashed by Vite, so safe to keep, but only in this browser.
    out.headers.set('Cache-Control', 'private, max-age=31536000, immutable')
  } else {
    out.headers.set('Cache-Control', 'private, no-cache')
  }
  return out
}

/** onRequest's context: the gate's part, plus the bindings forward() reads. */
type Context = GateContext & { env: BridgeEnv }

/**
 * Where a request goes once the gate admits it. Pages hands
 * functions/api/[[path]].ts only the paths its route, /api/:path*, matches,
 * and its matcher, path-to-regexp 6.3.0 as wrangler 4.130.0 bundles it, takes
 * non-empty segments only. An /api path with an empty segment, such as /api//x
 * or /api/read/v1//capabilities, would fall through to the static files and be
 * answered with index.html and a 200. Such a path goes to forward() from here,
 * which refuses it. Every other request goes to Pages' next(), which routes
 * the rest of /api to functions/api/[[path]].ts.
 */
function onward(context: Context, url: URL): GateContext['next'] {
  if (!API_PATH.test(url.pathname) || !url.pathname.includes('//')) return context.next
  // Like Pages' next(): handed a request, it forwards that one instead.
  return (passed?: Request) => forward(passed ?? context.request, context.env)
}

export async function onRequest(context: Context): Promise<Response> {
  const { request, env } = context
  const url = new URL(request.url)
  // Called only once the gate admits the request (rule 5).
  const next = onward(context, url)
  // Rule 0, before the configuration, login and cookie are looked at.
  const canonical = url.hostname === CANONICAL_HOST || url.hostname === `www.${CANONICAL_HOST}`
  if (env.CANONICAL_HOSTS_ONLY === 'true' && !canonical) return json('not_found', 404)

  const config = await readConfig(env)
  if (!config) return page('unavailable', 503)

  if (url.hostname === `www.${CANONICAL_HOST}`) {
    return new Response(null, {
      status: 301,
      headers: { ...BASE_HEADERS, Location: `https://${CANONICAL_HOST}${url.pathname}${url.search}` },
    })
  }

  if (url.pathname === LOGIN_PATH) return login(request, url, config)
  if (url.pathname === LOGOUT_PATH) return logout(request, url)

  if (await hasValidCookie(config, request.headers.get('Cookie'), Date.now())) {
    const read = url.pathname.startsWith(PUBLIC_READ_PREFIX)
    return secured(await (read ? next(withoutCookies(request)) : next()), url)
  }
  return wantsPage(request) ? page('ask', 401) : json('beta_access_required', 401)
}
