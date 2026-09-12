import { QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { WagmiProvider } from 'wagmi'
import { privateQueryClient } from '../../session/privateQuery'
import { walletConfig } from '../../wallet/config'
import { useSession } from '../../wallet/session'
import { Button } from '../ui'
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

  let label = <>Connect wallet</>
  if (identity.kind === 'connected') {
    label = (
      <>
        <span className="sr-only">{view.status === 'signed_in' ? 'Signed in as ' : 'Connected wallet '}</span>
        <span className="tnum font-mono">{shortAddress(identity.address)}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
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
            variant="outline"
            className="whitespace-nowrap"
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
