import type { SessionKind } from '../session/port'

/**
 * What Managed positions and Receipts say while there is no session to read them with (2026-10-01, audit D2): the reason
 * itself, in plain words, and the one thing the person can do about it here, if any. Every visitor used to be told "Sign
 * in with your wallet…", while the header said sign-in was unavailable and the card had no button.
 *
 * `action`: the card's button, which opens the header's wallet dialog where signing in happens: Sign in, as the audit
 * asks, and Open wallet for a session of another account, which only that dialog can end. Connecting a wallet and
 * switching its network keep the controls Positions already has for them (the header's, and the list's own empty
 * state), so neither card adds a third. Null when there is nothing to do here (sign-in switched off or failing, a
 * contract wallet).
 *
 * `both` (2026-10-01, the D2 follow-up): the one line Positions shows for the two cards at once, when neither has
 * anything to show for the same reason (lib/automationCards.ts).
 */
export function signedOutLine(kind: SessionKind, what: 'receipts' | 'managed' | 'both' | 'history'): { text: string; action: 'Sign in' | 'Open wallet' | null } {
  const things = what === 'history' ? 'more automation history' : what === 'receipts' ? 'your receipts' : what === 'managed' ? 'your automated positions' : 'your automated positions and their receipts'
  switch (kind) {
    case 'no_wallet':
      return { text: `Connect a wallet to see ${things}.`, action: null }
    case 'signed_out':
      return { text: `Sign in with your wallet to see ${things}.`, action: 'Sign in' }
    case 'wrong_network':
      return { text: `Switch your wallet to Robinhood Chain to see ${things}.`, action: null }
    case 'wallet_account_differs':
      return { text: `This browser is signed in with another account. Sign it out in your wallet menu to see ${things}.`, action: 'Open wallet' }
    case 'account_unsupported':
      return { text: `Contract wallets can’t sign in yet, so ${things} can’t be shown for this address.`, action: null }
    case 'off':
    case 'session_disabled':
      return { text: `${things.charAt(0).toUpperCase()}${things.slice(1)} will show here once wallet sign-in is available.`, action: null }
    default:
      return { text: `Sign-in is unavailable right now, so ${things} can’t be shown.`, action: null }
  }
}

/** Opens the header's wallet dialog, where the action happens. */
export const openWalletDialog = () => document.querySelector<HTMLButtonElement>('header [aria-haspopup="dialog"]')?.click()

/** Explicit inline Sign in actions share the header's single attempt. Connection remains a separate choice. */
export const signInWithWallet = () => {
  const signIn = document.querySelector<HTMLButtonElement>('header [data-wallet-signin]')
  if (signIn) signIn.click()
  else openWalletDialog()
}
