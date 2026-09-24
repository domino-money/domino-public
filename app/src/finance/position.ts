import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, numberToHex, zeroAddress, type Address, type Hex } from 'viem'
import { POSITION_MANAGER, STATE_VIEW, pinned } from './pin.js'
import { SLIPPAGE_MAX_BPS, SLIPPAGE_MIN_BPS } from './slippage.js'
import { SIGN_WINDOW_S, STEP_DEADLINE_S, type GasBudget, type WalletRpc } from './setup.js'

/*
 * The owner's own actions on a Uniswap v4 position NFT: collect its fees, or
 * close it. Both are one call from the owner's wallet to Uniswap's
 * PositionManager, `modifyLiquidities(abi.encode(actions, params), deadline)`
 * with no value, exactly as the v4 periphery encodes them:
 *
 *   collect  DECREASE_LIQUIDITY(tokenId, 0, 0, 0, '') then TAKE_PAIR(c0, c1, owner)
 *   close    DECREASE_LIQUIDITY(tokenId, all of it, min0, min1, '') then TAKE_PAIR
 *
 * Close keeps the NFT: it stays in the wallet with no liquidity, so it is
 * still listed as a closed position. TAKE_PAIR pays native ETH straight to the
 * owner, so a pool with ETH needs no unwrap. The minimums bound the principal
 * only, never the fees: the position manager checks them against the principal
 * it removed (SlippageCheck), so a minimum with fees in it would make every
 * close revert.
 *
 * Nothing here comes from Domino's service. The two contracts are the pinned
 * ones (./pin.ts), their code is checked through the wallet once per client,
 * and every read and send goes through the connected wallet's own provider,
 * like the setup client (./setup.ts), whose bounded-call, nonce and receipt
 * pattern this follows. It is a separate module because setup.ts is compiled
 * on its own by the backend suite and must not grow.
 */

/**
 * positionManagerAbi signatures:
 *   struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
 *   function modifyLiquidities(bytes, uint256) payable
 *   function ownerOf(uint256) view returns (address)
 *   function getPoolAndPositionInfo(uint256) view returns (PoolKey, uint256)
 *   function getPositionLiquidity(uint256) view returns (uint128)
 */
const poolKeyComponents = [{ type: 'address', name: 'currency0' }, { type: 'address', name: 'currency1' }, { type: 'uint24', name: 'fee' }, { type: 'int24', name: 'tickSpacing' }, { type: 'address', name: 'hooks' }] as const
export const positionManagerAbi = [
  { name: 'modifyLiquidities', type: 'function', stateMutability: 'payable', inputs: [{ type: 'bytes' }, { type: 'uint256' }], outputs: [] },
  { name: 'ownerOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { name: 'getPoolAndPositionInfo', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'tuple', components: poolKeyComponents }, { type: 'uint256' }] },
  { name: 'getPositionLiquidity', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint128' }] },
] as const
/**
 * stateViewAbi signatures:
 *   function getSlot0(bytes32) view returns (uint160, int24, uint24, uint24)
 *   function getPositionInfo(bytes32, address, int24, int24, bytes32) view returns (uint128, uint256, uint256)
 *   function getFeeGrowthInside(bytes32, int24, int24) view returns (uint256, uint256)
 */
export const stateViewAbi = [
  { name: 'getSlot0', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint160' }, { type: 'int24' }, { type: 'uint24' }, { type: 'uint24' }] },
  { name: 'getPositionInfo', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'address' }, { type: 'int24' }, { type: 'int24' }, { type: 'bytes32' }], outputs: [{ type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }] },
  { name: 'getFeeGrowthInside', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'int24' }, { type: 'int24' }], outputs: [{ type: 'uint256' }, { type: 'uint256' }] },
] as const
/** decreaseParameters signature: uint256,uint256,uint128,uint128,bytes */
export const decreaseParameters = [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }] as const
/** takePairParameters signature: address,address,address */
export const takePairParameters = [{ type: 'address' }, { type: 'address' }, { type: 'address' }] as const
/** unlockParameters signature: bytes,bytes[] */
export const unlockParameters = [{ type: 'bytes' }, { type: 'bytes[]' }] as const
/** poolIdParameters signature: (address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) */
export const poolIdParameters = [{ type: 'tuple', components: poolKeyComponents }] as const

