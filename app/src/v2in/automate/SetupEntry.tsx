import { useEffect, useMemo, useState } from 'react'
import type { PortfolioResponse } from 'api-contracts/read-v6/types'
import { NoPositionsArt } from '../../components/automate-v4/SeqPlateArt'
import { newPositionHref } from '../../components/explore/routes'
import { IconPlus } from '../../components/icons'
import { EmptyState, LinkButton, Skeleton } from '../../components/ui'
import { useCreatedPositions, useKeyedLatest } from '../lists/hooks'
import { OWN_PORTFOLIO } from '../lists/source'
import { gateOpen, useGate } from './gate'
import { setupIntent, setupKey } from './intent'
import { SetupFlow, type SetupGates } from './SetupFlow'
import { setupPositions, setupRetryDelay, setupWaiting, useSetupWaitOver } from './setupPositions'

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
  const waitOver = useSetupWaitOver()
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
  if (pending || (gateOpen(gate) && answer === null) || updating) return (
    <div className="dm-card dm-acct-block dm-seq-loading" aria-busy="true" data-v2in-setup="reading" data-sequence-positions="loading">
      {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the loading rows also while the position is
          read again after a transaction; it said "Updating your position…" (data-v2in-setup-updating marks it). */}
      {updating && <span hidden data-v2in-setup-updating="" />}
      {[0, 1, 2].map((row) => <Skeleton key={row} className="dm-seq-loading-row" />)}
    </div>
  )
  if (!gateOpen(gate)) return <p className="dm-acct-block text-body text-fg-muted" data-v2in-setup="unavailable">Automation isn’t available right now.</p>
  // Changed on purpose 2026-10-30 (QA round 2, the owner's rule: missing information stays out of sight, and reads are asked
  // again silently): a portfolio not read yet keeps the loading rows while ../lists/source.ts asks again by itself (after a
  // failure with backoff); it said "Your positions couldn’t be checked right now." with Try again. The marker stays. An
  // answer that came back but leaves a network behind (or is cut short) with nothing to offer shows the plate below at once,
  // never endless loading rows: the same source asks again (30 s), and the list replaces the plate when that network is in.
  // Changed on purpose 2026-10-30 (QA round 2, final review shell-1): but an NFT of the wallet on an open network that could
  // not be judged (its network or its reading not fresh yet) keeps the loading rows: the plate would tell its owner there is
  // no position and offer a second deposit. The same 30 s re-ask replaces the rows with the list; after two minutes
  // (SETUP_WAIT_MS) the plate is said all the same, as read-v6 can keep an NFT unjudged for good.
  const positions = list ? list.positions.filter((position) => gateOpen(gates[position.chainId])) : []
  if (!body || !list || (!waitOver && setupWaiting(body, owner, positions.length, (chainId) => gateOpen(gates[chainId])))) return (
    <div className="dm-card dm-acct-block dm-seq-loading" aria-busy="true" data-sequence-positions="failed">
      {[0, 1, 2].map((row) => <Skeleton key={row} className="dm-seq-loading-row" />)}
    </div>
  )
  const wanted = own.position ? setupKey(own.position) : null
  const missing = wanted !== null && !positions.some((position) => position.key === wanted)
  // Changed on purpose 2026-10-30 (QA round 2, the owner's decision on N13): with nothing to set up, the plate says a position
  // comes first and offers New position beside View positions (no dead end); the button its sentence names leads. Try again
  // went with the rule above: the position asked for is read again by itself (setupRetryDelay), and positions not read yet
  // stay out of the list.
  const newPosition = (variant: 'primary' | 'outline') => <LinkButton href={newPositionHref()} variant={variant} size="lg" data-sequence-new-position=""><IconPlus />New position</LinkButton>
  const viewPositions = (variant: 'primary' | 'outline') => <LinkButton href="#/positions" variant={variant} size="lg">View positions</LinkButton>
  if (!positions.length) return (
    <EmptyState plate icon={<NoPositionsArt />} className="dm-acct-block dm-lit" data-sequence-positions="empty"
      title="No positions available for setup"
      body={missing ? 'This position isn’t available for a new automation. Check its status in Positions.' : 'Open a new position, then come back to automate it.'}
      action={missing ? <>{viewPositions('primary')}{newPosition('outline')}</> : <>{newPosition('primary')}{viewPositions('outline')}</>} />
  )
  return <>
    {missing && <p className="dm-acct-note" role="status" data-sequence-position-missing="">This position isn’t available for a new automation. Choose another position below.</p>}
    <SetupFlow positions={positions} portfolio={body} intent={own} gates={gates} exitGates={exitGates} onHold={setHeld} />
  </>
}
