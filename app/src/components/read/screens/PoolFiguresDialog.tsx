import { useEffect, useRef, useState } from 'react'
import { formatUsdCompact } from '../../../lib/read/decimal'
import { compactUsd, percentText, readNow, type Market, type Metric } from '../../../lib/markets'
import { COPY, failureText } from '../../../lib/read/screens/copy'
import { activityFacts, rowQualified, type ActivityFacts, type AttributedFigure } from '../../../lib/read/screens/figures'
import { useReadSource } from '../../../lib/read/screens/readContext'
import { readWithin } from '../../../lib/read/screens/screenRead'
import { useDialog } from '../../../lib/useDialog'
import { TokenMarkPair } from '../../TokenIcon'
import { Button, Card, Display, Eyebrow } from '../../ui'
import { TokenLabel } from '../TokenLabel'
import { Address } from './Address'
import { ProviderFigure } from './ProviderFigure'
import { ScreenStatus, type StatusLine } from './ScreenStatus'
import { PoolAprEstimate } from './PoolAprEstimate'
import { PoolPriceChart } from './PoolPriceChart'

/** A row metric as a GeckoTerminal figure, when that is what it is. */
export function rowProviderFigure(metric: Metric, cacheAgeSeconds: number | null): AttributedFigure | null {
  if (metric.source !== 'GeckoTerminal') return null
  const provider = 'geckoterminal' as const
  if (metric.state === 'absent') return { state: 'not_reported', provider }
  if ((metric.state === 'provider' || metric.state === 'stale') && metric.value !== null && metric.asOf !== undefined) {
    const value = formatUsdCompact(metric.value) ?? 'Unavailable'
    const base = { value, zero: /^\$0\.00$/.test(value), provider, retrievedAt: metric.asOf, cacheAgeSeconds }
    return metric.state === 'stale' ? { state: 'attributed_stale', ...base, refreshReason: null } : { state: 'attributed', ...base }
  }
  return null
}

type Activity = { kind: 'loading' } | { kind: 'ok'; facts: ActivityFacts } | { kind: 'failed'; line: StatusLine }

/**
 * A pool's figures on demand, from the Top pools table. It opens with what
 * the row already read, and makes one pool-activity read for the pool's age
 * and coverage, only after the click. Provider figures are shown as the
 * provider's; Domino's qualified 24h figures only when pool-metrics says they
 * are usable as current; reference analytics folded away and marked not
 * current.
 */
