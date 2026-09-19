import { CREATE } from '../../lib/create/copy'
import { candidateDecimals, validateBudget, validateSlippage, type JourneyState, type TickRange } from '../../lib/create/journey'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import type { ReadSource } from '../../lib/read/types'
import { PoolRangeControls } from '../read/screens/PoolRangeControls'
import type { TokenCandidate } from '../../lib/read/screens/tokens'
import { TextField } from './fields'
import { PairedAmounts } from './PairedAmounts'
import type { PairBalancesState } from './usePairBalances'

/**
 * Step 2, Range: the price band, drawn on the pool's price as read, through
 * the shared range controls. Their only read is the price again: once it is
 * more than 5 minutes old, the next change to the range reads it, one pools
 * read of this pool at a time. There is no control to press for it.
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
  return (
    <div className="dm-flow-stack" data-stage="range">
      {source ? (
        <PoolRangeControls source={source} token={token.key} paired={state.paired?.key ?? null} option={pool} onOption={onPool} range={state.range} onRange={onRange} />
      ) : (
        <p role="status" className="text-body text-fg-muted">
          {CREATE.page.sourceLoading}
        </p>
      )}
    </div>
  )
}

/**
 * Step 3, Amount: one row per pool token, the amount typed in either, the
 * other following from the range and the pool's price, each row carrying the
 * connected wallet's balance of its token, and the slippage tolerance one
 * disclosure away.
 *
 * A position holds both currencies, so there is no "deposit with" choice: the
 * token an amount is typed in is the independent one (PairedAmounts.tsx).
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
  const token = state.token
  if (!token || !state.pool) return null
  const decimals = candidateDecimals(token)
  const budget = validateBudget(state.budget, decimals)
  const slippage = validateSlippage(state.slippageBps)
  return (
    <div className="dm-flow-stack" data-stage="amount">
      <PairedAmounts state={state} balances={balances} onBudget={onBudget} onDeposit={onDeposit} />
      {budget.ok && decimals !== null && (
        <p className="dm-hint tnum break-all" data-budget-raw={budget.raw} title={CREATE.amount.rawUnitsTitle}>
          {CREATE.amount.rawUnits(budget.raw, decimals)}
        </p>
      )}
      <details className="dm-details dm-flow-disclosure">
        <summary>{CREATE.amount.advanced}</summary>
        <div>
          <TextField
            id="create-slippage"
            label={CREATE.amount.slippageLabel}
            inputMode="numeric"
            value={state.slippageBps}
            onChange={(event) => onSlippage(event.target.value)}
            hint={CREATE.amount.slippageHint}
            error={slippage.ok ? null : slippage.reason}
            trailing="bps"
          />
        </div>
      </details>
    </div>
  )
}
