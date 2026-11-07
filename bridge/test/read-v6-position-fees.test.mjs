// read-v6 1.2.0-rc.1 in the read Worker (6 Nov 2026; launch round P3, docs/v2/V2_FEES.md "What the app and the read
// Worker need"): the Worker speaks 1.2.0-rc.1 beside 1.1.0-rc.1 and routes position-fees (Fees earned and Your APR on
// Base and Arbitrum One), 1.2.0-rc.1's one new route. What this pins:
//   (a) a capabilities GET in 1.1.0-rc.1 (or naming none) answers as before, and never names position-fees;
//   (b) one in 1.2.0-rc.1 answers 1.2.0-rc.1 (it was a 502 upstream_contract_mismatch, which Cloudflare shows as its
//       own HTML page), naming position-fees only when ENABLED_V6_READS does;
//   (c) position-fees is there only in 1.2.0-rc.1 and only when ENABLED_V6_READS names it, else the 404
//       route_not_available it always was; on, it goes upstream as the other routes do and its answer is the package's;
//   (d) 1.1.0-rc.1's five routes stay as they were in 1.1.0-rc.1, and are also taken in 1.2.0-rc.1, each request sent
//       upstream and answered in the version it was asked in;
//   (e) with production's ENABLED_V6_READS nothing a 1.1.0-rc.1 page can see changes.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { CONSTANTS as V6_CONSTANTS } from '../../api-contracts/read-v6/schema-data.mjs';
import { createWorker, LIMITS } from '../src/worker.mjs';
import {
  CONTRACT_VERSION, CONTRACT_VERSIONS, NEXT_VERSION, NEXT_ROUTES, ROUTES, ERROR_STATUS_BY_CODE, validateRequest,
} from '../../api-contracts/read-v6/runtime.mjs';

const origin = 'https://app.example.invalid';
const gateway = 'https://gateway.example.invalid';
const fixtures = new URL('../../api-contracts/read-v6/fixtures/', import.meta.url);
const text = (path) => readFileSync(new URL(path, fixtures), 'utf8');
const list = (dir) => readdirSync(new URL(`${dir}/`, fixtures)).filter((name) => name.endsWith('.json')).sort()
  .map((name) => [name, text(`${dir}/${name}`)]);

const V11 = '1.1.0-rc.1';
const V12 = '1.2.0-rc.1';
// Production's list on 6 Nov 2026 (the five 1.1.0-rc.1 reads), and the same with position-fees once rugged names it.
const PRODUCTION_READS = 'portfolio,activity,chain-pools,chain-balances,chain-tokens';
const WITH_FEES = `${PRODUCTION_READS},position-fees`;
const env = {
  APP_ORIGIN: origin, GATEWAY_ORIGIN: gateway, READ_V6_BRIDGE_ENABLED: 'true', ENABLED_V6_READS: PRODUCTION_READS,
  ACCESS_CLIENT_ID: 'synthetic-service-id', ACCESS_CLIENT_SECRET: 'synthetic-service-secret',
};
const on = { ...env, ENABLED_V6_READS: WITH_FEES };

const FEES_REQUEST = text('1.2.0-rc.1/requests/position-fees.json');
const FEES = text('1.2.0-rc.1/valid/position-fees.json');
const FEES_VALID = list('1.2.0-rc.1/valid').filter(([name]) => name.startsWith('position-fees'));
const FEES_INVALID = list('1.2.0-rc.1/invalid').filter(([name]) => name.startsWith('position-fees'));
const PORTFOLIO = text('valid/portfolio.json');
const PORTFOLIO_12 = text('1.2.0-rc.1/valid/portfolio.json');
const WALLET = JSON.parse(text('requests/portfolio.json')).wallet;
// The request each stored answer answers: its chain and its positions, in its order.
const feesRequestFor = (body) => {
  const answer = JSON.parse(body);
  return JSON.stringify({ chainId: answer.chainId, positions: answer.positions.map(({ dex, tokenId }) => ({ dex, tokenId })) });
};

