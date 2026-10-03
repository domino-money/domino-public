#!/usr/bin/env node
/** The three-chain fork rehearsal of the V2 deployment (issue #301; PR #302's review, item 5).
 *
 * Upstream endpoints are only read (deploy.mjs readOnlyRpc). Every transaction goes to a fresh loopback Anvil
 * fork that this script starts and validates itself; a loopback upstream (Robinhood's own-node tunnel) never
 * receives one. On each fork it:
 * - deploys the real package with the owner's role addresses, the owner's Safe as governance and the deployer's
 *   real balance (no top-up), after the same preflight the owner runs;
 * - repeats the deployment from the same block as an interrupted run plus a resume, then discards it;
 * - exercises the owner roles with the owner's Safe, whose transactions two impersonated owners approve and
 *   execute: the governance handoff both ways (the Safe proposes the deployer, who accepts; the deployer
 *   proposes the Safe, which accepts), operator and publisher registration through the 24-hour timelock, a
 *   guardian veto, a guardian halt and its timelocked resume;
 * - runs the journeys on real pools: zap create/exit on v3 and v4, creation of a new hookless v4 pool and of a
 *   new v3 pool, vault creation, a compound with a signed observation, and an auto-exit trigger. */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot, viem, DEPLOY_ORDER, CONTRACT_NAMES, PRODUCTION_DEPLOYER, ROLE_NAMES, ensure, quantity, compileV2, planDeployment,
  preflightDeployment, verifyDeployment, inspectGovernance, readOnlyRpc, writeJson, packageDigest, flags } from './deploy.mjs';
import { startAnvil, simulateGas, waitReceipt, rehearsalAccount } from './deploy-anvil.mjs';
import { executeSteps, chainProfile } from './deploy-local.mjs';
import { validateManifest } from './deploy-schema.mjs';

/** The owner's role addresses (issue #301, 2 Oct 2026); governance is the owner's Safe (1.5.0, 2-of-3, the same
 * address on 4663, 8453 and 42161; its owners are the deployer, the guardian and a third key). */
export const OWNER_ROLES = Object.freeze({ deployer: viem.getAddress(PRODUCTION_DEPLOYER), governance: '0x2B1d4098EC880058886B95A0E75069a7099C5a9d',
  guardian: '0x5e57FDEd90C4635648Eb7b3ba29705Ff0769D103', feeRecipient: '0x1488C84dAFc03F7f4c4fB986F83bA99Fd530c6f4',
  operator: '0x64b72517D8b0d72BE25F814b4e03985Cf15e098A', publisher: '0x07C7E7f92e2C76c9cb8D7F2aE44caa6877fc7DF3' });
export const CHAINS = Object.freeze(['robinhood-4663', 'base-8453', 'arbitrum-42161']);
const SAFE_141 = Object.freeze({ factory: '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67', singleton: '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762',
  fallbackHandler: '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99' });
