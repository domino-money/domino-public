import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, pad, parseAbi } from 'viem';
import { logLimitError } from './support/log-limits.mjs';
const require = createRequire(import.meta.url);
const { createRouteJournal } = require('../.test-build/app/src/finance/routedJournal.js');
const { routedBatchPlan, routedTermsKey } = require('../.test-build/app/src/finance/routedPlan.js');
const { routedReplacement, routeEvidence, permitDigest, poolDigest, swapDigest, walletOwnReads, routeDeadline, deadlinePassed } = require('../.test-build/app/src/finance/routedReplacement.js');
const { nonceStanding } = require('../.test-build/app/src/finance/setup.js');
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
  assert.deepEqual(second.read(owner), { claim, hash: null, batchOperation: null, nonce: null, evidence: null });
  await assert.rejects(second.claim(owner), /route_already_offered/);
  await first.record(owner, claim, hash);
  assert.deepEqual(f.make().read(owner), { claim, hash, batchOperation: null, nonce: null, evidence: null });
  await assert.rejects(f.make().claim(owner), /route_already_offered/);
  assert.equal(first.read(other), null);
  assert.ok([...f.store.values.keys()].every(k => !k.includes(owner.slice(2))));
  assert.deepEqual([...f.store.values.values()], [`${claim}|${hash}`]);
  await second.release(owner, 'bad-claim'); assert.ok(first.read(owner));
  await second.release(owner, claim); assert.equal(first.read(owner), null);
});
// Fix round 1 (2026-10-01): the swap's nonce is kept beside its hash, for its claim only, so a swap the wallet replaced
// is known after a reload too; it goes with the record, and a record of the release before reads with no nonce.
test('the routed swap’s nonce is kept beside its hash for its own claim, and goes with the record', async () => {
  const f = fixture(), journal = f.make(), claim = await journal.claim(owner);
  await journal.record(owner, claim, hash, 7n);
  assert.deepEqual(f.make().read(owner), { claim, hash, batchOperation: null, nonce: 7n, evidence: null });
  const keys = [...f.store.values.keys()].sort();
  assert.equal(keys.length, 2);
  assert.match(keys[0], /^domino\.routed-offer-nonce\.v1\.[0-9a-f]{64}$/);
  assert.match(keys[1], /^domino\.routed-offer\.v1\.[0-9a-f]{64}$/);
  assert.equal(keys[0].slice(-64), keys[1].slice(-64), 'the same opaque digest');
  assert.equal(f.store.values.get(keys[0]), `${claim}|7`, 'the claim and the nonce, no address');
  assert.ok([...f.store.values.keys(), ...f.store.values.values()].every(v => !v.includes(owner.slice(2))));
  await journal.release(owner, claim);
  assert.equal(f.store.values.size, 0, 'both let go');
  // A record of the release before (no nonce beside it), or a nonce left by another claim: no nonce.
  const old = f.make(), c2 = await old.claim(owner);
  await old.record(owner, c2, hash);
  assert.deepEqual(old.read(owner), { claim: c2, hash, batchOperation: null, nonce: null, evidence: null });
  f.store.values.set(keys[0], `${claim}|7`);
  assert.equal(old.read(owner).nonce, null, 'a nonce kept for another claim is not this one');
  for (const bad of [`${c2}|-1`, `${c2}|0x7`, `${c2}|07`, `${c2}|`, 'x']) { f.store.values.set(keys[0], bad); assert.equal(old.read(owner).nonce, null, bad); }
  f.store.values.set(keys[0], `${c2}|0`);
  assert.equal(old.read(owner).nonce, 0n);
  // A batch record carries no nonce.
  await old.release(owner, c2);
  const c3 = await old.claim(owner);
  await old.recordBatch(owner, c3, hash);
  f.store.values.set(keys[0], `${c3}|3`);
  assert.equal(old.read(owner).nonce, null);
});
// Fix round 3 (2026-10-01): what tells a replacement apart later is kept beside the nonce, for the same claim: a block
// height and digests, never an address, amount or calldata. A record of the rounds before reads with none. Fix round 3.1:
// two digests more (the allowance the swap leaves, and the owner and pool it was for); round 3's entry reads without them.
test('the routed swap’s evidence is kept beside its nonce for its own claim: a block height and digests, nothing more', async () => {
  const f = fixture(), journal = f.make(), claim = await journal.claim(owner);
  const swap = '0x' + '5a'.repeat(32), permit = '0x' + '6b'.repeat(32), spent = '0x' + '7c'.repeat(32), pool = '0x' + '8d'.repeat(32);
  await journal.record(owner, claim, hash, 7n, { sentAfter: 992n, swap, permit, spent, pool, deadline: 1_800_000_000n });
  assert.deepEqual(f.make().read(owner), { claim, hash, batchOperation: null, nonce: 7n, evidence: { sentAfter: 992n, swap, permit, spent, pool, deadline: 1_800_000_000n } });
  const nonceKey = [...f.store.values.keys()].find(key => key.startsWith('domino.routed-offer-nonce.v1.'));
  // Fix round 3.2: the router call's deadline, a time, last.
  assert.equal(f.store.values.get(nonceKey), `${claim}|7|992|${swap}|${permit}|${spent}|${pool}|1800000000`);
  assert.ok([...f.store.values.values()].every(v => !v.includes(owner.slice(2))), 'no address');
  // Parts a read could not give are kept empty, and read back as null.
  await journal.release(owner, claim);
  const c2 = await journal.claim(owner);
  await journal.record(owner, c2, hash, 0n, { sentAfter: null, swap, permit: null, spent: null, pool: null, deadline: null });
  assert.equal(f.store.values.get(nonceKey), `${c2}|0||${swap}||||`);
  assert.deepEqual(journal.read(owner).evidence, { sentAfter: null, swap, permit: null, spent: null, pool: null, deadline: null });
  // A digest that is not one is never kept.
  await journal.release(owner, c2);
  const c3 = await journal.claim(owner);
  await journal.record(owner, c3, hash, 1n, { sentAfter: 5n, swap: 'not-a-digest', permit: '0x' + 'AB'.repeat(32), spent: '0x12', pool: 'x', deadline: -1n });
  assert.deepEqual(journal.read(owner).evidence, { sentAfter: 5n, swap: null, permit: null, spent: null, pool: null, deadline: null });
  // Round 3's entry: no `spent`, no `pool`; round 3.1's: no deadline. The round before's: the nonce as it was, no evidence.
  f.store.values.set(nonceKey, `${c3}|1|5|${swap}|${permit}`);
  assert.deepEqual(journal.read(owner).evidence, { sentAfter: 5n, swap, permit, spent: null, pool: null, deadline: null });
  f.store.values.set(nonceKey, `${c3}|1|5|${swap}|${permit}|${spent}|${pool}`);
  assert.deepEqual(journal.read(owner).evidence, { sentAfter: 5n, swap, permit, spent, pool, deadline: null });
  f.store.values.set(nonceKey, `${c3}|1`);
  assert.deepEqual([journal.read(owner).nonce, journal.read(owner).evidence], [1n, null]);
  // Broken ones: nothing; another claim's: nothing.
  for (const bad of [`${c3}|1|5|${swap}`, `${c3}|1|05||`, `${c3}|1|x||`, `${c3}|1||0x12|`, `${c3}|1||||`, `${c3}|1|5|${swap}|${permit}|${spent}`, `${c3}|1|5|${swap}|${permit}|${spent}|0x12`,
    `${c3}|1|5|${swap}|${permit}|${spent}|${pool}|0x5`, `${c3}|1|5|${swap}|${permit}|${spent}|${pool}|05`, `${c3}|1|5|${swap}|${permit}|${spent}|${pool}|1|2`]) {
    f.store.values.set(nonceKey, bad);
    assert.deepEqual([journal.read(owner).nonce, journal.read(owner).evidence], [null, null], bad);
  }
  f.store.values.set(nonceKey, `${claim}|1|5||`);
  assert.deepEqual([journal.read(owner).nonce, journal.read(owner).evidence], [null, null], 'another claim');
  await journal.release(owner, c3);
  assert.equal(f.store.values.size, 0, 'both let go');
});
// Fix round 3.1 (2026-10-01), the recheck's finding: a swap offered to the wallet whose hash never came back (a signer
// slower than the signing window, a reload while the wallet showed it) was claimed with no nonce, and held every later
// Create position of the wallet in that browser for good. The nonce and evidence are now kept with the claim itself.
test('fix round 3.1: the swap’s nonce and evidence are kept with its claim, before the wallet is asked, and read beside a claim with no hash', async () => {
  const f = fixture(), journal = f.make();
  const evidence = { sentAfter: 90n, swap: '0x' + '5a'.repeat(32), permit: null, spent: null, pool: '0x' + '8d'.repeat(32), deadline: 1_800_000_000n };
  const claim = await journal.claim(owner, 4n, evidence);
  assert.deepEqual(f.make().read(owner), { claim, hash: null, batchOperation: null, nonce: 4n, evidence });
  await assert.rejects(f.make().claim(owner, 5n, evidence), /route_already_offered/, 'still one routed swap at a time');
  // The hash, when it comes back, goes beside them; what the claim kept stays.
  await journal.record(owner, claim, hash);
  assert.deepEqual(f.make().read(owner), { claim, hash, batchOperation: null, nonce: 4n, evidence });
  assert.ok([...f.store.values.keys(), ...f.store.values.values()].every(v => !v.includes(owner.slice(2))), 'no address');
  await journal.release(owner, claim);
  assert.equal(f.store.values.size, 0);
  // A claim with no nonce (a batch's) keeps none, and a batch never reads one.
  const c2 = await journal.claim(owner);
  assert.equal(journal.read(owner).nonce, null);
  await journal.recordBatch(owner, c2, hash);
  assert.equal(journal.read(owner).nonce, null);
  await journal.release(owner, c2);
  // Storage that refuses the entry: the claim still stands, with no nonce (its outcome is then unknown, as before).
  const refusing = memory(), set = refusing.setItem;
  refusing.setItem = (key, value) => { if (key.startsWith('domino.routed-offer-nonce.')) throw new Error('quota'); set(key, value); };
  const tight = fixture(refusing).make(), c3 = await tight.claim(owner, 4n, evidence);
  assert.deepEqual(tight.read(owner), { claim: c3, hash: null, batchOperation: null, nonce: null, evidence: null });
});
test('atomic and sequential route offers share one owner latch; reload records only the atomic operation hash', async () => {
  const f = fixture(), first = f.make(), second = f.make(), claim = await first.claim(owner);
  await first.recordBatch(owner, claim, hash);
  assert.deepEqual(second.read(owner), { claim, hash: null, batchOperation: hash, nonce: null, evidence: null });
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


// Fix round 2 (2026-10-01): a routed swap the wallet replaced is told apart by the transaction that took its nonce.
// "Speed up" (the same router call under another hash) is the swap, done: never a reason to offer a second one.
// Fix round 3 (2026-10-01): the wallet's RPC keeps little old state, so the search stops at the block the swap was sent
// after, and where old state is gone the input's Permit2 allowance as it is now tells what it can.
// Fix round 3.1 (2026-10-01): a wallet may put the swap under a nonce of its own, so `not_swapped` needs proof that holds
// whatever nonce it went out with; a spent allowance is the swap gone through; logs find the reviewed call without old state.
const ROUTER = '0x204faca1764b154221e35c0d20abb3c525710498', PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const TOKEN = '0x' + '33'.repeat(20), OTHER_TOKEN = '0x' + '44'.repeat(20), ETH = '0x' + '00'.repeat(20);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const permitAbi = parseAbi(['function allowance(address,address,address) view returns (uint160,uint48,uint48)']);
/** The Permit2 allowance the reviewed permit set: the gross, until the route's deadline, nonce 0. */
const SET = { amount: 5_000_000n, expiration: 1_900_000_000n, nonce: 0n };
const KEY = { currency0: ETH, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: ETH };
const hexOf = value => `0x${BigInt(value).toString(16)}`;
/**
 * A chain that answers what telling a replacement apart reads. `at`: the block the transaction at `nonce` is in;
 * `keptFrom`: the oldest block whose state the node keeps; `time`: the newest block's time; `logs`: Transfer logs the
 * node holds (eth_getLogs answers those of the filter's address); `more`: other transactions by hash, each with its
 * receipt's status. Fix round 3.2: `profile`, a wallet RPC measured on the chain (config/chainRobinhood.ts): 'drpc'
 * refuses state at any numbered block, the head included, and logs over 200 blocks; 'publicnode' refuses logs from
 * further than 100 blocks under the head (its state depth is `keptFrom`).
 */
function replacementChain({ at = 50, latest = 1000, tx, status = '0x1', keptFrom = 0, nonce = 3n, permits = {}, permitFails = false, behind = false, time = 1_800_000_000, logs = [], logsFail = false, more = {}, topicsMatter = false, profile = null }) {
  const reads = [], heights = [], permitTags = [], filters = [];
  const replacement = { hash: '0x' + 'cd'.repeat(32), from: owner, nonce: hexOf(nonce), input: '0x', value: '0x0', ...tx };
  const byHash = { [replacement.hash]: { ...replacement, status }, ...more };
  const request = async (method, params) => {
    reads.push(method);
    if (method === 'eth_blockNumber') return hexOf(latest);
    if (method === 'eth_getTransactionCount') {
      if (params[1] === 'latest') return hexOf(latest >= at ? nonce + 1n : nonce);
      const block = Number(BigInt(params[1]));
      heights.push(block);
      if (profile === 'drpc') throw new Error('Unknown state');
      // A node that keeps state only from `keptFrom` on, as the chain's RPC keeps about 2,000 blocks.
      if (block < keptFrom) throw new Error('missing trie node');
      // `behind`: the node answering is a block behind the head another node reported (a load-balanced RPC).
      if (behind && block >= latest) throw new Error('header not found');
      return hexOf(block >= at ? nonce + 1n : nonce);
    }
    if (method === 'eth_getBlockByNumber') {
      // The newest block, with its time: where an allowance is read, and against which its expiry is told.
      if (params[0] === 'latest') { assert.equal(params[1], false); return { number: hexOf(latest), timestamp: hexOf(time) }; }
      assert.equal(params[1], true);
      const unrelated = { hash: '0x' + 'ee'.repeat(32), from: other, nonce: hexOf(nonce), to: ROUTER, input: '0x01', value: '0x0' };
      return { number: params[0], transactions: Number(BigInt(params[0])) === at ? [unrelated, replacement] : [unrelated] };
    }
    if (method === 'eth_getTransactionReceipt') {
      const found = byHash[params[0]];
      return found ? { transactionHash: found.hash, status: found.status ?? '0x1' } : null;
    }
    if (method === 'eth_getTransactionByHash') {
      const found = byHash[params[0]];
      if (!found) return null;
      const { status: _status, ...body } = found;
      return body;
    }
    if (method === 'eth_getLogs') {
      filters.push(params[0]);
      if (logsFail) throw new Error('the method eth_getLogs does not exist/is not available');
      if (profile === 'drpc' && Number(BigInt(params[0].toBlock)) - Number(BigInt(params[0].fromBlock)) > 200) throw new Error('ranges over 10000 blocks are not supported on free plan');
      if (profile === 'publicnode' && Number(BigInt(params[0].fromBlock)) < latest - 100) throw new Error('Archive requests require a personal token');
      const refusal = logLimitError(params[0]);
      if (refusal) throw Object.assign(new Error(refusal.message), { code: refusal.code });
      // `topicsMatter`: as a node filters them, by each topic asked; otherwise by address alone.
      return logs.filter(log => log.address === params[0].address && (!topicsMatter || params[0].topics.every((topic, place) => topic === null || topic === log.topics[place])));
    }
    if (method === 'eth_call') {
      // Permit2.allowance(owner, token, router) at a block: the only call a replacement is told apart with.
      assert.equal(params[0].to, PERMIT2);
      permitTags.push(params[1]);
      if (permitFails) throw new Error('the wallet could not reach the chain');
      if (profile === 'drpc' && params[1] !== 'latest') throw new Error('Unknown state');
      const { functionName, args } = decodeFunctionData({ abi: permitAbi, data: params[0].data });
      assert.deepEqual([functionName, args[0].toLowerCase(), args[2].toLowerCase()], ['allowance', owner, ROUTER]);
      const state = permits[args[1].toLowerCase()] ?? { amount: 0n, expiration: 0n, nonce: 0n };
      return encodeFunctionResult({ abi: permitAbi, functionName, result: [state.amount, Number(state.expiration), Number(state.nonce)] });
    }
    throw new Error(`unexpected ${method}`);
  };
  return { request, reads, heights, permitTags, filters };
}
/** What the chain tells of the swap at nonce 3. */
const told = (chain, evidence, context) => routedReplacement(chain.request, owner, 3n, evidence, context);
const kindOf = async (chain, evidence, context) => (await told(chain, evidence, context)).kind;
const DATA = '0x3593564c' + '00'.repeat(36);
/** Evidence as a send keeps it: no allowance (an ETH input) unless given. */
const kept = (more = {}) => ({ sentAfter: null, swap: swapDigest(DATA), permit: null, spent: null, pool: null, ...more });
const KEPT = permitDigest(owner, TOKEN, SET), SPENT = permitDigest(owner, TOKEN, { ...SET, amount: 0n });

test('a replaced routed swap: the reviewed router call swapped or reverted, a Cancel did not, and anything else is not taken for either', async () => {
  const reviewed = kept();
  const sped = replacementChain({ tx: { to: ROUTER, input: DATA } });
  assert.deepEqual(await told(sped, reviewed), { kind: 'swapped' });
  assert.ok(sped.reads.filter(method => method === 'eth_getTransactionCount').length <= 48);
  assert.equal(await kindOf(replacementChain({ tx: { to: ROUTER, input: DATA.toUpperCase().replace('0X', '0x') } }), reviewed), 'swapped', 'the reviewed call, in any case');
  // Fix round 3: the reviewed calldata's digest is required, after a reload too; another router call is never the swap.
  assert.equal(await kindOf(replacementChain({ tx: { to: ROUTER, input: DATA } }), null), 'unknown', 'no digest kept: never taken for the swap');
  assert.equal(await kindOf(replacementChain({ tx: { to: ROUTER, input: DATA } }), kept({ swap: swapDigest('0x3593564c') })), 'unknown', 'another router call than the reviewed one');
  assert.equal(await kindOf(replacementChain({ tx: { to: ROUTER, input: DATA }, status: '0x0' }), reviewed), 'reverted');
  // Fix round 3.1: another router call that reverted is not the reviewed one reverting.
  assert.equal(await kindOf(replacementChain({ tx: { to: ROUTER, input: '0x3593564c' }, status: '0x0' }), reviewed), 'unknown');
  assert.equal(await kindOf(replacementChain({ tx: { to: owner, input: '0x' } }), reviewed), 'not_swapped', 'a cancel: 0 ETH to the account itself (an ETH input)');
  // Fix round 3.1: another dapp's transaction at the nonce (a wallet that sets its own nonces may have put the swap at the
  // next one, not sequenced yet) is never taken for a cancel.
  assert.equal(await kindOf(replacementChain({ tx: { to: other, input: '0xa9059cbb' } }), null), 'unknown', 'another call took the nonce');
  assert.equal(await kindOf(replacementChain({ tx: { to: owner, input: '0x', value: '0x1' } }), reviewed), 'unknown', 'ETH to itself is not a cancel');
  assert.equal(await kindOf(replacementChain({ tx: { to: owner, input: '0x1234' } }), reviewed), 'unknown', "the account's own code ran a call");
  assert.equal(await kindOf(replacementChain({ tx: { to: ROUTER, input: DATA }, at: 2000 }), reviewed), 'unknown', 'the nonce has not passed');
  assert.equal(await kindOf(replacementChain({ tx: { to: ROUTER, input: DATA, from: other } }), reviewed), 'unknown', 'no transaction of the owner at that nonce');
  assert.equal(await kindOf(replacementChain({ tx: { to: ROUTER, input: DATA }, at: 1000 }), reviewed), 'swapped', 'in the newest block');
  assert.equal(await kindOf(replacementChain({ tx: { to: ROUTER, input: DATA }, at: 0 }), reviewed), 'swapped', 'in the first block');
  const far = replacementChain({ tx: { to: ROUTER, input: DATA }, at: 5, latest: 2 ** 30 });
  assert.equal(await kindOf(far, reviewed), 'unknown', 'too far back to search');
  assert.ok(far.reads.filter(method => method === 'eth_getTransactionCount').length <= 48);
});
test('a replaced routed swap is searched for no further back than the block it was sent after, and above any state the node refuses', async () => {
  // Replaced 300 blocks ago, on a node that keeps 400: the doubling search overshoots to 512 back and meets pruned state.
  const pruned = { tx: { to: ROUTER, input: DATA }, at: 700, latest: 1000, keptFrom: 600 };
  // Changed on purpose in fix round 3.1: the refused probe ends the doubling, and the block is searched for above it.
  const unbounded = replacementChain(pruned);
  assert.equal(await kindOf(unbounded, kept()), 'swapped');
  assert.ok(unbounded.heights.some(block => block < 600), 'a probe met state the node no longer keeps');
  // Kept in the journal, the block the swap was sent after bounds it: no state at or below it is ever asked for.
  const bounded = replacementChain(pruned);
  assert.equal(await kindOf(bounded, kept({ sentAfter: 650n })), 'swapped');
  assert.ok(bounded.heights.every(block => block > 650), bounded.heights.join(','));
  // A block the swap was sent after that the head has not reached (a node behind) bounds nothing.
  assert.equal(await kindOf(replacementChain({ ...pruned, keptFrom: 0 }), kept({ sentAfter: 5000n })), 'swapped');
});
// Fix round 3.1, the recheck's finding: the doubling read latest-2048 for a replacement 1,500 blocks old on a node that keeps
// 2,000, was refused, and gave up, though the block was inside the state kept.
test('fix round 3.1: a refused nonce read on the way down ends the doubling there, and the block is searched for above it', async () => {
  const evidence = kept({ sentAfter: 7900n });
  const chain = replacementChain({ tx: { to: ROUTER, input: DATA }, latest: 10_000, keptFrom: 8000, at: 8500 });
  assert.deepEqual(await told(chain, evidence), { kind: 'swapped' });
  assert.ok(chain.heights.includes(7952), 'the probe 2,048 blocks back was refused');
  assert.ok(chain.heights.every(block => block > 7900), 'never at or under the block it was sent after');
  // Older than the state kept: the newest block above it does not hold the transaction, so nothing is taken from it.
  assert.equal(await kindOf(replacementChain({ tx: { to: ROUTER, input: DATA }, latest: 10_000, keptFrom: 8000, at: 7950 }), evidence), 'unknown');
  // Every read refused but the newest: nothing found, nothing assumed.
  assert.equal(await kindOf(replacementChain({ tx: { to: ROUTER, input: DATA }, latest: 10_000, keptFrom: 9999, at: 8500 }), evidence), 'unknown');
});
test('where old state is gone, the input’s Permit2 allowance as it is now decides what it can: untouched, spent, changed or unread', async () => {
  const evidence = kept({ sentAfter: 640n, permit: KEPT, spent: SPENT });
  // A transaction 360 blocks back on a node that keeps 100: its block cannot be found.
  const gone = (more = {}) => replacementChain({ tx: { to: owner, input: '0x' }, at: 700, latest: 1000, keptFrom: 900, ...more });
  assert.equal(await kindOf(gone(), kept({ sentAfter: 640n })), 'unknown', 'no allowance kept (an ETH input)');
  // Changed on purpose in fix round 3.1: untouched, but the swap may sit under another nonce: not proven never to run until
  // the allowance expires (Permit2 then refuses it, and the router call's same deadline has passed).
  const untouched = gone({ permits: { [TOKEN]: SET } });
  assert.deepEqual(await told(untouched, evidence, { tokens: [ETH, OTHER_TOKEN, TOKEN] }), { kind: 'untouched', until: 1_900_000_000 });
  // Read at the newest block, where the nonce is seen passed: never 'latest', which a node behind could answer from before the replacement.
  assert.deepEqual(untouched.permitTags, ['0x3e8', '0x3e8']);
  assert.deepEqual(await told(gone({ permits: { [TOKEN]: SET }, time: 1_900_000_000 }), evidence, { tokens: [TOKEN] }), { kind: 'untouched', until: 1_900_000_000 }, 'still spendable at its expiry');
  assert.deepEqual(await told(gone({ permits: { [TOKEN]: SET }, time: 1_900_000_001 }), evidence, { tokens: [TOKEN] }), { kind: 'not_swapped' }, 'expired untouched: nothing can take it any more');
  assert.equal(await kindOf(gone({ permits: { [TOKEN]: SET }, behind: true }), evidence, { tokens: [TOKEN] }), 'unknown', 'a node behind the head reads nothing');
  assert.equal(await kindOf(gone({ permits: { [TOKEN]: SET } }), evidence, { tokens: [OTHER_TOKEN] }), 'unknown', 'another pool’s tokens: not this allowance');
  assert.equal(await kindOf(gone({ permits: { [TOKEN]: SET } }), evidence, { tokens: [] }), 'unknown', 'no token to read');
  assert.equal(await kindOf(gone({ permits: { [TOKEN]: SET }, permitFails: true }), evidence, { tokens: [TOKEN] }), 'unknown', 'unread');
  assert.equal(await kindOf(gone({ permits: { [TOKEN]: SET }, at: 2000 }), evidence, { tokens: [TOKEN] }), 'unknown', 'never before the nonce has passed: the swap could still be mined');
  // What history proves is never overruled: the reviewed call that swapped stays `swapped`.
  assert.equal(await kindOf(replacementChain({ tx: { to: ROUTER, input: DATA }, at: 700, permits: { [TOKEN]: SET } }), evidence, { tokens: [TOKEN] }), 'swapped');
  // Another router call, or the account's own code, at the nonce, the input untouched: it may yet be taken until it expires.
  assert.equal(await kindOf(replacementChain({ tx: { to: ROUTER, input: '0x3593564c' }, at: 700, permits: { [TOKEN]: SET } }), evidence, { tokens: [TOKEN] }), 'untouched');
  assert.equal(await kindOf(replacementChain({ tx: { to: owner, input: '0x1234' }, at: 700, permits: { [TOKEN]: SET }, time: 1_900_000_100 }), evidence, { tokens: [TOKEN] }), 'not_swapped');
});
// Fix round 3.1, the recheck's high finding: a speed-up found after old state is gone spent the swap's Permit2 allowance,
// read as `unknown`, and a later one-token press offered "It did not go through": one click, a fresh quote, and a second
// swap and fee for the same deposit. Spent exactly as the reviewed swap spends it, it is the swap gone through; changed
// otherwise, it is never let go on the person's word.
test('fix round 3.1: an allowance spent as the reviewed swap spends it is the swap gone through; one changed otherwise is `changed`, never `unknown`', async () => {
  const evidence = kept({ sentAfter: 640n, permit: KEPT, spent: SPENT });
  const gone = (state, more = {}) => replacementChain({ tx: { to: ROUTER, input: DATA }, at: 700, latest: 1000, keptFrom: 900, permits: { [TOKEN]: state }, ...more });
  assert.deepEqual(await told(gone({ ...SET, amount: 0n }), evidence, { tokens: [ETH, TOKEN] }), { kind: 'spent' });
  assert.equal(await kindOf(gone({ ...SET, amount: 0n }), evidence, { tokens: [TOKEN], input: TOKEN }), 'spent', 'in the same press');
  // A record of round 3 kept no `spent`: a spent allowance is a changed one there.
  assert.equal(await kindOf(gone({ ...SET, amount: 0n }), kept({ sentAfter: 640n, permit: KEPT }), { tokens: [ETH, TOKEN], thisPool: true }), 'changed');
  for (const [state, why] of [[{ ...SET, amount: 1n }, 'spent by another amount'], [{ ...SET, expiration: SET.expiration + 1n }, 'set again since'], [{ ...SET, nonce: 1n }, 'a signed permit since']]) {
    assert.equal(await kindOf(gone(state), evidence, { tokens: [ETH, TOKEN], thisPool: true }), 'changed', why);
    assert.equal(await kindOf(gone(state), evidence, { tokens: [TOKEN], input: TOKEN }), 'changed', `${why}, in the same press`);
    // Where the input is not surely among the tokens read (a record from before the pool was kept), nothing is known.
    assert.equal(await kindOf(gone(state), evidence, { tokens: [ETH, TOKEN] }), 'unknown', `${why}, the pool not known`);
  }
  assert.equal(await kindOf(gone(SET, { permitFails: true }), evidence, { tokens: [ETH, TOKEN], thisPool: true }), 'unknown', 'unread is never changed');
  assert.equal(await kindOf(gone({ ...SET, amount: 1n }), evidence, { tokens: [OTHER_TOKEN, TOKEN], thisPool: true }), 'changed', 'both tokens read, neither matching');
});
// Fix round 3.1, the recheck's medium finding: the transaction at the nonce the page prepared may not be the swap's
// replacement (a wallet that sets its own nonces may have put the swap at the next one). A release needs proof that holds
// whatever nonce it went out with.
test('fix round 3.1: only a Cancel at the nonce, with an ERC-20 input’s allowance untouched beside it, or an untouched allowance expired, says the swap never happened', async () => {
  const evidence = kept({ sentAfter: 640n, permit: KEPT, spent: SPENT });
  const at = (tx, more = {}) => replacementChain({ tx, at: 700, ...more });
  const cancel = { to: owner, input: '0x', value: '0x0' };
  assert.equal(await kindOf(at(cancel, { permits: { [TOKEN]: SET } }), evidence, { tokens: [TOKEN] }), 'not_swapped', 'a cancel, the allowance untouched beside it');
  assert.equal(await kindOf(at(cancel, { permits: { [TOKEN]: { ...SET, amount: 0n } } }), evidence, { tokens: [TOKEN] }), 'spent', 'a cancel at the nonce, the swap gone through under another');
  assert.equal(await kindOf(at(cancel, { permits: { [TOKEN]: { ...SET, amount: 7n } } }), evidence, { tokens: [TOKEN], input: TOKEN }), 'changed');
  assert.equal(await kindOf(at(cancel, { permits: { [TOKEN]: SET }, permitFails: true }), evidence, { tokens: [TOKEN] }), 'unknown', 'a cancel beside an allowance kept but unread now');
  assert.equal(await kindOf(at(cancel), kept({ sentAfter: 640n }), { tokens: [ETH, TOKEN] }), 'not_swapped', 'an ETH input: nothing to read beside the cancel');
  // Another dapp's transaction at the nonce.
  const another = { to: other, input: '0xa9059cbb' };
  assert.equal(await kindOf(at(another), kept({ sentAfter: 640n }), { tokens: [ETH, TOKEN] }), 'unknown', 'an ETH input: the person’s word');
  assert.deepEqual(await told(at(another, { permits: { [TOKEN]: SET } }), evidence, { tokens: [TOKEN] }), { kind: 'untouched', until: 1_900_000_000 });
  assert.deepEqual(await told(at(another, { permits: { [TOKEN]: SET }, time: 1_900_000_001 }), evidence, { tokens: [TOKEN] }), { kind: 'not_swapped' });
  assert.equal(await kindOf(at(another, { permits: { [TOKEN]: { ...SET, amount: 0n } } }), evidence, { tokens: [TOKEN] }), 'spent');
});
// Fix round 3.1, the recheck's high finding (case B): an ETH input has no allowance, so a speed-up found after old state is
// gone read `unknown` and offered "It did not go through". The reviewed call is now found by what it paid this wallet.
test('fix round 3.1: where old state is gone, the reviewed router call is found by the pool’s token it paid this wallet, whatever its nonce; logs only ever prove the swap', async () => {
  const evidence = kept({ sentAfter: 640n });
  const replacement = '0x' + 'cd'.repeat(32), elsewhere = '0x' + 'c9'.repeat(32);
  const paid = (address, transactionHash) => ({ address, topics: [TRANSFER, pad(other), pad(owner)], transactionHash, blockNumber: '0x2bc' });
  const gone = (more = {}) => replacementChain({ tx: { to: ROUTER, input: DATA }, at: 700, keptFrom: 900, logs: [paid(TOKEN, replacement)], ...more });
  const chain = gone();
  assert.deepEqual(await told(chain, evidence, { tokens: [ETH, TOKEN] }), { kind: 'swapped' });
  // Two filters per ERC-20 token of the pool (to the wallet, from it): one address, one value per topic, from the block
  // after the one the swap was sent after, inside the chain RPC's limits.
  assert.deepEqual(chain.filters, [
    { address: TOKEN, topics: [TRANSFER, null, pad(owner)], fromBlock: '0x281', toBlock: '0x3e8' },
    { address: TOKEN, topics: [TRANSFER, pad(owner)], fromBlock: '0x281', toBlock: '0x3e8' },
  ]);
  for (const filter of chain.filters) assert.equal(logLimitError(filter), null);
  // An ERC-20 input whose output is ETH: found by what it took from the wallet.
  const taken = { address: TOKEN, topics: [TRANSFER, pad(owner), pad(other)], transactionHash: replacement, blockNumber: '0x2bc' };
  const fromWallet = replacementChain({ tx: { to: ROUTER, input: DATA }, at: 700, keptFrom: 900, logs: [taken], topicsMatter: true });
  assert.equal(await kindOf(fromWallet, evidence, { tokens: [ETH, TOKEN] }), 'swapped');
  assert.deepEqual(fromWallet.filters.map(filter => filter.topics), [[TRANSFER, null, pad(owner)], [TRANSFER, pad(owner)]]);
  // A wallet that put it under a nonce of its own: the call is the swap all the same.
  const another = replacementChain({ tx: { to: other, input: '0xa9059cbb' }, at: 700, logs: [paid(TOKEN, elsewhere)],
    more: { [elsewhere]: { hash: elsewhere, from: owner, to: ROUTER, input: DATA, nonce: '0x4', value: '0x0', status: '0x1' } } });
  assert.equal(await kindOf(another, evidence, { tokens: [ETH, TOKEN] }), 'swapped');
  // Long after the send: one span of 100,000 blocks from it.
  const late = gone({ latest: 400_000, keptFrom: 399_000 });
  assert.equal(await kindOf(late, evidence, { tokens: [ETH, TOKEN] }), 'swapped');
  assert.deepEqual([late.filters[0].fromBlock, late.filters[0].toBlock], ['0x281', hexOf(640 + 100_000)]);
  assert.equal(logLimitError({ ...late.filters[0], address: [TOKEN, OTHER_TOKEN] }), null, 'within the limit even for a filter of several values');
  // What proves nothing: no logs, a refused read, no block the swap was sent after, a payment by a transaction that is not
  // this wallet's reviewed call, or one that reverted.
  assert.equal(await kindOf(gone({ logs: [] }), evidence, { tokens: [ETH, TOKEN] }), 'unknown');
  assert.equal(await kindOf(gone({ logsFail: true }), evidence, { tokens: [ETH, TOKEN] }), 'unknown');
  assert.equal(await kindOf(gone(), kept(), { tokens: [ETH, TOKEN] }), 'unknown', 'no block the swap was sent after');
  assert.equal(await kindOf(gone(), evidence, { tokens: [ETH] }), 'unknown', 'no ERC-20 to look at');
  for (const [body, why] of [[{ from: other }, 'another sender'], [{ input: '0x3593564c' }, 'another router call'], [{ to: other }, 'not the router'], [{ status: '0x0' }, 'reverted']]) {
    const tx = { hash: elsewhere, from: owner, to: ROUTER, input: DATA, nonce: '0x4', value: '0x0', status: '0x1', ...body };
    assert.equal(await kindOf(replacementChain({ tx: { to: other, input: '0xa9059cbb' }, at: 700, keptFrom: 900, logs: [paid(TOKEN, elsewhere)], more: { [elsewhere]: tx } }), evidence, { tokens: [ETH, TOKEN] }), 'unknown', why);
  }
  // At most eight transactions that paid this wallet are read. Changed on purpose in fix round 3.2: the oldest first (below).
  const many = Array.from({ length: 12 }, (_, i) => paid(TOKEN, `0x${(0x10 + i).toString(16).padStart(64, '0')}`));
  const busy = gone({ logs: many });
  assert.equal(await kindOf(busy, evidence, { tokens: [ETH, TOKEN] }), 'unknown');
  assert.equal(busy.reads.filter(method => method === 'eth_getTransactionByHash').length, 8);
});
test('what a routed swap leaves in the journal is read right before it is sent: the head less a margin, the calldata’s digest, the input’s allowance and the one the swap leaves, and the pool', async () => {
  const data = '0x3593564c' + 'ab'.repeat(36);
  const chain = replacementChain({ tx: { to: owner }, permits: { [TOKEN]: SET } });
  assert.deepEqual(await routeEvidence(chain.request, owner, TOKEN, SET.amount, data, KEY),
    { sentAfter: 992n, swap: swapDigest(data), permit: permitDigest(owner, TOKEN, SET), spent: permitDigest(owner, TOKEN, { ...SET, amount: 0n }), pool: poolDigest(owner, KEY), deadline: null });
  assert.deepEqual(chain.permitTags, ['latest'], 'before the send, the allowance as it stands now');
  assert.equal(swapDigest(data), swapDigest(data.toUpperCase().replace('0X', '0x')));
  assert.notEqual(permitDigest(owner, TOKEN, SET), permitDigest(other, TOKEN, SET), 'bound to the owner');
  assert.notEqual(permitDigest(owner, TOKEN, SET), permitDigest(owner, OTHER_TOKEN, SET), 'and to the token');
  assert.deepEqual(await routeEvidence(replacementChain({ tx: {}, latest: 3 }).request, owner, ETH, 7n, data, KEY), { sentAfter: 0n, swap: swapDigest(data), permit: null, spent: null, pool: poolDigest(owner, KEY), deadline: null }, 'ETH input: no allowance; an early head');
  assert.deepEqual(await routeEvidence(replacementChain({ tx: {}, permits: { [TOKEN]: { ...SET, amount: 2n ** 160n - 1n } } }).request, owner, TOKEN, SET.amount, data, KEY),
    { sentAfter: 992n, swap: swapDigest(data), permit: null, spent: null, pool: poolDigest(owner, KEY), deadline: null }, 'an unlimited allowance is never spent from: it proves nothing');
  assert.equal((await routeEvidence(chain.request, owner, TOKEN, SET.amount + 1n, data, KEY)).spent, null, 'an allowance short of the swap leaves nothing it could be spent to');
  const failing = async (method) => { throw new Error(`${method} unavailable`); };
  assert.deepEqual(await routeEvidence(failing, owner, TOKEN, SET.amount, data, KEY), { sentAfter: null, swap: swapDigest(data), permit: null, spent: null, pool: poolDigest(owner, KEY), deadline: null }, 'reads that fail leave their part out');
});
// Fix round 3.1, the recheck's low finding: for a WalletConnect wallet, every read of the wallet's provider was the page's own
// read of the chain's public RPCs (wallet/walletConnectProvider.ts), which the owner's rule forbids adding. Since the RPC
// switch (merged 2026-10-02) the site serves such a wallet no read at all (lib/walletReads.ts readOnChain, RPC-SPEC D6).
test('fix round 3.1: a wallet that hands its reads to the site is asked nothing to tell a replacement apart', async () => {
  const asked = [];
  const injected = { request: async (method, params) => { asked.push([method, params]); return '0x1'; } };
  const reads = walletOwnReads(injected);
  assert.equal(await reads('eth_blockNumber', []), '0x1');
  assert.deepEqual(asked, [['eth_blockNumber', []]], 'an injected wallet answers through its own provider');
  assert.equal(walletOwnReads({ ...injected, readsThroughPage: false }) === null, false);
  assert.equal(walletOwnReads({ ...injected, readsThroughPage: true }), null, 'WalletConnect: none');
  // With no reads, the journal keeps only the digests that need none.
  const data = '0x3593564c' + 'ab'.repeat(36);
  assert.deepEqual(await routeEvidence(null, owner, TOKEN, 5n, data, KEY), { sentAfter: null, swap: swapDigest(data), permit: null, spent: null, pool: poolDigest(owner, KEY), deadline: null });
  // The flag is set for WalletConnect's connector only, and every read made to tell a replacement apart goes through the gate.
  const walletSource = readFileSync(new URL('../src/finance/wallet.ts', import.meta.url), 'utf8');
  assert.match(walletSource, /readsThroughPage: connector\.id === WALLETCONNECT_ID,/);
  const page = readFileSync(new URL('../src/components/create/CreatePosition.tsx', import.meta.url), 'utf8');
  assert.equal((page.match(/routeEvidence\(/g) ?? []).length, 1);
  assert.match(page, /routeEvidence\(walletOwnReads\(rpc\)/);
  for (const call of page.match(/await routedReplacement\([^,]+/g) ?? []) assert.equal(call, 'await routedReplacement(reads');
  assert.equal((page.match(/await routedReplacement\(/g) ?? []).length, 2);
});
// Fix round 3.1: where a nonce stands, for a routed swap offered with no hash back.
test('fix round 3.1: where the nonce of a swap offered with no hash back stands on chain', async () => {
  const wallet = (latest, pending) => ({ owner, request: async (method, params) => {
    assert.equal(method, 'eth_getTransactionCount');
    return hexOf(params[1] === 'latest' ? latest : pending);
  } });
  assert.equal(await nonceStanding(wallet(5, 5), 4n), 'passed', 'a transaction took it');
  assert.equal(await nonceStanding(wallet(4, 4), 4n), 'open', 'still the next one, nothing pending');
  assert.equal(await nonceStanding(wallet(4, 5), 4n), 'pending', 'a transaction is waiting on chain');
  assert.equal(await nonceStanding(wallet(3, 3), 4n), 'behind', 'a node behind');
  await assert.rejects(nonceStanding({ owner, request: async () => 'x' }, 4n), /invalid_wallet_quantity/);
});
// Fix round 3.1: the record keeps the owner and pool it was for, so it guards that pool's deposit only.
test('fix round 3.1: the pool a routed swap was for is kept as a digest of the owner and the pool key', () => {
  assert.equal(poolDigest(owner, KEY), poolDigest(owner.toUpperCase().replace('0X', '0x'), { ...KEY, currency1: TOKEN.toUpperCase().replace('0X', '0x') }));
  assert.notEqual(poolDigest(owner, KEY), poolDigest(other, KEY), 'bound to the owner');
  for (const change of [{ currency1: OTHER_TOKEN }, { fee: 500 }, { tickSpacing: 10 }, { hooks: other }]) assert.notEqual(poolDigest(owner, KEY), poolDigest(owner, { ...KEY, ...change }), JSON.stringify(change));
  assert.match(poolDigest(owner, KEY), /^0x[0-9a-f]{64}$/);
});

// Fix round 3.2 (2026-10-02), the recheck of 418f7bf: the reviewed call is mined right after the block it was sent after,
// so it is the oldest transfer of the window. Read newest first, eight later transfers of that token pushed it out, and an
// ETH input that went through read `unknown` (with "It did not go through" offered).
test('fix round 3.2: the logs are read oldest first, so later transfers of the wallet never push the reviewed call out', async () => {
  const evidence = kept({ sentAfter: 640n });
  const replacement = '0x' + 'cd'.repeat(32);
  const log = (transactionHash, block, topics, logIndex = 0) => ({ address: TOKEN, topics, transactionHash, blockNumber: hexOf(block), logIndex: hexOf(logIndex) });
  const toOwner = [TRANSFER, pad(other), pad(owner)], fromOwner = [TRANSFER, pad(owner), pad(other)];
  // Twelve later transfers of TOKEN, in and out, all after the swap's payout at block 645; the out ones are asked last.
  const later = Array.from({ length: 12 }, (_, i) => log(`0x${(0x10 + i).toString(16).padStart(64, '0')}`, 700 + i, i % 2 ? fromOwner : toOwner));
  const chain = replacementChain({ tx: { to: ROUTER, input: DATA }, at: 645, keptFrom: 900, logs: [...later, log(replacement, 645, toOwner)], topicsMatter: true });
  assert.deepEqual(await told(chain, evidence, { tokens: [ETH, TOKEN] }), { kind: 'swapped' });
  assert.equal(chain.reads.filter(method => method === 'eth_getTransactionByHash').length, 1, 'the oldest is read first, and it is the swap');
  // By place in the block too.
  const same = replacementChain({ tx: { to: ROUTER, input: DATA }, at: 645, keptFrom: 900, logs: [log(`0x${'77'.repeat(32)}`, 645, toOwner, 9), log(replacement, 645, toOwner, 2)], topicsMatter: true });
  assert.equal(await kindOf(same, evidence, { tokens: [ETH, TOKEN] }), 'swapped');
  assert.equal(same.reads.filter(method => method === 'eth_getTransactionByHash').length, 1);
  // Still at most eight read: eight older transfers in the window come first, and nothing is assumed.
  const older = Array.from({ length: 8 }, (_, i) => log(`0x${(0x40 + i).toString(16).padStart(64, '0')}`, 641 + (i % 4), toOwner, i));
  const capped = replacementChain({ tx: { to: ROUTER, input: DATA }, at: 645, keptFrom: 900, logs: [log(replacement, 645, toOwner), ...older], topicsMatter: true });
  assert.equal(await kindOf(capped, evidence, { tokens: [ETH, TOKEN] }), 'unknown');
  assert.equal(capped.reads.filter(method => method === 'eth_getTransactionByHash').length, 8);
});
// Fix round 3.2, the recheck's high finding: the fix of 3.1 held only on an RPC that serves numbered state and logs at any
// depth. dRPC answers state at 'latest' only (any numbered block refused) and logs over 200 blocks not at all.
test('fix round 3.2: on a wallet RPC that answers state at latest only (dRPC), a spent allowance reads spent and a changed one changed; an untouched one proves nothing', async () => {
  const evidence = kept({ sentAfter: 640n, permit: KEPT, spent: SPENT });
  const drpc = (state, more = {}) => replacementChain({ tx: { to: ROUTER, input: DATA }, at: 700, permits: { [TOKEN]: state }, profile: 'drpc', ...more });
  const spent = drpc({ ...SET, amount: 0n });
  assert.deepEqual(await told(spent, evidence, { tokens: [ETH, TOKEN] }), { kind: 'spent' });
  assert.deepEqual(spent.permitTags, ['latest'], 'read at latest, the only state it serves');
  assert.equal(spent.filters.length, 2, 'the logs were asked, and refused past its span');
  assert.equal(await kindOf(drpc({ ...SET, amount: 1n }), evidence, { tokens: [ETH, TOKEN], thisPool: true }), 'changed');
  assert.equal(await kindOf(drpc({ ...SET, amount: 1n }), evidence, { tokens: [TOKEN], input: TOKEN }), 'changed', 'in the same press');
  assert.equal(await kindOf(drpc(SET), evidence, { tokens: [ETH, TOKEN], thisPool: true }), 'unknown', 'untouched at latest: a node behind the swap could answer so');
  assert.equal(await kindOf(drpc(SET, { time: 1_900_000_001 }), evidence, { tokens: [TOKEN], thisPool: true }), 'unknown', 'never let go from a read at latest');
  assert.equal(await kindOf(drpc(SET, { permitFails: true }), evidence, { tokens: [TOKEN], thisPool: true }), 'unknown', 'unread');
  // An ETH input: no allowance, no logs that far: said plainly as not told apart.
  assert.equal(await kindOf(drpc(SET), kept({ sentAfter: 640n }), { tokens: [ETH, TOKEN] }), 'unknown');
  // Within its span the logs still prove the swap.
  const paid = { address: TOKEN, topics: [TRANSFER, pad(other), pad(owner)], transactionHash: '0x' + 'cd'.repeat(32), blockNumber: hexOf(700), logIndex: '0x0' };
  assert.equal(await kindOf(replacementChain({ tx: { to: ROUTER, input: DATA }, at: 700, latest: 750, profile: 'drpc', logs: [paid] }), kept({ sentAfter: 640n }), { tokens: [ETH, TOKEN] }), 'swapped');
});
test('fix round 3.2: on publicnode (logs about 100 blocks back, little state), an ETH input found later reads `unknown`, said plainly; within its reach the logs prove it', async () => {
  const replacement = '0x' + 'cd'.repeat(32);
  const paid = block => ({ address: TOKEN, topics: [TRANSFER, pad(other), pad(owner)], transactionHash: replacement, blockNumber: hexOf(block), logIndex: '0x0' });
  const late = replacementChain({ tx: { to: ROUTER, input: DATA }, at: 700, latest: 1000, keptFrom: 970, profile: 'publicnode', logs: [paid(700)] });
  assert.equal(await kindOf(late, kept({ sentAfter: 640n }), { tokens: [ETH, TOKEN] }), 'unknown');
  assert.ok(late.filters.length > 0, 'asked, and refused that deep');
  const soon = replacementChain({ tx: { to: ROUTER, input: DATA }, at: 950, latest: 1000, keptFrom: 970, profile: 'publicnode', logs: [paid(950)] });
  assert.equal(await kindOf(soon, kept({ sentAfter: 940n }), { tokens: [ETH, TOKEN] }), 'swapped');
});
// Fix round 3.2, the recheck's high finding: a swap offered with no hash back may still be in the wallet. A Cancel-shaped
// transaction at its nonce (another request of the wallet's) let its journal go, and the old request could still be
// approved and swap a second time.
test('fix round 3.2: for a swap offered with no hash back, a Cancel at its nonce proves nothing; only an expired untouched allowance does', async () => {
  const cancel = { to: owner, input: '0x', value: '0x0' };
  assert.equal(await kindOf(replacementChain({ tx: cancel, at: 700 }), kept({ sentAfter: 640n }), { tokens: [ETH, TOKEN], unanswered: true }), 'unknown');
  assert.equal(await kindOf(replacementChain({ tx: cancel, at: 700 }), kept({ sentAfter: 640n }), { tokens: [ETH, TOKEN] }), 'not_swapped', 'with its hash back, as before');
  const evidence = kept({ sentAfter: 640n, permit: KEPT, spent: SPENT });
  assert.deepEqual(await told(replacementChain({ tx: cancel, at: 700, permits: { [TOKEN]: SET } }), evidence, { tokens: [TOKEN], unanswered: true }), { kind: 'untouched', until: 1_900_000_000 });
  assert.deepEqual(await told(replacementChain({ tx: cancel, at: 700, permits: { [TOKEN]: SET }, time: 1_900_000_001 }), evidence, { tokens: [TOKEN], unanswered: true }), { kind: 'not_swapped' }, 'an allowance expired untouched still proves it');
  // Approved late, under the next nonce: found by what it paid the wallet.
  const elsewhere = '0x' + 'c9'.repeat(32);
  const approved = replacementChain({ tx: cancel, at: 700, logs: [{ address: TOKEN, topics: [TRANSFER, pad(other), pad(owner)], transactionHash: elsewhere, blockNumber: hexOf(701), logIndex: '0x0' }],
    more: { [elsewhere]: { hash: elsewhere, from: owner, to: ROUTER, input: DATA, nonce: '0x4', value: '0x0', status: '0x1' } } });
  assert.equal(await kindOf(approved, kept({ sentAfter: 640n }), { tokens: [ETH, TOKEN], unanswered: true }), 'swapped');
});
// Fix round 3.2, the recheck's findings on `spent`: Permit2's lockdown (revoke tools), or approve to 0 with the same expiry,
// after a cancel leaves exactly the allowance the swap leaves. It stays `spent`, a sign the page never says as proof.
test('fix round 3.2: an allowance read as the swap leaves it is a sign, not proof: it keeps every guard, and the page never says the swap went through on it', async () => {
  const evidence = kept({ sentAfter: 640n, permit: KEPT, spent: SPENT });
  const lockdown = replacementChain({ tx: { to: owner, input: '0x', value: '0x0' }, at: 700, permits: { [TOKEN]: { ...SET, amount: 0n } } });
  assert.equal(await kindOf(lockdown, evidence, { tokens: [TOKEN] }), 'spent', 'a cancel, then a revoke: the same allowance as a swap leaves');
  const page = readFileSync(new URL('../src/components/create/CreatePosition.tsx', import.meta.url), 'utf8');
  const sentence = name => page.match(new RegExp(`const ${name} = '([^']+)'`))?.[1] ?? '';
  for (const name of ['ROUTE_SPENT', 'ROUTE_SPENT_BALANCES', 'ROUTE_ELSEWHERE_SPENT']) {
    assert.ok(sentence(name).length > 0, name);
    assert.doesNotMatch(sentence(name), /the swap went through|took from your wallet|completed/, name);
  }
  assert.match(sentence('ROUTE_SPENT_BALANCES'), /may have gone through/);
  assert.match(page, /r\.outcome === 'spent' \? ROUTE_SPENT_BALANCES/);
});
// Fix round 3.2, the recheck's findings: a press in another pool let go of a record for a swap that went through, after
// which that pool's one-token deposit could be offered a second swap and fee. A record is now moved aside, never let go.
test('fix round 3.2: a record for another pool’s deposit is moved aside, never let go: it still guards its pool, and the slot is free', async () => {
  const f = fixture(), journal = f.make();
  const poolA = '0x' + 'a1'.repeat(32), poolB = '0x' + 'b2'.repeat(32), swap = '0x' + '5a'.repeat(32);
  const evidence = { sentAfter: 90n, swap, permit: null, spent: null, pool: poolA, deadline: 1_800_000_000n };
  const claim = await journal.claim(owner, 4n, evidence);
  await journal.record(owner, claim, hash);
  assert.equal(await journal.park(owner, '12345678-1234-1234-1234-999999999999'), false, 'only this claim');
  assert.equal(await journal.park(owner, claim), true);
  assert.equal(journal.read(owner), null, 'the slot is free');
  assert.deepEqual(journal.parked(owner, poolA), { claim, hash, batchOperation: null, nonce: 4n, evidence });
  assert.equal(journal.parked(owner, poolB), null, 'it guards its own pool only');
  const parkedKey = [...f.store.values.keys()].find(key => key.startsWith('domino.routed-parked.v1.'));
  assert.equal(f.store.values.get(parkedKey), `${claim}|${hash}|4|90|${swap}|||${poolA}|1800000000`);
  assert.ok([...f.store.values.keys(), ...f.store.values.values()].every(v => !v.includes(owner.slice(2))), 'no address');
  assert.equal(f.make().parked(owner, poolA).claim, claim, 'after a reload too');
  // A routed swap for another pool may now be claimed; a second record for pool A is not moved aside while one is.
  const forB = await journal.claim(owner, 5n, { ...evidence, pool: poolB });
  await journal.release(owner, forB);
  const againA = await journal.claim(owner, 6n, evidence);
  assert.equal(await journal.park(owner, againA), false, 'one moved aside per pool');
  assert.equal(journal.read(owner).claim, againA, 'it stays in the slot');
  await journal.release(owner, againA);
  // Let go only as any record is: by its claim (a mint in its pool, a cancel, the person's word).
  await journal.release(owner, claim);
  assert.equal(journal.parked(owner, poolA), null);
  assert.equal(f.store.values.size, 0, 'nothing left');
  // Only a record with a nonce and a pool, never a batch.
  const noPool = await journal.claim(owner, 7n, { ...evidence, pool: null });
  assert.equal(await journal.park(owner, noPool), false);
  await journal.release(owner, noPool);
  const noNonce = await journal.claim(owner);
  assert.equal(await journal.park(owner, noNonce), false);
  await journal.recordBatch(owner, noNonce, hash);
  assert.equal(await journal.park(owner, noNonce), false);
  await journal.release(owner, noNonce);
  // A hashless record with its nonce is moved aside as it is.
  const unanswered = await journal.claim(owner, 8n, evidence);
  assert.equal(await journal.park(owner, unanswered), true);
  assert.deepEqual(journal.parked(owner, poolA), { claim: unanswered, hash: null, batchOperation: null, nonce: 8n, evidence });
  // Eight at most; past it, a record stays where it is.
  const many = fixture().make();
  for (let i = 0; i < 8; i++) {
    const c = await many.claim(owner, BigInt(i), { ...evidence, pool: `0x${(0x10 + i).toString(16).repeat(32)}` });
    assert.equal(await many.park(owner, c), true);
  }
  const ninth = await many.claim(owner, 9n, { ...evidence, pool: '0x' + 'ee'.repeat(32) });
  assert.equal(await many.park(owner, ninth), false);
  assert.equal(many.read(owner).claim, ninth);
  // Broken: refused, as a broken record is.
  f.store.values.set(parkedKey, 'corrupt');
  assert.throws(() => journal.parked(owner, poolA), /route_coordination_unavailable/);
});
// Fix round 3.2, the recheck's findings: "I rejected it in my wallet" let a swap whose hash never came back go while the
// wallet could still show it; approved later, an ETH input swapped twice. A new Uniswap route now waits for its deadline.
test('fix round 3.2: a hold keeps a new Uniswap route waiting until the rejected swap’s deadline; a later one stays, and it is let go only as read', async () => {
  const f = fixture(), journal = f.make();
  assert.equal(journal.heldUntil(owner), null);
  await journal.hold(owner, 1_800_000_000n);
  assert.equal(f.make().heldUntil(owner), 1_800_000_000n);
  await journal.hold(owner, 1_700_000_000n);
  assert.equal(journal.heldUntil(owner), 1_800_000_000n, 'an earlier time never shortens it');
  await journal.hold(owner, 1_900_000_000n);
  assert.equal(journal.heldUntil(owner), 1_900_000_000n);
  await journal.releaseHold(owner, 1_800_000_000n);
  assert.equal(journal.heldUntil(owner), 1_900_000_000n, 'only the time read is let go');
  await journal.releaseHold(owner, 1_900_000_000n);
  assert.equal(journal.heldUntil(owner), null);
  assert.equal(f.store.values.size, 0);
  await journal.hold(owner, 5n);
  const holdKey = [...f.store.values.keys()].find(key => key.startsWith('domino.routed-hold.v1.'));
  assert.ok([...f.store.values.keys(), ...f.store.values.values()].every(v => !v.includes(owner.slice(2))), 'no address');
  f.store.values.set(holdKey, '05');
  assert.throws(() => journal.heldUntil(owner), /route_coordination_unavailable/);
});
// Fix round 3.2, the recheck's finding: in a second tab the person's word let go of the first tab's claim while its wallet
// showed the swap; approved there, its hash lived only in that tab's memory. A hash that comes back is written back.
test('fix round 3.2: a hash that comes back after its claim was let go (another tab took the person’s word) is written back, with its nonce and evidence', async () => {
  const f = fixture(), first = f.make(), second = f.make();
  const evidence = { sentAfter: 90n, swap: '0x' + '5a'.repeat(32), permit: null, spent: null, pool: '0x' + '8d'.repeat(32), deadline: 1_800_000_000n };
  const claim = await first.claim(owner, 4n, evidence);
  await second.release(owner, claim);
  assert.equal(first.read(owner), null);
  await first.record(owner, claim, hash, 4n, evidence);
  assert.deepEqual(f.make().read(owner), { claim, hash, batchOperation: null, nonce: 4n, evidence });
  // Another claim in the slot meanwhile: refused, as before.
  await second.release(owner, claim);
  const other = await second.claim(owner, 5n, evidence);
  await assert.rejects(first.record(owner, claim, hash, 4n, evidence), /route_coordination_unavailable/);
  assert.equal(first.read(owner).claim, other);
  await second.release(owner, other);
  // Moved aside meanwhile: back in the slot, with its hash, and no longer aside.
  const third = await first.claim(owner, 6n, evidence);
  assert.equal(await first.park(owner, third), true);
  await first.record(owner, third, hash);
  assert.deepEqual(first.read(owner), { claim: third, hash, batchOperation: null, nonce: 6n, evidence });
  assert.equal(first.parked(owner, evidence.pool), null);
});
// Fix round 3.2: the router call's deadline, kept from the calldata itself; the chain's clock read through the wallet,
// or this device's clock less five minutes where the wallet answers no reads (never a read of the site's, which serves none).
test('fix round 3.2: the router call’s deadline is kept from its calldata, and told past on the chain’s clock through the wallet, or this device’s clock less five minutes', async () => {
  const data = encodeFunctionData({ abi: parseAbi(['function execute(bytes,bytes[],uint256) payable']), functionName: 'execute', args: ['0x10', ['0x'], 1_800_000_000n] });
  assert.equal(routeDeadline(data), 1_800_000_000n);
  assert.equal(routeDeadline('0x3593564c'), null);
  assert.equal(routeDeadline(DATA), null);
  assert.equal((await routeEvidence(null, owner, TOKEN, 5n, data, KEY)).deadline, 1_800_000_000n, 'no read needed: kept for a WalletConnect wallet too');
  const asked = [];
  const at = time => async (method, params) => { asked.push([method, params]); return { number: '0x10', timestamp: hexOf(time) }; };
  assert.equal(await deadlinePassed(at(1_800_000_001), 1_800_000_000n), true);
  assert.equal(await deadlinePassed(at(1_800_000_000), 1_800_000_000n), false, 'at its deadline the call can still run');
  assert.deepEqual(asked, [['eth_getBlockByNumber', ['latest', false]], ['eth_getBlockByNumber', ['latest', false]]]);
  assert.equal(await deadlinePassed(at(1_900_000_000), null), false, 'no deadline: never past');
  assert.equal(await deadlinePassed(null, 1_800_000_000n, 1_800_000_301), true);
  assert.equal(await deadlinePassed(null, 1_800_000_000n, 1_800_000_300), false, 'this device may be five minutes ahead');
  assert.equal(await deadlinePassed(async () => { throw new Error('unreachable'); }, 1_800_000_000n, 1_800_000_100), false);
  // Every clock the page reads to tell a deadline past goes through the wallet's own reads.
  const page = readFileSync(new URL('../src/components/create/CreatePosition.tsx', import.meta.url), 'utf8');
  const calls = page.match(/deadlinePassed\([^,]+/g) ?? [];
  assert.ok(calls.length >= 4);
  for (const call of calls) assert.equal(call, 'deadlinePassed(walletOwnReads(rpc)');
});
// Fix round 3.2, the recheck's finding (case B): right after the permit was mined, a node one block behind answered the
// allowance from before it, and the journal kept that: a later cancel read `changed`, and a swap that went through matched
// neither digest. The swap is offered only once the allowance is exactly its input, so any other reading is read again.
test('fix round 3.2: the allowance kept at the send is the one the swap was offered against: a node behind the permit is read again, and its stale answer never kept', async () => {
  const data = '0x3593564c' + 'ab'.repeat(36);
  const lagging = answers => {
    const asked = [];
    const request = async (method, params) => {
      if (method === 'eth_blockNumber') return hexOf(1000);
      asked.push(params[1]);
      const state = answers[Math.min(asked.length - 1, answers.length - 1)];
      return encodeFunctionResult({ abi: permitAbi, functionName: 'allowance', result: [state.amount, Number(state.expiration), Number(state.nonce)] });
    };
    return { request, asked };
  };
  const before = { amount: 0n, expiration: 0n, nonce: 0n };
  const behind = lagging([before, SET]);
  const evidence = await routeEvidence(behind.request, owner, TOKEN, SET.amount, data, KEY);
  assert.equal(evidence.permit, permitDigest(owner, TOKEN, SET), 'the allowance the permit set, read again');
  assert.equal(evidence.spent, permitDigest(owner, TOKEN, { ...SET, amount: 0n }));
  assert.equal(behind.asked.length, 2);
  const stuck = lagging([before]);
  const none = await routeEvidence(stuck.request, owner, TOKEN, SET.amount, data, KEY);
  assert.deepEqual([none.permit, none.spent], [null, null], 'never the stale one');
  assert.equal(stuck.asked.length, 3, 'three reads at most');
  assert.equal(none.sentAfter, 992n, 'the rest is kept');
});
