import { useEffect, useRef, useState } from 'react'
import type { PreparedV2 } from '../../finance/v2/transact'
import type { ErrorLabels } from '../../v2/errors'
import { describeError, type ErrorView } from './copy'
import { IDLE, OfferedStepError, SentBatchError, SentStepError, resumeBatchStep, resumeStep, sendBatchStep, sendStep, type AutomationSession, type BatchClient, type IncludedReceipt, type StepPhase, type TxClient } from './session'
import { positionChanged } from '../lists/positionSync'
import { confirmedOperationState, recordConfirmedOperation, reorgConfirmedOperation, subscribeConfirmedOperations, type OperationScope } from '../../lib/confirmedOperations'
import { RECEIPT_FOLLOW, type FollowedReceipt } from '../journey/receiptFollow'
import { reconcileAutomationReceipt } from './receipt'

/**
 * A review's wallet steps in the look and the rhythm of Set up automation's own (screens/SequenceCreate.tsx): the list of
 * steps, each marked as it goes ("Confirm in your wallet.", "Waiting for the network.", "Included", then "Finalized";
 * a delay is never a failure), and ONE press that offers them in order, each confirmed (its receipt in a block, or its
 * signature) before the next is offered. A step that failed before the wallet saw it is offered again by the next press;
 * a step the wallet saw (a hash, a batch id, or the client's word that it was handed over) is never offered again from
 * here: its outcome is the chain's to say, and the press says so instead.
 */

export interface WalletStep {
  key: string
  /** The list's line: "Approve position #7 to your new vault". */
  title: string
  /** One plain sentence under it (what a batch holds, for instance). */
  note?: string
  /** One transaction, prepared by its client (re-derived from the chain and simulated) right when it is offered. */
  tx?: { client: TxClient; prepare: () => Promise<PreparedV2>; resume?: () => `0x${string}` | null }
  /** Several calls as ONE EIP-5792 batch: one confirmation in the wallet. */
  batch?: BatchClient<unknown>
  /** A signature through the client's own signer. */
  sign?: () => Promise<unknown>
  /**
   * The contract this step talks to, for its failure's words, when it is not the run's (Added 2026-10-06, the owner's
   * point 5: Auto-exit's one run holds the vault's approval and creation beside the module's registration).
   */
  context?: 'vault' | 'autoExit'
}

export interface StepOutcome {
  index: number
  step: WalletStep
  receipt: IncludedReceipt | null
}

const done = (phase: StepPhase) => phase.phase === 'included' || phase.phase === 'finalized' || phase.phase === 'signed'
const busy = (phase: StepPhase) => phase.phase === 'working' || phase.phase === 'sent'
/** Handed to the wallet already, with no known outcome: never offered again from here. */
const handedOver = (phase: StepPhase) => phase.phase === 'failed' && (phase.hash !== undefined || phase.batchId !== undefined || phase.offered === true)

const ALREADY_SENT: ErrorView = Object.freeze({
  text: 'This transaction is already sent. Check its confirmation to continue.',
  code: 'review_already_sent',
})

export interface StepsRun {
  phases: readonly StepPhase[]
  notice: ErrorView | null
  running: boolean
  /** A previous send is unresolved: the next press checks that transaction, never sends it again. */
  pending: boolean
  /** Every step is done (included, finalized or signed). */
  complete: boolean
  /** Offers the steps not done yet, in order, one confirmation each. */
  press: () => Promise<void>
}

/**
 * The run of one review's steps. `onStepDone` hears each confirmed step; `onError` may handle a failure itself (a batch
 * the wallet cannot make: the caller turns to the steps; a review the chain no longer matches: the caller reviews
 * again) and return true, and the press then stops without a notice. `done` names steps already done before this list
 * (a signature made before the steps changed path).
 */
