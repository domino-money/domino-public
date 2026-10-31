import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useConnectors, type Connector } from 'wagmi'
import { privateScope, type Snapshot } from '../../session/controller'
import { useSignedInIdentity } from '../../session/privateQuery'
import { cancelConnect, connectingState, connectWallet, disconnectWallet, subscribeConnecting } from '../../wallet/port'
import { sessionController } from '../../wallet/session'
import { walletConnectOffered } from '../../wallet/walletConnect'
import { PREVIEW_ALIAS } from '../../chains/elysium/mode'
import { useDialog } from '../../lib/useDialog'
import { Button, Card } from '../ui'
import { IconChevronRight, IconClose } from '../icons'
import { knownDelegateAt } from '../../finance/delegates'
import { approveIn, connectNotice, describe, NO_BROWSER_WALLET, NO_BROWSER_WALLET_PHONE, OPEN_IN_WALLET_APP, OPEN_IN_WALLET_APP_NOTE, shortAddress, WALLETCONNECT } from './copy'
import { CopyButton } from '../read/screens/CopyButton'
import { tokenHue } from '../../lib/format/tokenHue'
import { WalletConnectPanel } from './WalletConnectPanel'
import { WalletLogo } from './WalletLogo'
import { signInFlow, useSignInProgress } from '../../wallet/signIn'
import { networkName } from '../../lib/networkName'

/** Wallet names come from the extension that announced them: shown as text, shortened. */
const MAX_NAME = 40
const walletName = (name: string) => (name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}…` : name)

/**
 * A phone or a tablet, where no wallet extension can be installed (audit C4): its touch screen, or its browser's own
 * word for being one. Read once per dialog; it never selects a wallet, only which advice the dialog gives. Changed on
 * purpose 2026-10-30 (QA round 2, N4): an iPad with a keyboard or trackpad calls itself a Mac with a fine pointer, so a
 * "Mac" with a touch screen counts as a tablet too, and gets the wallet apps rather than extensions it cannot install.
 */
const onPhone = (): boolean =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(pointer: coarse)').matches === true ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1))

/**
 * The access gate's own pattern for a link back into the site (functions/_lib/gate.ts NEXT_PATTERN, the same text;
 * tests/wallet-compat.test.mjs holds them equal): a hash route of the site's own shape, nothing else.
 */
const NEXT_PATTERN = '^#\\/[A-Za-z0-9\\/_.,-]{0,200}(?:#[A-Za-z0-9_-]{1,64})?$'

/**
 * The open route, for the wallet app's browser to open after the site's password (2026-10-30, QA round 2, N56: the links
 * opened Home, and a phone lost the pool it had chosen): only a route the gate itself would go back to, and none for
 * Home, so a link from Home is exactly the fixed one it always was. Typed amounts and ranges are never carried.
 */
function openRoute(): string {
  const hash = typeof location === 'undefined' ? '' : location.hash
  const home = (hash.replace(/^#/, '').split('#')[0] || '/') === '/'
  return !home && new RegExp(NEXT_PATTERN).test(hash) ? hash : ''
}

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

/**
 * One wallet to connect: its logo, its name, and a second line when it has one. A wallet waiting for its approval wears
 * the row's hover, its pip and its brand ring, a turning arc in place of the chevron (V4 .is-wait; data-waiting, shell.css).
 */
function WalletRow({ connector, hint, waiting = false, onPick }: { connector: Connector; hint?: string; waiting?: boolean; onPick: () => void }) {
  return (
    <li>
      <button type="button" className="dm-wallet-row" data-waiting={waiting || undefined} onClick={onPick}>
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
 * A phone with no wallet in its browser (audit C4): the site opened in a wallet app's own browser instead, by each
 * wallet's documented link, on a fixed site. Changed on purpose 2026-10-01 (fix round 1): on the gated preview alias
 * (chains/elysium/mode.ts PREVIEW_ALIAS, exactly) they open the preview, where they sent a tester to production;
 * everywhere else, domino.money. Changed on purpose 2026-10-30 (QA round 2, N56): each link carries the open route
 * (openRoute, checked as the gate checks it), so the wallet's browser opens the same screen after the password; from
 * Home they are the fixed links they always were. Its two lines are the sheet's captions (N77, N79: they sat 12 px left
 * of the title and rows on a phone, and the password line was the smallest, faintest text in the sheet).
 */
function WalletApps() {
  const onPreview = typeof location !== 'undefined' && location.origin === PREVIEW_ALIAS
  const site = onPreview ? 'preview.domino-app-e65.pages.dev' : 'domino.money'
  const route = openRoute()
  const page = encodeURIComponent(`https://${site}/${route}`)
  const apps: ReadonlyArray<readonly [id: string, name: string, href: string]> = [
    ['io.metamask', 'MetaMask', `https://metamask.app.link/dapp/${site}/${route}`],
    ['com.coinbase.wallet', 'Coinbase Wallet', `https://go.cb-w.com/dapp?cb_url=${page}`],
    ['com.trustwallet.app', 'Trust Wallet', `https://link.trustwallet.com/open_url?coin_id=60&url=${page}`],
  ]
  return (
    <>
      <p className="dm-wd-cap text-fg-muted">{OPEN_IN_WALLET_APP}</p>
      <ul className="dm-wallet-list" aria-label="Wallet apps" data-wallet-apps={onPreview ? 'preview' : 'site'}>
        {apps.map(([id, name, href]) => (
          <li key={id}>
            <a className="dm-wallet-row" href={href} rel="noopener noreferrer">
              <span className="dm-wallet-logo"><WalletLogo id={id} /></span>
              <span className="sr-only">{'Open in '}</span>
              <span className="min-w-0 truncate">{name}</span>
              <IconChevronRight />
            </a>
          </li>
        ))}
      </ul>
      <p className="dm-wd-cap text-fg-muted">{OPEN_IN_WALLET_APP_NOTE}</p>
    </>
  )
}

