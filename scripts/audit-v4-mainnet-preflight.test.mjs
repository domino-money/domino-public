import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { DEPENDENCIES, toolsFor, readOnlyRpc } from './prepare-financial-release.mjs';
import { ARB_SYS, NUMBER_PROBE, preflight, publicInputs, loadBlockArtifacts } from './audit-v4-mainnet-preflight.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const viem = toolsFor(repo);
const hash = number => viem.toHex(BigInt(number), { size: 32 });
const block = number => ({ number: viem.toHex(number), hash: hash(number), parentHash: hash(number - 1n), timestamp: '0x6553f100', l1BlockNumber: '0x1f4' });
const code = '0x6000';
const completeInputs = () => ({ deployer: '0x' + '11'.repeat(20), operator: '0x' + '22'.repeat(20),
  pricePublisher: '0x' + '33'.repeat(20), priceGuardGuardian: '0x' + '44'.repeat(20), feeRecipient: '0x' + '55'.repeat(20),
  dependencyCodeHashes: Object.fromEntries(Object.keys(DEPENDENCIES).map(name => [name, viem.keccak256(code)])) });
const arbAbi = viem.parseAbi(['function arbBlockNumber() view returns (uint256)', 'function arbBlockHash(uint256) view returns (bytes32)']);

const compiledCreation = '0x600160005260206000f3';
const artifactTargets = {
  probe: ['test/DominoL2Block.t.sol', 'NitroBlockProbe'],
  priceGuard: ['src/DominoPriceGuardV4.sol', 'DominoPriceGuardV4'],
  readHelper: ['src/DominoVaultReadHelper.sol', 'DominoVaultReadHelper'],
};
const librarySource = 'src/DominoL2Block.sol';
function artifactFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'domino-block-artifacts-'));
  (t ? t.after.bind(t) : after)(() => rmSync(directory, { recursive: true, force: true }));
  const sources = { [librarySource]: 'library DominoL2Block {}\n' };
  for (const [path, name] of Object.values(artifactTargets)) sources[path] = `contract ${name} {}\n`;
  for (const [path, content] of Object.entries(sources)) {
    const fullPath = join(directory, 'contracts', path);
    mkdirSync(dirname(fullPath), { recursive: true }); writeFileSync(fullPath, content);
  }
  const paths = {};
  for (const [component, [source, name]] of Object.entries(artifactTargets)) {
    const metadata = { compiler: { version: '0.8.26+commit.8a97fa7a' }, settings: {
      optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun',
      metadata: { bytecodeHash: 'none' }, compilationTarget: { [source]: name },
    }, sources: Object.fromEntries([source, librarySource].map(path => [path, {
      keccak256: viem.keccak256(viem.stringToHex(sources[path])),
    }])) };
    const artifact = { metadata, rawMetadata: JSON.stringify(metadata),
      abi: [{ type: 'constructor', stateMutability: 'nonpayable', inputs: [] }],
      bytecode: { object: compiledCreation, linkReferences: {} },
      deployedBytecode: { object: code, linkReferences: {} } };
    const path = paths[component] = join(directory, 'contracts/out', source.split('/').at(-1), name + '.json');
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(artifact));
  }
  return { directory, paths, mutate(component, operation, updateRawMetadata = true) {
    const artifact = JSON.parse(readFileSync(paths[component], 'utf8'));
    operation(artifact);
    if (updateRawMetadata) artifact.rawMetadata = JSON.stringify(artifact.metadata);
    writeFileSync(paths[component], JSON.stringify(artifact));
  } };
}
const artifacts = artifactFixture();
const run = options => preflight({ repo: artifacts.directory, viem, ...options });

