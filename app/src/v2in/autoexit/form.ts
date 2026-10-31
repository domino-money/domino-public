import { group } from '../../lib/format/decimal'
import { MAX_TICK, MIN_TICK, sqrtPriceAtTick, usableTicks } from '../../lib/read/screens/poolRange'
import { priceFromSqrtPriceX96, roundTripPrice, type PoolDecimals, type PriceMove, type PriceOrientation, type TriggerField } from '../../v2/trigger'
import { RECEIVE_MODE, ZERO_ADDRESS, type Address, type ReceiveMode } from '../../v2/types'
import { AUTO_EXIT_DEFAULT_SLIPPAGE_BPS, AUTO_EXIT_DEFAULT_VALIDITY_DAYS } from './constants'

/**
 * Auto-exit's terms (spec F7 §4.2, §4.4), from the position's own range. Pure: no price is typed and nothing is guessed.
 *
 * Changed on purpose 2026-10-06 (the owner's point 5; rugged97: "when the price hits the edge of the range we close the
 * position automatically and send the tokens to the wallet. It must be automatic"; the study p5-auto-exit.md, "trigger"):
 * the triggers are the range's edges, `triggerBelowSqrtPriceX96 = sqrtPriceAtTick(tickLower)` and
 * `triggerAboveSqrtPriceX96 = sqrtPriceAtTick(tickUpper)` (exact integers, the pool's own TickMath), against the pool's
 * current price:
 *   - inside the range: both edges;
 *   - below the range (a buy or sell order born beside the price): only the upper edge, the far one; the lower one is
 *     already crossed and would fire at once (a trigger already passed fires on the first pass);
 *   - above the range: only the lower edge.
 * The rest is fixed: both tokens as withdrawn (no conversion), the 1% default slippage on top of the pool fee, and a
 * year's validity (the app's longest), since it is an autonomous service.
 *
 * Changed on purpose 2026-10-06 (the review of point 5):
 *   - an edge is armed only while the price is strictly short of it. The module fires at the lower trigger at or below it
 *     (DominoAutoExit._authorize: anchor <= triggerBelow) and at the upper one at or above it, so a pool resting exactly
 *     on the lower edge's price (which the pool still counts in range) has already reached it;
 *   - an end at the pool's usable tick limit for its spacing covers every price there (the position page writes it 0 or
 *     ∞, lib/read/screens/positions.ts rangeEnd) and can never be reached: it is left off, and a full range has nothing
 *     to close at (`full_range`), whatever the price;
 *   - the price is the pool's own, read on chain right before the review (finance/v2/autoExit.ts readPoolPrice; the
 *     client refuses an armed edge the chain price has reached, `mandate_trigger_reached`).
 *
 * Domino V2 integration (2026-10-02): first the logic of src/v2ui/autoExit/form.ts (a typed price per trigger).
 */

/** A position's range, in the pool's own ticks. */
export interface ExitRange {
  tickLower: number
  tickUpper: number
}

/** Where the pool's price stands against the range: below it, inside it, or above it. */
export type PriceSide = 'below' | 'inside' | 'above'

/** The edges an Auto-exit arms: 0 is an edge that is off. */
export interface ExitEdges {
  side: PriceSide
  triggerBelowSqrtPriceX96: bigint
  triggerAboveSqrtPriceX96: bigint
}

/**
 * Why there is nothing to arm: no valid range (or spacing), no price, a range that covers every price the pool allows
 * (`full_range`, whatever the price), or a range beside the price whose far end is at the pool's limit
 * (`edges_unreachable`: the near end is crossed, the far one can never be reached).
 */
export type EdgesProblem = 'range_invalid' | 'price_unknown' | 'full_range' | 'edges_unreachable'
export type EdgesCheck = { ok: true; edges: ExitEdges } | { ok: false; problem: EdgesProblem }

/** Whether a tick range is one the pool could hold: whole ticks inside TickMath's bounds, the lower under the upper. */
export function rangeValid(range: ExitRange | null | undefined): range is ExitRange {
  return !!range && Number.isInteger(range.tickLower) && Number.isInteger(range.tickUpper) && range.tickLower >= MIN_TICK && range.tickUpper <= MAX_TICK && range.tickLower < range.tickUpper
}

/** A pool's tick spacing as v3 and v4 allow it: a whole number from 1 to 32,767. */
const spacingValid = (spacing: unknown): spacing is number => typeof spacing === 'number' && Number.isInteger(spacing) && spacing >= 1 && spacing <= 32_767

