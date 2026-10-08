/**
 * Domino's own chain routes (functions/_lib/chainRoutes.ts and functions/api/**, RPC-SPEC §2.4–2.5 and §2.10), over a fake
 * node (tests/support/fake-node.mjs) in front of the test suites' fake chains: each route's refusals and their shape,
 * the source off, the visitor's rate, the edge cache and the questions in flight, Server-Timing and the log line, every
 * route's answer, the source away, and the gate in front of them. Nothing reaches the network.
 *
 * Changed on purpose 2026-10-02 (RPC-SPEC §11.4, rugged97's rules for the site's token): the fees replay's /logs route is
 * gone, and the ledger route (/api/fees/v2/ledger, its own suite tests/fees-ledger.test.mjs) takes its place here; the
 * visitor's classes and node bill are sized for the token's 1,000 requests a second; no record is read below block
 * 69,249,061.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fakeNode } from './support/fake-node.mjs';
import { browserChain, RPC_URL } from './support/browser-chain.mjs';
import { addressTopic, fakeChain as feesChain, memoryCache, rpcLog, topicOf, word } from './support/fees/fake-chain.mjs';
import { ledgerWorld } from './support/fees/ledger-world.mjs';
import { txOf } from './support/fees/ledger-chain.mjs';
import { KEY, OWNER, POOL, TOKEN, USDG } from './owned-chain.mjs';

const require = createRequire(import.meta.url);
const routes = require('../.test-build/app/functions/_lib/chainRoutes.js');
const owned = require('../.test-build/app/functions/_lib/owned.js');
const fees = require('../.test-build/app/functions/_lib/fees.js');
const walletPositions = require('../.test-build/app/functions/_lib/walletPositions.js');
const ownedMints = require('../.test-build/app/functions/_lib/ownedMints.js');
const vaultRecord = require('../.test-build/app/functions/_lib/vaultRecord.js');
const automation = require('../.test-build/app/functions/_lib/automation.js');
const { LOCAL_RPC_LOG_BLOCKS, LOCAL_RPC_POSTS_PER_INVOCATION } = require('../.test-build/app/functions/_lib/localRpc.js');
const { REPLY_BYTES } = require('../.test-build/app/src/lib/edge/chainRoutes.js');
const { parseWalletAnswer } = require('../.test-build/app/src/lib/walletPositions.js');
const { parseAutomationAnswer } = require('../.test-build/app/src/lib/automationState.js');
const { isLedgerResponse, isStateResponse } = require('../.test-build/app/src/lib/fees/answers.js');
const { onRequest: gate, LOGIN_PATH, API_CSP, CHAIN_ROUTE } = require('../.test-build/app/functions/_middleware.js');

const ORIGIN = 'https://domino.money';
const TOKEN_PATH = 'test-token-0123456789abcdef';
const ENV = { LOCAL_RPC_URL: `https://rpc.domino.money/${TOKEN_PATH}/` };
const SIMULATING = { ...ENV, LOCAL_RPC_SIMULATE: 'true' };
const PATHS = { owned: '/api/owned/v2/positions', state: '/api/fees/v1/state', ledger: '/api/fees/v2/ledger', automation: '/api/automation/v1/state', record: '/api/automation/v1/record', simulate: '/api/chain/v1/simulate' };
const PLAIN = new Set(['owned', 'automation']);
const VAULT = `0x${'5a'.repeat(20)}`;
const ZERO = '0x0000000000000000000000000000000000000000';
const LOG_KEYS = ['cache', 'items', 'ms', 'nodeMs', 'outcome', 'posts', 'route', 'service', 'status'];
/** A ledger line's verdicts (chainRoutes.ts ledgerVerdicts): fixed codes and counts only. */
const VERDICTS_LINE = /^(?:(?:exact|inexact|other|reading|before_floor|manual|shared|native|liquidity|unseen|too_many|not_found|rpc_unavailable|hooked_pool):\d+(?:,|$))+$|^(?:large|unparsed|none)$/;
const BODIES = {
  owned: { owner: OWNER },
  state: { tokenIds: ['11'] },
  ledger: { tokenIds: ['11'] },
  automation: { tokenIds: ['11'] },
  record: { vault: VAULT, tokenId: '11', currencies: [USDG, TOKEN], from: 70_000_000, to: 70_100_000 },
  simulate: { owner: OWNER, calls: [{ to: USDG, data: '0x', value: '0x0' }] },
};

