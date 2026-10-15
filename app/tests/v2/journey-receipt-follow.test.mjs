import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { createReceiptFollow } = require('../../.test-build/app/src/v2in/journey/receiptFollow.js');
const flush = async () => { for (let n = 0; n < 4; n++) await new Promise(resolve => setImmediate(resolve)); };
function harness() {
  let time = 0, visible = true;
  const timers = new Set();
  const follow = createReceiptFollow({ now: () => time, visible: () => visible,
    set: (run, delay) => { const timer = { run, at: time + delay }; timers.add(timer); return timer; }, clear: timer => timers.delete(timer) });
  return { follow, timers, time: () => time, visible: value => { visible = value; }, advance: value => { time += value; },
    async next() { const timer = [...timers].sort((a, b) => a.at - b.at)[0]; assert.ok(timer); timers.delete(timer); time = Math.max(time, timer.at); timer.run(); await flush(); } };
}

test('checked receipt continuation outlives its view, deduplicates the same operation and stops only on a proved outcome', async () => {
  const h = harness(), seen = []; let calls = 0, mounted = true;
  const receipts = [{ state: 'pending' }, { state: 'reorged' }, { state: 'included' }, { state: 'finalized' }];
  h.follow.follow('8453:owner:hash', { available: () => 'ready', read: async () => { calls++; return receipts.shift(); }, accept: receipt => { seen.push([mounted, receipt.state]); return receipt.state === 'finalized'; } });
  h.follow.follow('8453:owner:hash', { available: () => 'ready', read: async () => assert.fail('duplicate reader'), accept: () => true });
  mounted = false;
  for (let n = 0; n < 4; n++) await h.next();
  assert.deepEqual(seen, [[false, 'pending'], [false, 'reorged'], [false, 'included'], [false, 'finalized']]);
  assert.equal(calls, 4); assert.equal(h.timers.size, 0);
});

test('receipt continuation pauses invisible or on another chain and drops a changed account before invoking its reader', async () => {
  const h = harness(); let state = 'paused', calls = 0;
  h.follow.follow('one', { available: () => state, read: async () => { calls++; return { state: 'pending' }; }, accept: () => false });
  await h.next(); assert.equal(calls, 0);
  state = 'ready'; h.visible(false); await h.next(); assert.equal(calls, 0);
  h.visible(true); await h.next(); assert.equal(calls, 1);
  state = 'gone'; await h.next(); assert.equal(calls, 1); assert.equal(h.timers.size, 0);
});

