import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { financialFetch } from '../../finance/http'
import { realClock } from '../../lib/clock'
import { CREATE } from '../../lib/create/copy'
import { previewRequest, type JourneyState } from '../../lib/create/journey'
import type { PairBalancesState } from './usePairBalances'
import { positionAmounts, type AmountCell as EstimateCell } from '../../onboarding/amounts'
import { broadcastBudgetChannel, createPreviewBudget } from '../../onboarding/budget'
import { createOnboardingClient } from '../../onboarding/client'
import { ONBOARDING_RUNTIME } from '../../onboarding/contract'
import { createPreviewController } from '../../onboarding/controller'
import { createIntentDriver, formFromRequest, type IntentView } from '../../onboarding/intent'
import { livePort } from '../../session/livePort'
import { AmountsSection, type AmountCell, type AmountsShown } from './StageBalance'

/**
 * Review's deposit amounts and its way on to Setup, in builds with wallet
 * sign-in. Its own chunk (StageBalance.tsx and StageReview.tsx load it
 * lazily), so the entry never carries the session or the onboarding client.
 *
 * The amounts are onboarding-v1's position preview for exactly the request
 * the journey forms (journey.ts previewRequest), asked for a signed-in wallet
 * when Review opens, when its request changes, or when a sign-in finishes
 * while it is open (onboarding/intent.ts). Never on a timer: a preview is
 * current for 30 seconds, then its figures go back to a dash until the person
 * opens Review again. Everything about it lives in this component's memory
 * and goes with it.
 */

const timeText = (wallMs: number | null) => (wallMs === null ? '' : new Date(wallMs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }))

const shownCell = (cell: EstimateCell): AmountCell => (cell.kind === 'amount' ? { text: cell.text, units: cell.units } : null)

function shownFrom(view: IntentView<'position-preview'>, state: JourneyState): AmountsShown {
  const titles = CREATE.balance.titles
  const quiet = { status: view.status, reason: view.reason, figures: null, checks: null, short: [] }
  switch (view.status) {
    case 'current': {
      const pool = state.pool
      if (!view.preview || !pool) return { ...quiet, status: 'loading', title: titles.loading }
      const amounts = positionAmounts(view.preview, [pool.currencies[0].decimals, pool.currencies[1].decimals])
      return {
        ...quiet,
        figures: { expected: amounts.expected.map(shownCell), maximum: amounts.maximum.map(shownCell), unspent: amounts.unspent.map(shownCell), liquidity: amounts.liquidity },
        title: titles.current(timeText(view.currentUntilWallMs)),
        checks: amounts.checks,
        short: amounts.short,
      }
    }
    case 'expired':
      return { ...quiet, title: titles.expired(timeText(view.expiredAtWallMs)) }
    case 'signed-out':
      return { ...quiet, title: titles.signedOut }
    case 'loading':
      return { ...quiet, title: titles.loading }
    case 'unavailable':
      return { ...quiet, title: titles.unavailable }
    case 'off':
      return { ...quiet, title: titles.off }
    default:
      return view.status satisfies never
  }
}

export default function DepositAmounts({ state, open, balances }: { state: JourneyState; open: boolean; balances: PairBalancesState }) {
  // One client, budget, controller and intent per mounted Review. The budget hears other tabs only while mounted.
  const deps = useMemo(() => {
    const budget = createPreviewBudget({ clock: realClock, channel: broadcastBudgetChannel() })
    const client = createOnboardingClient({ fetch: financialFetch, runtime: ONBOARDING_RUNTIME, clock: realClock })
    const controller = createPreviewController('position-preview', { client, port: livePort, clock: realClock, budget })
    return { budget, driver: createIntentDriver({ controller, port: livePort, clock: realClock }) }
  }, [])
  useEffect(() => deps.budget.connect(), [deps])
  useEffect(() => deps.driver.start(), [deps])
  // `budgets` are the connected wallet's balances of this pool's two
  // currencies, read once by the journey as soon as the pool was chosen
  // (create/usePairBalances.ts), so they are part of the request from its
  // first form rather than a second ask later. They are what let the service
  // report that the wallet does not cover the currency the person did not
  // choose. A wallet that is not connected, or a balance that could not be
  // read, adds no field, and the request is then exactly what it was before.
  // Until that read has settled, no estimate is asked: the balances are part
  // of the request, so asking without them and again with them would be two
  // estimates for one opening. The wait is short — the read starts when the
  // pool is chosen, stages before this one — and the rows say "loading"
  // meanwhile, which is what they are.
  const waiting = balances.status === 'loading'
  const formed = previewRequest(state, balances.budgets)
  const request = waiting || !formed.ok ? null : formed.request
  const why = waiting ? CREATE.balance.balances : formed.ok ? '' : formed.reason
  // The driver compares requests by their key, so handing it the same request again changes nothing.
  useEffect(() => {
    deps.driver.setForm(formFromRequest('position-preview', request, why))
  })
  useEffect(() => {
    deps.driver.setOpen(open)
  }, [deps, open])
  const view = useSyncExternalStore(deps.driver.subscribe, deps.driver.getView)
  const shown = shownFrom(view, state)
  return <AmountsSection state={state} shown={waiting ? { ...shown, status: 'loading', reason: null, figures: null, title: CREATE.balance.titles.loading } : shown} />
}

/* ---------------------------------------------------------------------------
   Create position
--------------------------------------------------------------------------- */

/** Review's last control, from this same chunk so the entry never carries the wallet or the setup client. */
export { default as CreatePosition } from './CreatePosition'
