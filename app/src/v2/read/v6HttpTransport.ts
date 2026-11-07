/**
 * `read-v6` over same-origin HTTP (spec F7 rev2 §6.2; Domino V2 integration, 2026-10-02, the base agent's item 5):
 * `POST /api/read/v6/portfolio` and `POST /api/read/v6/activity`, a JSON body, `X-Domino-Read-Contract: 1.1.0-rc.1`.
 * The read Worker's own route (bridge/src/worker.mjs, off until its flag: src/v2/routes.ts says whether it is on).
 *
 * The POST itself is injected, as ./../plan/httpTransport.ts takes its own: lib/http/rawReply.ts's `fetchRaw` over the
 * page's financial fetch (src/finance/v2/http.ts), which sends with `mode: 'same-origin'`, `credentials: 'same-origin'`
 * and `redirect: 'manual'`, and reads a bounded body. A reply without the contract's header did not come from the read
 * route (the beta gate, the SPA's fallback, a route that is not deployed): its body is never read as the contract's, and
 * the exchange is refused as a transport failure, which ./v6.ts says as `unavailable` (a dash, never a zero).
 *
 * Added 2026-11-04: `position-fees` is asked in read-v6 1.2.0-rc.1, and an answer may carry either version (./v6.ts).
 *
 * Pure: no fetch, no wallet, no storage of its own.
 */
import type { ReadV6NextRoute } from 'api-contracts/read-v6/types'
import type { RawPost } from '../plan/httpTransport'
import { READ_V6_ANSWER_VERSIONS, READ_V6_CONTRACT_VERSION, READ_V6_HEADER, READ_V6_NEXT_CONTRACT_VERSION, type ReadV6Transport } from './v6'

/** Each route's path, on the site's own origin. */
export const READ_V6_PATHS: Readonly<Record<ReadV6NextRoute, string>> = Object.freeze({
  portfolio: '/api/read/v6/portfolio',
  activity: '/api/read/v6/activity',
  'chain-pools': '/api/read/v6/chain-pools',
  'chain-balances': '/api/read/v6/chain-balances',
  'chain-tokens': '/api/read/v6/chain-tokens',
  'position-fees': '/api/read/v6/position-fees',
})

/** The read Worker's limits (bridge/src/worker.mjs LIMITS): an 8 KiB request, a 1 MiB answer, 20 s; the page waits a little longer. */
export const READ_V6_MAX_REQUEST_BYTES = 8 * 1024
export const READ_V6_MAX_RESPONSE_BYTES = 1024 * 1024
export const READ_V6_TIMEOUT_MS = 22_000

const JSON_MEDIA = /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i

/** Why an exchange gave no contract answer (a thrown Error's message; ./v6.ts says each as `unavailable`). */
export type ReadV6TransportFailure = 'network' | 'timeout' | 'aborted' | 'not_the_route' | 'request_too_large'

export function createHttpReadV6Transport({ post }: { post: RawPost }): ReadV6Transport {
  return {
    kind: 'http',
    async post(route, request) {
      const path = READ_V6_PATHS[route]
      if (path === undefined) throw new Error('not_the_route')
      const body = JSON.stringify(request)
      if (new TextEncoder().encode(body).length > READ_V6_MAX_REQUEST_BYTES) throw new Error('request_too_large')
      const result = await post(
        path,
        { headers: { 'Content-Type': 'application/json', Accept: 'application/json', [READ_V6_HEADER]: route === 'position-fees' ? READ_V6_NEXT_CONTRACT_VERSION : READ_V6_CONTRACT_VERSION }, body },
        { contractHeader: READ_V6_HEADER, maxBytes: READ_V6_MAX_RESPONSE_BYTES, timeoutMs: READ_V6_TIMEOUT_MS },
      )
      if (result.kind !== 'reply') throw new Error(result.kind)
      const reply = result.reply
      // Not the read route's answer: nothing in it is the contract's.
      if (reply.opaqueRedirect || reply.contractHeader === null || !READ_V6_ANSWER_VERSIONS.includes(reply.contractHeader)) throw new Error('not_the_route')
      // Added 2026-10-06 (rugged's answer of 6 Oct, §1): a refusal's Retry-After, as sent, for ./v6.ts to keep on a 429.
      const wait = reply.status !== 200 && reply.retryAfterHeader !== null ? { retryAfter: reply.retryAfterHeader } : {}
      // The route's own answer, but not JSON it could have sent (or too large to read): no body, which ./v6.ts refuses as
      // `invalid` (the contract broke), never as data.
      if (reply.contentType === null || !JSON_MEDIA.test(reply.contentType) || reply.body.kind !== 'text') return { status: reply.status, body: undefined, ...wait }
      try {
        return { status: reply.status, body: JSON.parse(reply.body.text) as unknown, ...wait }
      } catch {
        return { status: reply.status, body: undefined, ...wait }
      }
    },
  }
}
