/** The V2 deployment tooling's only senders: Anvil instances that this module started itself, or that it
 * validated as a loopback Anvil before any impersonation, code installation or transaction. It also runs
 * the offline gas simulation that sizes every prepared package. */
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot, viem, CREATE_X, CREATE_X_CODE_HASH, DEPLOY_ORDER, MAX_TRANSACTION_GAS, PRODUCTION_DEPLOYER, ROLE_NAMES,
  ensure, makeRpc, dependencyMap, readJson, quantity } from './deploy.mjs';

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
const validated = new WeakSet();
const hex = value => viem.toHex(BigInt(value));

export function anvilBinary() {
  if (process.env.ANVIL_BIN) return process.env.ANVIL_BIN;
  const arch = { x64: 'amd64' }[process.arch] ?? process.arch;
  return join(repoRoot, 'node_modules/@foundry-rs', `anvil-${process.platform}-${arch}`, 'bin/anvil');
}

/** A loopback URL whose client says it is Anvil; only such an RPC function may mutate state. */
export async function requireAnvil(url, rpc) {
  const parsed = new URL(url);
  ensure(LOOPBACK.includes(parsed.hostname) && ['http:', 'https:'].includes(parsed.protocol), 'local_anvil_only');
  ensure(/anvil/i.test(await rpc('web3_clientVersion', [])), 'anvil_required');
  validated.add(rpc);
}
export const requireValidatedRpc = rpc => ensure(validated.has(rpc), 'local_rpc_not_validated');

/** The upstream network an Anvil forks, or null for a plain Anvil. */
export async function forkedNetwork(rpc) {
  requireValidatedRpc(rpc);
  return (await rpc('anvil_metadata', [])).forkedNetwork ?? null;
}

/** Starts a private Anvil on a free loopback port. History stays in memory (no state directory under
 * ~/.foundry/anvil/tmp) and output is discarded: an upstream URL must never reach a log. */
export async function startAnvil({ args = [], timeoutMs = 30000 } = {}) {
  const child = spawn(anvilBinary(), ['--host', '127.0.0.1', '--port', '0', '--max-persisted-states', '0', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '', ready = false;
  const url = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('anvil_start_timeout')); }, timeoutMs);
    const onData = chunk => {
      if (ready) return;
      buffer = (buffer + chunk.toString()).slice(-8192);
      const match = buffer.match(/Listening on (?:127\.0\.0\.1|0\.0\.0\.0):(\d+)/);
      if (match) { ready = true; clearTimeout(timer); resolveReady('http://127.0.0.1:' + match[1]); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.once('error', () => { clearTimeout(timer); reject(new Error('anvil_spawn_failed')); });
    child.once('exit', code => { if (!ready) { clearTimeout(timer); reject(new Error('anvil_exit_before_ready: ' + code)); } });
  });
  const rpc = makeRpc(url);
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(done => child.once('exit', done));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited; clearTimeout(timer);
  };
  try { await requireAnvil(url, rpc); } catch (error) { await stop(); throw error; }
  return { url, rpc, child, stop };
}

