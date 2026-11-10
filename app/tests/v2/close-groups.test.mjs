import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { closeGroups, canCloseTogether } = require('../../.test-build/app/src/v2in/lists/closeGroups.js');
const { v2Chain } = require('../../.test-build/app/src/v2/chains.js');
function row(chainId, dex, id, over = {}) {
  const positionManager = v2Chain(chainId).uniswap[dex === 3 ? 'v3' : 'v4'].positionManager;
  return { chainId, dex, positionManager, tokenId: String(id), key: `${chainId}:${positionManager}:${id}`, status: 'live', tab: 'open', hooked: false, vault: null, ...over };
}
test('bulk groups keep same numeric NFT on different networks/managers, deduplicate exact identity, and bound each atomic group', () => {
  const a = row(4663, 4, 1), b = row(8453, 4, 1), c = row(8453, 3, 1);
  const rows = [a, b, c, a, ...Array.from({ length: 9 }, (_, i) => row(4663, 4, i + 2))];
  const groups = closeGroups(rows);
  assert.deepEqual(groups.map((group) => group.length), [2, 2, 2, 2, 2, 1, 1]);
  for (const group of groups) assert.equal(new Set(group.map((one) => `${one.chainId}:${one.positionManager}`)).size, 1);
  assert.equal(groups.flat().length, 12);
});
test('bulk selection never treats unknown state, a closed position, a hook, a successor or an unrecognized manager as eligible', () => {
  assert.equal(canCloseTogether(row(4663, 4, 1)), true);
  for (const over of [{ status: 'not_read' }, { status: 'unavailable' }, { tab: 'closed' }, { tab: 'pending' }, { hooked: true }, { vault: { role: 'successor' } }, { positionManager: '0x' + '1'.repeat(40) }]) {
    assert.equal(canCloseTogether(row(4663, 4, 1, over)), false);
  }
});
// Added 2026-11-09 (the core-flows fix; the owner: closing positions with automation must be totally easy): the review's
// one plain line, in place of the tick box "I understand that closing these positions stops their automation.".
test('bulk close says in one line which automation closing turns off, by its list name', () => {
  const { bulkTurnsOffCopy } = require('../../.test-build/app/src/v2in/lists/closeGroups.js');
  const auto = { role: 'root', name: 'Auto-compound', word: null, running: true };
  assert.equal(bulkTurnsOffCopy([row(8453, 4, 1, { vault: auto }), row(8453, 4, 2)]), 'Closing also turns off Auto-compound for these positions.');
  assert.equal(bulkTurnsOffCopy([row(8453, 4, 1, { vault: auto }), row(8453, 4, 2, { vault: { ...auto, name: 'Auto-exit' } })]), 'Closing also turns off Auto-compound and Auto-exit for these positions.');
  assert.equal(bulkTurnsOffCopy([row(8453, 4, 1, { vault: { ...auto, name: null } })]), 'Closing also turns off their automation for this position.');
});
