/**
 * Robinhood Chain's public RPC as the browser suites answer it (2026-09-25).
 *
 * Since the RPC rate-limits Cloudflare's edge, the page reads the chain
 * itself: the wallet's Domino positions (functions/_lib/walletPositions.ts
 * scanWallet), a position's state and the fees history's logs
 * (functions/_lib/fees.ts), all through src/lib/chain/browser.ts's one fetch
 * of https://rpc.mainnet.chain.robinhood.com. A browser context of a suite
 * gets that host answered here with routeChain(), so no suite reaches the
 * network, and the page's CSP (which must name the host) is exercised as in
 * production: a request the CSP refused never reaches the route.
 *
 * browserChain() is a small chain described the way the screens show it: the
 * wallet's positions (who holds each, its pool key, range, liquidity and the
 * unclaimed fees the chain must report), the pools' prices, the tokens, and
 * the deposits DominoSetupV1 holds for an owner. It answers only the methods
 * the page may ask (eth_blockNumber, eth_getLogs, eth_call to Multicall3 and
 * batched eth_getBlockByNumber) and keeps what it was asked; a sub-call no
 * contract here answers reverts, and is listed in `missing`. With nothing
 * described it is an empty chain: no position, no deposit, every NFT
 * unknown. `outage` answers every request with that HTTP status while set (or,
 * a function of the request's first call, the status to answer it with, or null).
 *
 * Added with the review of 2026-09-25: `history(filter, from, to)` answers the
 * fees logs a position's replay asks (busyHistory() below: a pool whose
 * liquidity history is long, as PONS/USDG's is), and `limit` makes the chain
 * refuse as the public RPC does from one address: a budget of reply bytes
 * (`capacity`, refilled at `perSecond`) that a reply may overdraw; while it is
 * spent every request is refused with a 429 whose
 * `access-control-allow-origin: *,*` a browser cannot read, as the RPC sends
 * it. Refused requests are listed in `refusals`.
 * Not a suite of its own.
 */
import { createRequire } from 'node:module';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, keccak256, numberToHex, pad, parseAbi } from 'viem';

const require = createRequire(import.meta.url);
const owned = require('../../.test-build/app/functions/_lib/owned.js');
const fees = require('../../.test-build/app/functions/_lib/fees.js');
const automation = require('../../.test-build/app/functions/_lib/automation.js');

export const RPC_URL = owned.RPC_URL;
/** DominoSetupV1's SetupMinted topic: the wallet's list is read from these logs. */
export const SETUP_MINTED_TOPIC = owned.SETUP_MINTED_TOPIC;
/** The RPC's URL as the page asks it, and nothing else. */
const RPC_ROUTE = /^https:\/\/rpc\.mainnet\.chain\.robinhood\.com\/?$/;
const ZERO = '0x0000000000000000000000000000000000000000';
const PM = owned.POSITION_MANAGER;
const SETUP = owned.SETUP_CONTRACT;
const MULTICALL3 = owned.MULTICALL3;
const STATE_VIEW = fees.STATE_VIEW;

const multicallAbi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
  'function getCurrentBlockTimestamp() view returns (uint256)',
]);
const pmAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'function ownerOf(uint256) view returns (address)',
  'function getPositionLiquidity(uint256) view returns (uint128)',
  'function getPoolAndPositionInfo(uint256) view returns (PoolKey, uint256)',
  'function subscriber(uint256) view returns (address)',
]);
// 2026-09-25: a position's feature, read by the page itself (functions/_lib/automation.ts scanAutomation): the NFT's
// subscriber, and when it is a vault, the factory's isVault and the vault's root, policy and permission.
const SEQUENCE_FACTORY = automation.SEQUENCE_FACTORY;
const factoryAbi = parseAbi(['function isVault(address) view returns (bool)']);
const vaultAbi = parseAbi([
  'struct Policy { uint16 serviceFeeBps; uint16 triggerDistanceBps; uint16 maxOverlapBps; uint32 minimumIntervalSeconds; uint8 maxPositions; uint64 version; bool paused; }',
  'function rootTokenId() view returns (uint256)',
  'function policy() view returns (Policy)',
  'function rootPermissionValid() view returns (bool)',
]);
const stateViewAbi = parseAbi([
  'function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getFeeGrowthInside(bytes32, int24, int24) view returns (uint256, uint256)',
  'function getPositionInfo(bytes32, address, int24, int24, bytes32) view returns (uint128 liquidity, uint256, uint256)',
]);
const erc20Abi = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
const setupAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct Operation { address owner; PoolKey key; uint128 balance0; uint128 balance1; bool swapped; bool closed; uint256 tokenId; }',
  'function ownerNonce(address) view returns (uint64)',
  'function operation(bytes32) view returns (Operation)',
  'function recoveryStarted(bytes32) view returns (bool)',
]);