/** The v4 periphery's action codes (Actions.sol), one byte each in `actions`. */
export const V4_ACTION = { DECREASE_LIQUIDITY: 0x01, TAKE_PAIR: 0x11 } as const

/**
 * The contracts these actions call, and the runtime code each must have. The
 * hashes are the deployed v4-periphery revision's (reports/DEPOSIT_DEPLOYMENT_REVIEW.md),
 * the same ones the published setup profile names for this chain.
 */
export interface PositionDeployment { positionManager: Address; stateView: Address; positionManagerCodeHash: Hex; stateViewCodeHash: Hex }
export const POSITION_DEPLOYMENT: PositionDeployment = Object.freeze({
  positionManager: POSITION_MANAGER,
  stateView: STATE_VIEW,
  positionManagerCodeHash: '0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2',
  stateViewCodeHash: '0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6',
})

// ---------------------------------------------------------------------------
// Tick and amount math. Copies of lib/read/screens/poolRange.ts sqrtPriceAtTick and lib/create/pairAmount.ts
// amount0ForLiquidity/amount1ForLiquidity: finance/ may not import those (see ./slippage.ts for why), so they are
// pinned to them instead, over a tick sweep, in tests/position-actions.test.mjs.
// ---------------------------------------------------------------------------

const Q96 = 1n << 96n
const MAX_UINT256 = (1n << 256n) - 1n
export const MIN_TICK = -887272
export const MAX_TICK = 887272
/** Q128.128 factors 1/sqrt(1.0001^(2^i)), bit by bit, as in v4-core's TickMath.getSqrtPriceAtTick. */
const FACTORS: ReadonlyArray<readonly [number, bigint]> = [
  [0x2, 0xfff97272373d413259a46990580e213an], [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn], [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n], [0x20, 0xff973b41fa98c081472e6896dfb254c0n], [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n], [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n], [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n], [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n], [0x20000, 0x5d6af8dedb81196699c329225ee604n], [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
]
/** sqrt(1.0001^tick) × 2^96, rounded up, exactly as v4-core computes it. Throws outside MIN_TICK..MAX_TICK. */
export function sqrtPriceAtTick(tick: number): bigint {
  if (!Number.isSafeInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new RangeError(`tick ${tick} is outside ${MIN_TICK}..${MAX_TICK}`)
  const abs = Math.abs(tick)
  let price = abs & 0x1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n
  for (const [bit, factor] of FACTORS) if (abs & bit) price = (price * factor) >> 128n
  if (tick > 0) price = MAX_UINT256 / price
  return (price + 0xffffffffn) >> 32n
}
const ordered = (a: bigint, b: bigint): readonly [bigint, bigint] => (a <= b ? [a, b] : [b, a])
/** The currency0 a liquidity holds between two prices, rounded down as a removal is (getAmount0ForLiquidity). */
export function amount0ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  const [low, high] = ordered(sqrtA, sqrtB)
  if (low === 0n || high === low) return 0n
  return (((liquidity * Q96) * (high - low)) / high) / low
}
/** The currency1 a liquidity holds between two prices, rounded down as a removal is (getAmount1ForLiquidity). */
export function amount1ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  const [low, high] = ordered(sqrtA, sqrtB)
  return (liquidity * (high - low)) / Q96
}

/**
 * What a liquidity is worth in each currency at the pool's price now: what removing all of it pays, before fees.
 * Branches on the pool's tick as v4-core's Pool.modifyLiquidity does, so a tick equal to tickUpper is above the range.
 */
