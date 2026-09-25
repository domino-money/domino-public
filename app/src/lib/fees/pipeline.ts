/**
 * The fees pipeline of one position NFT (DESIGN-V2 §15.5), as the replay
 * worker runs it: the relay's logs in, a verified FeeHistory (or the reason
 * there is none) out. Kept apart from the worker's message glue so the tests
 * can drive it with recorded relay answers; it asks the network only through
 * the `logs` function it is handed.
 *
 *   1. `transfer`: the mint block (the NFT's first Transfer from the zero address).
 *   2. More swap days than MAX_SWAP_DAYS from the mint to the state block: stop (too_much_history).
 *   3. `initialize`, then every `pool` epoch from the pool's first to the state
 *      block's: the full tick map and the protocol-fee timeline.
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
 * A budget of decoded answer bytes bounds every run; past it the run stops
 * (too_much_history) and keeps a checkpoint a later run with a larger budget
 * resumes from. A verified run's checkpoint lets the next state block's run
 * replay only the new logs.
 */
import { BEHIND_RETRY_MS, CLIENT_CONCURRENCY, DAY_SPAN, EPOCH_SPAN, HOUR_SPAN, MAX_DAYS_PER_REQUEST, MAX_HEADERS_PER_REQUEST, MAX_SWAP_DAYS, POSITION_MANAGER } from './constants'
import { FeeReplay, ReplayError, Timeline, type ReplayData } from './replay'
import type { Checkpoint, CompactLog, FeesReason, LogsRequest, LogsResponse, PositionState, RelayAnswer, WorkerResult } from './types'

export interface PipelineDeps {
  /** One relay request (client.ts postLogs in the worker; recorded answers in the tests). */
  logs: (request: LogsRequest) => Promise<RelayAnswer<LogsResponse>>
  sleep: (ms: number) => Promise<void>
  progress?: (report: { bytes: number; daysDone: number; daysTotal: number }) => void
  /** True once the run is no longer wanted: it stops at the next request. */
  cancelled?: () => boolean
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
const RATE_ATTEMPTS = 3
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
  const keep = (): Checkpoint | null =>
    replay === null
      ? null
      : ({ v: 1, tokenId: run.id, poolId: state.poolId, tickLower: state.tickLower, tickUpper: state.tickUpper, mintBlock, through, points, replay: replay.save(), bytes } satisfies PipelineCheckpoint as unknown as Checkpoint)

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

  /** A one-unit request (a pool epoch), asked again while the relay answers with no whole unit: a busy one comes in parts. */
  async function askWhole(request: LogsRequest): Promise<Answer> {
    for (let idle = 1; ; idle++) {
      const answer = await ask(request)
      if (!('units' in answer) || answer.units.length > 0 || answer.next === null) return answer
      if (idle >= IDLE_TRIES) throw new Stop('rpc_unavailable')
      await deps.sleep(IDLE_WAIT_MS)
    }
  }

  try {
    // 1–2. The mint and the size of the history.
    if (!checkpoint) {
      const transfers = rangeLogs(await ask({ kind: 'transfer', tokenId: run.id })).filter((log) => log[0] <= top)
      const minted = transfers.find((log) => log[2] === 5 && log[4][0] === ZERO_TOPIC)
      if (!minted) throw new Stop('rpc_unavailable')
      mintBlock = minted[0]
    }
    const firstDay = Math.floor(mintBlock / DAY_SPAN)
    const lastDay = Math.floor(top / DAY_SPAN)
    if (lastDay - firstDay + 1 > MAX_SWAP_DAYS) throw new Stop('too_much_history')

    // 3. The pool's Initialize and every ModifyLiquidity and ProtocolFeeUpdated since.
    let firstEpoch: number
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
    }
    const lastEpoch = Math.floor(top / EPOCH_SPAN)
    const epochs = Array.from({ length: Math.max(0, lastEpoch - firstEpoch + 1) }, (_, i) => firstEpoch + i)
    const poolAnswers = await pooled(epochs, CLIENT_CONCURRENCY, (epoch) => askWhole({ kind: 'pool', poolId: state.poolId, epoch, until: top }))
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
    const headerAnswers = await pooled(batches, CLIENT_CONCURRENCY, (blocks) => ask({ kind: 'headers', blocks }))
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
      pending = nextDay <= lastDay && bytes < run.budgetBytes ? request(nextDay) : null
      for (const unit of units) {
        const unitDay = unit.unit as number
        const logs = unit.logs.filter((log) => log[0] > through && log[0] <= top)
        if (!checkpoint && unitDay === firstDay && mintLog) {
          // The starting price: a Swap earlier in the mint day, else the last one before the day, else the Initialize.
          const mint = mintLog
          const earlier = logs.some((log) => log[2] === 3 && before(log, mint))
          const found = earlier ? null : await ask({ kind: 'swapBefore', poolId: state.poolId, block: firstDay * DAY_SPAN })
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
    return { ok: true, history, prices, checkpoint: keep() as Checkpoint }
  } catch (error) {
    if (error instanceof Cancelled) return null
    if (error instanceof ReplayError) return { ok: false, reason: 'replay_mismatch', prices: null, checkpoint: null, bytes }
    const reason: FeesReason = error instanceof Stop ? error.reason : 'rpc_unavailable'
    // Only a budget stop keeps its place: a later run with a larger budget goes on from it.
    const kept = error instanceof Stop && error.keepPlace && replay !== null && through >= 0 ? keep() : null
    return { ok: false, reason, prices: null, checkpoint: kept, bytes }
  }
}
