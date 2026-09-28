import { useState } from 'react'
import { CREATE } from '../../lib/create/copy'
import type { JourneyState, TickRange } from '../../lib/create/journey'
import { slippageValue, slippageWarns, slippageWritten } from '../../lib/create/slippage'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import type { ReadSource } from '../../lib/read/types'
import type { TokenCandidate } from '../../lib/read/screens/tokens'
import { PairedAmounts } from './PairedAmounts'
import { RangeStep } from './RangeStep'
import { SlippageSlider } from './SlippageSlider'
import type { PairBalancesState } from './usePairBalances'

/**
 * Step 2, Range: the price band, in plain words (RangeStep.tsx). Its only read
 * is the price again: once it is more than 5 minutes old, the next change to
 * the range reads it, one pools read of this pool at a time. There is no
 * control to press for it.
 */
export function StageRange({
  source,
  state,
  onRange,
  onPool,
}: {
  source: ReadSource | null
  state: JourneyState
  onRange: (range: TickRange) => void
  onPool: (option: PoolOption) => void
}) {
  const token = state.token
  const pool = state.pool
  if (!token || !pool) return null
  if (!source) {
    return (
      <div className="dm-flow-stack" data-stage="range">
        <p role="status" className="text-body text-fg-muted">
          {CREATE.page.sourceLoading}
        </p>
      </div>
    )
  }
  return <RangeStep source={source} state={state} pool={pool} token={token.key} onRange={onRange} onPool={onPool} />
}

/**
 * Step 3, Amount: one row per pool token, the amount typed in either, the
 * other following from the range and the pool's price, each row carrying the
 * connected wallet's balance of its token.
 *
 * A position holds both currencies, so there is no "deposit with" choice: the
 * token an amount is typed in is the independent one (PairedAmounts.tsx).
 *
 * Changed on purpose (round 6, 2026-09-27, the owner: the technical parts go in
 * a collapsed Advanced): the slippage tolerance is under Advanced, closed, with
 * the tolerance in its summary. It opens by itself only when the tolerance was
 * already set above the usual 1%, so what it allows is in view.
 */
export function StageAmount({
  state,
  balances,
  onBudget,
  onDeposit,
  onSlippage,
}: {
  state: JourneyState
  balances: PairBalancesState
  onBudget: (text: string) => void
  /** The other token's row: switch the independent token and set its amount in one change. */
  onDeposit: (candidate: TokenCandidate, text: string) => void
  onSlippage: (text: string) => void
}) {
  const value = slippageValue(state.slippageBps)
  // Read once: a disclosure whose open state followed the value would shut under the slider being dragged.
  const [opened] = useState(() => slippageWarns(value))
  const token = state.token
  if (!token || !state.pool) return null
  return (
    <div className="dm-flow-stack" data-stage="amount">
      <PairedAmounts state={state} balances={balances} onBudget={onBudget} onDeposit={onDeposit} />
      <details className="dm-details dm-flow-advanced" data-flow-advanced="" open={opened || undefined}>
        <summary>
          <span>{CREATE.amount.advanced}</span>
          <span className="dm-flow-advanced-value">
            {CREATE.amount.slippageLabel} {slippageWritten(value)}
          </span>
        </summary>
        <div className="dm-flow-advanced-body">
          <SlippageSlider bps={state.slippageBps} onSlippage={onSlippage} />
        </div>
      </details>
    </div>
  )
}
