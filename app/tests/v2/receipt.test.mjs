/**
 * Domino V2's S1 receipt (spec F7 §2.11, §8.2): the zap's events, encoded here with viem from the exported ABIs (and
 * SwapLegExecuted from its Solidity declaration), become the receipt's lines, matched to the plan by the intent hash the
 * app computes. Only the zap's own logs count; another intent's events, a duplicate or a missing summary are closed
 * errors; the gas adds Base's L1 fee and nothing on Nitro; no USD anywhere.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, toEventSelector } from 'viem';

const require = createRequire(import.meta.url);
const receipts = require('../../.test-build/app/src/finance/v2/receipt.js');
const typed = require('../../.test-build/app/src/finance/v2/typedData.js');

const abiOf = (name) => JSON.parse(readFileSync(new URL(`../../../api-contracts/v2/abi/${name}.json`, import.meta.url), 'utf8')).abi;
const eventIn = (abi, name) => abi.find((item) => item.type === 'event' && item.name === name);
const EVENTS = {
  InputPulled: eventIn(abiOf('IDominoZap'), 'InputPulled'),
  PositionLiquidityChanged: eventIn(abiOf('IDominoZap'), 'PositionLiquidityChanged'),
  Refunded: eventIn(abiOf('IDominoPositionActions'), 'Refunded'),
  PositionActionExecuted: eventIn(abiOf('IDominoPositionActions'), 'PositionActionExecuted'),
  FeeCharged: eventIn(abiOf('IDominoFeeEvents'), 'FeeCharged'),
  FeeDeferred: eventIn(abiOf('IDominoFeeEvents'), 'FeeDeferred'),
  // Not exported (D7): as contracts/src/v2/route/DominoSwapExecutor.sol declares it.
  SwapLegExecuted: parseAbiItem('event SwapLegExecuted(uint8 indexed kind, address indexed tokenIn, address indexed tokenOut, address venue, uint256 amountIn, uint256 amountOut)'),
  Transfer: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
};

const ZAP = '0x00000000000000000000000000000000002a0d0d';
const OTHER = '0x0000000000000000000000000000000000000bad';
const OWNER = '0x0000000000000000000000000000000000000b0b';
const ETH = '0x0000000000000000000000000000000000000000';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const UNIVERSAL_ROUTER = '0x204faca1764b154221e35c0d20abb3c525710498';
const TX = `0x${'ab'.repeat(32)}`;
const POOL = { dex: 4, currency0: ETH, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: ETH };

/** A plan's intent: a create on ETH/USDG v4 unless told otherwise. */
const intentOf = (over = {}) => ({
  action: 1, pool: POOL, tokenId: 0n, tickLower: -201060, tickUpper: -198060, minLiquidity: 1n, feeBps: 65, feeToken: USDG,
  routesHash: `0x${'11'.repeat(32)}`, recipient: OWNER, nonce: 42n, deadline: 1790871000n, ...over,
});

/** One log, encoded as a node returns it. */
function log(name, args, address = ZAP) {
  const event = EVENTS[name];
  const topics = encodeEventTopics({ abi: [event], eventName: name, args });
  const unindexed = event.inputs.filter((input) => !input.indexed);
  const data = encodeAbiParameters(unindexed, unindexed.map((input) => args[input.name]));
  return { address, topics, data };
}
/** A receipt around logs, numbered in order, with Robinhood-like gas fields. */
function receiptOf(logs, extra = {}) {
  return {
    transactionHash: TX,
    status: '0x1',
    gasUsed: '0x61a80', // 400,000
    effectiveGasPrice: '0x989680', // 0.01 gwei
    logs: logs.map((entry, i) => ({ ...entry, logIndex: `0x${(i + 7).toString(16)}`, transactionHash: TX, removed: false })),
    ...extra,
  };
}
const read = (intent, logs, extra = {}, chainId = 4663, owner) => receipts.readZapReceipt({ chainId, zap: ZAP, intent, receipt: receiptOf(logs, extra), ...(owner ? { owner } : {}) });
const hashOf = (intent, chainId = 4663) => typed.intentHash(chainId, ZAP, intent);
const refuses = (fn, code) => assert.throws(fn, (error) => error instanceof Error && error.message === code, code);
/** A copy of an object without one key. */
const without = (key) => (value) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

