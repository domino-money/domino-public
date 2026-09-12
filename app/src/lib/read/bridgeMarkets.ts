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
import { CAPABILITIES } from '../capabilities'
import { BRIDGE_TEST_POOLS } from './bridgeTestPools'
import { createBridgeSource } from './bridgeSource'
import { READ_RUNTIME } from './contract'
import { createReadMarketsProvider } from './marketsProvider'
import { createScheduledSource } from './scheduler'

export function bridgeMarkets() {
  const source = createScheduledSource(createBridgeSource({ enabled: CAPABILITIES.liveReadsBuilt, validators: READ_RUNTIME }))
  const poolIds = __DOMINO_POOL_SET__ === 'selected' ? SELECTED_POOLS : BRIDGE_TEST_POOLS
  return createReadMarketsProvider({ source, poolIds, kind: 'bridge' })
}
