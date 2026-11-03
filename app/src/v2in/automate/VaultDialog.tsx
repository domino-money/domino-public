import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, KeyValue, KeyValueList, Skeleton } from '../../components/ui'
import { automationFeeText, VAULT_TEXT, type VaultAction, type VaultActionReview, type VaultSnapshot, type VaultStepKind, type VaultWithdrawBatch } from '../../finance/v2/vault'
import { v2ContractUrl } from '../../v2/explorers'
import { v2Chain } from '../../v2/chains'
import type { V2Gate } from '../../v2/gate'
import type { Hex, V2ChainId, V2Contracts } from '../../v2/types'
import type { ExitTriggers } from '../autoexit/card'
import { PastEdge } from '../autoexit/PastEdge'
import { EDGE_PASSED, edgePassed } from '../autoexit/turnBackOn'
import { CLOSED_TEXT, describeError, errorLabels, PROTECTION_CONSENT_TEXT, RESERVES_TEXT, STEPS_INSTEAD, type ErrorView } from './copy'
import { openAutomation, type AutomationSession } from './session'
import { recordVaultEvents, rememberApproval } from './store'
import { useStepsRun, WalletSteps, type StepOutcome, type WalletStep } from './steps'
import { amountWords, shortAddress, type TokenView } from './tokens'
import { Check, Details, ErrorLine, Fact, FlowDialog, LockedNote } from './ui'
import { protectionVault, restartsAfterLeave, recoverPositionInput, recoverTokenInput, withdrawRecipientInput, type VaultActionKind, type VaultReserve, type VaultView } from './vaultView'

/**
 * A vault's owner actions as the position page's action dialogs (spec F7 rev3/rev4 §2.13, §5.3, §5.5, §5.6): "Withdraw
 * to wallet" (every reserve, `withdrawReserves`, one EIP-5792 batch when the wallet has it), "Return my reserves"
 * (`returnReserves()`, the root closed and no successor active; no fee), "Leave automation" (`exitAll()`, the main way
 * out, and on v4 its follow-ups: remove Domino from the position, revoke the vault's approval), "Turn back on" (the
 * rearm after a manual action, decision #5: approve the vault again when the wallet asks, then `rearm(true)` with the
 * consent asked again), Pause and Resume; and §5.6's three others: "Withdraw #id from the vault" (`withdrawChild`, an
 * active successor to the wallet as a plain position), "Recover a token" (`recoverToken`, a token address and an amount
 * typed: anything the vault holds outside its accounted reserves, never a pool token's reserves) and "Recover a position"
 * (`recoverPosition`, a position number typed: an NFT the vault holds without managing, the root sent by mistake
 * included). The typed ones are reviewed once what is typed is whole; the vault client's checks and the contract's
 * refusals (InvalidPosition, InsufficientReserves…) are said in src/v2/errors.ts's words.
 *
 * Under the gate's `preview` the dialog shows its review and its steps and stops there: the sentence `lockedCopy` stands
 * where the wallet would be asked, and nothing reaches a wallet. Under `live`, its steps run through the vault client:
 * re-derived from the chain and simulated right before each is offered, offered once, each confirmed before the next.
 * The primary button says "Confirm in wallet", as the page's own action dialogs do, except where the verb itself is
 * the whole action (Withdraw, Pause, Resume).
 *
 * The race of rev4 §5.6: an exact withdrawal the automation's `returnReserves()` overtook reverts InsufficientReserves; the
 * reserves are read again and, gone to the wallet, said as "Already returned to your wallet", never as an error.
 */

export type VaultDialogKind = VaultActionKind

/** What a dialog is about beyond its vault: the successor of "Withdraw #id from the vault". */
export interface VaultDialogSubject {
  tokenId: bigint
}

const TITLE: Readonly<Record<VaultDialogKind, string>> = {
  withdraw: 'Withdraw to wallet',
  return: 'Return my reserves',
  leave: 'Leave automation',
  rearm: 'Turn back on',
  pause: 'Pause automation',
  resume: 'Resume automation',
  unsubscribe: 'Remove Domino from this position',
  revoke: 'Revoke approval',
  'withdraw-child': 'Withdraw from your automation',
  'recover-token': 'Recover a token',
  'recover-position': 'Recover a position',
}
const CONFIRM = 'Confirm in wallet'
const PRIMARY: Readonly<Record<VaultDialogKind, string>> = {
  withdraw: 'Withdraw in wallet',
  return: CONFIRM,
  leave: CONFIRM,
  rearm: CONFIRM,
  pause: 'Pause in wallet',
  resume: 'Resume in wallet',
  unsubscribe: CONFIRM,
  revoke: CONFIRM,
  'withdraw-child': 'Withdraw in wallet',
  'recover-token': CONFIRM,
  'recover-position': CONFIRM,
}
const STEP_TITLE: Readonly<Partial<Record<VaultStepKind, string>>> = {
  'approve-root': 'Approve this position for your automation',
  rearm: 'Turn automation back on',
  'withdraw-reserves': 'Withdraw to your wallet',
  'exit-all': 'End your automation',
  unsubscribe: 'Remove Domino from this position',
  'revoke-approval': "Revoke your automation's approval",
  'return-reserves': 'Return everything to your wallet',
  pause: 'Pause automation',
  resume: 'Resume automation',
  'withdraw-child': 'Withdraw this position to your wallet',
  'recover-token': 'Recover the token to your wallet',
  'recover-position': 'Recover the position to your wallet',
}
/** The codes after which a withdrawal's amounts are read again (rev4 §5.6: the automation may have returned them). */
const RESERVES_MOVED = new Set(['InsufficientReserves', 'vault_amount_exceeds_reserves', 'vault_reserves_empty'])
/** Codes after which the review is made again from the chain, by itself. */
const REVIEW_AGAIN = new Set(['vault_review_stale', 'vault_step_out_of_order', 'vault_review_unknown'])
const ALREADY_RETURNED = 'Already returned to your wallet.'
const CHANGED = 'The amounts changed since you opened this. Check them, then press again.'
const LEAVE_TEXT = (root: bigint) => `Your next positions and everything your automation can pay go to your wallet in one action, and position #${root} stops being automated. No fee.`
/**
 * Auto-exit's own vault (decision #25: paused, its module on), said in Auto-exit's words, never in compounding's
 * (Changed on purpose 2026-10-06, the review of point 5; rugged97: "auto-exit has no fee compounding"): whatever its root's
 * state, so a root whose approval moved (Add liquidity on v4 moves it to the zap) is turned back on as Auto-exit.
 *
 * Changed on purpose 2026-10-06 (the integration review, rugged-literal #1 and #2, money #4): its rearm is said by what it
 * does. An exit needs the position's approval alone (DominoV2VaultExecutor.executeExit), so for an Auto-exit that is on or
 * paused (`exit`) it is "approve this position again so Auto-exit can close it", with nothing to do when the approval is
 * still there (no rearm(true) the exit does not need), and the pool's price read before the approval goes back: that puts
 * the signed order in force again, and an end the price already passed closes the position at once (../autoexit/
 * turnBackOn.ts). With none on, it is the first part of turning Auto-exit on, whose own dialog the page opens right after.
 * Never "Auto-exit works again". Leave automation (exitAll) turns its module off: Auto-exit pauses, it does not end; with
 * none on (turned off, expired, or it closed the position), the automation simply stops for the position (`stops`).
 */
