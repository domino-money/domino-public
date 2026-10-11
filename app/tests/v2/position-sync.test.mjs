import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { createPositionSync, createPortfolioCatchup, positionKey, burnedPositionIds, positionChanged } = require('../../.test-build/app/src/v2in/lists/positionSync.js');
const { createPositionEvidence, createWalletReadGuard, subscribePositionEvidence } = require('../../.test-build/app/src/lib/positionEvidence.js');
const { positionRows } = require('../../.test-build/app/src/v2in/lists/model.js');
const { historicalPositionRows, mergePositionRows, positionCounts, hasPositionApr, withCreatedPositions } = require('../../.test-build/app/src/v2in/lists/positionCollection.js');
const { createCreatedPositionStore } = require('../../.test-build/app/src/v2in/lists/createdPositions.js');
const { createPositionReadings, recordedPriceHistory } = require('../../.test-build/app/src/v2in/position/recordedReadings.js');
const { v2Chain } = require('../../.test-build/app/src/v2/chains.js');
const fixture = () => JSON.parse(readFileSync(new URL('../../../api-contracts/read-v6/fixtures/valid/portfolio.json', import.meta.url)));
const copy = structuredClone;

test('recorded readings preserve block time and raw fee balances, never append stale or repeated snapshots, and survive this session only', () => {
  const saved = new Map(), storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  let clock = 10_000;
  const store = createPositionReadings(storage, () => clock);
  const state = (number, timestamp = 9000 + number, hash = `0x${number.toString(16).padStart(64, '0')}`) => ({ status: 'live', snapshot: { number, hash, timestamp }, sqrtPriceX96: (1n << 96n).toString(), feesOwed: [String(number), '0'] });
  const key = 'wallet:8453:manager:6238157:pool';
  let updates = 0; const stop = store.subscribe(key, () => updates++);
  store.observe(key, state(1), true);
  assert.equal(store.get(key)[0].snapshot.timestamp, 9001, 'the block timestamp, not the observation clock');
  store.observe(key, state(1), true); store.observe(key, state(2), false);
  assert.equal(updates, 1); assert.equal(store.get(key).length, 1);
  store.observe(key, { ...state(2), feesOwed: ['0', '17'] }, true);
  assert.deepEqual(store.get(key).map(row => row.fees), [['1', '0'], ['0', '17']], 'a collection can decrease a balance; this is not cumulative earnings');
  assert.deepEqual(createPositionReadings(storage, () => clock).get(key), store.get(key));
  assert.equal(createPositionReadings(null, () => clock).get(key).length, 0, 'no history invented in a new session');
  assert.equal(store.get('wallet:42161:manager:6238157:pool').length, 0);
  assert.equal(store.get('another-wallet:8453:manager:6238157:pool').length, 0);
  clock += 86401;
  assert.equal(createPositionReadings(storage, () => clock).get(key).length, 0);
  stop();
});

test('recorded readings cap both identities and points, and remove a replaced or reorganized branch', () => {
  const store = createPositionReadings(null, () => 10_000);
  const state = number => ({ status: 'live', snapshot: { number, hash: `0x${number.toString(16).padStart(64, '0')}`, timestamp: 9000 + number }, sqrtPriceX96: (1n << 96n).toString(), feesOwed: ['0', '0'] });
  for (let number = 1; number <= 70; number++) store.observe('one', state(number), true);
  assert.equal(store.get('one').length, 64); assert.equal(store.get('one')[0].snapshot.number, 7);
  const replacement = state(70); replacement.snapshot.hash = `0x${'ab'.repeat(32)}`;
  store.observe('one', replacement, true);
  assert.equal(store.get('one').length, 64); assert.equal(store.get('one').at(-1).snapshot.hash, replacement.snapshot.hash);
  store.rollback('one', state(68).snapshot.hash);
  assert.equal(store.get('one').at(-1).snapshot.number, 67);
  store.observe('one', state(65), true);
  assert.equal(store.get('one').at(-1).snapshot.number, 67, 'regressing responses never append');
  store.rollback('one', `0x${'cd'.repeat(32)}`, 60);
  assert.equal(store.get('one').at(-1).snapshot.number, 59, 'an unobserved reorganized block invalidates later observations too');
  for (let n = 0; n < 16; n++) store.observe(`other-${n}`, state(1), true);
  assert.equal(store.get('one').length, 0, 'at most sixteen identities remain');
  const invalid = state(1); invalid.sqrtPriceX96 = (1n << 160n).toString();
  store.observe('bad', invalid, true); assert.equal(store.get('bad').length, 0);
});

