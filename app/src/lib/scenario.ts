/**
 * The relative scenario the explanatory sections draw: a position opened at
 * a start price, in a pool of a token against a stablecoin. Every figure is
 * relative to that start, a multiple of its price or a share of its value,
 * so no amount, fee tier or dollar outcome is implied anywhere. The maths is
 * the product's own (core/position); nothing here is a market. (Since round 6
 * Home's simulator draws the pair as ETH and USDG, so its split has names and
 * faces, and reads the price as a move from the start: see SIM below.)
 */
export const RANGES = {
  standard: { key: 'standard', label: 'Closer range', lower: 0.7, upper: 1.5, hint: '0.70× to 1.50× the start price' },
  wide: { key: 'wide', label: 'Wider range', lower: 0.5, upper: 2.0, hint: '0.50× to 2.00× the start price' },
} as const

export type RangeKey = keyof typeof RANGES

export const SCENARIO_MIN = 0.4
export const SCENARIO_MAX = 2.2

/**
 * The size of the position the maths runs on. previewPosition needs one;
 * every figure shown is a ratio to it, so it never reaches the screen and any
 * size would draw the same page.
 */
export const UNIT = 100

/** A price as a multiple of the start price: 1.2 reads 1.20×. */
export const times = (v: number) => `${v.toFixed(2)}×`

/** A fraction of the starting value as a percentage to one place: 0.9842 reads 98.4%. */
export const ofStart = (v: number) => `${(v * 100).toFixed(1)}%`

/** A signed change against the starting value, to two places, with a real minus sign. Zero reads 0.00%. */
export function change(v: number): string {
  const size = Math.abs(v * 100).toFixed(2)
  if (size === '0.00') return '0.00%'
  return `${v > 0 ? '+' : '−'}${size}%`
}

/**
 * The Home simulator's one control (round 6, 2026-09-27: the owner asked for a simulator a newcomer understands at a
 * glance). It runs on a log scale: a notch `v` from −reach to +reach is the price 2^v times the start, so a fall of
 * a third and a rise of a half sit about as far from the start, as they do on a pool's own price scale. The range
 * is the Closer range, 30% below to 50% above the start.
 */
export const SIM = { reach: 1.1, step: 0.01, lower: RANGES.standard.lower, upper: RANGES.standard.upper } as const

/** The price a notch stands for, as a multiple of the start price. */
export const simPrice = (notch: number) => 2 ** notch

/** Where a price sits across the simulator, from 0 at its left end to 1 at its right. */
export const simAt = (price: number) => (Math.log2(price) + SIM.reach) / (2 * SIM.reach)

/** How far a price has moved from the start, in whole percent with a real minus sign: +12%, −8%, and 0% at the start. */
export function moved(price: number): string {
  const pct = Math.round((price - 1) * 100)
  return pct === 0 ? '0%' : `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`
}
