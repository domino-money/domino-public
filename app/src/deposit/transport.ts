/**
 * How a deposit request leaves the page. Two kinds exist:
 *
 *   fixture  scripted replies from the package fixtures, for the consumer-test
 *            lab and the node tests. Nothing leaves the page.
 *   http     same-origin POSTs to /api/deposit/v1/*. Built and node-tested
 *            only; no module under src imports it in this phase
 *            (tests/consumer.guard.test.mjs checks that), so no build can
 *            contact the deposit service.
 *
 * The kind matters beyond transport: a wallet step (prepare) may be issued
 * only over the fixture transport or with a real wallet handoff, which does
 * not exist (flow.ts, handoff.ts).
 */
import type { TransportResult } from '../lib/http/rawReply'
import type { DepositRoute } from './types'

export const DEPOSIT_PREFIX = '/api/deposit/v1/'
export const DEPOSIT_HEADER = 'X-Domino-Deposit-Contract'
/** Just above the service's shared deadline, so its own 504 is what is seen. */
export const DEPOSIT_TIMEOUT_MS = 27_000
export const MAX_REQUEST_BYTES = 8192
/** The producer's own ceiling: deposit_models.MAX_RESPONSE = 262144. */
export const MAX_RESPONSE_BYTES = 256 * 1024

export interface DepositTransport {
  readonly kind: 'fixture' | 'http'
  send(route: DepositRoute, body: string, options: { csrf: string; signal?: AbortSignal }): Promise<TransportResult>
}
