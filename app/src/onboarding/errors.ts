/**
 * What each of onboarding-v1's 24 closed error codes means to the preview
 * screen. A full record over the package's code union, so a new code fails
 * typechecking; tests compare its keys with the runtime's ERROR_STATUS_BY_CODE.
 *
 * No disposition retries on its own, and none leads to a signature: a
 * `session_required` or `csrf_invalid` makes the session re-read `me`, and
 * `account_unsupported` signs the tab out.
 */
import type { DenialCode } from '../session/port'
import type { OnboardingErrorCode } from './types'

export type PreviewFailureKind =
  | 'input_rejected'
  | 'signed_out'
  | 'session_recovery'
  | 'account_unsupported'
  | 'unavailable'
  | 'feature_unavailable'
  | 'expired_before_delivery'
  | 'no_route'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'service_busy'
  | 'timed_out'

/** When the user may ask again: after changing the inputs, by pressing again, never, or after a wait. */
export type RetryRule = 'edit' | 'manual' | 'none' | 'after'

export interface ErrorDisposition {
  kind: PreviewFailureKind
  retry: RetryRule
  denial?: DenialCode
}

const RATE_LIMITED: ErrorDisposition = { kind: 'rate_limited', retry: 'after' }
const UNAVAILABLE: ErrorDisposition = { kind: 'unavailable', retry: 'none' }

export const ONBOARDING_ERROR_UI: Readonly<Record<OnboardingErrorCode, ErrorDisposition>> = {
  invalid_request: { kind: 'input_rejected', retry: 'edit' },
  request_too_large: { kind: 'input_rejected', retry: 'edit' },
  session_required: { kind: 'signed_out', retry: 'none', denial: 'session_required' },
  csrf_invalid: { kind: 'session_recovery', retry: 'manual', denial: 'csrf_invalid' },
  account_unsupported: { kind: 'account_unsupported', retry: 'none', denial: 'account_unsupported' },
  origin_not_allowed: UNAVAILABLE,
  method_not_allowed: UNAVAILABLE,
  json_required: UNAVAILABLE,
  route_not_available: { kind: 'feature_unavailable', retry: 'none' },
  preview_expired: { kind: 'expired_before_delivery', retry: 'manual' },
  provider_request_rejected: { kind: 'no_route', retry: 'edit' },
  session_rate_limited: RATE_LIMITED,
  session_capacity_busy: RATE_LIMITED,
  onboarding_capacity_busy: RATE_LIMITED,
  onboarding_rate_limited: RATE_LIMITED,
  provider_rate_limited: RATE_LIMITED,
  upstream_contract_mismatch: UNAVAILABLE,
  upstream_invalid_response: UNAVAILABLE,
  provider_unavailable: { kind: 'provider_unavailable', retry: 'manual' },
  // The session is kept through these (T-30): the service could not check it.
  session_store_unavailable: { kind: 'service_busy', retry: 'manual' },
  account_check_unavailable: { kind: 'service_busy', retry: 'manual' },
  upstream_unavailable: { kind: 'unavailable', retry: 'manual' },
  request_timeout: { kind: 'timed_out', retry: 'manual' },
  upstream_timeout: { kind: 'timed_out', retry: 'manual' },
}
