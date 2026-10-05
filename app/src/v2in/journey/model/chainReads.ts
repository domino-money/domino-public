import type { ChainBalancesResponse, ChainPoolsResponse, ChainTokensResponse, LivePool, LiveToken } from 'api-contracts/read-v6/types'
import { rawFromFact, type CurrencyBalance } from '../../../lib/create/budgets'
import type { NetworkResolved, NetworkToken, OtherChainId } from '../../../lib/create/otherChains'
import { amountFact } from '../../../lib/read/pagers'
import { poolIdKey } from '../../../lib/read/screens/identity'
import type { PoolOption } from '../../../lib/read/screens/poolsList'
import type { TokenDisplay } from '../../../lib/read/types'
import { v2Chain } from '../../../v2/chains'
import { ZERO_ADDRESS, type Address, type PoolRef } from '../../../v2/types'
import { JOURNEY_USD_SHOWN } from '../constants'
import { JOURNEY } from '../copy'
import { cleanSymbol, profileTokens } from '../tokens'
import { displayOf, poolRow } from './networks'
import { offeredPool, tiersOf } from './pools'

/**
 * Base and Arbitrum One read by Domino's service (2026-10-06, rugged97's delta of 5 Oct, items 1-3: read-v6's live chain
 * reads chain-pools, chain-balances and chain-tokens, api-contracts/read-v6 README "Chain reads"): what is pure of it. The
 * answers, already checked against the contract (src/v2/read/v6.ts), become today's search rows, pool rows and balances,
 * so the wallet stays where it is until a step asks it to sign (spec F7 §1.3). No wallet, no React, no clock of its own.
 */

/** How well a symbol matches the text typed: 0 exact, 1 a prefix, 2 inside it, 3 not at all (a name or address hit). */
export function symbolRank(symbol: string | null, query: string): number {
  const needle = query.trim().toLowerCase()
  const label = (symbol ?? '').toLowerCase()
  if (!label || !needle) return 3
  if (label === needle) return 0
  if (label.startsWith(needle)) return 1
  return label.includes(needle) ? 2 : 3
}

/**
 * Whether a token passes for one of the network's own currencies (ETH, WETH, USDC) without being it: its symbol is theirs
 * and its address is not. Such a token is listed with a warning and never chosen (as today's search does on Robinhood
 * Chain, its rule I1): a symbol is anyone's to write.
 */
export function lookalikeOf(chainId: OtherChainId, token: { address: string; symbol: string | null }): string | null {
  const symbol = (token.symbol ?? '').trim().toLowerCase()
  if (!symbol) return null
  const own = profileTokens(chainId).find((entry) => (entry.symbol ?? '').toLowerCase() === symbol)
  return own && own.address !== token.address.toLowerCase() ? (own.symbol ?? null) : null
}

/** A chain-tokens answer as the search's rows for that network (pure), in the answer's own order. */
export function rowsOfTokens(chainId: OtherChainId, answer: ChainTokensResponse): NetworkToken[] {
  const network = v2Chain(chainId).name
  return answer.tokens.map((token): NetworkToken => {
    const shown = displayOf(chainId, { address: token.address.toLowerCase() as Address, symbol: cleanSymbol(token.symbol), decimals: token.decimals })
    const main = lookalikeOf(chainId, shown)
    return { chainId, network, token: shown, unread: false, ...(main ? { warning: JOURNEY.pool.lookalike(main) } : {}) }
  })
}

/** A token as a chain-pools answer read it, as a screen shows it: the network's own currencies as the profile names them. */
function tokenOf(chainId: OtherChainId, live: LiveToken): TokenDisplay {
  const address = live.address.toLowerCase() as Address
  const own = profileTokens(chainId).find((entry) => entry.address === address)
  return displayOf(chainId, own ?? { address, symbol: cleanSymbol(live.symbol), decimals: live.decimals })
}

/** The token a pasted address names on its network, from the chain-pools answer about it (pure), or why it cannot be used. */
export function resolvedOf(chainId: OtherChainId, address: string, answer: ChainPoolsResponse): NetworkResolved {
  const live = answer.tokens.find((token) => token.address.toLowerCase() === address.toLowerCase())
  if (!live || live.decimals === null) return { ok: false, code: 'token_decimals_unknown', reason: JOURNEY.pool.decimalsUnknown }
  return { ok: true, token: tokenOf(chainId, live) }
}

/** Whether a pool of the answer is one Domino can open a position in: hookless, on a tier the network offers for its version. */
function openable(chainId: OtherChainId, pool: PoolRef): boolean {
  return offeredPool(pool) && tiersOf(chainId, pool.dex).some((tier) => tier.fee === pool.fee && tier.tickSpacing === pool.tickSpacing)
}

