/**
 * A chain with Uniswap v4 alone through the screens' modules (added 2026-11-06, Elysium readiness; rugged97's #459 and
 * "delta 2"): nothing of v3 is offered, planned, built or asked there, and the services' invalid_request for such a
 * request is said as "not available on this network", never a fault and never asked again.
 *
 * As tests/v2/hype-chain.test.mjs does, this hands the modules a copy of src/v2/chains.js that also serves the test-only
 * fixture tests/fixtures/v2-chains/elysium-99901.json (chain 99901, `uniswap.v3` null, HYPE native) with Elysium's
 * facts, through Node's module cache, before any of them loads (each test file runs in a process of its own). Nothing of
 * the app changes for it; the app's own list is still the three (tests/v2/v4-only-chain.test.mjs). Each check also runs
 * on Base, whose v3 must stay exactly as it was.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { test } from 'node:test';
import { ELYSIUM_FORCED, loadWith } from './support/elysium-live.mjs';
import ts from 'typescript';
import * as planRuntime from '../../../api-contracts/position-plan-v1/runtime.mjs';
import { v4OnlyManifest } from './support/v4-only.mjs';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src/';
const CHAINS_PATH = require.resolve(`${BUILD}v2/chains.js`);
const real = require(CHAINS_PATH);
const { ELYSIUM } = require(`${BUILD}v2/elysium.js`);
const identity = require(`${BUILD}config/chainIdentity.js`);
const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const listed = ['robinhood-4663', 'base-8453', 'arbitrum-42161'].map((name) => json(`../../../api-contracts/v2/chains/${name}.json`));
const profile = json('../fixtures/v2-chains/elysium-99901.json');

const ID = 99901;
const FACTS = { ...real.V2_CHAIN_FACTS, [ID]: { slug: ELYSIUM.slug, name: ELYSIUM.name, nativeSymbol: ELYSIUM.nativeSymbol, wrappedSymbol: ELYSIUM.wrappedSymbol, finalityMinutes: ELYSIUM.finalityMinutes, dexes: ELYSIUM.dexes } };
const SERVED = real.chainsFrom([...listed, profile], [...identity.V2_CHAIN_IDS, ID], FACTS);
const v4only = SERVED[3];
const base = SERVED[1];
const ZERO = '0x0000000000000000000000000000000000000000';

// The screens' copy of the chains module: the same functions over the four chains.
const find = (chainId) => SERVED.find((chain) => chain.chainId === chainId);
const served = {
  ...real,
  V2_CHAINS: SERVED,
  isV2ChainId: (value) => typeof value === 'number' && find(value) !== undefined,
  v2Chain: (chainId) => { const chain = find(chainId); if (!chain) throw new Error('chain_not_supported'); return chain; },
  nativeSymbolOf: (chainId) => find(chainId)?.nativeSymbol ?? 'ETH',
  chainHasDex: (chainId, dex) => { const chain = find(chainId); return chain !== undefined && real.hasDex(chain, dex); },
};
const stub = new Module(CHAINS_PATH);
Object.assign(stub, { filename: CHAINS_PATH, loaded: true, exports: served });
require.cache[CHAINS_PATH] = stub;

const pools = require(`${BUILD}v2in/journey/model/pools.js`);
const networks = require(`${BUILD}v2in/journey/model/networks.js`);
const chainReads = require(`${BUILD}v2in/journey/model/chainReads.js`);
const lists = require(`${BUILD}v2in/lists/model.js`);
const read = require(`${BUILD}v2in/lists/read.js`);
const { canCloseTogether } = require(`${BUILD}v2in/lists/closeGroups.js`);
const { setupEligibility } = require(`${BUILD}v2in/automate/setupPositions.js`);
const { snapshotFromRead6 } = require(`${BUILD}v2in/automate/portfolio.js`);
const plan = require(`${BUILD}finance/v2/plan.js`);
const client = require(`${BUILD}v2/plan/client.js`);
const { createS1PlanFixtureTransport } = require(`${BUILD}v2/plan/fixtureTransport.js`);
const positionErrors = require(`${BUILD}v2in/position/errors.js`);
const { LEG_KIND } = require(`${BUILD}v2/types.js`);
const manifest = require(`${BUILD}v2/manifest.js`);
const { createZapClient } = require(`${BUILD}finance/v2/zap.js`);

/** New position's error words (src/v2in/journey/errors.ts), compiled here: the module reaches the wallet, which this file stubs. */
function journeyErrors() {
  const path = new URL('../../src/v2in/journey/errors.ts', import.meta.url);
  const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const at = (name) => require(name.startsWith('./') ? `${BUILD}v2in/journey/${name.slice(2)}.js` : `${BUILD}${name.replace(/^(\.\.\/)+/, '')}.js`);
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)((name) => (name === './wallet' ? { JourneyNotice: class extends Error {} } : at(name)), mod, mod.exports);
  return mod.exports;
}

