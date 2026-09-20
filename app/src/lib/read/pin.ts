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
 * The historical producer commit below records the original integration base.
 * The manifest digests pin the current producer, including additive local
 * inventory source/coverage and explicit fallback attribution. Publish this
 * consumer and the Worker before activating that producer on the VM.
 */
export const PRODUCER_PIN = {
  producerCommit: 'a5f71f19e6391f3eab52ee6e51417be211bc8ea5',
  producerIssue: 95,
  packages: {
    'read-v1': {
      version: '1.1.0-rc.3',
      manifestSha256: '77a5d7c3d698aeec06f6cf6500c94810b242213987216f20a150a91cf8e96c57',
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
  manifestSha256: '347cb7887011afc1ef9d62d161fd2eec59f4b6459fa4e5dec580f9f678d14767',
} as const

/** Stored public observations, paged discovery and explicitly denominated history. */
export const READ_V3_PIN = {
  version: '3.0.0-rc.1',
  manifestSha256: 'ea2c6deb7932e389bc04ea5bfbff3e9665ed20c0a84d5d9b565f2726c30ccf22',
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
  sha256: '3ef1538ace11117bfa1dd523548792ff6d7cfb0e7da5e35b77f82ea8a220a1e1',
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
  manifestSha256: '73c3c425d6ac92bca08110c1448a63809285297a33b6e9884f78b0f7f24c2efd',
} as const
