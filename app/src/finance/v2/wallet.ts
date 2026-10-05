import { getConnection } from 'wagmi/actions'
import { walletConfig } from '../../wallet/config'
import type { V2ChainId } from '../../v2/types'
import { chainNonceJournal } from '../nonce'
import { browserSignatureJournal } from './signatureJournal'
import type { V2Wallet } from './transact'

/**
 * The connected wallet as a Domino V2 client takes it (finance/v2/transact.ts V2Wallet), from the page's one wagmi
 * connection, as finance/wallet.ts setupWallet builds V1's: its owner, whether the same connector and account are still
 * there, the chain its connector reports (checked before and after every wallet call), its own provider for every read and
 * send, the page's nonce journal keyed by chain (finance/nonce.ts chainNonceJournal: for Robinhood Chain the very same
 * latches as V1's) and the page's signature journal (./signatureJournal.ts).
 *
 * Nothing here reads a chain or sends anything; nothing chooses the chain: each client is bound to the plan's chain and
 * refuses a wallet on another one (`wallet_wrong_chain`), so the person switches first (wallet/port.ts switchToChain).
 */
interface Provider { request(args: { method: string; params?: unknown[] }): Promise<unknown> }

export async function v2Wallet(): Promise<V2Wallet> {
  const connected = getConnection(walletConfig)
  if (connected.status !== 'connected' || !connected.connector) throw new Error('connect_wallet')
  const connector = connected.connector
  const owner = connected.address.toLowerCase() as `0x${string}`
  const provider = (await connector.getProvider()) as Provider
  const signatures = browserSignatureJournal()
  return {
    owner,
    current: () => {
      const next = getConnection(walletConfig)
      return next.status === 'connected' && next.connector?.uid === connector.uid && next.address.toLowerCase() === owner
    },
    chainId: () => {
      const next = getConnection(walletConfig)
      return next.status === 'connected' && next.connector?.uid === connector.uid ? next.chainId : null
    },
    request: (method, params) => provider.request({ method, params }),
    nonceOffered: (chainId: V2ChainId, nonce) => chainNonceJournal(chainId).offered(owner, nonce),
    claimNonce: (chainId: V2ChainId, nonce) => chainNonceJournal(chainId).claim(owner, nonce, Date.now() / 1000),
    releaseRejectedNonce: (chainId: V2ChainId, nonce, token) => chainNonceJournal(chainId).releaseAfterRejection(owner, nonce, token),
    settleNonce: (chainId: V2ChainId, nonce, now, maxAge) => chainNonceJournal(chainId).settle(owner, nonce, now, maxAge),
    // Changed on purpose (data) 2026-10-02 (Domino V2 rev2 review, F3): "I rejected it in my wallet" lets the latch go.
    forgetNonce: (chainId: V2ChainId, nonce) => chainNonceJournal(chainId).forget(owner, nonce),
    signatures,
  }
}
