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
 * its own digest: read-v1 (rc.3, unchanged), read-v2's opt-in pool APR
 * estimates, and read-v3's stored public observations, paged discovery and
 * denominated history. read-v3 is additive — it took nothing away from v1 or
 * v2, and the Worker serves all three at once.
 *
 * The producer commit below is a5f71f1, which carries the local RPC source,
 * persisted public token data, and acquisition separated from reads. Later
 * producer commits changed backend sources the manifests digest without
 * changing a route, a schema or a version, which is why the versions here did
 * not move while the digests did. The onboarding-v1 and deposit-v1 digests
 * moved again with the slippage bound: every request that carries a
 * `slippageBps` now takes 10 to 500 basis points (lib/create/slippage.ts holds
 * the same numbers), and the versions stayed where they were.
 */
export const PRODUCER_PIN = {
  producerCommit: 'a5f71f19e6391f3eab52ee6e51417be211bc8ea5',
  producerIssue: 95,
  packages: {
    'read-v1': {
      version: '1.1.0-rc.3',
      manifestSha256: 'a57a2124be81faf48207d13415736044ae2564bd772923f86be9717dfaeb503b',
    },
    'session-v1': {
      version: '3.0.0-rc.2',
      manifestSha256: '28412404c6b8b93e1be6d04291c8ef5042319151d9f905e193ee1a02aa230501',
    },
    'onboarding-v1': {
      version: '1.0.0',
      manifestSha256: '9ce8821d4e7604105c84126f282e19d3f2aab7de40c0cecb8ad8d8b07d098ed2',
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
  manifestSha256: '717a999813b8081ff3809e13355f22ed2e074d7628bf9513684565cafae49e26',
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
  sha256: 'd49a40a2d8713941b23f701082d52d8a4b75c8658ccf73672a4372afbadd2cdb',
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
  manifestSha256: '2b1264401f72b6a89d9d36fabc12c2b6d6cde9138eae92eebede4e7558cb3684',
} as const

/** Sanitized private execution status and finalized receipts only. */
export const EXECUTION_V1_PIN = {
  version: '1.0.0-rc.1',
  manifestSha256: '304297dd26312b7d06e09445c458ff1a07ae2971581d0dd89a797d4d159a24af',
} as const
