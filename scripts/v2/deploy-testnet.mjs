#!/usr/bin/env node
/** The frozen V2 release on a public testnet: Base Sepolia (84532) and Arbitrum Sepolia (421614), to test with tokens of
 * no value (launch round P3, item 7, 4 Nov 2026). Runbook: docs/v2/TESTNET_DEPLOYMENT.md.
 *
 * deploy.mjs, a frozen release input (docs/v2/FREEZE.md), prepares a public package only for 4663, 8453 and 42161
 * (ENABLED_CHAINS), from a profile committed in api-contracts/v2/chains, which the backend's chain registry and the app
 * serve as production chains. Changing either makes a new V2 candidate. So this file changes neither: it drives
 * deploy.mjs's own functions, unchanged, with the one environment they take for another chain id, `local-test`, and
 * puts back what a public package proves:
 * - the chain is one of TESTNETS, never a production chain;
 * - the profile is the one committed under api-contracts/v2/testnets at the compiled commit (no registry reads there);
 * - the checkout is clean and its compile is the reviewed release manifest's (checkReleaseManifest);
 * - no role is a key anyone holds (the public mnemonic's first 100 accounts, the rehearsal accounts) or a production
 *   role (every role of docs/deployments' production manifests, the owner's deployer among them): on a public chain,
 *   whoever holds a role's key holds the role, and a production key is never spent on a testnet;
 * - governance is a Safe (the preflight's requireSafeGovernance, as on production) whose owners are none of those
 *   either (review L4, 4 Nov 2026).
 * Like deploy.mjs it never loads a key, signs or broadcasts: a person signs each step with the testnet deployer's key
 * and broadcasts it. Its manifests say `environment: local-test`, which production never admits (backend/v2_manifest.py,
 * the app's manifest check): a testnet deployment can never be taken for Domino's.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot, PRODUCTION_DEPLOYER, ROLE_NAMES, ensure, canonical, compileV2, planDeployment,
  preflightDeployment, verifyDeployment, checkSignedTransactions, rebuildPackage, fullPackage, explorerInput,
  checkReleaseManifest, validateRoleInput, readOnlyRpc, writeJson, flags } from './deploy.mjs';
import { simulateGas, localRoles, rehearsalAccount } from './deploy-anvil.mjs';
import { verificationRpcEndpoint, readBounded } from '../prepare-financial-release.mjs';

export const TESTNETS = Object.freeze({
  84532: Object.freeze({ slug: 'base-sepolia', name: 'Base Sepolia', stack: 'op-stack' }),
  421614: Object.freeze({ slug: 'arbitrum-sepolia', name: 'Arbitrum Sepolia', stack: 'arbitrum-nitro' }),
});
/** deploy.mjs's only environment for a chain outside ENABLED_CHAINS. */
export const TESTNET_ENVIRONMENT = 'local-test';
export const TESTNET_PROFILE_DIRECTORY = 'api-contracts/v2/testnets';
export const PUBLIC_TEST_ACCOUNTS_FILE = 'api-contracts/v2/public-test-accounts.json';
export const DEPLOYMENTS_DIRECTORY = 'docs/deployments';

/** One of TESTNETS' profiles: never a production chain; its own slug, stack and the `enabled` deploy.mjs reads. */
export function checkTestnetProfile(profile) {
  // TESTNETS and ENABLED_CHAINS never meet (deploy-testnet.test.mjs): a production chain is never one of these.
  ensure(profile !== null && typeof profile === 'object' && Number.isSafeInteger(profile.chainId)
    && Object.hasOwn(TESTNETS, profile.chainId), 'not_a_testnet_profile');
  const testnet = TESTNETS[profile.chainId];
  ensure(profile.slug === testnet.slug && profile.stack === testnet.stack && profile.enabled === true, 'testnet_profile_mismatch');
  return profile;
}

