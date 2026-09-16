/**
 * Issue #13: provider figures, attributed.
 *
 * A provider figure is shown with who reported it and when it was retrieved,
 * as the payload says, and nothing more: never as current, qualified or
 * reconciled. Only pool-metrics with `usableAsCurrent24h` makes a figure
 * qualified, and that decision stays in slice A's projection. Times come only
 * from the payload, never from this browser's clock, so the same reply reads
 * the same everywhere. GeckoTerminal (pool-market) and DexScreener (pools)
 * are different providers and are never combined.
 */
import type { PoolActivityResponse, PoolMarketResponse, PoolPositionsResponse, ProviderMetrics } from 'api-contracts/read-v1/types'
import { formatUnits, formatUsdCompact, parseDecimal, toFixed } from '../decimal'
import { reasonText } from '../describe'
import type { TokenDisplay } from '../types'
import { presentMetric, turnover, type Instant, type Market, type Metric, type Presented } from '../../markets'
import { fixedFeePercent } from './fee'

export type ProviderId = 'geckoterminal' | 'dexscreener'

export const PROVIDER_NAME: Record<ProviderId, string> = { geckoterminal: 'GeckoTerminal', dexscreener: 'DexScreener' }

export type AttributedFigure =
  | { state: 'attributed'; value: string; zero: boolean; provider: ProviderId; retrievedAt: number; cacheAgeSeconds: number | null }
  | { state: 'attributed_stale'; value: string; zero: boolean; provider: ProviderId; retrievedAt: number; cacheAgeSeconds: number | null; refreshReason: string | null }
  | { state: 'not_reported'; provider: ProviderId }
  | { state: 'unavailable'; provider: ProviderId; reason: string }
  | { state: 'rejected'; provider: ProviderId; reason: string }

function valued(text: string): { value: string; zero: boolean } | null {
  const parsed = parseDecimal(text)
  const value = formatUsdCompact(text)
  return parsed && value ? { value, zero: parsed.coefficient === 0n } : null
}

/** DexScreener figures on a pools-route candidate. Always null in the catalogue route. */
export function figureFromProviderMetrics(metrics: ProviderMetrics | null, pick: 'liquidity' | 'volume', conflict: boolean): AttributedFigure {
  const provider = 'dexscreener' as const
  if (metrics === null) return { state: 'unavailable', provider, reason: 'no_provider_figures' }
  if (conflict) return { state: 'rejected', provider, reason: 'provider_currency_mismatch' }
  const raw = pick === 'liquidity' ? metrics.reportedLiquidityUsd : metrics.volume24hUsd
  if (raw === null) return { state: 'not_reported', provider }
  const v = valued(raw)
  if (!v) return { state: 'unavailable', provider, reason: 'invalid_quantity' }
  return { state: 'attributed', ...v, provider, retrievedAt: metrics.retrievedAt, cacheAgeSeconds: null }
}

/** GeckoTerminal figures from pool-market. The envelope's status decides, never a non-null cache age. */
export function figureFromMarket(market: PoolMarketResponse['market'], pick: 'liquidity' | 'volume'): AttributedFigure {
  const provider = 'geckoterminal' as const
  if (market.status === 'rejected') return { state: 'rejected', provider, reason: market.reason }
  if (market.status === 'unavailable' || market.data === null) return { state: 'unavailable', provider, reason: market.reason ?? 'provider_unavailable' }
  const raw = pick === 'liquidity' ? market.data.reportedLiquidityUsd : market.data.volume24hUsd
  if (raw === null) return { state: 'not_reported', provider }
  const v = valued(raw)
  if (!v) return { state: 'unavailable', provider, reason: 'invalid_quantity' }
  const base = { ...v, provider, retrievedAt: market.data.retrievedAt, cacheAgeSeconds: market.cache.ageSeconds }
  // A stale envelope is still a retained observation; a reason describes why no fresher observation is available.
  return market.status === 'stale' ? { state: 'attributed_stale', ...base, refreshReason: market.reason } : { state: 'attributed', ...base }
}

