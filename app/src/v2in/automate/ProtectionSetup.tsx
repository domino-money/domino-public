import { useMemo, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { AddressMark } from '../../components/automate/marks'
import { ExitPicture } from '../../components/automate-v4/AsidePictures'
import { NoPositionsArt } from '../../components/automate-v4/SeqPlateArt'
import { newPositionHref } from '../../components/explore/routes'
import { IconPlus } from '../../components/icons'
import { Button, Card, EmptyState, LinkButton, RangeBar, Skeleton } from '../../components/ui'
import { feeText, rangeView } from '../../lib/automate/picker'
import { ELYSIUM_LIVE, ELYSIUM_V2_ID } from '../../lib/elysiumIdentity'
import { feeWords } from '../../lib/format/fee'
import { v2Chain } from '../../v2/chains'
import type { V2Gate } from '../../v2/gate'
import type { Address, V2ChainId } from '../../v2/types'
import { MandateDialog, type ExitTarget } from '../autoexit/MandateDialog'
import { v2PositionHref } from '../route'
import { gateOpen, useElysiumGate, useGate } from './gate'
import { protectionPositions, protectionSelection, type ProtectionPosition } from './protectionPositions'
import { usePortfolio } from './read6'
import { setupWaiting, useSetupWaitOver } from './setupPositions'
import { automationState, sessionMandatesFor, sessionRevoked, subscribeAutomation } from './store'

type OpenGate = Exclude<V2Gate, { mode: 'off' }>
const joined = (vault: V2Gate | null, exit: V2Gate | null): OpenGate | null =>
  !gateOpen(vault) || !gateOpen(exit) ? null : vault.mode === 'preview' ? vault : exit.mode === 'preview' ? exit : vault

function Picker({ positions, selected, onSelect }: { positions: readonly ProtectionPosition[]; selected: string | null; onSelect: (key: string) => void }) {
  const focusable = selected ?? positions[0]?.key
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = (index + step + positions.length) % positions.length
    onSelect(positions[next].key)
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
  }
  return <div className="dm-seq-picker" role="radiogroup" aria-label="Your open positions">
    {positions.map(({ key, target, position }, index) => {
      const range = rangeView(position)
      return <button key={key} type="button" role="radio" aria-checked={selected === key} tabIndex={focusable === key ? 0 : -1}
        className="dm-seq-pick" data-protection-position={key} onClick={() => onSelect(key)} onKeyDown={(event) => move(event, index)}>
        <span className="dm-seq-pick-marks" aria-hidden="true">{target.tokens.map((token) => <AddressMark key={token.address} address={token.address} chainId={target.chainId} size={28} />)}</span>
        <span className="dm-seq-pick-name">
          <bdi className="dm-seq-pick-pair">{target.tokens.map((token) => token.label).join(' / ')}</bdi>
          <span className="dm-seq-pick-meta"><span className="dm-chip">{v2Chain(target.chainId).name}</span><span>{feeWords(feeText(position.fee))}</span><span className="dm-seq-pick-id">#{position.tokenId}</span></span>
        </span>
        <span className="dm-seq-pick-range" aria-hidden="true"><RangeBar lower={range.lower} upper={range.upper} current={range.current} inRange={range.inRange} /></span>
        <span className="dm-seq-pick-dot" aria-hidden="true" />
      </button>
    })}
  </div>
}

