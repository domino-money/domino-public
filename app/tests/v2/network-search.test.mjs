/**
 * The other networks' search in New position (2026-10-06, the owner's point 3: on Base and Arbitrum One the search
 * "sometimes only brings Robinhood Chain"), what is pure of it (src/v2in/journey/model/networkSearch.ts), with its reads
 * and its clock in the test's hands:
 *   - only the newest text the open list asks is asked, one read at a time per network, and an answer to an older text
 *     is ignored, so an abandoned search never holds more than its one read;
 *   - a read that failed for the moment is asked again after a quiet wait, a few times, only while the list asks for its
 *     text; a route that is off, a failure for good, or spent re-asks leave the network's own currencies standing in;
 *   - a pasted address is looked up on each network, never where it is one of the network's own currencies;
 *   - `pending` says some network is still being searched for a text.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { createNetworkSearch, searchable } = require('../../.test-build/app/src/v2in/journey/model/networkSearch.js');

const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TOKEN = '0x1111111111111111111111111111111111111111';
const flush = () => new Promise((resolve) => setImmediate(resolve));
const row = (chainId, symbol) => ({ chainId, network: chainId === 8453 ? 'Base' : 'Arbitrum One', token: { origin: 'read', chainId, address: TOKEN, symbol, decimals: 18, readStatus: 'available', artwork: null }, unread: false });

/** A search over Base and Arbitrum One whose reads the test answers by hand, with a clock it runs by hand. */
function harness({ own = () => false, delay = (attempt) => (attempt < 2 ? 1000 * (attempt + 1) : null) } = {}) {
  const calls = [];
  const waits = [];
  const store = createNetworkSearch({
    chains: [8453, 42161],
    read: (chainId, text) => new Promise((answer) => calls.push({ chainId, text, answer })),
    own,
    delay,
    after: (ms, run) => {
      const wait = { ms, run, cancelled: false };
      waits.push(wait);
      return () => { wait.cancelled = true; };
    },
  });
  const heard = [];
  store.subscribe(() => heard.push(store.version()));
  /** Answers the one read out for `chainId` (the oldest unanswered), and lets the store take it. */
  const answer = async (chainId, said) => {
    const call = calls.find((entry) => entry.chainId === chainId && !entry.done);
    assert.ok(call, `a read out on ${chainId}`);
    call.done = true;
    call.answer(said);
    await flush();
  };
  const asked = () => calls.map((call) => `${call.chainId}:${call.text}`);
  return { store, calls, waits, heard, answer, asked };
}

test('the text asked: two characters at least, or a whole address in lower case', () => {
  assert.deepEqual(['e', ' us ', '0x12', TOKEN.toUpperCase().replace('0X', '0x'), 'Virtual Protocol'].map(searchable), [null, 'us', null, TOKEN, 'Virtual Protocol']);
});

test('only the newest text is asked, one read at a time per network; an answer to an older text is ignored', async () => {
  const { store, answer, asked, heard } = harness();
  const stopVi = store.ask('vi');
  assert.deepEqual(asked(), ['8453:vi', '42161:vi']);
  // Typing on: the list stops asking for "vi" and asks for "vir", then "virtual", while both reads are still out.
  stopVi();
  const stopVir = store.ask('vir');
  stopVir();
  store.ask('virtual');
  assert.deepEqual(asked(), ['8453:vi', '42161:vi'], 'no second read while one is out on a network');
  await answer(8453, { kind: 'hits', rows: [row(8453, 'VI')] });
  assert.equal(store.found(8453, 'vi'), undefined, 'the stale answer is ignored');
  assert.deepEqual(asked(), ['8453:vi', '42161:vi', '8453:virtual'], 'the newest text, once the network is free');
  await answer(42161, { kind: 'hits', rows: [] });
  assert.deepEqual(asked().slice(3), ['42161:virtual'], '"vir" was never asked');
  assert.equal(store.pending('virtual'), true);
  await answer(8453, { kind: 'hits', rows: [row(8453, 'VIRTUAL')] });
  await answer(42161, { kind: 'hits', rows: [] });
  assert.deepEqual(store.found(8453, 'virtual').map((hit) => hit.token.symbol), ['VIRTUAL']);
  assert.deepEqual(store.found(42161, 'virtual'), []);
  assert.equal(store.pending('virtual'), false);
  assert.ok(heard.length >= 2, 'the search hears each answer');
  // Asked again for a text already answered: nothing is read.
  store.ask('virtual');
  assert.equal(asked().length, 4);
});

