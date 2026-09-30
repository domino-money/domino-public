import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { createRouteJournal } = require('../.test-build/app/src/finance/routedJournal.js');
const { routedBatchPlan, routedTermsKey } = require('../.test-build/app/src/finance/routedPlan.js');
const owner = '0x' + '11'.repeat(20), other = '0x' + '22'.repeat(20), hash = '0x' + 'ab'.repeat(32);
function memory() { const values = new Map(); return { values, getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) }; }
function fixture(store = memory()) {
  let counter = 0; const queues = new Map();
  const locks = { request(key, work) { const run = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(work); queues.set(key, run); return run; } };
  return { store, make: () => createRouteJournal(store, locks, () => `12345678-1234-1234-1234-${String(++counter).padStart(12, '0')}`) };
}
test('routed swap journal quarantines unknown offers across tabs and reloads, with only hashes and claims persisted', async () => {
  const f = fixture(), first = f.make(), second = f.make();
  const outcomes = await Promise.allSettled([first.claim(owner), second.claim(owner)]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  const claim = outcomes.find(x => x.status === 'fulfilled').value;
  assert.deepEqual(second.read(owner), { claim, hash: null, batchOperation: null });
  await assert.rejects(second.claim(owner), /route_already_offered/);
  await first.record(owner, claim, hash);
  assert.deepEqual(f.make().read(owner), { claim, hash, batchOperation: null });
  await assert.rejects(f.make().claim(owner), /route_already_offered/);
  assert.equal(first.read(other), null);
  assert.ok([...f.store.values.keys()].every(k => !k.includes(owner.slice(2))));
  assert.deepEqual([...f.store.values.values()], [`${claim}|${hash}`]);
  await second.release(owner, 'bad-claim'); assert.ok(first.read(owner));
  await second.release(owner, claim); assert.equal(first.read(owner), null);
});
test('atomic and sequential route offers share one owner latch; reload records only the atomic operation hash', async () => {
  const f = fixture(), first = f.make(), second = f.make(), claim = await first.claim(owner);
  await first.recordBatch(owner, claim, hash);
  assert.deepEqual(second.read(owner), { claim, hash: null, batchOperation: hash });
  await assert.rejects(second.claim(owner), /route_already_offered/);
  await first.release(owner, claim);
  const claim2 = await second.claim(owner);
  await second.record(owner, claim2, hash);
  await assert.rejects(first.claim(owner), /route_already_offered/);
});
test('routed journal refuses inaccessible/corrupt persistence and never mistakes a missing hash for a failed swap', async () => {
  const f = fixture(), journal = f.make(), claim = await journal.claim(owner);
  await assert.rejects(journal.record(owner, claim, 'not-a-hash'), /route_coordination_unavailable/);
  assert.equal(journal.read(owner).hash, null);
  for (const key of f.store.values.keys()) f.store.values.set(key, 'corrupt');
  assert.throws(() => journal.read(owner), /route_coordination_unavailable/);
  await assert.rejects(journal.claim(owner), /route_coordination_unavailable/);
});
const route = JSON.parse(readFileSync(new URL('../../api-contracts/onboarding-v1/fixtures/responses/swap-route.json', import.meta.url))).preview;
const key = { currency0: route.request.poolKey.currency0, currency1: route.request.poolKey.currency1, fee: route.request.poolKey.fee_pips, tickSpacing: route.request.poolKey.tick_spacing, hooks: route.request.poolKey.hooks };
const range = { tickLower: -400, tickUpper: 400, slippageBps: 50 };
test('routed mint uses guaranteed net output and untouched input; no second Setup swap or fee', () => {
  const gross = BigInt(route.request.amountRaw), total = gross * 2n;
  const plan = routedBatchPlan(route, total, key, range, 2n ** 96n);
  const from0 = route.request.tokenIn === key.currency0;
  assert.equal(plan[from0 ? 'amount0' : 'amount1'], gross);
  assert.equal(plan[from0 ? 'amount1' : 'amount0'], BigInt(route.uniswap.minimumAmountOutRaw));
  assert.equal(plan.swap, null); assert.equal(plan.routed.totalInput, total);
  assert.ok(plan.mint.maxAmount0 <= plan.amount0 && plan.mint.maxAmount1 <= plan.amount1);
  assert.throws(() => routedBatchPlan(route, gross - 1n, key, range, 2n ** 96n), /invalid_routed_swap/);
  assert.throws(() => routedBatchPlan({ ...route, decision: 'pool' }, total, key, range, 2n ** 96n), /invalid_routed_swap/);
});
test('route review identity changes with net economics, owner, slippage and deposit; not with refreshed deadlines', () => {
  const original = routedTermsKey(route, 10000000n);
  const copy = structuredClone(route); copy.expiresAt += 20; copy.requestedAt += 20;
  assert.equal(routedTermsKey(copy, 10000000n), original);
  for (const change of [p => p.uniswap.minimumAmountOutRaw = '1', p => p.uniswap.feeRaw = '1', p => p.request.owner = other, p => p.request.slippageBps++]) {
    const changed = structuredClone(route); change(changed);
    assert.notEqual(routedTermsKey(changed, 10000000n), original);
  }
  assert.notEqual(routedTermsKey(route, 10000001n), original);
});
