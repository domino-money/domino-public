import { createContext, useContext } from 'react'
import { compare } from '../read/decimal'
import type { DexPool } from '../read/dexFigures'
import { attributed } from '../read/figureFallback'
import { retrievalNote } from '../read/screens/figures'
import { NATIVE_CURRENCY, addressKey } from '../read/screens/identity'
import type { PoolOption } from '../read/screens/poolsList'
import type { TokenFacts } from '../read/screens/tokenSearch'
import type { TokenCandidate } from '../read/screens/tokens'
import type { TokenChainId, TokenDisplay } from '../read/types'
import type { CurrencyBalance } from './budgets'

/**
 * New position on the other networks Domino V2 serves (the owner, 2026-10-05: "the search on the screen, across the three
 * networks; the results get the network's tag", and creating there through the V2 contracts, spec F7 rev4 §1.2): Base and
 * Arbitrum One beside Robinhood Chain, in today's journey's own steps (components/create/Journey.tsx). V1 declares the
 * shape here and imports nothing of V2; a build that carries V2 hands an implementation in around today's journey
 * (src/v2in/journey/NewPositionV2.tsx, for the networks whose S1 gate is live). Without one (a build without V2, a page
 * outside that wrapper, no other network live) nothing of this exists and every step is exactly today's.
 *
 * Those networks have no read service yet (spec §6.2, "pools per chain" is still missing from read-v6), and no public RPC
 * may be asked (§6.1, the owner's rule): their tokens are offered from the network's profile (ETH, WETH, USDC) and a pasted
 * address, and a token's pools, a pool's price and the wallet's balances are read through the wallet's own provider on
 * that network, so the wallet is asked once to switch networks when such a token is chosen. Identity is chain plus
 * address (§1.3): Base's ETH is never Robinhood Chain's ETH.
 * Changed on purpose 2026-10-06 (rugged97's delta of 5 Oct, items 1-3): Domino's service now reads them (read-v6's
 * chain-pools, chain-balances and chain-tokens), so the search finds their tokens by name and their pools and balances
 * are listed with the wallet where it is; it moves only to sign. The wallet's own reads stay as the way when the service
 * cannot answer.
 * Changed on purpose 2026-10-06 (the owner's point 3: those networks' rows came "dry"): their pool rows carry TVL, 24h
 * volume and the APR worked out from them, from the same provider and in the same words as Robinhood Chain's
 * (`networkRows`); their tokens get the provider's artwork (lib/tokenArtwork.ts); one row stands for a v3 and a v4 pool
 * of one pair and fee; and the search ranks every network's hits together (`mergeHits`).
 */

/** The other networks: Base and Arbitrum One. */
export type OtherChainId = Exclude<TokenChainId, 4663>

/** A token of another network as the search offers it: its network's tag beside its name. */
export interface NetworkToken {
  chainId: OtherChainId
  /** The network's name, the tag ("Base", "Arbitrum One"). */
  network: string
  token: TokenDisplay
  /** A pasted address: its symbol and decimals are read once it is chosen (`resolve`). */
  unread: boolean
  /**
   * Added 2026-10-06: a hit that passes for one of the network's own currencies without being it ("Not the USDC Domino
   * uses"): listed with this line, never chosen, as today's search treats such a hit on Robinhood Chain.
   */
  warning?: string
  /**
   * Added 2026-10-06 (the review of the next update): one of the network's own currencies itself (its profile's ETH, WETH or
   * USDC, by address), which is never a rival of Robinhood Chain's own ETH, WETH or USDG for Enter (`preselectOf`).
   */
  own?: true
}

/**
 * Added 2026-10-06 (rugged97's delta of 5 Oct, item 2: read-v6's chain-tokens): the other networks' known tokens a text
 * names, read by Domino's service, for the search to list beside the network's own currencies. `ask` starts the read for
 * a text (the search calls it after its own short pause); `subscribe` and `version` tell the search an answer arrived,
 * after which `tokens(query)` includes it. Nothing is asked while the list is closed.
 *
 * Changed on purpose 2026-10-06 (the owner's point 3: "sometimes the name search only brings Robinhood Chain"): a read
 * that failed for the moment is asked again quietly, a few times, until the function `ask` returned is called (the list
 * closed, or the text changed); only the newest text is asked, one read at a time per network; and `pending` says a
 * network is still being searched for a text, so the search shows it (its icon pulses). A pasted address is looked up
 * on every network at once (chain-pools, which names it where it is a token there).
 */
export interface NetworkSearch {
  ask: (query: string) => () => void
  subscribe: (listener: () => void) => () => void
  version: () => number
  pending: (query: string) => boolean
}

