/**
 * Domino V2's two routes over the page's same-origin HTTP (the base agent's item 5, 2026-10-02):
 *
 *   - read-v6 (src/v2/read/v6HttpTransport.ts): the route's path, a JSON body, `X-Domino-Read-Contract: 1.0.0-rc.1`,
 *     the read Worker's bounds; a reply without the contract's header (the gate, the SPA's page, a route not deployed) is
 *     never read as the contract's: a dash (`unavailable`), never data; the route's own non-JSON answer is `invalid`; the
 *     package's own fixtures pass through readPortfolio and readActivity as `ok`;
 *   - position-plan-v1 with the session (src/v2/plan/httpTransport.ts createSessionPlanTransport): the signed-in session's
 *     CSRF lent for the one request and sent as `X-Domino-CSRF` with the contract's header; no session, no CSRF access,
 *     or a session that changed before the request: refused unsent (`session_required`).
 *   - src/finance/v2/http.ts binds them to the page (financialFetch, lib/http's bounded reading, the V1 session): its
 *     source is held to that, and to no wallet method and no fetch of its own.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as runtime from '../../../api-contracts/read-v6/runtime.mjs';

const require = createRequire(import.meta.url);
const APP = resolve(import.meta.dirname, '../..');
const BUILD = resolve(APP, '.test-build/app/src');
const { createHttpReadV6Transport, READ_V6_PATHS, READ_V6_MAX_RESPONSE_BYTES, READ_V6_TIMEOUT_MS } = require(`${BUILD}/v2/read/v6HttpTransport.js`);
const { readPortfolio, readActivity } = require(`${BUILD}/v2/read/v6.js`);
const { createSessionPlanTransport, S1_PLAN_MAX_RESPONSE_BYTES } = require(`${BUILD}/v2/plan/httpTransport.js`);

const fixture = (path) => JSON.parse(readFileSync(resolve(APP, '../api-contracts/read-v6/fixtures', path), 'utf8'));
const PORTFOLIO = fixture('valid/portfolio.json');
const ACTIVITY = fixture('valid/activity.json');

/** A RawPost that records each request and answers with `reply(url)`. */
function recordingPost(reply) {
  const sent = [];
  const post = async (url, init, options) => {
    sent.push({ url, init, options });
    return reply(url, init);
  };
  return { sent, post };
}
const answer = (status, body, { header = '1.0.0-rc.1', contentType = 'application/json' } = {}) => ({
  kind: 'reply',
  reply: { status, opaqueRedirect: false, contentType, contractHeader: header, requestIdHeader: null, retryAfterHeader: null, body: { kind: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) } },
});

