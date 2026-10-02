#!/usr/bin/env node
// Offline fixtures of the deployed Uniswap contracts the V2 position adapters
// (F1c, docs/v2/F1_POSITIONS.md) are tested against. Uniswap v3 cannot be
// compiled here (solc 0.7.6) and the vendored v4 copy is newer than what is
// deployed, so the tests etch the deployed runtime bytecode instead.
//
//   node scripts/v2/position-fixtures.mjs capture [--rpc URL] [--block N]
//     Reads each contract's code at one block of Base (8453), checks its
//     keccak256 against api-contracts/v2/chains/base-8453.json, records the
//     storage the constructors set, and writes
//     contracts/test/v2/positions/fixtures/base-8453.json (provenance) and
//     contracts/test/v2/positions/fixtures/UniswapBase8453.sol (generated).
//   node scripts/v2/position-fixtures.mjs check
//     Offline: every embedded runtime still hashes to the profile's code hash,
//     the Solidity file is exactly what the manifest renders, and the vendored
//     math under contracts/src/v2/positions/uniswap differs from the reference
//     copies only by the recorded edits.
//
// Read-only JSON-RPC (eth_blockNumber, eth_getCode, eth_getStorageAt); no
// keys, no transactions.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { keccak256 } = require('js-sha3'); // solc's own dependency, pinned by package-lock
const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const fixtures = path.join(repo, 'contracts/test/v2/positions/fixtures');
const manifestPath = path.join(fixtures, 'base-8453.json');
const solidityPath = path.join(fixtures, 'UniswapBase8453.sol');
const profilePath = path.join(repo, 'api-contracts/v2/chains/base-8453.json');

const hash = hex => '0x' + keccak256(Buffer.from(hex.replace(/^0x/, ''), 'hex'));
const word = value => BigInt(value).toString(16).padStart(64, '0');
const mappingSlot = (key, slot) => hash(word(key) + word(slot));

/** The contracts, where the profile lists them, and the constructor-set storage each needs. */
export function targets(profile) {
  const verified = name => {
    const entry = profile.verification.contracts.find(contract => contract.name === name);
    if (!entry?.codehash) throw new Error(`profile has no verified ${name}`);
    return entry;
  };
  const fees = Object.keys(profile.uniswap.v3.tickSpacingByFee).map(Number);
  return [
    { key: 'V3_FACTORY', contract: 'UniswapBase8453V3Factory', name: 'UniswapV3Factory',
      address: profile.uniswap.v3.factory, codehash: verified('UniswapV3Factory').codehash, license: 'BUSL-1.1, now GPL-2.0-or-later (v3-core 1.0.0)',
      // Parameters (slots 0-2) are transient deploy arguments; owner is slot 3;
      // feeAmountTickSpacing is the mapping at slot 4.
      storage: [{ slot: '0x3', note: 'owner (tests replace it)' },
        ...fees.map(fee => ({ slot: mappingSlot(fee, 4), note: `feeAmountTickSpacing[${fee}]`, fixtureValue: profile.uniswap.v3.tickSpacingByFee[fee] }))] },
    { key: 'V3_POSITION_MANAGER', contract: 'UniswapBase8453V3PositionManager', name: 'NonfungiblePositionManager',
      address: profile.uniswap.v3.positionManager, codehash: verified('NonfungiblePositionManager').codehash, license: 'GPL-2.0-or-later (v3-periphery 1.0.0)',
      storage: [{ slot: '0x6', note: 'ERC721 name', fixtureValue: 'live' }, { slot: '0x7', note: 'ERC721 symbol', fixtureValue: 'live' },
        { slot: '0xd', note: '_nextId (low 176 bits) and _nextPoolId (high 80 bits); the constructor sets both to 1', fixtureValue: '0x' + ((1n << 176n) | 1n).toString(16) }] },
    { key: 'WETH9', contract: 'UniswapBase8453Weth9', name: 'WETH',
      address: profile.wrappedNative.address, codehash: verified('WETH').codehash, license: 'GPL-3.0-or-later (WETH9, DappHub; OP Stack predeploy)',
      storage: [{ slot: '0x0', note: 'name', fixtureValue: 'live' }, { slot: '0x1', note: 'symbol', fixtureValue: 'live' }, { slot: '0x2', note: 'decimals', fixtureValue: 'live' }] },
    { key: 'V4_POOL_MANAGER', contract: 'UniswapBase8453V4PoolManager', name: 'PoolManager',
      address: profile.uniswap.v4.poolManager, codehash: verified('PoolManager').codehash, license: 'BUSL-1.1 (v4-core), test use only',
      storage: [{ slot: '0x0', note: 'owner (tests replace it)' }, { slot: '0x2', note: 'protocolFeeController (tests replace it)' }] },
    { key: 'V4_POSITION_MANAGER', contract: 'UniswapBase8453V4PositionManager', name: 'PositionManager',
      address: profile.uniswap.v4.positionManager, codehash: verified('PositionManager').codehash, license: 'MIT (v4-periphery)',
      storage: [{ slot: '0x0', note: 'ERC721 name', fixtureValue: 'live' }, { slot: '0x1', note: 'ERC721 symbol', fixtureValue: 'live' },
        { slot: '0x8', note: 'nextTokenId; the constructor sets 1', fixtureValue: '0x1' }] },
    { key: 'V4_STATE_VIEW', contract: 'UniswapBase8453V4StateView', name: 'StateView',
      address: profile.uniswap.v4.stateView, codehash: verified('StateView').codehash, license: 'MIT (v4-periphery)', storage: [] },
  ];
}