// The events of each kind of action, as DominoZapBase emits them.
function createLogs(intent, hash = hashOf(intent)) {
  return [
    log('Transfer', { from: OWNER, to: ZAP, value: 1_000_000_000n }, USDG),
    log('InputPulled', { intentHash: hash, owner: OWNER, token: USDG, amount: 1_000_000_000n }),
    log('SwapLegExecuted', { kind: 3, tokenIn: USDG, tokenOut: ETH, venue: POOL_MANAGER, amountIn: 500_000_000n, amountOut: 199_000_000_000_000_000n }),
    log('FeeCharged', { kind: 1, token: USDG, payer: OWNER, amount: 3_250_000n, ref: hash }),
    log('PositionLiquidityChanged', { intentHash: hash, owner: OWNER, tokenId: 3409700n, pool: POOL, liquidityDelta: 123456789n, amount0: -199_000_000_000_000_000n, amount1: -496_000_000n }),
    log('Refunded', { recipient: OWNER, token: USDG, amount: 750_000n }),
    log('PositionActionExecuted', { action: 1, recipient: OWNER, tokenId: 3409700n, previousTokenId: 0n, liquidity: 123456789n, intentHash: hash }),
  ];
}

// ---------------------------------------------------------------------------
// The topics
// ---------------------------------------------------------------------------

test('every topic0 is its signature\'s and the spec\'s (§2.11 table), recomputed here', () => {
  const SPEC = {
    SwapLegExecuted: ['SwapLegExecuted(uint8,address,address,address,uint256,uint256)', '0x60154ef230959d31cc953d02fea179f08acb4195f22d3ac43bc9ce7219c0cf31'],
    FeeCharged: ['FeeCharged(uint8,address,address,uint256,bytes32)', '0x9a37304a80e9ccbeef339119cc8e57118bbbf4ba4b01df2a1ef6a0dc843a7bca'],
    FeeDeferred: ['FeeDeferred(address,uint256,uint256)', '0xf48e46df15f5fe31c1c79e6219014406d25e1f90301334682c98267482a8221b'],
    InputPulled: ['InputPulled(bytes32,address,address,uint256)', '0xc9ee6073c7a83985d230183c509eada6d701370f470716bde0c37568a49711ad'],
    PositionLiquidityChanged: ['PositionLiquidityChanged(bytes32,address,uint256,(uint8,address,address,uint24,int24,address),int256,int256,int256)', '0xf6a97c0d2054864127258f1e392259b35bdb4e5360f3f78285bf30675b4b8b9a'],
    Refunded: ['Refunded(address,address,uint256)', '0xec1e5ed733e00f1a00915d56caef57b4f52312dde4f9b3165f213319a0da156b'],
    PositionActionExecuted: ['PositionActionExecuted(uint8,address,uint256,uint256,uint128,bytes32)', '0xa7c6a820069d8f01991283e8f527fa1678590447c17064fd43148892d2863a92'],
  };
  for (const [name, [signature, topic]] of Object.entries(SPEC)) {
    assert.equal(toEventSelector(signature), topic, `${name}: the spec's topic0 is its signature's`);
    assert.equal(receipts.RECEIPT_TOPICS[name], topic, name);
    assert.equal(toEventSelector(EVENTS[name]), topic, `${name}: the ABI the fixtures are encoded from`);
  }
  assert.deepEqual(Object.keys(receipts.RECEIPT_TOPICS).sort(), Object.keys(SPEC).sort());
  assert.deepEqual(receipts.RECEIPT_LABELS, { paidIn: 'Paid in', swapped: 'Swapped', fee: 'Domino fee (0.65% of the amount swapped)', returned: 'Returned to your wallet' });
});

// ---------------------------------------------------------------------------
// The four actions
// ---------------------------------------------------------------------------

