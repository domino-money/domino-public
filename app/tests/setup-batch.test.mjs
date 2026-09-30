/**
 * Create position's batch (EIP-5792) in the setup client (src/finance/setup.ts): what the wallet can do, what a batch
 * holds and how it is simulated, how it is offered once, and how its outcome is read from the operation it opens.
 * docs/plans/2026-09-25-eip5792-batches-design.md is the design these pin.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { atomicStatus, createSetupClient, setupAbi, tokenAbi, STEP_DEADLINE_S, BATCH_LATCH_EXPIRY_S } = require('../.test-build/app/src/finance/setup.js');
const { createNonceJournal } = require('../.test-build/app/src/finance/nonce.js');
const { atomicStatusOf } = require('../.test-build/app/src/finance/batch.js');
const { decodeFunctionData, encodeFunctionResult, keccak256, numberToHex } = require('viem');

const address = n => '0x' + n.toString(16).padStart(40, '0');
const owner = address(1), setup = address(2), token = address(9);
const ID = '0x' + 'ab'.repeat(32), OTHER_ID = '0x' + 'cd'.repeat(32);
const gas = { maxGas: 8_000_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, reserveWei: 0n };
const key = { currency0: address(0), currency1: token, fee: 3000, tickSpacing: 60, hooks: address(0) };
const mint = { tickLower: -60, tickUpper: 60, liquidity: 1000n, maxAmount0: 500n, maxAmount1: 500n, minSqrtPriceX96: 1n, maxSqrtPriceX96: 2n ** 100n, initialSqrtPriceX96: 0n };
const both = { key, amount0: 1000n, amount1: 2000n, swap: null, mint };
const oneToken = { key, amount0: 1000n, amount1: 0n, swap: { zeroForOne: true, gross: 400n, minOutput: 300n, sqrtLimit: 5n }, mint: { ...mint, maxAmount0: 600n, maxAmount1: 300n } };
const NONE = { owner: address(0), key: { currency0: address(0), currency1: address(0), fee: 0, tickSpacing: 0, hooks: address(0) }, balance0: 0n, balance1: 0n, swapped: false, closed: false, tokenId: 0n };
const opened = (fields = {}) => ({ ...NONE, owner, key, ...fields });
const rpcError = (code, message = 'wallet error') => Object.assign(new Error(message), { code });

function storage() { const map = new Map(); return { get length() { return map.size }, key: i => [...map.keys()][i] ?? null, getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) }; }
function locks() { const queues = new Map(); return { request(k, fn) { const prior = queues.get(k) ?? Promise.resolve(); const value = prior.catch(() => {}).then(fn); queues.set(k, value); return value; } }; }

/**
 * A wallet on a chain with Domino's setup contract: each answer can be changed through `state`, and every request is
 * logged. The batch latch is the real journal over memory.
 */
