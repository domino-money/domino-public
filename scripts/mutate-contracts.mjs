#!/usr/bin/env node
// Run a batch of source mutations against the contract suites, in a disposable
// copy of the repository, and report whether each one is caught.
//
// New committed batches reproduce only the mutations they explicitly name.
// Historical reports whose input batches are absent cannot be reproduced exactly.
// A guard counts as covered when deleting it makes a test
// fail, never because a test's name says so. Two rules keep the verdicts
// honest. The tree is never mutated - a copy is made under a temporary
// directory and thrown away - because an earlier run left a mutated security
// guard in the working tree and it reached a full backend run before anyone
// noticed. And a mutation that does not apply is an error, never a pass: a
// silently skipped edit reads exactly like a guard the tests already cover.
//
//   node scripts/mutate-contracts.mjs batch.json [--head] [--keep]
//
// The batch is JSON: a default `suite` and `file`, then `mutations`, each with
// a `label`, the `old` text to find and the `new` text to put in its place, and
// optionally its own `file`, `suite`, and explicit `index` among repeated
// occurrences. Expected verdicts default to CAUGHT; an intentional NOT CAUGHT
// expectation requires `expected` and a nonempty `reason`. Tool failures and any
// unexpected verdict fail the batch. `--head` mutates the last commit instead of the working tree,
// so a batch can run while tests are being edited.
//
// Verdicts, one per mutation:
//   CAUGHT       a complete test run failed after the mutation
//   NOT CAUGHT   the suite did not distinguish the mutation (possibly redundant)
//   NOT APPLIED  the text was not found exactly once as asked - fix the batch
//   NO BUILD     the mutation does not compile - it proves nothing
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const RESULT = /^Suite result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) skipped/gm;
const TOTAL = /^Ran (\d+) test suites? in .+: (\d+) tests? passed, (\d+) failed, (\d+) skipped \((\d+) total tests\)/m;

/** A disposable copy of everything a contract suite needs. Caller removes it. */
export function makeSandbox({ head = false, run = spawnSync } = {}) {
  const box = mkdtempSync(path.join(os.tmpdir(), 'domino-mutate-'));
  if (head) {
    const archive = run('git', ['-C', root, 'archive', 'HEAD', 'contracts', 'scripts', 'package.json'], { maxBuffer: 1 << 30 });
    if (archive.status !== 0) throw new Error('git archive HEAD failed');
    const tar = run('tar', ['-x', '-C', box], { input: archive.stdout });
    if (tar.status !== 0) throw new Error('could not unpack the HEAD archive');
  } else {
    for (const entry of ['contracts/src', 'contracts/test', 'contracts/foundry.toml', 'scripts', 'package.json']) {
      cpSync(path.join(root, entry), path.join(box, entry), { recursive: true });
    }
  }
  // The pinned Forge binary and the compiler wrapper resolve through node_modules.
  cpSync(path.join(root, 'node_modules'), path.join(box, 'node_modules'), { recursive: true, verbatimSymlinks: true });
  return box;
}

