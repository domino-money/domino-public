/**
 * The producer this app is built against, recorded in one place.
 *
 * The producer publishes API contracts from api-contracts/ in this repository.
 * The app imports them in place through the `api-contracts/*` alias and never
 * copies them. The contract is pinned by version plus the SHA-256 of each
 * package's manifest.json, the file that in turn hashes every schema, type,
 * fixture and runtime in the package.
 *
 * tests/contract-pin.test.mjs recomputes every digest below from the files the
 * build actually imports, so a producer change fails CI instead of silently
 * reaching the screen. `producerCommit` is informational: CI can check the
 * bytes, not which commit produced them.
 *
 * Three independent contracts are pinned below, each with its own version and
 * its own digest: read-v1 (rc.3), read-v2's opt-in pool APR
 * estimates, and read-v3's stored public observations, paged discovery and
 * denominated history. read-v3 is additive — it took nothing away from v1 or
 * v2, and the Worker serves all three at once.
 *
 * The producer commit below is a5f71f1, which carries the local RPC source,
 * persisted public token data, and acquisition separated from reads. Later
 * producer commits changed backend sources the manifests digest without
 * changing a route, a schema or a version, which is why the versions here did
 * not move while the digests did. The private V4 snapshot loopback route
 * updated read-v1 and read-v2 source hashes without changing their wire
 * contracts, and so did starting old historical state reads past the own node.
 * The onboarding-v1 and deposit-v1 digests
 * moved again with the slippage bound: every request that carries a
 * `slippageBps` now takes 10 to 500 basis points (lib/create/slippage.ts holds
 * the same numbers), and the versions stayed where they were.
 *
 * session-v1 is at 3.0.0-rc.3 because the producer dropped `wallet_not_allowed`
 * from its closed error set with the per-wallet whitelist (issue #182). The
 * onboarding-v1, performance-v2 and execution-v1 digests moved with it: those
 * manifests hash backend sources the same change touched, and the last two
 * inherit the session error table, without any of the three changing a route,
 * a schema shape or a version.
 */
export const PRODUCER_PIN = {
  producerCommit: 'a5f71f19e6391f3eab52ee6e51417be211bc8ea5',
  producerIssue: 95,
  packages: {
    'read-v1': {
      version: '1.1.0-rc.3',
      manifestSha256: 'a5e6e7fa47468ea5d39855beb62be40e314c2fd4831a192a1fb16ea91c31549b',
    },
    'session-v1': {
      version: '3.0.0-rc.3',
      manifestSha256: '98e89f83e157d3a774254aee4fa4165bdfd2e0b96df1127f3d654709127e2879',
    },
    'onboarding-v1': {
      version: '1.0.0',
      manifestSha256: '8c4f8076af50ec2e6537ba4764865fbb1055cd6ae866851307ba2390404b3a69',
    },
    'deposit-v1': {
      version: '1.1.0-rc.4',
      manifestSha256: 'fa84d370fc4f9b941946ec5ad04f9d2b251a8f9f7f6173600c8cd7ea78b82f29',
    },
  },
} as const

/** Separately opted-in public pool estimates; never accepted as a v1 response. */
export const READ_V2_PIN = {
  version: '2.0.0-rc.1',
  manifestSha256: '704ce295f5383c2a53402702fe889a7d19bf911a116e80b00187c6889bf0fa71',
} as const

/** Stored public observations, paged discovery and explicitly denominated history. */
export const READ_V3_PIN = {
  version: '3.0.0-rc.1',
  manifestSha256: '33e1ab5984c9a0fdf3033ff36885453bfb375c37acf413ccfcdc82ca39e604bd',
} as const

/**
 * The backend's own description of the read API, which issue #1 asks this
 * adapter to be agreed against. It is generated from the Python request and
 * response models (scripts/export-read-openapi.py) and is not what the
 * browser consumes: the browser reads read-v1 through the bridge. Pinned so a
 * backend change re-opens the reconciliation in
 * tests/backend-contract.test.mjs instead of passing silently; the gaps it
 * found are recorded in tests/backend-contract.ledger.mjs.
 */
export const BACKEND_OPENAPI_PIN = {
  path: 'backend/openapi-read.json',
  infoVersion: '0.8.0',
  sha256: 'f5dc031e09d3ecf6a49d6697ee776a8e369b896b4a155b1a816e52466f3ef3d9',
} as const

export type ReadContractPin = (typeof PRODUCER_PIN)['packages']['read-v1']['version']

/**
 * Read contract versions this build accepts in `X-Domino-Read-Contract`.
 *
 * Exactly the pinned release candidate. A prerelease never satisfies a range,
 * and the rc.3 notice requires an rc.2 consumer to reject rc.3 until updated,
 * so the comparison is an exact string match with no trimming or parsing.
 */
export const ACCEPTED_READ_CONTRACTS: ReadonlySet<string> = new Set([PRODUCER_PIN.packages['read-v1'].version])

/** The version this build sends with every read, so the bridge can refuse a mismatch. */
export const REQUEST_READ_CONTRACT: ReadContractPin = PRODUCER_PIN.packages['read-v1'].version

/** Authenticated private numeric history, independent of public pool estimates. */
export const PERFORMANCE_V2_PIN = {
  version: '2.0.0-rc.1',
  manifestSha256: '7c8291381abf244af0e62a8e0c8930c2919fb494ca817b213e4154537f96d8a0',
} as const

/** Sanitized private execution status, finalized receipts and short-lived service availability. */
export const EXECUTION_V1_PIN = {
  version: '1.0.0-rc.1',
  manifestSha256: '5b00de7408e658a4a1a1ee1190037744c4d48b0a1b8248e5e96217be81a69b75',
} as const
