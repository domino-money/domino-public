/**
 * Added 2026-10-14 (incident C3: screens finish at inclusion; L5 of the incident). The position page's direct exit
 * (src/v2in/position/directRun.ts) read its receipt every 1.5 s until the block was final, about 16 minutes on Robinhood
 * Chain, and went on after its dialog was gone. It now stops at inclusion, and its loop stops with the dialog: an exit
 * still not in a block is handed to the shared follow (src/v2in/journey/receiptFollow.ts), which reads it until its block
 * and no longer, so the direct client still lets the position go and the lists still hear of it.
 *
 * The hook runs over a small stand-in for React (state, refs, effects), a fake clock, and its imports faked; the pauses
 * are the real ones (src/v2in/receiptWait.ts).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const wait = require('../../.test-build/app/src/v2in/receiptWait.js');
const { createReceiptFollow } = require('../../.test-build/app/src/v2in/journey/receiptFollow.js');

const HASH = `0x${'ab'.repeat(32)}`;
const OWNER = `0x${'01'.repeat(20)}`;
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); };

// `current`: the wallet's own word that the same connector and account are still connected. `realFollow` (2026-10-14,
// review of C3 on main): the shared follow itself, on this clock, for the cases that need its ticks; recorded either way.
function harness(answers, { send = async () => HASH, current = () => true, realFollow = false } = {}) {
  let now = 0;
  const timers = new Set(), reads = [], follows = [], announced = [];
  const clock = { now: () => now };
  const later = (fn, ms) => { const timer = { fn, at: now + ms }; timers.add(timer); return timer; };
  const shared = realFollow ? createReceiptFollow({ now: () => now, visible: () => true, set: later, clear: (timer) => timers.delete(timer) }) : null;
  // React, as far as the hook uses it: one component, its state, its refs and its effects in call order.
  let state, setState, cells = [], cell = 0, effects = [], cleanups = [];
  const react = {
    useState: (initial) => { const at = cell++; if (!(at in cells)) cells[at] = { value: initial }; state = cells[at]; setState = (next) => { state.value = typeof next === 'function' ? next(state.value) : next; }; return [cells[at].value, setState]; },
    useRef: (initial) => { const at = cell++; if (!(at in cells)) cells[at] = { current: initial }; return cells[at]; },
    useEffect: (effect) => { const at = cell++; if (!(at in cells)) { cells[at] = true; effects.push(effect); } },
  };
  const direct = {
    prepareClose: async () => ({ step: { expiresAt: Number.MAX_SAFE_INTEGER }, pausesAutomation: null, state: { pool: {} } }),
    prepareCollect: async () => ({ step: { expiresAt: Number.MAX_SAFE_INTEGER }, pausesAutomation: null, state: { pool: {} } }),
    send,
    wasOffered: () => true,
    acknowledgePause() {},
    receipt: async (hash) => { assert.equal(hash, HASH); reads.push(now); const next = answers.shift() ?? { state: 'pending' }; if (next instanceof Error) throw next; return next; },
  };
  const connection = { direct, wallet: { owner: OWNER, current, chainId: () => 8453 } };
  const deps = {
    react,
    '../../finance/v2/direct': { readDirectReceipt: ({ receipt }) => ({ state: receipt.state, paid: [] }) },
    './copy': { COPY: { receipt: { unreadable: 'unreadable' } } },
    // The hook's own pause before 2026-10-14 (kept so the old hook can be run against these cases).
    './constants': { RECEIPT_POLL_MS: 1_500 },
    './errors': { actionError: (error) => ({ copy: 'failed', code: error instanceof Error ? error.message : 'unknown', recovery: 'none' }) },
    // Changed on purpose 2026-11-09 (the core-flows fix, item b): the hook asks whether a direct exit may be sent under its gate.
    './wallet': { connectPosition: async () => connection, directSendable: (gate) => gate.mode === 'live' },
    '../lists/positionSync': { positionChanged: (change) => announced.push(change) },
    '../../v2/chains': { v2Chain: () => ({ uniswap: { v3: { positionManager: '0x03' }, v4: { positionManager: '0x04' } } }), positionManagerOf: (chain, dex) => chain.uniswap[dex === 4 ? 'v4' : 'v3'].positionManager },
    '../receiptWait': wait,
    '../journey/receiptFollow': { RECEIPT_FOLLOW: { follow: (key, job) => { follows.push({ key, job }); shared?.follow(key, job); } } },
  };
  const ts = require('typescript'), mod = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL('../../src/v2in/position/directRun.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', 'setTimeout', 'Date', code)((name) => name === 'react' ? react : deps[name] ?? {}, mod, mod.exports, later, clock);
  const gate = { mode: 'live', chainId: 8453 };
  const position = { dex: 4, tokenId: 42n, vault: null };
  const render = () => { cell = 0; return mod.exports.useDirectExit(gate, position, () => 'TOKEN'); };
  return {
    reads, follows, announced, render,
    stage: () => state?.value.stage,
    mount() { cleanups = effects.map((effect) => effect()).filter(Boolean); },
    unmount() { for (const cleanup of cleanups) cleanup(); },
    async advance(ms) {
      const end = now + ms;
      await flush();
      for (let timer = [...timers].sort((a, b) => a.at - b.at)[0]; timer && timer.at <= end; timer = [...timers].sort((a, b) => a.at - b.at)[0]) { timers.delete(timer); now = timer.at; timer.fn(); await flush(); }
      now = end;
    },
  };
}
const included = { state: 'included', blockNumber: 20n, blockHash: `0x${'cd'.repeat(32)}`, gasUsed: 1n, effectiveGasPrice: 1n, l1Fee: null, logs: [] };

test('the direct exit is done at its block: no read after it, and nothing is handed on', async () => {
  const h = harness([{ state: 'pending' }, new Error('confirmation_unavailable'), included]);
  h.render(); h.mount();
  await h.render().quote('close', 50, 0n); await flush();
  assert.equal(h.stage(), 'ready');
  const sending = h.render().send();
  await h.advance(60_000);
  assert.equal(h.stage(), 'done');
  assert.equal(h.announced.length, 1, 'the lists hear of it once, at its block');
  await h.advance(30 * 60_000);
  assert.equal(h.reads.length, 3, 'a failed read is asked again, and nothing is read after its block (it was read every 1.5 s until final)');
  await Promise.race([sending, new Promise((_, reject) => setTimeout(() => reject(new Error('the exit’s wait never ended')), 5_000))]);
  h.unmount();
  assert.equal(h.follows.length, 0, 'an exit in its block is handed to nobody');
});

test('the dialog gone, its loop stops; an exit not in a block yet is handed to the shared follow, which ends at its block', async () => {
  const h = harness([{ state: 'pending' }, { state: 'pending' }]);
  h.render(); h.mount();
  await h.render().quote('collect', 50, 0n); await flush();
  void h.render().send();
  await h.advance(2_000);
  const before = h.reads.length;
  assert.ok(before >= 1);
  h.unmount();
  await h.advance(30 * 60_000);
  assert.equal(h.reads.length, before, 'the dialog’s loop reads nothing after it is gone');
  assert.equal(h.follows.length, 1);
  const [{ key, job }] = h.follows;
  assert.equal(key, `direct:8453:${OWNER}:${HASH}`);
  assert.equal(job.available(), 'ready');
  assert.equal(job.accept({ state: 'pending' }), false, 'followed on while it is not in a block');
  assert.equal(job.accept(included), true, 'and no longer once it is');
  assert.equal(h.announced.length, 1, 'the lists hear of it at its block, as with the dialog open');
  assert.equal(job.accept({ state: 'reverted' }), true, 'a reverted exit ends the follow too');
});

// Added 2026-10-14 (C3 review, blocking): the dialog closed with its X while the wallet still showed the exit. The cleanup
// ran before the wallet gave its hash, found nothing to hand on, and the hash, when it came, was never read: no receipt,
// no follow, no word to the lists, and the position stayed held from every later exit until a reload.
test('the dialog gone while the wallet still has the exit: its hash, when it comes, is handed to the shared follow', async () => {
  for (const leave of ['unmount', 'reset']) {
    let give;
    const h = harness([included], { send: () => new Promise((resolve) => { give = resolve; }) });
    h.render(); h.mount();
    await h.render().quote('close', 50, 0n); await flush();
    const sending = h.render().send();
    await flush();
    assert.equal(h.stage(), 'wallet', leave);
    if (leave === 'unmount') h.unmount(); else h.render().reset();
    assert.equal(h.follows.length, 0, 'nothing to hand on yet');
    give(HASH);
    await sending;
    assert.equal(h.follows.length, 1, `${leave}: the exit is followed`);
    const [{ key, job }] = h.follows;
    assert.equal(key, `direct:8453:${OWNER}:${HASH}`);
    await h.advance(30 * 60_000);
    assert.equal(h.reads.length, 0, `${leave}: the dialog's own loop never starts`);
    assert.equal(await job.read(), included, 'the follow reads it through the direct client');
    assert.equal(job.accept(included), true);
    assert.equal(h.announced.length, 1, `${leave}: the lists hear of it once, at its block`);
  }
});

// Added 2026-10-14 (C3 review): gone while a read is out, the dialog's loop leaves that answer to the follow it handed the
// exit to (it announced the exit too, and the follow announced it again).
test('the dialog gone while a read is out: the follow it was handed reads and announces the exit, once', async () => {
  let land;
  const h = harness([new Promise((resolve) => { land = resolve; })]);
  h.render(); h.mount();
  await h.render().quote('collect', 50, 0n); await flush();
  void h.render().send();
  await h.advance(1_000);
  assert.equal(h.reads.length, 1, 'one read out');
  h.unmount();
  land(included);
  await h.advance(30 * 60_000);
  assert.equal(h.reads.length, 1);
  assert.equal(h.follows.length, 1);
  assert.equal(h.announced.length, 0, 'the gone dialog announces nothing');
  assert.equal(h.follows[0].job.accept(included), true);
  assert.equal(h.announced.length, 1, 'the follow does, once');
});

// Added 2026-10-14 (review of C3 on main): the exit handed to the shared follow, then the wallet on another account (or
// gone a moment) at the follow's tick. The follow took that for "gone" and dropped the exit before any read; nothing
// else reads its hash, so the direct client's latch on the position was never let go. The same account back, the page
// reuses that client (position/wallet.ts), and every Withdraw or Collect fees of the position said "This was already
// sent to your wallet" until a reload. Base and Arbitrum One only: Robinhood's receipts come from the site's reader.
test('the wallet away when the follow comes: the exit waits for the same account, then is read and the position let go', async () => {
  let current = true;
  const h = harness([{ state: 'pending' }, included], { current: () => current, realFollow: true });
  h.render(); h.mount();
  await h.render().quote('close', 50, 0n); await flush();
  void h.render().send();
  await h.advance(600);
  assert.equal(h.reads.length, 1, 'the dialog read it once: not in a block yet');
  h.unmount();
  assert.equal(h.follows.length, 1, 'handed to the shared follow');
  current = false;
  await h.advance(10 * 60_000);
  assert.equal(h.reads.length, 1, 'nothing is read while the wallet is away');
  current = true;
  await h.advance(60_000);
  assert.equal(h.reads.length, 2, 'the same account back: the follow reads the exit through the direct client, which lets the position go');
  assert.equal(h.announced.length, 1, 'and the lists hear of it, once');
  await h.advance(60 * 60_000);
  assert.equal(h.reads.length, 2, 'and no longer once it is in a block');
  current = false;
  assert.equal(h.follows[0].job.available(), 'paused', 'another account (or none) is a pause, not the end');
});
