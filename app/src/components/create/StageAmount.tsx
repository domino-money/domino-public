import { useState } from 'react'
import { CREATE } from '../../lib/create/copy'
import type { JourneyState, PayWith, TickRange } from '../../lib/create/journey'
import { poolOnOtherChain, type OtherChains } from '../../lib/create/otherChains'
import type { PayFacts } from '../../lib/create/poolPrices'
import { slippageValue, slippageWarns, slippageWritten } from '../../lib/create/slippage'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import type { ReadSource } from '../../lib/read/types'
import type { TokenCandidate } from '../../lib/read/screens/tokens'
import { recovering } from '../../lib/staleRelease'
import { deferred } from '../Deferred'
import { PairedAmounts } from './PairedAmounts'
import { RangeStep } from './RangeStep'
import { SlippageSlider } from './SlippageSlider'
import type { PairBalancesState } from './usePairBalances'

// Changed on purpose 2026-10-02 (Domino V2 integration, spec F7 §3): in a build with V2 (never production or
// development, where the define is the literal false and this folds to nothing), the amounts below carry the inline
// "Bring {token} from {network}" offer (src/v2in/funds), opened lazily. Its mount replaces the amounts expression with
// a ternary whose alternate is that expression exactly, so a build without V2 emits the same bytes as before.
// Changed on purpose 2026-10-03 (the integration review, #15): V1's amounts are mounted by this step itself in both
// branches, and the chunk is only the offer under them, drawn as soon as it is in (components/Deferred.tsx, as
// components/positions/OwnedPositions.tsx opens the lists' chunks: nothing while it loads, nothing should it fail), so
// the inputs never remount and the caret is never lost when the chunk lands.
// Changed on purpose 2026-10-06 (the owner: AI/PONS short and nothing offered): the chunk also offers paying with one other
// token where Domino's service says it may (`pay`, lib/create/poolPrices.ts PayFacts; `onPayWith`, lib/create/journey.ts
// PayWith). Once chosen, V1's amounts, still mounted by this step, draw that token's one panel in place of the pair's
// (PairedAmounts.tsx), so it never depends on the chunk (the review of 2026-10-06).
type FundsOfferProps = {
  state: JourneyState
  balances: PairBalancesState
  onBudget: (text: string) => void
  onDeposit: (candidate: TokenCandidate, text: string) => void
  onArrived?: () => void
  onPayWith?: (payWith: PayWith | null) => void
  pay?: PayFacts | null
}
const FundsOffer = __DOMINO_V2__ ? deferred<FundsOfferProps>(recovering(() => import('../../v2in/funds/FundsAmounts'), () => ({ default: NoOffer }))) : null
if (__DOMINO_V2__ && FundsOffer) FundsOffer.preload()
function NoOffer() {
  return null
}

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
  others = null,
}: {
  source: ReadSource | null
  state: JourneyState
  onRange: (range: TickRange) => void
  onPool: (option: PoolOption) => void
  /** The other networks New position offers (2026-10-05): another network's pool has its price read again there. */
  others?: OtherChains | null
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
  const reread = others && poolOnOtherChain(pool) ? (signal: AbortSignal) => others.reread(pool, signal) : null
  return <RangeStep source={source} state={state} pool={pool} token={token.key} onRange={onRange} onPool={onPool} reread={reread} />
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
 * already set above 2% (create/slippage.ts), so its warning is in view.
 */
export function StageAmount({
  state,
  balances,
  onBudget,
  onDeposit,
  onSlippage,
  onFundsArrived,
  onPayWith,
  pay,
}: {
  state: JourneyState
  balances: PairBalancesState
  onBudget: (text: string) => void
  /** The other token's row: switch the independent token and set its amount in one change. */
  onDeposit: (candidate: TokenCandidate, text: string) => void
  onSlippage: (text: string) => void
  /** Added 2026-10-05: funds brought from another network arrived; the balances are read again. */
  onFundsArrived?: () => void
  /** Added 2026-10-06: pay with one other token, or with the pool's own again (null). */
  onPayWith?: (payWith: PayWith | null) => void
  /** Added 2026-10-06: what paying with one other token would be (./usePricedPool.ts usePayFacts). */
  pay?: PayFacts | null
}) {
  const value = slippageValue(state.slippageBps)
  // Read once: a disclosure whose open state followed the value would shut under the slider being dragged.
  const [opened] = useState(() => slippageWarns(value))
  const token = state.token
  if (!token || !state.pool) return null
  return (
    <div className="dm-flow-stack" data-stage="amount">
      {__DOMINO_V2__ && FundsOffer ? (
        <>
          <PairedAmounts state={state} balances={balances} onBudget={onBudget} onDeposit={onDeposit} pay={pay} onPayWith={onPayWith} />
          <FundsOffer state={state} balances={balances} onBudget={onBudget} onDeposit={onDeposit} onArrived={onFundsArrived} onPayWith={onPayWith} pay={pay} />
        </>
      ) : (
        <PairedAmounts state={state} balances={balances} onBudget={onBudget} onDeposit={onDeposit} />
      )}
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