function fixture(options = {}) {
  const code = '0x6000', hash = keccak256(code);
  const deployment = { setup, poolManager: address(3), positionManager: address(4), stateView: address(5), feeRecipient: address(6),
    setupCodeHash: hash, poolManagerCodeHash: hash, positionManagerCodeHash: hash, stateViewCodeHash: hash, feeBps: 65, tariffVersion: '1', expiresAt: 10000 };
  const state = { ownerCode: '0x', receive: 'accept', allowance: 0n, pending: 0, balance: 10n ** 20n, nextId: ID, operation: NONE, confirmed: true,
    simulate: 'ok', capabilities: undefined, sendError: null, sendReply: { id: '0xba7c4' }, status: 200, statusError: null,
    live: true, now: 100, onClaim: null, ...options };
  const calls = [], journal = createNonceJournal(storage(), locks(), () => crypto.randomUUID());
  const views = () => ({ manager: deployment.poolManager, positions: deployment.positionManager, stateView: deployment.stateView, feeRecipient: deployment.feeRecipient,
    assistedFeeBps: 65, tariffVersion: 1n, nextOperationId: state.nextId, operation: state.operation });
  const wallet = { owner, current: () => state.live, nonceOffered: () => false, claimNonce: async () => 'claim', releaseRejectedNonce: async () => {},
    delegateConfirmed: () => state.confirmed,
    batchOffered: id => journal.batchOffered(owner, id),
    // `state.onClaim` runs once the latch is claimed, before anything more: the moment another wallet or the clock can intervene.
    claimBatch: async id => { const claim = await journal.claimBatch(owner, id, state.now); state.onClaim?.(state); return claim; },
    recordBatch: (id, claim, batch) => journal.recordBatch(owner, id, claim, batch), releaseBatch: (id, claim) => journal.releaseBatch(owner, id, claim),
    expireBatch: (id, now, maxAge) => journal.expireBatch(owner, id, now, maxAge),
    request: async (method, params) => {
      calls.push({ method, params });
      switch (method) {
        case 'eth_accounts': return [owner];
        case 'eth_chainId': return '0x1237';
        case 'eth_getCode': return params[0] === owner ? state.ownerCode : code;
        case 'eth_getTransactionCount': return params[1] === 'pending' ? numberToHex(state.pending) : '0x0';
        case 'eth_getBalance': return numberToHex(state.balance);
        case 'eth_call': {
          // The one-wei payment probe to an account with code: accepted, or refused by that code as a node says it.
          if (params[0].to === owner) {
            if (state.receive === 'revert') throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x' });
            return '0x';
          }
          // Any token's allowance to the setup contract: the one `state.allowance` says.
          if (params[0].to !== setup) return encodeFunctionResult({ abi: tokenAbi, functionName: 'allowance', result: state.allowance });
          const call = decodeFunctionData({ abi: setupAbi, data: params[0].data });
          return encodeFunctionResult({ abi: setupAbi, functionName: call.functionName, result: views()[call.functionName] });
        }
        case 'eth_simulateV1': {
          if (state.simulate === 'unsupported') throw rpcError(-32601, 'the method eth_simulateV1 does not exist/is not available');
          if (typeof state.simulate === 'object') throw state.simulate;
          if (state.simulate === 'garbled') return [{ calls: [] }];
          const count = params[0].blockStateCalls[0].calls.length;
          return [{ calls: Array.from({ length: count }, (_, i) => ({ status: state.simulate === i ? '0x0' : '0x1', gasUsed: '0x10000' })) }];
        }
        case 'wallet_getCapabilities': if (state.capabilities instanceof Error) throw state.capabilities; return state.capabilities;
        case 'wallet_sendCalls': if (state.sendError) throw state.sendError; return state.sendReply;
        case 'wallet_getCallsStatus': if (state.statusError) throw state.statusError; return { version: '2.0.0', id: params[0], chainId: '0x1237', status: state.status, atomic: true, receipts: [] };
      }
      throw new Error('unexpected fixture request: ' + method);
    } };
  const client = createSetupClient(wallet, deployment, () => state.now, async () => deployment, options.fallback ? { simulate: options.fallback } : {});
  return { client, calls, state, journal, wallet, asked: method => calls.filter(c => c.method === method) };
}
const decoded = call => decodeFunctionData({ abi: call.to === setup ? setupAbi : tokenAbi, data: call.data });

