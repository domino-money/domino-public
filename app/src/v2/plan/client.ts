/**
 * Asking the S1 plan service for a plan (spec F7 rev2 §2.4, `position-plan-v1` `1.0.0-rc.2`): the request written and
 * checked (./request.ts, then the package's `validateRequest`), sent through the transport, the answer read by the
 * package's validator and the app's own checks (./parse.ts). A transport that throws is `unavailable` (`network`);
 * nothing is retried here, and a plan is never made up: no answer, no plan. Changed on purpose 2026-10-30 (QA round 2,
 * INST-2): `signal` stops a request nobody waits for any more (`aborted`), and a transport's own deadline is said as
 * `timeout` (it was `network`), so the screen can ask again sooner after one.
 *
 * No route reaches the service yet (the Worker's /api/position-plan/v1/ is the bridge side's): the v2-test build's
 * screens use ./fixtureTransport.ts; ./httpTransport.ts is written for the route and wired nowhere.
 *
 * Pure: no viem, no wallet. The runtime is handed in (./contract.ts imports the package's, for src/v2ui only).
 *
 * Changed on purpose 2026-11-06 (Elysium readiness; rugged97's #459): a request about a Uniswap version its chain lacks
 * (v3 on a chain with v4 alone) is never sent. The service refuses such a request with its own `invalid_request`; the
 * app gives that same refusal itself, without asking, and the screens say it as "not available on this network"
 * (v2in/journey/errors.ts and v2in/position/errors.ts planFailure, with the request's version): no fault, no new
 * words, never asked again.
 */
import { chainHasDex, isV2ChainId } from '../chains'
import { parsePlanAnswer } from './parse'
import { planRequestWire } from './request'
import type { S1PlanContext, S1PlanRequest, S1PlanResult, S1PlanTransport, S1PlanValidators } from './types'

/** The Uniswap version a plan request is about: its pool's (create) or its position's (the other actions). */
export const planDex = (request: Pick<S1PlanRequest, 'pool' | 'position'>): number | undefined => request.pool?.dex ?? request.position?.dex

/**
 * Whether `dex` is a Uniswap version (3 or 4) that a chain V2 serves does not have: v3 on a chain with v4 alone. False for
 * anything else, so a version that does not exist (a screen's bug) or a chain V2 does not serve stays the request's own
 * fault (`invalid`), never "not available" (changed on purpose 2026-11-06, review F5: it was any version the chain lacks).
 */
export const versionOffChain = (chainId: number, dex: unknown): boolean => (dex === 3 || dex === 4) && isV2ChainId(chainId) && !chainHasDex(chainId, dex)

/** Whether a plan request is about a version its chain lacks (v3 on a chain with v4 alone): never sent. */
export const planOffNetwork = (request: Pick<S1PlanRequest, 'chainId' | 'pool' | 'position'>): boolean => versionOffChain(request.chainId, planDex(request))

export async function requestS1Plan(
  transport: S1PlanTransport,
  runtime: S1PlanValidators,
  request: S1PlanRequest,
  context: Omit<S1PlanContext, 'now'>,
  now: () => number = () => Date.now() / 1000,
  signal?: AbortSignal,
): Promise<S1PlanResult> {
  // The service's own refusal of a version the chain lacks, given here without asking it (see the module's comment).
  if (planOffNetwork(request)) return { kind: 'refused', code: 'invalid_request', status: runtime.ERROR_STATUS_BY_CODE.invalid_request ?? 400 }
  // A request the app would never send is a bug of the screen, said as `invalid` and never sent.
  let wire: Record<string, unknown>
  try {
    wire = planRequestWire(request)
  } catch (error) {
    return { kind: 'invalid', detail: error instanceof Error ? error.message : 'plan_request' }
  }
  if (!runtime.validateRequest('plan', wire)) return { kind: 'invalid', detail: 'plan_request_contract' }
  let answer: { status: number; body: unknown; retryAfterSeconds?: number }
  if (signal?.aborted) return { kind: 'unavailable', reason: 'aborted' }
  try {
    answer = await transport.plan(structuredClone(wire), signal)
  } catch (error) {
    if (signal?.aborted) return { kind: 'unavailable', reason: 'aborted' }
    return { kind: 'unavailable', reason: error instanceof Error && error.message === 'timeout' ? 'timeout' : 'network' }
  }
  if (signal?.aborted) return { kind: 'unavailable', reason: 'aborted' }
  // `now` is read when the answer is in: a plan that arrives at or after its expiresAt is never consented to.
  const result = parsePlanAnswer(answer, request, wire, { ...context, now: now() }, runtime)
  return (result.kind === 'refused' || result.kind === 'unavailable') && answer.retryAfterSeconds !== undefined
    ? { ...result, retryAfterSeconds: answer.retryAfterSeconds }
    : result
}