const ZERO = '0x0000000000000000000000000000000000000000';
const MAX128 = (1n << 128n) - 1n;
const ACTION_GAS = 16_000_000n;
const TIMELOCK = 86_400;
const hex = n => viem.toHex(BigInt(n));
const kind = name => viem.keccak256(viem.toHex('domino.registry.' + name));
const SAFE_ABI = viem.parseAbi([
  'function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) returns (address)',
  'function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
  'function nonce() view returns (uint256)', 'function getOwners() view returns (address[])', 'function approveHash(bytes32)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  'event ProxyCreation(address indexed proxy, address singleton)',
]);
const TOKEN_ABI = viem.parseAbi(['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)', 'function deposit() payable']);
const NFT_ABI = viem.parseAbi(['function approve(address,uint256)', 'function ownerOf(uint256) view returns (address)', 'function subscriber(uint256) view returns (address)']);
const V3_FACTORY_ABI = viem.parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const V3_POOL_ABI = viem.parseAbi(['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)']);
const STATE_ABI = viem.parseAbi(['function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)']);
const POOL_REF = [{ name: 'dex', type: 'uint8' }, { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }];
const LEG = [{ name: 'kind', type: 'uint8' }, { name: 'router', type: 'address' }, { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
  { name: 'amountIn', type: 'uint128' }, { name: 'minAmountOut', type: 'uint128' }, { name: 'data', type: 'bytes' }];

const forks = new WeakSet();
/** Only an Anvil fork this script started and validated may receive a transaction. */
export const requireRehearsalFork = rpc => ensure(forks.has(rpc), 'rehearsal_fork_required');

/** An upstream endpoint, read-only: no credentials in the URL, Robinhood only through the own node's loopback tunnel. */
export function upstreamRpc(url, { robinhood = false } = {}) {
  const parsed = new URL(url);
  ensure(['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash, 'upstream_url_must_carry_no_credentials');
  ensure(!robinhood || ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname), 'robinhood_requires_the_own_node_tunnel');
  return readOnlyRpc(url, { maximumCalls: 400, seconds: 3600 });
}

/** The OP Stack hardfork the chain runs, as its GasPriceOracle reports it (Anvil's optimism mode names them). */
async function opHardfork(upstream) {
  for (const name of ['jovian', 'isthmus']) {
    const flag = await upstream('eth_call', [{ to: '0x420000000000000000000000000000000000000f', data: viem.toFunctionSelector('is' + name[0].toUpperCase() + name.slice(1) + '()') }, 'latest']);
    if (BigInt(flag) === 1n) return name;
  }
  throw new Error('op_hardfork_unknown');
}

export async function startFork(profile, upstreamUrl, blockNumber, upstream) {
  const args = ['--fork-url', upstreamUrl, '--fork-block-number', String(blockNumber), '--no-storage-caching', '--retries', '20',
    '--fork-retry-backoff', '1000', '--enable-tx-gas-limit'];
  // OP Stack forks charge the L1 data fee as the chain does (GasPriceOracle); Nitro's L1 gas is estimated live.
  if (profile.stack === 'op-stack') args.push('--network', 'optimism', '--hardfork', await opHardfork(upstream));
  else args.push('--hardfork', 'prague');
  const anvil = await startAnvil({ args, timeoutMs: 120000 });
  try {
    const metadata = await anvil.rpc('anvil_metadata', []);
    ensure(metadata.forkedNetwork && Number(metadata.forkedNetwork.forkBlockNumber) === blockNumber
      && Number(quantity(await anvil.rpc('eth_chainId', []))) === profile.chainId, 'rehearsal_fork_identity');
  } catch (error) { await anvil.stop(); throw error; }
  forks.add(anvil.rpc);
  return anvil;
}

let tokenCompile;
function rehearsalToken() {
  if (tokenCompile) return tokenCompile;
  const source = readFileSync(join(repoRoot, 'scripts/v2/deploy-fixtures/RehearsalToken.sol'), 'utf8');
  const input = { language: 'Solidity', sources: { 'RehearsalToken.sol': { content: source } }, settings: { optimizer: { enabled: true, runs: 200 },
    evmVersion: 'cancun', metadata: { bytecodeHash: 'none' }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const output = JSON.parse(execFileSync(process.execPath, [join(repoRoot, 'scripts/solc-compile.cjs')], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  ensure(!(output.errors ?? []).some(e => e.severity === 'error'), 'rehearsal_token_compile_failed');
  const artifact = output.contracts['RehearsalToken.sol'].RehearsalToken;
  tokenCompile = { abi: artifact.abi, bytecode: '0x' + artifact.evm.bytecode.object };
  return tokenCompile;
}

/** Transactions and reads on one validated fork; every send is recorded with its gas. */
function onFork(rpc) {
  requireRehearsalFork(rpc);
  const actions = [], impersonated = new Set(), syntheticGas = [];
  const read = async (to, abi, functionName, args = []) => viem.decodeFunctionResult({ abi, functionName,
    data: await rpc('eth_call', [{ to, data: viem.encodeFunctionData({ abi, functionName, args }) }, 'latest']) });
  const send = async (label, from, to, data, value = 0n, { expectRevert = false } = {}) => {
    if (!impersonated.has(from.toLowerCase())) { await rpc('anvil_impersonateAccount', [from]); impersonated.add(from.toLowerCase()); }
    // Chain-like fees: twice the current base fee, no tip. An account that cannot pay them gets synthetic gas money, recorded.
    const maxFee = BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).baseFeePerGas) * 2n + 1n;
    const need = ACTION_GAS * maxFee + value, held = BigInt(await rpc('eth_getBalance', [from, 'latest']));
    if (held < need) { await rpc('anvil_setBalance', [from, hex(need * 2n)]); syntheticGas.push({ account: from.toLowerCase(), action: label, heldWei: held.toString(), setToWei: (need * 2n).toString() }); }
    const tx = { from, data, value: hex(value), gas: hex(ACTION_GAS), maxFeePerGas: hex(maxFee), maxPriorityFeePerGas: '0x0' };
    if (to) tx.to = to;
    let hash;
    try { hash = await rpc('eth_sendTransaction', [tx]); } catch (error) { throw new Error(label + ' from ' + from + ': ' + error.message); }
    const receipt = await waitReceipt(rpc, hash);
    ensure((receipt.status === '0x1') !== expectRevert, label + (expectRevert ? ': did not revert' : ': reverted'));
    actions.push({ action: label, from: from.toLowerCase(), transactionHash: hash, blockNumber: Number(receipt.blockNumber),
      gasUsed: BigInt(receipt.gasUsed).toString(), ...(expectRevert ? { reverted: true } : {}) });
    return receipt;
  };
  const write = (label, from, to, abi, functionName, args = [], value = 0n, options) => send(label, from, to, viem.encodeFunctionData({ abi, functionName, args }), value, options);
  const fund = (account, wei = 10n ** 20n) => rpc('anvil_setBalance', [account, hex(wei)]);
  const timestamp = async () => BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp);
  const advance = async seconds => { await rpc('evm_increaseTime', [seconds]); await rpc('evm_mine', []); };
  return { rpc, actions, syntheticGas, read, send, write, fund, timestamp, advance };
}

/** A Safe through the canonical factory: the same owners, threshold and salt nonce give the same address on every chain. */
async function createSafe(fork, label, owners, threshold, saltNonce) {
  const initializer = viem.encodeFunctionData({ abi: SAFE_ABI, functionName: 'setup', args: [owners, BigInt(threshold), ZERO, '0x', SAFE_141.fallbackHandler, ZERO, 0n, ZERO] });
  const creator = rehearsalAccount('safe-creator').address;
  await fork.fund(creator);
  const receipt = await fork.write(label, creator, SAFE_141.factory, SAFE_ABI, 'createProxyWithNonce', [SAFE_141.singleton, initializer, saltNonce]);
  return viem.getAddress(viem.parseEventLogs({ abi: SAFE_ABI, logs: receipt.logs, eventName: 'ProxyCreation' })[0].args.proxy);
}

/** A transaction of the owner's Safe on the fork, without any owner key: the first impersonated owner approves
 * the Safe transaction hash (approveHash), the second executes it; both count through the Safe's "approved
 * hash" signatures (v = 1), sorted by owner as the Safe requires. */
async function safeExec(fork, safe, label, to, data, [approver, executor], options) {
  const nonce = await fork.read(safe, SAFE_ABI, 'nonce');
  const hash = await fork.read(safe, SAFE_ABI, 'getTransactionHash', [to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, nonce]);
  await fork.write(label + ': owner approves', approver, safe, SAFE_ABI, 'approveHash', [hash]);
  const signatures = viem.concatHex([approver, executor].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(owner => viem.concatHex([viem.padHex(owner.toLowerCase(), { size: 32 }), viem.padHex('0x0', { size: 32 }), '0x01'])));
  return fork.write(label, executor, safe, SAFE_ABI, 'execTransaction', [to, 0n, data, 0, 0n, 0n, 0n, ZERO, ZERO, signatures], 0n, options);
}

/** Governance handoff both ways, registrations through the timelock, the guardian's veto. */
async function exerciseOwnerRoles(fork, ctx) {
  const registry = ctx.contracts.registry, R = ctx.abis.registry, signers = ctx.safeSigners, safe = OWNER_ROLES.governance;
  const call = (functionName, args = []) => viem.encodeFunctionData({ abi: R, functionName, args });
  const governance = async () => (await fork.read(registry, R, 'governance')).toLowerCase();
  const pending = async () => (await fork.read(registry, R, 'pendingGovernance')).toLowerCase();
  const results = { governanceHandoff: [], registrations: {}, guardianVeto: {} };
  // The Safe, governance since the registry's constructor, proposes the deployer, who accepts.
  await safeExec(fork, safe, 'safe-proposes-deployer-as-governance', registry, call('transferGovernance', [OWNER_ROLES.deployer]), signers);
  ensure(await pending() === OWNER_ROLES.deployer.toLowerCase(), 'handoff_pending_mismatch');
  await fork.write('deployer-accepts-governance', OWNER_ROLES.deployer, registry, R, 'acceptGovernance');
  ensure(await governance() === OWNER_ROLES.deployer.toLowerCase(), 'handoff_not_accepted');
  results.governanceHandoff.push({ proposedBy: safe, accepted: OWNER_ROLES.deployer, governance: await governance() });
  // The deployer proposes the Safe; the Safe accepts through two of its owners.
  await fork.write('deployer-proposes-safe-as-governance', OWNER_ROLES.deployer, registry, R, 'transferGovernance', [safe]);
  ensure(await pending() === safe.toLowerCase(), 'handoff_pending_mismatch');
  await safeExec(fork, safe, 'safe-accepts-governance', registry, call('acceptGovernance'), signers);
  ensure(await governance() === safe.toLowerCase() && await pending() === ZERO, 'handoff_not_accepted');
  results.governanceHandoff.push({ proposedBy: OWNER_ROLES.deployer, accepted: safe, governance: await governance(), safeOwnersActing: signers });
  const schedule = async (label, changeKind, data) => {
    const receipt = await safeExec(fork, safe, label, registry, call('scheduleChange', [changeKind, data]), signers);
    return viem.parseEventLogs({ abi: R, logs: receipt.logs, eventName: 'ChangeScheduled' })[0].args.id;
  };
  const operatorId = await schedule('schedule-operator-registration', kind('operator'), viem.encodeAbiParameters([{ type: 'address' }, { type: 'bool' }], [ctx.rehearsalOperator.address, true]));
  const publisherId = await schedule('schedule-publisher-registration', kind('publisher'), viem.encodeAbiParameters([{ type: 'address' }, { type: 'bool' }], [ctx.rehearsalPublisher.address, true]));
  const feeId = await schedule('schedule-unwanted-fee-recipient', kind('feeRecipient'), viem.encodeAbiParameters([{ type: 'address' }], [rehearsalAccount('unwanted-recipient').address]));
  // The owner's guardian vetoes the fee-recipient change at once.
  await fork.write('guardian-cancels-scheduled-change', OWNER_ROLES.guardian, registry, R, 'cancelChange', [feeId]);
  const [, , , executableAt] = await fork.read(registry, R, 'pendingChange', [feeId]);
  ensure(executableAt === 0n, 'guardian_veto_failed');
  results.guardianVeto = { changeId: feeId, cancelled: true };
  await safeExec(fork, safe, 'execute-before-timelock-refused', registry, call('executeChange', [operatorId]), signers, { expectRevert: true });
  await fork.advance(TIMELOCK + 1);
  await safeExec(fork, safe, 'execute-operator-registration', registry, call('executeChange', [operatorId]), signers);
  await safeExec(fork, safe, 'execute-publisher-registration', registry, call('executeChange', [publisherId]), signers);
  ensure(await fork.read(registry, R, 'isOperator', [ctx.rehearsalOperator.address]) && await fork.read(registry, R, 'isPublisher', [ctx.rehearsalPublisher.address]), 'registration_failed');
  ensure((await fork.read(registry, R, 'feeRecipient')).toLowerCase() === OWNER_ROLES.feeRecipient.toLowerCase(), 'fee_recipient_changed');
  results.registrations = { operator: ctx.rehearsalOperator.address, publisher: ctx.rehearsalPublisher.address, timelockSeconds: TIMELOCK,
    ownerOperatorStillAdmitted: await fork.read(registry, R, 'isOperator', [OWNER_ROLES.operator]),
    ownerPublisherStillAdmitted: await fork.read(registry, R, 'isPublisher', [OWNER_ROLES.publisher]) };
  return results;
}

/** Manual management, pool creation, the vault and auto-exit on real pools of the fork. */
async function journeys(fork, ctx) {
  const { profile, contracts, abis } = ctx, user = ctx.user.address;
  const read = fork.read, write = fork.write;
  const balance = (token, account) => token === ZERO ? fork.rpc('eth_getBalance', [account, 'latest']).then(BigInt) : read(token, TOKEN_ABI, 'balanceOf', [account]);
  const deadline = async () => (await fork.timestamp()) + 300n;
  const eip712 = JSON.parse(readFileSync(join(repoRoot, 'api-contracts/v2/eip712.json'), 'utf8'));
  const observationParam = { type: 'tuple', components: eip712.types.PriceObservation.map(f => f.name === 'pool' ? { name: 'pool', type: 'tuple', components: POOL_REF } : f) };
  let observationNonce = 0n;
  const signedEvidence = async pool => {
    const sqrtPriceX96 = await read(contracts.priceAnchor, abis.priceAnchor, 'spotSqrtPrice', [pool]);
    const observedAt = await fork.timestamp();
    const point = { pool, sqrtPriceX96, observedAt, validUntil: observedAt + 300n, nonce: observationNonce++ };
    const signature = await ctx.rehearsalPublisher.signTypedData({ domain: { name: 'Domino', version: '2', chainId: profile.chainId, verifyingContract: contracts.priceAnchor },
      types: { PoolRef: eip712.types.PoolRef, PriceObservation: eip712.types.PriceObservation }, primaryType: 'PriceObservation', message: point });
    return viem.encodeAbiParameters([observationParam, { type: 'bytes' }], [point, signature]);
  };
  const stableCurrency = profile.chargeCurrencies.find(c => c.rank === 1), stable = stableCurrency.address, weth = profile.wrappedNative.address;
  const unit = 10n ** BigInt(stableCurrency.decimals);
  let v3Pool, v3Fee;
  for (const candidate of [3000, 500, 10000, 100]) {
    const found = await read(profile.uniswap.v3.factory, V3_FACTORY_ABI, 'getPool', [weth, stable, candidate]);
    if (found.toLowerCase() !== ZERO) { v3Pool = found; v3Fee = candidate; break; }
  }
  ensure(v3Pool, 'no_v3_eth_stable_pool');
  let whale;
  for (const account of [profile.uniswap.v4.poolManager, v3Pool]) if (await read(stable, TOKEN_ABI, 'balanceOf', [account]) >= 200_000n * unit) { whale = account; break; }
  ensure(whale, 'no_stable_holder_on_fork');
  await fork.fund(whale);
  await write('fund-user-stable-from-holder', whale, stable, TOKEN_ABI, 'transfer', [user, 200_000n * unit]);
  await fork.fund(user, 100n * 10n ** 18n);
  await write('wrap-user-eth', user, weth, TOKEN_ABI, 'deposit', [], 20n * 10n ** 18n);
  const emptyRoutesHash = viem.keccak256(viem.encodeAbiParameters([{ type: 'tuple[]', components: LEG }], [[]]));
  const v4Key = (fee, tickSpacing) => ({ dex: 4, currency0: ZERO, currency1: stable, fee, tickSpacing, hooks: ZERO });
  const v4Id = pool => viem.keccak256(viem.encodeAbiParameters([{ type: 'tuple', components: POOL_REF.slice(1) }], [pool]));
  let v4Pool, v4Tick, v4Price;
  for (const [fee, spacing] of [[3000, 60], [500, 10], [10000, 200], [100, 1]]) {
    const [price, tick] = await read(profile.uniswap.v4.stateView, STATE_ABI, 'getSlot0', [v4Id(v4Key(fee, spacing))]);
    if (price > 0n) { v4Pool = v4Key(fee, spacing); v4Tick = tick; v4Price = price; break; }
  }
  ensure(v4Pool, 'no_unhooked_v4_eth_stable_pool');
  const zapCreate = async (label, dex, pool, tickLower, tickUpper, caps, initSqrtPriceX96 = 0n) => {
    const suffix = 'v' + dex, zap = contracts['zap.' + suffix], manager = profile.uniswap[suffix].positionManager;
    const inputs = [pool.currency0, pool.currency1].map((token, i) => ({ token, amount: caps[i] }));
    for (const input of inputs) if (input.token !== ZERO) await write(label + '-approve', user, input.token, TOKEN_ABI, 'approve', [zap, input.amount]);
    const intent = { action: 1, pool, tokenId: 0n, tickLower, tickUpper, minLiquidity: 1n, feeBps: 0, feeToken: ZERO, routesHash: emptyRoutesHash, recipient: user, nonce: 0n, deadline: await deadline() };
    const receipt = await write(label, user, zap, abis['zap.' + suffix], 'create', [{ intent, inputs, legs: [], amount0Max: caps[0], amount1Max: caps[1], initSqrtPriceX96 }],
      pool.currency0 === ZERO ? caps[0] : 0n);
    const [event] = viem.parseEventLogs({ abi: abis['zap.' + suffix], logs: receipt.logs, eventName: 'PositionActionExecuted' });
    ensure((await read(manager, NFT_ABI, 'ownerOf', [event.args.tokenId])).toLowerCase() === user.toLowerCase(), 'position_not_with_owner');
    return { tokenId: event.args.tokenId, liquidity: event.args.liquidity };
  };
  const zapExit = async (label, dex, pool, position, tickLower, tickUpper) => {
    const suffix = 'v' + dex, zap = contracts['zap.' + suffix], manager = profile.uniswap[suffix].positionManager;
    await write(label + '-approve', user, manager, NFT_ABI, 'approve', [zap, position.tokenId]);
    const intent = { action: 4, pool, tokenId: position.tokenId, tickLower, tickUpper, minLiquidity: 1n, feeBps: 0, feeToken: ZERO, routesHash: emptyRoutesHash, recipient: user, nonce: 0n, deadline: await deadline() };
    await write(label, user, zap, abis['zap.' + suffix], 'exit', [{ intent, liquidityToRemove: position.liquidity, amount0MinRemoved: 0n, amount1MinRemoved: 0n, legs: [], burn: true }]);
  };
  const results = { pools: [], poolCreation: {} };
  // Pool creation in M1 (owner, 2 Oct): a new hookless v4 pool and a new v3 pool, initialised by the zap.
  let fresh;
  for (const [fee, spacing] of [[2345, 47], [1717, 33], [4321, 81]]) {
    const candidate = v4Key(fee, spacing), [price] = await read(profile.uniswap.v4.stateView, STATE_ABI, 'getSlot0', [v4Id(candidate)]);
    if (price === 0n) { fresh = candidate; break; }
  }
  ensure(fresh, 'no_uninitialised_v4_pool_key');
  const freshLower = Math.floor(Number(v4Tick) / fresh.tickSpacing) * fresh.tickSpacing - 100 * fresh.tickSpacing, freshUpper = freshLower + 200 * fresh.tickSpacing;
  const v4Created = await zapCreate('v4-create-new-pool-and-position', 4, fresh, freshLower, freshUpper, [10n ** 17n, 2_000n * unit], v4Price);
  const [freshPrice] = await read(profile.uniswap.v4.stateView, STATE_ABI, 'getSlot0', [v4Id(fresh)]);
  ensure(freshPrice === v4Price, 'v4_pool_not_initialised_at_the_given_price');
  await zapExit('v4-exit-new-pool-position', 4, fresh, v4Created, freshLower, freshUpper);
  results.poolCreation.v4 = { pool: fresh, poolId: v4Id(fresh), initSqrtPriceX96: v4Price.toString(), tokenId: v4Created.tokenId.toString(), liquidity: v4Created.liquidity.toString() };
  const token = rehearsalToken();
  const deployed = await fork.send('deploy-rehearsal-token', user, null, viem.encodeDeployData({ abi: token.abi, bytecode: token.bytecode, args: [10n ** 24n] }));
  const tokenAddress = viem.getAddress(deployed.contractAddress);
  ensure((await read(profile.uniswap.v3.factory, V3_FACTORY_ABI, 'getPool', [weth, tokenAddress, 3000])).toLowerCase() === ZERO, 'v3_rehearsal_pool_exists');
  const [t0, t1] = [weth, tokenAddress].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const v3Fresh = { dex: 3, currency0: t0, currency1: t1, fee: 3000, tickSpacing: 60, hooks: ZERO };
  const v3Created = await zapCreate('v3-create-new-pool-and-position', 3, v3Fresh, -6000, 6000, [10n ** 18n, 10n ** 18n], 1n << 96n);
  const createdPool = await read(profile.uniswap.v3.factory, V3_FACTORY_ABI, 'getPool', [weth, tokenAddress, 3000]);
  ensure(createdPool.toLowerCase() !== ZERO && (await read(createdPool, V3_POOL_ABI, 'slot0'))[0] === 1n << 96n, 'v3_pool_not_created');
  await zapExit('v3-exit-new-pool-position', 3, v3Fresh, v3Created, -6000, 6000);
  results.poolCreation.v3 = { token: tokenAddress, pool: createdPool, poolKey: v3Fresh, initSqrtPriceX96: (1n << 96n).toString(), tokenId: v3Created.tokenId.toString() };

  for (const dex of [3, 4]) {
    const suffix = 'v' + dex, manager = profile.uniswap[suffix].positionManager;
    const factory = contracts['vaultFactory.' + suffix], factoryAbi = abis['vaultFactory.' + suffix], vaultAbi = abis['vault.' + suffix];
    let pool, tick;
    if (dex === 3) {
      const [c0, c1] = [weth, stable].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      pool = { dex, currency0: c0, currency1: c1, fee: v3Fee, tickSpacing: profile.uniswap.v3.tickSpacingByFee[String(v3Fee)], hooks: ZERO };
      [, tick] = await read(v3Pool, V3_POOL_ABI, 'slot0');
    } else { pool = v4Pool; tick = v4Tick; }
    const tickLower = Math.floor(Number(tick) / pool.tickSpacing) * pool.tickSpacing - 6000, tickUpper = tickLower + 12000;
    const caps = [pool.currency0, pool.currency1].map(t => t.toLowerCase() === stable.toLowerCase() ? 10_000n * unit : 10n ** 18n);
    const manual = await zapCreate(suffix + '-zap-create', dex, pool, tickLower, tickUpper, caps);
    await zapExit(suffix + '-zap-exit', dex, pool, manual, tickLower, tickUpper);
    const root = await zapCreate(suffix + '-zap-create-root', dex, pool, tickLower, tickUpper, caps);
    const nonce = await read(factory, factoryAbi, 'nextNonce', [user]);
    const predicted = await read(factory, factoryAbi, 'predictVault', [user, nonce]);
    await write(suffix + '-approve-predicted-vault', user, manager, NFT_ABI, 'approve', [predicted, root.tokenId]);
    await write(suffix + '-vault-create', user, factory, factoryAbi, 'createVault', [{ root: { dex, positionManager: manager, tokenId: root.tokenId },
      policy: { mode: 1, triggerDistanceBps: 500, maxOverlapBps: 2000, minimumIntervalSeconds: 600, maxPositions: 1 },
      limits: { maxSlippageBps: 100, maxPriceImpactBps: 200, maxObservationAgeSeconds: 300, upsideBps: 5000 },
      startPaused: false, consentToUncollectedFees: true }, nonce]);
    if (dex === 4) ensure((await read(manager, NFT_ABI, 'subscriber', [root.tokenId])).toLowerCase() === predicted.toLowerCase(), 'v4_vault_not_subscribed');
    let halt = null;
    if (dex === 3) {
      // The owner's guardian halts automation at once; an operator execution is refused until governance resumes it.
      const R = abis.registry, registry = contracts.registry, signers = ctx.safeSigners;
      await write('guardian-halts-automation', OWNER_ROLES.guardian, registry, R, 'haltAutomation');
      const refused = await fork.rpc('eth_call', [{ from: OWNER_ROLES.operator, to: predicted, data: viem.encodeFunctionData({ abi: vaultAbi, functionName: 'execute', args: ['0x01'] }) }, 'latest'])
        .then(() => null, error => error.message);
      ensure(refused !== null, 'halted_execution_not_refused');
      await write('operator-execution-while-halted', OWNER_ROLES.operator, predicted, vaultAbi, 'execute', ['0x01'], 0n, { expectRevert: true });
      // A resume must be scheduled after the halt (a strictly later timestamp), so a queued resume cannot undo it.
      await fork.advance(1);
      const scheduled = await safeExec(fork, OWNER_ROLES.governance, 'schedule-resume-automation', registry, viem.encodeFunctionData({ abi: R, functionName: 'scheduleChange', args: [kind('resumeAutomation'), '0x'] }), signers);
      const id = viem.parseEventLogs({ abi: R, logs: scheduled.logs, eventName: 'ChangeScheduled' })[0].args.id;
      await fork.advance(TIMELOCK + 1);
      await safeExec(fork, OWNER_ROLES.governance, 'execute-resume-automation', registry, viem.encodeFunctionData({ abi: R, functionName: 'executeChange', args: [id] }), signers);
      ensure(!(await read(registry, R, 'automationHalted')), 'automation_not_resumed');
      halt = { haltedBy: OWNER_ROLES.guardian, executionRefusedWhileHalted: true, resumedBy: OWNER_ROLES.governance, resumeChangeId: id };
    }
    await write(suffix + '-enable-auto-exit', user, predicted, vaultAbi, 'setExitModule', [contracts.autoExit]);
    const beforePrice = await read(contracts.priceAnchor, abis.priceAnchor, 'spotSqrtPrice', [pool]);
    const mandate = { owner: user, vault: predicted, tokenId: root.tokenId, triggerBelowSqrtPriceX96: 0n, triggerAboveSqrtPriceX96: beforePrice + 1n,
      receiveMode: 0, convertTo: ZERO, maxSlippageBps: 100, validUntil: (await deadline()) + 3300n, nonce: BigInt(dex) };
    const typed = { domain: { name: 'Domino', version: '2', chainId: profile.chainId, verifyingContract: contracts.autoExit }, types: { ExitMandate: eip712.types.ExitMandate }, primaryType: 'ExitMandate', message: mandate };
    await write(suffix + '-register-mandate', user, contracts.autoExit, abis.autoExit, 'registerMandate', [mandate, await ctx.user.signTypedData(typed)]);
    // Module ids are EIP-712 struct hashes (without the domain), not signature digests.
    const structHash = viem.hashStruct({ data: mandate, types: { ExitMandate: eip712.types.ExitMandate }, primaryType: 'ExitMandate' });
    const swapStable = 1000n * unit;
    if (dex === 3) {
      const routerAbi = viem.parseAbi(['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)']);
      const router = profile.uniswap.v3.swapRouter02;
      await write(suffix + '-approve-swap', user, stable, TOKEN_ABI, 'approve', [router, swapStable]);
      await write(suffix + '-swap-stable-in', user, router, routerAbi, 'exactInputSingle', [{ tokenIn: stable, tokenOut: weth, fee: pool.fee, recipient: user, amountIn: swapStable, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }]);
      await write(suffix + '-approve-reverse', user, weth, TOKEN_ABI, 'approve', [router, 10n ** 16n]);
      await write(suffix + '-swap-eth-in', user, router, routerAbi, 'exactInputSingle', [{ tokenIn: weth, tokenOut: stable, fee: pool.fee, recipient: user, amountIn: 10n ** 16n, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }]);
    } else {
      const routerAbi = viem.parseAbi(['function execute(bytes,bytes[],uint256) payable']), permitAbi = viem.parseAbi(['function approve(address,address,uint160,uint48)']);
      const router = profile.uniswap.universalRouter.address;
      await write(suffix + '-approve-permit2', user, stable, TOKEN_ABI, 'approve', [profile.permit2, swapStable]);
      await write(suffix + '-permit2-router', user, profile.permit2, permitAbi, 'approve', [stable, router, swapStable, await deadline()]);
      const v4Swap = async (zeroForOne, amount, label) => {
        const key = { currency0: pool.currency0, currency1: pool.currency1, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks };
        const params = [viem.encodeAbiParameters([{ type: 'tuple', components: [{ name: 'poolKey', type: 'tuple', components: POOL_REF.slice(1) }, { name: 'zeroForOne', type: 'bool' },
          { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'minHopPriceX36', type: 'uint256' }, { name: 'hookData', type: 'bytes' }] }],
        [{ poolKey: key, zeroForOne, amountIn: amount, amountOutMinimum: 1n, minHopPriceX36: 0n, hookData: '0x' }]),
        viem.encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [zeroForOne ? ZERO : stable, amount]),
        viem.encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [zeroForOne ? stable : ZERO, 1n])];
        await write(label, user, router, routerAbi, 'execute', ['0x10', [viem.encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], ['0x060c0f', params])], await deadline()], zeroForOne ? amount : 0n);
      };
      await v4Swap(false, swapStable, suffix + '-swap-stable-in');
      await v4Swap(true, 10n ** 16n, suffix + '-swap-eth-in');
    }
    await fork.advance(61);
    const plan = { action: 1, stateNonce: await read(predicted, vaultAbi, 'stateNonce'), deadline: await deadline(), target: root.tokenId, tickLower: 0, tickUpper: 0,
      amount0Max: MAX128, amount1Max: MAX128, minLiquidity: 1n, collect: [root.tokenId], budgets: [{ tokenId: root.tokenId, max0: MAX128, max1: MAX128 }],
      swap: { source: 0n, zeroForOne: false, amountIn: 0n, minAmountOut: 0n, legs: [] }, anchorEvidence: await signedEvidence(pool) };
    const planComponents = [{ name: 'action', type: 'uint8' }, { name: 'stateNonce', type: 'uint64' }, { name: 'deadline', type: 'uint64' }, { name: 'target', type: 'uint256' },
      { name: 'tickLower', type: 'int24' }, { name: 'tickUpper', type: 'int24' }, { name: 'amount0Max', type: 'uint128' }, { name: 'amount1Max', type: 'uint128' },
      { name: 'minLiquidity', type: 'uint128' }, { name: 'collect', type: 'uint256[]' },
      { name: 'budgets', type: 'tuple[]', components: [{ name: 'tokenId', type: 'uint256' }, { name: 'max0', type: 'uint128' }, { name: 'max1', type: 'uint128' }] },
      { name: 'swap', type: 'tuple', components: [{ name: 'source', type: 'uint256' }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' },
        { name: 'minAmountOut', type: 'uint128' }, { name: 'legs', type: 'tuple[]', components: LEG }] }, { name: 'anchorEvidence', type: 'bytes' }];
    const encodedPlan = '0x01' + viem.encodeAbiParameters([{ type: 'tuple', components: planComponents }], [plan]).slice(2);
    const tokens = [pool.currency0, pool.currency1], recipient = OWNER_ROLES.feeRecipient;
    const recipientBefore = await Promise.all(tokens.map(t => balance(t, recipient)));
    // The owner's operator executes the compound; the observation is the registered rehearsal publisher's.
    const compounded = await write(suffix + '-vault-compound-signed-observation', OWNER_ROLES.operator, predicted, vaultAbi, 'execute', [encodedPlan]);
    const [compound] = viem.parseEventLogs({ abi: vaultAbi, logs: compounded.logs, eventName: 'Compounded' });
    ensure(compound && compound.args.liquidityAdded > 0n, 'compound_added_nothing');
    const serviceFees = [compound.args.serviceFee0, compound.args.serviceFee1], consumed = [compound.args.fees0, compound.args.fees1];
    for (let i = 0; i < 2; i++) {
      const gross = consumed[i] === 0n ? 0n : (consumed[i] - 1n) * 10_000n / 9800n + 1n;
      ensure(serviceFees[i] === gross * 200n / 10_000n, suffix + '_token' + i + '_compound_fee_not_2pct_once');
      ensure(await balance(tokens[i], recipient) - recipientBefore[i] === serviceFees[i], suffix + '_token' + i + '_compound_fee_not_received');
    }
    const freshAnchor = await read(contracts.priceAnchor, abis.priceAnchor, 'spotSqrtPrice', [pool]);
    ensure(freshAnchor > beforePrice, 'swaps_did_not_cross_the_trigger');
    const exitBefore = await Promise.all(tokens.map(t => balance(t, recipient)));
    // The rehearsal operator, admitted through the timelock, triggers the owner-signed take-profit.
    const exited = await write(suffix + '-auto-exit-trigger', ctx.rehearsalOperator.address, contracts.autoExit, abis.autoExit, 'execute',
      [structHash, { anchorEvidence: await signedEvidence(pool), legs: [], amount0MinRemoved: 0n, amount1MinRemoved: 0n }]);
    ensure(Number(await read(contracts.autoExit, abis.autoExit, 'mandateStatus', [structHash])) === 3, 'mandate_not_executed');
    const removed = viem.parseEventLogs({ abi: vaultAbi, logs: exited.logs, eventName: 'ExitExecuted' }).filter(l => l.address.toLowerCase() === predicted.toLowerCase());
    ensure(removed.length === 1, 'exit_event_missing');
    const charged = viem.parseEventLogs({ abi: abis.autoExit, logs: exited.logs, eventName: 'FeeCharged' }).filter(l => l.address.toLowerCase() === contracts.autoExit.toLowerCase());
    const paid = tokens.map(t => charged.filter(l => l.args.token.toLowerCase() === t.toLowerCase()).reduce((s, l) => s + l.args.amount, 0n));
    ensure(charged.every(l => Number(l.args.kind) === 3 && l.args.payer.toLowerCase() === user.toLowerCase()), 'exit_fee_payer');
    const received = [removed[0].args.amount0, removed[0].args.amount1];
    const quote0to1 = amount => freshAnchor <= MAX128 ? amount * freshAnchor * freshAnchor / (1n << 192n) : amount * (freshAnchor * freshAnchor / (1n << 64n)) / (1n << 128n);
    // ETH or WETH is currency0 and the stable (rank 1) currency1 in every pool used here.
    ensure(received[0] > 0n && received[1] > 0n, 'exit_received_one_side');
    const due = (received[1] + quote0to1(received[0])) * 20n / 10_000n;
    ensure(paid[0] === 0n && paid[1] === due, 'exit_fee_not_0_2pct_in_the_ranked_currency');
    for (let i = 0; i < 2; i++) ensure(await balance(tokens[i], recipient) - exitBefore[i] === paid[i], 'exit_fee_not_received');
    for (const token of tokens) for (const component of [contracts['zap.' + suffix], contracts.vaultSwap, contracts.autoExit]) {
      ensure(await balance(token, component) === 0n, 'stateless_component_keeps_tokens');
    }
    results.pools.push({ dex, pool, poolAddress: dex === 3 ? v3Pool : undefined, poolId: dex === 4 ? v4Id(v4Pool) : undefined, stableHolder: whale,
      rootTokenId: root.tokenId.toString(), vault: predicted, halt, mandateHash: structHash, beforeSqrtPriceX96: beforePrice.toString(),
      triggeredSqrtPriceX96: freshAnchor.toString(), compound: { liquidityAdded: compound.args.liquidityAdded.toString(), fees: consumed.map(String), serviceFees: serviceFees.map(String) },
      autoExit: { received: received.map(String), feePaid: paid.map(String) } });
  }
  return results;
}

