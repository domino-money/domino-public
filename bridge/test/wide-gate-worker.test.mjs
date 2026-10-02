// domino-wide-gate (2026-10-02, review of rugged97's rules, finding 2): the site-wide gate of wide log scans that every
// Pages Function isolate asks (app/functions/_lib/wideGate.ts). Its arithmetic on a clock of the test's own, then the
// Durable Object's two POSTs, and nothing else answered.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker, { SITE_WIDE, WideGate, wideGate } from '../src/wide-gate-worker.mjs';

test('the site’s budget: about one core of rugged97’s node in blocks, four scans at once', () => {
  assert.deepEqual(SITE_WIDE, { blocksPerSecond: 80_000_000, burstBlocks: 160_000_000, parallel: 4, leaseMs: 15_000, maxWaitMs: 5_000 });
  // Some 11 µs of his node's CPU per thousand blocks: 80 million blocks a second is under one core.
  assert.ok((SITE_WIDE.blocksPerSecond / 1_000) * 0.011 < 1_000);
});

test('blocks from one bucket: its burst at once, then its rate, a wait within the asker’s; a scan wider than the burst goes on a full bucket and leaves the rest owed', () => {
  const clock = { time: 1_000_000 };
  const gate = wideGate(() => clock.time);
  const take = (blocks, waitMs = 5_000) => {
    const answer = gate.take(blocks, waitMs);
    if (answer?.ok) gate.release(answer.lease);
    return answer;
  };
  // 40 million each: four at once (160 million), then one every half second.
  assert.deepEqual([1, 2, 3, 4].map(() => take(40_000_000).waitMs), [0, 0, 0, 0]);
  assert.deepEqual(take(40_000_000).waitMs, 500);
  assert.deepEqual(take(40_000_000).waitMs, 1_000);
  assert.deepEqual(take(40_000_000, 1_000), { ok: false, retryAfterMs: 1_500 }, 'past the asker’s wait');
  assert.deepEqual(take(40_000_000, 60_000).waitMs, 1_500, 'never more than five seconds: the refused one took nothing');
  clock.time += 60_000;
  assert.equal(take(400_000_000).waitMs, 0, 'a full bucket: a scan wider than its burst goes');
  assert.equal(take(40_000_000).waitMs, 3_500, 'and the next waits for what it owed, less what the burst holds for it');
});

test('four turns out at most; a fifth waits for one given back, or lapsed', () => {
  const clock = { time: 1_000_000 };
  const gate = wideGate(() => clock.time);
  const turns = [1, 2, 3, 4].map(() => gate.take(1_000_000, 5_000));
  assert.ok(turns.every((turn) => turn.ok));
  assert.equal(new Set(turns.map((turn) => turn.lease)).size, 4);
  assert.deepEqual(gate.take(1_000_000, 5_000), { ok: false, retryAfterMs: 1_000 });
  gate.release(turns[0].lease);
  assert.equal(gate.take(1_000_000, 5_000).ok, true, 'one given back');
  assert.equal(gate.take(1_000_000, 5_000).ok, false);
  clock.time += SITE_WIDE.leaseMs;
  assert.equal(gate.out(), 0, 'a turn never given back lapses');
  assert.equal(gate.take(1_000_000, 5_000).ok, true);
  for (const bad of [[0, 1], [-1, 1], [1.5, 1], ['1', 1], [1, -1], [1, '1'], [10_000_000_001, 1]]) assert.equal(gate.take(...bad), null, JSON.stringify(bad));
});

test('the object answers its two POSTs and nothing else; the Worker itself answers nothing', async () => {
  const object = new WideGate();
  const post = (path, body, method = 'POST') => object.fetch(new Request(`https://wide-gate${path}`, { method, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined }));
  const taken = await (await post('/take', { blocks: 9_000_000, waitMs: 5_000 })).json();
  assert.deepEqual(taken, { ok: true, lease: '1', waitMs: 0 });
  assert.deepEqual(await (await post('/release', { lease: taken.lease })).json(), { ok: true });
  for (const [path, body, method, status] of [
    ['/take', { blocks: 'x', waitMs: 1 }, 'POST', 400],
    ['/take', 'not json', 'POST', 400],
    ['/take', [1], 'POST', 400],
    ['/take', { blocks: 1, waitMs: 1, pad: 'x'.repeat(300) }, 'POST', 400],
    ['/take', null, 'GET', 404],
    ['/take?x=1', { blocks: 1, waitMs: 1 }, 'POST', 404],
    ['/other', { blocks: 1, waitMs: 1 }, 'POST', 404],
  ]) assert.equal((await post(path, body, method)).status, status, `${method} ${path}`);
  assert.equal((await worker.fetch(new Request('https://domino-wide-gate.example/take', { method: 'POST', body: '{}' }))).status, 404);
});
