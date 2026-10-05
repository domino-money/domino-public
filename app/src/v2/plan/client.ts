/**
 * Asking the S1 plan service for a plan (spec F7 rev2 §2.4, `position-plan-v1` `1.0.0-rc.2`): the request written and
 * checked (./request.ts, then the package's `validateRequest`), sent through the transport, the answer read by the
 * package's validator and the app's own checks (./parse.ts). A transport that throws is `unavailable` (`network`);
 * nothing is retried here, and a plan is never made up: no answer, no plan.
 *
 * No route reaches the service yet (the Worker's /api/position-plan/v1/ is the bridge side's): the v2-test build's
 * screens use ./fixtureTransport.ts; ./httpTransport.ts is written for the route and wired nowhere.
 *
 * Pure: no viem, no wallet. The runtime is handed in (./contract.ts imports the package's, for src/v2ui only).
 */
import { parsePlanAnswer } from './parse'
import { planRequestWire } from './request'
import type { S1PlanContext, S1PlanRequest, S1PlanResult, S1PlanTransport, S1PlanValidators } from './types'

export async function requestS1Plan(
  transport: S1PlanTransport,
  runtime: S1PlanValidators,
  request: S1PlanRequest,
  context: Omit<S1PlanContext, 'now'>,
  now: () => number = () => Date.now() / 1000,
): Promise<S1PlanResult> {
  // A request the app would never send is a bug of the screen, said as `invalid` and never sent.
  let wire: Record<string, unknown>
  try {
    wire = planRequestWire(request)
  } catch (error) {
    return { kind: 'invalid', detail: error instanceof Error ? error.message : 'plan_request' }
  }
  if (!runtime.validateRequest('plan', wire)) return { kind: 'invalid', detail: 'plan_request_contract' }
  let answer: { status: number; body: unknown }
  try {
    answer = await transport.plan(structuredClone(wire))
  } catch {
    return { kind: 'unavailable', reason: 'network' }
  }
  // `now` is read when the answer is in: a plan that arrives at or after its expiresAt is never consented to.
  return parsePlanAnswer(answer, request, wire, { ...context, now: now() }, runtime)
}