const contractFixture = (name) => json(`../../../api-contracts/read-v6/fixtures/valid/${name}.json`);
const USDC = v4only.chargeCurrencies[0].address;
const TOKEN = '0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e';

test('New position: no v3 fee tier and no v3 pool to read or open there; Base keeps both', () => {
  assert.deepEqual(pools.tiersOf(ID, 3), []);
  assert.deepEqual(pools.tiersOf(ID, 4), pools.tiersOf(8453, 4));
  assert.ok(pools.tiersOf(8453, 3).length >= 4, 'Base\'s v3 tiers, its extra ones included');
  const asked = networks.poolsToRead(ID, TOKEN);
  assert.ok(asked.length > 0);
  assert.deepEqual([...new Set(asked.map((pool) => pool.dex))], [4], 'only v4 pools are asked');
  assert.deepEqual([...new Set(networks.poolsToRead(8453, TOKEN).map((pool) => pool.dex))].sort(), [3, 4]);
  // A chain-pools answer naming a v3 pool there: only its v4 pools become rows.
  const answer = { ...contractFixture('chain-pools'), chainId: ID };
  const chosen = networks.displayOf(ID, { address: TOKEN, symbol: 'LIVE', decimals: 18 });
  const onBase = chainReads.poolsOfAnswer(8453, networks.displayOf(8453, { address: TOKEN, symbol: 'LIVE', decimals: 18 }), contractFixture('chain-pools'), 1_790_431_240_000);
  assert.deepEqual(onBase.map((row) => row.dex), [3, 4], 'Base: as tests/v2/chain-reads.test.mjs reads it');
  assert.deepEqual(chainReads.poolsOfAnswer(ID, chosen, answer, 1_790_431_240_000).map((row) => row.dex).filter((dex) => dex === 3), []);
});

test('lists: a v3 position there is no row, no close group and no automation offer; Base\'s are as before', () => {
  const body = structuredClone(contractFixture('portfolio'));
  const plain = body.positions.find((position) => position.tokenId === '9');
  const v3 = { ...structuredClone(plain), chainId: ID, dex: 3, tokenId: '99', positionManager: listed[2].uniswap.v3.positionManager.toLowerCase(), vault: null };
  const before = lists.positionRows(body, () => true).map((row) => row.key);
  const after = lists.positionRows({ ...body, positions: [...body.positions, v3] }, () => true).map((row) => row.key);
  // Left out before anything else: its route (src/v2in/route.ts) names no slug for 99901 until day 9, so a row built for
  // it would have thrown (invalid_position_ref), as a v4 one there still does today.
  assert.deepEqual(after, before, 'the v3 position on the v4-only chain is left out');
  const v4 = { ...v3, dex: 4, tokenId: '98', positionManager: v4only.uniswap.v4.positionManager };
  assert.throws(() => lists.positionRows({ ...body, positions: [...body.positions, v4] }, () => true), /invalid_position_ref/);
  // The same position on Base is a row (its chain has v3).
  const onBase = { ...v3, chainId: 8453, positionManager: base.uniswap.v3.positionManager };
  assert.equal(lists.positionRows({ ...body, positions: [...body.positions, onBase] }, () => true).length, before.length + 1);
  // Closing together and setting up automation.
  const row = { chainId: ID, dex: 3, status: 'live', tab: 'open', hooked: false, vault: null, positionManager: listed[2].uniswap.v3.positionManager.toLowerCase() };
  assert.equal(canCloseTogether(row), false);
  assert.equal(canCloseTogether({ ...row, chainId: 8453, positionManager: base.uniswap.v3.positionManager }), true);
  const wallet = body.wallet;
  assert.equal(setupEligibility({ ...body, wallet }, wallet, v3), 'unsupported');
  // A listed v3 vault there is no vault of that chain.
  const listedVault = { chainId: ID, dex: 3, state: { status: 'read' } };
  assert.equal(snapshotFromRead6(listedVault, body, ID, wallet), null);
});

