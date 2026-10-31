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
 *     leader whose answer is not a valid 200 leaves them to ask the Worker themselves, as before (since 2026-10-30, when
 *     a kept answer is still within its error life, they get that instead: see below);
 *   - every answer names how it was made in a `Server-Timing` entry (`edge;desc=hit|stale|coalesced|miss`), so the
 *     hit rate can be measured from the browser or a tail;
 *   - a route may be told of every valid answer the Worker gives (`onAnswer`): the featured list logs its changes (B1).
 *
 * Added 2026-10-30 (launch capacity study, item 4: at launch load almost no overview answer was settled, so the edge kept
 * nothing, and a VM or tunnel outage past the stale window left visitors with no figures at all):
 *   - stale-if-error (`errorSeconds`): past `staleSeconds` and before `errorSeconds`, a kept answer is no longer served at
 *     once, but it still stands in for the Worker's own answer when that is a failure: a 408, a 429, any 5xx (the
 *     forwarder's 503 and Cloudflare's 520 to 530 included), a 200 that is no answer to the question, or none within the
 *     route's `errorWaitMs` or `refreshWaitMs` when it has one. A definitive refusal (a 404 that says the route is off, which also takes the entry
 *     out, or any other 4xx) is passed on as it came. The stand-in says `edge;desc="stale-if-error"` and how old it is
 *     (X-Domino-Edge-Age); it is never `hit` for the request that reached the Worker, which the gateway counted;
 *   - a route may keep an answer still settling (`settling`, the overview: a pool or token still being collected): fresh
 *     only `settlingSeconds`, then served stale like any other, except that the request that refreshes it waits up to
 *     `refreshWaitMs` for the newer answer at once, since the page asks again exactly for the figures that are coming;
 *   - a miss on its way is joined by its own settling, not by its first request's frame, and only while younger than
 *     LEAD_LIFE_MS, so one whose request was cut off never holds its key; a follower whose leader failed, or has not
 *     answered by the time the leader itself stops waiting (FOLLOW_WAIT_MS at the most), gets the kept answer when there
 *     is one (`stale-if-error`, `hit`: no gateway saw it) instead of asking the Worker again;
 *   - the Worker is let alone after a failure (review of 2026-10-30): a refresh, or a read past `staleSeconds`, that
 *     failed or brought nothing worth keeping holds its key REFRESH_GUARD_MS in the isolate, and meanwhile the kept
 *     answer is served as it is (`hit`, no gateway saw it), so a failing VM is asked about a key once per guard per
 *     isolate, never by every request; a valid answer worth keeping ends the guard. When a kept answer is there to stand
 *     in, a valid answer not worth keeping (an overview with nothing to show) counts as a failure too, so it never
 *     replaces figures for a visitor; a 408 (the Worker's own time-out) is a failure like a 429 or a 5xx;
 *   - a route may bound the wait past `staleSeconds` on its own (`errorWaitMs`: the history, which has no
 *     `refreshWaitMs`), so a slow VM has the kept answer stand in within it rather than at the Worker's own time-out.
 * Nothing else changed: only a valid 200 is ever kept, under the same keys, for the same requests (plainAsk), and no
 * error body, no other question's answer and nothing of a session or a wallet is ever served from it.
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
  inflight?: Map<string, Inflight>
}

/** A valid answer as text, with the contract version the Worker answered it in. Plain data: it may cross requests. */
export interface EdgeAnswer {
  text: string
  version: string
}

/**
 * What the Worker's answer to a miss came to (2026-10-30): a valid answer, and whether it is one worth keeping
 * (`useful`: the route's `keep` says so); a failure a kept answer may stand in for (a 408, a 429, a 5xx, a 200 that is no
 * answer to the question); or a refusal, the Worker's own say, passed on as it came.
 */
export type MissOutcome = { kind: 'answer'; answer: EdgeAnswer; useful: boolean } | { kind: 'failure' } | { kind: 'refusal' }

