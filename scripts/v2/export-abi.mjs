#!/usr/bin/env node
// Domino V2 interface freeze, machine-readable: compiles contracts/src/v2 with
// the repository's pinned solc (scripts/solc-wrapper.py) and writes each
// interface's ABI plus its function selectors and ERC-165 interface id to
// api-contracts/v2/abi/. The backend and the app read these files instead of
// re-declaring the interfaces. `--check` fails when a committed export is stale.
//
// Additive (F7 D7): the deployable contracts' events and errors, which the app
// decodes in receipts and reverts but no frozen interface declares (for example
// SwapLegExecuted, emitted by the zap from F1b's executor, and the position
// adapters' errors that the v4 zap bubbles up from its steps contract), go to
// api-contracts/v2/implementations/: one file per contract with its events and
// errors (ABI items, topics and selectors), and index.json, which also maps each
// F0/#301 component to the contracts whose events and errors surface through it
// (a delegatecall target's included). Nothing under abi/ and no interface id changes.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const contracts = path.join(repo, 'contracts');
const sourceRoot = path.join(contracts, 'src/v2');
const outDir = path.join(repo, 'api-contracts/v2/abi');
const implementationsDir = path.join(repo, 'api-contracts/v2/implementations');
const pinTest = path.join(contracts, 'test/v2/DominoV2Interfaces.t.sol');

/** Each deployable component (F0, #301's manifest) and the contracts whose events and errors it can surface. */
export const COMPONENTS = {
  registry: ['DominoRegistry'],
  priceAnchor: ['DominoPriceAnchor'],
  autoExit: ['DominoAutoExit'],
  vaultSwap: ['DominoV2VaultSwapModule'],
  'vault.v3': ['DominoV2VaultV3', 'DominoV2VaultExecutorV3', 'DominoV2VaultSwapModule'],
  'vault.v4': ['DominoV2VaultV4', 'DominoV2VaultExecutorV4', 'DominoV2VaultSwapModule'],
  'vaultFactory.v3': ['DominoV2VaultFactory'],
  'vaultFactory.v4': ['DominoV2VaultFactory'],
  'zap.v4.steps': ['DominoZapV4Steps'],
  'zap.v3': ['DominoZapV3'],
  'zap.v4': ['DominoZapV4', 'DominoZapV4Steps'],
  'vaultExecutor.v3': ['DominoV2VaultExecutorV3'],
  'vaultExecutor.v4': ['DominoV2VaultExecutorV4'],
};

