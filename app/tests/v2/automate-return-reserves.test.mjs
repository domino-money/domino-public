/**
 * Domino V2 integration (2026-10-02, spec F7 rev4 §2.13, §5.6, #311): the vault client's `return-reserves` action, the
 * owner's "Return my reserves" after the root was closed (by S1's exit, burned, or directly on Uniswap, the NFT kept):
 * `returnReserves()` 0x8192ff3b on the vault, offered only while the contract's own two conditions hold, read live in its
 * order (no active successor, else SuccessorActive; the root closed, else RootOpen) and something is held; every reserve
 * of both pool tokens to the owner, no fee. Against the fake V2 vault chain (tests/support/v2-vault-chain.mjs).
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { decodeFunctionData } from 'viem';
import { ABI, OTHER, ZERO, createVaultChain, vaultContracts, walletOf } from '../support/v2-vault-chain.mjs';
import { USDG, WETH } from './support/plans.mjs';

const require = createRequire(import.meta.url);
const { createVaultClient, VAULT_TEXT } = require('../../.test-build/app/src/finance/v2/vault.js');
const { forgetV2DeploymentChecks } = require('../../.test-build/app/src/finance/v2/deployment.js');
const { decodeRevertData } = require('../../.test-build/app/src/v2/errors.js');
const chains = require('../../.test-build/app/src/v2/chains.js');

const NOW = 1_790_870_000;
const GAS = { maxGas: 2_000_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 0n, reserveWei: 0n };
const ROOT = 3_409_682n;
const ROOT_V3 = 77n;
const CHILD = 3_500_001n;
const ETH_USDG = { currency0: ZERO, currency1: USDG, fee: 3000, tickSpacing: 60 };
const WETH_USDG_V3 = { currency0: WETH, currency1: USDG, fee: 3000, tickSpacing: 60 };
const LIMITS = Object.freeze({ maxSlippageBps: 100, maxPriceImpactBps: 200, maxObservationAgeSeconds: 600, upsideBps: 1000 });

async function setup({ account } = {}) {
  forgetV2DeploymentChecks();
  const chain = createVaultChain({ positions: [
    { dex: 4, tokenId: ROOT, pool: ETH_USDG, tickLower: -201060, tickUpper: -198060 },
    { dex: 3, tokenId: ROOT_V3, pool: WETH_USDG_V3 },
  ], timestamp: NOW });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, limits: LIMITS });
  const vaultV3 = await chain.seedVault({ dex: 3, tokenId: ROOT_V3, limits: LIMITS });
  chain.setLot(vault, ROOT, USDG, { uncharged: 100n, charged: 5n });
  chain.setLot(vault, ROOT, ZERO, { uncharged: 7n, charged: 0n });
  chain.setIdle(vault, USDG, 1_000n);
  chain.setLot(vaultV3, ROOT_V3, USDG, { uncharged: 30n, charged: 0n });
  const wallet = walletOf(chain, account ? { account } : {});
  const client = createVaultClient(wallet, chains.v2Chain(4663), vaultContracts(4663), () => NOW);
  return { chain, wallet, client, vault, vaultV3 };
}

async function act(client, vault, action) {
  const review = await client.reviewAction(vault, action);
  const prepared = await client.prepareStep(review, 0, GAS);
  const hash = await client.send(prepared, true);
  return { review, receipt: await client.receipt(hash) };
}

test('a root closed directly on Uniswap (the NFT kept): returnReserves() pays every reserve to the owner, no fee', async () => {
  const { chain, client, vault, wallet } = await setup();
  await assert.rejects(client.reviewAction(vault, { kind: 'return-reserves' }), /^Error: vault_root_open$/, 'an open root: refused before anything is sent');
  chain.closeRoot(4, ROOT);
  const { review, receipt } = await act(client, vault, { kind: 'return-reserves' });
  assert.equal(review.steps.length, 1);
  assert.equal(review.steps[0].kind, 'return-reserves');
  assert.equal(review.steps[0].to, vault);
  assert.equal(review.steps[0].data, '0x8192ff3b', 'returnReserves(), no argument: nothing in it names a recipient');
  assert.equal(decodeFunctionData({ abi: ABI.vault, data: review.steps[0].data }).functionName, 'returnReserves');
  assert.deepEqual(review.notes, ['vault_returns_to_owner']);
  assert.match(VAULT_TEXT.vault_returns_to_owner, /No Domino fee/);
  assert.ok(receipt.state === 'included' || receipt.state === 'finalized');
  const returned = chain.paid.filter((entry) => entry.why === 'returnReserves');
  assert.ok(returned.length === 2 && returned.every((entry) => entry.to === wallet.owner), 'both tokens, to the owner and to no one else');
  const events = receipt.events.filter((event) => event.eventName === 'ReservesWithdrawn');
  assert.deepEqual(events.map((event) => [event.args.token.toLowerCase(), event.args.amount]).sort(), [[USDG.toLowerCase(), 1_105n], [ZERO, 7n]].sort());
  assert.equal(new Set(events.map((event) => event.args.stateNonce)).size, 1, 'the state nonce moved once');
  // Nothing left: a second press is refused before the wallet, as the contract would pay nothing.
  await assert.rejects(client.reviewAction(vault, { kind: 'return-reserves' }), /^Error: vault_reserves_empty$/);
});

test('a burned root (S1\'s full exit) is closed too; an active successor refuses first, as the contract does', async () => {
  const { chain, client, vault } = await setup();
  chain.addSuccessor(vault, { tokenId: CHILD, parent: ROOT, lots: [{ token: USDG, uncharged: 4n }] });
  chain.closeRoot(4, ROOT, { burn: true });
  await assert.rejects(client.reviewAction(vault, { kind: 'return-reserves' }), /^Error: vault_successor_active$/);
  await act(client, vault, { kind: 'withdraw-child', tokenId: CHILD });
  const { receipt } = await act(client, vault, { kind: 'return-reserves' });
  const events = receipt.events.filter((event) => event.eventName === 'ReservesWithdrawn');
  // The successor's lot became idle when it was withdrawn: it is returned with the rest.
  assert.deepEqual(events.map((event) => [event.args.token.toLowerCase(), event.args.amount]).sort(), [[USDG.toLowerCase(), 1_109n], [ZERO, 7n]].sort());
});

test('v3: liquidity 0 is closed, and so is a burned NFT (the manager\'s own "Invalid token ID")', async () => {
  const { chain, client, vaultV3 } = await setup();
  await assert.rejects(client.reviewAction(vaultV3, { kind: 'return-reserves' }), /^Error: vault_root_open$/);
  chain.closeRoot(3, ROOT_V3, { burn: true });
  const { review, receipt } = await act(client, vaultV3, { kind: 'return-reserves' });
  assert.equal(review.steps[0].data, '0x8192ff3b');
  assert.deepEqual(receipt.events.filter((event) => event.eventName === 'ReservesWithdrawn').map((event) => event.args.amount), [30n]);
});

test('only the vault\'s owner is offered it here (anyone may call it on chain: the money goes to the owner either way)', async () => {
  const { chain, vault } = await setup();
  chain.closeRoot(4, ROOT);
  const stranger = createVaultClient(walletOf(chain, { account: OTHER }), chains.v2Chain(4663), vaultContracts(4663), () => NOW);
  await assert.rejects(stranger.reviewAction(vault, { kind: 'return-reserves' }), /^Error: vault_not_owner$/);
});

test('the contract\'s refusals decode to their sentences (spec rev4 §5.6)', () => {
  const labels = { chainId: 4663 };
  const open = decodeRevertData('0xdae47e24', 'vault', labels);
  assert.equal(open.code, 'RootOpen()');
  assert.equal(open.copy, VAULT_TEXT.vault_root_open);
  const successor = decodeRevertData('0xa1c3fa1f', 'vault', labels);
  assert.equal(successor.code, 'SuccessorActive()');
  assert.equal(successor.copy, VAULT_TEXT.vault_successor_active);
  assert.equal(decodeRevertData('0x945e9268', 'vault', labels).code, 'InsufficientReserves()');
});
