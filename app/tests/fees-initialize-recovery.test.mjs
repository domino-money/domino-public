import test from 'node:test';
import assert from 'node:assert/strict';
import { addressTopic, fakeChain, fees, memoryCache, owned, rpcLog, word } from './support/fees/fake-chain.mjs';

const ORIGIN = 'https://domino.money';
const POOL = `0x${'11'.repeat(32)}`;
const OTHER = `0x${'22'.repeat(32)}`;
const WINDOW = owned.LOG_BLOCKS_ONE;
const initialize = (block, pool = POOL) => rpcLog({
  topics: [fees.TOPIC.Initialize, pool, addressTopic('0x1111111111111111111111111111111111111111'), addressTopic('0x2222222222222222222222222222222222222222')],
  data: `0x${[40000, 400, 0, 1n << 96n, 0].map(word).join('')}`,
  block,
});
const ranges = (chain) => chain.log.filter((call) => call.method === 'eth_getLogs').map((call) => call.params[0]).map((filter) => [Number(filter.fromBlock), Number(filter.toBlock)]);
const read = (chain, cache, pool = POOL, origin = ORIGIN) => fees.logsOnChain({ deps: chain.deps, cache }, origin, { kind: 'initialize', poolId: pool });
const refused = { error: { code: -32000, message: 'internal error' } };

test.beforeEach(() => fees.resetRelayMemory());

test('initialize resumes completed final empty coverage after a later failure, even as the head advances', async () => {
  for (const completed of [1, 2]) {
    fees.resetRelayMemory();
    const head = 76_600_000;
    const block = head - (completed + 0.5) * WINDOW;
    const chain = fakeChain({ head, logs: [initialize(block)], script: { eth_getLogs: [...Array.from({ length: completed }, () => ({ result: [] })), refused] } });
    const { cache } = memoryCache();
    const first = await read(chain, cache);
    assert.equal(first.ok, false, 'a failed search is not a completed absence');
    assert.equal(first.failure, 'unavailable');
    assert.equal(ranges(chain).length, completed + 1);
    chain.deps.time += 60_000;
    chain.head += 600;
    const before = ranges(chain).length;
    const recovered = await read(chain, cache);
    assert.equal(recovered.ok, true);
    assert.deepEqual(recovered.value.units[0].logs.map((log) => log[0]), [block]);
    assert.equal(recovered.value.units[0].final, true);
    assert.deepEqual(ranges(chain).slice(before), [
      [head - fees.SAFE_DEPTH + 1, chain.head],
      [head - (completed + 1) * WINDOW + 1, head - completed * WINDOW],
    ], 'only the unsafe/new tail and the previously failed window are read');
    assert.ok(ranges(chain).every(([from, to]) => to - from + 1 <= WINDOW), 'existing RPC window limit');
    const after = ranges(chain).length;
    chain.deps.time += 60_000;
    assert.equal((await read(chain, cache)).ok, true);
    assert.equal(ranges(chain).length, after, 'a found final event still uses the existing result cache');
  }
});

test('initialize never finalizes the recent tail: a newly visible or reorged event is read again', async () => {
  const head = 76_600_000;
  const chain = fakeChain({ head, script: { eth_getLogs: [{ result: [] }, refused] } });
  const { cache } = memoryCache();
  assert.equal((await read(chain, cache)).ok, false);
  chain.logs = [initialize(head - 10)];
  chain.deps.time += 60_000;
  const before = ranges(chain).length;
  const recent = await read(chain, cache);
  assert.equal(recent.ok, true);
  assert.equal(recent.value.units[0].final, false);
  assert.deepEqual(recent.value.units[0].logs.map((log) => log[0]), [head - 10]);
  assert.deepEqual(ranges(chain).slice(before), [[head - fees.SAFE_DEPTH + 1, head]]);
  chain.logs = [initialize(head - 20)];
  const changed = await read(chain, cache);
  assert.equal(changed.ok, true);
  assert.deepEqual(changed.value.units[0].logs.map((log) => log[0]), [head - 20], 'no nonfinal event is pinned by the coverage cache');
});

test('initialize does not cache a failed or invalid window as empty', async () => {
  const head = 76_600_000;
  const block = head - 1_000_000;
  const chain = fakeChain({ head, logs: [initialize(block)], script: { eth_getLogs: [{ result: [{ ...initialize(block), removed: true }] }] } });
  const { cache, stored } = memoryCache();
  assert.equal((await read(chain, cache)).ok, false);
  assert.equal(stored.size, 0, 'validation failed before any complete empty coverage existed');
  const recovered = await read(chain, cache);
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.value.units[0].logs.map((log) => log[0]), [block]);
  assert.deepEqual(ranges(chain)[1], ranges(chain)[0], 'the failed window is really read again');
});

test('initialize empty coverage is pool/origin scoped and never becomes a final absent event', async () => {
  const head = 2 * WINDOW + 50_000;
  const chain = fakeChain({ head });
  const { cache } = memoryCache();
  const absent = await read(chain, cache);
  assert.equal(absent.ok, true);
  assert.deepEqual(absent.value.units[0].logs, []);
  assert.equal(absent.value.units[0].final, false);
  chain.head += 600;
  chain.deps.time += 60_000;
  chain.logs = [initialize(chain.head - 1), initialize(WINDOW, OTHER)];
  const before = ranges(chain).length;
  const added = await read(chain, cache);
  assert.equal(added.ok, true);
  assert.deepEqual(added.value.units[0].logs.map((log) => log[0]), [chain.head - 1]);
  assert.deepEqual(ranges(chain).slice(before), [[head - fees.SAFE_DEPTH + 1, chain.head]]);
  const other = await read(chain, cache, OTHER);
  assert.equal(other.ok, true);
  assert.deepEqual(other.value.units[0].logs.map((log) => log[0]), [WINDOW], 'another pool has independent empty coverage');
  chain.logs = [initialize(WINDOW)];
  const origin = await read(chain, cache, POOL, 'https://preview.domino.money');
  assert.equal(origin.ok, true);
  assert.deepEqual(origin.value.units[0].logs.map((log) => log[0]), [WINDOW], 'another origin has independent empty coverage');
});
