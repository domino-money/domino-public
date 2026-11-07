/**
 * The chains Domino V2 serves, from the published chain profiles (api-contracts/v2/chains/*.json, spec F7 §1.2), read
 * at build time rather than copied by hand.
 *
 * Changed on purpose 2026-11-06 (Elysium readiness, the day-9 trap): only the profiles of the chains in the app's one
 * list (config/chainIdentity.ts V2_CHAIN_IDS) are imported, by name. Elysium's placeholder (elysium.json, disabled, no
 * chain id) was imported too, to prove it stays out; rugged97's enabling change replaces that file with
 * elysium-<id>.json (docs/v2/QUALIFY_CHAIN.md), which would have broken this build. Now the build holds whichever of the
 * two is there, and a profile of a chain id the app does not list is ignored (chainsFrom), never served and never a
 * failure. The chain model takes a chain whose native currency is HYPE (Elysium), with its own wrapped token, charge
 * currencies and finality (./elysium.ts).
 * Changed on purpose 2026-11-07 (Elysium as a fourth V2 chain, switched on by itself): Elysium is served, last, exactly
 * where the build's switch says it is live (lib/elysiumIdentity.ts ELYSIUM_LIVE, which V2_CHAIN_IDS follows): its facts
 * row joins V2_CHAIN_FACTS and its profile, read by the switch from api-contracts/v2/chains and handed in by the build
 * (./elysiumFiles.ts ELYSIUM_PROFILE: never a static import of a file that is not there yet), joins the profiles. A
 * build where Elysium is off holds neither, and serves the three exactly as before.
 *
 * Nothing here names a Domino contract: those come only from a chain's pinned deployment manifest (./manifest.ts).
 * Nothing here names an RPC either: the site reads no public RPC (the owner's rule, 2026-10-01), and every read of a
 * V2 chain goes through the wallet's own provider or rugged97's infrastructure.
 *
 * No viem, no wallet: screens may import this.
 */
import robinhoodProfile from '../../../api-contracts/v2/chains/robinhood-4663.json'
import baseProfile from '../../../api-contracts/v2/chains/base-8453.json'
import arbitrumProfile from '../../../api-contracts/v2/chains/arbitrum-42161.json'
import { ARBITRUM_NAME, BASE_NAME, ROBINHOOD_NAME, V2_CHAIN_IDS } from '../config/chainIdentity'
import { ELYSIUM_LIVE, ELYSIUM_V2_ID } from '../lib/elysiumIdentity'
import { ELYSIUM } from './elysium'
import { ELYSIUM_PROFILE } from './elysiumFiles'
import { ZERO_ADDRESS, type Address, type Dex, type NativeSymbol, type V2ChainId, type WrappedSymbol } from './types'

export interface ChargeCurrency {
  /** 1 is the chain's stable; 2 is its native currency (address(0)) and its wrapped token. Lower ranks first (spec §2.8). */
  rank: number
  symbol: string
  address: Address
  decimals: number
  native: boolean
}

/** A chain's Uniswap v3: its factory, NonfungiblePositionManager, pool init code hash and fee tiers. */
export interface V3Deployment {
  factory: Address
  positionManager: Address
  poolInitCodeHash: `0x${string}`
  tickSpacingByFee: Readonly<Record<number, number>>
}

