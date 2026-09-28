import { Fragment } from 'react'
import { CREATE } from '../../lib/create/copy'
import { candidatesFromPool, candidateDecimals, validateBudget, type JourneyState } from '../../lib/create/journey'
import { pairedAmount } from '../../lib/create/pairAmount'
import { maxSpend, reviewPlan } from '../../lib/create/reviewPlan'
import { shortAmount } from '../../lib/format/amount'
import { formatUnits } from '../../lib/read/decimal'
import { NATIVE_CURRENCY } from '../../lib/read/screens/identity'
import type { TokenCandidate } from '../../lib/read/screens/tokens'
import { SymbolText } from '../read/screens/SymbolText'
import { AmountText, UsdText } from '../figures'
import { IconPlus } from '../icons'
import { TokenMark } from '../TokenIcon'
import { Button } from '../ui'
import { AmountField } from './fields'
import type { PairBalancesState } from './usePairBalances'
import { rawBalances, usdOfSide } from './valuation'

/** A raw amount in whole tokens, grouped as the read writes it; the raw digits when the decimals are unknown. */
const unitsOf = (raw: bigint | string, decimals: number | null) => {
  const units = formatUnits(String(raw), decimals)
  return units && units.kind === 'units' ? units.text : String(raw)
}

/**
 * A figure the page works out, as it sits in a field the person may type over: six significant digits at most
 * (lib/format/amount.ts) and no thousands separator, which would not be an amount. The exact figure is Review's.
 */
