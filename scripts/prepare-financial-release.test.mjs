import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { CHAIN_ID, DEPENDENCIES, CONTRACTS, toolsFor, loadArtifacts, prepare, verify, readOnlyRpc, main } from './prepare-financial-release.mjs';

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
    dependencyCodeHashes: Object.fromEntries(Object.keys(DEPENDENCIES).map(name => [name, '0x' + 'ab'.repeat(32)])),
    setupFeeBps: 65, tariffVersion: '1',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    gas: { ...Object.fromEntries(Object.keys(CONTRACTS).map(name => [name, '8000000'])), finalize: '300000' },
    maxFeePerGas: '10000000000', maxPriorityFeePerGas: '1000000000',
    maxTotalCostWei: '1000000000000000000', reserveWei: '1000000000000000',
  };
});

test('actual compiled artifacts produce eight unsigned calls with exact constructors and no available profile', () => {
  const result = prepare(parameters, artifacts, viem);
  assert.equal(result.publicReleaseVersion, 1); assert.equal(result.implementationVersion, 4);
  assert.deepEqual(result.contractNames, CONTRACTS);
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
  const changes = [{ sourceCommit: '0'.repeat(40) }, { feeRecipient: undefined }, { privateKey: 'never-read' }, { operator: parameters.pricePublisher }, { operator: parameters.feeRecipient }, { pricePublisher: DEPENDENCIES.poolManager },
    { chainId: 1 }, { setupFeeBps: 66 }, { priceGuardDeviationBps: 0 }, { priceGuardDeviationBps: 10000 }, { priceGuardGuardian: undefined }, { priceGuardGuardian: '0x' + '44'.repeat(20) }, { priceGuardGuardian: '0x' + '33'.repeat(20) }, { tariffVersion: '0' }, { expiresAt: 1 }, { nonce: (2n ** 64n - 1n).toString() },
    { maxTotalCostWei: '1' }, { gas: { ...parameters.gas, implementation: '53000' } },
    { dependencyCodeHashes: undefined }, { dependencyCodeHashes: {} },
    { dependencyCodeHashes: { ...parameters.dependencyCodeHashes, poolManager: '0x' + '00'.repeat(32) } }];
  for (const update of changes) assert.throws(() => prepare({ ...parameters, ...update }, artifacts, viem));
});

test('substituted in-memory artifacts cannot prepare and read-only RPC cannot send', async () => {
  const forged = structuredClone(artifacts);
  forged.setup.creation = '0x' + '00'.repeat(49153);
  assert.throws(() => prepare(parameters, forged, viem), /unauthenticated_release_artifacts/);
  const oversizedRuntime = structuredClone(artifacts);
  oversizedRuntime.setup.runtime = '0x' + '00'.repeat(24577);
  assert.throws(() => prepare(parameters, oversizedRuntime, viem), /unauthenticated_release_artifacts/);
  assert.throws(() => { artifacts.setup.creation = '0x00'; }, TypeError);
  const rpc = readOnlyRpc('http://127.0.0.1:1');
  await assert.rejects(() => rpc('eth_sendRawTransaction', ['0x']), /readonly_rpc_budget/);
  assert.throws(() => readOnlyRpc('https://rpc.example/?key=secret'), /public_rpc_url_required/);
});

test('changed manifest fails verification before any RPC', async () => {
  const result = prepare(parameters, artifacts, viem); result.steps[0].transaction.data += '00';
  await assert.rejects(() => verify(result, [], artifacts, viem, () => { throw new Error('must not call'); }), /package_changed/);
  for (const update of [{ publicReleaseVersion: 4 }, { implementationVersion: 1 },
    { contractNames: { ...CONTRACTS, engine: 'DominoExecutionEngineV4' } }]) {
    const renamed = { ...prepare(parameters, artifacts, viem), ...update };
    await assert.rejects(() => verify(renamed, [], artifacts, viem, () => { throw new Error('must not call'); }), /package_changed/);
  }
});

