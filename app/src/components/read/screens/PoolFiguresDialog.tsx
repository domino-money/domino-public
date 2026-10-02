import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import { formatUsdCompact } from '../../../lib/read/decimal'
import { reasonText } from '../../../lib/read/describe'
import { compactUsd, percentText, presentMetric, readNow, type Market, type Metric } from '../../../lib/markets'
import { presentAprEstimate } from '../../../lib/read/aprEstimate'
import { COPY, failureText } from '../../../lib/read/screens/copy'
import { ACTIVITY_TOO_OLD, activityAge, activityFacts, activityStaleText, heldSeconds, type ActivityFacts, type AttributedFigure } from '../../../lib/read/screens/figures'
import { useReadSource } from '../../../lib/read/screens/readContext'
import { askAgainLater, readWithin } from '../../../lib/read/screens/screenRead'
import { useDialog } from '../../../lib/useDialog'
import { IconClose } from '../../icons'
import { TokenMarkPair } from '../../TokenIcon'
import { Button, FigureDash, IconButton, Skeleton } from '../../ui'
import { TokenLabel } from '../TokenLabel'
import { Address } from './Address'
import { duration } from './PoolActivityCard'
import { ProviderFigure } from './ProviderFigure'
import { PoolAprEstimate } from './PoolAprEstimate'
import { PoolPriceChart } from './PoolPriceChart'

/**
 * A row metric as a provider's figure, when that is what it is: the read service's (GeckoTerminal), or, since
 * 2026-10-01 (audit V1, V2), DEX Screener's standing in for it or carried by the pools route, dated by its retrieval.
 */
export function rowProviderFigure(metric: Metric, cacheAgeSeconds: number | null): AttributedFigure | null {
  if (metric.source !== 'GeckoTerminal' && metric.source !== 'DexScreener') return null
  const provider = metric.source === 'DexScreener' ? ('dexscreener' as const) : ('geckoterminal' as const)
  if (metric.source === 'DexScreener') cacheAgeSeconds = null
  if (metric.state === 'absent') return { state: 'not_reported', provider }
  if ((metric.state === 'provider' || metric.state === 'stale') && metric.value !== null && metric.asOf !== undefined) {
    const value = formatUsdCompact(metric.value) ?? 'Unavailable'
    const base = { value, raw: metric.value, zero: /^\$0\.00$/.test(value), provider, retrievedAt: metric.asOf, cacheAgeSeconds }
    return metric.state === 'stale' ? { state: 'attributed_stale', ...base, refreshReason: null } : { state: 'attributed', ...base }
  }
  return null
}

/** Pool activity for the dialog: not listed, still reading, the facts with how old they were and when they came, or no answer and why. */
type Activity =
  | { kind: 'off' }
  | { kind: 'loading' }
  | { kind: 'ok'; facts: ActivityFacts; freshness: Parameters<typeof activityAge>[0]; received: { receivedAt: number; receivedMonotonic?: number } }
  | { kind: 'failed'; code: string; reason: string }

/** A titled group inside the dialog. */
function Panel({ id, heading, children, ...rest }: { id: string; heading: string; children: ReactNode } & HTMLAttributes<HTMLElement>) {
  return (
    <section aria-labelledby={id} className="dm-inset grid gap-2 p-4" {...rest}>
      <h3 id={id} className="text-body font-medium text-fg">
        {heading}
      </h3>
      {children}
    </section>
  )
}

/** Domino's own 24h figure: its value when qualified, a dash with the reason when not. */
function History({ metric, percent = false }: { metric: Metric | undefined; percent?: boolean }) {
  if (!metric) return <FigureDash reason="Unavailable: not in this row" />
  // A provider's figure stands where Domino's did not qualify.
  if (metric.source) return <FigureDash reason="Not qualified: the figure shown is the provider’s" />
  if (metric.state !== 'qualified') {
    const shown = presentMetric(metric)
    const why = shown.kind === 'value' ? (shown.stale ? 'Stale, not current' : 'Not qualified') : `${shown.kind === 'not_current' ? 'Not current' : 'Unavailable'}: ${reasonText(shown.reason)}`
    return <FigureDash reason={why} />
  }
  return <>{percent ? `${percentText(metric) ?? '—'}%` : compactUsd(metric)}</>
}

