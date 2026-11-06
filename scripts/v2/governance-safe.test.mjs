// governance-safe.mjs on a plain Anvil that holds Safe 1.3.0's real runtimes (deploy-fixtures/safe-1.3.0-runtime.json):
// the plan's address is the one the factory creates, deploy.mjs's governance check accepts that Safe, and two of its
// owners can execute through it. Run: node --test scripts/v2/governance-safe.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot, viem, SAFE_SINGLETONS } from './deploy.mjs';
import { SAFE_PROXY_FACTORIES } from './qualify-chain.mjs';
import { startAnvil, waitReceipt } from './deploy-anvil.mjs';
import { SAFE_130_DEPLOYMENTS, SAFE_130_FALLBACK_HANDLER_CODE_HASH, checkGovernanceSafe, checkedOwners, cli, ownersFrom, planGovernanceSafe,
  readsOnly } from './governance-safe.mjs';

const FIXTURE = JSON.parse(readFileSync(join(repoRoot, 'scripts/v2/deploy-fixtures/safe-1.3.0-runtime.json'), 'utf8'));
const PREFLIGHT = 'docs/deployments/v2-robinhood-4663-2026-10-04/preflight.json';
// The production Safe's owners as its Robinhood preflight recorded them (4 Oct 2026): deployer, guardian, owner.
const PRODUCTION_OWNERS = ['0x706627e3e75b0603c4b6f9a1ebbfc635da712747', '0x5e57fded90c4635648eb7b3ba29705ff0769d103',
  '0x19ea136f23151d681da6d20a7a39d36e784ea792'];
const CHAIN = 31337;
let anvil, accounts;

before(async () => {
  anvil = await startAnvil();
  accounts = (await anvil.rpc('eth_accounts', [])).map(a => a.toLowerCase());
});
after(async () => { await anvil?.stop(); });

async function install(variant, parts = ['singletonL2', 'factory', 'fallbackHandler']) {
  const set = SAFE_130_DEPLOYMENTS[variant];
  const at = { singletonL2: set.singleton, factory: set.factory, fallbackHandler: set.fallbackHandler };
  for (const part of parts) await anvil.rpc('anvil_setCode', [at[part], FIXTURE[part].runtime]);
}
async function clear() {
  for (const set of Object.values(SAFE_130_DEPLOYMENTS)) for (const a of [set.singleton, set.factory, set.fallbackHandler]) await anvil.rpc('anvil_setCode', [a, '0x']);
}
const reads = () => readsOnly(anvil.rpc);
let nonce = 100n;
const fresh = () => nonce++; // a salt nonce per test: one Anvil, one Safe per plan

async function send(transaction, from = accounts[9]) {
  const hash = await anvil.rpc('eth_sendTransaction', [{ from, to: transaction.to, data: transaction.data, value: transaction.value, gas: transaction.gas }]);
  const receipt = await waitReceipt(anvil.rpc, hash);
  assert.equal(receipt.status, '0x1');
  return receipt;
}

test('the fixture is Safe 1.3.0 as safe-deployments records it, at both published address sets', () => {
  assert.equal(viem.keccak256(FIXTURE.singletonL2.runtime), SAFE_SINGLETONS[SAFE_130_DEPLOYMENTS.canonical.singleton].codehash);
  assert.equal(viem.keccak256(FIXTURE.factory.runtime), SAFE_PROXY_FACTORIES[SAFE_130_DEPLOYMENTS.canonical.factory].codehash);
  assert.equal(viem.keccak256(FIXTURE.fallbackHandler.runtime), SAFE_130_FALLBACK_HANDLER_CODE_HASH);
  for (const set of Object.values(SAFE_130_DEPLOYMENTS)) {
    assert.deepEqual([SAFE_SINGLETONS[set.singleton].version, SAFE_SINGLETONS[set.singleton].l2, SAFE_PROXY_FACTORIES[set.factory].version], ['1.3.0', true, '1.3.0']);
  }
  assert.equal(FIXTURE.license, 'LGPL-3.0-only');
});