test('receipt continuation serializes work, honors Retry-After and bounds attempts without converting delays to failure', async () => {
  const h = harness(); const calls = []; let finish;
  h.follow.follow('one', { available: () => 'ready', read: () => { calls.push(['one', h.time()]); return new Promise(resolve => { finish = resolve; }); }, accept: () => true });
  h.follow.follow('two', { available: () => 'ready', read: async () => { calls.push(['two', h.time()]); if (calls.filter(([name]) => name === 'two').length === 1) throw { retryAfterMs: 90_000 }; return { state: 'pending' }; }, accept: () => false });
  await h.next(); assert.deepEqual(calls.map(([key]) => key), ['one']);
  finish({ state: 'finalized' }); await flush();
  assert.deepEqual(calls.map(([key]) => key), ['one', 'two']);
  const first = calls.at(-1)[1]; await h.next(); assert.ok(calls.at(-1)[1] - first >= 90_000);
  for (let n = 0; h.timers.size && n < 100; n++) await h.next();
  assert.equal(calls.filter(([key]) => key === 'two').length, 80); assert.equal(h.timers.size, 0);
  h.follow.follow('expired', { available: () => 'paused', read: async () => assert.fail('expired read'), accept: () => false });
  h.advance(3_600_001); await h.next(); assert.equal(h.timers.size, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// Added 2026-10-15 (pack 8, incident C5). The follow above stays for what waits on a block alone (a direct exit after
// its dialog closed; on Base and Arbitrum One, a block found again after one left the chain). Finality is no longer
// its job: on ffbd80ab a Base or Arbitrum One action (New position's create, an automation step) was followed through
// the wallet until final, every 5 s, then 15 s, then 30 s; now its receipt goes to the confirmation queue
// (lib/confirmedOperations.ts) with its money client's own read and check, and the queue reads once, when read-v6's
// mark or the chain's age says the block may be final. Below, the REAL money client (finance/v2/transact.ts receipt)
// reads through a fake Base wallet, and the REAL check automation's steps hand in (v2in/automate/receipt.ts) judges.
// ---------------------------------------------------------------------------------------------------------------------
const { createConfirmedOperations } = require('../../.test-build/app/src/lib/confirmedOperations.js');
const { createTransactor } = require('../../.test-build/app/src/finance/v2/transact.js');
const { v2Chain } = require('../../.test-build/app/src/v2/chains.js');
const { reconcileAutomationReceipt } = require('../../.test-build/app/src/v2in/automate/receipt.js');
const OWNER = `0x${'01'.repeat(20)}`, TO = `0x${'0d'.repeat(20)}`, HASH = `0x${'ab'.repeat(32)}`, BLOCK = `0x${'cd'.repeat(32)}`, OTHER = `0x${'ef'.repeat(32)}`;
const MINUTE = 60_000;

/** A Base wallet whose chain includes HASH in block 0x10 and makes it final `finalAt` ms after inclusion; every request kept. */
function baseChain(h, { finalAt = 18 * MINUTE, chainId = 8453 } = {}) {
  const asked = [];
  const chain = { asked, block: { number: '0x10', hash: BLOCK }, receipt: { blockNumber: '0x10', blockHash: BLOCK, transactionHash: HASH }, transaction: true };
  const wallet = { owner: OWNER, current: () => true, chainId: () => chainId, signatures: {},
    async request(method, params) {
      asked.push(method);
      if (method === 'eth_accounts') return [OWNER];
      if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
      if (method === 'eth_getTransactionByHash') return chain.transaction ? { hash: params[0], from: OWNER, to: TO, input: '0x', value: '0x0', nonce: '0x1' } : null;
      if (method === 'eth_getTransactionReceipt') return chain.transaction ? { ...chain.receipt, from: OWNER, status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [] } : null;
      if (method === 'eth_getBlockByNumber' && params[0] === 'finalized') return { number: h.time() >= finalAt ? '0x10' : '0xf' };
      if (method === 'eth_getBlockByNumber') return params[0] === chain.block.number ? chain.block : null;
      throw new Error(`unexpected ${method}`);
    } };
  const client = createTransactor(wallet, v2Chain(chainId), () => h.time() / 1000);
  return { chain, asked, read: () => client.receipt(HASH, { from: OWNER, to: TO, data: '0x', value: '0x0', nonce: '0x1', chainId: `0x${chainId.toString(16)}` }) };
}
/** The confirmation queue over the same fake clock; its edge reader is never asked on Base (it fails the test if it is). */
function queueOn(h) {
  const edge = { read: async () => assert.fail('the edge is never asked about Base'), finalized: async () => assert.fail('the edge is never asked about Base') };
  return createConfirmedOperations(edge, { now: h.time, visible: () => true,
    set: (run, delay) => { const timer = { run, at: h.time() + delay }; h.timers.add(timer); return timer; }, clear: timer => h.timers.delete(timer) });
}
/** Records the action's inclusion as its money client does since C5: its own read and check go with it. */
function recordOwn(queue, read, chainId = 8453) {
  let op = null;
  op = queue.record({ chainId, wallet: OWNER, tokenIds: ['7'], receipt: { transactionHash: HASH, blockHash: BLOCK, blockNumber: 16n, state: 'included' },
    follow: { read, available: () => 'ready', accept: next => reconcileAutomationReceipt(op, next, queue.record, queue.reorg, queue.get().find(item => item.hash === op.hash) ?? null) } });
  return op;
}
async function runFor(h, ms) {
  const end = h.time() + ms;
  for (;;) {
    const timer = [...h.timers].sort((a, b) => a.at - b.at)[0];
    if (!timer || timer.at > end) break;
    h.timers.delete(timer); h.advance(Math.max(0, timer.at - h.time())); timer.run(); await flush();
  }
  h.advance(Math.max(0, end - h.time()));
}

test('a Base action\'s receipt reaches finality with fewer wallet reads than ffbd80ab\'s follow: one read at finality', async () => {
  // ffbd80ab: the action's follow (this module) read the money client's receipt until it said final.
  const before = harness(), old = baseChain(before);
  before.follow.follow('8453:owner:intent', { available: () => 'ready', read: old.read, accept: next => next.state !== 'included' && next.state !== 'pending' });
  for (let n = 0; before.timers.size && n < 200; n++) await before.next();
  const oldReads = old.asked.filter(method => method === 'eth_getTransactionReceipt').length;
  // Now: the queue, with no mark from read-v6 (Base is not indexed): the age says when.
  const after = harness(), now = baseChain(after), queue = queueOn(after);
  recordOwn(queue, now.read);
  await runFor(after, 2 * 60 * MINUTE);
  const newReads = now.asked.filter(method => method === 'eth_getTransactionReceipt').length;
  assert.equal(queue.get()[0].phase, 'finalized', 'final, as before');
  assert.equal(after.timers.size, 0);
  // With read-v6's mark (a chain it indexes), one read 75 s after the mark passes the block.
  const marked = harness(), withMark = baseChain(marked, { finalAt: 0 }), markedQueue = queueOn(marked);
  recordOwn(markedQueue, withMark.read);
  markedQueue.noteChainFinality(8453, 16);
  await runFor(marked, 10 * MINUTE);
  assert.equal(markedQueue.get()[0].phase, 'finalized');
  const markedReads = withMark.asked.filter(method => method === 'eth_getTransactionReceipt').length;
  console.log(`wallet reads per Base action until final (finality 18 min after inclusion): ffbd80ab ${oldReads} reads / ${old.asked.length} wallet calls; now ${newReads} reads / ${now.asked.length} calls; with read-v6's mark ${markedReads} read / ${withMark.asked.length} calls`);
  assert.ok(oldReads >= 40, `ffbd80ab read about fifty times (${oldReads})`);
  assert.equal(newReads, 1, 'one read: at twenty minutes the block is final');
  assert.equal(now.asked.length, 6, 'six wallet calls in all');
  assert.equal(markedReads, 1);
  assert.ok(now.asked.length < old.asked.length / 40);
});

test('a reorganised block on Base is still caught at the one read at finality', async () => {
  const h = harness(), wallet = baseChain(h), queue = queueOn(h);
  recordOwn(queue, wallet.read);
  await runFor(h, 10 * MINUTE);
  assert.equal(wallet.asked.length, 0, 'nothing asked before finality');
  wallet.chain.block = { number: '0x10', hash: OTHER };
  await runFor(h, 15 * MINUTE);
  assert.equal(queue.get()[0].phase, 'reorged', 'the block of that number is another: the operation is reorganised');
  assert.equal(wallet.asked.filter(method => method === 'eth_getTransactionReceipt').length, 1);
  assert.equal(h.timers.size, 0, 'and nothing more is asked');
});

test('a transaction found in another block (re-included, or replaced in a batch) on Base is caught at that read, never adopted', async () => {
  const h = harness(), wallet = baseChain(h, { finalAt: 0 }), queue = queueOn(h);
  recordOwn(queue, wallet.read);
  wallet.chain.receipt = { blockNumber: '0x11', blockHash: OTHER, transactionHash: HASH };
  wallet.chain.block = { number: '0x11', hash: OTHER };
  await runFor(h, 25 * MINUTE);
  assert.equal(queue.get()[0].phase, 'reorged');
  assert.equal(queue.get()[0].blockHash, BLOCK, 'the new block waits for the money client to check its effects');
  // A batch's transaction found under another hash: the client's answer names it, and the check refuses to adopt it.
  const batch = harness(), batchQueue = queueOn(batch);
  recordOwn(batchQueue, async () => ({ state: 'finalized', transactionHash: OTHER, blockHash: BLOCK, blockNumber: 16n, logs: [] }));
  await runFor(batch, 25 * MINUTE);
  assert.equal(batchQueue.get()[0].phase, 'reorged', 'another transaction for the same action is not this one');
  // A transaction that left its block and is in none (the wallet finds no transaction): kept, never a false rollback.
  const gone = harness(), goneWallet = baseChain(gone), goneQueue = queueOn(gone);
  recordOwn(goneQueue, goneWallet.read);
  goneWallet.chain.transaction = false;
  await runFor(gone, 25 * MINUTE);
  assert.equal(goneQueue.get()[0].phase, 'included');
});

// (2026-10-15, pack 8 review, L1): New position on Base told the queue only of a receipt its reader decoded with a new
// NFT; one it could not decode, or that named none, was followed by nothing, so its block leaving the chain went unseen
// (ffbd80ab's follow took every included receipt off Robinhood Chain). journeyOperation is what run.ts records now.
const { journeyOperation } = require('../../.test-build/app/src/v2in/journey/model/receiptOperation.js');
test('a New position receipt with no NFT read on Base still goes to the queue with its own check, and a reorganised block is caught', async () => {
  const follow = { read: async () => ({ state: 'pending' }), accept: () => false };
  const receipt = { state: 'included', blockNumber: 16n, blockHash: BLOCK };
  const base = { chainId: 8453, owner: OWNER, positionManager: TO, hash: HASH, receipt, tokenIds: [], follow };
  assert.equal(journeyOperation({ ...base, chainId: 4663 }), null, 'Robinhood Chain: the edge reads finality, read-v6 lists the action');
  assert.equal(journeyOperation({ ...base, hash: null }), null);
  assert.equal(journeyOperation({ ...base, receipt: { ...receipt, state: 'reverted' } }), null);
  for (const tokenIds of [[], ['7']]) {
    const h = harness(), wallet = baseChain(h), queue = queueOn(h);
    let op = null, checked = [];
    const own = journeyOperation({ ...base, tokenIds, follow: { read: wallet.read, available: () => 'ready',
      accept: (next) => { checked.push(next.state); return reconcileAutomationReceipt(op, next, queue.record, queue.reorg, queue.get().find((item) => item.hash === op.hash) ?? null); } } });
    assert.deepEqual([own.tokenIds, own.wallet, own.receipt.transactionHash], [tokenIds, OWNER, HASH]);
    op = queue.record(own);
    assert.equal(op.phase, 'included', `recorded (${tokenIds.length ? 'an NFT named' : 'no NFT read'})`);
    await runFor(h, 10 * MINUTE);
    wallet.chain.block = { number: '0x10', hash: OTHER };
    await runFor(h, 15 * MINUTE);
    assert.equal(queue.get()[0].phase, 'reorged', 'the block of that number is another: caught at the one read');
    assert.deepEqual(checked, ['reorged'], 'by the view\'s own check');
    assert.equal(h.timers.size, 0);
  }
});
