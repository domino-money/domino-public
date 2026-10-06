/**
 * PHASE B, B1 (spec F7 §1.3): the shared V1 modules made chain-aware, with Robinhood Chain's behaviour byte-identical.
 *   - finance/nonce.ts: a journal per chain; 4663's keys are exactly V1's (the same hashed input).
 *   - finance/batch.ts: wallet_getCapabilities and wallet_sendCalls carry the action's chain; 0x1237 by default.
 *   - session/machine.ts: a session is kept across Base and Arbitrum One only in a build that carries V2 (and, since
 *     2026-10-06, across the networks a deposit may come from).
 *   - config/chainIdentity.ts: the V2 chains' ids, equal to the V2 profiles'.
 *   - finance/v2/signatureJournal.ts and src/v2/capabilities.ts.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { getAddress, keccak256, stringToHex } from 'viem';
import { FIXTURES, runtime, siweMessage } from '../support/session-fixtures.mjs';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src/';
const { createNonceJournal } = require(`${BUILD}finance/nonce.js`);
const batch = require(`${BUILD}finance/batch.js`);
const identity = require(`${BUILD}config/chainIdentity.js`);
const chains = require(`${BUILD}v2/chains.js`);
const { createSignatureJournal } = require(`${BUILD}finance/v2/signatureJournal.js`);

const OWNER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
function storage() {
  const map = new Map();
  return { map, get length() { return map.size; }, key: (i) => [...map.keys()][i] ?? null, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}
const locks = () => ({ request: (_name, callback) => callback() });
let counter = 0;
const token = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

/** A module loaded fresh with `__DOMINO_V2__` set, standing in for the v2-test build (the flag is read at load). */
function withV2(on, path, also = []) {
  const paths = [path, ...also, `${BUILD}v2/flag.js`].map((p) => require.resolve(p));
  for (const p of paths) delete require.cache[p];
  globalThis.__DOMINO_V2__ = on;
  try {
    return require(path);
  } finally {
    delete globalThis.__DOMINO_V2__;
    for (const p of paths) delete require.cache[p];
  }
}

