import { Button, StepMarker } from '../../components/ui'
import { v2Chain } from '../../v2/chains'
import { v2TxUrl } from '../../v2/explorers'
import { EXACT_FRACTION, SHOWN_FRACTION } from '../../v2/plan/present'
import type { ActionName, Address, V2ChainId } from '../../v2/types'
import { COPY } from './copy'
import { stepLabel, type RunView } from './run'
import { ErrorLine, Note } from './ui'
import { amountText, labelOf, type TokenBook } from './tokens'

/**
 * The line under a step: its live state. Changed on purpose 2026-10-06 (the owner's point 4, as New position's wallet
 * steps: titles only until something happens): no "Waiting" under a step not started, nor under one being checked (its
 * row and its turning arc say so, ROW below).
 */
const STATUS: Record<string, string> = {
  waiting: '',
  preparing: '',
  ready: '',
  wallet: COPY.wallet.inWallet,
  sent: COPY.wallet.pendingNetwork,
  unknown: 'May have been sent',
  included: COPY.wallet.included,
  finalized: COPY.wallet.finalized,
}

/** A step's row state in New position's timeline (styles/flow.css .dm-flow-wsteps): done, in the wallet, on the network. */
const ROW: Record<string, string | undefined> = { preparing: 'reading', wallet: 'wallet', sent: 'chain', included: 'done', finalized: 'done' }

/** Whether every step is done (the action, or the batch, included). */
export function stepsDone(view: RunView): boolean {
  const current = view.steps[view.current]
  return view.current >= view.steps.length || ((current?.kind === 'action' || current?.kind === 'batch') && (current.status === 'included' || current.status === 'finalized'))
}

/**
 * The wallet's steps of a reviewed action (spec F7 §2.6.1 card 5; the S1 reference's WalletSteps): each in order with
 * its state ("Included", then "Finalized"). A batch is one step: every call runs together or not at all. A reverted
 * Permit2 action offers to cancel its signature first. The button for the current step is the dialog's foot
 * (`StepButton`). Changed on purpose 2026-10-03 (the owner, point 9): drawn as New position's wallet steps, a timeline
 * whose done steps turn green with a check and whose step under way turns its arc. Changed on purpose 2026-10-06 (the
 * owner's point 4: little text): no network fee on each step, the review above says it once (./Review.tsx); no line
 * under a step until it is under way; an amount to allow rounded up (as the wallet asks for it), every digit in its title.
 * Changed on purpose 2026-10-14 (incident C1; the owner's decision D0): a step that is in a block says "Confirmed", and
 * keeps that word when its block is final (./copy.ts wallet.included and wallet.finalized, the receipt's own words).
 */
export function StepsList({ chainId, view, action, book, onCancelSignature, onKeepSignature, onRejected }: { chainId: V2ChainId; view: RunView; action: ActionName; book: TokenBook; onCancelSignature: () => void; onKeepSignature: () => void; onRejected: () => void }) {
  const reviewed = view.reviewed
  if (!reviewed) return null
  const permit2 = v2Chain(chainId).permit2 as Address
  return (
    <div className="dm-pa-field" data-position-steps={reviewed.path}>
      {reviewed.path === 'batch' && <Note data-position-batch-note="">{COPY.wallet.oneSignatureAll}</Note>}
      <ol className="dm-flow-wsteps">
        {view.steps.map((step, i) => {
          const state = i < view.current || step.status === 'included' || step.status === 'finalized' ? 'done' : i === view.current ? 'current' : 'upcoming'
          const label = stepLabel(step, action, (token, raw) => amountText(book, token, raw, SHOWN_FRACTION, 'up'), (token) => labelOf(book, token), permit2)
          const whole = stepLabel(step, action, (token, raw) => amountText(book, token, raw, EXACT_FRACTION), (token) => labelOf(book, token), permit2)
          // Added 2026-10-14 (incident C3: waiting never locks): a step sent 20 s ago whose block is not seen yet (./run.ts);
          // before it (C3 review), a sent step whose reads fail on the wallet's network or account says to switch back.
          const status = step.status === 'sent' && step.away ? (step.away === 'chain' ? COPY.wallet.walletAway(v2Chain(chainId).name) : COPY.wallet.accountAway)
            : step.status === 'sent' && step.slow ? COPY.wallet.stillWaiting : STATUS[step.status]
          const explorer = step.status === 'sent' && step.slow && step.hash ? v2TxUrl(chainId, step.hash) : null
          return (
            <li key={`${step.kind}-${i}`} data-position-step={step.kind} data-status={step.status} data-step-state={state === 'done' ? 'done' : state === 'current' ? ROW[step.status] : undefined} data-step-failed={view.error && i === view.current ? '' : undefined}>
              <StepMarker index={i + 1} state={state} label={`${label}, ${state}`} />
              <div className="dm-flow-wstep-body">
                <span className="dm-flow-wstep-title" title={whole}>{label}</span>
                {status && <span className="dm-flow-wstep-note">{status}</span>}
                {explorer && <a className="dm-flow-wstep-note underline" href={explorer} target="_blank" rel="noreferrer noopener" data-step-explorer="">{COPY.wallet.explorer}</a>}
              </div>
            </li>
          )
        })}
      </ol>
      <ErrorLine error={view.error} onRejected={onRejected} busy={view.busy} />
      {view.cancel && (
        <div className="dm-pa-field" data-position-cancel-signature={view.cancel.status}>
          <ErrorLine error={view.cancel.error} />
          {view.cancel.status === 'ready' ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="primary" onClick={onCancelSignature} data-position-cancel-confirm="">{COPY.wallet.cancelSignature}</Button>
              <Button type="button" variant="ghost" onClick={onKeepSignature} data-position-cancel-keep="">{COPY.wallet.keepSignature}</Button>
            </div>
          ) : (
            <Note>{view.cancel.status === 'wallet' ? COPY.wallet.inWallet : COPY.wallet.cancelling}</Note>
          )}
        </div>
      )}
    </div>
  )
}

/** The current step's button, the dialog's foot: one press sends (or signs) it once. `blocked`: a box above is not ticked yet. */
export function StepButton({ view, onConfirm, blocked }: { view: RunView; onConfirm: () => void; blocked: boolean }) {
  const current = view.steps[view.current]
  if (!current || view.cancel) return null
  return (
    <Button
      type="button"
      variant="primary"
      size="lg"
      data-position-confirm={current.kind}
      disabled={view.busy || current.status !== 'ready' || blocked}
      aria-busy={view.busy || current.status === 'preparing' || undefined}
      onClick={onConfirm}
    >
      {current.kind === 'sign-permit' ? COPY.wallet.sign : COPY.wallet.confirm}
    </Button>
  )
}
