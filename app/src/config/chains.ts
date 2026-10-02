/**
 * The chains this app knows, one frozen record each (2026-10-01, the chain2 workstream, audit item G3).
 *
 * Why: Robinhood Chain's identity was declared in six places (session/machine.ts, read/screens/identity.ts,
 * read/project.ts, functions/_lib/owned.ts, wallet/chain.ts, lib/capabilities.ts) and its addresses copied into more,
 * so a second chain meant about sixty hand edits, and an address changed in one copy and not in another would split
 * the read path. The owner decided (G2, option B) that the second chain, rugged97's "Elysium v3" (Uniswap v3 on
 * Kinetiq's Elysium Testnet), lives inside this app as its own section. This registry is the one place a chain's id,
 * name, native and wrapped currency, stablecoins, explorer, RPCs, protocol deployment, log limits, pace, quote ranks and
 * $1 rule live (the record's shape and the helpers over it are config/chainKit.ts).
 *
 * - Robinhood's record is built here from the registry's own modules: its identity and addresses
 *   (config/chainIdentity.ts) and its network (config/chainRobinhood.ts: the official RPC for the wallet, block rate,
 *   first blocks, log limits; since 2026-10-01, RPC-SPEC, no public fallback, order or lane pace: the site reads no RPC). Changed on purpose 2026-10-01 (part B, audit items G3 and G4): until then this record was built
 *   from the app's constants (functions/_lib/owned.ts, lib/chain/endpoints.ts, config/mainTokens.ts,
 *   lib/fees/constants.ts) and copied LANE_PACE; now those modules read the registry, so nothing is copied and nothing
 *   can drift. What only rugged97's profile and registry name (the explorer's role here, the parent chain, the code
 *   hashes, the reference packages) and the orientation's quote ranks are written here and held equal to their sources
 *   by tests/chain-registry.test.mjs.
 * - Elysium's record is config/chainElysium.ts: rugged97's profile and registry at 7d190690, unqualified. It is a
 *   module of its own so that the Elysium section, which imports it alone, brings none of Robinhood Chain's modules
 *   into its lazy chunk.
 *
 * This module imports nothing but the registry's own (chainKit, chainIdentity, chainRobinhood, chainElysium), so the
 * site's middleware can build the page's CSP from it (functions/_middleware.ts; scripts/release.mjs BUNDLED lists them).
 *
 * Pure data and pure helpers: Node-safe, no DOM, no build flag, no network.
 */
import { ELYSIUM } from './chainElysium'
import {
  MULTICALL3_CANONICAL,
  ROBINHOOD_EXPLORER,
  ROBINHOOD_ID,
  ROBINHOOD_KEY,
  ROBINHOOD_NAME,
  ROBINHOOD_NATIVE,
  ROBINHOOD_NATIVE_ADDRESS,
  ROBINHOOD_POOL_MANAGER,
  ROBINHOOD_POSITION_MANAGER,
  ROBINHOOD_SETUP,
  ROBINHOOD_STATE_VIEW,
  ROBINHOOD_USDG,
  ROBINHOOD_WETH,
} from './chainIdentity'
import { ARB_SYS, deepFreeze, type ChainConfig } from './chainKit'
import { BLOCKS_PER_SECOND, FIRST_TRANSFER_BLOCK, LOG_BLOCKS_MANY, LOG_BLOCKS_ONE, PRIMARY, SETUP_DEPLOY_BLOCK } from './chainRobinhood'

export * from './chainKit'
export { ELYSIUM, ELYSIUM_PRIMARY } from './chainElysium'

/** config/chainRobinhood.ts's endpoint record, borrowed as that module made it (left unfrozen). */
const BORROWED: ReadonlySet<unknown> = new Set<unknown>([PRIMARY])

