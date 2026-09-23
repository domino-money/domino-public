import { concatHex, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, numberToHex, stringToHex, zeroAddress, type Abi, type Address, type ContractFunctionName, type ContractFunctionReturnType, type Hex } from 'viem'
import { POSITION_MANAGER, SEQUENCE_FACTORY, pinned, unpinned } from './pin.js'
import type { GasBudget, WalletRpc } from './setup'
import { sequenceSnapshotFrom, snapshotCalls, type SequenceSnapshot } from './sequenceSnapshot.js'

/*
 * The closed ABI is written as JSON: exactly what viem's parseAbi and
 * parseAbiParameters make of the reviewed signatures listed with it, so the
 * page ships no ABI parser. tests/performance.controller.test.mjs parses those
 * signature lines and requires every JSON form here to equal the result.
 */

/**
 * sequenceAbi signatures:
 *   struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
 *   struct Policy { uint16 serviceFeeBps; uint16 triggerDistanceBps; uint16 maxOverlapBps; uint32 minimumIntervalSeconds; uint8 maxPositions; uint64 version; bool paused; }
 *   struct Limits { uint64 version; uint32 upsideBps; uint16 maxSlippageBps; uint16 maxPriceImpactBps; uint128 maxGasCostWei; uint32 maxObservationAgeSeconds; uint32 forecastHorizonSeconds; }
 *   struct InitParams { uint256 rootTokenId; bytes32 expectedPoolId; address baseCurrency; address quoteCurrency; address operator; bool consentToUncollectedFees; Policy policy; Limits limits; }
 *   struct Position { bool known; bool active; bool isRoot; uint256 parentTokenId; uint64 generation; int24 tickLower; int24 tickUpper; bytes32 registrationBaselineId; bytes32 identity; bytes32 source0; bytes32 source1; }
 *   struct Source { bool known; uint256 tokenId; address originalCurrency; bytes32 positionIdentity; }
 *   struct Balance { uint128 original; uint128 charged; }
 *   function factory() view returns(address)
 *   function implementation() view returns(address)
 *   function implementationVersion() view returns(uint64)
 *   function poolManager() view returns(address)
 *   function positionManager() view returns(address)
 *   function stateView() view returns(address)
 *   function readHelper() view returns(address)
 *   function executionEngine() view returns(address)
 *   function serviceFeeRecipient() view returns(address)
 *   function routingHelper() view returns(address)
 *   function priceGuard() view returns(address)
 *   function publisher() view returns(address)
 *   function implementationCodeHash() view returns(bytes32)
 *   function readHelperCodeHash() view returns(bytes32)
 *   function executionEngineCodeHash() view returns(bytes32)
 *   function poolManagerCodeHash() view returns(bytes32)
 *   function positionManagerCodeHash() view returns(bytes32)
 *   function stateViewCodeHash() view returns(bytes32)
 *   function readHelperHash() view returns(bytes32)
 *   function routingHelperHash() view returns(bytes32)
 *   function priceGuardHash() view returns(bytes32)
 *   function nextOwnerNonce(address) view returns(uint256)
 *   function predictVault(address,uint256) view returns(address)
 *   function isVault(address) view returns(bool)
 *   function vaultForSequence(bytes32) view returns(address)
 *   function createVault(InitParams,uint256) returns(address)
 *   function owner() view returns(address)
 *   function operator() view returns(address)
 *   function sequenceId() view returns(bytes32)
 *   function rootTokenId() view returns(uint256)
 *   function poolId() view returns(bytes32)
 *   function poolKey() view returns(PoolKey)
 *   function baseCurrency() view returns(address)
 *   function quoteCurrency() view returns(address)
 *   function policy() view returns(Policy)
 *   function executionLimits() view returns(Limits)
 *   function stateNonce() view returns(uint64)
 *   function rootPermissionValid() view returns(bool)
 *   function successorOf(uint256) view returns(uint256)
 *   function activePositions() view returns(uint256)
 *   function position(uint256) view returns(Position)
 *   function source(bytes32) view returns(Source)
 *   function feeBalance(bytes32,address) view returns(Balance)
 *   function pause()
 *   function resume()
 *   function setOperator(address)
 *   function revokeOperator()
 *   function withdrawChildPosition(uint256)
 *   function withdrawFeeReserves(bytes32,address,uint128,uint128)
 *   function setPolicy(Policy)
 *   function setExecutionLimits(Limits)
 *   function rearmRoot(bool)
 *   function recoverUnmanagedPosition(uint256)
 *   function recoverUntrackedCurrency(address,uint256)
 *   function ownerOf(uint256) view returns(address)
 *   function getApproved(uint256) view returns(address)
 *   function approve(address,uint256)
 *   function getPoolAndPositionInfo(uint256) view returns(PoolKey,uint256)
 */
/**
 * Read on its own, not in `sequenceAbi`: every name added there widens the
 * union `call()` is generic over until viem's return-type inference stops
 * finishing — the same wall `links` hit.
 *
 * accountedCurrency signature: function accountedCurrency(address) view returns(uint256)
 */
const reserveAbi = [{ name: 'accountedCurrency', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }] as const satisfies Abi

