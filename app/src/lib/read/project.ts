/**
 * Validated payloads into what a screen shows.
 *
 * Projections run only on an `ok` outcome, so an invalid payload never gets
 * this far and is never partly rendered. Each keeps zero, not reported,
 * partial, stale, unavailable and rejected apart, keys everything by chain
 * plus address or pool id, keeps raw amounts as strings, and names where each
 * figure came from. Token symbols and provider labels are passed through as
 * untrusted text for the components to render as text, and `sourceUrl` is
 * never read at all.
 */
import type {
  CatalogueResponse,
  DynamicPoolKey,
  FixedPoolKey,
  MarketsSnapshotResponse,
  NftPositionsResponse,
  PoolActivityResponse,
  PoolMarketResponse,
  PoolMetricsResponse,
  PoolPositionsResponse,
  PoolsResponse,
  SnapshotPoolEntry,
  TokenMetadata,
  TokenResponse,
  UnknownToken,
  VerifiedPool,
} from 'api-contracts/read-v1/types'
import type { PoolAprEstimate } from 'api-contracts/read-v2/types'
import { formatUnits, formatUsdCompact, isZero, parseDecimal, toFixed } from './decimal'
import { reasonText } from './describe'
import type { ArtworkKey, EstimateReason, Observation, ReadOutcome, ReadRoute, TokenDisplay } from './types'
import type { Market, MarketProvenance, Metric } from '../markets'

export type FactState = 'value' | 'zero' | 'absent' | 'partial' | 'stale' | 'not-current' | 'unavailable' | 'rejected' | 'raw'

export interface Fact {
  label: string
  text: string
  state: FactState
  /** Tokens to show beside the text, symbols rendered as untrusted text. */
  tokens?: TokenDisplay[]
  /** `text` is provider-authored: render it isolated and truncated. */
  untrusted?: boolean
}

export interface ItemView {
  key: string
  title: Fact
  facts: Fact[]
  /** Kept from before a list restarted, and not seen since. */
  old?: boolean
}

export interface FamilyView {
  route: ReadRoute
  facts: Fact[]
  items: ItemView[]
  notes: string[]
  freshness: string[]
}

const CHAIN = 4663 as const
const lower = (value: string) => value.toLowerCase()
export const identityKey = (id: string) => `${CHAIN}:${lower(id)}`
export const shortId = (id: string) => (id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id)

/**
 * Bundled artwork for documented Robinhood Chain identities (see
 * reports/ALPHA_MARKET_REQUALIFICATION_2026-09-11.md). This is presentation,
 * not token admission or a verification badge. Symbols never select artwork.
 */
const ARTWORK_BY_ADDRESS: Readonly<Record<string, ArtworkKey>> = {
  '0x0000000000000000000000000000000000000000': 'ETH',
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73': 'WETH',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168': 'USDG',
  '0xab35d04e1ee39c789c4a65d522417b3c7f2e4723': 'MARLIN',
}

export function tokenDisplay(asset: TokenMetadata | UnknownToken): TokenDisplay {
  const address = lower(asset.address)
  return {
    origin: 'read',
    chainId: CHAIN,
    address,
    symbol: asset.symbol,
    decimals: asset.decimals,
    readStatus: asset.readStatus,
    artwork: ARTWORK_BY_ADDRESS[address] ?? null,
  }
}

/** A token known only by address, when its metadata read failed or was not made. */
export function unreadToken(address: string): TokenDisplay {
  const key = lower(address)
  return { origin: 'read', chainId: CHAIN, address: key, symbol: null, decimals: null, readStatus: 'unavailable', artwork: ARTWORK_BY_ADDRESS[key] ?? null }
}

export const tokenText = (token: TokenDisplay) => token.symbol ?? shortId(token.address ?? '')

function usd(label: string, value: string | null, whenNull = 'Not reported'): Fact {
  if (value === null) return { label, text: whenNull, state: 'absent' }
  const parsed = parseDecimal(value)
  if (!parsed) return { label, text: 'Unavailable', state: 'unavailable' }
  return { label, text: formatUsdCompact(value) as string, state: isZero(parsed) ? 'zero' : 'value' }
}

function raw(label: string, amounts: readonly string[] | null, reason?: string | null): Fact {
  if (amounts === null) return { label, text: `Unavailable: ${reasonText(reason)}`, state: 'unavailable' }
  const texts = amounts.map((amount) => formatUnits(amount, null)?.text ?? 'Unavailable')
  const zero = amounts.every((amount) => amount === '0')
  return { label, text: `${texts.join(' · ')} (raw units)`, state: zero ? 'zero' : 'raw' }
}

import { fixedFeePercent } from './screens/fee'

const count = (label: string, n: number, unit: string): Fact => ({ label, text: `${n} ${unit}`, state: n === 0 ? 'zero' : 'value' })

/** A fixed fee in pips as a percentage, or the dynamic sentinel as what it means. Pips are small integers, not amounts. */
export const feeText = (key: FixedPoolKey | DynamicPoolKey) => (key.feeMode === 'dynamic' ? 'Dynamic fee' : fixedFeePercent(key.fee_pips))

