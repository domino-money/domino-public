import { useEffect, useState } from 'react'
import { setupWallet } from '../finance/wallet'
import { atomicStatus } from '../finance/batch'
import type { ReleaseRead } from '../finance/release'
import type { SequenceDeployment } from '../finance/sequence'
import { connectSequence, watchSequenceRelease } from '../finance/sequenceLive'
import { EmptyState, LinkButton } from '../components/ui'
import { IconAutomate, IconPlus } from '../components/icons'
import { hashParts } from '../components/explore/routes'
import { sequenceIntent, type SequenceMode } from '../lib/create/sequenceDefaults'
import { pickerList } from '../lib/automate/picker'
import { useWalletIdentity, walletKey } from '../lib/walletIdentity'
import { useWalletAnswer, type WalletPosition, type WalletPositionsState } from '../lib/walletPositions'
import SequenceCreate, { type SequenceIntent } from './SequenceCreate'
import { Frame, Loading, WalletPrompt } from './SequenceShell'
import { currentRoute } from '../lib/route'

type Release = { kind: 'loading' } | ReleaseRead<SequenceDeployment>
const capabilities = () => setupWallet().then((wallet) => atomicStatus(wallet))

interface Lab {
  positions: readonly WalletPosition[]
  intent: SequenceIntent
}
function labSpec(text: string): Lab | null {
  try {
    const value: unknown = JSON.parse(decodeURIComponent(text))
    if (!value || typeof value !== 'object' || !Array.isArray((value as { positions?: unknown }).positions)) return null
    const { positions, mode, tokenId } = value as { positions: WalletPosition[]; mode?: unknown; tokenId?: unknown }
    const isMode = (text: unknown): text is SequenceMode => text === 'compound' || text === 'domino'
    return { positions, intent: { mode: isMode(mode) ? mode : null, tokenId: typeof tokenId === 'string' ? tokenId : null } }
  } catch {
    return null
  }
}


/** Retained for legacy builds and their fixture lab; eliminated as a whole from deployed V2. */
export default function LegacySequence({ lab: labText }: { lab?: string } = {}) {
  const [release, setRelease] = useState<Release>({ kind: 'loading' })
  const [lab] = useState(() => __DOMINO_TEST_HOOKS__ && labText ? labSpec(labText) : null)
  const [intent] = useState<SequenceIntent>(() => lab?.intent ?? sequenceIntent(hashParts(currentRoute()).segments))
  useEffect(() => watchSequenceRelease(setRelease), [])
  const identity = useWalletIdentity()
  const owner = walletKey(identity)?.split('|')[1] ?? null
  const answer = useWalletAnswer(owner)
  const read: WalletPositionsState = answer.phase === 'ready'
    ? { phase: 'ready', block: answer.answer.block, positions: answer.answer.positions }
    : answer.phase === 'retrying' ? { phase: 'loading' } : answer
  const list = pickerList(lab && owner ? { phase: 'ready', block: 0, positions: lab.positions } : read)
  let body
  if (release.kind === 'loading') body = <div hidden data-sequence-release="loading" />
  else if (release.kind === 'unavailable') body = <div className="dm-seq-empty dm-dots-plate">
    <span className="dm-empty-tile dm-seq-empty-tile" aria-hidden="true"><IconAutomate /></span>
    <p className="dm-acct-block text-body text-fg-muted" data-sequence-release="unavailable" data-sequence-release-reason={release.reason}
      title={`Sequence deployment unavailable: ${release.reason.replaceAll('_', ' ')}.`}>Automation can’t be set up here.</p>
  </div>
  else if (owner === null) body = <WalletPrompt identity={identity} />
  else if (list.kind === 'loading') body = <Loading />
  else if (list.kind === 'failed') body = <p className="dm-acct-block text-body text-fg-muted" data-sequence-release="available" data-sequence-positions="failed">Your positions couldn’t be read right now.</p>
  else if (list.kind === 'empty') body = <EmptyState plate icon={<IconAutomate />} className="dm-acct-block" data-sequence-release="available"
    data-sequence-positions="empty" title="No open positions" body="Automation runs on a position you hold. Open one first."
    action={<LinkButton href="/new" variant="primary" size="lg"><IconPlus />New position</LinkButton>} />
  else body = <SequenceCreate key={owner} positions={list.positions} intent={intent} connect={connectSequence} capabilities={capabilities} />
  return <Frame>{body}</Frame>
}

