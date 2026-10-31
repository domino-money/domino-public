import { Fragment, useState } from 'react'
import { CREATE } from '../../lib/create/copy'
import { candidatesFromPool, candidateDecimals, takesOnly, validateBudget, type JourneyState, type PayWith } from '../../lib/create/journey'
import { groupedAmount } from '../../lib/create/amountText'
import { pairedAmount } from '../../lib/create/pairAmount'
import type { PayFacts } from '../../lib/create/poolPrices'
import { networkFiguresAt } from '../../lib/create/otherChains'
import { maxSpend, reviewPlan } from '../../lib/create/reviewPlan'
import { shortAmount } from '../../lib/format/amount'
import { formatUsdFloor } from '../../lib/format/usd'
import { formatUnits } from '../../lib/read/decimal'
import { NATIVE_CURRENCY } from '../../lib/read/screens/identity'
import { useMarketOption } from '../../lib/read/screens/knownMarkets'
import type { TokenCandidate } from '../../lib/read/screens/tokens'
import { useNow } from '../../lib/read/useNow'
import { docsHref } from '../explore/routes'
import { SymbolText } from '../read/screens/SymbolText'
import { AmountText, UsdText } from '../figures'
import { IconPlus } from '../icons'
import { Figure } from '../positions/Figure'
import { TokenMark } from '../TokenIcon'
import { Button, FigureDash } from '../ui'
import { AmountField } from './fields'
import type { PairBalancesState } from './usePairBalances'
import { heldAmounts, poolSizeLine, rawBalances, reportedTvl, usdAt, usdOfSide } from './valuation'

/** A raw amount in whole tokens, grouped as the read writes it; the raw digits when the decimals are unknown. */
const unitsOf = (raw: bigint | string, decimals: number | null) => {
  const units = formatUnits(String(raw), decimals)
  return units && units.kind === 'units' ? units.text : String(raw)
}

/**
 * A figure the page works out, as it sits in a field the person may type over: six significant digits at most
 * (lib/format/amount.ts) and no thousands separator, which would not be an amount. The exact figure is Review's.
 * QA round 2, N75: drawn grouped while nobody types in its field (groupedAmount below), as typed once someone does.
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
 *
 * A range wholly above or below today's price takes one of the two tokens
 * alone (2026-09-28, one-sided): only that token's panel is shown, and the
 * amount is typed in it (the journey moves it there, journey.ts withRange).
 * Nothing is swapped when the wallet holds that token; when it holds only the
 * other one, the line under the panel says all of it is swapped.
 */
