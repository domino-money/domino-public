/**
 * The page's own line to Robinhood Chain (2026-09-25): the public RPC, asked
 * straight from the browser and from the fees replay worker.
 *
 * Why: the public RPC answers 429 "Too Many Requests" to every call that
 * comes from Cloudflare's edge (its shared egress is rate limited), so the
 * site's own routes that read the chain for the page (POST
 * /api/owned/v2/positions and /api/fees/v1/*) failed in production and
 * Positions showed nothing. The same reads now run here, with the same code:
 * functions/_lib/walletPositions.ts, owned.ts and fees.ts are pure modules the
 * page imports, with their caps, range splitting, 429 waits and strict
 * parsing unchanged. The routes stay, tested; nothing on the page asks them.
 *
 * What this module adds is the runtime those modules take: the one fetch,
 * which reaches the RPC and nothing else, with no credentials and no referrer
 * (the RPC allows CORS from any origin, and lets a preflight stand 600 s);
 * the page's clock; a pause that ends as soon as the read is no longer
 * wanted; the fees worker's paced lane (chainLane), so its log reads never
 * use up the RPC's per-address limit the page's own reads need; and a cache
 * in memory for the fees units. Nothing is kept in the browser's storage:
 * what is read lives for the visit, in this page's or this worker's memory.
 * The document's CSP and the worker's own name the RPC in connect-src
 * (functions/_middleware.ts).
 *
 * 2026-09-28 (a large Brazilian ISP's DNS answers NXDOMAIN for every host under chain.robinhood.com): the chain code
 * still names the chain's own RPC, and each runtime here still refuses any other URL first, but what they send goes
 * through this context's router (lib/chain/failover.ts): to the chain's own RPC while it can be reached, else to the
 * public fallbacks of lib/chain/endpoints.ts, each checked to be chain 4663 first and held to its own budget, and back
 * to the chain's own as soon as a quiet probe finds it again. The module still has one network call (rpcFetch), and
 * it reaches only those endpoints. A read's runtime also says whether wide log ranges can be read now (wideLogs): the
 * Positions list finds the owner's ids another way when they cannot (functions/_lib/walletPositions.ts).
 */
import { MAX_RPC_CALLS, RPC_URL, type OwnedDeps } from '../../../functions/_lib/owned'
import { MAX_RPC_CALLS as RELAY_CALLS, type FeesCache } from '../../../functions/_lib/fees'
import { FALLBACKS, PRIMARY } from './endpoints'
import { failover, type Router } from './failover'

/** What the chain code takes from the page (OwnedDeps and FeesDeps are the same shape). */
export type ChainDeps = Required<OwnedDeps>

/** Refused before anything is sent: the chain code names its endpoint itself, and this page reaches no other with it. */
const elsewhere = () => Promise.reject(new TypeError('not the chain RPC'))

/** The only URLs this module's one network call reaches: the chain's own RPC and its fallbacks (lib/chain/endpoints.ts). */
const ENDPOINT_URLS: ReadonlySet<string> = new Set([PRIMARY, ...FALLBACKS].map((endpoint) => endpoint.url))

