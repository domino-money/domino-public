import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { agedMarket, percentText, presentMetric, retrievedAgeSeconds, retrievedText, type Metric } from '../../../lib/markets'
import { presentAprEstimate } from '../../../lib/read/aprEstimate'
import { reasonText } from '../../../lib/read/describe'
import { projectMarketRow } from '../../../lib/read/project'
import { overviewPoolOption, storedPoolRead } from '../../../lib/read/publicOverview'
import { whenVisibleAfter } from '../../../lib/read/screens/quietRead'
import { COPY, failureText } from '../../../lib/read/screens/copy'
import { protocolFee } from '../../../lib/read/screens/figures'
import { NATIVE_CURRENCY } from '../../../lib/read/screens/identity'
import { poolPrice, presetRange } from '../../../lib/read/screens/poolRange'
import { optionUsableForDomino, type PoolOption } from '../../../lib/read/screens/poolsList'
import { askAgainLater, readWithin, type ScreenOutcome } from '../../../lib/read/screens/screenRead'
import type { ReadOutcome, ReadRequests, ReadSource } from '../../../lib/read/types'
import { useNow } from '../../../lib/read/useNow'
import { MetricCell, TurnoverCell } from '../../explore/MetricCell'
import { PoolTokenLabel } from '../../PoolCatalogueIdentity'
import { TokenMarkPair } from '../../TokenIcon'
import { FigureDash, Skeleton, Stat, StatStrip } from '../../ui'
import { PoolActivitySummary } from '../../pool/PoolActivitySummary'
import { PoolAutomation } from '../../pool/PoolAutomation'
import { PoolEarnings } from '../../pool/PoolEarnings'
import { PoolRangeGuide } from '../../pool/PoolRangeGuide'
import { aboutPercent, isUsdg, numberOf, priceAt, quoteSide, rangeGuide, type DaySpan } from '../../pool/plain'
import { Address } from './Address'
import { CopyButton } from './CopyButton'
import { PoolActivityCard } from './PoolActivityCard'
import { PoolAprEstimate } from './PoolAprEstimate'
import { PoolPositionsCard } from './PoolPositionsCard'
import { PoolHistoryChart } from './PoolHistoryChart'
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

