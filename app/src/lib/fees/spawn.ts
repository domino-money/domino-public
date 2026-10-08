/**
 * The page's one fees store (DESIGN-V2 §15.4), over the site's two fees routes (client.ts chainState and chainLedger),
 * this browser's copies of verified histories (historyCache.ts) and of its own reads of each position (readings.ts).
 *
 * Changed on purpose 2026-10-02 (RPC-SPEC §11.4, rugged97's rule 2): there is no replay worker any more. A history is the
 * position's own ledger, read at the edge (functions/_lib/feesLedger.ts) and folded here (ledger.ts). And (the same day,
 * the chart's periods back) the page's reads of a position at past blocks for a period's start (pastReads.ts).
 *
 * No unit-tested module imports this file: `import.meta` and the build's flags do not compile under the tests'
 * CommonJS config. The store's logic is tested through createFeesStore with fake reads.
 */
import { chainLedger, chainState } from './client'
import { createFeesStore } from './store'
import { whenVisibleAfter } from '../read/screens/quietRead'
import { readWithin } from '../read/screens/screenRead'
import { loadReadSource } from '../read/buildMode'
import { createHistoryCache } from './historyCache'
import { createPastReads, type PastOutcome } from './pastReads'
import { createReadings } from './readings'

const storage = () => {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

const timer = (ms: number, run: () => void) => {
  const id = setTimeout(run, ms)
  return () => clearTimeout(id)
}
const readings = createReadings(storage)

export const feesStore = createFeesStore({
  historyCache: createHistoryCache(storage),
  readings,
  // The chart's period starts too old for the readings to keep (a 30D start), held for the visit.
  pastReadings: (id) => pastReads.held(id),
  postState: (tokenIds, signal, background) => chainState(tokenIds, signal, background === true),
  postLedger: (tokenIds, fresh, signal, mintHints) => chainLedger(tokenIds, fresh, signal, mintHints),
  later: whenVisibleAfter,
  timer,
})

/**
 * 2026-10-02 (the chart's periods back): a position's state at a past block, from read-v1 `nft-positions` through the
 * page's one scheduled read source (its pacing and its budget, shared with every other read), for a period's start or a
 * fill (pastReads.ts). Nothing is asked where the source does not list the route.
 */
export const pastReads = createPastReads({
  async listed() {
    const source = await loadReadSource()
    if (!source?.routeEnabled) return false
    const check = await source.routeEnabled('nft-positions')
    return check.state === 'enabled' ? true : check.state === 'not_enabled' ? false : null
  },
  async read(id, block, signal): Promise<PastOutcome> {
    const source = await loadReadSource()
    if (!source) return { state: 'unavailable' }
    return readWithin(source, 'nft-positions', { tokenIds: [id], blockNumber: block }, { signal })
  },
  view: (id) => feesStore.view(id),
  watch: (id, listener) => feesStore.watch([id], listener),
  keep: (id, reading, now) => readings.insert(id, reading, now),
  redraw: (id) => feesStore.redraw(id),
  later: whenVisibleAfter,
  timer,
  now: () => performance.now(),
})
