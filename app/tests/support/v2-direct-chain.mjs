/**
 * TEST-ONLY. A browser wallet on a Domino V2 chain that is also the chain behind it, for the direct exits
 * (src/finance/v2/direct.ts, spec F7 §2.6.4): Uniswap's own position managers at the chain profile's addresses, no zap.
 * Nothing here reaches a network.
 *
 *   - v4: the PositionManager (ownerOf, getPoolAndPositionInfo, getPositionLiquidity, modifyLiquidities with
 *     DECREASE_LIQUIDITY + TAKE_PAIR, NotApproved for anyone but the owner, MinimumAmountInsufficient under the
 *     minimums, DeadlinePassed) and the StateView (getSlot0, getPositionInfo, getFeeGrowthInside). TAKE_PAIR pays the
 *     owner: an ERC-20 Transfer log from the PoolManager for a token, no log for native ETH.
 *   - v3: the NonfungiblePositionManager (ownerOf, positions, decreaseLiquidity with "Price slippage check" and
 *     "Transaction too old", collect with its Collect event, multicall), the factory (feeAmountTickSpacing) and the
 *     pool at its CREATE2 address (slot0).
 * The math is V1's (the unit build of finance/position.ts): principal at the price, fees owed from fee growth.
 *
 * The contracts' runtime code here is short invented bytes; `codeHashes` is their keccak256 in the shape of
 * src/v2/chains.ts `verifiedCode`, for a test to pass as the client's `code` (a deployable build refuses that).
 */
import { createRequire } from 'node:module';
import {
  decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, getContractAddress, keccak256, numberToHex,
  parseAbi, toFunctionSelector, concatHex, zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const require = createRequire(import.meta.url);
const position = require('../../.test-build/app/src/finance/position.js');
const abiOf = (name) => require(`../../../api-contracts/v2/abi/${name}.json`).abi;
const PROFILES = {
  4663: require('../../../api-contracts/v2/chains/robinhood-4663.json'),
  8453: require('../../../api-contracts/v2/chains/base-8453.json'),
  42161: require('../../../api-contracts/v2/chains/arbitrum-42161.json'),
};
export const OWNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const lower = (value) => String(value).toLowerCase();
const V4_PM = [...abiOf('IV4PositionManagerMinimal'), ...parseAbi(['function multicall(bytes[] data) payable returns (bytes[] results)'])];
const STATE_VIEW = abiOf('IV4StateViewMinimal');
const V3_NPM = [...abiOf('IUniswapV3PositionManagerMinimal'), ...parseAbi(['function multicall(bytes[] data) payable returns (bytes[] results)'])];
const V3_POOL = abiOf('IUniswapV3PoolMinimal');
const V3_FACTORY = abiOf('IUniswapV3FactoryMinimal');
const EVENTS = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)',
  'event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
]);
const POOL_KEY = [{ type: 'tuple', components: [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
] }];
class Revert extends Error { constructor(data) { super('execution reverted'); this.data = data; } }
const errorData = (signature, types = [], values = []) => (types.length ? concatHex([toFunctionSelector(signature), encodeAbiParameters(types.map((type) => ({ type })), values)]) : toFunctionSelector(signature));
const errorString = (text) => errorData('Error(string)', ['string'], [text]);
const CODE = { v4PositionManager: '0x600460aa', v4StateView: '0x600460bb', v3PositionManager: '0x600360aa', v3Factory: '0x600360bb' };

/**
 * `v4`: [{ tokenId, owner?, pool: { currency0, currency1, fee, tickSpacing, hooks? }, tickLower, tickUpper, liquidity,
 * sqrtPriceX96, tick, growthLast: [g0, g1], growthNow: [g0, g1] }]. `v3`: [{ tokenId, owner?, token0, token1, fee,
 * tickLower, tickUpper, liquidity, sqrtPriceX96, tick, owed: [a0, a1] }]. `refusesEth`: the owner refuses plain ETH.
 */
