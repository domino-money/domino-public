#!/usr/bin/env node
// Run a batch of source mutations against the contract suites, in a disposable
// copy of the repository, and report whether each one is caught.
//
// This is how every coverage claim in reports/ was produced and how any of them
// can be re-checked: a guard counts as covered when deleting it makes a test
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
// optionally its own `file`, `suite`, and `index` to pick among repeated
// occurrences. `--head` mutates the last commit instead of the working tree,
// so a batch can run while tests are being edited.
//
// Verdicts, one per mutation:
//   CAUGHT       the suite failed - the clause is covered
//   NOT CAUGHT   the suite passed - nothing tests that clause
//   NOT APPLIED  the text was not found exactly once as asked - fix the batch
//   NO BUILD     the mutation does not compile - it proves nothing
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const RESULT = /^Suite result: (ok|FAILED)\. (\d+) passed; (\d+) failed/m;

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
  const match = RESULT.exec(result.stdout ?? '');
  if (!match) {
    const error = /^Error.*$/m.exec(result.stdout ?? '') ?? /^Error.*$/m.exec(result.stderr ?? '');
    return { verdict: 'NO BUILD', detail: (error?.[0] ?? (result.stdout ?? '').slice(-90)).trim() };
  }
  return { verdict: match[1] === 'FAILED' ? 'CAUGHT' : 'NOT CAUGHT', detail: `${match[2]} passed / ${match[3]} failed` };
}

/** Put `next` in place of the `index`-th occurrence of `previous`, or say why not. */
export function applyMutation(text, { old: previous, new: next, index = 0 }) {
  const parts = text.split(previous);
  if (parts.length - 1 <= index) return { ok: false, occurrences: parts.length - 1 };
  return { ok: true, text: parts.slice(0, index + 1).join(previous) + next + parts.slice(index + 1).join(previous) };
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

function main(argv) {
  const spec = JSON.parse(readFileSync(argv.find((value) => !value.startsWith('--')), 'utf8'));
  const head = argv.includes('--head');
  const box = makeSandbox({ head });
  try {
    const files = [...new Set(spec.mutations.map((mutation) => mutation.file ?? spec.file))];
    const pristine = new Map(files.map((file) => [file, readFileSync(path.join(box, file), 'utf8')]));
    for (const suite of [...new Set(spec.mutations.map((mutation) => mutation.suite ?? spec.suite))].sort()) {
      const { verdict, detail } = runSuite(box, suite);
      console.log(`baseline ${suite}: ${verdict === 'CAUGHT' ? 'FAILING' : verdict} (${detail})`);
      if (verdict !== 'NOT CAUGHT') { console.log('STOPPED: the suite does not pass before any mutation.'); return 1; }
    }
    console.log();
    const width = Math.max(...spec.mutations.map((mutation) => mutation.label.length));
    const rows = [];
    for (const mutation of spec.mutations) {
      for (const [file, text] of pristine) writeFileSync(path.join(box, file), text);
      const file = mutation.file ?? spec.file;
      const applied = applyMutation(pristine.get(file), mutation);
      if (!applied.ok) {
        rows.push({ verdict: 'NOT APPLIED' });
        console.log(formatRow(mutation.label, width, 'NOT APPLIED', `${applied.occurrences} occurrence(s), asked for index ${mutation.index ?? 0}`));
        continue;
      }
      writeFileSync(path.join(box, file), applied.text);
      const { verdict, detail } = runSuite(box, mutation.suite ?? spec.suite);
      rows.push({ verdict });
      console.log(formatRow(mutation.label, width, verdict, detail));
    }
    console.log(`\n${summarise(rows)}`);
    return 0;
  } finally {
    if (!argv.includes('--keep')) rmSync(box, { recursive: true, force: true });
    else console.log('\nSandbox kept.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
