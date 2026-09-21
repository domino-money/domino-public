#!/usr/bin/env node
// Public V1 is a deployment name, not a migration of the technical V4 protocol.
// Compile every entrypoint, then prove exact artifact identity against its base.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveForge, contractArguments, runChecked } from './test-contracts.mjs';
import { PUBLIC_ALIASES, PUBLIC_CONTRACTS, checkContractSizes, formatReport, inspectArtifact } from './check-contract-size.mjs';
import { RELEASE_CONTRACTS, artifactIdentity, assertArtifactCompiler, canonical } from './release-artifact-manifest.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));

export function checkPublicReleaseEquivalence(out = join(repo, 'contracts/out')) {
  const names = Object.keys(PUBLIC_ALIASES).sort();
  if (canonical(names) !== canonical(Object.values(RELEASE_CONTRACTS).sort()))
    throw new Error('public_release_targets_differ');
  const read = name => {
    const artifact = JSON.parse(readFileSync(join(out, name + '.sol', name + '.json'), 'utf8'));
    assertArtifactCompiler(artifact, name);
    if (!inspectArtifact(name, artifact).ok) throw new Error('public_release_size_failed_' + name);
    return artifactIdentity(artifact);
  };
  return names.map(name => {
    const base = PUBLIC_ALIASES[name], identity = read(name), original = read(base);
    // No bytecode masks, optimizer exceptions or ABI-field deletions here.
    // artifactIdentity only canonicalizes ABI entry order and immutable AST ids.
    if (canonical(identity) !== canonical(original)) throw new Error('public_alias_identity_mismatch_' + name);
    return { name, base, exactIdentity: true, ...identity };
  });
}

export function buildPublicRelease(binary, {
  run = runChecked, sizes = checkContractSizes, equivalents = checkPublicReleaseEquivalence, log = console.log,
} = {}) {
  const paths = Object.keys(PUBLIC_ALIASES).map(name => 'src/' + name + '.sol');
  const status = run(binary, contractArguments(paths, 'build'), { cwd: join(repo, 'contracts') });
  if (status !== 0) return status;
  const report = sizes(join(repo, 'contracts/out'), PUBLIC_CONTRACTS);
  log(formatReport(report));
  if (!report.ok) return 1;
  const matches = equivalents();
  log('Public Domino V1: ' + matches.length + '/7 aliases have identical creation/runtime bytecode, ABI and immutable ranges to their technical bases.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error('usage_node_scripts_build_public_release');
    process.exitCode = buildPublicRelease(await resolveForge());
  } catch (error) { process.stderr.write('Public release build: ' + error.message + '\n'); process.exitCode = 1; }
}
