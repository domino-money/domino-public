/**
 * Runs before every request the deployment receives: pages, assets, /api/* and
 * /uniswap-v3/*.
 *
 * See functions/_lib/gate.ts for why the gate exists and what it proves.
 * The rules, in order:
 *
 *   0. Production only: a host other than   → 404, as JSON.
 *      domino.money or www.domino.money
 *   1. Missing or weak configuration        → 503 for everything.
 *   2. www.domino.money                     → 301 to the apex.
 *   3. GET /favicon.ico and the access      → the file, with no cookie needed:
 *      page's two fonts (UNGATED)             public files, nothing of the app.
 *   4. POST /__beta/login                   → set the access cookie, or 401;
 *                                             429 after too many wrong tries.
 *   5. POST /__beta/logout                  → clear it.
 *   6. Valid access cookie                  → the app, with security headers;
 *      A public read (/api/read/*),           a page served with a cookie more
 *      /uniswap-v3/* and the six chain        than a day old renews it.
 *      routes are passed on without any
 *      cookie.
 *   7. Anything else                        → 401: the access page for a
 *                                             navigation, a JSON error for
 *                                             assets and API calls.
 *
 * 2026-11-06 (the owner: the password comes off for the public launch): where
 * BETA_GATE is exactly "off" (functions/_lib/gate.ts gateOpen) the gate is
 * open, and the rules read:
 *
 *   0. As above.
 *   1. Skipped: the secrets are neither needed nor read, so a deployment
 *      without them opens too.
 *   2. As above.
 *   3. As above.
 *   4. /__beta/login, any method          → 303 to /, no cookie set or read.
 *   5. /__beta/logout, any method         → 303 to /, no cookie set or read.
 *   6. Everything else                    → served as rule 6 serves a visitor
 *                                             with a valid cookie: the same
 *                                             headers, CSP, caching, cookie
 *                                             stripping and forward(); no
 *                                             cookie is renewed.
 *   7. Never reached.
 *
 * Any other value, in another case, with a space, empty or not set at all,
 * is the gate above, byte for byte. Opening never needs the secrets deleted
 * or changed, and setting BETA_GATE to anything else (or deleting it) closes
 * the site again: a beta cookie still inside its week then works as before.
 * app/docs/OPEN_THE_SITE.md has the owner's steps.
 *
 * 2026-11-07 (the owner: Domino in Google): in rule 6, a page (a GET or HEAD of a path that names no file) answers at its
 * own address with its own head, a 301 from an older name or a trailing slash, and a 404 where the app has nothing; the
 * noindex every answer carries is lifted only on domino.money with SEARCH_INDEX exactly "on", for the pages listed for
 * search, the favicon and the shared picture (functions/_lib/seo.ts). The gate's own answers are unchanged; its access
 * page carries the asked page through the password as the `#/…` route it always carried.
 *
 * Rule 0 holds where CANONICAL_HOSTS_ONLY is "true", which wrangler.toml sets
 * for production only. A production deployment then answers on its own hosts
 * and none of its pages.dev or hash URLs is an entrance; previews keep the gate.
 *
 * An API call that passes rule 6 goes on to the fixed forwarder:
 *
 *   /api/* → functions/api/[[path]].ts → forward() in functions/_lib/bridge.ts
 *          → the family's private service binding → its bridge Worker
 *
 * The one exception is a path with an empty segment, such as /api//x: Pages'
 * route never hands it to functions/api/[[path]].ts, so this middleware hands
 * it to forward() itself (see onward()), and forward() refuses it.
 *
 * Whatever comes back, the Worker's answer or the forwarder's refusal, leaves
 * with Cache-Control "no-store, no-transform" and a CSP that renders nothing;
 * a public read, "no-store" alone, so the edge may compress it (2026-09-28).
 *
 * 2026-10-01 (RPC-SPEC §2.7): Domino's own chain routes (CHAIN_ROUTE, answered
 * from Domino's own Robinhood Chain node by functions/_lib/chainRoutes.ts) go
 * on as a public read does: with no cookie at all, and their answers leave
 * with "no-store" alone (a list's fees ledgers can be a megabyte).
 *
 * 2026-10-01 (the chain2 workstream, part B, audit G9): /uniswap-v3/* is an API
 * path too, rugged97's Uniswap v3 services for the second chain's section
 * (functions/uniswap-v3/[[path]].ts). Behind the gate it is passed on with no
 * cookie at all, as a public read is, and its answer leaves as every API
 * answer does. Where CHAIN2_PREVIEW is "true" (wrangler.toml sets it for the
 * preview environment alone) the page's CSP also names the second chain's RPC,
 * so the section, open there, can read it; production's CSP is unchanged.
 * Changed on purpose 2026-10-02 (review of the RPC switch, finding 1): that
 * RPC is a public node, so the section is closed everywhere for now
 * (src/chains/elysium/mode.ts SECTION_READS) and the preview's CSP names no
 * host of it either: APP_CSP_CHAIN2 is production's policy until then.
 *
 * 2026-10-01 (RPC-SPEC §7.4, the owner's rule: nothing is read from a public
 * RPC): the page's CSP names no Robinhood Chain RPC any more. The page reaches
 * this site, DEX Screener and WalletConnect's relay. Changed on purpose
 * 2026-10-02 (RPC-SPEC §11.4): the fees replay worker is gone, and its own CSP
 * with it; every hashed file gets STATIC_CSP.
 */
