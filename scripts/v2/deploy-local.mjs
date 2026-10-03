#!/usr/bin/env node
/** Deploys the V2 package on a loopback Anvil exactly as the owner deploys it on a chain (prepare, preflight,
 * one transaction at a time, verify) and writes its manifest. Two modes, each with its own label:
 *
 * - fork (default): an Anvil fork of Robinhood, Base or Arbitrum that keeps the real chain id, so EIP-712
 *   domains are production's; the committed profile's real Uniswap, Permit2 and CreateX are checked by code
 *   hash. The manifest says `environment: fork-rehearsal`.
 * - offline: a plain Anvil; CreateX's canonical runtime and synthetic constructor stubs at the dependency
 *   addresses. No Uniswap, no Permit2, no journeys. The manifest says `environment: local-test`.
 *
 * Neither mode can produce a `public-chain-preparation` manifest. Roles are the rehearsal test accounts
 * (deploy-anvil.mjs) unless --roles names others; --production-deployer impersonates the owner's deployer so
 * that every address equals production's. A rerun after an interruption checks what is already deployed by
 * code hash and sends only the rest. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot, viem, CONTRACT_NAMES, CREATE_X, CREATEX_EVENTS, DEPLOY_ORDER, ENABLED_CHAINS, PRODUCTION_DEPLOYER, ensure, quantity,
  compileV2, readJson, writeJson, flags, prepareDeployment, planDeployment, preflightDeployment, verifyDeployment, deploymentState,
  makeRpc, pinBlock } from './deploy.mjs';
import { requireAnvil, requireValidatedRpc, forkedNetwork, installCreateX, installOfflineDependencies, simulateGas, waitReceipt,
  localRoles } from './deploy-anvil.mjs';
import { validateManifest } from './deploy-schema.mjs';

const hex = value => viem.toHex(BigInt(value));

/** The committed profile of an enabled chain. */
export function chainProfile(chainId) {
  const slug = { 4663: 'robinhood-4663', 8453: 'base-8453', 42161: 'arbitrum-42161' }[chainId];
  ensure(slug, 'chain_not_enabled');
  return readJson(resolve(repoRoot, 'api-contracts/v2/chains', slug + '.json'));
}

/** Sends a package's steps from its impersonated deployer, one at a time, stopping at the first revert. */
export async function executeSteps(bundle, rpc, { limit = Infinity } = {}) {
  requireValidatedRpc(rpc);
  const deployer = bundle.manifest.roles.deployer, hashes = {};
  await rpc('anvil_impersonateAccount', [deployer]);
  try {
    for (const step of bundle.steps.slice(0, limit)) {
      const hash = await rpc('eth_sendTransaction', [step.transaction]);
      ensure(/^0x[0-9a-f]{64}$/.test(hash), 'local_transaction_hash_invalid');
      const receipt = await waitReceipt(rpc, hash);
      ensure(quantity(receipt.status) === 1n, 'local_deployment_reverted: ' + step.component);
      hashes[step.component] = hash;
    }
  } finally { await rpc('anvil_stopImpersonatingAccount', [deployer]); }
  return hashes;
}

/** The transaction that created each component, from CreateX's ContractCreation log (local chains only). */
export async function creationTransactions(bundle, rpc, components, fromBlock) {
  requireValidatedRpc(rpc);
  const hashes = {};
  for (const component of components) {
    const logs = await rpc('eth_getLogs', [{ address: CREATE_X, fromBlock: hex(fromBlock), toBlock: 'latest',
      topics: [CREATEX_EVENTS.creation, viem.padHex(bundle.components[component].expectedAddress, { size: 32 })] }]);
    ensure(logs.length === 1, 'creation_transaction_not_found: ' + component);
    hashes[component] = logs[0].transactionHash;
  }
  return hashes;
}

/** Local runs fund the impersonated deployer synthetically when it lacks the package's worst case. */
async function fundLocally(bundle, rpc) {
  const deployer = bundle.manifest.roles.deployer;
  const before = quantity(await rpc('eth_getBalance', [deployer, 'latest']));
  const need = BigInt(bundle.maximumExecutionGasCostWei) * 2n + 10n ** 18n;
  if (before >= need) return { synthetic: false, balanceWei: before.toString() };
  await rpc('anvil_setBalance', [deployer, hex(need)]);
  return { synthetic: true, balanceBeforeWei: before.toString(), balanceWei: need.toString() };
}