export async function waitReceipt(rpc, hash, attempts = 600) {
  for (let i = 0; i < attempts; i++) {
    let receipt = null;
    try { receipt = await rpc('eth_getTransactionReceipt', [hash]); } catch { /* a fork may ask its upstream first */ }
    if (receipt) return receipt;
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error('local_receipt_timeout');
}

export async function installCreateX(rpc) {
  requireValidatedRpc(rpc);
  const fixture = readJson(join(repoRoot, 'scripts/v2/deploy-fixtures/createx-runtime.json'));
  ensure(fixture.address.toLowerCase() === CREATE_X && fixture.runtimeCodeHash === CREATE_X_CODE_HASH
    && viem.keccak256(fixture.runtime) === CREATE_X_CODE_HASH, 'canonical_createx_fixture_changed');
  const current = await rpc('eth_getCode', [CREATE_X, 'latest']);
  if (current === '0x') await rpc('anvil_setCode', [CREATE_X, fixture.runtime]);
  ensure(viem.keccak256(await rpc('eth_getCode', [CREATE_X, 'latest'])) === CREATE_X_CODE_HASH, 'createx_runtime_mismatch');
}

let stubCompile;
/** DependencyFixture.sol, compiled once per process with the pinned compiler (outside the product build). */
export function dependencyStub() {
  if (stubCompile) return stubCompile;
  const source = readFileSync(join(repoRoot, 'scripts/v2/deploy-fixtures/DependencyFixture.sol'), 'utf8');
  const input = { language: 'Solidity', sources: { 'deploy-fixtures/DependencyFixture.sol': { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', metadata: { bytecodeHash: 'none' },
      outputSelection: { '*': { '': ['ast'], '*': ['evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } } } };
  const output = JSON.parse(execFileSync(process.execPath, [join(repoRoot, 'scripts/solc-compile.cjs')], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  ensure(!(output.errors ?? []).some(e => e.severity === 'error'), 'dependency_stub_compile_failed');
  const names = {};
  const visit = node => {
    if (node?.nodeType === 'VariableDeclaration' && node.mutability === 'immutable') names[node.id] = node.name;
    if (node && typeof node === 'object') for (const value of Object.values(node)) Array.isArray(value) ? value.forEach(visit) : value && typeof value === 'object' && visit(value);
  };
  visit(output.sources['deploy-fixtures/DependencyFixture.sol'].ast);
  const artifact = output.contracts['deploy-fixtures/DependencyFixture.sol'].DeploymentDependencyFixture.evm.deployedBytecode;
  stubCompile = Object.freeze({ object: artifact.object, references: artifact.immutableReferences, names });
  return stubCompile;
}

/** The stub's runtime answering for `profile`'s dependency addresses. */
export function stubRuntime(profile) {
  const stub = dependencyStub(), deps = dependencyMap(profile), code = Buffer.from(stub.object, 'hex');
  const values = { V3_FACTORY: deps.v3Factory, V4_POOL_MANAGER: deps.v4PoolManager, WRAPPED_NATIVE: deps.wrappedNative, PERMIT2: deps.permit2 };
  for (const [id, ranges] of Object.entries(stub.references)) {
    ensure(Object.hasOwn(values, stub.names[id]), 'dependency_stub_immutable_unknown');
    const word = Buffer.from(values[stub.names[id]].slice(2).padStart(64, '0'), 'hex');
    for (const range of ranges) { ensure(range.length === 32, 'dependency_stub_range_invalid'); word.copy(code, range.start); }
  }
  return '0x' + code.toString('hex');
}

/** Installs the stub at every dependency and non-native charge currency of `profile`: on an empty address,
 * or nowhere when the stub is already there (a rerun); any other code is refused. */
export async function installStubs(rpc, profile) {
  requireValidatedRpc(rpc);
  const runtime = stubRuntime(profile);
  const addresses = new Set([...Object.values(dependencyMap(profile)),
    ...profile.chargeCurrencies.filter(c => !c.native).map(c => c.address.toLowerCase())]);
  for (const address of addresses) {
    const code = await rpc('eth_getCode', [address, 'latest']);
    ensure(code === '0x' || code === runtime, 'offline_fixture_address_occupied');
    await rpc('anvil_setCode', [address, runtime]);
  }
  return { addresses: [...addresses], codehash: viem.keccak256(runtime) };
}

/** The `local-test` profile of a plain Anvil: Base's addresses at the Anvil's chain id, the stub's code
 * hash for every dependency. Synthetic, never a Uniswap or Permit2 qualification. */
export async function installOfflineDependencies(rpc) {
  requireValidatedRpc(rpc);
  const template = readJson(join(repoRoot, 'api-contracts/v2/chains/base-8453.json'));
  const profile = { ...template, chainId: Number(BigInt(await rpc('eth_chainId', []))), name: 'Offline V2 deployment fixtures', slug: 'local' };
  const { addresses, codehash } = await installStubs(rpc, profile);
  profile.verification = { block: Number(BigInt(await rpc('eth_blockNumber', []))), checkedAt: new Date().toISOString(),
    contracts: addresses.map(address => ({ name: 'DeploymentDependencyFixture', address, codehash })) };
  profile.notes = ['local-test: synthetic constructor dependencies only; not a Uniswap or Permit2 qualification or a journey rehearsal.'];
  return profile;
}

/** Execution gas of each of a package's eleven steps, measured by running exactly its calldata in order on a
 * private offline Anvil at the profile's chain id: canonical CreateX, the stub at every dependency, the
 * package's deployer impersonated. Each step may use at most EIP-7825's per-transaction cap, so a step that
 * needs more reverts here. L1 costs are added separately. */
export async function simulateGas(full) {
  ensure(full.steps.length === DEPLOY_ORDER.length && full.parameters.resumeOf === null, 'simulation_requires_all_steps');
  const profile = full.parameters.profile, deployer = full.manifest.roles.deployer;
  const anvil = await startAnvil({ args: ['--chain-id', String(profile.chainId), '--hardfork', 'prague', '--gas-limit', '60000000'] });
  try {
    await installCreateX(anvil.rpc);
    await installStubs(anvil.rpc, profile);
    await anvil.rpc('anvil_impersonateAccount', [deployer]);
    await anvil.rpc('anvil_setBalance', [deployer, hex(10n ** 24n)]);
    const gas = {};
    for (const step of full.steps) {
      const hash = await anvil.rpc('eth_sendTransaction', [{ from: deployer, to: CREATE_X, data: step.transaction.data, gas: hex(MAX_TRANSACTION_GAS), value: '0x0' }]);
      const receipt = await waitReceipt(anvil.rpc, hash);
      ensure(quantity(receipt.status) === 1n, 'gas_simulation_reverted: ' + step.component);
      gas[step.component] = quantity(receipt.gasUsed).toString();
    }
    return gas;
  } finally { await anvil.stop(); }
}

/** Deterministic test accounts for forks and local runs: key = keccak256("domino.v2.rehearsal.<label>"). They
 * are public (anyone can derive them) and exist for disposable EVMs only. The public test mnemonic cannot
 * serve here: its accounts carry EIP-7702 sweeper delegations on Robinhood, Base and Arbitrum. */
export function rehearsalAccount(label) {
  const { privateKeyToAccount } = createRequire(join(repoRoot, 'app/package.json'))('viem/accounts');
  return privateKeyToAccount(viem.keccak256(viem.toHex('domino.v2.rehearsal.' + label)));
}

/** The local modes' roles (checksummed): rehearsal accounts, and the owner's deployer on request so that
 * every address and EIP-712 domain equals production's. */
export function localRoles({ productionDeployer = false } = {}) {
  const roles = Object.fromEntries(ROLE_NAMES.map(name => [name, rehearsalAccount(name).address]));
  if (productionDeployer) roles.deployer = viem.getAddress(PRODUCTION_DEPLOYER);
  return roles;
}
