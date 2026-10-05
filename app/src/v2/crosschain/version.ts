/**
 * The crosschain-v1 contract this build is pinned to (spec F7 §3.1, §3.2): the version sent and the only one accepted
 * in `X-Domino-Crosschain-Contract`, and the SHA-256 of the package's manifest.json, exact bytes with LF endings.
 * tests/v2/crosschain-pin.test.mjs recomputes the digest and every file the manifest lists, the way
 * tests/contract-pin.test.mjs does for read-v2, so a producer change that lands in the tree fails CI before any screen
 * reads an answer this client was not tested with.
 *
 * Exact: a prerelease never satisfies a range, so rc.2 is refused until this pin moves.
 */
import type { CrosschainContractVersion } from 'api-contracts/crosschain-v1/types'

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

export const CROSSCHAIN_CONTRACT = '1.0.0-rc.1' as const

// Fails typecheck as soon as the package's generated version and this pin disagree.
void (true satisfies Same<CrosschainContractVersion, typeof CROSSCHAIN_CONTRACT>)

/** The request and reply header that carries the contract version (XC README). */
export const CROSSCHAIN_HEADER = 'X-Domino-Crosschain-Contract'

export const CROSSCHAIN_V1_PIN = Object.freeze({
  package: 'crosschain-v1',
  version: CROSSCHAIN_CONTRACT,
  /** sha256(api-contracts/crosschain-v1/manifest.json), as re-exported for #357: the fee proof on Base and Arbitrum
   *  reads F6's registry. Three backend files changed; the contract and its version did not. */
  manifestSha256: 'b3d80817cb4dec5fd3d59413df0b5f2be6b2e11a67edca6896636879b5265c20',
  /** The manifest's own `status`: the service is built but off until the owner's keys and the Worker route exist. */
  status: 'candidate_disabled_pending_keys_and_worker',
} as const)