/**
 * Added 2026-10-06: what chain-pools said of a pool beyond its row, to tell a v3 and a v4 pool of one pair and fee apart
 * (`networkRows`): its depth within the band in qualified USD (never shown, and never as TVL: the read says there is no
 * TVL) and its active liquidity, a raw integer.
 */
export interface NetworkPoolFacts {
  depthUsd: string | null
  liquidity: string | null
}

/**
 * What reading a token's pools on its network came to; `reason` is a sentence for the screen. Added 2026-10-06 to an
 * answer: `facts` by row key (above), and `subject`, the token the list is about, whose DEX Screener pairs give the rows
 * their figures (lowercase; native ETH by the zero address, as the provider names it).
 */
export type NetworkPools =
  | { kind: 'ok'; options: PoolOption[]; facts?: Readonly<Record<string, NetworkPoolFacts>>; subject?: string }
  | { kind: 'failed'; code: string; reason: string }

/**
 * Added 2026-10-06: the protocol fee of a pool on another network when it is not a v4 pool's packed fee the fee APR
 * estimate can take (lib/read/screens/rowApr.ts reads only v4's): a v3 pool whose protocol fee is on (there it is a share
 * of the LP fee, not on top of it), or a pool read through the wallet, whose protocol fee was not read. Out of the packed
 * fee's range on purpose, so every estimate refuses it and the APR is a dash, never a figure the method does not describe.
 */
export const PROTOCOL_FEE_UNDESCRIBED = 1 << 24

/** A pool's name at DEX Screener: a v4 pool's id, or a v3 pool's address (its key is the address as a 32-byte word). */
export const dexNameOf = (option: Pick<PoolOption, 'key' | 'dex'>): string => (option.dex === 3 ? `0x${option.key.slice(26)}` : option.key)

/** Whether a provider pair is about exactly this pool's two currencies (native ETH as the zero address on both sides). */
function samePair(option: Pick<PoolOption, 'currencies'>, dex: DexPool): boolean {
  const own = [option.currencies[0].address.toLowerCase(), option.currencies[1].address.toLowerCase()].sort()
  const theirs = [dex.base, dex.quote].sort()
  return own[0] === theirs[0] && own[1] === theirs[1]
}

/** Larger first as decimals; a known figure before a missing one; 0 when neither or both equal. */
function moreOf(a: string | null | undefined, b: string | null | undefined): number {
  if (a == null || b == null) return a == null && b == null ? 0 : a == null ? 1 : -1
  return -(compare(a, b) ?? 0)
}

/** Larger first as decimals when both are known; 0 when either is missing (two twins are compared on what both have). */
function bothMore(a: string | null | undefined, b: string | null | undefined): number {
  return a == null || b == null ? 0 : -(compare(a, b) ?? 0)
}

/** Larger first as raw integers when both are known; 0 otherwise. */
function bothMoreRaw(a: string | null | undefined, b: string | null | undefined): number {
  const x = a != null && /^\d+$/.test(a) ? BigInt(a) : null
  const y = b != null && /^\d+$/.test(b) ? BigInt(b) : null
  if (x === null || y === null) return 0
  return x === y ? 0 : x > y ? -1 : 1
}

const reported = (figure: PoolOption['liquidity']): string | null => (figure.state === 'attributed' || figure.state === 'attributed_stale' ? figure.raw : null)
const reportedTvl = (option: PoolOption): string | null => reported(option.liquidity)

/**
 * Another network's pool rows as New position shows them (2026-10-06, the owner's point 3: TVL, 24h volume and APR on
 * Base and Arbitrum One "like Robinhood Chain"), pure:
 *   - each row with DEX Screener's TVL and 24h volume where the provider lists that very pool (`dex`: its v4 id or v3
 *     address on that chain, both currencies the pool's own), attributed and dated as a Robinhood Chain row's figures
 *     are (figureFallback.ts `attributed`); the APR then follows from them, as on Robinhood Chain (rowApr.ts). A pool the
 *     provider does not list keeps its dashes: nothing is made up;
 *   - a v3 and a v4 pool of the same pair and fee, which a beginner cannot tell apart on screen, as one row: the one with
 *     the larger DEX Screener TVL, else the larger depth chain-pools measured (`facts`), else the more active liquidity;
 *     the row already chosen (`keep`, its key) stays whatever the figures say;
 *   - the largest reported TVL first, then the largest 24h volume, as Robinhood Chain's list (poolsList.ts byTvl).
 *
 * Changed on purpose 2026-10-06 (review of the same day):
 *   - two twins are compared on a figure only when both have it, else on the next one, else the first stays (the
 *     service's order puts the more liquid first): DEX Screener lists no Uniswap v4 pool on Arbitrum One, and a TVL
 *     there must not hide a v4 twin chain-pools measured deeper;
 *   - rows without a reported figure keep the order they came in, never byTvl's fee-tier fallback: chain-pools' (and the
 *     wallet read's) own order, ETH and WETH partners first, the most liquidity in range first, so a near-empty 0.01%
 *     pool is never the first row a beginner sees. Their measured depths (qualified USD) order them instead only when
 *     every one of them has one: a pool whose depth could not be measured may well be the deepest.
 */
