/**
 * The deposit service over same-origin HTTP. Node-tested only: nothing under
 * src imports this module in this phase, so no build carries a path to
 * /api/deposit/v1/*. Wiring it is part of the reviewed activation (consumer
 * acknowledgement, the R46b fix pinned, HTTPS staging, operator admission and
 * a reviewed wallet handoff).
 */
import type { Clock } from '../lib/clock'
import { fetchRaw, type FetchLike } from '../lib/http/rawReply'
import { DEPOSIT_HEADER, DEPOSIT_PREFIX, DEPOSIT_TIMEOUT_MS, MAX_RESPONSE_BYTES, type DepositTransport } from './transport'
import { DEPOSIT_CONTRACT } from './version'

export function createHttpDepositTransport({ fetch, clock }: { fetch: FetchLike; clock: Clock }): DepositTransport {
  return {
    kind: 'http',
    send(route, body, { csrf, signal }) {
      return fetchRaw(
        fetch,
        DEPOSIT_PREFIX + route,
        {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            [DEPOSIT_HEADER]: DEPOSIT_CONTRACT,
            'X-Domino-CSRF': csrf,
          },
          body,
        },
        { contractHeader: DEPOSIT_HEADER, maxBytes: MAX_RESPONSE_BYTES, timeoutMs: DEPOSIT_TIMEOUT_MS, signal, clock },
      )
    },
  }
}
