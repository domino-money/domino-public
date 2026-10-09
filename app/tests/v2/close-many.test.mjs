import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { decodeFunctionData, encodeFunctionData, parseAbi } from 'viem';
import { createDirectChain } from '../support/v2-direct-chain.mjs';
import { walletOf } from '../support/v2-chain.mjs';

const require = createRequire(import.meta.url);
const direct = require('../../.test-build/app/src/finance/v2/direct.js');
const position = require('../../.test-build/app/src/finance/position.js');
const { v2Chain } = require('../../.test-build/app/src/v2/chains.js');
const GAS = { maxGas: 8_000_000n, maxFeePerGas: 200_000_000n, maxPriorityFeePerGas: 0n, reserveWei: 0n };
const ZERO = '0x0000000000000000000000000000000000000000';
const TOKEN = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const VAULT = '0x2222222222222222222222222222222222222222';
const NOW = 1_790_870_000;
const MULTICALL = parseAbi(['function multicall(bytes[] data) payable returns (bytes[] results)']);
const v4 = (id, liquidity = 10n ** 15n) => ({ tokenId: BigInt(id), pool: { currency0: ZERO, currency1: TOKEN, fee: 3000, tickSpacing: 60 }, tickLower: -201060, tickUpper: -198060, liquidity,
  sqrtPriceX96: position.sqrtPriceAtTick(-199500), tick: -199500, growthLast: [0n, 0n], growthNow: [10n ** 28n, 10n ** 28n] });
const v3 = (id) => ({ tokenId: BigInt(id), token0: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', token1: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', fee: 500,
  tickLower: -200000, tickUpper: -190000, liquidity: 10n ** 15n, sqrtPriceX96: position.sqrtPriceAtTick(-195000), tick: -195000, owed: [10n ** 12n, 500_000n] });
function setup(options = {}, probe = null, root = null, wrap = (wallet) => wallet) {
  const chain = createDirectChain({ v4: [v4(101), v4(102, 5n * 10n ** 14n)], timestamp: NOW, ...options });
  const wallet = wrap(walletOf(chain));
  const client = direct.createDirectClient(wallet, v2Chain(chain.chainId), () => NOW, chain.codeHashes, probe, root);
  return { chain, client, wallet };
}

test('v4 closes two different-liquidity NFTs in one atomic owner multicall, no approval or native value; receipt aggregates shared currency once', async () => {
  const { chain, client } = setup();
  const prepared = await client.prepareCloseMany(4, [101n, 102n], 50, GAS);
  assert.equal(new Set(prepared.positions.map((entry) => entry.blockNumber)).size, 1);
  const calls = decodeFunctionData({ abi: MULTICALL, data: prepared.step.transaction.data }).args[0];
  assert.equal(calls.length, 2);
  calls.forEach((call, i) => assert.equal(call, position.closeData(prepared.positions[i].tokenId, prepared.positions[i].liquidity, ...prepared.minimums[i], ZERO, TOKEN, chain.owner, prepared.deadline)));
  const hash = await client.sendCloseMany(prepared, true);
  const receipt = await client.receipt(hash);
  const read = direct.readDirectCloseManyReceipt(prepared, chain.owner, receipt);
  assert.equal(chain.sends.length, 1);
  assert.equal(chain.sends[0].tx.value, '0x0');
  assert.equal(chain.v4Position(101).liquidity, 0n);
  assert.equal(chain.v4Position(102).liquidity, 0n);
  assert.equal(chain.v4Position(101).owner, chain.owner);
  assert.deepEqual(read.tokenIds, [101n, 102n]);
  assert.equal(read.paid.find((entry) => entry.token === TOKEN).amount, prepared.receive[0][1] + prepared.receive[1][1]);
  assert.equal(read.paid.find((entry) => entry.token === ZERO).amount, null, 'native payment is not invented from ERC20 logs');
  assert.equal(read.gas.executionWei, receipt.gasUsed * receipt.effectiveGasPrice);
  assert.equal(client.inFlight(4, 101n), null);
  assert.deepEqual(chain.missing, []);
});

