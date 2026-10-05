/**
 * Money/signing review L1 (src/finance/v2/autoExit.ts signMandate, signedNothing): an exit order's signature nonce is
 * recorded in the journal before the wallet's prompt and leaves it only when nothing was signed, as src/finance/v2/zap.ts
 * signHeld does. Forgotten: a definite refusal, the bounded port's refusal before it invoked the provider
 * (WalletNotAsked: here the signing window closed before the prompt), the signer's own refusals before any prompt, the
 * preview lock. Kept (cancelNonce offered): the wallet's node failed while the prompt was out, or a check failed after
 * the wallet answered. Against the fake V2 vault chain; the prompt is eth_signTypedData_v4.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { ZERO, createVaultChain, vaultContracts, walletOf } from '../support/v2-vault-chain.mjs';
import { FAKE, USDG } from './support/plans.mjs';

const require = createRequire(import.meta.url);
const auto = require('../../.test-build/app/src/finance/v2/autoExit.js');
const { WalletNotAsked } = require('../../.test-build/app/src/finance/v2/transact.js');
const { forgetV2DeploymentChecks } = require('../../.test-build/app/src/finance/v2/deployment.js');
const chains = require('../../.test-build/app/src/v2/chains.js');

const NOW = 1_790_870_000;
const ROOT = 3_409_682n;
const ETH_USDG = { currency0: ZERO, currency1: USDG, fee: 3000, tickSpacing: 60 };
const prompts = (chain) => chain.log.filter((m) => m === 'eth_signTypedData_v4').length;

/**
 * A vault with auto-exit on and a client whose clock jumps past the signing window at a chosen moment: `at` 'record'
 * (the nonce just recorded, nothing asked yet: the port refuses the signer's first call) or 'prompt' (the wallet has
 * just answered the prompt: the port's check after the call fails).
 */
async function setup({ jump = null } = {}) {
  forgetV2DeploymentChecks();
  const chain = createVaultChain({ positions: [{ dex: 4, tokenId: ROOT, pool: ETH_USDG, tickLower: -201060, tickUpper: -198060 }], timestamp: NOW });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT });
  chain.setExitModule(vault, FAKE.autoExit);
  let late = false;
  const base = walletOf(chain);
  const wallet = {
    ...base,
    signatures: { ...base.signatures, record: async (entry) => { await base.signatures.record(entry); if (jump === 'record') late = true; } },
    request: async (method, params) => {
      const result = await base.request(method, params);
      if (jump === 'prompt' && method === 'eth_signTypedData_v4') late = true;
      return result;
    },
  };
  let draw = 7n;
  const client = auto.createAutoExitClient(wallet, chains.v2Chain(4663), vaultContracts(4663), () => (late ? NOW + 100_000 : NOW), () => draw++);
  const review = await client.reviewMandate({ vault, tokenId: ROOT, triggerBelowSqrtPriceX96: 79228162514264337593543950336n, triggerAboveSqrtPriceX96: 0n, receiveMode: 0, convertTo: ZERO, maxSlippageBps: 100, validUntil: 1_798_646_400n, acknowledgedWarnings: true });
  return { chain, wallet: base, client, review };
}

test('signedNothing: a definite refusal, a refusal before the provider (WalletNotAsked, any code), the signer\'s pre-prompt refusals and the money lock; nothing else', () => {
  assert.equal(auto.signedNothing(Object.assign(new Error('User rejected the request.'), { code: 4001 })), true);
  assert.equal(auto.signedNothing(new WalletNotAsked('wallet_action_expired')), true);
  assert.equal(auto.signedNothing(new WalletNotAsked('wallet_wrong_chain')), true, 'refused before the provider was invoked');
  // Changed on purpose (data) 2026-10-02 (Domino V2 integration, item 6): the old preview build's lock is gone; the money
  // lock before V2's contracts are live (finance/v2/liveLock.ts) refuses before any prompt.
  assert.equal(auto.signedNothing(new Error('contracts_not_live')), true);
  for (const code of ['typed_data_chain_mismatch', 'typed_data_signer_mismatch', 'typed_data_not_signable']) assert.equal(auto.signedNothing(new Error(code)), true, code);
  // The port's checks AFTER the wallet answered use the same words as plain errors: a signature may exist.
  for (const code of ['wallet_wrong_chain', 'wallet_identity_changed', 'wallet_timeout', 'invalid_signature', 'signature_not_from_owner', 'signature_high_s']) assert.equal(auto.signedNothing(new Error(code)), false, code);
  assert.equal(auto.signedNothing(Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603 })), false);
  assert.equal(auto.signedNothing(undefined), false);
});

test('the signing window closed after the nonce was recorded, before the prompt: WalletNotAsked, the nonce leaves the journal, no cancelNonce offered', async () => {
  const { chain, wallet, client, review } = await setup({ jump: 'record' });
  await assert.rejects(client.signMandate(review), (error) => error instanceof WalletNotAsked && error.message === 'wallet_action_expired');
  assert.equal(prompts(chain), 0, 'the wallet never saw the prompt');
  assert.equal(wallet.held.size, 0, 'the never-signed nonce is not held');
  assert.deepEqual(client.heldNonces(), [], 'so no paid cancelNonce is offered for it');
  assert.deepEqual(wallet.journal.map(([what]) => what), ['record', 'forget']);
});

test('a definite refusal at the prompt forgets the nonce; the wallet\'s node failing while the prompt was out, or a check after the wallet answered, keeps it held', async () => {
  const declined = await setup();
  declined.chain.decline();
  await assert.rejects(declined.client.signMandate(declined.review), (error) => error.code === 4001);
  assert.equal(declined.wallet.held.size, 0);

  const lost = await setup();
  lost.chain.failNext('eth_signTypedData_v4');
  await assert.rejects(lost.client.signMandate(lost.review), /Internal JSON-RPC error/);
  assert.equal(prompts(lost.chain), 1);
  assert.equal(lost.wallet.held.size, 1, 'the prompt was out: a signature may exist');
  assert.deepEqual(lost.client.heldNonces().map((entry) => entry.nonce), [lost.review.mandate.nonce], 'offered for cancelling');

  const answered = await setup({ jump: 'prompt' });
  await assert.rejects(answered.client.signMandate(answered.review), /wallet_identity_changed/);
  assert.equal(prompts(answered.chain), 1, 'the wallet answered the prompt');
  assert.equal(answered.wallet.held.size, 1, 'a check after the answer keeps the nonce held');
});
