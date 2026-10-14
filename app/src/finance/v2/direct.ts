import { decodeAbiParameters, decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getContractAddress, keccak256, type Abi, type Address, type Hex } from 'viem'
import v3FactoryAbi from '../../../../api-contracts/v2/abi/IUniswapV3FactoryMinimal.json'
import v3PoolAbi from '../../../../api-contracts/v2/abi/IUniswapV3PoolMinimal.json'
import v4StateViewAbi from '../../../../api-contracts/v2/abi/IV4StateViewMinimal.json'
import { isV2ChainId, v2Chain, type V2Chain } from '../../v2/chains'
import { V2_FIXTURE_SETS_TAKEN } from '../../v2/flag'
import { ZERO_ADDRESS, type Dex, type PoolRef, type V2ChainId } from '../../v2/types'
import { closeData, closeMinimums, collectData, decodePositionInfo, decreaseParameters, takePairParameters, unlockParameters, feesOwed, principalAt, MAX_TICK, MIN_TICK } from '../position'
import { SLIPPAGE_MAX_BPS, SLIPPAGE_MIN_BPS } from '../slippage'
import { STEP_DEADLINE_S } from '../setup'
import { V3_POSITION_MANAGER_ABI, V4_POSITION_MANAGER_ABI } from './abi'
import { gasCost, type GasCost } from './receipt'
import { includedCloses, pendingClose } from './closeJournal'
import { refuseUnlessLive } from './liveLock'
import { WalletNotAsked, createTransactor, refused, revertIn, type PreparedV2, type Rpc, type V2GasBudget, type V2Receipt, type V2Wallet } from './transact'

/**
 * Domino V2's direct exits (spec F7 §2.6.4 recommendation): leaving a position for both of its tokens, and collecting its
 * fees without conversion, need no zap. The owner calls Uniswap's own position manager on the position's chain, as
 * finance/position.ts already does on Robinhood v4: no zap approval, no Domino fee. The zap stays the path for an exit
 * that converts (finance/v2/zap.ts).
 *
 *   v4 PositionManager  modifyLiquidities(DECREASE_LIQUIDITY + TAKE_PAIR, deadline)
 *                         collect: liquidity 0, minimums 0;  close: all of it, minimums on the principal only
 *   v3 NonfungiblePositionManager
 *                         collect: collect(tokenId, owner, max, max)
 *                         close:   multicall([decreaseLiquidity(all, min0, min1, deadline), collect(tokenId, owner, max, max)])
 *
 * The position manager (and v4's StateView, v3's factory) is the chain profile's, and before the first read of a DEX
 * this client checks each one's runtime code against the code hash the profile's verification list recorded for that
 * address (src/v2/chains.ts `verifiedCode`), as V1's position client does on Robinhood. The math is V1's
 * (finance/position.ts: principal at the price now, the slippage band's minimums, fees owed), imported, never copied.
 *
 * Sending is the shared V2 sender's (./transact.ts): every read through the connected wallet's own provider, bounded,
 * on THIS chain only (`wallet_wrong_chain` otherwise: switch first), simulated and estimated, the chain read right before
 * the wallet is asked, offered once. A hooked v4 position is refused (`position_pool_has_hooks`: hooked pools are not
 * supported yet, OP6). Nothing here names a Domino contract.
 *
 * A position under Domino automation (rev2 §2.13, decision #5): a direct exit of an armed root pauses its automation (v4:
 * the vault's subscription is notified of the change; v3: the collect moves the vault's checkpoint), so it is allowed
 * only after the person acknowledges the warning (`acknowledgePause`, refused `automation_pause_unacknowledged` before),
 * exactly as the zap's actions; a successor is held by its vault (`position_vault_successor`). Which addresses are
 * Domino vaults is asked of the probe the caller hands in (the zap client's `vaultProbe`, over the chain's manifest).
 */

// Declared here, module-scoped, as finance/pin.ts does: a compile outside Vite sees no ambient flag.
declare const __DOMINO_DEPLOYABLE__: boolean | undefined
// Changed on purpose (data) 2026-10-02 (Domino V2 integration, the preview-v2 build): preview-v2 is the real site for V1
// (`__DOMINO_DEPLOYABLE__` true there) yet takes fixture sets up to a review (V2_FIXTURE_SETS_TAKEN, src/v2/flag.ts): their
// sends and signatures are refused by ./liveLock.ts instead. The deployable builds refuse them here, as before.
const DEPLOYABLE: boolean = typeof __DOMINO_DEPLOYABLE__ === 'boolean' && __DOMINO_DEPLOYABLE__ && !V2_FIXTURE_SETS_TAKEN

/** The code hashes the client checks: the chain profile's (`chain.verifiedCode`), always in a deployable build. */
export type DirectCode = V2Chain['verifiedCode']

export type DirectKind = 'collect' | 'close'

/** A position as the chain has it now, read through the owner's wallet at one block. */
export interface DirectPosition {
  chainId: V2ChainId
  dex: Dex
  tokenId: bigint
  pool: PoolRef
  tickLower: number
  tickUpper: number
  liquidity: bigint
  sqrtPriceX96: bigint
  tick: number
  /** What removing all of the liquidity pays at the price now, before fees. */
  principal: readonly [bigint, bigint]
  /** The fees a collect pays now (v4: from StateView's fee growth; v3: the position manager's own answer to the collect). */
  fees: readonly [bigint, bigint]
  blockNumber: bigint
  blockTimestamp: bigint
  /** The NFT's individual approval (address(0) when none) and, on v4, its subscriber (address(0) when none). */
  approved: Address
  subscriber: Address | null
}

/** One prepared direct exit, ready for the wallet. */
export interface DirectPrepared {
  kind: DirectKind
  chainId: V2ChainId
  dex: Dex
  tokenId: bigint
  state: DirectPosition
  deadline: bigint
  /** The liquidity the call removes: zero for a collect. */
  liquidity: bigint
  /** The principal minimums the call carries: zero for a collect. */
  minimum: readonly [bigint, bigint]
  /** What the wallet receives at the price read: the fees, or principal and fees. */
  receive: readonly [bigint, bigint]
  /** At least: the minimums and the fees. */
  atLeast: readonly [bigint, bigint]
  /** The transaction, through the shared sender. */
  step: PreparedV2
  /** The armed root's vault whose automation this exit pauses (rev2 §2.13), or null: sent only after `acknowledgePause`. */
  pausesAutomation: Address | null
  /**
   * The vault whose root this position is, armed or not: its reserves stay behind an exit (rev3 §2.13). Changed on purpose
   * (data) 2026-10-02 (Domino V2 rev2 review, L2).
   */
  vaultRoot: Address | null
}