test('publisher re-admission is explicit, role-separated and cannot renew expired deployment profiles', async () => {
  const manifest = prepare(parameters, artifacts, viem);
  const noRpc = () => { throw new Error('must not call RPC'); };
  for (const pricePublisher of [undefined, '0x0', '0x' + '00'.repeat(20), parameters.operator,
    parameters.priceGuardGuardian, parameters.feeRecipient, ...Object.values(manifest.addresses)]) {
    await assert.rejects(() => verify(manifest, [], artifacts, viem, noRpc, Date.now() / 1000,
      { pricePublisher }), /invalid_address|publisher_admission_role_conflict/);
  }
  await assert.rejects(() => verify(manifest, [], artifacts, viem, noRpc, Date.now() / 1000,
    { pricePublisher: parameters.pricePublisher, expiresAt: parameters.expiresAt + 1000 }), /invalid_record_keys/);
  await assert.rejects(() => verify(manifest, [], artifacts, viem, noRpc, parameters.expiresAt + 1,
    { pricePublisher: '0x' + '66'.repeat(20) }), /release_expired/);
  await assert.rejects(() => main(['prepare', '--repo', repo, '--parameters', 'unused', '--out', 'unused',
    '--price-publisher', parameters.pricePublisher]), /invalid_record_keys/);
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
      const dependencyCodeHashes = {};
      for (const [name, address] of Object.entries(DEPENDENCIES))
        dependencyCodeHashes[name] = viem.keccak256(await rpc('eth_getCode', [address, 'latest']));
      const input = { ...parameters, deployer: accounts[0], nonce: BigInt(await rpc('eth_getTransactionCount', [accounts[0], 'pending'])).toString(),
        feeRecipient: accounts[1], operator: accounts[2], pricePublisher: accounts[3], priceGuardDeviationBps: 2000,
        priceGuardGuardian: accounts[4], dependencyCodeHashes };
      const manifest = prepare(input, artifacts, viem), hashes = [];
      for (const step of manifest.steps) hashes.push((await send(step.transaction)).transactionHash);
      await rpc('anvil_mine', ['0x40']);
      const methods = [];
      const readonly = async (method, params) => { assert(!method.includes('send')); methods.push(method); return rpc(method, params); };
      const result = await verify(manifest, hashes, artifacts, viem, readonly);
      assert.equal(result.setup.available, true); assert.equal(result.sequence.available, true);
      assert.equal(result.sequence.deployment.serviceFeeBps, 200);
      assert.equal(result.publicReleaseVersion, 1); assert.equal(result.implementationVersion, 4);
      assert.equal(result.contractNames.implementation, 'DominoVaultV1');
      assert.equal(result.sequence.contractVersion, '1.0.0-rc.1');
      assert.equal(result.setup.contractVersion, '1.0.0-rc.1');
      assert.equal(result.sequence.deployment.dominoServiceFeeBps, 400);
      assert.equal(result.executionAvailable, false); assert.equal(result.priceObservationQualified, false);
      assert.equal(result.receipts.length, 8); assert(methods.length <= 160);
      assert.equal(result.publisherAdmission.mode, 'original_deployment_publisher');
      assert.equal(result.publisherAdmission.changedFromDeployment, false);
      // Pins are admitted before preparation, never learned during verification.
      const alteredDependencyRpc = async (method, params) => method === 'eth_getCode'
        && params[0] === DEPENDENCIES.poolManager ? '0x6000' : readonly(method, params);
      await assert.rejects(() => verify(manifest, hashes, artifacts, viem, alteredDependencyRpc), /dependency_code_changed/);
      const contractGuardianRpc = async (method, params) => method === 'eth_getCode'
        && params[0] === input.priceGuardGuardian ? '0x6000' : readonly(method, params);
      await assert.rejects(() => verify(manifest, hashes, artifacts, viem, contractGuardianRpc), /execution_role_must_be_eoa/);
      const originalManifest = JSON.stringify(manifest);
      const nextPublisher = accounts[5];
      const readmit = (publisher = nextPublisher) => verify(manifest, hashes, artifacts, viem, readonly,
        Date.now() / 1000, { pricePublisher: publisher });
      async function rotateCall(from, functionName, args = []) {
        await send({ from, to: manifest.addresses.priceGuard, gas: '0x493e0',
          data: viem.encodeFunctionData({ abi: artifacts.priceGuard.abi, functionName, args }) });
        await rpc('anvil_mine', ['0x40']);
      }
      await rotateCall(input.priceGuardGuardian, 'proposePublisher', [nextPublisher]);
      await assert.rejects(() => readmit(), /deployment_link_mismatch/);
      await rotateCall(nextPublisher, 'acceptPublisher');
      await assert.rejects(() => verify(manifest, hashes, artifacts, viem, readonly), /deployment_link_mismatch/);
      await assert.rejects(() => readmit(accounts[6]), /deployment_link_mismatch/);
      for (const conflict of [input.operator, input.priceGuardGuardian, input.feeRecipient, manifest.addresses.engine])
        await assert.rejects(() => readmit(conflict), /publisher_admission_role_conflict/);
      // Even a role that accepted rotation is inadmissible while it has code.
      await rpc('anvil_setCode', [nextPublisher, '0x6000']);
      await rpc('anvil_mine', ['0x40']);
      await assert.rejects(() => readmit(), /execution_role_must_be_eoa/);
      await rpc('anvil_setCode', [nextPublisher, '0x']);
      await rpc('anvil_mine', ['0x40']);
      const rotated = await readmit();
      assert.equal(rotated.sequence.deployment.pricePublisher, nextPublisher);
      assert.equal(rotated.publisherAdmission.mode, 'explicit_current_publisher');
      assert.equal(rotated.publisherAdmission.originalPublisher, input.pricePublisher);
      assert.equal(rotated.publisherAdmission.admittedPublisher, nextPublisher);
      assert.equal(rotated.publisherAdmission.changedFromDeployment, true);
      assert.equal(rotated.publisherAdmission.guardian, input.priceGuardGuardian);
      assert.equal(rotated.publisherAdmission.priceGuard, manifest.addresses.priceGuard);
      assert.equal(rotated.publisherAdmission.expiresAt, input.expiresAt);
      assert.equal(rotated.sequence.deployment.expiresAt, input.expiresAt);
      assert.equal(rotated.setup.deployment.expiresAt, input.expiresAt);
      assert.equal(rotated.executionAvailable, false);
      assert.equal(rotated.priceObservationQualified, false);
      assert.equal(rotated.packageSha256, result.packageSha256);
      assert.deepEqual(rotated.receipts, result.receipts);
      assert.deepEqual(rotated.publisherAdmission.verifiedBlock,
        { number: rotated.verifiedBlock.number, hash: rotated.verifiedBlock.hash });
      assert.equal(JSON.stringify(manifest), originalManifest);
      const changed = structuredClone(manifest);
      changed.parameters.pricePublisher = nextPublisher;
      await assert.rejects(() => verify(changed, hashes, artifacts, viem, readonly, Date.now() / 1000,
        { pricePublisher: nextPublisher }), /package_changed/);
      const rewritten = prepare({ ...input, pricePublisher: nextPublisher }, artifacts, viem);
      await assert.rejects(() => verify(rewritten, hashes, artifacts, viem, readonly, Date.now() / 1000,
        { pricePublisher: nextPublisher }), /deployment_transaction_mismatch/);
      const directory = mkdtempSync(join(tmpdir(), 'domino-financial-profile-sdk-'));
      try {
        execFileSync(process.execPath, [join(repo, 'app/node_modules/typescript/bin/tsc'),
          join(repo, 'app/src/finance/setup.ts'), join(repo, 'app/src/finance/sequence.ts'), '--target', 'ES2022',
          '--module', 'ESNext', '--moduleResolution', 'Bundler', '--strict', '--skipLibCheck',
          '--outDir', directory, '--rootDir', join(repo, 'app/src/finance')], { stdio: 'pipe' });
        writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
        symlinkSync(join(repo, 'app/node_modules'), join(directory, 'node_modules'), 'dir');
        const packageFile = join(directory, 'unsigned.json'), transactionsFile = join(directory, 'transactions.json');
        const admittedFile = join(directory, 'admitted.json');
        writeFileSync(packageFile, originalManifest); writeFileSync(transactionsFile, JSON.stringify(hashes));
        await main(['verify', '--repo', repo, '--package', packageFile, '--transactions', transactionsFile,
          '--rpc', endpoint, '--out', admittedFile, '--price-publisher', nextPublisher,
          '--artifacts', process.env.DOMINO_FINANCIAL_ARTIFACTS ?? join(repo, 'contracts/out')]);
        const admitted = JSON.parse(readFileSync(admittedFile, 'utf8'));
        assert.equal(admitted.publisherAdmission.admittedPublisher, nextPublisher);
        const setup = await import(pathToFileURL(join(directory, 'setup.js')).href);
        const sequence = await import(pathToFileURL(join(directory, 'sequence.js')).href);
        assert.equal(setup.deploymentFrom(result.setup).setup, manifest.addresses.setup);
        assert.equal(sequence.sequenceDeploymentFrom(result.sequence).factory, manifest.addresses.factory);
        assert.equal(sequence.sequenceDeploymentFrom(rotated.sequence).pricePublisher, nextPublisher);
        assert.equal(sequence.sequenceDeploymentFrom(admitted.sequence).pricePublisher, nextPublisher);
        for (const profile of [result.sequence, rotated.sequence, admitted.sequence]) {
          const deployment = sequence.sequenceDeploymentFrom(profile);
          assert.equal(deployment.serviceFeeBps, 200); assert.equal(deployment.dominoServiceFeeBps, 400);
          for (const change of [{ serviceFeeBps: 400 }, { dominoServiceFeeBps: undefined },
            { dominoServiceFeeBps: 200 }, { dominoServiceFeeBps: '400' }])
            assert.throws(() => sequence.sequenceDeploymentFrom({ ...profile, deployment: { ...profile.deployment, ...change } }), /invalid_sequence_release/);
        }
        assert.equal(setup.deploymentFrom(admitted.setup).setup, manifest.addresses.setup);
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
