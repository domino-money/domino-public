/**
 * Every failure of the position page's Domino V2 actions said in the spec's English (F7 §2.12, §2.4's plan API table)
 * with its code for a `data-error-code` attribute, never in the text: first the V2 decoder (src/v2/errors.ts
 * decodeV2Error, context `zap`: a wallet's refusal, an unknown network, any contract's revert), then the money clients'
 * own closed codes, then the generic sentence. Copied from the S1 reference (the former src/v2ui/s1/errors.ts, with its rev2 review
 * codes F1–F4), worded with this page's copy.
 *
 * Pure: no React, no wallet.
 */
import { CONTRACTS_NOT_LIVE, contractsNotLiveCopy } from '../../finance/v2/liveLock'
import { capacityBusyWait, isCapacityBusy } from '../../finance/v2/requestCoordinator'
import { v2Chain } from '../../v2/chains'
import { versionOffChain } from '../../v2/plan/client'
import { GENERIC_COPY, decodeRevertData, decodeV2Error, type ErrorLabels, type Recovery } from '../../v2/errors'
import type { S1PlanResult } from '../../v2/plan/types'
import type { Address, V2ChainId } from '../../v2/types'
import { HOOKED_COPY, ROOT_CHANGE_RANGE_COPY, SUCCESSOR_BLOCKED_COPY } from './constants'
import { COPY } from './copy'

export interface ActionError {
  copy: string
  code: string
  /**
   * What the dialog does next: `requote` goes back to a fresh quote by itself; the plan API's own (rev2 §2.4):
   * `quiet-requote` asks again without a word (preview_expired, an answer past its expiry), `direct-retry` asks again
   * for the direct path without a word (consent_unsupported), `offer-both` offers the exit in both tokens. `retry-later`
   * (QA round 2, CAP-5b, as New position's run): a busy or rate-limited plan service, asked again by itself after its
   * Retry-After (`retryAfterSeconds`; a capacity-busy one after 4 to 5 s, retryLaterWait), twice at most, before the busy
   * sentence is said.
   */
  recovery: Recovery | 'none' | 'quiet-requote' | 'retry-later' | 'direct-retry' | 'offer-new-pool' | 'offer-both' | 'pool-race'
  /** The service's Retry-After, in whole seconds, when it named one (`retry-later`). */
  retryAfterSeconds?: number
}

/** A wallet outcome said in words (a switch the wallet refused, a network it does not know), with its code. */
export class WalletNotice extends Error {
  readonly copy: string
  readonly code: string
  constructor(copy: string, code: string) {
    super(code)
    this.name = 'WalletNotice'
    this.copy = copy
    this.code = code
  }
}

/** A closed failure code of the clients, carried by ZapRefusal (its `failures`) or a plain Error (its message). */
function codeOf(error: unknown): string {
  if (error && typeof error === 'object' && Array.isArray((error as { failures?: unknown }).failures)) {
    const first = (error as { failures: unknown[] }).failures[0]
    return typeof first === 'string' ? first : 'zap_refused'
  }
  return error instanceof Error ? error.message : 'unknown'
}

const PLAN_COPY = 'This plan can’t be executed. Review it again.'
const ROUTE_COPY = 'This plan would swap into something you didn’t ask for, so nothing was sent. Review it again.'
const EXPIRED_COPY = 'This review expired before it was confirmed. Review again for a fresh quote.'
const UNSETTLED_COPY = (chain: string) => `An earlier action was already sent to your wallet and is not settled on ${chain} yet. Check your wallet’s activity: nothing new is sent from here until this is clear. If you rejected or closed it in your wallet, say so below.`
export const REJECTED_IN_WALLET = 'I rejected it in my wallet'
const CLOSE_UNSETTLED_COPY = (chain: string) => `Closing this position was already sent to your wallet and is not settled on ${chain} yet. Check your wallet’s activity. If you rejected or closed it in your wallet, say so in Close positions.`
export const STILL_PENDING_COPY = 'A transaction from this wallet is still waiting. Let it finish, then try again.'
export const SENT_CHECK_WALLET_COPY = 'Sent to your wallet. Check your wallet’s activity to see how it went: nothing more is sent from here.'

