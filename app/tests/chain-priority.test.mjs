/**
 * The list goes first (2026-09-28). The owner, on his phone, in a wallet's in-app browser with five tabs open: Your
 * positions stayed on its loading rows with "Reading your positions from the chain…", while the Wallet card, read
 * elsewhere, was fine. The chain's answer and the parser were fine (the same scan in Node: four calls, one second, six
 * positions); the public RPC was refusing his address, and round 6 had put the fees histories' load back on it (the
 * list's APR replays each open position's history, in every tab that shows the list).
 *
 * Here, in a process of its own (the page's side of the channel is module state, and the lanes of other suites'
 * tests would rest it), the page's runtime (src/lib/chain/browser.ts): the list's read holds every tab's fees lane for
 * the whole of it, its waits between refused calls included; a refusal any page read meets rests every lane at once.
 * The page's side is tests/finance.browser.test.mjs. Changed on purpose (2026-09-28, hotfix): the list's APR queue is gone
 * (it replayed the fees histories from the list), and with it the page's low-priority wait (quietIn): the list measures
 * nothing (tests/list-apr.test.mjs).
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fakeChain, nft, OWNER } from './owned-chain.mjs';
import { reachable } from './support/reach.mjs';

const require = createRequire(import.meta.url);
const browser = require('../.test-build/app/src/lib/chain/browser.js');
const { chainDeps, chainLane, holdReads, routing, LANE_PACE } = browser;
const walletPositions = require('../.test-build/app/src/lib/walletPositions.js');

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const PACE = { bytesPerSecond: 100_000, burstBytes: 1_000, workFactor: 1, graceMs: 60, restMs: 150 };
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

// Changed on purpose (2026-09-28, hotfix): no low-priority read of the page waits on the channel any more (the list's APR
// queue is gone), so the page exports no quietIn; a hold still keeps every lane waiting.
test('a hold keeps every lane waiting until it is released, however long; the page has no low-priority reads of its own', async () => {
  assert.equal('quietIn' in browser, false, 'no list APR queue to hold');
  const lane = chainLane(PACE);
  try {
    const release = holdReads();
    const held = Date.now();
    // The lane hears the hold on the channel (a message, delivered after this turn of the event loop).
    await wait(20);
    const turn = lane.deps().turn();
    await wait(PACE.graceMs * 4 - 20);
    release();
    await turn;
    assert.ok(Date.now() - held >= PACE.graceMs * 5 - 10, `the lane waited for the release and its grace (${Date.now() - held} ms)`);
  } finally {
    lane.close();
  }
});

test('the list’s read holds every lane for the whole of it, its wait between refused calls included; the refusal it met rests every lane', async () => {
  const lane = chainLane(PACE);
  walletPositions.forgetMinted();
  // Its first call refused (two unreadable replies: the RPC's 429 as a browser sees it), the scan's 1.5 s wait, then the chain.
  const chain = fakeChain({ minted: [{ block: 69_300_000, id: 7 }], nfts: { 7: nft() } });
  let refused = 0;
  const original = globalThis.fetch;
  // 2026-09-28: the RPC is there to be reached (the router's no-cors probe is answered), so the TypeError is its refusal.
  globalThis.fetch = reachable(async (url, init) => (refused++ < 2 ? Promise.reject(new TypeError('Failed to fetch')) : chain.deps.fetch(url, init)));
  try {
    const read = walletPositions.readWalletPositions(OWNER, new AbortController().signal);
    while (refused < 2) await wait(5);
    await wait(20);
    assert.equal(lane.resting(), true, 'the page’s refusal rests the lane at once');
    // The lane's own rest (its test pace's) is over while the scan still waits out its 1.5 s: the lane is still held.
    await wait(PACE.restMs + 30);
    assert.equal(lane.resting(), false);
    const asked = Date.now();
    const next = lane.deps().turn();
    const answer = await read;
    const ended = Date.now();
    await next;
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(answer.answer.positions.length, 1);
    assert.ok(ended - asked > 1_000, `the list’s read went on for its wait (${ended - asked} ms)`);
    assert.ok(Date.now() - ended >= PACE.graceMs - 10, 'and the lane asked nothing before it was over, nor for its grace after');
  } finally {
    globalThis.fetch = original;
    walletPositions.forgetMinted();
    lane.close();
  }
});

test('a read handed its own runtime (a test’s, the picker’s fakes) holds nothing', async () => {
  const lane = chainLane(PACE);
  try {
    const chain = fakeChain({ minted: [{ block: 69_300_000, id: 7 }], nfts: { 7: nft() } });
    const turn = lane.deps().turn();
    const answer = await walletPositions.readWalletPositions(OWNER, new AbortController().signal, chain.deps);
    assert.equal(answer.ok, true);
    const started = Date.now();
    await turn;
    assert.ok(Date.now() - started < 50, 'the lane was never held');
  } finally {
    lane.close();
  }
});

// Review of 2026-09-28: every read the page starts says so again on the channel, and a lane's hold counts from the last
// it heard (PAGE_HOLD_MS, 15 s: its cap for a page that closed mid-read and never said it was done). So a list read that
// goes on past 15 s, asking all along (the scan's longest wait between two calls is 4.5 s), keeps every lane waiting
// throughout; one that says nothing for 15 s lets them go. On the lane's own clock.
test('a hold longer than the lanes’ 15 s cap keeps a lane waiting for as long as the read goes on asking, and lets it go 15 s after its last call', async () => {
  let at = 1_000_000;
  const lane = chainLane({ ...PACE, graceMs: 2_000 }, () => at);
  const page = chainDeps();
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}');
  try {
    assert.equal(lane.wait(), 0, 'nothing held yet');
    const release = holdReads();
    await wait(20);
    assert.equal(lane.wait(), 2_000, 'held at the read’s start');
    // The read goes on for 36 s, a call every 4.5 s, each answered: past the cap twice over.
    for (let spent = 4_500; spent <= 36_000; spent += 4_500) {
      at += 4_500;
      await (await page.fetch(RPC, { method: 'POST', body: '{}' })).text();
      await wait(20);
      assert.equal(lane.wait(), 2_000, `still held ${spent} ms into the read`);
    }
    // Then nothing for the cap: the lane goes again, as for a page closed mid-read.
    at += 14_999;
    assert.equal(lane.wait(), 2_000);
    at += 1;
    assert.equal(lane.wait(), 0, 'let go 15 s after the read’s last call');
    // The read ends: its grace, then nothing.
    release();
    await wait(20);
    assert.equal(lane.wait(), 2_000, 'the grace after the read');
    at += 2_000;
    assert.equal(lane.wait(), 0);
  } finally {
    globalThis.fetch = original;
    lane.close();
  }
});

/** A document for the page's visible-only waits (lib/read/screens/quietRead.ts whenVisibleAfter): always visible. */
function visibleDocument() {
  const doc = new EventTarget();
  doc.hidden = false;
  return doc;
}