export const poolIdOf = (key) =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
export const opIdOf = (owner, nonce) => keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint64' }], [4663n, SETUP, owner, BigInt(nonce)]));
const packInfo = (poolId, tickLower, tickUpper) => ((BigInt(poolId) >> 56n) << 56n) | (BigInt.asUintN(24, BigInt(tickUpper)) << 32n) | (BigInt.asUintN(24, BigInt(tickLower)) << 8n);
/** Every range's fee growth inside: large, so each position's last growth sits below it by exactly its unclaimed fees. */
const GROWTH = 1n << 200n;
const Q128 = 1n << 128n;
/** The growth a position of liquidity `l` needs since its last settlement for v4 to owe it exactly `owed`. */
const needed = (owed, l) => (l === 0n ? 0n : (BigInt(owed) * Q128 + l - 1n) / l);

/**
 * `positions`: [{ tokenId, holder, minter (holder unless said), key, tickLower, tickUpper, liquidity, unclaimed: [a, b],
 * burned, mintBlock, from, subscriber }] where `from` is how many times ownerOf must have been asked before the NFT
 * exists (a mint the chain has not shown yet) and `subscriber` its PositionManager subscriber (none unless said).
 * `pools`: per pool id { sqrtPriceX96, tick }; a position's pool not named sits at tick 0. `tokens`: per address
 * { symbol, decimals }. `deposits`: per owner [{ key, balance0, balance1, closed }], held by DominoSetupV1 (the n-th is
 * the owner's operation n). `vaults`: per lowercase address { root, feeBps, paused, valid, made }: a sequence vault
 * Domino's factory made (made: false, one it did not), for the automation read.
 */
