#!/usr/bin/env node
// A committed gas baseline for the contract suites, so a regression fails CI
// instead of living in a report.
//
// Runs `forge snapshot` one suite at a time (a whole-tree run OOMs soljson,
// issue #145) and keeps only the deterministic entries - fuzz and invariant
// tests report a mean that moves with the seed, so they are left out. The
// baseline is contracts/.gas-snapshot, sorted, one `Suite:test (gas: N)` per
// line. `--check` fails on any test whose gas rose above its baseline; tests
// that are new, gone, or cheaper are reported and pass, so adding a test does
// not need a baseline update but a regression does need a deliberate one.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contractArguments, resolveForge } from './test-contracts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const BASELINE = path.join(root, 'contracts', '.gas-snapshot');
const ENTRY = /^([A-Za-z0-9_]+):([A-Za-z0-9_]+\([^)]*\)) \(gas: (\d+)\)$/;

export function listSuites(directory = path.join(root, 'contracts', 'test')) {
  const found = [];
  const walk = (folder) => {
    for (const name of readdirSync(folder).sort()) {
      const full = path.join(folder, name);
      if (statSync(full).isDirectory()) { if (name !== 'official-v4') walk(full); }
      else if (name.endsWith('.t.sol')) found.push(path.relative(path.join(root, 'contracts'), full));
    }
  };
  walk(directory);
  return found;
}

/** Parse a snapshot file into {'Suite:test()': gas}; fuzz and invariant lines have no `(gas: N)` and are skipped. */
export function parseSnapshot(text) {
  const entries = {};
  for (const line of text.split('\n')) {
    const match = ENTRY.exec(line.trim());
    if (match) entries[`${match[1]}:${match[2]}`] = Number(match[3]);
  }
  return entries;
}

export function formatSnapshot(entries) {
  return Object.keys(entries).sort().map((key) => `${key} (gas: ${entries[key]})`).join('\n') + '\n';
}

/** Compare a run against the baseline: regressions fail, everything else is informational. */
export function compare(baseline, current) {
  const regressions = [], improvements = [], added = [], removed = [];
  for (const key of Object.keys(current).sort()) {
    if (!(key in baseline)) added.push(key);
    else if (current[key] > baseline[key]) regressions.push({ key, before: baseline[key], after: current[key] });
    else if (current[key] < baseline[key]) improvements.push({ key, before: baseline[key], after: current[key] });
  }
  for (const key of Object.keys(baseline).sort()) if (!(key in current)) removed.push(key);
  return { ok: regressions.length === 0, regressions, improvements, added, removed };
}

export function formatComparison(result) {
  const rows = [];
  const line = ({ key, before, after }) => `${key}: ${before} -> ${after} (${after > before ? '+' : ''}${after - before})`;
  for (const item of result.regressions) rows.push(`REGRESSION ${line(item)}`);
  for (const item of result.improvements) rows.push(`improved ${line(item)}`);
  for (const key of result.added) rows.push(`new ${key}`);
  for (const key of result.removed) rows.push(`gone ${key}`);
  rows.push(result.ok ? 'Gas baseline: no regressions.' : `Gas baseline: ${result.regressions.length} regression(s). Run \`node scripts/gas-baseline.mjs --update\` if the increase is intended, and say why in the commit.`);
  return rows.join('\n');
}

export function snapshotSuite(binary, suite, run = spawnSync) {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'domino-gas-'));
  try {
    const file = path.join(folder, 'snap');
    const result = run(binary, contractArguments(['--match-path', suite, '--snap', file], 'snapshot'), { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`forge snapshot failed for ${suite} with status ${result.status}`);
    return parseSnapshot(readFileSync(file, 'utf8'));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

async function main(argv) {
  const update = argv.includes('--update');
  const check = argv.includes('--check');
  if (update === check) throw new Error('pass exactly one of --check or --update');
  const binary = await resolveForge();
  const current = {};
  for (const suite of listSuites()) Object.assign(current, snapshotSuite(binary, suite));
  if (update) {
    writeFileSync(BASELINE, formatSnapshot(current));
    console.log(`Gas baseline written: ${Object.keys(current).length} deterministic tests in ${path.relative(root, BASELINE)}.`);
    return 0;
  }
  const baseline = parseSnapshot(readFileSync(BASELINE, 'utf8'));
  const result = compare(baseline, current);
  console.log(formatComparison(result));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((status) => process.exit(status), (error) => { console.error(error.message); process.exit(1); });
}
