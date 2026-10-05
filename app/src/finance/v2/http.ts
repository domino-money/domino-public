/**
 * The page's same-origin HTTP for Domino V2's three API routes (Changed on purpose (data) 2026-10-02, Domino V2
 * integration, the base agent's item 5): the one reviewed place where V2's requests meet the page.
 *
 *   - read-v6 (spec F7 rev2 §6.2): POST /api/read/v6/portfolio and /api/read/v6/activity, public reads (the read
 *     Worker's, off until its flag), `X-Domino-Read-Contract: 1.0.0-rc.1` (src/v2/read/v6HttpTransport.ts);
 *   - position-plan-v1 (§2.4): POST /api/position-plan/v1/plan, the session cookie and its CSRF,
 *     `X-Domino-Position-Plan-Contract: 1.0.0-rc.2` (src/v2/plan/httpTransport.ts);
 *   - crosschain-v1 (§3.2; Changed on purpose (data) 2026-10-02 (S2 wired), open point #17): POST
 *     /api/crosschain/v1/origins, /quote and /status, the session cookie and its CSRF,
 *     `X-Domino-Crosschain-Contract: 1.0.0-rc.1` (src/v2/crosschain/httpTransport.ts), for the inline offer in New
 *     position's amount step (src/v2in/funds);
 *   - each route's capabilities GET (src/v2/routes.ts), which says whether the route is on.
 *
 * Every request goes through finance/http.ts `financialFetch` (the financial clients' same-origin fetch) and
 * lib/http/rawReply.ts's reading (REQUEST_INIT: same-origin mode and credentials, no redirect followed, no cache; a body
 * read within its bound, a page's own deadline). The plan's and the deposit's CSRF is lent by the page's one session
 * controller (wallet/session.ts `withSessionCsrf`), only while the session of the epoch asked is the signed-in one:
 * handed to the request and never kept, returned or stored. Without a signed-in session for the connected account
 * nothing is sent (`session_required`). A build that carries V2 keeps the session across Base and Arbitrum One
 * (session/machine.ts keptChains), so a plan is asked whichever of the three chains the wallet is on; the V1 consumers'
 * own view of the session (session/port.ts) stays Robinhood Chain's. A crosschain route's refusal of the session
 * (session_required, csrf_invalid, account_unsupported) goes to the page's one session port (session/livePort.ts
 * `reportDenial`), as the onboarding and deposit clients report theirs.
 *
 * Nothing here asks a wallet anything, signs or sends a transaction.
 */
import { realClock } from '../../lib/clock'
import { fetchRaw, rawReplyOf, REQUEST_INIT, type TransportResult } from '../../lib/http/rawReply'
import { NO_SESSION } from '../../session/controller'
import { livePort } from '../../session/livePort'
import { createHttpCrosschainTransport } from '../../v2/crosschain/httpTransport'
import type { CrosschainTransport } from '../../v2/crosschain/transport'
import type { CrosschainClock, CrosschainSession } from '../../v2/crosschain/types'
import { createSessionPlanTransport, type PlanSession, type RawPost } from '../../v2/plan/httpTransport'
import type { S1PlanTransport } from '../../v2/plan/types'
import type { ReadV6Transport } from '../../v2/read/v6'
import { createHttpReadV6Transport } from '../../v2/read/v6HttpTransport'
import { createV2RouteProbe, type RawGet, type V2RouteProbe } from '../../v2/routes'
import { sessionController } from '../../wallet/session'
import { financialFetch } from '../http'

/** One same-origin POST and its bounded reply (lib/http/rawReply.ts fetchRaw over the financial fetch). Never throws. */
export const v2Post: RawPost = (url, init, options) => fetchRaw(financialFetch, url, init, { ...options, clock: realClock })