test('create with a swap leg, the fee and a refund: every line in log order, exact, and the summary', () => {
  const intent = intentOf();
  const hash = hashOf(intent);
  const said = read(intent, createLogs(intent));
  assert.equal(said.intentHash, hash);
  assert.equal(said.transactionHash, TX);
  assert.equal(said.zap, ZAP);
  assert.deepEqual(said.summary, { action: 1, actionName: 'create', recipient: OWNER, tokenId: 3409700n, previousTokenId: 0n, liquidity: 123456789n });
  assert.deepEqual(said.lines, [
    { kind: 'paid-in', logIndex: 8, token: USDG, amount: 1_000_000_000n, owner: OWNER },
    { kind: 'swapped', logIndex: 9, legKind: 3, tokenIn: USDG, tokenOut: ETH, venue: POOL_MANAGER, amountIn: 500_000_000n, amountOut: 199_000_000_000_000_000n },
    { kind: 'fee', logIndex: 10, token: USDG, amount: 3_250_000n, payer: OWNER },
    {
      kind: 'position', logIndex: 11, step: 'added', tokenId: 3409700n, pool: POOL, liquidity: 123456789n, owner: OWNER,
      amounts: [{ token: ETH, amount: 199_000_000_000_000_000n, direction: 'paid' }, { token: USDG, amount: 496_000_000n, direction: 'paid' }],
    },
    { kind: 'returned', logIndex: 12, token: USDG, amount: 750_000n, recipient: OWNER },
  ]);
  // §2.8 example 1: floor(500000000 × 65 / 10000) = 3250000, exactly what FeeCharged says.
  assert.deepEqual(said.fee, { token: USDG, amount: 3_250_000n, payer: OWNER });
  assert.equal((500_000_000n * 65n) / 10_000n, said.fee.amount);
  assert.deepEqual(said.deferredFees, []);
  assert.equal(said.owner, OWNER);
  // Robinhood is Nitro: gasUsed × effectiveGasPrice, no L1 part.
  assert.deepEqual(said.gas, { status: 'available', totalWei: 4_000_000_000_000n, executionWei: 4_000_000_000_000n, l1FeeWei: null });
  // Nothing in it is a USD figure, or a JS number where an amount belongs.
  assert.equal(JSON.stringify(said, (_k, v) => (typeof v === 'bigint' ? `${v}` : v)).match(/usd/i), null);
  assert.ok(Object.isFrozen(said) && Object.isFrozen(said.lines));
  // The owner the app expects matches.
  assert.equal(read(intent, createLogs(intent), {}, 4663, OWNER.toUpperCase().replace('0X', '0x')).owner, OWNER);
});

test('increase without a swap (v4, ETH and USDG paid in): no fee line, the same token id before and after', () => {
  const intent = intentOf({ action: 2, tokenId: 3409682n, feeBps: 0, feeToken: ETH, routesHash: typed.NO_LEGS_ROUTES_HASH });
  const hash = hashOf(intent);
  const said = read(intent, [
    log('InputPulled', { intentHash: hash, owner: OWNER, token: ETH, amount: 100_000_000_000_000_000n }),
    log('InputPulled', { intentHash: hash, owner: OWNER, token: USDG, amount: 250_000_000n }),
    log('PositionLiquidityChanged', { intentHash: hash, owner: OWNER, tokenId: 3409682n, pool: POOL, liquidityDelta: 5555n, amount0: -99_000_000_000_000_000n, amount1: -249_000_000n }),
    log('Refunded', { recipient: OWNER, token: ETH, amount: 1_000_000_000_000_000n }),
    log('Refunded', { recipient: OWNER, token: USDG, amount: 1_000_000n }),
    log('PositionActionExecuted', { action: 2, recipient: OWNER, tokenId: 3409682n, previousTokenId: 3409682n, liquidity: 5555n, intentHash: hash }),
  ]);
  assert.equal(said.fee, null);
  assert.deepEqual(said.lines.map((line) => line.kind), ['paid-in', 'paid-in', 'position', 'returned', 'returned']);
  assert.deepEqual(said.summary, { action: 2, actionName: 'increase', recipient: OWNER, tokenId: 3409682n, previousTokenId: 3409682n, liquidity: 5555n });
  assert.equal(said.lines[0].token, ETH);
});