/** A pool's key on screen: v4's pool id, or a v3 pool's address as a 32-byte word (lib/read/screens/poolsList.ts `dex`). */
function keyOf(live: LivePool) {
  if (live.pool.dex === 4 && live.id !== null) return poolIdKey(live.id)
  if (live.pool.dex === 3 && live.address !== null) return poolIdKey(`0x${'0'.repeat(24)}${live.address.slice(2)}`)
  return null
}

/**
 * A chain-pools answer's pools as today's pool rows (pure): the ones a position can open in, in the answer's order (ETH and
 * WETH partners first, then the dollar, then the most liquidity in range). `chosen` is the token as the journey holds it,
 * kept as it is on its own rows. `receivedAt`: when the answer arrived, on the page's clock.
 */
export function poolsOfAnswer(chainId: OtherChainId, chosen: TokenDisplay | null, answer: ChainPoolsResponse, receivedAt: number): PoolOption[] {
  const readAt = receivedAt - answer.freshness.ageSeconds * 1000
  const display = (address: string): TokenDisplay | null => {
    const key = address.toLowerCase()
    if (chosen && chosen.address.toLowerCase() === key) return chosen
    const live = answer.tokens.find((token) => token.address.toLowerCase() === key)
    return live ? tokenOf(chainId, live) : null
  }
  return answer.pools.flatMap((live) => {
    const key = keyOf(live)
    const first = display(live.pool.currency0)
    const second = display(live.pool.currency1)
    if (!key || !first || !second || !openable(chainId, live.pool as PoolRef)) return []
    return [poolRow({ pool: live.pool as PoolRef, key, tick: live.tick, sqrtPriceX96: live.sqrtPriceX96, block: answer.snapshot.number, usdPrices: pricesOf(answer, live.pool) }, [first, second], readAt)]
  })
}

/**
 * Each currency's USD price as the answer read it (read-v6 1.1.0-rc.1's qualified USD, rugged97's item 4), in pool order;
 * null for one without a price. None at all while the journey shows no USD (JOURNEY_USD_SHOWN).
 */
function pricesOf(answer: ChainPoolsResponse, pool: { currency0: string; currency1: string }): readonly [string | null, string | null] | undefined {
  if (!JOURNEY_USD_SHOWN) return undefined
  const price = (address: string) => answer.tokens.find((token) => token.address.toLowerCase() === address.toLowerCase())?.price?.usd ?? null
  return [price(pool.currency0), price(pool.currency1)]
}

/** Whether two pools are the same pool: version, pair, fee, spacing and hooks. */
export const samePool = (a: PoolRef, b: PoolRef): boolean =>
  a.dex === b.dex && a.currency0.toLowerCase() === b.currency0.toLowerCase() && a.currency1.toLowerCase() === b.currency1.toLowerCase() &&
  a.fee === b.fee && a.tickSpacing === b.tickSpacing && a.hooks.toLowerCase() === b.hooks.toLowerCase()

/** The pool on screen as a chain-pools answer about its pair reads it now (pure), or null when it is not listed any more. */
export function rereadOf(option: PoolOption, ref: PoolRef, answer: ChainPoolsResponse, receivedAt: number): PoolOption | null {
  const live = answer.pools.find((entry) => samePool(entry.pool as PoolRef, ref))
  const key = live ? keyOf(live) : null
  if (!live || !key) return null
  return poolRow({ pool: ref, key, tick: live.tick, sqrtPriceX96: live.sqrtPriceX96, block: answer.snapshot.number, usdPrices: pricesOf(answer, ref) }, option.currencies, receivedAt - answer.freshness.ageSeconds * 1000)
}

/** The tokens to ask chain-balances about for a pool's two currencies: native ETH is the zero address there too. */
export const balanceTokens = (chainId: OtherChainId, currencies: readonly TokenDisplay[]) =>
  currencies.map((currency) => ({ chainId, address: currency.address.toLowerCase() === ZERO_ADDRESS ? ZERO_ADDRESS : currency.address.toLowerCase() }))

/**
 * A pool's two balances from a chain-balances answer (pure), in pool order, or null when that network could not be read
 * (the journey then says the balances are unread, never zero). A balance the call could not read has no figure.
 */
export function balancesOfAnswer(chainId: OtherChainId, currencies: readonly [TokenDisplay, TokenDisplay], answer: ChainBalancesResponse): readonly [CurrencyBalance, CurrencyBalance] | null {
  const chain = answer.chains.find((entry) => entry.chainId === chainId)
  if (!chain || chain.status !== 'current') return null
  const of = (token: TokenDisplay): CurrencyBalance => {
    const read = chain.balances.find((entry) => entry.address.toLowerCase() === token.address.toLowerCase())
    if (!read || read.status !== 'read' || read.balanceRaw === null) return { token, fact: null, raw: null }
    const fact = amountFact({ amountRaw: read.balanceRaw, decimals: token.decimals })
    return { token, fact, raw: rawFromFact(fact, token.decimals) }
  }
  return [of(currencies[0]), of(currencies[1])]
}
