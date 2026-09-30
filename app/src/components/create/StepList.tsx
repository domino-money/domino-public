import { useEffect, useRef, type ReactNode } from 'react'
import { CREATE } from '../../lib/create/copy'
import type { JourneyState, Stage, TickRange } from '../../lib/create/journey'
import { boundPrice, shownPrice, shownRange, type PoolPrice } from '../../lib/read/screens/poolRange'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import { plainFigure } from '../../lib/create/plain'
import { AmountText } from '../figures'
import { SymbolText } from '../read/screens/SymbolText'
import { StepMarker } from '../ui'
import type { Held } from './valuation'
// Whether motion is stilled (reduced motion, or the footer's Pause motion): moved to lib/motion in V2 (DESIGN-V2 §5.4).
import { stilled } from '../../lib/motion/stilled'

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
}

/* ---------------------------------------------------------------------------
   What each done step says on its row, and Review says in its lines
--------------------------------------------------------------------------- */

type Usable = Extract<PoolPrice, { state: 'usable' }>

/** "WETH / USDG · 0.02%", symbols as untrusted text. */
export function PoolPair({ option }: { option: PoolOption }) {
  return (
    <>
      <SymbolText token={option.currencies[0]} /> / <SymbolText token={option.currencies[1]} /> · {option.fee}
    </>
  )
}

/**
 * "WETH / USDG · 0.02%". Changed on purpose (round 6, 2026-09-27): no "deposit WETH" after it. A position holds both
 * tokens and the amount step takes an amount in either, so which one step 1 started from is not a choice to show.
 */
export function PoolSummary({ state }: { state: JourneyState }) {
  if (!state.pool || !state.token) return null
  return <PoolPair option={state.pool} />
}

/**
 * "1 WETH = 2,241.12 to 3,738.54 USDG", in plain words (round 6: no "≈", no "per"). Changed on purpose 2026-09-28
 * (one-sided): the app's one way round (lib/read/orientation.ts), lowest price first, "1 MANY = 0.002 to 0.003 USDG"
 * where the pool's first token is USDG.
 */
export function RangeSummary({ range, price }: { range: TickRange; price: Usable }) {
  const shown = shownPrice(price)
  const view = shownRange(range, price.inverted === true)
  const words = (tick: number) => plainFigure(boundPrice(tick, shown) ?? CREATE.review.summary.beyondDisplay)
  return (
    <>
      1 <SymbolText token={price.base} /> = {words(view.lower)} to {words(view.upper)} <SymbolText token={price.quote} />
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
    return (
      <>
        {state.budget} <SymbolText token={state.token.token} />
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
        const top = heading.getBoundingClientRect().top
        const header = document.querySelector('header')?.getBoundingClientRect().height ?? 0
        if (top < header + 8 || top > window.innerHeight * 0.6) {
          window.scrollTo({ top: Math.max(0, window.scrollY + top - header - 24), behavior: still ? 'auto' : 'smooth' })
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
                        <p className="dm-flow-lead">{words.lead}</p>
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