// A market data provider is named on screen by the part it plays, never by its company name; the id stays in the payload.
const PROVIDER_NAME: Record<string, string> = {
  geckoterminal: 'Market data provider',
  dexscreener: 'Pool discovery provider',
  alchemy: 'Alchemy',
  alchemy_historical: 'Alchemy history',
  chainlink_robinhood_standard_v1: 'Chainlink',
}

/** Freshness lines for any successful read. */
export function freshnessLines(observation: Observation): string[] {
  const lines: string[] = []
  if (observation.block) lines.push(`Block ${observation.block.number}`)
  if (observation.interval) {
    lines.push(`Indexed blocks ${observation.interval.startBlock}–${observation.interval.indexedThrough ?? 'not yet indexed'}, configured interval only`)
  }
  if (observation.revision !== undefined) lines.push(`Revision ${observation.revision}`)
  if (observation.freshness) {
    const head = observation.freshness.checkedAgainstHead !== undefined ? `, checked against block ${observation.freshness.checkedAgainstHead}` : ''
    lines.push(`${observation.freshness.status === 'stale' ? 'Stale' : 'Fresh'}, ${observation.freshness.ageSeconds} s old${head}`)
  }
  const seen = new Set<string>()
  for (const p of observation.providers) {
    const cache = p.cache ? `, cache ${p.cache.ageSeconds === null ? 'age unknown' : `${p.cache.ageSeconds} s`}` : ''
    const line = `${PROVIDER_NAME[p.provider] ?? p.provider} (${p.scope}${cache})`
    if (!seen.has(line)) lines.push(line)
    seen.add(line)
  }
  return lines
}

// ---------------------------------------------------------------------------
// The nine families
// ---------------------------------------------------------------------------

function decimalsFact(asset: TokenMetadata | UnknownToken): Fact {
  if (asset.kind === 'unknown') {
    return asset.readStatus === 'no_contract'
      ? { label: 'Decimals', text: 'No contract at this address', state: 'absent' }
      : { label: 'Decimals', text: `Unavailable: ${reasonText(asset.reason)}`, state: 'unavailable' }
  }
  if (asset.decimals === null) {
    const why = asset.metadataIssues.decimals
    return { label: 'Decimals', text: `Units unknown${why ? `: ${reasonText(why)}` : ''}`, state: 'partial' }
  }
  return { label: 'Decimals', text: String(asset.decimals), state: asset.decimals === 0 ? 'zero' : 'value' }
}

const READ_STATUS: Record<'available' | 'partial' | 'no_contract' | 'unavailable', [string, FactState]> = {
  available: ['Available', 'value'],
  partial: ['Partial metadata', 'partial'],
  no_contract: ['No contract', 'absent'],
  unavailable: ['Unavailable', 'unavailable'],
}

export function projectToken(d: TokenResponse): Omit<FamilyView, 'freshness' | 'route'> {
  const a = d.asset
  const token = tokenDisplay(a)
  const [status, state] = READ_STATUS[a.readStatus]
  return {
    facts: [
      { label: 'Token', text: '', state: 'value', tokens: [token] },
      { label: 'Address', text: lower(a.address), state: 'value' },
      { label: 'Kind', text: a.kind === 'native' ? 'Native currency' : a.kind === 'erc20_candidate' ? 'ERC-20 candidate' : 'Unknown', state: 'value' },
      decimalsFact(a),
      { label: 'Metadata', text: status, state },
    ],
    items: [],
    notes: a.kind !== 'unknown' && a.metadataIssues.symbol ? [`Symbol could not be read: ${reasonText(a.metadataIssues.symbol)}`] : [],
  }
}