/** A payload time in UTC, the same text in every browser: "00:16:50 UTC, 1970-01-01". */
export function utcTime(seconds: number): string {
  const iso = new Date(seconds * 1000).toISOString()
  return `${iso.slice(11, 19)} UTC, ${iso.slice(0, 10)}`
}

/**
 * When a provider's figures for one pool were retrieved, as a sentence: the
 * pools route gives DexScreener figures no cache age, so the payload's
 * retrieval time, in UTC, is the only age there is. Never the client clock.
 */
export function retrievalNote(provider: ProviderId, retrievedAt: number): string {
  return `${PROVIDER_NAME[provider]} figures retrieved ${utcTime(retrievedAt)}. Provider-reported, not reconciled with chain data.`
}

/** Where a figure came from. Never says current, live, updated or qualified. */
export function provenanceText(figure: AttributedFigure): { short: string; long: string } {
  const name = PROVIDER_NAME[figure.provider]
  const tail = 'Provider-reported, not reconciled with chain data.'
  switch (figure.state) {
    case 'attributed': {
      const age = figure.cacheAgeSeconds === null ? '' : ` · cache ${figure.cacheAgeSeconds} s`
      return { short: `${name}${age}`, long: `Reported by ${name}, retrieved ${utcTime(figure.retrievedAt)}. ${tail}` }
    }
    case 'attributed_stale':
      return {
        short: `${name} · stale`,
        long: `Reported by ${name}, retrieved ${utcTime(figure.retrievedAt)}. This observation is stale${figure.refreshReason === null ? '' : ` (${reasonText(figure.refreshReason)})`}. ${tail}`,
      }
    case 'not_reported':
      return { short: `${name} · not reported`, long: `${name} was retrieved but reported no value for this figure. ${tail}` }
    case 'unavailable':
      return { short: `${name} · unavailable`, long: `Nothing usable was retrieved from ${name} (${reasonText(figure.reason)}). ${tail}` }
    case 'rejected':
      return { short: `${name} · rejected`, long: `What was retrieved from ${name} failed an identity check (${reasonText(figure.reason)}) and is not shown. ${tail}` }
    default:
      return figure satisfies never
  }
}

// ---------------------------------------------------------------------------
// How far behind the chain pool activity is
// ---------------------------------------------------------------------------

/**
 * pool-activity's own line between fresh and stale: the read service calls a
 * snapshot fresh while it is at most 120 s behind the chain head, measured
 * against the head's clock when it answers (read_service.py pool_activity;
 * METRICS_METHODOLOGY.md, "Rolling time and freshness").
 */
export const ACTIVITY_FRESH_SECONDS = 120

/**
 * How far behind the chain head activity may be and still be shown as the
 * 24 hours it covers. The read service keeps serving stale history with no
 * age at which it stops, and says a stale window "cannot be promoted to
 * current 24h data" (backend/README.md: "Do not relabel its requested 24h
 * window as a complete current day of data"). It sets no limit for showing
 * one, so the page sets its own: past 15 minutes behind, every figure is a
 * dash and the card says why only in its title.
 */
export const ACTIVITY_SHOWN_SECONDS = 900

/** How old an activity snapshot is now, and what the page may do with it. */
export interface ActivityAge {
  /** Seconds behind the chain head: the read service's age when it answered, plus the time since its answer arrived. */
  seconds: number
  /** `fresh` as the read service counts it; `stale` shown in normal type, stale in its title; `too_old` not shown as the last 24 hours. */
  state: 'fresh' | 'stale' | 'too_old'
}

/**
 * An activity snapshot's age now. The time since its answer arrived counts
 * on top of the age the read service reported, as the read service asks of a
 * consumer that keeps a result, so a card left open turns stale, then too old,
 * on its own. Nothing is read again for it.
 */
export function activityAge(freshness: PoolActivityResponse['freshness'], heldSeconds = 0): ActivityAge {
  const seconds = freshness.ageSeconds + Math.max(0, Math.floor(heldSeconds))
  if (seconds > ACTIVITY_SHOWN_SECONDS) return { seconds, state: 'too_old' }
  return { seconds, state: freshness.status === 'stale' || seconds > ACTIVITY_FRESH_SECONDS ? 'stale' : 'fresh' }
}