/** A miss on its way to the Worker (F7), with when it began (2026-10-30): joined only while younger than LEAD_LIFE_MS. */
export interface Inflight {
  started: number
  outcome: Promise<MissOutcome>
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
  /**
   * (2026-10-30, launch item 4) Whether a kept answer is still settling (the overview: a pool or token still being
   * collected): fresh only `settlingSeconds`, and once stale, the request that refreshes it waits up to `refreshWaitMs`
   * for the newer answer at once. Absent, or without `settlingSeconds`: none is.
   */
  settling?(text: string): boolean
  settlingSeconds?: number
  freshSeconds: number
  /** Past `freshSeconds` and before this, served at once and refreshed in the background. Absent: `freshSeconds`. */
  staleSeconds?: number
  /**
   * (2026-10-30, launch item 4) Stale-if-error: past `staleSeconds` and before this, a kept answer stands in for the
   * Worker's answer when that is a failure (see the header), never otherwise. Absent, or not longer: none.
   */
  errorSeconds?: number
  /**
   * Return a ready refresh to the requesting visitor within this bound; no extra upstream request. (2026-10-30) Also the
   * longest a request answered past `staleSeconds` waits for the Worker before a kept answer stands in for it, unless
   * the route names `errorWaitMs`.
   */
  refreshWaitMs?: number
  /**
   * (2026-10-30, review) The longest a request answered past `staleSeconds` waits for the Worker before a kept answer
   * stands in for it, on its own: the stale-while-revalidate wait (`refreshWaitMs`) is untouched. Absent:
   * `refreshWaitMs`; neither: the Worker's own result, a time-out of its own included.
   */
  errorWaitMs?: number
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
/** (2026-10-30, launch item 4) Set on an entry kept while still settling (EdgePolicy.settling): fresh `settlingSeconds` only. */
const STORED_SETTLING = 'X-Edge-Settling'
const JSON_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i
/**
 * A background refresh of a key is not started again this soon, in one isolate. (2026-10-30, review) Nor, after a read
 * of the key that failed or brought nothing worth keeping, is the Worker asked about it again this soon while a kept
 * answer can be served instead: the guard is lifted early only by a valid answer worth keeping.
 */
export const REFRESH_GUARD_MS = 10_000
/** (2026-10-30, review) Past this many keys guarded in an isolate, those whose guard is over are let go. */
const GUARD_KEYS = 512
/**
 * (2026-10-30, launch item 4) How long a miss on its way may be joined: past every limit of the read Worker's own
 * (bridge/src/worker.mjs LIMITS.totalMs, 20 s), so a miss whose request was cut off before it settled never holds its key.
 */
export const LEAD_LIFE_MS = 25_000
const REFRESHING = new Map<string, number>()
const INFLIGHT = new Map<string, Inflight>()

const accepted = (policy: EdgePolicy): readonly string[] => policy.versions ?? [policy.version]

/**
 * (2026-10-30) Whether a Worker's status is a failure a kept answer may stand in for: the Worker's own time-out (408,
 * read-v3 request_timeout: its total deadline passed, or the request above it was dropped), a refusal for load (429), or
 * any 5xx (the Worker's own 502, 503 and 504, the forwarder's 503, Cloudflare's 520 to 530). Any other status is the
 * Worker's say.
 */
const transient = (status: number) => status === 408 || status === 429 || (status >= 500 && status <= 599)

/** Whether a key's guard, set at `since`, still holds at `at`; a clock that went back never holds it. */
const guarded = (since: number | undefined, at: number) => since !== undefined && at >= since && at - since < REFRESH_GUARD_MS

/**
 * (2026-10-30, review) A read of `key` failed, or brought nothing worth keeping, at `at`: its guard holds REFRESH_GUARD_MS
 * from now. Keys whose guard is over are let go once the isolate holds more than GUARD_KEYS.
 */
function guardAfterFailure(refreshing: Map<string, number>, key: string, at: number): void {
  refreshing.set(key, at)
  if (refreshing.size <= GUARD_KEYS) return
  for (const [other, since] of refreshing) if (!guarded(since, at)) refreshing.delete(other)
}

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

/**
 * A kept answer: its text, its age in ms and its version, and, in ms, how long it is fresh and how long it is served at
 * once (past that, until its error life, it only stands in for a failure), and whether it was kept while still settling.
 */
interface Kept {
  text: string
  age: number
  version: string
  freshMs: number
  staleMs: number
  settling: boolean
}

/** How long a route serves a kept answer at once, and at all (its stale-if-error life included), in seconds. */
const staleLife = (policy: EdgePolicy) => policy.staleSeconds ?? policy.freshSeconds
const wholeLife = (policy: EdgePolicy) => Math.max(staleLife(policy), policy.errorSeconds ?? 0)

/** A kept answer while it is younger than the policy allows (its stale-if-error life included) and still an answer; else null. */
async function kept(rt: EdgeRuntime, key: string, body: unknown, policy: EdgePolicy): Promise<Kept | null> {
  if (!rt.cache) return null
  try {
    const entry = await rt.cache.match(new Request(key))
    if (!entry) return null
    const at = Number(entry.headers.get(STORED_AT) ?? entry.headers.get(OLD_STORED_AT))
    const age = rt.now() - at
    // An entry kept briefly (pack 7) is served only while fresh: never stale, and never for a failure either.
    const brief = Number(entry.headers.get(STORED_LIFE) ?? Infinity)
    const life = Math.min(wholeLife(policy), brief)
    if (!Number.isSafeInteger(at) || age < 0 || !(age < life * 1000)) return null
    const version = entry.headers.get(STORED_CONTRACT) ?? policy.version
    if (!accepted(policy).includes(version)) return null
    const text = await entry.text()
    if (!policy.answers(body, text) || !names(policy, text, version)) return null
    const settling = entry.headers.get(STORED_SETTLING) === '1' && policy.settlingSeconds !== undefined
    const fresh = settling ? Math.min(policy.freshSeconds, policy.settlingSeconds ?? policy.freshSeconds) : policy.freshSeconds
    return { text, age, version, freshMs: fresh * 1000, staleMs: Math.min(staleLife(policy), brief) * 1000, settling }
  } catch {
    return null
  }
}

function keep(rt: EdgeRuntime, key: string, answer: EdgeAnswer, policy: EdgePolicy): Promise<void> {
  if (!rt.cache) return Promise.resolve()
  const brief = policy.brief?.(answer.text) === true
  const settling = !brief && policy.settlingSeconds !== undefined && policy.settling?.(answer.text) === true
  const entry = new Response(answer.text, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `max-age=${brief ? policy.freshSeconds : wholeLife(policy)}`,
      [STORED_AT]: String(rt.now()),
      [STORED_CONTRACT]: answer.version,
      ...(brief ? { [STORED_LIFE]: String(policy.freshSeconds) } : {}),
      ...(settling ? { [STORED_SETTLING]: '1' } : {}),
    },
  })
  return rt.cache.put(new Request(key), entry).catch(() => undefined)
}