export function projectPools(d: PoolsResponse): Omit<FamilyView, 'freshness' | 'route'> {
  const byAddress = new Map(d.tokens.map((t) => [lower(t.address), tokenDisplay(t)]))
  const tokenAt = (address: string) => byAddress.get(lower(address)) ?? unreadToken(address)
  const discovery: Fact =
    d.discovery.status === 'received'
      ? { label: 'Discovery (provider)', text: `${d.discovery.returned} returned, ${d.discovery.v4Candidates} Uniswap candidates`, state: d.discovery.returned === 0 ? 'zero' : 'value' }
      : { label: 'Discovery (provider)', text: `Partial list: ${reasonText(d.discovery.reason)}`, state: 'partial' }
  const catalogue: Fact =
    d.catalogue.status === 'available'
      ? { label: 'Catalogue', text: `Revision ${d.catalogue.revision}, blocks ${d.catalogue.startBlock}–${d.catalogue.indexedThrough ?? 'not yet indexed'}`, state: 'value' }
      : d.catalogue.status === 'not_configured'
        ? { label: 'Catalogue', text: 'Not configured', state: 'absent' }
        : { label: 'Catalogue', text: `Unavailable: ${reasonText(d.catalogue.reason)}`, state: 'unavailable' }
  const [selected, selectedState] = READ_STATUS[d.selectedTokenReadStatus]

  const items: ItemView[] = d.pools.map((pool) => {
    const pm = pool.providerMetrics
    const facts: Fact[] = [
      { label: 'Kind', text: pool.poolKind === 'discovery' ? 'Verified by discovery' : 'From the catalogue', state: 'value' },
      { label: 'Fee', text: feeText(pool.poolKey), state: 'value' },
      pm
        ? usd('Liquidity (provider-reported, not reconciled)', pm.reportedLiquidityUsd)
        : { label: 'Liquidity (provider-reported, not reconciled)', text: 'No provider figures', state: 'absent' },
      pm
        ? usd('24h volume (provider-reported, not reconciled)', pm.volume24hUsd)
        : { label: '24h volume (provider-reported, not reconciled)', text: 'No provider figures', state: 'absent' },
      { label: 'Fee APR', text: `Not available: ${reasonText(pool.aprReason)}`, state: 'unavailable' },
      { label: 'Token metadata', text: pool.tokenMetadataStatus === 'available' ? 'Available' : 'Partial', state: pool.tokenMetadataStatus === 'available' ? 'value' : 'partial' },
    ]
    if ('providerCurrencyConflict' in pool && pool.providerCurrencyConflict) {
      facts.push({ label: 'Provider currencies', text: 'Conflict with the chain; provider figures not trusted', state: 'rejected' })
    }
    return {
      key: identityKey(pool.poolId),
      title: { label: 'Pool', text: shortId(pool.poolId), state: 'value', tokens: pool.currencies.map(tokenAt) },
      facts,
    }
  })

  const notes: string[] = []
  if (d.pools.length === 0) notes.push('No verified pools found. That is not proof none exist.')
  if (d.unverifiedCandidates.length > 0) {
    notes.push(`${d.unverifiedCandidates.length} candidate${d.unverifiedCandidates.length === 1 ? '' : 's'} rejected and not listed (${d.unverifiedCandidates.map((c) => reasonText(c.reason)).join(', ')}).`)
  }
  return {
    facts: [
      { label: 'Selected token', text: '', state: 'value', tokens: [tokenAt(d.selectedToken)] },
      { label: 'Selected token metadata', text: selected, state: selectedState },
      discovery,
      catalogue,
    ],
    items,
    notes,
  }
}

function historyFacts(h: PoolMarketResponse['priceHistory']): Fact[] {
  if (h.status === 'not_requested') return [{ label: 'Price history', text: 'Not requested', state: 'absent' }]
  if (h.data === null) {
    return h.status === 'rejected'
      ? [{ label: 'Price history', text: `Rejected: ${reasonText(h.reason)}`, state: 'rejected' }]
      : [{ label: 'Price history', text: `Unavailable: ${reasonText(h.reason)}`, state: 'unavailable' }]
  }
  const c = h.data.coverage
  const last = h.data.candles[h.data.candles.length - 1]
  const stale = h.status === 'stale'
  const facts: Fact[] = [
    {
      label: 'Price history (provider-reported)',
      text: `${stale ? 'Stale' : 'Available'}, cache ${h.cache.ageSeconds === null ? 'age unknown' : `${h.cache.ageSeconds} s`}`,
      state: stale ? 'stale' : 'value',
    },
    { label: 'Candles', text: `${c.returnedCandles} returned of ${c.requestedLimit}, ${c.closedCandles} closed`, state: c.returnedCandles === 0 ? 'zero' : 'value' },
    { label: 'Gaps', text: c.gapsDetected ? 'Gaps detected between candles' : 'None detected', state: c.gapsDetected ? 'partial' : 'value' },
    // complete24h is the literal false in this contract: candles never make a 24h figure.
    { label: '24h coverage', text: 'Not established', state: 'partial' },
  ]
  if (last && !last.closed) facts.push({ label: 'Latest hour', text: 'Still open (inferred from the backend clock)', state: 'partial' })
  return facts
}

export function projectPoolMarket(d: PoolMarketResponse): Omit<FamilyView, 'freshness' | 'route'> {
  const m = d.market
  const usable = (m.status === 'available' || m.status === 'stale') && m.data !== null
  const facts: Fact[] = [
    { label: 'Pool', text: shortId(d.poolId), state: 'value', tokens: d.pool.currencies.map(unreadToken) },
    { label: 'Fee', text: feeText(d.pool.poolKey), state: 'value' },
  ]
  if (usable) {
    const stale = m.status === 'stale'
    const mark = (fact: Fact): Fact => (stale && fact.state !== 'absent' ? { ...fact, text: `${fact.text} · stale`, state: 'stale' } : fact)
    facts.push(
      { label: 'Market (provider-reported)', text: stale ? `Stale: ${reasonText(m.reason)}` : 'Available', state: stale ? 'stale' : 'value' },
      mark(usd('Liquidity', m.data.reportedLiquidityUsd)),
      mark(usd('24h volume', m.data.volume24hUsd)),
    )
    if (m.data.dexLabel !== null) facts.push({ label: 'Provider label', text: m.data.dexLabel, state: 'value', untrusted: true })
  } else {
    // An expired observation keeps its cache age but has no data: unavailable, whatever the age says.
    const rejected = m.status === 'rejected'
    const text = rejected ? `Rejected: ${reasonText(m.reason)}` : `Unavailable: ${reasonText(m.reason)}`
    const state: FactState = rejected ? 'rejected' : 'unavailable'
    facts.push(
      { label: 'Market (provider-reported)', text, state },
      { label: 'Liquidity', text: rejected ? 'Rejected, not shown' : 'Unavailable', state },
      { label: '24h volume', text: rejected ? 'Rejected, not shown' : 'Unavailable', state },
    )
  }
  facts.push(
    { label: 'Provider cache', text: `${m.cache.status.replace(/_/g, ' ')}, ${m.cache.ageSeconds === null ? 'age unknown' : `${m.cache.ageSeconds} s`}${usable ? '' : ' (not a usable observation)'}`, state: 'value' },
    { label: 'Fee APR', text: `Not available: ${reasonText(d.aprReason)}`, state: 'unavailable' },
    ...historyFacts(d.priceHistory),
  )
  return { facts, items: [], notes: d.issues.includes('provider_dex_label_unconfirmed') ? ['The provider’s exchange label is unconfirmed.'] : [] }
}