/** `forkProfile` (tests only) stands in for the committed profile in fork mode, for a fork of an offline chain. */
export async function deployLocal({ rpcUrl, out, mode = 'fork', roles, productionDeployer = false, releaseTag = 'v2-local',
  sourceRoot = repoRoot, artifacts, now = Math.floor(Date.now() / 1000), forkProfile }) {
  ensure(['fork', 'offline'].includes(mode), 'invalid_local_mode');
  const rpc = makeRpc(rpcUrl); await requireAnvil(rpcUrl, rpc);
  const fork = await forkedNetwork(rpc);
  let profile, environment;
  if (mode === 'fork') {
    ensure(fork, 'anvil_fork_required_use_--mode_offline_for_a_plain_anvil');
    const chainId = Number(quantity(await rpc('eth_chainId', [])));
    ensure(ENABLED_CHAINS.includes(chainId) && Number(fork.chainId) === chainId, 'fork_must_keep_the_real_chain_id');
    profile = forkProfile ?? chainProfile(chainId); environment = 'fork-rehearsal';
    ensure(profile.chainId === chainId, 'fork_profile_chain_mismatch');
  } else {
    ensure(!fork, 'offline_mode_requires_a_plain_anvil');
    await installCreateX(rpc);
    profile = await installOfflineDependencies(rpc); environment = 'local-test';
  }
  artifacts ??= compileV2({ sourceRoot });
  roles ??= localRoles({ productionDeployer });
  ensure(!productionDeployer || roles.deployer.toLowerCase() === PRODUCTION_DEPLOYER, 'production_deployer_conflicts_with_roles');
  const deployer = roles.deployer.toLowerCase();
  const reference = prepareDeployment({ profile, roles, environment, sourceCommit: artifacts.sourceCommit, releaseTag, steps: [...DEPLOY_ORDER],
    resumeOf: null, nonce: quantity(await rpc('eth_getTransactionCount', [deployer, 'latest'])).toString(), maxFeePerGas: '1',
    maxPriorityFeePerGas: '0', expiresAt: now + 3600, gasLimits: Object.fromEntries(DEPLOY_ORDER.map(c => [c, '16777216'])) }, artifacts);
  const block = await pinBlock(rpc, 'latest');
  const before = await deploymentState(reference, rpc, block.tag);
  const deployed = DEPLOY_ORDER.filter(c => before[c] === 'deployed');
  const earlier = deployed.length ? await creationTransactions(reference, rpc, deployed, fork ? Number(fork.forkBlockNumber) + 1 : 0) : {};
  let bundle = reference, preflight = null, funding = null, sent = {};
  if (deployed.length < DEPLOY_ORDER.length) {
    const planned = await planDeployment({ profile, roles, environment, releaseTag, artifacts, rpc, simulate: simulateGas, now,
      resumeFrom: deployed.length ? reference : undefined });
    bundle = planned.bundle;
    funding = await fundLocally(bundle, rpc);
    preflight = await preflightDeployment(bundle, { rpc, simulatedGas: planned.simulatedGas, now });
    sent = await executeSteps(bundle, rpc);
  }
  const transactionHashes = { ...earlier, ...sent };
  const manifest = await verifyDeployment(bundle, { rpc, transactionHashes, blockTag: 'latest' });
  validateManifest(manifest);
  if (out) {
    writeJson(out, manifest); writeJson(out + '.unsigned.json', bundle); writeJson(out + '.receipts.json', transactionHashes);
    if (preflight) writeJson(out + '.preflight.json', { ...preflight, localFunding: funding });
  }
  return { manifest, bundle, transactionHashes, preflight, funding, resumed: deployed, rpc };
}

export async function cli(argv) {
  const f = flags(argv, ['production-deployer']);
  ensure(f.rpc && f.out, 'rpc_and_out_required');
  ensure(Object.keys(f).every(k => ['rpc', 'out', 'mode', 'roles', 'production-deployer', 'release-tag'].includes(k)), 'unknown_cli_argument');
  const result = await deployLocal({ rpcUrl: f.rpc, out: f.out, mode: f.mode ?? 'fork', roles: f.roles ? readJson(f.roles) : undefined,
    productionDeployer: f['production-deployer'] === true, releaseTag: f['release-tag'] ?? 'v2-local' });
  console.log('Deployed and verified ' + Object.keys(CONTRACT_NAMES).length + ' V2 runtimes on loopback Anvil; environment='
    + result.manifest.environment + (result.resumed.length ? '; resumed after ' + result.resumed.length + ' deployed component(s)' : '') + '.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
