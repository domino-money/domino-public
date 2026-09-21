import assert from 'node:assert/strict';
import test from 'node:test';
import { observedBlocks, differsFromCanonical } from './canonicality.mjs';
const a = '0x' + 'aa'.repeat(32), b = '0x' + 'bb'.repeat(32);

test('a replacement block cannot hide a previously sampled orphan', () => {
  const [block] = observedBlocks([{ blockNumber: 7, blockHash: a }, { blockNumber: 7, blockHash: b }]);
  assert(differsFromCanonical(block, { number: '0x7', hash: b }));
});
test('repeated canonical observations and reported read failures remain distinguishable', () => {
  const blocks = observedBlocks([{ blockNumber: 7, blockHash: a }, { error: 'timeout' }, { blockNumber: 7, blockHash: a }]);
  assert.equal(blocks.length, 1);
  assert.equal(differsFromCanonical(blocks[0], { number: '0x7', hash: a }), false);
});
test('missing or mismatched canonical headers cannot count as success', () => {
  const [block] = observedBlocks([{ blockNumber: 7, blockHash: a }]);
  assert.throws(() => differsFromCanonical(block, null));
  assert.throws(() => differsFromCanonical(block, { number: '0x8', hash: a }));
  assert.throws(() => observedBlocks([{ blockNumber: 7 }]));
});
