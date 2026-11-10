/**
 * TEST-ONLY child of tests/elysium-opening.test.mjs (added 2026-11-07, Elysium's pre-launch): run with TZ set to one time
 * zone, it loads the compiled date rule (src/lib/elysiumOpening.ts, .test-build) and prints, as JSON, this process's
 * offset on the opening day, the rule's first moment of that day and its answer for each moment asked about.
 * Usage: TZ=<zone> node tests/support/elysium-opening-zone.mjs '<{"at":[2026,11,9],"probes":["2026-11-08T10:00:00Z"]}>'
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { beforeOpening, openingStart } = require('../../.test-build/app/src/lib/elysiumOpening.js');
const { at, probes } = JSON.parse(process.argv[2]);
const results = Object.fromEntries(probes.map((iso) => [iso, beforeOpening(at, Date.parse(iso))]));
process.stdout.write(JSON.stringify({
  zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  offset: new Date(at[0], at[1] - 1, at[2]).getTimezoneOffset(),
  start: openingStart(at),
  results,
}));
