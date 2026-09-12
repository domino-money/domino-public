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
import { appBridgeSource } from './screens/appSourceBridge'
import { deferredMarkets } from './deferredMarkets'
import type { MarketsProvider } from './marketsProvider'
import type { ReadSource } from './types'

export function appMarketsProvider(): MarketsProvider {
  if (__DOMINO_READ_MODE__ === 'fixture') {
    return deferredMarkets('fixture', () => import('./fixtureMarkets').then((m) => m.fixtureMarkets('provider')))
  }
  return bridgeMarkets()
}

let appSource: Promise<ReadSource> | null = null

/**
 * The app's one scheduled read source, loaded on first use, shared by every
 * read screen: the position lookup, the pickers and the figures dialog all
 * queue on it, so their reads are serial and spaced the way the bridge admits
 * them, and its capabilities are asked once. The landing table reads through
 * this same source; the provider above only decides which pools it asks for.
 * In the fixture build the table keeps its own fixture pipeline, which never
 * reaches a bridge at all.
 */
export function loadReadSource(): Promise<ReadSource> | null {
  if (__DOMINO_READ_MODE__ === 'fixture') {
    appSource ??= import('./screens/appSourceFixture').then((m) => m.createAppFixtureSource())
    return appSource
  }
  appSource ??= Promise.resolve(appBridgeSource())
  return appSource
}
