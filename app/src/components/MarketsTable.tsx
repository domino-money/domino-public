import { Suspense, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { catalogueTokenLabel, poolListings, type PoolCatalogueEntry, type PoolListing } from '../config/selectedPoolCatalogue'
import { agedMarket, feeLabel, presentMetric, providerStale, retrievedAgeSeconds, retrievedText, type FallbackApr as Fallback, type Instant, type Market, type MarketProvenance, type Metric } from '../lib/markets'
import { presentAprEstimate } from '../lib/read/aprEstimate'
import { poolAprPresentation } from '../lib/read/poolAprPresentation'
import { FEE_VENUE_PREFIX, feeWords } from '../lib/format/fee'
import { featuredTitle } from '../lib/read/featuredList'
import { useFeatured } from '../lib/read/featuredSource'
import { pricePair } from '../lib/read/orientation'
import { READ_CURRENCIES } from '../lib/read/screens/featuredPools'
import { HIGH_FEE_PIPS, openable } from '../lib/read/tokenPools'
import { useCatalogueFallback, useFallbackRows } from '../lib/read/useFallback'
import { reasonText } from '../lib/read/describe'
import { marketPoolPrice } from '../lib/read/marketPrice'
import { isPageWide, type MarketsProvider } from '../lib/read/marketsProvider'
import { COPY } from '../lib/read/screens/copy'
import { PoolFiguresSlot, SlotBoundary, SlotFailed } from '../lib/read/screens/slots'
import type { TokenDisplay } from '../lib/read/types'
import { shownResult, useMarkets } from '../lib/read/useMarkets'
import { useNow } from '../lib/read/useNow'
import { useLoadMilestone } from '../lib/useLoadMilestone'
import { MetricCell, PendingFigure } from './explore/MetricCell'
import { InfoTip } from './InfoTip'
import { marketsHref, poolHref } from './explore/routes'
import { IconChevronRight, IconInfo } from './icons'
import { PoolCatalogueIdentity, PoolTokenLabel } from './PoolCatalogueIdentity'
import { ReadStatus, marketsStatus } from './read/ReadStatus'
import { FallbackApr } from './read/screens/FallbackApr'
import { PoolAprEstimate } from './read/screens/PoolAprEstimate'
import { TokenMarkPair } from './TokenIcon'
import { Button, Chip, FigureDash, LinkButton, Pill, Skeleton, TableShell, Td, Th, cx } from './ui'

/** The pool page for a PoolId. Identity is chain and PoolId, never a symbol. */
export { poolHref }

/**
 * Home and Markets show no status and no Retry, so while the table is on
 * screen the provider asks again on its own, quietly and bounded, and only
 * while the page is visible, for what a busy service or a flapping hop kept
 * from the rows: the one read that was busy or refused by a hop, never the
 * whole table, and the pools of a first load that met nothing but such
 * refusals (marketsProvider.ts). Any other failure is left as it is, and the
 * rows already say what is unavailable. The read lab has its own Refresh and
 * Retry and asks nothing on its own.
 */
function useQuietRecovery(provider: MarketsProvider, enabled: boolean) {
  useEffect(() => (enabled ? provider.recoverQuietly?.() : undefined), [provider, enabled])
}

export interface MarketsFilter {
  /** A token address, lowercase, or null for every token. */
  asset: string | null
  /** Words of a pair name, matched without case, spaces or slashes. */
  query: string
}

/**
 * Where a row's figures came from: the block the pool was verified at, and
 * what the market data provider reported, dated by when it was retrieved,
 * or why it has nothing to show. Never "as of" or "updated at": the
 * provider's own update time is not known. The provider is the part it
 * plays, never its name.
 */
function provenanceLine(p: MarketProvenance, age: number | null, stale: boolean) {
  const verified = `Pool verified on-chain at block ${p.block}`
  const market =
    p.market.status === 'available' || p.market.status === 'stale'
      ? `Reported by a market data provider, ${retrievedText(age)}${stale ? ' · stale' : ''}`
      : `Provider figures ${p.market.status}: ${reasonText(p.market.reason)}`
  if (p.metrics === 'not_requested') return `${verified} · ${market}`
  const metrics = p.metrics ? `Domino history ${p.metrics.freshness}, ${p.metrics.ageSeconds} s` : 'Domino history unavailable'
  return `${verified} · ${market} · ${metrics}`
}

/**
 * The whole row opens the pool page, the way a markets table does. The pool's
 * name is a real link, so the keyboard and assistive technology reach the
 * page through it; a plain click anywhere else on the row follows the same
 * link. Clicks on the row's own controls, modified clicks and a text
 * selection are left alone.
 */
function followRow(event: MouseEvent<HTMLTableRowElement>, href: string) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  if ((event.target as Element).closest('a, button')) return
  if (window.getSelection()?.toString()) return
  window.location.hash = href.slice(1)
}

