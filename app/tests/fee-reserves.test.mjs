/**
 * The fees waiting in a vault (2026-10-02; rugged97's spec rev3 §2.13, the V1 incident of that day: an owner closed his
 * vault's root position and the fees its automation had collected and not reinvested stayed in the vault, with no screen
 * to withdraw them).
 *
 * - The reserves model (src/lib/automate/reserves.ts): what a vault holds per token, the withdrawals that take it
 *   exactly, the automation's state in words, and when a review still holds.
 * - The money client's reads and withdrawals of them (src/finance/sequence.ts ownedVaults, feeReserves, recover
 *   'withdraw-fees', prepareWithdrawBatch, sendWithdrawBatch, withdrawBatchStatus) over the finance suite's fake chain,
 *   read from tests/finance.browser.test.mjs at run time (as tests/sequence-sign-window.test.mjs does), so the two never
 *   drift apart: the exact calls, the nonce latch, a batch's latch, and nothing sent twice.
 *
 * Added with the review of the fee withdrawal (2026-10-02): a withdrawal is proved by the vault's own record of it
 * (withdrawalRecord, and withdrawBatchStatus with no word from the wallet), never by balances an automation run also
 * moves (finding 1); every vault the factory lists, a page at a time (findings 2 and 6); a chain of members longer than
 * one read, walked in pages (finding 3); the transaction a batch's receipt names (finding 4); the V1 release this build
 * ships for recovery (finding 5); and what a screen keeps of each vault across reads that fail (finding 8).
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { decodeFunctionData, parseAbi, toEventSelector } from 'viem';

const require = createRequire(import.meta.url);
const APP = resolve(import.meta.dirname, '..');
const model = require('../.test-build/app/src/lib/automate/reserves.js');
const sequence = require('../.test-build/app/src/finance/sequence.js');
const pin = require('../.test-build/app/src/finance/pin.js');
const batch = require('../.test-build/app/src/finance/batch.js');
const { createNonceJournal } = require('../.test-build/app/src/finance/nonce.js');

async function loadFakeChain() {
  const source = readFileSync(join(APP, 'tests/finance.browser.test.mjs'), 'utf8');
  const start = source.indexOf('const chainAbi = parseAbi([');
  const marker = 'holdNext: () => { hold = true; }, simulate: calls => batchResults(calls).results };\n}';
  const end = source.indexOf(marker, start);
  assert.ok(start >= 0 && end > start, 'the finance suite still defines fakeSequenceChain between the audit harness markers');
  const header = "import { parseAbi, concatHex, keccak256, encodeAbiParameters, parseAbiParameters, stringToHex, zeroAddress, decodeFunctionData, encodeFunctionResult, numberToHex } from 'viem';\n"
    + `import { logLimitError } from ${JSON.stringify(pathToFileURL(join(APP, 'tests/support/log-limits.mjs')).href)};\n`;
  const body = source.slice(start, end + marker.length).replace('function fakeSequenceChain', 'export function fakeSequenceChain');
  const file = join(APP, '.test-build', 'fake-sequence-chain-reserves.mjs');
  mkdirSync(join(APP, '.test-build'), { recursive: true });
  writeFileSync(file, `${header}${body}\n`);
  return (await import(pathToFileURL(file).href)).fakeSequenceChain;
}
const fakeSequenceChain = await loadFakeChain();

// Anvil's public development account #0 address (no key is used here).
const OWNER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const BASE = `0x${'61'.repeat(20)}`, QUOTE = `0x${'62'.repeat(20)}`;
const GAS = { maxGas: 8_000_000n, maxFeePerGas: 200_000_000n, maxPriorityFeePerGas: 0n, reserveWei: 0n };
const vaultAbi = parseAbi(['function withdrawFeeReserves(bytes32,address,uint128,uint128)']);

function storage() {
  const map = new Map();
  return { map, get length() { return map.size; }, key: (i) => [...map.keys()][i] ?? null, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}
function pageLocks() {
  const live = new Set();
  return { live, request: async (_name, fn) => fn(), hold: (name) => { live.add(name); }, letGo: (name) => { live.delete(name); }, held: async (name) => live.has(name) };
}
let ids = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;

/** The owner's wallet over the fake chain, with this page's nonce and batch latches. */
function wallet(chain) {
  const journal = createNonceJournal(storage(), pageLocks(), uuid);
  const calls = [];
  return {
    calls,
    journal,
    rpc: {
      owner: OWNER,
      current: () => true,
      nonceOffered: (nonce) => journal.offered(OWNER, nonce),
      claimNonce: (nonce) => journal.claim(OWNER, nonce, Date.now() / 1000),
      releaseRejectedNonce: (nonce, token) => journal.releaseAfterRejection(OWNER, nonce, token),
      settleNonce: (nonce, now, maxAge) => journal.settle(OWNER, nonce, now, maxAge),
      batchOffered: (id) => journal.batchOffered(OWNER, id),
      claimBatch: (id) => journal.claimBatch(OWNER, id, Date.now() / 1000),
      recordBatch: (id, claim, batch) => journal.recordBatch(OWNER, id, claim, batch),
      releaseBatch: (id, claim) => journal.releaseBatch(OWNER, id, claim),
      async request(method, params) {
        calls.push({ method, params });
        if (method === 'eth_accounts') return [OWNER];
        if (method === 'eth_chainId') return '0x1237';
        const reply = await chain.request(method, params);
        if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
        return reply.result;
      },
    },
  };
}
const clientOf = (chain, w) => sequence.createSequenceClient(w.rpc, chain.release.deployment, () => Date.now() / 1000, async () => chain.release.deployment);
const decoded = (data) => decodeFunctionData({ abi: vaultAbi, data });

