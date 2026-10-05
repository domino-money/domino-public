import { encodeAbiParameters, hashStruct, hashTypedData, keccak256, recoverTypedDataAddress, type TypedDataDefinition } from 'viem'
import { V2_CHAINS } from '../../v2/chains'
import type { Address, ExitMandate, Hex, PermitBatch, PositionIntent, RelayedPositionAction, SwapLeg, V2ChainId } from '../../v2/types'
import { refuseUnlessLive } from './liveLock'

/**
 * Domino V2's EIP-712 typed data, and the one place in the app that asks a wallet to sign any (spec F7 §1.8, §2.5, §4.2).
 *
 * Three things are ever signed, each exactly as api-contracts/v2/eip712.json and eip712-goldens.json define them:
 *   - Permit2's `PermitBatchWitnessTransferFrom` with the `PositionIntent` as its witness (create and increase in one
 *     signature). Permit2's domain has NO `version`.
 *   - `RelayedPositionAction` (a relayed change of range or exit), in the `Domino`/`2` domain with the zap as verifier.
 *   - `ExitMandate` (an auto-exit order), in the `Domino`/`2` domain with the auto-exit module as verifier.
 * The `PositionIntent` digest (the zap's `intentHash`) is never signed alone; it is what every zap event carries, and
 * what a receipt is matched to its plan by.
 *
 * Every domain carries the chain id: a signature made for one chain is refused on another. The signer re-reads the
 * wallet's account and chain immediately before it asks, and checks what came back recovers to the owner before
 * anything is done with it.
 *
 * This is the only module that names `eth_signTypedData_v4` (tests/session.source-guard.test.mjs).
 */

export type TypedField = { readonly name: string; readonly type: string }