export function projectMarketsSnapshot(d: MarketsSnapshotResponse): Omit<FamilyView, 'freshness' | 'route'> {
  if (d.status === 'not_built') {
    return {
      facts: [{ label: 'Snapshot', text: 'Not built yet: one provider read per pool fills it (pool-market)', state: 'absent' }],
      items: [],
      notes: [],
    }
  }
  const stale = d.status === 'stale'
  const facts: Fact[] = [
    { label: 'Snapshot', text: `${stale ? 'Stale' : 'Current'}, built ${d.builtAt === null ? 'at an unknown time' : new Date(d.builtAt * 1000).toISOString()}, ${d.ageSeconds === null ? 'age unknown' : `${d.ageSeconds} s`}${d.reason === null ? '' : ` (${reasonText(d.reason)})`}`, state: stale ? 'stale' : 'value' },
    { label: 'Stored pools', text: `${d.pools.length} of ${d.requested.length} requested`, state: d.pools.length === 0 ? 'zero' : 'value' },
  ]
  const items: ItemView[] = d.pools.map((entry) => {
    const market = entry.market
    const usable = market.status === 'available' || market.status === 'stale'
    const stale = market.status === 'stale'
    return {
      key: entry.poolId,
      title: { label: 'Pool', text: shortId(entry.poolId), state: 'value', tokens: entry.pool.currencies.map(unreadToken) },
      facts: [
        { label: 'Fee', text: feeText(entry.pool.poolKey), state: 'value' },
        { label: 'Market (stored)', text: usable ? (stale ? 'Stale at fold time' : 'Available') : `Unavailable: ${reasonText(market.reason)}`, state: usable ? (stale ? 'stale' : 'value') : 'unavailable' },
        { label: 'Observed at', text: `${entry.observedAt}`, state: 'value' },
      ],
    }
  })
  return { facts, items, notes: [] }
}

type Valuation = PoolMetricsResponse['valuation']
type Calculated = Exclude<Valuation, { status: 'unavailable' }>

/**
 * Whether this valuation meets every condition the producer puts on
 * usableAsCurrent24h except a fresh snapshot: qualified_historical_calculation,
 * a complete 24h valuation window, reconciled capital over a complete 24h
 * window, and a fee APR. Only such a payload was a current figure that has
 * since aged; anything short of it was never current, however old it is.
 */
function qualifiedButForFreshness(d: PoolMetricsResponse, v: Calculated): boolean {
  return (
    v.status === 'qualified_historical_calculation' &&
    v.complete24h &&
    v.feeAprPercent !== null &&
    d.capital.status === 'reconciled_event_history' &&
    d.capital.complete24h
  )
}

/**
 * Which non-current basis a calculated valuation is on, when it is not usable
 * as current. Stale means a retained value: a figure that would be current if
 * the snapshot were fresh. A stale snapshot of a figure that would fail
 * qualification when fresh is partial (not current), never stale.
 */
function metricsBasis(d: PoolMetricsResponse, v: Calculated): 'reference' | 'stale' | 'partial' {
  if (v.status === 'reference_analytics_only') return 'reference'
  if (d.freshness.status === 'stale' && qualifiedButForFreshness(d, v)) return 'stale'
  return 'partial'
}

/** Why a partial valuation is not current: the window that is short, or the capital that is missing. */
function partialReason(d: PoolMetricsResponse, v: Calculated): string {
  if (!v.complete24h) return 'pool_younger_than_window'
  if (d.capital.status === 'unavailable') return d.capital.reason
  if (!d.capital.complete24h) return 'capital_window_incomplete'
  return v.feeAprReason ?? 'pool_younger_than_window'
}

/** The observed window of whichever input is short: valuation first, then capital. */
function partialWindowSeconds(d: PoolMetricsResponse, v: Calculated): number {
  if (!v.complete24h) return v.observedSeconds
  if (d.capital.status === 'reconciled_event_history' && !d.capital.complete24h) return d.capital.observedSeconds
  return v.observedSeconds
}

