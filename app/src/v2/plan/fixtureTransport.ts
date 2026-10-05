/**
 * Scripted `position-plan-v1` answers (./client.ts), for the node tests and the v2-test build's screens until the
 * Worker route exists (spec F7 rev2 §2.4, §7.5: the package's own fixtures, and planners that build valid answers with
 * its runtime). A responder answers each request (the request's wire form in, `{ status, body }` out, or a body alone
 * for a 200); a request it does not answer (undefined), or any request when none is scripted, is recorded and refused
 * (it throws, which the client says as `unavailable`), so a screen never sees a plan nobody scripted. Every answer is
 * TEST DATA: no deployable build imports this module (only src/v2ui and tests do).
 */
import type { S1PlanTransport } from './types'

export type S1PlanResponder = (request: Record<string, unknown>) => unknown | Promise<unknown>

export interface S1PlanFixtureTransport extends S1PlanTransport {
  readonly kind: 'fixture'
  /** The responder for every request from now on (the last one scripted wins); undefined from it means "not scripted". */
  script(responder: S1PlanResponder): void
  calls(): readonly Record<string, unknown>[]
  unscripted(): readonly Record<string, unknown>[]
}

/** `{ status, body }` as scripted, or a bare body as a 200. */
const isExchange = (value: unknown): value is { status: number; body: unknown } =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 2 && typeof (value as { status?: unknown }).status === 'number' && 'body' in value

export function createS1PlanFixtureTransport(responder?: S1PlanResponder): S1PlanFixtureTransport {
  let answer: S1PlanResponder | null = responder ?? null
  const log: Record<string, unknown>[] = []
  const refused: Record<string, unknown>[] = []
  return {
    kind: 'fixture',
    async plan(request) {
      const copy = structuredClone(request)
      log.push(copy)
      const reply = answer ? await answer(structuredClone(copy)) : undefined
      if (reply === undefined) {
        refused.push(copy)
        throw new Error(`no plan scripted for ${String(copy.action)} on ${String(copy.chainId)}`)
      }
      const exchange = isExchange(reply) ? reply : { status: 200, body: reply }
      return structuredClone(exchange)
    },
    script(next) {
      answer = next
    },
    calls: () => log,
    unscripted: () => refused,
  }
}
