/**
 * /uniswap-v3/{read,actions}/v1/<route> at this site's edge: rugged97's Uniswap v3 services for the second chain's
 * section, through a service binding to his bridge Worker (2026-10-01, the chain2 workstream, audit item G9).
 *
 * The browser asks this site (same origin, no CORS), and this route hands the request to ELYSIUM_BRIDGE, his Elysium v3
 * bridge Worker (bridge/src/elysium-worker.mjs on his branch; domino-elysium-v3-candidate in his
 * bridge/wrangler.elysium.toml at 7d190690, not deployed), which validates it against his closed contracts and asks his
 * gateway. Until the binding exists (production has none; preview gets one only when his Worker is deployed), every
 * such path answers 404 {"error":"not_enabled"}, which the section reads as "not connected yet".
 *
 * What it guarantees, in this order:
 *   1. Only this site's own origins: production, or the exact preview alias where CHAIN2_PREVIEW is "true". Anything
 *      else: 404 not_found, as the API forwarder answers (functions/_lib/bridge.ts).
 *   2. Only his routes: /uniswap-v3/read/v1/<route> and /uniswap-v3/actions/v1/<route> for a route his contract names,
 *      no query, no empty segment. Anything else: 404 not_found.
 *   3. No binding: 404 not_enabled.
 *   4. A Worker's subrequest (CF-Worker) is refused (403), as the forwarder refuses it.
 *   5. A browser's own same-origin POST only: the Origin header is this request's origin, the Fetch Metadata (where
 *      sent) say same-origin, cors and empty; JSON within 16 KiB, as his Worker takes it. Anything else: 403, 405, 413
 *      or 415 here, before anything reaches his Worker.
 *   6. What goes on is rebuilt from an allowlist: Content-Type, the contract's version and digest headers, and Origin.
 *      Every cookie (the beta gate's included), Authorization, CF-Access-* and forwarding header stays here: his Worker
 *      takes no credential and refuses any. From the preview alias, the URL and the Origin are the canonical site's, as
 *      the forwarder translates preview's public reads, so his Worker needs one ELYSIUM_APP_ORIGIN.
 *   7. capabilities (read and actions) is the same for every visitor and is kept at the edge for CAPABILITIES_SECONDS:
 *      only a 200 with his contract's version and digest, as JSON, that his runtime validates, for the chain the request
 *      named, under a key that names the site's origin, the chain id, the family, the contract version and digest
 *      (`edgeKey`). Every other route goes to his Worker every time and is never kept.
 *   8. The answer leaves with no-store, nosniff and a CSP that renders nothing; no Set-Cookie and no CORS header of his
 *      Worker's passes (the browser is same-origin).
 *
 * The runtimes come in (`contracts`), so this module compiles for node --test without them; the route file
 * (handler.ts) hands in rugged97's runtimes vendored under ./contracts.
 */
import { APP_ORIGIN, PREVIEW_ORIGIN } from '../bridge'
import { bodyWithin } from '../owned'
import type { EdgeCache } from '../publicEdge'

export interface UniswapV3Env {
  /** The service binding to rugged97's Elysium v3 bridge Worker; absent until it is deployed and bound. */
  ELYSIUM_BRIDGE?: unknown
  /** "true" in the preview environment only: the exact preview alias may use this route there. */
  CHAIN2_PREVIEW?: string
}

/** What this route needs of one of his runtimes (runtime.mjs) and its pin (pin.json). */
export interface V3Contract {
  readonly CONTRACT_VERSION: string
  readonly ROUTES: readonly string[]
  validateRequest(route: string, value: unknown, expected?: unknown): boolean
  validateResponse(route: string, value: unknown, expected?: unknown): boolean
  readonly pin: { readonly contractVersion: string; readonly manifestSha256: string }
}

export interface UniswapV3Runtime {
  readonly contracts: { readonly read: V3Contract; readonly actions: V3Contract }
  readonly cache: EdgeCache | null
  now(): number
  waitUntil?(work: Promise<unknown>): void
}

