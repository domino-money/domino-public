/**
 * The page's fallbacks for the chain's own RPC (2026-09-28).
 *
 * The DNS of Vivo, one of Brazil's largest ISPs, answers NXDOMAIN for every host under chain.robinhood.com: on that
 * network the browser meets net::ERR_NAME_NOT_RESOLVED for the RPC, and Your positions "couldn't be read", a position's
 * fees and New position's chain reads failed. The owner: no backend change; the page itself must fall back, and look
 * the same. Here, the router (src/lib/chain/failover.ts) over the registry (src/lib/chain/endpoints.ts), first with a
 * fake runtime and clock, then through the page's own runtime (src/lib/chain/browser.ts) with a stubbed fetch: the
 * three fallbacks answer as they were measured that day (tests/support/fallbacks.mjs), over the tests' own chains.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { KEY, OWNER, fakeChain, nft, opId, wallet as walletScan } from './owned-chain.mjs';
import { browserChain } from './support/browser-chain.mjs';
import { DRPC, FALLBACK_URLS, ORDOFI, PUBLICNODE, fallbackReply } from './support/fallbacks.mjs';

const require = createRequire(import.meta.url);
const owned = require('../.test-build/app/functions/_lib/owned.js');
const relay = require('../.test-build/app/functions/_lib/fees.js');
const endpoints = require('../.test-build/app/src/lib/chain/endpoints.js');
const router = require('../.test-build/app/src/lib/chain/failover.js');
const browser = require('../.test-build/app/src/lib/chain/browser.js');
const walletPositions = require('../.test-build/app/src/lib/walletPositions.js');

const RPC = owned.RPC_URL;
const HEAD = 74_912_000;
const hex = (n) => `0x${n.toString(16)}`;
const body = (method, params = [], id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const hostOf = (url) => new URL(url).hostname.split('.').slice(-2, -1)[0];
const ZERO_WORD = `0x${'00'.repeat(32)}`;

/** A small chain's own answer to a POST body: its head, a word for any call, a log every 50 blocks, a header per block. */
const tiny = (head = HEAD) => async (text) => {
  const value = JSON.parse(text);
  const one = (call) => {
    if (call.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: call.id, result: hex(head) };
    if (call.method === 'eth_getBlockByNumber') return { jsonrpc: '2.0', id: call.id, result: { number: call.params[0], timestamp: '0x1' } };
    if (call.method === 'eth_simulateV1') return { jsonrpc: '2.0', id: call.id, result: [{ calls: [{ status: '0x1' }] }] };
    if (call.method === 'eth_getLogs') {
      // DominoSetupV1's logs: one every 50 blocks (a shape only the windows' test reads); none anywhere else.
      const [from, to] = [Number(call.params[0].fromBlock), Number(call.params[0].toBlock)];
      const logs = [];
      if (call.params[0].address === owned.SETUP_CONTRACT) for (let block = Math.ceil(from / 50) * 50; block <= to; block += 50) logs.push({ blockNumber: hex(block) });
      return { jsonrpc: '2.0', id: call.id, result: logs };
    }
    return { jsonrpc: '2.0', id: call.id, result: ZERO_WORD };
  };
  return new Response(JSON.stringify(Array.isArray(value) ? value.map(one) : one(value)), { status: 200 });
};

/**
 * A router over a fake runtime: `primary` is 'dns' (every request to it fails at the network, its probe too), 'hidden'
 * (its replies are a 429 the browser cannot read: a TypeError, but its no-cors probe is answered) or 'up'. `sent` lists
 * every request as "host method" ('probe' for the no-cors GET), `log` every call a fallback got. `answer` (host, call)
 * may answer a fallback's request itself (a gateway's 502, a WAF's page) instead of the measured fallback.
 */
function world({ primary = 'dns', head = HEAD, busy = new Set(), chainId, options, answer } = {}) {
  const w = { primary, clock: 1_000_000, sent: [], log: [], busy };
  const own = tiny(head);
  const runtime = {
    now: () => w.clock,
    pause: async (ms) => {
      w.clock += ms;
    },
    offline: () => false,
    async send(url, init) {
      const calls = init.body ? JSON.parse(init.body) : null;
      w.sent.push(`${hostOf(url)} ${init.mode === 'no-cors' ? 'probe' : (Array.isArray(calls) ? calls.map((call) => call.method).join('+') : calls.method)}`);
      if (url === RPC) {
        if (w.primary === 'dns') throw new TypeError('Failed to fetch');
        if (init.mode === 'no-cors') return new Response(null, { status: 200 });
        if (w.primary === 'hidden') throw new TypeError('Failed to fetch');
        return own(init.body);
      }
      assert.ok(FALLBACK_URLS.includes(url), `only the registry's endpoints: ${url}`);
      const mine = answer?.(hostOf(url), calls);
      if (mine) {
        w.log.push({ host: url, method: calls.method, params: calls.params });
        return mine;
      }
      return fallbackReply(url, init.body, { own, head, log: w.log, busy, ...(chainId === undefined ? {} : { chainId }) });
    },
  };
  w.router = router.failover(runtime, options);
  w.post = (text, session) => w.router.send({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text }, session);
  return w;
}
const result = async (response) => (await response.json()).result;

