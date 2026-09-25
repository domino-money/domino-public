import { SEQUENCE_DEFAULTS, sequenceOptionsFrom, type SequenceForm } from '../create/sequenceDefaults'

/**
 * Why one limit field would be refused, in the words the creation already
 * uses (sequenceOptionsFrom), or null. Every other field stays at its default,
 * which is valid, so the only reason that can come back is this field's own.
 * Presentation only: Review the wallet steps still checks the whole form.
 */
export function fieldCheck(name: keyof SequenceForm, text: string): string | null {
  const check = sequenceOptionsFrom('domino', 1n, true, { ...SEQUENCE_DEFAULTS, [name]: text })
  return check.ok ? null : check.reason
}
