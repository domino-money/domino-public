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
import { MAX_RPC_CALLS as RELAY_CALLS, knownHead, type FeesCache } from '../../../functions/_lib/fees'
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

/**
 * 2026-09-28 (speed wave B, items 23 and 39): a head a read learned otherwise than by eth_blockNumber (the wallet scan's
 * first read), taken by this context's router for its fallbacks and by the relay's reads as their head of the moment
 * (functions/_lib/fees.ts headBlock: one read of the page's state right after the list's scan asks none of its own).
 */
const seeHead = (block: number) => {
  router.learn(block)
  knownHead(block, Date.now())
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
/** 2026-09-28 (speed wave B, item 15): whether a call of the page's reads on their way since the last were over was heavy. */
let weighty = false
/** A channel of our own name; in Node (the tests, the live proofs) it does not keep the process running. */
function openChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel !== 'function') return null
  const opened = new BroadcastChannel(CHANNEL)
  ;(opened as unknown as { unref?: () => void }).unref?.()
  return opened
}

/** A rest after refusals: until when, and how many came in a row. */
interface Rest {
  until: number
  count: number
}
/**
 * 2026-09-28 (speed wave B, item 19): the rest after a refusal is staged, no longer 30 s at the first: `firstRestMs`,
 * then four times as long at each refusal met within `restMs` of the last rest's end, up to `restMs` (6, 24, then 30 s).
 * A refusal the RPC lifts within seconds (its work limit) costs a chart seconds, not half a minute; one that goes on
 * (its byte limit over a minute) still meets the whole rest by the third. Every context counts every refusal it hears
 * of, its own and the other tabs', so they rest alike. 2026-09-29 (the release's live check, merged with hotfix/charts):
 * the first rest is 6 s, not 2.5: the RPC takes an address's calls again 4.5 to 6 s after the work that drew its
 * refusal (hotfix/charts, measured from Node), and live the wave's 2.5 s rest met a second refusal (see LANE_PACE).
 */
function restAfter(rest: Rest, at: number, pace: LanePace = LANE_PACE): void {
  rest.count = at < rest.until + pace.restMs ? Math.min(16, rest.count + 1) : 0
  rest.until = Math.max(rest.until, at + Math.min(pace.restMs, pace.firstRestMs * 4 ** rest.count))
}

// A refusal is the visitor's, not just the worker's. The existing channel continues to pace live lanes; this
// separate state channel also gives a newly opened page/worker the remaining cooldown, without an old tab treating
// a new message shape as "page done". Absolute expiry avoids extending a refusal every time a peer repeats it.
const COOLDOWN_CHANNEL = 'domino-chain-cooldown-v1'
const sharedRest: Rest = { until: -Infinity, count: 0 }
let cooldownChannel: BroadcastChannel | null | undefined
let cooldownReady = Promise.resolve()
function rememberRest(value: unknown): void {
  if (!value || typeof value !== 'object') return
  const { until, count } = value as Partial<Rest>
  if (typeof until !== 'number' || !Number.isFinite(until) || typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 16) return
  const bounded = Math.min(until, Date.now() + LANE_PACE.restMs)
  if (bounded > sharedRest.until) {
    sharedRest.until = bounded
    sharedRest.count = count
  }
}
function openCooldown(): Promise<void> {
  if (cooldownChannel !== undefined) return cooldownReady
  try {
    cooldownChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(COOLDOWN_CHANNEL) : null
    ;(cooldownChannel as unknown as { unref?: () => void } | null)?.unref?.()
    if (cooldownChannel) {
      cooldownChannel.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (data === '?') {
          if (sharedRest.until > Date.now()) cooldownChannel?.postMessage({ ...sharedRest })
        } else rememberRest(data)
      }
      // Give already-open peers one message turn to answer before a new context sends its first read.
      cooldownReady = pause(25)
      cooldownChannel.postMessage('?')
    }
  } catch {
    cooldownChannel = null
  }
  return cooldownReady
}
function publishRest(rest: Rest, at: number): void {
  void openCooldown()
  const state = { until: Date.now() + Math.max(0, rest.until - at), count: rest.count }
  rememberRest(state)
  try { cooldownChannel?.postMessage(state) } catch { /* This context still keeps the pause. */ }
}
function inheritRest(rest: Rest, at: number): void {
  const remaining = sharedRest.until - Date.now()
  if (remaining > 0) {
    rest.until = Math.max(rest.until, at + remaining)
    rest.count = Math.max(rest.count, sharedRest.count)
  }
}
/** Shared RPC deadline for a page's next scan, not a new refusal or an additional wait. */
export const chainRetryAt = (): number => sharedRest.until > Date.now() ? sharedRest.until : 0
/** Tests start a fresh visitor without carrying another test's refusal across runtimes. */
export function resetChainCooldown(): void {
  sharedRest.until = -Infinity
  sharedRest.count = 0
  cooldownChannel?.close()
  cooldownChannel = undefined
  cooldownReady = Promise.resolve()
}

