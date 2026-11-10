/**
 * A position NFT as the positions screens draw it: its pool, fee, range (as
 * prices where they can be written), principal and unclaimed fees, and its
 * owner, all public chain data at one block.
 *
 * Since 2026-09-24 every card comes from chain through the site's own
 * endpoints (lib/walletCards.ts: the wallet's list from POST
 * /api/owned/v2/positions, a position's page from /api/fees/v1/state): the
 * lookup by typed NFT ids and its nft-positions reads are gone. A card never
 * says the viewer controls it and carries no USD field; the screens value a
 * pair with USDG themselves. Nothing here is stored.
 */
import { formatUnits } from '../decimal'
import { priceInverted } from '../orientation'
import type { TokenDisplay } from '../types'
import { DYNAMIC_FEE_PIPS } from './fee'
import { tokenAmount } from './figures'
import { NATIVE_CURRENCY, type AddressKey, type PoolIdKey } from './identity'
// poolRange imports tickPriceText from here; the cycle is safe because
// neither module calls the other while it loads, only from inside functions.
import { shownPosition, shownRange, shownTick, tickAgrees, tickPriceIn, usableTicks, type PriceProblem } from './poolRange'
import { numberFormat } from '../../format/numberFormat'

const UINT256 = 2n ** 256n

export interface AmountView {
  raw: string
  /**
   * What a card shows: the amount in the token's units to six significant
   * digits (never fewer than its whole part, never an exponent), as the pool
   * page's activity card writes amounts; "0"; or, when the token's decimals
   * are not known, the raw integer, which a card never shows as units.
   */
  text: string
  /** The amount in the token's units, every digit, for a title; null when the decimals are not known. */
  exact: string | null
  /** `unread`: the chain gave no figure (the pool's price, or the fee growth, could not be read): a dash, and `raw` is ''. */
  kind: 'units' | 'raw' | 'zero' | 'unread'
  token: TokenDisplay
}

export type CardKey = `4663:nft:${string}`

export type ChainPositionCard =
  | { origin: 'chain'; kind: 'empty'; key: CardKey; tokenId: string }
  | {
      origin: 'chain'
      kind: 'live'
      key: CardKey
      tokenId: string
      poolId: PoolIdKey
      positionManager: AddressKey
      currencies: [TokenDisplay, TokenDisplay]
      fee: string
      /** The pool key's fee in pips; DYNAMIC_FEE_PIPS for a dynamic-fee pool, whose fee a hook sets. */
      feePips: number
      tickSpacing: number
      hooks: AddressKey
      range: {
        tickLower: number
        tickUpper: number
        /** Both ends at the pool's usable tick limits: the position covers every price the pool can have. */
        fullRange: boolean
        ends: { lower: RangeEnd; upper: RangeEnd }
        /** Both ends written as prices or limits ('0', '∞'); null when either end is written as its tick. */
        prices: { lower: string; upper: string } | null
      }
      /** Whether the pool's tick was inside the range at the card's block (v4's rule: the upper tick is outside). */
      inRange: boolean
      hasLiquidity: boolean
      /** The position's liquidity at the card's block, a decimal integer: for display and for the owner's actions, which read it again on chain. */
      liquidityRaw: string
      principal: [AmountView, AmountView]
      unsettledFees: [AmountView, AmountView]
      /** The NFT's owner (ownerOf) at the card's block. The core owner is the position manager and is never shown as an owner. */
      owner: { address: AddressKey; basis: 'ownerOf_at_pinned_block' }
      valuation: { state: 'unavailable'; reason: 'no_qualified_price_source' }
    }

/**
 * 1.0001^tick × 10^(dec0 − dec1): currency1 per currency0, never an exponent (priceDigits). Null past 10^24 or under
 * 10^−24. Changed on purpose 2026-09-28 (one-sided): the floor was 10^−12, and the app now writes many pools the other
 * way round (lib/read/orientation.ts, the same tick with its decimals swapped and negated), so the floor mirrors the
 * ceiling: a price the pages could write one way round, they can write the other way round too.
 */
export function tickPriceText(tick: number, decimals0: number, decimals1: number): string | null {
  const value = Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1)
  if (!isFinite(value) || value < 1e-24 || value > 1e24) return null
  return `≈${priceDigits(value)}`
}

