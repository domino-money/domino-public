import { QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState, type CSSProperties } from 'react'
import { WagmiProvider } from 'wagmi'
import { publishWalletIdentity } from '../../lib/walletIdentity'
import { privateQueryClient } from '../../session/privateQuery'
import { walletConfig } from '../../wallet/config'
import { useSession } from '../../wallet/session'
import { Button } from '../ui'
import { IconChevronDown } from '../icons'
import { tokenHue } from '../../lib/format/tokenHue'
import { announcement, shortAddress } from './copy'
import { PrivateReadProbe } from './PrivateReadProbe'
import { WalletSessionDialog } from './WalletSessionDialog'

/**
 * The wallet session feature, loaded as its own chunk and only in builds that
 * enable it. It owns its providers, so nothing outside the header changes:
 * the pools table, the positions screen and settings render exactly as before.
 */
export default function WalletSessionIsland() {
  return (
    <WagmiProvider config={walletConfig} reconnectOnMount={false}>
      <QueryClientProvider client={privateQueryClient}>
        <WalletControl />
        {__DOMINO_TEST_HOOKS__ && <PrivateReadProbe />}
      </QueryClientProvider>
    </WagmiProvider>
  )
}

function WalletControl() {
  const session = useSession()
  const [open, setOpen] = useState(false)
  const { view, identity } = session

  // Published outward for the screens that mention the connected address;
  // they may not import this feature, so the store is their only way in.
  // A connection, not the session: signed-in or not is never published.
  useEffect(() => {
    publishWalletIdentity(
      identity.kind === 'connected'
        ? { kind: 'connected', address: identity.address, chainId: identity.chainId, connectorName: identity.connectorName }
        : { kind: identity.kind },
    )
  }, [identity])

  let label = <>Connect wallet</>
  if (identity.kind === 'connected') {
    label = (
      <>
        <span aria-hidden="true" className="dm-wallet-disc" style={{ '--mark-h': 200 + (tokenHue(identity.address) % 120) } as CSSProperties} />
        <span className="sr-only">{view.status === 'signed_in' ? 'Signed in as ' : 'Connected wallet '}</span>
        <span className="tnum font-mono text-[13px] tracking-normal">{shortAddress(identity.address)}</span>
        <IconChevronDown size={14} className="text-fg-subtle" />
      </>
    )
  }

  return (
    <>
      {/* Announces every change, including an account switch that happens
          while the dialog is closed or the landing page is showing. */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement(session)}
      </p>
      {(
        <>
          <Button
            variant={identity.kind === 'connected' ? 'outline' : 'soft'}
            className={identity.kind === 'connected' ? 'dm-wallet-pill whitespace-nowrap' : 'whitespace-nowrap'}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-busy={session.busy || undefined}
            title={identity.kind === 'connected' ? identity.address : undefined}
            onClick={() => setOpen(true)}
          >
            {label}
          </Button>
          <WalletSessionDialog open={open} onClose={() => setOpen(false)} session={session} />
        </>
      )}
    </>
  )
}