/** One chain: fork, preflight, deploy (straight, and interrupted + resumed from the same block), verify, roles, journeys. */
export async function rehearseChain(slug, upstreamUrl, artifacts, out) {
  const profile = chainProfile({ 'robinhood-4663': 4663, 'base-8453': 8453, 'arbitrum-42161': 42161 }[slug]);
  const nitro = profile.stack === 'arbitrum-nitro';
  const upstream = upstreamRpc(upstreamUrl, { robinhood: slug === 'robinhood-4663' });
  ensure(Number(quantity(await upstream('eth_chainId', []))) === profile.chainId, 'upstream_chain_mismatch');
  const head = await upstream('eth_getBlockByNumber', ['latest', false]);
  const fork = await startFork(profile, upstreamUrl, Number(quantity(head.number)), upstream);
  const report = { schemaVersion: 2, kind: 'domino-v2-fork-rehearsal', chain: { chainId: profile.chainId, slug: profile.slug, stack: profile.stack },
    upstream: slug === 'robinhood-4663' ? 'own-node-ssh-tunnel' : 'public-read-only-rpc',
    forkBlock: { number: Number(quantity(head.number)), hash: head.hash, timestamp: Number(quantity(head.timestamp)), baseFeePerGas: quantity(head.baseFeePerGas).toString() },
    sourceCommit: artifacts.sourceCommit, sourceTreeSha256: artifacts.sourceState.sourceTreeSha256,
    workingTree: { sourceChanges: artifacts.sourceState.workingTreeSourceChanges, toolChanges: artifacts.sourceState.workingTreeToolChanges },
    publicTransactionsSent: 0 };
  try {
    const f = onFork(fork.rpc);
    const roles = { ...OWNER_ROLES };
    const roleState = {};
    for (const name of ROLE_NAMES) roleState[name] = { address: roles[name].toLowerCase(), hasCode: (await fork.rpc('eth_getCode', [roles[name], 'latest'])) !== '0x',
      balanceWei: BigInt(await fork.rpc('eth_getBalance', [roles[name], 'latest'])).toString(), nonce: Number(quantity(await fork.rpc('eth_getTransactionCount', [roles[name], 'latest']))) };
    for (const name of ['deployer', 'guardian', 'feeRecipient', 'operator', 'publisher']) ensure(!roleState[name].hasCode, 'owner_role_has_code_on_fork: ' + name);
    report.roles = { ...Object.fromEntries(ROLE_NAMES.map(n => [n, roles[n].toLowerCase()])),
      governanceNote: 'the owner\'s Safe, as it exists on the chain at the fork block; its transactions are approved and executed by two impersonated owners', atForkBlock: roleState };
    // The rejections the owner's Safe check is built on, on this chain's real Safe code.
    const lower = Object.fromEntries(ROLE_NAMES.map(n => [n, roles[n].toLowerCase()]));
    const refusals = {};
    for (const [label, address] of [['owner guardian EOA', OWNER_ROLES.guardian], ['CreateX', '0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed']]) {
      refusals[label] = await inspectGovernance(address, fork.rpc, 'latest', lower).then(() => 'accepted', e => e.message);
    }
    const single = await createSafe(f, 'create-1-of-3-test-safe', [1, 2, 3].map(i => rehearsalAccount('safe-owner-' + i).address), 1, 303n);
    refusals['1-of-3 Safe'] = await inspectGovernance(single, fork.rpc, 'latest', lower).then(() => 'accepted', e => e.message);
    ensure(Object.values(refusals).every(r => r.startsWith('governance_')), 'governance_check_accepted_a_non_safe');
    report.governanceRefusals = refusals;
    const tip = nitro ? '0' : quantity(await upstream('eth_maxPriorityFeePerGas', [])).toString();
    const l1Rpc = nitro ? upstream : fork.rpc;
    const before = await fork.rpc('evm_snapshot', []);
    const planned = await planDeployment({ profile, roles, environment: 'fork-rehearsal', releaseTag: 'v2-rehearsal-2026-10-02', artifacts, rpc: fork.rpc, l1Rpc,
      simulate: simulateGas, maxPriorityFeePerGas: tip });
    const preflight = await preflightDeployment(planned.bundle, { rpc: fork.rpc, l1Rpc, simulatedGas: planned.simulatedGas, requireSafeGovernance: true });
    // Interrupted after five steps, then resumed from the deployer's next nonce; the chain then goes back.
    const interrupted = await executeSteps(planned.bundle, fork.rpc, { limit: 5 });
    const resumedPlan = await planDeployment({ profile, roles, environment: 'fork-rehearsal', artifacts, rpc: fork.rpc, l1Rpc, simulate: simulateGas,
      maxPriorityFeePerGas: tip, resumeFrom: planned.bundle });
    const resumedPreflight = await preflightDeployment(resumedPlan.bundle, { rpc: fork.rpc, l1Rpc, simulatedGas: resumedPlan.simulatedGas, requireSafeGovernance: true });
    const resumed = await executeSteps(resumedPlan.bundle, fork.rpc);
    const resumedManifest = await verifyDeployment(planned.bundle, { rpc: fork.rpc, transactionHashes: { ...interrupted, ...resumed } });
    report.resumeExercise = { interruptedAfter: Object.keys(interrupted), resumePackageSha256: packageDigest(resumedPlan.bundle), resumeOf: resumedPlan.bundle.parameters.resumeOf,
      resumeNonce: resumedPlan.bundle.parameters.nonce, resumedSteps: resumedPlan.bundle.parameters.steps, preflight: resumedPreflight.status,
      componentsAtResume: resumedPreflight.components, verified: resumedManifest.status, sameContractsAndCode: null };
    await fork.rpc('evm_revert', [before]);
    // The straight run the owner performs: eleven transactions, one at a time, from the real balance.
    const balanceBefore = BigInt(await fork.rpc('eth_getBalance', [roles.deployer, 'latest']));
    const hashes = await executeSteps(planned.bundle, fork.rpc);
    const balanceAfter = BigInt(await fork.rpc('eth_getBalance', [roles.deployer, 'latest']));
    const manifest = await verifyDeployment(planned.bundle, { rpc: fork.rpc, transactionHashes: hashes });
    validateManifest(manifest);
    report.resumeExercise.sameContractsAndCode = JSON.stringify([resumedManifest.contracts, resumedManifest.runtimeCodeHashes]) === JSON.stringify([manifest.contracts, manifest.runtimeCodeHashes]);
    ensure(report.resumeExercise.sameContractsAndCode, 'resumed_deployment_differs');
    writeJson(join(out, slug + '-deployment.json'), manifest);
    const steps = [];
    // Anvil lowers its base fee block after block; the chain's own price at the fork block is the honest estimate.
    const chainPrice = BigInt(report.forkBlock.baseFeePerGas) + BigInt(planned.bundle.parameters.maxPriorityFeePerGas);
    let atChainPrice = 0n;
    for (const step of preflight.steps) {
      const receipt = manifest.deploymentReceipts[step.component];
      const l1Gas = BigInt(step.l1Gas);
      atChainPrice += (BigInt(receipt.gasUsed) + l1Gas) * chainPrice + BigInt(step.l1FeeWei);
      steps.push({ component: step.component, nonce: step.nonce, simulatedExecutionGas: step.simulatedExecutionGas, forkGasUsed: receipt.gasUsed,
        liveL1Gas: step.l1Gas, liveL1FeeWei: step.l1FeeWei, gasLimit: step.gasLimit,
        limitOverForkPlusL1Percent: Number((BigInt(step.gasLimit) * 10000n) / (BigInt(receipt.gasUsed) + l1Gas)) / 100,
        effectiveGasPrice: receipt.effectiveGasPrice, transactionHash: receipt.transactionHash });
    }
    const forkCost = balanceBefore - balanceAfter;
    report.package = { sha256: packageDigest(planned.bundle), nonce: planned.bundle.parameters.nonce, maxFeePerGas: planned.bundle.parameters.maxFeePerGas,
      maxPriorityFeePerGas: planned.bundle.parameters.maxPriorityFeePerGas, expiresAt: planned.bundle.parameters.expiresAt };
    report.preflight = preflight;
    report.deployment = { status: 'verified', contracts: manifest.contracts, runtimeCodeHashes: manifest.runtimeCodeHashes, steps,
      forkGasUsed: steps.reduce((s, x) => s + BigInt(x.forkGasUsed), 0n).toString(),
      simulatedGas: steps.reduce((s, x) => s + BigInt(x.simulatedExecutionGas), 0n).toString(), gasLimitTotal: preflight.funding.gasLimitTotal };
    report.funding = { deployer: roles.deployer.toLowerCase(), nonceAtFork: roleState.deployer.nonce, balanceAtForkWei: balanceBefore.toString(),
      worstCaseWei: preflight.funding.worstCaseWei, maxFeeCeilingWei: preflight.funding.maxFeeCeilingWei,
      forkChargedWei: forkCost.toString(), forkChargeNote: nitro ? 'execution only at Anvil\'s decaying base fee; Nitro\'s L1 gas is not charged by a fork'
        : 'execution at Anvil\'s decaying base fee plus the L1 fee (--network optimism)',
      l1: nitro ? { method: 'NodeInterface.gasEstimateL1Component, live from the chain', l1GasTotal: steps.reduce((s, x) => s + BigInt(x.liveL1Gas), 0n).toString() }
        : { method: 'GasPriceOracle.getL1Fee at the fork block', l1FeeTotalWei: steps.reduce((s, x) => s + BigInt(x.liveL1FeeWei), 0n).toString() },
      chainPriceWei: chainPrice.toString(), estimatedCostAtChainPriceWei: atChainPrice.toString(),
      balanceAfterEstimateWei: (balanceBefore - atChainPrice).toString(), syntheticFunding: false };
    const contracts = manifest.contracts;
    const abis = Object.fromEntries(Object.entries(CONTRACT_NAMES).map(([k, name]) => [k, artifacts.contracts[name].abi]));
    // Two of the Safe's owners act for it on the fork: the deployer and the owner that holds no other role.
    const owners = (await f.read(OWNER_ROLES.governance, SAFE_ABI, 'getOwners')).map(o => viem.getAddress(o));
    const busy = [OWNER_ROLES.deployer, OWNER_ROLES.guardian].map(x => x.toLowerCase());
    const safeSigners = [OWNER_ROLES.deployer, owners.find(o => !busy.includes(o.toLowerCase())) ?? owners.find(o => o.toLowerCase() !== busy[0])];
    ensure(safeSigners.every(o => owners.some(x => x.toLowerCase() === o?.toLowerCase())), 'safe_signers_not_owners');
    const ctx = { profile, contracts, abis, safeSigners, user: rehearsalAccount('user'), rehearsalOperator: rehearsalAccount('operator'),
      rehearsalPublisher: rehearsalAccount('publisher') };
    report.ownerRoles = await exerciseOwnerRoles(f, ctx);
    report.journeys = await journeys(f, ctx);
    report.governance = { safe: OWNER_ROLES.governance, inspected: preflight.governance, ownersActingOnFork: safeSigners };
    report.actions = f.actions;
    report.syntheticGasOnFork = f.syntheticGas;
    report.status = 'passed';
    return report;
  } catch (error) {
    report.status = 'failed';
    // Errors come from the local EVM; never echo an endpoint.
    report.failure = String(error.message).replace(/https?:\/\/\S+/g, '[endpoint]');
    throw Object.assign(new Error(slug + ': ' + report.failure), { report });
  } finally {
    try { writeJson(join(out, slug + '-rehearsal.json'), report); } finally { await fork.stop(); }
  }
}