/** One request to one of the endpoints, with no credentials and no referrer. */
function rpcFetch(url: string, init: RequestInit): Promise<Response> {
  if (!ENDPOINT_URLS.has(url)) return elsewhere()
  // No `cache` mode: a POST is never answered from the HTTP cache, and Chromium skips its CORS preflight cache for a
  // no-store request, which cost every call a preflight (the RPC allows 600 s of it).
  return fetch(url, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' })
}

/** Whether the browser says it has no network at all: a failed call is then not the RPC's rate limit. */
const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false

/** Resolves after `ms`, or at once when `signal` aborts or `stop()` is already true. */
function pause(ms: number, signal?: AbortSignal, stop?: () => boolean): Promise<void> {
  return new Promise((done) => {
    if (signal?.aborted || stop?.()) return done()
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      done()
    }
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/** This context's router to the chain (one per page, one per fees worker): what it knows lasts as long as the context. */
const router: Router = failover({ send: rpcFetch, now: () => Date.now(), pause: (ms, signal) => pause(ms, signal), offline })
/** For tests: this context's router, to read what it knows or forget it. */
export const routing = (): Router => router

/*
 * The RPC's limit, as measured from one address on 2026-09-25: it tracks the
 * work its answers cost over a short window, not the number of calls (200
 * calls of eth_blockNumber in 4 s were all answered; one cold log scan of
 * 1.7 s, or one 670 kB log reply, was enough for the next call to be
 * refused), and a refusal lasts well under a second once the address is quiet
 * (the next call 250 ms later was answered). While it refuses, it refuses
 * everything from that address, the page's own list and position reads too.
 */

/**
 * The page's reads tell the fees worker's lane when they are on their way: a channel of this site's own, carrying one
 * flag. 2026-09-25 (review): the lanes of other tabs' workers hear on it too what each read (its bytes) and each
 * refusal ('rest'): the RPC limits the visitor's address, not a tab, and two tabs each paced alone read twice the pace.
 */
const CHANNEL = 'domino-chain-reads'
/** How long after an unreadable reply the page asks the same call once more, before it counts as the RPC's 429. */
export const REASK_UNREADABLE_MS = 400

let channel: BroadcastChannel | null | undefined
let reading = 0
/** A channel of our own name; in Node (the tests, the live proofs) it does not keep the process running. */
function openChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel !== 'function') return null
  const opened = new BroadcastChannel(CHANNEL)
  ;(opened as unknown as { unref?: () => void }).unref?.()
  return opened
}
/**
 * Says on the channel that a page read is on its way (true), that the last one ended (false) or that the RPC refused one
 * ('rest'); quiet where there is no channel (a browser without BroadcastChannel, or one that refuses to open it).
 * 2026-09-28 (hotfix): the page no longer listens (it did for the list's APR queue, which is gone).
 */
function tell(news: boolean | 'rest'): void {
  try {
    if (channel === undefined) channel = openChannel()
    channel?.postMessage(news)
  } catch {
    channel = null
  }
}
/**
 * One more (or one fewer) page read on its way. The lanes hear every read that starts (2026-09-28: their hold lasts
 * PAGE_HOLD_MS from the last they heard, so a list read that waits between refused calls holds them throughout) and the
 * last that ends.
 */
function pageReading(step: 1 | -1): void {
  reading += step
  if (step > 0 || !reading) tell(step > 0)
}

/**
 * 2026-09-28: the list's read holds every tab's lane for the whole of it, its waits between refused calls included
 * (before, only while a call was on its way, so a fees log read went in the list's 3 and 4.5 s waits). Returns the
 * release.
 */
export function holdReads(): () => void {
  pageReading(1)
  return () => pageReading(-1)
}

/** The runtime for one read: `signal` aborted means nobody wants the answer, and no further call is made. */
export function chainDeps(signal?: AbortSignal): ChainDeps {
  // The read's own account with the fallbacks: the endpoint it keeps to, and no more requests than its chain code's cap.
  const session = router.session(MAX_RPC_CALLS)
  const once = (init: RequestInit) =>
    router.send(init, session).then(
      (response) => ({ response, unreadable: false }),
      (error: unknown) => {
        // The RPC sends its 429 with `access-control-allow-origin: *,*`, which a browser refuses as a CORS failure: the
        // page sees only a TypeError, never the 429 (seen 2026-09-25 in Chromium's net log). A time-out (an
        // AbortSignal's TimeoutError) is not a TypeError and keeps its own meaning, and so does a browser with no
        // network at all: that read fails at once, and is asked again on the page's own schedule. 2026-09-28: the router
        // hands back a TypeError only once its probe found the RPC there (so this is its refusal), or when no endpoint
        // at all could be reached; an RPC whose name does not resolve is not one: its calls went to the fallbacks.
        if (error instanceof TypeError && !offline()) return { response: null, unreadable: true }
        throw error
      },
    )
  return {
    async fetch(input, init) {
      if (input !== RPC_URL) return elsewhere()
      pageReading(1)
      try {
        let sent = await once(init)
        // A refusal the page meets is most often one the RPC lifts within half a second: asked once more first.
        if (sent.unreadable && !signal?.aborted) {
          await pause(REASK_UNREADABLE_MS, signal)
          sent = await once(init)
        }
        // Still unreadable: the RPC's 429, which the chain code waits out and asks again, as it does a 429 it can read.
        const response = sent.response ?? new Response(null, { status: 429, statusText: 'Unreadable reply' })
        // 2026-09-28: a refusal rests every tab's lane, so the page's own next call meets a quiet address.
        if (response.status === 429 || response.status === 503) tell('rest')
        return response
      } finally {
        pageReading(-1)
      }
    },
    sleep: (ms) => pause(ms, signal),
    now: () => Date.now(),
    cancelled: () => signal?.aborted === true,
    wideLogs: () => router.primaryUp(),
  }
}

/**
 * Create position's batch simulated whole on the chain's RPC (2026-09-25; finance/setup.ts prepareBatch), for a
 * wallet that does not carry eth_simulateV1: one POST through the module's one network call, a read like the page's
 * others, bounded to ten seconds. The reply's `result`, or the RPC's error thrown as itself.
 */
export async function simulateOnChain(params: unknown[]): Promise<unknown> {
  pageReading(1)
  try {
    const response = await router.send({ method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params }), signal: AbortSignal.timeout(10_000) })
    const reply = (await response.json()) as { result?: unknown; error?: { code?: unknown; message?: unknown } } | null
    if (!response.ok || !reply || reply.error || !('result' in reply)) {
      throw Object.assign(new Error(typeof reply?.error?.message === 'string' ? reply.error.message : 'simulation_unavailable'), { code: reply?.error?.code })
    }
    return reply.result
  } finally {
    pageReading(-1)
  }
}

