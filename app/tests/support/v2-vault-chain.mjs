/**
 * TEST-ONLY. A browser wallet on a Domino V2 chain (4663, 8453 or 42161) that is also the chain behind it, for the V2
 * vault and auto-exit clients (src/finance/v2/vault.ts, autoExit.ts), in the shape of ./position-chain.mjs. Every Domino
 * address is the invented FAKE set of tests/v2/support/plans.mjs; the contracts set this file exports says
 * `fixture: true`; the keys are the public Anvil development keys. Nothing here exists on any real network.
 *
 * What it holds, each answering as its contract's interface (api-contracts/v2/abi) says:
 *   - Uniswap's v4 PositionManager and v3 NonfungiblePositionManager at the chain profile's addresses: position NFTs
 *     with ownerOf, getApproved, the individual approve, subscriber/unsubscribe (v4), getPoolAndPositionInfo (v4) and
 *     positions with tokensOwed (v3). setApprovalForAll is not there: a call to it reverts and is recorded.
 *   - The two vault factories: nextNonce, predictVault (a deterministic function of factory, owner and nonce), isVault,
 *     createVault refusing an unexpected nonce (UnexpectedNonce), a root not held or not individually approved to the
 *     predicted vault (AutomationUnavailable), no consent or a wrong root (InvalidInit), a hooked v4 pool (HookedPool),
 *     another subscriber (ForeignSubscriber) and the §5.2 limits (InvalidPolicy, InvalidLimits).
 *   - The vaults it creates: every view of IDominoVault and IDominoVaultLedger, `rootArmed` live, and the owner's
 *     actions with their reverts (Unauthorized, InvalidInit, AutomationUnavailable, ForeignSubscriber, InvalidAmount,
 *     InsufficientReserves, InvalidPosition, InvalidPolicy, InvalidLimits).
 *   - The auto-exit module: registerMandate (the terms of spec §4.2, the nonce, the signature recovered from the typed
 *     data with a low s, the vault's owner), nonceUsed, mandateStatus, mandateOf, revokeMandate, cancelNonce, unclaimed,
 *     claim, MAX_SLIPPAGE_BPS = 1000, each refusal with spec §4.9's selector.
 *   - The registry: automationHalted, chargeCurrencyRank (the chain profile's ranks).
 *   - Runtime code at each component whose keccak256 is the exported contracts set's `codeHashes`; the owner's own code
 *     (none, or an EIP-7702 designator).
 * Every transaction is included in its own block, with the contracts' events encoded with viem from the ABI JSON.
 *
 * Added on purpose (data) 2026-10-02 (Domino V2 PHASE B, the vault's and the mandate's EIP-5792 batches), all off by
 * default so every earlier test sees the same wallet: `atomic` ('supported' | 'ready') makes the wallet answer
 * wallet_getCapabilities with that `atomic.status` for its chain (null answers 4200 as before); `simulateV1` makes it carry
 * eth_simulateV1 (each call from the owner, state carried; a failing call and every later one status 0x0); with `atomic`,
 * wallet_sendCalls runs the calls atomically as ONE transaction of the owner's (one nonce, all the calls' logs, a revert of
 * any call reverts them all, in a block of its own) and wallet_getCallsStatus answers 100 while `holdBatches()` holds, then
 * 200 (500 for a reverted batch). eth_getLogs answers the included logs by address and topics. `declineBatch(code)`
 * refuses the next wallet_sendCalls with `code`; `batches` records each one asked.
 *
 * `decline()` refuses the next send or signature with 4001; `revert()` includes the next send with status 0;
 * `failNext(method)` fails the next ask as a wallet's node does now and then; `moveNonce(dex)` is another tab creating
 * a vault from the same wallet; `lag()` freezes the factories' views as a lagging node would; `switchChain(id)` moves
 * the wallet to another network. `walletOf(chain)` is the V2Wallet the clients take, with in-memory per-chain nonce and
 * signature journals.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { concatHex, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, getContractAddress, hashStruct, keccak256, numberToHex, recoverTypedDataAddress, toFunctionSelector } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { FAKE } from '../v2/support/plans.mjs';

const require = createRequire(import.meta.url);
const chains = require('../../.test-build/app/src/v2/chains.js');

export const ZERO = '0x0000000000000000000000000000000000000000';
const lower = (value) => String(value).toLowerCase();

/** The public Anvil development accounts (they hold nothing anywhere real). #1 is the owner, #2 another person. */
const ANVIL_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
];
const ACCOUNTS = new Map(ANVIL_KEYS.map((key) => [lower(privateKeyToAccount(key).address), privateKeyToAccount(key)]));
export const [ANVIL_0, OWNER, OTHER] = [...ACCOUNTS.keys()];

// ---------------------------------------------------------------------------
// ABIs (the exported JSON, plus ERC-721's individual approve), errors and code
// ---------------------------------------------------------------------------

const json = (name) => JSON.parse(readFileSync(new URL(`../../../api-contracts/v2/abi/${name}.json`, import.meta.url), 'utf8')).abi;
const APPROVE = { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'tokenId', type: 'uint256' }], outputs: [] };
/**
 * Changed on purpose (data) 2026-10-02 (Domino V2 integration, spec rev4 §5.6, #311 d1ad6c41): IDominoVaultLedger's
 * returnReserves() and its two errors, as #311's export declares them, added while this tree's export predates it (as
 * src/finance/v2/abi.ts does), never twice.
 */
const LEDGER = json('IDominoVaultLedger');
const RETURN_RESERVES = [
  { type: 'function', name: 'returnReserves', stateMutability: 'nonpayable', inputs: [], outputs: [{ name: 'amount0', type: 'uint256' }, { name: 'amount1', type: 'uint256' }] },
  { type: 'error', name: 'RootOpen', inputs: [] },
  { type: 'error', name: 'SuccessorActive', inputs: [] },
].filter((item) => !LEDGER.some((have) => have.type === item.type && have.name === item.name));
export const ABI = Object.freeze({
  vault: [...json('IDominoVault'), ...LEDGER, ...RETURN_RESERVES],
  factory: json('IDominoVaultFactory'),
  autoExit: [...json('IDominoAutoExit'), ...json('IDominoAutoExitExtension')],
  registry: json('IDominoRegistry'),
  priceAnchor: json('IDominoPriceAnchor'),
  v3Pool: json('IUniswapV3PoolMinimal'),
  v4StateView: json('IV4StateViewMinimal'),
  v4: [...json('IV4PositionManagerMinimal'), APPROVE],
  v3: [...json('IUniswapV3PositionManagerMinimal'), APPROVE],
});

/** The refusals this chain makes, by signature; tests/v2 check each selector against the spec's table. */
export const ERRORS = Object.freeze({
  Unauthorized: 'Unauthorized()',
  InvalidInit: 'InvalidInit()',
  UnexpectedNonce: 'UnexpectedNonce(uint256,uint256)',
  AutomationUnavailable: 'AutomationUnavailable()',
  HookedPool: 'HookedPool(address)',
  ForeignSubscriber: 'ForeignSubscriber(address)',
  InvalidPolicy: 'InvalidPolicy()',
  InvalidLimits: 'InvalidLimits()',
  InvalidPosition: 'InvalidPosition()',
  InvalidAmount: 'InvalidAmount()',
  InsufficientReserves: 'InsufficientReserves()',
  MandateAlreadyRegistered: 'MandateAlreadyRegistered()',
  InvalidMandate: 'InvalidMandate()',
  NonceAlreadyUsed: 'NonceAlreadyUsed()',
  InvalidSignature: 'InvalidSignature()',
  MandateNotActive: 'MandateNotActive()',
  NothingToClaim: 'NothingToClaim()',
  InvalidRecipient: 'InvalidRecipient()',
  // Changed on purpose (data) 2026-10-02 (Domino V2 integration, spec rev4 §5.6, #311): returnReserves()'s refusals.
  RootOpen: 'RootOpen()',
  SuccessorActive: 'SuccessorActive()',
  // Added 2026-10-04 (rugged97's delta of 4 Oct §2 item 1): a token that refuses a transfer to one address.
  TokenCallFailed: 'TokenCallFailed(address)',
});
/** Spec §4.9 and §5.8's selectors. */
export const SPEC_SELECTORS = Object.freeze({
  Unauthorized: '0x82b42900', InvalidInit: '0xab849bda', UnexpectedNonce: '0x315f0ba0', AutomationUnavailable: '0xb114dfff',
  HookedPool: '0x1758b8a8', ForeignSubscriber: '0x7889477f', InvalidPolicy: '0xd06b96b1', InvalidLimits: '0xe773e0a9',
  InvalidPosition: '0xce7e065e', InvalidAmount: '0x2c5211c6', InsufficientReserves: '0x945e9268',
  MandateAlreadyRegistered: '0x6f6ffce9', InvalidMandate: '0x544cad7e', NonceAlreadyUsed: '0x1fb09b80', InvalidSignature: '0x8baa579f',
  MandateNotActive: '0x952501f6', NothingToClaim: '0x969bf728', InvalidRecipient: '0x9c8d2cd2',
  RootOpen: '0xdae47e24', SuccessorActive: '0xa1c3fa1f', TokenCallFailed: '0xfecb69b4',
});

