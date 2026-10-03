import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { repoRoot, readJson, viem, CREATE_X, DEPLOY_ORDER, PRODUCTION, MAX_TRANSACTION_GAS, ROLE_NAMES, prepareDeployment, planDeployment, preflightDeployment,
  verifyDeployment, inspectGovernance, checkDependencies, deploymentState, l1Costs, dependencyMap, quantity, pinBlock } from './deploy.mjs';
import { simulateGas, stubRuntime, installStubs, rehearsalAccount } from './deploy-anvil.mjs';
import { executeSteps } from './deploy-local.mjs';
import { validateManifest } from './deploy-schema.mjs';
import { compiled, roles, hex, checksummed, offlineChain, scripted, isCall, send, installSafe, safeOwners, SAFE } from './deploy-test-support.mjs';

const NODE_INTERFACE = '0x00000000000000000000000000000000000000c8';
const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000f';
const GUARD_SLOT = viem.keccak256(viem.toHex('guard_manager.guard.address'));
const word = value => viem.encodeAbiParameters([{ type: 'uint256' }], [BigInt(value)]);
/** An L1 RPC answering NodeInterface (Nitro: L1 gas units) or GasPriceOracle (OP: an L1 fee in wei). */
const l1Answer = (rpc, { gas = 0n, fee = 0n }) => scripted(rpc, (method, params) => {
  if (isCall(method, params, NODE_INTERFACE, 'gasEstimateL1Component(address,bool,bytes)'))
    return viem.encodeAbiParameters([{ type: 'uint64' }, { type: 'uint256' }, { type: 'uint256' }], [gas, 10_000_000n, 1_000_000n]);
  if (isCall(method, params, GAS_PRICE_ORACLE, 'getL1Fee(bytes)')) return word(fee);
  return undefined;
});
/** What a production node answers about itself; Anvil would be refused for a public package. */
const realNode = rpc => scripted(rpc, method => {
  if (method === 'web3_clientVersion') return 'Geth/v1.16.4-stable/linux-amd64/go1.24';
  if (method === 'anvil_metadata') throw new Error('rpc_method_failed: anvil_metadata');
  return undefined;
});

