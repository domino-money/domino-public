/**
 * TEST-ONLY. Day 9's read-v6 and position-plan-v1 runtimes, rehearsed (added 2026-11-07, Elysium's screens): rugged97's
 * packages' own runtimes over their data as the day-9 versions have it, naming chain 99901 (scripts/elysium-rehearsal.mjs,
 * from the forced profile tests/fixtures/v2-chains/elysium-99901.json): exactly what a build forcing Elysium on bundles
 * (vite.config.ts elysiumRehearsal). The browser suites' fixture services check every answer they serve on such a build
 * with these, as they check the others' with the packages themselves.
 *
 * How: each runtime's file, verbatim, is written beside its rehearsed `schema-data.mjs` in a directory of this process's
 * own under the system's temporary directory, with `../shared/closed-schema.mjs` re-exporting the package's own; the
 * directory is removed when the process exits. Nothing under api-contracts/ is written.
 *
 * Changed on purpose 2026-11-07 (day-9 rehearsal, finding F5): once rugged97's package names 99901 it is day 9's itself,
 * so READ_V6_DAY9 / PLAN_DAY9 are the package (its runtime and its CONSTANTS, as the app bundles them), and
 * ELYSIUM_DAY9_PROFILE is the profile the suites stand on (./elysium-profile.mjs: the repository's own once it turns
 * Elysium on, the synthetic one before). The suites' answers are then built from the real profile and checked with the
 * real packages, never the synthetic profile's addresses against rugged97's rows.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { moduleSource, rehearsePlan, rehearseReadV6 } from '../../scripts/elysium-rehearsal.mjs';
import { planNames, readV6Names } from '../../scripts/elysium-switch.mjs';
import * as readV6Data from '../../../api-contracts/read-v6/schema-data.mjs';
import * as planData from '../../../api-contracts/position-plan-v1/schema-data.mjs';
import { ELYSIUM_SUITE_PROFILE } from './elysium-profile.mjs';

const CONTRACTS = new URL('../../../api-contracts/', import.meta.url);
export const ELYSIUM_DAY9_PROFILE = ELYSIUM_SUITE_PROFILE;

let root = null;
function scratch() {
  if (root !== null) return root;
  root = mkdtempSync(join(tmpdir(), 'domino-elysium-day9-'));
  process.once('exit', () => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'shared'));
  writeFileSync(join(root, 'shared', 'closed-schema.mjs'), `export * from ${JSON.stringify(new URL('shared/closed-schema.mjs', CONTRACTS).href)};\n`);
  return root;
}

async function rehearsed(name, data) {
  const dir = scratch();
  mkdirSync(join(dir, name));
  writeFileSync(join(dir, name, 'runtime.mjs'), readFileSync(new URL(`${name}/runtime.mjs`, CONTRACTS), 'utf8'));
  writeFileSync(join(dir, name, 'schema-data.mjs'), moduleSource(data));
  return { runtime: await import(pathToFileURL(join(dir, name, 'runtime.mjs')).href), CONSTANTS: data.CONSTANTS };
}

/** A package as the app bundles it: its own runtime and constants. */
const itself = async (name, data) => ({ runtime: await import(new URL(`${name}/runtime.mjs`, CONTRACTS).href), CONSTANTS: data.CONSTANTS });

/** read-v6 on day 9: its runtime, and the constants it reads (`chainIds` ending with 99901). */
export const READ_V6_DAY9 = readV6Names(readV6Data.CONSTANTS.chainIds) ? await itself('read-v6', readV6Data) : await rehearsed('read-v6', rehearseReadV6(readV6Data, ELYSIUM_DAY9_PROFILE));
/** position-plan-v1 on day 9: its runtime, and the constants it reads (`chains` with a 99901 row). */
export const PLAN_DAY9 = planNames(planData.CONSTANTS.chains) ? await itself('position-plan-v1', planData) : await rehearsed('position-plan-v1', rehearsePlan(planData, ELYSIUM_DAY9_PROFILE));
