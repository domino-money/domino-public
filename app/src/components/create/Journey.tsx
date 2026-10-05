import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { CREATE } from '../../lib/create/copy'
import {
  back,
  canContinue,
  canOpen,
  candidatesFromPool,
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
  withBudget,
  withPool,
  withRange,
  withSlippage,
  withToken,
  type Check,
  type JourneyState,
  type Preselect,
  type Stage,
  type TickRange,
} from '../../lib/create/journey'
import { useOtherChains } from '../../lib/create/otherChains'
import { forgetCreatePools } from '../../lib/create/poolsAhead'
import { featuredStore, useFeatured } from '../../lib/read/featuredSource'
import { verifyCandidate } from '../../lib/read/screens/catalogueSession'
import { failureText } from '../../lib/read/screens/copy'
import { DYNAMIC_FEE_PIPS } from '../../lib/read/screens/fee'
import { NATIVE_CURRENCY, addressKey, type AddressKey } from '../../lib/read/screens/identity'
import { poolWarning } from '../../lib/read/screens/lookalike'
import { optionUsableForDomino, type PoolOption } from '../../lib/read/screens/poolsList'
import { useReadSource } from '../../lib/read/screens/readContext'
import { usePairBalances, type PairBalancesState } from './usePairBalances'
import { useCreated } from '../../lib/create/createProgress'
import { mergeCandidates, type TokenCandidate } from '../../lib/read/screens/tokens'
import { useNow } from '../../lib/read/useNow'
import { recovering } from '../../lib/staleRelease'
import { deferred } from '../Deferred'
import { Button, PageHeader, PageShell } from '../ui'
import { StageAmount, StageRange } from './StageAmount'
import { FinalControl, StageReview, preloadCreateControl } from './StageReview'
import { StageToken, type PreselectStatus } from './StageToken'
import { AmountSummary, PoolSummary, RangeSummary, StepList, VISUAL_STEPS, type StepView, type VisualStep } from './StepList'
import { PositionPreview } from './PositionPreview'
import { heldAmounts } from './valuation'

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
 * the new contracts once Robinhood Chain's S1 gate is live, and hands back today's own Review and Create position (`v1`)
 * everywhere else. Asked once a pool is chosen, as Create position's own code is; one that cannot load leaves today's own.
 */
type V2ReviewProps = { state: JourneyState; now: number; balances: PairBalancesState; v1: ReactElement }
type V2CreateProps = { state: JourneyState; balances: PairBalancesState; onBusy?: (busy: boolean) => void; v1: ReactElement }
const V2Review = __DOMINO_V2__ ? deferred<V2ReviewProps>(recovering(() => import('../../v2in/journey/JourneyCreateV2').then((module) => ({ default: module.ReviewV2 })), () => ({ default: ({ v1 }: V2ReviewProps) => v1 }))) : null
const V2Create = __DOMINO_V2__ ? deferred<V2CreateProps>(recovering(() => import('../../v2in/journey/JourneyCreateV2').then((module) => ({ default: module.default })), () => ({ default: ({ v1 }: V2CreateProps) => v1 }))) : null

