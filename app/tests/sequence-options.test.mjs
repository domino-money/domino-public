// The sequence creation form in human units to the exact wire the contracts
// take (src/lib/create/sequenceDefaults.ts): percentages to basis points,
// minutes and hours to seconds, ETH to wei, inside PolicyValidation's and the
// vault's bounds; and what a #/sequence/… link asks for.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SEQUENCE_DEFAULTS, ethToWei, percentToBps, sequenceIntent, sequenceOptionsFrom } from '../.test-build/app/src/lib/create/sequenceDefaults.js';

test('the defaults make a valid Domino creation and a valid Auto-compound one, on the wire the vault takes', () => {
  const domino = sequenceOptionsFrom('domino', 42n, SEQUENCE_DEFAULTS);
  assert.ok(domino.ok);
  assert.deepEqual(domino.options, {
    automationMode: 'domino', rootTokenId: 42n, baseIsCurrency0: true, consentToUncollectedFees: true,
    triggerDistanceBps: 500, maxOverlapBps: 2000, minimumIntervalSeconds: 3600, maxPositions: 3, upsideBps: 5000,
    maxSlippageBps: 100, maxPriceImpactBps: 100, maxGasCostWei: 5_000_000_000_000_000n, maxObservationAgeSeconds: 300, forecastHorizonSeconds: 604_800,
  });
  const compound = sequenceOptionsFrom('compound', 42n, { ...SEQUENCE_DEFAULTS, sequenceCap: '9', triggerPercent: '99' });
  assert.ok(compound.ok);
  // Auto-compound is one position, and the successor fields are the defaults whatever was typed for them.
  assert.equal(compound.options.maxPositions, 1);
  assert.equal(compound.options.triggerDistanceBps, 500);
  assert.equal(compound.options.automationMode, 'compound');
});

test('each field is refused with its own words at the contract bound', () => {
  const base = SEQUENCE_DEFAULTS;
  const refused = (form, mode = 'domino') => { const r = sequenceOptionsFrom(mode, 1n, { ...base, ...form }); assert.equal(r.ok, false); return r.reason; };
  assert.match(refused({ triggerPercent: '20.01' }), /^Trigger distance/);
  assert.match(refused({ triggerPercent: '5.123' }), /^Trigger distance/, 'three decimals');
  assert.match(refused({ maxOverlapPercent: '-1' }), /^Maximum overlap/);
  assert.match(refused({ sequenceCap: '256' }), /^The number of positions/);
  assert.match(refused({ sequenceCap: '0' }), /^The number of positions/);
  assert.match(refused({ upsidePercent: '0' }), /^Successor upside/);
  assert.match(refused({ minimumIntervalMinutes: '0' }), /^Minimum interval/);
  assert.match(refused({ minimumIntervalMinutes: '1.5' }), /^Minimum interval/);
  assert.match(refused({ maxSlippagePercent: '100' }), /^Maximum slippage/);
  assert.match(refused({ maxPriceImpactPercent: '100' }), /^Maximum price impact/);
  assert.match(refused({ maxGasCostEth: '0' }), /^The gas cap/);
  assert.match(refused({ maxGasCostEth: 'abc' }), /^The gas cap/);
  assert.match(refused({ maxObservationAgeMinutes: '0' }), /^Price reading age/);
  assert.match(refused({ forecastHorizonHours: '0' }), /^The forecast horizon/);
  assert.equal(sequenceOptionsFrom('compound', 0n, base).ok, false, 'no NFT');
});

test('units convert exactly', () => {
  assert.equal(percentToBps('0.5'), 50);
  assert.equal(percentToBps('20'), 2000);
  assert.equal(percentToBps('0.01'), 1);
  assert.equal(percentToBps('0.001'), null);
  assert.equal(ethToWei('0.005'), 5_000_000_000_000_000n);
  assert.equal(ethToWei('1'), 10n ** 18n);
  assert.equal(ethToWei('0.0000000000000000001'), null, 'nineteen decimals');
});

test('a #/sequence link names a mode, an NFT id, both in either order, or nothing', () => {
  assert.deepEqual(sequenceIntent(['sequence']), { mode: null, tokenId: null });
  assert.deepEqual(sequenceIntent(['sequence', 'compound']), { mode: 'compound', tokenId: null });
  assert.deepEqual(sequenceIntent(['sequence', 'domino', '4242']), { mode: 'domino', tokenId: '4242' });
  assert.deepEqual(sequenceIntent(['sequence', '4242']), { mode: null, tokenId: '4242' });
  assert.deepEqual(sequenceIntent(['sequence', '4242', 'compound']), { mode: 'compound', tokenId: '4242' });
  assert.deepEqual(sequenceIntent(['sequence', 'anything', '0']), { mode: null, tokenId: null }, 'not a mode, not an id');
  assert.deepEqual(sequenceIntent(['sequence', '0x1']), { mode: null, tokenId: null }, 'decimal ids only');
});
