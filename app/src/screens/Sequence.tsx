// The screens' own styles (styles/screens.css, F8): loaded with the first screen that needs them, never on Home's first paint.
import '../styles/screens.css'
import { lazy, Suspense, useEffect, useState, type ComponentType, type ReactElement } from 'react'
import { setupWallet } from '../finance/wallet'
import { useRouteTitle } from '../lib/routeTitle'
import { recovering } from '../lib/staleRelease'
import { atomicStatus } from '../finance/batch'
import type { ReleaseRead } from '../finance/release'
import type { SequenceDeployment } from '../finance/sequence'
import { connectSequence, watchSequenceRelease } from '../finance/sequenceLive'
import { SWITCH_NOTICE, switchToRobinhood } from '../wallet/port'
import { Button, Display, EmptyState, LinkButton, Skeleton } from '../components/ui'
import { IconAutomate, IconPlus, IconWallet } from '../components/icons'
import { hashParts } from '../components/explore/routes'
import { sequenceIntent, type SequenceMode } from '../lib/create/sequenceDefaults'
import { pickerList } from '../lib/automate/picker'
import { useWalletIdentity, walletKey } from '../lib/walletIdentity'
import { useWalletAnswer, type WalletPosition, type WalletPositionsState } from '../lib/walletPositions'
import SequenceCreate, { type SequenceIntent } from './SequenceCreate'

type Release = { kind: 'loading' } | ReleaseRead<SequenceDeployment>

/** What the connected wallet can do with a batch (EIP-5792): read once by the creation screen, which offers one signature for it. */
const capabilities = () => setupWallet().then((wallet) => atomicStatus(wallet))

// Domino V2 (integration, 2026-10-02): the vault's choices in this same flow, only in a build that carries V2 (the define
// is false in both deployable builds, so this is null there and nothing of it is bundled); src/v2in/automate/SetupEntry.tsx
// shows V1's own screen below wherever the vault's gate is off.
// A chunk that cannot load leaves V1's own screen, handed in as `v1` (2026-10-03, review #7).
type SetupEntryProps = { positions: readonly WalletPosition[]; intent: SequenceIntent; v1: ReactElement<{ intent: SequenceIntent }> }
const V2Setup = __DOMINO_V2__ ? lazy<ComponentType<SetupEntryProps>>(recovering(() => import('../v2in/automate/SetupEntry'), () => ({ default: ({ v1 }: SetupEntryProps) => v1 }))) : null

/** Test builds only (App.tsx routes `#/sequence-lab/<spec>` behind __DOMINO_TEST_HOOKS__): the wallet's positions injected, as useWalletPositions would answer them. */
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

const openWallet = () => document.querySelector<HTMLButtonElement>('header [aria-haspopup="dialog"]')?.click()

/**
 * Auto-compound and Domino-compound on one of the wallet's positions (the
 * owner's simpler page, 2026-09-24). The public release is read once on
 * mount; with none published, one plain line says automation can't be set up
 * here. With one: the wallet's open positions to choose from, then the guided
 * choices and one button (SequenceCreate). No NFT id or address is typed, and
 * how the processes work is on the docs pages.
 */
