import type { Address, Hex } from 'viem'
import { financialFetch } from './http.js'
import { boundedText } from './release.js'

/** This is a trusted local-node observation, not a cryptographic state proof.
 * It never carries calldata or a destination chosen by the browser. */
export interface SequenceSnapshot {
  schemaVersion: 1; contractVersion: '1.0.0-rc.1'; chainId: 4663
  owner: Address; tokenId: string | null; blockNumber: number; blockHash: Hex
  code: Record<string, Hex>; calls: Record<string, Record<string, Hex>>
  recent: { ownerNonce: string; sequenceId: Hex; vault: Address; vaultForSequence: Hex }[]
  root: null | { tokenId: string; ownerOf: Hex; getPoolAndPositionInfo: Hex; getApproved: Hex
    predictVault: Hex; predictedSequenceId: Hex; predictedVault: Address; currency0: Address
    currency1: Address; code: {currency0: Hex; currency1: Hex; predictedVault: Hex} }
}

const roles = ['factory','implementation','poolManager','positionManager','stateView','readHelper','engine','routing','priceGuard']
export const snapshotCalls = {
  factory: ['implementation','implementationCodeHash','poolManager','positionManager','stateView','serviceFeeRecipient','nextOwnerNonce'],
  implementation: ['factory','implementation','implementationVersion','poolManager','positionManager','stateView','serviceFeeRecipient','readHelper','executionEngine','readHelperCodeHash','executionEngineCodeHash','poolManagerCodeHash','positionManagerCodeHash','stateViewCodeHash'],
  positionManager: ['poolManager'], stateView: ['poolManager'], readHelper: ['positionManager','stateView'],
  engine: ['factory','readHelper','routingHelper','priceGuard','readHelperHash','routingHelperHash','priceGuardHash'],
  priceGuard: ['publisher'],
} as const
const obj = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => obj(value) && Object.keys(value).sort().join() === [...keys].sort().join()
const address = (value: unknown): value is Address => typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value)
const hash = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value)
const raw = (value: unknown, max=200_002): value is Hex => typeof value === 'string' && value.length <= max && /^0x(?:[0-9a-f]{2})*$/.test(value)
const decimal = (value: unknown, zero=false): value is string => typeof value === 'string' &&
  (zero ? /^(0|[1-9][0-9]{0,77})$/ : /^[1-9][0-9]{0,77}$/).test(value) && BigInt(value) < 2n ** 256n

export function sequenceSnapshotFrom(value: unknown, owner: Address, tokenId: bigint | null): SequenceSnapshot {
  const wanted = tokenId === null ? null : tokenId.toString()
  if (!exact(value, ['schemaVersion','contractVersion','chainId','owner','tokenId','blockNumber','blockHash','code','calls','recent','root'])
    || value.schemaVersion !== 1 || value.contractVersion !== '1.0.0-rc.1' || value.chainId !== 4663
    || value.owner !== owner || value.tokenId !== wanted || !Number.isSafeInteger(value.blockNumber)
    || (value.blockNumber as number) < 0 || !hash(value.blockHash)
    || !exact(value.code, [...roles,'operator','pricePublisher'])
    || !Object.values(value.code).every(item => raw(item))
    || !exact(value.calls,Object.keys(snapshotCalls))) throw new Error('sequence_read_snapshot_invalid')
  for (const [role, names] of Object.entries(snapshotCalls)) {
    if (!exact(value.calls[role],names) || !Object.values(value.calls[role]).every(item => raw(item,16_386)))
      throw new Error('sequence_read_snapshot_invalid')
  }
  if (!Array.isArray(value.recent) || value.recent.length > 8 || !value.recent.every(row =>
    exact(row,['ownerNonce','sequenceId','vault','vaultForSequence']) && decimal(row.ownerNonce,true)
      && hash(row.sequenceId) && address(row.vault) && raw(row.vaultForSequence,16_386)))
    throw new Error('sequence_read_snapshot_invalid')
  if (wanted === null) {
    if (value.root !== null) throw new Error('sequence_read_snapshot_invalid')
  } else {
    const root = value.root
    if (!exact(root,['tokenId','ownerOf','getPoolAndPositionInfo','getApproved','predictVault',
      'predictedSequenceId','predictedVault','currency0','currency1','code']) || root.tokenId !== wanted
      || !['ownerOf','getPoolAndPositionInfo','getApproved','predictVault'].every(name => raw(root[name],16_386))
      || !hash(root.predictedSequenceId) || !address(root.predictedVault) || !address(root.currency0)
      || !address(root.currency1) || !exact(root.code,['currency0','currency1','predictedVault'])
      || !Object.values(root.code).every(item => raw(item))) throw new Error('sequence_read_snapshot_invalid')
  }
  return value as unknown as SequenceSnapshot
}

export async function readSequenceSnapshot(owner: Address, tokenId: bigint | null): Promise<SequenceSnapshot> {
  if (!address(owner) || tokenId !== null && (tokenId <= 0n || tokenId >= 2n**256n)) throw new Error('sequence_read_snapshot_invalid')
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 17_000)
  try {
    const response = await financialFetch('/api/read/v4/sequence-snapshot', {
      method: 'POST', cache: 'no-store', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type':'application/json', 'X-Domino-Read-Contract':'1.0.0-rc.1' },
      body: JSON.stringify({owner, tokenId:tokenId === null ? null : tokenId.toString()}),
    })
    if (response.status !== 200 || response.headers.get('X-Domino-Read-Contract') !== '1.0.0-rc.1')
      throw new Error('sequence_read_snapshot_unavailable')
    if (!response.body) throw new Error('sequence_read_snapshot_invalid')
    const body = await boundedText(response, 1024 * 1024)
    if (body === null) throw new Error('sequence_read_snapshot_invalid')
    return sequenceSnapshotFrom(JSON.parse(body),owner,tokenId)
  } catch (error) {
    if (error instanceof Error && error.message === 'sequence_read_snapshot_invalid') throw error
    throw new Error('sequence_read_snapshot_unavailable')
  } finally { clearTimeout(timer) }
}
