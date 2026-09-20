#!/usr/bin/env node
/** Build unsigned deployment transactions, or verify their finalized receipts.
 * This module has no key loader, signer, send method or wallet integration.
 */
import { readFileSync, readSync, writeFileSync, openSync, closeSync, fstatSync, constants, realpathSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const CHAIN_ID = 4663;
export const DEPENDENCIES = Object.freeze({
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  positionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
  stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
});
export const CONTRACTS = Object.freeze({
  factory: 'DominoVaultFactoryV4', readHelper: 'DominoVaultReadHelper',
  routing: 'DominoRoutingHelperV4', priceGuard: 'DominoPriceGuardV4',
  engine: 'DominoExecutionEngineV4', implementation: 'DominoVaultV4', setup: 'DominoSetup',
});
const addressPattern = /^0x[0-9a-f]{40}$/;
const hashPattern = /^0x[0-9a-f]{64}$/;
const zeroAddress = '0x' + '0'.repeat(40);
const assert = (condition, code) => { if (!condition) throw new Error(code); };
const uint = (value, bits = 256) => {
  assert(typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value), 'invalid_decimal_integer');
  const number = BigInt(value); assert(number < 2n ** BigInt(bits), 'integer_out_of_range'); return number;
};
const quantity = value => { assert(typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value), 'invalid_rpc_quantity'); return BigInt(value); };
const hex = value => { assert(typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/.test(value), 'invalid_hex'); return value; };
const address = value => { assert(typeof value === 'string' && addressPattern.test(value) && value !== zeroAddress, 'invalid_address'); return value; };
const keys = (value, expected) => assert(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join() === [...expected].sort().join(), 'invalid_record_keys');
const digest = raw => createHash('sha256').update(raw).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const canonical = value => JSON.stringify(value, (_, x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);

export function readBounded(path, maximum = 8 * 1024 * 1024) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd); assert(info.isFile() && info.nlink === 1 && info.size <= maximum, 'invalid_input_file');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

export function toolsFor(repo) {
  const require = createRequire(join(resolve(repo), 'app/package.json'));
  return require('viem');
}

export function loadArtifacts(repo, viem = toolsFor(repo), artifactDirectory = join(repo, 'contracts/out')) {
  const artifacts = {};
  for (const [component, name] of Object.entries(CONTRACTS)) {
    const raw = readBounded(join(artifactDirectory, name + '.sol', name + '.json'));
    const artifact = JSON.parse(raw);
    const metadata = artifact.metadata;
    assert(metadata?.compiler?.version === '0.8.26+commit.8a97fa7a'
      && metadata.settings?.compilationTarget?.['src/' + name + '.sol'] === name
      && metadata.settings?.optimizer?.enabled === true && metadata.settings.optimizer.runs === 200
      && metadata.settings?.viaIR === true && metadata.settings?.evmVersion === 'cancun'
      && metadata.settings?.metadata?.bytecodeHash === 'none', 'artifact_compiler_or_target_mismatch');
    for (const [path, source] of Object.entries(metadata.sources)) {
      assert((path.startsWith('src/') || path.startsWith('lib/') || path.startsWith('test/reference/official-v4/'))
        && !path.split('/').some(p => p === '..' || p === '.') && !path.includes('\\'), 'unsafe_artifact_source');
      const sourcePath = realpathSync(join(repo, 'contracts', path));
      assert(sourcePath.startsWith(realpathSync(join(repo, 'contracts')) + sep), 'artifact_source_outside_contracts');
      assert(viem.keccak256('0x' + readBounded(sourcePath).toString('hex')) === source.keccak256, 'artifact_source_changed');
    }
    const creation = hex(artifact.bytecode.object), runtime = hex(artifact.deployedBytecode.object);
    assert(creation.length > 2 && runtime.length > 2 && (runtime.length - 2) / 2 <= 24576, 'runtime_size_limit');
    assert(Object.keys(artifact.bytecode.linkReferences ?? {}).length === 0
      && Object.keys(artifact.deployedBytecode.linkReferences ?? {}).length === 0, 'unlinked_artifact');
    const ranges = Object.values(artifact.deployedBytecode.immutableReferences ?? {}).flat();
    const occupied = new Set();
    for (const { start, length } of ranges) {
      assert(Number.isSafeInteger(start) && start >= 0 && length === 32 && start + length <= (runtime.length - 2) / 2, 'invalid_immutable_range');
      for (let offset = start; offset < start + length; offset++) {
        assert(!occupied.has(offset), 'overlapping_immutable_range'); occupied.add(offset);
      }
    }
    artifacts[component] = { abi: artifact.abi, creation, runtime, ranges, sha256: digest(raw),
      creationCodeHash: viem.keccak256(creation), runtimeTemplateHash: viem.keccak256(runtime) };
  }
  return artifacts;
}

