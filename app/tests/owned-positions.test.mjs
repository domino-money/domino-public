/**
 * Your positions on the page (src/lib/ownedPositions.ts): the endpoint's
 * answer checked field by field, the one request the page makes to it (also
 * answered by the endpoint itself, functions/_lib/owned.ts, over the fake
 * chain of tests/owned-chain.mjs), which ids go in which tab, and the rows'
 * reads, ten at a time, each id once.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as runtime from '../../api-contracts/read-v1/runtime.mjs';
import { fakeRpc, memoryCache, owned as endpoint } from './owned-chain.mjs';

const require = createRequire(import.meta.url);
const owned = require('../.test-build/app/src/lib/ownedPositions.js');
const positions = require('../.test-build/app/src/lib/read/screens/positions.js');
const project = require('../.test-build/app/src/lib/read/project.js');

const OWNER = '0xf6184f814543b88dd867c34ce6e9f56ab7d18c0a';
const FIXTURE_OWNER = '0x3333333333333333333333333333333333333333';
const fixture = (name) => JSON.parse(readFileSync(new URL(`../../api-contracts/read-v1/fixtures/gateway/${name}.json`, import.meta.url), 'utf8'));

const REPLY = {
  owner: OWNER,
  block: 70921337,
  positions: [
    { tokenId: '3135288', status: 'open' },
    { tokenId: '2578809', status: 'closed' },
  ],
  complete: true,
  deposits: [
    {
      operationId: '0x336239417f316789f8c3f88159622ecb6cba1da16a9bd46296de05732d26e887',
      currency0: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
      currency1: '0xca9c78dd337a67f6e0077f65f5e9218719d30edf',
      fee: 80000,
      tickSpacing: 800,
      hooks: '0x0000000000000000000000000000000000000000',
      balance0: '100000',
      balance1: '0',
    },
  ],
};
const clone = (value) => JSON.parse(JSON.stringify(value));

test('the endpoint’s answer is taken only when every field is exactly what the endpoint sends, and only for the owner asked about', () => {
  assert.deepEqual(owned.parseOwnedReply(clone(REPLY), OWNER), REPLY);
  assert.deepEqual(owned.parseOwnedReply(clone(REPLY), OWNER.toUpperCase().replace('0X', '0x')), REPLY, 'the address as the wallet reports it, checksummed or not');
  const broken = [
    (r) => (r.owner = FIXTURE_OWNER),
    (r) => (r.extra = 1),
    (r) => delete r.complete,
    (r) => (r.block = -1),
    (r) => (r.block = '1'),
    (r) => (r.complete = 'true'),
    (r) => (r.positions[0].tokenId = '03135288'),
    (r) => (r.positions[0].tokenId = 3135288),
    (r) => (r.positions[0].tokenId = (2n ** 256n).toString()),
    (r) => (r.positions[0].status = 'burned'),
    (r) => (r.positions[1].tokenId = '3135288'),
    (r) => (r.positions[0].owner = OWNER),
    (r) => (r.positions = Array.from({ length: 301 }, (_, i) => ({ tokenId: String(i + 1), status: 'closed' }))),
    (r) => (r.deposits[0].operationId = '0x1234'),
    (r) => (r.deposits[0].currency0 = r.deposits[0].currency0.toUpperCase()),
    (r) => (r.deposits[0].fee = 2 ** 24),
    (r) => (r.deposits[0].tickSpacing = 1.5),
    (r) => (r.deposits[0].balance0 = (2n ** 128n).toString()),
    (r) => (r.deposits[0].balance1 = '-1'),
    (r) => delete r.deposits[0].hooks,
    (r) => (r.deposits = Array.from({ length: 9 }, () => clone(REPLY.deposits[0]))),
  ];
  for (const [i, change] of broken.entries()) {
    const value = clone(REPLY);
    change(value);
    assert.equal(owned.parseOwnedReply(value, OWNER), null, `change ${i}`);
  }
  for (const value of [null, [], 'x', { ...clone(REPLY), positions: {} }]) assert.equal(owned.parseOwnedReply(value, OWNER), null);
});

/** Replaces global fetch for one call, recording what the page sent. */
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

