import { decodeAbiParameters, decodeFunctionData, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, numberToHex, zeroAddress, type Address, type Hex } from 'viem'
import { SLIPPAGE_MAX_BPS, SLIPPAGE_MIN_BPS, slippageWritten } from './slippage.js'
import { POSITION_MANAGER, SETUP_CONTRACT, V4_QUOTER, V4_QUOTER_CODE_HASH, pinned, unpinned } from './pin.js'
import { readAccountCode, type AccountCode } from './delegates.js'
import { BATCH_FRAME_GAS, batchCallsStatus, offerBatch, simulateBatch, type BatchCall, type BatchSimulator } from './batch.js'
export { atomicStatus, type AtomicStatus, type BatchCall, type BatchSimulator } from './batch.js'

/*
 * The closed ABIs are written as JSON: exactly what viem's parseAbi and
 * parseAbiParameters make of the reviewed signatures listed with each one, so
 * the page ships no ABI parser. tests/performance.controller.test.mjs parses
 * those signature lines and requires every JSON form here to equal the result.
 */

/**
 * setupAbi signatures:
 *   struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
 *   struct Operation { address owner; PoolKey key; uint128 balance0; uint128 balance1; bool swapped; bool closed; uint256 tokenId; }
 *   struct SwapPlan { bytes32 operationId; bool zeroForOne; uint128 grossInput; uint128 minOutput; uint160 sqrtPriceLimitX96; uint64 deadline; }
 *   struct MintPlan { bytes32 operationId; int24 tickLower; int24 tickUpper; uint128 liquidity; uint128 maxAmount0; uint128 maxAmount1; uint160 minSqrtPriceX96; uint160 maxSqrtPriceX96; uint160 initialSqrtPriceX96; uint64 deadline; }
 *   function manager() view returns (address)
 *   function positions() view returns (address)
 *   function stateView() view returns (address)
 *   function feeRecipient() view returns (address)
 *   function assistedFeeBps() view returns (uint16)
 *   function tariffVersion() view returns (uint64)
 *   function ownerNonce(address) view returns (uint64)
 *   function nextOperationId(address) view returns (bytes32)
 *   function operation(bytes32) view returns (Operation)
 *   function recoveryStarted(bytes32) view returns (bool)
 *   function open(bytes32 id, PoolKey key, uint128 amount0, uint128 amount1) payable
 *   function swap(SwapPlan) returns (uint128 output)
 *   function mint(MintPlan)
 *   function cancel(bytes32)
 *   function recoverCurrency(bytes32 id, address currency, uint128 amount)
 */
const poolKeyComponents = [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] as const
const operationComponents = [{ name: 'owner', type: 'address' }, { name: 'key', type: 'tuple', components: poolKeyComponents }, { name: 'balance0', type: 'uint128' }, { name: 'balance1', type: 'uint128' }, { name: 'swapped', type: 'bool' }, { name: 'closed', type: 'bool' }, { name: 'tokenId', type: 'uint256' }] as const
const swapPlanComponents = [{ name: 'operationId', type: 'bytes32' }, { name: 'zeroForOne', type: 'bool' }, { name: 'grossInput', type: 'uint128' }, { name: 'minOutput', type: 'uint128' }, { name: 'sqrtPriceLimitX96', type: 'uint160' }, { name: 'deadline', type: 'uint64' }] as const
const mintPlanComponents = [{ name: 'operationId', type: 'bytes32' }, { name: 'tickLower', type: 'int24' }, { name: 'tickUpper', type: 'int24' }, { name: 'liquidity', type: 'uint128' }, { name: 'maxAmount0', type: 'uint128' }, { name: 'maxAmount1', type: 'uint128' }, { name: 'minSqrtPriceX96', type: 'uint160' }, { name: 'maxSqrtPriceX96', type: 'uint160' }, { name: 'initialSqrtPriceX96', type: 'uint160' }, { name: 'deadline', type: 'uint64' }] as const
export const setupAbi = [
  { name: 'manager', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'positions', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'stateView', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'feeRecipient', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'assistedFeeBps', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },
  { name: 'tariffVersion', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { name: 'ownerNonce', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint64' }] },
  { name: 'nextOperationId', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bytes32' }] },
  { name: 'operation', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'tuple', components: operationComponents }] },
  { name: 'recoveryStarted', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bool' }] },
  { name: 'open', type: 'function', stateMutability: 'payable', inputs: [{ name: 'id', type: 'bytes32' }, { name: 'key', type: 'tuple', components: poolKeyComponents }, { name: 'amount0', type: 'uint128' }, { name: 'amount1', type: 'uint128' }], outputs: [] },
  { name: 'swap', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'tuple', components: swapPlanComponents }], outputs: [{ name: 'output', type: 'uint128' }] },
  { name: 'mint', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'tuple', components: mintPlanComponents }], outputs: [] },
  { name: 'cancel', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'bytes32' }], outputs: [] },
  { name: 'recoverCurrency', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'id', type: 'bytes32' }, { name: 'currency', type: 'address' }, { name: 'amount', type: 'uint128' }], outputs: [] },
] as const
/**
 * tokenAbi signatures:
 *   function allowance(address,address) view returns(uint256)
 *   function approve(address,uint256) returns(bool)
 */