import { forward, type BridgeEnv } from './_lib/bridge'
import { BOOT_SCRIPT_HASH } from './_lib/boot'
import { ELYSIUM } from '../src/config/chains'
import { withChains } from '../src/lib/chain/csp'
import { SECTION_READS } from '../src/chains/elysium/mode'
import { askedRoute, pageFromFiles, pageRedirect, pageRequest, searchRobots, shapePage, type SearchEnv } from './_lib/seo'
import {
  GATE_FONTS,
  PAGE_CSP,
  accessPage,
  clearCookie,
  cookieExpiry,
  createLoginLimiter,
  gateOpen,
  isPassword,
  issueCookie,
  nextHash,
  readConfig,
  renewable,
  type BetaConfig,
  type BetaEnv,
  type PageState,
} from './_lib/gate'

/**
 * The middleware's own setting (2026-10-01, the chain2 workstream, part B), on its own context rather than in
 * functions/_lib/bridge.ts, whose bytes the read-v2 contract pins: "true" makes the page's CSP name the second chain's
 * RPC (APP_CSP_CHAIN2). wrangler.toml sets it in [env.preview.vars] only; anything else, or nothing, keeps production's
 * policy. The /uniswap-v3/ route reads the same name for itself (functions/_lib/uniswap-v3/edge.ts UniswapV3Env).
 */
export interface Chain2Env {
  CHAIN2_PREVIEW?: string
}

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
/**
 * Domino's own chain routes (2026-10-01, RPC-SPEC §2.7): functions/api/owned/v2/positions.ts, fees/v1/state.ts,
 * fees/v2/ledger.ts (2026-10-02, RPC-SPEC §11.4: in place of fees/v1/logs.ts), automation/v1/{state,record}.ts and
 * chain/v1/simulate.ts, each a fixed read of Domino's own node. Like a public read, an admitted request goes on with no
 * cookie (none of them takes a credential) and its answer may be compressed on the way. In any case, as Pages routes a
 * path to them.
 */
export const CHAIN_ROUTE = /^\/api\/(?:owned\/v2\/positions|fees\/(?:v1\/state|v2\/ledger)|automation\/v1\/(?:state|record)|chain\/v1\/(?:simulate|confirmation))$/i
const CANONICAL_HOST = 'domino.money'
const MAX_FORM_BYTES = 1024

