export type Tone = 'neutral' | 'in' | 'out' | 'wait'

/**
 * How a money figure is written.
 *
 * Three rules carried over from the workbench, each of them a correctness
 * requirement rather than a style choice:
 *
 * - A positive amount below one cent is shown to six places, so a real fee is
 *   never displayed as `+$0.00`.
 * - Zero is always neutral, never green or red.
 * - The sign and the tone are both present, so colour is never the only cue.
 */
export function decimalsFor(value: number, exact = false): number {
  const abs = Math.abs(value)
  return exact || (abs > 0 && abs < 0.01) ? 6 : 2
}

export function toneFor(value: number, requested: Tone): Tone {
  return value === 0 ? 'neutral' : requested
}

export function signFor(tone: Tone): string {
  if (tone === 'in') return '+'
  if (tone === 'out') return '−'
  return ''
}

/** The complete rendered figure, sign included. */
export function formatAmount(
  value: number | string,
  { tone = 'neutral' as Tone, exact = false, prefix = '$' } = {},
): string {
  const n = typeof value === 'string' ? Number(value) : value
  const effective = toneFor(n, tone)
  const places = decimalsFor(n, exact)
  const body = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  })
  return `${signFor(effective)}${prefix}${body}`
}
