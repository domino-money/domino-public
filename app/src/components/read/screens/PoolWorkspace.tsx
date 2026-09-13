import { useEffect, useState, type ReactNode } from 'react'
import { agedMarket, retrievedAgeSeconds, retrievedText, type Market } from '../../../lib/markets'
import { reasonText } from '../../../lib/read/describe'
import { projectMarketRow } from '../../../lib/read/project'
import { COPY, failureText } from '../../../lib/read/screens/copy'
import { activityFacts, type ActivityFacts } from '../../../lib/read/screens/figures'
import { NATIVE_CURRENCY, addressKey, shortAddress } from '../../../lib/read/screens/identity'
import { poolPrice } from '../../../lib/read/screens/poolRange'
import type { PoolOption } from '../../../lib/read/screens/poolsList'
import { readWithin } from '../../../lib/read/screens/screenRead'
import type { ReadSource } from '../../../lib/read/types'
import { useNow } from '../../../lib/read/useNow'
import { MetricCell, TurnoverCell } from '../../explore/MetricCell'
import { PoolTokenLabel } from '../../PoolCatalogueIdentity'
import { TokenMarkPair } from '../../TokenIcon'
import { Button, Skeleton, Stat, StatStrip, cx } from '../../ui'
import { Address } from './Address'
import { CopyButton } from './CopyButton'
import { PoolAprEstimate } from './PoolAprEstimate'
import { PoolPriceChart } from './PoolPriceChart'
import { PoolRangeControls } from './PoolRangeControls'
import { ProviderFigure } from './ProviderFigure'
import { ScreenStatus, type StatusLine } from './ScreenStatus'
import { SymbolText } from './SymbolText'

/*
 * This file is loaded by tests/pool-workspace.test.mjs with every import but
 * React replaced by a fixed list of stubs, and React by useState, useRef,
 * useCallback and useEffect only. Everything else it draws comes through
 * class names (styles/shell.css, styles/pool.css).
 */

/** Two ticks on the pool's spacing: the band the range planner draws. Nothing is saved or sent. */
type PlannedRange = { lower: number; upper: number }

const Dash = () => <span className="text-fg-subtle">—</span>

/** A duration the way the activity card says it: seconds, minutes, then hours and minutes. */
const duration = (seconds: number) =>
  seconds < 120 ? `${seconds} s` : seconds < 7200 ? `${Math.floor(seconds / 60)} min` : `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`

/** One pool-activity read, made when this mounts (a person asked for it) and cancelled when it unmounts. */
function PoolActivity({ source, poolId }: { source: ReadSource; poolId: string }) {
  const [facts, setFacts] = useState<ActivityFacts | null>(null)
  const [line, setLine] = useState<StatusLine | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void readWithin(source, 'pool-activity', { poolId }, { signal: controller.signal }).then((outcome) => {
      if (controller.signal.aborted || outcome.state === 'aborted') return
      if (outcome.state === 'ok') setFacts(activityFacts(outcome.data))
      else setLine(failureText(outcome, 'activity'))
    })
    return () => controller.abort()
  }, [source, poolId, attempt])
  const loading = facts === null && line === null
  return (
    <section aria-label="Pool activity" className="mt-4">
      <ScreenStatus line={loading ? { code: 'loading', title: 'Reading activity…', detail: '' } : line} onRetry={() => { setLine(null); setAttempt(attempt + 1) }} />
      {facts && (
        <div className="animate-fade">
          <dl className="dm-kv dm-pool-kv dm-pool-kv--3 -mx-5">
            <div><dt>Swaps (24h)</dt><dd>{facts.swaps.toLocaleString('en-US')}</dd></div>
            <div><dt>Pool age</dt><dd>{facts.age ? duration(facts.age.seconds) : 'Older than 24 h'}</dd></div>
            <div><dt>Blocks covered</dt><dd>{facts.initializedBlock} to {facts.block}</dd></div>
            <div><dt>Window</dt><dd>{facts.window === 'covered' ? '24 h covered' : `Partial: ${duration(facts.observedSeconds)} observed`}{facts.stale && <span className="text-money-wait"> · stale</span>}</dd></div>
            <div><dt>Fee accounting</dt><dd>{facts.feeAccounting === 'reconciled' ? 'Reconciled' : 'Unavailable'}</dd></div>
          </dl>
          <p className="mt-2 text-caption text-fg-subtle">Read at block {facts.block}{facts.stale ? ', stale' : ''}. No USD volume or APR comes from this read.</p>
        </div>
      )}
    </section>
  )
}

/**
 * One verified pool on its own page, from the title row down. Its identity is
 * the pool as the pools read described it; its figures come from one lean
 * pool-market read, made once and again only on Retry. The chart and the
 * activity card each make their own read only when a person asks. `actions`
 * is the caller's way onward (a route into the new-position flow); nothing
 * here deposits, signs or quotes anything.
 */
