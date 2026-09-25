/**
 * A recorded busy pool (tests/support/fees/path-*.json.gz) as the raw chain it
 * was read from (2026-09-25), for the price path in the browser: the page's
 * own reads and its replay worker's, with its paced lane and its CSP.
 *
 * The NFT is shown as of `top` (a block on the recording's hourly grid, so its
 * time is a recorded header): its pool's price and tick then are its last
 * Swap's, its unclaimed fees the price path's up to it (checked against the
 * chain's own figures at the recording's block in tests/fees-path.test.mjs),
 * held with a fee growth that gives v4's own unclaimed figure. eth_getLogs
 * answers what the recording holds (the NFT's Transfers, the pool's
 * Initialize, its Swaps and the NFT's own ModifyLiquidity), and nothing for the
 * pool's currencies' Transfers (the owner was never paid by the PoolManager);
 * eth_getBlockByNumber the recorded hourly headers. Anything else is refused
 * and listed. `limit` (2026-09-25, review) limits one address as the RPC does,
 * as browserChain's does (browser-chain.mjs): a budget of reply bytes
 * (`capacity`, refilled at `perSecond`) a reply may overdraw, every request
 * refused with an unreadable 429 while it is spent, listed in `refusals`.
 * Not a suite of its own.
 */
import { createRequire } from 'node:module';
import { decodeFunctionData, encodeFunctionResult, numberToHex } from 'viem';
import { erc20Abi, fees, multicallAbi, owned, positionManagerAbi, stateViewAbi } from './fake-chain.mjs';
import { loadPath } from './path-fixture.mjs';

const require = createRequire(import.meta.url);
const { FeeReplay, Timeline } = require('../../../.test-build/app/src/lib/fees/replay.js');

const TOPICS = [fees.TOPIC.Initialize, fees.TOPIC.ModifyLiquidity, fees.TOPIC.ProtocolFeeUpdated, fees.TOPIC.Swap, fees.TOPIC.Donate, fees.TOPIC.Transfer];
const Q128 = 1n << 128n;
const word = (data, i) => BigInt(`0x${data.slice(2 + i * 64, 66 + i * 64)}`);

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

