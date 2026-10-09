/**
 * A position's own ledger of settlements at the edge (functions/_lib/feesLedger.ts, POST /api/fees/v2/ledger, RPC-SPEC
 * §11.4; rugged97's rules for the site's token, C:/dwt/rpc-plan/RUGGED_RPC_SITE_2026-10-02.md): its pins against the
 * contracts and the deployment profile; an automatic compound's exact fees and service fee from the engine's own events;
 * an owner's collect from the transfers it paid; what cannot be told apart, said so; the vault's checkpoint; a first read
 * from the floor and every later one from the kept block only; one-block PoolManager lookups and nothing of a pool's
 * history; a long ledger read in steps; the answer kept and a fresh question; and the route's refusals. Over a fake node
 * in front of a fake chain (tests/support/fees/ledger-world.mjs); nothing reaches the network.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { keccak256, toBytes, numberToHex, pad, encodeAbiParameters } from 'viem';
import { fakeNode } from './support/fake-node.mjs';
import { RPC_URL } from './support/browser-chain.mjs';
import { memoryCache } from './support/fees/fake-chain.mjs';
import { HEAD, HOLDER, KEY, OWNER_MINT, OWNER_STATE, OWNER_STEPS, USDG, VAULT, ledgerWorld } from './support/fees/ledger-world.mjs';
import { positionLogs, txOf, word } from './support/fees/ledger-chain.mjs';

const require = createRequire(import.meta.url);
const routes = require('../.test-build/app/functions/_lib/chainRoutes.js');
const ledger = require('../.test-build/app/functions/_lib/feesLedger.js');
const fees = require('../.test-build/app/functions/_lib/fees.js');
const local = require('../.test-build/app/functions/_lib/localRpc.js');
const owned = require('../.test-build/app/functions/_lib/owned.js');
const { isLedgerResponse } = require('../.test-build/app/src/lib/fees/answers.js');
const { foldLedger } = require('../.test-build/app/src/lib/fees/ledger.js');
const { stateOf } = require('../.test-build/app/src/lib/fees/store.js');

const ORIGIN = 'https://domino.money';
const ENV = { LOCAL_RPC_URL: 'https://rpc.domino.money/test-token-0123456789abcdef/' };
const FLOOR = 69_249_061;
const ID = '3325113';
const V2_HEAD = 82_880_000;
const V2_MINT = { block: V2_HEAD - 1_000, liquidity: OWNER_MINT.liquidity };
const v2Event = (address, topics, values, block, tx = txOf(block), index = 100) => ({ address, topics, data: `0x${values.map((value) => word(value).slice(2)).join('')}`, blockNumber: numberToHex(block), logIndex: numberToHex(index), transactionHash: tx, blockHash: `0x${'cd'.repeat(32)}`, transactionIndex: '0x0', removed: false });
const v2Mint = (id = ID, mint = V2_MINT) => v2Event(ledger.V2_ZAP, [ledger.V2_ACTION, word(1n), pad(HOLDER), word(id)], [0n, mint.liquidity, 0n], mint.block);
const mintHint = (id = ID, mint = V2_MINT) => ({ tokenId: String(id), block: mint.block, tx: mint.tx ?? txOf(mint.block) });
const v2Step = (block, delta, amounts, id = ID) => v2Event(ledger.V2_ZAP, [ledger.V2_STEP, word(0n), pad(HOLDER), word(id)], [4n, KEY.currency0, KEY.currency1, KEY.fee, KEY.tickSpacing, KEY.hooks, delta, ...amounts], block);
const v2World = (overrides = {}) => ledgerWorld({ vault: null, setup: false, mint: V2_MINT, steps: [], head: V2_HEAD, extraLogs: [v2Mint()], ...overrides });
const mintSwap = (poolId, price = OWNER_STATE.sqrtPriceX96, index = 200) => v2Event(fees.POOL_MANAGER, [ledger.MINT_SWAP, poolId, pad(HOLDER)], [-1n, 1n, price, 1_000n, 1n, 3_000n], V2_MINT.block, txOf(V2_MINT.block), index);
const prunedNode = (world, swapLogs) => ({ fetch: async (url, init) => {
  const call = JSON.parse(init.body);
  if (call.method === 'eth_call' && Number(call.params[1]) === V2_MINT.block) return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'historical state unavailable: pruned' } }));
  if (swapLogs !== undefined && call.method === 'eth_getLogs' && call.params[0].topics[0] === ledger.MINT_SWAP) return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: swapLogs }));
  return world.chain.fetch(url, init);
} });

/** The routes over `chain` as one isolate with one edge cache, on a clock of their own. */
function edge(chain, clock = { time: 1_000_000 }) {
  const lines = [];
  const { cache, stored } = memoryCache();
  const runtime = {
    upstream: fakeNode({ fetch: (_url, init) => chain.fetch(RPC_URL, init) }),
    cache,
    now: () => clock.time,
    sleep: async (ms) => {
      clock.time += ms;
    },
    memory: routes.chainRouteMemory(),
    log: (line) => lines.push(JSON.parse(line)),
  };
  const askOnce = async (body, headers = {}) => {
    const request = new Request(`${ORIGIN}/api/fees/v2/ledger`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const response = await routes.answerChainRoute('ledger', { request, env: ENV }, runtime);
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  // Existing accounting fixtures follow the bounded discovery cursor. Stop at the lookup/byte budget so those
  // tests still exercise a single settlement step; new cursor tests use askOnce explicitly.
  const ask = async (body, headers = {}) => {
    for (let attempt = 0; attempt < 25; attempt++) {
      const result = await askOnce(body, headers);
      let discovery = false;
      for (const position of result.body.positions ?? []) {
        if (!position.ok || position.why !== 'reading') continue;
        const kept = stored.get(`${ORIGIN}/api/fees/v1/cache/c1/ledger2/${position.tokenId}/0`);
        const saved = kept ? await kept.clone().json() : null;
        if (saved && saved.scanned === position.through && saved.scanned < result.body.block) discovery = true;
      }
      if (!discovery) return result;
    }
    throw new Error('bounded discovery did not complete');
  };
  return { ask, askOnce, lines, stored, clock, runtime };
}

/** Every eth_getLogs the node got (after the transport's windows), and every one of the PoolManager's. */
const logReads = (chain) => chain.log.filter((entry) => entry.method === 'eth_getLogs').map((entry) => entry.params[0]);

/** The page's fold of one ledger answer with its own state (what Fees earned shows). */
function folded(answer, id = ID) {
  const position = answer.positions.find((one) => one.tokenId === id);
  const read = { position, block: answer.block, timestamp: answer.timestamp };
  return foldLedger(read, stateOf(position.state, answer.block, answer.timestamp));
}

test.beforeEach(() => routes.resetChainRouteMemory());

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

test('the engine, its two events and the vault’s checkpoint are the deployment’s and the contracts’ own', () => {
  const deployment = JSON.parse(readFileSync(new URL('../../docs/deployments/v1-robinhood-mainnet-2026-09-21/deployment.json', import.meta.url), 'utf8'));
  assert.equal(ledger.ENGINE, deployment.contracts.engine);
  const source = readFileSync(new URL('../../contracts/src/DominoExecutionEngineV4.sol', import.meta.url), 'utf8');
  assert.match(source, /event FeesRealized\(address indexed vault, bytes32 indexed intentId, uint256 indexed tokenId,\s*bytes32 checkpointBefore, bytes32 checkpointAfter, uint128 amount0, uint128 amount1\);/);
  assert.match(source, /event BudgetApplied\(address indexed vault, bytes32 indexed intentId, bytes32 indexed sourceId,\s*address currency, uint256 destinationTokenId, T\.CompoundAmounts amounts\);/);
  const types = readFileSync(new URL('../../contracts/src/DominoVaultTypes.sol', import.meta.url), 'utf8');
  const amounts = /struct CompoundAmounts \{([^}]*)\}/.exec(types)[1].split(';').map((field) => field.trim()).filter(Boolean);
  assert.deepEqual(amounts, ['uint128 originalBefore', 'uint128 chargedBefore', 'uint128 realized', 'uint128 grossOriginalConsumed', 'uint128 chargedConsumed', 'uint128 serviceFee', 'uint128 liquidityAdded', 'uint128 originalAfter', 'uint128 chargedAfter']);
  assert.equal(ledger.FEES_REALIZED, keccak256(toBytes('FeesRealized(address,bytes32,uint256,bytes32,bytes32,uint128,uint128)')));
  assert.equal(ledger.BUDGET_APPLIED, keccak256(toBytes(`BudgetApplied(address,bytes32,bytes32,address,uint256,(${Array(9).fill('uint128').join(',')}))`)));
  assert.equal(ledger.CHECKPOINT_SELECTOR, keccak256(toBytes('checkpoint(uint256)')).slice(2, 10));
  const vault = readFileSync(new URL('../../contracts/src/DominoVaultV4.sol', import.meta.url), 'utf8');
  assert.match(vault, /function checkpoint\(uint256 id\) external view returns \(T\.Checkpoint memory\)/);
  assert.match(types, /struct Checkpoint \{\s*uint128 liquidity;\s*uint256 feeGrowthInside0LastX128;\s*uint256 feeGrowthInside1LastX128;/);
  assert.equal(ledger.LEDGER_FLOOR, FLOOR);
});

test('V2 pins match the verified deployment and event ABI signatures', () => {
  assert.equal(ledger.MINT_SWAP, keccak256(toBytes('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)')));
  const deployment = JSON.parse(readFileSync(new URL('../../docs/deployments/v2-robinhood-4663-2026-10-04/deployment.json', import.meta.url), 'utf8'));
  assert.equal(ledger.V2_ZAP, deployment.contracts['zap.v4']);
  assert.equal(ledger.V2_FACTORY, deployment.contracts['vaultFactory.v4']);
  for (const [topic, signature] of [
    [ledger.V2_ACTION, 'PositionActionExecuted(uint8,address,uint256,uint256,uint128,bytes32)'],
    [ledger.V2_STEP, 'PositionLiquidityChanged(bytes32,address,uint256,(uint8,address,address,uint24,int24,address),int256,int256,int256)'],
    [ledger.V2_VAULT_CREATED, 'VaultCreated(address,address,uint256,uint8,uint256)'],
    [ledger.V2_COLLECTED, 'FeesCollected(uint256,uint256,uint256)'],
    [ledger.V2_COMPOUNDED, 'Compounded(uint256,uint128,uint256,uint256,uint256,uint256,uint64)'],
  ]) assert.equal(topic, keccak256(toBytes(signature)));
});

test('a verified indexed V2 mint completes on its first read, with exact mint and no fabricated previous fees', async () => {
  const { chain } = v2World();
  const result = await edge(chain).askOnce({ tokenIds: [ID], mintHints: [mintHint()] });
  assert.equal(result.status, 200);
  assert.ok(isLedgerResponse(result.body));
  const [position] = result.body.positions;
  assert.equal(position.exact, true, position.why);
  assert.equal(position.mint.block, V2_MINT.block);
  assert.ok(position.mint.t > 0);
  assert.equal(position.mint.sqrtPriceX96, OWNER_STATE.sqrtPriceX96.toString());
  assert.deepEqual(position.entries.map((entry) => [entry.kind, entry.fees]), [['mint', ['0', '0']]]);
  assert.ok(logReads(chain).every((filter) => Number(filter.fromBlock) >= V2_MINT.block));
  assert.equal(folded(result.body).phase, 'verified');
});

test('a hint is an exact PM mint proof, never authority to skip history on a wrong tx, token or block', async () => {
  for (const hint of [mintHint(ID, { ...V2_MINT, tx: txOf(V2_MINT.block, 9) }), { ...mintHint(), block: V2_MINT.block + 1 }]) {
    const { chain } = v2World();
    const result = await edge(chain).askOnce({ tokenIds: [ID], mintHints: [hint] });
    assert.equal(result.status, 200);
    assert.equal(result.body.positions[0].why, 'reading');
    assert.equal(result.body.positions[0].mint, null);
    assert.ok(logReads(chain).some((filter) => Number(filter.fromBlock) === FLOOR));
  }
  for (const hint of [{ ...mintHint(), tokenId: '9' }, { ...mintHint(), extra: 1 }, { ...mintHint(), block: 1 }, { ...mintHint(), tx: '0x1234' }]) {
    assert.equal(ledger.ledgerRequestOf({ tokenIds: [ID], mintHints: [hint] }), null);
  }
});

test('a cold recent V2 NFT discovers its indexed mint immediately and scans settlements only during its life', async () => {
  const { chain } = v2World();
  const e = edge(chain);
  const first = await e.askOnce({ tokenIds: [ID] });
  assert.equal(first.body.positions[0].exact, true, first.body.positions[0].why);
  assert.equal(first.body.positions[0].mint.block, V2_MINT.block);
  assert.equal(first.body.positions[0].through, V2_HEAD);
  const discovery = logReads(chain).filter((filter) => filter.address === owned.POSITION_MANAGER && filter.topics[1] === word(0n));
  assert.equal(discovery.length, 1);
  assert.ok(Number(discovery[0].toBlock) - Number(discovery[0].fromBlock) < ledger.MINT_DISCOVERY_BLOCKS);
  assert.ok(logReads(chain).filter((filter) => !discovery.includes(filter)).every((filter) => Number(filter.fromBlock) >= V2_MINT.block));
  const second = await e.askOnce({ tokenIds: [ID] });
  assert.equal(second.body.positions[0].through, V2_HEAD);
  assert.equal(logReads(chain).filter((filter) => filter.address === owned.POSITION_MANAGER && filter.topics[1] === word(0n)).length, 1, 'cached accounting avoids repeating discovery');
  const ready = await e.askOnce({ tokenIds: [ID], mintHints: [mintHint()] });
  assert.equal(ready.body.positions[0].exact, true, ready.body.positions[0].why);
});

test('a previous unhinted failure does not hide a valid indexed mint in the failure cache', async () => {
  const world = v2World();
  const e = edge(world.chain);
  const digest = await fees.sha256(`${ID}|${ledger.LEDGER_ANSWER_VERSION}|`);
  e.stored.set(`${ORIGIN}/api/fees/v1/cache/c1/ledgerFail2/${digest}/0`, new Response(JSON.stringify({ outcome: 'rpc_unavailable', seconds: 60 }), { headers: { 'X-Fees-Stored-At': String(e.clock.time) } }));
  const old = await e.askOnce({ tokenIds: [ID] });
  assert.equal(old.status, 502);
  const indexed = await e.askOnce({ tokenIds: [ID], mintHints: [mintHint()] });
  assert.equal(indexed.status, 200);
  assert.equal(indexed.body.positions[0].exact, true);
});

test('a late cold response cannot overwrite the mint and complete ledger of the newer hinted response', async () => {
  const world = v2World();
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const began = new Promise((resolve) => { started = resolve; });
  const node = { fetch: async (url, init) => {
    const question = JSON.parse(init.body);
    if (question.method === 'eth_getLogs' && question.params[0].address === owned.POSITION_MANAGER && question.params[0].topics[1] === word(0n) && Number(question.params[0].toBlock) > Number(question.params[0].fromBlock)) { started(); await gate; }
    return world.chain.fetch(url, init);
  } };
  const e = edge(node);
  const cold = e.askOnce({ tokenIds: [ID] });
  await began;
  try {
    const ready = await e.askOnce({ tokenIds: [ID], mintHints: [mintHint()] });
    assert.equal(ready.body.positions[0].exact, true);
  } finally { release(); }
  assert.equal((await cold).body.positions[0].exact, true);
  const saved = await e.stored.get(`${ORIGIN}/api/fees/v1/cache/c1/ledger2/${ID}/0`).clone().json();
  assert.equal(saved.scanned, V2_HEAD);
  assert.equal(saved.through, V2_HEAD);
  assert.equal(saved.mint.block, V2_MINT.block);
  assert.equal(saved.entries.length, 1);
});

test('a recent hinted mint is not starved by a second NFT still discovering its older history', async () => {
  const older = more(2);
  const { chain } = v2World({ extraLogs: [v2Mint(), ...older.extraLogs], extraPositions: older.extraPositions });
  const result = await edge(chain).askOnce({ tokenIds: older.ids, mintHints: [mintHint()] });
  assert.equal(result.status, 200);
  assert.equal(result.body.positions.find((p) => p.tokenId === ID).exact, true);
  assert.equal(result.body.positions.find((p) => p.tokenId !== ID).why, 'reading');
  assert.ok(logReads(chain).every((filter) => Number(filter.toBlock) - Number(filter.fromBlock) < (filter.address === owned.POSITION_MANAGER && filter.topics[1] === word(0n) ? ledger.MINT_DISCOVERY_BLOCKS : ledger.LEDGER_SCAN_BLOCKS)));
});

test('bounded discovery waits for a later V2 factory proof instead of permanently rejecting a not-yet-proven holder', async () => {
  const factoryBlock = V2_MINT.block + ledger.LEDGER_SCAN_BLOCKS + 100;
  const factory = v2Event(ledger.V2_FACTORY, [ledger.V2_VAULT_CREATED, pad(HOLDER), pad(VAULT), word(ID)], [4n, 0n], factoryBlock);
  const { chain } = v2World({ head: factoryBlock + 500, extraLogs: [factory] });
  const e = edge(chain);
  let result;
  for (let i = 0; i < 8; i++) {
    result = await e.askOnce({ tokenIds: [ID], mintHints: [mintHint()] });
    assert.equal(result.status, 200);
    assert.notEqual(result.body.positions[0].why, 'unseen');
    if (result.body.positions[0].exact) break;
  }
  assert.equal(result.body.positions[0].exact, true, JSON.stringify(result.body));
  assert.ok(logReads(chain).every((filter) => Number(filter.toBlock) - Number(filter.fromBlock) < ledger.LEDGER_SCAN_BLOCKS));
});

test('a V2 fee-only collect is exact; an S1 add or withdrawal never counts its principal as fees', async () => {
  const block = V2_MINT.block + 100;
  for (const [kind, delta, amounts, exact] of [ ['collect', 0n, [123n, 456n], true], ['increase', 10n, [-1_000n, -2_000n], false], ['decrease', 10n, [1_000n, 2_000n], false] ]) {
    const signed = kind === 'decrease' ? -delta : delta;
    const { chain } = v2World({ steps: [{ block, kind, delta, fees: [123n, 456n] }], extraLogs: [v2Mint(), v2Step(block, signed, amounts)] });
    const result = await edge(chain).askOnce({ tokenIds: [ID], mintHints: [mintHint()] });
    const position = result.body.positions[0];
    assert.equal(position.exact, exact, JSON.stringify(position));
    assert.deepEqual(position.entries.at(-1).fees, exact ? ['123', '456'] : null);
  }
});

test('V2 vault fees use FeesCollected once; Compounded consumed amounts and aggregate service fees are not fresh NFT income', async () => {
  const block = V2_MINT.block + 100;
  const factory = v2Event(ledger.V2_FACTORY, [ledger.V2_VAULT_CREATED, pad(HOLDER), pad(VAULT), word(ID)], [4n, 0n], V2_MINT.block);
  const collected = v2Event(VAULT, [ledger.V2_COLLECTED, word(ID)], [123n, 456n], block);
  const compound = v2Event(VAULT, [ledger.V2_COMPOUNDED, word(ID)], [10n, 8_000n, 9_000n, 50n, 60n, 1n], block, txOf(block), 101);
  const { chain, logs } = v2World({ vault: VAULT, steps: [{ block, kind: 'compound', delta: 10n, fees: [123n, 456n] }], extraLogs: [v2Mint(), factory, collected, compound] });
  // The fixture's compound shape supplies PM collect/add and payment logs, but its old V1 engine logs are absent.
  for (let i = logs.length - 1; i >= 0; i--) if ([ledger.ENGINE, VAULT].includes(logs[i].address) && ![ledger.V2_COLLECTED, ledger.V2_COMPOUNDED].includes(logs[i].topics[0])) logs.splice(i, 1);
  const result = await edge(chain).askOnce({ tokenIds: [ID], mintHints: [mintHint()] });
  assert.equal(result.status, 200);
  const position = result.body.positions[0];
  assert.equal(position.exact, true, JSON.stringify(position));
  assert.deepEqual(position.entries.map((entry) => entry.fees), [['0', '0'], ['123', '456'], ['0', '0']]);
  assert.ok(position.entries.every((entry) => entry.service === undefined));
});

test('old unseen V2 verdicts rebuild from their verified mint; old V1 warm history keeps its trusted owner', async () => {
  const world = v2World();
  const e = edge(world.chain);
  const key = `${ORIGIN}/api/fees/v1/cache/c1/ledger2/${ID}/0`;
  const old = { v: 2, poolId: world.poolId, through: V2_HEAD, scanned: V2_HEAD, mint: { ...mintHint(), t: world.timeAt(V2_MINT.block) }, holders: [HOLDER], trusted: [], vaults: [], entries: [], final: 'unseen', pending: { candidates: [], realized: [], service: [], paidIn: [], paidOut: [] } };
  e.stored.set(key, new Response(JSON.stringify(old), { headers: { 'X-Fees-Stored-At': String(e.clock.time) } }));
  const repaired = await e.askOnce({ tokenIds: [ID] });
  assert.equal(repaired.body.positions[0].exact, true, repaired.body.positions[0].why);
  assert.ok(logReads(world.chain).every((filter) => Number(filter.fromBlock) >= V2_MINT.block));
  const saved = await e.stored.get(key).clone().json();
  assert.equal(saved.v, 3);

  const legacy = ledgerWorld({ vault: null, steps: [] });
  const oldEdge = edge(legacy.chain);
  const initial = await oldEdge.ask({ tokenIds: [ID] });
  assert.equal(initial.body.positions[0].exact, true);
  const kept = await oldEdge.stored.get(key).clone().json();
  kept.v = 2;
  kept.scanned = 80_200_000;
  kept.through = kept.scanned;
  oldEdge.stored.set(key, new Response(JSON.stringify(kept), { headers: { 'X-Fees-Stored-At': String(oldEdge.clock.time) } }));
  legacy.chain.head = 80_210_000;
  legacy.chain.log.length = 0;
  oldEdge.clock.time += 60_000;
  const migrated = await oldEdge.askOnce({ tokenIds: [ID] });
  assert.equal(migrated.body.positions[0].exact, true, migrated.body.positions[0].why);
  assert.ok(logReads(legacy.chain).every((filter) => Number(filter.fromBlock) > OWNER_MINT.block));
  assert.deepEqual(migrated.body.positions[0].entries, initial.body.positions[0].entries);
});

test('the opening anchor is a fixed pool read at the verified mint block, even when fee settlements are inexact', async () => {
  const block = V2_MINT.block + 100;
  const world = v2World({ steps: [{ block, kind: 'increase', delta: 10n }], extraLogs: [v2Mint(), v2Step(block, 10n, [-1_000n, -2_000n])] });
  const e = edge(world.chain);
  const result = await e.askOnce({ tokenIds: [ID], mintHints: [mintHint()] });
  assert.equal(result.status, 200);
  assert.equal(result.body.positions[0].exact, false);
  assert.equal(result.body.positions[0].mint.sqrtPriceX96, OWNER_STATE.sqrtPriceX96.toString());
  const historical = world.chain.log.filter((call) => call.method === 'eth_call' && Number(call.params[1]) === V2_MINT.block);
  assert.equal(historical.length, 1);
  assert.ok(historical[0].params[0].data.includes(fees.SELECTOR.getSlot0));
  assert.equal(e.lines.find((line) => line.event === 'ledger_mint_price').read, 1);
});

test('opening prices are deduplicated by pool and block and final values survive ledger refreshes', async () => {
  const other = more(2, { at: V2_MINT.block - 1_000 });
  const world = v2World({ head: V2_HEAD + fees.SAFE_DEPTH, extraLogs: [v2Mint(), ...other.extraLogs], extraPositions: other.extraPositions });
  const e = edge(world.chain);
  const question = { tokenIds: other.ids, mintHints: other.ids.map((id) => mintHint(id)) };
  const first = await e.askOnce(question);
  assert.ok(first.body.positions.every((position) => position.mint.sqrtPriceX96 === OWNER_STATE.sqrtPriceX96.toString()));
  const atMint = () => world.chain.log.filter((call) => call.method === 'eth_call' && Number(call.params[1]) === V2_MINT.block);
  assert.equal(atMint().length, 1, 'same pool and block: one getSlot0');
  e.clock.time += 60_000;
  await e.askOnce({ ...question, fresh: true });
  assert.equal(atMint().length, 1, 'a finalized anchor needs no second archive read');
});

test('recent opening prices are rechecked, and read once more when their block becomes final', async () => {
  const world = v2World();
  const e = edge(world.chain);
  const question = { tokenIds: [ID], mintHints: [mintHint()] };
  await e.askOnce(question);
  const atMint = () => world.chain.log.filter((call) => call.method === 'eth_call' && Number(call.params[1]) === V2_MINT.block).length;
  assert.equal(atMint(), 1);
  e.clock.time += 3_000;
  await e.askOnce({ ...question, fresh: true });
  assert.equal(atMint(), 1, 'brief provisional cache');
  e.clock.time += 10_000;
  await e.askOnce({ ...question, fresh: true });
  assert.equal(atMint(), 2, 'recent block rechecked');
  world.chain.head += fees.SAFE_DEPTH;
  e.clock.time += 3_000;
  await e.askOnce({ ...question, fresh: true });
  assert.equal(atMint(), 3, 'provisional value is not silently promoted to finalized');
});

test('unavailable archive state omits the anchor, keeps the ledger exact, and briefly cools down only that pool/block', async () => {
  const world = v2World();
  let attempts = 0;
  const node = { fetch: async (url, init) => {
    const call = JSON.parse(init.body);
    if (call.method === 'eth_call' && Number(call.params[1]) === V2_MINT.block) {
      attempts++;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'missing trie node' } }));
    }
    return world.chain.fetch(url, init);
  } };
  const e = edge(node);
  const question = { tokenIds: [ID], mintHints: [mintHint()] };
  const result = await e.askOnce(question);
  assert.equal(result.status, 200);
  assert.equal(result.body.positions[0].exact, true);
  assert.equal(result.body.positions[0].mint.sqrtPriceX96, undefined);
  const diagnostic = e.lines.find((line) => line.event === 'ledger_mint_price');
  assert.equal(diagnostic.rpc, 1);
  assert.equal(diagnostic.rpcCode, -32000);
  assert.equal(diagnostic.rpcClass, 'historical_unavailable');
  assert.equal(diagnostic.swapEmpty, 1);
  assert.ok(!JSON.stringify(diagnostic).includes('missing trie node'));
  e.clock.time += 3_000;
  await e.askOnce({ ...question, fresh: true });
  assert.equal(attempts, 1);
  assert.equal(e.lines.filter((line) => line.event === 'ledger_mint_price').at(-1).cooldown, 1);
});

