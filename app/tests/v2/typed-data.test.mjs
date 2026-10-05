/**
 * Domino V2's typed data (spec F7 §2.3, §2.5, §4.2, §7.5): every golden of api-contracts/v2/eip712-goldens.json is
 * reproduced with the app's own viem, from the app's own builders (src/finance/v2/typedData.ts), and the wire JSON a
 * wallet receives hashes to the same digest. The types are compared with api-contracts/v2/eip712.json field by field.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { hashTypedData, keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const require = createRequire(import.meta.url);
const typed = require('../../.test-build/app/src/finance/v2/typedData.js');

/** JSON.parse, but integers too wide for a double stay exact (as BigInt). */
const exact = (text) => JSON.parse(text.replace(/(:\s*)(-?\d{16,})(\s*[,}\]])/g, '$1"#big:$2"$3'), (_key, value) =>
  (typeof value === 'string' && value.startsWith('#big:') ? BigInt(value.slice(5)) : value));
const GOLDENS = exact(readFileSync(new URL('../../../api-contracts/v2/eip712-goldens.json', import.meta.url), 'utf8'));
const EIP712 = JSON.parse(readFileSync(new URL('../../../api-contracts/v2/eip712.json', import.meta.url), 'utf8'));
const big = (value) => BigInt(value);
const { domain } = GOLDENS;

const intentOf = (raw) => ({
  action: raw.action,
  pool: { ...raw.pool },
  tokenId: big(raw.tokenId),
  tickLower: raw.tickLower,
  tickUpper: raw.tickUpper,
  minLiquidity: big(raw.minLiquidity),
  feeBps: raw.feeBps,
  feeToken: raw.feeToken,
  routesHash: raw.routesHash,
  recipient: raw.recipient,
  nonce: big(raw.nonce),
  deadline: big(raw.deadline),
});
const legsOf = (raw) => raw.map((leg) => ({ ...leg, amountIn: big(leg.amountIn), minAmountOut: big(leg.minAmountOut) }));
const mandateOf = (raw) => ({
  ...raw,
  tokenId: big(raw.tokenId),
  triggerBelowSqrtPriceX96: big(raw.triggerBelowSqrtPriceX96),
  triggerAboveSqrtPriceX96: big(raw.triggerAboveSqrtPriceX96),
  validUntil: big(raw.validUntil),
  nonce: big(raw.nonce),
});

test('the goldens are read exactly: no integer lost precision on the way in', () => {
  assert.equal(GOLDENS.fixtures.PositionIntent.minLiquidity, 123456789012345678n);
  assert.equal(GOLDENS.fixtures.ExitMandate.triggerBelowSqrtPriceX96, 79228162514264337593543950336n);
  assert.equal(GOLDENS.fixtures.RelayedPositionAction.amount0MinRemoved, 4200000000000000n);
});

test('routesHash: the golden leg gives 0x3f539f7e…, and no legs gives the empty array hash', () => {
  assert.equal(typed.routesHash(legsOf(GOLDENS.fixtures.SwapLeg)), '0x3f539f7e015f09a9c197e20e2d9f3e45d8b4fc875714d48227f082b93fcf8dc7');
  assert.equal(typed.routesHash(legsOf(GOLDENS.fixtures.SwapLeg)), GOLDENS.routesHash);
  assert.equal(typed.routesHash([]), '0x569e75fc77c1a856f6daaf9e69d8a9566ca34aa47f9133711ce065a571af0cfd');
  assert.equal(typed.routesHash([]), typed.NO_LEGS_ROUTES_HASH);
});

test('PositionIntent digest (the zap\'s intentHash) is 0x642f715e…', () => {
  const intent = intentOf(GOLDENS.fixtures.PositionIntent);
  const digest = typed.intentHash(domain.chainId, domain.verifyingContract, intent);
  assert.equal(digest, '0x642f715eea2ecb377a9d3adbda7e0051399a89ec5c1f8bc2e4921f3bdc068df3');
  assert.equal(digest, GOLDENS.digests.PositionIntent);
});

