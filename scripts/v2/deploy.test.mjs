import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot, viem, CREATE_X, CREATE_X_CODE_HASH, CREATE3_PROXY_HASH, CREATE3_PROXY_RUNTIME, CREATEX_EVENTS, CONTRACT_NAMES, DEPLOY_ORDER, ROLE_NAMES,
  POLICIES, PRODUCTION, PRODUCTION_DEPLOYER, PUBLIC_TEST_ACCOUNTS, MAX_TRANSACTION_GAS, SAFE_SINGLETONS, SAFE_PROXY_RUNTIME_HASHES,
  precomputeAddresses, validateRoleInput, checkRoleAddresses, compileV2, checkPolicyConstants, literalNumber, prepareDeployment, rebuildPackage,
  packageDigest, fullPackage, planDeployment, preflightDeployment, verifyDeployment, deploymentState, checkSignedTransactions,
  explorerInput, committedProfile, checkProvenance, expectedRuntime, writeJson, flags, cli, readJson, quantity, makeRpc, readOnlyRpc,
  rpcErrorReason, pinBlock } from './deploy.mjs';
import { requireAnvil, installCreateX, installOfflineDependencies, installStubs, startAnvil, simulateGas, rehearsalAccount, localRoles, stubRuntime } from './deploy-anvil.mjs';
import { executeSteps, deployLocal, chainProfile, creationTransactions, cli as localCli } from './deploy-local.mjs';
import { cli as forkCli } from './deploy-fork.mjs';
import { validateManifest } from './deploy-schema.mjs';
import { compiled, roles, nowSeconds, hex, checksummed, offlineChain, parametersFor, scripted, isCall, send } from './deploy-test-support.mjs';

/** The owner's deployer gives these on 4663, 8453 and 42161 (issue #301); CREATE3 depends on deployer and salt only. */
const PRODUCTION_ADDRESSES = Object.freeze({
  registry: '0x25d4f013ecff3790e384e16ca9951bba6cd715fa', priceAnchor: '0x8c1edc4280d9533f6336f760380ba329e1f81f43',
  autoExit: '0x6109fc514a88a8e85e6e5c863238ddba9a98be36', vaultSwap: '0xbf22a36bbb419846e073cf0c6c729f669d7f348a',
  'vault.v3': '0xd55c0f5ff8ad1ded828edb36be77e0f3677ad4a4', 'vault.v4': '0xa3ff8d74e4ec4a19f35d92b7eec852ba6f7e2bbb',
  'vaultFactory.v3': '0xa7dfb61a6597d09742cb7f9a8780c9c74ebc34f4', 'vaultFactory.v4': '0xc71a561853514efc2271f1d10c13ec95834792ba',
  'zap.v4.steps': '0x355b0997d5e04392862a8e8d21d911851b2eefbe', 'zap.v3': '0xe30d7e07a67198c45d4c7b67d8423cbb6c7ea5a0',
  'zap.v4': '0x376b92929bbe778c6dd64e8d73f8688686288e8a', 'vaultExecutor.v3': '0xd8d3bf832b234855fee2ac36ac4803aa7f9adca9',
  'vaultExecutor.v4': '0xf3f68d8461c2071e2b8d88a60ce64f527f1d6639',
});
const deployerKey = rehearsalAccount('deployer');

/** A `local-test` profile without a chain: Base's addresses, one stub code hash per dependency. */
function syntheticProfile(chainId = 31337) {
  const profile = { ...readJson(join(repoRoot, 'api-contracts/v2/chains/base-8453.json')), chainId, name: 'Offline V2 deployment fixtures', slug: 'local' };
  const codehash = viem.keccak256(stubRuntime(profile));
  const addresses = new Set([...Object.values(profile.uniswap.v3).filter(v => typeof v === 'string' && v.length === 42),
    ...Object.values(profile.uniswap.v4), profile.uniswap.universalRouter.address, profile.permit2, profile.wrappedNative.address,
    ...profile.chargeCurrencies.filter(c => !c.native).map(c => c.address)].map(a => a.toLowerCase()));
  profile.verification = { block: 0, checkedAt: '2026-10-02', contracts: [...addresses].map(address => ({ name: 'stub', address, codehash })) };
  return profile;
}

test('the owner deployer predicts the 13 production addresses, the same on every chain', () => {
  assert.equal(PRODUCTION_DEPLOYER, '0x706627e3e75b0603c4b6f9a1ebbfc635da712747');
  const predicted = precomputeAddresses(PRODUCTION_DEPLOYER);
  assert.deepEqual(predicted.contracts, PRODUCTION_ADDRESSES);
  assert.deepEqual(precomputeAddresses(viem.getAddress(PRODUCTION_DEPLOYER)), predicted);
  for (const component of DEPLOY_ORDER) {
    assert.equal(viem.getContractAddress({ from: predicted.proxies[component], nonce: 1n }).toLowerCase(), PRODUCTION_ADDRESSES[component]);
  }
});

test('addresses and RPC quantities are parsed strictly', () => {
  assert.throws(() => precomputeAddresses('0x123'), /invalid_address/);
  assert.throws(() => precomputeAddresses(12), /invalid_address/);
  assert.throws(() => precomputeAddresses('0x' + '0'.repeat(40)), /zero_address/);
  for (const value of ['0x0', '0x1f', '0xabc']) assert.equal(quantity(value), BigInt(value));
  for (const value of [5, '0x01', '12', '0x', '0xG', '0X1', ' 0x1', null]) assert.throws(() => quantity(value), /invalid_rpc_quantity/, String(value));
  for (const url of ['ftp://127.0.0.1/', 'file:///etc/hosts', 'ws://127.0.0.1:8545']) assert.throws(() => makeRpc(url), /invalid_rpc_url/);
});

test('a pinned block must exist and carry a hash', async () => {
  const block = { number: '0x10', hash: '0x' + 'a'.repeat(64), timestamp: '0x5', baseFeePerGas: '0x7' };
  assert.deepEqual(await pinBlock(async () => block, 'latest'), { tag: '0x10', number: 16n, hash: block.hash, timestamp: 5n, baseFeePerGas: 7n });
  assert.equal((await pinBlock(async () => ({ ...block, baseFeePerGas: undefined }))).baseFeePerGas, 0n);
  for (const answer of [null, { ...block, hash: '0x12' }, { ...block, hash: undefined }]) {
    await assert.rejects(pinBlock(async () => answer, 'finalized'), /block_missing: finalized/);
  }
});

