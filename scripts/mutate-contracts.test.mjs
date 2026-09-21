import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyMutation, batchExitCode, formatRow, runBatch, runSuite, summarise, validateSpec } from './mutate-contracts.mjs';

function forgeOutput(suites) {
  const totals = suites.reduce((sum, [passed, failed, skipped = 0]) => [sum[0] + passed, sum[1] + failed, sum[2] + skipped], [0, 0, 0]);
  return suites.map(([passed, failed, skipped = 0]) => `Suite result: ${failed ? 'FAILED' : 'ok'}. ${passed} passed; ${failed} failed; ${skipped} skipped\n`).join('')
    + `Ran ${suites.length} test suites in 1.00ms (1.00ms CPU time): ${totals[0]} tests passed, ${totals[1]} failed, ${totals[2]} skipped (${totals.reduce((a, b) => a + b)} total tests)\n`;
}
const runner = (stdout, status = 0, extra = {}) => () => ({ stdout, stderr: '', status, ...extra });
const spec = (mutations) => ({ file: 'contracts/src/A.sol', suite: 'test/A.t.sol', mutations });
const mutation = { label: 'owner', old: 'guard', new: 'true' };

test('repeated source text requires an explicit occurrence and replaces only that one', () => {
  const text = 'if (a || b) revert X();\nif (a || b) revert Y();\n';
  assert.deepEqual(applyMutation(text, { old: 'a || ', new: '' }), { ok: false, occurrences: 2 });
  assert.equal(applyMutation(text, { old: 'a || ', new: '', index: 0 }).text, 'if (b) revert X();\nif (a || b) revert Y();\n');
  assert.equal(applyMutation(text, { old: 'a || ', new: '', index: 1 }).text, 'if (a || b) revert X();\nif (b) revert Y();\n');
  assert.equal(applyMutation('one guard', mutation).text, 'one true');
});

test('absent, empty, identical or invalid-index edits cannot count as applied', () => {
  for (const edit of [{ old: 'absent', new: '' }, { old: '', new: 'y' }, { old: 'x', new: 'x' },
    { old: 'x', new: 'y', index: 2 }, { old: 'x', new: 'y', index: -1 }, { old: 'x', new: 'y', index: 0.5 }])
    assert.equal(applyMutation('x x', edit).ok, false);
});

test('all suite results contribute to coverage, regardless of where failure appears', () => {
  for (const suites of [[[9, 0], [2, 1]], [[2, 1], [9, 0]]]) {
    const result = runSuite('/box', 'test/*.t.sol', runner(forgeOutput(suites), 1));
    assert.deepEqual(result, { verdict: 'CAUGHT', detail: '11 passed / 1 failed / 0 skipped across 2 suite(s)',
      suites: 2, passed: 11, failed: 1, skipped: 0 });
  }
  const passed = runSuite('/box', 'test/*.t.sol', runner(forgeOutput([[4, 0, 1], [8, 0, 2]])));
  assert.equal(passed.verdict, 'NOT CAUGHT');
  assert.equal(passed.passed, 12); assert.equal(passed.skipped, 3); assert.equal(passed.suites, 2);
});

test('a process or post-test size failure cannot be mistaken for successful coverage', () => {
  for (const extra of [{ status: 1 }, { status: null, signal: 'SIGKILL' }, { status: 0, error: new Error('maxBuffer exceeded') }]) {
    const result = runSuite('/box', 'test/A.t.sol', runner(forgeOutput([[10, 0]]), 0, extra));
    assert.equal(result.verdict, 'NO BUILD');
  }
  assert.equal(runSuite('/box', 'test/A.t.sol', runner(forgeOutput([[9, 1]]), 0)).verdict, 'NO BUILD');
});

test('missing, incomplete, inconsistent and zero-executed-test summaries fail closed', () => {
  for (const stdout of ['', 'Suite result: ok. 9 passed; 0 failed; 0 skipped\n', forgeOutput([[0, 0, 2]]),
    forgeOutput([[2, 1]]).replace('FAILED', 'ok'), forgeOutput([[2, 1]]).replace('3 total tests', '4 total tests')])
    assert.equal(runSuite('/box', 'test/A.t.sol', runner(stdout, 1)).verdict, 'NO BUILD');
});

test('a compiler error is NO BUILD, never a caught mutation', () => {
  const result = runSuite('/box', 'test/A.t.sol', runner('Compiler run failed:\nError (7576): Undeclared identifier.\n', 1));
  assert.equal(result.verdict, 'NO BUILD'); assert.match(result.detail, /Error \(7576\)/);
});