/** All enabled V2 networks share one picker; their existing money client owns consent, review, signatures and recovery. */
export default function ProtectionSetup({ owner, route }: { owner: string; route: string }) {
  const vault4663 = useGate('vault', 4663), exit4663 = useGate('autoExit', 4663)
  const vault8453 = useGate('vault', 8453), exit8453 = useGate('autoExit', 8453)
  const vault42161 = useGate('vault', 42161), exit42161 = useGate('autoExit', 42161)
  // Changed on purpose 2026-11-07 (Elysium as a fourth V2 chain): Elysium's gates, where the build serves it.
  const vault99901 = useElysiumGate('vault'), exit99901 = useElysiumGate('autoExit')
  const gates = { 4663: joined(vault4663, exit4663), 8453: joined(vault8453, exit8453), 42161: joined(vault42161, exit42161), ...(ELYSIUM_LIVE ? { [ELYSIUM_V2_ID]: joined(vault99901, exit99901) } : {}) } as Readonly<Record<V2ChainId, OpenGate | null>>
  const pending = (ELYSIUM_LIVE ? [vault4663, exit4663, vault8453, exit8453, vault42161, exit42161, vault99901, exit99901] : [vault4663, exit4663, vault8453, exit8453, vault42161, exit42161]).some((gate) => gate === null)
  const [version, setVersion] = useState(0)
  const waitOver = useSetupWaitOver()
  const answer = usePortfolio(owner as Address, null, version)
  const body = answer?.reply.kind === 'ok' ? answer.reply.body : null
  const list = useMemo(() => body ? protectionPositions(body, owner) : null, [body, owner])
  const store = useSyncExternalStore(subscribeAutomation, automationState, automationState)
  const positions = (list?.positions ?? []).filter(({ target }) => gates[target.chainId] && !sessionMandatesFor(store, target.chainId, owner as Address, target.tokenId, target.dex)
    .some((mandate) => mandate.registered && !sessionRevoked(store, target.chainId).has(mandate.id)))
  const requested = protectionSelection(route)
  const [selected, setSelected] = useState(requested)
  const chosen = positions.find((position) => position.key === selected) ?? null
  // Freeze the reviewed target while its dialog runs. A refresh after an approval must not tear down that run.
  const [dialog, setDialog] = useState<{ target: ExitTarget; gate: OpenGate } | null>(null)
  const dialogGate: OpenGate | null = dialog ? gates[dialog.target.chainId] ?? {
    mode: 'preview', chainId: dialog.target.chainId, contracts: dialog.gate.contracts, locked: true, lockedCopy: 'Auto-exit isn’t available right now.',
  } : null
  const missing = requested !== null && !positions.some((position) => position.key === requested)
  // Changed on purpose 2026-10-30 (QA round 2, final review shell-1): an NFT of the wallet on an open network that could not be
  // judged yet keeps the loading rows below, never the plate (./setupPositions.ts setupWaiting), for two minutes at most.
  const waiting = body !== null && !waitOver && setupWaiting(body, owner, positions.length, (chainId) => gates[chainId] !== null)
  const back = <LinkButton href="#/automate" variant="outline">Back</LinkButton>
  const newPosition = (variant: 'primary' | 'outline') => <LinkButton href={newPositionHref()} variant={variant} data-sequence-new-position=""><IconPlus />New position</LinkButton>
  const content = pending || (Object.values(gates).some(Boolean) && answer === null) ? <div className="dm-card dm-acct-block dm-seq-loading" aria-busy="true" data-sequence-positions="loading">
    {[0, 1, 2].map((row) => <Skeleton key={row} className="dm-seq-loading-row" />)}
  </div> : !Object.values(gates).some(Boolean) ? <div className="dm-acct-block"><p className="text-body text-fg-muted">Auto-exit isn’t available right now.</p>{back}</div>
    /* Changed on purpose 2026-10-30 (QA round 2, the owner's rule: missing information stays out of sight, and reads are
       asked again silently): a portfolio not read yet keeps the loading rows while ../lists/source.ts asks again by itself;
       it said "Your positions couldn’t be checked right now." with Try again. The marker stays. An answer that leaves a
       network behind with nothing to offer shows the plate at once (the list replaces it when that network is in). The
       plate is Set up automation's (SetupEntry.tsx, the owner's decision on N13): a position comes first, New position.
       Final review shell-1: not while one of the wallet's own NFTs on an open network waits to be judged (`waiting`). */
    : !list || waiting ? <div className="dm-card dm-acct-block dm-seq-loading" aria-busy="true" data-sequence-positions="failed">
      {[0, 1, 2].map((row) => <Skeleton key={row} className="dm-seq-loading-row" />)}
    </div> : !positions.length ? <EmptyState plate icon={<NoPositionsArt />} className="dm-acct-block dm-lit" data-sequence-positions="empty"
      title="No positions available for Auto-exit"
      body={missing ? 'This position isn’t available for a new Auto-exit. Check its status in Positions.' : 'Open a new position, then come back to set up Auto-exit.'}
      action={missing ? <><LinkButton href="#/positions" variant="primary">View positions</LinkButton>{newPosition('outline')}{back}</>
        : <>{newPosition('primary')}<LinkButton href="#/positions" variant="outline">View positions</LinkButton>{back}</>} /> : <>
      {missing && <p className="dm-acct-note" role="status" data-sequence-position-missing="">This position isn’t available for a new Auto-exit. Choose another position below.</p>}
      <Card className="dm-acct-block dm-acct-panel dm-seq-create" data-v2in-protection-setup="">
        <div className="dm-seq-grid">
          <div className="dm-seq-steps dm-lit"><fieldset className="dm-acct-fieldset">
            <legend className="dm-acct-subtitle"><span className="dm-seq-step" data-state={chosen ? 'done' : 'current'}>1</span><span className="sr-only"> · </span>Your position</legend>
            <Picker positions={positions} selected={chosen?.key ?? null} onSelect={setSelected} />
          </fieldset></div>
          <aside className="dm-seq-aside dm-lit" aria-label="Your Auto-exit" data-ember="">
            <div className="dm-auto-aside-heading"><h2>Auto-exit</h2></div>
            {/* V4 (the owner's approved site/sequence.html, Set up Auto-exit): Auto-exit's picture, playing once. */}
            <div className="dm-seq-pic" data-mode="protection"><div className="dm-seq-asc" data-scene="protection"><ExitPicture /></div></div>
            {/* Changed on purpose 2026-10-30 (QA round 2, N12 and the owner's Q1): no price is typed, and the fee in Automate's
                words, its base named. */}
            <p className="dm-seq-hint">Closes your position at the end of its range, with no price to set, and sends the tokens to your wallet.</p>
            <p className="dm-seq-hint">0.2% of the position’s value, only if it closes. No fee reinvestment.</p>
            <span className="dm-seq-seam" aria-hidden="true"><span className="dm-seam-lit" /></span>
            <Button type="button" variant="primary" size="xl" className="w-full" data-sequence-action="protection" disabled={!chosen}
              onClick={() => { if (chosen && gates[chosen.target.chainId]) setDialog({ target: chosen.target, gate: gates[chosen.target.chainId]! }) }}>Continue</Button>
            {!chosen && <p className="dm-flow-reason" data-align="start">Choose one of your positions.</p>}
          </aside>
        </div>
      </Card>
      <div className="dm-acct-block">{back}</div>
    </>
  return <>{content}{dialog && dialogGate && <MandateDialog target={dialog.target} gate={dialogGate} onClose={() => setDialog(null)}
    onChanged={() => setVersion((n) => n + 1)} done={{ label: 'View position', href: v2PositionHref(dialog.target) }} />}</>
}