export function projectPoolMetrics(d: PoolMetricsResponse): Omit<FamilyView, 'freshness' | 'route'> {
  const v = d.valuation
  const facts: Fact[] = [{ label: 'Usable as current 24h', text: d.usableAsCurrent24h ? 'Yes' : 'No', state: d.usableAsCurrent24h ? 'value' : 'partial' }]
  if (v.status === 'unavailable') {
    for (const label of ['TVL', '24h gross input volume', 'Fee APR']) facts.push({ label, text: `Unavailable: ${reasonText(v.reason)}`, state: 'unavailable' })
  } else {
    const apr = v.feeAprPercent === null ? null : `${toFixed(v.feeAprPercent, 2)}%`
    const shown = (label: string, text: string | null, why?: string | null): Fact => {
      if (text === null) return { label, text: `Not established: ${reasonText(why)}`, state: 'partial' }
      if (d.usableAsCurrent24h) return { label, text, state: 'value' }
      const basis = metricsBasis(d, v)
      if (basis === 'reference') return { label, text: `Reference analytics, not current: ${text}`, state: 'not-current' }
      if (basis === 'stale') return { label, text: `${text} · stale`, state: 'stale' }
      if (d.capital.status === 'unavailable') return { label, text: `Not current (capital unavailable): ${text}`, state: 'partial' }
      return { label, text: `Partial window (${partialWindowSeconds(d, v)} s observed): ${text}`, state: 'partial' }
    }
    facts.push(
      shown('TVL', formatUsdCompact(v.tvlUsd)),
      shown('Time-weighted TVL', formatUsdCompact(v.timeWeightedAverageTvlUsd)),
      shown('24h gross input volume', formatUsdCompact(v.grossInputVolumeUsd)),
      shown('24h LP fees', formatUsdCompact(v.tradingLpFeesUsd)),
      shown('Fee APR', apr, v.feeAprReason),
    )
  }
  facts.push(
    d.capital.status === 'unavailable'
      ? { label: 'Capital', text: `Unavailable: ${reasonText(d.capital.reason)}`, state: 'unavailable' }
      : { label: 'Capital', text: d.capital.complete24h ? 'Reconciled over the full 24h' : `Reconciled over ${d.capital.observedSeconds} s only`, state: d.capital.complete24h ? 'value' : 'partial' },
  )
  const items: ItemView[] = d.prices.map((price) => ({
    key: identityKey(price.currency),
    title: { label: 'Price evidence', text: '', state: 'value', tokens: [unreadToken(price.currency)] },
    facts: [
      {
        label: 'Status',
        text: price.status === 'qualified' ? 'Qualified' : price.status === 'observed_unqualified' ? `Observed, not qualified: ${reasonText(price.reason)}` : `Unavailable: ${reasonText(price.reason)}`,
        state: price.status === 'qualified' ? 'value' : price.status === 'observed_unqualified' ? 'partial' : 'unavailable',
      },
      {
        label: 'Sources',
        text: price.observedSources === null ? 'Not assessed' : price.observedSources.length === 0 ? 'None observed' : price.observedSources.map((s) => PROVIDER_NAME[s] ?? s).join(', '),
        state: price.observedSources === null ? 'unavailable' : price.observedSources.length === 0 ? 'zero' : 'value',
      },
    ],
  }))
  return { facts, items, notes: [] }
}

function accountingFact(label: string, accounting: { status: string; reason: string | null }): Fact {
  return accounting.status === 'unavailable'
    ? { label, text: `Unavailable: ${reasonText(accounting.reason)}`, state: 'unavailable' }
    : { label, text: 'Reconciled', state: 'value' }
}

export function projectPoolActivity(d: PoolActivityResponse): Omit<FamilyView, 'freshness' | 'route'> {
  const w = d.window24h
  const stale = d.freshness.status === 'stale'
  const window: Fact =
    w.status === 'pool_younger_than_window'
      ? { label: '24h window', text: `Partial: pool younger than the window (${w.observedSeconds} s observed)`, state: 'partial' }
      : { label: '24h window', text: `Covered (${w.observedSeconds} s)${stale ? ' · stale' : ''}`, state: stale ? 'stale' : 'value' }
  return {
    facts: [
      window,
      count('Swaps', w.swapEventCount, 'swap events'),
      count('Nonzero swaps', w.nonzeroSwapCount, 'nonzero'),
      raw('LP fees', w.lpFeesRaw, w.lpFeesReason),
      { label: 'USD volume', text: `Not available: ${reasonText(w.volumeUsdReason)}`, state: 'unavailable' },
      { label: 'Fee APR', text: `Not available: ${reasonText(w.feeAprReason)}`, state: 'unavailable' },
      accountingFact('Fee accounting', d.fees.accounting),
      accountingFact('Position accounting', d.liquidity.positionAccounting),
    ],
    items: [],
    notes: [],
  }
}

export function projectPoolPositions(d: PoolPositionsResponse): Omit<FamilyView, 'freshness' | 'route'> {
  const a = d.positionAccounting
  if (a.status === 'unavailable') {
    return { facts: [{ label: 'Position accounting', text: `Unavailable: ${reasonText(a.reason)}`, state: 'unavailable' }], items: [], notes: [] }
  }
  const stale = d.freshness.status === 'stale'
  return {
    facts: [
      { label: 'Position accounting', text: `Reconciled${stale ? ' · stale' : ''}`, state: stale ? 'stale' : 'value' },
      count('Core positions', a.corePositionCount, 'positions'),
      count('With liquidity', a.nonzeroLiquidityPositionCount, 'positions'),
      raw('LP assets', a.lpAssetsRaw),
    ],
    items: a.items.map((p) => ({
      key: `${CHAIN}:core:${lower(p.corePositionId)}`,
      title: { label: 'Core position', text: shortId(p.corePositionId), state: 'value' },
      facts: [
        { label: 'Range', text: `Ticks ${p.tickLower} to ${p.tickUpper}`, state: 'value' },
        raw('Liquidity', [p.liquidityRaw]),
        {
          label: 'NFT owner',
          text: p.nft.status === 'core_owner_adapter_required' ? 'Owner not resolved' : p.nft.status === 'position_info_empty_at_snapshot' ? 'Position empty at snapshot' : `${shortId(p.nft.owner)} at snapshot`,
          state: p.nft.status === 'owner_verified_at_snapshot' ? 'value' : 'absent',
        },
      ],
    })),
    notes: ['Core positions only. NFT ownership is a historical snapshot, not wallet authentication.'],
  }
}

