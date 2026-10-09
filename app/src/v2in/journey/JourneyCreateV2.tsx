import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { CreatedNext } from '../../components/create/CreatedNext'
import type { PairBalancesState } from '../../components/create/usePairBalances'
import { heldRaw, rawBalances } from '../../components/create/valuation'
import { Button } from '../../components/ui'
import { openWalletDialog } from '../../finance/signedOut'
import { crosschainSessionAccess } from '../../finance/v2/http'
import { CREATE } from '../../lib/create/copy'
import { publishCreated, publishFlowMade } from '../../lib/create/createProgress'
import type { JourneyState as V1JourneyState } from '../../lib/create/journey'
import type { PayFacts } from '../../lib/create/poolPrices'
import { reviewPlan } from '../../lib/create/reviewPlan'
import { useWalletIdentity } from '../../lib/walletIdentity'
import { v2Chain } from '../../v2/chains'
import { s2Gate, type V2Gate } from '../../v2/gate'
import type { Address, V2ChainId } from '../../v2/types'
import { v2PageProbe } from '../transports'
import { useJourneyNetwork } from './context'
import { JOURNEY } from './copy'
import { balancesUnread, inputsFromV1, requestFromV1, zapStateFromV1 } from './model/fromV1'
import { journeyPrice } from './model/state'
import { FinalControl, ReviewStage } from './ReviewStage'
import { testPlannerOn } from './source'
import { useJourneyRun, type RunView } from './run'
import { labelOf, tokenBook } from './tokens'

/**
 * The owner's New position on Domino V2 (2026-10-05: "my screens, with everything connected"): today's journey
 * (components/create/Journey.tsx) keeps every screen he built; its last step, Review and Create position, runs on the new
 * contracts once Robinhood Chain's S1 gate is `live`. The plan from position-plan-v1 for what his journey chose
 * (./model/fromV1.ts), the review of it and the wallet's steps through the closed money client, exactly as the zap path
 * runs them (./run.ts, ./ReviewStage.tsx). Wherever that gate is not live, creation stays disabled. The static selected
 * amounts may still be shown by the older presentation component, but no retired setup control is mounted.
 *
 * Two lazily mounted parts, as Journey.tsx draws its step: the footer (the default export) owns the run, as today's
 * footer owns Create position; Review's body (ReviewV2) draws the same run's review, through the small store below.
 *
 * Changed on purpose 2026-10-05 (the owner: New position on Base and Arbitrum One, through his screens): a pool of another
 * network (read through the wallet, ./otherChains.ts) goes by that network's S1 gate, its plan and its contracts, and is
 * never handed back to today's control (Domino V1 is Robinhood Chain's): where that gate is not live, Create position
 * stays disabled and says so. Once made, such a position is shown by the zap path's own created view (its receipt and
 * its link on its network), not today's, whose lists are Robinhood Chain's.
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

/** The network of the pool chosen: its currencies' (Robinhood Chain until one is chosen). */
const chainOf = (state: Pick<V1JourneyState, 'pool'>): V2ChainId => (state.pool?.currencies[0].chainId ?? 4663) as V2ChainId

/** The live S1 gate of `chainId` this page's wrapper read, or why there is none: outside the wrapper, still reading, or not live. */
function useLiveGate(chainId: V2ChainId): Gate | 'outside' | 'reading' | 'not-live' {
  const network = useJourneyNetwork()
  if (network === null) return 'outside'
  const gate = chainId === 4663 ? network.s1 : network.gates?.[chainId]
  if (gate === undefined) return 'reading'
  return gate.mode === 'live' ? gate : 'not-live'
}

type CreateProps = {
  state: V1JourneyState
  balances: PairBalancesState
  pay?: PayFacts | null
  onBusy?: (busy: boolean) => void
  /** Added 2026-10-06 (the final check's F5): reads the wallet's balances of the pool's two tokens again. */
  onReadAgain?: () => void
  v1: ReactElement
}

