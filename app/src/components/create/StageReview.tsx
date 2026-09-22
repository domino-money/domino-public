import { lazy, Suspense } from 'react'
import { CREATE } from '../../lib/create/copy'
import type { PairBalancesState } from './usePairBalances'
import { candidateDecimals, priceOf, validateBudget, validateSlippage, walletSteps, type JourneyState } from '../../lib/create/journey'
import { pairedAmount } from '../../lib/create/pairAmount'
import { slippageWarns, slippageWritten } from '../../lib/create/slippage'
import { formatUnits } from '../../lib/read/decimal'
import { rangePosition } from '../../lib/read/screens/poolRange'
import { Address } from '../read/screens/Address'
import { SymbolText } from '../read/screens/SymbolText'
import { Button, LinkButton } from '../ui'
import { StageBalance } from './StageBalance'
import { PoolPair, RangeSummary } from './StepList'
import type { PoolOption } from '../../lib/read/screens/poolsList'

/**
 * The position in one line: how much of each token it holds, at the pool's
 * price. Both figures are the ones the amount step showed — the typed one and
 * the one the range and the price make of it (create/pairAmount.ts) — so
 * Review opens with what is being created rather than with a list of settings.
 *
 * Null when a choice is missing or the price cannot be used; the service's own
 * expected and maximum amounts, with slippage, arrive below in StageBalance
 * when onboarding answers, and they remain the authority.
 *
 * Returned as two sides rather than one sentence so each symbol can be drawn
 * through SymbolText. A symbol is whatever the token contract returned: it can
 * carry a right-to-left override that reorders the figures around it, or run
 * long enough to push the line off the panel. Every read screen already
 * isolates symbols that way; this is the same treatment for Review.
 */
interface HeldSide {
  amount: string
  token: PoolOption['currencies'][number]
}

function heldAmounts(state: JourneyState): [HeldSide, HeldSide] | null {
  const { pool, token, range } = state
  if (!pool || !token || !range) return null
  const independent = pool.currencies.findIndex((currency) => currency.address === token.key)
  if (independent !== 0 && independent !== 1) return null
  const budget = validateBudget(state.budget, candidateDecimals(token))
  if (!budget.ok) return null
  const other = pairedAmount({ sqrtPriceX96: pool.sqrtPriceX96, tickLower: range.lower, tickUpper: range.upper, independent, amountRaw: budget.raw })
  if (other.kind !== 'amount') return null
  const side = (index: 0 | 1, raw: string): HeldSide => {
    const currency = pool.currencies[index]
    const units = formatUnits(raw, currency.decimals)
    return { amount: units && units.kind === 'units' ? units.text : raw, token: currency }
  }
  const mine = side(independent, budget.raw)
  const theirs = side(independent === 0 ? 1 : 0, other.raw)
  return independent === 0 ? [mine, theirs] : [theirs, mine]
}

/**
 * Step 4, Review: what is being created at the top, the deposit amounts the
 * service reports when it answers (StageBalance.tsx), and the wallet steps in
 * order. No Domino fee: a direct deposit carries none, and automation, with
 * its fee on earned fees, is applied later from Automate. `open` is whether
 * Review is the open step: the amounts are asked for only then.
 */
