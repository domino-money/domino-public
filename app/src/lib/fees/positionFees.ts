/**
 * A position's stored fee history on a chain with no ledger route of the site's own (read-v6 1.2.0-rc.1 `position-fees`,
 * docs/v2/V2_FEES.md: Base and Arbitrum One since launch round P3) as the view Robinhood Chain's screens draw
 * (./types.ts FeeHistoryView, the owner, 2026-11-04: "tudo tem que ser idêntico. A única coisa que muda é a rede"), so
 * one card, one chart and one Your APR serve every chain.
 *
 *   Fees earned  = the answer's `now.earned`: every settlement's fees plus what accrued since the last one, as Uniswap
 *                  computes them, never from token transfers
 *   its points   = measured ones only: opened (nothing), right after each settlement, the follower's stored points, and now
 *
 * A history that is not exact (`same_block`, `liquidity`) is Fees ready to collect only, as ./ledger.ts foldLedger says
 * it. A position still being read back is `loading`. One nobody follows, or a burned NFT, is `unavailable`: the caller
 * keeps what it showed without this read. Nothing here invents a number. Pure and Node-safe.
 */
import type { FeeNow, FeeSettlement, PositionFees } from 'api-contracts/read-v6/types'
import type { FeeEvent, FeeHistory, FeeHistoryView, FeePoint, LedgerWhy, PositionState, StateCurrency } from './types'

/** A token's label and decimals by address, as the caller's page read them (decimals null when unread, never guessed). */
export type FeeTokenOf = (address: string) => Pick<StateCurrency, 'symbol' | 'decimals'>

type Pair = readonly [bigint, bigint]

const ZERO: Pair = [0n, 0n]
const amounts = (raw: readonly string[]): Pair => [BigInt(raw[0]), BigInt(raw[1])]
const atMost = (a: Pair, b: Pair) => a[0] <= b[0] && a[1] <= b[1]
const atLeastZero = (a: Pair, b: Pair): Pair => [a[0] > b[0] ? a[0] - b[0] : 0n, a[1] > b[1] ? a[1] - b[1] : 0n]

/** The position at `now`. `unclaimed` is what a collect pays now: the page's Fees ready to collect, on v3 with its `tokensOwed`. */
export function stateOfNow(now: FeeNow, tokenOf: FeeTokenOf): PositionState {
  const currency = (address: string): StateCurrency => ({ address, ...tokenOf(address) })
  return {
    block: now.snapshot.number,
    timestamp: now.snapshot.timestamp,
    unclaimed: amounts(now.collectable),
    sqrtPriceX96: BigInt(now.sqrtPriceX96),
    tick: now.tick,
    tickLower: now.tickLower,
    tickUpper: now.tickUpper,
    liquidity: BigInt(now.liquidity),
    protocolFee: now.protocolFee,
    poolId: now.poolId ?? now.poolAddress ?? '',
    owner: now.owner,
    currencies: [currency(now.pool.currency0), currency(now.pool.currency1)],
  }
}

function kindOf(event: FeeSettlement, since: PositionFees['since']): FeeEvent['kind'] {
  const after = BigInt(event.liquidity)
  if (event.kind === 'decrease') return after === 0n ? 'close' : 'decrease'
  // The mint's own increase: in the block the NFT was minted, from no liquidity at all.
  if (event.kind === 'increase' && since?.kind === 'mint' && event.block.number === since.block.number && after === BigInt(event.liquidityDelta)) return 'mint'
  return event.kind
}

/**
 * The settlements as the screens' events, oldest first. Your APR walks the liquidity from the first one
 * (lib/positionApr.ts), so what the position already held where its history starts (minted before `floor`, or older events
 * left out of a `truncated` answer) comes first as a collect of nothing: it counts for the liquidity, and no screen lists it
 * (visual/model.ts feesEvents).
 */
