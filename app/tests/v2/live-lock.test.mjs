/**
 * The money lock before Domino V2's contracts are live (src/finance/v2/liveLock.ts; Domino V2 integration, 2026-10-02,
 * the base agent's item 2). The preview-v2 build lets the gate's FIXTURE set reach the closed clients up to a review, with
 * real wallets: nothing may be sent or signed with it.
 *
 *   - the rule: a compile outside Vite is not locked; a test build (`__DOMINO_TEST_HOOKS__` true) lets the fake chains'
 *     hand-built sets through and refuses the gate's fixture manifest set; every other build (preview-v2: the define
 *     false) refuses everything but the chain's pinned production manifest set, exactly, and a chain without one;
 *   - locked, with a fixture set: every send, signature, batch offer and approval of the zap, vault, auto-exit and direct
 *     clients, the shared sender, the one signer and the one batch offer refuse with `contracts_not_live` BEFORE the
 *     wallet is asked anything, and leave no journal entry, nonce claim or batch latch; the reads for a review still run;
 *   - locked, with the chain's pinned production set (the manifest map stood in for): nothing changes, the send reaches
 *     the wallet as before; a set one address away from it is refused;
 *   - a test build with the gate's live fake set: sends as before (what the browser suites drive);
 *   - the source: each entry point says the lock first; S2's sender still never sends a fixture quote.
 *
 * Changed on purpose 2026-10-04 (V2 deployed, #327): the real map pins Robinhood, Base and Arbitrum, so each chain is
 * live and its pinned set is the one that sends. The "no chain is live" cases stand the map in as empty (`NONE`): what a
 * chain with no pinned manifest, or one whose manifest fails a check, still gets.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createDirectChain } from '../support/v2-direct-chain.mjs';
import { createV2Chain, walletOf as zapWalletOf } from '../support/v2-chain.mjs';
import { createVaultChain, OWNER, vaultContracts, walletOf as vaultWalletOf, ZERO } from '../support/v2-vault-chain.mjs';
import * as fx from './support/plans.mjs';

const require = createRequire(import.meta.url);
const APP = resolve(import.meta.dirname, '../..');
const BUILD = resolve(APP, '.test-build/app/src');
const SRC = resolve(APP, 'src');
const chains = require(`${BUILD}/v2/chains.js`);
const position = require(`${BUILD}/finance/position.js`);

const CODE = 'contracts_not_live';
const NOW = 1_790_870_000;
const HASH = `0x${'11'.repeat(32)}`;
const GAS = { maxGas: 8_000_000n, maxFeePerGas: 200_000_000n, maxPriorityFeePerGas: 0n, reserveWei: 0n };
const SIGNING = /^(eth_sendTransaction|eth_sendRawTransaction|eth_signTypedData_v4|eth_sign|personal_sign|wallet_sendCalls|wallet_switchEthereumChain|wallet_addEthereumChain)$/;
const refusedByLock = (error) => error instanceof Error && error.message === CODE && error.code === CODE;

/** The money modules dropped from require's cache, so a fresh load reads the flags again (the chain profiles stay one object). */
function forget() {
  for (const key of Object.keys(require.cache)) if (/[\\/]finance[\\/]v2[\\/]/.test(key) && key.includes('.test-build')) delete require.cache[key];
}
/** The manifest map's own answer, before any test stands in for it. */
const manifest = require(`${BUILD}/v2/manifest.js`);
const realAvailability = manifest.v2Availability;

/** No pinned manifest: for the whole map (`money(false, NONE)`) or one chain (`{ 8453: NONE }`). */
const NONE = null;

/**
 * The money modules loaded fresh with `__DOMINO_TEST_HOOKS__` as `hooks` (undefined: no define at all, the node test
 * build), `pinned` standing in for the manifest map's answer (chainId -> contracts, or NONE; a chain it does not name
 * gets the real map's answer; NONE alone: no chain pinned) until the next load.
 */
function money(hooks, pinned = {}) {
  forget();
  if (hooks !== undefined) globalThis.__DOMINO_TEST_HOOKS__ = hooks;
  try {
    const load = (name) => require(`${BUILD}/${name}.js`);
    manifest.v2Availability = (chainId) => {
      const set = pinned === NONE ? NONE : pinned[chainId];
      if (set === NONE) return { available: false, copy: '', reason: 'not_deployed' };
      return set ? { available: true, contracts: set } : realAvailability(chainId);
    };
    return {
      lock: load('finance/v2/liveLock'),
      transact: load('finance/v2/transact'),
      typedData: load('finance/v2/typedData'),
      zap: load('finance/v2/zap'),
      vault: load('finance/v2/vault'),
      autoExit: load('finance/v2/autoExit'),
      direct: load('finance/v2/direct'),
      fixtures: load('v2/manifestFixtures'),
      deployment: load('finance/v2/deployment'),
    };
  } finally {
    delete globalThis.__DOMINO_TEST_HOOKS__;
  }
}