export function PoolFiguresDialog({ market, onClose }: { market: Market; onClose: () => void }) {
  const source = useReadSource()
  const [activity, setActivity] = useState<Activity>({ kind: 'loading' })
  const dialog = useDialog(true, onClose)
  const heading = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    const id = setTimeout(() => heading.current?.focus(), 0)
    return () => clearTimeout(id)
  }, [])

  useEffect(() => {
    if (!source) return
    const controller = new AbortController()
    void readWithin(source, 'pool-activity', { poolId: market.poolId }, { signal: controller.signal }).then((outcome) => {
      if (controller.signal.aborted || outcome.state === 'aborted') return
      setActivity(outcome.state === 'ok' ? { kind: 'ok', facts: activityFacts(outcome.data) } : { kind: 'failed', line: failureText(outcome, 'activity') })
    })
    return () => controller.abort()
  }, [source, market.poolId])

  const cacheAge = market.provenance?.market.cacheAgeSeconds ?? null
  const liquidity = rowProviderFigure(market.tvlUsd, cacheAge)
  const volume = rowProviderFigure(market.volume24hUsd, cacheAge)
  const qualified = rowQualified(market)
  const reference = [
    ['TVL', market.tvlUsd],
    ['24h volume', market.volume24hUsd],
    ['Fee APR', market.feeAprPercent],
  ].filter(([, metric]) => (metric as Metric).state === 'reference') as Array<[string, Metric]>
  const apr = percentText(market.feeAprPercent)

  return (
    <div role="presentation" className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-[2px] sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <Card
        ref={dialog}
        level={2}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pool-figures-title"
        className="grid max-h-[92vh] w-full max-w-[520px] grid-rows-[auto_minmax(0,1fr)_auto] rounded-b-none sm:max-h-[86vh] sm:rounded-b-[var(--radius-lg)]"
        data-pool-figures-dialog=""
      >
        <header className="border-b p-5">
          <Eyebrow>Pool figures · read only</Eyebrow>
          <div className="mt-2 flex items-center gap-3">
            <TokenMarkPair base={market.tokens.base} quote={market.tokens.quote} size={26} />
            <Display as="h2" id="pool-figures-title" ref={heading} tabIndex={-1} className="text-[23px] outline-none">
              <TokenLabel token={market.tokens.base} />/<TokenLabel token={market.tokens.quote} /> {COPY.figures.open}
            </Display>
          </div>
          <p className="mt-2">
            <Address value={market.poolId} />
          </p>
        </header>

        <div className="grid gap-4 overflow-y-auto p-5">
          <section className="grid gap-2 rounded-[var(--radius)] border bg-surface-1 p-4" aria-labelledby="figures-estimate">
            <h3 id="figures-estimate" className="text-[14px] font-medium">Estimated pool fee APR</h3>
            <PoolAprEstimate observation={market.feeAprEstimate} now={readNow()} detailed />
          </section>
          <section aria-labelledby="figures-qualified" className="rounded-[var(--radius)] border bg-surface-1 p-4" data-figures-qualified={qualified ? 'yes' : 'no'}>
            <h3 id="figures-qualified" className="text-[14px] font-medium">
              {qualified ? COPY.figures.qualified : COPY.figures.notQualified}
            </h3>
            {qualified ? (
              <dl className="mt-2 grid gap-1 text-[13px]">
                <div className="flex justify-between gap-3">
                  <dt className="text-fg-muted">TVL</dt>
                  <dd className="tnum font-mono">{market.tvlUsd.state === 'qualified' ? compactUsd(market.tvlUsd) : 'Not qualified'}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-fg-muted">24h volume</dt>
                  <dd className="tnum font-mono">{market.volume24hUsd.state === 'qualified' ? compactUsd(market.volume24hUsd) : 'Not qualified'}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-fg-muted">Pool APR</dt>
                  <dd className="tnum font-mono">{market.feeAprPercent.state === 'qualified' && apr ? `${apr}%` : 'Not qualified'}</dd>
                </div>
              </dl>
            ) : (
              <p className="mt-1 text-[13px] text-fg-muted">{COPY.figures.notQualifiedDetail}</p>
            )}
          </section>

          <section aria-labelledby="figures-provider" className="grid gap-2 rounded-[var(--radius)] border bg-surface-1 p-4" data-figures-provider="">
            <h3 id="figures-provider" className="text-[14px] font-medium">
              {COPY.figures.provider}
            </h3>
            {liquidity || volume ? (
              <>
                {liquidity && <ProviderFigure label="Liquidity" figure={liquidity} full />}
                {volume && <ProviderFigure label="24h volume" figure={volume} full />}
              </>
            ) : (
              <p className="text-[13px] text-fg-muted">
                {market.provenance ? `GeckoTerminal: ${market.provenance.market.status}${cacheAge === null ? '' : `, cache ${cacheAge} s`}. No provider figure is shown for this row.` : 'No provider figures.'}
              </p>
            )}
            <p className="text-[12px] text-fg-subtle">{COPY.figures.providerDetail}</p>
          </section>

          <PoolPriceChart market={market} />

          {reference.length > 0 && (
            <details className="rounded-[var(--radius)] border bg-surface-1 p-4" data-figures-reference="">
              <summary className="cursor-pointer text-[14px] font-medium">{COPY.figures.reference}</summary>
              <p className="mt-1 text-[12px] text-fg-subtle">{COPY.figures.referenceDetail}</p>
              <dl className="mt-2 grid gap-1 text-[13px]">
                {reference.map(([label, metric]) => (
                  <div key={label} className="flex justify-between gap-3">
                    <dt className="text-fg-muted">{label}</dt>
                    <dd className="tnum font-mono">
                      Not current: {label === 'Fee APR' ? `${percentText(metric) ?? 'Unavailable'}%` : compactUsd(metric)}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          )}

          <section aria-labelledby="figures-activity" className="grid gap-2 rounded-[var(--radius)] border bg-surface-1 p-4" data-figures-activity={activity.kind}>
            <h3 id="figures-activity" className="text-[14px] font-medium">
              {COPY.figures.activity}
            </h3>
            <ScreenStatus line={activity.kind === 'loading' ? { code: 'loading', title: COPY.figures.activityLoading, detail: '' } : activity.kind === 'failed' ? activity.line : null} />
            {activity.kind === 'ok' && (
              <div className="grid gap-1 text-[13px]" data-pool-age={activity.facts.age?.seconds ?? 'covered'}>
                {activity.facts.age ? (
                  <p>Pool is {activity.facts.age.seconds} s old; the 24h window isn’t complete, so no full-window figure applies.</p>
                ) : (
                  <p>The 24h window is covered ({activity.facts.observedSeconds} s observed).</p>
                )}
                <p className="text-fg-muted">
                  Verified since initialize at block {activity.facts.initializedBlock}; {activity.facts.swaps} swap event{activity.facts.swaps === 1 ? '' : 's'} in the window; fee accounting{' '}
                  {activity.facts.feeAccounting}.
                </p>
                <p className="font-mono text-[11px] text-fg-subtle">
                  Block {activity.facts.block}
                  {activity.facts.stale ? ' · stale' : ''}
                </p>
              </div>
            )}
          </section>

          <p className="text-[12px] leading-relaxed text-fg-subtle">{COPY.figures.caveat}</p>
        </div>

        <footer className="flex justify-end border-t p-5">
          <Button onClick={onClose}>{COPY.figures.done}</Button>
        </footer>
      </Card>
    </div>
  )
}
