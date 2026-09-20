import { useEffect, useRef, useState, type ReactNode } from 'react'
import { agedMarket, percentText, presentMetric, retrievedAgeSeconds, retrievedText, type Metric } from '../../../lib/markets'
import { reasonText } from '../../../lib/read/describe'
import { projectMarketRow } from '../../../lib/read/project'
import { overviewPoolOption, storedPoolRead } from '../../../lib/read/publicOverview'
import { whenVisibleAfter } from '../../../lib/read/screens/quietRead'
import { COPY, failureText } from '../../../lib/read/screens/copy'
import { protocolFee } from '../../../lib/read/screens/figures'
import { NATIVE_CURRENCY, addressKey, shortAddress } from '../../../lib/read/screens/identity'
import { poolPrice } from '../../../lib/read/screens/poolRange'
import type { PoolOption } from '../../../lib/read/screens/poolsList'
import { askAgainLater, readWithin, type ScreenOutcome } from '../../../lib/read/screens/screenRead'
import type { ReadOutcome, ReadRequests, ReadSource } from '../../../lib/read/types'
import { useNow } from '../../../lib/read/useNow'
import { MetricCell, TurnoverCell } from '../../explore/MetricCell'
import { PoolTokenLabel } from '../../PoolCatalogueIdentity'
import { TokenMarkPair } from '../../TokenIcon'
import { Skeleton, Stat, StatStrip, cx } from '../../ui'
import { Address } from './Address'
import { CopyButton } from './CopyButton'
import { PoolActivityCard } from './PoolActivityCard'
import { PoolAprEstimate } from './PoolAprEstimate'
import { PoolPositionsCard } from './PoolPositionsCard'
import { PoolHistoryChart } from './PoolHistoryChart'
import { PoolRangeControls } from './PoolRangeControls'
import { ProviderFigure } from './ProviderFigure'
import { SymbolText } from './SymbolText'

/*
 * This file is loaded by tests/pool-workspace.test.mjs with every import but
 * React replaced by a fixed list of stubs, and React by useState, useRef,
 * useCallback and useEffect only. Everything else it draws comes through
 * class names (styles/shell.css, styles/pool.css).
 */

/** Two ticks on the pool's spacing: the band the range planner draws. Nothing is saved or sent. */
type PlannedRange = { lower: number; upper: number }

/** The routes this page reads only where the page's capabilities list them. */
type Optional = 'markets-snapshot' | 'pool-metrics' | 'pool-activity' | 'pool-positions' | 'overview'
type Listed = Record<Optional, boolean>
const OPTIONAL: readonly Optional[] = ['markets-snapshot', 'pool-metrics', 'pool-activity', 'pool-positions', 'overview']
const NOTHING_LISTED: Listed = { 'markets-snapshot': false, 'pool-metrics': false, 'pool-activity': false, 'pool-positions': false, overview: false }

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
type MarketAnswer = { key: string; ok: OkMarket | null; origin: 'stored' | 'read' | 'overview' | null; acquiring?: boolean; failure: Exclude<ScreenOutcome<'pool-market' | 'overview'>, { state: 'ok' | 'aborted' }> | null }

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

const Dash = ({ title }: { title?: string }) => (
  <span className="text-fg-subtle" title={title} data-figure="none">
    —
  </span>
)

/**
 * One verified pool on its own page, from the title row down. Its identity is
 * the pool as the pools read described it. Its figures come from the page's
 * own reads, in order, one at a time through the shared queue: the market
 * figures (from the read service's stored snapshot first, where it keeps one,
 * then the pool's own lean read, which brings the estimate), then Domino's 24h
 * history, the pool's chain activity and its positions, each only where this
 * page's capabilities list it. Nothing on the page says how a read went: a
 * busy or briefly unavailable read is asked again on its own, and a figure
 * with no answer is a dash with the reason in its title. The chart reads
 * hourly candles when a person asks. `actions` is the caller's way onward (a
 * route into the new-position flow); nothing here deposits, signs or quotes.
 */