test('the precomputed runtime refuses what it cannot patch exactly', () => {
  const manifest = { contracts: precomputeAddresses(PRODUCTION_DEPLOYER).contracts, chain: { chainId: 8453 },
    dependencies: Object.fromEntries(['v3Factory', 'v3PositionManager', 'v4PoolManager', 'v4PositionManager', 'v4StateView', 'permit2', 'wrappedNative'].map((k, i) => [k, '0x' + String(i + 1).repeat(40)])) };
  const profile = { uniswap: { v3: { poolInitCodeHash: '0x' + 'ab'.repeat(32) } } };
  const artifact = (object, refs = {}, link = {}) => ({ contracts: { DominoRegistry: { evm: { bytecode: { linkReferences: link }, deployedBytecode: { object, immutableReferences: refs, linkReferences: {} } } } },
    immutables: { 1: 'REGISTRY', 2: 'V3_POOL_INIT_CODE_HASH', 3: 'SOMETHING_ELSE' } });
  const code = '00'.repeat(96);
  assert.equal(expectedRuntime('registry', artifact(code, { 1: [{ start: 0, length: 32 }] }), manifest, profile).slice(26, 66), manifest.contracts.registry.slice(2));
  assert.throws(() => expectedRuntime('registry', artifact(code, {}, { 'x.sol': {} }), manifest, profile), /unlinked_component/);
  assert.throws(() => expectedRuntime('registry', artifact(''), manifest, profile), /runtime_size_limit/);
  assert.throws(() => expectedRuntime('registry', artifact('00'.repeat(24577)), manifest, profile), /runtime_size_limit/);
  expectedRuntime('registry', artifact('00'.repeat(24576)), manifest, profile);
  assert.throws(() => expectedRuntime('registry', artifact(code, { 3: [{ start: 0, length: 32 }] }), manifest, profile), /unknown_immutable: registry:SOMETHING_ELSE/);
  assert.throws(() => expectedRuntime('registry', artifact(code, { 2: [{ start: 0, length: 32 }] }), manifest, { uniswap: { v3: { poolInitCodeHash: '0x' + 'ab'.repeat(33) } } }), /immutable_overflow/);
  for (const range of [{ start: 0, length: 31 }, { start: -1, length: 32 }, { start: 80, length: 32 }]) {
    assert.throws(() => expectedRuntime('registry', artifact(code, { 1: [range] }), manifest, profile), /invalid_immutable_range/);
  }
  assert.throws(() => expectedRuntime('registry', artifact(code, { 1: [{ start: 0, length: 32 }], 2: [{ start: 16, length: 32 }] }), manifest, profile), /overlapping_immutable_range/);
});

test('guarded caller salt and stable constructor-child predictions', () => {
  const deployer = roles.deployer.toLowerCase(), first = precomputeAddresses(deployer), other = precomputeAddresses(roles.guardian);
  assert.equal(Object.keys(first.contracts).length, 13);
  assert.equal(new Set(Object.values(first.contracts)).size, 13);
  for (const component of DEPLOY_ORDER) {
    const raw = first.salts[component];
    assert.equal(raw.slice(0, 42), deployer); assert.equal(raw.slice(42, 44), '00');
    assert.equal(raw.slice(44), viem.keccak256(viem.toHex('domino.v2.' + component)).slice(2, 24));
    assert.equal(first.guardedSalts[component], viem.keccak256(viem.encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [deployer, raw])));
    assert.equal(first.proxies[component], viem.getCreate2Address({ from: CREATE_X, salt: first.guardedSalts[component], bytecodeHash: CREATE3_PROXY_HASH }).toLowerCase());
    const wrongProxy = viem.getCreate2Address({ from: CREATE_X, salt: raw, bytecodeHash: CREATE3_PROXY_HASH });
    assert.notEqual(first.contracts[component], viem.getContractAddress({ from: wrongProxy, nonce: 1n }).toLowerCase());
    assert.notEqual(first.contracts[component], other.contracts[component]);
  }
  assert.throws(() => precomputeAddresses(deployer, '0x' + '42'.repeat(20)), /noncanonical_createx/);
});

test('roles: six checksummed addresses, no placeholder, operator != publisher, no public test key in production', () => {
  const lower = Object.fromEntries(ROLE_NAMES.map(name => [name, roles[name].toLowerCase()]));
  assert.deepEqual(validateRoleInput(roles), lower);
  assert.deepEqual(validateRoleInput(roles, { production: true }), lower);
  for (const name of ROLE_NAMES) {
    const missing = { ...roles }; delete missing[name]; assert.throws(() => validateRoleInput(missing), /mandatory_roles/);
    assert.throws(() => validateRoleInput({ ...roles, extra: roles.deployer }), /mandatory_roles/);
    assert.throws(() => validateRoleInput({ ...roles, [name]: roles[name].toLowerCase() }), new RegExp('role_address_not_checksummed: ' + name));
    // A one-character typo keeps the format but breaks the checksum.
    const value = roles[name], last = value.at(-2) === '0' ? '1' : '0';
    assert.throws(() => validateRoleInput({ ...roles, [name]: value.slice(0, -2) + last + value.at(-1) }), /role_address_not_checksummed/);
    assert.throws(() => validateRoleInput({ ...roles, [name]: '0x' + '0'.repeat(40) }), /zero_address/);
    assert.throws(() => validateRoleInput({ ...roles, [name]: '0x' + '1'.repeat(40) }), /placeholder_role/);
    assert.throws(() => validateRoleInput({ ...roles, [name]: viem.getAddress('0x' + '0'.repeat(36) + 'ffff') }), /placeholder_role/);
    assert.throws(() => validateRoleInput({ ...roles, [name]: 12 }), /invalid_address/);
  }
  assert.throws(() => validateRoleInput({ ...roles, publisher: roles.operator }), /operator_publisher_conflict/);
  for (const [index, key] of PUBLIC_TEST_ACCOUNTS.entries()) {
    const name = ROLE_NAMES[index % ROLE_NAMES.length], input = { ...roles, [name]: viem.getAddress(key) };
    assert.throws(() => validateRoleInput(input, { production: true }), /public_test_key_as_production_role/);
    assert.equal(validateRoleInput(input)[name], key);
    assert.throws(() => checkRoleAddresses(Object.fromEntries(Object.entries(input).map(([k, v]) => [k, v.toLowerCase()])), { production: true }), /public_test_key/);
  }
});

test('the refused public test keys are the first ten accounts of the public test mnemonic', () => {
  const { mnemonicToAccount } = createRequire(join(repoRoot, 'app/package.json'))('viem/accounts');
  const mnemonic = 'test test test test test test test test test test test junk';
  assert.deepEqual([...PUBLIC_TEST_ACCOUNTS], Array.from({ length: 10 }, (_, addressIndex) => mnemonicToAccount(mnemonic, { addressIndex }).address.toLowerCase()));
  // The rehearsal accounts are not among them (they carry EIP-7702 sweepers on the three chains).
  assert(Object.values(localRoles()).every(a => !PUBLIC_TEST_ACCOUNTS.includes(a.toLowerCase())));
});

test('canonical CreateX and Safe fixtures authenticate independently of installation', () => {
  const createx = readJson(join(repoRoot, 'scripts/v2/deploy-fixtures/createx-runtime.json'));
  assert.equal(viem.keccak256(createx.runtime), CREATE_X_CODE_HASH);
  assert.equal(createx.runtimeCodeHash, CREATE_X_CODE_HASH);
  assert.equal(createx.license, 'AGPL-3.0-only');
  const safe = readJson(join(repoRoot, 'scripts/v2/deploy-fixtures/safe-runtime.json'));
  assert.equal(viem.keccak256(safe.singleton.runtime), SAFE_SINGLETONS[safe.singleton.address.toLowerCase()].codehash);
  assert.equal(SAFE_SINGLETONS[safe.singleton.address.toLowerCase()].version, '1.4.1');
  assert.equal(SAFE_PROXY_RUNTIME_HASHES[viem.keccak256(safe.proxy.runtime)], '1.4.1');
  assert.equal(safe.license, 'LGPL-3.0-only');
  assert.match(readFileSync(join(repoRoot, 'scripts/v2/deploy-fixtures/Safe.LICENSE'), 'utf8'), /GNU LESSER GENERAL PUBLIC LICENSE\s+Version 3/);
});