export function prepare(parameters, artifacts, viem, now = Date.now() / 1000) {
  keys(parameters, ['chainId', 'sourceCommit', 'deployer', 'nonce', 'feeRecipient', 'operator', 'pricePublisher',
    'priceGuardDeviationBps', 'priceGuardGuardian',
    'setupFeeBps', 'tariffVersion', 'expiresAt', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'maxTotalCostWei', 'reserveWei']);
  assert(parameters.chainId === CHAIN_ID && /^[0-9a-f]{40}$/.test(parameters.sourceCommit), 'wrong_chain_or_commit');
  for (const name of ['deployer', 'feeRecipient', 'operator', 'pricePublisher', 'priceGuardGuardian']) address(parameters[name]);
  assert(parameters.operator !== parameters.pricePublisher, 'price_publisher_must_be_independent');
  // The guardian can replace the publisher, so it is neither the publisher
  // nor the operator: one key must not be able to hand itself the anchor.
  assert(parameters.priceGuardGuardian !== parameters.pricePublisher && parameters.priceGuardGuardian !== parameters.operator,
    'price_guard_guardian_must_be_independent');
  // The band a published price must sit within, against the pool's own
  // reading. Zero would admit any anchor; the contract refuses both ends.
  assert(Number.isSafeInteger(parameters.priceGuardDeviationBps) && parameters.priceGuardDeviationBps > 0
    && parameters.priceGuardDeviationBps < 10000, 'invalid_price_guard_deviation');
  assert(Number.isSafeInteger(parameters.setupFeeBps) && parameters.setupFeeBps >= 0 && parameters.setupFeeBps <= 65, 'invalid_setup_tariff');
  assert(uint(parameters.tariffVersion, 64) > 0n, 'invalid_tariff_version');
  assert(Number.isSafeInteger(parameters.expiresAt) && parameters.expiresAt > now, 'release_expired');
  const firstNonce = uint(parameters.nonce, 64);
  assert(firstNonce + 8n < 2n ** 64n, 'nonce_exhausted');
  const names = [...Object.keys(CONTRACTS), 'finalize'];
  keys(parameters.gas, names);
  const maxFee = uint(parameters.maxFeePerGas, 128), priority = uint(parameters.maxPriorityFeePerGas, 128);
  assert(maxFee > 0n && priority <= maxFee, 'invalid_fee_budget');
  const maximumCost = names.reduce((sum, name) => {
    const gas = uint(parameters.gas[name], 64); assert(gas >= 21000n, 'gas_limit_too_low'); return sum + gas * maxFee;
  }, 0n);
  assert(maximumCost <= uint(parameters.maxTotalCostWei), 'total_gas_budget_exceeded');
  const requiredBalance = maximumCost + uint(parameters.reserveWei);
  const addresses = { ...DEPENDENCIES };
  Object.keys(CONTRACTS).forEach((component, index) => {
    addresses[component] = viem.getContractAddress({ from: parameters.deployer, nonce: firstNonce + BigInt(index) }).toLowerCase();
  });
  assert(new Set(Object.values(addresses)).size === Object.values(addresses).length, 'component_address_collision');
  assert(!Object.values(addresses).includes(parameters.feeRecipient), 'fee_recipient_is_component');
  assert(['operator','pricePublisher','priceGuardGuardian'].every(role => parameters[role] !== parameters.feeRecipient
    && !Object.values(addresses).includes(parameters[role])), 'execution_role_is_component_or_recipient');
  const d = addresses, p = parameters;
  const argumentsByComponent = {
    factory: [d.poolManager, d.positionManager, d.stateView, p.feeRecipient],
    readHelper: [d.positionManager, d.stateView], routing: [], priceGuard: [p.pricePublisher, d.stateView, p.priceGuardDeviationBps, p.priceGuardGuardian],
    engine: [d.factory, d.readHelper, d.routing, d.priceGuard],
    implementation: [d.factory, d.poolManager, d.positionManager, d.stateView, p.feeRecipient, d.readHelper, d.engine],
    setup: [d.poolManager, d.positionManager, d.stateView, p.feeRecipient, p.setupFeeBps, BigInt(p.tariffVersion)],
  };
  const steps = Object.keys(CONTRACTS).map((component, index) => {
    const artifact = artifacts[component];
    assert((hex(artifact.runtime).length - 2) / 2 <= 24576, 'runtime_size_limit');
    const data = viem.encodeDeployData({ abi: artifact.abi, bytecode: artifact.creation, args: argumentsByComponent[component] });
    assert((data.length - 2) / 2 <= 49152, 'initcode_size_limit');
    const calldataCost = Buffer.from(data.slice(2), 'hex').reduce((cost, byte) => cost + (byte === 0 ? 4n : 16n), 0n);
    const minimumGas = 53000n + calldataCost + 2n * BigInt(Math.ceil((data.length - 2) / 64))
      + 200n * BigInt((artifact.runtime.length - 2) / 2);
    assert(uint(p.gas[component]) >= minimumGas, 'deployment_gas_below_intrinsic_and_code_deposit');
    return { component, kind: 'create', expectedAddress: d[component], artifactSha256: artifact.sha256,
      creationCodeHash: artifact.creationCodeHash, runtimeTemplateHash: artifact.runtimeTemplateHash,
      initcodeHash: viem.keccak256(data), runtimeBytes: (artifact.runtime.length - 2) / 2, initcodeBytes: (data.length - 2) / 2,
      transaction: transaction(index, data, p, viem) };
  });
  const finalizeData = viem.encodeFunctionData({ abi: artifacts.factory.abi, functionName: 'finalizeImplementation', args: [d.implementation] });
  steps.push({ component: 'finalize', kind: 'call', expectedAddress: d.factory,
    transaction: { ...transaction(7, finalizeData, p, viem), to: d.factory } });
  const cloneRuntime = '0x363d3d373d3d3d363d73' + d.implementation.slice(2) + '5af43d82803e903d91602b57fd5bf3';
  return { schemaVersion: 1, kind: 'domino-financial-unsigned-release', chainId: CHAIN_ID,
    network: 'Robinhood Chain mainnet', available: false, sourceCommit: p.sourceCommit,
    parameters: structuredClone(p), addresses, steps, cloneRuntime, cloneCodeHash: viem.keccak256(cloneRuntime),
    maximumExecutionGasCostWei: maximumCost.toString(), requiredDeployerBalanceWei: requiredBalance.toString(),
    l2AdditionalFees: 'unqualified', deployment: null };
}

