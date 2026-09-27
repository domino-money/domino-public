import { SELECTED_POOLS } from './selectedPools'
import { MAIN_TOKENS, NATIVE_ETH, USDG, WETH as MAIN_WETH } from './mainTokens'
import type { Market } from '../lib/markets'
import type { ArtworkKey, TokenDisplay } from '../lib/read/types'

// Catalogue display labels by exact chain/address, never a replacement for
// contract decimals, wallet assets, admission or a successful metadata read.
const TOKEN_LABELS: Readonly<Record<string, string>> = {
  '0x0000000000000000000000000000000000000000': 'ETH',
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73': 'WETH',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168': 'USDG',
  '0xab35d04e1ee39c789c4a65d522417b3c7f2e4723': 'MARLIN',
  '0xcec185eb182c47d1ba1efc84e6959e18cd620be4': 'cbBTC',
  '0xce24439f2d9c6a2289f741120fe202248b666666': 'U',
  '0x39dbed3a2bd333467115de45665cc57f813c4571': 'PONS',
}

export function catalogueTokenLabel(token: TokenDisplay): string | null {
  return token.symbol === null && token.chainId === 4663 && token.readStatus !== 'no_contract'
    ? TOKEN_LABELS[token.address.toLowerCase()] ?? null
    : null
}

/**
 * The one token every selected pool holds, lowercase. Verifying any of the
 * six on the pools route is a read about this token and that pool id; the
 * reply is bound to both, so a label never stands in for the check.
 */
export const SELECTED_POOLS_COMMON_TOKEN = USDG

const WETH = MAIN_WETH
const MARLIN = '0xab35d04e1ee39c789c4a65d522417b3c7f2e4723'

export interface PoolCatalogueEntry {
  poolId: string
  labels: readonly [string, string]
  artwork: readonly [ArtworkKey | null, ArtworkKey | null]
  /** Address-bound decoration only; never execution metadata. */
  addresses?: readonly [string, string]
  fee: string
  sourceUrl: string
  /** A featured list's pinned pool (lib/read/featuredList.ts); never set on the embedded list. */
  pinned?: true
  /** The estimated 24h fee APR a featured list ranked this pool by, as the answer wrote it; never set on the embedded list. */
  rankApr?: string
  /** A featured list's pool key, lowercase, which the pool's own read must match (featuredList.ts `bindsToEntry`); never set on the embedded list. */
  poolKey?: { currency0: string; currency1: string; fee_pips: number; tick_spacing: number; hooks: string }
}

// Display catalogue inspected on Uniswap, Robinhood Chain, 2026-09-13 UTC.
// These are labels, not contract metadata or execution admission. In particular,
// Uniswap's ETH label does not establish native-vs-wrapped currency identity.
// No TVL, volume, APR, decimals, price or pretend snapshot is stored here.
// cbBTC is the Robinhood representation, not a claim of Coinbase-native issuance.
// The ETH/USDG row carries no addresses: Uniswap's ETH label does not say
// whether the pool holds the native currency or wrapped ether, and only a
// read of the pool does. Every other row's addresses are the ones its labels
// are bound to above.
//
// Keyed by pool id (2026-09-26, featured pools v1 §11.4): a label can no longer land on another pool when the list's
// order changes. A pool of selectedPools.ts without labels here is left out of the catalogue, never shown unlabelled.
const LABELS: Readonly<Record<string, Omit<PoolCatalogueEntry, 'poolId' | 'sourceUrl'>>> = {
  '0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6': { labels: ['WETH', 'USDG'], artwork: ['WETH', 'USDG'], addresses: [WETH, SELECTED_POOLS_COMMON_TOKEN], fee: '0.02%' },
  '0xdb922f0619e11b0c1e6c3a142798f0243060b8a4331ea4f4e7de80e898cc02e7': { labels: ['USDG', 'MARLIN'], artwork: ['USDG', 'MARLIN'], addresses: [SELECTED_POOLS_COMMON_TOKEN, MARLIN], fee: '5.00%' },
  '0x94c62eebf6454231b2fcd0259ede448ae3c6ad8617718cd88dab20b30cfae48a': { labels: ['cbBTC', 'USDG'], artwork: [null, 'USDG'], addresses: ['0xcec185eb182c47d1ba1efc84e6959e18cd620be4', SELECTED_POOLS_COMMON_TOKEN], fee: '0.15%' },
  '0xf399bd1544377680d48c62fd85c2105b869e55906c4189cc5ab3b4e83446928c': { labels: ['U', 'USDG'], artwork: [null, 'USDG'], addresses: ['0xce24439f2d9c6a2289f741120fe202248b666666', SELECTED_POOLS_COMMON_TOKEN], fee: '0.0075%' },
  '0x24107d152f14a76d292123265ae3f3c71f863fc2f4ef7ba49d64e78d28ea379e': { labels: ['ETH', 'USDG'], artwork: ['ETH', 'USDG'], fee: '0.01%' },
  // Written as fee.ts writes a read fee (at least two decimals), so the label and the read agree.
  '0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a': { labels: ['PONS', 'USDG'], artwork: [null, 'USDG'], addresses: ['0x39dbed3a2bd333467115de45665cc57f813c4571', SELECTED_POOLS_COMMON_TOKEN], fee: '0.30%' },
}