test('read-v6 over HTTP: each route\'s path, the JSON body, the contract\'s header and the read Worker\'s bounds; the package\'s fixtures read as ok', async () => {
  const { sent, post } = recordingPost((url) => answer(200, url.endsWith('/portfolio') ? PORTFOLIO : ACTIVITY));
  const transport = createHttpReadV6Transport({ post });
  assert.equal(transport.kind, 'http');
  const portfolio = await readPortfolio(transport, runtime, PORTFOLIO.wallet);
  assert.equal(portfolio.kind, 'ok');
  const activity = await readActivity(transport, runtime, ACTIVITY.wallet, { limit: 20 });
  assert.equal(activity.kind, 'ok');
  assert.deepEqual(sent.map((request) => request.url), [READ_V6_PATHS.portfolio, READ_V6_PATHS.activity]);
  assert.deepEqual(READ_V6_PATHS, { portfolio: '/api/read/v6/portfolio', activity: '/api/read/v6/activity',
    'chain-pools': '/api/read/v6/chain-pools', 'chain-balances': '/api/read/v6/chain-balances',
    'chain-tokens': '/api/read/v6/chain-tokens' });
  for (const request of sent) {
    assert.deepEqual(request.init.headers, { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Domino-Read-Contract': '1.0.0-rc.1' });
    assert.deepEqual(request.options, { contractHeader: 'X-Domino-Read-Contract', maxBytes: READ_V6_MAX_RESPONSE_BYTES, timeoutMs: READ_V6_TIMEOUT_MS });
  }
  assert.deepEqual(JSON.parse(sent[0].init.body), { wallet: PORTFOLIO.wallet.toLowerCase() });
  assert.deepEqual(JSON.parse(sent[1].init.body), { wallet: ACTIVITY.wallet.toLowerCase(), limit: 20 });
  assert.equal(READ_V6_MAX_RESPONSE_BYTES, 1024 * 1024, 'the read Worker\'s own answer bound');
});

test('read-v6 over HTTP: a reply that is not the route\'s is a dash, never data; the route\'s own broken answer is invalid', async () => {
  const cases = [
    ['the beta gate', answer(401, { error: 'beta_access_required' }, { header: null })],
    ['the SPA\'s page', answer(200, '<!doctype html>', { header: null, contentType: 'text/html' })],
    ['the forwarder\'s not_found', answer(404, { error: 'not_found' }, { header: null })],
    ['another contract version', answer(200, PORTFOLIO, { header: '1.0.0-rc.0' })],
    ['a redirect', { kind: 'reply', reply: { ...answer(200, PORTFOLIO).reply, opaqueRedirect: true } }],
    ['the network', { kind: 'network' }],
    ['the page\'s deadline', { kind: 'timeout' }],
  ];
  for (const [label, reply] of cases) {
    const transport = createHttpReadV6Transport({ post: async () => reply });
    const result = await readPortfolio(transport, runtime, PORTFOLIO.wallet);
    assert.deepEqual(result, { kind: 'unavailable', reason: 'network' }, label);
  }
  for (const [label, reply] of [['not JSON', answer(200, 'oops', { contentType: 'text/plain' })], ['malformed JSON', answer(200, '{"wallet":')]]) {
    const result = await readPortfolio(createHttpReadV6Transport({ post: async () => reply }), runtime, PORTFOLIO.wallet);
    assert.equal(result.kind, 'invalid', label);
  }
  // The route's own error answer is said by its code, through the package's validator (a dash, with that reason).
  const down = await readPortfolio(createHttpReadV6Transport({ post: async () => answer(503, { error: 'upstream_unavailable' }) }), runtime, PORTFOLIO.wallet);
  assert.deepEqual(down, { kind: 'unavailable', reason: 'upstream_unavailable' });
  const off = await readPortfolio(createHttpReadV6Transport({ post: async () => answer(404, { error: 'route_not_available' }) }), runtime, PORTFOLIO.wallet);
  assert.deepEqual(off, { kind: 'unavailable', reason: 'route_not_available' }, 'the Worker switched off');
  const tooLarge = createHttpReadV6Transport({ post: async () => assert.fail('never sent') });
  await assert.rejects(tooLarge.post('portfolio', { wallet: 'x'.repeat(9000) }), /request_too_large/);
});

/** A V1 session as the plan transport takes it: signed in at `epoch` (or not), lending `csrf`. */
function session({ epoch = 7, csrfAccess = true, csrf = 'csrf-token-1', gone = false } = {}) {
  const lent = [];
  return {
    lent,
    csrfAccess,
    epoch: () => epoch,
    async withCsrf(asked, fn) {
      lent.push(asked);
      if (gone || asked !== epoch) return { ok: false };
      return { ok: true, value: await fn(csrf) };
    },
  };
}

test('the plan with the session: its CSRF lent for the one request, sent with the contract\'s header; no session, no CSRF access or a changed session: refused unsent', async () => {
  const request = { action: 'create', chainId: 8453 };
  const { sent, post } = recordingPost(() => answer(200, { contractVersion: '1.0.0-rc.2', plan: {} }, { header: '1.0.0-rc.2' }));
  const signedIn = session();
  const transport = createSessionPlanTransport({ post, session: signedIn });
  assert.equal(transport.kind, 'http');
  const reply = await transport.plan(request);
  assert.equal(reply.status, 200);
  assert.deepEqual(signedIn.lent, [7], 'lent for the signed-in session\'s epoch');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, '/api/position-plan/v1/plan');
  assert.deepEqual(sent[0].init.headers, { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Domino-Position-Plan-Contract': '1.0.0-rc.2', 'X-Domino-CSRF': 'csrf-token-1' });
  assert.deepEqual(JSON.parse(sent[0].init.body), request);
  assert.equal(sent[0].options.maxBytes, S1_PLAN_MAX_RESPONSE_BYTES);

  for (const [label, s] of [['no signed-in session', session({ epoch: null })], ['no CSRF access', session({ csrfAccess: false })], ['the session changed before the request', session({ gone: true })]]) {
    const { sent: none, post: never } = recordingPost(() => assert.fail('never sent'));
    await assert.rejects(createSessionPlanTransport({ post: never, session: s }).plan(request), /session_required/, label);
    assert.deepEqual(none, [], `${label}: nothing sent`);
  }
});

test('src/finance/v2/http.ts binds the routes to the page: the financial fetch, lib/http\'s bounded reading, the V1 session\'s CSRF; no wallet method, no fetch of its own', () => {
  const source = readFileSync(join(APP, 'src/finance/v2/http.ts'), 'utf8').replace(/\r\n/g, '\n');
  const imports = [...source.matchAll(/^import[^;]*?from '([^']+)'/gm)].map((match) => match[1]);
  // Changed on purpose (data) 2026-10-02 (S2 wired): and crosschain-v1's HTTP transport, the client's session and clock
  // shapes, and the page's one session port for a route's denial of the session.
  assert.deepEqual(imports.sort(), ['../../lib/clock', '../../lib/http/rawReply', '../../session/controller', '../../session/livePort', '../../v2/crosschain/httpTransport', '../../v2/crosschain/transport', '../../v2/crosschain/types', '../../v2/plan/httpTransport', '../../v2/plan/types', '../../v2/read/v6', '../../v2/read/v6HttpTransport', '../../v2/routes', '../../wallet/session', '../http'].sort());
  assert.match(source, /fetchRaw\(financialFetch, url, init, \{ \.\.\.options, clock: realClock \}\)/, 'every POST through the financial fetch, read within its bound');
  assert.match(source, /financialFetch\(path, \{ \.\.\.REQUEST_INIT, method: 'GET', headers: options\.headers, signal: controller\.signal \}\)/, 'the capabilities GET likewise, same-origin, no redirect followed');
  assert.doesNotMatch(source, /\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|\.request\(|eth_|wallet_/, 'no fetch of its own, no storage, no wallet');
  assert.match(source, /return answer === NO_SESSION \? \{ ok: false \} : \{ ok: true, value: answer \}/, 'the CSRF only while the session asked is the signed-in one');
  // Changed on purpose 2026-10-05 (the owner: "it keeps asking me to sign in"): or the same session held on Base or
  // Arbitrum One (session/machine.ts heldAway, its own account only; tests/v2/multichain-base.test.mjs).
  assert.match(source, /if \(identity\.kind !== 'connected'\) return null\n    if \(away\) return epoch\n    if \(view\.status !== 'signed_in'\) return null\n    return identity\.address\.toLowerCase\(\) === view\.owner\.toLowerCase\(\) \? epoch : null/, 'signed in, for the connected account, or held away for it');
});

// Changed on purpose (data) 2026-10-02 (S2 wired): crosschain-v1 with the session, bound in the same module. Its transport
// is the HTTP one over the page's POST (headers and bounds held by tests/v2/crosschain-client.test.mjs); its session lends
// the CSRF exactly as the plan's does and reports a denial under the epoch it lent for, as the onboarding and deposit
// clients do (port.reportDenial(code, epoch)). The module reaches the wallet session, so it is read as source here.
test('crosschain-v1 with the session: the HTTP transport over the page\'s POST; the CSRF lent as the plan\'s is; a denial reported to the live port under the epoch lent for', () => {
  const source = readFileSync(join(APP, 'src/finance/v2/http.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(source, /export function liveCrosschainTransport\(\): CrosschainTransport \{\n  return createHttpCrosschainTransport\(\{ post: v2Post \}\)\n\}/);
  const session = source.slice(source.indexOf('export function liveCrosschainSession()'), source.indexOf('\n}\n', source.indexOf('export function liveCrosschainSession()')) + 3);
  assert.ok(session.length > 0, 'the session adapter is there');
  assert.match(session, /const epoch = LIVE_SESSION\.epoch\(\)\n      if \(epoch === null\) return \{ lent: false \}/, 'no signed-in session for the connected account: nothing sent');
  assert.match(session, /lentEpoch = epoch\n      const answer = await LIVE_SESSION\.withCsrf\(epoch, send\)\n      return answer\.ok \? \{ lent: true, value: answer\.value \} : \{ lent: false \}/, 'the CSRF lent for this one request, through the plan\'s own lending');
  assert.match(session, /reportDenial\(code\) \{\n      if \(lentEpoch !== null\) livePort\.reportDenial\(code, lentEpoch\)\n    \}/, 'a denial under the epoch lent for, to the page\'s one port');
  assert.doesNotMatch(session, /csrf\b.*=|store|localStorage/, 'the CSRF is never kept');
  assert.match(source, /export const liveClock: CrosschainClock = realClock/, 'the page clock the offer\'s page module takes (src/v2in may not import lib/clock)');
});