test('the plan names the Safe the factory creates; deploy.mjs\'s check accepts it; a second plan finds it', async () => {
  await clear(); await install('canonical');
  const saltNonce = fresh();
  const plan = await planGovernanceSafe({ rpc: reads(), chainId: CHAIN, owners: PRODUCTION_OWNERS, threshold: 2, saltNonce });
  assert.equal(plan.status, 'to_create');
  assert.deepEqual({ ...plan.safe, address: undefined }, { address: undefined, version: '1.3.0', l2: true, deployment: 'canonical',
    singleton: SAFE_130_DEPLOYMENTS.canonical.singleton, factory: SAFE_130_DEPLOYMENTS.canonical.factory,
    fallbackHandler: SAFE_130_DEPLOYMENTS.canonical.fallbackHandler, owners: PRODUCTION_OWNERS, threshold: 2, saltNonce: saltNonce.toString() });
  assert.equal(plan.transaction.to, SAFE_130_DEPLOYMENTS.canonical.factory);
  assert.equal(plan.transaction.value, '0x0');
  assert.ok(BigInt(plan.transaction.gas) > BigInt(plan.transaction.estimatedGas));
  assert.equal(await anvil.rpc('eth_getCode', [plan.safe.address, 'latest']), '0x');

  const receipt = await send(plan.transaction); // any funded account: not an owner
  const check = await checkGovernanceSafe({ rpc: reads(), chainId: CHAIN, address: plan.safe.address, owners: PRODUCTION_OWNERS, threshold: 2,
    block: BigInt(receipt.blockNumber) });
  assert.equal(check.status, 'passed');
  assert.equal(check.block.number, BigInt(receipt.blockNumber).toString());
  assert.deepEqual([check.inspection.version, check.inspection.l2, check.inspection.threshold, check.inspection.owners, check.inspection.singleton,
    check.inspection.fallbackHandler, check.inspection.proxyVersion], ['1.3.0', true, 2, PRODUCTION_OWNERS, SAFE_130_DEPLOYMENTS.canonical.singleton,
    SAFE_130_DEPLOYMENTS.canonical.fallbackHandler, '1.3.0']);
  // The owners' order is what was asked: getOwners returns them as setup took them.
  const again = await planGovernanceSafe({ rpc: reads(), chainId: CHAIN, owners: PRODUCTION_OWNERS, threshold: 2, saltNonce });
  assert.equal(again.status, 'exists');
  assert.equal(again.transaction, null);
  assert.equal(again.safe.address, plan.safe.address);
  assert.equal(again.check.status, 'passed');
});

const EXEC_ABI = [{ type: 'function', name: 'execTransaction', stateMutability: 'payable', outputs: [{ type: 'bool' }], inputs: [
  { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' },
  { type: 'address' }, { type: 'bytes' }] }];
const EXECUTION_SUCCESS = viem.keccak256(viem.toHex('ExecutionSuccess(bytes32,uint256)'));

/** A Safe 1.3.0 transaction (domain: chain id and the Safe) signed by `signers` through Anvil, sent by a non-owner. */
async function execute(safe, signers, { to, data, nonce }) {
  const tx = { to, value: 0n, data, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: '0x' + '0'.repeat(40),
    refundReceiver: '0x' + '0'.repeat(40), nonce };
  const typed = { domain: { chainId: CHAIN, verifyingContract: viem.getAddress(safe) }, primaryType: 'SafeTx',
    types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      SafeTx: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
        { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' }, { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' },
        { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' }] },
    message: Object.fromEntries(Object.entries(tx).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])) };
  const sorted = [...signers].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  const signatures = viem.concatHex(await Promise.all(sorted.map(o => anvil.rpc('eth_signTypedData_v4', [o, JSON.stringify(typed)]))));
  const receipt = await send({ to: safe, value: '0x0', gas: '0x100000', data: viem.encodeFunctionData({ abi: EXEC_ABI, functionName: 'execTransaction',
    args: [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, signatures] }) });
  assert.ok(receipt.logs.some(l => l.address.toLowerCase() === safe && l.topics[0] === EXECUTION_SUCCESS));
  return receipt;
}

test('two of its owners execute through the Safe it creates', async () => {
  await clear(); await install('canonical');
  const owners = accounts.slice(0, 3);
  const plan = await planGovernanceSafe({ rpc: reads(), chainId: CHAIN, owners, threshold: 2, saltNonce: fresh() });
  await send(plan.transaction);
  await execute(plan.safe.address, [owners[2], owners[0]], { to: '0x00000000000000000000000000000000000d0e11', data: '0x1234', nonce: 0n });
});

