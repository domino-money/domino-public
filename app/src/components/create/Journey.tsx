import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { CREATE } from '../../lib/create/copy'
import {
  back,
  canContinue,
  canOpen,
  candidatesFromPool,
  effectiveAmounts,
  goTo,
  initialState,
  linkedDepositToken,
  next,
  poolHolds,
  preselectFrom,
  USDG,
  priceOf,
  stageIndex,
  takesOnly,
  validateRange,
  verificationToken,
  withFreshPool,
  withOtherAmount,
  withPayWith,
  withPool,
  withRange,
  withSlippage,
  withToken,
  withTypedAmount,
  type Check,
  type JourneyState,
  type Preselect,
  type Stage,
  type TickRange,
  validateBudget,
} from '../../lib/create/journey'
import { useOtherChains } from '../../lib/create/otherChains'
import { ELYSIUM_LIVE, fundsBroughtTo } from '../../lib/elysiumIdentity'
import { nativeWords } from '../../lib/nativeWords'
import { payFunding } from '../../lib/create/payFunding'
import type { PayFacts } from '../../lib/create/poolPrices'
import { lacksOne, reviewPlan } from '../../lib/create/reviewPlan'
import { forgetCreatePools } from '../../lib/create/poolsAhead'
import { featuredStore, useFeatured } from '../../lib/read/featuredSource'
import { appPaint } from '../../lib/read/appPaint'
import { paintedPool } from '../../lib/read/publicOverview'
import { verifyCandidate } from '../../lib/read/screens/catalogueSession'
import { failureText } from '../../lib/read/screens/copy'
import { DYNAMIC_FEE_PIPS } from '../../lib/read/screens/fee'
import { NATIVE_CURRENCY, addressKey, type AddressKey } from '../../lib/read/screens/identity'
import { poolWarning } from '../../lib/read/screens/lookalike'
import { optionUsableForDomino, type PoolOption } from '../../lib/read/screens/poolsList'
import { useReadSource } from '../../lib/read/screens/readContext'
import { usePairBalances, type PairBalancesState } from './usePairBalances'
import { useCreated, useFlowMade } from '../../lib/create/createProgress'
import { mergeCandidates, type TokenCandidate } from '../../lib/read/screens/tokens'
import { useNow } from '../../lib/read/useNow'
import { recovering } from '../../lib/staleRelease'
import { deferred } from '../Deferred'
import { Button, PageHeader, PageShell } from '../ui'
import { StageAmount, StageRange } from './StageAmount'
import { CreateUnavailable, FinalControl, StageReview, preloadCreateControl } from './StageReview'
import { StageToken, type PreselectStatus } from './StageToken'
import { AmountSummary, PoolSummary, RangeSummary, StepList, VISUAL_STEPS, type StepView, type VisualStep } from './StepList'
import { PositionPreview } from './PositionPreview'
import { useFirstLoad, useReviewColumns } from './reviewColumns'
import { useLivePoolPrice, usePayFacts, usePricedPool } from './usePricedPool'
import { heldAmounts, rawBalances, underMinimum, usdAt } from './valuation'
import { fundingContext, type FundingContinuation } from '../../lib/create/fundingContext'
import { useWalletIdentity } from '../../lib/walletIdentity'
import { currentRoute } from '../../lib/route'

/** The outcomes only the verification read, or the featured list before it, can produce. */
type Verified = Extract<PreselectStatus, { kind: 'verified' | 'not_found' | 'unsupported' | 'failed' | 'withdrawn' }>

/**
 * Changed on purpose (data) 2026-10-02 (Domino V2 integration, the journey; the owner, night: no network choice, the pool
 * step stays exactly today's): in a build that carries V2 (`__DOMINO_V2__`; production and development too since
 * 2026-10-04, the owner: the site runs on Domino V2; false only in the test builds without V2, where this folds away),
 * "Create a new pool (advanced)" at the foot of the pool step (src/v2in/journey/PoolAdvanced.tsx),
 * drawn only inside the integrated journey's wrapper. Opened lazily, named once; one that cannot load draws nothing
 * (lib/staleRelease.ts recovering).
 */
const V2PoolAdvanced = __DOMINO_V2__ ? lazy(recovering(() => import('../../v2in/journey/PoolAdvanced'), () => ({ default: () => null }))) : null

/**
 * Changed on purpose 2026-10-05 (the owner: his screens, with Domino V2 connected behind them): in a build that carries
 * V2, Review's body and its Create position come from src/v2in/journey/JourneyCreateV2.tsx, which draws the plan and runs
 * the new contracts once the selected network's S1 gate is live. A closed gate or failed V2 module disables creation;
 * the retired setup contract remains available only to builds without V2. Asked once a pool is chosen.
 */
type V2ReviewProps = { state: JourneyState; now: number; balances: PairBalancesState; pay?: PayFacts | null; v1: ReactElement }
type V2CreateProps = {
  state: JourneyState
  balances: PairBalancesState
  pay?: PayFacts | null
  onBusy?: (busy: boolean) => void
  onReadAgain?: () => void
  /** QA round 2, N18: the chosen pool at the price and tick a signed-in quote read it at, once per choice (withFreshPool). */
  onFreshPool?: (pool: PoolOption) => void
  v1: ReactElement
}
const V2Review = __DOMINO_V2__ ? deferred<V2ReviewProps>(recovering(() => import('../../v2in/journey/JourneyCreateV2').then((module) => ({ default: module.ReviewV2 })), () => ({ default: ({ v1 }: V2ReviewProps) => v1 }))) : null
const V2Create = __DOMINO_V2__ ? deferred<V2CreateProps>(recovering(() => import('../../v2in/journey/JourneyCreateV2').then((module) => ({ default: module.default })), () => ({ default: () => <CreateUnavailable note={CREATE.review.loadFailed} /> }))) : null

/**
 * The first wait before a failed verification of the linked pool is asked again on its own, and the longest wait.
 * Changed on purpose 2026-10-30 (QA round 2, N42): asked again for as long as the page is open and visible, the wait
 * doubling up to a minute, instead of three times and then never (the step stayed without its pool for good).
 */
const VERIFY_WAIT_MS = 4000
const VERIFY_WAIT_MAX_MS = 60_000

/**
 * Added 2026-10-30 (launch capacity, item 9a): how often Amount's reads are asked again in the background while the page
 * is visible, and how old the last read must be before the page opened again asks them. A timer may fire a little early.
 */
const REFRESH_MS = 60_000
const TIMER_SLACK_MS = 1_000
/**
 * Added 2026-10-30 (launch capacity 9a, its review): while Continue waits on a read that answered without the figure it
 * needs (the balances, or the token chosen to pay with), the reads are asked again sooner: 15 s after the last, then 30 s,
 * then every minute; and on focus or a tab shown once the last is 10 s old. A page that has its figures keeps the minute.
 */
const RETRY_MS = [15_000, 30_000, 60_000] as const
const RETURN_RETRY_MS = 10_000

/** Which half of the machine's `amount` stage is open: the range first, then the budget. */
type AmountPart = 'range' | 'amount'