test('the wallet’s atomic batches are read for chain 4663 only: supported, ready, or anything else is unsupported', async () => {
  for (const [capabilities, expected] of [
    [{ '0x1237': { atomic: { status: 'supported' } } }, 'supported'],
    [{ '0x1237': { atomic: { status: 'ready' } } }, 'ready'],
    [{ '0x1237': { atomic: { status: 'unsupported' } } }, 'unsupported'],
    // Version 1's shape, another chain's entry, or no answer at all: never offered.
    [{ '0x1237': { atomicBatch: { supported: true } } }, 'unsupported'],
    [{ '0x1': { atomic: { status: 'supported' } } }, 'unsupported'],
    [{}, 'unsupported'], [null, 'unsupported'], [rpcError(4200), 'unsupported'],
  ]) {
    const f = fixture({ capabilities });
    assert.equal(await atomicStatus(f.wallet), expected, JSON.stringify(capabilities));
    assert.deepEqual(f.asked('wallet_getCapabilities').map(c => c.params), [[owner, ['0x1237']]]);
  }
  // A wallet that never answers is unsupported once the wait ends.
  const silent = { owner, request: () => new Promise(() => {}) };
  assert.equal(await atomicStatus(silent, 20), 'unsupported');
});

// 2026-09-28 (the owner: the UI must work whenever a wallet can batch): wallets write the chain key in more than one way,
// and EIP-5792 keeps chain 0x0 for what a wallet supports on every chain.
test('the wallet’s answer is read under any key that names chain 4663, hex or decimal, and under chain 0x0 when 4663’s entry says nothing', async () => {
  for (const [capabilities, expected, why] of [
    [{ '4663': { atomic: { status: 'supported' } } }, 'supported', 'decimal, as viem reads it too'],
    [{ '0x01237': { atomic: { status: 'ready' } } }, 'ready', 'a leading zero'],
    [{ '0X1237': { atomic: { status: 'supported' } } }, 'supported', 'an upper-case prefix'],
    [{ '0x0': { atomic: { status: 'supported' } } }, 'supported', 'every chain'],
    [{ '0': { atomic: { status: 'ready' } } }, 'ready', 'every chain, in decimal'],
    [{ '0x0': { atomic: { status: 'supported' } }, '0x1237': { atomic: { status: 'unsupported' } } }, 'unsupported', '4663’s own entry wins over every chain’s'],
    [{ '0x0': { atomic: { status: 'supported' } }, '0x1237': { paymasterService: { supported: true } } }, 'supported', '4663’s entry says nothing of atomic'],
    [{ '0x1237': { atomic: { status: 'supported' } }, '4663': { atomic: { status: 'ready' } } }, 'ready', 'two keys that disagree: the weakest'],
    [{ '0x1237': { atomic: { status: 'supported' } }, '4663': { atomic: { status: 'bogus' } } }, 'unsupported', 'an unknown status is none'],
    // Ambire's reply: every network it knows, version 1's atomicBatch beside version 2's atomic.
    [{ '0x1': { atomicBatch: { supported: true }, atomic: { status: 'supported' } }, '0x1237': { atomicBatch: { supported: true }, atomic: { status: 'supported' } } }, 'supported', 'both versions side by side'],
    [{ '0x12370': { atomic: { status: 'supported' } } }, 'unsupported', 'another chain'],
    [{ '46630': { atomic: { status: 'supported' } } }, 'unsupported', 'another chain, in decimal'],
    [{ '0x1237 ': { atomic: { status: 'supported' } } }, 'unsupported', 'not a chain key'],
    [{ '0x0': { atomicBatch: { supported: true } } }, 'unsupported', 'version 1 on every chain'],
    [[{ atomic: { status: 'supported' } }], 'unsupported', 'a list, not an object'],
  ]) {
    assert.equal(atomicStatusOf(capabilities), expected, why);
    assert.equal(await atomicStatus(fixture({ capabilities }).wallet), expected, why);
  }
});

