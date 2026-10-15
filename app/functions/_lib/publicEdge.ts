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
 *
 * Added 2026-10-01 (audit items A6, A14, F7, the owner's OK on more edge caching):
 *   - an entry served from the edge says how old it is (`X-Domino-Edge-Age`, in ms): the page dates the answer by when
 *     the edge received it, never by when it reached the page, so a kept answer's figures are never younger on screen
 *     than they are (lib/read/pipeline.ts);
 *   - a stale entry younger than the route's `waitAfterSeconds` is served at once while its refresh runs behind; only
 *     an older one waits `refreshWaitMs` for that refresh (the featured list: 5 minutes, A6);
 *   - misses are coalesced, per isolate (F7): while one request for a key is on its way to the Worker, others asking
 *     the same question wait for its answer, a bounded FOLLOW_WAIT_MS, and get it as `hit` (no gateway saw them); a
 *     leader whose answer is not a valid 200 leaves them to ask the Worker themselves, as before;
 *   - every answer names how it was made in a `Server-Timing` entry (`edge;desc=hit|stale|coalesced|miss`), so the
 *     hit rate can be measured from the browser or a tail;
 *   - a route may be told of every valid answer the Worker gives (`onAnswer`): the featured list logs its changes (B1).
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
  /** A bounded foreground wait; its cancellation never cancels the background refresh. */
  timer?: (ms: number, fire: () => void) => () => void
  /** Misses on their way to the Worker, by key: this isolate's own unless a test gives one (F7). */
  inflight?: Map<string, Promise<EdgeAnswer | null>>
}

/** A valid answer as text, with the contract version the Worker answered it in. Plain data: it may cross requests. */
export interface EdgeAnswer {
  text: string
  version: string
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
  /**
   * (2026-10-15, pack 7) Whether a kept answer is served only while it is fresh: up to `freshSeconds`, never stale past
   * it (history.ts: a history not ready yet, which may become ready at any moment). Absent: none is.
   */
  brief?(text: string): boolean
  freshSeconds: number
  /** Past `freshSeconds` and before this, served at once and refreshed in the background. Absent: `freshSeconds`. */
  staleSeconds?: number
  /** Return a ready refresh to the requesting visitor within this bound; no extra upstream request. */
  refreshWaitMs?: number
  /**
   * Only an entry at least this old waits `refreshWaitMs` for its refresh; a younger stale entry is served at once while
   * the refresh runs behind (A6, 2026-10-01). Absent: every stale entry that sends a refresh waits.
   */
  waitAfterSeconds?: number
  /** Told of every valid answer the Worker gives this route, kept or not, as it passes (B1: the featured list's log). */
  onAnswer?(text: string, version: string): void
}

/** The read Worker's request limit (bridge/src/worker.mjs LIMITS.requestBytes). */
const REQUEST_BYTES = 8192
const CONTRACT_HEADER = 'X-Domino-Read-Contract'
export const EDGE_HEADER = 'X-Domino-Edge-Cache'
/** How old, in ms, the kept answer an edge response carries was when it left the edge (2026-10-01). */
export const EDGE_AGE_HEADER = 'X-Domino-Edge-Age'
/** How a follower of a miss on its way waits for the leader's answer, at most, before it asks the Worker itself (F7). */
export const FOLLOW_WAIT_MS = 1_000
const STORED_AT = 'X-Edge-Stored-At'
/** The featured list's entries of before 2026-09-28 name their time so; read as well, for the deploy that switches. */
const OLD_STORED_AT = 'X-Featured-Stored-At'
/** The version the Worker answered a kept entry in (2026-09-28); an entry without it was kept in the route's `version`. */
const STORED_CONTRACT = 'X-Edge-Contract'
/** (2026-10-15, pack 7) How long a kept entry is served at all, in seconds, when the route kept it briefly; absent: the policy's. */
const STORED_LIFE = 'X-Edge-Life'
const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i
/** A background refresh of a key is not started again this soon, in one isolate. */
export const REFRESH_GUARD_MS = 10_000
const REFRESHING = new Map<string, number>()
const INFLIGHT = new Map<string, Promise<EdgeAnswer | null>>()

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
    const life = Math.min(policy.staleSeconds ?? policy.freshSeconds, Number(entry.headers.get(STORED_LIFE) ?? Infinity))
    if (!Number.isSafeInteger(at) || age < 0 || !(age < life * 1000)) return null
    const version = entry.headers.get(STORED_CONTRACT) ?? policy.version
    if (!accepted(policy).includes(version)) return null
    const text = await entry.text()
    return policy.answers(body, text) && names(policy, text, version) ? { text, age, version } : null
  } catch {
    return null
  }
}

function keep(rt: EdgeRuntime, key: string, answer: EdgeAnswer, policy: EdgePolicy): Promise<void> {
  if (!rt.cache) return Promise.resolve()
  const brief = policy.brief?.(answer.text) === true
  const entry = new Response(answer.text, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `max-age=${brief ? policy.freshSeconds : (policy.staleSeconds ?? policy.freshSeconds)}`,
      [STORED_AT]: String(rt.now()),
      [STORED_CONTRACT]: answer.version,
      ...(brief ? { [STORED_LIFE]: String(policy.freshSeconds) } : {}),
    },
  })
  return rt.cache.put(new Request(key), entry).catch(() => undefined)
}

/** How an answer was made, for its Server-Timing entry: a kept one, a stale one served while it refreshes, a leader's shared, the Worker's. */
type Made = 'hit' | 'stale' | 'coalesced' | 'miss'
const timing = (made: Made) => `edge;desc="${made}"`

/**
 * The answer as the Worker sends it, minus the request id of a request it did not handle, saying where it came from
 * (`hit` when no gateway counted this request) and how old the kept answer was as it left (`ageMs`).
 */