export interface V2Chain {
  chainId: V2ChainId
  /** The chain id as wallets and EIP-5792 write it: '0x1237', '0x2105', '0xa4b1'. */
  hex: `0x${string}`
  slug: V2Slug
  /**
   * Shown as written: "Robinhood Chain", "Base", "Arbitrum One". Changed on purpose 2026-11-06 (Elysium readiness): the
   * app's one name for the network (V2ChainFacts.name, the words lib/networkName.ts writes), not the profile's own (the
   * same three words today; Elysium's placeholder says "Elysium (Kinetiq)").
   */
  name: string
  /** What the chain pays its network fees in, at address(0): ETH, or HYPE on Elysium. */
  nativeSymbol: NativeSymbol
  stack: 'arbitrum-nitro' | 'op-stack'
  uniswap: {
    /**
     * Null on a chain without Uniswap v3 (added 2026-11-06, Elysium readiness: Elysium launches with v4 only). Ask
     * `hasDex(chain, 3)` before anything of v3, and reach it through `v3Of`, which refuses such a chain.
     */
    v3: V3Deployment | null
    v4: { poolManager: Address; positionManager: Address; stateView: Address }
    /** Only 2.1.2: versions 2.0 and 2.1.1 are switched off on 2026-10-21 (spec §1.2). */
    universalRouter: { address: Address; version: '2.1.2' }
  }
  /**
   * The Uniswap versions the chain has, ascending (added 2026-11-06, Elysium readiness): [3, 4] on Robinhood Chain, Base
   * and Arbitrum One; [4] on a chain whose profile names `uniswap.v3` null. The one answer to "does this chain have v3?"
   * (`hasDex`): nothing of a version the chain lacks is offered, planned, built, read or sent there.
   */
  dexes: readonly Dex[]
  permit2: Address
  multicall3: Address
  /** WETH, or WHYPE on Elysium. */
  wrappedNative: { symbol: WrappedSymbol; address: Address; decimals: 18 }
  chargeCurrencies: readonly ChargeCurrency[]
  /**
   * How the chain finalizes, for the "Included" then "Finalized" receipt states (spec §1.3): a delay is never a failure.
   * `aboutMinutes` is the spec's figure, only ever said as "usually about"; what decides "Finalized" is the chain's own
   * `finalized` block. `profile` is the profile's words.
   */
  finality: { aboutMinutes: number; profile: string }
  /**
   * How the sequencer orders transactions, for the gas policy (spec open point 21): Nitro (Robinhood, Arbitrum) orders by
   * arrival, so a priority fee buys nothing; the OP Stack (Base) orders by priority fee.
   */
  ordering: 'arrival' | 'priority-fee'
  /** Base (OP Stack) charges an L1 data fee beside gasUsed (the receipt's l1Fee); on Nitro gasUsed already includes it. */
  l1FeeInReceipt: boolean
  /**
   * Changed on purpose (data) 2026-10-02 (Domino V2, post-B4 review F5): the OP Stack's GasPriceOracle predeploy, from the
   * profile's verification list (`opGasPriceOracle`), asked through the wallet for an upper bound of a step's L1 data fee
   * before the step is offered (finance/v2/transact.ts l1FeeCeiling); null on Nitro, where gasUsed already includes it.
   */
  l1FeeOracle: Address | null
  /**
   * How the chain's native currency gets its dollar price (added 2026-11-06, Elysium readiness; read-v6 README "A chain
   * without Chainlink"): `chainlink`, the profile's Chainlink ETH/USD feed (Robinhood Chain, Base, Arbitrum One); `pool`,
   * the one native/stable pool the profile names (`gasPrice.poolNativeUsd`: Elysium's HYPE, which Chainlink does not
   * serve). Where it is `pool`, what only the native currency could value says no_qualified_price_source while that pool
   * does not qualify, as a stale feed says eth_usd_stale on the others.
   */
  nativeUsd: 'chainlink' | 'pool'
  /** The bridges the profile names for Bring funds (S2): Relay and Across today; none on a new chain until they serve it, and S2 stays off there. */
  bridgeProviders: readonly string[]
  /**
   * Changed on purpose (data) 2026-10-02 (Domino V2 S1, B2.4): keccak256 of the runtime code the profile's
   * `verification.contracts` recorded for the Uniswap contracts an owner calls directly, without the zap
   * (finance/v2/direct.ts: exit to both tokens and collect, spec §2.6.4), matched by ADDRESS to the profile's own
   * `uniswap` addresses. Checked against `eth_getCode` before the first write, as V1's position client does.
   */
  verifiedCode: {
    /** Null, with `uniswap.v3`, on a chain without v3. */
    v3Factory: `0x${string}` | null
    v3PositionManager: `0x${string}` | null
    v4PositionManager: `0x${string}`
    v4StateView: `0x${string}`
  }
}

/** The slugs of the chains V2 knows: its three, and Elysium for the day it is one (./elysium.ts). */
export type V2Slug = 'robinhood' | 'base' | 'arbitrum' | 'elysium'

/**
 * What the app itself holds of a chain it serves, beside its profile (added 2026-11-06, Elysium readiness): the profile
 * must agree with it, or the chain is refused. The words a screen says (its name, its currencies) and the spec's figures
 * (finality, Base's extra fee tiers) live here, so a new chain is one row and its profile.
 */
