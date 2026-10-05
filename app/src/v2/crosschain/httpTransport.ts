/**
 * crosschain-v1 over same-origin HTTP, in deposit/httpTransport.ts's shape. Changed on purpose (data) 2026-10-02 (S2
 * wired): imported by src/finance/v2/http.ts alone (`liveCrosschainTransport`), for the inline offer in New position's
 * amount step (src/v2in/funds), under a gate the crosschain route's own capabilities open (src/v2/gate.ts); the forwarder
 * has its /api/crosschain/v1/ family (functions/_lib/bridge.ts) and the Worker exists (bridge/src/crosschain-worker.mjs).
 * Until the Worker is deployed and bound, a request ends at the forwarder's 404 not_found, which the client reads as
 * `not_deployed`.
 *
 * The POST itself is injected: src/finance/v2/http.ts passes lib/http/rawReply.ts's `fetchRaw` bound to the page's fetch
 * and clock, `(url, init, options) => fetchRaw(fetch, url, init, { ...options, clock })`, which sends with
 * `mode: 'same-origin'`, `credentials: 'same-origin'` (the session cookie is the browser's business) and
 * `redirect: 'manual'`, and reads a bounded body. This file only fixes the URL and the headers. Sending a request never
 * sends a wallet transaction.
 */
import { CROSSCHAIN_PREFIX, CROSSCHAIN_TIMEOUT_MS, CSRF_HEADER, MAX_RESPONSE_BYTES, type CrosschainTransport, type TransportResult } from './transport'
import { CROSSCHAIN_CONTRACT, CROSSCHAIN_HEADER } from './version'

/** lib/http/rawReply.ts `fetchRaw` without its fetch and clock arguments. */
export type RawPost = (
  url: string,
  init: { headers: Record<string, string>; body: string },
  options: { contractHeader: string; maxBytes: number; timeoutMs: number; signal?: AbortSignal },
) => Promise<TransportResult>

export function createHttpCrosschainTransport({ post }: { post: RawPost }): CrosschainTransport {
  return {
    kind: 'http',
    send(route, body, { csrf, signal }) {
      return post(
        CROSSCHAIN_PREFIX + route,
        {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            [CROSSCHAIN_HEADER]: CROSSCHAIN_CONTRACT,
            [CSRF_HEADER]: csrf,
          },
          body,
        },
        { contractHeader: CROSSCHAIN_HEADER, maxBytes: MAX_RESPONSE_BYTES, timeoutMs: CROSSCHAIN_TIMEOUT_MS, signal },
      )
    },
  }
}
