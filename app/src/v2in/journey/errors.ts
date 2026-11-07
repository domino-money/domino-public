import { ZapRefusal } from '../../finance/v2/zap'
import { v2Chain } from '../../v2/chains'
import { versionOffChain } from '../../v2/plan/client'
import { CONTRACTS_NOT_LIVE, contractsNotLiveCopy } from '../../finance/v2/liveLock'
import { GENERIC_COPY, decodeRevertData, decodeV2Error, type ErrorLabels, type Recovery } from '../../v2/errors'
import type { S1PlanResult } from '../../v2/plan/types'
import type { Address, V2ChainId } from '../../v2/types'
import { NEW_POOL_RACE_COPY } from './constants'
import { JOURNEY } from './copy'
import { JourneyNotice } from './wallet'

/**
 * Every failure of New position's zap path said in the spec's English (F7 §2.12, §2.4's plan API table), its code for a
 * `data-error-code` attribute, never in the text (copied from the #/v2 screens' src/v2ui/s1/errors.ts, which this area
 * never imports): first the V2 decoder (src/v2/errors.ts decodeV2Error, context `zap`: a wallet's refusal, an unknown
 * network, any contract's revert), then the clients' own closed codes, then the generic sentence.
 */
export interface JourneyError {
  copy: string
  code: string
  retryAfterSeconds?: number
  /**
   * What the screen does next: `requote` goes back to a fresh quote by itself; the plan API's own (rev2 §2.4):
   * `quiet-requote` asks again without a word (preview_expired, an answer past its expiry), `direct-retry` asks again
   * for the direct path without a word (consent_unsupported), `offer-new-pool` offers "Create a new pool (advanced)",
   * `pool-race` re-reads the pool and continues on the one that now exists.
   */
  recovery: Recovery | 'none' | 'quiet-requote' | 'retry-later' | 'direct-retry' | 'offer-new-pool' | 'offer-both' | 'pool-race'
}

const PLAN_COPY = 'This plan can’t be executed. Review it again.'
/** Domino V2 rev2 review, F1: a plan whose swaps end in a token nobody asked for (or start from one the wallet does not put in). */
const ROUTE_COPY = 'This plan would swap into something you didn’t ask for, so nothing was sent. Review it again.'
const EXPIRED_COPY = 'This review expired before it was confirmed. Review again for a fresh quote.'
const SENT_UNKNOWN = 'Your wallet may have sent this. Nothing more will be sent from here: check your wallet’s activity, and the page will follow the network.'
const UNSETTLED = (chain: string) => `An earlier action was already sent to your wallet and is not settled on ${chain} yet. Check your wallet’s activity: nothing new is sent from here until this is clear. If you rejected or closed it in your wallet, say so below.`

/** The plan API's refusals (rev2 §2.4 "Erros HTTP da API do plano"; the proposed copy, decision #29). */
const PLAN_ERRORS = {
  invalid_request: 'Something in this request isn’t valid. Review and try again.',
  position_plan_capacity_busy: 'Busy right now. Try again in a moment.',
  position_plan_not_owner: 'This position isn’t in your wallet.',
  position_plan_position_not_found: 'This position no longer exists.',
  position_plan_pool_not_initialized: 'This pool has no price yet.',
  position_plan_pool_initialized: NEW_POOL_RACE_COPY,
  position_plan_pool_invalid: 'This pool isn’t supported.',
  position_plan_hooked_pool: 'This pool isn’t supported.',
  position_plan_price_invalid: 'Check the starting price.',
  position_plan_price_decimals_mismatch: 'Check the starting price.',
  position_plan_range_invalid: 'Choose a different range.',
  position_plan_liquidity_invalid: 'Check the amount to remove.',
  position_plan_burn_needs_all: 'Check the amount to remove.',
  position_plan_inputs_unsupported: 'Pay with at most one token outside this pool.',
  position_plan_no_route: 'No route found for this swap.',
  position_plan_amount_too_small: 'Amount too small.',
  position_plan_nothing_to_convert: 'There is nothing to convert: you can receive both tokens instead.',
  planning_failed: 'Planning failed. Try again.',
  not_available: (chain: string) => `Not available on ${chain} right now.`,
  request_timeout: 'Planning took too long. Try again.',
  session: 'Sign in with your wallet first.',
} as const

