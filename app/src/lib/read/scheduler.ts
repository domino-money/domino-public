/**
 * Paces one screen's reads the way the bridge admits them.
 *
 * The bridge runs one operation at a time, starts at most one per second, has
 * no waiting queue, and gives each IP 30 reads a minute with a burst of five
 * (docs/API_READ_BRIDGE.md). A table that fired all its reads at once would
 * mostly get 429s back. So reads from one screen go through one serial queue:
 * at least 1.1 s between starts, at most 12 distinct reads queued or running,
 * an identical read sharing the request already queued or in flight, and a
 * read nobody waits for any more cancelled.
 *
 * The queue also keeps the gateway's per-client budget for this tab: a burst
 * of five, then one more read every two seconds (30 a minute). Every attempt
 * on the wire takes one, an automatic retry included (a route answered from
 * the edge cache, EDGE_CACHED, gives it back), so the queue waits for
 * the budget the way the gateway counts it instead of drawing its 429, with
 * a quarter of a read kept in hand for requests that meet less transit delay
 * than the one before them. And
 * after a read comes back busy, the whole queue holds for the Retry-After
 * that answer asked for, plus up to R-1's 250 ms of jitter: the next read,
 * whichever it is, is not sent into a service that has just said it is full
 * (since 2026-10-30, the next read of that lane only; see the end of this note).
 *
 * R-1's 60 s for a read start here, when it is queued, so they cover the time
 * it waits in line; the source is handed what is left. They and the 1.1 s
 * between starts are measured on the monotonic clock (pipeline.ts), so a step
 * of the wall clock neither stalls the queue nor rushes it. A reader settles on
 * its own, at its abort or its deadline, queued or running, without cancelling
 * the read for anyone else who waits for it. The last one to leave cancels
 * the read and frees the queue at once, even from a source that ignores the
 * cancellation.
 *
 * A reader that joins an identical read is held to that read's deadline, its
 * first reader's, not to 60 s from its own enqueue. The first reader was
 * queued no later, so that deadline is never more than 60 s after the
 * joiner's enqueue either: a joiner can be stopped early, never kept late.
 *
 * This mirrors the pacing of the package's progressive.mjs. Its 429 retries
 * are pipeline.ts's, inside a job: the queue waits with them, and the next
 * read is paced from the job's last attempt, not its first. It does not import
 * progressive.mjs, which checks the contract header before the gate and would
 * turn a gate 401 into a contract mismatch.
 *
 * Two lanes and one priority (added 2026-09-25, r4/metrics). The one-start-a-
 * second rule is the gateway's provider lane only. Where read-v3 is listed,
 * the gateway admits its stored routes (overview, history, search) on a
 * stored lane of four slots with no start interval (backend/read_gateway.py,
 * `ReadGate(stored_capacity=4, stored_interval=0)`), so with `unspacedStored`
 * those reads neither wait for the 1.1 s nor move it on: they wait for the
 * budget and a busy hold only. Before, the six Markets cards' stored history
 * reads went 1.1 s apart for nothing, and the production tail showed them
 * two seconds apart once the budget ran low. And a read asked with
 * `priority: 'first'` starts before every queued read without it, even one
 * already waiting for its turn on the wire: the table's overview no longer
 * waits behind six card histories (it did for eleven seconds on production,
 * 2026-09-25 13:07 UTC).
 *
 * Two stored reads at once (added 2026-09-27, r6/marketsdata): stored-lane
 * reads go out beside each other, up to two, instead of each waiting for the
 * one before it to answer. Measured with production's latency in the harness
 * (tests/support/markets-latency.mjs), Markets' six card histories took 4.2 s
 * end to end, one after another. A read takes its budget when it starts, not
 * when its first attempt leaves (a read may wait for the capabilities first),
 * so two reads starting together never count on the same token; a read that
 * never sent anything gives it back.
 *
 * The speed wave (2026-09-28, the owner's approval of the speed study, items 1, 4, 5 and 34):
 *
 *   - `width` (it replaces the stored lane's own width): every read goes out beside the queue, of any lane, up to
 *     that many on the wire at once. The gateway runs two reads at a time (backend/read_gateway.py
 *     `anyio.CapacityLimiter(2)`), so the deployed source keeps two; a slow provider read (a v2 pool-market takes
 *     about 4.9 s) holds one of them and no longer the whole queue: the pool page's overview waited 4.9 s behind
 *     it, measured. A spaced read whose lane is taken, or whose start interval is not due, lets a read behind it go
 *     first. 1 (the default): one read at a time, as before;
 *   - since #241 the gateway's provider lane has sixteen slots and no start interval (backend/read_api.py
 *     `public_gate`), so the deployed source spaces provider reads 0 ms apart (`minIntervalMs`), and the old 1.1 s
 *     (`refusedIntervalMs`) comes back by itself, for the page's life (since 2026-10-30, until a quiet minute) and one
 *     provider read at a time, the first time a provider read meets a refusal, as a gateway older than #241 answers a
 *     start inside its 1 s;
 *   - a refusal means the gateway counted more than the queue did: a read that settles busy leaves the budget at
 *     nothing, and a retry, which goes once the Retry-After has filled the gateway's own count to one, at one
 *     before it spends it; the budget fills again at its own pace (since 2026-10-30, the refused lane's own count);
 *   - `budgetStore`: the budget is this browser's, not this document's. A reload, a pasted link or a second tab
 *     starts from what the others left (appSourceBridge.ts keeps it in localStorage), and a read that waited for
 *     it looks again before it goes, in case another tab spent it meanwhile. A pool opened 1.5 s after Markets
 *     drew four refusals and its activity waited 6 s, measured;
 *   - the featured list (EDGE_ANSWERED) still goes without waiting for the budget, since the edge cache answers it
 *     almost always, but now takes its read from it, and gives it back when its answer came from the edge cache
 *     (`X-Domino-Edge-Cache: hit`, provenance `edge`: no Worker, so no gateway, handled it). It used to take none,
 *     and a miss that did reach the gateway drew refusals on Markets. A history read the edge answered (EDGE_CACHED)
 *     gives its read back the same way, and so does any read answered in front of the gateway (UNCOUNTED);
 *   - a source that throws, instead of answering, settles its read as unavailable (a network failure) at once: it
 *     used to hold every reader, and the queue, until the 60 s.
 *
 * Changed on purpose 2026-10-30 (launch capacity study, item 9b): a refusal holds only the lane it came from. The gateway
 * counts each visitor per lane (backend/read_gateway.py VISITOR_BUDGETS: stored and provider apart), so a provider read's
 * 429 says nothing of the stored lane, yet it held every read of the page: the busy hold was the whole queue's, and the
 * refusal left the one budget at nothing, the edge-cached overview, history and featured list included. With
 * `unspacedStored` (the deployed build, where the gateway has both lanes):
 *   - a busy answer holds the reads of its own lane (STORED_LANE or the provider lane) for its Retry-After, and a
 *     refusal leaves what that lane alone may spend (`cap`) at what the gateway left it, refilled at the budget's pace;
 *     the other lane goes on with the tab's budget as it stood. That `cap` is kept with the browser's budget
 *     (`budgetStore`), so a reload or a second tab waits for it too; the busy hold stays this document's, as before;
 *   - the routes the edge answers from its cache (EDGE_CACHED) wait for neither: no lane hold, no refusal's cap, only
 *     the tab's own budget as before (the featured list not even that);
 *   - a read held by its lane lets a read queued behind it go first: another lane's, or one the edge answers, even after
 *     a reader asked first joined the held read (which keeps its turn); and a read on the wire that settles lets the
 *     queue look again, for a read its lane held behind it;
 *   - the provider lane's refused spacing (`refusedIntervalMs`) goes back to `minIntervalMs` after a minute with no
 *     refusal (REFUSAL_QUIET_MS); it stayed for the page's life.
 * The budget itself is unchanged (GATEWAY_BUDGET, the provider lane's burst is not raised for every browser). Without
 * `unspacedStored` (local-live, the fixtures) there is one lane, which every read waits for, as before.
 */