// Review of 2026-09-28: a limiter that lengthens its refusal at each refused call (by `penalty`) lets an address in only
// after a quiet longer than that. The first fix asked the list again 2 s after each refused read, for ever: with the
// scan's own waits (1.5, 3 and 4.5 s) no quiet ever passed 4.5 s, and in the reviewer's harness a 6 s penalty kept the
// list out for good (78 refused calls in 120 s, where d1197112's ladder got in at 49.8 s). Here the page's own read, end
// to end on node's clock (the runtime's unreadable-reply re-ask, the scan's waits, askWallet's re-asks), against such a
// limiter that refuses from the start for 20 s: it gets in, as soon as the ladder's waits outlast the penalty, and it
// never asks more often than the owner's ladder of 2026-09-25 would.
test('against a limiter that lengthens its refusal at each refused call, the list still gets in, and never asks faster than the ladder', async (t) => {
  const chain = fakeChain({ minted: [{ block: 69_300_000, id: 7 }], nfts: { 7: nft() } });
  const before = { fetch: globalThis.fetch, document: globalThis.document };
  t.after(() => {
    globalThis.fetch = before.fetch;
    globalThis.document = before.document;
    walletPositions.forgetMinted();
    routing().reset();
  });
  globalThis.document = visibleDocument();
  const flush = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((done) => setImmediate(done));
  };
  const results = [];
  for (const penalty of [6_000, 12_000]) {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    walletPositions.forgetMinted();
    // Merged with fix/rpc-fallback (2026-09-28): the page's router starts knowing nothing on this clock (a probe an
    // earlier test answered on the real clock would vouch for the RPC here for ever), and its reach probe, a no-cors GET,
    // is answered as a browser answers it for a limiter that is there, so each TypeError below stays the RPC's refusal and
    // no call goes to the fallbacks. The probe is not one of the calls counted.
    routing().reset();
    let until = 20_000;
    const asked = [];
    // The RPC's 429 reaches a browser as a failed fetch (its allow-origin `*,*`): that is what the page sees here.
    globalThis.fetch = reachable(async (url, init) => {
      const at = Date.now();
      const refused = at < until;
      asked.push({ at, refused, url: String(url) });
      if (!refused) return chain.deps.fetch(url, init);
      until = Math.max(until, at + penalty);
      throw new TypeError('Failed to fetch');
    });
    const puts = [];
    const cancel = walletPositions.askWallet(OWNER, { current: null }, (value) => puts.push({ at: Date.now(), ...value }));
    await flush();
    while (!puts.some((put) => put.phase === 'ready') && Date.now() < 300_000) {
      t.mock.timers.tick(50);
      await flush();
    }
    cancel();
    const ready = puts.find((put) => put.phase === 'ready');
    const refused = asked.filter((call) => call.refused);
    results.push(`${penalty} ms: in at ${ready?.at} ms, ${refused.length} refused calls`);
    assert.ok(ready, `a ${penalty} ms penalty: the list got in (${puts.map((put) => `${put.at} ${put.phase}`).join(', ')})`);
    assert.equal(ready.answer.positions.length, 1);
    // The reads: the first, and one after each failure, after the ladder's waits (2, 5 and 10 s, then 30 s) but for the
    // second, 2 s for a refusal; so never more reads than the owner's ladder, and none later.
    const failures = puts.filter((put) => put.phase !== 'ready').map((put) => put.at);
    assert.ok(failures.length >= 3, `refused long enough to spend the quick waits (${failures.length} failed reads)`);
    const starts = [0, ...failures.map((failed, i) => failed + ([2_000, 2_000, 10_000][i] ?? 30_000))];
    for (const [i, start] of starts.entries()) {
      const calls = asked.filter((call) => call.at >= start && call.at < start + 50);
      assert.ok(calls.length > 0, `read ${i + 1} asked at ${start} ms`);
      const next = starts[i + 1] ?? Infinity;
      assert.ok(asked.filter((call) => call.refused && call.at >= start && call.at < next).length <= 8, `read ${i + 1}: its first call refused four times at most, each asked once more`);
    }
    assert.ok(asked.every((call) => call.at >= 0 && call.at <= ready.at), 'nothing asked after the answer');
    assert.ok(asked.every((call) => call.url.replace(/\/$/, '') === RPC), 'the chain’s own RPC only: a limiter is no outage');
    t.mock.timers.reset();
  }
  t.diagnostic(results.join('; '));
});
