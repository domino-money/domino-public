import { useEffect, useRef, useState } from 'react'
import {
  compactUsd,
  feeLabel,
  percentText,
  presentMetric,
  providerStale,
  readNow,
  retrievedAgeSeconds,
  retrievedText,
  turnover,
  type Instant,
  type Market,
  type MarketProvenance,
  type Metric,
  type Presented,
} from '../lib/markets'
import { reasonText } from '../lib/read/describe'
import { shownResult, useMarkets } from '../lib/read/useMarkets'
import { ReadStatus, marketsStatus } from './read/ReadStatus'
import { TokenLabel } from './read/TokenLabel'
import { TokenMarkPair } from './TokenIcon'
import { Button, Display, Pill, cx } from './ui'

/**
 * Any presented figure: unavailable, not reported, not current, stale, a
 * named provider's, Domino's calculation from a provider's figures, or
 * current. A provider figure is dated only by when it was retrieved
 * (`retrieved`), never "as of" a time: the provider's own update time is not
 * known. Titles carry only our own words for a state, never provider text.
 */
function Shown({ shown, strong, muted, retrieved }: { shown: Presented; strong?: boolean; muted?: boolean; retrieved?: string }) {
  if (shown.kind === 'unavailable') {
    return (
      <span
        className="text-[13px] text-fg-subtle"
        data-metric={shown.rejected ? 'rejected' : 'unavailable'}
        title={shown.reason ? `Unavailable: ${reasonText(shown.reason)}` : undefined}
      >
        Unavailable
      </span>
    )
  }
  if (shown.kind === 'absent') {
    return (
      <span
        className="text-[13px] text-fg-subtle"
        data-metric="absent"
        title={`Unavailable: ${shown.source ?? 'the source'} reported no value`}
      >
        {shown.source ? `Not reported by ${shown.source}` : 'Not reported'}
      </span>
    )
  }
  if (shown.kind === 'not_current') {
    return (
      <span
        className="text-[13px] text-fg-subtle"
        data-metric="not-current"
        title={shown.basis === 'reference' ? 'Reference analytics only, not a current figure' : 'Calculated over an incomplete window, not a current figure'}
      >
        Not current
      </span>
    )
  }
  return (
    <span
      className={cx(
        'tnum font-mono text-[13px]',
        strong && 'text-fg',
        muted && !shown.stale && 'text-fg-muted',
        shown.stale && 'text-money-wait',
      )}
      data-metric={shown.stale ? 'stale' : shown.source ? 'provider' : shown.calculatedFrom ? 'calculated' : 'qualified'}
      title={valueTitle(shown, retrieved)}
    >
      {shown.text}
      {shown.stale && <span className="ml-1 text-[11px]">· stale</span>}
      {shown.source && <span className="ml-1 text-[11px] text-fg-subtle">· {shown.source}</span>}
      {shown.calculatedFrom && <span className="ml-1 text-[11px] text-fg-subtle">· calculated</span>}
    </span>
  )
}

/** Who a shown figure comes from, and how old it is, in our own words. */
function valueTitle(shown: Extract<Presented, { kind: 'value' }>, retrieved = 'retrieval time unknown') {
  const stale = shown.stale ? ' Stale, not current.' : ''
  if (shown.source) return `Reported by ${shown.source}, ${retrieved}. Not reconciled by Domino.${stale}`
  // Only 24h vol/TVL is calculated from a provider's figures.
  if (shown.calculatedFrom) return `Calculated by Domino from ${shown.calculatedFrom}'s reported 24h volume and TVL, ${retrieved}. Those figures are not reconciled by Domino.${stale}`
  if (!shown.stale) return undefined
  return shown.asOf ? `Last observed ${new Date(shown.asOf * 1000).toLocaleString('en-US')}` : 'Last observed value, not current'
}

function Cell({ metric, percent, strong, retrieved }: { metric: Metric; percent?: boolean; strong?: boolean; retrieved?: string }) {
  const shown = presentMetric(metric, (m) => (percent ? `${percentText(m) ?? 'Unavailable'}%` : compactUsd(m)))
  return <Shown shown={shown} strong={strong} retrieved={retrieved} />
}

/**
 * Where a row's figures came from: the block the pool was verified at, and
 * what GeckoTerminal reported, dated by when it was retrieved, or why it has
 * nothing to show. Never "as of" or "updated at": the provider's own update
 * time is not known.
 */
function provenanceLine(p: MarketProvenance, age: number | null, stale: boolean) {
  const verified = `Pool verified on-chain at block ${p.block}`
  const market =
    p.market.status === 'available' || p.market.status === 'stale'
      ? `Reported by GeckoTerminal, ${retrievedText(age)}${stale ? ' · stale' : ''}`
      : `GeckoTerminal figures ${p.market.status}: ${reasonText(p.market.reason)}`
  if (p.metrics === 'not_requested') return `${verified} · ${market}`
  const metrics = p.metrics ? `Domino history ${p.metrics.freshness}, ${p.metrics.ageSeconds} s` : 'Domino history unavailable'
  return `${verified} · ${market} · ${metrics}`
}

