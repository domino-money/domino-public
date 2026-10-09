/**
 * The fees card's figures (DESIGN-V2 §13): one position's verified history (lib/fees) valued at one price (value.ts).
 * Pure: bigint arithmetic here, plain numbers only for geometry. Nothing here invents a figure.
 *
 * Changed on purpose 2026-10-02 (RPC-SPEC §11.4, rugged97's rule 2: the history is the position's ledger, no hourly
 * replay of its pool): the line is the history's measured points only (opened, right after each settlement, this
 * browser's reads, now); the stretches between two of them are the chart's buckets, each what was earned between two
 * measurements. No hourly buckets and no time in range any more: they needed every hour of the pool's price. One
 * position only: the Positions list's aggregate card was never drawn.
 *
 * Changed on purpose 2026-10-02, later (the owner: the 24H / 7D / 30D / All tabs went missing): the periods are back,
 * each from a measured start (lib/fees/periods.ts periodStart, read at a past block when the history has none,
 * lib/fees/pastReads.ts): `periodView` takes the points from that start on, its earned figure the period's floor.
 */
import type { FeesPeriod } from '../../../lib/fees/periods'
import type { FeeEvent, FeeHistory, FeePoint, FeeDisplayState as PositionState, StateCurrency } from '../../../lib/fees/types'
import { type Basis, valueNumber, valueUnits } from './value'

const ZERO: readonly [bigint, bigint] = [0n, 0n]

/** One verified position: its id, its history, the state it was verified at and the basis its values are in. */
export interface FeesSource {
  id: string
  state: PositionState
  history: FeeHistory
  basis: Basis
}

/** The stretch between two measured points: what was earned in it, and what was collected. */
export interface FeesBucket {
  start: number
  end: number
  /** Cumulative earned value at the stretch's end. */
  earned: bigint
  earnedTokens: readonly [bigint, bigint]
  earnedIn: bigint
  tokensIn: readonly [bigint, bigint]
  collectedIn: bigint
  collectedTokensIn: readonly [bigint, bigint]
}

export interface FeesEvent {
  id: string
  kind: 'mint' | 'collect' | 'increase' | 'decrease' | 'close'
  timestamp: number
  tx: string
  /** The fees it settled; [0, 0] where they are not known (`known` false). */
  fees: readonly [bigint, bigint]
  /** Whether its fees are known (a ledger that is not exact holds settlements whose fees are not). */
  known: boolean
  value: bigint
  basis: Basis
  currencies: readonly [StateCurrency, StateCurrency]
}

/** The chart's view of one period: the measured line from its start, its stretches and its settlements' pips. */
export interface FeesPeriodView {
  period: FeesPeriod
  /** The measured point the period starts at (the opened point for All). */
  from: Pick<FeePoint, 'block' | 't' | 'kind'>
  start: number
  end: number
  /** Earned value at the start (nothing, at the mint), and now. */
  base: bigint
  last: bigint
  /** The measured points: `v` everything earned, `c` the part of it collected by then. */
  points: ReadonlyArray<{ t: number; v: number; c: number }>
  buckets: ReadonlyArray<FeesBucket>
  events: ReadonlyArray<{ t: number; v: number; kind: FeesEvent['kind']; tx: string }>
}

export interface FeesView {
  sources: readonly [FeesSource]
  basis: Basis
  earned: bigint
  collected: bigint
  unclaimed: bigint
  earnedTokens: readonly [bigint, bigint]
  collectedTokens: readonly [bigint, bigint]
  unclaimedTokens: readonly [bigint, bigint]
  /** Earned since the mint is zero in both tokens. */
  zero: boolean
  span: number
  /** Newest first. */
  events: ReadonlyArray<FeesEvent>
  mintedAt: number
  /** How many measured points the line has (the chart draws three or more). */
  measured: number
}

const sub = (a: readonly [bigint, bigint], b: readonly [bigint, bigint]): readonly [bigint, bigint] => [a[0] - b[0], a[1] - b[1]]