test('a pruned historical state uses the last real Swap of the verified mint block only', async () => {
  const world = v2World({ head: V2_HEAD + fees.SAFE_DEPTH });
  const first = OWNER_STATE.sqrtPriceX96 - 100n;
  const last = OWNER_STATE.sqrtPriceX96 - 50n;
  world.logs.push(mintSwap(world.poolId, last, 205), mintSwap(world.poolId, first, 105));
  const e = edge(prunedNode(world));
  const question = { tokenIds: [ID], mintHints: [mintHint()] };
  const result = await e.askOnce(question);
  assert.equal(result.status, 200);
  assert.equal(result.body.positions[0].exact, true);
  assert.equal(result.body.positions[0].mint.sqrtPriceX96, last.toString());
  const asks = world.asked.filter((filter) => filter.topics[0] === ledger.MINT_SWAP);
  assert.equal(asks.length, 1);
  assert.deepEqual(asks[0], { address: fees.POOL_MANAGER, from: V2_MINT.block, to: V2_MINT.block, topics: [ledger.MINT_SWAP, world.poolId] });
  const metric = e.lines.find((line) => line.event === 'ledger_mint_price');
  assert.equal(metric.rpcClass, 'historical_unavailable');
  assert.equal(metric.swapRead, 1);
  e.clock.time += 60_000;
  const again = await e.askOnce({ ...question, fresh: true });
  assert.equal(again.body.positions[0].mint.sqrtPriceX96, last.toString());
  assert.equal(world.asked.filter((filter) => filter.topics[0] === ledger.MINT_SWAP).length, 1, 'final end-block price is shared in the anchor cache');
});

