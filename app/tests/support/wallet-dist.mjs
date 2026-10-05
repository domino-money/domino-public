/**
 * Which wallet test build the browser suites serve (Domino V2 integration, 2026-10-02, the base agent's item 3).
 *
 * By default the wallet-test build, as always. scripts/v1-on-v2.mjs runs V1's suites on wallet-test-v2, the same build
 * with Domino V2 compiled in (`DOMINO_WALLET_DIST=.wallet-test-v2-dist`), and V2's own browser suites serve
 * WALLET_V2_DIST directly. No other directory is accepted, so a suite can never be pointed at a build it was not
 * written for.
 */
import { resolve } from 'node:path';

const APP = resolve(import.meta.dirname, '../..');

/** The wallet-test build (vite.config.ts MODES `wallet-test`). */
export const WALLET_TEST_DIST = resolve(APP, '.wallet-test-dist');
/** The same build with V2 compiled in (MODES `wallet-test-v2`). */
export const WALLET_V2_DIST = resolve(APP, '.wallet-test-v2-dist');

const asked = process.env.DOMINO_WALLET_DIST;
if (asked !== undefined && asked !== '' && asked !== '.wallet-test-dist' && asked !== '.wallet-test-v2-dist') {
  throw new Error(`DOMINO_WALLET_DIST may be .wallet-test-dist or .wallet-test-v2-dist, not ${asked}.`);
}

/** The build this process's suites serve. */
export const WALLET_DIST = asked === '.wallet-test-v2-dist' ? WALLET_V2_DIST : WALLET_TEST_DIST;
