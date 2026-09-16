import { CREATE } from '../../lib/create/copy'
import { candidateDecimals, validateBudget, validateSlippage, type JourneyState, type TickRange } from '../../lib/create/journey'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import type { ReadSource } from '../../lib/read/types'
import { PoolRangeControls } from '../read/screens/PoolRangeControls'
import { SymbolText } from '../read/screens/SymbolText'
import { AmountField, TextField } from './fields'
import { WalletBalance } from './WalletBalance'

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
 * Step 3, Amount: the budget in the deposit token, converted to raw units
 * with the decimals the read returned, the connected wallet's balance of it
 * under the figure, and the slippage tolerance one disclosure away.
 */
export function StageAmount({
  source,
  state,
  onBudget,
  onSlippage,
}: {
  source: ReadSource | null
  state: JourneyState
  onBudget: (text: string) => void
  onSlippage: (text: string) => void
}) {
  const token = state.token
  if (!token || !state.pool) return null
  const decimals = candidateDecimals(token)
  const budget = validateBudget(state.budget, decimals)
  const slippage = validateSlippage(state.slippageBps)
  const budgetError = decimals === null ? CREATE.amount.decimalsUnknown : state.budget !== '' && !budget.ok ? budget.reason : null
  return (
    <div className="dm-flow-stack" data-stage="amount">
      <AmountField
        id="create-budget"
        label={
          <>
            {CREATE.amount.budgetLabel} (<SymbolText token={token.token} />)
          </>
        }
        unit={<SymbolText token={token.token} />}
        inputMode="decimal"
        placeholder="0.0"
        value={state.budget}
        disabled={decimals === null}
        onChange={(event) => onBudget(event.target.value)}
        footer={<WalletBalance source={source} token={token} onUse={onBudget} />}
        error={budgetError}
        below={
          budget.ok && decimals !== null ? (
            <p className="dm-hint tnum break-all" data-budget-raw={budget.raw} title={CREATE.amount.rawUnitsTitle}>
              {CREATE.amount.rawUnits(budget.raw, decimals)}
            </p>
          ) : null
        }
        hint={`${CREATE.amount.budgetHint(decimals)} ${CREATE.amount.budgetNote}`}
      />
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
