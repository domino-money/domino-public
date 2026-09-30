/**
 * How a position is funded from what the wallet holds: both tokens as the
 * range pairs them, or one token alone, part of which is swapped for the
 * other inside the same pool before the mint — the assisted swap Domino V1's
 * setup contract already carries (DominoSetup.swap: one exact-input swap per
 * deposit, in the deposit's own pool, at the owner's minimum output).
 *
 * Exact integer arithmetic on the v4-core helpers (pairAmount.ts), with the
 * same band the mint is sized for (mintPlan.ts): currency0 counted where the
 * band's price is lowest, currency1 where it is highest. The first split is
 * the one that leaves the two sides in that ratio at the pool's price after
 * the pool's fee and the assisted-swap fee (`splitFor`); `sizeSwap` then asks
 * the contract what sizes buy, reads from each answer the price the swap
 * leaves, and settles on the size that makes the largest position there.
 * What the mint does not use returns with the NFT, so an imperfect split
 * costs a smaller position, never a revert.
 *
 * Nothing here reads the chain or the wallet, and nothing here signs.
 */
import { bandFor, bandLiquidity } from './mintPlan'
import { amount0ForLiquidity, amount1ForLiquidity } from './pairAmount'

const Q192 = 1n << 192n
/** A reference liquidity: large enough that the helpers' rounding is negligible in the ratio. */
const REFERENCE_L = 10n ** 30n
const FEE_DEN = 1_000_000n * 10_000n
/** More than any balance: what nothing can be bought for. */
const UNREACHABLE = 1n << 256n

export type Side = 0 | 1

/**
 * Domino's assisted-swap fee as the V1 deployment publishes it (setup-release
 * feeBps, 65 basis points), for Review's estimate. Create position uses the
 * fee the verified deployment itself reports.
 */
export const ASSISTED_SWAP_FEE_BPS = 65

/** An amount with the slippage limit as room, rounded up: the most the deposit may take of that token. */
export const withRoom = (amount: bigint, slippageBps: number) => (amount === 0n ? 0n : (amount * (10000n + BigInt(slippageBps)) + 9999n) / 10000n)

export interface PoolTerms {
  /** The pool's square-root price, as read. */
  sqrtPriceX96: bigint
  tickLower: number
  tickUpper: number
  /** The pool's LP fee, in pips (3000 is 0.30%). */
  feePips: number
  /** Domino's assisted-swap fee on the swapped amount, in basis points (the deployment's feeBps). */
  assistedFeeBps: number
  /** The owner's slippage limit, in basis points: the band the mint is sized for (mintPlan.ts). */
  slippageBps: number
}

/**
 * What each side of the range takes for the reference liquidity where the
 * mint sizes it: [amount0 at the band's lowest price, amount1 at its highest].
 * A side the band does not reach takes nothing.
 */
function sides(terms: PoolTerms): readonly [bigint, bigint] {
  const band = bandFor(terms.sqrtPriceX96, terms.tickLower, terms.tickUpper, terms.slippageBps)
  if (!band) return [0n, 0n]
  return [
    band.low < band.sqrtUpper ? amount0ForLiquidity(band.low, band.sqrtUpper, REFERENCE_L) : 0n,
    band.high > band.sqrtLower ? amount1ForLiquidity(band.sqrtLower, band.high, REFERENCE_L) : 0n,
  ]
}

/** The fee factor of a swap in this pool through the setup contract: (1 − pool fee)(1 − assisted fee), as numerator over FEE_DEN. Zero when a fee takes everything. */
function feeNumerator(terms: PoolTerms): bigint {
  const pool = BigInt(terms.feePips), assisted = BigInt(terms.assistedFeeBps)
  if (pool < 0n || pool >= 1_000_000n || assisted < 0n || assisted >= 10_000n) return 0n
  return (1_000_000n - pool) * (10_000n - assisted)
}

/**
 * How much of token `from` buys `amount` of the other at the pool's price, the
 * pool's fee and the assisted-swap fee included, before price impact. Rounded
 * up.
 */
export function costOf(amount: bigint, from: Side, terms: PoolTerms): bigint {
  if (amount <= 0n) return 0n
  const fees = feeNumerator(terms)
  if (fees === 0n || terms.sqrtPriceX96 <= 0n) return UNREACHABLE
  const p2 = terms.sqrtPriceX96 * terms.sqrtPriceX96
  // Token 1 per token 0 is p² / 2¹⁹². Buying token 1 with token 0 costs amount·2¹⁹²/p²; buying token 0 with token 1, amount·p²/2¹⁹².
  const atPrice = from === 0 ? amount * Q192 : amount * p2
  const per = from === 0 ? p2 : Q192
  const num = atPrice * FEE_DEN, den = per * fees
  return (num + den - 1n) / den
}