test('the page asks the endpoint one way only: a same-origin POST of {owner}, no-store, and {owner, fresh} after an action', async () => {
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const ok = await withFetch(() => json(REPLY), () => owned.readOwnedPositions(OWNER, new AbortController().signal));
  assert.deepEqual(ok.result, { ok: true, list: REPLY });
  assert.equal(ok.sent.length, 1);
  const [{ url, init }] = ok.sent;
  assert.equal(url, '/api/owned/v1/positions');
  assert.doesNotMatch(url, /0x/i, 'the address is never in the URL');
  assert.deepEqual({ ...init, signal: undefined }, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: OWNER }), credentials: 'same-origin', cache: 'no-store', signal: undefined });
  const fresh = await withFetch(() => json(REPLY), () => owned.readOwnedPositions(OWNER, new AbortController().signal, true));
  assert.equal(fresh.sent[0].init.body, JSON.stringify({ owner: OWNER, fresh: true }));

  const cases = [
    [() => json({ error: 'chain_busy' }, 502), 'chain_busy'],
    [() => json({ error: 'NOT a code' }, 502), 'http_502'],
    [() => new Response('<!doctype html>', { status: 200 }), 'invalid_reply'],
    [() => new Response('<!doctype html>', { status: 404 }), 'http_404'],
    [() => json({ ...REPLY, owner: FIXTURE_OWNER }), 'invalid_reply'],
    [() => Promise.reject(new TypeError('Failed to fetch')), 'unreachable'],
  ];
  for (const [answer, reason] of cases) {
    const { result } = await withFetch(answer, () => owned.readOwnedPositions(OWNER, new AbortController().signal));
    assert.deepEqual(result, { ok: false, reason }, reason);
  }
  const controller = new AbortController();
  controller.abort();
  const aborted = await withFetch(() => Promise.reject(new DOMException('aborted', 'AbortError')), () => owned.readOwnedPositions(OWNER, controller.signal));
  assert.deepEqual(aborted.result, { ok: false, reason: 'aborted' });
  for (const reason of ['chain_busy', 'chain_unavailable', 'unreachable', 'http_503']) assert.equal(owned.passingOwnedFailure(reason), true, reason);
  for (const reason of ['invalid_owner', 'invalid_reply', 'http_404', 'beta_access_required']) assert.equal(owned.passingOwnedFailure(reason), false, reason);
});