class Revert extends Error {
  constructor(data) { super('execution reverted'); this.data = data; }
}
/** Reverts with the contract's own revert data: selector and ABI-encoded arguments. */
function revert(name, ...values) {
  const signature = ERRORS[name];
  const types = signature.slice(signature.indexOf('(') + 1, -1).split(',').filter(Boolean);
  const selector = toFunctionSelector(signature);
  throw new Revert(types.length ? concatHex([selector, encodeAbiParameters(types.map((type) => ({ type })), values)]) : selector);
}
const revertString = (text) => { throw new Revert(concatHex(['0x08c379a0', encodeAbiParameters([{ type: 'string' }], [text])])); };

/** Invented runtime code per component: its keccak256 is the contracts set's codeHash. */
export const CODES = Object.freeze({
  registry: '0x60d0d001600055',
  autoExit: '0x60d0d002600055',
  zapV3: '0x60d0d003600055',
  zapV4: '0x60d0d004600055',
  vaultFactoryV3: '0x60d0d005600055',
  vaultFactoryV4: '0x60d0d006600055',
});
const CLONE_CODE = '0x363d3d373d3d3d363d73d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d05af43d82803e903d91602b57fd5bf3';
const DELEGATE_CODE = '0x60016000526001601ff3';
/** Stand-ins for Uniswap's managers' code (the clients do not pin Uniswap's code; the chain profile names them). */
const UNISWAP_CODE = Object.freeze({ v3: '0x60aa600355', v4: '0x60aa600455', stateView: '0x60aa600456', v3Pool: '0x60aa600301' });
/**
 * Added 2026-10-06 (the review of the owner's point 5: Auto-exit reads the pool's own price before it arms an edge): the
 * pools' price when a test sets none, 2 x 2^96 (tick about 6,931): above every lower trigger the client tests sign (the
 * golden's 2^96), and no upper one is armed there. A test of Auto-exit's edges sets its own (`setPrice`).
 */
export const DEFAULT_SQRT_PRICE = 2n * 79228162514264337593543950336n;

/**
 * Added on purpose (data) 2026-10-02 (Domino V2 rev2 §5.2): the price anchor's TEST-ONLY address and invented code, in a
 * set only when asked (`vaultContracts(chainId, { anchor: true })`), as a manifest set carries it.
 */
export const PRICE_ANCHOR = '0x00000000000000000000000000000000d0d00007';
const PRICE_ANCHOR_CODE = '0x60d0d007600055';

/** The TEST-ONLY contracts set of this chain: the FAKE addresses, their code's hashes, `fixture: true`; the anchor when asked. */
export function vaultContracts(chainId, { anchor = false } = {}) {
  const set = { chainId, addresses: { ...FAKE }, codeHashes: Object.fromEntries(Object.entries(CODES).map(([name, code]) => [name, keccak256(code)])), fixture: true };
  if (anchor) {
    set.addresses.priceAnchor = PRICE_ANCHOR;
    set.codeHashes.priceAnchor = keccak256(PRICE_ANCHOR_CODE);
  }
  return set;
}

// ---------------------------------------------------------------------------
// Typed data, as the module checks it (independently of the app's builder)
// ---------------------------------------------------------------------------

export const MANDATE_TYPES = Object.freeze({
  ExitMandate: [
    { name: 'owner', type: 'address' }, { name: 'vault', type: 'address' }, { name: 'tokenId', type: 'uint256' },
    { name: 'triggerBelowSqrtPriceX96', type: 'uint160' }, { name: 'triggerAboveSqrtPriceX96', type: 'uint160' },
    { name: 'receiveMode', type: 'uint8' }, { name: 'convertTo', type: 'address' }, { name: 'maxSlippageBps', type: 'uint16' },
    { name: 'validUntil', type: 'uint64' }, { name: 'nonce', type: 'uint256' },
  ],
});
/** The module's id of a mandate: its EIP-712 struct hash. */
export const mandateHash = (mandate) => hashStruct({ data: mandate, primaryType: 'ExitMandate', types: MANDATE_TYPES });
const HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

const MAX_ROOT = (1n << 96n) - 1n;
const BASE_BLOCK = 0x10_0000;
const txHash = (index) => numberToHex((0x7a5n << 200n) + BigInt(index), { size: 32 });
const blockHash = (index) => numberToHex((0xb10cn << 200n) + BigInt(index), { size: 32 });

function eventLog(abi, address, eventName, args) {
  const item = abi.find((entry) => entry.type === 'event' && entry.name === eventName);
  if (!item) throw new Error(`no event ${eventName}`);
  const indexed = item.inputs.filter((input) => input.indexed);
  const plain = item.inputs.filter((input) => !input.indexed);
  const topics = encodeEventTopics({ abi: [item], eventName, args: Object.fromEntries(indexed.map((input) => [input.name, args[input.name]])) });
  const data = plain.length ? encodeAbiParameters(plain, plain.map((input) => args[input.name])) : '0x';
  return { address: lower(address), topics, data };
}

const policyValid = (p, members) => (p.mode === 1 || p.mode === 2) && p.triggerDistanceBps <= 2000 && p.maxOverlapBps <= 2000 && p.minimumIntervalSeconds > 0
  && p.maxPositions >= Math.max(1, members) && (p.mode !== 1 || p.maxPositions === 1);
const limitsValid = (l) => l.maxSlippageBps < 10000 && l.maxPriceImpactBps < 10000 && l.maxObservationAgeSeconds > 0 && l.upsideBps >= 1 && l.upsideBps <= 1_000_000;

/**
 * `positions`: [{ dex: 3|4, tokenId, owner?, pool: { currency0, currency1, fee, tickSpacing, hooks? }, tickLower, tickUpper,
 *   liquidity?, owed?: [a, b] (v3 tokensOwed), approved?, subscriber? (v4) }]
 * `ownerCode`: the owner's own code (an EIP-7702 designator '0xef0100…'), null for a plain account.
 */