test('the registry: the chain’s own RPC first, three measured fallbacks, and the order each need asks them in', () => {
  assert.equal(endpoints.PRIMARY.url, RPC, 'the routes’ own pin');
  assert.deepEqual(endpoints.FALLBACKS.map((e) => e.url), [PUBLICNODE, ORDOFI, DRPC]);
  const names = (list) => list.map((e) => hostOf(e.url));
  assert.deepEqual(Object.fromEntries(Object.entries(endpoints.ORDER).map(([need, list]) => [need, names(list)])), {
    latest: ['publicnode', 'drpc', 'ordofi'],
    state: ['publicnode', 'ordofi'],
    archive: ['ordofi'],
    headers: ['drpc', 'publicnode', 'ordofi'],
    simulate: ['publicnode', 'drpc'],
    logs: ['publicnode', 'ordofi', 'drpc'],
  });
  // What each was measured to serve, from a Vivo line (endpoints.ts): pruned state, a slow archive, a narrow window.
  assert.deepEqual([endpoints.PUBLICNODE.stateDepth, endpoints.ORDOFI.stateDepth, endpoints.DRPC.stateDepth], [24, Number.POSITIVE_INFINITY, 0]);
  assert.deepEqual([endpoints.ORDOFI.logWindow, endpoints.DRPC.logWindow, endpoints.DRPC.logWindows], [5_000, 100, 8]);
  assert.deepEqual([endpoints.ORDOFI.simulate, endpoints.ORDOFI.inFlight], [false, 1], 'no simulation at ordofi, one request at a time');
  for (const endpoint of endpoints.FALLBACKS) assert.ok(endpoint.perMinute <= 120 && endpoint.gapMs >= 100, `${endpoint.url} is never hammered`);
});

test('the chain’s own RPC first, while it answers: nothing else is asked', async () => {
  const w = world({ primary: 'up' });
  assert.equal(await result(await w.post(body('eth_blockNumber'))), hex(HEAD));
  assert.deepEqual(w.sent, ['robinhood eth_blockNumber']);
  assert.equal(w.router.primaryUp(), true);
});

test('a name that does not resolve: its probe fails too, the primary is left alone, and the call is answered by a fallback that said it is chain 4663', async () => {
  const w = world({ primary: 'dns' });
  assert.equal(await result(await w.post(body('eth_blockNumber'))), hex(HEAD));
  assert.deepEqual(w.sent, ['robinhood eth_blockNumber', 'robinhood probe', 'publicnode eth_chainId', 'publicnode eth_blockNumber'], 'the call, the probe, the chain id, the call again');
  assert.equal(w.router.primaryUp(), false);
  // 2026-09-28 (review): a short first period (a blip is not an outage), doubled at each probe it does not answer.
  assert.equal(w.router.state().primary.nextProbe, 1_000_000 + router.FIRST_DOWN_MS, 'left alone for FIRST_DOWN_MS from its failure');
  // Later calls go straight to the fallbacks: no second try of the primary, no second chain id.
  w.sent.length = 0;
  assert.equal(await result(await w.post(body('eth_call', [{ to: owned.MULTICALL3, data: '0x' }, 'latest']))), ZERO_WORD);
  assert.deepEqual(w.sent, ['publicnode eth_call']);
});

test('a refusal the browser cannot read (the RPC’s 429: a TypeError) is not a name that does not resolve: the probe reaches it, the caller gets the TypeError, and no fallback is asked', async () => {
  const w = world({ primary: 'hidden' });
  await assert.rejects(w.post(body('eth_blockNumber')), TypeError);
  assert.deepEqual(w.sent, ['robinhood eth_blockNumber', 'robinhood probe']);
  assert.equal(w.router.primaryUp(), true, 'still the primary');
  // Within REACHED_MS, the next TypeError is taken for the same refusal without another probe.
  w.clock += router.REACHED_MS - 1;
  await assert.rejects(w.post(body('eth_blockNumber')), TypeError);
  assert.deepEqual(w.sent.slice(2), ['robinhood eth_blockNumber']);
  assert.equal(w.log.length, 0, 'no fallback was asked anything');
  // Through the page's runtime: asked once more, then that 429, as before (tests/wallet-positions.test.mjs).
});