/** The page's one request, answered by the endpoint itself over a fake chain and a Map cache. */
async function throughEndpoint(chain, cache, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => endpoint.answerOwned(new Request(`https://domino.money${url}`, { method: init.method, headers: init.headers, body: init.body }), chain.deps, cache);
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('the page reads what the endpoint sends: 300 ids of a walk that stopped early, the zero address refused for good, a kept chain_busy, and a fresh read within 5 seconds from what is kept', async () => {
  // 301 NFTs received and held: the walk stops at the 300 most recent, and the list says it is not whole.
  const received = Array.from({ length: 301 }, (_, i) => ({ block: 1_000_000 + i * 200_000, id: 1 + i }));
  const chain = fakeRpc({ received, holders: Object.fromEntries(received.map(({ id }) => [id, OWNER])) });
  const { cache } = memoryCache();
  const read = (fresh = false, owner = OWNER) => throughEndpoint(chain, cache, () => owned.readOwnedPositions(owner, new AbortController().signal, fresh));
  const first = await read();
  assert.equal(first.ok, true);
  assert.deepEqual([first.list.positions.length, first.list.positions[0].tokenId, first.list.positions.at(-1).tokenId, first.list.complete], [300, '301', '2', false]);
  const calls = chain.log.length;
  // Right after an action the page asks fresh: within 5 seconds of the answer, it gets that answer.
  chain.deps.time = 4_999;
  assert.deepEqual(await read(true), first);
  assert.equal(chain.log.length, calls);
  chain.deps.time = 5_000;
  assert.equal((await read(true)).ok, true);
  assert.equal(chain.log.length, 2 * calls, 'from 5 seconds on, a fresh read scans again');

  // The zero address: refused, and not a failure the page asks again for.
  const zero = await read(false, `0x${'0'.repeat(40)}`);
  assert.deepEqual(zero, { ok: false, reason: 'invalid_owner' });
  assert.equal(owned.passingOwnedFailure(zero.reason), false);
  assert.equal(chain.log.length, 2 * calls);

  // A busy chain: the page asks again 3 s later (OwnedPositions) and gets the kept failure, with nothing read; 12 s after that it scans.
  const busy = fakeRpc({ script: { eth_blockNumber: Array.from({ length: 4 }, () => new Response('', { status: 429 })) } });
  const kept = memoryCache();
  const busyRead = () => throughEndpoint(busy, kept.cache, () => owned.readOwnedPositions(OWNER, new AbortController().signal));
  assert.deepEqual(await busyRead(), { ok: false, reason: 'chain_busy' });
  assert.equal(owned.passingOwnedFailure('chain_busy'), true);
  busy.deps.time = 3_000;
  assert.deepEqual(await busyRead(), { ok: false, reason: 'chain_busy' });
  assert.equal(busy.log.length, 4, 'the retry read nothing');
  busy.deps.time = 15_000;
  assert.deepEqual(await busyRead(), { ok: true, list: { owner: OWNER, block: 70_900_000, positions: [], complete: true, deposits: [] } });
});

test('ids this browser created and the endpoint did not name yet are listed first, as open, until their own read says otherwise', () => {
  const merged = owned.mergeOwned(REPLY, ['4242', '3135288', '0012', 'x']);
  assert.deepEqual(merged.order, ['4242', '3135288', '2578809']);
  assert.deepEqual([...merged.status], [['4242', 'open'], ['3135288', 'open'], ['2578809', 'closed']]);
  // The endpoint could not answer: memory alone.
  assert.deepEqual(owned.mergeOwned(null, ['7', '5']).order, ['7', '5']);
  assert.deepEqual(owned.mergeOwned(null, []).order, []);
});

/** Two live cards from the read fixture, owned by `owner`, as one read of `ids` answers them. */
function batchFor(ids, { owner = OWNER, empty = [], liquidity = {} } = {}) {
  const base = fixture('nft-positions.success');
  const items = ids.map((id) =>
    empty.includes(id)
      ? { tokenId: id, status: 'position_info_empty_at_snapshot', owner: null, corePositionId: null, nftOwnershipResolved: false }
      : { ...base.items[0], tokenId: id, owner, salt: `0x${BigInt(id).toString(16).padStart(64, '0')}`, hasLiquidity: liquidity[id] ?? true },
  );
  const data = runtime.assertResponse('nft-positions', { ...base, items });
  const projected = positions.projectNftBatch(ids, data, new Map([[base.items[0].poolKey.currency0, project.unreadToken(base.items[0].poolKey.currency0)]]));
  assert.ok(projected.ok);
  return { kind: 'ok', batch: projected.batch };
}

test('a read’s rows: the wallet’s live NFTs are shown, another owner’s or an emptied NFT is dropped, and a failure never replaces figures already read', () => {
  const read = batchFor(['1', '2', '3'], { empty: ['3'] });
  const rows = owned.rowResults(OWNER, ['1', '2', '3'], read, {});
  assert.deepEqual(Object.keys(rows), ['1', '2', '3']);
  assert.equal(rows['1'].kind, 'card');
  assert.equal(rows['1'].card.liquidityRaw, '1267650600228229401496703205376', 'the card carries the producer’s liquidity');
  assert.deepEqual(rows['3'], { kind: 'gone' });
  const other = owned.rowResults(OWNER, ['1'], batchFor(['1'], { owner: FIXTURE_OWNER }), {});
  assert.deepEqual(other, { 1: { kind: 'gone' } }, 'a row whose owner at the read’s block is not the wallet is dropped');
  const failure = { state: 'unavailable', route: 'nft-positions', provenance: 'bridge', cause: { kind: 'edge', status: 503 }, retryable: true };
  const failed = owned.rowResults(OWNER, ['1', '9'], { kind: 'failed', failure }, rows);
  assert.deepEqual(Object.keys(failed), ['9'], 'row 1 keeps its figures');
  assert.deepEqual(failed['9'], { kind: 'failed', failure });
});

test('the tabs: an NFT not read yet sits where the endpoint put it; one read goes where its own liquidity puts it; a dropped one is in neither', () => {
  const ids = owned.mergeOwned({ ...REPLY, positions: [{ tokenId: '1', status: 'open' }, { tokenId: '2', status: 'open' }, { tokenId: '3', status: 'closed' }, { tokenId: '4', status: 'closed' }] }, []);
  assert.deepEqual(owned.ownedTabs(ids, {}), { open: ['1', '2'], closed: ['3', '4'] });
  const rows = { ...owned.rowResults(OWNER, ['1', '2', '3'], batchFor(['1', '2', '3'], { liquidity: { 2: false } }), {}), 4: { kind: 'gone' } };
  assert.deepEqual(owned.ownedTabs(ids, rows), { open: ['1', '3'], closed: ['2'] }, '2 was closed and 3 topped up since the endpoint’s block');
});

test('the rows are read ten at a time, one read after another, each id once; a passing failure is asked again later; cancel stops everything', async () => {
  const calls = [];
  const results = [];
  const later = [];
  const failure = { state: 'unavailable', route: 'nft-positions', provenance: 'bridge', cause: { kind: 'edge', status: 503 }, retryable: true };
  let fail = true;
  let open = 0;
  const reader = owned.createRowReader(
    async (ids, signal) => {
      open += 1;
      assert.equal(open, 1, 'one read at a time');
      calls.push(ids);
      await new Promise((done) => setTimeout(done, 1));
      open -= 1;
      if (signal.aborted) return { kind: 'aborted' };
      if (fail && ids.includes('11')) return { kind: 'failed', failure };
      return batchFor(ids);
    },
    (ids, result) => results.push([ids, result.kind]),
    { retryIn: (_failure, attempt) => (attempt < 1 ? 5000 : null), later: (ms, run) => (later.push([ms, run]), () => undefined) },
  );
  const ids = Array.from({ length: 12 }, (_, i) => String(i + 1));
  reader.want(ids);
  reader.want(ids.slice(0, 3));
  await new Promise((done) => setTimeout(done, 30));
  assert.deepEqual(calls, [ids.slice(0, 10), ids.slice(10)], 'ten, then the rest, and nothing asked twice');
  assert.deepEqual(results.map(([batch, kind]) => [batch.length, kind]), [[10, 'ok'], [2, 'failed']]);
  assert.deepEqual(later.map(([ms]) => ms), [5000]);
  fail = false;
  later[0][1]();
  await new Promise((done) => setTimeout(done, 30));
  assert.deepEqual(calls.at(-1), ['11', '12'], 'the failed page asked again');
  assert.deepEqual(results.at(-1)[1], 'ok');

  const stopped = [];
  const cancelled = owned.createRowReader(async (batch, signal) => {
    stopped.push(batch);
    await new Promise((done) => setTimeout(done, 5));
    return signal.aborted ? { kind: 'aborted' } : batchFor(batch);
  }, () => assert.fail('a cancelled reader reported a result'));
  cancelled.want(ids);
  cancelled.cancel();
  await new Promise((done) => setTimeout(done, 30));
  assert.equal(stopped.length, 1, 'the read in flight was cancelled and nothing after it was asked');
});

// Review of 2026-09-25: under React StrictMode (npm run dev) every effect runs setup, cleanup, setup on mount, and
// useMemo keeps the reader. The cleanup's cancel() aborted the reader for good, so the second setup's want() read
// nothing and every row stayed a skeleton. A cancelled reader now starts over on the next want().
test('the rows are still read after setup, cleanup, setup (StrictMode): a cancelled reader starts over on the next want, and the cancelled read reports nothing', async () => {
  const calls = [];
  const results = [];
  const reader = owned.createRowReader(
    async (ids, signal) => {
      calls.push(ids);
      await new Promise((done) => setTimeout(done, 5));
      return signal.aborted ? { kind: 'aborted' } : batchFor(ids);
    },
    (ids, result) => results.push([ids, result.kind]),
  );
  const ids = ['1', '2', '3'];
  // OwnedPositions' two effects as StrictMode runs them: the cancel effect and the want effect set up, both cleaned up, both set up again.
  reader.want(ids);
  reader.cancel();
  reader.want(ids);
  await new Promise((done) => setTimeout(done, 40));
  assert.deepEqual(calls, [ids, ids], 'the ids are asked again after the cancel');
  assert.deepEqual(results, [[ids, 'ok']], 'only the second read reports, once');

  // A reader cancelled before it was ever asked (the first mount has no ids yet) reads once they arrive.
  const late = [];
  const idle = owned.createRowReader(async (batch) => batchFor(batch), (batch, result) => late.push([batch, result.kind]));
  idle.cancel();
  idle.want(['7']);
  await new Promise((done) => setTimeout(done, 20));
  assert.deepEqual(late, [[['7'], 'ok']]);
});

// Review of 2026-09-25: the read service answers at its own node's head, which can be behind the block that minted a
// position a moment ago. An id this browser remembers creating (lib/positionMemory.ts) read empty there, was dropped as
// gone, and was never asked again. An empty NFT is now asked once more, its row still being read meanwhile.
test('an NFT that reads empty stays as a row being read and is asked once more, later; empty again, it is dropped', async () => {
  // A position's page asks an empty NFT again after 2, 5 and 10 s before it says the NFT was not found (PositionDetail.tsx).
  assert.deepEqual([0, 1, 2, 3, -1, 0.5].map((attempt) => positions.emptyReaskDelayMs(attempt)), [2_000, 5_000, 10_000, null, null, null]);
  // The rows: an empty id the reader asks again stays, where the endpoint (or memory) put it; one it does not is dropped.
  const first = owned.rowResults(OWNER, ['4242', '1'], batchFor(['4242', '1'], { empty: ['4242'] }), {}, ['4242']);
  assert.deepEqual(first['4242'], { kind: 'empty', block: 700 });
  assert.equal(first['1'].kind, 'card');
  const ids = owned.mergeOwned({ ...REPLY, positions: [{ tokenId: '1', status: 'open' }] }, ['4242']);
  assert.deepEqual(owned.ownedTabs(ids, first), { open: ['4242', '1'], closed: [] }, 'still listed while it is asked again');
  const second = owned.rowResults(OWNER, ['4242'], batchFor(['4242'], { empty: ['4242'] }), first, []);
  assert.deepEqual(second, { 4242: { kind: 'gone' } });
  assert.deepEqual(owned.ownedTabs(ids, { ...first, ...second }), { open: ['1'], closed: [] });

  // The reader: the empty id once more, after the page's last empty re-ask, through `later`; then never again.
  assert.equal(owned.EMPTY_ROW_REASK_MS, 10_000);
  const calls = [];
  const reports = [];
  const later = [];
  let answers = [['4242'], ['4242']];
  const reader = owned.createRowReader(
    async (batch) => {
      calls.push(batch);
      const empty = answers.shift() ?? [];
      return batchFor(batch, { empty });
    },
    (batch, result, again) => reports.push([batch, result.kind, again]),
    { retryIn: () => null, later: (ms, run) => (later.push([ms, run]), () => undefined) },
  );
  reader.want(['4242', '1']);
  await new Promise((done) => setTimeout(done, 10));
  assert.deepEqual(reports, [[['4242', '1'], 'ok', ['4242']]], 'onResult is told which empty NFT will be asked again');
  assert.deepEqual(later.map(([ms]) => ms), [10_000]);
  later[0][1]();
  await new Promise((done) => setTimeout(done, 10));
  assert.deepEqual(calls, [['4242', '1'], ['4242']], 'the empty one alone, asked once more');
  assert.deepEqual(reports.at(-1), [['4242'], 'ok', []], 'and not again: the page drops it');
  assert.equal(later.length, 1);

  // Found the second time: the row is the position.
  answers = [['9'], []];
  const found = [];
  const recovering = owned.createRowReader(async (batch) => batchFor(batch, { empty: answers.shift() ?? [] }), (batch, result, again) => found.push(owned.rowResults(OWNER, batch, result, {}, again)), {
    retryIn: () => null,
    later: (_ms, run) => (setTimeout(run, 1), () => undefined),
  });
  recovering.want(['9']);
  await new Promise((done) => setTimeout(done, 30));
  assert.deepEqual(found.map((rows) => rows['9'].kind), ['empty', 'card']);

  // Without a retry policy nothing is asked again, and the empty NFT is dropped at once, as before.
  const plain = [];
  const once = owned.createRowReader(async (batch) => batchFor(batch, { empty: batch }), (batch, result, again) => plain.push(again));
  once.want(['3']);
  await new Promise((done) => setTimeout(done, 10));
  assert.deepEqual(plain, [[]]);
});

test('held deposits reach HeldDeposits with each currency’s symbol and decimals where the read service gave them, nulls where not', () => {
  const [deposit] = REPLY.deposits;
  assert.deepEqual(owned.depositCurrencies([deposit, { ...deposit, currency1: deposit.currency0 }]), [deposit.currency0, deposit.currency1]);
  const usdg = { origin: 'read', chainId: 4663, address: deposit.currency0, symbol: 'USDG', decimals: 6, readStatus: 'available', artwork: null };
  const [view] = owned.heldDepositViews([deposit], new Map([[deposit.currency0, usdg]]));
  assert.deepEqual(view, { ...deposit, currencies: [{ address: deposit.currency0, symbol: 'USDG', decimals: 6 }, { address: deposit.currency1, symbol: null, decimals: null }] });
});
