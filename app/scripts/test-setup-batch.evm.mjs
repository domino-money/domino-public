// Create position's batch (EIP-5792) against a fresh local Anvil (prague). The owner is delegated to Simple7702Account's
// real code; this wallet executes a batch as that account does, one transaction from the owner to itself calling
// executeBatch. No real keys. Driven by backend/tests/test_setup_batch_evm.py.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { decodeFunctionData, encodeFunctionData, zeroAddress } from 'viem';
const fixture = JSON.parse(readFileSync(0, 'utf8'));
const { atomicStatus, createSetupClient, deploymentFrom, setupAbi, tokenAbi } = await import(pathToFileURL(process.env.DOMINO_SETUP_SDK_MODULE).href);
const now = fixture.now;
const rpc = async (method, params = []) => {
  const response = await fetch(fixture.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const data = await response.json(); if (data.error) throw Object.assign(new Error(data.error.message), data.error); return data.result;
};
/** executeBatch(Call[]) of eth-infinitism's BaseAccount, which Simple7702Account runs for the account itself. */
const EXECUTE_BATCH = [{ name: 'executeBatch', type: 'function', stateMutability: 'nonpayable', outputs: [],
  inputs: [{ name: 'calls', type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }] }] }];
const owner = fixture.owner.toLowerCase(), batches = new Map(), latches = new Map();
/** A transaction's receipt once the local chain has mined it, as the harness waits for one. */
async function receiptOf(hash) {
  for (let tries = 0; tries < 200; tries++) {
    const receipt = await rpc('eth_getTransactionReceipt', [hash]);
    if (receipt) return receipt;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`no receipt for ${hash}`);
}
const wallet = { owner, current: () => true, nonceOffered: () => false, claimNonce: async () => 'nonce', releaseRejectedNonce: async () => {},
  batchOffered: id => (latches.has(id) ? latches.get(id).id : null),
  claimBatch: async id => { if (latches.has(id)) throw new Error('wallet_batch_already_offered'); latches.set(id, { claim: `claim-${id}`, id: '' }); return `claim-${id}`; },
  recordBatch: async (id, claim, batch) => { if (latches.get(id)?.claim === claim) latches.set(id, { claim, id: batch }); },
  releaseBatch: async (id, claim) => { const held = latches.get(id); if (held && claim && (held.claim === claim || held.id === claim)) latches.delete(id); },
  request: async (method, params) => {
    if (method === 'wallet_getCapabilities') return { '0x1237': { atomic: { status: 'supported' } } };
    if (method === 'wallet_sendCalls') {
      const [{ version, chainId, from, atomicRequired, calls }] = params;
      assert.deepEqual([version, chainId, from.toLowerCase(), atomicRequired], ['2.0.0', '0x1237', owner, true]);
      // The account executes its own batch (EIP-7702): one transaction from the owner to itself.
      const data = encodeFunctionData({ abi: EXECUTE_BATCH, functionName: 'executeBatch', args: [calls.map(call => ({ target: call.to, value: BigInt(call.value), data: call.data }))] });
      const hash = await rpc('eth_sendTransaction', [{ from: owner, to: owner, data, gas: '0x1c9c380' }]);
      await receiptOf(hash);
      const id = `0x${(0xba7c0 + batches.size).toString(16)}`;
      batches.set(id, hash);
      return { id };
    }
    if (method === 'wallet_getCallsStatus') {
      const receipt = await rpc('eth_getTransactionReceipt', [batches.get(params[0])]);
      return { version: '2.0.0', id: params[0], chainId: '0x1237', status: !receipt ? 100 : receipt.status === '0x1' ? 200 : 500, atomic: true, receipts: receipt ? [receipt] : [] };
    }
    return rpc(method, params);
  } };
const deployment = deploymentFrom(fixture.release, now);
const client = createSetupClient(wallet, deployment, () => now, async () => deployment);
const key = fixture.key, native = key.currency0 === zeroAddress, setup = deployment.setup.toLowerCase();
const gas = { maxGas: 15_000_000n, maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, reserveWei: 0n };
const nameOf = call => decodeFunctionData({ abi: call.to.toLowerCase() === setup ? setupAbi : tokenAbi, data: call.data }).functionName;
const tokens = [];
let checks = 0;
async function created(id, operationId) {
  for (let beat = 0; beat < 20; beat++) {
    const state = await client.batchStatus(id, operationId);
    if (state.state === 'created') return state.tokenId;
    assert.equal(state.state, 'pending', JSON.stringify(state, (_, v) => (typeof v === 'bigint' ? String(v) : v)));
    await rpc('anvil_mine', ['0x1']);
  }
  assert.fail('the batch never read back created');
}