export function browserChain({ head = 71_700_000, timestamp = 1_790_000_000, positions = [], pools = {}, tokens = {}, deposits = {}, vaults = {}, history = null, limit = null } = {}) {
  const chain = { head, timestamp, positions, pools, tokens, deposits, vaults, history, limit, outage: null, log: [], missing: [], refused: [], refusals: [], asked: new Map() };
  const lower = (value) => String(value).toLowerCase();
  const position = (id) => chain.positions.find((p) => String(p.tokenId) === String(id));
  const ok = (abi, functionName, result) => ({ success: true, returnData: encodeFunctionResult({ abi, functionName, result }) });
  const revert = { success: false, returnData: '0x' };
  const poolOf = (id) => chain.pools[id] ?? { sqrtPriceX96: 2n ** 96n, tick: 0 };
  const known = (p) => p && !p.burned && (chain.asked.get(String(p.tokenId)) ?? 0) > (p.from ?? 0);

  function view(target, data) {
    if (target === PM) {
      const { functionName, args } = decodeFunctionData({ abi: pmAbi, data });
      const p = position(args[0]);
      // A mapping: any id answers, the zero address when nothing is subscribed.
      if (functionName === 'subscriber') return ok(pmAbi, functionName, (known(p) && p.subscriber) || ZERO);
      if (!known(p)) return revert;
      if (functionName === 'ownerOf') return ok(pmAbi, functionName, p.holder);
      if (functionName === 'getPositionLiquidity') return ok(pmAbi, functionName, BigInt(p.liquidity));
      return ok(pmAbi, functionName, [p.key, packInfo(poolIdOf(p.key), p.tickLower, p.tickUpper)]);
    }
    if (target === STATE_VIEW) {
      const { functionName, args } = decodeFunctionData({ abi: stateViewAbi, data });
      const used = chain.positions.some((p) => poolIdOf(p.key) === args[0]) || args[0] in chain.pools;
      if (!used) return revert;
      if (functionName === 'getSlot0') {
        const pool = poolOf(args[0]);
        return ok(stateViewAbi, functionName, [BigInt(pool.sqrtPriceX96), pool.tick, 0, 3000]);
      }
      if (functionName === 'getFeeGrowthInside') return ok(stateViewAbi, functionName, [GROWTH, GROWTH]);
      const p = position(BigInt(args[4]));
      if (!p || lower(args[1]) !== PM) return revert;
      const l = BigInt(p.liquidity);
      const [a, b] = p.unclaimed ?? [0n, 0n];
      return ok(stateViewAbi, functionName, [l, GROWTH - needed(a, l), GROWTH - needed(b, l)]);
    }
    if (target === SETUP) {
      const { functionName, args } = decodeFunctionData({ abi: setupAbi, data });
      if (functionName === 'ownerNonce') return ok(setupAbi, functionName, BigInt((chain.deposits[lower(args[0])] ?? []).length));
      if (functionName === 'recoveryStarted') return ok(setupAbi, functionName, false);
      for (const [owner, list] of Object.entries(chain.deposits)) {
        const i = list.findIndex((_, n) => opIdOf(owner, n) === args[0]);
        if (i >= 0) return ok(setupAbi, functionName, { owner, key: list[i].key, balance0: BigInt(list[i].balance0), balance1: BigInt(list[i].balance1), swapped: false, closed: list[i].closed === true, tokenId: 0n });
      }
      return ok(setupAbi, functionName, { owner: ZERO, key: { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO }, balance0: 0n, balance1: 0n, swapped: false, closed: false, tokenId: 0n });
    }
    if (target === MULTICALL3) return ok(multicallAbi, 'getCurrentBlockTimestamp', BigInt(chain.timestamp));
    if (target === SEQUENCE_FACTORY) {
      const { functionName, args } = decodeFunctionData({ abi: factoryAbi, data });
      const vault = chain.vaults[lower(args[0])];
      return ok(factoryAbi, functionName, !!vault && vault.made !== false);
    }
    const vault = chain.vaults[target];
    if (vault) {
      const { functionName } = decodeFunctionData({ abi: vaultAbi, data });
      if (functionName === 'rootTokenId') return ok(vaultAbi, functionName, BigInt(vault.root));
      if (functionName === 'rootPermissionValid') return ok(vaultAbi, functionName, vault.valid !== false);
      return ok(vaultAbi, functionName, { serviceFeeBps: vault.feeBps, triggerDistanceBps: 500, maxOverlapBps: 2000, minimumIntervalSeconds: 3600, maxPositions: vault.feeBps === 200 ? 1 : 3, version: 1n, paused: vault.paused === true });
    }
    const token = chain.tokens[target];
    if (token) {
      const { functionName } = decodeFunctionData({ abi: erc20Abi, data });
      return ok(erc20Abi, functionName, functionName === 'symbol' ? token.symbol : token.decimals);
    }
    chain.missing.push(`${target} ${data.slice(0, 10)}`);
    return revert;
  }

  function answer(method, params) {
    if (method === 'eth_blockNumber') return { result: numberToHex(chain.head) };
    if (method === 'eth_getLogs') {
      const [filter] = params;
      const from = Number(filter.fromBlock);
      const to = Number(filter.toBlock);
      const logs = chain.history?.(filter, from, to);
      if (logs) return { result: logs };
      if (lower(filter.address) !== SETUP || filter.topics?.[0] !== owned.SETUP_MINTED_TOPIC) return { result: [] };
      const owner = lower(filter.topics[2]);
      const minted = chain.positions
        .map((p, i) => ({ p, block: p.mintBlock ?? chain.head - 1000 * (chain.positions.length - i) }))
        .filter(({ p, block }) => pad(lower(p.minter ?? p.holder)) === owner && block >= from && block <= to)
        .sort((a, b) => a.block - b.block);
      return {
        result: minted.map(({ p, block }, i) => ({
          address: SETUP,
          blockNumber: numberToHex(block),
          logIndex: numberToHex(i),
          transactionHash: `0x${block.toString(16).padStart(64, '0')}`,
          topics: [owned.SETUP_MINTED_TOPIC, pad(numberToHex(BigInt(p.tokenId) * 7n + 1n)), owner, pad(numberToHex(BigInt(p.tokenId)))],
          data: encodeAbiParameters([{ type: 'uint128' }, { type: 'uint128' }, { type: 'uint128' }], [1n, 2n, 3n]),
          removed: false,
        })),
      };
    }
    if (method === 'eth_getBlockByNumber') return { result: { number: params[0], timestamp: numberToHex(chain.timestamp), hash: `0x${'ab'.repeat(32)}` } };
    if (method === 'eth_call' && lower(params[0]?.to) === MULTICALL3 && Number(params[1]) <= chain.head) {
      const { args } = decodeFunctionData({ abi: multicallAbi, data: params[0].data });
      // One more read of each NFT this call asks ownerOf for, before any of its sub-calls is answered.
      for (const sub of args[0]) {
        if (lower(sub.target) !== PM || !sub.callData.startsWith('0x6352211e')) continue;
        const id = String(BigInt(`0x${sub.callData.slice(10)}`));
        chain.asked.set(id, (chain.asked.get(id) ?? 0) + 1);
      }
      return { result: encodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', result: args[0].map((sub) => view(lower(sub.target), sub.callData)) }) };
    }
    chain.refused.push(method);
    return { error: { code: -32601, message: `${method} is not answered here` } };
  }

  /** The RPC's reply to one POST body (a call or a batch), as a Response. */
  chain.fetch = async (url, init) => {
    if (url !== RPC_URL) throw new Error(`not the RPC: ${url}`);
    const body = JSON.parse(init.body);
    const status = typeof chain.outage === 'function' ? chain.outage(Array.isArray(body) ? body[0] : body) : chain.outage;
    if (status) return new Response(status === 429 ? 'Too Many Requests' : 'Unavailable', { status });
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
      // 2026-09-25: the size of each call's reply, for the tests that hold the fees lane to its pace.
      entry.bytes = JSON.stringify(reply).length;
      return reply;
    };
    const text = JSON.stringify(Array.isArray(body) ? body.map(one) : one(body));
    if (budget) budget.tokens -= text.length;
    return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  /** How many times the wallet's SetupMinted logs were asked for `owner`: one per read of its list. */
  chain.scans = (owner) => chain.log.filter((entry) => entry.method === 'eth_getLogs' && entry.params[0].topics?.[2] === pad(lower(owner))).length;
  return chain;
}

/**
 * Answers the RPC for every page of `context` from `chain` (an empty chain unless one is given), CORS included, as the
 * public RPC does (any origin, POST, content-type). A reply that throws is a 500 and is kept in `chain.errors`.
 */
export async function routeChain(context, chain = browserChain()) {
  chain.errors ??= [];
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
  await context.route(RPC_ROUTE, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    try {
      const reply = await chain.fetch(RPC_URL, { method: request.method(), body: request.postData() ?? '' });
      // A reply may carry its own allow-origin (the RPC's refusal: `*,*`, which a browser refuses to read).
      const origin = reply.headers.get('access-control-allow-origin');
      return route.fulfill({ status: reply.status, headers: { ...cors, ...(origin ? { 'access-control-allow-origin': origin } : {}), 'content-type': reply.headers.get('content-type') ?? 'text/plain' }, body: await reply.text() });
    } catch (error) {
      chain.errors.push(String(error?.stack ?? error));
      return route.fulfill({ status: 500, headers: cors, body: '' });
    }
  });
  return chain;
}