const PROTECTION_TITLE = { approve: 'Auto-exit', 'turn-on': 'Turn on Auto-exit' } as const
const PROTECTION_STEP: Readonly<Partial<Record<VaultStepKind, string>>> = {
  'approve-root': 'Approve this position for Auto-exit',
  rearm: 'Reconnect it to your automation',
}
const PROTECTION_LEDE = {
  approve: 'Approve this position again so Auto-exit can close it at the end of its range.',
  kept: 'Auto-exit still has its approval on this position: nothing to do here.',
  'turn-on': 'First, reconnect this position to your automation. Then you turn Auto-exit on.',
  leave: (root: bigint) => `Auto-exit pauses for position #${root}, and anything your automation holds goes to your wallet. No fee. Turn off ends it for good.`,
  stops: (root: bigint) => `Your Auto-exit automation stops for position #${root}, and anything it holds goes to your wallet. No fee.`,
  withdraw: "Amounts your Auto-exit automation holds for this position. They're yours: no Domino fee to withdraw them.",
} as const
const RETURN_TEXT = 'Your position is closed, so everything your automation holds can go back to your wallet in one transaction.'
const LEAVE_IT = 'Or leave it: Domino returns it to your wallet on its next pass.'
const CHILD_TEXT = (id: bigint) => `Position #${id} goes to your wallet as a plain position, with no automation. Fees it left behind can be withdrawn here, and Domino may open a new position in its place. No fee.`
const RECOVER_TOKEN_TEXT = 'Takes back something your automation holds outside its fees: another token, ETH, a donation, or what a route left behind. Fees collected from your positions are withdrawn with Withdraw to wallet, not here. No fee.'
const RECOVER_POSITION_TEXT = 'A position your automation holds without managing it goes back to your wallet: one sent to it by mistake, your main position included. Positions it manages are withdrawn with Withdraw from your automation instead.'
/** How long after the last keystroke a typed recovery is reviewed on chain. */
const TYPING_SETTLE_MS = 400
/** rugged97's delta of 4 Oct §2 item 1: offered once a transfer of the reserves to the wallet failed (TokenCallFailed). */
const ELSEWHERE = 'Send to another address you own'
const ELSEWHERE_HINT = "Only an address you control: a transfer can't be undone."
const RECIPIENT_PROBLEM: Readonly<Record<'address' | 'same-wallet' | 'not-a-wallet', string>> = {
  address: 'Enter a wallet address: 0x followed by 40 letters or digits.',
  'same-wallet': "That's the wallet the transfer failed to. Choose another wallet you own.",
  'not-a-wallet': 'Choose a wallet to receive the funds.',
}

/** One reserve per pool token, as "1.5 USDG" (raw units when its decimals are unknown). */
function Amounts({ list, tokens }: { list: readonly VaultReserve[]; tokens: readonly [TokenView, TokenView] | null }) {
  const held = list.filter((r) => r.total > 0n)
  if (held.length === 0) return <span>Nothing</span>
  return (
    <span className="dm-receipt-pair">
      {held.map((r) => {
        const token = tokens?.find((t) => t.address === r.token)
        const words = token ? amountWords(r.total, token) : { text: `${r.total} raw units of ${shortAddress(r.token)}`, exact: `${r.total} raw units of ${r.token}` }
        return (
          <span key={r.token} className="dm-receipt-amount tnum" title={words.exact} data-reserve-amount={r.token}>
            {words.text}
          </span>
        )
      })}
    </span>
  )
}

/** The session for a live dialog: the wallet switched to the vault's chain, the clients built. */
function useLiveSession(enabled: boolean, chainId: V2ChainId, contracts: V2Contracts) {
  const [state, setState] = useState<{ session: AutomationSession | null; error: ErrorView | null }>({ session: null, error: null })
  useEffect(() => {
    if (!enabled) return
    let alive = true
    openAutomation(chainId, contracts).then(
      (session) => { if (alive) setState({ session, error: null }) },
      (failure: unknown) => { if (alive) setState({ session: null, error: describeError(failure, 'vault', { chainId }) }) },
    )
    return () => {
      alive = false
    }
  }, [enabled, chainId, contracts])
  return state
}