export const POOL_REF_TYPE: readonly TypedField[] = [
  { name: 'dex', type: 'uint8' },
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
]
export const POSITION_INTENT_TYPE: readonly TypedField[] = [
  { name: 'action', type: 'uint8' },
  { name: 'pool', type: 'PoolRef' },
  { name: 'tokenId', type: 'uint256' },
  { name: 'tickLower', type: 'int24' },
  { name: 'tickUpper', type: 'int24' },
  { name: 'minLiquidity', type: 'uint128' },
  { name: 'feeBps', type: 'uint16' },
  { name: 'feeToken', type: 'address' },
  { name: 'routesHash', type: 'bytes32' },
  { name: 'recipient', type: 'address' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint64' },
]
export const TOKEN_PERMISSIONS_TYPE: readonly TypedField[] = [
  { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint256' },
]
export const PERMIT_BATCH_WITNESS_TYPE: readonly TypedField[] = [
  { name: 'permitted', type: 'TokenPermissions[]' },
  { name: 'spender', type: 'address' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
  { name: 'witness', type: 'PositionIntent' },
]
export const RELAYED_POSITION_ACTION_TYPE: readonly TypedField[] = [
  { name: 'intent', type: 'PositionIntent' },
  { name: 'liquidityToRemove', type: 'uint128' },
  { name: 'amount0MinRemoved', type: 'uint128' },
  { name: 'amount1MinRemoved', type: 'uint128' },
  { name: 'amount0Max', type: 'uint128' },
  { name: 'amount1Max', type: 'uint128' },
  { name: 'burn', type: 'bool' },
]
export const EXIT_MANDATE_TYPE: readonly TypedField[] = [
  { name: 'owner', type: 'address' },
  { name: 'vault', type: 'address' },
  { name: 'tokenId', type: 'uint256' },
  { name: 'triggerBelowSqrtPriceX96', type: 'uint160' },
  { name: 'triggerAboveSqrtPriceX96', type: 'uint160' },
  { name: 'receiveMode', type: 'uint8' },
  { name: 'convertTo', type: 'address' },
  { name: 'maxSlippageBps', type: 'uint16' },
  { name: 'validUntil', type: 'uint64' },
  { name: 'nonce', type: 'uint256' },
]
const DOMINO_DOMAIN_TYPE: readonly TypedField[] = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
]
/** Permit2's domain: no `version` (spec §2.5.2; eip712.json permit2.domain). */
const PERMIT2_DOMAIN_TYPE: readonly TypedField[] = [
  { name: 'name', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
]

/** The canonical Permit2 (the same address on every V2 chain's profile). */
export const PERMIT2: Address = '0x000000000022d473030f116ddee9f6b43ac78ba3'

/** `SwapLeg[]` as `abi.encode` lays it out: `(uint8,address,address,address,uint128,uint128,bytes)[]`. */
export const SWAP_LEGS_PARAMETERS = [{
  type: 'tuple[]',
  components: [
    { name: 'kind', type: 'uint8' },
    { name: 'router', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint128' },
    { name: 'minAmountOut', type: 'uint128' },
    { name: 'data', type: 'bytes' },
  ],
}] as const

/** `routesHash` of a plan with no legs. */
export const NO_LEGS_ROUTES_HASH: Hex = '0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd'

/** `keccak256(abi.encode(SwapLeg[] legs))`: what the intent signs in place of the legs (spec §2.3). */
export function routesHash(legs: readonly SwapLeg[]): Hex {
  return keccak256(encodeAbiParameters(SWAP_LEGS_PARAMETERS, [legs.map((leg) => ({ ...leg }))]))
}

/** A typed data object exactly as it is hashed and as `eth_signTypedData_v4` carries it, EIP712Domain included. */
export interface V2TypedData {
  types: Readonly<Record<string, readonly TypedField[]>>
  primaryType: 'PermitBatchWitnessTransferFrom' | 'RelayedPositionAction' | 'ExitMandate' | 'PositionIntent'
  domain: { name: 'Permit2' | 'Domino'; version?: '2'; chainId: number; verifyingContract: Address }
  message: Record<string, unknown>
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const fail = (code: string): never => { throw new Error(code) }
const address = (value: string, what: string): Address => (ADDRESS.test(value) ? (value.toLowerCase() as Address) : fail(`invalid_typed_data: ${what}`))
const isV2Chain = (chainId: number): chainId is V2ChainId => V2_CHAINS.some((chain) => chain.chainId === chainId)

function dominoDomain(chainId: number, verifyingContract: Address): V2TypedData['domain'] {
  return { name: 'Domino', version: '2', chainId, verifyingContract: address(verifyingContract, 'verifyingContract') }
}

/** A plain copy of the intent for hashing and the wire: integers stay bigint or number as their Solidity width allows. */
function intentMessage(intent: PositionIntent): Record<string, unknown> {
  return {
    action: intent.action,
    pool: {
      dex: intent.pool.dex,
      currency0: address(intent.pool.currency0, 'currency0'),
      currency1: address(intent.pool.currency1, 'currency1'),
      fee: intent.pool.fee,
      tickSpacing: intent.pool.tickSpacing,
      hooks: address(intent.pool.hooks, 'hooks'),
    },
    tokenId: intent.tokenId,
    tickLower: intent.tickLower,
    tickUpper: intent.tickUpper,
    minLiquidity: intent.minLiquidity,
    feeBps: intent.feeBps,
    feeToken: address(intent.feeToken, 'feeToken'),
    routesHash: intent.routesHash.toLowerCase(),
    recipient: address(intent.recipient, 'recipient'),
    nonce: intent.nonce,
    deadline: intent.deadline,
  }
}

/** The intent alone, in the zap's domain: its digest is the `intentHash` every zap event and `FeeCharged.ref` carry. */
export function intentTypedData(chainId: number, zap: Address, intent: PositionIntent): V2TypedData {
  return {
    types: { EIP712Domain: DOMINO_DOMAIN_TYPE, PositionIntent: POSITION_INTENT_TYPE, PoolRef: POOL_REF_TYPE },
    primaryType: 'PositionIntent',
    domain: dominoDomain(chainId, zap),
    message: intentMessage(intent),
  }
}

/**
 * Permit2's batch witness transfer, the plan's intent as its witness (createWithPermit, increaseWithPermit). The
 * spender is the zap; the permit's nonce and deadline are the intent's (checked by ./plan.ts before this is built).
 */
export function permit2WitnessTypedData(chainId: number, spender: Address, permit: PermitBatch, witness: PositionIntent): V2TypedData {
  return {
    types: {
      EIP712Domain: PERMIT2_DOMAIN_TYPE,
      PermitBatchWitnessTransferFrom: PERMIT_BATCH_WITNESS_TYPE,
      TokenPermissions: TOKEN_PERMISSIONS_TYPE,
      PositionIntent: POSITION_INTENT_TYPE,
      PoolRef: POOL_REF_TYPE,
    },
    primaryType: 'PermitBatchWitnessTransferFrom',
    domain: { name: 'Permit2', chainId, verifyingContract: PERMIT2 },
    message: {
      permitted: permit.permitted.map((p) => ({ token: address(p.token, 'permitted token'), amount: p.amount })),
      spender: address(spender, 'spender'),
      nonce: permit.nonce,
      deadline: permit.deadline,
      witness: intentMessage(witness),
    },
  }
}

/** What the NFT's owner signs for a relayed change of range or exit, in the zap's domain (spec §2.5.3). */
export function relayedActionTypedData(chainId: number, zap: Address, action: RelayedPositionAction): V2TypedData {
  return {
    types: {
      EIP712Domain: DOMINO_DOMAIN_TYPE,
      RelayedPositionAction: RELAYED_POSITION_ACTION_TYPE,
      PositionIntent: POSITION_INTENT_TYPE,
      PoolRef: POOL_REF_TYPE,
    },
    primaryType: 'RelayedPositionAction',
    domain: dominoDomain(chainId, zap),
    message: {
      intent: intentMessage(action.intent),
      liquidityToRemove: action.liquidityToRemove,
      amount0MinRemoved: action.amount0MinRemoved,
      amount1MinRemoved: action.amount1MinRemoved,
      amount0Max: action.amount0Max,
      amount1Max: action.amount1Max,
      burn: action.burn,
    },
  }
}

function mandateMessage(mandate: ExitMandate): Record<string, unknown> {
  return {
    owner: address(mandate.owner, 'owner'),
    vault: address(mandate.vault, 'vault'),
    tokenId: mandate.tokenId,
    triggerBelowSqrtPriceX96: mandate.triggerBelowSqrtPriceX96,
    triggerAboveSqrtPriceX96: mandate.triggerAboveSqrtPriceX96,
    receiveMode: mandate.receiveMode,
    convertTo: address(mandate.convertTo, 'convertTo'),
    maxSlippageBps: mandate.maxSlippageBps,
    validUntil: mandate.validUntil,
    nonce: mandate.nonce,
  }
}

/** An auto-exit order, in the auto-exit module's domain (spec §4.2). */
export function exitMandateTypedData(chainId: number, autoExit: Address, mandate: ExitMandate): V2TypedData {
  return {
    types: { EIP712Domain: DOMINO_DOMAIN_TYPE, ExitMandate: EXIT_MANDATE_TYPE },
    primaryType: 'ExitMandate',
    domain: dominoDomain(chainId, autoExit),
    message: mandateMessage(mandate),
  }
}

/** viem's view of a V2TypedData: EIP712Domain left for viem to derive from the domain's own fields, as it must match. */
function definition(typed: V2TypedData): TypedDataDefinition {
  const { EIP712Domain: _domain, ...types } = typed.types
  void _domain
  return { domain: typed.domain, types: types as TypedDataDefinition['types'], primaryType: typed.primaryType, message: typed.message } as TypedDataDefinition
}

/** The EIP-712 digest a wallet signs for this typed data. */
export function typedDataDigest(typed: V2TypedData): Hex {
  const types = typed.types.EIP712Domain
  const expected = typed.domain.name === 'Permit2' ? PERMIT2_DOMAIN_TYPE : DOMINO_DOMAIN_TYPE
  if (types !== expected) return fail('invalid_typed_data: domain')
  return hashTypedData(definition(typed))
}

/** The zap's `intentHash`: the intent's digest in the zap's domain on its chain. */
export function intentHash(chainId: number, zap: Address, intent: PositionIntent): Hex {
  return typedDataDigest(intentTypedData(chainId, zap, intent))
}

/**
 * A mandate's id: its EIP-712 STRUCT hash (`hashExitMandate`), not its digest. It is the argument of `mandateStatus`,
 * `mandateOf` and `revokeMandate` (spec §4.2).
 */
export function mandateId(mandate: ExitMandate): Hex {
  return hashStruct({ data: mandateMessage(mandate), primaryType: 'ExitMandate', types: { ExitMandate: EXIT_MANDATE_TYPE } as unknown as Record<string, { name: string; type: string }[]> })
}

/** The typed data as JSON for `eth_signTypedData_v4`: every bigint as its decimal string, every address lowercase. */
export function wireTypedData(typed: V2TypedData): string {
  return JSON.stringify(typed, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString(10) : value))
}

// ---------------------------------------------------------------------------
// The signer
// ---------------------------------------------------------------------------

/** The wallet's side of a signature: its provider, its owner, and whether it is still the one the review was made for. */
export interface TypedDataWallet {
  owner: Address
  current(): boolean
  request(method: string, params: unknown[]): Promise<unknown>
}

/**
 * - `ecdsa-low-s`: 65 bytes, `s` in the lower half (EIP-2), recovering to the owner. The zap's relayed path and the
 *   auto-exit module's ECDSA branch require it.
 * - `ecdsa`: 65 bytes recovering to the owner. Permit2 verifies an EOA's signature with ecrecover.
 * - `contract`: an account with code (EIP-1271): any non-empty signature, verified by the account on chain.
 */
export type SignatureShape = 'ecdsa-low-s' | 'ecdsa' | 'contract'

export interface SignedTypedData {
  chainId: V2ChainId
  signer: Address
  digest: Hex
  signature: Hex
}

const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n
const SIGNATURE_65 = /^0x[0-9a-fA-F]{130}$/

/**
 * Asks the connected wallet to sign one V2 typed data, once. Refuses before asking when the typed data names another
 * chain or another signer than the wallet's owner, or names a chain V2 does not serve; re-reads the wallet's account and
 * chain immediately before the prompt (spec §1.3). What comes back is checked against the owner (recovered locally for
 * an ECDSA shape) before it is returned. A 4001 is the wallet's refusal and is thrown as the wallet threw it.
 */
export async function signV2TypedData(wallet: TypedDataWallet, typed: V2TypedData, expect: { chainId: V2ChainId; signer: Address; shape: SignatureShape }): Promise<SignedTypedData> {
  // Changed on purpose (data) 2026-10-02 (Domino V2 integration): the backstop of every V2 signature (./liveLock.ts): none on
  // a chain whose contracts are not live, before any wallet request. Each caller checked its own set first.
  refuseUnlessLive(expect.chainId, null)
  if (!isV2Chain(expect.chainId) || typed.domain.chainId !== expect.chainId) return fail('typed_data_chain_mismatch')
  const owner = wallet.owner.toLowerCase() as Address
  if (expect.signer.toLowerCase() !== owner) return fail('typed_data_signer_mismatch')
  if (typed.primaryType === 'PositionIntent') return fail('typed_data_not_signable')
  const digest = typedDataDigest(typed)
  if (!wallet.current()) return fail('wallet_identity_changed')
  const [accounts, chain] = [await wallet.request('eth_accounts', []), await wallet.request('eth_chainId', [])]
  if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== owner) return fail('wallet_identity_changed')
  if (typeof chain !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(chain) || BigInt(chain) !== BigInt(expect.chainId)) return fail('wallet_wrong_chain')
  if (!wallet.current()) return fail('wallet_identity_changed')
  const reply = await wallet.request('eth_signTypedData_v4', [owner, wireTypedData(typed)])
  if (!wallet.current()) return fail('wallet_identity_changed')
  if (typeof reply !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(reply)) return fail('invalid_signature')
  let signature = reply.toLowerCase() as Hex
  if (expect.shape !== 'contract') {
    if (!SIGNATURE_65.test(signature)) return fail('invalid_signature')
    const s = BigInt(`0x${signature.slice(66, 130)}`)
    let v = Number.parseInt(signature.slice(130, 132), 16)
    // Some wallets write the recovery id as 0/1; the contracts' ecrecover takes 27/28. The same signature either way.
    if (v === 0 || v === 1) v += 27
    if (v !== 27 && v !== 28) return fail('invalid_signature')
    if (expect.shape === 'ecdsa-low-s' && s > SECP256K1_HALF_N) return fail('signature_high_s')
    signature = `${signature.slice(0, 130)}${v.toString(16)}` as Hex
    const recovered = await recoverTypedDataAddress({ ...definition(typed), signature })
    if (recovered.toLowerCase() !== owner) return fail('signature_not_from_owner')
  }
  return Object.freeze({ chainId: expect.chainId, signer: owner, digest, signature })
}
