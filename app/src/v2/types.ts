/**
 * Domino V2's on-chain shapes, as the app holds them (spec F7 §2.3, §4.2, §5.1; contracts/src/v2/DominoV2Types.sol).
 *
 * Plain types and constants only: no viem, no wallet, so a screen may import them without reaching the wallet feature
 * (tests/session.source-guard.test.mjs). Every integer that the contract holds wider than 32 bits is a bigint, never a
 * JS number; a tick, a fee tier, a basis-point figure and an enum code fit a number exactly.
 *
 * Every V2 object carries its chain (spec §1.3): the V2 contracts have the same address on every chain, so an address
 * alone never says which chain a pool, a plan, a signature or an approval belongs to.
 */

export type Address = `0x${string}`
export type Hex = `0x${string}`

/** The chains V2 serves (spec §1.2). Elysium is not one of them until its mainnet exists (api-contracts/v2/chains/elysium.json). */
export type V2ChainId = 4663 | 8453 | 42161

/** `PoolRef.dex`: 3 is Uniswap v3, 4 is Uniswap v4. No forks. */
export type Dex = 3 | 4

export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

/** `PoolRef(uint8 dex, address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)`. */
export interface PoolRef {
  dex: Dex
  currency0: Address
  currency1: Address
  /** The pool's fee in hundredths of a basis point (pips): 100, 500, 3000, 10000, and on Base also 200, 300, 400. */
  fee: number
  tickSpacing: number
  /** Always zero on v3. A v4 pool with a hook is refused for positions (spec §1.4). */
  hooks: Address
}

/** `PositionIntent.action`. */
export const ACTION = { create: 1, increase: 2, changeRange: 3, exit: 4 } as const
export type ActionCode = (typeof ACTION)[keyof typeof ACTION]
export type ActionName = keyof typeof ACTION

/** What the owner signs or sends for every S1 action (spec §2.3). */
export interface PositionIntent {
  action: ActionCode
  pool: PoolRef
  tokenId: bigint
  tickLower: number
  tickUpper: number
  minLiquidity: bigint
  /** 65 with swap legs, 0 without (spec §2.8). */
  feeBps: number
  /** The rank rule's token with legs (address(0) is native ETH), address(0) without. */
  feeToken: Address
  /** keccak256(abi.encode(SwapLeg[] legs)). */
  routesHash: Hex
  recipient: Address
  nonce: bigint
  /** Unix seconds; after it the zap reverts PlanExpired. */
  deadline: bigint
}

/** `TokenAmount { address token; uint128 amount; }`; native ETH is address(0). */
export interface TokenAmount {
  token: Address
  amount: bigint
}

/** `SwapLeg.kind`: 1 Universal Router, 2 a v3 path, 3 a v4 path (spec §2.3). */
export const LEG_KIND = { universalRouter: 1, v3Path: 2, v4Path: 3 } as const
export type LegKind = (typeof LEG_KIND)[keyof typeof LEG_KIND]

/** `SwapLeg { uint8 kind; address router; address tokenIn; address tokenOut; uint128 amountIn; uint128 minAmountOut; bytes data; }`. */
export interface SwapLeg {
  kind: LegKind
  /** The chain's Universal Router 2.1.2 for kind 1; address(0) for a pool path. */
  router: Address
  tokenIn: Address
  tokenOut: Address
  amountIn: bigint
  minAmountOut: bigint
  data: Hex
}

export interface CreatePlan {
  intent: PositionIntent
  inputs: readonly TokenAmount[]
  legs: readonly SwapLeg[]
  amount0Max: bigint
  amount1Max: bigint
  /** Not zero initializes a pool that has no price yet; nothing else. */
  initSqrtPriceX96: bigint
}

export interface IncreasePlan {
  intent: PositionIntent
  inputs: readonly TokenAmount[]
  legs: readonly SwapLeg[]
  amount0Max: bigint
  amount1Max: bigint
}

export interface ChangeRangePlan {
  intent: PositionIntent
  liquidityToRemove: bigint
  amount0MinRemoved: bigint
  amount1MinRemoved: bigint
  legs: readonly SwapLeg[]
  amount0Max: bigint
  amount1Max: bigint
  burnOld: boolean
}

export interface ExitPlan {
  intent: PositionIntent
  /** Zero collects the fees only. */
  liquidityToRemove: bigint
  amount0MinRemoved: bigint
  amount1MinRemoved: bigint
  legs: readonly SwapLeg[]
  burn: boolean
}