test('a wallet that refuses the chain filter as an invalid parameter is asked once more without it; any other refusal is final', async () => {
  const answering = (first) => {
    const asked = [];
    const wallet = { owner, request: async (method, params) => {
      asked.push(params);
      if (params.length === 2) throw first;
      return { '0x1237': { atomic: { status: 'ready' } }, '0x1': { atomic: { status: 'supported' } } };
    } };
    return { asked, wallet };
  };
  const invalid = answering(rpcError(-32602, 'invalid params'));
  assert.equal(await atomicStatus(invalid.wallet), 'ready');
  assert.deepEqual(invalid.asked, [[owner, ['0x1237']], [owner]]);
  // Rabby answers -32601 (no such method, measured 25 Sep 2026): the steps, and the wallet is not asked again.
  for (const code of [-32601, 4200, 4100, 4001]) {
    const other = answering(rpcError(code));
    assert.equal(await atomicStatus(other.wallet), 'unsupported', String(code));
    assert.deepEqual(other.asked, [[owner, ['0x1237']]], String(code));
  }
  // The second question shares the first one's wait.
  let calls = 0;
  const slow = { owner, request: (_, params) => { calls++; return params.length === 2 ? Promise.reject(rpcError(-32602)) : new Promise(() => {}); } };
  assert.equal(await atomicStatus(slow, 20), 'unsupported');
  assert.equal(calls, 2);
});

test('a batch holds the exact approvals, the funding into the id the contract opens next, and the mint in that operation, simulated from the owner', async () => {
  const f = fixture();
  const prepared = await f.client.prepareBatch(both, gas);
  assert.equal(prepared.kind, 'batch');
  assert.equal(prepared.operationId, ID);
  assert.deepEqual(prepared.calls.map(call => [call.to, decoded(call).functionName, call.value]), [[token, 'approve', '0x0'], [setup, 'open', numberToHex(1000n)], [setup, 'mint', '0x0']]);
  assert.deepEqual(decoded(prepared.calls[0]).args, [setup, 2000n], 'the exact amount, to the setup contract, never unlimited');
  assert.deepEqual(decoded(prepared.calls[1]).args.slice(0, 1).concat(decoded(prepared.calls[1]).args.slice(2)), [ID, 1000n, 2000n]);
  const minted = decoded(prepared.calls[2]).args[0];
  assert.deepEqual([minted.operationId, minted.liquidity, minted.deadline], [ID, 1000n, BigInt(100 + STEP_DEADLINE_S)]);
  // One block of calls, each from the owner as the account's own execution makes it, state carried between them.
  const [simulation] = f.asked('eth_simulateV1');
  assert.deepEqual(simulation.params, [{ blockStateCalls: [{ calls: prepared.calls.map(call => ({ from: owner, to: call.to, data: call.data, value: call.value })) }], validation: false }, 'latest']);
  assert.equal(prepared.gasUsed, 3n * 0x10000n);
  assert.equal(prepared.gasLimit, ((3n * 0x10000n + 150_000n) * 120n + 99n) / 100n, 'a fifth of room over the calls and the batch’s own frame');
  assert.ok(prepared.summary.some(line => line.includes('execute together or not at all')));
  assert.ok(Object.isFrozen(prepared) && Object.isFrozen(prepared.calls) && prepared.calls.every(Object.isFrozen));
  assert.equal(f.asked('wallet_sendCalls').length, 0, 'preparing asks the wallet to sign nothing');
  // A short allowance is reset to zero first; one that covers the amount needs no approval at all.
  const short = await fixture({ allowance: 5n }).client.prepareBatch(both, gas);
  assert.deepEqual(short.calls.slice(0, 2).map(call => decoded(call).args[1]), [0n, 2000n]);
  const covered = await fixture({ allowance: 2000n }).client.prepareBatch(both, gas);
  assert.deepEqual(covered.calls.map(call => decoded(call).functionName), ['open', 'mint']);
});

