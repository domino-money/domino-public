/**
 * The Points page's points-v1 transport (added 2026-11-07, the owner's Points page, Season 1; rugged97's PR #467,
 * api-contracts/points-v1 1.0.0-rc.1), driven with the contract's own fixtures and runtime: the capabilities GET read as
 * live, off or unavailable; the two POSTs with their headers and bodies; every answer held to the runtime before it is
 * used; a reply without the contract header read as no points route; and every refusal in the page's words (PROPOSAL.md
 * §3 h).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as runtime from '../../api-contracts/points-v1/runtime.mjs';

const require = createRequire(import.meta.url);
const APP = resolve(import.meta.dirname, '..');
const CONTRACT = resolve(APP, '../api-contracts/points-v1');
const transport = require('../.test-build/app/src/points/transport.js');
const { POINTS_WORDS, problemOf } = require('../.test-build/app/src/points/words.js');
const fixture = (name) => JSON.parse(readFileSync(join(CONTRACT, 'fixtures', name), 'utf8'));

const VERSION = '1.0.0-rc.1';
const CSRF = 'csrf-token-for-the-test';

/** A reply as lib/http/rawReply.ts reads one. */
const reply = (status, body, { contract = true, type = 'application/json; charset=utf-8', retryAfter = null } = {}) => ({
  kind: 'reply',
  reply: { status, opaqueRedirect: false, contentType: type, contractHeader: contract ? VERSION : null, requestIdHeader: null, retryAfterHeader: retryAfter, body: { kind: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) } },
});

/** A fake POST: records what it was asked, answers `answer`. */
function poster(answer) {
  const asked = [];
  const post = async (url, init, options) => {
    asked.push({ url, init, options });
    return typeof answer === 'function' ? answer(url, init) : answer;
  };
  return { post, asked };
}
function getter(answer) {
  const asked = [];
  const get = async (url, options) => {
    asked.push({ url, options });
    return answer;
  };
  return { get, asked };
}

test('the package is the one this transport speaks', () => {
  assert.equal(runtime.CONTRACT_VERSION, transport.POINTS_CONTRACT_VERSION);
  assert.deepEqual([...runtime.ROUTES].sort(), ['link', 'points']);
  assert.equal(transport.POINTS_HEADER, 'X-Domino-Points-Contract');
  assert.equal(transport.CSRF_HEADER, 'X-Domino-CSRF');
  assert.deepEqual({ ...transport.POINTS_PATHS }, { capabilities: '/api/points/v1/capabilities', points: '/api/points/v1/points', link: '/api/points/v1/link' });
  // The Worker's own limits (bridge/src/points-worker.mjs POINTS_LIMITS).
  const worker = readFileSync(resolve(APP, '../bridge/src/points-worker.mjs'), 'utf8');
  assert.match(worker, /requestBytes: 1024, responseBytes: 8192/);
  assert.equal(transport.POINTS_MAX_REQUEST_BYTES, 1024);
  assert.equal(transport.POINTS_MAX_RESPONSE_BYTES, 8192);
});

test('capabilities: live only from the Worker’s exact answer with both routes; disabled or no Worker is off; anything else unavailable', async () => {
  const live = { contractVersion: VERSION, dataMode: 'live', enabledRoutes: ['points', 'link'] };
  const disabled = { contractVersion: VERSION, dataMode: 'disabled', enabledRoutes: [] };
  const cases = [
    [reply(200, live), 'live'],
    [reply(200, { ...live, enabledRoutes: ['link', 'points'] }), 'live'],
    [reply(200, disabled), 'off'],
    [reply(200, { ...live, enabledRoutes: ['points'] }), 'off'],
    // The forwarder while no Worker is bound: its own 404, no contract header. The gate, the site's own page: the same.
    [reply(404, { error: 'not_found' }, { contract: false }), 'off'],
    [reply(401, { error: 'beta_access_required' }, { contract: false }), 'off'],
    [reply(200, '<!doctype html>', { contract: false, type: 'text/html' }), 'off'],
    // A broken binding (the forwarder's 503), the network, the deadline: it cannot be told now.
    [reply(503, { error: 'bridge_unavailable' }, { contract: false }), 'unavailable'],
    [{ kind: 'network' }, 'unavailable'],
    [{ kind: 'timeout' }, 'unavailable'],
    [{ kind: 'aborted' }, 'aborted'],
    // The Worker's own refusals.
    [reply(404, { error: 'route_not_available' }), 'off'],
    [reply(503, { error: 'upstream_unavailable' }), 'unavailable'],
    // Not the Worker's shape: never read as on.
    [reply(200, { ...live, extra: true }), 'unavailable'],
    [reply(200, { ...live, contractVersion: '1.0.0' }), 'unavailable'],
    [reply(200, { ...live, enabledRoutes: ['points', 'points', 'link'] }), 'unavailable'],
    [reply(200, { ...live, enabledRoutes: ['points', 'link', 'admin'] }), 'unavailable'],
    [reply(200, { ...disabled, enabledRoutes: ['points'] }), 'unavailable'],
    [reply(200, { ...live, dataMode: 'live_read_only' }), 'unavailable'],
    [reply(200, 'not json'), 'unavailable'],
    [reply(200, live, { type: 'text/plain' }), 'unavailable'],
  ];
  for (const [answer, expected] of cases) {
    const { get, asked } = getter(answer);
    assert.equal(await transport.askCapabilities(get), expected, JSON.stringify(answer));
    assert.equal(asked.length, 1);
    assert.equal(asked[0].url, '/api/points/v1/capabilities');
    assert.deepEqual(asked[0].options.headers, { Accept: 'application/json', 'X-Domino-Points-Contract': VERSION });
    assert.equal(asked[0].options.contractHeader, 'X-Domino-Points-Contract');
  }
});

