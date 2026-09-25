/**
 * The exact replay of one position NFT's fees from its pool's event logs: a
 * port of spec/fees-poc.mjs §3 (DESIGN-V2 §15.4, fees-evolution.md §3), which
 * matched StateView to the unit on four positions.
 *
 * Every Swap is walked step by step as v4-core's Pool.swap does: each step
 * stops at the next initialized tick or at a tick-bitmap word boundary
 * (TickBitmap.nextInitializedTickWithinOneWord), its fee is
 * SwapMath.computeSwapStep's, the protocol's share is taken out, and the LP
 * part becomes fee growth (fee × 2^128 / L), credited to the position while
 * the pool's tick is inside its range. The event gives the total input, the
 * swap fee and the end price, tick and liquidity; it does not say exact-in or
 * exact-out, so the last step is solved both ways and the one that lands on
 * the event's price is kept. Each Swap's end tick and liquidity are checked
 * against the replay. The NFT's own ModifyLiquidity events (sender =
 * PositionManager, salt = tokenId) settle what it has earned: every
 * "collected" amount.
 *
 * Integer-exact (bigint throughout), no DOM, no clock: time comes from a
 * Timeline the caller builds from block headers. The state is plain data, so
 * a replay can be saved at any log and resumed later (a Checkpoint).
 */
import { HOUR_SPAN, POSITION_MANAGER } from './constants'
import type { CompactLog, FeeEvent, FeeHistory, FeeHour, HourlyPrices } from './types'

// ---------------------------------------------------------------------------
// v4-core math (TickMath, SqrtPriceMath, SwapMath, FullMath), integer-exact
// ---------------------------------------------------------------------------

const Q96 = 1n << 96n
const Q128 = 1n << 128n
const U256 = (1n << 256n) - 1n
const PIPS = 1_000_000n
export const MIN_TICK = -887272
export const MAX_TICK = 887272

const FACTORS: ReadonlyArray<readonly [number, bigint]> = [
  [0x2, 0xfff97272373d413259a46990580e213an], [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn], [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n], [0x20, 0xff973b41fa98c081472e6896dfb254c0n], [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n], [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n], [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n], [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n], [0x20000, 0x5d6af8dedb81196699c329225ee604n], [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
]

const sqrtCache = new Map<number, bigint>()

/** TickMath.getSqrtPriceAtTick. */
export function sqrtAtTick(tick: number): bigint {
  const hit = sqrtCache.get(tick)
  if (hit !== undefined) return hit
  const abs = Math.abs(tick)
  let p = abs & 1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : Q128
  for (const [bit, factor] of FACTORS) if (abs & bit) p = (p * factor) >> 128n
  if (tick > 0) p = U256 / p
  const value = (p + 0xffffffffn) >> 32n
  if (sqrtCache.size > 50_000) sqrtCache.clear()
  sqrtCache.set(tick, value)
  return value
}

const divUp = (a: bigint, b: bigint) => (a + b - 1n) / b
const mulDivUp = (a: bigint, b: bigint, d: bigint) => divUp(a * b, d)

/** SqrtPriceMath.getAmount0Delta. */
function amount0Delta(a: bigint, b: bigint, liquidity: bigint, up: boolean): bigint {
  if (a > b) [a, b] = [b, a]
  const n1 = liquidity << 96n
  const n2 = b - a
  return up ? divUp(mulDivUp(n1, n2, b), a) : (n1 * n2) / b / a
}

/** SqrtPriceMath.getAmount1Delta. */
function amount1Delta(a: bigint, b: bigint, liquidity: bigint, up: boolean): bigint {
  if (a > b) [a, b] = [b, a]
  return up ? mulDivUp(liquidity, b - a, Q96) : (liquidity * (b - a)) / Q96
}

/** SqrtPriceMath.getNextSqrtPriceFromInput. */
function nextPriceFromInput(price: bigint, liquidity: bigint, amountIn: bigint, zeroForOne: boolean): bigint {
  if (amountIn === 0n) return price
  if (zeroForOne) {
    // getNextSqrtPriceFromAmount0RoundingUp(add = true)
    const n1 = liquidity << 96n
    const product = amountIn * price
    if (product <= U256) {
      const denominator = n1 + product
      if (denominator <= U256) return mulDivUp(n1, price, denominator)
    }
    return divUp(n1, n1 / price + amountIn)
  }
  // getNextSqrtPriceFromAmount1RoundingDown(add = true)
  return price + (amountIn << 96n) / liquidity
}

const floorDiv = (a: number, b: number) => Math.floor(a / b)

// ---------------------------------------------------------------------------
// The tick map
// ---------------------------------------------------------------------------

/** liquidityGross and liquidityNet per initialized tick, and the sorted compressed ticks. Plain data. */
export interface TickMapData {
  spacing: number
  gross: Map<number, bigint>
  net: Map<number, bigint>
  sorted: number[]
}

function findIndex(sorted: readonly number[], c: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < c) lo = mid + 1
    else hi = mid
  }
  return lo
}

