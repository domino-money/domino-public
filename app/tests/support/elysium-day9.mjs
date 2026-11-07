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
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { moduleSource, rehearsePlan, rehearseReadV6 } from '../../scripts/elysium-rehearsal.mjs';
import * as readV6Data from '../../../api-contracts/read-v6/schema-data.mjs';
import * as planData from '../../../api-contracts/position-plan-v1/schema-data.mjs';

const CONTRACTS = new URL('../../../api-contracts/', import.meta.url);
export const ELYSIUM_DAY9_PROFILE = JSON.parse(readFileSync(new URL('../fixtures/v2-chains/elysium-99901.json', import.meta.url), 'utf8'));

const root = mkdtempSync(join(tmpdir(), 'domino-elysium-day9-'));
process.once('exit', () => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, 'shared'));
writeFileSync(join(root, 'shared', 'closed-schema.mjs'), `export * from ${JSON.stringify(new URL('shared/closed-schema.mjs', CONTRACTS).href)};\n`);

async function rehearsed(name, data) {
  mkdirSync(join(root, name));
  writeFileSync(join(root, name, 'runtime.mjs'), readFileSync(new URL(`${name}/runtime.mjs`, CONTRACTS), 'utf8'));
  writeFileSync(join(root, name, 'schema-data.mjs'), moduleSource(data));
  return { runtime: await import(pathToFileURL(join(root, name, 'runtime.mjs')).href), CONSTANTS: data.CONSTANTS };
}

/** read-v6 on day 9: its runtime, and the constants it reads (`chainIds` ending with 99901). */
export const READ_V6_DAY9 = await rehearsed('read-v6', rehearseReadV6(readV6Data, ELYSIUM_DAY9_PROFILE));
/** position-plan-v1 on day 9: its runtime, and the constants it reads (`chains` with a 99901 row). */
export const PLAN_DAY9 = await rehearsed('position-plan-v1', rehearsePlan(planData, ELYSIUM_DAY9_PROFILE));