test('points: POST {} with the session’s CSRF and the contract header; the contract’s own answer comes back as it is', async () => {
  const answer = fixture('responses/points.json');
  assert.equal(runtime.validateResponse('points', answer), true);
  const { post, asked } = poster(reply(200, answer));
  const end = await transport.askPoints(post, CSRF, runtime);
  assert.deepEqual(end, { kind: 'ok', value: answer });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].url, '/api/points/v1/points');
  assert.equal(asked[0].init.body, JSON.stringify(fixture('requests/points.json')));
  assert.deepEqual(asked[0].init.headers, { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Domino-Points-Contract': VERSION, 'X-Domino-CSRF': CSRF });
  assert.deepEqual([asked[0].options.contractHeader, asked[0].options.maxBytes, asked[0].options.timeoutMs], ['X-Domino-Points-Contract', 8192, 22_000]);
  // Before the first count: snapshot null, still the contract's.
  const first = { ...answer, snapshot: null };
  assert.deepEqual(await transport.askPoints(poster(reply(200, first)).post, CSRF, runtime), { kind: 'ok', value: first });
});

test('points: an answer outside the contract is never used', async () => {
  const answer = fixture('responses/points.json');
  for (const broken of [
    { ...answer, wallet: { ...answer.wallet, points: '1716.000000' } }, // points ≠ usage + referral
    { ...answer, wallet: { ...answer.wallet, referrer: answer.wallet.address } }, // its own referrer
    { ...answer, contractVersion: '1.0.0' },
    { ...answer, extra: 1 },
    { ...answer, wallet: { ...answer.wallet, points: 1715 } },
  ]) {
    assert.deepEqual(await transport.askPoints(poster(reply(200, broken)).post, CSRF, runtime), { kind: 'refused', code: 'contract', status: 200 });
  }
  assert.deepEqual(await transport.askPoints(poster(reply(200, 'oops')).post, CSRF, runtime), { kind: 'refused', code: 'contract', status: 200 });
});

test('points: no contract header is no points route (off); the forwarder’s 503 and the network can be asked again', async () => {
  assert.deepEqual(await transport.askPoints(poster(reply(404, { error: 'not_found' }, { contract: false })).post, CSRF, runtime), { kind: 'refused', code: 'off', status: 404 });
  assert.deepEqual(await transport.askPoints(poster(reply(200, fixture('responses/points.json'), { contract: false })).post, CSRF, runtime), { kind: 'refused', code: 'off', status: 200 }, 'a body without the header is never read');
  assert.deepEqual(await transport.askPoints(poster(reply(503, { error: 'bridge_unavailable' }, { contract: false })).post, CSRF, runtime), { kind: 'refused', code: 'upstream_unavailable', status: 503 });
  assert.deepEqual(await transport.askPoints(poster({ kind: 'network' }).post, CSRF, runtime), { kind: 'refused', code: 'network', status: 0 });
  assert.deepEqual(await transport.askPoints(poster({ kind: 'timeout' }).post, CSRF, runtime), { kind: 'refused', code: 'timeout', status: 0 });
  assert.deepEqual(await transport.askPoints(poster({ kind: 'aborted' }).post, CSRF, runtime), { kind: 'aborted' });
});

