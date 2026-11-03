/**
 * What the S1 screens say about amounts, prices and ranges, as pure functions (src/v2ui/s1 draws them): exact integer
 * arithmetic on raw amounts, a price shown in both orientations from a tick, the minimum liquidity said as token amounts,
 * what comes back as leftovers, and what a person types turned into raw units. No figure is made up: an unknown decimals
 * count shows raw units, never a guess, and a figure that cannot be worked out is null (the screen draws a dash).
 *
 * Pure: no viem, no wallet.
 */
import { readFigure, type Decimal } from '../../lib/create/typedFigure'
import { ZERO_ADDRESS, type Address, type PoolRef, type SwapLeg, type TokenAmount } from '../types'

const MIN_TICK = -887272
const MAX_TICK = 887272

/** "1,234,567": an integer's digits grouped by thousands. */
export function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Added 2026-10-06 (the owner's point 4: no 18-digit amounts on screen): the most fraction digits a token amount shows
 * (formatUnitsText's default), and the cap that writes one exactly, for its title or its data-exact (a token has at most
 * 77 decimals). Rounding happens only where an amount is drawn: what is sent or signed is always the raw amount.
 */
export const SHOWN_FRACTION = 6
export const EXACT_FRACTION = 77

/**
 * A raw amount in a token's units: "1,234.5678" with at most `maxFraction` decimals, ROUNDED DOWN (a shown amount is
 * never more than the raw one), trailing zeros dropped. `decimals` null: the raw integer, said by the caller as raw units.
 * A non-zero amount too small to show at `maxFraction` is "<0.000001" (never "0").
 *
 * `round` 'up' (added 2026-10-06, the owner's point 4, with the study's correction: rounding down suits "about" and "at
 * least", never a fee or an approval): raised to the next digit shown whenever a digit is dropped, so a Domino fee or an
 * amount the wallet is asked to allow is never shown lower than it is ("0.0080246907" is "0.008025").
 */
export function formatUnitsText(raw: bigint, decimals: number | null, maxFraction = SHOWN_FRACTION, round: 'down' | 'up' = 'down'): string {
  const negative = raw < 0n
  const value = negative ? -raw : raw
  if (decimals === null) return `${negative ? '−' : ''}${groupDigits(value.toString(10))}`
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 77) throw new Error('invalid_decimals')
  const keep = Math.max(0, Math.min(Math.trunc(maxFraction), decimals))
  const dropped = 10n ** BigInt(decimals - keep)
  const shown = round === 'up' && value % dropped !== 0n ? value - (value % dropped) + dropped : value
  const base = 10n ** BigInt(decimals)
  const whole = shown / base
  const fraction = (shown % base).toString(10).padStart(decimals, '0')
  const cut = fraction.slice(0, keep).replace(/0+$/, '')
  if (whole === 0n && cut === '' && value !== 0n) return `${negative ? '−' : ''}<0.${'0'.repeat(Math.max(0, keep - 1))}1`
  return `${negative ? '−' : ''}${groupDigits(whole.toString(10))}${cut ? `.${cut}` : ''}`
}

/**
 * Added 2026-10-30 (QA round 2, N2: one number format; "10,345.741134 PRIORS" on Review): a raw amount at six significant
 * digits, as the rest of the app writes a token amount (lib/format/amount.ts shortAmount): the whole part always whole and
 * grouped, the fraction only until six significant digits in all, trailing zeros dropped ("10,345.7", "2,018,590",
 * "0.19"). Below one, at most six decimals (the owner's point 4 of 2026-10-06: no 18-digit amounts on screen), so dust
 * still reads "<0.000001". ROUNDED DOWN, or with `round` 'up' for a fee or an amount to allow, never shown lower than it
 * is (formatUnitsText's rule). `decimals` null: the raw integer, said by the caller as raw units.
 */
export function significantUnitsText(raw: bigint, decimals: number | null, round: 'down' | 'up' = 'down', significant = 6): string {
  if (decimals === null) return formatUnitsText(raw, null)
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 77) throw new Error('invalid_decimals')
  const value = raw < 0n ? -raw : raw
  const base = 10n ** BigInt(decimals)
  const whole = value / base
  let keep: number
  if (whole > 0n) keep = Math.max(0, significant - whole.toString(10).length)
  else {
    const lead = (value % base).toString(10).padStart(decimals, '0').search(/[1-9]/)
    keep = lead === -1 ? 0 : Math.min(lead + significant, SHOWN_FRACTION)
  }
  return formatUnitsText(raw, decimals, Math.min(keep, decimals), round)
}

