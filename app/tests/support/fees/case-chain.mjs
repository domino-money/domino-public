/**
 * A recorded fees case (tests/support/fees/<id>.json.gz) as the raw chain it
 * was read from (2026-09-25): the public RPC's answers, rebuilt from the
 * case's /state position and its relay units, for the page's own reads of the
 * chain (functions/_lib/fees.ts stateOnChain and logsOnChain, run by
 * src/lib/fees/client.ts in the page and in the replay worker).
 *
 * eth_blockNumber is the case's state block + 2 (the relay reads at head − 2);
 * eth_call to Multicall3 at that block answers the position, its pool, fee
 * growth and tokens as the /state answer recorded them; eth_getLogs answers
 * every recorded log that matches the filter and range asked (the units a
 * relay read are what the pipeline needs, so the same asks find them again);
 * eth_getBlockByNumber answers the recorded grid timestamps and the state
 * block's. Anything else is refused and listed. `fetch(url, init)` takes a
 * POST body as the page sends it and returns the RPC's Response. Not a suite
 * of its own.
 */
import { decodeFunctionData, encodeFunctionResult, numberToHex } from 'viem';
import { erc20Abi, fees, multicallAbi, owned, positionManagerAbi, stateViewAbi } from './fake-chain.mjs';
import { loadCase } from './relay-fixture.mjs';

const TOPICS = [fees.TOPIC.Initialize, fees.TOPIC.ModifyLiquidity, fees.TOPIC.ProtocolFeeUpdated, fees.TOPIC.Swap, fees.TOPIC.Donate, fees.TOPIC.Transfer];

/** A compact log (types.ts CompactLog) as the RPC sent it. */
function rpcOf([block, index, event, tx, topics, data]) {
  return {
    address: event === 5 ? owned.POSITION_MANAGER : fees.POOL_MANAGER,
    topics: [TOPICS[event], ...topics],
    data,
    blockNumber: numberToHex(block),
    logIndex: numberToHex(index),
    transactionHash: tx,
    blockHash: `0x${'cd'.repeat(32)}`,
    transactionIndex: '0x0',
    removed: false,
  };
}

/**
 * The USDG/UFG pools' protocol fee as slot0 packs it (1,000 pips each way, read on 2026-09-25): the recordings predate
 * /state naming it, and the price path needs it in the 4 % pool, where a Swap's fee fits 999 as well as 1,000.
 */
const USDG_UFG = ['0x5fc5360d0400a0fd4f2af552add042d716f1d168', '0xefab538cf3c29237a47c6afb145d50ddf204a0a3'];
export const UFG_PROTOCOL_FEE = 4_097_000;

/**
 * `edit(position)` may change the recorded /state position first (a chain that disagrees with the replay).
 * `quietProbe` (2026-09-25): the page's probe (its five kinds of log) sees the Swaps only, not the pool's liquidity
 * logs, so the exact replay of the recorded pool history is the one chosen (any liquidity log leads to the price path).
 */
