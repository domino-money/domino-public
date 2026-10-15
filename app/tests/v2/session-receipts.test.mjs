/**
 * Added (2026-10-15, pack 8): rows at once after the person's own action (incident design 2.1, 2.2, package R1), and the
 * automation receipts brought forward by the page's own readings (the owner: every compound must reach Receipts quickly).
 * Pure modules only: the session receipts (src/v2in/lists/sessionReceipts.ts) and their rows' words (model.ts), Robinhood
 * Chain's created-position hint drawn from the list's own state reading (positionCollection.ts), the automation steps'
 * rows (sessionActivity.ts), the activity head's pace for a wallet with automation on (activityModel.ts) and the compound
 * signals of positionSync.ts.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const build = (path) => require(`../../.test-build/app/src/${path}.js`);
const { createSessionReceiptStore, sessionReceipts, sessionReceiptOfZap, sessionReceiptOfDirect } = build('v2in/lists/sessionReceipts');
const { sessionReceiptView, decodedEventWords, tokenNamer } = build('v2in/lists/model');
const { sessionAutomation, immediateRows, sessionActivity } = build('v2in/lists/sessionActivity');
const { createCreatedPositionStore } = build('v2in/lists/createdPositions');
const { withCreatedPositions, hasPositionApr } = build('v2in/lists/positionCollection');
const { quietWallet, automationOn } = build('v2in/lists/activityModel');
const { createPositionSync, stateCompounded, portfolioCompounds } = build('v2in/lists/positionSync');
const { headerTime } = build('finance/v2/transact');
const { v2Chain } = build('v2/chains');
const { POSITION_MANAGER } = build('lib/fees/constants');

const OWNER = `0x${'a'.repeat(40)}`;
const VAULT = `0x${'c'.repeat(40)}`;
const ZERO = '0x0000000000000000000000000000000000000000';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const HASH = `0x${'1'.repeat(64)}`;
const BLOCK_HASH = `0x${'2'.repeat(64)}`;
const NOW = 1_790_000_000_000;
const memory = () => { const saved = new Map(); return { saved, getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) }; };
/** The receipt as the money client returns it in a block (finance/v2/transact.ts V2Receipt), with the header's time. */
const included = (patch = {}) => ({ state: 'included', blockHash: BLOCK_HASH, blockNumber: 73_400_000n, blockTimestamp: 1_790_000_000, gasUsed: 512_345n, effectiveGasPrice: 20_000_000n, l1Fee: null, logs: [], ...patch });
/** A create on Robinhood Chain as the zap's receipt reader decodes it (finance/v2/receipt.ts ZapReceipt). */
const created = (tokenId = 9_000_001n) => ({
  summary: { actionName: 'create', tokenId, previousTokenId: 0n },
  lines: [
    { kind: 'paid-in', token: ZERO, amount: 100_000_000_000_000_000n },
    { kind: 'paid-in', token: USDG, amount: 1_000_000_000n },
    { kind: 'swapped', tokenIn: USDG, tokenOut: ZERO, amountIn: 500_000_000n, amountOut: 190_000_000_000_000_000n },
    { kind: 'fee', token: USDG, amount: 3_250_000n },
    { kind: 'position', step: 'added', tokenId, amounts: [{ token: ZERO, amount: 190_000_000_000_000_000n }, { token: USDG, amount: 490_000_000n }] },
    { kind: 'returned', token: USDG, amount: 6_750_000n },
  ],
  fee: { token: USDG, amount: 3_250_000n },
});
const TOKENS = [{ address: USDG, symbol: 'USDG', decimals: 6 }, { address: ZERO, symbol: 'ETH', decimals: 18 }];
const createEntry = (patch = {}) => ({ ...sessionReceiptOfZap({ wallet: OWNER, chainId: 4663, dex: 4, hash: HASH, receipt: included(), read: created(), tokens: TOKENS, now: NOW }), ...patch });
const indexedItem = (hash = HASH, chainId = 4663) => ({ id: `${chainId}:73400000:3`, kind: 's1_action', chainId, tx: { hash, snapshot: { number: 73_400_000, hash: BLOCK_HASH, timestamp: 1_790_000_000 }, finality: 'unfinalized' } });