/** The Solidity fixture: one holder per runtime (its constructor returns the
 *  deployed code, so each stays under the initcode limit and no test embeds
 *  it), and a library of addresses, hashes and constructor storage. */
export function render(manifest, codes) {
  const lines = [];
  lines.push('// SPDX-License-Identifier: MIT AND BUSL-1.1 AND GPL-2.0-or-later AND GPL-3.0-or-later');
  lines.push('pragma solidity 0.8.26;');
  lines.push('');
  lines.push('// Generated by scripts/v2/position-fixtures.mjs from base-8453.json; do not edit.');
  lines.push(`// Runtime bytecode read from ${manifest.chain} (chain ${manifest.chainId}) at block ${manifest.block}.`);
  lines.push('// Each runtime belongs to its upstream project under its own licence (listed');
  lines.push('// per contract below) and is embedded for local tests only.');
  lines.push('');
  lines.push('/// @notice Addresses, code hashes and constructor storage of the Base (8453)');
  lines.push('/// Uniswap deployments the F1c tests etch. Immutables in the bytecode point at');
  lines.push('/// these addresses, so each runtime must be etched at its own address.');
  lines.push('library UniswapBase8453 {');
  lines.push(`    uint256 internal constant CHAIN_ID = ${manifest.chainId};`);
  lines.push(`    uint256 internal constant BLOCK = ${manifest.block};`);
  for (const target of manifest.contracts) {
    lines.push(`    address internal constant ${target.key} = ${target.address};`);
    lines.push(`    bytes32 internal constant ${target.key}_CODEHASH = ${target.codehash};`);
    lines.push(`    string internal constant ${target.key}_ARTIFACT = "UniswapBase8453.sol:${target.contract}";`);
  }
  const writes = manifest.contracts.flatMap(target => target.storage.filter(entry => entry.fixtureValue !== undefined)
    .map(entry => ({ key: target.key, slot: '0x' + word(entry.slot), value: entry.fixtureValue, note: entry.note })));
  lines.push('');
  lines.push('    /// @notice The storage each constructor wrote, as the tests write it after');
  lines.push('    /// etching: (account, slot, value) triples.');
  lines.push('    function constructorStorage()');
  lines.push('        internal');
  lines.push('        pure');
  lines.push('        returns (address[] memory accounts, bytes32[] memory slots, bytes32[] memory values)');
  lines.push('    {');
  lines.push(`        accounts = new address[](${writes.length});`);
  lines.push(`        slots = new bytes32[](${writes.length});`);
  lines.push(`        values = new bytes32[](${writes.length});`);
  writes.forEach((entry, index) => {
    lines.push(`        // ${entry.key}: ${entry.note}`);
    lines.push(`        (accounts[${index}], slots[${index}], values[${index}]) = (${entry.key}, ${entry.slot}, ${entry.value});`);
  });
  lines.push('    }');
  lines.push('}');
  for (const target of manifest.contracts) {
    lines.push('');
    lines.push(`/// @notice ${target.name} at ${target.address}: ${target.license}.`);
    lines.push(`contract ${target.contract} {`);
    lines.push('    constructor() {');
    lines.push(`        bytes memory runtime = hex"${codes[target.key].replace(/^0x/, '')}";`);
    lines.push('        assembly ("memory-safe") {');
    lines.push('            return(add(runtime, 0x20), mload(runtime))');
    lines.push('        }');
    lines.push('    }');
    lines.push('}');
  }
  return lines.join('\n') + '\n';
}