function updateTick(map: TickMapData, tick: number, delta: bigint, upper: boolean): void {
  const before = map.gross.get(tick) ?? 0n
  const after = before + delta
  if (after < 0n) throw new ReplayError(`negative liquidityGross at tick ${tick}`)
  map.net.set(tick, (map.net.get(tick) ?? 0n) + (upper ? -delta : delta))
  const c = tick / map.spacing
  if (before === 0n && after > 0n) map.sorted.splice(findIndex(map.sorted, c), 0, c)
  if (before > 0n && after === 0n) {
    map.sorted.splice(findIndex(map.sorted, c), 1)
    map.net.delete(tick)
  }
  if (after === 0n) map.gross.delete(tick)
  else map.gross.set(tick, after)
}

/** TickBitmap.nextInitializedTickWithinOneWord, clamped to [MIN_TICK, MAX_TICK] as Pool.swap does. */
function nextTick(map: TickMapData, tick: number, lte: boolean): [number, boolean] {
  let c = floorDiv(tick, map.spacing)
  let next: number
  let initialized: boolean
  if (lte) {
    const wordStart = floorDiv(c, 256) * 256
    const i = findIndex(map.sorted, c + 1) - 1
    initialized = i >= 0 && map.sorted[i] >= wordStart
    next = (initialized ? map.sorted[i] : wordStart) * map.spacing
  } else {
    c += 1
    const wordEnd = floorDiv(c, 256) * 256 + 255
    const i = findIndex(map.sorted, c)
    initialized = i < map.sorted.length && map.sorted[i] <= wordEnd
    next = (initialized ? map.sorted[i] : wordEnd) * map.spacing
  }
  return [Math.max(MIN_TICK, Math.min(MAX_TICK, next)), initialized]
}

/** The active liquidity at `tick`: the sum of liquidityNet of every initialized tick at or below it. */
function activeAt(map: TickMapData, tick: number): bigint {
  let liquidity = 0n
  for (const c of map.sorted) {
    if (c * map.spacing > tick) break
    liquidity += map.net.get(c * map.spacing) ?? 0n
  }
  return liquidity
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** Block timestamps known from headers (the hourly grid and state blocks); every other block is interpolated. */
export class Timeline {
  private readonly points: Array<[number, number]>

  constructor(points: Iterable<readonly [number, number]>) {
    const unique = new Map<number, number>()
    for (const [block, t] of points) unique.set(block, t)
    this.points = [...unique.entries()].sort((a, b) => a[0] - b[0])
  }

  /** The timestamp of `block`: exact at a known point, else linear between the nearest known points (at most minutes off). */
  at(block: number): number {
    const points = this.points
    let lo = 0
    let hi = points.length - 1
    if (hi < 0 || block < points[0][0] || block > points[hi][0]) throw new ReplayError(`no header around block ${block}`)
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (points[mid][0] <= block) lo = mid
      else hi = mid
    }
    const [b0, t0] = points[lo]
    const [b1, t1] = points[hi]
    if (block === b0 || b1 === b0) return t0
    if (block === b1) return t1
    return t0 + Math.floor(((block - b0) * (t1 - t0)) / (b1 - b0))
  }
}

// ---------------------------------------------------------------------------
// The replay
// ---------------------------------------------------------------------------

export class ReplayError extends Error {}

