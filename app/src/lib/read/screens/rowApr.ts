/**
 * A pool row's fee APR estimate, from the figures the pools read already
 * carried.
 *
 * The read service publishes its own estimate on read-v2 `pool-market`, and
 * that one stays the authority wherever a single pool is the subject: the pool
 * page, the markets carousel, the ticker. A list of twelve pools cannot ask for
 * twelve of those, so the list works its own out from the figures its own read
 * already returned.
 *
 * It is NOT the same figure, and must never be described as one. The service's
 * estimate is built on the market observation behind read-v2; this row is built
 * on the `ProviderMetrics` the read-v1 pools route carries, whose `source` is
 * fixed to a different provider (api-contracts/read-v1/types.ts). Same method,
 * different reported TVL and volume, so the two percentages can differ for the
 * same pool. The row says "est." and the pool page says "Est. APR"; neither
 * claims to be the other.
 *
 * What is shared is the arithmetic, taken from `backend/pool_apr.py`:
 *
 *     fixed_lp_fee_x_volume24h_over_reported_tvl_annualized_365
 *
 * and by the producer's arithmetic, `backend/pool_apr.py`:
 *
 *     protocolPips = protocolFeeRaw & 0xfff
 *     lpShare      = currentLpFeePips × (1_000_000 − protocolPips) / 1_000_000
 *     estimate     = volume × lpShare / 1_000_000 × 365 × 100 / tvl
 *
 * Exact integers throughout, rounded once at the end, half away from zero, as
 * `_render` there does — so the same inputs would give the same figure.
 *
 * It refuses wherever the producer refuses and this row can tell: a pool that
 * is not hookless with a fixed fee, a protocol fee that is invalid or differs
 * by direction, a missing or zero TVL, a missing volume, a result too small to
 * show. Refusing is the normal case for a pool no provider reports, and it
 * says which input was missing rather than a bare dash.
 *
 * What it is not: not reconciled, not a position's APR, not APY, not a
 * forecast. The row says so beside it, in the same words the service uses.
 */
import { parseDecimal } from '../decimal'
import type { AttributedFigure } from './figures'
import { protocolFee } from './figures'

/** How many decimal places a row shows. The producer renders 18; a list shows two. */
const PLACES = 2
/** Beyond this the figure is not a figure any more, as the producer's own bound says. */
const MAX_INTEGER_DIGITS = 78

export type RowApr =
  /** `text` is the percentage without its sign, e.g. "16.75"; `stale` when an input was a retained observation. */
  | { kind: 'estimate'; text: string; stale: boolean }
  /** No estimate, and the closed reason why. */
  | { kind: 'none'; reason: RowAprReason }

export type RowAprReason =
  | 'pool_integration_unsupported'
  | 'invalid_protocol_fee'
  | 'protocol_fee_directional_unsupported'
  | 'missing_reported_tvl'
  | 'zero_reported_tvl'
  | 'missing_volume24h'
  /** Ours, not the producer's: it renders 18 places, so its own floor is 10^16 times smaller. */
  | 'estimate_rounds_to_zero'
  | 'estimate_out_of_bounds'

/** The raw decimal behind an attributed figure, or null when it carries none. */
function amount(figure: AttributedFigure): { raw: string; stale: boolean } | null {
  if (figure.state === 'attributed') return { raw: figure.raw, stale: false }
  if (figure.state === 'attributed_stale') return { raw: figure.raw, stale: true }
  return null
}

/** A decimal string as a fraction of integers, exactly. */
function fraction(text: string): { numerator: bigint; denominator: bigint } | null {
  const parsed = parseDecimal(text)
  if (!parsed || parsed.coefficient < 0n) return null
  return { numerator: parsed.coefficient, denominator: 10n ** BigInt(parsed.scale) }
}

/**
 * One rounding step at `PLACES`, half away from zero — `units += remainder * 2 >= denominator`
 * in the producer's `_render`. Banker's rounding was wrong here: it disagrees with
 * the producer on every exact half.
 */
function render(numerator: bigint, denominator: bigint): { text: string } | { reason: RowAprReason } {
  const scaled = numerator * 10n ** BigInt(PLACES)
  let units = scaled / denominator
  if ((scaled % denominator) * 2n >= denominator) units += 1n
  if (units >= 10n ** BigInt(MAX_INTEGER_DIGITS + PLACES)) return { reason: 'estimate_out_of_bounds' }
  // A real zero is a figure and is shown as one; only a positive estimate too
  // small for two places is refused, exactly as the producer refuses at its own.
  if (units === 0n && numerator > 0n) return { reason: 'estimate_rounds_to_zero' }
  const text = units.toString().padStart(PLACES + 1, '0')
  const whole = text.slice(0, -PLACES)
  const places = text.slice(-PLACES).replace(/0+$/, '')
  return { text: places ? `${whole}.${places}` : whole }
}

export interface RowAprInputs {
  /** `'hookless_fixed_fee'` is the only integration the estimate admits. */
  integration: string
  currentLpFeePips: number
  protocolFeeRaw?: number
  /**
   * Added 2026-10-06 (the owner: Base's v3 rows showed TVL and volume but no APR): a v3 pool's `slot0.feeProtocol`, as
   * read-v6 chain-pools reports it ("protocolFee as the pool reports it"). When given, it is the protocol fee the estimate
   * takes and `protocolFeeRaw` is not read: see `v3LpShare`.
   */
  v3FeeProtocol?: number
  liquidity: AttributedFigure
  volume: AttributedFigure
}

