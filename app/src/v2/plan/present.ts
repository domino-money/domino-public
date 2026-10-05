/**
 * What the S1 screens say about amounts, prices and ranges, as pure functions (src/v2ui/s1 draws them): exact integer
 * arithmetic on raw amounts, a price shown in both orientations from a tick, the minimum liquidity said as token amounts,
 * what comes back as leftovers, and what a person types turned into raw units. No figure is made up: an unknown decimals
 * count shows raw units, never a guess, and a figure that cannot be worked out is null (the screen draws a dash).
 *
 * Pure: no viem, no wallet.
 */
import { ZERO_ADDRESS, type Address, type PoolRef, type SwapLeg, type TokenAmount } from '../types'

const MIN_TICK = -887272
const MAX_TICK = 887272

/** "1,234,567": an integer's digits grouped by thousands. */
export function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * A raw amount in a token's units: "1,234.5678" with at most `maxFraction` decimals, ROUNDED DOWN (a shown amount is
 * never more than the raw one), trailing zeros dropped. `decimals` null: the raw integer, said by the caller as raw units.
 * A non-zero amount too small to show at `maxFraction` is "<0.000001" (never "0").
 */
export function formatUnitsText(raw: bigint, decimals: number | null, maxFraction = 6): string {
  const negative = raw < 0n
  const value = negative ? -raw : raw
  if (decimals === null) return `${negative ? '−' : ''}${groupDigits(value.toString(10))}`
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 77) throw new Error('invalid_decimals')
  const base = 10n ** BigInt(decimals)
  const whole = value / base
  const fraction = (value % base).toString(10).padStart(decimals, '0')
  const cut = fraction.slice(0, Math.max(0, Math.min(maxFraction, decimals))).replace(/0+$/, '')
  if (whole === 0n && cut === '' && value !== 0n) return `${negative ? '−' : ''}<0.${'0'.repeat(Math.max(0, Math.min(maxFraction, decimals) - 1))}1`
  return `${negative ? '−' : ''}${groupDigits(whole.toString(10))}${cut ? `.${cut}` : ''}`
}

/**
 * What a person typed ("1,000.5", "0.25") as raw units; null when it is not a plain positive decimal with at most
 * `decimals` fraction digits. `decimals` null takes a raw integer only.
 */
export function parseUnitsText(text: string, decimals: number | null): bigint | null {
  const clean = text.trim().replace(/,/g, '')
  if (decimals === null) return /^[0-9]{1,78}$/.test(clean) && BigInt(clean) > 0n ? BigInt(clean) : null
  const match = /^([0-9]{0,60})(?:\.([0-9]*))?$/.exec(clean)
  if (!match || (match[1] === '' && (match[2] ?? '') === '')) return null
  const fraction = match[2] ?? ''
  if (fraction.length > decimals) return null
  const value = BigInt(match[1] || '0') * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0')
  return value > 0n ? value : null
}

/** A slippage typed as a percent ("0.5") as basis points inside [min, max]; null otherwise. */
export function slippageBpsOf(text: string, min: number, max: number): number | null {
  const clean = text.trim().replace(/%$/, '').trim()
  if (!/^[0-9]{1,2}(\.[0-9]{1,2})?$/.test(clean)) return null
  const [whole, fraction = ''] = clean.split('.')
  const bps = Number(whole) * 100 + Number((fraction + '00').slice(0, 2))
  return bps >= min && bps <= max ? bps : null
}

