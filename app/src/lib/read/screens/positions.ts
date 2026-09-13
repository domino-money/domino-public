/**
 * Issue #2: position NFTs read from chain, as cards.
 *
 * A card is public data about one NFT at one block: which pool, which range,
 * what principal and unsettled fees the position holds, and who owned the NFT
 * at that block. It never says the viewer owns or controls it, carries no USD
 * value (there is no qualified price source yet), and has no path into the
 * anything the app keeps: no field here is stored, and nothing is saved.
 *
 * Reads happen only when someone asks: one nft-positions read for up to 10
 * typed IDs, then one token read per distinct currency (at most 8) so amounts
 * and range prices can be written in display units. A reply that does not
 * answer every ID asked for is refused as a whole.
 */
import type { Freshness, LiveNft, NftPositionsResponse, PoolMarketResponse, Snapshot } from 'api-contracts/read-v1/types'
import type { Clock } from '../pipeline'
import { formatUnits } from '../decimal'
import { tokenDisplay, unreadToken } from '../project'
import type { ReadSource, TokenDisplay } from '../types'
import { feeLabel } from './fee'
import { NATIVE_CURRENCY, addressKey, poolIdKey, type AddressKey, type PoolIdKey } from './identity'
// poolRange imports tickPriceText from here; the cycle is safe because
// neither module calls the other while it loads, only from inside functions.
import { rangePosition, tickAgrees, type PriceProblem } from './poolRange'
import { readWithin, type ScreenOutcome } from './screenRead'

export const MAX_TOKEN_IDS = 10
export const MAX_TOKEN_READS_PER_LOOKUP = 8
const UINT256 = 2n ** 256n

export type IdsProblem = 'empty' | 'not_decimal' | 'leading_zero' | 'too_large' | 'duplicate' | 'too_many'

/** Typed IDs: canonical decimals below 2^256, unique, 1 to 10, separated by commas or white space. */
export function parseTokenIdsInput(text: string): { ok: true; ids: string[] } | { ok: false; reason: IdsProblem } {
  const parts = text.split(/[\s,]+/).filter((part) => part !== '')
  if (parts.length === 0) return { ok: false, reason: 'empty' }
  if (parts.length > MAX_TOKEN_IDS) return { ok: false, reason: 'too_many' }
  const seen = new Set<string>()
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return { ok: false, reason: 'not_decimal' }
    if (part.length > 1 && part.startsWith('0')) return { ok: false, reason: 'leading_zero' }
    if (part.length > 78 || BigInt(part) >= UINT256) return { ok: false, reason: 'too_large' }
    if (seen.has(part)) return { ok: false, reason: 'duplicate' }
    seen.add(part)
  }
  return { ok: true, ids: parts }
}

export interface AmountView {
  raw: string
  /** Display units when the token's decimals are known, otherwise the raw integer. */
  text: string
  kind: 'units' | 'raw' | 'zero'
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
      tickSpacing: number
      hooks: AddressKey
      range: { tickLower: number; tickUpper: number; prices: { lower: string; upper: string } | null }
      /** The producer's own answer at the snapshot, never recomputed here. */
      inRange: boolean
      hasLiquidity: boolean
      principal: [AmountView, AmountView]
      unsettledFees: [AmountView, AmountView]
      /** `items[].owner`. The core owner is the position manager and is never shown as an owner. */
      owner: { address: AddressKey; basis: 'ownerOf_at_pinned_block' }
      valuation: { state: 'unavailable'; reason: 'no_qualified_price_source' }
    }

export interface Batch {
  ids: string[]
  cards: ChainPositionCard[]
  block: Snapshot
  freshness: Freshness
  /** Currencies whose token details could not be read, or were beyond the cap. */
  tokenProblems: number
  tokenCapped: boolean
}

/** 1.0001^tick × 10^(dec0 − dec1): currency1 per currency0, to six significant digits, never an exponent. */
export function tickPriceText(tick: number, decimals0: number, decimals1: number): string | null {
  const value = Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1)
  if (!isFinite(value) || value < 1e-12 || value > 1e24) return null
  return `≈${new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 }).format(value)}`
}

function amount(raw: string, token: TokenDisplay): AmountView {
  if (raw === '0') return { raw, text: '0', kind: 'zero', token }
  const units = formatUnits(raw, token.origin === 'read' ? token.decimals : null)
  if (units === null) return { raw, text: raw, kind: 'raw', token }
  return { raw, text: units.text, kind: units.kind === 'units' ? 'units' : 'raw', token }
}

