/**
 * Domino V2's data transports for the integrated screens (Domino V2 integration, 2026-10-02, the base agent's item 5):
 * the ONE place a screen gets read-v6 (src/v2/read/v6.ts readPortfolio, readActivity) and position-plan-v1
 * (src/v2/plan/client.ts requestS1Plan) from, chosen by the chain's gate (src/v2/gate.ts):
 *
 *   const transports = v2Transports(await v2Gate('s1', chainId))   // null: the gate is off, the screen is V1's
 *   if (transports.mode === 'live' && !routeServes(await transports.routeState('readV6'), 'portfolio')) → a dash, its reason
 *   readPortfolio(transports.read, transports.readRuntime, connectedWallet)   // every read is about the connected wallet
 *   requestS1Plan(transports.plan, transports.planRuntime, request, context)
 *
 * `live` and `preview` alike: the site's own routes only (src/finance/v2/http.ts: the read Worker's POSTs, the plan with
 * the signed-in session's CSRF; ask the plan while the session is signed in, before switching the wallet to the plan's
 * chain), each only while its capabilities say it serves; an off route is a dash with its reason, never test data
 * (Changed on purpose (data) 2026-10-02, the owner: real data only; ./dataSource.ts holds the rule,
 * tests/v2/v2in-transports.test.mjs). `preview` differs only in that every send and signature stays locked.
 *
 * In a TEST build only (`__DOMINO_TEST_HOOKS__`; the define folds this away everywhere else), a browser suite scripts the
 * answers, in either mode, through `window.__dominoV2Test` (set before the page's first script, e.g. addInitScript):
 *   - `read6: { portfolio?: { status, body }, activity?: { status, body } }` (normally another of the package's fixtures:
 *     a chain out, a chain behind); a read not scripted is refused;
 *   - `plan: (request) => ({ status, body }) | body | undefined` (undefined: not scripted, refused).
 *
 * Imported only by src/v2in modules, which V1 files open lazily behind the bare `__DOMINO_V2__` define: neither the
 * fixtures, the runtimes nor the routes' code reach a deployable build.
 */
import { CONTRACT_VERSION, ERROR_STATUS_BY_CODE, validateRequest, validateResponse, validateExchange, validateError } from 'api-contracts/read-v6/runtime.mjs'
import { livePlanTransport, liveReadV6Transport, v2RouteProbe } from '../finance/v2/http'
import type { GateRoutes, V2Gate } from '../v2/gate'
import { POSITION_PLAN_RUNTIME } from '../v2/plan/contract'
import type { ReadV6Validators } from '../v2/read/v6'
import { routeServes, type V2RouteProbe } from '../v2/routes'
import { createV2ReadTransports, createV2Transports, type V2DataScript, type V2Transports, type V2ReadTransports } from './dataSource'

export { type V2DataSource, type V2Transports, type V2ReadTransports } from './dataSource'

declare const __DOMINO_TEST_HOOKS__: boolean | undefined
const TEST_HOOKS: boolean = typeof __DOMINO_TEST_HOOKS__ === 'boolean' && __DOMINO_TEST_HOOKS__

/** What a browser suite scripted, in a test build only; null everywhere else, and when nothing is scripted. */
function script(): V2DataScript | null {
  if (!TEST_HOOKS || typeof window === 'undefined') return null
  const hooks = (window as unknown as { __dominoV2Test?: V2DataScript }).__dominoV2Test
  return hooks && (hooks.read6 !== undefined || typeof hooks.plan === 'function') ? hooks : null
}

/** The page's one probe of the routes' capabilities (a settled answer kept a minute, concurrent askers share one GET). */
let probe: V2RouteProbe | null = null
/** The same probe for the gates (src/v2/gate.ts GateRoutes): a service is live only while its route serves. */
export const v2PageProbe: GateRoutes = () => Promise.resolve((probe ??= v2RouteProbe()))

const readRuntime: ReadV6Validators = Object.freeze({ CONTRACT_VERSION, ERROR_STATUS_BY_CODE, validateRequest, validateResponse, validateExchange, validateError })
const RUNTIMES = Object.freeze({ read: readRuntime, plan: POSITION_PLAN_RUNTIME })

/** The transports for a chain's gate; null when the gate is off. */
export function v2Transports(gate: V2Gate): V2Transports | null {
  return createV2Transports(gate, {
    runtimes: RUNTIMES,
    live: () => ({ read: liveReadV6Transport(), plan: livePlanTransport(), probe: (probe ??= v2RouteProbe()) }),
    script,
  })
}

export function v2ReadTransports(): V2ReadTransports {
  return createV2ReadTransports({ runtimes: RUNTIMES, live: () => ({ read: liveReadV6Transport(), plan: livePlanTransport(), probe: (probe ??= v2RouteProbe()) }), script })
}

/** Whether the read route is known to serve `position-fees` now, asking nothing: the page's first draw (its portfolio's read asked the route already). */
export function positionFeesServedNow(): boolean {
  const scripted = script()
  if (scripted) return scripted.read6?.['position-fees'] !== undefined
  const state = probe?.known?.('readV6') ?? null
  return state !== null && routeServes(state, 'position-fees')
}

/** Forget the routes' kept answers (a session or page change that may change them). */
export function forgetV2Routes(): void {
  probe?.forget()
}
