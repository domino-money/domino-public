#!/usr/bin/env node
/** The governance Safe of a new chain (docs/v2/GOVERNANCE_SAFE.md is the runbook).
 *
 * deploy.mjs takes governance as a role: a canonical Safe that already exists on the chain, with threshold >= 2, no
 * module and no guard (inspectGovernance). On Robinhood, Base and Arbitrum it is the owner's Safe 1.5.0, at the same
 * address on the three. Safe 1.4.1 and 1.5.0 reach a chain only through the Safe Singleton Factory, which the Safe team
 * deploys on request. So the owner decided on 5 Nov 2026, for Elysium, that such a chain gets a new Safe 1.3.0 L2 with
 * the same owners and threshold. Safe 1.3.0's canonical contracts go through the Arachnid proxy, which needs no one's
 * key. The 13 V2 addresses do not depend on governance: CREATE3 takes the deployer and the salts only.
 *
 * - `plan` reads the chain at one block and writes the one transaction that creates that Safe, unsigned. It is a call
 *   to Safe 1.3.0's proxy factory, which any funded account may send: creating the Safe needs no owner's signature. The
 *   address is CREATE2 over the owners, the threshold and the fallback handler, so a plan always names the same Safe,
 *   and a Safe already there is checked and reported instead.
 * - `check` runs deploy.mjs's own governance check at one block, the one `prepare` will run, and also requires the
 *   owners and threshold asked for.
 *
 * Read-only: it holds no key, signs nothing and sends nothing. Every method it calls is a read, within a call budget.
 * The RPC URL comes from an environment variable or an owner-only file, as for qualify-chain.mjs, and never reaches the
 * output. Not a release input (docs/v2/FREEZE.md): it changes nothing frozen.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAFE_SINGLETONS, GAS_HEADROOM_PERCENT, repoRoot, viem, ensure, quantity, flags, writeJson, pinBlock, inspectGovernance } from './deploy.mjs';
import { SAFE_PROXY_FACTORIES, RpcError, jsonRpc, redactUrls, rpcUrlFrom } from './qualify-chain.mjs';
import { readBounded } from '../prepare-financial-release.mjs';

const ZERO = '0x' + '0'.repeat(40);
/** Safe's linked-list sentinel: never an owner (OwnerManager). */
const SENTINEL = '0x0000000000000000000000000000000000000001';

/** Safe 1.3.0's L2 singleton, proxy factory and CompatibilityFallbackHandler at their two published addresses:
 * `canonical` (CREATE2 through the Arachnid proxy, permissionless) and `eip155` (through the Safe Singleton Factory).
 * The runtimes are the same at both (safe-global/safe-deployments src/assets/v1.3.0). */
export const SAFE_130_DEPLOYMENTS = Object.freeze({
  canonical: Object.freeze({ singleton: '0x3e5c63644e683549055b9be8653de26e0b4cd36e', factory: '0xa6b71e26c5e0845f74c812102ca7114b6a896ab2',
    fallbackHandler: '0xf48f2b2d2a534e402487b3ee7c18c33aec0fe5e4' }),
  eip155: Object.freeze({ singleton: '0xfb1bffc9d739b8d520daf37df666da4c687191ea', factory: '0xc22834581ebc8527d974f8a1c97e1bea4ef910bc',
    fallbackHandler: '0x017062a1de2fe6b99be3d9d37841fed19f573804' }),
});
/** CompatibilityFallbackHandler 1.3.0's runtime keccak (safe-deployments). The singleton's is deploy.mjs's
 * SAFE_SINGLETONS and the factory's qualify-chain.mjs's SAFE_PROXY_FACTORIES: one table each, and the tests hold the
 * three to the same release. */
export const SAFE_130_FALLBACK_HANDLER_CODE_HASH = '0x03e69f7ce809e81687c69b19a7d7cca45b6d551ffdec73d9bb87178476de1abf';

const SETUP_ABI = [{ type: 'function', name: 'setup', stateMutability: 'nonpayable', outputs: [], inputs: [
  { name: '_owners', type: 'address[]' }, { name: '_threshold', type: 'uint256' }, { name: 'to', type: 'address' }, { name: 'data', type: 'bytes' },
  { name: 'fallbackHandler', type: 'address' }, { name: 'paymentToken', type: 'address' }, { name: 'payment', type: 'uint256' },
  { name: 'paymentReceiver', type: 'address' }] }];
const FACTORY_ABI = [
  { type: 'function', name: 'createProxyWithNonce', stateMutability: 'nonpayable', outputs: [{ name: 'proxy', type: 'address' }], inputs: [
    { name: '_singleton', type: 'address' }, { name: 'initializer', type: 'bytes' }, { name: 'saltNonce', type: 'uint256' }] },
  { type: 'function', name: 'proxyCreationCode', stateMutability: 'pure', outputs: [{ name: '', type: 'bytes' }], inputs: [] },
];

