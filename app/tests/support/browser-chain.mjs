/**
 * Robinhood Chain as the browser suites answer it (2026-09-25; changed on purpose 2026-10-01, RPC-SPEC, the owner's rule:
 * nothing is read from a public RPC).
 *
 * From 2026-09-25 to 2026-10-01 the page read the chain itself, from the chain's public RPC (and, from 2026-09-28, its
 * three public fallbacks), and this module answered those hosts. Since the switch the page reads no RPC: the wallet's
 * list, a position's state, its features, the fees history's logs, a vault's record and a batch's simulation are the
 * site's own chain routes (src/lib/edge/chainRoutes.ts), which routeChain() answers here with the routes' real handler
 * (functions/_lib/chainRoutes.ts, through tests/support/edge-routes.mjs) over this same chain. Any request to one of the
 * old public hosts is refused at the network and listed in `publicAsked` (the page's CSP refuses them first; a suite
 * asserts the list stays empty). `chain.edge = 'off'` answers the routes as a deployment without the node's secret
 * does; `chain.simulate` (a function of eth_simulateV1's params) turns the simulate route on; `chain.edgeLog` lists
 * each route asked.
 *
 * browserChain() is a small chain described the way the screens show it: the
 * wallet's positions (who holds each, its pool key, range, liquidity and the
 * unclaimed fees the chain must report), the pools' prices, the tokens, and
 * the deposits DominoSetupV1 holds for an owner. It answers only the methods
 * the chain code may ask (eth_blockNumber, eth_getLogs, eth_call to Multicall3 and
 * batched eth_getBlockByNumber) and keeps what it was asked; a sub-call no
 * contract here answers reverts, and is listed in `missing`. With nothing
 * described it is an empty chain: no position, no deposit, every NFT
 * unknown. `outage` answers every request with that HTTP status while set (or,
 * a function of the request's first call, the status to answer it with, or null):
 * the node's answer to the routes.
 *
 * Added with the review of 2026-09-25: `history(filter, from, to)` answers the
 * log reads it is given (since 2026-10-02 a position's own events for the fees
 * ledger, tests/support/fees/ledger-world.mjs), and `limit` makes the chain
 * refuse as a node does past a budget of reply bytes (`capacity`, refilled at
 * `perSecond`) that a reply may overdraw; while it is spent every request is
 * refused with a 429. Refused requests are listed in `refusals`.
 *
 * `operations: true` (the default since 2026-10-01, RPC-SPEC §2.9) makes each position minted by an owner one of its
 * DominoSetupV1 operations too (after its deposits), as the contract records it: the edge's list reads its ids from that
 * state (functions/_lib/walletPositions.ts operationIds, RPC-SPEC D4).
 * Not a suite of its own.
 */
import { createRequire } from 'node:module';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, keccak256, numberToHex, pad, parseAbi } from 'viem';
import { logLimitError, nodeLogError } from './log-limits.mjs';
import { routeEdge } from './edge-routes.mjs';
import { clockSkew } from './clock.mjs';

const require = createRequire(import.meta.url);
const owned = require('../../.test-build/app/functions/_lib/owned.js');
const fees = require('../../.test-build/app/functions/_lib/fees.js');
const automation = require('../../.test-build/app/functions/_lib/automation.js');