/** A token's name as a row shows it: the read symbol, the catalogue's label for its address, or its short address. */
const nameOf = (token: TokenDisplay) => token.symbol ?? catalogueTokenLabel(token) ?? `${token.address.slice(0, 6)}…${token.address.slice(-4)}`

/** Letters and digits only, lowercase: "WETH / USDG", "WETHUSDG" and "weth usdg" are one name. */
const squeeze = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

function holds(listing: PoolListing, asset: string) {
  const key = asset.toLowerCase()
  if (listing.market) return [listing.market.tokens.base, listing.market.tokens.quote].some((token) => token.address.toLowerCase() === key)
  // A catalogue row names its tokens only where its labels are bound to addresses, or where its pool's Initialize event
  // named them (the embedded ETH/USDG row: lib/read/screens/featuredPools.ts READ_CURRENCIES; audit B9, 2026-10-01).
  const addresses = listing.catalogue?.addresses ?? READ_CURRENCIES[listing.poolId.toLowerCase()]
  return addresses?.some((address) => address.toLowerCase() === key) ?? false
}

/** Whether a listing passes the Markets filters. Nothing is read to decide. */
export function matchesFilter(listing: PoolListing, filter: MarketsFilter) {
  if (filter.asset !== null && !holds(listing, filter.asset)) return false
  const needle = squeeze(filter.query)
  if (needle === '') return true
  const named = listing.market ? pricePair(listing.market.tokens.base, listing.market.tokens.quote) : null
  const pair = named ? `${nameOf(named.base)}/${nameOf(named.quote)}` : (listing.catalogue?.labels.join('/') ?? '')
  // Either way round: "usdg eth" finds ETH/USDG as it always did.
  const reversed = named ? `${nameOf(named.quote)}/${nameOf(named.base)}` : [...(listing.catalogue?.labels ?? [])].reverse().join('/')
  return squeeze(pair).includes(needle) || squeeze(reversed).includes(needle)
}

/** What a row's pool is flagged for, in words a beginner reads (audit V2): a very high fee, or no positions here. */
export function rowFlags(m: Pick<Market, 'integration' | 'hooks' | 'feePips'>): Array<{ key: 'fee' | 'closed'; text: string; title: string }> {
  const flags: Array<{ key: 'fee' | 'closed'; text: string; title: string }> = []
  if (m.feePips !== null && m.feePips > HIGH_FEE_PIPS) flags.push({ key: 'fee', text: 'Very high fee', title: 'This pool takes more than 10% of every swap. That is unusual, and most pools with fees like this see little real trading.' })
  if (!openable(m)) flags.push({ key: 'closed', text: 'Domino can’t open positions here', title: 'This pool runs extra code on every swap (hooks) or changes its fee over time. Domino opens positions only in standard pools.' })
  return flags
}

/**
 * The pool's price as the chain holds it, the way a person reads a price:
 * "1 cbBTC =" over "84,367 USDG" (lib/read/marketPrice.ts chooses which token
 * is the one). Unavailable says why in its title. Until the row's token reads
 * have settled there are no decimals to write it with yet, which is no reason
 * to call it unavailable: the cell waits quietly instead.
 */
