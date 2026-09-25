/**
 * The fees pipeline of one position NFT (DESIGN-V2 §15.5), as the replay
 * worker runs it: the relay's logs in, a verified FeeHistory (or the reason
 * there is none) out. Kept apart from the worker's message glue so the tests
 * can drive it with recorded relay answers; it asks the network only through
 * the `logs` function it is handed.
 *
 *   1. `transfer`: the mint block (the NFT's first Transfer from the zero address),
 *      looked for in the last epoch first, then (2026-09-25) only as far back
 *      as a mint whose swap days can still be replayed (MAX_SWAP_DAYS): an
 *      older one stops the run as too_much_history without a scan of the whole
 *      chain.
 *   2. More swap days than MAX_SWAP_DAYS from the mint to the state block: stop (too_much_history).
 *   3. `initialize`, then (2026-09-25) a few small `probe` samples of the
 *      pool's logs (its last hour, in slices, and a few minutes in each of
 *      its epochs): their logs
 *      per block, over the pool's life for its liquidity history and over the
 *      position's for its swaps, give the bytes the whole history would take.
 *      More than the run's budget: stop (too_much_history) before reading any
 *      of it, which a history that can never verify in a browser (PONS/USDG's,
 *      over 60 MB) used to read for a minute. Then every
 *      `pool` epoch from the pool's first to the state block's: the full tick
 *      map and the protocol-fee timeline.
 *   4. `headers` on the hourly grid from the mint to the state block (the state's
 *      own timestamp closes the timeline).
 *   5. `swaps` from the mint day to the state block's day, replayed day by day
 *      in order while the next days are on their way; each day's logs are
 *      dropped once replayed. The starting price is the last Swap before the
 *      mint (in the mint day, else `swapBefore`), or the pool's Initialize.
 *   6. Verified ⇔ the replay's unclaimed fees equal the chain's for both tokens,
 *      its accrued fee growth equals the chain's inside − insideLast, its pool
 *      price and tick equal the chain's at the state block, and every Swap's
 *      end tick, liquidity and fee matched the replay.
 *
 * A budget of decoded answer bytes (and, in the worker, of time) bounds
 * every run, in every step (since
 * 2026-09-25 the pool's epochs and the headers too: a busy pool's liquidity
 * history alone, PONS/USDG's over 60 MB, was read to its end before the
 * budget was ever looked at, and each visitor now reads it from the RPC
 * under their own address's limit); past it the run stops (too_much_history).
 * Stopped among the swap days, it keeps a checkpoint a later run with a larger
 * budget resumes from; before them there is nothing to keep, and a larger
 * budget starts over. A verified run's checkpoint lets the next state block's
 * run replay only the new logs.
 *
 * The price path (2026-09-25). When the probe says the pool's whole history
 * is past the budget (a busy pool: PONS/USDG, USDG/DELTA), the run no longer
 * stops there: it replays the price path (replay.ts), which needs only the
 * NFT's own ModifyLiquidity events (a `settlements` read: its mint and every
 * settlement its owners made) and the pool's Swaps from the mint on (`span`
 * reads, the position's own life, not whole days), and checks the result
 * against the chain the same way: the unclaimed fees (to the rounding the
 * path allows, a unit or two a step), the pool's price and tick, the
 * position's liquidity.
 *   P1. When the Swaps of the life fit PATH_NOW_BYTES (USDG/DELTA: 106 kB),
 *       they are read at once, and the history is verified in seconds.
 *   P2. Otherwise (PONS/USDG: 2.7 MB a day), and when no settlement followed
 *       the mint (so the position has earned exactly its unclaimed fees since
 *       it), a window of Swaps is read in each hour of the life (SAMPLE_BYTES
 *       in all) and an estimated history (estimate.ts) is handed to
 *       `deps.estimate` at once: its end is the chain's figures, its shape an
 *       estimate, drawn with an "est." mark. The run then asks for more time
 *       (`deps.extend`) and reads the whole life within PATH_REFINE_BYTES; the
 *       verified history replaces the estimate when it is done.
 *   P3. (2026-09-25, review) The windows are sized by the rate they read, the
 *       first request one narrow window; the spans of the life by the busier of the
 *       last span and the life so far. A read of the life stopped by its
 *       budget or its time keeps its place (`later`): a later run, with a
 *       budget of its own, goes on from it.
 */
import { BEHIND_RETRY_MS, BUDGET_MS, CLIENT_CONCURRENCY, DAY_SPAN, EPOCH_SPAN, HOUR_SPAN, MAX_DAYS_PER_REQUEST, MAX_HEADERS_PER_REQUEST, MAX_HOLDERS, MAX_SLOTS, MAX_SWAP_DAYS, PATH_BURST, PATH_LIFE_SHARE, PATH_NOW_BYTES, PATH_REFINE_BYTES, PATH_REFINE_MS, POSITION_MANAGER, SAMPLE_BATCH_BYTES, SAMPLE_BYTES, SAMPLE_MIN_BLOCKS, SAMPLE_SPANS_PER_REQUEST, SPAN_BLOCKS_MAX, SPAN_CAP_BYTES, SPAN_MIN_BLOCKS, SPAN_TARGET_BYTES } from './constants'
import { estimateHistory, type EstimateSlot } from './estimate'
import { FeeReplay, ReplayError, Timeline, type ReplayData } from './replay'
import type { Checkpoint, CompactLog, FeeHistory, FeesReason, HourlyPrices, LogsRequest, LogsResponse, PositionState, RelayAnswer, WorkerResult } from './types'

export interface PipelineDeps {
  /** One relay request (logs.ts logsWith in the worker; recorded answers in the tests). */
  logs: (request: LogsRequest) => Promise<RelayAnswer<LogsResponse>>
  sleep: (ms: number) => Promise<void>
  progress?: (report: { bytes: number; daysDone: number; daysTotal: number }) => void
  /** True once the run is no longer wanted: it stops at the next request. */
  cancelled?: () => boolean
  /** True once the run's time is spent (the worker's BUDGET_MS): it stops as at its byte budget. None in the tests. */
  timeUp?: () => boolean
  /** 2026-09-25: an estimated history, drawn while the run goes on to the exact one (the price path, P2). */
  estimate?: (partial: { history: FeeHistory; prices: HourlyPrices }) => void
  /** 2026-09-25: the run's time runs on to `ms` from now (the worker's deadline): the exact read after an estimate. */
  extend?: (ms: number) => void
}

