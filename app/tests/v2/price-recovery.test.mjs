import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { createPriceRecovery, priceRecoveryTargets } = require('../../.test-build/app/src/v2in/lists/priceRecovery.js');
const original = JSON.parse(readFileSync(new URL('../../../api-contracts/read-v6/fixtures/valid/portfolio.json', import.meta.url)));
const setup = () => {
  const body = structuredClone(original);
  body.positions = [body.positions[0]];
  body.tokens[1].decimals = 18; body.tokens[1].price = null; body.tokens[1].priceReason = 'price_read_failed';
  return body;
};

test('targeted recovery is only for unread qualified sources in fresh nonzero positions', () => {
  const body = setup();
  assert.deepEqual(priceRecoveryTargets(body), [{ wallet: body.wallet, chainId: 4663, address: body.tokens[1].address }]);
  for (const reason of ['no_pool', 'pool_depth_below_floor', 'pool_depth_unmeasurable', 'eth_usd_stale', 'sequencer_down', 'decimals_unknown', 'no_qualified_price_source']) {
    const rejected = structuredClone(body); rejected.tokens[1].priceReason = reason;
    assert.deepEqual(priceRecoveryTargets(rejected), [], reason);
  }
  for (const change of [b => { b.positions[0].state.freshness.status = 'stale'; }, b => { b.chains[0].status = 'stale'; }, b => { b.tokens[1].decimals = null; }, b => { b.positions[0].state.principalAtSpot[1] = '0'; }]) {
    const rejected = structuredClone(body); change(rejected);
    assert.deepEqual(priceRecoveryTargets(rejected), []);
  }
  body.tokens[1].priceReason = 'pricing_limit_reached';
  assert.equal(priceRecoveryTargets(body).length, 1);
});

test('a recovered token causes one coherent portfolio reread and can recover again after its price expires', async () => {
  const warmed = [], refreshed = [], body = setup();
  let time = 0;
  const recovery = createPriceRecovery({ now: () => time, warm: async target => { warmed.push(target); return { kind: 'qualified' }; }, refresh: wallet => refreshed.push(wallet) });
  await recovery.run(body, () => true);
  await recovery.run(body, () => true);
  assert.equal(warmed.length, 1); assert.deepEqual(refreshed, [body.wallet]);
  const other = structuredClone(body); other.wallet = '0x' + 'dd'.repeat(20);
  await recovery.run(other, () => true);
  assert.equal(warmed.length, 2); assert.deepEqual(refreshed, [body.wallet, other.wallet]);
  assert.equal(warmed[1].wallet, other.wallet);
  time = 59_999; await recovery.run(body, () => true);
  assert.equal(warmed.length, 2, 'the same missing source cannot immediately loop');
  time++;
  await recovery.run(body, () => true);
  assert.equal(warmed.length, 3, 'a later price-cache expiry does not disable recovery for the page lifetime');
  assert.equal(refreshed.at(-1), body.wallet);
});

test('transient failures back off and retry on later portfolio polls without manufacturing a USD refresh', async () => {
  const body = setup();
  let time = 0, count = 0, refreshes = 0;
  const recovery = createPriceRecovery({ now: () => time, warm: async () => ({ kind: ++count < 3 ? 'retry' : 'qualified' }), refresh: () => refreshes++ });
  await recovery.run(body, () => true);
  time = 59_999; await recovery.run(body, () => true);
  assert.equal(count, 1); assert.equal(refreshes, 0);
  time = 60_000; await recovery.run(body, () => true);
  time = 179_999; await recovery.run(body, () => true);
  assert.equal(count, 2); assert.equal(refreshes, 0);
  time = 180_000; await recovery.run(body, () => true);
  assert.equal(count, 3); assert.equal(refreshes, 1);
});

test('Retry-After pauses the whole reader lane, including other tokens in the same pass', async () => {
  const body = setup();
  body.tokens[0].price = null; body.tokens[0].priceReason = 'pricing_limit_reached';
  let time = 0, count = 0;
  const recovery = createPriceRecovery({ now: () => time, warm: async () => { count++; return { kind: 'retry', afterMs: 180_000 }; }, refresh: () => assert.fail('no qualified USD') });
  await recovery.run(body, () => true);
  assert.equal(count, 1, 'the second target does not spend another lane token after a 429');
  time = 179_999; await recovery.run(body, () => true);
  assert.equal(count, 1);
  const other = structuredClone(body); other.wallet = '0x' + 'dd'.repeat(20);
  await recovery.run(other, () => true);
  assert.equal(count, 1, 'switching wallets cannot bypass the reader lane cooldown');
  time++; await recovery.run(body, () => true);
  assert.equal(count, 2);
});