export interface ReplayChecks {
  swaps: number
  steps: number
  tickMismatch: number
  liquidityMismatch: number
  swapFeeMismatch: number
  inconsistentLastStep: number
  ambiguousLastStep: number
}

/** The position a replay follows. */
export interface ReplayTarget {
  tokenId: bigint
  tickLower: number
  tickUpper: number
  tickSpacing: number
  /** The pool key's fee (pips); a dynamic-fee pool (0x800000) has hooks and is never replayed. */
  fee: number
}

/** Everything a replay knows: plain, structured-cloneable data (a Checkpoint's core). */
export interface ReplayData {
  v: 1
  target: ReplayTarget
  map: TickMapData
  /** The pool's price, tick and active liquidity (null until the mint, when the tick map gives it). */
  price: bigint
  tick: number
  liquidity: bigint | null
  protocolFee: bigint
  /** The position's liquidity, its fee growth inside since its last settlement (mod 2^256), and what it has settled. */
  positionLiquidity: bigint
  accrued: [bigint, bigint]
  settled: [bigint, bigint]
  minted: { block: number; timestamp: number } | null
  /** The last log applied, [block, logIndex]. */
  last: [number, number] | null
  /** Clock: the open hour's anchor, its in-range seconds, whether it saw a Swap, and the last time accounted. */
  hour: number | null
  hourInRange: number
  hourSwapped: boolean
  lastTs: number | null
  inSeconds: number
  totalSeconds: number
  hourly: FeeHour[]
  prices: HourlyPrices['hours'][number][]
  events: FeeEvent[]
  checks: ReplayChecks
}

const topicAddress = (topic: string) => `0x${topic.slice(26)}`

function dataWords(data: string, count: number): bigint[] {
  if (data.length !== 2 + count * 64) throw new ReplayError('log data of the wrong size')
  const out: bigint[] = []
  for (let i = 0; i < count; i++) out.push(BigInt(`0x${data.slice(2 + i * 64, 66 + i * 64)}`))
  return out
}

export class FeeReplay {
  private readonly d: ReplayData

  private constructor(data: ReplayData) {
    this.d = data
  }

  /** A replay that starts before the mint at the pool's price `price` / `tick` (its Initialize, or the last Swap before). */
  static start(target: ReplayTarget, price: bigint, tick: number): FeeReplay {
    return new FeeReplay({
      v: 1,
      target,
      map: { spacing: target.tickSpacing, gross: new Map(), net: new Map(), sorted: [] },
      price,
      tick,
      liquidity: null,
      protocolFee: 0n,
      positionLiquidity: 0n,
      accrued: [0n, 0n],
      settled: [0n, 0n],
      minted: null,
      last: null,
      hour: null,
      hourInRange: 0,
      hourSwapped: false,
      lastTs: null,
      inSeconds: 0,
      totalSeconds: 0,
      hourly: [],
      prices: [],
      events: [],
      checks: { swaps: 0, steps: 0, tickMismatch: 0, liquidityMismatch: 0, swapFeeMismatch: 0, inconsistentLastStep: 0, ambiguousLastStep: 0 },
    })
  }

  /** A replay resumed from saved data (the data is copied). */
  static resume(data: ReplayData): FeeReplay {
    return new FeeReplay(structuredClone(data))
  }

  /** A copy of the replay's data, to save. */
  save(): ReplayData {
    return structuredClone(this.d)
  }

  get last(): [number, number] | null {
    return this.d.last
  }

  get minted(): { block: number; timestamp: number } | null {
    return this.d.minted
  }

  get checks(): ReplayChecks {
    return this.d.checks
  }

  /** Fees owed now: L × accrued / 2^128 per token, as v4 computes them. */
  owed(): [bigint, bigint] {
    const d = this.d
    return [(d.accrued[0] * d.positionLiquidity) >> 128n, (d.accrued[1] * d.positionLiquidity) >> 128n]
  }

  /** Fee growth inside accrued since the last settlement (mod 2^256): what the chain's inside − insideLast must equal. */
  accrued(): [bigint, bigint] {
    return [this.d.accrued[0], this.d.accrued[1]]
  }

  /** The pool's price, tick and active liquidity now. */
  pool(): { price: bigint; tick: number; liquidity: bigint | null } {
    return { price: this.d.price, tick: this.d.tick, liquidity: this.d.liquidity }
  }