function PriceCell({ market, now }: { market: Market; now: Instant }) {
  const price = marketPoolPrice(market, now)
  if (price.state === 'unavailable' && price.problem === 'decimals_unknown' && market.tokensPending) {
    return <PendingFigure label="Price" data={{ 'data-pool-price': 'loading' }} />
  }
  if (price.state === 'unavailable') {
    const why = price.problem === 'not_read' ? 'The pool’s state was not in this read.' : COPY.range.problems[price.problem]
    return (
      <span className="text-fg-subtle" data-pool-price="unavailable" title={why}>
        Unavailable
      </span>
    )
  }
  const title = `The pool’s own price on Robinhood Chain, at block ${price.block}.${price.stale ? ' Stale, not current.' : ''}`
  return (
    <span className="dm-mkt-price" data-pool-price={price.stale ? 'stale' : 'usable'} title={title}>
      <span className="dm-mkt-price-unit">
        1 <PoolTokenLabel token={price.base} /> =
      </span>
      <span className="tnum font-medium text-fg">
        {price.text} <PoolTokenLabel token={price.quote} />
      </span>
      {price.stale && <span className="sr-only" data-saved-data="price">Last available price; see Details for its time.</span>}
    </span>
  )
}

function Row({ m: read, now, full, onFigures, poolToken, pinned }: { m: Market; now: Instant; full: boolean; onFigures: () => void; poolToken?: string | null; pinned: boolean }) {
  const p = read.provenance
  const age = p ? retrievedAgeSeconds(p.market, now) : null
  const stale = p ? providerStale(p.market, now) : false
  const retrieved = retrievedText(age)
  // The same projection the figures dialog is given, so the row and the dialog
  // it opens never disagree about whether a figure is still current.
  const m = agedMarket(read, now)
  const href = poolHref(m.poolId, poolToken ?? null)
  const line = p ? provenanceLine(p, age, stale) : undefined
  // Domino's own qualified history when there is one; the attributed backend estimate otherwise, marked as one.
  const apr = poolAprPresentation(m, now)
  const qualified = apr.qualified
  // Figures the store is about to collect (marketsProvider.ts, catch-up): a quiet placeholder where they will land,
  // never "Unavailable" while they are coming. Only a figure that would say unavailable waits.
  const coming = (metric: Metric) => read.figuresPending === true && presentMetric(metric).kind === 'unavailable'
  // An estimate standing in for the read service's (audit V1, lib/read/figureFallback.ts), where its own has no figure.
  const standIn = apr.fallback
  const aprComing = apr.pending
  const tvlFigure = presentMetric(m.tvlUsd)
  const volumeFigure = presentMetric(m.volume24hUsd)
  const estimateFigure = presentAprEstimate(m.feeAprEstimate, now)
  const savedFigures = [
    tvlFigure.kind === 'value' && tvlFigure.stale ? 'TVL' : null,
    volumeFigure.kind === 'value' && volumeFigure.stale ? '24h volume' : null,
    qualified ? m.feeAprPercent.state === 'stale' ? 'APR' : null
      : standIn ? standIn.basis === 'kept' || standIn.basis === 'selection' ? 'APR estimate' : null
      : estimateFigure.text !== null && estimateFigure.state === 'stale' ? 'APR estimate' : null,
  ].filter(Boolean)
  useLoadMilestone(['overview', 'markets'], 'tvl', tvlFigure.kind === 'value' ? tvlFigure.stale ? 'cached' : 'current' : null)
  useLoadMilestone(['overview', 'markets'], 'volume', volumeFigure.kind === 'value' ? volumeFigure.stale ? 'cached' : 'current' : null)
  useLoadMilestone(['overview', 'markets'], 'apr', qualified ? m.feeAprPercent.state === 'stale' ? 'cached' : 'current' : estimateFigure.text !== null ? estimateFigure.state === 'stale' ? 'cached' : 'estimated' : null)
  // Named as its price is written, "TOKEN/USDG" beside "1 TOKEN = X USDG" (audit E21).
  const pair = pricePair(m.tokens.base, m.tokens.quote)
  const flags = rowFlags(m)
  const name = (
    <>
      <PoolTokenLabel token={pair.base} />/<PoolTokenLabel token={pair.quote} />
    </>
  )
  return (
    // A read row fades in as it replaces its catalogue stand-in (M20). The fade is on the row: an opacity animation on
    // cell contents left some columns half-drawn in Edge's full-page captures.
    <tr className="dm-mkt-row animate-fade" onClick={(event) => followRow(event, href)} data-pool-row={full ? m.poolId : undefined} data-row-source={p?.origin}>
      <Td>
        <div className="dm-mkt-pool">
          <span className="dm-mkt-marks">
            <TokenMarkPair base={pair.base} quote={pair.quote} size={32} ring="var(--dm-mkt-ring)" />
          </span>
          {/* Where the figures came from stays on the row, as its title and as data, never as a
              printed line under the name: one hover, or the figures dialog, away. */}
          <div className="dm-mkt-ident" data-provenance={line} title={line}>
            <a href={href} className="dm-mkt-name">
              <span className="font-medium">{name}</span>
            </a>
            {/* The fee as every chip writes it (lib/format/fee.ts, audit E21); a phone keeps the fee and drops "Uniswap · ". */}
            <Chip className="dm-mkt-venue">
              <span className="dm-fee-venue">{FEE_VENUE_PREFIX}</span>
              {feeWords(feeLabel(m))}
            </Chip>
            {pinned && <PinnedChip />}
            {savedFigures.length > 0 && <span className="sr-only" data-saved-data="figures">Last available {savedFigures.join(', ')}; sources and times in Details.</span>}
            {flags.map((flag) => (
              <Chip key={flag.key} className="dm-mkt-venue dm-mkt-flag" data-pool-flag={flag.key} title={flag.title}>
                {flag.text}
              </Chip>
            ))}
          </div>
        </div>
      </Td>
      <Td numeric col="wide" className="dm-mkt-num">
        <PriceCell market={m} now={now} />
      </Td>
      <Td numeric className="dm-mkt-num">
        {coming(m.tvlUsd) ? <PendingFigure label="TVL" data={{ 'data-metric': 'pending' }} /> : <MetricCell metric={m.tvlUsd} retrieved={retrieved} />}
      </Td>
      <Td numeric col="wide" className="dm-mkt-num dm-mkt-volume">
        {coming(m.volume24hUsd) ? <PendingFigure label="24h volume" data={{ 'data-metric': 'pending' }} /> : <MetricCell metric={m.volume24hUsd} retrieved={retrieved} />}
      </Td>
      <Td numeric className="dm-mkt-num dm-mkt-apr">
        {qualified ? (
          <MetricCell metric={m.feeAprPercent} percent tone="in" />
        ) : aprComing ? (
          <PendingFigure label="APR" data={{ 'data-apr-estimate': 'pending' }} />
        ) : standIn ? (
          <FallbackApr apr={standIn} compact />
        ) : (
          <PoolAprEstimate observation={m.feeAprEstimate} now={now} compact />
        )}
      </Td>
      <Td numeric className="dm-mkt-end">
        <span className="dm-row-end">
          <span className="dm-row-actions">
            {/* The pool's figures, with their sources and ages, on demand. Nothing is read to open them. */}
            <button
              type="button"
              data-pool-figures=""
              onClick={(event) => {
                event.stopPropagation()
                onFigures()
              }}
              className="dm-icon-btn dm-icon-btn--ghost dm-icon-btn--sm dm-press-icon"
            >
              <IconInfo />
              <span className="sr-only">Details: figures and sources for {name}</span>
            </button>
          </span>
          <IconChevronRight size={14} />
        </span>
      </Td>
    </tr>
  )
}