test('a create checked in this browser is a receipt row at once, in the indexed row\'s own words, with the block\'s time', () => {
  const entry = createEntry();
  assert.deepEqual([entry.action, entry.tokenId, entry.at, entry.block, entry.state], ['create', '9000001', 1_790_000_000, 73_400_000, 'included']);
  const view = sessionReceiptView(entry, []);
  assert.equal(view.what, 'Created position #9000001', 'the title read-v6\'s s1_action row says');
  assert.equal(view.amount, '0.1 ETH', 'the first amount paid in, as the indexed row');
  assert.deepEqual(view.lines.map((line) => [line.label, line.value]), [
    ['Paid in', '0.1 ETH'], ['Paid in', '1,000 USDG'], ['Swapped', '500 USDG → 0.19 ETH'],
    ['Added to the position', '0.19 ETH + 490 USDG · position #9000001'], ['Returned to your wallet', '6.75 USDG'],
  ]);
  assert.deepEqual(view.fees.map((fee) => [fee.label, fee.value]), [['Domino fee (0.65% of the amount swapped)', '3.25 USDG']]);
  assert.deepEqual([view.confirmed, view.finalized, view.at, view.chain, view.kind], [true, false, 1_790_000_000, 'Robinhood Chain', 's1_action']);
  assert.deepEqual(view.gas, { sender: OWNER, gasUsed: '512,345', gasPrice: '0.02 gwei', l1Fee: null });
  // No header time named: no time drawn, never this page's clock.
  const untimed = sessionReceiptOfZap({ wallet: OWNER, chainId: 4663, dex: 4, hash: HASH, receipt: included({ blockTimestamp: undefined }), read: created(), tokens: TOKENS, now: NOW });
  assert.equal(untimed.at, null);
  assert.equal(sessionReceiptView(untimed, []).at, null);
  // The index's finality reaches it through the confirmation queue's word.
  assert.equal(sessionReceiptView(entry, [], () => 'finalized').finalized, true);
  assert.equal(sessionReceiptOfZap({ wallet: OWNER, chainId: 4663, dex: 4, hash: HASH, receipt: included({ state: 'reverted' }), read: created(), tokens: TOKENS }), null, 'a reverted transaction is no row');
});

test('the indexed item of the same transaction replaces the session row: never both, and the position\'s Activity shows only its own', () => {
  const entry = createEntry();
  assert.equal(sessionReceipts(OWNER.toUpperCase().replace('0X', '0x'), [entry], [], undefined, NOW).length, 1);
  assert.equal(sessionReceipts(OWNER, [entry], [indexedItem()], undefined, NOW).length, 0, 'listed by read-v6: its item is the row');
  assert.equal(sessionReceipts(OWNER, [entry], [indexedItem(HASH, 8453)], undefined, NOW).length, 1, 'the same hash on another chain is another transaction');
  assert.equal(sessionReceipts(`0x${'b'.repeat(40)}`, [entry], [], undefined, NOW).length, 0, 'another wallet\'s');
  assert.equal(sessionReceipts(OWNER, [entry], [], { chainId: 4663, dex: 4, tokenId: '9000001' }, NOW).length, 1);
  assert.equal(sessionReceipts(OWNER, [entry], [], { chainId: 4663, dex: 4, tokenId: '1' }, NOW).length, 0);
  assert.equal(sessionReceipts(OWNER, [entry], [], { chainId: 4663, dex: 3, tokenId: '9000001' }, NOW).length, 0);
  // One row per transaction among the rows drawn at once, newest first.
  const view = { view: sessionReceiptView(entry, []), observedAt: NOW };
  const later = { view: { ...sessionReceiptView({ ...entry, hash: `0x${'9'.repeat(64)}` }, []) }, observedAt: NOW + 5 };
  assert.deepEqual(immediateRows([], [], [view, later]).map((row) => row.key), [`4663:0x${'9'.repeat(64)}`, `4663:${HASH}`]);
});

