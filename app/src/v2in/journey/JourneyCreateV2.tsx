import { useEffect, useRef, useSyncExternalStore, type ReactElement } from 'react'
import { CreatedNext } from '../../components/create/CreatedNext'
import type { PairBalancesState } from '../../components/create/usePairBalances'
import { rawBalances } from '../../components/create/valuation'
import { Button } from '../../components/ui'
import { openWalletDialog } from '../../finance/signedOut'
import { crosschainSessionAccess } from '../../finance/v2/http'
import { publishCreated } from '../../lib/create/createProgress'
import type { JourneyState as V1JourneyState } from '../../lib/create/journey'
import { reviewPlan } from '../../lib/create/reviewPlan'
import { useWalletIdentity } from '../../lib/walletIdentity'
import type { V2Gate } from '../../v2/gate'
import { useJourneyNetwork } from './context'
import { JOURNEY } from './copy'
import { inputsFromV1, requestFromV1, zapStateFromV1, type V1Funding } from './model/fromV1'
import { journeyPrice } from './model/state'
import { FinalControl, ReviewStage } from './ReviewStage'
import { testPlannerOn } from './source'
import { useJourneyRun, type RunView } from './run'
import { amountText, labelOf, tokenBook } from './tokens'

/**
 * The owner's New position on Domino V2 (2026-10-05: "my screens, with everything connected"): today's journey
 * (components/create/Journey.tsx) keeps every screen he built; its last step, Review and Create position, runs on the new
 * contracts once Robinhood Chain's S1 gate is `live`. The plan from position-plan-v1 for what his journey chose
 * (./model/fromV1.ts), the review of it and the wallet's steps through the closed money client, exactly as the zap path
 * runs them (./run.ts, ./ReviewStage.tsx). Wherever that gate is not live (the preview alias, a build or page without
 * the wrapper), today's own Review and Create position, handed in as `v1`, stand unchanged.
 *
 * Two lazily mounted parts, as Journey.tsx draws its step: the footer (the default export) owns the run, as today's
 * footer owns Create position; Review's body (ReviewV2) draws the same run's review, through the small store below.
 */

type Gate = Extract<V2Gate, { mode: 'preview' | 'live' }>
type Shared = { view: RunView; forgetUnsettled: () => void }

