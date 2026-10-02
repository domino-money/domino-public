/**
 * What every chain record of the registry is, and the pure helpers over one (2026-10-01, the chain2 workstream, audit
 * items G3, G4 and G6). The registry itself is config/chains.ts; this module holds no chain, imports no chain's
 * constants and no module of the app at run time (but the canonical Multicall3 address, from config/chainIdentity.ts,
 * which every page carries anyway), so a chain's own module (config/chainElysium.ts) and the code that reads only that
 * chain can import it without bringing another chain's modules with them (the Elysium section's lazy chunk shares
 * nothing with Robinhood Chain's).
 *
 * Pure: Node-safe, no DOM, no build flag, no network.
 */

/** What a call needs from an endpoint (the retired lib/chain/failover.ts needOf; an empty order on both chains since 2026-10-01). */
export type Need = 'latest' | 'state' | 'archive' | 'headers' | 'simulate' | 'logs'

/** One public RPC of a chain, what it serves, and this page's own budget with it (part B: moved here from the retired lib/chain/endpoints.ts). */
export interface Endpoint {
  readonly url: string
  /**
   * How far below the head a numbered state read (eth_call, eth_getBalance, eth_getCode at a block number) is served:
   * Infinity for an archive, 0 for none (only 'latest').
   */
  readonly stateDepth: number
  /** eth_getLogs: the most blocks one of its calls may cover, and how many such calls one read of the page may take. */
  readonly logWindow: number
  readonly logWindows: number
  /** How far below the head its logs reach (Infinity: all of them). */
  readonly logDepth: number
  /** eth_getBlockByNumber at any height. */
  readonly headers: boolean
  readonly simulate: boolean
  /** This page's (or this worker's) own budget with it: the least gap between two requests, the most in a minute, the most at once. */
  readonly gapMs: number
  readonly perMinute: number
  readonly inFlight: number
}

/** The registry's names for its chains: a route segment and a storage prefix, never shown. */
export type ChainKey = 'robinhood' | 'elysium'

/** A lowercase 0x-prefixed 40-hex address. */
export type Address = string

export type Protocol = 'uniswap-v4' | 'uniswap-v3'

export interface NativeCurrency {
  readonly name: string
  readonly symbol: string
  readonly decimals: 18
}

/**
 * A chain's public RPCs: the chain's own first, then the public fallbacks, each with what it serves and this page's own
 * budget with it (Endpoint above), and the order the fallbacks are asked in per need.
 */
export interface ChainRpc {
  readonly primary: Endpoint
  readonly fallbacks: readonly Endpoint[]
  readonly order: Readonly<Record<Need, readonly Endpoint[]>>
}

/** What one eth_getLogs may cover on the chain's own RPC, and the window this app asks in. */
export interface ChainLogs {
  /** The most blocks one call may span with one value per filter position. */
  readonly maxSpan: number
  /** The most blocks one call may span when a filter position holds several values. */
  readonly maxSpanMany: number
  /** The span this app asks at once (a read wider than it goes window by window). */
  readonly window: number
  /** Whether a toBlock past the head is refused rather than clamped (Elysium answers -32000 "invalid block range params"). */
  readonly refusesPastHead: boolean
}

/**
 * How this page spends the chain's public RPC, beyond the primary endpoint's own budget (Endpoint gapMs, perMinute,
 * inFlight): how many calls one JSON-RPC batch may carry, whether each item of a batch counts as a request against the
 * provider's limit, and the rest after a refusal (doubled at each refusal in a row, up to `maxRestMs`).
 */
export interface ChainPace {
  readonly batchMax: number
  readonly batchItemsCount: boolean
  readonly firstRestMs: number
  readonly maxRestMs: number
}

/**
 * A fees worker's lane pace to a chain's public RPC (the retired lib/chain/browser.ts LANE_PACE): none on either chain
 * since 2026-10-01, and no fees worker at all since 2026-10-02 (RPC-SPEC §11.4: the page asks the site's ledger route).
 * The medium quiet and the batch log quiet (2026-10-01, the fees workstream's item A3) are optional: a pace from before
 * them takes none.
 */