test('a reorg tombstone prevents an orphaned portfolio snapshot from returning after observe or a remount', () => {
  const saved = new Map(), storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  const store = createPositionReadings(storage, () => 10_000);
  const state = number => ({ status: 'live', snapshot: { number, hash: `0x${number.toString(16).padStart(64, '0')}`, timestamp: 9000 + number }, sqrtPriceX96: (1n << 96n).toString(), feesOwed: ['0', '0'] });
  store.observe('one', state(9), true); store.observe('one', state(12), true);
  store.rollback('one', state(10).snapshot.hash, 10);
  store.observe('one', state(10), true); store.observe('one', state(12), true);
  assert.deepEqual(store.get('one').map(row => row.snapshot.number), [9], 'neither the explicit bad block nor later removed snapshots return');
  const remount = createPositionReadings(storage, () => 10_000);
  remount.observe('one', state(12), true);
  assert.equal(remount.get('one').length, 1, 'the session cache retains the exclusion');
  const replacement = state(12); replacement.snapshot.hash = `0x${'ab'.repeat(32)}`;
  remount.observe('one', replacement, true);
  assert.equal(remount.get('one').at(-1).snapshot.hash, replacement.snapshot.hash, 'a replacement snapshot can be recorded');
  remount.observe('other', state(12), true);
  assert.equal(remount.get('other').length, 1, 'another identity is not affected');
});

test('recorded price plots contain only exact observations, keep gaps, respect token precision and never claim a mint point', () => {
  const rows = [1000, 7200].map((t, i) => ({ snapshot: { number: i + 1, hash: `0x${'ab'.repeat(32)}`, timestamp: t }, sqrtPriceX96: ((1n << 96n) * BigInt(i + 1)).toString(), fees: ['0', '0'] }));
  const line = recordedPriceHistory(rows, [18, 18], false, { lower: 0.5, upper: 2 });
  assert.deepEqual(line.points.map(p => [p.t, p.price, p.inRange]), [[1000, 1, true], [7200, 4, false]]);
  assert.deepEqual(line.runs.map(run => run.length), [1, 1], 'no bridge across unobserved intervals');
  assert.deepEqual([line.start, line.end], [1000, 7200]);
  assert.equal(recordedPriceHistory(rows, [18, 18], false, { lower: 1, upper: 4 }).points[1].inRange, false, 'the upper price bound is exclusive, as in the existing range chart');
  assert.equal(recordedPriceHistory(rows, [18, 18], true, { lower: 0, upper: Infinity }).points[1].price, 0.25);
  assert.equal(recordedPriceHistory(rows, [18, 6], false, { lower: 0, upper: Infinity }).points[0].price, 1e12);
  assert.equal(recordedPriceHistory(rows, [null, 18], false, { lower: 0, upper: 2 }), null);
  assert.equal(recordedPriceHistory([], [18, 18], false, { lower: 0, upper: 2 }), null);
});

const creation = (over = {}) => ({ wallet: fixture().wallet, chainId: 8453, positionManager: v2Chain(8453).uniswap.v3.positionManager, dex: 3,
  tokenId: '6238157', hash: `0x${'ab'.repeat(32)}`, block: 52469635, blockHash: `0x${'cd'.repeat(32)}`, observedAt: 1000, fee: 3000,
  tokens: [{ address: '0x1111111111111111111111111111111111111111', symbol: 'BASECAT', decimals: 18 }, { address: '0x2222222222222222222222222222222222222222', symbol: 'USDC', decimals: 6 }], ...over });

