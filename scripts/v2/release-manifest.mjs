#!/usr/bin/env node
// The V2 freeze (docs/v2/FREEZE.md). contracts/release-artifacts-v2.json is
// the reviewed manifest of the release under audit: the compiler, every
// source under contracts/src/v2 (the vendored Uniswap math included), the
// files that decide the bytecode or what the deployment tool prepares, and
// each deployable contract's creation and runtime bytecode, immutable slots
// and ABI. scripts/v2/deploy.mjs refuses a public preparation from anything
// else.
//
//   node scripts/v2/release-manifest.mjs --check [--forge-out contracts/out]
//     Compiles every V2 source with deploy.mjs's pinned solc-js and fails when
//     the committed manifest differs. With --forge-out, the Foundry artifacts
//     there (what the suites deployed) must be the same contracts.
//   node scripts/v2/release-manifest.mjs --write
//     Rewrites the manifest from the same compile: a deliberate commit.
//
// DOMINO_V2_COMPILE_CACHE (CI) reuses the deployment tests' compile of an
// identical standard-JSON input. No key, no network.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_MANIFEST_PATH, artifactIdentity, canonical, compileV2, releaseManifest, repoRoot } from './deploy.mjs';

/** Where two manifests differ, one line per source, input or contract field. */
export function differences(committed, expected) {
  const lines = [];
  for (const key of new Set([...Object.keys(committed), ...Object.keys(expected)])) {
    if (['sources', 'releaseInputs', 'contracts'].includes(key)) continue;
    if (canonical(committed[key]) !== canonical(expected[key])) lines.push(key + ' changed');
  }
  for (const group of ['sources', 'releaseInputs']) {
    const before = committed[group] ?? {}, after = expected[group] ?? {};
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!(name in after)) lines.push(group + ': ' + name + ' removed');
      else if (!(name in before)) lines.push(group + ': ' + name + ' added');
      else if (before[name] !== after[name]) lines.push(group + ': ' + name + ' changed');
    }
  }
  const before = committed.contracts ?? {}, after = expected.contracts ?? {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const fields = new Set([...Object.keys(before[name] ?? {}), ...Object.keys(after[name] ?? {})]);
    const changed = [...fields].filter(field => canonical(before[name]?.[field]) !== canonical(after[name]?.[field]));
    if (changed.length) lines.push('contracts: ' + name + ' ' + changed.join(', '));
  }
  return lines;
}

/** The manifest's contracts the Foundry artifacts in `forgeOut` do not match. */
export function forgeMismatches(manifest, forgeOut) {
  return Object.entries(manifest.contracts).flatMap(([name, { source, ...pinned }]) => {
    const file = path.join(forgeOut, path.basename(source), name + '.json');
    if (!existsSync(file)) return [name + ': no Foundry artifact at ' + path.relative(repoRoot, file)];
    const identity = artifactIdentity(JSON.parse(readFileSync(file, 'utf8')));
    const changed = Object.keys(pinned).filter(field => canonical(identity[field]) !== canonical(pinned[field]));
    return changed.length ? [name + ': Foundry artifact differs in ' + changed.join(', ')] : [];
  });
}

function main(argv) {
  const write = argv.includes('--write'), check = argv.includes('--check');
  const at = argv.indexOf('--forge-out'), forgeOut = at === -1 ? undefined : argv[at + 1];
  const known = new Set(['--write', '--check', '--forge-out', forgeOut]);
  if (write === check || (at !== -1 && !forgeOut) || argv.some(arg => !known.has(arg))) {
    throw new Error('usage: release-manifest.mjs --check [--forge-out DIR] | --write');
  }
  const artifacts = compileV2({ cacheDirectory: process.env.DOMINO_V2_COMPILE_CACHE || undefined });
  const expected = releaseManifest(artifacts);
  const file = path.join(repoRoot, RELEASE_MANIFEST_PATH);
  if (write) {
    writeFileSync(file, JSON.stringify(expected, null, 2) + '\n');
    return `Wrote ${RELEASE_MANIFEST_PATH}: ${Object.keys(expected.sources).length} sources, ${Object.keys(expected.contracts).length} contracts.`;
  }
  const problems = existsSync(file) ? differences(JSON.parse(readFileSync(file, 'utf8')), expected) : [RELEASE_MANIFEST_PATH + ' missing'];
  if (forgeOut) problems.push(...forgeMismatches(expected, path.resolve(forgeOut)));
  if (problems.length) {
    throw new Error(problems.join('\n') + `\nThe V2 release manifest is stale. A change to a frozen V2 source is deliberate: run \`node scripts/v2/release-manifest.mjs --write\` and say why in the commit (docs/v2/FREEZE.md).`);
  }
  return `${RELEASE_MANIFEST_PATH} matches: ${Object.keys(expected.sources).length} sources, ${Object.keys(expected.contracts).length} contracts${forgeOut ? ', and the Foundry artifacts are the same contracts' : ''}.`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(main(process.argv.slice(2))); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