export const tokenAbi = [
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const
/**
 * quoterAbi signatures:
 *   struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
 *   struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }
 *   function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)
 *   function poolManager() view returns (address)
 */
export const quoterAbi = [
  { name: 'quoteExactInputSingle', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'params', type: 'tuple', components: [{ name: 'poolKey', type: 'tuple', components: poolKeyComponents }, { name: 'zeroForOne', type: 'bool' }, { name: 'exactAmount', type: 'uint128' }, { name: 'hookData', type: 'bytes' }] }], outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'gasEstimate', type: 'uint256' }] },
  { name: 'poolManager', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const
/** operationIdParameters signature: uint256,address,address,uint64 */
export const operationIdParameters = [{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint64' }] as const
export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
export type SetupOperation = { owner: Address; key: PoolKey; balance0: bigint; balance1: bigint; swapped: boolean; closed: boolean; tokenId: bigint; recoveryStarted: boolean }
export interface SetupDeployment {
  setup: Address; setupCodeHash: Hex; poolManager: Address; positionManager: Address; stateView: Address
  poolManagerCodeHash: Hex; positionManagerCodeHash: Hex; stateViewCodeHash: Hex
  feeRecipient: Address; feeBps: number; tariffVersion: string; expiresAt: number
}
export interface WalletRpc {
  owner: Address; current(): boolean; request(method: string, params: unknown[]): Promise<unknown>
  nonceOffered(nonce: bigint): boolean; claimNonce(nonce: bigint): Promise<string>; releaseRejectedNonce(nonce: bigint, token: string): Promise<void>
  /** Whether the person confirmed on this page that they set up this EIP-7702 delegate themselves (./delegates.ts). */
  delegateConfirmed?(delegate: Address): boolean
  /** The latch of a batch offered for this owner's operation (./nonce.ts): the wallet's id for it, '' before it answered, null when none. */
  batchOffered?(operationId: Hex): string | null
  claimBatch?(operationId: Hex): Promise<string>
  recordBatch?(operationId: Hex, claim: string, id: string): Promise<void>
  releaseBatch?(operationId: Hex, claim: string): Promise<void>
  /** Frees the latch claimed more than `maxAge` seconds before `now`, answered or not (./nonce.ts expireBatch); true when it did. */
  expireBatch?(operationId: Hex, now: number, maxAge: number): Promise<boolean>
}
/**
 * What a batch opens and makes (./setup.ts prepareBatch): the funding, the assisted swap of a one-token deposit with
 * the least it may pay, and the mint sized for that least, all inside the operation the batch opens.
 */
export interface BatchPlan {
  key: PoolKey; amount0: bigint; amount1: bigint
  swap: { zeroForOne: boolean; gross: bigint; minOutput: bigint; sqrtLimit: bigint } | null
  mint: { tickLower: number; tickUpper: number; liquidity: bigint; maxAmount0: bigint; maxAmount1: bigint; minSqrtPriceX96: bigint; maxSqrtPriceX96: bigint; initialSqrtPriceX96: bigint }
}
export interface PreparedBatch {
  kind: 'batch'; operationId: Hex; owner: Address; expiresAt: number
  calls: readonly BatchCall[]
  /** The gas the simulation used for every call together, and the limit asked of the wallet's budget with room. */
  gasUsed: bigint; gasLimit: bigint
  summary: readonly string[]
}
/** Where a batch stands, read from the wallet and then from the operation it opened: the effect decides. */
export type BatchState =
  | { state: 'pending' }
  | { state: 'created'; tokenId: bigint }
  | { state: 'held' }
  | { state: 'dropped' | 'reverted' | 'unknown' }
export interface GasBudget { maxGas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; reserveWei: bigint }
/** A pool as the chain has it now: StateView's slot0 and in-range liquidity, and the latest block's time (seconds). */
export interface PoolState { sqrtPriceX96: bigint; tick: number; protocolFee: number; lpFee: number; liquidity: bigint; chainTime: number }
/** V4Quoter's answer for `net` and `net + step` of one token in, or why it refused (quotePool). */
export type PoolQuote = { kind: 'quote'; out: bigint; outNext: bigint } | { kind: 'refused'; reason: 'not_enough_liquidity' | 'pool_not_initialized' | 'reverted' }
export interface PreparedSetup {
  kind: 'approve' | 'fund' | 'swap' | 'mint' | 'cancel' | 'recover'; operationId: Hex | null; owner: Address; expiresAt: number
  transaction: { from: Address; to: Address; data: Hex; value: Hex; nonce: Hex; gas: Hex; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex; chainId: '0x1237'; type: '0x2' }
  summary: readonly string[]
}
const ADDRESS = /^0x[0-9a-f]{40}$/, HASH = /^0x[0-9a-f]{64}$/
/**
 * How long a send waits for the wallet's answer. Every other step is bounded
 * to 25 seconds of reads; a signature is a person reading a transaction on a
 * phone, so it gets its own window. The prepared step itself still expires 25
 * seconds after it was simulated, and is checked before the wallet is asked.
 */
export const SIGN_WINDOW_S = 180
/**
 * The on-chain deadline a swap or mint carries: the signing window plus room
 * for inclusion, well inside the contract's 1,200 seconds. A deadline shorter
 * than the time a person may take to sign would revert a signed step; the
 * price band, not the deadline, is what bounds the price it executes at.
 */
export const STEP_DEADLINE_S = SIGN_WINDOW_S + 300
/**
 * How long a batch's latch holds the operation it would open (./nonce.ts expireBatch; 2026-09-28). A batch ends with
 * the mint, whose deadline the contract refuses once past, and refuses more than 1,200 s after the block it runs in;
 * the batch was simulated whole against the newest block just before it was offered, and executes whole or not at
 * all. So 1,200 s after the latch was claimed nothing of it can execute, whatever the device's clock says of the
 * chain's; five minutes more for good measure. Even a batch still held past this could only revert: the contract
 * opens each operation id once.
 */
export const BATCH_LATCH_EXPIRY_S = 1_200 + 300
const fail = (code: string): never => { throw new Error(code) }
const asHex = (value: unknown): Hex => typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value) ? value as Hex : fail('invalid_wallet_reply')
const quantity = (value: unknown): bigint => typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) ? BigInt(value) : fail('invalid_wallet_quantity')
/**
 * A simulated call the contract itself refused, as opposed to a wallet or network failure, with its revert data when
 * the wallet passed it on. Wallets and their libraries wrap a node's `{ code: 3, message: 'execution reverted', data }`
 * in errors of their own, so the error is walked four levels down through `data`, `originalError`, `cause` and
 * `error`: a revert is code 3 at any level, 0x-hex `data`, or a message that says it reverted. A request declined in
 * the wallet (4001) or rate-limited (429) is never a revert, whatever it carries. Null when it is not a revert.
 */
export function revertOf(error: unknown): { data: Hex | null } | null {
  let reverted = false, other = false, data: Hex | null = null
  const walk = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 4) return
    const node = value as { code?: unknown; message?: unknown; data?: unknown; originalError?: unknown; cause?: unknown; error?: unknown }
    if (node.code === 4001 || node.code === 429) other = true
    if (node.code === 3) reverted = true
    if (typeof node.data === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(node.data)) { reverted = true; data ??= node.data as Hex }
    if (typeof node.message === 'string' && /execution reverted|revert/i.test(node.message)) reverted = true
    for (const next of [node.data, node.originalError, node.cause, node.error]) walk(next, depth + 1)
  }
  walk(error, 0)
  return reverted && !other ? { data } : null
}
export const isRevert = (error: unknown): boolean => revertOf(error) !== null
/**
 * Whether the connected account can be paid plain ETH, read through the
 * wallet's own provider: no signature, no transaction.
 *
 * An account without code always can. An EIP-7702 account runs its delegate's
 * code on every payment, and a delegate with no payable receive() or fallback()
 * refuses it. Then every refund or withdrawal in native ETH reverts until the
 * owner changes or clears the delegation in their wallet; the funds stay where
 * they are meanwhile. So a step that pays ETH out, or would lock ETH that only
 * such a payment can return, asks first.
 *
 * The probe simulates one wei from the account to itself. Only a revert means
 * "refused"; a read that fails any other way throws, as every other read here.
 */
export async function acceptsNativeEth(read: (method: string, params: unknown[]) => Promise<unknown>,
  owner: Address, block = 'latest'): Promise<boolean> {
  if (await read('eth_getCode', [owner, block]) === '0x') return true
  try {
    await read('eth_call', [{ from: owner, to: owner, value: '0x1' }, block])
    return true
  } catch (error) {
    if (isRevert(error)) return false
    throw error
  }
}
/**
 * Why V4Quoter refused a size, from its revert data. It re-wraps every failure as UnexpectedRevertBytes(bytes)
 * (0x6190b2b0) around the pool's own error: NotEnoughLiquidity (0x7a5ed734) when the pool cannot fill the amount,
 * PoolNotInitialized (0x486aa307) when it has no price.
 */