function fixture(options = {}) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_chainId') return options.chainId ?? '0x1237';
    if (method === 'eth_getBlockByNumber') {
      const [tag] = params;
      if (tag === 'latest') return block(1000n);
      if (tag === 'finalized') { if (options.noFinalized) throw new Error('provider-secret'); return block(998n); }
      const result = block(BigInt(tag));
      if (options.reorg && tag === '0x3e6') result.hash = hash(9000);
      return result;
    }
    if (method === 'eth_getCode') {
      if (options.codeByAddress?.[params[0]] !== undefined) return options.codeByAddress[params[0]];
      return Object.values(DEPENDENCIES).includes(params[0]) ? code : '0x';
    }
    if (method === 'eth_call') {
      const [{ to, data }, pinned] = params;
      if (options.prunedFinalized && pinned.blockHash === hash(998)) throw new Error('private-provider-pruned-state');
      const current = BigInt(pinned.blockHash);
      if (data === NUMBER_PROBE) {
        if (options.unsupportedCreation) throw new Error('https://rpc.invalid/secret-key');
        return hash(options.numberOpcode ?? 500n);
      }
      if (data.startsWith('0x7f')) return options.blockhashOpcode ?? hash(0);
      if (!to) {
        if (options.unavailableProbe) throw new Error('private-provider-error');
        return options.probeOutput ?? hash(current) + hash(current - 1n).slice(2);
      }
      if (to === ARB_SYS) {
        const decoded = viem.decodeFunctionData({ abi: arbAbi, data });
        if (decoded.functionName === 'arbBlockNumber') return options.emptyArb ? '0x' : hash(options.arbNumber ?? current);
        assert.equal(decoded.functionName, 'arbBlockHash');
        assert.equal(decoded.args[0], current - 1n);
        return options.arbHash ?? hash(current - 1n);
      }
      assert.ok([DEPENDENCIES.positionManager, DEPENDENCIES.stateView].includes(to));
      return viem.encodeAbiParameters([{ type: 'address' }], [options.poolManagerLink ?? DEPENDENCIES.poolManager]);
    }
    throw new Error('unexpected_method');
  };
  return { rpc, calls };
}