/** The money clients' closed codes (finance/v2/zap.ts, direct.ts, transact.ts) that are not a contract's revert. */
function clientCopy(code: string, chainId: V2ChainId): { copy: string; recovery: ActionError['recovery'] } | null {
  const chain = v2Chain(chainId).name
  if (code === 'plan_route_source' || code === 'plan_route_target' || code === 'plan_target') return { copy: ROUTE_COPY, recovery: 'requote' }
  if (code === 'plan_price_moved') return { copy: 'The price moved. Review again.', recovery: 'requote' }
  if (code === 'plan_position_changed') return { copy: 'This position changed since the review. Review again.', recovery: 'requote' }
  if (code === 'plan_simulated_below_minimum') return { copy: 'The price moved: this would add less liquidity than your minimum. No tokens moved.', recovery: 'requote' }
  if (code.startsWith('plan_') && code !== 'plan_expiring' && code !== 'plan_nonce_used' && code !== 'plan_quote_expired') return { copy: PLAN_COPY, recovery: 'requote' }
  if (code.startsWith('deployment_')) return { copy: 'Domino isn’t available on this network right now.', recovery: 'disable-chain' }
  switch (code) {
    // The money lock before V2's contracts are live (finance/v2/liveLock.ts): the gate's own sentence for the chain.
    case CONTRACTS_NOT_LIVE: return { copy: contractsNotLiveCopy(chainId), recovery: 'none' }
    case 'connect_wallet': return { copy: 'Connect a wallet first.', recovery: 'none' }
    case 'wallet_wrong_chain': return { copy: `Your wallet is on another network. Switch it to ${chain}, then try again.`, recovery: 'none' }
    case 'wallet_identity_changed': case 'wallet_action_expired': return { copy: 'Your wallet changed while this was open. Review again.', recovery: 'none' }
    case 'wallet_action_busy': return { copy: 'Another request to your wallet is still open. Finish it first.', recovery: 'none' }
    case 'wallet_timeout': return { copy: 'Your wallet did not answer in time. Check it, then review again.', recovery: 'none' }
    case 'pending_wallet_transaction': case 'wallet_nonce_already_offered': return { copy: STILL_PENDING_COPY, recovery: 'none' }
    case 'plan_expiring': case 'plan_quote_expired': case 'wallet_review_expired': case 'wallet_review_required': return { copy: EXPIRED_COPY, recovery: 'requote' }
    case 'automation_pause_unacknowledged': return { copy: COPY.wallet.tickFirst, recovery: 'none' }
    case 'plan_nonce_used': case 'nonce_unavailable': return { copy: 'This signature was already used or cancelled.', recovery: 'requote' }
    case 'review_already_sent': case 'batch_already_offered': case 'wallet_batch_already_offered': return { copy: 'This was already sent to your wallet. Check its activity before doing anything else.', recovery: 'none' }
    // Added 2026-11-02 (review A1): a Close positions request with this position whose wallet answer never came. It is let
    // go once the network says it can no longer run, or in Close positions on the person's word (finance/v2/direct.ts settleLost).
    case 'close_request_unsettled': return { copy: CLOSE_UNSETTLED_COPY(chain), recovery: 'none' }
    case 'zap_action_unsettled': return { copy: UNSETTLED_COPY(chain), recovery: 'none' }
    case 'wallet_result_unknown': return { copy: COPY.wallet.sentUnknown, recovery: 'none' }
    case 'native_gas_reserve_insufficient': return { copy: `Not enough ${v2Chain(chainId).nativeSymbol} for the network fee.`, recovery: 'none' }
    case 'gas_budget_exceeded': return { copy: 'This would cost more network fee than allowed. Review again.', recovery: 'requote' }
    case 'position_not_found': return { copy: 'This position doesn’t belong to the selected pool, or it was closed.', recovery: 'reread-position' }
    case 'position_not_owned': return { copy: 'Only the wallet that holds this position can do this.', recovery: 'switch-account' }
    case 'position_pool_has_hooks': return { copy: HOOKED_COPY, recovery: 'none' }
    case 'position_already_empty': return { copy: 'This position has nothing left to withdraw.', recovery: 'none' }
    case 'pool_not_initialized': return { copy: 'This pool has no price yet.', recovery: 'other-pool' }
    case 'native_eth_refused': return { copy: `Your account can’t receive ${v2Chain(chainId).nativeSymbol} directly. Use another account.`, recovery: 'none' }
    case 'nft_approval_missing': return { copy: 'Approve Domino to manage this position first.', recovery: 'approve-position' }
    case 'batch_simulation_reverted': return { copy: GENERIC_COPY, recovery: 'requote' }
    case 'signature_journal_unavailable': case 'signature_journal_full': case 'wallet_nonce_coordination_unavailable': return { copy: 'This browser can’t keep track of your wallet requests. Use another browser.', recovery: 'none' }
    case 'invalid_slippage': return { copy: 'Choose between 0.1% and 5%.', recovery: 'fix-fields' }
    case 'position_vault_root': return { copy: ROOT_CHANGE_RANGE_COPY, recovery: 'none' }
    case 'position_vault_successor': return { copy: SUCCESSOR_BLOCKED_COPY, recovery: 'none' }
    case 'l1_fee_unavailable': return { copy: 'The network fee can’t be worked out right now. Try again in a moment.', recovery: 'none' }
    case 'invalid_liquidity': return { copy: 'Choose how much to withdraw again.', recovery: 'fix-fields' }
    case 'revoke_not_offered': return { copy: 'Domino can no longer manage this position.', recovery: 'none' }
    default: return null
  }
}

