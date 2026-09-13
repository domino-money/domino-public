/**
 * The deposit service over same-origin HTTP, loaded with the optional Setup
 * screen. Requests use the authenticated session and CSRF contract; preparing
 * an intent never sends a wallet transaction. The wallet handoff separately
 * verifies the current release and requires the owner's transaction review.
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