export function useStepsRun({ session, steps, context, labels, affected, onStepDone, onAllDone, onError, done: before = [] }: {
  session: AutomationSession | null
  steps: readonly WalletStep[]
  context: 'vault' | 'autoExit'
  labels: ErrorLabels
  affected?: OperationScope
  onStepDone?: (outcome: StepOutcome) => void
  onAllDone?: (outcomes: readonly StepOutcome[]) => void
  /** `at`: the step that failed, by its place in the list and its key (Added 2026-10-06: a later step found unnecessary is the caller's to call done). */
  onError?: (error: ErrorView, raw: unknown, at: { index: number; key: string }) => boolean
  done?: readonly string[]
}): StepsRun {
  const start = (list: readonly WalletStep[]): StepPhase[] => list.map((step) => (before.includes(step.key) ? { phase: 'signed' } : IDLE))
  const [phases, setPhases] = useState<StepPhase[]>(() => start(steps))
  const [notice, setNotice] = useState<ErrorView | null>(null)
  const [running, setRunning] = useState(false)
  // A new list (a new review, or the batch given up for the steps) starts over; what was signed before stays signed.
  // Changed on purpose 2026-10-05: a run still going on the old list ends with it (its next step stops, its generation
  // gone), so the list never rests on "running" with nothing asked of the wallet; the person presses again.
  const [seen, setSeen] = useState(steps)
  if (seen !== steps) {
    setSeen(steps)
    setPhases(start(steps))
    setNotice(null)
    setRunning(false)
  }
  const current = useRef<StepPhase[]>(phases)
  useEffect(() => {
    current.current = phases
  }, [phases])
  const generation = useRef(0)
  const watches = useRef(new Set<() => void>())
  useEffect(() => {
    generation.current++
  }, [steps])
  useEffect(() => () => { generation.current++; for (const stop of watches.current) stop(); watches.current.clear() }, [])

  function observe(receipt: IncludedReceipt, step: WalletStep, set: (phase: StepPhase) => void, alive: () => boolean, phase: { hash?: `0x${string}`; batchId?: string }, read: () => Promise<FollowedReceipt>) {
    if (!session) return
    const scope = { ...affected, tokenIds: /approve/.test(step.key) ? [] : affected?.tokenIds ?? [] }
    const operation = recordConfirmedOperation({ ...scope, chainId: session.chainId, wallet: session.owner, receipt, onFinalized: async () => (await read()).state === 'finalized' })
    if (!operation) positionChanged({ ...scope, chainId: session.chainId, wallet: session.owner, block: receipt.blockNumber, blockHash: receipt.blockHash })
    if (operation?.phase === 'included' && session.chainId !== 4663) {
      // The original transaction client outlives this view. Finality updates the shared receipt, not only this step's label.
      const active = session
      RECEIPT_FOLLOW.follow(`${operation.chainId}:${operation.wallet}:${operation.hash}`, {
        read: () => active.serial(read), available: () => active.receiptAvailability?.() ?? 'ready',
        accept: next => reconcileAutomationReceipt(operation, next, recordConfirmedOperation, reorgConfirmedOperation,
          confirmedOperationState().find(item => item.chainId === operation.chainId && item.hash === operation.hash) ?? null),
      })
    }
    if (!operation || operation.phase !== 'included' || !alive()) return
    const stop = subscribeConfirmedOperations(next => {
      if (next.chainId !== operation.chainId || next.hash !== operation.hash || next.blockHash !== operation.blockHash) return
      if (next.phase === 'finalized') set({ phase: 'finalized', ...phase })
      if (next.phase === 'reorged' && alive()) {
        set({ phase: 'failed', ...phase })
        const failure = phase.hash ? new SentStepError('receipt_reorged', phase.hash) : new SentBatchError('receipt_reorged', phase.batchId ?? '')
        setNotice(describeError(failure, step.context ?? context, labels))
      }
      if (next.phase === 'finalized' || next.phase === 'reorged' || !alive()) { stop(); watches.current.delete(stop) }
    })
    watches.current.add(stop)
  }

  async function runOne(index: number, step: WalletStep, phase: StepPhase, alive: () => boolean, set: (phase: StepPhase) => void): Promise<IncludedReceipt | null> {
    if (!session) throw new Error('connect_wallet')
    if (step.tx) {
      const known = ('hash' in phase ? phase.hash : undefined) ?? step.tx.resume?.()
      if (known) { await session.ensureChain(); if (!alive()) return null }
      const result = known ? await resumeStep(session, step.tx.client, known, set) : await sendStep(session, step.tx.client, step.tx.prepare, set, alive)
      if (!result) return null
      observe(result.receipt, step, set, alive, { hash: result.hash }, () => step.tx!.client.receipt(result.hash))
      return result.receipt
    }
    if (step.batch) {
      const batch = step.batch
      const known = 'batchId' in phase ? phase.batchId : undefined
      if (known) { await session.ensureChain(); if (!alive()) return null }
      const result = known ? await resumeBatchStep(session, batch, known, set) : await sendBatchStep(session, batch, set, alive)
      if (!result) return null
      observe(result.receipt, step, set, alive, { batchId: result.batchId }, () => batch.receipt(result.batchId))
      return result.receipt
    }
    if (step.sign) {
      set({ phase: 'working', note: 'checking' })
      await session.ensureChain()
      set({ phase: 'working', note: 'signing' })
      const sign = step.sign
      await session.serial(() => sign())
      set({ phase: 'signed' })
      return null
    }
    void index
    return null
  }

  async function press(): Promise<void> {
    if (running || !session) return
    const gen = ++generation.current
    const alive = () => generation.current === gen
    setRunning(true)
    setNotice(null)
    const outcomes: StepOutcome[] = []
    try {
      for (let index = 0; index < steps.length; index++) {
        const phase = current.current[index] ?? IDLE
        if (done(phase)) continue
        const step = steps[index]
        if (handedOver(phase) && !('hash' in phase && phase.hash) && !('batchId' in phase && phase.batchId) && !step.tx?.resume?.()) {
          if (alive()) setNotice(ALREADY_SENT)
          return
        }
        const set = (next: StepPhase) => {
          if (!alive()) return
          current.current = current.current.map((p, i) => (i === index ? next : p))
          setPhases(current.current)
        }
        let receipt: IncludedReceipt | null
        try {
          receipt = await runOne(index, step, phase, alive, set)
        } catch (error) {
          if (!alive()) return
          const view = describeError(error, step.context ?? context, labels)
          if (onError?.(view, error, { index, key: step.key })) {
            set(IDLE)
            return
          }
          set({ phase: 'failed', ...(error instanceof SentStepError ? { hash: error.hash } : {}), ...(error instanceof SentBatchError ? { batchId: error.batchId } : {}), ...(error instanceof OfferedStepError ? { offered: true as const } : {}) })
          setNotice(view)
          return
        }
        if (!alive()) return
        if (!step.sign && receipt === null) return
        const outcome = { index, step, receipt }
        outcomes.push(outcome)
        onStepDone?.(outcome)
      }
      if (alive()) onAllDone?.(outcomes)
    } finally {
      if (alive()) setRunning(false)
    }
  }

  return { phases, notice, running, pending: phases.some(handedOver) || notice?.code === 'review_already_sent', complete: phases.length > 0 && phases.every(done), press }
}