export function v2Sources() {
  const found = {};
  const walk = folder => {
    for (const name of readdirSync(folder).sort()) {
      const full = path.join(folder, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.sol')) found[path.relative(contracts, full)] = { content: readFileSync(full, 'utf8') };
    }
  };
  walk(sourceRoot);
  return found;
}

export function compileInterfaces(sources = v2Sources()) {
  const input = {
    language: 'Solidity',
    sources,
    settings: { evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.methodIdentifiers'] } } },
  };
  const raw = execFileSync('python3', [path.join(repo, 'scripts/solc-wrapper.py'), '--standard-json'], {
    cwd: contracts, input: JSON.stringify(input), maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000,
  });
  const result = JSON.parse(raw);
  const errors = (result.errors ?? []).filter(error => error.severity === 'error');
  if (errors.length) throw new Error('v2_compilation_failed: ' + errors.map(error => error.formattedMessage).join('\n'));
  return result.contracts;
}

/** Interfaces only: their ABI is the frozen surface; libraries export no ABI. */
export function interfaceExports(compiled) {
  const exports = {};
  for (const [file, byName] of Object.entries(compiled)) {
    if (!file.includes('/interfaces/') && !file.includes('/external/')) continue;
    for (const [name, artifact] of Object.entries(byName)) {
      const selectors = artifact.evm?.methodIdentifiers ?? {};
      let id = 0;
      for (const selector of Object.values(selectors)) id = (id ^ parseInt(selector, 16)) >>> 0;
      exports[name] = {
        source: 'contracts/' + file,
        interfaceId: '0x' + id.toString(16).padStart(8, '0'),
        functions: Object.fromEntries(Object.entries(selectors).sort(([a], [b]) => a.localeCompare(b))
          .map(([signature, selector]) => [signature, '0x' + selector])),
        abi: artifact.abi,
      };
    }
  }
  return Object.fromEntries(Object.entries(exports).sort(([a], [b]) => a.localeCompare(b)));
}

const canonicalType = (parameter) => parameter.type.startsWith('tuple')
  ? '(' + parameter.components.map(canonicalType).join(',') + ')' + parameter.type.slice('tuple'.length)
  : parameter.type;
const signatureOf = (item) => item.name + '(' + item.inputs.map(canonicalType).join(',') + ')';

/** Keccak-256 of a signature. The compiler lists function selectors only (evm.methodIdentifiers),
 * and Node has no Keccak, so event topics and error selectors are hashed here; every run checks
 * this function against all the compiler's function selectors first. */
const RC = [0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n,
  0x8000000000008009n, 0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n,
  0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
const ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
const MASK = (1n << 64n) - 1n;
const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK);
export function keccakHex(text) {
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / 136) * 136);
  padded.set(bytes);
  padded[bytes.length] ^= 1;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += 136) {
    for (let i = 0; i < 17; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[offset + i * 8 + k]);
      s[i] ^= lane;
    }
    for (let round = 0; round < 24; round++) {
      const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
      for (let x = 0; x < 5; x++) {
        const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
        for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
      }
      const b = new Array(25);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x][y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & MASK & b[((x + 2) % 5) + 5 * y]);
      s[0] ^= RC[round];
    }
  }
  let out = '0x';
  for (let i = 0; i < 4; i++) for (let k = 0; k < 8; k++) out += Number((s[i] >> BigInt(8 * k)) & 0xffn).toString(16).padStart(2, '0');
  return out;
}

/** The deployable contracts' events and errors, by contract name, from the same compilation. */
export function implementationExports(compiled) {
  const names = [...new Set(Object.values(COMPONENTS).flat())].sort();
  const exports = {};
  for (const name of names) {
    const found = Object.entries(compiled).filter(([file, byName]) => file.startsWith('src/v2/') && byName[name]);
    if (found.length !== 1) throw new Error('v2_implementation_not_unique: ' + name);
    const [file, byName] = found[0];
    // One item per signature: an error declared alike in two bases (Unauthorized()) is listed twice by solc.
    const unique = (kind) => [...new Map(byName[name].abi.filter((item) => item.type === kind)
      .map((item) => [signatureOf(item), item])).values()].sort((a, b) => signatureOf(a).localeCompare(signatureOf(b)));
    const events = unique('event');
    const errors = unique('error');
    exports[name] = {
      source: 'contracts/' + file,
      eventTopics: Object.fromEntries(events.map((item) => [signatureOf(item), keccakHex(signatureOf(item))])),
      errorSelectors: Object.fromEntries(errors.map((item) => [signatureOf(item), keccakHex(signatureOf(item)).slice(0, 10)])),
      abi: [...events, ...errors],
    };
  }
  return exports;
}

export function renderImplementations(exports) {
  const files = {};
  for (const [name, value] of Object.entries(exports)) files[name + '.json'] = JSON.stringify(value, null, 2) + '\n';
  const index = {
    note: 'Events and errors of the deployable V2 contracts (not a frozen surface); components maps each F0/#301 component to the contracts whose events and errors it can surface.',
    components: COMPONENTS,
    contracts: Object.fromEntries(Object.entries(exports).map(([name, value]) => [name, {
      source: value.source, eventTopics: value.eventTopics, errorSelectors: value.errorSelectors }])),
  };
  files['index.json'] = JSON.stringify(index, null, 2) + '\n';
  return files;
}