/** What `gross` of token `from` buys of the other at the pool's price, after both fees, before price impact. Rounded down. */
export function proceedsOf(gross: bigint, from: Side, terms: PoolTerms): bigint {
  if (gross <= 0n || terms.sqrtPriceX96 <= 0n) return 0n
  const p2 = terms.sqrtPriceX96 * terms.sqrtPriceX96
  const net = gross * feeNumerator(terms)
  return from === 0 ? (net * p2) / (Q192 * FEE_DEN) : (net * Q192) / (p2 * FEE_DEN)
}

/**
 * The part of `balance` of token `from` to swap so the rest and what it buys
 * sit in the range's ratio. Below the range the position is all token 0,
 * above it all token 1: the held token is then kept whole or swapped whole.
 */
export function splitFor(balance: bigint, from: Side, terms: PoolTerms): bigint {
  if (balance <= 0n) return 0n
  const [a0, a1] = sides(terms)
  const keep = from === 0 ? a0 : a1
  const buy = from === 0 ? a1 : a0
  if (buy === 0n) return 0n
  if (keep === 0n) return balance
  const cost = costOf(buy, from, terms)
  const s = (balance * cost) / (keep + cost)
  return s > balance ? balance : s
}

/**
 * The split again, with the pool's own rate at the first split's size: a quote
 * of `quoted` for `first` swapped says what the price impact costs, and the
 * split that balances the two sides at that rate follows. Clamped to the
 * balance.
 */
export function refineSplit(balance: bigint, from: Side, terms: PoolTerms, first: bigint, quoted: bigint): bigint {
  if (first <= 0n || quoted <= 0n) return first
  const [a0, a1] = sides(terms)
  const keep = from === 0 ? a0 : a1
  const buy = from === 0 ? a1 : a0
  if (buy === 0n || keep === 0n) return first
  // Balanced when (balance − s)/keep = rate·s/buy, with rate = quoted/first: s = balance·buy·first / (buy·first + quoted·keep).
  const s = (balance * buy * first) / (buy * first + quoted * keep)
  return s > balance ? balance : s < 1n ? 1n : s
}

/** Which side of the range a deposit needs across the mint's band: both, or one. */
export function needsSides(terms: PoolTerms): readonly [boolean, boolean] {
  const [a0, a1] = sides(terms)
  return [a0 > 0n, a1 > 0n]
}

/**
 * The pool's square-root price after `gross` of token `from` bought `output`
 * through the setup contract: the assisted fee off the gross, the pool's fee
 * off the rest, and along a constant-liquidity curve the product of the
 * square-root prices before and after is the rate the curve paid (exact inside
 * one liquidity range, the average across several). Never past the price in
 * the wrong direction: token 0 in lowers it, token 1 in raises it. Null when
 * the amounts say nothing.
 */
export function priceAfterSwap(terms: PoolTerms, from: Side, gross: bigint, output: bigint): bigint | null {
  const p = terms.sqrtPriceX96
  const net = gross - (gross * BigInt(terms.assistedFeeBps)) / 10_000n
  const curve = (net * (1_000_000n - BigInt(terms.feePips))) / 1_000_000n
  if (p <= 0n || curve <= 0n || output <= 0n) return null
  const after = from === 0 ? (output * Q192) / (curve * p) : (curve * Q192) / (output * p)
  if (after <= 0n) return null
  return from === 0 ? (after > p ? p : after) : after < p ? p : after
}

/**
 * What the mint would make of the deposit after `gross` of its `balance` of
 * token `from` was swapped for `output`, at the price that swap leaves: the
 * liquidity the kept part covers and the one the bought part covers, null for
 * a side the band does not need.
 */
export function liquidityAfterSwap(terms: PoolTerms, from: Side, balance: bigint, gross: bigint, output: bigint): { kept: bigint | null; bought: bigint | null; sqrtPriceX96: bigint } | null {
  const after = priceAfterSwap(terms, from, gross, output)
  if (after === null || gross > balance) return null
  const band = bandFor(after, terms.tickLower, terms.tickUpper, terms.slippageBps)
  if (!band) return null
  const kept = balance - gross
  const [l0, l1] = bandLiquidity(band, from === 0 ? kept : output, from === 0 ? output : kept)
  return from === 0 ? { kept: l0, bought: l1, sqrtPriceX96: after } : { kept: l1, bought: l0, sqrtPriceX96: after }
}

/**
 * The fee a swap in this direction pays, in pips, as v4-core's ProtocolFeeLibrary.calculateSwapFee takes it: the
 * pool's packed protocol fee (12 bits per direction: token 0 in the low bits, token 1 in the high) and the LP fee on
 * what the protocol leaves, pf + lp − ⌊pf·lp / 10⁶⌋.
 */
