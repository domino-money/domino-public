#!/usr/bin/env node
// Inspect the final Forge artifacts once. This command does not compile or deploy.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIMITS = Object.freeze({ runtimeBytes: 24_576, initcodeBytes: 49_152, vaultReserveBytes: 313, engineReserveBytes: 2_048 });
export const PROFILE = Object.freeze({ compiler: '0.8.26+commit.8a97fa7a', evmVersion: 'cancun', optimizerRuns: 200, viaIR: true, bytecodeHash: 'none' });
export const CONTRACTS = Object.freeze([
  Object.freeze({ name: 'DominoVaultReadHelper', constructorAddresses: 2, runtimeReserveBytes: 0 }),
  Object.freeze({ name: 'DominoVaultV4', constructorAddresses: 7, runtimeReserveBytes: LIMITS.vaultReserveBytes }),
  Object.freeze({ name: 'DominoVaultFactoryV4', constructorAddresses: 4, runtimeReserveBytes: 0 }),
  Object.freeze({ name: 'DominoExecutionEngineV4', constructorAddresses: 4, runtimeReserveBytes: LIMITS.engineReserveBytes }),
  Object.freeze({ name: 'DominoRoutingHelperV4', constructorAddresses: 0, runtimeReserveBytes: 0 }),
  // Publisher, the state view it bounds a published price against, and the
  // band in basis points (reviewed 2026-09-19 with the price-guard hardening).
  Object.freeze({ name: 'DominoPriceGuardV4', constructorAddresses: 3,
    constructorTypes: Object.freeze(['address', 'address', 'uint256']), runtimeReserveBytes: 0 }),
  Object.freeze({ name: 'DominoSetup', constructorAddresses: 6,
    constructorTypes: Object.freeze(['address', 'address', 'address', 'address', 'uint16', 'uint64']), runtimeReserveBytes: 0 }),
]);

const defaultOut = fileURLToPath(new URL('../contracts/out/', import.meta.url));
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function reject(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  throw error;
}

function metadataProfile(metadata, contract) {
  if (!object(metadata) || !object(metadata.compiler) || !object(metadata.settings)) {
    reject('malformed_metadata', 'compiler and settings metadata are required');
  }
  const { settings } = metadata;
  if (metadata.compiler.version !== PROFILE.compiler || settings.evmVersion !== PROFILE.evmVersion
      || settings.optimizer?.enabled !== true || settings.optimizer?.runs !== PROFILE.optimizerRuns
      || settings.viaIR !== PROFILE.viaIR || settings.metadata?.bytecodeHash !== PROFILE.bytecodeHash) {
    reject('wrong_build_profile', `requires solc ${PROFILE.compiler}, Cancun, optimizer 200, viaIR=true and bytecodeHash=none; rebuild through the reviewed contract suite`);
  }
  const target = settings.compilationTarget;
  if (!object(target) || Object.keys(target).length !== 1 || target[`src/${contract.name}.sol`] !== contract.name) {
    reject('wrong_compilation_target', `expected src/${contract.name}.sol:${contract.name}`);
  }
}

function checkMetadata(artifact, contract) {
  const records = [];
  if (artifact.metadata !== undefined) {
    let metadata = artifact.metadata;
    if (typeof metadata === 'string') {
      try { metadata = JSON.parse(metadata); }
      catch { reject('malformed_metadata', 'metadata is not valid JSON'); }
    }
    records.push(metadata);
  }
  if (artifact.rawMetadata !== undefined) {
    if (typeof artifact.rawMetadata !== 'string') reject('malformed_metadata', 'rawMetadata must be a JSON string');
    try { records.push(JSON.parse(artifact.rawMetadata)); }
    catch { reject('malformed_metadata', 'rawMetadata is not valid JSON'); }
  }
  if (!records.length) reject('missing_metadata', 'Forge compiler metadata is required');
  // Forge can emit both forms; neither may retain a stale/different profile.
  for (const record of records) metadataProfile(record, contract);
}

function bytecodeSize(section, label) {
  if (!object(section) || typeof section.object !== 'string') reject('malformed_bytecode', `${label}.object is required`);
  if (section.linkReferences !== undefined && (!object(section.linkReferences) || Object.keys(section.linkReferences).length !== 0)) {
    reject('unresolved_library_links', `${label} must have no library link references`);
  }
  if (section.object.includes('__')) reject('unresolved_library_links', `${label} contains a link placeholder`);
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(section.object)) reject('malformed_bytecode', `${label} must be nonempty, even-length 0x-prefixed hex`);
  return (section.object.length - 2) / 2;
}

