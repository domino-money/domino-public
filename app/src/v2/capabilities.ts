/**
 * Whether a Domino V2 service is open on a chain (spec F7 §1.1 recommendation: V2 enters as new flows, switched on per
 * service and per chain only with that chain's pinned manifest (§7) AND the backend's matching capability, after the
 * pattern of lib/capabilities.ts).
 *
 * Three conditions, all required, checked in this order, each with its own closed reason:
 *   1. the build carries V2 (src/v2/flag.ts: the v2-test build only; never a deployable one) — `build_off`;
 *   2. the chain has a pinned deployment manifest that passes every check (./manifest.ts) — `not_deployed`, said
 *      "Not available on {chain} yet" (§7.3 point 3); in the v2-test build only, the FIXTURE manifests stand in for it,
 *      marked `fixture: true`, which never enables a real financial operation;
 *   3. the backend says the service is on for that chain — `service_off`. No backend capability exists for any V2
 *      service yet (the S1 plan API, the V2 read API, the automation planner and exit operator are all pending, spec
 *      §9): every entry below is false. Turning one on is a reviewed change of this table, made only once the backend
 *      publishes its own word (and then read from it, not from here). S2 (Changed on purpose (data) 2026-10-02 (S2
 *      wired), spec §3.1: no Domino contract on any chain) is gated by ./gate.ts from the crosschain route's own
 *      capabilities (./routes.ts) and never asks this table: its row below is kept for the table's shape only.
 */
import { ELYSIUM_LIVE, ELYSIUM_V2_ID } from '../lib/elysiumIdentity'
import { V2_CHAINS, isV2ChainId, v2Chain } from './chains'
import { V2_ON } from './flag'
import { notAvailableCopy, v2Availability } from './manifest'
import type { V2ChainId, V2Contracts } from './types'

export type V2Service = 's1' | 's2' | 'vault' | 'autoExit'

/**
 * The backend's word for each service on each chain. None exists yet: all off (spec §9 points 1, 10, 17, 24). Changed on
 * purpose 2026-11-07 (Elysium as a fourth V2 chain): Elysium's row where it is live, off too. As on the other three, its
 * services open only from their routes' own answers (./gate.ts serviceRouteOpen), never from this table.
 */
const ELYSIUM_OFF: Partial<Record<V2ChainId, boolean>> = ELYSIUM_LIVE ? { [ELYSIUM_V2_ID]: false } : {}
const allOff = (): Readonly<Record<V2ChainId, boolean>> => Object.freeze({ 4663: false, 8453: false, 42161: false, ...ELYSIUM_OFF } as Record<V2ChainId, boolean>)
export const V2_BACKEND_CAPABILITIES: Readonly<Record<V2Service, Readonly<Record<V2ChainId, boolean>>>> = Object.freeze({
  s1: allOff(),
  s2: allOff(),
  vault: allOff(),
  autoExit: allOff(),
})

export type ServiceAvailability =
  | { readonly open: true; readonly contracts: V2Contracts }
  | { readonly open: false; readonly reason: 'build_off' | 'not_deployed' | 'service_off' | 'chain_not_supported'; readonly copy: string }

/** The words where no chain is in question (a build without V2, a chain V2 does not serve). */
export const SERVICE_OFF_COPY = 'Not available yet'


/**
 * The verdict for one service on one chain. `fixtureContracts` is how the v2-test build hands in its FIXTURE manifest
 * set (src/v2/manifestFixtures.ts, imported by the v2-test screens only); a deployable build never passes it, and V2 is
 * off there before it would be read. `testBackend` likewise stands in for the backend's word in the v2-test build only.
 */
export function serviceAvailability(service: V2Service, chainId: number, test?: { fixtureContracts?: (chainId: V2ChainId) => V2Contracts; backendOn?: boolean }): ServiceAvailability {
  if (!V2_ON) return Object.freeze({ open: false, reason: 'build_off', copy: SERVICE_OFF_COPY })
  if (!isV2ChainId(chainId)) return Object.freeze({ open: false, reason: 'chain_not_supported', copy: SERVICE_OFF_COPY })
  const chain = v2Chain(chainId)
  const pinned = v2Availability(chainId)
  const contracts = pinned.available ? pinned.contracts : test?.fixtureContracts?.(chainId) ?? null
  if (!contracts) return Object.freeze({ open: false, reason: 'not_deployed', copy: notAvailableCopy(chain) })
  const backend = contracts.fixture ? test?.backendOn === true : V2_BACKEND_CAPABILITIES[service][chainId]
  if (!backend) return Object.freeze({ open: false, reason: 'service_off', copy: notAvailableCopy(chain) })
  return Object.freeze({ open: true, contracts })
}

/** Every V2 chain with its verdict for a service, in the picker's order. */
export const chainsFor = (service: V2Service, test?: Parameters<typeof serviceAvailability>[2]) =>
  V2_CHAINS.map((chain) => ({ chain, availability: serviceAvailability(service, chain.chainId, test) }))