test('a one-token batch swaps the planned gross for at least its minimum, and its mint may count only on that minimum', async () => {
  const prepared = await fixture().client.prepareBatch(oneToken, gas);
  assert.deepEqual(prepared.calls.map(call => decoded(call).functionName), ['open', 'swap', 'mint'], 'ETH needs no approval');
  const swap = decoded(prepared.calls[1]).args[0];
  assert.deepEqual([swap.operationId, swap.zeroForOne, swap.grossInput, swap.minOutput, swap.sqrtPriceLimitX96, swap.deadline], [ID, true, 400n, 300n, 5n, BigInt(100 + STEP_DEADLINE_S)]);
  // After the swap the operation holds 600 of token 0 and at least 300 of token 1: a cap above either is refused.
  for (const cap of [{ maxAmount0: 601n }, { maxAmount1: 301n }]) {
    await assert.rejects(fixture().client.prepareBatch({ ...oneToken, mint: { ...oneToken.mint, ...cap } }, gas), /invalid_mint_limits/, JSON.stringify(cap, (_, v) => String(v)));
  }
  for (const swap of [{ gross: 1001n }, { gross: 0n }, { minOutput: 0n }, { sqrtLimit: 0n }]) {
    await assert.rejects(fixture().client.prepareBatch({ ...oneToken, swap: { ...oneToken.swap, ...swap } }, gas), /invalid_swap_budget/);
  }
});

test('a batch waits for what funding waits for: the delegate’s confirmation, ETH the account can take back, no pending transaction, no batch already offered', async () => {
  const delegated = fixture({ ownerCode: '0xef0100' + 'de'.repeat(20), confirmed: false });
  await assert.rejects(delegated.client.prepareBatch(both, gas), /delegate_unrecognized/);
  assert.equal(delegated.asked('eth_simulateV1').length, 0);
  assert.equal((await fixture({ ownerCode: '0xef0100' + 'de'.repeat(20) }).client.prepareBatch(both, gas)).kind, 'batch', 'confirmed: prepared');
  await assert.rejects(fixture({ pending: 1 }).client.prepareBatch(both, gas), /pending_wallet_transaction/);
  // ETH goes in and comes back with the mint: an account whose code refuses ETH gets no batch, and a token pool never asks.
  const refusing = fixture({ ownerCode: '0xef0100' + 'de'.repeat(20), receive: 'revert' });
  await assert.rejects(refusing.client.prepareBatch(both, gas), /native_eth_refused/);
  assert.equal(refusing.asked('eth_simulateV1').length, 0);
  const tokens = { ...both, key: { ...key, currency0: address(8) }, amount0: 1000n };
  assert.equal((await fixture({ ownerCode: '0xef0100' + 'de'.repeat(20), receive: 'revert' }).client.prepareBatch(tokens, gas)).kind, 'batch');
  const latched = fixture();
  await latched.journal.claimBatch(owner, ID);
  await assert.rejects(latched.client.prepareBatch(both, gas), /batch_already_offered/);
  assert.deepEqual(await latched.client.offeredBatch(), { operationId: ID, id: '' });
  assert.equal(await fixture().client.offeredBatch(), null);
});