/** A wallet whose every request is recorded before it reaches the fake chain behind it. */
function recording(wallet) {
  const asked = [];
  return { asked, wallet: { ...wallet, request: async (method, params) => { asked.push(method); return wallet.request(method, params); } } };
}

/** The page's batch latch, in memory, recording every claim. */
function memoryLatch() {
  const claims = [];
  return {
    claims,
    batchOffered: () => null,
    async claimBatch(key) { claims.push(key); return 'claim-1'; },
    async recordBatch() {},
    async releaseBatch() {},
    async expireBatch() { return true; },
  };
}

/** The chain's production set, as the pinned manifest map would give it (src/v2/manifest.ts v2Availability): the fake chain's own addresses, `fixture: false`. */
const asPinned = (contracts) => Object.freeze({ ...contracts, fixture: false });

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

test('the rule: no define, no lock; a test build refuses only the gate\'s fixture manifest set; every other build refuses all but the pinned production set', () => {
  const fake = createV2Chain().contracts;
  const node = money(undefined);
  for (const set of [fake, null, node.fixtures.fixtureContracts(4663)]) assert.doesNotThrow(() => node.lock.refuseUnlessLive(4663, set), 'a compile outside Vite is not locked');

  const testBuild = money(true);
  assert.doesNotThrow(() => testBuild.lock.refuseUnlessLive(4663, fake), 'a fake chain\'s hand-built set runs in a test build');
  assert.doesNotThrow(() => testBuild.lock.refuseUnlessLive(4663, null));
  assert.throws(() => testBuild.lock.refuseUnlessLive(4663, testBuild.fixtures.fixtureContracts(4663)), refusedByLock, 'the gate\'s fixture set never runs, even in a test build');

  const site = money(false, NONE);
  for (const [label, set] of [['a fake set', fake], ['a set that only says it is real', { ...fake, fixture: false }], ['the fixture manifest set', site.fixtures.fixtureContracts(8453)], ['the chain itself', null]]) {
    assert.throws(() => site.lock.refuseUnlessLive(8453, set), refusedByLock, `${label}: no chain has a pinned manifest`);
  }
  assert.throws(() => site.lock.refuseUnlessLive(1, null), refusedByLock, 'a chain V2 does not serve');

  const pinned = asPinned(fake);
  const live = money(false, { 4663: pinned, 8453: NONE });
  assert.doesNotThrow(() => live.lock.refuseUnlessLive(4663, pinned), 'exactly the pinned production set');
  assert.doesNotThrow(() => live.lock.refuseUnlessLive(4663, { ...pinned }), 'compared by value');
  assert.doesNotThrow(() => live.lock.refuseUnlessLive(4663, null), 'the chain is live');
  assert.throws(() => live.lock.refuseUnlessLive(4663, { ...pinned, fixture: true }), refusedByLock);
  assert.throws(() => live.lock.refuseUnlessLive(4663, { ...pinned, addresses: { ...pinned.addresses, zapV4: `0x${'99'.repeat(20)}` } }), refusedByLock, 'one address away');
  assert.throws(() => live.lock.refuseUnlessLive(8453, null), refusedByLock, 'another chain, with no pinned manifest, is not live for it');
  assert.throws(() => live.lock.refuseUnlessLive(8453, pinned), refusedByLock, 'nor is the first chain\'s set there');

  // The real map (Changed on purpose 2026-10-04, V2 deployed, #327): every V2 chain is live, and only its own pinned set sends.
  const real = money(false);
  for (const chainId of [4663, 8453, 42161]) {
    const own = manifest.v2Availability(chainId);
    assert.equal(own.available, true, `${chainId} has its pinned manifest`);
    assert.doesNotThrow(() => real.lock.refuseUnlessLive(chainId, null), `${chainId}: the chain is live`);
    assert.doesNotThrow(() => real.lock.refuseUnlessLive(chainId, own.contracts), `${chainId}: its pinned production set`);
    const other = manifest.v2Availability(chainId === 4663 ? 8453 : 4663).contracts;
    for (const [label, set] of [['a fake set', fake], ['a set that only says it is real', { ...fake, fixture: false }], ['the fixture manifest set', real.fixtures.fixtureContracts(chainId)], ['another chain\'s pinned set', other]]) {
      assert.throws(() => real.lock.refuseUnlessLive(chainId, set), refusedByLock, `${chainId}: ${label}`);
    }
  }

  assert.equal(site.lock.CONTRACTS_NOT_LIVE, CODE);
  assert.equal(site.lock.contractsNotLiveCopy(8453), 'This opens as soon as Domino\'s service is live on Base.');
  assert.equal(site.lock.contractsNotLiveCopy(4663), 'This opens as soon as Domino\'s service is live on Robinhood Chain.');
  assert.equal(site.lock.contractsNotLiveCopy(42161), 'This opens as soon as Domino\'s service is live on Arbitrum One.');
  const error = new site.lock.ContractsNotLive(8453);
  assert.deepEqual([error.message, error.code, error.name, error.chainId], [CODE, CODE, 'ContractsNotLive', 8453]);
});

