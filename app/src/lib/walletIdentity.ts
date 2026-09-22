import { useSyncExternalStore } from 'react'
import { CHAIN_ID } from './read/screens/identity'

/**
 * What the header's wallet control is connected to, published outward for
 * any screen that wants to mention it.
 *
 * The wallet feature (session/, wallet/, components/wallet/) is the only code
 * allowed to import wagmi, viem or its own modules; tests/session.source-guard
 * refuses every import of it from elsewhere, types included. So the identity
 * travels the other way: the wallet islands push their connection into this
 * store, and screens subscribe here. This module imports nothing from the
 * feature, and nothing here is a session, a permission or a proof of
 * ownership — it is the address the connected wallet reports, and no more.
 *
 * In a build without a wallet control nothing ever publishes, so every
 * subscriber sees "disconnected" and asks for an address instead.
 */
export type WalletIdentityView =
  /** The wallet control has not settled yet. */
  | { kind: 'unknown' }
  | { kind: 'disconnected' }
  | { kind: 'connected'; address: string; chainId: number; connectorName: string }

const DISCONNECTED: WalletIdentityView = { kind: 'disconnected' }

let current: WalletIdentityView = DISCONNECTED
const listeners = new Set<() => void>()

/** Called by the wallet islands on every connection change. Same-value publishes are dropped so subscribers do not re-render for nothing. */
export function publishWalletIdentity(next: WalletIdentityView) {
  if (same(current, next)) return
  current = next
  for (const listener of listeners) listener()
}

function same(a: WalletIdentityView, b: WalletIdentityView) {
  if (a.kind !== b.kind) return false
  if (a.kind !== 'connected' || b.kind !== 'connected') return true
  return a.address === b.address && a.chainId === b.chainId && a.connectorName === b.connectorName
}

export function getWalletIdentity(): WalletIdentityView {
  return current
}

export function subscribeWalletIdentity(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * One string for a wallet connected on Robinhood Chain, for what a screen
 * carries to another under it (lib/create/setupDraft.ts): the chain and the
 * lowercase address. Any other state, another chain included, keys nothing.
 */
export function walletKey(view: WalletIdentityView): string | null {
  return view.kind === 'connected' && view.chainId === CHAIN_ID ? `${view.chainId}|${view.address.toLowerCase()}` : null
}

/** The published identity, live. */
export function useWalletIdentity(): WalletIdentityView {
  return useSyncExternalStore(subscribeWalletIdentity, getWalletIdentity, () => DISCONNECTED)
}