test('v3 closes two NFTs in one manager transaction and sums tokenId-qualified Collect logs, with gas counted once', async () => {
  const { chain, client } = setup({ chainId: 42161, v4: [], v3: [v3(201), v3(202)] });
  const prepared = await client.prepareCloseMany(3, [201n, 202n], 50, GAS);
  const hash = await client.sendCloseMany(prepared, true);
  const receipt = await client.receipt(hash);
  const read = direct.readDirectCloseManyReceipt(prepared, chain.owner, receipt);
  assert.equal(chain.sends.length, 1);
  assert.equal(chain.v3Position(201).liquidity, 0n);
  assert.equal(chain.v3Position(202).liquidity, 0n);
  assert.deepEqual(read.paid.map((entry) => entry.amount), [0, 1].map((i) => prepared.receive[0][i] + prepared.receive[1][i]));
  assert.equal(read.gas.executionWei, receipt.gasUsed * receipt.effectiveGasPrice);
});

test('group rejects duplicate, too many, closed, hooked, foreign and vault-custodied NFTs before sending', async () => {
  const { client } = setup();
  await assert.rejects(client.prepareCloseMany(4, [101n, 101n], 50, GAS), /invalid_position_id/);
  await assert.rejects(client.prepareCloseMany(4, Array.from({ length: 9 }, (_, i) => BigInt(i + 1)), 50, GAS), /invalid_position_id/);
  for (const [change, code] of [[{ liquidity: 0n }, 'position_already_empty'], [{ pool: { ...v4(102).pool, hooks: VAULT } }, 'position_pool_has_hooks'], [{ owner: VAULT }, 'position_not_owned']]) {
    const { chain, client: checked } = setup({ v4: [v4(101), { ...v4(102), ...change }] });
    await assert.rejects(checked.prepareCloseMany(4, [101n, 102n], 50, GAS), new RegExp(code));
    assert.equal(chain.sends.length, 0);
  }
  const { client: custody } = setup({ v4: [v4(101), { ...v4(102), owner: VAULT }] }, async (_, address) => address === VAULT);
  await assert.rejects(custody.prepareCloseMany(4, [101n, 102n], 50, GAS), /position_vault_successor/);
});

test('armed root warning must be acknowledged, custody and liquidity are rechecked before wallet confirmation', async () => {
  const { chain, client } = setup({ v4: [{ ...v4(101), approved: VAULT }, v4(102)] }, async (_, address) => address === VAULT, async () => ({ armed: true }));
  const prepared = await client.prepareCloseMany(4, [101n, 102n], 50, GAS);
  assert.deepEqual(prepared.pausesAutomation, [VAULT]);
  await assert.rejects(client.sendCloseMany(prepared, true), /automation_pause_unacknowledged/);
  chain.v4Position(102).liquidity += 1n;
  await assert.rejects(client.sendCloseMany(prepared, true, true), /wallet_review_required/);
  assert.equal(chain.sends.length, 0);
  assert.equal(client.inFlight(4, 101n), null);
});

test('confirmed refusal releases every NFT; an unknown wallet outcome holds every NFT and cannot be sent again', async () => {
  const { chain, client } = setup();
  const prepared = await client.prepareCloseMany(4, [101n, 102n], 50, GAS);
  chain.decline();
  await assert.rejects(client.sendCloseMany(prepared, true));
  assert.equal(client.inFlight(4, 101n), null);
  assert.equal(client.inFlight(4, 102n), null);
  const sent = setup({}, null, null, (wallet) => ({ ...wallet, request: async (method, params) => {
    const reply = await wallet.request(method, params);
    if (method === 'eth_sendTransaction') throw new Error('Disconnected after send');
    return reply;
  } }));
  const unknown = await sent.client.prepareCloseMany(4, [101n, 102n], 50, GAS);
  await assert.rejects(sent.client.sendCloseMany(unknown, true));
  assert.ok(sent.client.wasGroupOffered(unknown));
  assert.ok(sent.client.inFlight(4, 101n));
  await assert.rejects(sent.client.prepareCloseMany(4, [101n, 102n], 50, GAS), /review_already_sent/);
  assert.equal(sent.chain.sends.length, 1);
});