/** A row resting while the list's first answer is out (audit B4): no name, no figure, the height of a row. */
function RestingRow() {
  const bubble = (className: string) => <Skeleton className={cx('dm-mkt-bubble', className)} />
  return (
    <tr className="dm-mkt-row" data-row-loading="">
      <Td>
        <span className="dm-mkt-pool">
          <Skeleton className="dm-mkt-bubble dm-mkt-bubble--marks h-8 w-12 rounded-full" />
          {bubble('dm-mkt-bubble--figure')}
        </span>
      </Td>
      <Td numeric col="wide">
        <span className="dm-mkt-bubbles">{bubble('dm-mkt-bubble--price')}{bubble('dm-mkt-bubble--unit')}</span>
      </Td>
      <Td numeric>{bubble('dm-mkt-bubble--figure')}</Td>
      <Td numeric col="wide" className="dm-mkt-volume">{bubble('dm-mkt-bubble--figure')}</Td>
      <Td numeric>{bubble('dm-mkt-bubble--apr')}</Td>
      <Td numeric className="dm-mkt-end" />
    </tr>
  )
}

const NO_MARKETS: readonly Market[] = []
const NO_IDS: readonly string[] = []
const NO_ENTRIES: readonly PoolCatalogueEntry[] = []

/**
 * A featured list's pinned pool, under its criterion title only (§11.7, option B): pinned by the owner, not ranked.
 * A chip with words, never a colour alone.
 */
