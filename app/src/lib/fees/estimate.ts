/**
 * An estimated fees history (2026-09-25), drawn for a position in a busy pool
 * while its exact one is still being read (pipeline.ts, path mode).
 *
 * A position's fees are its liquidity times the path of its pool's price
 * inside its range, times the LP's part of the fee (replay.ts, the price
 * path): exact, but it needs every Swap of the position's life, 4.1 MB for
 * one day of PONS/USDG (measured 2026-09-25), a minute of reading under the
 * RPC's per-address limit. The estimate reads a small window of Swaps in each
 * slot of the life (an hour, or a few for an older position), takes the fees
 * the price path gives in it, and scales them to the slot's length; then
 * every slot is scaled by one factor per token so that the history ends on
 * the chain's own figures (what the position has earned since its mint, which
 * the caller knows exactly). The end is exact, the shape is an estimate: the
 * screens mark it "est.", and the exact history replaces it once read.
 *
 * Pure: no network, no clock. Time comes from the caller's Timeline.
 */
import { HOUR_SPAN } from './constants'
import { protocolPart, sqrtAtTick, type Timeline } from './replay'
import type { CompactLog, FeeEvent, FeeHistory, FeeHour, HourlyPrices } from './types'

const Q96 = 1n << 96n
const Q128 = 1n << 128n
const PIPS = 1_000_000n

/** One slot of the life and the window of Swaps read in it (its logs in chain order, Swaps and Donates). */
export interface EstimateSlot {
  /** The slot's first and last hour anchors (floor(block / HOUR_SPAN)). */
  firstAnchor: number
  lastAnchor: number
  /** The window read, in blocks, and its logs; `logs` null when it could not be read. */
  from: number
  to: number
  logs: readonly CompactLog[] | null
}

export interface EstimateInput {
  tickLower: number
  tickUpper: number
  /** The pool key's fee, in pips, and its protocol fee now as slot0 packs it (replay.ts protocolPart), when read. */
  lpFee: number
  protocolFee?: number
  /** The position's liquidity (constant over its life: an estimate is made only when it never changed). */
  liquidity: bigint
  mint: { block: number; tx: string }
  /** The state block and its time: the history's end. */
  top: number
  topTime: number
  /** What the position has earned since its mint, exactly (its unclaimed fees: no settlement since the mint). */
  earned: readonly [bigint, bigint]
  slots: readonly EstimateSlot[]
  timeline: Timeline
}

interface Window {
  credit: [bigint, bigint]
  /** Blocks the credit was taken over (from the window's first Swap to its end). */
  blocks: number
  /** The share of those blocks the price was inside the range. */
  inRange: number | null
  close: { price: bigint; tick: number } | null
}

const word = (data: string, index: number) => BigInt(`0x${data.slice(2 + index * 64, 66 + index * 64)}`)

/** The fees the price path gives the position in one window: from its first Swap's price on (that Swap sets the start). */
function windowCredit(input: EstimateInput, slot: EstimateSlot): Window | null {
  const swaps = (slot.logs ?? []).filter((log) => log[2] === 3)
  if (slot.logs === null) return null
  const lower = sqrtAtTick(input.tickLower)
  const upper = sqrtAtTick(input.tickUpper)
  const lpFee = BigInt(input.lpFee)
  const growth: [bigint, bigint] = [0n, 0n]
  let price: bigint | null = null
  let tick = 0
  let at = slot.from
  let inside = 0
  for (const log of swaps) {
    const end = word(log[5], 2)
    const endTick = Number(BigInt.asIntN(24, word(log[5], 4)))
    const swapFee = word(log[5], 5)
    if (price !== null) {
      if (input.tickLower <= tick && tick < input.tickUpper) inside += log[0] - at
      const [below, above] = price < end ? [price, end] : [end, price]
      const from = below > lower ? below : lower
      const to = above < upper ? above : upper
      const now = input.protocolFee === undefined ? undefined : BigInt(end < price ? input.protocolFee % 4096 : input.protocolFee >> 12)
      const protocolFee = protocolPart(swapFee, lpFee, now)
      if (to > from && protocolFee !== null && swapFee < PIPS && swapFee > protocolFee) {
        const lp = swapFee - protocolFee
        const rest = PIPS - swapFee
        if (end < price) growth[0] += ((to - from) * Q96 * Q128 * lp) / (to * from * rest)
        else growth[1] += ((to - from) * Q128 * lp) / (Q96 * rest)
      }
    }
    price = end
    tick = endTick
    at = log[0]
  }
  if (price === null) return { credit: [0n, 0n], blocks: slot.to - slot.from + 1, inRange: null, close: null }
  if (input.tickLower <= tick && tick < input.tickUpper) inside += slot.to - at
  const first = swaps[0][0]
  const blocks = Math.max(1, slot.to - first + 1)
  return {
    credit: [(growth[0] * input.liquidity) >> 128n, (growth[1] * input.liquidity) >> 128n],
    blocks,
    inRange: Math.min(1, Math.max(0, inside / blocks)),
    close: { price, tick },
  }
}

