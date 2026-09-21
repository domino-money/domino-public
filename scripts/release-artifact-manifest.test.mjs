import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { MANIFEST_PATH, RELEASE_CONTRACTS, RELEASE_IDENTITY, COMPILER_VERSION, COMPILER_SETTINGS, BUILD_INPUTS,
  artifactIdentity, assertArtifactCompiler, releaseInputs } from './release-artifact-manifest.mjs';
import { toolsFor, loadArtifacts, prepare, verify } from './prepare-financial-release.mjs';

const viem = toolsFor(resolve(fileURLToPath(new URL('../', import.meta.url))));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (repo, name, value) => {
  const file = join(repo, name); mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
};
function git(repo, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Synthetic release test',
    '-c', 'user.email=release-test@example.invalid', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
}
function fixture(t, { committed = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'domino-release-identity-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const sources = {}, buildInputs = {}, rawArtifacts = {}, contracts = {};
  for (const name of BUILD_INPUTS) {
    const body = 'synthetic tracked build input: ' + name + '\n'; write(repo, name, body); buildInputs[name] = hash(body);
  }
  for (const [component, name] of Object.entries(RELEASE_CONTRACTS)) {
    const path = 'src/' + name + '.sol', source = 'pragma solidity 0.8.26; contract ' + name + ' {}\n';
    write(repo, 'contracts/' + path, source); sources['contracts/' + path] = hash(source);
    // This is a synthetic, explicitly committed trust fixture, not a claimed
    // compilation. Mutations exercise the release admission boundary directly.
    const artifact = { abi: [], bytecode: { object: '0x60006000', linkReferences: {} },
      deployedBytecode: { object: '0x' + '00'.repeat(64), immutableReferences: { 1: [{ start: 0, length: 32 }] }, linkReferences: {} },
      metadata: { compiler: { version: COMPILER_VERSION }, settings: { ...COMPILER_SETTINGS, compilationTarget: { [path]: name } },
        sources: { [path]: { keccak256: viem.keccak256('0x' + Buffer.from(source).toString('hex')) } } } };
    write(repo, 'contracts/out/' + name + '.sol/' + name + '.json', artifact);
    rawArtifacts[component] = artifact;
    contracts[component] = { creationSha256: hash(Buffer.from('60006000', 'hex')), runtimeSha256: hash(Buffer.alloc(64)),
      creationBytes: 4, runtimeBytes: 64, abiSha256: hash('[]'), immutableRanges: [{ start: 0, length: 32 }] };
  }
  const manifest = { schemaVersion: 1, kind: 'domino-reviewed-release-artifacts', compiler: COMPILER_VERSION,
    ...RELEASE_IDENTITY, contractNames: RELEASE_CONTRACTS,
    settings: COMPILER_SETTINGS, sources, buildInputs, contracts };
  write(repo, MANIFEST_PATH, manifest);
  git(repo, 'init', '-q'); git(repo, 'add', '.');
  if (committed) git(repo, 'commit', '-qm', 'Synthetic reviewed manifest and inputs');
  return { repo, rawArtifacts, manifest, writeArtifact(component) {
    const name = RELEASE_CONTRACTS[component]; write(repo, 'contracts/out/' + name + '.sol/' + name + '.json', rawArtifacts[component]);
  } };
}

test('reviewed Git manifest admits matching source/build/ABI/bytecode identity and seals artifacts', t => {
  const { repo } = fixture(t), artifacts = loadArtifacts(repo, viem);
  assert(Object.isFrozen(artifacts)); assert(Object.isFrozen(artifacts.setup.abi)); assert(Object.isFrozen(artifacts.setup.ranges[0]));
  assert.throws(() => { artifacts.engine.runtime = '0x00'; }, TypeError);
  assert.throws(() => prepare({}, structuredClone(artifacts), viem), /unauthenticated_release_artifacts/);
});

test('public names are V1 while the authenticated implementation protocol remains 4', t => {
  assert.deepEqual(RELEASE_CONTRACTS, { factory: 'DominoVaultFactoryV1', readHelper: 'DominoVaultReadHelperV1',
    routing: 'DominoRoutingHelperV1', priceGuard: 'DominoPriceGuardV1', engine: 'DominoExecutionEngineV1',
    implementation: 'DominoVaultV1', setup: 'DominoSetupV1' });
  assert.deepEqual(RELEASE_IDENTITY, { publicReleaseVersion: 1, implementationVersion: 4 });
  for (const update of [{ publicReleaseVersion: 4 }, { implementationVersion: 1 },
    { contractNames: { ...RELEASE_CONTRACTS, implementation: 'DominoVaultV4' } }]) {
    const f = fixture(t); Object.assign(f.manifest, update); write(f.repo, MANIFEST_PATH, f.manifest);
    git(f.repo, 'add', MANIFEST_PATH); git(f.repo, 'commit', '-qm', 'Incompatible synthetic release identity');
    assert.throws(() => loadArtifacts(f.repo, viem), /release_artifact_manifest_mismatch/);
  }
});

for (const [label, change] of [
  ['runtime byte while metadata remains authentic', artifact => { artifact.deployedBytecode.object = '0x01' + artifact.deployedBytecode.object.slice(4); }],
  ['creation byte while metadata remains authentic', artifact => { artifact.bytecode.object = '0x60006001'; }],
  ['ABI constructor substitution', artifact => { artifact.abi = [{ type: 'constructor', inputs: [{ type: 'address', name: 'recipient' }], stateMutability: 'nonpayable' }]; }],
  ['removed immutable mask', artifact => { artifact.deployedBytecode.immutableReferences = {}; }],
  ['moved immutable mask', artifact => { artifact.deployedBytecode.immutableReferences = { 1: [{ start: 32, length: 32 }] }; }],
]) test('artifact substitution is refused: ' + label, t => {
  const f = fixture(t); change(f.rawArtifacts.engine); f.writeArtifact('engine');
  assert.throws(() => loadArtifacts(f.repo, viem), /release_artifact_manifest_mismatch/);
});

test('changing source and matching artifact metadata cannot self-authenticate bytecode', t => {
  const f = fixture(t), name = RELEASE_CONTRACTS.engine, path = 'src/' + name + '.sol';
  const replacement = 'pragma solidity 0.8.26; contract ' + name + ' { uint256 changed; }\n';
  write(f.repo, 'contracts/' + path, replacement);
  f.rawArtifacts.engine.metadata.sources[path].keccak256 = viem.keccak256('0x' + Buffer.from(replacement).toString('hex'));
  f.writeArtifact('engine');
  assert.throws(() => loadArtifacts(f.repo, viem), /release_source_changed/);
});

test('compiler configuration, lockfile and wrapper changes invalidate the approval', t => {
  const f = fixture(t);
  for (const path of ['contracts/foundry.toml', 'package-lock.json', 'scripts/solc-wrapper.py', 'scripts/solc-compile.cjs',
    'scripts/build-public-release.mjs', 'scripts/check-contract-size.mjs']) {
    const original = readFileSync(join(f.repo, path), 'utf8'); write(f.repo, path, original + 'changed\n');
    assert.throws(() => loadArtifacts(f.repo, viem), /release_build_input_changed/);
    write(f.repo, path, original);
  }
  f.rawArtifacts.setup.metadata.settings = { ...f.rawArtifacts.setup.metadata.settings, optimizer: { enabled: true, runs: 201 } };
  f.writeArtifact('setup'); assert.throws(() => loadArtifacts(f.repo, viem), /artifact_compiler_or_target_mismatch/);
});

test('artifact plus local or staged manifest substitution cannot replace the HEAD trust root', t => {
  const f = fixture(t);
  f.rawArtifacts.engine.bytecode.object = '0x60006001'; f.writeArtifact('engine');
  f.manifest.contracts.engine.creationSha256 = hash(Buffer.from('60006001', 'hex'));
  write(f.repo, MANIFEST_PATH, f.manifest);
  assert.throws(() => loadArtifacts(f.repo, viem), /release_manifest_changed/);
  git(f.repo, 'add', MANIFEST_PATH);
  assert.throws(() => loadArtifacts(f.repo, viem), /release_manifest_changed/);
});

for (const field of ['source', 'build input']) test('committing only a manifest cannot approve an uncommitted ' + field, t => {
  const f = fixture(t);
  if (field === 'source') {
    const name = RELEASE_CONTRACTS.engine, path = 'src/' + name + '.sol';
    const body = readFileSync(join(f.repo, 'contracts', path), 'utf8') + '// locally edited source\n';
    write(f.repo, 'contracts/' + path, body);
    f.rawArtifacts.engine.metadata.sources[path].keccak256 = viem.keccak256('0x' + Buffer.from(body).toString('hex'));
    f.writeArtifact('engine'); f.manifest.sources['contracts/' + path] = hash(body);
  } else {
    const path = 'scripts/solc-compile.cjs', body = 'modified compiler adapter\n';
    write(f.repo, path, body); f.manifest.buildInputs[path] = hash(body);
  }
  write(f.repo, MANIFEST_PATH, f.manifest);
  git(f.repo, 'add', MANIFEST_PATH); git(f.repo, 'commit', '-qm', 'Only manifest committed, inputs left dirty');
  assert.throws(() => loadArtifacts(f.repo, viem), /release_input_differs_from_head/);
});

test('uncommitted manifest and stripped manifest fields fail closed', t => {
  const f = fixture(t, { committed: false });
  assert.throws(() => loadArtifacts(f.repo, viem), /release_manifest_not_committed/);
  delete f.manifest.contracts.engine; write(f.repo, MANIFEST_PATH, f.manifest);
  git(f.repo, 'add', MANIFEST_PATH); git(f.repo, 'commit', '-qm', 'Malformed synthetic manifest');
  assert.throws(() => loadArtifacts(f.repo, viem), /release_artifact_manifest_mismatch/);
});

test('verify also refuses an untrusted artifact set before RPC or package construction', async t => {
  const { repo } = fixture(t), artifacts = loadArtifacts(repo, viem);
  await assert.rejects(() => verify({ parameters: {} }, [], structuredClone(artifacts), viem,
    () => { throw new Error('RPC must not be called'); }), /unauthenticated_release_artifacts/);
});

test('imported sources are independently discovered rather than taken from artifact metadata', t => {
  const f = fixture(t), path = 'contracts/src/' + RELEASE_CONTRACTS.engine + '.sol';
  write(f.repo, path, 'pragma solidity 0.8.26; import {Dependency} from "./Dependency.sol"; contract ' + RELEASE_CONTRACTS.engine + ' {}\n');
  write(f.repo, 'contracts/src/Dependency.sol', 'pragma solidity 0.8.26; contract Dependency {}\n');
  const before = releaseInputs(f.repo);
  assert.equal(Object.keys(before.sources).length, 8);
  write(f.repo, 'contracts/src/Dependency.sol', 'pragma solidity 0.8.26; contract Dependency { uint256 changed; }\n');
  assert.notEqual(releaseInputs(f.repo).sourceHashes['contracts/src/Dependency.sol'], before.sourceHashes['contracts/src/Dependency.sol']);
});

test('immutable normalization ignores compiler AST ids but cannot mask an extra byte range', () => {
  const base = { abi: [], bytecode: { object: '6000' }, deployedBytecode: { object: '00'.repeat(96),
    immutableReferences: { 71: [{ start: 32, length: 32 }], 6: [{ start: 0, length: 32 }] } } };
  const renumbered = structuredClone(base);
  renumbered.deployedBytecode.immutableReferences = { 1: [{ start: 0, length: 32 }], 2: [{ start: 32, length: 32 }] };
  assert.deepEqual(artifactIdentity(base), artifactIdentity(renumbered));
  renumbered.deployedBytecode.immutableReferences[3] = [{ start: 64, length: 32 }];
  assert.notDeepEqual(artifactIdentity(base), artifactIdentity(renumbered));
});

test('raw solc empty remapping contexts equal Foundry normalization; nonempty contexts do not', () => {
  const settings = { ...COMPILER_SETTINGS, compilationTarget: { 'src/DominoSetupV1.sol': 'DominoSetupV1' },
    remappings: COMPILER_SETTINGS.remappings.map(value => ':' + value) };
  const metadata = { compiler: { version: COMPILER_VERSION }, settings };
  assert.doesNotThrow(() => assertArtifactCompiler({ metadata: JSON.stringify(metadata) }, 'DominoSetupV1'));
  metadata.settings.remappings[0] = 'src/:' + COMPILER_SETTINGS.remappings[0];
  assert.throws(() => assertArtifactCompiler({ metadata: JSON.stringify(metadata) }, 'DominoSetupV1'), /artifact_compiler_or_target_mismatch/);
});

test('ABI top-level ordering is immaterial but constructor parameter order and duplicates are bound', () => {
  const base = { abi: [
    { type: 'constructor', stateMutability: 'nonpayable', inputs: [{ name: 'owner', type: 'address' }, { name: 'fee', type: 'uint16' }] },
    { type: 'error', name: 'Invalid', inputs: [] },
  ], bytecode: { object: '6000' }, deployedBytecode: { object: '00'.repeat(32) } };
  const reordered = structuredClone(base); reordered.abi.reverse();
  assert.deepEqual(artifactIdentity(base), artifactIdentity(reordered));
  const params = structuredClone(base); params.abi[0].inputs.reverse();
  assert.notEqual(artifactIdentity(base).abiSha256, artifactIdentity(params).abiSha256);
  const duplicate = structuredClone(base); duplicate.abi.push(duplicate.abi[0]);
  assert.notEqual(artifactIdentity(base).abiSha256, artifactIdentity(duplicate).abiSha256);
});