export function PoolWorkspace({ source, option, onOption, range, onRange, actions }: {
  source: ReadSource
  option: PoolOption
  onOption: (next: PoolOption) => void
  range: PlannedRange | null
  onRange: (next: PlannedRange) => void
  actions?: ReactNode
}) {
  const [market, setMarket] = useState<Market | null>(null)
  const [line, setLine] = useState<StatusLine | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [activity, setActivity] = useState(false)
  // One clock for the page: figures age, and a pool price read long ago turns stale, while it is open.
  const now = useNow(true)
  useEffect(() => {
    const controller = new AbortController()
    void readWithin(source, 'pool-market', { poolId: option.key, includePriceHistory: false }, { signal: controller.signal }).then((outcome) => {
      if (controller.signal.aborted || outcome.state === 'aborted') return
      if (outcome.state !== 'ok') { setMarket(null); setLine(failureText(outcome, 'pools')); return }
      setLine(null)
      const row = projectMarketRow({ market: outcome, metrics: null, tokens: new Map() })
      // Use only metadata already returned by the validated pools response,
      // bound again by address. A catalogue label never supplies decimals.
      const tokens = row.tokens
      for (const side of ['base', 'quote'] as const) {
        tokens[side] = option.currencies.find((token) => token.address === tokens[side].address) ?? tokens[side]
      }
      setMarket({ ...row, tokens })
    })
    return () => controller.abort()
  }, [source, option.key, option.currencies, attempt])

  const shown = market ? agedMarket(market, now) : null
  const provenance = shown?.provenance
  const retrieved = retrievedText(provenance ? retrievedAgeSeconds(provenance.market, now) : null)
  const loading = market === null && line === null
  const retry = () => { setLine(null); setAttempt(attempt + 1) }
  const [currency0, currency1] = option.currencies
  const price = poolPrice(option, now.wall)
  const fee = option.fee === 'Dynamic' ? 'Dynamic fee' : option.fee
  const status = provenance?.market.status
  const providerLine = !shown
    ? line ? 'GeckoTerminal figures unavailable' : <span className="mt-2 grid gap-1.5"><Skeleton className="h-2.5 w-20" /><Skeleton className="h-2.5 w-24" /></span>
    : status === 'rejected'
      ? `GeckoTerminal figures rejected: ${reasonText(provenance?.market.reason)}`
      : status === 'unavailable'
        ? `GeckoTerminal figures unavailable: ${reasonText(provenance?.market.reason)}`
        : <><span className="block">GeckoTerminal</span><span className="block">{retrieved}</span></>
  const figure = (node: ReactNode) => (shown ? <span className="animate-fade">{node}</span> : loading ? <Skeleton className="mt-1 h-6 w-24" /> : <span className="text-fg-subtle">Unavailable</span>)

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

    <div className="dm-pool-figures mt-8" data-pool-figures="">
      <StatStrip cols={5}>
        <Stat label="Price" className="dm-pool-price-stat" sub={price.state === 'usable'
          ? <><SymbolText token={price.quote} /> per <SymbolText token={price.base} /> · block {price.block}{price.partial && ' · symbol not read'}</>
          : COPY.range.problems[price.problem]}>
          {price.state === 'usable'
            ? <span title={`Pool price from on-chain state at block ${price.block}. A ratio between the two tokens, not a dollar price.`}>{price.text}</span>
            : <span className="text-fg-subtle">Unavailable</span>}
        </Stat>
        <Stat label="TVL" sub={providerLine}>{figure(shown && <MetricCell metric={shown.tvlUsd} retrieved={retrieved} />)}</Stat>
        <Stat label="24h volume" sub={providerLine}>{figure(shown && <MetricCell metric={shown.volume24hUsd} retrieved={retrieved} />)}</Stat>
        <Stat label="Est. APR" sub={shown ? 'Estimate, not a return' : undefined}>{figure(shown && <PoolAprEstimate observation={shown.feeAprEstimate} now={now} compact />)}</Stat>
        <Stat label="Fee tier" sub={option.integration === 'hookless_fixed_fee' ? COPY.picker.hookless : COPY.picker.needsAdapter}>{fee}</Stat>
      </StatStrip>
    </div>
    <ScreenStatus line={line} className="mt-4" onRetry={retry} />
    {line && !line.retry && <Button variant="outline" size="sm" className="mt-3" onClick={retry}>Read market data again</Button>}

    <div className="mt-8">
      {shown ? <PoolPriceChart market={shown} /> : (
        <div className="dm-card p-5">
          <h2 className="dm-display dm-display-card">USD price and volume</h2>
          <p className="mt-1 text-caption text-fg-subtle">Hourly candles · GeckoTerminal</p>
          <div className="dm-pool-plot dm-dots-chart mt-4">
            <div className="dm-pool-plot-empty">
              {loading
                ? <Skeleton className="dm-pool-plot-baseline" />
                : <p className="max-w-[44ch] text-[13px] leading-[18px] text-fg-muted">Market data is needed to name the chart currency. Read it again above.</p>}
            </div>
          </div>
        </div>
      )}
    </div>

    <div className="dm-card mt-6 animate-rise p-5">
      <h2 className="dm-display dm-display-card">Pool details</h2>
      <dl className={cx('dm-kv dm-pool-kv -mx-5 mt-3', option.tokenMetadata === 'partial' ? 'dm-pool-kv--5' : 'dm-pool-kv--4')}>
        <div><dt>Pool id</dt><dd className="text-fg-muted"><Address value={option.key} /></dd></div>
        <div><dt>Currency 0</dt><dd><PoolTokenLabel token={currency0} /> <span className="text-fg-subtle"><Address value={currency0.address} short /></span></dd></div>
        <div><dt>Currency 1</dt><dd><PoolTokenLabel token={currency1} /> <span className="text-fg-subtle"><Address value={currency1.address} short /></span></dd></div>
        <div><dt>Fee</dt><dd>{fee === 'Dynamic fee' ? fee : `${fee} · fixed`}</dd></div>
        {option.tokenMetadata === 'partial' && <div><dt>Token metadata</dt><dd className="text-money-wait">{COPY.picker.partialMetadata}</dd></div>}
        <div><dt>Tick spacing</dt><dd>{option.tickSpacing}</dd></div>
        <div><dt>Hooks</dt><dd>{option.hooks === NATIVE_CURRENCY ? 'None' : <Address value={option.hooks} short />}</dd></div>
        <div><dt>24h vol / TVL</dt><dd>{shown ? <TurnoverCell market={shown} retrieved={retrieved} /> : loading ? <Skeleton className="ml-auto h-4 w-12" /> : <Dash />}</dd></div>
        <div>
          <dt>Verification</dt>
          <dd>
            Verified at block {option.block} · {option.kind === 'discovery' ? 'found by DexScreener discovery' : `from the catalogue (${option.catalogue?.source === 'initialize_event' ? 'initialize event' : 'verified observation'} at block ${option.catalogue?.block})`}
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
          <summary>About the APR estimate</summary>
          <div className="grid gap-2">
            {shown ? <PoolAprEstimate observation={shown.feeAprEstimate} now={now} detailed /> : <p className="text-caption text-fg-subtle">The estimate arrives with the market read.</p>}
            <p className="text-caption text-fg-subtle">Pool APR from reconciled history: unavailable ({reasonText(option.aprReason)}).</p>
          </div>
        </details>
      </div>
      {provenance && (
        <p className="mt-3 text-caption text-fg-subtle" data-market-provenance="">
          GeckoTerminal market observation: {provenance.market.status}{provenance.market.reason ? ` (${reasonText(provenance.market.reason)})` : ''}, {retrieved}
          {provenance.market.cacheAgeSeconds === null ? '' : `, reported cache age ${provenance.market.cacheAgeSeconds} s`}; counted current for {provenance.market.freshForSeconds} s.
        </p>
      )}
    </div>

    <section className="dm-card mt-6 animate-rise p-5 [--delay:60ms]" aria-labelledby="range-title">
      <h2 id="range-title" className="dm-display dm-display-card">Plan a range</h2>
      <p className="mt-1 max-w-[60ch] text-body text-fg-muted">Pick a band to see where it sits against the pool price. Nothing is saved or sent.</p>
      <div className="mt-5">
        <PoolRangeControls source={source} token={addressKey(currency0.address)} paired={addressKey(currency1.address)} option={option} onOption={onOption} range={range} onRange={onRange} />
      </div>
    </section>

    <div className="dm-card mt-6 animate-rise p-5 [--delay:120ms]">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h2 className="dm-display dm-display-card">On-chain activity</h2>
          <p className="mt-1 text-body text-fg-muted">Swap count and fee accounting from indexed chain events.</p>
        </div>
        {!activity && <Button variant="outline" size="sm" className="dm-pool-activity-button" onClick={() => setActivity(true)}>Read activity</Button>}
      </div>
      {activity ? <PoolActivity source={source} poolId={option.key} /> : (
        <div className="dm-pool-band dm-dots-chart mt-4">
          <p className="text-[13px] leading-[18px] text-fg-subtle">One read, when you ask.</p>
        </div>
      )}
    </div>
  </div>
}
