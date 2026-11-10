import { useState, type ReactNode } from 'react'
import { useRouteTitle } from '../lib/routeTitle'
import { SWITCH_NOTICE, switchToRobinhood } from '../wallet/port'
import { Button, Display, EmptyState, LinkButton, Skeleton } from '../components/ui'
import { IconPlus } from '../components/icons'
import { ConnectArt } from '../components/automate-v4/SeqPlateArt'
import { AUTOMATION_CHOICE_COPY } from '../components/automate/copy'
import { newPositionHref } from '../components/explore/routes'
import type { WalletIdentityView } from '../lib/walletIdentity'

/**
 * Changed on purpose 2026-10-30 (QA round 2, the owner's decision on N13): Set up Auto-compound and Set up Domino-compound
 * keep the mode chosen on Automate in their title, and their line says what it does, in Automate's words, and that it
 * works on a position you already have. A link with no mode still says Set up automation.
 */
export function Frame({ children, protection = false, mode = null }: { children: ReactNode; protection?: boolean; mode?: 'compound' | 'domino' | null }) {
  const named = !protection && mode ? AUTOMATION_CHOICE_COPY[mode] : null
  const title = protection ? 'Set up Auto-exit' : named ? `Set up ${named.title}` : 'Set up automation'
  useRouteTitle(title)
  return <main className="dm-page dm-page--narrow dm-seq">
    <Display as="h1" className="dm-display-title">{title}</Display>
    <p className="dm-acct-lede">{protection ? 'Choose the position you want Domino to close at the end of its range.' : named ? `${named.description} ${named.title} works on a position you already have.` : __DOMINO_V2__ ? 'Choose a position and what Domino does for it.' : 'Choose a position and what its earned fees do.'}</p>
    {children}
  </main>
}

export function Loading({ wallet = false }: { wallet?: boolean }) {
  return <div className="dm-card dm-acct-block dm-seq-loading" data-sequence-release="available" data-sequence-wallet={wallet ? 'waiting' : undefined} data-sequence-positions={wallet ? undefined : 'loading'} aria-busy="true">
    {[0, 1, 2].map((row) => <Skeleton key={row} className="dm-seq-loading-row" />)}
  </div>
}

/**
 * Connection remains shared; the legacy release and catalogue do not run in a V2 build. Changed on purpose 2026-10-30 (QA
 * round 2, the owner's decision on N13): with no wallet, the plate also says where a first position comes from and offers
 * New position beside Connect wallet (Automate's own button), and the page keeps a way back to Automate (ProtectionSetup's
 * Back, the same link).
 */
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
  return <>
    <EmptyState plate icon={<ConnectArt />} className="dm-acct-block dm-lit" data-sequence-release="available"
      data-sequence-wallet={elsewhere ? 'other-network' : 'none'}
      title={elsewhere ? 'Switch to Robinhood Chain' : 'Connect your wallet'}
      body={elsewhere ? 'Your open positions appear here to choose from.' : 'Your open positions appear here to choose from. Don’t have a position? Start with New position.'}
      action={<>
        <Button type="button" variant="primary" size="lg" aria-busy={switching || undefined} disabled={switching}
          onClick={() => elsewhere ? void switchNetwork() : document.querySelector<HTMLButtonElement>('header [aria-haspopup="dialog"]')?.click()}>
          {elsewhere ? switching ? 'Switching…' : 'Switch network' : 'Connect wallet'}
        </Button>
        {!elsewhere && <LinkButton href={newPositionHref()} variant="outline" size="lg" data-sequence-new-position=""><IconPlus />New position</LinkButton>}
        {elsewhere && notice && <p role="alert" className="mt-3 text-[0.8125rem] leading-[1.125rem] text-fg-muted" data-sequence-switch-notice="">{notice}</p>}
      </>} />
    <div className="dm-acct-block" data-sequence-back=""><LinkButton href="/automate" variant="outline">Back</LinkButton></div>
  </>
}