test('every refusal of the contract’s examples comes back by its code, and the page says it in its own words', async () => {
  const words = {
    invalid_request: { kind: 'retry', text: POINTS_WORDS.unavailable },
    session_required: { kind: 'session', text: 'Your sign-in ended. Sign in again to see your points.' },
    csrf_invalid: { kind: 'session', text: 'Your sign-in ended. Sign in again to see your points.' },
    points_unavailable: { kind: 'retry', text: 'Points can’t be loaded right now. Try again in a minute.' },
    referral_self: { kind: 'line', text: 'You can’t refer yourself.' },
    referral_wallet_excluded: { kind: 'line', text: 'This wallet can’t take part in referrals.' },
    referral_season_closed: { kind: 'line', text: 'Season 1 has ended, so referrals are closed.' },
    referral_message_not_fresh: { kind: 'line', text: 'The signature expired. Sign again to link.' },
    referral_signature_invalid: { kind: 'line', text: 'The signature doesn’t match the connected wallet. Sign again with the same wallet.' },
    referral_signature_mismatch: { kind: 'line', text: 'The signature doesn’t match the connected wallet. Sign again with the same wallet.' },
  };
  const examples = fixture('errors.json');
  assert.deepEqual(examples.map((example) => example.body.error).sort(), Object.keys(words).sort());
  for (const { status, body } of examples) {
    assert.equal(runtime.validateError(status, body), true);
    for (const ask of [(post) => transport.askPoints(post, CSRF, runtime), (post) => transport.askLink(post, CSRF, runtime, fixture('requests/link.json'))]) {
      const end = await ask(poster(reply(status, body, { retryAfter: status === 503 ? '30' : null })).post);
      assert.deepEqual(end, { kind: 'refused', code: body.error, status, ...(status === 503 ? { retryAfterSeconds: 30 } : {}) }, body.error);
    }
    assert.deepEqual(problemOf(body.error), words[body.error], body.error);
  }
  // A refusal the contract does not list for its status is outside it.
  assert.deepEqual(await transport.askPoints(poster(reply(418, { error: 'referral_self' })).post, CSRF, runtime), { kind: 'refused', code: 'contract', status: 418 });
  // The transport's own endings, and the session's others, in the same words.
  for (const code of ['network', 'timeout', 'contract', 'off', 'upstream_unavailable', 'points_capacity_busy', 'session_capacity_busy', 'wallet']) assert.deepEqual(problemOf(code), { kind: 'retry', text: POINTS_WORDS.unavailable }, code);
  assert.deepEqual(problemOf('account_unsupported').kind, 'session');
});

test('link: the signed request as the contract’s example, sent once; the answer checked; a bad request never sent', async () => {
  const request = fixture('requests/link.json');
  const answer = fixture('responses/link.json');
  assert.equal(runtime.validateRequest('link', request), true);
  const { post, asked } = poster(reply(200, answer));
  assert.deepEqual(await transport.askLink(post, CSRF, runtime, request), { kind: 'ok', value: answer });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].url, '/api/points/v1/link');
  assert.deepEqual(JSON.parse(asked[0].init.body), request);
  assert.equal(asked[0].init.headers['X-Domino-CSRF'], CSRF);
  assert.equal(asked[0].init.headers['X-Domino-Points-Contract'], VERSION);
  const existing = { ...answer, status: 'existing', referrer: '0x91b7e2c04d5a6f38b2c1e9d07a4f6b3c2d1e0f9a' };
  assert.deepEqual(await transport.askLink(poster(reply(200, existing)).post, CSRF, runtime, request), { kind: 'ok', value: existing });
  assert.deepEqual(await transport.askLink(poster(reply(200, { ...answer, referee: answer.referrer })).post, CSRF, runtime, request), { kind: 'refused', code: 'contract', status: 200 }, 'a wallet never its own referrer');
  for (const bad of [{ ...request, referrer: '0x123' }, { ...request, issuedAt: -1 }, { ...request, signature: '0x12' }, { ...request, extra: 1 }]) {
    const sent = poster(reply(200, answer));
    assert.deepEqual(await transport.askLink(sent.post, CSRF, runtime, bad), { kind: 'refused', code: 'invalid_request', status: 0 }, JSON.stringify(bad));
    assert.equal(sent.asked.length, 0, 'nothing sent');
  }
});

test('the page binds the transport to the session and the wallet in one reviewed module', () => {
  const binding = readFileSync(join(APP, 'src/finance/points.ts'), 'utf8');
  assert.match(binding, /from 'api-contracts\/points-v1\/runtime\.mjs'/);
  assert.match(binding, /fetchRaw\(financialFetch, url, init, \{ \.\.\.options, clock: realClock \}\)/, 'every POST through the financial fetch, read within its bound');
  assert.match(binding, /financialFetch\(url, \{ \.\.\.REQUEST_INIT, method: 'GET'/, 'the capabilities GET likewise');
  assert.match(binding, /sessionController\.withSessionCsrf\(epoch, send\)/, 'the CSRF lent per request');
  assert.match(binding, /livePort\.reportDenial\(answer\.code as DenialCode, epoch\)/, 'a refusal of the session reported to the page’s port');
  // The transport itself is pure: no fetch, no storage, no wallet.
  const pure = readFileSync(join(APP, 'src/points/transport.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(pure, /\bfetch\(|localStorage|sessionStorage|window\.|import /);
});
