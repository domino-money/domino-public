/**
 * A HYPE-native chain through the app (added 2026-11-06, Elysium readiness; audit items NET-4 and ADD-1). Elysium's
 * mainnet has no chain id, profile or deployment yet, so this runs a synthetic one: the enabled HYPE-native profile in
 * tests/fixtures/v2-chains/elysium-99801.json (testnet 99801 facts, the shape of rugged97's backend/tests/v2_hype_chain.py)
 * with Elysium's facts (src/v2/elysium.ts), served by the app's own parser (chainsFrom).
 *
 * The app's chain list is the real one: this file hands the synthetic chain to the screens' modules by putting a copy
 * of src/v2/chains.js that also serves it in Node's module cache, before any of them loads (each test file runs in a
 * process of its own). Nothing of the app is changed for it. What it proves:
 *   - the chain model accepts it, and its charge currencies rank as the spec says (1 its USDC, 2 HYPE and WHYPE);
 *   - its native and wrapped symbols reach the screens' words (token books, labels, network fees, errors, marks);
 *   - Robinhood Chain, Base and Arbitrum One read exactly as before;
 *   - and, in the app as it is, it is in no list: not V2_CHAINS, not isV2ChainId, not a picker, not a name table.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { test } from 'node:test';
import { ELYSIUM_FORCED, loadWith } from './support/elysium-live.mjs';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src/';
const CHAINS_PATH = require.resolve(`${BUILD}v2/chains.js`);
const real = require(CHAINS_PATH);
const { ELYSIUM } = require(`${BUILD}v2/elysium.js`);
const identity = require(`${BUILD}config/chainIdentity.js`);
const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const listed = ['robinhood-4663', 'base-8453', 'arbitrum-42161'].map((name) => json(`../../../api-contracts/v2/chains/${name}.json`));
const fixture = json('../fixtures/v2-chains/elysium-99801.json');

const HYPE_ID = 99801;
const FACTS = { ...real.V2_CHAIN_FACTS, [HYPE_ID]: { slug: ELYSIUM.slug, name: ELYSIUM.name, nativeSymbol: ELYSIUM.nativeSymbol, wrappedSymbol: ELYSIUM.wrappedSymbol, finalityMinutes: ELYSIUM.finalityMinutes } };
const SERVED = real.chainsFrom([...listed, fixture], [...identity.V2_CHAIN_IDS, HYPE_ID], FACTS);
const hype = SERVED[3];
const ZERO = '0x0000000000000000000000000000000000000000';
const WHYPE = hype.wrappedNative.address;
const USDC = hype.chargeCurrencies[0].address;

// The screens' copy of the chains module: the same functions over the four chains.
const find = (chainId) => SERVED.find((chain) => chain.chainId === chainId);
const served = {
  ...real,
  V2_CHAINS: SERVED,
  isV2ChainId: (value) => typeof value === 'number' && find(value) !== undefined,
  v2Chain: (chainId) => { const chain = find(chainId); if (!chain) throw new Error('chain_not_supported'); return chain; },
  nativeSymbolOf: (chainId) => find(chainId)?.nativeSymbol ?? 'ETH',
};
const stub = new Module(CHAINS_PATH);
Object.assign(stub, { filename: CHAINS_PATH, loaded: true, exports: served });
require.cache[CHAINS_PATH] = stub;

const errors = require(`${BUILD}v2/errors.js`);
const present = require(`${BUILD}v2/plan/present.js`);
const positionTokens = require(`${BUILD}v2in/position/tokens.js`);
const journeyTokens = require(`${BUILD}v2in/journey/tokens.js`);
const marks = require(`${BUILD}v2in/position/marks.js`);
const positionErrors = require(`${BUILD}v2in/position/errors.js`);
const automateCopy = require(`${BUILD}v2in/automate/copy.js`);
const fundsModel = require(`${BUILD}v2in/funds/model.js`);
const lists = require(`${BUILD}v2in/lists/model.js`);
const networks = require(`${BUILD}v2in/journey/model/networks.js`);
const positionCopy = require(`${BUILD}v2in/position/copy.js`);
const journeyCopy = require(`${BUILD}v2in/journey/copy.js`);
const { usdMissingShort } = require(`${BUILD}v2in/position/usdAvailability.js`);

test('the chain model accepts a HYPE-native chain and ranks its charge currencies: 1 its stable, 2 HYPE and WHYPE', () => {
  assert.deepEqual([hype.chainId, hype.slug, hype.name, hype.nativeSymbol, hype.wrappedNative.symbol, hype.nativeUsd], [HYPE_ID, 'elysium', 'Elysium', 'HYPE', 'WHYPE', 'pool']);
  assert.deepEqual(hype.bridgeProviders, [], 'no bridge serves it yet: Bring funds stays off there');
  assert.deepEqual(hype.chargeCurrencies.map((c) => [c.rank, c.symbol, c.address, c.native]), [[1, 'USDC', USDC, false], [2, 'HYPE', ZERO, true], [2, 'WHYPE', WHYPE, false]]);
  assert.deepEqual([ZERO, WHYPE, USDC, real.V2_CHAINS[2].wrappedNative.address].map((token) => real.profileRank(hype, token)), [2, 2, 1, 0]);
  // The other three keep Chainlink and their bridges.
  assert.deepEqual(real.V2_CHAINS.map((chain) => [chain.nativeUsd, chain.bridgeProviders.join('+')]), [['chainlink', 'relay+across'], ['chainlink', 'relay+across'], ['chainlink', 'relay+across']]);
});

test('its token books and labels name HYPE and WHYPE; the Ether chains still name ETH and WETH', () => {
  for (const book of [positionTokens.tokenBook(HYPE_ID), journeyTokens.tokenBook(HYPE_ID)]) {
    assert.deepEqual([book.get(ZERO).symbol, book.get(WHYPE).symbol, book.get(USDC).symbol], ['HYPE', 'WHYPE', 'USDC']);
  }
  assert.deepEqual(journeyTokens.profileTokens(HYPE_ID).map((token) => token.symbol), ['HYPE', 'WHYPE', 'USDC']);
  assert.equal(positionTokens.labelOf(positionTokens.tokenBook(HYPE_ID), ZERO), 'HYPE');
  assert.equal(journeyTokens.labelOf(journeyTokens.tokenBook(HYPE_ID), ZERO), 'HYPE');
  for (const chainId of [4663, 8453, 42161]) {
    const book = positionTokens.tokenBook(chainId);
    assert.deepEqual([book.get(ZERO).symbol, positionTokens.labelOf(book, ZERO), journeyTokens.labelOf(journeyTokens.tokenBook(chainId), ZERO)], ['ETH', 'ETH', 'ETH']);
    assert.deepEqual(journeyTokens.profileTokens(chainId).slice(0, 2).map((token) => token.symbol), ['ETH', 'WETH']);
  }
});

test('network fees are written in HYPE there, in ETH on the others; fee figures are unchanged', () => {
  const wei = 48_000_000_000_000n;
  assert.equal(present.ethText(wei, hype.nativeSymbol), '0.000048 HYPE');
  assert.equal(present.ethAboutText(100_020_000_000_000n, hype.nativeSymbol), '0.0001 HYPE');
  assert.equal(present.ethText(0n, 'HYPE'), '0 HYPE');
  assert.equal(lists.weiWords(150_000_000n, 'HYPE'), '0.00000000015 HYPE');
  // Without a symbol (every caller on Robinhood Chain's V1 screens) and with an Ether chain's, exactly as before.
  assert.equal(present.ethText(wei), '0.000048 ETH');
  assert.equal(present.ethText(wei, real.V2_CHAINS[1].nativeSymbol), '0.000048 ETH');
  assert.equal(present.ethAboutText(100_020_000_000_000n), '0.0001 ETH');
  assert.equal(lists.weiWords(150_000_000n), '0.00000000015 ETH');
  assert.equal(present.tokenText({ address: ZERO, symbol: null }, 'HYPE'), 'HYPE');
  assert.equal(present.tokenText({ address: ZERO, symbol: null }), 'ETH');
});

test('errors name the chain\'s own currency: the short label, the network-fee and refusal sentences', () => {
  assert.equal(errors.shortTokenLabel(ZERO, HYPE_ID), 'HYPE');
  assert.equal(errors.shortTokenLabel(ZERO, 8453), 'ETH');
  assert.equal(errors.shortTokenLabel(ZERO), 'ETH');
  assert.equal(errors.shortTokenLabel(USDC, HYPE_ID), `${USDC.slice(0, 6)}…${USDC.slice(-4)}`);
  assert.equal(positionErrors.actionError(new Error('native_gas_reserve_insufficient'), HYPE_ID).copy, 'Not enough HYPE for the network fee.');
  assert.equal(positionErrors.actionError(new Error('native_gas_reserve_insufficient'), 42161).copy, 'Not enough ETH for the network fee.');
  assert.equal(positionErrors.actionError(new Error('native_eth_refused'), HYPE_ID).copy, 'Your account can’t receive HYPE directly. Use another account.');
  assert.equal(positionErrors.actionError(new Error('native_eth_refused'), 4663).copy, 'Your account can’t receive ETH directly. Use another account.');
  const labels = (chainId) => automateCopy.errorLabels(chainId, (address) => address);
  assert.equal(automateCopy.describeError(new Error('native_gas_reserve_insufficient'), 'vault', labels(HYPE_ID)).text, 'Your HYPE does not cover the network fee for this step.');
  assert.equal(automateCopy.describeError(new Error('native_gas_reserve_insufficient'), 'vault', labels(8453)).text, 'Your ETH does not cover the network fee for this step.');
});

test('a sentence written for Ether reads in HYPE there, word for word; on an Ether chain it is the same sentence', () => {
  assert.equal(real.inChainCurrency(positionCopy.COPY.review.wethWarning, hype), 'On this pool, unused HYPE comes back as WHYPE.');
  assert.equal(real.inChainCurrency(journeyCopy.JOURNEY.review.ethDirect, hype), 'Paying with HYPE needs a direct transaction.');
  assert.equal(real.inChainCurrency('Ethereum needs more ETH; Tether is not WETH.', hype), 'Ethereum needs more HYPE; Tether is not WHYPE.', 'whole words only');
  for (const chain of real.V2_CHAINS) {
    assert.equal(real.inChainCurrency(positionCopy.COPY.review.wethWarning, chain), positionCopy.COPY.review.wethWarning);
    assert.equal(real.inChainCurrency(journeyCopy.JOURNEY.amount.ethDirect, chain), journeyCopy.JOURNEY.amount.ethDirect);
  }
});

test('HYPE and WHYPE take no Ether picture: their marks are the ones any token without bundled artwork takes', () => {
  assert.equal(marks.markOf(HYPE_ID, { address: ZERO, symbol: 'HYPE', decimals: 18 }).artwork, null);
  assert.equal(marks.markOf(HYPE_ID, { address: WHYPE, symbol: 'WHYPE', decimals: 18 }).artwork, null);
  assert.deepEqual([fundsModel.holdingArtwork(HYPE_ID, ZERO), fundsModel.holdingArtwork(HYPE_ID, WHYPE)], [null, null]);
  assert.deepEqual([networks.displayOf(HYPE_ID, { address: ZERO, symbol: 'HYPE', decimals: 18 }).artwork, networks.displayOf(HYPE_ID, { address: WHYPE, symbol: 'WHYPE', decimals: 18 }).artwork], [null, null]);
  // Robinhood Chain, Base and Arbitrum One: ETH's and WETH's pictures, as before.
  for (const chain of real.V2_CHAINS) {
    assert.equal(marks.markOf(chain.chainId, { address: ZERO, symbol: 'ETH', decimals: 18 }).artwork, 'ETH');
    assert.equal(marks.markOf(chain.chainId, { address: chain.wrappedNative.address, symbol: 'WETH', decimals: 18 }).artwork, 'WETH');
    assert.deepEqual([fundsModel.holdingArtwork(chain.chainId, ZERO), fundsModel.holdingArtwork(chain.chainId, chain.wrappedNative.address)], ['ETH', 'WETH']);
  }
});

test('a missing dollar figure: on a pool-priced chain the native pool\'s reasons read as a stale ETH feed does elsewhere', () => {
  for (const reason of ['no_qualified_price_source', 'no_qualified_reference', 'no_qualified_price_source,token_price_unavailable', 'eth_usd_stale']) {
    assert.equal(usdMissingShort(reason, hype.nativeUsd), 'USD price is updating', reason);
  }
  // A chain with Chainlink keeps its words: there no_qualified_price_source means the source has no reads for the chain.
  assert.equal(usdMissingShort('no_qualified_price_source', 'chainlink'), 'No reliable USD price');
  assert.equal(usdMissingShort('no_qualified_price_source'), 'No reliable USD price');
  assert.equal(usdMissingShort('eth_usd_stale'), 'USD price is updating');
  // The native currency's own pool reasons are a judgement of that pool, as for any token.
  assert.equal(usdMissingShort('pool_depth_below_floor', 'pool'), 'No reliable USD price');
  for (const words of ['USD price is updating']) assert.ok(words.length <= 32 && !/unavailable/i.test(words) && !/[.:]$/.test(words));
});

test('in the app as it is, the HYPE chain is in no list: V2_CHAINS, isV2ChainId, the pickers and the network names leave it out', () => {
  assert.deepEqual(real.V2_CHAINS.map((chain) => chain.chainId), [4663, 8453, 42161]);
  assert.equal(real.isV2ChainId(HYPE_ID), false);
  assert.throws(() => real.v2Chain(HYPE_ID), /chain_not_supported/);
  assert.equal(real.nativeSymbolOf(HYPE_ID), 'ETH', 'not a V2 chain: nothing names HYPE for it');
  const gates = { 4663: { mode: 'live' }, 8453: { mode: 'live' }, 42161: { mode: 'live' }, [HYPE_ID]: { mode: 'live' } };
  assert.deepEqual(networks.offeredNetworks(gates), [8453, 42161]);
  assert.deepEqual(networks.readableNetworks(gates), [8453, 42161]);
  const { networkName } = require(`${BUILD}lib/networkName.js`);
  assert.equal(networkName(HYPE_ID), 'another network');
});

// Added 2026-11-07 (Elysium's screens; docs/ELYSIUM_DAY9.md section 7): turned around where the build serves Elysium. The
// real HYPE chain (Elysium mainnet, 99901) is then in every list, last, with its own currency; this file's synthetic HYPE
// chain (99801) still in none.
test('where the build serves Elysium, the HYPE chain 99901 is in every list, last, named and in HYPE; 99801 in none', () => {
  const on = loadWith(require, ELYSIUM_FORCED, () => ({
    chains: require(`${BUILD}v2/chains.js`),
    networks: require(`${BUILD}v2in/journey/model/networks.js`),
    names: require(`${BUILD}lib/networkName.js`),
  }));
  assert.deepEqual(on.chains.V2_CHAINS.map((chain) => chain.chainId), [4663, 8453, 42161, 99901]);
  assert.equal(on.chains.isV2ChainId(99901), true);
  assert.equal(on.chains.nativeSymbolOf(99901), 'HYPE');
  assert.equal(on.chains.v2Chain(99901).wrappedNative.symbol, 'WHYPE');
  const gates = { 4663: { mode: 'live' }, 8453: { mode: 'live' }, 42161: { mode: 'live' }, 99901: { mode: 'live' }, [HYPE_ID]: { mode: 'live' } };
  assert.deepEqual(on.networks.offeredNetworks(gates), [8453, 42161, 99901]);
  assert.deepEqual(on.networks.readableNetworks(gates), [8453, 42161, 99901]);
  assert.equal(on.names.networkName(99901), 'Elysium');
  assert.equal(on.chains.isV2ChainId(HYPE_ID), false);
  assert.equal(on.names.networkName(HYPE_ID), 'another network');
});