/** The [vars] of the reviewed bridge/wrangler.read.toml, as committed. */
function committedVars() {
  const toml = readFileSync(new URL('../wrangler.read.toml', import.meta.url), 'utf8');
  const section = toml.slice(toml.indexOf('[vars]\n') + '[vars]\n'.length).split(/\n\[/)[0];
  return Object.fromEntries(section.split('\n').filter((line) => /^[A-Z0-9_]+ = "/.test(line))
    .map((line) => { const [, name, value] = line.match(/^([A-Z0-9_]+) = "(.*)"$/); return [name, value]; }));
}

function request(route, options = {}) {
  const { method = 'POST', version, headers = {}, body = FEES_REQUEST, url = `${origin}/api/read/v6/${route}`, signal } = options;
  return new Request(url, {
    method, signal,
    headers: {
      Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin',
      ...(version === undefined ? {} : { 'X-Domino-Read-Contract': version }), ...headers,
    },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body, duplex: 'half' }),
  });
}
const fees = (options = {}) => request('position-fees', { version: V12, ...options });
const capabilities = (version, headers = {}) => request('capabilities', { method: 'GET', version, headers });

function upstream({ body = FEES, status = 200, version = V12, headers = {} } = {}) {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': version, ...headers } });
}

function harness(responder = () => upstream()) {
  const calls = [];
  return { calls, worker: createWorker({
    getClientIp: () => '203.0.113.7',
    fetch: async (url, init) => { calls.push({ url, init }); return responder(url, init); },
  }) };
}

async function expectError(response, status, error, version) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { error });
  assert.equal(response.headers.get('X-Domino-Read-Contract'), version);
  assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
}

// Changed on purpose 2026-11-07 (Elysium, day 9; review finding B): read-v6's own chains, as the Worker names them.
const capabilitiesBody = (contractVersion, enabledReads) => ({
  contractVersion, dataMode: enabledReads.length ? 'live_read_only' : 'disabled', chainIds: [...V6_CONSTANTS.chainIds], enabledReads,
  walletAuthentication: false, privateAccounts: false, ownerTransactions: false, automation: false,
});

test('the package\'s window is the one this Worker was written for: 1.1.0-rc.1 its own, 1.2.0-rc.1 next with position-fees', () => {
  // When rugged closes the window (1.2.0-rc.1 becomes the package's version), this fails: the Worker is then revisited.
  assert.equal(CONTRACT_VERSION, V11);
  assert.equal(NEXT_VERSION, V12);
  assert.deepEqual(CONTRACT_VERSIONS, [V11, V12]);
  assert.deepEqual(NEXT_ROUTES, ['position-fees']);
  assert.deepEqual([...ROUTES].sort(), ['activity', 'chain-balances', 'chain-pools', 'chain-tokens', 'portfolio']);
  assert.equal(FEES_VALID.length, 6);
  assert.equal(FEES_INVALID.length, 46);
});

test('(a) capabilities asked in 1.1.0-rc.1, or naming none, never name position-fees, whatever ENABLED_V6_READS says', async () => {
  for (const [reads, listed] of [
    [PRODUCTION_READS, PRODUCTION_READS.split(',')],
    [WITH_FEES, PRODUCTION_READS.split(',')],
    ['position-fees,portfolio,activity', ['portfolio', 'activity']],
    ['activity,position-fees', ['activity']],
    // Only position-fees on: nothing of 1.1.0-rc.1 is, so a 1.1.0-rc.1 page reads the route as off.
    ['position-fees', []],
  ]) {
    for (const version of [V11, undefined]) {
      const h = harness();
      const response = await h.worker.fetch(capabilities(version), { ...env, ENABLED_V6_READS: reads });
      assert.equal(response.status, 200, reads);
      assert.equal(response.headers.get('X-Domino-Read-Contract'), V11, reads);
      assert.deepEqual(await response.json(), capabilitiesBody(V11, listed), `${reads} ${version}`);
      assert.equal(h.calls.length, 0);
    }
  }
});