/**
 * A position's settlements as Activity rows read them, newest first, valued in `basis`. A collect that settled nothing is no
 * event to a person; a settlement whose fees are not known keeps its row, with no figure.
 */
export function feesEvents(id: string, events: ReadonlyArray<FeeEvent>, basis: Basis, currencies: readonly [StateCurrency, StateCurrency]): FeesEvent[] {
  const out: FeesEvent[] = []
  for (const event of events) {
    const fees = event.fees ?? ZERO
    if (event.kind === 'collect' && event.fees && fees[0] === 0n && fees[1] === 0n) continue
    out.push({ id, kind: event.kind, timestamp: event.timestamp, tx: event.tx, fees, known: event.fees !== null, value: valueUnits(basis, fees), basis, currencies })
  }
  // Newest first; one transaction's two settlements stay in their chain order (a collect before its increase).
  return out.sort((a, b) => b.timestamp - a.timestamp)
}

/** The whole view of one verified history. */
export function feesView(source: FeesSource): FeesView {
  const { history, state, basis } = source
  const events = feesEvents(source.id, history.events, basis, state.currencies)
  const end = history.points.length > 0 ? history.points[history.points.length - 1].t : history.mintedAt.timestamp
  return {
    sources: [source],
    basis,
    earned: valueUnits(basis, history.earned),
    collected: valueUnits(basis, history.collected),
    unclaimed: valueUnits(basis, state.unclaimed),
    earnedTokens: history.earned,
    collectedTokens: history.collected,
    unclaimedTokens: state.unclaimed,
    zero: history.earned[0] === 0n && history.earned[1] === 0n,
    span: Math.max(0, end - history.mintedAt.timestamp),
    events,
    mintedAt: history.mintedAt.timestamp,
    measured: history.points.length,
  }
}

/**
 * The chart's line, stretches and pips of `period`, from its measured `start` (periodStart; the opened point for All) to
 * now: the points from that start on, its earned value the floor (`base`); the settlements after it (the mint's pip
 * only where the period starts at the mint).
 */
export function periodView(view: FeesView, period: FeesPeriod, start: FeePoint): FeesPeriodView {
  const { history, basis } = view.sources[0]
  const points = history.points.filter((point) => point.block >= start.block && point.t >= start.t)
  const end = points.length > 0 ? points[points.length - 1].t : start.t
  const buckets: FeesBucket[] = []
  for (let i = 1; i < points.length; i++) {
    const [before, after] = [points[i - 1], points[i]]
    const earnedIn = sub(after.earned, before.earned)
    const collectedIn = sub(after.collected, before.collected)
    buckets.push({ start: before.t, end: after.t, earned: valueUnits(basis, after.earned), earnedTokens: after.earned, earnedIn: valueUnits(basis, earnedIn), tokensIn: earnedIn, collectedIn: valueUnits(basis, collectedIn), collectedTokensIn: collectedIn })
  }
  const line = points.map((point) => ({ t: point.t, v: valueNumber(basis, point.earned), c: valueNumber(basis, point.collected) }))
  const base = valueUnits(basis, start.earned)
  // Each settlement on the line where it happened: its measured point (right after it). One at the start itself is in
  // the floor already, so only the mint's pip sits there, where the period starts at the mint.
  const opened = start.kind === 'opened'
  const events = view.events
    .filter((event) => (event.timestamp > start.t || (opened && event.timestamp === start.t)) && event.timestamp <= end)
    .map((event) => {
      const at = points.find((point) => point.t >= event.timestamp)
      return { t: event.timestamp, v: event.kind === 'mint' ? valueNumber(basis, start.earned) : valueNumber(basis, at?.earned ?? history.earned), kind: event.kind, tx: event.tx }
    })
    .reverse()
  return { period, from: { block: start.block, t: start.t, kind: start.kind }, start: start.t, end, base, last: view.earned, points: line, buckets, events }
}