/** The money clients' closed codes (finance/v2/zap.ts, transact.ts) that are not a contract's revert. */
function clientCopy(code: string, chainId: V2ChainId): { copy: string; recovery: JourneyError['recovery'] } | null {
  const chain = v2Chain(chainId).name
  // A pool initialized by someone else since the person typed its starting price (rev2 §2.6.5's race): said, then the
  // ordinary create on the pool that now exists.
  if (code === 'plan_pool_has_price') return { copy: NEW_POOL_RACE_COPY, recovery: 'pool-race' }
  // Domino V2 rev2 review (2026-10-02). F1: the plan's swaps do not lead to what the person asked for. F4: the plan's
  // minimums do not hold against what the app itself reads, or against its own simulation (§2.12's sentences).
  if (code === 'plan_route_source' || code === 'plan_route_target' || code === 'plan_target') return { copy: ROUTE_COPY, recovery: 'requote' }
  if (code === 'plan_price_moved') return { copy: 'The price moved. Review again.', recovery: 'requote' }
  if (code === 'plan_simulated_below_minimum') return { copy: 'The price moved: this would add less liquidity than your minimum. No tokens moved.', recovery: 'requote' }
  if (code.startsWith('plan_') && code !== 'plan_expiring' && code !== 'plan_nonce_used' && code !== 'plan_quote_expired') return { copy: PLAN_COPY, recovery: 'requote' }
  if (code.startsWith('deployment_')) return { copy: 'Domino isn’t available on this network right now.', recovery: 'disable-chain' }
  switch (code) {
    // The money lock before Domino V2's contracts are live (finance/v2/liveLock.ts): nothing reached the wallet; the
    // gate's own sentence for the chain.
    case CONTRACTS_NOT_LIVE: return { copy: contractsNotLiveCopy(chainId), recovery: 'none' }
    case 'connect_wallet': return { copy: 'Connect a wallet first.', recovery: 'none' }
    case 'wallet_wrong_chain': return { copy: `Your wallet is on another network. Switch it to ${chain}, then try again.`, recovery: 'none' }
    case 'wallet_identity_changed': case 'wallet_action_expired': return { copy: 'Your wallet changed while this was open. Review again.', recovery: 'none' }
    case 'wallet_action_busy': return { copy: 'Another request to your wallet is still open. Finish it first.', recovery: 'none' }
    case 'wallet_timeout': return { copy: 'Your wallet did not answer in time. Check it, then review again.', recovery: 'none' }
    case 'pending_wallet_transaction': case 'wallet_nonce_already_offered': return { copy: 'A transaction from this wallet is still waiting. Let it finish, then try again.', recovery: 'none' }
    case 'plan_expiring': case 'plan_quote_expired': case 'wallet_review_expired': case 'wallet_review_required': return { copy: EXPIRED_COPY, recovery: 'requote' }
    case 'plan_nonce_used': case 'nonce_unavailable': return { copy: 'This signature was already used or cancelled.', recovery: 'requote' }
    case 'review_already_sent': case 'batch_already_offered': case 'wallet_batch_already_offered': return { copy: 'This was already sent to your wallet. Check its activity before doing anything else.', recovery: 'none' }
    // Domino V2 rev2 review, F3: an earlier action of this wallet on this chain is not settled yet ("I rejected it in my wallet" below).
    case 'zap_action_unsettled': return { copy: UNSETTLED(chain), recovery: 'none' }
    case 'wallet_result_unknown': return { copy: SENT_UNKNOWN, recovery: 'none' }
    case 'native_gas_reserve_insufficient': return { copy: `Not enough ${v2Chain(chainId).nativeSymbol} for the network fee.`, recovery: 'none' }
    case 'gas_budget_exceeded': return { copy: 'This would cost more network fee than allowed. Review again.', recovery: 'requote' }
    case 'pool_not_initialized': return { copy: 'This pool has no price yet.', recovery: 'other-pool' }
    case 'batch_simulation_reverted': return { copy: GENERIC_COPY, recovery: 'requote' }
    case 'signature_journal_unavailable': case 'signature_journal_full': case 'wallet_nonce_coordination_unavailable': return { copy: 'This browser can’t keep track of your wallet requests. Use another browser.', recovery: 'none' }
    case 'invalid_slippage': return { copy: 'Choose between 0.1% and 5%.', recovery: 'fix-fields' }
    case 'l1_fee_unavailable': return { copy: 'The network fee can’t be worked out right now. Try again in a moment.', recovery: 'none' }
    default: return null
  }
}

/**
 * A plan answer that is not a plan, said (rev2 §2.4's table; the server's simulation's revert through the §2.12 decoder).
 * `dex`: the Uniswap version the request was about. Changed on purpose 2026-11-06 (Elysium readiness): the service's
 * `invalid_request` for a version the chain lacks (v3 on a chain with v4 alone; ../../v2/plan/client.ts gives it without
 * asking) is "Not available on {chain} right now.", as a chain the planner does not serve, never asked again; any other
 * `invalid_request` is said as before.
 */