test('change of range: the old position removed, a swap and its fee, the new one added; new token id, previous token id', () => {
  const intent = intentOf({ action: 3, tokenId: 3409682n, tickLower: -199020, tickUpper: -196020 });
  const hash = hashOf(intent);
  const said = read(intent, [
    log('PositionLiquidityChanged', { intentHash: hash, owner: OWNER, tokenId: 3409682n, pool: POOL, liquidityDelta: -5555n, amount0: 300_000_000_000_000_000n, amount1: 10_000_000n }),
    log('SwapLegExecuted', { kind: 1, tokenIn: ETH, tokenOut: USDG, venue: UNIVERSAL_ROUTER, amountIn: 100_000_000_000_000_000n, amountOut: 250_000_000n }),
    log('FeeCharged', { kind: 1, token: USDG, payer: OWNER, amount: 1_625_000n, ref: hash }),
    log('PositionLiquidityChanged', { intentHash: hash, owner: OWNER, tokenId: 3409701n, pool: POOL, liquidityDelta: 6000n, amount0: -199_000_000_000_000_000n, amount1: -258_000_000n }),
    log('Refunded', { recipient: OWNER, token: ETH, amount: 1_000_000_000_000_000n }),
    log('Refunded', { recipient: OWNER, token: USDG, amount: 375_000n }),
    log('PositionActionExecuted', { action: 3, recipient: OWNER, tokenId: 3409701n, previousTokenId: 3409682n, liquidity: 6000n, intentHash: hash }),
  ]);
  assert.deepEqual(said.summary, { action: 3, actionName: 'changeRange', recipient: OWNER, tokenId: 3409701n, previousTokenId: 3409682n, liquidity: 6000n });
  const steps = said.lines.filter((line) => line.kind === 'position');
  assert.deepEqual(steps.map((step) => [step.step, step.tokenId, step.liquidity]), [['removed', 3409682n, 5555n], ['added', 3409701n, 6000n]]);
  assert.deepEqual(steps[0].amounts.map((a) => a.direction), ['received', 'received']);
  assert.deepEqual(steps[1].amounts.map((a) => a.direction), ['paid', 'paid']);
  assert.deepEqual(said.fee, { token: USDG, amount: 1_625_000n, payer: OWNER });
});

test('exit converted to USDG: the fee is taken in the output token, the dust of ETH comes back', () => {
  const intent = intentOf({ action: 4, tokenId: 3409682n, minLiquidity: 5555n });
  const hash = hashOf(intent);
  const out = 1_352_500_000n;
  const fee = (out * 65n) / 10_000n; // §2.8 example 2: 8791250
  const said = read(intent, [
    log('PositionLiquidityChanged', { intentHash: hash, owner: OWNER, tokenId: 3409682n, pool: POOL, liquidityDelta: -5555n, amount0: 541_000_000_000_000_000n, amount1: 3_000_000_000n }),
    log('SwapLegExecuted', { kind: 3, tokenIn: ETH, tokenOut: USDG, venue: POOL_MANAGER, amountIn: 540_000_000_000_000_000n, amountOut: out }),
    log('FeeCharged', { kind: 1, token: USDG, payer: OWNER, amount: fee, ref: hash }),
    log('Refunded', { recipient: OWNER, token: USDG, amount: 3_000_000_000n + out - fee }),
    log('Refunded', { recipient: OWNER, token: ETH, amount: 1_000_000_000_000_000n }),
    log('PositionActionExecuted', { action: 4, recipient: OWNER, tokenId: 3409682n, previousTokenId: 3409682n, liquidity: 5555n, intentHash: hash }),
  ]);
  assert.equal(fee, 8_791_250n);
  assert.deepEqual(said.fee, { token: USDG, amount: 8_791_250n, payer: OWNER });
  assert.deepEqual(said.lines.filter((l) => l.kind === 'returned').map((l) => [l.token, l.amount]), [[USDG, 4_343_708_750n], [ETH, 1_000_000_000_000_000n]]);
  assert.equal(said.lines[0].step, 'removed');
  assert.equal(said.summary.actionName, 'exit');
});

