import type { SessionErrorCode } from 'api-contracts/session-v1/types'

/**
 * What each closed session-v1 error means to this client, before the route
 * and the step it arrived on are taken into account. machine.ts decides the
 * rest; nothing in this table ever leads to a signature request.
 */
export type ErrorClass =
  /** The session is gone: expired, idle, logged out or revoked by an operator. */
  | 'session_ended'
  /** The ten-minute pre-login context is missing or expired. */
  | 'preauth_expired'
  /** The challenge expired, was used, was replaced or ran out of attempts. */
  | 'challenge_rejected'
  | 'signature_rejected'
  | 'csrf'
  /** The address is a contract account: code other than one EIP-7702 designator. */
  | 'unsupported_account'
  | 'session_exists'
  /** The session bridge is switched off on this deployment. */
  | 'disabled'
  /** This page sent something the service rejects; retrying cannot help. */
  | 'client'
  | 'rate_limited'
  | 'store_unavailable'
  | 'account_check_unavailable'
  | 'upstream'
  | 'timeout'

/**
 * Every code the contract defines. Typed as a full record so a new code in the
 * package fails typechecking here, and tests compare the keys with the
 * runtime's own ERROR_STATUS_BY_CODE.
 */
export const ERROR_CLASS: Readonly<Record<SessionErrorCode, ErrorClass>> = {
  session_required: 'session_ended',
  preauth_required: 'preauth_expired',
  challenge_invalid: 'challenge_rejected',
  invalid_signature: 'signature_rejected',
  csrf_invalid: 'csrf',
  account_unsupported: 'unsupported_account',
  session_exists: 'session_exists',
  route_not_available: 'disabled',
  invalid_request: 'client',
  origin_not_allowed: 'client',
  method_not_allowed: 'client',
  request_too_large: 'client',
  json_required: 'client',
  session_rate_limited: 'rate_limited',
  session_capacity_busy: 'rate_limited',
  session_store_unavailable: 'store_unavailable',
  account_check_unavailable: 'account_check_unavailable',
  upstream_unavailable: 'upstream',
  upstream_invalid_response: 'upstream',
  upstream_contract_mismatch: 'upstream',
  request_timeout: 'timeout',
  upstream_timeout: 'timeout',
}

export function classify(code: SessionErrorCode): ErrorClass {
  return ERROR_CLASS[code]
}
