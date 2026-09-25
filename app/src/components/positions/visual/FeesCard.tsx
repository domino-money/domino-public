import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Delta, LiveFigure, PeriodTabs, StackedBar, UsdText, type PeriodKey } from '../../figures'
import { TokenMarkPair } from '../../TokenIcon'
import { Badge, cx } from '../../ui'
import { useFeeHistories } from '../../../lib/fees/useFeeHistory'
import type { FeeHistoryView, PositionState } from '../../../lib/fees/types'
import type { TokenDisplay } from '../../../lib/read/types'
import { AutomationFrame } from './AutomationFrame'
import { FeesActivity, TokenFigure } from './FeesActivity'
import { FeesChart, percentText } from './FeesChart'
import { FeesSkeleton } from './FeesSkeleton'
import { feesView, periodView, realisedApr, type FeesPeriod, type FeesSource, type FeesView } from './model'
import { anyPositive, basisOf, type Basis, growth, positive, stateToken, unitsNumber, unitsText, valueFigure, valueUnits } from './value'

export interface FeesCardProps {
  kind: 'plain' | 'compound' | 'domino'
  /** One position, or the Positions list's aggregate (§13.7). */
  source: { tokenId: string } | { tokenIds: readonly string[] }
  /** The hooks' download budget: a position page, or the list. */
  scope?: 'page' | 'list'
  /** The page already shows UNCLAIMED FEES (the value band): no compact card repeats it. */
  bandPresent: boolean
  /** Non-USDG pairs: the quote token of the page's price orientation. */
  quoteIndex?: 0 | 1
  /** The pair's marks, when the page has them. */
  tokens?: readonly [TokenDisplay, TokenDisplay]
  /** §12.4: under a position read that failed, the card names its pair itself. */
  standalone?: boolean
  /** Automation kinds: the caller's existing sentence. */
  empty?: ReactNode
}

/** The realised Fee APR row (§13.2-5) waits for the owner's yes (§21-3): built, and off. */
const SHOW_REALISED_APR = false

/** A symbol from /state as text (untrusted), or the short address when unreadable. */
const symbolOf = (state: PositionState, i: 0 | 1) => state.currencies[i].symbol ?? `${state.currencies[i].address.slice(0, 6)}…${state.currencies[i].address.slice(-4)}`

/** The token amounts under a legend value: at most six significant digits each, the full value in the title (`near`: "≈" before it). */
function Amounts({ amounts, state, near = false }: { amounts: readonly [bigint, bigint] | null; state: PositionState; near?: boolean }) {
  if (!amounts) return null
  return (
    <span className="dm-fees-amounts">
      {([0, 1] as const).map((i) =>
        state.currencies[i].decimals === null ? null : (
          <span key={i}>
            <TokenFigure raw={amounts[i]} currency={state.currencies[i]} near={near} /> {symbolOf(state, i)}
          </span>
        ),
      )}
    </span>
  )
}

/** A value with the quote token's symbol after it when the basis is not USD. */
function Value({ basis, units, state }: { basis: Basis; units: bigint; state: PositionState }) {
  return (
    <>
      {valueFigure(basis, units)}
      {basis.kind === 'quote' && <span className="dm-fees-sym"> {symbolOf(state, basis.into)}</span>}
    </>
  )
}

/** One legend row: a dot, the label, the value and the token amounts under it (36 high). */
function LegendRow({ tone, label, value, amounts, title, money }: { tone: 'collected' | 'unclaimed'; label: string; value: ReactNode; amounts?: ReactNode; title?: string; money?: boolean }) {
  return (
    <div className="dm-fees-legend-row" data-tone={tone}>
      <span className="dm-fees-legend-label">
        <span aria-hidden="true" className="dm-fees-dot" data-tone={tone} />
        {label}
      </span>
      <span className="dm-fees-legend-value">
        <span className={cx('dm-fig-xs', money && 'dm-fees-in')} title={title}>
          {value}
        </span>
        {amounts}
      </span>
    </div>
  )
}

/** The head: the title, an optional mark (the estimate's "est."), an optional pair row (standalone) and the period tabs. */
function Head({ titleId, state, tokens, standalone, tabs, mark }: { titleId: string; state: PositionState | null; tokens?: readonly [TokenDisplay, TokenDisplay]; standalone?: boolean; tabs?: ReactNode; mark?: ReactNode }) {
  const marks = tokens ?? (state ? ([stateToken(state.currencies[0]), stateToken(state.currencies[1])] as const) : null)
  return (
    <div className="dm-fees-head">
      <div className="dm-fees-title">
        <h2 id={titleId} className="dm-title">
          Fees earned
        </h2>
        {mark}
        {standalone && marks && state && (
          <span className="dm-fees-pair">
            <TokenMarkPair base={marks[0]} quote={marks[1]} size={24} />
            <span className="dm-fees-pair-name">
              <bdi>{symbolOf(state, 0)}</bdi> / <bdi>{symbolOf(state, 1)}</bdi>
            </span>
          </span>
        )}
      </div>
      {tabs}
    </div>
  )
}