/**
 * How the fees worker spends the RPC (2026-09-25). The fees logs are large and
 * only add a chart to a page, so they never compete with the reads the page is
 * made of (the list, a position's state):
 * - one request in flight for every history the worker replays, a position
 *   page's before the list's;
 * - none while the page has a read on its way, nor for `graceMs` after it;
 * - paced: after each reply, a wait of `workFactor` times the time it took
 *   above the quickest reply seen (the work it cost the RPC), and never faster
 *   than `bytesPerSecond` past a first `burstBytes`. The RPC also limits an
 *   address over a longer window: paced at 192 kB/s with the page reading
 *   every few seconds, its PONS/USDG epochs drew refusals after about a
 *   minute (12.6 MB), and the page's own reads were refused for half a minute
 *   after; at half that pace they were not;
 * - at the first reply the worker cannot read, or that says 429, the run stops
 *   (the card keeps its unclaimed figure) and the lane rests `restMs` before it
 *   asks anything again; 2026-09-27: the fees store asks that run again as
 *   soon as the rest is over (`wait`), no longer a minute later;
 * - 2026-09-25 (review): the pace is the address's, across tabs: every lane
 *   counts the bytes the others read, and rests when one of them was refused.
 * - 2026-09-28 (hotfix; C:/dwt/hotfix2, live from Node, where the RPC's 429 and its
 *   x-envoy-upstream-service-time can be read): one log scan the node worked on
 *   for 330 ms to 1.1 s (the NFT's Transfers over its last two days, the first
 *   read of every history) makes the RPC refuse the address's next call for
 *   about 4.5 s after it (refused 1, 2, 2.5 and 4 s after, answered 4.5 to 6 s
 *   after); the pace above waited 0.9 to 3.2 s, and the refusal cost the chart a
 *   30 s rest and a second run (45 to 80 s live). A reply whose headers came
 *   `heavyMs` past the quickest reply is followed by `heavyQuietMs` of quiet
 *   (such scans came 230 ms or more past it; the replay's batch of 50 block
 *   headers, which draws no refusal of its own, 130 to 155 ms past it). And
 *   the rest after a refusal is 6 s, no longer 30 s: the RPC took the address's
 *   calls again 4.5 to 6 s after the work that drew it, and the fees store
 *   still waits 30, 60 then 120 s before a position's third, fourth and fifth
 *   runs (store.ts RETRY_MS).
 * - 2026-09-28 (review of the above): the quickest reply is the chain's own
 *   RPC's only, and a reply is taken for heavy only while the calls go to that
 *   RPC. The replies the router makes itself while it is unreachable (1 to
 *   15 ms) had become the quickest, and after them every ordinary reply of
 *   200 ms or more (a phone's round trip from Brazil) was followed by 5 s of
 *   quiet, until the run's time ran out (and a run that ran out of its time is
 *   now asked again: fees/pipeline.ts outOfTime).
 */
