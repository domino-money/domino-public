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
 * session-v1 is at 3.0.0-rc.4 because EIP-7702 accounts may now sign in: the
 * `validation` a session returns is either the plain EOA shape or
 * `eip7702_delegated` with its `delegate`, a closed union where rc.3 had one
 * shape. rc.3 had dropped `wallet_not_allowed` with the per-wallet whitelist
 * (issue #182). The onboarding-v1, deposit-v1, performance-v2 and execution-v1
 * digests moved with rc.4 only because their manifests hash the backend
 * sources it touched (the account check, the session store, the deposit
 * owner check); none of them changed a route, a schema shape or a version.
 * The deposit-v1 digest moved once more because its manifest hashes
 * backend/tests/test_deposit_receipt.py, whose local Anvil now starts through
 * backend/local_anvil.py; nothing in the contract changed.
 * The read-v1 and read-v2 digests, and the OpenAPI below, moved with the
 * featured pools list: a separate read-v5 route (`POST /v5/read/featured-pools`,
 * api-contracts/read-v5) was added to the reader, the gateway and the bridge
 * client those manifests hash. No read-v1 or read-v2 route, schema or version
 * changed. The read-v2 digest moved once more on 2026-09-26, when the bridge
 * side of read-v5 landed: the read Worker (bridge/src/worker.mjs), its
 * reviewed config (bridge/wrangler.read.toml) and the Pages forwarder
 * (functions/_lib/bridge.ts), which that manifest hashes, gained the
 * /api/read/v5/ path, off in git. Nothing in read-v2 itself changed.
 * The read-v1, read-v2, session-v1, onboarding-v1, deposit-v1, performance-v2
 * and execution-v1 digests moved with the read path's capacity for 100+ users
 * (26 September 2026): the reader and gateway admit eight provider reads at
 * once, a wallet's inventory page is reused for five minutes, and the
 * authenticated APIs take eight requests at once. Only backend sources those
 * manifests hash changed; no route, schema, reason code or version did.
 * The execution-v1 digest moved again when availability started reporting
 * operational for a heartbeat up to 120 s old instead of 45 s, so one compound
 * holding the automation's loop no longer hides Turn on; the route, its schema
 * and its version are unchanged.
 * The read-v1 and read-v2 digests moved once more when the reader and gateway
 * admitted 32 connections, above their lanes, and a wallet read began waiting
 * up to two seconds for one of four inventory calls; the wire is unchanged.
 * They moved again when a 100-visitor load test sent both to sixteen provider
 * lanes and 64 connections; the wire is unchanged.
 * They moved once more when a wallet read stopped failing whole on one token
 * whose balanceOf answers with no data: that token is now listed in
 * `unavailableAssets` with `invalid_abi_response`, a shape and reason code the
 * contract already had. No route, schema, reason code or version changed.
 */
export const PRODUCER_PIN = {
  producerCommit: 'a5f71f19e6391f3eab52ee6e51417be211bc8ea5',
  producerIssue: 95,
  packages: {
    'read-v1': {
      version: '1.1.0-rc.3',
      manifestSha256: '1909b426a1afd8a4b41d18fa60c9f2b5369ca6cbf4bf04082ecbbb6e41c988e1',
    },
    'session-v1': {
      version: '3.0.0-rc.4',
      manifestSha256: 'e10f66fae4d045632b5667aacc7f30c4e77ecc3d5b4e4472baeefe101d9ce5ac',
    },
    'onboarding-v1': {
      version: '1.0.0',
      manifestSha256: 'ab9019d4033a9d699e318319a978ecfe68ab22bd4ce1c9cc500121fcd341a160',
    },
    'deposit-v1': {
      version: '1.1.0-rc.4',
      manifestSha256: '616d430fed52a9c37ffd0e38968622fd82d196cbd34075bddb4f1ac59f257f39',
    },
  },
} as const

/** Separately opted-in public pool estimates; never accepted as a v1 response. */
export const READ_V2_PIN = {
  version: '2.0.0-rc.1',
  manifestSha256: '395f938ffb17273bc4e6792acfc019e743da0ec2663fbc3ec78334803f55e135',
} as const

/** Stored public observations, paged discovery and explicitly denominated history. */
export const READ_V3_PIN = {
  version: '3.0.0-rc.1',
  manifestSha256: '33e1ab5984c9a0fdf3033ff36885453bfb375c37acf413ccfcdc82ca39e604bd',
} as const

/**
 * The featured pools list (featured-pools v1 §10.4). read-v5 has no manifest:
 * its runtime is written by hand, so the pin is the SHA-256 of runtime.mjs
 * itself, the validator both the Worker and this app run.
 */
export const READ_V5_PIN = {
  version: '1.0.0-rc.1',
  runtimeSha256: '42c6b7364ec11d906a08366b6334562c249aa0936ae2a258aab3d41efdfcd95e',
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
  sha256: '47d530e2b2365ff5873516772d5411ce3fdf2663f93262a8ddc40e91b6518392',
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
  manifestSha256: '66938a010968f16fc6ed8192e536287ad6f691b63f5f7e8e3cc5bcf46f84ea00',
} as const

/** Sanitized private execution status, finalized receipts and short-lived service availability. */
export const EXECUTION_V1_PIN = {
  version: '1.0.0-rc.1',
  manifestSha256: 'd9c354cf27beca2e8a7068eec6ba45e98a3c56b71e2e569f393817185a299308',
} as const