/**
 * A pool's figures on demand, from the Selected pools table. It opens with
 * what the row already read and, where pool-activity is listed, makes one
 * pool-activity read for the pool's age and coverage, only after the click.
 * Provider figures are shown as the provider's; Domino's 24h figures only
 * when pool-metrics says they are usable as current, otherwise a dash with
 * the reason in its title; reference analytics folded away and marked not
 * current. Nothing in it says how a read went, and nothing is a caption.
 */
export function PoolFiguresDialog({ market, onClose }: { market: Market; onClose: () => void }) {
  const source = useReadSource()
  const [activity, setActivity] = useState<Activity>({ kind: 'loading' })
  // Quiet re-asks spent on this pool's activity; another pool starts from none.
  const [asked, setAsked] = useState<{ key: string; attempt: number }>({ key: market.poolId, attempt: 0 })
  const attempt = asked.key === market.poolId ? asked.attempt : 0
  const dialog = useDialog(true, onClose)
  const heading = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    const id = setTimeout(() => heading.current?.focus(), 0)
    return () => clearTimeout(id)
  }, [])

  useEffect(() => {
    if (!source) return
    const controller = new AbortController()
    const { signal } = controller
    void (async () => {
      // Only where the deployment lists pool-activity: a route that is off costs no read and shows no section.
      const listed = source.routeEnabled ? await source.routeEnabled('pool-activity', { signal }).then((answer) => answer.state === 'enabled', () => false) : true
      if (signal.aborted) return
      if (!listed) return setActivity({ kind: 'off' })
      const outcome = await readWithin(source, 'pool-activity', { poolId: market.poolId }, { signal })
      if (signal.aborted || outcome.state === 'aborted') return
      if (outcome.state === 'ok') {
        const { receivedAt, receivedMonotonic } = outcome.provenance
        return setActivity({ kind: 'ok', facts: activityFacts(outcome.data), freshness: outcome.data.freshness, received: { receivedAt, receivedMonotonic } })
      }
      const text = failureText(outcome, 'activity')
      setActivity({ kind: 'failed', code: outcome.state === 'unavailable' && outcome.cause.kind === 'producer' ? outcome.cause.code : text.code, reason: [text.title, text.detail].filter(Boolean).join('. ') })
      if (await askAgainLater(outcome, attempt, signal)) setAsked({ key: market.poolId, attempt: attempt + 1 })
    })()
    return () => controller.abort()
  }, [source, market.poolId, attempt])

  const cacheAge = market.provenance?.market.cacheAgeSeconds ?? null
  const liquidity = rowProviderFigure(market.tvlUsd, cacheAge)
  const volume = rowProviderFigure(market.volume24hUsd, cacheAge)
  const qualified = [market.tvlUsd, market.volume24hUsd, market.feeAprPercent].some((metric) => metric.state === 'qualified')
  // Domino's own 24h history carries two figures no provider reports: the LP fees and the time-weighted TVL the APR is worked out from.
  const history: Array<[string, Metric | undefined]> = [
    ['24h LP fees', market.lpFees24hUsd],
    ['Time-weighted TVL', market.timeWeightedTvlUsd],
  ]
  const reference = ([
    ['TVL', market.tvlUsd],
    ['24h volume', market.volume24hUsd],
    ...history,
    ['Fee APR', market.feeAprPercent],
  ] as Array<[string, Metric | undefined]>).filter((entry): entry is [string, Metric] => entry[1]?.state === 'reference')
  const noProviderFigure = market.provenance ? `Provider observation: ${market.provenance.market.status}${market.provenance.market.reason ? ` (${reasonText(market.provenance.market.reason)})` : ''}. No provider figure is shown for this row.` : 'No provider figures.'
  // The pool's age and coverage count on while the dialog is open; a snapshot too far behind the chain gives neither.
  const age = activity.kind === 'ok' ? activityAge(activity.freshness, heldSeconds(activity.received, readNow())) : null
  const tooOld = age?.state === 'too_old'
  const staleText = activity.kind === 'ok' && age ? activityStaleText(age, activity.facts.block) : null
  const facts = activity.kind === 'ok' && !tooOld ? activity.facts : null
  const activityReason = activity.kind === 'failed' ? activity.reason : (staleText ?? undefined)
  const fact = (node: ReactNode) => (facts ? node : activity.kind === 'failed' || tooOld ? <FigureDash reason={activityReason} /> : <Skeleton className="ml-auto h-4 w-16" />)
  // Figures the store is collecting (marketsProvider.ts, `figuresPending`, added 2026-09-25): loading here as in the
  // row behind the dialog, never "no provider figure" while they are coming.
  const coming = market.figuresPending === true
  const loading = (label: string, data: Record<`data-${string}`, string>) => (
    <span className="inline-flex" {...data}>
      <Skeleton className="h-4 w-24" />
      <span className="sr-only">{label} loading</span>
    </span>
  )

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
          <Panel id="figures-estimate" heading="Estimated pool fee APR">
            {coming && presentAprEstimate(market.feeAprEstimate, readNow()).text === null
              ? loading('Estimated APR', { 'data-apr-estimate': 'pending' })
              : <PoolAprEstimate observation={market.feeAprEstimate} now={readNow()} detailed />}
          </Panel>

          <Panel id="figures-qualified" heading="Domino history, 24h" data-figures-qualified={qualified ? 'yes' : 'no'}>
            <dl className="grid gap-1 text-[13px] leading-[18px]">
              <div className="flex justify-between gap-3">
                <dt className="text-fg-muted">TVL</dt>
                <dd className="tnum font-medium"><History metric={market.tvlUsd} /></dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-fg-muted">24h volume</dt>
                <dd className="tnum font-medium"><History metric={market.volume24hUsd} /></dd>
              </div>
              {history.map(([label, metric]) => (
                <div key={label} className="flex justify-between gap-3">
                  <dt className="text-fg-muted">{label}</dt>
                  <dd className="tnum font-medium"><History metric={metric} /></dd>
                </div>
              ))}
              <div className="flex justify-between gap-3">
                <dt className="text-fg-muted">Pool APR</dt>
                <dd className="tnum font-medium"><History metric={market.feeAprPercent} percent /></dd>
              </div>
            </dl>
          </Panel>

          <Panel id="figures-provider" heading={COPY.figures.provider} data-figures-provider="">
            {liquidity || volume ? (
              <>
                {liquidity && <ProviderFigure label="Liquidity" figure={liquidity} full />}
                {volume && <ProviderFigure label="24h volume" figure={volume} full />}
              </>
            ) : coming ? (
              loading('Provider figures', { 'data-metric': 'pending' })
            ) : (
              <p className="text-[13px] leading-[18px]" data-no-provider-figure="">
                <FigureDash reason={noProviderFigure} />
              </p>
            )}
          </Panel>

          <PoolPriceChart market={market} />

          {reference.length > 0 && (
            <details className="dm-details dm-inset" data-figures-reference="">
              <summary>{COPY.figures.reference}</summary>
              <dl className="grid gap-1 text-[13px] leading-[18px]">
                {reference.map(([label, metric]) => (
                  <div key={label} className="flex justify-between gap-3">
                    <dt className="text-fg-muted">{label}</dt>
                    <dd className="tnum">Not current: {label === 'Fee APR' ? `${percentText(metric) ?? 'Unavailable'}%` : compactUsd(metric)}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}

          {activity.kind !== 'off' && (
            <Panel
              id="figures-activity"
              heading={COPY.figures.activity}
              data-figures-activity={tooOld ? 'unavailable' : activity.kind}
              data-activity-reason={activity.kind === 'failed' ? activity.code : tooOld ? ACTIVITY_TOO_OLD : undefined}
              data-pool-age={facts ? (facts.age?.seconds ?? 'covered') : undefined}
              title={activityReason}
            >
              <p role="status" className="sr-only">{activity.kind === 'loading' ? COPY.figures.activityLoading : activity.kind === 'failed' || tooOld ? activityReason : ''}</p>
              {facts ? (
                <div className="grid gap-1 text-[13px] leading-[18px]">
                  {facts.age ? (
                    <p>Pool is {duration(facts.age.seconds)} old; the 24h window isn’t complete, so no full-window figure applies.</p>
                  ) : (
                    <p>The {facts.windowSeconds === 86400 ? '24h' : `${facts.windowSeconds} s`} window is covered ({facts.observedSeconds} s observed).</p>
                  )}
                  <p className="text-fg-muted">
                    {facts.live
                      ? `Read live from block ${facts.coveredFromBlock}, not indexed since initialize`
                      : `Verified since initialize at block ${facts.initializedBlock}`}
                    ; {facts.swaps} swap event{facts.swaps === 1 ? '' : 's'} in the window; fee accounting {facts.feeAccounting}.
                  </p>
                </div>
              ) : (
                <p className="text-[13px] leading-[18px]">{fact(null)}</p>
              )}
            </Panel>
          )}
        </div>

        <div className="flex justify-end pt-1">
          <Button onClick={onClose}>{COPY.figures.done}</Button>
        </div>
      </div>
    </div>
  )
}
