/**
 * New position on the second chain (src/chains/elysium/flow.ts, 2026-10-01, the chain2 workstream): rugged97's actions
 * service prepares every transaction as a draft (an exact approval first where one is missing, then the vault's open),
 * and the flow only drives it: a draft is used only when his verifyDraft accepts it and it is exactly what was asked,
 * the vault is inspected again before the wallet, the wallet is asked once per draft, a receipt is asked by itself until
 * it settles and must name the draft's own transaction, and the next draft waits for the previous one's confirmation.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as actions from '../functions/_lib/uniswap-v3/contracts/uniswap-v3-actions-v1/runtime.mjs';

const require = createRequire(import.meta.url);
const flow = require('../.test-build/app/src/chains/elysium/flow.js');
const { ServiceError } = require('../.test-build/app/src/chains/elysium/api.js');
const { ELYSIUM } = require('../.test-build/app/src/config/chains.js');

const WIRE = JSON.parse(readFileSync(new URL('./fixtures/elysium/uniswap-v3-actions-v1.wire.json', import.meta.url), 'utf8'));
const IDENTITY = WIRE.identity;
const INSPECT = WIRE.responses.inspect;
const OWNER = INSPECT.owner;
const VAULT = INSPECT.vault;
const INPUT = { owner: OWNER, vault: VAULT, tickLower: -600, tickUpper: 600, amount0Raw: '1000', amount1Raw: '2000', slippageBps: 50 };
const ACTION = { kind: 'open', tickLower: -600, tickUpper: 600, amount0Raw: '1000', amount1Raw: '2000', slippageBps: 50 };
const NOW_S = 1_790_685_600;

const canonical = (v) => (Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);
/** His draft id: SHA-256 of the canonical JSON of the draft without its id (his runtime's verifyDraft). */
const withId = (draft) => {
  const { id, ...body } = draft;
  return { ...body, id: `0x${createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex')}` };
};

/** A draft of `step` for the open action, prepared at the inspected state, its id his. */
function draft(step, nonce, extra = {}) {
  const base = structuredClone(WIRE.responses.prepare.draft);
  return withId({
    ...base,
    action: { ...ACTION },
    step,
    readyForAction: step === 'open',
    stateHash: INSPECT.stateHash,
    stateNonce: INSPECT.stateNonce,
    policyVersion: INSPECT.policyVersion,
    contractPins: INSPECT.contractPins,
    expiresAt: NOW_S + 600,
    transaction: { ...base.transaction, nonce, data: `0x${step === 'open' ? 'aa' : 'bb'}${'00'.repeat(4)}` },
    ...extra,
  });
}

const hashOf = (n) => `0x${n.toString(16).padStart(64, '0')}`;

/** His actions service, scripted: `prepared` and `receipts` are queues; every call is recorded. */
function service({ prepared, receipts, inspect = () => INSPECT }) {
  const asked = [];
  const api = {
    runtimes: { actions: { runtime: actions } },
    async actions(route, body, identity) {
      asked.push({ route, body, identity });
      if (route === 'prepare') {
        const next = prepared.shift();
        if (next instanceof Error) throw next;
        return { ...IDENTITY, contractVersion: '1.0.0-rc.2', qualification: 'unqualified', anchor: WIRE.responses.prepare.anchor, owner: OWNER, vault: VAULT, draft: next };
      }
      if (route === 'inspect') return inspect();
      if (route === 'receipt') {
        const next = receipts.shift();
        if (next instanceof Error) throw next;
        return next(body.transactionHash);
      }
      throw new Error(`unexpected ${route}`);
    },
  };
  return { api, asked };
}

const receipt = (state, d) => (hash) => ({
  ...IDENTITY,
  contractVersion: '1.0.0-rc.2',
  qualification: 'unqualified',
  vault: VAULT,
  owner: OWNER,
  transactionHash: hash,
  state,
  anchor: state === 'pending' ? null : { number: 4242, hash: `0x${'1'.repeat(64)}`, timestamp: NOW_S + 5 },
  transaction: state === 'pending' ? null : { from: d.transaction.from, to: d.transaction.to, data: d.transaction.data, valueRaw: d.transaction.valueRaw, nonce: d.transaction.nonce },
  gasUsedRaw: state === 'pending' ? null : '47601',
});

