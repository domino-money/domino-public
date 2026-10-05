/**
 * Where and how Domino's V2 options appear inside the existing screens (the owner, 2026-10-02: V2 is an integration into
 * the screens that already exist, never a separate UI; spec F7 rev3's rules bind, its UI suggestions yield).
 *
 * Three answers per service and chain:
 *   - `off`: the build carries no V2 (`__DOMINO_V2__` false, nothing of V2 is even bundled), or the page is served
 *     anywhere but the site, the gated preview alias and the local development server (chains/elysium/mode.ts; Changed
 *     on purpose 2026-10-04, the owner: production runs on V2, so domino.money is one of them), or the chain is not one
 *     V2 serves. The screen is exactly V1's.
 *   - `live`: the chain has a pinned, production-admitted deployment manifest AND the backend says the service is on:
 *     the service's own route serving now (Changed on purpose (data) 2026-10-03, the owner: nothing pending on our side
 *     once rugged97 switches his side on; spec §1.1's capability pattern): S1's plan route for S1, read-v6 for the
 *     vault and auto-exit (switched on together with the automation, items 3a/3b), asked of the probe the caller hands
 *     in; the table in ./capabilities.ts stands in only where no probe is handed in. The V2 option then runs for real,
 *     through the closed money clients.
 *   - `preview`: before the backend's word: the option is visible and runs up to the review, locked, the screen saying so
 *     in plain words (`lockedCopy`). On the chain's pinned production set in a deployable build (Changed on purpose
 *     2026-10-04: every chain is pinned); on the FIXTURE set in preview-v2 and the test builds, loaded lazily so only their
 *     chunk carries it, where the closed money modules (finance/v2/liveLock.ts) refuse every send and signature as well.
 *
 * S2, deposits from another network (Changed on purpose (data) 2026-10-02 (S2 wired), spec F7 §3.1: "no Domino contract
 * on any chain"), is the one service whose `live` needs no manifest: its word is the crosschain route's own capabilities
 * (./routes.ts, the Worker's GET), asked of a probe the caller hands in (`s2Gate` below; the offer hands the page's,
 * src/v2in/funds/live.ts, since this module may not reach the page's routes itself: tests/session.source-guard.test.mjs);
 * `preview` otherwise, where the inline offer runs locked (src/v2in/funds). Every other service's gate is exactly as above.
 *
 * Pure apart from the lazy fixture import (fixture builds only); the origin is handed in (default: the page's), and so is
 * S2's probe.
 */
import { DEV_ORIGIN, PREVIEW_ALIAS, SITE_ORIGIN } from '../chains/elysium/mode'
import { serviceAvailability, type V2Service } from './capabilities'
import { isV2ChainId, v2Chain } from './chains'
import { V2_ON } from './flag'
import { v2Availability } from './manifest'
import { routeServes, type V2RouteProbe, type V2RouteState } from './routes'
import type { V2ChainId, V2Contracts } from './types'

export type V2Gate =
  | { readonly mode: 'off' }
  | { readonly mode: 'preview'; readonly chainId: V2ChainId; readonly contracts: V2Contracts; readonly locked: true; readonly lockedCopy: string }
  | { readonly mode: 'live'; readonly chainId: V2ChainId; readonly contracts: V2Contracts; readonly locked: false }

const OFF: V2Gate = Object.freeze({ mode: 'off' })

/**
 * What a browser suite hands a TEST build (`__DOMINO_TEST_HOOKS__`, never a deployable or preview build: there the
 * define folds this to nothing): `originOpen` opens the gate on the test server's origin; `contracts` + `backendOn` make
 * a chain `live` on a fake chain's contract set, so the suites exercise the real sends against fake chains (every
 * service but S2, which has no contracts: its gate is the crosschain route's word, which a suite's server answers).
 */
