import { Fragment, useState } from 'react'
import { AmountField } from '../../components/create/fields'
import { IconPlus } from '../../components/icons'
import { Segmented } from '../../components/ui'
import { CREATE } from '../../lib/create/copy'
import { slippageBpsFrom, slippageValue, slippageWritten } from '../../lib/create/slippage'
import { groupedAmount } from '../../lib/create/amountText'
import { inChainCurrency, v2Chain } from '../../v2/chains'
import { ZERO_ADDRESS, type Address } from '../../v2/types'
import { JOURNEY_SLIPPAGE_WARNING_ABOVE_BPS } from './constants'
import { JOURNEY } from './copy'
import { amountProblem, otherTokens, type Amounts, type JourneyState } from './model/state'
import { TokenDisc, TokenName } from './parts'
import { SlippageControl } from './SlippageControl'
import { decimalsOf, labelOf, tokenBook } from './tokens'
import { ZapFunds } from '../funds/ZapFunds'
import type { FundingContinuation } from '../funds/BringFunds'

/**
 * Step 3, Amount, on Domino's new contracts (spec F7 rev2 §2.6.1 "o que depositar": one or both of the pool's tokens, or
 * another token), in today's look (components/create/PairedAmounts.tsx's panels, the token pill beside each figure):
 *   - "This pool's tokens": one panel per token, an amount in either or both; an empty panel is none of it. Domino's
 *     swap balances what goes in (the plan says how much it swaps, and its fee, on the review);
 *   - "Another token": one panel, exactly one token outside the pool (the chain's stable, WETH or ETH), swapped in.
 * The slippage under Advanced, closed unless it is already above 2% (decision #2). A token whose decimals were never read
 * takes raw units only (never guessed). Paying with ETH says it needs a direct transaction (§2.7).
 */
export function AmountStage({ state, onAmounts, onSlippage, flowKey, onContinuationChange }: {
  state: JourneyState
  onAmounts: (amounts: Amounts) => void
  onSlippage: (text: string) => void
  flowKey?: string
  onContinuationChange?: (key: string, continuation: FundingContinuation) => void
}) {
  const value = slippageValue(state.slippage)
  const kept = slippageBpsFrom(state.slippage)
  const [opened] = useState(() => value > JOURNEY_SLIPPAGE_WARNING_ABOVE_BPS)
  // QA round 2, N75 (2026-10-30): a field nobody is typing in draws its amount with thousands separators, never the one
  // being typed in, so the caret never jumps ("5000000.5" shows "5,000,000.5"). Changed on purpose 2026-11-02 (review of
  // the money PRs, M4): drawn only, as New position's own fields do (components/create/PairedAmounts.tsx). The separators
  // were written into the amount once its field was left, so "1250" was read back as "1,250", which is refused now as
  // ambiguous (1.25 for someone who writes a decimal comma; lib/create/typedFigure.ts).
  const [editing, setEditing] = useState<Address | null>(null)
  const pool = state.pool
  if (!pool) return null
  const others = otherTokens(state.chainId, pool.pool)
  const book = tokenBook(state.chainId, [...pool.tokens])
  const amounts = state.amounts
  const tokens: Address[] = amounts.mode === 'other' ? (amounts.other ? [amounts.other] : []) : [pool.pool.currency0, pool.pool.currency1]
  const set = (token: Address, text: string) => onAmounts({ ...amounts, text: { ...amounts.text, [token]: text } })
  const paysEth = tokens.some((token) => token === ZERO_ADDRESS && (amounts.text[token] ?? '').trim() !== '')
  return (
    <div className="dm-flow-stack" data-stage="amount" data-zap-amounts={amounts.mode}>
      {others.length > 0 && (
        <Segmented
          label={JOURNEY.amount.payWith}
          items={[{ key: 'pool', label: JOURNEY.amount.poolTokens }, { key: 'other', label: JOURNEY.amount.otherToken }]}
          value={amounts.mode}
          onChange={(mode) => onAmounts({ mode, other: mode === 'other' ? (amounts.other ?? others[0]) : amounts.other, text: amounts.text })}
        />
      )}
      {amounts.mode === 'other' && others.length > 1 && (
        <Segmented
          label={JOURNEY.amount.otherChoice}
          items={others.map((token) => ({ key: token as string, label: labelOf(book, token) }))}
          value={(amounts.other ?? others[0]) as string}
          onChange={(token) => onAmounts({ ...amounts, other: token as Address })}
        />
      )}
      <div className="dm-flow-pair" data-paired-amounts={amounts.mode}>
        {tokens.map((token, index) => {
          const decimals = decimalsOf(book, token)
          const text = amounts.text[token] ?? ''
          const problem = amountProblem(state, token, text)
          const meta = { address: token, symbol: labelOf(book, token) }
          return (
            <Fragment key={token}>
              {index === 1 && (
                <span aria-hidden="true" className="dm-flow-link">
                  <IconPlus size={16} />
                </span>
              )}
              <div className="dm-flow-pair-row" data-zap-amount={token}>
                <AmountField
                  id={`zap-amount-${token}`}
                  label={<TokenName token={meta} chainId={state.chainId} />}
                  labelHidden
                  unit={
                    <>
                      <TokenDisc chainId={state.chainId} token={meta} size={20} />
                      <TokenName token={meta} chainId={state.chainId} />
                    </>
                  }
                  inputMode="decimal"
                  placeholder="0"
                  // N75: raw units (a token whose decimals were never read) stay as typed.
                  value={editing === token || decimals === null ? text : groupedAmount(text)}
                  onChange={(event) => set(token, event.target.value)}
                  onFocus={() => setEditing(token)}
                  onBlur={() => setEditing((was) => (was === token ? null : was))}
                  error={problem}
                  below={decimals === null ? <p className="dm-hint">{`${JOURNEY.amount.rawUnits} of ${labelOf(book, token)}`}</p> : null}
                />
              </div>
            </Fragment>
          )
        })}
      </div>
      {paysEth && (
        <p className="dm-flow-position" data-tone="neutral" data-zap-eth-direct="">
          <span>{inChainCurrency(JOURNEY.amount.ethDirect, v2Chain(state.chainId))}</span>
        </p>
      )}
      <ZapFunds state={state} onAmounts={onAmounts} flowKey={flowKey} onContinuationChange={onContinuationChange} />
      <details className="dm-details dm-flow-advanced" data-flow-advanced="" open={opened || undefined}>
        <summary>
          <span>{CREATE.amount.advanced}</span>
          <span className="dm-flow-advanced-value">
            {/* N28 (2026-10-30): no figure while the box holds no usable tolerance, as the owner's steps write it. */}
            {CREATE.amount.slippageLabel} {kept === null ? CREATE.page.notChosen : slippageWritten(kept)}
          </span>
        </summary>
        <div>
          <SlippageControl bps={state.slippage} onSlippage={onSlippage} />
        </div>
      </details>
    </div>
  )
}