test('back to the chain’s own RPC: a quiet probe once its down period has passed, twice as long at each probe it does not answer, and every call after its answer goes to it', async () => {
  const w = world({ primary: 'dns' });
  await w.post(body('eth_blockNumber'));
  // Not before its period (FIRST_DOWN_MS): no probe.
  w.clock = w.router.state().primary.nextProbe - 1;
  w.sent.length = 0;
  await w.post(body('eth_blockNumber'));
  assert.deepEqual(w.sent, ['publicnode eth_blockNumber']);
  assert.equal(w.router.probing(), null);
  // Still unreachable then: the probe finds it so, and the next period is twice as long, up to DOWN_MS.
  w.clock += 1;
  w.sent.length = 0;
  await w.post(body('eth_blockNumber'));
  await w.router.probing();
  assert.deepEqual(w.sent.sort(), ['publicnode eth_blockNumber', 'robinhood eth_blockNumber', 'robinhood probe']);
  assert.equal(w.router.primaryUp(), false);
  assert.equal(w.router.state().primary.downFor, 2 * router.FIRST_DOWN_MS);
  for (let i = 0; i < 6; i++) {
    w.clock = w.router.state().primary.nextProbe;
    await w.post(body('eth_blockNumber'));
    await w.router.probing();
  }
  assert.equal(w.router.state().primary.downFor, router.DOWN_MS, 'never longer than DOWN_MS');
  // Back: the call that finds the probe due still goes to the fallback; once the probe answered, the primary has them all.
  w.clock += router.DOWN_MS;
  w.primary = 'up';
  w.sent.length = 0;
  await w.post(body('eth_blockNumber'));
  await w.router.probing();
  assert.equal(w.router.primaryUp(), true);
  await w.post(body('eth_getBlockByNumber', [hex(HEAD), false]));
  assert.deepEqual(w.sent, ['robinhood eth_blockNumber', 'publicnode eth_blockNumber', 'robinhood eth_getBlockByNumber'], 'the quiet probe is one eth_blockNumber, and the call that found it due went to the fallback');
});

test('a range of logs wider than a fallback’s window is asked window by window, in order, as one reply; one it refuses teaches a narrower window; one past its windows is not asked at all', async () => {
  const drpcOnly = (endpoint) => ({ fallbacks: [endpoint], order: Object.fromEntries(Object.keys(endpoints.ORDER).map((need) => [need, [endpoint]])) });
  const w = world({ primary: 'dns', options: drpcOnly(endpoints.DRPC) });
  const from = 74_000_000;
  const logs = await result(await w.post(body('eth_getLogs', [{ address: owned.SETUP_CONTRACT, fromBlock: hex(from), toBlock: hex(from + 499), topics: [owned.SETUP_MINTED_TOPIC] }], 7)));
  const ranges = w.log.filter((call) => call.method === 'eth_getLogs').map((call) => [Number(call.params[0].fromBlock) - from, Number(call.params[0].toBlock) - from]);
  assert.deepEqual(ranges, [[0, 99], [100, 199], [200, 299], [300, 399], [400, 499]], 'five windows of 100 blocks, oldest first');
  assert.deepEqual(logs.map((log) => Number(log.blockNumber) - from), [0, 50, 100, 150, 200, 250, 300, 350, 400, 450], 'every window’s logs, in chain order');
  assert.ok(w.log.filter((call) => call.method === 'eth_getLogs').every((call) => call.params[0].address === owned.SETUP_CONTRACT && call.params[0].topics[0] === owned.SETUP_MINTED_TOPIC), 'the same filter in every window');
  // Past its eight windows: answered as not served, with no request.
  w.log.length = 0;
  const wide = await (await w.post(body('eth_getLogs', [{ address: owned.SETUP_CONTRACT, fromBlock: hex(from), toBlock: hex(from + 900) }], 8))).json();
  assert.deepEqual([wide.id, wide.error.message, w.log.length], [8, 'not served by any reachable endpoint', 0]);
  assert.equal(owned.classifyRpcError(wide.error.code, wide.error.message), 'fatal', 'a failure to the chain code, not a rate limit and not a range to split');
  // A fallback thought to serve 200 blocks at once refuses them (dRPC’s own words): its window is learned, the call asked again.
  const optimistic = world({ primary: 'dns', options: drpcOnly({ ...endpoints.DRPC, logWindow: 200 }) });
  await result(await optimistic.post(body('eth_getLogs', [{ address: owned.SETUP_CONTRACT, fromBlock: hex(from), toBlock: hex(from + 399) }])));
  const asked = optimistic.log.filter((call) => call.method === 'eth_getLogs').map((call) => Number(call.params[0].toBlock) - Number(call.params[0].fromBlock) + 1);
  assert.deepEqual(asked, [200, 100, 100, 100, 100], 'refused at 200 blocks, then four windows of 100');
  assert.equal(optimistic.router.state().fallbacks[DRPC].window, 100);
});