function PinnedChip() {
  // Its meaning in a title (audit E14, 2026-10-01): the chip alone did not say who pinned it, or why it is listed.
  return (
    <Chip className="dm-mkt-venue" data-pinned="" title="Chosen by Domino for today’s list, not ranked by the list’s rules.">
      Pinned
    </Chip>
  )
}

/**
 * A pool from the list on screen whose live row has not arrived: its
 * labels only, every figure a dash. It still opens its pool page.
 */
function CatalogueRow({ poolId, entry, full, loading, token, pinned, standIn }: {
  poolId: string
  entry: PoolCatalogueEntry
  full: boolean
  loading: boolean
  token: string | null
  pinned: boolean
  /** Figures standing in for the ones the read service has not given (audit V1, lib/read/figureFallback.ts): dated, attributed. */
  standIn?: { tvl: Metric | null; volume: Metric | null; apr: Fallback | null }
}) {
  const href = poolHref(poolId, token)
  // While the first markets read is out, or briefly while the store is about to collect the pool for the first time
  // (2026-09-28), each figure rests as a bubble at its text line's size, so the row keeps its height and nothing reads
  // as missing; once it has settled without a row, the dashes say what is unavailable. A figure this browser or DEX
  // Screener has for the pool, or today's selection's, stands in for either, dated and attributed in its title.
  const bubble = (className: string) => <Skeleton className={cx('dm-mkt-bubble', className)} />
  const tvl = standIn?.tvl ?? null
  const volume = standIn?.volume ?? null
  const apr = standIn?.apr ?? null
  // The name's title says figures are unavailable only when none stands in (fix round 1): beside stand-in figures it
  // said the opposite of the row. Each stand-in names its source and time in its own title.
  const standing = tvl !== null || volume !== null || apr !== null
  const saved = [tvl, volume].some((metric) => metric?.state === 'stale' && metric.value !== null) || apr?.basis === 'kept' || apr?.basis === 'selection'
  return (
    <tr className="dm-mkt-row" data-pool-catalogue={poolId} data-pool-row={full ? poolId : undefined} data-row-loading={loading ? '' : undefined} onClick={(event) => followRow(event, href)}>
      <Td>
        <a href={href} className="dm-mkt-pool dm-mkt-name" title={standing ? 'Listed on Uniswap. Its live figures are not in yet; each figure shown stands in, with its source and time.' : 'Listed on Uniswap. Pool figures are unavailable.'}>
          <PoolCatalogueIdentity entry={entry} />
        </a>
        {pinned && <PinnedChip />}
        {saved && <span className="sr-only" data-saved-data="figures">Last available figures; sources and times in Details.</span>}
      </Td>
      <Td numeric col="wide">
        {loading ? <span className="dm-mkt-bubbles">{bubble('dm-mkt-bubble--price')}{bubble('dm-mkt-bubble--unit')}</span> : <FigureDash reason="Price unavailable" />}
      </Td>
      <Td numeric>
        {tvl ? <MetricCell metric={tvl} /> : loading ? bubble('dm-mkt-bubble--figure') : <FigureDash reason="TVL unavailable" />}
      </Td>
      <Td numeric col="wide" className="dm-mkt-volume">
        {volume ? <MetricCell metric={volume} /> : loading ? bubble('dm-mkt-bubble--figure') : <FigureDash reason="24h volume unavailable" />}
      </Td>
      <Td numeric>
        {apr ? <FallbackApr apr={apr} compact /> : loading ? bubble('dm-mkt-bubble--apr') : <FigureDash reason="Pool APR unavailable" />}
      </Td>
      <Td numeric className="dm-mkt-end">
        <span className="dm-row-end">
          <IconChevronRight size={14} />
        </span>
      </Td>
    </tr>
  )
}