test('the mint-block Swap fallback rejects the whole pool answer on any unexpected or malformed log', async () => {
  const world = v2World();
  const good = mintSwap(world.poolId);
  for (const [label, bad] of [
    ['other pool', { ...good, topics: [ledger.MINT_SWAP, `0x${'ef'.repeat(32)}`, pad(HOLDER)] }],
    ['other contract', { ...good, address: ledger.V2_ZAP }],
    ['other block', { ...good, blockNumber: numberToHex(V2_MINT.block + 1) }],
    ['removed', { ...good, removed: true }],
    ['duplicate log index', { ...good }],
    ['different block hash', { ...good, logIndex: '0xff', blockHash: `0x${'de'.repeat(32)}` }],
    ['malformed ABI', { ...good, data: '0x' }],
    ['zero price', mintSwap(world.poolId, 0n, 201)],
    ['out-of-range price', mintSwap(world.poolId, 1n << 160n, 201)],
    ['noncanonical signed amount', { ...mintSwap(world.poolId, OWNER_STATE.sqrtPriceX96, 201), data: `0x${word(1n << 128n).slice(2)}${good.data.slice(66)}` }],
    ['inconsistent transaction index', { ...good, logIndex: '0xff', transactionIndex: '0x1' }],
  ]) {
    routes.resetChainRouteMemory();
    const e = edge(prunedNode(world, [good, bad]));
    const result = await e.askOnce({ tokenIds: [ID], mintHints: [mintHint()] });
    assert.equal(result.status, 200, label);
    assert.equal(result.body.positions[0].exact, true, label);
    assert.equal(result.body.positions[0].mint.sqrtPriceX96, undefined, label);
    assert.equal(e.lines.find((line) => line.event === 'ledger_mint_price').swapInvalid, 1, label);
  }
  routes.resetChainRouteMemory();
  const e = edge(prunedNode(world, [good, { ...good, logIndex: '0xff', transactionIndex: '0x1', transactionHash: txOf(V2_MINT.block + 1) }, { ...good, logIndex: '0x100', transactionIndex: '0x2' }]));
  const repeated = await e.askOnce({ tokenIds: [ID], mintHints: [mintHint()] });
  assert.equal(repeated.body.positions[0].mint.sqrtPriceX96, undefined, 'a transaction hash cannot recur at another index after an intervening transaction');
  assert.equal(e.lines.find((line) => line.event === 'ledger_mint_price').swapInvalid, 1);
});