/** "0x1234…abcd". */
export const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`

/** A token's label: its symbol (untrusted text, already cleaned by the read parser), "ETH" for native, else its short address. */
export function tokenText(token: { address: Address; symbol: string | null }): string {
  if (token.address.toLowerCase() === ZERO_ADDRESS) return token.symbol ?? 'ETH'
  return token.symbol ?? shortAddress(token.address)
}

/** "0.3%": a pool's fee in pips (hundredths of a basis point) as a percent. */
export function feeTierText(pips: number): string {
  const percent = pips / 10_000
  return `${Number(percent.toFixed(4)).toString()}%`
}

/** A price as a person reads it: six significant digits, no exponent; null stays a dash for the caller. */
export function priceText(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null
  if (value >= 1e15 || value < 1e-15) return null
  return new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6, useGrouping: true }).format(value)
}

/**
 * The price of currency0 in currency1 at a tick, in whole tokens: 1.0001^tick × 10^(decimals0 − decimals1). Null when a
 * decimals count is unknown (never guessed) or the figure is out of range.
 */
export function priceAtTick(tick: number, decimals0: number | null, decimals1: number | null): number | null {
  if (decimals0 === null || decimals1 === null || !Number.isSafeInteger(tick)) return null
  const value = Math.exp(tick * Math.log(1.0001)) * 10 ** (decimals0 - decimals1)
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * A range in both orientations (spec §2.6.1 review: "o range, nas duas orientações de preço"): `forward` is currency1
 * per currency0 (low, high), `inverse` is currency0 per currency1 (low, high); null figures where a decimals count is
 * unknown.
 */
export function rangeBothWays(tickLower: number, tickUpper: number, decimals0: number | null, decimals1: number | null) {
  const low = priceAtTick(tickLower, decimals0, decimals1)
  const high = priceAtTick(tickUpper, decimals0, decimals1)
  return {
    forward: { low, high },
    inverse: { low: high === null ? null : 1 / high, high: low === null ? null : 1 / low },
  }
}

/** The usable tick nearest `tick` on a spacing, inside TickMath's bounds. */
export function usableTick(tick: number, spacing: number): number {
  if (!Number.isSafeInteger(spacing) || spacing < 1) throw new Error('invalid_tick_spacing')
  const min = Math.ceil(MIN_TICK / spacing) * spacing
  const max = Math.floor(MAX_TICK / spacing) * spacing
  const rounded = Math.round(tick / spacing) * spacing
  return Math.min(max, Math.max(min, rounded))
}

/**
 * A range around the price now, `percent` either way (1 for ±1%): ticks on the pool's spacing, the lower rounded down
 * and the upper rounded up, never empty, inside TickMath's bounds.
 */
export function rangeAround(tick: number, spacing: number, percent: number): { tickLower: number; tickUpper: number } {
  if (!Number.isSafeInteger(spacing) || spacing < 1) throw new Error('invalid_tick_spacing')
  if (!(percent > 0) || percent >= 100) throw new Error('invalid_range_width')
  const up = Math.ceil(Math.log(1 + percent / 100) / Math.log(1.0001))
  const down = Math.ceil(-Math.log(1 - percent / 100) / Math.log(1.0001))
  const min = Math.ceil(MIN_TICK / spacing) * spacing
  const max = Math.floor(MAX_TICK / spacing) * spacing
  let tickLower = Math.max(min, Math.floor((tick - down) / spacing) * spacing)
  let tickUpper = Math.min(max, Math.ceil((tick + up) / spacing) * spacing)
  if (tickLower >= tickUpper) {
    if (tickUpper + spacing <= max) tickUpper = tickLower + spacing
    else tickLower = tickUpper - spacing
  }
  return { tickLower, tickUpper }
}

/** Whether a range is valid for a pool: ordered, on its spacing, inside TickMath's bounds (spec §2.6.1). */
export function rangeValid(tickLower: number, tickUpper: number, spacing: number): boolean {
  return Number.isSafeInteger(tickLower) && Number.isSafeInteger(tickUpper) && tickLower < tickUpper && tickLower >= MIN_TICK && tickUpper <= MAX_TICK
    && tickLower % spacing === 0 && tickUpper % spacing === 0
}

/**
 * The plan's minimum liquidity said as token amounts (spec §2.6.1 "liquidez esperada e mínima, como valores de
 * token"): at one price, a position's token amounts are proportional to its liquidity, so the minimum is the expected
 * amounts × minLiquidity / expectedLiquidity, rounded down. Null without an expected liquidity.
 */
export function minimumTokens(expected: readonly [bigint, bigint], expectedLiquidity: bigint, minLiquidity: bigint): readonly [bigint, bigint] | null {
  if (expectedLiquidity <= 0n || minLiquidity < 0n || minLiquidity > expectedLiquidity) return null
  return [(expected[0] * minLiquidity) / expectedLiquidity, (expected[1] * minLiquidity) / expectedLiquidity]
}

/**
 * What the plan expects to come back to the wallet (spec §2.6.1 "o que volta como sobra"), per token: what goes in
 * (inputs, or what a change of range or an exit removes), plus what the legs deliver (as quoted), minus what they spend,
 * minus the Domino fee, minus what enters the position. An estimate (the receipt's Refunded events are exact). On v3,
 * native ETH that enters a WETH pool comes back as WETH (spec §2.7). Null when the figures do not add up (a reply that
 * spends more than it holds): nothing is shown rather than a wrong figure.
 */
export function leftovers(args: {
  pool: PoolRef
  weth: Address
  inputs: readonly TokenAmount[]
  removed?: readonly [bigint, bigint]
  legs: readonly SwapLeg[]
  quotedOut: readonly bigint[]
  fee: { token: Address; amount: bigint } | null
  added: readonly [bigint, bigint]
}): readonly { token: Address; amount: bigint }[] | null {
  const held = new Map<string, bigint>()
  const add = (token: string, amount: bigint) => held.set(token.toLowerCase(), (held.get(token.toLowerCase()) ?? 0n) + amount)
  for (const input of args.inputs) add(input.token, input.amount)
  if (args.removed) {
    add(args.pool.currency0, args.removed[0])
    add(args.pool.currency1, args.removed[1])
  }
  args.legs.forEach((leg, i) => {
    add(leg.tokenIn, -leg.amountIn)
    add(leg.tokenOut, args.quotedOut[i] ?? 0n)
  })
  if (args.fee) add(args.fee.token, -args.fee.amount)
  const weth = args.weth.toLowerCase()
  const native = held.get(ZERO_ADDRESS) ?? 0n
  if (args.pool.dex === 3 && (args.pool.currency0 === weth || args.pool.currency1 === weth) && native > 0n) {
    held.set(ZERO_ADDRESS, 0n)
    add(weth, native)
  }
  add(args.pool.currency0, -args.added[0])
  add(args.pool.currency1, -args.added[1])
  const out: { token: Address; amount: bigint }[] = []
  for (const [token, amount] of held) {
    if (amount < 0n) return null
    if (amount > 0n) out.push({ token: token as Address, amount })
  }
  return out
}

/** "12 min", "1 h 5 min": a span of seconds for the review's deadline. */
export function spanText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s} s`
  const minutes = Math.floor(s / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`
}

/** Wei as ETH, for a network fee ("0.000048 ETH"): rounded UP at 8 decimals, so a ceiling is never shown lower. */
export function ethText(wei: bigint): string {
  if (wei <= 0n) return '0 ETH'
  const step = 10n ** 10n
  const up = ((wei + step - 1n) / step) * step
  return `${formatUnitsText(up, 18, 8)} ETH`
}

/**
 * A raw amount as an amount field's text, EXACTLY (spec §3.9: a finished deposit handed to New position fills its
 * amount): every decimal kept, no grouping, trailing zeros dropped; the raw digits when the decimals are unknown.
 * parseUnitsText reads it back to the same raw amount.
 */
export function exactUnitsText(raw: bigint, decimals: number | null): string {
  if (raw < 0n) throw new Error('invalid_amount')
  if (decimals === null) return raw.toString(10)
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 77) throw new Error('invalid_decimals')
  const base = 10n ** BigInt(decimals)
  const fraction = (raw % base).toString(10).padStart(decimals, '0').replace(/0+$/, '')
  return `${(raw / base).toString(10)}${fraction ? `.${fraction}` : ''}`
}

/**
 * Where a handed-over token goes on New position's amounts (spec §3.9): one of the pool's own tokens is "One token"
 * of it, a token "Another token" offers is that; any other cannot start this pool's plan (null: the person types).
 */
export function handoffPlace(token: Address, pool: PoolRef, others: readonly Address[]): { mode: 'one' | 'other'; token: Address } | null {
  const t = token.toLowerCase() as Address
  if (t === pool.currency0.toLowerCase() || t === pool.currency1.toLowerCase()) return { mode: 'one', token: t }
  if (others.some((other) => other.toLowerCase() === t)) return { mode: 'other', token: t }
  return null
}

/**
 * Rev2 §2.9's line: how much smaller the position can come out if the price moves within the slippage, as a percent of
 * the planned liquidity, X = 1 − minimum / expected, ROUNDED UP to one decimal ("34", "0.6"): the sentence says "up
 * to", so it is never shown lower. Null without a planned liquidity.
 */
export function smallerUpToPercent(expected: bigint, minimum: bigint): string | null {
  if (expected <= 0n || minimum < 0n) return null
  if (minimum >= expected) return '0'
  // tenths of a percent, rounded up
  const tenths = ((expected - minimum) * 1000n + expected - 1n) / expected
  const whole = tenths / 10n
  const fraction = tenths % 10n
  return fraction === 0n ? whole.toString(10) : `${whole}.${fraction}`
}

/**
 * The network cost a plan's action will take, in wei (rev2 §2.4 "Custo de rede na revisão"), from the plan's own figures
 * and the fee per gas the wallet's review read:
 *   - Nitro (Robinhood, Arbitrum): (simulation gas + the L1 component's gas units) × the fee per gas;
 *   - OP Stack (Base): simulation gas × the fee per gas + the L1 data fee, its upper bound as the ceiling.
 * `l1` null when the plan's L1 data fee is unavailable: the L2 part only, and the L1 part said as unknown (never 0).
 */
export function planNetworkCost(args: {
  gasUnits: bigint
  feePerGas: bigint
  l1: { source: 'op_gas_price_oracle'; wei: bigint; upperBoundWei: bigint | null } | { source: 'nitro_node_interface'; wei: bigint; l1GasUnits: bigint } | null
}): { l2: bigint; l1: bigint | null; total: bigint; ceiling: bigint | null } {
  const l2 = args.gasUnits * args.feePerGas
  if (!args.l1) return { l2, l1: null, total: l2, ceiling: null }
  if (args.l1.source === 'nitro_node_interface') {
    const l1 = args.l1.l1GasUnits * args.feePerGas
    return { l2, l1, total: l2 + l1, ceiling: null }
  }
  return { l2, l1: args.l1.wei, total: l2 + args.l1.wei, ceiling: args.l1.upperBoundWei === null ? null : l2 + args.l1.upperBoundWei }
}

/**
 * A converted exit's summary (rev2 §2.6.4): each conversion leg spends exactly its amountIn, so at least that much of the
 * source token is converted; the rest of what the withdrawal is expected to pay of it may come back as is. `offer`
 * when that rest is above `offerAbovePercent` of the source token's expected withdrawal (then a lower slippage or both
 * tokens is offered). Null when the plan converts nothing of a pool currency.
 */
export function conversionSummary(args: {
  pool: PoolRef
  legs: readonly SwapLeg[]
  expectedRemoved: readonly [bigint, bigint]
  offerAbovePercent: number
}): { token: Address; converted: bigint; rest: bigint; offer: boolean } | null {
  const sources = [args.pool.currency0, args.pool.currency1]
  for (const [i, token] of sources.entries()) {
    const converted = args.legs.filter((leg) => leg.tokenIn.toLowerCase() === token.toLowerCase()).reduce((sum, leg) => sum + leg.amountIn, 0n)
    if (converted === 0n) continue
    const expected = args.expectedRemoved[i]
    const rest = expected > converted ? expected - converted : 0n
    const offer = expected > 0n && rest * 100n > expected * BigInt(args.offerAbovePercent)
    return { token, converted, rest, offer }
  }
  return null
}