/** The distinct currencies whose details a batch needs, in order, and how many fall beyond the cap. */
export function tokensNeeded(data: NftPositionsResponse): { reads: AddressKey[]; skipped: number } {
  const all: AddressKey[] = []
  for (const item of data.items) {
    if (item.status !== 'owner_verified_at_snapshot') continue
    for (const currency of [item.poolKey.currency0, item.poolKey.currency1]) {
      const key = addressKey(currency)
      if (!all.includes(key)) all.push(key)
    }
  }
  return { reads: all.slice(0, MAX_TOKEN_READS_PER_LOOKUP), skipped: Math.max(0, all.length - MAX_TOKEN_READS_PER_LOOKUP) }
}

/** Every requested ID answered, and nothing else. */
export function answersEveryId(requested: readonly string[], data: NftPositionsResponse): boolean {
  const returned = data.items.map((item) => item.tokenId)
  return returned.length === requested.length && new Set(returned).size === returned.length && returned.every((id) => requested.includes(id))
}

function liveCard(item: LiveNft, tokens: ReadonlyMap<string, TokenDisplay>): ChainPositionCard {
  const token = (address: string) => tokens.get(address.toLowerCase()) ?? unreadToken(address)
  const base = token(item.poolKey.currency0)
  const quote = token(item.poolKey.currency1)
  const d0 = base.origin === 'read' ? base.decimals : null
  const d1 = quote.origin === 'read' ? quote.decimals : null
  let prices: { lower: string; upper: string } | null = null
  if (d0 !== null && d1 !== null) {
    const lower = tickPriceText(item.tickLower, d0, d1)
    const upper = tickPriceText(item.tickUpper, d0, d1)
    prices = lower && upper ? { lower, upper } : null
  }
  return {
    origin: 'chain',
    kind: 'live',
    key: `4663:nft:${item.tokenId}`,
    tokenId: item.tokenId,
    poolId: poolIdKey(item.poolId),
    positionManager: addressKey(item.positionManager),
    currencies: [base, quote],
    fee: feeLabel(item.poolKey),
    tickSpacing: item.poolKey.tick_spacing,
    hooks: addressKey(item.poolKey.hooks),
    range: { tickLower: item.tickLower, tickUpper: item.tickUpper, prices },
    inRange: item.inRange,
    hasLiquidity: item.hasLiquidity,
    principal: [amount(item.principalRaw[0], base), amount(item.principalRaw[1], quote)],
    unsettledFees: [amount(item.unsettledFeesRaw[0], base), amount(item.unsettledFeesRaw[1], quote)],
    owner: { address: addressKey(item.owner), basis: item.ownershipBasis },
    valuation: { state: 'unavailable', reason: 'no_qualified_price_source' },
  }
}

/** Cards in the order asked for. Fails closed unless the reply answers exactly the IDs requested. */
export function projectNftBatch(
  requested: readonly string[],
  data: NftPositionsResponse,
  tokens: ReadonlyMap<string, TokenDisplay>,
  problems: { tokenProblems: number; tokenCapped: boolean } = { tokenProblems: 0, tokenCapped: false },
): { ok: true; batch: Batch } | { ok: false; reason: 'incomplete_reply' } {
  if (!answersEveryId(requested, data)) return { ok: false, reason: 'incomplete_reply' }
  const byId = new Map(data.items.map((item) => [item.tokenId, item]))
  const cards = requested.map((id): ChainPositionCard => {
    const item = byId.get(id) as NftPositionsResponse['items'][number]
    if (item.status === 'position_info_empty_at_snapshot') return { origin: 'chain', kind: 'empty', key: `4663:nft:${id}`, tokenId: id }
    return liveCard(item, tokens)
  })
  return { ok: true, batch: { ids: [...requested], cards, block: { ...data.snapshot }, freshness: { ...data.freshness }, ...problems } }
}

export type LookupFailure = Exclude<ScreenOutcome<'nft-positions'>, { state: 'ok' | 'aborted' }> | { state: 'incomplete_reply' }
export type LookupResult = { kind: 'ok'; batch: Batch } | { kind: 'failed'; failure: LookupFailure } | { kind: 'aborted' }

/**
 * One lookup: the NFT read, then the token reads, all on one signal. A new
 * lookup aborts the old signal, which ends whichever of its reads is waiting.
 * The request is always `{ tokenIds }`: no pinned block, so no pin can go stale.
 */