export type ZapPlan =
  | { action: 'create'; plan: CreatePlan }
  | { action: 'increase'; plan: IncreasePlan }
  | { action: 'changeRange'; plan: ChangeRangePlan }
  | { action: 'exit'; plan: ExitPlan }

/** Permit2's `PermitBatchTransferFrom { TokenPermissions[] permitted; uint256 nonce; uint256 deadline; }`, as the zap takes it. */
export interface PermitBatch {
  permitted: readonly TokenAmount[]
  nonce: bigint
  deadline: bigint
}

/** `RelayedPositionAction`: what the NFT's owner signs for a relayed change of range or exit (spec §2.5.3). */
export interface RelayedPositionAction {
  intent: PositionIntent
  liquidityToRemove: bigint
  amount0MinRemoved: bigint
  amount1MinRemoved: bigint
  /** Zero for an exit. */
  amount0Max: bigint
  amount1Max: bigint
  /** The plan's `burn` (exit) or `burnOld` (change range). */
  burn: boolean
}

/** `ExitMandate.receiveMode`: 0 RECEIVE_BOTH, 1 RECEIVE_CONVERTED. Never inferred from `convertTo`. */
export const RECEIVE_MODE = { both: 0, converted: 1 } as const
export type ReceiveMode = (typeof RECEIVE_MODE)[keyof typeof RECEIVE_MODE]

/** The auto-exit order the vault's owner signs (spec §4.2). */
export interface ExitMandate {
  owner: Address
  vault: Address
  tokenId: bigint
  /** Fires with the anchor at or below this (token1 per token0, Q64.96); zero turns it off. */
  triggerBelowSqrtPriceX96: bigint
  /** Fires with the anchor at or above this; zero turns it off. */
  triggerAboveSqrtPriceX96: bigint
  receiveMode: ReceiveMode
  /** address(0) with mode 0; currency0 or currency1 with mode 1 (address(0) is ETH on v4). */
  convertTo: Address
  /** 1 to 1000; on top of the pool's own fee. */
  maxSlippageBps: number
  validUntil: bigint
  nonce: bigint
}

/** The vault's `Policy` (spec §5.2). */
export interface VaultPolicy {
  /** 1 MODE_SIMPLE (2%), 2 MODE_DOMINO (4%). */
  mode: 1 | 2
  triggerDistanceBps: number
  maxOverlapBps: number
  minimumIntervalSeconds: number
  maxPositions: number
}

/** The vault's `Limits` (spec §5.2). */
export interface VaultLimits {
  /** On top of the pool's fee. */
  maxSlippageBps: number
  /** The band between the reference price and the pool's price, not a swap's impact (D14). */
  maxPriceImpactBps: number
  maxObservationAgeSeconds: number
  upsideBps: number
}

/** `PositionRef { uint8 dex; address positionManager; uint256 tokenId }`. */
export interface PositionRef {
  dex: Dex
  positionManager: Address
  tokenId: bigint
}

/** `factory.createVault(Init, nonce)`'s Init (spec §5.1). */
export interface VaultInit {
  root: PositionRef
  policy: VaultPolicy
  limits: VaultLimits
  startPaused: boolean
  /** Must be true, or the factory reverts InvalidInit. */
  consentToUncollectedFees: boolean
}

/**
 * The fee constants of contracts/src/v2/DominoV2Types.sol (spec §1.6). Changed on purpose (data) 2026-10-02 (Domino V2
 * rev2 §7): `bridgeAppBps`, the S2 convenience fee (0.35%, F5), which a deployment manifest's `policies` pins too
 * (`bridgeAppFeeBps`, src/v2/manifest.ts MANIFEST_POLICIES).
 */
export const V2_FEES = {
  assistedSwapBps: 65,
  bridgeAppBps: 35,
  automationSimpleBps: 200,
  automationDominoBps: 400,
  autoExitBps: 20,
} as const

/** `FeeCharged.kind`. */
export const FEE_KIND = { assistedSwap: 1, automation: 2, autoExit: 3 } as const

/** The anchor's windows the app checks a manifest against (spec §4.3, §7.3): a signed v4 observation, a v3 TWAP. */
export const V2_WINDOWS = { v4ObservationMaxSeconds: 300, v3TwapMinSeconds: 600 } as const

/**
 * The Domino V2 components the app calls (spec rev2 §7.2: `zap.v3`, `zap.v4`, `vaultFactory.v3`, `vaultFactory.v4`,
 * `autoExit`, `registry` and `priceAnchor`, the TWAP of §5.2). Changed on purpose (data) 2026-10-02 (Domino V2 rev2 §7):
 * `priceAnchor` added.
 */