export default function Sequence({ lab: labText }: { lab?: string } = {}) {
  // The tab's name (lib/routeTitle.ts, audit E11).
  useRouteTitle('Set up automation')
  const [release, setRelease] = useState<Release>({ kind: 'loading' })
  const [lab] = useState(() => (__DOMINO_TEST_HOOKS__ && labText ? labSpec(labText) : null))
  // What the link asked for (#/sequence/<mode>/<nft>): the mode is chosen, and the position is chosen when it is one of the wallet's.
  const [intent] = useState<SequenceIntent>(() => lab?.intent ?? sequenceIntent(hashParts(window.location.hash).segments))
  useEffect(() => watchSequenceRelease(setRelease), [])
  const identity = useWalletIdentity()
  // 2026-10-01 (audit C1): the network switch says how it ended, in the wallet dialog's words; it used to say nothing.
  const [switching, setSwitching] = useState(false)
  const [switchNotice, setSwitchNotice] = useState<string | null>(null)
  const switchNetwork = async () => {
    if (switching) return
    setSwitching(true)
    setSwitchNotice(null)
    try {
      const result = await switchToRobinhood()
      setSwitchNotice(result === 'switched' ? null : SWITCH_NOTICE[result])
    } finally {
      setSwitching(false)
    }
  }
  const key = walletKey(identity)
  const owner = key === null ? null : key.slice(key.indexOf('|') + 1)
  // A link to a position just created (New position's success, #/sequence/<mode>/<id>): a read of the chain from a node
  // still behind its mint does not have it yet, so the list is asked again (a few times, by the read itself: RPC fix round
  // 2, walletPositions.ts askWallet); SequenceCreate chooses it when it arrives.
  // Only for an id Create position made during this visit, by this wallet: any other id missing from the list is not one
  // of the wallet's Domino positions, and costs no second read (review of 2026-09-24).
  const answer = useWalletAnswer(owner ? owner.toLowerCase() : null)
  // A read being asked again on its own is still loading: the picker never says "No open positions" for a failed read.
  const read: WalletPositionsState =
    answer.phase === 'ready' ? { phase: 'ready', block: answer.answer.block, positions: answer.answer.positions } : answer.phase === 'retrying' ? { phase: 'loading' } : answer
  const positions: WalletPositionsState = lab && owner ? { phase: 'ready', block: 0, positions: lab.positions } : read
  const list = pickerList(positions)

  let body
  if (release.kind === 'loading') body = <div hidden data-sequence-release="loading" />
  else if (release.kind === 'unavailable')
    body = (
      <div className="dm-seq-empty dm-dots-plate">
        <span className="dm-empty-tile dm-seq-empty-tile" aria-hidden="true">
          <IconAutomate />
        </span>
        <p className="dm-acct-block text-body text-fg-muted" data-sequence-release="unavailable" data-sequence-release-reason={release.reason} title={`Sequence deployment unavailable: ${release.reason.replaceAll('_', ' ')}.`}>
          Automation can’t be set up here.
        </p>
      </div>
    )
  // 2026-10-01 (audit C5): the wallet control is still finding the wallet; "Connect your wallet" flashed here meanwhile.
  else if (owner === null && identity.kind === 'unknown')
    body = (
      <div className="dm-card dm-acct-block dm-seq-loading" data-sequence-release="available" data-sequence-wallet="waiting" aria-busy="true">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="dm-seq-loading-row" />
        ))}
      </div>
    )
  else if (owner === null) {
    const elsewhere = identity.kind === 'connected'
    body = (
      <EmptyState
        plate
        icon={<IconWallet />}
        className="dm-acct-block"
        data-sequence-release="available"
        data-sequence-wallet={elsewhere ? 'other-network' : 'none'}
        title={elsewhere ? 'Switch to Robinhood Chain' : 'Connect your wallet'}
        body="Your open positions appear here to choose from."
        action={
          <>
            <Button type="button" variant="primary" size="lg" aria-busy={switching || undefined} disabled={switching} onClick={() => (elsewhere ? void switchNetwork() : openWallet())}>
              {elsewhere ? (switching ? 'Switching…' : 'Switch network') : 'Connect wallet'}
            </Button>
            {elsewhere && switchNotice && (
              <p role="alert" className="mt-3 text-[0.8125rem] leading-[1.125rem] text-fg-muted" data-sequence-switch-notice="">
                {switchNotice}
              </p>
            )}
          </>
        }
      />
    )
  } else if (list.kind === 'loading')
    body = (
      <div className="dm-card dm-acct-block dm-seq-loading" data-sequence-release="available" data-sequence-positions="loading" aria-busy="true">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="dm-seq-loading-row" />
        ))}
      </div>
    )
  else if (list.kind === 'failed')
    body = (
      <p className="dm-acct-block text-body text-fg-muted" data-sequence-release="available" data-sequence-positions="failed">
        Your positions couldn’t be read right now.
      </p>
    )
  else if (list.kind === 'empty')
    body = (
      <EmptyState
        plate
        icon={<IconAutomate />}
        className="dm-acct-block"
        data-sequence-release="available"
        data-sequence-positions="empty"
        title="No open positions"
        body="Automation runs on a position you hold. Open one first."
        action={
          <LinkButton href="#/new" variant="primary" size="lg">
            <IconPlus />
            New position
          </LinkButton>
        }
      />
    )
  else
    body = V2Setup ? (
      <Suspense fallback={<div className="dm-card dm-acct-block dm-seq-loading" aria-busy="true" />}>
        <V2Setup positions={list.positions} intent={intent} v1={<SequenceCreate key={owner} positions={list.positions} intent={intent} connect={connectSequence} capabilities={capabilities} />} />
      </Suspense>
    ) : (
      <SequenceCreate key={owner} positions={list.positions} intent={intent} connect={connectSequence} capabilities={capabilities} />
    )

  return (
    <main className="dm-page dm-page--narrow dm-seq">
      <Display as="h1" className="dm-display-title">
        Set up automation
      </Display>
      <p className="dm-acct-lede">Choose a position and what its earned fees do.</p>
      {body}
    </main>
  )
}