test('plans: a v3 pool or a v3 swap path is refused there, and no zap is named; Base\'s v3 stays planned', () => {
  const [a, b] = [USDC, real.v2Chain(42161).wrappedNative.address].map((x) => x.toLowerCase()).sort();
  const v3pool = { dex: 3, currency0: a, currency1: b, fee: 500, tickSpacing: 10, hooks: ZERO };
  assert.deepEqual(plan.poolProblems(v3pool, v4only), ['plan_pool_dex']);
  assert.deepEqual(plan.poolProblems({ ...v3pool, dex: 4 }, v4only), []);
  assert.deepEqual(plan.poolProblems(v3pool, base), []);
  const set = { chainId: ID, addresses: { registry: '0x00000000000000000000000000000000d0d00001', autoExit: '0x00000000000000000000000000000000d0d00002', priceAnchor: '0x00000000000000000000000000000000d0d00007', zapV4: '0x00000000000000000000000000000000d0d00004', vaultFactoryV4: '0x00000000000000000000000000000000d0d00006' }, codeHashes: {}, fixture: true };
  assert.equal(plan.zapFor(set, ID, v3pool), null);
  assert.equal(plan.zapFor(set, ID, { ...v3pool, dex: 4 }), set.addresses.zapV4);
  const path = `0x${a.slice(2)}0001f4${b.slice(2)}`;
  const leg = { kind: LEG_KIND.v3Path, router: ZERO, tokenIn: a, tokenOut: b, amountIn: 1n, minAmountOut: 1n, data: path };
  assert.ok(plan.legProblems([leg], v4only, () => 212).includes('plan_leg_kind'));
  assert.deepEqual(plan.legProblems([leg], base, () => 212), []);
});