/**
 * The share of a v3 pool's LP fee its LPs keep (Added 2026-10-06), from `slot0.feeProtocol` exactly as UniswapV3Pool.swap
 * spends it: the low 4 bits are N for a zero-for-one swap, the high 4 bits N for the other way; 0 is off, otherwise N is 4
 * to 10 and the protocol takes 1/N of the swap's fee (`feeAmount / feeProtocol`), so LPs keep (N − 1)/N. A value outside
 * that is invalid, and two different N are a fee no one figure describes, the same refusals as v4's.
 */
export function v3LpShare(feeProtocol: number): { keep: bigint; of: bigint } | 'invalid' | 'directional' {
  // A whole number from 0 to 255 (`| 0` rather than Number.isInteger: the read screens' source guard admits no Number).
  if ((feeProtocol | 0) !== feeProtocol || feeProtocol < 0 || feeProtocol > 0xff) return 'invalid'
  const valid = (n: number) => n === 0 || (n >= 4 && n <= 10)
  const zeroForOne = feeProtocol & 0x0f
  const oneForZero = feeProtocol >> 4
  if (!valid(zeroForOne) || !valid(oneForZero)) return 'invalid'
  if (zeroForOne !== oneForZero) return 'directional'
  return zeroForOne === 0 ? { keep: 1n, of: 1n } : { keep: BigInt(zeroForOne - 1), of: BigInt(zeroForOne) }
}

/** The share of the LP fee LPs keep: v4's packed fee is taken from the input first (1e6 − pips of 1e6); v3's, see v3LpShare. */
function keptShare(protocolFeeRaw: number | undefined, v3FeeProtocol: number | undefined): { keep: bigint; of: bigint } | RowAprReason {
  if (v3FeeProtocol !== undefined) {
    const share = v3LpShare(v3FeeProtocol)
    if (share === 'invalid') return 'invalid_protocol_fee'
    if (share === 'directional') return 'protocol_fee_directional_unsupported'
    return share
  }
  const fee = protocolFee(protocolFeeRaw ?? 0)
  if (fee.state === 'invalid') return 'invalid_protocol_fee'
  // The producer takes the zero-for-one direction only, so a pool charging
  // differently each way is outside what one figure can describe.
  if (fee.state === 'directional' && fee.zeroForOnePips !== fee.oneForZeroPips) return 'protocol_fee_directional_unsupported'
  return { keep: 1_000_000n - BigInt(fee.state === 'directional' ? fee.zeroForOnePips : 0), of: 1_000_000n }
}

export function rowApr({ integration, currentLpFeePips, protocolFeeRaw, v3FeeProtocol, liquidity, volume }: RowAprInputs): RowApr {
  // A hooked pool or a dynamic fee is not this method's subject at all.
  if (integration !== 'hookless_fixed_fee') return { kind: 'none', reason: 'pool_integration_unsupported' }
  const share = keptShare(protocolFeeRaw, v3FeeProtocol)
  if (typeof share === 'string') return { kind: 'none', reason: share }
  const tvl = amount(liquidity)
  if (!tvl) return { kind: 'none', reason: 'missing_reported_tvl' }
  const day = amount(volume)
  if (!day) return { kind: 'none', reason: 'missing_volume24h' }
  const tvlParts = fraction(tvl.raw)
  const volumeParts = fraction(day.raw)
  if (!tvlParts || !volumeParts) return { kind: 'none', reason: 'missing_reported_tvl' }
  if (tvlParts.numerator === 0n) return { kind: 'none', reason: 'zero_reported_tvl' }

  // volume × lpFeePips × kept share × 365 × 100 / (1e6 × tvl); for v4 the kept share is (1e6 − protocolPips) / 1e6, as before
  const numerator = volumeParts.numerator * tvlParts.denominator * BigInt(currentLpFeePips) * share.keep * 365n * 100n
  const denominator = volumeParts.denominator * tvlParts.numerator * 1_000_000n * share.of
  const rendered = render(numerator, denominator)
  if ('reason' in rendered) return { kind: 'none', reason: rendered.reason }
  return { kind: 'estimate', text: rendered.text, stale: tvl.stale || day.stale }
}

/** Why a row shows no estimate, in our own words, for the figure's title. */
export const rowAprReasonText = (reason: RowAprReason): string =>
  ({
    pool_integration_unsupported: 'This pool has hooks or a dynamic fee, which this estimate does not describe.',
    invalid_protocol_fee: 'The pool’s protocol fee could not be read.',
    protocol_fee_directional_unsupported: 'This pool charges a different protocol fee each way, which one figure cannot describe.',
    missing_reported_tvl: 'No market data provider reports liquidity for this pool.',
    zero_reported_tvl: 'The reported liquidity for this pool is zero.',
    missing_volume24h: 'No market data provider reports 24h volume for this pool.',
    estimate_rounds_to_zero: 'The estimate is below 0.01%, which two decimal places cannot show.',
    estimate_out_of_bounds: 'The estimate is too large to be a figure.',
  })[reason]
