import { useEffect, useRef, type ReactNode } from 'react'
import { CREATE } from '../../lib/create/copy'
import type { Automation, JourneyState, Stage, TickRange } from '../../lib/create/journey'
import { boundPrice, type PoolPrice } from '../../lib/read/screens/poolRange'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import { SymbolText } from '../read/screens/SymbolText'
import { StepMarker } from '../ui'

/** The five steps a person sees, over the state machine's six stages. */
export type VisualStep = 'pool' | 'range' | 'amount' | 'automation' | 'review'
export const VISUAL_STEPS: readonly VisualStep[] = ['pool', 'range', 'amount', 'automation', 'review']

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

/** "WETH / USDG · 0.02% · deposit WETH". */
export function PoolSummary({ state }: { state: JourneyState }) {
  if (!state.pool || !state.token) return null
  return (
    <>
      <PoolPair option={state.pool} /> · deposit <SymbolText token={state.token.token} />
    </>
  )
}

/** "≈2,241.12 to ≈3,738.54 USDG per WETH": the pool's own orientation, currency1 per currency0. */
export function RangeSummary({ range, price }: { range: TickRange; price: Usable }) {
  const words = (tick: number) => boundPrice(tick, price) ?? CREATE.review.summary.beyondDisplay
  return (
    <>
      {words(range.lower)} to {words(range.upper)} <SymbolText token={price.quote} /> per <SymbolText token={price.base} />
    </>
  )
}

/** "0.25 WETH". */
export function AmountSummary({ state }: { state: JourneyState }) {
  if (!state.token) return null
  return (
    <>
      {state.budget} <SymbolText token={state.token.token} />
    </>
  )
}

/** "None", "Auto-compound" or "Domino sequence". */
export function AutomationSummary({ automation }: { automation: Automation }) {
  return <>{CREATE.automation.options[automation].title}</>
}

/* ---------------------------------------------------------------------------
   The list
--------------------------------------------------------------------------- */

/** Whether motion is stilled: reduced motion, or the footer's Pause motion. */
const stilled = () =>
  (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) || document.documentElement.classList.contains('dm-still')

/**
 * The flow card's five steps, in order. A done step is a row that opens it
 * again; the open step is an inset panel with its title, lead, content and
 * footer; the rest wait as rows. Opening a step grows its panel while the
 * previous one folds back to its row (CSS, instant when motion is stilled),
 * and focus moves to the open step's title, except on the first paint.
 */
export function StepList({ steps, onOpen }: { steps: readonly StepView[]; onOpen: (key: VisualStep) => void }) {
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
                  <button type="button" className="dm-flow-row" onClick={() => onOpen(step.key)}>
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
