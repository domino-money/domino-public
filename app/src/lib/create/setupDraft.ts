/**
 * The New position choices on their way to Setup: in this page's memory
 * only, never storage or the URL, and only for the connected wallet they were
 * carried under.
 *
 * Review's "Continue in Setup" puts them here with the key of the wallet
 * connected on Robinhood Chain (lib/walletIdentity.ts walletKey, from
 * components/create/DepositAmounts.tsx), and clears them when that wallet
 * changes or disconnects from then on. Setup reads them for its own wallet key
 * and fills in its deposit; a different wallet never sees them, and reading
 * them sends nothing. They go when the deposit is funded, when the wallet
 * changes, or when another set of choices replaces them. Signing in or out
 * of the private session is not a wallet change.
 *
 * Nothing here imports the wallet feature: the key arrives as a string.
 */
import type { SetupDraft } from './journey'

let held: { draft: SetupDraft; session: string } | null = null

export function putSetupDraft(draft: SetupDraft, wallet: string) {
  held = { draft, session: wallet }
}

/** The draft carried under `wallet`. Another wallet's draft is dropped, never returned; no wallet returns nothing. */
export function setupDraftFor(wallet: string | null): SetupDraft | null {
  if (held === null || wallet === null) return null
  if (held.session !== wallet) {
    held = null
    return null
  }
  return held.draft
}

export function clearSetupDraft() {
  held = null
}

/**
 * What a pool chosen on Setup keeps of the carried choices: all of them for
 * the pool they were carried for, none for any other pool, where the deposit
 * token's index, the raw amount and the ticks would silently mean something
 * else. No choice yet keeps them.
 */
export function carriedFor(draft: SetupDraft | null, chosen: { key: string } | null): SetupDraft | null {
  return draft !== null && chosen !== null && chosen.key !== draft.pool.key ? null : draft
}