test('reload recovery proves exact calldata, owner, nonce and canonical receipt without requiring present NFT ownership', async () => {
  const { chain, client } = setup();
  const prepared = await client.prepareCloseMany(4, [101n, 102n], 50, GAS);
  const hash = await client.sendCloseMany(prepared, true);
  const hint = { dex: 4, tokenIds: [101n, 102n], data: prepared.step.transaction.data, nonce: prepared.step.transaction.nonce, hash };
  const restored = direct.createDirectClient(walletOf(chain), v2Chain(chain.chainId), () => NOW, chain.codeHashes);
  assert.equal((await restored.recoverCloseMany(hint)).receipt.state, 'finalized');
  chain.v4Position(101).owner = VAULT;
  const result = await restored.recoverCloseMany(hint);
  assert.equal(result.receipt.state, 'finalized'); assert.equal(result.description, null);
  await assert.rejects(restored.recoverCloseMany({ ...hint, nonce: '0xaa' }), /transaction_does_not_match_review/);
  await assert.rejects(restored.recoverCloseMany({ ...hint, tokenIds: [101n, 103n] }), /transaction_does_not_match_review/);
  const waiting = direct.createDirectClient({ ...walletOf(chain), request: async (method, params) => method === 'eth_getTransactionReceipt' ? null : walletOf(chain).request(method, params) }, v2Chain(chain.chainId), () => NOW, chain.codeHashes);
  assert.equal((await waiting.recoverCloseMany(hint)).receipt.state, 'pending');
  assert.equal(chain.sends.length, 1, 'recovery has no sending authority');
});

test('maximum two cold Base NFTs with foreign approvals, vault subscribers, native delegate and automatic gas fit the unchanged 48-call operation budget', async () => {
  const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), F0 = '0x' + 'c'.repeat(40), F1 = '0x' + 'd'.repeat(40);
  const abi = parseAbi(['function isVault(address who) view returns(bool)', 'function root() view returns(uint256)', 'function rootArmed() view returns(bool)']);
  const chain = createDirectChain({ chainId: 8453, timestamp: NOW, v4: [ { ...v4(101), approved: A, subscriber: VAULT }, { ...v4(102), approved: B, subscriber: '0x' + '3'.repeat(40) } ] });
  const inner = walletOf(chain); let calls = 0;
  const wallet = { ...inner, request: async (method, params) => {
    calls++;
    if (method === 'eth_getCode' && params[0] === chain.owner) return '0xef0100' + '1'.repeat(40);
    if (method === 'eth_call' && params[0].to === chain.owner) return '0x';
    if (method === 'eth_getCode' && [F0, F1].includes(params[0])) return '0x6000';
    if (method === 'eth_call' && [F0, F1, VAULT, '0x' + '3'.repeat(40)].includes(params[0].to)) return '0x' + '0'.repeat(64);
    return inner.request(method, params);
  } };
  const probe = async (rpc, address, block) => {
    await Promise.all([F0, F1].map((factory) => rpc('eth_getCode', [factory, block])));
    for (const factory of [F0, F1]) await rpc('eth_call', [{ to: factory, data: encodeFunctionData({ abi, functionName: 'isVault', args: [address] }) }, block]);
    return address !== A && address !== B;
  };
  const root = async (rpc, vault, _dex, _id, block) => {
    for (const fn of ['root', 'rootArmed']) await rpc('eth_call', [{ to: vault, data: encodeFunctionData({ abi, functionName: fn }) }, block]);
    return { armed: true };
  };
  const client = direct.createDirectClient(wallet, v2Chain(8453), () => NOW, chain.codeHashes, probe, root);
  assert.equal(direct.MAX_CLOSE_POSITIONS, 2);
  const prepared = await client.prepareCloseMany(4, [101n, 102n], 50);
  assert.ok(calls <= 48, `prepare uses ${calls} calls`); calls = 0;
  await client.sendCloseMany(prepared, true, true);
  assert.ok(calls <= 48, `send uses ${calls} calls`);
  assert.equal(chain.sends.length, 1); assert.deepEqual(chain.missing, []);
});