/**
 * What a person typed ("1,000.5", "0.25") as raw units; null when it is not a plain positive decimal with at most
 * `decimals` fraction digits. `decimals` null takes a raw integer only.
 *
 * Changed on purpose 2026-10-30 (QA round 2, N99): spaces around it are dropped, and commas only where they group
 * thousands ("1,000.50"), the rule New position's own amount step reads by (lib/create/amountText.ts). Any other comma is
 * refused: "0,5" was read as 5, ten times the amount, on the zap path and in a position's Add dialogs.
 *
 * Changed on purpose 2026-11-02 (review of the money PRs, M4): commas by lib/create/typedFigure.ts's rule, the one New
 * position reads by. "1,250" and "0,125" were read as 1250 and 125, a thousand times what a decimal comma means: the first
 * is refused as ambiguous, and both are decimals where the person's language writes a decimal comma (`decimal`, handed in
 * by a test). A page-style "1,000.5" or "1,250,000" still loses its separators.
 */
export function parseUnitsText(text: string, decimals: number | null, decimal?: Decimal): bigint | null {
  const read = readFigure(text, decimal)
  if (!read.ok) return null
  const clean = read.text
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

/**
 * "0.30%": a pool's fee in pips (hundredths of a basis point) as a percent. Changed on purpose 2026-10-30 (QA round 2,
 * N2: one fee format on every screen): the rule Robinhood Chain's screens write a fee by (lib/read/screens/fee.ts
 * fixedFeePercent), in integers: at least two decimals, then every further digit that is not zero (3000 → "0.30%",
 * 10000 → "1.00%", 500 → "0.05%", 200 → "0.02%", 50 → "0.005%"). It was "0.3%" and "1%" beside "0.30%" elsewhere.
 */
export function feeTierText(pips: number): string {
  if (!Number.isSafeInteger(pips) || pips < 0) return `${Number((pips / 10_000).toFixed(4)).toString()}%`
  const fraction = String(pips % 10_000).padStart(4, '0')
  return `${Math.floor(pips / 10_000)}.${fraction.slice(0, 2)}${fraction.slice(2).replace(/0+$/, '')}%`
}

/**
 * A price as a person reads it, no exponent; null stays a dash for the caller. Changed on purpose 2026-10-30 (QA round 2,
 * N2: "1,590.87" beside "3,411.8"): from 1,000 up, exactly two decimals; from 1 to 1,000, six significant digits with at
 * least two decimals ("3.40", "1.00045"); below 1, six significant digits as before. Never fewer digits than that: the
 * neighbouring ticks of a stable pair still read apart.
 */
export function priceText(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null
  if (value >= 1e15 || value < 1e-15) return null
  if (value >= 1000) return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true }).format(value)
  const text = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6, useGrouping: true }).format(value)
  if (value < 1) return text
  const point = text.indexOf('.')
  return point === -1 ? `${text}.00` : text.length - point - 1 < 2 ? `${text}0` : text
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

/**
 * Added 2026-10-06 (the review of the owner's point 5; rugged97: "someone makes an LP to buy or sell; when the price hits
 * the edge of the range we close the position automatically"): how New position's success offers Auto-exit for the range
 * it just opened. `none` for a range that covers every price the pool allows (no end to close it at); `recommended` when
 * today's price sits beside the range (a buy or a sell: tick < lower, or tick >= upper, as v3 and v4 count it), else
 * `offered`. An unknown price (`tick` null) is offered without the recommendation.
 */
