/**
 * The second chain's service client (src/chains/elysium/api.ts, 2026-10-01, the chain2 workstream): rugged97's read and
 * actions services through this site's /uniswap-v3/ route, decoded with his own runtimes (vendored), against his own
 * fixtures.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as read from '../functions/_lib/uniswap-v3/contracts/uniswap-v3-read-v1/runtime.mjs';
import * as actions from '../functions/_lib/uniswap-v3/contracts/uniswap-v3-actions-v1/runtime.mjs';

const require = createRequire(import.meta.url);
const api = require('../.test-build/app/src/chains/elysium/api.js');

const json = (name) => JSON.parse(readFileSync(new URL(`./fixtures/elysium/${name}`, import.meta.url), 'utf8'));
const vendored = (path) => JSON.parse(readFileSync(new URL(`../functions/_lib/uniswap-v3/contracts/${path}`, import.meta.url), 'utf8'));
const READ_PIN = vendored('uniswap-v3-read-v1/pin.json');
const ACTIONS_PIN = vendored('uniswap-v3-actions-v1/pin.json');
const RUNTIMES = { read: { runtime: read, pin: READ_PIN }, actions: { runtime: actions, pin: ACTIONS_PIN } };
const READ_WIRE = json('uniswap-v3-read-v1.wire.json');
const ACTIONS_WIRE = json('uniswap-v3-actions-v1.wire.json');
const H = { read: 'X-Domino-Uniswap-V3-Read-Contract', actions: 'X-Domino-Uniswap-V3-Actions-Contract' };

/** His answer as his Worker sends it: the body, his contract headers. */
function answer(family, body, status = 200, extra = {}) {
  const pin = family === 'read' ? READ_PIN : ACTIONS_PIN;
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', [H[family]]: pin.contractVersion, [`${H[family]}-Digest`]: pin.manifestSha256, ...extra } });
}

/** A public deployment's answer: his local-fixture evidence, as an unqualified public service would label it. */
const publicCopy = (value) => ({ ...structuredClone(value), qualification: 'unqualified' });

function recorder(reply) {
  const asked = [];
  const send = async (path, init) => {
    asked.push({ path, init, body: JSON.parse(init.body) });
    return reply(path, init);
  };
  return { asked, send };
}

test('a read is sent as his client sends it: the route, POST, the pinned version and digest, same-origin, no redirect', async () => {
  const { asked, send } = recorder(() => answer('read', publicCopy(READ_WIRE.responses.pool)));
  const client = api.createV3Api(send, RUNTIMES);
  const pool = await client.read('pool', READ_WIRE.requests.pool, READ_WIRE.identity);
  assert.equal(pool.pool.address, READ_WIRE.responses.pool.pool.address);
  assert.equal(asked.length, 1);
  const [{ path, init, body }] = asked;
  assert.equal(path, '/uniswap-v3/read/v1/pool');
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'same-origin');
  assert.equal(init.redirect, 'error');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.headers[H.read], '1.0.0-rc.2');
  assert.equal(init.headers[`${H.read}-Digest`], READ_PIN.manifestSha256);
  assert.deepEqual(body, READ_WIRE.requests.pool);
});

test('every route of his fixtures decodes through the client, labelled as a public service would label it', async () => {
  for (const [family, wire] of [['read', READ_WIRE], ['actions', ACTIONS_WIRE]]) {
    for (const route of Object.keys(wire.requests)) {
      const response = wire.responses[route];
      const body = route === 'capabilities' ? (family === 'actions' ? { ...structuredClone(response), qualification: 'unqualified', localWalletActionsAvailable: false } : response) : publicCopy(response);
      const client = api.createV3Api(async () => answer(family, body), RUNTIMES);
      const identity = route === 'capabilities' ? undefined : wire.identity;
      const got = await client[family](route, wire.requests[route], identity);
      assert.deepEqual(got, body, `${family}/${route}`);
    }
  }
});

test('a request is checked before it leaves: no identity, another deployment, a malformed body, an unknown route', async () => {
  const { asked, send } = recorder(() => answer('read', publicCopy(READ_WIRE.responses.pool)));
  const client = api.createV3Api(send, RUNTIMES);
  await assert.rejects(client.read('pool', READ_WIRE.requests.pool, undefined), { kind: 'invalid', message: 'identity_required' });
  await assert.rejects(client.read('pool', READ_WIRE.requests.pool, { ...READ_WIRE.identity, deploymentId: `0x${'1'.repeat(64)}` }), { kind: 'invalid', message: 'invalid_request' });
  await assert.rejects(client.read('pool', { ...READ_WIRE.requests.pool, pool: 'nope' }, READ_WIRE.identity), { kind: 'invalid' });
  await assert.rejects(client.read('pools', {}, READ_WIRE.identity), { kind: 'invalid', message: 'contract_pin_mismatch' });
  assert.equal(asked.length, 0, 'nothing was sent');
});