export function swapFeePips(lpFee: number, protocolFeeRaw: number, zeroForOne: boolean): number {
  const protocol = zeroForOne ? protocolFeeRaw & 0xfff : (protocolFeeRaw >>> 12) & 0xfff
  return protocol + lpFee - Math.floor((protocol * lpFee) / 1_000_000)
}

/** ⌊√n⌋ by Newton's method, from a first guess at or above the root. */
export function isqrt(n: bigint): bigint {
  if (n < 2n) return n < 0n ? 0n : n
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1)
  for (;;) {
    const next = (x + n / x) >> 1n
    if (next >= x) return x
    x = next
  }
}

/**
 * The pool's square-root price where an exact-input swap ends, from two quotes of it: `outDelta` more out for `step`
 * more in is the pool's marginal rate there, less the swap's fee (`feePips`, swapFeePips). Token 0 in pays token 1 at
 * price·(1 − fee), so √price = √(outDelta·2¹⁹²·10⁶ / (step·(10⁶ − fee))); token 1 in pays token 0 at (1 − fee)/price.
 * Null when the quotes say nothing.
 */
export function endSqrtPrice(zeroForOne: boolean, step: bigint, outDelta: bigint, feePips: number): bigint | null {
  if (!Number.isSafeInteger(feePips) || feePips < 0 || feePips >= 1_000_000 || step <= 0n || outDelta <= 0n) return null
  const f = 1_000_000n - BigInt(feePips)
  const root = zeroForOne ? isqrt((outDelta * Q192 * 1_000_000n) / (step * f)) : isqrt((step * f * Q192) / (outDelta * 1_000_000n))
  return root > 0n ? root : null
}

/** A pool's answer for `net` and `net + step` of one token in (finance/setup.ts quotePool), or its refusal. */
export type PoolQuote = { kind: 'quote'; out: bigint; outNext: bigint } | { kind: 'refused'; reason: string }

/**
 * A quote for sizeSwap before anything is deposited: what `gross` buys, asked of the pool itself for the net amount
 * the setup contract would swap (its assisted fee off the gross), with a second size a ten-thousandth larger (at least
 * 1,000 units) to read the price the swap ends at (endSqrtPrice, with the swap's own fee `feePips`). Null — too much
 * for this pool — when the pool refuses it, or when it would end at or past `check`, the square-root price the swap
 * may not reach.
 */
export function quoteWithin(assistedFeeBps: number, zeroForOne: boolean, feePips: number, check: bigint, ask: (net: bigint, step: bigint) => Promise<PoolQuote>) {
  return async (gross: bigint): Promise<bigint | null> => {
    const net = gross - (gross * BigInt(assistedFeeBps)) / 10_000n
    if (net <= 0n) return null
    const step = net / 10_000n > 1_000n ? net / 10_000n : 1_000n
    const answer = await ask(net, step)
    if (answer.kind !== 'quote' || answer.outNext <= answer.out) return null
    const end = endSqrtPrice(zeroForOne, step, answer.outNext - answer.out, feePips)
    if (end === null || (zeroForOne ? end <= check : end >= check)) return null
    return answer.out
  }
}

export interface SwapSize {
  gross: bigint
  /** What the contract's quote said this size buys. */
  output: bigint
  /** The price that swap leaves, as the quote implies it (`priceAfterSwap`). */
  sqrtPriceX96: bigint
  /** The liquidity the deposit then covers across the mint's band, before the mint's slack. */
  liquidity: bigint
}

/** At most this many quotes: each is one simulated swap through the wallet. */
export const SWAP_QUOTES = 10

/**
 * The swap that leaves the deposit making the largest position: the part of
 * `balance` of token `from` whose proceeds, at the price the swap itself
 * leaves, fund the range in its ratio across the mint's band. `quote` asks the
 * contract what a size buys; null is the contract refusing it (a size the pool
 * cannot fill inside the swap's price limit). The search keeps a bracket —
 * below it the part kept covers more than the part bought can match, above it
 * less — and steps by the rate each quote shows, halving the bracket when a
 * step would leave it, until the bracket is within 0.05% of the balance or
 * `maxQuotes` were asked. Null when no size quoted makes a position.
 */
