/**
 * The fees worker's lane to the public RPC (src/lib/chain/browser.ts
 * chainLane, 2026-09-25), and how the relay's code and client.ts use it.
 *
 * Since the page reads the chain itself, the fees logs and the page's own
 * reads (the list, a position's state) share one limit: the RPC's, per
 * visitor address, which tracks the work its answers cost over a short window
 * and, once it refuses, refuses everything from that address. The lane keeps
 * the logs from ever using it up: one request in flight for every history, a
 * position page's first; none while the page reads; paced by bytes and by
 * the work each reply cost; and at the first refusal the run stops and the
 * lane rests. Added 2026-09-25 with the review of r3/chain.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { chainDeps, chainLane, LANE_PACE } = require('../.test-build/app/src/lib/chain/browser.js');
const client = require('../.test-build/app/src/lib/fees/client.js');
const relay = require('../.test-build/app/functions/_lib/fees.js');

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const PACE = { bytesPerSecond: 100_000, burstBytes: 1_000, workFactor: 1, graceMs: 60, restMs: 150 };
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function withFetch(answer, run) {
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url, init });
    return answer(url, init);
  };
  try {
    return { result: await run(), sent };
  } finally {
    globalThis.fetch = original;
  }
}

/** One call through a lane's runtime, its body read to the end as the relay reads it. */
async function call(deps, init = {}) {
  const response = await deps.fetch(RPC, { method: 'POST', body: '{}', ...init });
  await response.text();
  return response;
}

test('the pace is the one measured on 2026-09-25: under the RPC’s own limit, with a first burst small enough for any reply', () => {
  assert.deepEqual({ ...LANE_PACE }, { bytesPerSecond: 96 * 1024, burstBytes: 128 * 1024, workFactor: 4, graceMs: 2_000, restMs: 30_000 });
});

test('one piece of work at a time in the lane, a position page’s before the list’s', async () => {
  const lane = chainLane(PACE);
  try {
    const order = [];
    let open;
    const gate = new Promise((done) => (open = done));
    const first = lane.queue(async () => { order.push('list 1 starts'); await gate; order.push('list 1 ends'); }, false);
    const second = lane.queue(async () => void order.push('list 2'), false);
    const page = lane.queue(async () => void order.push('page'), true);
    await wait(10);
    assert.deepEqual(order, ['list 1 starts'], 'nothing else starts while one runs');
    open();
    await Promise.all([first, second, page]);
    assert.deepEqual(order, ['list 1 starts', 'list 1 ends', 'page', 'list 2']);
  } finally { lane.close(); }
});

test('replies are paced by their bytes past a first burst, and by the work they cost the RPC', async () => {
  const bytes = chainLane(PACE);
  const work = chainLane({ ...PACE, bytesPerSecond: 10_000_000 });
  try {
    const deps = bytes.deps();
    assert.ok((await deps.turn()) < 20, 'the first call goes at once');
    await withFetch(() => new Response('x'.repeat(6_000)), () => call(deps));
    const waited = await deps.turn();
    assert.ok(waited >= 40 && waited < 400, `5,000 bytes past the burst at 100 kB/s: about 50 ms (${waited})`);

    const quick = work.deps();
    await withFetch(() => new Response('{}'), () => call(quick));
    assert.ok((await quick.turn()) < 20, 'a reply that cost nothing asks for no wait');
    await withFetch(async () => { await wait(150); return new Response('{}'); }, () => call(quick));
    const paid = await quick.turn();
    assert.ok(paid >= 100 && paid < 600, `a reply that took 150 ms more than the quickest waits about as long again (${paid})`);
  } finally { bytes.close(); work.close(); }
});

test('while the page has a read on its way the lane asks nothing, nor for a moment after it', async () => {
  const lane = chainLane(PACE);
  try {
    let answer;
    const held = new Promise((done) => (answer = done));
    const page = chainDeps();
    const reading = withFetch(() => held, () => page.fetch(RPC, { method: 'POST', body: '{}' }));
    await wait(30);
    const started = Date.now();
    const turn = lane.deps().turn();
    await wait(120);
    answer(new Response('{}'));
    await reading;
    const waited = await turn;
    const total = Date.now() - started;
    assert.ok(total >= 120 + PACE.graceMs - 10, `held for the page's read and its grace (${total} ms, turn ${waited} ms)`);
  } finally { lane.close(); }
});