export async function runLookup(source: ReadSource, ids: string[], options: { signal: AbortSignal; clock?: Clock }): Promise<LookupResult> {
  const nft = await readWithin(source, 'nft-positions', { tokenIds: [...ids] }, options)
  if (nft.state === 'aborted') return { kind: 'aborted' }
  if (nft.state !== 'ok') return { kind: 'failed', failure: nft }
  if (!answersEveryId(ids, nft.data)) return { kind: 'failed', failure: { state: 'incomplete_reply' } }
  const { reads, skipped } = tokensNeeded(nft.data)
  const tokens = new Map<string, TokenDisplay>()
  let tokenProblems = skipped
  for (const address of reads) {
    const read = await readWithin(source, 'token', { token: address }, options)
    if (read.state === 'aborted') return { kind: 'aborted' }
    if (read.state === 'ok') tokens.set(address, tokenDisplay(read.data.asset))
    else tokenProblems += 1
  }
  const projected = projectNftBatch(ids, nft.data, tokens, { tokenProblems, tokenCapped: skipped > 0 })
  return projected.ok ? { kind: 'ok', batch: projected.batch } : { kind: 'failed', failure: { state: 'incomplete_reply' } }
}

export const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id) => b.includes(id))

/**
 * A lookup of the IDs already being read is the same question: it joins the
 * read in flight instead of cancelling it and asking again. Only different
 * IDs start a new read (and cancel the old one).
 */
export const joinsRunningLookup = (state: LookupState, ids: readonly string[]) => state.phase === 'loading' && sameIds(state.ids, ids)

export interface LookupRunner {
  /**
   * Looks up `ids`: joins the read in flight when it is for the same IDs
   * (and returns false), otherwise cancels it and starts a new one.
   */
  start(state: LookupState, ids: string[]): boolean
  /** Cancels whatever is running. Its result, if it comes, is dropped as aborted. */
  cancel(): void
}

/**
 * What the lookup section does with a click, outside React so node tests run
 * the section's own rule: one abort controller at a time, a new request id per
 * started lookup, and the same IDs joined rather than read twice.
 */
export function createLookupRunner(source: ReadSource, dispatch: (event: LookupEvent) => void, run: typeof runLookup = runLookup): LookupRunner {
  let running: AbortController | null = null
  let counter = 0
  return {
    start(state, ids) {
      if (running && joinsRunningLookup(state, ids)) return false
      running?.abort()
      const mine = new AbortController()
      running = mine
      counter += 1
      const requestId = counter
      dispatch({ type: 'submit', requestId, ids })
      void run(source, ids, { signal: mine.signal }).then((result) => {
        if (running === mine) running = null
        dispatch({ type: 'result', requestId, result })
      })
      return true
    },
    cancel() {
      running?.abort()
      running = null
    },
  }
}

type Settled =
  | { phase: 'idle' }
  | { phase: 'ready'; requestId: number; ids: string[]; batch: Batch }
  | { phase: 'failed'; requestId: number; ids: string[]; failure: LookupFailure; retained: Batch | null }

export type LookupState = Settled | { phase: 'loading'; requestId: number; ids: string[]; retained: Batch | null; before: Settled }

export type LookupEvent =
  /** Look up, Refresh and Retry each take a new request id. */
  | { type: 'submit'; requestId: number; ids: string[] }
  | { type: 'result'; requestId: number; result: LookupResult }
  /** Hiding the lookup while it reads. */
  | { type: 'cancel'; requestId: number }
  | { type: 'clear' }

const shownBatch = (state: LookupState): Batch | null =>
  state.phase === 'ready' ? state.batch : state.phase === 'failed' || state.phase === 'loading' ? state.retained : null

/**
 * The lookup's state. Only the latest request's result lands; any other is
 * dropped, so a slow first answer can never overwrite a later one. Earlier
 * cards stay through a failed refresh of the same IDs, with their own block
 * and time, and are dropped when the IDs change.
 */