// ---- The model ----

const line = (tokenId, sourceId, currency, original, charged = 0n) => ({ tokenId, sourceId, currency, original, charged });
const view = (reserves, patch = {}) => ({ vault: `0x${'aa'.repeat(20)}`, rootTokenId: 100n, paused: false, rootPermissionValid: false, baseCurrency: BASE, quoteCurrency: QUOTE, reserves, ...patch });

test('a vault’s reserves: per token, base first, each balance and its already charged units together, zero ones left out', () => {
  const v = view([
    line(100n, '0x01', BASE, 1_250_000n), line(100n, '0x01', QUOTE, 0n), line(100n, '0x02', BASE, 0n, 40n), line(100n, '0x02', QUOTE, 7n * 10n ** 15n),
    line(11n, '0x03', BASE, 0n), line(11n, '0x03', QUOTE, 0n), line(11n, '0x04', BASE, 0n), line(11n, '0x04', QUOTE, 3n),
  ]);
  assert.deepEqual(model.reserveTotals(v), [{ currency: BASE, amount: 1_250_040n }, { currency: QUOTE, amount: 7n * 10n ** 15n + 3n }]);
  assert.equal(model.holdsReserves(v), true);
  // One withdrawal per balance above zero, for exactly what is booked, in the order read (the root's first).
  assert.deepEqual(model.withdrawals(v), [
    { sourceId: '0x01', currency: BASE, original: 1_250_000n, charged: 0n },
    { sourceId: '0x02', currency: BASE, original: 0n, charged: 40n },
    { sourceId: '0x02', currency: QUOTE, original: 7n * 10n ** 15n, charged: 0n },
    { sourceId: '0x04', currency: QUOTE, original: 3n, charged: 0n },
  ]);
  assert.deepEqual(model.withdrawalTotals(model.withdrawals(v)), model.reserveTotals(v), 'the withdrawals pay out what the row shows');
});

test('nothing is waiting when every reserve is zero: no vault is shown, and there is nothing to withdraw', () => {
  const empty = view([line(100n, '0x01', BASE, 0n), line(100n, '0x01', QUOTE, 0n), line(100n, '0x02', BASE, 0n), line(100n, '0x02', QUOTE, 0n)]);
  const none = view([]);
  assert.equal(model.holdsReserves(empty), false);
  assert.deepEqual(model.reserveTotals(empty), []);
  assert.deepEqual(model.withdrawals(empty), []);
  const full = view([line(100n, '0x01', BASE, 1n)], { vault: `0x${'bb'.repeat(20)}` });
  assert.deepEqual(model.vaultsWithReserves([empty, none, full]), [full]);
});

test('a reserve booked in a currency outside the pool’s two is never counted', () => {
  const odd = view([line(100n, '0x01', `0x${'99'.repeat(20)}`, 5n), line(100n, '0x01', BASE, 2n)]);
  assert.deepEqual(model.reserveTotals(odd), [{ currency: BASE, amount: 2n }]);
});

test('the automation’s state in words: on, paused, or stopped once its permission over the root is gone (a closed, burned or moved root)', () => {
  assert.equal(model.reserveStatus({ paused: false, rootPermissionValid: true }), 'on');
  assert.equal(model.reserveStatus({ paused: true, rootPermissionValid: true }), 'paused');
  assert.equal(model.reserveStatus({ paused: true, rootPermissionValid: false }), 'paused');
  assert.equal(model.reserveStatus({ paused: false, rootPermissionValid: false }), 'stopped');
  assert.deepEqual(Object.values(model.RESERVE_STATUS_TEXT), ['Automation on', 'Automation paused', 'Automation stopped']);
});

test('a review holds only while the vault books exactly what it showed: any change is a new review, never a send', () => {
  const reviewed = [{ sourceId: '0x01', currency: BASE, original: 10n, charged: 0n }, { sourceId: '0x02', currency: QUOTE, original: 0n, charged: 4n }];
  assert.equal(model.sameWithdrawals(reviewed, [...reviewed].reverse()), true, 'the order read does not matter');
  assert.equal(model.sameWithdrawals(reviewed, [{ ...reviewed[0], sourceId: '0X01' }, reviewed[1]]), true, 'nor the case of an id');
  assert.equal(model.sameWithdrawals(reviewed, [reviewed[0]]), false, 'a part already withdrawn');
  assert.equal(model.sameWithdrawals(reviewed, [{ ...reviewed[0], original: 11n }, reviewed[1]]), false, 'more fees collected since');
  assert.equal(model.sameWithdrawals(reviewed, [{ ...reviewed[0], original: 9n }, reviewed[1]]), false, 'fees used by an automation run since');
  assert.equal(model.sameWithdrawals(reviewed, [...reviewed, { sourceId: '0x03', currency: BASE, original: 1n, charged: 0n }]), false, 'a new balance');
});

