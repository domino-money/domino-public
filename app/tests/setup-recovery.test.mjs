import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { createSetupClient, setupAbi } = require('../.test-build/app/src/finance/setup.js');
const { decodeFunctionData, encodeFunctionResult, encodeFunctionData, keccak256 } = require('viem');
const address = n => '0x' + n.toString(16).padStart(40, '0');
const id = '0x' + 'ab'.repeat(32), txHash = '0x' + 'cd'.repeat(32), blockHash = '0x' + 'ef'.repeat(32);
const gas = { maxGas: 200000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, reserveWei: 0n };

function fixture({ expired = false, recovering = false, foreign = false, missingServices = false } = {}) {
  const code = '0x6000', hash = keccak256(code), owner = address(1), calls = [];
  const deployment = { setup: address(2), poolManager: address(3), positionManager: address(4), stateView: address(5), feeRecipient: address(6),
    setupCodeHash: hash, poolManagerCodeHash: hash, positionManagerCodeHash: hash, stateViewCodeHash: hash,
    feeBps: 65, tariffVersion: '1', expiresAt: expired ? 1 : 10000 };
  const operation = { owner: foreign ? address(10) : owner,
    key: { currency0: address(0), currency1: address(9), fee: 3000, tickSpacing: 60, hooks: address(0) },
    balance0: 1000n, balance1: 2000n, swapped: true, closed: false, tokenId: 0n };
  const getters = { manager: deployment.poolManager, positions: deployment.positionManager, stateView: deployment.stateView,
    feeRecipient: deployment.feeRecipient, assistedFeeBps: 65, tariffVersion: 1n, operation, recoveryStarted: recovering };
  let sent;
  const wallet = { owner, current: () => true, nonceOffered: () => false, claimNonce: async () => 'claim', releaseRejectedNonce: async () => {},
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'eth_accounts') return [owner];
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_getCode') return missingServices && params[0] !== deployment.setup ? '0x' : code;
      if (method === 'eth_getTransactionCount') return '0x0';
      if (method === 'eth_getBalance') return '0x10000000';
      if (method === 'eth_estimateGas') return '0x10000';
      if (method === 'eth_sendTransaction') { sent = params[0]; return txHash; }
      if (method === 'eth_call') {
        const call = decodeFunctionData({ abi: setupAbi, data: params[0].data });
        if (call.functionName === 'recoverCurrency' || call.functionName === 'cancel') return '0x';
        return encodeFunctionResult({ abi: setupAbi, functionName: call.functionName, result: getters[call.functionName] });
      }
      if (method === 'eth_getTransactionByHash') return { hash: txHash, from: owner, to: deployment.setup,
        input: encodeFunctionData({ abi: setupAbi, functionName: 'recoverCurrency', args: [id, address(0), 1000n] }), value: '0x0', nonce: '0x0' };
      if (method === 'eth_getTransactionReceipt') return { transactionHash: txHash, from: owner, blockNumber: '0x10', blockHash, status: '0x1' };
      if (method === 'eth_getBlockByNumber') return { number: '0x10', hash: blockHash };
      throw new Error('unexpected fixture request: ' + method);
    } };
  const client = createSetupClient(wallet, deployment, () => 100, async () => expired ? null : deployment);
  return { client, calls, operation, get sent() { return sent; } };
}

test('independent refund remains available with expired admission and absent external services', async () => {
  const f = fixture({ expired: true, missingServices: true });
  const prepared = await f.client.recover(id, address(0), 1000n, gas);
  assert.equal(prepared.kind, 'recover');
  assert.deepEqual(decodeFunctionData({ abi: setupAbi, data: prepared.transaction.data }).args, [id, address(0), 1000n]);
  assert.ok(prepared.summary.some(line => line.includes('can no longer swap or mint')));
  assert.ok(prepared.summary.some(line => line.includes('may reduce the amount received')));
  assert.ok(f.calls.filter(c => c.method === 'eth_getCode').every(c => c.params[0] === address(2)));
  assert.equal(f.sent, undefined);
  assert.equal(await f.client.send(prepared, true), txHash);
  assert.equal(f.sent.value, '0x0');
  assert.equal(f.sent.to, address(2));
});

test('refund refuses another owner, unrelated currency, zero and excessive debits before any wallet send', async () => {
  await assert.rejects(fixture({ foreign: true }).client.recover(id, address(0), 1n, gas), /operation_not_owned/);
  for (const [currency, amount] of [[address(0), 0n], [address(0), 1001n], [address(8), 1n], [address(9), 2n ** 128n]]) {
    const f = fixture();
    await assert.rejects(f.client.recover(id, currency, amount, gas), /invalid_recovery_amount/);
    assert.equal(f.sent, undefined);
  }
});

test('recovery state is read independently of the unchanged Operation tuple and refuses further economic actions', async () => {
  const f = fixture({ recovering: true });
  assert.equal((await f.client.inspect(id)).recoveryStarted, true);
  await assert.rejects(f.client.swap(id, true, 1n, 100, 1n, gas), /operation_recovery_started/);
  await assert.rejects(f.client.mint(id, {}, gas), /operation_recovery_started/);
  assert.equal(f.calls.some(c => c.method === 'eth_estimateGas'), false);
});

test('a reloaded client recognizes a single-currency recovery receipt and rejects a substituted operation', async () => {
  const f = fixture({ expired: true, missingServices: true });
  assert.equal((await f.client.receipt(txHash, id)).state, 'finalized');
  await assert.rejects(f.client.receipt(txHash, '0x' + 'cc'.repeat(32)), /transaction_operation_mismatch/);
});
