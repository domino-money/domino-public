/**
 * Reads of a position at chosen PAST blocks, for the Fees earned chart's periods (restored on purpose 2026-10-02, the
 * owner: "the chart had 24 hours, 7 days and all; that went missing") and Your APR's last 24 hours.
 *
 * Where a period starts is a measured point (lib/fees/periods.ts). Most often the history already has one: the mint, a
 * settlement (an Auto-compound position settles a few times a day), this browser's own readings. When it has none in the
 * period's window, one read of the position at a past block gives one, exactly:
 *
 *   Fees earned at block B = the ledger's settlements up to B (exact) + the fees ready to collect at B
 *
 * the second from read-v1 `nft-positions` at `blockNumber` B, through the site's read bridge to rugged97's read gateway
 * (its formula, ((growthInside − last) mod 2^256) × L >> 128, is /state's own; its snapshot is block B's header, so the
 * point carries its own exact time). No log and no pool history is read, and nothing of the site's chain routes: this is
 * the page's own scheduled read source (lib/read/buildMode.ts loadReadSource), its budget shared with every other read.
 *
 * Which blocks, cheapest first:
 *   - a period that reaches back to the mint starts at the opened point: no read;
 *   - an existing measured point inside the period's window: no read;
 *   - else one read at B = the block estimated at the nominal start (blockAt: between the exact headers the page holds),
 *     floored to the period's grid, so every viewer of a position asks the same blocks within an hour, six hours or a day.
 *     An answer outside the window is kept as a point anyway, and one corrected read is made with it as a new anchor;
 *     a second miss leaves the period unavailable for the view.
 *   - fills: inside a drawn period, the longest stretch between measured points, when longer than a quarter of the
 *     period, gets one read at the grid block nearest its middle; at most MAX_FILLS a period a view, never retried.
 *
 * Pacing (the gateway's budget is 5 at once and 30 a minute per address, shared with Markets and the other reads): one
 * read on its way for the whole page, start reads START_SPACING_MS apart, fills FILL_SPACING_MS apart, at most
 * MAX_READS_PER_VIEW per NFT while a screen shows it, and only while the page is visible (`later`). Only for a `verified`
 * view: never for a saved copy (`cached`) or a position whose fees earned are not exact. One id per read. A start read
 * that fails is asked again after START_RETRY_MS (never sooner than a busy answer's Retry-After); an answer that is not
 * this position as the ledger has it at B is let go and ends that period's start for the view (asking the same final
 * block again would get the same answer). Every good answer is kept: this browser's readings (readings.ts insert), or,
 * past the 30 days they keep (a 30D start), in memory for the visit (`held`).
 *
 * Pure apart from its dependencies; no storage, clock or network of its own. Node-safe.
 */
import { POSITION_MANAGER } from './constants'
import { PERIODS, periodStart, type FeesPeriod, type TimedPeriod } from './periods'
import type { Reading } from './readings'
import type { FeeDisplayState, FeeHistory, FeeHistoryView, FeePoint } from './types'

/** The chain's pace, about 9.9 blocks a second, where the page holds no header on one side of a time. */
export const BLOCKS_PER_SECOND = 9.9
/** Start reads at least this far apart. */
export const START_SPACING_MS = 1_500
/** Fill reads at least this far apart. */
export const FILL_SPACING_MS = 6_000
/** At most this many reads of one NFT while a screen shows it. */
export const MAX_READS_PER_VIEW = 8
/** At most this many fills of one period of one NFT while a screen shows it. */
export const MAX_FILLS = 2
/** After a start read that failed, the waits before it is asked again; past the last, the period is unavailable. */
export const START_RETRY_MS = [10_000, 30_000, 60_000, 120_000] as const
/** How long an NFT's view goes on after its last screen leaves (a remount picks it up), as the fees store's. */
export const PAST_RELEASE_MS = 3_000
/** A route check that could not be answered is asked again after this long, by the next screen that wants it. */
export const LISTED_RECHECK_MS = 60_000
/** At most this many reads held in memory per NFT (those too old for this browser's readings). */
const MAX_HELD = 32