export function principalAt(sqrtPriceX96: bigint, tick: number, tickLower: number, tickUpper: number, liquidity: bigint): readonly [bigint, bigint] {
  const lower = sqrtPriceAtTick(tickLower), upper = sqrtPriceAtTick(tickUpper)
  if (tick < tickLower) return [amount0ForLiquidity(lower, upper, liquidity), 0n]
  if (tick < tickUpper) return [amount0ForLiquidity(sqrtPriceX96, upper, liquidity), amount1ForLiquidity(lower, sqrtPriceX96, liquidity)]
  return [0n, amount1ForLiquidity(lower, upper, liquidity)]
}

/**
 * The least principal removing all of `liquidity` may pay anywhere in the slippage band around the price now,
 * which is what the close sends as its minimums. The band is the one a new position is minted with
 * (lib/create/mintPlan.ts bandFor): the square-root price × (1 ± bps/20000), clamped to the range. Currency0 is
 * least at the top of the band, currency1 at the bottom. Fees are not in it: the position manager checks the
 * minimums against the principal alone.
 */
export function closeMinimums(sqrtPriceX96: bigint, tickLower: number, tickUpper: number, liquidity: bigint, slippageBps: number): readonly [bigint, bigint] {
  if (!Number.isSafeInteger(slippageBps) || slippageBps < SLIPPAGE_MIN_BPS || slippageBps > SLIPPAGE_MAX_BPS) throw new Error('invalid_slippage')
  const lower = sqrtPriceAtTick(tickLower), upper = sqrtPriceAtTick(tickUpper), band = BigInt(slippageBps)
  const clamp = (x: bigint) => (x < lower ? lower : x > upper ? upper : x)
  const low = clamp((sqrtPriceX96 * (20000n - band)) / 20000n)
  const high = clamp((sqrtPriceX96 * (20000n + band) + 19999n) / 20000n)
  return [high < upper ? amount0ForLiquidity(high, upper, liquidity) : 0n, low > lower ? amount1ForLiquidity(lower, low, liquidity) : 0n]
}

/** Fees a position has earned and not collected: (growth now − growth at its last update, mod 2^256) × liquidity / 2^128, as v4-core's Position.update. */
export function feesOwed(growthNowX128: bigint, growthLastX128: bigint, liquidity: bigint): bigint {
  return (((growthNowX128 - growthLastX128) & MAX_UINT256) * liquidity) >> 128n
}

