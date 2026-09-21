#!/usr/bin/env node
/** Read-only chain qualification. Does not load a key, sign, deploy, or enable services. */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHAIN_ID, DEPENDENCIES, toolsFor, readBounded, verificationRpcEndpoint, readOnlyRpc } from './prepare-financial-release.mjs';

export const NUMBER_PROBE = '0x4360005260206000f3';
export const ARB_SYS = '0x0000000000000000000000000000000000000064';
const roleNames = ['deployer', 'operator', 'pricePublisher', 'priceGuardGuardian', 'feeRecipient'];
const hashPattern = /^0x[0-9a-f]{64}$/;
const hexPattern = /^0x(?:[0-9a-f]{2})*$/;
const quantityPattern = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const assert = (ok, reason) => { if (!ok) throw new Error(reason); };
const status = (state, reason, fields = {}) => ({ status: state, ...(reason ? { reason } : {}), ...fields });
const unavailable = () => status('unavailable', 'rpc_or_response_unavailable');
const quantity = value => { assert(typeof value === 'string' && quantityPattern.test(value), 'invalid_quantity'); return BigInt(value); };
const bytes = value => { assert(typeof value === 'string' && hexPattern.test(value), 'invalid_hex'); return value; };
const word = value => { assert(typeof value === 'string' && hashPattern.test(value), 'invalid_word'); return BigInt(value); };

export function publicInputs(input = {}) {
  assert(input && typeof input === 'object' && !Array.isArray(input), 'invalid_public_inputs');
  assert(Object.keys(input).every(key => [...roleNames, 'dependencyCodeHashes'].includes(key)), 'unknown_public_input');
  const output = {};
  for (const name of roleNames) if (Object.hasOwn(input, name)) {
    assert(typeof input[name] === 'string' && /^0x[0-9a-fA-F]{40}$/.test(input[name])
      && BigInt(input[name]) !== 0n, 'invalid_role_address');
    output[name] = input[name].toLowerCase();
  }
  if (Object.hasOwn(input, 'dependencyCodeHashes')) {
    const hashes = input.dependencyCodeHashes;
    assert(hashes && typeof hashes === 'object' && !Array.isArray(hashes)
      && Object.keys(hashes).every(name => Object.hasOwn(DEPENDENCIES, name)), 'invalid_dependency_hashes');
    output.dependencyCodeHashes = {};
    for (const [name, hash] of Object.entries(hashes)) {
      assert(typeof hash === 'string' && hashPattern.test(hash), 'invalid_dependency_hash');
      output.dependencyCodeHashes[name] = hash;
    }
  }
  return output;
}

function blockRecord(block) {
  assert(block && hashPattern.test(block.hash) && hashPattern.test(block.parentHash), 'invalid_block');
  const record = { number: quantity(block.number).toString(), hash: block.hash, parentHash: block.parentHash,
    timestamp: quantity(block.timestamp).toString() };
  if (block.l1BlockNumber !== undefined) record.l1BlockNumber = quantity(block.l1BlockNumber).toString();
  return record;
}

// The inherited transport intentionally reports only bounded generic failures.
// Never put an RPC error, endpoint, private filename, or provider message in the result.
async function checked(operation) {
  try { return status('pass', undefined, { value: await operation() }); }
  catch { return unavailable(); }
}

function separation(input) {
  const conflicts = [];
  for (const [a, b] of [['operator', 'pricePublisher'], ['operator', 'priceGuardGuardian'], ['pricePublisher', 'priceGuardGuardian']])
    if (input[a] && input[a] === input[b]) conflicts.push(`${a}_equals_${b}`);
  for (const name of ['operator', 'pricePublisher', 'priceGuardGuardian']) {
    if (input[name] && input[name] === input.feeRecipient) conflicts.push(`${name}_equals_feeRecipient`);
    if (Object.values(DEPENDENCIES).includes(input[name])) conflicts.push(`${name}_is_dependency`);
  }
  if (conflicts.length) return status('fail', 'role_separation_failed', { conflicts });
  return roleNames.every(name => input[name]) ? status('pass') : status('missing', 'public_roles_incomplete');
}