function request(name, body, { method = 'POST', headers = {} } = {}) {
  return new Request(`${ORIGIN}${PATHS[name]}`, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', ...headers },
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
}

/**
 * The routes over `deps` (a fake chain's runtime) as one isolate with one edge cache: `ask(name, body, options)`, every
 * POST the node got (`asked`), every log line (`lines`), what the cache holds (`stored`) and the clock.
 */
function edge(deps, { env = ENV, simulator = null, chainId, clock = { time: 1_000_000 } } = {}) {
  const asked = [];
  const lines = [];
  const { cache, stored } = memoryCache();
  const runtime = {
    upstream: fakeNode(deps, { simulator: () => simulator, chainId, asked }),
    cache,
    now: () => clock.time,
    sleep: async (ms) => {
      clock.time += ms;
    },
    memory: routes.chainRouteMemory(),
    log: (line) => lines.push(JSON.parse(line)),
  };
  const ask = (name, body = BODIES[name], options = {}) => routes.answerChainRoute(name, { request: request(name, body, options), env: options.env ?? env }, runtime);
  return { ask, asked, lines, stored, clock, runtime, routeLines: () => lines.filter((line) => line.route) };
}

const deps = (chain) => ({ fetch: (_url, init) => chain.fetch(RPC_URL, init) });

// The chain code's module memory (the head it read, the price path's head, its reads in flight) is the isolate's: each
// test starts from a new one, as each of its edges is an isolate of its own.
test.beforeEach(() => routes.resetChainRouteMemory());
const shapeOf = (name, error) => (PLAIN.has(name) ? { error } : { v: 1, error });

/** A wallet with two positions, one under an Auto-compound vault, minted at known blocks. */
function wallet(more = {}) {
  return browserChain({
    positions: [
      { tokenId: 11, holder: OWNER, key: KEY, tickLower: -600, tickUpper: 600, liquidity: 10n ** 12n, unclaimed: [5n, 7n], subscriber: VAULT, mintBlock: 70_100_000 },
      { tokenId: 12, holder: OWNER, key: KEY, tickLower: -600, tickUpper: 600, liquidity: 10n ** 12n, unclaimed: [0n, 0n], mintBlock: 71_000_000 },
    ],
    tokens: { [USDG]: { symbol: 'USDG', decimals: 6 }, [TOKEN]: { symbol: 'UFG', decimals: 18 } },
    vaults: { [VAULT]: { root: 11, feeBps: 200, paused: false } },
    ...more,
  });
}

// ---------------------------------------------------------------------------
// Refusals, the source, the visitor
// ---------------------------------------------------------------------------

test('each route refuses, in order, a method, an origin, a type, a size and a shape it does not take, in its own shape, asking nothing', async () => {
  const { ask, asked, routeLines } = edge(deps(wallet()), { env: SIMULATING });
  const big = (name) => JSON.stringify({ ...BODIES[name], pad: 'x'.repeat({ owned: 600, automation: 9_000, state: 600, ledger: 600, record: 600, simulate: 70_000 }[name]) });
  const shapes = {
    owned: { owner: OWNER, method: 'eth_call' },
    automation: { tokenIds: [] },
    state: { tokenIds: ['11'], automation: false },
    ledger: { tokenIds: [] },
    record: { ...BODIES.record, vault: ZERO },
    simulate: { owner: OWNER, calls: [] },
  };
  for (const name of Object.keys(PATHS)) {
    const plain = PLAIN.has(name);
    const cases = [
      [{ method: 'GET' }, undefined, 405, plain ? 'method_not_allowed' : 'bad_request'],
      [{ headers: { Origin: 'https://evil.example' } }, BODIES[name], 403, plain ? 'origin_not_allowed' : 'bad_request'],
      [{ headers: { 'Sec-Fetch-Site': 'cross-site' } }, BODIES[name], 403, plain ? 'origin_not_allowed' : 'bad_request'],
      [{ headers: { 'Content-Type': 'text/plain' } }, BODIES[name], 415, plain ? 'json_required' : 'bad_request'],
      [{}, big(name), plain ? 413 : 400, plain ? 'request_too_large' : 'bad_request'],
      [{}, '{"x":', 400, plain ? 'invalid_request' : 'bad_request'],
      [{}, shapes[name], 400, plain ? 'invalid_request' : 'bad_request'],
    ];
    for (const [options, body, status, error] of cases) {
      const response = await ask(name, body, options);
      assert.equal(response.status, status, `${name} ${JSON.stringify(options)}`);
      assert.deepEqual(await response.json(), shapeOf(name, error), `${name} ${status}`);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.match(response.headers.get('Content-Type'), /^application\/json; charset=utf-8$/);
      if (status === 405) assert.equal(response.headers.get('Allow'), 'POST');
    }
  }
  assert.equal(asked.length, 0, 'the node was asked nothing');
  assert.ok(routeLines().every((line) => line.outcome === 'bad_request' && line.cache === 'none' && line.posts === 0));
  // An owner the zero address, or not an address: the owned route's own codes.
  assert.deepEqual(await (await ask('owned', { owner: ZERO })).json(), { error: 'invalid_owner' });
  assert.deepEqual(await (await ask('owned', { owner: 'me' })).json(), { error: 'invalid_owner' });
});

test('without the node’s secret, or with anything but its exact shape, every route is a calm 503 at once, reading nothing; the simulation is off first', async () => {
  for (const env of [{}, { LOCAL_RPC_URL: '' }, { LOCAL_RPC_URL: `http://rpc.domino.money/${TOKEN_PATH}/` }, { LOCAL_RPC_URL: `https://rpc.domino.money.evil.example/${TOKEN_PATH}/` }, { LOCAL_RPC_URL: 'https://rpc.mainnet.chain.robinhood.com' }]) {
    const { ask, asked, lines } = edge(deps(wallet()), { env });
    for (const name of ['owned', 'state', 'ledger', 'automation', 'record']) {
      const response = await ask(name);
      assert.equal(response.status, 503, `${name} ${JSON.stringify(env)}`);
      assert.equal(response.headers.get('Retry-After'), '300');
      assert.deepEqual(await response.json(), shapeOf(name, 'source_unavailable'));
    }
    assert.equal(asked.length, 0);
    assert.deepEqual(lines.filter((line) => line.event), [{ service: 'chain-routes', event: 'local_rpc_not_configured' }], 'said once per isolate');
    assert.ok(lines.filter((line) => line.route).every((line) => line.outcome === 'source_off'));
    // The simulation's own switch comes before everything, its method included.
    for (const options of [{}, { method: 'GET' }]) {
      const off = await ask('simulate', BODIES.simulate, options);
      assert.equal(off.status, 404);
      assert.deepEqual(await off.json(), { v: 1, error: 'not_enabled' });
    }
  }
  // The simulation's flag is exactly "true".
  for (const value of ['1', 'TRUE', 'yes', ' true']) {
    assert.equal((await edge(deps(wallet()), { env: { ...ENV, LOCAL_RPC_SIMULATE: value } }).ask('simulate')).status, 404, value);
  }
});

test('each visitor’s rate per class: a burst, then a refill a minute; every request counts, hits included; without an address, none', async () => {
  const visitor = (ip) => ({ headers: { 'CF-Connecting-IP': ip } });
  const { ask, clock, routeLines, runtime } = edge(deps(wallet()), { env: {} });
  const statuses = async (name, count, ip = '203.0.113.7', env) => {
    const out = [];
    for (let i = 0; i < count; i++) {
      const response = await ask(name, BODIES[name], { ...visitor(ip), ...(env ? { env } : {}) });
      out.push(response.status === 429 ? `429:${response.headers.get('Retry-After')}` : String(response.status));
      if (response.status === 429) assert.deepEqual(await response.json(), shapeOf(name, 'rate_limited'));
    }
    return out;
  };
  // Changed on purpose 2026-10-02 (rugged97's answer to Q3: the site's token allows 1,000 requests a second): each class
  // five times what it was, or more, so a visitor is held by its node bill (VISITOR_NODE), not by counting questions.
  assert.deepEqual(routes.VISITOR_CLASSES, { owned: { burst: 30, perMinute: 60 }, state: { burst: 60, perMinute: 240 }, history: { burst: 240, perMinute: 1200 }, simulate: { burst: 6, perMinute: 12 } });
  assert.deepEqual(routes.CLASS_OF, { owned: 'owned', state: 'state', automation: 'state', ledger: 'history', record: 'history', simulate: 'simulate' });
  // owned: 30 at once, then one a second (60 a minute).
  assert.deepEqual(await statuses('owned', 32), [...Array(30).fill('503'), '429:1', '429:1']);
  clock.time += 1_000;
  assert.deepEqual(await statuses('owned', 2), ['503', '429:1']);
  assert.deepEqual(await statuses('owned', 1, '198.51.100.1'), ['503'], 'another visitor has its own');
  // state and automation share a class: 60, then four a second.
  assert.deepEqual(await statuses('state', 32), Array(32).fill('503'));
  assert.deepEqual(await statuses('automation', 29), [...Array(28).fill('503'), '429:1']);
  // the ledger and the record share one: 240, then twenty a second.
  const history = await statuses('ledger', 241);
  assert.deepEqual([history.filter((s) => s === '503').length, history.at(-1)], [240, '429:1']);
  assert.equal((await statuses('record', 1))[0], '429:1');
  // The simulation: 6, then one every five seconds.
  assert.deepEqual(await statuses('simulate', 7, '203.0.113.7', { LOCAL_RPC_SIMULATE: 'true' }), [...Array(6).fill('503'), '429:5']);
  // No address (a test, a local server): never limited.
  for (let i = 0; i < 20; i++) assert.equal((await ask('owned')).status, 503);
  assert.ok(routeLines().some((line) => line.outcome === 'limited'));
  assert.ok(routeLines().every((line) => !JSON.stringify(line).includes('203.0.113')), 'the address is never logged');
  // The isolate remembers at most MAX_VISITORS, by a salted digest, never the address.
  for (const key of runtime.memory.visitors.keys()) assert.match(key, /^(?:owned|state|history|simulate)\|[0-9a-f]{16}$/);
  for (let i = 0; i < routes.MAX_VISITORS + 10; i++) await ask('state', BODIES.state, visitor(`10.0.${i >> 8}.${i & 255}`));
  assert.equal(runtime.memory.visitors.size, routes.MAX_VISITORS);
});

// ---------------------------------------------------------------------------
// owned/v2/positions
// ---------------------------------------------------------------------------

test('owned: the envelope, its ids from DominoSetupV1’s state (no SetupMinted read by the scan), each listed position’s feature and mint', async () => {
  const chain = wallet();
  const { ask, asked, routeLines } = edge(deps(chain));
  const response = await ask('owned');
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.deepEqual(Object.keys(value), ['v', 'answer', 'automation', 'mints', 'capped']);
  assert.equal(value.v, 1);
  assert.equal(value.capped, false);
  const answer = parseWalletAnswer(value.answer, OWNER);
  assert.ok(answer);
  assert.deepEqual(answer.positions.map((p) => p.tokenId), ['12', '11']);
  assert.deepEqual(parseAutomationAnswer(value.automation, ['12', '11'])?.positions.map((p) => p.automation), ['plain', 'compound']);
  assert.deepEqual(value.mints, [
    { id: '12', block: 71_000_000, tx: `0x${(71_000_000).toString(16).padStart(64, '0')}` },
    { id: '11', block: 70_100_000, tx: `0x${(70_100_000).toString(16).padStart(64, '0')}` },
  ], 'newest first');
  // The scan read no log; the one log read is the mints walk, from DominoSetupV1's deployment, in windows the node serves.
  const logs = chain.log.filter((call) => call.method === 'eth_getLogs');
  assert.ok(logs.every((call) => call.params[0].topics[0] === owned.SETUP_MINTED_TOPIC));
  const ranges = logs.map((call) => [Number(call.params[0].fromBlock), Number(call.params[0].toBlock)]);
  assert.equal(ranges[0][0], owned.SETUP_DEPLOY_BLOCK);
  assert.equal(ranges.at(-1)[1], chain.head);
  // Changed on purpose 2026-10-02 (rugged97's answer to Q1: his node has no block ceiling): the transport's windows.
  assert.ok(ranges.every(([from, to], i) => to - from + 1 <= LOCAL_RPC_LOG_BLOCKS && (i === 0 || from === ranges[i - 1][1] + 1)), 'contiguous windows of at most LOCAL_RPC_LOG_BLOCKS');
  const [line] = routeLines();
  assert.deepEqual(Object.keys(line).sort(), LOG_KEYS);
  assert.equal(line.posts, asked.length);
  assert.ok(line.posts <= 7, `a cold list costs ${line.posts} POSTs`);
  assert.match(response.headers.get('Server-Timing'), new RegExp(`^edge;desc="miss", node;dur=\\d+;desc="${line.posts} posts"$`));
  // The ids come from the contract's state: with no SetupMinted log at all, the same positions are listed, with no mint.
  const hidden = wallet({ history: (filter) => (filter.topics?.[0] === owned.SETUP_MINTED_TOPIC ? [] : null) });
  const stateOnly = await (await edge(deps(hidden)).ask('owned')).json();
  assert.deepEqual(stateOnly.answer.positions.map((p) => p.tokenId), ['12', '11']);
  assert.deepEqual(stateOnly.mints, []);
});

test('owned: kept per owner 25 s (a fresh question 5 s), a failure 12 s; the mints walk kept a week, not made again while every listed mint is kept, and a failed walk leaves the kept mints', async () => {
  const chain = wallet();
  const { ask, clock, stored, routeLines } = edge(deps(chain));
  const first = await (await ask('owned')).json();
  const scans = () => chain.log.filter((call) => call.method === 'eth_call' && call.params[1] === 'latest').length;
  assert.equal(scans(), 1);
  clock.time += 4_999;
  assert.deepEqual(await (await ask('owned', { owner: OWNER, fresh: true })).json(), first, 'a fresh question within 5 s: the kept answer');
  assert.equal(routeLines().at(-1).cache, 'hit');
  assert.equal(scans(), 1);
  clock.time += 1;
  const mark = chain.log.length;
  await ask('owned', { owner: OWNER, fresh: true });
  assert.equal(scans(), 2, 'a fresh question after 5 s reads again');
  // The walk was kept, and it named every listed position's mint: changed on purpose 2026-10-02 (RPC fix round 2), no
  // second walk is made, where it read again from shortly before the first's block (a walk that may add something still
  // reads from there only: the capped wallet's test below).
  assert.deepEqual(chain.log.slice(mark).filter((call) => call.method === 'eth_getLogs'), []);
  const key = await ownedMints.mintsKey(ORIGIN, OWNER);
  assert.ok(stored.has(key));
  assert.doesNotMatch(key, new RegExp(OWNER.slice(2), 'i'), 'never the address in a URL');
  assert.match(stored.get(key).headers.get('Cache-Control'), /^max-age=604800$/);
  assert.deepEqual(ownedMints.keptMintsOf(await stored.get(key).clone().json()), { block: chain.head, ids: ['12', '11'], mints: first.mints });
  // A walk the node refuses (one listed position's mint is not kept, so a walk is made): the answer stands, with the mints
  // kept before. Changed on purpose 2026-10-02 (RPC fix round 2): past the 25 s an answer is kept now.
  clock.time += 25_000;
  stored.set(key, new Response(JSON.stringify({ block: chain.head, ids: ['12'], mints: [first.mints[0]] }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=604800' } }));
  chain.history = (filter) => {
    if (filter.topics?.[0] === owned.SETUP_MINTED_TOPIC) throw new Error('refused');
    return null;
  };
  const refusedWalk = await ask('owned');
  assert.equal(refusedWalk.status, 200);
  assert.deepEqual((await refusedWalk.json()).mints, [first.mints[0]]);
  // Cold, with nothing kept and a failing walk: the answer stands with no mint.
  const cold = edge(deps(chain));
  assert.deepEqual((await (await cold.ask('owned')).json()).mints, []);
  // A chain that cannot be read: chain_unavailable, kept 12 s for every question.
  const broken = wallet();
  broken.outage = 500;
  const down = edge(deps(broken));
  const failed = await down.ask('owned');
  assert.deepEqual([failed.status, await failed.json(), failed.headers.get('Retry-After')], [502, { error: 'chain_unavailable' }, '12']);
  broken.outage = null;
  down.clock.time += 11_999;
  assert.equal((await down.ask('owned', { owner: OWNER, fresh: true })).status, 502, 'kept for a fresh question too');
  down.clock.time += 1;
  assert.equal((await down.ask('owned')).status, 200);
});

test('owned: a busy node is chain_busy with its wait, which the client reads as a rate refusal', async () => {
  const chain = wallet();
  chain.outage = (call) => (call.method === 'eth_call' ? 429 : null);
  const { ask, routeLines } = edge(deps(chain));
  const response = await ask('owned');
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'chain_busy' });
  assert.ok(Number(response.headers.get('Retry-After')) > 0);
  assert.equal(routeLines().at(-1).outcome, 'busy');
});

// ---------------------------------------------------------------------------
// fees/v1/state and automation/v1/state
// ---------------------------------------------------------------------------

test('state: up to eight positions at one block, with each one’s feature only when asked; kept 10 s, apart per question', async () => {
  const chain = wallet();
  const { ask, clock, asked, routeLines } = edge(deps(chain));
  const plain = await (await ask('state', { tokenIds: ['12', '11'] })).json();
  assert.ok(isStateResponse(plain));
  assert.deepEqual(plain.positions.map((p) => p.tokenId), ['11', '12']);
  assert.equal(plain.automation, undefined);
  const withFeature = await (await ask('state', { tokenIds: ['11'], automation: true })).json();
  assert.ok(isStateResponse(withFeature));
  assert.deepEqual(withFeature.automation, [{ tokenId: '11', automation: 'compound', paused: false, active: true, vault: VAULT }]);
  const posts = asked.length;
  clock.time += 9_999;
  await ask('state', { tokenIds: ['11'], automation: true });
  assert.equal(asked.length, posts, 'kept');
  assert.equal(routeLines().at(-1).cache, 'hit');
  clock.time += 1;
  await ask('state', { tokenIds: ['11'], automation: true });
  assert.ok(asked.length > posts, 'read again at 10 s');
  // Two calls: the first at 'latest', which names its block; the second at that block.
  assert.ok(chain.log.filter((call) => call.method === 'eth_call').length >= 2);
});

// 2026-10-01 (the switch's integration): right after the owner's action the page asks fresh, and takes no answer the route
// kept from before it; a kept failure still stands, so asking fresh in a loop is not a loop of node reads.
test('state: a fresh question takes a kept answer only within 2 s and replaces it; a kept failure stands for it too', async () => {
  const chain = wallet();
  const { ask, clock, asked, routeLines } = edge(deps(chain));
  const body = { tokenIds: ['11'], automation: true };
  await ask('state', body);
  const posts = asked.length;
  clock.time += 1_999;
  await ask('state', { ...body, fresh: true });
  assert.equal(asked.length, posts, 'a kept answer within 2 s is fresh enough');
  assert.equal(routeLines().at(-1).cache, 'hit');
  clock.time += 1;
  const fresh = await ask('state', { ...body, fresh: true });
  assert.equal(fresh.status, 200);
  assert.ok(isStateResponse(await fresh.json()));
  assert.ok(asked.length > posts, 'read again at 2 s');
  const after = asked.length;
  await ask('state', body);
  assert.equal(asked.length, after, 'the fresh answer is kept for the plain question too');
  // Only true, as the other flags.
  for (const fresh of [false, 'true', 1, null]) assert.equal((await ask('state', { ...body, fresh })).status, 400, String(fresh));
  // A kept failure stands for a fresh question as for any other.
  const away = wallet();
  const failing = edge(deps(away));
  away.outage = 500;
  assert.equal((await failing.ask('state', body)).status, 502);
  const failed = failing.asked.length;
  away.outage = null;
  assert.equal((await failing.ask('state', { ...body, fresh: true })).status, 502, 'the failure is kept 5 s, fresh or not');
  assert.equal(failing.asked.length, failed);
});

test('automation: each id’s feature in the order asked; kept 15 s per set in any order; a rate limit is chain_busy, anything else chain_unavailable', async () => {
  const chain = wallet();
  const { ask, clock, asked } = edge(deps(chain));
  // The fake chain shows an NFT's subscriber once a read has named it (tests/support/browser-chain.mjs): the list first.
  assert.equal((await ask('owned')).status, 200);
  const first = await (await ask('automation', { tokenIds: ['12', '11'] })).json();
  assert.deepEqual(parseAutomationAnswer(first, ['12', '11'])?.positions.map((p) => p.automation), ['plain', 'compound']);
  const posts = asked.length;
  clock.time += 14_999;
  const reordered = await (await ask('automation', { tokenIds: ['11', '12'] })).json();
  assert.deepEqual(reordered.positions.map((p) => p.tokenId), ['11', '12'], 'the kept answer, in this question’s order');
  assert.equal(asked.length, posts);
  const busy = wallet();
  busy.outage = (call) => (call.method === 'eth_blockNumber' ? 429 : null);
  const refused = await edge(deps(busy)).ask('automation');
  assert.deepEqual([refused.status, await refused.json()], [502, { error: 'chain_busy' }]);
  const broken = wallet();
  broken.outage = 500;
  const failed = await edge(deps(broken)).ask('automation');
  assert.deepEqual([failed.status, await failed.json(), failed.headers.get('Retry-After')], [502, { error: 'chain_unavailable' }, '5']);
});

// ---------------------------------------------------------------------------
// fees/v2/ledger (its own suite: tests/fees-ledger.test.mjs), and the record's chain
// ---------------------------------------------------------------------------

const HEAD = 71_500_000;
const MINT = 70_000_000;
const PM_WORD = addressTopic(owned.POSITION_MANAGER);
const modifyLog = (block, salt, index = 0) =>
  rpcLog({ topics: [fees.TOPIC.ModifyLiquidity, POOL, PM_WORD], data: `0x${[-600n, 600n, 10n ** 12n, BigInt(salt)].map(word).join('')}`, block, index, tx: `0x${(block * 10 + index).toString(16).padStart(64, '0')}` });
const executionLog = (block, tokenId, address = VAULT) => rpcLog({ address, topics: [vaultRecord.EXECUTION_COMPLETED, topicOf(1), topicOf(2)], data: `0x${[0n, BigInt(tokenId), 0n, 7n].map(word).join('')}`, block, tx: `0x${(block * 7).toString(16).padStart(64, '0')}` });
const paymentLog = (currency, block, amount, to = OWNER) => rpcLog({ address: currency, topics: [fees.TOPIC.Transfer, addressTopic(VAULT), addressTopic(to)], data: `0x${word(amount)}`, block, tx: `0x${(block * 7).toString(16).padStart(64, '0')}` });

/** Cold vaults for the visitor's bill: `vaultOf(i)`, each a key of its own at the record route. */
const vaultOf = (i) => `0x${(0x1000 + i).toString(16).padStart(40, '0')}`;
const COLD_VAULTS = Array.from({ length: 300 }, (_, i) => vaultOf(i));
const LOW_HEAD = 70_500_000;

/**
 * A vault's record on a fake node (changed on purpose 2026-10-02: no pool history, which no route reads any more).
 * `more.head`: LOW_HEAD for the visitor's bill, so no question is a wide scan (localRpc.ts LOCAL_RPC_WIDE, which paces a
 * visitor at one a second, well within its bill's refill).
 */
function historyChain(more = {}) {
  const logs = [
    rpcLog({ address: owned.POSITION_MANAGER, topics: [fees.TOPIC.Transfer, addressTopic(ZERO), addressTopic(OWNER), topicOf(11)], block: MINT }),
    modifyLog(MINT, 11),
    modifyLog(MINT + 5_000, 99),
    executionLog(MINT + 50_000, 11),
    modifyLog(MINT + 50_000, 11, 1),
    paymentLog(USDG, MINT + 50_000, 5n),
    paymentLog(USDG, MINT + 50_000, 9n, owned.POSITION_MANAGER),
    ...(more.logs ?? []),
  ];
  // 2026-10-02 (review of the rules, finding 16): the factory made every vault these tests name, but `more.notMade`.
  const views = (target, data) =>
    target === automation.SEQUENCE_FACTORY && data.startsWith(`0x${automation.AUTOMATION_SELECTOR.isVault}`)
      ? { success: true, returnData: `0x${(more.notMade?.includes(`0x${data.slice(-40)}`) ? 0n : 1n).toString(16).padStart(64, '0')}` }
      : { success: false, returnData: '0x' };
  return feesChain({ head: more.head ?? HEAD, logs, headers: { [MINT]: 1_790_000_000, [HEAD - 5]: 1_790_100_000 }, views, tokens: [USDG, TOKEN, VAULT, `0x${'77'.repeat(20)}`, `0x${'78'.repeat(20)}`, ...COLD_VAULTS] });
}

test('ledger: a position’s ledger and its state at one block, what the page’s parser takes; kept half a minute, a fresh question two seconds', async () => {
  const world = ledgerWorld();
  const { ask, asked, routeLines, clock } = edge({ fetch: (_url, init) => world.chain.fetch(RPC_URL, init) });
  const question = { tokenIds: ['3325113'], mintHints: [{ tokenId: '3325113', block: world.spec.mint.block, tx: txOf(world.spec.mint.block) }] };
  const response = await ask('ledger', question);
  assert.equal(response.status, 200, await response.clone().text());
  const value = await response.json();
  assert.ok(isLedgerResponse(value), 'the page’s own check');
  assert.equal(value.positions[0].tokenId, '3325113');
  // 2026-10-02 (review of the chart's tabs, finding 1): its log line says what it answered, never the id.
  assert.equal(routeLines().at(-1).verdicts, 'exact:1');
  assert.equal(JSON.stringify(routeLines()).includes('3325113'), false);
  assert.ok(asked.length > 0);
  const posts = asked.length;
  clock.time += 20_000;
  assert.equal((await ask('ledger', question)).status, 200);
  assert.equal(asked.length, posts, 'the same ids within half a minute: kept');
  assert.equal(routeLines().at(-1).cache, 'hit');
  assert.equal(routeLines().at(-1).verdicts, 'exact:1', 'a kept answer’s verdicts too');
  clock.time += 5_000;
  assert.equal((await ask('ledger', { ...question, fresh: true })).status, 200);
  assert.ok(asked.length > posts, 'a fresh question takes no answer older than two seconds');
});

test('ledgerVerdicts: each position exact, its why, or its reason, counted and sorted; nothing else from the answer, never an id', () => {
  const { ledgerVerdicts } = routes;
  const answer = (positions) => JSON.stringify({ v: 1, block: 1, timestamp: 1, positions });
  assert.equal(ledgerVerdicts(answer([
    { tokenId: '3325113', ok: true, exact: true },
    { tokenId: '12', ok: true, exact: false, why: 'manual', entries: [{ why: 'native' }] },
    { tokenId: '13', ok: true, exact: false, why: 'manual' },
    { tokenId: '14', ok: true, exact: false, why: 'reading' },
    { tokenId: '15', ok: false, reason: 'not_found' },
  ])), 'exact:1,manual:2,not_found:1,reading:1');
  // A code it does not know is never logged as it came.
  assert.equal(ledgerVerdicts(answer([{ tokenId: '3325113', ok: true, exact: false, why: '0xabc' }, { tokenId: '9', ok: false, reason: '3325113' }])), 'inexact:1,other:1');
  assert.equal(ledgerVerdicts(answer([])), 'none');
  assert.equal(ledgerVerdicts('<!doctype html>'), 'unparsed');
  assert.equal(ledgerVerdicts(JSON.stringify({ v: 1 })), 'unparsed');
  assert.equal(ledgerVerdicts(`${answer([])}${' '.repeat(1_048_577)}`), 'large');
});



test('questions in flight: the same question in one isolate shares one read, each its own answer; another question reads its own', async () => {
  const chain = historyChain();
  let release;
  const held = new Promise((done) => (release = done));
  const slow = { ...chain.deps, fetch: async (url, init) => (await held, chain.deps.fetch(url, init)) };
  const { ask, asked, routeLines } = edge(slow);
  // Changed on purpose 2026-10-02 (RPC-SPEC §11.4): a vault's record, in place of a pool's swaps.
  const question = { ...BODIES.record, from: MINT, to: MINT + 200_000 };
  const answers = [ask('record', question), ask('record', question), ask('record', question)];
  setTimeout(release, 20);
  const done = await Promise.all(answers);
  const texts = await Promise.all(done.map((response) => response.text()));
  assert.equal(new Set(texts).size, 1);
  assert.deepEqual(routeLines().map((line) => line.cache).sort(), ['coalesced', 'coalesced', 'miss']);
  assert.match(done[1].headers.get('Server-Timing'), /^edge;desc="coalesced", node;dur=0;desc="0 posts"$/);
  assert.equal(asked.length, routeLines().find((line) => line.cache === 'miss').posts, 'only the one read asked the node');
  const other = await ask('record', { ...question, vault: `0x${'77'.repeat(20)}` });
  assert.equal(other.status, 200);
  assert.equal(routeLines().at(-1).cache, 'miss', 'another question reads its own');
});

// ---------------------------------------------------------------------------
// automation/v1/record
// ---------------------------------------------------------------------------

test('record: the vault’s executions and its pair’s payments out of it, trimmed; behind past the head; native pair: no transfers; no execution: none', async () => {
  const chain = historyChain();
  const { ask, stored, asked } = edge(chain.deps);
  const asked1 = { vault: VAULT, tokenId: '11', currencies: [USDG, TOKEN], from: MINT, to: MINT + 200_000 };
  const value = await (await ask('record', asked1)).json();
  assert.deepEqual(Object.keys(value), ['v', 'head', 'executions', 'transfers']);
  assert.equal(value.head, HEAD);
  assert.deepEqual(value.executions.map((log) => Object.keys(log)), [['address', 'topics', 'data', 'blockNumber', 'transactionHash', 'logIndex']]);
  assert.equal(value.executions[0].address, VAULT);
  assert.deepEqual(value.transfers.map((log) => [log.address, BigInt(log.data)]), [[USDG, 5n], [USDG, 9n]], 'every transfer out of the vault; the page tells the fee from the liquidity');
  const key = [...stored.keys()].find((url) => url.includes('/c1/record/'));
  assert.match(stored.get(key).headers.get('Cache-Control'), /^max-age=31536000$/, 'final: kept a year');
  const posts = asked.length;
  await ask('record', asked1);
  assert.equal(asked.length, posts);

  assert.deepEqual(await (await ask('record', { ...asked1, to: HEAD + 1 })).json(), { v: 1, behind: true });
  const native = await (await ask('record', { ...asked1, currencies: [ZERO, TOKEN] })).json();
  assert.equal(native.transfers, null);
  assert.equal(native.executions.length, 1);
  const none = await (await ask('record', { ...asked1, from: MINT + 60_000, to: MINT + 70_000 })).json();
  assert.deepEqual([none.executions, none.transfers], [[], []]);

  // A log that is not the one asked for fails the answer.
  const lying = historyChain();
  const wrong = {
    ...lying.deps,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.method !== 'eth_getLogs') return lying.deps.fetch(url, init);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: [executionLog(MINT + 50_000, 11, `0x${'66'.repeat(20)}`)] }), { headers: { 'Content-Type': 'application/json' } });
    },
  };
  const refused = await edge(wrong).ask('record', asked1);
  // An address Domino's factory did not make (finding 16: any address was a cold scan since the floor): no record, and no
  // log read, whatever it asks; its whole answer kept as any.
  const stranger = `0x${'99'.repeat(20)}`;
  const notMade = historyChain({ notMade: [stranger] });
  const cold = edge(notMade.deps);
  const empty = await (await cold.ask('record', { ...asked1, vault: stranger })).json();
  assert.deepEqual(empty, { v: 1, head: HEAD, executions: [], transfers: [] });
  assert.ok(!notMade.log.some((call) => call.method === 'eth_getLogs'), 'no log read');
  assert.ok(notMade.log.some((call) => call.method === 'eth_call'), 'the factory asked');
  // A vault it made is kept as one: its next record asks the factory nothing.
  await cold.ask('record', asked1);
  const calls = notMade.log.filter((call) => call.method === 'eth_call').length;
  await cold.ask('record', { ...asked1, from: MINT + 1 });
  assert.equal(notMade.log.filter((call) => call.method === 'eth_call').length, calls);
  assert.deepEqual([refused.status, await refused.json()], [502, { v: 1, error: 'rpc_unavailable' }]);
  assert.equal(vaultRecord.RECORD_REPLY_BYTES, REPLY_BYTES.record, 'no larger than the page reads');
  assert.equal(vaultRecord.recordRequestOf({ ...asked1, to: asked1.from + vaultRecord.RECORD_SPAN + 1 }), null, 'at most 50,000,000 blocks');
  assert.equal(vaultRecord.recordRequestOf({ ...asked1, tokenId: '011' }), null);
  assert.equal(vaultRecord.recordRequestOf({ ...asked1, currencies: [USDG.toUpperCase().replace('0X', '0x'), TOKEN] }), null);
});

