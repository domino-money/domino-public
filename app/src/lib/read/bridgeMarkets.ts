/**
 * Market rows from the same-origin bridge: the provider of every deployable
 * build, and of the bridge-test build.
 *
 * The deployable build's pools are the featured pools list (featuredList.ts,
 * featured pools v1 §11.1), read through the app's one source; the markets
 * of the pools it names follow it (since 2026-09-27 the first load goes out
 * beside the list's first read, for the pools this browser last read or the
 * embedded list, and starts over at once for a list with other pools,
 * marketsProvider.ts). Until it answers, and
 * whenever it cannot, the pools are the embedded list, a reviewed list of pool
 * ids in src/config/selectedPools.ts, so the page is never empty. A row whose
 * read does not bind to its list entry (another pool key, currencies or
 * integration class) is dropped, and with none left the embedded list is read
 * instead. The bridge-test build asks for the package's fixture pool instead,
 * which is what its local bridge stub serves, and never reads the list; that
 * branch folds away everywhere else, and the fixture id with it. Whether
 * anything is read is the server's call: the source asks the bridge's
 * capabilities first and sends only what they list. R-1's pacing and bounded
 * busy retry are the scheduler's and the pipeline's, unchanged.
 *
 * The deployable build keeps a copy of the last stored overview in this
 * browser (marketsPaint.ts, added 2026-09-27), which paints the rows at once
 * on the next visit while the live read is on its way.
 */
import * as publicRuntime from 'api-contracts/read-v3/runtime.mjs'
import { BRIDGE_TEST_POOLS } from './bridgeTestPools'
import { poolListOf } from './featuredList'
import { featuredStore } from './featuredSource'
import { createReadMarketsProvider } from './marketsProvider'
import { createPaintMemory } from './marketsPaint'
import { appBridgeSource } from './screens/appSourceBridge'

export function bridgeMarkets() {
  // The app's one source, shared with the read screens: the table, the
  // position lookup, the pickers and the figures dialog queue on the same
  // scheduler, so their starts are spaced the way the bridge admits reads
  // instead of each path spacing only itself.
  const source = appBridgeSource()
  if (__DOMINO_POOL_SET__ !== 'selected') return createReadMarketsProvider({ source, poolIds: BRIDGE_TEST_POOLS, kind: 'bridge', refreshMs: 60_000 })
  const pools = poolListOf(featuredStore())
  const paint = createPaintMemory(() => localStorage, publicRuntime)
  return createReadMarketsProvider({ source, poolIds: pools.ids(), pools, kind: 'bridge', refreshMs: 60_000, paint })
}