test('multichain creation survives reload only as a wallet-scoped discovery hint until exact indexed state arrives', () => {
  const kept = new Map(), storage = { getItem: key => kept.get(key) ?? null, setItem: (key, value) => kept.set(key, value) };
  const first = createCreatedPositionStore(storage, () => 1000), item = creation();
  first.record(item);
  const reloaded = createCreatedPositionStore(storage, () => 2000);
  assert.equal(reloaded.get(item.wallet).length, 1);
  assert.equal(reloaded.get(`0x${'9'.repeat(40)}`).length, 0);
  const rows = withCreatedPositions([], reloaded.get(item.wallet));
  assert.equal(rows[0].key, `${item.chainId}:${item.positionManager}:${item.tokenId}`);
  assert.equal(rows[0].tab, 'pending'); assert.equal(rows[0].status, 'not_read');
  assert.equal(rows[0].valueUsd, null); assert.equal(rows[0].fees, null); assert.equal(rows[0].block, null);
  assert.equal(hasPositionApr(rows[0]), false);
  assert.equal(rows[0].tokens[0].label, 'BASECAT');
  const body = fixture(); body.wallet = item.wallet;
  const position = copy(body.positions[0]); Object.assign(position, { chainId: item.chainId, dex: 3, positionManager: item.positionManager, tokenId: item.tokenId });
  position.state.snapshot.number = item.block - 1;
  body.positions = [position]; reloaded.reconcile(body);
  assert.equal(reloaded.get(item.wallet).length, 1, 'a pre-mint snapshot cannot settle discovery');
  position.state.snapshot.number = item.block;
  position.positionManager = v2Chain(8453).uniswap.v4.positionManager; reloaded.reconcile(body);
  assert.equal(reloaded.get(item.wallet).length, 1, 'another manager with the same NFT id is independent');
  position.positionManager = item.positionManager; reloaded.reconcile(body);
  assert.equal(reloaded.get(item.wallet).length, 0);
  assert.equal(createCreatedPositionStore(storage, () => 2001).get(item.wallet).length, 0, 'settled hints stay settled after reload');
});

test('created hints cannot inject financial state and reject invalid identity, expired sessions or replay after a reorg', () => {
  let clock = 1000; const store = createCreatedPositionStore(null, () => clock);
  const item = creation();
  store.record({ ...item, chainId: 4663 });
  store.record({ ...item, positionManager: `0x${'3'.repeat(40)}` });
  store.record({ ...item, observedAt: 1001 });
  assert.equal(store.get(item.wallet).length, 0);
  store.record(item); store.record(item);
  assert.equal(store.get(item.wallet).length, 1);
  const other = creation({ chainId: 42161, positionManager: v2Chain(42161).uniswap.v3.positionManager }); store.record(other);
  assert.equal(store.get(item.wallet).length, 2);
  store.rollback(8453, item.blockHash);
  assert.equal(store.get(item.wallet)[0].chainId, 42161);
  clock += 86400_001;
  store.reconcile({ ...fixture(), wallet: item.wallet });
  assert.equal(store.get(item.wallet).length, 0);
});

test('late multichain readers replay inclusion barriers, while rolled-back blocks are not replayed', () => {
  const sync = createPositionSync(), item = creation();
  const change = { ...item, tokenIds: [item.tokenId] };
  sync.changed(change);
  const late = []; sync.subscribe(value => late.push(value), true);
  assert.equal(late.length, 1); assert.equal(late[0].blockHash, item.blockHash);
  assert.equal(sync.minBlock(item), item.block);
  sync.rollback(change);
  const after = []; sync.subscribe(value => after.push(value), true);
  assert.equal(after.length, 0);
});

test('multichain catch-up spans index latency with bounded pacing, exact identity and no restart from the same hint', () => {
  let clock = 0; const catchup = createPortfolioCatchup(() => clock), item = creation();
  const change = { ...item, tokenIds: [item.tokenId] }, body = { ...fixture(), wallet: item.wallet, positions: [] };
  catchup.note(change);
  const delays = Array.from({ length: 24 }, () => catchup.delay(body));
  assert.equal(delays.filter(value => value === 5000).length, 5);
  assert.equal(delays.filter(value => value === 10000).length, 18);
  assert.equal(delays.at(-1), null);
  catchup.note(change); assert.equal(catchup.delay(body), null);
  catchup.note({ ...change, block: change.block + 1 }); clock = 300_001;
  assert.equal(catchup.delay(body), null, 'a sleeping tab cannot restart expired rapid polling');
});

