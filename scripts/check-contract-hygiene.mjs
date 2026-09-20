#!/usr/bin/env node
// Mechanical hygiene for the Solidity sources, so the state the 19 September
// review left them in stays that way without another review: one compiler
// version, a licence line, no leftover markers, no imported name that nothing
// uses, and no development-only imports in shipped code.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const PRAGMA = 'pragma solidity 0.8.26;';
const MARKERS = /\b(TODO|FIXME|XXX|HACK|TBD)\b/;
const DEVELOPMENT_IMPORTS = /^import\s+.*["'](forge-std|hardhat|ds-test)\//m;
const IMPORT = /^import\s+\{([^}]*)\}\s+from\s+["']([^"']+)["'];/gm;

export function listSources(base = path.join(root, 'contracts')) {
  const found = [];
  const walk = (folder, shipped) => {
    for (const name of readdirSync(folder).sort()) {
      const full = path.join(folder, name);
      if (statSync(full).isDirectory()) { if (name !== 'official-v4') walk(full, shipped); }
      else if (name.endsWith('.sol')) found.push({ file: path.relative(root, full), shipped });
    }
  };
  walk(path.join(base, 'src'), true);
  walk(path.join(base, 'test'), false);
  return found;
}

/** The names each file imports, keyed by the file they come from, so a re-export counts as a use. */
export function importedNames(sources) {
  const byFile = new Map();
  for (const { file, text } of sources) {
    for (const match of text.matchAll(IMPORT)) {
      const from = path.normalize(path.join(path.dirname(file), match[2]));
      const names = byFile.get(from) ?? new Set();
      for (const raw of match[1].split(',')) { const name = raw.trim().split(/\s+as\s+/)[0]; if (name) names.add(name); }
      byFile.set(from, names);
    }
  }
  return byFile;
}

/** Every finding for one source file; `shipped` applies the rules test code is exempt from,
 *  and `reexported` names are the ones other files import from this one. */
export function inspectSource(text, { shipped = true, reexported = new Set() } = {}) {
  const findings = [];
  const lines = text.split('\n');
  if (!/^\/\/ SPDX-License-Identifier: /.test(lines[0] ?? '')) findings.push('missing_spdx');
  if (!lines.includes(PRAGMA)) findings.push('wrong_pragma');
  const marker = lines.findIndex((line) => MARKERS.test(line));
  if (marker !== -1) findings.push(`leftover_marker:${marker + 1}`);
  if (shipped && DEVELOPMENT_IMPORTS.test(text)) findings.push('development_import');
  const body = text.replace(/^import[^\n]*\n/gm, '');
  for (const match of text.matchAll(IMPORT)) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop();
      if (name && !reexported.has(name) && !new RegExp(`\\b${name}\\b`).test(body)) findings.push(`unused_import:${name}`);
    }
  }
  return findings;
}

export function checkContractHygiene(base) {
  const sources = listSources(base).map((entry) => ({ ...entry, text: readFileSync(path.join(root, entry.file), 'utf8') }));
  const reexports = importedNames(sources);
  const report = [];
  for (const { file, shipped, text } of sources) {
    const findings = inspectSource(text, { shipped, reexported: reexports.get(path.normalize(file)) ?? new Set() });
    if (findings.length) report.push({ file, findings });
  }
  return { ok: report.length === 0, report };
}

export function formatHygiene(result) {
  if (result.ok) return 'Contract hygiene: clean.';
  return result.report.map(({ file, findings }) => `${file}: ${findings.join(', ')}`).join('\n')
    + `\nContract hygiene: ${result.report.length} file(s) with findings.`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkContractHygiene();
  console.log(formatHygiene(result));
  process.exit(result.ok ? 0 : 1);
}