describe('preflight on a disposable EVM with a real Safe', () => {
  let chain, rpc, safe, safeRoles, lower, planned, deployer;
  const preflight = (bundle = planned.bundle, options = {}) => preflightDeployment(bundle, { rpc, simulatedGas: planned.simulatedGas, requireSafeGovernance: true, ...options });
  const variant = changes => prepareDeployment({ ...planned.bundle.parameters, ...changes }, compiled());
  const isolated = async body => { const id = await rpc('evm_snapshot', []); try { return await body(); } finally { await rpc('evm_revert', [id]); } };
  before(async () => {
    chain = await offlineChain(); rpc = chain.rpc;
    safe = await installSafe(rpc, { address: checksummed('rehearsal-governance-safe') });
    safeRoles = { ...roles, governance: safe };
    lower = Object.fromEntries(ROLE_NAMES.map(name => [name, safeRoles[name].toLowerCase()]));
    deployer = lower.deployer;
    planned = await planDeployment({ profile: chain.profile, roles: safeRoles, environment: 'local-test', releaseTag: 'v2-preflight', artifacts: compiled(), rpc, simulate: simulateGas });
    await rpc('anvil_setBalance', [deployer, hex(10n ** 21n)]);
  });
  after(async () => { await chain?.stop(); });

  test('passes, pinned at one block, and reports what the signature depends on', async () => {
    const report = await preflight();
    assert.equal(report.status, 'passed');
    assert.equal(report.environment, 'local-test');
    assert.deepEqual(report.warnings, []);
    assert.deepEqual({ ...report.governance, owners: undefined }, { checked: true, address: safe.toLowerCase(), kind: 'safe', proxyVersion: '1.4.1',
      singleton: SAFE.singleton.address.toLowerCase(), version: '1.4.1', l2: true, threshold: 2, owners: undefined, modules: [], guard: '0x' + '0'.repeat(40),
      fallbackHandler: '0x' + '0'.repeat(40), warnings: [] });
    assert.deepEqual(report.governance.owners, safeOwners.map(o => o.toLowerCase()));
    assert.deepEqual(report.components, Object.fromEntries([...DEPLOY_ORDER, 'vaultExecutor.v3', 'vaultExecutor.v4'].map(c => [c, 'empty'])));
    assert.equal(report.deployer.nonce, planned.bundle.parameters.nonce);
    assert.equal(report.steps.length, 11);
    let worst = 0n;
    for (const step of report.steps) {
      assert.equal(step.simulatedExecutionGas, planned.simulatedGas[step.component]);
      assert.equal(BigInt(step.gasLimit), (BigInt(step.simulatedExecutionGas) * 125n + 99n) / 100n);
      worst += BigInt(step.gasLimit) * BigInt(planned.bundle.parameters.maxFeePerGas);
    }
    assert.equal(report.funding.worstCaseWei, worst.toString());
    assert.equal(report.l1.status, 'unavailable');
    // Without the requirement a local package skips the Safe check; an EOA governance then passes.
    const eoa = await planDeployment({ profile: chain.profile, roles, environment: 'local-test', releaseTag: 'v2-preflight', artifacts: compiled(), rpc, simulate: simulateGas });
    assert.equal((await preflightDeployment(eoa.bundle, { rpc, simulatedGas: eoa.simulatedGas })).governance.checked, false);
    await assert.rejects(preflightDeployment(eoa.bundle, { rpc, simulatedGas: eoa.simulatedGas, requireSafeGovernance: true }), /governance_has_no_code/);
  });

  test('governance must be a canonical Safe that two keys must agree to move', async () => {
    const inspect = (address, through = rpc) => inspectGovernance(address, through, 'latest', lower);
    await inspect(safe);
    await assert.rejects(inspect(roles.guardian), /governance_has_no_code/);
    await assert.rejects(inspect(CREATE_X), /governance_not_a_safe_proxy/);
    await isolated(async () => {
      const delegated = checksummed('7702-delegated');
      await rpc('anvil_setCode', [delegated, '0xef0100' + SAFE.singleton.address.slice(2).toLowerCase()]);
      await assert.rejects(inspect(delegated), /governance_not_a_safe_proxy/);
      // A proxy whose singleton is a copy at a non-canonical address.
      const copy = checksummed('singleton-copy');
      await rpc('anvil_setCode', [copy, SAFE.singleton.runtime]);
      await installSafe(rpc, { address: checksummed('copy-safe'), singleton: copy });
      await assert.rejects(inspect(checksummed('copy-safe')), /governance_singleton_not_canonical/);
      await rpc('anvil_setStorageAt', [safe, '0x0', '0x01' + SAFE.singleton.address.slice(2).toLowerCase().padStart(62, '0')]);
      await assert.rejects(inspect(safe), /invalid_storage_address/);
    });
    await isolated(async () => {
      await rpc('anvil_setCode', [SAFE.singleton.address, '0x00']);
      await assert.rejects(inspect(safe), /governance_singleton_code_mismatch/);
    });
    const version = scripted(rpc, (method, params) => isCall(method, params, safe, 'VERSION()') ? viem.encodeAbiParameters([{ type: 'string' }], ['1.3.0']) : undefined);
    await assert.rejects(inspect(safe, version), /governance_version_mismatch/);
    const single = await installSafe(rpc, { address: checksummed('one-of-three'), threshold: 1 });
    await assert.rejects(inspect(single), /governance_threshold_below_two/);
    const owners = list => scripted(rpc, (method, params) => isCall(method, params, safe, 'getOwners()') ? viem.encodeAbiParameters([{ type: 'address[]' }], [list]) : undefined);
    for (const list of [[safeOwners[0]], [safeOwners[0], safeOwners[0]], [safeOwners[0], '0x' + '0'.repeat(40)], [safeOwners[0], '0x' + '0'.repeat(39) + '1']]) {
      await assert.rejects(inspect(safe, owners(list)), /governance_owners_invalid/);
    }
    await isolated(async () => {
      await send(rpc, safe, safe, viem.encodeFunctionData({ abi: viem.parseAbi(['function enableModule(address)']), functionName: 'enableModule', args: [checksummed('a-module')] }));
      await assert.rejects(inspect(safe), /governance_has_modules/);
    });
    await isolated(async () => {
      await rpc('anvil_setStorageAt', [safe, GUARD_SLOT, word(BigInt(checksummed('a-guard')))]);
      await assert.rejects(inspect(safe), /governance_has_guard/);
    });
    // An owner that holds another role is the owner's choice (2 Oct 2026): a warning, never a refusal.
    assert.deepEqual((await inspect(safe)).warnings, []);
    for (const name of ROLE_NAMES.filter(n => n !== 'governance')) {
      const shared = await installSafe(rpc, { address: checksummed('shared-' + name), owners: [safeOwners[0], safeOwners[1], roles[name]] });
      assert.deepEqual((await inspect(shared)).warnings, ['governance_owner_holds_role: ' + name]);
    }
    // The owner's own arrangement: the deployer and the guardian among three owners, two to sign.
    const ownerLike = await installSafe(rpc, { address: checksummed('owner-like-safe'), owners: [roles.deployer, roles.guardian, safeOwners[2]] });
    const expected = ['governance_owner_holds_role: deployer', 'governance_owner_holds_role: guardian'];
    assert.deepEqual((await inspect(ownerLike)).warnings, expected);
    const report = await preflight(variant({ roles: { ...safeRoles, governance: ownerLike } }));
    assert.deepEqual([report.status, report.warnings, report.governance.warnings], ['passed', expected, expected]);
  });

  test('every dependency and cross-reference is the profile\'s', async () => {
    const profile = chain.profile, deps = dependencyMap(profile);
    await checkDependencies(profile, rpc);
    await assert.rejects(checkDependencies(profile, scripted(rpc, method => method === 'eth_chainId' ? '0x1' : undefined)), /chain_id_mismatch/);
    for (const [name, address] of [['createx', CREATE_X], ['v4PoolManager', deps.v4PoolManager], ['permit2', deps.permit2]]) {
      await isolated(async () => {
        await rpc('anvil_setCode', [address, '0x00']);
        await assert.rejects(checkDependencies(profile, rpc), new RegExp('dependency_codehash_mismatch: ' + name));
      });
    }
    const usdc = profile.chargeCurrencies.find(c => c.symbol === 'USDC').address.toLowerCase();
    await isolated(async () => {
      await rpc('anvil_setCode', [usdc, '0x00']);
      await assert.rejects(checkDependencies(profile, rpc), /charge_currency_codehash_mismatch/);
    });
    const unlisted = { ...profile, verification: { ...profile.verification, contracts: profile.verification.contracts.filter(row => row.address !== usdc) } };
    await assert.rejects(checkDependencies(unlisted, rpc), /charge_currency_hash_missing/);
    // Each cross-reference, alone: one dependency answers one getter with another address.
    const other = '0x' + '5a'.repeat(19) + '01';
    for (const [dependency, field, code] of [
      ['v3PositionManager', ['v3', 'factory'], 'v3_manager_factory_mismatch'], ['v3PositionManager', ['wrappedNative'], 'wrapped_native_mismatch'],
      ['v3Quoter', ['v3', 'factory'], 'v3_quoter_factory_mismatch'], ['v3SwapRouter', ['v3', 'factory'], 'v3_router_factory_mismatch'],
      ['v4PositionManager', ['v4', 'poolManager'], 'v4_manager_pool_mismatch'], ['v4PositionManager', ['permit2'], 'v4_manager_permit2_mismatch'],
      ['v4StateView', ['v4', 'poolManager'], 'v4_state_view_pool_mismatch'], ['v4Quoter', ['v4', 'poolManager'], 'v4_quoter_pool_mismatch']]) {
      const wrong = structuredClone(profile);
      if (field[0] === 'wrappedNative') wrong.wrappedNative.address = other; else if (field[0] === 'permit2') wrong.permit2 = other; else wrong.uniswap[field[0]][field[1]] = other;
      const runtime = stubRuntime(wrong), address = deps[dependency];
      const listed = structuredClone(profile);
      listed.verification.contracts = listed.verification.contracts.map(row => row.address === address ? { ...row, codehash: viem.keccak256(runtime) } : row);
      await isolated(async () => {
        await rpc('anvil_setCode', [address, runtime]);
        await assert.rejects(checkDependencies(listed, rpc), new RegExp(code));
      });
    }
  });

  test('the deployer\'s nonce is the package\'s and nothing of its is pending', async () => {
    await isolated(async () => {
      await send(rpc, deployer, deployer, '0x');
      await assert.rejects(preflight(), /deployer_nonce_mismatch/);
    });
    await isolated(async () => {
      await rpc('evm_setAutomine', [false]);
      try {
        await rpc('anvil_impersonateAccount', [deployer]);
        await rpc('eth_sendTransaction', [{ from: deployer, to: deployer, value: '0x0', gas: '0x5208' }]);
        await assert.rejects(preflight(), /deployer_has_pending_transactions/);
      } finally { await rpc('evm_setAutomine', [true]); }
    });
  });

  test('every target address is empty, or holds exactly this deployment on resume', async () => {
    const p = planned.bundle.parameters;
    await isolated(async () => {
      await executeSteps(planned.bundle, rpc, { limit: 1 });
      await assert.rejects(preflight(variant({ nonce: String(Number(p.nonce) + 1) })), /component_already_deployed: registry/);
    });
    const tail = variant({ steps: ['zap.v4'], resumeOf: 'c'.repeat(64), gasLimits: { 'zap.v4': p.gasLimits['zap.v4'] } });
    await assert.rejects(preflight(tail), /resume_prerequisite_missing: registry/);
    for (const [label, address] of [['registry', planned.bundle.components.registry.expectedAddress], ['registry', planned.bundle.components.registry.create3Proxy],
      ['vaultExecutor.v3', planned.bundle.manifest.contracts['vaultExecutor.v3']]]) {
      await isolated(async () => {
        await rpc('anvil_setCode', [address, '0x00']);
        await assert.rejects(preflight(), new RegExp('component_address_conflict: ' + label));
        await assert.rejects(deploymentState(planned.bundle, rpc, 'latest'), new RegExp('component_address_conflict: ' + label));
      });
    }
  });

  test('fees, gas limits and funds: each bound refused one unit short, passed at the bound', async () => {
    const p = planned.bundle.parameters, sim = planned.simulatedGas;
    const base = (await pinBlock(rpc)).baseFeePerGas;
    await assert.rejects(preflight(variant({ maxFeePerGas: (base - 1n).toString(), maxPriorityFeePerGas: '0' })), /max_fee_below_base_fee/);
    await preflight(variant({ maxFeePerGas: base.toString(), maxPriorityFeePerGas: '0' }));
    for (const component of ['registry', 'vault.v4']) {
      await assert.rejects(preflight(variant({ gasLimits: { ...p.gasLimits, [component]: (BigInt(sim[component]) - 1n).toString() } })), new RegExp('gas_limit_below_requirement: ' + component.replace('.', '\\.')));
      await preflight(variant({ gasLimits: { ...p.gasLimits, [component]: sim[component] } }));
    }
    await assert.rejects(preflight(planned.bundle, { simulatedGas: { ...sim, 'zap.v4': undefined } }), /gas_simulation_missing: zap.v4/);
    // Nitro: the L1 component is gas inside the limit.
    const nitro = variant({ profile: { ...p.profile, stack: 'arbitrum-nitro' } });
    const l1Gas = 50_000n, nitroRpc = l1Answer(rpc, { gas: l1Gas });
    const report = await preflight(nitro, { l1Rpc: nitroRpc });
    assert.equal(report.l1.status, 'estimated');
    assert(report.steps.every(s => s.l1Gas === l1Gas.toString()));
    const tight = component => variant({ profile: { ...p.profile, stack: 'arbitrum-nitro' }, gasLimits: { ...p.gasLimits, [component]: (BigInt(sim[component]) + l1Gas).toString() } });
    await preflight(tight('autoExit'), { l1Rpc: nitroRpc });
    await assert.rejects(preflight(tight('autoExit'), { l1Rpc: l1Answer(rpc, { gas: l1Gas + 1n }) }), /gas_limit_below_requirement: autoExit/);
    // OP Stack: the L1 fee is paid on top, with the same 25% headroom, out of the same balance.
    const fee = 10n ** 15n, opRpc = l1Answer(rpc, { fee });
    const op = await preflight(planned.bundle, { l1Rpc: opRpc });
    assert.equal(op.funding.l1FeesWithHeadroomWei, (11n * fee * 125n / 100n).toString());
    assert.equal(BigInt(op.funding.worstCaseWei), BigInt(op.funding.gasLimitTotal) * BigInt(p.maxFeePerGas) + 11n * fee * 125n / 100n);
    await isolated(async () => {
      const worst = BigInt(op.funding.worstCaseWei);
      await rpc('anvil_setBalance', [deployer, hex(worst - 1n)]);
      await assert.rejects(preflight(planned.bundle, { l1Rpc: opRpc }), /deployer_balance_insufficient/);
      await rpc('anvil_setBalance', [deployer, hex(worst)]);
      const exact = await preflight(planned.bundle, { l1Rpc: opRpc });
      assert.equal(exact.funding.marginWei, '0');
      assert.equal(BigInt(exact.funding.maxFeeCeilingWei), (worst - BigInt(exact.funding.l1FeesWithHeadroomWei)) / BigInt(exact.funding.gasLimitTotal));
    });
  });

  test('a package expires, and the pinned block must not move under the preflight', async () => {
    const expiry = planned.bundle.parameters.expiresAt;
    await assert.rejects(preflight(planned.bundle, { now: expiry }), /package_expired/);
    await preflight(planned.bundle, { now: expiry - 1 });
    await assert.rejects(preflightDeployment(structuredClone(planned.bundle), { rpc, simulatedGas: planned.simulatedGas }), /fresh_authenticated/);
    await rpc('evm_mine', []);
    const pinned = (await rpc('eth_getBlockByNumber', ['latest', false])).number;
    const reorg = scripted(rpc, async (method, params) => method === 'eth_getBlockByNumber' && params[0] === pinned ? { ...(await rpc(method, params)), hash: '0x' + 'd'.repeat(64) } : undefined);
    await assert.rejects(preflight(planned.bundle, { rpc: reorg }), /preflight_anchor_reorg/);
  });

  test('planning sizes each step from the simulation and live L1, within the per-transaction cap', async () => {
    const plan = options => planDeployment({ profile: chain.profile, roles: safeRoles, environment: 'local-test', releaseTag: 'v2-preflight', artifacts: compiled(), rpc, simulate: simulateGas, ...options });
    await assert.rejects(plan({ simulate: undefined }), /gas_simulator_required/);
    for (const validitySeconds of [0, 7 * 86400 + 1, 1.5]) await assert.rejects(plan({ validitySeconds }), /invalid_validity/);
    await assert.rejects(plan({ rpc: scripted(rpc, method => method === 'eth_chainId' ? '0x1' : undefined) }), /chain_id_mismatch/);
    const fixed = gas => async () => Object.fromEntries(DEPLOY_ORDER.map(c => [c, gas]));
    // ceil(13,421,772 x 1.25) = 16,777,215 fits EIP-7825's cap; one more gas unit of simulation does not.
    assert.equal((await plan({ simulate: fixed('13421772') })).bundle.parameters.gasLimits.registry, '16777215');
    await assert.rejects(plan({ simulate: fixed('13421773') }), /gas_limit_cap_exceeded: registry/);
    await assert.rejects(plan({ simulate: async () => ({ registry: '1000000' }) }), /gas_simulation_missing: priceAnchor/);
    // Nitro: limit = ceil((simulated + L1 gas) x 125%); no tip by default.
    const nitroProfile = { ...chain.profile, stack: 'arbitrum-nitro' };
    const nitro = await plan({ profile: nitroProfile, l1Rpc: l1Answer(rpc, { gas: 4001n }) });
    for (const c of DEPLOY_ORDER) assert.equal(BigInt(nitro.bundle.parameters.gasLimits[c]), ((BigInt(nitro.simulatedGas[c]) + 4001n) * 125n + 99n) / 100n);
    assert.equal(nitro.bundle.parameters.maxPriorityFeePerGas, '0');
    const base = (await pinBlock(rpc)).baseFeePerGas;
    assert.equal(nitro.bundle.parameters.maxFeePerGas, (3n * base).toString());
    // OP Stack: the node's tip suggestion, refused when implausible; explicit fees win.
    const suggested = BigInt(await rpc('eth_maxPriorityFeePerGas', []));
    const op = await plan();
    assert.equal(op.bundle.parameters.maxPriorityFeePerGas, suggested.toString());
    assert.equal(op.bundle.parameters.maxFeePerGas, (3n * base + suggested).toString());
    await assert.rejects(plan({ rpc: scripted(rpc, method => method === 'eth_maxPriorityFeePerGas' ? hex(10n ** 9n + 1n) : undefined) }), /suggested_priority_fee_implausible/);
    const explicit = await plan({ maxFeePerGas: '7000000000', maxPriorityFeePerGas: '5' });
    assert.deepEqual([explicit.bundle.parameters.maxFeePerGas, explicit.bundle.parameters.maxPriorityFeePerGas], ['7000000000', '5']);
    await assert.rejects(plan({ resumeFrom: structuredClone(planned.bundle) }), /resume_requires_fresh_authenticated_preparation/);
    await assert.rejects(l1Costs({ ...chain.profile, stack: 'zk' }, [], rpc, { required: false }), /unsupported_chain_stack/);
    await assert.rejects(l1Costs(chain.profile, planned.bundle.steps, rpc, { required: true }), /l1_estimate_unavailable/);
  });
});

