// The frozen V2 release on a public testnet (launch round P3, item 7, 4 Nov 2026): deploy-testnet.mjs drives deploy.mjs's
// own functions, unchanged, for Base Sepolia and Arbitrum Sepolia only, and puts back what a public package proves. Offline:
// an Anvil at Base Sepolia's chain id, canonical CreateX, synthetic dependency stubs and a real Safe as governance; the
// steps signed with the deployer's own key and sent raw, as a person sends them on the testnet.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot, readJson, viem, quantity, ENABLED_CHAINS, PRODUCTION_DEPLOYER, ROLE_NAMES, prepareDeployment,
  checkSignedTransactions, verifyDeployment } from './deploy.mjs';
import { localRoles, waitReceipt } from './deploy-anvil.mjs';
import { validateManifest } from './deploy-schema.mjs';
import { compiled, checksummed, hex, offlineChain, parametersFor, installSafe } from './deploy-test-support.mjs';
import { TESTNETS, TESTNET_ENVIRONMENT, PUBLIC_TEST_ACCOUNTS_FILE, REHEARSAL_SAFE_OWNERS, checkTestnetProfile, checkTestnetRoles,
  checkTestnetProvenance, checkTestnetGovernance, productionRoles, refusedTestnetRoles, testnetPackage, testnetProfilePath,
  prepareTestnet, preflightTestnet, cli } from './deploy-testnet.mjs';

const { privateKeyToAccount } = createRequire(join(repoRoot, 'app/package.json'))('viem/accounts');
/** Fresh keys of this test only: none is a public mnemonic, rehearsal or production key. */
const account = label => privateKeyToAccount(viem.keccak256(viem.toHex('domino.v2.testnet-test.' + label)));
const accounts = Object.fromEntries(ROLE_NAMES.map(name => [name, account(name)]));
const freshRoles = Object.fromEntries(ROLE_NAMES.map(name => [name, accounts[name].address]));
const shared = readJson(join(repoRoot, PUBLIC_TEST_ACCOUNTS_FILE)).addresses;
const mainnet = slug => readJson(join(repoRoot, 'api-contracts/v2/chains', slug + '.json'));
const noProvenance = () => {};
/** The committed production roles a testnet must never take (review L4), as the manifests state them. */
const PRODUCTION_ROLES = [['V2 governance Safe', '0x2b1d4098ec880058886b95a0e75069a7099c5a9d'],
  ['V2 operator', '0x64b72517d8b0d72be25f814b4e03985cf15e098a'], ['V2 publisher', '0x07c7e7f92e2c76c9cb8d7f2ae44caa6877fc7df3'],
  ['guardian', '0x5e57fded90c4635648eb7b3ba29705ff0769d103'], ['fee recipient', '0x1488c84dafc03f7f4c4fb986f83ba99fd530c6f4'],
  ['V1 operator', '0x2320ea29fcf7b827e1a4039ed46244be4d4b29da'], ['V1 price publisher', '0x4d6f91d3101569bb8c710bc332f621600e429e7b']];

test('the testnets are Base Sepolia and Arbitrum Sepolia, and never a production chain', () => {
  assert.deepEqual(Object.keys(TESTNETS), ['84532', '421614']);
  assert.deepEqual({ ...TESTNETS[84532] }, { slug: 'base-sepolia', name: 'Base Sepolia', stack: 'op-stack' });
  assert.deepEqual({ ...TESTNETS[421614] }, { slug: 'arbitrum-sepolia', name: 'Arbitrum Sepolia', stack: 'arbitrum-nitro' });
  assert.ok(ENABLED_CHAINS.every(chainId => !Object.hasOwn(TESTNETS, chainId)));
  assert.equal(TESTNET_ENVIRONMENT, 'local-test');
  assert.equal(testnetProfilePath(84532), 'api-contracts/v2/testnets/base-sepolia-84532.json');
  assert.equal(testnetProfilePath(421614), 'api-contracts/v2/testnets/arbitrum-sepolia-421614.json');
});

test('a profile is a testnet\'s own: no production chain, other slug, stack, state or chain id spelling', () => {
  const base = { ...mainnet('base-8453'), chainId: 84532, slug: 'base-sepolia', name: 'Base Sepolia' };
  const arbitrum = { ...mainnet('arbitrum-42161'), chainId: 421614, slug: 'arbitrum-sepolia', name: 'Arbitrum Sepolia' };
  assert.equal(checkTestnetProfile(base), base);
  assert.equal(checkTestnetProfile(arbitrum), arbitrum);
  for (const slug of ['robinhood-4663', 'base-8453', 'arbitrum-42161']) assert.throws(() => checkTestnetProfile(mainnet(slug)), /^Error: not_a_testnet_profile$/);
  for (const profile of [{ ...base, chainId: 11155111 }, { ...base, chainId: '84532' }, { ...base, chainId: 84532.5 }, null, 84532]) {
    assert.throws(() => checkTestnetProfile(profile), /^Error: not_a_testnet_profile$/, JSON.stringify(profile));
  }
  for (const profile of [{ ...base, slug: 'base' }, { ...base, slug: 'arbitrum-sepolia' }, { ...base, stack: 'arbitrum-nitro' },
    { ...arbitrum, stack: 'op-stack' }, { ...base, enabled: false }, { ...base, enabled: 'true' }]) {
    assert.throws(() => checkTestnetProfile(profile), /^Error: testnet_profile_mismatch$/);
  }
});