test('historical call and exact-block Swap fallback share the same optional deadline', async () => {
  const world = v2World();
  let firstStarted;
  let fallbackSignal;
  const node = { fetch: async (url, init) => {
    const call = JSON.parse(init.body);
    if (call.method === 'eth_call' && Number(call.params[1]) === V2_MINT.block) {
      firstStarted = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 300));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'historical state unavailable' } }));
    }
    if (call.method === 'eth_getLogs' && call.params[0].topics[0] === ledger.MINT_SWAP) {
      fallbackSignal = init.signal;
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    }
    return world.chain.fetch(url, init);
  } };
  const e = edge(node);
  const start = performance.now();
  const result = await e.askOnce({ tokenIds: [ID], mintHints: [mintHint()] });
  assert.equal(result.status, 200);
  assert.equal(result.body.positions[0].exact, true);
  assert.equal(result.body.positions[0].mint.sqrtPriceX96, undefined);
  assert.equal(fallbackSignal.aborted, true);
  assert.equal(fallbackSignal.reason.name, 'AbortError');
  assert.ok(performance.now() - firstStarted < ledger.MINT_PRICE_TIMEOUT_MS + 200, 'the fallback gets only what remains of the initial deadline');
  assert.ok(performance.now() - start < ledger.MINT_PRICE_TIMEOUT_MS + 800);
  assert.ok(!e.lines.some((line) => ['local_rpc_rest', 'local_rpc_down'].includes(line.event)));
});

test('optional anchor diagnostics distinguish a failed subcall from a noncanonical three-word response', async () => {
  for (const success of [false, true]) {
    const world = v2World();
    const node = { fetch: async (url, init) => {
      const call = JSON.parse(init.body);
      if (call.method === 'eth_call' && Number(call.params[1]) === V2_MINT.block) {
        const data = success ? `0x${[OWNER_STATE.sqrtPriceX96, 1n, 0n].map((value) => word(value).slice(2)).join('')}` : '0x';
        const result = encodeAbiParameters([{ type: 'tuple[]', components: [{ type: 'bool', name: 'success' }, { type: 'bytes', name: 'returnData' }] }], [[{ success, returnData: data }]]);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
      }
      return world.chain.fetch(url, init);
    } };
    const e = edge(node);
    const result = await e.askOnce({ tokenIds: [ID], mintHints: [mintHint()] });
    assert.equal(result.status, 200);
    assert.equal(result.body.positions[0].exact, true);
    assert.equal(result.body.positions[0].mint.sqrtPriceX96, undefined);
    const diagnostic = e.lines.find((line) => line.event === 'ledger_mint_price');
    assert.equal(diagnostic.subcall, success ? 0 : 1);
    assert.equal(diagnostic.words3, success ? 1 : 0);
    assert.equal(diagnostic.invalid, success ? 1 : 0);
    assert.ok(!JSON.stringify(diagnostic).includes(OWNER_STATE.sqrtPriceX96.toString()));
    assert.ok(!JSON.stringify(diagnostic).includes(world.poolId));
  }
});

test('malformed or out-of-range historical prices never become chart anchors', async () => {
  for (const price of [0n, 1n << 160n]) {
    const world = v2World();
    const node = { fetch: async (url, init) => {
      const call = JSON.parse(init.body);
      if (call.method === 'eth_call' && Number(call.params[1]) === V2_MINT.block) {
        const data = `0x${[price, 1n, 0n, 3_000n].map((value) => word(value).slice(2)).join('')}`;
        const result = encodeAbiParameters([{ type: 'tuple[]', components: [{ type: 'bool', name: 'success' }, { type: 'bytes', name: 'returnData' }] }], [[{ success: true, returnData: data }]]);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
      }
      return world.chain.fetch(url, init);
    } };
    const result = await edge(node).askOnce({ tokenIds: [ID], mintHints: [mintHint()] });
    assert.equal(result.status, 200);
    assert.equal(result.body.positions[0].exact, true);
    assert.equal(result.body.positions[0].mint.sqrtPriceX96, undefined);
  }
});

test('a late optional failure preserves a finalized pool/block anchor saved by another request', async () => {
  const world = v2World({ head: V2_HEAD + fees.SAFE_DEPTH });
  const key = fees.cacheUrl(ORIGIN, 'mintPrice1', world.poolId, V2_MINT.block);
  let e;
  const node = { fetch: async (url, init) => {
    const call = JSON.parse(init.body);
    if (call.method === 'eth_call' && Number(call.params[1]) === V2_MINT.block) {
      e.stored.set(key, new Response(JSON.stringify({ sqrtPriceX96: OWNER_STATE.sqrtPriceX96.toString(), finalized: true }), { headers: { 'X-Fees-Stored-At': String(e.clock.time) } }));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'missing trie node' } }));
    }
    return world.chain.fetch(url, init);
  } };
  e = edge(node);
  const result = await e.askOnce({ tokenIds: [ID], mintHints: [mintHint()] });
  assert.equal(result.status, 200);
  assert.equal(result.body.positions[0].exact, true);
  const saved = await e.stored.get(key).clone().json();
  assert.deepEqual(saved, { sqrtPriceX96: OWNER_STATE.sqrtPriceX96.toString(), finalized: true });
});

test('an optional archive read is cancelled within its short budget without resting unrelated node reads', async () => {
  const world = v2World();
  let observedSignal;
  const node = { fetch: async (url, init) => {
    const call = JSON.parse(init.body);
    if (call.method === 'eth_call' && Number(call.params[1]) === V2_MINT.block) {
      observedSignal = init.signal;
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    }
    return world.chain.fetch(url, init);
  } };
  const e = edge(node);
  const start = performance.now();
  const result = await e.askOnce({ tokenIds: [ID], mintHints: [mintHint()] });
  assert.equal(result.status, 200);
  assert.equal(result.body.positions[0].exact, true);
  assert.equal(result.body.positions[0].mint.sqrtPriceX96, undefined);
  assert.equal(observedSignal.aborted, true);
  assert.equal(observedSignal.reason.name, 'AbortError');
  assert.equal(e.lines.find((line) => line.event === 'ledger_mint_price').deadline, 1);
  assert.ok(performance.now() - start < ledger.MINT_PRICE_TIMEOUT_MS + 1_000);
  assert.ok(!e.lines.some((line) => ['local_rpc_rest', 'local_rpc_down'].includes(line.event)));
});