export interface V2GateTestHooks {
  originOpen?: boolean
  contracts?: Partial<Record<V2ChainId, V2Contracts>>
  backendOn?: boolean
}
declare const __DOMINO_TEST_HOOKS__: boolean | undefined
const TEST_HOOKS: boolean = typeof __DOMINO_TEST_HOOKS__ === 'boolean' && __DOMINO_TEST_HOOKS__
function testHooks(): V2GateTestHooks {
  if (!TEST_HOOKS || typeof window === 'undefined') return {}
  return ((window as unknown as { __dominoV2Test?: V2GateTestHooks }).__dominoV2Test) ?? {}
}

/**
 * Whether V2 options may appear at all at `origin`: a V2 build, on the site, the preview alias or the dev server.
 * Changed on purpose 2026-10-04 (the owner: the site runs on V2, every chain pinned): domino.money too.
 */
export function v2OriginOpen(origin: string): boolean {
  return V2_ON && (origin === SITE_ORIGIN || origin === PREVIEW_ALIAS || origin === DEV_ORIGIN || testHooks().originOpen === true)
}

declare const __DOMINO_V2_FIXTURE_SETS__: boolean | undefined
/**
 * Whether this build takes V2's FIXTURE sets for `preview` (the builds that carry V2 and are not deployable, src/v2/flag.ts).
 * A literal in every Vite build, so a deployable build drops the fixture chunk along with the branch that loads it.
 */
const FIXTURE_SETS: boolean = typeof __DOMINO_V2_FIXTURE_SETS__ === 'boolean' && __DOMINO_V2_FIXTURE_SETS__

/**
 * The set a `preview` gate carries: the FIXTURE set where the build takes fixture sets (preview-v2 and the test builds,
 * in a chunk only they emit), else the chain's pinned production set (Changed on purpose 2026-10-04, the owner: the site
 * runs on V2 and every chain is pinned). Either way the gate is locked and the screens offer no send. Null: no set, off.
 */
async function previewSet(chainId: V2ChainId): Promise<V2Contracts | null> {
  if (FIXTURE_SETS) {
    const { fixtureContracts } = await import('./manifestFixtures')
    return fixtureContracts(chainId)
  }
  const pinned = v2Availability(chainId)
  return pinned.available ? pinned.contracts : null
}

/** The plain sentence for an option that runs up to the review and no further yet. */
export const lockedCopy = (chainName: string): string => `This opens as soon as Domino's service is live on ${chainName}.`

const pageOrigin = (): string => (typeof location === 'undefined' ? '' : location.origin)

/**
 * How a gate asks whether a service's route is on: a probe of the routes' capabilities (./routes.ts V2RouteProbe, the
 * page's from src/finance/v2/http.ts, shared through src/v2in/transports.ts v2PageProbe), handed in by the caller. Without
 * one the routes have no word: S2 is `preview`, and the other services fall back to the table in ./capabilities.ts.
 */
export type S2Routes = () => Promise<Pick<V2RouteProbe, 'state'>>
/** The same probe, for every service (S2Routes keeps its name for the offer's callers). */
export type GateRoutes = S2Routes
const NO_WORD: V2RouteState = Object.freeze({ on: false, reason: 'unavailable' })
const noRoutes: S2Routes = () => Promise.resolve({ state: () => Promise.resolve(NO_WORD) })

/** S2 is on when the crosschain route serves the two it needs before a deposit, the listing and the quote (status follows a deposit). */
export const s2RouteOpen = (state: V2RouteState): boolean => routeServes(state, 'origins') && routeServes(state, 'quote')

/**
 * The backend's word on a service other than S2, from its route's capabilities: S1 needs the plan route serving `plan`;
 * the vault and auto-exit need read-v6 serving `portfolio` (the automation and the index are switched on together, and
 * the screens draw nothing of a vault without it). A probe that fails has no word.
 */