test('a Safe at the planned address whose owners changed it since is refused, not reported as the one asked for', async () => {
  // CREATE2 commits to the creation's owners and threshold, not to today's: the case of recreating a Safe elsewhere.
  await clear(); await install('canonical');
  const owners = accounts.slice(0, 3), saltNonce = fresh();
  const plan = await planGovernanceSafe({ rpc: reads(), chainId: CHAIN, owners, threshold: 2, saltNonce });
  await send(plan.transaction);
  const changeThreshold = viem.encodeFunctionData({ abi: [{ type: 'function', name: 'changeThreshold', stateMutability: 'nonpayable', outputs: [],
    inputs: [{ type: 'uint256' }] }], functionName: 'changeThreshold', args: [3n] });
  await execute(plan.safe.address, owners.slice(0, 2), { to: plan.safe.address, data: changeThreshold, nonce: 0n });
  await assert.rejects(planGovernanceSafe({ rpc: reads(), chainId: CHAIN, owners, threshold: 2, saltNonce }), /governance_threshold_mismatch/);
  // Code that is not a Safe at that address is refused too.
  const other = await planGovernanceSafe({ rpc: reads(), chainId: CHAIN, owners, threshold: 2, saltNonce: fresh() });
  await anvil.rpc('anvil_setCode', [other.safe.address, '0x6000']);
  await assert.rejects(planGovernanceSafe({ rpc: reads(), chainId: CHAIN, owners, threshold: 2, saltNonce: BigInt(other.safe.saltNonce) }),
    /governance_not_a_safe_proxy/);
});

test('the eip155 addresses serve when the canonical ones are absent', async () => {
  await clear(); await install('eip155');
  const plan = await planGovernanceSafe({ rpc: reads(), chainId: CHAIN, owners: PRODUCTION_OWNERS, threshold: 2, saltNonce: fresh() });
  assert.equal(plan.safe.deployment, 'eip155');
  assert.deepEqual([plan.safe.singleton, plan.transaction.to, plan.safe.fallbackHandler],
    [SAFE_130_DEPLOYMENTS.eip155.singleton, SAFE_130_DEPLOYMENTS.eip155.factory, SAFE_130_DEPLOYMENTS.eip155.fallbackHandler]);
  const receipt = await send(plan.transaction);
  const check = await checkGovernanceSafe({ rpc: reads(), chainId: CHAIN, address: plan.safe.address, owners: PRODUCTION_OWNERS, threshold: 2,
    block: BigInt(receipt.blockNumber) });
  assert.equal(check.inspection.singleton, SAFE_130_DEPLOYMENTS.eip155.singleton);
});

test('a chain without a complete Safe 1.3.0 is refused, whichever part is missing or different', async () => {
  const plan = () => planGovernanceSafe({ rpc: reads(), chainId: CHAIN, owners: PRODUCTION_OWNERS, threshold: 2, saltNonce: fresh() });
  await clear();
  await assert.rejects(plan(), /^Error: safe_130_not_on_chain: canonical lacks singleton, factory, fallbackHandler; eip155 lacks singleton, factory, fallbackHandler/);
  for (const part of ['singletonL2', 'factory', 'fallbackHandler']) {
    await clear(); await install('canonical', ['singletonL2', 'factory', 'fallbackHandler'].filter(p => p !== part));
    await assert.rejects(plan(), /safe_130_not_on_chain: canonical lacks/, part);
  }
  // Other code at the singleton's address: the factory's.
  await clear(); await install('canonical');
  await anvil.rpc('anvil_setCode', [SAFE_130_DEPLOYMENTS.canonical.singleton, FIXTURE.factory.runtime]);
  await assert.rejects(plan(), /canonical lacks singleton;/);
});

