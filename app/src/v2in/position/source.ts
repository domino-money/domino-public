/**
 * Where the position page's Domino V2 data comes from (Domino V2 integration, 2026-10-02): the integrated screens' one
 * place for it, src/v2in/transports.ts.
 *
 *   - `live` and `preview` alike: read-v6 over the site's own route, asked only while its capabilities say it serves
 *     (otherwise `unavailable` with the route's reason: a dash, never test data; Changed on purpose (data) 2026-10-02,
 *     the owner: real data only); the plan API over its route, with the signed-in session's CSRF (without one nothing is
 *     sent, and the page asks to sign in: `session_required`), under `live` only: under `preview` no plan is asked at
 *     all (the dialog stops at what the person chose, with the gate's sentence);
 *   - a test build's suite scripts both through `window.__dominoV2Test` (`read6`, `plan`), as src/v2in/transports.ts says.
 */
import type { ActivityResponse, PortfolioResponse } from 'api-contracts/read-v6/types'
import { requestS1Plan } from '../../v2/plan/client'
import type { S1PlanContext, S1PlanRequest, S1PlanResult, S1PlanTransport } from '../../v2/plan/types'
import { readActivity, readPortfolio, type ReadV6Reply } from '../../v2/read/v6'
import { routeServes, type V2RouteState } from '../../v2/routes'
import { v2Transports } from '../transports'
import type { OpenGate } from './wallet'

/** A read-v6 answer as the page draws it: read-v6's own, or a route that does not serve now (its reason). */
export type V6Read<T> = Exclude<ReadV6Reply<T>, { kind: 'unavailable' }> | { kind: 'unavailable'; reason: string }

/** Why a route does not serve now, in a `data-` attribute's words. */
const offReason = (state: V2RouteState): string => (state.on ? 'route_off' : `route_${state.reason}`)

/** The plan for `request` under `live`, held to the connected wallet, the chain's zaps and the profile's addresses. */
export async function askLivePlan(gate: OpenGate, request: S1PlanRequest, context: Omit<S1PlanContext, 'now'>): Promise<S1PlanResult> {
  const transports = v2Transports(gate)
  if (!transports || transports.mode !== 'live') return { kind: 'unavailable', reason: 'gate_not_live' }
  const state = await transports.routeState('plan')
  if (!routeServes(state, 'plan')) return { kind: 'unavailable', reason: offReason(state) }
  // The plan route takes the signed-in session's CSRF: without a session nothing is sent (the transport refuses it as
  // `session_required`, which the plan client reads as unavailable). Said as what it is: sign in first.
  let signedOut = false
  const watched: S1PlanTransport = {
    kind: transports.plan.kind,
    async plan(wire) {
      try {
        return await transports.plan.plan(wire)
      } catch (error) {
        if (error instanceof Error && error.message === 'session_required') signedOut = true
        throw error
      }
    },
  }
  const result = await requestS1Plan(watched, transports.planRuntime, request, context)
  return result.kind === 'unavailable' && signedOut ? { kind: 'refused', code: 'session_required', status: 401 } : result
}

export interface PortfolioRead {
  reply: V6Read<PortfolioResponse>
  /** The wallet the answer is about: the connected one. */
  wallet: string
}

/** The wallet's read-v6 portfolio, from the site's route (a route that is off: unavailable, with its reason). */
export async function portfolioFor(gate: OpenGate, wallet: string): Promise<PortfolioRead> {
  const transports = v2Transports(gate)
  const asked = wallet.toLowerCase()
  if (!transports) return { reply: { kind: 'unavailable', reason: 'gate_off' }, wallet: asked }
  const state = await transports.routeState('readV6')
  if (!routeServes(state, 'portfolio')) return { reply: { kind: 'unavailable', reason: offReason(state) }, wallet: asked }
  return { reply: await readPortfolio(transports.read, transports.readRuntime, asked), wallet: asked }
}

/** The wallet's read-v6 activity, from the site's route (a route that is off: unavailable, with its reason). */
export async function activityFor(gate: OpenGate, wallet: string): Promise<V6Read<ActivityResponse>> {
  const transports = v2Transports(gate)
  if (!transports) return { kind: 'unavailable', reason: 'gate_off' }
  const state = await transports.routeState('readV6')
  if (!routeServes(state, 'activity')) return { kind: 'unavailable', reason: offReason(state) }
  return readActivity(transports.read, transports.readRuntime, wallet.toLowerCase(), { limit: 20 })
}