/** A step's line: Auto-exit's own words for its own vault's approval and rearm, else the vault's. */
const stepTitle = (kind: VaultStepKind, protection: boolean): string => (protection ? PROTECTION_STEP[kind] : undefined) ?? STEP_TITLE[kind] ?? 'Confirm in your wallet'

/** The steps a preview shows for each action (nothing pressed: the review stops before the wallet). */
function previewSteps(kind: VaultDialogKind, view: VaultView, tokens: readonly [TokenView, TokenView] | null, subject: VaultDialogSubject | null): WalletStep[] {
  const held = view.reserves.known ? view.reserves.list.filter((r) => r.total > 0n) : []
  const name = (r: VaultReserve) => tokens?.find((t) => t.address === r.token)?.label ?? shortAddress(r.token)
  switch (kind) {
    case 'withdraw':
      return held.length > 1
        ? [{ key: 'withdraw-all-batch', title: 'Withdraw to your wallet', note: `One confirmation in your wallet when it can send ${held.length} calls together; otherwise one per token.` }]
        : held.map((r) => ({ key: `withdraw-${r.token}`, title: `Withdraw ${name(r)} to your wallet` }))
    case 'return':
      return [{ key: 'return-reserves', title: STEP_TITLE['return-reserves'] as string }]
    case 'leave':
      return [{ key: 'exit-all', title: STEP_TITLE['exit-all'] as string }]
    case 'rearm':
      return [
        { key: 'approve-root', title: stepTitle('approve-root', protectionVault(view)), note: 'Only if your wallet no longer approves your automation.' },
        { key: 'rearm', title: stepTitle('rearm', protectionVault(view)) },
        ...(restartsAfterLeave(view) ? [{ key: 'resume', title: STEP_TITLE.resume as string }] : []),
      ]
    case 'pause':
      return [{ key: 'pause', title: STEP_TITLE.pause as string }]
    case 'resume':
      return [{ key: 'resume', title: STEP_TITLE.resume as string }]
    case 'unsubscribe':
      return [{ key: 'unsubscribe', title: STEP_TITLE.unsubscribe as string }]
    case 'revoke':
      return [{ key: 'revoke-approval', title: STEP_TITLE['revoke-approval'] as string }]
    case 'withdraw-child':
      return [{ key: 'withdraw-child', title: subject ? `Withdraw #${subject.tokenId} from your automation` : (STEP_TITLE['withdraw-child'] as string) }]
    case 'recover-token':
      return [{ key: 'recover-token', title: STEP_TITLE['recover-token'] as string }]
    case 'recover-position':
      return [{ key: 'recover-position', title: STEP_TITLE['recover-position'] as string }]
  }
}

/** The action a dialog reviews (rearm only once its consent is given; a typed recovery only once what is typed is whole). */
function actionOf(kind: VaultDialogKind, consent: boolean, subject: VaultDialogSubject | null, typed: { token: `0x${string}` | null; amount: bigint | null; id: bigint | null }, restarts: boolean): VaultAction | null {
  switch (kind) {
    case 'return': return { kind: 'return-reserves' }
    case 'leave': return { kind: 'exit-all' }
    case 'rearm': return consent ? { kind: 'rearm', consentToUncollectedFees: true, thenResume: restarts } : null
    case 'pause': return { kind: 'pause' }
    case 'resume': return { kind: 'resume' }
    case 'unsubscribe': return { kind: 'unsubscribe' }
    case 'revoke': return { kind: 'revoke-approval' }
    case 'withdraw': return null
    case 'withdraw-child': return subject ? { kind: 'withdraw-child', tokenId: subject.tokenId } : null
    case 'recover-token': return typed.token !== null && typed.amount !== null ? { kind: 'recover-token', token: typed.token, amount: typed.amount } : null
    case 'recover-position': return typed.id !== null ? { kind: 'recover-position', tokenId: typed.id } : null
  }
}

export interface VaultDialogProps {
  kind: VaultDialogKind
  view: VaultView
  tokens: readonly [TokenView, TokenView] | null
  gate: Exclude<V2Gate, { mode: 'off' }>
  /** The successor a "Withdraw from the vault" is about; nothing for the other kinds. */
  subject?: VaultDialogSubject | null
  /**
   * Added 2026-10-06 (the integration review): for Auto-exit's own vault, the Auto-exit on its root as the position's card
   * has it: the one on or paused (its id and its ends as listed), which an approval put back puts in force again, or null
   * when none is on (the rearm is then the first part of turning Auto-exit on). Absent elsewhere.
   */
  exit?: { id: Hex; triggers: ExitTriggers | null } | null
  /** Added 2026-10-06 (the integration review, money #4): "Turn off instead", where the page has Auto-exit's own Turn off. */
  onTurnOff?: () => void
  onClose: () => void
  /**
   * Something changed on chain: the caller reads again. `snapshot`: the vault as read right after (live), for the caller
   * to show until read-v6's index reaches the same state.
   */
  onChanged: (snapshot?: VaultSnapshot) => void
}

function sameTokenPair(a: VaultDialogProps['tokens'], b: VaultDialogProps['tokens']): boolean {
  return a === b || (a !== null && b !== null && a.every((token, index) => {
    const next = b[index]
    return token.address === next.address && token.label === next.label && token.decimals === next.decimals && token.known === next.known
  }))
}