test('committed local manifest preserves complete receipts and source provenance', () => {
  const fixture = readJson(join(repoRoot, 'scripts/v2/deploy-fixtures/deployment.fixture.json'));
  validateManifest(fixture);
  assert.equal(fixture.environment, 'local-test');
  const editedSource = structuredClone(fixture); editedSource.build.sourceHashes[Object.keys(editedSource.build.sourceHashes)[0]] = '0'.repeat(64);
  assert.throws(() => validateManifest(editedSource), /manifest_build_invalid/);
  const masquerade = structuredClone(fixture); masquerade.status = 'prepared';
  assert.throws(() => validateManifest(masquerade), /prepared_has_receipts/);
  const codeRecipient = structuredClone(fixture); codeRecipient.roles.feeRecipient = codeRecipient.contracts.registry;
  assert.throws(() => validateManifest(codeRecipient), /role_component_conflict/);
});

test('the local sender refuses anything but a validated loopback Anvil', async () => {
  await assert.rejects(requireAnvil('https://example.com', async () => 'anvil/v1'), /local_anvil_only/);
  await assert.rejects(requireAnvil('http://127.0.0.1:1', async () => 'geth/v1'), /anvil_required/);
  const unvalidated = async () => { assert.fail('unvalidated RPC must never be called'); };
  await assert.rejects(installCreateX(unvalidated), /local_rpc_not_validated/);
  await assert.rejects(installOfflineDependencies(unvalidated), /local_rpc_not_validated/);
  await assert.rejects(executeSteps({ manifest: { roles: {} }, steps: [] }, unvalidated), /local_rpc_not_validated/);
});

test('missing F4 is refused, never replaced with a mock or silently omitted', () => {
  const incompleteRoot = mkdtempSync(join(tmpdir(), 'domino-v2-incomplete-'));
  try {
    mkdirSync(join(incompleteRoot, 'contracts/src/v2'), { recursive: true });
    assert.throws(() => compileV2({ sourceRoot: incompleteRoot }), /missing_auto_exit_dependency/);
  } finally { rmSync(incompleteRoot, { recursive: true, force: true }); }
});

test('the recorded tariffs are the compiled contracts\' constants', () => {
  const constants = compiled().policyConstants;
  assert.deepEqual(constants, { FEE_ASSISTED_SWAP_BPS: 65, FEE_AUTOMATION_SIMPLE_BPS: 200, FEE_AUTOMATION_DOMINO_BPS: 400, FEE_AUTO_EXIT_BPS: 20, MIN_UNIVERSAL_ROUTER_VERSION: 212 });
  checkPolicyConstants(constants);
  assert.equal(literalNumber({ nodeType: 'Literal', kind: 'number', value: '65' }), 65);
  for (const node of [{ nodeType: 'BinaryOperation', value: '65' }, { nodeType: 'Literal', kind: 'string', value: '65' },
    { nodeType: 'Literal', kind: 'number', value: '6_5' }, { nodeType: 'Literal', kind: 'number', value: '0x41' }, undefined]) {
    assert(Number.isNaN(literalNumber(node)), JSON.stringify(node));
  }
  for (const name of Object.keys(constants)) {
    assert.throws(() => checkPolicyConstants({ ...constants, [name]: constants[name] + 1 }), new RegExp('policy_constant_mismatch: ' + name));
    const missing = { ...constants }; delete missing[name];
    assert.throws(() => checkPolicyConstants(missing), new RegExp('policy_constant_mismatch: ' + name));
  }
});

test('prepareDeployment: every parameter explicit and bounded', () => {
  const artifacts = compiled(), profile = syntheticProfile(), base = parametersFor(profile);
  const bundle = prepareDeployment(base, artifacts);
  assert.equal(bundle.schemaVersion, 2);
  assert.deepEqual(bundle.steps.map(s => s.component), DEPLOY_ORDER);
  assert.equal(bundle.manifest.environment, 'local-test');
  assert.deepEqual(bundle.parameters.roles, roles);
  assert.deepEqual(Object.keys(bundle.components), DEPLOY_ORDER);
  for (const step of bundle.steps) {
    assert.equal(viem.keccak256(step.transaction.data), bundle.components[step.component].callDataHash);
    assert.equal(step.create3Proxy, bundle.components[step.component].create3Proxy);
  }
  assert.deepEqual(rebuildPackage(structuredClone(bundle), artifacts), bundle);
  const edited = structuredClone(bundle); edited.steps[0].transaction.gas = '0x5208';
  assert.throws(() => rebuildPackage(edited, artifacts), /unsigned_package_changed/);
  assert.throws(() => rebuildPackage({ ...structuredClone(bundle), schemaVersion: 1 }, artifacts), /unsupported_package/);
  assert.throws(() => bundle.steps[0].transaction.gas = '0x1', TypeError);
  const refused = (change, code) => assert.throws(() => prepareDeployment({ ...base, ...change }, artifacts), new RegExp(code));
  assert.throws(() => prepareDeployment(base, structuredClone(artifacts)), /preparation_requires_source_compilation/);
  const missing = { ...base }; delete missing.expiresAt;
  assert.throws(() => prepareDeployment(missing, artifacts), /invalid_preparation_parameters/);
  refused({ extra: 1 }, 'invalid_preparation_parameters');
  refused({ environment: 'production' }, 'invalid_environment');
  refused({ roles: { ...roles, operator: viem.getAddress(PUBLIC_TEST_ACCOUNTS[0]) }, environment: PRODUCTION }, 'public_test_key_as_production_role');
  refused({ environment: PRODUCTION }, 'unsupported_chain_profile');
  refused({ environment: 'fork-rehearsal' }, 'unsupported_chain_profile');
  refused({ profile: { ...profile, enabled: false } }, 'unsupported_chain_profile');
  refused({ profile: { ...profile, deployer: { ...profile.deployer, codehash: '0x' + '42'.repeat(32) } } }, 'createx_profile_mismatch');
  for (const version of ['2.1.1', '2.0.9', '1.9.9', '2.1', 'x.y.z']) refused({ profile: { ...profile, uniswap: { ...profile.uniswap, universalRouter: { ...profile.uniswap.universalRouter, version } } } }, 'universal_router_version_too_old');
  for (const version of ['2.1.2', '2.2.0', '3.0.0']) prepareDeployment({ ...base, profile: { ...profile, uniswap: { ...profile.uniswap, universalRouter: { ...profile.uniswap.universalRouter, version } } } }, artifacts);
  refused({ profile: { ...profile, uniswap: { ...profile.uniswap, v3: { ...profile.uniswap.v3, poolInitCodeHash: '0x12' } } } }, 'invalid_pool_init_code_hash');
  refused({ profile: { ...profile, bridge: { ...profile.bridge, appFeeBps: 30 } } }, 'policy_bridge_fee_mismatch');
  refused({ profile: { ...profile, verification: { ...profile.verification, contracts: profile.verification.contracts.slice(1) } } }, 'dependency_hash_missing_or_conflicting');
  refused({ sourceCommit: '0'.repeat(40) }, 'source_commit_mismatch');
  refused({ releaseTag: 'v2/release' }, 'invalid_release_tag');
  refused({ steps: [] }, 'invalid_step_selection');
  refused({ steps: ['registry', 'registry'], resumeOf: '0'.repeat(64), gasLimits: { registry: '100000' } }, 'invalid_step_selection');
  refused({ steps: ['zap.v4', 'registry'], resumeOf: '0'.repeat(64), gasLimits: { registry: '100000', 'zap.v4': '100000' } }, 'invalid_step_selection');
  refused({ steps: ['vaultExecutor.v3'], resumeOf: '0'.repeat(64), gasLimits: { 'vaultExecutor.v3': '100000' } }, 'invalid_step_selection');
  refused({ steps: ['zap.v4'], gasLimits: { 'zap.v4': '100000' } }, 'invalid_resume_reference');
  refused({ steps: ['zap.v4'], resumeOf: 'abc', gasLimits: { 'zap.v4': '100000' } }, 'invalid_resume_reference');
  refused({ resumeOf: '0'.repeat(64) }, 'invalid_resume_reference');
  const subset = prepareDeployment({ ...base, steps: ['zap.v3', 'zap.v4'], resumeOf: 'a'.repeat(64), gasLimits: { 'zap.v3': '7000000', 'zap.v4': '7000000' }, nonce: '7' }, artifacts);
  assert.deepEqual(subset.steps.map(s => [s.component, quantity(s.transaction.nonce)]), [['zap.v3', 7n], ['zap.v4', 8n]]);
  assert.deepEqual(subset.components, bundle.components);
  refused({ gasLimits: { ...base.gasLimits, extra: '1' } }, 'gas_limits_must_cover_each_step');
  refused({ gasLimits: { ...base.gasLimits, registry: '1e6' } }, 'invalid_gas_limit');
  refused({ gasLimits: { ...base.gasLimits, registry: (MAX_TRANSACTION_GAS + 1n).toString() } }, 'gas_limit_out_of_bounds');
  refused({ gasLimits: { ...base.gasLimits, registry: '20999' } }, 'gas_limit_out_of_bounds');
  prepareDeployment({ ...base, gasLimits: { ...base.gasLimits, registry: '21000' } }, artifacts);
  refused({ maxFeePerGas: '0' }, 'invalid_transaction_budget');
  refused({ maxPriorityFeePerGas: '100000000001' }, 'invalid_transaction_budget');
  refused({ nonce: (2n ** 64n - 12n).toString() }, 'invalid_transaction_budget');
  refused({ expiresAt: 0 }, 'invalid_expiry');
  refused({ expiresAt: '1900000000' }, 'invalid_expiry');
  refused({ roles: { ...roles, feeRecipient: viem.getAddress(bundle.manifest.contracts.registry) } }, 'role_component_conflict');
  refused({ roles: { ...roles, guardian: viem.getAddress(CREATE_X) } }, 'role_component_conflict');
  refused({ profile: { ...profile, chargeCurrencies: profile.chargeCurrencies.slice(0, 1) } }, 'invalid_charge_currencies');
  refused({ profile: { ...profile, chargeCurrencies: [...profile.chargeCurrencies, profile.chargeCurrencies[0]] } }, 'invalid_charge_currencies');
});

