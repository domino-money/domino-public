import { concatHex, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, numberToHex, parseAbi, parseAbiParameters, stringToHex, zeroAddress, type Abi, type Address, type ContractFunctionName, type ContractFunctionReturnType, type Hex } from 'viem'
import type { GasBudget, WalletRpc } from './setup'

export const sequenceAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct Policy { uint16 serviceFeeBps; uint16 triggerDistanceBps; uint16 maxOverlapBps; uint32 minimumIntervalSeconds; uint8 maxPositions; uint64 version; bool paused; }',
  'struct Limits { uint64 version; uint32 upsideBps; uint16 maxSlippageBps; uint16 maxPriceImpactBps; uint128 maxGasCostWei; uint32 maxObservationAgeSeconds; uint32 forecastHorizonSeconds; }',
  'struct InitParams { uint256 rootTokenId; bytes32 expectedPoolId; address baseCurrency; address quoteCurrency; address operator; bool consentToUncollectedFees; Policy policy; Limits limits; }',
  'struct Position { bool known; bool active; bool isRoot; uint256 parentTokenId; uint64 generation; int24 tickLower; int24 tickUpper; bytes32 registrationBaselineId; bytes32 identity; bytes32 source0; bytes32 source1; }',
  'struct Source { bool known; uint256 tokenId; address originalCurrency; bytes32 positionIdentity; }',
  'struct Balance { uint128 original; uint128 charged; }',
  'function factory() view returns(address)', 'function implementation() view returns(address)', 'function implementationVersion() view returns(uint64)',
  'function poolManager() view returns(address)', 'function positionManager() view returns(address)', 'function stateView() view returns(address)',
  'function readHelper() view returns(address)', 'function executionEngine() view returns(address)', 'function serviceFeeRecipient() view returns(address)',
  'function routingHelper() view returns(address)', 'function priceGuard() view returns(address)', 'function publisher() view returns(address)',
  'function implementationCodeHash() view returns(bytes32)', 'function readHelperCodeHash() view returns(bytes32)', 'function executionEngineCodeHash() view returns(bytes32)',
  'function poolManagerCodeHash() view returns(bytes32)', 'function positionManagerCodeHash() view returns(bytes32)', 'function stateViewCodeHash() view returns(bytes32)',
  'function readHelperHash() view returns(bytes32)', 'function routingHelperHash() view returns(bytes32)', 'function priceGuardHash() view returns(bytes32)',
  'function nextOwnerNonce(address) view returns(uint256)', 'function predictVault(address,uint256) view returns(address)',
  'function isVault(address) view returns(bool)', 'function vaultForSequence(bytes32) view returns(address)',
  'function createVault(InitParams,uint256) returns(address)',
  'function owner() view returns(address)', 'function operator() view returns(address)', 'function sequenceId() view returns(bytes32)',
  'function rootTokenId() view returns(uint256)', 'function poolId() view returns(bytes32)', 'function poolKey() view returns(PoolKey)',
  'function baseCurrency() view returns(address)', 'function quoteCurrency() view returns(address)',
  'function policy() view returns(Policy)', 'function executionLimits() view returns(Limits)', 'function stateNonce() view returns(uint64)',
  'function rootPermissionValid() view returns(bool)', 'function successorOf(uint256) view returns(uint256)',
  'function position(uint256) view returns(Position)', 'function source(bytes32) view returns(Source)', 'function feeBalance(bytes32,address) view returns(Balance)',
  'function pause()', 'function resume()', 'function revokeOperator()', 'function withdrawChildPosition(uint256)', 'function withdrawFeeReserves(bytes32,address,uint128,uint128)',
  'function ownerOf(uint256) view returns(address)', 'function getApproved(uint256) view returns(address)', 'function approve(address,uint256)',
  'function getPoolAndPositionInfo(uint256) view returns(PoolKey,uint256)',
])
type Component = 'factory' | 'implementation' | 'poolManager' | 'positionManager' | 'stateView' | 'readHelper' | 'engine' | 'routing' | 'priceGuard'
export interface SequenceDeployment extends Record<Component, Address> {
  serviceFeeRecipient: Address; operator: Address; pricePublisher: Address; serviceFeeBps: 200; expiresAt: number
  codeHashes: Record<Component | 'vault', Hex>
}
export interface SequenceOptions {
  rootTokenId: bigint; baseIsCurrency0: boolean; consentToUncollectedFees: boolean
  triggerDistanceBps: number; maxOverlapBps: number; minimumIntervalSeconds: number; maxPositions: number
  upsideBps: number; maxSlippageBps: number; maxPriceImpactBps: number; maxGasCostWei: bigint
  maxObservationAgeSeconds: number; forecastHorizonSeconds: number
}
export interface SequenceState {
  vault: Address; sequenceId: Hex; rootTokenId: bigint; operator: Address; paused: boolean; rootPermissionValid: boolean
  baseCurrency: Address; quoteCurrency: Address; stateNonce: bigint
}
export interface PreparedSequence {
  kind: 'approve-root' | 'create' | 'resume' | 'pause' | 'revoke-operator' | 'revoke-root' | 'withdraw-child' | 'withdraw-fees'
  owner: Address; vault: Address; expiresAt: number; summary: readonly string[]
  transaction: Readonly<{ from: Address; to: Address; data: Hex; value: '0x0'; nonce: Hex; gas: Hex; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex; chainId: '0x1237'; type: '0x2' }>
}
const components: Component[] = ['factory','implementation','poolManager','positionManager','stateView','readHelper','engine','routing','priceGuard']
const addressPattern = /^0x[0-9a-f]{40}$/, hashPattern = /^0x[0-9a-f]{64}$/
const fail = (code: string): never => { throw new Error(code) }
const record = (x: unknown): Record<string, unknown> => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : fail('invalid_sequence_reply')
const hex = (x: unknown): Hex => typeof x === 'string' && x.length <= 200_002 && /^0x(?:[0-9a-fA-F]{2})*$/.test(x) ? x.toLowerCase() as Hex : fail('invalid_wallet_reply')
const quantity = (x: unknown): bigint => typeof x === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(x) ? BigInt(x) : fail('invalid_wallet_quantity')
const address = (x: string): Address => addressPattern.test(x) ? x as Address : fail('invalid_address')
const uint = (x: bigint, bits = 128) => { if (typeof x !== 'bigint' || x < 0n || x >= 2n ** BigInt(bits)) fail('invalid_amount'); return x }
const integer = (x: number, min: number, max: number) => { if (!Number.isSafeInteger(x) || x < min || x > max) fail('invalid_sequence_policy'); return x }
export function sequenceRaw(x: string, bits = 128): bigint {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(x)) return fail('invalid_amount')
  return uint(BigInt(x), bits)
}
export function cloneRuntime(implementation: Address): Hex {
  return concatHex(['0x363d3d373d3d3d363d73', implementation, '0x5af43d82803e903d91602b57fd5bf3'])
}
export function sequenceIdentity(d: SequenceDeployment, owner: Address, nonce: bigint) {
  const id = keccak256(encodeAbiParameters(parseAbiParameters('bytes32,uint256,address,address,uint256'),
    [keccak256(stringToHex('DominoSequence(uint256 chainId,address factory,address owner,uint256 nonce)')),4663n,d.factory,owner,uint(nonce,256)]))
  const initHash = keccak256(concatHex(['0x3d602d80600a3d3981f3', cloneRuntime(d.implementation)]))
  const vault = `0x${keccak256(concatHex(['0xff', d.factory, id, initHash])).slice(-40)}` as Address
  return { id, vault }
}
/** Public deployment identities are checked again on chain. Expired profiles
 * may be parsed for recovery, but can never prepare an approval or creation. */