export function VaultDialog({ kind, view, tokens: receivedTokens, gate, subject = null, exit, onTurnOff, onClose, onChanged }: VaultDialogProps) {
  // A portfolio/credit refresh can recreate an identical pair while a wallet confirmation is pending. Preserve that
  // pair's identity so display-only churn cannot replace the review or abandon the running step. Real token changes
  // still replace it, and action/session/review changes retain their existing resets and on-chain checks.
  const [tokens, setTokens] = useState(receivedTokens)
  if (!sameTokenPair(tokens, receivedTokens)) setTokens(receivedTokens)
  const locked = gate.mode === 'preview'
  const live = useLiveSession(!locked, view.chainId, gate.contracts)
  const session = live.session
  const [consent, setConsent] = useState(false)
  // Money #4 (the integration review): the price is past an end of the Auto-exit an approval would put back in force
  // (null until read, or where it does not apply), and the person's tick to go on anyway.
  const [past, setPast] = useState<boolean | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const acknowledgedNow = useRef(false)
  const exitNow = useRef(exit)
  useEffect(() => {
    exitNow.current = exit
  })
  // Added 2026-10-06 (rugged's answer of 6 Oct, §4 item 6: read-v6 drops `custody_lost` only once it reads the position
  // again): the block of this dialog's approval of the position for its automation, said to the page once the dialog
  // closes, so its Auto-exit's card says "On" at once (../autoexit/card.ts withApprovals). Not before: a change of the
  // page's store while the dialog is open would read its review again under it.
  const approvedIn = useRef<bigint | null>(null)
  const { chainId: approvedChain, vault: approvedVault, rootTokenId: approvedRoot } = view
  useEffect(() => {
    const block = approvedIn
    return () => {
      if (block.current !== null) rememberApproval(approvedChain, approvedVault, approvedRoot, block.current)
    }
  }, [approvedChain, approvedVault, approvedRoot])
  const [round, setRound] = useState(0)
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null)
  const [review, setReview] = useState<VaultActionReview | null>(null)
  const [reviewError, setReviewError] = useState<ErrorView | null>(null)
  const [path, setPath] = useState<'batch' | 'steps'>('steps')
  const [info, setInfo] = useState<string | null>(null)
  const [finished, setFinished] = useState(false)
  // Leave automation on v4, once exitAll is in: its two follow-ups, each its own review.
  const [follow, setFollow] = useState<'unsubscribe' | 'revoke-approval' | null>(null)
  const [followed, setFollowed] = useState<readonly ('unsubscribe' | 'revoke-approval')[]>([])
  // The two recoveries' typed fields, and a withdrawal's own recipient, reviewed once typing settles (never on every keystroke).
  const [form, setForm] = useState({ token: '', amount: '', id: '', recipient: '' })
  const [settled, setSettled] = useState(form)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(form), TYPING_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [form])
  const typedToken = useMemo(() => (kind === 'recover-token' ? recoverTokenInput(view.chainId, tokens, settled.token, settled.amount) : null), [kind, view.chainId, tokens, settled.token, settled.amount])
  const typedId = kind === 'recover-position' ? recoverPositionInput(settled.id) : null
  // rugged97's delta of 4 Oct §2 item 1: once a transfer to the wallet failed (TokenCallFailed), the owner may name another
  // address of theirs; until it is whole, nothing is offered.
  const [elsewhere, setElsewhere] = useState(false)
  const poolTokens = useMemo(() => [...(tokens ?? []).map((t) => t.address), ...(snapshot?.reserves ?? []).map((r) => r.token)], [tokens, snapshot])
  const typedRecipient = useMemo(
    () => (kind === 'withdraw' && elsewhere ? withdrawRecipientInput(settled.recipient, { owner: session?.owner ?? null, vault: view.vault, tokens: poolTokens }) : null),
    [kind, elsewhere, settled.recipient, session, view.vault, poolTokens],
  )
  const recipient = typedRecipient?.ok ? typedRecipient.address : null
  const typedAddress = typedToken?.ok ? typedToken.token.address : null
  const typedAmount = typedToken?.ok ? typedToken.amount : null
  const subjectId = subject?.tokenId ?? null
  // As the dialog opened: the root coming back mid-way changes the view, never what the person was asked to confirm.
  const [restarts] = useState(() => kind === 'rearm' && restartsAfterLeave(view))
  const action = useMemo(
    () => actionOf(kind, consent, subjectId === null ? null : { tokenId: subjectId }, { token: typedAddress, amount: typedAmount, id: typedId }, restarts),
    [kind, consent, subjectId, typedAddress, typedAmount, typedId, restarts],
  )
  // `{token}` in a refusal names the typed token (InsufficientReserves: "That's more than your vault holds in {token}.").
  const named = typedToken?.token ?? null
  const labels = useMemo(
    () => errorLabels(view.chainId, (address) => tokens?.find((t) => t.address === address.toLowerCase())?.label ?? (named && named.address === address.toLowerCase() ? named.label : shortAddress(address)), named?.address),
    [view.chainId, tokens, named],
  )

  // Live: the vault read on chain (the amounts the steps will take), and the action's own review.
  useEffect(() => {
    if (locked || !session) return
    let alive = true
    void (async () => {
      try {
        const snap = await session.serial(() => session.vault.readVault(view.vault))
        if (!alive) return
        setSnapshot(snap)
        const reviewed: VaultAction | null = follow ? { kind: follow } : action
        if (kind === 'withdraw' && !follow) {
          const held = snap.reserves.filter((r) => r.total > 0n)
          const atomic = held.length > 1 ? await session.serial(() => session.vault.atomicSupport()) : 'unsupported'
          if (alive) setPath(atomic === 'ready' || atomic === 'supported' ? 'batch' : 'steps')
          if (alive) setReviewError(null)
          return
        }
        if (!reviewed) {
          // Nothing whole to review yet (the consent not given, a field not typed): the last review no longer stands.
          setReview(null)
          setReviewError(null)
          return
        }
        const next = await session.serial(() => session.vault.reviewAction(view.vault, reviewed))
        if (alive) {
          setReview(next)
          setReviewError(null)
        }
      } catch (failure) {
        if (alive) {
          setReview(null)
          setReviewError(describeError(failure, 'vault', labels))
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [locked, session, view.vault, kind, action, round, follow, labels])

  // Changed on purpose 2026-10-06 (the review of point 5): from the vault itself (paused, its auto-exit on), not from its
  // status, which says 'off' once its root lost its approval: that rearm is Auto-exit's, and reinvests nothing.
  const protection = protectionVault(view)
  // Changed on purpose 2026-10-06 (the integration review, rugged-literal #1): Auto-exit's own rearm by what it does, the
  // approval back for an Auto-exit that is on or paused ('approve'), or the first part of turning one on ('turn-on').
  const exitRearm = protection && kind === 'rearm' ? (exit === null ? 'turn-on' : 'approve') : null
  // Auto-exit on or paused on this root, as the position's card has it (`exit`; as listed where no card says): while it
  // is, Leave automation only pauses it, and nothing here cuts the position from its automation (an exit needs the
  // approval). Changed on purpose 2026-10-06 (the integration review's second pass).
  const exitLive = protection && (exit === undefined ? view.exit === 'on' || view.exit === 'paused' : exit !== null)
  // The approval still there, as the chain reads it now: an Auto-exit that is on or paused can close the position already,
  // and nothing is asked of the wallet (never a rearm(true) the exit does not need).
  const approvalKept = snapshot !== null && snapshot.custody.holder === snapshot.owner && snapshot.custody.approved === snapshot.vault
  const nothingToDo = exitRearm === 'approve' && !!exit && approvalKept
  // Money #4: the approval put back puts the signed order in force again, so the pool's price is read first.
  const guarded = exitRearm === 'approve' && !!exit && !approvalKept
  const exitKey = exit ? `${exit.id}|${exit.triggers?.below ?? ''}|${exit.triggers?.above ?? ''}` : null
  useEffect(() => {
    const order = exitNow.current
    if (locked || !session || !snapshot || !guarded || !order) return
    let alive = true
    void session.serial(() => edgePassed(session, order, view.dex, view.rootTokenId)).then(
      (passed) => { if (alive) setPast(passed) },
      // Unread: nothing is said here; the step reads it again right before the wallet, and says a failure there.
      () => { if (alive) setPast(null) },
    )
    return () => {
      alive = false
    }
  }, [locked, session, snapshot, guarded, exitKey, view.dex, view.rootTokenId])

  const liveSteps = useMemo<readonly WalletStep[]>(() => {
    if (locked || !session) return []
    if (kind === 'withdraw' && !follow) {
      if (!snapshot) return []
      // Sent elsewhere (delta of 4 Oct §2 item 1): nothing is offered until the address is whole.
      if (elsewhere && !recipient) return []
      const to = recipient ?? undefined
      const where = recipient ? shortAddress(recipient) : 'your wallet'
      const held = snapshot.reserves.filter((r) => r.total > 0n)
      if (path === 'batch' && held.length > 1) {
        return [{
          key: 'withdraw-all-batch',
          title: `Withdraw to ${where}`,
          note: `One confirmation in your wallet, ${held.length} withdrawals together. Both run, or neither does.`,
          batch: {
            prepareBatch: () => session.vault.prepareWithdrawAllBatch(view.vault, null, to),
            send: (batch) => session.vault.sendWithdrawAllBatch(batch as VaultWithdrawBatch, true),
            receipt: (id) => session.vault.withdrawAllReceipt(id),
          },
        }]
      }
      return held.map((r) => ({
        key: `withdraw-${r.token}`,
        title: `Withdraw ${tokens?.find((t) => t.address === r.token)?.label ?? shortAddress(r.token)} to ${where}`,
        tx: {
          client: session.vault,
          // Each token's own review, at the moment it is offered: the exact amount the dialog showed, checked again.
          prepare: async () => session.vault.prepareStep(await session.vault.reviewAction(view.vault, { kind: 'withdraw-reserves', token: r.token, amount: r.total, ...(to ? { recipient: to } : {}) }), 0, null),
        },
      }))
    }
    if (!review) return []
    return review.steps.map((step, index) => ({
      key: step.kind,
      title: stepTitle(step.kind, protection),
      tx: {
        client: session.vault,
        prepare: async () => {
          // Money #4: right before the approval goes back (already in the session's queue), the price again, unless the
          // person ticked to go on anyway: an end it reached since the dialog opened is said first, never sent unseen.
          const order = exitNow.current
          if (guarded && step.kind === 'approve-root' && !acknowledgedNow.current && order && (await edgePassed(session, order, view.dex, view.rootTokenId))) throw new Error(EDGE_PASSED)
          return session.vault.prepareStep(review, index, null)
        },
      },
    }))
  }, [locked, session, kind, follow, snapshot, path, review, view.vault, view.dex, view.rootTokenId, tokens, elsewhere, recipient, protection, guarded])

  /**
   * The vault read again from the chain (after the steps, or a race), or null when the read failed. The amounts the
   * dialog shows stay those the person confirmed, unless they changed under a step that did not run (CHANGED).
   */
  async function rereadVault(): Promise<VaultSnapshot | null> {
    if (!session) return null
    try {
      return await session.serial(() => session.vault.readVault(view.vault))
    } catch {
      return null
    }
  }

  const run = useStepsRun({
    session,
    steps: liveSteps,
    context: 'vault',
    labels,
    affected: { positionManager: (view.dex === 3 ? v2Chain(view.chainId).uniswap.v3 : v2Chain(view.chainId).uniswap.v4).positionManager, tokenIds: [view.rootTokenId.toString(), ...(subject ? [subject.tokenId.toString()] : [])], vault: view.vault },
    onStepDone: (outcome: StepOutcome) => {
      if (outcome.receipt) recordVaultEvents(view.chainId, view.vault, outcome.receipt.events)
      if (outcome.receipt && outcome.step.key === 'approve-root') approvedIn.current = outcome.receipt.blockNumber
    },
    onAllDone: () => {
      setFinished(true)
      if (follow) setFollowed((old) => [...old, follow])
      onChanged()
      void rereadVault().then((snap) => onChanged(snap ?? undefined))
    },
    onError: (error, _raw, at) => {
      if (error.code === EDGE_PASSED) {
        // Money #4: the price reached an end since the dialog opened: the warning says it, before anything is sent.
        setPast(true)
        return true
      }
      if (STEPS_INSTEAD.has(error.code) && path === 'batch') {
        // The wallet cannot batch these calls: one reviewed withdrawal per token instead.
        setPath('steps')
        return true
      }
      if (kind === 'withdraw' && RESERVES_MOVED.has(error.code)) {
        void rereadVault().then((snap) => {
          if (snap && snap.reserves.every((r) => r.total === 0n)) {
            setInfo(ALREADY_RETURNED)
            setFinished(true)
            onChanged(snap)
          } else {
            if (snap) setSnapshot(snap)
            setInfo(CHANGED)
          }
        })
        return true
      }
      if (REVIEW_AGAIN.has(error.code)) {
        setRound((n) => n + 1)
        return true
      }
      if (error.code === 'vault_step_not_needed' && at.index > 0 && at.index === liveSteps.length - 1) {
        // Changed on purpose 2026-10-06 (the review of point 5): a later step the earlier ones made unnecessary is done.
        // On v4 a moved approval never disarms the root (the position manager tells no one), so once the approval is back
        // the rearm has nothing left to do: the action is complete, never "This step is already done." with no way on.
        setFinished(true)
        if (follow) setFollowed((old) => [...old, follow])
        void rereadVault().then((snap) => onChanged(snap ?? undefined))
        return true
      }
      return false
    },
  })

  const root = view.rootTokenId
  const shownReserves: readonly VaultReserve[] = snapshot ? snapshot.reserves.map((r) => ({ token: r.token, total: r.total, idle: r.idle })) : view.reserves.known ? view.reserves.list : []
  const consentText = protection ? PROTECTION_CONSENT_TEXT : VAULT_TEXT.vault_consent_uncollected_fees.replace('{fee}', view.mode === 2 ? automationFeeText(2) : automationFeeText(1))
  const steps = locked ? previewSteps(kind, view, tokens, subject) : liveSteps
  // Something whole to review: a withdrawal always; otherwise the action (the consent given, the fields typed).
  const reviewable = kind === 'withdraw' || follow !== null || action !== null
  const waitingForReview = !locked && steps.length === 0 && !reviewError && !live.error && reviewable && !finished
  // Money #4: past an end, only once the person ticked to go on anyway.
  const heldBack = guarded && past === true && !acknowledged
  const canPress = !locked && !finished && !run.running && steps.length > 0 && (kind !== 'rearm' || consent) && !run.complete && !heldBack && !nothingToDo
  const typing = run.running || finished

  // A follow-up of Leave automation is said as its own action.
  const shown: VaultDialogKind = follow === 'unsubscribe' ? 'unsubscribe' : follow === 'revoke-approval' ? 'revoke' : kind
  // v4's follow-ups still open after Leave automation (each offered until done); none while Auto-exit is on or paused.
  const followUps = finished && kind === 'leave' && view.dex === 4 && !locked && !exitLive ? (['unsubscribe', 'revoke-approval'] as const).filter((next) => !followed.includes(next)) : []
  // A transfer to the wallet failed (TokenCallFailed, `send-elsewhere`): the owner may name another address of theirs.
  const offerElsewhere = kind === 'withdraw' && !locked && !elsewhere && !finished && !run.running && (run.notice?.recovery === 'send-elsewhere' || reviewError?.recovery === 'send-elsewhere')
  const recipientProblem = typedRecipient && !typedRecipient.ok && typedRecipient.problem !== 'empty' ? RECIPIENT_PROBLEM[typedRecipient.problem] : null
  // The vault on its chain's explorer (rugged97's delta of 4 Oct §1: Robin Etherscan on Robinhood Chain).
  const vaultHref = v2ContractUrl(view.chainId, view.vault)
  let lede: ReactNode
  switch (shown) {
    case 'withdraw':
      lede = protection ? PROTECTION_LEDE.withdraw : RESERVES_TEXT
      break
    case 'return':
      lede = `${RETURN_TEXT} ${VAULT_TEXT.vault_returns_to_owner}`
      break
    case 'leave':
      lede = exitLive ? PROTECTION_LEDE.leave(root) : protection ? PROTECTION_LEDE.stops(root) : LEAVE_TEXT(root)
      break
    case 'rearm':
      lede = exitRearm === 'turn-on'
        ? PROTECTION_LEDE['turn-on']
        : exitRearm === 'approve'
          ? (nothingToDo ? PROTECTION_LEDE.kept : PROTECTION_LEDE.approve)
          : restarts
            ? 'Automation starts again for this position, with the settings it had. Confirm each step in your wallet.'
            : 'Automation starts again for this position. Your wallet may first ask you to approve it again.'
      break
    case 'pause':
      lede = VAULT_TEXT.vault_pause_keeps_auto_exit
      break
    case 'resume':
      lede = 'Automation starts again for this position.'
      break
    case 'unsubscribe':
      lede = `Domino is no longer notified of changes to position #${root}. Your position stays in your wallet.`
      break
    case 'revoke':
      lede = `Your automation can no longer act on position #${root}. Your position stays in your wallet.`
      break
    case 'withdraw-child':
      lede = subject ? CHILD_TEXT(subject.tokenId) : 'A position Domino opened goes to your wallet as a plain position, with no automation.'
      break
    case 'recover-token':
      lede = RECOVER_TOKEN_TEXT
      break
    case 'recover-position':
      lede = RECOVER_POSITION_TEXT
      break
  }

  // What a half-typed recovery still needs, in the clients' own words; nothing while a field is empty.
  const tokenProblem = typedToken && !typedToken.ok && typedToken.problem === 'token' ? CLOSED_TEXT.vault_invalid_token : null
  const amountProblem = typedToken && !typedToken.ok && typedToken.problem === 'amount'
    ? (typedToken.token?.decimals === null ? 'Enter a whole number of raw units, greater than zero.' : `Enter an amount greater than zero, with at most ${typedToken.token?.decimals ?? 0} decimals.`)
    : null
  const idProblem = kind === 'recover-position' && settled.id.trim() !== '' && typedId === null ? CLOSED_TEXT.vault_invalid_token_id : null
  const amountUnit = typedToken?.token
    ? (typedToken.token.decimals === null ? `In raw units: ${typedToken.token.label}'s decimals aren't known.` : `In ${typedToken.token.label}.`)
    : "In the token's units, once its address is entered."

  const footer = finished || nothingToDo ? (
    <Button type="button" variant="outline" size="lg" className="w-full" onClick={onClose} data-v2in-close="">
      Back to position
    </Button>
  ) : (
    <>
      <Button type="button" variant="primary" size="lg" className="w-full" disabled={!canPress} aria-busy={run.running || undefined} data-v2in-send={kind} onClick={() => void run.press()}>
        {PRIMARY[shown]}
      </Button>
      {gate.mode === 'preview' && <LockedNote copy={gate.lockedCopy} />}
    </>
  )

  return (
    <FlowDialog name={`vault-${kind}`} title={follow ? (STEP_TITLE[follow] as string) : exitRearm ? PROTECTION_TITLE[exitRearm] : TITLE[kind]} onClose={onClose} footer={footer}>
      <p className="dm-receipt-lede" data-vault-lede={shown} data-vault-exit-rearm={exitRearm ? (nothingToDo ? 'kept' : exitRearm) : undefined}>
        {lede}
      </p>
      {(kind === 'withdraw' || kind === 'return' || kind === 'leave') && !follow && (
        <KeyValueList className="dm-receipt" data-vault-receive={kind}>
          <KeyValue label={elsewhere ? 'Amount' : 'You receive'}>
            {shownReserves.length || view.reserves.known ? <Amounts list={shownReserves} tokens={tokens} /> : !locked && !snapshot && !live.error ? <Skeleton className="dm-receipt-skel" /> : <span title={view.reserves.known ? undefined : `Not read: ${view.reserves.reason.replaceAll('_', ' ')}`}>—</span>}
          </KeyValue>
          {kind === 'withdraw' && elsewhere && (
            <KeyValue label="Sent to">{recipient ? <span className="dm-mono" title={recipient} translate="no" data-v2in-sent-to={recipient}>{shortAddress(recipient)}</span> : '—'}</KeyValue>
          )}
          {kind === 'leave' && view.successors.length > 0 && (
            <KeyValue label="Positions back to your wallet">{view.successors.map((id) => `#${id}`).join(', ')}</KeyValue>
          )}
          <KeyValue label="Domino fee">None</KeyValue>
        </KeyValueList>
      )}
      {kind === 'withdraw' && elsewhere && (
        <label className="dm-label dm-acct-lf dm-v2in-field">
          Address you own
          <input className="dm-field dm-acct-mono-field" value={form.recipient} spellCheck={false} autoComplete="off" disabled={typing} onChange={(event) => setForm((old) => ({ ...old, recipient: event.target.value }))} data-v2in-recipient="" aria-invalid={recipientProblem ? true : undefined} />
          <span className="dm-hint">{ELSEWHERE_HINT}</span>
          {recipientProblem && <span className="dm-error" data-v2in-recipient-problem="">{recipientProblem}</span>}
        </label>
      )}
      {kind === 'withdraw-child' && (
        <KeyValueList className="dm-receipt" data-vault-receive="withdraw-child">
          <KeyValue label="Position back to your wallet">{subject ? `#${subject.tokenId}` : '—'}</KeyValue>
          <KeyValue label="Domino fee">None</KeyValue>
        </KeyValueList>
      )}
      {kind === 'recover-token' && (
        <div className="grid gap-3" data-recover-form="token">
          <label className="dm-label dm-acct-lf dm-v2in-field">
            Token address
            <input className="dm-field dm-acct-mono-field" value={form.token} spellCheck={false} autoComplete="off" disabled={typing} onChange={(event) => setForm((old) => ({ ...old, token: event.target.value }))} data-recover-token="" aria-invalid={tokenProblem ? true : undefined} />
            {tokenProblem && <span className="dm-error">{tokenProblem}</span>}
          </label>
          <label className="dm-label dm-acct-lf dm-v2in-field">
            Amount
            <input className="dm-field" inputMode="decimal" value={form.amount} spellCheck={false} autoComplete="off" disabled={typing} onChange={(event) => setForm((old) => ({ ...old, amount: event.target.value }))} data-recover-amount="" aria-invalid={amountProblem ? true : undefined} />
            <span className="dm-hint" data-recover-unit="">{amountUnit}</span>
            {amountProblem && <span className="dm-error">{amountProblem}</span>}
          </label>
          <KeyValueList className="dm-receipt" data-vault-receive="recover-token">
            <KeyValue label="You receive">{typedToken?.ok ? <span className="tnum" title={amountWords(typedToken.amount, typedToken.token).exact}>{amountWords(typedToken.amount, typedToken.token).text}</span> : '—'}</KeyValue>
            <KeyValue label="Domino fee">None</KeyValue>
          </KeyValueList>
        </div>
      )}
      {kind === 'recover-position' && (
        <div className="grid gap-3" data-recover-form="position">
          <label className="dm-label dm-acct-lf dm-v2in-field">
            Position number
            <input className="dm-field" inputMode="numeric" value={form.id} spellCheck={false} autoComplete="off" disabled={typing} onChange={(event) => setForm((old) => ({ ...old, id: event.target.value }))} data-recover-id="" aria-invalid={idProblem ? true : undefined} />
            <span className="dm-hint">The number of a position your automation holds without managing it.</span>
            {idProblem && <span className="dm-error">{idProblem}</span>}
          </label>
          <KeyValueList className="dm-receipt" data-vault-receive="recover-position">
            <KeyValue label="Position back to your wallet">{typedId !== null ? `#${typedId}` : '—'}</KeyValue>
          </KeyValueList>
        </div>
      )}
      {kind === 'return' && <p className="text-body text-fg-muted">{LEAVE_IT}</p>}
      {kind === 'leave' && view.dex === 4 && !follow && !exitLive && (
        <p className="text-body text-fg-muted" data-leave-v4="">
          Afterwards you can remove Domino from position #{root.toString()} and revoke your automation's approval on it.
        </p>
      )}
      {/* Money #4: said first, before anything else is asked of the person. */}
      {guarded && past === true && !finished && (
        <PastEdge
          acknowledged={acknowledged}
          onAcknowledge={(next) => {
            acknowledgedNow.current = next
            setAcknowledged(next)
          }}
          disabled={run.running}
          onTurnOff={onTurnOff}
        />
      )}
      {kind === 'rearm' && !nothingToDo && (
        <Check checked={consent} onChange={setConsent} disabled={run.running || finished} data-rearm-consent="">
          {consentText}
        </Check>
      )}
      {/* The consent is the box above; the return's note is already in its lede, and so is Auto-exit's pause in its own
          automation's Leave automation (Changed on purpose 2026-10-06, the integration review, rugged-literal #2). */}
      {review?.notes.filter((key) => key !== 'vault_consent_uncollected_fees' && key !== 'vault_returns_to_owner' && !(protection && key === 'vault_exit_all_pauses_orders')).map((key) => (
        <p key={key} className="text-body text-fg-muted" data-vault-note={key}>
          {VAULT_TEXT[key].replace('{fee}', view.mode === 2 ? automationFeeText(2) : automationFeeText(1))}
        </p>
      ))}
      {steps.length > 0 && !nothingToDo && <WalletSteps steps={steps} phases={locked ? undefined : run.phases} name={`vault-${kind}`} />}
      {waitingForReview && !nothingToDo && (
        <p role="status" className="text-body text-fg-muted">
          Checking…
        </p>
      )}
      {run.running && run.phases.some((p) => p.phase === 'working' && p.note === 'wallet') && (
        <p role="status" className="text-body font-medium text-fg" data-v2in-progress="wallet">
          Confirm in your wallet…
        </p>
      )}
      {info && (
        <p role="status" className="text-body text-fg" data-v2in-info={info === ALREADY_RETURNED ? 'already-returned' : 'changed'}>
          {info}
        </p>
      )}
      {/* Changed on purpose 2026-10-06 (the review of point 5): once the action is done, a review made again after it (the
          page reads again) has nothing to say: "This step is already done." would stand under a finished dialog. */}
      <ErrorLine error={live.error ?? (finished ? null : reviewError) ?? run.notice} />
      {offerElsewhere && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => { setElsewhere(true); setRound((n) => n + 1) }} data-v2in-send-elsewhere="">
            {ELSEWHERE}
          </Button>
        </div>
      )}
      {followUps.length > 0 && (
        <div className="flex flex-wrap gap-2" data-leave-follow-ups="">
          {followUps.map((next) => (
            <Button key={next} type="button" variant="outline" size="sm" onClick={() => { setFinished(false); setReview(null); setFollow(next) }} data-v2in-follow={next}>
              {next === 'unsubscribe' ? 'Remove Domino from this position' : 'Revoke approval'}
            </Button>
          ))}
        </div>
      )}
      <Details data-vault-details="">
        <Fact label="Automation">
          {vaultHref ? (
            <a href={vaultHref} target="_blank" rel="noreferrer noopener" className="underline" data-v2-explorer="">
              {view.vault}
            </a>
          ) : (
            view.vault
          )}
        </Fact>
        <Fact label="Position">#{root.toString()}</Fact>
        {subject && <Fact label="Withdrawn">#{subject.tokenId.toString()}</Fact>}
        {snapshot && <Fact label="Read at block">{snapshot.blockNumber.toString()}</Fact>}
        {review && <Fact label="Reviewed at block">{review.snapshot.blockNumber.toString()}</Fact>}
      </Details>
    </FlowDialog>
  )
}