export async function serviceRouteOpen(service: Exclude<V2Service, 's2'>, routes: GateRoutes): Promise<boolean> {
  try {
    const probe = await routes()
    if (service === 's1') return routeServes(await probe.state('plan'), 'plan')
    return routeServes(await probe.state('readV6'), 'portfolio')
  } catch {
    return false
  }
}

/**
 * Where S1's plans go live once the plan route is on (rugged97, 2026-10-05: the planner plans on Robinhood Chain only until
 * Base and Arbitrum One pass their fork qualification; keep plans on those chains off meanwhile). Elsewhere S1 stays
 * `preview`, locked after its review, and its route is not asked. Widen it when he says a chain's plans are qualified.
 */
export const S1_PLAN_CHAINS: readonly V2ChainId[] = Object.freeze([4663])

/** The gate for one service on one chain at `origin`, with the probe its backend word comes from (none: the table's word). */
export async function v2Gate(service: V2Service, chainId: number, origin: string = pageOrigin(), routes: S2Routes = noRoutes): Promise<V2Gate> {
  if (!v2OriginOpen(origin) || !isV2ChainId(chainId)) return OFF
  if (service === 's2') return s2Gate(chainId, routes, origin)
  const hooks = testHooks()
  const testSet = hooks.contracts?.[chainId]
  if (testSet && hooks.backendOn === true) return Object.freeze({ mode: 'live', chainId, contracts: testSet, locked: false })
  const live = serviceAvailability(service, chainId)
  if (live.open && !live.contracts.fixture) return Object.freeze({ mode: 'live', chainId, contracts: live.contracts, locked: false })
  // The pinned, production-admitted set with the route's own word (the table above said nothing): live for real.
  const pinned = v2Availability(chainId)
  const planned = service !== 's1' || S1_PLAN_CHAINS.includes(chainId)
  if (pinned.available && !pinned.contracts.fixture && routes !== noRoutes && planned && (await serviceRouteOpen(service, routes))) {
    return Object.freeze({ mode: 'live', chainId, contracts: pinned.contracts, locked: false })
  }
  // Before the backend's word: locked, on the set previewSet gives (fixtures only where the build takes them).
  const set = await previewSet(chainId)
  if (!set) return OFF
  return Object.freeze({ mode: 'preview', chainId, contracts: set, locked: true, lockedCopy: lockedCopy(v2Chain(chainId).name) })
}

/**
 * S2's gate (spec F7 §3.1: the bridge goes to the person's own wallet, through no Domino contract on any chain): `live`
 * when the crosschain route's own capabilities, asked of `routes`, say it is on with origins and quote served, `preview`
 * otherwise (the route off, not deployed, behind the gate, unavailable, or the probe failing): the inline offer then runs
 * locked and says its own sentence (src/v2in/funds FUNDS_TEXT.locked). A manifest plays no part, and neither do the test
 * hooks' contract set and backend word, which are about Domino's contracts. The set a gate carries is the chain's pinned
 * one where there is one, else the FIXTURE set the preview carries: S2 reads neither (tests/v2/funds-source.test.mjs).
 * Off where every gate is off (not a V2 build, not the preview alias or the dev server, not a V2 chain).
 */
export async function s2Gate(chainId: number, routes: S2Routes, origin: string = pageOrigin()): Promise<V2Gate> {
  if (!v2OriginOpen(origin) || !isV2ChainId(chainId)) return OFF
  let state: V2RouteState
  try {
    state = await (await routes()).state('crosschain')
  } catch {
    state = NO_WORD
  }
  if (s2RouteOpen(state)) {
    const pinned = v2Availability(chainId)
    const set = pinned.available ? pinned.contracts : await previewSet(chainId)
    if (!set) return OFF
    return Object.freeze({ mode: 'live', chainId, contracts: set, locked: false })
  }
  const set = await previewSet(chainId)
  if (!set) return OFF
  return Object.freeze({ mode: 'preview', chainId, contracts: set, locked: true, lockedCopy: lockedCopy(v2Chain(chainId).name) })
}