test('collect only (an exit with liquidityToRemove 0): one "collected" step, paid straight to the owner, no fee, no refund', () => {
  const intent = intentOf({ action: 4, tokenId: 3409682n, minLiquidity: 0n, feeBps: 0, feeToken: ETH, routesHash: typed.NO_LEGS_ROUTES_HASH });
  const hash = hashOf(intent);
  const said = read(intent, [
    log('PositionLiquidityChanged', { intentHash: hash, owner: OWNER, tokenId: 3409682n, pool: POOL, liquidityDelta: 0n, amount0: 12_345_000_000_000n, amount1: 0n }),
    log('PositionActionExecuted', { action: 4, recipient: OWNER, tokenId: 3409682n, previousTokenId: 3409682n, liquidity: 0n, intentHash: hash }),
  ]);
  assert.deepEqual(said.lines, [{
    kind: 'position', logIndex: 7, step: 'collected', tokenId: 3409682n, pool: POOL, liquidity: 0n, owner: OWNER,
    amounts: [{ token: ETH, amount: 12_345_000_000_000n, direction: 'received' }, { token: USDG, amount: 0n, direction: 'none' }],
  }]);
  assert.equal(said.fee, null);
  assert.equal(said.summary.liquidity, 0n);
});

// ---------------------------------------------------------------------------
// Which logs count
// ---------------------------------------------------------------------------

test('a log with the same topic from another address is ignored, whatever it carries', () => {
  const intent = intentOf();
  const hash = hashOf(intent);
  const clean = read(intent, createLogs(intent));
  const logs = createLogs(intent);
  // Another contract emitting the zap's events with this plan's hash: a second "summary", a second fee, a refund.
  logs.splice(2, 0, log('FeeCharged', { kind: 1, token: USDG, payer: OWNER, amount: 999n, ref: hash }, OTHER));
  logs.splice(5, 0, log('Refunded', { recipient: OTHER, token: USDG, amount: 5n }, OTHER));
  logs.push(log('PositionActionExecuted', { action: 1, recipient: OWNER, tokenId: 1n, previousTokenId: 0n, liquidity: 1n, intentHash: hash }, OTHER));
  const said = read(intent, logs);
  assert.deepEqual(said.lines.map(without('logIndex')), clean.lines.map(without('logIndex')));
  assert.deepEqual(said.fee, clean.fee);
  assert.deepEqual(said.summary, clean.summary);
  // Only other addresses' summaries: none of the zap's.
  refuses(() => read(intent, [log('PositionActionExecuted', { action: 1, recipient: OWNER, tokenId: 1n, previousTokenId: 0n, liquidity: 1n, intentHash: hash }, OTHER)]), 'receipt_no_action');
});

