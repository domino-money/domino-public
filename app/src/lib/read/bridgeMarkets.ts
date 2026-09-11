/**
 * Market rows from the same-origin bridge, for the bridge-test build only.
 *
 * read-v1 has no "top pools" route: pools and catalogue both need a token. A
 * live table therefore needs a curated list of pool ids, which belongs to #13.
 * Until it exists this build asks for the package's fixture pool, which is
 * what the local bridge stub in tests/read-bridge.browser.test.mjs serves.
 */
import { CAPABILITIES } from '../capabilities'
import { createBridgeSource } from './bridgeSource'
import { READ_RUNTIME } from './contract'
import { createReadMarketsProvider } from './marketsProvider'
import { createScheduledSource } from './scheduler'

const BRIDGE_TEST_POOLS = ['0x0911afcb281d7bcae2d71443ceaeebd0f89b4537708449970d797622b4b4c941']

export function bridgeMarkets() {
  const source = createScheduledSource(createBridgeSource({ enabled: CAPABILITIES.liveDataEnabled, validators: READ_RUNTIME }))
  return createReadMarketsProvider({ source, poolIds: BRIDGE_TEST_POOLS, kind: 'bridge' })
}