export function sequenceDeploymentFrom(value: unknown, now = Date.now() / 1000): SequenceDeployment | null {
  const r = record(value)
  if (Object.keys(r).sort().join() !== 'available,chainId,contractVersion,deployment' || r.contractVersion !== '1.0.0-rc.1' || r.chainId !== 4663) return fail('invalid_sequence_release')
  if (r.available === false && r.deployment === null) return null
  if (r.available !== true) return fail('invalid_sequence_release')
  const d = record(r.deployment), hashes = record(d.codeHashes), names = [...components,'serviceFeeRecipient','operator','pricePublisher']
  if (Object.keys(d).sort().join() !== [...names,'serviceFeeBps','expiresAt','codeHashes'].sort().join()
    || !names.every(k => typeof d[k] === 'string' && addressPattern.test(d[k]) && d[k] !== zeroAddress)
    || Object.keys(hashes).sort().join() !== [...components,'vault'].sort().join()
    || !Object.values(hashes).every(h => typeof h === 'string' && hashPattern.test(h) && !/^0x0+$/.test(h))
    || new Set(components.map(k => d[k])).size !== components.length || d.operator === d.pricePublisher
    || [...components,'serviceFeeRecipient'].some(k => d[k] === d.operator || d[k] === d.pricePublisher)
    || d.serviceFeeBps !== 200 || !Number.isSafeInteger(d.expiresAt) || Number(d.expiresAt) <= now) return fail('invalid_sequence_release')
  const out = d as unknown as SequenceDeployment
  if (keccak256(cloneRuntime(out.implementation)) !== hashes.vault) return fail('invalid_clone_template')
  return Object.freeze({ ...out, codeHashes: Object.freeze({ ...out.codeHashes }) })
}

