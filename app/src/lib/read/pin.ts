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
  producerCommit: '8ee81245d5b8b394971b2412a6aaa273850d169d',
  producerIssue: 95,
  packages: {
    'read-v1': {
      version: '1.1.0-rc.3',
      manifestSha256: '139a293e70420333d920417b8999f99b5ce5125bd3e390f812d017f1101f3ab1',
    },
    'session-v1': {
      version: '3.0.0-rc.2',
      manifestSha256: '78ca5e628cf81b1c47a1b8329bce3638d4342894c806eef1150c105e61f1685c',
    },
    'onboarding-v1': {
      version: '1.0.0',
      manifestSha256: '1d6dc91e5f16a4b0f551840c4463c259f59d2078d95ed84008d8b662d205eda2',
    },
    'deposit-v1': {
      version: '1.1.0-rc.4',
      manifestSha256: '5446efcaa93b6688b1664e08ec52565a6dce110c5f74c43c8b9a8e7cf6fa63a9',
    },
  },
} as const

/** Separately opted-in public pool estimates; never accepted as a v1 response. */
export const READ_V2_PIN = {
  version: '2.0.0-rc.1',
  manifestSha256: '94a2dfbe5ea741ff9f00448ffafd74fc0bbe0c2be3bc07a9aa4745608909c103',
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
  sha256: '8eab5ee5ca8923f2fa58a3109e182ac02c56be1340771c2f10b49e84b9b35929',
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
  manifestSha256: '5d6d735ccf22cbbde5f8f493822f699afb1e1a0bf27f27ffe4526381bbb5162e',
} as const

/** Sanitized private execution status and finalized receipts only. */
export const EXECUTION_V1_PIN = {
  version: '1.0.0-rc.1',
  manifestSha256: '3d13cdf1e2afa846f13763d5186c788ca2a843de85752a3937c8101706e3461b',
} as const
