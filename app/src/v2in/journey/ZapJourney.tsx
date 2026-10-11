import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { StepList, VISUAL_STEPS, type StepView, type VisualStep } from '../../components/create/StepList'
import { Button, PageHeader, PageShell } from '../../components/ui'
import { CREATE } from '../../lib/create/copy'
import { publishFlowMade } from '../../lib/create/createProgress'
import type { Stage } from '../../lib/create/journey'
import { useReadSource } from '../../lib/read/screens/readContext'
import { useNow } from '../../lib/read/useNow'
import { useWalletIdentity } from '../../lib/walletIdentity'
import { v2Chain } from '../../v2/chains'
import type { V2Gate } from '../../v2/gate'
import { priceText, rangeBothWays } from '../../v2/plan/present'
import type { V2ChainId } from '../../v2/types'
import { AmountStage } from './AmountStage'
import { JOURNEY } from './copy'
import { useLinkedPool } from './linkedPool'
import { feePercent, poolFromList, type JourneyPool } from './model/pools'
import {
  back, canContinue, canOpen, createRequest, goTo, initialJourney, inputsOf, journeyPrice, next, stepIndex,
  withAmounts, withPool, withRange, withSlippage, withStart, type JourneyState, type JourneyStep,
} from './model/state'
import { PoolStage } from './PoolStage'
import { PreviewPanel } from './PreviewPanel'
import { RangeStage } from './RangeStage'
import { FinalControl, ReviewStage } from './ReviewStage'
import { useJourneyRun } from './run'
import { amountText, decimalsOf, labelOf, tokenBook } from './tokens'
import { connectJourney, inTurn } from './wallet'

type Gate = Extract<V2Gate, { mode: 'preview' | 'live' }>

/** The machine stage each visual step stands for, on its body as today's `data-stage-card`. */
const STAGE_OF: Record<JourneyStep, Stage> = { pool: 'pool', range: 'amount', amount: 'amount', review: 'review' }

/**
 * New position on Domino's new contracts (spec F7 rev2 §2.6.1, the integrated journey of 2026-10-02): today's page,
 * header, card and four steps (components/create/StepList.tsx: Pool, Range, Amount, Review), its preview beside them,
 * on Robinhood Chain, over the pure machine in ./model/state.ts (no network choice: the owner, 2026-10-02). Review asks
 * the plan (./run.ts) as it opens and shows it; Create position runs the wallet's steps through the closed money client
 * (finance/v2/zap.ts), or, under a `preview` gate, the gate's sentence stands where they would be. A pool's link
 * (`poolId`, `linkToken`: #/new/<id>[/<token>]) preselects that pool on Robinhood Chain's list once verified
 * (./linkedPool.ts), never over a pool the person chose.
 */