/**
 * A plan answer that is not a plan, said (rev2 §2.4's table of the plan API's codes; the server's simulation's revert
 * through the §2.12 decoder; anything this app does not accept as `invalid`).
 */
export function planFailure(result: Exclude<S1PlanResult, { kind: 'ok' }>, chainId: V2ChainId, token?: (address: Address) => string, dex?: number): ActionError {
  const chain = v2Chain(chainId).name
  const E = COPY.planErrors
  // Changed on purpose 2026-11-06 (Elysium readiness): the service's `invalid_request` for a version the chain lacks (v3
  // on a chain with v4 alone; ../../v2/plan/client.ts gives it without asking) is "Not available on {chain} right now.",
  // as a chain the planner does not serve, never asked again; any other `invalid_request` is said as before.
  if (result.kind === 'refused' && result.code === 'invalid_request' && versionOffChain(chainId, dex)) {
    return { copy: E.not_available(chain), code: 'position_plan_dex_not_on_chain', recovery: 'none' }
  }
  const tidy = (raw: string) => raw.replace(/[^a-z0-9_]/gi, '_').toLowerCase().slice(0, 64)
  switch (result.kind) {
    case 'expired': return { copy: EXPIRED_COPY, code: 'plan_answer_expired', recovery: 'quiet-requote' }
    case 'invalid': return { copy: COPY.review.planInvalid, code: tidy(`plan_reply_${result.detail}`), recovery: 'none' }
    case 'unavailable': return { copy: COPY.review.planUnavailable, code: tidy(`plan_${result.reason}`), recovery: 'none' }
    case 'unsimulated': return { copy: PLAN_COPY, code: tidy(`plan_simulation_${result.reason}`), recovery: 'none' }
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
        case 'position_plan_pool_not_initialized': return { copy: E.position_plan_pool_not_initialized, code, recovery: 'none' }
        case 'position_plan_pool_initialized': return { copy: E.position_plan_pool_initialized, code, recovery: 'none' }
        case 'position_plan_nothing_to_convert': return { copy: E.position_plan_nothing_to_convert, code, recovery: 'offer-both' }
        // (QA round 2, CAP-5b; launch study item 5) A busy planner and the session's own rate limits are one state: asked
        // again by itself after the service's Retry-After, a capacity-busy one after 4 to 5 s (./run.ts, retryLaterWait),
        // then "Busy right now. Try again in a moment." They
        // said "The planning service isn’t available yet." with nothing more, as if the feature did not exist.
        case 'position_plan_capacity_busy': case 'session_rate_limited': case 'session_capacity_busy': case 'onboarding_rate_limited':
        case 'onboarding_capacity_busy':
          return { copy: E.position_plan_capacity_busy, code, recovery: 'retry-later', ...(result.retryAfterSeconds !== undefined ? { retryAfterSeconds: result.retryAfterSeconds } : {}) }
        case 'invalid_request': case 'position_plan_not_owner': case 'position_plan_position_not_found':
        case 'position_plan_pool_invalid': case 'position_plan_hooked_pool': case 'position_plan_price_invalid': case 'position_plan_price_decimals_mismatch':
        case 'position_plan_range_invalid': case 'position_plan_liquidity_invalid': case 'position_plan_burn_needs_all':
        case 'position_plan_inputs_unsupported': case 'position_plan_no_route': case 'position_plan_amount_too_small':
          return { copy: E[code], code, recovery: 'none' }
        case 'position_plan_fee_not_backed': case 'upstream_invalid_response': case 'upstream_contract_mismatch': return { copy: E.planning_failed, code, recovery: 'none' }
        case 'position_plan_chain_unavailable': case 'position_plan_unavailable': case 'upstream_unavailable': return { copy: E.not_available(chain), code, recovery: 'none' }
        case 'request_timeout': case 'upstream_timeout': return { copy: E.request_timeout, code, recovery: 'none' }
        case 'session_required': case 'csrf_invalid': return { copy: E.session, code, recovery: 'none' }
        default: return { copy: COPY.review.planUnavailable, code, recovery: 'none' }
      }
    }
  }
}