test('signed transactions are checked offline: exactly a package step, signed by the deployer', async () => {
  const artifacts = compiled(), profile = syntheticProfile();
  const bundle = prepareDeployment(parametersFor(profile, { nonce: '5', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000' }), artifacts);
  const unsigned = step => { const t = step.transaction; return { type: 'eip1559', chainId: Number(quantity(t.chainId)), nonce: Number(quantity(t.nonce)),
    gas: quantity(t.gas), maxFeePerGas: quantity(t.maxFeePerGas), maxPriorityFeePerGas: quantity(t.maxPriorityFeePerGas), to: t.to, value: 0n, data: t.data, accessList: [] }; };
  const raws = await Promise.all(bundle.steps.slice(0, 3).map(step => deployerKey.signTransaction(unsigned(step))));
  const checked = await checkSignedTransactions(bundle, raws.reverse());
  assert.deepEqual(checked.map(x => [x.component, x.nonce]), [['registry', 5], ['priceAnchor', 6], ['autoExit', 7]]);
  assert.equal(checked[0].transactionHash, viem.keccak256(raws[2]));
  const first = unsigned(bundle.steps[0]);
  const other = await rehearsalAccount('guardian').signTransaction(first);
  await assert.rejects(checkSignedTransactions(bundle, [other]), /signer_is_not_the_deployer/);
  for (const [field, change] of [['chainId', { chainId: 1 }], ['to', { to: viem.getAddress(PRODUCTION_DEPLOYER) }], ['value', { value: 1n }],
    ['data', { data: first.data + '00' }], ['gas', { gas: first.gas + 1n }], ['maxFeePerGas', { maxFeePerGas: first.maxFeePerGas + 1n }],
    ['maxPriorityFeePerGas', { maxPriorityFeePerGas: first.maxPriorityFeePerGas + 1n }],
    ['accessList', { accessList: [{ address: CREATE_X, storageKeys: [] }] }]]) {
    await assert.rejects(checkSignedTransactions(bundle, [await deployerKey.signTransaction({ ...first, ...change })]), new RegExp('signed_transaction_mismatch: registry:' + field));
  }
  await assert.rejects(checkSignedTransactions(bundle, [await deployerKey.signTransaction({ ...first, nonce: 99 })]), /signed_nonce_not_in_package/);
  await assert.rejects(checkSignedTransactions(bundle, [raws[2], raws[2]]), /signed_nonce_not_in_package/);
  await assert.rejects(checkSignedTransactions(bundle, [await deployerKey.signTransaction({ to: CREATE_X, data: first.data, gas: first.gas, gasPrice: 1n, nonce: 5, chainId: first.chainId })]), /signed_transaction_not_eip1559/);
  await assert.rejects(checkSignedTransactions(bundle, []), /signed_transactions_required/);
  await assert.rejects(checkSignedTransactions(structuredClone(bundle), raws), /check_requires_fresh_authenticated_preparation/);
  await assert.rejects(checkSignedTransactions(bundle, raws, { now: bundle.parameters.expiresAt }), /package_expired/);
  await checkSignedTransactions(bundle, raws, { now: bundle.parameters.expiresAt - 1 });
});

test('block-explorer input: the exact compiler input and every component\'s constructor arguments', () => {
  const artifacts = compiled(), bundle = prepareDeployment(parametersFor(syntheticProfile()), artifacts);
  const input = explorerInput(bundle, artifacts);
  assert.equal(input.compilerVersion, 'v0.8.26+commit.8a97fa7a');
  assert.deepEqual(input.standardJsonInput.settings, { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun', metadata: { bytecodeHash: 'none' } });
  assert.deepEqual(Object.keys(input.components), Object.keys(CONTRACT_NAMES));
  for (const [component, entry] of Object.entries(input.components)) {
    const [source, name] = entry.contract.split(':');
    assert.equal(name, CONTRACT_NAMES[component]);
    assert.ok(input.standardJsonInput.sources[source]);
    assert.equal(entry.address, bundle.manifest.contracts[component]);
    if (component.startsWith('vaultExecutor.')) assert.equal(entry.constructorArguments, input.components['vault.' + component.slice(-2)].constructorArguments);
    else assert.equal(viem.keccak256(viem.concatHex(['0x' + artifacts.contracts[name].evm.bytecode.object, entry.constructorArguments])), bundle.components[component].initcodeHash);
  }
  assert.equal(input.components['zap.v4.steps'].constructorArguments, '0x');
  assert.throws(() => explorerInput(structuredClone(bundle), artifacts), /explorer_input_requires_fresh_authenticated_preparation/);
});

test('a public package attests a clean checkout and the committed chain profile', () => {
  const commit = compiled().sourceCommit;
  const clean = { sourceRoot: repoRoot, sourceCommit: commit, sourceState: { workingTreeSourceChanges: false, workingTreeToolChanges: false } };
  for (const chainId of [4663, 8453, 42161]) {
    const profile = committedProfile(repoRoot, commit, chainId);
    assert.equal(profile.chainId, chainId);
    checkProvenance({ artifacts: clean, profile });
    assert.throws(() => checkProvenance({ artifacts: { ...clean, sourceRoot: tmpdir() }, profile }), /public_preparation_requires_the_tool_checkout/);
    for (const flag of ['workingTreeSourceChanges', 'workingTreeToolChanges']) {
      assert.throws(() => checkProvenance({ artifacts: { ...clean, sourceState: { ...clean.sourceState, [flag]: true } }, profile }), /uncommitted_changes_refused_for_public_preparation/);
    }
    assert.throws(() => checkProvenance({ artifacts: clean, profile: { ...profile, permit2: PRODUCTION_DEPLOYER } }), /chain_profile_not_the_committed_one/);
  }
  assert.throws(() => committedProfile(repoRoot, commit, 1), /committed_chain_profile_missing/);
});

test('CLI: arguments checked before any work; outputs never overwritten', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'domino-v2-cli-'));
  try {
    const out = join(directory, 'addresses.json');
    await cli(['addresses', '--deployer', PRODUCTION_DEPLOYER, '--out', out]);
    assert.deepEqual(readJson(out).contracts, PRODUCTION_ADDRESSES);
    await assert.rejects(cli(['addresses', '--deployer', PRODUCTION_DEPLOYER, '--out', out]), /output_exists/);
    assert.throws(() => writeJson(out, {}), /output_exists/);
    await assert.rejects(cli(['deploy']), /command_required/);
    await assert.rejects(cli(['prepare', '--chain-profile', 'x', '--roles', 'y', '--release-tag', 'z', '--out', join(directory, 'p.json'), '--gas-limit', '1']), /unknown_or_missing_cli_argument/);
    await assert.rejects(cli(['prepare', '--chain-profile', 'x', '--roles', 'y', '--release-tag', 'z', '--out', join(directory, 'p.json')]), /exactly_one_rpc_source_required/);
    await assert.rejects(cli(['prepare', '--chain-profile', 'x', '--roles', 'y', '--release-tag', 'z', '--out', join(directory, 'p.json'), '--rpc', 'http://127.0.0.1:1', '--rpc-file', 'f']), /exactly_one_rpc_source_required/);
    await assert.rejects(cli(['verify', '--package', 'x', '--receipts', 'y', '--out', out, '--rpc', 'http://127.0.0.1:1']), /output_exists/);
    writeFileSync(join(directory, 'p.preflight.json'), '{}');
    await assert.rejects(cli(['prepare', '--chain-profile', 'x', '--roles', 'y', '--release-tag', 'z', '--out', join(directory, 'p.json'), '--rpc', 'http://127.0.0.1:1']), /output_exists/);
    await assert.rejects(cli(['resume', '--package', 'x', '--out', join(directory, 'r.json'), '--rpc', 'http://127.0.0.1:1', '--valid-hours', '200']), /invalid_valid_hours/);
    await assert.rejects(cli(['resume', '--package', 'x', '--out', join(directory, 'r.json'), '--rpc', 'http://127.0.0.1:1', '--max-fee-per-gas', '1.5']), /invalid_fee/);
    await assert.rejects(cli(['verify', '--package', '', '--receipts', 'y', '--out', join(directory, 'v.json'), '--rpc', 'http://127.0.0.1:1']), /invalid_cli_arguments/);
    await assert.rejects(localCli([]), /rpc_and_out_required/);
    await assert.rejects(localCli(['--rpc', 'http://127.0.0.1:1', '--out', join(directory, 'l.json'), '--chain', 'x']), /unknown_cli_argument/);
    await assert.rejects(forkCli(['--out', directory]), /usage: --robinhood-rpc/);
    await assert.rejects(forkCli(['--robinhood-rpc', 'http://127.0.0.1:1', '--out', directory, '--rpc', 'x']), /usage: --robinhood-rpc/);
    assert.deepEqual(flags(['--a', '1', '--b', '--c', '2'], ['b']), { a: '1', b: true, c: '2' });
    assert.throws(() => flags(['--a', '1', '--a', '2']), /duplicate_cli_argument/);
    assert.throws(() => flags(['--a']), /invalid_cli_arguments/);
    assert.throws(() => flags(['a', '1']), /invalid_cli_arguments/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the RPC transport retries rate limits only, a bounded number of times, and stays read-only and bounded', async () => {
  let calls = 0;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      calls++;
      const id = JSON.parse(body).id;
      response.setHeader('content-type', 'application/json');
      const limits = { '/limited': { code: -32016, message: 'over rate limit' }, '/code-32016': { code: -32016, message: 'slow down' },
        '/code-32005': { code: -32005, message: 'slow down' }, '/code429': { code: 429, message: 'slow down' }, '/message': { code: -1, message: 'Too Many Requests' } };
      if (limits[request.url] && calls <= 2) return response.end(JSON.stringify({ jsonrpc: '2.0', id, error: limits[request.url] }));
      if (request.url === '/http429' && calls <= 1) { response.statusCode = 429; return response.end('{}'); }
      if (request.url === '/broken') return response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'no method at https://node.example/secret-key' } }));
      if (request.url === '/http500') { response.statusCode = 500; return response.end('{}'); }
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result: '0x1' }));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    calls = 0; assert.equal(await makeRpc(base + '/limited', { retryDelays: [1, 1, 1] })('eth_chainId'), '0x1'); assert.equal(calls, 3);
    calls = 0; await assert.rejects(makeRpc(base + '/limited', { retryDelays: [1] })('eth_chainId'), /rpc_method_failed: eth_chainId/); assert.equal(calls, 2);
    for (const path of ['/code-32016', '/code-32005', '/code429', '/message']) {
      calls = 0; assert.equal(await makeRpc(base + path, { retryDelays: [1, 1] })('eth_chainId'), '0x1', path); assert.equal(calls, 3, path);
    }
    calls = 0; assert.equal(await makeRpc(base + '/http429', { retryDelays: [1] })('eth_chainId'), '0x1'); assert.equal(calls, 2);
    calls = 0; await assert.rejects(makeRpc(base + '/broken', { retryDelays: [1, 1] })('eth_chainId'), error => /^rpc_method_failed: eth_chainId \(no method at \[endpoint\]\)$/.test(error.message)); assert.equal(calls, 1);
    calls = 0; await assert.rejects(makeRpc(base + '/http500', { retryDelays: [1, 1] })('eth_chainId'), /rpc_transport_failed: eth_chainId/); assert.equal(calls, 1);
    const bounded = readOnlyRpc(base + '/ok', { maximumCalls: 1 });
    assert.equal(await bounded('eth_chainId', []), '0x1');
    await assert.rejects(bounded('eth_chainId', []), /readonly_rpc_budget/);
    await assert.rejects(readOnlyRpc(base + '/ok', { seconds: 0 })('eth_chainId', []), /readonly_rpc_budget/);
    await assert.rejects(readOnlyRpc(base + '/ok')('eth_sendRawTransaction', ['0x']), /rpc_method_not_read_only/);
  } finally { server.close(); }
  // A remote node's message is never echoed; a local EVM's is, without any URL.
  const body = { error: { message: 'failed https://node.example/key' } };
  assert.equal(rpcErrorReason('https://node.example/key', body), '');
  assert.equal(rpcErrorReason('http://localhost:8545', body), ' (failed [endpoint])');
  assert.equal(rpcErrorReason('http://127.0.0.1:8545', { result: '0x1' }), '');
});