export function renderExports(exports) {
  const files = {};
  for (const [name, value] of Object.entries(exports)) files[name + '.json'] = JSON.stringify(value, null, 2) + '\n';
  const index = Object.fromEntries(Object.entries(exports).map(([name, value]) => [name, {
    source: value.source, interfaceId: value.interfaceId, functions: value.functions,
  }]));
  files['index.json'] = JSON.stringify(index, null, 2) + '\n';
  return files;
}

/** The Solidity side of the freeze: every interface with functions keeps its id. */
export function renderPinTest(exports) {
  const pinned = Object.entries(exports).filter(([, value]) => Object.keys(value.functions).length);
  const byFile = new Map();
  for (const [name, value] of pinned) {
    const from = '../../' + path.relative('contracts', value.source).split(path.sep).join('/');
    byFile.set(from, [...(byFile.get(from) ?? []), name].sort());
  }
  const imports = [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([from, names]) => `import {${names.join(', ')}} from "${from}";`).join('\n');
  const pins = pinned.map(([name, value]) => `        _pin(type(${name}).interfaceId, ${value.interfaceId}, "${name}");`).join('\n');
  return `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

${imports}

// Generated by scripts/v2/export-abi.mjs; do not edit. A change here is an
// interface change: regenerate the export and commit both together.

/// @notice The F0 freeze in Solidity: every V2 interface compiles and keeps the
/// ERC-165 id exported in api-contracts/v2/abi/index.json.
contract DominoV2InterfacesTest {
    error InterfaceChanged(string name, bytes4 actual, bytes4 pinned);

    function _pin(bytes4 actual, bytes4 pinned, string memory name) private pure {
        if (actual != pinned) revert InterfaceChanged(name, actual, pinned);
    }

    function testInterfaceIdsArePinned() public pure {
${pins}
    }
}
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const compiled = compileInterfaces();
  const exported = interfaceExports(compiled);
  const files = renderExports(exported);
  const implementations = renderImplementations(implementationExports(compiled));
  // The local Keccak-256 against the compiler's own selectors (functions of every interface).
  for (const value of Object.values(exported)) {
    for (const [signature, selector] of Object.entries(value.functions)) {
      if (keccakHex(signature).slice(0, 10) !== selector) throw new Error('v2_keccak_mismatch: ' + signature);
    }
  }
  const pins = renderPinTest(exported);
  const staleIn = (directory, rendered, label) => Object.entries(rendered).filter(([name, text]) => {
    const target = path.join(directory, name);
    return !existsSync(target) || readFileSync(target, 'utf8') !== text;
  }).map(([name]) => label + name);
  const extraIn = (directory, rendered, label) => (existsSync(directory) ? readdirSync(directory) : [])
    .filter(name => !(name in rendered)).map(name => label + name);
  const stale = [...staleIn(outDir, files, ''), ...staleIn(implementationsDir, implementations, 'implementations/')];
  const extra = [...extraIn(outDir, files, ''), ...extraIn(implementationsDir, implementations, 'implementations/')];
  if (!existsSync(pinTest) || readFileSync(pinTest, 'utf8') !== pins) stale.push(path.relative(repo, pinTest));
  if (check) {
    if (stale.length || extra.length) {
      console.error('Stale V2 ABI exports: ' + [...stale, ...extra.map(name => name + ' (no longer exported)')].join(', '));
      process.exit(1);
    }
    console.log('V2 ABI exports are current.');
  } else {
    mkdirSync(outDir, { recursive: true });
    mkdirSync(implementationsDir, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(outDir, name), text);
    for (const [name, text] of Object.entries(implementations)) writeFileSync(path.join(implementationsDir, name), text);
    writeFileSync(pinTest, pins);
    console.log('Wrote ' + Object.keys(files).length + ' files to api-contracts/v2/abi and '
      + Object.keys(implementations).length + ' to api-contracts/v2/implementations');
  }
}