// ---------------------------------------------------------------------------
// What a ledger says
// ---------------------------------------------------------------------------

test('the owner’s Auto-compound position: every compound’s exact fees and service fee from the engine’s own events; Fees earned is what the replay verified', async () => {
  const { chain } = ledgerWorld();
  const e = edge(chain);
  const { status, body } = await e.ask({ tokenIds: [ID] });
  assert.equal(status, 200);
  assert.ok(isLedgerResponse(body), 'the page’s own check passes');
  const [position] = body.positions;
  assert.equal(position.ok, true);
  assert.equal(position.exact, true);
  assert.equal(position.why, undefined);
  assert.equal(position.through, HEAD);
  assert.equal(position.vault, VAULT);
  assert.deepEqual(position.mint, { block: OWNER_MINT.block, tx: txOf(OWNER_MINT.block), t: position.mint.t, sqrtPriceX96: OWNER_STATE.sqrtPriceX96.toString() });
  assert.deepEqual(position.entries.map((entry) => [entry.kind, entry.block, entry.delta, entry.fees, entry.auto === true]), [
    ['mint', 73_233_307, '36560795792617752', ['0', '0'], false],
    ['increase', 73_468_040, '330426593119223', ['13102257', '1126639544530725964113'], true],
    ['collect', 73_564_797, '0', ['4902099', '1304189670377567194270'], true],
    ['increase', 73_564_797, '377765874452623', ['0', '0'], true],
    ['collect', 73_705_363, '0', ['4425004', '836433380491496904379'], true],
    ['increase', 73_705_363, '258607619495802', ['0', '0'], true],
  ]);
  // The service fee rides the transaction's first settlement; each a 2 % of what the compound used, per currency.
  assert.deepEqual(position.entries.filter((entry) => entry.service).map((entry) => entry.service), OWNER_STEPS.map((step) => step.service.map(String)));
  assert.ok(position.entries.every((entry, i) => i === 0 || entry.t >= position.entries[i - 1].t), 'header times, oldest first');
  // Folded with its state: the recording's own verified figures (expect.earned, expect.collected).
  const view = folded(body);
  assert.equal(view.phase, 'verified');
  assert.deepEqual(view.history.collected, [22_429_360n, 3_267_262_595_399_790_062_762n]);
  assert.deepEqual(view.history.earned, [22_523_160n, 6_935_401_632_110_906_894_871n]);
  assert.deepEqual(view.history.points.map((point) => point.kind), ['opened', 'settlement', 'settlement', 'settlement', 'now']);
});

test('what the node was asked: nothing below the floor, the PoolManager one block at a time, no pool history, and a second read only from the kept block', async () => {
  const { chain } = ledgerWorld();
  const e = edge(chain);
  await e.ask({ tokenIds: [ID] });
  const first = logReads(chain);
  assert.ok(first.length > 0);
  for (const filter of first) {
    assert.ok(Number(filter.fromBlock) >= FLOOR, `${filter.fromBlock}: nothing below block 69,249,061`);
    const addresses = [filter.address].flat();
    if (addresses.includes(fees.POOL_MANAGER)) assert.equal(filter.fromBlock, filter.toBlock, 'a PoolManager read is one block');
    assert.ok([filter.topics[0]].flat().every((topic) => local.LOG_TOPICS.includes(topic)), 'only our own events and the NFT’s');
  }
  const topics = new Set(first.map((filter) => filter.topics[0]));
  for (const pool of ['0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438', '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f', '0x29ef05caaff9404b7cb6d1c0e9bbae9eaa7ab2541feba1a9c4248594c08156cb']) assert.ok(!topics.has(pool), 'no Initialize, Swap or Donate');
  // The PoolManager's logs asked: the mint's block and the three compounds' blocks, each once.
  const lookups = first.filter((filter) => [filter.address].flat().includes(fees.POOL_MANAGER)).map((filter) => Number(filter.fromBlock));
  assert.deepEqual(lookups.sort((a, b) => a - b), [OWNER_MINT.block, ...OWNER_STEPS.map((step) => step.block)]);
  // The NFT's own Transfer logs from the floor: one first scan since the deploy (with the engine's and DominoSetupV1's
  // events for it, in the same read since the review of the rules, finding 7).
  assert.equal(first.filter((filter) => [filter.address].flat().includes(owned.POSITION_MANAGER) && Number(filter.fromBlock) === FLOOR).length, 1);
  // A minute later the head moved on: the kept ledger is read on from its last SAFE_DEPTH blocks only, and its kept
  // blocks are not looked into again.
  chain.log.length = 0;
  chain.head += 600;
  e.clock.time += 60_000;
  const again = await e.ask({ tokenIds: [ID] });
  assert.equal(again.body.positions[0].exact, true);
  const second = logReads(chain);
  assert.ok(second.length > 0);
  for (const filter of second) assert.ok(Number(filter.fromBlock) >= HEAD + 1 - fees.SAFE_DEPTH, `${Number(filter.fromBlock)}: from the kept block on`);
  assert.equal(second.filter((filter) => [filter.address].flat().includes(fees.POOL_MANAGER)).length, 0, 'no lookup again');
  assert.ok(second.every((filter) => Number(filter.toBlock) - Number(filter.fromBlock) < local.LOCAL_RPC_WIDE.blocks), 'never a wide scan');
});

test('the answer is kept half a minute for the same ids; a fresh question takes one only two seconds old', async () => {
  const { chain } = ledgerWorld();
  const e = edge(chain);
  await e.ask({ tokenIds: [ID] });
  const posts = chain.log.length;
  e.clock.time += 20_000;
  assert.equal((await e.ask({ tokenIds: [ID] })).status, 200);
  assert.equal(chain.log.length, posts, 'a kept answer: nothing asked of the node');
  assert.equal((await e.ask({ tokenIds: [ID], fresh: true })).status, 200);
  assert.ok(chain.log.length > posts, 'a fresh question past two seconds reads the node');
  const fresh = chain.log.length;
  e.clock.time += 1_000;
  await e.ask({ tokenIds: [ID], fresh: true });
  assert.equal(chain.log.length, fresh, 'a fresh question within two seconds of a read takes it');
});

test('an owner’s collect: its fees are the transfers the PoolManager paid the owner in it; the owner’s own swaps are not settlements', async () => {
  const steps = [
    { block: 73_300_000, kind: 'swap' },
    { block: 73_400_000, kind: 'collect', fees: [7_000_000n, 5n * 10n ** 18n] },
    { block: 73_500_000, kind: 'swap' },
  ];
  const { chain } = ledgerWorld({ vault: null, steps });
  const { body } = await edge(chain).ask({ tokenIds: [ID] });
  const [position] = body.positions;
  assert.equal(position.exact, true, position.why);
  assert.deepEqual(position.entries.map((entry) => [entry.kind, entry.fees, entry.auto === true]), [['mint', ['0', '0'], false], ['collect', ['7000000', '5000000000000000000'], false]]);
  assert.equal(position.vault, undefined);
  const view = folded(body);
  assert.deepEqual(view.history.collected, [7_000_000n, 5n * 10n ** 18n]);
  assert.deepEqual(view.history.earned, [7_000_000n + OWNER_STATE.unclaimed[0], 5n * 10n ** 18n + OWNER_STATE.unclaimed[1]]);
});

test('what cannot be told apart is said so, the settlements kept: an owner’s add, a collect that did more, ETH, a mint before the floor', async () => {
  const cases = [
    ['manual', { steps: [{ block: 73_400_000, kind: 'increase', delta: 10n ** 15n }], vault: null }],
    ['shared', { steps: [{ block: 73_400_000, kind: 'collect', fees: [1n, 2n] }, { block: 73_400_000, kind: 'other' }], vault: null }],
    ['native', { key: { ...KEY, currency0: '0x0000000000000000000000000000000000000000', currency1: USDG }, steps: [{ block: 73_400_000, kind: 'collect', fees: [1n, 2n] }], vault: null }],
    ['before_floor', { mint: { block: 60_000_000, liquidity: OWNER_MINT.liquidity }, steps: [], vault: null }],
    ['liquidity', { liquidity: 1n, steps: [] }],
    ['unseen', { checkpoint: 'stale' }],
  ];
  for (const [why, options] of cases) {
    routes.resetChainRouteMemory();
    const { chain } = ledgerWorld(options);
    const { status, body } = await edge(chain).ask({ tokenIds: [ID] });
    assert.equal(status, 200, why);
    assert.ok(isLedgerResponse(body), why);
    const [position] = body.positions;
    assert.equal(position.exact, false, why);
    assert.equal(position.why, why);
    const view = folded(body);
    assert.equal(view.phase, 'unclaimed-only', why);
    assert.equal(view.reason, 'not_exact');
    assert.equal(view.why, why);
    if (why === 'manual') assert.deepEqual(position.entries.map((entry) => [entry.kind, entry.fees]), [['mint', ['0', '0']], ['increase', null]], 'the add is listed, its fees not');
    if (why === 'before_floor') assert.ok(logReads(chain).every((filter) => Number(filter.toBlock) >= FLOOR), 'nothing below the floor even for an old NFT');
  }
});