test('wallet balance reads follow only exact-chain exact-wallet receipts, never a pre-receipt or regressing snapshot', () => {
  const wallet = '0x3333333333333333333333333333333333333333';
  const guard = createWalletReadGuard(wallet);
  assert.equal(guard.accept(100), true);
  assert.equal(guard.confirm({ chainId: 8453, wallet, block: 120 }), false);
  assert.equal(guard.confirm({ chainId: 4663, wallet: '0x4444444444444444444444444444444444444444', block: 120 }), false);
  assert.equal(guard.confirm({ chainId: 4663, block: 120 }), false, 'an unqualified wallet is not inferred');
  assert.equal(guard.confirm({ chainId: 4663, wallet, block: 0 }), false);
  assert.equal(guard.confirm({ chainId: 4663, wallet: wallet.toUpperCase(), block: 120n }), true);
  assert.equal(guard.accept(119), false, 'last good balances remain until the node includes the action');
  assert.equal(guard.accept(null), false, 'unknown snapshot is not a zero balance');
  assert.equal(guard.accept(120), true);
  assert.equal(guard.accept(121), true);
  assert.equal(guard.accept(120), false, 'a delayed answer cannot roll the wallet back');
  assert.equal(guard.confirm({ chainId: 4663, wallet, block: 120 }), false, 'replay of the same or older receipt coalesces');
  assert.equal(guard.confirm({ chainId: 4663, wallet, block: 122 }), true);
  assert.equal(guard.accept(121), false);
});

test('a new wallet receipt and stale-node retries preserve the service Retry-After', () => {
  const wallet = fixture().wallet;
  const guard = createWalletReadGuard(wallet);
  guard.defer(30, 1000);
  guard.defer(2, 1500);
  assert.equal(guard.confirm({ chainId: 4663, wallet, block: 100 }), true);
  assert.equal(guard.delay(2000), 29_000);
  assert.equal(guard.delay(2000, 60_000), 60_000);
  assert.equal(guard.delay(31_000), 0);
  guard.defer(NaN, 32_000);
  assert.equal(guard.delay(32_000), 0);
});

test('V2 positionChanged reaches the neutral evidence bus and the position collection exactly once', () => {
  const wallet = fixture().wallet;
  const events = [];
  const stop = subscribePositionEvidence((event) => { if (event.kind === 'confirmed' && event.value.tokenIds?.includes('900003')) events.push(event.value); });
  positionChanged({ chainId: 4663, wallet, tokenIds: ['900003'], block: 123 });
  assert.equal(events.length, 1);
  assert.equal(events[0].wallet, wallet);
  stop();
});

test('public evidence received before the lazy collection loads replays confirmation minimums before retained states', () => {
  const evidence = createPositionEvidence();
  const events = [];
  evidence.state({ v: 1, block: 100, timestamp: 1000, positions: [{ ok: true, tokenId: '7' }] });
  evidence.state({ v: 1, block: 90, timestamp: 900, positions: [{ ok: true, tokenId: '7' }] });
  evidence.confirmed({ chainId: 4663, tokenIds: ['7'], block: 110 });
  const stop = evidence.subscribe((event) => events.push(event));
  assert.deepEqual(events.map(event => [event.kind, event.value.block]), [['confirmed', 110], ['state', 100]]);
  evidence.state({ v: 1, block: 111, timestamp: 1100, positions: [{ ok: true, tokenId: '7' }] });
  assert.equal(events.at(-1).value.block, 111);
  stop();
  evidence.confirmed({ chainId: 4663, tokenIds: ['7'], block: 112 });
  assert.equal(events.length, 3);
});

