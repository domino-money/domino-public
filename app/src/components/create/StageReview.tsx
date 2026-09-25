import { lazy, Suspense } from 'react'
import { CREATE } from '../../lib/create/copy'
import type { PairBalancesState } from './usePairBalances'
import { priceOf, validateSlippage, walletSteps, type JourneyState } from '../../lib/create/journey'
import { slippageWarns, slippageWritten } from '../../lib/create/slippage'
import { formatUnits } from '../../lib/read/decimal'
import { rangePosition } from '../../lib/read/screens/poolRange'
import { Address } from '../read/screens/Address'
import { SymbolText } from '../read/screens/SymbolText'
import { Button } from '../ui'
import { ASSISTED_SWAP_FEE_BPS, type DepositPlan } from '../../lib/create/depositPlan'
import { reviewPlan } from '../../lib/create/reviewPlan'
import { NATIVE_CURRENCY } from '../../lib/read/screens/identity'
import { useCreateProgress, type LiveState } from '../../lib/create/createProgress'
import { Approx, PoolPair, RangeSummary } from './StepList'
import { RangePreview } from '../charts/RangePreview'
import { AmountText, UsdText } from '../figures'
import { TokenMarkPair } from '../TokenIcon'
import { heldAmounts, rangeView, rawBalances } from './valuation'
import type { PoolOption } from '../../lib/read/screens/poolsList'

/**
 * The position in one line: how much of each token it holds, at the pool's
 * price. Both figures are the ones the amount step showed — the typed one and
 * the one the range and the price make of it (create/pairAmount.ts) — so
 * Review opens with what is being created rather than with a list of settings.
 *
 * Null when a choice is missing or the price cannot be used. When the wallet
 * holds only one of the two tokens, the line is what the position holds after
 * part of that token is swapped for the other (lib/create/depositPlan.ts).
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

const sideOf = (pool: PoolOption, index: 0 | 1, raw: bigint | string): HeldSide => {
  const currency = pool.currencies[index]
  const units = formatUnits(String(raw), currency.decimals)
  return { amount: units && units.kind === 'units' ? units.text : String(raw), token: currency }
}

/** How the wallet funds these choices, from the balances the read service reported: what Review shows, and what the final control's line says. */
const planFor = (state: JourneyState, balances: PairBalancesState): DepositPlan | null => reviewPlan(state, rawBalances(balances))?.plan ?? null

/** What each live state says under its step, once Create position runs. */
const LIVE_CAPTION: Record<LiveState, string> = {
  waiting: 'Next',
  reading: 'Checking…',
  wallet: 'Confirm in your wallet',
  chain: 'Waiting for the network',
  done: 'Done',
  failed: 'Stopped',
}

/**
 * Step 4, Review: the choices at the top, then the wallet steps in order,
 * each turning green as Create position completes it. No Domino fee on the
 * deposit: automation, with its fee on earned fees, is applied later from
 * Automate. When the wallet holds only one of the two tokens, the headline is
 * what the position holds after part of it is swapped, and the steps include
 * that swap with its fee.
 */
