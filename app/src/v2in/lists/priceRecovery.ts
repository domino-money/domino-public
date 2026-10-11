import type { PortfolioResponse } from 'api-contracts/read-v6/types'

/** A targeted survey can fill the existing backend price cache when a portfolio exhausted its shared read budget. */
export interface PriceRecoveryTarget { wallet: string; chainId: 4663 | 8453 | 42161; address: string }
const TRANSIENT = new Set(['price_read_failed', 'pricing_limit_reached'])
const PER_PASS = 3
const PER_WALLET = 6
const MAX_WALLETS = 8

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
  /** Uses the existing deduplicated chain-pools route; true only when this exact token is now qualified. */
  warm(target: PriceRecoveryTarget, active: () => boolean): Promise<boolean>
  refresh(wallet: string): void
}) {
  const tried = new Map<string, Set<string>>()
  const running = new Set<string>()
  return {
    async run(answer: PortfolioResponse, active: () => boolean): Promise<void> {
      const wallet = answer.wallet.toLowerCase()
      if (!active() || running.has(wallet)) return
      const attempts = tried.get(wallet) ?? new Set<string>()
      const targets = priceRecoveryTargets(answer).filter(target => !attempts.has(`${target.chainId}:${target.address}`))
        .slice(0, Math.min(PER_PASS, PER_WALLET - attempts.size))
      if (!targets.length) return
      tried.set(wallet, attempts)
      while (tried.size > MAX_WALLETS) tried.delete(tried.keys().next().value!)
      running.add(wallet)
      let qualified = false
      try {
        for (const target of targets) {
          if (!active()) break
          // A failure is not a reason to start a loop. Normal portfolio polling can still recover on its own.
          attempts.add(`${target.chainId}:${target.address}`)
          if (await deps.warm(target, active).catch(() => false)) qualified = true
        }
        // The new coherent portfolio supplies every amount and price; never splice a target price into older amounts.
        if (qualified && active()) deps.refresh(wallet)
      } finally { running.delete(wallet) }
    },
  }
}
