/**
 * The private cache on a real TanStack QueryClient, driven with the exact
 * options usePrivateQuery passes (privateQueryOptions). A read that is still in
 * flight when the account, network, connector or session changes must never
 * put its answer where the next scope, or anyone, can read it.
 *
 * Each read here ignores its AbortSignal and resolves when the test says so,
 * like a server answer that arrives after the switch regardless.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, test } from 'node:test';

const require = createRequire(import.meta.url);
const { QueryObserver } = require('@tanstack/react-query');
const { privateQueryClient, privateQueryOptions, privateKey, clearPrivate, storePrivate } = require(
  '../.test-build/app/src/session/privateQuery.js',
);

const A = { connectorUid: 'uid-a', address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', chainId: 4663, epoch: 3 };
const B = { ...A, address: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', epoch: 4 };
const A_NEXT_SESSION = { ...A, epoch: 4 };
const PARTS = ['positions'];

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A query function whose answer the test releases, and which records its signals. */
function controlledRead() {
  const calls = [];
  const fn = (signal) =>
    new Promise((resolve) => {
      calls.push({ signal, resolve });
    });
  return { fn, calls };
}

/** What a mounted usePrivateQuery does: one observer, re-pointed as the scope changes. */
function mount(scope, fn) {
  const observer = new QueryObserver(privateQueryClient, privateQueryOptions(scope, PARTS, fn));
  const seen = [];
  const unsubscribe = observer.subscribe((result) => {
    if (result.data !== undefined) seen.push(result.data);
  });
  return {
    observer,
    seen,
    rescope: (next) => observer.setOptions(privateQueryOptions(next, PARTS, fn)),
    unsubscribe,
  };
}

const everyValue = () =>
  privateQueryClient
    .getQueryCache()
    .getAll()
    .filter((query) => query.state.data !== undefined)
    .map((query) => query.state.data);

afterEach(() => {
  clearPrivate();
});

test('the options key every read by scope and leave it disabled without one', () => {
  const { fn, calls } = controlledRead();
  assert.deepEqual(privateQueryOptions(A, PARTS, fn).queryKey, privateKey(A, ...PARTS));
  assert.equal(privateQueryOptions(A, PARTS, fn).enabled, true);
  const view = mount(null, fn);
  assert.equal(view.observer.getCurrentResult().fetchStatus, 'idle');
  assert.equal(calls.length, 0, 'nothing is read without a signed-in scope');
  view.unsubscribe();
});

test("a read in flight when A's scope ends is cancelled, and its late answer is kept nowhere", async () => {
  const { fn, calls } = controlledRead();
  const view = mount(A, fn);
  await settle();
  assert.equal(calls.length, 1);

  // The switch: the controller clears, and the component loses its scope.
  clearPrivate();
  view.rescope(null);
  assert.equal(calls[0].signal.aborted, true, 'the read was cancelled');

  calls[0].resolve('secret-of-A');
  await settle();
  assert.equal(privateQueryClient.getQueryData(privateKey(A, ...PARTS)), undefined);
  assert.deepEqual(everyValue(), []);
  assert.deepEqual(view.seen, []);
  assert.equal(view.observer.getCurrentResult().data, undefined);
  view.unsubscribe();
});

test("A's late answer never reaches B, even when it lands after B's own read started", async () => {
  const { fn, calls } = controlledRead();
  const view = mount(A, fn);
  await settle();

  clearPrivate();
  view.rescope(B);
  await settle();
  assert.equal(calls.length, 2, "B's read started");

  calls[0].resolve('secret-of-A');
  await settle();
  assert.equal(privateQueryClient.getQueryData(privateKey(B, ...PARTS)), undefined, 'B shows nothing yet');
  assert.deepEqual(view.seen, []);

  calls[1].resolve('secret-of-B');
  await settle();
  assert.deepEqual(everyValue(), ['secret-of-B']);
  assert.deepEqual(view.seen, ['secret-of-B']);
  view.unsubscribe();
});

test('the same account in a new server session never sees the old session’s late answer', async () => {
  const { fn, calls } = controlledRead();
  const view = mount(A, fn);
  await settle();

  clearPrivate();
  view.rescope(A_NEXT_SESSION);
  await settle();
  calls[0].resolve('from-the-old-session');
  await settle();
  assert.equal(privateQueryClient.getQueryData(privateKey(A_NEXT_SESSION, ...PARTS)), undefined);
  assert.deepEqual(view.seen, []);

  calls[1].resolve('from-the-new-session');
  await settle();
  assert.deepEqual(everyValue(), ['from-the-new-session']);
  view.unsubscribe();
});

test('two connector instances for the same account never share a key, even when they announce the same rdns', () => {
  // Both providers announced one rdns; wagmi made a connector, with its own
  // uid, for each. Same account, chain and epoch: only the instance differs.
  const viaB = { ...A, connectorUid: 'uid-b' };
  assert.notDeepEqual(privateKey(viaB, 'session'), privateKey(A, 'session'));
  storePrivate(A, { owner: A.address.toLowerCase() });
  assert.equal(privateQueryClient.getQueryData(privateKey(viaB, 'session')), undefined, 'what A stored is not readable through B');
});

test('clearing drops the stored identity and every settled read with it', async () => {
  storePrivate(A, { owner: A.address.toLowerCase() });
  const { fn, calls } = controlledRead();
  const view = mount(A, fn);
  await settle();
  calls[0].resolve('settled');
  await settle();
  assert.equal(everyValue().length, 2);
  clearPrivate();
  assert.deepEqual(everyValue(), []);
  view.unsubscribe();
});