export async function sizeSwap(terms: PoolTerms, from: Side, balance: bigint, quote: (gross: bigint) => Promise<bigint | null>, maxQuotes = SWAP_QUOTES): Promise<SwapSize | null> {
  if (balance <= 0n) return null
  const close = 1n + balance / 2000n
  let lo = 0n
  let hi = balance + 1n
  let best: SwapSize | null = null
  const first = splitFor(balance, from, terms)
  let gross = first < 1n ? 1n : first
  for (let asked = 0; asked < maxQuotes; asked++) {
    const output = await quote(gross)
    const after = output !== null && output > 0n ? liquidityAfterSwap(terms, from, balance, gross, output) : null
    let next: bigint
    if (output === null || output <= 0n || !after) {
      // Refused, or an answer that says nothing: this size is too much.
      hi = gross
      next = (lo + hi) / 2n
    } else {
      const covered = [after.kept, after.bought].filter((value): value is bigint => value !== null)
      const liquidity = covered.reduce((low, value) => (value < low ? value : low), covered[0] ?? 0n)
      if (liquidity > 0n && (!best || liquidity > best.liquidity)) best = { gross, output, sqrtPriceX96: after.sqrtPriceX96, liquidity }
      // The kept part covering more than the bought part (or not needed at all): swap more. Otherwise less.
      if (after.kept === null || (after.bought !== null && after.kept > after.bought)) lo = gross
      else hi = gross
      next = refineSplit(balance, from, { ...terms, sqrtPriceX96: after.sqrtPriceX96 }, gross, output)
    }
    if (next <= lo || next >= hi) next = (lo + hi) / 2n
    if (hi - lo <= close || next === gross || next < 1n || next > balance) break
    gross = next
  }
  return best
}

export type DepositPlan =
  /** Both tokens, each with the slippage room; for a range that takes one token alone, exactly that token's need. */
  | { kind: 'both'; amount0: bigint; amount1: bigint }
  /** One token alone: `deposit` of token `from`, of which `swap` (an estimate before the pool's impact) is swapped for `receive` of the other. */
  | { kind: 'swap'; from: Side; deposit: bigint; swap: bigint; receive: bigint }
  /** The wallet cannot fund this position either way: short of `token` by `need − have`. */
  | { kind: 'short'; token: Side; have: bigint; need: bigint }

export interface PlanInput {
  terms: PoolTerms
  /** The token the amount was typed in, and that amount, raw. */
  independent: Side
  typedRaw: bigint
  /** What the position takes of each token at the pool's price: the typed amount and the one the range pairs with it. */
  need0: bigint
  need1: bigint
  slippageBps: number
  /** The wallet's balances of token 0 and token 1, raw; for native ETH, what is left after the gas the steps need. Null when unknown. */
  balances: readonly [bigint, bigint] | null
}

/**
 * How this wallet funds this position. With both tokens at hand, both. Short
 * of the token the range pairs with the typed one, the typed amount is the
 * budget: it is deposited alone and part of it is swapped. Short of the typed
 * token itself, the other token pays for the whole position: its own share
 * and the cost of the typed amount. Unknown balances: both, and the chain
 * decides at Create position.
 *
 * A range that takes one token alone (one need is zero: pairAmount.ts
 * rangeTakesOnly) is funded with exactly that need, with no slippage room
 * (2026-09-28, one-sided, review): what one token alone makes of a range
 * beside the price does not depend on where the price sits on that side, and
 * a one-sided mint has no second token to hold it back, so a room would
 * become position. Review shows 500,000 MANY, and 500,000 MANY is approved,
 * deposited and minted (mintPlan.ts keeps back its 10 bps slack for the
 * rounding, returned with the NFT).
 */
export function depositPlan(input: PlanInput): DepositPlan {
  const { terms, independent, typedRaw, need0, need1, slippageBps, balances } = input
  const oneSided = (need0 === 0n) !== (need1 === 0n)
  const room: readonly [bigint, bigint] = oneSided ? [need0, need1] : [withRoom(need0, slippageBps), withRoom(need1, slippageBps)]
  if (!balances) return { kind: 'both', amount0: room[0], amount1: room[1] }
  // Both at hand, with the room where the wallet has it: the mint is sized to what was deposited.
  if (balances[0] >= need0 && balances[1] >= need1) {
    return { kind: 'both', amount0: balances[0] < room[0] ? balances[0] : room[0], amount1: balances[1] < room[1] ? balances[1] : room[1] }
  }
  const other: Side = independent === 0 ? 1 : 0
  if (typedRaw > 0n && balances[independent] >= typedRaw) {
    const swap = splitFor(typedRaw, independent, terms)
    return { kind: 'swap', from: independent, deposit: typedRaw, swap, receive: proceedsOf(swap, independent, terms) }
  }
  const needOther = other === 0 ? need0 : need1
  const typedNeed = independent === 0 ? need0 : need1
  const whole = withRoom(needOther + costOf(typedNeed, other, terms), slippageBps)
  if (whole < UNREACHABLE && balances[other] >= whole) {
    const swap = splitFor(whole, other, terms)
    return { kind: 'swap', from: other, deposit: whole, swap, receive: proceedsOf(swap, other, terms) }
  }
  return balances[independent] < typedRaw
    ? { kind: 'short', token: independent, have: balances[independent], need: typedRaw }
    : { kind: 'short', token: other, have: balances[other], need: room[other] }
}
