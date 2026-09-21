#!/usr/bin/env node
/** A reviewed Git manifest, produced by an independent pinned compilation, is
 * the release trust root. Artifact metadata is never its own bytecode oracle. */
import { readFileSync, writeFileSync, realpathSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import { resolve, join, sep, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const MANIFEST_PATH = 'contracts/release-artifacts.json';
// Public release naming is independent from the authenticated execution wire
// protocol, plan domains and on-chain implementationVersion() identity.
export const RELEASE_IDENTITY = Object.freeze({ publicReleaseVersion: 1, implementationVersion: 4 });
export const RELEASE_CONTRACTS = Object.freeze({
  factory: 'DominoVaultFactoryV1', readHelper: 'DominoVaultReadHelperV1',
  routing: 'DominoRoutingHelperV1', priceGuard: 'DominoPriceGuardV1',
  engine: 'DominoExecutionEngineV1', implementation: 'DominoVaultV1', setup: 'DominoSetupV1',
});
export const COMPILER_VERSION = '0.8.26+commit.8a97fa7a';
export const BUILD_INPUTS = Object.freeze([
  '.nvmrc', '.python-version', 'package.json', 'package-lock.json', 'contracts/foundry.toml',
  'scripts/solc-wrapper.py', 'scripts/solc-compile.cjs', 'scripts/test-contracts.mjs',
  'scripts/prepare-financial-release.mjs', 'scripts/release-artifact-manifest.mjs',
  'scripts/build-public-release.mjs', 'scripts/check-contract-size.mjs',
]);
export const COMPILER_SETTINGS = Object.freeze({
  remappings: [
    '@openzeppelin/contracts/=test/reference/official-v4/openzeppelin-contracts/contracts/',
    '@uniswap/v4-core/=test/reference/official-v4/v4-core/',
    'permit2/=test/reference/official-v4/permit2/',
    'solmate/=test/reference/official-v4/solmate/',
  ], optimizer: { enabled: true, runs: 200 }, metadata: { bytecodeHash: 'none' },
  evmVersion: 'cancun', libraries: {}, viaIR: true,
});
const assert = (value, code) => { if (!value) throw new Error(code); };
export const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const sha256 = value => createHash('sha256').update(value).digest('hex');

function bounded(path, maximum = 8 * 1024 * 1024) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    assert(info.isFile() && info.nlink === 1 && info.size <= maximum, 'invalid_release_input_file');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
function localFile(repo, name) {
  assert(typeof name === 'string' && !name.includes('\\') && !name.startsWith('/')
    && !name.split('/').some(part => part === '.' || part === '..'), 'unsafe_release_input_path');
  const root = realpathSync(repo), path = realpathSync(join(root, name));
  assert(path.startsWith(root + sep), 'release_input_outside_checkout');
  return bounded(path);
}

function assertInputsCommitted(repo, hashes, commit) {
  const entries = Object.entries(hashes);
  const raw = execFileSync('git', ['cat-file', '--batch'], {
    cwd: repo, input: entries.map(([name]) => commit + ':' + name).join('\n') + '\n',
    maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'],
  });
  let offset = 0;
  for (const [, expected] of entries) {
    const newline = raw.indexOf(10, offset);
    assert(newline >= offset, 'release_input_not_committed');
    const header = raw.subarray(offset, newline).toString('ascii');
    const match = /^[0-9a-f]+ blob ([0-9]+)$/.exec(header);
    assert(match, 'release_input_not_committed');
    const start = newline + 1, end = start + Number(match[1]);
    assert(Number.isSafeInteger(end) && end < raw.length && raw[end] === 10, 'release_input_not_committed');
    assert(sha256(raw.subarray(start, end)) === expected, 'release_input_differs_from_head');
    offset = end + 1;
  }
  assert(offset === raw.length, 'invalid_release_git_batch');
}

/** Resolve the exact production import closure independently of out/metadata.
 * Unknown import syntax fails the compiler instead of enabling a remote loader. */
export function releaseInputs(repo) {
  const sources = {};
  const visit = name => {
    assert(name.startsWith('src/') || name.startsWith('lib/') || name.startsWith('test/reference/official-v4/'), 'unsafe_release_source');
    if (Object.hasOwn(sources, name)) return;
    const content = localFile(repo, 'contracts/' + name).toString('utf8');
    sources[name] = { content };
    const withoutComments = content.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    for (const match of withoutComments.matchAll(/\bimport\s+(?:[^;]*?\bfrom\s+)?["']([^"']+)["']\s*;/g)) {
      let dependency = match[1];
      if (dependency.startsWith('.')) dependency = posix.normalize(posix.join(posix.dirname(name), dependency));
      else {
        const mapping = COMPILER_SETTINGS.remappings.find(item => dependency.startsWith(item.split('=')[0]));
        assert(mapping, 'unknown_release_import');
        const [prefix, target] = mapping.split('='); dependency = target + dependency.slice(prefix.length);
      }
      visit(dependency);
    }
  };
  for (const name of Object.values(RELEASE_CONTRACTS)) visit('src/' + name + '.sol');
  return {
    sources: Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))),
    sourceHashes: Object.fromEntries(Object.entries(sources).map(([name, { content }]) => ['contracts/' + name, sha256(content)]).sort(([a], [b]) => a.localeCompare(b))),
    buildInputs: Object.fromEntries(BUILD_INPUTS.map(name => [name, sha256(localFile(repo, name))])),
  };
}