test('“the network is busy” is a rate: that fallback rests, twice as long at each refusal in a row, the call goes to the next that can serve it, and none left is a 429 of the router’s own', async () => {
  const w = world({ primary: 'dns', busy: new Set([ORDOFI]) });
  await w.post(body('eth_blockNumber'));
  // An old block's state: only the archive serves it.
  const old = body('eth_call', [{ to: owned.MULTICALL3, data: '0x' }, hex(HEAD - 1_000_000)]);
  const first = await w.post(old);
  assert.equal(first.status, 429);
  assert.deepEqual(w.log.filter((call) => call.host === ORDOFI).map((call) => call.method), ['eth_chainId', 'eth_call']);
  const rested = w.router.state().fallbacks[ORDOFI];
  assert.deepEqual([rested.rests, rested.restUntil - w.clock], [1, router.REST_MS]);
  // While it rests, nothing is sent to it.
  const count = w.log.length;
  assert.equal((await w.post(old)).status, 429);
  assert.equal(w.log.length, count);
  w.clock += router.REST_MS;
  assert.equal((await w.post(old)).status, 429);
  assert.equal(w.router.state().fallbacks[ORDOFI].restUntil - w.clock, 2 * router.REST_MS, 'the second rest in a row is twice as long');
  // A call another fallback serves goes there meanwhile.
  w.busy.add(PUBLICNODE);
  w.log.length = 0;
  assert.equal(await result(await w.post(body('eth_blockNumber'))), hex(HEAD));
  assert.deepEqual(w.log.map((call) => `${hostOf(call.host)} ${call.method}`), ['publicnode eth_blockNumber', 'drpc eth_chainId', 'drpc eth_blockNumber']);
  // Once it answers, its rests start over.
  w.busy.clear();
  w.clock += 2 * router.REST_MS;
  assert.equal(await result(await w.post(old)), ZERO_WORD);
  assert.equal(w.router.state().fallbacks[ORDOFI].rests, 0);
});

test('a fallback that says it is another chain is never asked again; one that says nothing of its chain is left alone for a while', async () => {
  const other = world({ primary: 'dns', chainId: '0x1' });
  await assert.rejects(other.post(body('eth_blockNumber')), TypeError, 'nothing reachable is this chain');
  assert.deepEqual(other.log.map((call) => call.method), ['eth_chainId', 'eth_chainId', 'eth_chainId'], 'each asked its chain id, and nothing else');
  assert.ok(Object.values(other.router.state().fallbacks).every((f) => f.distrusted));
  other.log.length = 0;
  other.clock += router.TRUST_MS * 2;
  await assert.rejects(other.post(body('eth_blockNumber')), TypeError);
  assert.equal(other.log.length, 0, 'never asked again');
  const silent = world({ primary: 'dns', chainId: null });
  await assert.rejects(silent.post(body('eth_blockNumber')), TypeError);
  assert.ok(Object.values(silent.router.state().fallbacks).every((f) => !f.distrusted && f.downUntil === silent.clock + router.FALLBACK_DOWN_MS));
});

// --- 2026-09-28, review: a blip is not an outage, and a failing fallback is left alone ------------------------------------

test('a blip is not an outage: a call only the chain’s own RPC serves probes it at once, at most every NEEDED_PROBE_MS, and goes to it once it answers', async () => {
  // A fees epoch's pool logs: 3.6 million blocks, which no fallback serves.
  const epoch = body('eth_getLogs', [{ address: owned.SETUP_CONTRACT, fromBlock: hex(HEAD - 3_600_000), toBlock: hex(HEAD) }], 5);
  const w = world({ primary: 'dns' });
  const start = w.clock;
  await w.post(body('eth_blockNumber'));
  assert.equal(w.router.primaryUp(), false, 'the blip: its call and its reach probe both failed');
  w.primary = 'up';
  // Within NEEDED_PROBE_MS of that failure (its last probe): answered as not served, with no request at all.
  w.clock = start + 2_000;
  w.sent.length = 0;
  const early = await (await w.post(epoch)).json();
  assert.deepEqual([early.id, early.error?.message, w.sent], [5, 'not served by any reachable endpoint', []]);
  // Past it, before the quiet probe is due: the probe, then the call itself, at the RPC; and every later call there.
  w.clock = start + router.NEEDED_PROBE_MS;
  assert.ok(w.clock < w.router.state().primary.nextProbe);
  w.sent.length = 0;
  assert.ok(Array.isArray(await result(await w.post(epoch))));
  assert.deepEqual(w.sent, ['robinhood eth_blockNumber', 'robinhood eth_getLogs']);
  assert.equal(w.router.primaryUp(), true);
  // Still unreachable: one probe per NEEDED_PROBE_MS however many such calls, each answered as not served, and the
  // failed probe doubles the down period.
  const down = world({ primary: 'dns' });
  await down.post(body('eth_blockNumber'));
  down.clock += router.NEEDED_PROBE_MS;
  down.sent.length = 0;
  for (let i = 0; i < 5; i++) {
    assert.equal((await (await down.post(epoch)).json()).error.message, 'not served by any reachable endpoint');
    down.clock += 1_000;
  }
  assert.deepEqual(down.sent, ['robinhood eth_blockNumber', 'robinhood probe'], 'one probe for five calls');
  assert.equal(down.router.state().primary.downFor, 2 * router.FIRST_DOWN_MS);
  // Nothing else reachable at all (every fallback refuses the page): any call, the same way.
  const alone = world({ primary: 'dns', answer: () => new Response('<html>Access denied</html>', { status: 403 }) });
  await assert.rejects(alone.post(body('eth_blockNumber')), TypeError);
  alone.primary = 'up';
  alone.clock += router.NEEDED_PROBE_MS;
  assert.equal(await result(await alone.post(body('eth_blockNumber'))), hex(HEAD));
  assert.equal(alone.router.primaryUp(), true);
});