export function lookupReducer(state: LookupState, event: LookupEvent): LookupState {
  switch (event.type) {
    case 'submit': {
      const before: Settled = state.phase === 'loading' ? state.before : state
      const previous = shownBatch(state)
      const retained = previous && sameIds(previous.ids, event.ids) ? previous : null
      return { phase: 'loading', requestId: event.requestId, ids: [...event.ids], retained, before }
    }
    case 'result': {
      if (state.phase !== 'loading' || state.requestId !== event.requestId) return state
      const { result } = event
      if (result.kind === 'aborted') return state.before
      if (result.kind === 'ok') return { phase: 'ready', requestId: state.requestId, ids: state.ids, batch: result.batch }
      return { phase: 'failed', requestId: state.requestId, ids: state.ids, failure: result.failure, retained: state.retained }
    }
    case 'cancel':
      return state.phase === 'loading' && state.requestId === event.requestId ? state.before : state
    case 'clear':
      return { phase: 'idle' }
    default:
      return event satisfies never
  }
}

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

export type PositionsRoute = { onRoute: false } | { onRoute: true; ids: string }

/**
 * `#/positions/<ids>` (or the older `#/app/<ids>`): the NFT ids a link
 * carries, as typed and not yet validated. Nothing else is read from the
 * hash and nothing is stored: the link is the whole state.
 */
export function positionsRoute(hash: string): PositionsRoute {
  const [first, second] = routeSegments(hash)
  if (first !== 'positions' && first !== 'app') return { onRoute: false }
  return { onRoute: true, ids: decodeSegment(second) }
}

/** The hash that carries these ids, so a card set can be shared as a link. */
export const positionsHash = (ids: readonly string[]) => (ids.length === 0 ? '#/positions' : `#/positions/${ids.join(',')}`)

export type PortfolioRoute = { onRoute: false } | { onRoute: true; address: string }

/** `#/portfolio/<address>`: a pasted public address, as typed and not yet validated. */
export function portfolioRoute(hash: string): PortfolioRoute {
  const [first, second] = routeSegments(hash)
  if (first !== 'portfolio') return { onRoute: false }
  return { onRoute: true, address: decodeSegment(second) }
}

export const portfolioHash = (address: string | null) => (address ? `#/portfolio/${address}` : '#/portfolio')

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
// The pool's price, read on demand for one card
// ---------------------------------------------------------------------------

export type CardPoolPriceProblem = PriceProblem | 'pool_mismatch'

export type CardPoolPrice =
  | { state: 'unavailable'; problem: CardPoolPriceProblem; block: number }
  | {
      state: 'usable'
      /** The price read's own block, which is not the card's. */
      block: number
      tick: number
      /** currency1 per currency0, written with the card's decimals: six significant digits, never an exponent. */
      text: string
      /** Where that tick sits against the card's range, at the price read's block. */
      position: 'inside' | 'below' | 'above'
    }

const decimalsOf = (token: TokenDisplay) => (token.origin === 'read' ? token.decimals : null)

/**
 * The pool's price from a pool-market read made for one card: the verified
 * pool's tick and square-root price at that read's block, checked exactly as
 * poolRange.ts checks a pool's price, and written with the card's decimals.
 * A reply about another pool, or one whose currencies are not the card's,
 * shows nothing. The block is the read's own and is always shown beside it.
 */
export function cardPoolPrice(card: Extract<ChainPositionCard, { kind: 'live' }>, data: PoolMarketResponse): CardPoolPrice {
  const pool = data.pool
  const block = pool.snapshot.number
  const sameCurrencies = pool.currencies.length === 2 && pool.currencies.every((currency, i) => currency.toLowerCase() === card.currencies[i].address)
  if (pool.poolId.toLowerCase() !== card.poolId || !sameCurrencies) return { state: 'unavailable', problem: 'pool_mismatch', block }
  let sqrt: bigint
  try {
    sqrt = BigInt(pool.sqrtPriceX96)
  } catch {
    return { state: 'unavailable', problem: 'tick_mismatch', block }
  }
  if (sqrt === 0n) return { state: 'unavailable', problem: 'not_initialized', block }
  if (!tickAgrees(pool.tick, sqrt)) return { state: 'unavailable', problem: 'tick_mismatch', block }
  const d0 = decimalsOf(card.currencies[0])
  const d1 = decimalsOf(card.currencies[1])
  if (d0 === null || d1 === null) return { state: 'unavailable', problem: 'decimals_unknown', block }
  const text = tickPriceText(pool.tick, d0, d1)
  if (text === null) return { state: 'unavailable', problem: 'beyond_display', block }
  return { state: 'usable', block, tick: pool.tick, text, position: rangePosition({ lower: card.range.tickLower, upper: card.range.tickUpper }, pool.tick) }
}
