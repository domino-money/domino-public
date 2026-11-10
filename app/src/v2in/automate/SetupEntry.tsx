import { useEffect, useMemo, useState } from 'react'
import type { PortfolioResponse } from 'api-contracts/read-v6/types'
import { NoPositionsArt } from '../../components/automate-v4/SeqPlateArt'
import { newPositionHref } from '../../components/explore/routes'
import { IconPlus } from '../../components/icons'
import { EmptyState, LinkButton, Skeleton } from '../../components/ui'
import { useCreatedPositions, useKeyed } from '../lists/hooks'
import { UNJUDGED_ASK_MS, useNewPositionWait, useQuickPortfolio } from '../lists/newPositionWait'
import { OWN_PORTFOLIO } from '../lists/source'
import { ADDING_POSITION, RELOAD_WORDS, useWaitOver } from '../../lib/readWait'
import { ELYSIUM_LIVE, ELYSIUM_V2_ID } from '../../lib/elysiumIdentity'
import { gateOpen, useElysiumGate, useGate } from './gate'
import { setupIntent, setupKey } from './intent'
import { SetupFlow, type SetupGates } from './SetupFlow'
import { setupPositions, setupRetryDelay, setupWaiting, useSetupWaitOver } from './setupPositions'
import { currentRoute } from '../../lib/route'

/** V2 setup reads the connected wallet's V2 portfolio, independently of the inactive V1 catalogue and release. */
export default function SetupEntry({ owner, intent }: {
  owner: string
  intent: { mode: 'compound' | 'domino' | null; tokenId: string | null }
}) {
  const vault4663 = useGate('vault', 4663), exit4663 = useGate('autoExit', 4663)
  const vault8453 = useGate('vault', 8453), exit8453 = useGate('autoExit', 8453)
  const vault42161 = useGate('vault', 42161), exit42161 = useGate('autoExit', 42161)
  // Changed on purpose 2026-11-07 (Elysium as a fourth V2 chain): Elysium's gates, where the build serves it.
  const vault99901 = useElysiumGate('vault'), exit99901 = useElysiumGate('autoExit')
  const gates = { 4663: vault4663, 8453: vault8453, 42161: vault42161, ...(ELYSIUM_LIVE ? { [ELYSIUM_V2_ID]: vault99901 } : {}) } as SetupGates
  const exitGates = { 4663: exit4663, 8453: exit8453, 42161: exit42161, ...(ELYSIUM_LIVE ? { [ELYSIUM_V2_ID]: exit99901 } : {}) } as SetupGates
  const vaults = ELYSIUM_LIVE ? [vault4663, vault8453, vault42161, vault99901] : [vault4663, vault8453, vault42161]
  const gate = vaults.find(gateOpen) ?? null
  const pending = vaults.some((value) => value === null)
  const [own] = useState(() => setupIntent(typeof window === 'undefined' ? `/sequence/${intent.mode ?? ''}/${intent.tokenId ?? ''}` : currentRoute()))
  const wallet = owner.toLowerCase()
  // Changed on purpose 2026-11-09 (core flows, the owner: nothing may load forever): the last good portfolio answer, as the
  // Positions list keeps it (useKeyed). It took the latest attempt (useKeyedLatest), so one failed refresh put the loading
  // rows back with no end; the money client still checks the chain again before anything is sent.
  const answer = useKeyed(OWN_PORTFOLIO, gateOpen(gate) ? wallet : null)
  const creations = useCreatedPositions(wallet)
  const [held, setHeld] = useState<PortfolioResponse | null>(null)
  const body = held ?? (answer?.kind === 'ok' ? answer.body : null)
  const list = useMemo(() => body ? setupPositions(body, owner) : null, [body, owner])
  const [attempt, setAttempt] = useState(0)
  const waitOver = useSetupWaitOver()
  const created = creations.find(item => own.position && item.chainId === own.position.chainId && item.dex === own.position.dex && item.tokenId === own.position.tokenId.toString())
  // Added 2026-11-09 (core flows): a portfolio that has only ever failed says what to do once it has failed for STUCK_MS
  // (below), also while a new position is awaited; it is still asked again by itself, and the list replaces the line the
  // moment an answer comes.
  const stuck = useWaitOver(gateOpen(gate) && held === null && answer !== null && answer.kind !== 'ok')
  // Shared receipt catch-up waits for the real indexed NFT. A stored creation supplies no balance or eligibility.
  // Changed on purpose 2026-11-09 (core flows): asked again every few seconds meanwhile (../lists/newPositionWait.ts), never
  // sooner than a Retry-After; it waited on the portfolio's 30 s pace, up to five minutes of bare loading rows.
  const awaiting = useNewPositionWait(created)
  const waitingForIndex = held === null && created !== undefined && awaiting && !stuck
  useQuickPortfolio(wallet, waitingForIndex)
  // Changed on purpose 2026-11-09 (core flows): while an NFT of the wallet waits to be judged (below, `setupWaiting`), the
  // portfolio is asked again every UNJUDGED_ASK_MS rather than on its 30 s pace, so the list replaces the rows sooner.
  const judging = held === null && body !== null && list !== null && !waitOver
    && setupWaiting(body, owner, list.positions.filter((position) => gateOpen(gates[position.chainId])).length, (chainId) => gateOpen(gates[chainId]))
  useQuickPortfolio(wallet, judging && !waitingForIndex, UNJUDGED_ASK_MS)
  const delay = held === null && body ? setupRetryDelay(body, owner, own.position, attempt) : null
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
      {/* Changed on purpose 2026-11-09 (core flows, the owner: no bare grey rows after a new position): while the position
          just created is being listed, one line says so over its one row. */}
      {waitingForIndex && <p role="status" className="dm-seq-loading-line" data-v2in-setup-adding="">{ADDING_POSITION}</p>}
      {(waitingForIndex ? [0] : [0, 1, 2]).map((row) => <Skeleton key={row} className="dm-seq-loading-row" />)}
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
  // Changed on purpose 2026-11-09 (core flows, the owner: nothing may load forever): past STUCK_MS of failed answers only,
  // the one-line state says what to do (the approved one-line box, v4-automate.css); the rows before it.
  if (!body && stuck) return (
    <div className="dm-acct-block" data-sequence-positions="stuck">
      <p className="text-body text-fg-muted">{RELOAD_WORDS.positions}</p>
    </div>
  )
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
  const viewPositions = (variant: 'primary' | 'outline') => <LinkButton href="/positions" variant={variant} size="lg">View positions</LinkButton>
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