export async function rehearse({ out, robinhoodRpc, baseRpc = 'https://mainnet.base.org', arbitrumRpc = 'https://arb1.arbitrum.io/rpc', chains = CHAINS }) {
  const artifacts = compileV2();
  mkdirSync(resolve(out), { recursive: true });
  const urls = { 'robinhood-4663': robinhoodRpc, 'base-8453': baseRpc, 'arbitrum-42161': arbitrumRpc };
  const reports = [];
  for (const slug of chains) {
    ensure(CHAINS.includes(slug) && urls[slug], 'unknown_chain_or_missing_upstream: ' + slug);
    console.log(slug + ': rehearsing');
    reports.push(await rehearseChain(slug, urls[slug], artifacts, out));
    console.log(slug + ': passed');
  }
  const contracts = reports[0].deployment.contracts;
  for (const r of reports) ensure(JSON.stringify(r.deployment.contracts) === JSON.stringify(contracts), 'cross_chain_address_mismatch');
  const summary = { schemaVersion: 2, kind: 'domino-v2-fork-rehearsal-summary', status: 'passed', sourceCommit: artifacts.sourceCommit,
    identicalAddresses: true, productionDeployer: PRODUCTION_DEPLOYER, contracts,
    governanceSafe: OWNER_ROLES.governance, preflightWarnings: [...new Set(reports.flatMap(r => r.preflight.warnings))],
    chains: reports.map(r => ({ chainId: r.chain.chainId, forkBlock: r.forkBlock.number, forkGasUsed: r.deployment.forkGasUsed, simulatedGas: r.deployment.simulatedGas,
      gasLimitTotal: r.deployment.gasLimitTotal, maxFeePerGas: r.package.maxFeePerGas, worstCaseWei: r.funding.worstCaseWei, balanceAtForkWei: r.funding.balanceAtForkWei,
      estimatedCostAtChainPriceWei: r.funding.estimatedCostAtChainPriceWei, maxFeeCeilingWei: r.funding.maxFeeCeilingWei, resume: r.resumeExercise.verified, journeys: 'passed' })),
    publicTransactionsSent: 0 };
  writeJson(join(out, 'summary.json'), summary);
  return summary;
}

export async function cli(argv) {
  const f = flags(argv);
  ensure(f['robinhood-rpc'] && f.out && Object.keys(f).every(k => ['robinhood-rpc', 'base-rpc', 'arbitrum-rpc', 'out', 'chains'].includes(k)),
    'usage: --robinhood-rpc <own-node tunnel> --out <dir> [--base-rpc] [--arbitrum-rpc] [--chains a,b]');
  const summary = await rehearse({ out: f.out, robinhoodRpc: f['robinhood-rpc'], baseRpc: f['base-rpc'], arbitrumRpc: f['arbitrum-rpc'],
    chains: f.chains ? f.chains.split(',') : CHAINS });
  return JSON.stringify({ status: summary.status, chains: summary.chains.map(c => c.chainId) });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).then(message => console.log(message))
    .catch(error => { console.error(String(error.message).replace(/https?:\/\/\S+/g, '[endpoint]')); process.exitCode = 1; });
}
