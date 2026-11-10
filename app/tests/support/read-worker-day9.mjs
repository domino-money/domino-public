/**
 * TEST-ONLY. The read Worker as a build from a `main` that carries rugged97's day-9 read-v6 would be (added 2026-11-07,
 * the read-v6 version skew; docs/ELYSIUM_DAY9.md "Order"): bridge/src/worker.mjs and its two helpers, verbatim, over
 * read-v6's runtime, verbatim, with its day-9 data (scripts/elysium-rehearsal.mjs rehearseReadV6, naming 99901, as
 * tests/support/elysium-day9.mjs loads it); read-v1 to read-v5 are the repository's own, re-exported. Written in a
 * directory of this process's own under the system's temporary directory, removed when the process exits. Nothing under
 * bridge/ or api-contracts/ is written.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { moduleSource, rehearseReadV6 } from '../../scripts/elysium-rehearsal.mjs';
import { ELYSIUM_DAY9_PROFILE } from './elysium-day9.mjs';
import * as readV6Data from '../../../api-contracts/read-v6/schema-data.mjs';

const REPO = new URL('../../../', import.meta.url);
const root = mkdtempSync(join(tmpdir(), 'domino-read-worker-day9-'));
process.once('exit', () => rmSync(root, { recursive: true, force: true }));

const write = (path, text) => {
  mkdirSync(join(root, ...path.split('/').slice(0, -1)), { recursive: true });
  writeFileSync(join(root, ...path.split('/')), text);
};
const verbatim = (path) => write(path, readFileSync(new URL(path, REPO), 'utf8'));
const reexport = (path) => write(path, `export * from ${JSON.stringify(new URL(path, REPO).href)};\n`);

for (const file of ['worker.mjs', 'strict-json.mjs', 'request-contract.mjs']) verbatim(`bridge/src/${file}`);
for (const version of [1, 2, 3, 4, 5]) reexport(`api-contracts/read-v${version}/runtime.mjs`);
reexport('api-contracts/shared/closed-schema.mjs');
verbatim('api-contracts/read-v6/runtime.mjs');
write('api-contracts/read-v6/schema-data.mjs', moduleSource(rehearseReadV6(readV6Data, ELYSIUM_DAY9_PROFILE)));

/** bridge/src/worker.mjs over the day-9 read-v6: its exports (createWorker, LIMITS, ...). */
export const WORKER_DAY9 = await import(pathToFileURL(join(root, 'bridge', 'src', 'worker.mjs')).href);
