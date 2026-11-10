/**
 * TEST-ONLY. Elysium's day-9 files the app would refuse (added 2026-11-07, day-9 rehearsal, finding F6), shared by
 * tests/elysium-switch.test.mjs (the build fails on each, naming why: scripts/elysium-switch.mjs profileRefusal and
 * recordRefusal) and tests/v2/elysium-build-guard.test.mjs (each verdict held to the app's own parser and admission).
 * Every case was rehearsed on 7 Nov 2026: a profile the chain parser refuses built green, then threw invalid_chain_profile
 * at load in every V2 chunk on all four networks; a pinned record the production admission refuses built green and
 * showed Elysium everywhere with its contracts unavailable.
 *
 *   PROFILE        the synthetic profile tests/fixtures/v2-chains/elysium-99901.json, one the parser takes;
 *   FIXTURE_RECORD the fork-rehearsal record of that profile (src/v2/fixtures/manifest.elysium-99901.fixture.json);
 *   RECORD         the same as a production record has it (public-chain-preparation, verified at `finalized`), one the
 *                  production admission takes for PROFILE;
 *   recordBytes    a record's file text (two-space JSON, LF, a final newline), as deploy.mjs writes one;
 *   PROFILE_FAULTS / RECORD_FAULTS  [what, the file, the reason the guard gives].
 */
import { readFileSync } from 'node:fs';

const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
export const PROFILE = Object.freeze(json('../fixtures/v2-chains/elysium-99901.json'));
export const FIXTURE_RECORD = Object.freeze(json('../../src/v2/fixtures/manifest.elysium-99901.fixture.json'));
export const RECORD = Object.freeze({ ...FIXTURE_RECORD, environment: 'public-chain-preparation', verification: { ...FIXTURE_RECORD.verification, blockTag: 'finalized' } });
export const recordBytes = (record) => Buffer.from(`${JSON.stringify(record, null, 2)}\n`);

const fixture = PROFILE;
const without = (object, key) => Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));

export const PROFILE_FAULTS = Object.freeze([
  ['slug', { ...fixture, slug: 'kinetiq' }, /its slug is "kinetiq", not "elysium"/],
  ['native symbol', { ...fixture, nativeSymbol: 'ETH' }, /its nativeSymbol is "ETH", not "HYPE"/],
  ['WHYPE symbol', { ...fixture, wrappedNative: { ...fixture.wrappedNative, symbol: 'WHYPE2' } }, /wrappedNative must be WHYPE/],
  ['four charge currencies', { ...fixture, chargeCurrencies: [...fixture.chargeCurrencies, { rank: 3, symbol: 'USDT', address: `0x${'ab'.repeat(20)}`, decimals: 6 }] }, /chargeCurrencies must be exactly three/],
  ['uniswap.v3 omitted', { ...fixture, uniswap: without(fixture.uniswap, 'v3') }, /uniswap\.v3 must be there and null/],
  ['a v3', { ...fixture, uniswap: { ...fixture.uniswap, v3: { factory: `0x${'cd'.repeat(20)}` } } }, /uniswap\.v3 must be there and null/],
  ['finality missing', without(fixture, 'finality'), /its finality text is missing/],
  ['universal router version', { ...fixture, uniswap: { ...fixture.uniswap, universalRouter: { ...fixture.uniswap.universalRouter, version: '2.0.0' } } }, /universalRouter must be version 2\.1\.2/],
  ['two gas prices', { ...fixture, gasPrice: { ...fixture.gasPrice, chainlinkEthUsd: { proxy: `0x${'ef'.repeat(20)}`, heartbeatSeconds: 86400 } } }, /gasPrice must name exactly one/],
  ['no code hash', { ...fixture, verification: { ...fixture.verification, contracts: fixture.verification.contracts.filter((entry) => entry.address.toLowerCase() !== fixture.uniswap.v4.stateView.toLowerCase()) } }, /no code hash for uniswap\.v4\.stateView/],
]);

export const RECORD_FAULTS = Object.freeze([
  ['chain name', { ...RECORD, chain: { ...RECORD.chain, name: 'Elysium' } }, /its chain\.name "Elysium" differs from the profile's name/],
  ['native currency', { ...RECORD, chain: { ...RECORD.chain, nativeCurrency: 'ETH' } }, /its chain\.nativeCurrency is "ETH", not "HYPE"/],
  ['wrapped native', { ...RECORD, dependencies: { ...RECORD.dependencies, wrappedNative: `0x${'12'.repeat(20)}` } }, /its dependencies differ from the profile's/],
  ['thirteen contracts', { ...RECORD, contracts: { ...RECORD.contracts, 'vault.v3': `0x${'34'.repeat(20)}`, 'vaultFactory.v3': `0x${'35'.repeat(20)}`, 'zap.v3': `0x${'36'.repeat(20)}`, 'vaultExecutor.v3': `0x${'37'.repeat(20)}` } }, /its contracts are not exactly the nine/],
  ['fork rehearsal', FIXTURE_RECORD, /its environment is "fork-rehearsal", not "public-chain-preparation"/],
  ['verified at latest', { ...RECORD, verification: { ...RECORD.verification, blockTag: 'latest' } }, /it is not verified at "finalized"/],
  ['prepared', { ...RECORD, status: 'prepared' }, /its status is "prepared", not "verified"/],
  ['contractNames cut', { ...RECORD, contractNames: Object.fromEntries(Object.entries(RECORD.contractNames).filter(([key]) => !key.endsWith('.v3'))) }, /its contractNames are not the 13/],
  ['working tree changes', { ...RECORD, build: { ...RECORD.build, workingTreeSourceChanges: true } }, /its build\.workingTreeSourceChanges is not false/],
  ['code hash', { ...RECORD, runtimeCodeHashes: { ...RECORD.runtimeCodeHashes, permit2: `0x${'56'.repeat(32)}` } }, /its runtimeCodeHashes\.permit2 differs/],
  ['charge currencies', { ...RECORD, chargeCurrencies: [...RECORD.chargeCurrencies].reverse() }, /its chargeCurrencies differ from the profile's/],
]);
