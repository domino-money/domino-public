import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Delta, LiveFigure, PeriodTabs, StackedBar, UsdText, type PeriodKey } from '../../figures'
import { TokenMarkPair } from '../../TokenIcon'
import { DataFreshness } from '../../DataFreshness'
import { cx } from '../../ui'
import { useFeeHistory } from '../../../lib/fees/useFeeHistory'
import { usePastReads } from '../../../lib/fees/usePastReads'
import { defaultPeriodFor, periodStart, periodsFor, type FeesPeriod } from '../../../lib/fees/periods'
import type { FeeDisplayState as PositionState } from '../../../lib/fees/types'
import { useLoadMilestone } from '../../../lib/useLoadMilestone'
import { historyLoadQuality } from '../../../lib/fees/freshness'
import { shortDate, shortTime } from '../../../lib/format/time'
import { spanText } from '../../../lib/positionApr'
import type { TokenDisplay } from '../../../lib/read/types'
import { automationImpact, useVaultRecord } from '../../../lib/automationImpact'
import { useAutomation } from '../../../lib/automationState'
import { AUTOMATION_NAME, AutomationImpact } from './AutomationImpact'
import { AutomationFrame } from './AutomationFrame'
import { FeesActivity, TokenFigure } from './FeesActivity'
import { FeesChart } from './FeesChart'
import { PendingPlot } from './PendingPlot'
import { feesView, periodView, type FeesView } from './model'
import { anyPositive, basisOf, type Basis, growth, positive, stateToken, unitsNumber, unitsText, valueFigure, valueUnits } from './value'

export interface FeesCardProps {
  kind: 'plain' | 'compound' | 'domino'
  /** One position. */
  source: { tokenId: string }
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
  /** Whether the card lists the activity under its chart (a position's page shows it in a card of its own, 2026-09-27). */
  activity?: boolean
}

/** A symbol from /state as text (untrusted), or the short address when unreadable. */
const symbolOf = (state: PositionState, i: 0 | 1) => state.currencies[i].symbol ?? `${state.currencies[i].address.slice(0, 6)}…${state.currencies[i].address.slice(-4)}`

/** The token amounts under a legend value: at most six significant digits each, the full value in the title. */
function Amounts({ amounts, state }: { amounts: readonly [bigint, bigint] | null; state: PositionState }) {
  if (!amounts) return null
  return (
    <span className="dm-fees-amounts">
      {([0, 1] as const).map((i) =>
        state.currencies[i].decimals === null ? null : (
          <span key={i}>
            <TokenFigure raw={amounts[i]} currency={state.currencies[i]} /> {symbolOf(state, i)}
          </span>
        ),
      )}
    </span>
  )
}

