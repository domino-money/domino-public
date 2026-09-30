import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fixtureRelay, loadCase, stateOfCase } from './support/fees/relay-fixture.mjs';

const require = createRequire(import.meta.url);
const { createHistoryCache, HISTORY_CACHE_KEY, HISTORY_MAX_AGE_MS, HISTORY_MAX_ENTRIES, HISTORY_MAX_CHARS, savedHistoryMatches } = require('../.test-build/app/src/lib/fees/historyCache.js');
const { runPipeline } = require('../.test-build/app/src/lib/fees/pipeline.js');
const fixture = loadCase('3136705');
const { state, growth } = stateOfCase(fixture);
const result = await runPipeline({ logs: fixtureRelay(fixture).logs, sleep: async () => {} }, { id: '3136705', state, growth, budgetBytes: 16 * 1024 * 1024, checkpoint: null });
assert.equal(result.ok, true);
const verified = { phase: 'verified', state, history: result.history, prices: result.prices };
const initialTime = state.timestamp * 1000 + 1000;
function fixtureCache() {
  const values = new Map();
  let time = initialTime;
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const cache = createHistoryCache(() => storage, () => time);
  return { values, storage, cache, advance(ms) { time += ms; } };
}
test('a real completed replay round-trips as cached public presentation, never current state or checkpoint', () => {
  const f = fixtureCache();
  f.cache.save('3136705', verified);
  const saved = f.cache.load('3136705');
  assert.ok(saved, 'fixture is eligible');
  assert.equal(saved.phase, 'cached');
  assert.equal(saved.source, 'public-chain-replay');
  assert.deepEqual(saved.history, verified.history);
  assert.deepEqual(saved.prices, verified.prices);
  assert.equal(saved.state.block, verified.state.block);
  assert.equal(saved.savedAt, initialTime);
  const text = f.values.get(HISTORY_CACHE_KEY);
  assert.ok(!text.includes(state.owner));
  for (const field of ['owner', 'checkpoint', 'growth', 'wallet', 'session', 'automation']) assert.ok(!text.includes(`"${field}"`), field);
  assert.equal(f.cache.load('1'), null, 'a different tokenId cannot select the snapshot');
});
test('estimates cannot be saved and missing decimals remain missing, never guessed', () => {
  const f = fixtureCache();
  f.cache.save('1', { ...verified, phase: 'estimated' });
  assert.equal(f.cache.load('1'), null);
  const next = structuredClone(verified);
  next.state.currencies[0].decimals = null;
  f.cache.save('2', next);
  assert.equal(f.cache.load('2')?.state.currencies[0].decimals, null);
});
test('expiry uses snapshot age as well as save age and never extends when read', () => {
  const f = fixtureCache();
  f.cache.save('3136705', verified);
  f.advance(HISTORY_MAX_AGE_MS - 2000);
  assert.ok(f.cache.load('3136705'));
  f.advance(1001);
  assert.equal(f.cache.load('3136705'), null);
  f.cache.save('3136705', verified);
  assert.equal(f.cache.load('3136705'), null, 'saving an old end does not make it fresh');
});
test('invalid version, chain, deployment identity, token id and malformed JSON fail closed', () => {
  const f = fixtureCache();
  f.cache.save('3136705', verified);
  const original = f.values.get(HISTORY_CACHE_KEY);
  for (const mutate of [
    data => { data.identity = data.identity.replace(':4663:', ':1:'); },
    data => { data.identity = data.identity.replace(/^1:/, '2:'); },
    data => { data.identity += ':other-contract'; },
    data => { data.entries[0].id = '03136705'; },
    data => { data.entries[0].id = '-1'; },
    data => { data.entries[0].snapshot.source = 'session'; },
  ]) {
    const data = JSON.parse(original); mutate(data);
    f.values.set(HISTORY_CACHE_KEY, JSON.stringify(data));
    assert.equal(f.cache.load('3136705'), null);
  }
  f.values.set(HISTORY_CACHE_KEY, '{');
  assert.equal(f.cache.load('3136705'), null);
});
test('bounded validator rejects poisoned accounting shape, identities, metadata and future time', () => {
  const f = fixtureCache();
  f.cache.save('3136705', verified);
  const original = f.values.get(HISTORY_CACHE_KEY);
  for (const mutate of [
    s => { s.savedAt += 60_000; },
    s => { s.state.owner = state.owner; },
    s => { s.checkpoint = {}; },
    s => { s.state.poolId = '0x123'; },
    s => { s.state.currencies[0].address = 'USDG'; },
    s => { s.state.currencies[0].decimals = 256; },
    s => { s.state.currencies[0].symbol = 'x'.repeat(65); },
    s => { s.state.unclaimed[0] = '-1'; },
    s => { s.history.earned[0] = '1'; },
    s => { s.history.hourly.reverse(); },
    s => { s.history.hourly.at(-1).t = 0; },
    s => { s.history.checks.tickMismatch = 1; },
    s => { s.history.events[0].tx = 'javascript:alert(1)'; },
    s => { s.prices.hours[0].sqrtPriceX96Close = '0'; },
  ]) {
    const data = JSON.parse(original); mutate(data.entries[0].snapshot);
    f.values.set(HISTORY_CACHE_KEY, JSON.stringify(data));
    assert.equal(f.cache.load('3136705'), null, mutate.toString());
  }
});
test('retention and oversized payloads are bounded; removals do not affect another token', () => {
  const f = fixtureCache();
  for (let id = 1; id <= 12; id++) f.cache.save(String(id), verified);
  const data = JSON.parse(f.values.get(HISTORY_CACHE_KEY));
  assert.equal(data.entries.length, HISTORY_MAX_ENTRIES);
  assert.equal(f.cache.load('1'), null);
  assert.ok(f.cache.load('12'));
  f.cache.remove('12');
  assert.equal(f.cache.load('12'), null);
  assert.ok(f.cache.load('11'));
  f.values.set(HISTORY_CACHE_KEY, ' '.repeat(HISTORY_MAX_CHARS + 1));
  assert.equal(f.cache.load('11'), null);
});
test('quota, disabled storage, getter failures and browser absence never affect live reading', () => {
  const throws = () => { throw new Error('storage disabled'); };
  for (const access of [() => null, throws, () => ({ getItem: throws, setItem: throws, removeItem: throws })]) {
    const cache = createHistoryCache(access, () => initialTime);
    assert.doesNotThrow(() => cache.save('3136705', verified));
    assert.equal(cache.load('3136705'), null);
    assert.doesNotThrow(() => cache.remove('3136705'));
  }
  const f = fixtureCache();
  f.cache.save('3136705', verified);
  f.storage.setItem = throws;
  f.cache.save('2', verified);
  assert.equal(f.values.size, 0, 'failed quota write removes only this application cache');
});
test('new current read invalidates changed pool/range/currency/liquidity and same-block conflict', () => {
  const f = fixtureCache();
  f.cache.save('3136705', verified);
  const saved = f.cache.load('3136705');
  assert.ok(savedHistoryMatches(saved, state));
  assert.ok(savedHistoryMatches(saved, { ...state, block: state.block + 10, timestamp: state.timestamp + 1, sqrtPriceX96: state.sqrtPriceX96 + 1n }));
  for (const live of [
    { ...state, block: state.block - 1 }, { ...state, timestamp: state.timestamp - 1 },
    { ...state, sqrtPriceX96: state.sqrtPriceX96 + 1n }, { ...state, liquidity: state.liquidity + 1n },
    { ...state, tickLower: state.tickLower + 1 }, { ...state, poolId: `0x${'1'.repeat(64)}` },
    { ...state, currencies: [...state.currencies].reverse() },
  ]) assert.equal(savedHistoryMatches(saved, live), false);
});
