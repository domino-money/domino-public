/**
 * The words for every state a read can end in, in one place.
 *
 * Reasons in the contract are closed enums, validated before they get here,
 * so a code this map does not know is still safe to show as plain text. No
 * provider-authored string ever passes through here.
 *
 * Every screen takes its words, its Retry and its sign-in link from here, so
 * an honest state is decided once, in the shared read layer, never per screen:
 *
 *   gate 401                           Access expired, with Sign in again
 *   /api forwarder 503, or no /api     Live data unavailable
 *   forwarder 404 (another address)    Live data isn't available on this address
 *   capabilities disabled, a route     Live data is switched off for now
 *     not enabled, 404 route_not_available
 *   429 read_capacity_busy             Read service busy, once R-1 gives up
 *   transient producer 503 or 504      Temporarily unavailable, Retry for a person
 *   read deadline                      Pool data unavailable, naming the limit
 *
 * None of these is asked again on its own; only R-1's 429 retry does that,
 * inside the pipeline. Nothing here ever puts sample data in their place.
 */
import { REQUEST_READ_CONTRACT, READ_V3_PIN } from './pin'
import { BRIDGE_RETRY } from './pipeline'
import type { FailedOutcome, NotConnectedReason, ReadKey } from './types'

const REASONS: Record<string, string> = {
  provider_unavailable: 'provider unavailable',
  provider_rate_limited: 'provider rate limited',
  provider_capacity_busy: 'provider busy',
  provider_currency_or_pool_mismatch: 'provider data did not match this pool',
  provider_dex_unconfirmed: 'provider could not confirm the exchange',
  provider_chart_currency_mismatch: 'chart currency did not match',
  provider_market_identity_unavailable: 'market identity unavailable',
  provider_lp_fee_history_unavailable: 'provider LP fee history unavailable',
  reconciled_fee_history_unavailable: 'reconciled fee history unavailable',
  qualified_usd_prices_required: 'qualified USD prices required',
  qualified_price_coverage_gap: 'gap in qualified price coverage',
  price_observation_budget_exhausted: 'price read budget exhausted',
  capital_history_unavailable: 'capital history unavailable',
  reconciled_position_tail_required: 'position history not reconciled yet',
  capital_ledger_not_caught_up: 'capital ledger catching up',
  capital_window_budget_exhausted: 'capital window read budget exhausted',
  pool_younger_than_window: 'pool younger than the 24h window',
  capital_window_incomplete: 'capital reconciled over less than the 24h window',
  zero_time_weighted_tvl: 'zero time-weighted TVL',
  position_ledger_not_caught_up: 'position ledger catching up',
  position_accounting_adapter_required: 'position accounting adapter required',
  fee_ledger_not_caught_up: 'fee ledger catching up',
  fee_accounting_adapter_required: 'fee accounting adapter required',
  timestamp_aligned_valuation_unavailable: 'no timestamp-aligned valuation',
  lp_fee_and_time_weighted_tvl_not_reconciled: 'LP fees and time-weighted TVL not reconciled',
  time_weighted_tvl_and_usd_valuation_not_reconciled: 'time-weighted TVL and USD valuation not reconciled',
  price_source_quality_not_qualified: 'price source not qualified',
  price_history_missing: 'price history missing',
  token_has_no_code: 'no contract at this address',
  rpc_error: 'RPC error',
  rpc_call_gas_limit: 'RPC call hit the gas limit',
  rpc_call_reverted: 'RPC call reverted',
  network_unavailable: 'network unavailable',
  upstream_unavailable: 'read service unavailable',
  upstream_timeout: 'read service timed out',
  not_in_read_v1: 'read-v1 has no such field',
  mixed_basis: 'operands come from different sources',
  fee_apr_not_provided: 'Qualified fee APR not provided by the read service',
  turnover_undefined: 'no TVL to divide by',
}

export const reasonText = (code: string | null | undefined): string =>
  code ? (REASONS[code] ?? code.replace(/_/g, ' ')) : 'no reason given'

export interface FailureText {
  title: string
  detail: string
  /** Whether asking again could plausibly help. */
  retry: boolean
  /** The beta cookie is gone: the way back is the access page. */
  signIn?: boolean
}

/** The site's own /api layer answered instead of the read bridge. A retry cannot change that, so none is offered. */
function notConnected(reason: NotConnectedReason): FailureText {
  switch (reason) {
    case 'not_found':
      return { title: 'Live data isn\'t available on this address', detail: 'Live data isn\'t served on this address.', retry: false }
    case 'worker_subrequest_refused':
      return { title: 'Request refused', detail: 'The site refused this read because it did not come straight from a browser.', retry: false }
    case 'bridge_unavailable':
    case 'no_forwarder':
      return { title: 'Live data unavailable', detail: 'This site\'s read service isn\'t reachable, so there are no pool figures to show. Nothing is shown in their place.', retry: false }
    default:
      return reason satisfies never
  }
}