export function createVaultChain({ chainId = 4663, owner = OWNER, positions = [], timestamp = 1_790_870_000, finality = 'final', ownerCode = null, atomic = null, simulateV1 = false } = {}) {
  const profile = chains.v2Chain(chainId);
  const PM = { 3: profile.uniswap.v3.positionManager, 4: profile.uniswap.v4.positionManager };
  const FACTORY = { 3: lower(FAKE.vaultFactoryV3), 4: lower(FAKE.vaultFactoryV4) };
  const AUTO_EXIT = lower(FAKE.autoExit), REGISTRY = lower(FAKE.registry);
  owner = lower(owner);
  const code = new Map(Object.entries(CODES).map(([name, bytes]) => [lower(FAKE[name]), bytes]));
  code.set(PM[3], UNISWAP_CODE.v3);
  code.set(PM[4], UNISWAP_CODE.v4);
  code.set(PRICE_ANCHOR, PRICE_ANCHOR_CODE);
  // §5.2's two prices on v3 (rev2): the anchor's TWAP (null: TwapUnavailable) and each v3 pool's spot, by pool address.
  let twap = null;
  const v3Spots = new Map();
  const v3PoolOf = (pool) => lower(getContractAddress({ opcode: 'CREATE2', from: profile.uniswap.v3.factory, salt: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }], [pool.currency0, pool.currency1, pool.fee])), bytecodeHash: profile.uniswap.v3.poolInitCodeHash }));
  // Added 2026-10-06 (Auto-exit's edges): each v4 pool's price by its id, through the chain profile's StateView.
  const STATE_VIEW = lower(profile.uniswap.v4.stateView);
  code.set(STATE_VIEW, UNISWAP_CODE.stateView);
  const v4Prices = new Map();
  const v4PoolId = (pool) => lower(keccak256(encodeAbiParameters([{ type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] }], [{ currency0: lower(pool.currency0), currency1: lower(pool.currency1), fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: lower(pool.hooks ?? ZERO) }])));
  // Every listed position's v3 pool answers slot0, at the default price until a test sets one.
  for (const p of positions) {
    if (p.dex !== 3) continue;
    const at = v3PoolOf({ currency0: lower(p.pool.currency0), currency1: lower(p.pool.currency1), fee: p.pool.fee });
    if (!v3Spots.has(at)) v3Spots.set(at, DEFAULT_SQRT_PRICE);
    code.set(at, UNISWAP_CODE.v3Pool);
  }
  if (ownerCode !== null) {
    code.set(owner, lower(ownerCode));
    const delegate = /^0xef0100([0-9a-f]{40})$/.exec(lower(ownerCode));
    if (delegate) code.set(`0x${delegate[1]}`, DELEGATE_CODE);
  }

  let state = {
    nfts: new Map(),
    nonces: { 3: new Map(), 4: new Map() },
    made: { 3: new Set(), 4: new Set() },
    vaults: new Map(),
    module: { status: new Map(), records: new Map(), used: new Set(), unclaimed: new Map() },
    halted: false,
    operators: new Set(),
    paid: [],
    /** `${token}|${to}`: transfers of that token to that address revert TokenCallFailed (a token's blocklist). */
    refused: new Set(),
  };
  const nftKey = (dex, tokenId) => `${dex}:${BigInt(tokenId)}`;
  for (const p of positions) {
    state.nfts.set(nftKey(p.dex, p.tokenId), {
      dex: p.dex, tokenId: BigInt(p.tokenId), owner: lower(p.owner ?? owner), approved: lower(p.approved ?? ZERO), subscriber: lower(p.subscriber ?? ZERO),
      pool: { currency0: lower(p.pool.currency0), currency1: lower(p.pool.currency1), fee: p.pool.fee, tickSpacing: p.pool.tickSpacing, hooks: lower(p.pool.hooks ?? ZERO) },
      tickLower: p.tickLower ?? -600, tickUpper: p.tickUpper ?? 600, liquidity: p.liquidity ?? 10n ** 18n, owed: p.owed ? [...p.owed] : [0n, 0n],
    });
  }

  const log = [], calls = [], sends = [], declined = [], signed = [], strange = [];
  let refuseNext = false, revertNext = false, walletChain = chainId, lagged = null, clock = timestamp, finalState = null;
  // The batch path (added on purpose 2026-10-02): what wallet_sendCalls was asked, the next refusal, a hold on the status.
  const batches = [];
  let refuseBatch = null, holdBatch = false;
  const failing = new Map();
  const receipts = [];
  const counts = new Map();
  const latestNumber = () => BASE_BLOCK + sends.length;
  const latest = () => ({ number: numberToHex(latestNumber()), timestamp: numberToHex(clock + 2 * sends.length), hash: blockHash(10_000 + sends.length) });
  const now = () => BigInt(clock + 2 * sends.length);

  const predict = (dex, who, nonce) => lower(`0x${keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [FACTORY[dex], lower(who), BigInt(nonce)])).slice(-40)}`);
  const rank = (token) => chains.profileRank(profile, token);
  const quoteOf = (pool) => {
    const r0 = rank(pool.currency0), r1 = rank(pool.currency1);
    if (r0 > 0 && (r1 === 0 || r0 <= r1)) return pool.currency0;
    return pool.currency1;
  };
  const armed = (st, v) => {
    const nft = st.nfts.get(nftKey(v.dex, v.root.tokenId));
    return !v.disarmed && !!nft && !nft.burned && nft.owner === v.owner && nft.approved === v.address && (v.dex === 3 || nft.subscriber === v.address);
  };
  const lotOf = (v, tokenId, token) => v.lots.get(`${tokenId}|${lower(token)}`) ?? { uncharged: 0n, charged: 0n };
  const reservesOf = (v, token) => {
    let total = v.idle.get(lower(token)) ?? 0n;
    for (const [key, lot] of v.lots) if (key.endsWith(`|${lower(token)}`)) total += lot.uncharged + lot.charged;
    return total;
  };
  const activeMembers = (v) => [...v.members.values()].filter((m) => m.active).length;
  const decode = (abi, data, label, ctx) => {
    try {
      return decodeFunctionData({ abi, data });
    } catch {
      ctx.calls.push(`${label}.${String(data).slice(0, 10)}`);
      strange.push({ label, data });
      throw new Revert('0x');
    }
  };
  const enc = (abi, functionName, result) => encodeFunctionResult({ abi, functionName, result });

  /** The vault a factory creates: the effects of createVault after its checks. */
  function makeVault(st, ctx, dex, who, init, nonce) {
    const tokenId = init.root.tokenId;
    const nft = st.nfts.get(nftKey(dex, tokenId));
    const address = predict(dex, who, nonce);
    if (dex === 4) nft.subscriber = address;
    if (dex === 3 && (nft.owed[0] > 0n || nft.owed[1] > 0n)) {
      // Whatever the manager owes the root is collected to the owner at arming (spec §5.1).
      st.paid.push({ to: who, tokens: [nft.pool.currency0, nft.pool.currency1], amounts: [...nft.owed], why: 'v3-owed-at-arming' });
      nft.owed = [0n, 0n];
    }
    const pool = { dex, ...nft.pool };
    st.nonces[dex].set(who, nonce + 1n);
    st.made[dex].add(address);
    st.vaults.set(address, {
      address, dex, factory: FACTORY[dex], owner: who, pool, root: { dex, positionManager: PM[dex], tokenId },
      policy: { ...init.policy }, limits: { ...init.limits }, paused: init.startPaused, disarmed: false, lastReason: 0, stateNonce: 1n,
      exitModule: ZERO, quote: quoteOf(pool), lastExecutionAt: 0n,
      members: new Map([[tokenId, { active: true, parent: 0n, successor: 0n, tickLower: nft.tickLower, tickUpper: nft.tickUpper }]]),
      lots: new Map(), idle: new Map(), unaccounted: new Map(),
    });
    ctx.logs.push(eventLog(ABI.factory, FACTORY[dex], 'VaultCreated', { owner: who, vault: address, rootTokenId: tokenId, dex, ownerNonce: nonce }));
    ctx.logs.push(eventLog(ABI.vault, address, 'Initialized', { owner: who, dex, rootTokenId: tokenId, mode: init.policy.mode }));
    ctx.logs.push(eventLog(ABI.vault, address, 'PolicyChanged', { policy: init.policy, stateNonce: 1n }));
    ctx.logs.push(eventLog(ABI.vault, address, 'LimitsChanged', { limits: init.limits, stateNonce: 1n }));
    ctx.logs.push(eventLog(ABI.vault, address, 'RootRearmed', { stateNonce: 1n }));
    return address;
  }

  function positionManager(st, ctx, dex, from, data) {
    const abi = dex === 4 ? ABI.v4 : ABI.v3;
    const { functionName, args = [] } = decode(abi, data, `v${dex}`, ctx);
    ctx.calls.push(`v${dex}.${functionName}`);
    const nft = args.length && typeof args.at(-1) === 'bigint' ? st.nfts.get(nftKey(dex, args.at(-1))) : undefined;
    const minted = nft && !nft.burned;
    switch (functionName) {
      case 'ownerOf': if (!minted) revertString('NOT_MINTED'); return enc(abi, functionName, nft.owner);
      case 'getApproved': if (!minted) revertString('NOT_MINTED'); return enc(abi, functionName, nft.approved);
      case 'isApprovedForAll': return enc(abi, functionName, false);
      case 'subscriber': return enc(abi, functionName, minted ? nft.subscriber : ZERO);
      case 'getPoolAndPositionInfo': {
        if (!minted) return enc(abi, functionName, [{ currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO }, 0n]);
        const { currency0, currency1, fee, tickSpacing, hooks } = nft.pool;
        const info = (BigInt.asUintN(24, BigInt(nft.tickUpper)) << 32n) | (BigInt.asUintN(24, BigInt(nft.tickLower)) << 8n) | (nft.subscriber !== ZERO ? 1n : 0n);
        return enc(abi, functionName, [{ currency0, currency1, fee, tickSpacing, hooks }, info]);
      }
      case 'getPositionLiquidity': return enc(abi, functionName, minted ? nft.liquidity : 0n);
      case 'positions': {
        if (!minted) revertString('Invalid token ID');
        return enc(abi, functionName, [0n, nft.approved, nft.pool.currency0, nft.pool.currency1, nft.pool.fee, nft.tickLower, nft.tickUpper, nft.liquidity, 0n, 0n, nft.owed[0], nft.owed[1]]);
      }
      case 'approve': {
        if (!minted) revertString('NOT_MINTED');
        if (from !== nft.owner) revertString('NOT_AUTHORIZED');
        nft.approved = lower(args[0]);
        return '0x';
      }
      case 'unsubscribe': {
        if (dex !== 4) break;
        if (!minted) revertString('NOT_MINTED');
        if (from !== nft.owner && from !== nft.approved) revertString('NotApproved');
        if (nft.subscriber === ZERO) revertString('NotSubscribed');
        const vault = st.vaults.get(nft.subscriber);
        if (vault && vault.root.tokenId === nft.tokenId && !vault.disarmed) { vault.disarmed = true; vault.lastReason = 1; }
        nft.subscriber = ZERO;
        return '0x';
      }
    }
    throw new Error(`unexpected ${functionName} on the v${dex} position manager`);
  }

  function factory(st, ctx, dex, from, data) {
    const { functionName, args = [] } = decode(ABI.factory, data, `factory${dex}`, ctx);
    ctx.calls.push(`factory${dex}.${functionName}`);
    const seen = ctx.mode === 'view' && lagged ? lagged : st;
    switch (functionName) {
      case 'nextNonce': return enc(ABI.factory, functionName, seen.nonces[dex].get(lower(args[0])) ?? 0n);
      case 'predictVault': return enc(ABI.factory, functionName, predict(dex, args[0], args[1]));
      case 'isVault': return enc(ABI.factory, functionName, seen.made[dex].has(lower(args[0])));
      case 'dex': return enc(ABI.factory, functionName, dex);
      case 'registry': return enc(ABI.factory, functionName, REGISTRY);
      case 'implementation': return enc(ABI.factory, functionName, '0xd0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0');
      case 'createVault': {
        const [init, expected] = args;
        const n = st.nonces[dex].get(from) ?? 0n;
        if (expected !== n) revert('UnexpectedNonce', n, expected);
        const { root } = init;
        if (!init.consentToUncollectedFees) revert('InvalidInit');
        if (root.dex !== dex || lower(root.positionManager) !== PM[dex] || root.tokenId === 0n || root.tokenId > MAX_ROOT) revert('InvalidInit');
        if (!policyValid(init.policy, 1)) revert('InvalidPolicy');
        if (!limitsValid(init.limits)) revert('InvalidLimits');
        const nft = st.nfts.get(nftKey(dex, root.tokenId));
        if (!nft || nft.burned || nft.owner !== from) revert('AutomationUnavailable');
        const vault = predict(dex, from, n);
        if (nft.approved !== vault) revert('AutomationUnavailable');
        if (dex === 4 && nft.pool.hooks !== ZERO) revert('HookedPool', nft.pool.hooks);
        if (dex === 4 && nft.subscriber !== ZERO && nft.subscriber !== vault) revert('ForeignSubscriber', nft.subscriber);
        return enc(ABI.factory, functionName, makeVault(st, ctx, dex, from, init, n));
      }
    }
    throw new Error(`unexpected ${functionName} on factory v${dex}`);
  }

  function vault(st, ctx, v, from, data) {
    const abi = ABI.vault;
    const { functionName, args = [] } = decode(abi, data, 'vault', ctx);
    ctx.calls.push(`vault.${functionName}`);
    const r = (result) => enc(abi, functionName, result);
    const ownerOnly = () => { if (from !== v.owner) revert('Unauthorized'); };
    const bump = () => { v.stateNonce += 1n; return v.stateNonce; };
    switch (functionName) {
      case 'owner': return r(v.owner);
      case 'factory': return r(v.factory);
      case 'registry': return r(REGISTRY);
      case 'pool': return r(v.pool);
      case 'root': return r(v.root);
      case 'positions': return r([...v.members.entries()].filter(([, m]) => m.active).map(([id]) => id));
      case 'policy': return r(v.policy);
      case 'limits': return r(v.limits);
      case 'paused': return r(v.paused);
      case 'rootArmed': return r(armed(st, v));
      case 'stateNonce': return r(v.stateNonce);
      case 'exitModule': return r(v.exitModule);
      case 'quoteCurrency': return r(v.quote);
      case 'lastExecutionAt': return r(v.lastExecutionAt);
      case 'reserves': return r(reservesOf(v, args[0]));
      case 'idleReserves': return r(v.idle.get(lower(args[0])) ?? 0n);
      case 'member': return r(v.members.get(args[0]) ?? { active: false, parent: 0n, successor: 0n, tickLower: 0, tickUpper: 0 });
      case 'lot': return r(lotOf(v, args[0], args[1]));
      case 'pause': {
        if (from !== v.owner && !st.operators.has(from)) revert('Unauthorized');
        v.paused = true;
        ctx.logs.push(eventLog(abi, v.address, 'AutomationPaused', { actor: from, stateNonce: bump() }));
        return '0x';
      }
      case 'resume': {
        ownerOnly();
        v.paused = false;
        ctx.logs.push(eventLog(abi, v.address, 'AutomationResumed', { stateNonce: bump() }));
        return '0x';
      }
      case 'rearm': {
        ownerOnly();
        if (args[0] !== true) revert('InvalidInit');
        const nft = st.nfts.get(nftKey(v.dex, v.root.tokenId));
        if (!nft || nft.burned || nft.owner !== v.owner || nft.approved !== v.address) revert('AutomationUnavailable');
        if (v.dex === 4) {
          if (nft.subscriber !== ZERO && nft.subscriber !== v.address) revert('ForeignSubscriber', nft.subscriber);
          nft.subscriber = v.address;
        }
        v.disarmed = false;
        v.lastReason = 0;
        ctx.logs.push(eventLog(abi, v.address, 'RootRearmed', { stateNonce: bump() }));
        return '0x';
      }
      case 'setPolicy': {
        ownerOnly();
        if (!policyValid(args[0], activeMembers(v))) revert('InvalidPolicy');
        v.policy = { ...args[0] };
        ctx.logs.push(eventLog(abi, v.address, 'PolicyChanged', { policy: v.policy, stateNonce: bump() }));
        return '0x';
      }
      case 'setLimits': {
        ownerOnly();
        if (!limitsValid(args[0])) revert('InvalidLimits');
        v.limits = { ...args[0] };
        ctx.logs.push(eventLog(abi, v.address, 'LimitsChanged', { limits: v.limits, stateNonce: bump() }));
        return '0x';
      }
      case 'withdrawReserves': {
        ownerOnly();
        // 2026-10-04 (#323): withdrawReserves(token, amount, recipient). Changed on purpose 2026-10-04 (rugged97's delta of
        // 4 Oct §2 item 1): as the deployed contract, any recipient but address(0) (InvalidRecipient); a token that refuses
        // the recipient reverts TokenCallFailed(token), and nothing moves.
        const [token, amount, recipient] = [lower(args[0]), args[1], lower(args[2])];
        if (amount === 0n) revert('InvalidAmount');
        if (recipient === ZERO) revert('InvalidRecipient');
        if (amount > reservesOf(v, token)) revert('InsufficientReserves');
        if (st.refused.has(`${token}|${recipient}`)) revert('TokenCallFailed', token);
        let left = amount;
        const idle = v.idle.get(token) ?? 0n;
        const fromIdle = idle < left ? idle : left;
        v.idle.set(token, idle - fromIdle);
        left -= fromIdle;
        for (const [key, lot] of v.lots) {
          if (!key.endsWith(`|${token}`) || left === 0n) continue;
          for (const part of ['uncharged', 'charged']) {
            const take = lot[part] < left ? lot[part] : left;
            lot[part] -= take;
            left -= take;
          }
        }
        st.paid.push({ to: recipient, tokens: [token], amounts: [amount], why: 'withdrawReserves' });
        ctx.logs.push(eventLog(abi, v.address, 'ReservesWithdrawn', { token, amount, stateNonce: bump() }));
        return '0x';
      }
      case 'withdrawChild': {
        ownerOnly();
        const tokenId = args[0];
        const member = v.members.get(tokenId);
        if (tokenId === v.root.tokenId || !member?.active) revert('InvalidPosition');
        retire(st, ctx, v, tokenId);
        return '0x';
      }
      case 'recoverToken': {
        ownerOnly();
        const [token, amount] = [lower(args[0]), args[1]];
        const free = v.unaccounted.get(token) ?? 0n;
        if (amount > free) revert('InsufficientReserves');
        v.unaccounted.set(token, free - amount);
        st.paid.push({ to: v.owner, tokens: [token], amounts: [amount], why: 'recoverToken' });
        ctx.logs.push(eventLog(abi, v.address, 'TokenRecovered', { token, amount }));
        return '0x';
      }
      case 'recoverPosition': {
        ownerOnly();
        const tokenId = args[0];
        const nft = st.nfts.get(nftKey(v.dex, tokenId));
        if (!nft || nft.owner !== v.address || v.members.get(tokenId)?.active) revert('InvalidPosition');
        nft.owner = v.owner;
        nft.approved = ZERO;
        ctx.logs.push(eventLog(abi, v.address, 'PositionRecovered', { tokenId }));
        return '0x';
      }
      case 'exitAll': {
        ownerOnly();
        for (const [tokenId, member] of [...v.members]) if (member.active && tokenId !== v.root.tokenId) retire(st, ctx, v, tokenId);
        for (const token of [v.pool.currency0, v.pool.currency1]) {
          const amount = reservesOf(v, token);
          if (amount === 0n) continue;
          v.idle.set(token, 0n);
          for (const [key, lot] of v.lots) if (key.endsWith(`|${token}`)) { lot.uncharged = 0n; lot.charged = 0n; }
          st.paid.push({ to: v.owner, tokens: [token], amounts: [amount], why: 'exitAll' });
          ctx.logs.push(eventLog(abi, v.address, 'ReservesWithdrawn', { token, amount, stateNonce: v.stateNonce }));
        }
        v.disarmed = true;
        v.lastReason = 7;
        v.paused = true;
        // Changed on purpose 2026-10-04 (#319, rugged97's delta of 4 Oct §2 item 3): the deployed exitAll also turns the exit
        // module off when one is on (its orders pause, not revoked), with the disarm's state nonce, before RootDisarmed.
        const nonce = bump();
        if (v.exitModule !== ZERO) {
          v.exitModule = ZERO;
          ctx.logs.push(eventLog(abi, v.address, 'ExitModuleSet', { module: ZERO, stateNonce: nonce }));
        }
        ctx.logs.push(eventLog(abi, v.address, 'RootDisarmed', { reason: 7, stateNonce: nonce }));
        return '0x';
      }
      case 'returnReserves': {
        // Changed on purpose (data) 2026-10-02 (Domino V2 integration, spec rev4 §5.6, #311): anyone may call it; the
        // contract's order (SuccessorActive, then RootOpen read live), every reserve of both pool tokens to the owner,
        // without any fee, ReservesWithdrawn per token paid, the state nonce moved once when anything was paid.
        if (activeMembers(v) !== 1) revert('SuccessorActive');
        const nft = st.nfts.get(nftKey(v.dex, v.root.tokenId));
        if (nft && !nft.burned && nft.liquidity !== 0n) revert('RootOpen');
        const nonce = v.stateNonce + 1n;
        const paid = [];
        for (const token of [v.pool.currency0, v.pool.currency1]) {
          const amount = reservesOf(v, token);
          paid.push(amount);
          if (amount === 0n) continue;
          v.idle.set(token, 0n);
          for (const [key, lot] of v.lots) if (key.endsWith(`|${token}`)) { lot.uncharged = 0n; lot.charged = 0n; }
          st.paid.push({ to: v.owner, tokens: [token], amounts: [amount], why: 'returnReserves', by: from });
          ctx.logs.push(eventLog(abi, v.address, 'ReservesWithdrawn', { token, amount, stateNonce: nonce }));
        }
        if (paid.some((amount) => amount > 0n)) v.stateNonce = nonce;
        return r(paid);
      }
      case 'setExitModule': {
        ownerOnly();
        const module = lower(args[0]);
        if (module !== ZERO && module !== AUTO_EXIT) revert('Unauthorized');
        v.exitModule = module;
        ctx.logs.push(eventLog(abi, v.address, 'ExitModuleSet', { module, stateNonce: bump() }));
        return '0x';
      }
    }
    throw new Error(`unexpected ${functionName} on a vault`);
  }

  /** A successor leaves the vault: its NFT to the owner, its lots to idle, its parent's slot freed. */
  function retire(st, ctx, v, tokenId) {
    const member = v.members.get(tokenId);
    member.active = false;
    const parent = v.members.get(member.parent);
    if (parent && parent.successor === tokenId) parent.successor = 0n;
    for (const token of [v.pool.currency0, v.pool.currency1]) {
      const key = `${tokenId}|${token}`;
      const lot = v.lots.get(key);
      if (!lot) continue;
      v.idle.set(token, (v.idle.get(token) ?? 0n) + lot.uncharged + lot.charged);
      v.lots.delete(key);
    }
    const nft = st.nfts.get(nftKey(v.dex, tokenId));
    if (nft) { nft.owner = v.owner; nft.approved = ZERO; }
    ctx.logs.push(eventLog(ABI.vault, v.address, 'ChildWithdrawn', { tokenId, stateNonce: (v.stateNonce += 1n) }));
  }

  async function autoExit(st, ctx, from, data) {
    const abi = ABI.autoExit;
    const { functionName, args = [] } = decode(abi, data, 'autoExit', ctx);
    ctx.calls.push(`autoExit.${functionName}`);
    const r = (result) => enc(abi, functionName, result);
    const m = st.module;
    switch (functionName) {
      case 'MAX_SLIPPAGE_BPS': return r(1000);
      case 'MAX_POOL_FEE_PIPS': return r(100_000);
      case 'INSTRUCTION_VERSION': return r(1);
      case 'maxObservationAgeSeconds': return r(300);
      case 'minTwapSeconds': return r(600);
      case 'registry': return r(REGISTRY);
      case 'priceAnchor': return r('0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0');
      case 'mandateStatus': return r(m.status.get(lower(args[0])) ?? 0);
      case 'mandateOf': {
        const record = m.records.get(lower(args[0]));
        return r(record ? { ...record.view, status: m.status.get(lower(args[0])) } : { owner: ZERO, validUntil: 0n, maxSlippageBps: 0, receiveMode: 0, status: 0, vault: ZERO, convertTo: ZERO, triggerBelowSqrtPriceX96: 0n, triggerAboveSqrtPriceX96: 0n, tokenId: 0n });
      }
      case 'nonceUsed': return r(m.used.has(`${lower(args[0])}|${args[1]}`));
      case 'unclaimed': return r(m.unclaimed.get(`${lower(args[0])}|${lower(args[1])}`) ?? 0n);
      case 'registerMandate': {
        const [mandate, signature] = args;
        const id = mandateHash(mandate);
        if ((m.status.get(id) ?? 0) !== 0) revert('MandateAlreadyRegistered');
        const owner = lower(mandate.owner), vaultAddress = lower(mandate.vault), convertTo = lower(mandate.convertTo);
        const below = mandate.triggerBelowSqrtPriceX96, above = mandate.triggerAboveSqrtPriceX96;
        const v = st.vaults.get(vaultAddress);
        if (owner === ZERO || vaultAddress === ZERO || mandate.validUntil < now()) revert('InvalidMandate');
        if (below === 0n && above === 0n) revert('InvalidMandate');
        if (below !== 0n && above !== 0n && below >= above) revert('InvalidMandate');
        if (mandate.maxSlippageBps === 0 || mandate.maxSlippageBps > 1000) revert('InvalidMandate');
        if (mandate.receiveMode === 0 && convertTo !== ZERO) revert('InvalidMandate');
        if (mandate.receiveMode === 1 && (!v || (convertTo !== v.pool.currency0 && convertTo !== v.pool.currency1))) revert('InvalidMandate');
        if (mandate.receiveMode > 1) revert('InvalidMandate');
        if (m.used.has(`${owner}|${mandate.nonce}`)) revert('NonceAlreadyUsed');
        // ECDSA first, only a low s (an EOA, or an EIP-7702 account whose delegate has no isValidSignature).
        let signer = null;
        if (/^0x[0-9a-f]{130}$/.test(lower(signature)) && BigInt(`0x${signature.slice(66, 130)}`) <= HALF_N && [27, 28].includes(Number.parseInt(signature.slice(130), 16))) {
          signer = lower(await recoverTypedDataAddress({ domain: { name: 'Domino', version: '2', chainId, verifyingContract: AUTO_EXIT }, types: MANDATE_TYPES, primaryType: 'ExitMandate', message: mandate, signature }));
        }
        if (signer !== owner) revert('InvalidSignature');
        if (!v || v.owner !== owner) revert('Unauthorized');
        m.used.add(`${owner}|${mandate.nonce}`);
        m.status.set(id, 1);
        m.records.set(id, { signer, signature: lower(signature), view: { owner, validUntil: mandate.validUntil, maxSlippageBps: mandate.maxSlippageBps, receiveMode: mandate.receiveMode, vault: vaultAddress, convertTo, triggerBelowSqrtPriceX96: below, triggerAboveSqrtPriceX96: above, tokenId: mandate.tokenId } });
        ctx.logs.push(eventLog(abi, AUTO_EXIT, 'MandateRegistered', { mandateHash: id, owner, vault: vaultAddress, tokenId: mandate.tokenId, validUntil: mandate.validUntil }));
        return r(id);
      }
      case 'revokeMandate': {
        const id = lower(args[0]);
        if ((m.status.get(id) ?? 0) !== 1) revert('MandateNotActive');
        if (m.records.get(id).view.owner !== from) revert('Unauthorized');
        m.status.set(id, 2);
        ctx.logs.push(eventLog(abi, AUTO_EXIT, 'MandateRevoked', { mandateHash: id }));
        return '0x';
      }
      case 'cancelNonce': {
        if (m.used.has(`${from}|${args[0]}`)) revert('NonceAlreadyUsed');
        m.used.add(`${from}|${args[0]}`);
        ctx.logs.push(eventLog(abi, AUTO_EXIT, 'NonceCancelled', { owner: from, nonce: args[0] }));
        return '0x';
      }
      case 'claim': {
        const [token, recipient] = [lower(args[0]), lower(args[1])];
        if (recipient === ZERO) revert('InvalidRecipient');
        const key = `${from}|${token}`;
        const amount = m.unclaimed.get(key) ?? 0n;
        if (amount === 0n) revert('NothingToClaim');
        m.unclaimed.set(key, 0n);
        st.paid.push({ to: recipient, tokens: [token], amounts: [amount], why: 'claim' });
        ctx.logs.push(eventLog(abi, AUTO_EXIT, 'Claimed', { owner: from, token, recipient, amount }));
        return r(amount);
      }
    }
    throw new Error(`unexpected ${functionName} on the auto-exit module`);
  }

  function registry(st, ctx, data) {
    const { functionName, args = [] } = decode(ABI.registry, data, 'registry', ctx);
    ctx.calls.push(`registry.${functionName}`);
    const r = (result) => enc(ABI.registry, functionName, result);
    switch (functionName) {
      case 'automationHalted': return r(st.halted);
      case 'chargeCurrencyRank': return r(rank(args[0]));
      case 'isOperator': return r(st.operators.has(lower(args[0])));
      case 'feeRecipient': return r('0xfeefeefeefeefeefeefeefeefeefeefeefeefee0');
    }
    throw new Error(`unexpected ${functionName} on the registry`);
  }

  /** One call against `st`: views and writes alike (a write on a copy is a simulation). */
  async function execute(st, ctx, from, to, data) {
    from = lower(from ?? ZERO);
    to = lower(to);
    // A call to an address without code returns nothing, as the EVM does.
    if ((code.get(to) ?? '0x') === '0x' && !st.vaults.has(to)) return '0x';
    if (to === PM[4]) return positionManager(st, ctx, 4, from, data);
    if (to === PM[3]) return positionManager(st, ctx, 3, from, data);
    if (to === FACTORY[4]) return factory(st, ctx, 4, from, data);
    if (to === FACTORY[3]) return factory(st, ctx, 3, from, data);
    if (to === AUTO_EXIT) return autoExit(st, ctx, from, data);
    if (to === REGISTRY) return registry(st, ctx, data);
    if (to === PRICE_ANCHOR) {
      const { functionName } = decode(ABI.priceAnchor, data, 'priceAnchor', ctx);
      if (functionName !== 'twapSqrtPrice') throw new Error(`unexpected priceAnchor.${functionName}`);
      if (twap === null) throw new Revert(toFunctionSelector('TwapUnavailable()'));
      return encodeFunctionResult({ abi: ABI.priceAnchor, functionName, result: twap });
    }
    if (v3Spots.has(to)) {
      const { functionName } = decode(ABI.v3Pool, data, 'v3Pool', ctx);
      if (functionName !== 'slot0') throw new Error(`unexpected v3 pool ${functionName}`);
      ctx.calls.push('v3Pool.slot0');
      return encodeFunctionResult({ abi: ABI.v3Pool, functionName, result: [v3Spots.get(to), 0, 0, 1, 1, 0, true] });
    }
    if (to === STATE_VIEW) {
      const { functionName, args = [] } = decode(ABI.v4StateView, data, 'stateView', ctx);
      if (functionName !== 'getSlot0') throw new Error(`unexpected StateView.${functionName}`);
      ctx.calls.push('stateView.getSlot0');
      return encodeFunctionResult({ abi: ABI.v4StateView, functionName, result: [v4Prices.get(lower(args[0])) ?? DEFAULT_SQRT_PRICE, 0, 0, 3000] });
    }
    const v = st.vaults.get(to);
    if (v) return vault(st, ctx, v, from, data);
    if (to === owner && (data === undefined || data === '0x')) return '0x';
    throw new Error(`unexpected call to ${to}`);
  }

  async function signTypedData(account, params) {
    if (lower(params[0]) !== account) return { error: { code: 4100, message: 'The requested account has not been authorized.' } };
    const wire = JSON.parse(params[1]);
    if (Number(wire.domain.chainId) !== walletChain) return { error: { code: -32603, message: `Provided chainId "${wire.domain.chainId}" must match the active chainId "${walletChain}"` } };
    if (refuseNext) { refuseNext = false; declined.push(wire); return { error: { code: 4001, message: 'User rejected the request.' } }; }
    const { EIP712Domain, ...types } = wire.types;
    void EIP712Domain;
    const signature = await ACCOUNTS.get(account).signTypedData({ domain: wire.domain, types, primaryType: wire.primaryType, message: wire.message });
    signed.push({ account, wire, signature });
    return { result: signature };
  }

  async function answer(method, params, account) {
    log.push(method);
    try {
      switch (method) {
        case 'eth_accounts': return { result: [account] };
        case 'eth_chainId': return { result: numberToHex(walletChain) };
        case 'eth_getCode': {
          const address = lower(params[0]);
          // A vault's code is the factory's clone, there exactly while the factory has made it.
          if (state.vaults.has(address) || state.made[3].has(address) || state.made[4].has(address)) return { result: CLONE_CODE };
          return { result: code.get(address) ?? '0x' };
        }
        case 'eth_getStorageAt': return { result: `0x${'0'.repeat(64)}` };
        case 'eth_gasPrice': return { result: '0x5f5e100' };
        case 'eth_maxPriorityFeePerGas': return { result: '0x1' };
        case 'eth_getBalance': return { result: numberToHex(10n ** 19n) };
        case 'eth_getTransactionCount': return { result: numberToHex(counts.get(lower(params[0])) ?? 0) };
        case 'eth_call': case 'eth_estimateGas': {
          const tx = params[0];
          // Base's GasPriceOracle predeploy (post-B4 review F5): getL1FeeUpperBound(size) answers a fixed ceiling, 7 gwei.
          if (method === 'eth_call' && lower(tx.to) === '0x420000000000000000000000000000000000000f' && String(tx.data).startsWith('0xf1c7a58b')) return { result: `0x${(7_000_000_000n).toString(16).padStart(64, '0')}` };
          const ctx = { mode: tx.from ? 'simulate' : 'view', logs: [], calls: [] };
          // A read with no sender is a view: a lagging node's factories answer from their frozen copy.
          // A read at the 'finalized' tag, while finality lags, sees the state before the first send (finalState).
          const draft = structuredClone(params[1] === 'finalized' && finality === 'lagging' && finalState ? finalState : state);
          try {
            const out = await execute(draft, ctx, tx.from, tx.to, tx.data);
            return { result: method === 'eth_call' ? out : '0x30d40' };
          } finally {
            // Recorded whether it answered or reverted.
            calls.push({ method, block: method === 'eth_call' ? params[1] : 'latest', calls: ctx.calls, from: lower(tx.from ?? ZERO), to: lower(tx.to) });
          }
        }
        case 'eth_sendTransaction': {
          const tx = params[0];
          if (lower(tx.from) !== account) return { error: { code: 4100, message: 'The requested account has not been authorized.' } };
          if (tx.chainId !== undefined && Number(BigInt(tx.chainId)) !== walletChain) return { error: { code: -32603, message: 'chainId does not match the active chain' } };
          if (refuseNext) { refuseNext = false; declined.push(tx); return { error: { code: 4001, message: 'User rejected the request.' } }; }
          const expectedNonce = counts.get(account) ?? 0;
          if (BigInt(tx.nonce) !== BigInt(expectedNonce)) return { error: { code: -32000, message: 'nonce too low' } };
          const index = sends.length;
          const ctx = { mode: 'send', logs: [], calls: [] };
          let status = '0x1';
          // What a 'finalized' read sees while finality lags: the chain as it was before anything was sent.
          finalState ??= structuredClone(state);
          if (revertNext) { revertNext = false; status = '0x0'; } else {
            const draft = structuredClone(state);
            try {
              await execute(draft, ctx, tx.from, tx.to, tx.data);
              state = draft;
            } catch (error) {
              if (!(error instanceof Revert)) throw error;
              status = '0x0';
              ctx.logs.length = 0;
            }
          }
          counts.set(account, expectedNonce + 1);
          sends.push(tx);
          receipts.push({ status, logs: status === '0x1' ? ctx.logs : [], calls: ctx.calls });
          return { result: txHash(index) };
        }
        case 'eth_getTransactionByHash': case 'eth_getTransactionReceipt': {
          const index = sends.findIndex((_, i) => txHash(i) === lower(params[0]));
          if (index === -1) return { result: null };
          const sent = sends[index];
          const where = { blockHash: blockHash(index), blockNumber: numberToHex(BASE_BLOCK + 1 + index) };
          if (method === 'eth_getTransactionByHash') return { result: { hash: txHash(index), from: sent.from, to: sent.to, input: sent.data, value: sent.value, nonce: sent.nonce, ...where } };
          const receipt = receipts[index];
          return { result: { transactionHash: txHash(index), from: sent.from, to: sent.to, status: receipt.status, gasUsed: '0x2ab98', effectiveGasPrice: '0x5f5e100', ...where,
            logs: receipt.logs.map((entry, i) => ({ ...entry, logIndex: numberToHex(i), transactionHash: txHash(index), ...where })) } };
        }
        case 'eth_getBlockByNumber': {
          if (params[0] === 'latest') return { result: latest() };
          if (params[0] === 'finalized') return { result: { number: numberToHex(finality === 'lagging' ? BASE_BLOCK : latestNumber()), hash: blockHash(20_000) } };
          const n = Number(BigInt(params[0])) - BASE_BLOCK - 1;
          return { result: n >= 0 && n < sends.length ? { number: params[0], hash: blockHash(n) } : null };
        }
        case 'eth_signTypedData_v4': return await signTypedData(account, params);
        // The batch path (added on purpose 2026-10-02).
        case 'wallet_getCapabilities': {
          if (atomic === null) break;
          if (lower(params[0]) !== account) return { error: { code: 4100, message: 'The requested account has not been authorized.' } };
          return { result: { [numberToHex(walletChain)]: { atomic: { status: atomic } } } };
        }
        case 'eth_simulateV1': {
          if (!simulateV1) break;
          const simulated = params[0]?.blockStateCalls?.[0]?.calls ?? [];
          const draft = structuredClone(state);
          let failed = false;
          const results = [];
          for (const call of simulated) {
            if (failed) { results.push({ status: '0x0', gasUsed: '0x0', returnData: '0x' }); continue; }
            const ctx = { mode: 'simulate', logs: [], calls: [] };
            try {
              const out = await execute(draft, ctx, call.from, call.to, call.data);
              results.push({ status: '0x1', gasUsed: '0x30d40', returnData: out });
            } catch (error) {
              if (!(error instanceof Revert)) throw error;
              failed = true;
              results.push({ status: '0x0', gasUsed: '0x0', returnData: '0x', error: { code: 3, message: 'execution reverted', data: error.data } });
            } finally {
              calls.push({ method, block: 'latest', calls: ctx.calls, from: lower(call.from ?? ZERO), to: lower(call.to) });
            }
          }
          return { result: [{ calls: results }] };
        }
        case 'wallet_sendCalls': {
          if (atomic === null) break;
          const batch = params[0];
          if (lower(batch.from) !== account) return { error: { code: 4100, message: 'The requested account has not been authorized.' } };
          if (BigInt(batch.chainId) !== BigInt(walletChain)) return { error: { code: 5710, message: 'Unsupported chain id' } };
          if (batch.version !== '2.0.0' || batch.atomicRequired !== true) return { error: { code: -32602, message: 'Invalid batch' } };
          if (refuseBatch !== null) { const code = refuseBatch; refuseBatch = null; declined.push(batch); return { error: { code, message: code === 4001 ? 'User rejected the request.' : 'Batch refused.' } }; }
          const expectedNonce = counts.get(account) ?? 0;
          const index = sends.length;
          const ctx = { mode: 'send', logs: [], calls: [] };
          let status = '0x1';
          finalState ??= structuredClone(state);
          const draft = structuredClone(state);
          try {
            for (const call of batch.calls) await execute(draft, ctx, account, call.to, call.data);
            state = draft;
          } catch (error) {
            if (!(error instanceof Revert)) throw error;
            status = '0x0';
            ctx.logs.length = 0;
          }
          counts.set(account, expectedNonce + 1);
          // A 7702 account's own batch: one transaction of the owner's, to itself.
          sends.push({ from: account, to: account, data: '0x', value: '0x0', nonce: numberToHex(expectedNonce), chainId: batch.chainId, type: '0x2', batch: true });
          receipts.push({ status, logs: status === '0x1' ? ctx.logs : [], calls: ctx.calls });
          const id = `0x${'ba'.repeat(31)}${index.toString(16).padStart(2, '0')}`;
          batches.push({ id, chainId: batch.chainId, calls: batch.calls, index, status });
          return { result: { id } };
        }
        case 'wallet_getCallsStatus': {
          if (atomic === null) break;
          const found = batches.find((entry) => entry.id === params[0]);
          if (!found) return { error: { code: 5730, message: 'Unknown bundle id' } };
          if (holdBatch) return { result: { version: '2.0.0', id: found.id, chainId: found.chainId, status: 100, atomic: true } };
          return { result: { version: '2.0.0', id: found.id, chainId: found.chainId, status: found.status === '0x1' ? 200 : 500, atomic: true, receipts: [{ status: found.status, transactionHash: txHash(found.index), blockHash: blockHash(found.index), blockNumber: numberToHex(BASE_BLOCK + 1 + found.index), gasUsed: '0x2ab98', logs: [] }] } };
        }
        case 'eth_getLogs': {
          const filter = params[0] ?? {};
          const from = filter.fromBlock && filter.fromBlock !== 'latest' ? Number(BigInt(filter.fromBlock)) : 0;
          const out = [];
          receipts.forEach(({ status, logs }, index) => {
            if (status !== '0x1' || BASE_BLOCK + 1 + index < from) return;
            logs.forEach((entry, i) => {
              if (filter.address && lower(filter.address) !== lower(entry.address)) return;
              if ((filter.topics ?? []).some((topic, t) => topic !== null && lower(topic) !== lower(entry.topics[t] ?? ''))) return;
              out.push({ address: entry.address, topics: entry.topics, data: entry.data, logIndex: numberToHex(i), transactionHash: txHash(index), blockHash: blockHash(index), blockNumber: numberToHex(BASE_BLOCK + 1 + index), removed: false });
            });
          });
          return { result: out };
        }
      }
    } catch (error) {
      if (error instanceof Revert) return { error: { code: 3, message: 'execution reverted', data: error.data } };
      return { error: { code: -32000, message: String(error?.stack ?? error) } };
    }
    return { error: { code: 4200, message: `${method} is not supported` } };
  }

  async function request(method, params = [], account = owner) {
    const fails = failing.get(method) ?? 0;
    if (fails > 0) {
      failing.set(method, fails - 1);
      log.push(method);
      return { error: { code: -32603, message: 'Internal JSON-RPC error.' } };
    }
    return answer(method, params, lower(account));
  }

  /** Runs a write directly on the chain's state, as another tab or another app would (no wallet involved). */
  async function direct(from, to, data) {
    const ctx = { mode: 'send', logs: [], calls: [] };
    const draft = structuredClone(state);
    await execute(draft, ctx, from, to, data);
    state = draft;
    return ctx.logs;
  }

  const chainObject = {
    chainId, owner, profile, request, log, calls, sends, receipts, declined, signed, strange,
    contracts: vaultContracts(chainId),
    positionManager: PM,
    factory: FACTORY,
    get paid() { return state.paid; },
    /** The block the next read sees. */
    latest,
    nft: (dex, tokenId) => state.nfts.get(nftKey(dex, tokenId)),
    vault: (address) => state.vaults.get(lower(address)),
    module: () => state.module,
    predict: (dex, who, nonce) => predict(dex, who, nonce),
    nextNonce: (dex, who = owner) => state.nonces[dex].get(lower(who)) ?? 0n,
    decline() { refuseNext = true; },
    revert() { revertNext = true; },
    failNext(method, times = 1) { failing.set(method, (failing.get(method) ?? 0) + times); },
    switchChain(id) { walletChain = id; },
    /** The chain the wallet is on now, as its connector reports it (V2Wallet.chainId). */
    chainNow: () => walletChain,
    setCode(address, bytes) { code.set(lower(address), bytes); },
    /** Added on purpose (data) 2026-10-02 (rev2 §5.2): the anchor's TWAP answer (null: TwapUnavailable), and a v3 pool's spot. */
    setTwap(sqrtPriceX96) { twap = sqrtPriceX96; },
    setV3Spot(pool, sqrtPriceX96) {
      const at = v3PoolOf({ currency0: lower(pool.currency0), currency1: lower(pool.currency1), fee: pool.fee });
      v3Spots.set(at, sqrtPriceX96);
      code.set(at, UNISWAP_CODE.v3Pool);
      return at;
    },
    /** Added 2026-10-06 (Auto-exit's edges): a pool's price now, v4 by its key's id (StateView.getSlot0), v3 by its spot. */
    setPrice(dex, pool, sqrtPriceX96) {
      if (dex === 3) return chainObject.setV3Spot(pool, sqrtPriceX96);
      const id = v4PoolId(pool);
      v4Prices.set(id, sqrtPriceX96);
      return id;
    },
    halt(on = true) { state.halted = on; },
    /** Moves the chain's clock forward (the latest block's timestamp). */
    advance(seconds) { clock += seconds; },
    /** A lagging node: the factories' views answer from a frozen copy until `unlag()`. */
    lag() { lagged = structuredClone({ nonces: state.nonces, made: state.made }); },
    unlag() { lagged = null; },
    /** Another tab created a vault from the same wallet: the factory's nonce for the owner moved on. */
    moveNonce(dex = 4, who = owner) {
      const n = state.nonces[dex].get(lower(who)) ?? 0n;
      const address = predict(dex, who, n);
      state.nonces[dex].set(lower(who), n + 1n);
      state.made[dex].add(address);
      return address;
    },
    /** The NFT moves to another wallet: its approval cleared, and on v4 unsubscribed (the vault disarms, reason 1). */
    transfer(dex, tokenId, to) {
      const nft = state.nfts.get(nftKey(dex, tokenId));
      nft.owner = lower(to);
      nft.approved = ZERO;
      if (dex === 4 && nft.subscriber !== ZERO) {
        const v = state.vaults.get(nft.subscriber);
        if (v && !v.disarmed) { v.disarmed = true; v.lastReason = 1; }
        nft.subscriber = ZERO;
      }
    },
    /** The holder approves another app: the individual approval moves (v4 does not notify; custody is lost, reason 4). */
    approveOther(dex, tokenId, spender) { state.nfts.get(nftKey(dex, tokenId)).approved = lower(spender); },
    /** Another app becomes the v4 position's subscriber. */
    subscribeOther(tokenId, subscriber) { state.nfts.get(nftKey(4, tokenId)).subscriber = lower(subscriber); },
    /** A v3 checkpoint mismatch (reason 5): the vault disarms while custody stays. */
    disarm(address, reason = 5) { Object.assign(state.vaults.get(lower(address)), { disarmed: true, lastReason: reason }); },
    /**
     * Added on purpose (data) 2026-10-02 (Domino V2 rev3 §2.13, the V1 incident): a root closed outside its vault, as the
     * S1 exit does with a full withdrawal (v4: the zap approved, the liquidity removed, the NFT burned; the vault
     * notified, reason 3), or directly on Uniswap (the liquidity removed, the NFT kept; v4 notifies a change, reason 2;
     * v3's checkpoint no longer matches, reason 5). The vault's reserves stay where they are either way.
     */
    closeRoot(dex, tokenId, { burn = false, by = null } = {}) {
      const nft = state.nfts.get(nftKey(dex, tokenId));
      nft.liquidity = 0n;
      if (by) nft.approved = lower(by);
      const vault = [...state.vaults.values()].find((v) => v.dex === dex && v.root.tokenId === BigInt(tokenId));
      if (burn) {
        nft.burned = true;
        nft.approved = ZERO;
        nft.subscriber = ZERO;
      }
      if (vault && !vault.disarmed) Object.assign(vault, { disarmed: true, lastReason: burn ? 3 : dex === 4 ? 2 : 5 });
    },
    /**
     * A vault created as the factory does it (approval, then createVault from the owner), without the wallet; returns its
     * address. For the panel's and auto-exit's tests, which start from an existing vault.
     */
    async seedVault({ dex = 4, tokenId, who = owner, policy = { mode: 1, triggerDistanceBps: 500, maxOverlapBps: 500, minimumIntervalSeconds: 3600, maxPositions: 1 }, limits = { maxSlippageBps: 100, maxPriceImpactBps: 200, maxObservationAgeSeconds: 600, upsideBps: 1000 }, startPaused = false } = {}) {
      const n = state.nonces[dex].get(lower(who)) ?? 0n;
      const address = predict(dex, who, n);
      const abi = dex === 4 ? ABI.v4 : ABI.v3;
      await direct(who, PM[dex], encodeFunctionData({ abi, functionName: 'approve', args: [address, BigInt(tokenId)] }));
      await direct(who, FACTORY[dex], encodeFunctionData({ abi: ABI.factory, functionName: 'createVault', args: [{ root: { dex, positionManager: PM[dex], tokenId: BigInt(tokenId) }, policy, limits, startPaused, consentToUncollectedFees: true }, n] }));
      return address;
    },
    /** A successor minted by the vault (Domino-compound): held by the vault, an active member under `parent`. */
    addSuccessor(address, { tokenId, parent, tickLower = 600, tickUpper = 1200, lots = [] }) {
      const v = state.vaults.get(lower(address));
      const root = state.nfts.get(nftKey(v.dex, v.root.tokenId));
      state.nfts.set(nftKey(v.dex, tokenId), { ...structuredClone(root), tokenId: BigInt(tokenId), owner: v.address, approved: ZERO, subscriber: ZERO, tickLower, tickUpper, owed: [0n, 0n] });
      v.members.set(BigInt(tokenId), { active: true, parent: BigInt(parent), successor: 0n, tickLower, tickUpper });
      const p = v.members.get(BigInt(parent));
      if (p) p.successor = BigInt(tokenId);
      for (const lot of lots) v.lots.set(`${BigInt(tokenId)}|${lower(lot.token)}`, { uncharged: lot.uncharged ?? 0n, charged: lot.charged ?? 0n });
    },
    setLot(address, tokenId, token, lot) { state.vaults.get(lower(address)).lots.set(`${BigInt(tokenId)}|${lower(token)}`, { uncharged: lot.uncharged ?? 0n, charged: lot.charged ?? 0n }); },
    setIdle(address, token, amount) { state.vaults.get(lower(address)).idle.set(lower(token), amount); },
    setUnaccounted(address, token, amount) { state.vaults.get(lower(address)).unaccounted.set(lower(token), amount); },
    /** An NFT of the vault's manager the vault holds without managing it (sent to it by mistake). */
    giveToVault(address, dex, tokenId) {
      const v = state.vaults.get(lower(address));
      const root = state.nfts.get(nftKey(v.dex, v.root.tokenId));
      state.nfts.set(nftKey(dex, tokenId), { ...structuredClone(root), dex, tokenId: BigInt(tokenId), owner: v.address, approved: ZERO, subscriber: ZERO });
    },
    setExitModule(address, module) { state.vaults.get(lower(address)).exitModule = lower(module); },
    /** The token refuses every transfer to `to` (a blocklist): the vault's payment there reverts TokenCallFailed. */
    refuseTransfers(token, to) { state.refused.add(`${lower(token)}|${lower(to)}`); },
    setVaultOwner(address, who) { state.vaults.get(lower(address)).owner = lower(who); },
    setUnclaimed(who, token, amount) { state.module.unclaimed.set(`${lower(who)}|${lower(token)}`, amount); },
    useNonce(who, nonce) { state.module.used.add(`${lower(who)}|${BigInt(nonce)}`); },
    /** The operator executed the order (status 3). */
    executeMandate(id) { state.module.status.set(lower(id), 3); },
    /** Every eth_call's block tag and the functions it reached, since `from` (an index into `calls`). */
    callsSince: (from = 0) => calls.slice(from),
    // The batch path (added on purpose 2026-10-02).
    batches,
    /** The next wallet_sendCalls is refused with `code` (4001 the person, 5750 an upgrade declined, 5700 unsupported). */
    declineBatch(code = 4001) { refuseBatch = code; },
    /** wallet_getCallsStatus answers 100 (pending) until `releaseBatches()`. */
    holdBatches() { holdBatch = true; },
    releaseBatches() { holdBatch = false; },
  };
  return chainObject;
}