function quoterRefusal(data: Hex | null): Extract<PoolQuote, { kind: 'refused' }>['reason'] {
  if (!data || data.slice(0, 10).toLowerCase() !== '0x6190b2b0') return 'reverted'
  try {
    const [inner] = decodeAbiParameters([{ type: 'bytes' }], `0x${data.slice(10)}`)
    const selector = inner.slice(0, 10).toLowerCase()
    return selector === '0x7a5ed734' ? 'not_enough_liquidity' : selector === '0x486aa307' ? 'pool_not_initialized' : 'reverted'
  } catch {
    return 'reverted'
  }
}
export function deploymentFrom(value: unknown, now = Date.now() / 1000): SetupDeployment | null {
  if (!value || typeof value !== 'object') return fail('invalid_setup_release')
  const r = value as Record<string, unknown>
  if (Object.keys(r).sort().join() !== 'available,chainId,contractVersion,deployment' || r.contractVersion !== '1.0.0-rc.1' || r.chainId !== 4663) return fail('invalid_setup_release')
  if (r.available === false && r.deployment === null) return null
  if (r.available !== true || !r.deployment || typeof r.deployment !== 'object') return fail('invalid_setup_release')
  const d = r.deployment as Record<string, unknown>
  const addresses = ['setup', 'poolManager', 'positionManager', 'stateView', 'feeRecipient'], hashes = ['setupCodeHash', 'poolManagerCodeHash', 'positionManagerCodeHash', 'stateViewCodeHash']
  if (Object.keys(d).sort().join() !== [...addresses, ...hashes, 'feeBps', 'tariffVersion', 'expiresAt'].sort().join()
    || !addresses.every(k => typeof d[k] === 'string' && ADDRESS.test(d[k]) && d[k] !== zeroAddress)
    || !hashes.every(k => typeof d[k] === 'string' && HASH.test(d[k]) && !/^0x0+$/.test(d[k]))
    || !Number.isSafeInteger(d.feeBps) || Number(d.feeBps) < 0 || Number(d.feeBps) > 65
    || typeof d.tariffVersion !== 'string' || !/^[1-9][0-9]{0,19}$/.test(d.tariffVersion) || BigInt(d.tariffVersion) >= 2n ** 64n
    || !Number.isSafeInteger(d.expiresAt) || Number(d.expiresAt) <= now) return fail('invalid_setup_release')
  // The same anchor the sequence lane needs, for the same reason: this record
  // names the contract that tokens are approved to, and every check above
  // compares the record against itself. See ./pin.ts.
  if (!pinned(SETUP_CONTRACT, d.setup)) return fail(unpinned(SETUP_CONTRACT) ? 'deployment_not_pinned' : 'deployment_identity_unpinned')
  if (!pinned(POSITION_MANAGER, d.positionManager)) return fail('deployment_identity_unpinned')
  return d as unknown as SetupDeployment
}
export function raw(value: string, bits = 128): bigint {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(value)) return fail('invalid_amount')
  const n = BigInt(value); return n < 2n ** BigInt(bits) ? n : fail('amount_out_of_range')
}
export function poolKey(key: PoolKey): PoolKey {
  if (![key.currency0, key.currency1, key.hooks].every(v => ADDRESS.test(v)) || key.currency0 >= key.currency1 || key.hooks !== zeroAddress
    || !Number.isSafeInteger(key.fee) || key.fee < 0 || key.fee > 1_000_000 || !Number.isSafeInteger(key.tickSpacing) || key.tickSpacing < 1 || key.tickSpacing > 32767) return fail('invalid_pool_key')
  return key
}
// Each operation is bounded and uses the selected wallet's provider. No RPC URL,
// signer, allowance spender or calldata comes from a backend response.
/** getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee) */
const slot0Abi = [{ name: 'getSlot0', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint160' }, { type: 'int24' }, { type: 'uint24' }, { type: 'uint24' }] }] as const
/** getLiquidity(bytes32 poolId) view returns (uint128 liquidity): the pool's in-range liquidity now. */
const liquidityAbi = [{ name: 'getLiquidity', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint128' }] }] as const
const poolIdOf = (key: PoolKey) => keccak256(encodeAbiParameters([{ type: 'tuple', components: poolKeyComponents }], [key]))
/** balanceOf(address) view returns (uint256) */
const balanceAbi = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }] as const
/**
 * The wallet's balance of one currency, read through its own provider: native
 * ETH with eth_getBalance, a token with balanceOf. Reads only; for saying what
 * is missing before a deposit is prepared (components/create/CreatePosition.tsx).
 */
export async function walletBalance(wallet: WalletRpc, currency: Address): Promise<bigint> {
  if (currency === zeroAddress) return quantity(await wallet.request('eth_getBalance', [wallet.owner, 'latest']))
  const data = encodeFunctionData({ abi: balanceAbi, functionName: 'balanceOf', args: [wallet.owner] })
  return decodeFunctionResult({ abi: balanceAbi, functionName: 'balanceOf', data: asHex(await wallet.request('eth_call', [{ to: currency, data }, 'latest'])) })
}
export function createSetupClient(wallet: WalletRpc, supplied: SetupDeployment, now = () => Date.now() / 1000,
  currentAdmission?: () => Promise<SetupDeployment | null>, options: { simulate?: BatchSimulator } = {}) {
  const deployment = Object.freeze({ ...supplied })
  const issued = new WeakSet<PreparedSetup>(), offered = new Set<string>(), issuedBatches = new WeakSet<PreparedBatch>()
  const returned = new Map<Hex, PreparedSetup>()
  let busy = false
  /** Whether V4Quoter's code and PoolManager were read back as pinned, once for this client (quotePool). */
  let quoterVerified = false
  async function bounded<T>(work: (rpc: (method: string, params: unknown[], onUserRejection?: () => Promise<void>) => Promise<unknown>) => Promise<T>, seconds = 25): Promise<T> {
    if (busy) return fail('wallet_action_busy')
    busy = true
    const end = now() + seconds
    let calls = 0
    const rpc = async (method: string, params: unknown[], onUserRejection?: () => Promise<void>) => {
      if (!wallet.current() || now() >= end || ++calls > 48) return fail('wallet_action_expired')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // Keep a definite wallet rejection observable even if our deadline has
        // already won. An unknown outcome must retain its nonce quarantine.
        const request = wallet.request(method, params).catch(async error => {
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
  async function call(rpc: Rpc, name: 'manager' | 'positions' | 'stateView' | 'feeRecipient' | 'assistedFeeBps' | 'tariffVersion') {
    const data = encodeFunctionData({ abi: setupAbi, functionName: name })
    return decodeFunctionResult({ abi: setupAbi, functionName: name, data: asHex(await rpc('eth_call', [{ to: deployment.setup, data }, 'latest'])) })
  }
  async function verify(rpc: Rpc, recovery = false) {
    await identity(rpc)
    if (!recovery && now() >= deployment.expiresAt) return fail('setup_release_expired')
    if (!recovery) {
      // The screen confirms the public release with one bounded same-origin
      // GET. A loaded client cannot approve/fund/swap/mint after OFF or drift.
      // Reads and cancellation deliberately remain independent of this API.
      let current: SetupDeployment | null | undefined
      try { current = await currentAdmission?.() } catch { return fail('setup_admission_unavailable') }
      const identities: (keyof SetupDeployment)[] = ['setup','setupCodeHash','poolManager','poolManagerCodeHash','positionManager','positionManagerCodeHash','stateView','stateViewCodeHash','feeRecipient','feeBps','tariffVersion']
      if (!current || now() >= current.expiresAt || identities.some(key => current[key] !== deployment[key])) return fail('setup_admission_unavailable')
    }
    const dependencies = [[deployment.poolManager, deployment.poolManagerCodeHash], [deployment.positionManager, deployment.positionManagerCodeHash], [deployment.stateView, deployment.stateViewCodeHash]] as const
    for (const [address, hash] of [[deployment.setup, deployment.setupCodeHash], ...(recovery ? [] : dependencies)] as const) {
      if (keccak256(asHex(await rpc('eth_getCode', [address, 'latest']))) !== hash) return fail('deployment_code_changed')
    }
    for (const [name, expected] of [['manager', deployment.poolManager], ['positions', deployment.positionManager], ['stateView', deployment.stateView], ['feeRecipient', deployment.feeRecipient], ['assistedFeeBps', deployment.feeBps], ['tariffVersion', deployment.tariffVersion]] as const) {
      if (String(await call(rpc, name)).toLowerCase() !== String(expected)) return fail('deployment_identity_changed')
    }
  }
  /** The id the setup contract gives this owner's next operation: the one a batch opens, and only that one. */
  async function nextOperationId(rpc: Rpc): Promise<Hex> {
    const data = encodeFunctionData({ abi: setupAbi, functionName: 'nextOperationId', args: [wallet.owner] })
    const id = decodeFunctionResult({ abi: setupAbi, functionName: 'nextOperationId', data: asHex(await rpc('eth_call', [{ to: deployment.setup, data }, 'latest'])) })
    return (HASH.test(id.toLowerCase()) ? id.toLowerCase() : fail('invalid_operation_id')) as Hex
  }
  /** The operation as the setup contract holds it, whoever owns it: an id never opened reads with the zero owner. */
  async function stored(rpc: Rpc, id: Hex) {
    if (!HASH.test(id)) return fail('invalid_operation_id')
    const data = encodeFunctionData({ abi: setupAbi, functionName: 'operation', args: [id] })
    return decodeFunctionResult({ abi: setupAbi, functionName: 'operation', data: asHex(await rpc('eth_call', [{ to: deployment.setup, data }, 'latest'])) })
  }
  async function operation(rpc: Rpc, id: Hex) {
    const op = await stored(rpc, id)
    if (op.owner.toLowerCase() !== wallet.owner) return fail('operation_not_owned')
    const recoveryData = encodeFunctionData({ abi: setupAbi, functionName: 'recoveryStarted', args: [id] })
    const recoveryStarted = decodeFunctionResult({ abi: setupAbi, functionName: 'recoveryStarted', data: asHex(await rpc('eth_call', [{ to: deployment.setup, data: recoveryData }, 'latest'])) })
    return { ...op, recoveryStarted }
  }
  async function prepare(rpc: Rpc, kind: PreparedSetup['kind'], operationId: Hex | null, to: Address, data: Hex, value: bigint, gas: GasBudget, summary: string[]) {
    if (gas.maxGas < 21000n || gas.maxGas > 15_000_000n || gas.maxFeePerGas <= 0n || gas.maxFeePerGas >= 2n ** 128n || gas.maxPriorityFeePerGas < 0n || gas.maxPriorityFeePerGas > gas.maxFeePerGas || gas.reserveWei < 0n) return fail('invalid_gas_budget')
    const latest = quantity(await rpc('eth_getTransactionCount', [wallet.owner, 'latest'])), pending = quantity(await rpc('eth_getTransactionCount', [wallet.owner, 'pending']))
    if (latest !== pending || offered.has(String(pending)) || wallet.nonceOffered(pending)) return fail('pending_wallet_transaction')
    const tx = { from: wallet.owner, to, data, value: numberToHex(value) }
    await rpc('eth_call', [tx, 'latest'])
    const estimate = quantity(await rpc('eth_estimateGas', [tx]))
    const limit = (estimate * 120n + 99n) / 100n
    if (limit > gas.maxGas) return fail('gas_budget_exceeded')
    if (quantity(await rpc('eth_getBalance', [wallet.owner, 'latest'])) < value + limit * gas.maxFeePerGas + gas.reserveWei) return fail('native_gas_reserve_insufficient')
    const result: PreparedSetup = Object.freeze({ kind, operationId, owner: wallet.owner, expiresAt: now() + 25,
      transaction: Object.freeze({ ...tx, chainId: '0x1237', type: '0x2', nonce: numberToHex(pending), gas: numberToHex(limit), maxFeePerGas: numberToHex(gas.maxFeePerGas), maxPriorityFeePerGas: numberToHex(gas.maxPriorityFeePerGas) }),
      summary: Object.freeze([...summary, `Maximum network cost: ${limit * gas.maxFeePerGas} wei.`, `Contract: ${deployment.setup}`]) })
    issued.add(result); return result
  }
  return {
    deployment,
    /** The connected account this client prepares for. */
    owner: wallet.owner,
    /** The pool's square-root price now, read on chain through the wallet from the deployment's own StateView. Reads only. */
    price: (key: PoolKey) => bounded(async rpc => {
      await identity(rpc); poolKey(key)
      const id = keccak256(encodeAbiParameters([{ type: 'tuple', components: poolKeyComponents }], [key]))
      const data = encodeFunctionData({ abi: slot0Abi, functionName: 'getSlot0', args: [id] })
      const [sqrtPriceX96] = decodeFunctionResult({ abi: slot0Abi, functionName: 'getSlot0', data: asHex(await rpc('eth_call', [{ to: deployment.stateView, data }, 'latest'])) })
      if (sqrtPriceX96 === 0n) return fail('pool_not_initialized')
      return sqrtPriceX96
    }),
    /**
     * The pool now, from the deployment's own StateView, through the wallet: its slot0 (price, tick, packed protocol
     * fee, LP fee), its in-range liquidity, and the time of the block both are read at — the latest one, read first,
     * so the three describe one state of the pool. Reads only; for checking a pool before a one-token deposit is made
     * into it.
     */
    poolState: (key: PoolKey) => bounded(async (rpc): Promise<PoolState> => {
      await identity(rpc); poolKey(key)
      const id = poolIdOf(key)
      const block = await rpc('eth_getBlockByNumber', ['latest', false]) as { number?: unknown; timestamp?: unknown } | null
      const at = numberToHex(quantity(block?.number))
      const slot = encodeFunctionData({ abi: slot0Abi, functionName: 'getSlot0', args: [id] })
      const [sqrtPriceX96, tick, protocolFee, lpFee] = decodeFunctionResult({ abi: slot0Abi, functionName: 'getSlot0', data: asHex(await rpc('eth_call', [{ to: deployment.stateView, data: slot }, at])) })
      if (sqrtPriceX96 === 0n) return fail('pool_not_initialized')
      const held = encodeFunctionData({ abi: liquidityAbi, functionName: 'getLiquidity', args: [id] })
      const liquidity = decodeFunctionResult({ abi: liquidityAbi, functionName: 'getLiquidity', data: asHex(await rpc('eth_call', [{ to: deployment.stateView, data: held }, at])) })
      return { sqrtPriceX96, tick, protocolFee, lpFee, liquidity, chainTime: Number(quantity(block?.timestamp)) }
    }),
    /**
     * What `net` of one token buys in this pool, and what `net + step` buys, from Uniswap's V4Quoter through the
     * wallet (`net` is what reaches the pool: the setup contract's swap of a gross amount quotes exactly as this
     * quote of the gross less the assisted fee). Two sizes, so the rate at the end of the swap can be read from their
     * difference; both are asked at one block, read once, so a swap in between cannot move one and not the other
     * (the difference is thousands of times more sensitive to the pool moving than the rate is). The quoter's code
     * and PoolManager are read back once per client against the pin (./pin.ts V4_QUOTER); a quoter that reverts is
     * `refused`, with the pool's reason. Reads only; used before anything is deposited, never by fund, swap, mint,
     * cancel or recover.
     */
    quotePool: (key: PoolKey, zeroForOne: boolean, net: bigint, step: bigint) => bounded(async (rpc): Promise<PoolQuote> => {
      await identity(rpc); poolKey(key)
      if (net <= 0n || step <= 0n || net + step >= 2n ** 128n) return fail('invalid_swap_budget')
      if (!quoterVerified) {
        if (keccak256(asHex(await rpc('eth_getCode', [V4_QUOTER, 'latest']))) !== V4_QUOTER_CODE_HASH) return fail('quoter_identity_changed')
        const manager = decodeFunctionResult({ abi: quoterAbi, functionName: 'poolManager', data: asHex(await rpc('eth_call', [{ to: V4_QUOTER, data: encodeFunctionData({ abi: quoterAbi, functionName: 'poolManager' }) }, 'latest'])) })
        if (manager.toLowerCase() !== deployment.poolManager) return fail('quoter_identity_changed')
        quoterVerified = true
      }
      const at = numberToHex(quantity(await rpc('eth_blockNumber', [])))
      const out: bigint[] = []
      for (const exactAmount of [net, net + step]) {
        const data = encodeFunctionData({ abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: key, zeroForOne, exactAmount, hookData: '0x' }] })
        let reply: unknown
        try {
          reply = await rpc('eth_call', [{ to: V4_QUOTER, data }, at])
        } catch (error) {
          const refused = revertOf(error)
          if (!refused) throw error
          return { kind: 'refused', reason: quoterRefusal(refused.data) }
        }
        out.push(decodeFunctionResult({ abi: quoterAbi, functionName: 'quoteExactInputSingle', data: asHex(reply) })[0])
      }
      return { kind: 'quote', out: out[0], outNext: out[1] }
    }),
    /** The connected account's code, and the EIP-7702 delegate it names if any, recognized or not (./delegates.ts). Reads only. */
    account: () => bounded(async (rpc): Promise<AccountCode> => { await identity(rpc); return readAccountCode(rpc, wallet.owner) }),
    inspect: (id: Hex) => bounded(async rpc => { await verify(rpc, true); return operation(rpc, id) }),
    recent: () => bounded(async rpc => {
      await verify(rpc, true)
      const data = encodeFunctionData({ abi: setupAbi, functionName: 'ownerNonce', args: [wallet.owner] })
      const n = decodeFunctionResult({ abi: setupAbi, functionName: 'ownerNonce', data: asHex(await rpc('eth_call', [{ to: deployment.setup, data }, 'latest'])) })
      const values: { id: Hex; operation: SetupOperation }[] = []
      for (let i = n; i > 0n && i > n - 8n; i--) {
        const id = keccak256(encodeAbiParameters(operationIdParameters, [4663n, deployment.setup, wallet.owner, i - 1n]))
        values.push({ id, operation: await operation(rpc, id) })
      }
      return values
    }),
    /**
     * What swapping `gross` of this operation's token buys, from the contract itself: the swap simulated through
     * the wallet with a minimum output of one unit, the pool's fee, its price impact and the assisted-swap fee all
     * in it. Reads only; for sizing a swap before it is prepared.
     */
    quoteSwap: (id: Hex, zeroForOne: boolean, gross: bigint, sqrtLimit: bigint) => bounded(async rpc => {
      await identity(rpc); const op = await operation(rpc, id)
      if (op.closed || op.swapped || op.recoveryStarted || gross <= 0n || gross > (zeroForOne ? op.balance0 : op.balance1) || sqrtLimit <= 0n || sqrtLimit >= 2n ** 160n) return fail('invalid_swap_budget')
      const plan = { operationId: id, zeroForOne, grossInput: gross, minOutput: 1n, sqrtPriceLimitX96: sqrtLimit, deadline: BigInt(Math.floor(now()) + STEP_DEADLINE_S) }
      const data = encodeFunctionData({ abi: setupAbi, functionName: 'swap', args: [plan] })
      return decodeFunctionResult({ abi: setupAbi, functionName: 'swap', data: asHex(await rpc('eth_call', [{ from: wallet.owner, to: deployment.setup, data }, 'latest'])) })
    }),
    fund: (key: PoolKey, amount0: bigint, amount1: bigint, gas: GasBudget) => bounded(async rpc => {
      await verify(rpc); poolKey(key)
      if (amount0 < 0n || amount1 < 0n || amount0 >= 2n ** 128n || amount1 >= 2n ** 128n || amount0 + amount1 === 0n) return fail('invalid_funding')
      // New funds, and the position they become, are held by an account whose delegate's code runs on all of it. A
      // delegate this app does not recognize waits for the person to confirm they set it up, before any approval.
      const account = await readAccountCode(rpc, wallet.owner)
      if (account.kind === 'delegated' && account.known === null && wallet.delegateConfirmed?.(account.delegate) !== true) return fail('delegate_unrecognized')
      // Mint's leftover and every refund of this operation pay ETH back: never
      // lock ETH (or approve anything) for an account that refuses it.
      if (key.currency0 === zeroAddress && !await acceptsNativeEth(rpc, wallet.owner)) return fail('native_eth_refused')
      for (const [token, amount] of [[key.currency0, amount0], [key.currency1, amount1]] as const) {
        if (token === zeroAddress || amount === 0n) continue
        const data = encodeFunctionData({ abi: tokenAbi, functionName: 'allowance', args: [wallet.owner, deployment.setup] })
        const allowance = decodeFunctionResult({ abi: tokenAbi, functionName: 'allowance', data: asHex(await rpc('eth_call', [{ to: token, data }, 'latest'])) })
        if (allowance < amount) {
          const exact = allowance === 0n ? amount : 0n
          return prepare(rpc, 'approve', null, token, encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [deployment.setup, exact] }), 0n, gas,
            [`Approve ${exact} smallest units of ${token} to ${deployment.setup}.`, exact === 0n ? 'Reset an existing allowance before setting the exact budget.' : 'Exact allowance; no unlimited approval.'])
        }
      }
      const data = encodeFunctionData({ abi: setupAbi, functionName: 'nextOperationId', args: [wallet.owner] })
      const id = decodeFunctionResult({ abi: setupAbi, functionName: 'nextOperationId', data: asHex(await rpc('eth_call', [{ to: deployment.setup, data }, 'latest'])) })
      return prepare(rpc, 'fund', id, deployment.setup, encodeFunctionData({ abi: setupAbi, functionName: 'open', args: [id, key, amount0, amount1] }), key.currency0 === zeroAddress ? amount0 : 0n, gas,
        [`Fund ${amount0} smallest units of ${key.currency0} and ${amount1} of ${key.currency1}.`, 'Funds stay in your setup operation until mint or refund. Funding has no Domino percentage fee.'])
    }),
    swap: (id: Hex, zeroForOne: boolean, gross: bigint, slippageBps: number, sqrtLimit: bigint, gas: GasBudget) => bounded(async rpc => {
      await verify(rpc); const op = await operation(rpc, id)
      if (op.recoveryStarted) return fail('operation_recovery_started')
      // The slippage is the owner's own limit, inside the product's bound (./slippage.ts, pinned to lib/create/slippage.ts): the minimum output below is drawn with it.
      if (op.closed || op.swapped || gross <= 0n || gross > (zeroForOne ? op.balance0 : op.balance1) || !Number.isSafeInteger(slippageBps) || slippageBps < SLIPPAGE_MIN_BPS || slippageBps > SLIPPAGE_MAX_BPS || sqrtLimit <= 0n || sqrtLimit >= 2n ** 160n) return fail('invalid_swap_budget')
      const plan = { operationId: id, zeroForOne, grossInput: gross, minOutput: 1n, sqrtPriceLimitX96: sqrtLimit, deadline: BigInt(Math.floor(now()) + STEP_DEADLINE_S) }
      const data = encodeFunctionData({ abi: setupAbi, functionName: 'swap', args: [plan] })
      const output = decodeFunctionResult({ abi: setupAbi, functionName: 'swap', data: asHex(await rpc('eth_call', [{ from: wallet.owner, to: deployment.setup, data }, 'latest'])) })
      const minimum = output * BigInt(10000 - slippageBps) / 10000n
      if (minimum <= 0n) return fail('swap_output_insufficient')
      const fee = gross * BigInt(deployment.feeBps) / 10000n
      return prepare(rpc, 'swap', id, deployment.setup, encodeFunctionData({ abi: setupAbi, functionName: 'swap', args: [{ ...plan, minOutput: minimum }] }), 0n, gas,
        [`Swap ${gross} smallest units of ${zeroForOne ? op.key.currency0 : op.key.currency1}.`, `Domino fee ${fee} (${deployment.feeBps} bps), net input ${gross - fee}; tariff ${deployment.tariffVersion}; recipient ${deployment.feeRecipient}.`,
          `Simulated output ${output}; minimum ${minimum} of ${zeroForOne ? op.key.currency1 : op.key.currency0}, at your ${slippageWritten(slippageBps)} slippage limit. Pool fees are included in the simulation.`, 'Swap and mint are separate. Cancelling mint refunds remaining balances without another swap or fee.'])
    }),
    mint: (id: Hex, plan: { tickLower: number; tickUpper: number; liquidity: bigint; maxAmount0: bigint; maxAmount1: bigint; minSqrtPriceX96: bigint; maxSqrtPriceX96: bigint; initialSqrtPriceX96: bigint }, gas: GasBudget) => bounded(async rpc => {
      await verify(rpc); const op = await operation(rpc, id)
      if (op.recoveryStarted) return fail('operation_recovery_started')
      if (op.closed || !Number.isSafeInteger(plan.tickLower) || !Number.isSafeInteger(plan.tickUpper) || plan.tickLower < -887272 || plan.tickUpper > 887272 || plan.tickLower >= plan.tickUpper || plan.tickLower % op.key.tickSpacing || plan.tickUpper % op.key.tickSpacing
        || plan.liquidity <= 0n || plan.liquidity >= 2n ** 127n || plan.maxAmount0 < 0n || plan.maxAmount1 < 0n || plan.maxAmount0 > op.balance0 || plan.maxAmount1 > op.balance1
        || plan.minSqrtPriceX96 <= 0n || plan.maxSqrtPriceX96 < plan.minSqrtPriceX96 || plan.maxSqrtPriceX96 >= 2n ** 160n || plan.initialSqrtPriceX96 < 0n || plan.initialSqrtPriceX96 >= 2n ** 160n) return fail('invalid_mint_limits')
      // Mint returns whatever ETH it did not use, and it rarely uses every wei.
      if (op.key.currency0 === zeroAddress && op.balance0 > 0n && !await acceptsNativeEth(rpc, wallet.owner)) return fail('native_eth_refused')
      return prepare(rpc, 'mint', id, deployment.setup, encodeFunctionData({ abi: setupAbi, functionName: 'mint', args: [{ operationId: id, ...plan, deadline: BigInt(Math.floor(now()) + STEP_DEADLINE_S) }] }), 0n, gas,
        [`Mint liquidity ${plan.liquidity} in ticks ${plan.tickLower} to ${plan.tickUpper}; caps ${plan.maxAmount0} / ${plan.maxAmount1} smallest units.`, `Token 0: ${op.key.currency0}; token 1: ${op.key.currency1}.`, `Price limits (sqrtPriceX96): ${plan.minSqrtPriceX96} to ${plan.maxSqrtPriceX96}.`,
          plan.initialSqrtPriceX96 ? `Create the pool at sqrtPriceX96 ${plan.initialSqrtPriceX96} and mint atomically. This sets the pool's initial relative token price.` : 'Mint into the existing pool.', `NFT and unused funds return to ${wallet.owner}. No Domino percentage fee on mint.`])
    }),
    cancel: (id: Hex, gas: GasBudget) => bounded(async rpc => {
      await verify(rpc, true); const op = await operation(rpc, id)
      if (op.closed) return fail('operation_already_closed')
      if (op.key.currency0 === zeroAddress && op.balance0 > 0n && !await acceptsNativeEth(rpc, wallet.owner)) return fail('native_eth_refused')
      return prepare(rpc, 'cancel', id, deployment.setup, encodeFunctionData({ abi: setupAbi, functionName: 'cancel', args: [id] }), 0n, gas,
        [`Refund ${op.balance0} of ${op.key.currency0} and ${op.balance1} of ${op.key.currency1} to ${wallet.owner}.`, 'No exit fee. Any earlier successful swap remains completed.'])
    }),
    recover: (id: Hex, currency: Address, amount: bigint, gas: GasBudget) => bounded(async rpc => {
      await verify(rpc, true); const op = await operation(rpc, id)
      if (op.closed) return fail('operation_already_closed')
      if (amount <= 0n || amount >= 2n ** 128n || ![op.key.currency0.toLowerCase(), op.key.currency1.toLowerCase()].includes(currency)
        || amount > (currency === op.key.currency0.toLowerCase() ? op.balance0 : op.balance1)) return fail('invalid_recovery_amount')
      if (currency === zeroAddress && !await acceptsNativeEth(rpc, wallet.owner)) return fail('native_eth_refused')
      return prepare(rpc, 'recover', id, deployment.setup, encodeFunctionData({ abi: setupAbi, functionName: 'recoverCurrency', args: [id, currency, amount] }), 0n, gas,
        [`Return ${amount} smallest units of ${currency} from this operation to ${wallet.owner}.`,
          'This starts recovery: this operation can no longer swap or mint. Other funds remain available for a later refund.',
          'No Domino exit fee. A token transfer charge may reduce the amount received; the receipt records actual wallet balances.'])
    }),
    send: (prepared: PreparedSetup, acknowledged: boolean) => bounded(async rpc => {
      if (!acknowledged || !issued.has(prepared) || prepared.expiresAt <= now() || prepared.owner !== wallet.owner) return fail('wallet_review_required')
      await verify(rpc, prepared.kind === 'cancel' || prepared.kind === 'recover')
      const latest = quantity(await rpc('eth_getTransactionCount', [wallet.owner, 'latest'])), pending = quantity(await rpc('eth_getTransactionCount', [wallet.owner, 'pending']))
      if (latest !== pending || numberToHex(pending) !== prepared.transaction.nonce || offered.has(String(pending)) || wallet.nonceOffered(pending) || prepared.expiresAt <= now()) return fail('pending_wallet_transaction')
      await rpc('eth_call', [prepared.transaction, 'latest'])
      if (prepared.expiresAt <= now()) return fail('wallet_review_expired')
      const claim = await wallet.claimNonce(pending)
      if (!wallet.current() || prepared.expiresAt <= now()) {
        // The provider has not been invoked, so releasing this claim is certain.
        await wallet.releaseRejectedNonce(pending, claim)
        return fail('wallet_review_expired')
      }
      offered.add(String(pending)); issued.delete(prepared)
      const hash = await rpc('eth_sendTransaction', [prepared.transaction], async () => {
        // This handler belongs to the original provider promise, including a
        // rejection after timeout. Release only this exact claim after4001;
        // a new preparation still requires fresh review and no retry is sent.
        await wallet.releaseRejectedNonce(pending, claim)
        offered.delete(String(pending))
      })
      if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return fail('wallet_result_unknown')
      returned.set(hash.toLowerCase() as Hex, prepared)
      return hash.toLowerCase() as Hex
    }, SIGN_WINDOW_S),
    receipt: (hash: Hex, operationId?: Hex) => bounded(async rpc => {
      await identity(rpc)
      if (!HASH.test(hash)) return fail('invalid_transaction_hash')
      const tx = await rpc('eth_getTransactionByHash', [hash]) as { hash?: string; from?: string; to?: string; input?: string; value?: string; nonce?: string } | null
      if (tx === null) return { state: 'pending' as const }
      if (!tx || tx.hash?.toLowerCase() !== hash || tx.from?.toLowerCase() !== wallet.owner || !tx.to || !tx.input || !tx.value || !tx.nonce) return fail('invalid_transaction')
      const known = returned.get(hash)
      if (known) {
        const sent = known.transaction
        if (tx.to.toLowerCase() !== sent.to.toLowerCase() || tx.input.toLowerCase() !== sent.data.toLowerCase() || quantity(tx.value) !== quantity(sent.value) || quantity(tx.nonce) !== quantity(sent.nonce)
          || (operationId && known.operationId !== null && operationId !== known.operationId)) return fail('transaction_does_not_match_review')
      } else {
        // Reload/lost-response recovery binds the receipt to this owner's exact
        // on-chain operation. An unrelated successful owner tx proves nothing.
        if (!operationId || !HASH.test(operationId) || tx.to.toLowerCase() !== deployment.setup) return fail('operation_receipt_required')
        const decoded = decodeFunctionData({ abi: setupAbi, data: asHex(tx.input) })
        const bound = decoded.functionName === 'open' || decoded.functionName === 'cancel' || decoded.functionName === 'recoverCurrency' ? decoded.args[0]
          : decoded.functionName === 'swap' || decoded.functionName === 'mint' ? decoded.args[0].operationId : null
        if (bound !== operationId) return fail('transaction_operation_mismatch')
        if (decoded.functionName !== 'open' && quantity(tx.value) !== 0n) return fail('invalid_transaction_value')
        await verify(rpc, true); await operation(rpc, operationId)
      }
      const receipt = await rpc('eth_getTransactionReceipt', [hash]) as { transactionHash?: string; from?: string; blockNumber?: string; blockHash?: string; status?: string } | null
      if (receipt === null) return { state: 'pending' as const }
      if (!receipt || receipt.transactionHash?.toLowerCase() !== hash || receipt.from?.toLowerCase() !== wallet.owner || !receipt.blockNumber || !receipt.blockHash || !HASH.test(receipt.blockHash) || !['0x0','0x1'].includes(receipt.status ?? '')) return fail('invalid_receipt')
      const block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]) as { hash?: string } | null
      if (!block || block.hash !== receipt.blockHash) return { state: 'reorged' as const }
      // A failed transaction is said as soon as its block is canonical: on Robinhood Chain finality trails by
      // minutes, and a revert read as "included" would let the next step start on a state that never changed.
      if (receipt.status === '0x0') return { state: 'reverted' as const, blockHash: receipt.blockHash }
      const final = await rpc('eth_getBlockByNumber', ['finalized', false]) as { number?: string } | null
      if (!final?.number || quantity(final.number) < quantity(receipt.blockNumber)) return { state: 'included' as const }
      return { state: receipt.status === '0x1' ? 'finalized' as const : 'reverted' as const, blockHash: receipt.blockHash }
    }),
    /**
     * A batch this page or another tab offered for the operation the setup contract opens next, still latched: its id,
     * '' when the wallet never answered. The operation is the next one, so the batch has opened nothing yet; once its
     * latch is older than BATCH_LATCH_EXPIRY_S it never can, and the latch is freed for a new batch (2026-09-28: a
     * wallet that never answered, or that answered with an error other than a refusal, left a latch that held every
     * later press of a wallet that batches).
     */
    offeredBatch: () => bounded(async (rpc): Promise<{ operationId: Hex; id: string } | null> => {
      await identity(rpc)
      const operationId = await nextOperationId(rpc)
      const id = wallet.batchOffered?.(operationId) ?? null
      if (id === null) return null
      if (await wallet.expireBatch?.(operationId, now(), BATCH_LATCH_EXPIRY_S)) return null
      return { operationId, id }
    }),
    /**
     * The whole deposit as one batch (EIP-5792), prepared against the chain and simulated before the wallet is asked:
     * the exact approvals the allowances need (a short one reset to zero first, as fund does), the funding into the
     * operation id the setup contract opens next, the assisted swap of a one-token deposit with the least it may pay,
     * and the mint sized for that least. The contract opens only that id, so a batch that meets another opening first
     * reverts whole. Fund's, swap's and mint's checks come first, the delegate's confirmation and the native-ETH probe
     * included. The simulation (eth_simulateV1: each call from the owner, as the account's own execution makes it,
     * state carried from one to the next) goes through the wallet, or through `options.simulate` when the wallet does
     * not carry the method; with neither, there is no batch.
     */
    prepareBatch: (plan: BatchPlan, gas: GasBudget) => bounded(async (rpc): Promise<PreparedBatch> => {
      await verify(rpc); const key = poolKey(plan.key)
      const { amount0, amount1, swap, mint } = plan
      if (amount0 < 0n || amount1 < 0n || amount0 >= 2n ** 128n || amount1 >= 2n ** 128n || amount0 + amount1 === 0n) return fail('invalid_funding')
      if (gas.maxGas < 21000n || gas.maxGas > 15_000_000n || gas.maxFeePerGas <= 0n || gas.maxFeePerGas >= 2n ** 128n || gas.maxPriorityFeePerGas < 0n || gas.maxPriorityFeePerGas > gas.maxFeePerGas || gas.reserveWei < 0n) return fail('invalid_gas_budget')
      const account = await readAccountCode(rpc, wallet.owner)
      if (account.kind === 'delegated' && account.known === null && wallet.delegateConfirmed?.(account.delegate) !== true) return fail('delegate_unrecognized')
      // The mint returns unused ETH, and a refund would too: never lock ETH (or approve anything) for an account that refuses it.
      if (key.currency0 === zeroAddress && !await acceptsNativeEth(rpc, wallet.owner)) return fail('native_eth_refused')
      // What the mint may count on: the funding, less the swapped side's gross, plus only the least the swap pays.
      let balance0 = amount0, balance1 = amount1
      if (swap) {
        if (swap.gross <= 0n || swap.gross > (swap.zeroForOne ? amount0 : amount1) || swap.minOutput <= 0n || swap.minOutput >= 2n ** 128n
          || swap.sqrtLimit <= 0n || swap.sqrtLimit >= 2n ** 160n) return fail('invalid_swap_budget')
        balance0 = swap.zeroForOne ? amount0 - swap.gross : amount0 + swap.minOutput
        balance1 = swap.zeroForOne ? amount1 + swap.minOutput : amount1 - swap.gross
      }
      if (!Number.isSafeInteger(mint.tickLower) || !Number.isSafeInteger(mint.tickUpper) || mint.tickLower < -887272 || mint.tickUpper > 887272 || mint.tickLower >= mint.tickUpper
        || mint.tickLower % key.tickSpacing || mint.tickUpper % key.tickSpacing || mint.liquidity <= 0n || mint.liquidity >= 2n ** 127n
        || mint.maxAmount0 < 0n || mint.maxAmount1 < 0n || mint.maxAmount0 > balance0 || mint.maxAmount1 > balance1
        || mint.minSqrtPriceX96 <= 0n || mint.maxSqrtPriceX96 < mint.minSqrtPriceX96 || mint.maxSqrtPriceX96 >= 2n ** 160n
        || mint.initialSqrtPriceX96 < 0n || mint.initialSqrtPriceX96 >= 2n ** 160n) return fail('invalid_mint_limits')
      const latest = quantity(await rpc('eth_getTransactionCount', [wallet.owner, 'latest'])), pending = quantity(await rpc('eth_getTransactionCount', [wallet.owner, 'pending']))
      if (latest !== pending || offered.has(String(pending)) || wallet.nonceOffered(pending)) return fail('pending_wallet_transaction')
      const operationId = await nextOperationId(rpc)
      const latched = wallet.batchOffered?.(operationId)
      if (latched !== undefined && latched !== null) return fail('batch_already_offered')
      const calls: BatchCall[] = [], summary: string[] = []
      for (const [token, amount] of [[key.currency0, amount0], [key.currency1, amount1]] as const) {
        if (token === zeroAddress || amount === 0n) continue
        const data = encodeFunctionData({ abi: tokenAbi, functionName: 'allowance', args: [wallet.owner, deployment.setup] })
        const allowance = decodeFunctionResult({ abi: tokenAbi, functionName: 'allowance', data: asHex(await rpc('eth_call', [{ to: token, data }, 'latest'])) })
        if (allowance >= amount) continue
        if (allowance > 0n) calls.push({ to: token, data: encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [deployment.setup, 0n] }), value: '0x0' })
        calls.push({ to: token, data: encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [deployment.setup, amount] }), value: '0x0' })
        summary.push(`Approve ${amount} smallest units of ${token} to ${deployment.setup}${allowance > 0n ? ', after resetting the existing allowance to zero' : ''}. Exact allowance; no unlimited approval.`)
      }
      const deadline = BigInt(Math.floor(now()) + STEP_DEADLINE_S), value = key.currency0 === zeroAddress ? amount0 : 0n
      calls.push({ to: deployment.setup, data: encodeFunctionData({ abi: setupAbi, functionName: 'open', args: [operationId, key, amount0, amount1] }), value: numberToHex(value) })
      summary.push(`Fund ${amount0} smallest units of ${key.currency0} and ${amount1} of ${key.currency1}.`)
      if (swap) {
        calls.push({ to: deployment.setup, data: encodeFunctionData({ abi: setupAbi, functionName: 'swap', args: [{ operationId, zeroForOne: swap.zeroForOne, grossInput: swap.gross, minOutput: swap.minOutput, sqrtPriceLimitX96: swap.sqrtLimit, deadline }] }), value: '0x0' })
        summary.push(`Swap ${swap.gross} smallest units of ${swap.zeroForOne ? key.currency0 : key.currency1} for at least ${swap.minOutput} of ${swap.zeroForOne ? key.currency1 : key.currency0}. Domino fee ${swap.gross * BigInt(deployment.feeBps) / 10000n} (${deployment.feeBps} bps); recipient ${deployment.feeRecipient}.`)
      }
      calls.push({ to: deployment.setup, data: encodeFunctionData({ abi: setupAbi, functionName: 'mint', args: [{ operationId, ...mint, deadline }] }), value: '0x0' })
      summary.push(`Mint liquidity ${mint.liquidity} in ticks ${mint.tickLower} to ${mint.tickUpper}; caps ${mint.maxAmount0} / ${mint.maxAmount1} smallest units. NFT and unused funds return to ${wallet.owner}.`,
        'One signature for every call: they execute together or not at all.')
      const gasUsed = await simulateBatch(rpc, wallet.owner, calls, options.simulate)
      // The wallet runs the calls in one transaction of its own (its delegate's execute, or a bundler's): room for that frame.
      const limit = ((gasUsed + BATCH_FRAME_GAS) * 120n + 99n) / 100n
      if (limit > gas.maxGas) return fail('gas_budget_exceeded')
      if (quantity(await rpc('eth_getBalance', [wallet.owner, 'latest'])) < value + limit * gas.maxFeePerGas + gas.reserveWei) return fail('native_gas_reserve_insufficient')
      summary.push(`Maximum network cost: about ${limit * gas.maxFeePerGas} wei; your wallet sets the final gas.`, `Contract: ${deployment.setup}`)
      const result: PreparedBatch = Object.freeze({ kind: 'batch' as const, operationId, owner: wallet.owner, expiresAt: now() + 25,
        calls: Object.freeze(calls.map(call => Object.freeze(call))), gasUsed, gasLimit: limit, summary: Object.freeze(summary) })
      issuedBatches.add(result); return result
    }),
    /**
     * Offers a prepared batch to the wallet once (EIP-5792 wallet_sendCalls, version 2.0.0, atomic required), after
     * the latch for its operation id is claimed: another tab, or this one after a lost answer, is refused. A refusal in
     * the wallet, or a wallet that cannot batch, frees it; an answer that never came keeps it, and the operation's own
     * state decides later (batchStatus).
     */
    sendBatch: (prepared: PreparedBatch, acknowledged: boolean) => bounded(async rpc => {
      if (!acknowledged || !issuedBatches.has(prepared) || prepared.expiresAt <= now() || prepared.owner !== wallet.owner) return fail('wallet_review_required')
      await verify(rpc)
      if (await nextOperationId(rpc) !== prepared.operationId) return fail('batch_state_changed')
      const latest = quantity(await rpc('eth_getTransactionCount', [wallet.owner, 'latest'])), pending = quantity(await rpc('eth_getTransactionCount', [wallet.owner, 'pending']))
      if (latest !== pending || offered.has(String(pending)) || wallet.nonceOffered(pending) || prepared.expiresAt <= now()) return fail('pending_wallet_transaction')
      issuedBatches.delete(prepared)
      return offerBatch(rpc, wallet, prepared.operationId, prepared.calls, () => wallet.current() && prepared.expiresAt > now())
    }, SIGN_WINDOW_S),
    /**
     * Where a batch stands: the wallet's status (EIP-5792 wallet_getCallsStatus) for what it knows, then the operation
     * the batch opens for what happened. Read back closed with its NFT is `created`. Its calls cannot leave the
     * operation funded and open, but such a state reads `held`, for the refund. The zero owner after a confirmation
     * is a node behind: `pending`. Not included (400) or reverted (500), nothing of it can execute and the latch is
     * freed; a wallet that no longer knows the batch (5730, or an id it never gave) leaves the operation to decide.
     */
    batchStatus: (id: string, operationId: Hex) => bounded(async (rpc): Promise<BatchState> => {
      await identity(rpc)
      if (!HASH.test(operationId)) return fail('invalid_operation_id')
      const status = await batchCallsStatus(rpc, id)
      if (status !== null && status >= 100 && status < 200) return { state: 'pending' }
      const op = await stored(rpc, operationId)
      if (op.owner === zeroAddress) {
        // Not included, reverted, or no longer known to the wallet: nothing of it runs through this wallet now, and a
        // later batch for the same id would revert whole at the contract anyway.
        if (id !== '' && (status === 400 || status === 500 || status === null)) await wallet.releaseBatch?.(operationId, id)
        return { state: status === 400 ? 'dropped' : status === 500 ? 'reverted' : status === 200 ? 'pending' : 'unknown' }
      }
      if (op.owner.toLowerCase() !== wallet.owner) return fail('operation_not_owned')
      if (op.closed && op.tokenId > 0n) {
        if (id !== '') await wallet.releaseBatch?.(operationId, id)
        return { state: 'created', tokenId: op.tokenId }
      }
      return op.closed ? { state: 'unknown' } : { state: 'held' }
    }),
  }
}