/** NFT `id` of the recorded pool `name`, as of `top` (a block of the recording's hourly grid). */
export function pathChain(name, id, top, { limit = null } = {}) {
  const fixture = loadPath(name);
  const recorded = fixture.positions[id].state.positions[0];
  if (!(top in fixture.headers)) throw new Error(`block ${top} is not on the recorded grid`);
  const mint = fixture.positions[id].mintBlock;
  const salt = BigInt(id);
  const own = (log) => log[2] === 1 && word(log[5], 3) === salt;
  const life = fixture.logs.filter((log) => log[0] <= top && (log[2] !== 1 || own(log)));
  // The NFT as of `top`: the price path's own figures (the replay the worker runs, from the Swap before the mint).
  const init = fixture.initialize[5];
  const replay = FeeReplay.start({ tokenId: salt, tickLower: recorded.tickLower, tickUpper: recorded.tickUpper, tickSpacing: Number(BigInt.asIntN(24, word(init, 1))), fee: Number(word(init, 0)), path: true, protocolFee: recorded.protocolFee }, 0n, 0);
  const timeline = new Timeline(Object.entries(fixture.headers).map(([block, t]) => [Number(block), t]));
  const before = life.filter((log) => log[2] === 3 && log[0] < mint).at(-1);
  for (const log of [before, ...life.filter((log) => log[0] >= mint)]) replay.apply(log, timeline);
  const unclaimed = replay.owed();
  const liquidity = BigInt(recorded.liquidity);
  const inside = unclaimed.map((u) => (u * Q128 + liquidity - 1n) / liquidity);
  const pool = replay.pool();
  const position = { ...recorded, sqrtPriceX96: String(pool.price), tick: pool.tick, unclaimed0: String(unclaimed[0]), unclaimed1: String(unclaimed[1]) };
  const logs = [...life, ...fixture.positions[id].transfer, fixture.initialize].map(rpcOf);
  const head = top + 2;
  const tokens = Object.fromEntries(position.currencies.map((c) => [c.address, c]));
  const key = position.poolKey;
  const info = ((BigInt(position.poolId) >> 56n) << 56n) | (BigInt.asUintN(24, BigInt(position.tickUpper)) << 32n) | (BigInt.asUintN(24, BigInt(position.tickLower)) << 8n);
  const ok = (abi, functionName, result) => ({ success: true, returnData: encodeFunctionResult({ abi, functionName, result }) });
  const revert = { success: false, returnData: '0x' };
  const chain = { id, head, top, unclaimed, limit, log: [], refused: [], refusals: [] };

  function view(target, data) {
    if (target === owned.MULTICALL3) return ok(multicallAbi, 'getCurrentBlockTimestamp', BigInt(fixture.headers[top]));
    if (target === owned.POSITION_MANAGER) {
      const { functionName, args } = decodeFunctionData({ abi: positionManagerAbi, data });
      if (functionName === 'subscriber') return ok(positionManagerAbi, functionName, '0x0000000000000000000000000000000000000000');
      if (args[0] !== salt) return revert;
      if (functionName === 'ownerOf') return ok(positionManagerAbi, functionName, position.owner);
      if (functionName === 'getPositionLiquidity') return ok(positionManagerAbi, functionName, liquidity);
      return ok(positionManagerAbi, functionName, [key, info]);
    }
    if (target === fees.STATE_VIEW) {
      const { functionName, args } = decodeFunctionData({ abi: stateViewAbi, data });
      if (args[0] !== position.poolId) return revert;
      if (functionName === 'getSlot0') return ok(stateViewAbi, functionName, [pool.price, pool.tick, position.protocolFee, key.fee]);
      if (functionName === 'getFeeGrowthInside') return ok(stateViewAbi, functionName, inside);
      if (BigInt(args[4]) !== salt) return revert;
      return ok(stateViewAbi, functionName, [liquidity, 0n, 0n]);
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
      const addresses = (Array.isArray(address) ? address : [address]).map((one) => one.toLowerCase());
      const from = Number(fromBlock);
      const to = Number(toBlock);
      const first = Array.isArray(topics[0]) ? topics[0] : [topics[0]];
      const match = (want, got) => want == null || (Array.isArray(want) ? want.includes(got) : want === got);
      return { result: logs.filter((log) => addresses.includes(log.address) && Number(log.blockNumber) >= from && Number(log.blockNumber) <= Math.min(to, top) && first.includes(log.topics[0]) && [1, 2, 3].every((i) => match(topics[i], log.topics[i]))) };
    }
    if (method === 'eth_getBlockByNumber') {
      const at = Number(params[0]);
      return { result: at in fixture.headers ? { number: params[0], timestamp: numberToHex(fixture.headers[at]), hash: `0x${'ab'.repeat(32)}` } : null };
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
    const budget = chain.limit;
    if (budget) {
      const now = Date.now();
      budget.tokens = Math.min(budget.capacity, (budget.tokens ?? budget.capacity) + ((now - (budget.at ?? now)) * budget.perSecond) / 1000);
      budget.at = now;
      if (budget.tokens <= 0) {
        chain.refusals.push({ at: now, method: (Array.isArray(body) ? body[0] : body).method });
        return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: 429, message: 'Too Many Requests' } }), { status: 429, headers: { 'Content-Type': 'application/json', 'access-control-allow-origin': '*,*' } });
      }
    }
    const one = (call) => {
      const entry = { method: call.method, params: call.params, at: Date.now() };
      chain.log.push(entry);
      const reply = { jsonrpc: '2.0', id: call.id, ...answer(call.method, call.params) };
      entry.bytes = JSON.stringify(reply).length;
      return reply;
    };
    const text = JSON.stringify(Array.isArray(body) ? body.map(one) : one(body));
    if (budget) budget.tokens -= text.length;
    return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return chain;
}
