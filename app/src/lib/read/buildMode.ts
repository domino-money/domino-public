/**
 * The markets provider this build uses, chosen at build time.
 *
 * `__DOMINO_READ_MODE__` is a constant. Every deployable build reads through
 * the same-origin bridge, imported statically so dist stays one script, and
 * the fixture branch folds away with the fixture pipeline, catalogue and
 * scenarios it imports. The fixture build loads its provider on first use
 * and renders a loading state until then. No build has sample rows to fall
 * back on: there are none.
 */
import { bridgeMarkets } from './bridgeMarkets'
import { deferredMarkets } from './deferredMarkets'
import type { MarketsProvider } from './marketsProvider'

export function appMarketsProvider(): MarketsProvider {
  if (__DOMINO_READ_MODE__ === 'fixture') {
    return deferredMarkets('fixture', () => import('./fixtureMarkets').then((m) => m.fixtureMarkets('provider')))
  }
  return bridgeMarkets()
}