/**
 * A price's digits, by the rule V2's Review and the position pages write prices with (v2/plan/present.ts priceText;
 * changed on purpose 2026-10-30, QA round 2, N2: range labels read "1,590.87" beside "3,411.8"): from 1,000 up, exactly
 * two decimals ("3,411.80"); from 1 to 1,000, six significant digits with at least two decimals ("3.40", "1.00045");
 * below 1, six significant digits as before ("0.000697689"). From a billion up the price keeps its six significant
 * digits ("994,018,000,000"), as before: two decimals there would print digits the number does not hold, and the
 * position chart writes it in billions anyway (lib/chart/priceFacts.ts readablePrice). Exported for the Markets price
 * (lib/read/marketPrice.ts plainAmount), so a pool's price reads the same on Markets, Home and its own page.
 */
export function priceDigits(value: number): string {
  if (value >= 1000 && value < 1e9) return numberFormat({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
  const text = numberFormat({ maximumSignificantDigits: 6 }).format(value)
  if (value < 1 || value >= 1e9) return text
  const point = text.indexOf('.')
  return point === -1 ? `${text}.00` : text.length - point - 1 < 2 ? `${text}0` : text
}

/** One end of a position's range as a card writes it. */
export type RangeEnd =
  /** At the pool's usable tick limit on that side: every price below (0) or above (∞). Needs no decimals. */
  | { kind: 'limit'; text: '0' | '∞' }
  /** 1.0001^tick in display units, from tickPriceText. */
  | { kind: 'price'; text: string }
  /** Written as its tick, and why. */
  | { kind: 'tick'; problem: Extract<PriceProblem, 'decimals_unknown' | 'beyond_display'> }

/**
 * One end of a range, on its own. An end at the pool's usable tick limit on
 * its side covers every price the pool can have there, so it is 0 or ∞ and
 * needs no decimals (Uniswap's own Min 0 / Max ∞). Any other end is a price
 * when both decimals are known and the price can be written as a plain
 * number; otherwise its tick, with the reason.
 */
export function rangeEnd(tick: number, side: 'lower' | 'upper', tickSpacing: number, decimals0: number | null, decimals1: number | null): RangeEnd {
  const { min, max } = usableTicks(tickSpacing)
  if (side === 'lower' && tick <= min) return { kind: 'limit', text: '0' }
  if (side === 'upper' && tick >= max) return { kind: 'limit', text: '∞' }
  if (decimals0 === null || decimals1 === null) return { kind: 'tick', problem: 'decimals_unknown' }
  const text = tickPriceText(tick, decimals0, decimals1)
  return text === null ? { kind: 'tick', problem: 'beyond_display' } : { kind: 'price', text }
}

/**
 * A card's range as the page writes it (the app's one way round, lib/read/orientation.ts, 2026-09-28): the token its
 * prices are for (`base`) and the one they are in (`quote`), and the range's lowest and highest price of `base`, each
 * with the pool tick it is at. A pool whose first currency is USDG or ETH is read the other way round from its own
 * order: its upper tick is then the range's lowest price, and the end at the pool's upper tick limit is 0.
 */
export interface ShownCardRange {
  base: TokenDisplay
  quote: TokenDisplay
  inverted: boolean
  low: { end: RangeEnd; tick: number }
  high: { end: RangeEnd; tick: number }
  /** The range's two ends in the page's frame (poolRange.ts shownRange): a higher tick is a higher price of `base`. */
  ticks: { lower: number; upper: number }
}

export function shownCardRange(card: Pick<Extract<ChainPositionCard, { kind: 'live' }>, 'currencies' | 'range' | 'tickSpacing'>): ShownCardRange {
  const [currency0, currency1] = card.currencies
  const inverted = priceInverted(currency0.address, currency1.address)
  const { tickLower, tickUpper } = card.range
  const ticks = shownRange({ lower: tickLower, upper: tickUpper }, inverted)
  if (!inverted) return { base: currency0, quote: currency1, inverted, low: { end: card.range.ends.lower, tick: tickLower }, high: { end: card.range.ends.upper, tick: tickUpper }, ticks }
  const [dBase, dQuote] = [decimalsOf(currency1), decimalsOf(currency0)]
  return {
    base: currency1,
    quote: currency0,
    inverted,
    low: { end: rangeEnd(ticks.lower, 'lower', card.tickSpacing, dBase, dQuote), tick: tickUpper },
    high: { end: rangeEnd(ticks.upper, 'upper', card.tickSpacing, dBase, dQuote), tick: tickLower },
    ticks,
  }
}

/** Why a card writes a range end as a tick, or null. An unread decimal comes first: it is the one a reader can act on. */
export function rangePricesProblem(range: { ends: { lower: RangeEnd; upper: RangeEnd } }): 'decimals_unknown' | 'beyond_display' | null {
  const problems = [range.ends.lower, range.ends.upper].flatMap((end) => (end.kind === 'tick' ? [end.problem] : []))
  return problems.includes('decimals_unknown') ? 'decimals_unknown' : (problems[0] ?? null)
}

/** A raw amount as a card shows it, bound to its token by address; null for an amount the chain did not give. */
export function amountView(raw: string | null, token: TokenDisplay): AmountView {
  if (raw === null) return { raw: '', text: '—', exact: null, kind: 'unread', token }
  if (raw === '0') return { raw, text: '0', exact: '0', kind: 'zero', token }
  // The activity card's own rule, bound to this token by its address: six significant digits, and every digit for the title.
  const shown = tokenAmount(raw, token.address, [token])
  if (shown.text === null || shown.exact === null) return { raw, text: formatUnits(raw, null)?.text ?? raw, exact: null, kind: 'raw', token }
  return { raw, text: shown.text, exact: shown.exact, kind: 'units', token }
}

/**
 * Whether Domino's setup contract can open a position in a card's pool: no
 * hooks and a fixed fee, the rule New position applies to every pool it lists
 * or opens by a link (poolsList.ts usableForDomino, optionUsableForDomino).
 * DominoSetup.open reverts on any other pool, so nothing links a card's pool
 * into New position unless this holds.
 */
export const cardPoolUsableForDomino = (card: { hooks: string; feePips: number }) => card.hooks === NATIVE_CURRENCY && card.feePips !== DYNAMIC_FEE_PIPS

export const isNative = (address: string) => address.toLowerCase() === NATIVE_CURRENCY

// ---------------------------------------------------------------------------
// Route parameters: what a shareable link carries, and nothing else
// ---------------------------------------------------------------------------

/** The route part of a hash, without the in-page section after a second `#`. */
const routeSegments = (hash: string): [first: string, second: string] => {
  const raw = hash.replace(/^#/, '')
  const cut = raw.indexOf('#')
  const route = cut === -1 ? raw : raw.slice(0, cut)
  const [, first = '', second = ''] = route.split('/')
  return [first, second]
}

const decodeSegment = (segment: string) => {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/**
 * The one NFT a `#/positions/<id>` link opens as its own page: the route's
 * second segment when it is exactly one canonical decimal id below 2^256 (no
 * sign, no leading zero, no comma, no space). Anything else is null and opens
 * the list: there is no lookup by typed ids any more (2026-09-24).
 */
export function positionDetailId(segment: string): string | null {
  const id = decodeSegment(segment)
  if (!/^[1-9]\d{0,77}$/.test(id) || BigInt(id) >= UINT256) return null
  return id
}

export type PortfolioRoute = { onRoute: false } | { onRoute: true; address: string }

/** `#/portfolio/<address>`: a pasted public address, as typed and not yet validated. */
export function portfolioRoute(hash: string): PortfolioRoute {
  const [first, second] = routeSegments(hash)
  if (first !== 'portfolio') return { onRoute: false }
  return { onRoute: true, address: decodeSegment(second) }
}

export const portfolioHash = (address: string | null) => (address ? `/portfolio/${address}` : '/portfolio')

// ---------------------------------------------------------------------------
// The range bar: a log price axis, in ticks
// ---------------------------------------------------------------------------

/** How much of the range's own width is drawn on each side of it. */
export const RANGE_BAR_PADDING = 0.25

export interface RangeBarScale {
  /** 0 to 1 across the drawn width. */
  lower: number
  upper: number
  /** 0 to 1, clamped to the drawn width, or null when no current tick was given. */
  current: number | null
  /** Set when the current tick had to be clamped: it lies beyond the drawn axis on that side. */
  currentBeyond: 'below' | 'above' | null
}

/**
 * Where a range and, when known, the pool's tick sit on the bar.
 *
 * Ticks are a log price axis already (price = 1.0001^tick, so equal tick
 * distances are equal price ratios), which is the axis Uniswap draws ranges
 * on: a range from 0.5× to 2× the price is centred on it. The drawn axis is
 * the range widened by `padding` of its own width on each side, so the band
 * never touches the edges and a price a little outside the range still lands
 * inside the drawing; one far outside is clamped to the edge and said so.
 */
export function rangeBarScale(tickLower: number, tickUpper: number, currentTick: number | null, padding = RANGE_BAR_PADDING): RangeBarScale {
  const width = Math.max(1, tickUpper - tickLower)
  const axisMin = tickLower - width * padding
  const axisMax = tickUpper + width * padding
  const at = (tick: number) => (tick - axisMin) / (axisMax - axisMin)
  const lower = at(tickLower)
  const upper = at(tickUpper)
  if (currentTick === null) return { lower, upper, current: null, currentBeyond: null }
  const raw = at(currentTick)
  return { lower, upper, current: Math.min(1, Math.max(0, raw)), currentBeyond: raw < 0 ? 'below' : raw > 1 ? 'above' : null }
}

// ---------------------------------------------------------------------------
// The pool's price, from the chain read the card came from
// ---------------------------------------------------------------------------

export type CardPoolPriceProblem = PriceProblem

export type CardPoolPrice =
  | { state: 'unavailable'; problem: CardPoolPriceProblem; block: number }
  | {
      state: 'usable'
      /** The block of the read the price is from: the card's own. */
      block: number
      /** The pool's own tick. */
      tick: number
      /**
       * The price as the page writes it, the app's one way round (lib/read/orientation.ts, 2026-09-28): `base` in `quote`
       * of shownCardRange, written with the card's decimals, six significant digits, never an exponent.
       */
      text: string
      /** Where the price sits against the card's range, as the page reads it: `below` it means the range is above today's price. */
      position: 'inside' | 'below' | 'above'
      /** The page reads the pool the other way round from its own order (currency1 priced in currency0). */
      inverted: boolean
    }

const decimalsOf = (token: TokenDisplay) => (token.origin === 'read' ? token.decimals : null)

/**
 * The pool's price at `block`, from the square-root price and tick the same
 * chain read gave with the card: checked exactly as poolRange.ts checks a
 * pool's price (the tick must agree with the square root), and written with
 * the card's decimals. Unavailable, with the reason, otherwise.
 */
export function chainPoolPrice(card: Extract<ChainPositionCard, { kind: 'live' }>, price: { sqrtPriceX96: string | null; tick: number | null; block: number }): CardPoolPrice {
  const { block } = price
  if (price.sqrtPriceX96 === null || price.tick === null) return { state: 'unavailable', problem: 'not_initialized', block }
  let sqrt: bigint
  try {
    sqrt = BigInt(price.sqrtPriceX96)
  } catch {
    return { state: 'unavailable', problem: 'tick_mismatch', block }
  }
  if (sqrt === 0n) return { state: 'unavailable', problem: 'not_initialized', block }
  if (!tickAgrees(price.tick, sqrt)) return { state: 'unavailable', problem: 'tick_mismatch', block }
  const d0 = decimalsOf(card.currencies[0])
  const d1 = decimalsOf(card.currencies[1])
  if (d0 === null || d1 === null) return { state: 'unavailable', problem: 'decimals_unknown', block }
  const inverted = priceInverted(card.currencies[0].address, card.currencies[1].address)
  const text = tickPriceIn(price.tick, [d0, d1], inverted)
  if (text === null) return { state: 'unavailable', problem: 'beyond_display', block }
  const position = shownPosition({ lower: card.range.tickLower, upper: card.range.tickUpper }, { tick: price.tick, inverted })
  return { state: 'usable', block, tick: price.tick, text, position, inverted }
}

/** The pool's tick in the page's frame of a card's price (shownCardRange's `ticks`): a higher tick is a higher price of `base`. */
export const shownCardTick = (price: { tick: number; inverted: boolean }) => shownTick(price.tick, price.inverted)
