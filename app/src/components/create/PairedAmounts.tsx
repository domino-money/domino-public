import { CREATE } from '../../lib/create/copy'
import { candidatesFromPool, candidateDecimals, validateBudget, type JourneyState } from '../../lib/create/journey'
import { pairedAmount } from '../../lib/create/pairAmount'
import { formatUnits } from '../../lib/read/decimal'
import type { TokenCandidate } from '../../lib/read/screens/tokens'
import { SymbolText } from '../read/screens/SymbolText'
import { TokenMark } from '../TokenIcon'
import { Button } from '../ui'
import { AmountField } from './fields'
import type { PairBalancesState } from './usePairBalances'

/**
 * The deposit as both of the pool's tokens: one row each, the amount typed in
 * either, and the other following from the range and the pool's price.
 *
 * A concentrated position holds both currencies in a ratio the range and the
 * price fix, so there is no "deposit with" choice to make: the token you type
 * an amount in is the independent one, exactly what `independentToken` means
 * in the position preview, and the other amount is arithmetic, not a decision.
 *
 * The second figure is computed from the pool's own `sqrtPriceX96` as read and
 * the chosen ticks, in exact integers (create/pairAmount.ts). It is the amount
 * at that price: the authority stays the service's preview in Review, which
 * reports the maximum with slippage and whether the wallet covers both sides.
 * Nothing here signs, approves or deposits.
 */
export function PairedAmounts({
  state,
  balances,
  onBudget,
  onDeposit,
}: {
  state: JourneyState
  balances: PairBalancesState
  onBudget: (text: string) => void
  onDeposit: (candidate: TokenCandidate, text: string) => void
}) {
  const pool = state.pool
  if (!pool) return null
  const choices = candidatesFromPool(pool)
  const independent = pool.currencies.findIndex((currency) => currency.address === state.token?.key)
  const decimals = state.token ? candidateDecimals(state.token) : null
  const budget = validateBudget(state.budget, decimals)

  // The other side, only once this one is a real amount: a half-typed figure claims nothing.
  const other =
    independent === 0 || independent === 1
      ? budget.ok && state.range
        ? pairedAmount({
            sqrtPriceX96: pool.sqrtPriceX96,
            tickLower: state.range.lower,
            tickUpper: state.range.upper,
            independent: independent as 0 | 1,
            amountRaw: budget.raw,
          })
        : null
      : null

  const otherText = (index: 0 | 1): { value: string; note: string | null } => {
    const currency = pool.currencies[index]
    if (!other) return { value: '', note: null }
    if (other.kind === 'unknown') return { value: '', note: CREATE.amount.pairUnknown }
    if (other.kind === 'unused') {
      const kept = pool.currencies[other.only]
      return { value: '', note: CREATE.amount.pairUnused(kept.symbol ?? '') }
    }
    // Plain decimal, not the grouped display text: this sits in a field the
    // person may type over, and a thousands separator would not be an amount.
    const units = formatUnits(other.raw, currency.decimals)
    const value = units && units.kind === 'units' ? units.text.replace(/,/g, '') : other.raw
    return { value, note: other.only === null ? null : CREATE.amount.pairOneSided(pool.currencies[other.only].symbol ?? '') }
  }

  return (
    <div className="dm-flow-pair" data-paired-amounts={independent === -1 ? 'none' : String(independent)}>
      {pool.currencies.map((currency, index) => {
        const side = index as 0 | 1
        const mine = side === independent
        const choice = choices[side]
        const unreadable = choice.why !== null || choice.token.decimals === null
        const shown = mine ? { value: state.budget, note: null } : otherText(side)
        const balance = balances.balances?.[side] ?? null
        const fill = balance?.fact && balance.fact.state === 'value' ? balance.fact.text.replace(/,/g, '') : null
        return (
          <div key={currency.address} className="dm-flow-pair-row" data-pair-side={side} data-pair-role={mine ? 'typed' : 'derived'}>
            <AmountField
              id={`create-amount-${side}`}
              label={
                <>
                  <TokenMark token={currency} size={18} /> <SymbolText token={currency} />
                </>
              }
              unit={<SymbolText token={currency} />}
              inputMode="decimal"
              placeholder="0.0"
              value={shown.value}
              disabled={unreadable}
              onChange={(event) => (mine ? onBudget(event.target.value) : onDeposit(choice, event.target.value))}
              error={mine && state.budget !== '' && !budget.ok ? budget.reason : unreadable ? CREATE.amount.pairUnreadable : null}
              below={shown.note ? <p className="dm-hint">{shown.note}</p> : null}
              footer={
                <div className="dm-flow-balance" data-pair-balance={balances.status}>
                  <p className="dm-flow-balance-line" title={CREATE.amount.balanceNote}>
                    <span className="text-fg-subtle">
                      {balances.status === 'disconnected'
                        ? CREATE.amount.connectForBalance
                        : balances.status !== 'ready'
                          ? CREATE.amount.pairReading
                          : balance?.fact
                            ? CREATE.amount.balanceAt(null)
                            : CREATE.amount.pairNone}
                    </span>{' '}
                    {balances.status === 'ready' && balance?.fact && <bdi className="tnum text-fg">{balance.fact.text}</bdi>}
                  </p>
                  {fill !== null && !unreadable && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-pair-max={side}
                      onClick={() => (mine ? onBudget(fill) : onDeposit(choice, fill))}
                    >
                      {CREATE.amount.maxLabel}
                    </Button>
                  )}
                </div>
              }
            />
          </div>
        )
      })}
      <p className="dm-hint" data-pair-note="">
        {CREATE.amount.pairNote(pool.block)}
      </p>
    </div>
  )
}