test('no role is a key anyone holds, nor the owner\'s production deployer', () => {
  assert.deepEqual(checkTestnetRoles(freshRoles), Object.fromEntries(ROLE_NAMES.map(name => [name, freshRoles[name].toLowerCase()])));
  const refused = refusedTestnetRoles();
  // Changed on purpose 2026-11-04 (review L4): the rehearsal Safe owners and every production role are refused too.
  assert.equal(refused.size, 100 + ROLE_NAMES.length + REHEARSAL_SAFE_OWNERS.length + productionRoles().size);
  assert.ok(productionRoles().has(PRODUCTION_DEPLOYER));
  // The mnemonic's first ten are refused by deploy.mjs's own rule for a public package, which runs first.
  for (const name of ['deployer', 'operator']) {
    assert.throws(() => checkTestnetRoles({ ...freshRoles, [name]: viem.getAddress(shared[0]) }), /^Error: public_test_key_as_production_role$/);
  }
  for (const [label, address] of [['mnemonic 10', shared[10]], ['mnemonic 99', shared[99]],
    ['rehearsal operator', localRoles().operator], ['rehearsal Safe owner', REHEARSAL_SAFE_OWNERS[0]],
    ['production deployer', PRODUCTION_DEPLOYER], ...PRODUCTION_ROLES]) {
    for (const name of ['deployer', 'governance', 'publisher']) {
      assert.throws(() => checkTestnetRoles({ ...freshRoles, [name]: viem.getAddress(address) }),
        new RegExp(`^Error: public_or_production_key_as_testnet_role: ${name}$`), `${label} as ${name}`);
    }
  }
  // deploy.mjs's own rules first: six checksummed roles.
  assert.throws(() => checkTestnetRoles({ ...freshRoles, guardian: freshRoles.guardian.toLowerCase() }), /role_address_not_checksummed/);
  const root = mkdtempSync(join(tmpdir(), 'domino-testnet-accounts-'));
  try {
    mkdirSync(join(root, 'api-contracts/v2'), { recursive: true });
    writeFileSync(join(root, PUBLIC_TEST_ACCOUNTS_FILE), JSON.stringify({ addresses: shared.slice(0, 99) }));
    assert.throws(() => refusedTestnetRoles(root), /^Error: public_test_accounts_unreadable$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('production roles come from the committed production manifests only, whole or not at all', () => {
  const roles = productionRoles();
  for (const [, address] of PRODUCTION_ROLES) assert.ok(roles.has(address), address);
  const root = mkdtempSync(join(tmpdir(), 'domino-testnet-deployments-'));
  const write = (name, manifest) => {
    mkdirSync(join(root, 'docs/deployments', name), { recursive: true });
    writeFileSync(join(root, 'docs/deployments', name, 'deployment.json'), JSON.stringify(manifest));
  };
  try {
    mkdirSync(join(root, 'docs/deployments'), { recursive: true });
    assert.throws(() => productionRoles(root), /^Error: production_deployments_unreadable$/);
    // A rehearsal's or a local test's roles are not production's, nor is a manifest of another kind.
    write('rehearsal', { kind: 'domino-v2-deployment', environment: 'fork-rehearsal', roles: { operator: '0x' + '1'.repeat(40) } });
    write('other', { kind: 'something-else', roles: { operator: '0x' + '2'.repeat(40) } });
    assert.throws(() => productionRoles(root), /^Error: production_deployments_unreadable$/);
    write('v2', { kind: 'domino-v2-deployment', environment: 'public-chain-preparation', roles: { deployer: PRODUCTION_DEPLOYER,
      operator: '0x' + 'AB'.repeat(20) } });
    assert.deepEqual([...productionRoles(root)].sort(), [PRODUCTION_DEPLOYER, '0x' + 'ab'.repeat(20)].sort());
    write('v1', { kind: 'domino-public-mainnet-deployment', roles: { pricePublisher: '0x' + 'cd'.repeat(20) } });
    assert.ok(productionRoles(root).has('0x' + 'cd'.repeat(20)));
    write('broken', { kind: 'domino-public-mainnet-deployment', roles: { operator: 'not an address' } });
    assert.throws(() => productionRoles(root), /^Error: production_deployment_roles_unreadable$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the governance Safe must have been checked, and none of its owners is a public or production key', () => {
  const fresh = [account('owner-1').address, account('owner-2').address].map(a => a.toLowerCase());
  const report = { governance: { checked: true, owners: fresh } };
  assert.equal(checkTestnetGovernance(report), report);
  for (const owner of [shared[0], shared[77], REHEARSAL_SAFE_OWNERS[1], PRODUCTION_DEPLOYER, ...PRODUCTION_ROLES.map(([, a]) => a)]) {
    assert.throws(() => checkTestnetGovernance({ governance: { checked: true, owners: [fresh[0], viem.getAddress(owner)] } }),
      /^Error: public_or_production_key_as_testnet_governance_owner$/, owner);
  }
  for (const governance of [{ checked: false, reason: 'safe_governance_required_only_for_public_preparation' }, { checked: true }, undefined]) {
    assert.throws(() => checkTestnetGovernance({ governance }), /^Error: testnet_governance_not_checked$/);
  }
});

test('provenance: this checkout, clean, its committed testnet profile, then the reviewed release manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'domino-testnet-provenance-'));
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' });
  try {
    const profile = { ...mainnet('base-8453'), chainId: 84532, slug: 'base-sepolia', name: 'Base Sepolia' };
    git('init', '-q');
    mkdirSync(join(root, 'api-contracts/v2/testnets'), { recursive: true });
    writeFileSync(join(root, testnetProfilePath(84532)), JSON.stringify(profile, null, 2));
    git('add', '.'); git('commit', '-q', '-m', 'profile');
    const artifacts = { sourceRoot: root, sourceCommit: git('rev-parse', 'HEAD').trim(),
      sourceState: { workingTreeSourceChanges: false, workingTreeToolChanges: false } };
    // The committed profile passes, and the release manifest is next: this scratch repository has none.
    assert.throws(() => checkTestnetProvenance({ artifacts, profile }, root), /^Error: release_manifest_not_committed$/);
    assert.throws(() => checkTestnetProvenance({ artifacts, profile: { ...profile, blockTimeSeconds: 1 } }, root),
      /^Error: testnet_profile_not_the_committed_one$/);
    assert.throws(() => checkTestnetProvenance({ artifacts, profile: { ...mainnet('arbitrum-42161'), chainId: 421614,
      slug: 'arbitrum-sepolia' } }, root), /^Error: testnet_profile_not_committed$/);
    assert.throws(() => checkTestnetProvenance({ artifacts, profile }), /^Error: testnet_preparation_requires_the_tool_checkout$/);
    for (const state of [{ workingTreeSourceChanges: true, workingTreeToolChanges: false }, { workingTreeSourceChanges: false, workingTreeToolChanges: true }]) {
      assert.throws(() => checkTestnetProvenance({ artifacts: { ...artifacts, sourceState: state }, profile }, root),
        /^Error: uncommitted_changes_refused_for_testnet_preparation$/);
    }
    assert.throws(() => checkTestnetProvenance({ artifacts, profile: mainnet('base-8453') }, root), /^Error: not_a_testnet_profile$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the command refuses an unknown command or missing argument before it reads or compiles anything', async () => {
  await assert.rejects(cli(['deploy']), /^Error: command_required/);
  await assert.rejects(cli(['prepare', '--chain-profile', 'profile.json']), /^Error: unknown_or_missing_cli_argument$/);
  await assert.rejects(cli(['verify', '--package', 'p', '--receipts', 'r', '--out', 'o', '--signed', 's']), /^Error: unknown_or_missing_cli_argument$/);
});

describe('a testnet deployment, offline at Base Sepolia\'s chain id', () => {
  let chain, rpc, profile, roles;
  const isolated = async body => {
    const id = await rpc('evm_snapshot', []);
    try { return await body(); } finally { await rpc('anvil_dropAllTransactions', []); await rpc('evm_revert', [id]); }
  };
  before(async () => {
    chain = await offlineChain({ chainId: 84532 }); rpc = chain.rpc;
    profile = { ...chain.profile, slug: 'base-sepolia', name: 'Base Sepolia (offline fixture)' };
    roles = { ...freshRoles, governance: await installSafe(rpc, { address: checksummed('testnet-governance-safe'),
      owners: [1, 2, 3].map(i => account('safe-owner-' + i).address) }) };
    await rpc('anvil_setBalance', [freshRoles.deployer, hex(10n ** 21n)]);
  });
  after(async () => { await chain?.stop(); });

  test('prepares, is signed by the deployer, sent raw one at a time, and verifies as local-test on 84532', () => isolated(async () => {
    const { bundle, report } = await prepareTestnet({ profile, roles, releaseTag: 'v2-testnet-test', artifacts: compiled(), rpc, provenance: noProvenance });
    assert.equal(bundle.parameters.environment, 'local-test');
    assert.equal(bundle.manifest.chain.chainId, 84532);
    assert.equal(bundle.steps.length, 11);
    assert.equal(report.status, 'passed');
    assert.equal(report.governance.checked, true);
    // The preflight `preflight` runs again before signing passes too, with a fresh simulation.
    assert.equal((await preflightTestnet(bundle, { rpc, artifacts: compiled() })).status, 'passed');
    // A supplied copy of the package is this one, rebuilt byte for byte.
    assert.equal(testnetPackage(JSON.parse(JSON.stringify(bundle)), compiled()).manifest.contracts.registry, bundle.manifest.contracts.registry);
    const deployer = accounts.deployer, raws = [];
    for (const step of bundle.steps) {
      const t = step.transaction;
      raws.push(await deployer.signTransaction({ type: 'eip1559', chainId: Number(quantity(t.chainId)), nonce: Number(quantity(t.nonce)),
        to: t.to, data: t.data, gas: quantity(t.gas), value: 0n, maxFeePerGas: quantity(t.maxFeePerGas),
        maxPriorityFeePerGas: quantity(t.maxPriorityFeePerGas), accessList: [] }));
    }
    assert.equal((await checkSignedTransactions(bundle, raws)).length, 11);
    const transactionHashes = {};
    for (const [index, raw] of raws.entries()) {
      const hash = await rpc('eth_sendRawTransaction', [raw]);
      assert.equal(quantity((await waitReceipt(rpc, hash)).status), 1n);
      transactionHashes[bundle.steps[index].component] = hash;
    }
    const verified = await verifyDeployment(bundle, { rpc, transactionHashes, blockTag: 'latest' });
    validateManifest(verified);
    assert.equal(verified.status, 'verified');
    assert.equal(verified.environment, 'local-test', 'never taken for a production deployment');
    assert.equal(verified.chain.chainId, 84532);
  }));

  test('refuses before planning: another chain, a public key as a role, an uncommitted profile, governance that is no Safe', () => isolated(async () => {
    const prepare = (changes) => prepareTestnet({ profile, roles, releaseTag: 'v2-testnet-test', artifacts: compiled(), rpc, provenance: noProvenance, ...changes });
    await assert.rejects(prepare({ profile: { ...profile, chainId: 8453, slug: 'base' } }), /^Error: not_a_testnet_profile$/);
    await assert.rejects(prepare({ roles: { ...roles, operator: localRoles().operator } }), /^Error: public_or_production_key_as_testnet_role: operator$/);
    await assert.rejects(prepare({ roles: { ...roles, deployer: viem.getAddress(shared[42]) } }), /^Error: public_or_production_key_as_testnet_role: deployer$/);
    // The real provenance: this offline profile is committed nowhere (and a dirty checkout is refused first).
    await assert.rejects(prepare({ provenance: undefined }), /^Error: (uncommitted_changes_refused_for_testnet_preparation|testnet_profile_not_committed)$/);
    await assert.rejects(prepare({ roles: { ...roles, governance: checksummed('testnet-governance-eoa') } }), /governance_has_no_code/);
    // Review L4: a Safe whose owners include a production role, or the harness's own public rehearsal owners.
    for (const owners of [[account('safe-owner-1').address, viem.getAddress('0x64b72517d8b0d72be25f814b4e03985cf15e098a')], undefined]) {
      const safe = await installSafe(rpc, { address: checksummed('testnet-safe-' + (owners ? 'production' : 'rehearsal')), ...(owners ? { owners } : {}) });
      await assert.rejects(prepare({ roles: { ...roles, governance: safe } }), /^Error: public_or_production_key_as_testnet_governance_owner$/);
    }
  }));

  test('a supplied package must be a testnet\'s, with roles no one else holds', () => {
    const rehearsal = prepareDeployment(parametersFor(profile, { roles: localRoles() }), compiled());
    assert.throws(() => testnetPackage(JSON.parse(JSON.stringify(rehearsal)), compiled()), /^Error: public_or_production_key_as_testnet_role: deployer$/);
    const local = prepareDeployment(parametersFor({ ...profile, slug: 'local' }, { roles: freshRoles }), compiled());
    assert.throws(() => testnetPackage(JSON.parse(JSON.stringify(local)), compiled()), /^Error: testnet_profile_mismatch$/);
    const fine = prepareDeployment(parametersFor(profile, { roles: freshRoles }), compiled());
    assert.equal(testnetPackage(JSON.parse(JSON.stringify(fine)), compiled()).parameters.profile.chainId, 84532);
  });
});
