import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyMutation, formatRow, runSuite, summarise } from './mutate-contracts.mjs';

test('a mutation replaces the occurrence it names, and only that one', () => {
  const text = 'if (a || b) revert X();\nif (a || b) revert Y();\n';
  const first = applyMutation(text, { old: 'a || ', new: '' });
  assert.equal(first.text, 'if (b) revert X();\nif (a || b) revert Y();\n');
  const second = applyMutation(text, { old: 'a || ', new: '', index: 1 });
  assert.equal(second.text, 'if (a || b) revert X();\nif (b) revert Y();\n');
});

test('a mutation that does not apply is reported, never silently skipped', () => {
  assert.deepEqual(applyMutation('nothing here', { old: 'absent', new: '' }), { ok: false, occurrences: 0 });
  // Two occurrences exist; asking for a third is a mistake in the batch, not a pass.
  assert.deepEqual(applyMutation('x x', { old: 'x', new: 'y', index: 2 }), { ok: false, occurrences: 2 });
});

test('a failing suite means the clause is caught; a passing one means it is not', () => {
  const runner = (out) => () => ({ stdout: out, stderr: '' });
  assert.deepEqual(runSuite('/box', 'test/A.t.sol', runner('Suite result: FAILED. 9 passed; 1 failed; 0 skipped\n')),
    { verdict: 'CAUGHT', detail: '9 passed / 1 failed' });
  assert.deepEqual(runSuite('/box', 'test/A.t.sol', runner('Suite result: ok. 10 passed; 0 failed; 0 skipped\n')),
    { verdict: 'NOT CAUGHT', detail: '10 passed / 0 failed' });
});

test('a mutation that does not compile proves nothing and says so', () => {
  const result = runSuite('/box', 'test/A.t.sol', () => ({ stdout: 'Compiler run failed:\nError (7576): Undeclared identifier.\n', stderr: '' }));
  assert.equal(result.verdict, 'NO BUILD');
  assert.match(result.detail, /Error \(7576\)/);
});

test('the summary counts every verdict', () => {
  const rows = [{ verdict: 'CAUGHT' }, { verdict: 'CAUGHT' }, { verdict: 'NOT CAUGHT' }, { verdict: 'NO BUILD' }, { verdict: 'NOT APPLIED' }];
  assert.equal(summarise(rows), '5 mutations: 2 caught, 1 not caught, 1 did not compile, 1 did not apply.');
  assert.equal(summarise([{ verdict: 'CAUGHT' }]), '1 mutations: 1 caught, 0 not caught.');
  assert.match(formatRow('the guard', 12, 'CAUGHT', '9 passed / 1 failed'), /the guard\s+CAUGHT\s+\(9 passed \/ 1 failed\)/);
});