test('another intent in the same transaction: each plan reads its own window, and an event of the other inside it is refused', () => {
  const ours = intentOf();
  const theirs = intentOf({ action: 2, tokenId: 77n, feeBps: 0, feeToken: ETH, nonce: 43n, routesHash: typed.NO_LEGS_ROUTES_HASH });
  const theirHash = hashOf(theirs);
  const theirLogs = [
    log('InputPulled', { intentHash: theirHash, owner: OWNER, token: USDG, amount: 10n }),
    log('PositionLiquidityChanged', { intentHash: theirHash, owner: OWNER, tokenId: 77n, pool: POOL, liquidityDelta: 9n, amount0: 0n, amount1: -9n }),
    log('Refunded', { recipient: OWNER, token: USDG, amount: 1n }),
    log('PositionActionExecuted', { action: 2, recipient: OWNER, tokenId: 77n, previousTokenId: 77n, liquidity: 9n, intentHash: theirHash }),
  ];
  const both = [...theirLogs, ...createLogs(ours)];
  const said = read(ours, both);
  assert.deepEqual(said.lines.filter((l) => l.kind === 'returned').map((l) => l.amount), [750_000n], 'their refund is not ours');
  assert.equal(said.lines.filter((l) => l.kind === 'paid-in').length, 1);
  const theirsRead = read(theirs, both);
  assert.deepEqual(theirsRead.lines.map((l) => l.kind), ['paid-in', 'position', 'returned']);
  assert.deepEqual(theirsRead.summary.tokenId, 77n);
  // Their InputPulled inside our window: refused, not dropped.
  const mixed = createLogs(ours);
  mixed.splice(2, 0, log('InputPulled', { intentHash: theirHash, owner: OWNER, token: USDG, amount: 10n }));
  refuses(() => read(ours, mixed), 'receipt_foreign_event');
  // One of ours outside our window (in theirs): refused.
  const stray = [log('InputPulled', { intentHash: hashOf(ours), owner: OWNER, token: USDG, amount: 1n }), ...theirLogs, ...createLogs(ours)];
  refuses(() => read(ours, stray), 'receipt_foreign_event');
  // A fee of another intent inside our window.
  const otherFee = createLogs(ours);
  otherFee.splice(4, 1, log('FeeCharged', { kind: 1, token: USDG, payer: OWNER, amount: 3_250_000n, ref: theirHash }));
  refuses(() => read(ours, otherFee), 'receipt_foreign_event');
});

test('the summary must be there once, for this plan\'s action', () => {
  const intent = intentOf();
  const hash = hashOf(intent);
  const logs = createLogs(intent);
  refuses(() => read(intent, logs.slice(0, -1)), 'receipt_no_action');
  refuses(() => read(intent, [...logs, logs[logs.length - 1]]), 'receipt_duplicate_action');
  const wrongAction = [...logs.slice(0, -1), log('PositionActionExecuted', { action: 2, recipient: OWNER, tokenId: 3409700n, previousTokenId: 0n, liquidity: 123456789n, intentHash: hash })];
  refuses(() => read(intent, wrongAction), 'receipt_action_mismatch');
  // A plan computed on another chain has another hash: nothing matches.
  refuses(() => receipts.readZapReceipt({ chainId: 8453, zap: ZAP, intent, receipt: receiptOf(logs) }), 'receipt_no_action');
  // Another zap address (the other dex's zap): nothing of this zap's.
  refuses(() => receipts.readZapReceipt({ chainId: 4663, zap: OTHER, intent, receipt: receiptOf(logs) }), 'receipt_no_action');
});

