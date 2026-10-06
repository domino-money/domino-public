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
  manifestSha256: '77fcbd9f680e9f5c682162ebf8348c6bc257f7f169a917427bb8671c01da0afe',
} as const

export const POSITION_PLAN_V1_PIN = {
  version: '1.0.0-rc.2',
  // Changed on purpose (data) 2026-10-05: main's #337 and #338 changed two backend sources the manifest lists
  // (v2_uniswap_api.py, v2_position_plan.py); the package's own files and its version are unchanged.
  manifestSha256: '6206c9454bcfe2ed88d9e860bbb3e0ff9924e4e2a8c425b72e6e47b93dad6110',
} as const