test('no balance says a replaced step withdrew its row: the model has no such rule any more (finding 1)', () => {
  // A balance gone to zero is what an automation run that reinvested it leaves too, and a balance still there is what a
  // withdrawal leaves when fees were credited meanwhile; only the vault's record of the withdrawal says (withdrawalRecord).
  assert.equal(model.rowTaken, undefined);
});

test('one batch only for two withdrawals or more with a wallet that batches atomically now; otherwise one transaction each', () => {
  assert.equal(model.withdrawalPlan(2, 'supported'), 'batch');
  assert.equal(model.withdrawalPlan(1, 'supported'), 'steps');
  assert.equal(model.withdrawalPlan(3, 'ready'), 'steps', 'a wallet that would first upgrade its account is not asked to');
  assert.equal(model.withdrawalPlan(3, 'unsupported'), 'steps');
  assert.equal(model.withdrawalPlan(3, null), 'steps');
  assert.equal(model.withdrawalPlan(model.WITHDRAWAL_BATCH_LIMIT, 'supported'), 'batch');
  assert.equal(model.withdrawalPlan(model.WITHDRAWAL_BATCH_LIMIT + 1, 'supported'), 'steps', 'more than one batch carries');
  assert.equal(model.WITHDRAWAL_BATCH_LIMIT, sequence.FEE_WITHDRAWAL_BATCH_LIMIT, 'the screen’s limit is the client’s');
});

test('a position’s page shows its own vault, or the vault whose root is its NFT', () => {
  const a = view([], { vault: `0x${'aa'.repeat(20)}`, rootTokenId: 100n }), b = view([], { vault: `0x${'bb'.repeat(20)}`, rootTokenId: 200n });
  assert.deepEqual(model.vaultsFor([a, b], {}), [a, b]);
  assert.deepEqual(model.vaultsFor([a, b], { vault: `0x${'BB'.repeat(20)}` }), [b]);
  assert.deepEqual(model.vaultsFor([a, b], { root: '100' }), [a]);
  assert.deepEqual(model.vaultsFor([a, b], { root: '300' }), []);
});

// ---- The money client over the fake chain ----

/** A vault whose root 100 has a withdrawn successor 11 and an active one 12, with fees booked on the root and on 11. */
const RESERVES = [
  { tokenId: 100n, source: 0, currency: 'base', original: 1_250_000n },
  { tokenId: 100n, source: 1, currency: 'quote', original: 7n * 10n ** 15n },
  { tokenId: 100n, source: 1, currency: 'base', original: 0n, charged: 40n },
  { tokenId: 11n, source: 0, currency: 'base', original: 5n },
];
const chainWith = (options = {}) => fakeSequenceChain(OWNER, { roots: [100n, 200n], chains: { 0: [{ id: 11n, active: false }, { id: 12n, active: true }] }, rootPermissionValid: false, paused: false, reserves: { 0: RESERVES }, settled: true, ...options });

test('feeReserves reads every balance of every position the vault ever registered, a withdrawn successor’s included, and nothing of the root NFT', async () => {
  const chain = chainWith(), w = wallet(chain), client = clientOf(chain, w);
  const read = await client.feeReserves(chain.vaults[0]);
  assert.equal(read.vault, chain.vaults[0]);
  assert.equal(read.rootTokenId, 100n);
  assert.deepEqual([read.paused, read.rootPermissionValid], [false, false]);
  assert.deepEqual(read.reserves.map((r) => r.tokenId), [100n, 100n, 100n, 100n, 11n, 11n, 11n, 11n, 12n, 12n, 12n, 12n], 'the root, then each successor, four balances each');
  const booked = read.reserves.filter((r) => r.original + r.charged > 0n).map((r) => [r.tokenId, r.sourceId, r.currency, r.original, r.charged]);
  assert.deepEqual(booked, [
    [100n, chain.sourceOf(100n, 0), BASE, 1_250_000n, 0n],
    [100n, chain.sourceOf(100n, 1), BASE, 0n, 40n],
    [100n, chain.sourceOf(100n, 1), QUOTE, 7n * 10n ** 15n, 0n],
    [11n, chain.sourceOf(11n, 0), BASE, 5n, 0n],
  ]);
  const asked = w.calls.filter((c) => c.method === 'eth_call').map((c) => c.params[0].to.toLowerCase());
  assert.ok(!asked.includes(chain.release.deployment.positionManager), 'the root NFT is never read: a burned or moved root changes nothing here');
  assert.deepEqual([...new Set(w.calls.map((c) => c.method))].sort(), ['eth_accounts', 'eth_call', 'eth_chainId', 'eth_getBlockByNumber', 'eth_getCode'], 'reads only');
});

test('ownedVaults lists every vault the wallet created, newest first, from the factory’s nonce alone', async () => {
  const chain = chainWith(), w = wallet(chain), client = clientOf(chain, w);
  assert.deepEqual(await client.ownedVaults(), { vaults: [chain.vaults[1], chain.vaults[0]], older: false });
  // A wallet that created no vault, most wallets: the factory's nonce, one read, and nothing more.
  const none = fakeSequenceChain(OWNER, { roots: [] }), nobody = wallet(none);
  assert.deepEqual(await clientOf(none, nobody).ownedVaults(), { vaults: [], older: false });
  assert.deepEqual(nobody.calls.filter((c) => c.method === 'eth_call' || c.method === 'eth_getCode').map((c) => c.method), ['eth_call']);
});

