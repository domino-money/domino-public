/**
 * The V2 API contracts this app is built against (spec F7 rev2 §2.4, §6.2), pinned as src/lib/read/pin.ts pins V1's:
 * the contract version and the SHA-256 of the package's manifest.json, whose `files` list hashes every file the app
 * and its tests read (tests/v2/pins.test.mjs recomputes both). A producer change that lands in the tree fails that test
 * before any screen validates a payload against a contract it was not built for. Kept apart from lib/read/pin.ts so
 * V1's pin module is byte for byte what it was.
 *
 * Both packages are candidates, switched off until the deploy and the Worker routes exist:
 * - read-v6 `1.1.0-rc.1` (main 4edd0720, #305; qualified USD, 0xdecimal's item 4): `candidate_disabled_pending_bridge_and_deployment`;
 * - position-plan-v1 `1.0.0-rc.2` (PR #308 a620b6d1): `candidate_disabled_pending_deployment_and_worker`.
 */
export const READ_V6_PIN = {
  // Changed on purpose 2026-10-05: 1.0.0-rc.1 -> 1.1.0-rc.1, qualified USD (0xdecimal's item 4): token prices, chain-pools'
  // depth, chain-balances' values and totals.
  version: '1.1.0-rc.1',
  // Changed on purpose (data) 2026-10-02: main d1ad6c41 (#311) added read-v6's reserves waiting reasons; same version.
  // Changed on purpose (data) 2026-10-04: main's V2 audit remediation (#323) added TwapWindowTooLong and two portfolio
  // fields to read-v6; same version, new manifest.
  // Changed on purpose (data) 2026-10-05: the live chain reads chain-pools, chain-balances and chain-tokens joined
  // read-v6 (0xdecimal's items 1-3); same version, new manifest.
  // Changed on purpose (data) 2026-10-05: activity's reserves_returned kind (0xdecimal's item 8); same version.
  // Changed on purpose (data) 2026-10-06: chain-pools' depth reads bounded (the producer's v2_chain_reads.py, its
  // fixture builder and the README's reasons); same version, same schemas and fixtures.
  // Changed on purpose (data) 2026-10-06: the producer's v2_chain_reads.py reads over kept connections and the chains
  // of one answer at once; same version, same schemas and fixtures.
  // Changed on purpose (data) 2026-10-06: read_gateway.py, which the manifest hashes, gives each reader lane its own visitor budget; no route, schema or version moved.
  // Changed on purpose (data) 2026-10-06: chain-balances also reads Ethereum (1) and OP Mainnet (10) when a request
  // names them (the owner's decision); same version, new schemas and fixtures for balance chain ids (BalanceTokenRef and
  // ChainBalances take them, PRICE_PROFILES and CONSTANTS.balanceChainIds carry them). Every other route and the default
  // answer are Domino's three chains, as before.
  // Changed on purpose (data) 2026-10-06: a mandate's waiting reason from before its vault's latest ExitModuleSet is
  // not shown (v2_read_service.py, v2_index_store.py); same version, same schemas and fixtures.
  // Changed on purpose (data) 2026-11-02: read_gateway.py and read_api.py, which the manifest hashes, raise a visitor's
  // provider budget and the stored lanes for the public launch; same version, same schemas and fixtures.
  // Changed on purpose (data) 2026-11-02: a position's `vault` is the vault it belongs to now, from the events (a newer
  // vault for the same root replaces the old one; null once that vault let it go: Leave automation, its auto-exit, a
  // successor withdrawn), not the first vault forever (v2_index_store.py, v2_read_service.py, the README); same
  // version, same schemas and fixtures.
  // Changed on purpose (data) 2026-11-03 (launch round P2): read_api.py and read_gateway.py: a stored read waits
  // about a second for a lane, and one visitor holds at most half of a lane; no route, schema, reason code or version
  // moved.
  // Changed on purpose (data) 2026-11-04 (launch round P3): 1.2.0-rc.1 adds position-fees (Base's and Arbitrum's Fees
  // earned, migration 054) in a version window answered only to a request that names it; the package's own version,
  // routes and fixtures stay 1.1.0-rc.1.
  manifestSha256: 'a79c38aa80f9ec4909ee8c9435b1cc3ca1b7a0b085912355047ecc83f269569b',
} as const

export const POSITION_PLAN_V1_PIN = {
  version: '1.0.0-rc.2',
  // Changed on purpose (data) 2026-10-05: main's #337 and #338 changed two backend sources the manifest lists
  // (v2_uniswap_api.py, v2_position_plan.py); the package's own files and its version are unchanged.
  // Changed on purpose (data) 2026-10-06: authenticated_api.py, which the manifest hashes, lets a family accept a second
  // contract version for a switch window (crosschain-v1's); position-plan-v1 keeps its one, and its files and version
  // are unchanged.
  // Changed on purpose (data) 2026-11-02: v2_position_plan_service.py, which the manifest hashes, keeps a read refused
  // for its intrinsic gas (an L1 price spike) as upstream_unavailable now that it reads as rpc_call_gas_limit; no
  // route, schema, error code or version moved.
  // Changed on purpose (data) 2026-11-03 (launch round P2): v2_position_plan.py, v2_position_plan_api.py,
  // v2_quotes.py and v2_uniswap_api.py ask a plan's chain and Trading API calls over kept connections and never ask
  // again for an answer in hand (the same plans), and authenticated_api.py and onboarding_auth.py name a 429's Retry-
  // After by cause, wait up to 2.5 s for a free worker and give each kind of signed-in work its own preview budget;
  // no route, schema, reason code or version moved.
  // Changed on purpose (data) 2026-11-04 (launch round P3): authenticated_api.py, onboarding_auth.py and
  // v2_position_plan_api.py: a session belongs to the origin it signed in on, and a listed preview origin rides its
  // own Access identity; no route, schema, reason code or version moved.
  manifestSha256: '0567c8cde23f095fa71b8df30c3d7f7976c47ef439af11e203a69dc5761be838',
} as const
