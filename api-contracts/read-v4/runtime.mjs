// Fixed V1 deployment snapshot. Only owner and one optional NFT id enter;
// selectors, contract addresses and RPC endpoints are server-owned constants.
export const CONTRACT_VERSION = '1.0.0-rc.1'
export const ROUTES = Object.freeze({'sequence-snapshot': Object.freeze({schemaVersion: 1})})
export { ERROR_STATUS_BY_CODE } from '../read-v1/runtime.mjs'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => object(value) && Object.keys(value).sort().join() === [...keys].sort().join()
const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value)
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value)
const raw = (value, max=200_002) => typeof value === 'string' && value.length <= max && /^0x(?:[0-9a-f]{2})*$/.test(value)
const token = value => typeof value === 'string' && /^[1-9][0-9]{0,77}$/.test(value) && BigInt(value) < 2n ** 256n
const nonce = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 2n ** 256n
const roles = ['factory','implementation','poolManager','positionManager','stateView','readHelper','engine','routing','priceGuard']
const staticCalls = Object.freeze({
  factory: ['implementation','implementationCodeHash','poolManager','positionManager','stateView','serviceFeeRecipient','nextOwnerNonce'],
  implementation: ['factory','implementation','implementationVersion','poolManager','positionManager','stateView','serviceFeeRecipient','readHelper','executionEngine','readHelperCodeHash','executionEngineCodeHash','poolManagerCodeHash','positionManagerCodeHash','stateViewCodeHash'],
  positionManager: ['poolManager'], stateView: ['poolManager'], readHelper: ['positionManager','stateView'],
  engine: ['factory','readHelper','routingHelper','priceGuard','readHelperHash','routingHelperHash','priceGuardHash'],
  priceGuard: ['publisher'],
})

export function validateRequest(route, body) {
  return route === 'sequence-snapshot' && exact(body, ['owner','tokenId']) && address(body.owner)
    && (body.tokenId === null || token(body.tokenId))
}

export function validateResponse(route, body) {
  if (route !== 'sequence-snapshot' || !exact(body, ['schemaVersion','contractVersion','chainId','owner','tokenId','blockNumber','blockHash','code','calls','recent','root'])
      || body.schemaVersion !== 1 || body.contractVersion !== CONTRACT_VERSION || body.chainId !== 4663
      || !address(body.owner) || !(body.tokenId === null || token(body.tokenId))
      || !Number.isSafeInteger(body.blockNumber) || body.blockNumber < 0 || !hash(body.blockHash)
      || !exact(body.code, [...roles,'operator','pricePublisher'])
      || !Object.values(body.code).every(value => raw(value))
      || !exact(body.calls, Object.keys(staticCalls))) return false
  for (const [role, fields] of Object.entries(staticCalls)) {
    if (!exact(body.calls[role], fields) || !Object.values(body.calls[role]).every(value => raw(value, 16_386))) return false
  }
  if (!Array.isArray(body.recent) || body.recent.length > 8 || !body.recent.every(row =>
    exact(row, ['ownerNonce','sequenceId','vault','vaultForSequence']) && nonce(row.ownerNonce)
      && hash(row.sequenceId) && address(row.vault) && raw(row.vaultForSequence,16_386))) return false
  if (body.tokenId === null) return body.root === null
  const root = body.root
  return exact(root, ['tokenId','ownerOf','getPoolAndPositionInfo','getApproved','predictVault',
    'predictedSequenceId','predictedVault','currency0','currency1','code']) && root.tokenId === body.tokenId
    && ['ownerOf','getPoolAndPositionInfo','getApproved','predictVault'].every(name => raw(root[name],16_386))
    && hash(root.predictedSequenceId) && ['predictedVault','currency0','currency1'].every(name => address(root[name]))
    && exact(root.code,['currency0','currency1','predictedVault']) && Object.values(root.code).every(value => raw(value))
}

export const matchesRequest = (request, response) => request.owner === response.owner && request.tokenId === response.tokenId