/** The estimated history, or null when no window could be read. */
export function estimateHistory(input: EstimateInput): { history: FeeHistory; prices: HourlyPrices } | null {
  const { timeline, mint, top } = input
  const firstAnchor = Math.floor(mint.block / HOUR_SPAN)
  const lastAnchor = Math.floor(top / HOUR_SPAN)
  const windows = input.slots.map((slot) => windowCredit(input, slot))
  if (windows.every((window) => window === null)) return null

  // Each hour's share of its slot's estimate, by the hour's blocks inside the life.
  const hourBlocks = (anchor: number) => Math.max(0, Math.min(top, (anchor + 1) * HOUR_SPAN - 1) - Math.max(mint.block, anchor * HOUR_SPAN) + 1)
  const raw = new Map<number, { credit: [bigint, bigint]; inRange: number | null; close: Window['close'] }>()
  input.slots.forEach((slot, i) => {
    const window = windows[i]
    for (let anchor = slot.firstAnchor; anchor <= slot.lastAnchor; anchor++) {
      const blocks = BigInt(hourBlocks(anchor))
      const credit: [bigint, bigint] = window ? [(window.credit[0] * blocks) / BigInt(window.blocks), (window.credit[1] * blocks) / BigInt(window.blocks)] : [0n, 0n]
      raw.set(anchor, { credit, inRange: window?.inRange ?? null, close: anchor === slot.lastAnchor ? (window?.close ?? null) : null })
    }
  })

  // One factor per token, so the history ends on what the position has exactly earned. A token no window saw earn (its
  // fees came in moves between the windows) follows the other token's shape, or the time the price was in range.
  const totals: [bigint, bigint] = [0n, 0n]
  for (const { credit } of raw.values()) {
    totals[0] += credit[0]
    totals[1] += credit[1]
  }
  const anchors = Array.from({ length: lastAnchor - firstAnchor + 1 }, (_, i) => firstAnchor + i)
  const seconds = anchors.map((anchor) => {
    const start = timeline.at(Math.max(mint.block, anchor * HOUR_SPAN))
    const end = anchor === lastAnchor ? input.topTime : timeline.at((anchor + 1) * HOUR_SPAN)
    return Math.max(0, end - start)
  })
  const inRangeSeconds = anchors.map((anchor, i) => Math.round(seconds[i] * (raw.get(anchor)?.inRange ?? 0)))
  const weight = (side: 0 | 1, i: number): bigint => {
    if (totals[side] > 0n) return raw.get(anchors[i])?.credit[side] ?? 0n
    const other = side === 0 ? 1 : 0
    if (totals[other] > 0n) return raw.get(anchors[i])?.credit[other] ?? 0n
    return BigInt(inRangeSeconds.some((value) => value > 0) ? inRangeSeconds[i] : seconds[i])
  }
  const weights = ([0, 1] as const).map((side) => anchors.map((_, i) => weight(side, i)))
  const sums = weights.map((list) => list.reduce((sum, value) => sum + value, 0n))
  const running: [bigint, bigint] = [0n, 0n]
  let price: bigint | null = null
  let tick = 0
  const hourly: FeeHour[] = []
  const closes: HourlyPrices['hours'][number][] = []
  anchors.forEach((anchor, i) => {
    running[0] += weights[0][i]
    running[1] += weights[1][i]
    const last = i === anchors.length - 1
    const earned: [bigint, bigint] = [
      last || sums[0] === 0n ? (last ? input.earned[0] : 0n) : (input.earned[0] * running[0]) / sums[0],
      last || sums[1] === 0n ? (last ? input.earned[1] : 0n) : (input.earned[1] * running[1]) / sums[1],
    ]
    const close = raw.get(anchor)?.close ?? null
    if (close) {
      price = close.price
      tick = close.tick
    }
    const t = last ? input.topTime : timeline.at((anchor + 1) * HOUR_SPAN)
    if (close) closes.push({ anchor, t, sqrtPriceX96Close: close.price, tickClose: close.tick })
    hourly.push({ anchor, t, earned, collected: [0n, 0n], inRangeSeconds: inRangeSeconds[i], sqrtPriceX96Close: price ?? 0n, tickClose: tick })
  })
  // Hours before the first window that saw a Swap carry its price back (a close is only the look of the line).
  const firstClose = hourly.find((hour) => hour.sqrtPriceX96Close !== 0n)
  for (const hour of hourly) {
    if (hour.sqrtPriceX96Close !== 0n) break
    if (firstClose) {
      hour.sqrtPriceX96Close = firstClose.sqrtPriceX96Close
      hour.tickClose = firstClose.tickClose
    }
  }
  const mintedAt = { block: mint.block, timestamp: timeline.at(mint.block) }
  const mintEvent: FeeEvent = { kind: 'mint', block: mint.block, timestamp: mintedAt.timestamp, tx: mint.tx, fees: [0n, 0n], liquidityDelta: input.liquidity }
  const sampled = input.slots.reduce((sum, slot) => sum + (slot.logs?.filter((log) => log[2] === 3).length ?? 0), 0)
  const history: FeeHistory = {
    mintedAt,
    earned: [input.earned[0], input.earned[1]],
    collected: [0n, 0n],
    timeInRange: { inSeconds: inRangeSeconds.reduce((sum, value) => sum + value, 0), totalSeconds: seconds.reduce((sum, value) => sum + value, 0) },
    hourly,
    events: [mintEvent],
    checks: { swaps: sampled, steps: 0, tickMismatch: 0, liquidityMismatch: 0, swapFeeMismatch: 0, inconsistentLastStep: 0 },
  }
  return { history, prices: { hours: closes } }
}