test('an owner’s collect after the vault’s last compound is seen, and the vault’s stale checkpoint is then no surprise', async () => {
  const steps = [...OWNER_STEPS, { block: 73_900_000, kind: 'collect', fees: [3n, 4n] }];
  const { chain } = ledgerWorld({ steps, checkpoint: 'stale' });
  const { body } = await edge(chain).ask({ tokenIds: [ID] });
  assert.equal(body.positions[0].exact, true, body.positions[0].why);
  assert.deepEqual(body.positions[0].entries.at(-1).fees, ['3', '4']);
});

test('a long ledger is read in steps: each read looks into at most LEDGER_STEP blocks, keeps how far it got and says `reading`, the next goes on', async () => {
  // The owner traded in the pool's tokens in 450 blocks: each a block to look into.
  const steps = Array.from({ length: 450 }, (_, i) => ({ block: 73_300_000 + 1_000 * i, kind: 'swap' }));
  steps.push({ block: 73_800_000, kind: 'collect', fees: [9n, 9n] });
  const { chain } = ledgerWorld({ vault: null, steps });
  const e = edge(chain);
  const throughs = [];
  for (let round = 0; round < 6; round++) {
    const { body } = await e.ask({ tokenIds: [ID] });
    const [position] = body.positions;
    throughs.push(position.through);
    if (position.exact) break;
    assert.equal(position.why, 'reading');
    assert.ok(position.through < body.block);
    e.clock.time += 3_000;
  }
  assert.equal(throughs.at(-1), HEAD, 'read through to the head in the end');
  assert.ok(throughs.length >= 3, `${throughs.length} reads`);
  assert.ok(throughs.every((through, i) => i === 0 || through > throughs[i - 1]), 'each read went further');
  const lookups = logReads(chain).filter((filter) => [filter.address].flat().includes(fees.POOL_MANAGER));
  assert.ok(lookups.length <= 452 + ledger.LEDGER_STEP, `${lookups.length} one-block lookups in all`);
});

test('the route’s refusals: a body not exactly {"tokenIds": [1..8]} with at most "fresh": true is a 400, nothing asked of the node', async () => {
  const { chain } = ledgerWorld();
  const e = edge(chain);
  for (const body of [{}, { tokenIds: [] }, { tokenIds: ['1', '1'] }, { tokenIds: Array.from({ length: 9 }, (_, i) => String(i + 1)) }, { tokenIds: ['01'] }, { tokenIds: [ID], fresh: false }, { tokenIds: [ID], other: 1 }, 'nope']) {
    const { status, body: answer } = await e.ask(body);
    assert.equal(status, 400, JSON.stringify(body));
    assert.deepEqual(answer, { v: 1, error: 'bad_request' });
  }
  assert.equal(chain.log.length, 0);
  assert.deepEqual(ledger.ledgerRequestOf({ tokenIds: ['7', '3'], fresh: true }), { ids: [3n, 7n], fresh: true });
});

test('several positions in one answer, one of them unknown: each its own ledger, the unknown one not_found', async () => {
  const { chain } = ledgerWorld();
  const { body } = await edge(chain).ask({ tokenIds: [ID, '999'] });
  assert.deepEqual(body.positions.map((one) => [one.tokenId, one.ok, one.ok ? one.exact : one.reason]), [['999', false, 'not_found'], [ID, true, true]]);
});

test('a second position of the same owner in the same transaction’s other pool is not this one’s: the transfers of a mixed transaction are never taken', () => {
  // positionLogs' own shape, as the ledger reads it: a collect and another NFT's ModifyLiquidity in one transaction.
  const { logs } = positionLogs({ tokenId: 5n, owner: HOLDER, key: KEY, poolId: `0x${'ab'.repeat(32)}`, tickLower: -60, tickUpper: 60, mint: { block: 70_000_000, liquidity: 1n }, steps: [{ block: 70_000_100, kind: 'collect', fees: [1n, 1n] }, { block: 70_000_100, kind: 'other' }] });
  const modifies = logs.filter((log) => log.address === fees.POOL_MANAGER && Number(log.blockNumber) === 70_000_100);
  assert.equal(new Set(modifies.map((log) => log.transactionHash)).size, 1);
  assert.equal(modifies.length, 2);
});

// ---------------------------------------------------------------------------
// 2026-10-02: the review of rugged97's rules (findings 1, 4, 5, 7, 8, 9, 10 and 14)
// ---------------------------------------------------------------------------

const ROUTER = '0x66a9893cc07d91d95644aedd05d03f95e1dba8af';
const HEAVY = '0x4ea0000000000000000000000000000000000004';
const topicOf = (address) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
/** The node's log reads that are not one-block PoolManager lookups. */
const scans = (chain) => logReads(chain).filter((filter) => ![filter.address].flat().includes(fees.POOL_MANAGER));
/** Whether a log read names `address` among its topics (a holder's transfers). */
const names = (filter, address) => filter.topics.some((topic) => [topic].flat().includes(topicOf(address)));

/** Positions 2.. beside the owner's own (each a plain one, its own mint and a collect), for a world of `count`. */
function more(count, { owner = HOLDER, at = 73_300_000 } = {}) {
  const logs = [];
  const positions = [];
  for (let i = 1; i < count; i++) {
    const tokenId = 5_000_000n + BigInt(i);
    const mint = { block: at + 1_000 * i, liquidity: 10n ** 15n };
    const spec = { tokenId, owner, key: KEY, poolId: ledgerWorld().poolId, tickLower: OWNER_STATE.tickLower, tickUpper: OWNER_STATE.tickUpper, vault: null, mint, steps: [{ block: at + 1_000 * i + 500, kind: 'collect', fees: [BigInt(i), BigInt(2 * i)] }] };
    const events = positionLogs(spec);
    logs.push(...events.logs);
    positions.push({ tokenId, holder: owner, minter: owner, key: KEY, tickLower: spec.tickLower, tickUpper: spec.tickUpper, liquidity: events.liquidity, unclaimed: [0n, 0n], mintBlock: mint.block });
  }
  return { extraLogs: logs, extraPositions: positions, ids: [ID, ...positions.map((p) => String(p.tokenId))] };
}

test('eight positions read cold: each bounded discovery window shares one own-event read across all eight', async () => {
  const many = more(8);
  const { chain } = ledgerWorld({ extraLogs: many.extraLogs, extraPositions: many.extraPositions });
  const { status, body } = await edge(chain).ask({ tokenIds: many.ids });
  assert.equal(status, 200);
  assert.ok(body.positions.every((one) => one.ok && one.exact), JSON.stringify(body.positions.map((one) => one.why)));
  const reads = scans(chain);
  const discovery = reads.filter((filter) => filter.address === owned.POSITION_MANAGER && filter.topics[1] === word(0n));
  assert.equal(discovery.length, 1, 'one indexed mint read shared by all eight NFTs');
  assert.equal(discovery[0].topics[3].length, 8);
  const own = reads.filter((filter) => [filter.address].flat().includes(owned.POSITION_MANAGER) && !discovery.includes(filter));
  assert.equal(own.length, 1, 'settlement scan starts at the actual earliest mint');
  assert.deepEqual([own[0].address].flat().sort(), [owned.POSITION_MANAGER, ledger.ENGINE, owned.SETUP_CONTRACT, ledger.V2_ZAP, ledger.V2_FACTORY].sort());
  assert.equal(Number(own[0].fromBlock), OWNER_MINT.block);
  assert.equal(own[0].topics[3].length, 8, 'its eight ids in one place');
  assert.ok(own.every((filter) => filter.topics[3].length === 8 && Number(filter.toBlock) - Number(filter.fromBlock) < ledger.LEDGER_SCAN_BLOCKS));
  const paid = reads.filter((filter) => filter.topics[0] === owned.TRANSFER_TOPIC && !discovery.includes(filter));
  assert.equal(paid.length, 1, 'round two: one read of the owners’ transfers, both ways');
  assert.equal(Number(paid[0].fromBlock), OWNER_MINT.block, 'from the earliest mint');
  for (const filter of reads) assert.ok(Number(filter.toBlock) - Number(filter.fromBlock) + 1 <= local.LOCAL_RPC_LOG_BLOCKS);
});

