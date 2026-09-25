/**
 * Where a Domino-compound sequence's next positions can stand, from its root
 * position and the limits the owner is choosing (DESIGN-V2 §14.2, automate.md
 * §5.5.5). It mirrors DominoRoutingHelperV4.nearCeiling and validateSuccessor
 * in log-price space, honouring the chosen orientation and the live upside:
 *
 * - inverse = the base is currency1 (the contract's `baseCurrency == currency1`);
 * - a successor's ceiling is the first spacing tick at least `upside` above the
 *   previous ceiling;
 * - its floor may reach down to the lowest spacing tick within `overlap` of
 *   that previous ceiling;
 * - it becomes eligible when the price is within `trigger` of the ceiling.
 *
 * Positions are aligned to their tick spacing, so the relative picture (and
 * every percentage here) is the same in both orientations; only the raw ticks
 * differ. The contract's sqrt-price floor rounding moves a tick by at most one,
 * which a drawing cannot show. Pure and Node-safe: no DOM, no chain, no clock.
 */

/** ln(1.0001): one tick in log price. */
export const LOG_TICK = Math.log(1.0001)
const MAX_TICK = 887272

export interface SuccessorRoot {
  lower: number
  upper: number
  spacing: number
}

export interface SuccessorLimits {
  /** Successor upside, % of the previous ceiling (0.01–10,000). */
  upside: number
  /** Maximum overlap, % (0–20). */
  overlap: number
  /** Trigger distance, % (0–20). */
  trigger: number
  /** Positions in the sequence, including the root (1–255). */
  cap: number
}

/** One successor: its anchor (the previous ceiling), its ceiling and its lowest allowed floor; ticks raw, positions as log price relative to the root's ceiling. */
export interface SuccessorStep {
  anchorTick: number
  ceilingTick: number
  floorMinTick: number
  anchor: number
  ceiling: number
  floorMin: number
  feasible: boolean
}

export interface SuccessorPlan {
  inverse: boolean
  /** The root's floor, log price relative to its ceiling (always < 0). */
  floor: number
  triggerTick: number
  trigger: number
  steps: SuccessorStep[]
  /** Successors past the drawn ones. */
  more: number
}

/** A log price relative to the root ceiling, as a percentage change. */
export const percentOf = (rel: number) => (Math.exp(rel) - 1) * 100

/** `+153.5%`, `−5%`, `0%`: one decimal at most, a true minus sign, no sign on zero. */
export function signedPercent(rel: number): string {
  const value = Math.round(percentOf(rel) * 10) / 10
  if (value === 0 || Object.is(value, -0)) return '0%'
  const text = Math.abs(value).toFixed(Number.isInteger(value) ? 0 : 1)
  return `${value > 0 ? '+' : '−'}${text}%`
}

/**
 * The plan for `root` under `limits`, drawing at most `draw` successors, or
 * null when the inputs are not a position and limits the contract could take.
 */
export function successorPlan(root: SuccessorRoot, limits: SuccessorLimits, inverse: boolean, draw = 3): SuccessorPlan | null {
  const { lower, upper, spacing: s } = root
  const { upside, overlap, trigger, cap } = limits
  if (![lower, upper, s, upside, overlap, trigger, cap].every(Number.isFinite)) return null
  if (s <= 0 || lower >= upper || upside <= 0 || overlap < 0 || overlap > 20 || trigger < 0 || trigger > 20 || cap < 1) return null
  const min = Math.ceil(-MAX_TICK / s) * s
  const max = Math.floor(MAX_TICK / s) * s
  const clamp = (tick: number) => Math.min(max, Math.max(min, tick))
  // Upward in the chosen orientation is a higher raw tick, or a lower one when inverse.
  const dir = inverse ? -1 : 1
  const ceil0 = inverse ? lower : upper
  const rel = (tick: number) => dir * (tick - ceil0) * LOG_TICK
  const snap = (tick: number) => (inverse ? Math.floor(tick / s) : Math.ceil(tick / s)) * s || 0
  const up = Math.log(1 + upside / 100) / LOG_TICK
  const down = Math.log(1 - overlap / 100) / LOG_TICK
  const steps: SuccessorStep[] = []
  let anchorTick = ceil0
  for (let i = 0; i < Math.min(cap - 1, draw); i++) {
    const ceilingTick = clamp(snap(anchorTick + dir * up))
    const floorMinTick = clamp(snap(anchorTick + dir * down))
    const step = { anchorTick, ceilingTick, floorMinTick, anchor: rel(anchorTick), ceiling: rel(ceilingTick), floorMin: rel(floorMinTick), feasible: false }
    step.feasible = step.ceiling > step.anchor && step.floorMin < step.ceiling
    steps.push(step)
    if (!step.feasible) break
    anchorTick = ceilingTick
  }
  const triggerTick = clamp(Math.round(ceil0 + dir * (Math.log(1 - trigger / 100) / LOG_TICK)))
  return {
    inverse,
    floor: rel(inverse ? upper : lower),
    triggerTick,
    trigger: rel(triggerTick),
    steps,
    more: Math.max(0, cap - 1 - steps.length),
  }
}
