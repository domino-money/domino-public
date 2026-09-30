/** Authenticated route lookup, loaded only inside the existing financial chunk. */
import { realClock } from '../lib/clock'
import { broadcastBudgetChannel, createPreviewBudget } from '../onboarding/budget'
import { createOnboardingClient } from '../onboarding/client'
import { ONBOARDING_RUNTIME } from '../onboarding/contract'
import { requestSwapRoute, type SwapRouteResult } from '../onboarding/routed'
import type { SwapRouteRequest } from '../onboarding/types'
import { livePort } from '../session/livePort'
import { sessionKey } from '../session/port'
import { financialFetch } from './http'

export type RouteQuote = Extract<SwapRouteResult, { ok: true }>
export type { SwapRouteRequest } from '../onboarding/types'
const budget = createPreviewBudget({ clock: realClock, channel: broadcastBudgetChannel() })
let connected = false
const client = createOnboardingClient({ fetch: financialFetch, runtime: ONBOARDING_RUNTIME, clock: realClock })

export const validateRoute = (body: unknown) => ONBOARDING_RUNTIME.validateResponse('swap-route', body)
export function routeCurrent(quote: RouteQuote): boolean {
  return quote.deadlineMono > realClock.monoMs() && quote.sessionKey === sessionKey(livePort.getSnapshot())
}

export async function lookupRoute(request: SwapRouteRequest, owner: string, signal: AbortSignal): Promise<SwapRouteResult> {
  if (!connected) { budget.connect(); connected = true }
  return requestSwapRoute({ client, port: livePort, clock: realClock, budget }, request, { owner, signal })
}