test('session receipts survive a reload of the tab, leave storage once indexed, and go with a replaced block', () => {
  const storage = memory();
  let now = NOW + 1000;
  const store = createSessionReceiptStore(storage, () => now);
  let told = 0;
  store.subscribe(OWNER, () => told++);
  store.record(createEntry());
  store.record(createEntry());
  assert.equal(told, 1, 'the same inclusion said again changes nothing');
  store.record(createEntry({ state: 'finalized' }));
  assert.equal(store.get(OWNER)[0].state, 'finalized');
  assert.equal(createSessionReceiptStore(storage, () => now).get(OWNER).length, 1, 'a reload keeps it');
  store.reconcile(OWNER, [indexedItem()]);
  assert.equal(store.get(OWNER).length, 0, 'read-v6 lists it');
  store.record(createEntry());
  store.rollback(4663, BLOCK_HASH);
  assert.equal(store.get(OWNER).length, 0, 'a replaced block');
  store.record(createEntry({ wallet: `0x${'b'.repeat(40)}` }));
  assert.equal(store.get(OWNER).length, 0, 'kept under its own wallet only');
  now += 24 * 60 * 60_000;
  assert.equal(createSessionReceiptStore(storage, () => now).get(`0x${'b'.repeat(40)}`).length, 0, 'a day later it is gone');
  storage.saved.set(`domino:session-receipts:v1:${OWNER}`, JSON.stringify([{ ...createEntry(), lines: [{ kind: 'paid-in', token: 'nope', amount: '1' }] }]));
  assert.equal(createSessionReceiptStore(storage, () => NOW + 1).get(OWNER).length, 0, 'a malformed entry is dropped');
});

test('Collect fees and Withdraw straight at Uniswap: their own lines, "No Domino fee", a native amount the logs do not show is never guessed', () => {
  const base = { wallet: OWNER, chainId: 8453, dex: 4, tokenId: 77n, hash: HASH, receipt: included({ l1Fee: 1234n }), tokens: TOKENS, now: NOW };
  const usdc = v2Chain(8453).chargeCurrencies[0].address;
  const collect = sessionReceiptView(sessionReceiptOfDirect({ ...base, kind: 'collect', paid: [{ token: ZERO, amount: 10n ** 15n }, { token: usdc, amount: 2_500_000n }] }), []);
  assert.equal(collect.what, 'Fees collected');
  assert.deepEqual(collect.lines.map((line) => [line.label, line.value]), [['Fees collected', '0.001 ETH + 2.5 USDC · position #77'], ['Domino fee', 'No Domino fee']]);
  assert.equal(collect.gas.l1Fee, '0.000000000000001234 ETH');
  const close = sessionReceiptView(sessionReceiptOfDirect({ ...base, kind: 'close', paid: [{ token: ZERO, amount: null }, { token: usdc, amount: 7_000_000n }] }), []);
  assert.equal(close.what, 'Withdrew from position #77');
  assert.deepEqual(close.lines.map((line) => [line.label, line.value]), [['Returned to your wallet', 'ETH: amount not reported'], ['Returned to your wallet', '7 USDC'], ['Domino fee', 'No Domino fee']]);
  assert.equal(close.amount, '7 USDC');
});

test('a change of range names the position it came from; an add and a converted withdrawal take the indexed titles', () => {
  const change = sessionReceiptView(sessionReceiptOfZap({ wallet: OWNER, chainId: 42161, dex: 3, hash: HASH, receipt: included(), tokens: [], now: NOW,
    read: { summary: { actionName: 'changeRange', tokenId: 12n, previousTokenId: 11n }, lines: [], fee: null } }), []);
  assert.equal(change.what, 'Changed the range: position #12');
  assert.deepEqual(change.lines.map((line) => [line.label, line.value]), [['Previous position', '#11'], ['Domino fee', 'No Domino fee']]);
  for (const [actionName, title] of [['increase', 'Added to position #11'], ['exit', 'Withdrew from position #11']]) {
    const entry = sessionReceiptOfZap({ wallet: OWNER, chainId: 42161, dex: 3, hash: HASH, receipt: included(), tokens: [], now: NOW, read: { summary: { actionName, tokenId: 11n, previousTokenId: 11n }, lines: [], fee: null } });
    assert.equal(sessionReceiptView(entry, []).what, title);
    assert.equal(entry.previousTokenId, null);
  }
});