export function projectNftPositions(d: NftPositionsResponse): Omit<FamilyView, 'freshness' | 'route'> {
  const stale = d.freshness.status === 'stale'
  return {
    facts: [{ label: 'Snapshot', text: stale ? `Stale, ${d.freshness.ageSeconds} s old` : `Fresh, ${d.freshness.ageSeconds} s old`, state: stale ? 'stale' : 'value' }],
    items: d.items.map((nft) => {
      const title: Fact = { label: 'NFT', text: `#${shortId(nft.tokenId)}`, state: 'value' }
      if (nft.status === 'position_info_empty_at_snapshot') {
        return { key: `${CHAIN}:nft:${nft.tokenId}`, title, facts: [{ label: 'Position', text: 'Position empty at snapshot', state: 'absent' }] }
      }
      return {
        key: `${CHAIN}:nft:${nft.tokenId}`,
        title,
        facts: [
          { label: 'Owner', text: `${shortId(nft.owner)}, owner at snapshot, not proof of wallet control`, state: stale ? 'stale' : 'value' },
          raw('Liquidity', [nft.liquidityRaw]),
          raw('Principal', nft.principalRaw),
          raw('Unsettled fees', nft.unsettledFeesRaw),
          { label: 'In range', text: nft.inRange ? 'Yes' : 'No', state: 'value' },
        ],
      }
    }),
    notes: d.items.length === 0 ? ['None of the requested NFTs were returned.'] : [],
  }
}

export function projectCatalogue(d: CatalogueResponse): Omit<FamilyView, 'freshness' | 'route'> {
  return {
    facts: [
      { label: 'Coverage', text: `Configured interval only, blocks ${d.startBlock}–${d.indexedThrough ?? 'not yet indexed'}. Not complete history.`, state: 'partial' },
      count('Candidates', d.items.length, d.items.length === 1 ? 'candidate' : 'candidates'),
    ],
    items: d.items.map((item) => ({
      key: identityKey(item.poolId),
      title: { label: 'Candidate', text: shortId(item.poolId), state: 'value', tokens: item.currencies.map(unreadToken) },
      facts: [
        { label: 'Fee', text: feeText(item.poolKey), state: 'value' },
        { label: 'Found by', text: item.catalogueSource === 'initialize_event' ? 'Initialize event' : 'Verified observation', state: 'value' },
      ],
    })),
    notes: d.items.length === 0 ? ['No candidates in the configured interval. That is not proof none exist.'] : [],
  }
}

/** Any successful single read, as a family view. Wallet assets and catalogue pages go through pagers.ts. */
export function projectFamily<R extends ReadRoute>(outcome: Extract<ReadOutcome<R>, { state: 'ok' }>): FamilyView {
  const base = { route: outcome.route, freshness: freshnessLines(outcome.observation) }
  const data = outcome.data as unknown
  switch (outcome.route) {
    case 'token':
      return { ...base, ...projectToken(data as TokenResponse) }
    case 'pools':
      return { ...base, ...projectPools(data as PoolsResponse) }
    case 'pool-market':
      return { ...base, ...projectPoolMarket(data as PoolMarketResponse) }
    case 'pool-metrics':
      return { ...base, ...projectPoolMetrics(data as PoolMetricsResponse) }
    case 'pool-activity':
      return { ...base, ...projectPoolActivity(data as PoolActivityResponse) }
    case 'pool-positions':
      return { ...base, ...projectPoolPositions(data as PoolPositionsResponse) }
    case 'nft-positions':
      return { ...base, ...projectNftPositions(data as NftPositionsResponse) }
    case 'catalogue':
      return { ...base, ...projectCatalogue(data as CatalogueResponse) }
    case 'markets-snapshot':
      return { ...base, ...projectMarketsSnapshot(data as MarketsSnapshotResponse) }
    case 'wallet-assets':
      throw new Error('wallet-assets pages are projected by the wallet pager')
    case 'overview':
    case 'history':
    case 'search':
      throw new Error('stored public reads are projected by their dedicated consumers')
    default:
      return outcome.route satisfies never
  }
}

// ---------------------------------------------------------------------------
// One table row from its reads
// ---------------------------------------------------------------------------

const unavailable = (reason: string): Metric => ({ value: null, state: 'unavailable', reason })

type MarketObservation = PoolMarketResponse['market']

/**
 * TVL and 24h volume, in order of precedence: Domino's qualified figure when
 * pool-metrics says usableAsCurrent24h; otherwise the provider's, named, when
 * its observation is usable; otherwise Domino's calculated value on its
 * non-current basis; otherwise unavailable with the reason that stopped it.
 */