test('the simulation decides: a failing call, a garbled reply or no simulation at all prepares nothing; a wallet without the method is simulated elsewhere', async () => {
  await assert.rejects(fixture({ simulate: 1 }).client.prepareBatch(both, gas), /batch_simulation_reverted/);
  await assert.rejects(fixture({ simulate: 'garbled' }).client.prepareBatch(both, gas), /invalid_simulation_reply/);
  await assert.rejects(fixture({ simulate: 'unsupported' }).client.prepareBatch(both, gas), /batch_simulation_unavailable/);
  const asked = [];
  const fallback = async params => { asked.push(params); return [{ calls: params[0].blockStateCalls[0].calls.map(() => ({ status: '0x1', gasUsed: '0x5208' })) }]; };
  const elsewhere = await fixture({ simulate: 'unsupported', fallback }).client.prepareBatch(both, gas);
  assert.equal(elsewhere.gasUsed, 3n * 0x5208n);
  assert.deepEqual(asked[0][0].blockStateCalls[0].calls.map(call => call.from), [owner, owner, owner]);
  // A wallet that says it lacks the method by its code alone, whatever its words; any other error of its simulation is its answer.
  for (const code of [4200, -32601, -32004]) assert.equal((await fixture({ simulate: rpcError(code, 'nope'), fallback }).client.prepareBatch(both, gas)).gasUsed, 3n * 0x5208n, `${code}`);
  await assert.rejects(fixture({ simulate: rpcError(-32000, 'nope'), fallback }).client.prepareBatch(both, gas), /nope/);
  await assert.rejects(fixture({ simulate: 'unsupported', fallback: async () => { throw new Error('429'); } }).client.prepareBatch(both, gas), /batch_simulation_unavailable/);
  await assert.rejects(fixture({ simulate: 'unsupported', fallback: async () => [{ calls: [{ status: '0x0', gasUsed: '0x1' }, { status: '0x1', gasUsed: '0x1' }, { status: '0x1', gasUsed: '0x1' }] }] }).client.prepareBatch(both, gas), /batch_simulation_reverted/);
  // The ETH the batch spends: its value, its gas at the ceiling and the reserve.
  await assert.rejects(fixture({ balance: 1000n }).client.prepareBatch(both, gas), /native_gas_reserve_insufficient/);
  await assert.rejects(fixture().client.prepareBatch(both, { ...gas, maxGas: 100_000n }), /gas_budget_exceeded/);
});

test('a batch is offered once, as version 2.0.0 on chain 4663 with atomic execution required, and its latch keeps the wallet’s id', async () => {
  const f = fixture();
  const prepared = await f.client.prepareBatch(both, gas);
  await assert.rejects(f.client.sendBatch(prepared, false), /wallet_review_required/);
  assert.equal(await f.client.sendBatch(prepared, true), '0xba7c4');
  assert.deepEqual(f.asked('wallet_sendCalls').map(c => c.params), [[{ version: '2.0.0', chainId: '0x1237', from: owner, atomicRequired: true, calls: prepared.calls }]]);
  assert.equal(f.journal.batchOffered(owner, ID), '0xba7c4');
  await assert.rejects(f.client.sendBatch(prepared, true), /wallet_review_required/, 'the same review is never offered twice');
  // A wallet that answers with the id alone, as some still do.
  const plain = fixture({ sendReply: '0xba7c5' });
  assert.equal(await plain.client.sendBatch(await plain.client.prepareBatch(both, gas), true), '0xba7c5');
  // Another deposit opened since the review: nothing offered.
  const moved = fixture();
  const stale = await moved.client.prepareBatch(both, gas);
  moved.state.nextId = OTHER_ID;
  await assert.rejects(moved.client.sendBatch(stale, true), /batch_state_changed/);
  assert.equal(moved.asked('wallet_sendCalls').length, 0);
});

test('another wallet, or the review’s end, while the latch is being claimed: the latch is freed and the wallet asked nothing', async () => {
  for (const [label, change] of [['another wallet', state => { state.live = false; }], ['expired', state => { state.now = 10_000; }]]) {
    const f = fixture();
    const prepared = await f.client.prepareBatch(both, gas);
    f.state.onClaim = change;
    await assert.rejects(f.client.sendBatch(prepared, true), /wallet_review_expired/, label);
    assert.deepEqual([f.asked('wallet_sendCalls').length, f.journal.batchOffered(owner, ID)], [0, null], label);
  }
});