/** Review's footer: Create position on V2 once the gate is live, otherwise disabled. */
export default function JourneyCreateV2({ state, balances, pay, onBusy, onReadAgain }: CreateProps) {
  const chainId = chainOf(state)
  const gate = useLiveGate(chainId)
  // V2 is the only creation path on every network. An unavailable gate never mounts the retired setup control.
  if (gate === 'outside' || gate === 'not-live') {
    return (
      <>
        <Button type="button" variant="primary" size="xl" className="w-full" disabled data-create-position="closed" aria-describedby="create-reason">
          {JOURNEY.final.create}
        </Button>
        <p id="create-reason" className="dm-flow-reason" data-align="start" data-zap-reason="network-closed">
          {JOURNEY.pool.networkClosed(v2Chain(chainId).name)}
        </p>
      </>
    )
  }
  // Never today's Create position while the gate is still read: it could leave a Domino V1 deposit held.
  if (gate === 'reading') {
    return (
      <Button type="button" variant="primary" size="xl" className="w-full" disabled data-create-position="reading">
        {JOURNEY.final.create}
      </Button>
    )
  }
  return <LiveCreate state={state} balances={balances} pay={pay} onBusy={onBusy} onReadAgain={onReadAgain} gate={gate} chainId={chainId} />
}

function LiveCreate({ state, balances, pay, onBusy, onReadAgain, gate, chainId }: Omit<CreateProps, 'v1'> & { gate: Gate; chainId: V2ChainId }) {
  const identity = useWalletIdentity()
  const connected = identity.kind === 'connected'
  const owner = identity.kind === 'connected' ? identity.address : null
  const access = useSyncExternalStore(crosschainSessionAccess.subscribe, crosschainSessionAccess.getSnapshot, () => 'pending')
  // The plan is asked for the signed-in wallet only (position-plan-v1); a test build's planner needs no session.
  const signedIn = access.startsWith('ready:') || testPlannerOn()
  const zap = zapStateFromV1(state)
  const funding = inputsFromV1(zap, reviewPlan(state, rawBalances(balances)), state.payWith, pay)
  const book = tokenBook(chainId, zap?.pool ? [...zap.pool.tokens] : [])
  const run = useJourneyRun({
    chainId,
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
    if (ask === null) return
    const refresh = () => {
      const current = latest.current
      const reviewed = current.view.reviewed
      if (!document.hidden && reviewed && reviewed.review.quoteExpiresAt - Date.now() / 1000 <= 30) current.refresh()
    }
    const timer = setInterval(refresh, 10_000)
    window.addEventListener('focus', refresh)
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh) }
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
  // Changed on purpose 2026-10-06 (the final check's F1/F6): the position exists once the run has its receipt, on every
  // network (Base and Arbitrum One too, and a receipt that could not be read exactly): Journey rests Back on it, as it does
  // on Robinhood Chain, so the success (the receipt, View position, Auto-exit's offer) is never dropped by Back; and nothing
  // drawn before a quote (Connect wallet, Sign in, a short wallet, unread balances) ever takes its place. Marked for the
  // flow (lib/create/createProgress.ts publishFlowMade), never for the lists: New position's own link then starts a fresh
  // flow, as on Robinhood Chain (screens/NewPosition.tsx). Taken back when this control goes (Review left, a new flow).
  const made = view.receipt !== null
  useEffect(() => {
    if (!made) return
    publishFlowMade(true)
    return () => publishFlowMade(false)
  }, [made])
  const tokenId = view.receipt?.read?.summary.tokenId ?? null
  // Today's created view and its lists are Robinhood Chain's: another network's position is shown by FinalControl's own.
  const home = chainId === 4663
  useEffect(() => {
    if (!home || tokenId === null) return
    publishCreated(tokenId.toString(), owner)
    // Changed on purpose 2026-10-06 (the final check's F1/F6): taken back when this control goes (Review left, or a new
    // flow), as today's Create position does (components/create/CreatePosition.tsx): Back then shows again on the step
    // reopened and in the next flow, where it stayed hidden. The lists keep the position (publishCreated never forgets it).
    return () => publishCreated(null)
  }, [home, tokenId, owner])

  if (home && tokenId !== null) return <CreatedNext tokenId={tokenId.toString()} state={state} />
  if (!made && !connected) {
    // Changed on purpose 2026-10-06 (the final check's F4): with no wallet, Create position's place asks for one, as today's
    // control does: the header's wallet dialog, as Sign in below opens it.
    return (
      <>
        <Button type="button" variant="primary" size="xl" className="w-full" onClick={openWalletDialog} data-create-position="connect" aria-describedby="create-reason">
          {JOURNEY.final.connect}
        </Button>
        <p id="create-reason" className="dm-flow-reason" data-align="start" data-zap-reason="no-wallet">
          {JOURNEY.final.reasonNoWallet}
        </p>
      </>
    )
  }
  if (!made && connected && !signedIn) {
    // Changed on purpose 2026-10-06 (the final check's F4): in Create position's place, full width as Connect wallet above
    // (styles/flow.css places the footer's [data-create-position]); without it the grid drew Sign in as a small button.
    return (
      <>
        <Button type="button" variant="primary" size="xl" className="w-full" onClick={openWalletDialog} data-create-position="signin" data-create-signin="" aria-describedby="create-reason">
          {JOURNEY.review.signIn}
        </Button>
        <p id="create-reason" className="dm-flow-reason" data-align="start" data-zap-reason="signed-out">
          {JOURNEY.review.signInForQuote}
        </p>
      </>
    )
  }
  if (!made && funding.kind === 'short') {
    // Changed on purpose 2026-10-06 (the review of the owner's point 4): what the wallet has and needs is said once, in
    // Review's view (ReviewV2 below); this line only says why Create position waits.
    return (
      <>
        <Button type="button" variant="primary" size="xl" className="w-full" disabled data-create-position="short" aria-describedby="create-reason">
          {JOURNEY.final.create}
        </Button>
        <p id="create-reason" className="dm-flow-reason" data-align="start" data-zap-reason="short">
          {JOURNEY.final.reasonShort}
        </p>
      </>
    )
  }
  if (!made && (funding.kind === 'unread' || (funding.kind === 'wait' && !state.payWith && balancesUnread(balances)))) {
    // Changed on purpose 2026-10-06 (the final check's F5): the read of the pair's balances finished with nothing usable, and
    // nothing asks it again by itself, so no quote could ever come. Said in one line, with the way on: read them again
    // (Journey's balance revision, as funds arriving from another network do).
    return (
      <>
        <Button type="button" variant="primary" size="xl" className="w-full" disabled data-create-position="unread" aria-describedby="create-reason">
          {JOURNEY.final.create}
        </Button>
        <p id="create-reason" className="dm-flow-reason" data-align="start" data-zap-reason="unread">
          {JOURNEY.final.reasonUnread}
        </p>
        {onReadAgain && (
          <Button type="button" variant="outline" size="md" className="w-full col-span-full" onClick={onReadAgain} data-create-read-again="">
            {JOURNEY.final.readAgain}
          </Button>
        )}
      </>
    )
  }
  // Changed on purpose 2026-10-06 (the final check's F5): nothing to quote yet says why, never "Your wallet will ask you to
  // confirm each step." under a disabled button: the balances still being read, else a choice Review cannot plan.
  const waiting = funding.kind === 'gas' ? 'Add ETH for the network fee to continue.' : funding.kind !== 'wait' ? null : state.payWith || balances.status !== 'ready' ? CREATE.amount.pairReading : CREATE.review.notReady
  // Changed on purpose 2026-10-06 (the final check's F5, a second look): a quote that failed before any review is asked
  // again from Review itself (FinalControl's Review again), for these same choices: nothing else asks it again (a wallet
  // switched to the pool's network by hand changes none of them), so only Back then Continue did.
  return (
    <FinalControl
      gate={gate}
      view={!made && funding.kind !== 'inputs' && !view.busy ? IDLE : view}
      blockedForPrice={false}
      connected={connected}
      onRun={run.run}
      onCancelSignature={run.cancelSignature}
      onKeepSignature={run.keepSignature}
      onRejected={run.forgetUnsettled}
      onQuote={ask !== null ? run.start : undefined}
      waiting={waiting}
    />
  )
}