/**
 * How an answer was made, for its Server-Timing entry: a kept one, a stale one served while it refreshes, a leader's
 * shared, the Worker's, or (2026-10-30) a kept one standing in for a failure of the Worker's.
 */
type Made = 'hit' | 'stale' | 'coalesced' | 'miss' | 'stale-if-error'
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
    const refreshing = rt.refreshing ?? REFRESHING
    if (hit !== null && hit.age < hit.staleMs) {
      const stale = hit.age >= hit.freshMs
      const renew = stale && !guarded(refreshing.get(key), rt.now())
      if (renew) {
        refreshing.set(key, rt.now())
        // The same request, its body as it was read here: nothing of it is read again once this answer has left.
        const again = new Request(request.url, { method: 'POST', headers: request.headers, body: asked.text })
        // (2026-10-30, review) Only a refresh that kept a newer answer, or found the route off, lifts the guard. One that
        // failed (a 429, a 5xx, no answer) or brought nothing worth keeping holds it REFRESH_GUARD_MS from its end, and
        // the kept answer is served as it is meanwhile: a failing VM is not asked again by the very next request.
        const work = refresh(again, env, rt, key, body, policy).then((fresh) => {
          if (fresh) refreshing.delete(key)
          else guardAfterFailure(refreshing, key, rt.now())
          return fresh
        })
        if (rt.waitUntil) rt.waitUntil(work)
        else void work
        // Only an entry past `waitAfterSeconds` waits for its refresh (A6): a younger one is served at once. One kept
        // while still settling waits from the moment it is stale (2026-10-30): its page asks for the figures coming.
        const waitAfterMs = hit.settling ? hit.freshMs : (policy.waitAfterSeconds ?? 0) * 1000
        if (policy.refreshWaitMs && hit.age >= waitAfterMs) {
          const fresh = await within(work, policy.refreshWaitMs, rt)
          if (fresh) return fresh
        }
      }
      // The request that sends the refresh is the one the gateway counts: its page keeps the read it took.
      return fromCache(hit.text, hit.version, !renew, hit.age, stale ? 'stale' : 'hit')
    }
    // Past its stale life (2026-10-30): a kept answer still within its error life only stands in for a failure.
    const fallback = hit
    // A miss another request is already asking the Worker about (F7): its answer, as soon as it has one.
    const inflight = rt.inflight ?? INFLIGHT
    const leading = inflight.get(key)
    const at = rt.now()
    if (leading && at >= leading.started && at - leading.started < LEAD_LIFE_MS) {
      // (2026-10-30, review) With a kept answer to stand in, a follower waits no longer than its leader does before that
      // answer stands in for the leader's read (the route's bound, from when the leader began), FOLLOW_WAIT_MS at the most.
      const bound = policy.errorWaitMs ?? policy.refreshWaitMs
      const waitMs = fallback && bound ? Math.min(FOLLOW_WAIT_MS, Math.max(0, leading.started + bound - at)) : FOLLOW_WAIT_MS
      const shared = waitMs > 0 ? await within(leading.outcome, waitMs, rt) : null
      // A valid answer is shared, unless it is not worth keeping and the kept answer can stand in for it (review).
      if (shared?.kind === 'answer' && (shared.useful || !fallback)) return fromCache(shared.answer.text, shared.answer.version, true, 0, 'coalesced')
      // The leader's read failed, or is not in yet (2026-10-30): the kept answer, which no gateway counted, rather than
      // one more read of a Worker that is failing or slow.
      if (fallback && shared?.kind !== 'refusal') return fromCache(fallback.text, fallback.version, true, fallback.age, 'stale-if-error')
      // No valid answer, or none in time: this request asks the Worker itself, as it always did.
      return answerMiss(request, env, rt, policy, key, body, null, fallback)
    }
    // (2026-10-30, review) A read of this key failed lately in this isolate, or its refresh is on its way: the kept answer,
    // which no gateway counted, rather than one more read of a Worker that is failing, until the guard is over.
    if (fallback && guarded(refreshing.get(key), at)) return fromCache(fallback.text, fallback.version, true, fallback.age, 'stale-if-error')
    // This request leads: its miss is joined until it settles (cleared by its own settling, never by this frame).
    let settle!: (outcome: MissOutcome) => void
    const mine: Inflight = { started: at, outcome: new Promise<MissOutcome>((resolve) => { settle = resolve }) }
    inflight.set(key, mine)
    const share = (outcome: MissOutcome) => {
      if (inflight.get(key) === mine) inflight.delete(key)
      // (2026-10-30, review) With a kept answer to stand in, a failure, or an answer not worth keeping, guards the key;
      // an answer worth keeping (now kept) lifts the guard. A refusal is the Worker's say and changes nothing.
      if (fallback) {
        if (outcome.kind === 'answer' && outcome.useful) refreshing.delete(key)
        else if (outcome.kind !== 'refusal') guardAfterFailure(refreshing, key, rt.now())
      }
      settle(outcome)
    }
    try {
      return await answerMiss(request, env, rt, policy, key, body, share, fallback)
    } catch (error) {
      share({ kind: 'failure' })
      throw error
    }
  }
  return answerMiss(request, env, rt, policy, key, body, null, null)
}

