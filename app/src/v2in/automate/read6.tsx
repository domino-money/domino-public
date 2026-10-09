import { useEffect, useMemo, useRef } from 'react'
import type { ActivityResponse, PortfolioResponse } from 'api-contracts/read-v6/types'
import { v2OriginOpen, type V2Gate } from '../../v2/gate'
import { readActivity, readPortfolio, type ReadV6Reply } from '../../v2/read/v6'
import { routeServes, type V2RouteOff } from '../../v2/routes'
import type { Address } from '../../v2/types'
import { v2Transports } from '../transports'
import { useKeyed } from '../lists/hooks'
import { OWN_PORTFOLIO } from '../lists/source'
import type { ListsReply } from '../lists/read'

/**
 * The integrated automation screens' one way to read read-v6 (spec F7 rev2 §6.2; decision #9: lists and history come
 * from the V2 read API, never from a chain read of the root NFT, rev3 §5.6), through the integration's shared transports
 * (src/v2in/transports.ts, chosen by the chain's gate; every answer passes the package's own validator,
 * src/v2/read/v6.ts). Changed on purpose (data) 2026-10-02 (the owner: real data only, no test data): under `preview`
 * and `live` alike, the site's read route (`/api/read/v6/portfolio|activity`), about the connected wallet, asked only
 * while its capabilities say it serves; until then `unavailable` (`route_not_available`, the probe's reason kept in
 * `off`), a dash with its reason, never zeros; a route simply not on yet (`routeQuiet`) is nothing to say on screen.
 * Nothing is read without a connected wallet. A TEST build's suite scripts the answers (`window.__dominoV2Test.read6`),
 * under either mode, about the connected wallet.
 */

export interface Read6<T> {
  reply: ListsReply<T>
  /** The wallet the answer is about: the connected one. */
  wallet: Address
  /** Under `live`, why the route was not asked (its capabilities: off, not deployed, unreadable now). */
  off?: V2RouteOff
}

type Route = 'portfolio' | 'activity'

async function read<T>(route: Route, connected: Address | null, gate: V2Gate, page: { limit?: number; cursor?: string }): Promise<Read6<T> | null> {
  const transports = v2Transports(gate)
  if (!transports) return null
  const wallet = connected?.toLowerCase() as Address | undefined
  if (!wallet) return null
  const state = await transports.routeState('readV6')
  if (!routeServes(state, route)) {
    return { reply: { kind: 'unavailable', reason: 'route_not_available' }, wallet, off: state.on ? 'disabled' : state.reason }
  }
  const reply = (route === 'portfolio'
    ? await readPortfolio(transports.read, transports.readRuntime, wallet)
    : await readActivity(transports.read, transports.readRuntime, wallet, page)) as ReadV6Reply<T>
  return { reply, wallet }
}

/** A read not made because the route is simply not on yet (before the deploy): nothing to say on screen. */
export const routeQuiet = (answer: Read6<unknown> | null): boolean => answer?.off === 'disabled' || answer?.off === 'not_deployed'

export const portfolioFor = (connected: Address | null, gate: V2Gate): Promise<Read6<PortfolioResponse> | null> => read('portfolio', connected, gate, {})
export const activityFor = (connected: Address | null, gate: V2Gate, page: { limit?: number; cursor?: string } = {}): Promise<Read6<ActivityResponse> | null> => read('activity', connected, gate, page)

/**
 * The portfolio for the connected wallet under a chain's gate (see above), read again whenever `version` moves (after
 * something the page did). The last answer for the same wallet and mode stays while the next is read (no flash of a dash
 * between two good answers); another wallet's is never shown. Null until the first arrives, with the gate off or not
 * known yet, and under `live` with no wallet connected.
 */
export function usePortfolio(connected: Address | null, gate: V2Gate | null, version = 0): Read6<PortfolioResponse> | null {
  const who = connected ? (connected.toLowerCase() as Address) : null
  // The gate still belongs to the caller's writes. Public state is shared even when those writes are paused.
  void gate
  const key = who && v2OriginOpen(typeof location === 'undefined' ? '' : location.origin) ? who : null
  const reply = useKeyed(OWN_PORTFOLIO, key)
  const previous = useRef({ key, version })
  useEffect(() => {
    if (key && previous.current.key === key && previous.current.version !== version) OWN_PORTFOLIO.again(key)
    previous.current = { key, version }
  }, [key, version])
  return useMemo(() => key && reply ? { wallet: key, reply } : null, [key, reply])
}