test('a late explicit wallet refusal releases the group and calls its durable-journal cleanup after the timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let rejectSend, started; const asked = new Promise((resolve) => { started = resolve; }); let cleaned = 0;
  const { client } = setup({}, null, null, (wallet) => ({ ...wallet, request: async (method, params) => {
    if (method !== 'eth_sendTransaction') return wallet.request(method, params);
    started(); return new Promise((_resolve, reject) => { rejectSend = reject; });
  } }));
  const prepared = await client.prepareCloseMany(4, [101n, 102n], 50, GAS);
  const sending = client.sendCloseMany(prepared, true, false, async () => { cleaned++; });
  const timedOut = assert.rejects(sending, /wallet_timeout/);
  await asked; t.mock.timers.tick(300_000); await timedOut;
  assert.ok(client.inFlight(4, 101n));
  rejectSend(Object.assign(new Error('User declined'), { code: 4001 }));
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(cleaned, 1); assert.equal(client.inFlight(4, 101n), null);
});

test('replacement recovery requires the exact wallet and reviewed nonce; a changed recipe ends tracking only after canonical finality and never produces close amounts', async () => {
  const { chain, client } = setup();
  const prepared = await client.prepareCloseMany(4, [101n, 102n], 50, GAS);
  const originalHash = await client.sendCloseMany(prepared, true);
  const replacementHash = '0x' + 'e'.repeat(64);
  let final = false, orphaned = false, same = false, nonce = prepared.step.transaction.nonce;
  const base = walletOf(chain);
  const wallet = { ...base, request: async (method, params) => {
    if (method === 'eth_getBlockByNumber' && params[0] === 'finalized' && !final) return { number: '0x0' };
    if (method === 'eth_getTransactionByHash' && params[0] === replacementHash) {
      const tx = await base.request(method, [originalHash]);
      return { ...tx, hash: replacementHash, nonce, to: same ? tx.to : chain.owner, input: same ? tx.input : '0x' };
    }
    if (method === 'eth_getTransactionReceipt' && params[0] === replacementHash) {
      const receipt = await base.request(method, [originalHash]);
      return { ...receipt, transactionHash: replacementHash, ...(orphaned ? { blockHash: '0x' + 'f'.repeat(64) } : {}), logs: same ? receipt.logs : [] };
    }
    return base.request(method, params);
  } };
  const restored = direct.createDirectClient(wallet, v2Chain(chain.chainId), () => NOW, chain.codeHashes);
  const hint = { dex: 4, tokenIds: [101n, 102n], data: prepared.step.transaction.data, nonce: prepared.step.transaction.nonce, hash: replacementHash, originalHash };
  let result = await restored.recoverCloseMany(hint);
  assert.equal(result.replaced, true); assert.equal(result.replacementFinal, false); assert.equal(result.description, null);
  final = true; orphaned = true;
  result = await restored.recoverCloseMany(hint);
  assert.equal(result.receipt.state, 'reorged'); assert.equal(result.replacementFinal, false);
  orphaned = false;
  result = await restored.recoverCloseMany(hint);
  assert.equal(result.replacementFinal, true); assert.equal(result.description, null);
  result = await restored.recoverCloseMany({ ...hint, originalHash: undefined });
  assert.equal(result.replaced, true); assert.equal(result.replacementFinal, true, 'unknown original hash is recovered by the final consumed reviewed nonce, never by a loose nonce count');
  same = true; result = await restored.recoverCloseMany(hint);
  assert.equal(result.replaced, false); assert.equal(result.receipt.state, 'finalized'); assert.ok(result.description);
  nonce = '0xaa'; await assert.rejects(restored.recoverCloseMany(hint), /transaction_does_not_match_review/);
  assert.equal(chain.sends.length, 1, 'recovery never submits anything');
});