test('all observations are pinned, code hashes and manager links checked, and inspection never enables deployment', async () => {
  const { rpc, calls } = fixture();
  const result = await run({ rpc, viem, inputs: completeInputs() });
  assert.equal(result.chain.status, 'pass');
  assert.match(result.checkedAtUTC, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(result.snapshot.tag, 'finalized');
  assert.equal(result.blockSemantics.compatibility.status, 'pass');
  assert.equal(result.blockSemantics.rpcBlockNumber, '998');
  assert.equal(result.dependencies.positionManager.poolManager.status, 'pass');
  assert.equal(result.dependencies.stateView.pin.status, 'pass');
  assert.equal(result.roles.priceGuardGuardian.status, 'pass');
  assert.equal(result.roleSeparation.status, 'pass');
  assert.equal(result.deploymentReady, false);
  assert.equal(result.executionAvailable, false);
  assert.equal(result.readiness.status, 'unavailable');
  for (const call of calls.filter(call => ['eth_getCode', 'eth_call'].includes(call.method)))
    assert.deepEqual(call.params[1], { blockHash: hash(998), requireCanonical: true });
  assert.ok(calls.every(call => ['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call'].includes(call.method)));
});

test('Nitro ancestor opcodes are diagnostic while the compiled corrected path qualifies', async () => {
  const { rpc } = fixture({ numberOpcode: 500n, blockhashOpcode: hash(0) });
  const result = await run({ rpc, viem });
  assert.equal(result.blockSemantics.numberOpcode.value, '500');
  assert.equal(result.blockSemantics.arbBlockNumber.value, '998');
  assert.equal(result.blockSemantics.arbBlockHash.status, 'pass');
  assert.equal(result.blockSemantics.numberOpcode.reason, 'ancestor_domain_expected_on_nitro');
  assert.equal(result.blockSemantics.numberOpcode.matchesHeaderL1, true);
  assert.equal(result.blockSemantics.blockhashOpcode.matchesRpcL2, false);
  assert.equal(result.blockSemantics.compiledProbe.status, 'pass');
  assert.equal(result.blockSemantics.compatibility.reason, 'compiled_production_library_matches_pinned_l2_block');
  assert.equal(result.readiness.status, 'missing');
  assert.equal(result.deploymentReady, false);
  assert.equal(result.roles.deployer.status, 'missing');
  assert.equal(result.dependencies.poolManager.pin.status, 'missing');
});

test('unavailable RPC probes and missing public inputs stay distinct and never reflect provider errors', async () => {
  const { rpc } = fixture({ unsupportedCreation: true, noFinalized: true, emptyArb: true });
  const result = await run({ rpc, viem, snapshotTag: 'latest' });
  assert.equal(result.blocks.finalized.status, 'unavailable');
  assert.equal(result.snapshot.tag, 'latest');
  assert.equal(result.blockSemantics.numberOpcode.status, 'unavailable');
  assert.equal(result.blockSemantics.arbBlockNumber.status, 'unavailable');
  assert.equal(result.blockSemantics.compatibility.status, 'unavailable');
  assert.equal(result.roles.operator.status, 'missing');
  assert.equal(result.readiness.status, 'unavailable');
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.ok(!JSON.stringify(result).includes('rpc.invalid'));
});

test('default finalized snapshot never silently falls back and explicit latest pins every state query', async () => {
  const defaultResult = await run({ rpc: fixture({ noFinalized: true }).rpc, viem });
  assert.equal(defaultResult.snapshot.tag, 'finalized');
  assert.equal(defaultResult.snapshot.status, 'unavailable');
  assert.equal(defaultResult.dependencies.poolManager.code.status, 'unavailable');
  const { rpc, calls } = fixture();
  const latestResult = await run({ rpc, viem, snapshotTag: 'latest' });
  assert.equal(latestResult.snapshot.number, '1000');
  assert.equal(latestResult.snapshot.tag, 'latest');
  for (const call of calls.filter(call => ['eth_getCode', 'eth_call'].includes(call.method)))
    assert.deepEqual(call.params[1], { blockHash: hash(1000), requireCanonical: true });
  await assert.rejects(() => run({ rpc, viem, snapshotTag: 'pending' }), /invalid_snapshot/);
});

test('wrong chain, changed code, wrong links, contract roles and a canonicality change fail independently', async () => {
  const inputs = completeInputs();
  const { rpc } = fixture({ chainId: '0x1', reorg: true, poolManagerLink: inputs.deployer,
    codeByAddress: { [DEPENDENCIES.poolManager]: '0x6001', [DEPENDENCIES.stateView]: '0x', [inputs.priceGuardGuardian]: code } });
  const result = await run({ rpc, viem, inputs });
  assert.equal(result.chain.reason, 'wrong_chain');
  assert.equal(result.dependencies.poolManager.pin.reason, 'dependency_code_hash_mismatch');
  assert.equal(result.dependencies.positionManager.poolManager.reason, 'dependency_link_mismatch');
  assert.equal(result.dependencies.stateView.code.reason, 'dependency_code_absent');
  assert.equal(result.roles.priceGuardGuardian.reason, 'role_must_be_eoa');
  assert.equal(result.snapshotCanonical.reason, 'pinned_block_changed');
  assert.equal(result.readiness.status, 'fail');
});

test('public inputs reject unknown fields and enforce current release role separation', async () => {
  for (const input of [{ privateKey: 'not-read' }, { operator: '0x0' }, { deployer: '0x' + '00'.repeat(20) },
    { dependencyCodeHashes: { foreign: hash(1) } }, { dependencyCodeHashes: { poolManager: 'secret' } }])
    assert.throws(() => publicInputs(input));
  const inputs = completeInputs();
  inputs.operator = inputs.pricePublisher;
  inputs.priceGuardGuardian = inputs.feeRecipient;
  const result = await run({ rpc: fixture().rpc, viem, inputs });
  assert.equal(result.roleSeparation.status, 'fail');
  assert.deepEqual(result.roleSeparation.conflicts, ['operator_equals_pricePublisher', 'priceGuardGuardian_equals_feeRecipient']);
});

test('artifact evidence binds current sources, both consumers, creation bytecode and metadata', async () => {
  const loaded = loadBlockArtifacts(artifacts.directory, viem);
  assert.equal(loaded.library.keccak256, loaded.priceGuard.sourceHashes[librarySource].keccak256);
  assert.equal(loaded.library.keccak256, loaded.readHelper.sourceHashes[librarySource].keccak256);
  assert.equal(loaded.probe.creationCodeHash, viem.keccak256(compiledCreation));
  assert.match(loaded.probe.artifactSha256, /^[0-9a-f]{64}$/);
  const { rpc, calls } = fixture();
  const result = await run({ rpc });
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.blockArtifacts.status, 'pass');
  assert.equal(result.blockArtifacts.components.probe.creation, undefined);
  assert.equal(result.blockSemantics.compatibility.librarySourceHash, loaded.library.keccak256);
  assert.ok(calls.some(call => call.method === 'eth_call' && call.params[0].data === compiledCreation));
});