  private inRange(): boolean {
    const d = this.d
    return d.target.tickLower <= d.tick && d.tick < d.target.tickUpper
  }

  /** Accounts the time from the last accounted moment to `ts` in the open hour. */
  private accrue(ts: number): void {
    const d = this.d
    if (d.lastTs !== null && ts > d.lastTs && d.positionLiquidity > 0n) {
      const dt = ts - d.lastTs
      d.totalSeconds += dt
      if (this.inRange()) {
        d.inSeconds += dt
        d.hourInRange += dt
      }
    }
    if (d.lastTs === null || ts > d.lastTs) d.lastTs = ts
  }

  private closeHour(t: number): void {
    const d = this.d
    if (d.hour === null) return
    const owed = this.owed()
    d.hourly.push({
      anchor: d.hour,
      t,
      earned: [d.settled[0] + owed[0], d.settled[1] + owed[1]],
      collected: [d.settled[0], d.settled[1]],
      inRangeSeconds: d.hourInRange,
      sqrtPriceX96Close: d.price,
      tickClose: d.tick,
    })
    if (d.hourSwapped) d.prices.push({ anchor: d.hour, t, sqrtPriceX96Close: d.price, tickClose: d.tick })
    d.hourInRange = 0
    d.hourSwapped = false
  }

  /** Closes every hour before `block`'s and accounts time up to `ts` (only once the position is minted). */
  private advance(block: number, ts: number, timeline: Timeline): void {
    const d = this.d
    if (d.hour === null) return
    const anchor = floorDiv(block, HOUR_SPAN)
    while (d.hour < anchor) {
      const end = timeline.at((d.hour + 1) * HOUR_SPAN)
      this.accrue(end)
      this.closeHour(end)
      d.hour += 1
    }
    this.accrue(ts)
  }

  /**
   * Applies one log. Logs must come in chain order: every Initialize,
   * ModifyLiquidity and ProtocolFeeUpdated of the pool from its Initialize,
   * and its Swaps and Donates from the price the replay started at.
   */
  apply(log: CompactLog, timeline: Timeline): void {
    const d = this.d
    const [block, index, event] = log
    if (d.last && (block < d.last[0] || (block === d.last[0] && index <= d.last[1]))) throw new ReplayError(`log ${block}:${index} out of order`)
    d.last = [block, index]
    if (event === 2) {
      d.protocolFee = dataWords(log[5], 1)[0]
      return
    }
    if (event === 5) return
    if (event === 0) {
      if (d.minted === null) {
        const [, , , price, tick] = dataWords(log[5], 5)
        d.price = price
        d.tick = Number(BigInt.asIntN(24, tick))
      }
      return
    }
    const mine = event === 1 && this.isMine(log)
    if (d.minted === null && !mine) {
      if (event === 1) {
        const [lower, upper, delta] = dataWords(log[5], 4)
        const change = BigInt.asIntN(256, delta)
        if (change !== 0n) {
          updateTick(d.map, Number(BigInt.asIntN(24, lower)), change, false)
          updateTick(d.map, Number(BigInt.asIntN(24, upper)), change, true)
        }
      } else if (event === 3) {
        const w = dataWords(log[5], 6)
        d.price = w[2]
        d.tick = Number(BigInt.asIntN(24, w[4]))
      }
      return
    }
    const ts = timeline.at(block)
    if (d.minted === null) {
      // The mint: the pool's active liquidity just before it, from the tick map; the clock starts here.
      d.liquidity = activeAt(d.map, d.tick)
      d.minted = { block, timestamp: ts }
      d.hour = floorDiv(block, HOUR_SPAN)
      d.lastTs = ts
    } else {
      this.advance(block, ts, timeline)
    }
    if (event === 1) this.modifyLiquidity(log, mine, ts)
    else if (event === 4) this.donate(log)
    else if (event === 3) this.swap(log)
  }

  private isMine(log: CompactLog): boolean {
    const topics = log[4]
    if (topics.length < 2 || topicAddress(topics[1]) !== POSITION_MANAGER) return false
    return dataWords(log[5], 4)[3] === this.d.target.tokenId
  }