/** The visual step a machine state stands for. `balance` is never rested on: Amount continues through it. */
function visualOf(state: JourneyState, part: AmountPart): VisualStep {
  switch (state.stage) {
    case 'token':
    case 'pool':
      return 'pool'
    case 'amount':
      return part
    case 'balance':
      return 'amount'
    case 'review':
      return 'review'
    default:
      return state.stage satisfies never
  }
}

/** The machine stage a visual step opens at. */
const STAGE_OF: Record<VisualStep, Stage> = { pool: 'token', range: 'amount', amount: 'amount', review: 'review' }

/**
 * Added 2026-10-30 (QA round 2, Q17): each step is an entry of the browser's history on the same URL (its state only,
 * never the hash, so nothing routes or remounts), so the browser's Back and Forward walk the steps with the choices
 * kept. `dmIndex` counts the flow's entries from its first. Changed on purpose 2026-10-30 (QA round 2 review): `dmFlow`
 * names the flow that wrote the entry, new each time a flow starts (the page opened again on the same link, or another
 * link followed), so the entries an earlier flow left behind are told apart: Back passes all of them in one press,
 * instead of resting on each with nothing changing on screen.
 */
type StepMark = { dmFlow: string | null; dmStep: VisualStep; dmIndex: number }
const markOf = (value: unknown): StepMark | null => {
  if (!value || typeof value !== 'object') return null
  const mark = value as { dmFlow?: unknown; dmStep?: unknown; dmIndex?: unknown }
  if (typeof mark.dmStep !== 'string' || !(VISUAL_STEPS as readonly string[]).includes(mark.dmStep)) return null
  if (typeof mark.dmIndex !== 'number' || !Number.isInteger(mark.dmIndex) || mark.dmIndex < 0) return null
  return { dmFlow: typeof mark.dmFlow === 'string' ? mark.dmFlow : null, dmStep: mark.dmStep as VisualStep, dmIndex: mark.dmIndex }
}
/** Where the flow stands in the browser's history: its name, its entry, the step of each of its entries, and so on. */
type Trail = {
  flow: string | null
  at: number
  hash: string | null
  popped: VisualStep | null
  steps: (VisualStep | undefined)[]
}
let flowCount = 0
const newFlowName = () => `${Date.now().toString(36)}.${(flowCount += 1)}`

/**
 * The inputs a step was last shown with. A step that has been reached stays
 * mounted, folded, while those inputs hold, so going back finds its list and
 * its wallet balance where they were instead of reading them again. When the
 * inputs change the folded step is dropped, and its read with it: nothing is
 * read for a step the person has not returned to.
 */
const keyOf = (step: VisualStep, state: JourneyState): string => (step === 'range' || step === 'amount' ? (state.pool?.key ?? '') : 'static')

const fail = (reason: string): Check => ({ ok: false, reason })

/**
 * New position: four steps in one card over the state machine in
 * lib/create/journey.ts, which decides what each step may do. Every read goes
 * through the shared read source; each step runs at most one at a time and
 * cancels it when the selection changes or the step is dropped. Nothing here
 * signs, approves, deposits or swaps before Create position is pressed. Nothing
 * here asks about automation: that is applied from Automate, to a position
 * that exists.
 */
