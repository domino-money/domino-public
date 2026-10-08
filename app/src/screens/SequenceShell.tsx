import { useState, type ReactNode } from 'react'
import { useRouteTitle } from '../lib/routeTitle'
import { SWITCH_NOTICE, switchToRobinhood } from '../wallet/port'
import { Button, Display, EmptyState, Skeleton } from '../components/ui'
import { IconWallet } from '../components/icons'
import type { WalletIdentityView } from '../lib/walletIdentity'

export function Frame({ children }: { children: ReactNode }) {
  useRouteTitle('Set up automation')
  return <main className="dm-page dm-page--narrow dm-seq">
    <Display as="h1" className="dm-display-title">Set up automation</Display>
    <p className="dm-acct-lede">{__DOMINO_V2__ ? 'Choose a position and what Domino does for it.' : 'Choose a position and what its earned fees do.'}</p>
    {children}
  </main>
}

export function Loading({ wallet = false }: { wallet?: boolean }) {
  return <div className="dm-card dm-acct-block dm-seq-loading" data-sequence-release="available" data-sequence-wallet={wallet ? 'waiting' : undefined} data-sequence-positions={wallet ? undefined : 'loading'} aria-busy="true">
    {[0, 1, 2].map((row) => <Skeleton key={row} className="dm-seq-loading-row" />)}
  </div>
}

/** Connection remains shared; the legacy release and catalogue do not run in a V2 build. */
export function WalletPrompt({ identity }: { identity: WalletIdentityView }) {
  const [switching, setSwitching] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const switchNetwork = async () => {
    if (switching) return
    setSwitching(true)
    setNotice(null)
    try {
      const result = await switchToRobinhood()
      setNotice(result === 'switched' ? null : SWITCH_NOTICE[result])
    } finally {
      setSwitching(false)
    }
  }
  if (identity.kind === 'unknown') return <Loading wallet />
  const elsewhere = identity.kind === 'connected'
  return <EmptyState plate icon={<IconWallet />} className="dm-acct-block" data-sequence-release="available"
    data-sequence-wallet={elsewhere ? 'other-network' : 'none'}
    title={elsewhere ? 'Switch to Robinhood Chain' : 'Connect your wallet'} body="Your open positions appear here to choose from."
    action={<>
      <Button type="button" variant="primary" size="lg" aria-busy={switching || undefined} disabled={switching}
        onClick={() => elsewhere ? void switchNetwork() : document.querySelector<HTMLButtonElement>('header [aria-haspopup="dialog"]')?.click()}>
        {elsewhere ? switching ? 'Switching…' : 'Switch network' : 'Connect wallet'}
      </Button>
      {elsewhere && notice && <p role="alert" className="mt-3 text-[0.8125rem] leading-[1.125rem] text-fg-muted" data-sequence-switch-notice="">{notice}</p>}
    </>} />
}