test('Robinhood Chain keeps its created-position hint, and its row is drawn from the list\'s own state reading at or past the receipt\'s block', () => {
  const storage = memory();
  const store = createCreatedPositionStore(storage, () => NOW + 1);
  const hint = { wallet: OWNER, chainId: 4663, positionManager: POSITION_MANAGER.toLowerCase(), dex: 4, tokenId: '9000001', hash: HASH, block: 73_400_000, blockHash: BLOCK_HASH, observedAt: NOW,
    fee: 500, tokens: [{ address: ZERO, symbol: 'ETH', decimals: 18 }, { address: USDG, symbol: 'USDG', decimals: 6 }] };
  store.record(hint);
  assert.equal(store.get(OWNER).length, 1, 'kept on Robinhood Chain (Base and Arbitrum One only before)');
  const [placeholder] = withCreatedPositions([], [hint], () => null);
  assert.deepEqual([placeholder.status, placeholder.tab, placeholder.value], ['not_read', 'pending', null], 'before its reading: the placeholder row');
  assert.equal(hasPositionApr(placeholder), true, 'so the list asks its state reading with the others (no read of its own)');
  const reading = (block, owner = OWNER) => ({ block, timestamp: 1_790_000_100, seen: NOW + 2, position: statePosition('9000001', owner) });
  const [row] = withCreatedPositions([], [hint], () => reading(73_400_001));
  assert.deepEqual([row.status, row.tab, row.state, row.key], ['live', 'open', 'in-range', `4663:${POSITION_MANAGER.toLowerCase()}:9000001`]);
  assert.ok(row.value && row.value.length === 2, 'its amounts, from the reading');
  assert.equal(withCreatedPositions([], [hint], () => reading(73_399_999))[0].status, 'not_read', 'a reading older than the receipt is not its state');
  assert.equal(withCreatedPositions([], [hint], () => reading(73_400_001, `0x${'d'.repeat(40)}`))[0].status, 'not_read', 'nor one held by someone else');
});

/** A position as the state route reads it (lib/fees/types.ts StatePositionOk). */
function statePosition(tokenId, owner, liquidity = '1000000000000000000', last = ['10', '20']) {
  return { tokenId, ok: true, owner, poolId: `0x${'e'.repeat(64)}`, poolKey: { currency0: ZERO, currency1: USDG, fee: 500, tickSpacing: 10, hooks: ZERO },
    currencies: [{ address: ZERO, symbol: 'ETH', decimals: 18 }, { address: USDG, symbol: 'USDG', decimals: 6 }], tickLower: -100, tickUpper: 100, liquidity,
    sqrtPriceX96: String(1n << 96n), tick: 0, feeGrowthInside0X128: '100', feeGrowthInside1X128: '100', feeGrowthInside0LastX128: last[0], feeGrowthInside1LastX128: last[1], unclaimed0: '5', unclaimed1: '6' };
}

