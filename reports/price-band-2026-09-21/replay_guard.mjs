#!/usr/bin/env node
// Local bytecode replay only. No RPC argument, fork option, keys, or compile step.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const folder = dirname(fileURLToPath(import.meta.url)), repo = resolve(folder, '../..');
const require = createRequire(join(repo, 'package.json'));
const viem = await import(pathToFileURL(createRequire(join(repo, 'app/package.json')).resolve('viem')).href);
const { keccak256, encodeDeployData, encodeFunctionData, decodeFunctionResult, toHex, stringToHex } = viem;
const invalidObservation = keccak256(stringToHex('InvalidObservation()')).slice(0, 10);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const stringify = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';
const pinsPath = join(repo, 'reports/revert-fees-2026-09-21/artifact-verification.json');
const pinsRaw = readFileSync(pinsPath), pins = JSON.parse(pinsRaw);
const bands = [25, 50, 100, 200, 2000];
const artifacts = [];
function artifact(path, contractName) {
  const raw = readFileSync(join(repo, 'contracts/out', path));
  const a = JSON.parse(raw), m = JSON.parse(a.rawMetadata);
  // Foundry normalizes remapping prefixes and removes some empty ABI/doc fields
  // in metadata; use the raw compiler metadata and compare its security inputs.
  assert.deepEqual(a.metadata.compiler, m.compiler);
  assert.deepEqual(a.metadata.sources, m.sources);
  for (const key of ['optimizer', 'metadata', 'compilationTarget', 'evmVersion', 'libraries', 'viaIR']) assert.deepEqual(a.metadata.settings[key], m.settings[key]);
  assert.equal(m.compiler.version, '0.8.26+commit.8a97fa7a');
  assert.equal(m.settings.evmVersion, 'cancun');
  assert.equal(m.settings.viaIR, true);
  assert.deepEqual(m.settings.optimizer, { enabled: true, runs: 200 });
  assert.deepEqual(Object.values(m.settings.compilationTarget), [contractName]);
  assert.deepEqual(m.settings.libraries, {});
  assert.deepEqual(a.bytecode.linkReferences, {});
  assert.deepEqual(a.deployedBytecode.linkReferences, {});
  const sources = Object.entries(m.sources).map(([file, value]) => {
    const sourceHash = keccak256(toHex(readFileSync(join(repo, 'contracts', file))));
    assert.equal(sourceHash, value.keccak256, 'stale compiled source: ' + file);
    return { file, keccak256: sourceHash };
  });
  const proof = { path: 'contracts/out/' + path, artifactSha256: sha(raw), sources,
    compiler: m.compiler.version, creationCodeHash: keccak256(a.bytecode.object),
    runtimeTemplateHash: keccak256(a.deployedBytecode.object) };
  if (contractName === 'DominoPriceGuardV4') {
    const pin = pins.artifacts.find(x => x.component === 'priceGuard');
    for (const field of ['artifactSha256', 'creationCodeHash', 'runtimeTemplateHash']) assert.equal(proof[field], pin[field], field + ' pin');
    for (const source of sources) assert.equal(source.keccak256, pins.sources.find(x => x.file === 'contracts/' + source.file)?.keccak256);
    proof.productionPinsVerified = true;
  }
  artifacts.push(proof);
  return a;
}
const guardArtifact = artifact('DominoPriceGuardV4.sol/DominoPriceGuardV4.json', 'DominoPriceGuardV4');
const stateArtifact = artifact('DominoPriceGuardV4.t.sol/MockGuardStateView.json', 'MockGuardStateView');
const nitroArtifact = artifact('NitroTestSetup.sol/MockNitroArbSys.json', 'MockNitroArbSys');
const samplesPath = join(folder, 'LIVE_SAMPLES.json'), samplesRaw = readFileSync(samplesPath), live = JSON.parse(samplesRaw);
assert.equal(live.chainId, 4663); assert.equal(live.mainnetTransactionsSent, false);
const cases = [], boundaryPool = keccak256(stringToHex('local guard replay boundaries'));
function add(label, band, reference, spot, extra = {}) {
  assert(reference >= 0n && reference < 2n ** 160n && spot >= 0n && spot < 2n ** 160n);
  cases.push({ label, band, reference, spot, poolId: boundaryPool, ageBlocks: 1, ...extra });
}
for (const band of bands) {
  for (const spot of [10n ** 30n, (1n << 96n) + 123n, 1n << 150n]) {
    const low = (spot * BigInt(10000 - band) + 9999n) / 10000n;
    const high = spot * BigInt(10000 + band) / 10000n;
    for (const [name, value, expected] of [['lower-outside', low - 1n, false], ['lower-edge', low, true], ['lower-inside', low + 1n, true],
      ['upper-inside', high - 1n, true], ['upper-edge', high, true], ['upper-outside', high + 1n, false]]) {
      add(name, band, value, spot, { expected });
    }
  }
  add('zero-reference', band, 0n, 10n ** 30n, { expected: false });
  add('zero-spot', band, 10n ** 30n, 0n, { expected: false });
  for (const ageBlocks of [255, 256, 257]) add('block-age-' + ageBlocks, band, 10n ** 30n, 10n ** 30n, { ageBlocks, expected: ageBlocks < 256 });
}
add('denominator-later-spot-accept', 50, 19900n, 20000n, { expected: true });
add('denominator-later-spot-reject', 50, 20000n, 19900n, { expected: false });
const samplePairs = [];
for (const pool of live.pools) {
  for (const delayMs of [500, 20000]) {
    const sourceIndex = live.samples.findIndex(sample => sample.pools?.some(row => row.poolId === pool.poolId && !row.error && BigInt(row.sqrtPriceX96 ?? 0) > 0n));
    assert(sourceIndex >= 0, 'no reference sample for pool');
    const source = live.samples[sourceIndex];
    const futureIndex = live.samples.findIndex((sample, i) => i > sourceIndex && sample.observedAtUnixMs >= source.observedAtUnixMs + delayMs);
    assert(futureIndex >= 0, 'sample window too short for bounded replay');
    const future = live.samples[futureIndex];
    const before = source.pools.find(row => row.poolId === pool.poolId), after = future.pools?.find(row => row.poolId === pool.poolId);
    if (!after || after.error || BigInt(after.sqrtPriceX96 ?? 0) === 0n) {
      samplePairs.push({ poolId: pool.poolId, sourceIndex, futureIndex, delayMs, status: 'missing-first-future-pool-read' });
      continue; // Never skip to a later successful pool read.
    }
    const pair = { poolId: pool.poolId, sourceIndex, futureIndex, delayMs,
      observedDelayMs: future.observedAtUnixMs - source.observedAtUnixMs,
      sourceBlock: source.blockNumber, laterBlock: future.blockNumber,
      sourceSqrtPriceX96: before.sqrtPriceX96, laterSqrtPriceX96: after.sqrtPriceX96 };
    samplePairs.push(pair);
    const ageBlocks = Number(BigInt(future.blockNumber) - BigInt(source.blockNumber));
    assert(ageBlocks >= 0 && ageBlocks < 1000000);
    for (const band of bands) add('live-pair', band, BigInt(before.sqrtPriceX96), BigInt(after.sqrtPriceX96), { poolId: pool.poolId, ageBlocks, pair });
  }
}
assert(samplePairs.some(p => p.sourceSqrtPriceX96 !== undefined), 'no usable live pairs');
// Compare every decision to the independently implemented Python analyzer, not
// a second JavaScript copy of our boundary formula.
const analyzerPath = join(folder, 'analyze.py');
const analyzerResults = JSON.parse(execFileSync('python3', ['-B', '-c',
  'import importlib.util,json,sys; s=importlib.util.spec_from_file_location("analyzer",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps([m.within_band(int(r[0]),int(r[1]),r[2]) for r in json.load(sys.stdin)]))', analyzerPath],
  { input: stringify(cases.map(c => [c.reference, c.spot, c.band])), encoding: 'utf8' }));