/**
 * The fees logs of one position in a busy pool, for browserChain's `history`
 * (2026-09-25): the NFT's mint Transfer to `owner`, the pool's Initialize
 * `epochs` pool epochs back, and `perEpoch` ModifyLiquidity logs of other
 * accounts in every epoch since (about 700 bytes each as the RPC sends them),
 * so the replay reads the pool's epochs for a while. No Swap: the replay never
 * gets that far in the tests that use it. `recent` more ModifyLiquidity logs
 * in the pool's last few hundred blocks make it a pool busy now, whose
 * history the page's probe (functions/_lib/fees.ts PROBE_SPAN) projects far
 * past any budget. `quietProbe` hides the history from the probe (see below).
 */
export function busyHistory({ tokenId, key, owner, head = 71_700_000, epochs = 12, perEpoch = 400, recent = 0, quietProbe = false }) {
  const EPOCH = fees.EPOCH_SPAN;
  const poolId = poolIdOf(key);
  const word = (value) => pad(numberToHex(BigInt.asUintN(256, BigInt(value))), { size: 32 });
  const mintBlock = head - 5_000;
  const initBlock = (Math.floor(head / EPOCH) - epochs + 1) * EPOCH + 7;
  const step = Math.floor(EPOCH / perEpoch);
  const logOf = (address, topics, data, block) => ({
    address,
    topics,
    data,
    blockNumber: numberToHex(block),
    logIndex: '0x0',
    transactionHash: word(block),
    blockHash: `0x${'ab'.repeat(32)}`,
    transactionIndex: '0x0',
    removed: false,
  });
  const someone = pad('0x7777777777777777777777777777777777777777');
  const data = (...words) => `0x${words.map((w) => w.slice(2)).join('')}`;
  const modify = (block) => logOf(fees.POOL_MANAGER, [fees.TOPIC.ModifyLiquidity, poolId, someone], data(word(-600), word(600), word(1000n), word(block)), block);
  return (filter, from, to) => {
    const address = String(filter.address).toLowerCase();
    const topics = filter.topics ?? [];
    const first = [topics[0]].flat();
    if (address === PM && first.includes(fees.TOPIC.Transfer) && topics[3] === word(tokenId))
      return mintBlock >= from && mintBlock <= to ? [logOf(PM, [fees.TOPIC.Transfer, word(0), pad(owner.toLowerCase()), word(tokenId)], '0x', mintBlock)] : [];
    if (address !== fees.POOL_MANAGER || topics[1] !== poolId) return null;
    const out = [];
    if (first.includes(fees.TOPIC.Initialize) && initBlock >= from && initBlock <= to)
      out.push(logOf(fees.POOL_MANAGER, [fees.TOPIC.Initialize, poolId, pad(key.currency0), pad(key.currency1)], data(word(key.fee), word(key.tickSpacing), word(0), word(2n ** 96n), word(0)), initBlock));
    // `quietProbe` (2026-09-25): the page's probe (its five kinds of log) sees none of this history, a burst its samples
    // miss, so the exact replay of the pool's history is the one chosen (any liquidity log in a sample leads to the
    // price path, pipeline.ts) and the tests that pace a long read of epochs still read them.
    if (first.includes(fees.TOPIC.ModifyLiquidity) && !(quietProbe && first.length === 5)) {
      // Every `step` blocks from the Initialize on, within the range asked.
      const start = Math.max(from, initBlock + 1);
      for (let block = start + ((step - ((start - initBlock - 1) % step)) % step); block <= Math.min(to, head); block += step) out.push(modify(block));
      for (let i = 0; i < recent; i++) {
        const block = head - 1 - 7 * i;
        if (block >= from && block <= to && (block - initBlock - 1) % step !== 0) out.push(modify(block));
      }
      out.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));
    }
    return out;
  };
}