// ---------------------------------------------------------------------------
// Locked, with a fixture set: refused before the wallet, the reads still running
// ---------------------------------------------------------------------------

test('locked: the zap reviews and prepares on its reads, then its send, approval, permit and relayed signatures and batch refuse before the wallet is asked', async () => {
  const m = money(false);
  m.deployment.forgetV2DeploymentChecks?.();
  const chain = createV2Chain({ pools: fx.PRICED, balances: { [fx.USDG]: 5_000_000_000n } });
  const side = recording(zapWalletOf(chain));
  const client = fx.honest(m.zap.createZapClient(side.wallet, chains.v2Chain(chain.home), chain.contracts, () => fx.NOW), chain);
  const plan = fx.createWithSwap();
  const review = await client.review({ chainId: 4663, plan: { action: 'create', plan }, consent: 'direct', quote: { requestedAt: fx.NOW, expiresAt: fx.NOW + 180, legs: fx.quotedFor(plan.legs), simulation: { ok: true, block: 77_000_000n, error: null } } });
  assert.deepEqual(review.steps.map((step) => step.kind), ['approve', 'action']);
  const approve = await client.prepareStep(review, 0, GAS);
  assert.ok(side.asked.length > 0, 'the review and the preparation read the chain through the wallet');
  const before = side.asked.length;
  await assert.rejects(client.send(approve, true), refusedByLock, 'the exact approval');
  await assert.rejects(client.signPermit(review), refusedByLock, 'the permit');
  await assert.rejects(client.signRelayed(review), refusedByLock, 'the relayed signature');
  const latch = memoryLatch();
  await assert.rejects(client.sendBatch({}, true, () => latch), refusedByLock, 'the batch');
  assert.deepEqual(side.asked.slice(before), [], 'not one wallet request after the refusals');
  assert.deepEqual(side.asked.filter((method) => SIGNING.test(method)), [], 'nothing was sent or signed');
  assert.deepEqual([side.wallet.claims, latch.claims, [...side.wallet.nonces.keys()]], [[], [], []], 'no nonce claimed, no latch');
});