test('(b) capabilities asked in 1.2.0-rc.1 answer 1.2.0-rc.1, naming position-fees only when ENABLED_V6_READS does', async () => {
  for (const [settings, listed] of [
    [env, PRODUCTION_READS.split(',')],
    [on, WITH_FEES.split(',')],
    [{ ...env, ENABLED_V6_READS: 'position-fees,portfolio' }, ['position-fees', 'portfolio']],
    [{ ...env, ENABLED_V6_READS: 'position-fees' }, ['position-fees']],
    [{ ...env, READ_V6_BRIDGE_ENABLED: 'false', ENABLED_V6_READS: WITH_FEES }, []],
    // The committed config (only the origin is the test's): off, said in 1.2.0-rc.1 rather than refused.
    [{ ...committedVars(), APP_ORIGIN: origin }, []],
  ]) {
    const h = harness();
    const response = await h.worker.fetch(capabilities(V12), settings);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8');
    assert.equal(response.headers.get('X-Domino-Read-Contract'), V12);
    assert.deepEqual(await response.json(), capabilitiesBody(V12, listed));
    assert.equal(h.calls.length, 0);
  }
  // As in 1.1.0-rc.1, a capabilities GET may omit Origin but never name another.
  const noOrigin = capabilities(V12); noOrigin.headers.delete('Origin');
  assert.equal((await harness().worker.fetch(noOrigin, on)).status, 200);
  await expectError(await harness().worker.fetch(capabilities(V12, { Origin: 'https://evil.invalid' }), on), 403, 'origin_not_allowed', V11);
  // A version read-v6 never had is still refused, before anything is read.
  for (const version of ['1.2.0-rc.2', '1.2.0', '1.0.0-rc.1', `${V12}, ${V12}`, `${V11}, ${V12}`, '1.2.0-RC.1']) {
    await expectError(await harness().worker.fetch(capabilities(version), on), 502, 'upstream_contract_mismatch', V11);
  }
});

test('(c) position-fees is not there unless ENABLED_V6_READS names it: the 404 it always was, for any version, method or origin', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => { lines.push(JSON.parse(line)); });
  const settingsList = [env, { ...env, ENABLED_V6_READS: 'portfolio' }, { ...on, READ_V6_BRIDGE_ENABLED: 'false' }, { ...committedVars(), APP_ORIGIN: origin }];
  for (const settings of settingsList) {
    for (const version of [undefined, V11, V12, '9.9.9']) {
      for (const method of ['POST', 'GET', 'PUT']) {
        for (const headers of [{}, { Origin: 'https://evil.invalid' }]) {
          const h = harness();
          await expectError(await h.worker.fetch(fees({ version, method, headers }), settings), 404, 'route_not_available', V11);
          assert.equal(h.calls.length, 0);
        }
      }
    }
  }
  assert.equal(lines.length, settingsList.length * 4 * 3 * 2);
  // Refused before the route is read, as a path no route owns: the record names none.
  assert.ok(lines.every((line) => line.route === 'unmatched' && line.contractVersion === V11 && line.status === 404));
});

test('(c) named, position-fees is still not there in 1.1.0-rc.1 or a version read-v6 never had: only in 1.2.0-rc.1', async () => {
  for (const version of [V11, '1.0.0-rc.1', '1.2.0-rc.2', '9.9.9', `${V12}, ${V12}`]) {
    for (const method of ['POST', 'GET']) {
      const h = harness();
      await expectError(await h.worker.fetch(fees({ version, method }), on), 404, 'route_not_available', V11);
      assert.equal(h.calls.length, 0, `${version} ${method}`);
    }
  }
});

