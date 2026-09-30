/**
 * The browser side of onboarding-v1: one POST per preview the user asks for,
 * and one interpretation of the reply, in this order (the tests fail if two
 * steps swap):
 *
 *   1. The transport: an abort from an invalidation, this page's deadline
 *      (12 s for route selection, 27 s for previews), a network failure, a redirect.
 *   2. No `X-Domino-Onboarding-Contract` header: the beta gate's 401 and 503,
 *      a missing route (404, 405, the SPA's HTML), anything else. None of
 *      these is a preview state, and no validator sees them.
 *   3. A header other than the pinned onboarding contract.
 *   4. JSON media, the 128 KiB bound, parsing.
 *   5. 200: the package runtime, then the owner (S-5), then the echo (INV-2).
 *   6. Anything else: `validateError` checks code and status together, then
 *      the error table.
 *
 * The CSRF arrives as an argument from the session port for this one request.
 * Nothing here retries, stores or logs a body.
 */
import type { Clock } from '../lib/clock'
import { classifyHeaderless, fetchRaw, jsonBody, parseRetryAfter, type FetchLike, type TransportResult } from '../lib/http/rawReply'
import type { DenialCode } from '../session/port'
import { echoMatches, ownerMatches } from './echo'
import { ONBOARDING_ERROR_UI, type PreviewFailureKind, type RetryRule } from './errors'
import type { OnboardingErrorCode, OnboardingRequests, OnboardingRoute, OnboardingValidators, PreviewOf } from './types'
import { ONBOARDING_CONTRACT } from './version'

export const ONBOARDING_PREFIX = '/api/onboarding/v1/'
export const ONBOARDING_HEADER = 'X-Domino-Onboarding-Contract'
export const CSRF_HEADER = 'X-Domino-CSRF'
/** Just above the worker's 25 s budget, so its own 504 is what the user normally sees. */
export const PREVIEW_TIMEOUT_MS = 27_000
/** Route selection is optional: leave time for the existing pool path to proceed. */
export const SWAP_ROUTE_TIMEOUT_MS = 12_000
export const MAX_REQUEST_BYTES = 8192
/**
 * The producer's own ceiling: the onboarding service and worker refuse to
 * send a response over 128 KiB (onboarding_models.MAX_RESPONSE = 131072,
 * rugged97 on #38), so a larger one is never a supported answer.
 */
export const MAX_RESPONSE_BYTES = 128 * 1024
export const ROUTES: readonly OnboardingRoute[] = ['swap-preview', 'position-preview', 'swap-route']

export type UnavailableDetail =
  | 'network'
  | 'redirect'
  | 'upstream_unavailable'
  | 'contract_version'
  | 'not_json'
  | 'too_large'
  | 'invalid_json'
  | 'response_contract'
  | 'owner_mismatch'
  | 'echo_mismatch'
  | 'request_contract'
  | 'runtime_error'
  | 'producer'

export type PreviewFailure =
  | { kind: 'gate_required' | 'gate_unavailable'; retry: 'none' }
  | {
      kind: PreviewFailureKind
      retry: RetryRule
      code?: OnboardingErrorCode
      status?: number
      detail?: UnavailableDetail
      retryAfterS?: number
      denial?: DenialCode
    }

export type PreviewResult<R extends OnboardingRoute> =
  | { ok: true; preview: PreviewOf<R>; requestId: string | null }
  | { ok: false; failure: PreviewFailure; requestId: string | null }
  /** Aborted by an invalidation: nothing to show, nothing to say. */
  | { ok: false; aborted: true }

const unavailable = (detail: UnavailableDetail, retry: RetryRule = 'none'): PreviewFailure => ({ kind: 'unavailable', retry, detail })