test('every other automation step is a row at once in the indexed words; a setup keeps its own row, an approval draws none', () => {
  const name = (address) => tokenNamer([])(4663, address);
  assert.equal(decodedEventWords({ eventName: 'AutomationPaused', args: { actor: OWNER.toUpperCase().replace('0X', '0x'), stateNonce: 4n } }, OWNER, name), 'Paused by you');
  assert.equal(decodedEventWords({ eventName: 'AutomationResumed', args: { stateNonce: 5n } }, OWNER, name), 'Automation resumed');
  assert.equal(decodedEventWords({ eventName: 'PolicyChanged', args: { policy: { mode: 2 }, stateNonce: 6n } }, OWNER, name), 'Automation settings saved: Domino-compound');
  assert.equal(decodedEventWords({ eventName: 'RootDisarmed', args: { reason: 7, stateNonce: 7n } }, OWNER, name), 'You ended your automation.');
  assert.equal(decodedEventWords({ eventName: 'RootRearmed', args: { stateNonce: 8n } }, OWNER, name), 'Turned back on');
  assert.equal(decodedEventWords({ eventName: 'ExitModuleSet', args: { module: ZERO, stateNonce: 9n } }, OWNER, name), 'Auto-exit turned off');
  assert.equal(decodedEventWords({ eventName: 'MandateRegistered', args: { tokenId: 12n } }, OWNER, name), 'Auto-exit turned on for position #12');
  assert.equal(decodedEventWords({ eventName: 'ReservesWithdrawn', args: { token: USDG, amount: 2_000_000n, stateNonce: 3n } }, OWNER, name), 'Withdrawn to your wallet: 2 USDG');
  assert.equal(decodedEventWords({ eventName: 'Approval', args: {} }, OWNER, name), null);
  const op = (events, patch = {}) => ({ chainId: 8453, wallet: OWNER, hash: HASH, blockHash: BLOCK_HASH, block: 10, phase: 'included', at: NOW, tokenIds: ['12'], vault: VAULT, events, ...patch });
  const pause = op([{ address: VAULT, eventName: 'AutomationPaused', args: { actor: OWNER, stateNonce: 4n } }, { address: VAULT, eventName: 'ExitModuleSet', args: { module: ZERO, stateNonce: 5n } }]);
  const [row] = sessionAutomation(OWNER, [pause], [], []);
  assert.deepEqual([row.what, row.lines.map((line) => line.value), row.at, row.kind, row.confirmed], ['Paused by you', ['Auto-exit turned off'], null, 'vault_event', true]);
  assert.equal(sessionAutomation(OWNER, [pause], [indexedItem(HASH, 8453)], []).length, 0, 'read-v6 lists it');
  assert.equal(sessionAutomation(OWNER, [pause], [], [], { chainId: 8453, dex: 4, tokenId: '12' }).length, 1);
  assert.equal(sessionAutomation(OWNER, [pause], [], [], { chainId: 8453, dex: 4, tokenId: '13' }).length, 0);
  assert.equal(sessionAutomation(OWNER, [op([{ address: USDG, eventName: 'Approval', args: {} }])], [], []).length, 0, 'an approval');
  assert.equal(sessionAutomation(OWNER, [op(pause.events, { phase: 'reorged' })], [], []).length, 0);
  const setup = op([{ address: VAULT, eventName: 'Initialized', args: { owner: OWNER, rootTokenId: 12n, dex: 4, mode: 1 } }, { address: VAULT, eventName: 'PolicyChanged', args: { policy: { mode: 1 } } }],
    { positionManager: v2Chain(8453).uniswap.v4.positionManager.toLowerCase() });
  assert.equal(sessionAutomation(OWNER, [setup], [], []).length, 0, 'a setup is its own row');
  assert.equal(sessionActivity(OWNER, [setup], []).length, 1);
});

test('a wallet with automation on keeps the activity head\'s minute; a portfolio without any leaves it idle as before', () => {
  const facts = { operations: [], created: 0, local: [], ownActionAt: null, now: NOW };
  assert.equal(quietWallet(OWNER, [], facts), true);
  assert.equal(quietWallet(OWNER, [], { ...facts, automated: true }), false);
  const vault = { owner: OWNER, custody: { armed: true }, pausedBy: null, state: { status: 'read', paused: false } };
  const portfolio = (vaults, mandates = []) => ({ wallet: OWNER, vaults, mandates });
  assert.equal(automationOn(OWNER, portfolio([vault])), true);
  assert.equal(automationOn(OWNER, portfolio([{ ...vault, state: { status: 'read', paused: true } }])), false, 'paused');
  assert.equal(automationOn(OWNER, portfolio([{ ...vault, custody: { armed: false } }])), false, 'disarmed');
  assert.equal(automationOn(OWNER, portfolio([{ ...vault, pausedBy: 'operator' }])), false);
  assert.equal(automationOn(OWNER, portfolio([], [{ owner: OWNER }])), true, 'an Auto-exit order');
  assert.equal(automationOn(OWNER, null), false);
  assert.equal(automationOn(`0x${'b'.repeat(40)}`, portfolio([vault])), false, 'another wallet\'s answer');
});

