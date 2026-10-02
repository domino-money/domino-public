/**
 * A position's ledger (POST /api/fees/v2/ledger, functions/_lib/feesLedger.ts) folded with the chain's state into what the
 * screens draw (RPC-SPEC §11.4, 2026-10-02: rugged97's rule 2, a fees history from eth_call and our own events):
 *
 *   Fees earned  = every settlement's fees (the ledger's, exact) + the fees ready to collect now (/state, exact)
 *   its points   = measured ones only: opened (nothing), right after each settlement (the position owes nothing then, so
 *                  the fees settled so far are everything it earned), each read this browser kept (readings.ts: the fees
 *                  settled up to it plus its unclaimed figure), and now
 *
 * Nothing between two points is a measurement: the chart draws a straight guide between them, and says so.
 *
 * The ledger is used only while the state agrees with it (`agreement`): a state at or past the ledger's block must show the
 * same liquidity and the same fee growth settled-to (feeGrowthInsideLast) as the ledger's own state; any settlement since
 * changes one of them, and the store then asks the ledger again, fresh. A state older than the ledger takes the ledger's
 * settlements up to its own block. Pure and Node-safe.
 */
import type { FeeEvent, FeeHistory, FeeHistoryView, FeePoint, LedgerPosition, PositionState, StatePositionOk } from './types'
import type { Reading } from './readings'

/** A ledger that answered, with the block and time its state was read at (the answer's). */
export interface LedgerRead {
  position: Extract<LedgerPosition, { ok: true }>
  block: number
  timestamp: number
}

const ZERO: readonly [bigint, bigint] = [0n, 0n]
const add = (a: readonly [bigint, bigint], b: readonly [bigint, bigint]): readonly [bigint, bigint] => [a[0] + b[0], a[1] + b[1]]
const atMost = (a: readonly [bigint, bigint], b: readonly [bigint, bigint]) => a[0] <= b[0] && a[1] <= b[1]

/** The ledger's settlements as the screens' events, oldest first (fees null where it cannot tell them). */
export function eventsOf(ledger: LedgerRead['position']): FeeEvent[] {
  return ledger.entries.map((entry) => ({
    kind: entry.kind,
    block: entry.block,
    timestamp: entry.t,
    tx: entry.tx,
    fees: entry.fees ? [BigInt(entry.fees[0]), BigInt(entry.fees[1])] : null,
    liquidityDelta: BigInt(entry.delta),
    ...(entry.auto ? { auto: true as const } : {}),
    ...(entry.service ? { service: [BigInt(entry.service[0]), BigInt(entry.service[1])] as const } : {}),
  }))
}

/**
 * Whether a state (`read`, at `block`) agrees with the ledger: `current` (at or past the ledger's block, nothing settled
 * since), `behind` (older than the ledger, and its liquidity is the ledger's at its block: the ledger's settlements up to
 * it apply), or `stale` (a settlement the ledger does not hold, or a state that does not fit it).
 */
export function agreement(ledger: LedgerRead, read: Pick<StatePositionOk, 'liquidity' | 'feeGrowthInside0LastX128' | 'feeGrowthInside1LastX128' | 'poolId' | 'tickLower' | 'tickUpper'>, block: number): 'current' | 'behind' | 'stale' {
  const own = ledger.position.state
  if (read.poolId !== own.poolId || read.tickLower !== own.tickLower || read.tickUpper !== own.tickUpper) return 'stale'
  if (block >= ledger.block) {
    return read.liquidity === own.liquidity && read.feeGrowthInside0LastX128 === own.feeGrowthInside0LastX128 && read.feeGrowthInside1LastX128 === own.feeGrowthInside1LastX128 ? 'current' : 'stale'
  }
  const liquidity = ledger.position.entries.filter((entry) => entry.block <= block).reduce((sum, entry) => sum + BigInt(entry.delta), 0n)
  return liquidity === BigInt(read.liquidity) ? 'behind' : 'stale'
}

/**
 * The view of `state` with `ledger`: verified when the ledger is exact (the state agreeing with it, as the caller checked),
 * Fees ready to collect only otherwise, with the settlements the ledger found. `readings`: this browser's reads of the
 * position (readings.ts), points between the settlements.
 */
export function foldLedger(ledger: LedgerRead, state: PositionState, readings: readonly Reading[] = []): FeeHistoryView {
  const { position } = ledger
  const events = eventsOf(position).filter((event) => event.block <= state.block)
  const mint = position.mint
  if (!position.exact || !mint || events.some((event) => event.fees === null)) {
    return { phase: 'unclaimed-only', state, reason: 'not_exact', ...(position.why ? { why: position.why } : {}), events }
  }
  const points: FeePoint[] = [{ block: mint.block, t: mint.t, earned: ZERO, collected: ZERO, kind: 'opened' }]
  let settled: readonly [bigint, bigint] = ZERO
  for (const event of events) {
    if (event.kind === 'mint') continue
    settled = add(settled, event.fees ?? ZERO)
    const point: FeePoint = { block: event.block, t: event.timestamp, earned: settled, collected: settled, kind: 'settlement' }
    // Two settlements of one block (a collect and the increase after it): one point, after both.
    if (points[points.length - 1].block === event.block) points[points.length - 1] = point
    else points.push(point)
  }
  const earned = add(settled, state.unclaimed)
  const now: FeePoint = { block: state.block, t: state.timestamp, earned, collected: settled, kind: 'now' }
  // This browser's reads between the settlements: each the fees settled up to it plus its unclaimed figure then, kept only
  // where it fits between the measured points around it (earned only grows).
  const settledAt = (block: number) => events.filter((event) => event.block <= block && event.kind !== 'mint').reduce<readonly [bigint, bigint]>((sum, event) => add(sum, event.fees ?? ZERO), ZERO)
  const all = [...points]
  for (const reading of readings) {
    if (reading.block <= mint.block || reading.block >= state.block || reading.t <= mint.t || reading.t >= state.timestamp) continue
    if (all.some((point) => point.block === reading.block)) continue
    const before = settledAt(reading.block)
    all.push({ block: reading.block, t: reading.t, earned: add(before, reading.unclaimed), collected: before, kind: 'reading' })
  }
  all.sort((a, b) => a.block - b.block)
  const kept: FeePoint[] = []
  for (const point of all) {
    const last = kept[kept.length - 1]
    if (point.kind === 'reading' && ((last && (!atMost(last.earned, point.earned) || point.t <= last.t)) || !atMost(point.earned, earned))) continue
    kept.push(point)
  }
  // A reading that read past the next settlement's figure is left out too (earned only grows).
  const measured = kept.filter((point, i) => point.kind !== 'reading' || (i + 1 >= kept.length || atMost(point.earned, kept[i + 1].earned)))
  if (measured[measured.length - 1].block >= now.block) measured.pop()
  measured.push(now)
  const history: FeeHistory = { mintedAt: { block: mint.block, timestamp: mint.t }, earned, collected: settled, points: measured, events, through: Math.min(ledger.block, state.block) }
  return { phase: 'verified', state, history }
}