test('Permit2 batch witness digest is 0x6aa9acf7…, and its domain has no version', () => {
  const golden = GOLDENS.fixtures.Permit2;
  const permit = { permitted: golden.permitted.map((p) => ({ token: p.token, amount: big(p.amount) })), nonce: big(golden.nonce), deadline: big(golden.deadline) };
  const data = typed.permit2WitnessTypedData(4663, golden.spender, permit, intentOf(golden.witness));
  assert.deepEqual(Object.keys(data.domain), ['name', 'chainId', 'verifyingContract']);
  assert.deepEqual(data.types.EIP712Domain.map((f) => f.name), ['name', 'chainId', 'verifyingContract']);
  assert.equal(typed.typedDataDigest(data), '0x6aa9acf7bc27a72ca98abcccc7fc59d5ac5b110b504a4846b9d0ca02d1cc20ae');
  assert.equal(typed.typedDataDigest(data), GOLDENS.digests.Permit2BatchWitness);
});

test('RelayedPositionAction digest is 0xa3be36f3…', () => {
  const golden = GOLDENS.fixtures.RelayedPositionAction;
  const action = {
    intent: intentOf(golden.intent),
    liquidityToRemove: big(golden.liquidityToRemove),
    amount0MinRemoved: big(golden.amount0MinRemoved),
    amount1MinRemoved: big(golden.amount1MinRemoved),
    amount0Max: big(golden.amount0Max),
    amount1Max: big(golden.amount1Max),
    burn: golden.burn,
  };
  const data = typed.relayedActionTypedData(domain.chainId, domain.verifyingContract, action);
  assert.equal(typed.typedDataDigest(data), '0xa3be36f3170f4a3d96db8f1e453afb016434929e707fb1d409d48ca9c83026cf');
  assert.equal(typed.typedDataDigest(data), GOLDENS.digests.RelayedPositionAction);
});

test('ExitMandate digest is 0x2a3403aa…, and its id is the STRUCT hash 0x9e9e8144…, not the digest', () => {
  const mandate = mandateOf(GOLDENS.fixtures.ExitMandate);
  const data = typed.exitMandateTypedData(domain.chainId, domain.verifyingContract, mandate);
  assert.equal(typed.typedDataDigest(data), '0x2a3403aaa791d63d81c9cd4f5a2865e7178fb19bc7e6a781712b9c05d45cf1bb');
  assert.equal(typed.typedDataDigest(data), GOLDENS.digests.ExitMandate);
  assert.equal(typed.mandateId(mandate), '0x9e9e81446114b3d191bec32453583427ce0931f2021588367c86505e91213025');
  assert.equal(typed.mandateId(mandate), GOLDENS.structHashes.ExitMandate);
  assert.notEqual(typed.mandateId(mandate), typed.typedDataDigest(data));
});

test('the Domino domain separator is the golden one', () => {
  // hashTypedData of EIP712Domain alone is keccak(0x1901 ‖ separator); the separator is checked through viem's own hashDomain.
  const { hashDomain } = require('viem');
  const types = { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] };
  assert.equal(hashDomain({ domain, types }), GOLDENS.domainSeparator);
});