export function PairedAmounts({
  state,
  balances,
  onBudget,
  onDeposit,
  pay,
  onPayWith,
}: {
  state: JourneyState
  balances: PairBalancesState
  onBudget: (text: string) => void
  onDeposit: (candidate: TokenCandidate, text: string) => void
  /** Added 2026-10-06: what paying with one other token would be (./usePricedPool.ts usePayFacts; undefined while read). */
  pay?: PayFacts | null
  /** Added 2026-10-06: pay with one other token, or with the pool's own again (null). */
  onPayWith?: (payWith: PayWith | null) => void
}) {
  // QA round 2, Q4 (2026-10-30): the panel typed in first, and kept first for this pool, so the panels never swap places
  // under the person when they type in the other one (that makes it the typed one). Set once per pool, as render state.
  const [first, setFirst] = useState<{ pool: string; side: 0 | 1 } | null>(null)
  // The page's clock as the journey reads it (read once): how long another network's TVL may be shown (N51 below).
  const now = useNow(false).wall
  // QA round 2, N75 (2026-10-30): the field being typed in, by its id. Every other field shows its amount with thousands
  // separators ("12,500.5", lib/create/amountText.ts groupedAmount); the one being typed in shows it as typed, so the caret
  // never jumps. Display only: the amount kept, checked and sent is the text as typed. On focus the field takes the text as
  // typed at once, before the browser places the caret or selects the text, so a selection is of that text and the draw
  // that follows changes nothing in it.
  const [editing, setEditing] = useState<string | null>(null)
  const shownAs = (id: string, text: string) => (editing === id ? text : groupedAmount(text))
  const pool = state.pool
  // QA round 2, N8 (pass 3): the pool's TVL as its preview card and Markets show it, for the share sentence below only
  // (display, never an amount); nothing is asked.
  const marketPool = useMarketOption(pool)
  if (!pool) return null
  // No wallet: one line under both panels asks for one, instead of the same line in each (round 6, 2026-09-28: less on screen).
  const disconnected = balances.status === 'disconnected'
  // Added 2026-10-06 (the owner, on production: AI/PONS short on Robinhood Chain and nothing offered): paid with one other
  // token (lib/create/journey.ts PayWith, offered by src/v2in/funds/PayWith.tsx), the step's one panel is that token's,
  // this same panel, with its balance and price as Domino's service read them (`pay`), and a quiet way back to the pool's
  // own tokens. Drawn by the step itself (the review of 2026-10-06), so it never waits on the offer, its network or the
  // wallet staying connected.
  const paid = state.payWith
  if (paid && onPayWith) {
    const { token, text } = paid
    const typed = validateBudget(text, token.decimals)
    const facts = pay?.token.chainId === token.chainId && pay.token.address.toLowerCase() === token.address.toLowerCase() ? pay : null
    // Max leaves native ETH's gas allowance in the wallet, as the pool's panels do.
    const spend = facts?.raw ? maxSpend(facts.raw, token.address === NATIVE_CURRENCY) : 0n
    const usdPaid = typed.ok ? usdAt(typed.raw, token.decimals, facts?.usd ?? null) : null
    return (
      <div className="dm-flow-stack" data-pay-with-amount={token.address}>
        <div className="dm-flow-pair">
          <div className="dm-flow-pair-row" data-pair-role="typed">
            <span className="dm-flow-pair-caption" aria-hidden="true">
              {CREATE.amount.entered}
            </span>
            <AmountField
              id="create-amount-pay"
              label={<SymbolText token={token} />}
              labelHidden
              unit={
                <>
                  <TokenMark token={token} size={20} />
                  <SymbolText token={token} />
                </>
              }
              inputMode="decimal"
              placeholder="0"
              value={text}
              onChange={(event) => onPayWith({ token, text: event.target.value })}
              error={text !== '' && !typed.ok ? typed.reason : null}
              usd={usdPaid !== null ? <UsdText value={usdPaid} floor /> : undefined}
              footer={
                disconnected ? null : (
                  <div className="dm-flow-balance" data-pair-balance={pay === undefined ? 'loading' : 'ready'}>
                    <p className="dm-flow-balance-line">
                      <span className="text-fg-subtle">{pay === undefined ? CREATE.amount.pairReading : CREATE.amount.balanceAt(null)}</span>{' '}
                      {/* A balance that could not be read is the figure dash, never a sentence (QA round 2 sweep). */}
                      {pay !== undefined && <bdi className={facts?.raw != null ? 'tnum text-fg' : 'tnum text-fg-subtle'}>{facts?.raw != null ? unitsOf(facts.raw, token.decimals) : CREATE.page.notChosen}</bdi>}
                    </p>
                    {spend > 0n && (
                      <Button type="button" variant="secondary" size="sm" data-pair-max="pay" onClick={() => onPayWith({ token, text: unitsOf(spend, token.decimals).replace(/,/g, '') })}>
                        {CREATE.amount.maxLabel}
                      </Button>
                    )}
                  </div>
                )
              }
            />
          </div>
        </div>
        {paid.estimated && <p className="dm-hint" data-pay-estimate="">Estimated budget. Review confirms the tokens you receive.</p>}
        <button type="button" className="dm-funds-more" onClick={() => onPayWith(null)} data-pay-with-back="">
          Use <SymbolText token={pool.currencies[0]} /> and <SymbolText token={pool.currencies[1]} /> instead
        </button>
      </div>
    )
  }
  const choices = candidatesFromPool(pool)
  const independent = pool.currencies.findIndex((currency) => currency.address === state.token?.key)
  if ((independent === 0 || independent === 1) && first?.pool !== pool.key) setFirst({ pool: pool.key, side: independent })
  const order: readonly (0 | 1)[] = (first?.pool === pool.key ? first.side : independent) === 1 ? [1, 0] : [0, 1]
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

  // The one token the range takes, when it takes one alone: only its panel is drawn.
  const only = takesOnly(state)
  // How the wallet funds it, from the balances the read service reported (Review's own reading, lib/create/reviewPlan.ts).
  const plan = reviewPlan(state, rawBalances(balances))?.plan ?? null
  // The same qualified estimate as Review and the live preview. No new prices or money calculations.
  const held = heldAmounts(state, balances)
  const total = held !== null && held.sides.every((side) => side.usd !== null) ? held.total : null
  const swap = plan && plan.kind === 'swap' && plan.swap > 0n ? plan : null
  // All of the deposit is swapped: said so, never "part" or "about" a figure that is all of it.
  const whole = swap !== null && swap.swap >= swap.deposit
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
    // Nothing to show is an empty field, never a sentence about it (QA round 2 sweep).
    if (other.kind === 'unknown') return { value: '', note: null }
    if (other.kind === 'unused') {
      const kept = pool.currencies[other.only]
      return { value: '', note: CREATE.amount.pairUnused(kept.symbol ?? '') }
    }
    return { value: fieldText(unitsOf(other.raw, currency.decimals)), note: other.only === null ? null : CREATE.amount.pairOneSided(pool.currencies[other.only].symbol ?? '') }
  }

  // The wallet cannot fund the amounts either way (audit E9, 2026-10-01): said as a warning, announced, tied to the typed
  // field, and naming both tokens, since neither one alone nor both together cover it. Words only: Create position stays
  // open (it looks for an earlier deposit first), and Review says the same with the amounts.
  const short = plan !== null && plan.kind === 'short'
  const shortId = 'create-amount-short'

  // QA round 2, N51 and Q20 (2026-10-30): the deposit beside the pool's reported TVL (another network's only while it may
  // be shown), said in plain words under the total: its share from about 10%, or a second look when it is more than the
  // whole pool. Never a warning colour, never a block: a thin pool can take a large deposit.
  const tvl = reportedTvl(networkFiguresAt(marketPool ?? pool, Math.floor(now / 1000)))
  const sizeLine = poolSizeLine(tvl, total)
  const sizeId = 'create-amount-size'
  const describedBy = [short ? shortId : null, sizeLine ? sizeId : null].filter(Boolean).join(' ')

  // Each amount's raw units, for its USD line: the typed one once it is a real amount, the other once the range pairs one with it.
  const rawOf = (side: 0 | 1): string | null => (side === independent ? (budget.ok ? budget.raw : null) : other && other.kind === 'amount' ? other.raw : null)

  return (
    <div className="dm-flow-stack">
      <div className="dm-flow-pair" data-paired-amounts={independent === -1 ? 'none' : String(independent)}>
        {order.map((side, position) => {
          const currency = pool.currencies[side]
          // A range that takes one token alone asks for that token's amount only.
          // A background price move may leave the typed token outside the range. Keep that input visible
          // until the person changes it; hiding it would look as though their amount had been cleared.
          if (only !== null && side !== only && side !== independent) return null
          const mine = side === independent
          const choice = choices[side]
          const unreadable = choice.why !== null || choice.token.decimals === null
          const shown = mine ? { value: state.budget, note: null } : otherText(side)
          const fieldId = `create-amount-${side}`
          const balance = balances.balances?.[side] ?? null
          // A figure only for a balance read as a number (lib/read/pagers.ts amountFact: a value, or zero).
          const readable = balance?.fact && (balance.fact.state === 'value' || balance.fact.state === 'zero') ? balance.fact.text : null
          // Max leaves native ETH's gas allowance in the wallet (maxSpend), so Review never finds it short of what Max typed.
          const spend = balance?.raw && /^\d+$/.test(balance.raw) ? maxSpend(BigInt(balance.raw), currency.address === NATIVE_CURRENCY) : 0n
          const fill = spend > 0n ? unitsOf(spend, currency.decimals).replace(/,/g, '') : null
          // The swapped side has no USD of its own: the preview's deposit stays the one statement of value.
          const usd = side === quiet ? null : usdOfSide(pool, side, rawOf(side))
          return (
            <Fragment key={currency.address}>
              {/* Between the two panels, as the swap form joins its two: decoration only. */}
              {position === 1 && only === null && (
                <span aria-hidden="true" className="dm-flow-link">
                  <IconPlus size={16} />
                </span>
              )}
              <div className="dm-flow-pair-row" data-pair-side={side} data-pair-role={mine ? 'typed' : 'derived'} data-plan-side={side === quiet ? 'swapped' : undefined}>
                <span className="dm-flow-pair-caption" aria-hidden="true">{mine ? CREATE.amount.entered : CREATE.amount.paired}</span>
                <AmountField
                  id={fieldId}
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
                  value={shownAs(fieldId, shown.value)}
                  onFocus={(event) => {
                    const input = event.currentTarget
                    if (input.value !== shown.value) input.value = shown.value
                    setEditing(fieldId)
                  }}
                  onBlur={() => setEditing((was) => (was === fieldId ? null : was))}
                  disabled={unreadable}
                  onChange={(event) => (mine ? onBudget(event.target.value) : onDeposit(choice, event.target.value))}
                  error={mine && state.budget !== '' && !budget.ok ? budget.reason : unreadable ? CREATE.amount.pairUnreadable : null}
                  {...(mine && short ? { 'aria-invalid': true } : {})}
                  {...(mine && describedBy ? { 'aria-describedby': describedBy } : {})}
                  usd={usd !== null ? <UsdText value={usd} floor /> : undefined}
                  below={shown.note ? <p className="dm-hint">{shown.note}</p> : null}
                  footer={
                    disconnected ? null : (
                      <div className="dm-flow-balance" data-pair-balance={balances.status} data-pair-refreshing={balances.refreshing ? '' : undefined}>
                        <p className="dm-flow-balance-line">
                          <span className="text-fg-subtle">{balances.status !== 'ready' ? CREATE.amount.pairReading : CREATE.amount.balanceAt(null)}</span>{' '}
                          {/* A balance that could not be read is the figure dash, never a sentence (QA round 2 sweep), and so is
                              one read without its decimals ("Unavailable", "… (raw units, decimals unknown)"), as the Wallet
                              card shows both. */}
                          {balances.status === 'ready' && <bdi className={readable ? 'tnum text-fg' : 'tnum text-fg-subtle'}>{readable ?? <FigureDash />}</bdi>}
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
      {held && (
        <div className="dm-flow-deposit-total" data-amount-total={total !== null ? 'valued' : 'unavailable'}>
          <div className="dm-flow-deposit-total-head">
            <span>{CREATE.amount.total}</span>
            {/* QA round 2 (2026-10-30): a figure with no value is the figure dash (sweep), and a long one breaks only between its
                digit groups, never inside one (Q20, ../positions/Figure.tsx). */}
            {/* QA round 2, N2 (d): under a cent it reads "<$0.01", as Review's total does. */}
            <strong className="tnum">{total !== null ? <Figure text={formatUsdFloor(total)} /> : CREATE.page.notChosen}</strong>
          </div>
          <p>
            {held.estimate ? CREATE.amount.totalSwapNote : held.only !== null ? CREATE.amount.totalOneNote : CREATE.amount.totalNote}
            {sizeLine && (
              <>
                {' '}
                <span id={sizeId} data-amount-size={sizeLine === CREATE.amount.beyondPool ? 'beyond' : 'share'}>
                  {sizeLine}
                </span>
              </>
            )}
          </p>
        </div>
      )}
      {disconnected && (
        <p className="dm-hint" data-pair-balance="disconnected">
          {/* QA round 2, N22: with no wallet, the one line also says a wallet with one of the two tokens is enough, with the
              docs' amount step one quiet link away (its review). Changed on purpose 2026-10-30 (QA round 2, final review
              create-1): in a new tab, so the pool, range and amount already chosen are still here after reading it (a
              same-tab link left New position, and Back started an empty flow); a screen reader hears where it opens. */}
          {CREATE.amount.connectForBalance}
          {only === null && (
            <>
              {` ${CREATE.amount.connectOneToken} `}
              <a className="underline" href={docsHref('new-position', 'step-amount')} target="_blank" rel="noopener noreferrer" data-pair-docs="">
                {CREATE.amount.connectOneTokenLink}
                <span className="sr-only">{CREATE.page.newTab}</span>
              </a>
            </>
          )}
        </p>
      )}
      {/* One line under the panels, only when the wallet changes the plan: part of one token swapped, or not enough. */}
      {swap && swapped !== null && (
        <p className="dm-flow-position" data-tone="neutral" data-amount-swap={swap.from} data-amount-swap-typed={swapped === independent ? '' : undefined}>
          {swapped === independent ? (
            // The swap buys the typed token: the wallet's other token pays for all of it, more than its own panel shows.
            whole ? (
              <span>
                {/* Changed on purpose 2026-10-06 (the owner's point 4: little text): what Domino swaps, in one short sentence. */}
                Domino swaps <AmountText text={unitsOf(swap.deposit, pool.currencies[swap.from].decimals)} /> <SymbolText token={pool.currencies[swap.from]} /> from your
                wallet for <SymbolText token={pool.currencies[swapped]} />.
              </span>
            ) : (
              <span>
                Domino swaps about <AmountText text={unitsOf(swap.swap, pool.currencies[swap.from].decimals)} /> <SymbolText token={pool.currencies[swap.from]} /> for{' '}
                <SymbolText token={pool.currencies[swapped]} /> for you, so <AmountText text={unitsOf(swap.deposit, pool.currencies[swap.from].decimals)} />{' '}
                <SymbolText token={pool.currencies[swap.from]} /> comes from your wallet.
              </span>
            )
          ) : (
            <span>
              Domino swaps about <AmountText text={unitsOf(swap.swap, pool.currencies[swap.from].decimals)} /> <SymbolText token={pool.currencies[swap.from]} /> for{' '}
              <SymbolText token={pool.currencies[swapped]} /> for you.
            </span>
          )}
        </p>
      )}
      {plan && plan.kind === 'short' && (
        <p id={shortId} role="status" className={pay ? 'sr-only' : 'dm-flow-position'} data-tone={onPayWith ? 'neutral' : 'warn'} data-amount-short={plan.token}>
          {pay ? 'Choose a funding option below.' : onPayWith ? 'This amount needs more funds on this network.' : CREATE.amount.shortOf(pool.currencies[plan.token].symbol ?? '', pool.currencies[plan.token === 0 ? 1 : 0].symbol ?? '')}
        </p>
      )}
    </div>
  )
}