function eventsOf(position: PositionFees, liquidityNow: bigint): FeeEvent[] {
  const events = position.events.map<FeeEvent>((event) => ({
    kind: kindOf(event, position.since),
    block: event.block.number,
    timestamp: event.block.timestamp,
    tx: event.tx,
    fees: event.fees ? amounts(event.fees) : null,
    liquidityDelta: BigInt(event.liquidityDelta),
    ...(event.auto ? { auto: true as const } : {}),
    ...(event.serviceFee ? { service: amounts(event.serviceFee) } : {}),
  }))
  const first = position.events[0]
  const held = first ? BigInt(first.liquidity) - BigInt(first.liquidityDelta) : liquidityNow
  // No transaction of its own (changed on purpose 2026-11-06): never matched to an automatic compound's
  // (lib/automationImpact.ts reads the events by transaction) nor to a receipt in Activity.
  if (position.since && held !== 0n) {
    events.unshift({ kind: 'collect', block: position.since.block.number, timestamp: position.since.block.timestamp, tx: '', fees: ZERO, liquidityDelta: held })
  }
  return events
}

/** Measured points only, oldest first: earned only grows, and one chain second holds one point (Arbitrum's blocks share seconds). */
function pointsOf(position: PositionFees, opened: FeePoint, now: FeePoint): FeePoint[] {
  const found: FeePoint[] = []
  for (const event of position.events) {
    if (event.settled === null) continue
    const settled = amounts(event.settled)
    found.push({ block: event.block.number, t: event.block.timestamp, earned: settled, collected: settled, kind: 'settlement' })
  }
  for (const point of position.points) {
    if (point.earned === null || point.settled === null) continue
    found.push({ block: point.block, t: point.timestamp, earned: amounts(point.earned), collected: amounts(point.settled), kind: 'reading' })
  }
  found.sort((a, b) => a.block - b.block)
  const kept: FeePoint[] = [opened]
  for (const point of found) {
    const last = kept[kept.length - 1]
    if (point.block <= opened.block || point.block >= now.block || !atMost(last.earned, point.earned) || !atMost(point.earned, now.earned)) continue
    if (point.t > last.t) kept.push(point)
    // Two settlements of one block keep the one after both; a stored point of a settlement's block adds nothing.
    else if (last.kind !== 'opened' && point.kind === 'settlement') kept[kept.length - 1] = point
  }
  if (kept[kept.length - 1].block >= now.block) kept.pop()
  kept.push(now)
  return kept
}

/** One position of a `position-fees` answer as the view the screens draw. */
export function positionFeesView(position: PositionFees, tokenOf: FeeTokenOf): FeeHistoryView {
  if (position.status === 'not_followed' || position.status === 'burned') return { phase: 'unavailable', reason: 'not_found' }
  const now = position.now
  if (position.status === 'reading' || !now) return { phase: 'loading', state: null }
  const state = stateOfNow(now, tokenOf)
  const events = eventsOf(position, state.liquidity)
  const since = position.since
  const mintedAt = since ? { block: since.block.number, timestamp: since.block.timestamp } : null
  if (!position.exact || !since || !mintedAt || !now.earned || !now.settled) {
    return {
      phase: 'unclaimed-only',
      state,
      reason: 'not_exact',
      ...(position.why ? { why: position.why as LedgerWhy } : {}),
      events,
      ...(mintedAt && since?.kind === 'mint' ? { mintedAt } : {}),
    }
  }
  const earned = amounts(now.earned)
  const settled = amounts(now.settled)
  const opened: FeePoint = { block: mintedAt.block, t: mintedAt.timestamp, earned: ZERO, collected: ZERO, kind: 'opened' }
  const end: FeePoint = { block: state.block, t: state.timestamp, earned, collected: settled, kind: 'now' }
  const history: FeeHistory = {
    mintedAt,
    earned,
    // v3's `settled` is what each settlement credited to the manager's `tokensOwed`, so the part still owed is not collected yet.
    collected: position.dex === 3 ? atLeastZero(earned, state.unclaimed) : settled,
    points: pointsOf(position, opened, end),
    events,
    through: state.block,
    ...(since.kind === 'floor' ? { fromFloor: true as const } : {}),
  }
  return { phase: 'verified', state, history }
}
