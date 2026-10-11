import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { createSignInFlow } = require('../.test-build/app/src/session/signInFlow.js');
const pause = () => new Promise(resolve => setImmediate(resolve));
function rig(chainId = 4663, options = {}) {
  const calls = [], subscribers = new Set();
  let snapshot = { identity: { kind: 'connected', address: '0xabc', connectorUid: 'wallet-a', connectorName: 'Wallet', chainId }, view: { status: chainId === 4663 ? 'signed_out' : 'wrong_network', reason: 'none', chainId }, epoch: 1, busy: false, away: false };
  const update = (patch) => { snapshot = { ...snapshot, ...patch }; for (const listener of subscribers) listener(); };
  const ports = {
    getSnapshot: () => snapshot,
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    dispatch(event) {
      calls.push(event.type);
      if (event.type === 'sign_in') {
        update({ view: { status: 'signing_in', step: 'awaiting_signature' }, busy: true });
        if (!options.holdSignature) queueMicrotask(() => update({ view: options.decline ? { status: 'signed_out', reason: 'signature_declined' } : { status: 'signed_in', owner: '0xabc', expiresAt: '2026-10-12T00:00:00Z' }, busy: false }));
      } else if (event.type === 'cancel') update({ view: { status: 'signed_out', reason: 'signin_cancelled' }, busy: false });
    },
    async switchNetwork(target) {
      calls.push(target);
      const result = await options.switch?.(target, update, snapshot);
      if (result && result !== 'switched') return result;
      update({ identity: { ...snapshot.identity, chainId: target }, epoch: snapshot.epoch + 1, view: target === 4663 ? { status: 'checking' } : { status: 'wrong_network', chainId: target }, busy: target === 4663, away: target !== 4663 });
      if (target === 4663) queueMicrotask(() => update({ view: options.restored ? { status: 'signed_in', owner: '0xabc', expiresAt: 'later' } : { status: 'signed_out', reason: 'none' }, busy: false }));
      return 'switched';
    },
    networkName: id => id === 8453 ? 'Base' : 'Arbitrum One',
    canReturn: () => true,
    explain: s => s.view.reason ?? s.view.status,
    switchError: result => result,
  };
  const flow = createSignInFlow(ports);
  return { flow, calls, update, snapshot: () => snapshot, subscribers };
}

test('a deliberate sign-in on Robinhood asks for one message, not a network switch', async () => {
  const r = rig(); await r.flow.start();
  assert.deepEqual(r.calls, ['sign_in']); assert.equal(r.flow.getSnapshot().phase, 'idle'); assert.equal(r.subscribers.size, 0);
});
test('each supported away network switches, checks, signs once and returns after verification', async () => {
  for (const chain of [8453, 42161, 10, 1]) {
    const r = rig(chain); await r.flow.start();
    assert.deepEqual(r.calls, [4663, 'sign_in', chain]); assert.equal(r.snapshot().identity.chainId, chain);
  }
});
test('a session restored during the expected network change needs no signature', async () => {
  const r = rig(8453, { restored: true }); await r.flow.start(); assert.deepEqual(r.calls, [4663, 8453]);
});
test('rejected or pending network switches never request a sign-in message', async () => {
  for (const result of ['user_rejected', 'pending', 'unknown_chain', 'error']) {
    const r = rig(8453, { switch: async () => result }); await r.flow.start();
    assert.deepEqual(r.calls, [4663]); assert.equal(r.flow.getSnapshot().phase, 'error');
  }
});
test('an account or connector changed while switching cancels the old continuation', async () => {
  for (const identity of [{ address: '0xdef' }, { connectorUid: 'wallet-b' }]) {
    const r = rig(8453, { switch: async (_id, update, snapshot) => { update({ identity: { ...snapshot.identity, ...identity } }); return 'error'; } });
    await r.flow.start(); assert.deepEqual(r.calls, [4663]); assert.equal(r.flow.getSnapshot().phase, 'idle');
  }
});
test('two controls cannot open two signatures; cancellation frees the intent without a reload', async () => {
  const r = rig(4663, { holdSignature: true }); const first = r.flow.start(); await pause();
  await r.flow.start(); assert.deepEqual(r.calls, ['sign_in']);
  r.flow.cancel(); await first; assert.deepEqual(r.calls, ['sign_in', 'cancel']); assert.equal(r.subscribers.size, 0);
});
test('declining the message remains retryable and never switches back as if signed in', async () => {
  const r = rig(8453, { decline: true }); await r.flow.start();
  assert.deepEqual(r.calls, [4663, 'sign_in']); assert.equal(r.flow.getSnapshot().message, 'signature_declined');
});
test('a declined return keeps the authenticated session and offers an explicit network-only retry', async () => {
  let rejected = true;
  const r = rig(8453, { switch: async id => id === 8453 && rejected ? 'user_rejected' : 'switched' });
  await r.flow.start(); assert.equal(r.snapshot().view.status, 'signed_in'); assert.equal(r.flow.getSnapshot().returnChain, 8453);
  rejected = false; await r.flow.start(); assert.deepEqual(r.calls, [4663, 'sign_in', 8453, 8453]);
});
test('a valid away session and checking state cannot start a new signature', async () => {
  const r = rig(8453); r.update({ away: true }); await r.flow.start(); assert.deepEqual(r.calls, []);
  r.update({ away: false, view: { status: 'checking' }, busy: true }); await r.flow.start(); assert.deepEqual(r.calls, []);
});

test('a wallet change releases an unanswered switch so the new account can sign in', async () => {
  let release;
  const r = rig(8453, { switch: () => new Promise(resolve => { release = resolve; }) });
  const old = r.flow.start(); await pause();
  r.update({ identity: { ...r.snapshot().identity, address: '0xdef', chainId: 4663 }, view: { status: 'signed_out', reason: 'none' } });
  await r.flow.start(); assert.deepEqual(r.calls, [4663, 'sign_in']);
  release('error'); await old; assert.equal(r.flow.getSnapshot().phase, 'idle');
});

test('a paused return belongs only to the account and connector that signed in', async () => {
  const r = rig(8453, { switch: async id => id === 8453 ? 'user_rejected' : 'switched' });
  await r.flow.start(); assert.equal(r.flow.getSnapshot().returnChain, 8453);
  r.update({ identity: { ...r.snapshot().identity, connectorUid: 'different' } });
  assert.equal(r.flow.getSnapshot().phase, 'idle'); assert.equal(r.flow.getSnapshot().returnChain, undefined);
});