export function createDirectChain({ chainId = 4663, key = OWNER_KEY, v4 = [], v3 = [], timestamp = 1_790_870_000, refusesEth = false } = {}) {
  const account = privateKeyToAccount(key);
  const owner = lower(account.address);
  const profile = PROFILES[chainId];
  const at = {
    v4PositionManager: lower(profile.uniswap.v4.positionManager), v4StateView: lower(profile.uniswap.v4.stateView), poolManager: lower(profile.uniswap.v4.poolManager),
    v3PositionManager: lower(profile.uniswap.v3.positionManager), v3Factory: lower(profile.uniswap.v3.factory),
  };
  const code = new Map([[at.v4PositionManager, CODE.v4PositionManager], [at.v4StateView, CODE.v4StateView], [at.v3PositionManager, CODE.v3PositionManager], [at.v3Factory, CODE.v3Factory]]);
  const tiers = new Map(Object.entries({ ...profile.uniswap.v3.tickSpacingByFee, ...(chainId === 8453 ? { 200: 4, 300: 6, 400: 8 } : {}) }).map(([fee, spacing]) => [Number(fee), spacing]));
  const poolAddress = (token0, token1, fee) => lower(getContractAddress({ opcode: 'CREATE2', from: profile.uniswap.v3.factory, salt: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }], [token0, token1, fee])), bytecodeHash: profile.uniswap.v3.poolInitCodeHash }));
  let world = {
    eth: new Map([[owner, 10n ** 19n]]),
    tokens: new Map(),
    v4: new Map(v4.map((p) => [BigInt(p.tokenId), { ...p, owner: lower(p.owner ?? owner), pool: { hooks: zeroAddress, ...p.pool, currency0: lower(p.pool.currency0), currency1: lower(p.pool.currency1) }, liquidity: BigInt(p.liquidity), growthLast: p.growthLast.map(BigInt), growthNow: p.growthNow.map(BigInt) }])),
    v3: new Map(v3.map((p) => [BigInt(p.tokenId), { ...p, owner: lower(p.owner ?? owner), token0: lower(p.token0), token1: lower(p.token1), liquidity: BigInt(p.liquidity), owed: p.owed.map(BigInt) }])),
  };
  const pools = new Map(v3.map((p) => [poolAddress(lower(p.token0), lower(p.token1), p.fee), { sqrtPriceX96: BigInt(p.sqrtPriceX96), tick: p.tick }]));
  let clock = timestamp;
  let refuseSend = false;
  const log = [], sends = [], missing = [];
  const hashOf = (index) => numberToHex(0xd1ec7000000n + BigInt(index), { size: 32 });
  const blockOf = (index) => ({ number: numberToHex(0x3000 + index), hash: keccak256(numberToHex(0x3000 + index, { size: 32 })) });
  const now = () => BigInt(clock + 2 * sends.length);
  const poolIdOf = (pool) => keccak256(encodeAbiParameters(POOL_KEY, [{ currency0: pool.currency0, currency1: pool.currency1, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks }]));
  const tokenPay = (w, token, to, amount, logs, from) => {
    if (amount === 0n) return;
    if (token === zeroAddress) {
      if (to === owner && refusesEth) throw new Revert(errorData('NativeTransferFailed()'));
      w.eth.set(to, (w.eth.get(to) ?? 0n) + amount);
      return;
    }
    const balances = w.tokens.get(token) ?? new Map();
    balances.set(to, (balances.get(to) ?? 0n) + amount);
    w.tokens.set(token, balances);
    logs.push({ address: token, topics: encodeEventTopics({ abi: EVENTS, eventName: 'Transfer', args: { from, to } }), data: encodeAbiParameters([{ type: 'uint256' }], [amount]) });
  };

  function v4Manager(ctx, data) {
    const { functionName, args = [] } = decodeFunctionData({ abi: V4_PM, data });
    if (functionName === 'multicall') return encodeFunctionResult({ abi: V4_PM, functionName, result: args[0].map((call) => v4Manager(ctx, call)) });
    const nft = ctx.w.v4.get(args[0]);
    switch (functionName) {
      case 'ownerOf': if (!nft) throw new Revert(errorString('NOT_MINTED')); return encodeFunctionResult({ abi: V4_PM, functionName, result: nft.owner });
      case 'getPositionLiquidity': return encodeFunctionResult({ abi: V4_PM, functionName, result: nft?.liquidity ?? 0n });
      // Rev2 §2.13: the NFT's individual approval and its subscriber (a Domino vault's, for an armed root).
      case 'getApproved': return encodeFunctionResult({ abi: V4_PM, functionName, result: nft?.approved ?? zeroAddress });
      case 'subscriber': return encodeFunctionResult({ abi: V4_PM, functionName, result: nft?.subscriber ?? zeroAddress });
      case 'getPoolAndPositionInfo': {
        if (!nft) return encodeFunctionResult({ abi: V4_PM, functionName, result: [{ currency0: zeroAddress, currency1: zeroAddress, fee: 0, tickSpacing: 0, hooks: zeroAddress }, 0n] });
        const packed = ((BigInt(poolIdOf(nft.pool)) >> 56n) << 56n) | (BigInt.asUintN(24, BigInt(nft.tickUpper)) << 32n) | (BigInt.asUintN(24, BigInt(nft.tickLower)) << 8n);
        return encodeFunctionResult({ abi: V4_PM, functionName, result: [nft.pool, packed] });
      }
      case 'modifyLiquidities': {
        const [unlock, deadline] = args;
        if (now() > deadline) throw new Revert(errorData('DeadlinePassed(uint256)', ['uint256'], [deadline]));
        const [actions, params] = decodeAbiParameters(position.unlockParameters, unlock);
        if (actions !== '0x0111' || params.length !== 2) throw new Error(`unexpected actions ${actions}`);
        const [tokenId, liquidity, min0, min1] = decodeAbiParameters(position.decreaseParameters, params[0]);
        const [c0, c1, recipient] = decodeAbiParameters(position.takePairParameters, params[1]).map(lower);
        const held = ctx.w.v4.get(tokenId);
        if (!held || held.owner !== ctx.from) throw new Revert(errorData('NotApproved(address)', ['address'], [ctx.from]));
        if (c0 !== held.pool.currency0 || c1 !== held.pool.currency1) throw new Error('take pair of another pool');
        const principal = liquidity === 0n ? [0n, 0n] : position.principalAt(held.sqrtPriceX96, held.tick, held.tickLower, held.tickUpper, liquidity);
        if (principal[0] < min0 || principal[1] < min1) throw new Revert(errorData('MinimumAmountInsufficient(uint128,uint128)', ['uint128', 'uint128'], [principal[0] < min0 ? min0 : min1, principal[0] < min0 ? principal[0] : principal[1]]));
        const fees = [0, 1].map((i) => position.feesOwed(held.growthNow[i], held.growthLast[i], held.liquidity));
        held.liquidity -= liquidity;
        held.growthLast = [...held.growthNow];
        tokenPay(ctx.w, c0, recipient, principal[0] + fees[0], ctx.logs, at.poolManager);
        tokenPay(ctx.w, c1, recipient, principal[1] + fees[1], ctx.logs, at.poolManager);
        return '0x';
      }
    }
    throw new Error(`unexpected ${functionName} on the v4 position manager`);
  }

  function stateView(ctx, data) {
    const { functionName, args } = decodeFunctionData({ abi: STATE_VIEW, data });
    const nft = functionName === 'getPositionInfo' ? ctx.w.v4.get(BigInt(args[4])) : [...ctx.w.v4.values()].find((p) => poolIdOf(p.pool) === lower(args[0]));
    if (!nft) throw new Error('unknown pool id');
    if (functionName === 'getSlot0') return encodeFunctionResult({ abi: STATE_VIEW, functionName, result: [nft.sqrtPriceX96, nft.tick, 0, nft.pool.fee] });
    if (functionName === 'getPositionInfo') return encodeFunctionResult({ abi: STATE_VIEW, functionName, result: [nft.liquidity, nft.growthLast[0], nft.growthLast[1]] });
    if (functionName === 'getFeeGrowthInside') return encodeFunctionResult({ abi: STATE_VIEW, functionName, result: [nft.growthNow[0], nft.growthNow[1]] });
    throw new Error(`unexpected ${functionName} on the state view`);
  }

  function v3Manager(ctx, data) {
    const { functionName, args = [] } = decodeFunctionData({ abi: V3_NPM, data });
    if (functionName === 'multicall') {
      const results = args[0].map((call) => v3Manager(ctx, call));
      return encodeFunctionResult({ abi: V3_NPM, functionName, result: results });
    }
    const id = functionName === 'ownerOf' || functionName === 'positions' || functionName === 'getApproved' ? args[0] : args[0].tokenId;
    const nft = ctx.w.v3.get(id);
    if (!nft) throw new Revert(errorString('Invalid token ID'));
    switch (functionName) {
      case 'ownerOf': return encodeFunctionResult({ abi: V3_NPM, functionName, result: nft.owner });
      case 'getApproved': return encodeFunctionResult({ abi: V3_NPM, functionName, result: nft.approved ?? zeroAddress });
      case 'positions': return encodeFunctionResult({ abi: V3_NPM, functionName, result: [0n, zeroAddress, nft.token0, nft.token1, nft.fee, nft.tickLower, nft.tickUpper, nft.liquidity, 0n, 0n, nft.owed[0], nft.owed[1]] });
      case 'decreaseLiquidity': {
        const { liquidity, amount0Min, amount1Min, deadline } = args[0];
        if (nft.owner !== ctx.from) throw new Revert(errorString('Not approved'));
        if (now() > deadline) throw new Revert(errorString('Transaction too old'));
        const price = pools.get(poolAddress(nft.token0, nft.token1, nft.fee));
        const out = position.principalAt(price.sqrtPriceX96, price.tick, nft.tickLower, nft.tickUpper, liquidity);
        if (out[0] < amount0Min || out[1] < amount1Min) throw new Revert(errorString('Price slippage check'));
        nft.liquidity -= liquidity;
        nft.owed = [nft.owed[0] + out[0], nft.owed[1] + out[1]];
        ctx.logs.push({ address: at.v3PositionManager, topics: encodeEventTopics({ abi: EVENTS, eventName: 'DecreaseLiquidity', args: { tokenId: id } }), data: encodeAbiParameters([{ type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }], [liquidity, out[0], out[1]]) });
        return encodeFunctionResult({ abi: V3_NPM, functionName, result: out });
      }
      case 'collect': {
        const { recipient, amount0Max, amount1Max } = args[0];
        if (nft.owner !== ctx.from) throw new Revert(errorString('Not approved'));
        const paid = [nft.owed[0] < amount0Max ? nft.owed[0] : amount0Max, nft.owed[1] < amount1Max ? nft.owed[1] : amount1Max];
        nft.owed = [nft.owed[0] - paid[0], nft.owed[1] - paid[1]];
        const pool = poolAddress(nft.token0, nft.token1, nft.fee);
        tokenPay(ctx.w, nft.token0, lower(recipient), paid[0], ctx.logs, pool);
        tokenPay(ctx.w, nft.token1, lower(recipient), paid[1], ctx.logs, pool);
        ctx.logs.push({ address: at.v3PositionManager, topics: encodeEventTopics({ abi: EVENTS, eventName: 'Collect', args: { tokenId: id } }), data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [lower(recipient), paid[0], paid[1]]) });
        return encodeFunctionResult({ abi: V3_NPM, functionName, result: paid });
      }
    }
    throw new Error(`unexpected ${functionName} on the v3 position manager`);
  }

  async function execute(w, call) {
    const to = lower(call.to);
    const from = lower(call.from ?? zeroAddress);
    const data = call.data ?? call.input ?? '0x';
    const ctx = { w, from, logs: [] };
    if (BigInt(call.value ?? '0x0') > 0n) throw new Revert('0x');
    let result;
    if (data === '0x') {
      if (to === owner && refusesEth) throw new Revert('0x');
      result = '0x';
    } else if (to === at.v4PositionManager) result = v4Manager(ctx, data);
    else if (to === at.v4StateView) result = stateView(ctx, data);
    else if (to === at.v3PositionManager) result = v3Manager(ctx, data);
    else if (to === at.v3Factory) {
      const { functionName, args } = decodeFunctionData({ abi: V3_FACTORY, data });
      result = encodeFunctionResult({ abi: V3_FACTORY, functionName, result: tiers.get(args[0]) ?? 0 });
    } else if (pools.has(to)) {
      const price = pools.get(to);
      result = encodeFunctionResult({ abi: V3_POOL, functionName: 'slot0', result: [price.sqrtPriceX96, price.tick, 0, 0, 0, 0, true] });
    } else throw new Error(`no contract at ${to}`);
    return { result, logs: ctx.logs };
  }

  let current = chainId;
  async function request(method, params = []) {
    log.push(method);
    if (current !== chainId && !['eth_accounts', 'eth_chainId', 'wallet_switchEthereumChain'].includes(method)) return { error: { code: -32000, message: `${method} on chain ${current}` } };
    try {
      switch (method) {
        case 'eth_accounts': return { result: [owner] };
        case 'eth_chainId': return { result: numberToHex(current) };
        case 'eth_getCode': return { result: code.get(lower(params[0])) ?? '0x' };
        case 'eth_gasPrice': return { result: '0x5f5e100' };
        // Added 2026-10-02 (S1 review F8): Base orders by priority fee, so a budget read there asks for one.
        case 'eth_maxPriorityFeePerGas': return { result: '0xf4240' };
        case 'eth_getTransactionCount': return { result: numberToHex(sends.length) };
        case 'eth_getBalance': return { result: numberToHex(world.eth.get(lower(params[0])) ?? 0n) };
        // Base's GasPriceOracle predeploy (post-B4 review F5): getL1FeeUpperBound(size) answers a fixed ceiling, 7 gwei.
        case 'eth_call': if (lower(params[0].to) === '0x420000000000000000000000000000000000000f' && String(params[0].data).startsWith('0xf1c7a58b')) return { result: `0x${(7_000_000_000n).toString(16).padStart(64, '0')}` };
          return { result: (await execute(structuredClone(world), params[0])).result };
        case 'eth_estimateGas': await execute(structuredClone(world), params[0]); return { result: '0x3a980' };
        case 'eth_sendTransaction': {
          const tx = params[0];
          if (lower(tx.from) !== owner) return { error: { code: 4100, message: 'Unauthorized' } };
          if (BigInt(tx.chainId) !== BigInt(current)) return { error: { code: -32000, message: 'wrong chain' } };
          if (refuseSend) { refuseSend = false; return { error: { code: 4001, message: 'User rejected the request.' } }; }
          const next = structuredClone(world);
          let status = '0x1', logs = [];
          try { ({ logs } = await execute(next, tx)); world = next; } catch (error) { if (!(error instanceof Revert)) throw error; status = '0x0'; }
          sends.push({ tx, status, logs });
          return { result: hashOf(sends.length - 1) };
        }
        case 'eth_getTransactionByHash': case 'eth_getTransactionReceipt': {
          const index = sends.findIndex((_, i) => hashOf(i) === lower(params[0]));
          if (index === -1) return { result: null };
          const { tx, status, logs } = sends[index];
          const block = { blockHash: blockOf(index).hash, blockNumber: blockOf(index).number };
          if (method === 'eth_getTransactionByHash') return { result: { hash: hashOf(index), from: tx.from, to: tx.to, input: tx.data, value: tx.value, nonce: tx.nonce, ...block } };
          return { result: { transactionHash: hashOf(index), from: tx.from, to: tx.to, status, gasUsed: '0x3a980', effectiveGasPrice: '0x5f5e100', ...block, ...(chainId === 8453 ? { l1Fee: '0x2a' } : {}),
            logs: logs.map((entry, i) => ({ address: entry.address, topics: entry.topics, data: entry.data, logIndex: numberToHex(i), ...block })) } };
        }
        case 'eth_getBlockByNumber': {
          if (params[0] === 'latest') return { result: { number: numberToHex(0x1000 + sends.length), timestamp: numberToHex(now()), hash: keccak256(numberToHex(0x1000 + sends.length, { size: 32 })) } };
          if (params[0] === 'finalized') return { result: { number: '0xffffff', hash: keccak256('0xf1') } };
          const index = Number(BigInt(params[0])) - 0x3000;
          if (index >= 0 && index < sends.length) return { result: blockOf(index) };
          return { result: { number: params[0], timestamp: numberToHex(now()), hash: keccak256(numberToHex(Number(BigInt(params[0])), { size: 32 })) } };
        }
      }
    } catch (error) {
      if (error instanceof Revert) return { error: { code: 3, message: 'execution reverted', data: error.data } };
      missing.push(String(error));
      return { error: { code: -32000, message: String(error) } };
    }
    return { error: { code: 4200, message: `${method} is not supported` } };
  }

  return {
    owner, chainId, at, log, sends, missing, request,
    codeHashes: Object.freeze(Object.fromEntries(Object.entries(CODE).map(([name, bytes]) => [name, keccak256(bytes)]))),
    chainNow: () => current,
    switchTo(id) { current = id; },
    decline() { refuseSend = true; },
    warp(seconds) { clock += seconds; },
    setCode(address, bytes) { code.set(lower(address), bytes); },
    v4Position: (tokenId) => world.v4.get(BigInt(tokenId)),
    v3Position: (tokenId) => world.v3.get(BigInt(tokenId)),
    balanceOf: (token, who = owner) => (lower(token) === zeroAddress ? world.eth.get(lower(who)) ?? 0n : world.tokens.get(lower(token))?.get(lower(who)) ?? 0n),
    poolAddress,
  };
}