const fieldText = (text: string) => shortAmount(text).short.replace(/,/g, '')

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
 * the chosen ticks, in exact integers (create/pairAmount.ts), and shown short:
 * Review and Create position work from the exact amounts, never from this text.
 *
 * Changed on purpose (round 6, 2026-09-27, the owner: plain words, fewer
 * numbers): each panel is named by its token pill alone (its label is for
 * assistive technology); when the wallet cannot pay the other token, one line
 * under the panels says how much of the typed one is swapped for it; when the
 * wallet cannot fund the amounts either way, one line says that. Nothing here
 * signs, approves or deposits.
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

  // How the wallet funds it, from the balances the read service reported (Review's own reading, lib/create/reviewPlan.ts).
  const plan = reviewPlan(state, rawBalances(balances))?.plan ?? null
  const swap = plan && plan.kind === 'swap' && plan.swap > 0n ? plan : null
  // Funded from one token, the other panel keeps what the range pairs with the typed amount, quieter and with no USD of
  // its own: beside its balance it shows why the swap is needed. Fixed 2026-09-28 (round 6 review): it showed what the swap
  // would bring instead, so a wallet holding 2,500 USDG read "1,550.92 USDG" over "You don't have enough USDG".
  const swapped = swap ? (swap.from === 0 ? 1 : 0) : null
  // The panel the amount was typed in is never quieted: when the swap buys the typed token, the wallet's token pays for
  // the whole position, and the line under the panels says so from the wallet's side. Fixed 2026-09-28 (round 6 review):
  // 1000 MARLIN typed with no MARLIN in the wallet greyed the typed panel and named a USDG deposit shown nowhere.
  const quiet = swapped !== null && swapped !== independent ? swapped : null

  const otherText = (index: 0 | 1): { value: string; note: string | null } => {
    const currency = pool.currencies[index]
    if (!other) return { value: '', note: null }
    if (other.kind === 'unknown') return { value: '', note: CREATE.amount.pairUnknown }
    if (other.kind === 'unused') {
      const kept = pool.currencies[other.only]
      return { value: '', note: CREATE.amount.pairUnused(kept.symbol ?? '') }
    }
    return { value: fieldText(unitsOf(other.raw, currency.decimals)), note: other.only === null ? null : CREATE.amount.pairOneSided(pool.currencies[other.only].symbol ?? '') }
  }

  // No wallet: one line under both panels asks for one, instead of the same line in each (round 6, 2026-09-28: less on screen).
  const disconnected = balances.status === 'disconnected'

  // Each amount's raw units, for its USD line: the typed one once it is a real amount, the other once the range pairs one with it.
  const rawOf = (side: 0 | 1): string | null => (side === independent ? (budget.ok ? budget.raw : null) : other && other.kind === 'amount' ? other.raw : null)

  return (
    <div className="dm-flow-stack">
      <div className="dm-flow-pair" data-paired-amounts={independent === -1 ? 'none' : String(independent)}>
        {pool.currencies.map((currency, index) => {
          const side = index as 0 | 1
          const mine = side === independent
          const choice = choices[side]
          const unreadable = choice.why !== null || choice.token.decimals === null
          const shown = mine ? { value: state.budget, note: null } : otherText(side)
          const balance = balances.balances?.[side] ?? null
          // Max leaves native ETH's gas allowance in the wallet (maxSpend), so Review never finds it short of what Max typed.
          const spend = balance?.raw && /^\d+$/.test(balance.raw) ? maxSpend(BigInt(balance.raw), currency.address === NATIVE_CURRENCY) : 0n
          const fill = spend > 0n ? unitsOf(spend, currency.decimals).replace(/,/g, '') : null
          // The swapped side has no USD of its own: the preview's deposit stays the one statement of value.
          const usd = side === quiet ? null : usdOfSide(pool, side, rawOf(side))
          return (
            <Fragment key={currency.address}>
              {/* Between the two panels, as the swap form joins its two: decoration only. */}
              {index === 1 && (
                <span aria-hidden="true" className="dm-flow-link">
                  <IconPlus size={16} />
                </span>
              )}
              <div className="dm-flow-pair-row" data-pair-side={side} data-pair-role={mine ? 'typed' : 'derived'} data-plan-side={side === quiet ? 'swapped' : undefined}>
                <AmountField
                  id={`create-amount-${side}`}
                  label={<SymbolText token={currency} />}
                  labelHidden
                  unit={
                    <>
                      <TokenMark token={currency} size={20} />
                      <SymbolText token={currency} />
                    </>
                  }
                  inputMode="decimal"
                  placeholder="0"
                  value={shown.value}
                  disabled={unreadable}
                  onChange={(event) => (mine ? onBudget(event.target.value) : onDeposit(choice, event.target.value))}
                  error={mine && state.budget !== '' && !budget.ok ? budget.reason : unreadable ? CREATE.amount.pairUnreadable : null}
                  usd={usd !== null ? <UsdText value={usd} /> : undefined}
                  below={shown.note ? <p className="dm-hint">{shown.note}</p> : null}
                  footer={
                    disconnected ? null : (
                      <div className="dm-flow-balance" data-pair-balance={balances.status}>
                        <p className="dm-flow-balance-line" title={CREATE.amount.balanceNote}>
                          <span className="text-fg-subtle">
                            {balances.status !== 'ready'
                              ? CREATE.amount.pairReading
                              : balance?.fact
                                ? CREATE.amount.balanceAt(null)
                                : CREATE.amount.pairNone}
                          </span>{' '}
                          {balances.status === 'ready' && balance?.fact && <bdi className="tnum text-fg">{balance.fact.text}</bdi>}
                        </p>
                        {fill !== null && !unreadable && (
                          <Button type="button" variant="secondary" size="sm" data-pair-max={side} onClick={() => (mine ? onBudget(fill) : onDeposit(choice, fill))}>
                            {CREATE.amount.maxLabel}
                          </Button>
                        )}
                      </div>
                    )
                  }
                />
              </div>
            </Fragment>
          )
        })}
      </div>
      {disconnected && (
        <p className="dm-hint" data-pair-balance="disconnected">
          {CREATE.amount.connectForBalance}
        </p>
      )}
      {/* One line under the panels, only when the wallet changes the plan: part of one token swapped, or not enough. */}
      {swap && swapped !== null && (
        <p className="dm-flow-position" data-tone="neutral" data-amount-swap={swap.from} data-amount-swap-typed={swapped === independent ? '' : undefined}>
          {swapped === independent ? (
            // The swap buys the typed token: the wallet's other token pays for all of it, more than its own panel shows.
            <span>
              You don’t have enough <SymbolText token={pool.currencies[swapped]} />, so <AmountText text={unitsOf(swap.deposit, pool.currencies[swap.from].decimals)} />{' '}
              <SymbolText token={pool.currencies[swap.from]} /> will come from your wallet. About <AmountText text={unitsOf(swap.swap, pool.currencies[swap.from].decimals)} />{' '}
              <SymbolText token={pool.currencies[swap.from]} /> of it will be swapped for <SymbolText token={pool.currencies[swapped]} /> when you create the position.
            </span>
          ) : (
            <span>
              You don’t have enough <SymbolText token={pool.currencies[swapped]} />, so about <AmountText text={unitsOf(swap.swap, pool.currencies[swap.from].decimals)} /> of your{' '}
              <AmountText text={unitsOf(swap.deposit, pool.currencies[swap.from].decimals)} /> <SymbolText token={pool.currencies[swap.from]} /> will be swapped for it when you create
              the position.
            </span>
          )}
        </p>
      )}
      {plan && plan.kind === 'short' && (
        <p className="dm-flow-position" data-tone="neutral" data-amount-short={plan.token}>
          {CREATE.amount.short}
        </p>
      )}
    </div>
  )
}