for (let i = 0; i < cases.length; i++) {
  cases[i].analyzerBandPass = analyzerResults[i];
  cases[i].analyzerPublishPass = analyzerResults[i] && cases[i].ageBlocks >= 1 && cases[i].ageBlocks < 256;
  if ('expected' in cases[i]) assert.equal(cases[i].analyzerPublishPass, cases[i].expected, 'analyzer edge mismatch');
}
const platform = await import(pathToFileURL(require.resolve('@foundry-rs/anvil/const.mjs')).href);
const binary = require.resolve(platform.PLATFORM_SPECIFIC_PACKAGE_NAME('anvil') + '/bin/' + platform.BINARY_NAME('anvil'));
const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done));
const port = server.address().port; await new Promise(done => server.close(done));
const child = spawn(binary, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '4663', '--hardfork', 'cancun', '--silent'], { stdio: 'ignore' });
const endpoint = 'http://127.0.0.1:' + port;
let requestId = 0, transactions = 0, publisher, guardian;
async function rpc(method, params = []) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }), signal: AbortSignal.timeout(5000) });
  const body = await response.json();
  if (body.error) throw Object.assign(new Error(body.error.message), { rpcError: body.error });
  return body.result;
}
async function send(to, data) {
  const hash = await rpc('eth_sendTransaction', [{ from: publisher, ...(to ? { to } : {}), data, gas: '0x989680', value: '0x0' }]);
  transactions++;
  for (let attempt = 0; attempt < 100; attempt++) {
    const receipt = await rpc('eth_getTransactionReceipt', [hash]);
    if (receipt) { assert.equal(receipt.status, '0x1'); return receipt; }
    await new Promise(done => setTimeout(done, 10));
  }
  throw new Error('local receipt timeout');
}
const callData = (a, functionName, args = []) => encodeFunctionData({ abi: a.abi, functionName, args });
async function read(to, a, functionName, args = []) {
  return decodeFunctionResult({ abi: a.abi, functionName, data: await rpc('eth_call', [{ to, from: publisher, data: callData(a, functionName, args) }, 'latest']) });
}
function normalized(code, a) {
  const bytes = Buffer.from(code.slice(2), 'hex');
  for (const ranges of Object.values(a.deployedBytecode.immutableReferences ?? {})) for (const { start, length } of ranges) bytes.fill(0, start, start + length);
  return '0x' + bytes.toString('hex');
}
async function deploy(a, args) {
  const receipt = await send(null, encodeDeployData({ abi: a.abi, bytecode: a.bytecode.object, args }));
  const code = await rpc('eth_getCode', [receipt.contractAddress, 'latest']);
  assert.equal(normalized(code, a), normalized(a.deployedBytecode.object, a));
  return { address: receipt.contractAddress, runtimeHash: keccak256(code), runtimeTemplateVerified: true };
}
const results = [], storedAgeChecks = [], deployments = [];
try {
  for (let attempt = 0;; attempt++) {
    try { assert.equal(await rpc('eth_chainId'), '0x1237'); break; }
    catch (error) { if (attempt >= 100) throw error; await new Promise(done => setTimeout(done, 25)); }
  }
  [publisher, guardian] = await rpc('eth_accounts');
  const arbSys = '0x0000000000000000000000000000000000000064';
  await rpc('anvil_setCode', [arbSys, nitroArtifact.deployedBytecode.object]);
  assert.equal(await rpc('eth_getCode', [arbSys, 'latest']), nitroArtifact.deployedBytecode.object);
  const state = await deploy(stateArtifact, []);
  const guards = new Map();
  for (const band of bands) {
    const guard = await deploy(guardArtifact, [publisher, state.address, BigInt(band), guardian]);
    assert.equal((await read(guard.address, guardArtifact, 'publisher')).toLowerCase(), publisher);
    assert.equal((await read(guard.address, guardArtifact, 'guardian')).toLowerCase(), guardian);
    assert.equal((await read(guard.address, guardArtifact, 'stateView')).toLowerCase(), state.address);
    assert.equal(await read(guard.address, guardArtifact, 'maxDeviationBps'), BigInt(band));
    assert.equal(await read(guard.address, guardArtifact, 'MAX_OBSERVATION_BLOCKS'), 256n);
    guards.set(band, guard.address); deployments.push({ band, ...guard, immutablesVerified: true });
  }
  await rpc('anvil_mine', [toHex(1024)]);
  for (const c of cases) {
    await send(state.address, callData(stateArtifact, 'set', [c.poolId, c.spot]));
    if (c.ageBlocks > 1024) await rpc('anvil_mine', [toHex(c.ageBlocks)]);
    const latest = await rpc('eth_getBlockByNumber', ['latest', false]);
    const prior = await rpc('eth_getBlockByNumber', [toHex(BigInt(latest.number) - BigInt(c.ageBlocks)), false]);
    const point = { poolId: c.poolId, blockNumber: BigInt(prior.number), blockHash: prior.hash,
      timestamp: BigInt(latest.timestamp), expiresAt: BigInt(latest.timestamp) + 86400n, sqrtPriceX96: c.reference };
    let accepted = true, revert = null;
    try { await read(guards.get(c.band), guardArtifact, 'publish', [point]); }
    catch (error) {
      assert(error.rpcError, 'transport or decoding error is not a contract rejection');
      assert.equal(error.rpcError.data, invalidObservation, 'unexpected custom error');
      accepted = false; revert = error.rpcError.data;
    }
    assert.equal(accepted, c.analyzerPublishPass, 'bytecode/analyzer mismatch: ' + c.label);
    results.push({ ...c, bytecodePublishPass: accepted, revert, localSourceBlock: prior.number, localPublicationBlock: latest.number });
  }
  // A real local publish persists an observation; referencePrice remains valid
  // at age255 and rejects at age256, even with an unexpired timestamp.
  for (const band of bands) {
    const guard = guards.get(band), price = 1n << 96n;
    await send(state.address, callData(stateArtifact, 'set', [boundaryPool, price]));
    const latest = await rpc('eth_getBlockByNumber', ['latest', false]);
    const prior = await rpc('eth_getBlockByNumber', [toHex(BigInt(latest.number) - 1n), false]);
    const point = { poolId: boundaryPool, blockNumber: BigInt(prior.number), blockHash: prior.hash,
      timestamp: BigInt(latest.timestamp), expiresAt: BigInt(latest.timestamp) + 86400n, sqrtPriceX96: price };
    const id = await read(guard, guardArtifact, 'publish', [point]);
    await send(guard, callData(guardArtifact, 'publish', [point]));
    const now = BigInt(await rpc('eth_blockNumber'));
    await rpc('anvil_mine', [toHex(point.blockNumber + 255n - now)]);
    const args = [id, boundaryPool, point.blockNumber, point.blockHash, 86400];
    assert.equal(await read(guard, guardArtifact, 'referencePrice', args), price);
    await rpc('anvil_mine', ['0x1']);
    await assert.rejects(read(guard, guardArtifact, 'referencePrice', args), error => error.rpcError?.data === invalidObservation);
    storedAgeChecks.push({ band, id, published: true, age255Accepted: true, age256Rejected: true });
  }
  const output = { schemaVersion: 1, generatedAtUTC: new Date().toISOString(), status: 'PASS',
    scope: 'real compiled guard on isolated local Anvil; no fork; synthetic unlocked accounts; no mainnet transactions',
    limitations: ['Pool spot is supplied by MockGuardStateView; ArbSys is explicitly mocked using local EVM block context.',
      'Sample square-root prices and block gaps are replayed with local hashes and timestamps; this is not mainnet inclusion, transport latency, or independent-oracle qualification.',
      'Only the first 500ms and 20s eligible sample pairs per pool are replayed, not the whole collection. Missing first future reads are never skipped.'],
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    scriptSha256: sha(readFileSync(fileURLToPath(import.meta.url))), analyzerSha256: sha(readFileSync(analyzerPath)),
    pins: { file: 'reports/revert-fees-2026-09-21/artifact-verification.json', sha256: sha(pinsRaw), sourceFreeze: pins.sourceFreeze },
    artifacts, anvilVersion: execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(),
    sampleInput: { file: 'LIVE_SAMPLES.json', sha256: sha(samplesRaw), sampleCount: live.samples.length,
      startedAtUTC: live.startedAtUTC, endedAtUTC: live.endedAtUTC ?? null,
      status: live.status ?? null, collectorSha256: live.collectorSha256 ?? null,
      noncanonicalBlocks: live.noncanonicalBlocks ?? null, canonicalityCheckedBlocks: live.canonicalityCheckedBlocks ?? null,
      firstObservedAtUnixMs: live.samples[0]?.observedAtUnixMs, lastObservedAtUnixMs: live.samples.at(-1)?.observedAtUnixMs },
    bands, deployments, syntheticStateView: state, syntheticArbSysRuntimeHash: keccak256(nitroArtifact.deployedBytecode.object),
    localTransactions: transactions, samplePairs, checks: { publishCases: results.length, storedAgeCases: storedAgeChecks.length * 2,
      allBytecodeAnalyzerDecisionsAgree: true, allSourceAndCodePinsVerified: true }, results, storedAgeChecks };
  writeFileSync(join(folder, 'guard-replay-results.json'), stringify(output));
  console.log(stringify(output.checks));
} finally { child.kill('SIGTERM'); await new Promise(done => child.once('exit', done)); }
