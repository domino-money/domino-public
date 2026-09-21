import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { test } from 'node:test';
import { contractArguments, runChecked, runContractChecks } from './test-contracts.mjs';
import { listContractSuites } from './contract-suites.mjs';

test('actual child failures retain their exit status instead of passing CI', () => {
  assert.equal(runChecked(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'pipe' }), 7);
  assert.equal(runChecked(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'pipe' }), 0);
});

test('terminated or unavailable executables cannot become successful checks', () => {
  assert.equal(runChecked(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")'], { stdio: 'pipe' }), 1);
  assert.throws(() => runChecked('/nonexistent-domino-test-executable', [], { stdio: 'pipe' }), { code: 'ENOENT' });
});

test('compiler and project paths are absolute for checkouts containing spaces', () => {
  const args = contractArguments(['--match-test', 'testFloorAtFortyNineAndFiftyBaseUnits']);
  assert.equal(args[0], 'test');
  assert.equal(path.isAbsolute(args[2]), true);
  assert.equal(path.isAbsolute(args[4]), true);
  assert.equal(path.basename(args[4]), 'solc-wrapper.py');
  assert.equal(args[5], '--offline');
  assert.deepEqual(args.slice(6), ['--match-test', 'testFloorAtFortyNineAndFiftyBaseUnits']);
});

function fixture({ statuses = [], files = ['test/A.t.sol', 'test/nested/B.t.sol'], sizeOK = true } = {}) {
  const calls = [], order = [];
  let discoveries = 0, sizes = 0;
  const hooks = {
    discover() { discoveries++; return files; },
    run(binary, args) {
      assert.equal(binary, '/pinned/forge');
      calls.push(args); order.push(args.at(-1)); return statuses[calls.length - 1] ?? 0;
    },
    checkSizes() { sizes++; order.push('size'); return { ok: sizeOK }; },
    reportSize(report) { return report.ok ? 'size pass' : 'size fail'; },
    log() {},
  };
  return { calls, order, hooks, discoveries: () => discoveries, sizes: () => sizes };
}

test('default invocation executes each dependency closure in sequence and checks size once afterward', () => {
  const run = fixture();
  assert.equal(runContractChecks('/pinned/forge', [], run.hooks), 0);
  assert.deepEqual(run.calls, [contractArguments(['--match-path', 'test/A.t.sol']),
    contractArguments(['--match-path', 'test/nested/B.t.sol'])]);
  assert.deepEqual(run.order, ['test/A.t.sol', 'test/nested/B.t.sol', 'size']);
  assert.equal(run.discoveries(), 1); assert.equal(run.sizes(), 1);
});

test('test, contract, exclusion and verbosity filters reach every isolated suite unchanged', () => {
  const run = fixture();
  const filters = ['--match-test', 'testOwner.*', '--match-contract=Custody.*', '--no-match-path', 'test/excluded/*', '-vv'];
  assert.equal(runContractChecks('/pinned/forge', filters, run.hooks), 0);
  assert.deepEqual(run.calls[0], contractArguments([...filters, '--match-path', 'test/A.t.sol']));
  assert.deepEqual(run.calls[1], contractArguments([...filters, '--match-path', 'test/nested/B.t.sol']));
});

test('explicit path flags and Forge path shortcuts retain their single-invocation semantics', () => {
  for (const filters of [['--match-path', 'test/Custody*.t.sol', '-vv'], ['--match-path=test/A.t.sol'],
    ['--mp', 'test/A.t.sol'], ['--mp=test/A.t.sol'], ['test/A.t.sol', '--match-test', 'testOwner'],
    ['--', 'test/A.t.sol']]) {
    const run = fixture();
    assert.equal(runContractChecks('/pinned/forge', filters, run.hooks), 0);
    assert.deepEqual(run.calls, [contractArguments(filters)]);
    assert.equal(run.discoveries(), 0); assert.equal(run.sizes(), 1);
  }
});

test('explicit builds preserve positional source filters and do not invoke tests or size checks', () => {
  for (const args of [['build'], ['build', 'test/setup/DominoSetup.t.sol', '--force']]) {
    const run = fixture();
    assert.equal(runContractChecks('/pinned/forge', args, run.hooks), 0);
    assert.deepEqual(run.calls, [contractArguments(args.slice(1), 'build')]);
    assert.equal(run.discoveries(), 0); assert.equal(run.sizes(), 0);
  }
});

test('first isolated-suite failure stops later compiles and preserves its exact child status', () => {
  const run = fixture({ statuses: [0, 7], files: ['test/A.t.sol', 'test/B.t.sol', 'test/C.t.sol'] });
  assert.equal(runContractChecks('/pinned/forge', [], run.hooks), 7);
  assert.equal(run.calls.length, 2); assert.equal(run.sizes(), 0);
  for (const args of [['build'], ['--match-path', 'test/A.t.sol']]) {
    const failure = fixture({ statuses: [9] });
    assert.equal(runContractChecks('/pinned/forge', args, failure.hooks), 9);
    assert.equal(failure.sizes(), 0);
  }
});

test('empty discovery and a failed final size check cannot report a passing run', () => {
  const empty = fixture({ files: [] });
  assert.throws(() => runContractChecks('/pinned/forge', [], empty.hooks), /No authored contract test suites/);
  assert.equal(empty.calls.length, 0); assert.equal(empty.sizes(), 0);
  const oversized = fixture({ sizeOK: false });
  assert.equal(runContractChecks('/pinned/forge', [], oversized.hooks), 1);
  assert.equal(oversized.calls.length, 2); assert.equal(oversized.sizes(), 1);
});

test('help runs once without suite discovery or requiring existing artifacts', () => {
  const run = fixture();
  assert.equal(runContractChecks('/pinned/forge', ['--help'], run.hooks), 0);
  assert.deepEqual(run.calls, [contractArguments(['--help'])]);
  assert.equal(run.discoveries(), 0); assert.equal(run.sizes(), 0);
});

test('discovery sorts nested authored suites and excludes vendored dependency tests', () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'domino-contract-suites-'));
  try {
    for (const name of ['test/Z.t.sol', 'test/nested/B.t.sol', 'test/nested/A.t.sol',
      'test/Helper.sol', 'test/reference/official-v4/core/Foreign.t.sol']) {
      const file = path.join(folder, name);
      mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, '');
    }
    assert.deepEqual(listContractSuites(path.join(folder, 'test'), folder), [
      path.join('test', 'Z.t.sol'), path.join('test', 'nested', 'A.t.sol'), path.join('test', 'nested', 'B.t.sol'),
    ]);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