const poolKeyComponents = [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] as const
const policyComponents = [{ name: 'serviceFeeBps', type: 'uint16' }, { name: 'triggerDistanceBps', type: 'uint16' }, { name: 'maxOverlapBps', type: 'uint16' }, { name: 'minimumIntervalSeconds', type: 'uint32' }, { name: 'maxPositions', type: 'uint8' }, { name: 'version', type: 'uint64' }, { name: 'paused', type: 'bool' }] as const
const limitsComponents = [{ name: 'version', type: 'uint64' }, { name: 'upsideBps', type: 'uint32' }, { name: 'maxSlippageBps', type: 'uint16' }, { name: 'maxPriceImpactBps', type: 'uint16' }, { name: 'maxGasCostWei', type: 'uint128' }, { name: 'maxObservationAgeSeconds', type: 'uint32' }, { name: 'forecastHorizonSeconds', type: 'uint32' }] as const
const initParamsComponents = [{ name: 'rootTokenId', type: 'uint256' }, { name: 'expectedPoolId', type: 'bytes32' }, { name: 'baseCurrency', type: 'address' }, { name: 'quoteCurrency', type: 'address' }, { name: 'operator', type: 'address' }, { name: 'consentToUncollectedFees', type: 'bool' }, { name: 'policy', type: 'tuple', components: policyComponents }, { name: 'limits', type: 'tuple', components: limitsComponents }] as const
const positionComponents = [{ name: 'known', type: 'bool' }, { name: 'active', type: 'bool' }, { name: 'isRoot', type: 'bool' }, { name: 'parentTokenId', type: 'uint256' }, { name: 'generation', type: 'uint64' }, { name: 'tickLower', type: 'int24' }, { name: 'tickUpper', type: 'int24' }, { name: 'registrationBaselineId', type: 'bytes32' }, { name: 'identity', type: 'bytes32' }, { name: 'source0', type: 'bytes32' }, { name: 'source1', type: 'bytes32' }] as const
const sourceComponents = [{ name: 'known', type: 'bool' }, { name: 'tokenId', type: 'uint256' }, { name: 'originalCurrency', type: 'address' }, { name: 'positionIdentity', type: 'bytes32' }] as const
const balanceComponents = [{ name: 'original', type: 'uint128' }, { name: 'charged', type: 'uint128' }] as const
export const sequenceAbi = [
  { name: 'factory', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'implementation', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'implementationVersion', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { name: 'poolManager', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'positionManager', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'stateView', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'readHelper', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'executionEngine', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'serviceFeeRecipient', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'routingHelper', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'priceGuard', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'publisher', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'implementationCodeHash', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { name: 'readHelperCodeHash', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { name: 'executionEngineCodeHash', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { name: 'poolManagerCodeHash', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { name: 'positionManagerCodeHash', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { name: 'stateViewCodeHash', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { name: 'readHelperHash', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { name: 'routingHelperHash', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { name: 'priceGuardHash', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { name: 'nextOwnerNonce', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'predictVault', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'address' }] },
  { name: 'isVault', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bool' }] },
  { name: 'vaultForSequence', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'address' }] },
  { name: 'createVault', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'tuple', components: initParamsComponents }, { type: 'uint256' }], outputs: [{ type: 'address' }] },
  { name: 'owner', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'operator', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'sequenceId', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { name: 'rootTokenId', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'poolId', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { name: 'poolKey', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'tuple', components: poolKeyComponents }] },
  { name: 'baseCurrency', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'quoteCurrency', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'policy', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'tuple', components: policyComponents }] },
  { name: 'executionLimits', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'tuple', components: limitsComponents }] },
  { name: 'stateNonce', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { name: 'rootPermissionValid', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { name: 'successorOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { name: 'activePositions', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'position', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'tuple', components: positionComponents }] },
  { name: 'source', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'tuple', components: sourceComponents }] },
  { name: 'feeBalance', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'address' }], outputs: [{ type: 'tuple', components: balanceComponents }] },
  { name: 'pause', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { name: 'resume', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { name: 'setOperator', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }], outputs: [] },
  { name: 'revokeOperator', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { name: 'withdrawChildPosition', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] },
  { name: 'withdrawFeeReserves', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint128' }, { type: 'uint128' }], outputs: [] },
  { name: 'setPolicy', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'tuple', components: policyComponents }], outputs: [] },
  { name: 'setExecutionLimits', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'tuple', components: limitsComponents }], outputs: [] },
  { name: 'rearmRoot', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'bool' }], outputs: [] },
  { name: 'recoverUnmanagedPosition', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }], outputs: [] },
  { name: 'recoverUntrackedCurrency', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] },
  { name: 'ownerOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { name: 'getApproved', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] },
  { name: 'getPoolAndPositionInfo', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'tuple', components: poolKeyComponents }, { type: 'uint256' }] },
] as const
/** sequenceIdParameters signature: bytes32,uint256,address,address,uint256 */
export const sequenceIdParameters = [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }] as const
/** poolKeyParameters signature: (address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) */
export const poolKeyParameters = [{ type: 'tuple', components: poolKeyComponents }] as const
export type AutomationMode = 'compound' | 'domino'
export const AUTOMATION_FEE_BPS = { compound: 200, domino: 400 } as const
export const automationModeForFee = (feeBps: number): AutomationMode | null => feeBps === 200 ? 'compound' : feeBps === 400 ? 'domino' : null
const feeDescription = (feeBps: number) => `${feeBps / 100}% of earned fees consumed, once; never principal or already charged lots. No additional automation swap fee.`
type Component = 'factory' | 'implementation' | 'poolManager' | 'positionManager' | 'stateView' | 'readHelper' | 'engine' | 'routing' | 'priceGuard'
export interface SequenceDeployment extends Record<Component, Address> {
  serviceFeeRecipient: Address; operator: Address; pricePublisher: Address; serviceFeeBps: 200; dominoServiceFeeBps: 400; expiresAt: number
  codeHashes: Record<Component | 'vault', Hex>
}
export interface SequenceOptions {
  automationMode: AutomationMode
  rootTokenId: bigint; baseIsCurrency0: boolean; consentToUncollectedFees: boolean
  triggerDistanceBps: number; maxOverlapBps: number; minimumIntervalSeconds: number; maxPositions: number
  upsideBps: number; maxSlippageBps: number; maxPriceImpactBps: number; maxGasCostWei: bigint
  maxObservationAgeSeconds: number; forecastHorizonSeconds: number
}
export interface SequenceState {
  vault: Address; sequenceId: Hex; rootTokenId: bigint; operator: Address; paused: boolean; rootPermissionValid: boolean
  baseCurrency: Address; quoteCurrency: Address; stateNonce: bigint
  serviceFeeBps: number; automationMode: AutomationMode | null
}
/** A sequence this wallet created, as the factory lists it: newest first, with its root NFT. */
export interface OwnedSequence { vault: Address; sequenceId: Hex; ownerNonce: bigint; rootTokenId: bigint }
/** How many of a wallet's most recent sequences the client lists; `older` says whether it created more. */
export const SEQUENCE_LIST_LIMIT = 8
/** The most successors a member read follows, so one read stays inside its wallet-call ceiling. */
export const SEQUENCE_MEMBER_STEPS = 30
export interface PreparedSequence {
  kind: 'approve-root' | 'create' | 'resume' | 'pause' | 'restore-operator' | 'revoke-operator' | 'revoke-root' | 'withdraw-child' | 'withdraw-fees' | 'rearm-root' | 'recover-position' | 'recover-currency' | 'set-policy' | 'set-limits'
  owner: Address; vault: Address; expiresAt: number; summary: readonly string[]
  transaction: Readonly<{ from: Address; to: Address; data: Hex; value: '0x0'; nonce: Hex; gas: Hex; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex; chainId: '0x1237'; type: '0x2' }>
}
const components: Component[] = ['factory','implementation','poolManager','positionManager','stateView','readHelper','engine','routing','priceGuard']
const addressPattern = /^0x[0-9a-f]{40}$/, hashPattern = /^0x[0-9a-f]{64}$/
// A closed failure raised by this client, distinct from an untrusted wallet
// provider exception. Only the code crosses into the owner screen.
class SequenceFault extends Error {
  constructor(code: string, readonly stage: string | null = null) { super(code) }
}
const fail = (code: string): never => { throw new SequenceFault(code) }
const READ_RPC_FAILURE: Readonly<Record<string, string>> = {
  eth_accounts: 'sequence_read_accounts',
  eth_chainId: 'sequence_read_chain',
  eth_getBlockByNumber: 'sequence_read_block',
  eth_getCode: 'sequence_read_code',
  eth_call: 'sequence_read_call',
}
/** Opening the provider precedes the first RPC. Keep that failure closed too. */
export function sequenceProviderReadError(error: unknown): Error {
  return error instanceof Error && error.message === 'connect_robinhood_wallet' ? error : new SequenceFault('sequence_read_provider')
}
/** No unknown exception from a read is ever copied into the DOM. */
export function sequenceReadError(error: unknown): Error {
  return error instanceof SequenceFault ? error : new SequenceFault('sequence_read_unexpected')
}
/** A closed contract/function label for a rejected owner eth_call. No address,
 * calldata, provider message or provider error data leaves this client. */