export interface PipelineRun {
  id: string
  state: PositionState
  growth: readonly [bigint, bigint]
  budgetBytes: number
  checkpoint: Checkpoint | null
}

/** What a checkpoint holds (opaque to the main thread). */
interface PipelineCheckpoint {
  v: 1
  /** 2026-09-25: a price path's (its later runs read only settlements and Swaps); absent for the exact replay. */
  path?: { holders: string[] }
  tokenId: string
  poolId: string
  tickLower: number
  tickUpper: number
  mintBlock: number
  /** Every log up to this block has been replayed. */
  through: number
  /** Known block timestamps (the hourly grid and the state blocks). */
  points: Array<[number, number]>
  replay: ReplayData
  bytes: number
}

class Stop extends Error {
  /** `keepPlace`: the budget ran out, and a later run with a larger one may go on from here. */
  constructor(
    readonly reason: FeesReason,
    readonly keepPlace = false,
  ) {
    super(reason)
  }
}

/** A relay answer that is not `behind`. */
type Answer = Exclude<LogsResponse, { behind: true }>

class Cancelled extends Error {}

const ZERO_TOPIC = `0x${'0'.repeat(64)}`
/** Logs of each kind the probe's count is taken without (see step 3). */
export const PROBE_SLACK = 4
/** The probe's slices of the pool's last hour, newest first (step 3): six, twelve and forty-two minutes of blocks. */
export const PROBE_SLICES = [3_600, 7_200, 25_200] as const
/** The probe's sample in each epoch the pool lived through: twelve minutes of blocks. */
export const PROBE_EPOCH_SAMPLE = 7_200
/** The most epochs the probe samples (step 3). */
export const PROBE_WINDOWS = 5
const RATE_ATTEMPTS = 3
/** About the compact bytes of a probe reply at the relay's cap (PROBE_BYTES, 64 kB of the RPC's JSON). */
const PROBE_CAP_BYTES = 40 * 1024
/** The wait before asking again after an answer that carried no whole unit (the relay kept its parts), and how many in a row. */
const IDLE_WAIT_MS = 1000
const IDLE_TRIES = 6

const before = (a: CompactLog, b: CompactLog) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])
const byPosition = (a: CompactLog, b: CompactLog) => a[0] - b[0] || a[1] - b[1]

function word(data: string, index: number): bigint {
  const start = 2 + index * 64
  if (data.length < start + 64) throw new Stop('rpc_unavailable')
  return BigInt(`0x${data.slice(start, start + 64)}`)
}

/** An NFT's own ModifyLiquidity: sender = the PositionManager, salt = the token id. */
function ownModify(log: CompactLog, tokenId: bigint): boolean {
  return log[2] === 1 && log[4].length >= 2 && `0x${log[4][1].slice(26)}` === POSITION_MANAGER && word(log[5], 3) === tokenId
}

/** Runs `work` over `items` with at most `limit` at a time; results in the items' order. */
async function pooled<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length })
  let next = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await work(items[i])
    }
  })
  await Promise.all(lanes)
  return out
}

/** A promise's outcome as a value, so one left waiting while the run stops never becomes an unhandled rejection. */
function settled<T>(promise: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  return promise.then((value) => ({ value }), (error: unknown) => ({ error }))
}

/**
 * One run of the pipeline. Null when it was cancelled; otherwise the result
 * the worker posts back ({ ok: true, history, prices, checkpoint } when the
 * replay verified).
 */
