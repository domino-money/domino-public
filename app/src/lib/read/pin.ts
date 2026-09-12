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
 * contract is pinned separately below; v1 remains exactly rc.3.
 */
export const PRODUCER_PIN = {
  producerCommit: '9f4195662f5cc859011dba8f631475b3daec1acd',
  producerIssue: 95,
  packages: {
    'read-v1': {
      version: '1.1.0-rc.3',
      manifestSha256: '6c32d2bda8ecf4946e8e54afa1d2f9778a6022db2166aa41d2a61a401dfd9b42',
    },
    'session-v1': {
      version: '3.0.0-rc.2',
      manifestSha256: '278d5fa3f3a6571c92e13e39bddc3e1b9091a8ad82e4b83aa534cc9e83decd42',
    },
    'onboarding-v1': {
      version: '1.0.0',
      manifestSha256: '2f6eb9f02b8cd2d06cddd4352e7db6fdae6b19bd7f2a91577a9ec15039b5d416',
    },
    'deposit-v1': {
      version: '1.1.0-rc.4',
      manifestSha256: 'be0e22ddfb5b6ea437a88999c9d924013bb5128af13060bd2af6f28a803848df',
    },
  },
} as const

/** Separately opted-in public pool estimates; never accepted as a v1 response. */
export const READ_V2_PIN = {
  version: '2.0.0-rc.1',
  manifestSha256: 'd516fe13f8c13fb2f70c4ad4ca287eb2ba006232ae94c33ba319f570fe6aab47',
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
  sha256: '8de9a88b3c1535d0ba3cafcbc2b0917a09ae7f83ab755ec9ea994cb0d2ff23fc',
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