test('the plan service is never asked about v3 there: its own invalid_request, given without sending; Base\'s is sent', async () => {
  const exit = (chainId, dex) => ({ chainId, action: 'exit', consent: 'direct', position: { dex, tokenId: 7n }, liquidityToRemove: 'all', burn: true, receive: 'both', slippageBps: 50 });
  const context = { owner: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', zaps: { 4: '0x' + 'd4'.repeat(20) }, permit2: v4only.permit2, managers: real.positionManagers(v4only) };
  const transport = createS1PlanFixtureTransport();
  assert.deepEqual(client.planOffNetwork(exit(ID, 3)), true);
  assert.deepEqual(client.planOffNetwork(exit(ID, 4)), false);
  assert.deepEqual(client.planOffNetwork(exit(8453, 3)), false);
  assert.equal(client.planDex({ pool: { dex: 3 } }), 3);
  assert.deepEqual(await client.requestS1Plan(transport, planRuntime, exit(ID, 3), context), { kind: 'refused', code: 'invalid_request', status: planRuntime.ERROR_STATUS_BY_CODE.invalid_request });
  assert.equal(transport.calls().length, 0, 'never sent');
  // (Today's package names the three chains only; rugged97's day-9 version names Elysium too.)
  await client.requestS1Plan(transport, { ...planRuntime, validateRequest: () => true }, exit(ID, 4), context);
  assert.equal(transport.calls().length, 1, 'a v4 request there is sent');
  await client.requestS1Plan(transport, planRuntime, exit(8453, 3), { ...context, zaps: { 3: '0x' + 'd3'.repeat(20), 4: '0x' + 'd4'.repeat(20) }, managers: real.positionManagers(base) });
  assert.equal(transport.calls().length, 2, 'Base\'s v3 request is sent as before');
  // Added 2026-11-06 (review F5): only a real version a served chain lacks is "off the network". A version that does not
  // exist (a screen's bug), on any chain, and a chain V2 does not serve stay the request's own fault, as before: `invalid`.
  for (const [chainId, dex] of [[8453, 2], [4663, 5], [ID, 2], [99999, 3]]) {
    assert.equal(client.planOffNetwork(exit(chainId, dex)), false, `${chainId} v${dex}`);
    assert.equal(client.versionOffChain(chainId, dex), false, `${chainId} v${dex}`);
    const said = await client.requestS1Plan(transport, planRuntime, exit(chainId, dex), context);
    assert.equal(said.kind, 'invalid', `${chainId} v${dex}: ${JSON.stringify(said)}`);
  }
  assert.deepEqual([client.versionOffChain(ID, 3), client.versionOffChain(ID, 4), client.versionOffChain(8453, 3), client.versionOffChain(ID, '3')], [true, false, false, false]);
  assert.equal(transport.calls().length, 2, 'none of them is sent');
});

test('invalid_request about a version the chain lacks reads "Not available on Elysium right now.", never again; any other as before', () => {
  const refused = { kind: 'refused', code: 'invalid_request', status: 400 };
  const journey = journeyErrors();
  for (const planFailure of [positionErrors.planFailure, journey.planFailure]) {
    assert.deepEqual(planFailure(refused, ID, undefined, 3), { copy: 'Not available on Elysium right now.', code: 'position_plan_dex_not_on_chain', recovery: 'none' });
    // The same refusal about v4 there, about v3 on Base, or with no version named: the words it always had.
    // (Review F5) Nor about a version that does not exist, on Base or there: the screen's bug keeps its own words.
    for (const [chainId, dex] of [[ID, 4], [8453, 3], [8453, undefined], [8453, 2], [ID, 2], [4663, 5]]) {
      const said = planFailure(refused, chainId, undefined, dex);
      assert.deepEqual([said.copy, said.code, said.recovery], ['Something in this request isn’t valid. Review and try again.', 'invalid_request', 'none'], `${chainId} v${dex}`);
    }
    // A chain the planner does not serve says the same words: no new text.
    assert.equal(planFailure({ kind: 'refused', code: 'position_plan_chain_unavailable', status: 503 }, ID).copy, 'Not available on Elysium right now.');
  }
});

test('position-fees: never asked about a v3 position there; its answer is not available there and never asked again', () => {
  assert.equal(read.offNetwork(ID, [{ dex: 3 }]), true);
  assert.equal(read.offNetwork(ID, [{ dex: 4 }, { dex: 3 }]), true);
  assert.equal(read.offNetwork(ID, [{ dex: 4 }]), false);
  assert.equal(read.offNetwork(8453, [{ dex: 3 }, { dex: 4 }]), false);
  assert.deepEqual({ ...read.OFF_NETWORK }, { kind: 'unavailable', reason: 'dex_not_on_chain' });
  assert.equal(read.offNetworkReply(read.OFF_NETWORK), true);
  // Any other refusal keeps its wait: read-v6's own invalid_request too.
  for (const reply of [{ kind: 'unavailable', reason: 'invalid_request' }, { kind: 'unavailable', reason: 'network' }, { kind: 'ok', body: {} }]) {
    assert.equal(read.offNetworkReply(reply), false, JSON.stringify(reply));
  }
  assert.equal(read.readAgainAfter({ kind: 'unavailable', reason: 'invalid_request' }, 1), 5_000);
});

// Added 2026-11-06 (review of the v4-only build, F1): the S1 client on a chain with v4 alone. Its v4 zap's signature nonces
// are its own (nonceHome asked zapOf(3) first and threw plan_pool_dex there, so a held v4 nonce could be neither cancelled
// nor settled), and a v3 approval, revoke or zap nonce is refused before the wallet is asked anything.
test('the S1 client there: the nonces of its v4 zap are its own, and nothing of v3 asks the wallet anything', async () => {
  const arbitrum = json('../../src/v2/fixtures/manifest.arbitrum-42161.fixture.json');
  const set = manifest.bindV2Deployment(v4OnlyManifest(arbitrum, profile, ID), v4only, profile, 'fork-rehearsal');
  assert.equal(set.addresses.zapV3, undefined, 'no v3 zap in its set');
  const owner = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
  const asked = [];
  const wallet = {
    owner, current: () => true, chainId: () => ID,
    request: async (method) => { asked.push(method); throw new Error('not_in_this_test'); },
    signatures: { held: () => false, record: async () => {}, forget: async () => {}, list: () => [] },
    nonceOffered: () => false, claimNonce: async () => 'token', releaseRejectedNonce: async () => {},
  };
  const zap = createZapClient(wallet, v4only, set, () => 1_800_000_000);
  const entry = (verifier) => ({ chainId: ID, owner, space: 'zap', verifier, nonce: 7n });
  // Its own v4 zap's nonce is this client's: it is then refused only because the journal does not hold it.
  await assert.rejects(zap.prepareCancelNonce(entry(set.addresses.zapV4)), /nonce_not_held/);
  // Another contract's (the v3 zap's address on the other chains) is not this client's.
  const v3Zap = manifest.v2Availability(42161).contracts.addresses.zapV3;
  await assert.rejects(zap.prepareCancelNonce(entry(v3Zap)), /nonce_not_this_clients/);
  for (const [name, call] of [['positionApproval', () => zap.positionApproval(3, 1n)], ['prepareRevoke', () => zap.prepareRevoke(3, 1n)], ['chooseNonce', () => zap.chooseNonce('zap', 3)]]) {
    await assert.rejects(call(), /plan_pool_dex/, name);
  }
  // A version that is none at all keeps its own refusal.
  await assert.rejects(zap.positionApproval(2, 1n), /invalid_position_id/);
  assert.deepEqual(asked, [], 'the wallet was asked nothing');
});

// Added 2026-11-07 (Elysium's screens; docs/ELYSIUM_DAY9.md section 7): turned around where the build serves Elysium. Its
// route names it (src/v2in/route.ts `elysium`), so a v4 position there is a row of its own, linked to its own page; a v3 one
// there is still no row; Base's are as before.
test('where the build serves Elysium, a v4 position there is a row with its own page; a v3 one is still none', () => {
  const on = loadWith(require, ELYSIUM_FORCED, () => require(`${BUILD}v2in/lists/model.js`));
  const body = structuredClone(contractFixture('portfolio'));
  const plain = body.positions.find((position) => position.tokenId === '9');
  const v4 = { ...structuredClone(plain), chainId: ID, dex: 4, tokenId: '98', positionManager: profile.uniswap.v4.positionManager.toLowerCase(), vault: null };
  const v3 = { ...v4, dex: 3, tokenId: '99', positionManager: listed[2].uniswap.v3.positionManager.toLowerCase() };
  const before = on.positionRows(body, () => true).map((row) => row.key);
  const rows = on.positionRows({ ...body, positions: [...body.positions, v4, v3] }, () => true);
  assert.equal(rows.length, before.length + 1, 'the v4 position is a row; the v3 one is left out');
  const row = rows.find((entry) => entry.chainId === ID);
  assert.equal(row.href, '#/positions/elysium-v4-98');
  assert.equal(row.dex, 4);
});