export const LANE_PACE = { bytesPerSecond: 96 * 1024, burstBytes: 128 * 1024, workFactor: 4, graceMs: 2_000, restMs: 6_000, heavyMs: 200, heavyQuietMs: 5_000 } as const
export type LanePace = { [key in keyof typeof LANE_PACE]: number }

/** A usual round trip to the RPC with no work in it (an eth_blockNumber took 150 to 200 ms from Brazil, 2026-09-25). */
const ROUND_TRIP_MS = 200

/** The longest the lane waits on the page's reads at once, in case a page never said it was done (it was closed mid-read). */
const PAGE_HOLD_MS = 15_000

/** A lane's runtime for one read: the chain code's, plus the wait for its turn (FeesDeps.turn). */
export type LaneDeps = ChainDeps & { turn: () => Promise<number> }

export interface ChainLane {
  /** Runs `work` once nothing else runs in the lane: one at a time, `urgent` ones (a position page's) first. */
  queue<T>(work: () => Promise<T>, urgent: boolean): Promise<T>
  /**
   * The runtime for one piece of work: its calls paced, and stopped for good once one is refused, once `signal`
   * aborts or once `until` (a time, as `now` gives it) has passed: the run's time budget, even inside one piece.
   */
  deps(signal?: AbortSignal, until?: number): LaneDeps
  /** Whether the lane is resting after a refusal: nothing may be asked until it ends. */
  resting(): boolean
  /** 2026-09-27: how long before the lane asks anything again (0: at once): its rest, or the work its last reply cost. */
  wait(): number
  /** Stops listening to the page (the tests' lanes). */
  close(): void
}

/** A signal that aborts when either does (AbortSignal.any, which older browsers lack); `drop()` lets go of both. */
function either(a: AbortSignal | null | undefined, b: AbortSignal | undefined): { signal: AbortSignal | undefined; drop: () => void } {
  if (!a || !b) return { signal: a ?? b, drop: () => undefined }
  const controller = new AbortController()
  const fromA = () => controller.abort(a.reason)
  const fromB = () => controller.abort(b.reason)
  const drop = () => {
    a.removeEventListener('abort', fromA)
    b.removeEventListener('abort', fromB)
  }
  if (a.aborted) fromA()
  else if (b.aborted) fromB()
  else {
    a.addEventListener('abort', fromA, { once: true })
    b.addEventListener('abort', fromB, { once: true })
  }
  return { signal: controller.signal, drop }
}

/** `response` with its body counted as it is read (`spend` gets each chunk's size); `settle` runs once, however it ends. */
function counted(response: Response, spend: (bytes: number) => void, settle: () => void, signal?: AbortSignal): Response {
  const body = response.body
  if (!body) {
    settle()
    return response
  }
  const reader = body.getReader()
  let open = true
  const end = () => {
    if (!open) return
    open = false
    settle()
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          end()
          controller.close()
          return
        }
        spend(value.byteLength)
        controller.enqueue(value)
      } catch (error) {
        end()
        // A read nobody wants any more is not a slow reply: the relay code would split its range and mark it busy.
        controller.error(signal?.aborted ? new Error('cancelled') : error)
      }
    },
    cancel(reason) {
      end()
      return reader.cancel(reason)
    },
  })
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers })
}

