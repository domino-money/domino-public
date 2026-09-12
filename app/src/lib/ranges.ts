/**
 * The two range presets the pool screens offer, as multiples of the pool's
 * current price.
 *
 * They describe a shape, not a pair: 0.7–1.5 is "closer", 0.5–2.0 is "wider",
 * whatever the pool and whatever its price is when read. The example pair they
 * used to live beside is gone with the practice workspace, and nothing here
 * names a token, a price or a figure of its own.
 */
export const RANGES = {
  standard: { key: 'standard', label: 'Closer range', lower: 0.7, upper: 1.5, hint: '0.7x to 1.5x the current price' },
  wide: { key: 'wide', label: 'Wider range', lower: 0.5, upper: 2.0, hint: '0.5x to 2x the current price' },
} as const

export type RangeKey = keyof typeof RANGES