test('what the plan does not explain is refused: recipient, token ids, pool, steps, liquidity, fee, owner', () => {
  const intent = intentOf();
  const hash = hashOf(intent);
  const replace = (index, entry) => { const logs = createLogs(intent); logs.splice(index, 1, entry); return logs; };
  const pae = (over) => log('PositionActionExecuted', { action: 1, recipient: OWNER, tokenId: 3409700n, previousTokenId: 0n, liquidity: 123456789n, intentHash: hash, ...over });
  const plc = (over) => log('PositionLiquidityChanged', { intentHash: hash, owner: OWNER, tokenId: 3409700n, pool: POOL, liquidityDelta: 123456789n, amount0: -1n, amount1: -1n, ...over });
  refuses(() => read(intent, replace(6, pae({ recipient: OTHER }))), 'receipt_recipient_mismatch');
  refuses(() => read(intent, replace(5, log('Refunded', { recipient: OTHER, token: USDG, amount: 1n }))), 'receipt_recipient_mismatch');
  refuses(() => read(intent, replace(6, pae({ previousTokenId: 5n }))), 'receipt_position_mismatch');
  refuses(() => read(intent, replace(6, pae({ tokenId: 0n }))), 'receipt_position_mismatch');
  refuses(() => read(intent, replace(4, plc({ pool: { ...POOL, fee: 500, tickSpacing: 10 } }))), 'receipt_position_mismatch');
  refuses(() => read(intent, replace(4, plc({ tokenId: 1n }))), 'receipt_position_mismatch');
  refuses(() => read(intent, replace(4, plc({ liquidityDelta: -123456789n }))), 'receipt_position_mismatch');
  refuses(() => read(intent, replace(4, plc({ liquidityDelta: 1n }))), 'receipt_position_mismatch');
  refuses(() => read(intent, createLogs(intent).filter((_, i) => i !== 4)), 'receipt_position_mismatch');
  refuses(() => read(intent, replace(3, log('FeeCharged', { kind: 2, token: USDG, payer: OWNER, amount: 1n, ref: hash }))), 'receipt_fee_mismatch');
  refuses(() => read(intent, replace(3, log('FeeCharged', { kind: 1, token: ETH, payer: OWNER, amount: 1n, ref: hash }))), 'receipt_fee_mismatch');
  const twice = createLogs(intent);
  twice.splice(3, 0, log('FeeCharged', { kind: 1, token: USDG, payer: OWNER, amount: 1n, ref: hash }));
  refuses(() => read(intent, twice), 'receipt_fee_mismatch');
  // A fee on a plan that has none.
  const noFee = intentOf({ feeBps: 0, feeToken: ETH });
  refuses(() => read(noFee, createLogs(noFee).map((entry, i) => (i === 3 ? log('FeeCharged', { kind: 1, token: ETH, payer: OWNER, amount: 1n, ref: hashOf(noFee) }) : entry))), 'receipt_fee_mismatch');
  // Two owners, or not the expected one.
  refuses(() => read(intent, replace(1, log('InputPulled', { intentHash: hash, owner: OTHER, token: USDG, amount: 1n }))), 'receipt_owner_mismatch');
  refuses(() => read(intent, createLogs(intent), {}, 4663, OTHER), 'receipt_owner_mismatch');
  assert.throws(() => read(intent, createLogs(intent), {}, 4663, '0x12'), /invalid_owner/);
});

test('FeeDeferred is internal: kept apart, never a line, never a second charge', () => {
  const intent = intentOf();
  const logs = createLogs(intent);
  logs.splice(4, 0, log('FeeDeferred', { token: USDG, amount: 3_250_000n, totalOwed: 9_750_000n }));
  const said = read(intent, logs);
  assert.deepEqual(said.fee, { token: USDG, amount: 3_250_000n, payer: OWNER });
  assert.equal(said.lines.filter((line) => line.kind === 'fee').length, 1);
  assert.equal(said.lines.length, 5);
  assert.deepEqual(said.deferredFees, [{ token: USDG, amount: 3_250_000n, totalOwed: 9_750_000n }]);
});