/**
 * A computer with no wallet extension (audit C4): where to get one. Fixed links, each in a new tab. Changed on purpose
 * 2026-10-30 (QA round 2, N4, N77): what to do next in plain words, naming the two wallets, and the way on for a phone or
 * a tablet; the lines are the sheet's captions, in one ink.
 * Changed on purpose 2026-10-31 (QA round 2 follow-ups, R34): each link's name says it opens in a new tab, as every other
 * link that leaves the app does (Footer.tsx, ExplorerAddress.tsx); a screen reader heard only "MetaMask" and "Rabby". An
 * aria-label, so the sentence the eye reads stays as it is.
 */
function GetAWallet() {
  return (
    <>
      <p className="dm-wd-cap text-fg-muted">{NO_BROWSER_WALLET}</p>
      <p className="dm-wallet-get dm-wd-cap text-fg-muted">
        {'Install '}
        <a href="https://metamask.io/download/" target="_blank" rel="noopener noreferrer" aria-label="MetaMask (opens in a new tab)">MetaMask</a>
        {' or '}
        <a href="https://rabby.io/" target="_blank" rel="noopener noreferrer" aria-label="Rabby (opens in a new tab)">Rabby</a>
        {', then reload this page.'}
      </p>
      <p className="dm-wd-cap text-fg-muted">{NO_BROWSER_WALLET_PHONE}</p>
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
  const progress = useSignInProgress()
  const signing = ['switching', 'checking', 'signing', 'returning'].includes(progress.phase)
  // V4 (site/_kit.md .ch-dlg): a closed dialog stays drawn while its scrim fades and its sheet sinks away, a quarter of a
  // second, as nothing more than a picture: no dialog role, no name, hidden from assistive technology, inert and taking
  // no pointer, so nothing reaches it and the page behind is released at once (useDialog goes by its open flag).
  const [wasOpen, setWasOpen] = useState(open)
  const [closing, setClosing] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    setClosing(!open)
  }
  useEffect(() => {
    if (!closing) return
    const settle = window.setTimeout(() => setClosing(false), 260)
    return () => window.clearTimeout(settle)
  }, [closing])

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

  if (!open && !closing) return null

  const { view, identity, busy } = session
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
  // Changed on purpose 2026-10-06 (the review of the next update): the session held while the wallet is on another network
  // Domino uses or brings funds from (session/machine.ts heldAway) is signed in there, with Sign out, and no switch to
  // Robinhood Chain, which would take the wallet away from the network the page is using.
  const away = view.status === 'wrong_network' && session.away
  const status = waiting !== null ? (pairing ? null : approveIn(walletName(waiting.name))) : quiet ? null : signing || progress.phase === 'error' ? progress.message : describe(view, away)

  let actions: React.ReactNode = null
  if (waiting !== null) {
    actions = (
      <Button variant="ghost" onClick={cancelConnect}>
        Cancel
      </Button>
    )
  } else if (signing) {
    actions = <Button variant="ghost" onClick={() => signInFlow.cancel()}>Cancel sign-in</Button>
  } else if (progress.returnChain !== undefined && (view.status === 'signed_in' || away)) {
    actions = <Button onClick={() => void signInFlow.start()}>Switch back to {networkName(progress.returnChain)}</Button>
  } else {
    switch (view.status) {
      case 'wrong_network':
        actions = away ? (
          <Button onClick={() => sessionController.dispatch({ type: 'sign_out' })}>Sign out</Button>
        ) : (
          <>
            {disconnectButton}
            <Button onClick={() => void signInFlow.start()} disabled={pending || busy}>Sign in</Button>
          </>
        )
        break
      case 'signed_out':
        actions = (
          <>
            {disconnectButton}
            <Button onClick={() => void signInFlow.start()} disabled={busy}>Sign in</Button>
          </>
        )
        break
      case 'signing_in':
        if (view.step !== 'recovering' && view.step !== 'closing') {
          actions = (
            <Button variant="ghost" onClick={() => signInFlow.cancel()}>
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
      data-closing={open ? undefined : ''}
      aria-hidden={open ? undefined : true}
      inert={!open}
      onMouseDown={(e) => open && e.target === e.currentTarget && onClose()}
    >
      <Card
        level={2}
        role={open ? 'dialog' : undefined}
        aria-modal={open ? 'true' : undefined}
        aria-labelledby={open ? 'wallet-dialog-title' : undefined}
        aria-describedby={open && status ? 'wallet-dialog-status' : undefined}
        ref={dialog}
        className="dm-dialog dm-wd dm-lit"
      >
        {/* The seam under the head carries the sign-in's progress (data-phase) and a running light while the dialog waits
            on something it cannot measure (data-wait): V4 states/Wallet.html .seam-fill, .seam-run (shell.css). */}
        <div
          className="dm-wd-head relative grid gap-y-1 pr-10"
          data-phase={signing ? progress.phase : undefined}
          data-wait={(waiting !== null && !pairing) || (view.status === 'signing_in' && (view.step === 'recovering' || view.step === 'closing')) || busy ? '' : undefined}
        >
          <h2 id="wallet-dialog-title" tabIndex={-1} className="dm-dialog-title outline-none">
            {choosing ? 'Connect' : 'Wallet'}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="dm-wd-close dm-icon-btn dm-icon-btn--ghost dm-icon-btn--sm dm-press-icon absolute -top-1.5 -right-1.5">
            <IconClose />
          </button>
          {status && <p id="wallet-dialog-status" role={progress.phase === 'error' ? 'alert' : 'status'} className="dm-wd-status text-[0.8125rem] leading-[1.125rem] text-fg-muted" data-status={waiting ? 'connecting' : view.status}>
            {/* A changed sentence settles in (V4 .sw); the line itself stays, so it is announced as before. */}
            <span key={status} className="dm-wd-sw">{status}</span>
          </p>}
        </div>

        <div className="grid gap-3" aria-busy={busy || pending || waiting !== null || undefined}>
          {identity.kind === 'connected' && !choosing && (
            // Changed on purpose 2026-10-03 (the owner: "no need to say which wallet app it is", and the pill above with the
            // address below looked broken): one calm row, the address's disc, the short address and its state under it,
            // and Copy for the whole address (also its title). The wallet app's name is no longer shown.
            <div className="dm-wallet-id" data-wallet-state={view.status === 'signed_in' || away ? 'signed-in' : view.status === 'wrong_network' ? 'other-network' : 'connected'}>
              <span aria-hidden="true" className="dm-wallet-disc dm-wallet-id-disc" style={{ '--mark-h': 200 + (tokenHue(identity.address) % 120) } as CSSProperties} />
              <span className="dm-wallet-id-text">
                <span className="dm-wallet-id-address tnum" title={identity.address} data-testid="wallet-address" data-address={identity.address}>
                  {shortAddress(identity.address)}
                </span>
                <span className="dm-wallet-id-state">{view.status === 'signed_in' || away ? 'Signed in' : view.status === 'wrong_network' ? 'Connected, on another network' : 'Connected'}</span>
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
                  waiting={waiting?.uid === connector.uid}
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
          {(view.status === 'signed_in' || away || view.status === 'signed_out' || (view.status === 'wrong_network' && !away)) && (
            // Changed on purpose 2026-10-01 (audit E5): one plain sentence for what the session does; the docs' Sessions
            // and signing out says the rest.
            <p className="dm-wd-cap text-caption text-fg-subtle">Stays signed in while Domino is open, for up to 12 hours. You may need to sign in again after closing the site or losing your connection.</p>
          )}
          {(view.status === 'signed_out' || (view.status === 'wrong_network' && !away) || signing) && <p className="dm-wd-cap text-caption text-fg-subtle">Sign a message to continue. No transaction or network fee.</p>}

          {/* Changed on purpose 2026-10-30 (QA round 2, the owner's rule: no notices that something could not update): a
              renewal the service could not serve is asked again in the background with backoff (session/), and the
              dialog no longer says "could not renew your session just now". */}

          {shown && (
            <p role="alert" className="dm-wd-alert text-[0.8125rem] leading-[1.125rem]">
              {shown}
            </p>
          )}

        </div>

        {/* Keyed by the state it answers, so a new set of buttons rises in (V4 .foot-in). */}
        {actions && <div key={`${view.status}:${waiting ? 'w' : ''}:${signing}`} className="dm-wd-foot flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
          {actions}
        </div>}
      </Card>
    </div>,
    document.body,
  )
}
