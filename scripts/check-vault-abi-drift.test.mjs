import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkVaultAbiDrift, formatDriftReport, signature, SHARED_COUNT, V3_ONLY, V4_ONLY }
  from './check-vault-abi-drift.mjs';

const shared = Array.from({ length: SHARED_COUNT }, (_, i) => ({
  type: 'function', name: `shared${i}`, inputs: [], stateMutability: 'view',
}));
const parse = (entry) => {
  const [, type, name, inputs, mutability] = /^(\w+) (\w*)\(([^)]*)\)(?: (\w+))?$/.exec(entry);
  return { type, ...(name ? { name } : {}), inputs: inputs ? inputs.split(',').map((t) => ({ type: t })) : [],
    ...(mutability ? { stateMutability: mutability } : {}) };
};
const declared = (map) => Object.keys(map).map((entry) =>
  parse(entry.startsWith('constructor ') ? entry.replace('constructor ', 'constructor ') : entry));

function fixture(extraV3 = [], extraV4 = []) {
  const out = mkdtempSync(path.join(tmpdir(), 'domino-drift-'));
  for (const [name, abi] of [
    ['DominoVault', [...shared, ...declared(V3_ONLY), ...extraV3]],
    ['DominoVaultV4', [...shared, ...declared(V4_ONLY), ...extraV4]],
  ]) {
    mkdirSync(path.join(out, `${name}.sol`), { recursive: true });
    writeFileSync(path.join(out, `${name}.sol`, `${name}.json`), JSON.stringify({ abi }));
  }
  return out;
}

test('a fixture whose divergences are all declared passes', () => {
  const report = checkVaultAbiDrift({ out: fixture() });
  assert.equal(report.ok, true, report.issues.join('; '));
  assert.equal(report.sharedCount, SHARED_COUNT);
  assert.match(formatDriftReport(report), /PASS/);
});

test('an undeclared member on either side fails, and the report names it', () => {
  const rogue = { type: 'error', name: 'Rogue', inputs: [] };
  for (const [label, extra] of [['v4_only', [[], [rogue]]], ['v3_only', [[rogue], []]]]) {
    const report = checkVaultAbiDrift({ out: fixture(extra[0], extra[1]) });
    assert.equal(report.ok, false, label);
    assert.deepEqual(report.issues, [`undeclared_${label}_member: ${signature(rogue)}`]);
    assert.match(formatDriftReport(report), /written down/);
  }
});

test('a declared divergence that no longer exists fails, so the list cannot rot', () => {
  const [first] = Object.keys(V4_ONLY);
  const kept = Object.keys(V4_ONLY).slice(1).map(parse);
  const out = mkdtempSync(path.join(tmpdir(), 'domino-drift-'));
  for (const [name, abi] of [
    ['DominoVault', [...shared, ...declared(V3_ONLY)]],
    ['DominoVaultV4', [...shared, ...kept]],
  ]) {
    mkdirSync(path.join(out, `${name}.sol`), { recursive: true });
    writeFileSync(path.join(out, `${name}.sol`, `${name}.json`), JSON.stringify({ abi }));
  }
  const report = checkVaultAbiDrift({ out });
  assert.equal(report.ok, false);
  assert.deepEqual(report.issues, [`stale_v4_only_entry: ${first}`]);
});

test('a member that leaves the shared surface fails even when both sides still declare it', () => {
  // Same name, one side changes the mutability: it stops being shared and
  // becomes an undeclared divergence on both sides at once.
  const moved = { type: 'function', name: 'shared0', inputs: [], stateMutability: 'nonpayable' };
  const out = mkdtempSync(path.join(tmpdir(), 'domino-drift-'));
  for (const [name, abi] of [
    ['DominoVault', [...shared, ...declared(V3_ONLY)]],
    ['DominoVaultV4', [...shared.slice(1), moved, ...declared(V4_ONLY)]],
  ]) {
    mkdirSync(path.join(out, `${name}.sol`), { recursive: true });
    writeFileSync(path.join(out, `${name}.sol`, `${name}.json`), JSON.stringify({ abi }));
  }
  const report = checkVaultAbiDrift({ out });
  assert.equal(report.ok, false);
  assert.equal(report.sharedCount, SHARED_COUNT - 1);
  assert.ok(report.issues.some((i) => i.startsWith('shared_surface_changed')), report.issues.join('; '));
  assert.ok(report.issues.some((i) => i.includes('function shared0() nonpayable')), report.issues.join('; '));
});

test('an unreadable or ABI-less artifact is an error, never a silent pass', () => {
  assert.throws(() => checkVaultAbiDrift({ out: mkdtempSync(path.join(tmpdir(), 'domino-drift-')) }),
    /artifact_unreadable/);
  const out = mkdtempSync(path.join(tmpdir(), 'domino-drift-'));
  mkdirSync(path.join(out, 'DominoVault.sol'), { recursive: true });
  writeFileSync(path.join(out, 'DominoVault.sol', 'DominoVault.json'), JSON.stringify({}));
  assert.throws(() => checkVaultAbiDrift({ out }), /artifact_has_no_abi/);
});

test('every declared divergence carries a reason, not just a name', () => {
  for (const [side, map] of [['V3_ONLY', V3_ONLY], ['V4_ONLY', V4_ONLY]]) {
    for (const [entry, reason] of Object.entries(map)) {
      assert.ok(reason.length > 20 && reason.endsWith('.'), `${side}: ${entry} needs a reason`);
    }
  }
});