export const PREFIX = '/uniswap-v3/'
/** How long a capabilities answer is served from the edge. */
export const CAPABILITIES_SECONDS = 30
/** His Worker's request bound (MAX_REQUEST). */
export const MAX_REQUEST_BYTES = 16_384

const PATH = /^\/uniswap-v3\/(read|actions)\/v1\/([a-z][a-z-]{0,63})$/
const JSON_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i
const STORED_AT = 'X-Edge-Stored-At'
export const EDGE_HEADER = 'X-Domino-Edge-Cache'

type Family = 'read' | 'actions'
const contractHeader = (family: Family) => `X-Domino-Uniswap-V3-${family === 'read' ? 'Read' : 'Actions'}-Contract`

interface Fetcher {
  fetch(request: Request): Promise<Response>
}
const isFetcher = (value: unknown): value is Fetcher => typeof value === 'object' && value !== null && 'fetch' in value && typeof (value as Fetcher).fetch === 'function'

/** A JSON answer of this route's own: no contract header, nothing kept, nothing rendered. */
function refuse(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    },
  })
}

/**
 * The edge key of a kept capabilities answer: the site's origin (preview never reads production's), the chain id the
 * request named, the family, the contract version and the manifest digest. Every key carries the chain id.
 */
export function edgeKey(origin: string, chainId: number, family: Family, version: string, digest: string): string {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new RangeError('chain id')
  return `${origin}/uniswap-v3/cache/${chainId}/${family}/${encodeURIComponent(version)}/${digest}/capabilities`
}

/** Whether the request is a browser's own same-origin POST, by its headers. */
function sameOriginBrowser(request: Request, url: URL): boolean {
  const headers = request.headers
  if (headers.get('Origin') !== url.origin) return false
  const host = headers.get('Host')
  if (host !== null && host !== url.host) return false
  const one = (name: string, allowed: readonly string[]) => {
    const value = headers.get(name)
    return value === null || allowed.includes(value)
  }
  return one('Sec-Fetch-Site', ['same-origin']) && one('Sec-Fetch-Mode', ['cors', 'same-origin']) && one('Sec-Fetch-Dest', ['empty']) && !headers.has('Sec-Fetch-User')
}

/** His Worker's answer as it leaves here: its status, body and contract headers, with this route's own safety headers. */
function onward(response: Response, family: Family, body: BodyInit | null): Response {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  })
  const type = response.headers.get('Content-Type')
  if (type !== null) headers.set('Content-Type', type)
  const name = contractHeader(family)
  for (const header of [name, `${name}-Digest`]) {
    const value = response.headers.get(header)
    if (value !== null) headers.set(header, value)
  }
  return new Response(body, { status: response.status, headers })
}

