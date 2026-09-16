import { ROADMAP, type Availability } from '../../lib/capabilities'
import { CREATE } from '../../lib/create/copy'
import { LIMIT_BOUNDS, priceOf, successorGeometry, validateLimits, type Automation, type DominoLimits, type JourneyState } from '../../lib/create/journey'
import { boundPrice, fromPoolPrice } from '../../lib/read/screens/poolRange'
import { SequenceFrame } from '../home/Vignettes'
import { Pill } from '../ui'
import { TextField } from './fields'

/** Each choice, and the ROADMAP entry whose status its pill shows (none for "Self-managing"). */
const OPTIONS: ReadonlyArray<{ key: Automation; roadmap: string | null }> = [
  { key: 'none', roadmap: null },
  { key: 'compound', roadmap: 'Compound' },
  { key: 'domino', roadmap: 'Domino' },
]

const STATUS_WORDS: Record<Availability, string> = { 'not-connected': CREATE.automation.notEnabled, planned: CREATE.automation.planned }

/** The pill a choice wears while ROADMAP says it is not connected or planned; nothing once ROADMAP drops the entry. */
export function automationPill(key: Automation): string | null {
  const name = OPTIONS.find((option) => option.key === key)?.roadmap
  const entry = name ? ROADMAP.find((item) => item.name === name) : undefined
  return entry ? STATUS_WORDS[entry.status] : null
}

function Rules({ heading, rules }: { heading: string; rules: readonly string[] }) {
  return (
    <details className="dm-details dm-flow-disclosure">
      <summary>{heading}</summary>
      <ul className="dm-flow-rules">
        {rules.map((rule) => (
          <li key={rule}>{rule}</li>
        ))}
      </ul>
    </details>
  )
}

/** The successor geometry the limits imply from the chosen range: the resting sequence drawing beside the real ticks and prices. */
function Geometry({ state, now }: { state: JourneyState; now: number }) {
  const limits = validateLimits(state.limits)
  const price = priceOf(state.pool, now)
  if (!limits.ok || !state.range || !state.pool) return null
  const geometry = successorGeometry(state.range, limits.values, state.pool.tickSpacing)
  const usable = price && price.state === 'usable' ? price : null
  const upper = state.range.upper
  const words = (tick: number) =>
    usable ? CREATE.automation.geometry.words(boundPrice(tick, usable) ?? CREATE.review.summary.beyondDisplay, tick, fromPoolPrice(tick, upper)) : CREATE.automation.geometry.tick(tick)
  return (
    <section aria-labelledby="create-successor-heading" className="dm-flow-geometry" data-successor-geometry="">
      <div className="dm-flow-geometry-art dm-plate dm-dots-plate">
        <SequenceFrame />
      </div>
      <div className="min-w-0">
        <h4 id="create-successor-heading" className="dm-flow-subtitle">
          {CREATE.automation.nextRange}
        </h4>
        {geometry ? (
          <dl className="dm-flow-facts">
            <div>
              <dt>{CREATE.automation.geometry.trigger}</dt>
              <dd className="tnum">{words(geometry.triggerTick)}</dd>
            </div>
            <div>
              <dt>{CREATE.automation.geometry.floor}</dt>
              <dd className="tnum">{words(geometry.floorMinTick)}</dd>
            </div>
            <div>
              <dt>{CREATE.automation.geometry.ceiling}</dt>
              <dd className="tnum">{words(geometry.ceilingTick)}</dd>
            </div>
          </dl>
        ) : (
          // An error sentence in normal type, never a warning colour: the reason is the sentence itself.
          <p className="mt-2 text-caption text-fg-muted" data-successor-geometry-state="infeasible">
            {CREATE.automation.infeasible}
          </p>
        )}
        <p className="dm-hint">
          {CREATE.automation.nextRangeNote} {CREATE.automation.fundingNote}
        </p>
      </div>
    </section>
  )
}

/**
 * Step 4, Automation: what happens to earned fees. Three cards; the two
 * automations wear ROADMAP's status while it says they are not connected.
 * Domino's limits are editable and checked, and the successor geometry they
 * imply is drawn from the chosen range. Nothing here reads anything.
 */
export function StageAutomation({ state, now, onAutomation, onLimits }: { state: JourneyState; now: number; onAutomation: (choice: Automation) => void; onLimits: (limits: Partial<DominoLimits>) => void }) {
  const limits = validateLimits(state.limits)
  return (
    <div className="dm-flow-stack" data-stage="automation">
      <fieldset className="min-w-0">
        <legend className="sr-only">{CREATE.automation.optionsLegend}</legend>
        <div className="dm-flow-options">
          {OPTIONS.map((option) => {
            const words = CREATE.automation.options[option.key]
            const status = automationPill(option.key)
            return (
              <label key={option.key} className="dm-flow-option" data-automation-option={option.key}>
                <span className="dm-flow-option-top">
                  <input type="radio" name="create-automation" value={option.key} checked={state.automation === option.key} onChange={() => onAutomation(option.key)} />
                  <span className="dm-flow-option-title">{words.title}</span>
                </span>
                <span className="dm-flow-option-line">{words.line}</span>
                {status && <Pill className="dm-flow-option-pill">{status}</Pill>}
              </label>
            )
          })}
        </div>
      </fieldset>

      {state.automation === 'none' && <p className="dm-hint">{CREATE.automation.noneDetail}</p>}

      {state.automation === 'compound' && <Rules heading={CREATE.automation.compoundRulesHeading} rules={CREATE.automation.compoundRules} />}

      {state.automation === 'domino' && (
        <section aria-labelledby="create-limits-heading" className="dm-flow-stack">
          <h3 id="create-limits-heading" className="dm-flow-subtitle">
            {CREATE.automation.limitsHeading}
          </h3>
          <div className="dm-flow-limits">
            <TextField id="create-trigger" label={CREATE.automation.trigger} inputMode="decimal" value={state.limits.triggerPercent} onChange={(event) => onLimits({ triggerPercent: event.target.value })} hint={CREATE.automation.triggerHint} error={limits.problems.triggerPercent} trailing="%" min={LIMIT_BOUNDS.trigger.min} max={LIMIT_BOUNDS.trigger.max} />
            <TextField id="create-overlap" label={CREATE.automation.overlap} inputMode="decimal" value={state.limits.maxOverlapPercent} onChange={(event) => onLimits({ maxOverlapPercent: event.target.value })} hint={CREATE.automation.overlapHint} error={limits.problems.maxOverlapPercent} trailing="%" min={LIMIT_BOUNDS.overlap.min} max={LIMIT_BOUNDS.overlap.max} />
            <TextField id="create-cap" label={CREATE.automation.cap} inputMode="numeric" value={state.limits.sequenceCap} onChange={(event) => onLimits({ sequenceCap: event.target.value })} hint={CREATE.automation.capHint} error={limits.problems.sequenceCap} min={LIMIT_BOUNDS.cap.min} max={LIMIT_BOUNDS.cap.max} />
          </div>
          <Geometry state={state} now={now} />
          <Rules heading={CREATE.automation.dominoRulesHeading} rules={CREATE.automation.dominoRules} />
        </section>
      )}
    </div>
  )
}