/** One same-origin GET and its bounded reply, as fetchRaw reads a POST's: the page's deadline, the caller's abort. Never throws. */
export const v2Get: RawGet = async (path, options) => {
  const controller = new AbortController()
  let timedOut = false
  const cancelTimer = realClock.setTimer(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs)
  const onAbort = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener('abort', onAbort, { once: true })
  const interrupted = (): TransportResult => ({ kind: timedOut ? 'timeout' : options.signal?.aborted ? 'aborted' : 'network' })
  try {
    let response: Response
    try {
      response = await financialFetch(path, { ...REQUEST_INIT, method: 'GET', headers: options.headers, signal: controller.signal })
    } catch {
      return interrupted()
    }
    try {
      return { kind: 'reply', reply: await rawReplyOf(response, options.contractHeader, options.maxBytes) }
    } catch {
      return interrupted()
    }
  } finally {
    cancelTimer()
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/** A probe of the three routes' capabilities over the page's GET and clock (src/v2/routes.ts: a settled answer kept a minute). */
export function v2RouteProbe(): V2RouteProbe {
  return createV2RouteProbe({ get: v2Get, now: () => realClock.monoMs() })
}

/** The page's monotonic clock as the V2 clients take it (lib/clock realClock; src/v2in may not import lib/clock itself: tests/consumer.guard.test.mjs). */
export const liveClock: CrosschainClock = realClock

/** read-v6 over the site's own route (the caller asks the route's capabilities first: src/v2/routes.ts). */
export function liveReadV6Transport(): ReadV6Transport {
  return createHttpReadV6Transport({ post: v2Post })
}

/**
 * position-plan-v1 over the site's own route, with the signed-in session's CSRF, lent for this one request. Refused
 * unsent (`session_required`, which the plan client says as unavailable) when no session is signed in, or when the
 * session changed before the request could be made.
 */
export function livePlanTransport(): S1PlanTransport {
  return createSessionPlanTransport({ post: v2Post, session: LIVE_SESSION })
}

/**
 * The page's session (wallet/session.ts) as the plan transport takes it: signed in, for the connected account (the
 * session's owner), on any chain the session is kept across.
 */
const LIVE_SESSION: PlanSession = {
  csrfAccess: true,
  epoch() {
    const { view, identity, epoch } = sessionController.getSnapshot()
    if (view.status !== 'signed_in' || identity.kind !== 'connected') return null
    return identity.address.toLowerCase() === view.owner.toLowerCase() ? epoch : null
  },
  async withCsrf(epoch, fn) {
    const answer = await sessionController.withSessionCsrf(epoch, fn)
    return answer === NO_SESSION ? { ok: false } : { ok: true, value: answer }
  },
}

/** Read-only state for the inline bridge offer. No CSRF, signature or session mutation leaves this adapter. */
export const crosschainSessionAccess = {
  subscribe: sessionController.subscribe,
  getSnapshot(): string {
    const epoch = LIVE_SESSION.epoch()
    return epoch === null ? livePort.getSnapshot().kind : `ready:${epoch}`
  },
}

/**
 * crosschain-v1 over the site's own route (the S2 gate asks the route's capabilities first: src/v2/gate.ts over
 * src/v2/routes.ts). The CSRF is the client's to lend per request (`liveCrosschainSession`).
 */
export function liveCrosschainTransport(): CrosschainTransport {
  return createHttpCrosschainTransport({ post: v2Post })
}

/**
 * The page's session as the crosschain-v1 client takes it (src/v2/crosschain/types.ts CrosschainSession): the signed-in
 * session's CSRF lent for one request exactly as LIVE_SESSION lends it for a plan (`lent: false`, nothing sent, without
 * a signed-in session for the connected account or when it changed before the request could be made), and a route's
 * refusal of the session reported to the page's one session port under the epoch the CSRF was lent for, as the
 * onboarding and deposit clients report theirs (onboarding/routed.ts, deposit/flow.ts: `port.reportDenial(code, epoch)`):
 * session_required and csrf_invalid re-read the session, account_unsupported signs the tab out; a denial from a session
 * that has since changed is dropped by the port. One per client: the epoch lent is kept here, never the CSRF.
 */
export function liveCrosschainSession(): CrosschainSession {
  let lentEpoch: number | null = null
  return {
    async withCsrf(send) {
      const epoch = LIVE_SESSION.epoch()
      if (epoch === null) return { lent: false }
      lentEpoch = epoch
      const answer = await LIVE_SESSION.withCsrf(epoch, send)
      return answer.ok ? { lent: true, value: answer.value } : { lent: false }
    },
    reportDenial(code) {
      if (lentEpoch !== null) livePort.reportDenial(code, lentEpoch)
    },
  }
}
