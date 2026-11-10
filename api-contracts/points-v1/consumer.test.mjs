// Producer fixtures pass; answers that would show points that do not add up, a wallet as its own referrer, or a field
// the contract does not have, fail; the runtime builds the signed text byte for byte as the listener checks it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as runtime from './runtime.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const clone = (value) => JSON.parse(JSON.stringify(value));

test('the producer fixtures pass', () => {
  for (const route of runtime.ROUTES) {
    assert.equal(runtime.validateRequest(route, read(`./fixtures/requests/${route}.json`)), true, route);
    assert.equal(runtime.validateResponse(route, read(`./fixtures/responses/${route}.json`)), true, route);
  }
  for (const { status, body } of read('./fixtures/errors.json')) assert.equal(runtime.validateError(status, body), true);
  assert.deepEqual([...runtime.ROUTES].sort(), ['link', 'points']);
});

test('the signed text is the listener\'s', () => {
  const pinned = read('./fixtures/signed-text.json');
  assert.equal(runtime.referralText(pinned.season, pinned.referee, pinned.referrer, pinned.issuedAt), pinned.text);
  assert.equal(runtime.referralText(pinned.season, pinned.referee.toUpperCase().replace('0X', '0x'), pinned.referrer,
    pinned.issuedAt), pinned.text);
  assert.throws(() => runtime.referralText('points-s9', pinned.referee, pinned.referrer, pinned.issuedAt));
  assert.throws(() => runtime.referralText(pinned.season, '0x12', pinned.referrer, pinned.issuedAt));
  assert.throws(() => runtime.referralText(pinned.season, pinned.referee, pinned.referrer, -1));
});

test('answers that do not hold are refused', () => {
  const points = read('./fixtures/responses/points.json');
  const wallet = (change) => ({ ...points, wallet: { ...points.wallet, ...change } });
  assert.equal(runtime.validateResponse('points', wallet({ points: '1716.000000' })), false);
  assert.equal(runtime.validateResponse('points', wallet({ referrer: points.wallet.address })), false);
  assert.equal(runtime.validateResponse('points', wallet({ points: '1715.0' })), false);
  assert.equal(runtime.validateResponse('points', { ...clone(points), extra: 1 }), false);
  assert.equal(runtime.validateResponse('points', { ...clone(points), snapshot: null }), true);
  const link = read('./fixtures/responses/link.json');
  assert.equal(runtime.validateResponse('link', { ...link, referrer: link.referee }), false);
  assert.equal(runtime.validateResponse('link', { ...link, status: 'replaced' }), false);
  const request = read('./fixtures/requests/link.json');
  assert.equal(runtime.validateRequest('link', { ...request, referee: request.referrer }), false);
  assert.equal(runtime.validateRequest('link', { referrer: request.referrer, issuedAt: request.issuedAt }), false);
  assert.equal(runtime.validateRequest('points', { wallet: request.referrer }), false);
  assert.equal(runtime.validateError(422, { error: 'not_a_code' }), false);
});
