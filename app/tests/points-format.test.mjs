/**
 * The Points page's numbers and its season (added 2026-11-07, the owner's Points page, Season 1;
 * integ-logs/points/PROPOSAL.md §4): points-v1's decimal text formatted as text, cut and never rounded up, never turned
 * into a floating-point number; points by kind of fee as the dollars times 1,000, exactly; and Season 1's window as the
 * season's own file has it (backend/points_season_1.json).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const APP = resolve(import.meta.dirname, '..');
const REPO = resolve(APP, '..');
const format = require('../.test-build/app/src/points/format.js');
const season = require('../.test-build/app/src/points/season.js');
const fixture = JSON.parse(readFileSync(join(REPO, 'api-contracts/points-v1/fixtures/responses/points.json'), 'utf8'));

test('points: whole from 100, up to two places below, <0.01 under a hundredth, 0 for zero; always cut', () => {
  for (const [text, shown] of [
    ['1715.000000', '1,715'],
    ['1234567.000000', '1,234,567'],
    ['100.999999', '100'],
    ['999.999999', '999'],
    ['99.999999', '99.99'],
    ['65.000000', '65'],
    ['65.500000', '65.5'],
    ['12.340000', '12.34'],
    ['12.349999', '12.34'],
    ['1.050000', '1.05'],
    ['0.010000', '0.01'],
    ['0.009999', '<0.01'],
    ['0.000001', '<0.01'],
    ['0.000000', '0'],
    ['0', '0'],
    ['000123.000000', '123'],
  ]) {
    assert.equal(format.pointsText(text), shown, text);
  }
  assert.equal(format.pointsText('-1.000000'), '–', 'not a decimal points-v1 writes');
  assert.equal(format.pointsText('1e3'), '–');
});

test('dollars: two places, cut to the cent, <$0.01 under a cent, $0 for zero', () => {
  for (const [text, shown] of [
    ['0.650000000000000000', '$0.65'],
    ['0.350000000000000000', '$0.35'],
    ['1234.567890000000000000', '$1,234.56'],
    ['21.349999999999999999', '$21.34'],
    ['0.009999999999999999', '<$0.01'],
    ['0.000000000000000001', '<$0.01'],
    ['0.000000000000000000', '$0'],
    ['5', '$5.00'],
  ]) {
    assert.equal(format.usdText(text), shown, text);
  }
});

test('points by kind are the dollars times 1,000, moved in the text with points-v1’s six places', () => {
  for (const [usd, points] of [
    ['0.650000000000000000', '650.000000'],
    ['0.350000000000000000', '350.000000'],
    ['21.340000000000000000', '21340.000000'],
    ['0.000000000000000000', '0.000000'],
    ['0.000001234567890123', '0.001234'],
    ['123456789.123456789123456789', '123456789123.456789'],
    ['3', '3000.000000'],
  ]) {
    assert.equal(format.usdToPoints(usd), points, usd);
  }
  // The contract's own example: 0.65 + 0.65 + 0.35 dollars are 650 + 650 + 350 = 1,650 points from use.
  const kinds = fixture.wallet.revenueUsd;
  assert.deepEqual(['assistedSwap', 'automation', 'autoExit', 'bridge'].map((kind) => format.pointsText(format.usdToPoints(kinds[kind]))), ['650', '650', '0', '350']);
  assert.equal(format.pointsText(fixture.wallet.usagePoints), '1,650');
  assert.equal(format.pointsText(fixture.wallet.points), '1,715');
  assert.equal(format.pointsText(fixture.wallet.referralPoints), '65');
  assert.equal(format.isZero(kinds.autoExit), true, 'Auto-exit at $0 is left out of What earned them');
  assert.equal(format.isZero(kinds.bridge), false);
});

test('the clock, the short address and the short hash', () => {
  assert.equal(format.utcClock(fixture.snapshot.takenAt), '02:05 UTC');
  assert.equal(format.shortAddress('0x4a62316623ad457f02cdc5d997ded67a383ec569'), '0x4a62…c569');
  assert.equal(format.shortHash(fixture.season.configSha256), '1657…fd98');
});

test('nothing in the formatters turns text into a floating-point number', () => {
  const source = readFileSync(join(APP, 'src/points/format.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(source, /\bNumber\(|parseFloat|parseInt|\bMath\.|toFixed|\+\s*text\b/, 'string math only');
});

test('Season 1 is the season’s own file: 9 Nov 2026 to 9 Feb 2027, 00:00 UTC, 92 days', () => {
  const file = JSON.parse(readFileSync(join(REPO, 'backend/points_season_1.json'), 'utf8'));
  assert.equal(season.SEASON_1.id, file.id);
  assert.equal(season.SEASON_1.startMs, file.startUnix * 1000);
  assert.equal(season.SEASON_1.endMs, file.endUnix * 1000);
  assert.equal(season.SEASON_1.startMs, Date.parse(file.start));
  assert.equal(season.SEASON_1.endMs, Date.parse(file.end));
  assert.equal(season.SEASON_1.id, fixture.season.id);
  assert.equal(season.SEASON_1.title, fixture.season.title);
  assert.equal(season.SEASON_1.startMs, Date.parse(fixture.season.start));
  assert.equal(season.SEASON_1.endMs, Date.parse(fixture.season.end));
  assert.equal(season.SEASON_DAYS, 92);
  const start = season.SEASON_1.startMs;
  assert.equal(season.seasonPhase(start - 1), 'before');
  assert.equal(season.seasonPhase(start), 'during');
  assert.equal(season.seasonPhase(season.SEASON_1.endMs - 1), 'during');
  assert.equal(season.seasonPhase(season.SEASON_1.endMs), 'after');
  assert.equal(season.seasonDay(start), 1);
  assert.equal(season.seasonDay(start + 86_400_000 * 37 + 1), 38);
  assert.equal(season.seasonDay(season.SEASON_1.endMs - 1), 92);
  assert.equal(season.seasonDay(start - 1), null);
  // The words name the same window.
  const { POINTS_WORDS } = require('../.test-build/app/src/points/words.js');
  assert.equal(POINTS_WORDS.seasonDates, '9 Nov 2026 to 9 Feb 2027');
  assert.ok(POINTS_WORDS.details.some(([term, line]) => term === 'Season window' && line === '9 Nov 2026, 00:00 UTC to 9 Feb 2027, 00:00 UTC'));
  assert.equal(POINTS_WORDS.seasonLine(38), 'Season 1: 9 Nov 2026 to 9 Feb 2027, day 38 of 92.');
});