/**
 * How long a `retry-later` refusal waits before the quote is asked again (./run.ts), `attempt` being 0 for the first quiet
 * retry and 1 for the second: 4 s, then 8 s, or the service's Retry-After when that is longer. Changed on purpose
 * 2026-10-30 (QA round 2, final review pos-run-1): a capacity-busy refusal (position_plan_capacity_busy and the like)
 * waits 4 to 5 s (finance/v2/requestCoordinator.ts capacityBusyWait), whatever Retry-After it names, as New position's
 * run does (../journey/run.ts): every one says 60 s while the planner's slot frees in a few seconds, so Add liquidity,
 * Change range and Withdraw in one token sat on their quote for two minutes at peak load. A rate limit
 * (session_rate_limited, onboarding_rate_limited) keeps its Retry-After. `random` as Math.random, for the tests.
 */
export function retryLaterWait(view: Pick<ActionError, 'code' | 'retryAfterSeconds'>, attempt: number, random: () => number = Math.random): number {
  if (isCapacityBusy(view.code)) return capacityBusyWait(random)
  return Math.max(4000 * 2 ** attempt, (view.retryAfterSeconds ?? 0) * 1000)
}

/** Any thrown failure of an action, said. */
export function actionError(error: unknown, chainId: V2ChainId, token?: (address: Address) => string): ActionError {
  if (error instanceof WalletNotice) return { copy: error.copy, code: error.code, recovery: 'none' }
  const labels: ErrorLabels = { chainId, token }
  const decoded = decodeV2Error(error, 'zap', labels)
  if (decoded) return { copy: decoded.copy, code: decoded.dataCode, recovery: decoded.recovery }
  const code = codeOf(error)
  const known = /^[a-z][a-z0-9_]{0,63}$/.test(code) ? clientCopy(code, chainId) : null
  if (known) return { copy: known.copy, code, recovery: known.recovery }
  return { copy: GENERIC_COPY, code: /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'unknown', recovery: 'review-again' }
}