  private modifyLiquidity(log: CompactLog, mine: boolean, ts: number): void {
    const d = this.d
    const [lowerWord, upperWord, deltaWord] = dataWords(log[5], 4)
    const lower = Number(BigInt.asIntN(24, lowerWord))
    const upper = Number(BigInt.asIntN(24, upperWord))
    const delta = BigInt.asIntN(256, deltaWord)
    if (mine) {
      if (lower !== d.target.tickLower || upper !== d.target.tickUpper) throw new ReplayError('the NFT’s own ModifyLiquidity names another range')
      const first = d.events.length === 0
      const fees = first ? ([0n, 0n] as [bigint, bigint]) : this.owed()
      d.settled = [d.settled[0] + fees[0], d.settled[1] + fees[1]]
      const after = d.positionLiquidity + delta
      if (after < 0n) throw new ReplayError('the position’s liquidity would go below zero')
      const kind: FeeEvent['kind'] = first ? 'mint' : delta > 0n ? 'increase' : delta < 0n ? (after === 0n ? 'close' : 'decrease') : 'collect'
      d.events.push({ kind, block: log[0], timestamp: ts, tx: log[3], fees, liquidityDelta: delta })
      d.accrued = [0n, 0n]
      d.positionLiquidity = after
    }
    if (delta !== 0n) {
      updateTick(d.map, lower, delta, false)
      updateTick(d.map, upper, delta, true)
      if (d.liquidity !== null && lower <= d.tick && d.tick < upper) d.liquidity += delta
    }
  }

  private donate(log: CompactLog): void {
    const d = this.d
    const [amount0, amount1] = dataWords(log[5], 2)
    if (d.liquidity !== null && d.liquidity > 0n && this.inRange()) {
      d.accrued[0] = (d.accrued[0] + (amount0 * Q128) / d.liquidity) & U256
      d.accrued[1] = (d.accrued[1] + (amount1 * Q128) / d.liquidity) & U256
    }
  }

