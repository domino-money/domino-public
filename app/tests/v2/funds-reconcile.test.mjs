import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { balanceSnapshot, reconcileBalances, BALANCE_CACHE_WAIT_MS, BALANCE_RECONCILE_ATTEMPTS } = require('../../.test-build/app/src/v2in/funds/reconcile.js');
const { fundsServices } = require('../../.test-build/app/src/v2in/funds/services.js');
const OWNER = `0x${'aa'.repeat(20)}`;
const TOKEN = `0x${'11'.repeat(20)}`;
const snapshot = (block, raw = '0') => ({ block, hash: `0x${block.toString(16).padStart(64, '0')}`, timestamp: 1_700_000_000 + block, balances: [{ token: TOKEN, raw }] });
const answer = (block = 100, raw = '0') => ({ kind: 'ok', body: {
  wallet: OWNER,
  chains: [{ chainId: 4663, status: 'current', snapshot: { number: block, hash: snapshot(block).hash, timestamp: snapshot(block).timestamp }, balances: [{ address: TOKEN, status: 'read', balanceRaw: raw }] }],
} });

function lab(replies) {
  let now = 0;
  let current = true;
  const seen = [];
  const reads = [];
  const waits = [];
  const deps = {
    monoMs: () => now,
    current: () => current,
    read: async () => { reads.push(now); return replies[Math.min(reads.length - 1, replies.length - 1)]; },
    wait: async (ms) => { waits.push(ms); now += ms; },
    onSnapshot: (value) => seen.push(value),
  };
  return { deps, seen, reads, waits, cancel: () => { current = false; }, advance: (ms) => { now += ms; } };
}

test('post-fill cache: actual old balance then fresh balance without depending on the active wallet chain', async () => {
  const s = lab([{ kind: 'ok', snapshot: snapshot(100, '2') }, { kind: 'ok', snapshot: snapshot(102, '50000002') }]);
  assert.equal(await reconcileBalances(s.deps), 'ready');
  assert.deepEqual(s.reads, [0, BALANCE_CACHE_WAIT_MS]);
  assert.deepEqual(s.seen.map((value) => value.balances[0].raw), ['2', '50000002']);
  assert.equal(Object.hasOwn(s.deps, 'walletChainId'), false, 'no active wallet chain is required for this read');
});

test('unchanged snapshot and balance are bounded, never optimistic credits or a completed reconciliation', async () => {
  const s = lab([{ kind: 'ok', snapshot: snapshot(100, '0') }]);
  assert.equal(await reconcileBalances(s.deps), 'unavailable');
  assert.equal(s.reads.length, BALANCE_RECONCILE_ATTEMPTS);
  assert.ok(s.seen.every((value) => value.balances[0].raw === '0'));
});

test('429 Retry-After and transient read failure are respected before a fresh destination snapshot', async () => {
  const s = lab([
    { kind: 'unavailable', retryAfterMs: 30_000 },
    { kind: 'ok', snapshot: snapshot(100, '2') },
    { kind: 'unavailable' },
    { kind: 'ok', snapshot: snapshot(103, '50000002') },
  ]);
  assert.equal(await reconcileBalances(s.deps), 'ready');
  assert.deepEqual(s.waits, [30_000, BALANCE_CACHE_WAIT_MS, BALANCE_CACHE_WAIT_MS]);
  assert.equal(s.seen.length, 2);
});

test('a larger retry delay cannot start a read beyond the reconciliation budget', async () => {
  const s = lab([{ kind: 'unavailable', retryAfterMs: 60_000 }]);
  assert.equal(await reconcileBalances(s.deps), 'unavailable');
  assert.deepEqual(s.reads, [0, 60_000, 120_000]);
});

test('changing account during a read or a retry wait cancels with no late update', async () => {
  const reading = lab([{ kind: 'ok', snapshot: snapshot(100) }]);
  reading.deps.read = async () => { reading.cancel(); return { kind: 'ok', snapshot: snapshot(101, '99') }; };
  assert.equal(await reconcileBalances(reading.deps), 'cancelled');
  assert.deepEqual(reading.seen, []);
  const waiting = lab([{ kind: 'unavailable' }]);
  waiting.deps.wait = async () => waiting.cancel();
  assert.equal(await reconcileBalances(waiting.deps), 'cancelled');
  assert.equal(waiting.reads.length, 1);
  assert.deepEqual(waiting.seen, []);
});