test('the first refusal stops the run and rests the lane; an unreadable reply is that refusal; a dropped run is not a slow call', async () => {
  const lane = chainLane(PACE);
  try {
    const deps = lane.deps();
    const refused = await withFetch(() => new Response('Too Many Requests', { status: 429 }), () => deps.fetch(RPC, { method: 'POST', body: '{}' }));
    assert.equal(refused.result.status, 429);
    assert.equal(deps.cancelled(), true, 'the run asks nothing more');
    assert.equal(lane.resting(), true);
    assert.equal(lane.deps().cancelled(), true, 'nor does any other while the lane rests');
    const started = Date.now();
    await deps.sleep(10_000);
    assert.ok(Date.now() - started < 50, 'the relay’s wait before asking again is no wait');
    await wait(PACE.restMs + 20);
    assert.equal(lane.resting(), false, 'the rest ends');

    const again = lane.deps();
    const unreadable = await withFetch(() => Promise.reject(new TypeError('Failed to fetch')), () => again.fetch(RPC, { method: 'POST', body: '{}' }));
    assert.equal(unreadable.result.status, 429, 'the RPC’s 429 as a browser sees it');
    assert.equal(unreadable.sent.length, 1, 'asked once: the worker does not ask again');
    assert.equal(again.cancelled(), true);
    await wait(PACE.restMs + 20);

    const controller = new AbortController();
    const dropped = lane.deps(controller.signal);
    const call = withFetch((_url, init) => new Promise((_done, fail) => init.signal.addEventListener('abort', () => fail(new DOMException('aborted', 'AbortError')))), () => dropped.fetch(RPC, { method: 'POST', body: '{}' }));
    controller.abort();
    await assert.rejects(call, (error) => error.name === 'Error' && error.message === 'cancelled', 'not a TimeoutError or AbortError: the relay would split the range and mark it busy');
    assert.equal(lane.resting(), false, 'a dropped run is no refusal');
    await assert.rejects(dropped.fetch('https://example.com', { method: 'POST' }), TypeError, 'no other URL');
  } finally { lane.close(); }
});

// 2026-09-27 (the owner: the Fees earned chart took far too long): the fees worker hands the store how long its lane waits
// before it asks the RPC anything again, and the store asks a refused run again then (store.ts RETRY_MS), not a minute later.
test('the lane says how long before it asks anything again: its rest after a refusal, or the work its last reply cost; 0 when it may ask at once', async () => {
  let at = 1_000;
  const lane = chainLane({ ...PACE, restMs: 30_000, workFactor: 4 }, () => at);
  try {
    assert.equal(lane.wait(), 0, 'a new lane asks at once');
    const deps = lane.deps();
    await withFetch(() => new Response('Too Many Requests', { status: 429 }), () => deps.fetch(RPC, { method: 'POST', body: '{}' }));
    assert.equal(lane.wait(), 30_000, 'refused: the whole rest');
    at += 29_000;
    assert.equal(lane.wait(), 1_000);
    at += 1_000;
    assert.equal(lane.wait(), 0, 'the rest is over');
    // A slow reply: the work it cost the RPC, workFactor times its time above a usual round trip, is waited out as well.
    const slow = lane.deps();
    await withFetch(() => {
      at += 2_200;
      return new Response('{}');
    }, () => call(slow));
    assert.equal(lane.wait(), 4 * (2_200 - 200));
  } finally { lane.close(); }
});

// 2026-09-25 (review of r4/fees): each tab has its own fees worker and lane, and the RPC limits the visitor's address,
// not a tab: two busy-pool pages each paced alone read at twice the pace. Two lanes in one process hear each other on the
// channel as two tabs' workers do.
test('two tabs’ lanes share one pace: each counts the bytes the other read, and rests when the other was refused', async () => {
  const a = chainLane(PACE);
  const b = chainLane(PACE);
  try {
    const tabA = a.deps();
    const tabB = b.deps();
    assert.ok((await tabB.turn()) < 20, 'B goes at once while nothing was read');
    await withFetch(() => new Response('x'.repeat(8_000)), () => call(tabA));
    await wait(10);
    const waited = await tabB.turn();
    assert.ok(waited >= 30 && waited < 400, `B waits for the 7,000 bytes A read past the burst, about 70 ms at 100 kB/s (${waited} ms)`);
    await withFetch(() => new Response('Too Many Requests', { status: 429 }), () => tabA.fetch(RPC, { method: 'POST', body: '{}' }));
    await wait(10);
    assert.equal(b.resting(), true, 'A’s refusal rests B too');
    assert.equal(b.deps().cancelled(), true);
    await wait(PACE.restMs + 20);
    assert.equal(b.resting(), false);
  } finally { a.close(); b.close(); }
});

