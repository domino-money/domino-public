import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { DEPENDENCIES, toolsFor, readOnlyRpc } from './prepare-financial-release.mjs';
import { ARB_SYS, NUMBER_PROBE, preflight, publicInputs } from './audit-v4-mainnet-preflight.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const viem = toolsFor(repo);
const hash = number => viem.toHex(BigInt(number), { size: 32 });
const block = number => ({ number: viem.toHex(number), hash: hash(number), parentHash: hash(number - 1n), timestamp: '0x6553f100', l1BlockNumber: '0x1f4' });
const code = '0x6000';
const completeInputs = () => ({ deployer: '0x' + '11'.repeat(20), operator: '0x' + '22'.repeat(20),
  pricePublisher: '0x' + '33'.repeat(20), priceGuardGuardian: '0x' + '44'.repeat(20), feeRecipient: '0x' + '55'.repeat(20),
  dependencyCodeHashes: Object.fromEntries(Object.keys(DEPENDENCIES).map(name => [name, viem.keccak256(code)])) });
const arbAbi = viem.parseAbi(['function arbBlockNumber() view returns (uint256)', 'function arbBlockHash(uint256) view returns (bytes32)']);

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
      const current = BigInt(pinned.blockHash);
      if (data === NUMBER_PROBE) {
        if (options.unsupportedCreation) throw new Error('https://rpc.invalid/secret-key');
        return hash(options.numberOpcode ?? current);
      }
      if (data.startsWith('0x7f')) return options.blockhashOpcode ?? hash(current - 1n);
      if (to === ARB_SYS) {
        const decoded = viem.decodeFunctionData({ abi: arbAbi, data });
        if (decoded.functionName === 'arbBlockNumber') return options.emptyArb ? '0x' : hash(current);
        assert.equal(decoded.functionName, 'arbBlockHash');
        assert.equal(decoded.args[0], current - 1n);
        return hash(current - 1n);
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
  const result = await preflight({ rpc, viem, inputs: completeInputs() });
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

test('Nitro ancestor NUMBER and BLOCKHASH domains explicitly fail frozen-contract compatibility', async () => {
  const { rpc } = fixture({ numberOpcode: 500n, blockhashOpcode: hash(0) });
  const result = await preflight({ rpc, viem });
  assert.equal(result.blockSemantics.numberOpcode.value, '500');
  assert.equal(result.blockSemantics.arbBlockNumber.value, '998');
  assert.equal(result.blockSemantics.arbBlockHash.status, 'pass');
  assert.equal(result.blockSemantics.compatibility.reason, 'frozen_contracts_use_incompatible_block_domain');
  assert.equal(result.readiness.status, 'fail');
  assert.equal(result.deploymentReady, false);
  assert.equal(result.roles.deployer.status, 'missing');
  assert.equal(result.dependencies.poolManager.pin.status, 'missing');
});

test('unavailable RPC probes and missing public inputs stay distinct and never reflect provider errors', async () => {
  const { rpc } = fixture({ unsupportedCreation: true, noFinalized: true, emptyArb: true });
  const result = await preflight({ rpc, viem, snapshotTag: 'latest' });
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
  const defaultResult = await preflight({ rpc: fixture({ noFinalized: true }).rpc, viem });
  assert.equal(defaultResult.snapshot.tag, 'finalized');
  assert.equal(defaultResult.snapshot.status, 'unavailable');
  assert.equal(defaultResult.dependencies.poolManager.code.status, 'unavailable');
  const { rpc, calls } = fixture();
  const latestResult = await preflight({ rpc, viem, snapshotTag: 'latest' });
  assert.equal(latestResult.snapshot.number, '1000');
  assert.equal(latestResult.snapshot.tag, 'latest');
  for (const call of calls.filter(call => ['eth_getCode', 'eth_call'].includes(call.method)))
    assert.deepEqual(call.params[1], { blockHash: hash(1000), requireCanonical: true });
  await assert.rejects(() => preflight({ rpc, viem, snapshotTag: 'pending' }), /invalid_snapshot/);
});

test('wrong chain, changed code, wrong links, contract roles and a canonicality change fail independently', async () => {
  const inputs = completeInputs();
  const { rpc } = fixture({ chainId: '0x1', reorg: true, poolManagerLink: inputs.deployer,
    codeByAddress: { [DEPENDENCIES.poolManager]: '0x6001', [DEPENDENCIES.stateView]: '0x', [inputs.priceGuardGuardian]: code } });
  const result = await preflight({ rpc, viem, inputs });
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
  const result = await preflight({ rpc: fixture().rpc, viem, inputs });
  assert.equal(result.roleSeparation.status, 'fail');
  assert.deepEqual(result.roleSeparation.conflicts, ['operator_equals_pricePublisher', 'priceGuardGuardian_equals_feeRecipient']);
});

test('inherited read-only transport refuses sending and signing methods before network access', async () => {
  const rpc = readOnlyRpc('http://127.0.0.1:1');
  for (const method of ['eth_sendTransaction', 'eth_sendRawTransaction', 'eth_sign', 'personal_sign', 'wallet_sendCalls'])
    await assert.rejects(() => rpc(method, []), /readonly_rpc_budget/);
});

test('CLI writes failed observations, exits nonzero and does not disclose private endpoint information', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'domino-mainnet-preflight-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { rpc } = fixture({ numberOpcode: 500n, blockhashOpcode: hash(0) });
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