/** The visitor's own round trip to the RPC, as a context learned it (the quickest reply), and whether a cheap call taught it. */
interface Floor {
  ms: number
  learned: boolean
  learnedAt: number
}
/** A fast connection from earlier in a visit must not classify a slower connection as expensive node work forever. */
export const ROUND_TRIP_WINDOW_MS = 15_000
/**
 * 2026-09-28 (speed wave B, items 14, 15 and 20): the work a reply cost the RPC, measured to its headers (which the RPC
 * sends once its work is done): for a log read or a batch of block headers, its time above the quickest reply seen.
 * Other calls teach the round trip (`floor`), above or below ROUND_TRIP_MS, which is the floor until one has.
 * A multi-header batch can include node work: it must not renew an expired floor with its whole elapsed time and
 * thereby hide the work of the next log read. Single-header reads keep their existing cheap-read behavior.
 */
function workOf(floor: Floor, body: unknown, took: number, at = Date.now()): number {
  if (!workRead(body)) {
    const renew = !floor.learned || at - floor.learnedAt >= ROUND_TRIP_WINDOW_MS
    floor.ms = renew ? took : Math.min(floor.ms, took)
    if (renew) floor.learnedAt = at
    floor.learned = true
    return 0
  }
  floor.ms = Math.min(floor.ms, took)
  return took - floor.ms
}
/** Reads whose elapsed time may include node work, not just one cheap round trip. */
function workRead(body: unknown): boolean {
  if (typeof body !== 'string') return false
  if (body.includes('"eth_getLogs"')) return true
  if (!body.includes('"eth_getBlockByNumber"')) return false
  try {
    const calls: unknown = JSON.parse(body)
    return Array.isArray(calls) && calls.filter((call: { method?: unknown } | null) => call?.method === 'eth_getBlockByNumber').length > 1
  } catch {
    return false
  }
}
/**
 * 2026-09-28 (speed wave B, item 15): a page call that cost the RPC this much work or more is heavy: the lanes wait
 * `graceMs` after the page's reads it was among. The others (its state reads, the head, a log read the RPC answered at
 * once) hold the lanes only while they are on their way.
 */
const HEAVY_MS = 500
/** A usual round trip to the RPC with no work in it (an eth_blockNumber took 150 to 200 ms from Brazil, 2026-09-25). */
const ROUND_TRIP_MS = 200
const pageFloor: Floor = { ms: ROUND_TRIP_MS, learned: false, learnedAt: 0 }

/**
 * Says on the channel that a page read is on its way (true), that the last one ended after a heavy call (false) or after
 * light ones only (null), or that the RPC refused one ('rest'); quiet where there is no channel (a browser without
 * BroadcastChannel, or one that refuses to open it). 2026-09-28 (speed wave B, item 15): a lane asks who reads ('?') when
 * it starts and when a tab says it is done, and a page with a read on its way says so again: a worker spawned mid-read,
 * or one tab done while another still reads, no longer takes the page for idle. That question is all the page hears
 * (2026-09-28, log-limits hotfix: the list's APR queue, which listened for the rests and the other tabs' reads, is gone).
 */
function tell(news: boolean | null | 'rest'): void {
  try {
    if (channel === undefined) {
      channel = openChannel()
      if (channel)
        channel.onmessage = ({ data }: MessageEvent<unknown>) => {
          if (data === '?' && reading) channel?.postMessage(true)
        }
    }
    channel?.postMessage(news)
  } catch {
    channel = null
  }
}
/**
 * One more (or one fewer) page read on its way. The lanes hear every read that starts (2026-09-28: their hold lasts
 * PAGE_HOLD_MS from the last they heard, so a list read that waits between refused calls holds them throughout) and the
 * last that ends, and whether a heavy call was among them.
 */
function pageReading(step: 1 | -1, weight = false): void {
  reading += step
  weighty ||= weight
  if (step > 0) tell(true)
  else if (!reading) {
    tell(weighty ? false : null)
    weighty = false
  }
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

/** Keep the caller's cancellation reason at every boundary, including older browsers without throwIfAborted. */
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('cancelled', 'AbortError')
}