function transaction(index, data, p, viem) {
  const component = [...Object.keys(CONTRACTS), 'finalize'][index];
  return { from: p.deployer, chainId: viem.toHex(CHAIN_ID), type: '0x2', nonce: viem.toHex(BigInt(p.nonce) + BigInt(index)),
    data, value: '0x0', gas: viem.toHex(BigInt(p.gas[component])), maxFeePerGas: viem.toHex(BigInt(p.maxFeePerGas)),
    maxPriorityFeePerGas: viem.toHex(BigInt(p.maxPriorityFeePerGas)), accessList: [] };
}

const equal = (actual, expected) => assert(String(actual).toLowerCase() === String(expected).toLowerCase(), 'deployment_link_mismatch');
function maskRuntime(code, ranges) {
  const data = Buffer.from(hex(code).slice(2), 'hex');
  for (const { start, length } of ranges) data.fill(0, start, start + length);
  return data.toString('hex');
}

export async function verify(manifest, transactionHashes, artifacts, viem, rpc, now = Date.now() / 1000) {
  assert(canonical(manifest) === canonical(prepare(manifest.parameters, artifacts, viem, now)), 'package_changed');
  assert(Array.isArray(transactionHashes) && transactionHashes.length === 8
    && new Set(transactionHashes).size === 8 && transactionHashes.every(h => hashPattern.test(h)), 'eight_transaction_hashes_required');
  equal(quantity(await rpc('eth_chainId', [])), CHAIN_ID);
  const final = await rpc('eth_getBlockByNumber', ['finalized', false]);
  assert(final && hashPattern.test(final.hash) && quantity(final.timestamp) <= BigInt(manifest.parameters.expiresAt), 'invalid_finalized_block');
  const finalNumber = quantity(final.number);
  assert(finalNumber <= BigInt(Number.MAX_SAFE_INTEGER), 'block_number_out_of_range');
  const receipts = [];
  for (let index = 0; index < 8; index++) {
    const step = manifest.steps[index], hash = transactionHashes[index], tx = step.transaction;
    const receipt = await rpc('eth_getTransactionReceipt', [hash]);
    assert(receipt && receipt.transactionHash === hash && quantity(receipt.status) === 1n
      && quantity(receipt.blockNumber) <= finalNumber && receipt.from?.toLowerCase() === tx.from, 'deployment_not_finalized');
    equal(step.kind === 'create' ? receipt.contractAddress : receipt.to, step.expectedAddress);
    assert(step.kind !== 'create' || receipt.to === null, 'deployment_receipt_target');
    const block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
    const position = quantity(receipt.transactionIndex);
    assert(block?.hash === receipt.blockHash && block?.number === receipt.blockNumber && Array.isArray(block.transactions)
      && position < BigInt(block.transactions.length) && block.transactions[Number(position)] === hash, 'deployment_noncanonical');
    const actual = await rpc('eth_getTransactionByHash', [hash]);
    assert(actual && actual.hash === hash && actual.blockHash === receipt.blockHash && actual.blockNumber === receipt.blockNumber
      && actual.transactionIndex === receipt.transactionIndex && actual.from?.toLowerCase() === tx.from
      && (actual.to?.toLowerCase() ?? null) === (tx.to ?? null) && actual.input === tx.data
      && Array.isArray(actual.accessList) && actual.accessList.length === 0, 'deployment_transaction_mismatch');
    for (const field of ['chainId', 'type', 'nonce', 'value', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas']) equal(quantity(actual[field]), quantity(tx[field]));
    receipts.push({ component: step.component, transactionHash: hash, blockNumber: Number(quantity(receipt.blockNumber)), blockHash: receipt.blockHash });
  }
  const codeHashes = {}, d = manifest.addresses, p = manifest.parameters;
  const block = { blockHash: final.hash, requireCanonical: true };
  for (const [component, contract] of Object.entries(d)) {
    const code = hex(await rpc('eth_getCode', [contract, block]));
    assert(code.length > 2 && (code.length - 2) / 2 <= 24576, 'deployment_code_missing');
    if (artifacts[component]) {
      const artifact = artifacts[component];
      assert(code.length === artifact.runtime.length && maskRuntime(code, artifact.ranges) === maskRuntime(artifact.runtime, artifact.ranges), 'deployment_code_changed');
    }
    codeHashes[component] = viem.keccak256(code);
  }
  for (const role of ['operator','pricePublisher'])
    assert(hex(await rpc('eth_getCode', [p[role], block])) === '0x', 'execution_role_must_be_eoa');
  const checks = {
    factory: { poolManager: d.poolManager, positionManager: d.positionManager, stateView: d.stateView,
      serviceFeeRecipient: p.feeRecipient, deployer: p.deployer, implementation: d.implementation, implementationCodeHash: codeHashes.implementation },
    readHelper: { positionManager: d.positionManager, stateView: d.stateView }, routing: {}, priceGuard: { publisher: p.pricePublisher, stateView: d.stateView, maxDeviationBps: p.priceGuardDeviationBps, guardian: p.priceGuardGuardian },
    engine: { factory: d.factory, readHelper: d.readHelper, routingHelper: d.routing, priceGuard: d.priceGuard,
      readHelperHash: codeHashes.readHelper, routingHelperHash: codeHashes.routing, priceGuardHash: codeHashes.priceGuard },
    implementation: { factory: d.factory, implementation: d.implementation, implementationVersion: 4,
      poolManager: d.poolManager, positionManager: d.positionManager, stateView: d.stateView, serviceFeeRecipient: p.feeRecipient,
      readHelper: d.readHelper, executionEngine: d.engine, readHelperCodeHash: codeHashes.readHelper,
      executionEngineCodeHash: codeHashes.engine, poolManagerCodeHash: codeHashes.poolManager,
      positionManagerCodeHash: codeHashes.positionManager, stateViewCodeHash: codeHashes.stateView },
    setup: { manager: d.poolManager, positions: d.positionManager, stateView: d.stateView,
      feeRecipient: p.feeRecipient, assistedFeeBps: p.setupFeeBps, tariffVersion: p.tariffVersion },
  };
  for (const [component, getters] of Object.entries(checks)) for (const [getter, expected] of Object.entries(getters)) {
    const abi = artifacts[component].abi;
    const data = await rpc('eth_call', [{ to: d[component], data: viem.encodeFunctionData({ abi, functionName: getter }) }, block]);
    equal(viem.decodeFunctionResult({ abi, functionName: getter, data: hex(data) }), expected);
  }
  const linkAbi = viem.parseAbi(['function poolManager() view returns(address)']);
  for (const component of ['positionManager', 'stateView']) {
    const result = await rpc('eth_call', [{ to: d[component], data: viem.encodeFunctionData({ abi: linkAbi, functionName: 'poolManager' }) }, block]);
    equal(viem.decodeFunctionResult({ abi: linkAbi, functionName: 'poolManager', data: hex(result) }), d.poolManager);
  }
  const canonicalFinal = await rpc('eth_getBlockByNumber', [final.number, false]);
  assert(canonicalFinal?.hash === final.hash && canonicalFinal.number === final.number, 'finalized_block_changed');
  assert(Math.max(now, Date.now() / 1000) < p.expiresAt, 'release_expired');
  const setup = { contractVersion: '1.0.0-rc.1', chainId: CHAIN_ID, available: true, deployment: {
    setup: d.setup, setupCodeHash: codeHashes.setup, ...DEPENDENCIES,
    poolManagerCodeHash: codeHashes.poolManager, positionManagerCodeHash: codeHashes.positionManager,
    stateViewCodeHash: codeHashes.stateView, feeRecipient: p.feeRecipient,
    feeBps: p.setupFeeBps, tariffVersion: p.tariffVersion, expiresAt: p.expiresAt } };
  const { setup: unusedSetup, ...sequenceAddresses } = d;
  const { setup: unusedHash, ...sequenceHashes } = codeHashes;
  const sequence = { contractVersion: '1.0.0-rc.1', chainId: CHAIN_ID, available: true, deployment: {
    ...sequenceAddresses, serviceFeeRecipient: p.feeRecipient, operator: p.operator, pricePublisher: p.pricePublisher,
    serviceFeeBps: 200, expiresAt: p.expiresAt, codeHashes: { ...sequenceHashes, vault: manifest.cloneCodeHash } } };
  return { schemaVersion: 1, kind: 'domino-financial-verified-release', chainId: CHAIN_ID,
    sourceCommit: manifest.sourceCommit, packageSha256: digest(canonical(manifest)),
    verifiedBlock: { number: Number(finalNumber), hash: final.hash, timestamp: Number(quantity(final.timestamp)) },
    receipts, setup, sequence, executionAvailable: false, operatorFundingQualified: false, priceObservationQualified: false };
}

function rpcUrl(endpoint) {
  try {
    assert(typeof endpoint === 'string' && /^[\x21-\x7e]{1,1536}$/.test(endpoint), 'public_rpc_url_required');
    const url = new URL(endpoint);
    assert((url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))
      && !url.username && !url.password && !url.hash && !url.search, 'public_rpc_url_required');
    return url;
  } catch { throw new Error('public_rpc_url_required'); }
}

/** Read the URL from an owner-only regular file; never include its path/content in errors. */
export function verificationRpcEndpoint(options) {
  const direct = Object.hasOwn(options, 'rpc'), file = Object.hasOwn(options, 'rpc-file');
  assert(direct !== file, 'exactly_one_rpc_source_required');
  if (direct) { rpcUrl(options.rpc); return options.rpc; }
  let fd;
  try {
    fd = openSync(options['rpc-file'], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    assert(info.isFile() && info.nlink === 1 && info.size > 0 && info.size <= 1538
      && typeof process.getuid === 'function' && info.uid === process.getuid() && !(info.mode & 0o077), 'invalid_private_rpc_file');
    // Bound the read too: a file growing after fstat must not allocate without limit.
    const buffer = Buffer.alloc(1539);
    let size = 0, count;
    while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += count;
    assert(size <= 1538, 'invalid_private_rpc_file');
    const endpoint = buffer.subarray(0, size).toString('utf8').replace(/\r?\n$/, '');
    rpcUrl(endpoint);
    return endpoint;
  } catch { throw new Error('invalid_private_rpc_file'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function readOnlyRpc(endpoint) {
  const url = rpcUrl(endpoint);
  const allowed = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call',
    'eth_getTransactionReceipt', 'eth_getTransactionByHash']);
  let calls = 0;
  const end = Date.now() + 90000;
  return async (method, params) => {
    assert(allowed.has(method) && ++calls <= 160 && Date.now() < end, 'readonly_rpc_budget');
    const response = await fetch(url, { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, Math.min(5000, end - Date.now()))),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: calls, method, params }) });
    assert(response.ok, 'rpc_unavailable');
    const reader = response.body.getReader(); let size = 0; const chunks = [];
    try { for (;;) { const { value, done } = await reader.read(); if (done) break;
      size += value.length; assert(size <= 1048576, 'rpc_reply_too_large'); chunks.push(value); }
    } finally { await reader.cancel(); }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    keys(result, ['jsonrpc', 'id', 'result']); assert(result.jsonrpc === '2.0' && result.id === calls, 'rpc_invalid_reply');
    return result.result;
  };
}