/** The fees worker's lane to the RPC (see LANE_PACE). `now` is the tests' to replace. */
export function chainLane(pace: LanePace = LANE_PACE, now: () => number = Date.now): ChainLane {
  let tokens = pace.burstBytes
  let filled = now()
  /** No call before this time: the work the last reply cost the RPC, paid back. */
  let quietUntil = 0
  /**
   * The quickest reply seen: about the network's own round trip, which costs the RPC nothing. It starts at a round
   * trip's usual length, so a first reply that was slow already counts as work. 2026-09-28 (review): the chain's own
   * RPC's replies only (`own` in fetch).
   */
  let quickest = ROUND_TRIP_MS
  let restUntil = 0
  let busy = false
  const waiting: Array<{ urgent: boolean; start: () => void }> = []
  // The page's reads: whether one is on its way, and when the last one ended.
  let pageBusy = false
  let pageBusySince = 0
  let pageDoneAt = Number.NEGATIVE_INFINITY
  let listening: BroadcastChannel | null = null
  try {
    listening = openChannel()
    if (listening)
      listening.onmessage = (event: MessageEvent<unknown>) => {
        const news = event.data
        // Another tab's lane: what it read counts against this one's pace too, and its refusal rests this one.
        if (typeof news === 'number') {
          refill()
          tokens -= news
        } else if (news === 'rest') restUntil = Math.max(restUntil, now() + pace.restMs)
        // 2026-09-28: every read the page starts says so again, and its hold counts from the last.
        else if (news === true) {
          pageBusy = true
          pageBusySince = now()
        } else if (news === false) {
          pageBusy = false
          pageDoneAt = now()
        }
      }
  } catch {
    listening = null
  }
  const refill = () => {
    const at = now()
    tokens = Math.min(pace.burstBytes, tokens + ((at - filled) * pace.bytesPerSecond) / 1000)
    filled = at
  }
  /** How long to wait before the next call (0: now). */
  const due = () => {
    const at = now()
    refill()
    const held = pageBusy && at - pageBusySince < PAGE_HOLD_MS ? pace.graceMs : Math.max(0, pageDoneAt + pace.graceMs - at)
    const paced = tokens < 0 ? Math.ceil((-tokens * 1000) / pace.bytesPerSecond) : 0
    return Math.max(held, paced, quietUntil - at)
  }
  const pump = () => {
    if (busy || waiting.length === 0) return
    const first = waiting.findIndex((entry) => entry.urgent)
    const [next] = waiting.splice(first >= 0 ? first : 0, 1)
    busy = true
    next.start()
  }
  const resting = () => now() < restUntil
  /** Tells the other tabs' lanes what this one read, or that the RPC refused it. */
  const share = (news: number | 'rest') => {
    try {
      listening?.postMessage(news)
    } catch {
      // A channel that closed: this lane's own pace still holds.
    }
  }
  return {
    resting,
    wait: () => Math.max(due(), restUntil - now()),
    close: () => listening?.close(),
    queue(work, urgent) {
      return new Promise((resolve, reject) => {
        waiting.push({
          urgent,
          start: () =>
            void work()
              .then(resolve, reject)
              .finally(() => {
                busy = false
                pump()
              }),
        })
        pump()
      })
    },
    deps(signal, until = Number.POSITIVE_INFINITY) {
      let refused = false
      // This piece of work's account with the fallbacks: no more requests than the relay's own cap (fees.ts MAX_RPC_CALLS).
      const session = router.session(RELAY_CALLS)
      const stopped = () => refused || signal?.aborted === true || resting() || now() >= until
      return {
        now,
        cancelled: stopped,
        wideLogs: () => router.primaryUp(),
        // Once refused, the chain code's wait before asking again is no wait: it asks nothing more.
        sleep: (ms) => pause(ms, signal, stopped),
        async turn() {
          const started = now()
          // Never past `until`: a long wait for a large reply ends with the run's time.
          for (let wait = due(); wait > 0 && !stopped(); wait = due()) await pause(Math.min(wait, until - now()), signal)
          return now() - started
        },
        async fetch(input, init) {
          if (input !== RPC_URL) return elsewhere()
          const joined = either(init.signal, signal)
          const sent = now()
          // 2026-09-28 (review): only the chain's own RPC's reply to a call sent while the calls went to it, and answered
          // while they still do (`own`), tells a round trip. The router's own replies (1 to 15 ms, while the RPC is
          // unreachable) and a fallback's tell none: taken for the quickest, they made every ordinary reply after them
          // look heavy, 5 s of quiet each, until the run's time ran out. A reply answered while the calls go to the RPC
          // (`up`) may still be heavy: one the router got from it right after finding it again carries its probe's round
          // trip too, and is taken for heavy rather than risk the RPC's refusal after a scan.
          let own = router.primaryUp()
          let quiet = 0
          let response: Response
          try {
            response = await router.send({ ...init, signal: joined.signal }, session)
            const up = router.primaryUp()
            own &&= up
            // Its headers came heavyMs past the quickest reply or more: the node worked on it (see LANE_PACE).
            quiet = up && now() - sent - quickest >= pace.heavyMs ? pace.heavyQuietMs : 0
          } catch (error) {
            joined.drop()
            // A call nobody wants any more is not a slow one either (see counted).
            if (signal?.aborted) throw new Error('cancelled')
            if (!(error instanceof TypeError) || offline()) throw error
            // The RPC's own 429 reaches a browser as an unreadable reply (see chainDeps): taken as that refusal.
            response = new Response(null, { status: 429, statusText: 'Unreadable reply' })
          }
          if (response.status === 429 || response.status === 503) {
            joined.drop()
            refused = true
            restUntil = now() + pace.restMs
            share('rest')
            await response.body?.cancel().catch(() => undefined)
            return new Response(null, { status: 429, statusText: response.statusText })
          }
          return counted(
            response,
            (bytes) => {
              refill()
              tokens -= bytes
              share(bytes)
            },
            () => {
              joined.drop()
              const took = now() - sent
              if (own) quickest = Math.min(quickest, took)
              quietUntil = now() + Math.max(pace.workFactor * Math.max(0, took - quickest), quiet)
            },
            signal,
          )
        },
      }
    },
  }
}

