import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useConnectors, type Connector } from 'wagmi'
import { privateScope, type Snapshot } from '../../session/controller'
import { useSignedInIdentity } from '../../session/privateQuery'
import { connectWallet, disconnectWallet, switchToRobinhood } from '../../wallet/port'
import { sessionController } from '../../wallet/session'
import { useDialog } from '../../lib/useDialog'
import { Callout } from '../Callout'
import { Button, Card, Display, Eyebrow, Pill } from '../ui'
import { describe, REFRESH_UNAVAILABLE } from './copy'

/** Wallet names come from the extension that announced them: shown as text, shortened. */
const MAX_NAME = 40
const walletName = (name: string) => (name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}…` : name)

/** A neutral mark. The provider's own EIP-6963 icon is untrusted data and never used as an image. */
function WalletGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="3.5" width="13" height="10" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1.5 6.5h13" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.5" cy="10" r="1" fill="currentColor" />
    </svg>
  )
}

/** An action's own outcome, shown only while the state it was taken in lasts. */
interface Notice {
  text: string
  epoch: number
  status: string
}

const CONNECT_NOTICE = {
  user_rejected: 'Your wallet declined the connection request.',
  error: 'Your wallet could not connect.',
} as const

const SWITCH_NOTICE = {
  unknown_chain: 'Add Robinhood Chain (4663) in your wallet, then try again.',
  user_rejected: 'Your wallet declined the network switch.',
  error: 'Your wallet could not switch networks.',
} as const

export function WalletSessionDialog({
  open,
  onClose,
  session,
}: {
  open: boolean
  onClose: () => void
  session: Snapshot
}) {
  const dialog = useDialog(open, onClose)
  const connectors = useConnectors()
  const signedIn = useSignedInIdentity(privateScope(session))
  const [notice, setNotice] = useState<Notice | null>(null)
  const [pending, setPending] = useState(false)

  // Each step swaps the footer buttons, and a wallet action disables them
  // while it runs. When the button that had focus goes away or is disabled,
  // the browser drops focus to the body, outside this modal, and a keyboard
  // or screen reader user loses their place. Put it back on the title, which
  // the status line describes.
  useEffect(() => {
    if (!open) return
    const node = dialog.current
    if (node && !node.contains(document.activeElement)) {
      node.querySelector<HTMLElement>('#wallet-dialog-title')?.focus()
    }
  }, [open, session.view, pending, dialog])

  if (!open) return null

  const { view, identity, busy } = session
  const note = (text: string) => setNotice({ text, epoch: session.epoch, status: view.status })
  const shown = notice && notice.epoch === session.epoch && notice.status === view.status ? notice.text : null

  async function act<T>(task: () => Promise<T>, onDone: (result: T) => void) {
    setNotice(null)
    setPending(true)
    try {
      onDone(await task())
    } finally {
      setPending(false)
    }
  }

  const connect = (connector: Connector) =>
    act(
      () => connectWallet(connector),
      (result) => {
        if (result !== 'connected') note(CONNECT_NOTICE[result])
      },
    )
  const switchNetwork = () =>
    act(switchToRobinhood, (result) => {
      if (result !== 'switched') note(SWITCH_NOTICE[result])
    })
  const disconnect = () => act(disconnectWallet, () => {})

  const disconnectButton = (
    <Button variant="ghost" onClick={disconnect} disabled={pending}>
      Disconnect wallet
    </Button>
  )

  let actions: React.ReactNode = null
  switch (view.status) {
    case 'wrong_network':
      actions = (
        <>
          {disconnectButton}
          <Button onClick={switchNetwork} disabled={pending} aria-busy={pending || undefined}>
            Switch to Robinhood Chain
          </Button>
        </>
      )
      break
    case 'signed_out':
      actions = (
        <>
          {disconnectButton}
          <Button onClick={() => sessionController.dispatch({ type: 'sign_in' })}>Sign in</Button>
        </>
      )
      break
    case 'signing_in':
      if (view.step !== 'recovering' && view.step !== 'closing') {
        actions = (
          <Button variant="ghost" onClick={() => sessionController.dispatch({ type: 'cancel' })}>
            Cancel sign-in
          </Button>
        )
      }
      break
    case 'signed_in':
      actions = <Button onClick={() => sessionController.dispatch({ type: 'sign_out' })}>Sign out</Button>
      break
    case 'other_session':
      actions = (
        <>
          {disconnectButton}
          <Button onClick={() => sessionController.dispatch({ type: 'sign_out' })}>Sign that session out</Button>
        </>
      )
      break
    case 'not_invited':
      // No retry: another signature cannot change an admission decision.
      actions = disconnectButton
      break
    case 'blocked':
      actions = (
        <>
          {view.failure !== 'browser_unsupported' && disconnectButton}
          {view.retry === 'check' && (
            <Button onClick={() => sessionController.dispatch({ type: 'retry' })}>Check again</Button>
          )}
          {view.retry === 'sign_out' && (
            <Button onClick={() => sessionController.dispatch({ type: 'retry' })}>Try signing out again</Button>
          )}
        </>
      )
      break
  }

  const details = signedIn.data

  // Portalled to the body: the header's backdrop filter would otherwise become
  // the containing block of this fixed overlay and trap it inside the header.
  return createPortal(
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-[2px] sm:items-center sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <Card
        level={2}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-dialog-title"
        aria-describedby="wallet-dialog-status"
        ref={dialog}
        className="grid max-h-[92vh] w-full max-w-[480px] grid-rows-[auto_minmax(0,1fr)_auto] rounded-b-none sm:max-h-[86vh] sm:rounded-b-[var(--radius-lg)]"
      >
        <header className="border-b p-5">
          <Eyebrow>Robinhood Chain · 4663</Eyebrow>
          <Display as="h2" id="wallet-dialog-title" tabIndex={-1} className="mt-2 text-[23px] outline-none">
            Wallet sign-in
          </Display>
          <p id="wallet-dialog-status" className="mt-1 text-[13px] text-fg-muted" data-status={view.status}>
            {describe(view)}
          </p>
        </header>

        <div className="grid gap-4 overflow-y-auto p-5" aria-busy={busy || pending || undefined}>
          {identity.kind === 'connected' && view.status !== 'no_wallet' && (
            <div className="flex items-center justify-between gap-3 rounded-[var(--radius)] border bg-surface-1 px-4 py-3">
              <div className="min-w-0">
                <p className="text-[12px] text-fg-subtle">{walletName(identity.connectorName)}</p>
                <p className="tnum truncate font-mono text-[13px]" data-testid="wallet-address">
                  {identity.address}
                </p>
              </div>
              {view.status === 'signed_in' ? <Pill tone="in">Signed in</Pill> : <Pill tone="neutral">Not signed in</Pill>}
            </div>
          )}

          {view.status === 'no_wallet' &&
            (connectors.length === 0 ? (
              <p className="text-[13px] text-fg-muted">
                No browser wallet detected. Wallets that announce themselves through EIP-6963 appear here.
              </p>
            ) : (
              <ul className="grid gap-2" aria-label="Browser wallets">
                {connectors.map((connector) => (
                  <li key={connector.uid}>
                    <Button
                      variant="outline"
                      className="w-full justify-start"
                      disabled={pending}
                      onClick={() => connect(connector)}
                    >
                      <WalletGlyph />
                      <span className="sr-only">{'Connect '}</span>
                      {walletName(connector.name)}
                    </Button>
                  </li>
                ))}
              </ul>
            ))}

          {view.status === 'signed_in' && details && (
            <dl className="rounded-[var(--radius)] border bg-surface-1 px-4" data-testid="session-details">
              <div className="flex items-baseline justify-between gap-4 border-b border-dashed py-3">
                <dt className="text-[13px] text-fg-muted">Ends no later than</dt>
                <dd className="tnum font-mono text-[13px]">{details.expiresAt.slice(0, 16).replace('T', ' ')} UTC</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-3">
                <dt className="text-[13px] text-fg-muted">Latest account check</dt>
                <dd className="tnum text-right font-mono text-[13px]">Plain EOA · block {details.validation.blockNumber}</dd>
              </div>
            </dl>
          )}
          {view.status === 'signed_in' && (
            <p className="text-[12px] text-fg-subtle">
              The service ends a session sooner after 30 minutes idle. While you use this page in a visible tab, it
              renews the session before then; it checks with the service every few minutes and signs you out here
              when the session has ended. The account check is the latest one the service stored and may be out of
              date. It is not a live eligibility check.
            </p>
          )}

          {view.status === 'signed_in' && view.notice === 'refresh_unavailable' && (
            <p className="text-[13px]" data-testid="refresh-notice" style={{ color: 'var(--money-wait)' }}>
              {REFRESH_UNAVAILABLE}
            </p>
          )}

          {shown && (
            <p role="alert" className="text-[13px]" style={{ color: 'var(--money-out)' }}>
              {shown}
            </p>
          )}

          <Callout title="Signing in is not a permission">
            Signing in only proves you control this address. It grants no spending permission and cannot deposit, swap,
            mint, compound or open a successor position. Nothing in your wallet can move because you signed in.
          </Callout>
          <p className="text-[12px] text-fg-subtle">
            Only standard wallets (EOAs) can sign in. Smart-contract and EIP-7702 delegated accounts are not supported yet.
          </p>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t p-5">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </footer>
      </Card>
    </div>,
    document.body,
  )
}
