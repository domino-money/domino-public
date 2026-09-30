/**
 * What Domino's automation did for a position (src/lib/automationImpact.ts, round 5, 2026-09-27): how an automatic
 * compound is told from the owner's own increase, and the figures the Fees earned card writes from it.
 *
 * The chain data here is the owner's own Auto-compound position, NFT 3325113 (USDG/UFG 4 %, vault
 * 0x5290e7d1a3cb728cc497b455e2397b3ec31eab69), read read-only from Robinhood Chain's public RPC on 2026-09-27: its mint
 * (DominoSetupV1, from the owner's wallet), and three executions the operator (0x2320…29da) sent to the vault: a NET
 * increase at 23:14 UTC (one ModifyLiquidity that settled the fees itself), then two collect-and-increase pairs at
 * 01:57 and 05:55 UTC. Each paid the vault's 2 % service fee to 0x1488…c6f4 and the liquidity to the PoolManager.
 * The pool's price is the one read at block 74,126,505, where the position's principal was $1,061.59.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { logLimitError } from './support/log-limits.mjs';

const require = createRequire(import.meta.url);
const impact = require('../.test-build/app/src/lib/automationImpact.js');
const value = require('../.test-build/app/src/components/positions/visual/value.js');

const TOKEN = '3325113';
const VAULT = '0x5290e7d1a3cb728cc497b455e2397b3ec31eab69';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const UFG = '0xefab538cf3c29237a47c6afb145d50ddf204a0a3';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const RECIPIENT = '0x1488c84dafc03f7f4c4fb986f83ba99fd530c6f4';
const TX = {
  mint: '0xb8261350a8f595944e1489f1cca8878c030670981c00cfc2183e00d2a367218b',
  net: '0x8f7546e00d814959ae8ca5f585d3a15caaa546e505433d65bae429cf1dff772a',
  second: '0x08a2da4c46e28a1f2f55642dfedcf048efdbec73fd2c0c5acab009465f035f7c',
  third: '0x6b5df10f9293d478e5ec587775b50bad47a9362eafa86976198151beea480d2e',
};
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const topic = (address) => `0x${address.slice(2).padStart(64, '0')}`;
const hex = (n) => `0x${n.toString(16)}`;

/** One of the vault's ExecutionCompleted logs, as the RPC sent it (topics: the intent and plan hashes). */
const executed = (tx, block, action, parent = TOKEN, destination = TOKEN, extra = {}) => ({
  address: VAULT,
  topics: [impact.EXECUTION_COMPLETED, `0x${'a3'.repeat(32)}`, `0x${'d8'.repeat(32)}`],
  data: `0x${word(action)}${word(parent)}${word(destination)}${word(3)}`,
  blockNumber: hex(block),
  transactionHash: tx,
  logIndex: '0x8',
  removed: false,
  ...extra,
});
const LOGS = [executed(TX.net, 73_468_040, 1), executed(TX.second, 73_564_797, 0), executed(TX.third, 73_705_363, 0)];

