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
 * The read-v2 digest moved on 2026-09-29 for the explicitly opted-in preview
 * public-read adapter in that same Pages forwarder. Its generated schemas,
 * runtime, fixtures, version and financial calculations are unchanged.
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
 * The performance-v2 digest moved when the V4 receipt verifier began naming a
 * call the chain reverted by the contract's own error instead of reporting an
 * unreachable node; the manifest hashes backend/execution_v4.py. Its routes,
 * schemas, reason codes and version are unchanged.
 * It moved again when those error names became snake case, the only form a
 * cycle's recorded reason takes; nothing in the contract changed.
 * The onboarding-v1, read-v1 and read-v2 digests moved when Uniswap quotes were
 * asked of Universal Router 2.1.2, since Uniswap sunsets 2.0 and 2.1.1 on
 * 21 October 2026: swap-preview's routerVersion const is "2.1.2" (a coordinated
 * change to a candidate never enabled), and read-v1 and read-v2 hash
 * backend/discovery.py, which holds the header. Their wire is unchanged.
 * The read-v1 and read-v2 digests, and the OpenAPI below, moved with the
 * Domino V2 wallet reads: a separate read-v6 (`POST /v6/read/portfolio` and
 * `/v6/read/activity`, api-contracts/read-v6) was added to the reader, the
 * gateway and the bridge client those manifests hash, off in the gateway. No
 * read-v1 or read-v2 route, schema or version changed, and no OpenAPI
 * component of theirs did.
 * The OpenAPI below moved again when the V2 vault gained returnReserves, which
 * anyone may call to pay a closed vault's reserves to its owner: read-v6's
 * contract error names (a waiting reason's `error`) list its two refusals,
 * RootOpen and SuccessorActive. No other route, schema or version changed.
 * onboarding-v1 is 1.1.0 with swap-route, an additive route: Setup's assisted
 * swap routed through Uniswap when that returns more than 0.5% above the pool,
 * with unsigned transactions for the wallet. The two previews are unchanged
 * but for the version. read-v1 and read-v2 moved with it: discovery.py now also
 * admits the router-version header on Uniswap's /swap. Their wire is unchanged.
 * The read-v1 and read-v2 digests moved again on 2026-10-03, when the reader
 * began keeping its RPC connections open between calls (discovery.py,
 * read_service.py) and the gateway began running every read its lanes admit
 * at once instead of two (read_gateway.py). No route, schema, reason code or
 * version changed.
 * They moved once more the same day (#315), when a version 4 provider file
 * began admitting the node's proxy on the services host as its first route,
 * ahead of rpc.domino.money (discovery.py, read_service.py, rpc_config.py,
 * local_config.py, rpc_failover.py). The wire is unchanged.
 */
export const PRODUCER_PIN = {
  producerCommit: 'a5f71f19e6391f3eab52ee6e51417be211bc8ea5',
  producerIssue: 95,
  packages: {
    'read-v1': {
      version: '1.1.0-rc.3',
      // Changed on purpose (data) 2026-10-05: read_api.py, which the manifest hashes, gained read-v6's chain reads; no
      // read-v1 route, schema or version moved.
      // Changed on purpose (data) 2026-10-06: read_gateway.py, which the manifest hashes, gives each reader lane its own visitor budget; no route, schema or version moved.
      // Changed on purpose (data) 2026-10-06: read_api.py names read-v6 chain-balances' balance chain RPC file
      // (Ethereum, OP Mainnet); no read-v1 route, schema or version moved.
      // Changed on purpose (data) 2026-10-06: historical_read.py, which the manifest hashes, projects a ledger's refusal
      // of a source activity chunk over 2,000 events as `*_ledger_not_caught_up` instead of a 502; no read-v1 route,
      // schema, reason code or version moved.
      // Changed on purpose (data) 2026-10-06: read_service.py, which the manifest hashes, answers pool-activity for a
      // registered pool whose stored walk is 24 h or more behind with the existing live-window answer; no read-v1
      // route, schema or version moved.
      // Changed on purpose (data) 2026-10-06: read_service.py reads a live window's logs on their own client and
      // retries a refused range on a fresh one; no read-v1 route, schema or version moved.
      // Changed on purpose (data) 2026-11-02: read_gateway.py and read_api.py, which the manifest hashes, raise a
      // visitor's provider budget to 30, then 300 a minute, and the stored lanes to eight for the public launch; no
      // read-v1 route, schema or version moved.
      // Changed on purpose (data) 2026-11-02: activity_store.py and activity_indexer.py, which the manifest hashes, read
      // a pool's newest chunks by start_block, through the primary key; no read-v1 route, schema or version moved.
      // Changed on purpose (data) 2026-11-02: discovery.py, which the manifest hashes, reads StateView and the
      // PositionManager with a 30M gas ceiling and takes "err: intrinsic gas too low (supplied gas N)" as
      // rpc_call_gas_limit, an existing reason code (an L1 price spike failed every read on 29 Oct); no read-v1 route,
      // schema, reason code or version moved.
      // Changed on purpose (data) 2026-11-03: discovery.py and rpc_failover.py, which the manifest hashes, move a read
      // to its next route when a call outlives its own ceiling with the read's time left, and hold that route for
      // 15 s; to every caller it is still read_deadline_exceeded, an existing reason code. No read-v1 route, schema,
      // reason code or version moved.
      manifestSha256: 'f268fdc8fa616bba556d7175a332bb9fd16291a9cb1d339212d273461dbe9c2d',
    },
    'session-v1': {
      version: '3.0.0-rc.4',
      // Changed on purpose (data) 2026-11-02: session_store.py, which the manifest hashes, raises the sign-in and
      // signed-in rate limits for the public launch; no route, schema, reason code or version moved.
      manifestSha256: '7e815e11ce6e86fb9af7627a949c88ae677cd2340f4cd19d2943f7560dae18d9',
    },
    'onboarding-v1': {
      version: '1.1.0',
      // Changed on purpose (data) 2026-10-06: authenticated_api.py, which the manifest hashes, lets a family accept a
      // second contract version for a switch window (crosschain-v1's); onboarding-v1 keeps its one, and no route, schema
      // or version moved.
      // Changed on purpose (data) 2026-11-02: session_store.py, which the manifest hashes, raises the signed-in rate
      // limits for the public launch; no route, schema, reason code or version moved.
      manifestSha256: 'ea2e65fd801c02860529248df2ce1a603a1c682c3f03c69e529a69c70ab5527d',
    },
    'deposit-v1': {
      version: '1.1.0-rc.4',
      // Changed on purpose (data) 2026-10-06: authenticated_api.py, which the manifest hashes, lets a family accept a
      // second contract version for a switch window (crosschain-v1's); deposit-v1 keeps its one, and no route, schema or
      // version moved.
      manifestSha256: '3bd57d043a0534d6af4140dd06750eab515e5a52d134eff65ddf3d1b4b240fb6',
    },
  },
} as const

/** Separately opted-in public pool estimates; never accepted as a v1 response. */
// Changed on purpose (data) 2026-10-02 (Domino V2 integration, bridge): read-v2's manifest hashes the read Worker, its
// config and the forwarder, which gained read-v6 and the position-plan family; no read-v2 route, schema or version moved.
export const READ_V2_PIN = {
  version: '2.0.0-rc.1',
  // Changed on purpose (data) 2026-10-05: read_api.py gained read-v6's chain reads; no read-v2 route, schema or version moved.
  // Changed on purpose (data) 2026-10-06: read_gateway.py, which the manifest hashes, gives each reader lane its own visitor budget; no route, schema or version moved.
  // Changed on purpose (data) 2026-10-06: read_api.py names read-v6 chain-balances' balance chain RPC file; no read-v2
  // route, schema or version moved.
  // Changed on purpose (data) 2026-10-06: read_service.py, which the manifest hashes, serves a pool walked 24 h or
  // more behind from its live window; no read-v2 route, schema or version moved.
  // Changed on purpose (data) 2026-10-06: read_service.py retries a live window's refused log range on a fresh
  // client; no read-v2 route, schema or version moved.
  // Changed on purpose (data) 2026-11-02: read_gateway.py and read_api.py raise a visitor's provider budget and the
  // stored lanes for the public launch; no read-v2 route, schema or version moved.
  // Changed on purpose (data) 2026-11-02: discovery.py reads StateView and the PositionManager with a 30M gas
  // ceiling and takes an intrinsic gas refusal as rpc_call_gas_limit; no read-v2 route, schema or version moved.
  // Changed on purpose (data) 2026-11-03: bridge_identity.py, which the manifest hashes, refreshes Cloudflare
  // Access's keys in the background; no read-v2 route, schema or version moved.
  // Changed on purpose (data) 2026-11-03: discovery.py tells a call that outlived its own ceiling from a read that
  // outlived its deadline, so a failover client asks the next route; no read-v2 route, schema or version moved.
  manifestSha256: 'a053d0bb3c3f06ccf12d71b7e66571aeb64a32278318c47a11f3b7d8ac06a9c4',
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
 *
 * rc.2 since 2026-09-28 (featured-policy v2, rugged's handoff of that day): a
 * list may rank by today's APR, a market rule may be off (null), and a ranked
 * pool may have no previous-day APR or measured depth. The runtime still takes
 * rc.1, held to rc.1's rules, while the VM moves to rc.2 (CONTRACT_VERSIONS);
 * `version` is the one this build asks in. The read-v2 digest moved with it
 * only because that manifest hashes the read Worker (bridge/src/worker.mjs),
 * which now takes both versions, and the Pages forwarder
 * (functions/_lib/bridge.ts), whose header comment the speed wave changed
 * without moving the manifest; nothing in read-v2 changed.
 */
export const READ_V5_PIN = {
  version: '1.0.0-rc.2',
  runtimeSha256: 'f3a705de31761b4e02a17bc671c726891c6302e621ecb5e0124a85d5254068cd',
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
  // Changed on purpose (data) 2026-10-05: three read-v6 paths (chain-pools, chain-balances, chain-tokens).
  // Changed on purpose (data) 2026-10-05: read-v6 activity's reserves_returned item.
  // Changed on purpose (data) 2026-10-05: read-v6 1.1.0-rc.1's qualified USD (prices, depth, values and totals).
  // Changed on purpose (data) 2026-10-06: read-v6 chain-balances' BalanceTokenRef and ChainBalances also take Ethereum
  // (1) and OP Mainnet (10); no other route, schema or version moved.
  sha256: '2e048dfcbebfc4ea40f7324fb4f5bfffafa3d891f829168bf87d2b123eca654e',
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
  // Changed on purpose (data) 2026-10-06: authenticated_api.py, which the manifest hashes, lets a family accept a second
  // contract version for a switch window (crosschain-v1's); performance-v2 keeps its one, and no route, schema or
  // version moved.
  manifestSha256: '8fe57c6938fe66fd18db5149b9ae362088fe8ef7f8f265bee39e1d6673fe73ee',
} as const

/** Sanitized private execution status, finalized receipts and short-lived service availability. */
export const EXECUTION_V1_PIN = {
  version: '1.0.0-rc.1',
  // Changed on purpose (data) 2026-10-06: authenticated_api.py, which the manifest hashes, lets a family accept a second
  // contract version for a switch window (crosschain-v1's); execution-v1 keeps its one, and no route, schema or version
  // moved.
  manifestSha256: '19ea0a9de9b74e8f71ef717843c8bc0f9087c70bac109658fb1d48aa6e7d43d0',
} as const
