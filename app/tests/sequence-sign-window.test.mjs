/**
 * A sequence's own wallet steps (Turn on, Pause, Set up automation) against a person who takes time to sign, and a wallet
 * that refuses or is left open (2026-10-01, the audit's C8 and C2; its harness wallet-compat/seq-sign-window.mjs, ported).
 * Nothing real is signed or sent: the chain is the finance suite's fake, read from tests/finance.browser.test.mjs at
 * run time (the audit's extract-fake-chain.mjs markers), so the two never drift apart.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const APP = resolve(import.meta.dirname, '..');
const sequence = require('../.test-build/app/src/finance/sequence.js');
const { createNonceJournal } = require('../.test-build/app/src/finance/nonce.js');
const { SIGN_WINDOW_S } = require('../.test-build/app/src/finance/setup.js');

async function loadFakeChain() {
  const source = readFileSync(join(APP, 'tests/finance.browser.test.mjs'), 'utf8');
  const start = source.indexOf('const chainAbi = parseAbi([');
  const marker = 'holdNext: () => { hold = true; }, simulate: calls => batchResults(calls).results };\n}';
  const end = source.indexOf(marker, start);
  assert.ok(start >= 0 && end > start, 'the finance suite still defines fakeSequenceChain between the audit harness markers');
  const header = "import { parseAbi, concatHex, keccak256, encodeAbiParameters, parseAbiParameters, stringToHex, zeroAddress, decodeFunctionData, encodeFunctionResult, numberToHex } from 'viem';\n";
  const body = source.slice(start, end + marker.length).replace('function fakeSequenceChain', 'export function fakeSequenceChain');
  const file = join(APP, '.test-build', 'fake-sequence-chain.mjs');
  mkdirSync(join(APP, '.test-build'), { recursive: true });
  writeFileSync(file, `${header}${body}\n`);
  return (await import(pathToFileURL(file).href)).fakeSequenceChain;
}
const fakeSequenceChain = await loadFakeChain();

// Anvil's public development account #0 address (no key is used here).
const OWNER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const GAS = { maxGas: 8_000_000n, maxFeePerGas: 200_000_000n, maxPriorityFeePerGas: 0n, reserveWei: 0n };
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

/** The owner's wallet over the fake chain: `sign` decides what the person does with the prompt. */
function wallet(chain, { journalStorage = storage(), locks = pageLocks(), sign = async () => undefined } = {}) {
  const journal = createNonceJournal(journalStorage, locks, uuid);
  const calls = [];
  return {
    calls,
    journal,
    locks,
    rpc: {
      owner: OWNER,
      current: () => true,
      nonceOffered: (nonce) => journal.offered(OWNER, nonce),
      claimNonce: (nonce) => journal.claim(OWNER, nonce, Date.now() / 1000),
      releaseRejectedNonce: (nonce, token) => journal.releaseAfterRejection(OWNER, nonce, token),
      settleNonce: (nonce, now, maxAge) => journal.settle(OWNER, nonce, now, maxAge),
      async request(method, params) {
        calls.push(method);
        if (method === 'eth_accounts') return [OWNER];
        if (method === 'eth_chainId') return '0x1237';
        if (method === 'eth_sendTransaction') await sign(params);
        const reply = await chain.request(method, params);
        if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
        return reply.result;
      },
    },
  };
}
const client = (chain, w) => sequence.createSequenceClient(w.rpc, chain.release.deployment, () => Date.now() / 1000, async () => chain.release.deployment);
const settle = async (until) => {
  for (let i = 0; i < 200 && !until(); i++) await new Promise((resolve) => setImmediate(resolve));
};

test('Turn on waits for a slow signer as long as Create position does (180 s), where it gave up after 30 s', async (t) => {
  assert.equal(SIGN_WINDOW_S, 180);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const chain = fakeSequenceChain(OWNER, { roots: [100n], paused: true });
  let signed = false;
  // The person reads the transaction on a Ledger for 40 s, then confirms.
  const w = wallet(chain, { sign: () => new Promise((resolve) => setTimeout(() => { signed = true; resolve(); }, 40_000)) });
  const sequenceClient = client(chain, w);
  const prepared = await sequenceClient.resume(chain.vaults[0], GAS);
  let outcome = null;
  const sending = sequenceClient.send(prepared, true).then((hash) => { outcome = hash; }, (error) => { outcome = error; });
  await settle(() => w.calls.includes('eth_sendTransaction'));
  assert.ok(w.calls.includes('eth_sendTransaction'), 'the prompt opened');
  t.mock.timers.tick(31_000);
  await settle(() => outcome !== null);
  assert.equal(outcome, null, 'still waiting for the person past 30 s');
  t.mock.timers.tick(9_000);
  await sending;
  assert.equal(signed, true);
  assert.match(String(outcome), /^0x[0-9a-f]{64}$/, String(outcome?.message ?? outcome));
  assert.equal(chain.sends.length, 1);
  // The 180 s are the send's only: a read still answers in its own 30 s window.
  t.mock.timers.reset();
});