export async function preflight({ rpc, viem, inputs = {}, snapshotTag = 'finalized' }) {
  assert(['latest', 'finalized'].includes(snapshotTag), 'invalid_snapshot');
  const input = publicInputs(inputs);
  const result = { schemaVersion: 1, kind: 'domino-v4-mainnet-preflight', expectedChainId: CHAIN_ID,
    checkedAtUTC: new Date().toISOString(), readOnly: true, deploymentReady: false, executionAvailable: false };
  result.chain = await checked(async () => quantity(await rpc('eth_chainId', [])).toString());
  if (result.chain.status === 'pass' && result.chain.value !== String(CHAIN_ID))
    result.chain = status('fail', 'wrong_chain', { value: result.chain.value });
  result.blocks = {};
  // Calls are sequential: readOnlyRpc's request counter is intentionally shared.
  for (const tag of ['latest', 'finalized'])
    result.blocks[tag] = await checked(async () => blockRecord(await rpc('eth_getBlockByNumber', [tag, false])));
  if (result.blocks.latest.status === 'pass' && result.blocks.finalized.status === 'pass'
    && BigInt(result.blocks.finalized.value.number) > BigInt(result.blocks.latest.value.number))
    result.blocks.finalized = status('fail', 'finalized_ahead_of_latest', { value: result.blocks.finalized.value });
  // Never substitute a newer state when a pruned RPC cannot serve the requested
  // finalized snapshot. The operator may explicitly choose --snapshot latest.
  const snapshot = result.blocks[snapshotTag].status === 'pass' ? result.blocks[snapshotTag].value : null;
  result.snapshot = snapshot ? { ...snapshot, tag: snapshotTag }
    : status('unavailable', 'requested_block_unavailable', { tag: snapshotTag });
  const pinned = snapshot && { blockHash: snapshot.hash, requireCanonical: true };
  result.dependencies = {};
  const linkAbi = viem.parseAbi(['function poolManager() view returns (address)']);
  for (const [name, address] of Object.entries(DEPENDENCIES)) {
    const dependency = result.dependencies[name] = { address };
    const code = snapshot ? await checked(async () => bytes(await rpc('eth_getCode', [address, pinned]))) : unavailable();
    if (code.status !== 'pass') dependency.code = code;
    else dependency.code = code.value === '0x' ? status('fail', 'dependency_code_absent')
      : status('pass', undefined, { runtimeBytes: (code.value.length - 2) / 2, codeHash: viem.keccak256(code.value) });
    const expected = input.dependencyCodeHashes?.[name];
    dependency.pin = !expected ? status('missing', 'expected_dependency_code_hash_not_supplied')
      : dependency.code.status !== 'pass' ? status('unavailable', 'dependency_code_unavailable', { expected })
      : status(dependency.code.codeHash === expected ? 'pass' : 'fail',
        dependency.code.codeHash === expected ? undefined : 'dependency_code_hash_mismatch', { expected });
    if (name !== 'poolManager') {
      dependency.poolManager = snapshot ? await checked(async () => viem.decodeFunctionResult({ abi: linkAbi,
        functionName: 'poolManager', data: bytes(await rpc('eth_call', [{ to: address,
          data: viem.encodeFunctionData({ abi: linkAbi, functionName: 'poolManager' }) }, pinned])) }).toLowerCase()) : unavailable();
      if (dependency.poolManager.status === 'pass' && dependency.poolManager.value !== DEPENDENCIES.poolManager)
        dependency.poolManager.status = 'fail', dependency.poolManager.reason = 'dependency_link_mismatch';
    }
  }
  result.roles = {};
  for (const name of roleNames) {
    if (!input[name]) { result.roles[name] = status('missing', 'public_role_address_not_supplied'); continue; }
    const code = snapshot ? await checked(async () => bytes(await rpc('eth_getCode', [input[name], pinned]))) : unavailable();
    result.roles[name] = { address: input[name], ...code };
    delete result.roles[name].value;
    if (code.status === 'pass') {
      result.roles[name].hasCode = code.value !== '0x';
      if (name !== 'feeRecipient' && code.value !== '0x')
        result.roles[name].status = 'fail', result.roles[name].reason = 'role_must_be_eoa';
    }
  }
  result.roleSeparation = separation(input);
  result.blockSemantics = await inspectBlockSemantics(rpc, viem, snapshot, pinned);
  result.snapshotCanonical = snapshot ? await checked(async () => {
    const current = blockRecord(await rpc('eth_getBlockByNumber', [viem.toHex(BigInt(snapshot.number)), false]));
    return current.hash === snapshot.hash;
  }) : unavailable();
  if (result.snapshotCanonical.status === 'pass' && !result.snapshotCanonical.value)
    result.snapshotCanonical = status('fail', 'pinned_block_changed');
  const checks = { chain: result.chain, latest: result.blocks.latest, finalized: result.blocks.finalized, snapshotCanonical: result.snapshotCanonical,
    roleSeparation: result.roleSeparation, frozenContractCompatibility: result.blockSemantics.compatibility,
    ...Object.fromEntries(Object.entries(result.roles).map(([name, check]) => [`roles.${name}`, check])) };
  for (const [name, dependency] of Object.entries(result.dependencies))
    for (const field of ['code', 'pin', 'poolManager']) if (dependency[field]) checks[`dependencies.${name}.${field}`] = dependency[field];
  const blockers = Object.entries(checks).filter(([, check]) => check.status !== 'pass')
    .map(([check, value]) => ({ check, status: value.status, reason: value.reason }));
  result.readiness = { status: blockers.some(b => b.status === 'fail') ? 'fail'
    : blockers.some(b => b.status === 'unavailable') ? 'unavailable' : blockers.length ? 'missing' : 'unavailable',
    reason: 'read_only_preflight_does_not_qualify_deployment', blockers };
  result.deploymentInputs = { status: 'missing', reason: 'unsigned_release_parameters_artifacts_and_cost_qualification_still_required',
    pendingNonce: status('unavailable', 'not_queried'), balanceWei: status('unavailable', 'not_queried'),
    feeEstimate: status('unavailable', 'not_queried') };
  return result;
}

