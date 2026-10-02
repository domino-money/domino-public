/**
 * Elysium Testnet (99801) in the chain registry (2026-10-01, the chain2 workstream, audit items G3, G4 and G6): rugged97's
 * chain profile and deployment registry at commit 7d190690 (codex/elysium-v3-s8: chains/elysium-99801.json,
 * chains/deployments/elysium-v3-unqualified.json; copies in tests/fixtures/elysium/, which tests/chain-registry.test.mjs
 * compares field by field), plus what this app measured of the chain's public RPC on 2026-10-01.
 *
 * Its deployment is unqualified: rugged97's registry names no contract (factory, position manager, router and quoter
 * are null), so nothing that needs one is offered, and production keeps the section off (chains/elysium/flag.ts).
 *
 * A module of its own (config/chains.ts gathers it with Robinhood's), so the Elysium section imports this chain alone
 * and none of Robinhood Chain's modules.
 */
import { ELYSIUM_ID, ELYSIUM_KEY, ELYSIUM_NAME, ELYSIUM_STATUS, MULTICALL3_CANONICAL } from './chainIdentity'
import { ARB_SYS, deepFreeze, type ChainConfig, type Endpoint } from './chainKit'

/**
 * Elysium Testnet's public RPC (2026-10-01, measured from Brazil): CORS open (`access-control-allow-origin: *`), JSON-RPC
 * batches and Multicall3 at its canonical address answered; a numbered eth_call 650,000 blocks below the head and old
 * headers answered (block 701088's hash equals rugged97's S0 anchor); eth_getLogs over 600,000 blocks with an address
 * and a topic answered, and a toBlock past the head was refused (-32000 "invalid block range params"). Its provider
 * documents 25 requests a second for public traffic and refuses past it with HTTP 429 or -32017, counting every item
 * of a batch (rugged97's S5 report: a burst of 32 calls in one batch had 25 refused, each item with its own -32017):
 * this page asks at most 6 calls a second, 2 requests at a time, a batch carrying at most 6, and reads state through
 * Multicall3 (one call for many reads).
 */
export const ELYSIUM_PRIMARY: Endpoint = deepFreeze({
  url: 'https://testnet-rpc.elysium.kinetiq.xyz',
  stateDepth: Infinity,
  logWindow: 100_000,
  logWindows: 1,
  logDepth: Infinity,
  headers: true,
  simulate: false,
  gapMs: 150,
  perMinute: 360,
  inFlight: 2,
})

/** USDC as Elysium Testnet's bridge mints it (6 decimals; rugged97's S0 inventory). */
const ELYSIUM_USDC = '0x7d29d8047b905000459c0e80c34a26ceedcb47b2'
/** WHYPE, the canonical wrapped HYPE (18 decimals). */
const ELYSIUM_WHYPE = '0xcd57f65c2b0e5881cfc2e609f7cd53b746e1f234'

/** Elysium Testnet (99801): rugged97's Uniswap v3 profile, unqualified. */
export const ELYSIUM: ChainConfig = deepFreeze({
  key: ELYSIUM_KEY,
  profileId: 'elysium-99801',
  id: ELYSIUM_ID,
  name: ELYSIUM_NAME,
  network: 'testnet',
  parentChainId: 998,
  native: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  nativeAddress: null,
  wrapped: ELYSIUM_WHYPE,
  stables: [ELYSIUM_USDC],
  explorer: 'https://elysium.kinetiq.xyz/testnet-explorer',
  rpc: { primary: ELYSIUM_PRIMARY, fallbacks: [], order: { latest: [], state: [], archive: [], headers: [], simulate: [], logs: [] } },
  logs: { maxSpan: 600_000, maxSpanMany: 600_000, window: 100_000, refusesPastHead: true },
  pace: { batchMax: 6, batchItemsCount: true, firstRestMs: 2_000, maxRestMs: 30_000 },
  lanePace: null,
  multicall3: MULTICALL3_CANONICAL,
  arbSys: ARB_SYS,
  // Block 701088 at 2026-09-28T21:32:17Z (rugged97's S0 anchor) and 1588970 at 2026-10-01T14:55:55Z: 3.77 a second.
  blocksPerSecond: 3.77,
  deployment: {
    id: 'elysium-v3-unqualified',
    protocol: 'uniswap-v3',
    status: ELYSIUM_STATUS,
    version: 'local-reference-only',
    contracts: { factory: null, positionManager: null, router: null, quoter: null },
    codeHashes: { factory: null, positionManager: null, router: null, quoter: null },
    reference: { corePackage: '@uniswap/v3-core', coreVersion: '1.0.1', peripheryPackage: '@uniswap/v3-periphery', peripheryVersion: '1.4.4' },
    evidencePath: 'reports/elysium-v3-s0-2026-09-28/deployments.json',
  },
  firstBlocks: {},
  // G6: the testnet's USDC first, then WHYPE; any other token ranks 0.
  quoteRanks: { [ELYSIUM_USDC]: 2, [ELYSIUM_WHYPE]: 1 },
  // No fixed dollar: a test token's USDC is not a real dollar, so amounts are shown and USD totals hidden.
  dollarTokens: [],
  priceAliases: {},
  priceProvider: null,
  dexLink: null,
  webOrigin: null,
})