/** Solidity AST ids vary with test compilation units; only the byte offsets
 * actually masked by the verifier matter. Bind the complete normalized set. */
export function artifactIdentity(artifact) {
  const bytecode = artifact.bytecode ?? artifact.evm?.bytecode;
  const deployed = artifact.deployedBytecode ?? artifact.evm?.deployedBytecode;
  const normalize = value => {
    assert(typeof value === 'string' && /^(?:0x)?(?:[0-9a-f]{2})+$/.test(value), 'invalid_release_bytecode');
    return value.replace(/^0x/, '');
  };
  const creation = normalize(bytecode?.object), runtime = normalize(deployed?.object);
  assert(Array.isArray(artifact.abi), 'invalid_release_abi');
  // Foundry groups ABI entries differently from raw solc. Only top-level
  // ordering is irrelevant: preserve every entry and all parameter/component
  // ordering, names, types, mutability, indexed flags and duplicates.
  const abi = artifact.abi.map(canonical).sort().map(entry => JSON.parse(entry));
  assert(Object.keys(bytecode.linkReferences ?? {}).length === 0
    && Object.keys(deployed.linkReferences ?? {}).length === 0, 'unlinked_release_artifact');
  const immutableRanges = Object.values(deployed.immutableReferences ?? {}).flat()
    .map(({ start, length }) => ({ start, length })).sort((a, b) => a.start - b.start);
  let end = 0;
  for (const { start, length } of immutableRanges) {
    assert(Number.isSafeInteger(start) && start >= end && length === 32 && start + length <= runtime.length / 2, 'invalid_release_immutable_range');
    end = start + length;
  }
  return { creationSha256: sha256(Buffer.from(creation, 'hex')), runtimeSha256: sha256(Buffer.from(runtime, 'hex')),
    creationBytes: creation.length / 2, runtimeBytes: runtime.length / 2,
    abiSha256: sha256(canonical(abi)), immutableRanges };
}

export function assertArtifactCompiler(artifact, name) {
  const metadata = typeof artifact.metadata === 'string' ? JSON.parse(artifact.metadata) : artifact.metadata;
  const { compilationTarget, ...settings } = metadata?.settings ?? {};
  // solc emits an explicit empty remapping context (":prefix=target");
  // Foundry removes that colon in its parsed metadata. No nonempty context,
  // target, order or other setting is discarded by this normalization.
  if (Array.isArray(settings.remappings))
    settings.remappings = settings.remappings.map(value => typeof value === 'string' ? value.replace(/^:/, '') : value);
  assert(metadata?.compiler?.version === COMPILER_VERSION
    && canonical(compilationTarget) === canonical({ ['src/' + name + '.sol']: name })
    && canonical(settings) === canonical(COMPILER_SETTINGS), 'artifact_compiler_or_target_mismatch');
}