export interface LanePace {
  readonly bytesPerSecond: number
  readonly burstBytes: number
  readonly workFactor: number
  readonly maxQuietMs: number
  readonly mediumMs?: number
  readonly mediumQuietMs?: number
  readonly heavyMs: number
  readonly heavyQuietMs: number
  readonly batchLogBlocks?: number
  readonly batchLogQuietMs?: number
  readonly graceMs: number
  readonly firstRestMs: number
  readonly restMs: number
}

/** The protocol deployment a chain's profile resolves (rugged97's chains/deployments/*.json), and its status. */
export interface Deployment {
  readonly id: string
  readonly protocol: Protocol
  /** `qualified`: agrees with a recorded deployment and its code hashes. `unqualified`: a reference only; no address is known. */
  readonly status: 'qualified' | 'unqualified'
  readonly version: string
  /** Contract addresses by role, lowercase; null where the registry names none. */
  readonly contracts: Readonly<Record<string, Address | null>>
  /** keccak256 of each contract's runtime code by role, lowercase; null where the registry names none. */
  readonly codeHashes: Readonly<Record<string, string | null>>
  readonly reference: Readonly<{ corePackage: string; coreVersion: string; peripheryPackage: string; peripheryVersion: string }>
  /** Where rugged97's repository keeps the deployment's evidence. */
  readonly evidencePath: string
}

export interface ChainConfig {
  readonly key: ChainKey
  /** rugged97's profile id (chains/<profileId>.json). */
  readonly profileId: string
  readonly id: number
  readonly name: string
  readonly network: 'mainnet' | 'testnet'
  readonly parentChainId: number
  readonly native: NativeCurrency
  /** The native currency's address where the protocol names one (Uniswap v4: the zero address); null where pools hold only the wrapped token (v3). */
  readonly nativeAddress: Address | null
  readonly wrapped: Address
  readonly stables: readonly Address[]
  /** The explorer's base URL, with no trailing slash: `/address/<a>` and `/tx/<h>` go after it. */
  readonly explorer: string
  readonly rpc: ChainRpc
  readonly logs: ChainLogs
  readonly pace: ChainPace
  readonly lanePace: LanePace | null
  readonly multicall3: Address
  /** Nitro's ArbSys precompile (arbBlockNumber() is the chain's own block inside a call; block.number is the parent's). */
  readonly arbSys: Address | null
  /** About how many blocks the chain makes a second, as measured (a head that moves on between reads). */
  readonly blocksPerSecond: number
  readonly deployment: Deployment
  /** The first block each contract can have logs from, by role (its deployment or first event); none where unknown. */
  readonly firstBlocks: Readonly<Record<string, number>>
  /**
   * How strongly a token is the one a price is counted in (lib/read/orientation.ts): the higher rank is the quote, an
   * absent token ranks 0. By address only: a symbol is untrusted text and never decides.
   */
  readonly quoteRanks: Readonly<Record<Address, number>>
  /** Tokens worth $1 by definition (USDG on Robinhood). Empty: no fixed dollar, so no USD total is built from one. */
  readonly dollarTokens: readonly Address[]
  /** A token priced as another (native ETH as WETH). */
  readonly priceAliases: Readonly<Record<Address, Address>>
  /** The public price provider's name for this chain (DEX Screener's chain id), or null: no provider, no USD price. */
  readonly priceProvider: Readonly<{ kind: 'dexscreener'; chain: string }> | null
  /** "Open on Uniswap" links: Uniswap's chain slug, or null: no external pool link. */
  readonly dexLink: Readonly<{ kind: 'uniswap'; chain: string }> | null
  /** The web origin rugged97's profile binds the chain to (null: none assumed). */
  readonly webOrigin: string | null
}

