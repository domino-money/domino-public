/**
 * Runs before every request the deployment receives: pages, assets and /api/*.
 *
 * See functions/_lib/gate.ts for why the gate exists and what it proves.
 * The rules, in order:
 *
 *   1. Missing or weak configuration        → 503 for everything.
 *   2. www.domino.money                     → 301 to the apex.
 *   3. POST /__beta/login                   → set the access cookie, or 401.
 *   4. POST /__beta/logout                  → clear it.
 *   5. Valid access cookie                  → the app, with security headers.
 *   6. Anything else                        → 401: the access page for a
 *      navigation, a JSON error for assets and API calls.
 */
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

/** The part of Cloudflare's Pages Functions context this middleware uses. */
export interface GateContext {
  request: Request
  env: BetaEnv
  next: () => Promise<Response>
}

export const LOGIN_PATH = '/__beta/login'
export const LOGOUT_PATH = '/__beta/logout'
const CANONICAL_HOST = 'domino.money'
const MAX_FORM_BYTES = 1024

/**
 * The app's CSP. Scripts, styles and images from this origin only, plus the
 * Google Fonts stylesheet and font files index.html already loads.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ')

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
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
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

/** The app's own response, with the security headers every page must carry. */
function secured(response: Response, url: URL): Response {
  const out = new Response(response.body, response)
  for (const [name, value] of Object.entries(BASE_HEADERS)) out.headers.set(name, value)
  out.headers.append('Vary', 'Cookie')
  const type = out.headers.get('Content-Type') ?? ''
  if (type.includes('text/html')) {
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

export async function onRequest({ request, env, next }: GateContext): Promise<Response> {
  const url = new URL(request.url)
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
    return secured(await next(), url)
  }
  return wantsPage(request) ? page('ask', 401) : json('beta_access_required', 401)
}
