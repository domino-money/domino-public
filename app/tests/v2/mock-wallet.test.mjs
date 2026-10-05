/**
 * The test wallets' V2 behaviour (spec F7 §1.8 last row, §7.5), without a browser: tests/support/mock-wallet.mjs is
 * driven through a fake Playwright context that hands over the request function the pages would call. Typed data is
 * signed by the account and recovers to it, and is refused for another chain, as MetaMask refuses it; capabilities are
 * answered per chain; a V2 wallet knows Base and Arbitrum, and a default wallet still knows only 4663 and 1.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { recoverTypedDataAddress } from 'viem';
import { ACCOUNTS, installWallets } from '../support/mock-wallet.mjs';
import { V2_METHODS, V2_WALLET_CHAINS } from '../support/mock-wallet-v2.mjs';

const require = createRequire(import.meta.url);
const typed = require('../../.test-build/app/src/finance/v2/typedData.js');
const fixtures = require('../../.test-build/app/src/v2/manifestFixtures.js');

/** What a Playwright BrowserContext gives installWallets: the exposed request function is kept, nothing is injected. */
function fakeContext() {
  const exposed = new Map();
  return {
    exposed,
    async exposeFunction(name, fn) { exposed.set(name, fn); },
    async addInitScript() {},
    pages: () => [],
  };
}

async function install(wallets) {
  const context = fakeContext();
  const control = await installWallets(context, wallets);
  const request = context.exposed.get('__dominoWalletRequest');
  assert.equal(typeof request, 'function');
  return { control, request };
}

const V2_WALLET = { id: 'v2', name: 'Test Wallet V2', rdns: 'test.wallet.v2', uuid: '8f2a7d1c-0000-4000-8000-00000000000c', chains: [...V2_WALLET_CHAINS] };
const owner = ACCOUNTS[0].address;

/** An auto-exit order for the fixture deployment on `chainId`, as the app builds it (src/finance/v2/typedData.ts). */
const mandateTyped = (chainId) => typed.exitMandateTypedData(chainId, fixtures.fixtureContracts(chainId).addresses.autoExit, {
  owner,
  vault: '0x00000000000000000000000000000000000000aa',
  tokenId: 7n,
  triggerBelowSqrtPriceX96: 3543191142285914205922034n,
  triggerAboveSqrtPriceX96: 0n,
  receiveMode: 0,
  convertTo: '0x0000000000000000000000000000000000000000',
  maxSlippageBps: 100,
  validUntil: 1_900_000_000n,
  nonce: 1n,
});
const viewOf = (wire) => {
  const parsed = JSON.parse(wire);
  const { EIP712Domain, ...types } = parsed.types;
  assert.ok(EIP712Domain);
  return { domain: parsed.domain, types, primaryType: parsed.primaryType, message: parsed.message };
};

test('a default wallet is as before: 4663 and 1 only, 4902 for Base and Arbitrum, no batching, no typed data until connected', async () => {
  const { control, request } = await install();
  for (const id of ['a', 'b']) {
    const wallet = control.state.wallets.get(id);
    assert.deepEqual([wallet.account, wallet.chainId, wallet.permitted, [...wallet.chains], wallet.added], [0, 4663, false, [4663, 1], []]);
  }
  assert.deepEqual(await request('a', 'wallet_switchEthereumChain', [{ chainId: '0x2105' }]), { error: { code: 4902, message: 'Unrecognized chain ID' } });
  assert.deepEqual(await request('a', 'wallet_switchEthereumChain', [{ chainId: '0xa4b1' }]), { error: { code: 4902, message: 'Unrecognized chain ID' } });
  assert.deepEqual(await request('a', 'eth_chainId', []), { result: '0x1237' });
  assert.deepEqual(await request('a', 'wallet_switchEthereumChain', [{ chainId: '0x1' }]), { result: null });
  assert.deepEqual(await request('a', 'eth_chainId', []), { result: '0x1' });
  assert.deepEqual(await request('a', 'wallet_getCapabilities', [owner, ['0x1237']]), { result: {} }, 'batches nothing, whatever is asked');
  assert.deepEqual(await request('a', 'wallet_getCapabilities', []), { result: {} });
  assert.deepEqual(await request('b', 'eth_signTypedData_v4', [owner, typed.wireTypedData(mandateTyped(4663))]), { error: { code: 4100, message: 'Unauthorized' } });
  assert.deepEqual(await request('a', 'eth_sendTransaction', [{}]), { error: { code: 4200, message: 'eth_sendTransaction is not supported' } });
  assert.deepEqual(control.state.refused, ['a: eth_sendTransaction'], 'an unlisted method is still refused and recorded');
  assert.deepEqual(control.state.signedTyped, []);
  assert.deepEqual([...V2_METHODS].sort(), ['eth_signTypedData_v4', 'wallet_getCapabilities']);
});

