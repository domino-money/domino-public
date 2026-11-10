// Route styles stay out of Home's first paint.
import '../styles/screens.css'
import { lazy, Suspense, useSyncExternalStore, type ComponentType } from 'react'
import { recovering } from '../lib/staleRelease'
import { hashParts } from '../components/explore/routes'
import { sequenceIntent } from '../lib/create/sequenceDefaults'
import { useWalletIdentity } from '../lib/walletIdentity'
import type { SequenceIntent } from './SequenceCreate'
import { Frame, Loading, WalletPrompt } from './SequenceShell'
import { currentRoute, subscribeRoute } from '../lib/route'

// The inactive legacy catalogue and clients never enter a deployed V2 build. Changed on purpose 2026-10-30 (QA round 2,
// review): kept as the app's stand-in for code that did not arrive (not a read: nothing to ask again, and a release that
// replaced it has already reloaded the tab, ../lib/staleRelease.ts recovering), in the words every other section's uses
// (Positions.tsx, PositionLab.tsx); it said "Automation couldn’t be loaded. Reload to try again."
const unavailable = () => ({ default: () => <p role="alert" className="dm-acct-block text-body text-fg-muted">This section couldn’t load. Reload to try again.</p> })
type SetupEntryProps = { owner: string; intent: SequenceIntent }
const V2Setup = __DOMINO_V2__ ? lazy<ComponentType<SetupEntryProps>>(recovering(() => import('../v2in/automate/SetupEntry'), unavailable)) : null
const Protection = __DOMINO_V2__ ? lazy(recovering(() => import('../v2in/automate/ProtectionSetup'), unavailable)) : null
const Legacy = !__DOMINO_V2__ ? lazy(recovering(() => import('./SequenceLegacy'), unavailable)) : null

function V2Sequence() {
  const identity = useWalletIdentity()
  const hash = useSyncExternalStore(subscribeRoute, currentRoute, () => '')
  const protection = /^#\/sequence\/protection(?:\/|$)/.test(hash)
  // Selecting a position is a public read. Only its existing dialog requests the correct network before signing.
  const owner = identity.kind === 'connected' ? identity.address.toLowerCase() : null
  const intent = sequenceIntent(hashParts(hash).segments)
  // 2026-10-30 (QA round 2, the owner's decision on N13): the mode chosen on Automate names the page, before a wallet and
  // after it (the setup opens on that mode), so a returning wallet that reconnects on load never sees the title change.
  return <Frame protection={protection} mode={intent.mode}>
    {owner === null ? <WalletPrompt identity={identity} /> : V2Setup && <Suspense fallback={<Loading />}>
      {protection && Protection ? <Protection key={`${owner}|${hash}`} owner={owner} route={hash} /> : <V2Setup key={`${owner}|${hash}`} owner={owner} intent={intent} />}
    </Suspense>}
  </Frame>
}


export default function Sequence({ lab }: { lab?: string } = {}) {
  return Legacy ? <Suspense fallback={<Frame><Loading /></Frame>}><Legacy lab={lab} /></Suspense> : <V2Sequence />
}
