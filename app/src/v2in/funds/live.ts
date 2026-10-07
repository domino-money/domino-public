/**
 * The page's parts of the offer (./services.ts FundsPage, src/v2/gate.ts S2Routes): the probe of the routes' capabilities
 * the S2 gate asks whether the crosschain route is on, and, for a live chain, the HTTP transport over the site's own route
 * and the signed-in session's CSRF, and the page's monotonic clock (src/finance/v2/http.ts), with the package runtime
 * (src/v2/crosschain/contract.ts). Imported by ./FundsAmounts.tsx alone, which hands them to s2Gate and fundsServices, as
 * src/v2in/transports.ts hands the page's routes to src/v2in/dataSource.ts: the node tests compile it and never load it
 * (its imports reach the wallet session and the package runtime). Nothing here is a fixture.
 */
import { liveClock, liveCrosschainSession, liveCrosschainTransport, v2RouteProbe } from '../../finance/v2/http'
import { CROSSCHAIN_RUNTIME } from '../../v2/crosschain/contract'
import type { S2Routes } from '../../v2/gate'
import { readChainBalances } from '../../v2/read/v6'
import { routeServes, type V2RouteProbe } from '../../v2/routes'
import { v2Transports } from '../transports'
import { balanceSnapshot } from './reconcile'
import type { FundsPage } from './services'

/** The offer's one probe of the routes' capabilities (a settled answer kept a minute; src/v2/routes.ts). */
let probe: V2RouteProbe | null = null
export const fundsRoutes: S2Routes = () => Promise.resolve((probe ??= v2RouteProbe()))

export const fundsPage: FundsPage = {
  live: () => ({ transport: liveCrosschainTransport(), runtime: CROSSCHAIN_RUNTIME, session: liveCrosschainSession(), clock: liveClock }),
  async balances(gate, owner, chainId, tokens) {
    const transports = v2Transports(gate)
    if (!transports || !routeServes(await transports.routeState('readV6'), 'chain-balances')) return { kind: 'unavailable' }
    return balanceSnapshot(await readChainBalances(transports.read, transports.readRuntime, owner, tokens.map((address) => ({ chainId, address }))), owner, chainId, tokens)
  },
}