test('a compound is seen in the readings the page already makes: the state route\'s fee checkpoint or liquidity, the portfolio\'s last execution or fees owed', () => {
  const before = statePosition('5', VAULT);
  assert.equal(stateCompounded(before, before), false, 'nothing changed');
  assert.equal(stateCompounded(before, { ...before, liquidity: '1000000000000000001' }), true);
  assert.equal(stateCompounded(before, { ...before, feeGrowthInside1LastX128: '21' }), true);
  assert.equal(stateCompounded(before, { ...before, liquidity: '1' }), false, 'liquidity down is a withdrawal, not a compound');
  const live = (number, liquidity, feesOwed) => ({ chainId: 8453, dex: 3, positionManager: v2Chain(8453).uniswap.v3.positionManager, tokenId: '7', vault: { address: VAULT, role: 'root' },
    state: { status: 'live', snapshot: { number, hash: BLOCK_HASH, timestamp: 1 }, liquidity: String(liquidity), feesOwed }, firstSeenBlock: 1 });
  const vault = (hash, number) => ({ chainId: 8453, address: VAULT, lastExecution: hash ? { tx: { hash, snapshot: { number, hash: BLOCK_HASH, timestamp: 1 } }, planHash: HASH, action: 'compound' } : null });
  const answer = (positions, vaults) => ({ positions, vaults });
  assert.deepEqual(portfolioCompounds(answer([live(10, 5, ['3', '0'])], [vault(null)]), answer([live(10, 5, ['3', '0'])], [vault(null)])), [], 'the same answer again');
  assert.deepEqual(portfolioCompounds(answer([], [vault(null)]), answer([], [vault(HASH, 12)])), [{ chainId: 8453, block: 12 }], 'a new last execution');
  assert.deepEqual(portfolioCompounds(answer([], [vault(HASH, 12)]), answer([], [vault(HASH, 12)])), []);
  assert.deepEqual(portfolioCompounds(answer([], []), answer([], [vault(HASH, 12)])), [], 'a vault first seen says nothing of when it ran');
  assert.deepEqual(portfolioCompounds(answer([live(10, 5, ['3', '0'])], []), answer([live(11, 6, ['3', '0'])], [])), [{ chainId: 8453, block: 11 }], 'more liquidity');
  assert.deepEqual(portfolioCompounds(answer([live(10, 5, ['3', '0'])], []), answer([live(11, 5, ['0', '0'])], [])), [{ chainId: 8453, block: 11 }], 'fees owed taken out');
  assert.deepEqual(portfolioCompounds(answer([live(10, 5, ['3', '0'])], []), answer([live(11, 6, ['3', '0'])], []), () => 11), [], 'the person\'s own action explains it');
  assert.deepEqual(portfolioCompounds(answer([{ ...live(10, 5, ['3', '0']), vault: null }], []), answer([{ ...live(11, 6, ['3', '0']), vault: null }], [])), [], 'not a vault\'s NFT');
});

