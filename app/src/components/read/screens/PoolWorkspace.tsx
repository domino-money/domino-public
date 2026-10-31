import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { agedMarket, percentText, presentMetric, type Metric } from '../../../lib/markets'
import { presentAprEstimate } from '../../../lib/read/aprEstimate'
import { projectMarketRow } from '../../../lib/read/project'
import { overviewPoolOption, storedPoolRead } from '../../../lib/read/publicOverview'
import { whenVisibleAfter } from '../../../lib/read/screens/quietRead'
import { COPY } from '../../../lib/read/screens/copy'
import { protocolFee } from '../../../lib/read/screens/figures'
import { NATIVE_CURRENCY } from '../../../lib/read/screens/identity'
import { poolPrice, presetFor } from '../../../lib/read/screens/poolRange'
import { optionUsableForDomino, type PoolOption } from '../../../lib/read/screens/poolsList'
import { askAgainLater, readWithin, type ScreenOutcome } from '../../../lib/read/screens/screenRead'
import type { ReadOutcome, ReadRequests, ReadSource } from '../../../lib/read/types'
import { usePoolStandIns, useFallbackRow } from '../../../lib/read/useFallback'
import { useNow } from '../../../lib/read/useNow'
import { APR_SLIVER, aprDigits } from '../../../lib/format/apr'
import { FEE_VENUE, feeWords } from '../../../lib/format/fee'
import { networkName } from '../../../lib/networkName'
import { useLoadMilestone } from '../../../lib/useLoadMilestone'
import { FEE_MEANING } from '../../explore/feeMeaning'
import { InfoTip } from '../../InfoTip'
import { MetricCell, TurnoverCell } from '../../explore/MetricCell'
import { PoolTokenLabel } from '../../PoolCatalogueIdentity'
import { TokenMarkPair } from '../../TokenIcon'
import { FigureDash, Skeleton, Stat, StatStrip } from '../../ui'
import { PoolActivitySummary } from '../../pool/PoolActivitySummary'
import { ExplorerAddress } from '../../pool/ExplorerAddress'
import { PoolAutomation } from '../../pool/PoolAutomation'
import { PoolEarnings } from '../../pool/PoolEarnings'
import { PoolRangeGuide } from '../../pool/PoolRangeGuide'
import { isUsdg, numberOf, priceAt, quoteSide, rangeGuide, type DaySpan } from '../../pool/plain'
import { Address } from './Address'
import { CopyButton } from './CopyButton'
import { FallbackApr } from './FallbackApr'
import { PoolActivityCard } from './PoolActivityCard'
import { PoolAprEstimate } from './PoolAprEstimate'
import { PoolPositionsCard } from './PoolPositionsCard'
import { PoolHistoryChart } from './LazyPoolHistoryChart'
import { ProviderFigure } from './ProviderFigure'
import { SymbolText } from './SymbolText'

/*
 * This file is loaded by tests/pool-workspace.test.mjs with every import but
 * React replaced by a fixed list of stubs, and React by useState, useRef,
 * useCallback and useEffect only. Everything else it draws comes through
 * class names (styles/shell.css, styles/pool.css).
 */

/** The routes this page reads only where the page's capabilities list them. */
type Optional = 'markets-snapshot' | 'pool-metrics' | 'pool-activity' | 'pool-positions' | 'overview'
type Listed = Record<Optional, boolean>
const OPTIONAL: readonly Optional[] = ['markets-snapshot', 'pool-metrics', 'pool-activity', 'pool-positions', 'overview']
const NOTHING_LISTED: Listed = { 'markets-snapshot': false, 'pool-metrics': false, 'pool-activity': false, 'pool-positions': false, overview: false }

/**
 * How often the page asks the stored overview again (round 6): every 5 s only while the store is still collecting the
 * pool, every 30 s while collection is refused at capacity, and once a minute once the pool's figures are stored, the
 * pace the Markets table keeps. It used to ask every 5 s for as long as the page stayed open.
 */
export const OVERVIEW_EVERY = { collecting: 5_000, refused: 30_000, settled: 60_000 } as const
/**
 * The fast asks while the store collects the pool are this many at the most (audit A12, 2026-10-01); after them the page
 * asks at the settled pace. A pool the store never collects used to be asked every 5 s for as long as the page was open.
 */
export const COLLECTING_ASKS = 12

/** Uniswap's usual fixed fee tiers, in pips (0.01%, 0.05%, 0.30%, 1.00%): any other fixed fee is said to be non-standard (N72). */
const STANDARD_FEE_PIPS: ReadonlySet<number> = new Set([100, 500, 3000, 10_000])

/** Which optional routes are listed, from the source's capabilities answer: no read, no place in the queue. A failed answer lists nothing. */
async function listedRoutes(source: ReadSource, signal: AbortSignal): Promise<Listed> {
  const check = source.routeEnabled
  if (!check) return NOTHING_LISTED
  const routes = source.supportsStoredReads ? OPTIONAL : OPTIONAL.filter((route) => route !== 'overview')
  const answers = await Promise.all(routes.map((route) => check.call(source, route, { signal }).then((answer) => answer.state === 'enabled', () => false)))
  return { 'markets-snapshot': answers[0], 'pool-metrics': answers[1], 'pool-activity': answers[2], 'pool-positions': answers[3], overview: answers[4] ?? false }
}

