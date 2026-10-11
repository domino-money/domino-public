import type { PortfolioResponse, Position, IndexedToken } from 'api-contracts/read-v6/types'
import { rawAmounts, usdOfRaw } from '../usd'

/** A brief read interruption can keep an unchanged complete valuation, never reprice new amounts with old prices. */
export const POSITION_USD_MEMORY_MS = 90_000
const TRANSIENT = new Set(['price_read_failed', 'pricing_limit_reached'])
type Portfolio = Pick<PortfolioResponse, 'wallet' | 'servedAt' | 'chains' | 'positions' | 'tokens'>
type Identity = Pick<Position, 'chainId' | 'positionManager' | 'tokenId'>
export interface PositionValuation { value: string; fees: string; at: number; saved: boolean }
interface Snapshot extends PositionValuation { fingerprint: string; until: number }
const keyOf = (wallet: string, p: Identity) => `${wallet.toLowerCase()}:${p.chainId}:${p.positionManager.toLowerCase()}:${p.tokenId}`
const exact = (p: Position, tokens: readonly IndexedToken[]) => p.state.status === 'live' ? JSON.stringify([
  p.state.owner, p.state.pool, p.state.tickLower, p.state.tickUpper, p.state.liquidity, p.state.principalAtSpot, p.state.feesOwed,
  tokens.map(token => [token.address, token.decimals]),
]) : null

export function createPositionValuations(now: () => number = () => Date.now()) {
  const kept = new Map<string, Snapshot>()
  function record(answer: Portfolio) {
    const time = now()
    for (const [key, value] of kept) if (value.until <= time) kept.delete(key)
    for (const position of answer.positions) {
      const key = keyOf(answer.wallet, position), state = position.state
      const current = state.status === 'live' && state.freshness.status === 'fresh'
        && answer.chains.find(chain => chain.chainId === position.chainId)?.status === 'current'
      if (!current || state.status !== 'live') { kept.delete(key); continue }
      const tokens = [state.pool.currency0, state.pool.currency1].map(address => answer.tokens.find(token => token.chainId === position.chainId && token.address === address))
      if (tokens.some(token => !token)) { kept.delete(key); continue }
      const pair = tokens as [IndexedToken, IndexedToken]
      const fingerprint = exact(position, pair)!
      const prior = kept.get(key)
      if (prior?.fingerprint !== fingerprint) kept.delete(key)
      const valueOf = (amounts: readonly string[]) => {
        const raw = rawAmounts(amounts)
        return raw?.length === 2 ? usdOfRaw(raw.map((raw, index) => ({ raw, decimals: pair[index].decimals, usd: pair[index].price?.usd }))) : null
      }
      const value = valueOf(state.principalAtSpot), fees = valueOf(state.feesOwed)
      if (value === null || fees === null) {
        // Explicit disqualification supersedes an earlier price. Only an unread source permits a short cached display.
        if (pair.some((token, index) => (BigInt(state.principalAtSpot[index] ?? '0') > 0n || BigInt(state.feesOwed[index] ?? '0') > 0n)
          && (!token.price && !TRANSIENT.has(token.priceReason ?? '')))) kept.delete(key)
        continue
      }
      const at = Math.min(time, answer.servedAt * 1000)
      const until = Math.min(at + POSITION_USD_MEMORY_MS, ...pair.flatMap(token => token.price?.snapshot ? [token.price.snapshot.timestamp * 1000 + POSITION_USD_MEMORY_MS] : []))
      if (until <= time) { kept.delete(key); continue }
      kept.delete(key)
      kept.set(key, { value, fees, at, saved: false, fingerprint, until })
    }
    while (kept.size > 128) kept.delete(kept.keys().next().value!)
  }
  function get(answer: Portfolio, identity: Identity): PositionValuation | null {
    const position = answer.positions.find(p => p.chainId === identity.chainId && p.positionManager.toLowerCase() === identity.positionManager.toLowerCase() && p.tokenId === identity.tokenId)
    if (!position || position.state.status !== 'live' || position.state.freshness.status !== 'fresh'
      || answer.chains.find(chain => chain.chainId === position.chainId)?.status !== 'current') return null
    const state = position.state
    const pair = [state.pool.currency0, state.pool.currency1].map(address => answer.tokens.find(token => token.chainId === identity.chainId && token.address === address))
    if (pair.some(token => !token)) return null
    const entry = kept.get(keyOf(answer.wallet, identity))
    if (!entry || entry.until <= now() || entry.fingerprint !== exact(position, pair as IndexedToken[])) return null
    const missing = pair.some(token => !token?.price)
    if (!missing) return null // Current qualified USD is always calculated from the current answer by the caller.
    if (pair.some((token, index) => (BigInt(state.principalAtSpot[index] ?? '0') > 0n || BigInt(state.feesOwed[index] ?? '0') > 0n)
      && (!token?.price && !TRANSIENT.has(token?.priceReason ?? '')))) return null
    return { value: entry.value, fees: entry.fees, at: entry.at, saved: true }
  }
  return { record, get }
}

export const POSITION_VALUATIONS = createPositionValuations()