/** The PositionManager's packed PositionInfo: 200 bits of pool id | 24 tickUpper | 24 tickLower | 8 hasSubscriber (PositionInfoLibrary). */
export function decodePositionInfo(info: bigint): { tickLower: number; tickUpper: number; hasSubscriber: boolean; poolIdPrefix: bigint } {
  return {
    tickLower: Number(BigInt.asIntN(24, info >> 8n)),
    tickUpper: Number(BigInt.asIntN(24, info >> 32n)),
    hasSubscriber: (info & 0xffn) !== 0n,
    poolIdPrefix: info >> 56n,
  }
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

const actions = (...codes: number[]): Hex => `0x${codes.map((code) => code.toString(16).padStart(2, '0')).join('')}`
const modifyLiquidities = (codes: Hex, params: readonly Hex[], deadline: bigint): Hex =>
  encodeFunctionData({ abi: positionManagerAbi, functionName: 'modifyLiquidities', args: [encodeAbiParameters(unlockParameters, [codes, params]), deadline] })
const takePair = (currency0: Address, currency1: Address, owner: Address) => encodeAbiParameters(takePairParameters, [currency0, currency1, owner])

/** Collect: remove no liquidity, which settles the fees, and pay both currencies to the owner. */
export function collectData(tokenId: bigint, currency0: Address, currency1: Address, owner: Address, deadline: bigint): Hex {
  return modifyLiquidities(actions(V4_ACTION.DECREASE_LIQUIDITY, V4_ACTION.TAKE_PAIR),
    [encodeAbiParameters(decreaseParameters, [tokenId, 0n, 0n, 0n, '0x']), takePair(currency0, currency1, owner)], deadline)
}
/** Close: remove all of the liquidity with minimums on the principal, and pay principal and fees to the owner. The NFT stays. */
export function closeData(tokenId: bigint, liquidity: bigint, minimum0: bigint, minimum1: bigint, currency0: Address, currency1: Address, owner: Address, deadline: bigint): Hex {
  return modifyLiquidities(actions(V4_ACTION.DECREASE_LIQUIDITY, V4_ACTION.TAKE_PAIR),
    [encodeAbiParameters(decreaseParameters, [tokenId, liquidity, minimum0, minimum1, '0x']), takePair(currency0, currency1, owner)], deadline)
}

/**
 * The position manager's refusals this client says in words, by selector: the price left the band (MinimumAmountInsufficient),
 * the step outlived its deadline (DeadlinePassed), the wallet is not the NFT's owner (NotApproved), or there is no liquidity
 * left to touch (CannotUpdateEmptyPosition).
 */
export const REVERT_CODES: Readonly<Record<string, string>> = {
  '0x12816f22': 'position_price_moved',
  '0xbfb22adf': 'position_deadline_passed',
  '0x0ca968d8': 'position_not_owned',
  '0xaefeb924': 'position_already_empty',
}
/** A wallet's error for a refused simulation as one of this client's codes; null when it was not a contract's refusal. */
export function revertCode(error: unknown): string | null {
  let revert = false, selector: string | null = null
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 3) return
    const { code, message, data } = value as { code?: unknown; message?: unknown; data?: unknown }
    if (code === 3 || (typeof message === 'string' && /execution reverted|revert/i.test(message))) revert = true
    if (typeof data === 'string' && /^0x[0-9a-fA-F]{8}/.test(data)) { revert = true; selector ??= data.slice(0, 10).toLowerCase() }
    visit(data, depth + 1)
    visit((value as { originalError?: unknown }).originalError, depth + 1)
    visit((value as { error?: unknown }).error, depth + 1)
    visit((value as { cause?: unknown }).cause, depth + 1)
  }
  visit(error, 0)
  if (selector && Object.hasOwn(REVERT_CODES, selector)) return REVERT_CODES[selector]
  return revert ? 'position_simulation_reverted' : null
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface PoolKey { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
/** A position as the chain has it at one block, read through the owner's wallet. */
export interface PositionState {
  tokenId: bigint; key: PoolKey; poolId: Hex; tickLower: number; tickUpper: number; liquidity: bigint
  sqrtPriceX96: bigint; tick: number; principal: readonly [bigint, bigint]; fees: readonly [bigint, bigint]
  hasSubscriber: boolean; blockNumber: bigint; blockTimestamp: bigint
}
export interface PreparedPosition {
  kind: 'collect' | 'close'; tokenId: bigint; owner: Address; expiresAt: number; deadline: bigint; state: PositionState
  /** The principal minimums the transaction carries: zero for a collect. */
  minimum: readonly [bigint, bigint]
  /** What the owner receives at the price read: the fees, or principal and fees. */
  receive: readonly [bigint, bigint]
  /** What the owner receives at least: the minimums and the fees. */
  atLeast: readonly [bigint, bigint]
  /** The most the step may cost in network fees: its gas limit at the fee ceiling. */
  networkFeeWei: bigint
  transaction: Readonly<{ from: Address; to: Address; data: Hex; value: '0x0'; nonce: Hex; gas: Hex; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex; chainId: '0x1237'; type: '0x2' }>
}
export type PositionReceipt = { state: 'pending' } | { state: 'reorged' } | { state: 'included' | 'finalized' | 'reverted'; blockHash: Hex }

const ADDRESS = /^0x[0-9a-f]{40}$/, HASH = /^0x[0-9a-f]{64}$/
const fail = (code: string): never => { throw new Error(code) }
const asHex = (value: unknown): Hex => typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value) ? value as Hex : fail('invalid_wallet_reply')
const quantity = (value: unknown): bigint => typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value) ? BigInt(value) : fail('invalid_wallet_quantity')
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail('invalid_wallet_reply')
const lowerAddress = (value: string): Address => ADDRESS.test(value.toLowerCase()) ? value.toLowerCase() as Address : fail('invalid_wallet_reply')

