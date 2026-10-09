// Route styles stay out of Home's first paint.
import '../styles/screens.css'
import { lazy, Suspense, useSyncExternalStore, type ComponentType } from 'react'
import { recovering } from '../lib/staleRelease'
import { hashParts } from '../components/explore/routes'
import { sequenceIntent } from '../lib/create/sequenceDefaults'
import { useWalletIdentity, walletKey } from '../lib/walletIdentity'
import type { SequenceIntent } from './SequenceCreate'
import { Frame, Loading, WalletPrompt } from './SequenceShell'

// The inactive legacy catalogue and clients never enter a deployed V2 build.
const unavailable = () => ({ default: () => <p className="dm-acct-block text-body text-fg-muted">Automation couldn’t be loaded. Reload to try again.</p> })
type SetupEntryProps = { owner: string; intent: SequenceIntent }
const V2Setup = __DOMINO_V2__ ? lazy<ComponentType<SetupEntryProps>>(recovering(() => import('../v2in/automate/SetupEntry'), unavailable)) : null
const Protection = __DOMINO_V2__ ? lazy(recovering(() => import('../v2in/automate/ProtectionSetup'), unavailable)) : null
const Legacy = !__DOMINO_V2__ ? lazy(recovering(() => import('./SequenceLegacy'), unavailable)) : null

const subscribeRoute = (changed: () => void) => {
  window.addEventListener('hashchange', changed)
  return () => window.removeEventListener('hashchange', changed)
}

function V2Sequence() {
  const identity = useWalletIdentity()
  const hash = useSyncExternalStore(subscribeRoute, () => window.location.hash, () => '')
  const protection = /^#\/sequence\/protection(?:\/|$)/.test(hash)
  // Selecting a position is a public read. Only its existing dialog requests the correct network before signing.
  const owner = protection && identity.kind === 'connected' ? identity.address.toLowerCase() : walletKey(identity)?.split('|')[1] ?? null
  const intent = sequenceIntent(hashParts(hash).segments)
  return <Frame protection={protection}>
    {owner === null ? <WalletPrompt identity={identity} /> : V2Setup && <Suspense fallback={<Loading />}>
      {protection && Protection ? <Protection key={`${owner}|${hash}`} owner={owner} route={hash} /> : <V2Setup key={`${owner}|${hash}`} owner={owner} intent={intent} />}
    </Suspense>}
  </Frame>
}


export default function Sequence({ lab }: { lab?: string } = {}) {
  return Legacy ? <Suspense fallback={<Frame><Loading /></Frame>}><Legacy lab={lab} /></Suspense> : <V2Sequence />
}
