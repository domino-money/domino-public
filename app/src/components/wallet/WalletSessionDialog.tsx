import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useConnectors, type Connector } from 'wagmi'
import { privateScope, type Snapshot } from '../../session/controller'
import { useSignedInIdentity } from '../../session/privateQuery'
import { cancelConnect, connectingState, connectWallet, disconnectWallet, subscribeConnecting, switchToRobinhood } from '../../wallet/port'
import { sessionController } from '../../wallet/session'
import { walletConnectOffered } from '../../wallet/walletConnect'
import { PREVIEW_ALIAS } from '../../chains/elysium/mode'
import { useDialog } from '../../lib/useDialog'
import { Button, Card } from '../ui'
import { IconChevronRight, IconClose } from '../icons'
import { knownDelegateAt } from '../../finance/delegates'
import { approveIn, connectNotice, describe, NO_BROWSER_WALLET, OPEN_IN_WALLET_APP, OPEN_IN_WALLET_APP_NOTE, REFRESH_UNAVAILABLE, shortAddress, SWITCH_NOTICE, WALLETCONNECT } from './copy'
import { CopyButton } from '../read/screens/CopyButton'
import { tokenHue } from '../../lib/format/tokenHue'
import { WalletConnectPanel } from './WalletConnectPanel'
import { WalletLogo } from './WalletLogo'