test('an answer is checked before it is used: his contract headers, JSON, his runtime, the expected identity', async () => {
  const good = publicCopy(READ_WIRE.responses.pool);
  const cases = [
    [() => new Response(JSON.stringify(good), { status: 200, headers: { 'Content-Type': 'application/json' } }), 'contract_changed'],
    [() => answer('read', good, 200, { [`${H.read}-Digest`]: `${'0'.repeat(64)}` }), 'contract_changed'],
    [() => answer('read', good, 200, { 'Content-Type': 'text/html' }), 'invalid_answer'],
    [() => answer('read', { ...good, chainId: 4663 }), 'invalid_answer'],
    [() => answer('read', { ...good, deploymentId: `0x${'1'.repeat(64)}` }), 'invalid_answer'],
    [() => answer('read', READ_WIRE.responses.pool), 'local_fixture_only'],
    [() => answer('read', { ...good, qualification: 'testnet-rehearsal' }), 'private_rehearsal_only'],
  ];
  for (const [reply, message] of cases) {
    const client = api.createV3Api(async () => reply(), RUNTIMES);
    await assert.rejects(client.read('pool', READ_WIRE.requests.pool, READ_WIRE.identity), { kind: 'invalid', message });
  }
});

test('an answer past 256 KiB is not read to its end', async () => {
  const huge = new Response(new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(64 * 1024).fill(32));
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json', [H.read]: READ_PIN.contractVersion, [`${H.read}-Digest`]: READ_PIN.manifestSha256 } });
  const client = api.createV3Api(async () => huge, RUNTIMES);
  await assert.rejects(client.read('pool', READ_WIRE.requests.pool, READ_WIRE.identity), { kind: 'invalid', message: 'invalid_answer' });
});

test('this site\'s own refusals and his service\'s errors are told apart', async () => {
  const ours = (status, error) => async () => new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  await assert.rejects(api.createV3Api(ours(404, 'not_enabled'), RUNTIMES).read('capabilities', READ_WIRE.requests.capabilities), { kind: 'not-enabled', code: 'not_enabled' });
  await assert.rejects(api.createV3Api(ours(503, 'bridge_unavailable'), RUNTIMES).read('capabilities', READ_WIRE.requests.capabilities), { kind: 'unreachable' });
  // His envelope at its status, with his headers: a refusal with his code.
  await assert.rejects(api.createV3Api(async () => answer('actions', { error: 'deployment_unqualified' }, 409), RUNTIMES).actions('capabilities', ACTIONS_WIRE.requests.capabilities), (error) => error.kind === 'refused' || error.kind === 'invalid');
  const refused = await api.createV3Api(async () => answer('read', { error: 'service_disabled' }, read.ERROR_STATUS_BY_CODE.service_disabled), RUNTIMES).read('capabilities', READ_WIRE.requests.capabilities).catch((error) => error);
  assert.equal(refused.kind, 'refused');
  assert.equal(refused.code, 'service_disabled');
  // An envelope his contract does not know is not trusted as his.
  await assert.rejects(api.createV3Api(async () => answer('read', { error: 'made_up' }, 500), RUNTIMES).read('capabilities', READ_WIRE.requests.capabilities), { kind: 'invalid', message: 'invalid_error' });
  await assert.rejects(api.createV3Api(async () => { throw new TypeError('offline'); }, RUNTIMES).read('capabilities', READ_WIRE.requests.capabilities), { kind: 'unreachable' });
});

test('a request nobody wants any more ends as aborted, and a slow one at its own deadline', async () => {
  const controller = new AbortController();
  const hang = (path, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const pending = api.createV3Api(hang, RUNTIMES).read('capabilities', READ_WIRE.requests.capabilities, undefined, controller.signal);
  controller.abort();
  await assert.rejects(pending, { kind: 'aborted' });
  await assert.rejects(api.createV3Api(hang, RUNTIMES, 20).read('capabilities', READ_WIRE.requests.capabilities), { kind: 'unreachable', message: 'timeout' });
});

test('a pin that is not the runtime\'s version is refused before anything is sent', async () => {
  const { asked, send } = recorder(() => answer('read', READ_WIRE.responses.capabilities));
  const client = api.createV3Api(send, { ...RUNTIMES, read: { runtime: read, pin: { ...READ_PIN, contractVersion: '1.0.0-rc.1' } } });
  await assert.rejects(client.read('capabilities', READ_WIRE.requests.capabilities), { message: 'contract_pin_mismatch' });
  assert.equal(asked.length, 0);
});