test('older snapshots and transient failures cannot reopen a closed NFT; each position owns its block', () => {
  const sync = createPositionSync();
  const first = fixture();
  const closed = first.positions[0];
  closed.state.liquidity = '0';
  const block = closed.state.snapshot.number;
  sync.reconcile(first);
  const older = fixture();
  older.positions[0].state.snapshot.number = block - 1;
  // The envelope being newer does not qualify the older individual position.
  older.servedAt += 100;
  const reconciled = sync.reconcile(older);
  assert.equal(reconciled.positions[0].state.liquidity, '0');
  assert.equal(reconciled.positions[0].state.snapshot.number, block);
  assert.equal(reconciled.positions[0].state.freshness.status, 'stale');
  const unavailable = copy(older);
  unavailable.positions[0].state = { status: 'not_read' };
  assert.equal(sync.reconcile(unavailable).positions[0].state.liquidity, '0');
  // A partial withdrawal keeps liquidity, regardless of automation being off.
  const partial = copy(first);
  partial.positions[0].state.snapshot.number = block + 1;
  partial.positions[0].state.liquidity = '1';
  assert.equal(positionRows(sync.reconcile(partial), () => true)[0].tab, 'open');
});

test('a receipt block gates the first cold read and later responses, with no manufactured state', () => {
  const sync = createPositionSync();
  const before = fixture();
  const position = before.positions[0];
  const block = position.state.snapshot.number;
  sync.changed({ chainId: position.chainId, positionManager: position.positionManager, tokenIds: [position.tokenId], wallet: before.wallet, block: block + 10 });
  const pending = sync.reconcile(before);
  assert.deepEqual(pending.positions[0].state, { status: 'not_read' });
  const current = copy(before);
  current.positions[0].state.snapshot.number = block + 10;
  current.positions[0].state.liquidity = '0';
  assert.equal(sync.reconcile(current).positions[0].state.liquidity, '0');
  assert.equal(sync.reconcile(before).positions[0].state.liquidity, '0');
});

test('an explicitly affected NFT does not invalidate other positions or a same-id NFT on another manager', () => {
  const sync = createPositionSync(), body = fixture();
  const target = body.positions[0], block = target.state.snapshot.number + 10;
  const other = { ...copy(target), tokenId: '999998' };
  const differentManager = { ...copy(target), positionManager: '0x' + 'e'.repeat(40) };
  body.positions = [target, other, differentManager];
  sync.reconcile(body);
  sync.changed({ chainId: target.chainId, wallet: body.wallet, positionManager: target.positionManager, tokenIds: [target.tokenId], block });
  assert.equal(sync.minBlock(target), block);
  assert.equal(sync.minBlock(other), 0);
  assert.equal(sync.minBlock(differentManager), 0);
  const again = sync.reconcile(copy(body));
  assert.equal(again.positions[1].state.freshness.status, other.state.freshness.status);
  const approval = createPositionSync();
  approval.reconcile(body);
  approval.changed({ chainId: target.chainId, wallet: body.wallet, tokenIds: [], block });
  assert.equal(approval.minBlock(target), 0, 'an approval with explicit empty scope does not block every NFT');
  const unknown = createPositionSync();
  unknown.reconcile(body);
  unknown.changed({ chainId: target.chainId, wallet: body.wallet, block });
  assert.equal(unknown.minBlock(other), block, 'truly unscoped confirmations keep the wallet read barrier');
});

test('portfolio confirmation catch-up stops at the matching snapshot, stays bounded and ignores other wallets', () => {
  const body = fixture(), policy = createPortfolioCatchup();
  const position = body.positions[0], block = position.state.snapshot.number + 10;
  const change = { chainId: position.chainId, positionManager: position.positionManager, tokenIds: [position.tokenId], wallet: body.wallet, block };
  policy.note(change);
  assert.equal(policy.delay({ ...body, wallet: '0x' + 'c'.repeat(40) }), null);
  assert.equal(policy.delay(body), 2_000);
  const fresh = copy(body); fresh.positions[0].state.snapshot.number = block;
  if (position.vault) {
    const vault = fresh.vaults.find(value => value.address.toLowerCase() === position.vault.address.toLowerCase());
    vault.state.snapshot.number = block;
  }
  const chain = fresh.chains.find(value => value.chainId === position.chainId);
  chain.indexedThrough.number = Math.max(block, chain.indexedThrough.number);
  assert.equal(policy.delay(fresh), null);
  policy.note(change);
  assert.equal(policy.delay(body), null, 'replaying the same proof cannot restart a fast loop');
  policy.note({ ...change, block: block + 10 });
  for (let i = 0; i < 5; i++) assert.equal(policy.delay(body), 2_000);
  assert.equal(policy.delay(body), null);
  assert.equal(policy.delay(body), null);
});