test('a late Retry-After from an abandoned wallet stops the active wallet before its next target', async () => {
  const first = setup(), second = structuredClone(first);
  second.wallet = '0x' + 'dd'.repeat(20);
  second.tokens[0].price = null; second.tokens[0].priceReason = 'pricing_limit_reached';
  let time = 0, firstActive = true, releaseFirst, releaseSecond;
  const firstReply = new Promise(resolve => { releaseFirst = resolve; });
  const secondReply = new Promise(resolve => { releaseSecond = resolve; });
  const warmed = [];
  const recovery = createPriceRecovery({ now: () => time, warm: async target => {
    warmed.push(target);
    if (target.wallet === first.wallet) return firstReply;
    return warmed.filter(item => item.wallet === second.wallet).length === 1 ? secondReply : { kind: 'retry' };
  }, refresh: () => assert.fail('no qualified USD') });
  const abandoned = recovery.run(first, () => firstActive);
  firstActive = false;
  const current = recovery.run(second, () => true);
  assert.equal(warmed.length, 2, 'each wallet already has one shared request in flight');
  releaseFirst({ kind: 'retry', afterMs: 180_000 }); await abandoned;
  releaseSecond({ kind: 'retry' }); await current;
  assert.equal(warmed.length, 2, 'the active wallet rechecks the lane before asking its second token');
  time = 179_999; await recovery.run(second, () => true);
  assert.equal(warmed.length, 2);
  time++; await recovery.run(second, () => true);
  assert.equal(warmed.length, 4, 'the active wallet can resume its eligible targets after Retry-After');
});

test('hidden or abandoned owners never start another targeted read or receive a follow-up refresh', async () => {
  const body = setup(), warmed = [], refreshed = [];
  let release, active = true;
  const answer = new Promise(resolve => { release = resolve; });
  let time = 0;
  const recovery = createPriceRecovery({ now: () => time, warm: async target => { warmed.push(target); return answer; }, refresh: wallet => refreshed.push(wallet) });
  await recovery.run(body, () => false);
  assert.equal(warmed.length, 0);
  const waiting = recovery.run(body, () => active);
  await recovery.run(body, () => active);
  assert.equal(warmed.length, 1, 'parallel components share one recovery');
  active = false; release({ kind: 'qualified' }); await waiting;
  assert.deepEqual(refreshed, [], 'late shared replies cannot refresh the abandoned wallet');
  time = 60_000; active = true;
  await recovery.run(body, () => active);
  assert.equal(warmed.length, 2, 'returning to the wallet is not permanently blocked by the abandoned read');
});

test('recovery is serial, uses a rolling budget, and gives later position tokens their turn', async () => {
  const body = setup(), sample = body.positions[0], token = body.tokens[1];
  body.positions = Array.from({ length: 10 }, (_, i) => {
    const address = '0x' + (i + 1).toString(16).padStart(40, '0');
    body.tokens.push({ ...token, address });
    return { ...sample, tokenId: String(i + 100), state: { ...sample.state, pool: { ...sample.state.pool, currency1: address } } };
  });
  let current = 0, max = 0, count = 0, refreshes = 0, time = 0;
  const warmed = [];
  const recovery = createPriceRecovery({ now: () => time, warm: async target => { warmed.push(target.address); count++; current++; max = Math.max(max, current); await new Promise(setImmediate); current--; return { kind: 'retry' }; }, refresh: () => refreshes++ });
  await recovery.run(body, () => true); assert.equal(count, 3);
  await recovery.run(body, () => true); assert.equal(count, 6);
  await recovery.run(body, () => true); assert.equal(count, 6, 'six attempts per rolling five minutes is the hard ceiling');
  time = 299_999; await recovery.run(body, () => true); assert.equal(count, 6);
  time++; await recovery.run(body, () => true); assert.equal(count, 9);
  assert.equal(new Set(warmed).size, 9, 'tokens beyond the first six are not starved when the budget replenishes');
  assert.equal(max, 1); assert.equal(refreshes, 0);
});

test('a targeted read that disqualifies the source neither supplies USD nor immediately repeats', async () => {
  const body = setup();
  let time = 0, count = 0;
  const recovery = createPriceRecovery({ now: () => time, warm: async () => { count++; return { kind: 'unavailable' }; }, refresh: () => assert.fail('no qualified USD') });
  await recovery.run(body, () => true);
  time = 120_000; await recovery.run(body, () => true);
  assert.equal(count, 1);
  body.tokens[1].priceReason = 'pool_depth_below_floor';
  time = 600_000; await recovery.run(body, () => true);
  assert.equal(count, 1, 'explicitly unqualified portfolio sources are never recovery targets');
});
