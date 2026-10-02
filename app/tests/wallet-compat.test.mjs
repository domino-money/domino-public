/**
 * Wallet compatibility quirks, as pure functions (2026-10-01, the audit's items C1-C16 and H5). The browser suites
 * (session.browser.test.mjs, finance.browser.test.mjs) drive the same quirks through the real dialog and Review.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const wellFormed = require('../.test-build/app/src/wallet/wellFormed.js');
const { ADD_ROBINHOOD_CHAIN } = require('../.test-build/app/src/wallet/chain.js');
const { DOC_PAGES } = require('../.test-build/app/src/lib/docs/registry.js');

// C12: Safari and iOS WebViews before 16.4 and Chrome before 111 have no String#isWellFormed, which the session
// runtime calls on every sign-in message; without it the wallet feature never started.
test('the well-formed string methods follow the specification on every surrogate shape', () => {
  const cases = [
    ['', true, ''],
    ['abc', true, 'abc'],
    ['a😀b', true, 'a😀b'],
    ['\uD800', false, '�'],
    ['\uDC00', false, '�'],
    ['a\uD800b', false, 'a�b'],
    ['\uD800𐀀', false, '�𐀀'],
    ['𐀀\uDC00', false, '𐀀�'],
    ['\uDC00\uD800', false, '��'],
  ];
  for (const [text, formed, fixed] of cases) {
    assert.equal(wellFormed.isWellFormed(text), formed, JSON.stringify(text));
    assert.equal(wellFormed.toWellFormed(text), fixed, JSON.stringify(text));
    // The engine running these tests has the native methods: the same answers.
    assert.equal(text.isWellFormed(), formed);
    assert.equal(text.toWellFormed(), fixed);
  }
});

test('installed only where missing, as non-enumerable methods, and false on a prototype that refuses them', () => {
  const bare = {};
  assert.equal(wellFormed.installWellFormed(bare), true);
  assert.deepEqual(Object.keys(bare), [], 'not enumerable');
  assert.equal(bare.isWellFormed.call('a\uD800'), false);
  assert.equal(bare.toWellFormed.call('a\uD800'), 'a�');
  assert.throws(() => bare.isWellFormed.call(null), TypeError);
  const native = { isWellFormed() { return 'native'; }, toWellFormed() { return 'native'; } };
  assert.equal(wellFormed.installWellFormed(native), true);
  assert.equal(native.isWellFormed(), 'native', 'a native method is never replaced');
  assert.equal(wellFormed.installWellFormed(Object.freeze({})), false);
  // The real prototype keeps its native methods.
  const before = String.prototype.isWellFormed;
  assert.equal(wellFormed.installWellFormed(), true);
  assert.equal(String.prototype.isWellFormed, before);
});

// ---- error codes through wallets' wrappers (C1) -------------------------------------------------------------------

const { codesOf } = require('../.test-build/app/src/wallet/codes.js');

test('every code a wallet error carries is found, wrapped or not: MetaMask Mobile hides its 4902 under data.originalError', () => {
  assert.deepEqual(codesOf({ code: 4902, message: 'Unrecognized chain ID' }), [4902]);
  assert.deepEqual(codesOf({ code: -32603, message: 'Internal JSON-RPC error.', data: { originalError: { code: 4902 } } }), [-32603, 4902]);
  assert.deepEqual(codesOf(Object.assign(new Error('viem'), { cause: { code: 4001 } })), [4001]);
  assert.deepEqual(codesOf({ error: { code: -32002 } }), [-32002]);
  assert.deepEqual(codesOf(new Error('no code')), []);
  assert.deepEqual(codesOf(null), []);
});

// ---- what the browser remembers of the wallet connection (C11) -----------------------------------------------------

const { walletMemory, MEMORY_KEY } = require('../.test-build/app/src/wallet/memory.js');
function memoryStore() {
  const map = new Map();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

test('the wallet memory keeps wallet ids only: which were disconnected here and which connected last, never an address', () => {
  const store = memoryStore();
  const memory = walletMemory(() => store);
  assert.equal(memory.recent(), null);
  memory.connected('io.metamask');
  assert.equal(memory.recent(), 'io.metamask');
  memory.disconnectedAll(['io.metamask', 'io.rabby']);
  assert.equal(memory.disconnected('io.metamask'), true);
  assert.equal(memory.disconnected('io.rabby'), true);
  assert.equal(memory.disconnected('walletConnect'), false);
  // Connecting a wallet again ends its disconnect, and only its own.
  memory.connected('io.rabby');
  assert.equal(memory.disconnected('io.rabby'), false);
  assert.equal(memory.disconnected('io.metamask'), true);
  assert.equal(memory.recent(), 'io.rabby');
  assert.deepEqual([...store.map.keys()], [MEMORY_KEY]);
  assert.equal(MEMORY_KEY, 'domino.wallet.v1');
  // Nothing that looks like an address is ever written, even when asked to.
  memory.connected('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  memory.disconnectedAll(['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', 'x'.repeat(200), '']);
  const written = store.map.get(MEMORY_KEY);
  assert.doesNotMatch(written, /0x[0-9a-fA-F]{6,}/);
  assert.deepEqual(JSON.parse(written), { recent: 'io.rabby', disconnected: ['io.metamask'] });
  // A broken entry, or storage that refuses everything, is a browser that remembers nothing.
  store.map.set(MEMORY_KEY, '{not json');
  assert.equal(memory.recent(), null);
  const refusing = walletMemory(() => ({ getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {} }));
  refusing.connected('io.metamask');
  assert.equal(refusing.recent(), null);
  assert.equal(walletMemory(() => null).disconnected('io.metamask'), false);
  // Bounded.
  const many = walletMemory(() => store);
  many.disconnectedAll(Array.from({ length: 40 }, (_, i) => `wallet.n${i}`));
  assert.ok(JSON.parse(store.map.get(MEMORY_KEY)).disconnected.length <= 16);
});

// ---- the nonce latch: refusals, reloads, age and the person's word (C2) --------------------------------------------

const { createNonceJournal, definiteRefusal, personRefused } = require('../.test-build/app/src/finance/nonce.js');
const setup = require('../.test-build/app/src/finance/setup.js');
const { decodeFunctionData, encodeFunctionResult, keccak256, numberToHex, stringToHex } = require('viem');

const LEDGER = Object.assign(new Error('Ledger device: Condition of use not satisfied (denied by the user?) (0x6985)'), { code: -32603 });
test('a refusal that proves nothing was sent is told from an outcome that may have been sent', () => {
  for (const error of [{ code: 4001 }, { code: 4100 }, { code: 4200 }, { code: 4900 }, { code: 4901 }, { code: -32602 }, { code: 5000, message: 'User rejected.' }, LEDGER,
    { code: -32603, message: 'Internal JSON-RPC error.', data: { message: 'MetaMask Tx Signature: User denied transaction signature.' } },
    Object.assign(new Error('wrapped'), { cause: { code: 4001 } })]) {
    assert.equal(definiteRefusal(error), true, String(error.message ?? error.code));
  }
  for (const error of [{ code: -32603, message: 'Internal JSON-RPC error.' }, { code: -32000, message: 'header not found' }, new TypeError('Failed to fetch'),
    new Error('wallet_timeout'), { code: -32603, data: { message: 'Failed to fetch' } }, null, undefined]) {
    assert.equal(definiteRefusal(error), false, String(error?.message ?? error));
  }
  // The person's own refusal, which the page says as "you declined", is narrower: not a wallet that lacks a method.
  assert.equal(personRefused({ code: 4001 }), true);
  assert.equal(personRefused(LEDGER), true);
  assert.equal(personRefused({ code: 5000 }), true);
  assert.equal(personRefused({ code: 4200 }), false);
  assert.equal(personRefused({ code: -32602 }), false);
});

const address = (n) => '0x' + n.toString(16).padStart(40, '0');
const OWNER = address(0xa11ce), TOKEN = address(9), OPERATION = '0x' + 'ab'.repeat(32);
const CODE = '0x6000', CODE_HASH = keccak256(CODE);
const DEPLOYMENT = { setup: address(2), poolManager: address(3), positionManager: address(4), stateView: address(5), feeRecipient: address(6), setupCodeHash: CODE_HASH,
  poolManagerCodeHash: CODE_HASH, positionManagerCodeHash: CODE_HASH, stateViewCodeHash: CODE_HASH, feeBps: 65, tariffVersion: '1', expiresAt: 4_000_000_000 };
const KEY = { currency0: address(0), currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: address(0) };
const NONE = { owner: address(0), key: { currency0: address(0), currency1: address(0), fee: 0, tickSpacing: 0, hooks: address(0) }, balance0: 0n, balance1: 0n, swapped: false, closed: false, tokenId: 0n };
const GAS = { maxGas: 8_000_000n, maxFeePerGas: 20_000_000n, maxPriorityFeePerGas: 0n, reserveWei: 0n };
function journalStorage() {
  const map = new Map();
  return { map, get length() { return map.size; }, key: (i) => [...map.keys()][i] ?? null, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}
/** Web Locks as the journal uses them, with the holds of open pages as a set: clearing it is the page being reloaded. */
function pageLocks() {
  const live = new Set();
  return { live, request: async (_name, fn) => fn(), hold: (name) => { live.add(name); }, letGo: (name) => { live.delete(name); }, held: async (name) => live.has(name) };
}
let uuids = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, '0')}`;

/**
 * Create position's setup client against a stub wallet (modelled on the audit's harnesses, 2026-10-01): ETH and a token,
 * one approval needed. `sendError` is what the wallet answers eth_sendTransaction with; `hang` leaves it unanswered;
 * `fail` makes a method fail, by what it returns; `read` is the page's own line to the chain.
 */
function world({ storage = journalStorage(), locks = pageLocks(), sendError = null, hang = false, fail = {}, read, state = {} } = {}) {
  const st = { latest: 0, pending: 0, allowance: 0n, operation: NONE, balance: 10n ** 20n, known: new Set(), sent: [], ...state };
  const journal = createNonceJournal(storage, locks, uuid);
  const calls = [];
  const views = () => ({ manager: DEPLOYMENT.poolManager, positions: DEPLOYMENT.positionManager, stateView: DEPLOYMENT.stateView, feeRecipient: DEPLOYMENT.feeRecipient,
    assistedFeeBps: 65, tariffVersion: 1n, nextOperationId: OPERATION, operation: st.operation, ownerNonce: 0n, recoveryStarted: false });
  const answer = (method, params) => {
    switch (method) {
      case 'eth_accounts': return [OWNER];
      case 'eth_chainId': return '0x1237';
      case 'eth_getCode': return params[0] === OWNER ? '0x' : CODE;
      case 'eth_getTransactionCount': return numberToHex(params[1] === 'pending' ? st.pending : st.latest);
      case 'eth_getBalance': return numberToHex(st.balance);
      case 'eth_estimateGas': return '0x10000';
      case 'eth_call': {
        if (params[0].to === OWNER) return '0x';
        if (params[0].to === TOKEN) return encodeFunctionResult({ abi: setup.tokenAbi, functionName: 'allowance', result: st.allowance });
        const call = decodeFunctionData({ abi: setup.setupAbi, data: params[0].data });
        if (['approve', 'open', 'swap', 'mint', 'cancel', 'recoverCurrency'].includes(call.functionName)) return '0x';
        return encodeFunctionResult({ abi: setup.setupAbi, functionName: call.functionName, result: views()[call.functionName] });
      }
      case 'eth_getTransactionByHash': return st.known.has(params[0]) ? st.sent.find((tx) => tx.hash === params[0]) : null;
      case 'eth_getTransactionReceipt': return null;
    }
    throw new Error(`unexpected ${method}`);
  };
  const w = { st, journal, calls, storage, locks };
  w.wallet = {
    owner: OWNER,
    current: () => true,
    nonceOffered: (nonce) => journal.offered(OWNER, nonce),
    claimNonce: (nonce) => journal.claim(OWNER, nonce, 1000),
    releaseRejectedNonce: (nonce, token) => journal.releaseAfterRejection(OWNER, nonce, token),
    settleNonce: (nonce, now, maxAge) => journal.settle(OWNER, nonce, now, maxAge),
    forgetNonce: (nonce) => journal.forget(OWNER, nonce),
    ...(read ? { read } : {}),
    request: async (method, params) => {
      calls.push(method);
      if (w.override) {
        const answered = await w.override(method, params);
        if (answered !== undefined) return answered;
      }
      const error = fail[method]?.(params);
      if (error) throw error;
      if (method === 'eth_sendTransaction') {
        // Unanswered until the test lets it go (w.prompt), so no timer outlives the test.
        if (hang) return new Promise((resolve, reject) => { w.prompt = { resolve, reject }; });
        if (sendError) throw sendError;
        const tx = { ...params[0], hash: '0x' + String(st.sent.length + 1).padStart(64, 'e'), input: params[0].data, nonce: params[0].nonce };
        st.sent.push(tx);
        st.known.add(tx.hash);
        return tx.hash;
      }
      return answer(method, params);
    },
  };
  w.client = (now = () => 1000) => setup.createSetupClient(w.wallet, DEPLOYMENT, now, async () => DEPLOYMENT, {});
  w.sends = () => calls.filter((m) => m === 'eth_sendTransaction').length;
  return w;
}
const press = (w, now) => w.client(now).fund(KEY, 10n ** 15n, 10n ** 18n, GAS);
/** Starts a send whose prompt the wallet never answers, and returns once the prompt is open. */
async function openPrompt(w) {
  const client = w.client();
  const step = await client.fund(KEY, 10n ** 15n, 10n ** 18n, GAS);
  void client.send(step, true).catch(() => {});
  for (let i = 0; i < 100 && w.sends() === 0; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(w.sends(), 1, 'the prompt opened');
}

test('every refusal that proves nothing was sent lets the nonce go at once; an outcome that may have been sent keeps it; nothing is sent twice', async () => {
  for (const [error, freed] of [[{ code: 4001, message: 'User rejected the request.' }, true], [LEDGER, true], [{ code: -32602, message: 'Invalid transaction params' }, true],
    [{ code: 4100, message: 'Unauthorized' }, true], [{ code: 4900, message: 'Disconnected' }, true], [{ code: 5000, message: 'User rejected.' }, true],
    [{ code: -32603, message: 'Internal JSON-RPC error.' }, false], [{ code: -32000, message: 'header not found' }, false]]) {
    const label = `${error.code} ${error.message}`;
    const w = world({ sendError: error instanceof Error ? error : Object.assign(new Error(error.message), error) });
    const client = w.client();
    const step = await client.fund(KEY, 10n ** 15n, 10n ** 18n, GAS);
    assert.equal(step.kind, 'approve');
    await assert.rejects(client.send(step, true));
    assert.equal(w.journal.offered(OWNER, 0n), !freed, label);
    if (freed) assert.equal((await press(w)).kind, 'approve', `${label}: the next press prepares at once`);
    else {
      // The page that offered it is still open: held, said as a request still open in the wallet (the audit's harness
      // said "pending_wallet_transaction" here, and every later press too, for good).
      await assert.rejects(press(w), /wallet_request_open/, label);
      // After a reload (its lock gone) and with nothing pending on chain, the next press prepares.
      w.locks.live.clear();
      assert.equal((await press(w)).kind, 'approve', `${label}: let go after the reload`);
    }
    assert.equal(w.sends(), 1, `${label}: one offer, never resent`);
  }
});

test('a reload during the prompt: a latch whose page is still open holds, one whose page is gone is let go once the chain shows nothing pending', async () => {
  const w = world({ hang: true });
  await openPrompt(w);
  assert.equal(w.journal.offered(OWNER, 0n), true);
  assert.equal(w.locks.live.size, 1, 'the page holds the offer while it is open');
  // Same page, or another tab, while the first page is open: a request still open in the wallet, never a second prompt.
  await assert.rejects(press(w), /wallet_request_open/);
  // A transaction really pending on chain is said as such, whatever the latch.
  w.st.pending = 1;
  await assert.rejects(press(w), /pending_wallet_transaction/);
  w.st.pending = 0;
  // The page is reloaded: its lock goes with it. Nothing pending on chain, so the next press prepares anew.
  w.locks.live.clear();
  assert.equal((await press(w)).kind, 'approve');
  assert.equal(w.journal.offered(OWNER, 0n), false);
  assert.equal(w.sends(), 1, 'nothing was sent again');
  w.prompt.reject(Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603 }));
});

test('a latch whose page stays open is let go once older than the limit, never before', async () => {
  assert.equal(setup.NONCE_LATCH_EXPIRY_S, 600);
  const w = world({ hang: true });
  await openPrompt(w);
  // Claimed at 1000 (the fixture's clock).
  await assert.rejects(press(w, () => 1000 + setup.NONCE_LATCH_EXPIRY_S), /wallet_request_open/);
  assert.equal((await press(w, () => 1001 + setup.NONCE_LATCH_EXPIRY_S)).kind, 'approve');
  assert.equal(w.locks.live.size, 0, 'its hold is let go with it');
  w.prompt.reject(Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603 }));
  // A latch with no time beside it (claimed before times were kept) starts its clock when it is met, its page open.
  const storage = journalStorage();
  await createNonceJournal(storage, pageLocks(), uuid).claim(OWNER, 0n);
  const open = pageLocks();
  open.held = async () => true;
  const kept = world({ storage, locks: open });
  await assert.rejects(press(kept, () => 5000), /wallet_request_open/);
  await assert.rejects(press(kept, () => 5000 + setup.NONCE_LATCH_EXPIRY_S), /wallet_request_open/);
  assert.equal((await press(kept, () => 5001 + setup.NONCE_LATCH_EXPIRY_S)).kind, 'approve');
});

test('"I rejected it in my wallet" lets the latch go only while nothing is pending, and sends nothing', async () => {
  const w = world({ hang: true });
  await openPrompt(w);
  w.st.pending = 1;
  assert.equal(await setup.forgetOpenRequest(w.wallet), false, 'a transaction is pending: the latch stays');
  assert.equal(w.journal.offered(OWNER, 0n), true);
  w.st.pending = 0;
  assert.equal(await setup.forgetOpenRequest(w.wallet), true);
  assert.equal(w.journal.offered(OWNER, 0n), false);
  assert.equal(w.locks.live.size, 0);
  assert.equal(await setup.forgetOpenRequest(w.wallet), false, 'nothing left to let go');
  assert.equal(w.sends(), 1);
  assert.equal((await press(w)).kind, 'approve', 'the next press prepares and reviews anew');
  w.prompt.reject(Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603 }));
});

test('a batch the wallet never answered, whose page is gone, is let go; one the wallet took is left to its status', async () => {
  const storage = journalStorage(), locks = pageLocks(), journal = createNonceJournal(storage, locks, uuid);
  await journal.claimBatch(OWNER, OPERATION, 1000);
  assert.equal(await journal.expireBatch(OWNER, OPERATION, 1001, 1500), false, 'its page is open');
  locks.live.clear();
  assert.equal(await journal.expireBatch(OWNER, OPERATION, 1001, 1500), true, 'reloaded during the prompt, never answered');
  assert.equal(journal.batchOffered(OWNER, OPERATION), null);
  const again = await journal.claimBatch(OWNER, OPERATION, 1000);
  await journal.recordBatch(OWNER, OPERATION, again, '0xfeed');
  locks.live.clear();
  assert.equal(await journal.expireBatch(OWNER, OPERATION, 1001, 1500), false, 'the wallet has the batch: its status decides');
  assert.equal(journal.batchOffered(OWNER, OPERATION), '0xfeed');
});

// Fix round 1 (2026-10-01): during the rollout a tab of the release before this package may still have a prompt open.
// Its latches hold no lock (and a nonce's has no time beside it), so a missing lock proves nothing about them: they are
// let go by their age alone. A claim of this release marks its time (LIVE_MARK), and only such a latch is let go at once
// when its page is gone.
test('a latch claimed by the release before the lock existed is let go by its age, never for want of a lock', async () => {
  const nonceKey = keccak256(stringToHex(`4663|${OWNER}|0`)).slice(2);
  const batchKey = keccak256(stringToHex(`4663|${OWNER}|${OPERATION}`)).slice(2);
  // A nonce latch as that release wrote it: the claim alone, no time, no lock held by anyone.
  const storage = journalStorage(), locks = pageLocks();
  storage.setItem(`domino.offered-nonce.v1.${nonceKey}`, uuid());
  const old = world({ storage, locks });
  await assert.rejects(press(old, () => 5000), /wallet_request_open/, 'its prompt may still be open in that tab');
  assert.equal(storage.getItem(`domino.offered-nonce-at.v1.${nonceKey}`), '5000', 'its clock starts when it is met, unmarked');
  await assert.rejects(press(old, () => 5000 + setup.NONCE_LATCH_EXPIRY_S), /wallet_request_open/);
  assert.equal((await press(old, () => 5001 + setup.NONCE_LATCH_EXPIRY_S)).kind, 'approve', 'let go by its age');
  assert.equal(old.sends(), 0, 'nothing was sent meanwhile');
  // This release's own claim is marked, and is let go at once once its page is gone.
  const fresh = journalStorage(), freshLocks = pageLocks();
  await createNonceJournal(fresh, freshLocks, uuid).claim(OWNER, 0n, 1000);
  assert.equal(fresh.getItem(`domino.offered-nonce-at.v1.${nonceKey}`), '1000L');
  freshLocks.live.clear();
  assert.equal(await createNonceJournal(fresh, freshLocks, uuid).settle(OWNER, 0n, 1001, 600), true);
  // A batch latch as that release wrote it: a claim and its time (unmarked), never answered, no lock.
  const batches = journalStorage(), none = pageLocks(), journal = createNonceJournal(batches, none, uuid);
  batches.setItem(`domino.offered-batch.v1.${batchKey}`, uuid());
  batches.setItem(`domino.offered-batch-at.v1.${batchKey}`, '1000');
  assert.equal(await journal.expireBatch(OWNER, OPERATION, 1001, 1500), false, 'its prompt may still be open in that tab');
  assert.equal(journal.batchOffered(OWNER, OPERATION), '');
  assert.equal(await journal.expireBatch(OWNER, OPERATION, 2501, 1500), true, 'let go once it can no longer execute');
  // A marked time in the future (a clock set back) starts again now and keeps its mark.
  await journal.claimBatch(OWNER, OPERATION, 9000);
  assert.equal(await journal.expireBatch(OWNER, OPERATION, 3000, 1500), false);
  assert.equal(batches.getItem(`domino.offered-batch-at.v1.${batchKey}`), '3000L');
});

// ---- the wallet's RPC cannot reach the chain (C6) ------------------------------------------------------------------

const FETCH_FAILED = { code: -32603, message: 'Internal JSON-RPC error.', data: { code: -32603, message: 'Failed to fetch' } };
test('a wallet read that failed for want of its RPC is told from a revert and from the person', () => {
  for (const error of [FETCH_FAILED, { code: -32005, message: 'Limit exceeded' }, { code: 429, message: 'Too Many Requests' }, new TypeError('Failed to fetch'), { code: -32000, message: 'request timed out' }]) {
    assert.equal(setup.walletUnreachable(error), true, error.message);
  }
  for (const error of [{ code: 3, message: 'execution reverted', data: '0x08c379a0' }, { code: -32603, message: 'Internal JSON-RPC error.', data: { code: 3, data: '0x1234' } },
    { code: 4001, message: 'User rejected the request.' }, LEDGER, new Error('wallet_identity_changed')]) {
    assert.equal(setup.walletUnreachable(error), false, error.message);
  }
});

test('a pure read the wallet’s own RPC could not answer is asked through the page’s line; still unanswered, it is said as such', async () => {
  const offline = () => ({ ...FETCH_FAILED });
  // Every read the wallet's RPC would answer fails; the page answers them all, from the same chain, and the step is prepared.
  const asked = [];
  const pure = ['eth_call', 'eth_getCode', 'eth_estimateGas', 'eth_getBalance'];
  const truth = world();
  const answering = world({ fail: Object.fromEntries(pure.map((method) => [method, offline])), read: async (method, params) => { asked.push(method); return truth.wallet.request(method, params); } });
  const step = await press(answering);
  assert.equal(step.kind, 'approve');
  assert.deepEqual([...new Set(asked)].sort(), [...pure].sort(), 'every pure read went through the page');
  // Without the page's line, the same failure is said as the wallet's RPC being out of reach, its own error kept.
  const alone = world({ fail: { eth_getCode: offline } });
  await assert.rejects(press(alone), (error) => error.message === 'wallet_rpc_unreachable' && error.cause?.data?.message === 'Failed to fetch');
  // A revert is the chain's own answer: never asked again elsewhere.
  let page = 0;
  const reverting = world({ fail: { eth_estimateGas: () => ({ code: 3, message: 'execution reverted', data: '0x08c379a0' }) }, read: async () => { page++; return '0x'; } });
  await assert.rejects(press(reverting), (error) => error.code === 3);
  assert.equal(page, 0);
  // Nonces are the wallet's to say: never read through the page, and said as unreachable when the wallet cannot.
  let nonceViaPage = 0;
  const nonce = world({ fail: { eth_getTransactionCount: offline }, read: async () => { nonceViaPage++; return '0x0'; } });
  await assert.rejects(press(nonce), /wallet_rpc_unreachable/);
  assert.equal(nonceViaPage, 0);
});

// RPC-SPEC D6 (2026-10-01, the owner's rule: nothing is read from a public RPC): the page's line to the chain
// (src/lib/walletReads.ts readOnChain, what finance/wallet.ts hands the money code as `read`) serves no read any more. A
// read the wallet's own RPC could not answer is refused at once, with no network call, and the step says the wallet's
// RPC is out of reach, as it does without the page's line; a step the wallet answers itself goes on as before.
test('the page’s line serves no read: a read the wallet’s own RPC could not answer is said as out of reach, with nothing sent anywhere', async () => {
  const { readOnChain } = require('../.test-build/app/src/lib/walletReads.js');
  const original = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (...args) => (sent.push(args), assert.fail('the page read the chain'));
  try {
    const offline = () => ({ ...FETCH_FAILED });
    const alone = world({ fail: { eth_getCode: offline }, read: readOnChain });
    await assert.rejects(press(alone), (error) => error.message === 'wallet_rpc_unreachable' && error.cause?.data?.message === 'Failed to fetch');
    const answering = world({ read: readOnChain });
    assert.equal((await press(answering)).kind, 'approve', 'the wallet answers its own reads: nothing changes');
    assert.equal(sent.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});
// ---- fewer round trips before the first prompt (C10) ---------------------------------------------------------------

test('the deployment is read back once per press: a step within the next 30 s reads no code again, and the same checks still run', async () => {
  assert.equal(setup.VERIFIED_FOR_S, 30);
  const w = world({ state: { allowance: 10n ** 30n } });
  let clock = 1000;
  const client = w.client(() => clock);
  const step = await client.fund(KEY, 10n ** 15n, 10n ** 18n, GAS);
  assert.equal(step.kind, 'fund');
  const codes = () => w.calls.filter((m) => m === 'eth_getCode').length;
  const first = codes();
  await client.send(step, true);
  assert.equal(codes(), first, 'the send reuses the read-back made a moment before');
  clock += 31;
  await assert.rejects(client.fund(KEY, 10n ** 15n, 10n ** 18n, GAS), /pending_wallet_transaction|wallet_request_open/);
  assert.ok(codes() > first, 'past the window, read back again');
  // A changed deployment is still caught on the first read-back of a press.
  const changed = world();
  changed.override = (method, params) => (method === 'eth_getCode' && params[0] === DEPLOYMENT.stateView ? '0x6001' : undefined);
  await assert.rejects(press(changed), /deployment_code_changed/);
});

// ---- a transaction the wallet replaced (C14) -----------------------------------------------------------------------

test('a hash the chain does not know, while the account’s nonce has passed it, is read as replaced; a node behind is not', async () => {
  const w = world({ state: { allowance: 10n ** 30n } });
  const client = w.client();
  const step = await client.fund(KEY, 10n ** 15n, 10n ** 18n, GAS);
  assert.equal(step.kind, 'fund');
  const hash = await client.send(step, true);
  assert.equal((await client.receipt(hash, OPERATION)).state, 'pending', 'known, no receipt yet');
  // Sped up or cancelled in the wallet: its hash is gone, and the nonce it carried is used.
  w.st.known.delete(hash);
  w.st.latest = w.st.pending = 1;
  assert.equal((await client.receipt(hash, OPERATION)).state, 'replaced');
  // A node that had not seen it on the first ask, and has on the second, is not a replacement.
  let asks = 0;
  w.st.known.add(hash);
  w.override = (method) => (method === 'eth_getTransactionByHash' && ++asks === 1 ? null : undefined);
  assert.equal((await client.receipt(hash, OPERATION)).state, 'pending');
  // The hash unknown but the nonce not passed: still pending.
  const fresh = world({ state: { allowance: 10n ** 30n } });
  const other = fresh.client();
  const sent = await other.send(await other.fund(KEY, 10n ** 15n, 10n ** 18n, GAS), true);
  fresh.st.known.delete(sent);
  assert.equal((await other.receipt(sent, OPERATION)).state, 'pending');
});

// Fix round 1 (2026-10-01): a client that did not send the hash (a later press, or a reload) knows a replacement from the
// nonce the hash went out with, which a routed swap's journal keeps beside it; without it, an unknown hash stays pending.
test('a later client knows a replaced hash from the nonce kept beside it; without it, the hash reads as pending', async () => {
  const w = world({ state: { allowance: 10n ** 30n } });
  const first = w.client();
  const hash = await first.send(await first.fund(KEY, 10n ** 15n, 10n ** 18n, GAS), true);
  w.st.known.delete(hash);
  w.st.latest = w.st.pending = 1;
  const later = w.client();
  assert.equal((await later.receipt(hash, OPERATION)).state, 'pending', 'a later client with no nonce cannot tell');
  assert.equal((await later.receipt(hash, OPERATION, undefined, 0n)).state, 'replaced', 'with the nonce it went out with');
  assert.equal((await later.receipt(hash, OPERATION, undefined, 1n)).state, 'pending', 'a nonce not yet passed');
  // A node that had not seen it on the first ask, and has on the second, is not a replacement.
  let asks = 0;
  w.st.known.add(hash);
  w.override = (method) => (method === 'eth_getTransactionByHash' && ++asks === 1 ? null : undefined);
  assert.notEqual(await later.receipt(hash, OPERATION, undefined, 0n).then((r) => r.state, () => 'checked further'), 'replaced');
});

// C1: what a wallet without Robinhood Chain is asked to add, and what the wallet docs tell a person adding it by hand,
// are the same network: one name, one id, ETH, the chain's official RPC (alone since 2026-10-01, RPC-SPEC §7.5: the
// wallet's own; the public fallback beside it is gone), and the explorer.
test('the network the wallet is asked to add is the one the wallet docs give for adding it by hand', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(ADD_ROBINHOOD_CHAIN)), {
    chainId: '0x1237',
    chainName: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
    blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
  });
  assert.ok(Object.isFrozen(ADD_ROBINHOOD_CHAIN) && Object.isFrozen(ADD_ROBINHOOD_CHAIN.rpcUrls), 'fixed in the build');
  const section = DOC_PAGES.find((page) => page.slug === 'wallet').sections.find((entry) => entry.id === 'robinhood-chain');
  const rows = Object.fromEntries(section.blocks.find((block) => block.kind === 'facts').rows.map((row) => [row.label, row]));
  assert.deepEqual(Object.keys(rows), ['Network name', 'Chain ID', 'Currency symbol', 'RPC URL', 'Block explorer']);
  assert.equal(rows['Network name'].value, ADD_ROBINHOOD_CHAIN.chainName);
  assert.equal(rows['Chain ID'].value, String(Number(ADD_ROBINHOOD_CHAIN.chainId)));
  assert.equal(rows['Currency symbol'].value, ADD_ROBINHOOD_CHAIN.nativeCurrency.symbol);
  assert.equal(rows['RPC URL'].value, ADD_ROBINHOOD_CHAIN.rpcUrls[0]);
  assert.equal(rows['RPC URL'].note, undefined, 'no other RPC is offered');
  assert.equal(rows['Block explorer'].value, ADD_ROBINHOOD_CHAIN.blockExplorerUrls[0]);
});

// 2026-10-02 (review of the RPC switch, finding 16): a WalletConnect wallet answers no read; its provider hands every read
// to the page (wallet/walletConnect.ts), which serves none (lib/walletReads.ts readOnChain, RPC-SPEC D6). Its money steps
// stop before the wallet, said as what it is: not available yet for such a wallet. Never "check your wallet's RPC",
// which was never asked and which nothing the person changes would help. The C6 fallback (the wallet's own RPC failed
// first) still says the wallet cannot reach the chain, which is true.
test('a WalletConnect wallet’s reads, refused by the site, stop the step as not available for such a wallet, never as its RPC; nothing is sent', async () => {
  const { readOnChain } = require('../.test-build/app/src/lib/walletReads.js');
  const words = require('../.test-build/app/src/finance/words.js');
  const refusal = await readOnChain('eth_getCode', [OWNER, 'latest']).then(() => assert.fail('served'), (error) => error);
  assert.equal(refusal.message, 'site_reads_unavailable');
  assert.equal(setup.siteRefused(refusal), true);
  assert.equal(setup.siteRefused(FETCH_FAILED), false);
  assert.equal(setup.siteRefused({ code: -32603, message: 'Internal JSON-RPC error.', data: refusal }), true, 'wrapped in a wallet’s own error');
  // Every read the provider is asked goes to the page and is refused there.
  const phone = world({ read: readOnChain });
  phone.override = async (method, params) => (['eth_call', 'eth_getCode', 'eth_getBalance', 'eth_estimateGas', 'eth_getTransactionCount', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_gasPrice'].includes(method) ? readOnChain(method, params) : undefined);
  await assert.rejects(press(phone), (error) => error.message === 'site_reads_unavailable');
  assert.equal(phone.sends(), 0, 'nothing sent');
  const text = words.financeErrorText('site_reads_unavailable', 'fallback', 'Create position');
  assert.match(text, /WalletConnect/);
  assert.match(text, /Nothing was sent\.$/);
  assert.doesNotMatch(text, /RPC/, 'no advice about the wallet’s RPC');
  // The C6 fallback is unchanged: the wallet's own RPC failed, and the page's refusal behind it says nothing new.
  const offline = world({ fail: { eth_getCode: () => ({ ...FETCH_FAILED }) }, read: readOnChain });
  await assert.rejects(press(offline), (error) => error.message === 'wallet_rpc_unreachable');
  // Create position keeps the sentence through its own checks (it is not an unchecked pool).
  const create = readFileSync(new URL('../src/components/create/CreatePosition.tsx', import.meta.url), 'utf8');
  assert.match(create, /code === 'wallet_rpc_unreachable' \|\| code === 'site_reads_unavailable'\) throw error/);
});

// Fix round 1 (2026-10-01): a phone's wallet-app links open the site they were tapped on when it is the gated preview
// alias (where they used to send a tester to production), and domino.money from anywhere else: fixed links either way,
// never one the page builds (tests/session.source-guard.test.mjs). tests/session.browser.test.mjs taps the site's.
test('the wallet-app links open the preview alias there, domino.money everywhere else, each a fixed link', () => {
  const dialog = readFileSync(new URL('../src/components/wallet/WalletSessionDialog.tsx', import.meta.url), 'utf8');
  assert.match(dialog, /const onPreview = typeof location !== 'undefined' && location\.origin === PREVIEW_ALIAS/);
  for (const [preview, site] of [
    ['https://metamask.app.link/dapp/preview.domino-app-e65.pages.dev/', 'https://metamask.app.link/dapp/domino.money/'],
    ['https://go.cb-w.com/dapp?cb_url=https%3A%2F%2Fpreview.domino-app-e65.pages.dev%2F', 'https://go.cb-w.com/dapp?cb_url=https%3A%2F%2Fdomino.money%2F'],
    ['https://link.trustwallet.com/open_url?coin_id=60&url=https%3A%2F%2Fpreview.domino-app-e65.pages.dev%2F', 'https://link.trustwallet.com/open_url?coin_id=60&url=https%3A%2F%2Fdomino.money%2F'],
  ]) {
    assert.ok(dialog.includes(`{onPreview ? (\n            <a className="dm-wallet-row" href="${preview}"`), preview);
    assert.ok(dialog.includes(`) : (\n            <a className="dm-wallet-row" href="${site}"`), site);
  }
  const mode = require('../.test-build/app/src/chains/elysium/mode.js');
  assert.equal(mode.PREVIEW_ALIAS, 'https://preview.domino-app-e65.pages.dev', 'the alias the links name');
  const copy = readFileSync(new URL('../src/components/wallet/copy.ts', import.meta.url), 'utf8');
  assert.match(copy, /OPEN_IN_WALLET_APP = 'Open this site in your wallet app’s browser, then connect there\.'/);
});