/** A position NFT id as written: a canonical decimal, 1 to 2^256 − 1. */
export function positionTokenId(text: string): bigint {
  if (!/^[1-9][0-9]{0,77}$/.test(text)) return fail('invalid_position_id')
  const id = BigInt(text)
  return id <= MAX_UINT256 ? id : fail('invalid_position_id')
}

export function createPositionClient(wallet: WalletRpc, supplied: PositionDeployment = POSITION_DEPLOYMENT, now = () => Date.now() / 1000) {
  const deployment = Object.freeze({ ...supplied })
  const issued = new WeakSet<PreparedPosition>(), offered = new Set<string>()
  const returned = new Map<Hex, PreparedPosition>()
  let verified = false, busy = false
  async function bounded<T>(work: (rpc: (method: string, params: unknown[], onUserRejection?: () => Promise<void>) => Promise<unknown>) => Promise<T>, seconds = 25): Promise<T> {
    if (busy) return fail('wallet_action_busy')
    busy = true
    const end = now() + seconds
    let calls = 0
    const rpc = async (method: string, params: unknown[], onUserRejection?: () => Promise<void>) => {
      if (!wallet.current() || now() >= end || ++calls > 32) return fail('wallet_action_expired')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // A definite wallet rejection stays observable even after the deadline has won; an unknown outcome keeps its nonce quarantined.
        const request = wallet.request(method, params).catch(async (error) => {
          if (error && typeof error === 'object' && 'code' in error && error.code === 4001) await onUserRejection?.()
          throw error
        })
        const result = await Promise.race([request, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('wallet_timeout')), Math.max(1, (end - now()) * 1000)) })])
        if (!wallet.current() || now() >= end) return fail('wallet_identity_changed')
        return result
      } finally { clearTimeout(timer) }
    }
    try { return await work(rpc) } finally { busy = false }
  }
  type Rpc = Parameters<Parameters<typeof bounded>[0]>[0]
  async function identity(rpc: Rpc) {
    const accounts = await rpc('eth_accounts', []), chain = await rpc('eth_chainId', [])
    if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== wallet.owner || quantity(chain) !== 4663n) return fail('wallet_identity_changed')
  }
  /** The pinned contracts, and their code, once per client: a different position manager is not this chain's Uniswap. */
  async function verify(rpc: Rpc) {
    await identity(rpc)
    if (verified) return
    if (!pinned(POSITION_MANAGER, deployment.positionManager) || !pinned(STATE_VIEW, deployment.stateView)) return fail('deployment_identity_unpinned')
    for (const [address, hash] of [[deployment.positionManager, deployment.positionManagerCodeHash], [deployment.stateView, deployment.stateViewCodeHash]] as const) {
      if (keccak256(asHex(await rpc('eth_getCode', [address, 'latest']))) !== hash) return fail('deployment_code_changed')
    }
    verified = true
  }
  const ask = async (rpc: Rpc, to: Address, data: Hex, block: Hex): Promise<Hex> => asHex(await rpc('eth_call', [{ to, data }, block]))
  /** The position at the latest block, every read pinned to that block. */
  async function read(rpc: Rpc, tokenId: bigint): Promise<PositionState> {
    await verify(rpc)
    if (tokenId <= 0n || tokenId > MAX_UINT256) return fail('invalid_position_id')
    const latest = record(await rpc('eth_getBlockByNumber', ['latest', false]))
    const blockNumber = quantity(latest.number), blockTimestamp = quantity(latest.timestamp), block = numberToHex(blockNumber)
    const pm = deployment.positionManager, sv = deployment.stateView
    let owner: string
    try {
      owner = decodeFunctionResult({ abi: positionManagerAbi, functionName: 'ownerOf',
        data: await ask(rpc, pm, encodeFunctionData({ abi: positionManagerAbi, functionName: 'ownerOf', args: [tokenId] }), block) })
    } catch (error) {
      // A burned or never-minted NFT has no owner: solmate reverts NOT_MINTED.
      if (revertCode(error)) return fail('position_not_found')
      throw error
    }
    if (owner.toLowerCase() !== wallet.owner) return fail('position_not_owned')
    const [rawKey, info] = decodeFunctionResult({ abi: positionManagerAbi, functionName: 'getPoolAndPositionInfo',
      data: await ask(rpc, pm, encodeFunctionData({ abi: positionManagerAbi, functionName: 'getPoolAndPositionInfo', args: [tokenId] }), block) })
    const key: PoolKey = { currency0: lowerAddress(rawKey.currency0), currency1: lowerAddress(rawKey.currency1), fee: rawKey.fee, tickSpacing: rawKey.tickSpacing, hooks: lowerAddress(rawKey.hooks) }
    if (key.tickSpacing === 0) return fail('position_not_found')
    // A hook may take a share of a removal or refuse it; these actions are offered for hookless pools only, as positions are created.
    if (key.hooks !== zeroAddress) return fail('position_pool_has_hooks')
    const poolId = keccak256(encodeAbiParameters(poolIdParameters, [key]))
    const decoded = decodePositionInfo(info)
    if (decoded.poolIdPrefix !== BigInt(poolId) >> 56n || decoded.tickLower >= decoded.tickUpper || decoded.tickLower < MIN_TICK || decoded.tickUpper > MAX_TICK) return fail('invalid_position_identity')
    const liquidity = decodeFunctionResult({ abi: positionManagerAbi, functionName: 'getPositionLiquidity',
      data: await ask(rpc, pm, encodeFunctionData({ abi: positionManagerAbi, functionName: 'getPositionLiquidity', args: [tokenId] }), block) })
    const [sqrtPriceX96, tick] = decodeFunctionResult({ abi: stateViewAbi, functionName: 'getSlot0',
      data: await ask(rpc, sv, encodeFunctionData({ abi: stateViewAbi, functionName: 'getSlot0', args: [poolId] }), block) })
    if (sqrtPriceX96 === 0n) return fail('pool_not_initialized')
    const salt = numberToHex(tokenId, { size: 32 })
    const [held, last0, last1] = decodeFunctionResult({ abi: stateViewAbi, functionName: 'getPositionInfo',
      data: await ask(rpc, sv, encodeFunctionData({ abi: stateViewAbi, functionName: 'getPositionInfo', args: [poolId, pm, decoded.tickLower, decoded.tickUpper, salt] }), block) })
    if (held !== liquidity) return fail('invalid_position_identity')
    const [now0, now1] = decodeFunctionResult({ abi: stateViewAbi, functionName: 'getFeeGrowthInside',
      data: await ask(rpc, sv, encodeFunctionData({ abi: stateViewAbi, functionName: 'getFeeGrowthInside', args: [poolId, decoded.tickLower, decoded.tickUpper] }), block) })
    return Object.freeze({
      tokenId, key, poolId, tickLower: decoded.tickLower, tickUpper: decoded.tickUpper, liquidity, sqrtPriceX96, tick,
      principal: principalAt(sqrtPriceX96, tick, decoded.tickLower, decoded.tickUpper, liquidity),
      fees: [feesOwed(now0, last0, liquidity), feesOwed(now1, last1, liquidity)] as const,
      hasSubscriber: decoded.hasSubscriber, blockNumber, blockTimestamp,
    })
  }
  /** A contract refusal said as this client's code; any other failure unchanged. */
  async function simulated<T>(work: Promise<T>): Promise<T> {
    try { return await work } catch (error) {
      const code = revertCode(error)
      throw code ? new Error(code) : error
    }
  }
  async function prepare(rpc: Rpc, kind: PreparedPosition['kind'], state: PositionState, deadline: bigint, data: Hex, minimum: readonly [bigint, bigint], gas: GasBudget): Promise<PreparedPosition> {
    if (gas.maxGas < 21000n || gas.maxGas > 15_000_000n || gas.maxFeePerGas <= 0n || gas.maxFeePerGas >= 2n ** 128n || gas.maxPriorityFeePerGas < 0n || gas.maxPriorityFeePerGas > gas.maxFeePerGas || gas.reserveWei < 0n) return fail('invalid_gas_budget')
    const latest = quantity(await rpc('eth_getTransactionCount', [wallet.owner, 'latest'])), pending = quantity(await rpc('eth_getTransactionCount', [wallet.owner, 'pending']))
    if (latest !== pending || offered.has(String(pending)) || wallet.nonceOffered(pending)) return fail('pending_wallet_transaction')
    const tx = { from: wallet.owner, to: deployment.positionManager, data, value: '0x0' as const }
    await simulated(rpc('eth_call', [tx, 'latest']))
    const estimate = quantity(await simulated(rpc('eth_estimateGas', [tx])))
    const limit = (estimate * 120n + 99n) / 100n
    if (limit > gas.maxGas) return fail('gas_budget_exceeded')
    if (quantity(await rpc('eth_getBalance', [wallet.owner, 'latest'])) < limit * gas.maxFeePerGas + gas.reserveWei) return fail('native_gas_reserve_insufficient')
    const pair = (a: bigint, b: bigint) => Object.freeze([a, b] as const)
    const prepared: PreparedPosition = Object.freeze({
      kind, tokenId: state.tokenId, owner: wallet.owner, expiresAt: now() + 25, deadline, state, minimum: pair(minimum[0], minimum[1]),
      receive: kind === 'collect' ? pair(state.fees[0], state.fees[1]) : pair(state.principal[0] + state.fees[0], state.principal[1] + state.fees[1]),
      atLeast: pair(minimum[0] + state.fees[0], minimum[1] + state.fees[1]),
      networkFeeWei: limit * gas.maxFeePerGas,
      transaction: Object.freeze({ ...tx, chainId: '0x1237' as const, type: '0x2' as const, nonce: numberToHex(pending), gas: numberToHex(limit), maxFeePerGas: numberToHex(gas.maxFeePerGas), maxPriorityFeePerGas: numberToHex(gas.maxPriorityFeePerGas) }),
    })
    issued.add(prepared)
    return prepared
  }
  return {
    deployment,
    /** The position now, for showing what an action would pay. Reads only. */
    inspect: (tokenId: bigint) => bounded((rpc) => read(rpc, tokenId)),
    /** Collect the fees to the owner, keeping the liquidity where it is. */
    prepareCollect: (tokenId: bigint, gas: GasBudget) => bounded(async (rpc) => {
      const state = await read(rpc, tokenId)
      if (state.liquidity === 0n) return fail('position_already_empty')
      const deadline = state.blockTimestamp + BigInt(STEP_DEADLINE_S)
      return prepare(rpc, 'collect', state, deadline, collectData(tokenId, state.key.currency0, state.key.currency1, wallet.owner, deadline), [0n, 0n], gas)
    }),
    /** Remove all of the liquidity, with minimums from the owner's slippage limit, and pay principal and fees to the owner. The NFT stays. */
    prepareClose: (tokenId: bigint, slippageBps: number, gas: GasBudget) => bounded(async (rpc) => {
      if (!Number.isSafeInteger(slippageBps) || slippageBps < SLIPPAGE_MIN_BPS || slippageBps > SLIPPAGE_MAX_BPS) return fail('invalid_slippage')
      const state = await read(rpc, tokenId)
      if (state.liquidity === 0n) return fail('position_already_empty')
      const minimum = closeMinimums(state.sqrtPriceX96, state.tickLower, state.tickUpper, state.liquidity, slippageBps)
      const deadline = state.blockTimestamp + BigInt(STEP_DEADLINE_S)
      return prepare(rpc, 'close', state, deadline, closeData(tokenId, state.liquidity, minimum[0], minimum[1], state.key.currency0, state.key.currency1, wallet.owner, deadline), minimum, gas)
    }),
    /** Offers a prepared step to the wallet once. A rejection (4001) releases its nonce and sends nothing more. */
    send: (prepared: PreparedPosition, acknowledged: boolean) => bounded(async (rpc) => {
      if (!acknowledged || !issued.has(prepared) || prepared.expiresAt <= now() || prepared.owner !== wallet.owner) return fail('wallet_review_required')
      await verify(rpc)
      const latest = quantity(await rpc('eth_getTransactionCount', [wallet.owner, 'latest'])), pending = quantity(await rpc('eth_getTransactionCount', [wallet.owner, 'pending']))
      if (latest !== pending || numberToHex(pending) !== prepared.transaction.nonce || offered.has(String(pending)) || wallet.nonceOffered(pending)) return fail('pending_wallet_transaction')
      // The chain may have moved since the review: the exact transaction is simulated again before the wallet sees it.
      await simulated(rpc('eth_call', [prepared.transaction, 'latest']))
      if (prepared.expiresAt <= now()) return fail('wallet_review_expired')
      const claim = await wallet.claimNonce(pending)
      if (!wallet.current() || prepared.expiresAt <= now()) {
        // The provider has not been invoked, so releasing this claim is certain.
        await wallet.releaseRejectedNonce(pending, claim)
        return fail('wallet_review_expired')
      }
      offered.add(String(pending)); issued.delete(prepared)
      const hash = await rpc('eth_sendTransaction', [prepared.transaction], async () => {
        // Only this exact claim, only after a definite rejection; nothing is offered again without a new review.
        await wallet.releaseRejectedNonce(pending, claim)
        offered.delete(String(pending))
      })
      if (typeof hash !== 'string' || !HASH.test(hash.toLowerCase())) return fail('wallet_result_unknown')
      returned.set(hash.toLowerCase() as Hex, prepared)
      return hash.toLowerCase() as Hex
    }, SIGN_WINDOW_S),
    /** Where a step this client sent stands. A revert is said as soon as its block is canonical. */
    receipt: (hash: Hex) => bounded(async (rpc): Promise<PositionReceipt> => {
      await identity(rpc)
      const known = returned.get(hash)
      if (!HASH.test(hash) || !known) return fail('receipt_not_from_this_review')
      const tx = await rpc('eth_getTransactionByHash', [hash]) as { hash?: string; from?: string; to?: string; input?: string; value?: string; nonce?: string } | null
      if (tx === null) return { state: 'pending' }
      const sent = known.transaction
      if (!tx || tx.hash?.toLowerCase() !== hash || tx.from?.toLowerCase() !== wallet.owner || tx.to?.toLowerCase() !== sent.to || tx.input?.toLowerCase() !== sent.data.toLowerCase()
        || quantity(tx.value) !== 0n || quantity(tx.nonce) !== quantity(sent.nonce)) return fail('transaction_does_not_match_review')
      const receipt = await rpc('eth_getTransactionReceipt', [hash]) as { transactionHash?: string; from?: string; blockNumber?: string; blockHash?: string; status?: string } | null
      if (receipt === null) return { state: 'pending' }
      if (!receipt || receipt.transactionHash?.toLowerCase() !== hash || receipt.from?.toLowerCase() !== wallet.owner || !receipt.blockNumber || !receipt.blockHash || !HASH.test(receipt.blockHash) || !['0x0', '0x1'].includes(receipt.status ?? '')) return fail('invalid_receipt')
      const block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]) as { hash?: string } | null
      if (!block || block.hash !== receipt.blockHash) return { state: 'reorged' }
      if (receipt.status === '0x0') return { state: 'reverted', blockHash: receipt.blockHash as Hex }
      const final = await rpc('eth_getBlockByNumber', ['finalized', false]) as { number?: string } | null
      if (!final?.number || quantity(final.number) < quantity(receipt.blockNumber)) return { state: 'included', blockHash: receipt.blockHash as Hex }
      return { state: 'finalized', blockHash: receipt.blockHash as Hex }
    }),
  }
}
export type PositionClient = ReturnType<typeof createPositionClient>