test('locked: the vault\'s and the auto-exit module\'s sends, signature and batches refuse first; the shared sender, the one signer and the one batch offer refuse as backstops', async () => {
  // The backstops ask whether the CHAIN is live: here no chain has a pinned manifest (the real map's chains are live).
  const m = money(false, NONE);
  const vaultChain = createVaultChain({ chainId: 4663, timestamp: NOW, atomic: 'ready', simulateV1: true });
  const side = recording(vaultWalletOf(vaultChain));
  const vault = m.vault.createVaultClient(side.wallet, chains.v2Chain(4663), vaultContracts(4663), () => NOW);
  const auto = m.autoExit.createAutoExitClient(side.wallet, chains.v2Chain(4663), vaultContracts(4663), () => NOW, () => 1n);
  const latch = memoryLatch();
  await assert.rejects(vault.send({}, true), refusedByLock, 'a vault step');
  await assert.rejects(vault.sendBatch({}, true, () => latch), refusedByLock, 'the vault\'s creation batch');
  await assert.rejects(vault.sendWithdrawAllBatch({}, true, () => latch), refusedByLock, 'the reserves\' withdraw-all batch');
  await assert.rejects(auto.send({}, true), refusedByLock, 'an auto-exit step');
  await assert.rejects(auto.signMandate({}), refusedByLock, 'the exit order\'s signature');
  await assert.rejects(auto.sendRegisterBatch({}, true, () => latch), refusedByLock, 'the order\'s registration batch');
  const t = m.transact.createTransactor(side.wallet, chains.v2Chain(4663), () => NOW);
  await assert.rejects(t.send({ kind: 'x' }, true), refusedByLock, 'the shared sender, with no lock of its own: the chain must be live');
  const MANDATE = { owner: OWNER, vault: `0x${'a2'.repeat(20)}`, tokenId: 7n, triggerBelowSqrtPriceX96: 1n << 90n, triggerAboveSqrtPriceX96: 0n, receiveMode: 0, convertTo: ZERO, maxSlippageBps: 100, validUntil: BigInt(NOW + 86_400), nonce: 5n };
  await assert.rejects(m.typedData.signV2TypedData(side.wallet, m.typedData.exitMandateTypedData(4663, `0x${'a4'.repeat(20)}`, MANDATE), { chainId: 4663, signer: OWNER, shape: 'ecdsa-low-s' }), refusedByLock, 'the one signer');
  const rpcAsked = [];
  await assert.rejects(m.vault.offerV2Batch(async (method) => { rpcAsked.push(method); return 'id'; }, OWNER, 4663, latch, HASH, [{ to: `0x${'a2'.repeat(20)}`, data: '0x', value: '0x0' }], () => true), refusedByLock, 'the one batch offer');
  assert.deepEqual([side.asked, rpcAsked, latch.claims, side.wallet.claims], [[], [], [], []], 'the wallet was asked nothing at all');
});

test('locked: a direct exit reads the position for its review, then its send refuses before the wallet: no chain is live', async () => {
  const m = money(false, NONE);
  const V4 = { tokenId: 5_000_123n, pool: { currency0: ZERO, currency1: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', fee: 3000, tickSpacing: 60 }, tickLower: -201060, tickUpper: -198060, liquidity: 10n ** 15n,
    sqrtPriceX96: position.sqrtPriceAtTick(-199500), tick: -199500, growthLast: [5n << 128n, 7n << 128n], growthNow: [(5n << 128n) + 1n, (7n << 128n) + 1n] };
  const chain = createDirectChain({ v4: [V4], v3: [], timestamp: NOW });
  const side = recording(zapWalletOf(chain));
  const client = m.direct.createDirectClient(side.wallet, chains.v2Chain(chain.chainId), () => NOW, chain.codeHashes);
  const prepared = await client.prepareCollect(4, V4.tokenId, GAS);
  assert.ok(side.asked.length > 0, 'the review read the chain');
  const before = side.asked.length;
  await assert.rejects(client.send(prepared, true), refusedByLock);
  assert.deepEqual(side.asked.slice(before), [], 'nothing asked after the refusal');
  assert.deepEqual(side.wallet.claims, [], 'no nonce claimed');
});

// ---------------------------------------------------------------------------
// Live contracts, and the test builds: nothing changes
// ---------------------------------------------------------------------------

test('locked, with the chain\'s pinned production set: the zap\'s approval reaches the wallet exactly as before; a test build sends the fake chain\'s set', async () => {
  for (const [label, hooks, setOf] of [['the pinned production set', false, (contracts) => asPinned(contracts)], ['a test build\'s live fake set', true, (contracts) => contracts]]) {
    const chain = createV2Chain({ pools: fx.PRICED, balances: { [fx.USDG]: 5_000_000_000n } });
    const set = setOf(chain.contracts);
    const m = money(hooks, hooks ? {} : { 4663: set });
    m.deployment.forgetV2DeploymentChecks?.();
    const side = recording(zapWalletOf(chain));
    const client = fx.honest(m.zap.createZapClient(side.wallet, chains.v2Chain(chain.home), set, () => fx.NOW), chain);
    const plan = fx.createWithSwap();
    const review = await client.review({ chainId: 4663, plan: { action: 'create', plan }, consent: 'direct', quote: { requestedAt: fx.NOW, expiresAt: fx.NOW + 180, legs: fx.quotedFor(plan.legs), simulation: { ok: true, block: 77_000_000n, error: null } } });
    const hash = await client.send(await client.prepareStep(review, 0, GAS), true);
    assert.match(hash, /^0x[0-9a-f]{64}$/, label);
    assert.equal(side.asked.filter((method) => method === 'eth_sendTransaction').length, 1, `${label}: the approval was offered once`);
  }
});

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

const read = (path) => readFileSync(join(SRC, path), 'utf8');

/** The statements of a body whose signature line starts with `signature`, comments and blank lines skipped. */
function statements(code, signature, label) {
  const at = code.indexOf(signature);
  assert.ok(at >= 0, `${label}: ${signature} is where it was`);
  assert.equal(code.indexOf(signature, at + 1), -1, `${label}: ${signature} is there once`);
  const end = code.indexOf('\n', at);
  return code.slice(end + 1).split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('//'));
}