export function networkRows(options: readonly PoolOption[], dex: (chainId: number, name: string) => DexPool | null, facts: Readonly<Record<string, NetworkPoolFacts>> = {}, keep: string | null = null): PoolOption[] {
  const figured = options.map((option): PoolOption => {
    const found = dex(option.currencies[0].chainId, dexNameOf(option))
    if (!found || !samePair(option, found) || (found.liquidityUsd === null && found.volume24hUsd === null)) return option
    return { ...option, liquidity: attributed(found.liquidityUsd, found.retrievedAt), volume: attributed(found.volume24hUsd, found.retrievedAt), providerNote: retrievalNote(found.retrievedAt) }
  })
  const kept = new Map<string, PoolOption>()
  for (const option of figured) {
    const pair = `${option.currencies[0].address.toLowerCase()}|${option.currencies[1].address.toLowerCase()}|${option.feePips}`
    const held = kept.get(pair)
    if (!held) {
      kept.set(pair, option)
      continue
    }
    if (held.key === keep) continue
    const better = option.key === keep || (bothMore(reportedTvl(option), reportedTvl(held)) || bothMore(facts[option.key]?.depthUsd, facts[held.key]?.depthUsd) || bothMoreRaw(facts[option.key]?.liquidity, facts[held.key]?.liquidity)) < 0
    if (better) kept.set(pair, option)
  }
  // Each row at the place its pair came in (a twin that replaced another takes its place).
  const rows = [...kept.values()]
  const unreported = rows.filter((row) => reportedTvl(row) === null && reported(row.volume) === null)
  const byDepth = unreported.length > 1 && unreported.every((row) => facts[row.key]?.depthUsd != null)
  const at = new Map(rows.map((row, index) => [row.key, index]))
  return [...rows].sort(
    (a, b) =>
      moreOf(reportedTvl(a), reportedTvl(b)) ||
      moreOf(reported(a.volume), reported(b.volume)) ||
      (byDepth ? moreOf(facts[a.key]?.depthUsd, facts[b.key]?.depthUsd) : 0) ||
      (at.get(a.key) ?? 0) - (at.get(b.key) ?? 0),
  )
}

/** How well a hit's symbol matches the text typed, as the search ranks names: 0 exact, 1 a prefix, 2 inside it, 3 not. */
export function hitRank(symbol: string | null, query: string): number {
  const needle = query.trim().toLowerCase()
  const label = (symbol ?? '').toLowerCase()
  if (!label || !needle) return 3
  if (label === needle) return 0
  if (label.startsWith(needle)) return 1
  return label.includes(needle) ? 2 : 3
}

/**
 * Today's hits and the other networks' as one list (2026-10-06, the owner's point 3: an exact match on Base must not sit
 * under twenty Robinhood Chain rows), pure: by match quality, exact first, then a prefix, then the rest; each list keeps
 * its own order, and Robinhood Chain's hit goes first between two of one quality. `rankOf` is today's own rank of a hit.
 *
 * Changed on purpose 2026-10-06 (review of the same day: rugged's "virtual" listed Robinhood Chain's two copies with
 * "No liquidity found" above Base's real VIRTUAL): between two hits of one quality, a token known to have no liquidity
 * (`empty`, DEX Screener's figure for it) comes after every one that may have some, whatever its network.
 */
export function mergeHits<H, N extends { token: { symbol: string | null } }>(
  home: readonly H[],
  rankOf: (hit: H) => number,
  network: readonly N[],
  query: string,
  empty: { home?: (hit: H) => boolean; network?: (row: N) => boolean } = {},
): Array<{ home: H } | { network: N }> {
  const entries: Array<{ entry: { home: H } | { network: N }; rank: number; dead: boolean; at: number }> = []
  for (const hit of home) entries.push({ entry: { home: hit }, rank: rankOf(hit), dead: empty.home?.(hit) === true, at: entries.length })
  for (const row of network) entries.push({ entry: { network: row }, rank: hitRank(row.token.symbol, query), dead: empty.network?.(row) === true, at: entries.length })
  return entries.sort((a, b) => a.rank - b.rank || Number(a.dead) - Number(b.dead) || a.at - b.at).map(({ entry }) => entry)
}

/**
 * What the search knows of a hit for choosing the one Enter takes (2026-10-06): its name as read (symbolReading), its facts.
 * Added 2026-10-06 (the review of the next update): `home`, a Robinhood Chain hit; `own`, one of its network's own
 * currencies itself (Robinhood Chain's ETH, WETH or USDG, config/mainTokens.ts; another network's profile currency,
 * NetworkToken.own).
 */