export interface V2ChainFacts {
  slug: V2Slug
  name: string
  nativeSymbol: NativeSymbol
  wrappedSymbol: WrappedSymbol
  /** Hard finality, in minutes (spec §1.3, from the profile's `finality`): only ever said as "usually about"; never a deadline. */
  finalityMinutes: number
  /** v3 fee tiers the profile does not list, read from the chain's own factory. */
  extraV3Tiers?: Readonly<Record<number, number>>
  /**
   * The Uniswap versions the app holds for the chain (added 2026-11-06, Elysium readiness): its profile must name
   * exactly these, or the chain is refused. Absent means both, v3 and v4: a chain's profile never drops v3 unless its
   * row says so.
   */
  dexes?: readonly Dex[]
}

/** Uniswap v3 and v4: the versions of Robinhood Chain, Base and Arbitrum One, and of any chain whose facts name none. */
export const BOTH_DEXES: readonly Dex[] = Object.freeze([3, 4] as const)

interface Profile {
  chainId: number | null
  slug: string
  name: string
  enabled: boolean
  nativeSymbol: string
  stack: string
  uniswap?: {
    v3: { factory: string; positionManager: string; poolInitCodeHash: string; tickSpacingByFee: Record<string, number> } | null
    v4: { poolManager: string; positionManager: string; stateView: string } | null
    universalRouter: { address: string; version: string }
  }
  permit2?: string
  multicall3?: string
  wrappedNative?: { symbol: string; address: string; decimals: number }
  chargeCurrencies?: { rank: number; symbol: string; address: string; decimals: number; native?: boolean }[]
  finality?: string
  gasPrice?: { chainlinkEthUsd?: unknown; poolNativeUsd?: unknown }
  bridge?: { providers?: unknown }
  verification?: { contracts?: { name?: string; address?: string; codehash?: string | null }[] }
}

/** The OP Stack GasPriceOracle the profile's verification list names: exactly one, at its fixed predeploy address. */
function l1Oracle(raw: Profile): Address {
  const found = (raw.verification?.contracts ?? []).filter((entry) => entry.name === 'opGasPriceOracle')
  const at = found.length === 1 && typeof found[0].address === 'string' ? found[0].address.toLowerCase() : ''
  if (at !== '0x420000000000000000000000000000000000000f') throw new Error(`invalid_chain_profile: ${raw.slug} L1 fee oracle`)
  return at as Address
}

/** The code hash the profile's verification list recorded at `address` (matched by address, never by name). */
function verifiedHash(raw: Profile, address: string, what: string): `0x${string}` {
  const at = address.toLowerCase()
  const found = (raw.verification?.contracts ?? []).filter((entry) => typeof entry.address === 'string' && entry.address.toLowerCase() === at)
  const hash = found.length === 1 ? found[0].codehash : null
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error(`invalid_chain_profile: ${raw.slug} ${what} code hash`)
  return hash.toLowerCase() as `0x${string}`
}

/**
 * Base's extra v3 fee tiers, 0.02%, 0.03% and 0.04% (fee 200/300/400 → tick spacing 4/6/8). The profile lists the four
 * standard tiers only; these were read from Base's v3 factory (`feeAmountTickSpacing`) on 2026-10-02 (spec §1.4, D16:
 * the unit is the pool fee's, hundredths of a basis point, not "bps"). A tier outside the table is read from the
 * factory (`feeAmountTickSpacing(fee)`) before it is used.
 */
export const BASE_EXTRA_V3_TIERS: Readonly<Record<number, number>> = Object.freeze({ 200: 4, 300: 6, 400: 8 })

/**
 * The chains V2 serves, by id: Robinhood ~13 min and Arbitrum One ~13 min after their batch is posted to Ethereum
 * (itself within minutes), Base ~20 min (L1 batch finality); Base carries its extra fee tiers. Changed on purpose
 * 2026-11-06 (Elysium readiness): the figures were a table of their own, and the native and wrapped symbols, the slug
 * and the name were literals in the parser below; one row per chain now. Changed on purpose 2026-11-06 (Elysium
 * readiness, a chain with v4 only): each row names its Uniswap versions, both on these three, so their profiles must
 * still name v3. Changed on purpose 2026-11-07 (Elysium as a fourth V2 chain): Elysium's row, from ./elysium.ts (HYPE,
 * WHYPE, about 12 minutes to finalized, v4 alone), where it is live; its profile must then name `uniswap.v3` null.
 */