test('withdraw-fees sends exactly withdrawFeeReserves(source, currency, original, charged) to the vault, once, and the vault pays it', async () => {
  const chain = chainWith(), w = wallet(chain), client = clientOf(chain, w);
  const vault = chain.vaults[0];
  const [first] = (await client.feeReserves(vault)).reserves.filter((r) => r.original + r.charged > 0n);
  const step = await client.recover(vault, 'withdraw-fees', GAS, first);
  assert.equal(step.transaction.to, vault);
  assert.equal(step.transaction.value, '0x0');
  assert.deepEqual(decoded(step.transaction.data), { functionName: 'withdrawFeeReserves', args: [first.sourceId, BASE, 1_250_000n, 0n] });
  const hash = await client.send(step, true);
  assert.equal(chain.sends.length, 1);
  assert.equal((await client.receipt(hash)).state, 'finalized');
  assert.deepEqual(chain.balanceOf(0, 100n, 0, 'base'), { original: 0n, charged: 0n });
  // The same reviewed step can never be sent again.
  await assert.rejects(client.send(step, true), /review_required/);
  assert.equal(chain.sends.length, 1, 'never sent twice');
  // A second withdrawal of what is gone is refused before anything is prepared.
  await assert.rejects(client.recover(vault, 'withdraw-fees', GAS, first), /fee_reserve_insufficient/);
});

test('a withdrawal the person declines frees its nonce, and the next press sends it once', async () => {
  const chain = chainWith(), w = wallet(chain), client = clientOf(chain, w);
  const vault = chain.vaults[0];
  const [first] = (await client.feeReserves(vault)).reserves.filter((r) => r.original > 0n);
  chain.refuseNextSend();
  await assert.rejects(client.send(await client.recover(vault, 'withdraw-fees', GAS, first), true), (error) => error.code === 4001);
  assert.equal(chain.sends.length, 0);
  assert.equal(w.journal.offered(OWNER, 0n), false, 'a refusal proves nothing was sent: the nonce is free');
  await client.send(await client.recover(vault, 'withdraw-fees', GAS, first), true);
  assert.equal(chain.sends.length, 1);
});

test('a withdrawal whose wallet answer was lost holds its nonce: the next press is refused before the wallet, and nothing is sent twice', async () => {
  const chain = chainWith(), w = wallet(chain), client = clientOf(chain, w);
  const vault = chain.vaults[0];
  const [first] = (await client.feeReserves(vault)).reserves.filter((r) => r.original > 0n);
  chain.dropNextSend();
  await assert.rejects(client.send(await client.recover(vault, 'withdraw-fees', GAS, first), true), (error) => error.code === -32603);
  assert.equal(w.journal.offered(OWNER, 0n), true, 'the outcome is unknown: the nonce stays latched');
  const sendsBefore = w.calls.filter((c) => c.method === 'eth_sendTransaction').length;
  await assert.rejects(client.recover(vault, 'withdraw-fees', GAS, first), /wallet_request_open/);
  assert.equal(w.calls.filter((c) => c.method === 'eth_sendTransaction').length, sendsBefore, 'the wallet is not asked again');
});

test('one batch withdraws every balance at once: the exact calls, a latch while the wallet holds it, and the vault read for what it did', async () => {
  const chain = chainWith({ atomic: 'supported' }), w = wallet(chain), client = clientOf(chain, w);
  const vault = chain.vaults[0];
  const rows = (await client.feeReserves(vault)).reserves.filter((r) => r.original + r.charged > 0n).map(({ sourceId, currency, original, charged }) => ({ sourceId, currency, original, charged }));
  assert.equal(rows.length, 4);
  // A batch takes two rows or more, never the same balance twice.
  await assert.rejects(client.prepareWithdrawBatch(vault, rows.slice(0, 1), GAS), /invalid_fee_withdrawal/);
  await assert.rejects(client.prepareWithdrawBatch(vault, [rows[0], rows[0]], GAS), /invalid_fee_withdrawal/);
  await assert.rejects(client.prepareWithdrawBatch(vault, [rows[0], { ...rows[1], original: rows[1].original + 1n }], GAS), /fee_reserve_insufficient/);
  chain.holdNext();
  const prepared = await client.prepareWithdrawBatch(vault, rows, GAS);
  assert.deepEqual(prepared.calls.map((call) => [call.to, call.value, decoded(call.data).args]), rows.map((row) => [vault, '0x0', [row.sourceId, row.currency, row.original, row.charged]]));
  const id = await client.sendWithdrawBatch(prepared, true);
  assert.equal(chain.batches.length, 1);
  assert.deepEqual([chain.batches[0].atomicRequired, chain.batches[0].chainId, chain.batches[0].from], [true, '0x1237', OWNER]);
  await assert.rejects(client.sendWithdrawBatch(prepared, true), /review_required/, 'a prepared batch is offered once');
  // Held by the wallet: a new preparation of the same withdrawal is refused, and nothing is offered again.
  assert.deepEqual(await client.withdrawBatchStatus(id, prepared), { state: 'pending' });
  await assert.rejects(client.prepareWithdrawBatch(vault, rows, GAS), /batch_already_offered/);
  assert.equal(chain.batches.length, 1);
  // The wallet includes it: the vault paid every row, and the batch reads withdrawn. This stand-in sends each call as a
  // transaction of its own and its status names none, so no one transaction is named for it.
  for (const call of chain.batches[0].calls) await chain.request('eth_sendTransaction', [{ from: OWNER, to: call.to, data: call.data, value: '0x0' }]);
  chain.batches[0].status = 200;
  assert.deepEqual(await client.withdrawBatchStatus(id, prepared), { state: 'withdrawn', hash: null });
  assert.equal(w.journal.batchOffered(OWNER, prepared.key), null, 'the latch is freed once it is known');
  assert.ok((await client.feeReserves(vault)).reserves.every((r) => r.original + r.charged === 0n), 'nothing is left in the vault');
});

