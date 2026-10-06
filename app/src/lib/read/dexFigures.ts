/**
 * DEX Screener as the markets' second source of figures (audit V1, V2, V3; 2026-10-01).
 *
 * The page already reads DEX Screener's token-pairs body for every token it draws, for the artwork
 * (lib/tokenArtwork.ts), and that body carries each pool's liquidity and 24h volume, which used to be thrown away. They
 * are kept here, by pool id and by token, with the time they were retrieved:
 *
 *   - a pool's figures stand in for the read service's when its provider refused for the moment (figureFallback.ts),
 *     always attributed to DEX Screener and dated, never mixed with the read service's own;
 *   - a token's liquidity across its pools tells two tokens with the same symbol apart in the token search (V3).
 *
 * Only Uniswap v4 pools on Robinhood Chain, named by their 32-byte pool id, are taken as a pool's figures: the same
 * pairs New position's hints take (screens/poolHints.ts). A figure is a provider's own number, as a decimal string;
 * nothing is worked out here. Figures older than DEX_MAX_AGE_S are not given out.
 *
 * Changed on purpose 2026-10-06 (the owner's point 3: Base and Arbitrum One's pools in New position with TVL, 24h volume
 * and APR "like Robinhood Chain"): the same figures for a pool on Base or Arbitrum One, from the token-pairs body of the
 * token New position lists there (`askOn`). There a pool is named by what the provider calls it: a Uniswap v4 pool by
 * its 32-byte id, a v3 pool by its address (the provider labels neither reliably there, and Arbitrum's v3 pairs carry no
 * label at all), so a pool is taken only under Uniswap and only by that exact name; New position then checks both
 * currencies too (lib/create/otherChains.ts). Every key names the chain: an id or an address can repeat across chains.
 */
import { dexChainSlug, tokenArtwork } from '../tokenArtwork'
import { NATIVE_ETH, USDG, WETH } from '../../config/mainTokens'

