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

let appMarkets: MarketsProvider | null = null

/**
 * The app's one markets provider, made on first use: main.tsx may start its first load before the app renders (speed
 * wave, item 9, 2026-09-28), and the app's own first render takes the same one.
 */
export function appMarketsProvider(): MarketsProvider {
  if (appMarkets) return appMarkets
  if (__DOMINO_READ_MODE__ === 'fixture') {
    return (appMarkets = deferredMarkets('fixture', () => import('./fixtureMarkets').then((m) => m.fixtureMarkets('provider'))))
  }
  return (appMarkets = bridgeMarkets())
}

/**
 * Home's and Markets' first load, started as the script runs rather than once the page has rendered and committed
 * (0.07 s on a laptop, 0.33 s on a phone, measured by the speed study). Until their table renders and holds the quiet
 * re-asks itself, this holds them, so the first answer is read as the table will read it; it lets go after 10 s.
 */
export function startMarkets(): void {
  const markets = appMarketsProvider()
  markets.ensure()
  const release = markets.recoverQuietly?.()
  if (release) setTimeout(release, 10_000)
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