// Two NFTs leave room in the existing bounded wallet read budget for ownership, pool and automation checks.
export const MAX_CLOSE_POSITIONS = 2
/** One atomic owner call to one verified position manager; every NFT remains in the owner's wallet. */
export interface DirectCloseMany {
  chainId: V2ChainId
  dex: Dex
  positions: readonly DirectPosition[]
  minimums: readonly (readonly [bigint, bigint])[]
  receive: readonly (readonly [bigint, bigint])[]
  deadline: bigint
  pausesAutomation: readonly Address[]
  vaultRoots: readonly Address[]
  step: PreparedV2
}
export interface DirectCloseRecovery {
  dex: Dex
  tokenIds: readonly bigint[]
  data: Hex
  nonce: Hex
  hash: Hex
  originalHash?: Hex
}
export type DirectCloseDescription = Pick<DirectCloseMany, 'chainId' | 'dex' | 'positions'>

/** Whether an address is a Domino V2 vault of this chain, read at `block` through the rpc it is handed (the zap client's `vaultProbe`). */
export type VaultProbe = (rpc: Rpc, address: Address, block: Hex | 'latest') => Promise<boolean>
/**
 * Whether a Domino vault holds this position as its root, and whether that root is armed (the zap client's `rootProbe`:
 * the vault's own `root()` and `rootArmed()`); null when its root is another position. Domino V2 rev2 review, L2.
 */
export type RootProbe = (rpc: Rpc, vault: Address, dex: Dex, tokenId: bigint, block: Hex | 'latest') => Promise<{ armed: boolean } | null>

const MAX_UINT128 = (1n << 128n) - 1n
const MAX_UINT256 = (1n << 256n) - 1n
const fail = (code: string): never => { throw new Error(code) }
const lower = (value: unknown): Address => (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) ? (value.toLowerCase() as Address) : fail('invalid_wallet_reply'))
const STATE_VIEW_ABI = v4StateViewAbi.abi as unknown as Abi
const V3_POOL_ABI = v3PoolAbi.abi as unknown as Abi
const V3_FACTORY_ABI = v3FactoryAbi.abi as unknown as Abi
/** The NonfungiblePositionManager's own multicall (not in the minimal export, D7): the standard Uniswap v3 periphery's. */
const V3_MULTICALL_ABI = [{ name: 'multicall', type: 'function', stateMutability: 'payable', inputs: [{ type: 'bytes[]', name: 'data' }], outputs: [{ type: 'bytes[]', name: 'results' }] }] as const
const POOL_KEY = [{ type: 'tuple', components: [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
] }] as const

/** The v3 pool's address for its tokens and tier: CREATE2 of the chain's factory with the profile's init code hash. */
export function v3PoolAddress(chain: V2Chain, token0: Address, token1: Address, fee: number): Address {
  const salt = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }], [token0, token1, fee]))
  return getContractAddress({ opcode: 'CREATE2', from: chain.uniswap.v3.factory, salt, bytecodeHash: chain.uniswap.v3.poolInitCodeHash }).toLowerCase() as Address
}

/** v3 close: decreaseLiquidity (all, with the principal's minimums) then collect everything to the owner, in one multicall. */
export function v3CloseData(tokenId: bigint, liquidity: bigint, minimum0: bigint, minimum1: bigint, owner: Address, deadline: bigint): Hex {
  const decrease = encodeFunctionData({ abi: V3_POSITION_MANAGER_ABI, functionName: 'decreaseLiquidity', args: [{ tokenId, liquidity, amount0Min: minimum0, amount1Min: minimum1, deadline }] })
  return encodeFunctionData({ abi: V3_MULTICALL_ABI, functionName: 'multicall', args: [[decrease, v3CollectData(tokenId, owner)]] })
}
/** v3 collect: everything owed to the position, to the owner. */
export function v3CollectData(tokenId: bigint, owner: Address): Hex {
  return encodeFunctionData({ abi: V3_POSITION_MANAGER_ABI, functionName: 'collect', args: [{ tokenId, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }] })
}

/**
 * The direct-exit client for one wallet on one chain. `code` is the code hashes checked before the first read; only a
 * test passes another set, and a deployable build refuses one (`deployment_fixture_refused`). `rootProbe` (L2) says
 * whether a vault's root is armed: without one, a vault's approval or subscription counts as an armed root (the
 * cautious reading: the warning is asked).
 */
