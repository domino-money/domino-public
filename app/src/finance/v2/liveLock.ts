/**
 * The money lock of Domino V2 before its contracts are live (Changed on purpose (data) 2026-10-02, Domino V2
 * integration, the preview-v2 build).
 *
 * The preview-v2 build is the real site with V2 compiled in, published on the preview alias, where wallets are real. Its
 * gate (src/v2/gate.ts) runs a V2 option up to its review on the FIXTURE manifest set until a chain has a pinned,
 * production-admitted manifest (`preview`), and a fixture set may then reach the closed money clients (their reads for
 * the review are allowed: reads before a signature). Nothing may ever be sent or signed with one. So every send,
 * signature, batch offer and approval of finance/v2 refuses FIRST, before any wallet request, any journal entry, nonce
 * claim or batch latch, unless the contracts in use are live on their chain, with ONE code, CONTRACTS_NOT_LIVE, said in
 * the gate's own words (`contractsNotLiveCopy`: "This opens as soon as Domino's service is live on {chain}."):
 *
 *   - live means exactly the chain's pinned production manifest set (src/v2/manifest.ts v2Availability, `fixture: false`,
 *     the `production` admission, the very addresses and code hashes: ./deployment.ts sameSet). A fixture set, a set
 *     that does not say what it is, or one that merely says `fixture: false`, is not; neither is any set on a chain with
 *     no pinned manifest (every chain today). A client with no V2 set of its own (the direct exits, ./direct.ts) and the
 *     shared backstops (the one signer, the one batch offer) ask whether the CHAIN is live;
 *   - where: ./transact.ts `send` (every step of the zap, vault, auto-exit and direct clients, approvals included), each
 *     client's signatures (zap `signPermit`, `signRelayed`; auto-exit `signMandate`) and batch offers (zap `sendBatch`,
 *     vault `sendBatch`, `sendWithdrawAllBatch`, auto-exit `sendRegisterBatch`), and, as backstops, ./typedData.ts
 *     `signV2TypedData` and ./vault.ts `offerV2Batch`. S2's sender sends no Domino contract call: a fixture quote is
 *     never sendable there (./crosschain.ts `quote_synthetic`);
 *   - in a TEST build (`__DOMINO_TEST_HOOKS__`: v2-test, wallet-test-v2, never deployable, never published) the fake
 *     chains' hand-built sets, which the gate's test hooks make `live` (src/v2/gate.ts V2GateTestHooks), are sent and
 *     signed as the suites need; the gate's FIXTURE manifest set (a set carrying a test admission's manifest facts) is
 *     refused there too, exactly as in preview-v2, so a suite sees the lock a person would;
 *   - a compile outside Vite (the node tests' .test-build) sees no define and is not locked, as finance/pin.ts answers
 *     "not deployable" there: nothing outside a Vite build reaches a person's wallet. tests/v2/live-lock.test.mjs loads
 *     the money modules afresh with `globalThis.__DOMINO_TEST_HOOKS__` set to test both.
 *
 * The production and development builds carry no V2 at all (`__DOMINO_V2__` false): none of this is in them.
 */
import { isV2ChainId, v2Chain } from '../../v2/chains'
import { lockedCopy } from '../../v2/gate'
import { v2Availability } from '../../v2/manifest'
import type { V2Contracts } from '../../v2/types'
import { sameSet } from './deployment'

declare const __DOMINO_TEST_HOOKS__: boolean | undefined

/** Whether a Vite define reached this module at all (a node test compile has none: no lock). */
const DEFINED: boolean = typeof __DOMINO_TEST_HOOKS__ === 'boolean'
/** A test build: the fake chains' sets go through; the fixture manifests' never do. */
const TEST_BUILD: boolean = DEFINED && __DOMINO_TEST_HOOKS__ === true

/** The one code every refusal of this lock carries (an error's message, a `data-error-code`). */
export const CONTRACTS_NOT_LIVE = 'contracts_not_live' as const

/** The lock's refusal: nothing reached the wallet, nothing was journaled, claimed or latched. */
export class ContractsNotLive extends Error {
  readonly code: typeof CONTRACTS_NOT_LIVE = CONTRACTS_NOT_LIVE
  readonly chainId: number
  constructor(chainId: number) {
    super(CONTRACTS_NOT_LIVE)
    this.name = 'ContractsNotLive'
    this.chainId = chainId
  }
}

/** The lock's refusal in words: the gate's own sentence for the chain (src/v2/gate.ts lockedCopy). */
export function contractsNotLiveCopy(chainId: number): string {
  return lockedCopy(isV2ChainId(chainId) ? v2Chain(chainId).name : 'this network')
}

/** Whether a set comes from a manifest under a TEST admission (the FIXTURE manifests: src/v2/manifestFixtures.ts). */
const fromTestManifest = (contracts: V2Contracts): boolean => contracts.deployment !== undefined && contracts.deployment.admission !== 'production'

/**
 * Whether `contracts` are live on `chainId`: exactly the chain's pinned, production-admitted manifest set. `null` asks
 * whether the chain itself is live (it has such a manifest), for a client that uses no V2 set of its own.
 */
export function contractsLive(chainId: number, contracts: V2Contracts | null): boolean {
  if (!isV2ChainId(chainId)) return false
  const pinned = v2Availability(chainId)
  // v2Availability takes production-admitted manifests only (`fixture: false`): anything else is not live.
  if (!pinned.available || pinned.contracts.fixture !== false) return false
  if (contracts === null) return true
  return typeof contracts === 'object' && contracts.fixture === false && contracts.chainId === chainId && sameSet(pinned.contracts, contracts)
}

/**
 * Throws ContractsNotLive unless what is about to be sent or signed uses live contracts (above), or the build is a test
 * build and the set is not the gate's fixture manifest set. Call it FIRST in every send, signature and batch offer,
 * before any wallet request, journal entry, nonce claim or batch latch.
 */
export function refuseUnlessLive(chainId: number, contracts: V2Contracts | null): void {
  if (!DEFINED) return
  if (TEST_BUILD) {
    if (contracts !== null && (typeof contracts !== 'object' || fromTestManifest(contracts))) throw new ContractsNotLive(chainId)
    return
  }
  if (!contractsLive(chainId, contracts)) throw new ContractsNotLive(chainId)
}