export function exitOffer(tickLower: number, tickUpper: number, tickSpacing: number, tick: number | null): 'none' | 'offered' | 'recommended' {
  if (tickLower <= Math.ceil(MIN_TICK / tickSpacing) * tickSpacing && tickUpper >= Math.floor(MAX_TICK / tickSpacing) * tickSpacing) return 'none'
  return tick !== null && (tick < tickLower || tick >= tickUpper) ? 'recommended' : 'offered'
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
 * Added 2026-10-06 (the owner's point 4: little text): wei as ETH for an estimate said "about" (Review's one network fee
 * line): three significant digits, rounded to the nearest ("about 0.0001 ETH", not "0.00010002"). A ceiling keeps
 * ethText, which is never shown lower.
 */
export function ethAboutText(wei: bigint): string {
  if (wei <= 0n) return '0 ETH'
  const drop = wei.toString(10).length - 3
  if (drop <= 0) return `${formatUnitsText(wei, 18, EXACT_FRACTION)} ETH`
  const unit = 10n ** BigInt(drop)
  return `${formatUnitsText(((wei + unit / 2n) / unit) * unit, 18, EXACT_FRACTION)} ETH`
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
 * Added 2026-10-06 (the owner's point 4: a small cue, never a blank): what a review draws while the same choices are
 * quoted again (the price moved, or the quote ran out): the last review, `stale` (greyed and busy on screen), until the
 * new one replaces it. A first quote, or one for new choices, has nothing to keep and draws nothing.
 */
export function keptWhileRequoting<T>(now: T | null, requoting: boolean, last: T | null): { shown: T | null; stale: boolean } {
  if (now !== null) return { shown: now, stale: false }
  return requoting && last !== null ? { shown: last, stale: true } : { shown: null, stale: false }
}

/**
 * Added 2026-10-06 (the owner's point 4: Review shows ONE network fee line, its detail under Details): what that line
 * says.
 *   - `about` the plan's own cost (rev2 §2.4, planNetworkCost's total) once the wallet's fee per gas is known, plus the
 *     wallet's other transactions still to come (`others`, ./feesToCome: an approval is a transaction of its own). Each
 *     of those counts at its own prepared figure, a ceiling, so the sum can come out a little high, never low; one not
 *     prepared yet is `othersMissing`, for the screen to say as a dash next to the figure, never left out. When the
 *     plan's L1 data fee is unavailable the plan's part is the L2 part alone, and `l1Missing` asks the screen to say the
 *     L1 part as a dash next to it, never to let it pass for the whole (§2.4: never 0). Robinhood's measured zero is a
 *     figure like any other. `ceiling` (Base's, under Details): the plan's own ceiling with the same approvals added, so
 *     it is never below the figure in view; null where the plan has none.
 *   - else `upTo` a batch's own ceiling, once it is prepared: its calls together (the approvals in it), the L1 data fee
 *     ceiling included.
 *   - else `unknown`: nothing is known yet, and the screen draws a dash (never a zero).
 * One step's ceiling is never the line's figure alone: the approval's alone would understate the action's.
 */
export function networkFeeLine(args: { cost: { total: bigint; ceiling?: bigint | null } | null; l1Available: boolean; batchFee: bigint | null; others?: readonly (bigint | null)[] }):
  | { kind: 'about'; wei: bigint; ceiling: bigint | null; l1Missing: boolean; othersMissing: boolean }
  | { kind: 'upTo'; wei: bigint; ceiling: null; l1Missing: false; othersMissing: false }
  | { kind: 'unknown' } {
  if (args.cost) {
    const others = args.others ?? []
    const known = others.reduce<bigint>((sum, fee) => sum + (fee ?? 0n), 0n)
    const ceiling = args.cost.ceiling === undefined || args.cost.ceiling === null ? null : args.cost.ceiling + known
    return { kind: 'about', wei: args.cost.total + known, ceiling, l1Missing: !args.l1Available, othersMissing: others.some((fee) => fee === null) }
  }
  if (args.batchFee !== null) return { kind: 'upTo', wei: args.batchFee, ceiling: null, l1Missing: false, othersMissing: false }
  return { kind: 'unknown' }
}

/** The wallet transactions of a review other than its action: an approval, a reset to zero, the position's approval. */
const APPROVALS: ReadonlySet<string> = new Set(['approve', 'approve-reset', 'approve-nft'])

/**
 * Added 2026-10-06 (the owner's point 4, for networkFeeLine's `others`): the fees of a review's wallet transactions other
 * than its action that are still to be paid (an approval, a reset to zero, the position's approval; one the network has
 * not included yet), each at its prepared figure, null for one not read yet (./readFeesToCome reads them at the review).
 * A signature costs no network fee, the action is the plan's own cost, and a batch is its own figure.
 */
export function feesToCome(steps: readonly { kind: string; status: string; feeWei: bigint | null }[]): (bigint | null)[] {
  return steps.filter((step) => APPROVALS.has(step.kind) && step.status !== 'included' && step.status !== 'finalized').map((step) => step.feeWei)
}

/**
 * Added 2026-10-06 (the review of the owner's point 4: one network fee line, never "+ other steps —"): the fees of the
 * approvals still to come after step `current`, read at the review (one after another), so feesToCome has a figure for
 * each. `read(index)` prepares one for its fee only (reads only: the run prepares it again, for the wallet, when it becomes
 * current); `alive()` false stops it (a new quote). One that cannot be read yet (an approval that follows a reset to zero)
 * stays null, for the screen to say in words. Never throws.
 */
export async function readFeesToCome(steps: readonly { kind: string; index: number; status: string; feeWei: bigint | null }[], current: number, read: (index: number) => Promise<bigint>, alive: () => boolean): Promise<void> {
  for (const step of steps.slice(current + 1)) {
    if (step.status !== 'waiting' || step.feeWei !== null || !APPROVALS.has(step.kind)) continue
    try {
      const fee = await read(step.index)
      if (!alive()) return
      step.feeWei = fee
    } catch {
      if (!alive()) return
    }
  }
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