test('an NFT sent to an address that is not Domino’s (a router): unseen, that address’s transfers never read, and nothing read for it again', async () => {
  const { chain } = ledgerWorld({ vault: null, steps: [], transfers: [{ block: 73_400_000, to: ROUTER }] });
  const e = edge(chain);
  const { status, body } = await e.ask({ tokenIds: [ID] });
  assert.equal(status, 200);
  assert.ok(isLedgerResponse(body));
  const [position] = body.positions;
  assert.deepEqual([position.exact, position.why, position.entries, position.through], [false, 'unseen', [], HEAD]);
  assert.ok(!logReads(chain).some((filter) => names(filter, ROUTER)), 'the router’s transfers are never asked');
  assert.ok(!logReads(chain).some((filter) => filter.topics[0] === owned.TRANSFER_TOPIC && filter.topics.length === 3), 'no holder’s transfers at all');
  assert.equal(folded(body).phase, 'unclaimed-only');
  // Kept as its verdict: a later question, fresh, reads the state and no log.
  chain.log.length = 0;
  chain.head += 600;
  e.clock.time += 60_000;
  const again = await e.ask({ tokenIds: [ID], fresh: true });
  assert.equal(again.body.positions[0].why, 'unseen');
  assert.deepEqual(logReads(chain), [], 'no log read');
  // Minted elsewhere, never through DominoSetupV1: the same.
  routes.resetChainRouteMemory();
  const elsewhere = ledgerWorld({ vault: null, setup: false, steps: [{ block: 73_400_000, kind: 'collect', fees: [1n, 1n] }] });
  const other = await edge(elsewhere.chain).ask({ tokenIds: [ID] });
  assert.equal(other.body.positions[0].why, 'unseen');
  assert.ok(!logReads(elsewhere.chain).some((filter) => names(filter, HOLDER)), 'its holder is not followed');
});

test('a Domino-compound position minted to its vault and handed back to the vault’s owner: both followed, exact; to anyone else, unseen', async () => {
  const handed = { setup: false, mintTo: VAULT, transfers: [{ block: 73_300_000, to: HOLDER }] };
  const { chain } = ledgerWorld(handed);
  const { body } = await edge(chain).ask({ tokenIds: [ID] });
  assert.equal(body.positions[0].exact, true, body.positions[0].why);
  routes.resetChainRouteMemory();
  const stranger = ledgerWorld({ ...handed, vaultOwner: ROUTER });
  const other = await edge(stranger.chain).ask({ tokenIds: [ID] });
  assert.equal(other.body.positions[0].why, 'unseen');
});

test('more holders than MAX_HOLDERS: too_many, kept as its verdict, so a later question reads no log for it', async () => {
  const transfers = Array.from({ length: ledger.MAX_HOLDERS }, (_, i) => ({ block: 73_300_000 + i, to: `0x${(0xb0b0 + i).toString(16).padStart(40, '0')}` }));
  const { chain } = ledgerWorld({ vault: null, steps: [], transfers });
  const e = edge(chain);
  const { body } = await e.ask({ tokenIds: [ID] });
  assert.equal(body.positions[0].why, 'too_many');
  assert.ok(!logReads(chain).some((filter) => filter.topics[0] === owned.TRANSFER_TOPIC && filter.topics.length === 3), 'no holder’s transfers read');
  chain.log.length = 0;
  e.clock.time += 3_000;
  assert.equal((await e.ask({ tokenIds: [ID], fresh: true })).body.positions[0].why, 'too_many');
  assert.deepEqual(logReads(chain), []);
});

test('a holder whose transfers are past ROUND_BYTES: that NFT is too_many and kept, the other of the question exact; alone, the same, never a 413 that keeps nothing', async () => {
  const heavyId = 7_777_777n;
  const heavy = positionLogs({ tokenId: heavyId, owner: HEAVY, key: KEY, poolId: ledgerWorld().poolId, tickLower: OWNER_STATE.tickLower, tickUpper: OWNER_STATE.tickUpper, vault: null, mint: { block: 73_300_000, liquidity: 10n ** 15n }, steps: [] });
  const world = ledgerWorld({ vault: null, steps: [{ block: 73_400_000, kind: 'collect', fees: [1n, 2n] }], extraLogs: heavy.logs, extraPositions: [{ tokenId: heavyId, holder: HEAVY, minter: HEAVY, key: KEY, tickLower: OWNER_STATE.tickLower, tickUpper: OWNER_STATE.tickUpper, liquidity: heavy.liquidity, unclaimed: [0n, 0n], mintBlock: 73_300_000 }] });
  const big = 'f'.repeat(ledger.ROUND_BYTES + 1024);
  let heavyReads = 0;
  // The node's answer to any read of HEAVY's transfers is more than a round may take.
  const node = {
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'eth_getLogs' && names(body.params[0], HEAVY)) {
        heavyReads += 1;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: [{ data: big }] }), { headers: { 'Content-Type': 'application/json' } });
      }
      return world.chain.fetch(url, init);
    },
  };
  const e = edge(node);
  const both = await e.ask({ tokenIds: [ID, String(heavyId)] });
  assert.equal(both.status, 200);
  const byId = new Map(both.body.positions.map((one) => [one.tokenId, one]));
  assert.equal(byId.get(ID).exact, true, byId.get(ID).why);
  assert.equal(byId.get(String(heavyId)).why, 'too_many');
  assert.equal(heavyReads, 2, 'together, then alone');
  // Alone, later: answered from its verdict, HEAVY's transfers never asked again.
  e.clock.time += 3_000;
  const alone = await e.ask({ tokenIds: [String(heavyId)], fresh: true });
  assert.equal(alone.status, 200);
  assert.equal(alone.body.positions[0].why, 'too_many');
  assert.equal(heavyReads, 2);
  // A first question of it alone: too_many at once (one read), never a 413.
  routes.resetChainRouteMemory();
  heavyReads = 0;
  const first = await edge(node).ask({ tokenIds: [String(heavyId)] });
  assert.deepEqual([first.status, first.body.positions[0].why, heavyReads], [200, 'too_many', 1]);
});

// 2026-10-02 (review of the rules, round 4): the question's byte budget running out was kept as a month's `too_many`.
const idWord = (id) => `0x${BigInt(id).toString(16).padStart(64, '0')}`;
const keptKeys = (stored) => [...stored.keys()].filter((url) => /\/cache\/c1\/ledger\d*\//.test(url)).map((url) => url.replace(`${ORIGIN}/api/fees/v1/cache/c1/`, ''));

test('the question’s byte budget running out is never a verdict: the NFTs it did not reach are `reading`, nothing kept for them, and answered the next time', async () => {
  // Three positions whose own round-one read is past ROUND_BYTES, and the owner's own position, last in the question.
  const heavyIds = [1_000_001n, 1_000_002n, 1_000_003n];
  const heavyPositions = heavyIds.map((tokenId) => ({ tokenId, holder: HEAVY, minter: HEAVY, key: KEY, tickLower: OWNER_STATE.tickLower, tickUpper: OWNER_STATE.tickUpper, liquidity: 10n ** 15n, unclaimed: [0n, 0n], mintBlock: 73_300_000 }));
  const world = ledgerWorld({ extraPositions: heavyPositions });
  const big = 'f'.repeat(ledger.ROUND_BYTES + 1024);
  let heavyReads = 0;
  const node = {
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'eth_getLogs' && body.params[0].topics[1] !== word(0n) && heavyIds.some((id) => [body.params[0].topics[3]].flat().includes(idWord(id)))) {
        heavyReads += 1;
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: [{ data: big }] }), { headers: { 'Content-Type': 'application/json' } });
      }
      return world.chain.fetch(url, init);
    },
  };
  const e = edge(node);
  const ids = [...heavyIds.map(String), ID];
  const first = await e.ask({ tokenIds: ids });
  assert.equal(first.status, 200);
  assert.ok(isLedgerResponse(first.body), 'the page’s own check passes');
  const whys = (body) => Object.fromEntries(body.positions.map((one) => [one.tokenId, one.why ?? 'exact']));
  // Together, then the first two alone: each its own read past its cap, a verdict. The budget then holds no further round
  // read: the third and the owner's are not answered this time, never `too_many`.
  assert.deepEqual(whys(first.body), { [ids[0]]: 'too_many', [ids[1]]: 'too_many', [ids[2]]: 'reading', [ID]: 'reading' });
  assert.equal(heavyReads, 3);
  const owner = first.body.positions.find((one) => one.tokenId === ID);
  assert.deepEqual([owner.exact, owner.entries, owner.mint], [false, [], null]);
  assert.ok(owner.through < first.body.block);
  assert.deepEqual(keptKeys(e.stored).sort(), [`ledger2/${ids[0]}/0`, `ledger2/${ids[1]}/0`], 'only the two verdicts kept; no whole answer either');
  // The next question: the third's own read is its verdict, and the owner's is answered, exact.
  e.clock.time += 3_000;
  const second = await e.ask({ tokenIds: ids });
  assert.deepEqual(whys(second.body), { [ids[0]]: 'too_many', [ids[1]]: 'too_many', [ids[2]]: 'too_many', [ID]: 'exact' });
  assert.equal(heavyReads, 4, 'the third reads alone from its proven mint; the first two are not read again');
  // A `too_many` is kept an hour, then read again.
  e.clock.time += ledger.TOO_MANY_SECONDS * 1000 - 60_000;
  await e.ask({ tokenIds: [ids[0]] });
  assert.equal(heavyReads, 4, 'within its hour: its verdict');
  e.clock.time += 60_000;
  const again = await e.ask({ tokenIds: [ids[0]] });
  assert.equal(again.body.positions[0].why, 'too_many');
  assert.equal(heavyReads, 5, 'past its hour: read again');
});