test('a fallback that fails its chain-id check in any other way (a WAF’s 403 page, a method it refuses, a key it wants) is left alone as an unreachable one is, twice as long each time in a row: asked at most once per period, never at every call', async () => {
  const refusals = {
    'a WAF’s 403 page': () => new Response('<html>Attention Required</html>', { status: 403, headers: { 'Content-Type': 'text/html' } }),
    'a method it refuses': (call) => new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'the method eth_chainId does not exist/is not available' } }), { status: 200 }),
    'a key it wants': (call) => new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'API key required' } }), { status: 401 }),
  };
  for (const [label, refuse] of Object.entries(refusals)) {
    const w = world({ primary: 'dns', answer: (host, call) => (host === 'publicnode' ? refuse(call) : undefined) });
    const start = w.clock;
    for (let i = 0; i < 30; i++) {
      assert.equal(await result(await w.post(body('eth_blockNumber'))), hex(HEAD), label);
      w.clock += 1_000;
    }
    const asked = () => w.log.filter((call) => call.host === PUBLICNODE).length;
    assert.equal(asked(), 1, `${label}: publicnode asked its chain once in 30 calls`);
    assert.equal(w.log.filter((call) => call.host === DRPC && call.method === 'eth_blockNumber').length, 30, `${label}: each call answered by the next`);
    assert.equal(w.router.state().fallbacks[PUBLICNODE].downUntil, start + router.FALLBACK_DOWN_MS, label);
    // Its period over: asked once more, then left alone twice as long.
    w.clock = start + router.FALLBACK_DOWN_MS;
    const at = w.clock;
    await w.post(body('eth_blockNumber'));
    assert.equal(asked(), 2, label);
    assert.equal(w.router.state().fallbacks[PUBLICNODE].downUntil, at + 2 * router.FALLBACK_DOWN_MS, label);
  }
});

test('a fallback’s reply that is not JSON-RPC with a 2xx (a gateway’s 502 or 504, an HTML page) is that endpoint failing: the read is answered by the next that serves it, and the failing one is left alone; a revert is the call’s own answer', async () => {
  const failures = {
    'a 502': () => new Response('bad gateway', { status: 502 }),
    'a 504': () => new Response('', { status: 504 }),
    'an HTML 200': () => new Response('<html><body>Just a moment...</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
  };
  const read = body('eth_call', [{ to: owned.MULTICALL3, data: '0x' }, hex(HEAD)]);
  const where = (w) => w.log.map((call) => `${hostOf(call.host)} ${call.method}`);
  for (const [label, fail] of Object.entries(failures)) {
    let failedAt = null;
    const w = world({ primary: 'dns', answer: (host, call) => (host === 'publicnode' && call.method === 'eth_call' ? ((failedAt = w.clock), fail()) : undefined) });
    await w.post(body('eth_blockNumber'));
    w.log.length = 0;
    const reply = await w.post(read);
    assert.deepEqual([reply.status, await result(reply)], [200, ZERO_WORD], `${label}: the chain code gets the state, not the failure`);
    assert.deepEqual(where(w), ['publicnode eth_call', 'ordofi eth_chainId', 'ordofi eth_call'], label);
    assert.equal(w.router.state().fallbacks[PUBLICNODE].downUntil, failedAt + router.FALLBACK_DOWN_MS, label);
    // The next read goes straight to the next one.
    w.log.length = 0;
    assert.equal(await result(await w.post(read)), ZERO_WORD);
    assert.deepEqual(where(w), ['ordofi eth_call'], label);
  }
  const reverted = world({ primary: 'dns', answer: (host, call) => (call.method === 'eth_call' ? new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: 3, message: 'execution reverted: pool does not exist' } }), { status: 200 }) : undefined) });
  await reverted.post(body('eth_blockNumber'));
  reverted.log.length = 0;
  assert.equal((await (await reverted.post(read)).json()).error.message, 'execution reverted: pool does not exist');
  assert.deepEqual(where(reverted), ['publicnode eth_call'], 'to the chain code as it is');
  assert.equal(reverted.router.state().fallbacks[PUBLICNODE].downUntil, 0, 'and nothing is left alone');
});

test('each fallback keeps its own budget (a gap between requests, a most per minute), and a read takes no more requests than its chain code’s cap', async () => {
  const w = world({ primary: 'dns' });
  await w.post(body('eth_blockNumber'));
  const before = w.clock;
  await w.post(body('eth_blockNumber'));
  assert.ok(w.clock - before >= endpoints.PUBLICNODE.gapMs, `the second waited its gap (${w.clock - before} ms)`);
  // A minute's worth at publicnode: the next goes to dRPC rather than wait past BUDGET_WAIT_MS.
  const state = w.router.state().fallbacks[PUBLICNODE];
  for (let i = state.starts.length; i < endpoints.PUBLICNODE.perMinute; i++) await w.post(body('eth_blockNumber'));
  assert.equal(w.router.state().fallbacks[PUBLICNODE].starts.length, endpoints.PUBLICNODE.perMinute);
  w.log.length = 0;
  await w.post(body('eth_blockNumber'));
  assert.deepEqual(w.log.map((call) => `${hostOf(call.host)} ${call.method}`), ['drpc eth_chainId', 'drpc eth_blockNumber']);
  // A read's own cap: three requests, then the router's refusal, which the chain code takes as a failure.
  const session = w.router.session(3);
  for (let i = 0; i < 3; i++) await w.post(body('eth_blockNumber'), session);
  const refused = await (await w.post(body('eth_blockNumber'), session)).json();
  assert.equal(refused.error.message, 'fallback budget used up');
  assert.equal(owned.classifyRpcError(refused.error.code, refused.error.message), 'fatal');
});