export function planFailure(result: Exclude<S1PlanResult, { kind: 'ok' }>, chainId: V2ChainId, token?: (address: Address) => string, dex?: number): JourneyError {
  const chain = v2Chain(chainId).name
  const E = PLAN_ERRORS
  if (result.kind === 'refused' && result.code === 'invalid_request' && versionOffChain(chainId, dex)) {
    return { copy: E.not_available(chain), code: 'position_plan_dex_not_on_chain', recovery: 'none' }
  }
  const codeOf = (text: string) => text.replace(/[^a-z0-9_]/gi, '_').toLowerCase().slice(0, 64)
  switch (result.kind) {
    case 'expired': return { copy: EXPIRED_COPY, code: 'plan_answer_expired', recovery: 'quiet-requote' }
    case 'invalid': return { copy: JOURNEY.review.planInvalid, code: codeOf(`plan_reply_${result.detail}`), recovery: 'none' }
    // A transport's own deadline (`timeout`, 2026-10-30, INST-2) is asked again as a dropped connection is (./run.ts).
    case 'unavailable': return { copy: 'The quote service could not be reached. Your amount is unchanged.', code: codeOf(`plan_${result.reason}`), recovery: result.reason === 'network' || result.reason === 'timeout' ? 'retry-later' : 'none', ...(result.retryAfterSeconds !== undefined ? { retryAfterSeconds: result.retryAfterSeconds } : {}) }
    case 'unsimulated': return { copy: PLAN_COPY, code: codeOf(`plan_simulation_${result.reason}`), recovery: 'none' }
    case 'reverted': {
      const decoded = result.selector ? decodeRevertData(result.selector, 'zap', { chainId, token }) : null
      if (decoded) return { copy: decoded.copy, code: decoded.dataCode, recovery: decoded.recovery }
      return { copy: GENERIC_COPY, code: 'plan_simulation_reverted', recovery: 'review-again' }
    }
    case 'refused': {
      const code = result.code
      switch (code) {
        case 'preview_expired': return { copy: EXPIRED_COPY, code, recovery: 'quiet-requote' }
        case 'position_plan_consent_unsupported': return { copy: PLAN_COPY, code, recovery: 'direct-retry' }
        case 'position_plan_pool_not_initialized': return { copy: E.position_plan_pool_not_initialized, code, recovery: 'offer-new-pool' }
        case 'position_plan_pool_initialized': return { copy: E.position_plan_pool_initialized, code, recovery: 'pool-race' }
        case 'position_plan_nothing_to_convert': return { copy: E.position_plan_nothing_to_convert, code, recovery: 'offer-both' }
        case 'invalid_request': case 'position_plan_not_owner': case 'position_plan_position_not_found':
        case 'position_plan_pool_invalid': case 'position_plan_hooked_pool': case 'position_plan_price_invalid': case 'position_plan_price_decimals_mismatch':
        case 'position_plan_range_invalid': case 'position_plan_liquidity_invalid': case 'position_plan_burn_needs_all':
        case 'position_plan_inputs_unsupported': case 'position_plan_no_route': case 'position_plan_amount_too_small':
          return { copy: E[code], code, recovery: 'none' }
        case 'position_plan_fee_not_backed': case 'upstream_invalid_response': case 'upstream_contract_mismatch': return { copy: E.planning_failed, code, recovery: 'none' }
        case 'position_plan_chain_unavailable': return { copy: E.not_available(chain), code, recovery: 'none' }
        // Changed on purpose 2026-10-30 (launch capacity, CAP-5): the session and onboarding limits too (a refusal of the
        // shared sign-in budget, not of the plan), which fell to "The planning service isn’t available yet." and were never
        // asked again: the same busy sentence, asked again quietly after a short wait or the limit's Retry-After (./run.ts).
        case 'position_plan_capacity_busy': case 'position_plan_unavailable': case 'upstream_unavailable':
        case 'request_timeout': case 'upstream_timeout':
        case 'session_rate_limited': case 'session_capacity_busy': case 'onboarding_rate_limited': case 'onboarding_capacity_busy':
          return { copy: 'The quote service is temporarily busy. Your amount is unchanged.', code, recovery: 'retry-later', ...(result.retryAfterSeconds !== undefined ? { retryAfterSeconds: result.retryAfterSeconds } : {}) }
        case 'session_required': case 'csrf_invalid': return { copy: E.session, code, recovery: 'none' }
        default: return { copy: JOURNEY.review.planUnavailable, code, recovery: 'none' }
      }
    }
  }
}

export function journeyError(error: unknown, chainId: V2ChainId, token?: (address: Address) => string): JourneyError {
  if (error instanceof JourneyNotice) return { copy: error.copy, code: error.code, recovery: 'none' }
  const labels: ErrorLabels = { chainId, token }
  const decoded = decodeV2Error(error, 'zap', labels)
  if (decoded) return { copy: decoded.copy, code: decoded.dataCode, recovery: decoded.recovery }
  const code = error instanceof ZapRefusal ? error.failures[0] ?? 'zap_refused' : error instanceof Error ? error.message : 'unknown'
  const known = /^[a-z][a-z0-9_]{0,63}$/.test(code) ? clientCopy(code, chainId) : null
  if (known) return { copy: known.copy, code, recovery: known.recovery }
  return { copy: GENERIC_COPY, code: /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'unknown', recovery: 'review-again' }
}

/** The copy of a step the wallet may have sent (F2): never offered again from this review. */
export const SENT_CHECK_WALLET = 'Sent to your wallet. Check your wallet’s activity to see how it went: nothing more is sent from here.'
export const SENT_UNKNOWN_COPY = SENT_UNKNOWN
export const STILL_PENDING = 'A transaction from this wallet is still waiting. Let it finish, then try again.'
export const REJECTED_IN_WALLET = 'I rejected it in my wallet'