/** Multicall3 at its canonical address, the same on every chain it is deployed on (config/chainIdentity.ts). */
export { MULTICALL3_CANONICAL } from './chainIdentity'

/** ArbSys, the Nitro precompile both chains carry (rugged97's profiles: nitro.arbSys). */
export const ARB_SYS = '0x0000000000000000000000000000000000000064'

/**
 * Deep-freezes a record built by the registry. Objects in `borrowed` (another module's records, such as
 * config/chainRobinhood.ts's PRIMARY) are left as their module made them: building a record changes nothing of another module.
 */
export function deepFreeze<T>(value: T, borrowed: ReadonlySet<unknown> = new Set()): T {
  if (value && typeof value === 'object' && !borrowed.has(value) && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key], borrowed)
    Object.freeze(value)
  }
  return value
}

/** `0x`-prefixed hex of the chain id, as EIP-155, EIP-3085 and EIP-5792 write it. */
export const hexChainId = (chain: ChainConfig): string => `0x${chain.id.toString(16)}`

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HASH = /^0x[0-9a-fA-F]{64}$/

/** The explorer page of an address, or null for anything that is not one. */
export const explorerAddress = (chain: ChainConfig, address: string): string | null =>
  ADDRESS.test(address) ? `${chain.explorer}/address/${address.toLowerCase()}` : null

/** The explorer page of a transaction, or null for anything that is not a hash. */
export const explorerTx = (chain: ChainConfig, hash: string): string | null => (HASH.test(hash) ? `${chain.explorer}/tx/${hash.toLowerCase()}` : null)

/** A token's rank as a quote on this chain (lib/read/orientation.ts's rule, from the registry). */
export const quoteRankOn = (chain: ChainConfig, address: string): number => chain.quoteRanks[address.toLowerCase()] ?? 0

/** Whether the chain's prices write this pool the other way round: its second currency priced in its first. */
export const priceInvertedOn = (chain: ChainConfig, token0: string, token1: string): boolean => quoteRankOn(chain, token0) > quoteRankOn(chain, token1)

/** Whether a token is worth $1 by definition on this chain. */
export const isDollarToken = (chain: ChainConfig, address: string): boolean => chain.dollarTokens.includes(address.toLowerCase())

/** Whether the chain's deployment names a contract for `role`. */
export const hasContract = (chain: ChainConfig, role: string): boolean => typeof chain.deployment.contracts[role] === 'string'

/** Uniswap's page of a pool, or null where the chain has no such link (Elysium: none). */
export function poolSourceUrl(chain: ChainConfig, poolId: string): string | null {
  if (!chain.dexLink || !/^0x[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?$/.test(poolId)) return null
  return `https://app.uniswap.org/explore/pools/${chain.dexLink.chain}/${poolId.toLowerCase()}`
}

/**
 * The chain as EIP-3085 wallet_addEthereumChain takes it: the chain's own RPC first, then its fallbacks (none on either
 * chain since 2026-10-01), and its explorer. The wallet reads through these; the page never does for Robinhood Chain.
 */
export function addChainParameters(chain: ChainConfig) {
  return {
    chainId: hexChainId(chain),
    chainName: chain.name,
    nativeCurrency: { name: chain.native.name, symbol: chain.native.symbol, decimals: chain.native.decimals },
    rpcUrls: [chain.rpc.primary.url, ...chain.rpc.fallbacks.map((endpoint) => endpoint.url)],
    blockExplorerUrls: [chain.explorer],
  }
}

/**
 * The origins a page reading `chain` from the browser must name in its connect-src (lib/chain/csp.ts). Since 2026-10-01
 * (RPC-SPEC) only the Elysium section reads a chain from the browser; Robinhood Chain is read at the edge.
 */
export const rpcOrigins = (chain: ChainConfig): readonly string[] => [chain.rpc.primary, ...chain.rpc.fallbacks].map((endpoint) => new URL(endpoint.url).origin)