export function authenticateReleaseArtifacts(repo, rawArtifacts) {
  const raw = localFile(repo, MANIFEST_PATH);
  // A freshly generated or staged manifest is a proposal, not an approved trust
  // root. Replacing an artifact AND its neighboring manifest cannot bless it.
  let committed, sourceCommit;
  try {
    sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    committed = execFileSync('git', ['show', sourceCommit + ':' + MANIFEST_PATH], { cwd: repo, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  }
  catch { throw new Error('release_manifest_not_committed'); }
  assert(raw.equals(committed), 'release_manifest_changed');
  const manifest = JSON.parse(raw), inputs = releaseInputs(repo);
  const expected = {
    schemaVersion: 1, kind: 'domino-reviewed-release-artifacts', compiler: COMPILER_VERSION,
    ...RELEASE_IDENTITY, contractNames: RELEASE_CONTRACTS,
    settings: COMPILER_SETTINGS, sources: inputs.sourceHashes, buildInputs: inputs.buildInputs,
    contracts: Object.fromEntries(Object.entries(RELEASE_CONTRACTS).map(([component, name]) => {
      assertArtifactCompiler(rawArtifacts[component], name);
      return [component, artifactIdentity(rawArtifacts[component])];
    })),
  };
  assert(canonical(manifest.sources) === canonical(expected.sources), 'release_source_changed');
  assert(canonical(manifest.buildInputs) === canonical(expected.buildInputs), 'release_build_input_changed');
  assert(canonical(manifest) === canonical(expected), 'release_artifact_manifest_mismatch');
  // The named sourceCommit must describe the inputs themselves, not merely a
  // committed manifest approving inputs that were left in a dirty worktree.
  assertInputsCommitted(repo, { ...inputs.sourceHashes, ...inputs.buildInputs }, sourceCommit);
  return { manifestSha256: sha256(raw), sourceCommit };
}

/** Independent solc output, never copied from Foundry's artifact metadata. */
export function compileReleaseManifest(repo, artifactDirectory = join(repo, 'contracts/out')) {
  const inputs = releaseInputs(repo);
  const compiler = join(repo, 'scripts/solc-wrapper.py');
  const version = execFileSync('python3', [compiler, '--version'], { cwd: repo, encoding: 'utf8' });
  assert(version.includes('Version: ' + COMPILER_VERSION + '.Emscripten.clang'), 'release_compiler_version_mismatch');
  const outputSelection = Object.fromEntries(Object.values(RELEASE_CONTRACTS).map(name => ['src/' + name + '.sol', {
    [name]: ['abi', 'metadata', 'evm.bytecode', 'evm.deployedBytecode'],
  }]));
  const input = { language: 'Solidity', sources: inputs.sources, settings: { ...COMPILER_SETTINGS, outputSelection } };
  const raw = execFileSync('python3', [compiler, '--standard-json'], {
    cwd: repo, input: JSON.stringify(input), maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000,
  });
  const result = JSON.parse(raw);
  assert(!(result.errors ?? []).some(error => error.severity === 'error'), 'release_compilation_failed');
  const contracts = {};
  for (const [component, name] of Object.entries(RELEASE_CONTRACTS)) {
    const compiled = result.contracts?.['src/' + name + '.sol']?.[name];
    assert(compiled, 'release_compilation_output_missing');
    assertArtifactCompiler(compiled, name);
    const foundry = JSON.parse(bounded(join(artifactDirectory, name + '.sol', name + '.json')));
    assertArtifactCompiler(foundry, name);
    const identity = artifactIdentity(compiled);
    assert(canonical(identity) === canonical(artifactIdentity(foundry)), 'release_rebuild_mismatch_' + component);
    contracts[component] = identity;
  }
  // Inputs changing during compilation must never produce a mixed manifest.
  const after = releaseInputs(repo);
  assert(canonical(inputs) === canonical(after), 'release_inputs_changed_during_build');
  return { schemaVersion: 1, kind: 'domino-reviewed-release-artifacts', compiler: COMPILER_VERSION,
    ...RELEASE_IDENTITY, contractNames: RELEASE_CONTRACTS,
    settings: COMPILER_SETTINGS, sources: inputs.sourceHashes, buildInputs: inputs.buildInputs, contracts };
}

export function manifestMain(args) {
  assert(args.length === 1 && ['--write', '--check'].includes(args[0]), 'usage_release_manifest_write_or_check');
  const repo = resolve(fileURLToPath(new URL('../', import.meta.url)));
  const manifest = compileReleaseManifest(repo);
  if (args[0] === '--write') {
    writeFileSync(join(repo, MANIFEST_PATH), JSON.stringify(manifest, null, 2) + '\n');
    return 'Independent rebuild matches all seven artifacts. Review and commit ' + MANIFEST_PATH + ' before prepare/verify.';
  }
  assert(canonical(JSON.parse(localFile(repo, MANIFEST_PATH))) === canonical(manifest), 'release_rebuild_manifest_mismatch');
  const rawArtifacts = Object.fromEntries(Object.entries(RELEASE_CONTRACTS).map(([component, name]) => [component,
    JSON.parse(bounded(join(repo, 'contracts/out', name + '.sol', name + '.json')))]));
  authenticateReleaseArtifacts(repo, rawArtifacts);
  return 'Independent rebuild matches the release manifest and all seven artifacts.';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(manifestMain(process.argv.slice(2)) + '\n'); }
  catch (error) { process.stderr.write('Release artifact manifest: ' + error.message + '\n'); process.exitCode = 1; }
}