import { BRIDGE_RETRY, realClock, settleBy, type Clock, type Settled } from './pipeline'
import type { Provenance, ReadOptions, ReadOutcome, ReadRequests, ReadRoute, ReadSource, RouteCheck } from './types'

/** A per-client budget: `burst` attempts at once, then `perMinute` a minute. */
export interface ReadBudget {
  burst: number
  perMinute: number
}

/** The gateway's per-client budget (backend ClientBudgets), which this tab keeps for itself. */
export const GATEWAY_BUDGET: ReadBudget = { burst: 5, perMinute: 30 }
/** Of an attempt, what the queue keeps in hand beyond the one it spends: 500 ms at 30 a minute, for transit jitter. */
export const BUDGET_RESERVE = 0.25

/**
 * The stored routes the gateway admits on its stored lane: four at a time, no start interval. Listed only where
 * read-v3 is enabled, which is where the gateway builds that lane (backend/read_gateway.py). read-v5's featured list
 * (2026-09-26) is a stored read too, one answer the same for everyone (featured pools v1 §10.6, §11.1).
 */
export const STORED_LANE: ReadonlySet<ReadRoute> = new Set<ReadRoute>(['overview', 'history', 'search', 'featured-pools'])

/**
 * Routes a Pages Function may answer from its edge cache (functions/_lib/featuredEdge.ts, publicEdge.ts), which the
 * gateway's per-client budget then never counts. Such a read takes its budget like any other and gives it back when
 * its answer says it came from that cache (provenance `edge`). Added 2026-09-28 (speed wave, items 4 and 45); the
 * stored overview since 2026-10-01 (audit A14, functions/_lib/overviewEdge.ts).
 */