/** Closed owner-only calls: no backend calldata, signer, router or nonce is
 * accepted. Every logical action has one deadline and a fixed read ceiling. */
export function createSequenceClient(wallet: WalletRpc, deployment: SequenceDeployment, now = () => Date.now() / 1000) {
  const d = Object.freeze({ ...deployment, codeHashes: Object.freeze({ ...deployment.codeHashes }) })
  type Rpc = (method: string, params: unknown[], rejected?: (error: unknown) => Promise<void>) => Promise<unknown>
  type Context = { rpc: Rpc; block: Hex; hash: Hex }
  const issued = new WeakMap<PreparedSequence, (c: Context) => Promise<void>>()
  const sent = new Map<Hex, PreparedSequence>()
  let busy = false
  async function bounded<T>(work: (c: Context) => Promise<T>): Promise<T> {
    if (busy) return fail('wallet_action_busy')
    busy = true; const end = now() + 30; let calls = 0
    const rpc: Rpc = async (method, params, rejected) => {
      if (!wallet.current() || now() >= end || ++calls > 100) return fail('wallet_action_expired')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // Observe the original wallet promise even after our deadline. A late
        // explicit 4001 may release only this claim; silence/timeout never does.
        const original = wallet.request(method, params).catch(async error => {
          if (rejected) { try { await rejected(error) } catch { /* A failed release keeps the nonce protected. */ } }
          throw error
        })
        const value = await Promise.race([original, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('wallet_timeout')), Math.max(1, (end - now()) * 1000)) })])
        if (!wallet.current() || now() >= end) return fail('wallet_identity_changed')
        return value
      } finally { clearTimeout(timer) }
    }
    try {
      const accounts = await rpc('eth_accounts', [])
      if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== wallet.owner || quantity(await rpc('eth_chainId', [])) !== 4663n) return fail('wallet_identity_changed')
      const block = record(await rpc('eth_getBlockByNumber', ['latest', false]))
      if (!hashPattern.test(String(block.hash))) return fail('invalid_block')
      const c = { rpc, block: numberToHex(quantity(block.number)), hash: block.hash as Hex }
      return await work(c)
    } finally { busy = false }
  }
  // Call signatures are selected from the local closed ABI, never public JSON.
  type ViewName = ContractFunctionName<typeof sequenceAbi, 'view'>
  async function call<Name extends ViewName>(c: Context, to: Address, name: Name, args: readonly unknown[] = []): Promise<ContractFunctionReturnType<typeof sequenceAbi, 'view', Name>> {
    const abi: Abi = sequenceAbi, functionName: string = name
    return decodeFunctionResult({ abi, functionName, data: hex(await c.rpc('eth_call', [{ to, data: encodeFunctionData({ abi, functionName, args }) }, c.block])) }) as ContractFunctionReturnType<typeof sequenceAbi, 'view', Name>
  }
  const encode = (name: ContractFunctionName<typeof sequenceAbi>, args: readonly unknown[] = []) => encodeFunctionData({ abi: sequenceAbi as Abi, functionName: name, args })
  const equal = (actual: unknown, expected: unknown) => { if (String(actual).toLowerCase() !== String(expected).toLowerCase()) fail('deployment_identity_changed') }
  async function code(c: Context, component: Component) {
    if (keccak256(hex(await c.rpc('eth_getCode', [d[component], c.block]))) !== d.codeHashes[component]) fail('deployment_code_changed')
  }
  async function links(c: Context, to: Address, values: Partial<Record<ViewName, unknown>>) {
    for (const [name, expected] of Object.entries(values) as [ViewName,unknown][]) equal(await call(c, to, name), expected)
  }
  async function verify(c: Context, recovery = false) {
    if (!recovery && now() >= d.expiresAt) fail('sequence_release_expired')
    if (keccak256(cloneRuntime(d.implementation)) !== d.codeHashes.vault) fail('invalid_clone_template')
    // Recovery does not require the engine, publisher, read service or session.
    for (const k of recovery ? ['factory','implementation'] as Component[] : components) await code(c, k)
    await links(c, d.factory, { implementation: d.implementation, implementationCodeHash: d.codeHashes.implementation,
      poolManager: d.poolManager, positionManager: d.positionManager, stateView: d.stateView, serviceFeeRecipient: d.serviceFeeRecipient })
    await links(c, d.implementation, { factory: d.factory, implementation: d.implementation, implementationVersion: 4,
      poolManager: d.poolManager, positionManager: d.positionManager, stateView: d.stateView, serviceFeeRecipient: d.serviceFeeRecipient,
      readHelper: d.readHelper, executionEngine: d.engine })
    if (recovery) return
    if (d.operator === wallet.owner || d.pricePublisher === wallet.owner) fail('invalid_execution_roles')
    for (const eoa of [d.operator,d.pricePublisher]) if (hex(await c.rpc('eth_getCode', [eoa, c.block])) !== '0x') fail('invalid_execution_roles')
    await links(c, d.implementation, { readHelperCodeHash: d.codeHashes.readHelper, executionEngineCodeHash: d.codeHashes.engine,
      poolManagerCodeHash: d.codeHashes.poolManager, positionManagerCodeHash: d.codeHashes.positionManager, stateViewCodeHash: d.codeHashes.stateView })
    await links(c, d.positionManager, { poolManager: d.poolManager }); await links(c, d.stateView, { poolManager: d.poolManager })
    await links(c, d.readHelper, { positionManager: d.positionManager, stateView: d.stateView })
    await links(c, d.engine, { factory: d.factory, readHelper: d.readHelper, routingHelper: d.routing, priceGuard: d.priceGuard,
      readHelperHash: d.codeHashes.readHelper, routingHelperHash: d.codeHashes.routing, priceGuardHash: d.codeHashes.priceGuard })
    await links(c, d.priceGuard, { publisher: d.pricePublisher })
  }
  async function canonical(c: Context) {
    const block = record(await c.rpc('eth_getBlockByNumber', [c.block, false]))
    if (block.hash !== c.hash) fail('chain_changed')
  }
  async function owned(c: Context, vault: Address): Promise<SequenceState> {
    address(vault)
    if (hex(await c.rpc('eth_getCode', [vault, c.block])) !== cloneRuntime(d.implementation) || !await call(c, d.factory, 'isVault', [vault])) fail('unqualified_sequence')
    equal(await call(c, vault, 'owner'), wallet.owner)
    const id = await call(c, vault, 'sequenceId') as Hex
    equal(await call(c, d.factory, 'vaultForSequence', [id]), vault)
    const p = await call(c, vault, 'policy')
    return { vault, sequenceId: id, rootTokenId: await call(c, vault, 'rootTokenId'), operator: String(await call(c, vault, 'operator')).toLowerCase() as Address,
      paused: p.paused, rootPermissionValid: await call(c, vault, 'rootPermissionValid'), baseCurrency: String(await call(c, vault, 'baseCurrency')).toLowerCase() as Address,
      quoteCurrency: String(await call(c, vault, 'quoteCurrency')).toLowerCase() as Address, stateNonce: await call(c, vault, 'stateNonce') }
  }
  async function root(c: Context, tokenId: bigint) {
    if (uint(tokenId,256) === 0n) fail('invalid_root_nft')
    equal(await call(c, d.positionManager, 'ownerOf', [tokenId]), wallet.owner)
    const [rawKey, packed] = await call(c, d.positionManager, 'getPoolAndPositionInfo', [tokenId])
    const key = { ...rawKey, currency0: address(rawKey.currency0.toLowerCase()), currency1: address(rawKey.currency1.toLowerCase()), hooks: address(rawKey.hooks.toLowerCase()) }
    if (key.currency0 >= key.currency1 || key.hooks !== zeroAddress || key.fee > 1_000_000 || key.tickSpacing <= 0 || key.tickSpacing > 32767) fail('unsupported_pool')
    const poolId = keccak256(encodeAbiParameters(parseAbiParameters('(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'), [key]))
    const lower = Number(BigInt.asIntN(24, packed >> 8n)), upper = Number(BigInt.asIntN(24, packed >> 32n))
    if (packed >> 56n !== BigInt(poolId) >> 56n || lower < -887272 || upper > 887272 || lower >= upper || lower % key.tickSpacing || upper % key.tickSpacing) fail('invalid_position_identity')
    for (const currency of [key.currency0,key.currency1]) if (currency !== zeroAddress && hex(await c.rpc('eth_getCode', [currency,c.block])) === '0x') fail('invalid_currency')
    const ownerNonce = await call(c,d.factory,'nextOwnerNonce',[wallet.owner]) as bigint, predicted = sequenceIdentity(d,wallet.owner,ownerNonce)
    equal(await call(c,d.factory,'predictVault',[wallet.owner,ownerNonce]),predicted.vault)
    if (hex(await c.rpc('eth_getCode',[predicted.vault,c.block])) !== '0x') fail('sequence_already_exists')
    return { tokenId, key, poolId, lower, upper, ownerNonce, ...predicted, approved: String(await call(c,d.positionManager,'getApproved',[tokenId])).toLowerCase() as Address }
  }
  function options(o: SequenceOptions) {
    if (!o.consentToUncollectedFees || typeof o.baseIsCurrency0 !== 'boolean') fail('sequence_consent_required')
    integer(o.triggerDistanceBps,0,2000); integer(o.maxOverlapBps,0,2000); integer(o.minimumIntervalSeconds,1,2**32-1); integer(o.maxPositions,1,255)
    integer(o.upsideBps,1,1_000_000); integer(o.maxSlippageBps,0,9999); integer(o.maxPriceImpactBps,0,9999)
    if (uint(o.maxGasCostWei) === 0n) fail('invalid_sequence_policy')
    integer(o.maxObservationAgeSeconds,1,2**32-1); integer(o.forecastHorizonSeconds,1,2**32-1)
  }
  async function prepare(c: Context, kind: PreparedSequence['kind'], vault: Address, to: Address, data: Hex, gas: GasBudget, summary: string[], guard: (c: Context) => Promise<void>) {
    if (gas.maxGas < 21000n || gas.maxGas > 15_000_000n || uint(gas.maxFeePerGas) === 0n || uint(gas.maxPriorityFeePerGas) > gas.maxFeePerGas || uint(gas.reserveWei,256) < 0n) fail('invalid_gas_budget')
    const latest = quantity(await c.rpc('eth_getTransactionCount',[wallet.owner,'latest'])), pending = quantity(await c.rpc('eth_getTransactionCount',[wallet.owner,'pending']))
    if (latest !== pending || wallet.nonceOffered(pending)) fail('pending_wallet_transaction')
    const tx = { from: wallet.owner, to, data, value: '0x0' as const }
    await c.rpc('eth_call',[tx,'latest'])
    const estimate = quantity(await c.rpc('eth_estimateGas',[tx])), limit = (estimate * 120n + 99n) / 100n
    if (limit < 21000n || limit > gas.maxGas) fail('gas_budget_exceeded')
    if (quantity(await c.rpc('eth_getBalance',[wallet.owner,'latest'])) < limit * gas.maxFeePerGas + gas.reserveWei) fail('native_gas_reserve_insufficient')
    await canonical(c)
    const out: PreparedSequence = Object.freeze({ kind, owner: wallet.owner, vault, expiresAt: now() + 120,
      transaction: Object.freeze({ ...tx, nonce:numberToHex(pending),gas:numberToHex(limit),maxFeePerGas:numberToHex(gas.maxFeePerGas),maxPriorityFeePerGas:numberToHex(gas.maxPriorityFeePerGas),chainId:'0x1237',type:'0x2' }),
      summary:Object.freeze([...summary,`Owner: ${wallet.owner}`,`Sequence: ${vault}`,`Maximum network cost: ${limit * gas.maxFeePerGas} wei. Native reserve: ${gas.reserveWei} wei.`]) })
    issued.set(out,guard); return out
  }
  return {
    deployment:d,
    verify: () => bounded(async c => { await verify(c,now() >= d.expiresAt); await canonical(c) }),
    inspectRoot: (id: bigint) => bounded(async c => { await verify(c); const result = await root(c,id); await canonical(c); return result }),
    inspect: (vault: Address) => bounded(async c => { await verify(c,true); const result = await owned(c,vault); await canonical(c); return result }),
    recent: () => bounded(async c => {
      await verify(c,now() >= d.expiresAt); const nonce = await call(c,d.factory,'nextOwnerNonce',[wallet.owner]) as bigint
      const rows: { vault: Address; sequenceId: Hex; ownerNonce: bigint }[] = []
      for (let n = nonce; n > 0n && n > nonce - 8n; n--) { const found = sequenceIdentity(d,wallet.owner,n-1n); equal(await call(c,d.factory,'vaultForSequence',[found.id]),found.vault); rows.push({vault:found.vault,sequenceId:found.id,ownerNonce:n-1n}) }
      await canonical(c); return rows
    }),
    create: (supplied: SequenceOptions, gas: GasBudget) => bounded(async c => {
      const o = Object.freeze({...supplied}); options(o); await verify(c); const r = await root(c,o.rootTokenId)
      const policy = {serviceFeeBps:200,triggerDistanceBps:o.triggerDistanceBps,maxOverlapBps:o.maxOverlapBps,minimumIntervalSeconds:o.minimumIntervalSeconds,maxPositions:o.maxPositions,version:1n,paused:true}
      const limits = {version:1n,upsideBps:o.upsideBps,maxSlippageBps:o.maxSlippageBps,maxPriceImpactBps:o.maxPriceImpactBps,maxGasCostWei:o.maxGasCostWei,maxObservationAgeSeconds:o.maxObservationAgeSeconds,forecastHorizonSeconds:o.forecastHorizonSeconds}
      const params = {rootTokenId:o.rootTokenId,expectedPoolId:r.poolId,baseCurrency:o.baseIsCurrency0?r.key.currency0:r.key.currency1,quoteCurrency:o.baseIsCurrency0?r.key.currency1:r.key.currency0,operator:d.operator,consentToUncollectedFees:true,policy,limits}
      const approval = r.approved !== r.vault
      const guard = async (next: Context) => { await verify(next); const current = await root(next,o.rootTokenId); if (current.ownerNonce !== r.ownerNonce || current.poolId !== r.poolId || current.lower !== r.lower || current.upper !== r.upper) fail('sequence_preparation_changed'); if (!approval && current.approved !== r.vault) fail('root_approval_changed') }
      return prepare(c,approval?'approve-root':'create',r.vault,approval?d.positionManager:d.factory,approval?encode('approve',[r.vault,o.rootTokenId]):encode('createVault',[params,r.ownerNonce]),gas,
        [approval?`Approve only NFT #${o.rootTokenId} to the predicted sequence. No approval for all NFTs.`:`Create a paused sequence from NFT #${o.rootTokenId}.`,
          'Your root NFT stays in your wallet. This does not start automation.',`Pool: ${r.poolId}. Range: ${r.lower} to ${r.upper}.`,
          `Base: ${params.baseCurrency}. Quote: ${params.quoteCurrency}.`,`Operator: ${d.operator}. Fee recipient: ${d.serviceFeeRecipient}.`,
          '2% service fee on earned fees consumed for reinvestment, once; never on principal. Includes already uncollected fees with your consent.',
          `Trigger distance: ${o.triggerDistanceBps} bps; maximum overlap: ${o.maxOverlapBps} bps; minimum interval: ${o.minimumIntervalSeconds}s; maximum positions: ${o.maxPositions}.`,
          `Successor upside: ${o.upsideBps} bps; maximum slippage: ${o.maxSlippageBps} bps; maximum price impact: ${o.maxPriceImpactBps} bps.`,
          `Execution gas cost cap: ${o.maxGasCostWei} wei; observation age: ${o.maxObservationAgeSeconds}s; forecast horizon: ${o.forecastHorizonSeconds}s.`],guard)
    }),
    resume: (vault: Address, gas: GasBudget) => bounded(async c => {
      async function activeProfile(next: Context) {
        await verify(next); const state=await owned(next,vault)
        if (!state.paused || !state.rootPermissionValid || state.operator !== d.operator) fail('sequence_activation_unavailable')
        const policy=await call(next,vault,'policy'), limits=await call(next,vault,'executionLimits')
        if (policy.serviceFeeBps !== d.serviceFeeBps) fail('sequence_tariff_changed')
        return {state,policy,limits}
      }
      const before=await activeProfile(c), {state,policy,limits}=before
      return prepare(c,'resume',vault,vault,encode('resume'),gas,[
        `Activate execution for root NFT #${state.rootTokenId} with operator ${state.operator}.`,
        `Base: ${state.baseCurrency}. Quote: ${state.quoteCurrency}. The root NFT remains in your wallet.`,
        '2% on earned fees actually consumed for reinvestment, once, including already uncollected fees previously consented to. Never principal.',
        `Fee recipient: ${d.serviceFeeRecipient}. Policy version ${policy.version}; limits version ${limits.version}.`,
        `Trigger distance: ${policy.triggerDistanceBps} bps; maximum overlap: ${policy.maxOverlapBps} bps; minimum interval: ${policy.minimumIntervalSeconds}s; maximum positions: ${policy.maxPositions}.`,
        `Successor upside: ${limits.upsideBps} bps; maximum slippage: ${limits.maxSlippageBps} bps; maximum price impact: ${limits.maxPriceImpactBps} bps.`,
        `Execution gas cost cap: ${limits.maxGasCostWei} wei; observation age: ${limits.maxObservationAgeSeconds}s; forecast horizon: ${limits.forecastHorizonSeconds}s.`,
        'This owner transaction enables the configured operator. No wallet sign-in or page visit activates execution by itself.',
      ],async next=>{
        const current=await activeProfile(next)
        if (current.state.stateNonce !== state.stateNonce || current.policy.version !== policy.version || current.limits.version !== limits.version) fail('sequence_preparation_changed')
      })
    }),
    recover: (vault: Address, action: 'pause'|'revoke-operator'|'revoke-root'|'withdraw-child'|'withdraw-fees', gas: GasBudget, values: {tokenId?:bigint;sourceId?:Hex;currency?:Address;original?:bigint;charged?:bigint} = {}) => bounded(async c => {
      // Capture values before an await; caller mutation cannot change a review.
      const v = Object.freeze({...values})
      async function check(next: Context) {
        await verify(next,true); const state = await owned(next,vault)
        if (action === 'pause' && state.paused) fail('sequence_already_paused')
        if (action === 'revoke-operator' && state.operator === zeroAddress) fail('operator_already_revoked')
        if (action === 'revoke-root') { await code(next,'positionManager'); equal(await call(next,d.positionManager,'ownerOf',[state.rootTokenId]),wallet.owner); equal(await call(next,d.positionManager,'getApproved',[state.rootTokenId]),vault) }
        if (action === 'withdraw-child') {
          if (v.tokenId === undefined || uint(v.tokenId,256) === 0n) fail('invalid_child')
          await code(next,'positionManager'); const p = await call(next,vault,'position',[v.tokenId])
          if (!p.known || !p.active || p.isRoot) fail('invalid_child'); equal(await call(next,d.positionManager,'ownerOf',[v.tokenId]),vault)
        }
        if (action === 'withdraw-fees') {
          if (!v.sourceId || !hashPattern.test(v.sourceId) || !v.currency || !addressPattern.test(v.currency) || ![state.baseCurrency,state.quoteCurrency].includes(v.currency) || v.original === undefined || v.charged === undefined || uint(v.original)+uint(v.charged) === 0n) fail('invalid_fee_withdrawal')
          const source = await call(next,vault,'source',[v.sourceId]), balance = await call(next,vault,'feeBalance',[v.sourceId,v.currency])
          if (!source.known || v.original! > balance.original || v.charged! > balance.charged) fail('fee_reserve_insufficient')
        }
        return state
      }
      const s = await check(c)
      const name = action === 'pause'?'pause':action === 'revoke-operator'?'revokeOperator':action === 'revoke-root'?'approve':action === 'withdraw-child'?'withdrawChildPosition':'withdrawFeeReserves'
      const args = action === 'revoke-root'?[zeroAddress,s.rootTokenId]:action === 'withdraw-child'?[v.tokenId]:action === 'withdraw-fees'?[v.sourceId,v.currency,v.original,v.charged]:[]
      const detail = action === 'withdraw-child'?`Return child NFT #${v.tokenId} to your wallet.`:action === 'withdraw-fees'?`Return ${v.original} original + ${v.charged} already charged fee units of ${v.currency}, source ${v.sourceId}, to your wallet.`:action === 'revoke-root'?`Revoke only the sequence approval for root NFT #${s.rootTokenId}.`:action === 'pause'?'Pause future execution.':'Remove the operator’s execution authority.'
      return prepare(c,action,vault,action === 'revoke-root'?d.positionManager:vault,encode(name,args),gas,[detail,'Owner recovery: no Domino service fee. Network gas still applies. No private sign-in or running executor is required.'],async next => { await check(next) })
    }),
    reserves: (vault: Address, tokenId: bigint) => bounded(async c => {
      await verify(c,true); const s = await owned(c,vault), p = await call(c,vault,'position',[uint(tokenId,256)])
      if (!p.known) fail('unknown_position')
      const balances: {sourceId:Hex;currency:Address;original:bigint;charged:bigint}[] = []
      for (const sourceId of [p.source0,p.source1] as Hex[]) for (const currency of [s.baseCurrency,s.quoteCurrency]) balances.push({sourceId,currency,...await call(c,vault,'feeBalance',[sourceId,currency])})
      const successor = await call(c,vault,'successorOf',[tokenId]) as bigint
      await canonical(c); return {tokenId,active:p.active,isRoot:p.isRoot,successor,balances}
    }),
    send: (prepared: PreparedSequence, acknowledged: boolean) => bounded(async c => {
      const guard = issued.get(prepared)
      if (!acknowledged || !guard || prepared.owner !== wallet.owner || now() >= prepared.expiresAt) fail('review_required')
      await guard!(c); await canonical(c)
      const nonce = BigInt(prepared.transaction.nonce), latest = quantity(await c.rpc('eth_getTransactionCount',[wallet.owner,'latest'])), pending = quantity(await c.rpc('eth_getTransactionCount',[wallet.owner,'pending']))
      if (latest !== nonce || pending !== nonce || wallet.nonceOffered(nonce)) fail('pending_wallet_transaction')
      await c.rpc('eth_call',[prepared.transaction,'latest'])
      const claim = await wallet.claimNonce(nonce)
      issued.delete(prepared)
      const hash = await c.rpc('eth_sendTransaction',[prepared.transaction],async error => {
        if (error && typeof error === 'object' && (error as {code?:unknown}).code === 4001) await wallet.releaseRejectedNonce(nonce,claim)
      })
      if (typeof hash !== 'string' || !hashPattern.test(hash)) fail('wallet_outcome_unknown')
      sent.set(hash as Hex,prepared); return hash as Hex
    }),
    receipt: (hash: Hex) => bounded(async c => {
      if (!hashPattern.test(hash)) fail('invalid_transaction_hash')
      const expected = sent.get(hash) ?? fail('receipt_not_from_this_review')
      // After a reload, owner state remains independently readable; never label
      // an unrelated pasted transaction as confirmation of a reviewed action.
      const value = await c.rpc('eth_getTransactionReceipt',[hash])
      if (value === null) return {state:'pending' as const}
      const r = record(value), tx = record(await c.rpc('eth_getTransactionByHash',[hash]))
      for (const [actual,wanted] of [[r.transactionHash,hash],[tx.hash,hash],[tx.from,expected.owner],[tx.to,expected.transaction.to],[tx.input,expected.transaction.data],[r.from,expected.owner],[r.to,expected.transaction.to]]) equal(actual,wanted)
      if (quantity(tx.nonce) !== BigInt(expected.transaction.nonce) || quantity(tx.value) !== 0n || quantity(tx.chainId) !== 4663n || quantity(tx.type) !== 2n
        || quantity(tx.gas) > BigInt(expected.transaction.gas) || quantity(tx.maxFeePerGas) > BigInt(expected.transaction.maxFeePerGas)
        || quantity(tx.maxPriorityFeePerGas) > BigInt(expected.transaction.maxPriorityFeePerGas)
        || tx.blockHash !== r.blockHash || tx.blockNumber !== r.blockNumber) fail('receipt_identity_changed')
      const block = record(await c.rpc('eth_getBlockByNumber',[r.blockNumber,false]))
      if (block.hash !== r.blockHash) return {state:'reorged' as const}
      const status = quantity(r.status); if (status !== 0n && status !== 1n) fail('invalid_receipt')
      if (status === 0n) return {state:'reverted' as const}
      const finalized = record(await c.rpc('eth_getBlockByNumber',['finalized',false]))
      return {state:quantity(finalized.number) >= quantity(r.blockNumber)?'finalized' as const:'confirming' as const}
    }),
  }
}
