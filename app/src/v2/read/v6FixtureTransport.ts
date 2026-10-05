/**
 * Scripted read-v6 answers (./v6.ts), for the node tests and the v2-test build's screens until the Worker route
 * exists (spec F7 rev2 §6.2). The screens script the package's own fixtures (api-contracts/read-v6/fixtures/valid),
 * so what they draw is what the contract allows. A read nobody scripted is recorded and refused (it throws, which the
 * client says as `unavailable`, `network`). Every answer is TEST DATA: no deployable build imports this module.
 */
import type { ReadV6Route } from 'api-contracts/read-v6/types'
import type { ReadV6Transport } from './v6'

export interface ReadV6FixtureTransport extends ReadV6Transport {
  readonly kind: 'fixture'
  /** The answer for every read of `route` from now on (the last one scripted wins). */
  script(route: ReadV6Route, status: number, body: unknown): void
  calls(): readonly { route: ReadV6Route; body: unknown }[]
  unscripted(): readonly ReadV6Route[]
}

export function createReadV6FixtureTransport(): ReadV6FixtureTransport {
  const answers = new Map<ReadV6Route, { status: number; body: unknown }>()
  const log: { route: ReadV6Route; body: unknown }[] = []
  const refused: ReadV6Route[] = []
  return {
    kind: 'fixture',
    async post(route, body) {
      log.push({ route, body: structuredClone(body) })
      const answer = answers.get(route)
      if (!answer) {
        refused.push(route)
        throw new Error(`no read-v6 answer scripted for ${route}`)
      }
      return { status: answer.status, body: structuredClone(answer.body) }
    },
    script(route, status, body) {
      answers.set(route, { status, body: structuredClone(body) })
    },
    calls: () => log,
    unscripted: () => refused,
  }
}