let shared: Shared | null = null
const listeners = new Set<() => void>()
function share(next: Shared | null) {
  shared = next
  for (const listener of listeners) listener()
}
function subscribeShared(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const sharedNow = (): Shared | null => shared

const IDLE: RunView = { stage: 'idle', requoting: false, reviewed: null, asked: null, steps: [], current: 0, busy: false, error: null, receipt: null, feePerGas: null, cancel: null, round: 0 }

/** The live S1 gate this page's wrapper read, or why there is none: outside the wrapper, still reading, or not live. */
function useLiveGate(): Gate | 'outside' | 'reading' | 'not-live' {
  const network = useJourneyNetwork()
  if (network === null) return 'outside'
  if (network.s1 === undefined) return 'reading'
  return network.s1.mode === 'live' ? network.s1 : 'not-live'
}

/** What a short wallet lacks, in today's words for the zap path ("Your wallet has X; this position needs Y."). */
function shortCopy(funding: Extract<V1Funding, { kind: 'short' }>, book: ReturnType<typeof tokenBook>): string {
  return JOURNEY.review.walletShort(amountText(book, funding.token, funding.have), amountText(book, funding.token, funding.need))
}

type CreateProps = { state: V1JourneyState; balances: PairBalancesState; onBusy?: (busy: boolean) => void; v1: ReactElement }

/** Review's footer: Create position on the new contracts once the gate is live, else today's own control (`v1`). */
export default function JourneyCreateV2({ state, balances, onBusy, v1 }: CreateProps) {
  const gate = useLiveGate()
  if (gate === 'outside' || gate === 'not-live') return v1
  // Never today's Create position while the gate is still read: it could leave a Domino V1 deposit held.
  if (gate === 'reading') {
    return (
      <Button type="button" variant="primary" size="xl" className="w-full" disabled data-create-position="reading">
        {JOURNEY.final.create}
      </Button>
    )
  }
  return <LiveCreate state={state} balances={balances} onBusy={onBusy} gate={gate} />
}

function LiveCreate({ state, balances, onBusy, gate }: Omit<CreateProps, 'v1'> & { gate: Gate }) {
  const identity = useWalletIdentity()
  const connected = identity.kind === 'connected'
  const owner = identity.kind === 'connected' ? identity.address : null
  const access = useSyncExternalStore(crosschainSessionAccess.subscribe, crosschainSessionAccess.getSnapshot, () => 'pending')
  // The plan is asked for the signed-in wallet only (position-plan-v1); a test build's planner needs no session.
  const signedIn = access.startsWith('ready:') || testPlannerOn()
  const zap = zapStateFromV1(state)
  const funding = inputsFromV1(zap, reviewPlan(state, rawBalances(balances)))
  const book = tokenBook(4663, zap?.pool ? [...zap.pool.tokens] : [])
  const run = useJourneyRun({
    chainId: 4663,
    gate,
    inputs: funding.kind === 'inputs' ? funding.inputs : [],
    label: (token) => labelOf(book, token),
    request: (consent) => requestFromV1(zap, funding, consent),
  })
  const view = run.view
  // The run as of the last draw, for the effects below, which go by the choice and by Review closing, not by each draw.
  const latest = useRef(run)
  useEffect(() => {
    latest.current = run
  })
  // One quote per choice: asked once the wallet is connected and signed in and the deposit is funded, asked again when
  // a choice changes, never while a step is with the wallet or on its way.
  const ask =
    connected && signedIn && zap?.pool && zap.range && funding.kind === 'inputs'
      ? JSON.stringify([owner, zap.pool.id, zap.range, zap.slippage, funding.inputs.map((input) => [input.token, input.amount.toString()])])
      : null
  useEffect(() => {
    if (ask === null) return
    const current = latest.current
    const now = current.view
    if (now.busy || now.receipt || now.steps.some((step) => step.status === 'sent' || step.status === 'included' || step.status === 'finalized' || step.status === 'unknown')) return
    current.start()
  }, [ask])
  useEffect(() => {
    const owned = latest
    return () => {
      owned.current.reset()
      share(null)
    }
  }, [])
  // Review's body draws this same run: a copy, since the run's view changes in place.
  useEffect(() => {
    share({ view: { ...view, steps: view.steps.map((step) => ({ ...step })) }, forgetUnsettled: run.forgetUnsettled })
  })
  const busy = view.busy
  useEffect(() => {
    onBusy?.(busy)
  }, [busy, onBusy])
  const tokenId = view.receipt?.read?.summary.tokenId ?? null
  useEffect(() => {
    if (tokenId !== null) publishCreated(tokenId.toString(), owner)
  }, [tokenId, owner])

  if (tokenId !== null) return <CreatedNext tokenId={tokenId.toString()} />
  if (connected && !signedIn) {
    return (
      <>
        <Button type="button" variant="primary" size="xl" className="w-full" onClick={openWalletDialog} data-create-signin="" aria-describedby="create-reason">
          {JOURNEY.review.signIn}
        </Button>
        <p id="create-reason" className="dm-flow-reason" data-align="start" data-zap-reason="signed-out">
          {JOURNEY.review.signInForQuote}
        </p>
      </>
    )
  }
  if (funding.kind === 'short') {
    return (
      <>
        <Button type="button" variant="primary" size="xl" className="w-full" disabled data-create-position="short" aria-describedby="create-reason">
          {JOURNEY.final.create}
        </Button>
        <p id="create-reason" className="dm-flow-reason" data-align="start" data-zap-reason="short">
          {shortCopy(funding, book)}
        </p>
      </>
    )
  }
  return (
    <FinalControl
      gate={gate}
      view={view}
      blockedForPrice={false}
      connected={connected}
      onRun={run.run}
      onCancelSignature={run.cancelSignature}
      onKeepSignature={run.keepSignature}
      onRejected={run.forgetUnsettled}
    />
  )
}

type ReviewProps = { state: V1JourneyState; now: number; balances: PairBalancesState; v1: ReactElement }

/** Review's body: the plan's review once the gate is live, else today's own Review (`v1`). */
export function ReviewV2({ state, now, balances, v1 }: ReviewProps) {
  const gate = useLiveGate()
  const run = useSyncExternalStore(subscribeShared, sharedNow, () => null)
  const zap = zapStateFromV1(state)
  if (gate === 'outside' || gate === 'not-live' || !zap) return v1
  if (gate === 'reading') return null
  const funding = inputsFromV1(zap, reviewPlan(state, rawBalances(balances)))
  const book = tokenBook(4663, zap.pool ? [...zap.pool.tokens] : [])
  // A short wallet asks no quote: said where the review's notes stand.
  const view: RunView =
    funding.kind === 'short' ? { ...IDLE, stage: 'failed', error: { copy: shortCopy(funding, book), code: 'wallet_short', recovery: 'none' } } : (run?.view ?? IDLE)
  return (
    <ReviewStage
      state={zap}
      gate={gate}
      view={view}
      price={journeyPrice(zap, now)}
      confirmed={false}
      onConfirmed={() => undefined}
      onRejected={() => run?.forgetUnsettled()}
      onNewPool={() => undefined}
      onPoolRace={() => undefined}
    />
  )
}