export function runSuite(box, suite, run = spawnSync) {
  const result = run('node', ['scripts/test-contracts.mjs', '--match-path', suite], { cwd: box, encoding: 'utf8', maxBuffer: 1 << 28 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const matches = [...(result.stdout ?? '').matchAll(RESULT)];
  const counts = matches.reduce((sum, match) => ({
    suites: sum.suites + 1, passed: sum.passed + Number(match[2]),
    failed: sum.failed + Number(match[3]), skipped: sum.skipped + Number(match[4]),
  }), { suites: 0, passed: 0, failed: 0, skipped: 0 });
  const detail = `${counts.passed} passed / ${counts.failed} failed / ${counts.skipped} skipped across ${counts.suites} suite(s)`;
  const invalidSummary = matches.some(match => (match[1] === 'FAILED') !== (Number(match[3]) > 0));
  const total = TOTAL.exec(result.stdout ?? '');
  const complete = total && Number(total[1]) === counts.suites && Number(total[2]) === counts.passed
    && Number(total[3]) === counts.failed && Number(total[4]) === counts.skipped
    && Number(total[5]) === counts.passed + counts.failed + counts.skipped;
  // A successful suite followed by a size/build/tool failure is not coverage.
  // Nor is a process killed after printing just one of its suite summaries.
  if (result.error || result.signal || !Number.isInteger(result.status) || !matches.length
      || counts.passed + counts.failed === 0 || invalidSummary || !complete
      || (counts.failed === 0 ? result.status !== 0 : result.status !== 1)) {
    const error = /^Error.*$/m.exec(output)?.[0];
    return { verdict: 'NO BUILD', detail: [result.error?.message, result.signal,
      error ?? `incomplete or unsuccessful test run (exit ${result.status ?? 'unknown'})`, detail].filter(Boolean).join('; '), ...counts };
  }
  return { verdict: counts.failed > 0 ? 'CAUGHT' : 'NOT CAUGHT', detail, ...counts };
}

/** Without an explicit index, require exactly one match; never guess which guard. */
export function applyMutation(text, { old: previous, new: next, index }) {
  if (typeof previous !== 'string' || previous.length === 0 || typeof next !== 'string' || previous === next)
    return { ok: false, occurrences: 0 };
  const parts = text.split(previous);
  const occurrences = parts.length - 1;
  if ((index === undefined && occurrences !== 1)
      || (index !== undefined && (!Number.isSafeInteger(index) || index < 0 || occurrences <= index)))
    return { ok: false, occurrences };
  const at = index ?? 0;
  return { ok: true, text: parts.slice(0, at + 1).join(previous) + next + parts.slice(at + 1).join(previous) };
}

export function validateSpec(spec) {
  if (!spec || !Array.isArray(spec.mutations) || spec.mutations.length === 0) throw new Error('A batch needs at least one mutation.');
  const labels = new Set();
  const relative = (value, prefix) => typeof value === 'string' && value.startsWith(prefix)
    && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..');
  for (const mutation of spec.mutations) {
    if (!mutation || typeof mutation.label !== 'string' || !mutation.label.trim() || labels.has(mutation.label))
      throw new Error('Mutation labels must be nonempty and unique.');
    labels.add(mutation.label);
    if (!relative(mutation.file ?? spec.file, 'contracts/src/') || !relative(mutation.suite ?? spec.suite, 'test/'))
      throw new Error(`Invalid source or suite path: ${mutation.label}`);
    if (typeof mutation.old !== 'string' || !mutation.old || typeof mutation.new !== 'string' || mutation.old === mutation.new
        || (mutation.index !== undefined && (!Number.isSafeInteger(mutation.index) || mutation.index < 0)))
      throw new Error(`Invalid edit: ${mutation.label}`);
    if (mutation.expected !== undefined && !['CAUGHT', 'NOT CAUGHT'].includes(mutation.expected))
      throw new Error(`Invalid expected verdict: ${mutation.label}`);
    if (mutation.expected === 'NOT CAUGHT' && (typeof mutation.reason !== 'string' || !mutation.reason.trim()))
      throw new Error(`An expected surviving mutation needs a reason: ${mutation.label}`);
  }
  return spec;
}

export function batchExitCode(rows) {
  return rows.length === 0 || rows.some(row => !['CAUGHT', 'NOT CAUGHT'].includes(row.verdict)
    || row.verdict !== (row.expected ?? 'CAUGHT')) ? 1 : 0;
}

export function formatRow(label, width, verdict, detail) {
  return `  ${label.padEnd(width)}  ${verdict.padEnd(11)} (${detail})`;
}

export function summarise(rows) {
  const count = (verdict) => rows.filter((row) => row.verdict === verdict).length;
  return `${rows.length} mutations: ${count('CAUGHT')} caught, ${count('NOT CAUGHT')} not caught`
    + `${count('NO BUILD') ? `, ${count('NO BUILD')} did not compile` : ''}`
    + `${count('NOT APPLIED') ? `, ${count('NOT APPLIED')} did not apply` : ''}.`;
}

export function runBatch(box, input, { suiteRunner = runSuite, log = console.log } = {}) {
  const spec = validateSpec(input);
  if (typeof spec.description === 'string') log(spec.description);
  if (typeof spec.provenance === 'string') log(spec.provenance);
  const files = [...new Set(spec.mutations.map(mutation => mutation.file ?? spec.file))];
  const pristine = new Map(files.map(file => [file, readFileSync(path.join(box, file), 'utf8')]));
  for (const suite of [...new Set(spec.mutations.map(mutation => mutation.suite ?? spec.suite))].sort()) {
    const baseline = suiteRunner(box, suite);
    log(`baseline ${suite}: ${baseline.verdict === 'CAUGHT' ? 'FAILING' : baseline.verdict} (${baseline.detail})`);
    if (baseline.verdict !== 'NOT CAUGHT') {
      log('STOPPED: the suite does not pass before any mutation.');
      return { exitCode: 1, rows: [], baselineFailure: suite };
    }
  }
  const width = Math.max(...spec.mutations.map(mutation => mutation.label.length));
  const rows = [];
  for (const mutation of spec.mutations) {
    for (const [file, text] of pristine) writeFileSync(path.join(box, file), text);
    const file = mutation.file ?? spec.file;
    const applied = applyMutation(pristine.get(file), mutation);
    let result;
    if (!applied.ok) result = { verdict: 'NOT APPLIED', detail:
      `${applied.occurrences} occurrence(s), ${mutation.index === undefined ? 'exactly one required' : `asked for index ${mutation.index}`}` };
    else {
      writeFileSync(path.join(box, file), applied.text);
      result = suiteRunner(box, mutation.suite ?? spec.suite);
    }
    const row = { label: mutation.label, expected: mutation.expected ?? 'CAUGHT', ...result };
    rows.push(row);
    log(formatRow(mutation.label, width, row.verdict, `${row.detail}; expected ${row.expected}${mutation.reason ? `: ${mutation.reason}` : ''}`));
  }
  log(`\n${summarise(rows)}`);
  return { exitCode: batchExitCode(rows), rows };
}

function main(argv) {
  const spec = validateSpec(JSON.parse(readFileSync(argv.find(value => !value.startsWith('--')), 'utf8')));
  const box = makeSandbox({ head: argv.includes('--head') });
  try {
    return runBatch(box, spec).exitCode;
  } finally {
    if (!argv.includes('--keep')) rmSync(box, { recursive: true, force: true });
    else console.log(`\nSandbox kept: ${box}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
