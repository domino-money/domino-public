import { useEffect, useMemo, useRef, useState } from 'react'
import { StepMarker } from '../../components/ui'
import { positionManagerOrNull, v2Chain } from '../../v2/chains'
import { lockedCopy } from '../../v2/gate'
import type { Address } from '../../v2/types'
import { describeError, errorLabels, type ErrorView } from '../automate/copy'
import { useGate } from '../automate/gate'
import { openAutomation, type AutomationSession, type StepPhase } from '../automate/session'
import { useStepsRun, type WalletStep } from '../automate/steps'
import { CLOSE_STEP } from './constants'
import { COPY } from './copy'
import type { DirectState } from './directRun'
import type { ActionError } from './errors'
import type { ActionPosition, VaultReserves } from './model'

/**
 * Added 2026-11-09 (the core-flows fix; the owner: "if you have a position with Auto-compound or any active automation you
 * must turn it off first, then you can close the position, and this must be totally easy for the user"): Close position as
 * ONE guided flow, whatever the automation does with the position, in the dialog's own step list (New position's
 * timeline, styles/flow.css .dm-flow-wsteps, as ./Steps.tsx draws it), one wallet confirmation per step, each next step
 * starting by itself once the one before it is confirmed:
 *
 *   1. "Withdraw from your automation", only for a position Domino-compound holds (its successor: the vault holds the
 *      NFT, so nothing at Uniswap can close it): the vault's own `withdrawChild(tokenId)` (finance/v2/vault.ts), the one
 *      way such a position comes back to the wallet as a plain one. Then the position is read through the wallet.
 *   2. "Close position": the direct exit at Uniswap (./directRun.ts), the same as before. An armed root needs no step of
 *      its own first: the vault never refuses its owner's exit and only turns its automation off
 *      (DominoV2VaultV4._notified), so closing IS turning it off, said in one line.
 *   3. "Withdraw to wallet", only for an automation's main position whose automation still holds fees once it is closed,
 *      and holds no other position: the vault's `returnReserves()`, every reserve of both tokens to the owner alone, no
 *      fee, one transaction (its two conditions, the root closed and no other member, are the contract's own and are read
 *      on chain right after the close). Nothing held: no step. Another position still in it: no step either (its fees
 *      are that position's too); the automation's card keeps Withdraw to wallet for them.
 *
 * The vault steps go through the automation's own session and run (../automate/session.tsx, ../automate/steps.tsx: the
 * chain read again and simulated right before the wallet, offered once, followed to its block). Under a vault gate that is
 * not live, step 1 is not offered (the dialog says the gate's sentence) and step 3 is left to the automation's card.
 */

/** One row of the close's step list. */
export interface CloseRow {
  key: 'withdraw-child' | 'close' | 'return-reserves'
  title: string
  state: 'upcoming' | 'current' | 'done' | 'failed'
  note: string | null
}

type PostState = 'none' | 'checking' | 'running' | 'done' | 'empty' | 'skipped'

const asAction = (view: ErrorView): ActionError => ({ copy: view.text, code: view.code, recovery: 'none' })

/** A vault step's row from its phase in the automation's run. */
function vaultRow(key: CloseRow['key'], title: string, phase: StepPhase | undefined, failed: boolean): CloseRow {
  const p = phase ?? { phase: 'idle' as const }
  if (p.phase === 'included' || p.phase === 'finalized') return { key, title, state: 'done', note: COPY.wallet.included }
  if (p.phase === 'working') return { key, title, state: 'current', note: p.note === 'wallet' ? COPY.wallet.inWallet : null }
  if (p.phase === 'sent') return { key, title, state: 'current', note: p.slow ? COPY.wallet.stillWaiting : COPY.wallet.pendingNetwork }
  if (p.phase === 'failed' || failed) return { key, title, state: 'failed', note: null }
  return { key, title, state: 'upcoming', note: null }
}

/** The close's own row from the direct exit's stage. */
function closeRow(direct: Pick<DirectState, 'stage' | 'slow'>, started: boolean): CloseRow {
  const title = CLOSE_STEP.close
  switch (direct.stage) {
    case 'reading': return { key: 'close', title, state: started ? 'current' : 'upcoming', note: null }
    case 'wallet': return { key: 'close', title, state: 'current', note: COPY.wallet.inWallet }
    case 'sent': return { key: 'close', title, state: 'current', note: direct.slow ? COPY.wallet.stillWaiting : COPY.wallet.pendingNetwork }
    case 'unknown': return { key: 'close', title, state: 'current', note: null }
    case 'done': return { key: 'close', title, state: 'done', note: COPY.wallet.included }
    case 'failed': return { key: 'close', title, state: started ? 'failed' : 'upcoming', note: null }
    default: return { key: 'close', title, state: 'upcoming', note: null }
  }
}

