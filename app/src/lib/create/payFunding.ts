import type { PayWith } from './journey'
import { validateBudget } from './journey'
import type { PayFacts, PayOption } from './poolPrices'
import { maxSpend, REVIEW_GAS_RESERVE_WEI } from './reviewPlan'
import { parseScaled, scaledText } from '../format/decimal'
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
  if (!facts || facts.stale || facts.token.chainId !== paid.token.chainId || facts.token.address.toLowerCase() !== paid.token.address.toLowerCase() || facts.raw === null) return { kind: 'unread' }
  const amount = BigInt(typed.raw)
  const native = paid.token.address.toLowerCase() === NATIVE_CURRENCY
  const have = maxSpend(facts.raw, native)
  if (have < amount) return { kind: 'short', have, need: amount }
  if (!native && facts.nativeRaw == null) return { kind: 'unread' }
  if (!native && facts.nativeRaw! < REVIEW_GAS_RESERVE_WEI) return { kind: 'gas' }
  return { kind: 'ready', amount }
}

/** Same-wallet refreshes retain unread local offers, but an observed zero removes them. The hook isolates identities. */
export function unavailablePayFacts(previous: PayFacts | null | undefined): PayFacts | null {
  return previous ? { ...previous, stale: true, alternatives: previous.alternatives?.map((option) => ({ ...option, stale: true })) } : null
}

/** Reconcile only observations for the same hook key; a wallet or selection change supplies no previous value. */
export function reconcilePayFacts(previous: PayFacts | null | undefined, next: PayFacts | null): PayFacts | null {
  if (!previous || !next || previous.token.chainId !== next.token.chainId) return next
  const address = (option: PayOption) => option.token.address.toLowerCase()
  const before = [previous, ...(previous.alternatives ?? [])]
  const current = [next, ...(next.alternatives ?? [])]
  const observed = new Set(next.observedTokens?.map((token) => token.toLowerCase()) ?? [])
  const merge = (option: PayOption): PayOption => {
    const old = before.find((item) => address(item) === address(option))
    if (!old || (option.raw !== null && option.nativeRaw != null)) return option
    return { ...option, raw: option.raw ?? old.raw, nativeRaw: option.nativeRaw ?? old.nativeRaw, usd: option.raw === null ? option.usd ?? old.usd : option.usd, stale: true }
  }
  const options = current.map(merge)
  for (const old of before) {
    if (old.raw !== null && old.raw > 0n && !observed.has(address(old)) && !options.some((option) => address(option) === address(old))) {
      options.push({ ...old, nativeRaw: next.nativeRaw ?? old.nativeRaw, stale: true })
    }
  }
  const retained = options.find((option) => address(option) === address(previous) && option.stale && option.raw !== null && option.raw > 0n)
  const preferred = retained ?? options[0]
  return { ...preferred, observedTokens: next.observedTokens, alternatives: options.filter((option) => address(option) !== address(preferred)) }
}

/** Preserve an indicative USD budget when switching assets. Never a promise of exact output or a larger spend. */
export function paymentEstimate(totalUsd: string | null, facts: PayOption): { raw: bigint; text: string } | null {
  if (!totalUsd || !facts.usd || !/^\d{1,30}(?:\.\d{1,36})?$/.test(totalUsd) || !/^\d{1,30}(?:\.\d{1,36})?$/.test(facts.usd)) return null
  const decimals = facts.token.decimals
  if (decimals === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null
  const total = parseScaled(totalUsd), price = parseScaled(facts.usd)
  if (!total || !price || total.units <= 0n || price.units <= 0n) return null
  const raw = total.units * 10n ** BigInt(price.scale + decimals) / (price.units * 10n ** BigInt(total.scale))
  if (raw <= 0n || raw >= (1n << 128n)) return null
  return { raw, text: scaledText(raw, decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') }
}

/** Prefer a locally fundable budget over another chain's gross wealth. */
export function preferredPayment(facts: PayFacts | null | undefined, totalUsd: string | null): PayOption | null {
  if (!facts) return null
  const options = [facts, ...(facts.alternatives ?? [])]
  const usable = (option: PayOption) => !option.stale && option.raw !== null && maxSpend(option.raw, option.token.address === NATIVE_CURRENCY) > 0n && (option.token.address === NATIVE_CURRENCY || (option.nativeRaw != null && option.nativeRaw >= REVIEW_GAS_RESERVE_WEI))
  const funded = options.find((option) => {
    const estimate = paymentEstimate(totalUsd, option)
    return usable(option) && estimate !== null && option.raw !== null && maxSpend(option.raw, option.token.address === NATIVE_CURRENCY) >= estimate.raw
  })
  return funded ?? options.find(usable) ?? facts
}
