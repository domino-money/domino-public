/**
 * Added (2026-10-15, pack 8; incident design 2.5, limits item 3, package Q3, client side): every wait this page derives from
 * a Retry-After, or from a 429 or a "busy" answer that names none, gets 0 to 25% more at random, so the thousands of tabs
 * one refusal reaches at once do not all come back in the same second. Only ever added: a wait is never shorter than the
 * one the server named. No limit and no constant changes here; the server's limiters are as they were.
 *
 * Callers: lib/edge/chainRoutes.ts (every chain route's refusal: the fees store's state and ledger, the confirmation
 * reads, the automation and wallet reads), lib/edge/confirmation.ts (the edge's "busy"), lib/fees/pastReads.ts, the
 * read-v6 readers (v2in/lists/read.ts readAgainAfter, v2in/lists/activityHistory.ts, v2in/funds/reconcile.ts), the read
 * cards (lib/read/cardReads.ts, lib/read/cardSeries.ts) and the token pictures (lib/tokenArtwork.ts). The read gateway's
 * own retry paths (lib/read/pipeline.ts, screens/transient.ts, screens/quietRead.ts, marketsProvider.ts) had theirs.
 */

/** The most added to a wait, as a share of it. */
export const JITTER_SHARE = 0.25

/**
 * `ms` and up to JITTER_SHARE of it more, at random; never less than `ms`. A wait that is not a positive finite number is
 * handed back as it came. `random` returns a number in [0, 1), as Math.random does (read at each call, so a test may seed it).
 */
export function jittered(ms: number, random: () => number = Math.random): number {
  if (!Number.isFinite(ms) || ms <= 0) return ms
  const draw = random()
  const share = Number.isFinite(draw) ? Math.min(Math.max(draw, 0), 1) : 0
  return ms + Math.floor(ms * JITTER_SHARE * share)
}
