/**
 * The day-9 trap (added 2026-11-06, Elysium readiness; audit item ADD-1). src/v2/chains.ts imported Elysium's placeholder
 * profile (api-contracts/v2/chains/elysium.json) at build time, and rugged97's enabling change replaces that file with
 * elysium-<id>.json in the same pull request (docs/v2/QUALIFY_CHAIN.md, "It replaces elysium.json"), so the app's build
 * would have broken on his merge. Now:
 *   - no app source imports any profile but the three of the app's one list (a build holds either layout);
 *   - the chains served from a profiles directory are the listed ones, whichever of the two layouts it has, and a profile
 *     of a chain id the app does not list (enabled or not, well formed or not) is ignored, never served, never a crash;
 *   - with Elysium's facts attached to the synthetic profile's id (what docs/ELYSIUM_DAY9.md does with the real one),
 *     the same code serves it as a fourth chain, HYPE-native.
 * The layouts use the fixtures in tests/fixtures/v2-chains: a copy of today's placeholder, and a synthetic enabled
 * HYPE-native profile in the shape of rugged97's backend/tests/v2_hype_chain.py (testnet 99801 facts, Arbitrum One's
 * Uniswap as stand-ins).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const chains = require('../../.test-build/app/src/v2/chains.js');
const { ELYSIUM } = require('../../.test-build/app/src/v2/elysium.js');
const identity = require('../../.test-build/app/src/config/chainIdentity.js');

const APP = fileURLToPath(new URL('../../', import.meta.url));
const PROFILES = join(APP, '..', 'api-contracts', 'v2', 'chains');
const FIXTURES = join(APP, 'tests', 'fixtures', 'v2-chains');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const listed = ['robinhood-4663.json', 'base-8453.json', 'arbitrum-42161.json'].map((name) => json(join(PROFILES, name)));
const placeholder = json(join(FIXTURES, 'elysium.json'));
const enabled = json(join(FIXTURES, 'elysium-99801.json'));
const ids = (served) => served.map((chain) => [chain.chainId, chain.slug, chain.name, chain.nativeSymbol, chain.wrappedNative.symbol]);
const TODAY = [[4663, 'robinhood', 'Robinhood Chain', 'ETH', 'WETH'], [8453, 'base', 'Base', 'ETH', 'WETH'], [42161, 'arbitrum', 'Arbitrum One', 'ETH', 'WETH']];

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : /\.(?:ts|tsx|mts|mjs|js)$/.test(entry.name) ? [path] : [];
  });
}

test('the app imports the profiles of its three chains by name, and none of Elysium, so either layout builds', () => {
  const found = [];
  for (const path of [...sources(join(APP, 'src')), ...sources(join(APP, 'functions')), ...sources(join(APP, 'scripts'))]) {
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(/(?:from|import\()\s*['"]([^'"]*api-contracts\/v2\/chains\/[^'"]+)['"]/g)) found.push([relative(APP, path).replaceAll('\\', '/'), match[1].replace(/^(?:\.\.\/)+/, '')]);
  }
  const files = [...new Set(found.map(([, file]) => file))].sort();
  assert.deepEqual(files, ['api-contracts/v2/chains/arbitrum-42161.json', 'api-contracts/v2/chains/base-8453.json', 'api-contracts/v2/chains/robinhood-4663.json']);
  assert.equal(found.some(([, file]) => /elysium/i.test(file)), false);
  // No build configuration names a profile either.
  for (const name of readdirSync(APP).filter((file) => /^(?:tsconfig.*\.json|vite\.config\..*)$/.test(file))) {
    assert.doesNotMatch(readFileSync(join(APP, name), 'utf8'), /v2\/chains\/elysium/, name);
  }
});

test('today\'s layout (the disabled placeholder), the day-9 layout (elysium-<id>.json) and both at once serve the same three chains', () => {
  for (const [label, extra] of [['today', [placeholder]], ['day 9', [enabled]], ['both', [placeholder, enabled]], ['neither', []]]) {
    const served = chains.chainsFrom([...listed, ...extra], identity.V2_CHAIN_IDS, chains.V2_CHAIN_FACTS);
    assert.deepEqual(ids(served), TODAY, label);
    assert.deepEqual(served, chains.V2_CHAINS, `${label}: exactly what the app serves`);
  }
  // Whatever the real directory holds when the tests run (today: the placeholder; on day 9: elysium-<id>.json).
  const directory = readdirSync(PROFILES).filter((name) => name.endsWith('.json')).map((name) => json(join(PROFILES, name)));
  assert.deepEqual(ids(chains.chainsFrom(directory, identity.V2_CHAIN_IDS, chains.V2_CHAIN_FACTS)), TODAY);
});

test('a profile of a chain the app does not list is ignored, however it is written; a listed chain without a good profile still fails', () => {
  const odd = [null, 'elysium', 7, [], {}, { chainId: null, enabled: true }, { chainId: '99801' }, { chainId: 12345, enabled: true }, { chainId: 99801, enabled: true, nativeSymbol: 'HYPE' }, enabled];
  assert.deepEqual(ids(chains.chainsFrom([...odd, ...listed], identity.V2_CHAIN_IDS, chains.V2_CHAIN_FACTS)), TODAY);
  const [robinhood, base, arbitrum] = listed;
  assert.throws(() => chains.chainsFrom([robinhood, base], identity.V2_CHAIN_IDS, chains.V2_CHAIN_FACTS), /chainId 42161 has no profile/);
  assert.throws(() => chains.chainsFrom([...listed, base], identity.V2_CHAIN_IDS, chains.V2_CHAIN_FACTS), /chainId 8453 twice/);
  assert.throws(() => chains.chainsFrom([robinhood, base, { ...arbitrum, enabled: false }], identity.V2_CHAIN_IDS, chains.V2_CHAIN_FACTS), /arbitrum is incomplete/);
  assert.throws(() => chains.chainsFrom([robinhood, base, { ...arbitrum, slug: 'elysium' }], identity.V2_CHAIN_IDS, chains.V2_CHAIN_FACTS), /slug elysium/);
  // A listed id with no row of facts is refused: the app never serves a chain it holds no words for.
  assert.throws(() => chains.chainsFrom([...listed, enabled], [...identity.V2_CHAIN_IDS, 99801], chains.V2_CHAIN_FACTS), /chainId 99801 has no facts/);
});

test('the rank rule: rank 2 is the chain\'s own native currency and wrapped token, rank 1 its one stable; anything else is refused', () => {
  const arbitrum = listed[2];
  const facts = chains.V2_CHAIN_FACTS;
  const withCurrencies = (chargeCurrencies) => [listed[0], listed[1], { ...arbitrum, chargeCurrencies }];
  const [stable, eth, weth] = arbitrum.chargeCurrencies;
  assert.doesNotThrow(() => chains.chainsFrom(withCurrencies([weth, stable, eth]), identity.V2_CHAIN_IDS, facts), 'the order of the list is not the rule');
  for (const bad of [
    [stable, eth],
    [stable, eth, weth, { ...stable, symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' }],
    [{ ...stable, rank: 2 }, eth, weth],
    [stable, { ...eth, symbol: 'HYPE' }, weth],
    [stable, eth, { ...weth, symbol: 'WHYPE' }],
    [stable, { ...eth, native: false }, weth],
    [stable, eth, { ...weth, address: stable.address }],
    [stable, { ...eth, rank: 3 }, weth],
  ]) assert.throws(() => chains.chainsFrom(withCurrencies(bad), identity.V2_CHAIN_IDS, facts), /arbitrum charge currencies/);
  // Robinhood's, Base's and Arbitrum One's ranks stay what they were.
  for (const chain of chains.V2_CHAINS) {
    assert.deepEqual(chain.chargeCurrencies.map((c) => [c.rank, c.symbol, c.native]), [[1, chain.chainId === 4663 ? 'USDG' : 'USDC', false], [2, 'ETH', true], [2, 'WETH', false]]);
  }
});

test('with Elysium\'s facts attached to the synthetic id, the same code serves a HYPE-native chain, last, on Nitro', () => {
  const facts = { ...chains.V2_CHAIN_FACTS, 99801: { slug: ELYSIUM.slug, name: ELYSIUM.name, nativeSymbol: ELYSIUM.nativeSymbol, wrappedSymbol: ELYSIUM.wrappedSymbol, finalityMinutes: ELYSIUM.finalityMinutes } };
  const served = chains.chainsFrom([...listed, placeholder, enabled], [...identity.V2_CHAIN_IDS, 99801], facts);
  assert.deepEqual(ids(served), [...TODAY, [99801, 'elysium', 'Elysium', 'HYPE', 'WHYPE']]);
  const hype = served[3];
  assert.equal(hype.hex, '0x185d9');
  assert.equal(hype.wrappedNative.address, '0xcd57f65c2b0e5881cfc2e609f7cd53b746e1f234');
  assert.deepEqual(hype.chargeCurrencies.map((c) => [c.rank, c.symbol, c.native]), [[1, 'USDC', false], [2, 'HYPE', true], [2, 'WHYPE', false]]);
  assert.deepEqual([chains.profileRank(hype, '0x0000000000000000000000000000000000000000'), chains.profileRank(hype, hype.wrappedNative.address), chains.profileRank(hype, hype.chargeCurrencies[0].address), chains.profileRank(hype, listed[2].wrappedNative.address)], [2, 2, 1, 0]);
  assert.deepEqual([hype.stack, hype.ordering, hype.l1FeeInReceipt, hype.l1FeeOracle, hype.finality.aboutMinutes], ['arbitrum-nitro', 'arrival', false, null, 12]);
  assert.deepEqual([chains.nativeArtwork(hype), chains.wrappedArtwork(hype)], [null, null], 'no Ether picture for HYPE');
  assert.deepEqual([chains.nativeArtwork(served[0]), chains.wrappedArtwork(served[0])], ['ETH', 'WETH']);
  // The profile's own name ("Elysium (synthetic test fixture)") is not what a screen says: the app's one name is.
  assert.equal(enabled.name === hype.name, false);
  // A HYPE-native profile is refused under Ether's facts: the facts are the app's word, not the profile's.
  assert.throws(() => chains.chainsFrom([...listed, enabled], [...identity.V2_CHAIN_IDS, 99801], { ...chains.V2_CHAIN_FACTS, 99801: { ...chains.V2_CHAIN_FACTS[42161], slug: 'elysium' } }), /elysium native/);
});

test('the served list is still the three, and the helpers say Ether for every network the app reads today', () => {
  assert.deepEqual(ids(chains.V2_CHAINS), TODAY);
  assert.deepEqual([...identity.V2_CHAIN_IDS], [4663, 8453, 42161]);
  assert.deepEqual([4663, 8453, 42161, 1, 10, 99801].map(chains.nativeSymbolOf), ['ETH', 'ETH', 'ETH', 'ETH', 'ETH', 'ETH']);
  assert.equal(Object.isFrozen(chains.V2_CHAINS) && Object.isFrozen(chains.V2_CHAIN_FACTS), true);
});