export function StageReview({ state, now, balances }: { state: JourneyState; now: number; balances: PairBalancesState }) {
  const pool = state.pool
  const price = priceOf(pool, now)
  const usable = price && price.state === 'usable' ? price : null
  const inside = usable && state.range ? rangePosition(state.range, usable.tick) === 'inside' : null
  const planned = reviewPlan(state, rawBalances(balances))
  const plan = planned?.plan ?? null
  const swap = plan && plan.kind === 'swap' ? plan : null
  const steps = walletSteps(state, swap ? swap.from : null, `${ASSISTED_SWAP_FEE_BPS / 100}%`)
  // Once Create position runs, its own steps, as they happen: the tokens it found in the wallet decide them.
  const progress = useCreateProgress()
  const live = progress && progress.length > 0 ? progress : null
  // "Next" is said under the first step still waiting, and only there.
  const next = live ? live.findIndex((step) => step.state === 'waiting') : -1
  const shown = live
    ? live.map((step, index) => ({ ...step, caption: step.state === 'waiting' && index !== next ? '' : LIVE_CAPTION[step.state] }))
    : steps.map((step) => ({ ...step, state: null as LiveState | null, caption: step.detail }))
  const held = pool && planned ? ([sideOf(pool, 0, planned.need[0]), sideOf(pool, 1, planned.need[1])] as const) : null
  const slippage = validateSlippage(state.slippageBps)
  // The headline's value in USD (USDG pairs only), and the range drawn small under its lines.
  const total = planned ? (heldAmounts(state, balances)?.total ?? null) : null
  const view = pool && usable && state.range ? rangeView(state.range, usable, pool) : null
  return (
    <div className="dm-flow-stack" data-stage="review">
      <section aria-labelledby="create-choices-heading" className="dm-flow-section">
        <h3 id="create-choices-heading" className="dm-flow-subtitle">
          {CREATE.review.choices}
        </h3>
        <div className="dm-flow-headline" data-review-headline="">
          {/* PoolPair already ends in the fee ("ETH / TOKEN · 0.30%"); a chip beside it said the same thing twice. */}
          <p className="dm-flow-headline-pair">
            {pool ? (
              <>
                <TokenMarkPair base={pool.currencies[0]} quote={pool.currencies[1]} size={24} ring="var(--flow-well, var(--surface-1))" />
                <span className="min-w-0">
                  <PoolPair option={pool} />
                </span>
              </>
            ) : (
              CREATE.page.notChosen
            )}
          </p>
          <p className="dm-flow-headline-amounts tnum" data-review-amounts="" data-review-plan={plan?.kind}>
            {/* Every digit stays (the amount is compared at full precision); the digits past the sixth are dimmed. */}
            {/* Each side is one phrase that keeps its line, and the + leads the second, so a narrow line breaks only before the +. */}
            {swap && pool ? (
              // What the position holds once part of the one token is swapped: estimates, before the pool's own price impact.
              <>
                <span className="dm-flow-headline-side">
                  <span className="dm-approx">≈</span>
                  <AmountText text={sideOf(pool, swap.from, swap.deposit - swap.swap).amount} mode="dim-tail" /> <SymbolText token={pool.currencies[swap.from]} />
                </span>{' '}
                <span className="dm-flow-headline-side">
                  + <span className="dm-approx">≈</span>
                  <AmountText text={sideOf(pool, swap.from === 0 ? 1 : 0, swap.receive).amount} mode="dim-tail" /> <SymbolText token={pool.currencies[swap.from === 0 ? 1 : 0]} />
                </span>
              </>
            ) : held ? (
              <>
                <span className="dm-flow-headline-side">
                  <AmountText text={held[0].amount} mode="dim-tail" /> <SymbolText token={held[0].token} />
                </span>{' '}
                <span className="dm-flow-headline-side">
                  + <AmountText text={held[1].amount} mode="dim-tail" /> <SymbolText token={held[1].token} />
                </span>
              </>
            ) : (
              CREATE.page.notChosen
            )}
          </p>
          {total !== null && (
            <p className="dm-usd-line dm-flow-headline-usd">
              <UsdText value={total} approx={swap !== null} />
            </p>
          )}
          {swap && pool && (
            <p className="dm-flow-headline-line tnum" data-review-swap={swap.from}>
              From your wallet: {sideOf(pool, swap.from, swap.deposit).amount} <SymbolText token={pool.currencies[swap.from]} />. About {sideOf(pool, swap.from, swap.swap).amount}{' '}
              <SymbolText token={pool.currencies[swap.from]} /> of it is swapped for ≈<AmountText text={sideOf(pool, swap.from === 0 ? 1 : 0, swap.receive).amount} mode="dim-tail" />{' '}
              <SymbolText token={pool.currencies[swap.from === 0 ? 1 : 0]} />.
            </p>
          )}
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
          {/* The range drawn small, with the bounds the line above says under its ends. Beside the steps on a wide screen the preview draws it large, so this one is shown only where that one is not. */}
          {view && (
            <RangePreview
              lower={view.lower}
              upper={view.upper}
              current={view.current}
              inRange={view.inRange}
              height={56}
              labels={{ lower: <Approx text={view.lowerText ?? CREATE.review.summary.beyondDisplay} />, upper: <Approx text={view.upperText ?? CREATE.review.summary.beyondDisplay} /> }}
              className="dm-flow-headline-range"
            />
          )}
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
        {swap && pool && (
          // One span: the line is a flex row (its dot, then the sentence), and the symbols must stay inside the sentence.
          <p role="status" className="dm-flow-position" data-tone="neutral" data-review-swap-note="">
            <span>
              Your wallet does not hold enough <SymbolText token={pool.currencies[swap.from === 0 ? 1 : 0]} />, so part of your <SymbolText token={pool.currencies[swap.from]} /> is swapped for it
              inside this pool before the position is created. {CREATE.review.swapNote(`${ASSISTED_SWAP_FEE_BPS / 100}%`)}
            </span>
          </p>
        )}
        {/* The pool's liquidity figure is reported and zero: the swap has nothing to trade against. Create position checks the pool on chain too, before anything is deposited. */}
        {swap && planned?.noLiquidity && (
          <p role="status" className="dm-flow-position" data-tone="neutral" data-review-liquidity="none">
            {CREATE.review.emptyPool}
          </p>
        )}
        {plan && plan.kind === 'short' && pool && (
          <p role="status" className="dm-flow-position" data-tone="neutral" data-review-short={plan.token}>
            <span>
              Your wallet holds {sideOf(pool, plan.token, plan.have).amount} <SymbolText token={pool.currencies[plan.token]} />
              {pool.currencies[plan.token].address === NATIVE_CURRENCY ? ' after network gas' : ''}; this position needs {sideOf(pool, plan.token, plan.need).amount}. Lower the amount, or add{' '}
              <SymbolText token={pool.currencies[plan.token]} /> to your wallet.
            </span>
          </p>
        )}
      </section>

      <section aria-labelledby="create-steps-heading" className="dm-flow-section">
        <h3 id="create-steps-heading" className="dm-flow-subtitle">
          {CREATE.review.steps}
        </h3>
        <p className="text-caption text-fg-muted">{CREATE.review.stepsNote}</p>
        <ol className="dm-flow-wsteps" data-wallet-steps="" data-live={live ? '' : undefined} aria-live="polite">
          {shown.map((step, index) => (
            <li key={step.key} data-wallet-step={step.key} data-step-state={step.state ?? undefined}>
              <span
                aria-hidden="true"
                className="dm-step-marker"
                data-state={step.state === 'done' ? 'done' : step.state === 'wallet' || step.state === 'chain' || step.state === 'reading' ? 'current' : undefined}
              >
                {step.state === 'done' ? '✓' : index + 1}
              </span>
              <span className="dm-flow-wstep-body">
                <span className="dm-flow-wstep-title">
                  {step.title}
                  {step.token && (
                    <span className="dm-flow-wstep-token">
                      <SymbolText token={step.token} /> <Address value={step.token.address} short />
                    </span>
                  )}
                </span>
                {step.caption && <span className="dm-flow-wstep-note">{step.caption}</span>}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}

// The final control in builds with the wallet: Create position, from its own chunk, so the entry never carries the
// wallet or the setup client. While it loads, the disabled button stands in for it.
const CreateControl = __DOMINO_WALLET_SESSION__
  ? lazy(() =>
      import('./DepositAmounts')
        .then((module) => ({ default: module.CreatePosition }))
        .catch(() => ({ default: () => <Unavailable note={CREATE.review.loadFailed} /> })),
    )
  : null

function Unavailable({ note }: { note: string }) {
  return (
    <>
      <Button type="button" variant="primary" size="xl" className="w-full" disabled data-create-position="" aria-describedby="create-reason">
        {CREATE.page.create}
      </Button>
      <p id="create-reason" className="dm-flow-reason" data-align="start">
        {note}
      </p>
    </>
  )
}

/**
 * The last control of the flow: Create position. In a build that carries the
 * wallet it opens the position through the wallet, step by step
 * (CreatePosition.tsx), and says under it when Review's reading finds the
 * wallet cannot fund it; any other build shows the disabled action and why.
 * This is the one control that depends on the build, so it lives here, where
 * the build flag is defined, and not in lib/create/copy.ts, which is compiled
 * for tests without it.
 */
export function FinalControl({ state, balances, onBusy }: { state: JourneyState; balances: PairBalancesState; onBusy?: (busy: boolean) => void }) {
  if (CreateControl) {
    return (
      <Suspense fallback={<Unavailable note={CREATE.review.loading} />}>
        <CreateControl state={state} reviewed={planFor(state, balances)} onBusy={onBusy} />
      </Suspense>
    )
  }
  return <Unavailable note={CREATE.review.noWallet} />
}
