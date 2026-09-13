import { SELECTED_POOLS } from './selectedPools'
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
export const SELECTED_POOLS_COMMON_TOKEN = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'

const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
const MARLIN = '0xab35d04e1ee39c789c4a65d522417b3c7f2e4723'

export interface PoolCatalogueEntry {
  poolId: string
  labels: readonly [string, string]
  artwork: readonly [ArtworkKey | null, ArtworkKey | null]
  /** Address-bound decoration only; never execution metadata. */
  addresses?: readonly [string, string]
  fee: string
  sourceUrl: string
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
const LABELS: readonly Omit<PoolCatalogueEntry, 'poolId' | 'sourceUrl'>[] = [
  { labels: ['WETH', 'USDG'], artwork: ['WETH', 'USDG'], addresses: [WETH, SELECTED_POOLS_COMMON_TOKEN], fee: '0.02%' },
  { labels: ['USDG', 'MARLIN'], artwork: ['USDG', 'MARLIN'], addresses: [SELECTED_POOLS_COMMON_TOKEN, MARLIN], fee: '5.00%' },
  { labels: ['cbBTC', 'USDG'], artwork: [null, 'USDG'], addresses: ['0xcec185eb182c47d1ba1efc84e6959e18cd620be4', SELECTED_POOLS_COMMON_TOKEN], fee: '0.15%' },
  { labels: ['U', 'USDG'], artwork: [null, 'USDG'], addresses: ['0xce24439f2d9c6a2289f741120fe202248b666666', SELECTED_POOLS_COMMON_TOKEN], fee: '0.0075%' },
  { labels: ['ETH', 'USDG'], artwork: ['ETH', 'USDG'], fee: '0.01%' },
  // Written as fee.ts writes a read fee (at least two decimals), so the label and the read agree.
  { labels: ['PONS', 'USDG'], artwork: [null, 'USDG'], addresses: ['0x39dbed3a2bd333467115de45665cc57f813c4571', SELECTED_POOLS_COMMON_TOKEN], fee: '0.30%' },
]

export const SELECTED_POOL_CATALOGUE: readonly PoolCatalogueEntry[] = SELECTED_POOLS.map((poolId, index) => ({
  poolId,
  ...LABELS[index],
  sourceUrl: `https://app.uniswap.org/explore/pools/robinhood/${poolId}`,
}))

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
 * nothing: its tokens appear once a read of the pool names them.
 */
export function catalogueTokens(): CatalogueToken[] {
  const seen = new Map<string, CatalogueToken>()
  for (const entry of SELECTED_POOL_CATALOGUE) {
    if (!entry.addresses) continue
    entry.addresses.forEach((address, index) => {
      const key = address.toLowerCase()
      if (!seen.has(key)) seen.set(key, { address: key, label: entry.labels[index], artwork: entry.artwork[index] })
    })
  }
  return [...seen.values()]
}

export interface PoolListing { poolId: string; market?: Market; catalogue?: PoolCatalogueEntry }

/** Stable rows immediately; live observations replace labels only by exact PoolId. */
export function poolListings(markets: readonly Market[], includeCatalogue: boolean): PoolListing[] {
  if (!includeCatalogue) return markets.map((market) => ({ poolId: market.poolId, market }))
  const byId = new Map(markets.map((market) => [market.poolId.toLowerCase(), market]))
  return SELECTED_POOL_CATALOGUE.map((catalogue) => ({
    poolId: catalogue.poolId,
    catalogue,
    market: byId.get(catalogue.poolId),
  }))
}