const POOL_ID = /^0x[0-9a-fA-F]{64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
/** A pool's name on Base or Arbitrum One: a v4 pool's 32-byte id, or a v3 pool's 20-byte address. */
const POOL_NAME = /^0x(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{40})$/
/** Robinhood Chain: every reader of this store before 2026-10-06 asks about it alone. */
const HOME = 4663
/** Figures older than this, in seconds, are not given out. */
export const DEX_MAX_AGE_S = 600
/** A token is not asked about again sooner than this. */
export const DEX_ASK_EVERY_MS = 60_000

/** One pool's figures as DEX Screener reported them. */
export interface DexPool {
  /** Lowercase: a v4 pool's id; on Base and Arbitrum One also a v3 pool's address (2026-10-06). */
  poolId: string
  /** The pair's two tokens as the provider names them, lowercase. */
  base: string
  quote: string
  /** Decimal strings, USD; null when the provider reported none. */
  liquidityUsd: string | null
  volume24hUsd: string | null
  /** Unix seconds, when it was retrieved (by our edge, where it answered). */
  retrievedAt: number
}

/** A token's liquidity across the pools the provider lists for it, for telling two tokens with one symbol apart. */
export interface DexToken {
  address: string
  liquidityUsd: number
  pools: number
  retrievedAt: number
}

type Pair = {
  chainId?: unknown
  dexId?: unknown
  labels?: unknown
  pairAddress?: unknown
  baseToken?: { address?: unknown } | null
  quoteToken?: { address?: unknown } | null
  liquidity?: { usd?: unknown } | null
  volume?: { h24?: unknown } | null
}

/** A provider number as a plain decimal string, two places; null for anything that is not a finite, non-negative number. */
export function usdText(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1e15 ? value.toFixed(2) : null
}

const lower = (value: unknown): string | null => (typeof value === 'string' && ADDRESS.test(value) ? value.toLowerCase() : null)
const pairsOf = (body: unknown): Pair[] => (Array.isArray(body) && body.length <= 300 ? body.filter((pair): pair is Pair => typeof pair === 'object' && pair !== null) : [])

/** The Uniswap v4 pools on Robinhood Chain a token-pairs body names, with their figures. */
export function dexPoolsFromPairs(body: unknown, retrievedAtMs: number): DexPool[] {
  const out: DexPool[] = []
  for (const pair of pairsOf(body)) {
    if (pair.chainId !== 'robinhood' || pair.dexId !== 'uniswap' || !Array.isArray(pair.labels) || !pair.labels.includes('v4')) continue
    if (typeof pair.pairAddress !== 'string' || !POOL_ID.test(pair.pairAddress)) continue
    const base = lower(pair.baseToken?.address)
    const quote = lower(pair.quoteToken?.address)
    if (!base || !quote) continue
    out.push({ poolId: pair.pairAddress.toLowerCase(), base, quote, liquidityUsd: usdText(pair.liquidity?.usd), volume24hUsd: usdText(pair.volume?.h24), retrievedAt: Math.floor(retrievedAtMs / 1000) })
  }
  return out
}

/**
 * The Uniswap pools on Base or Arbitrum One a token-pairs body names (2026-10-06), with their figures: each by its exact
 * name there, a v4 pool's 32-byte id or a v3 pool's address. The pair's two tokens are kept as the provider names them
 * (native ETH by the zero address), for the reader to check against the pool's own currencies.
 */
export function dexChainPoolsFromPairs(body: unknown, chainId: number, retrievedAtMs: number): DexPool[] {
  const slug = dexChainSlug(chainId)
  if (slug === null || chainId === HOME) return []
  const out: DexPool[] = []
  for (const pair of pairsOf(body)) {
    if (pair.chainId !== slug || pair.dexId !== 'uniswap' || typeof pair.pairAddress !== 'string' || !POOL_NAME.test(pair.pairAddress)) continue
    const base = lower(pair.baseToken?.address)
    const quote = lower(pair.quoteToken?.address)
    if (!base || !quote) continue
    out.push({ poolId: pair.pairAddress.toLowerCase(), base, quote, liquidityUsd: usdText(pair.liquidity?.usd), volume24hUsd: usdText(pair.volume?.h24), retrievedAt: Math.floor(retrievedAtMs / 1000) })
  }
  return out
}

/** A token's liquidity across every pair on its chain naming it, as base or quote (Robinhood Chain unless another is named). */
export function dexTokenFromPairs(body: unknown, address: string, retrievedAtMs: number, chainId = HOME): DexToken | null {
  const key = address.toLowerCase()
  const slug = dexChainSlug(chainId)
  let liquidity = 0
  let pools = 0
  for (const pair of pairsOf(body)) {
    if (slug === null || pair.chainId !== slug) continue
    if (lower(pair.baseToken?.address) !== key && lower(pair.quoteToken?.address) !== key) continue
    pools += 1
    const usd = pair.liquidity?.usd
    if (typeof usd === 'number' && Number.isFinite(usd) && usd > 0) liquidity += usd
  }
  return pools === 0 ? { address: key, liquidityUsd: 0, pools: 0, retrievedAt: Math.floor(retrievedAtMs / 1000) } : { address: key, liquidityUsd: liquidity, pools, retrievedAt: Math.floor(retrievedAtMs / 1000) }
}

export interface DexStore {
  /**
   * A body read for `address` on `chainId` (Robinhood Chain unless named, 2026-10-06): its pools' figures and the token's
   * liquidity are kept, the newest of each.
   */
  take(address: string, body: unknown, retrievedAtMs: number, chainId?: number): void
  /** A Robinhood Chain pool's figures, by its v4 id. */
  pool(poolId: string, nowMs?: number): DexPool | null
  /** A Robinhood Chain token's liquidity across its pairs. */
  token(address: string, nowMs?: number): DexToken | null
  /** Asks the provider about a Robinhood Chain token, unless it was asked within DEX_ASK_EVERY_MS. */
  ask(address: string): void
  /** Added 2026-10-06: a pool on Base or Arbitrum One by its name there (v4 id or v3 address). */
  chainPool(chainId: number, name: string, nowMs?: number): DexPool | null
  /** Added 2026-10-06: a token on Base or Arbitrum One, once a body about it was read (none past DEX_MAX_AGE_S). */
  chainToken(chainId: number, address: string, nowMs?: number): DexToken | null
  /** Added 2026-10-06: asks about a token on Base or Arbitrum One, unless it was asked within DEX_ASK_EVERY_MS. */
  askOn(chainId: number, address: string): void
  subscribe(listener: () => void): () => void
  /** Moves on every change: React's snapshot. */
  version(): number
}

/** `read(address, chainId)`: the token-pairs body of a token on a chain (the store passes Robinhood Chain's as 4663). */
export function createDexStore(read: (address: string, chainId: number) => Promise<unknown>, wall: () => number = Date.now): DexStore {
  // Every key is chain plus id or address (2026-10-06).
  const pools = new Map<string, DexPool>()
  const tokens = new Map<string, DexToken>()
  const asked = new Map<string, number>()
  const listeners = new Set<() => void>()
  let version = 0
  const fresh = <T extends { retrievedAt: number }>(entry: T | undefined, nowMs: number) => (entry && nowMs / 1000 - entry.retrievedAt <= DEX_MAX_AGE_S ? entry : null)
  const keyOf = (chainId: number, name: string) => `${chainId}:${name.toLowerCase()}`
  function askAbout(chainId: number, address: string) {
    const lowered = address.toLowerCase()
    if (!ADDRESS.test(lowered) || dexChainSlug(chainId) === null) return
    const key = keyOf(chainId, lowered)
    const at = wall()
    const last = asked.get(key)
    if (last !== undefined && at - last < DEX_ASK_EVERY_MS) return
    asked.set(key, at)
    while (asked.size > 512) asked.delete(asked.keys().next().value!)
    void read(lowered, chainId).catch(() => undefined)
  }
  return {
    take(address, body, retrievedAtMs, chainId = HOME) {
      if (dexChainSlug(chainId) === null) return
      let changed = false
      for (const found of chainId === HOME ? dexPoolsFromPairs(body, retrievedAtMs) : dexChainPoolsFromPairs(body, chainId, retrievedAtMs)) {
        const key = keyOf(chainId, found.poolId)
        const kept = pools.get(key)
        if (kept && kept.retrievedAt > found.retrievedAt) continue
        pools.set(key, found)
        changed = true
      }
      const token = ADDRESS.test(address) ? dexTokenFromPairs(body, address, retrievedAtMs, chainId) : null
      if (token) {
        tokens.set(keyOf(chainId, token.address), token)
        changed = true
      }
      while (pools.size > 512) pools.delete(pools.keys().next().value!)
      while (tokens.size > 256) tokens.delete(tokens.keys().next().value!)
      if (!changed) return
      version += 1
      for (const listener of listeners) listener()
    },
    pool: (poolId, nowMs = wall()) => fresh(pools.get(keyOf(HOME, poolId)), nowMs),
    token: (address, nowMs = wall()) => fresh(tokens.get(keyOf(HOME, address)), nowMs),
    ask: (address) => askAbout(HOME, address),
    chainPool: (chainId, name, nowMs = wall()) => fresh(pools.get(keyOf(chainId, name)), nowMs),
    chainToken: (chainId, address, nowMs = wall()) => fresh(tokens.get(keyOf(chainId, address)), nowMs),
    askOn: (chainId, address) => askAbout(chainId, address),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    version: () => version,
  }
}

/**
 * The token the provider is asked about for a pool: the one that is not the dollar or ether, whose list of pairs is
 * short enough to name the pool (the provider lists 30 pairs a token, and USDG's are not ranked by liquidity); for a
 * pool of ether and the dollar, native ether by the zero address, as the provider names it.
 */
export function subjectOf(currencies: readonly [string, string]): string {
  const keys = currencies.map((address) => address.toLowerCase())
  const plain = keys.find((key) => key !== USDG && key !== NATIVE_ETH && key !== WETH)
  return plain ?? (keys.includes(USDG) ? NATIVE_ETH : keys[0])
}

/** The page's one store, fed by every token-pairs body the artwork resolver reads, on every chain it reads. */
export const dexStore = createDexStore((address, chainId) => tokenArtwork.pairs(chainId, address))
tokenArtwork.onPairs((address, body, retrievedAt, chainId) => dexStore.take(address, body, retrievedAt, chainId))