// ---------------------------------------------------------------------------
// chain/v1/simulate
// ---------------------------------------------------------------------------

test('simulate: on by its flag, one fixed eth_simulateV1, the answer trimmed to status and gas; a node without it is 501, a failed simulation 422', async () => {
  const seen = [];
  const simulator = (params) => {
    seen.push(params);
    return [{ number: '0x1', calls: params[0].blockStateCalls[0].calls.map((_, i) => ({ status: i ? '0x0' : '0x1', gasUsed: '0x5208', returnData: '0xdead', logs: [{}] })) }];
  };
  // A deposit of 1 ETH: a wei value past 2^53 is a value like any other.
  const calls = [{ to: USDG, data: '0x095ea7b3', value: '0x0' }, { to: TOKEN, data: '0x', value: '0xde0b6b3a7640000' }];
  const on = edge(deps(wallet()), { env: SIMULATING, simulator });
  const response = await on.ask('simulate', { owner: OWNER, calls });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { v: 1, result: [{ calls: [{ status: '0x1', gasUsed: '0x5208' }, { status: '0x0', gasUsed: '0x5208' }] }] });
  // Changed on purpose 2026-10-02 (review of the rules, finding 15): each call with its share of the gas, 15,000,000 for two.
  assert.deepEqual(seen, [[{ blockStateCalls: [{ calls: calls.map((call) => ({ from: OWNER, ...call, gas: '0xe4e1c0' })) }], validation: false }, 'latest']]);
  assert.equal(on.routeLines().at(-1).cache, 'none', 'never kept');
  await on.ask('simulate', { owner: OWNER, calls });
  assert.equal(seen.length, 2, 'asked again: never cached');
  for (const [label, body] of [
    ['an extra key', { owner: OWNER, calls, from: OWNER }],
    ['a gas field', { owner: OWNER, calls: [{ ...calls[0], gas: '0x1' }] }],
    ['a call to Multicall3', { owner: OWNER, calls: [{ ...calls[0], to: owned.MULTICALL3 }] }],
    // Changed on purpose 2026-10-02 (review finding 17): up to twelve calls.
    ['thirteen calls', { owner: OWNER, calls: Array(13).fill(calls[0]) }],
    ['odd data', { owner: OWNER, calls: [{ ...calls[0], data: '0x1' }] }],
    ['a padded value', { owner: OWNER, calls: [{ ...calls[0], value: '0x01' }] }],
    ['a value past 256 bits', { owner: OWNER, calls: [{ ...calls[0], value: `0x1${'0'.repeat(64)}` }] }],
  ]) {
    assert.equal((await on.ask('simulate', body)).status, 400, label);
  }
  const missing = edge(deps(wallet()), { env: SIMULATING, simulator: null });
  const unsupported = await missing.ask('simulate', { owner: OWNER, calls });
  assert.deepEqual([unsupported.status, await unsupported.json()], [501, { v: 1, error: 'simulate_unsupported' }]);
  const reverting = edge(deps(wallet()), { env: SIMULATING, simulator: () => Promise.reject(Object.assign(new Error('execution reverted'), { code: 3 })) });
  const failed = await reverting.ask('simulate', { owner: OWNER, calls });
  assert.deepEqual([failed.status, await failed.json()], [422, { v: 1, error: 'simulation_failed' }]);
  for (const odd of [[], [{ calls: [] }], [{ calls: [{ status: '0x1', gasUsed: '0x1' }] }, { calls: [] }], [{ calls: [{ status: '0x2', gasUsed: '0x1' }, { status: '0x1', gasUsed: '0x1' }] }], [{ calls: [{ status: '0x1', gasUsed: 21000 }, { status: '0x1', gasUsed: '0x1' }] }]]) {
    const strange = await edge(deps(wallet()), { env: SIMULATING, simulator: () => odd }).ask('simulate', { owner: OWNER, calls });
    assert.deepEqual([strange.status, await strange.json()], [502, { v: 1, error: 'rpc_unavailable' }], JSON.stringify(odd));
  }
});