test('the collection merges complete identities, counts only proven liquidity and preserves family metadata', () => {
  const portfolio = fixture();
  portfolio.positions[0].state.liquidity = '0';
  const current = positionRows(portfolio, () => true);
  const root = current[0];
  const oldRoot = { ...root, block: root.block - 1, tab: 'open', state: 'in-range', vault: null, family: null };
  const differentManager = { ...oldRoot, positionManager: '0x1111111111111111111111111111111111111111' };
  differentManager.key = positionKey(differentManager);
  const merged = mergePositionRows([oldRoot, differentManager], current);
  assert.equal(merged.filter(row => row.key === root.key).length, 1);
  assert.equal(merged.find(row => row.key === root.key).tab, 'closed');
  assert.deepEqual(merged.find(row => row.key === root.key).family, root.family);
  assert.ok(root.family.successors > 0, 'a closed root does not discard its active successors');
  assert.equal(merged.find(row => row.tokenId === '8').tab, 'open');
  assert.deepEqual(positionCounts(merged), { open: 3, closed: 1, pending: 2 });
  assert.equal(hasPositionApr(differentManager), false, 'same token id on another manager never hits Robinhood fees endpoint');
  assert.equal(hasPositionApr({ ...root, chainId: 8453 }), false);
  assert.equal(hasPositionApr(root), true);
});

test('unknown custody cannot claim automation is running and reservations are not open liquidity', () => {
  const portfolio = fixture();
  portfolio.vaults[0].custody.armed = null;
  portfolio.positions[0].state.liquidity = '0';
  const row = positionRows(portfolio, () => true)[0];
  assert.equal(row.vault.running, false);
  assert.equal(row.vault.name, null);
  assert.equal(row.vault.word, 'Updating');
  assert.equal(row.tab, 'closed');
  assert.ok(row.family, 'family recovery is retained on the closed root');
});

test('partial inventory and burned/omitted closed NFTs retain history; complete removal is not assumed to be a burn', () => {
  const sync = createPositionSync();
  const first = fixture();
  first.positions[0].state.liquidity = '0';
  sync.reconcile(first);
  const partial = copy(first);
  partial.positions = [];
  partial.truncated.positions = true;
  assert.equal(sync.reconcile(partial).positions.length, first.positions.length);
  const full = copy(partial);
  full.truncated.positions = false;
  assert.deepEqual(sync.reconcile(full).positions.map(row => row.tokenId), ['7'], 'only proved closed history remains after complete inventory omits it');
});

test('same-height block hash replacement uses the replacement snapshot, not stale closed status', () => {
  const sync = createPositionSync();
  const first = fixture();
  first.positions[0].state.liquidity = '0';
  sync.reconcile(first);
  const replacement = copy(first);
  replacement.positions[0].state.snapshot.hash = `0x${'ef'.repeat(32)}`;
  replacement.positions[0].state.liquidity = '1';
  assert.equal(sync.reconcile(replacement).positions[0].state.liquidity, '1');
});

