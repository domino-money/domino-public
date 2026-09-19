#!/usr/bin/env node
// DominoVault (V3) and DominoVaultV4 share most of their text. They have
// already diverged in ways nobody intended and nobody noticed - hygiene H-01
// in reports/CONTRACT_REVIEW_2026-09-19.md, whose own example was an error and
// an event V4 declared and never used.
//
// This inspects the two finished ABIs and refuses any divergence that is not
// written down below. It costs no contract bytes, which matters: DominoVaultV4
// has a few hundred to spare, so the check cannot live in a Forge test.
//
// It catches a member added to one side only, a signature that changes on one
// side, and a mutability that changes on one side. It does NOT catch two
// bodies drifting behind an unchanged signature - nothing cheap does, and a
// hash of the shared text was measured and rejected as too brittle to keep
// (renaming one local variable moved it).
//
// To add a divergence deliberately: put it in the right list with a reason.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Members only DominoVault has, each with why V4 does not. */
export const V3_ONLY = Object.freeze({
  'constructor (address,address,address,address,address) nonpayable':
    'V4 additionally pins the read helper and the execution engine.',
  'error StaleAuthority()': 'Raised by V3 validateAuthority, an entry point V4 does not have.',
  'event CompoundSelfCompleted(bytes32,uint256,bytes32,uint128,uint128,uint64,uint64,uint64)':
    'V3 compoundSelf; V4 emits ExecutionCompleted instead.',
  'function adoptChild(uint256,uint256,bool) nonpayable':
    'V4 creates children only through executionMint, inside an authenticated action.',
  'function compoundApply(tuple[2]) nonpayable': 'V3 compound wire; V4 uses executionApply.',
  'function compoundCheckpoint(tuple) nonpayable': 'V3 compound wire; V4 uses executionCheckpoint.',
  'function compoundEngine() view': 'V4 names the same role executionEngine.',
  'function compoundEngineCodeHash() view': 'V4 names the same pin executionEngineCodeHash.',
  'function compoundModify(bool,uint128,uint128) nonpayable': 'V3 compound wire; V4 uses executionModify.',
  'function compoundSelf(tuple) nonpayable': 'V3 entry point; V4 uses execute.',
  'function onERC721Received(address,address,uint256,bytes) nonpayable':
    'Only V3 accepts a safeTransferFrom adoption; V4 mints its own children.',
  'function validateAuthority(uint64,uint64,uint64) view': 'V3 pre-flight; V4 validates in the routing helper.',
});

/** Members only DominoVaultV4 has, each with why V3 does not. */
export const V4_ONLY = Object.freeze({
  'constructor (address,address,address,address,address,address,address) nonpayable':
    'The read helper and the execution engine are pinned at construction.',
  'event ExecutionCompleted(bytes32,bytes32,uint8,uint256,uint256,uint64)':
    'The V4 execution receipt, replacing V3 CompoundSelfCompleted.',
  'event SuccessorCreated(bytes32,uint256,uint256)': 'Emitted by executionMint, which V3 has no analogue for.',
  'function execute(tuple) nonpayable': 'The V4 entry point, replacing the V3 compoundSelf wire.',
  'function executionApply(bytes32,address,tuple,address,bool) nonpayable':
    'Engine callback settling one budget against the pool; V3 does the same work in compoundApply.',
  'function executionCheckpoint(uint256,tuple) nonpayable':
    'Engine callback recording a position point; V3 does the same work in compoundCheckpoint.',
  'function executionConvert(bytes32,address,uint128) nonpayable':
    'Engine callback. Exposes a fee-credit sink that V3 keeps unreachable; see DominoVaultV4.sol.',
  'function executionCredit(uint256,uint128,uint128) nonpayable':
    'Engine callback. Exposes a fee-credit sink that V3 keeps unreachable; see DominoVaultV4.sol.',
  'function executionEngine() view': 'The pinned engine, named compoundEngine in V3.',
  'function executionEngineCodeHash() view': 'Its codehash pin, named compoundEngineCodeHash in V3.',
  'function executionMint(bytes32,uint256,int24,int24,uint128) nonpayable':
    'Engine callback minting the one successor of a parent; V3 adopts an existing NFT instead.',
  'function executionModify(uint256,uint128,uint128,uint128,bool) nonpayable':
    'Engine callback driving the periphery; V3 does the same work in compoundModify.',
  'function successorOf(uint256) view': 'Write-once child lineage; V3 adopts instead of minting.',
});

/** How many members the two must keep in common. Lowering it needs a reason. */
export const SHARED_COUNT = 96;

const defaultOut = fileURLToPath(new URL('../contracts/out/', import.meta.url));

export const signature = (entry) =>
  `${entry.type} ${entry.name ?? ''}(${(entry.inputs ?? []).map((i) => i.type).join(',')})` +
  (entry.stateMutability ? ` ${entry.stateMutability}` : '');

function abiOf(name, out) {
  const file = path.join(out, `${name}.sol`, `${name}.json`);
  let artifact;
  try { artifact = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error(`artifact_unreadable: ${file}`); }
  if (!Array.isArray(artifact.abi)) throw new Error(`artifact_has_no_abi: ${file}`);
  return new Set(artifact.abi.map(signature));
}

export function checkVaultAbiDrift({ out = defaultOut } = {}) {
  const v3 = abiOf('DominoVault', out);
  const v4 = abiOf('DominoVaultV4', out);
  const shared = [...v3].filter((entry) => v4.has(entry));
  const issues = [];

  const side = (members, declared, label) => {
    for (const entry of [...members].filter((e) => !shared.includes(e)).sort()) {
      if (!Object.hasOwn(declared, entry)) issues.push(`undeclared_${label}_member: ${entry}`);
    }
    for (const entry of Object.keys(declared).sort()) {
      if (!members.has(entry)) issues.push(`stale_${label}_entry: ${entry}`);
    }
  };
  side(v3, V3_ONLY, 'v3_only');
  side(v4, V4_ONLY, 'v4_only');
  if (shared.length !== SHARED_COUNT) {
    issues.push(`shared_surface_changed: ${shared.length} shared members, expected ${SHARED_COUNT}`);
  }
  return { ok: issues.length === 0, sharedCount: shared.length, issues };
}

export function formatDriftReport(report) {
  if (report.ok) {
    return `Vault ABI drift: PASS; ${report.sharedCount} shared members, ` +
      `${Object.keys(V3_ONLY).length} V3-only and ${Object.keys(V4_ONLY).length} V4-only, all declared`;
  }
  return ['Vault ABI drift: FAIL', ...report.issues.map((i) => `  ${i}`),
    '  DominoVault and DominoVaultV4 share most of their text. A divergence is allowed,',
    '  but it has to be written down in scripts/check-vault-abi-drift.mjs with a reason.'].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = checkVaultAbiDrift();
  console.log(formatDriftReport(report));
  process.exitCode = report.ok ? 0 : 1;
}