test('the local modes read only enabled chains\' committed profiles', () => {
  for (const chainId of [4663, 8453, 42161]) assert.equal(chainProfile(chainId).chainId, chainId);
  for (const chainId of [1, 31337, 99801]) assert.throws(() => chainProfile(chainId), /chain_not_enabled/);
});

describe('on a disposable EVM', () => {
  let chain, result;
  before(async () => {
    chain = await offlineChain();
    result = await deployLocal({ rpcUrl: chain.url, mode: 'offline', artifacts: compiled() });
  });
  after(async () => { await chain?.stop(); });

  test('canonical CreateX agrees with the prediction and separates a foreign salt caller', async () => {
    const other = await startAnvil();
    try {
      const rpc = other.rpc; await installCreateX(rpc);
      const deployer = roles.deployer.toLowerCase(), addresses = precomputeAddresses(deployer), guarded = addresses.guardedSalts.registry;
      const data = viem.concatHex([viem.toFunctionSelector('computeCreate3Address(bytes32)'), viem.encodeAbiParameters([{ type: 'bytes32' }], [guarded])]);
      const [onchain] = viem.decodeAbiParameters([{ type: 'address' }], await rpc('eth_call', [{ to: CREATE_X, data }, 'latest']));
      assert.equal(onchain.toLowerCase(), addresses.contracts.registry);
      const deployData = viem.encodeFunctionData({ abi: [{ type: 'function', name: 'deployCreate3', inputs: [{ type: 'bytes32' }, { type: 'bytes' }], outputs: [{ type: 'address' }], stateMutability: 'payable' }], functionName: 'deployCreate3', args: [addresses.salts.registry, '0x6001600c60003960016000f300'] });
      // A foreign caller uses CreateX's fallback namespace: it may deploy, never at the caller-protected address.
      await send(rpc, roles.guardian, CREATE_X, deployData);
      assert.equal(await rpc('eth_getCode', [addresses.contracts.registry, 'latest']), '0x');
      await send(rpc, roles.deployer, CREATE_X, deployData);
      assert.equal(await rpc('eth_getCode', [addresses.contracts.registry, 'latest']), '0x00');
      // CreateX leaves its spent CREATE3 proxy behind with this runtime.
      assert.equal(await rpc('eth_getCode', [addresses.proxies.registry, 'latest']), CREATE3_PROXY_RUNTIME);
      // Other code already at CreateX's address is never accepted, nor overwritten.
      await rpc('anvil_setCode', [CREATE_X, '0x00']);
      await assert.rejects(installCreateX(rpc), /createx_runtime_mismatch/);
      assert.equal(await rpc('eth_getCode', [CREATE_X, 'latest']), '0x00');
    } finally { await other.stop(); }
  });

  test('an offline deployment: all 13 exact runtimes, wiring, roles, receipts; labelled local-test', async () => {
    const { manifest, bundle, transactionHashes, preflight, funding } = result;
    assert.equal(manifest.status, 'verified'); assert.equal(manifest.environment, 'local-test');
    assert.equal(Object.keys(manifest.deploymentReceipts).length, 11); assert.equal(Object.keys(manifest.contracts).length, 13);
    validateManifest(manifest);
    for (const [component, address] of Object.entries(manifest.contracts)) {
      assert.equal(await chain.rpc('eth_getCode', [address, 'latest']), expectedRuntime(component, compiled(), manifest, bundle.parameters.profile));
    }
    assert.deepEqual(Object.keys(transactionHashes).sort(), [...DEPLOY_ORDER].sort());
    assert.equal(preflight.status, 'passed');
    assert.equal(preflight.governance.checked, false);
    assert.equal(funding.synthetic, true);
    for (const step of preflight.steps) assert(BigInt(step.gasLimit) >= BigInt(step.simulatedExecutionGas) * 125n / 100n);
    assert.deepEqual(await deploymentState(bundle, chain.rpc, 'latest'), Object.fromEntries(Object.keys(CONTRACT_NAMES).map(c => [c, 'deployed'])));
  });

  test('verification refuses each way a deployment can differ from its package', async () => {
    const { bundle, transactionHashes, manifest } = result, rpc = chain.rpc;
    const again = await verifyDeployment(bundle, { rpc, transactionHashes }); validateManifest(again);
    await assert.rejects(verifyDeployment(structuredClone(bundle), { rpc, transactionHashes }), /fresh_authenticated/);
    const missing = { ...transactionHashes }; delete missing.registry;
    await assert.rejects(verifyDeployment(bundle, { rpc, transactionHashes: missing }), /deployment_receipts_required/);
    await assert.rejects(verifyDeployment(bundle, { rpc, transactionHashes: { ...transactionHashes, registry: transactionHashes['zap.v4'] } }), /deployment_receipts_required/);
    await assert.rejects(verifyDeployment(bundle, { rpc, transactionHashes: { ...transactionHashes, registry: 'x' } }), /deployment_receipts_required/);
    // Verified at a block before the deployment: not final yet, never "wrong code".
    const first = Math.min(...Object.values(manifest.deploymentReceipts).map(r => r.blockNumber));
    await assert.rejects(verifyDeployment(bundle, { rpc, transactionHashes, blockTag: hex(first - 1) }), new RegExp('deployment_not_final_at_' + hex(first - 1) + ': registry'));
    const tamper = (target, change) => scripted(rpc, async (method, params) => method === target && params[0] === transactionHashes.priceAnchor ? change(await rpc(method, params)) : undefined);
    await assert.rejects(verifyDeployment(bundle, { rpc: tamper('eth_getTransactionReceipt', () => null), transactionHashes }), /deployment_receipt_missing: priceAnchor/);
    await assert.rejects(verifyDeployment(bundle, { rpc: tamper('eth_getTransactionReceipt', r => ({ ...r, status: '0x0' })), transactionHashes }), /deployment_reverted: priceAnchor/);
    await assert.rejects(verifyDeployment(bundle, { rpc: tamper('eth_getTransactionReceipt', r => ({ ...r, blockHash: '0x' + 'f'.repeat(64) })), transactionHashes }), /deployment_receipt_noncanonical: priceAnchor/);
    for (const change of [{ from: roles.guardian.toLowerCase() }, { to: PRODUCTION_DEPLOYER }, { input: bundle.steps[0].transaction.data }, { value: '0x1' }, { chainId: undefined }, { chainId: '0x1' }]) {
      await assert.rejects(verifyDeployment(bundle, { rpc: tamper('eth_getTransactionByHash', t => ({ ...t, ...change })), transactionHashes }), /deployment_transaction_mismatch: priceAnchor/);
    }
    // CreateX's events, not look-alikes from another contract.
    await assert.rejects(verifyDeployment(bundle, { rpc: tamper('eth_getTransactionReceipt', r => ({ ...r, logs: r.logs.map(log => ({ ...log, address: manifest.contracts.registry })) })), transactionHashes }), /deployment_creation_event_missing: priceAnchor/);
    // Each topic of both events: the proxy, the guarded salt and the component they name.
    const retopic = (event, index, value) => tamper('eth_getTransactionReceipt', r => ({ ...r, logs: r.logs.map(log =>
      log.topics[0] === CREATEX_EVENTS[event] ? { ...log, topics: log.topics.map((t, i) => i === index ? value : t) } : log) }));
    for (const [event, index] of [['proxy', 1], ['proxy', 2], ['creation', 1]]) {
      await assert.rejects(verifyDeployment(bundle, { rpc: retopic(event, index, '0x' + '1'.repeat(64)), transactionHashes }), /deployment_creation_event_missing: priceAnchor/);
    }
    for (const topic of Object.values(CREATEX_EVENTS)) {
      await assert.rejects(verifyDeployment(bundle, { rpc: tamper('eth_getTransactionReceipt', r => ({ ...r, logs: r.logs.filter(log => log.topics[0] !== topic) })), transactionHashes }), /deployment_creation_event_missing: priceAnchor/);
    }
    const fakeChain = scripted(rpc, method => method === 'eth_chainId' ? '0x1' : undefined);
    await assert.rejects(verifyDeployment(bundle, { rpc: fakeChain, transactionHashes }), /chain_id_mismatch/);
    const snapshot = await rpc('evm_snapshot', []);
    try {
      await rpc('anvil_setCode', [manifest.contracts['vaultExecutor.v4'], '0x00']);
      await assert.rejects(verifyDeployment(bundle, { rpc, transactionHashes }), /runtime_codehash_mismatch: vaultExecutor.v4/);
    } finally { await rpc('evm_revert', [snapshot]); }
    for (const [from, data, code] of [
      [roles.guardian, viem.concatHex([viem.toFunctionSelector('removeOperator(address)'), viem.encodeAbiParameters([{ type: 'address' }], [roles.operator])]), 'registry:isOperator'],
      [roles.governance, viem.concatHex([viem.toFunctionSelector('transferGovernance(address)'), viem.encodeAbiParameters([{ type: 'address' }], [roles.guardian])]), 'registry:pendingGovernance'],
      [roles.guardian, viem.toFunctionSelector('haltAutomation()'), 'registry:automationHalted']]) {
      const before = await rpc('evm_snapshot', []);
      try {
        await send(rpc, from, manifest.contracts.registry, data);
        await assert.rejects(verifyDeployment(bundle, { rpc, transactionHashes }), new RegExp('deployment_wiring_mismatch: ' + code));
      } finally { await rpc('evm_revert', [before]); }
    }
    const routerFloor = scripted(rpc, (method, params) => isCall(method, params, manifest.contracts.registry, 'MIN_UNIVERSAL_ROUTER_VERSION()') ? viem.encodeAbiParameters([{ type: 'uint16' }], [211]) : undefined);
    await assert.rejects(verifyDeployment(bundle, { rpc: routerFloor, transactionHashes }), /deployment_wiring_mismatch: registry:MIN_UNIVERSAL_ROUTER_VERSION/);
    // The anchor is read by tag, then re-read by number at the end: a different hash there is a reorganization.
    await rpc('evm_mine', []);
    const pinned = (await rpc('eth_getBlockByNumber', ['latest', false])).number;
    const reorg = scripted(rpc, async (method, params) => method === 'eth_getBlockByNumber' && params[0] === pinned
      ? { ...(await rpc(method, params)), hash: '0x' + 'e'.repeat(64) } : undefined);
    await assert.rejects(verifyDeployment(bundle, { rpc: reorg, transactionHashes }), /verification_anchor_reorg/);
    await verifyDeployment(bundle, { rpc, transactionHashes });
  });

  test('the local modes are labelled and cannot be swapped', async () => {
    await assert.rejects(deployLocal({ rpcUrl: chain.url, mode: 'fork', artifacts: compiled() }), /anvil_fork_required/);
    await assert.rejects(deployLocal({ rpcUrl: chain.url, mode: 'public', artifacts: compiled() }), /invalid_local_mode/);
    const fork = await startAnvil({ args: ['--fork-url', chain.url, '--no-storage-caching'] });
    try {
      await assert.rejects(deployLocal({ rpcUrl: fork.url, mode: 'offline', artifacts: compiled() }), /offline_mode_requires_a_plain_anvil/);
      // A fork of a chain that is not enabled, or one that changed its chain id, is refused.
      await assert.rejects(deployLocal({ rpcUrl: fork.url, mode: 'fork', artifacts: compiled() }), /fork_must_keep_the_real_chain_id/);
    } finally { await fork.stop(); }
    await assert.rejects(deployLocal({ rpcUrl: chain.url, mode: 'offline', productionDeployer: true, roles, artifacts: compiled() }), /production_deployer_conflicts_with_roles/);
  });

  test('local helpers: stubs only on empty addresses or their own, a revert stops the run, creations found only where they happened', async () => {
    const rpc = chain.rpc, { bundle, manifest } = result;
    await installStubs(rpc, chain.profile);
    const snapshot = await rpc('evm_snapshot', []);
    try {
      await rpc('anvil_setCode', [bundle.manifest.dependencies.v4PoolManager, '0x00']);
      await assert.rejects(installStubs(rpc, chain.profile), /offline_fixture_address_occupied/);
    } finally { await rpc('evm_revert', [snapshot]); }
    // A step whose component exists reverts in CreateX: the run stops there.
    const again = prepareDeployment({ ...bundle.parameters, steps: [...DEPLOY_ORDER], resumeOf: null,
      nonce: quantity(await rpc('eth_getTransactionCount', [manifest.roles.deployer, 'latest'])).toString() }, compiled());
    const before = await rpc('evm_snapshot', []);
    try { await assert.rejects(executeSteps(again, rpc), /local_deployment_reverted: registry/); } finally { await rpc('evm_revert', [before]); }
    const fresh = await offlineChain();
    try { await assert.rejects(creationTransactions(bundle, fresh.rpc, ['zap.v4'], 0), /creation_transaction_not_found: zap.v4/); } finally { await fresh.stop(); }
    assert.deepEqual(await creationTransactions(bundle, rpc, ['zap.v4'], 0), { 'zap.v4': result.transactionHashes['zap.v4'] });
    // A deployed component whose spent CREATE3 proxy is not CreateX's is a conflict too.
    const proxy = await rpc('evm_snapshot', []);
    try {
      await rpc('anvil_setCode', [bundle.components.registry.create3Proxy, '0x00']);
      await assert.rejects(deploymentState(bundle, rpc, 'latest'), /component_address_conflict: registry/);
    } finally { await rpc('evm_revert', [proxy]); }
  });
});