export function createDirectClient(wallet: V2Wallet, chain: V2Chain, now: () => number = () => Date.now() / 1000, code: DirectCode = chain.verifiedCode, vaultProbe: VaultProbe | null = null, rootProbe: RootProbe | null = null) {
  if (!chain || !isV2ChainId(chain.chainId) || chain !== v2Chain(chain.chainId)) fail('deployment_chain_mismatch')
  if (code !== chain.verifiedCode && DEPLOYABLE) fail('deployment_fixture_refused')
  const expected = Object.freeze({ ...code })
  for (const hash of Object.values(expected)) if (!/^0x[0-9a-f]{64}$/.test(hash)) fail('deployment_invalid')
  // Changed on purpose (data) 2026-10-02 (Domino V2 integration): a direct exit uses no Domino contract, but it is a V2 option
  // like the others: sent only once Domino's contracts are live on this chain (./liveLock.ts), refused before any wallet request.
  const t = createTransactor(wallet, chain, now, () => refuseUnlessLive(chain.chainId, null))
  const owner = t.owner
  const verified = new Set<Dex>()
  const ownPrepared = new WeakSet<DirectPrepared>()
  const ownGroups = new WeakSet<DirectCloseMany>()
  const pauseAcknowledged = new WeakSet<DirectPrepared>()
  /**
   * Review fix F2: a direct exit is not idempotent (a second partial withdrawal or collect would run), and Uniswap consumes
   * nothing that would refuse a repeat. So one direct exit per position is in flight from this client at a time: held
   * from the moment it is handed to the shared sender (keyed by chain, owner, DEX and position, whatever the kind, the
   * amounts or the block of its review, so a fresh review cannot slip past it), let go only when the wallet was never
   * asked or refused definitely, or once its receipt is read back on chain (included or reverted).
   */
  const inFlight = new Map<string, { kind: DirectKind; liquidity: bigint; block: bigint; hash: Hex | null; data?: Hex; nonce?: Hex }>()
  const flightKey = (dex: Dex, tokenId: bigint) => `${chain.chainId}|${owner}|${dex}|${tokenId}`

  const managerOf = (dex: Dex): Address => (dex === 3 ? chain.uniswap.v3.positionManager : chain.uniswap.v4.positionManager)
  const heldByJournal = (dex: Dex, ids: readonly bigint[]): boolean => {
    if (typeof localStorage === 'undefined') return false
    const pending = pendingClose(owner)
    // Changed on purpose 2026-10-14 (incident C3): a close in a block and not final yet holds its positions too (./closeJournal.ts).
    return [...(pending ? [pending] : []), ...includedCloses(owner)].some((row) => row.chainId === chain.chainId && row.dex === dex && ids.some((id) => row.tokenIds.includes(String(id))))
  }
  async function read<T>(rpc: Rpc, to: Address, abi: Abi, functionName: string, args: readonly unknown[], block: Hex | 'latest', from?: Address): Promise<T> {
    const data = encodeFunctionData({ abi, functionName, args })
    return decodeFunctionResult({ abi, functionName, data: await t.call(rpc, to, data, block, from) }) as T
  }

  /** The DEX's Uniswap contracts hold the code the chain profile verified, once per client. */
  async function verify(rpc: Rpc, dex: Dex): Promise<void> {
    if (verified.has(dex)) return
    const checks: [Address, Hex][] = dex === 4
      ? [[chain.uniswap.v4.positionManager, expected.v4PositionManager], [chain.uniswap.v4.stateView, expected.v4StateView]]
      : [[chain.uniswap.v3.positionManager, expected.v3PositionManager], [chain.uniswap.v3.factory, expected.v3Factory]]
    for (const [address, hash] of checks) {
      const found = await rpc('eth_getCode', [address, 'latest'])
      if (typeof found !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(found)) fail('deployment_read_invalid')
      if (found === '0x') fail('deployment_missing')
      if (keccak256((found as string).toLowerCase() as Hex) !== hash) fail('deployment_code_changed')
    }
    verified.add(dex)
  }

  /** The position now, every read pinned to the latest block; the wallet must hold it. */
  async function readPosition(rpc: Rpc, dex: Dex, tokenId: bigint, at?: Awaited<ReturnType<typeof t.latestBlock>>, groupVerified = false): Promise<DirectPosition> {
    if (!groupVerified) await t.identity(rpc)
    if ((dex !== 3 && dex !== 4) || typeof tokenId !== 'bigint' || tokenId <= 0n || tokenId > MAX_UINT256) return fail('invalid_position_id')
    if (!groupVerified) await verify(rpc, dex)
    const block = at ?? await t.latestBlock(rpc)
    const manager = managerOf(dex)
    let holder: Address
    try {
      holder = lower(await read<Address>(rpc, manager, dex === 4 ? V4_POSITION_MANAGER_ABI : V3_POSITION_MANAGER_ABI, 'ownerOf', [tokenId], block.tag))
    } catch (error) {
      if (revertIn(error)) return fail('position_not_found')
      throw error
    }
    if (holder !== owner) {
      // A successor of Domino-compound is its vault's (rev2 §2.13): withdrawn from the vault first.
      if (vaultProbe && (await vaultProbe(rpc, holder, block.tag))) fail('position_vault_successor')
      fail('position_not_owned')
    }
    const approved = lower(await read<Address>(rpc, manager, dex === 4 ? V4_POSITION_MANAGER_ABI : V3_POSITION_MANAGER_ABI, 'getApproved', [tokenId], block.tag))
    if (dex === 4) {
      const [key, info] = await read<readonly [{ currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }, bigint]>(rpc, manager, V4_POSITION_MANAGER_ABI, 'getPoolAndPositionInfo', [tokenId], block.tag)
      if (key.tickSpacing === 0) fail('position_not_found')
      const pool: PoolRef = { dex: 4, currency0: lower(key.currency0), currency1: lower(key.currency1), fee: key.fee, tickSpacing: key.tickSpacing, hooks: lower(key.hooks) }
      // A hook may take a share of a removal or refuse it: hooked pools are not supported yet (OP6).
      if (pool.hooks !== ZERO_ADDRESS) fail('position_pool_has_hooks')
      const poolId = keccak256(encodeAbiParameters(POOL_KEY, [{ currency0: pool.currency0, currency1: pool.currency1, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks }]))
      const decoded = decodePositionInfo(info)
      if (decoded.poolIdPrefix !== BigInt(poolId) >> 56n || decoded.tickLower >= decoded.tickUpper || decoded.tickLower < MIN_TICK || decoded.tickUpper > MAX_TICK) fail('invalid_position_identity')
      const liquidity = await read<bigint>(rpc, manager, V4_POSITION_MANAGER_ABI, 'getPositionLiquidity', [tokenId], block.tag)
      const stateView = chain.uniswap.v4.stateView
      const [sqrtPriceX96, tick] = await read<readonly [bigint, number, number, number]>(rpc, stateView, STATE_VIEW_ABI, 'getSlot0', [poolId], block.tag)
      if (sqrtPriceX96 === 0n) fail('pool_not_initialized')
      const salt = `0x${tokenId.toString(16).padStart(64, '0')}` as Hex
      const [held, last0, last1] = await read<readonly [bigint, bigint, bigint]>(rpc, stateView, STATE_VIEW_ABI, 'getPositionInfo', [poolId, manager, decoded.tickLower, decoded.tickUpper, salt], block.tag)
      if (held !== liquidity) fail('invalid_position_identity')
      const [now0, now1] = await read<readonly [bigint, bigint]>(rpc, stateView, STATE_VIEW_ABI, 'getFeeGrowthInside', [poolId, decoded.tickLower, decoded.tickUpper], block.tag)
      const subscriber = lower(await read<Address>(rpc, manager, V4_POSITION_MANAGER_ABI, 'subscriber', [tokenId], block.tag))
      return Object.freeze({
        chainId: chain.chainId, dex, tokenId, pool, tickLower: decoded.tickLower, tickUpper: decoded.tickUpper, liquidity, sqrtPriceX96, tick: Number(tick),
        principal: principalAt(sqrtPriceX96, Number(tick), decoded.tickLower, decoded.tickUpper, liquidity),
        fees: Object.freeze([feesOwed(now0, last0, liquidity), feesOwed(now1, last1, liquidity)] as const),
        blockNumber: block.number, blockTimestamp: block.timestamp, approved, subscriber,
      })
    }
    const row = await read<readonly [bigint, string, string, string, number, number, number, bigint, bigint, bigint, bigint, bigint]>(rpc, manager, V3_POSITION_MANAGER_ABI, 'positions', [tokenId], block.tag)
    const token0 = lower(row[2])
    const token1 = lower(row[3])
    const fee = Number(row[4])
    const tickLower = Number(row[5])
    const tickUpper = Number(row[6])
    const liquidity = row[7]
    if (tickLower >= tickUpper || tickLower < MIN_TICK || tickUpper > MAX_TICK) fail('invalid_position_identity')
    let spacing: number | null = Object.hasOwn(chain.uniswap.v3.tickSpacingByFee, fee) ? chain.uniswap.v3.tickSpacingByFee[fee] : null
    // A tier outside the profile's table (spec §1.4): its spacing is the verified factory's.
    if (spacing === null) spacing = Number(await read<number>(rpc, chain.uniswap.v3.factory, V3_FACTORY_ABI, 'feeAmountTickSpacing', [fee], block.tag))
    if (!spacing) fail('invalid_position_identity')
    const pool: PoolRef = { dex: 3, currency0: token0, currency1: token1, fee, tickSpacing: spacing, hooks: ZERO_ADDRESS }
    // The pool is the verified factory's CREATE2 address for these tokens and tier: its price is that pool's.
    const slot0 = await read<readonly [bigint, number]>(rpc, v3PoolAddress(chain, token0, token1, fee), V3_POOL_ABI, 'slot0', [], block.tag)
    const [sqrtPriceX96, tick] = [slot0[0], Number(slot0[1])]
    if (sqrtPriceX96 === 0n) fail('pool_not_initialized')
    // What a collect pays now: the position manager's own answer (it settles the fees first), simulated from the owner.
    const [fees0, fees1] = await read<readonly [bigint, bigint]>(rpc, manager, V3_POSITION_MANAGER_ABI, 'collect', [{ tokenId, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }], block.tag, owner)
    return Object.freeze({
      chainId: chain.chainId, dex, tokenId, pool, tickLower, tickUpper, liquidity, sqrtPriceX96, tick,
      principal: principalAt(sqrtPriceX96, tick, tickLower, tickUpper, liquidity),
      fees: Object.freeze([fees0, fees1] as const),
      blockNumber: block.number, blockTimestamp: block.timestamp, approved, subscriber: null,
    })
  }

  async function automationOf(rpc: Rpc, state: DirectPosition): Promise<{ pausesAutomation: Address | null; vaultRoot: Address | null }> {
    if (!vaultProbe) return { pausesAutomation: null, vaultRoot: null }
    const block = `0x${state.blockNumber.toString(16)}` as Hex
    for (const candidate of [state.approved, state.subscriber]) {
      if (candidate === null || candidate === ZERO_ADDRESS || !(await vaultProbe(rpc, candidate, block))) continue
      const root = rootProbe ? await rootProbe(rpc, candidate, state.dex, state.tokenId, block) : { armed: true }
      if (root) return { pausesAutomation: root.armed ? candidate : null, vaultRoot: candidate }
    }
    return { pausesAutomation: null, vaultRoot: null }
  }

  // Both official managers implement multicall(bytes[]) by delegatecall. Every inner close pays only its own
  // liquidity delta to the owner. No sweep/refund, conversion, native value, or exitAll is composed here.
  function inspectGroup(reply: Hex, count: number): void {
    const results = decodeFunctionResult({ abi: V3_MULTICALL_ABI, functionName: 'multicall', data: reply }) as readonly Hex[]
    if (results.length !== count) fail('invalid_wallet_reply')
  }

  const groupAutomation = new WeakMap<DirectCloseMany, readonly { pausesAutomation: Address | null; vaultRoot: Address | null }[]>()
  /** Share only immutable reads at one explicit block, within this single bounded operation.
   * Identity, latest/pending nonces, balances and simulations are always live and never cached. */
  async function readGroup(rpc: Rpc, dex: Dex, ids: readonly bigint[]) {
    await t.identity(rpc)
    await verify(rpc, dex)
    const block = await t.latestBlock(rpc)
    const cache = new Map<string, Promise<unknown>>()
    const pinned: Rpc = (method, params, onRefusal, answerKept) => {
      if ((method !== 'eth_call' && method !== 'eth_getCode') || params[1] !== block.tag) return rpc(method, params, onRefusal, answerKept)
      const key = JSON.stringify([method, params])
      let value = cache.get(key)
      if (!value) { value = rpc(method, params, onRefusal, answerKept); cache.set(key, value) }
      return value
    }
    const positions = await Promise.all(ids.map((id) => readPosition(pinned, dex, id, block, true)))
    const automation = await Promise.all(positions.map((position) => automationOf(pinned, position)))
    return { block, positions, automation }
  }
  async function prepareCloseMany(dex: Dex, tokenIds: readonly bigint[], slippageBps: number, gas: V2GasBudget | null = null): Promise<DirectCloseMany> {
    if (tokenIds.length === 0 || tokenIds.length > MAX_CLOSE_POSITIONS || new Set(tokenIds.map(String)).size !== tokenIds.length) fail('invalid_position_id')
    if (!Number.isSafeInteger(slippageBps) || slippageBps < SLIPPAGE_MIN_BPS || slippageBps > SLIPPAGE_MAX_BPS) fail('invalid_slippage')
    if (heldByJournal(dex, tokenIds) || tokenIds.some((id) => inFlight.has(flightKey(dex, id)))) fail('review_already_sent')
    return t.bounded(async (rpc) => {
      const { block, positions, automation } = await readGroup(rpc, dex, tokenIds)
      if (positions.some((position) => position.liquidity === 0n)) fail('position_already_empty')
      if (dex === 4 && positions.some((position) => position.pool.currency0 === ZERO_ADDRESS) && !(await t.acceptsNativeEth(rpc))) fail('native_eth_refused')
      const deadline = block.timestamp + BigInt(STEP_DEADLINE_S)
      const minimums = positions.map((position) => Object.freeze(closeMinimums(position.sqrtPriceX96, position.tickLower, position.tickUpper, position.liquidity, slippageBps)))
      const calls = positions.map((position, index) => dex === 4
        ? closeData(position.tokenId, position.liquidity, minimums[index][0], minimums[index][1], position.pool.currency0, position.pool.currency1, owner, deadline)
        : v3CloseData(position.tokenId, position.liquidity, minimums[index][0], minimums[index][1], owner, deadline))
      const data = encodeFunctionData({ abi: V3_MULTICALL_ABI, functionName: 'multicall', args: [calls] })
      const step = await t.prepare(rpc, { kind: 'direct-close-many', to: managerOf(dex), value: 0n, data,
        summary: [`Close positions ${tokenIds.join(', ')} at Uniswap, returning both tokens to ${owner}. No Domino fee.`] }, gas, (reply) => inspectGroup(reply, positions.length))
      const prepared: DirectCloseMany = Object.freeze({ chainId: chain.chainId, dex, positions: Object.freeze(positions), minimums: Object.freeze(minimums),
        receive: Object.freeze(positions.map((position) => Object.freeze([position.principal[0] + position.fees[0], position.principal[1] + position.fees[1]] as const))),
        deadline, step, pausesAutomation: Object.freeze([...new Set(automation.flatMap((entry) => entry.pausesAutomation ? [entry.pausesAutomation] : []))]),
        vaultRoots: Object.freeze([...new Set(automation.flatMap((entry) => entry.vaultRoot ? [entry.vaultRoot] : []))]) })
      ownGroups.add(prepared)
      groupAutomation.set(prepared, automation)
      return prepared
    })
  }

  async function prepare(kind: DirectKind, dex: Dex, tokenId: bigint, slippageBps: number | null, gas: V2GasBudget | null, part?: bigint): Promise<DirectPrepared> {
    if (heldByJournal(dex, [tokenId]) || inFlight.has(flightKey(dex, tokenId))) return fail('review_already_sent')
    if (kind === 'close' && (slippageBps === null || !Number.isSafeInteger(slippageBps) || slippageBps < SLIPPAGE_MIN_BPS || slippageBps > SLIPPAGE_MAX_BPS)) return fail('invalid_slippage')
    return t.bounded(async (rpc) => {
      const state = await readPosition(rpc, dex, tokenId)
      if (kind === 'close' && state.liquidity === 0n) fail('position_already_empty')
      // A vault's root (rev2 §2.13): its approval, or on v4 its subscriber, is a Domino vault whose `root()` is this
      // position. Changed on purpose (data) 2026-10-02 (Domino V2 rev2 review, L2): only a root its vault reads ARMED
      // pauses automation (a v4 root disarmed earlier keeps the vault as subscriber); the vault is kept either way, for
      // the reserves an exit leaves behind (rev3 §2.13).
      let pausesAutomation: Address | null = null
      let vaultRoot: Address | null = null
      if (vaultProbe) {
        const block = `0x${state.blockNumber.toString(16)}` as Hex
        for (const candidate of [state.approved, state.subscriber]) {
          if (vaultRoot !== null || candidate === null || candidate === ZERO_ADDRESS || !(await vaultProbe(rpc, candidate, block))) continue
          const root = rootProbe ? await rootProbe(rpc, candidate, dex, tokenId, block) : { armed: true }
          if (!root) continue
          vaultRoot = candidate
          if (root.armed) pausesAutomation = candidate
        }
      }
      // A partial exit removes `part` of the liquidity (spec §2.6.4 "Parcial"); the NFT always stays.
      const liquidity = kind === 'close' ? part ?? state.liquidity : 0n
      if (kind === 'close' && (typeof liquidity !== 'bigint' || liquidity <= 0n || liquidity > state.liquidity)) fail('invalid_liquidity')
      const principal = kind === 'close' ? principalAt(state.sqrtPriceX96, state.tick, state.tickLower, state.tickUpper, liquidity) : ([0n, 0n] as const)
      if (kind === 'collect' && state.liquidity === 0n && state.fees[0] === 0n && state.fees[1] === 0n) fail('position_already_empty')
      // TAKE_PAIR pays native ETH straight to the owner on v4: an account that refuses ETH cannot receive it.
      if (dex === 4 && state.pool.currency0 === ZERO_ADDRESS && !(await t.acceptsNativeEth(rpc))) fail('native_eth_refused')
      const deadline = state.blockTimestamp + BigInt(STEP_DEADLINE_S)
      const minimum = kind === 'close' ? closeMinimums(state.sqrtPriceX96, state.tickLower, state.tickUpper, liquidity, slippageBps as number) : ([0n, 0n] as const)
      const manager = managerOf(dex)
      let data: Hex
      let receive: readonly [bigint, bigint]
      if (dex === 4) {
        data = kind === 'collect'
          ? collectData(tokenId, state.pool.currency0, state.pool.currency1, owner, deadline)
          : closeData(tokenId, liquidity, minimum[0], minimum[1], state.pool.currency0, state.pool.currency1, owner, deadline)
        receive = kind === 'collect' ? state.fees : [principal[0] + state.fees[0], principal[1] + state.fees[1]]
      } else if (kind === 'collect') {
        data = v3CollectData(tokenId, owner)
        receive = state.fees
      } else {
        data = v3CloseData(tokenId, liquidity, minimum[0], minimum[1], owner, deadline)
        // What the close pays: the position manager's own answer to the exact call, simulated from the owner.
        const results = decodeFunctionResult({ abi: V3_MULTICALL_ABI, functionName: 'multicall', data: await t.call(rpc, manager, data, 'latest', owner) }) as readonly Hex[]
        if (results.length !== 2) fail('invalid_wallet_reply')
        const [paid0, paid1] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], results[1])
        receive = [paid0, paid1]
      }
      const step = await t.prepare(rpc, {
        kind: `direct-${kind}`, to: manager, value: 0n, data,
        summary: [kind === 'collect' ? `Collect the fees of position ${tokenId} at Uniswap, to ${owner}. No Domino fee.` : `Withdraw ${liquidity} of the liquidity of position ${tokenId} at Uniswap: at least ${minimum[0]} and ${minimum[1]} smallest units of principal, and its fees, to ${owner}. No Domino fee.`],
      }, gas)
      const pair = (a: bigint, b: bigint) => Object.freeze([a, b] as const)
      const prepared: DirectPrepared = Object.freeze({
        kind, chainId: chain.chainId, dex, tokenId, state, deadline, liquidity,
        minimum: pair(minimum[0], minimum[1]),
        receive: pair(receive[0], receive[1]),
        atLeast: kind === 'collect' ? pair(state.fees[0], state.fees[1]) : pair(minimum[0] + state.fees[0], minimum[1] + state.fees[1]),
        step,
        pausesAutomation,
        vaultRoot,
      })
      ownPrepared.add(prepared)
      return prepared
    })
  }

  return Object.freeze({
    chain,
    owner,
    /** The position now, for showing what an exit would pay. Reads only. */
    inspect: (dex: Dex, tokenId: bigint): Promise<DirectPosition> => t.bounded((rpc) => readPosition(rpc, dex, tokenId)),
    /** Collect the fees to the owner, the liquidity left where it is. */
    prepareCollect: (dex: Dex, tokenId: bigint, gas: V2GasBudget | null = null) => prepare('collect', dex, tokenId, null, gas),
    /**
     * Remove all of the liquidity (or `liquidity` of it, a partial exit), with minimums on the principal from the owner's
     * slippage, and pay principal and fees. The NFT stays.
     */
    prepareClose: (dex: Dex, tokenId: bigint, slippageBps: number, gas: V2GasBudget | null = null, liquidity?: bigint) => prepare('close', dex, tokenId, slippageBps, gas, liquidity),
    prepareCloseMany,
    /** A persisted request is a hint, never permission to send. Decode our exact recipes,
     * and match the transaction/receipt on chain through the existing bounded wallet transport.
     * Changed on purpose 2026-10-14 (review of C3 on main): `describe` false, the positions are not read for a description
     * (null): a close's settlement proof (v2in/lists/BulkClosePositions.tsx proofOf) never uses one, and that read took the
     * one-operation lock in the background, so the person's next review or send met "wallet_action_busy". */
    recoverCloseMany: async (hint: DirectCloseRecovery, describe = true): Promise<{ receipt: V2Receipt; description: DirectCloseDescription | null; replaced: boolean; replacementFinal: boolean }> => {
      if (!/^0x[0-9a-f]{64}$/.test(hint.hash) || !/^0x[0-9a-f]+$/.test(hint.nonce) || hint.data.length > 65_536 || hint.tokenIds.length < 1 || hint.tokenIds.length > MAX_CLOSE_POSITIONS || new Set(hint.tokenIds.map(String)).size !== hint.tokenIds.length) fail('invalid_position_id')
      const outer = decodeFunctionData({ abi: V3_MULTICALL_ABI, data: hint.data })
      if (outer.functionName !== 'multicall' || outer.args[0].length !== hint.tokenIds.length) fail('transaction_does_not_match_review')
      outer.args[0].forEach((data, index) => {
        const tokenId = hint.tokenIds[index]
        let canonical: Hex
        if (hint.dex === 4) {
          const call = decodeFunctionData({ abi: V4_POSITION_MANAGER_ABI, data })
          if (call.functionName !== 'modifyLiquidities') return fail('transaction_does_not_match_review')
          const [unlock, deadline] = call.args as readonly [Hex, bigint]
          const [actions, params] = decodeAbiParameters(unlockParameters, unlock)
          if (actions !== '0x0111' || params.length !== 2) return fail('transaction_does_not_match_review')
          const [id, liquidity, min0, min1, hookData] = decodeAbiParameters(decreaseParameters, params[0])
          const [token0, token1, recipient] = decodeAbiParameters(takePairParameters, params[1])
          if (id !== tokenId || liquidity <= 0n || hookData !== '0x' || lower(recipient) !== owner) return fail('transaction_does_not_match_review')
          canonical = closeData(id, liquidity, min0, min1, lower(token0), lower(token1), owner, deadline)
        } else {
          const inner = decodeFunctionData({ abi: V3_MULTICALL_ABI, data }).args[0]
          if (inner.length !== 2) return fail('transaction_does_not_match_review')
          const call = decodeFunctionData({ abi: V3_POSITION_MANAGER_ABI, data: inner[0] })
          if (call.functionName !== 'decreaseLiquidity') return fail('transaction_does_not_match_review')
          const [args] = call.args as readonly [{ tokenId: bigint; liquidity: bigint; amount0Min: bigint; amount1Min: bigint; deadline: bigint }]
          if (args.tokenId !== tokenId || args.liquidity <= 0n) return fail('transaction_does_not_match_review')
          canonical = v3CloseData(args.tokenId, args.liquidity, args.amount0Min, args.amount1Min, owner, args.deadline)
        }
        if (canonical !== data.toLowerCase()) fail('transaction_does_not_match_review')
      })
      const reviewed = { from: owner, to: managerOf(hint.dex), data: hint.data, value: '0x0' as Hex, nonce: hint.nonce, chainId: `0x${chain.chainId.toString(16)}` as Hex }
      const recovered = hint.originalHash !== hint.hash ? await t.replacement(hint.originalHash ?? null, hint.hash, reviewed) : { receipt: await t.receipt(hint.hash, reviewed), replaced: false, final: false }
      const { receipt } = recovered
      if (recovered.replaced ? recovered.final : receipt.state === 'finalized' || receipt.state === 'reverted') for (const id of hint.tokenIds) {
        const key = flightKey(hint.dex, id), flight = inFlight.get(key)
        if (flight?.data === hint.data && flight.nonce !== undefined && BigInt(flight.nonce) === BigInt(hint.nonce) && (flight.hash === null || flight.hash === hint.hash || flight.hash === hint.originalHash)) inFlight.delete(key)
      }
      // A later transfer or burn cannot erase proof of a confirmed withdrawal. Current position metadata is optional;
      // without it the UI records only the proven transaction and NFT IDs, never inferred token quantities.
      let description: DirectCloseDescription | null = null
      if (describe && !recovered.replaced && (receipt.state === 'included' || receipt.state === 'finalized')) {
        const positions = await t.bounded(async (rpc) => {
          const block = await t.latestBlock(rpc)
          return Promise.all(hint.tokenIds.map((id) => readPosition(rpc, hint.dex, id, block)))
        }).catch(() => null)
        if (positions) description = { chainId: chain.chainId, dex: hint.dex, positions }
      }
      return { receipt, description, replaced: recovered.replaced, replacementFinal: recovered.final }
    },
    sendCloseMany: async (prepared: DirectCloseMany, acknowledged: boolean, acknowledgePause = false, onRefusal?: () => Promise<void>): Promise<Hex> => {
      if (!ownGroups.has(prepared)) fail('wallet_review_required')
      if (prepared.pausesAutomation.length && !acknowledgePause) fail('automation_pause_unacknowledged')
      const keys = prepared.positions.map((position) => flightKey(prepared.dex, position.tokenId))
      if (keys.some((key) => inFlight.has(key))) fail('review_already_sent')
      const flights = prepared.positions.map((position) => ({ kind: 'close' as const, liquidity: position.liquidity, block: position.blockNumber, hash: null as Hex | null, data: prepared.step.transaction.data, nonce: prepared.step.transaction.nonce }))
      keys.forEach((key, index) => inFlight.set(key, flights[index]))
      try {
        const hash = await t.send(prepared.step, acknowledged, async (rpc) => {
          if (BigInt(Math.floor(now())) >= prepared.deadline) fail('wallet_review_expired')
          const { positions: current, automation } = await readGroup(rpc, prepared.dex, prepared.positions.map((position) => position.tokenId))
          const previous = groupAutomation.get(prepared)!
          current.forEach((position, index) => {
            const before = prepared.positions[index]
            if (position.liquidity !== before.liquidity || position.approved !== before.approved || position.subscriber !== before.subscriber ||
              position.tickLower !== before.tickLower || position.tickUpper !== before.tickUpper || JSON.stringify(position.pool) !== JSON.stringify(before.pool) ||
              automation[index].pausesAutomation !== previous[index].pausesAutomation || automation[index].vaultRoot !== previous[index].vaultRoot) fail('wallet_review_required')
          })
        }, { inspect: (reply) => inspectGroup(reply, prepared.positions.length), onRefusal: async () => { keys.forEach((key) => inFlight.delete(key)); await onRefusal?.() } })
        flights.forEach((flight) => { flight.hash = hash })
        return hash
      } catch (error) {
        if (refused(error) || error instanceof WalletNotAsked || !t.wasOffered(prepared.step)) keys.forEach((key) => inFlight.delete(key))
        throw error
      }
    },
    wasGroupOffered: (prepared: DirectCloseMany) => t.wasOffered(prepared.step),
    /**
     * Offers a prepared exit to the wallet once (the shared sender's discipline: simulated again, the chain read last),
     * holding its position's in-flight latch (fix F2) from before the wallet is asked.
     */
    /** The person ticked the §2.13 warning for this prepared exit of an armed root: it may be sent. */
    acknowledgePause: (prepared: DirectPrepared): void => {
      if (ownPrepared.has(prepared) && prepared.pausesAutomation !== null) pauseAcknowledged.add(prepared)
    },
    send: async (prepared: DirectPrepared, acknowledged: boolean): Promise<Hex> => {
      if (!ownPrepared.has(prepared)) return fail('wallet_review_required')
      if (heldByJournal(prepared.dex, [prepared.tokenId])) return fail('review_already_sent')
      if (prepared.pausesAutomation !== null && !pauseAcknowledged.has(prepared)) return fail('automation_pause_unacknowledged')
      const key = flightKey(prepared.dex, prepared.tokenId)
      if (inFlight.has(key)) return fail(t.wasOffered(prepared.step) ? 'wallet_review_required' : 'review_already_sent')
      const flight = { kind: prepared.kind, liquidity: prepared.liquidity, block: prepared.state.blockNumber, hash: null as Hex | null }
      inFlight.set(key, flight)
      try {
        const hash = await t.send(prepared.step, acknowledged, async () => {
          if (BigInt(Math.floor(now())) >= prepared.deadline) fail('wallet_review_expired')
        })
        flight.hash = hash
        return hash
      } catch (error) {
        // Nothing reached the wallet, or it refused definitely: the position is free. Any other outcome holds it.
        if (refused(error) || error instanceof WalletNotAsked || !t.wasOffered(prepared.step)) inFlight.delete(key)
        throw error
      }
    },
    /** Where a sent exit stands: "Included", then "Finalized"; a delay is never a failure. Read back on chain, its position is free again. */
    receipt: async (hash: Hex): Promise<V2Receipt> => {
      const receipt = await t.receipt(hash)
      if (receipt.state === 'included' || receipt.state === 'finalized' || receipt.state === 'reverted') {
        for (const [key, flight] of inFlight) if (flight.hash === hash) inFlight.delete(key)
      }
      return receipt
    },
    wasOffered: (prepared: DirectPrepared) => t.wasOffered(prepared.step),
    /** The direct exit of this position this client handed to the wallet and has not seen on chain yet; null when none. */
    inFlight: (dex: Dex, tokenId: bigint): { kind: DirectKind; liquidity: bigint; block: bigint; hash: Hex | null } | null => {
      const flight = inFlight.get(flightKey(dex, tokenId))
      return flight ? Object.freeze({ ...flight }) : null
    },
  })
}
export type DirectClient = ReturnType<typeof createDirectClient>