export const testnetProfilePath = chainId => `${TESTNET_PROFILE_DIRECTORY}/${TESTNETS[chainId].slug}-${chainId}.json`;

/** Every role of Domino's committed production deployments (docs/deployments/<name>/deployment.json): V1's mainnet
 * deployment and V2's public-chain preparations. Review L4 (4 Nov 2026): a testnet must never put a production key to
 * use, nor make the owner's Safe or one of its keys a testnet role. Lower case. */
export function productionRoles(root = repoRoot) {
  const roles = new Set(), directory = join(root, DEPLOYMENTS_DIRECTORY);
  let manifests = 0;
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name, 'deployment.json');
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const production = manifest.kind === 'domino-public-mainnet-deployment'
      || (manifest.kind === 'domino-v2-deployment' && manifest.environment === 'public-chain-preparation');
    if (!production) continue;
    ensure(manifest.roles && typeof manifest.roles === 'object' && Object.values(manifest.roles).every(a => /^0x[0-9a-fA-F]{40}$/.test(a)),
      'production_deployment_roles_unreadable');
    for (const address of Object.values(manifest.roles)) roles.add(address.toLowerCase());
    manifests += 1;
  }
  ensure(manifests > 0 && roles.has(PRODUCTION_DEPLOYER), 'production_deployments_unreadable');
  return roles;
}

/** The rehearsal Safe owners the offline tests sign with (deploy-test-support.mjs safeOwners): public keys too. */
export const REHEARSAL_SAFE_OWNERS = Object.freeze([1, 2, 3].map(i => rehearsalAccount('safe-owner-' + i).address.toLowerCase()));

/** Addresses whose keys others hold or must never be spent here: the public mnemonic's first 100 accounts, the
 * rehearsal accounts the local modes use as roles or Safe owners, and every production role (productionRoles, the
 * owner's deployer among them). Lower case. */
export function refusedTestnetRoles(root = repoRoot) {
  const shared = JSON.parse(readFileSync(join(root, PUBLIC_TEST_ACCOUNTS_FILE), 'utf8'));
  ensure(Array.isArray(shared.addresses) && shared.addresses.length === 100, 'public_test_accounts_unreadable');
  return new Set([...shared.addresses, ...Object.values(localRoles()).map(a => a.toLowerCase()), ...REHEARSAL_SAFE_OWNERS,
    PRODUCTION_DEPLOYER, ...productionRoles(root)]);
}

/** Review L4: the preflight checked governance as a Safe (threshold, owners distinct); none of its owners may be a key
 * others hold or a production role either. Returns the report. */
export function checkTestnetGovernance(report, root = repoRoot) {
  ensure(report?.governance?.checked === true && Array.isArray(report.governance.owners), 'testnet_governance_not_checked');
  const refused = refusedTestnetRoles(root);
  for (const owner of report.governance.owners) {
    ensure(!refused.has(String(owner).toLowerCase()), 'public_or_production_key_as_testnet_governance_owner');
  }
  return report;
}

/** deploy.mjs's role rules for a public package, then none of refusedTestnetRoles. Returns the lower-case roles. */
export function checkTestnetRoles(roles) {
  const lower = validateRoleInput(roles, { production: true }), refused = refusedTestnetRoles();
  for (const name of ROLE_NAMES) ensure(!refused.has(lower[name]), 'public_or_production_key_as_testnet_role: ' + name);
  return lower;
}

/** What deploy.mjs's checkProvenance proves for a public package, with the testnet's own committed profile. `root` is
 * this checkout; tests name a scratch repository. */