/**
 * The runtime for one read: `signal` aborted means nobody wants the answer, and no further call is made. 2026-09-28
 * (speed wave B, item 26): an `aside` read (an automated position's vault record, read beside its chart) is not one the
 * lanes step aside for: it neither holds them nor rests them but by a refusal.
 */
export function chainDeps(signal?: AbortSignal, aside = false): ChainDeps {
  const ready = openCooldown()
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
      const step = aside ? 0 : 1
      if (step) pageReading(1)
      let work = 0
      const joined = either(init.signal, signal)
      let bodyOwnsSignal = false
      try {
        await ready
        checkAbort(joined.signal)
        const remaining = sharedRest.until - Date.now()
        // A local refusal is not a new refusal from the RPC: do not broadcast it or lengthen the pause. Preserve the
        // caller's deadline and existing bounded retries instead of sleeping past its ten-second network budget.
        if (remaining > 0) return new Response(null, { status: 429, headers: { 'Retry-After': String(Math.ceil(remaining / 1000)) } })
        const started = Date.now()
        const request = { ...init, signal: joined.signal }
        let sent = await once(request)
        if (sent.response) work = workOf(pageFloor, init.body, Date.now() - started)
        // A refusal the page meets is most often one the RPC lifts within half a second: asked once more first.
        if (sent.unreadable && !joined.signal?.aborted) {
          await pause(REASK_UNREADABLE_MS, joined.signal)
          checkAbort(joined.signal)
          sent = await once(request)
        }
        checkAbort(joined.signal)
        // Still unreadable: the RPC's 429, which the chain code waits out and asks again, as it does a 429 it can read.
        const response = sent.response ?? new Response(null, { status: 429, statusText: 'Unreadable reply' })
        // 2026-09-28: a refusal rests every tab's lane, so the page's own next call meets a quiet address.
        if (response.status === 429 || response.status === 503) {
          restAfter(sharedRest, Date.now())
          publishRest(sharedRest, Date.now())
          tell('rest')
        }
        // Fetch resolves at the headers, not after the body. Keep the joined signal alive until consumption/cancel,
        // so leaving a page also aborts a large reply already streaming, without cancelling another consumer.
        const result = counted(response, () => undefined, joined.drop, signal)
        bodyOwnsSignal = true
        return result
      } finally {
        if (!bodyOwnsSignal) joined.drop()
        if (step) pageReading(-1, work >= HEAVY_MS)
      }
    },
    sleep: (ms) => pause(ms, signal),
    now: () => Date.now(),
    cancelled: () => signal?.aborted === true,
    wideLogs: () => router.primaryUp(),
    head: seeHead,
  }
}

/**
 * Create position's batch simulated whole on the chain's RPC (2026-09-25; finance/setup.ts prepareBatch), for a
 * wallet that does not carry eth_simulateV1: one POST through the module's one network call, a read like the page's
 * others, bounded to ten seconds. The reply's `result`, or the RPC's error thrown as itself.
 */