assert.equal(await atomicStatus(wallet), 'supported'); checks++;
// 1. Both tokens into a pool the mint creates: the approvals (none for ETH), the deposit and the mint, one transaction.
const price = 2n ** 96n, amount = 100n * 10n ** 18n;
const first = await client.prepareBatch({ key, amount0: amount, amount1: amount, swap: null,
  mint: { tickLower: -600, tickUpper: 600, liquidity: 10n ** 18n, maxAmount0: amount, maxAmount1: amount, minSqrtPriceX96: price / 2n, maxSqrtPriceX96: price * 2n, initialSqrtPriceX96: price } }, gas);
assert.deepEqual(first.calls.map(nameOf), native ? ['approve', 'open', 'mint'] : ['approve', 'approve', 'open', 'mint']); checks++;
assert.ok(first.gasUsed > 0n); checks++;
const idOne = await client.sendBatch(first, true);
const receiptOne = await receiptOf(batches.get(idOne));
assert.deepEqual([receiptOne.status, receiptOne.from.toLowerCase(), receiptOne.to.toLowerCase()], ['0x1', owner, owner], 'one transaction, the account to itself'); checks++;
tokens.push(String(await created(idOne, first.operationId))); checks++;
assert.equal(wallet.batchOffered(first.operationId), null, 'created: the latch is done'); checks++;
// 2. One token with the swap, in the pool the first batch made: the swap asks at least its minimum, the mint counts on it alone.
const deposit = 10n ** 18n, gross = 10n ** 16n, minOutput = (gross * 9n) / 10n;
const second = await client.prepareBatch({ key, amount0: deposit, amount1: 0n, swap: { zeroForOne: true, gross, minOutput, sqrtLimit: (price * 9n) / 10n },
  mint: { tickLower: -600, tickUpper: 600, liquidity: minOutput * 20n, maxAmount0: deposit - gross, maxAmount1: minOutput, minSqrtPriceX96: price / 2n, maxSqrtPriceX96: price * 2n, initialSqrtPriceX96: 0n } }, gas);
assert.deepEqual(second.calls.map(nameOf), native ? ['open', 'swap', 'mint'] : ['approve', 'open', 'swap', 'mint']); checks++;
const idTwo = await client.sendBatch(second, true);
tokens.push(String(await created(idTwo, second.operationId))); checks++;
// 3. A batch prepared for an operation id another batch then opened reverts whole on chain: nothing of it remains.
const small = { key, amount0: 10n ** 15n, amount1: 10n ** 15n, swap: null,
  mint: { tickLower: -600, tickUpper: 600, liquidity: 10n ** 15n, maxAmount0: 10n ** 15n, maxAmount1: 10n ** 15n, minSqrtPriceX96: price / 2n, maxSqrtPriceX96: price * 2n, initialSqrtPriceX96: 0n } };
const stale = await client.prepareBatch(small, gas), fresh = await client.prepareBatch(small, gas);
assert.equal(stale.operationId, fresh.operationId); checks++;
const idFresh = await client.sendBatch(fresh, true);
tokens.push(String(await created(idFresh, fresh.operationId))); checks++;
await assert.rejects(client.sendBatch(stale, true), /batch_state_changed/, 'the client offers nothing for an id already opened'); checks++;
const nonceBefore = await rpc('eth_getTransactionCount', [owner, 'latest']);
const { id: idStale } = await wallet.request('wallet_sendCalls', [{ version: '2.0.0', chainId: '0x1237', from: owner, atomicRequired: true, calls: stale.calls }]);
const receiptStale = await receiptOf(batches.get(idStale));
assert.equal(receiptStale.status, '0x0', 'executed whole or not at all: the open of a used id reverts every call'); checks++;
assert.equal(BigInt(await rpc('eth_getTransactionCount', [owner, 'latest'])), BigInt(nonceBefore) + 1n, 'only the transaction itself, and its gas'); checks++;
assert.deepEqual((await wallet.request('wallet_getCallsStatus', [idStale])).status, 500); checks++;
console.log(JSON.stringify({ passed: true, checks, tokens, batches: batches.size }));
