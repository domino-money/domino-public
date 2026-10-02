/**
 * A small Uniswap v3 chain for the chain2 workstream's tests (2026-10-01): pools, a position manager, Domino vaults,
 * ERC-20 tokens, a factory, ArbSys and Multicall3, answering JSON-RPC as an RPC does. Every ABI encoding and decoding
 * here is viem's, so the app's hand-written encoders and decoders (functions/_lib/owned.ts, functions/_lib/uniswap-v3/
 * abi.ts) are checked against an independent implementation, not against themselves.
 */
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, parseAbi, toEventSelector } from 'viem';

export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
export const ARB_SYS = '0x0000000000000000000000000000000000000064';

const MULTICALL_ABI = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
  'function getCurrentBlockTimestamp() view returns (uint256)',
]);
const ARBSYS_ABI = parseAbi(['function arbBlockNumber() view returns (uint256)']);
const ERC20_ABI = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)']);
const POOL_ABI = parseAbi([
  'function factory() view returns (address)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
  'function ticks(int24) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)',
]);
const FACTORY_ABI = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const NFPM_ABI = parseAbi([
  'function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function ownerOf(uint256) view returns (address)',
  'function factory() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)',
]);
const VAULT_ABI = parseAbi([
  'struct Deployment { address factory; address manager; address router; address priceGuard; address wrappedNative; address feeRecipient; bytes32 factoryHash; bytes32 managerHash; bytes32 routerHash; bytes32 guardHash; bytes32 wrappedHash; bytes32 poolHash; bytes32 token0Hash; bytes32 token1Hash; uint8 decimals0; uint8 decimals1; }',
  'function owner() view returns (address)',
  'function pool() view returns (address)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function poolFee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function paused() view returns (bool)',
  'function operator() view returns (address)',
  'function policy() view returns (uint16 serviceFeeBps, uint16 maxPositions, uint16 maxSlippageBps, uint16 maxDeviationBps, uint32 maxObservationAge, uint32 minInterval, uint64 validUntil, bool allowSwap, bool allowSuccessor, int24 successorTickLower, int24 successorTickUpper)',
  'function policyVersion() view returns (uint64)',
  'function deployment() view returns (address factory, address manager, address router, address priceGuard, address wrappedNative, address feeRecipient, bytes32 factoryHash, bytes32 managerHash, bytes32 routerHash, bytes32 guardHash, bytes32 wrappedHash, bytes32 poolHash, bytes32 token0Hash, bytes32 token1Hash, uint8 decimals0, uint8 decimals1)',
  'function positionCount() view returns (uint256)',
  'function positionIds(uint256) view returns (uint256)',
  'function positions(uint256) view returns (bool known, bool active, uint64 generation, uint256 parent, int24 lower, int24 upper, uint128 liquidity, bytes32 identity, bytes32 source0, bytes32 source1)',
  'function capital(address) view returns (uint256)',
]);

export const TOPIC = {
  PoolCreated: toEventSelector('PoolCreated(address,address,uint24,int24,address)'),
  Swap: toEventSelector('Swap(address,address,int256,int256,uint160,uint128,int24)'),
};

const hex = (n) => `0x${BigInt(n).toString(16)}`;
const word = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const lower = (a) => a.toLowerCase();
const ZERO32 = `0x${'0'.repeat(64)}`;

/** An address-like literal for tests: 0x + `n` as 40 hex. */
export const addr = (n) => `0x${BigInt(n).toString(16).padStart(40, '0')}`;

