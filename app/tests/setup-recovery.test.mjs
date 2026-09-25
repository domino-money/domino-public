import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { createSetupClient, setupAbi } = require('../.test-build/app/src/finance/setup.js');
const { decodeFunctionData, encodeFunctionResult, encodeFunctionData, keccak256 } = require('viem');
const address = n => '0x' + n.toString(16).padStart(40, '0');
const id = '0x' + 'ab'.repeat(32), txHash = '0x' + 'cd'.repeat(32), blockHash = '0x' + 'ef'.repeat(32);
const gas = { maxGas: 200000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, reserveWei: 0n };

function fixture({ expired = false, recovering = false, foreign = false, missingServices = false, ownerCode = '0x', receive = 'accept', delegateCode = null, confirmed = true } = {}) {
  const code = '0x6000', hash = keccak256(code), owner = address(1), calls = [], asked = [];
  // The delegate a designator in `ownerCode` names answers `delegateCode` when given, else the same code as every other contract.
  const delegate = '0x' + ownerCode.slice(8);
  const deployment = { setup: address(2), poolManager: address(3), positionManager: address(4), stateView: address(5), feeRecipient: address(6),
    setupCodeHash: hash, poolManagerCodeHash: hash, positionManagerCodeHash: hash, stateViewCodeHash: hash,
    feeBps: 65, tariffVersion: '1', expiresAt: expired ? 1 : 10000 };
  const operation = { owner: foreign ? address(10) : owner,
    key: { currency0: address(0), currency1: address(9), fee: 3000, tickSpacing: 60, hooks: address(0) },
    balance0: 1000n, balance1: 2000n, swapped: true, closed: false, tokenId: 0n };
  const getters = { manager: deployment.poolManager, positions: deployment.positionManager, stateView: deployment.stateView,
    feeRecipient: deployment.feeRecipient, assistedFeeBps: 65, tariffVersion: 1n, operation, recoveryStarted: recovering, nextOperationId: id };
  let sent;
  const wallet = { owner, current: () => true, nonceOffered: () => false, claimNonce: async () => 'claim', releaseRejectedNonce: async () => {},
    // Whether the person confirmed on the page that they set up this delegate (finance/wallet.ts); every question logged.
    delegateConfirmed: value => { asked.push(value); return confirmed; },
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'eth_accounts') return [owner];
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_getCode') return params[0] === owner ? ownerCode : delegateCode !== null && params[0] === delegate ? delegateCode : missingServices && params[0] !== deployment.setup ? '0x' : code;
      if (method === 'eth_getTransactionCount') return '0x0';
      if (method === 'eth_getBalance') return '0x10000000';
      if (method === 'eth_estimateGas') return '0x10000';
      if (method === 'eth_sendTransaction') { sent = params[0]; return txHash; }
      if (method === 'eth_call') {
        if (params[0].to === owner) {
          // The one-wei payment probe to the owner's own account, as a node
          // answers it through a wallet: paid, refused by the account's code
          // (code 3 wrapped by the wallet), or not answered at all.
          if (receive === 'revert') throw Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603, data: { code: 3, message: 'execution reverted', data: '0x' } });
          if (receive === 'unavailable') throw Object.assign(new Error('Request failed'), { code: -32603 });
          assert.deepEqual(params[0], { from: owner, to: owner, value: '0x1' });
          return '0x';
        }
        const call = decodeFunctionData({ abi: setupAbi, data: params[0].data });
        if (['recoverCurrency', 'cancel', 'open', 'mint'].includes(call.functionName)) return '0x';
        return encodeFunctionResult({ abi: setupAbi, functionName: call.functionName, result: getters[call.functionName] });
      }
      if (method === 'eth_getTransactionByHash') return { hash: txHash, from: owner, to: deployment.setup,
        input: encodeFunctionData({ abi: setupAbi, functionName: 'recoverCurrency', args: [id, address(0), 1000n] }), value: '0x0', nonce: '0x0' };
      if (method === 'eth_getTransactionReceipt') return { transactionHash: txHash, from: owner, blockNumber: '0x10', blockHash, status: '0x1' };
      if (method === 'eth_getBlockByNumber') return { number: '0x10', hash: blockHash };
      throw new Error('unexpected fixture request: ' + method);
    } };
  const client = createSetupClient(wallet, deployment, () => 100, async () => expired ? null : deployment);
  return { client, calls, operation, asked, get sent() { return sent; } };
}

test('independent refund remains available with expired admission and absent external services', async () => {
  const f = fixture({ expired: true, missingServices: true });
  const prepared = await f.client.recover(id, address(0), 1000n, gas);
  assert.equal(prepared.kind, 'recover');
  assert.deepEqual(decodeFunctionData({ abi: setupAbi, data: prepared.transaction.data }).args, [id, address(0), 1000n]);
  assert.ok(prepared.summary.some(line => line.includes('can no longer swap or mint')));
  assert.ok(prepared.summary.some(line => line.includes('may reduce the amount received')));
  // Only the setup contract and the owner's own account: no external service.
  assert.ok(f.calls.filter(c => c.method === 'eth_getCode').every(c => [address(2), address(1)].includes(c.params[0])));
  assert.equal(f.sent, undefined);
  assert.equal(await f.client.send(prepared, true), txHash);
  assert.equal(f.sent.value, '0x0');
  assert.equal(f.sent.to, address(2));
});

