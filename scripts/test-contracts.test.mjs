import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { contractArguments, runChecked } from './test-contracts.mjs';

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
