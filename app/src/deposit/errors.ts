/**
 * What each of deposit-v1's 49 closed error codes means to the deposit screen.
 * A full record over the package's code union; tests compare its keys with
 * the runtime's ERROR_STATUS_BY_CODE and check every entry of errors.json.
 *
 * No disposition schedules a create or a prepare. A denial of the token,
 * admission or state stops the flow and latches Prepare off for that
 * operation; nothing suggests another pool or a new deposit to work around it
 * (ADM:56, C40b, rugged97's instruction). The only automatic follow-up is one
 * `get` after a version or state conflict, and the mutation is never replayed.
 */
import type { DenialCode } from '../session/port'
import type { DepositErrorCode } from './types'

export interface DepositDisposition {
  /** The sentence shown. `{n}` is the step's nonce, `{s}` the wait in seconds. */
  copy: string
  retry: 'manual' | 'none' | 'after'
  /** Stop any wallet step for this operation: nothing is to be signed. */
  stop?: true
  /** Prepare stays off for this operation for the rest of the page's life. */
  latch?: true
  /** One `get` of the same operation, to show what the server has now. */
  autoGet?: true
  /** Point at the operation that blocks this one. */
  blocker?: true
  /** The operation is gone: forget the remembered id. */
  notFound?: true
  denial?: DenialCode
}

/** ERR-2: a token or admission error never cancels a transaction already sent. */
export const ERR2 = 'Nothing already sent from your wallet is cancelled by this.'
const NO_RAISE = 'Limits are never raised automatically. A new budget needs a new draft after the previous step resolves.'

const SERVICE_UNAVAILABLE: DepositDisposition = { copy: 'Deposit service unavailable.', retry: 'none' }
const TOO_MANY: DepositDisposition = { copy: 'Too many requests. Try again in {s} s.', retry: 'after' }
const STILL_SIGNED_IN: DepositDisposition = { copy: "Temporarily unavailable. You're still signed in.", retry: 'manual' }
const TIMED_OUT: DepositDisposition = { copy: 'The request timed out. Its outcome is unknown. Use Check status.', retry: 'manual' }
const TEMPORARY: DepositDisposition = { copy: 'Temporarily unavailable. Try again later.', retry: 'manual' }