/** Past this many bytes of kept text, the oldest entries go first. */
const MEMORY_BYTES = 32 * 1024 * 1024

/**
 * The fees relay's cache (the Workers cache on the edge) as a Map in memory,
 * for one page or one worker: each entry kept for the max-age the relay gives
 * it, as the Workers cache keeps it, and never past this context's life.
 */
export function memoryCache(limit = MEMORY_BYTES, now: () => number = Date.now): FeesCache {
  const stored = new Map<string, { text: string; headers: [string, string][]; until: number }>()
  let bytes = 0
  const drop = (key: string) => {
    const entry = stored.get(key)
    if (!entry) return
    stored.delete(key)
    bytes -= entry.text.length
  }
  return {
    async match(request) {
      const hit = stored.get(request.url)
      if (hit && hit.until <= now()) drop(request.url)
      else if (hit) return new Response(hit.text, { headers: hit.headers })
      return undefined
    },
    async put(request, response) {
      const text = await response.text()
      const seconds = Number(/max-age=(\d+)/.exec(response.headers.get('Cache-Control') ?? '')?.[1] ?? 0)
      drop(request.url)
      if (!(seconds > 0)) return
      stored.set(request.url, { text, headers: [...response.headers], until: now() + seconds * 1000 })
      bytes += text.length
      for (const key of stored.keys()) {
        if (bytes <= limit) break
        drop(key)
      }
    },
  }
}