export async function simulateOnChain(params: unknown[]): Promise<unknown> {
  pageReading(1, true)
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
 * - none while the page has a read on its way, nor for `graceMs` after one
 *   with a heavy call in it (2026-09-28, speed wave B, item 15: after a light
 *   one, none);
 * - paced: after each log read, a wait of `workFactor` times the time its reply
 *   took to start above the quickest reply seen (the work it cost the RPC), at
 *   most `maxQuietMs`, and never faster than `bytesPerSecond` past a first
 *   `burstBytes`. The RPC also limits an address over a longer window: paced
 *   at 192 kB/s with the page reading every few seconds, its PONS/USDG epochs
 *   drew refusals after about a minute (12.6 MB), and the page's own reads
 *   were refused for half a minute after; at half that pace they were not;
 * - at the first reply the worker cannot read, or that says 429, the run stops
 *   (the card keeps its unclaimed figure) and the lane rests before it asks
 *   anything again (2026-09-28, speed wave B, item 19: `firstRestMs`, then
 *   longer at each refusal in a row, up to `restMs`: restAfter); 2026-09-27:
 *   the fees store asks that run again as soon as the rest is over (`wait`),
 *   no longer a minute later;
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
 *
 * 2026-09-28 (speed wave B, items 14 and 20: a phone's Fees earned chart took about 17 s where a desktop's took 9): the
 * work is measured to the reply's headers, which the RPC sends once its work is done (live that day: a 5.6-million-block
 * log read's headers and its last byte came 0.5 ms apart, both a round trip after the call), so the visitor's own
 * download is the byte pace's alone; and the quickest reply is learned from the replies of calls that cost the RPC
 * nothing (now excluding multi-header batches too): the visitor's own round trip, above or below ROUND_TRIP_MS, where it used to start
 * at ROUND_TRIP_MS and only go down, so a phone 300 ms away paid 4 × 100 ms of quiet after every call. The byte pace is
 * the one measured, unchanged.
 *
 * 2026-09-29 (the release's live check, speed wave B merged with hotfix/charts; C:/dwt/wave-b-live): the wave's quiet
 * after a log read is at most `maxQuietMs`, but after one that came `heavyMs` or more past the quickest reply while the
 * calls go to the chain's own RPC it is hotfix/charts' own: `heavyQuietMs`, or its work times `workFactor` when that is
 * longer. Live, with the wave's 1 s cap alone, the replay's cold Transfer scan (380 to 420 ms, about 250 ms of work)
 * was followed 0.9 to 1.1 s later by a call the RPC refused, in 12 of 18 such scans across this release and production;
 * the 2.5 s rest then met a second refusal, and in two of the three runs opened from the list the chart had not come
 * 150 s later. The round trip (`floor`) is learned from the chain's own RPC's replies only, as hotfix/charts' review
 * found: the router's own replies (1 to 15 ms, while the RPC is unreachable) would make every ordinary reply look
 * heavy. The rest after a refusal stays the wave's staged one (restAfter), from 6 s where hotfix/charts rests 6 s every
 * time; the store's retries stay the wave's (store.ts RETRY_MS).
 */
export const LANE_PACE = { bytesPerSecond: 96 * 1024, burstBytes: 128 * 1024, workFactor: 4, maxQuietMs: 1_000, heavyMs: 200, heavyQuietMs: 5_000, graceMs: 2_000, firstRestMs: 6_000, restMs: 30_000 } as const
export type LanePace = { [key in keyof typeof LANE_PACE]: number }


/** The longest the lane waits on the page's reads at once, in case a page never said it was done (it was closed mid-read). */
const PAGE_HOLD_MS = 15_000
/** 2026-09-28 (speed wave B, item 15): how often a wait held by a page read on its way looks again, so it ends with it. */
const BUSY_MS = 250

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
  /** 2026-09-28 (speed wave B, item 39): whether a call that costs the RPC nothing answered it: the round trip is known. */
  learned(): boolean
  /** Stops listening to the page (the tests' lanes). */
  close(): void
}

/** A signal that aborts when either does (AbortSignal.any, which older browsers lack); `drop()` lets go of both. */
function either(a: AbortSignal | null | undefined, b: AbortSignal | undefined): { signal: AbortSignal | undefined; drop: () => void } {
  if (!a || !b) return { signal: a ?? b, drop: () => undefined }
  const controller = new AbortController()
  const abort = () => controller.abort(a.aborted ? a.reason : b.reason)
  const drop = () => {
    a.removeEventListener('abort', abort)
    b.removeEventListener('abort', abort)
  }
  if (a.aborted || b.aborted) abort()
  else {
    a.addEventListener('abort', abort, { once: true })
    b.addEventListener('abort', abort, { once: true })
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
  const ready = openCooldown()
  let tokens = pace.burstBytes
  let filled = now()
  /** No call before this time: the work the last reply cost the RPC, paid back. */
  let quietUntil = 0
  /**
   * The quickest reply seen: about the network's own round trip, which costs the RPC nothing. Until a call that costs
   * nothing has answered it is a round trip's usual length at most, so a first log read that was slow already counts as
   * work; the first such call sets it, and the quickest of them keeps it (workOf, item 14 above). 2026-09-28 (hotfix/charts'
   * review): the chain's own RPC's replies only (`own` in fetch).
   */
  const floor: Floor = { ms: ROUND_TRIP_MS, learned: false, learnedAt: 0 }
  const rest: Rest = { until: -Infinity, count: 0 }
  inheritRest(rest, now())
  let inherited = false
  const hydrated = async () => {
    await ready
    if (!inherited) {
      inheritRest(rest, now())
      inherited = true
    }
  }
  let busy = false
  const waiting: Array<{ urgent: boolean; start: () => void }> = []
  // The page's reads: whether one is on its way, and when the last one with a heavy call in it ended.
  let pageBusy = false
  let pageBusySince = 0
  let pageDoneAt = Number.NEGATIVE_INFINITY
  let listening: BroadcastChannel | null = null
  /** Tells the pages and the other tabs' lanes what this one read, that the RPC refused it, or asks who reads ('?'). */
  const share = (news: number | 'rest' | '?') => {
    try {
      listening?.postMessage(news)
    } catch {
      // A channel that closed: this lane's own pace still holds.
    }
  }
  try {
    listening = openChannel()
    if (listening)
      listening.onmessage = (event: MessageEvent<unknown>) => {
        const news = event.data
        // Another tab's lane: what it read counts against this one's pace too, and its refusal rests this one.
        if (typeof news === 'number') {
          refill()
          tokens -= news
        } else if (news === 'rest') restAfter(rest, now(), pace)
        // 2026-09-28: every read the page starts says so again, and its hold counts from the last.
        else if (news === true) {
          pageBusy = true
          pageBusySince = now()
        } else if (news !== '?') {
          // Done (false after a heavy call, null after light ones only); a page still reading, in another tab, says so again.
          pageBusy = false
          if (news === false) pageDoneAt = now()
          share('?')
        }
      }
  } catch {
    listening = null
  }
  // 2026-09-28 (speed wave B, item 15): a lane made while a page read is on its way hears of it.
  share('?')
  const refill = () => {
    const at = now()
    tokens = Math.min(pace.burstBytes, tokens + ((at - filled) * pace.bytesPerSecond) / 1000)
    filled = at
  }
  /** How long to wait before the next call (0: now); while a page read is on its way, BUSY_MS at a time. */
  const due = () => {
    const at = now()
    refill()
    const held = pageBusy && at - pageBusySince < PAGE_HOLD_MS ? BUSY_MS : Math.max(0, pageDoneAt + pace.graceMs - at)
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
  const resting = () => now() < rest.until
  return {
    resting,
    wait: () => Math.max(due(), rest.until - now()),
    learned: () => floor.learned,
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
        head: seeHead,
        // Once refused, the chain code's wait before asking again is no wait: it asks nothing more.
        sleep: (ms) => pause(ms, signal, stopped),
        async turn() {
          const started = now()
          await hydrated()
          // Never past `until`: a long wait for a large reply ends with the run's time.
          for (let wait = due(); wait > 0 && !stopped(); wait = due()) await pause(Math.min(wait, until - now()), signal)
          return now() - started
        },
        async fetch(input, init) {
          if (input !== RPC_URL) return elsewhere()
          await hydrated()
          if (signal?.aborted) throw new Error('cancelled')
          if (stopped()) return new Response(null, { status: 429, statusText: 'RPC cooldown' })
          const joined = either(init.signal, signal)
          const sent = now()
          // 2026-09-28 (review): only the chain's own RPC's reply to a call sent while the calls went to it, and answered
          // while they still do (`own`), tells a round trip. The router's own replies (1 to 15 ms, while the RPC is
          // unreachable) and a fallback's tell none: taken for the quickest, they made every ordinary reply after them
          // look heavy, 5 s of quiet each, until the run's time ran out. A reply answered while the calls go to the RPC
          // (`up`) may still be heavy: one the router got from it right after finding it again carries its probe's round
          // trip too, and is taken for heavy rather than risk the RPC's refusal after a scan.
          let own = router.primaryUp()
          let up = false
          let response: Response
          try {
            response = await router.send({ ...init, signal: joined.signal }, session)
            up = router.primaryUp()
            own &&= up
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
            restAfter(rest, now(), pace)
            publishRest(rest, now())
            share('rest')
            await response.body?.cancel().catch(() => undefined)
            return new Response(null, { status: 429, statusText: response.statusText })
          }
          // The work: to the reply's headers, for log reads and multi-header batches; the round trip learned from the
          // chain's own RPC's cheap replies only (`own`). A read that came heavyMs past it or more while the calls go to that
          // RPC: the node worked on it, heavyQuietMs of quiet at least, uncapped (see LANE_PACE, 2026-09-29).
          const took = now() - sent
          const work = own ? workOf(floor, init.body, took, now()) : workRead(init.body) ? Math.max(0, took - floor.ms) : 0
          const quiet = pace.workFactor * work
          quietUntil = now() + (up && work >= pace.heavyMs ? Math.max(pace.heavyQuietMs, quiet) : Math.min(pace.maxQuietMs, quiet))
          return counted(
            response,
            (bytes) => {
              refill()
              tokens -= bytes
              share(bytes)
            },
            joined.drop,
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
