import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { createFundingBalanceCache } = require('../../.test-build/app/src/v2in/funds/balanceCache.js');
const tokens = [{ chainId: 4663, address: '0xabc' }];
test('funding consumers coalesce the same wallet read; failed reads recover and wallets stay separate', async () => {
  let now = 0, calls = 0, release;
  const cache = createFundingBalanceCache(() => now);
  const load = () => { calls++; return new Promise((done) => { release = done; }); };
  const first = cache.read('0xOWNER', tokens, load);
  const second = cache.read('0xowner', [...tokens], load);
  await Promise.resolve();
  assert.equal(calls, 1);
  release({ kind: 'ok', balance: '100' });
  assert.equal(await first, await second);
  assert.equal((await cache.read('0xowner', tokens, load)).balance, '100');
  assert.equal(calls, 1);
  assert.equal((await cache.read('0xother', tokens, async () => ({ kind: 'ok', balance: '0' }))).balance, '0');
  now = 10_001;
  const failure = await cache.read('0xowner', tokens, async () => ({ kind: 'unavailable' }));
  assert.equal(failure.kind, 'unavailable');
  assert.equal((await cache.read('0xowner', tokens, async () => ({ kind: 'ok', balance: '200' }))).balance, '200');
});
test('arrival invalidation prevents an older in-flight read from repopulating the balance cache', async () => {
  const cache = createFundingBalanceCache(() => 0);
  let release;
  const old = cache.read('owner', tokens, () => new Promise((done) => { release = done; }));
  await Promise.resolve();
  cache.invalidate('owner');
  const fresh = await cache.read('owner', tokens, async () => ({ kind: 'ok', balance: '20' }));
  release({ kind: 'ok', balance: '10' });
  await old;
  assert.equal(await cache.read('owner', tokens, async () => { throw new Error('should be cached'); }), fresh);
});

test('token order and address case share a read, while different networks or assets stay separate', async () => {
  const cache = createFundingBalanceCache(() => 0);
  let count = 0;
  const load = async () => ({ kind: 'ok', revision: ++count });
  const pair = [{ chainId: 4663, address: '0xaBc' }, { chainId: 8453, address: '0xDEF' }];
  const first = await cache.read('owner', pair, load);
  const reordered = await cache.read('owner', [{ chainId: 8453, address: '0xdef' }, { chainId: 4663, address: '0xABC' }], load);
  assert.equal(first, reordered);
  assert.equal(count, 1);
  assert.notEqual(await cache.read('owner', [{ chainId: 42161, address: '0xabc' }, pair[1]], load), first);
  assert.notEqual(await cache.read('owner', [{ chainId: 4663, address: '0xaaa' }, pair[1]], load), first);
  assert.equal(count, 3);
});

test('successful reads expire exactly ten seconds after receipt, including a genuine zero balance', async () => {
  let now = 0, count = 0, finish;
  const cache = createFundingBalanceCache(() => now);
  const pending = cache.read('owner', tokens, () => new Promise((resolve) => { finish = resolve; }));
  await Promise.resolve();
  now = 5_000;
  finish({ kind: 'ok', balance: '0' });
  const zero = await pending;
  const load = async () => { count += 1; return { kind: 'ok', balance: '10' }; };
  now = 14_999;
  assert.equal(await cache.read('owner', tokens, load), zero);
  assert.equal(count, 0);
  now = 15_000;
  assert.equal((await cache.read('owner', tokens, load)).balance, '10');
  assert.equal(count, 1);
});

test('thrown reads are retried and an old rejection cannot remove a newer post-arrival result', async () => {
  const cache = createFundingBalanceCache(() => 0);
  await assert.rejects(cache.read('owner', tokens, async () => { throw new Error('read failed'); }), /read failed/);
  let fail;
  const old = cache.read('owner', tokens, () => new Promise((_resolve, reject) => { fail = reject; }));
  const rejected = assert.rejects(old, /old read failed/);
  await Promise.resolve();
  cache.invalidate('owner');
  const fresh = await cache.read('owner', tokens, async () => ({ kind: 'ok', balance: '25' }));
  fail(new Error('old read failed'));
  await rejected;
  assert.equal(await cache.read('owner', tokens, async () => { throw new Error('new result must remain cached'); }), fresh);
});

test('arrival invalidates only the named wallet and all its token groups', async () => {
  const cache = createFundingBalanceCache(() => 0);
  const otherTokens = [{ chainId: 8453, address: '0xdef' }];
  await cache.read('owner', tokens, async () => ({ kind: 'ok', balance: '1' }));
  await cache.read('OWNER', otherTokens, async () => ({ kind: 'ok', balance: '2' }));
  const other = await cache.read('someone-else', tokens, async () => ({ kind: 'ok', balance: '3' }));
  cache.invalidate('OWNER');
  assert.equal((await cache.read('owner', tokens, async () => ({ kind: 'ok', balance: '11' }))).balance, '11');
  assert.equal((await cache.read('owner', otherTokens, async () => ({ kind: 'ok', balance: '12' }))).balance, '12');
  assert.equal(await cache.read('someone-else', tokens, async () => { throw new Error('unrelated wallet must remain cached'); }), other);
});
