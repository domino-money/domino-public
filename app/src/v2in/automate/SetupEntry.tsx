import { useState, type ReactElement } from 'react'
import { Skeleton } from '../../components/ui'
import type { WalletPosition } from '../../lib/walletPositions'
import { gateOpen, useGate } from './gate'
import { protectionIntent } from './intent'
import { SetupFlow } from './SetupFlow'

/**
 * Set up automation's V2 mount (screens/Sequence.tsx, behind `__DOMINO_V2__`): where the vault's gate on Robinhood Chain
 * is `off`, V1's own screen exactly as Sequence.tsx built it; otherwise the same page with the vault's choices
 * (./SetupFlow.tsx). A link names the person's own choice: V1's `#/sequence/<mode>/<id>`, or the vault's
 * `#/sequence/protection[/<id>]`, which V1's reading of the link leaves out.
 */

export default function SetupEntry({ positions, intent, v1 }: {
  positions: readonly WalletPosition[]
  intent: { mode: 'compound' | 'domino' | null; tokenId: string | null }
  v1: ReactElement<{ intent: { mode: 'compound' | 'domino' | null; tokenId: string | null } }>
}) {
  const gate = useGate('vault', 4663)
  const exitGate = useGate('autoExit', 4663)
  const [own] = useState(() => (typeof window === 'undefined' ? null : protectionIntent(window.location.hash)) ?? intent)
  if (gate === null) {
    return (
      <div className="dm-card dm-acct-block dm-seq-loading" aria-busy="true" data-v2in-setup="reading">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="dm-seq-loading-row" />
        ))}
      </div>
    )
  }
  if (!gateOpen(gate)) return v1
  return <SetupFlow positions={positions} intent={own} gate={gate} exitGate={exitGate} />
}
