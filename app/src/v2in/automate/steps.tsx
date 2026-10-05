import { useEffect, useRef, useState } from 'react'
import type { PreparedV2 } from '../../finance/v2/transact'
import type { ErrorLabels } from '../../v2/errors'
import { describeError, type ErrorView } from './copy'
import { IDLE, OfferedStepError, SentBatchError, SentStepError, sendBatchStep, sendStep, watchFinality, type AutomationSession, type BatchClient, type IncludedReceipt, type StepPhase, type TxClient } from './session'

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
  tx?: { client: TxClient; prepare: () => Promise<PreparedV2> }
  /** Several calls as ONE EIP-5792 batch: one confirmation in the wallet. */
  batch?: BatchClient<unknown>
  /** A signature through the client's own signer. */
  sign?: () => Promise<unknown>
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
  text: "This step was already sent from this page, and its outcome isn't known yet. Check your wallet activity before trying again.",
  code: 'review_already_sent',
})

export interface StepsRun {
  phases: readonly StepPhase[]
  notice: ErrorView | null
  running: boolean
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
export function useStepsRun({ session, steps, context, labels, onStepDone, onAllDone, onError, done: before = [] }: {
  session: AutomationSession | null
  steps: readonly WalletStep[]
  context: 'vault' | 'autoExit'
  labels: ErrorLabels
  onStepDone?: (outcome: StepOutcome) => void
  onAllDone?: (outcomes: readonly StepOutcome[]) => void
  onError?: (error: ErrorView, raw: unknown) => boolean
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
  useEffect(() => {
    generation.current++
  }, [steps])
  useEffect(() => () => void generation.current++, [])

  async function runOne(index: number, step: WalletStep, alive: () => boolean, set: (phase: StepPhase) => void): Promise<IncludedReceipt | null> {
    if (!session) throw new Error('connect_wallet')
    if (step.tx) {
      const result = await sendStep(session, step.tx.client, step.tx.prepare, set, alive)
      if (!result) return null
      if (result.receipt.state === 'included') {
        const client = step.tx.client
        void watchFinality(session, () => client.receipt(result.hash), () => set({ phase: 'finalized', hash: result.hash }), alive)
      }
      return result.receipt
    }
    if (step.batch) {
      const batch = step.batch
      const result = await sendBatchStep(session, batch, set, alive)
      if (!result) return null
      if (result.receipt.state === 'included') void watchFinality(session, () => batch.receipt(result.batchId), () => set({ phase: 'finalized', batchId: result.batchId }), alive)
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
        if (handedOver(phase)) {
          if (alive()) setNotice(ALREADY_SENT)
          return
        }
        const set = (next: StepPhase) => {
          if (!alive()) return
          current.current = current.current.map((p, i) => (i === index ? next : p))
          setPhases(current.current)
        }
        const step = steps[index]
        let receipt: IncludedReceipt | null
        try {
          receipt = await runOne(index, step, alive, set)
        } catch (error) {
          if (!alive()) return
          const view = describeError(error, context, labels)
          if (onError?.(view, error)) {
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

  return { phases, notice, running, complete: phases.length > 0 && phases.every(done), press }
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
