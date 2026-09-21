import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as execution from '../../api-contracts/execution-v1/runtime.mjs';
import * as performance from '../../api-contracts/performance-v2/runtime.mjs';

const fixture = (path) => JSON.parse(readFileSync(new URL(`../../api-contracts/${path}`, import.meta.url)));
const executionFixture = fixture('execution-v1/fixtures/status-wire.json');
const cards = fixture('performance-v2/fixtures/responses/cards.json');

test('shared traversal retains independent execution and performance semantic checks', () => {
  const badStatus = structuredClone(executionFixture.responses['status.reserved']);
  badStatus.item.canCancel = false;
  const badCard = structuredClone(cards);
  badCard.cards[0].financial.observedSeconds -= 1;
  // Alternate instances: neither the latest import nor the previous call may
  // replace the semantic callback used for a nested $ref in the other contract.
  for (let i = 0; i < 2; i++) {
    assert.equal(execution.validateResponse('status', badStatus), false);
    assert.equal(performance.validateResponse('cards', badCard), false);
    assert.equal(execution.validateResponse('status', executionFixture.responses['status.reserved']), true);
    assert.equal(performance.validateResponse('cards', cards), true);
  }
});

for (const [name, runtime, route, valid] of [
  ['execution', execution, 'status', executionFixture.requests.status],
  ['performance', performance, 'cards', fixture('performance-v2/fixtures/requests/cards.json')],
]) {
  test(`${name} rejects non-JSON shapes without invoking property getters`, () => {
    const [key] = Object.keys(valid);
    let reads = 0;
    const accessor = structuredClone(valid);
    Object.defineProperty(accessor, key, { enumerable: true, get() { reads++; return valid[key]; } });
    const hidden = structuredClone(valid);
    Object.defineProperty(hidden, key, { enumerable: false });
    const symbol = { ...valid, [Symbol('extra')]: true };
    for (const value of [accessor, hidden, symbol, Object.assign(Object.create({}), valid)]) {
      assert.equal(runtime.validateRequest(route, value), false);
    }
    assert.equal(runtime.validateRequest(route, Object.assign(Object.create(null), valid)), true);
    assert.equal(runtime.validateRequest('__proto__', valid), false);
    assert.equal(reads, 0);
  });

  test(`${name} preserves exact error envelopes and status-code binding`, () => {
    for (const [error, status] of Object.entries(runtime.ERROR_STATUS_BY_CODE)) {
      assert.equal(runtime.validateError(status, { error }), true);
      assert.equal(runtime.validateError(status + 1, { error }), false);
      assert.equal(runtime.validateError(status, { error, extra: null }), false);
    }
    let reads = 0;
    assert.equal(runtime.validateError(400, { get error() { reads++; return 'invalid_request'; } }), false);
    assert.equal(reads, 0);
  });
}

test('shared traversal rejects sparse and accessor arrays in nested responses', () => {
  for (const [runtime, route, body, field] of [
    [execution, 'list', executionFixture.responses['list.empty'], 'items'],
    [performance, 'cards', cards, 'cards'],
  ]) {
    let reads = 0;
    const sparse = new Array(1);
    const accessor = [null];
    Object.defineProperty(accessor, '0', { get() { reads++; return null; } });
    for (const value of [sparse, accessor]) assert.equal(runtime.validateResponse(route, { ...body, [field]: value }), false);
    assert.equal(reads, 0);
  }
});