test('what a call needs decides where it goes: the head anywhere, a block near the head where its state is kept, an old one at the archive, headers, a simulation never at ordofi, logs where one call covers them', async () => {
  const w = world({ primary: 'dns' });
  const where = async (text, session) => {
    w.log.length = 0;
    const reply = await w.post(text, session);
    return [reply.status, [...new Set(w.log.filter((call) => call.method !== 'eth_chainId').map((call) => hostOf(call.host)))].join(',')];
  };
  assert.deepEqual(await where(body('eth_blockNumber')), [200, 'publicnode']);
  assert.deepEqual(await where(body('eth_call', [{ to: owned.MULTICALL3, data: '0x' }, hex(HEAD)])), [200, 'publicnode'], 'the head just read');
  assert.deepEqual(await where(body('eth_call', [{ to: owned.MULTICALL3, data: '0x' }, hex(HEAD - 1_000)])), [200, 'ordofi'], 'a thousand blocks back');
  assert.deepEqual(await where(JSON.stringify([1, 2].map((id) => ({ jsonrpc: '2.0', id, method: 'eth_getBlockByNumber', params: [hex(HEAD - id * 1_000_000), false] })))), [200, 'drpc'], 'a batch of headers');
  assert.deepEqual(await where(body('eth_simulateV1', [{ blockStateCalls: [] }, 'latest'])), [200, 'publicnode']);
  w.busy.add(PUBLICNODE);
  assert.deepEqual(await where(body('eth_simulateV1', [{ blockStateCalls: [] }, 'latest'])), [200, 'publicnode,drpc']);
  w.busy.add(DRPC);
  w.clock += router.MAX_REST_MS;
  assert.deepEqual(await where(body('eth_simulateV1', [{ blockStateCalls: [] }, 'latest'])), [429, 'publicnode,drpc'], 'never ordofi, which has no simulation');
  w.busy.clear();
  w.clock += router.MAX_REST_MS;
  assert.deepEqual(await where(body('eth_getLogs', [{ fromBlock: hex(HEAD - 3_000), toBlock: hex(HEAD) }])), [200, 'ordofi'], '3,000 blocks in one call');
  const hour = await where(body('eth_getLogs', [{ fromBlock: hex(HEAD - 36_000), toBlock: hex(HEAD) }]));
  assert.deepEqual(hour, [200, ''], 'an hour of logs: no fallback serves it, and none is asked');
});

// --- Through the page's own runtime (src/lib/chain/browser.ts), the chain's own RPC unreachable ------------------------

/**
 * globalThis.fetch for `run`: the chain's own RPC behind a name that does not resolve, the fallbacks over `own`;
 * `failing` (url, body) may answer a fallback's request itself (a gateway's 502).
 */
async function unreachablePrimary(own, head, run, failing) {
  const asked = [];
  const log = [];
  const original = globalThis.fetch;
  browser.routing().reset();
  globalThis.fetch = async (url, init) => {
    asked.push(url);
    if (url === RPC) throw new TypeError('Failed to fetch');
    const failed = failing?.(url, init.body);
    if (failed) {
      log.push({ host: url, method: 'failed', params: [] });
      return failed;
    }
    return fallbackReply(url, init.body, { own, head, log });
  };
  try {
    return { result: await run(), asked, log };
  } finally {
    globalThis.fetch = original;
    browser.routing().reset();
  }
}

/** A wallet whose four setup operations minted 7 (open), 8 (closed, NFT kept) and 9 (sent away), and one still held as a deposit. */
function mintedWallet() {
  const op = (tokenId, patch = {}) => ({ owner: OWNER, key: KEY, balance0: 0n, balance1: 0n, swapped: false, closed: true, tokenId, ...patch });
  return {
    minted: [{ block: 69_300_000, id: 7 }, { block: 69_400_000, id: 8 }, { block: 69_500_000, id: 9 }],
    nfts: { 7: nft(), 8: nft({ liquidity: 0n }), 9: nft({ holder: '0x000000000000000000000000000000000000dead' }) },
    nonce: 4n,
    operations: { [opId(OWNER, 0n)]: op(7n), [opId(OWNER, 1n)]: op(0n, { balance0: 5n, closed: false }), [opId(OWNER, 2n)]: op(8n), [opId(OWNER, 3n)]: op(9n) },
  };
}