export const DEPOSIT_ERROR_UI: Readonly<Record<DepositErrorCode, DepositDisposition>> = {
  deposit_invalid_request: { copy: 'The deposit service rejected this request. Nothing changed.', retry: 'none' },
  invalid_request: { copy: 'The deposit service rejected this request. Nothing changed.', retry: 'none' },
  deposit_not_found: { copy: 'Not found. It may have been archived.', retry: 'none', notFound: true },
  route_not_available: { copy: 'The deposit service is unavailable right now. Nothing changed.', retry: 'none' },
  deposit_idempotency_conflict: { copy: 'This draft request was already used with different details.', retry: 'none' },
  deposit_version_conflict: { copy: 'This deposit changed in another tab or session. Showing the latest state.', retry: 'none', autoGet: true },
  deposit_state_conflict: { copy: "That action doesn't apply to this deposit's current state. Showing the latest state.", retry: 'none', autoGet: true },
  deposit_owner_busy: { copy: 'Another deposit of yours is still open or needs attention. Resolve it first.', retry: 'none', blocker: true },
  deposit_artifact_expired: {
    copy: 'The wallet handoff for this step expired. The reservation for nonce {n} is still held. If your wallet already sent it, use Check status.',
    retry: 'none',
    stop: true,
  },
  deposit_wallet_pending: { copy: 'Your wallet has a pending transaction. Let it finish, then try again.', retry: 'manual' },
  deposit_state_changed: { copy: `The pool or token state changed while preparing. Stopped. Nothing new was prepared. ${ERR2}`, retry: 'none', stop: true },
  deposit_history_full: { copy: 'This deposit has reached its step or report limit (16 steps, 8 reports per step).', retry: 'none' },
  deposit_token_changed: {
    copy: `A token in this pool changed since it was reviewed. Stopped: don't sign anything for this step. ${ERR2}`,
    retry: 'none',
    stop: true,
    latch: true,
  },
  deposit_token_restricted: {
    copy: `A token in this pool is paused, frozen or restricted for your address. Stopped. ${ERR2}`,
    retry: 'none',
    stop: true,
    latch: true,
  },
  deposit_admission_required: { copy: `Deposits aren't available for this pool or token. ${ERR2}`, retry: 'none', stop: true, latch: true },
  deposit_funding_insufficient: { copy: `Your balance doesn't cover this step's maximum. ${NO_RAISE}`, retry: 'none', stop: true },
  deposit_fee_cap_too_low: { copy: `The network fee is above the maximum fee you selected. ${NO_RAISE}`, retry: 'none', stop: true },
  deposit_gas_limit_exceeded: { copy: `This step needs more gas than the gas limit you selected. ${NO_RAISE}`, retry: 'none', stop: true },
  deposit_gas_balance_insufficient: {
    copy: `Your native balance doesn't cover the deposit plus this step's maximum network fee. ${NO_RAISE}`,
    retry: 'none',
    stop: true,
  },
  deposit_capacity_busy: { copy: 'The deposit service is busy. Try again in {s} s.', retry: 'after' },
  // Neither clears with time, so neither re-enables anything after a wait.
  deposit_owner_capacity_busy: {
    copy: 'You have 16 active deposits, the maximum. One must finish, be cancelled, or resolve before you can start another.',
    retry: 'none',
  },
  deposit_owner_history_full: { copy: "You've reached the limit of 128 retained deposits. Contact support to archive older ones.", retry: 'none' },
  deposit_token_check_unavailable: { copy: `Token checks are temporarily unavailable. Stopped: don't sign. ${ERR2}`, retry: 'none', stop: true },
  deposit_preparation_unavailable: TEMPORARY,
  deposit_reconciliation_unavailable: TEMPORARY,
  deposit_allowance_unavailable: TEMPORARY,
  deposit_store_unavailable: TEMPORARY,
  session_required: {
    copy: 'Your session ended. Sign in again to continue. Any reserved wallet step stays reserved.',
    retry: 'none',
    stop: true,
    denial: 'session_required',
  },
  csrf_invalid: { copy: 'Rechecking your sign-in. No signature needed. Retry the action when it finishes.', retry: 'manual', denial: 'csrf_invalid' },
  account_unsupported: {
    copy: "This account can't use deposits. Only standard wallets (EOAs) are supported. You've been signed out.",
    retry: 'none',
    stop: true,
    denial: 'account_unsupported',
  },
  origin_not_allowed: SERVICE_UNAVAILABLE,
  method_not_allowed: SERVICE_UNAVAILABLE,
  json_required: SERVICE_UNAVAILABLE,
  request_too_large: SERVICE_UNAVAILABLE,
  upstream_contract_mismatch: SERVICE_UNAVAILABLE,
  upstream_invalid_response: SERVICE_UNAVAILABLE,
  preview_expired: SERVICE_UNAVAILABLE,
  provider_request_rejected: SERVICE_UNAVAILABLE,
  provider_unavailable: SERVICE_UNAVAILABLE,
  session_rate_limited: TOO_MANY,
  session_capacity_busy: TOO_MANY,
  onboarding_capacity_busy: TOO_MANY,
  onboarding_rate_limited: TOO_MANY,
  provider_rate_limited: TOO_MANY,
  account_check_unavailable: STILL_SIGNED_IN,
  session_store_unavailable: STILL_SIGNED_IN,
  upstream_unavailable: STILL_SIGNED_IN,
  request_timeout: TIMED_OUT,
  upstream_timeout: TIMED_OUT,
}