test('a sequence step a Ledger refused lets its nonce go; one left open holds it until its page is gone, and is never offered twice', async () => {
  const chain = fakeSequenceChain(OWNER, { roots: [100n], paused: true });
  const ledger = Object.assign(new Error('Ledger device: Condition of use not satisfied (denied by the user?) (0x6985)'), { code: -32603 });
  const refusing = wallet(chain, { sign: async () => { throw ledger; } });
  const first = client(chain, refusing);
  await assert.rejects(first.send(await first.resume(chain.vaults[0], GAS), true), /0x6985/);
  assert.equal(refusing.journal.offered(OWNER, 0n), false, 'released at once');
  assert.equal((await client(chain, refusing).resume(chain.vaults[0], GAS)).kind, 'resume', 'the next press prepares');

  // The page is reloaded while the prompt is open (the audit's harness: every later press said pending_wallet_transaction).
  const shared = storage();
  let unanswered;
  const open = wallet(chain, { journalStorage: shared, sign: () => new Promise((_, reject) => { unanswered = reject; }) });
  const page = client(chain, open);
  void page.send(await page.resume(chain.vaults[0], GAS), true).catch(() => {});
  await settle(() => open.calls.includes('eth_sendTransaction'));
  assert.equal(open.journal.offered(OWNER, 0n), true);
  await assert.rejects(client(chain, open).resume(chain.vaults[0], GAS), /wallet_request_open/, 'its page is open: held');
  // After the reload: a new page, the same storage, the old page's lock gone; nothing is pending on chain.
  const reloaded = wallet(chain, { journalStorage: shared });
  assert.equal((await client(chain, reloaded).resume(chain.vaults[0], GAS)).kind, 'resume');
  assert.equal(chain.sends.length, 0, 'nothing was ever sent');
  unanswered(Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603 }));
});

// 2026-10-01 (audit C14): a sequence step the person replaced in the wallet ("Speed up" or "Cancel") reads as replaced once
// the chain does not know its hash and the account's mined nonce has passed it, as Create position's do; the vault read
// again says whether it happened. One still pending is known by its hash and stays pending.
test('a sequence step sped up or cancelled in the wallet reads as replaced, and the vault says whether it happened; one still pending stays pending', async () => {
  for (const kind of ['speedUpNext', 'cancelNextInWallet']) {
    const chain = fakeSequenceChain(OWNER, { roots: [100n], paused: true, settled: true });
    const w = wallet(chain);
    const sequenceClient = client(chain, w);
    const prepared = await sequenceClient.resume(chain.vaults[0], GAS);
    chain[kind]();
    const hash = await sequenceClient.send(prepared, true);
    assert.deepEqual(await sequenceClient.receipt(hash), { state: 'replaced' }, kind);
    assert.equal((await sequenceClient.inspect(chain.vaults[0])).paused, kind === 'cancelNextInWallet', kind === 'speedUpNext' ? 'a sped-up Turn on turned it on' : 'a cancelled one left it paused');
    assert.equal(w.calls.filter((method) => method === 'eth_sendTransaction').length, 1, 'nothing sent again');
    if (kind === 'cancelNextInWallet') {
      // The next press prepares at the nonce after the one the cancel took.
      assert.equal((await client(chain, w).resume(chain.vaults[0], GAS)).transaction.nonce, '0x1');
    }
  }
  const chain = fakeSequenceChain(OWNER, { roots: [100n], paused: true });
  const w = wallet(chain);
  const sequenceClient = client(chain, w);
  const hash = await sequenceClient.send(await sequenceClient.resume(chain.vaults[0], GAS), true);
  assert.deepEqual(await sequenceClient.receipt(hash), { state: 'pending' }, 'not in a block yet: known by its hash, so never a replacement');
  chain.include({});
  assert.ok(['confirming', 'finalized'].includes((await sequenceClient.receipt(hash)).state));
});
