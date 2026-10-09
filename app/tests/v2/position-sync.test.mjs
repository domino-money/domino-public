import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { createPositionSync, positionKey, burnedPositionIds, positionChanged } = require('../../.test-build/app/src/v2in/lists/positionSync.js');
const { createPositionEvidence, createWalletReadGuard, subscribePositionEvidence } = require('../../.test-build/app/src/lib/positionEvidence.js');
const { positionRows } = require('../../.test-build/app/src/v2in/lists/model.js');
const { historicalPositionRows, mergePositionRows, positionCounts, hasPositionApr } = require('../../.test-build/app/src/v2in/lists/positionCollection.js');
const fixture = () => JSON.parse(readFileSync(new URL('../../../api-contracts/read-v6/fixtures/valid/portfolio.json', import.meta.url)));
const copy = structuredClone;

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