/** The runtimes embedded in a rendered fixture, by holder contract name. */
export function embedded(text) {
  const codes = {};
  for (const match of text.matchAll(/^contract (\w+) \{\n {4}constructor\(\) \{\n {8}bytes memory runtime = hex"([0-9a-f]*)";/gm)) codes[match[1]] = '0x' + match[2];
  return codes;
}

async function rpc(url, method, params) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'domino-position-fixtures' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function capture(argv) {
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  const option = name => { const index = argv.indexOf(name); return index === -1 ? undefined : argv[index + 1]; };
  const url = option('--rpc') ?? 'https://mainnet.base.org';
  const chainId = Number.parseInt(await rpc(url, 'eth_chainId', []), 16);
  if (chainId !== profile.chainId) throw new Error(`RPC chain ${chainId} is not ${profile.chainId}`);
  const block = option('--block') ? Number(option('--block')) : Number.parseInt(await rpc(url, 'eth_blockNumber', []), 16);
  const tag = '0x' + block.toString(16);
  const codes = {};
  const contracts = [];
  for (const target of targets(profile)) {
    const code = await rpc(url, 'eth_getCode', [target.address, tag]);
    if (hash(code) !== target.codehash.toLowerCase()) throw new Error(`${target.name}: code hash ${hash(code)} is not the profile's ${target.codehash}`);
    codes[target.key] = code.toLowerCase();
    const storage = [];
    for (const entry of target.storage) {
      const live = await rpc(url, 'eth_getStorageAt', [target.address, entry.slot, tag]);
      const value = entry.fixtureValue === undefined ? undefined
        : entry.fixtureValue === 'live' ? live : '0x' + word(entry.fixtureValue);
      storage.push({ slot: entry.slot, note: entry.note, liveValue: live, ...(value === undefined ? {} : { fixtureValue: value }) });
    }
    const { storage: _ignored, ...rest } = target;
    contracts.push({ ...rest, codehash: target.codehash.toLowerCase(), runtimeBytes: (code.length - 2) / 2, storage });
  }
  const manifest = {
    chain: 'Base', chainId, block, rpc: url, capturedAt: new Date().toISOString().slice(0, 10),
    profile: 'api-contracts/v2/chains/base-8453.json',
    method: 'eth_getCode and eth_getStorageAt at the block; keccak256(code) checked against the profile. Storage: the slots each constructor writes, located on the live contract (liveValue); the tests write fixtureValue after etching, or their own value where none is given. feeAmountTickSpacing covers the fee tiers the profile lists.',
    contracts,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(solidityPath, render(manifest, codes));
  console.log(`Captured ${contracts.length} contracts from ${manifest.chain} block ${block}.`);
}

/** Vendored files: the reference copy each mirrors and the only lines that may differ. */
const VENDORED = Object.freeze({
  'BitMath.sol': 'v4-core/src/libraries/BitMath.sol',
  'CustomRevert.sol': 'v4-core/src/libraries/CustomRevert.sol',
  'FixedPoint128.sol': 'v4-core/src/libraries/FixedPoint128.sol',
  'FixedPoint96.sol': 'v4-core/src/libraries/FixedPoint96.sol',
  'FullMath.sol': 'v4-core/src/libraries/FullMath.sol',
  'LiquidityAmounts.sol': 'v4-periphery/src/libraries/LiquidityAmounts.sol',
  'SafeCast.sol': 'v4-core/src/libraries/SafeCast.sol',
  'SqrtPriceMath.sol': 'v4-core/src/libraries/SqrtPriceMath.sol',
  'TickMath.sol': 'v4-core/src/libraries/TickMath.sol',
  'UnsafeMath.sol': 'v4-core/src/libraries/UnsafeMath.sol',
});

export function vendoredEdit(line) {
  return line.replace(/^pragma solidity \^0\.8\.\d+;$/, 'pragma solidity 0.8.26;')
    .replace(/"@uniswap\/v4-core\/src\/libraries\/(\w+\.sol)"/, '"./$1"');
}

function check() {
  const problems = [];
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const text = readFileSync(solidityPath, 'utf8');
  const byContract = embedded(text);
  const codes = {};
  const expected = new Map(targets(profile).map(target => [target.key, target]));
  for (const target of manifest.contracts) {
    const code = byContract[target.contract];
    if (!code) { problems.push(`${target.contract}: runtime missing`); continue; }
    codes[target.key] = code;
    const want = expected.get(target.key);
    if (!want || want.address !== target.address) problems.push(`${target.key}: address differs from the profile`);
    if (hash(code) !== target.codehash || target.codehash !== want?.codehash.toLowerCase()) problems.push(`${target.key}: code hash differs from the profile`);
  }
  if (Object.keys(codes).length === manifest.contracts.length && render(manifest, codes) !== text) problems.push('UniswapBase8453.sol is not what base-8453.json renders');
  const vendored = path.join(repo, 'contracts/src/v2/positions/uniswap');
  const reference = path.join(repo, 'contracts/test/reference/official-v4');
  for (const [file, upstream] of Object.entries(VENDORED)) {
    const want = readFileSync(path.join(reference, upstream), 'utf8').split('\n').map(vendoredEdit).join('\n');
    if (readFileSync(path.join(vendored, file), 'utf8') !== want) problems.push(`uniswap/${file}: differs from ${upstream} beyond the pragma and import paths`);
  }
  for (const problem of problems) console.error(problem);
  console.log(problems.length ? `Position fixtures: ${problems.length} problem(s).` : 'Position fixtures and vendored math are consistent.');
  return problems.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'capture') capture(rest).catch(error => { console.error(error.message); process.exit(1); });
  else if (command === 'check') process.exit(check());
  else { console.error('usage: position-fixtures.mjs capture [--rpc URL] [--block N] | check'); process.exit(2); }
}