const ELYSIUM_FACTS: Partial<Record<V2ChainId, V2ChainFacts>> = ELYSIUM_LIVE
  ? { [ELYSIUM_V2_ID]: Object.freeze({ slug: ELYSIUM.slug, name: ELYSIUM.name, nativeSymbol: ELYSIUM.nativeSymbol, wrappedSymbol: ELYSIUM.wrappedSymbol, finalityMinutes: ELYSIUM.finalityMinutes, dexes: ELYSIUM.dexes }) }
  : {}
export const V2_CHAIN_FACTS: Readonly<Record<V2ChainId, V2ChainFacts>> = Object.freeze({
  4663: Object.freeze({ slug: 'robinhood', name: ROBINHOOD_NAME, nativeSymbol: 'ETH', wrappedSymbol: 'WETH', finalityMinutes: 13, dexes: BOTH_DEXES }),
  8453: Object.freeze({ slug: 'base', name: BASE_NAME, nativeSymbol: 'ETH', wrappedSymbol: 'WETH', finalityMinutes: 20, extraV3Tiers: BASE_EXTRA_V3_TIERS, dexes: BOTH_DEXES }),
  42161: Object.freeze({ slug: 'arbitrum', name: ARBITRUM_NAME, nativeSymbol: 'ETH', wrappedSymbol: 'WETH', finalityMinutes: 13, dexes: BOTH_DEXES }),
  ...ELYSIUM_FACTS,
} as Record<V2ChainId, V2ChainFacts>)

const lower = (value: string, what: string): Address => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`invalid_chain_profile: ${what}`)
  return value.toLowerCase() as Address
}

/**
 * The chain's charge currencies (spec §2.8), as the profile lists them, held to the rank rule: exactly one stable at
 * rank 1 (never the native currency), and at rank 2 exactly the chain's native currency at address(0) and its wrapped
 * token, each with the chain's own symbol and 18 decimals (ETH and WETH, or HYPE and WHYPE). Added 2026-11-06 (Elysium
 * readiness): rank 2 was taken on trust as "ETH and WETH"; a profile outside the rule is refused rather than ranked.
 */
function currenciesOf(raw: Profile, facts: V2ChainFacts, wrapped: Address): ChargeCurrency[] {
  const currencies = (raw.chargeCurrencies ?? []).map((c) => ({
    rank: c.rank, symbol: c.symbol, address: lower(c.address, `charge currency ${c.symbol}`), decimals: c.decimals, native: c.native === true,
  }))
  const stables = currencies.filter((c) => c.rank === 1)
  const second = currencies.filter((c) => c.rank === 2)
  const native = second.filter((c) => c.native && c.address === ZERO_ADDRESS && c.symbol === facts.nativeSymbol && c.decimals === 18)
  const token = second.filter((c) => !c.native && c.address === wrapped && c.symbol === facts.wrappedSymbol && c.decimals === 18)
  if (currencies.length !== 3 || stables.length !== 1 || stables[0].native || stables[0].address === ZERO_ADDRESS || second.length !== 2
    || native.length !== 1 || token.length !== 1) {
    throw new Error(`invalid_chain_profile: ${raw.slug} charge currencies`)
  }
  return currencies
}

/** The profile's dollar source for its native currency: its Chainlink feed, or else its one native/stable pool; one of the two. */
function nativeUsdOf(raw: Profile): V2Chain['nativeUsd'] {
  const feed = raw.gasPrice?.chainlinkEthUsd != null, pool = raw.gasPrice?.poolNativeUsd != null
  if (feed === pool) throw new Error(`invalid_chain_profile: ${raw.slug} gas price`)
  return feed ? 'chainlink' : 'pool'
}

/**
 * The profile's Uniswap versions, held to the app's row (added 2026-11-06, Elysium readiness): v4 always (every V2 screen
 * and client stands on it), v3 only where the profile names it, and exactly the versions the row says (both, unless the
 * row says v4 alone). A profile without v4, or whose versions differ from the row's, is refused: Robinhood Chain, Base
 * and Arbitrum One keep requiring both, and a chain loses v3 only by its own row and its own profile together.
 */