type OkMarket = Extract<ReadOutcome<'pool-market'>, { state: 'ok' }>
/** The page's market figures for one pool: the last good answer and which read it was, and the last failure since. */
/** `accepted` is the producer's own word on whether it took the acquisition on; false is its capacity ceiling, not a failure. */
type MarketAnswer = { key: string; ok: OkMarket | null; origin: 'stored' | 'read' | 'overview' | null; acquiring?: boolean; accepted?: boolean; failure: Exclude<ScreenOutcome<'pool-market' | 'overview'>, { state: 'ok' | 'aborted' }> | null }

/**
 * A stored answer's provider figures as the page shows them until the pool's
 * own read lands. The read service serves the market observation exactly as
 * it stored it: its cache age dates from when it was stored, and nothing in
 * the answer says how long the store has held it since (read_service.py,
 * pool_market from_snapshot). So their retrieval age is unknown and they are
 * stale: normal type, with that in their title, never "retrieved 0 s ago".
 * Nothing else about the answer changes.
 */
function storedFigures(outcome: OkMarket): OkMarket {
  const market = outcome.data.market
  if (market.status !== 'available' && market.status !== 'stale') return outcome
  return { ...outcome, data: { ...outcome.data, market: { ...market, status: 'stale', cache: { ...market.cache, ageSeconds: null } } } }
}

/** A screen outcome as a read outcome: the screen's own budget reads as the read deadline it is. */
function asRead<R extends 'pool-metrics'>(outcome: ScreenOutcome<R>, source: ReadSource): ReadOutcome<R> {
  if (outcome.state !== 'local') return outcome
  return { route: outcome.route, state: 'unavailable', cause: { kind: 'read_deadline', limit: 'read' }, retryable: true, provenance: { transport: source.transport, contract: null, receivedAt: 0, attempts: 0 } }
}

/**
 * One chain read of this pool, once the market figures have answered and only
 * where the route is listed; asked again on its own, quietly and a few times,
 * when the read service was busy or briefly out. Cancelled when the page goes.
 */
function useChainRead<R extends 'pool-metrics' | 'pool-activity' | 'pool-positions'>(source: ReadSource, route: R, poolId: string, when: boolean): ScreenOutcome<R> | null {
  const [answer, setAnswer] = useState<{ key: string; outcome: ScreenOutcome<R> } | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!when) return
    const controller = new AbortController()
    const { signal } = controller
    void readWithin(source, route, { poolId } as ReadRequests[R], { signal }).then(async (outcome) => {
      if (signal.aborted || outcome.state === 'aborted') return
      setAnswer({ key: poolId, outcome })
      if (outcome.state !== 'ok' && (await askAgainLater(outcome, attempt, signal))) setAttempt((n) => n + 1)
    })
    return () => controller.abort()
  }, [source, route, poolId, when, attempt])
  return answer?.key === poolId ? answer.outcome : null
}

/** Where stand-in figures come from (audit V1), in a few words for Details; null for the read service's own. */
function figuresFrom(metric: Metric): string | null {
  switch (metric.fallback) {
    // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): figures kept from an earlier read are named by
    // where they came from, as their title does (MetricCell fallbackTitle), no longer "Last figures this browser saw".
    case 'kept':
      return 'Market data provider'
    case 'dexscreener':
    case 'discovered':
      return 'DEX Screener'
    case 'selection':
      return 'Today’s selection of Top pools'
    default:
      return null
  }
}

/** Why Domino opens no position in a pool, in words. */
function refusal(option: PoolOption): string {
  if (option.hooks !== NATIVE_CURRENCY) return 'it runs extra code on every swap (hooks)'
  if (option.fee === 'Dynamic') return 'its fee changes over time'
  return 'it is not a standard pool'
}

/**
 * One verified pool on its own page, for someone who knows nothing about
 * liquidity pools (round 6, the owner): what the pool is and what it earns,
 * in one sentence under its name; the four figures that say how much it earns,
 * how busy and how big it is and its price; its price chart beside an
 * estimate of what an amount could earn; a typical range and what Domino can
 * do here; the last day in words; and everything technical in one closed
 * Details card at the end. Its figures come from the page's own reads, in
 * order, one at a time through the shared queue: the market figures (from the
 * read service's stored snapshot first, where it keeps one, then the pool's
 * own lean read, which brings the estimate), then Domino's 24h history, the
 * pool's chain activity and its positions, each only where this page's
 * capabilities list it. Nothing on the page says how a read went: a busy or
 * briefly unavailable read is asked again on its own, and a figure with no
 * answer is a dash with the reason in its title. `actions` is the caller's
 * way onward (a route into the new-position flow); nothing here deposits,
 * signs or quotes. A pool Domino can't open positions in (hooks, or a fee that
 * changes) has no estimate and no typical range: what Domino can do here says
 * why, beside its chart.
 */