/** Whole seconds since an answer arrived: on the monotonic clock when both readings have one, so a step of the wall clock moves nothing; never negative. */
export function heldSeconds(received: { receivedAt: number; receivedMonotonic?: number }, now: Instant): number {
  const ms = received.receivedMonotonic !== undefined && now.monotonic !== undefined ? now.monotonic - received.receivedMonotonic : now.wall - received.receivedAt
  return Math.max(0, Math.floor(ms / 1000))
}

/** A lag in the largest whole unit that still reads plainly: seconds, minutes, hours, then days. */
export function lagText(seconds: number): string {
  if (seconds < 120) return `${seconds} s`
  if (seconds < 7_200) return `${Math.floor(seconds / 60)} min`
  if (seconds < 172_800) return `${Math.floor(seconds / 3_600)} h`
  return `${Math.floor(seconds / 86_400)} days`
}

/** What a title says about activity that is not fresh: how far behind, at which block, and whether it is still shown. Null while fresh. */
export function activityStaleText(age: ActivityAge, block: number): string | null {
  if (age.state === 'fresh') return null
  const behind = `Stale: indexed ${lagText(age.seconds)} behind the chain head, at block ${block}`
  return age.state === 'too_old' ? `${behind}, too far behind to show as the last 24 hours.` : `${behind}.`
}

/** The data code a card carries when its activity is too far behind to show. */
export const ACTIVITY_TOO_OLD = 'activity_stale'

export interface ActivityFacts {
  window: 'covered' | 'young'
  /** Seconds of the 24h window the pool has existed for, from the payload alone. */
  observedSeconds: number
  /** A young pool's age, from verified discovery data; null when the pool is older than the window. */
  age: { seconds: number; basis: 'observedSeconds' | 'snapshot_minus_initializedAt' } | null
  swaps: number
  stale: boolean
  block: number
  initializedBlock: number
  feeAccounting: 'reconciled' | 'unavailable'
}

/**
 * Pool age and coverage from pool-activity. Its `feeApr` is always null and
 * its `volumeUsd` null, so neither ever becomes a figure here.
 */
export function activityFacts(d: PoolActivityResponse): ActivityFacts {
  const w = d.window24h
  const young = w.status === 'pool_younger_than_window'
  const derived = d.snapshot.timestamp - d.coverage.initializedAt
  return {
    window: young ? 'young' : 'covered',
    observedSeconds: w.observedSeconds,
    age: young ? (Math.trunc(w.observedSeconds) === w.observedSeconds ? { seconds: w.observedSeconds, basis: 'observedSeconds' } : { seconds: derived, basis: 'snapshot_minus_initializedAt' }) : null,
    swaps: w.swapEventCount,
    stale: d.freshness.status === 'stale',
    block: d.snapshot.number,
    initializedBlock: d.coverage.initializedBlock,
    feeAccounting: d.fees.accounting.status === 'unavailable' ? 'unavailable' : 'reconciled',
  }
}

// ---------------------------------------------------------------------------
// The pool page's chain figures: amounts in token units, never USD
// ---------------------------------------------------------------------------

