import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compare, formatComparison, formatSnapshot, listSuites, parseSnapshot } from './gas-baseline.mjs';

const SNAPSHOT = `DominoPriceGuardV4Test:testOnlyThePublisherPublishesOrRevokes() (gas: 61234)
DominoPriceGuardV4Test:testAnExpiredObservationIsRefusedEvenInsideItsBlockWindow() (gas: 40100)
FeeAccountingTest:testFuzzConservation(uint128,uint128,uint16) (runs: 512, μ: 1234, ~: 1200)
DominoVaultV4InvariantsTest:invariant_theStateNonceOnlyGrows() (runs: 32, calls: 768, reverts: 0)
`;

test('only deterministic entries are kept; fuzz and invariant lines are not part of the baseline', () => {
  const entries = parseSnapshot(SNAPSHOT);
  assert.deepEqual(entries, {
    'DominoPriceGuardV4Test:testOnlyThePublisherPublishesOrRevokes()': 61234,
    'DominoPriceGuardV4Test:testAnExpiredObservationIsRefusedEvenInsideItsBlockWindow()': 40100,
  });
  assert.equal(formatSnapshot(entries),
    'DominoPriceGuardV4Test:testAnExpiredObservationIsRefusedEvenInsideItsBlockWindow() (gas: 40100)\n'
    + 'DominoPriceGuardV4Test:testOnlyThePublisherPublishesOrRevokes() (gas: 61234)\n');
  assert.deepEqual(parseSnapshot(formatSnapshot(entries)), entries);
});

test('a rise fails, a fall passes, and new or removed tests are reported without failing', () => {
  const baseline = { 'A:a()': 100, 'A:b()': 200, 'A:gone()': 300 };
  const current = { 'A:a()': 101, 'A:b()': 150, 'A:new()': 5 };
  const result = compare(baseline, current);
  assert.equal(result.ok, false);
  assert.deepEqual(result.regressions, [{ key: 'A:a()', before: 100, after: 101 }]);
  assert.deepEqual(result.improvements, [{ key: 'A:b()', before: 200, after: 150 }]);
  assert.deepEqual(result.added, ['A:new()']);
  assert.deepEqual(result.removed, ['A:gone()']);
  const text = formatComparison(result);
  assert.match(text, /REGRESSION A:a\(\): 100 -> 101 \(\+1\)/);
  assert.match(text, /improved A:b\(\): 200 -> 150 \(-50\)/);
  assert.match(text, /new A:new\(\)/);
  assert.match(text, /gone A:gone\(\)/);
  assert.match(text, /--update/);
  assert.equal(compare(baseline, { ...baseline }).ok, true);
  assert.equal(compare(baseline, current).regressions.length, 1);
});

test('suites are every test file under contracts/test except the vendored official tree', () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'domino gas suites '));
  try {
    mkdirSync(path.join(folder, 'reference', 'official-v4', 'v4-core', 'test'), { recursive: true });
    mkdirSync(path.join(folder, 'setup'), { recursive: true });
    writeFileSync(path.join(folder, 'B.t.sol'), '');
    writeFileSync(path.join(folder, 'A.t.sol'), '');
    writeFileSync(path.join(folder, 'Mocks.sol'), '');
    writeFileSync(path.join(folder, 'setup', 'C.t.sol'), '');
    writeFileSync(path.join(folder, 'reference', 'official-v4', 'v4-core', 'test', 'Vendored.t.sol'), '');
    const suites = listSuites(folder).map((suite) => suite.split(path.sep).slice(-1)[0]);
    assert.deepEqual(suites, ['A.t.sol', 'B.t.sol', 'C.t.sol']);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