export const DEFAULT_MAX_CALLS = 40;
const READS = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getStorageAt', 'eth_call', 'eth_estimateGas']);
const hashOf = code => code === '0x' ? null : viem.keccak256(code);
const hex = n => '0x' + BigInt(n).toString(16);

/** Reads only, at most `maximumCalls` of them. */
export function readsOnly(transport, { maximumCalls = DEFAULT_MAX_CALLS } = {}) {
  let calls = 0;
  const rpc = async (method, params = []) => {
    if (!READS.has(method)) throw new RpcError('refused', method);
    if (++calls > maximumCalls) throw new RpcError('budget', method, { detail: `${maximumCalls} calls spent` });
    return transport(method, params);
  };
  rpc.calls = () => calls;
  return rpc;
}

/** Owners and threshold as deploy.mjs's inspectGovernance will require them: distinct addresses (EIP-55 when mixed
 * case), none zero or the sentinel, a threshold of at least 2 and no more than the owners. The order is kept: it is
 * part of the address. */
export function checkedOwners(owners, threshold) {
  ensure(Array.isArray(owners) && owners.length > 0 && owners.length <= 20
    && owners.every(o => typeof o === 'string' && /^0x[0-9a-fA-F]{40}$/.test(o) && viem.isAddress(o)), 'invalid_owner_address');
  const lowered = owners.map(o => o.toLowerCase());
  ensure(new Set(lowered).size === lowered.length && lowered.every(o => o !== ZERO && o !== SENTINEL), 'governance_owners_invalid');
  ensure(Number.isSafeInteger(threshold) && threshold >= 2, 'governance_threshold_below_two');
  ensure(threshold <= lowered.length, 'governance_threshold_above_owners');
  return lowered;
}

/** `--owners A,B,C --threshold N`, or `--owners-from FILE`: a deployment's preflight report (docs/deployments/), whose
 * governance section holds the Safe's owners and threshold as deploy.mjs read them at its block. */
export function ownersFrom(f) {
  const listed = f.owners !== undefined || f.threshold !== undefined, recorded = f['owners-from'] !== undefined;
  ensure(listed !== recorded, 'exactly_one_owner_source_required: --owners and --threshold, or --owners-from');
  if (recorded) {
    let report;
    try { report = JSON.parse(readBounded(f['owners-from'], 16 * 1024 * 1024)); } catch { throw new Error('owners_from_unreadable'); }
    const g = report?.kind === 'domino-v2-deployment-preflight' ? report.governance : null;
    ensure(g?.checked === true && Array.isArray(g.owners) && Number.isSafeInteger(g.threshold), 'owners_from_not_a_preflight_report');
    return { owners: checkedOwners(g.owners, g.threshold), threshold: g.threshold,
      source: { preflight: f['owners-from'], chainId: report.chain?.chainId ?? null, block: report.chain?.block?.number ?? null, safe: g.address } };
  }
  ensure(typeof f.owners === 'string' && /^[1-9][0-9]?$/.test(f.threshold ?? ''), 'invalid_owners_or_threshold');
  const threshold = Number(f.threshold);
  return { owners: checkedOwners(f.owners.split(','), threshold), threshold, source: { listed: true } };
}

async function expectChain(rpc, chainId) {
  ensure(Number.isSafeInteger(chainId) && chainId > 0, 'invalid_chain_id');
  ensure(quantity(await rpc('eth_chainId', [])) === BigInt(chainId), 'chain_id_mismatch');
}

/** The first of SAFE_130_DEPLOYMENTS whose singleton, factory and fallback handler all hold their code at `tag`. */
export async function safe130At(rpc, tag) {
  const missing = [];
  for (const [variant, set] of Object.entries(SAFE_130_DEPLOYMENTS)) {
    const [singleton, factory, handler] = await Promise.all([set.singleton, set.factory, set.fallbackHandler].map(a => rpc('eth_getCode', [a, tag])));
    const ok = { singleton: hashOf(singleton) === SAFE_SINGLETONS[set.singleton].codehash, factory: hashOf(factory) === SAFE_PROXY_FACTORIES[set.factory].codehash,
      fallbackHandler: hashOf(handler) === SAFE_130_FALLBACK_HANDLER_CODE_HASH };
    if (ok.singleton && ok.factory && ok.fallbackHandler) return { variant, ...set };
    missing.push(`${variant} lacks ${Object.keys(ok).filter(k => !ok[k]).join(', ')}`);
  }
  throw new Error(`safe_130_not_on_chain: ${missing.join('; ')} (qualify-chain.mjs's bootstrap says how to deploy it)`);
}