test('DominoSetupV1’s own state names exactly the ids its SetupMinted logs name: the scan that reads no log gives the log walk’s answer', async () => {
  const setup = mintedWallet();
  const walked = await walletScan.scanWallet(fakeChain(setup).deps, OWNER);
  const chain = fakeChain(setup);
  const read = await walletScan.scanWallet({ ...chain.deps, wideLogs: () => false }, OWNER);
  assert.deepEqual(read.body, walked.body, 'the same positions and deposits, field for field');
  assert.deepEqual(read.body.positions.map((p) => [p.tokenId, p.status]), [['7', 'open'], ['8', 'closed']], '9 was sent away');
  assert.equal(read.body.deposits.length, 1);
  assert.deepEqual([read.capped, read.minted], [false, { block: 71_700_000, ids: [9n, 8n, 7n] }], 'every one, most recent first: a later scan may read only the logs since');
  assert.equal(chain.log.filter((call) => call.method === 'eth_getLogs').length, 0, 'not one log');
  assert.deepEqual(chain.log.map((call) => call.method), ['eth_blockNumber', 'eth_call', 'eth_call', 'eth_call', 'eth_call'], 'the head, the nonce, the operations, then the scan’s own two reads');
  // An operation that is not the owner's is a reply that cannot be trusted.
  const forged = mintedWallet();
  forged.operations[opId(OWNER, 2n)] = { ...forged.operations[opId(OWNER, 2n)], owner: '0x000000000000000000000000000000000000beef' };
  await assert.rejects(walletScan.scanWallet({ ...fakeChain(forged).deps, wideLogs: () => false }, OWNER), (error) => error.message === 'invalid_operation');
  // More operations than it reads: the most recent ones, and the answer says it stopped there, as the log walk does.
  const operations = {};
  for (let n = 0n; n < BigInt(walletScan.MINTED_OPERATIONS + 5); n++) operations[opId(OWNER, n)] = { owner: OWNER, key: KEY, balance0: 0n, balance1: 0n, swapped: false, closed: true, tokenId: 0n };
  const many = { nonce: BigInt(walletScan.MINTED_OPERATIONS + 5), operations, nfts: {} };
  const capped = await walletScan.scanWallet({ ...fakeChain(many).deps, wideLogs: () => false }, OWNER);
  assert.deepEqual([capped.capped, capped.minted], [true, null]);
});