test('the receipt itself: reverted, malformed, removed or mismatched logs are refused; logs are read in logIndex order', () => {
  const intent = intentOf();
  const logs = createLogs(intent);
  refuses(() => read(intent, logs, { status: '0x0' }), 'receipt_reverted');
  refuses(() => read(intent, logs, { status: undefined }), 'receipt_invalid');
  refuses(() => read(intent, logs, { logs: 'nope' }), 'receipt_invalid');
  const truncated = logs.map((entry, i) => (i === 1 ? { ...entry, data: entry.data.slice(0, 10) } : entry));
  refuses(() => read(intent, truncated), 'receipt_invalid');
  const badTopic = logs.map((entry, i) => (i === 2 ? { ...entry, topics: [entry.topics[0], '0x1234'] } : entry));
  refuses(() => read(intent, badTopic), 'receipt_invalid');
  const removed = receiptOf(logs);
  removed.logs[3].removed = true;
  refuses(() => receipts.readZapReceipt({ chainId: 4663, zap: ZAP, intent, receipt: removed }), 'receipt_invalid');
  const otherTx = receiptOf(logs);
  otherTx.logs[3].transactionHash = `0x${'cd'.repeat(32)}`;
  refuses(() => receipts.readZapReceipt({ chainId: 4663, zap: ZAP, intent, receipt: otherTx }), 'receipt_invalid');
  // Shuffled, with their logIndex: read in logIndex order all the same.
  const ordered = receiptOf(logs);
  const shuffled = { ...ordered, logs: [...ordered.logs].reverse() };
  assert.deepEqual(receipts.readZapReceipt({ chainId: 4663, zap: ZAP, intent, receipt: shuffled }).lines, read(intent, logs).lines);
  // Without logIndex: the node's order, with each line's position as its index.
  const bare = { ...ordered, logs: ordered.logs.map(without('logIndex')) };
  assert.deepEqual(receipts.readZapReceipt({ chainId: 4663, zap: ZAP, intent, receipt: bare }).lines.map((l) => l.logIndex), [1, 2, 3, 4, 5]);
  const duplicateIndex = receiptOf(logs);
  duplicateIndex.logs[2].logIndex = duplicateIndex.logs[3].logIndex;
  refuses(() => receipts.readZapReceipt({ chainId: 4663, zap: ZAP, intent, receipt: duplicateIndex }), 'receipt_invalid');
  assert.throws(() => receipts.readZapReceipt({ chainId: 1, zap: ZAP, intent, receipt: ordered }), /chain_not_supported/);
  assert.throws(() => receipts.readZapReceipt({ chainId: 4663, zap: '0x12', intent, receipt: ordered }), /invalid_zap/);
});

// ---------------------------------------------------------------------------
// Gas
// ---------------------------------------------------------------------------

test('gas: Base adds the receipt\'s l1Fee; Nitro chains add nothing; a missing field is unavailable, never zero', () => {
  const intent = intentOf();
  const base = receipts.readZapReceipt({ chainId: 8453, zap: ZAP, intent, receipt: receiptOf(createLogs(intent, hashOf(intent, 8453)), { l1Fee: '0x2540be400' }) });
  assert.deepEqual(base.gas, { status: 'available', totalWei: 4_000_000_000_000n + 10_000_000_000n, executionWei: 4_000_000_000_000n, l1FeeWei: 10_000_000_000n });
  // Robinhood and Arbitrum: an l1Fee field (if a node sent one) is not added; gasUsed already holds the L1 part.
  for (const chainId of [4663, 42161]) {
    assert.deepEqual(receipts.gasCost(chainId, { gasUsed: '0x61a80', effectiveGasPrice: '0x989680', l1Fee: '0x2540be400' }), { status: 'available', totalWei: 4_000_000_000_000n, executionWei: 4_000_000_000_000n, l1FeeWei: null });
  }
  assert.deepEqual(receipts.gasCost(8453, { gasUsed: '0x61a80', effectiveGasPrice: '0x989680' }), { status: 'unavailable', reason: 'l1_fee_missing' });
  assert.deepEqual(receipts.gasCost(4663, { effectiveGasPrice: '0x1' }), { status: 'unavailable', reason: 'gas_used_missing' });
  assert.deepEqual(receipts.gasCost(4663, { gasUsed: '0x1', effectiveGasPrice: null }), { status: 'unavailable', reason: 'gas_price_missing' });
  assert.deepEqual(receipts.gasCost(4663, { gasUsed: 'lots', effectiveGasPrice: '0x1' }), { status: 'unavailable', reason: 'gas_used_missing' });
  // A measured zero is zero, not unavailable; bigints are taken as they are.
  assert.deepEqual(receipts.gasCost(8453, { gasUsed: 21000n, effectiveGasPrice: 0n, l1Fee: 0n }), { status: 'available', totalWei: 0n, executionWei: 0n, l1FeeWei: 0n });
  // The receipt without gas fields still reads; only its gas is unavailable.
  const noGas = receipts.readZapReceipt({ chainId: 4663, zap: ZAP, intent, receipt: receiptOf(createLogs(intent), { gasUsed: undefined }) });
  assert.deepEqual(noGas.gas, { status: 'unavailable', reason: 'gas_used_missing' });
  assert.equal(noGas.lines.length, 5);
});