/** What a miss's read of the Worker came to: its outcome, and the response to pass on when no kept answer stands in. */
interface Asked {
  outcome: MissOutcome
  response: Response
}

/**
 * The Worker's own answer to a miss, kept when it is one to keep: a valid 200 is an answer; a 408, a 429, a 5xx or a 200
 * that is no answer to the question is a failure; anything else is a refusal, and one that says the route is off takes out the
 * entry a stand-in would have come from (`hasEntry`), as a refresh's does. `check`: whether the answer is read at all
 * (with no cache, nobody to share it with and no stand-in, it is passed on unread, as it always was).
 */
async function askWorker(request: Request, env: BridgeEnv, rt: EdgeRuntime, policy: EdgePolicy, key: string, body: unknown, check: boolean, hasEntry: boolean): Promise<Asked> {
  const response = await forward(request, env)
  if (response.status !== 200) {
    if (hasEntry && response.status === 404 && accepted(policy).includes(response.headers.get(CONTRACT_HEADER) ?? '')) {
      await rt.cache?.delete?.(new Request(key))?.catch(() => false)
    }
    return { outcome: transient(response.status) ? { kind: 'failure' } : { kind: 'refusal' }, response }
  }
  if (!check) return { outcome: { kind: 'refusal' }, response }
  const answer = await validAnswer(response.clone(), body, policy).catch(() => null)
  const useful = keepable(answer, policy)
  if (answer !== null && rt.cache && useful) {
    const stored = keep(rt, key, answer, policy)
    if (rt.waitUntil) rt.waitUntil(stored)
    else await stored
  }
  // The same answer, its bytes read once, from a copy, to check them; it says it was the Worker's.
  const out = new Response(response.body, response)
  out.headers.set('Server-Timing', timing('miss'))
  return { outcome: answer !== null ? { kind: 'answer', answer, useful } : { kind: 'failure' }, response: out }
}