  /** One Swap: amount0, amount1 (negative = paid in), sqrtPriceX96, liquidity, tick, fee, as the event gives them. */
  private swap(log: CompactLog): void {
    const d = this.d
    const w = dataWords(log[5], 6)
    const a0 = BigInt.asIntN(128, w[0])
    const a1 = BigInt.asIntN(128, w[1])
    const endPrice = w[2]
    const endLiquidity = w[3]
    const endTick = Number(BigInt.asIntN(24, w[4]))
    const swapFee = w[5]
    d.checks.swaps += 1
    d.hourSwapped = true
    const zeroForOne = endPrice < d.price ? true : endPrice > d.price ? false : a0 < 0n
    const input = zeroForOne ? -a0 : -a1
    const protocolFee = zeroForOne ? d.protocolFee % 4096n : d.protocolFee >> 12n
    const lpFee = BigInt(d.target.fee)
    // ProtocolFeeLibrary.calculateSwapFee
    const expectedFee = protocolFee === 0n ? lpFee : protocolFee + lpFee - (protocolFee * lpFee) / PIPS
    if (d.target.fee < 0x800000 && expectedFee !== swapFee) d.checks.swapFeeMismatch += 1
    const side = zeroForOne ? 0 : 1
    let liquidity = d.liquidity ?? 0n
    const addStep = (amountIn: bigint, feeAmount: bigint, stepTick: number) => {
      d.checks.steps += 1
      let lp = feeAmount
      if (protocolFee > 0n) lp -= swapFee === protocolFee ? feeAmount : ((amountIn + feeAmount) * protocolFee) / PIPS
      if (liquidity > 0n && d.target.tickLower <= stepTick && stepTick < d.target.tickUpper) {
        d.accrued[side] = (d.accrued[side] + (lp * Q128) / liquidity) & U256
      }
    }
    let remaining = input
    for (let guard = 0; ; guard++) {
      if (guard > 20_000) throw new ReplayError('step budget exhausted')
      const [tickNext, initialized] = nextTick(d.map, d.tick, zeroForOne)
      const target = sqrtAtTick(tickNext)
      const reachesTarget = zeroForOne ? endPrice <= target : endPrice >= target
      if (reachesTarget) {
        const amountIn = zeroForOne ? amount0Delta(target, d.price, liquidity, true) : amount1Delta(d.price, target, liquidity, true)
        const feeAmount = swapFee === PIPS ? amountIn : mulDivUp(amountIn, swapFee, PIPS - swapFee)
        if (endPrice === target && amountIn + feeAmount >= remaining) {
          // The last step ends exactly on this boundary.
          if (amountIn + feeAmount !== remaining) d.checks.inconsistentLastStep += 1
          addStep(amountIn, remaining - amountIn, d.tick)
          remaining = 0n
        } else {
          addStep(amountIn, feeAmount, d.tick)
          remaining -= amountIn + feeAmount
        }
        d.price = target
        if (initialized) {
          const net = d.map.net.get(tickNext) ?? 0n
          liquidity += zeroForOne ? -net : net
        }
        d.tick = zeroForOne ? tickNext - 1 : tickNext
        if (remaining <= 0n && d.price === endPrice) break
        continue
      }
      // The swap ends inside this step, at the event's price: exact-in (the fee is the remainder) or exact-out (the fee from amountIn).
      if (liquidity === 0n) {
        addStep(0n, remaining, d.tick)
        d.price = endPrice
        d.tick = endTick
        break
      }
      const lessFee = (remaining * (PIPS - swapFee)) / PIPS
      const exactIn = { amountIn: lessFee, fee: remaining - lessFee, ok: nextPriceFromInput(d.price, liquidity, lessFee, zeroForOne) === endPrice }
      const outIn = zeroForOne ? amount0Delta(endPrice, d.price, liquidity, true) : amount1Delta(d.price, endPrice, liquidity, true)
      const outFee = mulDivUp(outIn, swapFee, PIPS - swapFee)
      const exactOut = { amountIn: outIn, fee: outFee, ok: outIn + outFee === remaining }
      let pick = exactIn
      if (!exactIn.ok && exactOut.ok) pick = exactOut
      if (exactIn.ok && exactOut.ok && exactIn.fee !== exactOut.fee) d.checks.ambiguousLastStep += 1
      if (!exactIn.ok && !exactOut.ok) d.checks.inconsistentLastStep += 1
      addStep(pick.amountIn, pick.fee, d.tick)
      d.price = endPrice
      // A swap that ends inside a step takes the tick of its end price (TickMath.getTickAtSqrtPrice): the event's.
      if (!(sqrtAtTick(endTick) <= endPrice && (endTick === MAX_TICK || endPrice < sqrtAtTick(endTick + 1)))) d.checks.tickMismatch += 1
      d.tick = endTick
      break
    }
    if (d.tick !== endTick) {
      d.checks.tickMismatch += 1
      d.tick = endTick
    }
    if (liquidity !== endLiquidity) {
      d.checks.liquidityMismatch += 1
      liquidity = endLiquidity
    }
    d.liquidity = liquidity
  }

  /**
   * The history as of `block` (every log up to it applied) at time `ts`, and
   * the hourly closes of its Swaps: the hours so far plus the open hour closed
   * at `ts`. The replay itself is not changed, so it can go on from here.
   */
  snapshot(block: number, ts: number, timeline: Timeline): { history: FeeHistory; prices: HourlyPrices } {
    const copy = FeeReplay.resume(this.d)
    const d = copy.d
    if (d.minted === null) throw new ReplayError('the position’s mint was not among the logs')
    copy.advance(block, ts, timeline)
    copy.closeHour(ts)
    const owed = copy.owed()
    const checks = d.checks
    const history: FeeHistory = {
      mintedAt: { block: d.minted.block, timestamp: d.minted.timestamp },
      earned: [d.settled[0] + owed[0], d.settled[1] + owed[1]],
      collected: [d.settled[0], d.settled[1]],
      timeInRange: { inSeconds: d.inSeconds, totalSeconds: d.totalSeconds },
      hourly: d.hourly,
      events: d.events,
      checks: {
        swaps: checks.swaps,
        steps: checks.steps,
        tickMismatch: checks.tickMismatch,
        liquidityMismatch: checks.liquidityMismatch,
        swapFeeMismatch: checks.swapFeeMismatch,
        inconsistentLastStep: checks.inconsistentLastStep,
      },
    }
    return { history, prices: { hours: d.prices } }
  }
}
