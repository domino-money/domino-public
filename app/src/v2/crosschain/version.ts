/**
 * The crosschain-v1 contract this build is pinned to (spec F7 §3.1, §3.2): the version sent and the only one accepted
 * in `X-Domino-Crosschain-Contract`, and the SHA-256 of the package's manifest.json, exact bytes with LF endings.
 * tests/v2/crosschain-pin.test.mjs recomputes the digest and every file the manifest lists, the way
 * tests/contract-pin.test.mjs does for read-v2, so a producer change that lands in the tree fails CI before any screen
 * reads an answer this client was not tested with.
 *
 * Exact: a prerelease never satisfies a range, so rc.2 is refused until this pin moves.
 *
 * Changed on purpose (data) 2026-10-06: 1.0.0-rc.1 -> 1.1.0-rc.1 (quoting by output, the owner's authorization of
 * 6 Oct 2026). The package carries one version, so the app moves with it, and asks both ways (rugged's delta of 6 Oct
 * §3): by exact input (`amountKind: 'exact_input'`, `maxInputRaw: null`, v2in/funds/model.ts quoteRequestOf) for a typed
 * amount, Other networks, everything held and "All you have"; by output (`amountKind: 'output'`, `amountRaw` = what the
 * position lacks, `maxInputRaw` = the sendable balance, v2in/funds/BringFunds.tsx outputRequestOf) for the one click
 * sized for what the position lacks. What the wallet sends is always the winner's `inputRaw`. The listener answers both
 * versions for the switch window; the Worker and this page are each one version.
 */
import type { CrosschainContractVersion } from 'api-contracts/crosschain-v1/types'

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

export const CROSSCHAIN_CONTRACT = '1.1.0-rc.1' as const

// Fails typecheck as soon as the package's generated version and this pin disagree.
void (true satisfies Same<CrosschainContractVersion, typeof CROSSCHAIN_CONTRACT>)

/** The request and reply header that carries the contract version (XC README). */
export const CROSSCHAIN_HEADER = 'X-Domino-Crosschain-Contract'

export const CROSSCHAIN_V1_PIN = Object.freeze({
  package: 'crosschain-v1',
  version: CROSSCHAIN_CONTRACT,
  /** sha256(api-contracts/crosschain-v1/manifest.json), as re-exported for the quote's decision record (5 Oct 2026:
   *  the listener logs which provider won and why). One backend file changed; the contract and its version did not.
   *  Changed on purpose (data) 2026-10-06: crosschain-v1 1.1.0-rc.1 (quoting by output: amountKind, maxInputRaw,
   *  inputRaw, input_above_max, the decision by rate), and the listener's switch window for 1.0.0-rc.1. */
  // Changed on purpose (data) 2026-11-03 (launch round P2): crosschain_http.py, crosschain_relay.py,
  // crosschain_across.py, crosschain_api.py and crosschain_config.py give bridge status reads their own share of each
  // provider's budget, and authenticated_api.py and onboarding_auth.py name a 429's Retry-After by cause, wait up to
  // 2.5 s for a free worker and give each kind of signed-in work its own preview budget; no route, schema, reason
  // code or version moved.
  // Changed on purpose (data) 2026-11-04 (launch round P3): authenticated_api.py, onboarding_auth.py and
  // crosschain_api.py: a session belongs to the origin it signed in on, and a listed preview origin rides its own
  // Access identity; a read-only route may take an account check up to a minute old, for the delegate the session was
  // admitted with; no route, schema, reason code or version moved.
  // Changed on purpose (data) 2026-11-05: crosschain_common.py, crosschain_config.py, crosschain_across.py and
  // crosschain_fees.py: a chain profile naming no bridge provider is no destination (S2 off there), and the fee
  // proof's chains follow the destinations (still 4663, 8453, 42161); no route, schema, reason code or version moved.
  // Changed on purpose (data) 2026-11-09 (0xdecimal's item 11, the owner's parity): Elysium (99901) is a destination
  // Relay alone serves, of its USDC alone (CONSTANTS.destinations, the destination chain enums), and an origin pinned
  // for Relay (CONSTANTS.chains); Across' candidate there is `no_route` / `destination_not_served` and its listing
  // `unavailable` with that reason. Same version; no other route, schema or reason code moved.
  manifestSha256: '98173920f836b97dc7f7866de27281d393ca1fe934e7708c186ee9a84ff630bb',
  /** The manifest's own `status`: the service is built but off until the owner's keys and the Worker route exist. */
  status: 'candidate_disabled_pending_keys_and_worker',
} as const)