test('the shared position evidence tells a compound once, only for a vault\'s NFT, never for the first reading or the person\'s own action', () => {
  const sync = createPositionSync(() => NOW, () => undefined);
  const signals = [];
  sync.subscribeCompounds((signal) => signals.push(signal));
  const body = { wallet: OWNER, servedAt: 1, chains: [], truncated: { positions: false }, positions: [], vaults: [{ chainId: 4663, address: VAULT, lastExecution: null }] };
  sync.reconcile(body);
  const offer = (block, position) => sync.offerState({ v: 1, block, timestamp: 1, positions: [position] });
  offer(100, statePosition('5', VAULT));
  assert.deepEqual(signals, [], 'a first reading says nothing');
  offer(101, statePosition('5', VAULT));
  assert.deepEqual(signals, [], 'nothing changed');
  offer(102, statePosition('5', VAULT, '1000000000000000000', ['11', '20']));
  assert.deepEqual(signals, [{ wallet: OWNER, chainId: 4663, block: 102 }]);
  sync.changed({ chainId: 4663, positionManager: POSITION_MANAGER, tokenIds: ['5'], wallet: OWNER, block: 103 });
  offer(103, statePosition('5', VAULT, '2000000000000000000', ['12', '20']));
  assert.equal(signals.length, 1, 'the person\'s own action at that block explains the change');
  offer(110, statePosition('6', OWNER));
  offer(111, statePosition('6', OWNER, '2000000000000000000', ['50', '50']));
  assert.equal(signals.length, 1, 'a position in the wallet itself is the person\'s, not the keeper\'s');
  // read-v6's own answers: a new last execution of the wallet's vault.
  sync.reconcile({ ...body, servedAt: 2, vaults: [{ chainId: 4663, address: VAULT, lastExecution: { tx: { hash: HASH, snapshot: { number: 120, hash: BLOCK_HASH, timestamp: 1 } }, planHash: HASH, action: 'compound' } }] });
  assert.deepEqual(signals.at(-1), { wallet: OWNER, chainId: 4663, block: 120 });
});

test('the header\'s time is carried as the receipt\'s block time only when it is a quantity', () => {
  assert.deepEqual(headerTime('0x6a8b1c00'), { blockTimestamp: 0x6a8b1c00 });
  assert.deepEqual(headerTime(undefined), {});
  assert.deepEqual(headerTime('0x0'), {});
  assert.deepEqual(headerTime('12'), {});
});

// (2026-10-15, pack 8 review, L5): a tab open for more than a day draws no session receipt older than a day, as a reload
// would not (the store checks the age only when it reads storage or records one).
test('a session receipt older than a day is not drawn in a tab that stayed open', () => {
  const entry = createEntry();
  const DAY = 24 * 60 * 60_000;
  assert.equal(sessionReceipts(OWNER, [entry], [], undefined, NOW + DAY - 1).length, 1, 'still inside the day');
  assert.equal(sessionReceipts(OWNER, [entry], [], undefined, NOW + DAY).length, 0, 'a day old: no longer drawn');
  assert.equal(sessionReceipts(OWNER, [entry], [], { chainId: 4663, dex: 4, tokenId: '9000001' }, NOW + DAY).length, 0, "nor in the position's Activity");
  const store = createSessionReceiptStore(memory(), () => NOW);
  store.record(entry);
  assert.equal(sessionReceipts(OWNER, store.get(OWNER), [], undefined, NOW + 2 * DAY).length, 0, 'what the tab still holds in memory');
});