export const RPC_URL = owned.RPC_URL;
/** DominoSetupV1's SetupMinted topic: the wallet's list is read from these logs. */
export const SETUP_MINTED_TOPIC = owned.SETUP_MINTED_TOPIC;
/** The public RPC hosts the page read from until 2026-10-01: none may be asked any more (publicAsked). */
const PUBLIC_RPC_ROUTE = /^https:\/\/(?:rpc\.mainnet\.chain\.robinhood\.com|robinhood-rpc\.publicnode\.com|rpc\.ordofi\.network|robinhood\.drpc\.org)(?:\/|$)/;
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
  // 2026-09-28 (speed wave B, item 23): what a scan that took its head from Multicall3 would read (the parent chain's block).
  'function getBlockNumber() view returns (uint256)',
]);
// 2026-09-28 (speed wave B, item 23): the wallet scan's first read asks ArbSys the (L2) block it runs at.
const ARB_SYS = '0x0000000000000000000000000000000000000064';
const PARENT_BLOCK = 26_079_103n;
const arbSysAbi = parseAbi(['function arbBlockNumber() view returns (uint256)']);
const pmAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'function ownerOf(uint256) view returns (address)',
  'function getPositionLiquidity(uint256) view returns (uint128)',
  'function getPoolAndPositionInfo(uint256) view returns (PoolKey, uint256)',
  'function subscriber(uint256) view returns (address)',
  // 2026-10-01 (fees item D5): the page's state read asks it, to tell an id never minted from a burned one.
  'function nextTokenId() view returns (uint256)',
]);
// 2026-09-25: a position's feature, read by the page itself (functions/_lib/automation.ts scanAutomation): the NFT's
// subscriber, and when it is a vault, the factory's isVault and the vault's root, policy and permission.
const SEQUENCE_FACTORY = automation.SEQUENCE_FACTORY;
const factoryAbi = parseAbi(['function isVault(address) view returns (bool)']);
const vaultAbi = parseAbi([
  'struct Policy { uint16 serviceFeeBps; uint16 triggerDistanceBps; uint16 maxOverlapBps; uint32 minimumIntervalSeconds; uint8 maxPositions; uint64 version; bool paused; }',
  'struct Checkpoint { uint128 liquidity; uint256 feeGrowthInside0LastX128; uint256 feeGrowthInside1LastX128; uint256 feeGrowthInside0X128; uint256 feeGrowthInside1X128; uint64 observedAtBlock; bytes32 commitment; }',
  'function rootTokenId() view returns (uint256)',
  'function policy() view returns (Policy)',
  'function rootPermissionValid() view returns (bool)',
  // 2026-10-02 (RPC-SPEC §11.4): the fees ledger checks a vault's own checkpoint of its NFT (functions/_lib/feesLedger.ts).
  'function checkpoint(uint256) view returns (Checkpoint)',
  // 2026-10-02 (review of the rules, finding 1): a holder the ledger follows may be a vault's own owner.
  'function owner() view returns (address)',
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
/** A position's fee growth settled to (its last), as the chain answers it: its own `growth`, or below GROWTH by its unclaimed fees. */
const lastOf = (p) => {
  if (p.growth) return p.growth.last;
  const l = BigInt(p.liquidity);
  const [a, b] = p.unclaimed ?? [0n, 0n];
  return [GROWTH - needed(a, l), GROWTH - needed(b, l)];
};

/**
 * `positions`: [{ tokenId, holder, minter (holder unless said), key, tickLower, tickUpper, liquidity, unclaimed: [a, b],
 * burned, mintBlock, from, subscriber, growth }] where `from` is how many times ownerOf must have been asked before the NFT
 * exists (a mint the chain has not shown yet) and `subscriber` its PositionManager subscriber (none unless said).
 * `growth` (2026-10-01, item H1): { inside: [a, b], last: [a, b] }, the range's fee growth and the position's last, as a
 * modeled archive had them (the retired point reads); what they owe is the position's unclaimed fees then.
 * `pools`: per pool id { sqrtPriceX96, tick }; a position's pool not named sits at tick 0. `tokens`: per address
 * { symbol, decimals }. `deposits`: per owner [{ key, balance0, balance1, closed }], held by DominoSetupV1 (the n-th is
 * the owner's operation n). `vaults`: per lowercase address { root, feeBps, paused, valid, made }: a sequence vault
 * Domino's factory made (made: false, one it did not), for the automation read; its `checkpoint` of its root (the fees
 * ledger's check, 2026-10-02): the root's state now unless `checkpoint: 'stale'` (one from before an unseen settlement).
 * `times(block)` (2026-10-02): a block's header time (the ledger's settlements); the chain's `timestamp` otherwise.
 * `nodeRules` (2026-10-02, the default): its logs are answered as Domino's own node does, with the transport's own rules
 * checked (log-limits.mjs nodeLogError); false: as the chain's public RPC does (logLimitError).
 */
export function browserChain({ head = 71_700_000, timestamp = 1_790_000_000, positions = [], pools = {}, tokens = {}, deposits = {}, vaults = {}, history = null, limit = null, operations = true, times = null, nodeRules = true } = {}) {
  const chain = { head, timestamp, positions, pools, tokens, deposits, vaults, history, limit, operations, times, nodeRules, outage: null, publicAsked: [], log: [], missing: [], refused: [], refusals: [], asked: new Map() };
  const lower = (value) => String(value).toLowerCase();
  const position = (id) => chain.positions.find((p) => String(p.tokenId) === String(id));
  const ok = (abi, functionName, result) => ({ success: true, returnData: encodeFunctionResult({ abi, functionName, result }) });
  const revert = { success: false, returnData: '0x' };
  const poolOf = (id) => chain.pools[id] ?? { sqrtPriceX96: 2n ** 96n, tick: 0 };
  const known = (p) => p && !p.burned && (chain.asked.get(String(p.tokenId)) ?? 0) > (p.from ?? 0);
  /** With `operations`: the positions `owner` minted, in the order their SetupMinted logs come (their operations' order). */
  // By id, not by object: a suite may describe `positions` with a getter that makes new objects at each read.
  const indexOf = (list, p) => list.findIndex((one) => String(one.tokenId) === String(p.tokenId));
  const mintBlock = (p) => p.mintBlock ?? chain.head - 1000 * (chain.positions.length - indexOf(chain.positions, p));
  const mintedBy = (owner) => (chain.operations ? chain.positions.filter((p) => lower(p.minter ?? p.holder) === owner).sort((a, b) => mintBlock(a) - mintBlock(b)) : []);

  function view(target, data) {
    if (target === PM) {
      const { functionName, args } = decodeFunctionData({ abi: pmAbi, data });
      // 2026-10-01 (fees item D5): the id the next mint gets (`nextTokenId` when given): a mint the chain does not show yet
      // (`from`) is that next mint, as on the chain; else the id past every NFT described.
      if (functionName === 'nextTokenId') {
        const pending = chain.positions.filter((one) => !one.burned && !known(one)).map((one) => Number(one.tokenId));
        return ok(pmAbi, functionName, BigInt(chain.nextTokenId ?? (pending.length ? Math.min(...pending) : 1 + Math.max(0, ...chain.positions.map((one) => Number(one.tokenId))))));
      }
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
      if (functionName === 'getFeeGrowthInside') {
        // 2026-10-01 (item H1): a position described with its own fee growth (`growth`), as a modeled archive answers it.
        const own = chain.positions.find((one) => one.growth && poolIdOf(one.key) === args[0] && one.tickLower === args[1] && one.tickUpper === args[2]);
        return ok(stateViewAbi, functionName, own ? own.growth.inside : [GROWTH, GROWTH]);
      }
      const p = position(BigInt(args[4]));
      if (!p || lower(args[1]) !== PM) return revert;
      const [last0, last1] = lastOf(p);
      return ok(stateViewAbi, functionName, [BigInt(p.liquidity), last0, last1]);
    }
    if (target === SETUP) {
      const { functionName, args } = decodeFunctionData({ abi: setupAbi, data });
      // Changed on purpose 2026-09-28 (speed wave B, item 23): every position the owner minted is one of its operations, with
      // `operations` or not (a nonce of 0 is now a wallet with nothing, answered without a log read).
      if (functionName === 'ownerNonce') return ok(setupAbi, functionName, BigInt((chain.deposits[lower(args[0])] ?? []).length + chain.positions.filter((p) => lower(p.minter ?? p.holder) === lower(args[0])).length));
      if (functionName === 'recoveryStarted') return ok(setupAbi, functionName, false);
      for (const [owner, list] of Object.entries(chain.deposits)) {
        const i = list.findIndex((_, n) => opIdOf(owner, n) === args[0]);
        if (i >= 0) return ok(setupAbi, functionName, { owner, key: list[i].key, balance0: BigInt(list[i].balance0), balance1: BigInt(list[i].balance1), swapped: false, closed: list[i].closed === true, tokenId: 0n });
      }
      // A minted position's operation (`operations`): closed, its NFT's id kept, after the owner's deposits.
      for (const p of chain.operations ? chain.positions : []) {
        const owner = lower(p.minter ?? p.holder);
        const n = (chain.deposits[owner] ?? []).length + indexOf(mintedBy(owner), p);
        if (opIdOf(owner, n) === args[0]) return ok(setupAbi, functionName, { owner, key: p.key, balance0: 0n, balance1: 0n, swapped: false, closed: true, tokenId: BigInt(p.tokenId) });
      }
      return ok(setupAbi, functionName, { owner: ZERO, key: { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO }, balance0: 0n, balance1: 0n, swapped: false, closed: false, tokenId: 0n });
    }
    // 2026-09-28 (speed wave B, item 23): as on Robinhood Chain (Arbitrum Nitro), ArbSys.arbBlockNumber() is the head and
    // Multicall3.getBlockNumber() is block.number, the parent chain's block (tests/owned-chain.mjs PARENT_BLOCK).
    if (target === ARB_SYS) return ok(arbSysAbi, 'arbBlockNumber', BigInt(chain.head));
    if (target === MULTICALL3) {
      const { functionName } = decodeFunctionData({ abi: multicallAbi, data });
      return functionName === 'getBlockNumber' ? ok(multicallAbi, functionName, PARENT_BLOCK) : ok(multicallAbi, 'getCurrentBlockTimestamp', BigInt(chain.timestamp));
    }
    if (target === SEQUENCE_FACTORY) {
      const { functionName, args } = decodeFunctionData({ abi: factoryAbi, data });
      const vault = chain.vaults[lower(args[0])];
      return ok(factoryAbi, functionName, !!vault && vault.made !== false);
    }
    const vault = chain.vaults[target];
    if (vault) {
      const { functionName, args } = decodeFunctionData({ abi: vaultAbi, data });
      if (functionName === 'rootTokenId') return ok(vaultAbi, functionName, BigInt(vault.root));
      if (functionName === 'checkpoint') {
        const p = position(args[0]);
        const [last0, last1] = p ? lastOf(p) : [0n, 0n];
        const stale = vault.checkpoint === 'stale';
        return ok(vaultAbi, functionName, { liquidity: p ? BigInt(p.liquidity) : 0n, feeGrowthInside0LastX128: stale ? last0 - 1n : last0, feeGrowthInside1LastX128: last1, feeGrowthInside0X128: 0n, feeGrowthInside1X128: 0n, observedAtBlock: 0n, commitment: `0x${'00'.repeat(32)}` });
      }
      if (functionName === 'rootPermissionValid') return ok(vaultAbi, functionName, vault.valid !== false);
      if (functionName === 'owner') return ok(vaultAbi, functionName, vault.owner ?? ZERO);
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
      // Changed on purpose 2026-10-02: Domino's own node, which the routes read, has no block ceiling; what the routes'
      // transport must never send it fails the test (tests/support/log-limits.mjs nodeLogError). `nodeRules: false`: the
      // chain RPC's own limits, for a test that runs the chain code directly, with its own windows (logLimitError).
      const limited = chain.nodeRules ? nodeLogError(filter) : logLimitError(filter);
      if (limited) return { error: limited };
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
    if (method === 'eth_getBlockByNumber') return { result: { number: params[0], timestamp: numberToHex(chain.times ? chain.times(Number(params[0])) : chain.timestamp), hash: `0x${'ab'.repeat(32)}` } };
    // 2026-09-28 (speed wave B, item 23): the wallet scan's first read is an aggregate3 at 'latest' of ArbSys.arbBlockNumber
    // and the owner's nonce, taken here at the head.
    if (method === 'eth_call' && lower(params[0]?.to) === MULTICALL3 && (params[1] === 'latest' || Number(params[1]) <= chain.head)) {
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
 * Answers the site's own chain routes for every page of `context` (and its fees worker) from `chain` (an empty chain
 * unless one is given), and refuses at the network, listing each in `chain.publicAsked`, any request to a public RPC
 * host the page read from until 2026-10-01. A route whose chain code threw answers as the route does (a 502).
 */
export async function routeChain(context, chain = browserChain()) {
  chain.errors ??= [];
  chain.publicAsked ??= [];
  await context.route(PUBLIC_RPC_ROUTE, (route) => {
    chain.publicAsked.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  // RPC-SPEC Phase 0: the site's own chain routes (src/lib/edge/chainRoutes.ts), answered from this same chain by the
  // routes' chain code (tests/support/edge-routes.mjs). `chain.edge = 'off'` answers them as a deployment without the
  // node's secret does; `chain.simulate` (a function of eth_simulateV1's params) turns the simulate route on.
  chain.edgeLog ??= [];
  // The routes keep time by the scenario's clock: real time plus every jump of it (tests/support/clock.mjs), so a kept
  // answer ages and a node's rest ends as the page's own time moves.
  await routeEdge(context, { fetch: (_url, init) => chain.fetch(RPC_URL, init), now: () => Date.now() + clockSkew(context) }, { simulator: () => chain.simulate ?? null, source: () => chain.edge ?? 'up', log: chain.edgeLog });
  return chain;
}

// Changed on purpose 2026-10-02 (RPC-SPEC §11.4): busyHistory, a busy pool's history for the fees replay, is gone with it;
// a position's own events are tests/support/fees/ledger-chain.mjs's.
