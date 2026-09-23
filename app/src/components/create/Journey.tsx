import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { CREATE } from '../../lib/create/copy'
import {
  back,
  canContinue,
  canOpen,
  candidatesFromPool,
  goTo,
  initialState,
  next,
  preselectFrom,
  priceOf,
  stageIndex,
  validateRange,
  verificationToken,
  withBudget,
  withPool,
  withRange,
  withSlippage,
  withToken,
  type Check,
  type JourneyState,
  type Stage,
  type TickRange,
} from '../../lib/create/journey'
import { verifyCandidate } from '../../lib/read/screens/catalogueSession'
import { failureText } from '../../lib/read/screens/copy'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import { useReadSource } from '../../lib/read/screens/readContext'
import { usePairBalances } from './usePairBalances'
import { mergeCandidates, type TokenCandidate } from '../../lib/read/screens/tokens'
import { useNow } from '../../lib/read/useNow'
import { Button, PageHeader, PageShell } from '../ui'
import { StageAmount, StageRange } from './StageAmount'
import { FinalControl, StageReview } from './StageReview'
import { StageToken, type PreselectStatus } from './StageToken'
import { AmountSummary, PoolSummary, RangeSummary, StepList, VISUAL_STEPS, type StepView, type VisualStep } from './StepList'

/** The outcomes only the verification read can produce. */
type Verified = Extract<PreselectStatus, { kind: 'verified' | 'not_found' | 'failed' }>

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
export function Journey({ poolId }: { poolId: string }) {
  const source = useReadSource()
  const now = useNow(false).wall
  const [state, setState] = useState<JourneyState>(initialState)
  const [part, setPart] = useState<AmountPart>('range')
  // Create position is asking the wallet: Back waits, so leaving Review cannot drop the flow mid-way.
  const [creating, setCreating] = useState(false)
  // Whether the budget half of the amount stage has been reached on this visit.
  const [amountReached, setAmountReached] = useState(false)
  const [candidates, setCandidates] = useState<TokenCandidate[]>([])
  const [kept, setKept] = useState<Partial<Record<VisualStep, string>>>({ pool: 'static' })
  // What the verification read of the linked pool came to, for the link and the attempt it was about.
  const [verified, setVerified] = useState<{ poolId: string; attempt: number; outcome: Verified } | null>(null)
  // Each attempt is one more read of the same id: asked again on its own after a failure that asking again could fix.
  const [attempt, setAttempt] = useState(0)
  const running = useRef<AbortController | null>(null)

  useEffect(() => () => running.current?.abort(), [])

  // The pool id in the link, verified against the chain exactly as the
  // explorer verifies a featured pool: one pools read for that id, cancelled
  // if the source or the link changes first. State changes only when the
  // read answers; what to show meanwhile is derived below.
  useEffect(() => {
    const linked = preselectFrom(poolId)
    if (!linked.ok || !source) return
    running.current?.abort()
    const controller = new AbortController()
    running.current = controller
    void verifyCandidate(source, verificationToken(linked), null, linked.key, { signal: controller.signal }).then((result) => {
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
      const at = Date.now()
      // A verification read again after a failure never replaces a pool the person chose in the meantime.
      setState((was) => (attempt > 0 && was.pool ? was : withPool(was, option, at)))
      setCandidates((was) => mergeCandidates(was, candidatesFromPool(option)))
      setVerified({ poolId, attempt, outcome: { kind: 'verified', block: option.block } })
    })
    return () => controller.abort()
  }, [source, poolId, attempt])

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

  const linked = preselectFrom(poolId)
  const preselect: PreselectStatus = !linked.ok
    ? { kind: linked.reason === 'malformed' ? 'malformed' : 'none' }
    : verified?.poolId === poolId && verified.attempt === attempt
      ? verified.outcome
      : { kind: 'checking', again: attempt > 0 }

  const current = visualOf(state, part)

  /** Makes `updated` the state, with `nextPart` as the open half of the amount stage, and keeps the step it opens. */
  const open = (updated: JourneyState, nextPart: AmountPart = part) => {
    const step = visualOf(updated, nextPart)
    setKept((was) => ({ ...was, [step]: keyOf(step, updated) }))
    setPart(nextPart)
    setState(updated)
  }
  const update = (updated: JourneyState) => setState(updated)

  const setToken = (candidate: TokenCandidate | null) => update(withToken(state, candidate))
  const setPool = (option: PoolOption | null) => update(withPool(state, option, Date.now()))
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
  const pair = usePairBalances(source, state.pool)

  const checkFor: Record<VisualStep, Check> = { pool: poolCheck, range: rangeCheck, amount: amountCheck, review: canContinue('review', state, now) }
  const check = checkFor[current]
  const footer = (
    <div className="dm-flow-foot" data-journey-footer="" data-final={current === 'review' ? '' : undefined}>
      <Button type="button" variant="outline" size="lg" disabled={current === 'pool' || creating} onClick={backward}>
        {CREATE.page.back}
      </Button>
      {current === 'review' ? (
        <FinalControl state={state} balances={pair} onBusy={setCreating} />
      ) : (
        <>
          <Button type="button" variant="primary" size="lg" disabled={!check.ok} aria-describedby={check.ok ? undefined : 'continue-reason'} onClick={forward}>
            {CREATE.page.next}
          </Button>
          {/* Always in the DOM, so the live region exists before the reason lands in it: a region
              mounted together with its text is announced by nothing. */}
          <p id="continue-reason" role="status" className="dm-flow-reason">
            {check.ok ? '' : check.reason}
          </p>
        </>
      )}
    </div>
  )


  const bodyOf = (step: VisualStep): ReactNode => {
    switch (step) {
      case 'pool':
        return <StageToken source={source} state={state} preselect={preselect} candidates={candidates} onCandidates={setCandidates} onToken={setToken} onPool={setPool} />
      case 'range':
        return <StageRange source={source} state={state} onRange={setRange} onPool={setPool} />
      case 'amount':
        return <StageAmount state={state} balances={pair} onBudget={setBudget} onDeposit={setDeposit} onSlippage={setSlippage} />
      case 'review':
        return <StageReview state={state} now={now} balances={pair} />
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
        return <AmountSummary state={state} />
      case 'review':
        return null
      default:
        return step satisfies never
    }
  }

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
    }
  })

  return (
    <PageShell width="flow" data-create-journey="">
      <PageHeader size="display" align="center" title={CREATE.page.title} description={CREATE.page.description} className="dm-flow-rise" />
      <div className="dm-card dm-flow-card dm-flow-rise" style={{ '--delay': '60ms' } as CSSProperties}>
        <StepList steps={steps} onOpen={reopen} locked={creating} />
      </div>
    </PageShell>
  )
}