function harness({ prepared, receipts, inspect, signer }) {
  let now = NOW_S * 1000;
  const states = [];
  const sent = [];
  const settled = [];
  const { api, asked } = service({ prepared, receipts, inspect });
  const run = flow.createOpenFlow({
    chain: ELYSIUM,
    api,
    identity: IDENTITY,
    signer,
    now: () => now,
    pause: async (ms) => {
      now += ms;
    },
    onChange: (state) => states.push(state),
    sent: (t) => sent.push(t),
    settled: (...args) => settled.push(args),
  });
  return { run, states, sent, settled, asked, steps: () => states.map((s) => s.step), advance: (ms) => (now += ms) };
}

function wallet(hashes) {
  const calls = [];
  return {
    calls,
    async send(d) {
      calls.push(d);
      const next = hashes.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test('an approval, then the open: each drafted by his service, signed once, confirmed before the next is prepared', async () => {
  const approve = draft('approve-token0', 31);
  const open = draft('open', 32);
  const signer = wallet([hashOf(1), hashOf(2)]);
  const h = harness({ prepared: [approve, open], receipts: [receipt('pending', approve), receipt('confirmed', approve), receipt('confirmed', open)], signer });
  await h.run.start(INPUT);
  assert.equal(h.run.state().step, 'review');
  assert.equal(h.run.state().draft.step, 'approve-token0');
  await h.run.confirm();
  assert.equal(h.run.state().step, 'review', 'the open is prepared once the approval confirmed');
  assert.equal(h.run.state().transaction, 2);
  await h.run.confirm();
  assert.deepEqual(h.run.state(), { step: 'done', hashes: [hashOf(1), hashOf(2)], block: 4242 });
  assert.deepEqual(signer.calls.map((d) => d.step), ['approve-token0', 'open'], 'the wallet was asked exactly once per draft');
  assert.deepEqual(h.sent.map((t) => [t.hash, t.step]), [[hashOf(1), 'approve-token0'], [hashOf(2), 'open']]);
  assert.deepEqual(h.settled.map(([hash, state]) => [hash, state]), [[hashOf(1), 'confirmed'], [hashOf(2), 'confirmed']]);
  const routes = h.asked.map((a) => a.route);
  assert.deepEqual(routes, ['prepare', 'inspect', 'receipt', 'receipt', 'prepare', 'inspect', 'receipt']);
  assert.deepEqual(h.asked[0].body, { ...IDENTITY, owner: OWNER, vault: VAULT, action: ACTION });
  assert.ok(h.steps().includes('confirming') && h.steps().includes('wallet') && h.steps().includes('checking'));
});

test('a draft that is not exactly what was asked is never used, and the wallet is never asked', async () => {
  const cases = [
    draft('open', 1, { action: { ...ACTION, amount0Raw: '999999' } }),
    { ...draft('open', 1), id: `0x${'0'.repeat(64)}` },
    draft('open', 1, { owner: '0x0000000000000000000000000000000000000001' }),
    draft('open', 1, { expiresAt: NOW_S + 5 }),
    withId({ ...draft('open', 1), transaction: { ...draft('open', 1).transaction, chainId: 4663 } }),
  ];
  for (const bad of cases) {
    const signer = wallet([hashOf(9)]);
    const h = harness({ prepared: [bad], receipts: [], signer });
    await h.run.start(INPUT);
    assert.equal(h.run.state().step, 'stopped');
    assert.equal(h.run.state().reason, 'draft_changed');
    await h.run.confirm();
    assert.equal(signer.calls.length, 0);
  }
});

test('a vault that changed after the draft was prepared stops the flow before the wallet', async () => {
  const signer = wallet([hashOf(1)]);
  const h = harness({ prepared: [draft('open', 1)], receipts: [], inspect: () => ({ ...INSPECT, stateNonce: '4' }), signer });
  await h.run.start(INPUT);
  await h.run.confirm();
  assert.equal(h.run.state().reason, 'state_changed');
  assert.equal(signer.calls.length, 0);
});

test('a draft that expires while it is reviewed is not sent', async () => {
  const signer = wallet([hashOf(1)]);
  const h = harness({ prepared: [draft('open', 1, { expiresAt: NOW_S + 60 })], receipts: [], signer });
  await h.run.start(INPUT);
  assert.equal(h.run.state().step, 'review');
  // The person reads the review for a minute: the draft is past its expiry (less its margin) when confirmed.
  h.advance(55_000);
  await h.run.confirm();
  assert.equal(h.run.state().reason, 'expired');
  assert.equal(signer.calls.length, 0);
  assert.equal(h.asked.filter((a) => a.route === 'inspect').length, 0, 'not even inspected');
});

test('a refusal in the wallet goes back to the review; nothing is sent again on its own', async () => {
  const open = draft('open', 1);
  const signer = wallet([new flow.SignerError('rejected', 'User rejected'), hashOf(5)]);
  const h = harness({ prepared: [open], receipts: [receipt('confirmed', open)], signer });
  await h.run.start(INPUT);
  await h.run.confirm();
  assert.deepEqual([h.run.state().step, h.run.state().refused], ['review', true]);
  assert.equal(signer.calls.length, 1);
  await h.run.confirm();
  assert.equal(h.run.state().step, 'done');
  assert.equal(signer.calls.length, 2, 'the second send was the person\'s own confirm');
});

test('a wallet that cannot send stops the flow; nothing was sent', async () => {
  const signer = wallet([new flow.SignerError('nonce_changed', 'nonce')]);
  const h = harness({ prepared: [draft('open', 1)], receipts: [], signer });
  await h.run.start(INPUT);
  await h.run.confirm();
  assert.deepEqual([h.run.state().reason, h.run.state().detail, h.run.state().hash], ['wallet', 'nonce_changed', null]);
});

test('a receipt that names another transaction stops the flow as replaced; a reverted one stops it too', async () => {
  const open = draft('open', 1);
  const replaced = (hash) => ({ ...receipt('confirmed', open)(hash), transaction: { ...receipt('confirmed', open)(hash).transaction, nonce: 2 } });
  const h = harness({ prepared: [open], receipts: [replaced], signer: wallet([hashOf(1)]) });
  await h.run.start(INPUT);
  await h.run.confirm();
  assert.deepEqual([h.run.state().reason, h.run.state().hash], ['replaced', hashOf(1)]);
  assert.deepEqual(h.settled, [[hashOf(1), 'replaced', null]]);

  const approve = draft('approve-token0', 1);
  const r = harness({ prepared: [approve], receipts: [receipt('reverted', approve)], signer: wallet([hashOf(2)]) });
  await r.run.start(INPUT);
  await r.run.confirm();
  assert.deepEqual([r.run.state().reason, r.run.state().detail], ['reverted', '47601']);
  assert.equal(r.asked.filter((a) => a.route === 'prepare').length, 1, 'no next step after a revert');
});

test('a pending receipt is asked again by itself, through a service outage, slower after two minutes', async () => {
  const open = draft('open', 1);
  const pending = receipt('pending', open);
  const outage = new ServiceError('unreachable', null, 'unreachable');
  const many = [pending, outage, pending, ...Array.from({ length: 45 }, () => pending), receipt('confirmed', open)];
  const total = many.length;
  const h = harness({ prepared: [open], receipts: many, signer: wallet([hashOf(1)]) });
  await h.run.start(INPUT);
  await h.run.confirm();
  assert.equal(h.run.state().step, 'done');
  assert.ok(h.states.some((s) => s.step === 'confirming' && s.slow), 'the screen says it is taking longer');
  assert.equal(h.asked.filter((a) => a.route === 'receipt').length, total);
});

test('cancelling while a receipt is pending stops asking; the transaction is the receipts list\'s to follow', async () => {
  const open = draft('open', 1);
  let flowRef = null;
  const pending = receipt('pending', open);
  const receipts = [pending, (hash) => { flowRef.cancel(); return pending(hash); }, ...Array.from({ length: 10 }, () => pending)];
  const h = harness({ prepared: [open], receipts, signer: wallet([hashOf(1)]) });
  flowRef = h.run;
  await h.run.start(INPUT);
  await h.run.confirm();
  assert.equal(h.run.state().step, 'idle');
  assert.equal(h.asked.filter((a) => a.route === 'receipt').length, 2);
  assert.equal(h.sent.length, 1);
});

test('the service refusing to prepare stops the flow with its code', async () => {
  const h = harness({ prepared: [new ServiceError('refused', 'deployment_unqualified', 'deployment_unqualified')], receipts: [], signer: wallet([]) });
  await h.run.start(INPUT);
  assert.deepEqual([h.run.state().reason, h.run.state().detail], ['service', 'deployment_unqualified']);
});
