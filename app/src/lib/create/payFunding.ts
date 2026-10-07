import type { PayWith } from './journey'
import { validateBudget } from './journey'
import type { PayFacts } from './poolPrices'
import { maxSpend } from './reviewPlan'
import { NATIVE_CURRENCY } from '../read/screens/identity'

export type PayFunding =
  | { kind: 'wait' }
  | { kind: 'unread' }
  | { kind: 'short'; have: bigint; need: bigint }
  | { kind: 'gas' }
  | { kind: 'ready'; amount: bigint }

/** A typed external-token amount is never a balance. Unknown is not zero or permission to continue. */
export function payFunding(paid: PayWith, facts: PayFacts | null | undefined): PayFunding {
  const typed = validateBudget(paid.text, paid.token.decimals)
  if (!typed.ok || facts === undefined) return { kind: 'wait' }
  if (!facts || facts.token.chainId !== paid.token.chainId || facts.token.address.toLowerCase() !== paid.token.address.toLowerCase() || facts.raw === null) return { kind: 'unread' }
  const amount = BigInt(typed.raw)
  const native = paid.token.address.toLowerCase() === NATIVE_CURRENCY
  const have = maxSpend(facts.raw, native)
  if (have < amount) return { kind: 'short', have, need: amount }
  if (!native && facts.nativeRaw == null) return { kind: 'unread' }
  if (!native && facts.nativeRaw === 0n) return { kind: 'gas' }
  return { kind: 'ready', amount }
}