/** The on-chain unclaimed figure alone (§13.3 unclaimed-only; also the known row while the rest loads). */
function UnclaimedRow({ state, basis, large = false }: { state: PositionState; basis: Basis | null; large?: boolean }) {
  const units = basis ? valueUnits(basis, state.unclaimed) : null
  const earning = anyPositive(state.unclaimed)
  const title = basis ? `Pool price at block ${basis.block}` : undefined
  if (large) {
    return (
      <div className="dm-fees-compact-row" data-tone="unclaimed">
        <span className="dm-fees-legend-label">
          <span aria-hidden="true" className="dm-fees-dot" data-tone="unclaimed" />
          Unclaimed
        </span>
        <span className="dm-fees-compact-value">
          {basis && units !== null ? (
            <span className={cx('dm-fig-lg', earning && 'dm-fees-in')} title={title}>
              <Value basis={basis} units={units} state={state} />
            </span>
          ) : null}
          <Amounts amounts={state.unclaimed} state={state} />
        </span>
      </div>
    )
  }
  return (
    <LegendRow
      tone="unclaimed"
      label="Unclaimed"
      money={earning}
      title={title}
      value={basis && units !== null ? <Value basis={basis} units={units} state={state} /> : null}
      amounts={<Amounts amounts={state.unclaimed} state={state} />}
    />
  )
}

/**
 * The chart's room when no history can be drawn (2026-09-25): the card keeps its place and its exact figures, and the
 * plot is a flat, quiet line along its foot, at the loaded chart's height (nothing moves when a later run draws one).
 */
function QuietPlot() {
  return (
    <div className="dm-fees-plot dm-fees-quiet" aria-hidden="true" data-fees-quiet="">
      <svg className="dm-fees-quiet-line" viewBox="0 0 100 2" preserveAspectRatio="none" focusable="false">
        <line x1="0" y1="1" x2="100" y2="1" className="dm-fees-flat" />
      </svg>
    </div>
  )
}

/** Fee APR: the realised rate over the history, when one can be worked out (off until the owner's yes). */
function AprRow({ view }: { view: FeesView }) {
  const apr = realisedApr(view)
  if (apr === null) return null
  return (
    <div className="dm-fees-legend-row">
      <span className="dm-fees-legend-label">Fee APR</span>
      <span className="dm-fig-xs dm-fees-in">{`${(apr * 100).toFixed(2)}%`}</span>
    </div>
  )
}

/** The phase of several views taken together: verified only when every one is. */
function combined(views: ReadonlyArray<FeeHistoryView>): FeeHistoryView['phase'] {
  if (views.length === 0) return 'idle'
  if (views.every((view) => view.phase === 'verified')) return 'verified'
  if (views.every((view) => view.phase === 'verified' || view.phase === 'estimated')) return 'estimated'
  if (views.some((view) => view.phase === 'loading')) return 'loading'
  if (views.some((view) => view.phase === 'idle')) return 'idle'
  return views.find((view) => view.phase !== 'verified')?.phase ?? 'unavailable'
}

/** The drawn sources (verified, or estimated), each with its basis; null when any cannot be valued (an unknown decimals: nothing is guessed). */
function sourcesOf(ids: readonly string[], views: ReadonlyMap<string, FeeHistoryView>, quoteIndex: 0 | 1): FeesSource[] | null {
  const out: FeesSource[] = []
  for (const id of ids) {
    const view = views.get(id)
    if (view?.phase !== 'verified' && view?.phase !== 'estimated') return null
    const basis = basisOf(view.state, quoteIndex)
    if (!basis) return null
    out.push({ id, state: view.state, history: view.history, basis })
  }
  return out
}

/**
 * Fees earned (DESIGN-V2 §13): a position's fees since its mint, rebuilt
 * from public chain logs and drawn only when the replay equals the chain bit
 * for bit (§15.5). The hero is everything earned (collected + unclaimed) at
 * the pool's price now; the chart is its growth in the chosen period, with
 * each bucket's earnings, the settlements and time in range; the activity
 * lists the settlements. Before the replay verifies only the on-chain
 * unclaimed figure may show.
 *
 * 2026-09-25 (the owner: the card loaded, then vanished, on his busy-pool
 * positions): once shown, the card stays. While the history is read it shows
 * its exact figures and a calm chart skeleton; a busy pool's history is drawn
 * estimated first (`estimated`: the chart and its shape marked "est.", the
 * figures the chain's own, Time in range left out), then exact; a history that
 * cannot be drawn leaves the card with the chain's unclaimed figure and a flat,
 * quiet plot, never an empty place where a card was.
 */
