import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import { formatUsdCompact } from '../../../lib/read/decimal'
import { compactUsd, percentText, readNow, type Market, type Metric } from '../../../lib/markets'
import { COPY, failureText } from '../../../lib/read/screens/copy'
import { activityFacts, rowQualified, type ActivityFacts, type AttributedFigure } from '../../../lib/read/screens/figures'
import { useReadSource } from '../../../lib/read/screens/readContext'
import { readWithin } from '../../../lib/read/screens/screenRead'
import { useDialog } from '../../../lib/useDialog'
import { IconClose } from '../../icons'
import { TokenMarkPair } from '../../TokenIcon'
import { Button, IconButton } from '../../ui'
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

/** A titled panel inside the dialog. */
function Panel({ id, title, children, ...rest }: { id: string; title: string; children: ReactNode } & HTMLAttributes<HTMLElement>) {
  return (
    <section aria-labelledby={id} className="dm-inset grid gap-2 p-4" {...rest}>
      <h3 id={id} className="text-body font-medium text-fg">
        {title}
      </h3>
      {children}
    </section>
  )
}

/**
 * A pool's figures on demand, from the Selected pools table. It opens with
 * what the row already read, and makes one pool-activity read for the pool's
 * age and coverage, only after the click. Provider figures are shown as the
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
    <div role="presentation" className="dm-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="pool-figures-title" className="dm-dialog dm-dialog--wide" data-pool-figures-dialog="">
        <div className="grid gap-2 pr-10">
          <p className="text-caption font-medium text-fg-subtle">Pool figures and sources</p>
          <div className="flex min-w-0 items-center gap-3">
            <TokenMarkPair base={market.tokens.base} quote={market.tokens.quote} size={24} ring="var(--surface-2)" />
            <h2 id="pool-figures-title" ref={heading} tabIndex={-1} className="dm-dialog-title min-w-0 outline-none">
              <TokenLabel token={market.tokens.base} />/<TokenLabel token={market.tokens.quote} /> {COPY.figures.open}
            </h2>
          </div>
          <p className="text-fg-muted">
            <Address value={market.poolId} />
          </p>
        </div>
        <IconButton label="Close" icon={<IconClose />} variant="ghost" size="sm" className="dm-dialog-close" onClick={onClose} />

        <div className="grid gap-3">
          <Panel id="figures-estimate" title="Estimated pool fee APR">
            <PoolAprEstimate observation={market.feeAprEstimate} now={readNow()} detailed />
          </Panel>

          <Panel id="figures-qualified" title={qualified ? COPY.figures.qualified : COPY.figures.notQualified} data-figures-qualified={qualified ? 'yes' : 'no'}>
            {qualified ? (
              <dl className="grid gap-1 text-[13px] leading-[18px]">
                <div className="flex justify-between gap-3">
                  <dt className="text-fg-muted">TVL</dt>
                  <dd className="tnum font-medium">{market.tvlUsd.state === 'qualified' ? compactUsd(market.tvlUsd) : 'Not qualified'}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-fg-muted">24h volume</dt>
                  <dd className="tnum font-medium">{market.volume24hUsd.state === 'qualified' ? compactUsd(market.volume24hUsd) : 'Not qualified'}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-fg-muted">Pool APR</dt>
                  <dd className="tnum font-medium">{market.feeAprPercent.state === 'qualified' && apr ? `${apr}%` : 'Not qualified'}</dd>
                </div>
              </dl>
            ) : (
              <p className="text-[13px] leading-[18px] text-fg-muted">{COPY.figures.notQualifiedDetail}</p>
            )}
          </Panel>

          <Panel id="figures-provider" title={COPY.figures.provider} data-figures-provider="">
            {liquidity || volume ? (
              <>
                {liquidity && <ProviderFigure label="Liquidity" figure={liquidity} full />}
                {volume && <ProviderFigure label="24h volume" figure={volume} full />}
              </>
            ) : (
              <p className="text-[13px] leading-[18px] text-fg-muted">
                {market.provenance ? `GeckoTerminal: ${market.provenance.market.status}${cacheAge === null ? '' : `, cache ${cacheAge} s`}. No provider figure is shown for this row.` : 'No provider figures.'}
              </p>
            )}
            <p className="text-caption text-fg-subtle">{COPY.figures.providerDetail}</p>
          </Panel>

          <PoolPriceChart market={market} />

          {reference.length > 0 && (
            <details className="dm-details dm-inset" data-figures-reference="">
              <summary>{COPY.figures.reference}</summary>
              <div className="grid gap-2">
                <p className="text-caption text-fg-subtle">{COPY.figures.referenceDetail}</p>
                <dl className="grid gap-1 text-[13px] leading-[18px]">
                  {reference.map(([label, metric]) => (
                    <div key={label} className="flex justify-between gap-3">
                      <dt className="text-fg-muted">{label}</dt>
                      <dd className="tnum">Not current: {label === 'Fee APR' ? `${percentText(metric) ?? 'Unavailable'}%` : compactUsd(metric)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </details>
          )}

          <Panel id="figures-activity" title={COPY.figures.activity} data-figures-activity={activity.kind}>
            <ScreenStatus line={activity.kind === 'loading' ? { code: 'loading', title: COPY.figures.activityLoading, detail: '' } : activity.kind === 'failed' ? activity.line : null} />
            {activity.kind === 'ok' && (
              <div className="grid gap-1 text-[13px] leading-[18px]" data-pool-age={activity.facts.age?.seconds ?? 'covered'}>
                {activity.facts.age ? (
                  <p>Pool is {activity.facts.age.seconds} s old; the 24h window isn’t complete, so no full-window figure applies.</p>
                ) : (
                  <p>The 24h window is covered ({activity.facts.observedSeconds} s observed).</p>
                )}
                <p className="text-fg-muted">
                  Verified since initialize at block {activity.facts.initializedBlock}; {activity.facts.swaps} swap event{activity.facts.swaps === 1 ? '' : 's'} in the window; fee accounting{' '}
                  {activity.facts.feeAccounting}.
                </p>
                <p className="tnum text-caption text-fg-subtle">
                  Block {activity.facts.block}
                  {activity.facts.stale ? ' · stale' : ''}
                </p>
              </div>
            )}
          </Panel>

          <p className="text-caption text-fg-subtle">{COPY.figures.caveat}</p>
        </div>

        <div className="flex justify-end pt-1">
          <Button onClick={onClose}>{COPY.figures.done}</Button>
        </div>
      </div>
    </div>
  )
}