export type V2Component = 'registry' | 'priceAnchor' | 'autoExit' | 'zapV3' | 'zapV4' | 'vaultFactoryV3' | 'vaultFactoryV4'

/**
 * Changed on purpose (data) 2026-10-02 (Domino V2 rev2 §7): every Domino V2 contract whose runtime code
 * finance/v2/deployment.ts verifyV2Code can check before a write: the components the app calls, and the ones it reaches
 * through them (each vault implementation and the executor it created, the vault's swap module, the v4 zap's steps),
 * which a set carries in `deployment` only.
 */
export type V2CodeComponent = V2Component | 'vaultSwap' | 'vaultV3' | 'vaultV4' | 'zapV4Steps' | 'vaultExecutorV3' | 'vaultExecutorV4'

/** The 13 contracts of a deployment manifest, by the manifest's own names (#302; spec rev2 §7.2). */
export type V2ManifestContract =
  | 'registry' | 'priceAnchor' | 'autoExit' | 'vaultSwap' | 'vault.v3' | 'vault.v4' | 'vaultFactory.v3' | 'vaultFactory.v4'
  | 'zap.v4.steps' | 'zap.v3' | 'zap.v4' | 'vaultExecutor.v3' | 'vaultExecutor.v4'
/** The eleven deployCreate3 components (the two executors are their vault implementation's first CREATE). */
export type V2DeployedComponent = Exclude<V2ManifestContract, 'vaultExecutor.v3' | 'vaultExecutor.v4'>
/** A manifest's `environment`. Only `public-chain-preparation` is ever a production deployment. */
export type V2Environment = 'public-chain-preparation' | 'fork-rehearsal' | 'local-test'
/** The admission a manifest passed (backend/v2_manifest.py ADMISSIONS): `production`, or one of the two test ones. */
export type V2Admission = 'production' | 'fork-rehearsal' | 'local-test'

/**
 * Changed on purpose (data) 2026-10-02 (Domino V2 rev2 §7): what a set's manifest says beyond the components the app
 * calls, kept for finance/v2/deployment.ts: the CREATE3 prediction it re-derives from `deployer` (every address, raw and
 * guarded salt), the source tree's SHA-256, and the 13 contracts with their runtime code hashes.
 */
export interface V2DeploymentFacts {
  readonly environment: V2Environment
  readonly admission: V2Admission
  readonly releaseTag: string
  readonly sourceCommit: string
  /** `roles.deployer`: every CREATE3 salt starts with it. */
  readonly deployer: Address
  readonly createx: Address
  /** All 13 contracts (lowercase) and their runtime code hashes, by the manifest's names. */
  readonly contracts: Readonly<Record<V2ManifestContract, Address>>
  readonly codeHashes: Readonly<Record<V2ManifestContract, Hex>>
  readonly salts: Readonly<Record<V2DeployedComponent, Hex>>
  readonly guardedSalts: Readonly<Record<V2DeployedComponent, Hex>>
  readonly sourceHashes: Readonly<Record<string, string>>
  readonly sourceTreeSha256: string
}

/**
 * The Domino V2 contracts the app uses on ONE chain, from that chain's pinned deployment manifest only (spec §7.3):
 * never from an API reply, never a fallback address. Built by src/v2/manifest.ts; the money clients take it as given
 * and check every component's runtime code against `codeHashes` before their first write (finance/v2/deployment.ts).
 */
export interface V2Contracts {
  chainId: V2ChainId
  addresses: Readonly<Record<V2Component, Address>>
  /** keccak256 of each component's runtime code, the manifest's `runtimeCodeHashes`. */
  codeHashes: Readonly<Record<V2Component, Hex>>
  /**
   * True when it came from a manifest under a TEST admission (fork-rehearsal or local-test: the FIXTURE manifests of
   * tests and the v2-test build). A fixture never reaches a deployable build (scripts/deploy-markers.mjs) and never
   * enables a real financial operation.
   */
  fixture: boolean
  /**
   * Changed on purpose (data) 2026-10-02 (Domino V2 rev2 §7), additive: the manifest's facts, on every set src/v2/manifest.ts
   * builds; absent from a set a test builds by hand. finance/v2/deployment.ts admitV2Contracts re-derives the CREATE3
   * prediction from them before a money client takes the set.
   */
  deployment?: V2DeploymentFacts
}