test('only explicitly documented surviving mutations may be expected', () => {
  assert.equal(validateSpec(spec([mutation])).mutations.length, 1);
  assert.doesNotThrow(() => validateSpec(spec([{ ...mutation, expected: 'NOT CAUGHT', reason: 'Adjacent clause independently rejects the same input.' }])));
  for (const invalid of [{ ...mutation, expected: 'NO BUILD' }, { ...mutation, expected: 'NOT APPLIED' },
    { ...mutation, expected: 'NOT CAUGHT' }, { ...mutation, file: '../source.sol' },
    { ...mutation, file: 'contracts/src/../../outside.sol' }, { ...mutation, suite: '../test.sol' },
    { ...mutation, old: '' }, { ...mutation, new: mutation.old }, { ...mutation, index: -1 }])
    assert.throws(() => validateSpec(spec([invalid])));
  assert.throws(() => validateSpec(spec([])));
  assert.throws(() => validateSpec(spec([mutation, mutation])));
});

test('NO BUILD, NOT APPLIED, unknown and unexpected verdicts always fail the batch', () => {
  assert.equal(batchExitCode([{ verdict: 'CAUGHT' }]), 0);
  assert.equal(batchExitCode([{ verdict: 'NOT CAUGHT', expected: 'NOT CAUGHT' }]), 0);
  for (const verdict of ['NOT CAUGHT', 'NOT APPLIED', 'NO BUILD', 'UNKNOWN'])
    assert.equal(batchExitCode([{ verdict: 'CAUGHT' }, { verdict }]), 1);
  assert.equal(batchExitCode([{ verdict: 'CAUGHT', expected: 'NOT CAUGHT' }]), 1);
  assert.equal(batchExitCode([{ verdict: 'NO BUILD', expected: 'NO BUILD' }]), 1);
  assert.equal(batchExitCode([]), 1);
});

test('batch orchestration restores pristine sources between mutations and returns an aggregate failure', () => {
  const box = mkdtempSync(path.join(os.tmpdir(), 'domino-mutation-unit-'));
  try {
    mkdirSync(path.join(box, 'contracts/src'), { recursive: true });
    writeFileSync(path.join(box, 'contracts/src/A.sol'), 'guard other');
    let calls = 0;
    const { exitCode, rows } = runBatch(box, spec([mutation, { label: 'other', old: 'other', new: 'changed' },
      { label: 'missing', old: 'absent', new: 'changed' }]), { log() {}, suiteRunner() {
      const text = readFileSync(path.join(box, 'contracts/src/A.sol'), 'utf8');
      calls++;
      assert.equal(text, ['guard other', 'true other', 'guard changed'][calls - 1]);
      return { verdict: calls === 2 ? 'CAUGHT' : 'NOT CAUGHT', detail: 'fixture' };
    } });
    assert.equal(calls, 3); assert.equal(exitCode, 1);
    assert.deepEqual(rows.map(row => row.verdict), ['CAUGHT', 'NOT CAUGHT', 'NOT APPLIED']);
  } finally { rmSync(box, { recursive: true, force: true }); }
});

test('a failing baseline stops before any edit and every distinct suite has a baseline', () => {
  const box = mkdtempSync(path.join(os.tmpdir(), 'domino-mutation-unit-'));
  try {
    mkdirSync(path.join(box, 'contracts/src'), { recursive: true });
    writeFileSync(path.join(box, 'contracts/src/A.sol'), 'guard other');
    const suites = [];
    const result = runBatch(box, spec([mutation, { label: 'other', old: 'other', new: 'changed', suite: 'test/B.t.sol' }]), {
      log() {}, suiteRunner(_box, suite) { suites.push(suite); return { verdict: suites.length === 1 ? 'NOT CAUGHT' : 'NO BUILD', detail: 'fixture' }; },
    });
    assert.deepEqual(suites, ['test/A.t.sol', 'test/B.t.sol']);
    assert.equal(result.exitCode, 1); assert.equal(result.rows.length, 0);
    assert.equal(readFileSync(path.join(box, 'contracts/src/A.sol'), 'utf8'), 'guard other');
  } finally { rmSync(box, { recursive: true, force: true }); }
});

test('the human summary includes every verdict, independent of expected results', () => {
  const rows = [{ verdict: 'CAUGHT' }, { verdict: 'CAUGHT' }, { verdict: 'NOT CAUGHT' }, { verdict: 'NO BUILD' }, { verdict: 'NOT APPLIED' }];
  assert.equal(summarise(rows), '5 mutations: 2 caught, 1 not caught, 1 did not compile, 1 did not apply.');
  assert.equal(summarise([{ verdict: 'CAUGHT' }]), '1 mutations: 1 caught, 0 not caught.');
  assert.match(formatRow('the guard', 12, 'CAUGHT', '9 passed / 1 failed'), /the guard\s+CAUGHT\s+\(9 passed \/ 1 failed\)/);
});
