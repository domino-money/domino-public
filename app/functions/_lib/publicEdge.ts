/**
 * A public read kept at the edge: the one pattern behind the featured pools list's cache (featuredEdge.ts, featured
 * pools v1 §10.6) and, since 2026-09-28 (speed wave, items 7 and 45), a pool's stored 24h history (history.ts). Only a
 * read whose answer is the same for every visitor ever comes here; no session, wallet or private read does.
 *
 * What is kept, and when:
 *   - only a 200 that carries the route's contract header, as JSON, whose body passes the route's own runtime (the one
 *     the Worker ran on it already) and answers the question asked, and that the route's `keep` accepts. An error, a
 *     refusal, a timeout or anything else is passed on as it came and never kept;
 *   - in caches.default, under a synthetic GET key (the Cache API keeps GET answers only; functions/_lib/fees.ts does
 *     the same) that names the contract version, so a new version never reads an old entry, checked here against the
 *     time it was stored, not only the entry's max-age, and against the runtime again when it is read.
 *
 * Who is answered from it: only a request the read Worker itself would have answered (`plainAsk`: the exact path and
 * origin, a JSON POST the route's runtime accepts, the browser checks the Worker makes). Any other request is
 * forwarded, and the Worker's own refusal is the answer, so the cache never widens what the route accepts. A kept
 * answer carries no X-Domino-Request-Id, since no Worker handled that request, and says `X-Domino-Edge-Cache: hit`,
 * which the page reads to give back the read it took from its budget (src/lib/read/scheduler.ts EDGE_CACHED).
 *
 * An entry younger than `freshSeconds` is served as it is. One older, but younger than `staleSeconds`, is served at
 * once too, and the request it answered goes on to the Worker in the background (waitUntil), at most once every
 * REFRESH_GUARD_MS in an isolate, to keep a newer answer; a refusal that says the route is off (404 with the route's
 * contract header) takes the entry out, so switching a route off reaches every visitor at their next read. The
 * background read is the visitor's own request, so it counts against that visitor's address at the gateway (at most
 * one a minute for the whole site, where it was one for each visitor who missed), and the answer that sent it does not
 * say `hit`: their page keeps the read it took, as the gateway does.
 *
 * The browser never keeps any of it: the gate's secured() (functions/_middleware.ts) sets every /api answer to
 * no-store with the API CSP, and the gate runs before these routes like before every /api path.
 */
import { APP_ORIGIN, forward, type BridgeEnv } from './bridge'

/** The part of the Workers cache these routes use: caches.default in production, absent in tests. */
export interface EdgeCache {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
  delete?(request: Request): Promise<boolean>
}

export interface EdgeRuntime {
  cache: EdgeCache | null
  now: () => number
  waitUntil?: (work: Promise<unknown>) => void
  /** Keys refreshed in the background lately, with when: this isolate's own unless a test gives one. */
  refreshing?: Map<string, number>
}

/** One public route's rules. */
export interface EdgePolicy {
  path: string
  version: string
  /** Whether the Worker would take this body (the route's runtime), and the key it is kept under. Null: not asked of the edge. */
  keyOf(body: unknown): string | null
  /** Whether a text is an answer to this body the route's runtime accepts. */
  answers(body: unknown, text: string): boolean
  /** Whether a valid answer is kept. Absent: every one is. */
  keep?(text: string): boolean
  freshSeconds: number
  /** Past `freshSeconds` and before this, served at once and refreshed in the background. Absent: `freshSeconds`. */
  staleSeconds?: number
}

/** The read Worker's request limit (bridge/src/worker.mjs LIMITS.requestBytes). */
const REQUEST_BYTES = 8192
const CONTRACT_HEADER = 'X-Domino-Read-Contract'
export const EDGE_HEADER = 'X-Domino-Edge-Cache'
const STORED_AT = 'X-Edge-Stored-At'
/** The featured list's entries of before 2026-09-28 name their time so; read as well, for the deploy that switches. */
const OLD_STORED_AT = 'X-Featured-Stored-At'
const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i
/** A background refresh of a key is not started again this soon, in one isolate. */
export const REFRESH_GUARD_MS = 10_000
const REFRESHING = new Map<string, number>()

/**
 * The body of a request the read Worker would answer, on a copy of it, so the request itself can still be forwarded
 * untouched; undefined for anything else, which then goes to the Worker and gets its own refusal.
 */