export async function runPipeline(deps: PipelineDeps, run: PipelineRun): Promise<WorkerResult | null> {
  const { state } = run
  const tokenId = BigInt(run.id)
  const top = state.block
  const saved = run.checkpoint as unknown as PipelineCheckpoint | null
  const resumable =
    saved !== null && saved.v === 1 && saved.tokenId === run.id && saved.poolId === state.poolId && saved.tickLower === state.tickLower && saved.tickUpper === state.tickUpper && saved.through <= top
  const checkpoint = resumable ? saved : null
  let bytes = checkpoint?.bytes ?? 0
  let replay: FeeReplay | null = checkpoint ? FeeReplay.resume(checkpoint.replay) : null
  let through = checkpoint?.through ?? -1
  let points: Array<[number, number]> = checkpoint ? [...checkpoint.points] : []
  let mintBlock = checkpoint?.mintBlock ?? -1
  /** The NFT's owners since its mint (from its Transfers): a price path's settlements are looked for in their payments. */
  let holders: string[] = checkpoint?.path?.holders ?? []
  /** Set once the run replays the price path (a path checkpoint, or the probe's plan). */
  let onPath = checkpoint?.path !== undefined
  /**
   * Where the run is. `spentBytes`: what a later run counts from, the bytes so far for a budget stop (a larger budget goes
   * on from them), none for a verified run (2026-09-25, review: each later run reads only the new logs, under a budget of
   * its own; counted on from the first, a verified exact replay's minute runs used to add up past the page's budget).
   */
  const keep = (spentBytes = bytes): Checkpoint | null =>
    replay === null
      ? null
      : ({ v: 1, ...(onPath ? { path: { holders } } : {}), tokenId: run.id, poolId: state.poolId, tickLower: state.tickLower, tickUpper: state.tickUpper, mintBlock, through, points, replay: replay.save(), bytes: spentBytes } satisfies PipelineCheckpoint as unknown as Checkpoint)

  /** One relay request: rate limits waited out, a lagging relay asked once more, any other failure stops the run. */
  async function ask(request: LogsRequest): Promise<Answer> {
    let behind = 0
    for (let attempt = 1; ; attempt++) {
      if (deps.cancelled?.()) throw new Cancelled()
      const answer = await deps.logs(request)
      if (deps.cancelled?.()) throw new Cancelled()
      if (answer.ok) {
        bytes += answer.bytes
        if ('behind' in answer.value) {
          if (behind++ < 1) {
            await deps.sleep(BEHIND_RETRY_MS)
            continue
          }
          throw new Stop('rpc_unavailable')
        }
        return answer.value
      }
      if (answer.failure === 'rate_limited' && attempt < RATE_ATTEMPTS) {
        await deps.sleep(Math.max(answer.retryAfterMs, 2000 * attempt))
        continue
      }
      throw new Stop(answer.failure === 'too_large' ? 'too_much_history' : 'rpc_unavailable')
    }
  }

  const rangeLogs = (answer: Answer): CompactLog[] => ('units' in answer ? answer.units.flatMap((unit) => unit.logs) : [])

  /** Whether the run's budget (its bytes, or its time) is spent. */
  const spent = () => bytes >= run.budgetBytes || deps.timeUp?.() === true
  /** Before the swap days, the budget spent is the end of the run: nothing is replayed yet, so no place is kept. */
  const within = () => {
    if (spent()) throw new Stop('too_much_history')
  }

  /** A one-unit request (a pool epoch), asked again while the relay answers with no whole unit: a busy one comes in parts. */
  async function askWhole(request: LogsRequest): Promise<Answer> {
    for (let idle = 1; ; idle++) {
      within()
      const answer = await ask(request)
      if (!('units' in answer) || answer.units.length > 0 || answer.next === null) return answer
      if (idle >= IDLE_TRIES) throw new Stop('rpc_unavailable')
      await deps.sleep(IDLE_WAIT_MS)
    }
  }

  /**
   * The cheap bound (2026-09-25), before any of the pool's history: small samples of its logs, newest first. Its last
   * hour in three slices (PROBE_SLICES: six, twelve, then forty-two minutes), then twelve minutes (PROBE_EPOCH_SAMPLE)
   * in the middle of each epoch it lived through (PROBE_WINDOWS epochs at most, spread evenly). After each sample, the
   * liquidity history is taken at its rate over every sample so far, across the pool's life, and the swaps at their
   * rate in the last hour's slices, across the position's; each less PROBE_SLACK logs (a log or two says nothing of a
   * quiet pool's years). Past the budget, the run stops at once. Small samples, because a sample is a reply the RPC
   * counts against the visitor's address: one hour of PONS/USDG's logs, 232 kB, drew refusals of the page's own reads
   * (measured live that day), where its first six minutes, 28 kB, already stop the run. A pool quiet this hour can have
   * been busy for weeks (USDG/DELTA's last epochs were 1 and 1.7 MB): hence the samples in its older epochs.
   */
  async function probe(initBlock: number): Promise<{ fits: boolean; historyFits: boolean; inParts: boolean; swapRate: number }> {
    const windows: Array<{ from: number; to: number; recent: boolean }> = []
    let end = top
    for (const span of PROBE_SLICES) {
      const from = Math.max(initBlock, end - span + 1)
      if (from > end) break
      windows.push({ from, to: end, recent: true })
      end = from - 1
    }
    const recentFrom = windows[windows.length - 1].from
    const lived: number[] = []
    for (let epoch = Math.floor(top / EPOCH_SPAN); epoch >= Math.floor(initBlock / EPOCH_SPAN); epoch--) lived.push(epoch)
    const picked = lived.length <= PROBE_WINDOWS ? lived : Array.from({ length: PROBE_WINDOWS }, (_, i) => lived[Math.round((i * (lived.length - 1)) / (PROBE_WINDOWS - 1))])
    for (const epoch of picked) {
      const from = Math.max(initBlock, epoch * EPOCH_SPAN + (EPOCH_SPAN - PROBE_EPOCH_SAMPLE) / 2)
      const to = Math.min(top, from + PROBE_EPOCH_SAMPLE - 1)
      if (from <= to && to < recentFrom) windows.push({ from, to, recent: false })
    }
    const size = (logs: readonly CompactLog[]) => logs.reduce((sum, log) => sum + JSON.stringify(log).length, 0)
    const rate = (count: number, total: number, blocks: number) => (count > PROBE_SLACK ? ((count - PROBE_SLACK) * (total / count)) / blocks : 0)
    const pool = { count: 0, bytes: 0, blocks: 0 }
    const swaps = { count: 0, bytes: 0, blocks: 0 }
    // 2026-09-25: the Swaps' own rate over every sample (no slack), for the price path's plan (step P).
    const seen = { bytes: 0, blocks: 0 }
    const swapRate = () => Math.max(swaps.blocks > 0 ? swaps.bytes / swaps.blocks : 0, seen.blocks > 0 ? seen.bytes / seen.blocks : 0)
    for (const { from, to, recent } of windows) {
      within()
      let sample: CompactLog[]
      try {
        sample = rangeLogs(await ask({ kind: 'probe', poolId: state.poolId, from, to }))
      } catch (error) {
        // A sample past the probe's own cap (a reply of 64 kB) is a history no budget reaches: the price path's, then.
        if (error instanceof Stop && error.reason === 'too_much_history' && !spent()) return { fits: false, historyFits: false, inParts: true, swapRate: Math.max(swapRate(), PROBE_CAP_BYTES / (to - from + 1)) }
        throw error
      }
      const swapped = sample.filter((log) => log[2] === 3 || log[2] === 4)
      seen.bytes += size(swapped)
      seen.blocks += to - from + 1
      const history = sample.filter((log) => log[2] <= 2)
      pool.count += history.length
      pool.bytes += size(history)
      pool.blocks += to - from + 1
      if (recent) {
        const swapLogs = sample.filter((log) => log[2] === 3 || log[2] === 4)
        swaps.count += swapLogs.length
        swaps.bytes += size(swapLogs)
        swaps.blocks += to - from + 1
      }
      const projected = rate(pool.count, pool.bytes, pool.blocks) * (top - initBlock + 1) + rate(swaps.count, swaps.bytes, swaps.blocks) * (top - mintBlock + 1)
      if (bytes + projected > run.budgetBytes) return { fits: false, historyFits: false, inParts: pool.count > 0, swapRate: swapRate() }
      // 2026-09-25: any liquidity history in a sample and the price path is the one (its reads are the position's own
      // life, never the pool's history): liquidity comes in bursts the samples do not see, and a projection that fitted
      // read USDG/DELTA's epochs in parts for 20 s and stopped (measured live that day). The exact replay of the pool's
      // history stays for a pool whose every sample was quiet (the owner's USDG/UFG 79 %, 5 kB).
      if (pool.count > 0) return { fits: false, historyFits: true, inParts: true, swapRate: swapRate() }
    }
    // Any liquidity history in the samples: the pool's epochs are asked in capped parts. Liquidity comes in bursts the
    // samples do not see: USDG/DELTA showed 5 liquidity logs in 64,800 sampled blocks (measured live on 2026-09-25) and
    // its last epochs, asked whole, were replies of 1 and 1.7 MB. A pool with none in its samples is asked whole, one
    // reply an epoch, as quiet pools are (the owner's USDG/UFG 79 %).
    return { fits: true, historyFits: true, inParts: pool.count > 0, swapRate: swapRate() }
  }

  /** Block times from the hour of `from` to the state block's, at most MAX_HEADERS_PER_REQUEST × 2 of them (a long life's every few hours). */
  async function timelineFrom(from: number): Promise<Timeline> {
    const knownGrid = points.filter(([block]) => block % HOUR_SPAN === 0).map(([block]) => block)
    const first = knownGrid.length > 0 ? Math.max(...knownGrid) / HOUR_SPAN + 1 : Math.floor(from / HOUR_SPAN)
    const last = Math.floor(top / HOUR_SPAN)
    const step = Math.max(1, Math.ceil((last - first + 1) / (2 * MAX_HEADERS_PER_REQUEST)))
    const anchors: number[] = []
    for (let anchor = first; anchor <= last; anchor += step) anchors.push(anchor * HOUR_SPAN)
    for (let i = 0; i < anchors.length; i += MAX_HEADERS_PER_REQUEST) {
      within()
      const blocks = anchors.slice(i, i + MAX_HEADERS_PER_REQUEST)
      const answer = await ask({ kind: 'headers', blocks })
      const got = 'headers' in answer ? answer.headers : []
      if (got.length !== blocks.length || got.some(([block], j) => block !== blocks[j])) throw new Stop('rpc_unavailable')
      points.push(...got)
    }
    points.push([top, state.timestamp])
    points = [...new Map(points).entries()].sort((a, b) => a[0] - b[0])
    return new Timeline(points)
  }

  /**
   * The price path (2026-09-25; the header's P1 and P2): the NFT's own settlements, the Swaps of its life, the check.
   * `start` is the pool's, for a first run; a path checkpoint's run goes on from where it stopped.
   */
  async function pricePath(start: { lpFee: number; tickSpacing: number; initBlock: number; initPrice: bigint; initTick: number; swapRate: number } | null): Promise<WorkerResult> {
    onPath = true
    const resumed = start === null
    // A later run reads only what came after the checkpoint: its budget is its own, not the first run's plus it (a day
    // of PONS/USDG is 2.7 MB, past the page's 2 MB, and its next minute's run is a few kB).
    if (resumed) bytes = 0
    const path = resumed && replay ? replay : FeeReplay.start({ tokenId, tickLower: state.tickLower, tickUpper: state.tickUpper, tickSpacing: start?.tickSpacing ?? 1, fee: start?.lpFee ?? 0, path: true, ...(state.protocolFee === undefined ? {} : { protocolFee: state.protocolFee }) }, start?.initPrice ?? 0n, start?.initTick ?? 0)
    replay = path
    const from = resumed ? through + 1 : mintBlock
    const timeline = await timelineFrom(from)
    const currencies: [string, string] = [state.currencies[0].address, state.currencies[1].address]
    // (a) The NFT's own ModifyLiquidity events: its mint (in its block) and every settlement its owners made since.
    const own =
      from <= top && holders.length > 0
        ? rangeLogs(await ask({ kind: 'settlements', poolId: state.poolId, tokenId: run.id, holders, currencies, from, to: top })).filter((log) => log[0] >= from && log[0] <= top && ownModify(log, tokenId))
        : []
    // The settlements found must account for the position's liquidity now: one missed (an increase, or a decrease paid
    // to someone who was never an owner) and the path cannot land on the chain's figures, so it stops before reading.
    const liquidity = own.reduce((sum, log) => sum + BigInt.asIntN(256, word(log[5], 2)), resumed ? path.positionLiquidity() : 0n)
    if (liquidity !== state.liquidity) throw new Stop('replay_mismatch')
    if (!resumed) {
      if (own.length === 0 || own[0][0] !== mintBlock) throw new Stop('rpc_unavailable')
      // (b) The price at the mint: the last Swap before its block (its own block's come with the first span), or the Initialize.
      if (start && start.initBlock < mintBlock) {
        const found = await ask({ kind: 'swapBefore', poolId: state.poolId, block: mintBlock, since: start.initBlock })
        const previous = 'log' in found ? found.log : null
        if (previous && previous[0] < mintBlock) path.apply(previous, timeline)
      }
    }
    const settledSince = resumed ? own.length : own.length - 1
    // (c) The plan: the whole life now, or first an estimate from windows of it (a busy pool), then the whole life.
    let budget = run.budgetBytes
    const projected = start ? start.swapRate * (top - from + 1) : 0
    /** The Swaps' rate the spans are sized by (compact bytes a block): the probe's, or the estimate's windows'. */
    let rate = start?.swapRate ?? 0
    // The probe's rate is its last minutes', and Swaps come in bursts: read at once only a life that fits even at
    // PATH_BURST times that rate, else draw an estimate first (the reading after it then shows nothing new for longer).
    if (start && PATH_BURST * projected > PATH_NOW_BYTES) {
      // The probe's rate is its last minutes' (PONS/USDG's last hour was 2.5 times its day's average, 2026-09-25): the
      // windows of the estimate, spread over the life, say better what the whole read will take.
      // They are read either way: after a settlement no estimate is drawn (what it collected would be a guess), but
      // the windows still size the whole read (2310187's pool had its busiest hour of two weeks just before the probe).
      let expected = projected
      const sample = await sampled(start, own[0], timeline)
      if (sample.history && settledSince === 0) deps.estimate?.(sample.history)
      if (sample.rate !== null) {
        expected = sample.rate * (top - from + 1)
        rate = sample.rate
      }
      if (expected > PATH_REFINE_BYTES) throw new Stop('too_much_history')
      deps.extend?.(PATH_REFINE_MS)
      budget = bytes + PATH_REFINE_BYTES
    }
    // (d) The Swaps of the life, in spans sized to about SPAN_TARGET_BYTES, replayed with the NFT's own events in chain order.
    let next = 0
    const apply = (logs: readonly CompactLog[], limit: number) => {
      let j = 0
      while (true) {
        const mine = next < own.length && own[next][0] <= limit ? own[next] : null
        const swap = j < logs.length ? logs[j] : null
        if (!mine && !swap) break
        if (mine && (!swap || before(mine, swap))) {
          path.apply(mine, timeline)
          next += 1
        } else if (swap) {
          path.apply(swap, timeline)
          j += 1
        }
      }
    }
    // A span's length follows the Swaps' rate, and grows at most by half from one span to the next: a pool's Swaps come in
    // bursts (measured 2026-09-25: after a quiet PONS/USDG span of 14,400 blocks, one of 165,658 was a reply of 943 kB).
    // The first is sized at PATH_BURST times the rate known before it (2026-09-25, review: a reply past the cap is cut
    // only once the RPC has sent it, and the visitor's address pays for it).
    let blocks = Math.min(SPAN_BLOCKS_MAX, Math.max(SPAN_MIN_BLOCKS, Math.round(SPAN_TARGET_BYTES / Math.max(PATH_BURST * rate, 1e-6))))
    const total = Math.max(1, top - from + 1)
    const read = { bytes: 0, blocks: 0 }
    for (let at = from; at <= top; ) {
      // Out of its budget or time: a span read keeps its place (2026-09-25, review), and a later run goes on from it.
      if (bytes >= budget || deps.timeUp?.() === true) throw new Stop('too_much_history', through >= from)
      const to = Math.min(top, at + blocks - 1)
      const spent0 = bytes
      let answer: Answer
      try {
        answer = await ask({ kind: 'span', poolId: state.poolId, spans: [[at, to]] })
      } catch (error) {
        // A span past the reply's cap held at least SPAN_CAP_BYTES: the next is sized by that rate, down to SPAN_MIN_BLOCKS.
        if (error instanceof Stop && error.reason === 'too_much_history' && blocks > SPAN_MIN_BLOCKS) {
          blocks = Math.max(SPAN_MIN_BLOCKS, Math.min(Math.floor(blocks / 2), Math.floor(((to - at + 1) * SPAN_TARGET_BYTES) / SPAN_CAP_BYTES)))
          continue
        }
        throw error
      }
      const unit = 'units' in answer ? answer.units[0] : undefined
      if (!unit || unit.from !== at || unit.to !== to) throw new Stop('rpc_unavailable')
      apply(unit.logs.filter((log) => log[0] >= at && log[0] <= to && log[0] > through), to)
      through = to
      // Sized by the busier of the last span and the life read so far (a burst after a quiet span, 2026-09-25, review).
      read.bytes += bytes - spent0
      read.blocks += to - at + 1
      const busier = Math.max((bytes - spent0) / (to - at + 1), read.bytes / read.blocks, 1e-6)
      blocks = Math.min(SPAN_BLOCKS_MAX, Math.round(1.5 * (to - at + 1)), Math.max(SPAN_MIN_BLOCKS, Math.round(SPAN_TARGET_BYTES / busier)))
      deps.progress?.({ bytes, daysDone: Math.floor(((to - from + 1) * 100) / total), daysTotal: 100 })
      at = to + 1
    }
    apply([], top)
    through = Math.max(through, top)
    // (e) The check: the chain's unclaimed fees to the path's rounding, its price and tick, the position's liquidity.
    const owed = path.owed()
    const allowed = path.rounding()
    const pool = path.pool()
    const checks = path.checks
    const near = (a: bigint, b: bigint, units: number) => (a > b ? a - b : b - a) <= BigInt(units)
    const verified =
      path.minted !== null &&
      near(owed[0], state.unclaimed[0], allowed[0]) &&
      near(owed[1], state.unclaimed[1], allowed[1]) &&
      pool.price === state.sqrtPriceX96 &&
      pool.tick === state.tick &&
      path.positionLiquidity() === state.liquidity &&
      checks.tickMismatch === 0 &&
      checks.liquidityMismatch === 0 &&
      checks.swapFeeMismatch === 0
    if (!verified) return { ok: false, reason: 'replay_mismatch', prices: null, checkpoint: null, bytes }
    const { history, prices } = path.snapshot(top, state.timestamp, timeline)
    // The chain's own figures at the end (the path lands within its rounding of them); no hour above them.
    const exact: [bigint, bigint] = [history.collected[0] + state.unclaimed[0], history.collected[1] + state.unclaimed[1]]
    const cap = (value: readonly [bigint, bigint]): [bigint, bigint] => [value[0] < exact[0] ? value[0] : exact[0], value[1] < exact[1] ? value[1] : exact[1]]
    const hourly = history.hourly.map((hour, i, all) => ({ ...hour, earned: i === all.length - 1 ? exact : cap(hour.earned) }))
    // What a settlement collected is the path's own figure (2026-09-25, review): marked `near`.
    const settledAny = history.events.some((event) => event.kind !== 'mint' && (event.fees[0] > 0n || event.fees[1] > 0n))
    return { ok: true, history: { ...history, earned: exact, hourly, ...(settledAny ? { near: true as const } : {}) }, prices, checkpoint: keep(0) as Checkpoint }
  }

  /**
   * The estimate (P2): a window of Swaps in each slot of the life (an hour, or a few hours past MAX_SLOTS of them), about
   * SAMPLE_BYTES in all, read SAMPLE_SPANS_PER_REQUEST windows a request; the most recent window ends at the state block.
   * 2026-09-25 (review): the windows are sized by the Swaps' rate they show as they are read, not by the probe's last
   * minutes alone (a quiet probe made them wide, and a request of four was cut at the reply's cap three times live): the
   * first request is one window, SAMPLE_MIN_BLOCKS wide; each next one's windows share what SAMPLE_BYTES has left among
   * the windows still unread, at most four times as wide as the last, and a request stays under SAMPLE_BATCH_BYTES at
   * PATH_BURST times the rate. A request cut at the cap tells the rate it had at least: its windows are asked again one
   * by one, sized by it. With the history, the Swaps' rate over the windows read (compact bytes a block), or null when
   * none could be read.
   */
  async function sampled(start: { lpFee: number; swapRate: number }, mint: CompactLog, timeline: Timeline): Promise<{ history: { history: FeeHistory; prices: HourlyPrices } | null; rate: number | null }> {
    const firstAnchor = Math.floor(mintBlock / HOUR_SPAN)
    const lastAnchor = Math.floor(top / HOUR_SPAN)
    const per = Math.max(1, Math.ceil((lastAnchor - firstAnchor + 1) / MAX_SLOTS))
    const slots: EstimateSlot[] = []
    for (let anchor = firstAnchor; anchor <= lastAnchor; anchor += per) {
      const lastOf = Math.min(lastAnchor, anchor + per - 1)
      slots.push({ firstAnchor: anchor, lastAnchor: lastOf, from: Math.max(mintBlock + 1, anchor * HOUR_SPAN), to: Math.min(top, (lastOf + 1) * HOUR_SPAN - 1), logs: null })
    }
    const bounds = slots.filter((slot) => slot.from <= slot.to)
    const windows = bounds.map((slot) => ({ ...slot }))
    const seen = { bytes: 0, blocks: 0 }
    /** The least rate the windows are sized by: the probe's, raised by any request cut at the cap. */
    let least = start.swapRate
    let width = 0
    /** The width of the next request's `count` windows, of `left` still unread (what SAMPLE_BYTES has left, shared). */
    const widthFor = (count: number, left = count) => {
      const measured = seen.blocks > 0 ? seen.bytes / seen.blocks : null
      const rate = Math.max(least, measured ?? 0)
      const perWindow = Math.max(0, SAMPLE_BYTES - seen.bytes) / left
      const wanted = measured === null ? SAMPLE_MIN_BLOCKS : Math.min(4 * width, Math.max(SAMPLE_MIN_BLOCKS, perWindow / Math.max(rate, 1e-6)))
      const cap = rate > 0 ? SAMPLE_BATCH_BYTES / (PATH_BURST * rate * count) : wanted
      width = Math.max(1, Math.floor(Math.min(wanted, cap)))
      return width
    }
    /** Window `i`, `size` blocks: in the middle of its slot, or at the end of the last (the state block). */
    const place = (i: number, size: number) => {
      const slot = bounds[i]
      const blocks = Math.min(size, slot.to - slot.from + 1)
      const from = i === bounds.length - 1 ? slot.to - blocks + 1 : Math.floor((slot.from + slot.to - blocks) / 2)
      windows[i].from = from
      windows[i].to = from + blocks - 1
    }
    const read = async (batch: number[], size: number, tries: number): Promise<void> => {
      if (spent()) return
      for (const i of batch) place(i, size)
      try {
        const answer = await ask({ kind: 'span', poolId: state.poolId, spans: batch.map((i) => [windows[i].from, windows[i].to] as [number, number]) })
        const units = 'units' in answer ? answer.units : []
        batch.forEach((i, j) => {
          const unit = units[j]
          const window = windows[i]
          if (!unit || unit.from !== window.from || unit.to !== window.to) return
          window.logs = unit.logs.filter((log) => log[0] >= window.from && log[0] <= window.to)
          seen.bytes += JSON.stringify(window.logs).length
          seen.blocks += window.to - window.from + 1
        })
      } catch (error) {
        if (!(error instanceof Stop && error.reason === 'too_much_history')) throw error
        least = Math.max(least, SPAN_CAP_BYTES / batch.reduce((sum, i) => sum + windows[i].to - windows[i].from + 1, 0))
        // One by one, each narrower than it was; a window cut twice more is left unread.
        for (const i of batch) {
          const narrower = Math.min(windows[i].to - windows[i].from, widthFor(1))
          if (tries > 0 && narrower >= 1) await read([i], narrower, tries - 1)
        }
      }
    }
    // The first request reads one window (the last, up to the state block), the others SAMPLE_SPANS_PER_REQUEST each.
    for (let i = windows.length - 1, first = true; i >= 0; first = false) {
      const count = first ? 1 : Math.min(SAMPLE_SPANS_PER_REQUEST, i + 1)
      const batch = Array.from({ length: count }, (_, j) => i - count + 1 + j)
      await read(batch, widthFor(count, i + 1), 2)
      i -= count
    }
    const history = estimateHistory({
      tickLower: state.tickLower,
      tickUpper: state.tickUpper,
      lpFee: start.lpFee,
      ...(state.protocolFee === undefined ? {} : { protocolFee: state.protocolFee }),
      liquidity: state.liquidity,
      mint: { block: mint[0], tx: mint[3] },
      top,
      topTime: state.timestamp,
      earned: state.unclaimed,
      slots: windows,
      timeline,
    })
    return { history, rate: seen.blocks > 0 ? seen.bytes / seen.blocks : null }
  }

  try {
    // 2026-09-25: a price path's later run reads only what came after it.
    if (checkpoint?.path) return await pricePath(null)
    // 1–2. The mint and the size of the history.
    const lastDay = Math.floor(top / DAY_SPAN)
    if (!checkpoint) {
      const transfersSince = async (since: number) => rangeLogs(await ask({ kind: 'transfer', tokenId: run.id, since })).filter((log) => log[0] <= top && log[2] === 5)
      const isMint = (log: CompactLog) => log[4][0] === ZERO_TOPIC
      const earliest = Math.max(0, (lastDay - MAX_SWAP_DAYS + 1) * DAY_SPAN)
      const recent = Math.max(earliest, top - EPOCH_SPAN + 1)
      let transfers = await transfersSince(recent)
      if (!transfers.some(isMint) && earliest < recent) transfers = await transfersSince(earliest)
      const minted = transfers.find(isMint)
      // /state found the NFT, so its mint is older than any history that could be replayed.
      if (!minted) throw new Stop('too_much_history')
      mintBlock = minted[0]
      // Its owners since (each Transfer's receiver), the newest MAX_HOLDERS: the price path's settlements are theirs.
      const owners = transfers.filter((log) => !before(log, minted)).map((log) => `0x${log[4][1].slice(26)}`).filter((address) => BigInt(address) !== 0n)
      holders = [...new Set(owners.reverse())].slice(0, MAX_HOLDERS)
    }
    const firstDay = Math.floor(mintBlock / DAY_SPAN)
    if (lastDay - firstDay + 1 > MAX_SWAP_DAYS) throw new Stop('too_much_history')

    // 3. The pool's Initialize and every ModifyLiquidity and ProtocolFeeUpdated since.
    let firstEpoch: number
    /** The pool's Initialize block: no Swap is older (swapBefore looks no further back). */
    let initBlock = 0
    /** Whether the pool's epochs are asked in capped parts (the probe saw liquidity history). */
    let inParts = false
    if (checkpoint) {
      firstEpoch = Math.floor((through + 1) / EPOCH_SPAN)
    } else {
      const initialized = rangeLogs(await ask({ kind: 'initialize', poolId: state.poolId }))[0]
      if (!initialized || initialized[0] > mintBlock) throw new Stop('rpc_unavailable')
      // Initialize data: fee, tickSpacing, hooks, sqrtPriceX96, tick.
      if (word(initialized[5], 2) !== 0n) throw new Stop('hooked_pool')
      const fee = Number(word(initialized[5], 0))
      const tickSpacing = Number(BigInt.asIntN(24, word(initialized[5], 1)))
      if (fee >= 0x800000 || tickSpacing <= 0) throw new Stop('hooked_pool')
      replay = FeeReplay.start({ tokenId, tickLower: state.tickLower, tickUpper: state.tickUpper, tickSpacing, fee }, 0n, 0)
      firstEpoch = Math.floor(initialized[0] / EPOCH_SPAN)
      initBlock = initialized[0]
      const plan = await probe(initBlock)
      // 2026-09-25: a pool's whole history past the budget, or any liquidity history in the samples: the price path (see
      // the header), no longer a stop.
      // A position that has lived through most of a pool whose history fits (2310187: twelve million of its pool's
      // thirteen) reads about as much either way, and the exact replay of that history needs no owner's payments looked
      // for over its whole life (a query the node gave up on once, live, and the lane then rested for): it stays exact.
      const oldHand = plan.historyFits && (top - mintBlock) * PATH_LIFE_SHARE > top - initBlock
      if (!plan.fits && !oldHand) {
        const initPrice = word(initialized[5], 3)
        const initTick = Number(BigInt.asIntN(24, word(initialized[5], 4)))
        const start = { lpFee: fee, tickSpacing, initBlock, initPrice, initTick, swapRate: plan.swapRate }
        if (!plan.historyFits) return await pricePath(start)
        // The pool's history fits by its samples: should the path not settle the position (an owner who traded too
        // often for its settlements to be looked for, as 2310187's did in the fee scenes, or a replay that disagrees),
        // the exact replay of that history is the one, as before.
        try {
          const result = await pricePath(start)
          if (result.ok || result.reason !== 'replay_mismatch') return result
        } catch (error) {
          if (!(error instanceof Stop && (error.reason === 'replay_mismatch' || (error.reason === 'too_much_history' && bytes < run.budgetBytes)))) throw error
        }
        // The page's time again for the pool's history (the card shows its figures and loads meanwhile).
        deps.extend?.(BUDGET_MS.page)
        onPath = false
        replay = FeeReplay.start({ tokenId, tickLower: state.tickLower, tickUpper: state.tickUpper, tickSpacing, fee }, 0n, 0)
        through = -1
        points = []
      }
      inParts = plan.inParts
    }
    const lastEpoch = Math.floor(top / EPOCH_SPAN)
    const epochs = Array.from({ length: Math.max(0, lastEpoch - firstEpoch + 1) }, (_, i) => firstEpoch + i)
    const poolAnswers = await pooled(epochs, CLIENT_CONCURRENCY, (epoch) => askWhole(inParts ? { kind: 'pool', poolId: state.poolId, epoch, until: top, parts: true } : { kind: 'pool', poolId: state.poolId, epoch, until: top }))
    const poolLogs = poolAnswers.flatMap(rangeLogs).filter((log) => log[0] > through && log[0] <= top).sort(byPosition)
    let mintLog: CompactLog | null = null
    if (!checkpoint) {
      mintLog = poolLogs.find((log) => ownModify(log, tokenId)) ?? null
      if (!mintLog || mintLog[0] !== mintBlock) throw new Stop('rpc_unavailable')
    }

    // 4. Block times on the hourly grid, from the mint's hour (or where the checkpoint's end) to the state block's.
    const knownGrid = points.filter(([block]) => block % HOUR_SPAN === 0).map(([block]) => block)
    const fromAnchor = knownGrid.length > 0 ? Math.max(...knownGrid) / HOUR_SPAN + 1 : Math.floor(mintBlock / HOUR_SPAN)
    const anchors: number[] = []
    for (let anchor = fromAnchor; anchor * HOUR_SPAN <= top; anchor++) anchors.push(anchor * HOUR_SPAN)
    const batches: number[][] = []
    for (let i = 0; i < anchors.length; i += MAX_HEADERS_PER_REQUEST) batches.push(anchors.slice(i, i + MAX_HEADERS_PER_REQUEST))
    const headerAnswers = await pooled(batches, CLIENT_CONCURRENCY, (blocks) => {
      within()
      return ask({ kind: 'headers', blocks })
    })
    headerAnswers.forEach((answer, i) => {
      const got = 'headers' in answer ? answer.headers : []
      if (got.length !== batches[i].length || got.some(([block], j) => block !== batches[i][j])) throw new Stop('rpc_unavailable')
      points.push(...got)
    })
    points.push([top, state.timestamp])
    points = [...new Map(points).entries()].sort((a, b) => a[0] - b[0])
    const timeline = new Timeline(points)
    const current = replay
    if (!current) throw new Stop('rpc_unavailable')

    // 5. The replay, day by day, pool logs and swap logs merged in chain order.
    let cursor = 0
    const feed = (limit: number, extra: readonly CompactLog[]) => {
      let j = 0
      while (true) {
        const pool = cursor < poolLogs.length && poolLogs[cursor][0] <= limit ? poolLogs[cursor] : null
        const other = j < extra.length && extra[j][0] <= limit ? extra[j] : null
        if (!pool && !other) break
        if (pool && (!other || before(pool, other))) {
          current.apply(pool, timeline)
          cursor += 1
        } else if (other) {
          current.apply(other, timeline)
          j += 1
        }
      }
    }
    const startDay = checkpoint ? Math.floor((through + 1) / DAY_SPAN) : firstDay
    const daysTotal = lastDay - startDay + 1
    let daysDone = 0
    const request = (day: number) =>
      settled(ask({ kind: 'swaps', poolId: state.poolId, day, count: Math.min(MAX_DAYS_PER_REQUEST, lastDay - day + 1), until: top }))
    let day = startDay
    let pending = day <= lastDay ? request(day) : null
    let idle = 0
    while (pending) {
      const outcome = await pending
      if ('error' in outcome) throw outcome.error
      const answer = outcome.value
      const units = 'units' in answer ? answer.units : []
      if (units.some((unit, i) => unit.unit !== day + i)) throw new Stop('rpc_unavailable')
      const nextDay = 'next' in answer && answer.next !== null ? answer.next : day + units.length
      if (nextDay < day + units.length || (units.length === 0 && nextDay === day && ++idle >= IDLE_TRIES)) throw new Stop('rpc_unavailable')
      // An answer with no whole day still kept the hours it read: the next one starts further in.
      if (units.length === 0) await deps.sleep(IDLE_WAIT_MS)
      else idle = 0
      // The next days are asked while these are replayed, unless the budget is spent.
      pending = nextDay <= lastDay && !spent() ? request(nextDay) : null
      for (const unit of units) {
        const unitDay = unit.unit as number
        const logs = unit.logs.filter((log) => log[0] > through && log[0] <= top)
        if (!checkpoint && unitDay === firstDay && mintLog) {
          // The starting price: a Swap earlier in the mint day, else the last one before the day, else the Initialize.
          const mint = mintLog
          const earlier = logs.some((log) => log[2] === 3 && before(log, mint))
          // No Swap is older than the pool's Initialize: one made in the mint day has none before the day.
          const found = earlier || initBlock >= firstDay * DAY_SPAN ? null : await ask({ kind: 'swapBefore', poolId: state.poolId, block: firstDay * DAY_SPAN, since: initBlock })
          const previous = found && 'log' in found ? found.log : null
          feed(firstDay * DAY_SPAN - 1, previous && previous[0] < firstDay * DAY_SPAN ? [previous] : [])
        }
        const end = Math.min(unitDay * DAY_SPAN + DAY_SPAN - 1, top)
        feed(end, logs)
        through = end
        daysDone += 1
        deps.progress?.({ bytes, daysDone, daysTotal })
      }
      day = nextDay
      if (day <= lastDay && !pending) throw new Stop('too_much_history', true)
    }
    feed(top, [])
    through = top

    // 6. The verification gate.
    const { history, prices } = current.snapshot(top, state.timestamp, timeline)
    const owed = current.owed()
    const accrued = current.accrued()
    const pool = current.pool()
    const checks = history.checks
    const verified =
      owed[0] === state.unclaimed[0] &&
      owed[1] === state.unclaimed[1] &&
      accrued[0] === run.growth[0] &&
      accrued[1] === run.growth[1] &&
      pool.price === state.sqrtPriceX96 &&
      pool.tick === state.tick &&
      checks.tickMismatch === 0 &&
      checks.liquidityMismatch === 0 &&
      checks.swapFeeMismatch === 0 &&
      checks.inconsistentLastStep === 0 &&
      history.events.length > 0
    if (!verified) return { ok: false, reason: 'replay_mismatch', prices, checkpoint: null, bytes }
    return { ok: true, history, prices, checkpoint: keep(0) as Checkpoint }
  } catch (error) {
    if (error instanceof Cancelled) return null
    if (error instanceof ReplayError) return { ok: false, reason: 'replay_mismatch', prices: null, checkpoint: null, bytes }
    const reason: FeesReason = error instanceof Stop ? error.reason : 'rpc_unavailable'
    // Only a budget stop keeps its place: a later run with a larger budget goes on from it; a price path's, any later run
    // (2026-09-25, review: each counts its own bytes, `later`).
    const kept = error instanceof Stop && error.keepPlace && replay !== null && through >= 0 ? keep() : null
    return { ok: false, reason, prices: null, checkpoint: kept, bytes, ...(kept && onPath ? { later: true as const } : {}) }
  }
}