test('missing artifacts never qualify even when all raw RPC probes succeed', async () => {
  const { rpc, calls } = fixture();
  const result = await preflight({ rpc, viem, inputs: completeInputs() });
  assert.equal(result.blockArtifacts.status, 'missing');
  assert.equal(result.blockSemantics.compiledProbe.status, 'missing');
  assert.equal(result.blockSemantics.compatibility.status, 'missing');
  assert.ok(!calls.some(call => call.method === 'eth_call' && call.params[0].data === compiledCreation));
});

test('Foundry metadata normalization preserves build-input binding', t => {
  const local = artifactFixture(t);
  local.mutate('probe', artifact => {
    artifact.metadata.settings.remappings = ['x/=src/'];
    const raw = structuredClone(artifact.metadata);
    raw.settings.remappings = [':x/=src/'];
    raw.output = { userdoc: { notice: 'Documentation removed by Foundry parser' } };
    artifact.rawMetadata = JSON.stringify(raw);
  }, false);
  assert.doesNotThrow(() => loadBlockArtifacts(local.directory, viem));
  local.mutate('probe', artifact => { artifact.metadata.settings.remappings = ['x/=wrong/']; }, false);
  assert.throws(() => loadBlockArtifacts(local.directory, viem), /block_artifact_metadata_inconsistent/);
});

test('changed current library and stale consumer metadata stop the compiled probe', async t => {
  const changed = artifactFixture(t);
  writeFileSync(join(changed.directory, 'contracts', librarySource), 'library Changed {}');
  assert.throws(() => loadBlockArtifacts(changed.directory, viem), /block_artifact_source_changed/);
  const stale = artifactFixture(t);
  stale.mutate('readHelper', artifact => { artifact.metadata.sources[librarySource].keccak256 = hash(1); });
  const { rpc, calls } = fixture();
  const result = await run({ rpc, repo: stale.directory });
  assert.equal(result.blockArtifacts.reason, 'block_artifact_source_changed');
  assert.equal(result.blockSemantics.compiledProbe.status, 'fail');
  assert.equal(result.readiness.status, 'fail');
  assert.ok(!calls.some(call => call.method === 'eth_call' && call.params[0].data === compiledCreation));
  assert.ok(!JSON.stringify(result).includes(stale.directory));
});

test('invalid compiler, missing library, inconsistent metadata, unsafe sources, missing bytecode and wrong probe ABI fail closed', t => {
  for (const [component, mutate, reason, updateRawMetadata] of [
    ['probe', a => { a.metadata.settings.optimizer.runs = 201; }, 'profile_mismatch'],
    ['priceGuard', a => { delete a.metadata.sources[librarySource]; }, 'library_missing'],
    ['probe', a => { a.metadata.settings.viaIR = false; }, 'metadata_inconsistent', false],
    ['probe', a => { a.metadata.sources['src/../../private'] = { keccak256: hash(1) }; }, 'source_invalid'],
    ['probe', a => { a.bytecode.object = '0x'; }, 'bytecode_invalid'],
    ['probe', a => { a.abi[0].inputs = [{ name: 'unused', type: 'uint256' }]; }, 'probe_abi_invalid'],
  ]) {
    const local = artifactFixture(t);
    local.mutate(component, mutate, updateRawMetadata ?? true);
    assert.throws(() => loadBlockArtifacts(local.directory, viem), new RegExp('block_artifact_' + reason));
  }
  const missing = artifactFixture(t);
  rmSync(missing.paths.readHelper);
  assert.throws(() => loadBlockArtifacts(missing.directory, viem), /block_artifact_unavailable_or_malformed/);
});

