/**
 * TEST-ONLY. A browser wallet on a Domino V2 chain (Robinhood 4663, Base 8453 or Arbitrum One 42161) that is also the
 * chain behind it, for the S1 money client (src/finance/v2/zap.ts), in the shape of ./position-chain.mjs. Nothing here
 * reaches a network: every answer is this file's.
 *
 * The wallet: one owner (a public Anvil dev account, whose public test key signs typed data here and nowhere else),
 * on one chain at a time (`eth_chainId` answers the chain it is on; `switchTo` and `wallet_switchEthereumChain` move
 * it). The world below is the HOME chain's: on any other chain every read and send is refused and recorded in
 * `offChain`, so a client that reads or sends on the wrong chain is caught.
 *
 * The chain: ERC-20 balances and exact allowances (a `zeroFirst` token reverts a non-zero to non-zero approve, as
 * USDT does); Uniswap's v4 PositionManager and v3 NonfungiblePositionManager at the chain profile's addresses with
 * their NFTs (owner, individual approval, pool, range, liquidity, principal and uncollected fees); Permit2 (unordered
 * nonce bitmap, invalidateUnorderedNonces, the batch witness transfer the zap asks for); the registry (charge-currency
 * ranks from the chain profile, Universal Router 2.1.2 at version 212); and the zaps at the invented fixture
 * addresses (tests/v2/support/plans.mjs FAKE), with runtime code whose keccak256 is the exported contracts set's
 * `codeHashes` (`fixture: true`).
 *
 * The zap enforces what the contract enforces and the client relies on, in the contract's order, reverting with the
 * contract's own selectors (spec F7 §2.12): the action, the deadline, a recipient that is neither zero nor the zap,
 * the pool's DEX and hooks, the routesHash recomputed from the legs, the owner of an existing position (sender, or the
 * Permit2 signer), msg.value equal to the native inputs, ERC-20 pulled exactly from msg.sender's allowance to the
 * zap, the Permit2 witness signature recovered to the recipient (Permit2's domain, spender = the zap), the NFT
 * approved to the zap (v4 increase, change range and exit on both), the removal minimums, the fee terms by the rank
 * rule, each leg's minimum, the minimum liquidity. Its economics are deliberately simple: a leg delivers its minimum
 * plus 1% (what tests/v2/support/plans.mjs quotes), a position takes 99% of what the zap holds of its currencies up to
 * the caps, and mints its minimum liquidity plus 1%. `movePrice()` makes the next additions mint one unit under the
 * minimum (InsufficientLiquidity(uint128,uint128)); `moveLegs()` makes legs deliver one unit under their minimum.
 *
 * Receipts carry the zap's events, ENCODED with viem from the exported ABIs (SwapLegExecuted declared by hand, D7):
 * InputPulled, SwapLegExecuted, FeeCharged, PositionLiquidityChanged, Refunded, PositionActionExecuted, each with the
 * intentHash this file computes on its own (EIP-712 PositionIntent in the zap's domain), so a receipt decoder can be
 * tested against it.
 *
 * `decline()` refuses the next send with 4001, `declineSignature()` the next signature, `revert()` includes the next
 * send with status 0, `failNext(method)` fails the next ask of a method as a wallet's node does now and then.
 */
import { createRequire } from 'node:module';
import {
  concatHex, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, hashDomain, hashTypedData, keccak256, numberToHex,
  parseAbi, parseAbiItem, recoverTypedDataAddress, toFunctionSelector, zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { FAKE } from '../v2/support/plans.mjs';

const require = createRequire(import.meta.url);
const abiOf = (name) => require(`../../../api-contracts/v2/abi/${name}.json`).abi;
const EIP712 = require('../../../api-contracts/v2/eip712.json');
const PROFILES = {
  4663: require('../../../api-contracts/v2/chains/robinhood-4663.json'),
  8453: require('../../../api-contracts/v2/chains/base-8453.json'),
  42161: require('../../../api-contracts/v2/chains/arbitrum-42161.json'),
};

/** Anvil's public dev account #1 (0x7099…79c8), the owner the V2 test plans name. Its key is public; it signs nothing real. */
export const OWNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
/** Anvil's public dev account #2, another account. */
export const OTHER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';

const lower = (value) => String(value).toLowerCase();
const ZAP_ABI = [...abiOf('IDominoPositionActions'), ...abiOf('IDominoZap')];
const FEE_EVENTS = abiOf('IDominoFeeEvents');
const REGISTRY_ABI = abiOf('IDominoRegistry');
const PERMIT2_ABI = [...abiOf('IPermit2Signature'), ...parseAbi(['function invalidateUnorderedNonces(uint256 wordPos, uint256 mask)'])];
const V4_PM_ABI = [...abiOf('IV4PositionManagerMinimal'), ...parseAbi(['function approve(address spender, uint256 tokenId)'])];
const V3_NPM_ABI = [...abiOf('IUniswapV3PositionManagerMinimal'), ...parseAbi(['function approve(address spender, uint256 tokenId)'])];
const V3_FACTORY_ABI = abiOf('IUniswapV3FactoryMinimal');
// Added 2026-10-02 (rev2 §2.6.5, §6.2): pools the app reads through the wallet (StateView on v4, the factory and the pool on v3).
const STATE_VIEW_ABI = abiOf('IV4StateViewMinimal');
/** Multicall3's aggregate3 (added 2026-10-05, finance/v2/zap.ts readPools). */
const MULTICALL3_ABI = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result3 { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result3[] returnData)',
]);
const V3_POOL_ABI = abiOf('IUniswapV3PoolMinimal');
const POOL_KEY_TYPE = [{ type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] }];
/** A v4 pool's id, keccak256(abi.encode(PoolKey)), as StateView takes it. */
export const poolIdOf = (pool) => keccak256(encodeAbiParameters(POOL_KEY_TYPE, [{ currency0: pool.currency0, currency1: pool.currency1, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks ?? zeroAddress }]));
/** A v3 pool's address on this fake (not Uniswap's CREATE2: the fake factory answers it). */
export const v3PoolOf = (pool) => `0x${keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }], [pool.currency0, pool.currency1, pool.fee])).slice(-40)}`;
const VAULT_FACTORY_ABI = abiOf('IDominoVaultFactory');
// Added 2026-10-02 (Domino V2 rev2 review, L2): a vault answers its root() and rootArmed().
const VAULT_ABI = abiOf('IDominoVault');
const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  // Added 2026-10-02 (rev2 §2.6.5): a token's own decimals and symbol, as the pool choice reads them through the wallet.
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);
/** Emitted by the zap (F1b) but not in the exported ABIs (spec D7): declared by hand, as the spec's §2.11 writes it. */
export const SWAP_LEG_EXECUTED = parseAbiItem('event SwapLegExecuted(uint8 indexed kind, address indexed tokenIn, address indexed tokenOut, address venue, uint256 amountIn, uint256 amountOut)');
const EVENTS = [...ZAP_ABI, ...FEE_EVENTS, SWAP_LEG_EXECUTED].filter((item) => item.type === 'event');