export function FeesCard({ kind, source, scope = 'page', bandPresent, quoteIndex = 1, tokens, standalone = false, empty }: FeesCardProps) {
  const titleId = useId()
  const list = 'tokenIds' in source
  // One string per id set, so a new array with the same ids is the same card.
  const key = list ? source.tokenIds.join(',') : source.tokenId
  const ids = useMemo(() => key.split(','), [key])
  const views = useFeeHistories(kind === 'plain' ? ids : null, scope)
  const [chosen, setChosen] = useState<FeesPeriod | null>(null)
  const [inspected, setInspected] = useState<number | null>(null)

  const phase = combined(ids.map((id) => views.get(id) ?? { phase: 'idle' as const }))
  const sources = useMemo(() => (phase === 'verified' || phase === 'estimated' ? sourcesOf(ids, views, quoteIndex) : null), [phase, ids, views, quoteIndex])
  const view = useMemo(() => (sources ? feesView(sources) : null), [sources])
  const period: FeesPeriod = view && chosen && view.periods.includes(chosen) ? chosen : (view?.defaultPeriod ?? 'all')
  const pv = useMemo(() => (view ? periodView(view, period) : null), [view, period])

  if (kind !== 'plain') {
    return <AutomationFrame title="Fees earned" art={kind} empty={empty} />
  }

  const first = views.get(ids[0])
  const state = first && (first.phase === 'loading' || first.phase === 'unclaimed-only' || first.phase === 'verified' || first.phase === 'estimated') ? first.state : null
  const reason = first && (first.phase === 'unclaimed-only' || first.phase === 'unavailable') ? first.reason : undefined
  // A currency with unknown decimals: no guessed formatting, no card (§15.6).
  if (state && (state.currencies[0].decimals === null || state.currencies[1].decimals === null)) return null
  const root = (state_: string, children: ReactNode, className?: string) => (
    <section className={cx('dm-card dm-fees', className)} aria-labelledby={titleId} data-fees-card="" data-fees-state={state_} data-fees-reason={reason}>
      {children}
    </section>
  )

  // The list's aggregate shows only when every history verified: no skeleton that could vanish (§11.1-6).
  if (list && (phase !== 'verified' || !view || !pv)) return null
  if (phase === 'idle') return null
  // Not even the unclaimed figure could be read: the store reaches this only before the card was ever shown (its first
  // /state read failed) or once the NFT is gone, so nothing that was on screen goes away.
  if (phase === 'unavailable') return null

  if (phase === 'loading') {
    const basis = state ? basisOf(state, quoteIndex) : null
    return root(
      'loading',
      <>
        <Head titleId={titleId} state={state} tokens={tokens} standalone={standalone} />
        <FeesSkeleton unclaimed={state ? <UnclaimedRow state={state} basis={basis} /> : undefined} />
      </>,
    )
  }

  if (phase === 'unclaimed-only') {
    if (!state) return null
    // No history to draw (2026-09-25: the card stays): the chain's unclaimed figure, and the plot flat and quiet.
    return root(
      'unclaimed-only',
      <>
        <Head titleId={titleId} state={state} tokens={tokens} standalone={standalone} />
        <div className="dm-fees-body">
          <div className="dm-fees-summary">
            <UnclaimedRow state={state} basis={basisOf(state, quoteIndex)} large={!bandPresent} />
          </div>
          <QuietPlot />
        </div>
      </>,
      bandPresent ? undefined : 'dm-fees--compact',
    )
  }

  if (!view || !pv) return null
  const estimated = phase === 'estimated'
  const { basis } = view
  const lead = view.sources[0].state
  const blockTitle = `Pool price at block ${basis.block}`
  const bucket = inspected === null ? null : (pv.buckets[inspected] ?? null)
  // The hero: everything earned since the mint, or at the inspected bucket's end.
  const heroUnits = bucket ? bucket.earned : view.earned
  const heroText = valueFigure(basis, heroUnits)
  const periodGrowth = growth(pv.base, bucket ? bucket.earned : pv.last)
  // Hidden for All, and for a period that reaches back to the mint (it would repeat the hero).
  const showDelta = period !== 'all' && pv.start > view.mintedAt && positive(periodGrowth)
  const collectedShare = unitsNumber(view.collected)
  const unclaimedShare = unitsNumber(view.unclaimed)
  const split = positive(view.collected) && positive(view.unclaimed)
  // An estimate's time in range is sampled too: left out (the chart's strip, marked "est." with it, shows its look).
  const timeInRange = estimated ? null : view.timeInRange

  const tabs = (
    <PeriodTabs value={period as PeriodKey} onChange={(next) => { setChosen(next); setInspected(null) }} available={view.periods as PeriodKey[]} label="Fees earned" />
  )

  return root(
    estimated ? 'estimated' : 'verified',
    <>
      <Head titleId={titleId} state={lead} tokens={tokens} standalone={standalone} tabs={<span className="dm-fees-tabs">{tabs}</span>} mark={estimated ? <Badge kind="estimate" data-fees-estimate="" /> : undefined} />
      <div className="dm-fees-body" data-zero={view.zero ? '' : undefined}>
        <div className="dm-fees-summary">
          <p className="dm-fees-hero" title={blockTitle}>
            {bucket ? (
              // Inspecting: the bucket's end value as plain text, instantly (no roll while scrubbing).
              basis.kind === 'usd' ? (
                <UsdText value={unitsText(heroUnits)} dimCents className="dm-fig-hero dm-tick-fig" />
              ) : (
                <span className="dm-fig-hero dm-tick-fig">{heroText}</span>
              )
            ) : (
              <LiveFigure value={heroText} mode="digits" dimCents={basis.kind === 'usd'} className="dm-fig-hero" />
            )}
            {basis.kind === 'quote' && <span className="dm-fees-hero-sym">{symbolOf(lead, basis.into)}</span>}
            {showDelta && (
              <Delta sign={1} size="md" className="dm-fees-delta">
                {valueFigure(basis, periodGrowth)}
                {basis.kind === 'quote' ? ` ${symbolOf(lead, basis.into)}` : ''}
                {/* 2026-09-25 (review): an estimate's growth in the period is sampled too. */}
                {estimated ? ' est.' : ''}
              </Delta>
            )}
          </p>

          {view.zero ? (
            // Nothing earned yet: one quiet row says both figures; no split bar (a bare track reads as an empty progress bar).
            <div className="dm-fees-legend dm-fees-legend--zero">
              <div className="dm-fees-legend-row" title={blockTitle}>
                <span className="dm-fees-legend-label">
                  <span aria-hidden="true" className="dm-fees-dot" data-tone="collected" />
                  Collected
                  <span className="dm-fig-xs dm-fees-zero-fig">
                    <Value basis={basis} units={view.collected} state={lead} />
                  </span>
                </span>
                <span className="dm-fees-legend-label">
                  <span aria-hidden="true" className="dm-fees-dot" data-tone="unclaimed" />
                  Unclaimed
                  <span className="dm-fig-xs dm-fees-zero-fig">
                    <Value basis={basis} units={view.unclaimed} state={lead} />
                  </span>
                </span>
              </div>
            </div>
          ) : (
            <>
              {/* The split bar, then the two rows that name its colours, directly under it; only when there are two parts to
                  split (one solid bar says nothing the rows do not, and would read as a second Time in range). */}
              {split && (
                <StackedBar
                  className="dm-fees-split"
                  parts={[{ share: collectedShare, tone: 'primary' }, { share: unclaimedShare, tone: 'in' }]}
                  height={6}
                />
              )}
              <div className="dm-fees-legend">
                <LegendRow
                  tone="collected"
                  label="Collected"
                  title={blockTitle}
                  value={<Value basis={basis} units={view.collected} state={lead} />}
                  amounts={<Amounts amounts={view.collectedTokens} state={lead} near={view.near} />}
                />
                <LegendRow
                  tone="unclaimed"
                  label="Unclaimed"
                  title={blockTitle}
                  money={positive(view.unclaimed)}
                  value={<Value basis={basis} units={view.unclaimed} state={lead} />}
                  amounts={<Amounts amounts={view.unclaimedTokens} state={lead} />}
                />
                {SHOW_REALISED_APR && <AprRow view={view} />}
              </div>
            </>
          )}

          {/* Time in range last, under a hairline, with its own bar: never read as a second split. */}
          {timeInRange !== null && (
            <div className="dm-fees-tir">
              <div className="dm-fees-tir-row">
                <span className="dm-fees-tir-label">Time in range</span>
                <span className="dm-fig-xs">{percentText(timeInRange)}</span>
              </div>
              <StackedBar parts={[{ share: timeInRange, tone: 'in' }, { share: 1 - timeInRange, tone: 'muted' }]} height={4} />
            </div>
          )}
        </div>
        <div className="dm-fees-plot">
          <FeesChart view={view} pv={pv} zero={view.zero} onInspect={setInspected} estimated={estimated} />
        </div>
      </div>
      <FeesActivity view={view} ids={list} />
    </>,
    list ? 'dm-arrive' : undefined,
  )
}

export type { FeesView }