/** The Safe 1.3.0 that the owners and threshold give on this chain, and the transaction that creates it unless it
 * exists. `from` only sizes the gas: anyone may send it. */
export async function planGovernanceSafe({ rpc, chainId, owners, threshold, saltNonce = 0n, from = null }) {
  owners = checkedOwners(owners, threshold);
  ensure(typeof saltNonce === 'bigint' && saltNonce >= 0n && saltNonce < 2n ** 256n, 'invalid_salt_nonce');
  ensure(from === null || (typeof from === 'string' && viem.isAddress(from)), 'invalid_from_address');
  await expectChain(rpc, chainId);
  const block = await pinBlock(rpc, 'latest');
  const set = await safe130At(rpc, block.tag);
  const initializer = viem.encodeFunctionData({ abi: SETUP_ABI, functionName: 'setup',
    args: [owners.map(o => viem.getAddress(o)), BigInt(threshold), ZERO, '0x', viem.getAddress(set.fallbackHandler), ZERO, 0n, ZERO] });
  const creationCode = viem.decodeFunctionResult({ abi: FACTORY_ABI, functionName: 'proxyCreationCode',
    data: await rpc('eth_call', [{ to: set.factory, data: viem.encodeFunctionData({ abi: FACTORY_ABI, functionName: 'proxyCreationCode' }) }, block.tag]) });
  // GnosisSafeProxyFactory 1.3.0: CREATE2 with salt keccak256(keccak256(initializer) ++ saltNonce) over the proxy's
  // creation code followed by the singleton as one word.
  const address = viem.getCreate2Address({ from: set.factory, salt: viem.keccak256(viem.encodePacked(['bytes32', 'uint256'], [viem.keccak256(initializer), saltNonce])),
    bytecode: viem.concatHex([creationCode, viem.encodeAbiParameters([{ type: 'address' }], [set.singleton])]) }).toLowerCase();
  const safe = { address, version: '1.3.0', l2: true, deployment: set.variant, singleton: set.singleton, factory: set.factory,
    fallbackHandler: set.fallbackHandler, owners, threshold, saltNonce: saltNonce.toString() };
  const base = { schemaVersion: 1, kind: 'domino-v2-governance-safe-plan', chainId, block: { number: block.number.toString(), hash: block.hash }, safe };
  if (await rpc('eth_getCode', [address, block.tag]) !== '0x') {
    const check = await checkGovernanceSafe({ rpc, chainId, address, owners, threshold, block: block.number });
    return { ...base, status: 'exists', transaction: null, check };
  }
  const data = viem.encodeFunctionData({ abi: FACTORY_ABI, functionName: 'createProxyWithNonce', args: [set.singleton, initializer, saltNonce] });
  const sender = from === null ? owners[0] : from.toLowerCase();
  const created = viem.decodeFunctionResult({ abi: FACTORY_ABI, functionName: 'createProxyWithNonce',
    data: await rpc('eth_call', [{ from: sender, to: set.factory, data }, block.tag]) });
  ensure(created.toLowerCase() === address, 'safe_address_prediction_mismatch');
  // On Nitro the estimate carries the L1 component inside the gas, as deploy.mjs's steps do.
  const estimate = quantity(await rpc('eth_estimateGas', [{ from: sender, to: set.factory, data }]));
  const gas = (estimate * GAS_HEADROOM_PERCENT + 99n) / 100n;
  return { ...base, status: 'to_create',
    transaction: { chainId, to: set.factory, value: '0x0', data, gas: hex(gas), estimatedGas: estimate.toString(), simulatedFrom: sender } };
}

/** deploy.mjs's inspectGovernance at one block (the receipt's, or the head), plus exactly these owners and threshold. */
export async function checkGovernanceSafe({ rpc, chainId, address, owners, threshold, block = null }) {
  owners = checkedOwners(owners, threshold);
  ensure(typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address) && viem.isAddress(address), 'invalid_safe_address');
  ensure(block === null || (typeof block === 'bigint' && block >= 0n), 'invalid_block');
  await expectChain(rpc, chainId);
  const pinned = await pinBlock(rpc, block === null ? 'latest' : hex(block));
  const inspection = await inspectGovernance(address, rpc, pinned.tag, {});
  ensure(inspection.threshold === threshold, 'governance_threshold_mismatch');
  ensure(inspection.owners.length === owners.length && owners.every(o => inspection.owners.includes(o)), 'governance_owners_mismatch');
  return { schemaVersion: 1, kind: 'domino-v2-governance-safe-check', status: 'passed', chainId, block: { number: pinned.number.toString(), hash: pinned.hash },
    address: address.toLowerCase(), inspection };
}

