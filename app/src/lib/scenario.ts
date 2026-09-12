/**
 * The relative scenario the explanatory sections draw: a position opened at
 * a start price, in a pool of a token against a stablecoin. Every figure is
 * relative to that start, a multiple of its price or a share of its value,
 * so no pair, amount, fee tier or dollar outcome is implied anywhere. The
 * maths is the product's own (core/position); nothing here is a market.
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