function constructorBytes(abi, contract) {
  if (!Array.isArray(abi)) reject('missing_constructor_abi', 'ABI is required to measure constructor arguments');
  const constructors = abi.filter((entry) => object(entry) && entry.type === 'constructor');
  const types = contract.constructorTypes ?? Array(contract.constructorAddresses).fill('address');
  const absentEmptyConstructor = types.length === 0 && constructors.length === 0;
  if (!absentEmptyConstructor && (constructors.length !== 1 || !Array.isArray(constructors[0].inputs)
      || constructors[0].inputs.length !== types.length
      || constructors[0].inputs.some((input, index) => !object(input) || input.type !== types[index]))) {
    reject('constructor_abi_changed', `expected constructor (${types.join(',')}); review the size gate when changing its static ABI words`);
  }
  if (['DominoVaultReadHelper', 'DominoRoutingHelperV4'].includes(contract.name)) {
    for (const entry of abi) {
      // Custom errors describe revert data, not callable state-changing entry
      // points. The helper's current compiled ABI contains these declarations.
      if (object(entry) && entry.type === 'error') continue;
      const readFunction = object(entry) && entry.type === 'function' && ['view', 'pure'].includes(entry.stateMutability);
      const constructor = object(entry) && entry.type === 'constructor' && entry.stateMutability === 'nonpayable';
      if (!readFunction && !constructor) {
        reject('helper_read_only_abi_changed', 'helper callable ABI must contain only view/pure functions and one nonpayable constructor; no fallback, receive, payable or mutating entry points');
      }
    }
  }
  // Each address occupies one ABI word, not 20 packed bytes. No selector is
  // prepended to constructor arguments; dynamic args require a reviewed change.
  return contract.constructorAddresses * 32;
}

export function inspectArtifact(name, artifact) {
  const contract = CONTRACTS.find((item) => item.name === name);
  if (!contract) reject('unknown_contract', 'only the enumerated architecture artifacts are admitted');
  if (!object(artifact)) reject('malformed_artifact', 'expected a Forge artifact object');
  checkMetadata(artifact, contract);
  const runtimeBytes = bytecodeSize(artifact.deployedBytecode, 'deployedBytecode');
  const creationBytes = bytecodeSize(artifact.bytecode, 'bytecode');
  const argumentsBytes = constructorBytes(artifact.abi, contract);
  const initcodeBytes = creationBytes + argumentsBytes;
  const runtimeHeadroomBytes = LIMITS.runtimeBytes - runtimeBytes;
  const initcodeHeadroomBytes = LIMITS.initcodeBytes - initcodeBytes;
  const issues = [];
  if (runtimeHeadroomBytes < 0) issues.push('runtime_limit_exceeded');
  if (initcodeHeadroomBytes < 0) issues.push('initcode_limit_exceeded');
  if (runtimeHeadroomBytes >= 0 && runtimeHeadroomBytes < contract.runtimeReserveBytes) issues.push(contract.name === 'DominoExecutionEngineV4' ? 'engine_runtime_reserve_exceeded' : 'vault_runtime_reserve_exceeded');
  return { name, ok: issues.length === 0, runtimeBytes, runtimeHeadroomBytes,
    requiredRuntimeReserveBytes: contract.runtimeReserveBytes, creationBytes, constructorArgumentsBytes: argumentsBytes,
    initcodeBytes, initcodeHeadroomBytes, issues };
}

export function checkContractSizes(outDirectory = defaultOut) {
  const contracts = CONTRACTS.map(({ name }) => {
    const artifactPath = path.join(outDirectory, `${name}.sol`, `${name}.json`);
    try {
      let artifact;
      try { artifact = JSON.parse(readFileSync(artifactPath, 'utf8')); }
      catch (error) {
        if (error.code === 'ENOENT') reject('missing_artifact', 'run the reviewed contract suite before this gate');
        reject('unreadable_artifact', error instanceof SyntaxError ? 'artifact is not valid JSON' : 'artifact could not be read');
      }
      return inspectArtifact(name, artifact);
    } catch (error) {
      return { name, ok: false, issues: [error.code ?? 'artifact_check_failed'], detail: error.message };
    }
  });
  // The factory's own creation bytecode already embeds its child creation
  // payloads. Measuring that artifact + its ABI args counts nested deployment
  // code exactly once; do not add the separate child artifact sizes again.
  return { version: 1, ok: contracts.every((contract) => contract.ok), profile: PROFILE, limits: LIMITS, contracts };
}

export function formatReport(report) {
  const rows = report.contracts.map((contract) => {
    if (contract.runtimeBytes === undefined) return `${contract.name}: FAIL ${contract.detail}`;
    const outcome = contract.ok ? 'PASS' : `FAIL ${contract.issues.join(', ')}`;
    return `${contract.name}: ${outcome}; runtime ${contract.runtimeBytes}/${LIMITS.runtimeBytes} B, headroom ${contract.runtimeHeadroomBytes} B (required ${contract.requiredRuntimeReserveBytes} B); initcode ${contract.initcodeBytes}/${LIMITS.initcodeBytes} B including ${contract.constructorArgumentsBytes} B constructor arguments`;
  });
  if (report.contracts.some((contract) => contract.issues.some((issue) => issue.endsWith('_runtime_reserve_exceeded')))) {
    rows.push(`Runtime reserves must remain at least ${LIMITS.vaultReserveBytes} bytes for the vault and ${LIMITS.engineReserveBytes} for the engine. Consuming them requires an explicit architecture review and gate change.`);
  }
  return rows.join('\n');
}

function main(args) {
  let out = defaultOut;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--json' && !json) json = true;
    else if (args[index] === '--out' && args[index + 1] && !args[index + 1].startsWith('--')) out = path.resolve(args[++index]);
    else reject('invalid_arguments', 'usage: node scripts/check-contract-size.mjs [--out PATH] [--json]');
  }
  const report = checkContractSizes(out);
  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(`Contract size gate: ${error.message}`); process.exitCode = 1; }
}