test('the types are api-contracts/v2/eip712.json\'s, field by field, and so are their typehashes', () => {
  assert.deepEqual(typed.POOL_REF_TYPE, EIP712.types.PoolRef);
  assert.deepEqual(typed.POSITION_INTENT_TYPE, EIP712.types.PositionIntent);
  assert.deepEqual(typed.EXIT_MANDATE_TYPE, EIP712.types.ExitMandate);
  assert.deepEqual(typed.RELAYED_POSITION_ACTION_TYPE, EIP712.types.RelayedPositionAction);
  assert.deepEqual(typed.PERMIT_BATCH_WITNESS_TYPE, EIP712.permit2.types.PermitBatchWitnessTransferFrom);
  assert.deepEqual(typed.TOKEN_PERMISSIONS_TYPE, EIP712.permit2.types.TokenPermissions);
  for (const name of ['PoolRef', 'PositionIntent', 'ExitMandate', 'RelayedPositionAction']) {
    assert.equal(keccak256(stringToHex(EIP712.encodedTypes[name])), EIP712.typehashes[name], name);
  }
  assert.equal(keccak256(stringToHex(EIP712.permit2.fullType)), EIP712.permit2.fullTypehash);
  assert.equal(typed.PERMIT2, EIP712.permit2.domain.verifyingContract.toLowerCase());
});