/** read-v3's own routes; a mismatch on one of them is about 3.0.0-rc.1, not read-v1's version. */
const V3_ONLY = new Set(['overview', 'history', 'search'])
/** The version the app asked that route under, so the sentence names the contract that actually disagreed. */
const expectedContract = (route: string) => (V3_ONLY.has(route) ? READ_V3_PIN.version : REQUEST_READ_CONTRACT)

export function describeFailure(outcome: FailedOutcome<ReadKey>): FailureText {
  switch (outcome.state) {
    case 'gate_required':
      return { title: 'Access expired', detail: 'Your access has expired or was signed out. Reload the page to sign in again.', retry: false, signIn: true }
    case 'gate_unavailable':
      return { title: 'Access is paused', detail: 'Site access is unavailable right now. Nothing is wrong on your side.', retry: true }
    case 'access_required':
      return { title: 'Blocked by an access check', detail: 'This environment sits behind an access check that redirected the read. Nothing was shown.', retry: false }
    case 'not_connected':
      return notConnected(outcome.reason)
    case 'incompatible':
      return {
        title: 'Read contract mismatch',
        detail:
          outcome.reason === 'contract_header_missing'
            ? 'The read service did not say which contract it speaks, so nothing it sent is shown.'
            : outcome.reason === 'upstream_contract_mismatch'
              ? 'The read bridge and its gateway disagree on the contract version.'
              : `The read service speaks a contract this app was not built for. It expects ${expectedContract(outcome.route)}.`,
        retry: true,
      }
    case 'invalid':
      return {
        title: 'Data failed validation',
        detail:
          outcome.reason === 'identity_mismatch'
            ? 'The reply was about a different pool, token or block than the one asked for. Nothing from it is shown.'
            : outcome.reason === 'request_contract'
              ? 'This app built a request the read contract does not allow. Nothing was sent.'
              : 'The reply did not match the read contract. Nothing from it is shown.',
        retry: outcome.reason !== 'request_contract',
      }
    case 'unavailable': {
      const cause = outcome.cause
      if (cause.kind === 'producer') {
        const detail = `The read service answered: ${reasonText(cause.code)}.`
        // A transient 503 or 504 may clear, so a person may ask again; nothing asks on its own.
        // Integrity, configuration and indexing codes would get the same answer, so no Retry.
        return outcome.retryable ? { title: 'Temporarily unavailable', detail, retry: true } : { title: 'Pool data unavailable', detail, retry: false }
      }
      const detail =
        cause.kind === 'network'
          ? 'The read service could not be reached.'
          : cause.kind === 'edge'
            ? `The network edge answered with an error page (HTTP ${cause.status}), not the read service.`
            : cause.kind === 'read_deadline'
              ? cause.limit === 'attempt'
                ? `The read service did not answer within ${BRIDGE_RETRY.attemptMs / 1000} s, so the read was stopped.`
                : `Stopped after ${BRIDGE_RETRY.totalMs / 1000} s, time spent queued included.`
              : 'Too many reads are already waiting on this screen.'
      return { title: 'Pool data unavailable', detail, retry: true }
    }
    case 'busy':
      return { title: 'Read service busy', detail: `Try again in ${outcome.retryAfterSeconds} s.`, retry: true }
    case 'restart_required':
      return {
        title: 'The list changed',
        detail: outcome.code === 'invalid_or_expired_cursor' ? 'The page handle expired, so the list restarts from the first page.' : 'The catalogue was re-indexed, so the list restarts from the first page.',
        retry: true,
      }
    case 'request_rejected':
      return { title: 'Request refused', detail: `The read bridge refused this request (${reasonText(outcome.code)}, HTTP ${outcome.status}).`, retry: false }
    case 'disabled':
      return {
        title: 'Live data is switched off for now',
        detail:
          outcome.reason === 'live_data_disabled'
            ? 'This build does not read live data.'
            : outcome.reason === 'bridge_data_mode_disabled'
              ? 'Live reads are switched off on the server.'
              : 'This read is not enabled on the server.',
        retry: false,
      }
    case 'aborted':
      return { title: 'Cancelled', detail: 'The read was cancelled.', retry: true }
    default:
      return outcome satisfies never
  }
}
