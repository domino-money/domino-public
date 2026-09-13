/**
 * Scripted deposit replies, for the consumer-test lab and the node tests.
 *
 * Each route has a queue of replies; a call takes the next one. A call nobody
 * scripted is recorded and refused, so a flow that sends something unexpected
 * (a second prepare, a create) fails its test instead of passing quietly.
 * Every call is logged with its body, for the tests and the lab's request log,
 * and with whether it carried the CSRF the transport expects: a CSRF is only
 * ever compared in memory, so the log never holds one (rugged97 on #14).
 * Replies carry the pinned contract header unless a scenario says otherwise.
 */
import type { RawReply, TransportResult } from '../lib/http/rawReply'
import type { DepositTransport } from './transport'
import type { DepositRoute } from './types'
import { DEPOSIT_CONTRACT } from './version'

export interface ScriptedReply {
  status: number
  /** A string is sent byte for byte (a package fixture's raw text); anything else is JSON-encoded. */
  body: unknown
  /** The contract header; null leaves it out. Defaults to the pinned version. */
  contract?: string | null
  contentType?: string | null
  retryAfter?: string
  opaqueRedirect?: boolean
  /** Instead of a reply: the network failed, or this page's deadline passed. */
  outcome?: 'network' | 'timeout'
}

export interface FixtureCall {
  route: DepositRoute
  body: unknown
  /** Whether the call carried the expected CSRF, compared with === on arrival. Never the CSRF itself. */
  csrfMatched: boolean
}

export class UnscriptedCallError extends Error {
  constructor(route: DepositRoute) {
    super(`No reply is scripted for ${route}`)
    this.name = 'UnscriptedCallError'
  }
}

export interface FixtureTransport extends DepositTransport {
  readonly kind: 'fixture'
  script(route: DepositRoute, ...replies: ScriptedReply[]): void
  calls(route?: DepositRoute): readonly FixtureCall[]
  /** Calls that found no scripted reply. Any entry is a test failure. */
  unscripted(): readonly DepositRoute[]
  remaining(route: DepositRoute): number
  reset(): void
}

export const reply = (status: number, body: unknown, extra: Omit<ScriptedReply, 'status' | 'body'> = {}): ScriptedReply => ({ status, body, ...extra })

function toRawReply(scripted: ScriptedReply): RawReply {
  const text = typeof scripted.body === 'string' ? scripted.body : JSON.stringify(scripted.body)
  return {
    status: scripted.status,
    opaqueRedirect: scripted.opaqueRedirect ?? false,
    contentType: scripted.contentType === undefined ? 'application/json; charset=utf-8' : scripted.contentType,
    contractHeader: scripted.contract === undefined ? DEPOSIT_CONTRACT : scripted.contract,
    requestIdHeader: null,
    retryAfterHeader: scripted.retryAfter ?? (scripted.status === 429 ? '60' : null),
    body: { kind: 'text', text },
  }
}

/** `csrf` is the one the session in front of it lends (the lab's FIXTURE_CSRF). */
export function createFixtureTransport({ csrf: expected }: { csrf: string }): FixtureTransport {
  const queues = new Map<DepositRoute, ScriptedReply[]>()
  let log: FixtureCall[] = []
  let refused: DepositRoute[] = []
  return {
    kind: 'fixture',
    async send(route, body, { csrf, signal }): Promise<TransportResult> {
      let parsed: unknown = null
      try {
        parsed = JSON.parse(body)
      } catch {
        parsed = body
      }
      log.push({ route, body: parsed, csrfMatched: csrf === expected })
      const next = queues.get(route)?.shift()
      if (!next) {
        refused.push(route)
        throw new UnscriptedCallError(route)
      }
      if (signal?.aborted) return { kind: 'aborted' }
      if (next.outcome) return { kind: next.outcome }
      return { kind: 'reply', reply: toRawReply(next) }
    },
    script(route, ...replies) {
      queues.set(route, [...(queues.get(route) ?? []), ...replies])
    },
    calls: (route) => (route ? log.filter((call) => call.route === route) : log),
    unscripted: () => refused,
    remaining: (route) => queues.get(route)?.length ?? 0,
    reset() {
      queues.clear()
      log = []
      refused = []
    },
  }
}