/** This page's clocks, once a second while `active`, so a retrieval age or time on screen keeps counting. */
function useNow(active: boolean) {
  const [now, setNow] = useState(readNow)
  useEffect(() => {
    if (!active) return
    const tick = () => setNow(readNow())
    const first = setTimeout(tick, 0)
    const timer = setInterval(tick, 1000)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [active])
  return now
}

function Row({ m: read, now }: { m: Market; now: Instant }) {
  const p = read.provenance
  const age = p ? retrievedAgeSeconds(p.market, now) : null
  const stale = p ? providerStale(p.market, now) : false
  const retrieved = retrievedText(age)
  // A provider figure past the read service's fresh window is shown stale, never as current.
  const aged = (metric: Metric): Metric => (stale && metric.state === 'provider' ? { ...metric, state: 'stale' } : metric)
  const m: Market = { ...read, tvlUsd: aged(read.tvlUsd), volume24hUsd: aged(read.volume24hUsd) }
  return (
    <tr className="border-b transition last:border-b-0 hover:bg-surface-2">
      <td className="px-5 py-4">
        <div className="flex items-center gap-3">
          <TokenMarkPair base={m.tokens.base} quote={m.tokens.quote} size={30} ring="var(--surface-1)" />
          <span className="text-[14px] font-medium">
            <TokenLabel token={m.tokens.base} />/<TokenLabel token={m.tokens.quote} />
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
            <span className="rounded-[6px] bg-surface-3 px-1.5 py-0.5 font-mono">{m.protocol}</span>
            <span>·</span>
            <span className="font-mono">{feeLabel(m)}</span>
          </span>
        </div>
        {p && (
          <p className="mt-1.5 font-mono text-[10.5px] text-fg-subtle" data-provenance="">
            {provenanceLine(p, age, stale)}
          </p>
        )}
      </td>
      <td className="px-5 py-4 text-right"><Cell metric={m.tvlUsd} strong retrieved={retrieved} /></td>
      <td className="px-5 py-4 text-right"><Cell metric={m.volume24hUsd} retrieved={retrieved} /></td>
      <td className="px-5 py-4 text-right"><Shown shown={turnover(m)} muted retrieved={retrieved} /></td>
      <td className="px-5 py-4 text-right"><Cell metric={m.feeAprPercent} percent strong /></td>
    </tr>
  )
}

/**
 * Column headers, each with what its figures are. The lean table reads
 * pool-market only, so its TVL and 24h volume can only be GeckoTerminal's,
 * and the headers say so (#93) on a second line that every width shows; the
 * ratio is Domino's own. Were a row to carry Domino's own history, they
 * would name no one.
 */
function heads(markets: Market[]): [label: string, note?: string][] {
  const lean = markets.every((m) => m.provenance?.metrics === 'not_requested')
  return [
    ['Pool'],
    ['TVL', lean ? '(reported by GeckoTerminal)' : undefined],
    ['24h volume', lean ? '(reported by GeckoTerminal)' : undefined],
    ['24h vol/TVL', lean ? '(calculated by Domino)' : undefined],
    ['Pool APR'],
  ]
}

/**
 * The pools rugged97 selected for review (src/config/selectedPools.ts), in
 * that order, which is not a ranking. Every figure comes from a validated
 * read and names its provider and age; a figure the read service does not
 * provide, the pool APR today, says so. Nothing is shown in place of a read
 * that failed.
 */
export function MarketsTable() {
  const { state, provider } = useMarkets()
  const result = shownResult(state)
  const markets = result?.markets ?? []
  const network = result?.network ?? 'Robinhood Chain'
  const now = useNow(markets.length > 0)
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

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Display ref={heading} className="text-[30px] outline-none" tabIndex={-1}>
              Selected pools
            </Display>
            {fixtures && <Pill tone="wait">Fixture data</Pill>}
          </div>
          <p className="mt-2 max-w-[60ch] text-[14px] text-fg-muted">
            {fixtures
              ? `Pools on ${network}, read through the read pipeline from contract fixtures.`
              : `Pools selected for review on ${network}, read live through this site's read service. Figures carry their provider and age; anything not provided shows as unavailable.`}
            {result?.notice ? ` ${result.notice}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-2 rounded-[var(--radius-pill)] border bg-surface-1 px-3 py-1.5 text-[12px]">
            <span className="h-2 w-2 rounded-full" style={{ background: '#00c805' }} aria-hidden="true" />
            {network}
          </span>
          {(state.phase === 'ready' || refreshing) && markets.length > 0 && (
            <Button variant="ghost" aria-disabled={refreshing ? true : undefined} onClick={refresh}>
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
          )}
        </div>
      </div>

      <ReadStatus status={marketsStatus(state)} onRetry={retry} className="mt-4" />

      <div className="mt-6 overflow-hidden rounded-[20px] border bg-surface-1">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse">
            <thead>
              <tr className="border-b bg-surface-2/60 text-left">
                {heads(markets).map(([label, note], i) => (
                  <th key={label} scope="col" className={cx('px-5 py-3 align-bottom text-[12px] font-normal text-fg-subtle', i >= 1 && 'text-right')}>
                    {label}
                    {note && (
                      <>
                        {' '}
                        <span className="block text-[11px]">{note}</span>
                      </>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {markets.map((m) => (
                <Row key={m.key} m={m} now={now} />
              ))}
            </tbody>
          </table>
        </div>
        {state.phase === 'ready' && markets.length === 0 && (
          <p className="border-t px-5 py-6 text-center text-[13px] text-fg-muted" data-empty="no-pools">
            No pools selected yet.
          </p>
        )}
        <p className="border-t px-5 py-3 text-[12px] leading-relaxed text-fg-subtle">
          Pool APR describes a pool, not a position. It is not a forecast, not a return on your deposit, and says nothing about what a given range would have earned.
        </p>
      </div>
    </div>
  )
}