const signatureKey = (entry) => `${entry.chainId}|${lower(entry.owner)}|${entry.space}|${lower(entry.verifier)}|${entry.nonce}`;

/**
 * The chain above as the V2Wallet a client takes, for `account` (the chain's owner by default): errors thrown as a
 * provider throws them, an in-memory journal of offered nonces per chain and owner, and one of held signature nonces.
 * Pass the same journals to two wallets to model two tabs of one page.
 */
export function walletOf(chain, { account = chain.owner, current = () => true, nonces = new Map(), signatures = new Map() } = {}) {
  const who = lower(account);
  const claims = [], journal = [];
  return {
    owner: who,
    current,
    chainId: () => chain.chainNow(),
    claims,
    journal,
    nonces,
    held: signatures,
    request: async (method, params) => {
      const reply = await chain.request(method, params, who);
      if (reply.error) throw Object.assign(new Error(reply.error.message), reply.error);
      return reply.result;
    },
    nonceOffered: (chainId, nonce) => nonces.has(`${chainId}|${who}|${nonce}`),
    async claimNonce(chainId, nonce) {
      const key = `${chainId}|${who}|${nonce}`;
      if (nonces.has(key)) throw new Error('wallet_nonce_already_offered');
      const token = `claim-${chainId}-${nonce}`;
      nonces.set(key, token);
      claims.push(['claim', chainId, nonce]);
      return token;
    },
    async releaseRejectedNonce(chainId, nonce, token) {
      const key = `${chainId}|${who}|${nonce}`;
      if (nonces.get(key) === token) nonces.delete(key);
      claims.push(['release', chainId, nonce]);
    },
    signatures: {
      held: (entry) => signatures.has(signatureKey(entry)),
      async record(entry) {
        const key = signatureKey(entry);
        if (signatures.has(key)) throw new Error('signature_nonce_already_held');
        signatures.set(key, Object.freeze({ ...entry }));
        // When it was recorded, against the chain's request log: the order of record and prompt is checked.
        journal.push(['record', entry.nonce, chain.log.length]);
      },
      async forget(entry) {
        signatures.delete(signatureKey(entry));
        journal.push(['forget', entry.nonce, chain.log.length]);
      },
      list: (chainId, owner) => [...signatures.values()].filter((entry) => entry.chainId === chainId && lower(entry.owner) === lower(owner)),
    },
  };
}