async function inspectBlockSemantics(rpc, viem, snapshot, pinned) {
  const out = {};
  if (!snapshot) return { compatibility: status('unavailable', 'no_valid_block') };
  const abi = viem.parseAbi(['function arbBlockNumber() view returns (uint256)', 'function arbBlockHash(uint256) view returns (bytes32)']);
  out.rpcBlockNumber = snapshot.number;
  out.numberOpcode = await checked(async () => word(await rpc('eth_call', [{ data: NUMBER_PROBE }, pinned])).toString());
  out.arbBlockNumber = await checked(async () => word(await rpc('eth_call', [{ to: ARB_SYS,
    data: viem.encodeFunctionData({ abi, functionName: 'arbBlockNumber' }) }, pinned])).toString());
  for (const name of ['numberOpcode', 'arbBlockNumber']) if (out[name].status === 'pass' && out[name].value !== snapshot.number)
    out[name].status = 'fail', out[name].reason = 'rpc_block_number_domain_mismatch';
  if (BigInt(snapshot.number) === 0n) {
    out.parent = status('unavailable', 'genesis_has_no_parent_observation');
    out.arbBlockHash = unavailable(); out.blockhashOpcode = unavailable();
  } else {
    const parent = BigInt(snapshot.number) - 1n;
    out.parent = await checked(async () => blockRecord(await rpc('eth_getBlockByNumber', [viem.toHex(parent), false])));
    if (out.parent.status === 'pass' && (out.parent.value.hash !== snapshot.parentHash || out.parent.value.number !== parent.toString()))
      out.parent = status('fail', 'parent_block_mismatch');
    out.arbBlockHash = await checked(async () => {
      const hash = await rpc('eth_call', [{ to: ARB_SYS, data: viem.encodeFunctionData({ abi,
        functionName: 'arbBlockHash', args: [parent] }) }, pinned]);
      assert(hashPattern.test(hash), 'invalid_hash_result'); return hash;
    });
    out.blockhashOpcode = await checked(async () => {
      const hash = await rpc('eth_call', [{ data: '0x7f' + parent.toString(16).padStart(64, '0') + '4060005260206000f3' }, pinned]);
      assert(hashPattern.test(hash), 'invalid_hash_result'); return hash;
    });
    if (out.parent.status === 'pass') for (const name of ['arbBlockHash', 'blockhashOpcode'])
      if (out[name].status === 'pass' && out[name].value !== out.parent.value.hash)
        out[name].status = 'fail', out[name].reason = 'rpc_parent_hash_domain_mismatch';
  }
  const checks = ['numberOpcode', 'arbBlockNumber', 'parent', 'arbBlockHash', 'blockhashOpcode'].map(name => out[name]);
  out.compatibility = out.numberOpcode.status === 'fail' || out.blockhashOpcode.status === 'fail'
    ? status('fail', 'frozen_contracts_use_incompatible_block_domain')
    : checks.some(check => check.status === 'fail') ? status('fail', 'chain_block_semantics_inconsistent')
    : checks.some(check => check.status !== 'pass') ? status('unavailable', 'block_semantics_not_fully_observed')
    : status('pass', 'rpc_and_opcode_domains_match_at_pinned_block');
  return out;
}

export async function main(argv) {
  assert(argv.length % 2 === 0, 'invalid_cli');
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index].slice(2);
    assert(argv[index].startsWith('--') && ['repo', 'rpc', 'rpc-file', 'inputs', 'out', 'snapshot'].includes(name)
      && !Object.hasOwn(options, name), 'invalid_cli');
    options[name] = argv[index + 1];
  }
  assert(options.repo, 'repo_required');
  const endpoint = verificationRpcEndpoint(options);
  const inputs = options.inputs ? publicInputs(JSON.parse(readBounded(options.inputs, 16384))) : {};
  const result = await preflight({ rpc: readOnlyRpc(endpoint), viem: toolsFor(resolve(options.repo)), inputs,
    snapshotTag: options.snapshot ?? 'finalized' });
  if (options.out) writeFileSync(options.out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await main(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.readiness.status === 'fail') process.exitCode = 2;
  }
  catch { process.stderr.write('Read-only preflight failed; no transaction was signed or sent.\n'); process.exitCode = 1; }
}
