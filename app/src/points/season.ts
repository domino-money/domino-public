/**
 * Season 1 of Domino points (the owner's campaign of 6-7 Nov 2026, rugged97's PR #467: backend/points_season_1.json),
 * as the Points page needs it before any answer of the points service: its window and its length in days. The service
 * names the same season in every `points` answer (api-contracts/points-v1 `season`); these are the app's own copy, so the
 * page can say when the season starts while the service is off or nobody is signed in. tests/points-format.test.mjs holds
 * them equal to the season's file.
 *
 * Pure: no clock of its own. The page hands in the time it reads (screens/Points.tsx `now`).
 */

export const SEASON_1 = Object.freeze({
  id: 'points-s1',
  title: 'Season 1',
  /** 9 Nov 2026, 00:00 UTC. */
  startMs: Date.UTC(2026, 10, 9),
  /** 9 Feb 2027, 00:00 UTC: the first moment outside the season. */
  endMs: Date.UTC(2027, 1, 9),
})

const DAY_MS = 86_400_000

/** How many days the season has: 92. */
export const SEASON_DAYS = Math.round((SEASON_1.endMs - SEASON_1.startMs) / DAY_MS)

/** Where `nowMs` stands against the season's window. */
export type SeasonPhase = 'before' | 'during' | 'after'

export function seasonPhase(nowMs: number): SeasonPhase {
  if (nowMs < SEASON_1.startMs) return 'before'
  return nowMs < SEASON_1.endMs ? 'during' : 'after'
}

/** The season's day a moment falls on, 1 to SEASON_DAYS, or null outside the season. */
export function seasonDay(nowMs: number): number | null {
  if (seasonPhase(nowMs) !== 'during') return null
  return Math.floor((nowMs - SEASON_1.startMs) / DAY_MS) + 1
}
