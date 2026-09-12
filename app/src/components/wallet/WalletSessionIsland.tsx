import { QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { WagmiProvider } from 'wagmi'
import { privateQueryClient } from '../../session/privateQuery'
import { walletConfig } from '../../wallet/config'
import { useSession } from '../../wallet/session'
import { Button, Pill } from '../ui'
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

  let label = <>Wallet</>
  if (view.status === 'no_wallet') label = <>Connect wallet</>
  else if (view.status === 'signed_out') label = <>Sign in</>
  else if (view.status === 'signed_in' && identity.kind === 'connected') {
    label = (
      <>
        <Pill tone="in">Signed in</Pill>
        <span className="sr-only">{' as '}</span>
        <span className="tnum font-mono">{shortAddress(identity.address)}</span>
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