test('(c) named and asked in 1.2.0-rc.1, it goes to its one upstream path as the other routes do, and each answer is relayed byte for byte', async () => {
  for (const [name, body] of FEES_VALID) {
    const sent = name === 'position-fees.json' ? FEES_REQUEST : feesRequestFor(body);
    const h = harness(() => upstream({ body }));
    const response = await h.worker.fetch(fees({ body: sent }), on);
    assert.equal(response.status, 200, name);
    assert.equal(await response.text(), body, name);
    assert.equal(response.headers.get('X-Domino-Read-Contract'), V12, name);
    assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.match(response.headers.get('X-Domino-Request-Id'), /^[0-9a-f-]{36}$/);
    assert.equal(h.calls.length, 1);
    const [{ url, init }] = h.calls;
    assert.equal(url, `${gateway}/internal/read/v6/position-fees`);
    assert.equal(init.method, 'POST');
    assert.equal(init.body, sent, 'the request bytes are forwarded as they came');
    assert.equal(init.redirect, 'manual');
    assert.deepEqual(init.headers, {
      'Content-Type': 'application/json', 'X-Domino-Read-Contract': V12,
      'CF-Access-Client-Id': env.ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.ACCESS_CLIENT_SECRET,
      'X-Domino-Client-Id': '203.0.113.7',
    });
  }
  // A request naming no version is read in its route's first, 1.2.0-rc.1, as the reader and the gateway read it.
  const h = harness();
  const response = await h.worker.fetch(fees({ version: undefined }), on);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Domino-Read-Contract'), V12);
  assert.equal(h.calls[0].init.headers['X-Domino-Read-Contract'], V12);
  // Only position-fees on works too.
  const alone = harness();
  assert.equal((await alone.worker.fetch(fees(), { ...env, ENABLED_V6_READS: 'position-fees' })).status, 200);
  await expectError(await alone.worker.fetch(request('portfolio', { version: V11, body: JSON.stringify({ wallet: WALLET }) }), { ...env, ENABLED_V6_READS: 'position-fees' }), 404, 'route_not_available', V11);
  assert.equal(alone.calls.length, 1);
});

test('(c) the hop record names position-fees and the version it was read and answered in', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => { lines.push(JSON.parse(line)); });
  await harness().worker.fetch(fees(), on);
  await harness(() => upstream({ body: '{"error":"route_not_available"}', status: 404, version: V11 })).worker.fetch(fees(), on);
  await harness().worker.fetch(capabilities(V12), on);
  assert.deepEqual(lines.map(({ route, contractVersion, method, status, reason }) => ({ route, contractVersion, method, status, reason })), [
    { route: 'position-fees', contractVersion: V12, method: 'POST', status: 200, reason: undefined },
    { route: 'position-fees', contractVersion: V12, method: 'POST', status: 404, reason: 'route_not_available' },
    { route: 'capabilities', contractVersion: V12, method: 'GET', status: 200, reason: undefined },
  ]);
});

test('(c) every invalid stored answer, and every answer about other positions or another chain, is refused, never relayed', async () => {
  let ownRequests = 0;
  for (const [name, body] of FEES_INVALID) {
    // Asked exactly what it answers (its chain, its positions in its order) whenever that is a request at all, so the
    // answer's own defect refuses it, not a mismatch with the question.
    let own = null;
    try { own = feesRequestFor(body); } catch { /* No chain or positions to ask about. */ }
    const asked = own !== null && validateRequest('position-fees', JSON.parse(own)) ? own : FEES_REQUEST;
    if (asked === own) ownRequests += 1;
    const h = harness(() => upstream({ body }));
    await expectError(await h.worker.fetch(fees({ body: asked }), on), 502, 'upstream_contract_mismatch', V12);
    assert.equal(h.calls.length, 1, name);
  }
  // Only the answer that lists a position twice cannot be asked for.
  assert.equal(ownRequests, FEES_INVALID.length - 1);
  const asked = JSON.parse(FEES_REQUEST);
  for (const other of [
    { ...asked, chainId: 42161 },
    { ...asked, positions: [...asked.positions].reverse() },
    { ...asked, positions: asked.positions.slice(0, 1) },
    { ...asked, positions: [...asked.positions, { dex: 4, tokenId: '42' }] },
  ]) {
    const h = harness();
    await expectError(await h.worker.fetch(fees({ body: JSON.stringify(other) }), on), 502, 'upstream_contract_mismatch', V12);
    assert.equal(h.calls.length, 1);
  }
  // An answer must speak the version asked: one labelled 1.1.0-rc.1, or of another protocol, is refused.
  for (const version of [V11, '1.0.0-rc.2', null]) {
    const h = harness(() => upstream({ version }));
    await expectError(await h.worker.fetch(fees(), on), 502, 'upstream_contract_mismatch', V12);
  }
});