test('a batch the wallet did not include frees its latch, and says so', async () => {
  const chain = chainWith({ atomic: 'supported' }), w = wallet(chain), client = clientOf(chain, w);
  const vault = chain.vaults[0];
  const rows = (await client.feeReserves(vault)).reserves.filter((r) => r.original + r.charged > 0n).map(({ sourceId, currency, original, charged }) => ({ sourceId, currency, original, charged }));
  chain.holdNext();
  const prepared = await client.prepareWithdrawBatch(vault, rows, GAS);
  const id = await client.sendWithdrawBatch(prepared, true);
  chain.batches[0].status = 400;
  assert.deepEqual(await client.withdrawBatchStatus(id, prepared), { state: 'dropped' });
  assert.equal(w.journal.batchOffered(OWNER, prepared.key), null);
  assert.equal(chain.withdrawals.length, 0, 'nothing was paid');
});

// ---- The review of the fee withdrawal (2026-10-02) ----

const ownerWord = `0x${'0'.repeat(24)}${OWNER.slice(2)}`;
const rowsOf = (read) => model.withdrawals(read);
const sinceOf = (read) => ({ block: read.blockNumber, stateNonce: read.stateNonce });

test('the vault’s record is the event withdrawFeeReserves alone emits, as the contract declares it', () => {
  const source = readFileSync(join(APP, '../contracts/src/DominoVaultV4.sol'), 'utf8');
  assert.match(source, /event FeeReservesWithdrawn\(\s*bytes32 indexed sourceId,\s*address indexed currency,\s*address indexed owner,\s*uint128 originalAmount,\s*uint128 chargedAmount,\s*uint64 stateNonce\s*\);/);
  assert.match(source, /emit FeeReservesWithdrawn\(sourceId, currency, owner, originalAmount, chargedAmount, stateNonce\);/);
  assert.equal(source.match(/emit FeeReservesWithdrawn\(/g).length, 1, 'emitted by withdrawFeeReserves only');
  assert.equal(sequence.FEE_RESERVES_WITHDRAWN, toEventSelector('event FeeReservesWithdrawn(bytes32 indexed sourceId, address indexed currency, address indexed owner, uint128 originalAmount, uint128 chargedAmount, uint64 stateNonce)'));
  assert.ok(sequence.RECORD_SPAN_BLOCKS < 100_000n, 'under the chain RPC’s limit for any filter shape');
});

test('finding 1: a step the wallet sped up is proved by the vault’s own record, under the transaction that took its place, though fees credited meanwhile left a balance', async () => {
  const chain = chainWith(), w = wallet(chain), client = clientOf(chain, w);
  const vault = chain.vaults[0];
  const read = await client.feeReserves(vault);
  const [row] = rowsOf(read);
  chain.speedUpNext('withdrawFeeReserves');
  const hash = await client.send(await client.recover(vault, 'withdraw-fees', GAS, row), true);
  assert.equal((await client.receipt(hash)).state, 'replaced', 'the hash the page was given was never included');
  // An automation run credited new fees to the same balance since: it is above zero, and the withdrawal still happened.
  chain.automationRun(0, [{ tokenId: 100n, source: 0, currency: 'base', original: 9n }]);
  assert.deepEqual(chain.balanceOf(0, 100n, 0, 'base'), { original: 9n, charged: 0n });
  const [record] = await client.withdrawalRecord(vault, [row], sinceOf(read));
  assert.ok(record, 'found');
  assert.equal(record.transactionHash, chain.vaultLogs[0].transactionHash, 'the transaction that paid');
  assert.notEqual(record.transactionHash, hash, 'never the replaced hash');
  assert.ok(record.stateNonce > read.stateNonce);
  // One read of the vault's own logs: one value in each place, from the block read before the send to the one read now.
  const asked = w.calls.filter((c) => c.method === 'eth_getLogs');
  assert.deepEqual(asked.map((c) => c.params), [[{ address: vault, topics: [sequence.FEE_RESERVES_WITHDRAWN, null, null, ownerWord], fromBlock: '0x10', toBlock: '0x10' }]]);
  assert.equal(chain.sends.length, 1, 'nothing sent again');
});

test('finding 1: a step the wallet cancelled while an automation run spent its balance is never taken for a withdrawal', async () => {
  const chain = chainWith(), w = wallet(chain), client = clientOf(chain, w);
  const vault = chain.vaults[0];
  const read = await client.feeReserves(vault);
  const [row] = rowsOf(read);
  chain.cancelNextInWallet('withdrawFeeReserves', () => chain.automationRun(0, [{ tokenId: 100n, source: 0, currency: 'base', original: 0n }]));
  const hash = await client.send(await client.recover(vault, 'withdraw-fees', GAS, row), true);
  assert.equal((await client.receipt(hash)).state, 'replaced');
  // What the old rule read as withdrawn: the balance is gone, and the state nonce moved. The automation reinvested it.
  assert.deepEqual(chain.balanceOf(0, 100n, 0, 'base'), { original: 0n, charged: 0n });
  assert.ok((await client.feeReserves(vault)).stateNonce > read.stateNonce);
  assert.deepEqual(await client.withdrawalRecord(vault, [row], sinceOf(read)), [null], 'the vault never paid it to the wallet');
  assert.deepEqual([chain.withdrawals.length, chain.vaultLogs.length], [0, 0]);
});

test('finding 1: a record counts only for exactly the reviewed row, after the read, in a block still on the chain', async () => {
  const chain = chainWith(), w = wallet(chain), client = clientOf(chain, w);
  const vault = chain.vaults[0];
  const read = await client.feeReserves(vault);
  const [row, other] = rowsOf(read);
  await client.send(await client.recover(vault, 'withdraw-fees', GAS, row), true);
  assert.equal((await client.withdrawalRecord(vault, [row, other], sinceOf(read)))[0].transactionHash, chain.vaultLogs[0].transactionHash);
  assert.equal((await client.withdrawalRecord(vault, [row, other], sinceOf(read)))[1], null, 'another balance has none');
  const after = await client.feeReserves(vault);
  assert.deepEqual(await client.withdrawalRecord(vault, [row], sinceOf(after)), [null], 'a withdrawal the read already showed is not this one');
  assert.deepEqual(await client.withdrawalRecord(vault, [{ ...row, original: row.original - 1n }], sinceOf(read)), [null], 'other amounts are another withdrawal');
  assert.deepEqual(await client.withdrawalRecord(vault, [{ ...row, currency: QUOTE }], sinceOf(read)), [null], 'another currency');
  chain.vaultLogs[0].removed = true;
  assert.deepEqual(await client.withdrawalRecord(vault, [row], sinceOf(read)), [null], 'a log the node took back');
  chain.vaultLogs[0].removed = false;
  chain.vaultLogs[0].blockHash = `0x${'ab'.repeat(32)}`;
  assert.deepEqual(await client.withdrawalRecord(vault, [row], sinceOf(read)), [null], 'a record in a block that left the chain');
  // A node behind the block read before the send is not asked, and finds nothing.
  const logsBefore = w.calls.filter((c) => c.method === 'eth_getLogs').length;
  assert.deepEqual(await client.withdrawalRecord(vault, [row], { block: 0x20n, stateNonce: read.stateNonce }), [null]);
  assert.equal(w.calls.filter((c) => c.method === 'eth_getLogs').length, logsBefore);
});

test('finding 1: a batch the wallet no longer answers for is withdrawn only by the vault’s record of every row in one transaction', async () => {
  // The wallet forgot the batch, and an automation run moved the state nonce and spent every balance it named.
  {
    const chain = chainWith({ atomic: 'supported' }), w = wallet(chain), client = clientOf(chain, w);
    const vault = chain.vaults[0];
    const rows = rowsOf(await client.feeReserves(vault));
    chain.holdNext();
    const prepared = await client.prepareWithdrawBatch(vault, rows, GAS);
    assert.equal(prepared.block, 0x10n);
    const id = await client.sendWithdrawBatch(prepared, true);
    chain.batches[0].forgotten = true;
    chain.automationRun(0, RESERVES.map((r) => ({ ...r, original: 0n, charged: 0n })));
    assert.deepEqual(await client.withdrawBatchStatus(id, prepared), { state: 'unknown' }, 'never said withdrawn');
    assert.equal(chain.withdrawals.length, 0);
  }
  // The wallet ran it whole and then forgot it: the vault's record names every row, in the one transaction that carried it.
  {
    const chain = chainWith({ atomic: 'supported' }), w = wallet(chain), client = clientOf(chain, w);
    const vault = chain.vaults[0];
    const rows = rowsOf(await client.feeReserves(vault));
    const prepared = await client.prepareWithdrawBatch(vault, rows, GAS);
    const id = await client.sendWithdrawBatch(prepared, true);
    assert.equal(chain.batches[0].status, 200);
    chain.batches[0].forgotten = true;
    assert.deepEqual(await client.withdrawBatchStatus(id, prepared), { state: 'withdrawn', hash: chain.batches[0].transactionHash });
  }
});

test('finding 4: a batch the wallet confirmed names the transaction its receipt carries; one with no receipt, the vault’s record’s', async () => {
  const chain = chainWith({ atomic: 'supported' }), w = wallet(chain), client = clientOf(chain, w);
  const vault = chain.vaults[0];
  const rows = rowsOf(await client.feeReserves(vault));
  const prepared = await client.prepareWithdrawBatch(vault, rows, GAS);
  const id = await client.sendWithdrawBatch(prepared, true);
  const named = chain.batches[0].transactionHash;
  assert.match(named, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(await client.withdrawBatchStatus(id, prepared), { state: 'withdrawn', hash: named });
  assert.equal(w.calls.filter((c) => c.method === 'eth_getLogs').length, 0, 'the wallet named it: no log read');
  chain.batches[0].unnamed = true;
  assert.deepEqual(await client.withdrawBatchStatus(id, prepared), { state: 'withdrawn', hash: named }, 'from the vault’s record');
  // What a status reply's receipts say: one transaction named by all of them, or none.
  const reply = (receipts) => async () => ({ status: 200, receipts });
  const A = `0x${'aB'.repeat(32)}`, B = `0x${'cd'.repeat(32)}`;
  assert.deepEqual(await batch.batchCallsState(reply([{ transactionHash: A }, { transactionHash: A.toLowerCase() }]), '0x1'), { status: 200, transactionHash: A.toLowerCase() });
  assert.deepEqual(await batch.batchCallsState(reply([{ transactionHash: A }, { transactionHash: B }]), '0x1'), { status: 200, transactionHash: null });
  assert.deepEqual(await batch.batchCallsState(reply([]), '0x1'), { status: 200, transactionHash: null });
  assert.deepEqual(await batch.batchCallsState(reply(undefined), '0x1'), { status: 200, transactionHash: null });
  assert.deepEqual(await batch.batchCallsState(reply([{ transactionHash: '0x12' }]), '0x1'), { status: 200, transactionHash: null });
  assert.equal(await batch.batchCallsState(reply([]), ''), null);
});

test('findings 2 and 6: every vault the wallet created is listed, past the sixteen newest, up to RESERVE_VAULT_CAP', async () => {
  const roots = Array.from({ length: 17 }, (_, i) => BigInt(100 + i));
  const chain = fakeSequenceChain(OWNER, { roots, settled: true }), w = wallet(chain), client = clientOf(chain, w);
  const listed = await client.ownedVaults();
  assert.equal(listed.vaults.length, 17);
  assert.deepEqual(listed.vaults, [...chain.vaults].reverse(), 'newest first, the oldest included');
  assert.equal(listed.older, false);
  assert.equal(sequence.RESERVE_VAULT_PAGE, 16);
  // Past the cap: the newest RESERVE_VAULT_CAP, and `older` says there are more.
  const many = fakeSequenceChain(OWNER, { roots: Array.from({ length: sequence.RESERVE_VAULT_CAP + 1 }, (_, i) => BigInt(i + 1)), settled: true });
  const most = await clientOf(many, wallet(many)).ownedVaults();
  assert.equal(most.vaults.length, sequence.RESERVE_VAULT_CAP);
  assert.equal(most.vaults[0], many.vaults.at(-1));
  assert.equal(most.older, true);
});

test('finding 3: a chain of members longer than one read is walked in pages, and a member far down it keeps its reserves', async () => {
  const members = Array.from({ length: 40 }, (_, i) => ({ id: BigInt(1000 + i), active: i % 3 === 0 }));
  const chain = fakeSequenceChain(OWNER, { roots: [100n], chains: { 0: members }, settled: true, rootPermissionValid: false,
    reserves: { 0: [{ tokenId: 100n, source: 0, currency: 'base', original: 4n }, { tokenId: 1035n, source: 1, currency: 'quote', original: 77n, charged: 3n }] } });
  const w = wallet(chain), client = clientOf(chain, w);
  const vault = chain.vaults[0];
  const first = await client.feeReserves(vault);
  assert.equal(first.reserves.length, 4 * (sequence.SEQUENCE_MEMBER_STEPS + 1), 'one read: the root and SEQUENCE_MEMBER_STEPS successors');
  assert.deepEqual([first.last, first.next], [1029n, 1030n], 'where it stopped');
  const all = await sequence.walkFeeReserves(client, vault);
  assert.equal(all.reserves.length, 4 * 41);
  assert.equal(all.next, 0n, 'every member read');
  assert.deepEqual(rowsOf(all), [
    { sourceId: chain.sourceOf(100n, 0), currency: BASE, original: 4n, charged: 0n },
    { sourceId: chain.sourceOf(1035n, 1), currency: QUOTE, original: 77n, charged: 3n },
  ]);
  assert.deepEqual([all.blockNumber, all.stateNonce], [first.blockNumber, first.stateNonce], 'as of the first page');
  // Fewer pages than the chain: what was read, and where the rest starts.
  const part = await sequence.walkFeeReserves(client, vault, 1);
  assert.equal(part.next, 1030n);
  // A further read must start where the one before stopped: a member whose parent is not the one named is refused.
  await assert.rejects(client.feeReserves(vault, { tokenId: 1030n, parent: 1028n }), /invalid_position_identity/);
  await assert.rejects(client.feeReserves(vault, { tokenId: 100n, parent: 1n }), /invalid_position_identity/, 'the root is no successor');
  // The member far down the chain is withdrawn as any other.
  const step = await client.recover(vault, 'withdraw-fees', GAS, rowsOf(all)[1]);
  assert.deepEqual(decoded(step.transaction.data).args, [chain.sourceOf(1035n, 1), QUOTE, 77n, 3n]);
});

test('finding 5: the V1 release this build ships for recovery is the published record, parsed as strictly, and marked expired', () => {
  const docs = JSON.parse(readFileSync(join(APP, '../docs/deployments/v1-robinhood-mainnet-2026-09-21/sequence-release.json'), 'utf8'));
  assert.deepEqual(JSON.parse(JSON.stringify(pin.SEQUENCE_RECOVERY_RECORD)), docs, 'the committed record, exactly');
  assert.equal(pin.SEQUENCE_RECOVERY_RECORD.deployment.factory, pin.SEQUENCE_FACTORY);
  assert.equal(pin.SEQUENCE_RECOVERY_RECORD.deployment.positionManager, pin.POSITION_MANAGER);
  const recovery = sequence.recoveryDeployment();
  assert.ok(recovery && Object.isFrozen(recovery));
  assert.equal(recovery.expiresAt, 0, 'expired: it reads and recovers, and can never prepare an approval, a creation or a Turn on');
  assert.deepEqual({ ...recovery, expiresAt: docs.deployment.expiresAt }, sequence.sequenceDeploymentFrom(docs, 0));
  // Anything else is none.
  assert.equal(sequence.recoveryDeployment({ ...docs, available: false, deployment: null }), null);
  assert.equal(sequence.recoveryDeployment({ ...docs, deployment: { ...docs.deployment, factory: docs.deployment.implementation } }), null);
  assert.equal(sequence.recoveryDeployment('nothing'), null);
});

test('finding 5: a client over an expired recovery deployment still finds and withdraws fees, and still refuses a creation', async () => {
  const chain = chainWith(), w = wallet(chain);
  const client = sequence.createSequenceClient(w.rpc, { ...chain.release.deployment, expiresAt: 0 }, () => Date.now() / 1000, async () => null);
  const vault = chain.vaults[0];
  assert.deepEqual((await client.ownedVaults()).vaults, [chain.vaults[1], chain.vaults[0]]);
  const [row] = rowsOf(await client.feeReserves(vault));
  await client.send(await client.recover(vault, 'withdraw-fees', GAS, row), true);
  assert.equal(chain.withdrawals.length, 1);
  await assert.rejects(client.create({ automationMode: 'compound', rootTokenId: 5n, baseIsCurrency0: true, consentToUncollectedFees: true, triggerDistanceBps: 500, maxOverlapBps: 2000,
    minimumIntervalSeconds: 60, maxPositions: 1, upsideBps: 5000, maxSlippageBps: 100, maxPriceImpactBps: 100, maxGasCostWei: 10n ** 15n, maxObservationAgeSeconds: 60, forecastHorizonSeconds: 3600 }, GAS), /sequence_release_expired/);
});

test('finding 8: a screen keeps each vault’s last good read through reads that fail, reads the pages after the first next, and asks failed vaults again for as long as it is open', () => {
  const A = `0x${'a1'.repeat(20)}`, B = `0x${'b2'.repeat(20)}`, C = `0x${'c3'.repeat(20)}`;
  const v = (vault, amount) => ({ vault, reserves: [line(1n, '0x01', BASE, amount)] });
  const amounts = (held) => model.heldVaults(held).map((x) => [x.vault, x.reserves[0].original]);
  let held = model.holdReserves(null, { order: [A, B, C], vaults: [v(A, 1n), v(B, 2n)], failed: [], unread: [C], beyond: false });
  assert.deepEqual(model.nextReserveRead(held, 16), { vaults: [C], again: false }, 'the next page, at once');
  assert.equal(model.stillChecking(held), 1);
  held = model.holdMore(held, [C], { vaults: [v(C, 3n)], failed: [] });
  assert.equal(model.nextReserveRead(held, 16), null);
  assert.deepEqual(amounts(held), [[A, 1n], [B, 2n], [C, 3n]], 'newest first, the oldest included');
  // A withdrawal from A: the first page read again, and B's read fails this time. B stays, as last read.
  held = model.holdReserves(held, { order: [A, B, C], vaults: [v(A, 0n)], failed: [B], unread: [C], beyond: false });
  assert.deepEqual(amounts(held), [[A, 0n], [B, 2n], [C, 3n]]);
  assert.deepEqual(model.nextReserveRead(held, 16), { vaults: [C], again: false }, 'the pages not read again come first');
  held = model.holdMore(held, [C], { vaults: [v(C, 3n)], failed: [] });
  assert.deepEqual(model.nextReserveRead(held, 16), { vaults: [B], again: true }, 'then the vault that failed, after a wait');
  assert.equal(model.stillChecking(held), 0, 'B is on screen: nothing unseen');
  held = model.holdMore(held, [B], { vaults: [], failed: [B] });
  assert.deepEqual([held.failed, amounts(held)], [[B], [[A, 0n], [B, 2n], [C, 3n]]], 'failed again: still there');
  held = model.holdMore(held, [B], { vaults: [v(B, 5n)], failed: [] });
  assert.deepEqual([held.failed, amounts(held)], [[], [[A, 0n], [B, 5n], [C, 3n]]]);
  // A vault never read whose read fails is still being checked; one the factory no longer lists is let go.
  const fresh = model.holdReserves(null, { order: [A, B], vaults: [v(A, 1n)], failed: [B], unread: [], beyond: true });
  assert.equal(model.stillChecking(fresh), 1);
  assert.equal(fresh.beyond, true);
  assert.deepEqual(model.heldVaults(model.holdReserves(held, { order: [A], vaults: [], failed: [], unread: [], beyond: false })).map((x) => x.vault), [A]);
  // Asked again for as long as the page is open, ever more slowly, never given up; the pages after the first follow
  // sooner, one short gap apart, so many vaults' reads are spread out rather than sent back to back.
  assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map(model.reserveReaskMs), [3_000, 12_000, 30_000, 60_000, 120_000, 120_000, 120_000]);
  assert.ok(model.RESERVE_PAGE_GAP_MS > 0 && model.RESERVE_PAGE_GAP_MS < model.reserveReaskMs(0));
});