/** One ERC-20 transfer out of the vault, as the RPC sent it. */
const transfer = (tx, block, token, to, amount) => ({ address: token, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', topic(VAULT), topic(to)], data: `0x${word(amount)}`, blockNumber: hex(block), transactionHash: tx, logIndex: '0x1', removed: false });
/** The three transactions' transfers out of the vault, from their receipts: the liquidity to the PoolManager, the fee to its recipient. */
const TRANSFERS = [
  transfer(TX.net, 73_468_040, USDG, RECIPIENT, 129_309n),
  transfer(TX.net, 73_468_040, UFG, RECIPIENT, 22_420_126_936_161_376_268n),
  transfer(TX.second, 73_564_797, USDG, POOL_MANAGER, 2_393_742n),
  transfer(TX.second, 73_564_797, USDG, POOL_MANAGER, 4_768_068n),
  transfer(TX.second, 73_564_797, UFG, POOL_MANAGER, 5_520_533_768_203_260_464n),
  transfer(TX.second, 73_564_797, UFG, POOL_MANAGER, 1_271_687_744_916_324_281_497n),
  transfer(TX.second, 73_564_797, USDG, RECIPIENT, 146_159n),
  transfer(TX.second, 73_564_797, UFG, RECIPIENT, 26_065_475_075_194_439_631n),
  transfer(TX.third, 73_705_363, USDG, POOL_MANAGER, 796_265n),
  transfer(TX.third, 73_705_363, USDG, POOL_MANAGER, 4_310_840n),
  transfer(TX.third, 73_705_363, UFG, POOL_MANAGER, 6_418_132_053_691_031_232n),
  transfer(TX.third, 73_705_363, UFG, POOL_MANAGER, 815_574_098_656_989_588_275n),
  transfer(TX.third, 73_705_363, USDG, RECIPIENT, 104_226n),
  transfer(TX.third, 73_705_363, UFG, RECIPIENT, 16_775_351_647_156_747_336n),
];

/** The NFT's settlements as its fees history holds them (fees settled; liquidity added), in chain order. */
const EVENTS = [
  { kind: 'mint', block: 73_233_307, timestamp: 1_790_440_824, tx: TX.mint, fees: [0n, 0n], liquidityDelta: 36_560_795_792_617_752n },
  { kind: 'increase', block: 73_468_040, timestamp: 1_790_464_468, tx: TX.net, fees: [13_102_300n, 1_126_640_000_000_000_000_000n], liquidityDelta: 330_426_593_119_223n },
  { kind: 'collect', block: 73_564_797, timestamp: 1_790_474_265, tx: TX.second, fees: [4_902_099n, 1_304_189_670_377_567_194_270n], liquidityDelta: 0n },
  { kind: 'increase', block: 73_564_797, timestamp: 1_790_474_265, tx: TX.second, fees: [0n, 0n], liquidityDelta: 377_765_874_452_623n },
  { kind: 'collect', block: 73_705_363, timestamp: 1_790_488_510, tx: TX.third, fees: [4_425_004n, 836_433_380_491_496_904_379n], liquidityDelta: 0n },
  { kind: 'increase', block: 73_705_363, timestamp: 1_790_488_510, tx: TX.third, fees: [0n, 0n], liquidityDelta: 258_607_619_495_802n },
];
const STATE = {
  block: 74_126_505,
  timestamp: 1_790_531_021,
  sqrtPriceX96: 1_444_395_114_968_365_204_920_726_338_179_518_260n,
  tick: 334_389,
  tickLower: 327_200,
  tickUpper: 339_200,
  liquidity: 37_527_595_879_685_400n,
  unclaimed: [0n, 0n],
  poolId: `0x031fe000${'0'.repeat(56)}`,
  owner: '0xf6184f814543b88dd867c34ce6e9f56ab7d18c0a',
  currencies: [{ address: USDG, symbol: 'USDG', decimals: 6 }, { address: UFG, symbol: 'UFG', decimals: 18 }],
};
const BASIS = value.basisOf(STATE, 1);
const usd = (units) => value.unitsText(units).replace(/(\.\d\d)\d*$/, '$1');
const worth = (liquidity) => value.valueUnits(BASIS, value.principalAt(liquidity, STATE.sqrtPriceX96, STATE.tick, STATE.tickLower, STATE.tickUpper));
const run = (record, overrides = {}) => impact.automationImpact({ tokenId: TOKEN, kind: 'compound', history: { events: EVENTS }, state: STATE, basis: BASIS, record, ...overrides });

test('the vault’s ExecutionCompleted logs name the NFT’s automatic compounds, oldest first; any log that is not what was asked for names nothing', () => {
  const executions = impact.executionsOf([LOGS[2], LOGS[0], LOGS[1]], VAULT, TOKEN);
  assert.deepEqual(executions, [
    { tx: TX.net, block: 73_468_040, action: 1, destination: TOKEN },
    { tx: TX.second, block: 73_564_797, action: 0, destination: TOKEN },
    { tx: TX.third, block: 73_705_363, action: 0, destination: TOKEN },
  ]);
  // Another root of the same vault, and a removed log (a reorg), are left out.
  assert.deepEqual(impact.executionsOf([executed(TX.mint, 73_300_000, 0, '42', '42'), executed(TX.net, 73_468_040, 1, TOKEN, TOKEN, { removed: true })], VAULT, TOKEN), []);
  // Another contract's log, another event, a short data field, a bad hash, or no array: nothing at all.
  for (const bad of [
    { ...LOGS[0], address: '0x1111111111111111111111111111111111111111' },
    { ...LOGS[0], topics: [`0x${'00'.repeat(32)}`, ...LOGS[0].topics.slice(1)] },
    { ...LOGS[0], data: LOGS[0].data.slice(0, -64) },
    { ...LOGS[0], transactionHash: '0x1234' },
    { ...LOGS[0], data: `0x${word(256)}${LOGS[0].data.slice(66)}` },
  ]) assert.equal(impact.executionsOf([LOGS[1], bad], VAULT, TOKEN), null);
  assert.equal(impact.executionsOf({ result: LOGS }, VAULT, TOKEN), null);
});

test('the service fee of each compound is the pair’s transfers out of the vault in it but its payments to the PoolManager', () => {
  const paid = impact.paymentsOf(TRANSFERS, VAULT, [USDG, UFG], new Set(Object.values(TX)));
  assert.deepEqual([...paid], [
    [TX.net, [129_309n, 22_420_126_936_161_376_268n]],
    [TX.second, [146_159n, 26_065_475_075_194_439_631n]],
    [TX.third, [104_226n, 16_775_351_647_156_747_336n]],
  ]);
  // It is 2 % of what the vault put back: the second compound paid the PoolManager 7.16181 USDG and 1,277.208 UFG.
  assert.equal((7_161_810n + 146_159n) * 200n / 10_000n, 146_159n);
  // A transfer from anyone else, or of another token, is not what was asked for.
  assert.equal(impact.paymentsOf([...TRANSFERS, { ...TRANSFERS[0], topics: [TRANSFERS[0].topics[0], topic(RECIPIENT), topic(VAULT)] }], VAULT, [USDG, UFG], new Set([TX.net])), null);
  assert.equal(impact.paymentsOf([{ ...TRANSFERS[0], address: POOL_MANAGER }], VAULT, [USDG, UFG], new Set([TX.net])), null);
  // A transaction that is no execution of this position is left out.
  assert.deepEqual([...impact.paymentsOf(TRANSFERS, VAULT, [USDG, UFG], new Set([TX.third]))].map(([tx]) => tx), [TX.third]);
});

test('NFT 3325113: Auto-compound added its fees back three times, $27.34 at today’s price, and the position grew 2.64 % over the owner’s deposit', () => {
  const executions = impact.executionsOf(LOGS, VAULT, TOKEN);
  const paid = impact.paymentsOf(TRANSFERS, VAULT, [USDG, UFG], new Set(executions.map((e) => e.tx)));
  const result = run({ executions, paid });
  assert.equal(result.kind, 'compound');
  assert.deepEqual(result.adds.map((add) => [add.tx, add.timestamp, add.liquidity]), [
    [TX.net, 1_790_464_468, 330_426_593_119_223n],
    [TX.second, 1_790_474_265, 377_765_874_452_623n],
    [TX.third, 1_790_488_510, 258_607_619_495_802n],
  ]);
  // Each re-add is what its liquidity is worth now; together, the re-added share of the principal ($1,061.59).
  assert.deepEqual(result.adds.map((add) => usd(add.value)), ['9.34', '10.68', '7.31']);
  assert.equal(usd(result.added), '27.34');
  assert.equal(usd(worth(STATE.liquidity)), '1061.59');
  const share = Number((result.added * 1_000_000n) / worth(STATE.liquidity)) / 1_000_000;
  assert.ok(Math.abs(share - 966_800_086_867_648 / 37_527_595_879_685_400) < 1e-5, String(share));
  // The fees are the transfers themselves, at today's price.
  assert.equal(result.exactFees, true);
  assert.deepEqual(result.adds.map((add) => usd(add.fee)), ['0.19', '0.22', '0.15']);
  assert.equal(result.fees, result.adds.reduce((sum, add) => sum + add.fee, 0n));
  // 966,800,086,867,648 of liquidity added by the vault over the mint's 36,560,795,792,617,752.
  assert.equal(result.growth, 0.026443);
  assert.equal(result.opened, 0);
  assert.equal(result.moved, 0n);
});

test('without the transfers (a native currency), each fee is the policy’s rate on what was put back, and marked approximate', () => {
  const executions = impact.executionsOf(LOGS, VAULT, TOKEN);
  const result = run({ executions, paid: null });
  assert.equal(result.exactFees, false);
  for (const add of result.adds) assert.equal(add.fee, (add.value * 200n) / 9_800n);
  const domino = run({ executions, paid: null }, { kind: 'domino' });
  for (const add of domino.adds) assert.equal(add.fee, (add.value * 400n) / 9_600n);
});

test('only the vault’s own executions count: the owner’s increase is the owner’s, a decrease takes from both parts, and nothing done is nothing said', () => {
  const executions = impact.executionsOf(LOGS, VAULT, TOKEN);
  // The owner adds as much as the mint by hand: the growth halves, the re-adds are the same three.
  const own = { kind: 'increase', block: 73_800_000, timestamp: 1_790_500_000, tx: `0x${'ee'.repeat(32)}`, fees: [0n, 0n], liquidityDelta: 36_560_795_792_617_752n };
  const doubled = run({ executions, paid: null }, { history: { events: [...EVENTS, own] } });
  assert.equal(doubled.adds.length, 3);
  assert.equal(doubled.growth, 0.013221);
  // A decrease of half the position keeps the proportion; closing it leaves no owner's part to grow over.
  const half = { kind: 'decrease', block: 73_900_000, timestamp: 1_790_510_000, tx: `0x${'dd'.repeat(32)}`, fees: [0n, 0n], liquidityDelta: -18_763_797_939_842_700n };
  assert.equal(run({ executions, paid: null }, { history: { events: [...EVENTS, half] } }).growth, 0.026443);
  const close = { ...half, kind: 'close', liquidityDelta: -STATE.liquidity };
  assert.equal(run({ executions, paid: null }, { history: { events: [...EVENTS, close] } }).growth, null);
  // An execution with no increase of this NFT in its transaction, or none at all: nothing to say.
  assert.equal(run({ executions: [], paid: new Map() }), null);
  assert.equal(run({ executions: [{ tx: `0x${'ab'.repeat(32)}`, block: 1, action: 0, destination: TOKEN }], paid: new Map() }), null);
});

test('Domino-compound: the next positions it opened, and the fees it moved out of this one for them', () => {
  const executions = [
    ...impact.executionsOf(LOGS.slice(0, 2), VAULT, TOKEN),
    // The third transaction as the vault's MINT of a next position, #3400001, from this one's collected fees.
    { tx: TX.third, block: 73_705_363, action: impact.ACTION.MINT, destination: '3400001' },
  ];
  const events = EVENTS.filter((event) => !(event.tx === TX.third && event.kind === 'increase'));
  const result = run({ executions, paid: new Map() }, { kind: 'domino', history: { events } });
  assert.equal(result.adds.length, 2);
  assert.equal(result.opened, 1);
  assert.equal(result.moved, value.valueUnits(BASIS, EVENTS[4].fees));
  assert.equal(usd(result.moved), '6.94');
});

test('the vault is read from the chain by the page: its executions from the mint to the last settlement, then the fees in their blocks only', async () => {
  const flags = [globalThis.__DOMINO_DEPLOYABLE__, globalThis.__DOMINO_TEST_HOOKS__];
  globalThis.__DOMINO_DEPLOYABLE__ = true;
  globalThis.__DOMINO_TEST_HOOKS__ = false;
  try {
    const asked = [];
    const deps = (answer) => ({
      async fetch(url, init) {
        const call = JSON.parse(init.body);
        asked.push(call.params[0]);
        const reply = answer(call.params[0]);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, ...reply }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
      sleep: async () => undefined,
      now: () => Date.now(),
    });
    const chain = (filter) => {
      // 2026-09-28: the RPC's gateway refuses a range past its limits (tests/support/log-limits.mjs), as it does live.
      const limited = logLimitError(filter);
      if (limited) return { error: limited };
      if (filter.topics[0] === impact.EXECUTION_COMPLETED) {
        // The RPC refuses the whole range once: the page asks it in two halves.
        if (Number(filter.toBlock) - Number(filter.fromBlock) > 400_000) return { error: { code: -32005, message: 'block range is too wide' } };
        return { result: LOGS.filter((log) => Number(log.blockNumber) >= Number(filter.fromBlock) && Number(log.blockNumber) <= Number(filter.toBlock)) };
      }
      const addresses = [filter.address].flat();
      return { result: TRANSFERS.filter((log) => addresses.includes(log.address)) };
    };
    const record = await impact.readVault(VAULT, TOKEN, [USDG, UFG], 73_233_307, 73_705_363, deps(chain));
    assert.deepEqual(record.executions.map((e) => e.tx), [TX.net, TX.second, TX.third]);
    assert.equal(record.paid.size, 3);
    assert.deepEqual(asked.map((filter) => [filter.address, Number(filter.fromBlock), Number(filter.toBlock)]), [
      [VAULT, 73_233_307, 73_705_363],
      [VAULT, 73_233_307, 73_469_335],
      [VAULT, 73_469_336, 73_705_363],
      // Changed on purpose (2026-09-28: the RPC serves a filter with several addresses over 100,000 blocks at most): the
      // fees paid over these 237,324 blocks are asked one currency at a time.
      [USDG, 73_468_040, 73_705_363],
      [UFG, 73_468_040, 73_705_363],
    ]);
    // A native currency leaves no log: no transfer read, fees by the policy's rate.
    asked.length = 0;
    const native = await impact.readVault(VAULT, TOKEN, ['0x0000000000000000000000000000000000000000', USDG], 73_600_000, 73_705_363, deps(chain));
    assert.deepEqual([native.executions.length, native.paid, asked.length], [1, null, 1]);
    // A reply that is not what was asked for, or a bad argument: no record.
    assert.equal(await impact.readVault(VAULT, TOKEN, [USDG, UFG], 73_600_000, 73_705_363, deps(() => ({ result: [{ ...LOGS[2], address: USDG }] }))), null);
    assert.equal(await impact.readVault('0xNOT', TOKEN, [USDG, UFG], 1, 2, deps(chain)), null);
    // A build that reads no chain asks nothing.
    globalThis.__DOMINO_DEPLOYABLE__ = false;
    asked.length = 0;
    assert.equal(await impact.readVault(VAULT, TOKEN, [USDG, UFG], 73_233_307, 73_705_363, deps(chain)), null);
    assert.equal(asked.length, 0);
  } finally {
    [globalThis.__DOMINO_DEPLOYABLE__, globalThis.__DOMINO_TEST_HOOKS__] = flags;
  }
});

// 2026-09-28 (speed wave B, item 26: an automated position's card waited for its vault's record, read only once its chart
// was drawn): the page reads it as soon as its own read names the vault, from the factory's first block; a card whose
// blocks start there or later takes its part of it with nothing read again, and one whose blocks start earlier (no
// position Domino opened does) has it read again from there, whole, and waits for that read.
test('the vault read early, from the factory’s first block: a card within it reads nothing more; one from an earlier block reads again from there, and waits for it', async () => {
  const asked = [];
  const record = { executions: impact.executionsOf(LOGS, VAULT, TOKEN), paid: new Map() };
  const answers = [record, record];
  const store = impact.vaultStore(async (...ask) => { asked.push(ask.slice(3)); return answers.shift() ?? null; }, 60_000, { set: () => undefined, now: () => 0 });
  const settle = () => new Promise((done) => setImmediate(done));
  const stop = store.subscribe(() => undefined);
  assert.equal(impact.VAULT_FIRST_BLOCK, 69_239_633);
  store.want(VAULT, TOKEN, [USDG, UFG], impact.VAULT_FIRST_BLOCK, 74_118_377);
  // The card asks its own blocks while the early read is on its way: nothing more is read for them.
  store.want(VAULT, TOKEN, [USDG, UFG], 73_233_307, 73_705_363);
  await settle();
  await settle();
  assert.deepEqual(asked, [[impact.VAULT_FIRST_BLOCK, 74_118_377]]);
  assert.deepEqual([store.get(VAULT, TOKEN).from, store.get(VAULT, TOKEN).to], [impact.VAULT_FIRST_BLOCK, 74_118_377]);
  // A card from an earlier block (a recording older than the factory): read again from its block, to the end read so far.
  store.want(VAULT, TOKEN, [USDG, UFG], 60_000_000, 73_705_363);
  await settle();
  await settle();
  assert.deepEqual(asked.at(-1), [60_000_000, 74_118_377]);
  assert.equal(store.get(VAULT, TOKEN).from, 60_000_000);
  stop();
});

test('a vault read that fails is asked again a minute later, with the latest blocks wanted, while a screen shows it; the card is told it settled either way', async () => {
  let clock = 1_000_000;
  const timers = [];
  const asked = [];
  const answers = [null, { executions: impact.executionsOf(LOGS, VAULT, TOKEN), paid: new Map() }];
  const store = impact.vaultStore(async (...ask) => { asked.push(ask.slice(3)); return answers.shift() ?? null; }, 60_000, { set: (run, ms) => timers.push({ run, ms }), now: () => clock });
  const settle = () => new Promise((done) => setImmediate(done));
  let heard = 0;
  const stop = store.subscribe(() => { heard += 1; });
  assert.equal(store.get(VAULT, TOKEN), null, 'nothing read yet: the card waits');
  store.want(VAULT, TOKEN, [USDG, UFG], 73_233_307, 73_600_000);
  await settle();
  // The first read failed (a 429, a timeout): the card is told, with no record, and one retry is set for a minute on.
  // Changed on purpose 2026-09-28 (speed wave B, item 26): the entry says from which block it was read too.
  assert.deepEqual(store.get(VAULT, TOKEN), { from: 73_233_307, to: -1, record: null, failedAt: clock });
  assert.deepEqual([heard, timers.map((timer) => timer.ms)], [1, [60_000]]);
  // A new settlement in the meantime is not read at once; the retry asks for it.
  store.want(VAULT, TOKEN, [USDG, UFG], 73_233_307, 73_705_363);
  assert.equal(asked.length, 1);
  clock += 60_000;
  timers.shift().run();
  await settle();
  assert.deepEqual(asked, [[73_233_307, 73_600_000], [73_233_307, 73_705_363]]);
  const entry = store.get(VAULT, TOKEN);
  assert.deepEqual([entry.to, entry.failedAt, entry.record.executions.map((e) => e.tx)], [73_705_363, 0, [TX.net, TX.second, TX.third]]);
  assert.equal(heard, 2);
  assert.equal(timers.length, 0, 'nothing more to retry');
  // Once no screen shows it, a failure is not asked again by the timer (the next screen asks for itself).
  stop();
  answers.push(null);
  store.want(VAULT, '42', [USDG, UFG], 1, 2);
  await settle();
  clock += 60_000;
  timers.shift().run();
  await settle();
  assert.equal(asked.length, 3);
});

test('automation attribution exposes only full interval coverage, never an early warm record or failed expansion', () => {
  const record = { executions: impact.executionsOf(LOGS, VAULT, TOKEN), paid: new Map() };
  const complete = { from: 73_233_307, to: 73_705_363, record, failedAt: 0 };
  assert.equal(impact.coveredVaultRecord(null, complete.from, complete.to), null);
  assert.equal(impact.coveredVaultRecord(complete, complete.from, complete.to), record, 'exact inclusive coverage');
  assert.equal(impact.coveredVaultRecord(complete, complete.from + 1, complete.to - 1), record, 'a wider read covers the requested subset');
  assert.equal(impact.coveredVaultRecord({ ...complete, from: complete.from + 1 }, complete.from, complete.to), null, 'warm read omits the beginning');
  assert.equal(impact.coveredVaultRecord({ ...complete, to: complete.to - 1 }, complete.from, complete.to), null, 'retained read omits the latest settlement');
  assert.equal(impact.coveredVaultRecord({ ...complete, from: complete.from + 1, failedAt: 1_000_000 }, complete.from, complete.to), null, 'a failed earlier expansion cannot certify its retained partial record');
  assert.equal(impact.coveredVaultRecord({ ...complete, to: complete.to - 1, failedAt: 1_000_000 }, complete.from, complete.to), null, 'a failed later expansion cannot certify its retained partial record');
  assert.equal(impact.coveredVaultRecord({ ...complete, failedAt: 1_000_000 }, complete.from, complete.to), record, 'failure outside an already covered interval does not remove that interval');
  assert.equal(impact.coveredVaultRecord({ ...complete, record: null }, complete.from, complete.to), null);
});
