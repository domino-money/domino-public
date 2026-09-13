import { CREATE } from '../../lib/create/copy'
import { candidateDecimals, feeBases, positionText, priceOf, serialiseSummary, validateBudget, walletSteps, type JourneyState } from '../../lib/create/journey'
import { rangePosition } from '../../lib/read/screens/poolRange'
import { Address } from '../read/screens/Address'
import { SymbolText } from '../read/screens/SymbolText'
import { Button, LinkButton, Pill } from '../ui'
import { automationPill } from './StageAutomation'
import { RequestDetails, StageBalance } from './StageBalance'
import { AutomationSummary, PoolPair, RangeSummary } from './StepList'

/**
 * Step 5, Review: every choice, the deposit amounts (calculated in Setup),
 * the wallet steps Setup will ask for (a list, not buttons) and the fee bases
 * apart. Nothing here reads, and the request is shown, never sent.
 */
export function StageReview({ state, now }: { state: JourneyState; now: number }) {
  const token = state.token
  const pool = state.pool
  const price = priceOf(pool, now)
  const position = positionText(state, now)
  const inside = price && price.state === 'usable' && state.range ? rangePosition(state.range, price.tick) === 'inside' : null
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
        {position && (
          <p role="status" className="dm-flow-position" data-tone={inside ? 'in' : 'wait'} data-review-position="">
            {position}
          </p>
        )}
      </section>

      <StageBalance />

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
        <RequestDetails state={state} />
      </div>
    </div>
  )
}

/**
 * The last control of the flow. Deposits happen in Setup, one reviewed
 * wallet step at a time: a build that carries wallet sign-in links there and
 * says what Setup does and that nothing is carried over; any other build
 * shows the disabled action and why. This is the one sentence that depends
 * on the build, so it lives here, where the build flag is defined, and not in
 * lib/create/copy.ts, which is compiled for tests without it.
 */
export function FinalControl() {
  if (__DOMINO_WALLET_SESSION__) {
    return (
      <>
        <LinkButton href="#/setup" variant="primary" size="lg" className="w-full" data-create-position="setup" aria-describedby="create-reason">
          {CREATE.review.setup}
        </LinkButton>
        <p id="create-reason" className="dm-flow-reason" data-align="start">
          {CREATE.review.setupNote}
        </p>
      </>
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
