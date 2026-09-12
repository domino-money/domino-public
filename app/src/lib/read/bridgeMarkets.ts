/**
 * Market rows from the same-origin bridge: the provider of every deployable
 * build, and of the bridge-test build.
 *
 * read-v1 has no "top pools" route, so the rows come from a reviewed list of
 * pool ids, src/config/selectedPools.ts. The bridge-test build asks for the
 * package's fixture pool instead, which is what its local bridge stub
 * serves; that branch folds away everywhere else, and the fixture id with
 * it. Whether anything is read is the server's call: the source asks the
 * bridge's capabilities first and sends only what they list. R-1's pacing
 * and bounded busy retry are the scheduler's and the pipeline's, unchanged.
 */
import { SELECTED_POOLS } from '../../config/selectedPools'
import { BRIDGE_TEST_POOLS } from './bridgeTestPools'
import { createReadMarketsProvider } from './marketsProvider'
import { appBridgeSource } from './screens/appSourceBridge'

export function bridgeMarkets() {
  // The app's one source, shared with the read screens: the table, the
  // position lookup, the pickers and the figures dialog queue on the same
  // scheduler, so their starts are spaced the way the bridge admits reads
  // instead of each path spacing only itself.
  const source = appBridgeSource()
  const poolIds = __DOMINO_POOL_SET__ === 'selected' ? SELECTED_POOLS : BRIDGE_TEST_POOLS
  return createReadMarketsProvider({ source, poolIds, kind: 'bridge' })
}