/**
 * The Worker's own answer, kept when it is one to keep, and handed to the requests waiting on this key (F7). With a kept
 * answer still within its error life (`fallback`, 2026-10-30), that answer stands in when the Worker's is a failure, or a
 * valid answer not worth keeping (review), or is not in within the route's `errorWaitMs` (else `refreshWaitMs`); the read
 * then goes on behind (waitUntil), and its answer is kept.
 */
async function answerMiss(
  request: Request,
  env: BridgeEnv,
  rt: EdgeRuntime,
  policy: EdgePolicy,
  key: string | null,
  body: unknown,
  share: ((outcome: MissOutcome) => void) | null,
  fallback: Kept | null,
): Promise<Response> {
  if (key === null) return forward(request, env)
  const work = askWorker(request, env, rt, policy, key, body, rt.cache !== null || share !== null, fallback !== null).then(
    (asked) => {
      share?.(asked.outcome)
      return asked
    },
    (error: unknown) => {
      share?.({ kind: 'failure' })
      throw error
    },
  )
  if (fallback === null) return (await work).response
  // The read is the stand-in's to outlive: its answer is kept for the next visitor even once this one has the stand-in.
  if (rt.waitUntil) rt.waitUntil(work.catch(() => undefined))
  const bound = policy.errorWaitMs ?? policy.refreshWaitMs
  const asked = bound ? await within(work, bound, rt) : await work.catch(() => null)
  // The Worker's say (a refusal), or an answer worth keeping, is passed on; an answer with nothing worth keeping never
  // replaces the kept one for this visitor (review).
  if (asked !== null && (asked.outcome.kind === 'refusal' || (asked.outcome.kind === 'answer' && asked.outcome.useful))) return asked.response
  // The Worker's own failure, or its late answer once kept, is read no further.
  if (asked === null) void work.then((late) => late.response.body?.cancel().catch(() => undefined), () => undefined)
  else await asked.response.body?.cancel().catch(() => undefined)
  // This request reached the Worker, and the gateway counted it: no `hit`.
  return fromCache(fallback.text, fallback.version, false, fallback.age, 'stale-if-error')
}
