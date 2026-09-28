/**
 * A position's Activity rows (src/components/positions/visual/activityRows.ts, the owner, 2026-09-27: plain words, and
 * show when Domino's automation put the fees back). A row is the automation's only when its transaction is one the
 * vault's own record names (lib/automationImpact.ts): a collect and an increase in one transaction are otherwise two
 * rows in neutral words, whoever sent them (the 2026-09-27 review: NFT 2310187's own pairs came before Domino's vaults
 * existed).
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { ROW_VERB, activityRows } = require('../.test-build/app/src/components/positions/visual/activityRows.js');

const ev = (kind, tx, id = '7') => ({ id, kind, tx });
/** What a test reads of the rows: kind, the transaction of the event shown, and whether its figure is " in fees". */
const shape = (rows) => rows.map(({ event, kind, inFees }) => [kind, event.tx, event.kind, inFees]);

test('the words are plain, and "Fees added back" is the automation’s alone', () => {
  assert.deepEqual(ROW_VERB, { mint: 'Opened', collect: 'Fees collected', increase: 'Added to position', decrease: 'Withdrew part', close: 'Closed', auto: 'Fees added back' });
});

test('with no record of the automation, a collect and an increase in one transaction stay two neutral rows', () => {
  const events = [ev('collect', '0xc'), ev('increase', '0xb'), ev('collect', '0xb'), ev('mint', '0xa')];
  const rows = activityRows(events);
  assert.deepEqual(shape(rows), [
    ['collect', '0xc', 'collect', false],
    ['increase', '0xb', 'increase', true],
    ['collect', '0xb', 'collect', false],
    ['mint', '0xa', 'mint', true],
  ]);
  // A record that names other transactions changes nothing here.
  assert.deepEqual(shape(activityRows(events, new Set(['0xd']))), shape(rows));
  assert.ok(rows.every((row) => row.kind !== 'auto'));
});

test('a transaction the vault’s record names is one "Fees added back" row showing the fees it collected, in either order', () => {
  const auto = new Set(['0xb', '0xd']);
  const rows = activityRows([ev('increase', '0xd'), ev('collect', '0xd'), ev('collect', '0xc'), ev('collect', '0xb'), ev('increase', '0xb'), ev('mint', '0xa')], auto);
  assert.deepEqual(shape(rows), [
    ['auto', '0xd', 'collect', false],
    ['collect', '0xc', 'collect', false],
    ['auto', '0xb', 'collect', false],
    ['mint', '0xa', 'mint', true],
  ]);
});

test('the vault’s one increase that settled the fees itself (its NET action) is a "Fees added back" row; a lone increase of the owner’s is "Added to position … in fees"', () => {
  const rows = activityRows([ev('increase', '0xe'), ev('increase', '0xd'), ev('decrease', '0xc'), ev('close', '0xf')], new Set(['0xd']));
  assert.deepEqual(shape(rows), [
    ['increase', '0xe', 'increase', true],
    ['auto', '0xd', 'increase', false],
    ['decrease', '0xc', 'decrease', true],
    ['close', '0xf', 'close', true],
  ]);
});

test('only a collect and an increase of the same NFT and transaction are joined; a decrease in a named transaction keeps its own row', () => {
  const auto = new Set(['0xb']);
  // The list's aggregate: two NFTs in one transaction are never one row.
  assert.deepEqual(shape(activityRows([ev('collect', '0xb', '7'), ev('increase', '0xb', '8')], auto)), [
    ['collect', '0xb', 'collect', false],
    ['auto', '0xb', 'increase', false],
  ]);
  assert.deepEqual(shape(activityRows([ev('decrease', '0xb'), ev('collect', '0xb')], auto)), [
    ['decrease', '0xb', 'decrease', true],
    ['collect', '0xb', 'collect', false],
  ]);
  assert.deepEqual(activityRows([], auto), []);
});
