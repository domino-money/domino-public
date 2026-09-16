/**
 * The New position choices on their way to Setup's deposit draft: in this
 * page's memory only, never storage or the URL, and only for the server
 * session they were carried under.
 *
 * Review's "Continue in Setup" puts them here with the session key of the
 * signed-in wallet (components/create/DepositAmounts.tsx), and clears them on
 * any session change from then on. Setup reads them for its own session key
 * and fills in its draft; a different session never sees them, and reading
 * them sends nothing. They go when the draft is created, when the session
 * changes, or when another set of choices replaces them.
 *
 * Nothing here imports the wallet session: the key arrives as a string.
 */
import type { SetupDraft } from './journey'

let held: { draft: SetupDraft; session: string } | null = null

export function putSetupDraft(draft: SetupDraft, session: string) {
  held = { draft, session }
}

/** The draft carried under `session`. Another session's draft is dropped, never returned; no session returns nothing. */
export function setupDraftFor(session: string | null): SetupDraft | null {
  if (held === null || session === null) return null
  if (held.session !== session) {
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