/**
 * The selected pools, in the reviewed catalogue's order, which is not a
 * ranking: Home's `featured` card ("Selected pools" and the way to Markets;
 * Refresh only in the read lab) and the Markets page's `full` table, filtered
 * by token and pair name. Every figure comes from a validated read and names
 * its provider and age; the price is the pool's own ratio from chain state;
 * backend estimates stay separate from qualified historical APR, and missing
 * figures stay unavailable. The table reads nothing itself: the app's one
 * markets provider does.
 */
export function MarketsTable({
  variant = 'featured',
  filter,
  onMatchCount,
  empty,
  diagnostics = false,
  includeCatalogue = true,
  poolToken,
}: {
  variant?: 'featured' | 'full'
  /** Full only. */
  filter?: MarketsFilter
  /** Full only: how many listings pass the filter, of how many. */
  onMatchCount?: (count: number, total: number) => void
  /** Full only: what stands in for the rows when the filter matches none of them. */
  empty?: ReactNode
  /**
   * The read lab only: the status panel, Refresh and Retry, so every read
   * state can be seen and driven. Home and Markets show the pools and their
   * figures and nothing else; a busy read service is asked again on its own.
   */
  diagnostics?: boolean
  /** Token explorer pages already define their complete bounded selection. */
  includeCatalogue?: boolean
  /** Preserve an arbitrary pool's verified token in its shareable link. */
  poolToken?: string
}) {
  const full = variant === 'full'
  const { state, provider } = useMarkets()
  useQuietRecovery(provider, !diagnostics)
  const result = shownResult(state)
  // The list on screen (lib/read/featuredSource.ts): the featured list with its title, or the embedded one with today's.
  const featured = useFeatured()
  const listed = includeCatalogue && __DOMINO_POOL_SET__ === 'selected' && provider.kind === 'bridge'
  const read = result?.markets ?? NO_MARKETS
  const now = useNow(read.length > 0)
  // Refused figures stood in for: this browser's last ones, DEX Screener's, today's selection's (audit V1).
  const markets = useFallbackRows(read, listed ? featured.entries : null, now)
  // Until the list's first answer is in, the embedded list only holds its place: resting rows with no names, under a
  // resting title, rather than six pools that are not today's (audit B4, 2026-10-01).
  const unsettled = listed && !featured.settled
  const listings = unsettled ? [] : poolListings(markets, listed ? featured.entries : null)
  const ranked = listed && featured.source === 'server'
  const title = featuredTitle(listed ? featured.source : 'bundled')
  const matches = full && filter ? listings.filter((listing) => matchesFilter(listing, filter)) : listings
  // Pools still without a row once the markets read has settled (still being collected, or refused): their stand-ins.
  // Not while the first read is out (every pool is rowless then, and nothing is wrong with any of them yet), nor when
  // the page itself cannot read (the gate, live data not connected): no figure is shown where no read has answered.
  const answered = state.phase === 'ready' || (state.phase === 'failed' && !isPageWide(state.failure))
  const rowless = answered ? listings.flatMap((listing) => (!listing.market && listing.catalogue ? [listing.poolId] : [])) : NO_IDS
  const standIns = useCatalogueFallback(listed ? featured.entries : NO_ENTRIES, rowless, now)
  // The pool whose figures are open, held by key rather than by value: the
  // projection is taken again on every tick, so an open dialog ages with the
  // row behind it instead of keeping the market as it was when it opened.
  const [figuresKey, setFiguresKey] = useState<string | null>(null)
  const figures = figuresKey === null ? null : (markets.find((m) => m.key === figuresKey) ?? null)
  // Folded away in every build but the fixture one, with the words it would show.
  const fixtures = __DOMINO_READ_MODE__ === 'fixture' && provider.kind === 'fixture'

  // After a successful retry the Retry button goes away; focus moves to the heading instead of the page.
  // Refresh stays mounted (busy) while its own read runs, so it keeps focus; if that read fails, Refresh
  // gives way to Retry and focus moves to the heading rather than falling to the page.
  const heading = useRef<HTMLHeadingElement>(null)
  const retried = useRef(false)
  const refreshed = useRef(false)
  useEffect(() => {
    if (state.phase === 'ready' && retried.current) {
      retried.current = false
      heading.current?.focus()
    }
    if (state.phase !== 'loading' && refreshed.current) {
      refreshed.current = false
      const lost = !document.activeElement || document.activeElement === document.body
      if (state.phase === 'failed' && lost) heading.current?.focus()
    }
  }, [state.phase])
  const retry = () => {
    retried.current = true
    provider.refresh()
  }
  // A refresh of rows on screen: loading with the previous rows kept and no failure being retried.
  const refreshing = state.phase === 'loading' && state.previous !== null && state.retrying === null
  const refresh = () => {
    if (refreshing) return
    refreshed.current = true
    provider.refresh()
  }

  // The count is the page's to show; the latest callback is kept so an inline one does not re-run this.
  const counted = useRef(onMatchCount)
  useEffect(() => {
    counted.current = onMatchCount
  }, [onMatchCount])
  const matchCount = matches.length
  const total = listings.length
  useEffect(() => {
    counted.current?.(matchCount, total)
  }, [matchCount, total])

  const lean = markets.length > 0 && markets.every((m) => m.provenance?.metrics === 'not_requested')
  // A filter that changes which pools are listed remounts the rows, so they cross-fade in rather than jump;
  // A daily reorder keeps those rows mounted, preserving focus on a surviving pool.
  const filtering = full ? matches.map((listing) => listing.poolId).sort().join(',') : 'all'
  const nothingMatches = full && total > 0 && matchCount === 0

  const notice = diagnostics && (fixtures || result?.notice) && (
    <p className="dm-mkt-notice">
      {fixtures && <Pill tone="wait">Fixture data</Pill>}
      {result?.notice && <span>{result.notice}</span>}
    </p>
  )
  const said = marketsStatus(state)
  const status = diagnostics ? <ReadStatus status={said} onRetry={retry} /> : <ReadStatus status={said} quiet />

  // Changed on purpose 2026-10-03 (the owner): a short list no longer says "5 of 6 today" over the table. It raised a
  // question the screen can't answer, and a list carried over from an earlier day made its "today" untrue.
  const table = (
    <TableShell
      label={title}
      className="dm-mkt-table"
      title={full ? undefined : unsettled ? <Skeleton className="dm-mkt-title-skel h-5 w-40" /> : title}
      data={{
        'featured-source': unsettled ? 'pending' : listed ? featured.source : 'bundled',
        ...(listed && featured.listId !== null ? { 'featured-list-id': featured.listId } : {}),
        ...(listed && featured.revision !== null ? { 'featured-revision': String(featured.revision) } : {}),
        ...(listed && featured.selectionDate !== null ? { 'featured-selection-date': featured.selectionDate } : {}),
        ...(listed && featured.effectiveAt !== null ? { 'featured-effective-at': String(featured.effectiveAt) } : {}),
        ...(nothingMatches ? { 'filter-empty': '' } : {}),
      }}
      titleRef={full ? undefined : heading}
      action={
        full ? undefined : (
          <>
            {diagnostics && (state.phase === 'ready' || refreshing) && markets.length > 0 && (
              <Button variant="ghost" size="sm" aria-disabled={refreshing ? true : undefined} onClick={refresh}>
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </Button>
            )}
            <LinkButton href={marketsHref()} variant="ghost" size="sm">
              Find more pools
              <IconChevronRight size={14} />
            </LinkButton>
          </>
        )
      }
      status={
        full ? undefined : (
          <>
            {notice}
            {status}
          </>
        )
      }
      rowHeight={64}
      surface="flat"
      // With no rows to scroll, the token search's list may open past the card's edge (markets.css): `filter-empty` above.
    >
      <thead>
        <tr>
          <Th>Pool</Th>
          <Th numeric col="wide" className="dm-mkt-col-price">
            Price
          </Th>
          <Th numeric className="dm-mkt-col-tvl">
            {/* What the letters stand for, in a title (audit E5, 2026-10-01): the pool page says it under its own TVL. */}
            <InfoTip label="About TVL" text="Estimated value held in this pool.">TVL</InfoTip>
            {lean && <span className="sr-only">{' reported by a market data provider'}</span>}
          </Th>
          <Th numeric col="wide" className="dm-mkt-col-volume">
            24h volume{lean && <span className="sr-only">{' reported by a market data provider'}</span>}
          </Th>
          {/* APR stays on a phone: it is the figure people come for (DESIGN-V2 §8.4). */}
          <Th numeric className="dm-mkt-col-apr">
            <InfoTip label="About pool APR" text="Annualized pool fees from the last 24 hours. Estimates are marked ‘est.’ Not a forecast.">APR</InfoTip>
          </Th>
          <Th numeric className="dm-mkt-end">
            <span className="sr-only">Details</span>
          </Th>
        </tr>
      </thead>
      {matchCount > 0 && (
        <tbody key={filtering} className={full ? 'animate-fade' : undefined}>
          {matches.map(({ poolId, market, catalogue, token }) =>
            market ? (
              <Row key={poolId} m={market} now={now} full={full} onFigures={() => setFiguresKey(market.key)} poolToken={poolToken ?? token} pinned={ranked && catalogue?.pinned === true} />
            ) : catalogue ? (
              // A pool the store is about to collect for the first time keeps its placeholder briefly (marketsProvider.ts).
              <CatalogueRow key={poolId} poolId={poolId} entry={catalogue} full={full} loading={state.phase === 'loading' || (state.phase === 'ready' && state.placeholders?.includes(poolId.toLowerCase()) === true)} token={token} pinned={ranked && catalogue.pinned === true} standIn={standIns.get(poolId)} />
            ) : null,
          )}
        </tbody>
      )}
      {unsettled && (
        <tbody aria-hidden="true" data-featured-pending="">
          {Array.from({ length: Math.min(6, Math.max(read.length, 4)) }, (_, index) => <RestingRow key={index} />)}
        </tbody>
      )}
      {nothingMatches && (
        <tfoot>
          <tr>
            <td colSpan={6}>{empty}</td>
          </tr>
        </tfoot>
      )}
      {total === 0 && !unsettled && (
        // Never a body row: a table with nothing read has no rows, and says so under the header.
        <tfoot>
          <tr>
            <td colSpan={6} className="text-center text-fg-subtle">
              {state.phase === 'loading' ? (
                <Skeleton className="mx-auto h-10 max-w-[30rem]" />
              ) : state.phase === 'ready' && state.problems.length === 0 ? (
                empty ?? <span data-empty="no-pools">{state.acquiring ? 'Pool data is being collected.' : 'No pools selected yet.'}</span>
              ) : (
                'Pool data unavailable'
              )}
            </td>
          </tr>
        </tfoot>
      )}
    </TableShell>
  )

  return (
    <>
      {full ? (
        <div data-selected-pools="">
          {notice}
          <div className={diagnostics && said ? 'mb-3' : undefined}>{status}</div>
          {table}
        </div>
      ) : (
        table
      )}
      {figures && PoolFiguresSlot && SlotBoundary && SlotFailed && (
        <SlotBoundary fallback={<SlotFailed />}>
          <Suspense fallback={null}>
            <PoolFiguresSlot market={agedMarket(figures, now)} onClose={() => setFiguresKey(null)} />
          </Suspense>
        </SlotBoundary>
      )}
    </>
  )
}
