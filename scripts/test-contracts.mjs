#!/usr/bin/env node
// Invoke the pinned native binary directly: the 1.7.1 npm launcher does not
// propagate child exit status. All compiler paths are absolute and offline.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkContractSizes, formatReport } from './check-contract-size.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));

export function contractArguments(extra = [], command = 'test') {
  return [command, '--root', path.join(root, 'contracts'), '--use', path.join(root, 'scripts/solc-wrapper.py'), '--offline', ...extra];
}

export function runChecked(binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  return Number.isInteger(result.status) ? result.status : 1;
}

/** The pinned Forge binary, never a global tool; shared with the gas baseline. */
export async function resolveForge() {
  if (process.platform === 'win32') throw new Error('Native Windows contract tests are unsupported; run npm ci and npm run test:contracts inside WSL2.');
  const { PLATFORM_SPECIFIC_PACKAGE_NAME, BINARY_NAME } = await import('@foundry-rs/forge/const.mjs');
  const platformPackage = PLATFORM_SPECIFIC_PACKAGE_NAME('forge');
  if (!platformPackage) throw new Error('Unsupported platform. Contract tests support macOS, Linux and WSL2.');
  const name = BINARY_NAME('forge');
  let binary;
  try { binary = require.resolve(`${platformPackage}/bin/${name}`); }
  catch {
    // Same pinned package fallback used by Foundry's installer, never a global tool.
    binary = path.resolve(path.dirname(require.resolve('@foundry-rs/forge/package.json')), '../dist', name);
  }
  if (!existsSync(binary)) throw new Error('Pinned Forge binary missing; run npm ci in this checkout on macOS, Linux or WSL2.');
  return binary;
}

async function main() {
  const binary = await resolveForge();
  // `build` compiles every source (including all test contracts) without
  // running tests, so backend EVM tests can load artifacts such as
  // contracts/out/DominoSetup.t.sol/SetupToken.json (issue #144).
  const raw = process.argv.slice(2);
  const build = raw[0] === 'build';
  const extra = build ? raw.slice(1) : raw;
  const status = runChecked(binary, contractArguments(extra, build ? 'build' : 'test'));
  if (status !== 0) return status;
  if (build) return 0;
  // Keep npm's trailing Forge filters attached to this launcher, not to a
  // second shell command. Inspect only artifacts from the successful build.
  const report = checkContractSizes();
  console.log(formatReport(report));
  return report.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(`Contract test launcher: ${error.message}`); process.exitCode = 1; }
}