export function sequenceReadStage(error: unknown): string | null {
  return error instanceof SequenceFault && error.message === 'sequence_read_call' ? error.stage : null
}
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
  const id = keccak256(encodeAbiParameters(sequenceIdParameters,
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
  if (Object.keys(d).sort().join() !== [...names,'serviceFeeBps','dominoServiceFeeBps','expiresAt','codeHashes'].sort().join()
    || !names.every(k => typeof d[k] === 'string' && addressPattern.test(d[k]) && d[k] !== zeroAddress)
    || Object.keys(hashes).sort().join() !== [...components,'vault'].sort().join()
    || !Object.values(hashes).every(h => typeof h === 'string' && hashPattern.test(h) && !/^0x0+$/.test(h))
    || new Set(components.map(k => d[k])).size !== components.length || d.operator === d.pricePublisher
    || [...components,'serviceFeeRecipient'].some(k => d[k] === d.operator || d[k] === d.pricePublisher)
    || d.serviceFeeBps !== 200 || d.dominoServiceFeeBps !== 400 || !Number.isSafeInteger(d.expiresAt) || Number(d.expiresAt) <= now) return fail('invalid_sequence_release')
  // Everything above proves the record is self-consistent. Nothing above proves
  // it is OURS: every address it compares comes from the record. One identity
  // has to be anchored to this build, or a substituted factory passes the whole
  // on-chain verification and chooses the spender of a real NFT approval. See
  // ./pin.ts. Domino V1 is pinned there; a record naming any other factory is
  // refused before a client is built from it.
  if (!pinned(SEQUENCE_FACTORY, d.factory)) return fail(unpinned(SEQUENCE_FACTORY) ? 'deployment_not_pinned' : 'deployment_identity_unpinned')
  if (!pinned(POSITION_MANAGER, d.positionManager)) return fail('deployment_identity_unpinned')
  const out = d as unknown as SequenceDeployment
  if (keccak256(cloneRuntime(out.implementation)) !== hashes.vault) return fail('invalid_clone_template')
  return Object.freeze({ ...out, codeHashes: Object.freeze({ ...out.codeHashes }) })
}

/** Closed owner-only calls: no backend calldata, signer, router or nonce is
 * accepted. Every logical action has one deadline and a fixed read ceiling. */
export function createSequenceClient(wallet: WalletRpc, deployment: SequenceDeployment, now = () => Date.now() / 1000,
  currentAdmission?: () => Promise<SequenceDeployment | null>,
  snapshotRead?: (owner: Address, tokenId: bigint | null) => Promise<SequenceSnapshot>) {
  const d = Object.freeze({ ...deployment, codeHashes: Object.freeze({ ...deployment.codeHashes }) })
  type Rpc = (method: string, params: unknown[], rejected?: (error: unknown) => Promise<void>) => Promise<unknown>
  type Context = { rpc: Rpc; block: Hex; hash: Hex; diagnoseRead: boolean }
  const issued = new WeakMap<PreparedSequence, (c: Context) => Promise<void>>()
  const sent = new Map<Hex, PreparedSequence>()
  let busy = false
  /** The snapshot has a closed, server-selected set of view results. Its source
   * is the Domino local RPC, which is a trust boundary, not a state proof. */
  function snapshotRpc(snapshot: SequenceSnapshot, walletRpc: Rpc, check: () => void): Rpc {
    const block = numberToHex(BigInt(snapshot.blockNumber))
    const codes = new Map<string, Hex>(), calls = new Map<string, Hex>()
    const setCode = (to: Address, value: Hex) => {
      const target = to.toLowerCase(), previous = codes.get(target)
      if (previous !== undefined && previous !== value) fail('sequence_read_snapshot_invalid')
      codes.set(target,value)
    }
    const key = (to: Address, data: Hex) => `${to.toLowerCase()}:${data.toLowerCase()}`
    const put = (to: Address, name: string, args: readonly unknown[], result: Hex) => {
      const abi: Abi = sequenceAbi
      calls.set(key(to,encodeFunctionData({abi,functionName:name,args})),result)
    }
    for (const role of components) setCode(d[role],snapshot.code[role])
    setCode(d.operator,snapshot.code.operator); setCode(d.pricePublisher,snapshot.code.pricePublisher)
    for (const [role,names] of Object.entries(snapshotCalls)) {
      const target = d[role as Component]
      for (const name of names) put(target,name,name === 'nextOwnerNonce' ? [wallet.owner] : [],snapshot.calls[role][name])
    }
    let nonce: bigint
    try { nonce = decodeFunctionResult({abi:sequenceAbi as Abi,functionName:'nextOwnerNonce',data:snapshot.calls.factory.nextOwnerNonce}) as bigint }
    catch { return fail('sequence_read_snapshot_invalid') }
    if (snapshot.recent.length !== Number(nonce < 8n ? nonce : 8n)) fail('sequence_read_snapshot_invalid')
    for (const [index,row] of snapshot.recent.entries()) {
      const expectedNonce = nonce - 1n - BigInt(index), expected = sequenceIdentity(d,wallet.owner,expectedNonce)
      if (row.ownerNonce !== expectedNonce.toString() || row.sequenceId !== expected.id || row.vault !== expected.vault)
        fail('sequence_read_snapshot_invalid')
      put(d.factory,'vaultForSequence',[row.sequenceId],row.vaultForSequence)
    }
    if (snapshot.root) {
      const root = snapshot.root, id = BigInt(root.tokenId)
      const expected = sequenceIdentity(d,wallet.owner,nonce)
      if (root.predictedSequenceId !== expected.id || root.predictedVault !== expected.vault) fail('sequence_read_snapshot_invalid')
      put(d.positionManager,'ownerOf',[id],root.ownerOf)
      put(d.positionManager,'getPoolAndPositionInfo',[id],root.getPoolAndPositionInfo)
      put(d.positionManager,'getApproved',[id],root.getApproved)
      put(d.factory,'predictVault',[wallet.owner,nonce],root.predictVault)
      setCode(root.currency0,root.code.currency0); setCode(root.currency1,root.code.currency1)
      setCode(root.predictedVault,root.code.predictedVault)
    }
    return async (method, params) => {
      if (method !== 'eth_call' && method !== 'eth_getCode') return walletRpc(method,params)
      check()
      if (params.length !== 2 || params[1] !== block) return fail('sequence_read_snapshot_invalid')
      if (method === 'eth_getCode') {
        const target = String(params[0]).toLowerCase()
        return codes.get(target) ?? fail('sequence_read_snapshot_invalid')
      }
      const tx = record(params[0])
      if (Object.keys(tx).sort().join() !== 'data,to' || typeof tx.to !== 'string' || typeof tx.data !== 'string') return fail('sequence_read_snapshot_invalid')
      return calls.get(key(tx.to as Address,tx.data as Hex)) ?? fail('sequence_read_snapshot_invalid')
    }
  }
  async function bounded<T>(work: (c: Context) => Promise<T>, diagnoseRead = false,
    fallbackTokenId?: bigint | null): Promise<T> {
    if (busy) return fail('wallet_action_busy')
    busy = true; const started = now(); let end = started + 30; let calls = 0, readCallLimit = 100
    const rpc: Rpc = async (method, params, rejected) => {
      // Keep the wallet transaction lane exactly as it was. Diagnostic
      // normalization is for owner reads only and never wraps a send result.
      if (!diagnoseRead) {
        if (!wallet.current() || now() >= end || ++calls > 100) return fail('wallet_action_expired')
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const original = wallet.request(method, params).catch(async error => {
            if (rejected) { try { await rejected(error) } catch { /* A failed release keeps the nonce protected. */ } }
            throw error
          })
          const value = await Promise.race([original, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('wallet_timeout')), Math.max(1, (end - now()) * 1000)) })])
          if (!wallet.current() || now() >= end) return fail('wallet_identity_changed')
          return value
        } finally { clearTimeout(timer) }
      }
      if (!wallet.current()) return fail('wallet_action_expired')
      // Wallet RPCs can reject an isolated contract read under load. Retry
      // only these owner reads, with the exact same pinned block and calldata.
      // Every attempt still counts toward this action's deadline and RPC cap.
      const retryable = method === 'eth_call' || method === 'eth_getCode'
      const failure = READ_RPC_FAILURE[method] ?? 'sequence_read_rpc'
      for (let attempt = 0; attempt < (retryable ? 3 : 1); attempt++) {
        if (!wallet.current()) return fail('wallet_identity_changed')
        if (now() >= end) return fail('sequence_read_timeout')
        if (++calls > readCallLimit) return fail('sequence_read_limit')
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          let reply: Promise<unknown>
          try { reply = Promise.resolve(wallet.request(method, params)) }
          catch { return fail(failure) }
          const original = reply.catch(() => fail(failure))
          const value = await Promise.race([original, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SequenceFault('sequence_read_timeout')), Math.max(1, (end - now()) * 1000)) })])
          if (!wallet.current()) return fail('wallet_identity_changed')
          if (now() >= end) return fail('sequence_read_timeout')
          return value
        } catch (error) {
          if (!retryable || attempt === 2 || !(error instanceof SequenceFault) || error.message !== failure) throw error
          if (!wallet.current()) return fail('wallet_identity_changed')
          const remaining = Math.floor((end - now()) * 1000)
          if (remaining <= 0) return fail('sequence_read_timeout')
          await new Promise<void>(resolve => setTimeout(resolve, Math.min(attempt === 0 ? 200 : 500, remaining)))
        } finally { clearTimeout(timer) }
      }
      return fail(failure)
    }
    try {
      const execute = async (snapshot?: SequenceSnapshot) => {
        const accounts = await rpc('eth_accounts', [])
        if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== wallet.owner || quantity(await rpc('eth_chainId', [])) !== 4663n) return fail('wallet_identity_changed')
        const tag = snapshot ? numberToHex(BigInt(snapshot.blockNumber)) : 'latest'
        const block = record(await rpc('eth_getBlockByNumber', [tag, false]))
        if (!hashPattern.test(String(block.hash)) || snapshot && (block.hash !== snapshot.blockHash || quantity(block.number) !== BigInt(snapshot.blockNumber))) return fail('chain_changed')
        const c = { rpc: snapshot ? snapshotRpc(snapshot,rpc,()=>{
          if (!wallet.current() || now() >= end) fail('sequence_read_timeout')
          if (++calls > readCallLimit) fail('sequence_read_limit')
        }) : rpc,
          block: numberToHex(quantity(block.number)), hash: block.hash as Hex, diagnoseRead }
        return work(c)
      }
      try { return await execute() }
      catch (error) {
        if (!diagnoseRead || !snapshotRead || fallbackTokenId === undefined || !(error instanceof SequenceFault)
            || !['sequence_read_call','sequence_read_code'].includes(error.message)) throw error
        if (!wallet.current() || now() >= end) return fail('sequence_read_timeout')
        // One read-only replay gets its own allowance after a late wallet
        // rejection. The first phase still has its original 30s/100-call cap;
        // the entire action cannot exceed 55s/160 fixed reads.
        end = Math.min(now() + 25, started + 55)
        readCallLimit = 160
        let snapshot: SequenceSnapshot
        try { snapshot = sequenceSnapshotFrom(await snapshotRead(wallet.owner,fallbackTokenId),wallet.owner,fallbackTokenId) }
        catch (failure) {
          // OFF/404 or a broken bridge is an availability miss: preserve the
          // original closed wallet error and stage. Never retry the 48 reads.
          if (!(failure instanceof Error) || failure.message !== 'sequence_read_snapshot_invalid') throw error
          return fail('sequence_read_snapshot_invalid')
        }
        if (!wallet.current() || now() >= end) return fail('sequence_read_timeout')
        return execute(snapshot)
      }
    } finally { busy = false }
  }
  // Call signatures are selected from the local closed ABI, never public JSON.
  type ViewName = ContractFunctionName<typeof sequenceAbi, 'view'>
  const readStage = (to: Address, name: string) => {
    const role = components.find(component => d[component].toLowerCase() === to.toLowerCase()) ?? 'other_contract'
    return `${role.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}_${name.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}`
  }
  async function readCall(c: Context, to: Address, functionName: string, args: readonly unknown[]): Promise<Hex> {
    const abi: Abi = sequenceAbi
    let value: unknown
    try { value = await c.rpc('eth_call', [{ to, data: encodeFunctionData({ abi, functionName, args }) }, c.block]) }
    catch (error) {
      if (c.diagnoseRead && error instanceof SequenceFault && error.message === 'sequence_read_call')
        throw new SequenceFault('sequence_read_call', readStage(to, functionName))
      throw error
    }
    return hex(value)
  }
  async function call<Name extends ViewName>(c: Context, to: Address, name: Name, args: readonly unknown[] = []): Promise<ContractFunctionReturnType<typeof sequenceAbi, 'view', Name>> {
    const abi: Abi = sequenceAbi, functionName: string = name
    const data = await readCall(c, to, functionName, args)
    try { return decodeFunctionResult({ abi, functionName, data }) as ContractFunctionReturnType<typeof sequenceAbi, 'view', Name> }
    catch (error) { if (c.diagnoseRead) fail('sequence_read_decode'); throw error }
  }
  // Narrowed to the functions that WRITE, which is all this builds. Naming
  // every function of the ABI — views included — is a type the compiler cannot
  // finish, the same reason `links` above is left untyped.
  const encode = (name: ContractFunctionName<typeof sequenceAbi, 'nonpayable'>, args: readonly unknown[] = []) => encodeFunctionData({ abi: sequenceAbi as Abi, functionName: name, args })
  const equal = (actual: unknown, expected: unknown) => { if (String(actual).toLowerCase() !== String(expected).toLowerCase()) fail('deployment_identity_changed') }
  async function code(c: Context, component: Component) {
    if (keccak256(hex(await c.rpc('eth_getCode', [d[component], c.block]))) !== d.codeHashes[component]) fail('deployment_code_changed')
  }
  async function links(c: Context, to: Address, values: Partial<Record<ViewName, unknown>>) {
    // The same call as `call`, left untyped: a link is only compared as text, and typing one result over every view name is needlessly deep for the compiler.
    const abi: Abi = sequenceAbi
    for (const [functionName, expected] of Object.entries(values) as [string,unknown][]) {
      const data = await readCall(c, to, functionName, [])
      let decoded: unknown
      try { decoded = decodeFunctionResult({ abi, functionName, data }) }
      catch (error) { if (c.diagnoseRead) fail('sequence_read_decode'); throw error }
      equal(decoded, expected)
    }
  }
  async function verify(c: Context, recovery = false) {
    if (!recovery && now() >= d.expiresAt) fail('sequence_release_expired')
    if (!recovery && (d.serviceFeeBps !== 200 || d.dominoServiceFeeBps !== 400)) fail('sequence_tariff_changed')
    if (!recovery) {
      // The UI performs one bounded same-origin GET here. OFF or a changed
      // profile must stop a previously loaded client before the wallet opens.
      const current=await currentAdmission?.()
      if (!current || now() >= current.expiresAt
        || [...components,'operator','pricePublisher','serviceFeeRecipient','serviceFeeBps','dominoServiceFeeBps'].some(k => current[k as keyof SequenceDeployment] !== d[k as keyof SequenceDeployment])
        || Object.entries(d.codeHashes).some(([key,hash]) => current.codeHashes[key as keyof SequenceDeployment['codeHashes']] !== hash)) fail('sequence_admission_unavailable')
    }
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
      quoteCurrency: String(await call(c, vault, 'quoteCurrency')).toLowerCase() as Address, stateNonce: await call(c, vault, 'stateNonce'), serviceFeeBps: p.serviceFeeBps, automationMode: automationModeForFee(p.serviceFeeBps) }
  }
  async function root(c: Context, tokenId: bigint) {
    if (uint(tokenId,256) === 0n) fail('invalid_root_nft')
    equal(await call(c, d.positionManager, 'ownerOf', [tokenId]), wallet.owner)
    const [rawKey, packed] = await call(c, d.positionManager, 'getPoolAndPositionInfo', [tokenId])
    const key = { ...rawKey, currency0: address(rawKey.currency0.toLowerCase()), currency1: address(rawKey.currency1.toLowerCase()), hooks: address(rawKey.hooks.toLowerCase()) }
    if (key.currency0 >= key.currency1 || key.hooks !== zeroAddress || key.fee > 1_000_000 || key.tickSpacing <= 0 || key.tickSpacing > 32767) fail('unsupported_pool')
    const poolId = keccak256(encodeAbiParameters(poolKeyParameters, [key]))
    const lower = Number(BigInt.asIntN(24, packed >> 8n)), upper = Number(BigInt.asIntN(24, packed >> 32n))
    if (packed >> 56n !== BigInt(poolId) >> 56n || lower < -887272 || upper > 887272 || lower >= upper || lower % key.tickSpacing || upper % key.tickSpacing) fail('invalid_position_identity')
    for (const currency of [key.currency0,key.currency1]) if (currency !== zeroAddress && hex(await c.rpc('eth_getCode', [currency,c.block])) === '0x') fail('invalid_currency')
    const ownerNonce = await call(c,d.factory,'nextOwnerNonce',[wallet.owner]) as bigint, predicted = sequenceIdentity(d,wallet.owner,ownerNonce)
    equal(await call(c,d.factory,'predictVault',[wallet.owner,ownerNonce]),predicted.vault)
    if (hex(await c.rpc('eth_getCode',[predicted.vault,c.block])) !== '0x') fail('sequence_already_exists')
    return { tokenId, key, poolId, lower, upper, ownerNonce, ...predicted, approved: String(await call(c,d.positionManager,'getApproved',[tokenId])).toLowerCase() as Address }
  }
  function options(o: SequenceOptions) {
    if (o.automationMode !== 'compound' && o.automationMode !== 'domino') fail('invalid_sequence_policy')
    if (o.automationMode === 'compound' && o.maxPositions !== 1) fail('simple_compound_position_limit')
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
    inspectRoot: (id: bigint) => bounded(async c => { await verify(c); const result = await root(c,id); await canonical(c); return result }, true, id),
    inspect: (vault: Address) => bounded(async c => { await verify(c,true); const result = await owned(c,vault); await canonical(c); return result }),
    recent: () => bounded(async c => {
      await verify(c,now() >= d.expiresAt); const nonce = await call(c,d.factory,'nextOwnerNonce',[wallet.owner]) as bigint
      const rows: { vault: Address; sequenceId: Hex; ownerNonce: bigint }[] = []
      for (let n = nonce; n > 0n && n > nonce - 8n; n--) { const found = sequenceIdentity(d,wallet.owner,n-1n); equal(await call(c,d.factory,'vaultForSequence',[found.id]),found.vault); rows.push({vault:found.vault,sequenceId:found.id,ownerNonce:n-1n}) }
      await canonical(c); return rows
    }, true, null),
    /** Read-only, for tracking: the sequences `recent` lists, each with its root NFT, checked only as recovery checks a deployment. Prepares nothing. */
    sequences: () => bounded(async c => {
      await verify(c,true); const nonce = await call(c,d.factory,'nextOwnerNonce',[wallet.owner]) as bigint
      const rows: OwnedSequence[] = []
      for (let n = nonce; n > 0n && n > nonce - BigInt(SEQUENCE_LIST_LIMIT); n--) {
        const found = sequenceIdentity(d,wallet.owner,n-1n); equal(await call(c,d.factory,'vaultForSequence',[found.id]),found.vault)
        rows.push({vault:found.vault,sequenceId:found.id,ownerNonce:n-1n,rootTokenId:await call(c,found.vault,'rootTokenId') as bigint})
      }
      await canonical(c); return { rows, older: nonce > BigInt(SEQUENCE_LIST_LIMIT) }
    }),
    /**
     * Read-only, for tracking: the complete active NFT set of a sequence this
     * wallet owns, in the order the vault registered it: the root, then each
     * successor still held. Every successor is walked from the root, and the
     * count must equal the vault's own `activePositions`. Prepares nothing.
     */
    members: (vault: Address) => bounded(async c => {
      await verify(c,true); const s = await owned(c,vault)
      const root = await call(c,vault,'position',[s.rootTokenId])
      if (!root.known || !root.active || !root.isRoot) fail('invalid_position_identity')
      const tokenIds = [s.rootTokenId]
      for (let parent = s.rootTokenId, steps = 0; ; steps++) {
        const next = await call(c,vault,'successorOf',[parent]) as bigint
        if (next === 0n) break
        if (steps >= SEQUENCE_MEMBER_STEPS) fail('sequence_members_unbounded')
        const p = await call(c,vault,'position',[next])
        if (!p.known || p.isRoot || p.parentTokenId !== parent) fail('invalid_position_identity')
        if (p.active) tokenIds.push(next)
        parent = next
      }
      if (await call(c,vault,'activePositions') !== BigInt(tokenIds.length)) fail('sequence_members_incomplete')
      await canonical(c); return { vault, rootTokenId: s.rootTokenId, tokenIds }
    }),
    create: (supplied: SequenceOptions, gas: GasBudget) => bounded(async c => {
      const o = Object.freeze({...supplied}); options(o); await verify(c); const r = await root(c,o.rootTokenId)
      const policy = {serviceFeeBps:AUTOMATION_FEE_BPS[o.automationMode],triggerDistanceBps:o.triggerDistanceBps,maxOverlapBps:o.maxOverlapBps,minimumIntervalSeconds:o.minimumIntervalSeconds,maxPositions:o.maxPositions,version:1n,paused:true}
      const limits = {version:1n,upsideBps:o.upsideBps,maxSlippageBps:o.maxSlippageBps,maxPriceImpactBps:o.maxPriceImpactBps,maxGasCostWei:o.maxGasCostWei,maxObservationAgeSeconds:o.maxObservationAgeSeconds,forecastHorizonSeconds:o.forecastHorizonSeconds}
      const params = {rootTokenId:o.rootTokenId,expectedPoolId:r.poolId,baseCurrency:o.baseIsCurrency0?r.key.currency0:r.key.currency1,quoteCurrency:o.baseIsCurrency0?r.key.currency1:r.key.currency0,operator:d.operator,consentToUncollectedFees:true,policy,limits}
      const approval = r.approved !== r.vault
      const guard = async (next: Context) => { await verify(next); const current = await root(next,o.rootTokenId); if (current.ownerNonce !== r.ownerNonce || current.poolId !== r.poolId || current.lower !== r.lower || current.upper !== r.upper) fail('sequence_preparation_changed'); if (!approval && current.approved !== r.vault) fail('root_approval_changed') }
      return prepare(c,approval?'approve-root':'create',r.vault,approval?d.positionManager:d.factory,approval?encode('approve',[r.vault,o.rootTokenId]):encode('createVault',[params,r.ownerNonce]),gas,
        [approval?`Approve only NFT #${o.rootTokenId} to the predicted sequence. No approval for all NFTs.`:`Create a paused sequence from NFT #${o.rootTokenId}.`,
          'Your root NFT stays in your wallet. This does not start automation.',`Pool: ${r.poolId}. Range: ${r.lower} to ${r.upper}.`,
          `Base: ${params.baseCurrency}. Quote: ${params.quoteCurrency}.`,`Operator: ${d.operator}. Fee recipient: ${d.serviceFeeRecipient}.`,
          `${o.automationMode === 'domino' ? 'Domino-compound' : 'Auto-compound'}: ${feeDescription(policy.serviceFeeBps)} Includes already uncollected fees with your consent.`,
          `Trigger distance: ${o.triggerDistanceBps} bps; maximum overlap: ${o.maxOverlapBps} bps; minimum interval: ${o.minimumIntervalSeconds}s; maximum positions: ${o.maxPositions}.`,
          `Successor upside: ${o.upsideBps} bps; maximum slippage: ${o.maxSlippageBps} bps; maximum price impact: ${o.maxPriceImpactBps} bps.`,
          `Execution gas cost cap: ${o.maxGasCostWei} wei; observation age: ${o.maxObservationAgeSeconds}s; forecast horizon: ${o.forecastHorizonSeconds}s.`],guard)
    }),
    resume: (vault: Address, gas: GasBudget) => bounded(async c => {
      async function activeProfile(next: Context) {
        await verify(next); const state=await owned(next,vault)
        if (!state.paused || !state.rootPermissionValid || state.operator !== d.operator) fail('sequence_activation_unavailable')
        const policy=await call(next,vault,'policy'), limits=await call(next,vault,'executionLimits')
        if (automationModeForFee(policy.serviceFeeBps) === null) fail('sequence_tariff_changed')
        if (policy.serviceFeeBps === d.serviceFeeBps && policy.maxPositions !== 1) fail('simple_compound_position_limit')
        return {state,policy,limits}
      }
      const before=await activeProfile(c), {state,policy,limits}=before
      return prepare(c,'resume',vault,vault,encode('resume'),gas,[
        `Activate execution for root NFT #${state.rootTokenId} with operator ${state.operator}.`,
        `Base: ${state.baseCurrency}. Quote: ${state.quoteCurrency}. The root NFT remains in your wallet.`,
        `${automationModeForFee(policy.serviceFeeBps) === 'domino' ? 'Domino-compound' : 'Auto-compound'}: ${feeDescription(policy.serviceFeeBps)} Includes already uncollected fees previously consented to.`,
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
    /**
     * Authorise the deployment's operator again for a sequence whose operator
     * was revoked.
     *
     * `revokeOperator` sets the operator to the zero address, and `resume`
     * requires the configured one, so without this a person who revokes from
     * this product can never enable automation from it again. The address is
     * never asked for: it is `d.operator`, the same operator the sequence was
     * created with, which the deployment check already proved is an externally
     * owned account, distinct from every component and from the owner. An
     * operator that is some other non-zero address is refused rather than
     * replaced — silently swapping who may execute is not a restoration.
     *
     * It grants authority and nothing else: a paused sequence stays paused,
     * and Resume remains a separate, reviewed step.
     */
    /**
     * Change the automation rules, or the safety limits, on a sequence the
     * person owns. Both are onlyOwner on chain and neither had a way in from
     * this product: the four policy fields and the six limits were chosen once
     * at creation and could never be changed, so a sequence that reached its
     * own maxPositions had no way forward except being abandoned.
     *
     * Each sends a WHOLE struct, because the contract takes a whole one. Only
     * the fields a person chose come from the form; the rest is re-read from
     * the live vault and sent back unchanged:
     *
     *   version        exactly current + 1, which the contract demands
     *   paused         unchanged — flipping it here is refused
     *                  (PauseChangeRequiresTransition); pause and resume stay
     *                  their own reviewed steps
     *   serviceFeeBps  preserves the current mode unless an explicit new mode is
     *                  selected and reviewed. Already charged lots stay charged.
     *
     * The bounds are the contract's own, checked here first so a refusal reads
     * as words rather than as a reverted transaction.
     */
    setPolicy: (vault: Address, next: {automationMode?:AutomationMode;triggerDistanceBps:number;maxOverlapBps:number;minimumIntervalSeconds:number;maxPositions:number}, gas: GasBudget) => bounded(async c => {
      const o = Object.freeze({...next})
      if (o.automationMode !== undefined && o.automationMode !== 'compound' && o.automationMode !== 'domino') fail('invalid_sequence_policy')
      integer(o.triggerDistanceBps,0,2000); integer(o.maxOverlapBps,0,2000); integer(o.minimumIntervalSeconds,1,2**32-1); integer(o.maxPositions,1,255)
      async function check(at: Context) {
        await verify(at); const state = await owned(at,vault)
        const current = await call(at,vault,'policy'), members = await call(at,vault,'activePositions') as bigint
        if (current.version === 0n || current.version >= 2n**64n-1n) fail('policy_version_exhausted')
        if (BigInt(o.maxPositions) < members) fail('position_limit_below_membership')
        const mode = o.automationMode ?? automationModeForFee(current.serviceFeeBps)
        if (mode !== 'compound' && mode !== 'domino') fail('invalid_sequence_policy')
        if (mode === 'compound' && (o.maxPositions !== 1 || members !== 1n)) fail('simple_compound_position_limit')
        return { state, current, members, mode: mode as AutomationMode }
      }
      const s = await check(c)
      const policy = {serviceFeeBps:AUTOMATION_FEE_BPS[s.mode],triggerDistanceBps:o.triggerDistanceBps,maxOverlapBps:o.maxOverlapBps,
        minimumIntervalSeconds:o.minimumIntervalSeconds,maxPositions:o.maxPositions,version:s.current.version+1n,paused:s.current.paused}
      return prepare(c,'set-policy',vault,vault,encode('setPolicy',[policy]),gas,[
        `Change the automation rules for root NFT #${s.state.rootTokenId}.`,
        `Service fee: ${feeDescription(s.current.serviceFeeBps)} New ${s.mode === 'domino' ? 'Domino-compound' : 'Auto-compound'} policy: ${feeDescription(policy.serviceFeeBps)}`,
        `Trigger distance ${s.current.triggerDistanceBps} to ${policy.triggerDistanceBps} bps; maximum overlap ${s.current.maxOverlapBps} to ${policy.maxOverlapBps} bps; minimum interval ${s.current.minimumIntervalSeconds} to ${policy.minimumIntervalSeconds}s; maximum positions ${s.current.maxPositions} to ${policy.maxPositions}, with ${s.members} registered now.`,
        `Policy version ${s.current.version} to ${policy.version}. The paused state is unchanged: ${policy.paused?'this sequence stays paused':'this sequence stays active'}, and pausing or resuming is its own step.`,
        'Owner transaction: no Domino service fee. Network gas still applies.',
      ],async at => {
        const again = await check(at)
        if (again.state.stateNonce !== s.state.stateNonce || again.current.version !== s.current.version) fail('sequence_preparation_changed')
      })
    }),
    setExecutionLimits: (vault: Address, next: {upsideBps:number;maxSlippageBps:number;maxPriceImpactBps:number;maxGasCostWei:bigint;maxObservationAgeSeconds:number;forecastHorizonSeconds:number}, gas: GasBudget) => bounded(async c => {
      const o = Object.freeze({...next})
      integer(o.upsideBps,1,1_000_000); integer(o.maxSlippageBps,0,9999); integer(o.maxPriceImpactBps,0,9999)
      if (uint(o.maxGasCostWei) === 0n) fail('invalid_sequence_policy')
      integer(o.maxObservationAgeSeconds,1,2**32-1); integer(o.forecastHorizonSeconds,1,2**32-1)
      async function check(at: Context) {
        await verify(at); const state = await owned(at,vault)
        const current = await call(at,vault,'executionLimits')
        if (current.version >= 2n**64n-1n) fail('limits_version_exhausted')
        return { state, current }
      }
      const s = await check(c)
      const limits = {version:s.current.version+1n,upsideBps:o.upsideBps,maxSlippageBps:o.maxSlippageBps,maxPriceImpactBps:o.maxPriceImpactBps,
        maxGasCostWei:o.maxGasCostWei,maxObservationAgeSeconds:o.maxObservationAgeSeconds,forecastHorizonSeconds:o.forecastHorizonSeconds}
      return prepare(c,'set-limits',vault,vault,encode('setExecutionLimits',[limits]),gas,[
        `Change the safety limits for root NFT #${s.state.rootTokenId}.`,
        `Successor upside ${s.current.upsideBps} to ${limits.upsideBps} bps; maximum slippage ${s.current.maxSlippageBps} to ${limits.maxSlippageBps} bps; maximum price impact ${s.current.maxPriceImpactBps} to ${limits.maxPriceImpactBps} bps.`,
        `Maximum execution gas cost ${s.current.maxGasCostWei} to ${limits.maxGasCostWei} wei; maximum observation age ${s.current.maxObservationAgeSeconds} to ${limits.maxObservationAgeSeconds}s; forecast horizon ${s.current.forecastHorizonSeconds} to ${limits.forecastHorizonSeconds}s.`,
        `Limits version ${s.current.version} to ${limits.version}. These bound every automated run; they do not move the position.`,
        'Owner transaction: no Domino service fee. Network gas still applies.',
      ],async at => {
        const again = await check(at)
        if (again.state.stateNonce !== s.state.stateNonce || again.current.version !== s.current.version) fail('sequence_preparation_changed')
      })
    }),
    restoreOperator: (vault: Address, gas: GasBudget) => bounded(async c => {
      async function check(next: Context) {
        await verify(next); const state = await owned(next,vault)
        if (state.operator !== zeroAddress) fail(state.operator === d.operator ? 'operator_already_set' : 'operator_not_revoked')
        return state
      }
      const s = await check(c)
      return prepare(c,'restore-operator',vault,vault,encode('setOperator',[d.operator]),gas,[
        `Authorise operator ${d.operator} to execute for root NFT #${s.rootTokenId} again.`,
        'The root NFT stays in your wallet, and your policy and limits are unchanged.',
        s.paused ? 'This sequence stays paused: Resume is a separate step you review and sign.' : 'Execution becomes possible again once this is signed.',
        'Owner transaction: no Domino service fee. Network gas still applies.',
      ],async next => {
        const current = await check(next)
        if (current.stateNonce !== s.stateNonce) fail('sequence_preparation_changed')
      })
    }),
    recover: (vault: Address, action: 'pause'|'revoke-operator'|'revoke-root'|'withdraw-child'|'withdraw-fees'|'rearm-root'|'recover-position'|'recover-currency', gas: GasBudget, values: {tokenId?:bigint;sourceId?:Hex;currency?:Address;original?:bigint;charged?:bigint;amount?:bigint} = {}) => bounded(async c => {
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
        // Re-arming consents to whatever fees the root has not collected, so it
        // is offered only where it is the repair it claims to be: a sequence
        // whose permission over the root has lapsed.
        if (action === 'rearm-root') {
          if (state.rootPermissionValid) fail('root_permission_valid')
          await code(next,'positionManager'); equal(await call(next,d.positionManager,'ownerOf',[state.rootTokenId]),wallet.owner)
        }
        // A stray NFT, not a member. An ACTIVE child is not stray — that one
        // leaves through withdrawChildPosition, which keeps the ledger straight.
        if (action === 'recover-position') {
          if (v.tokenId === undefined || uint(v.tokenId,256) === 0n) fail('invalid_position')
          await code(next,'positionManager'); equal(await call(next,d.positionManager,'ownerOf',[v.tokenId]),vault)
          const p = await call(next,vault,'position',[v.tokenId])
          if (p.active && !p.isRoot) fail('position_is_managed')
        }
        if (action === 'recover-currency') {
          if (!v.currency || !addressPattern.test(v.currency) || ![state.baseCurrency,state.quoteCurrency,zeroAddress].includes(v.currency)) fail('invalid_currency')
          if (v.amount === undefined || uint(v.amount,256) === 0n) fail('invalid_amount')
        }
        if (action === 'withdraw-fees') {
          if (!v.sourceId || !hashPattern.test(v.sourceId) || !v.currency || !addressPattern.test(v.currency) || ![state.baseCurrency,state.quoteCurrency].includes(v.currency) || v.original === undefined || v.charged === undefined || uint(v.original)+uint(v.charged) === 0n) fail('invalid_fee_withdrawal')
          const source = await call(next,vault,'source',[v.sourceId]), balance = await call(next,vault,'feeBalance',[v.sourceId,v.currency])
          if (!source.known || v.original! > balance.original || v.charged! > balance.charged) fail('fee_reserve_insufficient')
        }
        return state
      }
      const s = await check(c)
      const NAMES = { 'pause':'pause', 'revoke-operator':'revokeOperator', 'revoke-root':'approve', 'withdraw-child':'withdrawChildPosition',
        'withdraw-fees':'withdrawFeeReserves', 'rearm-root':'rearmRoot', 'recover-position':'recoverUnmanagedPosition', 'recover-currency':'recoverUntrackedCurrency' } as const
      const name = NAMES[action]
      const args = action === 'revoke-root'?[zeroAddress,s.rootTokenId]:action === 'withdraw-child'||action === 'recover-position'?[v.tokenId]
        :action === 'withdraw-fees'?[v.sourceId,v.currency,v.original,v.charged]:action === 'rearm-root'?[true]
        :action === 'recover-currency'?[v.currency,v.amount]:[]
      // What the books already account for, so the sentence can say what is NOT free.
      const accounted = action === 'recover-currency'
        ? decodeFunctionResult({ abi: reserveAbi as Abi, functionName: 'accountedCurrency',
            data: hex(await c.rpc('eth_call', [{ to: vault, data: encodeFunctionData({ abi: reserveAbi as Abi, functionName: 'accountedCurrency', args: [v.currency] }) }, c.block])) }) as bigint
        : 0n
      const DETAILS: Record<typeof action, string> = {
        'pause': 'Pause future execution.',
        'revoke-operator': 'Remove the operator’s execution authority.',
        'revoke-root': `Revoke only the sequence approval for root NFT #${s.rootTokenId}.`,
        'withdraw-child': `Return child NFT #${v.tokenId} to your wallet.`,
        'withdraw-fees': `Return ${v.original} original + ${v.charged} already charged fee units of ${v.currency}, source ${v.sourceId}, to your wallet.`,
        'rearm-root': `Re-establish this sequence’s permission over root NFT #${s.rootTokenId}. Fees the root has not collected are consented to as part of it, exactly as at creation.`,
        'recover-position': `Return NFT #${v.tokenId}, which this sequence holds but does not manage, to your wallet.`,
        'recover-currency': `Return ${v.amount} raw units of ${v.currency} to your wallet. The sequence’s books account for ${accounted} units of it; only what is held above that can leave this way, and the contract refuses anything more.`,
      }
      const detail = DETAILS[action]
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
      // Identity is exact: hash, from, to, calldata, nonce, value, chain and
      // type are what was reviewed, byte for byte, and the receipt names the
      // same block as the transaction. Any of these is a different step.
      for (const [actual,wanted] of [[r.transactionHash,hash],[tx.hash,hash],[tx.from,expected.owner],[tx.to,expected.transaction.to],[tx.input,expected.transaction.data],[r.from,expected.owner],[r.to,expected.transaction.to]]) {
        if (String(actual).toLowerCase() !== String(wanted).toLowerCase()) fail('receipt_identity_changed')
      }
      if (quantity(tx.nonce) !== BigInt(expected.transaction.nonce) || quantity(tx.value) !== 0n || quantity(tx.chainId) !== 4663n || quantity(tx.type) !== 2n
        || tx.blockHash !== r.blockHash || tx.blockNumber !== r.blockNumber) fail('receipt_identity_changed')
      // The gas fields are the wallet's to reshape (Rabby does), so they are
      // held to the budget the review approved rather than to its exact
      // figures: gas × maxFeePerGas as reviewed. The transaction as included,
      // and what the receipt says it cost, must both fit under it.
      const approved = BigInt(expected.transaction.gas) * BigInt(expected.transaction.maxFeePerGas), maxFee = quantity(tx.maxFeePerGas)
      if (r.gasUsed === undefined || r.gasUsed === null || r.effectiveGasPrice === undefined || r.effectiveGasPrice === null) fail('invalid_receipt')
      const withinBudget = quantity(tx.gas) * maxFee <= approved && quantity(tx.maxPriorityFeePerGas) <= maxFee && quantity(r.gasUsed) * quantity(r.effectiveGasPrice) <= approved
      const block = record(await c.rpc('eth_getBlockByNumber',[r.blockNumber,false]))
      if (block.hash !== r.blockHash) return {state:'reorged' as const}
      const status = quantity(r.status); if (status !== 0n && status !== 1n) fail('invalid_receipt')
      if (status === 0n) return {state:'reverted' as const}
      // Included and successful, but past the budget: nothing to send again,
      // and not a revert. Said as its own state so the screen can say so.
      const finalized = record(await c.rpc('eth_getBlockByNumber',['finalized',false]))
      const isFinal = quantity(finalized.number) >= quantity(r.blockNumber)
      if (!withinBudget) return {state:isFinal?'over_budget_finalized' as const:'over_budget' as const}
      return {state:isFinal?'finalized' as const:'confirming' as const}
    }),
  }
}