/** One reply (or the lack of one) as a preview result. Exported for the tests. */
export function interpretPreview<R extends OnboardingRoute>(
  route: R,
  sent: OnboardingRequests[R],
  result: TransportResult,
  runtime: OnboardingValidators,
  sessionOwner: string,
): PreviewResult<R> {
  switch (result.kind) {
    case 'aborted':
      return { ok: false, aborted: true }
    case 'timeout':
      return { ok: false, failure: { kind: 'timed_out', retry: 'manual' }, requestId: null }
    case 'network':
      return { ok: false, failure: unavailable('network', 'manual'), requestId: null }
    case 'reply':
      break
  }
  const reply = result.reply
  const requestId = reply.requestIdHeader
  const fail = (failure: PreviewFailure): PreviewResult<R> => ({ ok: false, failure, requestId })
  if (reply.opaqueRedirect) return fail(unavailable('redirect'))

  if (reply.contractHeader === null) {
    switch (classifyHeaderless(reply)) {
      case 'gate_required':
        return fail({ kind: 'gate_required', retry: 'none' })
      case 'gate_unavailable':
        return fail({ kind: 'gate_unavailable', retry: 'none' })
      case 'feature_unavailable':
        return fail({ kind: 'feature_unavailable', retry: 'none' })
      case 'unrecognised':
        return fail(unavailable('upstream_unavailable', 'manual'))
    }
  }
  if (reply.contractHeader !== ONBOARDING_CONTRACT) return fail(unavailable('contract_version'))

  const body = jsonBody(reply)
  if (!body.ok) return fail(unavailable(body.reason))

  try {
    if (reply.status === 200) {
      if (!runtime.validateResponse(route, body.value)) return fail(unavailable('response_contract'))
      const preview = body.value.preview as PreviewOf<R>
      if (!ownerMatches(preview, sessionOwner)) return fail(unavailable('owner_mismatch'))
      if (!echoMatches(route, sent, preview)) return fail(unavailable('echo_mismatch'))
      return { ok: true, preview, requestId }
    }
    if (!runtime.validateError(reply.status, body.value)) return fail(unavailable('upstream_unavailable', 'manual'))
  } catch {
    // The runtime itself threw, e.g. on a browser without String#isWellFormed.
    return fail(unavailable('runtime_error'))
  }
  const code = (body.value as { error: OnboardingErrorCode }).error
  const disposition = ONBOARDING_ERROR_UI[code]
  return fail({
    kind: disposition.kind,
    retry: disposition.retry,
    code,
    status: reply.status,
    detail: disposition.kind === 'unavailable' ? 'producer' : undefined,
    ...(reply.status === 429 ? { retryAfterS: parseRetryAfter(reply.retryAfterHeader) } : {}),
    ...(disposition.denial ? { denial: disposition.denial } : {}),
  })
}

export interface OnboardingClient {
  preview<R extends OnboardingRoute>(
    route: R,
    request: OnboardingRequests[R],
    options: { csrf: string; sessionOwner: string; signal?: AbortSignal },
  ): Promise<PreviewResult<R>>
}

export function createOnboardingClient({ fetch, runtime, clock }: { fetch: FetchLike; runtime: OnboardingValidators; clock: Clock }): OnboardingClient {
  return {
    async preview(route, request, { csrf, sessionOwner, signal }) {
      // Never send what the contract would refuse, and nothing over the worker's bound.
      let valid: boolean
      try {
        valid = ROUTES.includes(route) && runtime.validateRequest(route, request)
      } catch {
        valid = false
      }
      const body = JSON.stringify(request)
      if (!valid || new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
        return { ok: false, failure: unavailable('request_contract'), requestId: null }
      }
      const result = await fetchRaw(
        fetch,
        ONBOARDING_PREFIX + route,
        {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            [ONBOARDING_HEADER]: ONBOARDING_CONTRACT,
            [CSRF_HEADER]: csrf,
          },
          body,
        },
        { contractHeader: ONBOARDING_HEADER, maxBytes: MAX_RESPONSE_BYTES, timeoutMs: route === 'swap-route' ? SWAP_ROUTE_TIMEOUT_MS : PREVIEW_TIMEOUT_MS, signal, clock },
      )
      return interpretPreview(route, request, result, runtime, sessionOwner)
    },
  }
}
