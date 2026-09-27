/**
 * Market rows from the same-origin bridge: the provider of every deployable
 * build, and of the bridge-test build.
 *
 * The deployable build's pools are the featured pools list (featuredList.ts,
 * featured pools v1 §11.1): the list is read first, through the app's one
 * source, and then the markets of the pools it names. Until it answers, and
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
 */
import { BRIDGE_TEST_POOLS } from './bridgeTestPools'
import { poolListOf } from './featuredList'
import { featuredStore } from './featuredSource'
import { createReadMarketsProvider } from './marketsProvider'
import { appBridgeSource } from './screens/appSourceBridge'

export function bridgeMarkets() {
  // The app's one source, shared with the read screens: the table, the
  // position lookup, the pickers and the figures dialog queue on the same
  // scheduler, so their starts are spaced the way the bridge admits reads
  // instead of each path spacing only itself.
  const source = appBridgeSource()
  if (__DOMINO_POOL_SET__ !== 'selected') return createReadMarketsProvider({ source, poolIds: BRIDGE_TEST_POOLS, kind: 'bridge', refreshMs: 60_000 })
  const pools = poolListOf(featuredStore())
  return createReadMarketsProvider({ source, poolIds: pools.ids(), pools, kind: 'bridge', refreshMs: 60_000 })
}