/**
 * Which of a range's ends the price can ever reach, on its pool's spacing (Added 2026-10-06, the review of point 5): an
 * end at the usable tick limit on its side (±887,220 on spacing 60, ±887,270 on 10, ±887,200 on 200) covers every price
 * the pool can have there, so it is never reached. Null for a range or spacing that is not valid.
 */
export function reachableEnds(range: ExitRange | null | undefined, tickSpacing: number): { lower: boolean; upper: boolean } | null {
  if (!rangeValid(range) || !spacingValid(tickSpacing)) return null
  const { min, max } = usableTicks(tickSpacing)
  return { lower: range.tickLower > min, upper: range.tickUpper < max }
}

/** Whether a range covers every price the pool allows: both its ends at the usable limits (Uniswap's "Full range"). */
export function fullRange(range: ExitRange | null | undefined, tickSpacing: number): boolean {
  const ends = reachableEnds(range, tickSpacing)
  return ends !== null && !ends.lower && !ends.upper
}

/** Where `sqrtPriceX96` stands against the range, as v3 and v4 count a position in range (sqrtA <= price < sqrtB). */
export function priceSide(range: ExitRange, sqrtPriceX96: bigint): PriceSide {
  if (sqrtPriceX96 < sqrtPriceAtTick(range.tickLower)) return 'below'
  if (sqrtPriceX96 >= sqrtPriceAtTick(range.tickUpper)) return 'above'
  return 'inside'
}

/**
 * The edges to arm for `range` on a pool of `tickSpacing` with its price at `sqrtPriceX96` (null when none was read):
 * each reachable end the price is strictly short of, since arming an edge already reached closes the position at once.
 */
export function exitEdges(range: ExitRange | null | undefined, sqrtPriceX96: bigint | null, tickSpacing: number): EdgesCheck {
  const ends = reachableEnds(range, tickSpacing)
  if (!ends || !rangeValid(range)) return { ok: false, problem: 'range_invalid' }
  if (!ends.lower && !ends.upper) return { ok: false, problem: 'full_range' }
  if (sqrtPriceX96 === null || sqrtPriceX96 <= 0n) return { ok: false, problem: 'price_unknown' }
  const lower = sqrtPriceAtTick(range.tickLower)
  const upper = sqrtPriceAtTick(range.tickUpper)
  const below = ends.lower && sqrtPriceX96 > lower ? lower : 0n
  const above = ends.upper && sqrtPriceX96 < upper ? upper : 0n
  if (below === 0n && above === 0n) return { ok: false, problem: 'edges_unreachable' }
  return { ok: true, edges: Object.freeze({ side: priceSide(range, sqrtPriceX96), triggerBelowSqrtPriceX96: below, triggerAboveSqrtPriceX96: above }) }
}

/**
 * Whether an armed edge sits within `bps` of the price (Added 2026-10-06, the review of point 5): the band of the price
 * itself, not of its square root, as the module's anchor compares them (contracts AnchorMath.withinBand: high² x 10,000 <=
 * low² x (10,000 + bps)). Within the slippage band an Auto-exit may close the position soon after it is turned on (on v3
 * the reference is a 10-minute average, which can still sit past the edge while the pool price is just inside it).
 */
export function nearEdge(edges: Pick<ExitEdges, 'triggerBelowSqrtPriceX96' | 'triggerAboveSqrtPriceX96'>, sqrtPriceX96: bigint, bps: number): boolean {
  if (sqrtPriceX96 <= 0n || !Number.isInteger(bps) || bps < 0) return false
  const within = (edge: bigint) => {
    if (edge <= 0n) return false
    const [high, low] = edge > sqrtPriceX96 ? [edge, sqrtPriceX96] : [sqrtPriceX96, edge]
    return high * high * 10_000n <= low * low * BigInt(10_000 + bps)
  }
  return within(edges.triggerBelowSqrtPriceX96) || within(edges.triggerAboveSqrtPriceX96)
}

/** The terms of an Auto-exit, before the client's review adds the owner, the vault's checks and the nonce. */
export interface MandateTerms {
  triggerBelowSqrtPriceX96: bigint
  triggerAboveSqrtPriceX96: bigint
  receiveMode: ReceiveMode
  convertTo: Address
  maxSlippageBps: number
  validUntil: bigint
}

const DAY = 86_400