test('reorg rollback removes only its scoped barriers and burns, preserving later proof and other manager/chain state', () => {
  const sync = createPositionSync();
  const body = fixture();
  const position = body.positions[0];
  const block = position.state.snapshot.number;
  const a = { chainId: position.chainId, wallet: body.wallet, positionManager: position.positionManager, tokenIds: [position.tokenId], block: block + 1, blockHash: '0x' + 'a1'.repeat(32) };
  const b = { ...a, block: block + 2, blockHash: '0x' + 'b2'.repeat(32) };
  sync.reconcile(body);
  sync.changed({ ...a, burnedTokenIds: a.tokenIds }); sync.changed(b);
  const other = { ...position, positionManager: '0x' + 'c3'.repeat(20) };
  sync.changed({ ...b, positionManager: other.positionManager, block: block + 3, blockHash: '0x' + 'c3'.repeat(32) });
  sync.rollback(a);
  assert.equal(sync.minBlock(position), b.block, 'later operation remains a barrier');
  assert.equal(sync.burn(position), null);
  assert.equal(sync.minBlock(other), block + 3);
  sync.rollback(b);
  assert.equal(sync.minBlock(position), 0);
  assert.equal(sync.minBlock(other), block + 3, 'same numeric NFT on another manager remains independent');
  sync.changed({ ...a, tokenIds: undefined, blockHash: '0x' + 'd4'.repeat(32) });
  sync.rollback({ ...a, tokenIds: [], blockHash: '0x' + 'd4'.repeat(32) });
  assert.equal(sync.minBlock(position), 0, 'unscoped wallet contribution also rolls back');
  const orphan = copy(body);
  orphan.positions[0].state.snapshot.hash = a.blockHash;
  orphan.positions[0].state.snapshot.number = a.block;
  const reread = sync.reconcile(orphan).positions[0];
  assert.notEqual(reread.state.status === 'live' ? reread.state.snapshot.hash : null, a.blockHash, 'a lagging index cannot reintroduce a positively orphaned snapshot');
});

test('only a confirmed NFT Transfer to zero from the exact manager proves a burn', () => {
  const manager = fixture().positions[0].positionManager;
  const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const zero = `0x${'0'.repeat(64)}`;
  const token = `0x${'7'.padStart(64, '0')}`;
  const owner = `0x${'1'.repeat(64)}`;
  assert.deepEqual(burnedPositionIds([
    { address: manager, topics: [transfer, owner, zero, token] },
    { address: manager, topics: [transfer, zero, owner, token] },
    { address: '0x0000000000000000000000000000000000000001', topics: [transfer, owner, zero, token] },
    { address: manager, topics: [transfer, owner, zero] },
  ], manager), ['7']);
  const sync = createPositionSync();
  const portfolio = fixture();
  const position = portfolio.positions[0];
  sync.reconcile(portfolio);
  sync.changed({ chainId: 4663, positionManager: manager, tokenIds: ['7'], burnedTokenIds: ['7'], block: position.state.snapshot.number + 1 });
  assert.equal(sync.burn(position).block, position.state.snapshot.number + 1);
  portfolio.positions = [];
  assert.ok(sync.reconcile(portfolio).positions.some(row => row.tokenId === '7'), 'the closed history survives a burned NFT disappearing from inventory');
});

test('an older historical inventory cannot turn a pending post-confirmation NFT back into Open', () => {
  const portfolio = fixture();
  const position = portfolio.positions[0];
  position.tokenId = '900001';
  position.vault = null;
  const block = position.state.snapshot.number;
  const old = positionRows(portfolio, () => true)[0];
  const historical = { owner: portfolio.wallet, block, deposits: [], positions: [{
    tokenId: position.tokenId, status: 'open', poolId: 'unused', currencies: old.tokens,
    fee: 3000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000',
    tickLower: -60, tickUpper: 60, liquidity: '1', sqrtPriceX96: null, tick: 0,
    principal: ['1', '2'], unclaimedFees: ['0', '0'],
  }] };
  positionChanged({ chainId: position.chainId, positionManager: position.positionManager, tokenIds: [position.tokenId], block: block + 1 });
  const merged = mergePositionRows(historicalPositionRows(historical, true), positionRows(portfolio, () => true));
  const row = merged.find(row => row.tokenId === position.tokenId);
  assert.equal(row.tab, 'pending');
  assert.equal(row.state, 'unread');
  assert.equal(row.stale, 'Updating');
  assert.ok(row.value, 'the last good amounts remain visible while the newer snapshot is pending');
});