const ENTRIES = [
  // [file, signature, the statements allowed before the lock, the lock]
  ['finance/v2/zap.ts', 'async function send(prepared: PreparedV2, acknowledged: boolean): Promise<Hex> {', ['guard()'], 'refuseUnlessLive(chain.chainId, contracts)'],
  ['finance/v2/zap.ts', 'async function signPermit(review: ZapReview): Promise<SignedTypedData> {', ['guard()'], 'refuseUnlessLive(chain.chainId, contracts)'],
  ['finance/v2/zap.ts', 'async function signRelayed(review: ZapReview): Promise<SignedTypedData> {', ['guard()'], 'refuseUnlessLive(chain.chainId, contracts)'],
  ['finance/v2/zap.ts', 'async function sendBatch(batch: ZapBatch,', [], 'refuseUnlessLive(chain.chainId, contracts)'],
  ['finance/v2/vault.ts', 'sendBatch: async (batch: VaultCreateBatch,', [], 'refuseUnlessLive(chain.chainId, contracts)'],
  ['finance/v2/vault.ts', 'sendWithdrawAllBatch: async (batch: VaultWithdrawBatch,', [], 'refuseUnlessLive(chain.chainId, contracts)'],
  ['finance/v2/vault.ts', 'export async function offerV2Batch(', [], 'refuseUnlessLive(chainId, null)'],
  ['finance/v2/autoExit.ts', 'sendRegisterBatch: async (batch: MandateBatch,', [], 'refuseUnlessLive(chain.chainId, contracts)'],
  // Added 2026-10-06 (the owner's point 5: Auto-exit as a signature plus ONE batch): the protection-only vault and its order together.
  ['finance/v2/autoExit.ts', 'sendProtectBatch: async (batch: ProtectBatch,', [], 'refuseUnlessLive(chain.chainId, contracts)'],
  ['finance/v2/autoExit.ts', 'signMandate: (review: MandateReview) => {', ['try {'], 'refuseUnlessLive(chain.chainId, contracts)'],
  ['finance/v2/typedData.ts', 'export async function signV2TypedData(', [], 'refuseUnlessLive(expect.chainId, null)'],
  ['finance/v2/transact.ts', 'function send(prepared: PreparedV2,', ['try {'], 'liveLock()'],
];