export function ZapJourney({ chainId, gate, finderOnly, onListed, poolId = '', linkToken = null }: {
  chainId: V2ChainId
  gate: Gate
  finderOnly: boolean
  onListed: (poolId: string) => void
  poolId?: string
  linkToken?: string | null
}) {
  const now = useNow(false).wall
  const identity = useWalletIdentity()
  const [state, setState] = useState<JourneyState>(() => initialJourney(chainId))
  const source = useReadSource()
  const listed = chainId === 4663 && !finderOnly
  const preselect = useLinkedPool(source, listed ? poolId : '', linkToken, (option) => {
    const pool = poolFromList({ ...option, currencies: option.currencies, readAt: option.readAt })
    if (pool) setState((was) => (was.pool ? was : withPool(was, pool, Date.now())))
  })
  const [confirmed, setConfirmed] = useState(false)
  const [raceReading, setRaceReading] = useState(false)
  const book = tokenBook(chainId, state.pool ? [...state.pool.tokens] : [])
  const inputs = inputsOf(state) ?? []
  const run = useJourneyRun({
    chainId,
    gate,
    inputs,
    tokens: state.pool?.tokens,
    label: (token) => labelOf(book, token),
    request: (consent) => createRequest(state, consent),
  })
  const view = run.view
  // A fresh quote (a re-quote after a price move or a cancelled signature) is reviewed again: the new pool's box too.
  const [seenRound, setSeenRound] = useState(view.round)
  if (seenRound !== view.round) {
    setSeenRound(view.round)
    setConfirmed(false)
  }
  const price = journeyPrice(state, now)
  const current = state.step
  const locked = view.busy || view.receipt !== null
  // Changed on purpose 2026-10-06 (the final check's F1/F6, a second look): once the position exists the flow is marked
  // made (lib/create/createProgress.ts publishFlowMade), as the owner's journey marks it, so New position's own link starts
  // a fresh flow here too (screens/NewPosition.tsx; from the pool finder, ./NewPositionV2.tsx then opens today's journey);
  // taken back when this goes.
  const made = view.receipt !== null
  useEffect(() => {
    if (!made) return
    publishFlowMade(true)
    return () => publishFlowMade(false)
  }, [made])

  /** Makes `updated` the state; leaving Review drops its quote. */
  const open = (updated: JourneyState) => {
    if (updated.step !== 'review' && state.step === 'review') run.reset()
    setState(updated)
  }
  const forward = () => {
    const moved = next(state)
    if (moved.step === state.step) return
    open(moved)
    if (moved.step === 'review') {
      setConfirmed(false)
      run.start()
    }
  }
  const backward = () => {
    if (locked) return
    open(back(state))
  }
  const reopen = (step: VisualStep) => {
    if (locked || !canOpen(step, state)) return
    open(goTo(state, step))
  }

  const setPool = (pool: JourneyPool | null) => open({ ...withPool(state, pool, Date.now()), step: 'pool' })

  /** What the person typed stays when the pool is read again: the amounts and the slippage. */
  const keepInputs = (next: JourneyState): JourneyState => ({ ...next, amounts: state.amounts, slippage: state.slippage })
  /** The planner found the pool has no price (rev2 §2.4 `position_plan_pool_not_initialized`): back to step 1, to set one. */
  const offerNewPool = () => {
    if (!state.pool) return
    open({ ...keepInputs(withPool(state, { ...state.pool, initialized: false, exists: state.pool.exists }, Date.now())), step: 'pool' })
  }
  /** Rev2 §2.6.5's race: the pool is read again through the wallet; on with the ordinary create on the pool that now exists. */
  const continueOnExisting = async () => {
    const pool = state.pool
    if (!pool || gate.mode !== 'live' || raceReading) return
    setRaceReading(true)
    try {
      const found = await inTurn(async () => (await connectJourney(chainId, gate.contracts)).zap.readPool(pool.pool))
      if (found.initialized) {
        const existing: JourneyPool = { ...pool, exists: found.exists, initialized: true, sqrtPriceX96: found.sqrtPriceX96, tick: found.tick, block: found.block, readAt: Date.now() }
        open({ ...keepInputs(withPool({ ...state, pool: null }, existing, Date.now())), step: 'range', furthest: 'range' })
      }
    } catch {
      // The read failed: the sentence already shown stands; the person can start again from step 1.
    } finally {
      setRaceReading(false)
    }
  }

  const checks: Record<JourneyStep, ReturnType<typeof canContinue>> = {
    pool: canContinue('pool', state),
    range: canContinue('pool', state).ok ? canContinue('range', state) : canContinue('pool', state),
    amount: canContinue('range', state).ok ? canContinue('amount', state) : canContinue('range', state),
    review: canContinue('review', state),
  }
  const check = checks[current]
  const first = current === 'pool'
  const blockedForPrice = (view.reviewed?.review.createsPool ?? false) && !confirmed
  const connected = identity.kind === 'connected'
  const footer = (
    <div className="dm-flow-foot" data-journey-footer="" data-final={current === 'review' ? '' : undefined} data-first={first ? '' : undefined}>
      {!first && (
        <Button type="button" variant="outline" size={current === 'review' ? 'md' : 'lg'} disabled={locked} hidden={view.receipt !== null} onClick={backward}>
          {CREATE.page.back}
        </Button>
      )}
      {current === 'review' ? (
        <FinalControl
          gate={gate}
          view={view}
          blockedForPrice={blockedForPrice}
          connected={connected}
          onRun={run.run}
          onCancelSignature={run.cancelSignature}
          onKeepSignature={run.keepSignature}
          onRejected={run.forgetUnsettled}
          onQuote={run.start}
        />
      ) : (
        <>
          <Button type="button" variant="primary" size="lg" disabled={!check.ok} aria-describedby={check.ok ? undefined : 'continue-reason'} onClick={forward} data-zap-continue={current}>
            {CREATE.page.next}
          </Button>
          <p id="continue-reason" role="status" className="dm-flow-reason">
            {check.ok ? '' : check.reason}
          </p>
        </>
      )}
    </div>
  )

  const bodyOf = (step: JourneyStep): ReactNode => {
    switch (step) {
      case 'pool':
        return (
          <PoolStage
            chainId={chainId}
            gate={gate}
            state={state}
            finderOnly={finderOnly}
            preselect={preselect}
            onPool={setPool}
            onStart={(start) => setState((was) => withStart(was, start, Date.now()))}
            onListed={onListed}
          />
        )
      case 'range':
        return <RangeStage state={state} price={price} onRange={(range) => setState((was) => withRange(was, range))} />
      case 'amount':
        return <AmountStage state={state} onAmounts={(amounts) => setState((was) => withAmounts(was, amounts))} onSlippage={(text) => setState((was) => withSlippage(was, text))} />
      case 'review':
        return (
          <ReviewStage
            state={state}
            gate={gate}
            view={view}
            price={price}
            confirmed={confirmed}
            onConfirmed={setConfirmed}
            onRejected={run.forgetUnsettled}
            onNewPool={offerNewPool}
            onPoolRace={() => void continueOnExisting()}
          />
        )
      default:
        return step satisfies never
    }
  }

  const summaryOf = (step: JourneyStep): ReactNode => {
    const pool = state.pool
    if (!pool) return null
    switch (step) {
      case 'pool':
        // The DEX as ./parts.tsx PoolChips says it: never its version; nothing at all for a v4 pool on Robinhood Chain.
        return [`${labelOf(book, pool.pool.currency0)} / ${labelOf(book, pool.pool.currency1)}`, v2Chain(chainId).name, ...(chainId === 4663 && pool.pool.dex === 4 ? [] : ['Uniswap']), feePercent(pool.pool.fee)].join(' · ')
      case 'range': {
        if (!state.range) return null
        const both = rangeBothWays(state.range.lower, state.range.upper, decimalsOf(book, pool.pool.currency0), decimalsOf(book, pool.pool.currency1))
        const low = priceText(both.forward.low)
        const high = priceText(both.forward.high)
        return low && high ? `1 ${labelOf(book, pool.pool.currency0)} = ${low} to ${high} ${labelOf(book, pool.pool.currency1)}` : CREATE.review.summary.rangeTicks(state.range.lower, state.range.upper)
      }
      case 'amount':
        return inputs.map((input) => amountText(book, input.token, input.amount)).join(' + ')
      case 'review':
        return null
      default:
        return step satisfies never
    }
  }

  const leadOf = (step: JourneyStep): string | undefined => {
    if (step === 'pool') return JOURNEY.step.poolLead
    if (step === 'amount') return state.amounts.mode === 'other' ? JOURNEY.step.amountLeadOther : JOURNEY.step.amountLead
    return undefined
  }

  // A step is done when it was reached, it and every step before it are complete, and the machine would open it again.
  const complete: Record<JourneyStep, boolean> = { pool: checks.pool.ok, range: checks.range.ok, amount: checks.amount.ok, review: false }
  const steps: StepView[] = VISUAL_STEPS.map((step, index) => {
    const isCurrent = step === current
    const done = !isCurrent && stepIndex(step) <= stepIndex(state.furthest) && VISUAL_STEPS.slice(0, index + 1).every((before) => complete[before]) && canOpen(step, state)
    return {
      key: step,
      state: isCurrent ? 'current' : done ? 'done' : 'upcoming',
      stage: STAGE_OF[step],
      summary: done ? summaryOf(step) : null,
      body: isCurrent ? bodyOf(step) : null,
      footer: isCurrent ? footer : null,
      lead: leadOf(step),
    }
  })

  return (
    <PageShell width="flow" className="dm-np" data-create-journey="" data-create-step={current} data-zap-journey={chainId} data-zap-gate={gate.mode}>
      <PageHeader size="display" title={CREATE.page.title} description={CREATE.page.description} className="dm-np-head dm-flow-rise" />
      <div className="dm-card dm-flow-card dm-flow-rise" style={{ '--delay': '40ms' } as CSSProperties}>
        <StepList steps={steps} onOpen={reopen} locked={locked} />
      </div>
      <PreviewPanel className="dm-card dm-flow-preview dm-flow-rise" style={{ '--delay': '80ms' } as CSSProperties} state={state} price={price} step={current} />
    </PageShell>
  )
}
