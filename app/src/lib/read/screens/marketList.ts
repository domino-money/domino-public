/**
 * Which pools the landing reads, and how much that may cost.
 *
 * read-v1 has no market-list route: pool-market is a per-pool read (#13).
 * The table therefore reads a short, fixed list and never fans out over the
 * sample rows, four of which carry made-up pool ids. Both read builds use the
 * package's fixture pool: the fixture build serves it from the package, and
 * the bridge-test build talks only to a local stub that serves the same
 * package fixtures. A curated live list is an open question for rugged97.
 */
export type ReadMode = 'fixture' | 'bridge'

export const FIXTURE_MARKET_POOL = '0x0911afcb281d7bcae2d71443ceaeebd0f89b4537708449970d797622b4b4c941'

/** The sample rows' placeholder ids. Never requested. */
export const PLACEHOLDER_POOL_IDS: readonly string[] = ['a2', 'a3', 'a4', 'a5'].map((tail) => `0x${'0'.repeat(62)}${tail}`)

/** At most this many pools on one landing load. */
export const MARKET_POOL_BUDGET = 5
/**
 * pool-market and the two currencies' token reads, shared across rows. The
 * table asks for no pool-metrics: F3 dropped it from this path, so the ceiling
 * is three reads a pool, not four (marketsProvider.ts says the same).
 */
export const READS_PER_POOL = 3

const LISTS: Record<ReadMode, readonly string[]> = {
  fixture: [FIXTURE_MARKET_POOL],
  bridge: [FIXTURE_MARKET_POOL],
}

export function marketPoolIds(mode: ReadMode): string[] {
  const ids = LISTS[mode].filter((id) => !PLACEHOLDER_POOL_IDS.includes(id.toLowerCase()))
  return ids.slice(0, MARKET_POOL_BUDGET)
}
