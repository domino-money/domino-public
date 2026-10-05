/**
 * Base and Arbitrum One read by Domino's service (2026-10-06, rugged97's delta of 5 Oct, items 1-3: read-v6's live chain
 * reads chain-pools, chain-balances and chain-tokens, api-contracts/read-v6 README "Chain reads"), what is pure of it
 * (src/v2in/journey/model/chainReads.ts), on the package's own fixtures:
 *   - a chain-pools answer becomes today's pool rows: the pools Domino can open (hookless, a tier the network offers), in
 *     the answer's order, a v3 pool keyed by its address as a 32-byte word, the read's block and age;
 *   - the same answer names a pasted address's symbol and decimals, and reads one pool again;
 *   - a chain-balances answer gives a pool's two balances, and nothing for a network it could not read;
 *   - a chain-tokens answer becomes the search's rows, a token passing for USDC listed with a warning;
 *   - a test build's script serves the chain reads it scripts, and only those (src/v2in/dataSource.ts).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src/';
const reads = require(`${BUILD}v2in/journey/model/chainReads.js`);
const networks = require(`${BUILD}v2in/journey/model/networks.js`);
const dataSource = require(`${BUILD}v2in/dataSource.js`);
const v6 = require(`${BUILD}v2/read/v6.js`);
const runtime = await import('../../../api-contracts/read-v6/runtime.mjs');

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../../api-contracts/read-v6/fixtures/valid/${name}.json`, import.meta.url), 'utf8'));
const ZERO = '0x0000000000000000000000000000000000000000';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const LIVE = '0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e';
const chosen = networks.displayOf(8453, { address: LIVE, symbol: 'LIVE', decimals: 18 });

test('the fixtures used here are answers the contract accepts', () => {
  for (const [route, name] of [['chain-pools', 'chain-pools'], ['chain-pools', 'chain-pools-paired'], ['chain-balances', 'chain-balances-asked'], ['chain-tokens', 'chain-tokens'], ['chain-tokens', 'chain-tokens-usdc']]) {
    assert.equal(runtime.validateResponse(route, fixture(name)), true, name);
  }
});

test('chain-pools: the pools Domino can open, in the answer\'s order, keyed, read at the answer\'s block and age', () => {
  const answer = fixture('chain-pools');
  const receivedAt = 1_790_431_240_000;
  const rows = reads.poolsOfAnswer(8453, chosen, answer, receivedAt);
  assert.deepEqual(rows.map((row) => [row.dex, row.feePips, row.tickSpacing, row.fee]), [[3, 500, 10, '0.05%'], [4, 3000, 60, '0.30%']]);
  const [v3, v4] = rows;
  assert.equal(v3.key, `0x${'0'.repeat(24)}${answer.pools[0].address.slice(2)}`, 'a v3 pool: its address as a 32-byte word');
  assert.equal(v4.key, answer.pools[1].id, 'a v4 pool: its id');
  assert.deepEqual(v3.currencies.map((token) => [token.address, token.symbol, token.chainId]), [[WETH_BASE, 'WETH', 8453], [LIVE, 'LIVE', 8453]]);
  assert.equal(v3.currencies[1], chosen, 'the chosen token is kept as the journey holds it');
  assert.equal(v4.currencies[0].address, ZERO);
  assert.equal(v4.currencies[0].artwork, 'ETH', 'the network\'s own currencies as the profile names them');
  assert.equal(v3.tick, answer.pools[0].tick);
  assert.equal(v3.sqrtPriceX96, answer.pools[0].sqrtPriceX96);
  assert.equal(v3.block, answer.snapshot.number);
  assert.equal(v3.readAt, receivedAt - answer.freshness.ageSeconds * 1000, 'its age at the answer counts');
  // A pool with a hook, or on a tier this network does not offer for its version, is never a row.
  const odd = structuredClone(answer);
  odd.pools[0].pool.hooks = '0x1111111111111111111111111111111111110080';
  odd.pools[1].pool.tickSpacing = 61;
  assert.deepEqual(reads.poolsOfAnswer(8453, chosen, odd, receivedAt), []);
});

test('chain-pools names a pasted address\'s token, and reads one pool again', () => {
  const resolved = reads.resolvedOf(8453, LIVE.toUpperCase().replace('0X', '0x'), fixture('chain-pools'));
  assert.equal(resolved.ok, true);
  assert.deepEqual([resolved.token.address, resolved.token.symbol, resolved.token.decimals, resolved.token.chainId], [LIVE, 'LIVE', 18, 8453]);
  // A token whose decimals could not be read is never used.
  assert.deepEqual(reads.resolvedOf(8453, '0x6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f', fixture('chain-pools-none')), { ok: false, code: 'token_decimals_unknown', reason: 'This token doesn’t say how many decimals it has, so it can’t be used here.' });
  // Read again: the same pool in an answer about its pair, at that answer's price; gone from it, null.
  const rows = reads.poolsOfAnswer(8453, chosen, fixture('chain-pools'), 1_000_000);
  const paired = fixture('chain-pools-paired');
  paired.pools[0].tick = 13870;
  const again = reads.rereadOf(rows[0], networks.refOf(rows[0]), paired, 2_000_000);
  assert.equal(again.key, rows[0].key);
  assert.equal(again.tick, 13870);
  assert.deepEqual(again.currencies, rows[0].currencies);
  assert.equal(reads.rereadOf(rows[1], networks.refOf(rows[1]), paired, 2_000_000), null, 'the v4 pool is not in an answer about WETH');
});

test('chain-balances: a pool\'s two balances in pool order; a network not read gives none, never zeros', () => {
  const eth = networks.displayOf(8453, { address: ZERO, symbol: 'ETH', decimals: 18 });
  const pair = reads.balancesOfAnswer(8453, [eth, chosen], fixture('chain-balances-asked'));
  assert.deepEqual(pair.map((entry) => [entry.token.address, entry.fact.text, entry.raw]), [[ZERO, '0.1', '100000000000000000'], [LIVE, '7', '7000000000000000000']]);
  assert.deepEqual(reads.balanceTokens(8453, [eth, chosen]), [{ chainId: 8453, address: ZERO }, { chainId: 8453, address: LIVE }]);
  // Arbitrum One unavailable in the default answer: no balances at all for a pool there.
  const usdcArb = networks.displayOf(42161, { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', symbol: 'USDC', decimals: 6 });
  const ethArb = networks.displayOf(42161, { address: ZERO, symbol: 'ETH', decimals: 18 });
  assert.equal(reads.balancesOfAnswer(42161, [ethArb, usdcArb], fixture('chain-balances')), null);
  // Base read, but its WETH balance unavailable: that one has no figure, the other has its own.
  const weth = networks.displayOf(8453, { address: WETH_BASE, symbol: 'WETH', decimals: 18 });
  const usdc = networks.displayOf(8453, { address: USDC_BASE, symbol: 'USDC', decimals: 6 });
  const partial = reads.balancesOfAnswer(8453, [weth, usdc], fixture('chain-balances'));
  assert.deepEqual(partial.map((entry) => [entry.fact?.text ?? null, entry.raw]), [[null, null], ['2.5', '2500000']]);
});

test('chain-tokens: the search\'s rows, with their network; a token passing for USDC is listed with a warning', () => {
  const rows = reads.rowsOfTokens(8453, fixture('chain-tokens'));
  assert.deepEqual(rows.map((row) => [row.chainId, row.network, row.token.symbol, row.token.decimals, row.unread, row.warning ?? null]), [
    [8453, 'Base', 'AERO', 18, false, null],
    [8453, 'Base', 'AEROX', 18, false, null],
  ]);
  const usdc = reads.rowsOfTokens(8453, fixture('chain-tokens-usdc'));
  assert.equal(usdc[0].token.address, USDC_BASE);
  assert.equal(usdc[0].warning, undefined, 'the network\'s own USDC');
  const fake = fixture('chain-tokens-usdc');
  fake.tokens[0] = { ...fake.tokens[0], address: '0x9999999999999999999999999999999999999999', sources: ['looked_up'] };
  assert.equal(reads.rowsOfTokens(8453, fake)[0].warning, 'Not the USDC Domino uses');
  assert.equal(reads.lookalikeOf(8453, { address: '0x9999999999999999999999999999999999999999', symbol: ' weth ' }), 'WETH');
  assert.equal(reads.lookalikeOf(8453, { address: WETH_BASE, symbol: 'WETH' }), null);
  assert.deepEqual(['usdc', 'us', 'sd', 'aero'].map((query) => reads.symbolRank('USDC', query)), [0, 1, 2, 3]);
});

test('a test build\'s script serves the chain reads it scripts, answering by request, and only those', async () => {
  const deps = (script) => ({ runtimes: { read: runtime, plan: {} }, live: () => assert.fail('no live route under a script'), script: () => script });
  const gate = { mode: 'live' };
  const asked = [];
  const t = dataSource.createV2Transports(gate, deps({
    read6: {
      'chain-pools': (request) => {
        asked.push(request);
        return request.token === LIVE ? { status: 200, body: fixture('chain-pools') } : undefined;
      },
    },
  }));
  const state = await t.routeState('readV6');
  assert.deepEqual(state.routes, ['portfolio', 'activity', 'plan', 'chain-pools']);
  const reply = await v6.readChainPools(t.read, t.readRuntime, 8453, LIVE);
  assert.equal(reply.kind, 'ok');
  assert.deepEqual(asked, [{ chainId: 8453, token: LIVE }]);
  assert.deepEqual(await v6.readChainPools(t.read, t.readRuntime, 8453, USDC_BASE), { kind: 'unavailable', reason: 'network' }, 'a request the function leaves unscripted is refused');
  // Without chain reads scripted, today's routes alone, as before.
  const plain = dataSource.createV2Transports(gate, deps({ read6: { portfolio: { status: 200, body: fixture('portfolio') } } }));
  assert.deepEqual((await plain.routeState('readV6')).routes, ['portfolio', 'activity', 'plan']);
});