/**
 * The page's CSP, one directive per row and one source per line (2026-10-01, platform workstream: data, so a workstream
 * that needs a host adds one line to one list and merges never fight over one long string).
 *
 * - script-src: the site's own files, and the page's one inline script, the boot script, by its hash
 *   (functions/_lib/boot.ts). Each HTML response also carries a fresh cryptographic nonce: Cloudflare reads it from
 *   this header and applies it to its JavaScript Detection tags. This keeps that protection compatible with CSP
 *   without unsafe-inline, extra hosts or trusting arbitrary inline scripts. The boot script still uses its hash;
 *   neither its bytes nor the HTML need rewriting. See Cloudflare's JavaScript Detections CSP documentation.
 * - style-src, font-src: the site's own files; the fonts are its own since 2026-09-28 (src/styles/fonts.css), and no
 *   Google host is reached.
 * - img-src, connect-src: the two public DEX Screener hosts token artwork uses (the metadata endpoint's same GET also
 *   names the pool ids New position asks the read service to verify, src/lib/read/screens/poolHints.ts; nothing it
 *   reports is shown). No Domino credentials are forwarded to either. Changed on purpose 2026-10-01 (RPC-SPEC §7.4, the
 *   owner's rule: nothing is read from a public RPC): Robinhood Chain's public RPC and its three public fallbacks, named
 *   here since 2026-09-25 and 2026-09-28, are gone: every chain read is this site's ('self': the read bridge and the
 *   site's own chain routes).
 * - connect-src, frame-src (2026-10-01, audit C3, the owner's OK): WalletConnect, for a wallet on a phone, and nothing
 *   else of it: its relay (wss://relay.walletconnect.org), which carries the session's end-to-end encrypted messages,
 *   and its Verify API's frame (https://verify.walletconnect.org), which attests this origin to the wallet before it
 *   pairs. Reached only after the person picks WalletConnect, from its own lazy chunk (src/wallet/walletConnect.ts);
 *   telemetry is off, and no read goes to WalletConnect's RPC service (the site serves a WalletConnect wallet none,
 *   src/lib/walletReads.ts). The relay sits with the page's own sources, as src/lib/chain/csp.ts PAGE_CONNECT_BASE writes
 *   them, so the policy a second chain's RPC is added to keeps it (tests/chain-csp.test.mjs holds the two equal).
 */
export const APP_CSP_SOURCES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'default-src': ["'self'"],
  'script-src': [
    "'self'",
    BOOT_SCRIPT_HASH,
  ],
  'style-src': ["'self'"],
  'font-src': ["'self'"],
  'img-src': [
    "'self'",
    'data:',
    'https://cdn.dexscreener.com',
  ],
  'connect-src': [
    "'self'",
    'https://api.dexscreener.com',
    'wss://relay.walletconnect.org',
  ],
  'frame-src': [
    'https://verify.walletconnect.org',
  ],
  'object-src': ["'none'"],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
})

/** A CSP header from its directives, in their order. */
export const cspOf = (sources: Readonly<Record<string, readonly string[]>>) =>
  Object.entries(sources)
    .map(([directive, list]) => [directive, ...list].join(' '))
    .join('; ')

export const APP_CSP = cspOf(APP_CSP_SOURCES)

/**
 * The page's CSP where the second chain's section is open (2026-10-01, the chain2 workstream, part B): production's
 * policy with the second chain's RPC named in connect-src too, after the page's own sources (src/lib/chain/csp.ts
 * withChains: the page's own sources, WalletConnect's relay among them, then every RPC origin of the chains named, each
 * once). Every other directive is APP_CSP's. Served only where CHAIN2_PREVIEW is "true" (Chain2Env), which
 * wrangler.toml sets for the preview environment alone: the section reads that chain only where its own flag is open
 * (src/chains/elysium/mode.ts), and production names no host of a chain it does not read. Changed on purpose
 * 2026-10-01 (RPC-SPEC §7.4): Robinhood Chain is no longer among the chains named, since the browser reads no RPC of
 * it; the Elysium testnet's RPC stays, on the preview alone (RPC-SPEC §7.12, pending rugged97). Changed on purpose
 * 2026-10-02 (review of the RPC switch, finding 1; the owner's rule: the site reads nothing from a public RPC, on the
 * preview too): that RPC is named only while the section may read it (src/chains/elysium/mode.ts SECTION_READS, false
 * until rugged97 serves its reads through this site's own route), so today this is production's policy exactly.
 */
export const APP_CSP_CHAIN2 = withChains(APP_CSP, SECTION_READS ? [ELYSIUM] : [])

/** The page's CSP in `env`: APP_CSP_CHAIN2 where CHAIN2_PREVIEW is exactly "true", APP_CSP everywhere else. */
export const pageCspFor = (env: Chain2Env): string => (env.CHAIN2_PREVIEW === 'true' ? APP_CSP_CHAIN2 : APP_CSP)

