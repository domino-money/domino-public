/**
 * Managed positions and Receipts on Positions, read together (2026-10-01, audit D2: with nothing to show, the two cards
 * were two large empty plates saying the same thing twice). Each card (screens/Performance.tsx, screens/Execution.tsx)
 * tells the page what it has to show; when neither has anything, for the same reason, the page draws one calm line for
 * both in their place (screens/Positions.tsx), and keeps both cards mounted, hidden, so they go on reading and take
 * their place again the moment either has something.
 *
 * Plain data and plain functions: no session, wallet or finance code, so Positions may use them.
 */

/**
 * The one line for both cards once signed in, when neither has anything yet. Changed on purpose 2026-10-01 (integration
 * pass 3, the copy review): shorter, and "here" once.
 */
export const NOTHING_YET_BOTH = 'Nothing here yet. Turn on Auto-compound for a position to follow it and its receipts here.'

/** The one line for both cards in a build that cannot sign in (the fixture and bridge test builds). */
export const NO_SIGN_IN_BOTH = 'Wallet sign-in isn’t available here, so automated positions and their receipts can’t be shown.'

/**
 * What a card has to show:
 * - `content`: anything a person can use (rows, a tracking offer);
 * - `none`: nothing, known: no session (`reason` is the session's kind), or signed in and nothing yet (`empty`); `text`
 *   and `action` are the one line for both cards and its button;
 * - `other`: a line of its own that is not "nothing" (a history or a receipts list that could not be read): never merged.
 * Null: not known yet (the card's chunk loading, the session being checked).
 */
export type CardShows = { kind: 'content' } | { kind: 'other' } | { kind: 'none'; reason: string; text: string; action: 'Sign in' | 'Open wallet' | null }

/** Whether two answers say the same, so a card that tells the page again on each render changes nothing. */
export function sameShows(a: CardShows | null, b: CardShows | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind !== 'none' || b.kind !== 'none') return a.kind === b.kind
  return a.reason === b.reason && a.text === b.text && a.action === b.action
}

/**
 * How Positions draws the two cards: `split` (both cards, as before), or `merged` with the one line (`line` null while
 * either card has not said yet: nothing is drawn under the title meanwhile, so neither card's empty plate flashes in
 * first). Split as soon as either card has something, or they have nothing for different reasons.
 */
export function automationLayout(managed: CardShows | null, receipts: CardShows | null): { kind: 'split' } | { kind: 'merged'; line: Extract<CardShows, { kind: 'none' }> | null } {
  if (managed?.kind === 'content' || managed?.kind === 'other' || receipts?.kind === 'content' || receipts?.kind === 'other') return { kind: 'split' }
  if (managed?.kind === 'none' && receipts?.kind === 'none') return managed.reason === receipts.reason ? { kind: 'merged', line: managed } : { kind: 'split' }
  return { kind: 'merged', line: null }
}