export function checkTestnetProvenance({ artifacts, profile }, root = repoRoot) {
  checkTestnetProfile(profile);
  ensure(resolve(artifacts.sourceRoot) === resolve(root), 'testnet_preparation_requires_the_tool_checkout');
  ensure(!artifacts.sourceState.workingTreeSourceChanges && !artifacts.sourceState.workingTreeToolChanges,
    'uncommitted_changes_refused_for_testnet_preparation');
  let committed;
  try {
    committed = JSON.parse(execFileSync('git', ['-C', artifacts.sourceRoot, 'show', `${artifacts.sourceCommit}:${testnetProfilePath(profile.chainId)}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 20 }));
  } catch { throw new Error('testnet_profile_not_committed'); }
  ensure(canonical(committed) === canonical(profile), 'testnet_profile_not_the_committed_one');
  return checkReleaseManifest(artifacts);
}

/** A supplied package of this tool: rebuilt byte for byte from the current compile, its testnet and roles checked. (Its
 * environment is local-test: deploy.mjs takes no other for a chain outside ENABLED_CHAINS.) */
export function testnetPackage(supplied, artifacts) {
  const bundle = rebuildPackage(supplied, artifacts);
  checkTestnetProfile(bundle.parameters.profile);
  checkTestnetRoles(bundle.parameters.roles);
  return bundle;
}

/** Plans a package (or the rest of one, `resumeFrom`) on the testnet's current state and runs the preflight, a Safe as
 * governance required. `provenance` is checkTestnetProvenance; offline tests, whose chain profile is synthetic and
 * uncommitted, pass their own. */
export async function prepareTestnet({ profile, roles, releaseTag, artifacts, rpc, simulate = simulateGas, now = Math.floor(Date.now() / 1000),
  validitySeconds, maxFeePerGas, maxPriorityFeePerGas, resumeFrom, provenance = checkTestnetProvenance }) {
  if (resumeFrom) ({ profile, roles, releaseTag } = resumeFrom.parameters);
  checkTestnetProfile(profile);
  checkTestnetRoles(roles);
  provenance({ artifacts, profile });
  const planned = await planDeployment({ profile, roles, environment: TESTNET_ENVIRONMENT, releaseTag, artifacts, rpc, simulate, now,
    validitySeconds, maxFeePerGas, maxPriorityFeePerGas, resumeFrom });
  return { bundle: planned.bundle, report: await preflightTestnet(planned.bundle, { rpc, simulatedGas: planned.simulatedGas, now }) };
}

/** deploy.mjs's preflight with a Safe as governance required, then none of the Safe's owners a refused key (review L4).
 * Both `prepare` (through prepareTestnet) and `preflight` run it; `simulatedGas` defaults to a fresh simulation. */
export async function preflightTestnet(bundle, { rpc, artifacts, simulatedGas, now = Math.floor(Date.now() / 1000) }) {
  const report = await preflightDeployment(bundle, { rpc, now, requireSafeGovernance: true,
    simulatedGas: simulatedGas ?? await simulateGas(fullPackage(bundle, artifacts)) });
  return checkTestnetGovernance(report);
}

const readInput = path => JSON.parse(readBounded(path, 16 * 1024 * 1024));
const preflightPath = out => out.endsWith('.json') ? out.slice(0, -5) + '.preflight.json' : out + '.preflight.json';
const optional = (value, code) => { if (value === undefined) return undefined; ensure(/^(0|[1-9][0-9]{0,77})$/.test(value), code); return value; };

export async function cli(argv) {
  const command = argv[0], f = flags(argv.slice(1));
  const fees = ['max-fee-per-gas', 'priority-fee-per-gas', 'valid-hours'];
  const allowed = {
    prepare: [['chain-profile', 'roles', 'release-tag', 'out'], ['rpc', 'rpc-file', ...fees]],
    resume: [['package', 'out'], ['rpc', 'rpc-file', ...fees]],
    preflight: [['package', 'out'], ['rpc', 'rpc-file']],
    'check-signed': [['package', 'signed'], ['out']],
    verify: [['package', 'receipts', 'out'], ['rpc', 'rpc-file', 'block-tag']],
    'explorer-input': [['package', 'out'], []],
  }[command];
  ensure(allowed, 'command_required: prepare|resume|preflight|check-signed|verify|explorer-input');
  ensure(allowed[0].every(k => Object.hasOwn(f, k)) && Object.keys(f).every(k => allowed[0].includes(k) || allowed[1].includes(k)),
    'unknown_or_missing_cli_argument');
  for (const key of ['out', 'package', 'chain-profile', 'roles', 'receipts', 'signed']) {
    if (f[key] !== undefined) ensure(typeof f[key] === 'string' && f[key].length > 0, 'invalid_cli_arguments');
  }
  if (f.out !== undefined) ensure(!existsSync(f.out) && (!['prepare', 'resume'].includes(command) || !existsSync(preflightPath(f.out))), 'output_exists');
  const source = Object.fromEntries(['rpc', 'rpc-file'].filter(k => Object.hasOwn(f, k)).map(k => [k, f[k]]));
  const rpc = ['prepare', 'resume', 'preflight', 'verify'].includes(command) ? readOnlyRpc(verificationRpcEndpoint(source)) : null;
  let validitySeconds;
  if (f['valid-hours'] !== undefined) {
    const hours = Number(optional(f['valid-hours'], 'invalid_valid_hours'));
    ensure(hours >= 1 && hours <= 168, 'invalid_valid_hours');
    validitySeconds = hours * 3600;
  }
  const maxFeePerGas = optional(f['max-fee-per-gas'], 'invalid_fee'), maxPriorityFeePerGas = optional(f['priority-fee-per-gas'], 'invalid_fee');
  const artifacts = compileV2();
  const bundle = f.package ? testnetPackage(readInput(f.package), artifacts) : null;
  checkTestnetProvenance({ artifacts, profile: bundle ? bundle.parameters.profile : readInput(f['chain-profile']) });
  if (command === 'check-signed') {
    const checked = await checkSignedTransactions(bundle, readFileSync(f.signed, 'utf8').split(/\s+/).filter(Boolean));
    if (f.out) writeJson(f.out, checked);
    return checked.map(x => `${x.component} nonce ${x.nonce} signed by the deployer: ${x.transactionHash}`).join('\n');
  }
  if (command === 'explorer-input') { writeJson(f.out, explorerInput(bundle, artifacts)); return 'Wrote the block-explorer verification input.'; }
  if (command === 'verify') {
    const verified = await verifyDeployment(bundle, { rpc, transactionHashes: readInput(f.receipts), blockTag: f['block-tag'] ?? 'finalized' });
    const { validateManifest } = await import('./deploy-schema.mjs');
    validateManifest(verified);
    writeJson(f.out, verified);
    return `Verified the V2 testnet deployment on ${TESTNETS[verified.chain.chainId].name}: code, wiring, roles and receipts (environment ${verified.environment}).`;
  }
  const now = Math.floor(Date.now() / 1000);
  if (command === 'preflight') {
    const report = await preflightTestnet(bundle, { rpc, artifacts, now });
    writeJson(f.out, report);
    return `Preflight passed at block ${report.chain.block.number}: ${report.steps.length} transaction(s), worst case ${report.funding.worstCaseWei} wei of ${report.funding.balanceWei}.`;
  }
  const { bundle: prepared, report } = await prepareTestnet({ profile: bundle ? undefined : readInput(f['chain-profile']),
    roles: bundle ? undefined : readInput(f.roles), releaseTag: f['release-tag'], artifacts, rpc, now, validitySeconds,
    maxFeePerGas, maxPriorityFeePerGas, resumeFrom: bundle ?? undefined });
  writeJson(f.out, prepared); writeJson(preflightPath(f.out), report);
  return `Prepared ${prepared.steps.length} unsigned CREATE3 transaction(s) for ${TESTNETS[prepared.parameters.profile.chainId].name} `
    + `from nonce ${prepared.parameters.nonce} (environment ${TESTNET_ENVIRONMENT}); preflight passed; nothing was signed or sent.`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).then(message => console.log(message)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