type ReviewProps = { state: V1JourneyState; now: number; balances: PairBalancesState; pay?: PayFacts | null; v1: ReactElement }

/**
 * Whether a deposit from another network can bring `token` to `chainId` now (Added 2026-10-06, the review of point 4: the
 * short wallet's sentence offers it only then): Amount's offer is open there (S2 `live`, the crosschain route's own word,
 * as ../funds/useS2Gate.ts asks it) and the token is one a deposit delivers (the chain's stable, ETH or WETH: its charge
 * currencies, ../funds/model.ts deliverableTokens). False until known, and for any other token.
 */
function useBringable(chainId: V2ChainId, token: Address | null): boolean {
  const [live, setLive] = useState<V2ChainId | null>(null)
  const asked = token !== null
  useEffect(() => {
    // Kept by the chain it is for: an answer for another chain never stands for this one.
    if (asked) void s2Gate(chainId, v2PageProbe).then((gate) => gate.mode === 'live' && setLive(chainId), () => undefined)
  }, [chainId, asked])
  return live === chainId && v2Chain(chainId).chargeCurrencies.some((currency) => currency.address.toLowerCase() === token?.toLowerCase())
}

/** Review's body: the plan's review once the gate is live, else today's own Review (`v1`). */
export function ReviewV2({ state, now, balances, pay, v1 }: ReviewProps) {
  const chainId = chainOf(state)
  const gate = useLiveGate(chainId)
  const run = useSyncExternalStore(subscribeShared, sharedNow, () => null)
  const zap = zapStateFromV1(state)
  // Paid with one other token (2026-10-06): no pool-token amounts before the plan's own; the review says what it swaps.
  const planned = zap && !state.payWith ? reviewPlan(state, rawBalances(balances)) : null
  const funding = inputsFromV1(zap, planned, state.payWith, pay)
  const bring = useBringable(chainId, funding.kind === 'short' ? funding.token : null)
  if (gate === 'outside' || gate === 'not-live' || !zap) return v1
  if (gate === 'reading') return null
  // A short wallet asks no quote, and an earlier review is not for these amounts: nothing of it is drawn. Changed on
  // purpose 2026-10-06 (the review of the owner's point 4: one sentence, in view): the review shows what the position
  // needs and says once, in its body, what the wallet has and the ways on, as today's Review does; Create position's
  // line only says why it waits.
  const short = funding.kind === 'short' && planned ? { amounts: planned.need, token: funding.token, have: funding.have, need: funding.need, bring } : null
  const view: RunView = funding.kind !== 'inputs' ? IDLE : (run?.view ?? IDLE)
  // Changed on purpose 2026-10-06 (the final check's F4): what the position holds as typed, for the headline whenever no
  // quote has figures and none is under way: no wallet, a wallet not signed in, balances not read, a quote that failed. A
  // lone dash only when it cannot be worked out. Changed on purpose 2026-10-06 (the final check's F4, a second look): the
  // amounts his amount step's row writes (components/create/valuation.ts heldRaw): reviewPlan's need, or, when the wallet
  // funds the deposit from one token, the amounts after its swap; the need then said about twice the position.
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
      short={short}
      estimate={planned ? heldRaw(planned) : null}
    />
  )
}
