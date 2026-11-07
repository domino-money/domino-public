/**
 * FIXTURE manifests for Domino V2, one per chain, until #301 publishes the real ones (spec F7 rev2 §7.2, §7.5). They are
 * NOT deployments.
 *
 * Changed on purpose (data) 2026-10-03 (main 597bcb7b, #302 merged): they are the merged #302 fork-rehearsal
 * manifests, byte for byte (docs/deployments/v2-rehearsal-2026-10-02/<slug>-<chainId>-deployment.json), in the exact
 * format the backend loader and scripts/v2/deploy-schema.mjs check:
 *   - `environment: fork-rehearsal`: deployed on disposable Anvil forks of each chain, with real Uniswap code and real
 *     dependencies, sending nothing to a public chain;
 *   - the owner's REAL roles of 2 Oct 2026 (docs/v2/DEPLOYMENT.md: deployer 0x7066…2747, the governance Safe, …), so
 *     their 13 addresses are the very CREATE3 addresses the production deployment will have;
 *   - `verification.blockTag: latest`, not `finalized`.
 * So they pass the `fork-rehearsal` admission and FAIL the production admission (environment, block tag; and the pinned
 * map takes production manifests only).
 *
 * What makes them unmistakable:
 *   - only the test admission takes them (./manifest.ts parseV2FixtureManifest), which a deployable build, and any Vite
 *     build without V2, refuses before reading (`manifest_fixture_refused`); a set they yield says `fixture: true`, which
 *     never enables a real financial operation (spec §1.7, §7.5; src/finance/v2/liveLock.ts);
 *   - scripts/deploy-markers.mjs refuses a deployable bundle that carries their rehearsal receipts or verification
 *     blocks (their addresses are production's, so they cannot be the marker any more), so this module can never ship:
 *     import it only in tests, or behind a branch a deployable build folds away;
 *   - the file names say `.fixture.json`.
 *
 * This is the only TypeScript file that names the fixture files; ./manifest.ts never does, so a deployable bundle that
 * includes the parser stays clean.
 */
import robinhood from './fixtures/manifest.robinhood-4663.fixture.json'
import base from './fixtures/manifest.base-8453.fixture.json'
import arbitrum from './fixtures/manifest.arbitrum-42161.fixture.json'
import elysium from './fixtures/manifest.elysium-99901.fixture.json'
import { ELYSIUM_LIVE, ELYSIUM_V2_ID } from '../lib/elysiumIdentity'
import { parseV2FixtureManifest, type ManifestPin } from './manifest'
import type { V2ChainId, V2Contracts } from './types'

/** The admission the fixtures pass: #302's fork rehearsal. */
export const FIXTURE_ADMISSION = 'fork-rehearsal' as const

/**
 * Elysium's fixture (added 2026-11-07, Elysium as a fourth V2 chain), where it is live: not one of #302's files (no fork
 * rehearsal of chain 99901 exists yet), but Arbitrum One's rehearsal moved to the synthetic Elysium profile the forced
 * test builds serve (tests/fixtures/v2-chains/elysium-99901.json), exactly as deploy.mjs writes a chain with Uniswap v4
 * alone: nine contracts, `contractNames` the 13, v4's dependencies at that profile's addresses with its verified code
 * hashes, its charge currencies (tests/v2/support/v4-only.mjs v4OnlyManifest, which tests/v2/elysium-chain.test.mjs holds
 * it to). Its addresses are the owner's CREATE3 addresses, as every rehearsal's. It binds to that synthetic profile only;
 * against rugged97's real one ./gate.ts previewSet falls back to Elysium's pinned production set.
 */
const ELYSIUM_FIXTURE: Partial<Record<V2ChainId, unknown>> = ELYSIUM_LIVE ? { [ELYSIUM_V2_ID]: elysium } : {}
const ELYSIUM_FIXTURE_PIN: Partial<Record<V2ChainId, ManifestPin>> = ELYSIUM_LIVE
  ? { [ELYSIUM_V2_ID]: { path: 'app/src/v2/fixtures/manifest.elysium-99901.fixture.json', sha256: '6d16910207bd70a5ed72c090307266f3314949d6ef54caea0875ac85334168b7' } }
  : {}

/** chainId → that chain's fixture manifest, as the file holds it. */
export const FIXTURE_MANIFESTS: Readonly<Record<V2ChainId, unknown>> = Object.freeze({ 4663: robinhood, 8453: base, 42161: arbitrum, ...ELYSIUM_FIXTURE } as Record<V2ChainId, unknown>)

/** chainId → the fixture file and the SHA-256 of its exact bytes, checked by tests/v2/manifest-pin.test.mjs. */
export const FIXTURE_PINS: Readonly<Record<V2ChainId, ManifestPin>> = Object.freeze({
  4663: { path: 'app/src/v2/fixtures/manifest.robinhood-4663.fixture.json', sha256: 'c0e7e2efe74670655a36a317756e6600dc9e79a7d1693db45c7ec88682906f6a' },
  8453: { path: 'app/src/v2/fixtures/manifest.base-8453.fixture.json', sha256: '1eb710c45a71012fd8799b26ab3ddde0131514238b9a94498ffaa143d5bef19b' },
  42161: { path: 'app/src/v2/fixtures/manifest.arbitrum-42161.fixture.json', sha256: 'b29f180ce6dd5fa14d260851055d5debec4d33f32da06073e3941fb064b12b8d' },
  ...ELYSIUM_FIXTURE_PIN,
} as Record<V2ChainId, ManifestPin>)

/** A fixture manifest, checked as a deployment manifest is, for the chain asked, under the fork-rehearsal admission. */
export function parseFixtureManifest(raw: unknown, chainId: number): V2Contracts {
  return parseV2FixtureManifest(raw, chainId, FIXTURE_ADMISSION)
}

/** The fixture V2 contracts of one chain (`fixture: true`). */
export function fixtureContracts(chainId: V2ChainId): V2Contracts {
  return parseFixtureManifest(FIXTURE_MANIFESTS[chainId], chainId)
}