test('a failure that may pass is asked again after its quiet wait, a few times, only while the list asks for its text', async () => {
  const { store, answer, asked, waits } = harness();
  store.ask('usd');
  await answer(8453, { kind: 'failed', passing: true });
  await answer(42161, { kind: 'hits', rows: [] });
  assert.equal(store.pending('usd'), true, 'Base is still being searched');
  assert.deepEqual(waits.map((wait) => wait.ms), [1000]);
  waits[0].run();
  assert.deepEqual(asked(), ['8453:usd', '42161:usd', '8453:usd'], 'asked again after the wait');
  await answer(8453, { kind: 'failed', passing: true });
  waits[1].run();
  await answer(8453, { kind: 'failed', passing: true });
  assert.deepEqual(waits.map((wait) => wait.ms), [1000, 2000], 'no third wait: the re-asks are spent');
  assert.equal(store.pending('usd'), false, 'done: the network’s own currencies stand in');
  assert.equal(store.found(8453, 'usd'), undefined);
  // A failure for good, or a route that is off, is done at once.
  const other = harness();
  other.store.ask('eth');
  await other.answer(8453, { kind: 'failed', passing: false });
  await other.answer(42161, { kind: 'off' });
  assert.equal(other.waits.length, 0);
  assert.equal(other.store.pending('eth'), false);
});

// Added 2026-10-06 (rugged's answer of 6 Oct, §1: the gateway's Retry-After is now the real time to the lane's next token):
// a busy reader's search is asked again no sooner than its Retry-After, which the wait is told.
test('a busy reader’s Retry-After reaches the wait before the search is asked again', async () => {
  const told = [];
  const { store, answer, asked, waits } = harness({ delay: (attempt, retryAfterS) => { told.push([attempt, retryAfterS]); return attempt < 2 ? Math.max(1000, (retryAfterS ?? 0) * 1000) : null; } });
  store.ask('usd');
  await answer(8453, { kind: 'failed', passing: true, retryAfterS: 7 });
  await answer(42161, { kind: 'failed', passing: true });
  assert.deepEqual(told, [[0, 7], [0, undefined]]);
  assert.deepEqual(waits.map((wait) => wait.ms), [7000, 1000], 'Base waits the 7 s its reader asked; Arbitrum One the quiet wait');
  waits[0].run();
  assert.deepEqual(asked(), ['8453:usd', '42161:usd', '8453:usd']);
});

test('the list closing stops a waiting re-ask; opened again, the text is asked afresh', async () => {
  const { store, answer, asked, waits } = harness();
  const stop = store.ask('aero');
  await answer(8453, { kind: 'failed', passing: true });
  await answer(42161, { kind: 'hits', rows: [] });
  assert.equal(waits.length, 1);
  stop();
  assert.equal(waits[0].cancelled, true, 'nothing is asked for a list nobody has open');
  waits[0].run();
  assert.equal(asked().length, 2, 'a cancelled wait asks nothing even if its timer fires');
  store.ask('aero');
  assert.deepEqual(asked().slice(2), ['8453:aero'], 'asked afresh; Arbitrum One’s answer is kept');
  await answer(8453, { kind: 'hits', rows: [row(8453, 'AERO')] });
  assert.equal(store.found(8453, 'aero').length, 1);
  // Another text while a re-ask waits: the wait for the old text is dropped and the new text asked.
  const next = harness();
  next.store.ask('wif');
  await next.answer(8453, { kind: 'failed', passing: true });
  next.store.ask('wifi');
  assert.equal(next.waits[0].cancelled, true);
  assert.ok(next.asked().includes('8453:wifi'));
});

