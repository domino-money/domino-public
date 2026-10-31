import { useContext, useSyncExternalStore } from 'react'
import { agedMarket, readNow, type Instant, type Market } from '../../markets'
import { dexStore } from '../dexFigures'
import { needsFallback, withFallback } from '../figureFallback'
import { fallbackInputs } from '../useFallback'
import { MarketsContext, shownResult } from '../useMarkets'
import { marketApr, marketFigure, withMarketFigures, type MarketFigures, type PoolOption } from './poolsList'

/**
 * The Markets rows this page already holds, from the app's one markets provider, without asking it for anything (QA
 * round 2, N10): no `ensure`, so a screen that reads them never starts the Markets read itself, and nothing is added to
 * its first paint. Null while the provider holds none (a page opened straight from a link).
 */
export function useKnownMarkets(): readonly Market[] | null {
  const provider = useContext(MarketsContext)
  const state = useSyncExternalStore(provider.subscribe, provider.getSnapshot, provider.getSnapshot)
  return shownResult(state)?.markets ?? null
}

/**
 * Each row as the Markets table draws it (QA round 2, N8: one source for a pool's figures on every screen): a refused
 * figure stood in for by what is at hand (this browser's last good one, or an answer DEX Screener already gave;
 * figureFallback.ts, as useFallbackRows does), then aged on the same clock; and from that, its TVL, 24h volume and APR as
 * a New position row carries them (poolsList.ts). By pool id, lowercase. Nothing is asked for here: a stand-in that is
 * not at hand is the one Markets, Home or the pool page asks DEX Screener for. Null for no rows.
 */
export function knownMarketFigures(rows: readonly Market[] | null, now: Instant): ReadonlyMap<string, MarketFigures> | null {
  if (!rows || rows.length === 0) return null
  return new Map(rows.map((row) => [row.poolId.toLowerCase(), rowFigures(row, now)] as const))
}

/** One row's figures as the Markets table draws them (knownMarketFigures). */
function rowFigures(row: Market, now: Instant): MarketFigures {
  const shown = agedMarket(needsFallback(row, now) ? withFallback(row, fallbackInputs(row.poolId, null, now)) : row, now)
  return { liquidity: marketFigure(shown.tvlUsd), volume: marketFigure(shown.volume24hUsd), apr: marketApr(shown, now) }
}

/**
 * One pool option with the figures Markets shows for its pool (withMarketFigures), from `rows` already held; the same
 * option where they hold no row for it (or a row with nothing to show). Only that one row is worked out.
 */
export function withKnownMarket<T extends PoolOption>(option: T, rows: readonly Market[] | null, now: Instant): T {
  const key = option.key.toLowerCase()
  const row = rows?.find((candidate) => candidate.poolId.toLowerCase() === key)
  return row ? withMarketFigures([option], new Map([[option.key, rowFigures(row, now)]]))[0] ?? option : option
}

const quiet = () => () => undefined
const still = () => 0

/**
 * knownMarketFigures for the rows this page already holds, now (useKnownMarkets: nothing is asked of the provider), drawn
 * again when those rows change or DEX Screener answers for a pool. Null, with nothing worked out or followed, where the
 * screen does not want them (`wanted` false).
 */
export function useKnownMarketFigures(wanted: boolean): ReadonlyMap<string, MarketFigures> | null {
  const rows = useKnownMarkets()
  useSyncExternalStore(wanted ? dexStore.subscribe : quiet, wanted ? dexStore.version : still, wanted ? dexStore.version : still)
  return wanted ? knownMarketFigures(rows, readNow()) : null
}

/**
 * A pool option as New position's list shows it (QA round 2, N8 review): with the TVL, 24h volume and APR Markets shows
 * for its pool, whichever way the pool came in. The list merges its own rows (useKnownMarketFigures); this is for one
 * pool that did not come through it, a pool chosen from a link (#/new/<pool>, Home's row pill, the pool page, Markets) or
 * a chosen one a later read replaced, so its preview card writes the figures its list row writes. Nothing is asked, as
 * above; null for null.
 */
export function useMarketOption<T extends PoolOption>(option: T | null): T | null {
  const rows = useKnownMarkets()
  const wanted = option !== null
  useSyncExternalStore(wanted ? dexStore.subscribe : quiet, wanted ? dexStore.version : still, wanted ? dexStore.version : still)
  return option && rows ? withKnownMarket(option, rows, readNow()) : option
}