test('the owner\'s deployer impersonated offline: production addresses and domains, still local-test', async () => {
  const chain = await offlineChain({ chainId: 8453 });
  try {
    const { manifest } = await deployLocal({ rpcUrl: chain.url, mode: 'offline', productionDeployer: true, artifacts: compiled() });
    assert.deepEqual(manifest.contracts, PRODUCTION_ADDRESSES);
    assert.equal(manifest.roles.deployer, PRODUCTION_DEPLOYER);
    assert.equal(manifest.environment, 'local-test');
    assert.equal(manifest.chain.chainId, 8453);
  } finally { await chain.stop(); }
});

test('fork mode end to end on a fork that keeps its chain id: labelled fork-rehearsal, production addresses, resumed from the fork', async () => {
  const origin = await offlineChain({ chainId: 8453 });
  const fork = await startAnvil({ args: ['--fork-url', origin.url, '--no-storage-caching'] });
  try {
    const artifacts = compiled(), options = { rpcUrl: fork.url, mode: 'fork', forkProfile: origin.profile, productionDeployer: true, artifacts };
    // An interrupted earlier run on the fork: three steps sent from the impersonated owner's deployer.
    const planned = await planDeployment({ profile: origin.profile, roles: localRoles({ productionDeployer: true }), environment: 'fork-rehearsal',
      releaseTag: 'v2-local', artifacts, rpc: fork.rpc, simulate: simulateGas });
    await fork.rpc('anvil_setBalance', [PRODUCTION_DEPLOYER, hex(10n ** 21n)]);
    const earlier = await executeSteps(planned.bundle, fork.rpc, { limit: 3 });
    const { manifest, resumed, transactionHashes } = await deployLocal(options);
    assert.deepEqual([manifest.environment, manifest.chain.chainId, manifest.contracts], ['fork-rehearsal', 8453, PRODUCTION_ADDRESSES]);
    assert.deepEqual(resumed, DEPLOY_ORDER.slice(0, 3));
    for (const [component, hash] of Object.entries(earlier)) assert.equal(transactionHashes[component], hash);
    validateManifest(manifest);
    await assert.rejects(deployLocal({ ...options, forkProfile: { ...origin.profile, chainId: 4663 } }), /fork_profile_chain_mismatch/);
  } finally { await fork.stop(); await origin.stop(); }
});

