import { decodeFunctionData, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, numberToHex, zeroAddress, type Address, type Hex } from 'viem'

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
 *   function open(bytes32 id, PoolKey key, uint128 amount0, uint128 amount1) payable
 *   function swap(SwapPlan) returns (uint128 output)
 *   function mint(MintPlan)
 *   function cancel(bytes32)
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
  { name: 'open', type: 'function', stateMutability: 'payable', inputs: [{ name: 'id', type: 'bytes32' }, { name: 'key', type: 'tuple', components: poolKeyComponents }, { name: 'amount0', type: 'uint128' }, { name: 'amount1', type: 'uint128' }], outputs: [] },
  { name: 'swap', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'tuple', components: swapPlanComponents }], outputs: [{ name: 'output', type: 'uint128' }] },
  { name: 'mint', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'tuple', components: mintPlanComponents }], outputs: [] },
  { name: 'cancel', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'bytes32' }], outputs: [] },
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
/** operationIdParameters signature: uint256,address,address,uint64 */
export const operationIdParameters = [{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint64' }] as const
export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }
export type SetupOperation = { owner: Address; key: PoolKey; balance0: bigint; balance1: bigint; swapped: boolean; closed: boolean; tokenId: bigint }
export interface SetupDeployment {
  setup: Address; setupCodeHash: Hex; poolManager: Address; positionManager: Address; stateView: Address
  poolManagerCodeHash: Hex; positionManagerCodeHash: Hex; stateViewCodeHash: Hex
  feeRecipient: Address; feeBps: number; tariffVersion: string; expiresAt: number
}
export interface WalletRpc {
  owner: Address; current(): boolean; request(method: string, params: unknown[]): Promise<unknown>
  nonceOffered(nonce: bigint): boolean; claimNonce(nonce: bigint): Promise<string>; releaseRejectedNonce(nonce: bigint, token: string): Promise<void>
}
export interface GasBudget { maxGas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; reserveWei: bigint }
export interface PreparedSetup {
  kind: 'approve' | 'fund' | 'swap' | 'mint' | 'cancel'; operationId: Hex | null; owner: Address; expiresAt: number
  transaction: { from: Address; to: Address; data: Hex; value: Hex; nonce: Hex; gas: Hex; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex; chainId: '0x1237'; type: '0x2' }
  summary: readonly string[]
}
const ADDRESS = /^0x[0-9a-f]{40}$/, HASH = /^0x[0-9a-f]{64}$/
const fail = (code: string): never => { throw new Error(code) }
const asHex = (value: unknown): Hex => typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value) ? value as Hex : fail('invalid_wallet_reply')
const quantity = (value: unknown): bigint => typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) ? BigInt(value) : fail('invalid_wallet_quantity')
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
export function createSetupClient(wallet: WalletRpc, supplied: SetupDeployment, now = () => Date.now() / 1000,
  currentAdmission?: () => Promise<SetupDeployment | null>) {
  const deployment = Object.freeze({ ...supplied })
  const issued = new WeakSet<PreparedSetup>(), offered = new Set<string>()
  const returned = new Map<Hex, PreparedSetup>()
  let busy = false
  async function bounded<T>(work: (rpc: (method: string, params: unknown[], onUserRejection?: () => Promise<void>) => Promise<unknown>) => Promise<T>): Promise<T> {
    if (busy) return fail('wallet_action_busy')
    busy = true
    const end = now() + 25
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
    for (const [address, hash] of [[deployment.setup, deployment.setupCodeHash], [deployment.poolManager, deployment.poolManagerCodeHash], [deployment.positionManager, deployment.positionManagerCodeHash], [deployment.stateView, deployment.stateViewCodeHash]] as const) {
      if (keccak256(asHex(await rpc('eth_getCode', [address, 'latest']))) !== hash) return fail('deployment_code_changed')
    }
    for (const [name, expected] of [['manager', deployment.poolManager], ['positions', deployment.positionManager], ['stateView', deployment.stateView], ['feeRecipient', deployment.feeRecipient], ['assistedFeeBps', deployment.feeBps], ['tariffVersion', deployment.tariffVersion]] as const) {
      if (String(await call(rpc, name)).toLowerCase() !== String(expected)) return fail('deployment_identity_changed')
    }
  }
  async function operation(rpc: Rpc, id: Hex) {
    if (!HASH.test(id)) return fail('invalid_operation_id')
    const data = encodeFunctionData({ abi: setupAbi, functionName: 'operation', args: [id] })
    const op = decodeFunctionResult({ abi: setupAbi, functionName: 'operation', data: asHex(await rpc('eth_call', [{ to: deployment.setup, data }, 'latest'])) })
    if (op.owner.toLowerCase() !== wallet.owner) return fail('operation_not_owned')
    return op
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
    fund: (key: PoolKey, amount0: bigint, amount1: bigint, gas: GasBudget) => bounded(async rpc => {
      await verify(rpc); poolKey(key)
      if (amount0 < 0n || amount1 < 0n || amount0 >= 2n ** 128n || amount1 >= 2n ** 128n || amount0 + amount1 === 0n) return fail('invalid_funding')
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
      if (op.closed || op.swapped || gross <= 0n || gross > (zeroForOne ? op.balance0 : op.balance1) || !Number.isSafeInteger(slippageBps) || slippageBps < 0 || slippageBps > 1000 || sqrtLimit <= 0n || sqrtLimit >= 2n ** 160n) return fail('invalid_swap_budget')
      const plan = { operationId: id, zeroForOne, grossInput: gross, minOutput: 1n, sqrtPriceLimitX96: sqrtLimit, deadline: BigInt(Math.floor(now()) + 90) }
      const data = encodeFunctionData({ abi: setupAbi, functionName: 'swap', args: [plan] })
      const output = decodeFunctionResult({ abi: setupAbi, functionName: 'swap', data: asHex(await rpc('eth_call', [{ from: wallet.owner, to: deployment.setup, data }, 'latest'])) })
      const minimum = output * BigInt(10000 - slippageBps) / 10000n
      if (minimum <= 0n) return fail('swap_output_insufficient')
      const fee = gross * BigInt(deployment.feeBps) / 10000n
      return prepare(rpc, 'swap', id, deployment.setup, encodeFunctionData({ abi: setupAbi, functionName: 'swap', args: [{ ...plan, minOutput: minimum }] }), 0n, gas,
        [`Swap ${gross} smallest units of ${zeroForOne ? op.key.currency0 : op.key.currency1}.`, `Domino fee ${fee} (${deployment.feeBps} bps), net input ${gross - fee}; tariff ${deployment.tariffVersion}; recipient ${deployment.feeRecipient}.`,
          `Simulated output ${output}; minimum ${minimum} of ${zeroForOne ? op.key.currency1 : op.key.currency0}. Pool fees are included in the simulation.`, 'Swap and mint are separate. Cancelling mint refunds remaining balances without another swap or fee.'])
    }),
    mint: (id: Hex, plan: { tickLower: number; tickUpper: number; liquidity: bigint; maxAmount0: bigint; maxAmount1: bigint; minSqrtPriceX96: bigint; maxSqrtPriceX96: bigint; initialSqrtPriceX96: bigint }, gas: GasBudget) => bounded(async rpc => {
      await verify(rpc); const op = await operation(rpc, id)
      if (op.closed || !Number.isSafeInteger(plan.tickLower) || !Number.isSafeInteger(plan.tickUpper) || plan.tickLower < -887272 || plan.tickUpper > 887272 || plan.tickLower >= plan.tickUpper || plan.tickLower % op.key.tickSpacing || plan.tickUpper % op.key.tickSpacing
        || plan.liquidity <= 0n || plan.liquidity >= 2n ** 127n || plan.maxAmount0 < 0n || plan.maxAmount1 < 0n || plan.maxAmount0 > op.balance0 || plan.maxAmount1 > op.balance1
        || plan.minSqrtPriceX96 <= 0n || plan.maxSqrtPriceX96 < plan.minSqrtPriceX96 || plan.maxSqrtPriceX96 >= 2n ** 160n || plan.initialSqrtPriceX96 < 0n || plan.initialSqrtPriceX96 >= 2n ** 160n) return fail('invalid_mint_limits')
      return prepare(rpc, 'mint', id, deployment.setup, encodeFunctionData({ abi: setupAbi, functionName: 'mint', args: [{ operationId: id, ...plan, deadline: BigInt(Math.floor(now()) + 90) }] }), 0n, gas,
        [`Mint liquidity ${plan.liquidity} in ticks ${plan.tickLower} to ${plan.tickUpper}; caps ${plan.maxAmount0} / ${plan.maxAmount1} smallest units.`, `Token 0: ${op.key.currency0}; token 1: ${op.key.currency1}.`, `Price limits (sqrtPriceX96): ${plan.minSqrtPriceX96} to ${plan.maxSqrtPriceX96}.`,
          plan.initialSqrtPriceX96 ? `Create the pool at sqrtPriceX96 ${plan.initialSqrtPriceX96} and mint atomically. This sets the pool's initial relative token price.` : 'Mint into the existing pool.', `NFT and unused funds return to ${wallet.owner}. No Domino percentage fee on mint.`])
    }),
    cancel: (id: Hex, gas: GasBudget) => bounded(async rpc => {
      await verify(rpc, true); const op = await operation(rpc, id)
      if (op.closed) return fail('operation_already_closed')
      return prepare(rpc, 'cancel', id, deployment.setup, encodeFunctionData({ abi: setupAbi, functionName: 'cancel', args: [id] }), 0n, gas,
        [`Refund ${op.balance0} of ${op.key.currency0} and ${op.balance1} of ${op.key.currency1} to ${wallet.owner}.`, 'No exit fee. Any earlier successful swap remains completed.'])
    }),
    send: (prepared: PreparedSetup, acknowledged: boolean) => bounded(async rpc => {
      if (!acknowledged || !issued.has(prepared) || prepared.expiresAt <= now() || prepared.owner !== wallet.owner) return fail('wallet_review_required')
      await verify(rpc, prepared.kind === 'cancel')
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
    }),
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
        const bound = decoded.functionName === 'open' || decoded.functionName === 'cancel' ? decoded.args[0]
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
      const final = await rpc('eth_getBlockByNumber', ['finalized', false]) as { number?: string } | null
      if (!final?.number || quantity(final.number) < quantity(receipt.blockNumber)) return { state: 'included' as const }
      return { state: receipt.status === '0x1' ? 'finalized' as const : 'reverted' as const, blockHash: receipt.blockHash }
    }),
  }
}