test('the wire JSON a wallet receives is the golden JSON\'s shape and hashes to the same digest', () => {
  const golden = GOLDENS.fixtures.Permit2;
  const permit = { permitted: golden.permitted.map((p) => ({ token: p.token, amount: big(p.amount) })), nonce: big(golden.nonce), deadline: big(golden.deadline) };
  const wire = JSON.parse(typed.wireTypedData(typed.permit2WitnessTypedData(4663, golden.spender, permit, intentOf(golden.witness))));
  // As the spec's golden JSON (§2.5.2): EIP712Domain without version, wide integers as decimal strings.
  assert.deepEqual(wire.types.EIP712Domain, [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }]);
  assert.equal(wire.primaryType, 'PermitBatchWitnessTransferFrom');
  assert.deepEqual(wire.domain, { name: 'Permit2', chainId: 4663, verifyingContract: '0x000000000022d473030f116ddee9f6b43ac78ba3' });
  assert.deepEqual(wire.message.permitted, [{ token: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', amount: '1000000000' }]);
  assert.equal(wire.message.witness.minLiquidity, '123456789012345678');
  assert.equal(wire.message.witness.tickLower, -201060);
  // A wallet hashes what it receives: the same digest.
  const { EIP712Domain, ...types } = wire.types;
  void EIP712Domain;
  assert.equal(hashTypedData({ domain: wire.domain, types, primaryType: wire.primaryType, message: wire.message }), GOLDENS.digests.Permit2BatchWitness);
});

test('the chain is in every domain: the same intent on another chain is another digest', () => {
  const intent = intentOf(GOLDENS.fixtures.PositionIntent);
  const digests = [4663, 8453, 42161].map((chainId) => typed.intentHash(chainId, domain.verifyingContract, intent));
  assert.equal(new Set(digests).size, 3);
});

// ---------------------------------------------------------------------------
// The signer
// ---------------------------------------------------------------------------

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const account = privateKeyToAccount(KEY);
function walletFor({ chainId = 4663, owner = account.address, sign = 'good', current = () => true } = {}) {
  const asked = [];
  return {
    asked,
    owner: owner.toLowerCase(),
    current,
    async request(method, params) {
      asked.push(method);
      if (method === 'eth_accounts') return [owner];
      if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
      if (method === 'eth_signTypedData_v4') {
        if (sign === 'reject') throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
        const wire = JSON.parse(params[1]);
        const { EIP712Domain, ...types } = wire.types;
        void EIP712Domain;
        const signature = await account.signTypedData({ domain: wire.domain, types, primaryType: wire.primaryType, message: wire.message });
        if (sign === 'v01') return `${signature.slice(0, 130)}${(Number.parseInt(signature.slice(130), 16) - 27).toString(16).padStart(2, '0')}`;
        if (sign === 'high-s') {
          const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
          const s = BigInt(`0x${signature.slice(66, 130)}`);
          const v = Number.parseInt(signature.slice(130), 16) === 27 ? 28 : 27;
          return `${signature.slice(0, 66)}${(n - s).toString(16).padStart(64, '0')}${v.toString(16)}`;
        }
        if (sign === 'other') return privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80').signTypedData({ domain: wire.domain, types, primaryType: wire.primaryType, message: wire.message });
        return signature;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}
const mandateData = (chainId = 4663) => typed.exitMandateTypedData(chainId, domain.verifyingContract, { ...mandateOf(GOLDENS.fixtures.ExitMandate), owner: account.address.toLowerCase() });

test('signing re-reads the account and the chain right before the prompt, and returns a signature that recovers to the owner', async () => {
  const wallet = walletFor();
  const signed = await typed.signV2TypedData(wallet, mandateData(), { chainId: 4663, signer: account.address, shape: 'ecdsa-low-s' });
  assert.deepEqual(wallet.asked, ['eth_accounts', 'eth_chainId', 'eth_signTypedData_v4']);
  assert.equal(signed.chainId, 4663);
  assert.equal(signed.digest, typed.typedDataDigest(mandateData()));
  assert.match(signed.signature, /^0x[0-9a-f]{130}$/);
});

test('a wallet on another chain is refused before any prompt; so is a typed data for another chain or another signer', async () => {
  const onBase = walletFor({ chainId: 8453 });
  await assert.rejects(typed.signV2TypedData(onBase, mandateData(), { chainId: 4663, signer: account.address, shape: 'ecdsa-low-s' }), /wallet_wrong_chain/);
  assert.equal(onBase.asked.includes('eth_signTypedData_v4'), false);
  const wallet = walletFor();
  await assert.rejects(typed.signV2TypedData(wallet, mandateData(8453), { chainId: 4663, signer: account.address, shape: 'ecdsa' }), /typed_data_chain_mismatch/);
  await assert.rejects(typed.signV2TypedData(wallet, mandateData(), { chainId: 4663, signer: '0x0000000000000000000000000000000000000b0b', shape: 'ecdsa' }), /typed_data_signer_mismatch/);
  await assert.rejects(typed.signV2TypedData(wallet, mandateData(1), { chainId: 1, signer: account.address, shape: 'ecdsa' }), /typed_data_chain_mismatch/);
  assert.equal(wallet.asked.length, 0);
});

test('the intent alone is never signed', async () => {
  const wallet = walletFor();
  const data = typed.intentTypedData(4663, domain.verifyingContract, intentOf(GOLDENS.fixtures.PositionIntent));
  await assert.rejects(typed.signV2TypedData(wallet, data, { chainId: 4663, signer: account.address, shape: 'ecdsa' }), /typed_data_not_signable/);
});

test('a recovery id of 0/1 is written as 27/28; a high s is refused where the contract requires a low one; another key is refused', async () => {
  const v01 = await typed.signV2TypedData(walletFor({ sign: 'v01' }), mandateData(), { chainId: 4663, signer: account.address, shape: 'ecdsa-low-s' });
  assert.match(v01.signature.slice(130), /^(1b|1c)$/);
  await assert.rejects(typed.signV2TypedData(walletFor({ sign: 'high-s' }), mandateData(), { chainId: 4663, signer: account.address, shape: 'ecdsa-low-s' }), /signature_high_s/);
  await assert.rejects(typed.signV2TypedData(walletFor({ sign: 'other' }), mandateData(), { chainId: 4663, signer: account.address, shape: 'ecdsa' }), /signature_not_from_owner/);
});

test('a refusal (4001) is the wallet\'s, thrown as it was; a wallet that changed during the prompt is refused', async () => {
  await assert.rejects(typed.signV2TypedData(walletFor({ sign: 'reject' }), mandateData(), { chainId: 4663, signer: account.address, shape: 'ecdsa' }), (error) => error.code === 4001);
  let calls = 0;
  const changing = walletFor({ current: () => ++calls < 3 });
  await assert.rejects(typed.signV2TypedData(changing, mandateData(), { chainId: 4663, signer: account.address, shape: 'ecdsa' }), /wallet_identity_changed/);
});
