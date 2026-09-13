import { getConnection } from 'wagmi/actions'
import { numberToHex } from 'viem'
import { walletConfig } from '../wallet/config'
import type { WalletHandoff } from '../deposit/handoff'
import { livePort } from '../session/livePort'
import type { WalletRpc } from './setup'
import { claimOwnerNonce, ownerNonceOffered, releaseOwnerNonceAfterRejection } from './nonce'

interface Provider { request(args: { method: string; params?: unknown[] }): Promise<unknown> }
// Once offered to a wallet, a nonce stays latched for this page even if the
// provider loses its response. Reconciliation, never a second Send, follows.
const offered = new Set<string>()
/** Owner recovery deliberately does not require a Domino session or backend. */
export async function setupWallet(): Promise<WalletRpc> {
  const connected = getConnection(walletConfig)
  if (connected.status !== 'connected' || !connected.connector || connected.chainId !== 4663) throw new Error('connect_robinhood_wallet')
  const connector = connected.connector, owner = connected.address.toLowerCase() as `0x${string}`
  const provider = await connector.getProvider() as Provider
  return { owner, current: () => {
    const next = getConnection(walletConfig)
    return next.status === 'connected' && next.connector?.uid === connector.uid && next.address.toLowerCase() === owner && next.chainId === 4663
  }, request: (method, params) => provider.request({ method, params }),
  nonceOffered: nonce => ownerNonceOffered(owner, nonce), claimNonce: nonce => claimOwnerNonce(owner, nonce),
  releaseRejectedNonce: (nonce, token) => releaseOwnerNonceAfterRejection(owner, nonce, token) }
}
export const liveWalletHandoff: WalletHandoff = {
  available: true,
  async send(step, context) {
    if (!context.isCurrent?.()) throw new Error('wallet_step_expired')
    const session = livePort.getSnapshot(), connected = getConnection(walletConfig)
    if (session.kind !== 'signed_in' || connected.status !== 'connected' || !connected.connector
      || connected.connector.uid !== session.connectorUid || session.owner !== context.from.toLowerCase()
      || connected.address.toLowerCase() !== session.owner || connected.chainId !== 4663
      || step.transaction.chainId !== 4663 || step.transaction.from.toLowerCase() !== session.owner) throw new Error('wallet_identity_changed')
    const provider = await connected.connector.getProvider() as Provider
    const [accounts, chain] = await Promise.all([provider.request({ method: 'eth_accounts' }), provider.request({ method: 'eth_chainId' })])
    if (!Array.isArray(accounts) || accounts[0]?.toLowerCase() !== session.owner || BigInt(String(chain)) !== 4663n
      || livePort.getSnapshot() !== session || getConnection(walletConfig).connector?.uid !== session.connectorUid
      || !context.isCurrent()) throw new Error('wallet_identity_changed')
    const tx = step.transaction
    const key = `${session.owner}|${tx.nonceRaw}`
    if (offered.has(key) || ownerNonceOffered(session.owner, BigInt(tx.nonceRaw))) throw new Error('wallet_step_already_offered')
    const claim = await claimOwnerNonce(session.owner, BigInt(tx.nonceRaw))
    if (!context.isCurrent() || livePort.getSnapshot() !== session || getConnection(walletConfig).connector?.uid !== session.connectorUid) {
      // Still before the provider call: no signing outcome can exist.
      await releaseOwnerNonceAfterRejection(session.owner, BigInt(tx.nonceRaw), claim)
      throw new Error('wallet_identity_changed')
    }
    offered.add(key)
    let result: unknown
    try { result = await provider.request({ method: 'eth_sendTransaction', params: [{ chainId: '0x1237', from: tx.from, to: tx.to, data: tx.data,
      value: numberToHex(BigInt(tx.valueRaw)), nonce: numberToHex(BigInt(tx.nonceRaw)), gas: numberToHex(BigInt(tx.gasLimitRaw)),
      maxFeePerGas: numberToHex(BigInt(tx.maxFeePerGasRaw)), maxPriorityFeePerGas: numberToHex(BigInt(tx.maxPriorityFeePerGasRaw)), type: '0x2' }] }) }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 4001) { offered.delete(key); await releaseOwnerNonceAfterRejection(session.owner, BigInt(tx.nonceRaw), claim) }
      throw error
    }
    if (typeof result !== 'string' || !/^0x[0-9a-f]{64}$/i.test(result)) throw new Error('wallet_result_unknown')
    return result as `0x${string}`
  },
}
