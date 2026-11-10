/**
 * Elysium's opening day in the visitor's own time (added 2026-11-07, Elysium's pre-launch; src/lib/elysiumOpening.ts).
 * The words that carry the date ("Opens Nov 9" on Home, "It opens on November 9." in the docs) must never show a day
 * that has passed: they drop it at the start of the opening day, local midnight, in the browser's own time zone, so a
 * page left open or a release that comes late stays true. Each zone runs in a node process of its own with TZ set
 * (tests/support/elysium-opening-zone.mjs), from UTC-12 to UTC+14, the half and quarter hours included; a platform that
 * ignored TZ fails here, never skips. The browser suite drives the same rule on Home and the docs with a fake clock
 * (tests/v2in-browser/elysium-surface.test.mjs).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { ELYSIUM_OPENS_ON, elysiumSwitch, openingOf } from '../scripts/elysium-switch.mjs';

const APP = resolve(import.meta.dirname, '..');
const CHILD = join(APP, 'tests/support/elysium-opening-zone.mjs');
const read = (path) => readFileSync(join(APP, path), 'utf8').replace(/\r\n/g, '\n');
const AT = [2026, 11, 9];

/** Each zone, its offset on 9 Nov 2026 as getTimezoneOffset() says it (minutes, UTC minus local), and its local midnight. */
const ZONES = [
  ['Etc/GMT+12', 720, '2026-11-09T12:00:00.000Z'],
  ['Pacific/Pago_Pago', 660, '2026-11-09T11:00:00.000Z'],
  ['America/Sao_Paulo', 180, '2026-11-09T03:00:00.000Z'],
  ['UTC', 0, '2026-11-09T00:00:00.000Z'],
  ['Asia/Kolkata', -330, '2026-11-08T18:30:00.000Z'],
  ['Asia/Kathmandu', -345, '2026-11-08T18:15:00.000Z'],
  ['Pacific/Tongatapu', -780, '2026-11-08T11:00:00.000Z'],
  ['Pacific/Chatham', -825, '2026-11-08T10:15:00.000Z'],
  ['Pacific/Kiritimati', -840, '2026-11-08T10:00:00.000Z'],
];

function inZone(zone, probes) {
  const run = spawnSync(process.execPath, [CHILD, JSON.stringify({ at: AT, probes })], { cwd: APP, env: { ...process.env, TZ: zone }, encoding: 'utf8' });
  assert.equal(run.status, 0, `${zone}: ${run.stderr}`);
  return JSON.parse(run.stdout);
}
const iso = (ms) => new Date(ms).toISOString();

test('the dated words end at local midnight of the opening day, in every time zone from UTC-12 to UTC+14', () => {
  for (const [zone, offset, midnight] of ZONES) {
    const M = Date.parse(midnight);
    const probes = [iso(M - 1), iso(M), '2026-11-07T12:00:00.000Z', '2026-11-10T12:00:00.000Z', '2026-11-08T10:00:00.000Z', '2026-11-09T11:59:00.000Z'];
    const answer = inZone(zone, probes);
    // The guard: this process really runs in the zone (a platform that ignored TZ would answer UTC's).
    assert.equal(answer.offset, offset, `${zone}: the child runs in the zone (getTimezoneOffset ${answer.offset})`);
    assert.equal(answer.start, M, `${zone}: the first moment of 9 Nov there is ${midnight}`);
    assert.equal(answer.results[iso(M - 1)], true, `${zone}: a millisecond before its midnight, the date still shows`);
    assert.equal(answer.results[iso(M)], false, `${zone}: at its midnight, the date is gone`);
    assert.equal(answer.results['2026-11-07T12:00:00.000Z'], true, `${zone}: 7 Nov`);
    assert.equal(answer.results['2026-11-10T12:00:00.000Z'], false, `${zone}: 10 Nov`);
  }
  // The world's two ends: 10:00Z on 8 Nov is already the 9th at UTC+14 and still the 7th at UTC-12; 11:59Z on 9 Nov is
  // still the 8th at UTC-12 and the 9th in UTC.
  const at = (zone, when) => inZone(zone, [when]).results[when];
  assert.equal(at('Pacific/Kiritimati', '2026-11-08T10:00:00.000Z'), false);
  assert.equal(at('Etc/GMT+12', '2026-11-08T10:00:00.000Z'), true);
  assert.equal(at('Etc/GMT+12', '2026-11-09T11:59:00.000Z'), true);
  assert.equal(at('UTC', '2026-11-09T11:59:00.000Z'), false);
});

test('the date rule is local midnight by numbers, never a parse of the day\'s text (which is midnight in UTC), and reads nothing', () => {
  const source = read('src/lib/elysiumOpening.ts');
  assert.doesNotMatch(source, /Date\.parse/);
  assert.doesNotMatch(source, /new Date\(['"`]/);
  assert.match(source, /new Date\(at\[0\], at\[1\] - 1, at\[2\]\)\.getTime\(\)/);
  assert.doesNotMatch(source, /\bfetch\b|XMLHttpRequest|WebSocket|EventSource|sendBeacon|eth_|localStorage|sessionStorage/);
  // One way: the hook's state only ever turns false, and its timer and listener are cleared.
  assert.match(source, /if \(left <= 0\) setBefore\(false\)/);
  assert.doesNotMatch(source, /setBefore\(true\)/);
  assert.match(source, /Math\.min\(left \+ 250, LONGEST\)/);
  assert.match(source, /const LONGEST = 2_147_483_647/);
  assert.match(source, /document\.removeEventListener\('visibilitychange', check\)/);
});

test('the words that carry the date: month then day in the site\'s English, no year and no weekday', () => {
  const opening = openingOf(ELYSIUM_OPENS_ON ?? '2026-11-09');
  assert.match(opening.short, /^[A-Z][a-z]{2} \d{1,2}$/);
  assert.match(opening.long, /^[A-Z][a-z]+ \d{1,2}$/);
  const repository = elysiumSwitch({ row: { testHooks: false, deployable: true, site: true }, appRoot: APP });
  if (repository.stage === 'prelaunch') assert.deepEqual(repository.opening, openingOf(ELYSIUM_OPENS_ON));
  // Every pre-launch word as written: Home's chip and the docs' section.
  const landing = read('src/screens/Landing.tsx');
  const chip = landing.slice(landing.indexOf('function ElysiumNext()'), landing.indexOf('function Hero()'));
  const intro = read('src/lib/docs/pages/introduction.ts');
  const section = intro.slice(intro.indexOf('...(ELYSIUM_PRELAUNCH ? [{'), intro.indexOf('}] : []),'));
  assert.ok(chip.includes("'Opens next'") && chip.includes('`Opens ${ELYSIUM_OPENING.short}`'), 'Home\'s two tags');
  assert.ok(section.includes("{ beforeElysiumOpens: ' It opens on {day}.' }"), 'the docs\' dated sentence');
  const WEEKDAY = /\b(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b|\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/;
  for (const [where, text] of [['Home', chip], ['docs', section], ['opening', `${opening.short} ${opening.long}`]]) {
    const words = [...text.matchAll(/'([^']*)'|`([^`]*)`/g)].map((match) => match[1] ?? match[2]).join(' | ');
    assert.doesNotMatch(words, /\b20\d\d\b/, `${where}: no year`);
    assert.doesNotMatch(words, WEEKDAY, `${where}: no weekday`);
  }
});