/** A value with the quote token's symbol after it when the basis is not USD. */
function Value({ basis, units, state, rawPositive = false }: { basis: Basis; units: bigint; state: PositionState; rawPositive?: boolean }) {
  return (
    <>
      {valueFigure(basis, units, rawPositive)}
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

/** The head: the title, an optional mark (a saved copy's), an optional pair row (standalone) and the period tabs. */
function Head({ titleId, state, tokens, standalone, mark, tabs }: { titleId: string; state: PositionState | null; tokens?: readonly [TokenDisplay, TokenDisplay]; standalone?: boolean; mark?: ReactNode; tabs?: ReactNode }) {
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
          Ready to collect
        </span>
        <span className="dm-fees-compact-value">
          {basis && units !== null ? (
            <span className={cx('dm-fig-lg', earning && 'dm-fees-in')} title={title}>
              <Value basis={basis} units={units} state={state} rawPositive={earning} />
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
      label="Ready to collect"
      money={earning}
      title={title}
      value={basis && units !== null ? <Value basis={basis} units={units} state={state} rawPositive={earning} /> : null}
      amounts={<Amounts amounts={state.unclaimed} state={state} />}
    />
  )
}

/**
 * The chart's room when no history can be drawn (2026-09-25): the card keeps its place and its exact figures, and the
 * plot is a flat, quiet line along its foot, at the loaded chart's height (nothing moves when a later read draws one).
 * 2026-10-01 (item A13: an empty plot with no word read as broken, or as a position that earned nothing): one calm grey
 * line over it says why, in plain words. No button: the page asks again itself.
 */
function QuietPlot({ note, why }: { note?: string; why?: string }) {
  return (
    <div className="dm-fees-plot dm-fees-quiet" data-fees-quiet={why ?? ''}>
      <PendingPlot label="Fee history awaiting measurements" note={note ?? 'Updating fee history…'} />
    </div>
  )
}

/**
 * Why there is no history, in a person's words (item A13; the reason itself stays in data-fees-reason). Changed on purpose
 * 2026-10-02 (RPC-SPEC §11.4): a position whose fees earned cannot be told apart from its own deposits and withdrawals
 * says so; its Fees ready to collect is still exact.
 */
export function quietNote(reason: string | undefined): string {
  if (reason === 'rpc_unavailable') return 'Your fee history can’t be read right now. Fees ready to collect is exact.'
  if (reason === 'not_exact') return 'Fees earned can’t be measured for this position. Fees ready to collect is exact.'
  return 'Your fee history isn’t available here. Fees ready to collect is exact.'
}

/** The chart's place before its first measured point. */
export const FEW_POINTS_NOTE = 'The chart fills in as this position’s fees are measured.'

/**
 * A period whose start could not be read (2026-10-02, the periods back): the plot says so in one calm line, and the page
 * asks again by itself (lib/fees/pastReads.ts). All is always drawn.
 */
export const PERIOD_NOTE = 'This period can’t be read right now. Fees earned above is exact.'

const INITIAL_PERIODS: readonly FeesPeriod[] = ['24h', '7d', 'all']

/** A saved copy's time, as every date on the page is written (UTC, item D4). */
const savedWhen = (timestamp: number) => `${shortDate(timestamp)} ${shortTime(timestamp)}`

/**
 * Fees earned (DESIGN-V2 §13): a position's fees since its mint, exactly: every settlement's fees, from its own ledger
 * (lib/fees/ledger.ts), plus the fees ready to collect now. The hero is everything earned at the pool's price now; the
 * chart its measured points; the activity lists the settlements. Before the ledger answers, or when it cannot measure
 * this position, only the on-chain unclaimed figure shows.
 *
 * 2026-09-25 (the owner: the card loaded, then vanished, on his busy-pool positions): once shown, the card stays. While
 * the history is read it shows its exact figures and a calm chart skeleton; a history that cannot be drawn leaves the card
 * with the chain's unclaimed figure and a flat, quiet plot, never an empty place where a card was.
 *
 * Changed on purpose 2026-10-02 (RPC-SPEC §11.4, rugged97's rule 2): no time in range and no estimate: the history is no
 * longer replayed hour by hour from the pool's own logs.
 *
 * Changed on purpose 2026-10-02, later (the owner: "the chart had 24 hours, 7 days and all; that went missing"): the
 * period tabs and the "+x" beside the hero are back, each period from a MEASURED start (lib/fees/periods.ts): a point
 * the history has in the period's window, or one read of the position at a past block (lib/fees/pastReads.ts, through
 * the page's read source). While a start is read the plot keeps its box with the chart's skeleton; one that cannot be
 * read says so in one calm line (the page asks again by itself). The hero and the legend are exact all along. A history
 * with nothing earned yet, a saved copy without the points, and a page where no past read can be made show All alone.
 */
export function FeesCard({ kind, source, bandPresent, quoteIndex, tokens, standalone = false, empty, activity = true }: FeesCardProps) {
  const titleId = useId()
  const id = source.tokenId
  const first = useFeeHistory(kind === 'plain' ? id : null, 'page')
  const [chosen, setChosen] = useState<FeesPeriod | null>(null)
  const [inspected, setInspected] = useState<number | null>(null)

  const drawn = first.phase === 'verified' || first.phase === 'cached' ? first : null
  const basis = useMemo(() => (drawn ? basisOf(drawn.state, quoteIndex) : null), [drawn, quoteIndex])
  const view = useMemo(() => (drawn && basis ? feesView({ id, state: drawn.state, history: drawn.history, basis }) : null), [drawn, basis, id])
  // Period controls keep their place while measurements arrive; an unavailable start never fabricates a series.
  const offered = useMemo<readonly FeesPeriod[]>(() => {
    return view ? periodsFor(view.span, true) : INITIAL_PERIODS
  }, [view])
  const fallback = view ? defaultPeriodFor(view.span) : 'all'
  const period: FeesPeriod = chosen && offered.includes(chosen) ? chosen : offered.includes(fallback) ? fallback : 'all'
  const periodState = usePastReads(kind === 'plain' && drawn ? id : null, period)
  const start = drawn ? periodStart(drawn.history, period) : null
  const pv = useMemo(() => (view && start ? periodView(view, period, start) : null), [view, period, start])
  useLoadMilestone('position', 'chart', kind === 'plain' && view && (pv || periodState === 'unavailable') ? historyLoadQuality(first) : null)

  // 2026-09-27 (the owner: show what Domino's automation did): one position's page reads its sequence (the chip's own
  // read, shared) and, when a vault holds it, that vault's record up to the NFT's latest settlement.
  const state = first.phase === 'loading' || first.phase === 'unclaimed-only' || first.phase === 'verified' || first.phase === 'cached' ? first.state : null
  // The early/saved card must not start a duplicate automation scan before the shared state read supplies it.
  const automation = useAutomation(kind === 'plain' && state && first.phase !== 'cached' ? id : null)
  const sequence = automation.phase === 'ready' && automation.state.automation !== 'plain' && automation.state.automation !== 'other' ? automation.state : null
  // A saved chart never drives automation attribution or its additional reads.
  const own = first.phase === 'verified' && view ? view.sources[0] : null
  const from = own ? own.history.mintedAt.block : 0
  const to = own ? own.history.events.reduce((top, event) => Math.max(top, event.block), from) : 0
  const pair = own ? ([own.state.currencies[0].address, own.state.currencies[1].address] as const) : null
  const vault = useVaultRecord(sequence && own ? sequence.vault : null, id, pair, from, to)
  const record = vault.record
  const impact = useMemo(
    () => (sequence && own && record ? automationImpact({ tokenId: id, kind: sequence.automation, history: own.history, state: own.state, basis: own.basis, record }) : null),
    [sequence, own, record, id],
  )

  if (kind !== 'plain') {
    return <AutomationFrame title="Fees earned" art={kind} empty={empty} />
  }

  const saved = first.phase === 'cached' ? first : null
  // Changed on purpose 2026-10-01 (items A13 and D4): plain words and the page's UTC time; the block is in Details.
  const savedTitle = saved ? `A copy this browser saved of this position’s public history, through ${savedWhen(saved.state.timestamp)}. The chain is read again for the current one.` : undefined
  const reason = first.phase === 'unclaimed-only' || first.phase === 'unavailable' ? first.reason : undefined
  const why = first.phase === 'unclaimed-only' ? first.why : undefined
  const tabs = (
    <span className="dm-fees-tabs">
      <PeriodTabs value={period as PeriodKey} onChange={(next) => { setChosen(next); setInspected(null) }} available={offered as PeriodKey[]} label="Fees earned" />
    </span>
  )
  // The period drawn (2026-10-02): which, whether its start is known, being read or unreadable, and the block it starts at.
  const periodData = drawn ? { 'data-fees-period': period, 'data-fees-period-state': periodState, 'data-fees-period-from': start?.block } : {}
  const root = (phase: string, children: ReactNode, className?: string) => (
    <section className={cx('dm-card dm-fees', className)} aria-labelledby={titleId} data-fees-card="" data-fees-state={phase} data-fees-reason={reason} data-fees-why={why} data-fees-source={saved?.source} data-fees-block={state?.block} data-fees-timestamp={state?.timestamp} {...periodData}>
      {children}
    </section>
  )

  if (first.phase === 'idle' || first.phase === 'unavailable' || first.phase === 'loading' || (state && (state.currencies[0].decimals === null || state.currencies[1].decimals === null))) {
    const loadingBasis = state ? basisOf(state, quoteIndex) : null
    return root(
      first.phase,
      <>
        <Head titleId={titleId} state={state} tokens={tokens} standalone={standalone} tabs={tabs} />
        <div className="dm-fees-body">
          <div className="dm-fees-summary">{state ? <UnclaimedRow state={state} basis={loadingBasis} /> : <span className="dm-fig-hero" aria-label="Fees not available yet">—</span>}</div>
          <PendingPlot label="Fee history awaiting measurements" busy={first.phase !== 'unavailable'} note={first.phase === 'unavailable' ? first.reason === 'rpc_unavailable' ? 'Fee history is temporarily unavailable. Retrying automatically.' : 'Fee history isn’t available for this position.' : 'Updating fee history…'} />
        </div>
      </>,
    )
  }

  if (first.phase === 'unclaimed-only') {
    // No history to draw (2026-09-25: the card stays): the chain's unclaimed figure, and the plot flat and quiet.
    return root(
      'unclaimed-only',
      <>
        <Head titleId={titleId} state={first.state} tokens={tokens} standalone={standalone} tabs={tabs} />
        <div className="dm-fees-body">
          <div className="dm-fees-summary">
            <UnclaimedRow state={first.state} basis={basisOf(first.state, quoteIndex)} large={!bandPresent} />
          </div>
          <QuietPlot note={quietNote(reason)} />
        </div>
      </>,
      bandPresent ? undefined : 'dm-fees--compact',
    )
  }

  if (!view || !basis) return root('unavailable', <><Head titleId={titleId} state={state} tokens={tokens} tabs={tabs} /><PendingPlot label="Fee history awaiting valuation" note="Updating fee values…" /></>)
  const lead = view.sources[0].state
  const blockTitle = savedTitle ?? `Pool price at block ${basis.block}`
  const bucket = inspected === null || !pv ? null : (pv.buckets[inspected] ?? null)
  // The hero: everything earned since the mint, or at the inspected point.
  const heroUnits = bucket ? bucket.earned : view.earned
  const heroText = valueFigure(basis, heroUnits, anyPositive(bucket?.earnedTokens ?? view.earnedTokens))
  // The period's growth beside it: hidden for All, and for a period that starts at the mint (it would repeat the hero).
  const periodGrowth = pv ? growth(pv.base, bucket ? bucket.earned : pv.last) : 0n
  const showDelta = pv !== null && period !== 'all' && pv.from.kind !== 'opened' && positive(periodGrowth)
  const deltaTitle = pv ? `Earned since ${shortDate(pv.start)} ${shortTime(pv.start)} (${spanText(pv.end - pv.start)}), measured at block ${pv.from.block}` : undefined
  const collectedShare = unitsNumber(view.collected)
  const unclaimedShare = unitsNumber(view.unclaimed)
  const split = positive(view.collected) && positive(view.unclaimed)
  // A single real measurement is already a chart point. There is no warm-up gate.
  const chart = pv !== null && pv.points.length > 0
  let plot: ReactNode
  if (pv && chart) {
    plot = (
      <div className="dm-fees-plot">
        <FeesChart view={view} pv={pv} zero={view.zero} onInspect={setInspected} automation={impact ? { adds: impact.adds, by: AUTOMATION_NAME[impact.kind], exactFees: impact.exactFees } : undefined} />
        <p className="dm-fees-window" data-fees-window="" title={`${shortDate(pv.start)} ${shortTime(pv.start)} — ${shortDate(pv.end)} ${shortTime(pv.end)}`}>
          {pv.from.kind === 'opened' ? 'Since opened' : `From ${shortDate(pv.start)} ${shortTime(pv.start)}`}
        </p>
      </div>
    )
  } else if (pv) plot = <QuietPlot note={FEW_POINTS_NOTE} why="few_points" />
  else if (periodState === 'reading') {
    // The period's start is being read: the plot keeps the drawn chart's box; the figures above are exact already.
    plot = <PendingPlot label="Fee history for the selected period" note="Updating this period…" busy />
  } else plot = <QuietPlot note={PERIOD_NOTE} why="period_unavailable" />

  return root(
    saved ? 'cached' : 'verified',
    <>
      <Head titleId={titleId} state={lead} tokens={tokens} standalone={standalone} tabs={tabs} />
      {saved && <span className="sr-only" data-fees-saved="">{savedTitle}</span>}
      <DataFreshness active={saved !== null} scope={id} detail={savedTitle}>Fee history is taking longer to update. Showing the last available figures.</DataFreshness>
      <div className="dm-fees-body" data-zero={view.zero ? '' : undefined}>
        <div className="dm-fees-summary">
          <p className="dm-fees-hero" title={blockTitle}>
            {bucket ? (
              // Inspecting: the point's value as plain text, instantly (no roll while scrubbing).
              basis.kind === 'usd' && !(heroUnits === 0n && !view.zero) ? (
                <UsdText value={unitsText(heroUnits)} dimCents className="dm-fig-hero dm-tick-fig" />
              ) : (
                <span className="dm-fig-hero dm-tick-fig">{heroText}</span>
              )
            ) : (
              <LiveFigure value={heroText} mode="digits" dimCents={basis.kind === 'usd'} className="dm-fig-hero" />
            )}
            {basis.kind === 'quote' && <span className="dm-fees-hero-sym">{symbolOf(lead, basis.into)}</span>}
            {showDelta && (
              <Delta sign={1} size="md" className="dm-fees-delta" title={deltaTitle}>
                {valueFigure(basis, periodGrowth)}
                {basis.kind === 'quote' ? ` ${symbolOf(lead, basis.into)}` : ''}
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
                  Ready to collect
                  <span className="dm-fig-xs dm-fees-zero-fig">
                    <Value basis={basis} units={view.unclaimed} state={lead} />
                  </span>
                </span>
              </div>
            </div>
          ) : (
            <>
              {/* The split bar, then the two rows that name its colours, directly under it; only when there are two parts to
                  split (one solid bar says nothing the rows do not). */}
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
                  value={<Value basis={basis} units={view.collected} state={lead} rawPositive={anyPositive(view.collectedTokens)} />}
                  amounts={<Amounts amounts={view.collectedTokens} state={lead} />}
                />
                <LegendRow
                  tone="unclaimed"
                  label="Ready to collect"
                  title={blockTitle}
                  money={positive(view.unclaimed)}
                  value={<Value basis={basis} units={view.unclaimed} state={lead} rawPositive={anyPositive(view.unclaimedTokens)} />}
                  amounts={<Amounts amounts={view.unclaimedTokens} state={lead} />}
                />
              </div>
              {/* The automation's lines keep their room while the vault's record is read; then they are there, or one quiet
                  line says it has added nothing back yet (2026-10-01, item E22: an empty room read as a broken layout). */}
              {sequence && (impact ? (
                <div className="dm-fees-impact-slot" data-kind={sequence.automation}>
                  <AutomationImpact impact={impact} basis={basis} symbol={basis.kind === 'quote' ? symbolOf(lead, basis.into) : null} />
                </div>
              ) : record ? (
                <p className="dm-fees-impact-none" data-fees-impact="none">No fees added back yet</p>
              ) : !vault.settled ? (
                <div className="dm-fees-impact-slot" data-kind={sequence.automation} aria-hidden="true" />
              ) : null)}
            </>
          )}
        </div>
        {plot}
      </div>
      {activity && <FeesActivity events={view.events} automatic={impact ? { adds: impact.adds, by: AUTOMATION_NAME[impact.kind] } : undefined} />}
    </>,
  )
}

export type { FeesView }