// (2026-10-15, pack 8 review, L2): a create then a burn (or a close) before read-v6 lists the NFT. The hint of Robinhood
// Chain lasted a day: an "Updating" row with nothing to read, and its NFT in the state route's batches. A reading the
// page already holds (the state route's, or this browser's own burn) now lets it go; and read-v6 listing a kept
// transaction in another block takes that block's hints and session receipts with it. No read is made for either.
const { CREATED_POSITIONS, replacedBlocks } = build('v2in/lists/createdPositions');
const { SESSION_RECEIPTS } = build('v2in/lists/sessionReceipts');
const { notePositionState, notePositionConfirmation } = build('lib/positionEvidence');
const { stateEnded } = build('v2in/lists/positionSync');
test('a created position\'s hint goes once a reading shows its NFT burned or closed at or past its block, and with a block read-v6 shows replaced', () => {
  const hintOf = (tokenId, wallet = OWNER) => ({ wallet, chainId: 4663, positionManager: POSITION_MANAGER.toLowerCase(), dex: 4, tokenId, hash: `0x${tokenId.padStart(64, '0')}`, block: 73_400_000, blockHash: BLOCK_HASH, observedAt: Date.now(),
    fee: 500, tokens: [{ address: ZERO, symbol: 'ETH', decimals: 18 }, { address: USDG, symbol: 'USDG', decimals: 6 }] });
  const state = (block, positions) => ({ v: 1, block, timestamp: 1_790_000_100, positions });
  const ids = () => CREATED_POSITIONS.get(OWNER).map((item) => item.tokenId).sort();
  assert.deepEqual(stateEnded(state(1, [{ tokenId: '1', ok: false, reason: 'not_found' }, { tokenId: '2', ok: false, reason: 'rpc_unavailable' }, statePosition('3', OWNER, '0'), statePosition('4', OWNER)])), ['1', '3']);
  for (const id of ['9000011', '9000012', '9000013', '9000014']) CREATED_POSITIONS.record(hintOf(id));
  assert.deepEqual(ids(), ['9000011', '9000012', '9000013', '9000014']);
  // An older reading proves nothing about the NFT the receipt made; a node away proves nothing at all.
  notePositionState(state(73_399_999, [{ tokenId: '9000011', ok: false, reason: 'not_found' }, { tokenId: '9000012', ok: false, reason: 'rpc_unavailable' }]));
  notePositionState(state(73_400_005, [{ tokenId: '9000012', ok: false, reason: 'rpc_unavailable' }, statePosition('9000013', OWNER)]));
  assert.deepEqual(ids(), ['9000011', '9000012', '9000013', '9000014']);
  notePositionState(state(73_400_005, [{ tokenId: '9000011', ok: false, reason: 'not_found' }, statePosition('9000012', OWNER, '0')]));
  assert.deepEqual(ids(), ['9000013', '9000014'], 'burned, and closed: their hints go');
  assert.equal(withCreatedPositions([], CREATED_POSITIONS.get(OWNER), () => null).length, 2, 'no "Updating" row left for them');
  // This browser's own burn (a zap exit's receipt names the NFTs it burned).
  notePositionConfirmation({ kind: 'confirmed', chainId: 4663, positionManager: POSITION_MANAGER, wallet: OWNER, tokenIds: ['9000013'], burnedTokenIds: ['9000013'], block: 73_400_009, blockHash: `0x${'9'.repeat(64)}` });
  assert.deepEqual(ids(), ['9000014']);
  // read-v6 lists the kept create in another block: the block was replaced, and its receipts go too.
  const listed = { chainId: 4663, tx: { hash: `0x${'9000014'.padStart(64, '0')}`, snapshot: { hash: `0x${'7'.repeat(64)}` } } };
  assert.deepEqual(replacedBlocks(CREATED_POSITIONS.get(OWNER), [{ ...listed, tx: { ...listed.tx, snapshot: { hash: BLOCK_HASH } } }]), [], 'the same block: nothing replaced');
  assert.deepEqual(replacedBlocks(CREATED_POSITIONS.get(OWNER), [{ ...listed, chainId: 8453 }]), [], 'another chain\'s transaction');
  assert.deepEqual(replacedBlocks(CREATED_POSITIONS.get(OWNER), [listed]), [{ chainId: 4663, blockHash: BLOCK_HASH }]);
  SESSION_RECEIPTS.record(createEntry({ observedAt: Date.now() }));
  for (const block of replacedBlocks([...CREATED_POSITIONS.get(OWNER), ...SESSION_RECEIPTS.get(OWNER)], [listed])) { CREATED_POSITIONS.rollback(block.chainId, block.blockHash); SESSION_RECEIPTS.rollback(block.chainId, block.blockHash); }
  assert.deepEqual(ids(), []);
  assert.equal(SESSION_RECEIPTS.get(OWNER).length, 0, 'a session receipt of the replaced block goes with it');
});