export function caseChain(id, { edit = (position) => position, quietProbe = false } = {}) {
  const fixture = loadCase(id);
  const position = edit(structuredClone(fixture.state.positions[0]));
  const block = fixture.state.block;
  const head = block + 2;
  const seen = new Set();
  const all = [];
  for (const log of [...fixture.transfer, ...fixture.initialize, ...Object.values(fixture.pool).flat(), ...Object.values(fixture.swaps).flat(), ...Object.values(fixture.swapBefore).filter(Boolean)]) {
    const key = `${log[0]}:${log[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(rpcOf(log));
  }
  all.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex));
  const headers = { ...fixture.headers, [block]: fixture.state.timestamp };
  const tokens = Object.fromEntries(position.currencies.map((c) => [c.address, c]));
  const key = position.poolKey;
  const info = ((BigInt(position.poolId) >> 56n) << 56n) | (BigInt.asUintN(24, BigInt(position.tickUpper)) << 32n) | (BigInt.asUintN(24, BigInt(position.tickLower)) << 8n);
  const ok = (abi, functionName, result) => ({ success: true, returnData: encodeFunctionResult({ abi, functionName, result }) });
  const revert = { success: false, returnData: '0x' };
  const chain = { id, fixture, head, log: [], refused: [] };

  function view(target, data) {
    if (target === owned.MULTICALL3) return ok(multicallAbi, 'getCurrentBlockTimestamp', BigInt(fixture.state.timestamp));
    if (target === owned.POSITION_MANAGER) {
      const { functionName, args } = decodeFunctionData({ abi: positionManagerAbi, data });
      // 2026-09-25: the page reads each position's feature itself; nothing is subscribed to a recorded case.
      if (functionName === 'subscriber') return ok(positionManagerAbi, functionName, '0x0000000000000000000000000000000000000000');
      if (args[0] !== BigInt(position.tokenId)) return revert;
      if (functionName === 'ownerOf') return ok(positionManagerAbi, functionName, position.owner);
      if (functionName === 'getPositionLiquidity') return ok(positionManagerAbi, functionName, BigInt(position.liquidity));
      return ok(positionManagerAbi, functionName, [key, info]);
    }
    if (target === fees.STATE_VIEW) {
      const { functionName, args } = decodeFunctionData({ abi: stateViewAbi, data });
      if (args[0] !== position.poolId) return revert;
      const protocolFee = key.currency0 === USDG_UFG[0] && key.currency1 === USDG_UFG[1] ? UFG_PROTOCOL_FEE : 0;
      if (functionName === 'getSlot0') return ok(stateViewAbi, functionName, [BigInt(position.sqrtPriceX96), position.tick, protocolFee, key.fee]);
      if (functionName === 'getFeeGrowthInside') return ok(stateViewAbi, functionName, [BigInt(position.feeGrowthInside0X128), BigInt(position.feeGrowthInside1X128)]);
      if (BigInt(args[4]) !== BigInt(position.tokenId)) return revert;
      return ok(stateViewAbi, functionName, [BigInt(position.liquidity), BigInt(position.feeGrowthInside0LastX128), BigInt(position.feeGrowthInside1LastX128)]);
    }
    const token = tokens[target];
    if (!token) return revert;
    const { functionName } = decodeFunctionData({ abi: erc20Abi, data });
    return functionName === 'symbol' ? ok(erc20Abi, 'symbol', token.symbol) : ok(erc20Abi, 'decimals', token.decimals);
  }

  function answer(method, params) {
    if (method === 'eth_blockNumber') return { result: numberToHex(head) };
    if (method === 'eth_getLogs') {
      const [{ address, fromBlock, toBlock, topics }] = params;
      const from = Number(fromBlock);
      const to = Number(toBlock);
      const asked = Array.isArray(topics[0]) ? topics[0] : [topics[0]];
      const first = quietProbe && asked.length === 5 ? asked.filter((topic) => topic === fees.TOPIC.Swap || topic === fees.TOPIC.Donate) : asked;
      // 2026-09-25: the price path's settlements read names the pool's currencies (a recorded case holds none of their
      // Transfers) and places that match any of several topics.
      const addresses = (Array.isArray(address) ? address : [address]).map((one) => one.toLowerCase());
      const match = (want, got) => want == null || (Array.isArray(want) ? want.includes(got) : want === got);
      const hits = all.filter((log) => {
        const at = Number(log.blockNumber);
        return addresses.includes(log.address) && at >= from && at <= to && first.includes(log.topics[0]) && [1, 2, 3].every((i) => match(topics[i], log.topics[i]));
      });
      return { result: hits };
    }
    if (method === 'eth_getBlockByNumber') {
      const at = Number(params[0]);
      return { result: at in headers ? { number: params[0], timestamp: numberToHex(headers[at]), hash: `0x${'ab'.repeat(32)}` } : null };
    }
    if (method === 'eth_call' && params[0]?.to === owned.MULTICALL3 && Number(params[1]) <= head) {
      const { args } = decodeFunctionData({ abi: multicallAbi, data: params[0].data });
      return { result: encodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', result: args[0].map((sub) => view(sub.target.toLowerCase(), sub.callData)) }) };
    }
    chain.refused.push(method);
    return { error: { code: -32601, message: `${method} is not answered here` } };
  }

  chain.fetch = async (url, init) => {
    if (url !== owned.RPC_URL) throw new Error(`not the RPC: ${url}`);
    const body = JSON.parse(init.body);
    const one = (call) => {
      chain.log.push({ method: call.method, params: call.params });
      return { jsonrpc: '2.0', id: call.id, ...answer(call.method, call.params) };
    };
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return chain;
}
