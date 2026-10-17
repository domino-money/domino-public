import { useEffect, useMemo, useState } from 'react'
import type { PortfolioResponse } from 'api-contracts/read-v6/types'
import { NoPositionsArt } from '../../components/automate-v4/SeqPlateArt'
import { Button, EmptyState, LinkButton, Skeleton } from '../../components/ui'
import { useCreatedPositions, useKeyedLatest } from '../lists/hooks'
import { OWN_PORTFOLIO } from '../lists/source'
import { gateOpen, useGate } from './gate'
import { setupIntent, setupKey } from './intent'
import { SetupFlow, type SetupGates } from './SetupFlow'
import { setupPositions, setupRetryDelay } from './setupPositions'

/** V2 setup reads the connected wallet's V2 portfolio, independently of the inactive V1 catalogue and release. */
export default function SetupEntry({ owner, intent }: {
  owner: string
  intent: { mode: 'compound' | 'domino' | null; tokenId: string | null }
}) {
  const vault4663 = useGate('vault', 4663), exit4663 = useGate('autoExit', 4663)
  const vault8453 = useGate('vault', 8453), exit8453 = useGate('autoExit', 8453)
  const vault42161 = useGate('vault', 42161), exit42161 = useGate('autoExit', 42161)
  const gates: SetupGates = { 4663: vault4663, 8453: vault8453, 42161: vault42161 }
  const exitGates: SetupGates = { 4663: exit4663, 8453: exit8453, 42161: exit42161 }
  const gate = [vault4663, vault8453, vault42161].find(gateOpen) ?? null
  const pending = [vault4663, vault8453, vault42161].some((value) => value === null)
  const [own] = useState(() => setupIntent(typeof window === 'undefined' ? `#/sequence/${intent.mode ?? ''}/${intent.tokenId ?? ''}` : window.location.hash))
  const wallet = owner.toLowerCase()
  const answer = useKeyedLatest(OWN_PORTFOLIO, gateOpen(gate) ? wallet : null)
  const creations = useCreatedPositions(wallet)
  const [held, setHeld] = useState<PortfolioResponse | null>(null)
  const body = held ?? (answer?.kind === 'ok' ? answer.body : null)
  const list = useMemo(() => body ? setupPositions(body, owner) : null, [body, owner])
  const [attempt, setAttempt] = useState(0)
  const [waitExpired, setWaitExpired] = useState(false)
  const created = creations.find(item => own.position && item.chainId === own.position.chainId && item.dex === own.position.dex && item.tokenId === own.position.tokenId.toString())
  const waitingForIndex = held === null && created !== undefined && !waitExpired
  const delay = held === null && body ? setupRetryDelay(body, owner, own.position, attempt) : null
  // Shared receipt catch-up waits for the real indexed NFT. A stored creation supplies no balance or eligibility.
  useEffect(() => {
    if (!created) return
    const timer = window.setTimeout(() => setWaitExpired(true), Math.max(0, created.observedAt + 300_000 - Date.now()))
    return () => window.clearTimeout(timer)
  }, [created])
  // Legacy deep links without a local receipt keep their brief retry; all retries respect the shared Retry-After.
  useEffect(() => {
    if (delay === null || waitingForIndex) return
    const timer = window.setTimeout(() => { setAttempt(n => n + 1); OWN_PORTFOLIO.again(wallet) }, delay)
    return () => window.clearTimeout(timer)
  }, [delay, waitingForIndex, wallet, attempt])
  const updating = waitingForIndex || delay !== null
  const retry = <Button type="button" variant="outline" size="sm" onClick={() => OWN_PORTFOLIO.again(wallet)}>Try again</Button>
  if (pending || (gateOpen(gate) && answer === null) || updating) return (
    <div className="dm-card dm-acct-block dm-seq-loading" aria-busy="true" data-v2in-setup="reading" data-sequence-positions="loading">
      {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the loading rows also while the position is
          read again after a transaction; it said "Updating your position…" (data-v2in-setup-updating marks it). */}
      {updating && <span hidden data-v2in-setup-updating="" />}
      {[0, 1, 2].map((row) => <Skeleton key={row} className="dm-seq-loading-row" />)}
    </div>
  )
  if (!gateOpen(gate)) return <p className="dm-acct-block text-body text-fg-muted" data-v2in-setup="unavailable">Automation isn’t available right now.</p>
  if (!body || !list || (list.incomplete && !list.positions.length)) return (
    <div className="dm-acct-block" data-sequence-positions="failed">
      <p className="text-body text-fg-muted">Your positions couldn’t be checked right now.</p>
      {retry}
    </div>
  )
  const positions = list.positions.filter((position) => gateOpen(gates[position.chainId]))
  const wanted = own.position ? setupKey(own.position) : null
  const missing = wanted !== null && !positions.some((position) => position.key === wanted)
  if (!positions.length) return (
    <EmptyState plate icon={<NoPositionsArt />} className="dm-acct-block dm-lit" data-sequence-positions="empty"
      title="No positions available for setup"
      body={missing ? 'This position isn’t available for a new automation. Check its status in Positions.' : 'Check your positions to see their current status and automation.'}
      action={<><LinkButton href="#/positions" variant="primary" size="lg">View positions</LinkButton>{missing && retry}</>} />
  )
  return <>
    {missing && <p className="dm-acct-note" role="status" data-sequence-position-missing="">This position isn’t available for a new automation. Choose another position below. {retry}</p>}
    {list.incomplete && <p className="dm-acct-note" role="status">Some positions couldn’t be checked. {retry}</p>}
    <SetupFlow positions={positions} portfolio={body} intent={own} gates={gates} exitGates={exitGates} onHold={setHeld} />
  </>
}