/** A step's line under its title, in Set up automation's words. */
function caption(phase: StepPhase): string | null {
  switch (phase.phase) {
    case 'working':
      return phase.note === 'wallet' ? 'Confirm in your wallet.' : phase.note === 'signing' ? 'Sign in your wallet.' : 'Checking…'
    case 'sent':
      return 'Waiting for the network.'
    case 'included':
      return 'Included'
    case 'finalized':
      return 'Finalized'
    case 'signed':
      return 'Signed'
    case 'failed':
      return handedOver(phase) ? 'Confirmation not available yet. Check the transaction to continue.' : null
    default:
      return null
  }
}

/** The list of a review's wallet steps (Set up automation's own markup); `phases` absent: nothing pressed yet (a preview). */
export function WalletSteps({ steps, phases, name }: { steps: readonly WalletStep[]; phases?: readonly StepPhase[]; name: string }) {
  return (
    <ol className="dm-flow-wsteps dm-seq-wsteps" data-wallet-steps={name} aria-live="polite">
      {steps.map((step, index) => {
        const phase = phases?.[index] ?? IDLE
        const state = done(phase) ? 'done' : busy(phase) ? 'current' : phase.phase === 'failed' ? 'failed' : 'upcoming'
        const line = caption(phase) ?? step.note ?? null
        return (
          <li key={`${step.key}-${index}`} data-wallet-step={step.key} data-step-state={state} data-step-phase={phase.phase}>
            <span aria-hidden="true" className="dm-step-marker" data-state={state === 'done' ? 'done' : state === 'current' ? 'current' : undefined}>
              {state === 'done' ? '✓' : index + 1}
            </span>
            <span className="dm-flow-wstep-body">
              <span className="dm-flow-wstep-title">{step.title}</span>
              {line && <span className="dm-flow-wstep-note">{line}</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