export function StageReview({ state, now, open, balances }: { state: JourneyState; now: number; open: boolean; balances: PairBalancesState }) {
  const pool = state.pool
  const price = priceOf(pool, now)
  const usable = price && price.state === 'usable' ? price : null
  const inside = usable && state.range ? rangePosition(state.range, usable.tick) === 'inside' : null
  const steps = walletSteps(state)
  const held = heldAmounts(state)
  const slippage = validateSlippage(state.slippageBps)
  return (
    <div className="dm-flow-stack" data-stage="review">
      <section aria-labelledby="create-choices-heading" className="dm-flow-section">
        <h3 id="create-choices-heading" className="dm-flow-subtitle">
          {CREATE.review.choices}
        </h3>
        <div className="dm-flow-headline" data-review-headline="">
          {/* PoolPair already ends in the fee ("ETH / TOKEN · 0.30%"); a chip beside it said the same thing twice. */}
          <p className="dm-flow-headline-pair">
            {pool ? <PoolPair option={pool} /> : CREATE.page.notChosen}
          </p>
          <p className="dm-flow-headline-amounts tnum" data-review-amounts="">
            {held ? (
              <>
                {held[0].amount} <SymbolText token={held[0].token} /> + {held[1].amount} <SymbolText token={held[1].token} />
              </>
            ) : (
              CREATE.page.notChosen
            )}
          </p>
          <p className="dm-flow-headline-line tnum" data-review-range="">
            {state.range && price && price.state === 'usable' ? (
              <>
                {CREATE.review.rangeBetween} <RangeSummary range={state.range} price={price} />
              </>
            ) : state.range ? (
              CREATE.review.summary.rangeTicks(state.range.lower, state.range.upper)
            ) : (
              CREATE.page.notChosen
            )}
          </p>
          {/* The person's own tolerance, in view here and again on Setup's draft before any wallet step. */}
          <p className="dm-flow-headline-line tnum" data-review-slippage={slippage.ok ? slippage.bps : undefined}>
            {slippage.ok ? CREATE.review.slippage(slippageWritten(slippage.bps)) : CREATE.page.notChosen}
          </p>
        </div>
        {slippage.ok && slippageWarns(slippage.bps) && (
          <p role="status" className="dm-flow-position" data-tone="neutral" data-review-slippage-warning="">
            {CREATE.amount.slippageWarning(slippageWritten(slippage.bps))}
          </p>
        )}
        {/* Only when there is something to warn about, as the range step does:
            a range that does not hold the price earns no fees until the price
            moves into it. The ordinary case is silent on screen. */}
        {inside === false && usable && (
          // A price read more than 5 minutes ago keeps its sentence in normal type; that it is stale is in the title only.
          <p role="status" className="dm-flow-position" data-tone="neutral" data-review-position="" data-stale={usable.stale ? '' : undefined} title={usable.stale ? CREATE.review.stale : undefined}>
            {CREATE.review.outOfRange}
          </p>
        )}
        {inside === true && usable && <span className="sr-only" data-review-position="inside">{CREATE.review.inRange}</span>}
      </section>

      <StageBalance state={state} open={open} balances={balances} />

      <section aria-labelledby="create-steps-heading" className="dm-flow-section">
        <h3 id="create-steps-heading" className="dm-flow-subtitle">
          {CREATE.review.steps}
        </h3>
        <p className="text-caption text-fg-muted">{CREATE.review.stepsNote}</p>
        <ol className="dm-flow-wsteps" data-wallet-steps="">
          {steps.map((step, index) => (
            <li key={step.title}>
              <span aria-hidden="true" className="dm-step-marker">
                {index + 1}
              </span>
              <span className="grid min-w-0 gap-0.5">
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-body font-medium text-fg">
                  {step.title}
                  {step.token && (
                    <span className="text-caption font-normal text-fg-muted">
                      <SymbolText token={step.token} /> <Address value={step.token.address} short />
                    </span>
                  )}
                </span>
                <span className="text-caption text-fg-muted">{step.detail}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}

// The final control's own part in builds with wallet sign-in, from the same chunk as the deposit amounts: it
// carries the choices to Setup for a signed-in wallet. While it loads, the plain link stands in for it with the
// neutral line: that link carries nothing, so it promises nothing.
const ContinueInSetup = __DOMINO_WALLET_SESSION__
  ? lazy(() =>
      import('./DepositAmounts')
        .then((module) => ({ default: module.ContinueInSetup }))
        .catch(() => ({ default: () => <SetupLink note={CREATE.review.gateDetail} /> })),
    )
  : null

/** The link to Setup and the one line under it. `onClick` carries the choices; without it the link carries nothing. */
export function SetupLink({ note, onClick }: { note: string; onClick?: () => void }) {
  return (
    <>
      <LinkButton href="#/setup" variant="primary" size="lg" className="w-full" data-create-position="setup" aria-describedby="create-reason" onClick={onClick}>
        {CREATE.review.setup}
      </LinkButton>
      <p id="create-reason" className="dm-flow-reason" data-align="start">
        {note}
      </p>
    </>
  )
}

/**
 * The last control of the flow. Deposits happen in Setup, one reviewed
 * wallet step at a time: a build that carries wallet sign-in links there, and
 * the link takes these choices along for a signed-in wallet; any other build
 * shows the disabled action and why. This is the one control that depends on
 * the build, so it lives here, where the build flag is defined, and not in
 * lib/create/copy.ts, which is compiled for tests without it.
 */
export function FinalControl({ state }: { state: JourneyState }) {
  if (ContinueInSetup) {
    return (
      <Suspense fallback={<SetupLink note={CREATE.review.gate} />}>
        <ContinueInSetup state={state} />
      </Suspense>
    )
  }
  return (
    <>
      <Button type="button" variant="primary" size="lg" className="w-full" disabled data-create-position="" aria-describedby="create-reason">
        {CREATE.page.create}
      </Button>
      <p id="create-reason" className="dm-flow-reason" data-align="start">
        {CREATE.review.noSetup}
      </p>
    </>
  )
}