test('(c) a position-fees request is the package\'s exactly: anything else is refused before upstream I/O', async () => {
  const position = (tokenId, dex = 4) => ({ dex, tokenId });
  for (const body of [
    JSON.stringify({ chainId: 8453, positions: [] }),
    JSON.stringify({ chainId: 8453, positions: Array.from({ length: 9 }, (_, i) => position(String(i + 1))) }),
    JSON.stringify({ chainId: 8453, positions: [position('41'), position('41')] }),
    JSON.stringify({ chainId: 8453, positions: [position('41', 2)] }),
    JSON.stringify({ chainId: 8453, positions: [position(41)] }),
    JSON.stringify({ chainId: 8453, positions: [position('041')] }),
    JSON.stringify({ chainId: 8453, positions: [position('0')] }),
    JSON.stringify({ chainId: 8453, positions: [{ ...position('41'), owner: WALLET }] }),
    JSON.stringify({ chainId: 1, positions: [position('41')] }),
    JSON.stringify({ chainId: '8453', positions: [position('41')] }),
    JSON.stringify({ chainId: 8453 }),
    JSON.stringify({ chainId: 8453, positions: [position('41')], wallet: WALLET }),
    '{"chainId":8453.0,"positions":[{"dex":4,"tokenId":"41"}]}',
    '{"chainId":8453,"positions":[{"dex":4e0,"tokenId":"41"}]}',
    '{"chainId":8453,"chainId":8453,"positions":[{"dex":4,"tokenId":"41"}]}',
    '[]', 'null', '', '{',
  ]) {
    const h = harness();
    await expectError(await h.worker.fetch(fees({ body }), on), 422, 'invalid_request', V12);
    assert.equal(h.calls.length, 0, body);
  }
  // The same transport limits as every route: JSON only, at most LIMITS.requestBytes.
  await expectError(await harness().worker.fetch(fees({ headers: { 'Content-Type': 'text/plain' } }), on), 415, 'json_required', V12);
  await expectError(await harness().worker.fetch(fees({ body: ' '.repeat(LIMITS.requestBytes + 1) }), on), 413, 'request_too_large', V12);
  await expectError(await harness().worker.fetch(fees({ headers: { Origin: 'https://evil.invalid' } }), on), 403, 'origin_not_allowed', V11);
  await expectError(await harness().worker.fetch(fees({ method: 'GET' }), on), 405, 'method_not_allowed', V11);
});

test('(c) the gateway\'s refusals pass in the version asked, its limits and failures as for every route', async () => {
  for (const [responder, status, error] of [
    // The gateway refuses a route it does not serve before reading the version, in its first: relayed as asked.
    [() => upstream({ body: '{"error":"route_not_available"}', status: 404, version: V11 }), 404, 'route_not_available'],
    [() => upstream({ body: '{"error":"route_not_available"}', status: 404 }), 404, 'route_not_available'],
    [() => upstream({ body: '{"error":"invalid_request"}', status: 422, version: V11 }), 422, 'invalid_request'],
    [() => upstream({ body: '{"error":"catalogue_database_unavailable"}', status: 503 }), 503, 'catalogue_database_unavailable'],
    [() => upstream({ body: '{"error":"read_deadline_exceeded"}', status: 504 }), 504, 'read_deadline_exceeded'],
    [() => upstream({ body: '{"error":"not_a_code"}', status: 503 }), 503, 'upstream_unavailable'],
    [() => upstream({ body: '{"error":"route_not_available"}', status: 404, version: '1.0.0-rc.1' }), 502, 'upstream_contract_mismatch'],
    [() => upstream({ headers: { 'Content-Type': 'text/html' }, body: '<html>login</html>' }), 503, 'upstream_unavailable'],
    [() => upstream({ status: 401, body: '{"error":"origin_not_allowed"}' }), 503, 'upstream_unavailable'],
    [() => upstream({ status: 302, headers: { Location: 'https://evil.invalid' } }), 503, 'upstream_unavailable'],
    [() => upstream({ body: ' '.repeat(LIMITS.responseBytes + 1) }), 502, 'upstream_invalid_response'],
    [() => upstream({ headers: { 'Content-Encoding': 'gzip' } }), 502, 'upstream_invalid_response'],
    [() => upstream({ body: JSON.stringify({ ...JSON.parse(FEES), schemaVersion: 2 }) }), 502, 'upstream_contract_mismatch'],
  ]) {
    const h = harness(responder);
    await expectError(await h.worker.fetch(fees(), on), status, error, V12);
    assert.equal(h.calls.length, 1, 'no retry');
  }
  const busy = harness(() => upstream({ body: '{"error":"read_capacity_busy"}', status: 429, version: V11, headers: { 'Retry-After': '7' } }));
  const response = await busy.worker.fetch(fees(), on);
  assert.equal(response.headers.get('Retry-After'), '7');
  await expectError(response, 429, 'read_capacity_busy', V12);
  assert.equal(ERROR_STATUS_BY_CODE.route_not_available, 404);
});

