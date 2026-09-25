// A sequence's creation as one batch (EIP-5792) against the actual official V4 contracts on local Anvil (prague). The owner
// is delegated to Simple7702Account's real code; this wallet executes a batch as that account does, one transaction from
// the owner to itself calling executeBatch. No real keys. Driven by backend/tests/test_sequence_batch_evm.py.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { decodeFunctionData, encodeFunctionData } from 'viem';
const f = JSON.parse(readFileSync(0, 'utf8'));
assert.match(f.url, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
const { createSequenceClient, sequenceDeploymentFrom, sequenceIdentity, sequenceAbi } = await import(pathToFileURL(process.env.DOMINO_SEQUENCE_SDK_MODULE).href);
let now = f.now, checks = 0;
const check = () => checks++;
async function rpc(method, params = []) {
  const response = await fetch(f.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
  const data = await response.json(); if (data.error) throw Object.assign(new Error(data.error.message), data.error); return data.result;
}
async function receiptOf(hash) {
  for (let tries = 0; tries < 200; tries++) {
    const receipt = await rpc('eth_getTransactionReceipt', [hash]);
    if (receipt) return receipt;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`no receipt for ${hash}`);
}
/** executeBatch(Call[]) of eth-infinitism's BaseAccount, which Simple7702Account runs for the account itself. */
const EXECUTE_BATCH = [{ name: 'executeBatch', type: 'function', stateMutability: 'nonpayable', outputs: [],
  inputs: [{ name: 'calls', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }] }];
const owner = f.owner.toLowerCase(), batches = new Map(), latches = new Map(), claims = new Map(), offered = [];
/** The next batch offered gets no answer: the wallet's reply is lost before anything is sent. */
let loseNext = false;
/** The next batch offered is taken and held unsent; `said` is the wallet's status for it (5730: an id it does not know, 'fails': no answer). */
let holdNext = false;
const said = new Map();
/** Whether this is still the wallet the page connected; and what happens while a batch's latch is being claimed. */
let live = true, onClaim = null;
/** Every simulation the wallet was asked for; the next one reports its calls failed when `failSimulation` is set. */
const simulations = [];
let failSimulation = false;
const wallet = { owner, current: () => live, nonceOffered: n => claims.has(String(n)), claimNonce: async n => { claims.set(String(n), String(n)); return String(n); }, releaseRejectedNonce: async n => { claims.delete(String(n)); },
  batchOffered: key => (latches.has(key) ? latches.get(key).id : null),
  claimBatch: async key => {
    if (latches.has(key)) throw new Error('wallet_batch_already_offered');
    latches.set(key, { claim: `claim-${key}`, id: '' });
    const change = onClaim; onClaim = null; change?.();
    return `claim-${key}`;
  },
  recordBatch: async (key, claim, id) => { if (latches.get(key)?.claim === claim) latches.set(key, { claim, id }); },
  releaseBatch: async (key, claim) => { const held = latches.get(key); if (held && claim && (held.claim === claim || held.id === claim)) latches.delete(key); },
  request: async (method, params) => {
    if (method === 'wallet_getCapabilities') return { '0x1237': { atomic: { status: 'supported' } } };
    if (method === 'eth_simulateV1') {
      simulations.push(params);
      if (failSimulation) { failSimulation = false; return [{ calls: params[0].blockStateCalls[0].calls.map(() => ({ status: '0x0', gasUsed: '0x0' })) }]; }
    }
    if (method === 'wallet_sendCalls') {
      offered.push(params[0]);
      if (loseNext) { loseNext = false; throw new Error('outcome_unknown'); }
      const [{ version, chainId, from, atomicRequired, calls }] = params;
      if (holdNext) { holdNext = false; const id = `0x${(0x401d + said.size).toString(16)}`; said.set(id, 100); return { id }; }
      assert.deepEqual([version, chainId, from.toLowerCase(), atomicRequired], ['2.0.0', '0x1237', owner, true]);
      // The account executes its own batch (EIP-7702): one transaction from the owner to itself.
      const data = encodeFunctionData({ abi: EXECUTE_BATCH, functionName: 'executeBatch', args: [calls.map(call => ({ target: call.to, value: BigInt(call.value), data: call.data }))] });
      const hash = await rpc('eth_sendTransaction', [{ from: owner, to: owner, data, gas: '0x1c9c380' }]);
      await receiptOf(hash);
      const id = `0x${(0x5eba70 + batches.size).toString(16)}`;
      batches.set(id, hash);
      return { id };
    }
    if (method === 'wallet_getCallsStatus') {
      if (said.has(params[0])) {
        const status = said.get(params[0]);
        if (status === 'fails') throw new Error('wallet_busy');
        if (status === 5730) throw Object.assign(new Error('Unknown bundle id'), { code: 5730 });
        return { version: '2.0.0', id: params[0], chainId: '0x1237', status, atomic: true, receipts: [] };
      }
      const receipt = await rpc('eth_getTransactionReceipt', [batches.get(params[0])]);
      return { version: '2.0.0', id: params[0], chainId: '0x1237', status: !receipt ? 100 : receipt.status === '0x1' ? 200 : 500, atomic: true, receipts: receipt ? [receipt] : [] };
    }
    return rpc(method, params);
  } };
const d = sequenceDeploymentFrom(f.release, now);
const client = createSequenceClient(wallet, d, () => now, async () => sequenceDeploymentFrom(f.release, now));
const options = { automationMode: 'domino', rootTokenId: BigInt(f.root), baseIsCurrency0: !f.native, consentToUncollectedFees: true, triggerDistanceBps: 1000, maxOverlapBps: 1000,
  minimumIntervalSeconds: 60, maxPositions: 4, upsideBps: 5000, maxSlippageBps: 100, maxPriceImpactBps: 100, maxGasCostWei: 10n ** 16n, maxObservationAgeSeconds: 120, forecastHorizonSeconds: 3600 };
const gas = { maxGas: 15_000_000n, maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, reserveWei: 10n ** 14n };

// The root NFT's approval and the paused creation, one batch: the approval names the vault the factory predicts at the owner's next nonce.
const predicted = sequenceIdentity(d, f.owner, 1n);
// An answer that never came keeps the sequence's latch: nothing more is prepared for it until the chain or the owner decides.
const lost = await client.prepareCreateBatch(options, gas);
loseNext = true;
await assert.rejects(client.sendCreateBatch(lost, true), /outcome_unknown/);
assert.equal(wallet.batchOffered(lost.sequenceId), '', 'latched with no id'); check();
await assert.rejects(client.prepareCreateBatch(options, gas), /batch_already_offered/); check();
assert.deepEqual(await client.createBatchStatus('', lost), { state: 'unknown' });
assert.equal(wallet.batchOffered(lost.sequenceId), '', 'nothing to ask about, and the chain has nothing: still latched'); check();
await wallet.releaseBatch(lost.sequenceId, `claim-${lost.sequenceId}`);
// A batch the wallet took and holds, left unread by the page that offered it: the next preparation asks the wallet. Still
// pending, confirmed on a node behind, or not answered, it waits; not included, reverted or unknown to the wallet, it is freed.
for (const [status, freed] of [[100, false], [200, false], ['fails', false], [400, true], [500, true], [5730, true]]) {
  const review = await client.prepareCreateBatch(options, gas);
  holdNext = true;
  const id = await client.sendCreateBatch(review, true);
  said.set(id, status);
  if (freed) {
    await client.prepareCreateBatch(options, gas);
    assert.equal(wallet.batchOffered(review.sequenceId), null, `${status} frees the batch`);
  } else {
    await assert.rejects(client.prepareCreateBatch(options, gas), /batch_already_offered/, `${status} waits`);
    assert.equal(wallet.batchOffered(review.sequenceId), id);
    await wallet.releaseBatch(review.sequenceId, id);
  }
  check();
}
// What the wallet says of a batch it holds, while the chain has nothing of it: pending, or confirmed on a node behind, waits;
// not included, reverted, or unknown to the wallet, it is said so and freed.
for (const [status, expected, freed] of [[100, 'pending', false], [200, 'pending', false], [400, 'dropped', true], [500, 'reverted', true], [5730, 'unknown', true]]) {
  const review = await client.prepareCreateBatch(options, gas);
  holdNext = true;
  const id = await client.sendCreateBatch(review, true);
  said.set(id, status);
  assert.deepEqual(await client.createBatchStatus(id, review), { state: expected }, `${status}`);
  assert.equal(wallet.batchOffered(review.sequenceId) === null, freed, `${status} frees it: ${freed}`); check();
  if (!freed) await wallet.releaseBatch(review.sequenceId, id);
}
assert.equal(await rpc('eth_getCode', [predicted.vault, 'latest']), '0x', 'no batch held executed'); check();
// The preparation's own limits, each refused before the wallet is asked.
await assert.rejects(client.prepareCreateBatch(options, { ...gas, maxGas: 20_000n }), /invalid_gas_budget/); check();
await assert.rejects(client.prepareCreateBatch(options, { ...gas, maxGas: 100_000n }), /gas_budget_exceeded/, 'less than the batch uses'); check();
await assert.rejects(client.prepareCreateBatch(options, { ...gas, reserveWei: 10n ** 30n }), /native_gas_reserve_insufficient/); check();
failSimulation = true;
await assert.rejects(client.prepareCreateBatch(options, gas), /batch_simulation_reverted/, 'a call the simulation says fails'); check();
const pendingNonce = String(BigInt(await rpc('eth_getTransactionCount', [owner, 'pending'])));
claims.set(pendingNonce, pendingNonce);
await assert.rejects(client.prepareCreateBatch(options, gas), /pending_wallet_transaction/, 'a transaction already offered at the next nonce'); check();
claims.delete(pendingNonce);
// A review is sent only acknowledged, in time, and with no transaction offered since.
const unsent = await client.prepareCreateBatch(options, gas);
await assert.rejects(client.sendCreateBatch(unsent, false), /review_required/, 'not acknowledged'); check();
now = unsent.expiresAt;
await assert.rejects(client.sendCreateBatch(unsent, true), /review_required/, 'expired'); check();
now = f.now;
claims.set(pendingNonce, pendingNonce);
await assert.rejects(client.sendCreateBatch(unsent, true), /pending_wallet_transaction/, 'a transaction offered since the review'); check();
claims.delete(pendingNonce);
assert.equal(wallet.batchOffered(unsent.sequenceId), null, 'refused before any latch'); check();
// Another wallet, or the review's end, while the latch was being claimed: it is freed, and the wallet is asked nothing.
for (const [change, label] of [[() => { live = false; }, 'another wallet'], [() => { now = unsent.expiresAt; }, 'expired']]) {
  const review = await client.prepareCreateBatch(options, gas);
  const before = offered.length;
  onClaim = change;
  await assert.rejects(client.sendCreateBatch(review, true), /wallet_review_expired/, label);
  assert.deepEqual([offered.length, wallet.batchOffered(review.sequenceId)], [before, null], label); check();
  live = true; now = f.now;
}
// A status is asked only for an address and a sequence id.
await assert.rejects(client.createBatchStatus('0x1', { vault: '0x1234', sequenceId: predicted.id }), /invalid_address/); check();
await assert.rejects(client.createBatchStatus('0x1', { vault: predicted.vault, sequenceId: '0x12' }), /unqualified_sequence/); check();
// Two reviews of the same creation: the second is sent, and the first, whose sequence then exists, is refused before the wallet.
const stale = await client.prepareCreateBatch(options, gas);
const prepared = await client.prepareCreateBatch(options, gas);
assert.deepEqual([prepared.kind, prepared.vault, prepared.sequenceId], ['create-batch', predicted.vault, predicted.id]); check();
const decoded = prepared.calls.map(call => decodeFunctionData({ abi: sequenceAbi, data: call.data }));
assert.deepEqual(decoded.map(call => call.functionName), ['approve', 'createVault']); check();
assert.deepEqual([decoded[0].args[0].toLowerCase(), decoded[0].args[1]], [predicted.vault, BigInt(f.root)], 'only the root, to the predicted sequence'); check();
assert.deepEqual([decoded[1].args[0].policy.paused, decoded[1].args[0].policy.serviceFeeBps, decoded[1].args[1]], [true, 400, 1n], 'paused, Domino-compound, at the next nonce'); check();
assert.ok(prepared.gasUsed > 0n && prepared.summary.some(line => line.includes('execute together or not at all'))); check();
const [simulated] = simulations.at(-1);
assert.deepEqual([simulated.validation, simulated.blockStateCalls[0].calls], [false, prepared.calls.map(call => ({ from: owner, to: call.to, data: call.data, value: call.value }))], 'simulated whole, each call from the owner'); check();
assert.equal(prepared.gasLimit, ((prepared.gasUsed + 150_000n) * 120n + 99n) / 100n, 'room for the wallet’s own frame'); check();
const id = await client.sendCreateBatch(prepared, true);
const receipt = await receiptOf(batches.get(id));
assert.deepEqual([receipt.status, receipt.from.toLowerCase(), receipt.to.toLowerCase()], ['0x1', owner, owner], 'one transaction, the account to itself'); check();
await assert.rejects(client.sendCreateBatch(prepared, true), /review_required/, 'a review is offered once'); check();
const asked = offered.length;
await assert.rejects(client.sendCreateBatch(stale, true), /sequence_preparation_changed|position_subscribed/, 'the chain moved under the first review');
assert.equal(offered.length, asked, 'and the wallet was asked nothing for it'); check();
let state;
for (let beat = 0; beat < 20; beat++) {
  state = await client.createBatchStatus(id, prepared);
  if (state.state === 'created') break;
  assert.equal(state.state, 'pending');
  await rpc('anvil_mine', ['0x1']);
}
assert.deepEqual(state, { state: 'created', vault: predicted.vault }); check();
assert.equal(wallet.batchOffered(prepared.sequenceId), null, 'created: the latch is done'); check();
await assert.rejects(client.createBatchStatus(id, { vault: predicted.vault, sequenceId: sequenceIdentity(d, f.owner, 2n).id }), /unqualified_sequence/, 'the vault there is another sequence'); check();
const created = await client.inspect(predicted.vault);
assert.deepEqual([created.paused, created.rootPermissionValid, created.rootTokenId, created.serviceFeeBps], [true, true, BigInt(f.root), 400], 'paused, holding its root’s approval'); check();
// The same batch again: the factory no longer creates at that nonce, and the whole batch reverts, its approval with it.
const nonceBefore = BigInt(await rpc('eth_getTransactionCount', [owner, 'latest']));
const { id: again } = await wallet.request('wallet_sendCalls', [{ version: '2.0.0', chainId: '0x1237', from: owner, atomicRequired: true, calls: prepared.calls }]);
assert.equal((await receiptOf(batches.get(again))).status, '0x0', 'executed whole or not at all'); check();
assert.equal(BigInt(await rpc('eth_getTransactionCount', [owner, 'latest'])), nonceBefore + 1n); check();
assert.deepEqual(await client.createBatchStatus(again, { vault: sequenceIdentity(d, f.owner, 2n).vault, sequenceId: sequenceIdentity(d, f.owner, 2n).id }), { state: 'reverted' }, 'no vault at the next address'); check();
console.log(JSON.stringify({ passed: true, checks, vault: predicted.vault, batches: batches.size }));
