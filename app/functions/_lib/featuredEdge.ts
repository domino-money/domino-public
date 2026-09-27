/**
 * The featured pools list at the edge (featured-pools v1 §10.3, §10.6):
 * POST /api/read/v5/featured-pools, answered by the read Worker through the
 * fixed forwarder, with its valid answers kept for 60 seconds.
 *
 * Why a cache here, against docs/API_READ_BRIDGE.md's "no CDN or BFF caching
 * initially" (an exception the spec records): the list changes once a day and
 * is the same for every visitor, the Home asks it before anything else, and
 * every read costs the VM a gateway admission, a reader health round trip and
 * a place in the stored lane, out of a per-IP budget all read versions share.
 *
 * What is kept, and when:
 *   - only a 200 that carries read-v5's contract header and whose body passes
 *     read-v5's runtime (api-contracts/read-v5/runtime.mjs, which the Worker
 *     ran on it already). An error, a refusal, a timeout or anything the
 *     runtime refuses is passed on as it came and never kept;
 *   - in caches.default, under a synthetic GET key (the Cache API keeps GET
 *     answers only; functions/_lib/fees.ts does the same), for 60 seconds,
 *     checked here against the time it was stored, not only the entry's
 *     max-age;
 *   - the key names the contract version, so a new version never reads an
 *     old entry.
 *
 * Who is answered from it: only a request the read Worker itself would have
 * answered with that list (plainAsk below: the exact path and origin, a POST
 * of `{}` as JSON, the browser checks the Worker makes). Any other request is
 * forwarded, and the Worker's own refusal is the answer, so the cache never
 * widens what the route accepts. A kept answer carries no
 * X-Domino-Request-Id: no Worker handled that request.
 *
 * The browser never keeps any of it: the gate's secured()
 * (functions/_middleware.ts) sets every /api answer to no-store, no-transform
 * with the API CSP, and the gate runs before this route like before every
 * /api path. A rollback (READ_V5_BRIDGE_ENABLED=false) reaches a visitor
 * within the 60 seconds an entry can live.
 *
 * The runtime comes in as `contract`, so this module compiles for node --test
 * without it (tsconfig.test.json); functions/api/read/v5/featured-pools.ts
 * hands in the real one.
 */
import { APP_ORIGIN, forward, type BridgeEnv } from './bridge'

/** What this route needs from api-contracts/read-v5/runtime.mjs. */
export interface FeaturedContract {
  CONTRACT_VERSION: string
  validateRequest(route: 'featured-pools', value: unknown): boolean
  validateResponse(route: 'featured-pools', value: unknown): boolean
}

/** The part of the Workers cache this route uses: caches.default in production, absent in tests. */
export interface EdgeCache {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

export interface FeaturedRuntime {
  contract: FeaturedContract
  cache: EdgeCache | null
  now: () => number
  waitUntil?: (work: Promise<unknown>) => void
}

export const FEATURED_PATH = '/api/read/v5/featured-pools'
/** How long a kept list is served (§10.6). */
export const LIST_SECONDS = 60
/** The read Worker's request limit (bridge/src/worker.mjs LIMITS.requestBytes). */
const REQUEST_BYTES = 8192
const CONTRACT_HEADER = 'X-Domino-Read-Contract'
const STORED_AT = 'X-Featured-Stored-At'
const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i

/** The synthetic GET the list is kept under, on the app's own origin. */
export const cacheKey = (version: string) => `${APP_ORIGIN}/api/read/v5/cache/${encodeURIComponent(version)}/featured-pools`

/**
 * Whether the read Worker would answer this request with the list: the
 * checks bridge/src/worker.mjs makes before it asks upstream, on a copy of the
 * body, so the request itself can still be forwarded untouched. False for
 * anything else, which then goes to the Worker and gets its own refusal.
 */
async function plainAsk(request: Request, contract: FeaturedContract): Promise<boolean> {
  const url = new URL(request.url)
  const headers = request.headers
  const one = (name: string, accepted: readonly (string | null)[]) => accepted.includes(headers.get(name))
  if (url.origin !== APP_ORIGIN || url.pathname !== FEATURED_PATH || url.search !== '' || url.hash !== '') return false
  if (request.method !== 'POST' || headers.has('CF-Worker') || headers.get('Origin') !== APP_ORIGIN) return false
  if (headers.has('Host') && headers.get('Host') !== url.host) return false
  if (!one('Sec-Fetch-Site', [null, 'same-origin']) || !one('Sec-Fetch-Mode', [null, 'cors', 'same-origin'])
      || !one('Sec-Fetch-Dest', [null, 'empty']) || headers.has('Sec-Fetch-User')) return false
  if (!one(CONTRACT_HEADER, [null, contract.CONTRACT_VERSION]) || !one('Content-Encoding', [null, 'identity'])) return false
  if (!JSON_TYPE.test(headers.get('Content-Type') ?? '')) return false
  // A browser's fetch() always declares the length of a string body.
  const length = headers.get('Content-Length')
  if (length === null || !/^(0|[1-9][0-9]{0,4})$/.test(length) || Number(length) > REQUEST_BYTES) return false
  const bytes = await request.clone().arrayBuffer()
  if (bytes.byteLength > REQUEST_BYTES) return false
  // Strict UTF-8, and a byte order mark stays a character JSON refuses, as in the Worker.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  return contract.validateRequest('featured-pools', JSON.parse(text))
}

/** Whether a body is a list read-v5's runtime accepts. */
function validList(text: string, contract: FeaturedContract): boolean {
  try {
    return contract.validateResponse('featured-pools', JSON.parse(text))
  } catch {
    return false
  }
}

/** A kept list, while it is younger than LIST_SECONDS and still valid; else null. */
async function kept(rt: FeaturedRuntime, key: string): Promise<string | null> {
  if (!rt.cache) return null
  try {
    const entry = await rt.cache.match(new Request(key))
    if (!entry) return null
    const at = Number(entry.headers.get(STORED_AT))
    const age = rt.now() - at
    if (!Number.isSafeInteger(at) || age < 0 || age >= LIST_SECONDS * 1000) return null
    const text = await entry.text()
    return validList(text, rt.contract) ? text : null
  } catch {
    return null
  }
}

async function keep(rt: FeaturedRuntime, key: string, text: string): Promise<void> {
  if (!rt.cache) return
  const entry = new Response(text, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `max-age=${LIST_SECONDS}`,
      [STORED_AT]: String(rt.now()),
    },
  })
  const stored = rt.cache.put(new Request(key), entry).catch(() => undefined)
  if (rt.waitUntil) rt.waitUntil(stored)
  else await stored
}

/** The list as the Worker sends it, minus the request id of a request it did not handle. */
function fromCache(text: string, version: string): Response {
  return new Response(text, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      [CONTRACT_HEADER]: version,
    },
  })
}

export async function answerFeatured(request: Request, env: BridgeEnv, rt: FeaturedRuntime): Promise<Response> {
  const version = rt.contract.CONTRACT_VERSION
  const key = cacheKey(version)
  const plain = await plainAsk(request, rt.contract).catch(() => false)
  if (plain) {
    const hit = await kept(rt, key)
    if (hit !== null) return fromCache(hit, version)
  }
  const response = await forward(request, env)
  if (!plain || !rt.cache || response.status !== 200 || response.headers.get(CONTRACT_HEADER) !== version
      || !JSON_TYPE.test(response.headers.get('Content-Type') ?? '')) return response
  const text = await response.text()
  if (validList(text, rt.contract)) await keep(rt, key, text)
  // The same answer, its bytes read once to check them.
  return new Response(text, response)
}
