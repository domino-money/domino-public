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
 * A route may take more than one contract version (`versions`; read-v5 takes rc.1 and rc.2 while the VM moves to rc.2,
 * 2026-09-28): a request may ask in any of them, an answer in any of them is kept, and a kept answer is served in the
 * version the Worker answered it in, which the entry records.
 *
 * The browser never keeps any of it: the gate's secured() (functions/_middleware.ts) sets every /api answer to
 * no-store with the API CSP, and the gate runs before these routes like before every /api path.
 */
import { APP_ORIGIN, PREVIEW_ORIGIN, forward, type BridgeEnv } from './bridge'

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
  /** Every version the route takes, in a request's and an answer's contract header. Absent: `version` alone. */
  versions?: readonly string[]
  /** Whether the Worker would take this body (the route's runtime), and the key it is kept under. Null: not asked of the edge. */
  keyOf(body: unknown, origin: string): string | null
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
/** The version the Worker answered a kept entry in (2026-09-28); an entry without it was kept in the route's `version`. */
const STORED_CONTRACT = 'X-Edge-Contract'
const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i
/** A background refresh of a key is not started again this soon, in one isolate. */
export const REFRESH_GUARD_MS = 10_000
const REFRESHING = new Map<string, number>()

const accepted = (policy: EdgePolicy): readonly string[] => policy.versions ?? [policy.version]

/** Where a route takes more than one version, an answer names the one it came in (the read Worker checks the same). */
function names(policy: EdgePolicy, text: string, version: string): boolean {
  if (!policy.versions) return true
  try {
    return (JSON.parse(text) as { contractVersion?: unknown } | null)?.contractVersion === version
  } catch {
    return false
  }
}

/**
 * The body of a request the read Worker would answer, on a copy of it, so the request itself can still be forwarded
 * untouched; undefined for anything else, which then goes to the Worker and gets its own refusal.
 */
async function plainAsk(request: Request, env: BridgeEnv, policy: EdgePolicy): Promise<{ body: unknown; text: string; origin: string } | undefined> {
  const url = new URL(request.url)
  const headers = request.headers
  const one = (name: string, accepted: readonly (string | null)[]) => accepted.includes(headers.get(name))
  // Validate the original preview browser request before the forwarder maps it to the Worker's origin. A cached
  // answer must not outlive the preview opt-in or its public-read binding, and never admits a private API family.
  const reader = env.READ_BRIDGE
  const preview = url.origin === PREVIEW_ORIGIN && env.PREVIEW_PUBLIC_READS === 'true'
    && typeof reader === 'object' && reader !== null && 'fetch' in reader && typeof reader.fetch === 'function'
    && /^\/api\/read\/v[1-5]\//.test(url.pathname) && !url.pathname.includes('//')
  if ((url.origin !== APP_ORIGIN && !preview) || url.pathname !== policy.path || url.search !== '' || url.hash !== '') return undefined
  if (request.method !== 'POST' || headers.has('CF-Worker') || headers.get('Origin') !== url.origin) return undefined
  if (headers.has('Host') && headers.get('Host') !== url.host) return undefined
  if (!one('Sec-Fetch-Site', [null, 'same-origin']) || !one('Sec-Fetch-Mode', [null, 'cors', 'same-origin'])
      || !one('Sec-Fetch-Dest', [null, 'empty']) || headers.has('Sec-Fetch-User')) return undefined
  if (!one(CONTRACT_HEADER, [null, ...accepted(policy)]) || !one('Content-Encoding', [null, 'identity'])) return undefined
  if (!JSON_TYPE.test(headers.get('Content-Type') ?? '')) return undefined
  // A browser's fetch() always declares the length of a string body.
  const length = headers.get('Content-Length')
  if (length === null || !/^(0|[1-9][0-9]{0,4})$/.test(length) || Number(length) > REQUEST_BYTES) return undefined
  const bytes = await request.clone().arrayBuffer()
  if (bytes.byteLength > REQUEST_BYTES) return undefined
  // Strict UTF-8, and a byte order mark stays a character JSON refuses, as in the Worker.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  return { body: JSON.parse(text), text, origin: url.origin }
}

/** A kept answer, its age in ms and its version, while it is younger than the policy allows and still an answer; else null. */
async function kept(rt: EdgeRuntime, key: string, body: unknown, policy: EdgePolicy): Promise<{ text: string; age: number; version: string } | null> {
  if (!rt.cache) return null
  try {
    const entry = await rt.cache.match(new Request(key))
    if (!entry) return null
    const at = Number(entry.headers.get(STORED_AT) ?? entry.headers.get(OLD_STORED_AT))
    const age = rt.now() - at
    if (!Number.isSafeInteger(at) || age < 0 || age >= (policy.staleSeconds ?? policy.freshSeconds) * 1000) return null
    const version = entry.headers.get(STORED_CONTRACT) ?? policy.version
    if (!accepted(policy).includes(version)) return null
    const text = await entry.text()
    return policy.answers(body, text) && names(policy, text, version) ? { text, age, version } : null
  } catch {
    return null
  }
}

function keep(rt: EdgeRuntime, key: string, answer: { text: string; version: string }, policy: EdgePolicy): Promise<void> {
  if (!rt.cache) return Promise.resolve()
  const entry = new Response(answer.text, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `max-age=${policy.staleSeconds ?? policy.freshSeconds}`,
      [STORED_AT]: String(rt.now()),
      [STORED_CONTRACT]: answer.version,
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

/** Whether a Worker's answer is one to keep: a 200 with one of the route's contract headers, as JSON, that answers `body`. */
async function keepable(response: Response, body: unknown, policy: EdgePolicy): Promise<{ text: string; version: string } | null> {
  const version = response.headers.get(CONTRACT_HEADER)
  if (response.status !== 200 || version === null || !accepted(policy).includes(version) || !JSON_TYPE.test(response.headers.get('Content-Type') ?? '')) return null
  const text = await response.text()
  return policy.answers(body, text) && names(policy, text, version) && (policy.keep?.(text) ?? true) ? { text, version } : null
}

/** The Worker's answer to a stale entry's request, kept for the next visitor; a route that is off takes the entry out. */
async function refresh(request: Request, env: BridgeEnv, rt: EdgeRuntime, key: string, body: unknown, policy: EdgePolicy): Promise<void> {
  try {
    const response = await forward(request, env)
    if (response.status === 404 && accepted(policy).includes(response.headers.get(CONTRACT_HEADER) ?? '')) {
      await rt.cache?.delete?.(new Request(key))
      return
    }
    const answer = await keepable(response, body, policy)
    if (answer !== null) await keep(rt, key, answer, policy)
  } catch {
    // The entry stands; a later request refreshes it.
  }
}

export async function answerFromEdge(request: Request, env: BridgeEnv, rt: EdgeRuntime, policy: EdgePolicy): Promise<Response> {
  const asked = await plainAsk(request, env, policy).catch(() => undefined)
  const body = asked?.body
  const key = asked === undefined ? null : policy.keyOf(body, asked.origin)
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
      return fromCache(hit.text, hit.version, !renew)
    }
  }
  const response = await forward(request, env)
  if (key === null || !rt.cache || response.status !== 200) return response
  const copy = response.clone()
  const answer = await keepable(copy, body, policy)
  if (answer !== null) {
    const stored = keep(rt, key, answer, policy)
    if (rt.waitUntil) rt.waitUntil(stored)
    else await stored
  }
  // The same answer, its bytes read once, from a copy, to check them.
  return response
}