function dexesOf(raw: Profile, facts: V2ChainFacts): readonly Dex[] {
  const uniswap = raw.uniswap
  const want = facts.dexes ?? BOTH_DEXES
  // `null` is the profile's word for "no v3 here"; a missing key is a broken profile, refused.
  const v3Named = uniswap !== undefined && Object.hasOwn(uniswap, 'v3')
  const named: Dex[] = uniswap?.v3 != null ? [3, 4] : [4]
  if (uniswap?.v4 == null || !v3Named || named.length !== want.length || named.some((dex, index) => dex !== want[index])) {
    throw new Error(`invalid_chain_profile: ${raw.slug} uniswap versions`)
  }
  return want === BOTH_DEXES ? BOTH_DEXES : Object.freeze(named)
}

function chainOf(raw: Profile, facts: V2ChainFacts): V2Chain {
  const id = raw.chainId as V2ChainId
  if (!raw.enabled || !raw.uniswap || !raw.permit2 || !raw.multicall3 || !raw.wrappedNative || !raw.chargeCurrencies || !raw.finality) {
    throw new Error(`invalid_chain_profile: ${raw.slug} is incomplete`)
  }
  const dexes = dexesOf(raw, facts)
  const v3 = raw.uniswap.v3
  const v4 = raw.uniswap.v4 as NonNullable<typeof raw.uniswap.v4>
  if (raw.slug !== facts.slug) throw new Error(`invalid_chain_profile: slug ${raw.slug}`)
  if (raw.nativeSymbol !== facts.nativeSymbol) throw new Error(`invalid_chain_profile: ${raw.slug} native`)
  if (raw.stack !== 'arbitrum-nitro' && raw.stack !== 'op-stack') throw new Error(`invalid_chain_profile: ${raw.slug} stack`)
  if (raw.uniswap.universalRouter.version !== '2.1.2') throw new Error(`invalid_chain_profile: ${raw.slug} universal router`)
  if (raw.wrappedNative.symbol !== facts.wrappedSymbol || raw.wrappedNative.decimals !== 18) throw new Error(`invalid_chain_profile: ${raw.slug} wrapped native`)
  const wrapped = lower(raw.wrappedNative.address, 'wrapped native')
  const chargeCurrencies = currenciesOf(raw, facts, wrapped)
  if (!v3 && facts.extraV3Tiers) throw new Error(`invalid_chain_profile: ${raw.slug} v3 tiers`)
  const tiers: Record<number, number> = {}
  for (const [fee, spacing] of Object.entries(v3?.tickSpacingByFee ?? {})) tiers[Number(fee)] = spacing
  if (facts.extraV3Tiers) Object.assign(tiers, facts.extraV3Tiers)
  return Object.freeze({
    chainId: id,
    hex: `0x${id.toString(16)}` as `0x${string}`,
    slug: facts.slug,
    name: facts.name,
    nativeSymbol: facts.nativeSymbol,
    stack: raw.stack,
    uniswap: Object.freeze({
      v3: v3 ? Object.freeze({
        factory: lower(v3.factory, 'v3 factory'),
        positionManager: lower(v3.positionManager, 'v3 position manager'),
        poolInitCodeHash: v3.poolInitCodeHash.toLowerCase() as `0x${string}`,
        tickSpacingByFee: Object.freeze(tiers),
      }) : null,
      v4: Object.freeze({
        poolManager: lower(v4.poolManager, 'v4 pool manager'),
        positionManager: lower(v4.positionManager, 'v4 position manager'),
        stateView: lower(v4.stateView, 'v4 state view'),
      }),
      universalRouter: Object.freeze({ address: lower(raw.uniswap.universalRouter.address, 'universal router'), version: '2.1.2' as const }),
    }),
    dexes,
    permit2: lower(raw.permit2, 'permit2'),
    multicall3: lower(raw.multicall3, 'multicall3'),
    wrappedNative: Object.freeze({ symbol: facts.wrappedSymbol, address: wrapped, decimals: 18 as const }),
    chargeCurrencies: Object.freeze(chargeCurrencies.map((c) => Object.freeze(c))),
    finality: Object.freeze({ aboutMinutes: facts.finalityMinutes, profile: raw.finality }),
    ordering: raw.stack === 'op-stack' ? 'priority-fee' : 'arrival',
    l1FeeInReceipt: raw.stack === 'op-stack',
    l1FeeOracle: raw.stack === 'op-stack' ? l1Oracle(raw) : null,
    nativeUsd: nativeUsdOf(raw),
    bridgeProviders: Object.freeze(Array.isArray(raw.bridge?.providers) ? raw.bridge.providers.filter((name): name is string => typeof name === 'string') : []),
    verifiedCode: Object.freeze({
      v3Factory: v3 ? verifiedHash(raw, v3.factory, 'v3 factory') : null,
      v3PositionManager: v3 ? verifiedHash(raw, v3.positionManager, 'v3 position manager') : null,
      v4PositionManager: verifiedHash(raw, v4.positionManager, 'v4 position manager'),
      v4StateView: verifiedHash(raw, v4.stateView, 'v4 state view'),
    }),
  })
}

