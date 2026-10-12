import type { PortfolioResponse } from 'api-contracts/read-v6/types'

/** A targeted survey can fill the existing backend price cache when a portfolio exhausted its shared read budget. */
export interface PriceRecoveryTarget { wallet: string; chainId: 4663 | 8453 | 42161; address: string }
const TRANSIENT = new Set(['price_read_failed', 'pricing_limit_reached'])
const PER_PASS = 3
const PER_WINDOW = 6
const WINDOW_MS = 5 * 60_000
const RETRY_MS = 60_000
const MAX_WALLETS = 8
const MAX_TARGETS = 128
export type PriceRecoveryResult = { kind: 'qualified' | 'unavailable' | 'cancelled' } | { kind: 'retry'; afterMs?: number }

export function priceRecoveryTargets(answer: PortfolioResponse): PriceRecoveryTarget[] {
  const wanted = new Map<string, PriceRecoveryTarget>()
  for (const position of answer.positions) {
    const state = position.state, chainId = position.chainId
    if (![4663, 8453, 42161].includes(chainId) || state.status !== 'live' || state.freshness.status !== 'fresh'
      || answer.chains.find(chain => chain.chainId === chainId)?.status !== 'current') continue
    for (const [index, address] of [state.pool.currency0, state.pool.currency1].entries()) {
      if (BigInt(state.principalAtSpot[index] ?? '0') === 0n && BigInt(state.feesOwed[index] ?? '0') === 0n) continue
      const token = answer.tokens.find(token => token.chainId === chainId && token.address === address)
      if (!token || token.price || token.decimals === null || !TRANSIENT.has(token.priceReason ?? '')) continue
      const target = { wallet: answer.wallet.toLowerCase(), chainId: chainId as PriceRecoveryTarget['chainId'], address: address.toLowerCase() }
      wanted.set(`${chainId}:${target.address}`, target)
    }
  }
  // Give each affected chain one slot before taking a second token from a chain.
  const first: PriceRecoveryTarget[] = [], rest: PriceRecoveryTarget[] = [], seen = new Set<number>()
  for (const target of wanted.values()) {
    if (seen.has(target.chainId)) rest.push(target)
    else { seen.add(target.chainId); first.push(target) }
  }
  return [...first, ...rest]
}

export function createPriceRecovery(deps: {
  /** Uses the existing deduplicated chain-pools route; only this exact token can qualify. */
  warm(target: PriceRecoveryTarget, active: () => boolean): Promise<PriceRecoveryResult>
  refresh(wallet: string): void
  now?(): number
}) {
  type Attempt = { at: number; next: number; failures: number }
  const kept = new Map<string, { attempts: Map<string, Attempt>; starts: number[] }>()
  const running = new Set<string>()
  const now = deps.now ?? Date.now
  let notBefore = 0
  return {
    async run(answer: PortfolioResponse, active: () => boolean): Promise<void> {
      const wallet = answer.wallet.toLowerCase()
      if (!active() || running.has(wallet)) return
      const state = kept.get(wallet) ?? { attempts: new Map<string, Attempt>(), starts: [] }
      const time = now()
      state.starts = state.starts.filter(at => time - at < WINDOW_MS)
      if (time < notBefore) return
      const key = (target: PriceRecoveryTarget) => `${target.chainId}:${target.address}`
      const targets = priceRecoveryTargets(answer).filter(target => (state.attempts.get(key(target))?.next ?? 0) <= time)
        // A large portfolio's later tokens get their turn when the rolling budget opens again.
        .sort((a, b) => (state.attempts.get(key(a))?.at ?? -Infinity) - (state.attempts.get(key(b))?.at ?? -Infinity))
        .slice(0, Math.min(PER_PASS, PER_WINDOW - state.starts.length))
      if (!targets.length) return
      kept.delete(wallet)
      kept.set(wallet, state)
      while (kept.size > MAX_WALLETS) kept.delete(kept.keys().next().value!)
      running.add(wallet)
      let qualified = false
      try {
        for (const target of targets) {
          if (!active() || now() < notBefore) break
          const id = key(target), at = now(), prior = state.attempts.get(id)
          // Charge the attempt even if navigation interrupts it: the shared request may already be in flight.
          state.starts.push(at)
          const attempt = { at, next: at + RETRY_MS, failures: prior?.failures ?? 0 }
          state.attempts.delete(id)
          state.attempts.set(id, attempt)
          while (state.attempts.size > MAX_TARGETS) state.attempts.delete(state.attempts.keys().next().value!)
          const result = await deps.warm(target, active).catch((): PriceRecoveryResult => ({ kind: 'retry' }))
          if (result.kind === 'qualified') { qualified = true; attempt.failures = 0; attempt.next = now() + RETRY_MS }
          else if (result.kind !== 'cancelled') {
            attempt.failures++
            attempt.next = now() + (result.kind === 'unavailable' ? WINDOW_MS : Math.min(WINDOW_MS, RETRY_MS * 2 ** Math.min(attempt.failures - 1, 3)))
          }
          // Retry-After names the reader lane's next token, not just this currency's next attempt.
          if (result.kind === 'retry' && Number.isFinite(result.afterMs) && result.afterMs! > 0) {
            notBefore = Math.max(notBefore, now() + result.afterMs!)
            attempt.next = Math.max(attempt.next, notBefore)
            break
          }
        }
        // The new coherent portfolio supplies every amount and price; never splice a target price into older amounts.
        if (qualified && active()) deps.refresh(wallet)
      } finally { running.delete(wallet) }
    },
  }
}