export type HitFacts = TokenFacts & { name: string | null; home?: boolean; own?: boolean }

/**
 * The hit Enter takes in the list of every network's hits, or -1 for none (2026-10-06, review of the same day: audit V3's
 * rule, which a copy on Robinhood Chain escaped while the real token sat on Base), pure: the first hit, unless it passes
 * for one of the main tokens, or another hit of any network has its name and the first is not clearly the real one (ten
 * times as liquid as each of the others, by known figures, with a logo). The rule today's search keeps within Robinhood
 * Chain's hits (lib/read/screens/tokenSearch.ts disambiguate), across networks. A hit with no name (an address to look up)
 * is taken alone; beside another such hit (one address, several networks that could not read it) the person chooses.
 *
 * Changed on purpose 2026-10-06 (the review of the next update: "eth" highlighted nothing and Enter did nothing, where
 * Robinhood Chain's ETH was taken before): another network's own currency is not a rival of Robinhood Chain's own ETH,
 * WETH or USDG. Base's ETH is the same name for that network's own currency, not a copy, and the 10x rule could never
 * hold beside it. Every other rival, a copy among them, still goes through the rule.
 */
export function preselectOf<E>(entries: readonly E[], factsOf: (entry: E) => HitFacts): number {
  if (entries.length === 0) return -1
  const mine = factsOf(entries[0])
  if (mine.warned) return -1
  const rivals = entries
    .slice(1)
    .map(factsOf)
    .filter((facts) => facts.name === mine.name && !(mine.home === true && mine.own === true && facts.home !== true && facts.own === true))
  if (rivals.length === 0) return 0
  if (mine.name === null) return -1
  const liquid = mine.liquidityUsd
  const clearly = mine.artwork === true && liquid !== null && liquid > 0 && rivals.every((rival) => rival.liquidityUsd !== null && rival.liquidityUsd * 10 < liquid)
  return clearly ? 0 : -1
}

export type NetworkResolved = { ok: true; token: TokenDisplay } | { ok: false; code: string; reason: string }

export interface OtherChains {
  /** Robinhood Chain's own tag, for today's rows once other networks are listed beside them. */
  home: string
  /** A network's name by id, for its tag; null for one this page does not offer. */
  name: (chainId: number) => string | null
  /** The other networks' tokens a query names. Synchronous; reads nothing (what `search` read is included). */
  tokens: (query: string) => readonly NetworkToken[]
  /** Added 2026-10-06: the read behind `tokens`, where Domino's service can search those networks; absent otherwise. */
  search?: NetworkSearch
  /**
   * A chosen row's token with its symbol and decimals, when it was a pasted address: read by Domino's service (the answer
   * the search already has, for 20 s), else through the wallet.
   */
  resolve: (row: NetworkToken, signal: AbortSignal) => Promise<NetworkResolved>
  /** The pools of a token on its network a position can open in: read by Domino's service, else through the wallet there. */
  pools: (token: TokenDisplay, signal: AbortSignal) => Promise<NetworkPools>
  /** A pool read again (its price), when the one on screen has aged; null when it could not be. */
  reread: (option: PoolOption, signal: AbortSignal) => Promise<PoolOption | null>
  /** The wallet's balances of a pool's two currencies, in pool order, on the pool's network; null when unread. */
  balances: (option: PoolOption, owner: string, signal: AbortSignal) => Promise<readonly [CurrencyBalance, CurrencyBalance] | null>
}

export const OtherChainsContext = createContext<OtherChains | null>(null)

/** The other networks this page offers, or null where there are none (every V1 path). */
export const useOtherChains = (): OtherChains | null => useContext(OtherChainsContext)

/** Whether a token or a pool's currency is on another network than Robinhood Chain. */
export const onOtherChain = (token: Pick<TokenDisplay, 'chainId'> | null | undefined): boolean => !!token && token.chainId !== 4663

/** Whether a pool is on another network than Robinhood Chain. */
export const poolOnOtherChain = (pool: Pick<PoolOption, 'currencies'> | null | undefined): boolean => !!pool && onOtherChain(pool.currencies[0])

/** Another network's token as the journey holds a chosen token: chosen, selectable, its decimals as read. */
export function networkCandidate(token: TokenDisplay): TokenCandidate {
  const key = addressKey(token.address)
  return {
    key,
    wire: key,
    token,
    kind: key === NATIVE_CURRENCY ? 'native' : 'erc20_candidate',
    why: null,
    reasonCode: null,
    decimalsUnavailable: token.decimals === null,
    source: 'pasted',
    wallet: null,
    balance: null,
    page: null,
    old: false,
    block: null,
  }
}
