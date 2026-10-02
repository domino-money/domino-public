/**
 * New position's figures in plain words (round 6, 2026-09-27, the owner: the flow is for people who know nothing
 * about liquidity pools). No "≈" on the steps, and a bound's distance from today's price as a side and a rounded
 * percentage ("30% below today") rather than a signed figure. Pure helpers: nothing here reads or renders.
 */
import { numberFormat } from '../format/numberFormat'

/** A price the read writes with a leading "≈" (every tick price is approximate), as the steps show it: the figure alone. */
export const plainFigure = (text: string): string => text.replace(/^≈/, '')

export interface Away {
  side: 'below' | 'above' | 'at'
  /** Rounded for reading: one decimal under 10%, whole percent from there ("0.5%", "30%", "1,200%"). */
  percent: string
}

/** How far the price at `tick` sits from the pool's price at `poolTick`, as a side and a rounded percentage. */
export function awayFrom(tick: number, poolTick: number): Away {
  const change = (Math.pow(1.0001, tick - poolTick) - 1) * 100
  const size = Math.abs(change)
  if (size < 0.05) return { side: 'at', percent: '0%' }
  const percent = `${numberFormat({ maximumFractionDigits: size < 10 ? 1 : 0 }).format(size)}%`
  return { side: change < 0 ? 'below' : 'above', percent }
}

/**
 * The same distance, short, for the range's slider and picture ("−30%", "+51%"), with the same rounding as the words
 * beside it: the preview's picture wrote "−30.1%" beside the step's "30% below today" until 2026-09-28 (round 6).
 */
export function awayShort(tick: number, poolTick: number): string {
  const away = awayFrom(tick, poolTick)
  return away.side === 'at' ? '0%' : `${away.side === 'below' ? '−' : '+'}${away.percent}`
}