// ------------------------------------------------------------------ CLI

const USAGE = 'usage: governance-safe.mjs plan --chain-id N (--owners A,B,C --threshold N | --owners-from PREFLIGHT) [--salt-nonce N] [--from ADDRESS] '
  + '(--rpc-env NAME | --rpc-file PATH) --out FILE\n       governance-safe.mjs check --chain-id N --address SAFE (--owners A,B,C --threshold N | --owners-from PREFLIGHT) '
  + '[--block N] (--rpc-env NAME | --rpc-file PATH) [--out FILE]';
const OPTIONS = { plan: ['chain-id', 'owners', 'threshold', 'owners-from', 'salt-nonce', 'from', 'rpc-env', 'rpc-file', 'out', 'max-calls'],
  check: ['chain-id', 'address', 'owners', 'threshold', 'owners-from', 'block', 'rpc-env', 'rpc-file', 'out', 'max-calls'] };

/** A plan or a check is evidence, not source: written outside the checkout. */
function outputFile(path) {
  const target = resolve(path);
  let existing = dirname(target);
  while (!existsSync(existing)) existing = dirname(existing);
  const real = join(realpathSync(existing), relative(existing, target)), root = realpathSync(repoRoot);
  const rel = relative(root, real);
  ensure(rel.startsWith('..') || isAbsolute(rel), 'output_inside_the_checkout: write the plan outside the repository');
  return target; // writeJson never overwrites (output_exists)
}

export async function cli(argv, { env = process.env } = {}) {
  const [command, ...rest] = argv;
  ensure(Object.hasOwn(OPTIONS, command ?? ''), USAGE);
  const f = flags(rest);
  ensure(Object.keys(f).every(k => OPTIONS[command].includes(k)) && typeof f[command === 'plan' ? 'out' : 'address'] === 'string', USAGE);
  const integer = (value, name, max) => { ensure(/^(0|[1-9][0-9]{0,77})$/.test(value ?? '') && BigInt(value) <= max, 'invalid_' + name); return BigInt(value); };
  const chainId = Number(integer(f['chain-id'], 'chain_id', BigInt(Number.MAX_SAFE_INTEGER)));
  const { owners, threshold, source } = ownersFrom(f);
  const out = f.out === undefined ? null : outputFile(f.out);
  const maximumCalls = f['max-calls'] === undefined ? DEFAULT_MAX_CALLS : Number(integer(f['max-calls'], 'max_calls', 1000n));
  const rpc = readsOnly(jsonRpc(rpcUrlFrom(f, env)), { maximumCalls });
  if (command === 'plan') {
    const plan = await planGovernanceSafe({ rpc, chainId, owners, threshold, from: f.from ?? null,
      saltNonce: f['salt-nonce'] === undefined ? 0n : integer(f['salt-nonce'], 'salt_nonce', 2n ** 256n - 1n) });
    plan.ownersSource = source;
    writeJson(out, plan);
    const s = plan.safe;
    return [`Safe ${s.version} L2 (${s.deployment} addresses) for ${s.threshold} of ${s.owners.length}: ${viem.getAddress(s.address)} on chain ${chainId} at block ${plan.block.number}`,
      `Owners: ${s.owners.map(o => viem.getAddress(o)).join(', ')}`,
      plan.status === 'exists' ? 'It already exists, and deploy.mjs\'s governance check passes on it: nothing to send.'
        : `To create it, send from any funded account: to ${viem.getAddress(plan.transaction.to)}, value 0, gas ${BigInt(plan.transaction.gas)}, data in the plan (${(plan.transaction.data.length - 2) / 2} bytes).`,
      `Wrote ${out}`].join('\n');
  }
  const report = await checkGovernanceSafe({ rpc, chainId, address: f.address, owners, threshold,
    block: f.block === undefined ? null : integer(f.block, 'block', 2n ** 63n) });
  report.ownersSource = source;
  if (out) writeJson(out, report);
  const g = report.inspection;
  return [`Governance ${viem.getAddress(report.address)} passes deploy.mjs's check at block ${report.block.number} of chain ${chainId}:`,
    `Safe ${g.version}${g.l2 ? ' L2' : ''}, ${g.threshold} of ${g.owners.length}, no module, no guard; owners as asked: ${g.owners.map(o => viem.getAddress(o)).join(', ')}`,
    ...(g.warnings.length ? ['Warnings: ' + g.warnings.join('; ')] : []), ...(out ? [`Wrote ${out}`] : [])].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).then(message => console.log(message))
    .catch(error => { console.error(redactUrls(error.message).replace(/[^\x20-\x7e\n]/g, '?')); process.exitCode = 1; });
}
