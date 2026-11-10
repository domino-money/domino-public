/**
 * TEST-ONLY. The Elysium the browser suites stand on (added 2026-11-07, day-9 rehearsal, finding F5): which profile their
 * fakes answer at, and which build draws Elysium live.
 *
 *   - While the repository leaves Elysium off (scripts/elysium-switch.mjs, as the release build reads it): the synthetic
 *     profile tests/fixtures/v2-chains/elysium-99901.json, drawn by the build that forces Elysium on with it
 *     (`.wallet-test-v2-dist-elysium`, scripts/build-elysium-test.mjs), whose contracts are its fork-rehearsal fixture.
 *   - Once the repository turns it on (day 9): rugged97's enabled profile itself, drawn by the usual test build
 *     (`.wallet-test-v2-dist`), which then carries that profile and the pinned record exactly as the release build does.
 *     The forced build cannot stand in for it any more: its fork-rehearsal fixture binds the synthetic profile's name and
 *     addresses alone (src/v2/manifest.ts), so the real profile's answers would never match what it draws.
 *
 * ELYSIUM_REPO_LIVE says which; ELYSIUM_SUITE_PROFILE is the profile (parsed), ELYSIUM_LIVE_DIST the build.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { elysiumSwitch } from '../../scripts/elysium-switch.mjs';
import { WALLET_V2_DIST } from './wallet-dist.mjs';

const APP = resolve(import.meta.dirname, '../..');
const REPOSITORY = elysiumSwitch({ row: { testHooks: false, deployable: true, site: true }, appRoot: APP });

/** Whether the repository turns Elysium on (every day-9 piece is there), as the release build reads it. */
export const ELYSIUM_REPO_LIVE = REPOSITORY.live;
/**
 * Whether the repository's own build takes funds from Elysium, and brings funds to it (added 2026-11-09: true once
 * rugged97's crosschain-v1 pins Relay for 99901 and its profile names it; scripts/elysium-switch.mjs fundsFrom, fundsTo).
 */
export const ELYSIUM_REPO_FUNDS_FROM = REPOSITORY.fundsFrom;
export const ELYSIUM_REPO_FUNDS_TO = REPOSITORY.fundsTo;
/**
 * The repository's stage, as the release build reads it (added 2026-11-07, Elysium's pre-launch): 'live', 'prelaunch'
 * (Home's "Open positions on" row with Elysium's chip and when it opens, and the docs' Elysium section) or 'off'.
 */
export const ELYSIUM_REPO_STAGE = REPOSITORY.stage;
/** The synthetic profile the forced test builds carry. */
export const ELYSIUM_FIXTURE_PROFILE = Object.freeze(JSON.parse(readFileSync(resolve(APP, 'tests/fixtures/v2-chains/elysium-99901.json'), 'utf8')));
/** The profile the suites' fakes answer at: the repository's own once it turns Elysium on, the synthetic one before. */
export const ELYSIUM_SUITE_PROFILE = ELYSIUM_REPO_LIVE ? Object.freeze(JSON.parse(REPOSITORY.profile)) : ELYSIUM_FIXTURE_PROFILE;
/** The build that draws Elysium live with that profile: the usual one on day 9, the forced one before. */
export const ELYSIUM_LIVE_DIST = ELYSIUM_REPO_LIVE ? WALLET_V2_DIST : resolve(APP, '.wallet-test-v2-dist-elysium');