export function PoolWorkspace({ source, option, onOption, range, onRange, actions }: {
  source: ReadSource
  option: PoolOption
  onOption: (next: PoolOption) => void
  range: PlannedRange | null
  onRange: (next: PlannedRange) => void
  actions?: ReactNode
}) {
  const poolId = option.key
  const optionChanged = useRef(onOption)
  useEffect(() => { optionChanged.current = onOption }, [onOption])
  const [checked, setChecked] = useState<{ key: string; listed: Listed } | null>(null)
  const [market, setMarket] = useState<MarketAnswer | null>(null)
  const [marketAttempt, setMarketAttempt] = useState(0)
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
          setMarket({ key: poolId, ok: outcome, origin: 'overview', acquiring: entry?.acquisition.status === 'pending', failure: null })
          if (next) optionChanged.current(next)
          cancelRefresh = whenVisibleAfter(5_000, () => setMarketAttempt((n) => n + 1))
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
  const loading = answered === null || (answered.ok === null && answered.acquiring === true)
  const failure = answered && !answered.ok ? answered.failure : null
  const failed = failure ? sentence(failureText(failure, 'pools')) : undefined
  const [currency0, currency1] = option.currencies
  const price = poolPrice(option, now.wall)
  const fee = option.fee === 'Dynamic' ? 'Dynamic fee' : option.fee
  const status = provenance?.market.status
  const resting = <span className="mt-2 grid gap-1.5"><Skeleton className="h-2.5 w-20" /><Skeleton className="h-2.5 w-24" /></span>
  // Who reported the figures and when they were retrieved, as words under them; the whole observation is their title.
  const observation = provenance
    ? `GeckoTerminal market observation${answered?.origin === 'stored' ? ', as the read service stored it' : ''}: ${provenance.market.status}${provenance.market.reason ? ` (${reasonText(provenance.market.reason)})` : ''}, ${retrieved}${provenance.market.cacheAgeSeconds === null ? '' : `, reported cache age ${provenance.market.cacheAgeSeconds} s`}; counted current for ${provenance.market.freshForSeconds} s.`
    : undefined
  const providerLine = !shown
    ? loading ? resting : undefined
    : <span className="block" data-market-provenance="" title={observation}>
        <span className="block">GeckoTerminal</span>
        {(status === 'available' || status === 'stale') && <span className="block">{retrieved}</span>}
      </span>
  const HISTORY = 'Domino history'
  const fromHistory = (metric: Metric) => metric.source === undefined && metric.state !== 'unavailable' && metric.state !== 'rejected' && metric.state !== 'absent'
  const figure = (node: ReactNode) => (shown ? <span className="animate-fade">{node}</span> : loading ? <Skeleton className="mt-1 h-6 w-24" /> : <Dash title={failed} />)
  const metricsFailed = metricsRead && metricsRead.state !== 'ok' && metricsRead.state !== 'aborted' ? sentence(failureText(metricsRead, 'pools')) : undefined
  const apr = shown?.feeAprPercent
  const aprFromHistory = !!apr && apr.value !== null && (apr.state === 'qualified' || apr.state === 'stale')

  // Domino's own pool APR, where its 24h history qualifies; a dash with the reason otherwise.
  const historyApr = (() => {
    if (!metricsListed) return <Dash title={`Unavailable: ${reasonText(option.aprReason)}`} />
    if (!metricsRead) return <Skeleton className="ml-auto h-4 w-14" />
    if (metricsFailed) return <Dash title={metricsFailed} />
    if (!apr) return <Dash title={failed} />
    const presented = presentMetric(apr, (m) => `${percentText(m) ?? '—'}%`)
    if (presented.kind !== 'value') return <Dash title={`${presented.kind === 'not_current' ? 'Not current' : 'Unavailable'}: ${reasonText(presented.reason)}`} />
    return <span className="tnum" data-metric={presented.stale ? 'stale' : 'qualified'} title={presented.stale ? 'Stale, not current.' : undefined}>{presented.text}</span>
  })()

  const protocol = option.protocolFeeRaw === undefined ? null : protocolFee(option.protocolFeeRaw)
  // The details read down the first column, then the second: half the rows, rounded up, in each.
  const detailRows = 8 + (option.tokenMetadata === 'partial' ? 1 : 0) + (protocol ? 1 : 0)
  const perColumn = Math.ceil(detailRows / 2)

  return <div data-pool-workspace={option.key}>
    <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-5">
      <div className="flex min-w-0 items-center gap-4">
        <span className="dm-pool-marks"><TokenMarkPair base={currency0} quote={currency1} size={44} ring="var(--bg)" /></span>
        <div className="min-w-0">
          <h1 className="dm-display dm-display-title"><PoolTokenLabel token={currency0} /> / <PoolTokenLabel token={currency1} /></h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <span className="dm-chip">Uniswap · {fee}</span>
            <span className="dm-chip">Robinhood Chain</span>
            <span className="dm-pool-id" title={option.key} translate="no">
              <span aria-hidden="true">{shortAddress(option.key)}</span>
              <span className="sr-only">{option.key}</span>
              <CopyButton value={option.key} label="Copy pool id" />
            </span>
          </div>
        </div>
      </div>
      {actions && <div className="dm-pool-actions flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>

    <div className="dm-pool-figures mt-8" data-pool-figures="" data-market-read={shown ? (answered?.origin ?? 'read') : loading ? 'loading' : 'none'} data-market-reason={failure?.state}>
      <StatStrip cols={5} className={metricsListed ? 'dm-pool-stats-6' : undefined}>
        <Stat label="Price" className="dm-pool-price-stat" sub={price.state === 'usable'
          ? <><SymbolText token={price.quote} /> per <SymbolText token={price.base} /> · block {price.block}{price.partial && ' · symbol not read'}</>
          : COPY.range.problems[price.problem]}>
          {price.state === 'usable'
            ? <span title={`${price.text}. Pool price from on-chain state at block ${price.block}. A ratio between the two tokens, not a dollar price.${price.stale ? ' Read more than 5 minutes ago on this page.' : ''}`}>{price.text}</span>
            : <Dash title={COPY.range.problems[price.problem]} />}
        </Stat>
        <Stat label="TVL" sub={shown && fromHistory(shown.tvlUsd) ? HISTORY : providerLine}>{figure(shown && <MetricCell metric={shown.tvlUsd} retrieved={retrieved} />)}</Stat>
        <Stat label="24h volume" sub={shown && fromHistory(shown.volume24hUsd) ? HISTORY : providerLine}>{figure(shown && <MetricCell metric={shown.volume24hUsd} retrieved={retrieved} />)}</Stat>
        {metricsListed && (
          <Stat label="24h fees" sub={shown ? HISTORY : loading ? resting : undefined}>
            {shown && !metricsRead ? <Skeleton className="mt-1 h-6 w-20" /> : shown && metricsFailed ? <Dash title={metricsFailed} /> : figure(shown && shown.lpFees24hUsd && <MetricCell metric={shown.lpFees24hUsd} />)}
          </Stat>
        )}
        {aprFromHistory && apr
          ? <Stat label="APR" sub={HISTORY}>{figure(<MetricCell metric={apr} percent />)}</Stat>
          : <Stat label="Est. APR" sub={shown ? 'Estimate, not a return' : undefined}>{figure(shown && <PoolAprEstimate observation={shown.feeAprEstimate} now={now} compact />)}</Stat>}
        <Stat label="Fee tier" sub={option.integration === 'hookless_fixed_fee' ? COPY.picker.hookless : COPY.picker.needsAdapter}>{fee}</Stat>
      </StatStrip>
      <p role="status" aria-live="polite" className="sr-only" data-pool-status={loading ? 'loading' : failure ? failure.state : 'none'}>
        {loading ? 'Reading pool figures…' : failed && !shown ? failed : ''}
      </p>
    </div>

    <div className="mt-8">
      <PoolHistoryChart source={source} option={option} market={shown} loading={loading} failed={failed} />
    </div>

    <div className="dm-card mt-6 animate-rise p-5">
      <h2 className="dm-display dm-display-card">Pool details</h2>
      <dl className={cx('dm-kv dm-pool-kv -mx-5 mt-3', perColumn <= 4 ? 'dm-pool-kv--4' : 'dm-pool-kv--5')}>
        <div><dt>Pool id</dt><dd className="text-fg-muted"><Address value={option.key} /></dd></div>
        <div><dt>Currency 0</dt><dd><PoolTokenLabel token={currency0} /> <span className="text-fg-subtle"><Address value={currency0.address} short /></span></dd></div>
        <div><dt>Currency 1</dt><dd><PoolTokenLabel token={currency1} /> <span className="text-fg-subtle"><Address value={currency1.address} short /></span></dd></div>
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
        <div><dt>24h vol / TVL</dt><dd>{shown ? <TurnoverCell market={shown} retrieved={retrieved} /> : loading ? <Skeleton className="ml-auto h-4 w-12" /> : <Dash title={failed} />}</dd></div>
        <div>
          <dt>Verification</dt>
          <dd>
            Verified at block {option.block} · {option.kind === 'stored' ? 'stored on-chain observation' : option.kind === 'discovery' ? 'found by DexScreener discovery' : `from the catalogue (${option.catalogue?.source === 'initialize_event' ? 'initialize event' : 'verified observation'} at block ${option.catalogue?.block})`}
            {option.requestedById && ' · asked for by id'}
          </dd>
        </div>
      </dl>
      <div className="-mx-3 mt-3 grid gap-1">
        <details className="dm-details">
          <summary>Other provider figures</summary>
          <div className="grid gap-3">
            <ProviderFigure label="Liquidity" figure={option.liquidity} full />
            <ProviderFigure label="24h volume" figure={option.volume} full />
            {option.providerConflict && <p className="text-caption text-money-out">{COPY.picker.providerConflict}</p>}
          </div>
        </details>
        <details className="dm-details">
          <summary>About the APR</summary>
          <div className="grid gap-3 text-[13px] leading-[18px]">
            <dl data-history-apr="">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3"><dt className="text-fg-muted">Pool APR, Domino history</dt><dd className="font-medium">{historyApr}</dd></div>
            </dl>
            {shown ? (
              <PoolAprEstimate observation={shown.feeAprEstimate} now={now} detailed label="Estimated APR" />
            ) : (
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-fg-muted">Estimated APR</span>
                {loading ? <Skeleton className="h-4 w-14" /> : <Dash title={failed} />}
              </div>
            )}
          </div>
        </details>
      </div>
    </div>

    <section className="dm-card mt-6 animate-rise p-5 [--delay:60ms]" aria-labelledby="range-title">
      <h2 id="range-title" className="dm-display dm-display-card">Plan a range</h2>
      <p className="mt-1 max-w-[60ch] text-body text-fg-muted">Pick a band to see where it sits against the pool price. Nothing is saved or sent.</p>
      <div className="mt-5">
        <PoolRangeControls source={source} token={addressKey(currency0.address)} paired={addressKey(currency1.address)} option={option} onOption={onOption} range={range} onRange={onRange} />
      </div>
    </section>

    {listed?.['pool-activity'] && <PoolActivityCard read={activityRead} option={option} now={now} />}
    {listed?.['pool-positions'] && <PoolPositionsCard read={positionsRead} option={option} />}
  </div>
}