export const EDGE_CACHED: ReadonlySet<ReadRoute> = new Set<ReadRoute>(['featured-pools', 'history', 'overview'])

/**
 * Routes the edge answers almost always (the featured list: one answer for everyone, kept for up to 15 minutes), which
 * therefore never wait for the budget: the list is the first read of Home and Markets, on a 1.5 s deadline. Changed on
 * purpose 2026-09-28 (speed wave, item 4): it used to take no budget at all, and its cache misses, which do reach the
 * gateway, drew refusals; now it takes one at its start and gives it back when the edge answered (EDGE_CACHED).
 */
export const EDGE_ANSWERED: ReadonlySet<ReadRoute> = new Set<ReadRoute>(['featured-pools'])

/**
 * Answers made in front of the gateway, whose per-client budget therefore never counted the attempt that drew them:
 * the beta gate's and Cloudflare Access's own, and no read Worker behind the site. The attempt gives its read back.
 * Added 2026-09-28 (speed wave, item 4), with a route of EDGE_CACHED switched off: the read Worker's own switch
 * (READ_V5_BRIDGE_ENABLED, ENABLED_V3_READS), so the Worker's refusal. Home's list read, refused so, held the six
 * Markets cards' history reads 2 s, measured.
 */
export const UNCOUNTED: ReadonlySet<ReadOutcome['state']> = new Set<ReadOutcome['state']>(['gate_required', 'gate_unavailable', 'access_required', 'not_connected'])
const uncounted = (route: ReadRoute, outcome: ReadOutcome) =>
  outcome.state === 'ok' ? EDGE_CACHED.has(route) && outcome.provenance.edge === true : UNCOUNTED.has(outcome.state) || (outcome.state === 'disabled' && EDGE_CACHED.has(route))

/**
 * After a refusal, how long with no other before the provider lane's spacing goes back to `minIntervalMs` (2026-10-30,
 * launch capacity item 9b: it used to stay at `refusedIntervalMs` for the page's life).
 */
export const REFUSAL_QUIET_MS = 60_000

/** The gateway's two lanes (2026-10-30, launch capacity item 9b). */
type LaneName = 'stored' | 'provider'
const LANE_NAMES: readonly LaneName[] = ['stored', 'provider']

/**
 * One of the gateway's two lanes as this tab keeps it (2026-10-30, launch capacity item 9b): what a refusal of its reads
 * holds, for its reads alone.
 */
interface LaneState {
  /** No read of this lane starts before this monotonic reading: the Retry-After of its last busy answer. */
  holdUntil: number
  /**
   * What this lane may still spend since its last refusal, counted at `at` (on the budget's clock: the wall clock when the
   * budget is the browser's, else this document's monotonic one), refilled at the budget's pace up to its burst; null
   * when no refusal is outstanding. A read waits for this and the tab's budget. Kept with the browser's budget (since
   * 2026-10-30 after review), so a reload or another tab waits for it too.
   */
  cap: { tokens: number; at: number } | null
  /** Reads of this lane holding the budget they took at their start, nothing sent yet. */
  holding: number
}

/** The budget as this browser keeps it: the attempts left, counted at `at` (wall-clock ms). */
export interface BudgetState {
  tokens: number
  at: number
  /**
   * What a lane may still spend since its last refusal, each counted at its own `at` (wall-clock ms); a lane with none
   * outstanding is left out. Added 2026-10-30 after review (item 9b): a refusal left the one budget at nothing for every
   * document of the browser, and once it held only its lane, a reload or a second tab no longer saw it.
   */
  lanes?: Partial<Record<LaneName, { tokens: number; at: number }>>
}

/** Where a budget shared by this browser's documents is kept (appSourceBridge.ts). Either call may throw. */
export interface BudgetStore {
  load(): BudgetState | null
  save(state: BudgetState): void
}

/** The budget in this browser's localStorage under `key`. The scheduler checks what it reads back, and outlives either call throwing. */
export const storedBudget = (key: string): BudgetStore => ({
  load: () => JSON.parse(localStorage.getItem(key) ?? 'null'),
  save: (state) => localStorage.setItem(key, JSON.stringify(state)),
})

export interface SchedulerOptions {
  /** Between two spaced reads' starts. */
  minIntervalMs?: number
  /** The spacing a spaced read's refusal brings back for the page's life. Absent: `minIntervalMs` stays. */
  refusedIntervalMs?: number
  maxPending?: number
  /** A read's whole budget from the moment it is queued: R-1's 60 s. */
  totalMs?: number
  clock?: Clock
  /** The attempts this tab may send: the gateway's budget unless given. Null: spacing alone. */
  budget?: ReadBudget | null
  /** Where the budget is shared with this browser's other documents. Absent: this document's own, on the monotonic clock. */
  budgetStore?: BudgetStore | null
  /**
   * Stored-lane reads (STORED_LANE) skip `minIntervalMs`: they neither wait for it nor move it on, and keep the
   * budget and a busy hold. Absent or false: every read is spaced, as the development reader (local-live) needs.
   */
  unspacedStored?: boolean
  /** How many reads may be on the wire at once, every lane together. 1 (the default): one read at a time. */
  width?: number
}