test('a run’s time budget ends its piece of work too: no wait past it, nothing asked after it, and the unit says its budget is spent', async () => {
  const lane = chainLane(PACE);
  try {
    const deps = lane.deps(undefined, Date.now() + 80);
    // A reply far past the burst: at 100 kB/s the next turn would be two seconds away.
    await withFetch(() => new Response('x'.repeat(200_000)), () => call(deps));
    const started = Date.now();
    await deps.turn();
    assert.ok(Date.now() - started < 400, `the wait ends with the run's time (${Date.now() - started} ms)`);
    assert.equal(deps.cancelled(), true, 'and nothing more is asked');
    const { logsWith } = require('../.test-build/app/src/lib/fees/logs.js');
    globalThis.__DOMINO_DEPLOYABLE__ = true;
    const spent = await withFetch(() => assert.fail('asked the chain'), () => logsWith({ chainDeps, logsOnChain: relay.logsOnChain }, null, { kind: 'transfer', tokenId: '1' }, { lane, until: Date.now() - 1 }));
    assert.deepEqual(spent.result, { ok: false, failure: 'too_large', retryAfterMs: 0 }, 'too_large: the run stops as too_much_history, as at its byte budget');
  } finally {
    lane.close();
    delete globalThis.__DOMINO_DEPLOYABLE__;
  }
});

test('through the relay’s code: a refused log read ends the unit at once as unavailable, and the resting lane asks nothing more', async () => {
  const { caseChain } = await import('./support/fees/case-chain.mjs');
  const chain = caseChain('3136705');
  const lane = chainLane(PACE);
  globalThis.__DOMINO_DEPLOYABLE__ = true;
  relay.resetRelayMemory();
  client.forgetChainMemory();
  try {
    const answer = (url, init) => (JSON.parse(init.body).method === 'eth_getLogs' ? new Response('Too Many Requests', { status: 429 }) : chain.fetch(url, init));
    const first = await withFetch(answer, () => client.chainLogs({ kind: 'transfer', tokenId: '3136705' }, { lane, urgent: true }));
    assert.deepEqual([first.result.ok, first.result.failure], [false, 'unavailable']);
    assert.deepEqual(first.sent.map((s) => JSON.parse(s.init.body).method), ['eth_blockNumber', 'eth_getLogs'], 'one refused call, no second try');
    const second = await withFetch(answer, () => client.chainLogs({ kind: 'transfer', tokenId: '3136705' }, { lane }));
    assert.deepEqual([second.result.failure, second.sent.length], ['unavailable', 0], 'the lane rests: nothing is asked');
    await wait(PACE.restMs + 20);
    const later = await withFetch((url, init) => chain.fetch(url, init), () => client.chainLogs({ kind: 'transfer', tokenId: '3136705' }, { lane }));
    assert.equal(later.result.ok, true, 'after the rest, the chain is asked again');
  } finally {
    lane.close();
    delete globalThis.__DOMINO_DEPLOYABLE__;
  }
});

test('the relay waits for a paced runtime’s turn before each call, and that wait is not the answer’s time', async () => {
  const { caseChain } = await import('./support/fees/case-chain.mjs');
  const chain = caseChain('3136705');
  let clock = 1_000_000;
  let turns = 0;
  const deps = {
    fetch: (url, init) => chain.fetch(url, init),
    sleep: async () => {},
    now: () => clock,
    // Twenty seconds for every turn: three calls would pass the answer's 25 s deadline if the waits counted.
    turn: async () => {
      turns += 1;
      clock += 20_000;
      return 20_000;
    },
  };
  relay.resetRelayMemory();
  const answer = await relay.stateOnChain({ deps, cache: null }, ['3136705']);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(turns, 3, 'a turn before each of the three calls');
});

test('two askers of the same position’s state share one read; one that leaves gets nothing, the other its answer', async () => {
  const { caseChain } = await import('./support/fees/case-chain.mjs');
  const chain = caseChain('3136705');
  globalThis.__DOMINO_DEPLOYABLE__ = true;
  relay.resetRelayMemory();
  try {
    const controller = new AbortController();
    const both = await withFetch((url, init) => chain.fetch(url, init), async () => {
      const leaving = client.chainState(['3136705'], controller.signal);
      const staying = client.chainState(['3136705']);
      controller.abort();
      return Promise.all([leaving, staying]);
    });
    assert.deepEqual(both.result[0], { ok: false, failure: 'unavailable', retryAfterMs: 0 });
    assert.equal(both.result[1].ok, true);
    assert.equal(both.sent.length, 3, 'one read of three calls, not two');
    // Once answered, a read is never reused: asked again, the position is read again (the head, a second old, is the relay's).
    const again = await withFetch((url, init) => chain.fetch(url, init), () => client.chainState(['3136705']));
    assert.deepEqual([again.result.ok, again.sent.filter((s) => JSON.parse(s.init.body).method === 'eth_call').length], [true, 2]);
  } finally {
    delete globalThis.__DOMINO_DEPLOYABLE__;
  }
});
