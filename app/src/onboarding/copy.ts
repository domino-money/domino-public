/**
 * Every sentence the lab's preview screen (#/live-preview, consumer-test build
 * only) says. Enums reach the screen only through these maps, never as raw
 * server text.
 *
 * Lab-only wording: the eligibility and failure sentences below name the beta
 * and this build's deployment, which only the invited testers' lab may say.
 * No product screen imports this module. The product's preview words live
 * with the screens that show them: New position's deposit amounts in
 * lib/create/copy.ts (CREATE.balance), Setup's swap quote in onboarding/swap.ts
 * and components/preview/SwapQuote.tsx. tests/consumer.bundle.test.mjs checks
 * that none of these lab sentences reaches the build that deploys.
 */
import type { UnavailableDetail } from './client'
import type { EligibilityBlock } from './controller'
import type { PreviewFailureKind } from './errors'
import type { PositionPreview, SwapPreview } from './types'

export const ELIGIBILITY_COPY: Readonly<Record<EligibilityBlock, string>> = {
  pending: 'Checking your sign-in…',
  no_wallet: 'Connect a wallet to request a live preview.',
  signed_out: 'Sign in with your wallet to request a live preview. Previews are private to your session and are cleared when you sign out.',
  wrong_network: 'Switch your wallet to Robinhood Chain (4663) to request a preview.',
  wallet_account_differs: 'Your wallet is on a different account than your session. Sign out, then sign in with this account.',
  gate_required: 'Your beta access has expired. Reload the page and enter the password again.',
  gate_unavailable: 'The site is temporarily unavailable. Try again later.',
  session_disabled: "Wallet sign-in isn't enabled on this deployment.",
  session_busy: 'The sign-in service is temporarily unavailable. Previews resume when it recovers.',
  account_unsupported:
    "This account can't use previews. Only standard wallets (EOAs) are supported; smart-contract and delegated accounts aren't yet. You've been signed out.",
  session_error: "Sign-in isn't working in this build right now. Reload the page.",
  browser_unsupported: 'This browser is too old for wallet sign-in. Update it to continue.',
  session_off: "Wallet sign-in isn't part of this build.",
  session_access_unavailable: "Live previews need a sign-in update that isn't in this build.",
}

export const FAILURE_COPY: Readonly<Record<PreviewFailureKind | 'gate_required' | 'gate_unavailable', string>> = {
  input_rejected: 'The preview service rejected these inputs. Check them and try again.',
  signed_out: 'Your session ended. Sign in again to request a preview.',
  session_recovery: 'Rechecking your sign-in. No signature is needed. Try again when it finishes.',
  account_unsupported: ELIGIBILITY_COPY.account_unsupported,
  unavailable: 'Preview unavailable. Nothing from this attempt is shown.',
  feature_unavailable: "Live previews aren't enabled on this deployment.",
  expired_before_delivery: 'This preview expired before it could be delivered. Request a new one.',
  no_route: 'No preview is available for this selection. Nothing else was tried in its place.',
  rate_limited: 'Too many preview requests. Try again in {s} s.',
  provider_unavailable: 'The price provider is unavailable right now. Try again later.',
  service_busy: "The preview service can't check your session right now. You're still signed in. Try again shortly.",
  timed_out: 'The preview request timed out. Nothing from it is shown.',
  gate_required: ELIGIBILITY_COPY.gate_required,
  gate_unavailable: ELIGIBILITY_COPY.gate_unavailable,
}

/** Only for the request-id line of an unavailable failure; never the reason itself. */
export const UNAVAILABLE_DETAIL: Readonly<Record<UnavailableDetail, string>> = {
  network: 'the connection failed',
  redirect: 'the request was redirected',
  upstream_unavailable: 'the service did not answer as the contract requires',
  contract_version: 'the service speaks another contract version',
  not_json: 'the answer was not JSON',
  too_large: 'the answer was too large',
  invalid_json: 'the answer was not valid JSON',
  response_contract: 'the answer failed the contract check',
  owner_mismatch: 'the answer was for another account',
  echo_mismatch: 'the answer was for other inputs',
  request_contract: 'this page refused to send inputs the contract rejects',
  runtime_error: 'this browser could not check the answer',
  producer: 'the service reported a problem',
}

export const EXPIRED_ON_ARRIVAL = 'This preview had already expired by the time it arrived, so its figures are hidden.'
export const EXPIRED_ON_ARRIVAL_REPEAT = 'If this keeps happening, the price service is slow right now. Try again in a minute.'
export const READY_COPY = 'Ready. Nothing is requested until you press Get preview.'
export const LOADING_COPY = 'Requesting a preview… (it stops after 27 s)'
export const PREVIEW_ONLY =
  'A provider estimate, not a quote lock, transaction or authorization. Nothing can be executed from this screen.'
export const expiredCopy = (time: string) =>
  `This preview expired at ${time}. Its figures are hidden. Request a new preview for current numbers.`

export const SWAP_REASON_COPY: Readonly<Record<SwapPreview['previewChecks']['reasons'][number], string>> = {
  price_impact_unknown: 'Price impact was not reported.',
  price_impact_exceeded: 'Price impact is above your maximum.',
  provider_output_fee_unknown: "The provider's output fee is unknown.",
  provider_output_fee_unsupported_nonzero: 'The provider reported a non-zero output fee, which is not supported.',
  simulation_unknown: 'The provider did not report a simulation result.',
  provider_simulation_failed: 'The provider reported a failed simulation.',
  gas_estimate_incomplete: 'The gas estimate is incomplete.',
}

export const POSITION_REASON_COPY: Readonly<Record<PositionPreview['previewChecks']['reasons'][number], string>> = {
  token0_maximum_exceeds_budget: 'The maximum debit of currency 0 exceeds your budget.',
  token1_maximum_exceeds_budget: 'The maximum debit of currency 1 exceeds your budget.',
  native_deposit_exceeds_balance: 'The native deposit exceeds the balance you entered.',
  native_gas_reserve_exceeded: 'The native deposit plus your gas reserve exceeds the balance you entered.',
  token0_budget_unknown: 'No budget was set for currency 0.',
  token1_budget_unknown: 'No budget was set for currency 1.',
  native_balance_unknown: 'No native balance was entered.',
  native_gas_reserve_unspecified: 'No native gas reserve was entered.',
}

export const WITHIN_LIMITS_NOTE = 'Within the limits checked. This is not a readiness check and nothing can be executed from it.'
