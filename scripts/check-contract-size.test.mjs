import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CONTRACTS, LIMITS, PROFILE, checkContractSizes, formatReport, inspectArtifact } from './check-contract-size.mjs';

const command = fileURLToPath(new URL('./check-contract-size.mjs', import.meta.url));
const bytes = (length) => `0x${'01'.repeat(length)}`;
function artifact(name = 'DominoVaultV4', { runtime = 10_000, creation = 30_000 } = {}) {
  const contract = CONTRACTS.find((value) => value.name === name);
  const metadata = { compiler: { version: PROFILE.compiler }, settings: { compilationTarget: { [`src/${name}.sol`]: name },
    evmVersion: 'cancun', optimizer: { enabled: true, runs: 200 }, viaIR: true, metadata: { bytecodeHash: 'none' } } };
  return { metadata, rawMetadata: JSON.stringify(metadata),
    abi: [{ type: 'constructor', stateMutability: 'nonpayable', inputs: Array.from({ length: contract.constructorAddresses }, (_, index) => ({ name: `arg${index}`, type: contract.constructorTypes?.[index] ?? 'address' })) }],
    bytecode: { object: bytes(creation), linkReferences: {} }, deployedBytecode: { object: bytes(runtime), linkReferences: {} } };
}
function rewriteProfile(value, update) {
  update(value.metadata);
  value.rawMetadata = JSON.stringify(value.metadata);
  return value;
}
function directory(t) {
  const output = mkdtempSync(path.join(os.tmpdir(), 'domino size gate '));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  return output;
}
function populate(output) {
  for (const { name } of CONTRACTS) {
    mkdirSync(path.join(output, `${name}.sol`), { recursive: true });
    writeFileSync(path.join(output, `${name}.sol`, `${name}.json`), JSON.stringify(artifact(name)));
  }
}

test('EIP-170 exact runtime limit passes for non-reserved production contracts; one byte over fails', () => {
  for (const name of ['DominoVaultFactoryV4', 'DominoVaultReadHelper']) {
    const exact = inspectArtifact(name, artifact(name, { runtime: 24_576 }));
    assert.equal(exact.ok, true);
    assert.equal(exact.runtimeHeadroomBytes, 0);
    const over = inspectArtifact(name, artifact(name, { runtime: 24_577 }));
    assert.deepEqual(over.issues, ['runtime_limit_exceeded']);
  }
});

test('vault architecture reserve has its own exact boundary below the chain limit', () => {
  const exact = inspectArtifact('DominoVaultV4', artifact('DominoVaultV4', { runtime: LIMITS.runtimeBytes - LIMITS.vaultReserveBytes }));
  assert.equal(exact.ok, true);
  assert.equal(exact.runtimeHeadroomBytes, LIMITS.vaultReserveBytes);
  const over = inspectArtifact('DominoVaultV4', artifact('DominoVaultV4', { runtime: LIMITS.runtimeBytes - LIMITS.vaultReserveBytes + 1 }));
  assert.deepEqual(over.issues, ['vault_runtime_reserve_exceeded']);
  assert.match(formatReport({ contracts: [over] }), /explicit architecture review/);
});

test('initcode includes ABI address words and no selector: exact 49152 passes, next byte fails', () => {
  for (const { name, constructorAddresses } of CONTRACTS) {
    const args = constructorAddresses * 32;
    const exact = inspectArtifact(name, artifact(name, { creation: 49_152 - args }));
    assert.equal(exact.ok, true, name);
    assert.equal(exact.constructorArgumentsBytes, args);
    assert.equal(exact.initcodeBytes, 49_152);
    assert.deepEqual(inspectArtifact(name, artifact(name, { creation: 49_153 - args })).issues, ['initcode_limit_exceeded']);
  }
});

test('factory nested child creation bytes are already present and are not counted again', (t) => {
  const output = directory(t);
  populate(output);
  writeFileSync(path.join(output, 'DominoVaultFactoryV4.sol/DominoVaultFactoryV4.json'), JSON.stringify(artifact('DominoVaultFactoryV4', { creation: 49_024 })));
  const report = checkContractSizes(output);
  assert.equal(report.ok, true);
  assert.equal(report.contracts.find((value) => value.name === 'DominoVaultFactoryV4').initcodeBytes, 49_152);
});

