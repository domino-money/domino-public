/**
 * rugged97's Uniswap v3 API contracts, vendored by pinned hash (functions/_lib/uniswap-v3/contracts/, 2026-10-01, the
 * chain2 workstream, audit items G7 and G9).
 *
 * The vendored files are his, byte for byte: each one's SHA-256 is the one his own manifest records, each manifest's
 * SHA-256 is its pin.json's (the digest his client and Worker exchange in the contract headers), and the shared
 * closed-schema module is the very bytes main already carries at api-contracts/shared/. His committed wire fixtures pass
 * his runtimes, as vendored, with his identity; a well-shaped answer for another deployment, chain or route does not.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as read from '../functions/_lib/uniswap-v3/contracts/uniswap-v3-read-v1/runtime.mjs';
import * as actions from '../functions/_lib/uniswap-v3/contracts/uniswap-v3-actions-v1/runtime.mjs';

const VENDOR = new URL('../functions/_lib/uniswap-v3/contracts/', import.meta.url);
const FIXTURES = new URL('./fixtures/elysium/', import.meta.url);
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
const file = (path) => readFileSync(new URL(path, VENDOR));
const json = (url) => JSON.parse(readFileSync(url, 'utf8'));
const clone = (value) => structuredClone(value);

test('every vendored file is the one VENDOR.json names, at his commit', () => {
  const vendor = json(new URL('VENDOR.json', VENDOR));
  assert.equal(vendor.commit, '7d1906907381c55e65d9b83ad1f3efafe1cabb36');
  assert.ok(Object.keys(vendor.files).length >= 13);
  for (const [path, entry] of Object.entries(vendor.files)) {
    assert.equal(sha(file(path)), entry.sha256, path);
    assert.equal(entry.source, `api-contracts/${path}`);
  }
});

for (const family of ['uniswap-v3-read-v1', 'uniswap-v3-actions-v1']) {
  test(`${family}: the manifest is the pin's, and every vendored runtime file is the manifest's`, () => {
    const pin = JSON.parse(file(`${family}/pin.json`));
    const manifestBytes = file(`${family}/manifest.json`);
    const manifest = JSON.parse(manifestBytes);
    assert.equal(pin.contract, family);
    assert.equal(manifest.contract, family);
    assert.equal(pin.contractVersion, manifest.contractVersion);
    assert.equal(sha(manifestBytes), pin.manifestSha256, 'the digest the contract headers carry');
    const recorded = Object.fromEntries(manifest.files.map((entry) => [entry.path, entry.sha256]));
    for (const name of ['runtime.mjs', 'runtime.d.mts', 'schema-data.mjs', 'types.ts']) assert.equal(sha(file(`${family}/${name}`)), recorded[name], name);
    assert.equal(sha(file('shared/closed-schema.mjs')), recorded['../shared/closed-schema.mjs'], 'the shared validator his manifest records');
  });
}

test('the vendored closed-schema module is main\'s own api-contracts/shared/closed-schema.mjs, byte for byte', () => {
  assert.equal(sha(file('shared/closed-schema.mjs')), sha(readFileSync(new URL('../../api-contracts/shared/closed-schema.mjs', import.meta.url))));
});

test('the runtimes are his rc.2, and name his routes', () => {
  assert.equal(read.CONTRACT_VERSION, '1.0.0-rc.2');
  assert.equal(actions.CONTRACT_VERSION, '1.0.0-rc.2');
  assert.deepEqual([...read.ROUTES].sort(), ['capabilities', 'discover-pool', 'history', 'ledger', 'pool', 'position']);
  assert.deepEqual([...actions.ROUTES].sort(), ['capabilities', 'inspect', 'prepare', 'receipt']);
});

for (const [name, runtime, fixture] of [
  ['read', read, 'uniswap-v3-read-v1.wire.json'],
  ['actions', actions, 'uniswap-v3-actions-v1.wire.json'],
]) {
  test(`his ${name} wire fixtures pass his runtime, as vendored, with his identity`, () => {
    const wire = json(new URL(fixture, FIXTURES));
    const identity = wire.identity;
    for (const [route, request] of Object.entries(wire.requests)) {
      assert.ok(runtime.validateRequest(route, request, route === 'capabilities' ? undefined : identity), `${route} request`);
    }
    for (const [route, response] of Object.entries(wire.responses)) {
      const expected = route === 'capabilities' && response.deployment === null ? undefined : identity;
      assert.ok(runtime.validateResponse(route, response, expected), `${route} response`);
    }
  });

  test(`his ${name} runtime refuses a well-shaped answer for another deployment, chain or shape`, () => {
    const wire = json(new URL(fixture, FIXTURES));
    const identity = wire.identity;
    const route = name === 'read' ? 'pool' : 'inspect';
    const good = wire.responses[route];
    assert.ok(runtime.validateResponse(route, good, identity));
    const other = { ...identity, deploymentId: `0x${'1'.repeat(64)}` };
    assert.equal(runtime.validateResponse(route, good, other), false, 'another deployment');
    assert.equal(runtime.validateResponse(route, { ...clone(good), chainId: 4663 }, identity), false, 'another chain');
    assert.equal(runtime.validateResponse(route, { ...clone(good), extra: true }, identity), false, 'a closed schema: no extra field');
    assert.equal(runtime.validateResponse(route, good, undefined), false, 'no identity, no answer');
    assert.equal(runtime.validateResponse('capabilities', good), false, 'another route');
  });
}

test('his draft verification: the fixture\'s prepared draft verifies; any change to it does not', async () => {
  const wire = json(new URL('uniswap-v3-actions-v1.wire.json', FIXTURES));
  const draft = wire.responses.prepare.draft;
  assert.equal(await actions.verifyDraft(draft), true);
  for (const change of [
    (d) => (d.transaction.nonce += 1),
    (d) => (d.transaction.to = '0x0000000000000000000000000000000000000001'),
    (d) => (d.action.paused = true),
    (d) => (d.expiresAt += 60),
    (d) => (d.contractPins[0].codeHash = `0x${'0'.repeat(64)}`),
  ]) {
    const tampered = clone(draft);
    change(tampered);
    assert.equal(await actions.verifyDraft(tampered), false);
  }
});

test('his error envelopes are closed too: a known code at its status passes, anything else does not', () => {
  assert.equal(read.validateError(503, { error: 'service_disabled' }) || read.validateError(404, { error: 'service_disabled' }), true);
  assert.equal(read.validateError(500, { error: 'not_a_code' }), false);
  assert.equal(actions.validateError(409, { error: 'contract_mismatch' }), true);
  assert.equal(actions.validateError(409, { error: 'contract_mismatch', detail: 'x' }), false);
});
