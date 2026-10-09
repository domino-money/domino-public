/**
 * The page's client of Domino's own chain routes (src/lib/edge/chainRoutes.ts, RPC-SPEC Phase 0,
 * appendix C.4): each route's fixed same-origin POST, and what each kind of answer becomes. The network call is handed
 * in (RouteOptions.fetch), so nothing here reaches a server; the last cases ask the routes as tests/support/edge-routes.mjs
 * answers them, over a fake chain.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { browserChain, RPC_URL } from './support/browser-chain.mjs';
import { edgeFetch } from './support/edge-routes.mjs';

const require = createRequire(import.meta.url);
const routes = require('../.test-build/app/src/lib/edge/chainRoutes.js');
const { parseWalletAnswer } = require('../.test-build/app/src/lib/walletPositions.js');
const { parseAutomationAnswer } = require('../.test-build/app/src/lib/automationState.js');
const { isStateResponse } = require('../.test-build/app/src/lib/fees/answers.js');

const OWNER = '0xf6184f814543b88dd867c34ce6e9f56ab7d18c0a';
const POOL = `0x${'ab'.repeat(32)}`;
const json = (body, status = 200, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

/** A fake network call: what each call was, and `reply` (a Response, or a function of the call) as its answer. */
function recorder(reply = () => json({ v: 1 })) {
  const calls = [];
  const fetch = async (input, init) => {
    calls.push({ input, init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return typeof reply === 'function' ? reply(input, init) : reply;
  };
  return { calls, fetch };
}

test('each route posts JSON to its own fixed path, with this site’s cookies, never cached and never redirected, and the body exactly as its contract', async () => {
  const cases = [
    [(o) => routes.postOwnedPositions(OWNER, false, o), '/api/owned/v2/positions', { owner: OWNER }],
    [(o) => routes.postOwnedPositions(OWNER, true, o), '/api/owned/v2/positions', { owner: OWNER, fresh: true }],
    [(o) => routes.postState(['7', '3'], false, o), '/api/fees/v1/state', { tokenIds: ['7', '3'] }],
    [(o) => routes.postState(['7'], true, o), '/api/fees/v1/state', { tokenIds: ['7'], automation: true }],
    // 2026-10-01 (the switch's integration): right after the owner's action, fresh.
    [(o) => routes.postState(['7'], true, o, true), '/api/fees/v1/state', { tokenIds: ['7'], automation: true, fresh: true }],
    [(o) => routes.postState(['7'], false, o, true), '/api/fees/v1/state', { tokenIds: ['7'], fresh: true }],
    // 2026-10-02 (RPC-SPEC §11.4): a position's ledger, in place of the fees replay's log units; fresh after a settlement.
    [(o) => routes.postLedger(['7', '3'], false, o), '/api/fees/v2/ledger', { tokenIds: ['7', '3'] }],
    [(o) => routes.postLedger(['7'], true, o), '/api/fees/v2/ledger', { tokenIds: ['7'], fresh: true }],
    [(o) => routes.postLedger(['7'], true, o, [{ tokenId: '7', block: 82863189, tx: `0x${'ab'.repeat(32)}` }]), '/api/fees/v2/ledger', { tokenIds: ['7'], fresh: true, mintHints: [{ tokenId: '7', block: 82863189, tx: `0x${'ab'.repeat(32)}` }] }],
    [(o) => routes.postAutomation(['1', '2'], o), '/api/automation/v1/state', { tokenIds: ['1', '2'] }],
    [(o) => routes.postVaultRecord({ vault: `0x${'5a'.repeat(20)}`, tokenId: '7', currencies: [`0x${'01'.repeat(20)}`, `0x${'02'.repeat(20)}`], from: 1, to: 2 }, o), '/api/automation/v1/record', { vault: `0x${'5a'.repeat(20)}`, tokenId: '7', currencies: [`0x${'01'.repeat(20)}`, `0x${'02'.repeat(20)}`], from: 1, to: 2 }],
    [(o) => routes.postSimulate({ owner: OWNER, calls: [{ to: `0x${'01'.repeat(20)}`, data: '0x', value: '0x0', extra: 1 }] }, o), '/api/chain/v1/simulate', { owner: OWNER, calls: [{ to: `0x${'01'.repeat(20)}`, data: '0x', value: '0x0' }] }],
    [(o) => routes.postRoute('confirmation', { hash: `0x${'ab'.repeat(32)}` }, o), '/api/chain/v1/confirmation', { hash: `0x${'ab'.repeat(32)}` }],
    [(o) => routes.postRoute('confirmation', { finality: true }, o), '/api/chain/v1/confirmation', { finality: true }],
  ];
  for (const [ask, path, body] of cases) {
    const { calls, fetch } = recorder(() => json({ v: 1, result: [] }));
    await ask({ fetch });
    assert.equal(calls.length, 1, path);
    const [{ input, init, body: sent }] = calls;
    assert.equal(input, path);
    assert.equal(init.method, 'POST');
    assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(sent, body, path);
    assert.equal(JSON.stringify(sent), JSON.stringify(body), `${path}: the keys in their contract order`);
  }
  assert.deepEqual(Object.values(routes.ROUTES), ['/api/owned/v2/positions', '/api/fees/v1/state', '/api/fees/v2/ledger', '/api/automation/v1/state', '/api/automation/v1/record', '/api/chain/v1/simulate', '/api/chain/v1/confirmation']);
  assert.equal(routes.postLogs, undefined, 'the logs route is gone');
});

test('a 200 JSON answer is handed on with its size; one that is not JSON, or larger than its route allows, is unavailable', async () => {
  const value = { v: 1, block: 9, positions: [] };
  const ok = await routes.postState(['1'], false, { fetch: async () => json(value) });
  assert.deepEqual(ok, { ok: true, value, bytes: JSON.stringify(value).length });
  for (const reply of [new Response('{"v":1}', { headers: { 'Content-Type': 'text/html' } }), json('{"v":'), json('x'.repeat(routes.REPLY_BYTES.state + 1))]) {
    assert.deepEqual(await routes.postState(['1'], false, { fetch: async () => reply }), { ok: false, failure: 'unavailable', retryAfterMs: 0 });
  }
  const big = { v: 1, pad: 'x'.repeat(routes.REPLY_BYTES.automation) };
  assert.equal((await routes.postAutomation(['1'], { fetch: async () => json(big) })).ok, false, 'past the route’s own limit');
  assert.equal((await routes.postLedger(['1'], false, { fetch: async () => json(big) })).ok, true, 'within the ledger route’s larger one');
});

test('a rate refusal names its wait (bounded), five seconds when it names none; a busy chain is one too', async () => {
  const ask = (reply) => routes.postAutomation(['1'], { fetch: async () => reply });
  assert.deepEqual(await ask(json({ error: 'rate_limited' }, 429, { 'Retry-After': '7' })), { ok: false, failure: 'rate_limited', retryAfterMs: 7_000 });
  assert.deepEqual(await ask(json({ error: 'rate_limited' }, 429)), { ok: false, failure: 'rate_limited', retryAfterMs: routes.RATE_RETRY_MS });
  assert.equal(routes.RATE_RETRY_MS, 5_000);
  assert.deepEqual(await ask(json({ error: 'chain_busy' }, 502, { 'Retry-After': '12' })), { ok: false, failure: 'rate_limited', retryAfterMs: 12_000 });
  assert.deepEqual(await ask(json({ error: 'chain_unavailable' }, 502, { 'Retry-After': '12' })), { ok: false, failure: 'unavailable', retryAfterMs: 12_000 });
});

test('the source away is unavailable with its wait, bounded to five minutes', async () => {
  const ask = (headers) => routes.postOwnedPositions(OWNER, false, { fetch: async () => json({ error: 'source_unavailable' }, 503, headers) });
  assert.deepEqual(await ask({ 'Retry-After': '300' }), { ok: false, failure: 'unavailable', retryAfterMs: 300_000 });
  assert.deepEqual(await ask({ 'Retry-After': '9999' }), { ok: false, failure: 'unavailable', retryAfterMs: routes.MAX_RETRY_MS });
  assert.equal(routes.MAX_RETRY_MS, 300_000);
  assert.deepEqual(await ask({}), { ok: false, failure: 'unavailable', retryAfterMs: 0 });
});

test('413 is too large; 400, 403, 405 and 415 are a bad request; 404, 401, 500 and 502 are unavailable', async () => {
  const ask = (status, body = { v: 1, error: 'x' }) => routes.postLedger(['1'], false, { fetch: async () => json(body, status) });
  assert.equal((await ask(413)).failure, 'too_large');
  for (const status of [400, 403, 405, 415]) assert.equal((await ask(status)).failure, 'bad_request', String(status));
  for (const status of [404, 401, 500]) assert.equal((await ask(status)).failure, 'unavailable', String(status));
  assert.deepEqual(await ask(502, { v: 1, error: 'rpc_unavailable' }), { ok: false, failure: 'unavailable', retryAfterMs: 0 });
});

test('a call that could not be made, or was dropped, is unavailable', async () => {
  assert.deepEqual(await routes.postState(['1'], false, { fetch: async () => Promise.reject(new TypeError('Failed to fetch')) }), { ok: false, failure: 'unavailable', retryAfterMs: 0 });
  const controller = new AbortController();
  controller.abort();
  const aborting = async (_input, init) => {
    init.signal?.throwIfAborted();
    return json({ v: 1 });
  };
  assert.deepEqual(await routes.postState(['1'], false, { fetch: aborting, signal: controller.signal }), { ok: false, failure: 'unavailable', retryAfterMs: 0 });
  assert.equal((await routes.postSimulate({ owner: OWNER, calls: [] }, { fetch: aborting, signal: controller.signal })).reason, 'unavailable');
});

test('a simulation: its result, or why there is none', async () => {
  const ask = (reply) => routes.postSimulate({ owner: OWNER, calls: [{ to: OWNER, data: '0x', value: '0x0' }] }, { fetch: async () => reply });
  const result = [{ calls: [{ status: '0x1', gasUsed: '0x5208' }] }];
  assert.deepEqual(await ask(json({ v: 1, result })), { ok: true, result });
  assert.deepEqual(await ask(json({ v: 1, error: 'not_enabled' }, 404)), { ok: false, reason: 'not_enabled' });
  assert.deepEqual(await ask(json({ v: 1, error: 'simulate_unsupported' }, 501)), { ok: false, reason: 'unsupported' });
  assert.deepEqual(await ask(json({ v: 1, error: 'simulation_failed' }, 422)), { ok: false, reason: 'failed' });
  assert.deepEqual(await ask(json({ v: 1, error: 'rate_limited' }, 429)), { ok: false, reason: 'rate_limited' });
  assert.deepEqual(await ask(json({ v: 1, error: 'bad_request' }, 400)), { ok: false, reason: 'bad_request' });
  for (const status of [503, 500, 502, 401]) assert.deepEqual(await ask(json({ v: 1, error: 'source_unavailable' }, status)), { ok: false, reason: 'unavailable' }, String(status));
  assert.deepEqual(await ask(json({ result })), { ok: false, reason: 'unavailable' }, 'a 200 without v:1');
  assert.deepEqual(await ask(json('{"v":')), { ok: false, reason: 'unavailable' });
});

test('through the routes over a fake chain: the list’s envelope, a position’s feature and state, each as its parser takes it; with the source off, every route is a 503', async () => {
  const VAULT = `0x${'5a'.repeat(20)}`;
  const KEY = { currency0: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', currency1: '0xefab538cf3c29237a47c6afb145d50ddf204a0a3', fee: 3000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000' };
  const chain = browserChain({
    operations: true,
    positions: [
      { tokenId: 11, holder: OWNER, key: KEY, tickLower: -600, tickUpper: 600, liquidity: 10n ** 12n, unclaimed: [5n, 7n], subscriber: VAULT },
      { tokenId: 12, holder: OWNER, key: KEY, tickLower: -600, tickUpper: 600, liquidity: 10n ** 12n, unclaimed: [0n, 0n] },
    ],
    tokens: { [KEY.currency0]: { symbol: 'USDG', decimals: 6 }, [KEY.currency1]: { symbol: 'UFG', decimals: 18 } },
    vaults: { [VAULT]: { root: 11, feeBps: 200, paused: false } },
  });
  const deps = { fetch: (_url, init) => chain.fetch(RPC_URL, init), sleep: async () => {}, now: () => Date.now() };
  const fetch = edgeFetch(deps);

  const owned = await routes.postOwnedPositions(OWNER, false, { fetch });
  assert.equal(owned.ok, true, JSON.stringify(owned));
  assert.deepEqual(Object.keys(owned.value).sort(), ['answer', 'automation', 'capped', 'mints', 'v']);
  assert.equal(owned.value.v, 1);
  const answer = parseWalletAnswer(owned.value.answer, OWNER);
  assert.ok(answer, 'the answer is what the list’s parser takes');
  assert.deepEqual(answer.positions.map((p) => p.tokenId), ['12', '11']);
  assert.ok(parseAutomationAnswer(owned.value.automation, answer.positions.map((p) => p.tokenId)), 'and so is its automation');

  const automation = await routes.postAutomation(['11', '12'], { fetch });
  assert.equal(automation.ok, true);
  assert.deepEqual(parseAutomationAnswer(automation.value, ['11', '12'])?.positions, [{ tokenId: '11', automation: 'compound', paused: false, active: true, vault: VAULT }, { tokenId: '12', automation: 'plain' }]);

  const state = await routes.postState(['11'], true, { fetch });
  assert.equal(state.ok, true);
  assert.ok(isStateResponse(state.value), 'a StateResponse');
  assert.equal(state.value.positions[0].tokenId, '11');

  // A deployment without the node's secret: every route but the simulation's (off by its own flag) is a 503 that names
  // five minutes, which the client reads as unavailable for that long.
  const off = edgeFetch(deps, { source: () => 'off' });
  const record = { vault: VAULT, tokenId: '11', currencies: [KEY.currency0, KEY.currency1], from: 1, to: 2 };
  const bodies = [
    [routes.ROUTES.owned, { owner: OWNER }],
    [routes.ROUTES.state, { tokenIds: ['11'] }],
    [routes.ROUTES.ledger, { tokenIds: ['11'] }],
    [routes.ROUTES.automation, { tokenIds: ['11'] }],
    [routes.ROUTES.record, record],
  ];
  for (const [path, body] of bodies) {
    const response = await off(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 503, path);
    assert.equal(response.headers.get('Retry-After'), '300', path);
    assert.equal((await response.json()).error, 'source_unavailable', path);
  }
  for (const ask of [
    () => routes.postOwnedPositions(OWNER, false, { fetch: off }),
    () => routes.postAutomation(['11'], { fetch: off }),
    () => routes.postState(['11'], true, { fetch: off }),
    () => routes.postLedger(['11'], false, { fetch: off }),
    () => routes.postVaultRecord(record, { fetch: off }),
  ]) {
    assert.deepEqual(await ask(), { ok: false, failure: 'unavailable', retryAfterMs: 300_000 });
  }
  assert.deepEqual(await routes.postSimulate({ owner: OWNER, calls: [{ to: VAULT, data: '0x', value: '0x0' }] }, { fetch: off }), { ok: false, reason: 'not_enabled' }, 'the simulation is off by its own flag');
});
