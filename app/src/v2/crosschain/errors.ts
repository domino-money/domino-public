/**
 * What each of crosschain-v1's 28 closed error codes means to the S2 screens (spec F7 §3.8; XC fixtures/errors.json).
 * A full record over the package's code union, so a new code fails typechecking; tests compare its keys with the
 * runtime's ERROR_STATUS_BY_CODE and check every errors.json pair.
 *
 * The code is never part of the text. A screen puts it in a `data-error-code` attribute, and a code this table does not
 * know (impossible after `validateError`, but a screen may hold a stale one) gets the generic sentence.
 *
 * No disposition leads to a signature. `session_required` and `csrf_invalid` go to the session's `reportDenial`, which
 * re-reads the session; `account_unsupported` does too, and stops. Transient states have no Retry button: the page
 * asks again by itself (`retry`, `later`, `backoff`, `retry_once`), and ./polling.ts schedules those waits.
 */
import type { CrosschainDenial, CrosschainErrorCode } from './types'

/** What the page does after the error. */
export type CrosschainNext =
  /** reportDenial; the session flow asks the person to sign in again. */
  | 'session'
  /** reportDenial, then stop: this wallet cannot use S2. */
  | 'account'
  /** Ask again by itself shortly. */
  | 'retry'
  /** Ask again by itself later. */
  | 'later'
  /** 429: wait Retry-After, longer each time. */
  | 'backoff'
  /** One more attempt, then stop. */
  | 'retry_once'
  /** Get a new quote. */
  | 'requote'
  /** The person changes the amount or the token. */
  | 'edit'
  /** Deposits from another network are off for this page. */
  | 'feature_off'
  /** Stop asking for this deposit's status; show its transaction hash. */
  | 'stop_polling'
  /** Stop: nothing here clears with time (an app bug, a refused origin or wallet). */
  | 'stop'

export interface CrosschainDisposition {
  copy: string
  next: CrosschainNext
  denial?: CrosschainDenial
}

/** The sentence for a code the table does not know. */
export const GENERIC_ERROR_COPY = 'Something went wrong. Try again in a moment.'

const SIGN_IN_AGAIN = 'Sign in again to continue.'
const APP_BUG: CrosschainDisposition = { copy: 'Something went wrong with this request.', next: 'stop' }
const BUSY: CrosschainDisposition = { copy: 'Busy right now. Try again in a moment.', next: 'backoff' }
const TOO_MANY: CrosschainDisposition = { copy: 'Too many requests. Try again in a moment.', next: 'backoff' }
const TOO_LONG: CrosschainDisposition = { copy: 'This took too long. Try again.', next: 'retry' }
const UNEXPECTED: CrosschainDisposition = { copy: 'We got an unexpected answer. Try again.', next: 'retry_once' }
const SERVICE_DOWN: CrosschainDisposition = { copy: 'Service unavailable right now.', next: 'later' }

export const CROSSCHAIN_ERROR_UI: Readonly<Record<CrosschainErrorCode, CrosschainDisposition>> = Object.freeze({
  session_required: { copy: SIGN_IN_AGAIN, next: 'session', denial: 'session_required' },
  csrf_invalid: { copy: SIGN_IN_AGAIN, next: 'session', denial: 'csrf_invalid' },
  account_unsupported: { copy: "This wallet type isn't supported. Use a regular wallet account.", next: 'account', denial: 'account_unsupported' },
  account_check_unavailable: { copy: "We couldn't check your wallet right now. Try again.", next: 'retry' },
  origin_not_allowed: { copy: "This page can't reach Domino's service.", next: 'stop' },
  invalid_request: APP_BUG,
  json_required: APP_BUG,
  method_not_allowed: APP_BUG,
  request_too_large: APP_BUG,
  route_not_available: { copy: "Deposits from another network aren't available right now.", next: 'feature_off' },
  preview_expired: { copy: 'The quote expired. Getting a new one…', next: 'requote' },
  crosschain_route_unsupported: { copy: "Deposits can't be made from this wallet.", next: 'stop' },
  crosschain_deposit_not_found: {
    copy: "We couldn't match this deposit to your wallet. Check the transaction in the explorer.",
    next: 'stop_polling',
  },
  crosschain_listing_unavailable: { copy: 'The list of networks is unavailable right now. Try again.', next: 'later' },
  crosschain_capacity_busy: BUSY,
  onboarding_capacity_busy: BUSY,
  session_capacity_busy: BUSY,
  onboarding_rate_limited: TOO_MANY,
  session_rate_limited: TOO_MANY,
  provider_rate_limited: TOO_MANY,
  provider_request_rejected: { copy: 'The bridge provider refused this request.', next: 'edit' },
  provider_unavailable: { copy: 'The bridge provider is unavailable right now.', next: 'later' },
  request_timeout: TOO_LONG,
  upstream_timeout: TOO_LONG,
  upstream_contract_mismatch: UNEXPECTED,
  upstream_invalid_response: UNEXPECTED,
  upstream_unavailable: SERVICE_DOWN,
  session_store_unavailable: SERVICE_DOWN,
})

/** A code's disposition, the generic one for a code the table does not know. `code` is for a data-* attribute only. */
export function errorDisposition(code: string): CrosschainDisposition & { code: string; known: boolean } {
  if (Object.hasOwn(CROSSCHAIN_ERROR_UI, code)) return { ...CROSSCHAIN_ERROR_UI[code as CrosschainErrorCode], code, known: true }
  return { copy: GENERIC_ERROR_COPY, next: 'retry_once', code, known: false }
}
