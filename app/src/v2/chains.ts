/**
 * The chains Domino V2 serves, from the published chain profiles (api-contracts/v2/chains/*.json, spec F7 §1.2), read
 * at build time rather than copied by hand. Elysium's profile is imported only to prove it stays out: it is
 * `enabled: false`, with no chain id, until its mainnet and a qualified Uniswap deployment exist.
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
import elysiumProfile from '../../../api-contracts/v2/chains/elysium.json'
import type { Address, V2ChainId } from './types'

export interface ChargeCurrency {
  /** 1 is the chain's stable; 2 is ETH and WETH. Lower ranks first (spec §2.8). */
  rank: number
  symbol: string
  address: Address
  decimals: number
  native: boolean
}

export interface V2Chain {
  chainId: V2ChainId
  /** The chain id as wallets and EIP-5792 write it: '0x1237', '0x2105', '0xa4b1'. */
  hex: `0x${string}`
  slug: 'robinhood' | 'base' | 'arbitrum'
  /** Shown as written: "Robinhood Chain", "Base", "Arbitrum One". */
  name: string
  nativeSymbol: 'ETH'
  stack: 'arbitrum-nitro' | 'op-stack'
  uniswap: {
    v3: { factory: Address; positionManager: Address; poolInitCodeHash: `0x${string}`; tickSpacingByFee: Readonly<Record<number, number>> }
    v4: { poolManager: Address; positionManager: Address; stateView: Address }
    /** Only 2.1.2: versions 2.0 and 2.1.1 are switched off on 2026-10-21 (spec §1.2). */
    universalRouter: { address: Address; version: '2.1.2' }
  }
  permit2: Address
  multicall3: Address
  wrappedNative: { symbol: 'WETH'; address: Address; decimals: 18 }
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
   * Changed on purpose (data) 2026-10-02 (Domino V2 S1, B2.4): keccak256 of the runtime code the profile's
   * `verification.contracts` recorded for the Uniswap contracts an owner calls directly, without the zap
   * (finance/v2/direct.ts: exit to both tokens and collect, spec §2.6.4), matched by ADDRESS to the profile's own
   * `uniswap` addresses. Checked against `eth_getCode` before the first write, as V1's position client does.
   */
  verifiedCode: {
    v3Factory: `0x${string}`
    v3PositionManager: `0x${string}`
    v4PositionManager: `0x${string}`
    v4StateView: `0x${string}`
  }
}

interface Profile {
  chainId: number | null
  slug: string
  name: string
  enabled: boolean
  nativeSymbol: string
  stack: string
  uniswap?: {
    v3: { factory: string; positionManager: string; poolInitCodeHash: string; tickSpacingByFee: Record<string, number> }
    v4: { poolManager: string; positionManager: string; stateView: string }
    universalRouter: { address: string; version: string }
  }
  permit2?: string
  multicall3?: string
  wrappedNative?: { symbol: string; address: string; decimals: number }
  chargeCurrencies?: { rank: number; symbol: string; address: string; decimals: number; native?: boolean }[]
  finality?: string
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
 * Hard finality, in minutes (spec §1.3 from each profile's `finality`): Base ~20 min (L1 batch finality); Robinhood and
 * Arbitrum ~13 min after their batch is posted to Ethereum (itself within minutes). Never a deadline.
 */
const FINALITY_MINUTES: Readonly<Record<V2ChainId, number>> = { 4663: 13, 8453: 20, 42161: 13 }

const lower = (value: string, what: string): Address => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`invalid_chain_profile: ${what}`)
  return value.toLowerCase() as Address
}