// ---------------------------------------------------------------------------
// The source away, the log line, the token
// ---------------------------------------------------------------------------

test('the node away (another chain, a refused token, out of reach) is the calm source_unavailable with a minute’s wait; a busy one is not', async () => {
  const other = edge(deps(wallet()), { chainId: '0x1' });
  for (const name of ['owned', 'state', 'automation', 'ledger', 'record']) {
    const response = await other.ask(name);
    assert.deepEqual([response.status, response.headers.get('Retry-After'), await response.json()], [503, '60', shapeOf(name, 'source_unavailable')], name);
  }
  assert.ok(other.lines.some((line) => line.event === 'local_rpc_wrong_chain'));
  const refusing = edge({ fetch: async () => new Response('', { status: 401 }) });
  const refused = await refusing.ask('state');
  assert.deepEqual([refused.status, await refused.json()], [503, { v: 1, error: 'source_unavailable' }]);
  assert.ok(refusing.lines.some((line) => line.event === 'local_rpc_refused' && line.status === 401));
  const unreachable = edge({ fetch: async () => Promise.reject(new TypeError('fetch failed')) });
  const away = await unreachable.ask('automation');
  assert.deepEqual([away.status, await away.json()], [503, { error: 'source_unavailable' }]);
  const busy = edge({ fetch: async () => new Response('', { status: 429 }) });
  const resting = await busy.ask('state');
  assert.deepEqual([resting.status, await resting.json()], [429, { v: 1, error: 'rate_limited' }]);
  assert.equal(busy.routeLines().at(-1).outcome, 'busy');
});

test('one log line per invocation, of fixed keys and codes; the token, the address and the ids are in no answer, header or line', async () => {
  const echoing = wallet();
  const { ask, lines } = edge({
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'eth_getLogs') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: `upstream https://rpc.domino.money/${TOKEN_PATH}/ failed` } }), { headers: { 'Content-Type': 'application/json' } });
      return echoing.fetch(url, init);
    },
  });
  const texts = [];
  for (const name of ['owned', 'state', 'automation', 'ledger', 'record']) {
    const response = await ask(name);
    texts.push(String(response.status), ...[...response.headers].flat(), await response.text());
  }
  for (const line of lines.filter((one) => one.route)) {
    // 2026-10-02 (review of the chart's tabs, finding 1): a ledger answer's line also counts its verdicts, codes only.
    assert.deepEqual(Object.keys(line).filter((key) => key !== 'verdicts').sort(), LOG_KEYS);
    if ('verdicts' in line) {
      assert.equal(line.route, 'ledger');
      assert.match(line.verdicts, VERDICTS_LINE);
    }
    assert.match(line.outcome, /^(?:answer|busy|unavailable|source_off|bad_request|limited)$/);
    assert.match(line.cache, /^(?:hit|miss|coalesced|none)$/);
  }
  const logged = JSON.stringify(lines);
  for (const secret of [TOKEN_PATH, 'rpc.domino.money', OWNER.slice(2), VAULT.slice(2)]) assert.equal(logged.includes(secret), false, `${secret} logged`);
  assert.equal(texts.some((text) => text.includes(TOKEN_PATH)), false, 'the token in an answer');
});

// ---------------------------------------------------------------------------
// The gate in front of them
// ---------------------------------------------------------------------------

