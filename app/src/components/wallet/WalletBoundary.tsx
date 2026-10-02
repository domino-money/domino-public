import { Component, type ReactNode } from 'react'
import { publishWalletIdentity } from '../../lib/walletIdentity'

/**
 * Keeps a failed wallet chunk from taking the page down with it.
 *
 * The chunk is loaded lazily and can fail: after a redeploy removed its hashed
 * file, or once the beta cookie has expired and /assets/* answers 401. Nothing
 * else in the app depends on it, so the header falls back to the disabled
 * control and says why.
 */
export class WalletBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  // 2026-10-01 (audit C5): the screens wait while the identity is unknown; with no wallet feature, there is none to wait for.
  componentDidCatch() {
    publishWalletIdentity({ kind: 'disconnected' })
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <>
        {this.props.fallback}
        <span role="status" className="sr-only">
          Wallet sign-in could not load. Reload the page to try again.
        </span>
      </>
    )
  }
}
