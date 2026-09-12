import type { Snapshot } from '../../session/controller'
import type { FailureKind, SignedOutReason, SigningStep, View } from '../../session/machine'

/** English copy for every session state. Plain strings, rendered as text only. */

export const SIGNED_OUT: Record<SignedOutReason, string> = {
  none: 'Sign in to prove you control this address.',
  logged_out: 'You signed out.',
  session_ended: 'Your session ended: it expired or was revoked. Sign in again to continue.',
  identity_changed:
    'Your wallet account or network changed, so the previous session was signed out. Sign in again for this account.',
  challenge_expired: 'The sign-in request expired or was already used. Start again when you are ready.',
  signature_rejected: 'The signature did not match this address. Nothing was signed in.',
  signature_declined: 'You declined the signature request. Nothing was signed in.',
  wallet_error: 'Your wallet could not sign the message. Nothing was signed in.',
  preauth_expired: 'The sign-in window closed. Start again when you are ready.',
  lost_response: 'The sign-in response was lost, so the attempt was cancelled. Start again when you are ready.',
  signin_aborted: 'Sign-in was interrupted. Start again when you are ready.',
  signin_cancelled: 'Sign-in cancelled.',
}

export const FAILURE: Record<FailureKind, string> = {
  gate_required: 'Your beta access expired. Reload the page and enter the password again.',
  gate_unavailable: 'This site is temporarily unavailable.',
  service_disabled: 'Sign-in isn’t enabled on this deployment.',
  store_unavailable: 'The sign-in service is temporarily unavailable. This is not a problem with your wallet.',
  account_check_unavailable: 'The account check is temporarily unavailable. This is not a problem with your wallet.',
  service_unavailable: 'The sign-in service is temporarily unavailable.',
  rate_limited: 'Too many sign-in attempts. Wait a minute, then check again.',
  account_unsupported: 'This address has contract code. Only standard wallets (EOAs) can sign in for now.',
  contract_mismatch: 'The sign-in service answered in an unexpected format, so sign-in stopped.',
  untrusted_challenge:
    'The sign-in message did not match this site, address and network, so it was not sent to your wallet.',
  network_error: 'The sign-in service could not be reached.',
  timeout: 'The sign-in service took too long to answer.',
  signout_unconfirmed: 'Sign-out could not be confirmed. Try again before signing in.',
  client_error: 'Sign-in stopped because of an unexpected error in this page.',
  browser_unsupported: 'This browser is too old for wallet sign-in. Update it and reload.',
}

export const STEP: Record<SigningStep, string> = {
  bootstrap: 'Starting sign-in…',
  challenge: 'Requesting a sign-in message…',
  awaiting_signature: 'Check your wallet to sign the sign-in message.',
  verifying: 'Verifying your signature…',
  recovering: 'Checking whether sign-in completed…',
  closing: 'Closing the sign-in request…',
}

export const REFRESH_UNAVAILABLE =
  'The service could not renew your session just now. This page will try again shortly; if it cannot, the session ends after 30 minutes idle.'

export const NOT_INVITED =
  'This wallet isn’t on the invited list for the alpha. Public pages keep working. Ask the team for an invitation.'

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
}

/** One sentence for the current state, used by the dialog and the live region. */
export function describe(view: View): string {
  switch (view.status) {
    case 'starting':
      return 'Looking for your wallet…'
    case 'no_wallet':
      return 'Connect a browser wallet to sign in.'
    case 'wrong_network':
      return `Your wallet is on network ${view.chainId}. Sign-in works on Robinhood Chain (4663) only.`
    case 'checking':
      return 'Checking for an existing session…'
    case 'signed_out':
      return SIGNED_OUT[view.reason]
    case 'signing_in':
      return STEP[view.step]
    case 'signed_in':
      return view.notice === 'refresh_unavailable'
        ? `Signed in as ${shortAddress(view.owner)}. ${REFRESH_UNAVAILABLE}`
        : `Signed in as ${shortAddress(view.owner)}.`
    case 'other_session':
      return `This browser is signed in as ${shortAddress(view.owner)}, not the connected account. Sign that session out to continue.`
    case 'not_invited':
      return NOT_INVITED
    case 'signing_out':
      return 'Signing out…'
    case 'blocked':
      return FAILURE[view.failure]
  }
}

/** What the header's live region says. Silent while the wallet is still being found. */
export function announcement({ view }: Snapshot): string {
  return view.status === 'starting' ? '' : describe(view)
}