export async function main(argv) {
  const [action, ...args] = argv;
  assert(['prepare', 'verify'].includes(action) && args.length % 2 === 0, 'usage_prepare_or_verify');
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    assert(args[index].startsWith('--') && !Object.hasOwn(options, args[index].slice(2)), 'invalid_cli_option');
    options[args[index].slice(2)] = args[index + 1];
  }
  const endpoint = action === 'verify' ? verificationRpcEndpoint(options) : undefined;
  const expected = action === 'prepare' ? ['repo', 'parameters', 'out']
    : ['repo', 'package', 'transactions', Object.hasOwn(options, 'rpc-file') ? 'rpc-file' : 'rpc', 'out'];
  keys(options, Object.hasOwn(options, 'artifacts') ? [...expected, 'artifacts'] : expected);
  const repo = resolve(options.repo), viem = toolsFor(repo), artifacts = loadArtifacts(repo, viem, options.artifacts);
  let result;
  if (action === 'prepare') {
    const parameters = JSON.parse(readBounded(options.parameters, 16384));
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    assert(parameters.sourceCommit === commit, 'source_commit_mismatch');
    execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'contracts/src', 'contracts/foundry.toml'], { cwd: repo });
    result = prepare(parameters, artifacts, viem);
  } else {
    const manifest = JSON.parse(readBounded(options.package));
    assert(manifest.sourceCommit === execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), 'source_commit_mismatch');
    execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'contracts/src', 'contracts/foundry.toml'], { cwd: repo });
    result = await verify(manifest, JSON.parse(readBounded(options.transactions, 4096)),
      artifacts, viem, readOnlyRpc(endpoint));
  }
  writeFileSync(options.out, json(result), { flag: 'wx', mode: 0o600 });
  return { kind: result.kind, transactions: result.steps?.length ?? result.receipts.length, available: result.available ?? true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(json(await main(process.argv.slice(2)))); }
  catch { process.stderr.write('Financial release preparation/verification failed; no transaction was signed or sent.\n'); process.exitCode = 1; }
}