export function fakeV3Chain({ chainId = 99801, head = 2_000_000, timestamp = 1_790_000_000 } = {}) {
  const chain = {
    chainId,
    head,
    timestamp,
    tokens: new Map(),
    pools: new Map(),
    factories: new Map(),
    managers: new Map(),
    vaults: new Map(),
    logs: [],
    receipts: new Map(),
    calls: [],
    /** Called before each request is answered: return a Response to answer it instead (a refusal, an outage). */
    intercept: null,
  };

  chain.token = (address, symbol, decimals) => {
    chain.tokens.set(lower(address), { symbol, decimals, balances: new Map() });
    return lower(address);
  };
  chain.setBalance = (token, holder, amount) => chain.tokens.get(lower(token)).balances.set(lower(holder), BigInt(amount));
  chain.factory = (address) => {
    chain.factories.set(lower(address), { pools: new Map() });
    return lower(address);
  };
  chain.pool = (address, spec) => {
    const pool = { feeProtocol: 0, liquidity: 0n, feeGrowthGlobal0X128: 0n, feeGrowthGlobal1X128: 0n, ticks: new Map(), ...spec, token0: lower(spec.token0), token1: lower(spec.token1), factory: lower(spec.factory) };
    chain.pools.set(lower(address), pool);
    chain.factories.get(pool.factory)?.pools.set(`${pool.token0}:${pool.token1}:${pool.fee}`, lower(address));
    return lower(address);
  };
  chain.tick = (pool, tick, spec) => chain.pools.get(lower(pool)).ticks.set(tick, { liquidityGross: 1n, liquidityNet: 0n, feeGrowthOutside0X128: 0n, feeGrowthOutside1X128: 0n, initialized: true, ...spec });
  chain.manager = (address, factory) => {
    chain.managers.set(lower(address), { factory: lower(factory), positions: new Map(), owners: new Map() });
    return lower(address);
  };
  chain.position = (manager, id, owner, spec) => {
    const m = chain.managers.get(lower(manager));
    m.positions.set(BigInt(id), { nonce: 0n, operator: addr(0), feeGrowthInside0LastX128: 0n, feeGrowthInside1LastX128: 0n, tokensOwed0: 0n, tokensOwed1: 0n, ...spec, token0: lower(spec.token0), token1: lower(spec.token1) });
    m.owners.set(BigInt(id), lower(owner));
  };
  chain.vault = (address, spec) => {
    chain.vaults.set(lower(address), { paused: true, operator: addr(0), policy: null, policyVersion: 0n, positionIds: [], positions: new Map(), capital: new Map(), ...spec, owner: lower(spec.owner), pool: lower(spec.pool) });
    return lower(address);
  };
  chain.log = (log) => chain.logs.push({ blockHash: `0x${word(log.blockNumber)}`, transactionHash: `0x${word(chain.logs.length + 1)}`, transactionIndex: 0, logIndex: chain.logs.length, data: '0x', ...log, address: lower(log.address) });

  function subcall(target, data) {
    const to = lower(target);
    const ok = (returnData) => ({ success: true, returnData });
    const fail = { success: false, returnData: '0x' };
    try {
      if (to === ARB_SYS) return ok(encodeFunctionResult({ abi: ARBSYS_ABI, functionName: 'arbBlockNumber', result: BigInt(chain.head) }));
      if (to === MULTICALL3) {
        const { functionName } = decodeFunctionData({ abi: MULTICALL_ABI, data });
        if (functionName === 'getCurrentBlockTimestamp') return ok(encodeFunctionResult({ abi: MULTICALL_ABI, functionName, result: BigInt(chain.timestamp) }));
        return fail;
      }
      const token = chain.tokens.get(to);
      if (token) {
        const { functionName, args } = decodeFunctionData({ abi: ERC20_ABI, data });
        if (functionName === 'symbol') return token.symbol === null ? fail : ok(encodeFunctionResult({ abi: ERC20_ABI, functionName, result: token.symbol }));
        if (functionName === 'decimals') return ok(encodeFunctionResult({ abi: ERC20_ABI, functionName, result: token.decimals }));
        return ok(encodeFunctionResult({ abi: ERC20_ABI, functionName: 'balanceOf', result: token.balances.get(lower(args[0])) ?? 0n }));
      }
      const pool = chain.pools.get(to);
      if (pool) {
        const { functionName, args } = decodeFunctionData({ abi: POOL_ABI, data });
        const result = {
          factory: () => pool.factory,
          token0: () => pool.token0,
          token1: () => pool.token1,
          fee: () => pool.fee,
          tickSpacing: () => pool.tickSpacing,
          slot0: () => [pool.sqrtPriceX96, pool.tick, 0, 1, 1, pool.feeProtocol, true],
          liquidity: () => pool.liquidity,
          feeGrowthGlobal0X128: () => pool.feeGrowthGlobal0X128,
          feeGrowthGlobal1X128: () => pool.feeGrowthGlobal1X128,
          ticks: () => {
            const t = pool.ticks.get(Number(args[0])) ?? { liquidityGross: 0n, liquidityNet: 0n, feeGrowthOutside0X128: 0n, feeGrowthOutside1X128: 0n, initialized: false };
            return [t.liquidityGross, t.liquidityNet, t.feeGrowthOutside0X128, t.feeGrowthOutside1X128, 0n, 0n, 0, t.initialized];
          },
        }[functionName]();
        return ok(encodeFunctionResult({ abi: POOL_ABI, functionName, result }));
      }
      const factory = chain.factories.get(to);
      if (factory) {
        const { args } = decodeFunctionData({ abi: FACTORY_ABI, data });
        const [a, b] = [lower(args[0]), lower(args[1])].sort();
        return ok(encodeFunctionResult({ abi: FACTORY_ABI, functionName: 'getPool', result: factory.pools.get(`${a}:${b}:${args[2]}`) ?? addr(0) }));
      }
      const manager = chain.managers.get(to);
      if (manager) {
        const { functionName, args } = decodeFunctionData({ abi: NFPM_ABI, data });
        if (functionName === 'factory') return ok(encodeFunctionResult({ abi: NFPM_ABI, functionName, result: manager.factory }));
        if (functionName === 'ownerOf') {
          const owner = manager.owners.get(args[0]);
          return owner ? ok(encodeFunctionResult({ abi: NFPM_ABI, functionName, result: owner })) : fail;
        }
        if (functionName === 'balanceOf') return ok(encodeFunctionResult({ abi: NFPM_ABI, functionName, result: BigInt([...manager.owners.values()].filter((owner) => owner === lower(args[0])).length) }));
        if (functionName === 'tokenOfOwnerByIndex') {
          const ids = [...manager.owners].filter(([, owner]) => owner === lower(args[0])).map(([id]) => id);
          return args[1] < BigInt(ids.length) ? ok(encodeFunctionResult({ abi: NFPM_ABI, functionName, result: ids[Number(args[1])] })) : fail;
        }
        const p = manager.positions.get(args[0]);
        if (!p) return fail;
        return ok(encodeFunctionResult({ abi: NFPM_ABI, functionName: 'positions', result: [p.nonce, p.operator, p.token0, p.token1, p.fee, p.tickLower, p.tickUpper, p.liquidity, p.feeGrowthInside0LastX128, p.feeGrowthInside1LastX128, p.tokensOwed0, p.tokensOwed1] }));
      }
      const vault = chain.vaults.get(to);
      if (vault) {
        const { functionName, args } = decodeFunctionData({ abi: VAULT_ABI, data });
        const d = vault.deployment;
        const result = {
          owner: () => vault.owner,
          pool: () => vault.pool,
          token0: () => vault.token0,
          token1: () => vault.token1,
          poolFee: () => vault.fee,
          tickSpacing: () => vault.tickSpacing,
          paused: () => vault.paused,
          operator: () => vault.operator,
          policy: () => {
            const p = vault.policy;
            if (!p) return [0, 0, 0, 0, 0, 0, 0n, false, false, 0, 0];
            return [p.serviceFeeBps, p.maxPositions, 50, 100, 120, 3600, BigInt(p.validUntil), p.allowSwap, p.allowSuccessor, 0, 0];
          },
          policyVersion: () => vault.policyVersion,
          deployment: () => [d.factory, d.manager, addr(0x70), addr(0x71), addr(0x72), addr(0x73), ZERO32, ZERO32, ZERO32, ZERO32, ZERO32, ZERO32, ZERO32, ZERO32, d.decimals0 ?? 18, d.decimals1 ?? 18],
          positionCount: () => BigInt(vault.positionIds.length),
          positionIds: () => {
            if (args[0] >= BigInt(vault.positionIds.length)) throw new Error('out of range');
            return BigInt(vault.positionIds[Number(args[0])]);
          },
          positions: () => {
            const s = vault.positions.get(BigInt(args[0])) ?? { known: false, active: false, generation: 0n, parent: 0n, lower: 0, upper: 0, liquidity: 0n };
            return [s.known, s.active, s.generation, s.parent, s.lower, s.upper, s.liquidity, ZERO32, ZERO32, ZERO32];
          },
          capital: () => vault.capital.get(lower(args[0])) ?? 0n,
        }[functionName]();
        return ok(encodeFunctionResult({ abi: VAULT_ABI, functionName, result }));
      }
      // An account with no code: the call succeeds with nothing in it, as on a real chain.
      return ok('0x');
    } catch {
      return fail;
    }
  }

  function answerOne(call) {
    const reply = (result) => ({ jsonrpc: '2.0', id: call.id, result });
    switch (call.method) {
      case 'eth_chainId':
        return reply(hex(chain.chainId));
      case 'eth_blockNumber':
        return reply(hex(chain.head));
      case 'eth_getBlockByNumber':
        return reply({ number: hex(chain.head), timestamp: hex(chain.timestamp), hash: `0x${word(chain.head)}` });
      case 'eth_getTransactionReceipt':
        return reply(chain.receipts.get(lower(call.params[0])) ?? null);
      case 'eth_call': {
        const [{ to, data }] = call.params;
        if (lower(to) !== MULTICALL3) return reply(subcall(to, data).returnData);
        const { args } = decodeFunctionData({ abi: MULTICALL_ABI, data });
        const results = args[0].map((sub) => subcall(sub.target, sub.callData));
        return reply(encodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'aggregate3', result: results }));
      }
      case 'eth_getLogs': {
        const filter = call.params[0];
        const from = Number(BigInt(filter.fromBlock));
        const to = Number(BigInt(filter.toBlock));
        if (to > chain.head) return { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'invalid block range params' } };
        const addresses = [filter.address].flat().map(lower);
        const topic0 = [filter.topics?.[0]].flat().filter(Boolean).map(lower);
        const logs = chain.logs.filter((log) => log.blockNumber >= from && log.blockNumber <= to && addresses.includes(log.address) && (topic0.length === 0 || topic0.includes(log.topics[0])));
        return reply(logs.map((log) => ({ ...log, blockNumber: hex(log.blockNumber), transactionIndex: hex(log.transactionIndex), logIndex: hex(log.logIndex) })));
      }
      default:
        return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'method not found' } };
    }
  }

  /** The chain as a client runtime's `send`: one POST, one JSON-RPC answer. */
  chain.send = async (url, init) => {
    const value = JSON.parse(init.body);
    chain.calls.push(value);
    const intercepted = chain.intercept?.(value);
    if (intercepted) return intercepted;
    const body = Array.isArray(value) ? value.map(answerOne) : answerOne(value);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return chain;
}

/** A Swap log's data: the signed amounts, the price after, the liquidity and the tick. */
export const swapData = (amount0, amount1, sqrtPriceX96, liquidity, tick) =>
  encodeAbiParameters([{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }], [BigInt(amount0), BigInt(amount1), BigInt(sqrtPriceX96), BigInt(liquidity), tick]);

/** A PoolCreated log's data: the tick spacing and the pool. */
export const poolCreatedData = (tickSpacing, pool) => encodeAbiParameters([{ type: 'int24' }, { type: 'address' }], [tickSpacing, pool]);
export const topicAddress = (address) => `0x${lower(address).slice(2).padStart(64, '0')}`;
export const topicUint = (n) => `0x${word(n)}`;

/** A client runtime over the fake chain, with a clock that only moves when the client pauses. */
export function fakeRuntime(chain) {
  let now = 1_000_000;
  return {
    send: chain.send,
    now: () => now,
    pause: async (ms) => {
      now += Math.max(1, ms);
    },
    advance: (ms) => (now += ms),
  };
}