test('a refusal frees the latch and says why; an answer that never came keeps it', async () => {
  for (const [error, pattern] of [[rpcError(4001, 'User rejected the request.'), /User rejected/], [rpcError(5750), /batch_upgrade_declined/],
    [rpcError(5760), /batch_unsupported/], [rpcError(5700), /batch_unsupported/], [rpcError(4200), /batch_unsupported/], [rpcError(-32601), /batch_unsupported/]]) {
    const f = fixture({ sendError: error });
    await assert.rejects(f.client.sendBatch(await f.client.prepareBatch(both, gas), true), pattern);
    assert.equal(f.journal.batchOffered(owner, ID), null, `freed after ${error.code}`);
  }
  const lost = fixture({ sendError: rpcError(-32603, 'Internal JSON-RPC error.') });
  await assert.rejects(lost.client.sendBatch(await lost.client.prepareBatch(both, gas), true), /Internal JSON-RPC error/);
  assert.equal(lost.journal.batchOffered(owner, ID), '', 'the outcome is unknown: latched, with no id');
  const garbled = fixture({ sendReply: { id: 42 } });
  await assert.rejects(garbled.client.sendBatch(await garbled.client.prepareBatch(both, gas), true), /wallet_result_unknown/);
  assert.equal(garbled.journal.batchOffered(owner, ID), '');
  const unfit = fixture({ sendReply: { id: 'a|b' } });
  await assert.rejects(unfit.client.sendBatch(await unfit.client.prepareBatch(both, gas), true), /invalid_wallet_batch/);
  assert.equal(unfit.journal.batchOffered(owner, ID), '');
});

// 2026-09-28 (audit): a latch whose wallet never answered, or answered with an error other than a refusal, held every
// later press of a wallet that batches, for good. Past the mint's latest deadline its batch can execute nothing.
test('a latch the wallet never settled holds the next operation only until its batch can no longer execute, then a new batch is prepared', async () => {
  assert.equal(BATCH_LATCH_EXPIRY_S, 1_500, 'the contract’s 1,200 s deadline ceiling and five minutes more');
  assert.ok(BATCH_LATCH_EXPIRY_S > STEP_DEADLINE_S);
  const lost = fixture({ sendError: rpcError(-32603, 'Internal JSON-RPC error.') });
  await assert.rejects(lost.client.sendBatch(await lost.client.prepareBatch(both, gas), true), /Internal JSON-RPC error/);
  assert.deepEqual(await lost.client.offeredBatch(), { operationId: ID, id: '' }, 'at first, watched and never offered twice');
  await assert.rejects(lost.client.prepareBatch(both, gas), /batch_already_offered/);
  lost.state.now = 100 + BATCH_LATCH_EXPIRY_S;
  assert.deepEqual(await lost.client.offeredBatch(), { operationId: ID, id: '' }, 'not a second before its time');
  lost.state.now = 101 + BATCH_LATCH_EXPIRY_S;
  assert.equal(await lost.client.offeredBatch(), null, 'past it, freed');
  assert.equal(lost.journal.batchOffered(owner, ID), null);
  lost.state.sendError = null;
  const again = await lost.client.prepareBatch(both, gas);
  assert.equal(await lost.client.sendBatch(again, true), '0xba7c4', 'a new batch for the same operation');
  // A batch the wallet took and still says is pending is freed the same way: it cannot execute past its deadline either.
  const held = fixture({ status: 100 });
  await held.client.sendBatch(await held.client.prepareBatch(both, gas), true);
  held.state.now = 101 + BATCH_LATCH_EXPIRY_S;
  assert.equal(await held.client.offeredBatch(), null);
  // A latch claimed with no time beside it (before 28 Sep) starts its clock when first found, and one from a clock set
  // back starts it again: either frees later, never sooner.
  const legacy = fixture();
  await legacy.journal.claimBatch(owner, ID);
  legacy.state.now = 5_000;
  assert.deepEqual(await legacy.client.offeredBatch(), { operationId: ID, id: '' });
  legacy.state.now = 5_000 + BATCH_LATCH_EXPIRY_S;
  assert.deepEqual(await legacy.client.offeredBatch(), { operationId: ID, id: '' });
  legacy.state.now = 5_001 + BATCH_LATCH_EXPIRY_S;
  assert.equal(await legacy.client.offeredBatch(), null);
  const future = fixture();
  await future.journal.claimBatch(owner, ID, 9_000);
  future.state.now = 8_000;
  assert.deepEqual(await future.client.offeredBatch(), { operationId: ID, id: '' });
  future.state.now = 8_000 + BATCH_LATCH_EXPIRY_S;
  assert.deepEqual(await future.client.offeredBatch(), { operationId: ID, id: '' }, 'restamped at 8,000, not freed from 9,000');
  future.state.now = 8_001 + BATCH_LATCH_EXPIRY_S;
  assert.equal(await future.client.offeredBatch(), null);
  // Another operation's latch is left alone.
  const other = fixture();
  await other.journal.claimBatch(owner, OTHER_ID, 1);
  other.state.now = 10 ** 6;
  assert.equal(await other.client.offeredBatch(), null);
  assert.equal(other.journal.batchOffered(owner, OTHER_ID), '');
});