// ---------------------------------------------------------------------------
// The receipt of a direct exit (spec §2.6.4: "o recibo vem dos eventos da Uniswap")
// ---------------------------------------------------------------------------

const V3_COLLECT_EVENT = [{ name: 'Collect', type: 'event', inputs: [{ type: 'uint256', name: 'tokenId', indexed: true }, { type: 'address', name: 'recipient' }, { type: 'uint256', name: 'amount0' }, { type: 'uint256', name: 'amount1' }] }] as const
const TRANSFER_EVENT = [{ name: 'Transfer', type: 'event', inputs: [{ type: 'address', name: 'from', indexed: true }, { type: 'address', name: 'to', indexed: true }, { type: 'uint256', name: 'value' }] }] as const

/** What one token of a direct exit paid: the exact amount from the logs, or null when the logs cannot say (native ETH on v4). */
export interface DirectPaid {
  token: Address
  amount: bigint | null
}

export interface DirectReceipt {
  chainId: V2ChainId
  kind: DirectKind
  state: 'included' | 'finalized'
  /** What Uniswap paid to the wallet, per pool currency, from the receipt's logs. */
  paid: readonly [DirectPaid, DirectPaid]
  gas: GasCost
}

/**
 * What Uniswap paid, read from the receipt's own logs:
 *   - v3: the position manager's `Collect(tokenId, recipient, amount0, amount1)`, exactly one for this position, to the
 *     owner (it carries principal and fees together; the close's DecreaseLiquidity only moves them to `tokensOwed`);
 *   - v4: the ERC-20 `Transfer` from the chain's PoolManager to the owner for each currency (TAKE_PAIR's payment); native
 *     ETH leaves no log, so a native currency's amount is null (said "not in the receipt's logs", never guessed).
 * A receipt that is not included, or that holds anything else than the exit's own pay-out, is refused.
 */
