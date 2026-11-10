/**
 * The Points page's points-v1 exchanges, bound to the page (added 2026-11-07, the owner's Points page, Season 1;
 * rugged97's spec of 7 Nov, "No app" 1 to 6): the one reviewed place where the page's points requests and the referral
 * signature meet the session and the wallet.
 *
 *   - Requests go through finance/http.ts `financialFetch` and lib/http/rawReply.ts's reading (same-origin, no redirect
 *     followed, no cache, a bounded body, the page's own deadline), as finance/v2/http.ts sends the plan's.
 *   - The CSRF is lent by the page's one session controller for one request, only while the session of the epoch asked
 *     is still the signed-in one, for the connected account (on Robinhood Chain, or held on another network the session
 *     is kept across: finance/v2/http.ts LIVE_SESSION's rule), and never kept. Without one, nothing is sent.
 *   - A refusal of the session (session_required, csrf_invalid, account_unsupported) goes to the page's one session port
 *     (session/livePort.ts reportDenial), as the other private clients report theirs.
 *   - The referral link's signature: points-v1's referralText for the season the service named, the signed-in wallet,
 *     the stored referrer and the time it is asked, signed as a message by the connected wallet (wallet/port.ts
 *     signLoginMessage, the same signer and method as the sign-in's message) right before the POST, and only when the person pressed Link referrer
 *     (screens/Points.tsx is the only caller). Nothing here sends a transaction.
 */
import { CONTRACT_VERSION, referralText, validateError, validateRequest, validateResponse } from 'api-contracts/points-v1/runtime.mjs'
import type { LinkResponse, PointsResponse } from 'api-contracts/points-v1/types'
import { realClock } from '../lib/clock'
import { fetchRaw, rawReplyOf, REQUEST_INIT, type TransportResult } from '../lib/http/rawReply'
import { askCapabilities, askLink, askPoints, type Exchange, type PointsService, type RawGet, type RawPost } from '../points/transport'
import { NO_SESSION } from '../session/controller'
import { livePort } from '../session/livePort'
import type { DenialCode } from '../session/port'
import { signLoginMessage } from '../wallet/port'
import { sessionController } from '../wallet/session'
import { financialFetch } from './http'

export type { LinkResponse, PointsResponse, PointsService }

const runtime = { CONTRACT_VERSION, validateRequest, validateResponse, validateError }

const post: RawPost = (url, init, options) => fetchRaw(financialFetch, url, init, { ...options, clock: realClock })

const get: RawGet = async (url, options) => {
  const controller = new AbortController()
  let timedOut = false
  const cancel = realClock.setTimer(() => {
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
      response = await financialFetch(url, { ...REQUEST_INIT, method: 'GET', headers: options.headers, signal: controller.signal })
    } catch {
      return interrupted()
    }
    try {
      return { kind: 'reply', reply: await rawReplyOf(response, options.contractHeader, options.maxBytes) }
    } catch {
      return interrupted()
    }
  } finally {
    cancel()
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/** Whether the points routes are on. Asked with no session. */
export const pointsService = (signal?: AbortSignal): Promise<PointsService> => askCapabilities(get, signal)

/**
 * The session as the page reads it: `signed_in` with its epoch and owner (the connected account), or why not.
 * `connect`: no wallet connected; `sign_in`: a wallet, and no session for it here (signed out, another network, another
 * account's session, a session the service refuses for now); `pending`: the session is being checked or changed.
 */
export type PointsSession =
  | { kind: 'signed_in'; epoch: number; owner: string }
  | { kind: 'connect' }
  | { kind: 'sign_in' }
  | { kind: 'pending' }

let shown: PointsSession = { kind: 'pending' }

/** The page's session, read the way finance/v2/http.ts LIVE_SESSION reads it. A stable object while nothing changes. */
export function pointsSession(): PointsSession {
  const { view, identity, epoch, away } = sessionController.getSnapshot()
  let next: PointsSession
  if (identity.kind === 'connected' && (away || (view.status === 'signed_in' && identity.address.toLowerCase() === view.owner.toLowerCase()))) {
    next = { kind: 'signed_in', epoch, owner: identity.address.toLowerCase() }
  } else if (view.status === 'starting' || view.status === 'checking' || view.status === 'signing_in' || view.status === 'signing_out') {
    next = { kind: 'pending' }
  } else if (identity.kind !== 'connected') {
    next = { kind: 'connect' }
  } else {
    next = { kind: 'sign_in' }
  }
  if (JSON.stringify(next) !== JSON.stringify(shown)) shown = next
  return shown
}

export const subscribePointsSession = (listener: () => void): (() => void) => sessionController.subscribe(listener)

const DENIALS: ReadonlySet<string> = new Set<DenialCode>(['session_required', 'csrf_invalid', 'account_unsupported'])

/** Runs one exchange with the CSRF of the session of `epoch`; a refusal of the session is reported to the page's port. */
async function withSession<T>(epoch: number, send: (csrf: string) => Promise<Exchange<T>>): Promise<Exchange<T>> {
  const answer = await sessionController.withSessionCsrf(epoch, send)
  if (answer === NO_SESSION) return { kind: 'refused', code: 'session_required', status: 0 }
  if (answer.kind === 'refused' && DENIALS.has(answer.code)) livePort.reportDenial(answer.code as DenialCode, epoch)
  return answer
}

/** The signed-in wallet's points (POST points {}). */
export function readPoints(epoch: number, signal?: AbortSignal): Promise<Exchange<PointsResponse>> {
  return withSession(epoch, (csrf) => askPoints<PointsResponse>(post, csrf, runtime, signal))
}

/** How a link ended: the service's answer, the wallet's refusal, or a refusal of the service. */
export type LinkEnd = Exchange<LinkResponse> | { kind: 'declined' }

/**
 * Links `referrer` as the signed-in wallet's referrer for `season` (the id the service named): the text built and signed
 * at the moment of asking, then sent at once (the service takes a signature up to 10 minutes old). `owner` must be the
 * session's account, which the wallet signs as. Called only from the Link referrer button.
 */
export async function linkReferrer({ epoch, owner, season, referrer, now = () => Date.now() }: { epoch: number; owner: string; season: string; referrer: string; now?: () => number }): Promise<LinkEnd> {
  const issuedAt = Math.floor(now() / 1000)
  let text: string
  try {
    text = referralText(season, owner, referrer, issuedAt)
  } catch {
    return { kind: 'refused', code: 'invalid_request', status: 0 }
  }
  const signed = await signLoginMessage({ address: owner, message: text })
  // Refused in the wallet, or the wallet could not sign: either way nothing was signed, and nothing is sent.
  if (!signed.ok) return { kind: 'declined' }
  const answer = await withSession(epoch, (csrf) => askLink<LinkResponse>(post, csrf, runtime, { referrer: referrer.toLowerCase(), issuedAt, signature: signed.signature }))
  // The service names the referred wallet from the session: it must be the one that signed.
  if (answer.kind === 'ok' && answer.value.referee.toLowerCase() !== owner.toLowerCase()) return { kind: 'refused', code: 'contract', status: 200 }
  return answer
}