test('a batch’s outcome is the operation it opens: created is read back closed with its NFT; not included or reverted frees the latch', async () => {
  const sent = async (state = {}) => {
    const f = fixture(state);
    await f.client.sendBatch(await f.client.prepareBatch(both, gas), true);
    return f;
  };
  let f = await sent({ status: 100 });
  assert.deepEqual(await f.client.batchStatus('0xba7c4', ID), { state: 'pending' });
  assert.equal(f.asked('eth_call').filter(c => c.params[0].to === setup && decodeFunctionData({ abi: setupAbi, data: c.params[0].data }).functionName === 'operation').length, 0, 'still with the wallet: the chain is not read');
  // Confirmed: the operation decides. Behind (zero owner), pending; closed with its NFT, created, and the latch is done.
  f = await sent();
  assert.deepEqual(await f.client.batchStatus('0xba7c4', ID), { state: 'pending' });
  assert.equal(f.journal.batchOffered(owner, ID), '0xba7c4');
  f.state.operation = opened({ closed: true, tokenId: 42n });
  assert.deepEqual(await f.client.batchStatus('0xba7c4', ID), { state: 'created', tokenId: 42n });
  assert.equal(f.journal.batchOffered(owner, ID), null);
  f = await sent({ operation: opened({ balance0: 1000n }) });
  assert.deepEqual(await f.client.batchStatus('0xba7c4', ID), { state: 'held' });
  f = await sent({ operation: { ...opened(), owner: address(7) } });
  await assert.rejects(f.client.batchStatus('0xba7c4', ID), /operation_not_owned/);
  for (const [status, said] of [[400, 'dropped'], [500, 'reverted']]) {
    f = await sent({ status });
    assert.deepEqual(await f.client.batchStatus('0xba7c4', ID), { state: said });
    assert.equal(f.journal.batchOffered(owner, ID), null, `${status} frees the latch`);
  }
  // A wallet that no longer knows the batch: the operation decides, and the latch is freed.
  f = await sent({ statusError: rpcError(5730) });
  assert.deepEqual(await f.client.batchStatus('0xba7c4', ID), { state: 'unknown' });
  assert.equal(f.journal.batchOffered(owner, ID), null);
  // Created all the same, even with the wallet's status lost.
  f = await sent({ statusError: rpcError(5730), operation: opened({ closed: true, tokenId: 7n }) });
  assert.deepEqual(await f.client.batchStatus('0xba7c4', ID), { state: 'created', tokenId: 7n });
  // An answer that never came: no id to ask about; the operation alone decides, and the latch stays.
  f = fixture({ sendError: rpcError(-32603) });
  await assert.rejects(f.client.sendBatch(await f.client.prepareBatch(both, gas), true));
  assert.deepEqual(await f.client.batchStatus('', ID), { state: 'unknown' });
  assert.equal(f.asked('wallet_getCallsStatus').length, 0);
  assert.equal(f.journal.batchOffered(owner, ID), '');
  f = await sent({ statusError: rpcError(-32603, 'Internal JSON-RPC error.') });
  await assert.rejects(f.client.batchStatus('0xba7c4', ID), /Internal JSON-RPC error/, 'any other failed read is read again later');
});