/** How many times a failed verification of the linked pool is asked again on its own, and the first wait. */
const VERIFY_ATTEMPTS = 3
const VERIFY_WAIT_MS = 4000

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
export function Journey({ poolId, linkToken = null }: { poolId: string; linkToken?: string | null }) {
  const source = useReadSource()
  const now = useNow(false).wall
  const [state, setState] = useState<JourneyState>(initialState)
  const [part, setPart] = useState<AmountPart>('range')
  // Create position is asking the wallet: Back waits, so leaving Review cannot drop the flow mid-way.
  const [creating, setCreating] = useState(false)
  // Once the position exists, Review offers what comes next in its footer (CreatedNext.tsx) and Back rests. A done step
  // still reopens (review of 2026-09-24): that leaves Review, which ends the offer, so a second position can be made from
  // the same choices; New position's own link starts a fresh flow (screens/NewPosition.tsx).
  const created = useCreated() !== null
  // Whether the budget half of the amount stage has been reached on this visit.
  const [amountReached, setAmountReached] = useState(false)
  const [candidates, setCandidates] = useState<TokenCandidate[]>([])
  const [kept, setKept] = useState<Partial<Record<VisualStep, string>>>({ pool: 'static' })
  // What the verification read of the linked pool came to, for the link and the attempt it was about.
  const [verified, setVerified] = useState<{ poolId: string; attempt: number; outcome: Verified } | null>(null)
  // Each attempt is one more read of the same id: asked again on its own after a failure that asking again could fix.
  const [attempt, setAttempt] = useState(0)
  // A pool row pointed at or focused in step 1 while nothing is chosen: the preview beside the steps shows it.
  const [preview, setPreview] = useState<PoolOption | null>(null)
  const running = useRef<AbortController | null>(null)
  // The list on screen (lib/read/featuredSource.ts): a linked pool it names is found by its entry.
  const featured = useFeatured()
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
      const result = await (kept ?? verifyCandidate(source, against, null, linked.key, { signal: controller.signal }))
      if (controller.signal.aborted) return
      if (result.failure) {
        if (result.failure.state !== 'aborted') setVerified({ poolId, attempt, outcome: { kind: 'failed', line: failureText(result.failure, 'pools') } })
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
      const at = Date.now()
      // The pool arrives chosen, with the token the link was verified against as the one an amount starts in, so step 1
      // is exactly what choosing this pool from the search leaves (round 6, 2026-09-27: one flow, whichever way in).
      // A verification read again after a failure never replaces a pool the person chose in the meantime.
      const start = linkedDepositToken(option, poolHolds(option, USDG) ? USDG : against)
      setState((was) => {
        if (attempt > 0 && was.pool) return was
        const held = was.token !== null && poolHolds(option, was.token.key)
        return withPool(held || !start ? was : withToken(was, start), option, at)
      })
      setCandidates((was) => mergeCandidates(was, candidatesFromPool(option)))
      setVerified({ poolId, attempt, outcome: { kind: 'verified', block: option.block } })
    })
    return () => controller.abort()
  }, [source, poolId, linkToken, attempt])

  // No Retry on this page: a verification that failed in a way asking again could fix (a busy or unreachable
  // read service) is read again by itself, a few times, at doubling intervals, and only while the page is
  // visible. Any other outcome stays as it is, with its reason on the step's data attributes.
  useEffect(() => {
    if (!verified || verified.poolId !== poolId || verified.attempt !== attempt) return
    const outcome = verified.outcome
    if (outcome.kind !== 'failed' || !outcome.line.retry || attempt >= VERIFY_ATTEMPTS) return
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
    }, VERIFY_WAIT_MS * 2 ** attempt)
    return () => {
      cancelled = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', whenVisible)
    }
  }, [verified, poolId, attempt])

  const linked = preselectFrom(poolId, featured.entries)
  const preselect: PreselectStatus = !linked.ok
    ? { kind: linked.reason === 'malformed' ? 'malformed' : 'none' }
    : verified?.poolId === poolId && verified.attempt === attempt
      ? verified.outcome
      : { kind: 'checking', again: attempt > 0 }

  const current = visualOf(state, part)

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
    const step = visualOf(updated, nextPart)
    setKept((was) => ({ ...was, [step]: keyOf(step, updated) }))
    setPart(nextPart)
    setState(updated)
  }
  const update = (updated: JourneyState) => setState(updated)

  const setToken = (candidate: TokenCandidate | null) => {
    setPreview(null)
    update(withToken(state, candidate))
  }
  const setPool = (option: PoolOption | null) => {
    setPreview(null)
    update(withPool(state, option, Date.now()))
  }
  const setRange = (range: TickRange) => update(withRange(state, range))
  const setBudget = (text: string) => update(withBudget(state, text))
  // Typing in the other token's row is one change, not two: switching the
  // independent token clears the amount (withToken), so setting them
  // separately from the same state would lose whichever landed first.
  const setDeposit = (candidate: TokenCandidate, text: string) => update(withBudget(withToken(state, candidate), text))
  const setSlippage = (text: string) => update(withSlippage(state, text))

  // What each step needs before Continue, in the machine's own words.
  const tokenCheck = canContinue('token', state, now)
  const poolCheck = tokenCheck.ok ? canContinue('pool', state, now) : tokenCheck
  const price = priceOf(state.pool, now)
  const usablePrice = price && price.state === 'usable' ? price : null
  const rangeCheck: Check = !poolCheck.ok ? poolCheck : !state.pool ? fail(CREATE.pool.needPool) : !usablePrice ? fail(CREATE.amount.priceUnavailable) : validateRange(state.range, state.pool)
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
  const pair = usePairBalances(source, state.pool, others)

  const checkFor: Record<VisualStep, Check> = { pool: poolCheck, range: rangeCheck, amount: amountCheck, review: canContinue('review', state, now) }
  const check = checkFor[current]
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
        <Button type="button" variant="outline" size={current === 'review' ? 'md' : 'lg'} disabled={creating} hidden={created} onClick={backward}>
          {CREATE.page.back}
        </Button>
      )}
      {current === 'review' ? (
        V2Create ? (
          <V2Create state={state} balances={pair} onBusy={setCreating} v1={<FinalControl state={state} balances={pair} onBusy={setCreating} />} />
        ) : (
          <FinalControl state={state} balances={pair} onBusy={setCreating} />
        )
      ) : (
        <>
          {!waiting && (
            <Button type="button" variant="primary" size="lg" disabled={!check.ok} aria-describedby={check.ok ? undefined : 'continue-reason'} onClick={forward}>
              {CREATE.page.next}
            </Button>
          )}
          {/* Always in the DOM, so the live region exists before the reason lands in it: a region
              mounted together with its text is announced by nothing. */}
          <p id="continue-reason" role="status" className={waiting ? 'dm-flow-reason sr-only' : 'dm-flow-reason'}>
            {check.ok ? '' : check.reason}
          </p>
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
              <StageToken source={source} state={state} preselect={preselect} candidates={candidates} onCandidates={setCandidates} onToken={setToken} onPool={setPool} onPreview={setPreview} others={others} />
              {!state.pool && (
                <Suspense fallback={null}>
                  <V2PoolAdvanced />
                </Suspense>
              )}
            </div>
          )
        }
        return <StageToken source={source} state={state} preselect={preselect} candidates={candidates} onCandidates={setCandidates} onToken={setToken} onPool={setPool} onPreview={setPreview} />
      case 'range':
        return <StageRange source={source} state={state} onRange={setRange} onPool={setPool} others={others} />
      case 'amount':
        return <StageAmount state={state} balances={pair} onBudget={setBudget} onDeposit={setDeposit} onSlippage={setSlippage} />
      case 'review':
        return V2Review ? (
          <V2Review state={state} now={now} balances={pair} v1={<StageReview state={state} now={now} balances={pair} />} />
        ) : (
          <StageReview state={state} now={now} balances={pair} />
        )
      default:
        return step satisfies never
    }
  }

  const summaryOf = (step: VisualStep): ReactNode => {
    switch (step) {
      case 'pool':
        return <PoolSummary state={state} />
      case 'range':
        return state.range && usablePrice ? <RangeSummary range={state.range} price={usablePrice} /> : null
      case 'amount':
        return <AmountSummary state={state} held={heldAmounts(state, pair)} />
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
  const amountLead = oneSymbol ? CREATE.step.amount.leadOne(oneSymbol) : undefined

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
      lead: step === 'amount' ? amountLead : undefined,
    }
  })

  // The page is the steps and, on a wide screen, the position they make, drawn beside them as it takes shape.
  return (
    <PageShell width="flow" className="dm-np" data-create-journey="" data-create-step={current}>
      <PageHeader size="display" title={CREATE.page.title} description={CREATE.page.description} className="dm-np-head dm-flow-rise" />
      <div className="dm-card dm-flow-card dm-flow-rise" style={{ '--delay': '40ms' } as CSSProperties}>
        <StepList steps={steps} onOpen={reopen} locked={creating} />
      </div>
      <PositionPreview
        className="dm-card dm-flow-preview dm-flow-rise"
        style={{ '--delay': '80ms' } as CSSProperties}
        state={state}
        preview={current === 'pool' && !state.pool ? preview : null}
        price={usablePrice}
        balances={pair}
        step={current}
      />
    </PageShell>
  )
}