function fromCache(text: string, version: string, hit: boolean, ageMs: number, made: Made): Response {
  return new Response(text, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      [CONTRACT_HEADER]: version,
      ...(hit ? { [EDGE_HEADER]: 'hit' } : {}),
      [EDGE_AGE_HEADER]: String(Math.max(0, Math.round(ageMs))),
      'Server-Timing': timing(made),
    },
  })
}

/** A Worker's answer the route's runtime accepts for `body`: a 200 with one of the route's contract headers, as JSON. Not yet whether it is kept. */
async function validAnswer(response: Response, body: unknown, policy: EdgePolicy): Promise<EdgeAnswer | null> {
  const version = response.headers.get(CONTRACT_HEADER)
  if (response.status !== 200 || version === null || !accepted(policy).includes(version) || !JSON_TYPE.test(response.headers.get('Content-Type') ?? '')) return null
  const text = await response.text()
  if (!policy.answers(body, text) || !names(policy, text, version)) return null
  try {
    policy.onAnswer?.(text, version)
  } catch {
    // Evidence only: a log that fails never changes an answer.
  }
  return { text, version }
}

/** Whether a valid answer is one to keep: the route's `keep` says so, or it has none. */
const keepable = (answer: EdgeAnswer | null, policy: EdgePolicy): answer is EdgeAnswer => answer !== null && (policy.keep?.(answer.text) ?? true)

/** Keep the refreshed answer for other visitors, and offer it to the caller waiting within its short bound. */
async function refresh(request: Request, env: BridgeEnv, rt: EdgeRuntime, key: string, body: unknown, policy: EdgePolicy): Promise<Response | null> {
  try {
    const response = await forward(request, env)
    if (response.status === 404 && accepted(policy).includes(response.headers.get(CONTRACT_HEADER) ?? '')) {
      await rt.cache?.delete?.(new Request(key))
      return response
    }
    const answer = await validAnswer(response, body, policy)
    if (keepable(answer, policy)) {
      await keep(rt, key, answer, policy)
      return fromCache(answer.text, answer.version, false, 0, 'miss')
    }
  } catch {
    // The entry stands; a later request refreshes it.
  }
  return null
}

const realTimer = (delay: number, fire: () => void) => {
  const handle = setTimeout(fire, delay)
  return () => clearTimeout(handle)
}

/** `work`'s value, or null once `ms` have passed on this request's own timer, whichever comes first. */
function within<T>(work: Promise<T | null>, ms: number, rt: EdgeRuntime): Promise<T | null> {
  return new Promise((resolve) => {
    const cancel = (rt.timer ?? realTimer)(ms, () => resolve(null))
    void work.then((value) => { cancel(); resolve(value) }, () => { cancel(); resolve(null) })
  })
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
      const stale = hit.age >= policy.freshSeconds * 1000
      const renew = stale && (since === undefined || rt.now() - since >= REFRESH_GUARD_MS || rt.now() < since)
      if (renew) {
        refreshing.set(key, rt.now())
        // The same request, its body as it was read here: nothing of it is read again once this answer has left.
        const again = new Request(request.url, { method: 'POST', headers: request.headers, body: asked.text })
        const work = refresh(again, env, rt, key, body, policy).finally(() => refreshing.delete(key))
        if (rt.waitUntil) rt.waitUntil(work)
        else void work
        // Only an entry past `waitAfterSeconds` waits for its refresh (A6): a younger one is served at once.
        if (policy.refreshWaitMs && hit.age >= (policy.waitAfterSeconds ?? 0) * 1000) {
          const fresh = await within(work, policy.refreshWaitMs, rt)
          if (fresh) return fresh
        }
      }
      // The request that sends the refresh is the one the gateway counts: its page keeps the read it took.
      return fromCache(hit.text, hit.version, !renew, hit.age, stale ? 'stale' : 'hit')
    }
    // A miss another request is already asking the Worker about (F7): its answer, as soon as it has one.
    const inflight = rt.inflight ?? INFLIGHT
    const leading = inflight.get(key)
    if (leading) {
      const shared = await within(leading, FOLLOW_WAIT_MS, rt)
      if (shared) return fromCache(shared.text, shared.version, true, 0, 'coalesced')
      // No valid answer, or none in time: this request asks the Worker itself, as it always did.
      return answerMiss(request, env, rt, policy, key, body, null)
    }
    let share!: (answer: EdgeAnswer | null) => void
    const mine = new Promise<EdgeAnswer | null>((resolve) => { share = resolve })
    inflight.set(key, mine)
    try {
      return await answerMiss(request, env, rt, policy, key, body, share)
    } finally {
      share(null)
      if (inflight.get(key) === mine) inflight.delete(key)
    }
  }
  return answerMiss(request, env, rt, policy, key, body, null)
}

/** The Worker's own answer, kept when it is one to keep, and handed to the requests waiting on this key (F7). */
async function answerMiss(request: Request, env: BridgeEnv, rt: EdgeRuntime, policy: EdgePolicy, key: string | null, body: unknown, share: ((answer: EdgeAnswer | null) => void) | null): Promise<Response> {
  const response = await forward(request, env)
  if (key === null || response.status !== 200 || (!rt.cache && !share)) return response
  const copy = response.clone()
  const answer = await validAnswer(copy, body, policy)
  share?.(answer)
  if (rt.cache && keepable(answer, policy)) {
    const stored = keep(rt, key, answer, policy)
    if (rt.waitUntil) rt.waitUntil(stored)
    else await stored
  }
  // The same answer, its bytes read once, from a copy, to check them; it says it was the Worker's.
  const out = new Response(response.body, response)
  out.headers.set('Server-Timing', timing('miss'))
  return out
}