test('a regressed block cannot replace a good observed balance or finish reconciliation', async () => {
  const s = lab([
    { kind: 'ok', snapshot: snapshot(100, '4') },
    { kind: 'ok', snapshot: snapshot(99, '1000000') },
    { kind: 'ok', snapshot: snapshot(102, '5') },
  ]);
  assert.equal(await reconcileBalances(s.deps), 'ready');
  assert.deepEqual(s.seen.map((value) => value.balances[0].raw), ['4', '5']);
});

test('same-block contradictory balances or a different block hash are never trusted', async () => {
  for (const next of [snapshot(100, '5000'), { ...snapshot(100, '4'), hash: snapshot(99).hash }]) {
    const s = lab([{ kind: 'ok', snapshot: snapshot(100, '4') }, { kind: 'ok', snapshot: next }]);
    assert.equal(await reconcileBalances(s.deps), 'unavailable');
    assert.deepEqual(s.seen.map((value) => value.balances[0].raw), ['4']);
  }
});

test('balance normalization requires the right owner, chain and every requested token; unread is never zero', () => {
  assert.deepEqual(balanceSnapshot(answer(100, '0'), OWNER, 4663, [TOKEN]), { kind: 'ok', snapshot: snapshot(100) });
  assert.equal(balanceSnapshot(answer(), `0x${'bb'.repeat(20)}`, 4663, [TOKEN]).kind, 'unavailable');
  assert.equal(balanceSnapshot(answer(), OWNER, 8453, [TOKEN]).kind, 'unavailable');
  assert.equal(balanceSnapshot(answer(), OWNER, 4663, [TOKEN, `0x${'22'.repeat(20)}`]).kind, 'unavailable');
  assert.equal(balanceSnapshot(answer(), OWNER, 4663, []).kind, 'unavailable');
  const unread = answer();
  unread.body.chains[0].balances[0].balanceRaw = null;
  unread.body.chains[0].balances[0].status = 'unavailable';
  assert.equal(balanceSnapshot(unread, OWNER, 4663, [TOKEN]).kind, 'unavailable');
  const noSnapshot = answer();
  noSnapshot.body.chains[0].snapshot = null;
  assert.equal(balanceSnapshot(noSnapshot, OWNER, 4663, [TOKEN]).kind, 'unavailable');
  assert.deepEqual(balanceSnapshot({ kind: 'unavailable', reason: 'read_capacity_busy', retryAfterSeconds: 17 }, OWNER, 4663, [TOKEN]), { kind: 'unavailable', retryAfterMs: 17_000 });
});

test('simultaneous arrivals share an in-flight read, with no settled cache and no cross-owner reuse', async () => {
  let reads = 0;
  const waiting = [];
  const page = {
    live: () => ({ transport: { kind: 'http' }, runtime: {}, session: {}, clock: { monoMs: () => 0, setTimer: () => () => {} } }),
    balances: async (_gate, owner, chainId, tokens) => { reads++; await new Promise((done) => waiting.push(done)); return { kind: 'ok', snapshot: { ...snapshot(chainId), balances: tokens.map((token) => ({ token, raw: owner === OWNER ? '1' : '2' })) } }; },
  };
  const gate = { mode: 'live', chainId: 4663, contracts: {}, locked: false };
  const first = fundsServices(gate, OWNER, page);
  const other = fundsServices(gate, `0x${'bb'.repeat(20)}`, page);
  const one = first.readBalances(4663, [TOKEN]);
  const two = first.readBalances(4663, [TOKEN, TOKEN]);
  assert.equal(one, two);
  const separate = other.readBalances(4663, [TOKEN]);
  await Promise.resolve();
  assert.equal(reads, 2);
  waiting.splice(0).forEach((done) => done());
  assert.equal((await one).snapshot.balances[0].raw, '1');
  assert.equal((await separate).snapshot.balances[0].raw, '2');
  const next = first.readBalances(4663, [TOKEN]);
  await Promise.resolve();
  assert.equal(reads, 3, 'the next snapshot is requested again, not reused from a stale cache');
  waiting.splice(0).forEach((done) => done());
  await next;
});