const sentence = (text: { title: string; detail: string }) => [text.title, text.detail].filter(Boolean).join('. ').replace(/\.\./g, '.')

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
export function PoolWorkspace({ source, option, onOption, actions }: {
  source: ReadSource
  option: PoolOption
  onOption: (next: PoolOption) => void
  actions?: ReactNode
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
          // Asked again quickly only while the store is still collecting the pool; a refusal at capacity cannot start
          // until the producer's ceiling drains, and stored figures change about once a minute.
          cancelRefresh = whenVisibleAfter(acquiring ? (accepted ? OVERVIEW_EVERY.collecting : OVERVIEW_EVERY.refused) : OVERVIEW_EVERY.settled, () => setMarketAttempt((n) => n + 1))
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

  const answered = market?.key === poolId ? market : null
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
  const shown = row ? agedMarket(row, now) : null
  const provenance = shown?.provenance
  const retrieved = retrievedText(provenance ? retrievedAgeSeconds(provenance.market, now) : null)
  // A refused acquisition with nothing stored is not loading: nothing is coming
  // until the ceiling drains, and an endless skeleton says nothing at all.
  const atCapacity = answered?.ok === null && answered.acquiring === true && answered.accepted === false
  const loading = answered === null || (answered.ok === null && answered.acquiring === true && answered.accepted !== false)
  const failure = answered && !answered.ok ? answered.failure : null
  const failed = failure ? sentence(failureText(failure, 'pools')) : atCapacity ? 'Data collection is at capacity; no figures are stored for this pool yet.' : undefined
  const [currency0, currency1] = option.currencies
  const price = poolPrice(option, now.wall)
  const fee = option.fee === 'Dynamic' ? 'Dynamic fee' : option.fee
  const usable = optionUsableForDomino(option)
  const priceNow = price.state === 'usable' ? priceAt(price.tick, price.decimals, quoteIndex) : null
  // The typical range New position starts on, worked out on the price now each time it is drawn (round 6 review): a
  // range kept from when the pool was checked would drift off a price read again, and its words with it.
  const guide = usable && price.state === 'usable' ? rangeGuide(presetRange(price.tick, price.tickSpacing, 'standard'), price.tick, price.decimals, quoteIndex) : null
  const day = heard?.key === poolId && heard.span.base === base.address ? heard.span : null
  const unit = <><PoolTokenLabel token={quote} /> for 1 <PoolTokenLabel token={base} /></>
  const status = provenance?.market.status
  // Who reported the figures and when they were retrieved, in Details; the whole observation is its title.
  const observation = provenance
    ? `Provider market observation${answered?.origin === 'stored' ? ', as the read service stored it' : ''}: ${provenance.market.status}${provenance.market.reason ? ` (${reasonText(provenance.market.reason)})` : ''}, ${retrieved}${provenance.market.cacheAgeSeconds === null ? '' : `, reported cache age ${provenance.market.cacheAgeSeconds} s`}; counted current for ${provenance.market.freshForSeconds} s.`
    : undefined
  const fromHistory = (metric: Metric) => metric.source === undefined && metric.state !== 'unavailable' && metric.state !== 'rejected' && metric.state !== 'absent'
  const figure = (node: ReactNode) => (shown ? <span className="dm-arrive">{node}</span> : loading ? <Skeleton className="dm-pool-fig-skel" /> : <FigureDash reason={failed} />)
  const metricsFailed = metricsRead && metricsRead.state !== 'ok' && metricsRead.state !== 'aborted' ? sentence(failureText(metricsRead, 'pools')) : undefined
  const apr = shown?.feeAprPercent
  const aprFromHistory = !!apr && apr.value !== null && (apr.state === 'qualified' || apr.state === 'stale')
  // The pool's yearly rate as a number, for the sentence under the name and the earnings estimate: Domino's own where
  // its 24h history qualifies, else the read service's estimate while it is current. Never a figure worked out here.
  const estimate = shown ? presentAprEstimate(shown.feeAprEstimate, now) : null
  const aprNumber = aprFromHistory && apr ? numberOf(apr.value) : estimate?.text && estimate.text !== '<0.01' ? numberOf(shown?.feeAprEstimate?.data?.feeAprEstimate24hPercent ?? estimate.text) : null
  const aprWords = aprNumber !== null && aprNumber > 0 ? aboutPercent(aprNumber) : null
  // A pool Domino can't open positions in is never estimated (hooks, a fee that changes): its dash says so in words.
  // The money in the pool, which shares its fees with an amount added (the estimate), where the TVL is a figure.
  const tvl = shown && presentMetric(shown.tvlUsd).kind === 'value' ? numberOf(shown.tvlUsd.value) : null
  // Fees in dollars only where the pool holds USDG, at the pool's own price with 1 USDG = $1 (lib/format/usd.ts).
  const usd = isUsdg(quote.address) && priceNow !== null ? { usdgIndex: quoteIndex, price: numberOf(priceNow) ?? 0 } : null

  // Domino's own pool APR, where its 24h history qualifies; a dash with the reason otherwise.
  const historyApr = (() => {
    if (!metricsListed) return <FigureDash reason={`Unavailable: ${reasonText(option.aprReason)}`} />
    if (!metricsRead) return <Skeleton className="ml-auto h-4 w-14" />
    if (metricsFailed) return <FigureDash reason={metricsFailed} />
    if (!apr) return <FigureDash reason={failed} />
    const presented = presentMetric(apr, (m) => `${percentText(m) ?? '—'}%`)
    if (presented.kind !== 'value') return <FigureDash reason={`${presented.kind === 'not_current' ? 'Not current' : 'Unavailable'}: ${reasonText(presented.reason)}`} />
    return <span className="tnum" data-metric={presented.stale ? 'stale' : 'qualified'} title={presented.stale ? 'Stale, not current.' : undefined}>{presented.text}</span>
  })()

  // The 24h volume as the key figure writes it, for the recent activity's sentence.
  const volumeShown = shown ? presentMetric(shown.volume24hUsd) : null
  const volumeText = volumeShown?.kind === 'value' ? volumeShown.text : null
  const protocol = option.protocolFeeRaw === undefined ? null : protocolFee(option.protocolFeeRaw)
  const activityListed = listed?.['pool-activity'] === true

  // One grid for the page (pool.css): the title row and the sentence under it, the key figures, the chart beside the
  // earnings estimate and the recent activity, the typical range beside what Domino can do here, then Details; where
  // Domino can't open a position, what it can do here and the recent activity beside the chart. A phone reads them in
  // the DOM's order.
  return <div data-pool-workspace={option.key} className={usable ? 'dm-pool-layout' : 'dm-pool-layout dm-pool-layout--follow'}>
    <div className="dm-pool-head dm-pool-a-head">
      <div className="dm-pool-title">
        <span className="dm-pool-marks"><TokenMarkPair base={currency0} quote={currency1} size={44} ring="var(--bg)" /></span>
        <div className="min-w-0">
          <h1 className="dm-display dm-display-h1"><PoolTokenLabel token={currency0} /> / <PoolTokenLabel token={currency1} /></h1>
          <div className="dm-pool-chips">
            <span className="dm-chip">Uniswap · {fee === 'Dynamic fee' ? fee : `${fee} fee`}</span>
          </div>
        </div>
      </div>
      {actions && <div className="dm-pool-actions">{actions}</div>}
    </div>

    <p className="dm-pool-intro dm-pool-a-lead" data-pool-intro="">
      People swap <b><SymbolText token={base} /></b> and <b><SymbolText token={quote} /></b> in this pool. Everyone who adds money to it shares {fee === 'Dynamic fee' ? 'the pool’s fee' : `the ${fee} fee`} on each swap{aprWords ? <>: about <b className="dm-pool-intro-apr">{aprWords} a year</b> at recent activity</> : null}.
    </p>

    <div className="dm-pool-figures dm-pool-a-figs" data-pool-figures="" data-market-read={shown ? (answered?.origin ?? 'read') : loading ? 'loading' : 'none'} data-market-reason={failure?.state}>
      <StatStrip cols={metricsListed ? 5 : 4} layout="tiles" className="dm-pool-stats">
        {aprFromHistory && apr
          ? <Stat label="APR" info="What the pool’s fees come to over a year, from Domino’s own history of its last day. It describes the pool, not your position, and is not a promise." className="dm-pool-stat" sub="A year, at recent activity">{figure(<MetricCell metric={apr} percent tone="in" />)}</Stat>
          : <Stat label="APR" info="What the pool’s fees come to over a year, estimated from its last day of trading. It describes the pool, not your position, and is not a promise." className="dm-pool-stat" sub={shown ? (usable || aprNumber !== null ? 'A year, at recent activity' : 'Not estimated for this pool') : loading ? <Skeleton className="dm-pool-fig-sub-skel" /> : undefined}>{figure(shown && <PoolAprEstimate observation={shown.feeAprEstimate} now={now} compact />)}</Stat>}
        <Stat label="24h volume" info="How much people swapped through the pool over the last 24 hours." className="dm-pool-stat" sub={shown && fromHistory(shown.volume24hUsd) ? 'Swapped in the last day, Domino history' : 'Swapped in the last day'}>{figure(shown && <MetricCell metric={shown.volume24hUsd} retrieved={retrieved} />)}</Stat>
        <Stat label="TVL" info="Total value locked: what all the money in the pool is worth now." className="dm-pool-stat" sub={shown && fromHistory(shown.tvlUsd) ? 'In the pool now, Domino history' : 'In the pool now'}>{figure(shown && <MetricCell metric={shown.tvlUsd} retrieved={retrieved} />)}</Stat>
        {metricsListed && (
          <Stat label="24h fees" info="What the pool’s swaps paid to the people who provide its money over the last 24 hours, from Domino’s own history." className="dm-pool-stat" sub={shown ? 'Paid to the pool, Domino history' : undefined}>
            {shown && !metricsRead ? <Skeleton className="dm-pool-fig-skel" /> : shown && metricsFailed ? <FigureDash reason={metricsFailed} /> : figure(shown && shown.lpFees24hUsd && <MetricCell metric={shown.lpFees24hUsd} />)}
          </Stat>
        )}
        {/* The price as a person says it, "1 PONS = 0.6175 USDG": a ratio between the two tokens, read on chain. */}
        <Stat label="Price" info="What one token costs in the other now. It changes with every swap." className="dm-pool-stat" sub={priceNow ? <>for 1 <SymbolText token={base} /></> : price.state === 'usable' ? undefined : COPY.range.problems[price.problem]}>
          {priceNow
            ? <span className="dm-pool-price-now" data-pool-price-now="" title={`Pool price from on-chain state at block ${price.state === 'usable' ? price.block : ''}. A ratio between the two tokens.${price.state === 'usable' && price.stale ? ' Read more than 5 minutes ago on this page.' : ''}`}>{priceNow} <span className="dm-pool-price-side"><SymbolText token={quote} /></span></span>
            : <FigureDash reason={price.state === 'usable' ? 'The price can’t be written as a plain number.' : COPY.range.problems[price.problem]} />}
        </Stat>
      </StatStrip>
      <p role="status" aria-live="polite" className="sr-only" data-pool-status={loading ? 'loading' : failure ? failure.state : 'none'}>
        {loading ? 'Reading pool figures…' : failed && !shown ? failed : ''}
      </p>
    </div>

    <div className="dm-pool-a-chart">
      <PoolHistoryChart source={source} option={option} market={shown} loading={loading} failed={failed} quote={quoteIndex} onDay={onDay} />
    </div>

    {usable && <div className="dm-pool-a-earn">
      <PoolEarnings apr={aprNumber} tvl={tvl} loading={loading || (metricsListed && !metricsRead && !!shown)} />
    </div>}

    <div className="dm-pool-a-recent">
      <PoolActivitySummary read={activityRead} listed={activityListed} option={option} now={now} day={day} usd={usd} volume={volumeText} loading={loading} />
    </div>

    {usable && <div className="dm-pool-a-range">
      <PoolRangeGuide guide={guide} day={day} unit={unit} />
    </div>}

    <div className="dm-pool-a-auto">
      <PoolAutomation usable={usable} why={refusal(option)} />
    </div>

    {/* Everything technical, at the end and closed until asked for, as on a position's page. */}
    <details className="dm-card dm-pool-details dm-pool-a-details" data-pool-details="">
      <summary className="dm-pool-details-head">
        <h2 className="dm-title">Details</h2>
        <span className="dm-pool-details-hint">Contract data for this pool</span>
        <span aria-hidden="true" className="dm-pool-details-chevron" />
      </summary>
      <dl className="dm-kv dm-kv--two dm-pool-kv">
        <div>
          <dt>Pool id</dt>
          <dd className="dm-pool-kv-id"><Address value={option.key} /><CopyButton value={option.key} label="Copy pool id" /></dd>
        </div>
        <div><dt><PoolTokenLabel token={currency0} /></dt><dd className="text-fg-muted"><Address value={currency0.address} short /></dd></div>
        <div><dt><PoolTokenLabel token={currency1} /></dt><dd className="text-fg-muted"><Address value={currency1.address} short /></dd></div>
        <div><dt>Fee</dt><dd>{fee === 'Dynamic fee' ? fee : `${fee} · fixed`}</dd></div>
        {protocol && (
          <div data-protocol-fee={protocol.state}>
            <dt>Protocol fee</dt>
            <dd title={protocol.state === 'invalid' ? 'The pool’s protocol fee could not be read as two directional rates.' : `Taken from the token a swap sells into the pool, before the LP fee. Packed value ${option.protocolFeeRaw}, read at block ${option.block}.`}>
              {protocol.state === 'none' ? 'None' : protocol.state === 'invalid' ? '—' : protocol.zeroForOnePips === protocol.oneForZeroPips
                ? protocol.zeroForOne
                : <>{protocol.zeroForOne} selling <SymbolText token={currency0} /> · {protocol.oneForZero} selling <SymbolText token={currency1} /></>}
            </dd>
          </div>
        )}
        {option.tokenMetadata === 'partial' && <div><dt>Token metadata</dt><dd className="text-fg-muted">{COPY.picker.partialMetadata}</dd></div>}
        <div><dt>Tick spacing</dt><dd>{option.tickSpacing}</dd></div>
        <div><dt>Hooks</dt><dd>{option.hooks === NATIVE_CURRENCY ? 'None' : <Address value={option.hooks} short />}</dd></div>
        <div>
          <dt>Pool price</dt>
          <dd>{price.state === 'usable'
            ? <span className="tnum" title={`${price.text}, read at block ${price.block}.`}>{price.text.replace(/^≈/, '')} <SymbolText token={price.quote} /> per <SymbolText token={price.base} /><span className="dm-provenance"> · block {price.block}</span>{price.partial && ' · symbol not read'}</span>
            : COPY.range.problems[price.problem]}</dd>
        </div>
        <div><dt>24h vol / TVL</dt><dd>{shown ? <TurnoverCell market={shown} retrieved={retrieved} /> : loading ? <Skeleton className="ml-auto h-4 w-12" /> : <FigureDash reason={failed} />}</dd></div>
        <div>
          <dt>Figures from</dt>
          <dd>{shown
            ? <span data-market-provenance="" title={observation}>{fromHistory(shown.tvlUsd) ? 'Domino history' : 'Market data provider'}{(status === 'available' || status === 'stale') && `, ${retrieved}`}</span>
            : loading ? <Skeleton className="ml-auto h-4 w-24" /> : <FigureDash reason={failed} />}</dd>
        </div>
        <div>
          <dt>Verification</dt>
          <dd>
            Verified at block {option.block} · {option.kind === 'stored' ? 'stored on-chain observation' : option.kind === 'discovery' ? 'found by provider discovery' : `from the catalogue (${option.catalogue?.source === 'initialize_event' ? 'initialize event' : 'verified observation'} at block ${option.catalogue?.block})`}
            {option.requestedById && ' · asked for by id'}
          </dd>
        </div>
      </dl>
      <div className="dm-pool-details-parts">
        <section className="dm-pool-embedded" aria-labelledby="pool-apr-how">
          <h3 id="pool-apr-how" className="dm-pool-embedded-title">How the APR is worked out</h3>
          <div className="grid gap-3 text-[13px] leading-[18px]">
            <dl data-history-apr="">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3"><dt className="text-fg-muted">Pool APR, Domino history</dt><dd className="font-medium">{historyApr}</dd></div>
            </dl>
            {shown ? (
              <PoolAprEstimate observation={shown.feeAprEstimate} now={now} detailed label="Estimated APR" />
            ) : (
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-fg-muted">Estimated APR</span>
                {loading ? <Skeleton className="h-4 w-14" /> : <FigureDash reason={failed} />}
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
