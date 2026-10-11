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

test('a recovered token causes one coherent portfolio reread, once per owner chain and address', async () => {
  const warmed = [], refreshed = [], body = setup();
  const recovery = createPriceRecovery({ warm: async target => { warmed.push(target); return true; }, refresh: wallet => refreshed.push(wallet) });
  await recovery.run(body, () => true);
  await recovery.run(body, () => true);
  assert.equal(warmed.length, 1); assert.deepEqual(refreshed, [body.wallet]);
  const other = structuredClone(body); other.wallet = '0x' + 'dd'.repeat(20);
  await recovery.run(other, () => true);
  assert.equal(warmed.length, 2); assert.deepEqual(refreshed, [body.wallet, other.wallet]);
  assert.equal(warmed[1].wallet, other.wallet);
});

test('hidden or abandoned owners never start another targeted read or receive a follow-up refresh', async () => {
  const body = setup(), warmed = [], refreshed = [];
  let release, active = true;
  const answer = new Promise(resolve => { release = resolve; });
  const recovery = createPriceRecovery({ warm: async target => { warmed.push(target); return answer; }, refresh: wallet => refreshed.push(wallet) });
  await recovery.run(body, () => false);
  assert.equal(warmed.length, 0);
  const waiting = recovery.run(body, () => active);
  await recovery.run(body, () => active);
  assert.equal(warmed.length, 1, 'parallel components share one recovery');
  active = false; release(true); await waiting;
  assert.deepEqual(refreshed, [], 'late shared replies cannot refresh the abandoned wallet');
});

test('recovery is serial, bounded across many positions and never loops after failed target reads', async () => {
  const body = setup(), sample = body.positions[0], token = body.tokens[1];
  body.positions = Array.from({ length: 10 }, (_, i) => {
    const address = '0x' + (i + 1).toString(16).padStart(40, '0');
    body.tokens.push({ ...token, address });
    return { ...sample, tokenId: String(i + 100), state: { ...sample.state, pool: { ...sample.state.pool, currency1: address } } };
  });
  let current = 0, max = 0, count = 0, refreshes = 0;
  const recovery = createPriceRecovery({ warm: async () => { count++; current++; max = Math.max(max, current); await new Promise(setImmediate); current--; return false; }, refresh: () => refreshes++ });
  await recovery.run(body, () => true); assert.equal(count, 3);
  await recovery.run(body, () => true); assert.equal(count, 6);
  await recovery.run(body, () => true); assert.equal(count, 6, 'six distinct tokens per wallet visit is the hard ceiling');
  assert.equal(max, 1); assert.equal(refreshes, 0);
});