test('Your positions with the chain’s own RPC unreachable: read through the fallbacks, the owner’s ids from DominoSetupV1’s state, and the answer the route gives', async () => {
  walletPositions.forgetMinted();
  const setup = mintedWallet();
  const chain = fakeChain(setup);
  const { result: read, asked, log } = await unreachablePrimary((text) => chain.deps.fetch(RPC, { method: 'POST', body: text }), 71_700_000, () => walletPositions.readWalletPositions(OWNER, new AbortController().signal));
  assert.equal(read.ok, true, JSON.stringify(read));
  const route = await (await walletScan.answerWalletPositions(new Request('https://domino.money/api/owned/v2/positions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: OWNER }) }), fakeChain(setup).deps)).json();
  assert.deepEqual(read.answer, route, 'the list the chain’s own RPC gives, field for field');
  assert.deepEqual([...new Set(asked)], [RPC, PUBLICNODE], 'the primary once (its call and its probe), then publicnode only');
  assert.equal(asked.filter((url) => url === RPC).length, 2);
  assert.deepEqual(log.map((call) => call.method), ['eth_chainId', 'eth_blockNumber', 'eth_call', 'eth_call', 'eth_call', 'eth_call']);
  // 2026-09-28 (review): publicnode failing every read (a gateway's 502 after its chain id): the same list, through the
  // next fallbacks, and publicnode asked no more than that once.
  walletPositions.forgetMinted();
  const flaky = await unreachablePrimary((text) => fakeChain(setup).deps.fetch(RPC, { method: 'POST', body: text }), 71_700_000, () => walletPositions.readWalletPositions(OWNER, new AbortController().signal), (url, text) => (url === PUBLICNODE && !text.includes('eth_chainId') ? new Response('bad gateway', { status: 502 }) : undefined));
  assert.equal(flaky.result.ok, true, JSON.stringify(flaky.result));
  assert.deepEqual(flaky.result.answer, route, 'the same list, field for field');
  assert.deepEqual(flaky.log.filter((call) => call.host === PUBLICNODE).map((call) => call.method), ['eth_chainId', 'failed']);
  assert.ok(flaky.log.some((call) => call.host === ORDOFI && call.method === 'eth_call'), 'the state at the next that keeps it');
  walletPositions.forgetMinted();
});

test('a position’s page with the chain’s own RPC unreachable: its fees card’s state and its automation, read through the fallbacks, as the chain’s own RPC gives them', async () => {
  const flags = [globalThis.__DOMINO_DEPLOYABLE__, globalThis.__DOMINO_TEST_HOOKS__];
  globalThis.__DOMINO_DEPLOYABLE__ = true;
  globalThis.__DOMINO_TEST_HOOKS__ = false;
  const fees = require('../.test-build/app/src/lib/fees/client.js');
  const automation = require('../.test-build/app/src/lib/automationState.js');
  const make = () =>
    browserChain({
      positions: [{ tokenId: 11, holder: OWNER, key: KEY, tickLower: -600, tickUpper: 600, liquidity: 10n ** 12n, unclaimed: [5n, 7n] }],
      tokens: { [KEY.currency0]: { symbol: 'USDG', decimals: 6 }, [KEY.currency1]: { symbol: 'UFG', decimals: 18 } },
    });
  try {
    const direct = make();
    const original = globalThis.fetch;
    browser.routing().reset();
    globalThis.fetch = (url, init) => direct.fetch(url, init);
    let expected;
    try {
      relay.resetRelayMemory();
      fees.forgetChainMemory();
      expected = { state: await fees.chainState(['11']), automation: await automation.readAutomation(['11']) };
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(expected.state.ok, true, JSON.stringify(expected.state));
    const chain = make();
    relay.resetRelayMemory();
    fees.forgetChainMemory();
    const { result: read, asked } = await unreachablePrimary((text) => chain.fetch(RPC, { method: 'POST', body: text }), chain.head, async () => ({ state: await fees.chainState(['11']), automation: await automation.readAutomation(['11']) }));
    assert.deepEqual(read, expected, 'the unclaimed fees and the automation the chain’s own RPC gives');
    assert.ok(asked.every((url) => url === RPC || FALLBACK_URLS.includes(url)));
    assert.ok(asked.some((url) => url === PUBLICNODE));
  } finally {
    [globalThis.__DOMINO_DEPLOYABLE__, globalThis.__DOMINO_TEST_HOOKS__] = flags;
    relay.resetRelayMemory();
  }
});

test('the fees history with the chain’s own RPC unreachable: the worker’s lane reads headers and narrow ranges through the fallbacks; a range none serves ends the unit as unavailable, with no request', async () => {
  const { logsWith } = require('../.test-build/app/src/lib/fees/logs.js');
  const flags = [globalThis.__DOMINO_DEPLOYABLE__, globalThis.__DOMINO_TEST_HOOKS__];
  globalThis.__DOMINO_DEPLOYABLE__ = true;
  const lane = browser.chainLane({ bytesPerSecond: 10_000_000, burstBytes: 10_000_000, workFactor: 0, graceMs: 0, restMs: 150 });
  const code = { chainDeps: lane.deps, logsOnChain: relay.logsOnChain };
  const cache = browser.memoryCache();
  const pool = `0x${'ab'.repeat(32)}`;
  try {
    relay.resetRelayMemory();
    const { result: read, log } = await unreachablePrimary(tiny(HEAD), HEAD, async () => ({
      headers: await logsWith(code, cache, { kind: 'headers', blocks: [74_880_000, 74_844_000] }, { lane }),
      probe: await logsWith(code, cache, { kind: 'probe', poolId: pool, from: HEAD - 2_999, to: HEAD }, { lane }),
      wide: await logsWith(code, cache, { kind: 'probe', poolId: pool, from: HEAD - 35_999, to: HEAD }, { lane }),
    }));
    assert.equal(read.headers.ok, true, JSON.stringify(read.headers));
    assert.deepEqual(read.headers.value.headers, [[74_880_000, 1], [74_844_000, 1]]);
    assert.equal(read.probe.ok, true, JSON.stringify(read.probe));
    assert.deepEqual([read.wide.ok, read.wide.failure], [false, 'unavailable']);
    const calls = log.filter((call) => call.method !== 'eth_chainId');
    // The head and the headers where the head was read (a read keeps to its endpoint), the narrow range at ordofi.
    assert.deepEqual(calls.map((call) => `${hostOf(call.host)} ${call.method}`), ['publicnode eth_blockNumber', 'publicnode eth_getBlockByNumber', 'publicnode eth_getBlockByNumber', 'ordofi eth_getLogs']);
    assert.ok(!calls.some((call) => call.method === 'eth_getLogs' && Number(call.params[0].toBlock) - Number(call.params[0].fromBlock) >= 5_000), 'no range wider than a fallback serves was sent');
  } finally {
    lane.close();
    [globalThis.__DOMINO_DEPLOYABLE__, globalThis.__DOMINO_TEST_HOOKS__] = flags;
    relay.resetRelayMemory();
  }
});

test('New position’s batch simulation with the chain’s own RPC unreachable: a fallback that simulates answers it, and ordofi, which does not, is never asked', async () => {
  const params = [{ blockStateCalls: [{ calls: [{ to: owned.MULTICALL3, data: '0x' }] }], validation: true }, 'latest'];
  const { result: simulated, log } = await unreachablePrimary(tiny(HEAD), HEAD, () => browser.simulateOnChain(params));
  assert.deepEqual(simulated, [{ calls: [{ status: '0x1' }] }]);
  assert.deepEqual(log.map((call) => `${hostOf(call.host)} ${call.method}`), ['publicnode eth_chainId', 'publicnode eth_simulateV1']);
  assert.deepEqual(log[1].params, params, 'the page’s own simulation, as it would have gone to the chain’s own RPC');
});
