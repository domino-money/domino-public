/**
 * The slippage tolerance as the amount step chooses it: a percentage dragged
 * along a track. What is kept and sent is still whole basis points
 * (JourneyState.slippageBps, which validateSlippage decides); nothing here
 * changes that contract. It only maps between a position on the track, the
 * basis points behind it and the percentage written on screen.
 */

/** The ends of the track, in basis points: 0.1% to 5%. */
export const SLIPPAGE_MIN_BPS = 10
export const SLIPPAGE_MAX_BPS = 500

/** The marks on the track, in basis points: 0.1%, 0.5% and 1%. */
export const SLIPPAGE_MARKS = [10, 50, 100] as const

/** How near a mark the thumb may be let go and still take it, in basis points. */
const SNAP_BPS = 4

function buildSteps(): number[] {
  const steps: number[] = []
  for (let bps = SLIPPAGE_MIN_BPS; bps < 100; bps += 1) steps.push(bps)
  for (let bps = 100; bps <= SLIPPAGE_MAX_BPS; bps += 5) steps.push(bps)
  return steps
}

/**
 * Every value the thumb can take, in basis points: hundredths of a percent up
 * to 1%, twentieths from there to 5%. The positions are evenly spaced, so the
 * tolerances people choose between take half the track instead of a tenth of
 * it, and each arrow key press still moves to a different value.
 */
export const SLIPPAGE_STEPS: readonly number[] = buildSteps()

/**
 * A whole number of basis points as its percentage, without the sign: 50 is
 * "0.5", 500 is "5". Basis points are hundredths of a percent, so this is the
 * decimal point moved two places, never a division a float could round.
 */
export function slippagePercent(bps: number): string {
  const fraction = String(bps % 100).padStart(2, '0').replace(/0+$/, '')
  return fraction === '' ? String(Math.trunc(bps / 100)) : `${Math.trunc(bps / 100)}.${fraction}`
}

/** The same percentage as it is written on screen: 50 is "0.5%". */
export const slippageWritten = (bps: number): string => `${slippagePercent(bps)}%`

/** The kept value in basis points. Anything outside the ends takes the nearer end, since the track cannot draw it. */
export function slippageValue(text: string): number {
  const bps = Number(text)
  if (!Number.isFinite(bps)) return SLIPPAGE_MIN_BPS
  return Math.min(SLIPPAGE_MAX_BPS, Math.max(SLIPPAGE_MIN_BPS, Math.round(bps)))
}

/** The position on the track a value sits at: the nearest step to it. */
export function slippageIndex(bps: number): number {
  let best = 0
  for (let index = 1; index < SLIPPAGE_STEPS.length; index += 1) {
    if (Math.abs(SLIPPAGE_STEPS[index] - bps) < Math.abs(SLIPPAGE_STEPS[best] - bps)) best = index
  }
  return best
}

/** The mark a thumb let go here takes, or null when it is not beside one. */
export function slippageMark(bps: number): number | null {
  const mark = SLIPPAGE_MARKS.find((value) => Math.abs(bps - value) <= SNAP_BPS)
  return mark === undefined || mark === bps ? null : mark
}

const PERCENT_TEXT = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/

/** A typed percentage as whole basis points inside the ends, or null when it is neither. */
export function slippageFromPercent(text: string): number | null {
  const match = PERCENT_TEXT.exec(text)
  if (!match) return null
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return bps >= SLIPPAGE_MIN_BPS && bps <= SLIPPAGE_MAX_BPS ? bps : null
}