test('source: every send, signature and batch offer of finance/v2 says the lock first (after the pure guard only)', () => {
  for (const [path, signature, before, lock] of ENTRIES) {
    const body = statements(read(path), signature, path);
    assert.deepEqual(body.slice(0, before.length), before, `${path} ${signature}: what comes before the lock`);
    assert.equal(body[before.length], lock, `${path} ${signature}`);
  }
  // Each client's transactor carries the client's own lock; the direct client's asks the chain.
  for (const path of ['finance/v2/zap.ts', 'finance/v2/vault.ts', 'finance/v2/autoExit.ts']) {
    assert.equal([...read(path).matchAll(/createTransactor\(wallet, chain, now, \(\) => refuseUnlessLive\(chain\.chainId, contracts\)\)/g)].length, 1, path);
    assert.equal([...read(path).matchAll(/createTransactor\(/g)].length, 1, `${path} builds one transactor`);
  }
  assert.match(read('finance/v2/direct.ts'), /createTransactor\(wallet, chain, now, \(\) => refuseUnlessLive\(chain\.chainId, null\)\)/);
  assert.match(read('finance/v2/transact.ts'), /liveLock: \(\) => void = \(\) => refuseUnlessLive\(chain\.chainId, null\)\) \{/, 'without a lock of its own, the chain must be live');
  // A refusal of the lock signed nothing: the signers' "before any prompt" sets name it.
  assert.match(read('finance/v2/zap.ts'), /const BEFORE_PROMPT = new Set\(\[[^\]]*CONTRACTS_NOT_LIVE\]\)/);
  assert.match(read('finance/v2/autoExit.ts'), /const SIGNER_BEFORE_PROMPT: ReadonlySet<string> = new Set\(\[[^\]]*CONTRACTS_NOT_LIVE\]\)/);
  // The lock names no wallet method and reads no network.
  const lock = read('finance/v2/liveLock.ts');
  assert.doesNotMatch(lock, /\.request\(|getProvider|fetch\(|eth_|wallet_/);
});

test('S2: a fixture quote is still never sent (crosschain.ts quote_synthetic), the test that holds it is still there', () => {
  const sender = read('finance/v2/crosschain.ts');
  assert.match(sender, /quote_synthetic/);
  const tests = readFileSync(join(APP, 'tests/v2/s2-sender.test.mjs'), 'utf8');
  assert.match(tests, /quote_synthetic/);
});

// Changed on purpose (data) 2026-10-02 (Domino V2 integration, item 6): moved here from the old preview build's lock test
// (tests/v2/preview-lock.test.mjs, gone with that build): where the V2 modules reach a wallet at all, so a new way to a
// wallet cannot appear beside the locked ones unseen.
test('source: the V2 modules invoke a wallet\'s provider in exactly the known places, and offer a batch only in the two locked ones', () => {
  const v2 = readdirSync(join(SRC, 'finance/v2')).filter((name) => name.endsWith('.ts')).map((name) => `finance/v2/${name}`);
  const sites = {};
  for (const path of v2) {
    const count = [...read(path).matchAll(/\b(?:wallet|provider)\.request\(/g)].length;
    if (count > 0) sites[path] = count;
  }
  // transact: the bounded port's one call (every read and the one eth_sendTransaction, the send behind the lock);
  // typedData: the signer's three (account, chain, then the signature, behind the lock's backstop); crosschain: the
  // origin sender's bounded port and the wallet it builds (S2: a fixture quote is never sent); wallet: the V2 wallet it builds.
  // holdings: the S2 scan's three reads on an origin (eth_chainId, eth_getBalance, eth_call), never a send (2026-10-02).
  assert.deepEqual(sites, { 'finance/v2/crosschain.ts': 2, 'finance/v2/holdings.ts': 3, 'finance/v2/transact.ts': 1, 'finance/v2/typedData.ts': 3, 'finance/v2/wallet.ts': 1 });
  assert.deepEqual(v2.filter((path) => /getProvider\(/.test(read(path))).sort(), ['finance/v2/crosschain.ts', 'finance/v2/wallet.ts'], 'only the two wallet builders take a provider');
  const offers = Object.fromEntries(v2.map((path) => [path, [...read(path).matchAll(/\bofferBatch\(/g)].length]).filter(([, count]) => count > 0));
  // vault.ts: offerV2Batch's one call (the vault's and the auto-exit module's batches); zap.ts: sendBatch's one call.
  // Changed on purpose 2026-10-06 (rugged's answer of 6 Oct: the owner revoked decision #15): crosschain.ts, S2's sendBatch,
  // a deposit's approval and the deposit on its ORIGIN chain. No Domino contract is on its way (S2 has no live lock): it
  // is behind S2's own guards, a review of a quote from Domino's service only (quote_synthetic), asserted below.
  assert.deepEqual(offers, { 'finance/v2/crosschain.ts': 1, 'finance/v2/vault.ts': 1, 'finance/v2/zap.ts': 1 });
  const s2 = read('finance/v2/crosschain.ts');
  assert.match(s2, /async function sendBatch\(reviewed: OriginReview\): Promise<PendingBatch> \{\n    const state = reviews\.get\(reviewed\) \?\? fail\('review_required'\)/, 'only a review this sender issued, and a review refuses a fixture quote');
  // Changed on purpose 2026-10-06 (the owner's point 5): two auto-exit batches, the registration and the one-batch activation
  // (sendRegisterBatch, sendProtectBatch), both through the vault's locked offerV2Batch.
  assert.equal([...read('finance/v2/autoExit.ts').matchAll(/\bofferV2Batch\(/g)].length, 2, 'auto-exit offers through the vault\'s locked offerV2Batch');
  for (const path of ['finance/v2/zap.ts', 'finance/v2/vault.ts', 'finance/v2/autoExit.ts', 'finance/v2/direct.ts']) {
    assert.doesNotMatch(read(path), /\b(?:wallet|provider)\.request\(/, `${path} reaches the wallet only through the shared sender`);
  }
  assert.equal(read('finance/batch.ts').includes('liveLock'), false, 'V1\'s batch module is unchanged');
});
