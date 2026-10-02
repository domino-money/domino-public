import type { Snapshot } from '../../session/controller'
import type { FailureKind, SignedOutReason, SigningStep, View } from '../../session/machine'
import { networkName } from '../../lib/networkName'

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
  gate_required: 'Your site access expired. Reload the page and enter the password again.',
  gate_unavailable: 'This site is temporarily unavailable.',
  service_disabled: 'Sign-in is unavailable right now. Public pages keep working.',
  store_unavailable: 'The sign-in service is temporarily unavailable. This is not a problem with your wallet.',
  account_check_unavailable: 'The account check is temporarily unavailable. This is not a problem with your wallet.',
  service_unavailable: 'The sign-in service is temporarily unavailable.',
  rate_limited: 'Too many sign-in attempts. Wait a minute, then check again.',
  account_unsupported: "This address is a contract wallet, which can't sign in yet. Standard wallet accounts can, including ones upgraded to a smart account.",
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

/** The Connect dialog on a computer when no browser wallet has announced itself (through EIP-6963 or window.ethereum). */
export const NO_BROWSER_WALLET = 'No browser wallet found. Install or unlock a wallet extension, then open this again.'

/**
 * The Connect dialog on a phone with no wallet in its browser (2026-10-01, audit C4): an extension cannot be installed
 * there, so the site is opened in a wallet app's own browser instead, where the beta's access password is asked again.
 */
// Changed on purpose 2026-10-01 (fix round 1): "this site", which the links open (wallet/appLinks.ts), the preview too.
export const OPEN_IN_WALLET_APP = 'Open this site in your wallet app’s browser, then connect there.'
export const OPEN_IN_WALLET_APP_NOTE = 'You’ll enter the site’s access password again there. Using Rabby or another wallet app? Open this site in its own browser.'
/** WalletConnect's row and what its pairing says (wallet/walletConnect.ts, WalletConnectPanel.tsx). */
export const WALLETCONNECT = {
  rowHint: 'A wallet on your phone',
  scan: 'Scan this code with your phone’s wallet app.',
  open: 'Open your wallet app to approve the connection.',
  starting: 'Starting WalletConnect…',
} as const

/** Outcomes of Connect, in words (wallet/port.ts ConnectOutcome). `name` is the wallet's own, shortened. */
export function connectNotice(outcome: 'user_rejected' | 'pending' | 'error', name: string): string {
  if (outcome === 'user_rejected') return 'Your wallet declined the connection request.'
  if (outcome === 'pending') return `A request is already waiting in ${name}. Open it to approve or reject.`
  return 'Your wallet could not connect.'
}

/** While a connection waits for the wallet (audit C7): which wallet to open. */
export const approveIn = (name: string) => `Open ${name} to approve the connection.`

/** Outcomes of "Switch to Robinhood Chain" in words: kept beside the switch itself (wallet/port.ts), shared with the money screens. */
export { SWITCH_NOTICE } from '../../wallet/port'

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
}

/** One sentence for the current state, used by the dialog and the live region. */
export function describe(view: View): string {
  switch (view.status) {
    case 'starting':
      return 'Looking for your wallet…'
    case 'no_wallet':
      return ''
    case 'wrong_network':
      // Changed on purpose 2026-10-01 (audit E6): the network by its name, never its number, and what Domino needs.
      return `Your wallet is on ${networkName(view.chainId)}. Domino works on Robinhood Chain. Switch to continue.`
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