const MAX_UINT256 = (1n << 256n) - 1n;
const LEGS = [{ type: 'tuple[]', components: [
  { name: 'kind', type: 'uint8' }, { name: 'router', type: 'address' }, { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
  { name: 'amountIn', type: 'uint128' }, { name: 'minAmountOut', type: 'uint128' }, { name: 'data', type: 'bytes' },
] }];
const POOL_KEY = [{ type: 'tuple', components: [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
] }];

/** Revert data as the contracts write it: the selector of the signature, then the ABI-encoded arguments. */
export const revertData = (signature, types = [], values = []) =>
  (types.length ? concatHex([toFunctionSelector(signature), encodeAbiParameters(types.map((type) => ({ type })), values)]) : toFunctionSelector(signature));
const errorString = (text) => revertData('Error(string)', ['string'], [text]);
export const REVERTS = {
  invalidPlan: () => revertData('InvalidPlan()'),
  planExpired: () => revertData('PlanExpired()'),
  unauthorized: () => revertData('Unauthorized()'),
  feeMismatch: () => revertData('FeeMismatch()'),
  swapEffectMismatch: () => revertData('SwapEffectMismatch()'),
  exitBelowMinimum: () => revertData('InsufficientLiquidity()'),
  insufficientLiquidity: (liquidity, minimum) => revertData('InsufficientLiquidity(uint128,uint128)', ['uint128', 'uint128'], [liquidity, minimum]),
  partialBurn: (tokenId, liquidity, removed) => revertData('PartialBurn(uint256,uint128,uint128)', ['uint256', 'uint128', 'uint128'], [tokenId, liquidity, removed]),
  positionPoolMismatch: (tokenId) => revertData('PositionPoolMismatch(uint256)', ['uint256'], [tokenId]),
  tokenCallFailed: (token) => revertData('TokenCallFailed(address)', ['address'], [token]),
  feeNotBacked: (token) => revertData('FeeNotBacked(address)', ['address'], [token]),
  transferFailed: (token) => revertData('TransferFailed(address)', ['address'], [token]),
  v4NotApproved: (caller) => revertData('NotApproved(address)', ['address'], [caller]),
  v4MinimumAmount: (minimum, amount) => revertData('MinimumAmountInsufficient(uint128,uint128)', ['uint128', 'uint128'], [minimum, amount]),
  v3NotApproved: () => errorString('Not approved'),
  v3PriceSlippage: () => errorString('Price slippage check'),
  invalidSigner: () => revertData('InvalidSigner()'),
  invalidContractSignature: () => revertData('InvalidContractSignature()'),
  invalidSignatureLength: () => revertData('InvalidSignatureLength()'),
  invalidNonce: () => revertData('InvalidNonce()'),
  signatureExpired: (deadline) => revertData('SignatureExpired(uint256)', ['uint256'], [deadline]),
  transferFromFailed: () => errorString('TRANSFER_FROM_FAILED'),
  notMinted: () => errorString('NOT_MINTED'),
};
class Revert extends Error {
  constructor(data) { super('execution reverted'); this.data = data; }
}

/** The runtime code each invented component answers with; its keccak256 is the contracts set's code hash. */
const COMPONENT_CODE = { registry: '0x600160d0d0', autoExit: '0x600260d0d0', zapV3: '0x600360d0d0', zapV4: '0x600460d0d0', vaultFactoryV3: '0x600560d0d0', vaultFactoryV4: '0x600660d0d0' };
/** The TEST-ONLY contracts set for this fake on `chainId`: the invented addresses, hashes of the code above, `fixture: true`. */
export const contractsFor = (chainId) => ({
  chainId,
  addresses: { ...FAKE },
  codeHashes: Object.fromEntries(Object.entries(COMPONENT_CODE).map(([name, code]) => [name, keccak256(code)])),
  fixture: true,
});
/** A delegate's code for an EIP-7702 owner: unknown to the app's table of known delegates. */
const DELEGATE = '0x0000000000000000000000000000000000007702';

/** The profile's addresses this fake answers at, lowercase. */
function profileOf(chainId) {
  const raw = PROFILES[chainId];
  if (!raw) throw new Error(`no profile for ${chainId}`);
  const tiers = { ...raw.uniswap.v3.tickSpacingByFee, ...(chainId === 8453 ? { 200: 4, 300: 6, 400: 8 } : {}) };
  return {
    chainId,
    v4PositionManager: lower(raw.uniswap.v4.positionManager),
    v4PoolManager: lower(raw.uniswap.v4.poolManager),
    v3PositionManager: lower(raw.uniswap.v3.positionManager),
    v3Factory: lower(raw.uniswap.v3.factory),
    v4StateView: lower(raw.uniswap.v4.stateView),
    multicall3: lower(raw.multicall3),
    universalRouter: lower(raw.uniswap.universalRouter.address),
    permit2: lower(raw.permit2),
    weth: lower(raw.wrappedNative.address),
    ranks: new Map(raw.chargeCurrencies.map((c) => [lower(c.address), c.rank])),
    tiers: new Map(Object.entries(tiers).map(([fee, spacing]) => [Number(fee), spacing])),
  };
}

/** Where a token sits in the route, and the best-ranked charge currency (F1b DominoFeeRules, rank first): written again here, apart from the app's replica. */
function feeTokenOf(legs, rankOf) {
  let best = Infinity;
  let token = null;
  for (const wanted of ['input', 'output', 'hop']) {
    for (let i = 0; i < legs.length; i++) {
      const spent = lower(legs[i].tokenIn);
      const spentPlace = legs.slice(0, i).some((leg) => lower(leg.tokenOut) === spent) ? 'hop' : 'input';
      if (spentPlace === wanted && rankOf(spent) !== 0 && rankOf(spent) < best) [best, token] = [rankOf(spent), spent];
      const delivered = lower(legs[i].tokenOut);
      const deliveredPlace = legs.slice(i + 1).some((leg) => lower(leg.tokenIn) === delivered) ? 'hop' : 'output';
      if (deliveredPlace === wanted && rankOf(delivered) !== 0 && rankOf(delivered) < best) [best, token] = [rankOf(delivered), delivered];
    }
  }
  return token ?? lower(legs[0].tokenIn);
}

const PERMIT2_TYPES = { ...EIP712.permit2.types, PositionIntent: EIP712.types.PositionIntent, PoolRef: EIP712.types.PoolRef };
const INTENT_TYPES = { PositionIntent: EIP712.types.PositionIntent, PoolRef: EIP712.types.PoolRef };

/**
 * `owner`: the wallet's account (default Anvil #1). `chainId`: the home chain. `eth`: the owner's ETH.
 * `balances`: { token: amount } the owner holds. `allowances`: [{ token, spender, amount }] the owner has given.
 * `zeroFirst`: tokens that refuse a non-zero to non-zero approve. `positions`: [{ dex, tokenId, pool, tickLower,
 * tickUpper, liquidity, principal: [a0, a1], fees: [f0, f1], owner?, approved? }]. `ownerCode`: the owner's code
 * ('delegated' for an EIP-7702 designator, or any hex); `refusesEth`: that code reverts a plain ETH payment.
 *
 * Added on purpose 2026-10-02 (Domino V2 S1, PHASE B2: the zap's EIP-5792 batch path), all off by default so every
 * earlier test sees the same wallet: `atomic` ('supported' | 'ready') makes the wallet answer wallet_getCapabilities for
 * its home chain with that `atomic.status` (any chain it is on; null answers 4200 as before); `simulateV1` makes it carry
 * eth_simulateV1 (each call from the owner, state carried, a failing call and every later one status 0x0); with
 * `atomic`, wallet_sendCalls runs the calls atomically as ONE transaction of the owner's (a 7702 account's own batch: one
 * nonce, all the calls' logs, a revert of any call reverts them all) and wallet_getCallsStatus answers 100 while
 * `holdBatches()` holds, then 200 (500 for a reverted batch) with its receipt. eth_getLogs answers the sends' logs by
 * address and topics (a prefix match), for a client that looks a batch's transaction up by its intentHash.
 * `vaults` (added for the S1 review, F7): the addresses the two Domino vault factories call vaults (isVault).
 * `disarmed` (added 2026-10-02, Domino V2 rev2 review L2): vaults whose root reads disarmed. A vault's root (root()) is
 * the first position its address held the individual approval of, or the v4 subscription of, when the chain was made;
 * a position's `subscriber` (v4) is any address (none by default).
 */
export function createV2Chain({
  chainId = 4663, key = OWNER_KEY, eth = 10n ** 19n, balances = {}, allowances = [], zeroFirst = [], positions = [],
  ownerCode = null, refusesEth = false, timestamp = 1_790_870_000, hookedPoolsAllowed = false, finality = 'final',
  atomic = null, simulateV1 = false, vaults = [], pools = [], disarmed = [],
} = {}) {
  const account = privateKeyToAccount(key);
  const owner = lower(account.address);
  const home = chainId;
  const profile = profileOf(home);
  const contracts = contractsFor(home);
  const ZAP_V3 = lower(FAKE.zapV3);
  const ZAP_V4 = lower(FAKE.zapV4);
  const REGISTRY = lower(FAKE.registry);
  const zeroFirstSet = new Set(zeroFirst.map(lower));
  const rankOverrides = new Map();
  const versions = new Map([[profile.universalRouter, 212]]);

  const code = new Map([
    ...Object.entries(COMPONENT_CODE).map(([name, bytes]) => [lower(FAKE[name]), bytes]),
    [profile.v4PositionManager, '0x6004'], [profile.v4PoolManager, '0x6044'], [profile.v4StateView, '0x6045'], [profile.v3PositionManager, '0x6003'], [profile.v3Factory, '0x6033'],
    [profile.universalRouter, '0x6001'], [profile.permit2, '0x6002'], [profile.weth, '0x60ff'], [DELEGATE, '0x6077'],
  ]);
  if (ownerCode === 'delegated') code.set(owner, `0xef0100${DELEGATE.slice(2)}`);
  else if (ownerCode !== null) code.set(owner, ownerCode);

  const tokenEntry = () => ({ balances: new Map(), allowances: new Map() });
  let world = {
    eth: new Map([[owner, eth]]),
    tokens: new Map(),
    nfts: { 3: new Map(), 4: new Map() },
    next: { 3: 900_001n, 4: 5_000_001n },
    permit2Bits: new Map(),
    zapBits: new Map(),
    fees: new Map(),
    // Added 2026-10-02 (rev2 §2.6.5): pool prices, by pool key; a pool not here has none (v3: the factory does not know it).
    pools: new Map(),
  };
  const poolKey = (pool) => `${pool.dex}|${lower(pool.currency0)}|${lower(pool.currency1)}|${pool.fee}|${pool.tickSpacing}`;
  for (const p of pools) world.pools.set(poolKey(p.pool), { pool: p.pool, sqrtPriceX96: BigInt(p.sqrtPriceX96), tick: p.tick, liquidity: BigInt(p.liquidity ?? 0n) });
  const tokenOf = (w, token) => {
    const at = lower(token);
    if (!w.tokens.has(at)) w.tokens.set(at, tokenEntry());
    return w.tokens.get(at);
  };
  for (const [token, amount] of Object.entries(balances)) tokenOf(world, token).balances.set(owner, BigInt(amount));
  for (const { token, spender, amount } of allowances) tokenOf(world, token).allowances.set(`${owner}|${lower(spender)}`, BigInt(amount));
  for (const p of positions) {
    world.nfts[p.dex].set(BigInt(p.tokenId), {
      owner: lower(p.owner ?? owner), approved: lower(p.approved ?? zeroAddress), subscriber: lower(p.subscriber ?? zeroAddress),
      pool: { ...p.pool, currency0: lower(p.pool.currency0), currency1: lower(p.pool.currency1), hooks: lower(p.pool.hooks ?? zeroAddress) },
      tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: BigInt(p.liquidity),
      principal: (p.principal ?? [0n, 0n]).map(BigInt), fees: (p.fees ?? [0n, 0n]).map(BigInt),
    });
  }
  // Each vault's root, fixed when the chain is made (a vault's root does not move with approvals), and whether it is armed.
  const disarmedSet = new Set(disarmed.map(lower));
  const roots = new Map(vaults.map((vault) => {
    const v = lower(vault);
    const found = positions.find((p) => lower(p.approved ?? zeroAddress) === v || lower(p.subscriber ?? zeroAddress) === v);
    return [v, found ? { dex: found.dex, tokenId: BigInt(found.tokenId) } : null];
  }));

  let current = home;
  let clock = timestamp;
  let refuseSend = false, refuseSign = false, revertNext = false, priceMoved = false, legsMoved = false;
  let managerOverride = null;
  const log = [], asked = [], offChain = [], sends = [], declined = [], signed = [], missing = [];
  // How many calls each aggregate3 carried (added 2026-10-05).
  const multicalls = [];
  // The batch path (added 2026-10-02): what wallet_sendCalls was asked, the next refusal, and a hold on the status.
  const batches = [];
  let refuseBatch = null, holdBatch = false;
  const hooks = new Map(), failing = new Map();

  const rankOf = (token) => (rankOverrides.has(lower(token)) ? rankOverrides.get(lower(token)) : (profile.ranks.get(lower(token)) ?? 0));
  const now = () => BigInt(clock + 2 * sends.length);
  const latest = () => ({ number: numberToHex(0x1000 + sends.length), timestamp: numberToHex(now()), hash: keccak256(numberToHex(0x1000 + sends.length, { size: 32 })) });
  const blockOf = (index) => ({ number: numberToHex(0x2000 + index), hash: keccak256(numberToHex(0x2000 + index, { size: 32 })) });
  const hashOf = (index) => numberToHex(0xc0ffee000000n + BigInt(index), { size: 32 });
  const zapDomain = (zap) => ({ name: 'Domino', version: '2', chainId: home, verifyingContract: zap });
  /** The zap's intentHash, computed here from eip712.json's types, apart from the app's typed data module. */
  const intentHashOf = (zap, intent) => hashTypedData({ domain: zapDomain(zap), types: INTENT_TYPES, primaryType: 'PositionIntent', message: intent });
  const routesHashOf = (legs) => keccak256(encodeAbiParameters(LEGS, [legs]));

  function logOf(address, eventName, args) {
    const event = EVENTS.find((item) => item.name === eventName);
    const plain = event.inputs.filter((input) => !input.indexed);
    return { address, topics: encodeEventTopics({ abi: [event], eventName, args }), data: encodeAbiParameters(plain, plain.map((input) => args[input.name])) };
  }

  // ---------------------------------------------------------------------------
  // Moving value inside one world
  // ---------------------------------------------------------------------------
  function debitEth(w, from, amount) {
    const have = w.eth.get(from) ?? 0n;
    if (have < amount) throw new Error('insufficient funds for value');
    w.eth.set(from, have - amount);
  }
  function pay(w, token, to, amount) {
    if (amount === 0n) return;
    if (lower(token) === zeroAddress) {
      if (to === owner && refusesEth) throw new Revert(REVERTS.transferFailed(zeroAddress));
      w.eth.set(to, (w.eth.get(to) ?? 0n) + amount);
      return;
    }
    const entry = tokenOf(w, token);
    entry.balances.set(to, (entry.balances.get(to) ?? 0n) + amount);
  }
  /** `spender` takes `amount` of `holder`'s token through its allowance; false when the allowance or the balance is short. */
  function pull(w, token, holder, spender, amount) {
    const entry = tokenOf(w, token);
    const key = `${holder}|${spender}`;
    const allowance = entry.allowances.get(key) ?? 0n;
    const balance = entry.balances.get(holder) ?? 0n;
    if (allowance < amount || balance < amount) return false;
    if (allowance !== MAX_UINT256) entry.allowances.set(key, allowance - amount);
    entry.balances.set(holder, balance - amount);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Contracts
  // ---------------------------------------------------------------------------
  function erc20(ctx, token, data) {
    const { functionName, args } = decodeFunctionData({ abi: ERC20_ABI, data });
    const entry = tokenOf(ctx.w, token);
    if (functionName === 'allowance') return encodeFunctionResult({ abi: ERC20_ABI, functionName, result: entry.allowances.get(`${lower(args[0])}|${lower(args[1])}`) ?? 0n });
    if (functionName === 'balanceOf') return encodeFunctionResult({ abi: ERC20_ABI, functionName, result: entry.balances.get(lower(args[0])) ?? 0n });
    if (functionName === 'decimals' || functionName === 'symbol') {
      const known = PROFILES[home].chargeCurrencies.find((c) => lower(c.address) === token);
      const value = functionName === 'decimals' ? (known?.decimals ?? 18) : (known?.symbol ?? (token === profile.weth ? 'WETH' : 'TKN'));
      return encodeFunctionResult({ abi: ERC20_ABI, functionName, result: value });
    }
    // approve: the allowance is set exactly; a zero-first token refuses a non-zero to non-zero change, with no data.
    const key = `${ctx.from}|${lower(args[0])}`;
    const before = entry.allowances.get(key) ?? 0n;
    if (zeroFirstSet.has(token) && before !== 0n && args[1] !== 0n) throw new Revert('0x');
    entry.allowances.set(key, args[1]);
    return encodeFunctionResult({ abi: ERC20_ABI, functionName, result: true });
  }

  function registry(data) {
    const { functionName, args } = decodeFunctionData({ abi: REGISTRY_ABI, data });
    if (functionName === 'chargeCurrencyRank') return encodeFunctionResult({ abi: REGISTRY_ABI, functionName, result: rankOf(args[0]) });
    if (functionName === 'routerVersion') return encodeFunctionResult({ abi: REGISTRY_ABI, functionName, result: versions.get(lower(args[0])) ?? 0 });
    if (functionName === 'automationHalted') return encodeFunctionResult({ abi: REGISTRY_ABI, functionName, result: false });
    throw new Error(`unexpected ${functionName} on the registry`);
  }

  function permit2(ctx, data) {
    const { functionName, args } = decodeFunctionData({ abi: PERMIT2_ABI, data });
    if (functionName === 'nonceBitmap') return encodeFunctionResult({ abi: PERMIT2_ABI, functionName, result: ctx.w.permit2Bits.get(`${lower(args[0])}|${args[1]}`) ?? 0n });
    if (functionName === 'invalidateUnorderedNonces') {
      const key = `${ctx.from}|${args[0]}`;
      ctx.w.permit2Bits.set(key, (ctx.w.permit2Bits.get(key) ?? 0n) | args[1]);
      return '0x';
    }
    throw new Error(`unexpected ${functionName} on Permit2`);
  }

  /** Permit2's permitWitnessTransferFrom, as the zap calls it: deadline, nonce, the signer's witness signature, then the pulls. */
  async function permit2Pull(w, zap, signer, permit, intent, signature) {
    if (now() > permit.deadline) throw new Revert(REVERTS.signatureExpired(permit.deadline));
    const key = `${signer}|${permit.nonce >> 8n}`;
    const bits = w.permit2Bits.get(key) ?? 0n;
    if ((bits >> (permit.nonce & 255n)) & 1n) throw new Revert(REVERTS.invalidNonce());
    // An account with code is asked through EIP-1271; an EIP-7702 delegate without isValidSignature cannot answer.
    if (code.has(signer)) throw new Revert(REVERTS.invalidContractSignature());
    if (signature.length !== 132) throw new Revert(REVERTS.invalidSignatureLength());
    const recovered = await recoverTypedDataAddress({
      domain: { name: 'Permit2', chainId: home, verifyingContract: profile.permit2 }, types: PERMIT2_TYPES, primaryType: 'PermitBatchWitnessTransferFrom',
      message: { permitted: permit.permitted, spender: zap, nonce: permit.nonce, deadline: permit.deadline, witness: intent }, signature,
    });
    if (lower(recovered) !== signer) throw new Revert(REVERTS.invalidSigner());
    w.permit2Bits.set(key, bits | (1n << (permit.nonce & 255n)));
    for (const { token, amount } of permit.permitted) if (!pull(w, lower(token), signer, profile.permit2, amount)) throw new Revert(REVERTS.transferFromFailed());
  }

  function positionManager(ctx, dex, data) {
    const abi = dex === 4 ? V4_PM_ABI : V3_NPM_ABI;
    const { functionName, args = [] } = decodeFunctionData({ abi, data });
    const nfts = ctx.w.nfts[dex];
    const nft = nfts.get(functionName === 'approve' ? args[1] : args[0]);
    const absent = () => { throw new Revert(dex === 4 ? REVERTS.notMinted() : errorString(functionName === 'positions' ? 'Invalid token ID' : 'ERC721: owner query for nonexistent token')); };
    switch (functionName) {
      case 'ownerOf': return nft ? encodeFunctionResult({ abi, functionName, result: nft.owner }) : absent();
      case 'getApproved':
        if (!nft && dex === 3) absent();
        return encodeFunctionResult({ abi, functionName, result: nft?.approved ?? zeroAddress });
      case 'isApprovedForAll': return encodeFunctionResult({ abi, functionName, result: false });
      case 'subscriber': return encodeFunctionResult({ abi, functionName, result: nft?.subscriber ?? zeroAddress });
      case 'getPositionLiquidity': return encodeFunctionResult({ abi, functionName, result: nft?.liquidity ?? 0n });
      case 'getPoolAndPositionInfo': {
        if (!nft) return encodeFunctionResult({ abi, functionName, result: [{ currency0: zeroAddress, currency1: zeroAddress, fee: 0, tickSpacing: 0, hooks: zeroAddress }, 0n] });
        const keyOf = { currency0: nft.pool.currency0, currency1: nft.pool.currency1, fee: nft.pool.fee, tickSpacing: nft.pool.tickSpacing, hooks: nft.pool.hooks };
        const poolId = keccak256(encodeAbiParameters(POOL_KEY, [keyOf]));
        const packed = ((BigInt(poolId) >> 56n) << 56n) | (BigInt.asUintN(24, BigInt(nft.tickUpper)) << 32n) | (BigInt.asUintN(24, BigInt(nft.tickLower)) << 8n);
        return encodeFunctionResult({ abi, functionName, result: [keyOf, packed] });
      }
      case 'positions':
        if (!nft) absent();
        return encodeFunctionResult({ abi, functionName, result: [0n, nft.approved, nft.pool.currency0, nft.pool.currency1, nft.pool.fee, nft.tickLower, nft.tickUpper, nft.liquidity, 0n, 0n, nft.fees[0], nft.fees[1]] });
      case 'approve': {
        if (!nft) absent();
        if (nft.owner !== ctx.from) throw new Revert(errorString(dex === 4 ? 'NOT_AUTHORIZED' : 'ERC721: approve caller is not owner nor approved for all'));
        nft.approved = lower(args[0]);
        return '0x';
      }
    }
    throw new Error(`unexpected ${functionName} on the v${dex} position manager`);
  }

  function factory(w, data) {
    const { functionName, args } = decodeFunctionData({ abi: V3_FACTORY_ABI, data });
    if (functionName === 'getPool') {
      const [a, b, fee] = args;
      const [currency0, currency1] = BigInt(a) < BigInt(b) ? [lower(a), lower(b)] : [lower(b), lower(a)];
      const known = [...w.pools.values()].find((p) => p.pool.dex === 3 && lower(p.pool.currency0) === currency0 && lower(p.pool.currency1) === currency1 && p.pool.fee === fee);
      return encodeFunctionResult({ abi: V3_FACTORY_ABI, functionName, result: known ? v3PoolOf(known.pool) : zeroAddress });
    }
    if (functionName !== 'feeAmountTickSpacing') throw new Error(`unexpected ${functionName} on the v3 factory`);
    return encodeFunctionResult({ abi: V3_FACTORY_ABI, functionName, result: profile.tiers.get(args[0]) ?? 0 });
  }
  /** v4's StateView: getSlot0 and getLiquidity of a pool id (zeros for a pool with no price). */
  function stateView(w, data) {
    const { functionName, args } = decodeFunctionData({ abi: STATE_VIEW_ABI, data });
    const found = [...w.pools.values()].find((p) => p.pool.dex === 4 && poolIdOf(p.pool) === lower(args[0]));
    if (functionName === 'getSlot0') return encodeFunctionResult({ abi: STATE_VIEW_ABI, functionName, result: [found?.sqrtPriceX96 ?? 0n, found?.tick ?? 0, 0, found?.pool.fee ?? 0] });
    if (functionName === 'getLiquidity') return encodeFunctionResult({ abi: STATE_VIEW_ABI, functionName, result: found?.liquidity ?? 0n });
    throw new Error(`unexpected ${functionName} on StateView`);
  }
  /**
   * Multicall3's aggregate3 (added 2026-10-05, finance/v2/zap.ts readPools): each call run against this world as a call of
   * its own from the Multicall3 address, in order; one that reverts answers (false, its revert data) when it may fail.
   */
  async function multicall(w, data) {
    const { functionName, args } = decodeFunctionData({ abi: MULTICALL3_ABI, data });
    if (functionName !== 'aggregate3') throw new Error(`unexpected ${functionName} on Multicall3`);
    const results = [];
    for (const call of args[0]) {
      try {
        const { result } = await execute(w, { to: call.target, from: profile.multicall3, data: call.callData });
        results.push({ success: true, returnData: result });
      } catch (error) {
        if (!(error instanceof Revert) || !call.allowFailure) throw error;
        results.push({ success: false, returnData: error.data ?? '0x' });
      }
    }
    multicalls.push(args[0].length);
    return encodeFunctionResult({ abi: MULTICALL3_ABI, functionName, result: results });
  }
  /** A v3 pool this fake knows: slot0 and liquidity. */
  function v3Pool(entry, data) {
    const { functionName } = decodeFunctionData({ abi: V3_POOL_ABI, data });
    if (functionName === 'slot0') return encodeFunctionResult({ abi: V3_POOL_ABI, functionName, result: [entry.sqrtPriceX96, entry.tick, 0, 1, 1, 0, true] });
    if (functionName === 'liquidity') return encodeFunctionResult({ abi: V3_POOL_ABI, functionName, result: entry.liquidity });
    throw new Error(`unexpected ${functionName} on a v3 pool`);
  }

  /** The zap's action, in the contract's order (docs/v2/F2_ZAP.md "The flows"). */
  async function act(ctx, dex, functionName, args) {
    const { w, from } = ctx;
    const zap = ctx.to;
    const plan = args[0];
    const intent = plan.intent;
    const actionCode = { create: 1, createWithPermit: 1, increase: 2, increaseWithPermit: 2, changeRange: 3, exit: 4 }[functionName];
    const withPermit = functionName.endsWith('WithPermit');
    const pool = { ...intent.pool, currency0: lower(intent.pool.currency0), currency1: lower(intent.pool.currency1), hooks: lower(intent.pool.hooks) };
    const recipient = lower(intent.recipient);
    const legs = plan.legs;
    const invalid = () => { throw new Revert(REVERTS.invalidPlan()); };
    // 1. The plan.
    if (intent.action !== actionCode) invalid();
    if (now() > intent.deadline) throw new Revert(REVERTS.planExpired());
    if (recipient === zeroAddress || recipient === zap) invalid();
    if (pool.dex !== dex) invalid();
    if (pool.hooks !== zeroAddress && (dex === 3 || !hookedPoolsAllowed)) invalid();
    if (routesHashOf(legs) !== lower(intent.routesHash)) invalid();
    if (actionCode === 1 && intent.tokenId !== 0n) invalid();
    if (legs.length > 8) invalid();
    for (const leg of legs) {
      if (lower(leg.tokenIn) === lower(leg.tokenOut) || leg.amountIn === 0n || leg.minAmountOut === 0n) invalid();
      if (leg.kind === 1 && (versions.get(lower(leg.router)) ?? 0) < 212) invalid();
      if ((leg.kind === 2 || leg.kind === 3) && lower(leg.router) !== zeroAddress) invalid();
      if (leg.kind < 1 || leg.kind > 3) invalid();
    }
    const hash = intentHashOf(zap, intent);
    // 2. Consent: the sender, or the Permit2 signer (the recipient); an existing position's CURRENT owner only.
    const payer = withPermit ? recipient : from;
    const nfts = w.nfts[dex];
    let nft = null;
    if (actionCode !== 1) {
      nft = nfts.get(intent.tokenId);
      if (!nft) throw new Revert(REVERTS.positionPoolMismatch(intent.tokenId));
      if (nft.owner !== payer) throw new Revert(REVERTS.unauthorized());
      const p = nft.pool;
      if (p.dex !== pool.dex || p.currency0 !== pool.currency0 || p.currency1 !== pool.currency1 || p.fee !== pool.fee || p.tickSpacing !== pool.tickSpacing || p.hooks !== pool.hooks) {
        throw new Revert(REVERTS.positionPoolMismatch(intent.tokenId));
      }
      if ((actionCode === 2 || actionCode === 4) && (intent.tickLower !== nft.tickLower || intent.tickUpper !== nft.tickUpper)) invalid();
    }
    // 3. Inputs.
    const held = new Map();
    const add = (token, amount) => held.set(lower(token), (held.get(lower(token)) ?? 0n) + amount);
    const logs = ctx.logs;
    if (actionCode <= 2) {
      const nativeIn = plan.inputs.filter((input) => lower(input.token) === zeroAddress).reduce((sum, input) => sum + input.amount, 0n);
      if (withPermit) {
        const [, permit, signature] = args;
        if (nativeIn > 0n || permit.nonce !== intent.nonce) invalid();
        if (permit.permitted.length !== plan.inputs.length || permit.permitted.some((p, i) => lower(p.token) !== lower(plan.inputs[i].token) || p.amount !== plan.inputs[i].amount)) invalid();
        await permit2Pull(w, zap, payer, permit, intent, signature);
      } else {
        if (ctx.value !== nativeIn) invalid();
        for (const input of plan.inputs) {
          if (lower(input.token) !== zeroAddress && !pull(w, lower(input.token), from, zap, input.amount)) throw new Revert(REVERTS.tokenCallFailed(input.token));
        }
      }
      for (const input of plan.inputs) {
        add(input.token, input.amount);
        logs.push(logOf(zap, 'InputPulled', { intentHash: hash, owner: payer, token: input.token, amount: input.amount }));
      }
    }
    // The NFT approved to the zap: v4 increase, change of range and exit on both.
    if ((actionCode === 2 && dex === 4) || actionCode >= 3) {
      if (nft.approved !== zap) throw new Revert(dex === 4 ? REVERTS.v4NotApproved(zap) : REVERTS.v3NotApproved());
    }
    // 4. Withdraw.
    let removed = [0n, 0n];
    let removedLiquidity = 0n;
    if (actionCode >= 3) {
      const liquidity = plan.liquidityToRemove;
      const burn = actionCode === 3 ? plan.burnOld : plan.burn;
      if (actionCode === 4 && liquidity < intent.minLiquidity) throw new Revert(REVERTS.exitBelowMinimum());
      if (liquidity > nft.liquidity) invalid();
      if (burn && liquidity !== nft.liquidity) throw new Revert(REVERTS.partialBurn(intent.tokenId, nft.liquidity, liquidity));
      const part = (amount) => (nft.liquidity === 0n ? 0n : (amount * liquidity) / nft.liquidity);
      const out = [part(nft.principal[0]), part(nft.principal[1])];
      for (const [i, minimum] of [plan.amount0MinRemoved, plan.amount1MinRemoved].entries()) {
        if (out[i] < minimum) throw new Revert(dex === 4 ? REVERTS.v4MinimumAmount(minimum, out[i]) : REVERTS.v3PriceSlippage());
      }
      removed = [out[0] + nft.fees[0], out[1] + nft.fees[1]];
      removedLiquidity = liquidity;
      nft.principal = [nft.principal[0] - out[0], nft.principal[1] - out[1]];
      nft.fees = [0n, 0n];
      nft.liquidity -= liquidity;
      if (burn) nfts.delete(intent.tokenId);
      logs.push(logOf(zap, 'PositionLiquidityChanged', { intentHash: hash, owner: payer, tokenId: intent.tokenId, pool, liquidityDelta: -liquidity, amount0: removed[0], amount1: removed[1] }));
      if (actionCode === 4 && legs.length === 0) {
        // An exit without conversion pays the recipient directly.
        pay(w, pool.currency0, recipient, removed[0]);
        pay(w, pool.currency1, recipient, removed[1]);
      } else {
        add(pool.currency0, removed[0]);
        add(pool.currency1, removed[1]);
      }
    }
    // 5. The assisted swap and its fee.
    let feeToken = zeroAddress;
    let feeAmount = 0n;
    if (legs.length > 0) {
      const token = feeTokenOf(legs, rankOf);
      if (intent.feeBps !== 65 || lower(intent.feeToken) !== token) throw new Revert(REVERTS.feeMismatch());
      const outs = [];
      for (const leg of legs) {
        const tokenIn = lower(leg.tokenIn), tokenOut = lower(leg.tokenOut);
        if ((held.get(tokenIn) ?? 0n) < leg.amountIn) throw new Revert(REVERTS.swapEffectMismatch());
        const out = legsMoved ? leg.minAmountOut - 1n : leg.minAmountOut + leg.minAmountOut / 100n;
        if (out < leg.minAmountOut) throw new Revert(REVERTS.swapEffectMismatch());
        held.set(tokenIn, held.get(tokenIn) - leg.amountIn);
        add(tokenOut, out);
        outs.push(out);
        const venue = leg.kind === 1 ? lower(leg.router) : leg.kind === 2 ? profile.v3Factory : profile.v4PoolManager;
        logs.push(logOf(zap, 'SwapLegExecuted', { kind: leg.kind, tokenIn, tokenOut, venue, amountIn: leg.amountIn, amountOut: out }));
      }
      const spent = legs.filter((leg) => lower(leg.tokenIn) === token).reduce((sum, leg) => sum + leg.amountIn, 0n);
      const delivered = legs.reduce((sum, leg, i) => (lower(leg.tokenOut) === token ? sum + outs[i] : sum), 0n);
      feeAmount = ((spent > delivered ? spent : delivered) * 65n) / 10_000n;
      feeToken = token;
      if ((held.get(token) ?? 0n) < feeAmount) throw new Revert(REVERTS.feeNotBacked(token));
      held.set(token, held.get(token) - feeAmount);
      w.fees.set(token, (w.fees.get(token) ?? 0n) + feeAmount);
      logs.push(logOf(zap, 'FeeCharged', { kind: 1, token, payer, amount: feeAmount, ref: hash }));
    } else if (intent.feeBps !== 0 || lower(intent.feeToken) !== zeroAddress) throw new Revert(REVERTS.feeMismatch());
    // 5b. A new pool (added 2026-10-02, rev2 §2.6.5): initialized only if it has no price; priced first by someone else at
    // another price, the mint falls below its minimum (InsufficientLiquidity), as the race of §2.6.5.
    let raced = false;
    if (actionCode === 1 && plan.initSqrtPriceX96 !== undefined && plan.initSqrtPriceX96 !== 0n) {
      const key = poolKey(pool);
      const priced = w.pools.get(key);
      if (!priced) w.pools.set(key, { pool, sqrtPriceX96: plan.initSqrtPriceX96, tick: 0, liquidity: 0n });
      else if (priced.sqrtPriceX96 !== plan.initSqrtPriceX96) raced = true;
    }
    // 6. Add.
    let resultTokenId = actionCode === 1 ? 0n : intent.tokenId;
    let liquidity = removedLiquidity;
    let amount0 = removed[0], amount1 = removed[1];
    if (actionCode <= 3) {
      // v3 holds WETH: native ETH is wrapped before it enters a WETH pool, and what is left of it comes back as WETH.
      if (dex === 3 && (pool.currency0 === profile.weth || pool.currency1 === profile.weth) && (held.get(zeroAddress) ?? 0n) > 0n) {
        add(profile.weth, held.get(zeroAddress));
        held.set(zeroAddress, 0n);
      }
      const take = (token, cap) => { const have = held.get(token) ?? 0n; return ((have < cap ? have : cap) * 99n) / 100n; };
      amount0 = take(pool.currency0, plan.amount0Max);
      amount1 = take(pool.currency1, plan.amount1Max);
      liquidity = priceMoved || raced ? intent.minLiquidity - 1n : intent.minLiquidity + intent.minLiquidity / 100n;
      if (liquidity < intent.minLiquidity) throw new Revert(REVERTS.insufficientLiquidity(liquidity, intent.minLiquidity));
      held.set(pool.currency0, (held.get(pool.currency0) ?? 0n) - amount0);
      held.set(pool.currency1, (held.get(pool.currency1) ?? 0n) - amount1);
      if (actionCode === 2) {
        nft.liquidity += liquidity;
        nft.principal = [nft.principal[0] + amount0, nft.principal[1] + amount1];
        // v4: the increase credits the accrued fees to the zap, which refunds them; v3 leaves them owed in the NFT.
        if (dex === 4) {
          add(pool.currency0, nft.fees[0]);
          add(pool.currency1, nft.fees[1]);
          nft.fees = [0n, 0n];
        }
      } else {
        resultTokenId = w.next[dex];
        w.next[dex] += 1n;
        nfts.set(resultTokenId, { owner: recipient, approved: zeroAddress, pool, tickLower: intent.tickLower, tickUpper: intent.tickUpper, liquidity, principal: [amount0, amount1], fees: [0n, 0n] });
      }
      logs.push(logOf(zap, 'PositionLiquidityChanged', { intentHash: hash, owner: payer, tokenId: resultTokenId, pool, liquidityDelta: liquidity, amount0: -amount0, amount1: -amount1 }));
    }
    // 7. Refund everything the action touched to the recipient.
    for (const [token, amount] of held) {
      if (amount <= 0n) continue;
      pay(w, token, recipient, amount);
      logs.push(logOf(zap, 'Refunded', { recipient, token, amount }));
    }
    logs.push(logOf(zap, 'PositionActionExecuted', { action: actionCode, recipient, tokenId: resultTokenId, previousTokenId: actionCode === 1 ? 0n : intent.tokenId, liquidity, intentHash: hash }));
    return encodeFunctionResult({ abi: ZAP_ABI, functionName, result: { tokenId: resultTokenId, liquidity, amount0, amount1, feeToken, feeAmount } });
  }

  async function zapCall(ctx, data) {
    const dex = ctx.to === ZAP_V3 ? 3 : 4;
    const { functionName, args = [] } = decodeFunctionData({ abi: ZAP_ABI, data });
    switch (functionName) {
      case 'positionManager': return encodeFunctionResult({ abi: ZAP_ABI, functionName, result: managerOverride ?? (dex === 4 ? profile.v4PositionManager : profile.v3PositionManager) });
      case 'hookedPoolsAllowed': return encodeFunctionResult({ abi: ZAP_ABI, functionName, result: dex === 4 && hookedPoolsAllowed });
      case 'domainSeparator': return encodeFunctionResult({ abi: ZAP_ABI, functionName, result: hashDomain({ domain: zapDomain(ctx.to), types: { EIP712Domain: EIP712.domain.fields } }) });
      case 'nonceBitmap': return encodeFunctionResult({ abi: ZAP_ABI, functionName, result: ctx.w.zapBits.get(`${ctx.to}|${lower(args[0])}|${args[1]}`) ?? 0n });
      case 'invalidateNonces': {
        const key = `${ctx.to}|${ctx.from}|${args[0]}`;
        ctx.w.zapBits.set(key, (ctx.w.zapBits.get(key) ?? 0n) | args[1]);
        ctx.logs.push(logOf(ctx.to, 'NoncesInvalidated', { owner: ctx.from, word: args[0], mask: args[1] }));
        return '0x';
      }
      case 'create': case 'increase': case 'createWithPermit': case 'increaseWithPermit': case 'changeRange': case 'exit':
        return act(ctx, dex, functionName, args);
    }
    throw new Error(`unexpected ${functionName} on the zap`);
  }

  /** One call against world `w`: what it returns, or a Revert; `logs` collects what it emitted. */
  async function execute(w, call) {
    const to = lower(call.to);
    const from = lower(call.from ?? zeroAddress);
    const value = BigInt(call.value ?? '0x0');
    const data = call.data ?? call.input ?? '0x';
    const ctx = { w, from, to, value, logs: [] };
    if (value > 0n) debitEth(w, from, value);
    let result;
    if (data === '0x') {
      // A plain ETH payment: the one-wei probe the app sends to an account with code.
      if (to === owner && refusesEth) throw new Revert('0x');
      w.eth.set(to, (w.eth.get(to) ?? 0n) + value);
      result = '0x';
    } else if (to === ZAP_V3 || to === ZAP_V4) {
      const payable = ['0x0e97b041', '0x2e563c43'].includes(data.slice(0, 10));
      if (value > 0n && !payable) throw new Revert('0x');
      result = await zapCall(ctx, data);
    } else {
      if (value > 0n) throw new Revert('0x');
      if (to === REGISTRY) result = registry(data);
      // Added 2026-10-02 (S1 review F7): the two vault factories answer isVault for the `vaults` a test names.
      else if (to === lower(FAKE.vaultFactoryV3) || to === lower(FAKE.vaultFactoryV4)) {
        const { functionName, args } = decodeFunctionData({ abi: VAULT_FACTORY_ABI, data });
        if (functionName !== 'isVault') throw new Error(`unexpected ${functionName} on a vault factory`);
        result = encodeFunctionResult({ abi: VAULT_FACTORY_ABI, functionName, result: vaults.map(lower).includes(lower(args[0])) });
      }
      // Added 2026-10-02 (Domino V2 rev2 review, L2): a vault's root() and rootArmed().
      else if (roots.has(to)) {
        const { functionName } = decodeFunctionData({ abi: VAULT_ABI, data });
        const root = roots.get(to);
        if (functionName === 'root') result = encodeFunctionResult({ abi: VAULT_ABI, functionName, result: { dex: root?.dex ?? 0, positionManager: root ? (root.dex === 4 ? profile.v4PositionManager : profile.v3PositionManager) : zeroAddress, tokenId: root?.tokenId ?? 0n } });
        else if (functionName === 'rootArmed') result = encodeFunctionResult({ abi: VAULT_ABI, functionName, result: root !== null && !disarmedSet.has(to) });
        else throw new Error(`unexpected ${functionName} on a vault`);
      }
      else if (to === profile.permit2) result = permit2(ctx, data);
      else if (to === profile.v4PositionManager) result = positionManager(ctx, 4, data);
      else if (to === profile.v3PositionManager) result = positionManager(ctx, 3, data);
      else if (to === profile.v3Factory) result = factory(w, data);
      else if (to === profile.v4StateView) result = stateView(w, data);
      else if (to === profile.multicall3) result = await multicall(w, data);
      else if ([...w.pools.values()].some((p) => p.pool.dex === 3 && v3PoolOf(p.pool) === to)) result = v3Pool([...w.pools.values()].find((p) => p.pool.dex === 3 && v3PoolOf(p.pool) === to), data);
      else result = erc20(ctx, to, data);
    }
    return { result, logs: ctx.logs };
  }

  // ---------------------------------------------------------------------------
  // The wallet's JSON-RPC
  // ---------------------------------------------------------------------------
  const ANY_CHAIN = new Set(['eth_accounts', 'eth_requestAccounts', 'eth_chainId', 'wallet_switchEthereumChain']);
  async function request(method, params = []) {
    const fails = failing.get(method) ?? 0;
    if (fails > 0) {
      failing.set(method, fails - 1);
      log.push(method);
      return { error: { code: -32603, message: 'Internal JSON-RPC error.' } };
    }
    const reply = await answer(method, params);
    const hook = hooks.get(method);
    if (hook) { hooks.delete(method); hook(); }
    return reply;
  }
  async function answer(method, params) {
    log.push(method);
    asked.push({ method, params });
    // The batch path (added 2026-10-02): a wallet states its capabilities whatever chain it is on.
    if (method === 'wallet_getCapabilities' && atomic !== null) {
      if (lower(params[0]) !== owner) return { error: { code: 4100, message: 'The requested account has not been authorized.' } };
      return { result: { [numberToHex(home)]: { atomic: { status: atomic } } } };
    }
    if (current !== home && !ANY_CHAIN.has(method)) {
      offChain.push(method);
      return { error: { code: -32000, message: `${method} asked on chain ${current}, where this fake holds no state` } };
    }
    try {
      switch (method) {
        case 'eth_accounts': case 'eth_requestAccounts': return { result: [owner] };
        case 'eth_chainId': return { result: numberToHex(current) };
        case 'wallet_switchEthereumChain': {
          const wanted = Number(BigInt(params[0].chainId));
          if (!PROFILES[wanted]) return { error: { code: 4902, message: 'Unrecognized chain ID.' } };
          current = wanted;
          return { result: null };
        }
        case 'eth_getCode': return { result: code.get(lower(params[0])) ?? '0x' };
        case 'eth_getStorageAt': return { result: `0x${'0'.repeat(64)}` };
        case 'eth_gasPrice': return { result: '0x5f5e100' };
        case 'eth_maxPriorityFeePerGas': return { result: '0xf4240' };
        case 'eth_getTransactionCount': return { result: numberToHex(sends.length) };
        case 'eth_getBalance': return { result: numberToHex(world.eth.get(lower(params[0])) ?? 0n) };
        // Base's GasPriceOracle predeploy (post-B4 review F5): getL1FeeUpperBound(size) answers a fixed ceiling, 7 gwei.
        case 'eth_call': if (lower(params[0].to) === '0x420000000000000000000000000000000000000f' && String(params[0].data).startsWith('0xf1c7a58b')) return { result: `0x${(7_000_000_000n).toString(16).padStart(64, '0')}` };
          return { result: (await execute(structuredClone(world), params[0])).result };
        case 'eth_estimateGas': await execute(structuredClone(world), params[0]); return { result: '0x7a120' };
        case 'eth_signTypedData_v4': {
          if (lower(params[0]) !== owner) return { error: { code: 4100, message: 'The requested account has not been authorized.' } };
          const wire = JSON.parse(params[1]);
          // Wallets refuse typed data whose domain names another chain than the one they are on.
          if (Number(wire.domain.chainId) !== current) return { error: { code: -32602, message: 'Provided chainId does not match the currently active chain.' } };
          if (refuseSign) { refuseSign = false; return { error: { code: 4001, message: 'User rejected the request.' } }; }
          const { EIP712Domain, ...types } = wire.types;
          void EIP712Domain;
          const signature = await account.signTypedData({ domain: wire.domain, types, primaryType: wire.primaryType, message: wire.message });
          signed.push({ typed: wire, signature });
          return { result: signature };
        }
        case 'eth_sendTransaction': {
          const tx = params[0];
          if (lower(tx.from) !== owner) return { error: { code: 4100, message: 'The requested account has not been authorized.' } };
          if (tx.chainId !== undefined && BigInt(tx.chainId) !== BigInt(current)) return { error: { code: -32000, message: 'chainId does not match the wallet\'s chain' } };
          if (BigInt(tx.nonce) !== BigInt(sends.length)) return { error: { code: -32000, message: 'nonce does not match the account' } };
          if (refuseSend) { refuseSend = false; declined.push(tx); return { error: { code: 4001, message: 'User rejected the request.' } }; }
          const index = sends.length;
          let status = '0x1', logs = [];
          if (revertNext) {
            revertNext = false;
            status = '0x0';
          } else {
            const next = structuredClone(world);
            try {
              ({ logs } = await execute(next, tx));
              world = next;
            } catch (error) {
              if (!(error instanceof Revert)) throw error;
              status = '0x0';
            }
          }
          sends.push({ tx, status, logs });
          return { result: hashOf(index) };
        }
        case 'eth_getTransactionByHash': case 'eth_getTransactionReceipt': {
          const index = sends.findIndex((_, i) => hashOf(i) === lower(params[0]));
          if (index === -1) return { result: null };
          const { tx, status, logs } = sends[index];
          const block = { blockHash: blockOf(index).hash, blockNumber: blockOf(index).number };
          if (method === 'eth_getTransactionByHash') return { result: { hash: hashOf(index), from: tx.from, to: tx.to, input: tx.data, value: tx.value, nonce: tx.nonce, ...block } };
          return { result: {
            transactionHash: hashOf(index), from: tx.from, to: tx.to, status, gasUsed: '0x3d090', effectiveGasPrice: '0x5f5e100', ...block,
            ...(home === 8453 ? { l1Fee: '0x2a' } : {}),
            logs: logs.map((entry, i) => ({ address: entry.address, topics: entry.topics, data: entry.data, logIndex: numberToHex(i), ...block })),
          } };
        }
        // The batch path (added 2026-10-02).
        case 'eth_simulateV1': {
          if (!simulateV1) break;
          const calls = params[0]?.blockStateCalls?.[0]?.calls ?? [];
          const next = structuredClone(world);
          let failed = false;
          const results = [];
          for (const call of calls) {
            if (failed) { results.push({ status: '0x0', gasUsed: '0x0', returnData: '0x' }); continue; }
            try {
              const { result } = await execute(next, call);
              results.push({ status: '0x1', gasUsed: '0x30d40', returnData: result });
            } catch (error) {
              if (!(error instanceof Revert)) throw error;
              failed = true;
              results.push({ status: '0x0', gasUsed: '0x0', returnData: '0x', error: { code: 3, message: 'execution reverted', data: error.data } });
            }
          }
          return { result: [{ calls: results }] };
        }
        case 'wallet_sendCalls': {
          if (atomic === null) break;
          const batch = params[0];
          if (lower(batch.from) !== owner) return { error: { code: 4100, message: 'The requested account has not been authorized.' } };
          if (BigInt(batch.chainId) !== BigInt(current)) return { error: { code: 5710, message: 'Unsupported chain id' } };
          if (batch.version !== '2.0.0' || batch.atomicRequired !== true) return { error: { code: -32602, message: 'Invalid batch' } };
          if (refuseBatch !== null) { const code = refuseBatch; refuseBatch = null; return { error: { code, message: code === 4001 ? 'User rejected the request.' : 'Batch refused.' } }; }
          const index = sends.length;
          const next = structuredClone(world);
          let status = '0x1', logs = [];
          try {
            for (const call of batch.calls) logs.push(...(await execute(next, { ...call, from: owner })).logs);
            world = next;
          } catch (error) {
            if (!(error instanceof Revert)) throw error;
            status = '0x0';
            logs = [];
          }
          const value = batch.calls.reduce((sum, call) => sum + BigInt(call.value ?? '0x0'), 0n);
          sends.push({ tx: { from: owner, to: owner, data: '0x', value: numberToHex(value), nonce: numberToHex(index) }, status, logs });
          const id = `batch-${index}`;
          batches.push({ id, calls: batch.calls, index, status });
          return { result: { id } };
        }
        case 'wallet_getCallsStatus': {
          if (atomic === null) break;
          const found = batches.find((entry) => entry.id === params[0]);
          if (!found) return { error: { code: 5730, message: 'Unknown bundle id' } };
          if (holdBatch) return { result: { version: '2.0.0', id: found.id, chainId: numberToHex(home), status: 100, atomic: true } };
          return { result: { version: '2.0.0', id: found.id, chainId: numberToHex(home), status: found.status === '0x1' ? 200 : 500, atomic: true,
            receipts: [{ status: found.status, transactionHash: hashOf(found.index), blockHash: blockOf(found.index).hash, blockNumber: blockOf(found.index).number, gasUsed: '0x3d090', logs: [] }] } };
        }
        case 'eth_getLogs': {
          const filter = params[0] ?? {};
          const out = [];
          sends.forEach(({ logs, status }, index) => {
            if (status !== '0x1') return;
            logs.forEach((entry, i) => {
              if (filter.address && lower(filter.address) !== lower(entry.address)) return;
              if ((filter.topics ?? []).some((topic, t) => topic !== null && lower(topic) !== lower(entry.topics[t] ?? ''))) return;
              out.push({ address: entry.address, topics: entry.topics, data: entry.data, logIndex: numberToHex(i), transactionHash: hashOf(index), blockHash: blockOf(index).hash, blockNumber: blockOf(index).number, removed: false });
            });
          });
          return { result: out };
        }
        case 'eth_getBlockByNumber': {
          if (params[0] === 'latest') return { result: latest() };
          if (params[0] === 'finalized') return { result: { number: finality === 'lagging' ? '0x1' : '0xffffff', hash: keccak256('0xf1') } };
          const index = Number(BigInt(params[0])) - 0x2000;
          if (index >= 0 && index < sends.length) return { result: blockOf(index) };
          const number = Number(BigInt(params[0]));
          return { result: { number: params[0], timestamp: numberToHex(now()), hash: keccak256(numberToHex(number, { size: 32 })) } };
        }
      }
    } catch (error) {
      if (error instanceof Revert) return { error: { code: 3, message: 'execution reverted', data: error.data } };
      missing.push(String(error));
      return { error: { code: -32000, message: String(error) } };
    }
    return { error: { code: 4200, message: `${method} is not supported` } };
  }

  const nftOf = (dex, tokenId) => world.nfts[dex].get(BigInt(tokenId));
  return {
    owner, home, profile, contracts, account, log, asked, offChain, sends, declined, signed, missing, multicalls, request,
    /** The chain the wallet is on now. */
    get chainId() { return current; },
    /** The block the next read sees. */
    latest,
    /** Moves the wallet to another chain, as the person would in the wallet. */
    switchTo(id) { current = id; },
    /** The chain the wallet is on now, as its connector reports it (V2Wallet.chainId). */
    chainNow: () => current,
    decline() { refuseSend = true; },
    declineSignature() { refuseSign = true; },
    revert() { revertNext = true; },
    /** Prices a pool now, as another account's initialization would (rev2 §2.6.5's race), or a pool that already exists. */
    initializePool(pool, sqrtPriceX96, tick = 0, liquidity = 0n) { world.pools.set(poolKey(pool), { pool, sqrtPriceX96: BigInt(sqrtPriceX96), tick, liquidity: BigInt(liquidity) }); },
    /** A pool's price as this fake holds it (null when it has none). */
    poolPrice(pool) { return world.pools.get(poolKey(pool))?.sqrtPriceX96 ?? null; },
    failNext(method, times = 1) { failing.set(method, (failing.get(method) ?? 0) + times); },
    /** Runs `then` once, right after the wallet next answers `method`. */
    once(method, then) { hooks.set(method, then); },
    /** The next additions mint one unit under their minimum, as after a price move (InsufficientLiquidity(uint128,uint128)). */
    movePrice() { priceMoved = true; },
    /** Legs deliver one unit under their minimum (SwapEffectMismatch). */
    moveLegs() { legsMoved = true; },
    /** Seconds pass on the chain. */
    warp(seconds) { clock += seconds; },
    setCode(address, bytes) { code.set(lower(address), bytes); },
    setRank(token, rank) { rankOverrides.set(lower(token), rank); },
    setRouterVersion(router, version) { versions.set(lower(router), version); },
    setPositionManager(address) { managerOverride = lower(address); },
    setAllowance(token, spender, amount) { tokenOf(world, token).allowances.set(`${owner}|${lower(spender)}`, amount); },
    setBalance(token, amount) { tokenOf(world, token).balances.set(owner, amount); },
    approveNft(dex, tokenId, spender) { nftOf(dex, tokenId).approved = lower(spender); },
    allowance: (token, spender) => world.tokens.get(lower(token))?.allowances.get(`${owner}|${lower(spender)}`) ?? 0n,
    balanceOf: (token, who = owner) => (lower(token) === zeroAddress ? world.eth.get(lower(who)) ?? 0n : world.tokens.get(lower(token))?.balances.get(lower(who)) ?? 0n),
    nft: nftOf,
    feesTaken: (token) => world.fees.get(lower(token)) ?? 0n,
    /** A Permit2 nonce of the owner's used elsewhere (another app's permit). */
    markPermit2Nonce(nonce) { const key = `${owner}|${nonce >> 8n}`; world.permit2Bits.set(key, (world.permit2Bits.get(key) ?? 0n) | (1n << (nonce & 255n))); },
    markZapNonce(dex, nonce) { const key = `${dex === 3 ? ZAP_V3 : ZAP_V4}|${owner}|${nonce >> 8n}`; world.zapBits.set(key, (world.zapBits.get(key) ?? 0n) | (1n << (nonce & 255n))); },
    permit2NonceUsed: (nonce) => (((world.permit2Bits.get(`${owner}|${nonce >> 8n}`) ?? 0n) >> (nonce & 255n)) & 1n) === 1n,
    zapNonceUsed: (dex, nonce) => (((world.zapBits.get(`${dex === 3 ? ZAP_V3 : ZAP_V4}|${owner}|${nonce >> 8n}`) ?? 0n) >> (nonce & 255n)) & 1n) === 1n,
    intentHashOf,
    // The batch path (added 2026-10-02).
    batches,
    /** The next wallet_sendCalls is refused with `code` (4001 the person, 5750 an upgrade declined, 5700 unsupported). */
    declineBatch(code = 4001) { refuseBatch = code; },
    /** wallet_getCallsStatus answers 100 (pending) until `releaseBatches()`. */
    holdBatches() { holdBatch = true; },
    releaseBatches() { holdBatch = false; },
    /** The vault's root reads disarmed from now on (Domino V2 rev2 review, L2). */
    disarm(vault) { disarmedSet.add(lower(vault)); },
  };
}

/**
 * The chain above as a V2Wallet for finance/v2 clients in node: errors thrown as a provider throws them, with an
 * in-memory nonce journal (per chain) and signature journal, both inspectable.
 */
export function walletOf(chain, { current = () => true } = {}) {
  const nonces = new Map();
  const signatures = new Map();
  const claims = [];
  const sigKey = (entry) => `${entry.chainId}|${lower(entry.owner)}|${entry.space}|${lower(entry.verifier)}|${entry.nonce}`;
  return {
    owner: chain.owner,
    current,
    chainId: () => chain.chainNow(),
    claims,
    nonces,
    request: async (method, params) => {
      const reply = await chain.request(method, params);
      if (reply.error) throw Object.assign(new Error(reply.error.message), reply.error);
      return reply.result;
    },
    nonceOffered: (chainId, nonce) => nonces.has(`${chainId}|${nonce}`),
    async claimNonce(chainId, nonce) {
      const key = `${chainId}|${nonce}`;
      if (nonces.has(key)) throw new Error('wallet_nonce_already_offered');
      const token = `claim-${key}`;
      nonces.set(key, token);
      claims.push(['claim', chainId, nonce]);
      return token;
    },
    async releaseRejectedNonce(chainId, nonce, token) {
      const key = `${chainId}|${nonce}`;
      if (nonces.get(key) === token) nonces.delete(key);
      claims.push(['release', chainId, nonce]);
    },
    // Added 2026-10-02 (Domino V2 rev2 review, F3): "I rejected it in my wallet" lets the latch go, whoever holds it.
    async forgetNonce(chainId, nonce) {
      const key = `${chainId}|${nonce}`;
      const had = nonces.has(key);
      nonces.delete(key);
      claims.push(['forget', chainId, nonce]);
      return had;
    },
    signatures: {
      held: (entry) => signatures.has(sigKey(entry)),
      async record(entry) { signatures.set(sigKey(entry), { ...entry }); },
      async forget(entry) { signatures.delete(sigKey(entry)); },
      list: (chainId, owner) => [...signatures.values()].filter((entry) => entry.chainId === chainId && lower(entry.owner) === lower(owner)),
    },
  };
}
