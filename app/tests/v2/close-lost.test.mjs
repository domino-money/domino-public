/**
 * Added 2026-11-02 (review A1, REVISAO_DINHEIRO_LOGIN.md: "Close positions: a request that never reaches the chain locks the
 * group and its positions' direct exits for good"). Close positions keeps its intent before the wallet is asked
 * (finance/v2/closeJournal.ts beginClose), with no hash until the wallet gives one. When that answer was lost (a reload
 * during the prompt, an error that is not a refusal, a time-out), the intent held the group, and Close position, Collect
 * fees and Withdraw of its positions, in that browser for good. The direct client (finance/v2/direct.ts settleLost) now
 * lets it go once the chain says it can no longer run (the latest block past the close's own deadline), or on the
 * person's word while the chain shows its nonce still the next one with nothing pending, and never otherwise.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { createDirectChain } from '../support/v2-direct-chain.mjs';
import { walletOf } from '../support/v2-chain.mjs';

const require = createRequire(import.meta.url);
const build = (path) => require(`../../.test-build/app/src/${path}.js`);
const direct = build('finance/v2/direct');
const journal = build('finance/v2/closeJournal');
const position = build('finance/position');
const errors = build('v2in/position/errors');
const { STEP_DEADLINE_S } = build('finance/setup');
const { v2Chain } = build('v2/chains');

const GAS = { maxGas: 8_000_000n, maxFeePerGas: 200_000_000n, maxPriorityFeePerGas: 0n, reserveWei: 0n };
const ZERO = '0x0000000000000000000000000000000000000000';
const TOKEN = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const NOW = 1_790_870_000;
const v4 = (id) => ({ tokenId: BigInt(id), pool: { currency0: ZERO, currency1: TOKEN, fee: 3000, tickSpacing: 60 }, tickLower: -201060, tickUpper: -198060, liquidity: 10n ** 15n,
  sqrtPriceX96: position.sqrtPriceAtTick(-199500), tick: -199500, growthLast: [0n, 0n], growthNow: [10n ** 28n, 10n ** 28n] });
const v3 = (id) => ({ tokenId: BigInt(id), token0: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', token1: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', fee: 500,
  tickLower: -200000, tickUpper: -190000, liquidity: 10n ** 15n, sqrtPriceX96: position.sqrtPriceAtTick(-195000), tick: -195000, owed: [10n ** 12n, 500_000n] });
const NETWORKS = [
  { name: 'Base v4', chainId: 8453, dex: 4, ids: [101n, 102n], options: { v4: [v4(101), v4(102)] } },
  { name: 'Arbitrum One v3', chainId: 42161, dex: 3, ids: [201n, 202n], options: { v4: [], v3: [v3(201), v3(202)] } },
];

/** The page's storage and Web Locks, as tests/v2/close-journal.test.mjs installs them. */
async function withBrowser(run) {
  const rows = new Map(); let line = Promise.resolve();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key) => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value) } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request(_key, fn) { const next = line.then(fn); line = next.catch(() => {}); return next; } } } });
  try { await run(); } finally { delete globalThis.localStorage; delete globalThis.navigator; }
}

/**
 * A group handed to the wallet whose answer is lost, as Close positions sends it (BulkClosePositions.tsx send): the intent
 * kept first, then the wallet asked. `lost` says what the wallet does: answer an error that is not a refusal without
 * sending anything ('dropped', -32603), or send it and lose the answer ('sent').
 */
async function lostGroup({ chainId, dex, ids, options }, lost = 'dropped') {
  const chain = createDirectChain({ chainId, timestamp: NOW, ...options });
  const base = walletOf(chain);
  let once = true;
  const nonces = { shift: 0 };
  const wallet = { ...base, request: async (method, params) => {
    if (method === 'eth_sendTransaction' && once) {
      once = false;
      if (lost === 'sent') await base.request(method, params);
      throw Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603 });
    }
    if (method === 'eth_getTransactionCount') return `0x${(BigInt(await base.request(method, params)) + BigInt(params[1] === 'pending' ? nonces.shift : 0)).toString(16)}`;
    return base.request(method, params);
  } };
  const client = direct.createDirectClient(wallet, v2Chain(chainId), () => NOW, chain.codeHashes);
  const prepared = await client.prepareCloseMany(dex, ids, 50, GAS);
  const transaction = prepared.step.transaction;
  const intent = { wallet: chain.owner, chainId, positionManager: transaction.to, dex, tokenIds: ids.map(String), data: transaction.data.toLowerCase(),
    nonce: `0x${BigInt(transaction.nonce).toString(16)}`, hash: null };
  await journal.beginClose(intent);
  await assert.rejects(client.sendCloseMany(prepared, true), /Internal JSON-RPC error/);
  assert.ok(client.wasGroupOffered(prepared), 'handed to the wallet: its answer is what was lost');
  assert.deepEqual(journal.pendingClose(chain.owner), intent);
  return { chain, base, wallet, client, prepared, intent, nonces, ids, dex, chainId };
}

