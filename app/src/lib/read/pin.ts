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
 * The source commit integrates opt-in pool APR estimates (#127), explicit
 * chart currency identity (#128) and their development gateway path while
 * preserving RPC batching and the seven read-v1 routes. The independent V2
 * contract is pinned separately below; v1 remains exactly rc.3. The last
 * producer change is the T1.6/T1.7 indexing work, which touches
 * backend/catalogue.py — a source the manifest digests — without changing any
 * route, schema or version.
 */
export const PRODUCER_PIN = {
  producerCommit: 'c0d647b9c7558f1b35ba9d6c2ab00f7736772c24',
  producerIssue: 95,
  packages: {
    'read-v1': {
      version: '1.1.0-rc.3',
      manifestSha256: 'a0d7a6b4fca89603dc4eea6bf1dac0bf0c730bdb66d365c6768cc5789ce3f849',
    },
    'session-v1': {
      version: '3.0.0-rc.2',
      manifestSha256: '28412404c6b8b93e1be6d04291c8ef5042319151d9f905e193ee1a02aa230501',
    },
    'onboarding-v1': {
      version: '1.0.0',
      manifestSha256: 'a8967fb4e67fe87a5c9da1f6a2638e1ba9a9b5b781ecee6f2894ca946adc3898',
    },
    'deposit-v1': {
      version: '1.1.0-rc.4',
      manifestSha256: '40d7e7343f41fba4681811d4f8606e22a2ba1f6fe682d6f7baf234383f5c4f3e',
    },
  },
} as const

/** Separately opted-in public pool estimates; never accepted as a v1 response. */
export const READ_V2_PIN = {
  version: '2.0.0-rc.1',
  manifestSha256: 'cea55a56d8d4b9d6c134c50703780fc6b6cb84257e30ae2bec0c29b983fce51c',
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
  manifestSha256: 'd5665e0b15c3ab982f95c56263d3cab7182f6c92deb1f07389c18c319aaab4a8',
} as const

/** Sanitized private execution status and finalized receipts only. */
export const EXECUTION_V1_PIN = {
  version: '1.0.0-rc.1',
  manifestSha256: '73c3c425d6ac92bca08110c1448a63809285297a33b6e9884f78b0f7f24c2efd',
} as const