export function readDirectReceipt(input: { chainId: V2ChainId; kind: DirectKind; dex: Dex; tokenId: bigint; owner: Address; pool: PoolRef; receipt: V2Receipt }): DirectReceipt {
  const chain = v2Chain(input.chainId)
  const receipt = input.receipt
  if (receipt.state !== 'included' && receipt.state !== 'finalized') return fail('receipt_not_included')
  const owner = input.owner.toLowerCase()
  const costs = gasCost(chain.chainId, { gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, l1Fee: receipt.l1Fee })
  if (input.dex === 3) {
    const manager = chain.uniswap.v3.positionManager
    const collects = receipt.logs.filter((log) => log.address === manager && log.topics.length === 2 && log.topics[0] === keccak256(new TextEncoder().encode('Collect(uint256,address,uint256,uint256)')))
    const ours = collects.map((log) => {
      try {
        return decodeEventLog({ abi: V3_COLLECT_EVENT, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true }).args
      } catch {
        return fail('receipt_invalid')
      }
    }).filter((args) => args.tokenId === input.tokenId)
    if (ours.length !== 1 || ours[0].recipient.toLowerCase() !== owner) return fail('receipt_position_mismatch')
    return Object.freeze({
      chainId: chain.chainId, kind: input.kind, state: receipt.state,
      paid: Object.freeze([{ token: input.pool.currency0, amount: ours[0].amount0 }, { token: input.pool.currency1, amount: ours[0].amount1 }] as const),
      gas: costs,
    })
  }
  const poolManager = chain.uniswap.v4.poolManager
  const transferTopic = keccak256(new TextEncoder().encode('Transfer(address,address,uint256)'))
  const paidIn = (token: Address): DirectPaid => {
    if (token === ZERO_ADDRESS) return { token, amount: null }
    const transfers = receipt.logs.filter((log) => log.address === token && log.topics.length === 3 && log.topics[0] === transferTopic)
      .map((log) => {
        try {
          return decodeEventLog({ abi: TRANSFER_EVENT, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true }).args
        } catch {
          return fail('receipt_invalid')
        }
      })
      .filter((args) => args.from.toLowerCase() === poolManager && args.to.toLowerCase() === owner)
    if (transfers.length > 1) return fail('receipt_position_mismatch')
    // No transfer: nothing of that currency was owed (a collect of a position with no fees in it).
    return { token, amount: transfers.length === 1 ? transfers[0].value : 0n }
  }
  return Object.freeze({
    chainId: chain.chainId, kind: input.kind, state: receipt.state,
    paid: Object.freeze([paidIn(input.pool.currency0), paidIn(input.pool.currency1)] as const),
    gas: costs,
  })
}