test('a V2 wallet knows Robinhood Chain, Base and Arbitrum One, and switches between them', async () => {
  const { control, request } = await install([V2_WALLET]);
  assert.deepEqual([...control.state.wallets.get('v2').chains], [4663, 8453, 42161]);
  for (const [hex, id] of [['0x2105', 8453], ['0xa4b1', 42161], ['0x1237', 4663]]) {
    assert.deepEqual(await request('v2', 'wallet_switchEthereumChain', [{ chainId: hex }]), { result: null });
    assert.deepEqual(await request('v2', 'eth_chainId', []), { result: hex });
    assert.equal(control.state.wallets.get('v2').chainId, id);
  }
  assert.deepEqual(await request('v2', 'wallet_switchEthereumChain', [{ chainId: '0x1' }]), { error: { code: 4902, message: 'Unrecognized chain ID' } });
});

test('typed data is signed by the account on the wallet\'s chain, recovers to it, and is recorded', async () => {
  const { control, request } = await install([V2_WALLET]);
  await request('v2', 'eth_requestAccounts', []);
  await request('v2', 'wallet_switchEthereumChain', [{ chainId: '0x2105' }]);
  const wire = typed.wireTypedData(mandateTyped(8453));
  const reply = await request('v2', 'eth_signTypedData_v4', [owner.toLowerCase(), wire]);
  assert.match(reply.result, /^0x[0-9a-f]{130}$/);
  assert.equal(await recoverTypedDataAddress({ ...viewOf(wire), signature: reply.result }), owner);
  assert.equal(control.state.signedTyped.length, 1);
  const [record] = control.state.signedTyped;
  assert.deepEqual({ id: record.id, from: record.from, primaryType: record.primaryType, signature: record.signature }, { id: 'v2', from: owner.toLowerCase(), primaryType: 'ExitMandate', signature: reply.result });
  assert.equal(record.domain.chainId, 8453);
  assert.equal(record.message.triggerBelowSqrtPriceX96, '3543191142285914205922034');
  assert.deepEqual(control.state.signed, [], 'personal_sign\'s list is untouched');

  // The app's own signer, end to end: it re-reads the account and the chain, asks once, and checks the signature.
  const wallet = {
    owner,
    current: () => true,
    async request(method, params) {
      const answer = await request('v2', method, params);
      if (answer.error) throw Object.assign(new Error(answer.error.message), { code: answer.error.code });
      return answer.result;
    },
  };
  const signed = await typed.signV2TypedData(wallet, mandateTyped(8453), { chainId: 8453, signer: owner, shape: 'ecdsa-low-s' });
  assert.equal(signed.chainId, 8453);
  assert.equal(signed.digest, typed.typedDataDigest(mandateTyped(8453)));
  assert.equal(control.state.signedTyped.length, 2);
  // Permit2's domain has no version; the wallet signs it as it comes.
  const permit = typed.permit2WitnessTypedData(8453, fixtures.fixtureContracts(8453).addresses.zapV4, { permitted: [{ token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amount: 1_000_000n }], nonce: 5n, deadline: 1_900_000_000n }, {
    action: 1,
    pool: { dex: 4, currency0: '0x0000000000000000000000000000000000000000', currency1: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', fee: 500, tickSpacing: 10, hooks: '0x0000000000000000000000000000000000000000' },
    tokenId: 0n, tickLower: -200000, tickUpper: -190000, minLiquidity: 1n, feeBps: 65, feeToken: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    routesHash: typed.NO_LEGS_ROUTES_HASH, recipient: owner, nonce: 5n, deadline: 1_900_000_000n,
  });
  const permitReply = await request('v2', 'eth_signTypedData_v4', [owner, typed.wireTypedData(permit)]);
  assert.equal(await recoverTypedDataAddress({ ...viewOf(typed.wireTypedData(permit)), signature: permitReply.result }), owner);
});

test('typed data for another chain than the wallet\'s is refused, as MetaMask refuses it; so is another account, or a refusal', async () => {
  const { control, request } = await install([V2_WALLET]);
  await request('v2', 'eth_requestAccounts', []);
  assert.equal(control.state.wallets.get('v2').chainId, 4663);
  assert.deepEqual(await request('v2', 'eth_signTypedData_v4', [owner, typed.wireTypedData(mandateTyped(8453))]), {
    error: { code: -32603, message: 'Provided chainId "8453" must match the active chainId "4663"' },
  });
  assert.deepEqual(await request('v2', 'eth_signTypedData_v4', [ACCOUNTS[1].address, typed.wireTypedData(mandateTyped(4663))]), { error: { code: 4100, message: 'Unauthorized' } });
  assert.equal((await request('v2', 'eth_signTypedData_v4', [owner, '{not json'])).error.code, -32602);
  assert.equal((await request('v2', 'eth_signTypedData_v4', [owner, JSON.stringify({ types: {} })])).error.code, -32602);
  control.rejectNext('v2', 'eth_signTypedData_v4');
  assert.deepEqual(await request('v2', 'eth_signTypedData_v4', [owner, typed.wireTypedData(mandateTyped(4663))]), { error: { code: 4001, message: 'User rejected the request.' } });
  assert.deepEqual(control.state.signedTyped, [], 'nothing was signed');
  // The app's signer refuses before it asks: the wallet is on Robinhood Chain, the order is for Base.
  const wallet = { owner, current: () => true, request: async (method, params) => (await request('v2', method, params)).result };
  await assert.rejects(typed.signV2TypedData(wallet, mandateTyped(8453), { chainId: 8453, signer: owner, shape: 'ecdsa-low-s' }), /wallet_wrong_chain/);
  assert.equal(control.calls('eth_signTypedData_v4').length, 5, 'the signer never reached the wallet\'s prompt');
  // On the right chain it signs.
  await request('v2', 'wallet_switchEthereumChain', [{ chainId: '0x1237' }]);
  assert.match((await request('v2', 'eth_signTypedData_v4', [owner, typed.wireTypedData(mandateTyped(4663))])).result, /^0x[0-9a-f]{130}$/);
});

test('capabilities are answered per chain: only the chains asked, for the connected account, and {} where none is declared', async () => {
  const capabilities = { '0x2105': { atomic: { status: 'supported' } }, '0xA4B1': { atomic: { status: 'ready' } } };
  const { request } = await install([{ ...V2_WALLET, capabilities }]);
  assert.deepEqual(await request('v2', 'wallet_getCapabilities', [owner, ['0x2105']]), { error: { code: 4100, message: 'Unauthorized' } }, 'not before the site is connected');
  await request('v2', 'eth_requestAccounts', []);
  assert.deepEqual(await request('v2', 'wallet_getCapabilities', [owner, ['0x2105']]), { result: { '0x2105': { atomic: { status: 'supported' } } } });
  assert.deepEqual(await request('v2', 'wallet_getCapabilities', [owner, ['0xa4b1']]), { result: { '0xa4b1': { atomic: { status: 'ready' } } } });
  assert.deepEqual(await request('v2', 'wallet_getCapabilities', [owner, ['0x1237']]), { result: {} }, 'a chain it declares nothing for');
  assert.deepEqual(await request('v2', 'wallet_getCapabilities', [owner, ['0x1237', '0x2105']]), { result: { '0x2105': { atomic: { status: 'supported' } } } });
  assert.deepEqual(await request('v2', 'wallet_getCapabilities', [owner]), { result: { '0x2105': { atomic: { status: 'supported' } }, '0xa4b1': { atomic: { status: 'ready' } } } }, 'every declared chain when none is named');
  assert.deepEqual(await request('v2', 'wallet_getCapabilities', [ACCOUNTS[2].address, ['0x2105']]), { error: { code: 4100, message: 'Unauthorized' } });
});
