/** Shared fixtures of the V2 deployment tool's offline tests (not a test file itself). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { repoRoot, viem, compileV2, DEPLOY_ORDER, MAX_TRANSACTION_GAS, quantity } from './deploy.mjs';
import { startAnvil, installCreateX, installOfflineDependencies, localRoles, rehearsalAccount, waitReceipt } from './deploy-anvil.mjs';

let artifacts;
/** One compile per test process; identical standard-JSON input reuses the cached output (tests only). */
export function compiled() {
  artifacts ??= compileV2({ cacheDirectory: process.env.DOMINO_V2_COMPILE_CACHE ?? join(repoRoot, 'contracts/cache/v2-deploy-tests') });
  return artifacts;
}

export const roles = localRoles();
export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const hex = value => viem.toHex(BigInt(value));
export const checksummed = label => viem.getAddress('0x' + viem.keccak256(viem.toHex(label)).slice(26));

/** A plain Anvil with canonical CreateX and the synthetic dependency stubs (the `local-test` chain). */
export async function offlineChain({ chainId } = {}) {
  const anvil = await startAnvil({ args: chainId ? ['--chain-id', String(chainId)] : [] });
  try {
    await installCreateX(anvil.rpc);
    return { ...anvil, profile: await installOfflineDependencies(anvil.rpc) };
  } catch (error) { await anvil.stop(); throw error; }
}

/** prepareDeployment parameters for a fresh package, every field explicit. */
export function parametersFor(profile, overrides = {}) {
  return { profile, roles, environment: 'local-test', sourceCommit: compiled().sourceCommit, releaseTag: 'v2-test', nonce: '0',
    gasLimits: Object.fromEntries(DEPLOY_ORDER.map(c => [c, MAX_TRANSACTION_GAS.toString()])), maxFeePerGas: '100000000000',
    maxPriorityFeePerGas: '0', expiresAt: nowSeconds() + 3600, steps: [...DEPLOY_ORDER], resumeOf: null, ...overrides };
}

/** An RPC function whose answers `override(method, params)` may replace (undefined keeps the real one). */
export function scripted(rpc, override) {
  return async (method, params) => {
    const replaced = await override(method, params);
    return replaced === undefined ? rpc(method, params) : replaced;
  };
}
export const selector = signature => viem.toFunctionSelector(signature);
export const isCall = (method, params, to, signature) => method === 'eth_call' && params[0].to?.toLowerCase() === to.toLowerCase()
  && params[0].data.startsWith(selector(signature));

export async function send(rpc, from, to, data, value = 0n) {
  await rpc('anvil_impersonateAccount', [from]);
  await rpc('anvil_setBalance', [from, hex(10n ** 21n)]);
  const hash = await rpc('eth_sendTransaction', [{ from, to, data, value: hex(value), gas: hex(10_000_000) }]);
  await rpc('anvil_stopImpersonatingAccount', [from]);
  const receipt = await waitReceipt(rpc, hash);
  assert.equal(receipt.status, '0x1', 'local transaction reverted');
  return receipt;
}

export const SAFE = JSON.parse(readFileSync(join(repoRoot, 'scripts/v2/deploy-fixtures/safe-runtime.json'), 'utf8'));
export const safeOwners = [1, 2, 3].map(i => rehearsalAccount('safe-owner-' + i).address);
const SETUP = viem.parseAbi(['function setup(address[] owners, uint256 threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)']);

/** A real Safe on the local chain: the canonical SafeL2 1.4.1 runtime at its address, a 1.4.1 proxy at
 * `address` pointing to it, then the singleton's own `setup`. */
export async function installSafe(rpc, { address, owners = safeOwners, threshold = 2, singleton = SAFE.singleton.address }) {
  if (await rpc('eth_getCode', [SAFE.singleton.address, 'latest']) === '0x') await rpc('anvil_setCode', [SAFE.singleton.address, SAFE.singleton.runtime]);
  await rpc('anvil_setCode', [address, SAFE.proxy.runtime]);
  await rpc('anvil_setStorageAt', [address, '0x0', viem.padHex(singleton.toLowerCase(), { size: 32 })]);
  const zero = '0x' + '0'.repeat(40);
  await send(rpc, checksummed('safe-setup-caller'), address, viem.encodeFunctionData({ abi: SETUP, functionName: 'setup',
    args: [owners, BigInt(threshold), zero, '0x', zero, zero, 0n, zero] }));
  return address;
}

export const quantityOf = value => quantity(value);