function figure(
  metrics: ReadOutcome<'pool-metrics'> | null,
  m: MarketObservation,
  qualified: (v: Calculated) => string,
  provider: (m: NonNullable<MarketObservation['data']>) => string | null,
): Metric {
  const metricsData = metrics?.state === 'ok' ? metrics.data : null
  const v = metricsData?.valuation
  if (metricsData && v && v.status !== 'unavailable' && metricsData.usableAsCurrent24h) {
    return { value: qualified(v), state: 'qualified' }
  }
  if ((m.status === 'available' || m.status === 'stale') && m.data !== null) {
    const value = provider(m.data)
    if (value === null) return { value: null, state: 'absent', reason: 'provider_not_reported', source: 'GeckoTerminal' }
    return { value, state: m.status === 'stale' ? 'stale' : 'provider', asOf: m.data.retrievedAt, source: 'GeckoTerminal' }
  }
  if (metricsData && v && v.status !== 'unavailable') {
    const basis = metricsBasis(metricsData, v)
    if (basis === 'stale') return { value: qualified(v), state: 'stale', asOf: metricsData.snapshot.timestamp }
    return { value: qualified(v), state: basis, reason: basis === 'reference' ? 'reference_analytics_only' : partialReason(metricsData, v) }
  }
  if (m.status === 'rejected') return { value: null, state: 'rejected', reason: m.reason }
  return unavailable(m.status === 'unavailable' ? m.reason : 'provider_unavailable')
}

function apr(metrics: ReadOutcome<'pool-metrics'> | null): Metric {
  // Without pool-metrics nothing in read-v1 carries a fee APR: unavailable,
  // with that reason. Never a zero, never an estimate.
  if (!metrics) return unavailable('fee_apr_not_provided')
  if (metrics.state !== 'ok') return unavailable(metrics.state)
  const d = metrics.data
  const v = d.valuation
  if (v.status === 'unavailable') return unavailable(v.reason)
  if (d.usableAsCurrent24h && v.feeAprPercent !== null) return { value: v.feeAprPercent, state: 'qualified' }
  const basis = metricsBasis(d, v)
  if (v.feeAprPercent === null) return { value: null, state: 'partial', reason: v.feeAprReason ?? 'pool_younger_than_window' }
  if (basis === 'stale') return { value: v.feeAprPercent, state: 'stale', asOf: d.snapshot.timestamp }
  return { value: v.feeAprPercent, state: basis, reason: basis === 'reference' ? 'reference_analytics_only' : partialReason(d, v) }
}

/**
 * A 24h figure only Domino's own history carries (LP fees, time-weighted
 * TVL): qualified when pool-metrics says usableAsCurrent24h, otherwise on its
 * non-current basis, otherwise unavailable with the reason. No provider
 * reports these, so there is no provider figure to fall back on.
 */
function historyFigure(metrics: ReadOutcome<'pool-metrics'> | null, pick: (v: Calculated) => string): Metric {
  if (!metrics) return unavailable('pool_metrics_not_requested')
  if (metrics.state !== 'ok') return unavailable(metrics.state)
  const d = metrics.data
  const v = d.valuation
  if (v.status === 'unavailable') return unavailable(v.reason)
  if (d.usableAsCurrent24h) return { value: pick(v), state: 'qualified' }
  const basis = metricsBasis(d, v)
  if (basis === 'stale') return { value: pick(v), state: 'stale', asOf: d.snapshot.timestamp }
  return { value: pick(v), state: basis, reason: basis === 'reference' ? 'reference_analytics_only' : partialReason(d, v) }
}

export interface RowReads {
  market: Extract<ReadOutcome<'pool-market'>, { state: 'ok' }>
  /** Null when not requested: pool-metrics is read only where the deployment lists it. */
  metrics: ReadOutcome<'pool-metrics'> | null
  /** Token reads by lowercase address. */
  tokens: ReadonlyMap<string, ReadOutcome<'token'>>
}

/** Everything a row is made of, whichever read it came from. */
interface RowInput {
  poolId: string
  pool: VerifiedPool
  /** The block the pool was verified at. */
  block: number
  market: MarketObservation
  /** Seconds since the provider figures were retrieved, when this answer arrived; null when unknown. */
  cacheAgeSeconds: number | null
  /** The answer the row came in: when it arrived, on both clocks. */
  answer: Extract<ReadOutcome, { state: 'ok' }>
  estimate: { data: PoolAprEstimate | null; reason: EstimateReason }
  metrics: ReadOutcome<'pool-metrics'> | null
  tokens: ReadonlyMap<string, ReadOutcome<'token'>>
  origin: 'pool-market' | 'markets-snapshot'
  /** A stored state's age when it was served. */
  servedAgeSeconds?: number
}