/** Cloudflare adds this response's nonce to the scripts it injects; never shared across responses or cached here. */
function withDetectionNonce(policy: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const nonce = btoa(String.fromCharCode(...bytes))
  return policy.replace('script-src ', `script-src 'nonce-${nonce}' `)
}

/** The CSP for an API answer: JSON that renders nothing and frames nowhere. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'"

/**
 * Every other file the site serves that is not a page: scripts, styles, fonts, images (2026-10-01, I8). None of them
 * is a document, so none needs to run or load anything as one: an SVG opened on its own draws its shapes and its
 * inline styles and nothing else. The page keeps its own policy; a CSP on a script the page loads does not apply to it.
 */
export const STATIC_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'"

/**
 * The /api paths: /api itself and everything under /api/, in any case. Pages
 * hands every one of them to functions/api/[[path]].ts but a path with an
 * empty segment; see onward().
 *
 * 2026-10-01 (the chain2 workstream, part B): and /uniswap-v3 with everything
 * under it, in any case, which Pages hands to functions/uniswap-v3/[[path]].ts
 * the same way: an API answer, never a page.
 */
const API_PATH = /^\/(?:api|uniswap-v3)(?:\/|$)/i

/**
 * The second chain's service paths (2026-10-01, the chain2 workstream, part B): passed on past the gate with no cookie
 * at all, as a public read is (withoutCookies). rugged97's Worker takes no credential and refuses any; the beta cookie
 * has done its job once the gate checked it. In any case, as Pages routes it.
 */
const UNISWAP_V3_PATH = /^\/uniswap-v3(?:\/|$)/i

/**
 * Browser capabilities the site never uses, switched off so nothing injected into a page can reach them. Changed
 * 2026-10-01 (I8): USB, HID, serial and Bluetooth too. They were left open for a wallet connection that was still to
 * come; it came, and it never uses them: the page talks to a wallet only through the wallet's own provider (EIP-6963),
 * and a hardware wallet behind an extension talks to the device from the extension, not from this page.
 */
export const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'bluetooth=()',
  'camera=()',
  'display-capture=()',
  'geolocation=()',
  'gyroscope=()',
  'hid=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'serial=()',
  'usb=()',
].join(', ')

/**
 * HSTS stays without includeSubDomains (2026-10-01, I8): the names under domino.money are not all this site's.
 * rpc.domino.money and ws.domino.money are rugged97's node, reached through his own Cloudflare tunnel
 * (domino-robinhood-rpc-clawber; corrected 2026-10-01, RPC-SPEC §2.7: they were said to point, unproxied, at his host),
 * and vm-read.domino.money his read gateway: HTTPS on every one of them is not this site's to promise. The owner adds
 * it once every name under domino.money is known to answer HTTPS.
 */
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