test('(c) position-fees shares the read budget: a stalled gateway is cut at 15 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const h = harness(() => new Promise(() => {}));
  const pending = h.worker.fetch(fees(), on);
  for (let i = 0; i < 24; i++) await Promise.resolve();
  assert.equal(h.calls.length, 1);
  t.mock.timers.tick(LIMITS.upstreamMs + 1);
  await expectError(await pending, 504, 'upstream_timeout', V12);
  assert.equal(h.calls[0].init.signal.aborted, true);
});

test('naming position-fees in ENABLED_V6_READS no longer fails every read-v6 route closed; a misspelt name still does', async () => {
  for (const reads of [WITH_FEES, 'position-fees', 'position-fees,activity']) {
    const h = harness(() => upstream({ body: reads.includes('activity') ? text('valid/activity.json') : PORTFOLIO, version: V11 }));
    const route = reads.includes('activity') ? 'activity' : null;
    if (route) assert.equal((await h.worker.fetch(request(route, { version: V11, body: JSON.stringify({ wallet: WALLET }) }), { ...env, ENABLED_V6_READS: reads })).status, 200, reads);
    assert.equal((await h.worker.fetch(capabilities(V11), { ...env, ENABLED_V6_READS: reads })).status, 200, reads);
  }
  for (const reads of ['position_fees', 'Position-fees', 'position-fees,position-fees', ` position-fees`, `${PRODUCTION_READS},fees`, 'position-fees ']) {
    const h = harness();
    const settings = { ...env, ENABLED_V6_READS: reads };
    for (const version of [V11, V12]) {
      await expectError(await h.worker.fetch(capabilities(version), settings), 503, 'upstream_unavailable', V11);
      await expectError(await h.worker.fetch(request('portfolio', { version, body: JSON.stringify({ wallet: WALLET }) }), settings), 503, 'upstream_unavailable', V11);
      await expectError(await h.worker.fetch(fees({ version }), settings), 503, 'upstream_unavailable', V11);
    }
    assert.equal(h.calls.length, 0);
  }
});