test('an EIP-7702 account that refuses plain ETH gets no native refund prepared; one that accepts it does', async () => {
  const designator = '0xef0100' + 'ab'.repeat(20);
  for (const step of [f => f.client.cancel(id, gas), f => f.client.recover(id, address(0), 1000n, gas)]) {
    const refused = fixture({ ownerCode: designator, receive: 'revert' });
    await assert.rejects(step(refused), /native_eth_refused/);
    assert.equal(refused.calls.some(c => c.method === 'eth_estimateGas'), false, 'nothing is simulated or offered');
    assert.equal(refused.sent, undefined);
    const accepted = fixture({ ownerCode: designator });
    assert.ok((await step(accepted)).kind);
    // A plain EOA is paid without a probe.
    const plain = fixture();
    assert.ok((await step(plain)).kind);
    assert.equal(plain.calls.some(c => c.method === 'eth_call' && c.params[0].to === address(1)), false);
  }
  // Funding a native operation checks before any approval or funding, and a
  // mint that would return unused ETH checks before it is simulated.
  const key = { currency0: address(0), currency1: address(9), fee: 3000, tickSpacing: 60, hooks: address(0) };
  const plan = { tickLower: -60, tickUpper: 60, liquidity: 1n, maxAmount0: 1n, maxAmount1: 1n, minSqrtPriceX96: 1n, maxSqrtPriceX96: 2n ** 100n, initialSqrtPriceX96: 0n };
  for (const step of [f => f.client.fund(key, 1n, 0n, gas), f => f.client.mint(id, plan, gas)]) {
    const refused = fixture({ ownerCode: designator, receive: 'revert' });
    await assert.rejects(step(refused), /native_eth_refused/);
    assert.equal(refused.calls.some(c => c.method === 'eth_estimateGas'), false);
  }
  assert.equal((await fixture({ ownerCode: designator }).client.fund(key, 1n, 0n, gas)).kind, 'fund');
  // Only the token side needs no probe, whatever the account's code.
  const token = fixture({ ownerCode: designator, receive: 'revert' });
  assert.equal((await token.client.recover(id, address(9), 2000n, gas)).kind, 'recover');
  // A probe the wallet could not answer is not a refusal: it fails as a read.
  await assert.rejects(fixture({ ownerCode: designator, receive: 'unavailable' }).client.cancel(id, gas), /Request failed/);
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

test('funding an EIP-7702 account whose delegate is not recognized waits for the person’s confirmation, before any approval or simulation', async () => {
  const key = { currency0: address(0), currency1: address(9), fee: 3000, tickSpacing: 60, hooks: address(0) };
  const delegate = '0x' + 'ab'.repeat(20), designator = '0xef0100' + delegate.slice(2);
  // Not confirmed: refused as itself, asked once for this exact delegate, and the wallet was asked nothing past the reads.
  const waiting = fixture({ ownerCode: designator, confirmed: false });
  await assert.rejects(waiting.client.fund(key, 1n, 0n, gas), /delegate_unrecognized/);
  assert.deepEqual(waiting.asked, [delegate]);
  assert.deepEqual(waiting.calls.filter(c => ['eth_call', 'eth_estimateGas', 'eth_getTransactionCount', 'eth_sendTransaction'].includes(c.method) && c.params[0].to !== address(2)), [],
    'no native probe, allowance, simulation, nonce or send: only the deployment was read');
  const deploymentReads = ['manager', 'positions', 'stateView', 'feeRecipient', 'assistedFeeBps', 'tariffVersion'];
  assert.deepEqual(waiting.calls.filter(c => c.method === 'eth_call' && c.params[0].to === address(2))
    .map(c => decodeFunctionData({ abi: setupAbi, data: c.params[0].data }).functionName).filter(name => !deploymentReads.includes(name)), [],
    'the setup contract was read for its deployment only: no operation id, no simulated open');
  assert.equal(waiting.sent, undefined);
  // Confirmed for that delegate: the funding is prepared.
  const confirmed = fixture({ ownerCode: designator });
  assert.equal((await confirmed.client.fund(key, 1n, 0n, gas)).kind, 'fund');
  assert.deepEqual(confirmed.asked, [delegate]);
  // A recognized delegate's own code (Simple7702Account, read on 4663) needs no confirmation, and none is asked.
  const REAL = JSON.parse(readFileSync(new URL('./support/eip7702-delegates.code.json', import.meta.url), 'utf8'));
  const simple = '0xe6cae83bde06e4c305530e199d7217f42808555b';
  const known = fixture({ ownerCode: '0xef0100' + simple.slice(2), delegateCode: REAL.code[simple], confirmed: false });
  assert.equal((await known.client.fund(key, 1n, 0n, gas)).kind, 'fund');
  assert.deepEqual(known.asked, []);
  // A plain EOA, and an account with other code, fund as before: this check is about designators only.
  for (const ownerCode of ['0x', '0x6000']) {
    const f = fixture({ ownerCode, confirmed: false });
    assert.equal((await f.client.fund(key, 1n, 0n, gas)).kind, 'fund', ownerCode);
    assert.deepEqual(f.asked, [], ownerCode);
  }
  // What the page shows first: the account's code, and the delegate with its entry or none.
  assert.deepEqual(await waiting.client.account(), { kind: 'delegated', delegate, known: null });
  assert.equal((await known.client.account()).known.wallet, 'Simple7702Account');
  assert.deepEqual(await fixture().client.account(), { kind: 'plain' });
  assert.equal(waiting.client.owner, address(1));
  // Refunds, recovery and the mint never wait for it: they move nothing new into the account's care.
  const id2 = '0x' + 'ab'.repeat(32);
  for (const step of [f => f.client.cancel(id2, gas), f => f.client.recover(id2, address(9), 2000n, gas)]) {
    const f = fixture({ ownerCode: designator, confirmed: false });
    assert.ok((await step(f)).kind);
    assert.deepEqual(f.asked, []);
  }
});
