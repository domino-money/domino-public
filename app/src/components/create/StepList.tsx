import { useEffect, useRef, type ReactNode } from 'react'
import { CREATE } from '../../lib/create/copy'
import type { JourneyState, Stage, TickRange } from '../../lib/create/journey'
import { pricePair } from '../../lib/read/orientation'
import { shownPrice, shownRange, type PoolPrice } from '../../lib/read/screens/poolRange'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import { plainFigure } from '../../lib/create/plain'
import { feeWords } from '../../lib/format/fee'
import { FEE_MEANING } from '../explore/feeMeaning'
import { AmountText } from '../figures'
import { SymbolText } from '../read/screens/SymbolText'
import { StepMarker } from '../ui'
import { endPrice, type Held } from './valuation'
// Whether motion is stilled (reduced motion, or the footer's Pause motion): moved to lib/motion in V2 (DESIGN-V2 §5.4).
import { stilled } from '../../lib/motion/stilled'
import { rootScale } from '../../lib/rootScale'

/** The four steps a person sees, over the state machine's five stages. */
export type VisualStep = 'pool' | 'range' | 'amount' | 'review'
export const VISUAL_STEPS: readonly VisualStep[] = ['pool', 'range', 'amount', 'review']

export interface StepView {
  key: VisualStep
  state: 'upcoming' | 'current' | 'done'
  /** The machine stage the open step stands for, on its body as `data-stage-card`. */
  stage: Stage
  /** What was chosen, on the row of a done step. */
  summary: ReactNode
  /** The step's content while it is mounted (open, or kept from an earlier visit); null otherwise. */
  body: ReactNode
  /** Back, Continue or the final control, for the open step only. */
  footer: ReactNode
  /**
   * The step's lead when it differs from CREATE's (2026-10-01, live note L11): the amount step of a range that takes one
   * token alone, which asks for that token's amount only.
   */
  lead?: ReactNode
}

/* ---------------------------------------------------------------------------
   What each done step says on its row, and Review says in its lines
--------------------------------------------------------------------------- */

type Usable = Extract<PoolPrice, { state: 'usable' }>

/**
 * "WETH / USDG · 0.02% fee", symbols as untrusted text; the fee as every screen writes it (lib/format/fee.ts, audit E21).
 * Changed on purpose 2026-10-30 (QA round 2, Q24): the pair in the order its price is written (lib/read/orientation.ts
 * pricePair, "PRIORS / USDG"), as Markets and the pool page name it, never the pool's own order. Display only.
 * Changed on purpose 2026-10-30 (QA round 2, Q23/N37, the owner: the network on every pool): with `network`, the pool's
 * network before the fee ("WETH / USDC · Base · 0.05% fee"), where the chosen pool's panel shows it (other networks offered).
 * Q28: the fee says what it is on hover, as every fee chip does.
 */
export function PoolPair({ option, network = null }: { option: PoolOption; network?: string | null }) {
  const pair = pricePair(option.currencies[0], option.currencies[1])
  return (
    <>
      <SymbolText token={pair.base} /> / <SymbolText token={pair.quote} /> · {network !== null && <><span data-chain-chip={option.currencies[0].chainId}>{network}</span> · </>}
      <span title={FEE_MEANING}>{feeWords(option.fee)}</span>
    </>
  )
}

/**
 * "WETH / USDG · 0.02%". Changed on purpose (round 6, 2026-09-27): no "deposit WETH" after it. A position holds both
 * tokens and the amount step takes an amount in either, so which one step 1 started from is not a choice to show.
 */
export function PoolSummary({ state, network = null }: { state: JourneyState; network?: string | null }) {
  if (!state.pool || !state.token) return null
  return <PoolPair option={state.pool} network={network} />
}

/**
 * "1 WETH = 2,241.12 to 3,738.54 USDG", in plain words (round 6: no "≈", no "per"). Changed on purpose 2026-09-28
 * (one-sided): the app's one way round (lib/read/orientation.ts), lowest price first, "1 MANY = 0.002 to 0.003 USDG"
 * where the pool's first token is USDG.
 */
export function RangeSummary({ range, price }: { range: TickRange; price: Usable }) {
  const shown = shownPrice(price)
  const view = shownRange(range, price.inverted === true)
  // A full-range end reads 0 or ∞ (QA round 2, N73), as the range step writes it.
  const words = (tick: number, which: 'lower' | 'upper') => plainFigure(endPrice(tick, which, shown) ?? CREATE.review.summary.beyondDisplay)
  return (
    <>
      1 <SymbolText token={price.base} /> = {words(view.lower, 'lower')} to {words(view.upper, 'upper')} <SymbolText token={price.quote} />
    </>
  )
}

/**
 * "0.4522 ETH + 1,000 USDG": what the position holds, short (the exact amounts are Review's), "About" before a
 * one-token plan's amounts after its swap; the typed amount alone until both are known. Changed on purpose (round 6,
 * 2026-09-27): the slippage tolerance is under Advanced now, and no longer on this row.
 */
export function AmountSummary({ state, held }: { state: JourneyState; held: Held | null }) {
  const pool = state.pool
  if (!state.token || !pool) return null
  if (!held) {
    // Paid with one other token (2026-10-06): that amount, as typed.
    const paid = state.payWith
    return (
      <>
        {paid ? paid.text : state.budget} <SymbolText token={paid ? paid.token : state.token.token} />
      </>
    )
  }
  // One token alone (a range wholly above or below the price, 2026-09-28): that token only, never "0" of the other.
  if (held.only !== null) {
    return (
      <>
        {held.estimate && `${CREATE.review.about} `}
        <AmountText text={held.sides[held.only].text} /> <SymbolText token={pool.currencies[held.only]} />
      </>
    )
  }
  return (
    <>
      {held.estimate && `${CREATE.review.about} `}
      <AmountText text={held.sides[0].text} /> <SymbolText token={pool.currencies[0]} /> + <AmountText text={held.sides[1].text} /> <SymbolText token={pool.currencies[1]} />
    </>
  )
}

