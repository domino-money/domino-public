import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useConnectors, WagmiProvider, type Connector } from 'wagmi'
import type { WalletIdentity } from '../../session/machine'
import { walletConfig } from '../../wallet/config'
import { connectWallet, disconnectWallet, startIdentityFeed } from '../../wallet/port'
import { useDialog } from '../../lib/useDialog'
import { publishWalletIdentity, type WalletIdentityView } from '../../lib/walletIdentity'
import { Button, Card } from '../ui'
import { IconChevronDown, IconChevronRight, IconClose } from '../icons'
import { shortAddress } from './copy'
import { tokenHue } from '../../lib/format/tokenHue'
import { WalletLogo } from './WalletLogo'

/** The connection as the store outside this feature describes it: address, chain and connector name, nothing that identifies the provider instance. */
const toView = (identity: WalletIdentity): WalletIdentityView =>
  identity.kind === 'connected' ? { kind: 'connected', address: identity.address, chainId: identity.chainId, connectorName: identity.connectorName } : { kind: identity.kind }

/** Local connection only. Never imports or starts the server-session client. */
export default function LocalWalletIsland() {
  return <WagmiProvider config={walletConfig} reconnectOnMount={false}><LocalWalletControl /></WagmiProvider>
}

function LocalWalletControl() {
  const connectors = useConnectors()
  const [identity, setIdentity] = useState<WalletIdentity>({ kind: 'unknown' })
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const pending = useRef(false)
  const alive = useRef(true)
  const dialog = useDialog(open, () => setOpen(false))
  useEffect(() => {
    alive.current = true
    // Published outward as well: screens outside this feature may not import
    // it, so the address they mention comes from the store, never from here.
    const stop = startIdentityFeed((next) => { setIdentity(next); publishWalletIdentity(toView(next)); if (next.kind === 'connected') setNotice(null) })
    return () => { alive.current = false; stop() }
  }, [])
  useEffect(() => {
    const node = dialog.current
    if (open && node && !node.contains(document.activeElement)) node.querySelector<HTMLElement>('#local-wallet-title')?.focus()
  }, [open, identity, busy, dialog])

  async function connect(connector: Connector) {
    if (pending.current) return
    pending.current = true; setBusy(true); setNotice(null)
    try {
      const result = await connectWallet(connector)
      if (alive.current && result !== 'connected') setNotice(result === 'user_rejected' ? 'Your wallet declined the connection request.' : 'Your wallet could not connect.')
    } finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  async function disconnect() {
    if (pending.current) return
    pending.current = true; setBusy(true); setNotice(null)
    try { await disconnectWallet() }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  const connected = identity.kind === 'connected'
  const name = (text: string) => text.length > 40 ? `${text.slice(0, 39)}…` : text
  return <>
    <p role="status" aria-live="polite" className="sr-only">{connected ? `Connected wallet ${shortAddress(identity.address)}. Not signed in.` : identity.kind === 'disconnected' ? 'Wallet disconnected.' : ''}</p>
    <Button variant={connected ? 'outline' : 'soft'} className={connected ? 'dm-wallet-pill whitespace-nowrap' : 'whitespace-nowrap'} aria-haspopup="dialog" aria-expanded={open} title={connected ? identity.address : undefined} onClick={() => setOpen(true)}>
      {connected ? <><span aria-hidden="true" className="dm-wallet-disc" style={{ '--mark-h': 200 + (tokenHue(identity.address) % 120) } as CSSProperties} /><span className="sr-only">Connected wallet </span><span className="tnum font-mono text-[13px] tracking-normal">{shortAddress(identity.address)}</span><IconChevronDown size={14} className="text-fg-subtle" /></> : 'Connect wallet'}
    </Button>
    {open && createPortal(
      <div role="presentation" className="dm-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
        <Card level={2} role="dialog" aria-modal="true" aria-labelledby="local-wallet-title" aria-describedby={connected ? 'local-wallet-status' : undefined} ref={dialog} className="dm-dialog">
          <div className="relative grid gap-y-1 pr-10">
            <h2 id="local-wallet-title" tabIndex={-1} className="dm-dialog-title outline-none">{connected ? 'Wallet' : 'Connect'}</h2>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="dm-icon-btn dm-icon-btn--ghost dm-icon-btn--sm dm-press-icon absolute -top-1.5 -right-1.5"><IconClose /></button>
            {connected && <p id="local-wallet-status" className="text-[13px] leading-[18px] text-fg-muted">Connected · Not signed in</p>}
          </div>
          <div className="grid gap-3" aria-busy={busy || undefined}>
            {connected ? <>
              <div className="dm-inset px-3 py-2.5"><p className="text-caption text-fg-subtle"><bdi>{name(identity.connectorName)}</bdi></p><p className="tnum break-all font-mono text-[13px] leading-[18px] tracking-normal" data-testid="local-wallet-address">{identity.address}</p></div>
              <p className="text-caption text-fg-subtle">Sign-in and transactions are unavailable in this local read-only environment.</p>
              {identity.chainId !== 4663 && <p className="text-caption text-fg-subtle">Wallet network: {identity.chainId}. Public reads remain on Robinhood Chain.</p>}
            </> : connectors.length === 0 ? <p className="text-[13px] leading-[18px] text-fg-muted">No browser wallet detected. Open this local site in a browser with your wallet extension.</p> :
              <ul className="dm-wallet-list" aria-label="Browser wallets">{connectors.map((connector) => <li key={connector.uid}><button type="button" className="dm-wallet-row" disabled={busy} onClick={() => void connect(connector)}><span className="dm-wallet-logo"><WalletLogo id={connector.id} /></span><span className="sr-only">Connect </span><bdi className="min-w-0 truncate">{name(connector.name)}</bdi><IconChevronRight /></button></li>)}</ul>}
            {notice && <p role="alert" className="text-[13px] leading-[18px] text-money-out">{notice}</p>}
          </div>
          {connected && <div className="flex justify-end border-t border-line pt-3"><Button variant="ghost" size="sm" disabled={busy} onClick={() => void disconnect()}>Disconnect wallet</Button></div>}
        </Card>
      </div>, document.body,
    )}
  </>
}