test('(d) 1.1.0-rc.1\'s five routes are also taken in 1.2.0-rc.1: sent upstream and answered in that version', async () => {
  const requests = {
    portfolio: JSON.stringify({ wallet: WALLET }),
    activity: text('requests/activity.json'),
    'chain-pools': null, 'chain-balances': text('requests/chain-balances.json'), 'chain-tokens': null,
  };
  const answers = {
    portfolio: PORTFOLIO_12,
    activity: text('valid/activity-page.json'),
    'chain-pools': text('valid/chain-pools.json'),
    'chain-balances': text('valid/chain-balances-asked.json'),
    'chain-tokens': text('valid/chain-tokens.json'),
  };
  for (const route of ROUTES) {
    // The 1.2.0-rc.1 answer of each: its fixture (portfolio), else 1.1.0-rc.1's under 1.2.0-rc.1's name, which it is.
    const body = route === 'portfolio' ? answers[route] : JSON.stringify({ ...JSON.parse(answers[route]), contractVersion: V12 });
    const answer = JSON.parse(body);
    const sent = requests[route] ?? (route === 'chain-pools'
      ? JSON.stringify({ chainId: answer.chainId, token: answer.token, ...(answer.pairedToken ? { pairedToken: answer.pairedToken } : {}) })
      : JSON.stringify({ chainId: answer.chainId, query: answer.query }));
    const h = harness(() => upstream({ body }));
    const response = await h.worker.fetch(request(route, { version: V12, body: sent }), env);
    assert.equal(response.status, 200, route);
    assert.equal(await response.text(), body, route);
    assert.equal(response.headers.get('X-Domino-Read-Contract'), V12, route);
    assert.equal(h.calls[0].init.headers['X-Domino-Read-Contract'], V12, route);
    // A gateway that answers 1.1.0-rc.1 to a 1.2.0-rc.1 request (one installed before its read release) is refused:
    // today's app never asks these routes in 1.2.0-rc.1.
    const older = harness(() => upstream({ body: answers[route] === PORTFOLIO_12 ? PORTFOLIO : answers[route], version: V11 }));
    await expectError(await older.worker.fetch(request(route, { version: V12, body: sent }), env), 502, 'upstream_contract_mismatch', V12);
    // Its refusals made before it reads the version (in its first, 1.1.0-rc.1) pass in the version asked, as
    // position-fees' do; one in 1.2.0-rc.1 passes too; one in a version read-v6 never had does not.
    for (const [status, error, version, expected] of [
      [404, 'route_not_available', V11, 404], [429, 'read_capacity_busy', V11, 429], [503, 'upstream_unavailable', V12, 503],
      [404, 'route_not_available', '1.0.0-rc.1', 502],
    ]) {
      const refusing = harness(() => upstream({ body: JSON.stringify({ error }), status, version }));
      const answer = await refusing.worker.fetch(request(route, { version: V12, body: sent }), env);
      await expectError(answer, expected, expected === 502 ? 'upstream_contract_mismatch' : error, V12);
      assert.equal(refusing.calls.length, 1, `${route} ${status} ${version}`);
    }
  }
});

test('(d) a 1.1.0-rc.1 request stays 1.1.0-rc.1 end to end: sent in it, answered in it, and never with a 1.2.0-rc.1 answer', async () => {
  for (const version of [V11, undefined]) {
    const h = harness(() => upstream({ body: PORTFOLIO, version: V11 }));
    const response = await h.worker.fetch(request('portfolio', { version, body: JSON.stringify({ wallet: WALLET }) }), on);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), PORTFOLIO);
    assert.equal(response.headers.get('X-Domino-Read-Contract'), V11);
    assert.equal(h.calls[0].init.headers['X-Domino-Read-Contract'], V11);
    for (const [answerVersion, body] of [
      [V12, PORTFOLIO_12],
      // Labelled 1.1.0-rc.1 but naming 1.2.0-rc.1: the body names the version its header does (as read-v5's window).
      [V11, PORTFOLIO_12],
      [V12, PORTFOLIO],
    ]) {
      const refused = harness(() => upstream({ body, version: answerVersion }));
      await expectError(await refused.worker.fetch(request('portfolio', { version, body: JSON.stringify({ wallet: WALLET }) }), on), 502, 'upstream_contract_mismatch', V11);
    }
    // A refusal in 1.2.0-rc.1 to a 1.1.0-rc.1 request is refused too, as before the window.
    const refusal = harness(() => upstream({ body: '{"error":"route_not_available"}', status: 404, version: V12 }));
    await expectError(await refusal.worker.fetch(request('portfolio', { version, body: JSON.stringify({ wallet: WALLET }) }), on), 502, 'upstream_contract_mismatch', V11);
  }
});

test('(e) with production\'s ENABLED_V6_READS, a 1.1.0-rc.1 page reads the same capabilities, byte for byte', async () => {
  // Changed on purpose 2026-11-07 (review finding B): the chains are read-v6's own (today the three, in this order).
  const expected = `{"contractVersion":"1.1.0-rc.1","dataMode":"live_read_only","chainIds":${JSON.stringify(V6_CONSTANTS.chainIds)},` +
    '"enabledReads":["portfolio","activity","chain-pools","chain-balances","chain-tokens"],' +
    '"walletAuthentication":false,"privateAccounts":false,"ownerTransactions":false,"automation":false}';
  for (const settings of [env, on]) {
    for (const version of [V11, undefined]) {
      const response = await harness().worker.fetch(capabilities(version), settings);
      assert.equal(await response.text(), expected);
      assert.equal(response.headers.get('X-Domino-Read-Contract'), V11);
    }
  }
});
