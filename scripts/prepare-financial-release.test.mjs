import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { CHAIN_ID, DEPENDENCIES, CONTRACTS, toolsFor, loadArtifacts, prepare, verify, readOnlyRpc } from './prepare-financial-release.mjs';

const repo = resolve(process.env.DOMINO_FINANCIAL_RELEASE_REPO ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const viem = toolsFor(repo);
let artifacts, parameters;
before(() => {
  artifacts = loadArtifacts(repo, viem, process.env.DOMINO_FINANCIAL_ARTIFACTS);
  parameters = {
    chainId: CHAIN_ID, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    deployer: '0x' + '11'.repeat(20), nonce: '3', feeRecipient: '0x' + '22'.repeat(20),
    operator: '0x' + '33'.repeat(20), pricePublisher: '0x' + '44'.repeat(20), priceGuardDeviationBps: 2000,
    priceGuardGuardian: '0x' + '55'.repeat(20),
    setupFeeBps: 65, tariffVersion: '1',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    gas: { ...Object.fromEntries(Object.keys(CONTRACTS).map(name => [name, '8000000'])), finalize: '300000' },
    maxFeePerGas: '10000000000', maxPriorityFeePerGas: '1000000000',
    maxTotalCostWei: '1000000000000000000', reserveWei: '1000000000000000',
  };
});

test('actual compiled artifacts produce eight unsigned calls with exact constructors and no available profile', () => {
  const result = prepare(parameters, artifacts, viem);
  assert.equal(result.available, false); assert.equal(result.deployment, null);
  assert.equal(result.steps.length, 8); assert.deepEqual(result.addresses.poolManager, DEPENDENCIES.poolManager);
  for (let index = 0; index < 8; index++) {
    const step = result.steps[index];
    assert.equal(step.transaction.nonce, viem.toHex(3n + BigInt(index)));
    assert.equal(step.transaction.value, '0x0'); assert.equal(step.transaction.chainId, '0x1237');
    assert(!('privateKey' in step));
    if (index < 7) {
      assert.equal(step.expectedAddress, viem.getContractAddress({ from: parameters.deployer, nonce: 3n + BigInt(index) }).toLowerCase());
      assert(step.runtimeBytes <= 24576); assert(step.initcodeBytes <= 49152);
      assert.equal(step.initcodeHash, viem.keccak256(step.transaction.data));
    }
  }
  assert.equal(result.steps[7].transaction.to, result.addresses.factory);
  const last = viem.decodeFunctionData({ abi: artifacts.factory.abi, data: result.steps[7].transaction.data });
  assert.equal(last.functionName, 'finalizeImplementation'); assert.equal(last.args[0].toLowerCase(), result.addresses.implementation);
  assert.equal(result.cloneCodeHash, viem.keccak256(result.cloneRuntime));
});

test('no inferred roles, excess tariff, exhausted nonce, bad gas or false chain can prepare', () => {
  const changes = [{ feeRecipient: undefined }, { privateKey: 'never-read' }, { operator: parameters.pricePublisher }, { operator: parameters.feeRecipient }, { pricePublisher: DEPENDENCIES.poolManager },
    { chainId: 1 }, { setupFeeBps: 66 }, { priceGuardDeviationBps: 0 }, { priceGuardDeviationBps: 10000 }, { priceGuardGuardian: undefined }, { priceGuardGuardian: '0x' + '44'.repeat(20) }, { priceGuardGuardian: '0x' + '33'.repeat(20) }, { tariffVersion: '0' }, { expiresAt: 1 }, { nonce: (2n ** 64n - 1n).toString() },
    { maxTotalCostWei: '1' }, { gas: { ...parameters.gas, implementation: '53000' } }];
  for (const update of changes) assert.throws(() => prepare({ ...parameters, ...update }, artifacts, viem));
});

test('size guards reject oversized runtime/initcode and read-only RPC cannot send', async () => {
  const forged = structuredClone(artifacts);
  forged.setup.creation = '0x' + '00'.repeat(49153);
  assert.throws(() => prepare(parameters, forged, viem), /initcode_size_limit/);
  const oversizedRuntime = structuredClone(artifacts);
  oversizedRuntime.setup.runtime = '0x' + '00'.repeat(24577);
  assert.throws(() => prepare(parameters, oversizedRuntime, viem), /runtime_size_limit/);
  const rpc = readOnlyRpc('http://127.0.0.1:1');
  await assert.rejects(() => rpc('eth_sendRawTransaction', ['0x']), /readonly_rpc_budget/);
  assert.throws(() => readOnlyRpc('https://rpc.example/?key=secret'), /public_rpc_url_required/);
});

test('changed manifest fails verification before any RPC', async () => {
  const result = prepare(parameters, artifacts, viem); result.steps[0].transaction.data += '00';
  await assert.rejects(() => verify(result, [], artifacts, viem, () => { throw new Error('must not call'); }), /package_changed/);
});

test('actual official-v4 dependency code and all unsigned deployments verify into current consumer profiles',
  { skip: process.env.DOMINO_TEST_EVM !== '1', timeout: 90000 }, async () => {
    const require = createRequire(join(repo, 'package.json'));
    const platform = await import(pathToFileURL(require.resolve('@foundry-rs/anvil/const.mjs')).href);
    const binary = require.resolve(platform.PLATFORM_SPECIFIC_PACKAGE_NAME('anvil') + '/bin/' + platform.BINARY_NAME('anvil'));
    const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port; await new Promise(resolve => server.close(resolve));
    const child = spawn(binary, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '4663', '--hardfork', 'cancun', '--silent'], { stdio: 'ignore' });
    const endpoint = 'http://127.0.0.1:' + port;
    let id = 0;
    async function rpc(method, params) {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(5000) });
      const result = await response.json(); if (result.error) throw new Error(JSON.stringify(result.error)); return result.result;
    }
    try {
      for (let attempt = 0;; attempt++) {
        try { assert.equal(await rpc('eth_chainId', []), '0x1237'); break; }
        catch (error) { if (attempt >= 100) throw error; await new Promise(resolve => setTimeout(resolve, 25)); }
      }
      const accounts = (await rpc('eth_accounts', [])).map(a => a.toLowerCase());
      // Only the test sends transactions, using ephemeral unlocked Anvil accounts.
      async function send(transaction) {
        const hash = await rpc('eth_sendTransaction', [transaction]);
        for (let attempt = 0; attempt < 100; attempt++) {
          const receipt = await rpc('eth_getTransactionReceipt', [hash]);
          if (receipt) { assert.equal(receipt.status, '0x1'); return receipt; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error('local_receipt_timeout');
      }
      async function dependency(name, args, target) {
        const artifact = JSON.parse(readFileSync(join(repo, 'contracts/out', name + '.sol', name + '.json')));
        const receipt = await send({ from: accounts[0], gas: '0x1c9c380', value: '0x0',
          data: viem.encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args }) });
        // The isolated chain places actual compiled official code at the fixed
        // mainnet dependency addresses; this is fixture setup, not mainnet evidence.
        await rpc('anvil_setCode', [target, await rpc('eth_getCode', [receipt.contractAddress, 'latest'])]);
      }
      await dependency('PoolManager', [accounts[0]], DEPENDENCIES.poolManager);
      await dependency('PositionManager', [DEPENDENCIES.poolManager, accounts[8], 100000n, accounts[7], accounts[6]], DEPENDENCIES.positionManager);
      await dependency('StateView', [DEPENDENCIES.poolManager], DEPENDENCIES.stateView);
      const input = { ...parameters, deployer: accounts[0], nonce: BigInt(await rpc('eth_getTransactionCount', [accounts[0], 'pending'])).toString(),
        feeRecipient: accounts[1], operator: accounts[2], pricePublisher: accounts[3], priceGuardDeviationBps: 2000,
        priceGuardGuardian: accounts[4] };
      const manifest = prepare(input, artifacts, viem), hashes = [];
      for (const step of manifest.steps) hashes.push((await send(step.transaction)).transactionHash);
      await rpc('anvil_mine', ['0x40']);
      const methods = [];
      const readonly = async (method, params) => { assert(!method.includes('send')); methods.push(method); return rpc(method, params); };
      const result = await verify(manifest, hashes, artifacts, viem, readonly);
      assert.equal(result.setup.available, true); assert.equal(result.sequence.available, true);
      assert.equal(result.executionAvailable, false); assert.equal(result.priceObservationQualified, false);
      assert.equal(result.receipts.length, 8); assert(methods.length <= 160);
      const directory = mkdtempSync(join(tmpdir(), 'domino-financial-profile-sdk-'));
      try {
        execFileSync(process.execPath, [join(repo, 'app/node_modules/typescript/bin/tsc'),
          join(repo, 'app/src/finance/setup.ts'), join(repo, 'app/src/finance/sequence.ts'), '--target', 'ES2022',
          '--module', 'ESNext', '--moduleResolution', 'Bundler', '--strict', '--skipLibCheck',
          '--outDir', directory, '--rootDir', join(repo, 'app/src/finance')], { stdio: 'pipe' });
        writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
        symlinkSync(join(repo, 'app/node_modules'), join(directory, 'node_modules'), 'dir');
        const setup = await import(pathToFileURL(join(directory, 'setup.js')).href);
        const sequence = await import(pathToFileURL(join(directory, 'sequence.js')).href);
        assert.equal(setup.deploymentFrom(result.setup).setup, manifest.addresses.setup);
        assert.equal(sequence.sequenceDeploymentFrom(result.sequence).factory, manifest.addresses.factory);
      } finally { rmSync(directory, { recursive: true, force: true }); }
      await assert.rejects(() => verify(manifest, [...hashes.slice(1), hashes[0]], artifacts, viem, readonly));
      const code = await rpc('eth_getCode', [manifest.addresses.routing, 'latest']);
      await rpc('anvil_setCode', [manifest.addresses.routing, '0x00' + code.slice(4)]);
      await rpc('anvil_mine', ['0x40']);
      await assert.rejects(() => verify(manifest, hashes, artifacts, viem, readonly), /deployment_code_changed/);
    } finally {
      child.kill('SIGTERM');
      await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    }
  });