test('a pasted address is looked up on each network, never where it is one of the network’s own currencies', async () => {
  const own = (chainId, address) => chainId === 8453 && address === USDC_BASE;
  const { store, answer, asked } = harness({ own });
  assert.equal(store.pending(USDC_BASE), true, 'Arbitrum One still to be asked');
  store.ask(USDC_BASE.toUpperCase().replace('0X', '0x'));
  assert.deepEqual(asked(), [`42161:${USDC_BASE}`], 'Base’s own USDC is named without a read');
  await answer(42161, { kind: 'pasted', said: { state: 'none' } });
  assert.deepEqual(store.pasted(42161, USDC_BASE), { state: 'none' });
  assert.equal(store.pending(USDC_BASE), false);
  // Where a read fails, or the route is off, the address is "not read": the plain row, looked up once chosen.
  const other = harness();
  other.store.ask(TOKEN);
  await other.answer(8453, { kind: 'failed', passing: true });
  await other.answer(42161, { kind: 'off' });
  assert.deepEqual([other.store.pasted(8453, TOKEN), other.store.pasted(42161, TOKEN)], [{ state: 'unread' }, { state: 'unread' }]);
  assert.equal(other.waits.length, 0, 'a paste is never asked again by itself');
  const token = { origin: 'read', chainId: 8453, address: TOKEN, symbol: 'TKN', decimals: 18, readStatus: 'available', artwork: null };
  const named = harness();
  named.store.ask(TOKEN);
  await named.answer(8453, { kind: 'pasted', said: { state: 'token', token } });
  assert.deepEqual(named.store.pasted(8453, TOKEN), { state: 'token', token });
  assert.equal(named.store.pending(TOKEN), true, 'Arbitrum One still being looked up');
});

test('pending: a text some network has still to answer; never a short text or half an address', () => {
  const { store } = harness();
  assert.equal(store.pending('e'), false);
  assert.equal(store.pending('0x12'), false);
  assert.equal(store.pending('usdc'), true, 'not answered yet: the search is still on its way');
});

test('unavailable discovery is distinct from a successful empty search and clears before a reopened lookup', async () => {
  const { store, answer } = harness();
  const close = store.ask('basecat');
  await answer(8453, { kind: 'off' });
  await answer(42161, { kind: 'hits', rows: [] });
  assert.deepEqual(store.unavailable('basecat'), [8453], 'empty Arbitrum results are available, Base was not searched');
  close();
  store.ask('basecat');
  assert.deepEqual(store.unavailable('basecat'), [], 'the retried network is pending, not permanently unavailable');
  await answer(8453, { kind: 'hits', rows: [row(8453, 'BASECAT')] });
  assert.deepEqual(store.unavailable('basecat'), []);
  const pasted = harness();
  pasted.store.ask(TOKEN);
  await pasted.answer(8453, { kind: 'pasted', said: { state: 'unread' } });
  await pasted.answer(42161, { kind: 'pasted', said: { state: 'none' } });
  assert.deepEqual(pasted.store.unavailable(TOKEN), [8453], 'unread is not a missing token');
  const metadata = harness();
  const closeMetadata = metadata.store.ask(TOKEN);
  await metadata.answer(8453, { kind: 'pasted', said: { state: 'metadata_unavailable' } });
  await metadata.answer(42161, { kind: 'pasted', said: { state: 'token', token: row(42161, 'CAT').token } });
  assert.deepEqual(metadata.store.unavailable(TOKEN), [8453]);
  closeMetadata();
  metadata.store.ask(TOKEN);
  assert.deepEqual(metadata.store.unavailable(TOKEN), [], 'unread metadata can recover on another search');
});
