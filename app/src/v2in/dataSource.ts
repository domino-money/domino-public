/**
 * The choice behind src/v2in/transports.ts (Domino V2 integration, 2026-10-02, the base agent's item 5), pure: the gate's
 * mode in, the transports a screen reads read-v6 and position-plan-v1 through out.
 *
 * Changed on purpose (data) 2026-10-02 (the owner, night: real data only, no test data anywhere): the package FIXTURES
 * are gone from every screen. Under `preview` (the preview alias and the development server, before the deploy) the
 * screens read the SAME site routes as under `live` (src/finance/v2/http.ts), each sent only while its capabilities say
 * it serves (src/v2/routes.ts, one probe for the page); a route that is off is a dash with its reason (`routeState`),
 * never a fixture: a read or a plan asked of an off route is refused unsent. What `preview` changes is only that every
 * send and signature stays locked (src/v2/gate.ts): the screens stop at their review with the gate's sentence. `off`:
 * null. A test build's script (handed in by src/v2in/transports.ts from `window.__dominoV2Test`, test builds only)
 * replaces the routes, in either mode: `source: 'scripted'`, every route on.
 *
 * No wallet, no fetch, no storage, no runtime of its own (the package's validators are handed in), so the node tests
 * run it as it is (tests/v2/v2in-transports.test.mjs).
 */
import type { ReadV6Route } from 'api-contracts/read-v6/types'
import type { V2Gate } from '../v2/gate'
import { createS1PlanFixtureTransport } from '../v2/plan/fixtureTransport'
import type { S1PlanTransport, S1PlanValidators } from '../v2/plan/types'
import type { ReadV6Transport, ReadV6Validators } from '../v2/read/v6'
import { createReadV6FixtureTransport } from '../v2/read/v6FixtureTransport'
import { routeServes, type V2Route, type V2RouteProbe, type V2RouteState } from '../v2/routes'

/** Where a screen's V2 data comes from: the site's routes, or a test build's script. */
export type V2DataSource = 'route' | 'scripted'

export interface V2Transports {
  readonly mode: 'live' | 'preview'
  readonly source: V2DataSource
  /** read-v6's own validators (api-contracts/read-v6/runtime.mjs), for src/v2/read/v6.ts readPortfolio and readActivity. */
  readonly readRuntime: ReadV6Validators
  readonly read: ReadV6Transport
  /** position-plan-v1's own validators (api-contracts/position-plan-v1/runtime.mjs), for src/v2/plan/client.ts requestS1Plan. */
  readonly planRuntime: S1PlanValidators
  readonly plan: S1PlanTransport
  /** Whether a route serves now, and if not why (a dash with its reason). A script: on. */
  routeState(route: V2Route): Promise<V2RouteState>
}

/** A scripted answer, as a test build's suite hands it. */
export interface ScriptedAnswer {
  status: number
  body: unknown
}
/** What a test build's suite may script (`window.__dominoV2Test.read6` / `.plan`). */
export interface V2DataScript {
  read6?: Partial<Record<ReadV6Route, ScriptedAnswer>>
  plan?: (request: Record<string, unknown>) => unknown
}

/** What src/v2in/transports.ts hands in. */
export interface V2DataDeps {
  runtimes: { read: ReadV6Validators; plan: S1PlanValidators }
  /** The site's routes: the read and plan transports and the page's probe of their capabilities. */
  live: () => { read: ReadV6Transport; plan: S1PlanTransport; probe: V2RouteProbe }
  /** A test build's script, or null (always null outside a test build). */
  script: () => V2DataScript | null
}

const ON: V2RouteState = Object.freeze({ on: true, routes: Object.freeze(['portfolio', 'activity', 'plan']) })

/** Why a request to an off route was refused unsent (a thrown Error's message; the clients say it as unavailable). */
const offReason = (state: V2RouteState): string => (state.on ? 'route_off' : `route_off_${state.reason}`)

/** read-v6 through a transport that posts only to a read the route serves now. */
function servedRead(transport: ReadV6Transport, probe: V2RouteProbe): ReadV6Transport {
  return {
    kind: transport.kind,
    async post(route, body) {
      const state = await probe.state('readV6')
      if (!routeServes(state, route)) throw new Error(offReason(state))
      return transport.post(route, body)
    },
  }
}

/** The plan through a transport that posts only while the plan route serves. */
function servedPlan(transport: S1PlanTransport, probe: V2RouteProbe): S1PlanTransport {
  return {
    kind: transport.kind,
    async plan(request) {
      const state = await probe.state('plan')
      if (!routeServes(state, 'plan')) throw new Error(offReason(state))
      return transport.plan(request)
    },
  }
}

/** Scripted read-v6 answers as a transport: a read nobody scripted is refused. */
function scriptedRead(answers: Partial<Record<ReadV6Route, ScriptedAnswer>>): ReadV6Transport {
  const transport = createReadV6FixtureTransport()
  for (const route of ['portfolio', 'activity'] as const) {
    const answer = answers[route]
    if (answer) transport.script(route, answer.status, answer.body)
  }
  return transport
}

/** The transports for a chain's gate, or null when it is off. */
export function createV2Transports(gate: V2Gate, deps: V2DataDeps): V2Transports | null {
  if (gate.mode === 'off') return null
  const runtimes = { readRuntime: deps.runtimes.read, planRuntime: deps.runtimes.plan }
  const script = deps.script()
  if (script) {
    return Object.freeze({
      mode: gate.mode,
      source: 'scripted' as const,
      ...runtimes,
      read: scriptedRead(script.read6 ?? {}),
      plan: createS1PlanFixtureTransport((request) => script.plan?.(request)),
      routeState: async () => ON,
    })
  }
  const live = deps.live()
  return Object.freeze({
    mode: gate.mode,
    source: 'route' as const,
    ...runtimes,
    read: servedRead(live.read, live.probe),
    plan: servedPlan(live.plan, live.probe),
    routeState: (route: V2Route) => live.probe.state(route),
  })
}