/* ---------------------------------------------------------------------------
   The list
--------------------------------------------------------------------------- */

/**
 * The flow card's four steps, in order. A done step is a row that opens it
 * again; the open step is an inset panel with its title, lead, content and
 * footer; the rest wait as rows. Opening a step grows its panel while the
 * previous one folds back to its row (CSS, instant when motion is stilled),
 * and focus moves to the open step's title, except on the first paint.
 * `locked` keeps the done rows closed while Create position is asking the
 * wallet: changing a choice mid-way would leave the steps describing another
 * position.
 */
export function StepList({ steps, onOpen, locked = false }: { steps: readonly StepView[]; onOpen: (key: VisualStep) => void; locked?: boolean }) {
  const current = steps.find((step) => step.state === 'current')?.key ?? null
  const title = useRef<HTMLHeadingElement>(null)
  const arrived = useRef(false)

  useEffect(() => {
    if (!arrived.current) {
      arrived.current = true
      return
    }
    const heading = title.current
    if (!heading) return
    heading.focus({ preventScroll: true })
    // Once the panels have settled, bring the title into view if it is under the header or low on the screen.
    const still = stilled()
    const timer = setTimeout(
      () => {
        // A person may already be pressing a control while the panel settles. Do not move that control between
        // pointer-down and pointer-up: the gesture would end elsewhere and its click would be lost.
        if (document.activeElement !== heading) return
        const header = Math.max(0, document.querySelector('header')?.getBoundingClientRect().bottom ?? 0)
        const air = rootScale()
        // QA round 2, Q6 and N14 (2026-10-30): Review's In your wallet card holds Connect wallet / Create position. On a
        // wide screen it stands beside the done rows, 12rem above Review's title (styles/v4-newposition.css §8): the scroll
        // takes the higher of the two, so its button never ends under the header. Under 900px the card is stacked under
        // the steps: the scroll brings its button up to just under the header, so it is in reach when Review opens.
        const card = heading.closest<HTMLElement>('[data-stage-card="review"]')
        const side = card?.querySelector<HTMLElement>('[data-stage="review"] > section[aria-labelledby$="steps-heading"], :scope > [data-journey-footer][data-final]') ?? null
        const action = card?.querySelector<HTMLElement>(':scope > [data-journey-footer][data-final]') ?? null
        const sideTop = side ? side.getBoundingClientRect().top : Infinity
        const headingTop = heading.getBoundingClientRect().top
        const wide = sideTop < headingTop
        const below = !wide && action ? action.getBoundingClientRect() : null
        const top = below ? below.top : Math.min(headingTop, sideTop)
        const out = below ? below.top < header + 8 * air || below.bottom > window.innerHeight : top < header + 8 * air || top > window.innerHeight * 0.6
        if (out) {
          window.scrollTo({ top: Math.max(0, window.scrollY + top - header - 24 * air), behavior: still ? 'auto' : 'smooth' })
        }
      },
      still ? 0 : 260,
    )
    return () => clearTimeout(timer)
  }, [current])

  return (
    <ol className="dm-flow-steps">
      {steps.map((step, index) => {
        const words = CREATE.step[step.key]
        const open = step.state === 'current'
        const number = index + 1
        const label = `${CREATE.page.stepOf(number, steps.length)}, ${CREATE.page.stepState[step.state]}`
        return (
          <li key={step.key} className="dm-flow-step" data-state={step.state} data-step={step.key} data-step-done={step.state === 'done' ? '' : undefined} aria-current={open ? 'step' : undefined}>
            <div className="dm-flow-collapse" data-open={open ? undefined : ''}>
              <div className="dm-flow-collapse-inner">
                {step.state === 'done' ? (
                  <button type="button" className="dm-flow-row" disabled={locked} onClick={() => onOpen(step.key)}>
                    <StepMarker index={number} state="done" label={label} />
                    <span className="dm-flow-row-title">{words.title}</span>
                    <span className="dm-flow-row-summary">{step.summary}</span>
                    <span className="dm-flow-edit">{CREATE.page.edit}</span>
                  </button>
                ) : (
                  <div className="dm-flow-row">
                    <StepMarker index={number} state="upcoming" label={label} />
                    <span className="dm-flow-row-title">{words.title}</span>
                  </div>
                )}
              </div>
            </div>
            <div className="dm-flow-collapse" data-open={open ? '' : undefined}>
              <div className="dm-flow-collapse-inner">
                {step.body !== null && (
                  <div className="dm-flow-body" data-stage-card={open ? step.stage : undefined}>
                    <div className="dm-flow-head">
                      <StepMarker index={number} state={open ? 'current' : step.state} label={label} />
                      <div className="min-w-0">
                        <h2 ref={open ? title : undefined} tabIndex={-1} className="dm-flow-title">
                          {words.title}
                        </h2>
                        {(step.lead ?? words.lead) && <p className="dm-flow-lead">{step.lead ?? words.lead}</p>}
                      </div>
                    </div>
                    <div className="dm-flow-content">{step.body}</div>
                    {open && step.footer}
                  </div>
                )}
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