test('the compile records whether the V2 sources or the tool have uncommitted changes', () => {
  const probes = [join(repoRoot, 'contracts/src/v2/.provenance-probe'), join(repoRoot, 'scripts/v2/.provenance-probe')];
  const cache = process.env.DOMINO_V2_COMPILE_CACHE ?? join(repoRoot, 'contracts/cache/v2-deploy-tests');
  const flags = () => { const { sourceState } = compileV2({ cacheDirectory: cache }); return [sourceState.workingTreeSourceChanges, sourceState.workingTreeToolChanges]; };
  const clean = flags();
  try {
    writeFileSync(probes[1], 'probe\n');
    assert.deepEqual(flags(), [clean[0], true]);
    writeFileSync(probes[0], 'probe\n');
    assert.deepEqual(flags(), [true, true]);
  } finally { for (const probe of probes) rmSync(probe, { force: true }); }
  assert.deepEqual(flags(), clean);
});

test('an interrupted deployment resumes: deployed components proven by code hash, the rest re-signed from the current nonce', async () => {
  const chain = await offlineChain();
  try {
    const rpc = chain.rpc, artifacts = compiled(), deployer = roles.deployer.toLowerCase();
    const plan = options => planDeployment({ profile: chain.profile, roles, environment: 'local-test', releaseTag: 'v2-test', artifacts, rpc, simulate: simulateGas, ...options });
    const planned = await plan();
    await rpc('anvil_setBalance', [deployer, hex(10n ** 21n)]);
    const first = await executeSteps(planned.bundle, rpc, { limit: 4 });
    await assert.rejects(preflightDeployment(planned.bundle, { rpc, simulatedGas: planned.simulatedGas }), /deployer_nonce_mismatch/);
    await assert.rejects(plan(), /deployment_already_started_use_resume/);
    // A transaction still pending from the deployer could double-spend a step: nothing resumes then.
    await rpc('evm_setAutomine', [false]);
    await rpc('anvil_impersonateAccount', [deployer]);
    const stray = await rpc('eth_sendTransaction', [{ from: deployer, to: deployer, value: '0x0', gas: '0x5208' }]);
    await assert.rejects(plan({ resumeFrom: planned.bundle }), /deployer_has_pending_transactions/);
    await rpc('evm_setAutomine', [true]); await rpc('evm_mine', []);
    assert.equal((await rpc('eth_getTransactionReceipt', [stray])).status, '0x1');
    const resumed = await plan({ resumeFrom: planned.bundle });
    const bundle = resumed.bundle;
    assert.deepEqual(bundle.parameters.steps, DEPLOY_ORDER.slice(4));
    assert.equal(bundle.parameters.nonce, String(Number(planned.bundle.parameters.nonce) + 5));
    assert.equal(bundle.parameters.resumeOf, packageDigest(planned.bundle));
    assert.deepEqual(bundle.components, planned.bundle.components);
    for (const step of bundle.steps) assert.equal(step.transaction.data, planned.bundle.steps.find(s => s.component === step.component).transaction.data);
    const report = await preflightDeployment(bundle, { rpc, simulatedGas: resumed.simulatedGas });
    assert.deepEqual(Object.entries(report.components).filter(([, v]) => v === 'deployed').map(([k]) => k), DEPLOY_ORDER.slice(0, 4));
    const rest = await executeSteps(bundle, rpc);
    for (const used of [planned.bundle, bundle]) validateManifest(await verifyDeployment(used, { rpc, transactionHashes: { ...first, ...rest } }));
    await assert.rejects(plan({ resumeFrom: bundle }), /nothing_to_resume/);
  } finally { await chain.stop(); }
});

