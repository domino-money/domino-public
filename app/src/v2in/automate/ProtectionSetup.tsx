import { useMemo, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { AddressMark } from '../../components/automate/marks'
import { IconAutomate } from '../../components/icons'
import { Button, Card, EmptyState, LinkButton, RangeBar, Skeleton } from '../../components/ui'
import { feeText, rangeView } from '../../lib/automate/picker'
import { feeWords } from '../../lib/format/fee'
import { v2Chain } from '../../v2/chains'
import type { V2Gate } from '../../v2/gate'
import type { Address } from '../../v2/types'
import { MandateDialog, type ExitTarget } from '../autoexit/MandateDialog'
import { v2PositionHref } from '../route'
import { gateOpen, useGate } from './gate'
import { protectionPositions, protectionSelection, type ProtectionPosition } from './protectionPositions'
import { usePortfolio } from './read6'
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
  const gates = { 4663: joined(vault4663, exit4663), 8453: joined(vault8453, exit8453), 42161: joined(vault42161, exit42161) }
  const pending = [vault4663, exit4663, vault8453, exit8453, vault42161, exit42161].some((gate) => gate === null)
  const [version, setVersion] = useState(0)
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
  const retry = <Button type="button" variant="outline" size="sm" onClick={() => setVersion((n) => n + 1)}>Try again</Button>
  const missing = requested !== null && !positions.some((position) => position.key === requested)
  const back = <LinkButton href="#/automate" variant="outline">Back</LinkButton>
  const content = pending || (Object.values(gates).some(Boolean) && answer === null) ? <div className="dm-card dm-acct-block dm-seq-loading" aria-busy="true" data-sequence-positions="loading">
    {[0, 1, 2].map((row) => <Skeleton key={row} className="dm-seq-loading-row" />)}
  </div> : !Object.values(gates).some(Boolean) ? <div className="dm-acct-block"><p className="text-body text-fg-muted">Auto-exit isn’t available right now.</p>{back}</div>
    : !list || (list.incomplete && !positions.length) ? <div className="dm-acct-block" data-sequence-positions="failed">
      <p className="text-body text-fg-muted">Your positions couldn’t be checked right now.</p>{retry} {back}
    </div> : !positions.length ? <EmptyState plate icon={<IconAutomate />} className="dm-acct-block" data-sequence-positions="empty"
      title="No positions available for Auto-exit" body="Check your positions to see their current status and automation."
      action={<><LinkButton href="#/positions" variant="primary">View positions</LinkButton>{back}</>} /> : <>
      {missing && <p className="dm-acct-note" role="status" data-sequence-position-missing="">This position isn’t available for a new Auto-exit. Choose another position below.</p>}
      {list.incomplete && <p className="dm-acct-note" role="status">Some positions couldn’t be checked. {retry}</p>}
      <Card className="dm-acct-block dm-acct-panel dm-seq-create" data-v2in-protection-setup="">
        <div className="dm-seq-grid">
          <div className="dm-seq-steps"><fieldset className="dm-acct-fieldset">
            <legend className="dm-acct-subtitle"><span className="dm-seq-step" data-state={chosen ? 'done' : 'current'}>1</span><span className="sr-only"> · </span>Your position</legend>
            <Picker positions={positions} selected={chosen?.key ?? null} onSelect={setSelected} />
          </fieldset></div>
          <aside className="dm-seq-aside" aria-label="Your Auto-exit">
            <div className="dm-auto-aside-heading"><h2>Auto-exit</h2></div>
            <p className="dm-seq-hint">Closes your position at the end of its range and sends the tokens to your wallet.</p>
            <p className="dm-seq-hint">0.2% only if it closes. No fee reinvestment.</p>
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
