/**
 * What the fixture build's app routes read: one reply per route, from the
 * package fixtures, through the real pipeline. It answers the questions the
 * package's own fixtures describe: NFT IDs 1 and 2^255+1, the native token and
 * 0x1111…1111, the fixture pool, and the fixture owner's address. Any other
 * question gets the bridge's 422, shown as a refused request.
 *
 * The read lab (src/lab/screensCases.tsx) scripts every other state.
 */
import type { RouteScript } from '../fixtureSource'
import { FIXTURE_TOKEN, MUTATED_CURSOR, NATIVE, gateway, withCursor, withoutHistory } from '../scenarios'

export const FIXTURE_OWNER = '0x3333333333333333333333333333333333333333'
export const FIXTURE_NFT_IDS = ['1', '57896044618658097711785492504343953926634992332820282019728792003956564819969']

export const APP_SCRIPT: RouteScript = {
  'pool-market': [{ fixture: gateway('pool-market.success'), mutate: withoutHistory }],
  'pool-metrics': [{ fixture: gateway('pool-metrics.qualified') }],
  token: [
    { fixture: gateway('token.native'), expectRequest: { token: NATIVE } },
    { fixture: gateway('token.success'), expectRequest: { token: FIXTURE_TOKEN } },
  ],
  'nft-positions': [{ fixture: gateway('nft-positions.success'), expectRequest: { tokenIds: FIXTURE_NFT_IDS } }],
  'wallet-assets': [
    { fixture: gateway('wallet-assets.opaque-page'), mutate: withCursor(MUTATED_CURSOR), expectRequest: { wallet: FIXTURE_OWNER, autoDiscover: true } },
    { fixture: gateway('wallet-assets.last-page'), expectRequest: { wallet: FIXTURE_OWNER, autoDiscover: true, cursor: MUTATED_CURSOR } },
  ],
  pools: [{ fixture: gateway('pools.success') }],
  catalogue: [{ fixture: gateway('catalogue.success') }],
  'pool-activity': [{ fixture: gateway('pool-activity.partial') }],
}