function chainOf(raw: Profile): V2Chain {
  const id = raw.chainId
  if (id !== 4663 && id !== 8453 && id !== 42161) throw new Error(`invalid_chain_profile: chainId ${String(id)}`)
  if (!raw.enabled || !raw.uniswap || !raw.permit2 || !raw.multicall3 || !raw.wrappedNative || !raw.chargeCurrencies || !raw.finality) {
    throw new Error(`invalid_chain_profile: ${raw.slug} is incomplete`)
  }
  if (raw.slug !== 'robinhood' && raw.slug !== 'base' && raw.slug !== 'arbitrum') throw new Error(`invalid_chain_profile: slug ${raw.slug}`)
  if (raw.nativeSymbol !== 'ETH') throw new Error(`invalid_chain_profile: ${raw.slug} native`)
  if (raw.stack !== 'arbitrum-nitro' && raw.stack !== 'op-stack') throw new Error(`invalid_chain_profile: ${raw.slug} stack`)
  if (raw.uniswap.universalRouter.version !== '2.1.2') throw new Error(`invalid_chain_profile: ${raw.slug} universal router`)
  if (raw.wrappedNative.symbol !== 'WETH' || raw.wrappedNative.decimals !== 18) throw new Error(`invalid_chain_profile: ${raw.slug} WETH`)
  const tiers: Record<number, number> = {}
  for (const [fee, spacing] of Object.entries(raw.uniswap.v3.tickSpacingByFee)) tiers[Number(fee)] = spacing
  if (id === 8453) Object.assign(tiers, BASE_EXTRA_V3_TIERS)
  return Object.freeze({
    chainId: id,
    hex: `0x${id.toString(16)}` as `0x${string}`,
    slug: raw.slug,
    name: raw.name,
    nativeSymbol: 'ETH',
    stack: raw.stack,
    uniswap: Object.freeze({
      v3: Object.freeze({
        factory: lower(raw.uniswap.v3.factory, 'v3 factory'),
        positionManager: lower(raw.uniswap.v3.positionManager, 'v3 position manager'),
        poolInitCodeHash: raw.uniswap.v3.poolInitCodeHash.toLowerCase() as `0x${string}`,
        tickSpacingByFee: Object.freeze(tiers),
      }),
      v4: Object.freeze({
        poolManager: lower(raw.uniswap.v4.poolManager, 'v4 pool manager'),
        positionManager: lower(raw.uniswap.v4.positionManager, 'v4 position manager'),
        stateView: lower(raw.uniswap.v4.stateView, 'v4 state view'),
      }),
      universalRouter: Object.freeze({ address: lower(raw.uniswap.universalRouter.address, 'universal router'), version: '2.1.2' as const }),
    }),
    permit2: lower(raw.permit2, 'permit2'),
    multicall3: lower(raw.multicall3, 'multicall3'),
    wrappedNative: Object.freeze({ symbol: 'WETH' as const, address: lower(raw.wrappedNative.address, 'WETH'), decimals: 18 as const }),
    chargeCurrencies: Object.freeze(raw.chargeCurrencies.map((c) => Object.freeze({
      rank: c.rank, symbol: c.symbol, address: lower(c.address, `charge currency ${c.symbol}`), decimals: c.decimals, native: c.native === true,
    }))),
    finality: Object.freeze({ aboutMinutes: FINALITY_MINUTES[id], profile: raw.finality }),
    ordering: raw.stack === 'op-stack' ? 'priority-fee' : 'arrival',
    l1FeeInReceipt: raw.stack === 'op-stack',
    l1FeeOracle: raw.stack === 'op-stack' ? l1Oracle(raw) : null,
    verifiedCode: Object.freeze({
      v3Factory: verifiedHash(raw, raw.uniswap.v3.factory, 'v3 factory'),
      v3PositionManager: verifiedHash(raw, raw.uniswap.v3.positionManager, 'v3 position manager'),
      v4PositionManager: verifiedHash(raw, raw.uniswap.v4.positionManager, 'v4 position manager'),
      v4StateView: verifiedHash(raw, raw.uniswap.v4.stateView, 'v4 state view'),
    }),
  })
}

/** Robinhood, Base and Arbitrum One, in that order (the order of the chain picker until the owner decides another; open point 23). */
export const V2_CHAINS: readonly V2Chain[] = Object.freeze([robinhoodProfile, baseProfile, arbitrumProfile].map((raw) => chainOf(raw as Profile)))

/** Whether Elysium's profile is still switched off (it must be until its mainnet exists; spec §1.2). */
export const ELYSIUM_HIDDEN: boolean = (elysiumProfile as Profile).enabled === false && (elysiumProfile as Profile).chainId === null

export function isV2ChainId(value: unknown): value is V2ChainId {
  return value === 4663 || value === 8453 || value === 42161
}

/** The chain's profile; throws for any chain V2 does not serve. */
export function v2Chain(chainId: number): V2Chain {
  const chain = V2_CHAINS.find((c) => c.chainId === chainId)
  if (!chain) throw new Error('chain_not_supported')
  return chain
}

/**
 * A token's charge-currency rank on a chain (spec §2.8): 1 the stable, 2 ETH (address(0)) and WETH, 0 when it is not a
 * charge currency. From the profile until a deployment exists; then from `registry.chargeCurrencyRank(token)`.
 */
export function profileRank(chain: V2Chain, token: string): number {
  const t = token.toLowerCase()
  return chain.chargeCurrencies.find((c) => c.address === t)?.rank ?? 0
}

/** The v3 tick spacing for a fee tier, from the profile; null for a tier outside the table (read the factory then). */
export function v3TickSpacing(chain: V2Chain, fee: number): number | null {
  return Object.hasOwn(chain.uniswap.v3.tickSpacingByFee, fee) ? chain.uniswap.v3.tickSpacingByFee[fee] : null
}

/** "Add {chain} to your wallet, then try again." (spec §1.3, §2.12: a wallet's 4902). */
export const addChainCopy = (chain: V2Chain): string => `Add ${chain.name} to your wallet, then try again.`