test('deploy-local resumes its own interrupted run and finds the earlier creations', async () => {
  const chain = await offlineChain();
  const directory = mkdtempSync(join(tmpdir(), 'domino-v2-local-'));
  try {
    const rpc = chain.rpc, artifacts = compiled();
    const planned = await planDeployment({ profile: chain.profile, roles, environment: 'local-test', releaseTag: 'v2-local', artifacts, rpc, simulate: simulateGas });
    await rpc('anvil_setBalance', [roles.deployer, hex(10n ** 21n)]);
    const earlier = await executeSteps(planned.bundle, rpc, { limit: 3 });
    const out = join(directory, 'deployment.json');
    const result = await deployLocal({ rpcUrl: chain.url, mode: 'offline', artifacts, out });
    assert.deepEqual(result.resumed, DEPLOY_ORDER.slice(0, 3));
    for (const [component, hash] of Object.entries(earlier)) assert.equal(result.transactionHashes[component], hash);
    assert.deepEqual(readJson(out), result.manifest);
    for (const suffix of ['.unsigned.json', '.receipts.json', '.preflight.json']) assert(existsSync(out + suffix));
    await assert.rejects(deployLocal({ rpcUrl: chain.url, mode: 'offline', artifacts, out }), /output_exists/);
    // Fully deployed: nothing left to send, the run only verifies.
    const again = await deployLocal({ rpcUrl: chain.url, mode: 'offline', artifacts });
    assert.equal(again.preflight, null);
    assert.deepEqual(again.transactionHashes, result.transactionHashes);
  } finally { await chain.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('a full package replays all eleven steps for the gas simulation, whatever subset it sends', () => {
  const artifacts = compiled(), base = parametersFor(syntheticProfile());
  const subset = prepareDeployment({ ...base, steps: ['zap.v4'], resumeOf: 'b'.repeat(64), gasLimits: { 'zap.v4': '6000000' } }, artifacts);
  const full = fullPackage(subset, artifacts);
  assert.deepEqual(full.steps.map(s => s.component), DEPLOY_ORDER);
  assert.equal(full.parameters.resumeOf, null);
  assert.deepEqual(full.components, subset.components);
  assert.throws(() => fullPackage(structuredClone(subset), artifacts), /fresh_authenticated/);
});
