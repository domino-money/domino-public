import { useEffect, useRef } from 'react'
import { compactUsd, feeLabel, percentText, presentMetric, turnover, type Market, type MarketProvenance, type Metric, type Presented } from '../lib/markets'
import { reasonText } from '../lib/read/describe'
import { shownResult, useMarkets } from '../lib/read/useMarkets'
import { ReadStatus, marketsStatus } from './read/ReadStatus'
import { TokenLabel } from './read/TokenLabel'
import { TokenMarkPair } from './TokenIcon'
import { Button, Display, Pill, cx } from './ui'

/**
 * Any presented figure: unavailable, not reported, not current, stale with
 * its time, a named provider's, a sample, or current. Titles carry only our
 * own words for a state, never provider text.
 */
function Shown({ shown, strong, muted }: { shown: Presented; strong?: boolean; muted?: boolean }) {
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
    // A gap in the read contract is not the same thing as a source reporting nothing.
    const gap = shown.reason === 'not_in_read_v1'
    return (
      <span className="text-[13px] text-fg-subtle" data-metric="absent" title={gap ? 'The read contract has no field for this figure yet' : 'The source reported no value'}>
        {gap ? 'No source' : 'Not reported'}
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
  const asOf = shown.asOf ? new Date(shown.asOf * 1000).toLocaleString('en-US') : undefined
  return (
    <span
      className={cx(
        'tnum font-mono text-[13px]',
        strong && 'text-fg',
        muted && !shown.stale && 'text-fg-muted',
        shown.stale && 'text-money-wait',
      )}
      style={shown.sample && !strong ? { color: 'var(--fg-muted)' } : undefined}
      data-metric={shown.stale ? 'stale' : shown.sample ? 'placeholder' : shown.source ? 'provider' : 'qualified'}
      title={
        shown.sample
          ? 'Sample figure, not an observation'
          : shown.stale
            ? `Last observed ${asOf}`
            : shown.source
              ? `Reported by ${shown.source}, not reconciled by Domino`
              : undefined
      }
    >
      {shown.text}
      {shown.stale && <span className="ml-1 text-[11px]">· stale</span>}
      {shown.source && <span className="ml-1 text-[11px] text-fg-subtle">· {shown.source}</span>}
    </span>
  )
}

function Cell({ metric, percent, strong }: { metric: Metric; percent?: boolean; strong?: boolean }) {
  const shown = presentMetric(metric, (m) => (percent ? `${percentText(m) ?? 'Unavailable'}%` : compactUsd(m)))
  return <Shown shown={shown} strong={strong} />
}

/** Where a read row's figures came from. Never on sample rows. */
function provenanceLine(p: MarketProvenance) {
  const market = `GeckoTerminal ${p.market.status}${p.market.cacheAgeSeconds === null ? '' : `, cache ${p.market.cacheAgeSeconds} s`}`
  const metrics = p.metrics ? `Domino history ${p.metrics.freshness}, ${p.metrics.ageSeconds} s` : 'Domino history unavailable'
  return `Block ${p.block} · ${market} · ${metrics}`
}

function Row({ m, i }: { m: Market; i: number }) {
  return (
    <tr className="group cursor-pointer border-b transition last:border-b-0 hover:bg-surface-2" {...(m.provenance ? { 'data-fixtures': m.provenance.fixtures.join(' ') } : {})}>
      <td className="px-5 py-4 text-[13px] text-fg-subtle">{i + 1}</td>
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
        {m.provenance && <p className="mt-1.5 font-mono text-[10.5px] text-fg-subtle">{provenanceLine(m.provenance)}</p>}
      </td>
      <td className="px-5 py-4 text-right"><Cell metric={m.tvlUsd} strong /></td>
      <td className="px-5 py-4 text-right"><Cell metric={m.volume24hUsd} /></td>
      <td className="px-5 py-4 text-right"><Cell metric={m.volume30dUsd} /></td>
      <td className="px-5 py-4 text-right"><Shown shown={turnover(m)} muted /></td>
      <td className="px-5 py-4 text-right">
        <span className="inline-flex items-center gap-2">
          <Cell metric={m.feeAprPercent} percent strong />
          <span className="text-fg-subtle transition group-hover:translate-x-0.5" aria-hidden="true">›</span>
        </span>
      </td>
    </tr>
  )
}

const HEAD = ['#', 'Pool', 'TVL', '1D vol', '30D vol', '1D vol/TVL', 'Pool APR']

export function MarketsTable() {
  const { state, provider } = useMarkets()
  const result = shownResult(state)
  const markets = result?.markets ?? []
  const network = result?.network ?? 'Robinhood Chain'
  const reads = provider.kind !== 'sample'

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
            <Display ref={heading} className="text-[30px] outline-none" {...(reads ? { tabIndex: -1 } : {})}>
              Top pools
            </Display>
            {result?.source === 'placeholder' && <Pill tone="wait">Sample data</Pill>}
            {provider.kind === 'fixture' && <Pill tone="wait">Fixture data</Pill>}
          </div>
          <p className="mt-2 max-w-[60ch] text-[14px] text-fg-muted">
            {reads
              ? `Pools on ${network}, read through ${provider.kind === 'fixture' ? 'the read pipeline from contract fixtures' : 'the same-origin read bridge'}.`
              : `Pools on ${network}, built from tokens that exist on the network.`}
            {result?.notice ? ` ${result.notice}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-2 rounded-[var(--radius-pill)] border bg-surface-1 px-3 py-1.5 text-[12px]">
            <span className="h-2 w-2 rounded-full" style={{ background: '#00c805' }} aria-hidden="true" />
            {network}
          </span>
          {reads && (state.phase === 'ready' || refreshing) && (
            <Button variant="ghost" aria-disabled={refreshing ? true : undefined} onClick={refresh}>
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
          )}
          <Button variant="ghost">View all pools →</Button>
        </div>
      </div>

      <ReadStatus status={marketsStatus(state)} onRetry={retry} className="mt-4" />

      <div className="mt-6 overflow-hidden rounded-[20px] border bg-surface-1">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse">
            <thead>
              <tr className="border-b bg-surface-2/60 text-left">
                {HEAD.map((h, i) => (
                  <th key={h} scope="col" className={cx('px-5 py-3 text-[12px] font-normal text-fg-subtle', i >= 2 && 'text-right', i === 0 && 'w-12')}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {markets.map((m, i) => (
                <Row key={m.key} m={m} i={i} />
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t px-5 py-3 text-[12px] leading-relaxed text-fg-subtle">
          Pool APR describes a pool, not a position. It is not a forecast, not a return on your deposit, and says nothing about what a given range would have earned.
        </p>
      </div>
    </div>
  )
}
