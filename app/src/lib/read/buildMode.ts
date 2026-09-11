/**
 * The markets provider this build uses, chosen at build time.
 *
 * `__DOMINO_READ_MODE__` is a constant, so in the default build both branches
 * below fold away and the dynamic imports with them: no validator, fixture,
 * fetch or bridge code is emitted into dist. Fixture and bridge-test builds
 * load their provider on first use and render a loading state until then.
 */
import { deferredMarkets } from './deferredMarkets'
import { sampleMarkets, type MarketsProvider } from './marketsProvider'

export function appMarketsProvider(): MarketsProvider {
  if (__DOMINO_READ_MODE__ === 'fixture') {
    return deferredMarkets('fixture', () => import('./fixtureMarkets').then((m) => m.fixtureMarkets('qualified')))
  }
  if (__DOMINO_READ_MODE__ === 'bridge') {
    return deferredMarkets('bridge', () => import('./bridgeMarkets').then((m) => m.bridgeMarkets()))
  }
  return sampleMarkets
}