test('the gas simulation refuses an incomplete package and a reverted step', async () => {
  const full = { parameters: { resumeOf: null, profile: { chainId: 31337 } }, manifest: { roles: { deployer: roles.deployer.toLowerCase() } } };
  await assert.rejects(simulateGas({ ...full, steps: [] }), /simulation_requires_all_steps/);
  await assert.rejects(simulateGas({ ...full, parameters: { ...full.parameters, resumeOf: 'a'.repeat(64) }, steps: DEPLOY_ORDER.map(component => ({ component })) }), /simulation_requires_all_steps/);
  const failing = viem.encodeFunctionData({ abi: viem.parseAbi(['function deployCreate3(bytes32,bytes) payable returns (address)']), functionName: 'deployCreate3',
    args: [roles.deployer.toLowerCase() + '00' + 'ab'.repeat(11), '0xfe'] });
  const profile = { ...readJson(join(repoRoot, 'api-contracts/v2/chains/base-8453.json')), chainId: 31337 };
  const steps = DEPLOY_ORDER.map(component => ({ component, transaction: { data: failing } }));
  await assert.rejects(simulateGas({ ...full, parameters: { ...full.parameters, profile }, steps }), /gas_simulation_reverted: registry/);
});

test('a public package: production rules on a node that is not a development EVM, then verified', async () => {
  const chain = await offlineChain({ chainId: 8453 });
  try {
    const rpc = chain.rpc, safe = await installSafe(rpc, { address: checksummed('production-safe') });
    const owner = { ...roles, governance: safe }, node = realNode(rpc), fee = 2n * 10n ** 12n, l1 = l1Answer(node, { fee });
    const plan = (options = {}) => planDeployment({ profile: chain.profile, roles: owner, environment: PRODUCTION, releaseTag: 'v2-production-test', artifacts: compiled(),
      rpc: node, l1Rpc: l1, simulate: simulateGas, ...options });
    await assert.rejects(plan({ roles: { ...roles, governance: safe, operator: viem.getAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266') } }), /public_test_key_as_production_role/);
    await assert.rejects(plan({ l1Rpc: node }), /l1_estimate_unavailable/);
    const planned = await plan();
    assert.equal(planned.bundle.manifest.environment, PRODUCTION);
    await rpc('anvil_setBalance', [owner.deployer, hex(10n ** 20n)]);
    const options = { simulatedGas: planned.simulatedGas, l1Rpc: l1 };
    // Production requires the Safe even when the caller does not ask, and refuses a development EVM by both signs.
    await assert.rejects(preflightDeployment(planned.bundle, { rpc, ...options }), /development_chain_refused_for_public_preparation/);
    await assert.rejects(preflightDeployment(planned.bundle, { rpc: scripted(rpc, method => method === 'web3_clientVersion' ? 'Geth/v1.16.4' : undefined), ...options }), /development_chain_refused_for_public_preparation/);
    for (const client of [7, 'HardhatNetwork/2.22.10/@nomicfoundation/edr', 'Ganache/v7.9.2/EthereumJS TestRPC', 'Tenderly/1.0', 'anvil/v1.7.1']) {
      await assert.rejects(preflightDeployment(planned.bundle, { rpc: scripted(node, method => method === 'web3_clientVersion' ? client : undefined), ...options }),
        /development_chain_refused_for_public_preparation/, String(client));
    }
    await assert.rejects(preflightDeployment(planned.bundle, { rpc: node, ...options, l1Rpc: node }), /l1_estimate_unavailable/);
    const report = await preflightDeployment(planned.bundle, { rpc: node, ...options });
    assert.equal(report.governance.kind, 'safe');
    assert(report.chain.client.startsWith('Geth'));
    const eoa = await plan({ roles: roles });
    await rpc('anvil_setBalance', [roles.deployer, hex(10n ** 20n)]);
    await assert.rejects(preflightDeployment(eoa.bundle, { rpc: node, simulatedGas: eoa.simulatedGas, l1Rpc: l1 }), /governance_has_no_code/);
    const hashes = await executeSteps(planned.bundle, rpc);
    await assert.rejects(verifyDeployment(planned.bundle, { rpc, transactionHashes: hashes }), /development_chain_refused_for_public_preparation/);
    const manifest = await verifyDeployment(planned.bundle, { rpc: node, transactionHashes: hashes, blockTag: 'latest' });
    validateManifest(manifest);
    assert.deepEqual([manifest.environment, manifest.status, manifest.roles.governance], [PRODUCTION, 'verified', safe.toLowerCase()]);
  } finally { await chain.stop(); }
});