function projectRow(input: RowInput): Market {
  const { pool, market: m, metrics, tokens, answer } = input
  const [currency0, currency1] = pool.currencies
  const token = (address: string) => {
    const read = tokens.get(lower(address))
    return read?.state === 'ok' ? tokenDisplay(read.data.asset) : unreadToken(address)
  }
  const base = token(currency0)
  const quote = token(currency1)
  const received = answer.provenance
  const provenance: MarketProvenance = {
    block: input.block,
    market: {
      status: m.status,
      reason: m.reason,
      cacheAgeSeconds: input.cacheAgeSeconds,
      freshForSeconds: m.cache.freshForSeconds,
      receivedAt: received.receivedAt,
      ...(received.receivedMonotonic !== undefined ? { receivedMonotonic: received.receivedMonotonic } : {}),
    },
    metrics: metrics === null ? 'not_requested' : metrics.state === 'ok' ? { freshness: metrics.data.freshness.status, ageSeconds: metrics.data.freshness.ageSeconds } : null,
    fixtures: [answer, metrics, ...tokens.values()]
      .map((outcome) => outcome?.provenance.fixture)
      .filter((file): file is string => typeof file === 'string'),
    origin: input.origin,
  }
  return {
    key: identityKey(input.poolId),
    poolId: lower(input.poolId),
    base: tokenText(base),
    quote: tokenText(quote),
    tokens: { base, quote },
    feePips: pool.poolKey.feeMode === 'fixed' ? pool.poolKey.fee_pips : null,
    protocol: 'v4',
    tvlUsd: figure(metrics, m, (v) => v.tvlUsd, (data) => data.reportedLiquidityUsd),
    volume24hUsd: figure(metrics, m, (v) => v.grossInputVolumeUsd, (data) => data.volume24hUsd),

    feeAprPercent: apr(metrics),
    lpFees24hUsd: historyFigure(metrics, (v) => v.tradingLpFeesUsd),
    timeWeightedTvlUsd: historyFigure(metrics, (v) => v.timeWeightedAverageTvlUsd),
    feeAprEstimate: {
      data: input.estimate.data,
      reason: input.estimate.reason,
      receivedAt: received.receivedAt,
      receivedMonotonic: received.receivedMonotonic,
    },
    ...(m.data ? { chartTokens: { base: m.data.baseToken, quote: m.data.quoteToken } } : {}),
    // The verified pool's own state in this same answer: the price is the pool's
    // ratio from it (marketPrice.ts), never the provider's and never dollars.
    poolState: {
      sqrtPriceX96: pool.sqrtPriceX96,
      tick: pool.tick,
      tickSpacing: pool.poolKey.tick_spacing,
      block: input.block,
      currency0: lower(pool.poolKey.currency0),
      currency1: lower(pool.poolKey.currency1),
      ...(input.servedAgeSeconds !== undefined ? { servedAgeSeconds: input.servedAgeSeconds } : {}),
    },
    provenance,
  }
}

export function projectMarketRow({ market, metrics, tokens }: RowReads): Market {
  const d = market.data
  return projectRow({
    poolId: d.poolId,
    pool: d.pool,
    block: d.snapshot.number,
    market: d.market,
    cacheAgeSeconds: d.market.cache.ageSeconds,
    answer: market,
    estimate: { data: market.estimate ?? null, reason: market.estimateReason ?? 'estimate_not_enabled' },
    metrics,
    tokens,
    origin: 'pool-market',
  })
}

/** How old a stored entry was when the snapshot answered, in whole seconds. */
export interface StoredAges {
  /** Since the entry was stored. */
  servedAgeSeconds: number
  /** Since its provider figures were retrieved; null when the store reported no cache age. */
  providerAgeSeconds: number | null
}

/**
 * A stored entry's ages from the payload's own times only, never this
 * browser's clock: the store's clock when it answered is `builtAt +
 * ageSeconds`, so the entry had been held `builtAt + ageSeconds − observedAt`
 * seconds, and its provider figures were that much older than the cache age
 * they were stored with. Null when the store reports no times.
 */
export function storedAges(d: MarketsSnapshotResponse, entry: SnapshotPoolEntry): StoredAges | null {
  if (d.builtAt === null || d.ageSeconds === null) return null
  const servedAgeSeconds = Math.max(0, d.builtAt + d.ageSeconds - entry.observedAt)
  const cached = entry.market.cache.ageSeconds
  return { servedAgeSeconds, providerAgeSeconds: cached === null ? null : cached + servedAgeSeconds }
}

export interface SnapshotRowReads {
  snapshot: Extract<ReadOutcome<'markets-snapshot'>, { state: 'ok' }>
  entry: SnapshotPoolEntry
  metrics: ReadOutcome<'pool-metrics'> | null
  tokens: ReadonlyMap<string, ReadOutcome<'token'>>
}

/**
 * A row from a stored entry, as the snapshot served it. Its figures are the
 * provider's as stored, dated by the ages above and counted on from the
 * snapshot's arrival, so a stored figure turns stale on screen exactly when a
 * fresh read of the same age would. The store keeps no estimate, and none is
 * made from its inputs.
 */
export function projectSnapshotRow({ snapshot, entry, metrics, tokens }: SnapshotRowReads): Market {
  const ages = storedAges(snapshot.data, entry)
  return projectRow({
    poolId: entry.poolId,
    pool: entry.pool,
    block: entry.pool.snapshot.number,
    market: entry.market,
    cacheAgeSeconds: ages?.providerAgeSeconds ?? null,
    answer: snapshot,
    estimate: { data: null, reason: 'estimate_not_in_snapshot' },
    metrics,
    tokens,
    origin: 'markets-snapshot',
    servedAgeSeconds: ages?.servedAgeSeconds ?? 0,
  })
}