const GATE = { BETA_PASSWORD: 'chain-routes-beta-password-01', BETA_COOKIE_KEY: 'Vb3sQ7mLx2Kp9TcN4dWy8ZhJ1gFa6ReU5oYiXwErTzC' };

async function betaCookie() {
  const response = await gate({
    request: new Request(`${ORIGIN}${LOGIN_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN }, body: `password=${encodeURIComponent(GATE.BETA_PASSWORD)}` }),
    env: GATE,
    next: async () => assert.fail('login reached the app'),
  });
  return response.headers.get('Set-Cookie').split(';')[0];
}

test('the gate: without the access cookie a 401; with it each chain route goes on with no cookie at all, and its answer leaves no-store (compressible) with the API CSP', async () => {
  const cookie = await betaCookie();
  for (const path of [...Object.values(PATHS), '/API/OWNED/V2/POSITIONS']) {
    assert.equal(CHAIN_ROUTE.test(path), true, path);
    const ask = (headers) => new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', ...headers }, body: '{}' });
    const refused = await gate({ request: ask({ Cookie: '__Host-domino-session=v1.sessiontoken' }), env: GATE, next: async () => assert.fail('the gate let an unauthenticated request through') });
    assert.deepEqual([refused.status, await refused.json()], [401, { error: 'beta_access_required' }]);
    const handed = [];
    const answered = await gate({
      request: ask({ Cookie: `theme=dark; ${cookie}; __Host-domino-session=v1.sessiontoken` }),
      env: GATE,
      next: async (passed) => {
        handed.push(passed);
        return new Response('{}', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' } });
      },
    });
    assert.ok(handed[0] instanceof Request, path);
    assert.equal(handed[0].headers.get('Cookie'), null, `${path}: no cookie past the gate`);
    assert.equal(await handed[0].text(), '{}');
    assert.equal(answered.headers.get('Cache-Control'), 'no-store', path);
    assert.equal(answered.headers.get('Content-Security-Policy'), API_CSP);
    assert.equal(answered.headers.get('Set-Cookie'), null);
  }
  // Anything else under those prefixes is not a chain route: it keeps its cookies and its no-transform.
  for (const path of ['/api/owned/v2/positions/x', '/api/fees/v1/stat', '/api/chain/v1/simulate2', '/api/automation/v2/state']) {
    assert.equal(CHAIN_ROUTE.test(path), false, path);
    const answered = await gate({ request: new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' }), env: GATE, next: async (passed) => (assert.equal(passed, undefined), new Response('{}', { headers: { 'Content-Type': 'application/json' } })) });
    assert.equal(answered.headers.get('Cache-Control'), 'no-store, no-transform', path);
  }
});

test('the route files: one line each over answerChainRoute, at the six fixed paths', async () => {
  const files = {
    owned: require('../.test-build/app/functions/api/owned/v2/positions.js'),
    state: require('../.test-build/app/functions/api/fees/v1/state.js'),
    ledger: require('../.test-build/app/functions/api/fees/v2/ledger.js'),
    automation: require('../.test-build/app/functions/api/automation/v1/state.js'),
    record: require('../.test-build/app/functions/api/automation/v1/record.js'),
    simulate: require('../.test-build/app/functions/api/chain/v1/simulate.js'),
  };
  const log = console.log;
  console.log = () => {};
  try {
    for (const [name, file] of Object.entries(files)) {
      assert.deepEqual(Object.keys(file), ['onRequest'], name);
      const response = await file.onRequest({ request: request(name, BODIES[name]), env: {} });
      assert.equal(response.status, name === 'simulate' ? 404 : 503, name);
    }
  } finally {
    console.log = log;
    routes.resetChainRouteMemory();
  }
});

test('the windows the chain code is told at the edge, and the mints walk’s kept entry, checked field by field', () => {
  assert.deepEqual(owned.limitsOf({}), { one: owned.LOG_BLOCKS_ONE, many: owned.LOG_BLOCKS_MANY }, 'the chain RPC’s, without the edge’s');
  assert.deepEqual(owned.limitsOf({ logLimits: { one: 5, many: 3 } }), { one: 5, many: 3 });
  const tx = `0x${'ab'.repeat(32)}`;
  const kept = { block: 71_000_000, ids: ['12', '11'], mints: [{ id: '12', block: 70_000_000, tx }] };
  assert.deepEqual(ownedMints.keptMintsOf(kept), kept);
  for (const bad of [
    { ...kept, extra: 1 },
    { ...kept, block: 1 },
    { ...kept, ids: ['012'] },
    { ...kept, ids: ['12', '12'] },
    { ...kept, mints: [{ id: '12', block: 70_000_000, tx: tx.toUpperCase().replace('0X', '0x') }] },
    { ...kept, mints: [{ id: '12', block: 70_000_000 }] },
    null,
  ]) {
    assert.equal(ownedMints.keptMintsOf(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(ownedMints.mergedMints([{ id: '12', block: 90_000_000, tx }], [{ id: '12', block: 1, tx }, { id: '11', block: 70_000_001, tx }, { id: '9', block: 70_000_002, tx }], new Set(['12', '11'])), [{ id: '12', block: 90_000_000, tx }, { id: '11', block: 70_000_001, tx }], 'one per id, the new first, only the listed, newest first');
});

// ---------------------------------------------------------------------------
// 2026-10-02: the review of the RPC switch (its findings 3, 4, 5, 6, 12, 13, 14 and 17)
// ---------------------------------------------------------------------------

/** One route's answer through answerChainRoute with a waitUntil of its own: the answer, and every promise handed to it. */
async function withWaitUntil(e, name, body, options = {}) {
  const kept = [];
  const response = await routes.answerChainRoute(name, { request: request(name, body, options), env: options.env ?? ENV, waitUntil: (work) => kept.push(work) }, e.runtime);
  return { response, kept };
}

// Finding 3: Cloudflare cancels a request's tasks when its visitor leaves, unless they were handed to waitUntil; a read
// the questions of an isolate share must neither die with its first question nor pin its key for good.
test('a read the questions share is handed to the first one’s waitUntil and clears its own slot; one older than its bound is never joined', async () => {
  const e = edge(deps(wallet()));
  const { response, kept } = await withWaitUntil(e, 'owned', BODIES.owned);
  assert.equal(response.status, 200);
  const handed = await Promise.all(kept);
  assert.ok(handed.some((value) => value && typeof value === 'object' && value.status === 200 && typeof value.text === 'string'), 'the shared read itself was handed to waitUntil');
  assert.equal(e.runtime.memory.inflight.size, 0, 'its slot is cleared once it settled');
  // A read whose question was cut off (its tasks cancelled: it never settles), older than SHARED_STALE_MS: a new question
  // reads for itself and answers, rather than waiting on it for good.
  const key = `owned#owned|${OWNER}|`;
  e.runtime.memory.inflight.set(key, { done: new Promise(() => {}), signals: [], started: e.clock.time - 45_001, refused: () => false });
  e.clock.time += 60_000;
  const fresh = await e.ask('owned');
  assert.equal(fresh.status, 200, 'answered, not stalled');
  assert.equal(e.runtime.memory.inflight.has(key), false, 'the dead read is gone from the slot');
  assert.equal(e.routeLines().at(-1).cache, 'miss', 'read itself');
  // The chain code's own units in flight (fees.ts shared): the same bound, and the same handover.
  const handedOver = [];
  const rt = (time) => ({ deps: { now: () => time, fetch: async () => assert.fail('no read'), sleep: async () => {} }, cache: null, waitUntil: (work) => handedOver.push(work) });
  let ran = 0;
  const first = fees.shared(rt(0), 'unit#1', () => (ran++, new Promise(() => {})));
  void first;
  assert.equal(handedOver.length, 1, 'handed to waitUntil when it starts');
  assert.equal(await fees.shared(rt(45_001), 'unit#1', async () => (ran++, 42)), 42, 'one older than its bound is never joined');
  assert.equal(ran, 2);
  const shared = fees.shared(rt(10), 'unit#2', async () => (ran++, 'once'));
  assert.equal(await fees.shared(rt(20), 'unit#2', async () => (ran++, 'twice')), 'once', 'a young one is joined');
  assert.equal(await shared, 'once');
  assert.equal(ran, 3);
  // RPC fix round 2.2: a unit whose own question was refused the node for its visitor's bill is never taken by a joiner,
  // which reads for itself; and joiners whose waits run out together make one read, not one each.
  let spent = false;
  const offered = assert.rejects(
    fees.shared({ ...rt(30), refused: () => spent }, 'unit#3', async () => {
      spent = true;
      throw new TypeError('local_rpc_visitor_spent');
    }),
    /local_rpc_visitor_spent/,
  );
  assert.equal(await fees.shared(rt(31), 'unit#3', async () => (ran++, 'mine')), 'mine', 'the refusal is not the joiner’s');
  await offered;
  let reads = 0;
  void fees.shared(rt(0), 'unit#4', () => new Promise(() => {}));
  const late = (value) => async () => (reads++, await new Promise((done) => setTimeout(done, 30)), value);
  const woke = await Promise.all([fees.shared(rt(44_990), 'unit#4', late('a')), fees.shared(rt(44_990), 'unit#4', late('b')), fees.shared(rt(44_990), 'unit#4', late('c'))]);
  assert.equal(reads, 1, 'one read for the three');
  assert.equal(new Set(woke).size, 1, 'each its answer');
});



// Finding 5: the visitor's share of the node, billed by the POSTs its questions made. Changed on purpose 2026-10-02 (RPC
// fix round 2): no slot is held for a question, a spent visitor is answered from the edge's cache alone, and an IPv6
// visitor is its /48; (round 2.1) each question pays a reserve, and every POST past it is owed; (round 2.2) the reserve
// is taken at the question's first call to the node, never by a cache hit or a join.
// Changed on purpose 2026-10-02 (rugged97's answer to Q3): a burst of 240 POSTs, 480 a minute, a reserve of 8.
test('a visitor is billed each node POST: once spent, only what would reach the node is a 429 with the wait; other visitors are not held; an IPv6 visitor is its /48', async () => {
  assert.deepEqual(routes.VISITOR_NODE, { burst: 240, perMinute: 480, reserve: 8 });
  for (const [address, network] of [
    ['203.0.113.7', '203.0.113.7'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1::/48'],
    ['2001:db8:1:ffff::1', '2001:db8:1::/48'],
    ['2001:0DB8:0001:0002:ffff::', '2001:db8:1::/48'],
    ['2001:db8::1', '2001:db8:0::/48'],
    ['::ffff:192.0.2.1', '192.0.2.1'],
    ['64:ff9b::192.0.2.1', '64:ff9b:0::/48'],
  ]) assert.equal(routes.visitorNetwork(address), network, address);
  // Records of vaults never read before (each cold: its two units and its payments, a POST each), by one visitor: billed
  // until its share is spent, before its class (240 questions) would refuse it. Changed on purpose 2026-10-02: the record
  // route, in place of a pool's parts.
  const chain = historyChain({ head: LOW_HEAD });
  const e = edge(chain.deps);
  const visitor = { headers: { 'CF-Connecting-IP': '198.51.100.20' } };
  const statuses = [];
  const started = e.clock.time;
  for (let i = 0; i < 239 && !statuses.includes(429); i++) {
    const response = await e.ask('record', { ...BODIES.record, vault: vaultOf(i), from: 69_500_000, to: LOW_HEAD - 100_000 }, visitor);
    statuses.push(response.status);
    if (response.status === 429) {
      assert.deepEqual(await response.json(), { v: 1, error: 'rate_limited' });
      assert.ok(Number(response.headers.get('Retry-After')) >= 1);
      assert.equal(e.routeLines().at(-1).outcome, 'limited');
    }
  }
  assert.ok(statuses.includes(429), 'the visitor’s share ran out');
  assert.ok(statuses.indexOf(429) < 239, `after ${statuses.indexOf(429)} questions, each billed its POSTs (the class alone would admit 240)`);
  const entries = [...e.runtime.memory.nodes.values()];
  assert.equal(entries.length, 1);
  assert.ok(entries[0].tokens < routes.VISITOR_NODE.reserve, 'refused once a question’s reserve is not left');
  // Every POST is owed, the reserves the questions did not use given back: a full burst less the POSTs, plus the refill.
  const owed = routes.VISITOR_NODE.burst - e.asked.length + ((entries[0].at - started) * routes.VISITOR_NODE.perMinute) / 60_000;
  assert.ok(Math.abs(entries[0].tokens - owed) < 0.01, `${entries[0].tokens} left after ${e.asked.length} POSTs`);
  assert.deepEqual(Object.keys(entries[0]).sort(), ['at', 'tokens'], 'nothing held for a question, so nothing to give back');
  assert.equal((await e.ask('record', { ...BODIES.record, vault: vaultOf(299) }, { headers: { 'CF-Connecting-IP': '198.51.100.21' } })).status, 200, 'another visitor is not held');
  // The same /48 is the same visitor: an address in another /64 of it is not a new bucket.
  const six = edge(deps(wallet()), { env: {} });
  const owned = [];
  for (let i = 0; i < 32; i++) owned.push((await six.ask('owned', BODIES.owned, { headers: { 'CF-Connecting-IP': `2001:db8:aa:${(i + 1).toString(16)}::1` } })).status);
  assert.deepEqual(owned, [...Array(30).fill(503), 429, 429], 'thirty at once for the whole /48, then the class’s wait');
});

/** Waits (real time, at most a second) until `check()` holds, and asserts it does. */
async function until(check, what) {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((done) => setTimeout(done, 2));
  assert.ok(check(), what);
}

/** The one visitor `e` remembers at the node, its bill set to `tokens` POSTs left (below zero: owed). */
function billOf(e, tokens) {
  const [key] = e.runtime.memory.nodes.keys();
  assert.ok(key, 'the visitor read the node');
  e.runtime.memory.nodes.set(key, { tokens, at: e.clock.time });
}

// RPC fix round 2 (the recheck's findings 1, 4 and 10): the bill was checked before the edge cache.
test('a spent visitor is answered from the cache alone: a kept answer and a read on its way are its as anyone’s; a read that would reach the node is a 429 that keeps nothing for anyone', async () => {
  const chain = historyChain();
  let release = null;
  const slow = { ...chain.deps, fetch: async (url, init) => (release ? await new Promise((done) => release.push(done)) : undefined, chain.deps.fetch(url, init)) };
  const e = edge(slow);
  const visitor = { headers: { 'CF-Connecting-IP': '198.51.100.40' } };
  const other = { headers: { 'CF-Connecting-IP': '198.51.100.41' } };
  const kept = { ...BODIES.record, from: MINT, to: MINT + 200_000 };
  assert.equal((await e.ask('record', kept, visitor)).status, 200);
  billOf(e, -50);
  // A final record, kept a year: answered, the node asked nothing.
  const posts = e.asked.length;
  const hit = await e.ask('record', kept, visitor);
  assert.equal(hit.status, 200);
  assert.equal(e.routeLines().at(-1).cache, 'hit');
  assert.equal(e.asked.length, posts, 'a cache hit costs the node nothing and is not refused');
  // A vault nobody read: a 429 with the wait until the bill holds a question's reserve again (58 POSTs at eight a second),
  // and nothing sent.
  const cold = { ...BODIES.record, vault: `0x${'77'.repeat(20)}` };
  const before = new Set(e.stored.keys());
  const refused = await e.ask('record', cold, visitor);
  assert.deepEqual([refused.status, await refused.json(), refused.headers.get('Retry-After')], [429, { v: 1, error: 'rate_limited' }, '8']);
  assert.deepEqual(e.routeLines().at(-1), { ...e.routeLines().at(-1), outcome: 'limited', cache: 'none', posts: 0 });
  assert.equal(e.asked.length, posts, 'nothing sent, not even the chain id check');
  assert.deepEqual([...e.stored.keys()].filter((url) => !before.has(url)), [], 'no failure kept for anyone');
  // Another visitor asks the same: answered from the node, never the spent visitor's refusal.
  assert.equal((await e.ask('record', cold, other)).status, 200);
  // A read already on its way, of another visitor: the spent visitor's same question joins it and is answered.
  release = [];
  const joined = { ...BODIES.record, vault: TOKEN };
  const theirs = e.ask('record', joined, other);
  for (let i = 0; i < 100 && release.length === 0; i++) await new Promise((done) => setTimeout(done, 2));
  assert.ok(release.length > 0, 'their read is at the node');
  const mine = e.ask('record', joined, visitor);
  await new Promise((done) => setTimeout(done, 20));
  const waiting = release;
  release = null;
  waiting.forEach((go) => go());
  const [a, b] = await Promise.all([theirs, mine]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.deepEqual(await b.json(), await a.json());
  assert.ok(e.routeLines().some((line) => line.route === 'record' && line.cache === 'coalesced' && line.posts === 0), 'joined, at no cost');
  // RPC fix round 2.2: the spent visitor's own read is offered like anyone's (it learns its bill is spent only at its
  // first call to the node), but another visitor who joined it never takes its refusal: that one reads for itself.
  // The spent visitor's read waits at the cache until the other visitor has joined it.
  const original = e.runtime.cache;
  let gate = null;
  e.runtime.cache = { match: async (key) => (gate ? await gate.wait : undefined, original.match(key)), put: (key, value) => original.put(key, value) };
  gate = {};
  gate.wait = new Promise((done) => (gate.open = done));
  const fresh = { ...BODIES.record, vault: `0x${'78'.repeat(20)}` };
  const seen = new Set(e.stored.keys());
  const lines = e.routeLines().length;
  const theRead = () => [...e.runtime.memory.inflight.entries()].find(([key]) => key.includes('78'.repeat(20)))?.[1];
  const spentAsk = e.ask('record', fresh, visitor);
  await until(() => theRead()?.signals.length === 1);
  const joinerAsk = e.ask('record', fresh, other);
  await until(() => theRead()?.signals.length === 2);
  const opened = gate.open;
  gate = null;
  opened();
  const [spent, joiner] = await Promise.all([spentAsk, joinerAsk]);
  e.runtime.cache = original;
  assert.deepEqual([spent.status, joiner.status], [429, 200]);
  assert.deepEqual(
    e.routeLines()
      .slice(lines)
      .map((line) => [line.outcome, line.cache])
      .sort(),
    [
      ['answer', 'miss'],
      ['limited', 'none'],
    ],
    'the joiner let the refused read go and read for itself',
  );
  const added = [...e.stored.keys()].filter((url) => !seen.has(url));
  assert.ok(added.length > 0, 'the joiner’s answer is kept');
  assert.deepEqual(added.filter((url) => url.includes('/recordFail/')), [], 'and no failure, for anyone');
});

/** The POSTs left on the bill of the one visitor `e` remembers at the node, refill included (a full burst when none). */
function leftOf(e) {
  const [entry] = e.runtime.memory.nodes.values();
  return entry ? Math.min(routes.VISITOR_NODE.burst, entry.tokens + ((e.clock.time - entry.at) * routes.VISITOR_NODE.perMinute) / 60_000) : routes.VISITOR_NODE.burst;
}

// RPC fix round 2 (the recheck's findings 0 and 9): a 'running' slot freed only by the question's own frame leaked when a
// visitor who had joined another's read left (Cloudflare cancels such a request's tasks), and eight leaks locked out
// the visitor's network for the isolate's life. Round 2.1 made each question pay a reserve at the door, joiners
// included, so eight joiners held the whole bill. Round 2.2 (the recheck of round 2.1, its medium finding and the low
// ones on the cut test and on joiners that time out): only a question that starts a node read of its own holds a
// reserve, and joiners whose wait runs out make one read between them, not one each.
test('nothing is held for a question that joins: a visitor’s many questions at once are all answered, joiners hold nothing, and eighteen whose wait ran out make one read', async () => {
  const chain = historyChain();
  let release;
  const held = new Promise((done) => (release = done));
  const slow = { ...chain.deps, fetch: async (url, init) => (await held, chain.deps.fetch(url, init)) };
  const e = edge(slow);
  const visitor = { headers: { 'CF-Connecting-IP': '198.51.100.30' } };
  const question = { ...BODIES.record, from: MINT, to: MINT + 200_000 };
  const asking = Array.from({ length: 12 }, () => e.ask('record', question, visitor));
  const theRead = () => [...e.runtime.memory.inflight.values()][0];
  await until(() => theRead()?.signals.length === 12 && leftOf(e) < routes.VISITOR_NODE.burst, 'all twelve on one read, which is at the node');
  assert.equal(leftOf(e), routes.VISITOR_NODE.burst - routes.VISITOR_NODE.reserve, 'one reserve, the reader’s; the eleven joiners hold nothing');
  release();
  const done = await Promise.all(asking);
  assert.deepEqual(done.map((response) => response.status), Array(12).fill(200), 'twelve at once, every one answered (eleven join the read on its way)');
  const lines = e.routeLines();
  assert.equal(lines.filter((line) => line.cache === 'coalesced').length, 11);
  const posts = lines.reduce((sum, line) => sum + line.posts, 0);
  // Billed the POSTs the one read made (its unused reserve given back), and nothing for the eleven that joined it.
  const [entry] = e.runtime.memory.nodes.values();
  assert.ok(Math.abs(entry.tokens - (routes.VISITOR_NODE.burst - posts)) < 0.5, `${entry.tokens} left after ${posts} POSTs`);
  assert.deepEqual(Object.keys(entry).sort(), ['at', 'tokens']);
  // Eighteen questions that joined a read that never ends (its own question cut off), left waiting as a visitor who went
  // away leaves them, or as the many people behind one carrier address wait on one slow popular read: they hold nothing
  // of the bill, so that address's next cold read goes to the node at once.
  const wallets = wallet();
  let slowMs = 0;
  const w = edge({ fetch: async (_url, init) => (slowMs > 0 ? await new Promise((done) => setTimeout(done, slowMs)) : undefined, wallets.fetch(RPC_URL, init)) });
  const headers = { headers: { 'CF-Connecting-IP': '198.51.100.31' } };
  assert.equal((await w.ask('automation', { tokenIds: ['12'] }, headers)).status, 200);
  w.clock.time += 60_000; // the bill back to full
  w.runtime.memory.inflight.set('automation#automation|11', { done: new Promise(() => {}), signals: [], started: w.clock.time - 44_000, refused: () => false });
  const stuck = Array.from({ length: 18 }, () => w.ask('automation', { tokenIds: ['11'] }, headers));
  await until(() => w.runtime.memory.inflight.get('automation#automation|11').signals.length === 18, 'the eighteen joined it');
  assert.equal(leftOf(w), routes.VISITOR_NODE.burst, 'the eighteen hold nothing of the bill');
  const next = await Promise.race([w.ask('automation', { tokenIds: ['11', '12'] }, headers), new Promise((resolve) => setTimeout(() => resolve(null), 500))]);
  assert.ok(next, 'answered at once, while they wait');
  assert.equal(next.status, 200);
  // Past their bound (sharedWork.ts), the first to wake reads, on its own reserve, and the other seventeen join that read
  // (the node now slow, so the read is still on its way as they wake): one read, not eighteen.
  slowMs = 200;
  const before = w.routeLines().length;
  assert.deepEqual((await Promise.all(stuck)).map((response) => response.status), Array(18).fill(200));
  const theirs = w.routeLines().slice(before);
  assert.deepEqual(theirs.map((line) => line.cache).sort(), [...Array(17).fill('coalesced'), 'miss']);
  assert.equal(theirs.filter((line) => line.posts > 0).length, 1, 'only the reader asked the node');
});

// RPC fix round 2.1 (finding 1 of the recheck of round 2): the bill was read once per question and charged only as its
// POSTs went, so questions that arrived together all saw a full bill: one visitor held some 146 questions at the node at
// once, each of up to forty POSTs, and kept the isolate's pace (LOCAL_RPC_RATE) from every other visitor. Round 2.2: the
// reserve is taken as each reaches the node (after its cache missed, with no read to join), no longer at the door.
// Changed on purpose 2026-10-02 (rugged97's answer to Q3): a full bill holds thirty reserves of eight.
test('cold questions that arrive together pay their reserves as they reach the node: a full bill has thirty at the node, the rest are answered from the cache alone, and every POST is owed', async () => {
  const chain = historyChain({ head: LOW_HEAD });
  let release;
  const held = new Promise((done) => (release = done));
  const slow = { ...chain.deps, fetch: async (url, init) => (await held, chain.deps.fetch(url, init)) };
  const e = edge(slow);
  const visitor = { headers: { 'CF-Connecting-IP': '198.51.100.60' } };
  const started = e.clock.time;
  // Forty cold questions, each of a key of its own (no read to join), all at once; the history class alone admits 240.
  const cold = (i) => ({ ...BODIES.record, vault: vaultOf(i) });
  const asking = Array.from({ length: 40 }, (_, i) => e.ask('record', cold(i), visitor));
  await new Promise((done) => setTimeout(done, 50));
  // Thirty reserves spent the whole bill as they reached the node; the other ten were refused there at once, sending nothing.
  // Less than one reserve left (the isolate's own pace, LOCAL_RPC_RATE, moved the clock a little as they went).
  assert.ok([...e.runtime.memory.nodes.values()][0].tokens < routes.VISITOR_NODE.reserve, 'thirty reserves of eight');
  const refused = e.routeLines();
  assert.equal(refused.length, 10, 'refused while the thirty are at the node');
  assert.ok(refused.every((line) => line.outcome === 'limited' && line.posts === 0 && line.cache === 'none'));
  release();
  const done = await Promise.all(asking);
  const statuses = done.map((response) => response.status);
  assert.deepEqual([statuses.filter((status) => status === 200).length, statuses.filter((status) => status === 429).length], [30, 10]);
  for (const response of done.filter((one) => one.status === 429)) {
    assert.deepEqual(await response.json(), { v: 1, error: 'rate_limited' });
    assert.equal(response.headers.get('Retry-After'), '1', 'until one reserve is back: 8 POSTs at eight a second');
  }
  // The visitor's POSTs: only the thirty's, each within the invocation's budget, and every one owed (the reserves the
  // thirty did not use given back).
  const lines = e.routeLines();
  const posts = lines.reduce((sum, line) => sum + line.posts, 0);
  assert.equal(posts, e.asked.length);
  assert.ok(lines.every((line) => line.posts <= LOCAL_RPC_POSTS_PER_INVOCATION));
  assert.ok(posts <= 30 * LOCAL_RPC_POSTS_PER_INVOCATION);
  const [entry] = e.runtime.memory.nodes.values();
  const owed = routes.VISITOR_NODE.burst - posts + ((entry.at - started) * routes.VISITOR_NODE.perMinute) / 60_000;
  assert.ok(Math.abs(entry.tokens - owed) < 0.01, `${entry.tokens} left after ${posts} POSTs`);
  // Once they are over, the next goes on, and another visitor was never held by this one's bill.
  e.clock.time += 2_000;
  assert.equal((await e.ask('record', cold(40), visitor)).status, 200);
  assert.equal((await e.ask('record', cold(41), { headers: { 'CF-Connecting-IP': '198.51.100.61' } })).status, 200);
});

// A mint walk goes on under waitUntil after the answer has left: its POSTs are billed as they go too. RPC fix round 2.2
// (the recheck of round 2.1, its low findings on settle and on walks outliving their reserve): the question's reserve
// is held while any work it handed to waitUntil goes on, the walk included, and given back by that chain once it ends,
// long after the question's own frame returned (as when Cloudflare drops the frame of a visitor who left).
test('owned: every node POST is billed to the visitor as it goes, the mint walk’s after the answer included, and the reserve is held until the walk ends', async () => {
  const chain = wallet({ head: 76_000_000 });
  let release;
  const held = new Promise((done) => (release = done));
  const e = edge(deps(chain));
  e.runtime.mintWaitMs = 30;
  // A cold walk of 6.75 million blocks from DominoSetupV1's deployment is two POSTs: the first's reply is held past the
  // answer, so the second goes to the node after the answer has left.
  const upstream = e.runtime.upstream;
  let walked = 0;
  e.runtime.upstream = async (url, init) => {
    const reply = await upstream(url, init);
    if (String(init.body).includes(owned.SETUP_MINTED_TOPIC) && ++walked === 1) await held;
    return reply;
  };
  const visitor = { 'CF-Connecting-IP': '198.51.100.50' };
  const waits = [];
  const response = await routes.answerChainRoute('owned', { request: request('owned', BODIES.owned, { headers: visitor }), env: ENV, waitUntil: (work) => waits.push(work) }, e.runtime);
  assert.equal(response.status, 200);
  const answered = e.asked.length;
  assert.ok(answered < routes.VISITOR_NODE.reserve);
  assert.equal(leftOf(e), routes.VISITOR_NODE.burst - routes.VISITOR_NODE.reserve, 'the POSTs before the answer within the reserve, which is still held while the walk goes on');
  release();
  for (let seen = -1; seen < waits.length; ) {
    seen = waits.length;
    await Promise.all(waits);
  }
  assert.ok(e.asked.length > answered, 'the walk read the node after the answer');
  const [entry] = e.runtime.memory.nodes.values();
  assert.equal(entry.tokens, routes.VISITOR_NODE.burst - e.asked.length, 'every POST billed once, the chain id check’s and the walk’s included, the rest of the reserve given back once the walk ended');
});

test('record: read in fixed units kept per vault, so a range moved by a block reads nothing new', async () => {
  const chain = historyChain();
  const { ask, asked, stored } = edge(chain.deps);
  const first = await (await ask('record', { ...BODIES.record, from: 69_500_000, to: MINT + 200_000 })).json();
  assert.equal(first.executions.length, 1);
  const units = [...stored.keys()].filter((url) => url.includes('/c1/recordUnit/'));
  assert.deepEqual(units.map((url) => url.split('/').at(-1)), ['13', '14'], 'units of 5,000,000 blocks, aligned to block 0');
  assert.match(stored.get(units[0]).headers.get('Cache-Control'), /^max-age=31536000$/, 'a unit below the head’s depth: kept a year');
  // Changed on purpose 2026-10-02 (RPC fix round 2): the newest is kept a week, to be read on from (served as kept for
  // ten seconds), where it was kept ten seconds and then read again from its first block.
  assert.match(stored.get(units[1]).headers.get('Cache-Control'), /^max-age=604800$/, 'the newest: a week, to be read on from');
  const posts = asked.length;
  // Changed on purpose 2026-10-02 (RPC fix round 2): from the factory's block at the lowest; a question from below it
  // reads unit 13 from there, once (the test below).
  for (const [from, to] of [[69_500_001, MINT + 200_000], [69_500_000, MINT + 200_001], [69_499_993, MINT + 199_993], [vaultRecord.VAULT_FIRST_BLOCK, MINT + 60_000]]) {
    const moved = await (await ask('record', { ...BODIES.record, from, to })).json();
    assert.deepEqual(moved.executions, first.executions, `${from}..${to}`);
    assert.deepEqual(moved.transfers, first.transfers, `${from}..${to}`);
  }
  assert.equal(asked.length, posts, 'ranges moved by a few blocks read nothing from the node');
  // Executions outside the range asked are left out of the answer, though the unit holds them.
  const before = await (await ask('record', { ...BODIES.record, from: MINT, to: MINT + 49_999 })).json();
  assert.deepEqual([before.executions, before.transfers], [[], []]);
});

// RPC fix round 2 (the recheck's findings 3 and 8): the newest unit was read again from its first block on almost every
// question (up to 50 node calls for a minute of new blocks), its payments over the whole unit, and unit 13 from 65M.
test('record: the newest unit is read on from where it was kept (its last SAFE_DEPTH blocks again, then the new ones), its payments too; nothing below the factory’s block unless asked', async () => {
  const impact = require('../.test-build/app/src/lib/automationImpact.js');
  assert.equal(vaultRecord.VAULT_FIRST_BLOCK, impact.VAULT_FIRST_BLOCK, 'the page’s floor and the route’s are one');
  const chain = historyChain();
  const reads = [];
  const watched = {
    ...chain.deps,
    fetch: async (url, init) => {
      const call = JSON.parse(init.body);
      if (call.method === 'eth_getLogs') reads.push({ topic: call.params[0].topics[0], from: Number(call.params[0].fromBlock), to: Number(call.params[0].toBlock) });
      return chain.deps.fetch(url, init);
    },
  };
  const { ask, clock } = edge(watched);
  const executions = () => reads.filter((read) => read.topic === vaultRecord.EXECUTION_COMPLETED);
  const payments = () => reads.filter((read) => read.topic === fees.TOPIC.Transfer);
  // The page's early read starts at the factory's block (automationImpact.ts warmVault). Changed on purpose 2026-10-02
  // (rugged97's rule 3: never a log below block 69,249,061): unit 13 is read from DominoSetupV1's deploy block, the
  // record's floor, 9,428 blocks above the factory's.
  assert.equal(vaultRecord.RECORD_FLOOR, 69_249_061);
  const first = await (await ask('record', { ...BODIES.record, from: vaultRecord.VAULT_FIRST_BLOCK, to: HEAD })).json();
  assert.equal(first.executions.length, 1);
  assert.equal(Math.min(...reads.map((read) => read.from)), vaultRecord.RECORD_FLOOR, 'from the floor, never below it');
  // A card that asks from a mint before the floor (a position put under a vault later) reads nothing below it: unit 13
  // is the same kept unit, and nothing is read again.
  reads.length = 0;
  assert.deepEqual((await (await ask('record', { ...BODIES.record, from: 65_000_000, to: HEAD })).json()).executions, first.executions);
  assert.deepEqual(reads, [], 'the kept unit, from the floor');
  reads.length = 0;
  await ask('record', { ...BODIES.record, from: vaultRecord.VAULT_FIRST_BLOCK, to: HEAD - 1 });
  await ask('record', { ...BODIES.record, from: 65_000_000, to: HEAD - 2 });
  assert.deepEqual(reads, [], 'then kept for both');
  // A minute on: the head moved, with a new execution and the fee it paid. The page asks the new blocks only.
  const step = async (head, execution, fee) => {
    clock.time += 60_000;
    const from = chain.head + 1;
    chain.head = head;
    chain.logs.push(executionLog(execution, 11), paymentLog(USDG, execution, fee));
    reads.length = 0;
    return (await ask('record', { ...BODIES.record, from, to: head })).json();
  };
  const second = await step(HEAD + 600, HEAD + 500, 3n);
  assert.deepEqual(second.executions.map((log) => Number(log.blockNumber)), [HEAD + 500]);
  assert.deepEqual(second.transfers.map((log) => BigInt(log.data)), [3n]);
  assert.deepEqual(executions().map((read) => [read.from, read.to]), [[HEAD - fees.SAFE_DEPTH + 1, HEAD + 600]], 'one node call: the kept tail again, then the new blocks');
  assert.equal(Math.min(...payments().map((read) => read.from)), MINT + 50_000, 'the payments from where they were kept (the first execution), not the unit’s first block');
  const third = await step(HEAD + 1_200, HEAD + 1_100, 4n);
  assert.deepEqual(third.executions.map((log) => Number(log.blockNumber)), [HEAD + 1_100]);
  assert.deepEqual(third.transfers.map((log) => BigInt(log.data)), [4n]);
  assert.deepEqual(executions().map((read) => [read.from, read.to]), [[HEAD + 600 - fees.SAFE_DEPTH + 1, HEAD + 1_200]]);
  assert.deepEqual(payments().map((read) => [read.from, read.to]), [[HEAD + 500 - fees.SAFE_DEPTH + 1, HEAD + 1_100]], 'one node call for the payments too');
  // The whole record, asked again: the units kept, read on, give the same as one read from scratch.
  clock.time += 60_000;
  const whole = await (await ask('record', { ...BODIES.record, from: 65_000_000, to: HEAD + 1_200 })).json();
  const fresh = await (await edge(chain.deps).ask('record', { ...BODIES.record, from: 65_000_000, to: HEAD + 1_200 })).json();
  assert.deepEqual(whole, fresh);
  assert.deepEqual(whole.executions.map((log) => Number(log.blockNumber)), [MINT + 50_000, HEAD + 500, HEAD + 1_100]);
});

// Finding 6: a body without Content-Length (chunked) is read no further than the route's limit.
test('a chunked body past a plain route’s limit is refused 413 without being read whole', async () => {
  for (const [name, limit] of [['automation', 8192], ['owned', 512]]) {
    let pulled = 0;
    const chunk = new TextEncoder().encode('x'.repeat(1024));
    const stream = new ReadableStream({
      pull(controller) {
        if (pulled >= 1024 * 1024) return controller.close();
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const chunked = new Request(`${ORIGIN}${PATHS[name]}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: stream, duplex: 'half' });
    assert.equal(chunked.headers.get('Content-Length'), null);
    const response = await routes.answerChainRoute(name, { request: chunked, env: ENV }, edge(deps(wallet())).runtime);
    assert.deepEqual([response.status, await response.json()], [413, { error: 'request_too_large' }], name);
    assert.ok(pulled <= limit + 4 * 1024, `${name}: ${pulled} bytes read, not the whole megabyte`);
  }
});

// Finding 12: the list does not wait for a slow mint walk; finding 13: a walk capped at MAX_POSITIONS is kept.
test('owned: a slow mint walk does not hold the list: it answers with the mints kept before, and the walk goes on and keeps its result for the next', async () => {
  const chain = wallet();
  let release;
  const held = new Promise((done) => (release = done));
  const slow = { fetch: async (url, init) => (String(init.body).includes(owned.SETUP_MINTED_TOPIC) ? (await held, chain.fetch(RPC_URL, init)) : chain.fetch(RPC_URL, init)) };
  const e = edge(slow);
  e.runtime.mintWaitMs = 30;
  const { response, kept } = await withWaitUntil(e, 'owned', BODIES.owned);
  const value = await response.json();
  assert.deepEqual(value.answer.positions.map((p) => p.tokenId), ['12', '11'], 'the list, at once');
  assert.deepEqual(value.mints, [], 'with the mints kept before (none yet)');
  release();
  for (let seen = -1; seen < kept.length; ) {
    seen = kept.length;
    await Promise.all(kept);
  }
  const key = await ownedMints.mintsKey(ORIGIN, OWNER);
  assert.ok(e.stored.has(key), 'the walk went on and kept what it found');
  e.clock.time += 41_000;
  const next = await (await e.ask('owned')).json();
  assert.deepEqual(next.mints.map((mint) => mint.id), ['12', '11'], 'the next answer carries the mints');
  // A warm walk (one POST) is waited for: its mints come in the same answer.
  const warm = edge(deps(chain));
  const quick = await withWaitUntil(warm, 'owned', BODIES.owned);
  assert.deepEqual((await quick.response.json()).mints.map((mint) => mint.id), ['12', '11']);
});

test('owned: a walk capped at a hundred positions is kept with its newest hundred, and the next reads only from its block', async () => {
  const positions = Array.from({ length: 101 }, (_, i) => ({ tokenId: 2000 + i, holder: OWNER, key: KEY, tickLower: -600, tickUpper: 600, liquidity: 10n ** 9n, unclaimed: [0n, 0n], mintBlock: 70_000_000 + i * 1_000 }));
  const chain = browserChain({ positions, tokens: { [USDG]: { symbol: 'USDG', decimals: 6 }, [TOKEN]: { symbol: 'UFG', decimals: 18 } } });
  const e = edge(deps(chain));
  const first = await (await e.ask('owned')).json();
  assert.equal(first.capped, true);
  const key = await ownedMints.mintsKey(ORIGIN, OWNER);
  assert.ok(e.stored.has(key), 'kept, though capped');
  const keptMints = ownedMints.keptMintsOf(await e.stored.get(key).clone().json());
  assert.equal(keptMints.ids.length, 100);
  assert.equal(keptMints.ids[0], '2100', 'the newest first');
  assert.ok(!keptMints.ids.includes('2000'), 'the oldest past the cap left out');
  // The list itself is capped at the same hundred (DominoSetupV1's state), each with its mint kept: the next scan makes no
  // walk (RPC fix round 2). One whose mint is not kept: the walk reads from the kept block only, not the deployment.
  e.clock.time += 41_000;
  let mark = chain.log.length;
  await e.ask('owned');
  assert.deepEqual(chain.log.slice(mark).filter((call) => call.method === 'eth_getLogs'), []);
  e.stored.set(key, new Response(JSON.stringify({ ...keptMints, mints: keptMints.mints.slice(1) }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=604800' } }));
  e.clock.time += 41_000;
  mark = chain.log.length;
  await e.ask('owned');
  const walked = chain.log.slice(mark).filter((call) => call.method === 'eth_getLogs');
  assert.deepEqual(walked.map((call) => [Number(call.params[0].fromBlock), Number(call.params[0].toBlock)]), [[chain.head - walletPositions.REREAD_BLOCKS + 1, chain.head]], 'from the kept block only, not the deployment');
});

// Finding 14, changed on purpose 2026-10-02 (RPC fix round 2): the list's figures at most one 30 s refresh old, as the
// owner approved, with the node's load bounded by the entry every tab of the owner shares and a refresh that reads no log.
test('owned: kept a little less than the list’s refresh, so each refresh of an open list reaches the node, while every other tab of the owner takes the kept answer; a refresh reads no log', async () => {
  const page = require('../.test-build/app/src/lib/walletPositions.js');
  assert.equal(owned.CACHE_SECONDS, 25);
  assert.ok(owned.CACHE_SECONDS * 1000 + 5_000 <= page.REFRESH_MS, 'a refresh, its round trips aside, never takes the answer kept at the one before');
  assert.ok(page.CREATED_REASK_MS.every((ms) => ms > owned.FRESH_AFTER_MS), 'the re-asks for a position made here each reach the node (finding 10)');
  const chain = wallet();
  const { ask, clock, routeLines } = edge(deps(chain));
  const scans = () => chain.log.filter((call) => call.method === 'eth_call' && call.params[1] === 'latest').length;
  await ask('owned');
  clock.time += 10_000;
  await ask('owned');
  assert.deepEqual([scans(), routeLines().at(-1).cache], [1, 'hit'], 'another tab 10 s later: the kept answer');
  clock.time += 20_000;
  const mark = chain.log.length;
  await ask('owned');
  assert.deepEqual([scans(), routeLines().at(-1).cache], [2, 'miss'], 'the first tab’s refresh, 30 s after its read: the node');
  assert.deepEqual(chain.log.slice(mark).filter((call) => call.method === 'eth_getLogs'), [], 'every listed position’s mint is kept: no walk');
  assert.ok(routeLines().at(-1).posts <= 4, `a refresh costs ${routeLines().at(-1).posts} POSTs`);
});

// Finding 17: Create position's largest batch is ten calls; the route and the transport take twelve.
test('simulate: up to twelve calls, the most Create position’s largest batch needs with room; thirteen are refused', async () => {
  const simulate = require('../.test-build/app/functions/_lib/simulate.js');
  assert.equal(simulate.SIMULATE_CALLS, 12);
  const call = { to: USDG, data: '0x095ea7b3', value: '0x0' };
  const on = edge(deps(wallet()), { env: SIMULATING, simulator: (params) => [{ calls: params[0].blockStateCalls[0].calls.map(() => ({ status: '0x1', gasUsed: '0x5208' })) }] });
  const twelve = await on.ask('simulate', { owner: OWNER, calls: Array(12).fill(call) });
  assert.equal(twelve.status, 200);
  assert.equal((await twelve.json()).result[0].calls.length, 12);
  assert.equal((await on.ask('simulate', { owner: OWNER, calls: Array(13).fill(call) })).status, 400);
});

// Review of rugged97's rules, finding 15: a caller's calls ran to the node's own gas cap.
test('simulate: each call’s gas is its share of thirty million, at most fifteen million: the page’s largest batches fit, a caller’s twelve calls cannot run to the node’s cap', () => {
  const simulate = require('../.test-build/app/functions/_lib/simulate.js');
  assert.deepEqual([simulate.SIMULATE_CALL_GAS, simulate.SIMULATE_TOTAL_GAS], [15_000_000, 30_000_000]);
  assert.deepEqual([1, 2, 3, 10, 12].map(simulate.simulateGas), [15_000_000, 15_000_000, 10_000_000, 3_000_000, 2_500_000]);
  const envelope = simulate.simulateEnvelope({ owner: OWNER, calls: Array(12).fill({ to: USDG, data: '0x', value: '0x0' }) });
  const calls = envelope.params[0].blockStateCalls[0].calls;
  assert.ok(calls.every((call) => call.gas === '0x2625a0'));
  assert.ok(calls.reduce((sum, call) => sum + Number(call.gas), 0) <= simulate.SIMULATE_TOTAL_GAS);
});
