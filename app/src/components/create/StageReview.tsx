import { lazy, Suspense } from 'react'
import { CREATE } from '../../lib/create/copy'
import type { PairBalancesState } from './usePairBalances'
import { candidateDecimals, feeBases, priceOf, serialiseSummary, validateBudget, walletSteps, type JourneyState } from '../../lib/create/journey'
import { rangePosition } from '../../lib/read/screens/poolRange'
import { Address } from '../read/screens/Address'
import { SymbolText } from '../read/screens/SymbolText'
import { Button, LinkButton, Pill } from '../ui'
import { automationPill } from './StageAutomation'
import { StageBalance } from './StageBalance'
import { AutomationSummary, PoolPair, RangeSummary } from './StepList'

/**
 * Step 5, Review: every choice, the deposit amounts (an estimate while one is
 * current, StageBalance.tsx), the wallet steps in order (the deposit in Setup,
 * then any automation from Automate; a list, not buttons) and the fee bases
 * apart. `open` is whether Review is the open step: the amounts are asked for
 * only then.
 */
export function StageReview({ state, now, open, balances }: { state: JourneyState; now: number; open: boolean; balances: PairBalancesState }) {
  const token = state.token
  const pool = state.pool
  const price = priceOf(pool, now)
  const usable = price && price.state === 'usable' ? price : null
  const inside = usable && state.range ? rangePosition(state.range, usable.tick) === 'inside' : null
  const budget = token ? validateBudget(state.budget, candidateDecimals(token)) : null
  const steps = walletSteps(state)
  const pill = automationPill(state.automation)
  const lines = CREATE.review.lines
  return (
    <div className="dm-flow-stack" data-stage="review">
      <section aria-labelledby="create-choices-heading" className="dm-flow-section">
        <h3 id="create-choices-heading" className="dm-flow-subtitle">
          {CREATE.review.choices}
        </h3>
        <dl className="dm-flow-facts">
          <div data-review-line="pool">
            <dt>{lines.pool}</dt>
            <dd>{pool ? <PoolPair option={pool} /> : CREATE.page.notChosen}</dd>
          </div>
          <div data-review-line="token">
            <dt>{lines.token}</dt>
            <dd>
              {token ? (
                <>
                  <SymbolText token={token.token} />
                  <span className="dm-flow-fact-sub">
                    <Address value={token.key} short />
                  </span>
                </>
              ) : (
                CREATE.page.notChosen
              )}
            </dd>
          </div>
          <div data-review-line="range">
            <dt>{lines.range}</dt>
            <dd className="tnum">
              {state.range && price && price.state === 'usable' ? (
                <>
                  <RangeSummary range={state.range} price={price} />
                  <span className="dm-flow-fact-sub">{CREATE.review.summary.rangeTicks(state.range.lower, state.range.upper)}</span>
                </>
              ) : state.range ? (
                CREATE.review.summary.rangeTicks(state.range.lower, state.range.upper)
              ) : (
                CREATE.page.notChosen
              )}
            </dd>
          </div>
          <div data-review-line="budget">
            <dt>{lines.budget}</dt>
            <dd className="tnum">
              {token && budget?.ok ? (
                <>
                  {state.budget} <SymbolText token={token.token} />
                </>
              ) : (
                CREATE.page.notChosen
              )}
            </dd>
          </div>
          <div data-review-line="slippage">
            <dt>{lines.slippage}</dt>
            <dd className="tnum">{CREATE.amount.slippageValue(state.slippageBps)}</dd>
          </div>
          <div data-review-line="automation">
            <dt>{lines.automation}</dt>
            <dd>
              <AutomationSummary automation={state.automation} />
              {pill && <Pill className="ml-2">{pill}</Pill>}
            </dd>
          </div>
          <div>
            <dt>{CREATE.review.recipient}</dt>
            <dd className="text-fg-muted">{CREATE.review.recipientValue}</dd>
          </div>
        </dl>
        {inside !== null && usable && (
          // A price read more than 5 minutes ago keeps its sentence in normal type; that it is stale is in the title only.
          <p role="status" className="dm-flow-position" data-tone={inside ? 'in' : 'neutral'} data-review-position="" data-stale={usable.stale ? '' : undefined} title={usable.stale ? CREATE.review.stale : undefined}>
            {inside ? CREATE.review.inRange : CREATE.review.outOfRange}
          </p>
        )}
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
                  {pill && state.automation !== 'none' && index === steps.length - 1 && <Pill>{pill}</Pill>}
                </span>
                <span className="text-caption text-fg-muted">{step.detail}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="dm-hint">{CREATE.review.gateDetail}</p>
      </section>

      <section aria-labelledby="create-fees-heading" className="dm-flow-section">
        <h3 id="create-fees-heading" className="dm-flow-subtitle">
          {CREATE.review.fees}
        </h3>
        <p className="text-caption text-fg-muted">{CREATE.review.feesNote}</p>
        <dl className="dm-flow-facts dm-flow-facts--noted" data-fee-bases="">
          {feeBases(state).map((fee) => (
            <div key={fee.label}>
              <dt>{fee.label}</dt>
              <dd className="tnum">{fee.value}</dd>
              <dd className="dm-flow-fact-note">{fee.note}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="dm-flow-disclosures">
        <details className="dm-details dm-flow-disclosure">
          <summary>{CREATE.review.summaryHeading}</summary>
          <pre className="dm-pre" data-summary-text="">
            {serialiseSummary(state, now).join('\n')}
          </pre>
        </details>
      </div>
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