for (const network of NETWORKS) test(`${network.name}: a lost close holds its positions only while it can still run; past its deadline the chain lets it go and the next close is sent once`, () => withBrowser(async () => {
  const s = await lostGroup(network);
  const [first] = s.ids;
  // Before its deadline it may still go through: the wallet may still show it. Nothing is let go.
  assert.equal(await s.client.settleLostClose(s.intent), 'open');
  await assert.rejects(s.client.prepareClose(s.dex, first, 50, GAS), /close_request_unsettled/, 'Close position waits');
  await assert.rejects(s.client.prepareCollect(s.dex, first, GAS), /close_request_unsettled/, 'and Collect fees');
  await assert.rejects(s.client.prepareCloseMany(s.dex, s.ids, 50, GAS), /close_request_unsettled/, 'and the group');
  assert.deepEqual(journal.pendingClose(s.chain.owner), s.intent);
  // The block at its deadline still lets it run (the position manager refuses only a later one).
  s.chain.warp(Number(s.prepared.deadline) - NOW);
  assert.equal(await s.client.settleLostClose(s.intent), 'open', 'at its deadline it can still run');
  assert.ok(s.client.inFlight(s.dex, first));
  // One second later nothing of it can happen any more: a late inclusion reverts. The positions are free again.
  s.chain.warp(1);
  const review = await s.client.prepareClose(s.dex, first, 50, GAS);
  assert.equal(review.tokenId, first, 'Close position reviews again');
  assert.equal(journal.pendingClose(s.chain.owner), null, 'the intent is let go');
  for (const id of s.ids) assert.equal(s.client.inFlight(s.dex, id), null, 'and this client’s own hold on each position');
  assert.ok(s.base.claims.some(([kind, chainId, nonce]) => kind === 'forget' && chainId === s.chainId && nonce === BigInt(s.intent.nonce)), 'its nonce, still free, is let go too');
  const group = await s.client.prepareCloseMany(s.dex, s.ids, 50, GAS);
  await s.client.sendCloseMany(group, true);
  assert.equal(s.chain.sends.length, 1, 'the next close is sent once; the lost one never was');
  for (const id of s.ids) assert.equal((s.dex === 4 ? s.chain.v4Position(id) : s.chain.v3Position(id)).liquidity, 0n);
}));

test('“I rejected it in my wallet” lets a lost close go only while its nonce is still the next one with nothing pending', () => withBrowser(async () => {
  const s = await lostGroup(NETWORKS[0]);
  // Something of this owner is pending on chain: it may be this close. The person's word is not enough.
  s.nonces.shift = 1;
  assert.equal(await s.client.settleLostClose(s.intent, true), 'pending');
  assert.deepEqual(journal.pendingClose(s.chain.owner), s.intent);
  s.nonces.shift = 0;
  assert.equal(await s.client.settleLostClose(s.intent, true), 'forgotten');
  assert.equal(journal.pendingClose(s.chain.owner), null);
  assert.equal(s.client.inFlight(4, 101n), null);
  assert.ok(s.base.claims.some(([kind]) => kind === 'forget'), 'its nonce latch goes with it (V1’s forget)');
  const group = await s.client.prepareCloseMany(4, s.ids, 50, GAS);
  await s.client.sendCloseMany(group, true);
  assert.equal(s.chain.sends.length, 1);
}));

test('a lost close the wallet did send is never let go on the person’s word: its hash can still be found, and the chain lets it go past its deadline', () => withBrowser(async () => {
  const s = await lostGroup(NETWORKS[0], 'sent');
  assert.equal(s.chain.sends.length, 1, 'the wallet sent it; only its answer was lost');
  assert.equal(await s.client.settleLostClose(s.intent, true), 'passed', 'its nonce was taken: it may have gone through');
  assert.equal(await s.client.settleLostClose(s.intent), 'passed');
  assert.deepEqual(journal.pendingClose(s.chain.owner), s.intent, 'kept, so Find your transaction can still prove it');
  await assert.rejects(s.client.prepareCollect(4, 101n, GAS), /close_request_unsettled/);
  s.chain.warp(STEP_DEADLINE_S + 1);
  await assert.rejects(s.client.prepareClose(4, 101n, 50, GAS), /position_already_empty/, 'let go, the review reads what the chain has: it went through');
  assert.equal(journal.pendingClose(s.chain.owner), null);
  assert.equal(s.chain.sends.length, 1, 'nothing sent twice');
}));

test('after a reload: a new client of the page lets the lost close go by the same rules, and Close positions’ own intent too', () => withBrowser(async () => {
  const s = await lostGroup(NETWORKS[0]);
  const reloaded = direct.createDirectClient(walletOf(s.chain), v2Chain(8453), () => NOW, s.chain.codeHashes);
  assert.equal(await reloaded.settleLostClose(s.intent), 'open');
  await assert.rejects(reloaded.prepareCollect(4, 102n, GAS), /close_request_unsettled/, 'Collect fees of the other position of the group waits too');
  // Another account's intent, or another network's, is never this client's to let go.
  await assert.rejects(reloaded.settleLostClose({ ...s.intent, wallet: '0x' + '3'.repeat(40) }), /invalid_close_intent/);
  await assert.rejects(reloaded.settleLostClose({ ...s.intent, chainId: 42161 }), /invalid_close_intent/);
  s.chain.warp(STEP_DEADLINE_S + 1);
  assert.equal(await reloaded.settleLostClose(s.intent), 'settled');
  assert.equal(journal.pendingClose(s.chain.owner), null);
  assert.equal((await reloaded.prepareCollect(4, 102n, GAS)).tokenId, 102n);
  assert.equal(s.chain.sends.length, 0);
}));

test('the position page says where the way out is, in words, with its code apart', () => {
  const said = errors.actionError(new Error('close_request_unsettled'), 8453);
  assert.equal(said.code, 'close_request_unsettled');
  assert.equal(said.copy, 'Closing this position was already sent to your wallet and is not settled on Base yet. Check your wallet’s activity. If you rejected or closed it in your wallet, say so in Close positions.');
  assert.equal(said.recovery, 'none');
});