/**
 * The chains served from a set of profiles: one for each id of `ids`, in that order, from its profile and its row of
 * `facts`. A profile of any other chain id, or of none (a pending placeholder), is ignored: a chain the app does not
 * list yet never enters, and never fails the build or the page (added 2026-11-06, Elysium readiness). A listed chain
 * whose profile is missing, repeated, disabled or out of its rules fails, as it always did. Pure: the tests run it on
 * both layouts of the profiles directory (tests/v2/chain-layouts.test.mjs).
 */
export function chainsFrom(profiles: readonly unknown[], ids: readonly number[], facts: Readonly<Record<number, V2ChainFacts>>): readonly V2Chain[] {
  const found = new Map<number, V2Chain>()
  for (const raw of profiles) {
    const id = raw !== null && typeof raw === 'object' ? (raw as { chainId?: unknown }).chainId : undefined
    if (typeof id !== 'number' || !ids.includes(id)) continue
    if (found.has(id)) throw new Error(`invalid_chain_profile: chainId ${id} twice`)
    const known = Object.hasOwn(facts, id) ? facts[id] : undefined
    if (!known) throw new Error(`invalid_chain_profile: chainId ${id} has no facts`)
    found.set(id, chainOf(raw as Profile, known))
  }
  return Object.freeze(ids.map((id) => {
    const chain = found.get(id)
    if (!chain) throw new Error(`invalid_chain_profile: chainId ${id} has no profile`)
    return chain
  }))
}

/**
 * Robinhood, Base and Arbitrum One, in that order (the order of the chain picker until the owner decides another; open
 * point 23), then Elysium where it is live (its profile handed in by the build, ./elysiumFiles.ts).
 */
export const V2_CHAINS: readonly V2Chain[] = chainsFrom([robinhoodProfile, baseProfile, arbitrumProfile, ...(ELYSIUM_PROFILE === null ? [] : [ELYSIUM_PROFILE])], V2_CHAIN_IDS, V2_CHAIN_FACTS)

/** One of the chains V2 serves (config/chainIdentity.ts V2_CHAIN_IDS, the app's one list). */
export function isV2ChainId(value: unknown): value is V2ChainId {
  return typeof value === 'number' && V2_CHAIN_IDS.includes(value)
}

/** The chain's profile; throws for any chain V2 does not serve. */
export function v2Chain(chainId: number): V2Chain {
  const chain = V2_CHAINS.find((c) => c.chainId === chainId)
  if (!chain) throw new Error('chain_not_supported')
  return chain
}

/**
 * A token's charge-currency rank on a chain (spec §2.8): 1 the stable, 2 the native currency (address(0)) and its wrapped
 * token (ETH and WETH; HYPE and WHYPE on Elysium), 0 when it is not a charge currency. From the profile until a deployment exists; then from `registry.chargeCurrencyRank(token)`.
 */
export function profileRank(chain: V2Chain, token: string): number {
  const t = token.toLowerCase()
  return chain.chargeCurrencies.find((c) => c.address === t)?.rank ?? 0
}

/**
 * The v3 tick spacing for a fee tier, from the profile; null for a tier outside the table (read the factory then, through
 * `v3Of`), and for every tier on a chain without v3.
 */
export function v3TickSpacing(chain: V2Chain, fee: number): number | null {
  const v3 = chain.uniswap.v3
  return v3 && Object.hasOwn(v3.tickSpacingByFee, fee) ? v3.tickSpacingByFee[fee] : null
}

/**
 * Whether the chain has Uniswap `dex` (3 or 4), from its profile (added 2026-11-06, Elysium readiness): the one question
 * every list, picker, plan, client and read asks before anything of a version. True for both on Robinhood Chain, Base
 * and Arbitrum One; false for 3 on a chain without v3 (Elysium); false for anything that is not 3 or 4.
 */