export interface CloseFlow {
  /** The position is Domino-compound's (its successor): it is withdrawn from the automation first. */
  successor: boolean
  /** That first step is confirmed (or there is none). */
  ready: boolean
  /** The gate's sentence when a vault step is needed and the vault gate is not live; null otherwise. */
  locked: string | null
  /** The step list; null when the close is the only step (no list is drawn then). */
  rows: readonly CloseRow[] | null
  /** Something the automation's steps said (a refusal, a failure before the wallet). */
  error: ActionError | null
  /** A vault step is under way (its button waits). */
  busy: boolean
  /** Everything after the close is done, or there is nothing after it. */
  finished: boolean
  /** The fees the automation held were returned here (no hand-over to the automation's card after this dialog). */
  handled: boolean
  /** The last vault step failed before or at the wallet: pressing again offers it again. */
  retry: 'withdraw-child' | 'return-reserves' | null
  /** The press: step 1 (a successor), or a vault step offered again. */
  start: () => void
}

export function useCloseFlow({ enabled, position, reserves, direct }: {
  enabled: boolean
  position: ActionPosition
  reserves: VaultReserves | null
  direct: Pick<DirectState, 'stage' | 'slow'>
}): CloseFlow {
  const chainId = position.chainId
  const vault = position.vault
  const successor = enabled && vault?.role === 'successor'
  const rootVault: Address | null = enabled && vault?.role === 'root' ? vault.address : null
  const needsVault = successor || rootVault !== null
  // The vault gate is asked only where a vault step can be needed (a hook is always called; chain 0 is off at once).
  const vaultGate = useGate('vault', needsVault ? chainId : 0)
  const live = vaultGate && vaultGate.mode === 'live' ? vaultGate : null
  const [session, setSession] = useState<AutomationSession | null>(null)
  const [sessionError, setSessionError] = useState<ActionError | null>(null)
  const opening = useRef<Promise<AutomationSession> | null>(null)
  const ensureSession = (): Promise<AutomationSession> => {
    if (!live) return Promise.reject(new Error('vault_not_live'))
    if (session) return Promise.resolve(session)
    opening.current ??= openAutomation(chainId, live.contracts).then((made) => { setSession(made); return made }).finally(() => { opening.current = null })
    return opening.current
  }
  const labels = useMemo(() => errorLabels(chainId, (address) => address), [chainId])
  const manager = positionManagerOrNull(v2Chain(chainId), position.dex) ?? undefined
  const tokenId = position.tokenId
  const vaultAddress = vault?.address ?? null

  // 1. A successor: withdrawn from the automation first.
  const [preDone, setPreDone] = useState(false)
  const [wantPre, setWantPre] = useState(false)
  const pressedPre = useRef(false)
  const preSteps = useMemo<readonly WalletStep[]>(() => (successor && session && vaultAddress ? [{
    key: 'withdraw-child',
    title: CLOSE_STEP.withdrawChild,
    tx: { client: session.vault, prepare: async () => session.vault.prepareStep(await session.vault.reviewAction(vaultAddress, { kind: 'withdraw-child', tokenId }), 0, null) },
  }] : []), [successor, session, vaultAddress, tokenId])
  const pre = useStepsRun({
    session, steps: preSteps, context: 'vault', labels,
    affected: { positionManager: manager, tokenIds: [tokenId.toString()], vault: vaultAddress ?? undefined },
    onAllDone: () => setPreDone(true),
  })
  const pressPre = pre.press
  useEffect(() => {
    if (!wantPre || !session || preSteps.length === 0 || pressedPre.current) return
    pressedPre.current = true
    void pressPre()
  }, [wantPre, session, preSteps, pressPre])

  // 3. An automation's main position, closed: its fees still in the automation come back in one transaction.
  const heldBefore = reserves !== null && reserves.vault === rootVault && reserves.reserves !== null && reserves.reserves.some((reserve) => reserve.amount > 0n)
  const [checked, setChecked] = useState<'ready' | 'empty' | 'skipped' | null>(null)
  const [returned, setReturned] = useState(false)
  const closed = direct.stage === 'done'
  const checking = useRef(false)
  const checkNeeded = enabled && closed && rootVault !== null && live !== null && checked === null
  useEffect(() => {
    if (!checkNeeded || !rootVault || !live || checking.current) return
    checking.current = true
    void (async () => {
      try {
        // The automation's session for this wallet and chain (kept by ../automate/session.tsx: one per wallet, chain and set).
        const made = await openAutomation(chainId, live.contracts)
        setSession(made)
        const snapshot = await made.serial(() => made.vault.readVault(rootVault))
        setChecked(!snapshot.reserves.some((reserve) => reserve.total > 0n) ? 'empty' : !snapshot.ownedByWallet || snapshot.positions.length > 1 ? 'skipped' : 'ready')
      } catch {
        // Unread: the automation's card offers Withdraw to wallet after this dialog, as before.
        setChecked('skipped')
      }
    })()
  }, [checkNeeded, rootVault, live, chainId])
  const post: PostState = !enabled || !closed ? 'none' : !rootVault || !live ? 'skipped' : checked === null ? 'checking' : returned ? 'done' : checked === 'ready' ? 'running' : checked
  const postSteps = useMemo<readonly WalletStep[]>(() => (session && rootVault && checked === 'ready' ? [{
    key: 'return-reserves',
    title: CLOSE_STEP.withdrawReserves,
    tx: { client: session.vault, prepare: async () => session.vault.prepareStep(await session.vault.reviewAction(rootVault, { kind: 'return-reserves' }), 0, null) },
  }] : []), [session, rootVault, checked])
  const after = useStepsRun({
    session, steps: postSteps, context: 'vault', labels,
    affected: { positionManager: manager, tokenIds: [tokenId.toString()], vault: rootVault ?? undefined },
    onAllDone: () => setReturned(true),
  })
  const pressedPost = useRef(false)
  const pressAfter = after.press
  useEffect(() => {
    if (postSteps.length === 0 || pressedPost.current) return
    pressedPost.current = true
    void pressAfter()
  }, [postSteps, pressAfter])

  const start = () => {
    if (!live) return
    setSessionError(null)
    if (successor && !preDone) {
      if (session && preSteps.length > 0 && pressedPre.current) { void pre.press(); return }
      setWantPre(true)
      ensureSession().catch((failure: unknown) => setSessionError(asAction(describeError(failure, 'vault', labels))))
      return
    }
    if (post === 'running' && !after.running) void after.press()
  }

  const showPost = rootVault !== null && live !== null && (post === 'running' || post === 'done' || (post !== 'empty' && post !== 'skipped' && heldBefore))
  const rows: CloseRow[] = []
  if (successor) rows.push(vaultRow('withdraw-child', CLOSE_STEP.withdrawChild, pre.phases[0], pre.notice !== null && !pre.running))
  rows.push(closeRow(direct, !successor || preDone))
  if (showPost) rows.push(vaultRow('return-reserves', CLOSE_STEP.withdrawReserves, after.phases[0], after.notice !== null && !after.running))
  const notice = sessionError ?? (pre.notice ? asAction(pre.notice) : null) ?? (after.notice ? asAction(after.notice) : null)
  return {
    successor,
    ready: !successor || preDone,
    locked: successor && vaultGate !== null && vaultGate.mode !== 'live' ? (vaultGate.mode === 'preview' ? vaultGate.lockedCopy : lockedCopy(v2Chain(chainId).name)) : null,
    rows: rows.length > 1 ? rows : null,
    error: notice,
    busy: (successor && vaultGate === null) || pre.running || after.running || post === 'checking' || (post === 'running' && !after.running && after.notice === null) || (wantPre && !preDone && !pre.running && pre.notice === null && sessionError === null),
    finished: !enabled || post === 'done' || post === 'empty' || post === 'skipped',
    handled: post === 'done' || post === 'empty',
    retry: successor && !preDone && (pre.notice !== null || sessionError !== null) && !pre.running ? 'withdraw-child' : post === 'running' && after.notice !== null && !after.running ? 'return-reserves' : null,
    start,
  }
}

/** The close's step list, in New position's timeline (./Steps.tsx draws the zap's steps the same way). */
export function CloseStepsList({ rows }: { rows: readonly CloseRow[] }) {
  return (
    <ol className="dm-flow-wsteps" data-close-steps={rows.length}>
      {rows.map((row, index) => (
        <li key={row.key} data-close-step={row.key} data-step-state={row.state === 'done' ? 'done' : row.state === 'current' ? 'wallet' : undefined} data-step-failed={row.state === 'failed' ? '' : undefined}>
          <StepMarker index={index + 1} state={row.state === 'failed' ? 'current' : row.state} label={`${row.title}, ${row.state}`} />
          <div className="dm-flow-wstep-body">
            <span className="dm-flow-wstep-title">{row.title}</span>
            {row.note && <span className="dm-flow-wstep-note">{row.note}</span>}
          </div>
        </li>
      ))}
    </ol>
  )
}
