/**
 * Whether the second chain's section is on, and what it reads (2026-10-01, the chain2 workstream; the owner's decision on
 * audit item G2: Elysium lives inside this app, as a lazily loaded section, behind a flag that is off in production
 * until there is a qualified deployment and on in preview).
 *
 * Production and preview deploy the same build, so the flag cannot be a build constant: it is the page's origin and the
 * registry's deployment status.
 * - production (https://domino.money): `live` only once the chain's deployment is qualified (config/chains.ts; rugged97's
 *   registry says unqualified today, so `off`);
 * - the gated Pages preview alias, and the local development server: `preview`;
 * - any other origin (a hash deployment, a copy of the site elsewhere): `off`.
 * Changed on purpose 2026-10-02 (review of the RPC switch, finding 1; the owner's final decision of 2026-10-01: the site
 * reads nothing from a public RPC, on the preview too): `off` everywhere for now, since the section reads its chain from
 * the testnet's public RPC alone; the rule above holds again once rugged97 serves those reads (mode.ts SECTION_READS).
 * The server side agrees (part B of the chain2 workstream): the middleware names the chain's RPC in the page's CSP only
 * where CHAIN2_PREVIEW is "true" (wrangler.toml sets it for the preview environment alone), and the /uniswap-v3/ route
 * forwards only with its binding and only from those origins.
 *
 * The mode itself is mode.ts (part B): the app's menu asks it on every page, so it lives in a module of its own that
 * imports nothing at run time; this module adds what the section reads.
 *
 * What `preview` reads: the registry's contracts when it names them, else rugged97's public testnet rehearsal
 * (rehearsal.ts), said so on every screen that shows them. `live` reads the registry's contracts only.
 *
 * Pure: the origin is handed in.
 */
import type { ChainConfig } from '../../config/chainKit'
import type { SectionMode } from './mode'
import { ELYSIUM_REHEARSAL } from './rehearsal'

export { DEV_ORIGIN, sectionMode, type SectionMode } from './mode'

/** Where the section's pools, positions and vaults come from. */
export interface SectionSource {
  readonly kind: 'qualified' | 'rehearsal'
  readonly factory: string
  readonly positionManager: string
  /** The block the factory's PoolCreated logs start from. */
  readonly fromBlock: number
  /** Pools known without a scan (the rehearsal's own two). */
  readonly pools: readonly string[]
  /** Vaults known to exist: their owner() is asked to find a wallet's (the actions service lists more where it answers). */
  readonly vaults: readonly string[]
}

/** The source for `mode`, or null when the section is off or nothing is known to read. */
export function sectionSource(mode: SectionMode, chain: ChainConfig): SectionSource | null {
  if (mode === 'off') return null
  const { factory, positionManager } = chain.deployment.contracts
  if (typeof factory === 'string' && typeof positionManager === 'string') {
    return { kind: 'qualified', factory, positionManager, fromBlock: chain.firstBlocks.factory ?? 0, pools: [], vaults: [] }
  }
  // The rehearsal is Elysium's alone, and only for preview.
  if (mode !== 'preview' || chain.key !== 'elysium') return null
  return {
    kind: 'rehearsal',
    factory: ELYSIUM_REHEARSAL.factory,
    positionManager: ELYSIUM_REHEARSAL.positionManager,
    fromBlock: ELYSIUM_REHEARSAL.factoryBlock,
    pools: ELYSIUM_REHEARSAL.pools.map((pool) => pool.address),
    vaults: ELYSIUM_REHEARSAL.vaults.map((vault) => vault.address),
  }
}