test('the plan refuses another chain, bad owners and a node that creates elsewhere', async () => {
  await clear(); await install('canonical');
  const base = { rpc: reads(), chainId: CHAIN, owners: PRODUCTION_OWNERS, threshold: 2 };
  await assert.rejects(planGovernanceSafe({ ...base, chainId: 4663 }), /chain_id_mismatch/);
  await assert.rejects(planGovernanceSafe({ ...base, owners: [PRODUCTION_OWNERS[0], PRODUCTION_OWNERS[0]] }), /governance_owners_invalid/);
  await assert.rejects(planGovernanceSafe({ ...base, owners: [...PRODUCTION_OWNERS.slice(0, 2), '0x' + '0'.repeat(40)] }), /governance_owners_invalid/);
  await assert.rejects(planGovernanceSafe({ ...base, owners: [...PRODUCTION_OWNERS.slice(0, 2), '0x' + '0'.repeat(39) + '1'] }), /governance_owners_invalid/);
  await assert.rejects(planGovernanceSafe({ ...base, threshold: 1 }), /governance_threshold_below_two/);
  await assert.rejects(planGovernanceSafe({ ...base, threshold: 4 }), /governance_threshold_above_owners/);
  await assert.rejects(planGovernanceSafe({ ...base, saltNonce: -1n }), /invalid_salt_nonce/);
  await assert.rejects(planGovernanceSafe({ ...base, from: '0x1234' }), /invalid_from_address/);
  // A node that answers the creation's simulation with another address.
  const selector = viem.toFunctionSelector('createProxyWithNonce(address,bytes,uint256)');
  const inner = reads();
  const lying = async (method, params) => method === 'eth_call' && params[0].data.startsWith(selector)
    ? viem.encodeAbiParameters([{ type: 'address' }], ['0x00000000000000000000000000000000000bad01']) : inner(method, params);
  await assert.rejects(planGovernanceSafe({ ...base, rpc: lying, saltNonce: fresh() }), /safe_address_prediction_mismatch/);
});

test('the check requires the owners and threshold asked for, on deploy.mjs\'s own rules', async () => {
  await clear(); await install('canonical');
  const owners = accounts.slice(3, 6);
  const plan = await planGovernanceSafe({ rpc: reads(), chainId: CHAIN, owners, threshold: 2, saltNonce: fresh() });
  await send(plan.transaction);
  const check = extra => checkGovernanceSafe({ rpc: reads(), chainId: CHAIN, address: plan.safe.address, owners, threshold: 2, ...extra });
  assert.equal((await check()).status, 'passed');
  await assert.rejects(check({ threshold: 3 }), /governance_threshold_mismatch/);
  await assert.rejects(check({ owners: [...owners.slice(0, 2), accounts[7]] }), /governance_owners_mismatch/);
  await assert.rejects(check({ owners: owners.slice(0, 2) }), /governance_owners_mismatch/);
  await assert.rejects(check({ chainId: 1 }), /chain_id_mismatch/);
  await assert.rejects(check({ address: accounts[8] }), /governance_has_no_code/);
  await assert.rejects(check({ address: '0x1234' }), /invalid_safe_address/);
  await assert.rejects(check({ block: 5 }), /invalid_block/);
  // Before its creation block, there was no Safe.
  await assert.rejects(check({ block: 0n }), /governance_has_no_code/);
});

test('reads only, within a budget', async () => {
  const rpc = readsOnly(async () => '0x1', { maximumCalls: 2 });
  await assert.rejects(rpc('eth_sendTransaction', [{}]), /rpc_refused: eth_sendTransaction/);
  await assert.rejects(rpc('eth_sendRawTransaction', ['0x']), /rpc_refused/);
  assert.equal(await rpc('eth_chainId', []), '0x1');
  assert.equal(await rpc('eth_estimateGas', [{}]), '0x1');
  await assert.rejects(rpc('eth_chainId', []), /rpc_budget/);
});