test('metadata rejects missing, malformed and stale/wrong compiler profiles', () => {
  const missing = artifact();
  delete missing.metadata;
  delete missing.rawMetadata;
  assert.throws(() => inspectArtifact('DominoVaultV4', missing), { code: 'missing_metadata' });
  for (const change of [
    (metadata) => { metadata.compiler.version = '0.8.27+commit.40a35a09'; },
    (metadata) => { metadata.compiler.version = '0.8.26+commit.deadbeef'; },
    (metadata) => { metadata.settings.evmVersion = 'shanghai'; },
    (metadata) => { metadata.settings.optimizer.runs = 1; },
    (metadata) => { metadata.settings.optimizer.enabled = false; },
    (metadata) => { delete metadata.settings.viaIR; },
    (metadata) => { metadata.settings.viaIR = 'true'; },
    (metadata) => { metadata.settings.metadata.bytecodeHash = 'ipfs'; },
    (metadata) => { metadata.settings.metadata.bytecodeHash = 'bzzr1'; },
    (metadata) => { delete metadata.settings.metadata.bytecodeHash; },
    (metadata) => { delete metadata.settings.metadata; },
  ]) assert.throws(() => inspectArtifact('DominoVaultV4', rewriteProfile(artifact(), change)), { code: 'wrong_build_profile' });
  assert.throws(() => inspectArtifact('DominoVaultV4', { ...artifact(), metadata: 'not-json' }), { code: 'malformed_metadata' });
  assert.throws(() => inspectArtifact('DominoVaultV4', { ...artifact(), rawMetadata: '{}' }), { code: 'malformed_metadata' });
});

test('a stale duplicate metadata representation or different compilation target cannot pass', () => {
  const value = artifact();
  const stale = structuredClone(value.metadata);
  stale.settings.viaIR = false;
  value.rawMetadata = JSON.stringify(stale);
  assert.throws(() => inspectArtifact('DominoVaultV4', value), { code: 'wrong_build_profile' });
  const target = rewriteProfile(artifact(), (metadata) => { metadata.settings.compilationTarget = { 'test/Fake.sol': 'DominoVaultV4' }; });
  assert.throws(() => inspectArtifact('DominoVaultV4', target), { code: 'wrong_compilation_target' });
  const rawOnly = artifact();
  delete rawOnly.metadata;
  assert.equal(inspectArtifact('DominoVaultV4', rawOnly).ok, true);
});

test('bytecode is nonempty exact hex and cannot retain unresolved link slots', () => {
  for (const section of ['bytecode', 'deployedBytecode']) {
    for (const object of ['', '0x', '0x1', '1234', '0xgg', null, 10]) {
      const value = artifact();
      value[section].object = object;
      assert.throws(() => inspectArtifact('DominoVaultV4', value), { code: 'malformed_bytecode' });
    }
    const placeholder = artifact();
    placeholder[section].object = '0x__$1234567890abcdef1234567890abcdef12$__';
    assert.throws(() => inspectArtifact('DominoVaultV4', placeholder), { code: 'unresolved_library_links' });
    const references = artifact();
    references[section].linkReferences = { 'Library.sol': { Library: [{ start: 0, length: 20 }] } };
    assert.throws(() => inspectArtifact('DominoVaultV4', references), { code: 'unresolved_library_links' });
  }
});

test('constructor ABI changes cannot silently undercount dynamic or added deployment arguments', () => {
  for (const change of [
    (abi) => { abi[0].inputs.push({ type: 'address' }); },
    (abi) => { abi[0].inputs[0].type = 'bytes'; },
    (abi) => { abi[0].inputs[0].type = 'address[]'; },
    (abi) => { abi.push(structuredClone(abi[0])); },
    (abi) => { abi.length = 0; },
  ]) {
    const value = artifact();
    change(value.abi);
    assert.throws(() => inspectArtifact('DominoVaultV4', value), { code: 'constructor_abi_changed' });
  }
  const value = artifact();
  delete value.abi;
  assert.throws(() => inspectArtifact('DominoVaultV4', value), { code: 'missing_constructor_abi' });
});

test('missing or malformed artifacts fail closed and still report the other contracts', (t) => {
  const output = directory(t);
  assert.equal(checkContractSizes(output).contracts.filter((value) => value.issues.includes('missing_artifact')).length, CONTRACTS.length);
  populate(output);
  writeFileSync(path.join(output, 'DominoVaultV4.sol/DominoVaultV4.json'), '{');
  const report = checkContractSizes(output);
  assert.equal(report.ok, false);
  assert.deepEqual(report.contracts.find((value) => value.name === 'DominoVaultV4').issues, ['unreadable_artifact']);
  assert.equal(report.contracts.filter((value) => value.ok).length, CONTRACTS.length - 1);
});