function page(state: PageState, status: number, next = '', extra: Record<string, string> = {}): Response {
  return new Response(accessPage(state, next), {
    status,
    headers: {
      ...BASE_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': PAGE_CSP,
      ...extra,
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

/** `cookie` is optional so a redirect that must NOT touch the session can say so. */
function seeOther(location: string, cookie?: string): Response {
  const headers = new Headers({ ...BASE_HEADERS, Location: location, 'Cache-Control': 'no-store' })
  if (cookie) headers.set('Set-Cookie', cookie)
  return new Response(null, { status: 303, headers })
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

/**
 * Wrong passwords per client address, in this isolate (I7, 2026-10-01): after five within ten minutes the address
 * waits a minute, whatever it sends. The address is the one Cloudflare's edge writes (CF-Connecting-IP); a request
 * without it (a local server, a test) is not limited, since there is no address to hold it to.
 */
export const loginLimiter = createLoginLimiter()

async function login(request: Request, url: URL, config: BetaConfig): Promise<Response> {
  // A GET here sent Set-Cookie clearing the beta cookie, with no origin check
  // of any kind — so any page, ad frame or extension could point at
  // /__beta/login and sign a visitor out of the whole site, and so could the
  // visitor's own bookmark. A GET must not change session state at all: it
  // redirects and touches nothing. Signing out is a POST, and the gate
  // already has one.
  if (request.method !== 'POST') return seeOther('/')
  if (!sameOriginPost(request, url)) return json('origin_not_allowed', 403)
  const type = (request.headers.get('Content-Type') ?? '').toLowerCase()
  if (!type.startsWith('application/x-www-form-urlencoded')) return json('form_required', 415)
  const body = await readForm(request)
  if (body === null) return json('request_too_large', 413)
  const form = new URLSearchParams(body)
  // The link the visitor opened, carried by the access page (D3): only a hash route of this site's own shape.
  const next = nextHash(form.get('next'))
  const client = request.headers.get('CF-Connecting-IP')
  const now = Date.now()
  const wait = client === null ? 0 : loginLimiter.waitMs(client, now)
  if (wait > 0) return page('wait', 429, next, { 'Retry-After': String(Math.ceil(wait / 1000)) })
  if (!(await isPassword(config, form.get('password') ?? ''))) {
    if (client !== null) loginLimiter.failed(client, now)
    return page('wrong', 401, next)
  }
  if (client !== null) loginLimiter.succeeded(client)
  return seeOther(`/${next}`, await issueCookie(config, now))
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

/**
 * The files public/ serves under fixed names that are the same for every visitor: tokens' artwork (public/tokens/),
 * wallets' (public/wallets/), the docs' pictures (public/docs/), the favicon and the access page's fonts.
 * 2026-09-28 (speed wave, item 41): the icons were kept a day, then used while they are checked again, instead of
 * asked again through the gate on every page load (Home asked for four of them each time). 2026-10-01 (F3): the docs'
 * pictures (twenty of them, one round trip each per docs page) and the favicon too, and none of them varies on the
 * cookie any more: the beta cookie is renewed as it is used (D3), and a cache that varied on it would ask for every
 * file again each time. A replaced file reaches a returning visitor within a day.
 */
export const ICON_PATH = /^\/(?:tokens\/|wallets\/|docs\/|favicon\.(?:svg|ico)$|__beta\/fonts\/)/
export const ICON_CACHE = 'private, max-age=86400, stale-while-revalidate=604800'

/**
 * Served without the access cookie (2026-10-01): /favicon.ico, which browsers ask for on their own and, the live notes
 * found (L16), without the cookie, so it was a 401 and a console error on every page; and the access page's own two
 * fonts (gate.ts GATE_FONTS, I5). Public files, the same for everyone, and nothing of the app.
 */
export const UNGATED = new Set(['/favicon.ico', ...GATE_FONTS])

/**
 * A path that names a file (its last segment has an extension) other than a page. Pages answers a file it does not
 * hold with the app's index.html and a 200: after a release that is every old chunk an open tab asks for (D1), and a
 * missing picture would load as HTML. Such an answer becomes a 404 here, kept by no cache.
 */
const FILE_PATH = /\/[^/]*\.(?!html?$)[A-Za-z0-9]{1,8}$/

/**
 * The app's own response, with the security headers every page must carry. `pageCsp` is the page's policy in this
 * environment (pageCspFor: APP_CSP, or APP_CSP_CHAIN2 where the second chain's section is open).
 */
function secured(response: Response, url: URL, pageCsp: string = APP_CSP): Response {
  const type = response.headers.get('Content-Type') ?? ''
  const api = API_PATH.test(url.pathname)
  if (!api && type.includes('text/html') && FILE_PATH.test(url.pathname)) return json('not_found', 404)
  const out = new Response(response.body, response)
  for (const [name, value] of Object.entries(BASE_HEADERS)) out.headers.set(name, value)
  // A content-hashed file under /assets/ is the same for everyone and kept a year in this browser alone (private).
  // 2026-09-28 (speed wave, item 36): it no longer varies on Cookie, which made every chunk the browser held go back
  // to the server, once each, whenever any cookie changed. 2026-10-01 (F3): nor do the fixed public files (ICON_PATH).
  // Every other answer still varies on it.
  const hashed = !api && !type.includes('text/html') && url.pathname.startsWith('/assets/')
  const icon = !api && !type.includes('text/html') && ICON_PATH.test(url.pathname)
  if (!hashed && !icon) out.headers.append('Vary', 'Cookie')
  if (api) {
    // Never stored, never transformed on the way, never rendered as a page,
    // whatever the Worker or the forwarder sent. A Worker's no-store is kept
    // and tightened, never relaxed to the app's private, no-cache. Changed
    // 2026-09-28 (speed wave, item 13): a public read may be compressed on the
    // way; no-transform switched Cloudflare's own compression off, and an
    // overview travelled 12 to 16 times larger than it needed to.
    // 2026-10-01 (RPC-SPEC §2.7): a chain route's too (CHAIN_ROUTE).
    out.headers.set('Cache-Control', url.pathname.startsWith(PUBLIC_READ_PREFIX) || CHAIN_ROUTE.test(url.pathname) ? 'no-store' : 'no-store, no-transform')
    out.headers.set('Content-Security-Policy', API_CSP)
  } else if (type.includes('text/html')) {
    if (out.status !== 304) out.headers.set('Content-Security-Policy', withDetectionNonce(pageCsp))
    out.headers.set('Cache-Control', 'private, no-cache')
  } else if (hashed) {
    // Content-hashed by Vite, so safe to keep, but only in this browser.
    out.headers.set('Cache-Control', 'private, max-age=31536000, immutable')
    if (out.status !== 304) out.headers.set('Content-Security-Policy', STATIC_CSP)
  } else {
    out.headers.set('Cache-Control', icon ? ICON_CACHE : 'private, no-cache')
    // A 304 says the browser's copy is still right, and its headers replace the copy's: one with no type (the page's own,
    // revalidated) must not carry a CSP, or the page's would be replaced by the static files' and the page would run
    // nothing on its next load. Its copy keeps the CSP it was served with.
    if (out.status !== 304) out.headers.set('Content-Security-Policy', STATIC_CSP)
  }
  // A fresh nonce would not match the injected tags in the browser's retained HTML. A 304 keeps that document's
  // original policy, even if the static origin returned a Content-Type or its own CSP with the validators.
  if (!api && out.status === 304) out.headers.delete('Content-Security-Policy')
  // Only a file that is there is kept: a refusal or an error from the static files never is.
  if (!api && out.status >= 400) out.headers.set('Cache-Control', 'no-store')
  return out
}

/** onRequest's context: the gate's part, plus the bindings forward() reads and the middleware's own setting. */
type Context = GateContext & { env: BridgeEnv & Chain2Env & SearchEnv }

/**
 * Where a request goes once the gate admits it. Pages hands
 * functions/api/[[path]].ts only the paths its route, /api/:path*, matches,
 * and its matcher, path-to-regexp 6.3.0 as wrangler 4.130.0 bundles it, takes
 * non-empty segments only. An /api path with an empty segment, such as /api//x
 * or /api/read/v1//capabilities, would fall through to the static files and be
 * answered with index.html and a 200. Such a path goes to forward() from here,
 * which refuses it. Every other request goes to Pages' next(), which routes
 * the rest of /api to functions/api/[[path]].ts.
 *
 * 2026-10-01 (the chain2 workstream, part B): /uniswap-v3 the same way. Pages
 * routes it to functions/uniswap-v3/[[path]].ts, whose route,
 * /uniswap-v3/:path*, takes no empty segment either; such a path goes to
 * forward() too, which owns nothing outside /api/ and refuses it as JSON
 * (404 not_found), never index.html.
 */
function onward(context: Context, url: URL): GateContext['next'] {
  if (!API_PATH.test(url.pathname) || !url.pathname.includes('//')) return context.next
  // Like Pages' next(): handed a request, it forwards that one instead.
  return (passed?: Request) => forward(passed ?? context.request, context.env)
}

export async function onRequest(context: Context): Promise<Response> {
  const { request, env } = context
  const url = new URL(request.url)
  // Called only once the gate admits the request (rule 6).
  const next = onward(context, url)
  // The page's CSP in this environment (2026-10-01, the chain2 workstream, part B): production's everywhere but where
  // CHAIN2_PREVIEW is "true".
  const pageCsp = pageCspFor(env)
  // Rule 0, before the configuration, login and cookie are looked at.
  const canonical = url.hostname === CANONICAL_HOST || url.hostname === `www.${CANONICAL_HOST}`
  if (env.CANONICAL_HOSTS_ONLY === 'true' && !canonical) return json('not_found', 404)

  // Rule 1, unless the gate is open (BETA_GATE exactly "off", 2026-11-06): then the secrets are not read at all, and a
  // deployment without them opens as well. From here on `config` is null exactly when the gate is open.
  const open = gateOpen(env)
  const config = open ? null : await readConfig(env)
  if (!open && config === null) return page('unavailable', 503)

  if (url.hostname === `www.${CANONICAL_HOST}`) {
    // Permanent describes what the redirect means, not how long a browser may
    // keep it. A 301 without this header is stored for the life of the profile,
    // so the www → apex mapping could never be changed again for anyone who had
    // followed it once. Like every other answer the gate writes: no-store.
    return new Response(null, {
      status: 301,
      headers: {
        ...BASE_HEADERS,
        Location: `https://${CANONICAL_HOST}${url.pathname}${url.search}`,
        'Cache-Control': 'no-store',
      },
    })
  }

  // Rule 3: the public files that need no cookie, as they are, and nothing else under them.
  if (UNGATED.has(url.pathname) && (request.method === 'GET' || request.method === 'HEAD')) return searchRobots(secured(await context.next(), url, pageCsp), url, env, null)

  if (url.pathname === LOGIN_PATH || url.pathname === LOGOUT_PATH) {
    // Rules 4 and 5. With the gate open there is nothing to sign in to or out of: both go home, and no cookie is set,
    // cleared or read (a tab left on the access page posts its form here and lands on the app).
    if (config === null) return seeOther('/')
    return url.pathname === LOGIN_PATH ? login(request, url, config) : logout(request, url)
  }

  const now = Date.now()
  // Rule 6. With the gate open every request is admitted, as one with a valid cookie is; the cookie is not read.
  const expires = config === null ? null : await cookieExpiry(config, request.headers.get('Cookie'), now)
  if (config === null || expires !== null) {
    // A public read, and since 2026-10-01 (the chain2 workstream, part B) the second chain's services and (RPC-SPEC
    // §2.7) Domino's own chain routes, go on with no cookie at all.
    const bare = url.pathname.startsWith(PUBLIC_READ_PREFIX) || UNISWAP_V3_PATH.test(url.pathname) || CHAIN_ROUTE.test(url.pathname)
    // 2026-11-07 (the owner: Domino in Google, functions/_lib/seo.ts): a page answers at its own address (an older name or
    // a trailing slash moves there for good), with its own head, 404 where the app has nothing, and noindex lifted only
    // where search is on for domino.money. The request goes on exactly as before, but a page's HEAD, asked as its GET so
    // that it answers as the GET does, without the body.
    const asPage = pageRequest(request, url)
    const own = asPage ? pageRedirect(url) : null
    if (own !== null) return new Response(null, { status: 301, headers: { ...BASE_HEADERS, Location: own, 'Cache-Control': 'no-store' } })
    const asked = asPage ? pageFromFiles(request) : undefined
    const served = await (bare ? next(withoutCookies(request)) : asked ? next(asked) : next())
    const shaped = asPage ? await shapePage(served, url, request.method === 'HEAD') : null
    const response = searchRobots(secured(shaped?.response ?? served, url, pageCsp), url, env, shaped)
    // D3 (2026-10-01): the week runs from the last visit. A page load (also one the browser's copy answers, a 304) with
    // a cookie more than a day old gets a fresh one; nothing else does, so a visit renews it at most once a day. With the
    // gate open nothing is renewed: there is no cookie to keep.
    if (config !== null && expires !== null && renewable(expires, now) && wantsPage(request) && (response.status === 200 || response.status === 304 || shaped?.kind === 'missing')) {
      response.headers.append('Set-Cookie', await issueCookie(config, now))
    }
    return response
  }
  // The access page carries the asked page through the password as the route it already carries (2026-11-07,
  // functions/_lib/seo.ts askedRoute): `/markets` opens `/#/markets` after it, which the app turns into `/markets`.
  return wantsPage(request) ? page('ask', 401, askedRoute(url)) : json('beta_access_required', 401)
}
