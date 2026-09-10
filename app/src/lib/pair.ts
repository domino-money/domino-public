/**
 * The example pair and range presets used by the practice workspace.
 * These values mirror the workbench so both apps describe the same thing.
 */
export const PAIR = {
  token: 'MEME',
  stable: 'USDG',
  label: 'MEME / USDG',
  startPrice: 1,
  /** LP fee tier of the example pool, in pips (1,000,000 = 100%). */
  feePips: 10000,
  note: 'Robinhood Chain · example pair',
} as const

export const feeTier = (pips: number) => `${(pips / 10_000).toFixed(2)}%`

export const RANGES = {
  standard: { key: 'standard', label: 'Closer range', lower: 0.7, upper: 1.5, hint: '$0.70 to $1.50' },
  wide: { key: 'wide', label: 'Wider range', lower: 0.5, upper: 2.0, hint: '$0.50 to $2.00' },
} as const

export type RangeKey = keyof typeof RANGES

export const SCENARIO_MIN = 0.4
export const SCENARIO_MAX = 2.2

/** Position of a price on the scenario scale, as a percentage. */
export const scale = (v: number) =>
  ((v - SCENARIO_MIN) / (SCENARIO_MAX - SCENARIO_MIN)) * 100

/** Accepts a non-negative decimal with at most six places, matching moneyUnits. */
export const isMoney = (v: string) => /^\d{1,9}(\.\d{1,6})?$/.test(v.trim())