/** Wallet names come from the extension that announced them: shown as text, shortened. */
const MAX_NAME = 40
const walletName = (name: string) => (name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}…` : name)

/**
 * A phone or a tablet, where no wallet extension can be installed (audit C4): its touch screen, or its browser's own
 * word for being one. Read once per dialog; it never selects a wallet, only which advice the dialog gives.
 */
const onPhone = (): boolean =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(pointer: coarse)').matches === true || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent))

/**
 * The service's latest account check in words: a standard wallet account, or one turned into a smart account and the
 * wallet whose code it runs, named from its delegate's address (finance/delegates.ts). Funding reads the delegate's code
 * itself. Changed on purpose 2026-10-01 (audit E5): plain words on the dialog ("Plain EOA", "EIP-7702" and the block
 * were jargon); the technical facts stay in the line's title.
 */
function accountCheck(validation: { method: string; blockNumber: string; delegate?: string }): { text: string; title: string } {
  if (validation.method !== 'eip7702_delegated' || !validation.delegate) return { text: 'Standard wallet', title: `Plain EOA, checked at block ${validation.blockNumber}` }
  const known = knownDelegateAt(validation.delegate)
  return {
    text: known ? `Smart account (${known.wallet})` : 'Smart account (not recognized)',
    title: `EIP-7702 delegation to ${known ? `${known.wallet} ${known.contract}` : `unrecognized contract ${validation.delegate}`}, checked at block ${validation.blockNumber}`,
  }
}

/** An action's own outcome, shown only while the state it was taken in lasts. */
interface Notice {
  text: string
  epoch: number
  status: string
}

/** One wallet to connect: its logo, its name, and a second line when it has one. */
function WalletRow({ connector, hint, onPick }: { connector: Connector; hint?: string; onPick: () => void }) {
  return (
    <li>
      <button type="button" className="dm-wallet-row" onClick={onPick}>
        <span className="dm-wallet-logo">
          <WalletLogo id={connector.id} />
        </span>
        <span className="sr-only">{'Connect '}</span>
        <span className="dm-wallet-row-text">
          <bdi className="min-w-0 truncate">{walletName(connector.name)}</bdi>
          {hint && <span className="dm-wallet-row-hint">{hint}</span>}
        </span>
        <IconChevronRight />
      </button>
    </li>
  )
}

/**
 * A phone with no wallet in its browser (audit C4): the site opened in a wallet app's own browser instead. Fixed links,
 * each the wallet's documented way to open a site; the page never builds one. Changed on purpose 2026-10-01 (fix round
 * 1): on the gated preview alias (chains/elysium/mode.ts PREVIEW_ALIAS, exactly) they open the preview, where they sent
 * a tester to production; everywhere else, domino.money.
 */
function WalletApps() {
  const onPreview = typeof location !== 'undefined' && location.origin === PREVIEW_ALIAS
  const row = (id: string, name: React.ReactNode) => (
    <>
      <span className="dm-wallet-logo"><WalletLogo id={id} /></span>
      <span className="sr-only">{'Open in '}</span>
      <span className="min-w-0 truncate">{name}</span>
      <IconChevronRight />
    </>
  )
  return (
    <>
      <p className="text-[0.8125rem] leading-[1.125rem] text-fg-muted">{OPEN_IN_WALLET_APP}</p>
      <ul className="dm-wallet-list" aria-label="Wallet apps" data-wallet-apps={onPreview ? 'preview' : 'site'}>
        <li>
          {onPreview ? (
            <a className="dm-wallet-row" href="https://metamask.app.link/dapp/preview.domino-app-e65.pages.dev/" rel="noopener noreferrer">{row('io.metamask', <>MetaMask</>)}</a>
          ) : (
            <a className="dm-wallet-row" href="https://metamask.app.link/dapp/domino.money/" rel="noopener noreferrer">{row('io.metamask', <>MetaMask</>)}</a>
          )}
        </li>
        <li>
          {onPreview ? (
            <a className="dm-wallet-row" href="https://go.cb-w.com/dapp?cb_url=https%3A%2F%2Fpreview.domino-app-e65.pages.dev%2F" rel="noopener noreferrer">{row('com.coinbase.wallet', <>Coinbase Wallet</>)}</a>
          ) : (
            <a className="dm-wallet-row" href="https://go.cb-w.com/dapp?cb_url=https%3A%2F%2Fdomino.money%2F" rel="noopener noreferrer">{row('com.coinbase.wallet', <>Coinbase Wallet</>)}</a>
          )}
        </li>
        <li>
          {onPreview ? (
            <a className="dm-wallet-row" href="https://link.trustwallet.com/open_url?coin_id=60&url=https%3A%2F%2Fpreview.domino-app-e65.pages.dev%2F" rel="noopener noreferrer">{row('com.trustwallet.app', <>Trust Wallet</>)}</a>
          ) : (
            <a className="dm-wallet-row" href="https://link.trustwallet.com/open_url?coin_id=60&url=https%3A%2F%2Fdomino.money%2F" rel="noopener noreferrer">{row('com.trustwallet.app', <>Trust Wallet</>)}</a>
          )}
        </li>
      </ul>
      <p className="text-caption text-fg-subtle">{OPEN_IN_WALLET_APP_NOTE}</p>
    </>
  )
}

/** A computer with no wallet extension (audit C4): where to get one. Fixed links, each in a new tab. */
function GetAWallet() {
  return (
    <>
      <p className="text-[0.8125rem] leading-[1.125rem] text-fg-muted">{NO_BROWSER_WALLET}</p>
      <p className="dm-wallet-get text-caption text-fg-subtle">
        {'Get one: '}
        <a href="https://metamask.io/download/" target="_blank" rel="noopener noreferrer">MetaMask</a>
        {' or '}
        <a href="https://rabby.io/" target="_blank" rel="noopener noreferrer">Rabby</a>
        {'.'}
      </p>
    </>
  )
}

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
  const waiting = useSyncExternalStore(subscribeConnecting, connectingState, connectingState)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [pending, setPending] = useState(false)
  const [phone] = useState(onPhone)

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
  }, [open, session.view, pending, waiting, dialog])

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

  // A connection waits for its wallet without holding the dialog (audit C7): the list stays, another wallet can be
  // picked, and Cancel lets go of it. Its outcome is said in the state the page is in once it ends.
  const connect = async (connector: Connector) => {
    setNotice(null)
    const result = await connectWallet(connector)
    if (result === 'user_rejected' || result === 'pending' || result === 'error') {
      const { epoch, view: after } = sessionController.getSnapshot()
      setNotice({ text: connectNotice(result, walletName(connector.name)), epoch, status: after.status })
    }
  }
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

  const choosing = view.status === 'no_wallet' || waiting !== null
  const browserWallets = connectors.filter((connector) => connector.type !== 'walletConnect')
  const walletConnect = walletConnectOffered() ? connectors.find((connector) => connector.type === 'walletConnect') : undefined
  const pairing = waiting !== null && waiting.uid === walletConnect?.uid
  // A connected wallet with an unavailable sign-in must say why no Sign in action is offered.
  // Otherwise receipts look like a missing feature even though the session service is the missing part.
  const quiet = view.status === 'no_wallet'
  const status = waiting !== null ? (pairing ? null : approveIn(walletName(waiting.name))) : quiet ? null : describe(view)

  let actions: React.ReactNode = null
  if (waiting !== null) {
    actions = (
      <Button variant="ghost" onClick={cancelConnect}>
        Cancel
      </Button>
    )
  } else {
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
  }

  const details = signedIn.data
  const walletConnectRow = walletConnect && (
    <WalletRow key={walletConnect.uid} connector={walletConnect} hint={WALLETCONNECT.rowHint} onPick={() => void connect(walletConnect)} />
  )

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
        aria-describedby={status ? 'wallet-dialog-status' : undefined}
        ref={dialog}
        className="dm-dialog"
      >
        <div className="relative grid gap-y-1 pr-10">
          <h2 id="wallet-dialog-title" tabIndex={-1} className="dm-dialog-title outline-none">
            {choosing ? 'Connect' : 'Wallet'}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="dm-icon-btn dm-icon-btn--ghost dm-icon-btn--sm dm-press-icon absolute -top-1.5 -right-1.5">
            <IconClose />
          </button>
          {status && <p id="wallet-dialog-status" className="text-[0.8125rem] leading-[1.125rem] text-fg-muted" data-status={waiting ? 'connecting' : view.status}>
            {status}
          </p>}
        </div>

        <div className="grid gap-3" aria-busy={busy || pending || waiting !== null || undefined}>
          {identity.kind === 'connected' && !choosing && (
            // Changed on purpose 2026-10-03 (the owner: "no need to say which wallet app it is", and the pill above with the
            // address below looked broken): one calm row, the address's disc, the short address and its state under it,
            // and Copy for the whole address (also its title). The wallet app's name is no longer shown.
            <div className="dm-wallet-id" data-wallet-state={view.status === 'signed_in' ? 'signed-in' : view.status === 'wrong_network' ? 'other-network' : 'connected'}>
              <span aria-hidden="true" className="dm-wallet-disc dm-wallet-id-disc" style={{ '--mark-h': 200 + (tokenHue(identity.address) % 120) } as CSSProperties} />
              <span className="dm-wallet-id-text">
                <span className="dm-wallet-id-address tnum" title={identity.address} data-testid="wallet-address" data-address={identity.address}>
                  {shortAddress(identity.address)}
                </span>
                <span className="dm-wallet-id-state">{view.status === 'signed_in' ? 'Signed in' : view.status === 'wrong_network' ? 'Connected, on another network' : 'Connected'}</span>
              </span>
              <CopyButton value={identity.address} label="Copy address" className="dm-wallet-id-copy" />
            </div>
          )}

          {choosing && pairing && <WalletConnectPanel phone={phone} />}

          {choosing && !pairing && (browserWallets.length > 0 ? (
            <ul className="dm-wallet-list" aria-label="Browser wallets">
              {browserWallets.map((connector) => (
                <WalletRow
                  key={connector.uid}
                  connector={connector}
                  hint={waiting?.uid === connector.uid ? 'Waiting for your approval…' : undefined}
                  onPick={() => void connect(connector)}
                />
              ))}
            </ul>
          ) : phone ? <WalletApps /> : <GetAWallet />)}
          {choosing && !pairing && walletConnectRow && (
            <ul className="dm-wallet-list" aria-label="Phone wallets">
              {walletConnectRow}
            </ul>
          )}

          {view.status === 'signed_in' && details && (
            <dl className="dm-inset dm-kv" data-testid="session-details">
              <div>
                <dt className="text-[0.8125rem]">Ends no later than</dt>
                <dd className="tnum font-mono text-[0.8125rem] tracking-normal">{details.expiresAt.slice(0, 16).replace('T', ' ')} UTC</dd>
              </div>
              <div>
                <dt className="text-[0.8125rem]">Account</dt>
                <dd className="text-[0.8125rem]" title={accountCheck(details.validation).title} data-account-check={details.validation.method}>
                  {accountCheck(details.validation).text}
                </dd>
              </div>
            </dl>
          )}
          {view.status === 'signed_in' && (
            // Changed on purpose 2026-10-01 (audit E5): one plain sentence for what the session does; the docs' Sessions
            // and signing out says the rest.
            <p className="text-caption text-fg-subtle">Signs you out after 30 minutes without use, and at the latest at the time above.</p>
          )}

          {view.status === 'signed_in' && view.notice === 'refresh_unavailable' && (
            <p className="text-[0.8125rem] leading-[1.125rem] text-fg-muted" data-testid="refresh-notice">
              {REFRESH_UNAVAILABLE}
            </p>
          )}

          {shown && (
            <p role="alert" className="text-[0.8125rem] leading-[1.125rem]" style={{ color: 'var(--money-out)' }}>
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