interface Job {
  key: string
  route: ReadRoute
  run: (signal: AbortSignal) => Promise<ReadOutcome>
  controller: AbortController
  waiters: number
  promise: Promise<ReadOutcome>
  resolve: (outcome: ReadOutcome) => void
  /** Held to the start spacing: a provider-lane read, or any read without `unspacedStored`. */
  spaced: boolean
  /** Asked with `priority: 'first'`. */
  first: boolean
  /** The budget it took at its start, not yet used by an attempt. */
  held?: boolean
  /** Attempts on the wire so far: a second one means the first was refused. */
  attempts: number
}

const usable = (state: unknown, burst: number): state is BudgetState => {
  const kept = state as BudgetState | null
  return typeof kept === 'object' && kept !== null && Number.isFinite(kept.tokens) && Number.isFinite(kept.at) && kept.tokens <= burst && kept.tokens >= -2 * burst
}

export function createScheduledSource(
  source: ReadSource,
  { minIntervalMs = 1100, refusedIntervalMs, maxPending = 12, totalMs = BRIDGE_RETRY.totalMs, clock = realClock, budget = GATEWAY_BUDGET, budgetStore = null, unspacedStored = false, width = 1 }: SchedulerOptions = {},
): ReadSource {
  const queue: Job[] = []
  /** Reads on the wire, each until it settles. */
  const flights = new Set<Promise<void>>()
  let spacedFlights = 0
  const byKey = new Map<string, Job>()
  let running = false
  /** The start spacing now: `refusedIntervalMs` once a spaced read met a refusal, until REFUSAL_QUIET_MS pass with none. */
  let interval = minIntervalMs
  /** The monotonic reading of the last refusal of a spaced read. */
  let refusedAt = -Infinity
  /** The last start of a spaced read. */
  let lastStart = -Infinity
  /**
   * The gateway's two lanes (2026-10-30, launch capacity item 9b): a refusal holds its own. A spaced read is the provider
   * lane's; with `unspacedStored`, a stored read (STORED_LANE) the stored lane's. Without it, every read is spaced: one lane.
   */
  const lanes: Record<LaneName, LaneState> = {
    stored: { holdUntil: -Infinity, cap: null, holding: 0 },
    provider: { holdUntil: -Infinity, cap: null, holding: 0 },
  }
  const laneOf = (job: Job): LaneState => lanes[job.spaced ? 'provider' : 'stored']
  /** A read the edge answers from its cache, where the gateway has two lanes: no lane hold and no refusal's cap holds it. */
  const unheld = (job: Job) => unspacedStored && EDGE_CACHED.has(job.route)
  /**
   * Ends the wait of the read next on the wire: one without priority, so a read asked first can take its turn; or one
   * waiting for its own lane alone (laneNap), so a read that may go now can pass it.
   */
  let wake: AbortController | null = null
  /** The read waiting for its turn on the wire, out of the queue while it waits. */
  let napping: Job | null = null
  /**
   * It waits for its own lane alone (its spacing, its lane's hold, what its lane may spend since a refusal), not for the
   * tab's budget: a read that may go now (another lane's, or one the edge answers), joining the line meanwhile, goes
   * first, and so may a read its lane held behind a read on the wire, once that read settles.
   */
  let laneNap = false
  /** Ends that wait early, for the read to look again: the budget came back (a read the edge answered, one never sent). */
  let napper: AbortController | null = null
  /** That wait ended for the budget, not for another read: the read keeps its turn. */
  let budgetBack = false
  /** Ends the queue's idle wait: a read joined the line, or one on the wire settled. */
  let kicker: (() => void) | null = null
  const kick = () => {
    const go = kicker
    kicker = null
    go?.()
  }

  /** In line: a first read after the first reads already queued, any other read at the end, or at the head of its kind when `back` (a read that gave up its turn). */
  const enqueue = (job: Job, back = false) => {
    const at = job.first || back ? queue.findIndex((queued) => !queued.first) : -1
    if (at === -1) queue.push(job)
    else queue.splice(at, 0, job)
    // A read asked first wakes a read without priority; a read that may go now wakes one waiting for its own lane alone
    // (2026-10-30: it used to be a stored read waking a spaced one, the only lane wait there was). Fixed 2026-10-30 after
    // review: a read asked first no longer wakes one asked first too (or joined by such a reader) that waits for its
    // spacing alone; it took that read's turn, and a read that may go now wakes it anyway.
    if ((job.first && !napping?.first) || (laneNap && laneWait(job, clock.monotonic()) <= 0)) wake?.abort()
    kick()
  }

  // The per-client budget: tokens refill at `perMinute` a minute up to `burst`. Shared with this browser's other
  // documents through `budgetStore`, on the wall clock (the one clock they share), else this document's own, on the
  // monotonic one. A kept count that cannot be read, or makes no sense, leaves this document's own as it is.
  const perMs = budget ? budget.perMinute / 60_000 : 0
  const store = budget ? budgetStore : null
  const stamp = () => (store ? clock.now() : clock.monotonic())
  let tokens = budget ? budget.burst : Infinity
  let filledAt = stamp()
  /**
   * Reads of this document holding the budget they took at their start, nothing sent yet: counted here, never kept for
   * the others, so a document that goes away before they are sent leaves nothing behind for them.
   */
  let holding = 0
  /** The kept budget this document last read or wrote: one that differs from it, another document wrote since. */
  let seen: BudgetState | null = null
  /**
   * What this document spent that the kept budget does not show: all it spent before a read of it met the read service
   * (nothing is kept until then, see `met`), or since a save that failed. Another document's budget never counted it.
   */
  let unsaved = 0
  /**
   * This document's own count, refilled to now; taken afresh from the kept budget when another document wrote it,
   * less what this document holds and has not kept (fixed 2026-09-28 after review: it used to be taken afresh at every
   * look, so a document whose reads had not met the read service yet forgot its own spends, and a reload that found
   * 2.3 kept sent its third read into a refusal). The kept budget is filled to now first, the burst at most, and only
   * then does this document's part come off: never more than there is.
   */
  const refill = () => {
    if (!budget) return
    const at = stamp()
    try {
      const kept = store?.load()
      if (usable(kept, budget.burst) && (kept.at !== seen?.at || kept.tokens !== seen.tokens)) {
        seen = kept
        tokens = Math.min(budget.burst, kept.tokens + Math.max(0, at - kept.at) * perMs) - holding - unsaved
        filledAt = at
        // A lane another document saw refused (2026-10-30 after review, item 9b): this one waits for what that lane has
        // left too, less what this document's reads of that lane hold; never more than its own count of it.
        for (const name of LANE_NAMES) {
          const theirs = kept.lanes?.[name]
          if (!usable(theirs, budget.burst)) continue
          const filled = Math.min(budget.burst, theirs.tokens + Math.max(0, at - theirs.at) * perMs)
          if (filled >= budget.burst) continue
          const lane = lanes[name]
          const left = filled - lane.holding
          if (left < capOf(lane)) lane.cap = { tokens: left, at }
        }
      }
    } catch {
      // Blocked storage: this document's own count.
    }
    // A clock stepped back refills nothing; one stepped forward, the burst at most (what this document holds included).
    tokens = Math.min(budget.burst - holding, tokens + Math.max(0, at - filledAt) * perMs)
    filledAt = at
  }
  /**
   * Whether a read of this document met the read service (an answer with its contract header, or a refusal): only then
   * is the budget kept for the others, so a page whose reads meet nothing (a build with no bridge) keeps nothing.
   */
  let met = false
  const keep = () => {
    if (!met || !store) return
    const state: BudgetState = { tokens: tokens + holding, at: filledAt }
    // Each lane with a refusal outstanding, as the others may count it: what this document's reads of it hold is not kept.
    for (const name of LANE_NAMES) {
      const lane = lanes[name]
      if (capOf(lane) === Infinity) continue
      state.lanes = { ...state.lanes, [name]: { tokens: lane.cap!.tokens + lane.holding, at: lane.cap!.at } }
    }
    try {
      store.save(state)
      seen = state
      unsaved = 0
    } catch {
      // Full or blocked: the next read counts from this document's own.
    }
  }
  /** Spends `by` (gives it back when negative), and moves `holds` reads in or out of holding, in one count. */
  const spend = (by = 1, holds = 0) => {
    if (!budget) return
    refill()
    const before = tokens + holding
    holding += holds
    tokens = Math.min(budget.burst - holding, tokens - by)
    unsaved += before - tokens - holding
    if (by < 0 && napper) {
      budgetBack = true
      napper.abort()
    }
    keep()
  }
  /**
   * Ms until an attempt is in the budget, with a quarter of one more in hand; 0 when it is there now. The
   * gateway counts an attempt when it arrives, and transit is not the same for every request: without the
   * quarter, a request that met less delay than the one before it would arrive a moment early and draw the
   * 429 this budget is here to avoid. The burst and the rate are the gateway's. A retry may have spent past zero.
   */
  const budgetWait = () => {
    if (!budget) return 0
    refill()
    const wanted = 1 + BUDGET_RESERVE
    // A thousandth of a millisecond forgiven, so the float sums of refilling never add a whole millisecond.
    return tokens >= wanted - 1e-9 ? 0 : Math.ceil((wanted - tokens) / perMs - 1e-3)
  }
  /** What `lane` may still spend since its last refusal, refilled to now; Infinity when no refusal is outstanding. */
  const capOf = (lane: LaneState): number => {
    const cap = lane.cap
    if (!cap || !budget) return Infinity
    const at = stamp()
    cap.tokens = Math.min(budget.burst, cap.tokens + Math.max(0, at - cap.at) * perMs)
    cap.at = at
    if (cap.tokens < budget.burst) return cap.tokens
    lane.cap = null
    return Infinity
  }
  /** Spends `by` of what `lane` may still spend since its last refusal (gives it back when negative), if a refusal is outstanding. */
  const capSpend = (lane: LaneState, by: number) => {
    if (capOf(lane) !== Infinity) lane.cap!.tokens -= by
  }
  /** Ms until `lane` may spend an attempt and a quarter since its last refusal; 0 when it may now, or none is outstanding. */
  const capWait = (lane: LaneState) => {
    const left = capOf(lane)
    const wanted = 1 + BUDGET_RESERVE
    return left >= wanted - 1e-9 ? 0 : Math.ceil((wanted - left) / perMs - 1e-3)
  }
  /**
   * The gateway refused a read: it counted more than the queue did, so no more than `left` is left (0 when the read
   * settles busy, 1 when its retry goes out), and a spaced read's refusal brings the spacing back.
   * Changed on purpose 2026-10-30 (launch capacity item 9b): what is left is the refused lane's alone (its `cap`, less
   * the reads of that lane holding the budget), never the tab's budget, which the other lane keeps spending; and the
   * spacing's refusal is dated, so a quiet minute takes it back. With one lane (no `unspacedStored`) every read waits for
   * that cap, as every read waited for the budget left at nothing.
   */
  const refused = (job: Job, left: number) => {
    const lane = laneOf(job)
    if (budget) {
      refill()
      const kept = capOf(lane)
      lane.cap = { tokens: Math.min(kept === Infinity ? tokens : kept, left - lane.holding), at: stamp() }
      // Kept for this browser's other documents (fixed 2026-10-30 after review): a reload or a second tab waits for it too.
      keep()
    }
    if (job.spaced && refusedIntervalMs !== undefined) {
      interval = Math.max(interval, refusedIntervalMs)
      refusedAt = clock.monotonic()
    }
  }
  /**
   * Ms until `job`'s lane lets it go, its spacing aside: its lane's busy hold and what its lane may spend since a refusal
   * (neither for a read the edge answers from its cache, with two lanes; no cap for the featured list, which never waits
   * for the budget).
   */
  const laneRest = (job: Job, now: number) => {
    if (unheld(job)) return 0
    const lane = laneOf(job)
    return Math.max(lane.holdUntil - now, EDGE_ANSWERED.has(job.route) ? 0 : capWait(lane))
  }
  /** Ms until `job` may go as far as its own lane says: its spacing (a spaced read's) too. The tab's budget is the other wait (budgetWait), the same for all. */
  const laneWait = (job: Job, now: number) => Math.max(job.spaced ? lastStart + interval - now : 0, laneRest(job, now))

  /** One read on the wire until it settles: its budget, its registration, the hold a busy answer asks for, its answer. */
  async function fly(job: Job) {
    const { signal } = job.controller
    const lane = laneOf(job)
    if (job.spaced) lastStart = clock.monotonic()
    if (budget) {
      spend(1, 1)
      capSpend(lane, 1)
      lane.holding += 1
      job.held = true
    }
    // Registered until it settles, so an identical read joins it in flight. Let go
    // of as soon as nobody waits: a source that ignores the abort cannot hold the queue.
    let settled: Settled<ReadOutcome>
    try {
      settled = await settleBy(clock, job.run(signal), Infinity, signal)
    } catch {
      // A source that threw instead of answering: what it sent, if anything, is unknown, as after a dropped connection.
      settled = { kind: 'done', value: { route: job.route, state: 'unavailable', cause: { kind: 'network' }, retryable: false,
        provenance: { transport: source.transport, contract: null, receivedAt: clock.now(), receivedMonotonic: clock.monotonic(), attempts: job.attempts } } }
    }
    // Nothing went out: the budget it took goes back, and an attempt still to come (a reader left, the read goes on)
    // spends its own.
    if (job.held) {
      job.held = false
      lane.holding -= 1
      capSpend(lane, -1)
      spend(-1, -1)
    }
    if (byKey.get(job.key) === job) byKey.delete(job.key)
    if (settled.kind !== 'done') return
    // Busy after R-1, or with a wait its read could not afford: its lane waits what the service asked (the whole queue,
    // with one lane).
    const outcome = settled.value
    if (!met && store && (outcome.state === 'busy' || outcome.provenance.contract)) {
      met = true
      // Counted again first: another document may have kept a budget meanwhile, and this one's spends come off it.
      refill()
      keep()
    }
    if (outcome.state === 'busy') {
      lane.holdUntil = Math.max(lane.holdUntil, clock.monotonic() + outcome.retryAfterSeconds * 1000 + Math.floor(clock.random() * BRIDGE_RETRY.jitterMs))
      refused(job, 0)
    } else if (job.attempts > 0 && uncounted(job.route, outcome)) {
      // Answered from the edge cache, or in front of the gateway (UNCOUNTED): the gateway never counted its last attempt.
      capSpend(lane, -1)
      spend(-1)
    }
    job.resolve(outcome)
  }

  /**
   * Reads on the wire that take a place of the width: all but the ones the edge answers almost always (EDGE_ANSWERED),
   * which the gateway's two workers never see then; one it does see waits there for its turn, as before.
   */
  let wide = 0
  /** Puts a read on the wire, beside the queue. */
  function start(job: Job) {
    const counted = !EDGE_ANSWERED.has(job.route)
    if (job.spaced) spacedFlights += 1
    if (counted) wide += 1
    const done = () => {
      flights.delete(flight)
      if (job.spaced) spacedFlights -= 1
      if (counted) wide -= 1
      // A read waiting for its own lane alone looks again (fixed 2026-10-30 after review): a read its lane held behind the
      // one that just settled (one provider read at a time after a refusal) may go now, not when that nap ends.
      if (laneNap) wake?.abort()
      kick()
    }
    const flight: Promise<void> = fly(job).then(done, done)
    flights.add(flight)
  }

  /**
   * The next read to go, in line order: with the width taken (`full`), only a read the edge answers; a spaced read
   * whose lane is taken (one at a time while spaced, else the width) waits, and one whose spacing is not due lets a
   * read behind it go first.
   */
  function pick(now: number, full: boolean): Job | null {
    // A quiet minute since the last refusal: the provider lane's spacing as it was (2026-10-30, launch capacity item 9b).
    if (interval !== minIntervalMs && now - refusedAt >= REFUSAL_QUIET_MS) interval = minIntervalMs
    // What the browser's other documents kept, a lane they saw refused included (2026-10-30 after review), before any
    // read is judged by its lane.
    refill()
    // Changed on purpose 2026-10-30 (item 9b): a read its own lane holds (its spacing, as before, and now its lane's busy
    // hold or a refusal's cap) lets a read behind it go first; with none that may go, the one its lane frees soonest.
    let soonest = -1
    let least = Infinity
    for (let i = 0; i < queue.length; i++) {
      const job = queue[i]
      if (job.controller.signal.aborted) {
        queue.splice(i--, 1)
        continue
      }
      if (full && !EDGE_ANSWERED.has(job.route)) continue
      if (job.spaced && spacedFlights >= (interval > 0 ? 1 : width)) continue
      const own = laneWait(job, now)
      if (own > 0) {
        if (own < least) {
          least = own
          soonest = i
        }
        continue
      }
      return queue.splice(i, 1)[0]
    }
    return soonest === -1 ? null : queue.splice(soonest, 1)[0]
  }

  async function drain() {
    if (running) return
    running = true
    try {
      for (;;) {
        const job = pick(clock.monotonic(), wide >= width)
        if (!job) {
          // Nothing may go now: a read on the wire settling, or a new one in line, looks again.
          if (flights.size === 0 || queue.length === 0) break
          await new Promise<void>((resolve) => {
            kicker = resolve
          })
          continue
        }
        const { signal } = job.controller
        const now = clock.monotonic()
        // One wait for all: the spacing (a spaced read's only), its lane's busy hold and refusal's cap (laneWait), and
        // the tab's budget.
        const rest = laneRest(job, now)
        const shared = EDGE_ANSWERED.has(job.route) ? 0 : budgetWait()
        const wait = Math.max(job.spaced ? lastStart + interval - now : 0, rest, shared)
        if (wait > 0) {
          const nap = new AbortController()
          const stop = () => nap.abort()
          signal.addEventListener('abort', stop, { once: true })
          laneNap = shared <= 0
          if (!job.first || laneNap) wake = nap
          napping = job
          napper = nap
          budgetBack = false
          try {
            await clock.sleep(wait, nap.signal)
          } catch {
            // Cancelled by its last reader, or woken for a read asked first (or, while it waits for its own lane alone,
            // for a read that may go now).
          } finally {
            signal.removeEventListener('abort', stop)
            if (wake === nap) wake = null
            napping = null
            napper = null
            laneNap = false
          }
          if (signal.aborted) continue
          // Woken for another read, a read without priority goes back to the head of its kind, and that read takes the
          // turn. One asked first is woken only while its own lane holds it (for a read that may go now, or to look again
          // when a read on the wire settled): it keeps its place at the head of the line and a read that may go passes it
          // (fixed 2026-10-30 after review: sent behind later reads asked first, one its lane held too took its turn).
          // Otherwise it keeps its turn and is looked at again: another tab may have spent the budget meanwhile, or it
          // came back.
          if (nap.signal.aborted && !budgetBack && !job.first) enqueue(job, true)
          else queue.unshift(job)
          continue
        }
        start(job)
      }
    } finally {
      running = false
    }
  }

  /** A reader stops waiting. The last one cancels the read and takes it off the count. */
  function leave(job: Job, outcome: ReadOutcome) {
    job.waiters -= 1
    if (job.waiters > 0) return
    job.controller.abort()
    // A later identical read starts afresh instead of joining a cancelled one.
    if (byKey.get(job.key) === job) byKey.delete(job.key)
    job.resolve(outcome)
  }

  const inner = source.routeEnabled?.bind(source)
  return {
    transport: source.transport,
    ...(source.supportsStoredReads ? { supportsStoredReads: true as const } : {}),
    // Whether a route is listed is the source's own capabilities answer, never a job: it takes no place in
    // the queue and moves no pacing, so a screen can skip a route that is off without waiting a turn for it.
    ...(inner ? { routeEnabled: (route: ReadRoute, opts?: Pick<ReadOptions, 'signal' | 'deadlineAt'>): Promise<RouteCheck> => inner(route, opts) } : {}),
    read<R extends ReadRoute>(route: R, request: ReadRequests[R], opts: ReadOptions = {}): Promise<ReadOutcome<R>> {
      // The budget runs from here. A restart keeps what is left of the read it restarts.
      const deadlineAt = Math.min(opts.deadlineAt ?? Infinity, clock.monotonic() + totalMs)
      const provenance = (): Provenance => ({ transport: source.transport, contract: null, receivedAt: clock.now(), receivedMonotonic: clock.monotonic(), attempts: 0, deadlineAt })
      const aborted = (): ReadOutcome<R> => ({ route, state: 'aborted', provenance: provenance() })
      const expired = (): ReadOutcome<R> => ({ route, state: 'unavailable', cause: { kind: 'read_deadline', limit: 'read' }, retryable: true, provenance: provenance() })
      if (opts.signal?.aborted) return Promise.resolve(aborted())
      if (clock.monotonic() >= deadlineAt) return Promise.resolve(expired())

      const key = `${route}\u0000${JSON.stringify(request)}`
      const first = opts.priority === 'first'
      let job = byKey.get(key)
      if (!job) {
        if (byKey.size >= maxPending) {
          return Promise.resolve({ route, state: 'unavailable', cause: { kind: 'queue_full' }, retryable: true, provenance: provenance() })
        }
        let resolve!: (outcome: ReadOutcome) => void
        const promise = new Promise<ReadOutcome>((done) => {
          resolve = done
        })
        const spaced = !(unspacedStored && STORED_LANE.has(route))
        // Every attempt of the job, an automatic retry included, spends the budget, the first one what the job took at
        // its start, and a spaced one moves the pace on. A second attempt means the first was refused.
        const made: Job = { key, route, run: (signal) => source.read(route, request, { signal, deadlineAt, onAttempt: () => {
          made.attempts += 1
          if (spaced) lastStart = clock.monotonic()
          if (made.attempts > 1) refused(made, 1)
          if (made.held) {
            // The budget it took at its start is spent now.
            made.held = false
            laneOf(made).holding -= 1
            spend(0, -1)
          } else {
            capSpend(laneOf(made), 1)
            spend()
          }
        } }), controller: new AbortController(), waiters: 0, promise, resolve, spaced, first, attempts: 0 }
        byKey.set(key, (job = made))
        enqueue(made)
      } else if (first && !job.first) {
        // Joined by a reader asked first while it is still in line: it moves up with that reader. Already waiting for
        // its turn on the wire (out of the queue), it keeps that turn: no later read asked first takes it (fixed
        // 2026-09-25 after review; it used to be woken and sent back behind such a read). Fixed 2026-10-30 after review:
        // waiting for its own lane alone, it can still be woken by a read that may go now (enqueue), which passes it and
        // leaves it its turn; its lane's hold (a provider Retry-After, say) no longer holds the edge-cached overview.
        job.first = true
        const at = queue.indexOf(job)
        if (at !== -1) {
          queue.splice(at, 1)
          enqueue(job)
        } else if (napping === job && !laneNap) wake = null
      }

      const shared = job
      shared.waiters += 1
      const answer = settleBy(clock, shared.promise, deadlineAt, opts.signal).then((settled): ReadOutcome<R> => {
        if (settled.kind === 'done') return settled.value as ReadOutcome<R>
        // This reader alone stops waiting; the read goes on for anyone else.
        const outcome = settled.kind === 'aborted' ? aborted() : expired()
        leave(shared, outcome)
        return outcome
      })
      void drain()
      return answer
    },
  }
}
