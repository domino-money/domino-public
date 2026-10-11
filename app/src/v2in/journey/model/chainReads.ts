import type { ChainBalancesResponse, ChainPoolsResponse, ChainTokensResponse, LivePool, LiveToken } from 'api-contracts/read-v6/types'
import { rawFromFact, type CurrencyBalance } from '../../../lib/create/budgets'
import { PROTOCOL_FEE_UNDESCRIBED, type NetworkPoolFacts, type NetworkResolved, type NetworkToken, type OtherChainId } from '../../../lib/create/otherChains'
import { amountFact } from '../../../lib/read/pagers'
import { poolIdKey } from '../../../lib/read/screens/identity'
import type { PoolOption } from '../../../lib/read/screens/poolsList'
import type { TransientCandidate } from '../../../lib/read/screens/transient'
import type { TokenDisplay } from '../../../lib/read/types'
import { v2Chain } from '../../../v2/chains'
import type { ReadV6Reply } from '../../../v2/read/v6'
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
 * Added the same day (the owner's point 3): a pasted address named on each network (`pastedOf`), the pools' facts that
 * tell two rows of one pair and fee apart (`factsOfAnswer`), and which failed reads are worth asking again (`passingReply`).
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

/**
 * A chain-tokens answer as the search's rows for that network (pure), in the answer's own order. Changed on purpose
 * 2026-10-06 (the review of the next update): one of the network's own currencies (its profile's, by address) says so
 * (`own`), so it never rivals Robinhood Chain's own ETH or WETH for Enter (lib/create/otherChains.ts preselectOf).
 */
export function rowsOfTokens(chainId: OtherChainId, answer: ChainTokensResponse): NetworkToken[] {
  const network = v2Chain(chainId).name
  const profile = profileTokens(chainId)
  return answer.tokens.map((token): NetworkToken => {
    const shown = displayOf(chainId, { address: token.address.toLowerCase() as Address, symbol: cleanSymbol(token.symbol), decimals: token.decimals })
    const main = lookalikeOf(chainId, shown)
    const own = profile.some((entry) => entry.address === shown.address)
    return { chainId, network, token: shown, unread: false, ...(main ? { warning: JOURNEY.pool.lookalike(main) } : {}), ...(own ? { own: true as const } : {}) }
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

/**
 * What a pasted address is on a network, from the chain-pools answer about it (pure; 2026-10-06, the owner's point 3: a
 * pasted contract came as three unnamed "Look up this address" rows): the token, named, where it is one that can be used
 * there (read, with its decimals). Missing metadata cannot prove absence: read-v6 does not distinguish no contract
 * from a failed metadata read, so the search keeps that uncertainty without adding an unnamed duplicate row.
 */
export function pastedOf(chainId: OtherChainId, address: string, answer: ChainPoolsResponse): { state: 'token'; token: TokenDisplay } | { state: 'metadata_unavailable' } {
  const live = answer.tokens.find((token) => token.address.toLowerCase() === address.toLowerCase())
  if (!live || live.status === 'unavailable' || live.decimals === null) return { state: 'metadata_unavailable' }
  return { state: 'token', token: tokenOf(chainId, live) }
}

/**
 * Why a chain read did not answer, read for whether asking again soon could help (pure; 2026-10-06): a dropped connection,
 * a busy or slow reader, a chain or upstream briefly out. Anything else (a refusal, a reply the contract refuses, a route
 * that is off) comes back the same and is final.
 */
const PASSING_REASONS: ReadonlySet<string> = new Set([
  'network', 'unexpected_status', 'read_capacity_busy', 'read_deadline_exceeded', 'request_timeout', 'request_budget_exhausted',
  'upstream_timeout', 'upstream_unavailable', 'upstream_contract_mismatch', 'network_unavailable', 'rpc_error', 'block_unavailable',
  'snapshot_not_built', 'snapshot_reorganized', 'stale_or_future_block', 'catalogue_database_unavailable', 'missing_rpc_result',
])
export const passingReply = (reply: ReadV6Reply<unknown>): boolean => reply.kind === 'unavailable' && PASSING_REASONS.has(reply.reason)

/** The Retry-After a failed reply named (src/v2/read/v6.ts: a busy reader's 429), in whole seconds; undefined for none. */
export const retryAfterOf = (reply: ReadV6Reply<unknown>): number | undefined => (reply.kind === 'unavailable' ? reply.retryAfterSeconds : undefined)

/**
 * A failure that may pass, as the read screens' one rule waits for it (lib/read/screens/transient.ts): a dropped
 * connection's. Moved here on purpose 2026-10-06 from ../served.ts, unchanged (which still exports it), for `passingAfter`.
 */
export const PASSING: TransientCandidate = { state: 'unavailable', cause: { kind: 'network' } }

/**
 * What a failed chain read waits before it is asked again, as the read screens' rule takes it (quietDelayMs; pure).
 * Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, §1: the gateway's Retry-After is now the real time to the
 * lane's next token): a busy reader's 429 that named a Retry-After waits as a busy service does, never less than it asked;
 * any other failure that may pass waits as a dropped connection does (PASSING), as before.
 */
export const passingAfter = (retryAfterS: number | undefined): TransientCandidate => (retryAfterS === undefined ? PASSING : { state: 'busy', retryAfterSeconds: retryAfterS })

/**
 * The reader's own cache of a chain-pools answer (rugged's answer of 6 Oct, §1: "don't repeat chain-pools of the same
 * token before 15 s, which is the reader's cache"): asked again sooner, the same answer comes back, for one more of the
 * visitor's provider lane's tokens.
 */
export const READER_POOLS_CACHE_MS = 15_000
/** How long every caller reuses a chain-pools answer (rugged: "the app already reuses for 20 s"): above the reader's cache. */
export const POOLS_REUSE_MS = 20_000

/** A chain-pools read's key: the network, the token and the one it is paired with (none: the network's base currencies). */
export const poolsKey = (chainId: number, token: string, paired?: string): string => `${chainId}|${token.toLowerCase()}|${paired?.toLowerCase() ?? ''}`

/**
 * One answer per key for every ask within `maxAgeMs` (POOLS_REUSE_MS by default, never less than the reader's own cache,
 * READER_POOLS_CACHE_MS) of the ask that read it (pure; Added 2026-10-06, rugged's answer of 6 Oct, §1): a read on its way
 * is shared; an answer `ok` refuses (a failure) is dropped as it lands, so it is asked again after its own wait, except
 * that a failure `holdMs` names a wait for (a busy reader's Retry-After) is kept that long from when it landed, so no
 * caller asks the same read again before it (each one that meets it waits at least as long); at most `size` keys are
 * kept, the oldest dropped first. The clock is handed in.
 */
export function createAnswerReuse<T>(ok: (answer: T) => boolean, now: () => number, size = 64, holdMs: (failure: T) => number = () => 0) {
  // `until`: a failure kept until then, whatever an ask's age allows.
  const kept = new Map<string, { at: number; answer: Promise<T>; until?: number }>()
  return {
    ask(key: string, read: () => Promise<T>, maxAgeMs: number = POOLS_REUSE_MS): Promise<T> {
      const found = kept.get(key)
      if (found && (found.until !== undefined ? now() < found.until : now() - found.at < Math.max(maxAgeMs, READER_POOLS_CACHE_MS))) return found.answer
      const answer = read()
      kept.delete(key)
      kept.set(key, { at: now(), answer })
      while (kept.size > size) kept.delete(kept.keys().next().value as string)
      const settle = (hold: number) => {
        const entry = kept.get(key)
        if (entry?.answer !== answer) return
        if (hold > 0) entry.until = now() + hold
        else kept.delete(key)
      }
      void answer.then(
        (said) => {
          if (!ok(said)) settle(holdMs(said))
        },
        () => settle(0),
      )
      return answer
    },
  }
}

/**
 * A pool's protocol fee as a row carries it for the fee APR estimate (2026-10-06): v4's packed fee as read; a v3 pool's
 * only when it is off (0). A v3 pool whose protocol fee is on keeps PROTOCOL_FEE_UNDESCRIBED here, so every reader of the
 * packed v4 fee refuses it as before, and carries its slot0.feeProtocol beside it (`v3FeeOf`).
 */
const protocolFeeOf = (live: LivePool): number => (live.pool.dex === 4 ? live.protocolFee : live.protocolFee === 0 ? 0 : PROTOCOL_FEE_UNDESCRIBED)

/**
 * Changed on purpose 2026-10-06 (the owner: Base's v3 rows showed TVL and volume but no APR): a v3 pool whose protocol fee is
 * on carries its slot0.feeProtocol as read-v6 reports it, and the estimate takes the LPs' share of the fee from it
 * (lib/read/screens/rowApr.ts v3LpShare: the protocol keeps 1/N, as UniswapV3Pool.swap spends it).
 */
const v3FeeOf = (live: LivePool): { v3FeeProtocol?: number } => (live.pool.dex === 3 && live.protocolFee !== 0 ? { v3FeeProtocol: live.protocolFee } : {})

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
 * kept as it is on its own rows. `receivedAt`: when the answer arrived, on the page's clock. Since 2026-10-06 each row
 * carries its pool's protocol fee for the APR estimate (`protocolFeeOf`); its TVL and 24h volume are DEX Screener's, put
 * on as New position draws the rows (lib/create/otherChains.ts networkRows), never the answer's depth.
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
    return [poolRow({ pool: live.pool as PoolRef, key, tick: live.tick, sqrtPriceX96: live.sqrtPriceX96, block: answer.snapshot.number, usdPrices: pricesOf(answer, live.pool), protocolFeeRaw: protocolFeeOf(live), ...v3FeeOf(live) }, [first, second], readAt)]
  })
}

/**
 * What the answer says of each listed pool beyond its row, by row key (pure; 2026-10-06): its depth within the band and its
 * active liquidity, for telling a v3 and a v4 pool of one pair and fee apart (networkRows). Never shown.
 */
export function factsOfAnswer(answer: ChainPoolsResponse): Record<string, NetworkPoolFacts> {
  const out: Record<string, NetworkPoolFacts> = {}
  for (const live of answer.pools) {
    const key = keyOf(live)
    if (key) out[key] = { depthUsd: live.market.status === 'measured' ? live.market.depthUsd : null, liquidity: live.liquidity }
  }
  return out
}

/**
 * Each currency's USD price as the answer read it (read-v6 1.1.0-rc.1's qualified USD, rugged97's item 4), in pool order;
 * null for one without a price. None at all while the journey shows no USD (JOURNEY_USD_SHOWN).
 * Exported 2026-10-06 (no change of behaviour): Robinhood Chain's pools without USDG take their prices the same way, from
 * a chain-pools answer about their own pair (../poolPrices.ts).
 */
export function pricesOf(answer: ChainPoolsResponse, pool: { currency0: string; currency1: string }): readonly [string | null, string | null] | undefined {
  if (!JOURNEY_USD_SHOWN) return undefined
  const price = (address: string) => answer.tokens.find((token) => token.address.toLowerCase() === address.toLowerCase())?.price?.usd ?? null
  return [price(pool.currency0), price(pool.currency1)]
}

/** Whether two pools are the same pool: version, pair, fee, spacing and hooks. */
export const samePool = (a: PoolRef, b: PoolRef): boolean =>
  a.dex === b.dex && a.currency0.toLowerCase() === b.currency0.toLowerCase() && a.currency1.toLowerCase() === b.currency1.toLowerCase() &&
  a.fee === b.fee && a.tickSpacing === b.tickSpacing && a.hooks.toLowerCase() === b.hooks.toLowerCase()

/**
 * The pool on screen as a chain-pools answer about its pair reads it now (pure), or null when it is not listed any more.
 * Its price is the answer's; its TVL and 24h volume stay the row's own (2026-10-06: they are DEX Screener's, about the
 * pool and not its price, so a price read again keeps them, and the APR beside them).
 */
export function rereadOf(option: PoolOption, ref: PoolRef, answer: ChainPoolsResponse, receivedAt: number): PoolOption | null {
  const live = answer.pools.find((entry) => samePool(entry.pool as PoolRef, ref))
  const key = live ? keyOf(live) : null
  if (!live || !key) return null
  const row = poolRow({ pool: ref, key, tick: live.tick, sqrtPriceX96: live.sqrtPriceX96, block: answer.snapshot.number, usdPrices: pricesOf(answer, ref), protocolFeeRaw: protocolFeeOf(live), ...v3FeeOf(live) }, option.currencies, receivedAt - answer.freshness.ageSeconds * 1000)
  return { ...row, liquidity: option.liquidity, volume: option.volume, providerNote: option.providerNote }
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