test('the ledger’s keys are version 2: a verdict a spent budget kept under the old keys is never read', async () => {
  assert.equal(ledger.LEDGER_KEYS, 2);
  const { poolId } = ledgerWorld();
  const verdict = { v: 2, poolId, through: HEAD, scanned: HEAD, mint: null, holders: [], trusted: [], vaults: [], entries: [], final: 'too_many', pending: { candidates: [], realized: [], service: [], paidIn: [], paidOut: [] } };
  const kept = (clock) => new Response(JSON.stringify(verdict), { headers: { 'Content-Type': 'application/json', 'X-Fees-Stored-At': String(clock.time) } });
  // Under the old key (what the preview's edge cache may hold): ignored, the ledger read and exact.
  const old = edge(ledgerWorld().chain);
  old.stored.set(`${ORIGIN}/api/fees/v1/cache/c1/ledger/${ID}/0`, kept(old.clock));
  const read = await old.ask({ tokenIds: [ID] });
  assert.equal(read.body.positions[0].exact, true, read.body.positions[0].why);
  assert.ok(keptKeys(old.stored).includes(`ledger2/${ID}/0`));
  assert.ok([...old.stored.keys()].some((url) => url.includes('/cache/c1/ledgerAnswer2/')), 'the whole answer under its new key');
  // The same verdict under the new key is the ledger's own (so the bump is what retires the old one).
  routes.resetChainRouteMemory();
  const current = edge(ledgerWorld().chain);
  current.stored.set(`${ORIGIN}/api/fees/v1/cache/c1/ledger2/${ID}/0`, kept(current.clock));
  assert.equal((await current.ask({ tokenIds: [ID] })).body.positions[0].why, 'too_many');
});

test('a reply cut by the question’s own budget is `budget_spent`, never the read’s own `attempt_cap`', async () => {
  const big = JSON.stringify({ jsonrpc: '2.0', id: 1, result: ['x'.repeat(4096)] });
  const rt = { deps: { fetch: async () => new Response(big, { headers: { 'Content-Type': 'application/json' } }), sleep: async () => {}, now: () => 0 }, cache: null };
  const own = fees.newBudget(rt);
  await assert.rejects(fees.post(rt, own, {}, true, 1024), (error) => error.message === 'attempt_cap');
  const spent = fees.newBudget(rt);
  spent.bytes = fees.MAX_BYTES - 512;
  await assert.rejects(fees.post(rt, spent, {}, true, 1024), (error) => error.message === 'budget_spent');
  const whole = fees.newBudget(rt);
  whole.bytes = fees.MAX_BYTES - 512;
  await assert.rejects(fees.post(rt, whole, {}, true), (error) => error.message === 'budget_spent');
  // A reply past the whole budget at a fresh answer stays the call's own cap.
  await assert.rejects(fees.post(rt, fees.newBudget(rt), {}, true, 1024), (error) => error.kind === 'bytes' && error.message === 'attempt_cap');
});

test('a ledger read in steps reads its logs once: each later step reads from where the last read ended, not from where its ledger ended', async () => {
  const steps = Array.from({ length: 450 }, (_, i) => ({ block: 73_300_000 + 1_000 * i, kind: 'swap' }));
  steps.push({ block: 73_800_000, kind: 'collect', fees: [9n, 9n] });
  const { chain } = ledgerWorld({ vault: null, steps });
  const e = edge(chain);
  const first = await e.ask({ tokenIds: [ID] });
  assert.equal(first.body.positions[0].why, 'reading');
  for (let round = 0; round < 6; round++) {
    chain.log.length = 0;
    e.clock.time += 3_000;
    const { body } = await e.ask({ tokenIds: [ID] });
    for (const filter of scans(chain)) assert.ok(Number(filter.fromBlock) >= HEAD + 1 - fees.SAFE_DEPTH, `${Number(filter.fromBlock)}: only the last read's tail`);
    if (body.positions[0].exact) break;
  }
  const { body } = await e.ask({ tokenIds: [ID] });
  assert.equal(body.positions[0].exact, true, body.positions[0].why);
  assert.deepEqual(body.positions[0].entries.map((entry) => entry.kind), ['mint', 'collect']);
});

test('a node behind the block a ledger was kept through: read on from where it stands, never from the floor', async () => {
  const { chain } = ledgerWorld();
  const e = edge(chain);
  await e.ask({ tokenIds: [ID] });
  chain.log.length = 0;
  chain.head -= 50;
  e.clock.time += 60_000;
  const { body } = await e.ask({ tokenIds: [ID] });
  assert.equal(body.positions[0].exact, true, body.positions[0].why);
  assert.equal(body.block, HEAD - 50);
  assert.ok(scans(chain).every((filter) => Number(filter.fromBlock) >= HEAD - 50 + 1 - fees.SAFE_DEPTH), 'nothing from the floor');
});

test('a pool in native ETH: a plain position is never exact (a collect paid only in ETH leaves no log); a vault’s, whose checkpoint vouches, is', async () => {
  const native = { ...KEY, currency0: '0x0000000000000000000000000000000000000000', currency1: USDG };
  // Its mint only, as far as any log shows (an ETH-only collect would look the same).
  const plain = ledgerWorld({ key: native, vault: null, steps: [] });
  const { body } = await edge(plain.chain).ask({ tokenIds: [ID] });
  assert.deepEqual([body.positions[0].exact, body.positions[0].why], [false, 'native']);
  routes.resetChainRouteMemory();
  const vaulted = ledgerWorld({ key: native });
  const held = await edge(vaulted.chain).ask({ tokenIds: [ID] });
  assert.equal(held.body.positions[0].exact, true, held.body.positions[0].why);
});

test('one ledger whose settlements remove more than they add is `liquidity` for good; the other positions of the question are answered and kept', async () => {
  const brokenId = 6_666_666n;
  const broken = positionLogs({ tokenId: brokenId, owner: HOLDER, key: KEY, poolId: ledgerWorld().poolId, tickLower: OWNER_STATE.tickLower, tickUpper: OWNER_STATE.tickUpper, vault: null, mint: { block: 73_300_000, liquidity: 10n ** 15n }, steps: [{ block: 73_400_000, kind: 'decrease', delta: 3n * 10n ** 15n }] });
  const { chain } = ledgerWorld({ extraLogs: broken.logs, extraPositions: [{ tokenId: brokenId, holder: HOLDER, minter: HOLDER, key: KEY, tickLower: OWNER_STATE.tickLower, tickUpper: OWNER_STATE.tickUpper, liquidity: 1n, unclaimed: [0n, 0n], mintBlock: 73_300_000 }] });
  const e = edge(chain);
  const { status, body } = await e.ask({ tokenIds: [ID, String(brokenId)] });
  assert.equal(status, 200);
  const byId = new Map(body.positions.map((one) => [one.tokenId, one]));
  assert.equal(byId.get(ID).exact, true, byId.get(ID).why);
  assert.equal(byId.get(String(brokenId)).why, 'liquidity');
  // Both kept: a minute later, neither is read from the floor.
  chain.log.length = 0;
  chain.head += 600;
  e.clock.time += 60_000;
  await e.ask({ tokenIds: [ID, String(brokenId)] });
  assert.ok(scans(chain).every((filter) => Number(filter.fromBlock) >= HEAD + 1 - fees.SAFE_DEPTH));
});

test('a question still too large is kept a while (413 at once, nothing asked); one our own time-out ended is kept a minute', async () => {
  const { chain } = ledgerWorld();
  const big = 'e'.repeat(ledger.ROUND_BYTES + 1024);
  // Every one-block lookup of the PoolManager answers more than a round may take.
  const node = {
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'eth_getLogs' && [body.params[0].address].flat().includes(fees.POOL_MANAGER)) return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: [{ data: big }] }), { headers: { 'Content-Type': 'application/json' } });
      return chain.fetch(url, init);
    },
  };
  const e = edge(node);
  assert.equal((await e.ask({ tokenIds: [ID] })).status, 413);
  const posts = chain.log.length;
  e.clock.time += 60_000;
  const again = await e.ask({ tokenIds: [ID] });
  assert.deepEqual([again.status, again.body], [413, { v: 1, error: 'too_large' }]);
  assert.equal(chain.log.length, posts, 'nothing asked');
  e.clock.time += ledger.TOO_LARGE_SECONDS * 1000;
  await e.ask({ tokenIds: [ID] });
  assert.ok(chain.log.length > posts, 'read again once its while is over');

  // Our own time-out of a call (rpc_timeout): kept a minute, Retry-After 60.
  assert.equal(fees.failureSeconds(new fees.RelayError('fatal', 'rpc_timeout')), 60);
  assert.equal(fees.failureSeconds(new fees.RelayError('fatal', 'http_500')), fees.FAILURE_SECONDS);
  const { cache } = memoryCache();
  let calls = 0;
  const clock = { time: 5_000_000 };
  const rt = {
    deps: {
      fetch: async () => {
        calls += 1;
        throw new DOMException('The node took too long', 'TimeoutError');
      },
      sleep: async () => {},
      now: () => clock.time,
    },
    cache,
  };
  const request = () => new Request(`${ORIGIN}/api/fees/v2/ledger`, { method: 'POST' });
  const slow = await ledger.ledgerAnswer(request(), rt, { ids: [3_325_113n], fresh: false });
  assert.deepEqual([slow.status, slow.headers.get('Retry-After')], [502, '60']);
  clock.time += 30_000;
  const kept = await ledger.ledgerAnswer(request(), rt, { ids: [3_325_113n], fresh: true });
  assert.equal(kept.status, 502);
  assert.equal(calls, 1, 'not sent again within the minute, fresh or not');
});