const groupThousands = (text: string) => {
  const [whole, fraction] = text.split('.')
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction === undefined ? '' : `.${fraction}`}`
}

/** A non-negative decimal to six significant digits, never fewer than its whole part, never an exponent, trailing zeros dropped. */
function significant(plain: string): string {
  const [whole, fraction = ''] = plain.split('.')
  const lead = whole.replace(/^0+/, '')
  const zeros = /^0*/.exec(fraction)?.[0].length ?? 0
  if (lead.length === 0 && zeros === fraction.length) return '0'
  const places = lead.length >= 6 ? 0 : lead.length > 0 ? 6 - lead.length : zeros + 6
  const rounded = toFixed(plain, Math.min(places, fraction.length)) ?? plain
  return groupThousands(rounded.includes('.') ? rounded.replace(/0+$/, '').replace(/\.$/, '') : rounded)
}

/** A raw token amount: the text a figure shows, and the exact amount for its title. */
export interface TokenAmount {
  raw: string
  /** In the token's units, to six significant digits; null when its decimals are not known. */
  text: string | null
  /** The whole amount in units, every digit; null when its decimals are not known. */
  exact: string | null
}

/**
 * A raw amount in the units of the token at `address`, with the decimals the
 * pools read already returned for it, bound by address. A token whose
 * decimals were not read keeps its raw amount only: units are never guessed.
 */
export function tokenAmount(raw: string, address: string, tokens: readonly TokenDisplay[]): TokenAmount {
  const token = tokens.find((t) => t.address.toLowerCase() === address.toLowerCase())
  const units = formatUnits(raw, token?.decimals ?? null)
  if (!units || units.kind !== 'units') return { raw, text: null, exact: null }
  return { raw, text: significant(units.text.replace(/,/g, '')), exact: units.text }
}

/** Two amounts in the pool's currency order, or why there are none. */
export type AmountPair = { state: 'amounts'; amounts: [TokenAmount, TokenAmount] } | { state: 'unavailable'; reason: string }

const pair = (raws: readonly string[] | null, currencies: readonly [string, string], tokens: readonly TokenDisplay[], reason: string | null | undefined): AmountPair =>
  raws && raws.length === 2
    ? { state: 'amounts', amounts: [tokenAmount(raws[0], currencies[0], tokens), tokenAmount(raws[1], currencies[1], tokens)] }
    : { state: 'unavailable', reason: reason ?? 'not_reconciled' }

/** One pool-activity answer as the pool page shows it. Counts and token amounts only: its USD volume and fee APR are always null. */
export interface PoolActivityView {
  block: number
  stale: boolean
  freshnessSeconds: number
  swaps: number
  window: 'covered' | 'young'
  observedSeconds: number
  /** A young pool's age; null when the pool is older than the window. */
  age: ActivityFacts['age']
  initializedBlock: number
  /** Swapped in plus swapped out over the window, per currency in pool order: the chain's own turnover. */
  turnover: [TokenAmount | null, TokenAmount | null]
  /** The window's LP fees, only when fee accounting is reconciled. */
  lpFees: AmountPair
  /** The pool's LP-attributed assets at the block, only when position accounting is reconciled. */
  lpAssets: AmountPair
}

export function poolActivityView(d: PoolActivityResponse, tokens: readonly TokenDisplay[]): PoolActivityView {
  const facts = activityFacts(d)
  const w = d.window24h
  const currencies = [d.poolKey.currency0, d.poolKey.currency1] as const
  const leg = (index: 0 | 1) => {
    const found = w.swapLegsRaw.find((l) => l.currencyIndex === index)
    return found ? tokenAmount(found.absoluteTurnover, currencies[index], tokens) : null
  }
  const positions = d.liquidity.positionAccounting
  return {
    block: facts.block,
    stale: facts.stale,
    freshnessSeconds: d.freshness.ageSeconds,
    swaps: facts.swaps,
    window: facts.window,
    observedSeconds: facts.observedSeconds,
    age: facts.age,
    initializedBlock: facts.initializedBlock,
    turnover: [leg(0), leg(1)],
    lpFees: pair(w.lpFeesRaw, currencies, tokens, w.lpFeesReason ?? d.fees.accounting.reason),
    lpAssets: pair(positions.lpAssetsRaw, currencies, tokens, positions.status === 'unavailable' ? positions.reason : null),
  }
}

/** One core position on the pool page: its range, and its NFT and owner at the block when the read service resolved them. */
export interface PoolPositionRow {
  key: string
  tickLower: number
  tickUpper: number
  hasLiquidity: boolean
  /** Null when no NFT was resolved for the position (the owner adapter is required). */
  nft: { tokenId: string; owner: string | null } | null
}

export type PoolPositionsView =
  | { state: 'unavailable'; reason: string; block: number; stale: boolean }
  | {
      state: 'reconciled'
      block: number
      stale: boolean
      count: number
      withLiquidity: number
      lpAssets: AmountPair
      rows: PoolPositionRow[]
    }

/**
 * pool-positions as the pool page shows it. An owner is whoever held the
 * position's NFT at the snapshot block: public data at that block, never a
 * sign of who controls a wallet.
 */
export function poolPositionsView(d: PoolPositionsResponse, tokens: readonly TokenDisplay[]): PoolPositionsView {
  const a = d.positionAccounting
  const block = d.snapshot.number
  const stale = d.freshness.status === 'stale'
  if (a.status === 'unavailable') return { state: 'unavailable', reason: a.reason, block, stale }
  const currencies = [d.poolKey.currency0, d.poolKey.currency1] as const
  return {
    state: 'reconciled',
    block,
    stale,
    count: a.corePositionCount,
    withLiquidity: a.nonzeroLiquidityPositionCount,
    lpAssets: pair(a.lpAssetsRaw, currencies, tokens, null),
    rows: a.items.map((item) => ({
      key: item.corePositionId.toLowerCase(),
      tickLower: item.tickLower,
      tickUpper: item.tickUpper,
      hasLiquidity: item.liquidityRaw !== '0',
      nft: item.nft.status === 'core_owner_adapter_required' ? null : { tokenId: item.nft.tokenId, owner: item.nft.status === 'owner_verified_at_snapshot' ? item.nft.owner.toLowerCase() : null },
    })),
  }
}

/**
 * A v4 pool's protocol fee, packed as the pool holds it: the low 12 bits for
 * swaps selling currency0, the high 12 bits for swaps selling currency1, each
 * in pips (at most 1,000, which is 0.1%). Anything outside that is invalid.
 */
export type ProtocolFee =
  | { state: 'none' }
  | { state: 'directional'; zeroForOne: string; oneForZero: string; zeroForOnePips: number; oneForZeroPips: number }
  | { state: 'invalid' }

export function protocolFee(raw: number): ProtocolFee {
  if (Math.trunc(raw) !== raw || raw < 0 || raw >= 1 << 24) return { state: 'invalid' }
  const zeroForOnePips = raw & 0xfff
  const oneForZeroPips = raw >> 12
  if (zeroForOnePips > 1000 || oneForZeroPips > 1000) return { state: 'invalid' }
  if (raw === 0) return { state: 'none' }
  return { state: 'directional', zeroForOne: fixedFeePercent(zeroForOnePips), oneForZero: fixedFeePercent(oneForZeroPips), zeroForOnePips, oneForZeroPips }
}

/** Whether a table row's figures are Domino's qualified 24h ones. */
export const rowQualified = (row: Pick<Market, 'tvlUsd' | 'volume24hUsd' | 'feeAprPercent'>) =>
  [row.tvlUsd, row.volume24hUsd, row.feeAprPercent].some((metric) => metric.state === 'qualified')

/**
 * Volume over TVL in the read builds. From qualified operands it is slice A's
 * ratio. From provider operands, current or retained, it stays unavailable
 * until the open question on derived provider figures is answered: a ratio of
 * two unreconciled figures is a new claim neither provider made.
 */
export function turnoverCell(row: Pick<Market, 'volume24hUsd' | 'tvlUsd'>): Presented {
  if ([row.volume24hUsd, row.tvlUsd].some((metric) => metric.source !== undefined)) return { kind: 'unavailable', reason: 'derived_figure_pending_q8' }
  return turnover(row)
}

/** Why a presented figure shows no number, as a closed code; null for a number. */
export function presentedNoteCode(shown: Presented): string | null {
  if (shown.kind === 'value') return null
  return shown.reason ?? (shown.kind === 'not_current' ? shown.basis : shown.kind)
}

export const metricNoteCode = (metric: Metric) => presentedNoteCode(presentMetric(metric))

/** The id of the visible note a table cell points at with aria-describedby. */
export const figureNoteId = (code: string) => `figure-note-${code.replace(/[^a-z0-9_]/g, '')}`