/** A group receipt counts gas once. V4 transfers identify tokens, never the NFT they came from. */
export function readDirectCloseManyReceipt(prepared: DirectCloseDescription, owner: Address, receipt: V2Receipt): { paid: readonly DirectPaid[]; gas: GasCost; tokenIds: readonly bigint[] } {
  if (receipt.state !== 'included' && receipt.state !== 'finalized') fail('receipt_not_included')
  const confirmed = receipt as Extract<V2Receipt, { logs: unknown }>
  const chain = v2Chain(prepared.chainId)
  const totals = new Map<Address, bigint | null>()
  if (prepared.dex === 3) {
    for (const position of prepared.positions) {
      const entry = readDirectReceipt({ chainId: prepared.chainId, kind: 'close', dex: 3, tokenId: position.tokenId, owner, pool: position.pool, receipt })
      for (const { token, amount } of entry.paid) totals.set(token, amount === null ? null : (totals.get(token) ?? 0n) + amount)
    }
  } else {
    const transferTopic = keccak256(new TextEncoder().encode('Transfer(address,address,uint256)'))
    for (const position of prepared.positions) for (const token of [position.pool.currency0, position.pool.currency1]) totals.set(token, token === ZERO_ADDRESS ? null : 0n)
    for (const log of confirmed.logs) {
      if (!totals.has(log.address) || log.topics.length !== 3 || log.topics[0] !== transferTopic) continue
      let args
      try { args = decodeEventLog({ abi: TRANSFER_EVENT, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true }).args }
      catch { return fail('receipt_invalid') }
      if (args.from.toLowerCase() === chain.uniswap.v4.poolManager && args.to.toLowerCase() === owner.toLowerCase()) totals.set(log.address, (totals.get(log.address) ?? 0n) + args.value)
    }
  }
  return Object.freeze({ paid: Object.freeze([...totals].map(([token, amount]) => Object.freeze({ token, amount }))),
    gas: gasCost(chain.chainId, { gasUsed: confirmed.gasUsed, effectiveGasPrice: confirmed.effectiveGasPrice, l1Fee: confirmed.l1Fee }),
    tokenIds: Object.freeze(prepared.positions.map((position) => position.tokenId)) })
}