/** The embedded list: the reviewed pools of selectedPools.ts, in its order, each with its own labels. */
export const SELECTED_POOL_CATALOGUE: readonly PoolCatalogueEntry[] = SELECTED_POOLS.flatMap((poolId) => {
  const labelled = LABELS[poolId]
  return labelled ? [{ poolId, ...labelled, sourceUrl: `https://app.uniswap.org/explore/pools/robinhood/${poolId}` }] : []
})

/** A token the catalogue can name by address: a display label and artwork, never metadata. */
export interface CatalogueToken {
  /** Lowercase. */
  address: string
  label: string
  artwork: ArtworkKey | null
}

/**
 * The distinct tokens the selected pools are labelled with, by address, in
 * catalogue order. A row whose addresses are not established contributes
 * nothing: its tokens appear once a read of the pool names them. `entries`
 * is the embedded list unless a screen hands it the list on screen
 * (lib/read/featuredSource.ts); a featured list's labels are its symbols,
 * untrusted text.
 */
export function catalogueTokens(entries: readonly PoolCatalogueEntry[] = SELECTED_POOL_CATALOGUE): CatalogueToken[] {
  const seen = new Map<string, CatalogueToken>()
  for (const entry of entries) {
    if (!entry.addresses) continue
    entry.addresses.forEach((address, index) => {
      const key = address.toLowerCase()
      if (!seen.has(key)) seen.set(key, { address: key, label: entry.labels[index], artwork: entry.artwork[index] })
    })
  }
  return [...seen.values()]
}

/**
 * An entry as a row names it: its two sides in the pool's own order of
 * currencies, the order a read of the pool gives them. currency0 is the lower
 * address, so native ETH, the zero address, always comes first. Uniswap may
 * list a pair the other way round (cbBTC/USDG for USDG/cbBTC), and a row
 * would then swap its names when its read lands. Labels, artwork and
 * addresses move together, so each label stays bound to its address. Without
 * both addresses the order is not known and the labels stay as inspected.
 * Display only: the catalogue itself keeps the inspected order.
 */
export function inPoolOrder(entry: PoolCatalogueEntry): PoolCatalogueEntry {
  const addresses = entry.addresses
  if (!addresses || addresses[0].toLowerCase() <= addresses[1].toLowerCase()) return entry
  return {
    ...entry,
    labels: [entry.labels[1], entry.labels[0]],
    artwork: [entry.artwork[1], entry.artwork[0]],
    addresses: [addresses[1], addresses[0]],
  }
}

/**
 * The tokens a wallet's list falls back to when its provider names none: the main tokens (config/mainTokens.ts,
 * native ETH aside, which has no contract to ask) and the embedded list's, by exact address, in that order. Never a
 * daily featured list's tokens (2026-09-26, featured pools v1 §11.4).
 */
export const WALLET_FALLBACK_TOKENS: readonly string[] = Object.freeze([
  ...new Set([...MAIN_TOKENS.filter((token) => token.address !== NATIVE_ETH).map((token) => token.address), ...catalogueTokens().map((token) => token.address)]),
])

/**
 * The token a pool's link names (`#/pool/<id>/<token>`, components/explore/routes.ts), so the link opens the pool
 * whatever list it came from: USDG where the pool holds it, else WETH, else its first currency that is not native
 * ETH (the zero address names no contract to verify with). Null without one.
 */
export function referenceToken(addresses: readonly string[]): string | null {
  const keys = addresses.map((address) => address.toLowerCase())
  return [USDG, MAIN_WETH].find((main) => keys.includes(main)) ?? keys.find((key) => key !== NATIVE_ETH) ?? null
}

/** An entry's link token: its reference side, or USDG for an embedded row without addresses (every embedded pool holds it). */
export const entryToken = (entry: PoolCatalogueEntry): string | null =>
  entry.addresses ? referenceToken(entry.addresses) : SELECTED_POOLS_COMMON_TOKEN

export interface PoolListing {
  poolId: string
  market?: Market
  catalogue?: PoolCatalogueEntry
  /** The token the listing's link names (referenceToken): the read pool's own currencies once its row is in. */
  token: string | null
}

/**
 * Stable rows immediately; live observations replace labels only by exact
 * PoolId. A catalogue row names its pair in the pool's order, as its read
 * will, so the ticker, the table and the Markets cards keep one name for a
 * pool before and after its read lands. `entries` is the list on screen
 * (lib/read/featuredSource.ts, the embedded list or a featured list); null
 * lists the read rows alone, as a token's own pages and the test builds do.
 */
export function poolListings(markets: readonly Market[], entries: readonly PoolCatalogueEntry[] | null): PoolListing[] {
  const tokenOf = (market: Market) => referenceToken([market.tokens.base.address, market.tokens.quote.address])
  if (!entries) return markets.map((market) => ({ poolId: market.poolId, market, token: tokenOf(market) }))
  const byId = new Map(markets.map((market) => [market.poolId.toLowerCase(), market]))
  return entries.map((catalogue) => {
    const market = byId.get(catalogue.poolId)
    return { poolId: catalogue.poolId, catalogue: inPoolOrder(catalogue), market, token: market ? tokenOf(market) : entryToken(catalogue) }
  })
}