test('the V2 chains\' ids in the registry are the V2 profiles\', and none joins the registry V1 reads', () => {
  assert.deepEqual([identity.BASE_ID, identity.ARBITRUM_ID], [8453, 42161]);
  assert.deepEqual([...identity.V2_CHAIN_IDS], chains.V2_CHAINS.map((c) => c.chainId));
  assert.deepEqual([identity.BASE_NAME, identity.ARBITRUM_NAME], [chains.v2Chain(8453).name, chains.v2Chain(42161).name]);
  assert.deepEqual([...identity.REGISTRY_CHAIN_IDS], [4663, 99801], 'the registry V1 reads and keeps sessions across is unchanged');
  const source = readFileSync(new URL('../../src/config/chainIdentity.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source.slice(source.indexOf('export const BASE_ID')), /https?:\/\//i, 'no URL of any kind for Base or Arbitrum One: no RPC, no explorer');
});

test('nonce journal: Robinhood Chain\'s keys are exactly V1\'s; the same nonce on Base is another latch', async () => {
  const s = storage();
  const v1 = createNonceJournal(s, locks(), token);
  const robinhood = createNonceJournal(s, locks(), token, 4663);
  const base = createNonceJournal(s, locks(), token, 8453);
  await v1.claim(OWNER, 7n, 1_000);
  const v1Key = `domino.offered-nonce.v1.${keccak256(stringToHex(`4663|${OWNER}|7`)).slice(2)}`;
  assert.ok(s.map.has(v1Key), 'the hashed input is 4663|owner|nonce, as always');
  assert.equal(robinhood.offered(OWNER, 7n), true, 'an explicit 4663 journal sees V1\'s latch: the same key');
  assert.equal(base.offered(OWNER, 7n), false, 'Base\'s nonce 7 is not Robinhood\'s');
  await base.claim(OWNER, 7n, 1_000);
  assert.ok(s.map.has(`domino.offered-nonce.v1.${keccak256(stringToHex(`8453|${OWNER}|7`)).slice(2)}`));
  await assert.rejects(base.claim(OWNER, 7n, 1_000), /wallet_nonce_already_offered/);
  // Batch latches too.
  const op = `0x${'c'.repeat(64)}`;
  await v1.claimBatch(OWNER, op, 1_000);
  assert.ok(s.map.has(`domino.offered-batch.v1.${keccak256(stringToHex(`4663|${OWNER}|${op}`)).slice(2)}`));
  assert.equal(base.batchOffered(OWNER, op), null);
  assert.throws(() => createNonceJournal(s, locks(), token, 0), /invalid_wallet_chain/);
});

test('batch: the capabilities read and the batch carry the action\'s chain; Robinhood Chain\'s by default', async () => {
  const reply = { '0x2105': { atomic: { status: 'supported' } }, '0x1237': { atomic: { status: 'ready' } } };
  assert.equal(batch.atomicStatusOf(reply), 'ready', 'V1: 4663');
  assert.equal(batch.atomicStatusOf(reply, 8453), 'supported');
  assert.equal(batch.atomicStatusOf(reply, 42161), 'unsupported');
  const asked = [];
  const wallet = (chainReply) => ({ owner: OWNER, request: async (method, params) => { asked.push([method, params]); return chainReply; } });
  assert.equal(await batch.atomicStatus(wallet(reply)), 'ready');
  assert.equal(await batch.atomicStatus(wallet(reply), 5_000, 8453), 'supported');
  assert.deepEqual(asked.map(([, params]) => params[1]), [['0x1237'], ['0x2105']]);
  const sent = [];
  const batchWallet = { owner: OWNER, claimBatch: async () => 'claim', recordBatch: async () => {}, releaseBatch: async () => {} };
  const request = async (method, params) => { sent.push(params[0].chainId); return { id: 'batch-1' }; };
  await batch.offerBatch(request, batchWallet, `0x${'d'.repeat(64)}`, [], () => true);
  await batch.offerBatch(request, batchWallet, `0x${'e'.repeat(64)}`, [], () => true, 42161);
  assert.deepEqual(sent, ['0x1237', '0xa4b1']);
  // A chain that is not one is refused before any latch is claimed: nothing is left held.
  let claimed = 0;
  const counting = { ...batchWallet, claimBatch: async () => { claimed++; return 'claim'; } };
  await assert.rejects(batch.offerBatch(request, counting, `0x${'f'.repeat(64)}`, [], () => true, 0), /invalid_wallet_chain/);
  assert.equal(claimed, 0);
  assert.deepEqual(sent, ['0x1237', '0xa4b1']);
});

// ---------------------------------------------------------------------------
// The session across V2's chains
// ---------------------------------------------------------------------------

const ADDR = FIXTURES.requests.challenge.address;
const CSRF = 'a'.repeat(43);
const ORIGIN = 'https://app.example.invalid';
const wallet = (chainId = 4663) => ({ kind: 'connected', connectorUid: 'uid-a', connectorName: 'Test Wallet', address: ADDR, chainId });
const ok = (route, body) => ({ ok: true, route, body, serverTime: null });
const code = (route, error) => ({ ok: false, route, failure: { kind: 'session_error', status: runtime.ERROR_STATUS_BY_CODE[error], code: error, retryAfterS: null }, serverTime: null });
const sessionBody = { ...FIXTURES.responses.me, owner: { address: ADDR.toLowerCase(), chainId: 4663 }, csrfToken: CSRF };
const result = (outcome) => (m) => ({ type: 'result', epoch: m.epoch, outcome });

function walk(machineModule, env, ...events) {
  let machine = machineModule.initialMachine;
  const effects = [];
  for (const event of events) {
    const step = machineModule.reduce(machine, typeof event === 'function' ? event(machine) : event, env);
    machine = step.machine;
    effects.push(...step.effects);
  }
  return { machine, effects };
}
function signedIn(machineModule, env) {
  const challenge = { challengeId: 'b'.repeat(32), expiresAt: '2026-09-10T12:05:00Z', message: siweMessage({ origin: ORIGIN, address: ADDR, nonce: 'a'.repeat(32), issuedAt: '2026-09-10T12:00:00Z', expiresAt: '2026-09-10T12:05:00Z' }) };
  return walk(machineModule, env,
    { type: 'identity', identity: wallet() }, result(code('me', 'session_required')), { type: 'sign_in' },
    result(ok('bootstrap', { ...FIXTURES.responses.bootstrap, csrfToken: 'p'.repeat(43) })), result(ok('challenge', challenge)),
    (m) => ({ type: 'signed', epoch: m.epoch, signature: FIXTURES.requests.verify.signature }), result(ok('verify', sessionBody)));
}
const then = (machineModule, env, start, ...events) => {
  let machine = start.machine;
  const effects = [];
  for (const event of events) {
    const step = machineModule.reduce(machine, typeof event === 'function' ? event(machine) : event, env);
    machine = step.machine;
    effects.push(...step.effects);
  }
  return { machine, effects };
};
const routes = (effects) => effects.filter((e) => e.type === 'call').map((e) => e.request.route);

// Changed on purpose 2026-10-04 (the owner: the site runs on V2): the deployable builds carry V2 now; a build without it
// (the V1 test builds) keeps this behavior.
test('a build without V2: moving to Base is an identity change, exactly as before', () => {
  const m = withV2(false, `${BUILD}session/machine.js`);
  assert.deepEqual([...m.sessionChains('https://domino.money')], [4663]);
  assert.deepEqual([...m.keptChains()], [4663, 99801]);
  const env = { origin: ORIGIN, checksum: getAddress, chains: m.sessionChains(ORIGIN) };
  const start = signedIn(m, env);
  assert.equal(start.machine.view.status, 'signed_in');
  const away = then(m, env, start, { type: 'identity', identity: wallet(8453) });
  assert.deepEqual(routes(away.effects), ['logout'], 'the session is closed, as for any chain outside the registry');
  assert.equal(away.machine.session, null);
  // Even a controller that named Base would not keep it: the machine's own list is the registry's.
  const forced = then(m, { ...env, chains: [4663, 8453] }, start, { type: 'identity', identity: wallet(8453) });
  assert.deepEqual(routes(forced.effects), ['logout']);
});

test('the v2-test build: the session is kept while the wallet is on Base or Arbitrum One, and back on Robinhood Chain it is read again, no signature', () => {
  const m = withV2(true, `${BUILD}session/machine.js`);
  // Changed on purpose 2026-10-06 (the owner's point 2a): and every network a deposit may come from, after Domino's three.
  assert.deepEqual([...m.sessionChains('https://domino.money')], [4663, 8453, 42161, ...m.CROSSCHAIN_ORIGIN_CHAIN_IDS]);
  assert.deepEqual([...m.keptChains()], [4663, 99801, 8453, 42161, ...m.CROSSCHAIN_ORIGIN_CHAIN_IDS]);
  const env = { origin: ORIGIN, checksum: getAddress, chains: m.sessionChains(ORIGIN) };
  const start = signedIn(m, env);
  for (const chainId of [8453, 42161, 1, 10]) {
    const away = then(m, env, start, { type: 'identity', identity: wallet(chainId) });
    assert.deepEqual(away.machine.view, { status: 'wrong_network', chainId }, 'Robinhood Chain\'s screens say the wallet is elsewhere');
    assert.deepEqual(routes(away.effects), [], 'no logout, nothing asked');
    assert.deepEqual(away.machine.session, start.machine.session, 'the session is kept');
    const back = then(m, env, away, { type: 'identity', identity: wallet() });
    assert.deepEqual(routes(back.effects), ['me']);
    const landed = then(m, env, back, result(ok('me', sessionBody)));
    assert.equal(landed.machine.view.status, 'signed_in');
    assert.equal([...away.effects, ...back.effects, ...landed.effects].filter((e) => e.type === 'sign').length, 0, 'no signature');
  }
  // Changed on purpose 2026-10-06 (the owner's point 2a): Ethereum is a network a deposit may come from: kept (above). A
  // chain outside every list is still an identity change.
  const elsewhere = then(m, env, start, { type: 'identity', identity: wallet(31337) });
  assert.deepEqual(routes(elsewhere.effects), ['logout']);
});

// Added 2026-10-06 (the owner's point 2a): the networks a deposit may come from are rugged97's pins, copied as numbers into
// the session machine (the package's pin table would put every bridge address in the page's entry).
test('the deposit origins the session is kept across are crosschain-v1 pins as origins, less Domino’s own three', async () => {
  const m = withV2(true, `${BUILD}session/machine.js`);
  const { CONSTANTS } = await import(new URL('../../../api-contracts/crosschain-v1/schema-data.mjs', import.meta.url).href);
  const pinned = Object.keys(CONSTANTS.chains).map(Number).sort((a, b) => a - b);
  assert.deepEqual([...new Set([...identity.V2_CHAIN_IDS, ...m.CROSSCHAIN_ORIGIN_CHAIN_IDS])].sort((a, b) => a - b), pinned);
  assert.equal(m.CROSSCHAIN_ORIGIN_CHAIN_IDS.some((id) => identity.V2_CHAIN_IDS.includes(id)), false, 'Domino’s own are V2_CHAIN_IDS');
  assert.equal(m.CROSSCHAIN_ORIGIN_CHAIN_IDS.includes(99801), false);
});

// Added 2026-10-05 (the owner, testing a deposit from another network: "it keeps asking me to sign in"): the session held on
// Base or Arbitrum One is usable there (session/machine.ts heldAway; the controller lends its CSRF, finance/v2/http.ts
// counts it), for its own account only, at rest only, and only in a build that carries V2.
test('the session held on Base or Arbitrum One, or on a deposit’s origin network, is usable there; never on another chain, for another account, or in a build without V2', () => {
  const m = withV2(true, `${BUILD}session/machine.js`);
  const env = { origin: ORIGIN, checksum: getAddress, chains: m.sessionChains(ORIGIN) };
  const start = signedIn(m, env);
  assert.equal(m.heldAway(start.machine, env), false, 'on Robinhood Chain the session is simply signed in');
  // Changed on purpose 2026-10-06 (the owner's point 2a): Ethereum and OP Mainnet (deposit origins) too.
  for (const chainId of [8453, 42161, 1, 10]) {
    const away = then(m, env, start, { type: 'identity', identity: wallet(chainId) });
    assert.equal(away.machine.view.status, 'wrong_network');
    assert.equal(m.heldAway(away.machine, env), true, `held on ${chainId}`);
    assert.equal(m.heldAway(away.machine, { ...env, chains: [4663] }), false, 'not where the page keeps no session');
    assert.equal(m.heldAway({ ...away.machine, flow: { kind: 'checking' } }, env), false, 'only at rest');
    assert.equal(m.heldAway({ ...away.machine, session: { ...away.machine.session, owner: '0x' + '9'.repeat(40) } }, env), false, 'only for its own account');
  }
  const elsewhere = then(m, env, start, { type: 'identity', identity: wallet(31337) });
  assert.equal(m.heldAway(elsewhere.machine, env), false, 'a network no deposit comes from: the session is closed');
  const ethereum = then(m, env, start, { type: 'identity', identity: wallet(1) });
  assert.equal(m.heldAway(ethereum.machine, { ...env, chains: [4663, 8453, 42161] }), false, 'not where the page keeps no session');
  const v1 = withV2(false, `${BUILD}session/machine.js`);
  const v1env = { origin: ORIGIN, checksum: getAddress, chains: v1.sessionChains(ORIGIN) };
  const v1start = signedIn(v1, v1env);
  assert.equal(v1.heldAway({ ...v1start.machine, identity: wallet(8453), view: { status: 'wrong_network', chainId: 8453 } }, { ...v1env, chains: [4663, 8453] }), false, 'a build without V2: never');
});

// ---------------------------------------------------------------------------
// The signature journal
// ---------------------------------------------------------------------------

const ENTRY = { chainId: 8453, owner: OWNER, space: 'permit2', verifier: '0x000000000022d473030f116ddee9f6b43ac78ba3', nonce: 2n ** 200n + 5n };

test('signature journal: recorded before a prompt, listed per chain and owner, forgotten on demand; public data only', async () => {
  const s = storage();
  const journal = createSignatureJournal(s, locks());
  await journal.record(ENTRY);
  assert.equal(journal.held(ENTRY), true);
  assert.equal(journal.held({ ...ENTRY, chainId: 4663 }), false, 'chains do not collide');
  assert.deepEqual(journal.list(8453, OWNER.toUpperCase().replace('0X', '0x')), [ENTRY]);
  assert.deepEqual(journal.list(42161, OWNER), []);
  const [[key, value]] = [...s.map.entries()];
  assert.match(key, /^domino\.signed-nonce\.v1\.[0-9a-f]{64}$/);
  const stored = JSON.parse(value);
  assert.deepEqual(Object.keys(stored).sort(), ['chainId', 'nonce', 'space', 'verifier', 'who']);
  assert.deepEqual({ ...stored, who: undefined }, { chainId: 8453, who: undefined, space: 'permit2', verifier: ENTRY.verifier, nonce: ENTRY.nonce.toString() });
  assert.match(stored.who, /^0x[0-9a-f]{64}$/);
  assert.equal(value.toLowerCase().includes(OWNER.slice(2).toLowerCase()), false, 'no address of the person in storage');
  assert.deepEqual(journal.list(8453, '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc'), [], 'another owner sees none of it');
  await journal.forget(ENTRY);
  assert.equal(journal.held(ENTRY), false);
  await assert.rejects(journal.record({ ...ENTRY, chainId: 1 }), /invalid_signature_nonce/);
  // A storage that does not keep what it is given refuses the signature.
  const refusing = { ...storage(), setItem() {} };
  await assert.rejects(createSignatureJournal(refusing, locks()).record(ENTRY), /signature_journal_unavailable/);
  // Something written under the prefix that is not exactly an entry is not listed.
  s.map.set(`domino.signed-nonce.v1.${'0'.repeat(64)}`, JSON.stringify({ ...stored, nonce: '1' }));
  s.map.set(`domino.signed-nonce.v1.${'1'.repeat(64)}`, JSON.stringify({ chainId: 8453, owner: OWNER, space: 'permit2', verifier: ENTRY.verifier, nonce: '1' }));
  assert.deepEqual(journal.list(8453, OWNER), []);
});

// ---------------------------------------------------------------------------
// Capabilities and the build modes
// ---------------------------------------------------------------------------

test('a V2 service opens only with the build, a manifest and the backend\'s word; none is on today', () => {
  const off = withV2(false, `${BUILD}v2/capabilities.js`);
  assert.deepEqual(off.serviceAvailability('s1', 4663), { open: false, reason: 'build_off', copy: 'Not available yet' });
  for (const service of ['s1', 's2', 'vault', 'autoExit']) for (const chainId of [4663, 8453, 42161]) assert.equal(off.V2_BACKEND_CAPABILITIES[service][chainId], false);
  const on = withV2(true, `${BUILD}v2/capabilities.js`);
  const { fixtureContracts } = require(`${BUILD}v2/manifestFixtures.js`);
  // Changed on purpose 2026-10-04 (V2 deployed, #327): Base's manifest is pinned, so the table's word decides, and it is
  // off (the live word is each service's route: src/v2/gate.ts serviceRouteOpen). The pinned set wins over a fixture.
  assert.deepEqual(on.serviceAvailability('s1', 8453), { open: false, reason: 'service_off', copy: 'Not available on Base yet' });
  assert.equal(on.serviceAvailability('s1', 8453, { fixtureContracts, backendOn: true }).reason, 'service_off', 'a test\'s backend word is for a fixture set, never the pinned one');
  // A chain with no pinned manifest (every chain before 2026-10-04; still one whose manifest fails a check), the map stood in for.
  const manifest = require(`${BUILD}v2/manifest.js`);
  const realAvailability = manifest.v2Availability;
  manifest.v2Availability = (chainId) => ({ available: false, copy: manifest.notAvailableCopy(chains.v2Chain(chainId)), reason: 'not_deployed' });
  try {
    assert.deepEqual(on.serviceAvailability('s1', 8453), { open: false, reason: 'not_deployed', copy: 'Not available on Base yet' });
    assert.deepEqual(on.serviceAvailability('s1', 8453, { fixtureContracts }).reason, 'service_off', 'a fixture manifest alone opens nothing');
    const open = on.serviceAvailability('s1', 8453, { fixtureContracts, backendOn: true });
    assert.equal(open.open, true);
    assert.equal(open.contracts.fixture, true, 'and what it opens is marked as a fixture');
  } finally {
    manifest.v2Availability = realAvailability;
  }
  assert.equal(on.serviceAvailability('s1', 99801).reason, 'chain_not_supported');
});

test('the build modes: production and development carry V2 with its pinned manifests; its test data stays out of every deployable build', async () => {
  const config = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');
  const rows = [...config.slice(config.indexOf('const MODES'), config.indexOf('} as const')).matchAll(/^\s+'?([a-z0-9-]+)'?: \{(.+)\},?$/gm)];
  const v2 = Object.fromEntries(rows.map(([, name, row]) => [name, /\bv2: true\b/.test(row) ? true : /\bv2: false\b/.test(row) ? false : null]));
  // Changed on purpose (data) 2026-10-02 (Domino V2 integration, item 6): the old fixture-only v2-preview mode is gone.
  // Changed on purpose (data) 2026-10-02 (Domino V2 integration): preview-v2 carries V2 too, never deployable
  // (tests/v2/preview-v2-build.test.mjs holds its row).
  // Changed on purpose 2026-10-04 (the owner: the site runs on Domino V2, deployed and pinned on every chain): production
  // and development carry it too, with the pinned production manifests only.
  assert.deepEqual(v2, { production: true, development: true, fixtures: false, 'bridge-test': false, 'wallet-test': false, 'consumer-test': false, 'v2-test': true, 'preview-v2': true, 'wallet-test-v2': true });
  assert.match(config, /__DOMINO_V2__: JSON\.stringify\(settings\.v2\)/);
  // The fixture sets: only the builds that carry V2 and are not deployable.
  assert.match(config, /__DOMINO_V2_FIXTURE_SETS__: JSON\.stringify\(settings\.v2 && !settings\.deployable\)/);
  const { assertDeployable, findForbidden } = await import('../../scripts/deploy-markers.mjs');
  const good = { read: 'bridge', pools: 'selected', deployable: true, outDir: 'dist', lab: false, wallet: true, testHooks: false, preview: false, depositLab: false };
  assert.doesNotThrow(() => assertDeployable('production', { ...good, v2: false }));
  assert.doesNotThrow(() => assertDeployable('production', { ...good, v2: true }), 'a deployable build may carry V2');
  assert.throws(() => assertDeployable('production', { ...good, v2: true, testHooks: true }), /switches on testHooks/, 'never its test hooks');
  assert.ok(findForbidden('<main data-v2-test-build="">').length > 0, 'V2\'s test screens never ship');
  assert.ok(findForbidden('<html data-v2-build="preview-v2">').length > 0, 'nor a build that took V2\'s test data');
});

test('the site\'s CSS never scans the V2 test screens; only a build with V2 on takes the exclusion out', () => {
  const tokens = readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8');
  // Changed on purpose (data) 2026-10-02 (Domino V2 integration, item 6): the old #/v2 screens (src/v2ui) and their line are gone.
  assert.doesNotMatch(tokens, /v2ui/);
  assert.match(tokens, /^@source not '\.\.\/v2in';$/m);
  const config = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');
  // Changed on purpose (data) 2026-10-02 (Domino V2 integration): beside it, the page's V2 mark (vite.config.ts v2BuildMark).
  // Changed on purpose 2026-10-04 (the owner: the site runs on V2): the mark only where the build is not deployable.
  assert.match(config, /plugins: \[react\(\), \.\.\.\(settings\.v2 \? \[v2ScreensCss\(\), \.\.\.\(settings\.deployable \? \[\] : \[v2BuildMark\(mode\)\]\)\] : \[\]\), tailwindcss\(\)/);
});