test('owners come from a list or from a committed preflight report, never both', () => {
  assert.deepEqual(ownersFrom({ 'owners-from': join(repoRoot, PREFLIGHT) }),
    { owners: PRODUCTION_OWNERS, threshold: 2, source: { preflight: join(repoRoot, PREFLIGHT), chainId: 4663, block: 80189378,
      safe: '0x2b1d4098ec880058886b95a0e75069a7099c5a9d' } });
  const listed = ownersFrom({ owners: PRODUCTION_OWNERS.map(o => viem.getAddress(o)).join(','), threshold: '2' });
  assert.deepEqual([listed.owners, listed.threshold], [PRODUCTION_OWNERS, 2]);
  assert.throws(() => ownersFrom({ owners: PRODUCTION_OWNERS.join(','), threshold: '2', 'owners-from': PREFLIGHT }), /exactly_one_owner_source_required/);
  assert.throws(() => ownersFrom({}), /exactly_one_owner_source_required/);
  assert.throws(() => ownersFrom({ owners: PRODUCTION_OWNERS.join(',') }), /invalid_owners_or_threshold/);
  assert.throws(() => ownersFrom({ owners: PRODUCTION_OWNERS.join(','), threshold: '02' }), /invalid_owners_or_threshold/);
  const dir = mkdtempSync(join(tmpdir(), 'governance-safe-'));
  writeFileSync(join(dir, 'other.json'), JSON.stringify({ kind: 'domino-v2-deployment', governance: { checked: true, owners: PRODUCTION_OWNERS, threshold: 2 } }));
  assert.throws(() => ownersFrom({ 'owners-from': join(dir, 'other.json') }), /owners_from_not_a_preflight_report/);
  assert.throws(() => ownersFrom({ 'owners-from': join(dir, 'missing.json') }), /owners_from_unreadable/);
  // A mistyped EIP-55 checksum is refused rather than taken as another address.
  const typo = viem.getAddress(PRODUCTION_OWNERS[0]).replace(/[a-f]/, c => c.toUpperCase());
  assert.throws(() => checkedOwners([typo, ...PRODUCTION_OWNERS.slice(1)], 2), /invalid_owner_address/);
});

test('the command line plans, writes outside the checkout only, and checks', async () => {
  await clear(); await install('canonical');
  const dir = mkdtempSync(join(tmpdir(), 'governance-safe-cli-'));
  const env = { TEST_RPC: anvil.url };
  const common = ['--chain-id', String(CHAIN), '--owners-from', join(repoRoot, PREFLIGHT), '--rpc-env', 'TEST_RPC'];
  const message = await cli(['plan', ...common, '--salt-nonce', String(fresh()), '--out', join(dir, 'plan.json')], { env });
  assert.match(message, /^Safe 1\.3\.0 L2 \(canonical addresses\) for 2 of 3: 0x[0-9a-fA-F]{40} on chain 31337/);
  assert.match(message, /send from any funded account/);
  const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
  assert.equal(plan.ownersSource.safe, '0x2b1d4098ec880058886b95a0e75069a7099c5a9d');
  await assert.rejects(cli(['plan', ...common, '--out', join(dir, 'plan.json')], { env }), /output_exists/);
  await assert.rejects(cli(['plan', ...common, '--out', join(repoRoot, 'scripts/v2/plan.json')], { env }), /output_inside_the_checkout/);
  await assert.rejects(cli(['plan', ...common], { env }), /usage/);
  await assert.rejects(cli(['plan', ...common, '--out', join(dir, 'p2.json'), '--sign', 'x'], { env }), /usage/);
  await assert.rejects(cli(['send', ...common], { env }), /usage/);
  await assert.rejects(cli(['check', ...common], { env }), /usage/);
  await assert.rejects(cli(['plan', ...common.map(x => x === String(CHAIN) ? '0x7a69' : x), '--out', join(dir, 'p3.json')], { env }), /invalid_chain_id/);
  await assert.rejects(cli(['plan', ...common.map(x => x === String(CHAIN) ? '0' : x), '--out', join(dir, 'p4.json')], { env }), /invalid_chain_id/);
  await assert.rejects(cli(['plan', ...common, '--max-calls', '5', '--salt-nonce', String(fresh()), '--out', join(dir, 'p5.json')], { env }), /rpc_budget/);
  const receipt = await send(plan.transaction);
  const checked = await cli(['check', ...common, '--address', plan.safe.address, '--block', String(BigInt(receipt.blockNumber)), '--out', join(dir, 'check.json')], { env });
  assert.match(checked, /passes deploy\.mjs's check at block \d+ of chain 31337/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'check.json'), 'utf8')).status, 'passed');
  assert.match(await cli(['check', ...common, '--address', plan.safe.address], { env }), /Safe 1\.3\.0 L2, 2 of 3, no module, no guard/);
});