/** Robinhood Chain (4663): Uniswap v4 and Domino V1, live. */
export const ROBINHOOD: ChainConfig = deepFreeze(
  {
    key: ROBINHOOD_KEY,
    profileId: 'robinhood-4663',
    id: ROBINHOOD_ID,
    name: ROBINHOOD_NAME,
    network: 'mainnet',
    // Copy: rugged97's chains/robinhood-4663.json parentChainId.
    parentChainId: 1,
    native: { ...ROBINHOOD_NATIVE },
    nativeAddress: ROBINHOOD_NATIVE_ADDRESS,
    wrapped: ROBINHOOD_WETH,
    stables: [ROBINHOOD_USDG],
    explorer: ROBINHOOD_EXPLORER,
    // Changed on purpose 2026-10-01 (RPC-SPEC, the owner's rule: nothing is read from a public RPC): the official RPC is
    // named for the wallet's "add network" alone; no fallback and no order, since this site reads no RPC of the chain.
    rpc: { primary: PRIMARY, fallbacks: [], order: { latest: [], state: [], archive: [], headers: [], simulate: [], logs: [] } },
    logs: { maxSpan: LOG_BLOCKS_ONE, maxSpanMany: LOG_BLOCKS_MANY, window: LOG_BLOCKS_ONE, refusesPastHead: false },
    // The browser's pace with a chain's RPC (lib/chain/client.ts): unused for this chain, which the browser no longer reads.
    pace: { batchMax: 50, batchItemsCount: false, firstRestMs: 6_000, maxRestMs: 30_000 },
    lanePace: null,
    multicall3: MULTICALL3_CANONICAL,
    arbSys: ARB_SYS,
    blocksPerSecond: BLOCKS_PER_SECOND,
    deployment: {
      id: 'robinhood-v4',
      protocol: 'uniswap-v4',
      status: 'qualified',
      version: 'recorded-robinhood-release-2026-09-21',
      contracts: { poolManager: ROBINHOOD_POOL_MANAGER, positionManager: ROBINHOOD_POSITION_MANAGER, stateView: ROBINHOOD_STATE_VIEW, setup: ROBINHOOD_SETUP },
      // Copies: rugged97's chains/deployments/robinhood-v4.json codeHashes.
      codeHashes: {
        poolManager: '0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626',
        positionManager: '0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2',
        stateView: '0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6',
        setup: null,
      },
      reference: {
        corePackage: '@uniswap/v4-core',
        coreVersion: '59d3ecf53afa9264a16bba0e38f4c5d2231f80bc',
        peripheryPackage: '@uniswap/v4-periphery',
        peripheryVersion: 'dce236d4e2057422d0791d9a973a58765eb46f65',
      },
      evidencePath: 'docs/deployments/v1-robinhood-mainnet-2026-09-21/deployment.json',
    },
    firstBlocks: { positionManager: FIRST_TRANSFER_BLOCK, setup: SETUP_DEPLOY_BLOCK },
    // Copy: lib/read/orientation.ts QUOTE_RANK.
    quoteRanks: { [ROBINHOOD_USDG]: 2, [ROBINHOOD_NATIVE_ADDRESS]: 1, [ROBINHOOD_WETH]: 1 },
    dollarTokens: [ROBINHOOD_USDG],
    priceAliases: { [ROBINHOOD_NATIVE_ADDRESS]: ROBINHOOD_WETH },
    priceProvider: { kind: 'dexscreener', chain: 'robinhood' },
    dexLink: { kind: 'uniswap', chain: 'robinhood' },
    webOrigin: 'https://domino.money',
  },
  BORROWED,
)

/** Every chain, Robinhood first: the app's default when a route names none. */
export const CHAINS: readonly ChainConfig[] = Object.freeze([ROBINHOOD, ELYSIUM])

/** The chain with this id, or null. */
export const chainById = (id: number): ChainConfig | null => CHAINS.find((chain) => chain.id === id) ?? null

/** The chain with this registry key, or null for anything else (a route segment is untrusted text). */
export const chainByKey = (key: string): ChainConfig | null => CHAINS.find((chain) => chain.key === key) ?? null