export function Journey({
  poolId,
  linkToken = null,
  initialToken = null,
  initialPool = null,
}: {
  poolId: string
  linkToken?: string | null
  initialToken?: TokenCandidate | null
  /**
   * Added 2026-10-30 (QA round 2, N5): the pool another network's link proposes with its token
   * (#/new/network/<chain>/<token>/<pool>), handed by the journey's wrapper. Untrusted: that network's pool list chooses
   * it once, only when its own read lists exactly that pool, never over a choice already made (StagePool.tsx).
   */
  initialPool?: string | null
}) {
  const source = useReadSource()
  const now = useNow(false).wall
  const [state, setState] = useState<JourneyState>(() => initialToken ? withToken(initialState(), initialToken) : initialState())
  // Added 2026-10-31 (QA round 2 follow-ups, free-amounts): the state every plan reads. With both amounts the person's own
  // (`own`), its amount is the side that limits the position (lib/create/journey.ts effectiveAmounts), so Review, the
  // preview, the funds offer and Create position receive one amount and the other worked out from it, as always. Step 1,
  // Range and every transition keep the state as typed.
  const amounts = useMemo(() => effectiveAmounts(state), [state])
  const walletIdentity = useWalletIdentity()
  const [fundingFlowKey] = useState(() => __DOMINO_V2__ ? crypto.randomUUID() : '')
  const walletKey = walletIdentity.kind === 'connected' ? `${walletIdentity.connectorName}|${walletIdentity.address.toLowerCase()}` : ''
  const fundingKey = __DOMINO_V2__ ? fundingContext(amounts, walletKey, fundingFlowKey) : ''
  const fundingKeyRef = useRef(fundingKey)
  useEffect(() => { fundingKeyRef.current = fundingKey }, [fundingKey])
  const [funding, setFunding] = useState<{ key: string; value: FundingContinuation } | null>(null)
  const fundingEpoch = useRef(0)
  const [fundingAdvance, setFundingAdvance] = useState<{ key: string; epoch: number; phase: 'checking' | 'ready' } | null>(null)
  const fundingBusy = useRef(false)
  const receiveFunding = useCallback((key: string, value: FundingContinuation) => {
    if (key !== fundingKeyRef.current) return
    setFunding((previous) => previous?.key === key && previous.value === value ? previous : { key, value })
  }, [])
  const [part, setPart] = useState<AmountPart>('range')
  // Create position is asking the wallet: Back waits, so leaving Review cannot drop the flow mid-way.
  const [creating, setCreating] = useState(false)
  // Once the position exists, Review offers what comes next in its footer (CreatedNext.tsx) and Back rests. A done step
  // still reopens (review of 2026-09-24): that leaves Review, which ends the offer, so a second position can be made from
  // the same choices; New position's own link starts a fresh flow (screens/NewPosition.tsx).
  const created = useCreated() !== null
  // Changed on purpose 2026-10-06 (the final check's F1/F6): Domino V2's Create position says when its position exists, on
  // every network (lib/create/createProgress.ts publishFlowMade, from src/v2in/journey/JourneyCreateV2.tsx), and Back
  // rests under that success too: on Base and Arbitrum One, whose positions are never published above (its lists are
  // Robinhood Chain's), Back threw away the receipt, View position and Auto-exit's offer. New position's own link reads
  // the same marker (screens/NewPosition.tsx).
  const createdV2 = useFlowMade()
  // Whether the budget half of the amount stage has been reached on this visit.
  const [amountReached, setAmountReached] = useState(false)
  const [candidates, setCandidates] = useState<TokenCandidate[]>([])
  const [kept, setKept] = useState<Partial<Record<VisualStep, string>>>({ pool: 'static' })
  // What the verification read of the linked pool came to, for the link and the attempt it was about.
  const [verified, setVerified] = useState<{ poolId: string; attempt: number; outcome: Verified } | null>(null)
  // Each attempt is one more read of the same id: asked again on its own after a failure that asking again could fix.
  const [attempt, setAttempt] = useState(0)
  // The state and Create position's run as they are now, for reads that answer later (the link's verification).
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state })
  const creatingRef = useRef(false)
  useEffect(() => { creatingRef.current = creating }, [creating])
  // Once the position exists, the link's verification changes nothing more (QA round 2 review, N42).
  const doneRef = useRef(false)
  useEffect(() => { doneRef.current = created || createdV2 })
  // QA round 2 review (N42): a token or a pool picked by hand in step 1 ends what the link decides. A later answer of its
  // verification then only refreshes that same pool's read, and it is not asked again. Each link starts without it.
  const [steered, setSteered] = useState(false)
  const steeredRef = useRef(false)
  useEffect(() => { steeredRef.current = steered }, [steered])
  const steer = () => {
    steeredRef.current = true
    setSteered(true)
  }
  // A pool row pointed at or focused in step 1 while nothing is chosen: the preview beside the steps shows it.
  const [preview, setPreview] = useState<PoolOption | null>(null)
  // QA round 2, Q18: a Custom price typed or refused in either field holds Continue, with the field's own reason.
  const [rangeBlock, setRangeBlock] = useState<{ lower?: string | null; upper?: string | null }>({})
  const onRangeBlock = useCallback((which: 'lower' | 'upper', reason: string | null) => {
    setRangeBlock((was) => ((was[which] ?? null) === reason ? was : { ...was, [which]: reason }))
  }, [])
  // Another link's pool starts its own count (QA round 2, N42): a count spent on one link never holds back the next.
  // Added 2026-10-30 (QA round 2, N53): and a New position link to another pool, followed while this flow is open (the
  // page stays mounted from one link to the next), starts the flow again at step 1, as arriving by that link does; its
  // pool is chosen once verified. The same pool's link keeps the flow, and nothing restarts while the wallet is asked.
  // Done as the render's own adjustment, so no step of the old flow is drawn, or written to history, under the new link.
  const [attemptFor, setAttemptFor] = useState(poolId)
  if (attemptFor !== poolId) {
    setAttemptFor(poolId)
    setAttempt(0)
    setSteered(false)
    const link = preselectFrom(poolId)
    if (link.ok && !creating && state.pool !== null && state.pool.key !== link.key) {
      setFundingAdvance(null)
      setPreview(null)
      setRangeBlock({})
      setAmountReached(false)
      setKept({ pool: 'static' })
      setPart('range')
      setState(initialState())
    }
  }
  const running = useRef<AbortController | null>(null)
  // The list on screen (lib/read/featuredSource.ts): a linked pool it names is found by its entry.
  const featured = useFeatured()
  // QA round 2, N19: the list's pools step 1 offers under the search, once the list has settled (never the stand-in).
  const topPools = featured.settled ? featured.entries : []
  // Named as Home and Markets name the same list (lib/read/featuredList.ts featuredTitle): Top pools for the server's.
  const topServer = featured.source === 'server'
  // Added 2026-10-05 (the owner: New position across the three networks Domino V2 serves): Base and Arbitrum One beside
  // Robinhood Chain, handed in by the journey's wrapper in a build that carries V2 (lib/create/otherChains.ts); null
  // everywhere else, where every step is exactly today's.
  const others = useOtherChains()

  // Leaving the flow cancels its link verification, and its pools reads still out, and forgets the lists it kept.
  useEffect(
    () => () => {
      running.current?.abort()
      forgetCreatePools()
    },
    [],
  )

  // The pool id in the link, verified against the chain exactly as the
  // explorer verifies a featured pool: one pools read for that id, cancelled
  // if the source or the link changes first. State changes only when the
  // read answers; what to show meanwhile is derived below.
  useEffect(() => {
    const listed = featuredStore()
    const link = preselectFrom(poolId)
    if (!source || !link.ok) return
    running.current?.abort()
    const controller = new AbortController()
    running.current = controller
    // A pool of the lists is verified against the token its entry names; any other against the token its link names
    // (the pool page's own, #/new/<id>/<token>), else USDG. Fixed 2026-09-27 (round 6): a pool page's link carried no
    // token, so an unlisted pool without USDG was never verified and New position opened on an empty search.
    const tokenFor = (linked: Extract<Preselect, { ok: true }>): AddressKey =>
      !linked.catalogue && linkToken ? addressKey(linkToken) : verificationToken(linked)
    // Changed on purpose 2026-09-28 (speed wave, study item 31): the verification is asked at once, against the token
    // the list on screen names now (the one read before, or the embedded one), beside the featured list's first answer
    // instead of after it. That answer still decides: the read is used only when the list, once in, names the same
    // token and has not withdrawn the pool; otherwise it is cancelled, and the pool is verified or refused as before.
    const early = new AbortController()
    const follow = () => early.abort()
    controller.signal.addEventListener('abort', follow, { once: true })
    const guess = preselectFrom(poolId, listed.getSnapshot().entries)
    const guessed = guess.ok ? tokenFor(guess) : null
    const ahead = guessed ? verifyCandidate(source, guessed, null, link.key, { signal: early.signal }) : null
    // The featured list first (its first answer is the page's one read of it, at most 1.5 s): a pool it withdrew by a
    // safety rule is refused from a link, never verified or preselected (featured pools v1 §11.5). The list as it is
    // now, once that first answer is in: a later refresh may have withdrawn the pool since (fixed 2026-09-26 after review).
    void listed.ensure().then(async () => {
      const list = listed.getSnapshot()
      const linked = preselectFrom(poolId, list.entries)
      const against = linked.ok ? tokenFor(linked) : null
      const kept = ahead !== null && linked.ok && against === guessed && !list.withdrawn.has(linked.key) ? ahead : null
      if (!kept) early.abort()
      if (controller.signal.aborted || !linked.ok || !against) return
      if (list.withdrawn.has(linked.key)) {
        setVerified({ poolId, attempt, outcome: { kind: 'withdrawn' } })
        return
      }
      // The pool arrives chosen, with the token the link was verified against as the one an amount starts in, so step 1
      // is exactly what choosing this pool from the search leaves (round 6, 2026-09-27: one flow, whichever way in).
      // A verification read again after a failure never replaces another pool, or a token, the person chose in the
      // meantime. The same pool read again (the copy chosen meanwhile, or a link to the pool already chosen) only takes the
      // fresher read, exactly as a background price read does (withFreshPool): the token, the amount and the range stay as
      // they are (QA round 2, N42, and its review). Nothing changes while Create position is asking the wallet, or once
      // the position exists.
      const choose = (option: PoolOption) => {
        const at = Date.now()
        const start = linkedDepositToken(option, poolHolds(option, USDG) ? USDG : against)
        setState((was) => {
          if (creatingRef.current || doneRef.current) return was
          if (was.pool?.key === option.key) return withFreshPool(was, option)
          if (was.pool || steeredRef.current) return was
          const held = was.token !== null && poolHolds(option, was.token.key)
          return withPool(held || !start ? was : withToken(was, start), option, at)
        })
        setCandidates((was) => mergeCandidates(was, candidatesFromPool(option)))
      }
      const result = await (kept ?? verifyCandidate(source, against, null, linked.key, { signal: controller.signal }))
      if (controller.signal.aborted) return
      if (result.failure) {
        if (result.failure.state === 'aborted') return
        const line = failureText(result.failure, 'pools')
        setVerified({ poolId, attempt, outcome: { kind: 'failed', line } })
        // Added 2026-10-30 (QA round 2, N42): a read that asking again may fix leaves no dead end. The pool page and Markets
        // paint from this browser's copy of the last stored overview (lib/read/marketsPaint.ts, block-verified, our own
        // read, no request made here); a pool it names with this token, under the same rules as a verified one, is chosen
        // from it meanwhile, and the verification keeps being asked quietly. Review plans from its own reads before
        // anything is signed. Only while the person has chosen nothing in step 1 themselves.
        const blank = !stateRef.current.pool && !stateRef.current.token && !steeredRef.current && !doneRef.current
        const painted = line.retry && blank ? paintedPool(appPaint, linked.key, against) : null
        if (painted && optionUsableForDomino(painted.option) && !poolWarning(painted.option.currencies)) choose(painted.option)
        return
      }
      const option = result.option
      if (!option) {
        setVerified({ poolId, attempt, outcome: { kind: 'not_found' } })
        return
      }
      // Domino opens positions only in pools with no hooks and a fixed fee, and step 1 never lists
      // another: a link to one preselects nothing, and says why only in the step's live region and data.
      if (!optionUsableForDomino(option)) {
        setVerified({ poolId, attempt, outcome: { kind: 'unsupported', reason: option.hooks === NATIVE_CURRENCY && option.feePips === DYNAMIC_FEE_PIPS ? 'dynamic' : 'hooks' } })
        return
      }
      // A pool with a token that passes for one of the site's main tokens, or a misleading name, is refused from a link
      // as a withdrawn one is (audit I1, 2026-10-01): never preselected. Display only: nothing of the money path changes.
      if (poolWarning(option.currencies)) {
        setVerified({ poolId, attempt, outcome: { kind: 'withdrawn' } })
        return
      }
      choose(option)
      setVerified({ poolId, attempt, outcome: { kind: 'verified', block: option.block } })
    })
    return () => controller.abort()
  }, [source, poolId, linkToken, attempt])

  // No Retry on this page: a verification that failed in a way asking again could fix (a busy or unreachable
  // read service) is read again by itself, at doubling intervals up to a minute, for as long as the page is open,
  // and only while it is visible (QA round 2, N42). It stops once another pool is chosen, once the person picks a
  // token or a pool by hand, and once the position exists (its review). Any other outcome stays as it is, with its
  // reason on the step's data attributes.
  const linkPool = preselectFrom(poolId)
  const otherChosen = state.pool !== null && linkPool.ok && state.pool.key !== linkPool.key
  const linkLeft = otherChosen || steered || created || createdV2
  useEffect(() => {
    if (!verified || verified.poolId !== poolId || verified.attempt !== attempt || linkLeft) return
    const outcome = verified.outcome
    if (outcome.kind !== 'failed' || !outcome.line.retry) return
    let cancelled = false
    const again = () => {
      if (!cancelled) setAttempt((count) => count + 1)
    }
    const whenVisible = () => {
      if (document.hidden) return
      document.removeEventListener('visibilitychange', whenVisible)
      again()
    }
    const timer = setTimeout(() => {
      if (document.hidden) document.addEventListener('visibilitychange', whenVisible)
      else again()
    }, Math.min(VERIFY_WAIT_MAX_MS, VERIFY_WAIT_MS * 2 ** Math.min(attempt, 8)))
    return () => {
      cancelled = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', whenVisible)
    }
  }, [verified, poolId, attempt, linkLeft])

  const linked = preselectFrom(poolId, featured.entries)
  const preselect: PreselectStatus = !linked.ok
    ? { kind: linked.reason === 'malformed' ? 'malformed' : 'none' }
    : verified?.poolId === poolId && verified.attempt === attempt
      ? verified.outcome
      : { kind: 'checking', again: attempt > 0 }

  const current = visualOf(state, part)
  // V4 (presentation only): the first moment's flag, and Review's two cards on a wide screen (./reviewColumns.ts).
  const firstLoad = useFirstLoad()
  useReviewColumns(current === 'review')

  // QA round 2, Q17 (2026-10-30): each step change is an entry of the browser's history on the same URL, its state only
  // (markOf), never the hash: nothing routes or remounts. A step reached by the browser's Back or Forward is not written
  // again; the flow's first entry (or a link's) is marked in place, under the flow's own name (its review). The step
  // of each entry is kept, so Back can pass the ones that would change nothing (onPop below). A browser that refuses
  // history writes keeps the flow as one entry, as before.
  const trail = useRef<Trail>({ flow: null, at: 0, hash: null, popped: null, steps: [] })
  useEffect(() => {
    const mine = trail.current
    const hash = currentRoute()
    if (mine.popped === current && mine.hash === hash) {
      mine.popped = null
      return
    }
    mine.popped = null
    try {
      if (mine.flow === null || mine.hash !== hash) {
        // A flow starts on this entry. An entry an earlier flow marked keeps its count, so every entry behind it is
        // still counted from the first one on this link (Back passes them all at once, onPop below).
        const held: unknown = window.history.state
        const mark = markOf(held)
        mine.flow = newFlowName()
        mine.hash = hash
        mine.at = mark ? mark.dmIndex : 0
        mine.steps = []
        mine.steps[mine.at] = current
        window.history.replaceState({ ...(held && typeof held === 'object' ? held : {}), dmFlow: mine.flow, dmStep: current, dmIndex: mine.at }, '')
        return
      }
      if (mine.steps[mine.at] === current) return
      mine.at += 1
      mine.steps.length = mine.at
      mine.steps[mine.at] = current
      window.history.pushState({ dmFlow: mine.flow, dmStep: current, dmIndex: mine.at }, '')
    } catch {
      /* Kept as one entry. */
    }
  }, [current, poolId, linkToken])

  // Speed wave, 2026-09-28 (study item 33): Create position's code is asked once a pool is chosen, so Review finds it
  // loaded instead of waiting for it behind its disabled button. Loading it runs nothing.
  const poolChosen = state.pool !== null
  useEffect(() => {
    if (poolChosen) preloadCreateControl()
    if (poolChosen && __DOMINO_V2__) {
      V2Review?.preload()
      V2Create?.preload()
    }
  }, [poolChosen])

  /** Makes `updated` the state, with `nextPart` as the open half of the amount stage, and keeps the step it opens. */
  const open = (updated: JourneyState, nextPart: AmountPart = part) => {
    fundingEpoch.current++
    setFundingAdvance(null)
    const step = visualOf(updated, nextPart)
    setKept((was) => ({ ...was, [step]: keyOf(step, updated) }))
    setPart(nextPart)
    setState(updated)
  }
  const update = (updated: JourneyState) => {
    fundingEpoch.current++
    setFundingAdvance(null)
    setState(updated)
  }

  // Step 1's token and pool, picked by hand: the link no longer decides (steer, above).
  const setToken = (candidate: TokenCandidate | null) => {
    setPreview(null)
    steer()
    update(withToken(state, candidate))
  }
  const setPool = (option: PoolOption | null) => {
    setPreview(null)
    update(withPool(state, option, now))
  }
  const pickPool = (option: PoolOption | null) => {
    steer()
    setPool(option)
  }
  const setRange = (range: TickRange) => update(withRange(state, range))
  // Changed on purpose 2026-10-31 (QA round 2 follow-ups, free-amounts; the owner: "tem que ser livre"): typing in the
  // other token's row before anything is typed makes it the amount, and the first row is worked out from it, as before;
  // once an amount is typed, a figure typed over the worked-out one is the person's own and stays as typed (withOtherAmount).
  // Cleared, or "Fill in for me" pressed, it is worked out again. One change each, from the same state.
  // Changed on purpose 2026-10-31 (free-amounts review; the owner: "preencher de forma automática quando o usuário não tem
  // o token"): with a wallet read holding none of one of the two tokens, the field typed in is the amount and the other is
  // worked out from it, as before (lib/create/reviewPlan.ts lacksOne). `pair` is the balances read below, as drawn.
  const setBudget = (text: string) => update(withTypedAmount(state, text))
  const setDeposit = (candidate: TokenCandidate, text: string) =>
    update(withOtherAmount(state, candidate, text, !(state.pool && lacksOne(state.pool, rawBalances(pair)))))
  const setSlippage = (text: string) => update(withSlippage(state, text))

  const blocked = rangeBlock.lower ?? rangeBlock.upper ?? null

  // What each step needs before Continue, in the machine's own words.
  const tokenCheck = canContinue('token', state, now)
  const poolCheck = tokenCheck.ok ? canContinue('pool', state, now) : tokenCheck
  const price = priceOf(state.pool, now)
  const usablePrice = price && price.state === 'usable' ? price : null
  const rangeCheck: Check = !poolCheck.ok ? poolCheck : !state.pool ? fail(CREATE.pool.needPool) : !usablePrice ? fail(CREATE.amount.priceUnavailable) : blocked ? fail(blocked) : validateRange(state.range, state.pool)
  const amountCheck = poolCheck.ok ? canContinue('amount', state, now) : poolCheck

  const complete: Record<VisualStep, boolean> = { pool: poolCheck.ok, range: rangeCheck.ok, amount: amountCheck.ok, review: false }
  const furthest = stageIndex(state.furthest)
  const reached: Record<VisualStep, boolean> = {
    pool: true,
    range: furthest >= stageIndex('amount'),
    amount: furthest > stageIndex('amount') || amountReached,
    review: furthest >= stageIndex('review'),
  }

  // Continue, per step. Each moves through the machine with next(), which checks canContinue again.
  const forward = () => {
    switch (current) {
      case 'pool': {
        let moved = state
        if (moved.stage === 'token') moved = next(moved, now)
        if (moved.stage === 'pool') moved = next(moved, now)
        if (moved.stage === 'amount') open(moved, 'range')
        return
      }
      case 'range':
        if (!rangeCheck.ok) return
        setAmountReached(true)
        open(state, 'amount')
        return
      case 'amount': {
        if (__DOMINO_V2__) {
          if (activeFunding?.state === 'ready') { void continueFunding(); return }
          if (activeFunding && activeFunding.state !== 'none') return
        }
        if (!checkFor.amount.ok) return
        const toBalance = next(state, now)
        if (toBalance.stage !== 'balance') return
        // The balance stage has no step of its own: its rows are in Review. It always continues.
        open(next(toBalance, now), 'amount')
        return
      }
      case 'review':
        return
      default:
        return current satisfies never
    }
  }

  // Back moves exactly one step; back() moves exactly one stage per call.
  const backward = () => {
    switch (current) {
      case 'pool':
        return
      case 'range':
        open(back(state), 'range')
        return
      case 'amount':
        open(state, 'range')
        return
      case 'review':
        // Back over the balance stage too: it has no step of its own, so Review's Back lands on Amount.
        open(back(back(state)), 'amount')
        return
      default:
        return current satisfies never
    }
  }

  // Reopening a done step: goTo() opens a stage only when canOpen() allows it.
  const reopen = (step: VisualStep) => {
    const target = STAGE_OF[step]
    if (creating || !canOpen(target, state, now)) return
    open(goTo(state, target, now), step === 'amount' ? 'amount' : 'range')
  }

  // One wallet read for both of the pool's currencies, owned here so it starts
  // as soon as a pool is chosen and is settled by the time Review reads it:
  // the amount step names the second token with it, and Review and Create
  // position plan the deposit from it.
  // Read again when funds brought from another network arrive (2026-10-05): the offer under the amounts says so. And on
  // Review's quiet re-reads while the read finishes with nothing usable (2026-10-06, the final check's F5; QA round 2,
  // final review journey-1: no button any more).
  const [balanceRevision, setBalanceRevision] = useState(0)
  // Changed on purpose 2026-10-30 (launch capacity, item 9a): while Amount is open its three reads (the balances, the offer
  // to pay with another token, the pool's price) are asked again in the background from one tick, every minute while the
  // page is visible, and when the page is opened again (Amount reached, focus, a tab shown) only once the last read is a
  // minute old; it was every 30 s, with the offer and the price each on a timer of their own. A background read keeps what
  // is on screen until its answer is in: nothing flips back to loading, and Continue stays as it is (usePairBalances.ts,
  // usePricedPool.ts). A deliberate read again (funds arrived, Review's re-reads) still waits for its answer, as before.
  // Its review: a background read of the balances that reads nothing keeps the balances it had (usePairBalances.ts), and
  // Continue held by a read that answered without its figure is asked again sooner (RETRY_MS, below).
  // `readsTick` moves the balances and the offer once a wallet's first read of them is in; `priceTick` the price.
  const [readsTick, setReadsTick] = useState(0)
  const [priceTick, setPriceTick] = useState(0)
  const pair = usePairBalances(source, state.pool, others, balanceRevision, readsTick)
  const balanceRead = useRef(pair.status)
  const balanceRefreshing = useRef(false)
  const payReading = useRef(false)
  const marketReading = useRef(false)
  useEffect(() => {
    balanceRead.current = pair.status
    balanceRefreshing.current = pair.refreshing === true
  })
  const balanceKey = state.pool ? `${state.pool.currencies[0].chainId}|${state.pool.key}` : null
  // When the balances and the offer were last asked: as a pool is chosen, on a deliberate read again, and on each tick;
  // when the price was last asked on the tick; and how many reads in a row were asked while Continue waited (RETRY_MS).
  const lastRead = useRef(0)
  const lastPrice = useRef(0)
  const retries = useRef(0)
  useEffect(() => {
    lastRead.current = Date.now()
    retries.current = 0
  }, [balanceKey, balanceRevision])
  // Added 2026-10-06 (the owner: "USD estimate unavailable" for Robinhood Chain pairs without USDG): the chosen pool with its
  // currencies' qualified prices, once read (./usePricedPool.ts), for what the steps value: the amount step, its row, the
  // preview and Review. Everything else keeps the state as it is. Since 2026-10-31 (free-amounts) over the state plans read
  // (`amounts`), which still carries both amounts as typed for the amount step to draw.
  const pricedPool = usePricedPool(state.pool)
  const valued = useMemo<JourneyState>(() => (pricedPool === amounts.pool ? amounts : { ...amounts, pool: pricedPool }), [amounts, pricedPool])
  // Added 2026-10-06 (the owner: AI/PONS short on Robinhood Chain and nothing offered): what paying with one other token
  // would be for this pool and wallet, read once and again with the balances (./usePricedPool.ts usePayFacts): on a
  // deliberate read again and on Amount's tick, keeping its last answer meanwhile; the tick apart, so a tick's read never
  // cuts short one already out, and the reader knows a background read from a deliberate one (PoolPrices `pay`).
  const pay = usePayFacts(state.pool, balanceRevision, state.payWith?.token ?? null, readsTick)
  useEffect(() => { payReading.current = pay === undefined })
  // Changed on purpose 2026-10-30 (QA round 2, N18): the price is read once as Range opens, so the amount step pairs the
  // first typed amount on a fresh price instead of changing it under the person when its first read lands; it is read
  // again on Amount alone, in the background, on its tick (launch capacity 9a). The range keeps its width (RangeStep.tsx)
  // and nothing is said.
  const priceReading = useLivePoolPrice(state.pool, (current === 'range' || current === 'amount') && !creating, balanceRevision, (fresh) => {
    // A price crossing the range never clears or silently changes the user's independent amount.
    setState((was) => withFreshPool(was, fresh))
  }, current === 'amount', priceTick)
  useEffect(() => { marketReading.current = priceReading })
  const paidFunding = state.payWith ? payFunding(state.payWith, pay) : null
  const pairFunding = state.payWith ? null : reviewPlan(amounts, rawBalances(pair))
  // Continue held by a read that answered without the figure it needs: the token chosen to pay with, or the pool's two
  // balances (a background read that reads nothing keeps the figures it had, usePairBalances.ts, so this is a first read,
  // a deliberate one, or the offer's).
  const unreadHold = __DOMINO_V2__ && current === 'amount' && (paidFunding ? paidFunding.kind === 'unread' : pair.status === 'ready' && (pair.balances === null || pair.balances.some((side) => side.raw === null)))
  // Changed on purpose 2026-10-30 (launch capacity 9a, its review): one timer, set from the last read whatever asked it (a
  // focus, a tab shown, a deliberate read again), so a read in between never makes the next wait close to two minutes;
  // and sooner while `unreadHold` (RETRY_MS). Nothing is planned or asked while the page is hidden.
  useEffect(() => {
    if (!__DOMINO_V2__ || current !== 'amount' || creating || !balanceKey) return
    if (!unreadHold) retries.current = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const due = () => (unreadHold ? RETRY_MS[Math.min(retries.current, RETRY_MS.length - 1)] : REFRESH_MS)
    const refresh = (age: number) => {
      if (document.hidden || Date.now() - lastRead.current < age) return
      lastRead.current = Date.now()
      if (unreadHold) retries.current += 1
      // The price whatever the wallet, once a minute (a read of it already out is left to finish).
      if (!marketReading.current && lastRead.current - lastPrice.current >= REFRESH_MS - TIMER_SLACK_MS) {
        lastPrice.current = lastRead.current
        setPriceTick((n) => n + 1)
      }
      // The balances and the offer once their first read is in, and no read of them is out: none is cut short.
      if (balanceRead.current !== 'disconnected' && balanceRead.current !== 'loading' && !balanceRefreshing.current && !payReading.current) setReadsTick((n) => n + 1)
    }
    const plan = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (document.hidden) return
        refresh(due() - TIMER_SLACK_MS)
        plan()
      }, Math.max(0, lastRead.current + due() - Date.now()))
    }
    const onReturn = () => {
      refresh(unreadHold ? Math.min(due(), RETURN_RETRY_MS) : due())
      plan()
    }
    refresh(due())
    plan()
    window.addEventListener('focus', onReturn)
    document.addEventListener('visibilitychange', onReturn)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('focus', onReturn)
      document.removeEventListener('visibilitychange', onReturn)
    }
  }, [current, creating, balanceKey, balanceRevision, unreadHold])
  // Changed on purpose 2026-10-30 (QA round 2 review, the sweep): a balance not read yet holds Continue as a balance being
  // checked, never as one that "could not be checked"; it is read again quietly (RETRY_MS, above).
  // Changed on purpose 2026-11-07 (review finding P1): on a network funds are not brought to (Elysium, where the build
  // serves it: lib/elysiumIdentity.ts fundsBroughtTo), nothing is offered below the amounts but paying with another token
  // the wallet holds there (`pay`, the funding line's own facts); without one, the reason is Robinhood Chain's own way on.
  // Changed on purpose 2026-11-07 (review finding P6): the network fee's reason in that network's currency (HYPE on Elysium).
  const poolChainId = state.pool?.currencies[0].chainId
  const noBringing = ELYSIUM_LIVE && !fundsBroughtTo(poolChainId)
  const shortReason = (offered: boolean) => (noBringing && !offered ? 'Lower the amount, or add tokens to your wallet.' : 'Choose how to fund this amount below.')
  const fundingCheck: Check = paidFunding && paidFunding.kind !== 'ready'
    ? fail(paidFunding.kind === 'short' ? shortReason(false) : paidFunding.kind === 'gas' ? nativeWords('Add ETH for the network fee to continue.', poolChainId) : CREATE.amount.pairReading)
    : __DOMINO_V2__ && !state.payWith && pair.status !== 'disconnected' && (!pairFunding?.plan || pairFunding.plan.kind === 'short')
      ? fail(pairFunding?.plan?.kind === 'short' ? shortReason(!!pay) : CREATE.amount.pairReading)
      : priceReading ? fail('Checking the price…') : amountCheck

  // Added 2026-10-30 (QA round 2, N54, the owner's decision): US$ 1 at least, by the total the step shows (or the amount
  // paid with another token); a pool with no USD value refuses only an amount that rounds to nothing in one of its two
  // tokens. Said only as Continue's reason; no figure is changed.
  const minimumCheck: Check = (() => {
    if (!amountCheck.ok || !valued.pool) return amountCheck
    if (valued.payWith) {
      const paidAmount = valued.payWith
      const typed = validateBudget(paidAmount.text, paidAmount.token.decimals)
      const facts = pay && pay.token.chainId === paidAmount.token.chainId && pay.token.address.toLowerCase() === paidAmount.token.address.toLowerCase() ? pay : null
      const usd = typed.ok ? usdAt(typed.raw, paidAmount.token.decimals, facts?.usd ?? null) : null
      return underMinimum(usd) ? fail(CREATE.amount.tooSmall) : amountCheck
    }
    const held = heldAmounts(valued, pair)
    const total = held !== null && held.sides.every((side) => side.usd !== null) ? held.total : null
    if (total !== null) return underMinimum(total) ? fail(CREATE.amount.tooSmall) : amountCheck
    const planned = reviewPlan(valued, null)
    return planned && takesOnly(valued) === null && (planned.need[0] === 0n || planned.need[1] === 0n) ? fail(CREATE.amount.tooSmallUnpriced) : amountCheck
  })()

  const checkFor: Record<VisualStep, Check> = { pool: poolCheck, range: rangeCheck, amount: !amountCheck.ok ? amountCheck : !minimumCheck.ok ? minimumCheck : fundingCheck, review: canContinue('review', state, now) }
  const check = checkFor[current]
  // What Review's own control checks again (N53): the amount, and its minimum.
  const reviewHold: Check = !amountCheck.ok ? amountCheck : minimumCheck
  const activeFunding = __DOMINO_V2__ && funding?.key === fundingKey ? funding.value : null
  const adoptingFunds = fundingAdvance?.key === fundingKey
  const continueFunding = async () => {
    if (fundingBusy.current || activeFunding?.state !== 'ready' || !amountCheck.ok || !minimumCheck.ok || !rangeCheck.ok) return
    const request = { key: fundingKey, epoch: fundingEpoch.current }
    fundingBusy.current = true
    setFundingAdvance({ ...request, phase: 'checking' })
    try {
      const adopted = await activeFunding.run()
      if (request.key !== fundingKeyRef.current || request.epoch !== fundingEpoch.current) return
      setFundingAdvance(adopted ? { ...request, phase: 'ready' } : null)
    } catch {
      if (request.key === fundingKeyRef.current && request.epoch === fundingEpoch.current) setFundingAdvance(null)
    } finally { fundingBusy.current = false }
  }
  // The one Continue click adopts the selected payment, then waits for the parent's current balance/price check.
  // Arrival itself never advances the wizard, changes the amount or signs a transaction.
  const canAdvanceAmount = checkFor.amount.ok
  const amountReadSettled = pair.status === 'ready' && pay !== undefined && !priceReading
  useEffect(() => {
    if (!__DOMINO_V2__) return
    if (!fundingAdvance || fundingAdvance.phase !== 'ready' || fundingAdvance.key !== fundingKey || current !== 'amount') return
    // Let the selected payment's balance refresh commit first. Cancel if any input changes before this handoff.
    const timer = setTimeout(() => {
      if (fundingAdvance.epoch !== fundingEpoch.current || fundingAdvance.key !== fundingKeyRef.current) return
      if (!canAdvanceAmount) { if (amountReadSettled) setFundingAdvance(null); return }
      const balance = next(state, now)
      if (balance.stage !== 'balance') return
      const reviewed = next(balance, now)
      if (reviewed.stage !== 'review') return
      setFundingAdvance(null)
      setKept((was) => ({ ...was, review: keyOf('review', reviewed) }))
      setPart('amount')
      setState(reviewed)
    }, 0)
    return () => clearTimeout(timer)
  }, [fundingAdvance, fundingKey, current, canAdvanceAmount, amountReadSettled, state, now])
  // A lost response is a retryable read, never an endless wait or permission to submit a transaction.
  useEffect(() => {
    if (!__DOMINO_V2__ || !fundingAdvance) return
    const timer = setTimeout(() => setFundingAdvance((current) => current === fundingAdvance ? null : current), 30_000)
    return () => clearTimeout(timer)
  }, [fundingAdvance])
  const fundingWaiting = current === 'amount' && activeFunding && (activeFunding.state === 'waiting' || activeFunding.state === 'attention')
  const continuationReady = current === 'amount' && activeFunding?.state === 'ready'
  const canPressContinue = __DOMINO_V2__ ? !adoptingFunds && !fundingWaiting && (continuationReady ? amountCheck.ok && minimumCheck.ok && rangeCheck.ok : check.ok) : check.ok
  const continueReason = __DOMINO_V2__ && adoptingFunds ? 'Checking your selected funds…' : fundingWaiting ? activeFunding.copy : check.ok ? '' : check.reason
  // QA round 2, Q17: the browser's Back and Forward open the step their entry names, with every choice kept (the flow never
  // unmounted). Once the position exists the flow rests on its success: Back leaves it, as before. While Create position
  // asks the wallet, a step change waits: the entry goes back to Review. A Forward the step's Continue would not take goes
  // back to the entry on screen. Changed on purpose 2026-10-30 (QA round 2 review): Back never rests on an entry that
  // changes nothing. An earlier flow's entry, or one whose step cannot open now, is passed on to the nearest entry of
  // this flow that opens a step, else out of the flow to the page before it, in the same press.
  const onPop = useRef<(event: PopStateEvent) => void>(() => undefined)
  useEffect(() => {
    onPop.current = (event) => {
      const mine = trail.current
      if (currentRoute() !== mine.hash) return
      const mark = markOf(event.state)
      if (!mark) return
      const was = mine.at
      const ahead = mark.dmIndex > was
      // Back to the entry of the step on screen (never go(0), which reloads the page).
      const stay = () => {
        if (mark.dmIndex !== was) window.history.go(was - mark.dmIndex)
      }
      // Out of the flow, past every entry left on this link: the page before it.
      const leave = () => {
        mine.at = mark.dmIndex
        window.history.go(-(mark.dmIndex + 1))
      }
      if (mark.dmFlow !== mine.flow) {
        if (ahead) stay()
        else leave()
        return
      }
      if (mark.dmStep === current) {
        mine.at = mark.dmIndex
        return
      }
      if (created || createdV2) {
        if (ahead) stay()
        else leave()
        return
      }
      if (creating) {
        stay()
        return
      }
      const opens = (step: VisualStep | undefined) => step !== undefined && step !== current && canOpen(STAGE_OF[step], state, now)
      if (ahead && (!opens(mark.dmStep) || !canPressContinue || continuationReady)) {
        stay()
        return
      }
      if (!ahead && !opens(mark.dmStep)) {
        let to = mark.dmIndex - 1
        while (to >= 0 && !opens(mine.steps[to])) to -= 1
        if (to < 0) {
          leave()
          return
        }
        mine.at = mark.dmIndex
        window.history.go(to - mark.dmIndex)
        return
      }
      mine.at = mark.dmIndex
      mine.popped = mark.dmStep
      if (mark.dmStep === 'amount') setAmountReached(true)
      open(goTo(state, STAGE_OF[mark.dmStep], now), mark.dmStep === 'amount' ? 'amount' : 'range')
    }
  })
  useEffect(() => {
    const listener = (event: PopStateEvent) => onPop.current(event)
    window.addEventListener('popstate', listener)
    return () => window.removeEventListener('popstate', listener)
  }, [])

  // Changed on purpose (owner, 2026-09-24): step 1 shows no buttons until a token is chosen, and then only
  // Continue, full width (there is nowhere to go back to from the first step). The buttons arrive gently
  // (flow.css, stilled under reduced motion). The reason paragraph stays mounted, out of sight while nothing
  // is chosen, so the live region already exists when its first visible reason lands in it.
  const first = current === 'pool'
  const waiting = first && !state.token
  const footer = (
    <div
      className="dm-flow-foot"
      data-journey-footer=""
      data-final={current === 'review' ? '' : undefined}
      data-first={first ? '' : undefined}
      data-waiting={waiting ? '' : undefined}
    >
      {/* On Review, Back steps down under Create position (flow.css), so it is the smaller button there. */}
      {!first && (
        <Button type="button" variant="outline" size={current === 'review' ? 'md' : 'lg'} disabled={creating} hidden={created || createdV2} onClick={backward}>
          {CREATE.page.back}
        </Button>
      )}
      {current === 'review' ? (
        // Added 2026-10-30 (QA round 2, N53): Review never offers Connect wallet or Create position for choices the amount
        // step would not take (another pool's link, an amount gone); never while the wallet is asked, nor once created.
        !creating && !created && !createdV2 && !reviewHold.ok ? (
          <CreateUnavailable note={reviewHold.reason} />
        ) : V2Create ? (
          <V2Create
            state={amounts}
            balances={pair}
            pay={pay}
            onBusy={setCreating}
            onReadAgain={() => setBalanceRevision((n) => n + 1)}
            onFreshPool={(fresh) => setState((was) => withFreshPool(was, fresh))}
            v1={<FinalControl state={amounts} balances={pair} onBusy={setCreating} />}
          />
        ) : (
          <FinalControl state={amounts} balances={pair} onBusy={setCreating} />
        )
      ) : (
        <>
          {!waiting && (
            // Changed on purpose 2026-10-30 (QA round 2, N89): not ready, Continue is aria-disabled rather than disabled, so
            // Tab still reaches it and its reason is read with it; pressed then, it does nothing. It keeps its quiet face.
            <Button
              type="button"
              variant="primary"
              size="lg"
              aria-disabled={canPressContinue ? undefined : true}
              aria-describedby={canPressContinue ? undefined : 'continue-reason'}
              onClick={canPressContinue ? forward : undefined}
            >
              {__DOMINO_V2__ && adoptingFunds ? 'Checking funds…' : current === 'amount' && activeFunding?.state === 'waiting' ? 'Waiting for funds…' : CREATE.page.next}
            </Button>
          )}
          {/* Always in the DOM, so the live region exists before the reason lands in it: a region
              mounted together with its text is announced by nothing. */}
          <p id="continue-reason" role="status" className={waiting ? 'dm-flow-reason sr-only' : 'dm-flow-reason'}>
            {continueReason}
          </p>
          {/* Changed on purpose 2026-10-30 (QA round 2 review, the sweep, rule 3): no "Check balance again" button under it.
              While Amount is open the balances are read again quietly: every minute, and sooner while they hold Continue
              (RETRY_MS, launch capacity 9a). */}
        </>
      )}
    </div>
  )


  const bodyOf = (step: VisualStep): ReactNode => {
    switch (step) {
      case 'pool':
        if (__DOMINO_V2__ && V2PoolAdvanced) {
          return (
            <div className="dm-flow-stack" data-pool-stage="">
              <StageToken source={source} state={state} preselect={preselect} candidates={candidates} onCandidates={setCandidates} onToken={setToken} onPool={pickPool} onPreview={setPreview} others={others} top={topPools} topServer={topServer} initialPool={initialPool} />
              {/* Changed on purpose 2026-11-06 (O-15): the finder of the chosen token's network (Robinhood Chain before one). */}
              {!state.pool && (
                <Suspense fallback={null}>
                  <V2PoolAdvanced chainId={state.token?.token.chainId ?? 4663} />
                </Suspense>
              )}
            </div>
          )
        }
        return <StageToken source={source} state={state} preselect={preselect} candidates={candidates} onCandidates={setCandidates} onToken={setToken} onPool={pickPool} onPreview={setPreview} top={topPools} topServer={topServer} initialPool={initialPool} />
      case 'range':
        return <StageRange source={source} state={state} onRange={setRange} onPool={setPool} others={others} onBlock={onRangeBlock} />
      case 'amount':
        return (
          <StageAmount
            flowKey={fundingFlowKey}
            onContinuationChange={__DOMINO_V2__ ? receiveFunding : undefined}
            onFundingPayWith={__DOMINO_V2__ ? (payWith) => setState((was) => withPayWith(was, payWith)) : undefined}
            state={valued}
            balances={pair}
            onBudget={setBudget}
            onDeposit={setDeposit}
            onSlippage={setSlippage}
            onFundsArrived={() => setBalanceRevision((n) => n + 1)}
            onPayWith={(payWith) => update(withPayWith(state, payWith))}
            pay={pay}
          />
        )
      case 'review':
        return V2Review ? (
          <V2Review state={valued} now={now} balances={pair} pay={pay} v1={<StageReview state={valued} now={now} balances={pair} />} />
        ) : (
          <StageReview state={valued} now={now} balances={pair} />
        )
      default:
        return step satisfies never
    }
  }

  const summaryOf = (step: VisualStep): ReactNode => {
    switch (step) {
      case 'pool':
        // QA round 2, Q23/N37: the pool's network on its row, where the chosen pool's panel names it (other networks offered).
        return <PoolSummary state={state} network={state.pool ? (others?.name(state.pool.currencies[0].chainId) ?? null) : null} />
      case 'range':
        return state.range && usablePrice ? <RangeSummary range={state.range} price={usablePrice} /> : null
      case 'amount':
        return <AmountSummary state={valued} held={heldAmounts(valued, pair)} />
      case 'review':
        return null
      default:
        return step satisfies never
    }
  }

  // A range that takes one token alone asks for that token's amount only (2026-10-01, live note L11): the amount step
  // says so, instead of "either token". Words only: the journey already moved the amount to that token (withRange).
  const one = takesOnly(state)
  const oneSymbol = one !== null && state.pool ? (state.pool.currencies[one].symbol ?? null) : null
  // Added 2026-10-06: paid with one other token, the step says so (lib/create/journey.ts PayWith).
  const paid = state.payWith?.token.symbol
  const amountLead = paid ? CREATE.step.amount.leadPay(paid) : oneSymbol ? CREATE.step.amount.leadOne(oneSymbol) : undefined

  // A step is done when it was reached, its inputs are complete, every step
  // before it is complete, and the machine would open it again.
  const steps: StepView[] = VISUAL_STEPS.map((step, index) => {
    const isCurrent = step === current
    const earlierComplete = VISUAL_STEPS.slice(0, index).every((before) => complete[before])
    const done = !isCurrent && earlierComplete && reached[step] && complete[step] && canOpen(STAGE_OF[step], state, now)
    const mounted = isCurrent || kept[step] === keyOf(step, state)
    return {
      key: step,
      state: isCurrent ? 'current' : done ? 'done' : 'upcoming',
      stage: isCurrent ? state.stage : STAGE_OF[step],
      summary: done ? summaryOf(step) : null,
      body: mounted ? bodyOf(step) : null,
      footer: isCurrent ? footer : null,
      // Changed on purpose 2026-10-30 (QA round 2, Q4): a two-sided Amount says its own line (CREATE.step.amount.lead: both
      // tokens go in), as Range does; Pool and Review keep none.
      lead: step === 'amount' ? amountLead : step === 'range' ? undefined : '',
    }
  })

  // The page is the steps and, on a wide screen, the position they make, drawn beside them as it takes shape.
  return (
    <PageShell width="flow" className="dm-np" data-create-journey="" data-create-step={current} data-first-load={firstLoad ? '' : undefined}>
      <PageHeader size="display" title={CREATE.page.title} className="dm-np-head dm-flow-rise" />
      <div className="dm-card dm-flow-card dm-flow-rise dm-lit" style={{ '--delay': '40ms' } as CSSProperties}>
        <StepList steps={steps} onOpen={reopen} locked={creating} />
      </div>
      <PositionPreview
        className="dm-card dm-flow-preview dm-flow-rise dm-lit"
        style={{ '--delay': '80ms' } as CSSProperties}
        state={valued}
        preview={current === 'pool' && !state.pool ? preview : null}
        price={usablePrice}
        balances={pair}
        step={current}
        network={others ? (chainId) => others.name(chainId) : null}
      />
    </PageShell>
  )
}