export async function answerUniswapV3(request: Request, env: UniswapV3Env, rt: UniswapV3Runtime): Promise<Response> {
  const url = new URL(request.url)
  const preview = url.origin === PREVIEW_ORIGIN && env.CHAIN2_PREVIEW === 'true'
  if (url.origin !== APP_ORIGIN && !preview) return refuse('not_found', 404)
  const match = PATH.exec(url.pathname)
  const family = match?.[1] as Family | undefined
  const route = match?.[2]
  const contract = family ? rt.contracts[family] : undefined
  if (!family || !route || !contract || !contract.ROUTES.includes(route) || url.search !== '' || url.pathname.includes('//')) return refuse('not_found', 404)
  const bridge = env.ELYSIUM_BRIDGE
  if (!isFetcher(bridge)) return refuse('not_enabled', 404)
  if (request.headers.has('CF-Worker')) return refuse('worker_subrequest_refused', 403)
  if (request.method !== 'POST') return refuse('method_not_allowed', 405)
  if (!sameOriginBrowser(request, url)) return refuse('origin_not_allowed', 403)
  if (!JSON_TYPE.test(request.headers.get('Content-Type') ?? '')) return refuse('unsupported_media_type', 415)
  const read = await bodyWithin(request, MAX_REQUEST_BYTES).catch(() => ({ text: null, bytes: 0 }))
  if (read.text === null) return refuse('body_too_large', 413)
  const text = read.text

  const name = contractHeader(family)
  const headers = new Headers({ 'Content-Type': 'application/json' })
  for (const header of [name, `${name}-Digest`]) {
    const value = request.headers.get(header)
    if (value !== null) headers.set(header, value)
  }
  // His Worker admits one browser origin: the canonical site's, for production and the preview alias alike.
  headers.set('Origin', APP_ORIGIN)
  const target = `${APP_ORIGIN}${url.pathname}`

  // capabilities: served from the edge while a kept answer is young enough, and kept when his Worker's is valid.
  let key: string | null = null
  let asked: { chainId?: unknown } | null = null
  if (route === 'capabilities') {
    try {
      asked = JSON.parse(text) as { chainId?: unknown }
    } catch {
      asked = null
    }
    const chainId = asked?.chainId
    const pinned = request.headers.get(name) === contract.pin.contractVersion && request.headers.get(`${name}-Digest`) === contract.pin.manifestSha256
    if (pinned && typeof chainId === 'number' && contract.validateRequest(route, asked)) key = edgeKey(url.origin, chainId, family, contract.pin.contractVersion, contract.pin.manifestSha256)
  }
  if (key && rt.cache) {
    const hit = await kept(rt, key, contract, asked)
    if (hit !== null) {
      const response = new Response(hit, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', [name]: contract.pin.contractVersion, [`${name}-Digest`]: contract.pin.manifestSha256 } })
      const out = onward(response, family, hit)
      out.headers.set(EDGE_HEADER, 'hit')
      return out
    }
  }

  let response: Response
  try {
    response = await bridge.fetch(new Request(target, { method: 'POST', headers, body: text, redirect: 'manual' }))
  } catch {
    return refuse('bridge_unavailable', 503)
  }
  if (!(response instanceof Response)) return refuse('bridge_unavailable', 503)
  if (!key || !rt.cache || response.status !== 200) return onward(response, family, response.body)
  // A copy is checked before it is kept; the visitor gets the Worker's own bytes either way.
  const body = await response.text()
  const store = keepable(response, body, contract, name, asked) ? keep(rt, key, body) : Promise.resolve()
  if (rt.waitUntil) rt.waitUntil(store)
  else await store
  return onward(response, family, body)
}

/** Whether a Worker answer is one to keep: his contract's headers, JSON, valid by his runtime, for the chain asked. */
function keepable(response: Response, body: string, contract: V3Contract, name: string, asked: { chainId?: unknown } | null): boolean {
  if (response.headers.get(name) !== contract.pin.contractVersion || response.headers.get(`${name}-Digest`) !== contract.pin.manifestSha256) return false
  if (!JSON_TYPE.test(response.headers.get('Content-Type') ?? '')) return false
  try {
    const value = JSON.parse(body) as { chainId?: unknown }
    return contract.validateResponse('capabilities', value) && value.chainId === asked?.chainId
  } catch {
    return false
  }
}

async function kept(rt: UniswapV3Runtime, key: string, contract: V3Contract, asked: { chainId?: unknown } | null): Promise<string | null> {
  try {
    const entry = await rt.cache?.match(new Request(key))
    if (!entry) return null
    const at = Number(entry.headers.get(STORED_AT))
    const age = rt.now() - at
    if (!Number.isSafeInteger(at) || age < 0 || age >= CAPABILITIES_SECONDS * 1000) return null
    const text = await entry.text()
    const value = JSON.parse(text) as { chainId?: unknown }
    return contract.validateResponse('capabilities', value) && value.chainId === asked?.chainId ? text : null
  } catch {
    return null
  }
}

function keep(rt: UniswapV3Runtime, key: string, body: string): Promise<void> {
  const entry = new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `max-age=${CAPABILITIES_SECONDS}`, [STORED_AT]: String(rt.now()) } })
  return (rt.cache?.put(new Request(key), entry) ?? Promise.resolve()).catch(() => undefined)
}