test('compiled mismatches and malformed or unavailable responses never produce compatibility pass', async () => {
  for (const options of [{ probeOutput: hash(500) + hash(997).slice(2) },
    { probeOutput: hash(998) + hash(0).slice(2) }, { probeOutput: hash(998) },
    { probeOutput: hash(998) + hash(997).slice(2) + '00' }, { unavailableProbe: true }]) {
    const result = await run({ rpc: fixture(options).rpc });
    assert.notEqual(result.blockSemantics.compiledProbe.status, 'pass');
    assert.notEqual(result.blockSemantics.compatibility.status, 'pass');
    assert.equal(result.deploymentReady, false);
    assert.ok(!JSON.stringify(result).includes('private-provider'));
  }
});

test('direct ArbSys disagreement fails even if compiled probe appears correct', async () => {
  for (const options of [{ arbNumber: 500 }, { arbHash: hash(0) }]) {
    const result = await run({ rpc: fixture(options).rpc });
    assert.equal(result.blockSemantics.compiledProbe.status, 'pass');
    assert.equal(result.blockSemantics.compatibility.status, 'fail');
  }
});

test('unavailable native opcode diagnostic does not invalidate qualified production path', async () => {
  const result = await run({ rpc: fixture({ unsupportedCreation: true }).rpc });
  assert.equal(result.blockSemantics.numberOpcode.status, 'unavailable');
  assert.equal(result.blockSemantics.compiledProbe.status, 'pass');
  assert.equal(result.blockSemantics.compatibility.status, 'pass');
});

test('pruned finalized state stays unavailable until latest is explicitly selected', async () => {
  const { rpc, calls } = fixture({ prunedFinalized: true });
  const result = await run({ rpc });
  assert.equal(result.snapshot.tag, 'finalized');
  assert.equal(result.blockSemantics.compiledProbe.status, 'unavailable');
  assert.equal(result.blockSemantics.compatibility.status, 'unavailable');
  for (const call of calls.filter(call => call.method === 'eth_call')) assert.equal(call.params[1].blockHash, hash(998));
  const explicit = await run({ rpc: fixture({ prunedFinalized: true }).rpc, snapshotTag: 'latest' });
  assert.equal(explicit.blockSemantics.compatibility.status, 'pass');
  assert.equal(explicit.blockSemantics.compatibility.snapshotTag, 'latest');
});

test('inherited read-only transport refuses sending and signing methods before network access', async () => {
  const rpc = readOnlyRpc('http://127.0.0.1:1');
  for (const method of ['eth_sendTransaction', 'eth_sendRawTransaction', 'eth_sign', 'personal_sign', 'wallet_sendCalls'])
    await assert.rejects(() => rpc(method, []), /readonly_rpc_budget/);
});

test('CLI writes failed observations, exits nonzero and does not disclose private endpoint information', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'domino-mainnet-preflight-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { rpc } = fixture({ chainId: '0x1' });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: await rpc(message.method, message.params) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const endpointFile = join(directory, 'private-rpc');
  writeFileSync(endpointFile, `http://127.0.0.1:${server.address().port}/synthetic-secret-path`, { mode: 0o600 });
  const outputFile = join(directory, 'preflight.json');
  const child = spawn(process.execPath, [join(repo, 'scripts/audit-v4-mainnet-preflight.mjs'), '--repo', repo,
    '--rpc-file', endpointFile, '--out', outputFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(exit, 2); assert.equal(stderr, '');
  assert.equal(JSON.parse(stdout).readiness.status, 'fail');
  assert.equal(JSON.parse(readFileSync(outputFile, 'utf8')).deploymentReady, false);
  assert.ok(!stdout.includes('synthetic-secret-path') && !stdout.includes(endpointFile));
});