/** Auto-exit's terms for `edges`, signed at `nowSeconds` (the page's clock): both tokens, 1% slippage, a year's validity. */
export function autoExitTerms(edges: ExitEdges, nowSeconds: number): MandateTerms {
  return Object.freeze({
    triggerBelowSqrtPriceX96: edges.triggerBelowSqrtPriceX96,
    triggerAboveSqrtPriceX96: edges.triggerAboveSqrtPriceX96,
    receiveMode: RECEIVE_MODE.both,
    convertTo: ZERO_ADDRESS,
    maxSlippageBps: AUTO_EXIT_DEFAULT_SLIPPAGE_BPS,
    validUntil: BigInt(Math.floor(nowSeconds) + AUTO_EXIT_DEFAULT_VALIDITY_DAYS * DAY),
  })
}

/** The move a mandate field means in an orientation: the inverse of src/v2/trigger.ts triggerField. */
export function moveOf(field: TriggerField, orientation: PriceOrientation): PriceMove {
  return (field === 'triggerBelowSqrtPriceX96') === (orientation === 'token1PerToken0') ? 'falls' : 'rises'
}

/**
 * A trigger's price as the screens write a range's ends, in an orientation; null for a trigger that is off or a token
 * whose decimals are unknown (never guessed). Also the automation screens' range ends (src/v2in/automate/tokens.ts
 * rangeWords).
 *
 * Changed on purpose 2026-10-30 (QA round 2, N2: the same range read "2,998.90" on V2 Review and the position page and
 * "2,998.9" on its Auto-exit line): src/v2/plan/present.ts priceText's rule, the integer part grouped: from 1,000 up,
 * exactly two decimals; from 1 to 1,000, six significant digits with at least two decimals; below 1, six significant
 * digits as before. Still exact, from the sqrt price itself (never a float).
 */
export function edgePrice(sqrtPriceX96: bigint, decimals: PoolDecimals, orientation: PriceOrientation): string | null {
  if (sqrtPriceX96 <= 0n || decimals.decimals0 === null || decimals.decimals0 === undefined || decimals.decimals1 === null || decimals.decimals1 === undefined) return null
  try {
    const at = (significant: number, rounding?: 'down') => priceFromSqrtPriceX96(sqrtPriceX96, decimals, orientation, { significant, rounding })
    // The leading digit rounded down: "0.0003" below 1, else as many digits as the price's integer part ("2000").
    const lead = at(1, 'down')
    if (lead.startsWith('0')) return at(6)
    const [integer, fraction = ''] = at(lead.length >= 4 ? lead.length + 2 : 6).split('.')
    return `${group(integer)}.${fraction.padEnd(2, '0')}`
  } catch {
    return null
  }
}

/** One armed edge as the dialog and the card say it: which way the price moves to reach it, and at what price. */
export interface EdgeWords {
  field: TriggerField
  move: PriceMove
  /** "2,000.00" (the screens' price rule, edgePrice), or null when a token's decimals are unknown. */
  price: string | null
  sqrtPriceX96: bigint
}

/** The armed edges of a pair of triggers, in an orientation, the falling one first. */
export function edgeWords(triggers: { triggerBelowSqrtPriceX96: bigint; triggerAboveSqrtPriceX96: bigint }, decimals: PoolDecimals, orientation: PriceOrientation): EdgeWords[] {
  const out: EdgeWords[] = []
  for (const field of ['triggerBelowSqrtPriceX96', 'triggerAboveSqrtPriceX96'] as const) {
    const sqrtPriceX96 = triggers[field]
    if (sqrtPriceX96 === 0n) continue
    out.push(Object.freeze({ field, move: moveOf(field, orientation), price: edgePrice(sqrtPriceX96, decimals, orientation), sqrtPriceX96 }))
  }
  return out.sort((a, b) => (a.move === b.move ? 0 : a.move === 'falls' ? -1 : 1))
}

/**
 * A signed trigger's integer back as a price in an orientation (spec §4.3 "ida e volta"): the shortest decimal that
 * translates back to exactly this integer, or, when there is none within the input's limits, the price rounded to
 * eight significant digits. Null for a trigger that is off (0) or decimals that are unknown.
 */
export function triggerPrice(sqrtPriceX96: bigint, decimals: PoolDecimals, orientation: PriceOrientation): string | null {
  if (sqrtPriceX96 === 0n || decimals.decimals0 === null || decimals.decimals0 === undefined || decimals.decimals1 === null || decimals.decimals1 === undefined) return null
  try {
    return roundTripPrice(sqrtPriceX96, decimals, orientation) ?? priceFromSqrtPriceX96(sqrtPriceX96, decimals, orientation, { significant: 8 })
  } catch {
    return null
  }
}