test('CLI works with spaced paths, emits machine-readable results and propagates actual failure', (t) => {
  const output = directory(t);
  populate(output);
  let result = spawnSync(process.execPath, [command, '--out', output, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.limits, LIMITS);
  writeFileSync(path.join(output, 'DominoVaultV4.sol/DominoVaultV4.json'), JSON.stringify(artifact('DominoVaultV4', { runtime: 24_577 })));
  result = spawnSync(process.execPath, [command, '--out', output, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
  result = spawnSync(process.execPath, [command, '--skip-reserve'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid_arguments/);
});


test('helper ABI admits only nonpayable construction, view/pure functions and custom error declarations', () => {
  const value = artifact('DominoVaultReadHelper');
  value.abi.push({ type: 'function', name: 'readPosition', stateMutability: 'view', inputs: [], outputs: [] },
    { type: 'function', name: 'positionIdentity', stateMutability: 'pure', inputs: [], outputs: [] },
    { type: 'error', name: 'InvalidPosition', inputs: [] });
  assert.equal(inspectArtifact('DominoVaultReadHelper', value).ok, true);
  for (const entry of [
    { type: 'function', name: 'mutate', stateMutability: 'nonpayable', inputs: [], outputs: [] },
    { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
    { type: 'function', name: 'legacy', constant: true, inputs: [], outputs: [] },
    { type: 'fallback', stateMutability: 'nonpayable' },
    { type: 'fallback', stateMutability: 'view' },
    { type: 'receive', stateMutability: 'payable' },
    { type: 'unknown' }, null,
  ]) {
    const changed = artifact('DominoVaultReadHelper');
    changed.abi.push(entry);
    assert.throws(() => inspectArtifact('DominoVaultReadHelper', changed), { code: 'helper_read_only_abi_changed' });
  }
  for (const state of ['payable', 'view', undefined]) {
    const changed = artifact('DominoVaultReadHelper');
    changed.abi[0].stateMutability = state;
    assert.throws(() => inspectArtifact('DominoVaultReadHelper', changed), { code: 'helper_read_only_abi_changed' });
  }
  // Owner-bound vault mutations remain legitimate; this is the helper boundary.
  const vault = artifact('DominoVaultV4');
  vault.abi.push({ type: 'function', name: 'pause', stateMutability: 'nonpayable', inputs: [], outputs: [] });
  assert.equal(inspectArtifact('DominoVaultV4', vault).ok, true);
});


test('execution engine has its own runtime reserve and measured constructor arguments', () => {
  const exact = inspectArtifact('DominoExecutionEngineV4', artifact('DominoExecutionEngineV4', {
    runtime: LIMITS.runtimeBytes - LIMITS.engineReserveBytes,
  }));
  assert.equal(exact.ok, true);
  assert.equal(exact.constructorArgumentsBytes, 128);
  assert.equal(exact.requiredRuntimeReserveBytes, LIMITS.engineReserveBytes);
  const over = inspectArtifact('DominoExecutionEngineV4', artifact('DominoExecutionEngineV4', {
    runtime: LIMITS.runtimeBytes - LIMITS.engineReserveBytes + 1,
  }));
  assert.deepEqual(over.issues, ['engine_runtime_reserve_exceeded']);
  assert.match(formatReport({ contracts: [over] }), /explicit architecture review/);
});


test('V4 staged architecture and setup static tariff words have explicit size gates', () => {
  for (const name of ['DominoVaultV4','DominoVaultFactoryV4','DominoExecutionEngineV4','DominoRoutingHelperV4','DominoPriceGuardV4','DominoSetup']) {
    assert.equal(inspectArtifact(name, artifact(name)).ok, true);
  }
  const routing = artifact('DominoRoutingHelperV4'); routing.abi = [];
  assert.equal(inspectArtifact('DominoRoutingHelperV4', routing).constructorArgumentsBytes, 0);
  const setup = artifact('DominoSetup');
  assert.equal(inspectArtifact('DominoSetup', setup).constructorArgumentsBytes, 192);
  setup.abi[0].inputs[4].type = 'bytes';
  assert.throws(() => inspectArtifact('DominoSetup', setup), { code: 'constructor_abi_changed' });
  const boundary = inspectArtifact('DominoVaultV4',artifact('DominoVaultV4',{runtime:24263}));
  assert.equal(boundary.ok,true); assert.equal(boundary.runtimeHeadroomBytes,313);
  assert.deepEqual(inspectArtifact('DominoVaultV4',artifact('DominoVaultV4',{runtime:24264})).issues,['vault_runtime_reserve_exceeded']);
});
