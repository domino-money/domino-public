import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useConnectors, type Connector } from 'wagmi'
import { privateScope, type Snapshot } from '../../session/controller'
import { useSignedInIdentity } from '../../session/privateQuery'
import { connectWallet, disconnectWallet, switchToRobinhood } from '../../wallet/port'
import { sessionController } from '../../wallet/session'
import { useDialog } from '../../lib/useDialog'
import { Button, Card, Pill } from '../ui'
import { IconChevronRight, IconClose } from '../icons'
import { BrandMark } from '../BrandMark'
import { describe, REFRESH_UNAVAILABLE } from './copy'
import { WalletLogo } from './WalletLogo'

/** Wallet names come from the extension that announced them: shown as text, shortened. */
const MAX_NAME = 40
const walletName = (name: string) => (name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}…` : name)

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
    <Button variant="ghost" size="sm" onClick={disconnect} disabled={pending}>
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

  // Portalled to the body, outside #root: while it is open the rest of the page
  // is marked inert and hidden from assistive technology.
  return createPortal(
    <div
      role="presentation"
      className="dm-dialog-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <Card
        level={2}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-dialog-title"
        aria-describedby={view.status === 'no_wallet' ? undefined : 'wallet-dialog-status'}
        ref={dialog}
        className="dm-dialog"
      >
        <div className="relative grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1 pr-10">
          <BrandMark width={12} height={21} />
          <h2 id="wallet-dialog-title" tabIndex={-1} className="dm-dialog-title outline-none">
            {view.status === 'no_wallet' ? 'Connect' : 'Wallet'}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="dm-icon-btn dm-icon-btn--ghost dm-icon-btn--sm dm-press-icon absolute -top-1.5 -right-1.5">
            <IconClose />
          </button>
          {view.status !== 'no_wallet' && <p id="wallet-dialog-status" className="col-span-2 text-[13px] leading-[18px] text-fg-muted" data-status={view.status}>
            {describe(view)}
          </p>}
        </div>

        <div className="grid gap-3" aria-busy={busy || pending || undefined}>
          {identity.kind === 'connected' && view.status !== 'no_wallet' && (
            <div className="dm-inset flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-caption text-fg-subtle">{walletName(identity.connectorName)}</p>
                <p className="tnum truncate font-mono text-[13px] leading-[18px] tracking-normal" data-testid="wallet-address">
                  {identity.address}
                </p>
              </div>
              {view.status === 'signed_in' ? <Pill tone="in">Signed in</Pill> : <Pill tone="neutral">Not signed in</Pill>}
            </div>
          )}

          {view.status === 'no_wallet' &&
            (connectors.length === 0 ? (
              <p className="text-[13px] leading-[18px] text-fg-muted">
                No browser wallet detected. Wallets that announce themselves through EIP-6963 appear here.
              </p>
            ) : (
              <ul className="dm-wallet-list" aria-label="Browser wallets">
                {connectors.map((connector) => (
                  <li key={connector.uid}>
                    <button
                      type="button"
                      className="dm-wallet-row"
                      disabled={pending}
                      onClick={() => connect(connector)}
                    >
                      <span className="dm-wallet-logo">
                        <WalletLogo id={connector.id} />
                      </span>
                      <span className="sr-only">{'Connect '}</span>
                      <bdi className="min-w-0 truncate">{walletName(connector.name)}</bdi>
                      <IconChevronRight />
                    </button>
                  </li>
                ))}
              </ul>
            ))}

          {view.status === 'signed_in' && details && (
            <dl className="dm-inset dm-kv" data-testid="session-details">
              <div>
                <dt className="text-[13px]">Ends no later than</dt>
                <dd className="tnum font-mono text-[13px] tracking-normal">{details.expiresAt.slice(0, 16).replace('T', ' ')} UTC</dd>
              </div>
              <div>
                <dt className="text-[13px]">Latest account check</dt>
                <dd className="tnum font-mono text-[13px] tracking-normal">Plain EOA · block {details.validation.blockNumber}</dd>
              </div>
            </dl>
          )}
          {view.status === 'signed_in' && (
            <p className="text-caption text-fg-subtle">
              The service ends a session sooner after 30 minutes idle. While you use this page in a visible tab, it
              renews the session before then; it checks with the service every few minutes and signs you out here
              when the session has ended. The account check is the latest one the service stored and may be out of
              date. It is not a live eligibility check.
            </p>
          )}

          {view.status === 'signed_in' && view.notice === 'refresh_unavailable' && (
            <p className="text-[13px] leading-[18px]" data-testid="refresh-notice" style={{ color: 'var(--money-wait)' }}>
              {REFRESH_UNAVAILABLE}
            </p>
          )}

          {shown && (
            <p role="alert" className="text-[13px] leading-[18px]" style={{ color: 'var(--money-out)' }}>
              {shown}
            </p>
          )}

        </div>

        {actions && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
          {actions}
        </div>}
      </Card>
    </div>,
    document.body,
  )
}