const UINT = /^(?:0|[1-9]\d{0,77})$/
const HASH = /^0x[0-9a-f]{64}$/

/** A block and its header's time (Unix seconds): exact, from a read the page made. */
export interface Anchor {
  block: number
  t: number
}

/** Whether a period can be drawn: its start known (`drawn`), being read, not readable now, or not offered here (`off`). */
export type PastStatus = 'drawn' | 'reading' | 'unavailable' | 'off'

/** A read's outcome as the page's read source gives it (lib/read/types.ts ReadOutcome), checked field by field here. */
export interface PastOutcome {
  state: string
  data?: unknown
  retryAfterSeconds?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Every exact header the history holds: the mint, each settlement and each measured point; oldest first, one per block. */
export function anchorsOf(history: Pick<FeeHistory, 'mintedAt' | 'events' | 'points'>, extra: readonly Anchor[] = []): Anchor[] {
  const byBlock = new Map<number, Anchor>()
  const add = (block: number, t: number) => {
    if (Number.isSafeInteger(block) && block > 0 && Number.isFinite(t) && t > 0 && !byBlock.has(block)) byBlock.set(block, { block, t })
  }
  add(history.mintedAt.block, history.mintedAt.timestamp)
  for (const event of history.events) add(event.block, event.timestamp)
  for (const point of history.points) add(point.block, point.t)
  for (const anchor of extra) add(anchor.block, anchor.t)
  return [...byBlock.values()].sort((a, b) => a.t - b.t || a.block - b.block)
}

/**
 * The block at time `t`, estimated: linear between the two anchors around it, or BLOCKS_PER_SECOND from the nearest one
 * when it is past either end. NaN with no anchor at all.
 */
export function blockAt(anchors: readonly Anchor[], t: number): number {
  let below: Anchor | null = null
  let above: Anchor | null = null
  for (const anchor of anchors) {
    if (anchor.t <= t && (!below || anchor.t >= below.t)) below = anchor
    if (anchor.t >= t && (!above || anchor.t < above.t)) above = anchor
  }
  if (below && above) {
    if (above.t === below.t) return below.block
    return Math.round(below.block + ((t - below.t) * (above.block - below.block)) / (above.t - below.t))
  }
  if (below) return Math.round(below.block + (t - below.t) * BLOCKS_PER_SECOND)
  if (above) return Math.round(above.block - (above.t - t) * BLOCKS_PER_SECOND)
  return Number.NaN
}

const nowOf = (history: Pick<FeeHistory, 'points'>): FeePoint | null => history.points[history.points.length - 1] ?? null

/**
 * The block a read for `period`'s start is made at: the block estimated at its nominal start (now less the period),
 * floored to its grid, so it is at least the period's age. Null when no read is needed or none can help: the nominal start
 * at or before the mint (the opened point starts it), or a block not between the mint and now.
 */
export function startTarget(history: Pick<FeeHistory, 'mintedAt' | 'events' | 'points'>, period: TimedPeriod, extra: readonly Anchor[] = []): number | null {
  const now = nowOf(history)
  if (!now) return null
  const rule = PERIODS[period]
  const nominal = now.t - rule.seconds
  if (nominal <= history.mintedAt.timestamp) return null
  const estimate = blockAt(anchorsOf(history, extra), nominal)
  if (!Number.isFinite(estimate)) return null
  const block = Math.floor(estimate / rule.grid) * rule.grid
  return block > history.mintedAt.block && block < now.block ? block : null
}

/** The grid of a fill inside a drawn stretch `length` seconds long: the period's own, All's from its length. */
function fillGrid(period: FeesPeriod, length: number): number {
  if (period !== 'all') return PERIODS[period].grid
  if (length <= 2 * 86_400) return PERIODS['24h'].grid
  if (length <= 14 * 86_400) return PERIODS['7d'].grid
  return PERIODS['30d'].grid
}

/**
 * The block of the next fill inside `period` (drawn from `start` to now): the grid block nearest the middle of its
 * longest stretch between measured points, when that stretch is longer than a quarter of the period; null otherwise, or
 * when that block is not strictly inside the stretch.
 */
export function fillTarget(history: Pick<FeeHistory, 'mintedAt' | 'events' | 'points'>, period: FeesPeriod, start: FeePoint, extra: readonly Anchor[] = []): number | null {
  const points = history.points.filter((point) => point.block >= start.block)
  const now = points[points.length - 1]
  if (!now || points.length < 2) return null
  const length = now.t - start.t
  if (!(length > 0)) return null
  let best: { a: FeePoint; b: FeePoint; gap: number } | null = null
  for (let i = 1; i < points.length; i++) {
    const gap = points[i].t - points[i - 1].t
    if (gap > length / 4 && (!best || gap > best.gap)) best = { a: points[i - 1], b: points[i], gap }
  }
  if (!best) return null
  const grid = fillGrid(period, length)
  const estimate = blockAt(anchorsOf(history, extra), (best.a.t + best.b.t) / 2)
  if (!Number.isFinite(estimate)) return null
  const block = Math.round(estimate / grid) * grid
  return block > best.a.block && block < best.b.block ? block : null
}

/**
 * A read of `id` at `block` as one of this browser's readings, or null when it is not one: not `ok`, another block, an
 * NFT not live there, another PositionManager, another pool or range than the ledger's, a liquidity that is not the
 * ledger's settlements up to `block`, a time not between the mint and now, or amounts that do not parse. Whether its
 * figure fits between the measured points around it is the fold's own rule (lib/fees/ledger.ts: earned only grows).
 */
export function parsePastRead(
  outcome: PastOutcome,
  id: string,
  block: number,
  history: Pick<FeeHistory, 'mintedAt' | 'events' | 'points'>,
  state: Pick<FeeDisplayState, 'poolId' | 'tickLower' | 'tickUpper' | 'timestamp'>,
): Reading | null {
  if (outcome.state !== 'ok' || !isRecord(outcome.data)) return null
  const { snapshot, items } = outcome.data
  if (!isRecord(snapshot) || snapshot.number !== block || typeof snapshot.timestamp !== 'number' || !Number.isSafeInteger(snapshot.timestamp)) return null
  if (typeof snapshot.hash === 'string' && !HASH.test(snapshot.hash.toLowerCase())) return null
  if (!Array.isArray(items) || items.length !== 1) return null
  const item: unknown = items[0]
  if (!isRecord(item) || item.tokenId !== id || item.status !== 'owner_verified_at_snapshot') return null
  if (typeof item.positionManager !== 'string' || item.positionManager.toLowerCase() !== POSITION_MANAGER) return null
  if (typeof item.poolId !== 'string' || item.poolId.toLowerCase() !== state.poolId.toLowerCase()) return null
  if (item.tickLower !== state.tickLower || item.tickUpper !== state.tickUpper) return null
  if (typeof item.liquidityRaw !== 'string' || !UINT.test(item.liquidityRaw)) return null
  const liquidity = history.events.filter((event) => event.block <= block).reduce((sum, event) => sum + event.liquidityDelta, 0n)
  if (BigInt(item.liquidityRaw) !== liquidity) return null
  const t = snapshot.timestamp
  if (!(t > history.mintedAt.timestamp && t < state.timestamp && block > history.mintedAt.block)) return null
  const fees = item.unsettledFeesRaw
  if (!Array.isArray(fees) || fees.length !== 2 || !fees.every((one): one is string => typeof one === 'string' && UINT.test(one))) return null
  return { block, t, unclaimed: [BigInt(fees[0]), BigInt(fees[1])] }
}

export interface PastReadsDeps {
  /** Whether read-v1 `nft-positions` is listed here: true, false, or null when that could not be told just now. */
  listed(): Promise<boolean | null>
  /** `id` at `block` from the page's read source (one id). Never rejects for an answer it has. */
  read(id: string, block: number, signal: AbortSignal): Promise<PastOutcome>
  /** The fees store's view of `id`, and its changes (lib/fees/store.ts). */
  view(id: string): FeeHistoryView
  watch(id: string, listener: () => void): () => void
  /** Keeps a reading among this browser's (readings.ts insert, `now` the chain's time); false when it cannot. */
  keep(id: string, reading: Reading, now: number): boolean
  /** Has the store fold `id`'s view again with the readings as they are now. */
  redraw(id: string): void
  /** Calls `run` once `ms` have passed and the page is visible; returns a cancel. */
  later(ms: number, run: () => void): () => void
  /** A plain timer; returns a cancel. */
  timer(ms: number, run: () => void): () => void
  /** A clock in ms that only moves forward, for the spacing. */
  now(): number
}

export interface PastReads {
  /**
   * Wants `period` of `id` while subscribed: its start, and with `fills` (a chart drawing it) its fills too. Your APR's
   * last 24 hours want the start alone.
   */
  subscribe(id: string, period: FeesPeriod, listener: () => void, fills?: boolean): () => void
  /** Whether `period` of `id` can be drawn now. */
  status(id: string, period: FeesPeriod): PastStatus
  /** Whether past reads can be made here: true, false, or null while the route check is on its way. */
  listed(): boolean | null
  /** Tells `listener` when `listed()` changes; asks whether past reads can be made here, when that is not known yet. */
  onListed(listener: () => void): () => void
  /** `id`'s reads held in memory for the visit (too old for this browser's readings). */
  held(id: string): readonly Reading[]
}

interface Start {
  failures: number
  /** A read whose answer missed the window, and the one corrected read made since. */
  missed: number | null
  corrected: boolean
  done: boolean
  wait: (() => void) | null
}

interface Nft {
  id: string
  /** Its subscriptions per period: how many, and how many of them draw the period (and so want its fills). */
  refs: Map<FeesPeriod, { n: number; drawn: number }>
  listeners: Set<() => void>
  unwatch: (() => void) | null
  release: (() => void) | null
  /** This view's: reads made, start states, fills made per period, blocks asked. */
  reads: number
  starts: Map<TimedPeriod, Start>
  fills: Map<FeesPeriod, number>
  tried: Set<number>
  /** The visit's: headers the answers gave, and reads too old to keep. */
  learned: Anchor[]
  holds: Reading[]
}

interface Job {
  nft: Nft
  period: FeesPeriod
  kind: 'start' | 'fill'
  block: number
}

const NONE: readonly Reading[] = []

export function createPastReads(deps: PastReadsDeps): PastReads {
  const nfts = new Map<string, Nft>()
  const listedListeners = new Set<() => void>()
  let listedValue: boolean | null = null
  let listedAsking = false
  let recheckAt: number | null = null
  let inFlight = false
  let scheduled: (() => void) | null = null
  let lastReadAt: number | null = null
  let busyUntil = 0
  /** While an answer is handled: the store's redraw tells the watchers, who must not start the next read before it is done. */
  let handling = false

  const nftOf = (id: string): Nft => {
    let found = nfts.get(id)
    if (!found) {
      found = { id, refs: new Map(), listeners: new Set(), unwatch: null, release: null, reads: 0, starts: new Map(), fills: new Map(), tried: new Set(), learned: [], holds: [] }
      nfts.set(id, found)
    }
    return found
  }
  const startOf = (nft: Nft, period: TimedPeriod): Start => {
    let found = nft.starts.get(period)
    if (!found) {
      found = { failures: 0, missed: null, corrected: false, done: false, wait: null }
      nft.starts.set(period, found)
    }
    return found
  }
  const notify = (nft: Nft) => {
    for (const listener of Array.from(nft.listeners)) listener()
  }
  const notifyAll = () => {
    for (const nft of nfts.values()) notify(nft)
    for (const listener of Array.from(listedListeners)) listener()
  }
  /** A verified history with something earned: the only one past reads are made for. */
  const verified = (id: string) => {
    const view = deps.view(id)
    return view.phase === 'verified' && (view.history.earned[0] > 0n || view.history.earned[1] > 0n) ? view : null
  }

  function ensureListed(): void {
    if (listedAsking) return
    if (listedValue !== null && !(recheckAt !== null && deps.now() >= recheckAt)) return
    listedAsking = true
    void deps
      .listed()
      .catch(() => null)
      .then((answer) => {
        listedAsking = false
        const before = listedValue
        // A check that could not be answered is "not here" for now; the next screen asks again past LISTED_RECHECK_MS.
        listedValue = answer ?? false
        recheckAt = answer === null ? deps.now() + LISTED_RECHECK_MS : null
        if (listedValue !== before) notifyAll()
        pump()
      })
  }

  /** The next read to make: a start before any fill; null when none is wanted. Ends the starts that cannot be read. */
  function nextJob(): Job | null {
    if (listedValue !== true) return null
    const ended: Nft[] = []
    let fill: Job | null = null
    for (const nft of nfts.values()) {
      if (nft.refs.size === 0) continue
      const view = verified(nft.id)
      if (!view) continue
      for (const period of nft.refs.keys()) {
        const start = periodStart(view.history, period)
        if (!start) {
          if (period === 'all') continue
          const s = startOf(nft, period)
          if (s.done || s.wait) continue
          const block = nft.reads >= MAX_READS_PER_VIEW ? null : startTarget(view.history, period, nft.learned)
          if (block === null || block === s.missed) {
            s.done = true
            ended.push(nft)
            continue
          }
          for (const one of ended) notify(one)
          return { nft, period, kind: 'start', block }
        }
        if (fill || (nft.refs.get(period)?.drawn ?? 0) === 0 || nft.reads >= MAX_READS_PER_VIEW || (nft.fills.get(period) ?? 0) >= MAX_FILLS) continue
        const block = fillTarget(view.history, period, start, nft.learned)
        if (block !== null && !nft.tried.has(block)) fill = { nft, period, kind: 'fill', block }
      }
    }
    for (const one of ended) notify(one)
    return fill
  }

  const dueAt = (job: Job) => Math.max(lastReadAt === null ? 0 : lastReadAt + (job.kind === 'start' ? START_SPACING_MS : FILL_SPACING_MS), busyUntil)

  /** Starts the next read when it is due, while the page is visible; one at a time for the whole page. */
  function pump(): void {
    if (inFlight || scheduled || handling) return
    const job = nextJob()
    if (!job) return
    scheduled = deps.later(Math.max(0, dueAt(job) - deps.now()), () => {
      scheduled = null
      if (inFlight || handling) return
      const next = nextJob()
      if (!next) return
      if (dueAt(next) > deps.now()) pump()
      else run(next)
    })
  }

  function run(job: Job): void {
    const { nft } = job
    inFlight = true
    lastReadAt = deps.now()
    nft.reads += 1
    nft.tried.add(job.block)
    if (job.kind === 'fill') nft.fills.set(job.period, (nft.fills.get(job.period) ?? 0) + 1)
    // Never cancelled: a read rugged97's gateway has started costs the same whether or not its answer is kept, and a good
    // answer is a measured point for the next visit too.
    void deps
      .read(nft.id, job.block, new AbortController().signal)
      .catch((): PastOutcome => ({ state: 'unavailable' }))
      .then((outcome) => {
        inFlight = false
        handling = true
        try {
          answered(job, outcome)
        } finally {
          handling = false
        }
        notify(nft)
        pump()
      })
  }

  function answered(job: Job, outcome: PastOutcome): void {
    const { nft } = job
    const busy = outcome.state === 'busy' && typeof outcome.retryAfterSeconds === 'number' && Number.isFinite(outcome.retryAfterSeconds) ? Math.max(0, outcome.retryAfterSeconds) * 1_000 : 0
    if (busy > 0) busyUntil = Math.max(busyUntil, deps.now() + busy)
    const view = verified(nft.id)
    const reading = view ? parsePastRead(outcome, nft.id, job.block, view.history, view.state) : null
    if (view && reading) {
      nft.learned.push({ block: reading.block, t: reading.t })
      if (!deps.keep(nft.id, reading, view.state.timestamp) && !nft.holds.some((one) => one.block === reading.block)) nft.holds = [...nft.holds, reading].sort((a, b) => a.block - b.block).slice(-MAX_HELD)
      deps.redraw(nft.id)
    }
    // No verified history to check it against just now (a fresh ledger asked after a settlement, say): the start is
    // asked again once there is one, as if this read had not been made.
    if (job.kind !== 'start' || job.period === 'all' || !view) return
    const s = startOf(nft, job.period)
    if (reading) {
      s.failures = 0
      const after = verified(nft.id)
      if (after && !periodStart(after.history, job.period)) {
        // Outside the window (or not a point the fold could keep): one corrected read, with this answer as an anchor.
        if (s.corrected) s.done = true
        else {
          s.corrected = true
          s.missed = job.block
        }
      }
      return
    }
    // An answer that is not this position at that block, as the ledger has it: the same final block would answer the same.
    if (outcome.state === 'ok') {
      s.done = true
      return
    }
    s.failures += 1
    if (s.failures > START_RETRY_MS.length) {
      s.done = true
      return
    }
    s.wait = deps.later(Math.max(START_RETRY_MS[s.failures - 1], busy), () => {
      s.wait = null
      notify(nft)
      pump()
    })
  }

  /** The last screen of `nft` left a moment ago: its view ends (its counts, its waits); what it learned stays. */
  function endView(nft: Nft): void {
    nft.release = null
    if (nft.refs.size > 0) return
    for (const s of nft.starts.values()) s.wait?.()
    nft.starts.clear()
    nft.fills.clear()
    nft.tried.clear()
    nft.reads = 0
    nft.unwatch?.()
    nft.unwatch = null
  }

  return {
    subscribe(id, period, listener, fills = true) {
      const nft = nftOf(id)
      nft.listeners.add(listener)
      const ref = nft.refs.get(period) ?? { n: 0, drawn: 0 }
      nft.refs.set(period, { n: ref.n + 1, drawn: ref.drawn + (fills ? 1 : 0) })
      nft.release?.()
      nft.release = null
      nft.unwatch ??= deps.watch(id, () => {
        notify(nft)
        pump()
      })
      ensureListed()
      pump()
      let open = true
      return () => {
        if (!open) return
        open = false
        nft.listeners.delete(listener)
        const ref = nft.refs.get(period) ?? { n: 1, drawn: fills ? 1 : 0 }
        if (ref.n > 1) nft.refs.set(period, { n: ref.n - 1, drawn: ref.drawn - (fills ? 1 : 0) })
        else nft.refs.delete(period)
        if (nft.refs.size === 0 && !nft.release) nft.release = deps.timer(PAST_RELEASE_MS, () => endView(nft))
      }
    },
    status(id, period) {
      const view = deps.view(id)
      if (view.phase === 'cached') return periodStart(view.history, period) ? 'drawn' : 'off'
      if (view.phase !== 'verified') return 'off'
      if (periodStart(view.history, period)) return 'drawn'
      if (period === 'all' || listedValue === false || !verified(id)) return 'off'
      const s = nfts.get(id)?.starts.get(period)
      return s && (s.done || s.failures > 0) ? 'unavailable' : 'reading'
    },
    listed: () => listedValue,
    onListed(listener) {
      listedListeners.add(listener)
      // Asked as soon as a card that may offer periods is on screen, before its history is drawn: its tabs are then
      // known when it is, and never drawn to be taken away.
      ensureListed()
      return () => void listedListeners.delete(listener)
    },
    held: (id) => nfts.get(id)?.holds ?? NONE,
  }
}
