/**
 * The tokens and pools the preview forms offer.
 *
 * The consumer-test catalog holds only the onboarding-v1 package's synthetic
 * fixture pools and tokens, labelled as such. Real pools come from #13 and a
 * curated catalog before any activation (Q5); nothing here reads a pool from
 * the network or accepts one pasted by the user.
 */
import type { Lower } from '../session/port'

export interface CatalogToken {
  address: Lower
  symbol: string
  decimals: number
  native: boolean
}

export interface CatalogPool {
  poolId: Lower
  label: string
  poolKey: { currency0: Lower; currency1: Lower; fee_pips: number; tick_spacing: number; hooks: '0x0000000000000000000000000000000000000000' }
}

export interface PreviewCatalog {
  /** Shown next to every pool and token the catalog names. */
  label: string
  tokens: readonly CatalogToken[]
  pools: readonly CatalogPool[]
}

const NO_HOOKS = '0x0000000000000000000000000000000000000000' as const
const SYN_A = '0x1111111111111111111111111111111111111111' as const
const SYN_B = '0x2222222222222222222222222222222222222222' as const
const NATIVE = '0x0000000000000000000000000000000000000000' as const

export const consumerTestCatalog: PreviewCatalog = {
  label: 'Synthetic test pool',
  tokens: [
    { address: SYN_A, symbol: 'SYN-A', decimals: 18, native: false },
    { address: SYN_B, symbol: 'SYN-B', decimals: 18, native: false },
    { address: NATIVE, symbol: 'ETH', decimals: 18, native: true },
  ],
  pools: [
    {
      poolId: '0x25431634fd7de72516ccb751020a1a9188376a983ccc5f6c1152ca04a6acffad',
      label: 'SYN-A / SYN-B · 0.30%',
      poolKey: { currency0: SYN_A, currency1: SYN_B, fee_pips: 3000, tick_spacing: 60, hooks: NO_HOOKS },
    },
    {
      poolId: '0x06339ed6a3555ccef52e5dd5be2a590cdeaeeb7bd1e0cecee96da150ac14dc58',
      label: 'ETH (native) / SYN-B · 0.30%',
      poolKey: { currency0: NATIVE, currency1: SYN_B, fee_pips: 3000, tick_spacing: 60, hooks: NO_HOOKS },
    },
  ],
}

export function tokenOf(catalog: PreviewCatalog, address: string): CatalogToken | null {
  const wanted = address.toLowerCase()
  return catalog.tokens.find((token) => token.address === wanted) ?? null
}

export function poolOf(catalog: PreviewCatalog, poolId: string): CatalogPool | null {
  const wanted = poolId.toLowerCase()
  return catalog.pools.find((pool) => pool.poolId === wanted) ?? null
}