export function PoolWorkspace({ source, option, onOption, actions, earnAction, painted, notice, moment = false }: {
  source: ReadSource
  option: PoolOption
  onOption: (next: PoolOption) => void
  actions?: ReactNode
  /** QA round 2, N84 (the owner's yes): the way into New position again, under the earnings estimate, one-column page only. */
  earnAction?: ReactNode
  /** The first layout drawn for this pool (a copy this browser painted at once): it plays the page's load moment (v4-pool.css). */
  moment?: boolean
  /** What the page must say before anything else (a look-alike token, a pool off the list): under the pool's name (audit I1). */
  notice?: ReactNode
  /** This browser's copy of the last overview, when it names the pool: its figures stand until the page's own (item 44). */
  painted?: Extract<ReadOutcome<'overview'>, { state: 'ok' }>
}) {
  const poolId = option.key
  const optionChanged = useRef(onOption)
  useEffect(() => { optionChanged.current = onOption }, [onOption])
  const [checked, setChecked] = useState<{ key: string; listed: Listed } | null>(null)
  const [market, setMarket] = useState<MarketAnswer | null>(null)
  const [marketAttempt, setMarketAttempt] = useState(0)
  // The page's direction: prices in USDG where the pool holds it ("1 PONS = 0.62 USDG"), else the pool's own order.
  const quoteIndex = quoteSide(option.currencies)
  const base = option.currencies[quoteIndex === 1 ? 0 : 1]
  const quote = option.currencies[quoteIndex]
  // The chart's last day in the page's direction, for the range guide and the activity summary, kept per pool. A day
  // heard with the chart flipped the other way round is not in the page's direction, so the one already kept stays.
  const [heard, setHeard] = useState<{ key: string; span: DaySpan } | null>(null)
  const pageBase = base.address
  const onDay = useCallback((span: DaySpan) => { if (span.base === pageBase) setHeard({ key: poolId, span }) }, [poolId, pageBase])
  // One clock for the page: figures age, and a pool price read long ago turns stale, while it is open.
  const now = useNow(true)
  const checkable = typeof source.routeEnabled === 'function'
  const listed: Listed | null = !checkable ? NOTHING_LISTED : checked?.key === poolId ? checked.listed : null
  const ready = listed !== null
  const storedFirst = listed?.['markets-snapshot'] === true
  const bundled = listed?.overview === true

  useEffect(() => {
    if (!checkable) return
    const controller = new AbortController()
    void listedRoutes(source, controller.signal).then((answer) => {
      if (!controller.signal.aborted) setChecked({ key: poolId, listed: answer })
    })
    return () => controller.abort()
  }, [source, poolId, checkable])

  useEffect(() => {
    if (!ready) return
    const controller = new AbortController()
    const { signal } = controller
    let cancelRefresh: (() => void) | null = null
    const lean = { poolId, includePriceHistory: false }
    const load = async () => {
      if (bundled) {
        const overview = await readWithin(source, 'overview', { poolIds: [poolId] }, { signal })
        if (signal.aborted || overview.state === 'aborted') return
        if (overview.state === 'ok') {
          const entry = overview.data.pools.find((pool) => pool.poolId === poolId)
          const outcome = entry ? storedPoolRead(entry, overview.data.generatedAt, overview.provenance) : null
          const next = overviewPoolOption(overview, poolId)
          const accepted = overview.data.acquisitionAccepted !== false
          const acquiring = entry?.acquisition.status === 'pending'
          setMarket({ key: poolId, ok: outcome, origin: 'overview', acquiring, accepted, failure: null })
          if (next) optionChanged.current(next)
          // Asked again quickly only while the store is still collecting the pool, COLLECTING_ASKS times at the most (A12); a
          // refusal at capacity cannot start until the producer's ceiling drains, and stored figures change about once a minute.
          const fast = acquiring && marketAttempt < COLLECTING_ASKS
          cancelRefresh = whenVisibleAfter(fast ? (accepted ? OVERVIEW_EVERY.collecting : OVERVIEW_EVERY.refused) : OVERVIEW_EVERY.settled, () => setMarketAttempt((n) => n + 1))
        } else {
          setMarket((current) => current?.key === poolId ? { ...current, failure: overview } : { key: poolId, ok: null, origin: null, failure: overview })
          if (await askAgainLater(overview, marketAttempt, signal)) setMarketAttempt((n) => n + 1)
        }
        return
      }
      // The stored snapshot paints the figures first; the pool's own read then brings them up to date, with the estimate.
      // A store that holds nothing for the pool (503 snapshot_not_built), or any other failed stored read, shows
      // nothing: the pool's own read follows it through the same paced queue, as it follows a stored answer.
      if (storedFirst && marketAttempt === 0) {
        const stored = await readWithin(source, 'pool-market', { ...lean, fromSnapshot: true }, { signal })
        if (signal.aborted || stored.state === 'aborted') return
        if (stored.state === 'ok') setMarket({ key: poolId, ok: stored, origin: 'stored', failure: null })
      }
      const outcome = await readWithin(source, 'pool-market', lean, { signal })
      if (signal.aborted || outcome.state === 'aborted') return
      if (outcome.state === 'ok') {
        setMarket({ key: poolId, ok: outcome, origin: 'read', failure: null })
        return
      }
      // A stored answer already on screen stays there; the failure only says why nothing newer came.
      setMarket((current) => (current?.key === poolId ? { ...current, failure: outcome } : { key: poolId, ok: null, origin: null, failure: outcome }))
      if (await askAgainLater(outcome, marketAttempt, signal)) setMarketAttempt((n) => n + 1)
    }
    if (bundled && typeof document !== 'undefined' && document.hidden) cancelRefresh = whenVisibleAfter(0, () => void load())
    else void load()
    return () => { controller.abort(); cancelRefresh?.() }
  }, [source, poolId, ready, storedFirst, bundled, marketAttempt])

  // The copy's figures, dated as they were read, until the page's own first answer (speed wave, item 44, 2026-09-28);
  // shown once the page knows which of its routes are listed, as its own answer is, so its cards take their places
  // (the fifth figure, the activity's resting lines) as they always did, and no sentence is swapped for another.
  const copied = useMemo((): MarketAnswer | null => {
    const entry = painted?.data.pools.find((pool) => pool.poolId === poolId)
    const ok = painted && entry ? storedPoolRead(entry, painted.data.generatedAt, painted.provenance) : null
    return ok ? { key: poolId, ok, origin: 'overview', failure: null } : null
  }, [painted, poolId])
  const answered = market?.key === poolId ? market : ready ? copied : null
  const metricsListed = listed?.['pool-metrics'] === true
  const metricsRead = useChainRead(source, 'pool-metrics', poolId, metricsListed && answered !== null)
  const activityRead = useChainRead(source, 'pool-activity', poolId, listed?.['pool-activity'] === true && answered !== null)
  const positionsRead = useChainRead(source, 'pool-positions', poolId, listed?.['pool-positions'] === true && answered !== null)

  const marketFigures = answered?.ok ? (answered.origin === 'stored' ? storedFigures(answered.ok) : answered.ok) : null
  const projected = marketFigures ? projectMarketRow({ market: marketFigures, metrics: metricsRead ? asRead(metricsRead, source) : null, tokens: new Map() }) : null
  // Use only metadata already returned by the validated pools response,
  // bound again by address. A catalogue label never supplies decimals.
  const bound = (token: PoolOption['currencies'][number]) => option.currencies.find((known) => known.address === token.address) ?? token
  const row = projected ? { ...projected, tokens: { base: bound(projected.tokens.base), quote: bound(projected.tokens.quote) } } : null
  // Refused figures stood in for, as on Markets (audit V1, lib/read/figureFallback.ts): dated and attributed.
  const shown = useFallbackRow(row ? agedMarket(row, now) : null, now)
  const provenance = shown?.provenance
  // A refused acquisition with nothing stored is not loading: nothing is coming until the ceiling drains, so its figures
  // are dashes, not an endless skeleton.
  const loading = answered === null || (answered.ok === null && answered.acquiring === true && answered.accepted !== false)
  // A pool with no stored figures at all (still being collected, or the store refused them): this browser's last ones,
  // DEX Screener's, or today's selection's stand in, dated and attributed (audit V1), rather than resting bubbles.
  const standIns = usePoolStandIns(option, shown === null && answered !== null, now)
  const failure = answered && !answered.ok ? answered.failure : null
  // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): a figure with no answer is a dash with no
  // reason. Gone from the dashes' titles, the live region and the chart: the failed read's words (failureText, e.g.
  // "Pool data unavailable. The read service couldn’t be reached.") and "Domino’s data service is busy, so no figures are
  // stored for this pool yet. The page asks again by itself."
  const [currency0, currency1] = option.currencies
  const price = poolPrice(option, now.wall)
  const fee = option.fee === 'Dynamic' ? 'Dynamic fee' : option.fee
  const network = networkName(base.chainId)
  const usable = optionUsableForDomino(option)
  const priceNow = price.state === 'usable' ? priceAt(price.tick, price.decimals, quoteIndex) : null
  // The typical range New position starts on, worked out on the price now each time it is drawn (round 6 review): a
  // range kept from when the pool was checked would drift off a price read again, and its words with it.
  // Changed on purpose 2026-09-28 (one-sided): the preset is taken on the price as the page writes it, so it reads −30% and +50% whichever way the pool is.
  const guide = usable && price.state === 'usable' ? rangeGuide(presetFor(price, 'standard'), price.tick, price.decimals, quoteIndex) : null
  const day = heard?.key === poolId && heard.span.base === base.address ? heard.span : null
  const unit = <><PoolTokenLabel token={quote} /> for 1 <PoolTokenLabel token={base} /></>
  // Who reported the figures, in Details. Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the basis
  // only; the observation's state and reason, ", retrieved N s ago" (also printed after "Market data provider"), ",
  // reported cache age N s" and "; counted current for N s." are no longer said.
  const observation = provenance
    ? `Provider market observation${answered?.origin === 'stored' ? ', as the read service stored it' : ''}.`
    : undefined
  const fromHistory = (metric: Metric) => metric.source === undefined && metric.state !== 'unavailable' && metric.state !== 'rejected' && metric.state !== 'absent'
  // Where a figure comes from, in its (i) tip, which a tap or the keyboard opens (QA round 2, N38): its hover title alone
  // never reached touch or keyboard users. Said only of a market data provider's figure, never of Domino's own history.
  // The same words as the figures sheet's Details (PoolFiguresDialog): "not checked by Domino".
  const reported = (metric: Metric | null | undefined) => (metric && metric.source !== undefined ? ' Reported by a market data provider, not checked by Domino.' : '')
  // A block number as the activity card writes it, grouped ("101,310,246"), one form for it on the page (QA round 2 review).
  const blockText = (block: number) => block.toLocaleString('en-US')
  const figure = (node: ReactNode, standIn?: ReactNode) => (shown ? <span className="dm-arrive">{node}</span> : standIn ? <span className="dm-arrive">{standIn}</span> : loading ? <Skeleton className="dm-pool-fig-skel" /> : <FigureDash />)
  const metricsFailed = !!metricsRead && metricsRead.state !== 'ok' && metricsRead.state !== 'aborted'
  const apr = shown?.feeAprPercent
  const aprFromHistory = !!apr && apr.value !== null && (apr.state === 'qualified' || apr.state === 'stale')
  // The pool's yearly rate as a number, for the sentence under the name and the earnings estimate: Domino's own where
  // its 24h history qualifies, else the read service's estimate while it is current. Never a figure worked out here.
  const estimate = shown ? presentAprEstimate(shown.feeAprEstimate, now) : null
  // An estimate standing in for the read service's where its own has no figure (audit V1): the row's, or the stand-in.
  const aprStandIn = !aprFromHistory && estimate?.text == null ? (shown?.aprFallback ?? standIns?.apr ?? null) : null
  const aprNumber = aprFromHistory && apr ? numberOf(apr.value) : estimate?.text && estimate.text !== APR_SLIVER ?numberOf(shown?.feeAprEstimate?.data?.feeAprEstimate24hPercent ?? estimate.text) : aprStandIn ? numberOf(aprStandIn.percent) : null
  const savedApr = aprFromHistory ? apr?.state === 'stale' : aprStandIn ? aprStandIn.basis === 'kept' || aprStandIn.basis === 'selection' : estimate?.state === 'stale'
  // The digits the APR tile shows for that same rate (QA round 2, N8): the earnings sentence says "about 38.8% a year"
  // under a "38.8% est." tile, never its own rounding of the number (it read "about 38.9%"). Formula untouched (D9).
  const aprShown = aprNumber === null ? null : aprFromHistory && apr ? percentText(apr) : estimate?.text && estimate.text !== APR_SLIVER ? estimate.text : aprStandIn ? aprDigits(aprStandIn.percent) : null
  // A pool Domino can't open positions in is never estimated (hooks, a fee that changes): its dash says so in words.
  // The money in the pool, which shares its fees with an amount added (the estimate), where the TVL is a figure.
  const tvlMetric = shown?.tvlUsd ?? standIns?.tvl ?? null
  const tvl = tvlMetric && presentMetric(tvlMetric).kind === 'value' ? numberOf(tvlMetric.value) : null
  // Fees in dollars only where the pool holds USDG, at the pool's own price with 1 USDG = $1 (lib/format/usd.ts).
  const usd = isUsdg(quote.address) && priceNow !== null ? { usdgIndex: quoteIndex, price: numberOf(priceNow) ?? 0 } : null

  // Domino's own pool APR, where its 24h history qualifies; a dash otherwise. Changed on purpose 2026-10-15 (pack 7, the
  // owner: no status notices): the dashes have no reason ("Unavailable: <reason>", "Not current: <reason>", the failed
  // read's words), and a kept figure no longer has the title "Stale, not current.".
  const historyApr = (() => {
    if (!metricsListed) return <FigureDash />
    if (!metricsRead) return <Skeleton className="ml-auto h-4 w-14" />
    if (metricsFailed) return <FigureDash />
    if (!apr) return <FigureDash />
    const presented = presentMetric(apr, (m) => `${percentText(m) ?? '—'}%`)
    if (presented.kind !== 'value') return <FigureDash />
    return <span className="tnum" data-metric={presented.stale ? 'stale' : 'qualified'}>{presented.text}</span>
  })()

  // The 24h volume as the key figure writes it, for the recent activity's sentence.
  const volumeShown = shown ? presentMetric(shown.volume24hUsd) : null
  const volumeText = volumeShown?.kind === 'value' ? volumeShown.text : null
  const tvlShown = shown ? presentMetric(shown.tvlUsd) : null
  useLoadMilestone('pool', 'tvl', tvlShown?.kind === 'value' ? tvlShown.stale ? 'cached' : 'current' : null)
  useLoadMilestone('pool', 'volume', volumeShown?.kind === 'value' ? volumeShown.stale ? 'cached' : 'current' : null)
  useLoadMilestone('pool', 'apr', aprFromHistory ? apr?.state === 'stale' ? 'cached' : 'current' : estimate?.text !== null && estimate?.text !== undefined ? estimate.state === 'stale' ? 'cached' : 'estimated' : null)
  const protocol = option.protocolFeeRaw === undefined ? null : protocolFee(option.protocolFeeRaw)
  const activityListed = listed?.['pool-activity'] === true

  // One grid for the page (pool.css): the title row and the sentence under it, the key figures, the chart beside the
  // earnings estimate and the recent activity, the typical range beside what Domino can do here, then Details; where
  // Domino can't open a position, what it can do here and the recent activity beside the chart. A phone reads them in
  // the DOM's order.
  return <div data-pool-workspace={option.key} className={usable ? 'dm-pool-layout' : 'dm-pool-layout dm-pool-layout--follow'} data-pool-moment={moment ? '' : undefined}>
    <div className="dm-pool-head dm-pool-a-head">
      <div className="dm-pool-title">
        {/* Named as its price is written, "TOKEN/USDG" beside "1 TOKEN = X USDG" (audit E21). */}
        <span className="dm-pool-marks"><TokenMarkPair base={base} quote={quote} size={44} ring="var(--bg)" /></span>
        <div className="min-w-0">
          <h1 className="dm-display dm-display-h1"><PoolTokenLabel token={base} /> <span className="dm-pool-slash">/</span> <PoolTokenLabel token={quote} /></h1>
          <div className="dm-pool-chips">
            {/* The fee as every chip writes it (lib/format/fee.ts, audit E21): "Uniswap · 0.30% fee", drawn as joined
                segments (V4 .tag), the "·" kept in the text and unseen. QA round 2, Q23 (the owner: the network on every
                pool): the pool's network is the middle segment, as the Markets row the page was opened from draws it
                ("Uniswap · Robinhood Chain · 0.30% fee"), by the app's one table of network names; Q28: what the fee is.
                Changed on purpose 2026-10-30 (QA round 2, final review read-1): the fee segment opens that sentence as the
                button of a tip (InfoTip, no (i) mark on the chip), which a tap or the keyboard opens as the key figures' do (N38); a hover title alone
                reached neither, and the chip keeps its short text. */}
            <span className="dm-chip"><span className="dm-fee-venue">{FEE_VENUE}</span><span className="dm-fee-sep"> · </span><span className="dm-fee-venue dm-fee-net" data-chain-chip={base.chainId}>{network}</span><span className="dm-fee-sep"> · </span><InfoTip label={`About the ${feeWords(fee).toLowerCase()}`} text={FEE_MEANING}><span className="dm-fee-value">{feeWords(fee)}</span></InfoTip></span>
          </div>
        </div>
      </div>
      {actions && <div className="dm-pool-actions">{actions}</div>}
    </div>

    {notice && <div className="dm-pool-a-lead grid gap-3">{notice}</div>}

    <div className="dm-pool-figures dm-pool-a-figs dm-lit" data-pool-figures="" data-market-read={shown ? (answered?.origin ?? 'read') : loading ? 'loading' : 'none'} data-market-reason={failure?.state}>
      <StatStrip cols={metricsListed ? 5 : 4} layout="tiles" className="dm-pool-stats">
        {aprFromHistory && apr
          ? <Stat label="APR" info="What the pool’s trading fees come to over a year, from Domino’s own history of the last 24 hours. It describes the pool, not your position, and is not a promise." className="dm-pool-stat">{figure(<MetricCell metric={apr} percent tone="in" />)}</Stat>
          : <Stat label="APR" info="What the pool’s trading fees come to over a year, estimated from the last 24 hours. It describes the pool, not your position, and is not a promise." className="dm-pool-stat" sub={(shown || aprStandIn) && !usable && aprNumber === null ? 'Not estimated for this pool' : undefined}>{figure(shown && (aprStandIn ? <FallbackApr apr={aprStandIn} compact /> : <PoolAprEstimate observation={shown.feeAprEstimate} now={now} compact />), aprStandIn && <FallbackApr apr={aprStandIn} compact />)}</Stat>}
        <Stat label="24h volume" info={`How much people swapped through the pool over the last 24 hours.${reported(shown?.volume24hUsd ?? standIns?.volume)}`} className="dm-pool-stat">{figure(shown && <MetricCell metric={shown.volume24hUsd} />, standIns?.volume && <MetricCell metric={standIns.volume} />)}</Stat>
        <Stat label="TVL" info={`Total value locked: the value of all tokens in the pool.${reported(shown?.tvlUsd ?? standIns?.tvl)}`} className="dm-pool-stat">{figure(shown && <MetricCell metric={shown.tvlUsd} />, standIns?.tvl && <MetricCell metric={standIns.tvl} />)}</Stat>
        {metricsListed && (
          <Stat label="24h fees" info="What the pool’s swaps paid to the people who provide its money over the last 24 hours, from Domino’s own history." className="dm-pool-stat">
            {shown && !metricsRead ? <Skeleton className="dm-pool-fig-skel" /> : shown && metricsFailed ? <FigureDash /> : figure(shown && shown.lpFees24hUsd && <MetricCell metric={shown.lpFees24hUsd} />)}
          </Stat>
        )}
        {/* The price as a person says it, "1 PONS = 0.6175 USDG": a ratio between the two tokens, read on chain.
            Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): a price that cannot be written is a dash
            with no line under it and no reason (the range problem's words, e.g. "A price needs both tokens’ decimals, and
            at least one couldn’t be read.", or "The price can’t be written as a plain number."), and a kept price's title
            no longer adds " Read more than 5 minutes ago on this page." */}
        <Stat label="Pool price" info="What one token costs in the other at the block read. It changes with every swap." className="dm-pool-stat" sub={priceNow ? <>for 1 <SymbolText token={base} /></> : undefined}>
          {priceNow
            ? <span className="dm-pool-price-now" data-pool-price-now="" title={`Pool price from on-chain state at block ${price.state === 'usable' ? price.block : ''}. A ratio between the two tokens.`}>{priceNow} <span className="dm-pool-price-side"><SymbolText token={quote} /></span></span>
            : <FigureDash />}
        </Stat>
      </StatStrip>
      <p role="status" aria-live="polite" className="sr-only" data-pool-status={loading ? 'loading' : failure ? failure.state : 'none'}>
        {loading ? 'Reading pool figures…' : ''}
      </p>
    </div>

    <div className="dm-pool-a-chart dm-lit">
      <PoolHistoryChart source={source} option={option} market={shown} loading={loading} quote={quoteIndex} onDay={onDay} />
    </div>

    {usable && <div className="dm-pool-a-earn dm-lit">
      <PoolEarnings apr={aprNumber} aprDigits={aprShown} tvl={tvl} loading={loading || (metricsListed && !metricsRead && !!shown)} saved={aprNumber !== null && (savedApr || (tvl !== null && tvl > 0 && tvlMetric?.state === 'stale'))} action={earnAction} />
    </div>}

    <div className="dm-pool-a-recent dm-v3-pool-recent dm-lit">
      <PoolActivitySummary read={activityRead} listed={activityListed} option={option} now={now} day={day} usd={usd} volume={volumeText} loading={loading} />
    </div>

    {usable && <details className="dm-pool-a-range dm-v3-pool-disclosure dm-lit">
      <summary>Choosing a price range<span aria-hidden="true" /></summary>
      <PoolRangeGuide guide={guide} day={day} unit={unit} saved={price.state === 'usable' && price.stale} />
    </details>}

    {usable ? <details className="dm-pool-a-auto dm-v3-pool-disclosure dm-lit">
      <summary>Automate your position<span aria-hidden="true" /></summary>
      <PoolAutomation usable={usable} why={refusal(option)} />
    </details> : <div className="dm-pool-a-auto dm-lit"><PoolAutomation usable={usable} why={refusal(option)} /></div>}

    {/* Everything technical, at the end and closed until asked for, as on a position's page. */}
    <details className="dm-card dm-pool-details dm-pool-a-details dm-lit" data-pool-details="">
      <summary className="dm-pool-details-head">
        {/* Changed on purpose 2026-10-30 (QA round 2, Q34): named for what it holds, as the docs call it. */}
        <h2 className="dm-title">Technical details</h2>
        <span aria-hidden="true" className="dm-pool-details-chevron" />
      </summary>
      <dl className="dm-kv dm-kv--two dm-pool-kv">
        <div><dt>Network</dt><dd data-chain-chip={base.chainId}>{network}</dd></div>
        <div>
          <dt>Pool id</dt>
          <dd className="dm-pool-kv-id"><Address value={option.key} /><CopyButton value={option.key} label="Copy pool id" /></dd>
        </div>
        {/* QA round 2, Q34: the chain's own ETH has no contract; its zero address is named for what it is. N24 (the
            owner's yes): a token's contract opens on the pool's network's explorer; the pool id stays unlinked. */}
        <div><dt><PoolTokenLabel token={currency0} /></dt><dd className="text-fg-muted">{currency0.address === NATIVE_CURRENCY ? <>Native ETH (<Address value={currency0.address} short />)</> : <ExplorerAddress address={currency0.address} chainId={base.chainId}><SymbolText token={currency0} /></ExplorerAddress>}</dd></div>
        <div><dt><PoolTokenLabel token={currency1} /></dt><dd className="text-fg-muted">{currency1.address === NATIVE_CURRENCY ? <>Native ETH (<Address value={currency1.address} short />)</> : <ExplorerAddress address={currency1.address} chainId={base.chainId}><SymbolText token={currency1} /></ExplorerAddress>}</dd></div>
        {/* QA round 2, N72 (the owner's option b): a fixed fee off Uniswap's usual tiers says so here, inside the closed
            details only, with no version named. */}
        <div><dt>Fee</dt><dd data-fee-tier={fee === 'Dynamic fee' ? undefined : STANDARD_FEE_PIPS.has(option.feePips) ? 'standard' : 'non-standard'}>{fee === 'Dynamic fee' ? fee : `${fee} · fixed${STANDARD_FEE_PIPS.has(option.feePips) ? '' : ' · non-standard'}`}</dd></div>
        {protocol && (
          <div data-protocol-fee={protocol.state}>
            <dt>Protocol fee</dt>
            <dd title={protocol.state === 'invalid' ? 'The pool’s protocol fee could not be read as two directional rates.' : `Taken from the token a swap sells into the pool, before the LP fee. Packed value ${option.protocolFeeRaw}, read at block ${blockText(option.block)}.`}>
              {protocol.state === 'none' ? 'None' : protocol.state === 'invalid' ? '—' : protocol.zeroForOnePips === protocol.oneForZeroPips
                ? protocol.zeroForOne
                : <>{protocol.zeroForOne} selling <SymbolText token={currency0} /> · {protocol.oneForZero} selling <SymbolText token={currency1} /></>}
            </dd>
          </div>
        )}
        {option.tokenMetadata === 'partial' && <div><dt>Token metadata</dt><dd className="text-fg-muted">{COPY.picker.partialMetadata}</dd></div>}
        <div><dt>Tick spacing</dt><dd>{option.tickSpacing}</dd></div>
        <div><dt>Hooks</dt><dd>{option.hooks === NATIVE_CURRENCY ? 'None' : <ExplorerAddress address={option.hooks} chainId={base.chainId}>Hooks contract</ExplorerAddress>}</dd></div>
        <div>
          <dt>Pool price</dt>
          <dd>{price.state === 'usable'
            ? <span className="tnum" title={`${price.text}, read at block ${blockText(price.block)}.`}>{price.text.replace(/^≈/, '')} <SymbolText token={price.quote} /> per <SymbolText token={price.base} /><span className="dm-provenance"> · block {blockText(price.block)}</span>{price.partial && ' · symbol not read'}</span>
            : <FigureDash />}</dd>
        </div>
        <div><dt>24h vol / TVL</dt><dd>{shown ? <TurnoverCell market={shown} /> : loading ? <Skeleton className="ml-auto h-4 w-12" /> : <FigureDash />}</dd></div>
        <div>
          <dt>Figures from</dt>
          <dd>{shown
            ? <span data-market-provenance="" title={observation}>{figuresFrom(shown.tvlUsd) ?? (fromHistory(shown.tvlUsd) ? 'Domino history' : 'Market data provider')}</span>
            : standIns?.tvl ? <span data-market-provenance="">{figuresFrom(standIns.tvl)}</span>
            : loading ? <Skeleton className="ml-auto h-4 w-24" /> : <FigureDash />}</dd>
        </div>
        <div>
          {/* Changed 2026-10-01 (audit I1): what was checked is the pool, never its tokens; "Verified" read as vetted tokens. */}
          <dt>Pool read</dt>
          <dd title="The pool was read on Robinhood Chain and matches its id. Its tokens are not checked or endorsed.">
            On chain at block {blockText(option.block)} · {option.kind === 'stored' ? 'stored on-chain observation' : option.kind === 'discovery' ? 'found by provider discovery' : `from the catalogue (${option.catalogue?.source === 'initialize_event' ? 'initialize event' : 'verified observation'} at block ${option.catalogue ? blockText(option.catalogue.block) : ''})`}
            {option.requestedById && ' · asked for by id'}
          </dd>
        </div>
      </dl>
      <div className="dm-pool-details-parts">
        <section className="dm-pool-embedded" aria-labelledby="pool-apr-how">
          <h3 id="pool-apr-how" className="dm-pool-embedded-title">How the APR is worked out</h3>
          <div className="grid gap-3 text-[0.8125rem] leading-[1.125rem]">
            <dl data-history-apr="">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3"><dt className="text-fg-muted">Pool APR, Domino history</dt><dd className="font-medium">{historyApr}</dd></div>
            </dl>
            {shown ? (
              <PoolAprEstimate observation={shown.feeAprEstimate} now={now} detailed label="Estimated APR" />
            ) : (
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-fg-muted">Estimated APR</span>
                {loading ? <Skeleton className="h-4 w-14" /> : <FigureDash />}
              </div>
            )}
          </div>
        </section>
        <section className="dm-pool-embedded" aria-labelledby="pool-provider-figures">
          <h3 id="pool-provider-figures" className="dm-pool-embedded-title">Other provider figures</h3>
          <div className="grid gap-3">
            <ProviderFigure label="Liquidity" figure={option.liquidity} full />
            <ProviderFigure label="24h volume" figure={option.volume} full />
            {option.providerConflict && <p className="text-caption text-money-out">{COPY.picker.providerConflict}</p>}
          </div>
        </section>
        {activityListed && <PoolActivityCard read={activityRead} option={option} now={now} embedded />}
        {listed?.['pool-positions'] && <PoolPositionsCard read={positionsRead} option={option} embedded />}
      </div>
    </details>
  </div>
}
