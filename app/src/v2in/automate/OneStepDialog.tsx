import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button } from '../../components/ui'
import type { ErrorLabels } from '../../v2/errors'
import type { V2ChainId, V2Contracts } from '../../v2/types'
import { describeError, type ErrorView } from './copy'
import { openAutomation, type AutomationSession } from './session'
import { useStepsRun, WalletSteps, type WalletStep } from './steps'
import { ErrorLine, FlowDialog, LockedNote } from './ui'

/**
 * A one-step owner action in the look of the position page's action dialogs (cancel an exit order, cancel a signed order
 * that was never registered, claim what an exit could not deliver): what it does in plain words, the step, and one press.
 * `locked` (the gate's `preview`, or anything drawn from the package's fixtures): the review stops there, and `lockedCopy`
 * stands where the wallet would be asked. Live: the session is opened (the wallet on the chain), `prepare` builds the step
 * through the closed client (checks first: a refusal is said before anything is sent), and the press offers it once.
 */
export function OneStepDialog({ name, title, primary, children, chainId, contracts, locked, lockedCopy, context, labels, prepare, onDone, onClose }: {
  name: string
  title: string
  primary: string
  children: ReactNode
  chainId: V2ChainId
  contracts: V2Contracts
  locked: boolean
  lockedCopy: string
  context: 'vault' | 'autoExit'
  labels: ErrorLabels
  /** The step, built through the client once the session is open (a read may refuse it first). */
  prepare: (session: AutomationSession) => Promise<WalletStep> | WalletStep
  onDone: () => void
  onClose: () => void
}) {
  const [session, setSession] = useState<AutomationSession | null>(null)
  const [step, setStep] = useState<WalletStep | null>(null)
  const [error, setError] = useState<ErrorView | null>(null)
  const [finished, setFinished] = useState(false)
  // The caller's step builder, fixed for this dialog's life.
  const build = useRef(prepare)
  useEffect(() => {
    if (locked) return
    let alive = true
    void (async () => {
      try {
        const opened = await openAutomation(chainId, contracts)
        const made = await build.current(opened)
        if (!alive) return
        setSession(opened)
        setStep(made)
      } catch (failure) {
        if (alive) setError(describeError(failure, context, labels))
      }
    })()
    return () => {
      alive = false
    }
  }, [locked, chainId, contracts, context, labels])
  const steps = useMemo(() => (step ? [step] : []), [step])
  const run = useStepsRun({ session, steps, context, labels, onAllDone: () => { setFinished(true); onDone() } })
  const footer = finished ? (
    <Button type="button" variant="outline" size="lg" className="w-full" onClick={onClose} data-v2in-close="">
      Back to position
    </Button>
  ) : (
    <>
      <Button type="button" variant="primary" size="lg" className="w-full" disabled={locked || !step || run.running} aria-busy={run.running || undefined} data-v2in-send={name} onClick={() => void run.press()}>
        {primary}
      </Button>
      {locked && <LockedNote copy={lockedCopy} />}
    </>
  )
  return (
    <FlowDialog name={name} title={title} onClose={onClose} footer={footer}>
      {children}
      {(locked || step) && <WalletSteps steps={step ? steps : [{ key: name, title: primary.replace(/ in wallet$/, '') }]} phases={locked ? undefined : run.phases} name={name} />}
      {!locked && !step && !error && (
        <p role="status" className="text-body text-fg-muted">
          Checking…
        </p>
      )}
      <ErrorLine error={error ?? run.notice} />
    </FlowDialog>
  )
}