export const hasDex = (chain: Pick<V2Chain, 'dexes'>, dex: unknown): dex is Dex => (dex === 3 || dex === 4) && chain.dexes.includes(dex)

/** The same question by chain id, for a screen that holds only the id: false for a chain V2 does not serve. */
export function chainHasDex(chainId: number, dex: unknown): dex is Dex {
  const chain = V2_CHAINS.find((c) => c.chainId === chainId)
  return chain !== undefined && hasDex(chain, dex)
}

/**
 * The chain's Uniswap v3, for a path that is v3 only; `dex_not_on_chain` on a chain without v3, so nothing of v3 is
 * read, planned or sent there even if a caller forgot to ask `hasDex` first.
 */
export function v3Of(chain: V2Chain): V3Deployment {
  if (!chain.uniswap.v3) throw new Error('dex_not_on_chain')
  return chain.uniswap.v3
}

/**
 * The chain's Uniswap position manager of a version: v3's NonfungiblePositionManager or v4's PositionManager;
 * `dex_not_on_chain` for a version the chain lacks.
 */
export function positionManagerOf(chain: V2Chain, dex: Dex): Address {
  return dex === 4 ? chain.uniswap.v4.positionManager : v3Of(chain).positionManager
}

/** The chain's position managers by version: both on Robinhood Chain, Base and Arbitrum One; v4's alone without v3. */
export const positionManagers = (chain: V2Chain): Readonly<Partial<Record<Dex, Address>>> =>
  Object.freeze(Object.fromEntries(chain.dexes.map((dex) => [dex, positionManagerOf(chain, dex)])))

/** The same, or null for a version the chain lacks: for a screen that names a position's manager and must never throw. */
export const positionManagerOrNull = (chain: V2Chain, dex: unknown): Address | null => (hasDex(chain, dex) ? positionManagerOf(chain, dex) : null)

/** "Add {chain} to your wallet, then try again." (spec §1.3, §2.12: a wallet's 4902). */
export const addChainCopy = (chain: V2Chain): string => `Add ${chain.name} to your wallet, then try again.`

/**
 * The bundled picture of a chain's native currency and of its wrapped token (public/tokens): Ether's and WETH's on an
 * Ether chain. A chain whose native currency is another (HYPE) has none bundled: its marks are then the token marks'
 * own (components/TokenIcon.tsx TokenMark: DEX Screener's picture by chain and address, else the plain disc), as for
 * any other token. Added 2026-11-06 (Elysium readiness): the screens drew ETH's picture for address(0) on every chain.
 */
export const nativeArtwork = (chain: Pick<V2Chain, 'nativeSymbol'>): 'ETH' | null => (chain.nativeSymbol === 'ETH' ? 'ETH' : null)
export const wrappedArtwork = (chain: Pick<V2Chain, 'wrappedNative'>): 'WETH' | null => (chain.wrappedNative.symbol === 'WETH' ? 'WETH' : null)

/**
 * What a network pays its fees in, at address(0): a V2 chain's own native currency (ETH, or HYPE on Elysium), and ETH on
 * every other network the app reads (Ethereum and OP Mainnet). Added 2026-11-06 (Elysium readiness).
 */
export const nativeSymbolOf = (chainId: number): NativeSymbol => V2_CHAINS.find((chain) => chain.chainId === chainId)?.nativeSymbol ?? 'ETH'

/**
 * A sentence written for an Ether chain (the copy tables' "Paying with ETH needs a direct transaction.", "On this pool,
 * unused ETH comes back as WETH."), in a chain's own currency: the whole words "ETH" and "WETH" become its native currency
 * and its wrapped token (HYPE and WHYPE on a HYPE-native chain). On an Ether chain the sentence is returned as it is.
 * Added 2026-11-06 (Elysium readiness), so one English text serves every chain.
 */
export function inChainCurrency(text: string, chain: Pick<V2Chain, 'nativeSymbol' | 'wrappedNative'>): string {
  if (chain.nativeSymbol === 'ETH' && chain.wrappedNative.symbol === 'WETH') return text
  return text.replace(/\bWETH\b/g, chain.wrappedNative.symbol).replace(/\bETH\b/g, chain.nativeSymbol)
}