async function plainAsk(request: Request, policy: EdgePolicy): Promise<{ body: unknown; text: string } | undefined> {
  const url = new URL(request.url)
  const headers = request.headers
  const one = (name: string, accepted: readonly (string | null)[]) => accepted.includes(headers.get(name))
  if (url.origin !== APP_ORIGIN || url.pathname !== policy.path || url.search !== '' || url.hash !== '') return undefined
  if (request.method !== 'POST' || headers.has('CF-Worker') || headers.get('Origin') !== APP_ORIGIN) return undefined
  if (headers.has('Host') && headers.get('Host') !== url.host) return undefined
  if (!one('Sec-Fetch-Site', [null, 'same-origin']) || !one('Sec-Fetch-Mode', [null, 'cors', 'same-origin'])
      || !one('Sec-Fetch-Dest', [null, 'empty']) || headers.has('Sec-Fetch-User')) return undefined
  if (!one(CONTRACT_HEADER, [null, policy.version]) || !one('Content-Encoding', [null, 'identity'])) return undefined
  if (!JSON_TYPE.test(headers.get('Content-Type') ?? '')) return undefined
  // A browser's fetch() always declares the length of a string body.
  const length = headers.get('Content-Length')
  if (length === null || !/^(0|[1-9][0-9]{0,4})$/.test(length) || Number(length) > REQUEST_BYTES) return undefined
  const bytes = await request.clone().arrayBuffer()
  if (bytes.byteLength > REQUEST_BYTES) return undefined
  // Strict UTF-8, and a byte order mark stays a character JSON refuses, as in the Worker.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  return { body: JSON.parse(text), text }
}

/** A kept answer and its age in ms, while it is younger than the policy allows and still an answer; else null. */
async function kept(rt: EdgeRuntime, key: string, body: unknown, policy: EdgePolicy): Promise<{ text: string; age: number } | null> {
  if (!rt.cache) return null
  try {
    const entry = await rt.cache.match(new Request(key))
    if (!entry) return null
    const at = Number(entry.headers.get(STORED_AT) ?? entry.headers.get(OLD_STORED_AT))
    const age = rt.now() - at
    if (!Number.isSafeInteger(at) || age < 0 || age >= (policy.staleSeconds ?? policy.freshSeconds) * 1000) return null
    const text = await entry.text()
    return policy.answers(body, text) ? { text, age } : null
  } catch {
    return null
  }
}

function keep(rt: EdgeRuntime, key: string, text: string, policy: EdgePolicy): Promise<void> {
  if (!rt.cache) return Promise.resolve()
  const entry = new Response(text, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `max-age=${policy.staleSeconds ?? policy.freshSeconds}`,
      [STORED_AT]: String(rt.now()),
    },
  })
  return rt.cache.put(new Request(key), entry).catch(() => undefined)
}

/** The answer as the Worker sends it, minus the request id of a request it did not handle, saying where it came from. */
function fromCache(text: string, version: string, hit: boolean): Response {
  return new Response(text, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      [CONTRACT_HEADER]: version,
      ...(hit ? { [EDGE_HEADER]: 'hit' } : {}),
    },
  })
}

/** Whether a Worker's answer is one to keep: a 200 with the route's contract header, as JSON, that answers `body`. */
async function keepable(response: Response, body: unknown, policy: EdgePolicy): Promise<string | null> {
  if (response.status !== 200 || response.headers.get(CONTRACT_HEADER) !== policy.version || !JSON_TYPE.test(response.headers.get('Content-Type') ?? '')) return null
  const text = await response.text()
  return policy.answers(body, text) && (policy.keep?.(text) ?? true) ? text : null
}

/** The Worker's answer to a stale entry's request, kept for the next visitor; a route that is off takes the entry out. */
async function refresh(request: Request, env: BridgeEnv, rt: EdgeRuntime, key: string, body: unknown, policy: EdgePolicy): Promise<void> {
  try {
    const response = await forward(request, env)
    if (response.status === 404 && response.headers.get(CONTRACT_HEADER) === policy.version) {
      await rt.cache?.delete?.(new Request(key))
      return
    }
    const text = await keepable(response, body, policy)
    if (text !== null) await keep(rt, key, text, policy)
  } catch {
    // The entry stands; a later request refreshes it.
  }
}

export async function answerFromEdge(request: Request, env: BridgeEnv, rt: EdgeRuntime, policy: EdgePolicy): Promise<Response> {
  const asked = await plainAsk(request, policy).catch(() => undefined)
  const body = asked?.body
  const key = asked === undefined ? null : policy.keyOf(body)
  if (key !== null && asked !== undefined) {
    const hit = await kept(rt, key, body, policy)
    if (hit !== null) {
      const refreshing = rt.refreshing ?? REFRESHING
      const since = refreshing.get(key)
      const renew = hit.age >= policy.freshSeconds * 1000 && (since === undefined || rt.now() - since >= REFRESH_GUARD_MS || rt.now() < since)
      if (renew) {
        refreshing.set(key, rt.now())
        // The same request, its body as it was read here: nothing of it is read again once this answer has left.
        const again = new Request(request.url, { method: 'POST', headers: request.headers, body: asked.text })
        const work = refresh(again, env, rt, key, body, policy).finally(() => refreshing.delete(key))
        if (rt.waitUntil) rt.waitUntil(work)
        else void work
      }
      // The request that sends the refresh is the one the gateway counts: its page keeps the read it took.
      return fromCache(hit.text, policy.version, !renew)
    }
  }
  const response = await forward(request, env)
  if (key === null || !rt.cache || response.status !== 200) return response
  const copy = response.clone()
  const text = await keepable(copy, body, policy)
  if (text !== null) {
    const stored = keep(rt, key, text, policy)
    if (rt.waitUntil) rt.waitUntil(stored)
    else await stored
  }
  // The same answer, its bytes read once, from a copy, to check them.
  return response
}
