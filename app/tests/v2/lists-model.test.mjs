/**
 * The Positions screen's lists from read-v6 (src/v2in/lists/model.ts; spec F7 rev4 §6.2, §6.3, §2.11, §2.13; the
 * integration brief's data rule), on the package's own fixtures (api-contracts/read-v6/fixtures/valid), each held to the
 * package's validator first: each position as a row (chain, DEX, its own page's address, open or closed, its state, its
 * token amounts with no USD and no APR, a dash and the reason for one the index could not read, the stale badge's age),
 * a Robinhood Chain v4 NFT V1 already lists shown once, the gate's chains only; §6.3's partial sentence; and the receipts
 * (what moved, the fee's kind, rate, token, amount and its deferred part, the gas fields as stated with the L1 data fee,
 * Included or Finalized, and rev4's "Returned to your wallet" for a reserves return the person did not send).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as runtime from '../../../api-contracts/read-v6/runtime.mjs';

const require = createRequire(import.meta.url);
const model = require('../../.test-build/app/src/v2in/lists/model.js');

const CONTRACTS = resolve(import.meta.dirname, '../../../api-contracts');
const fixture = (name) => JSON.parse(readFileSync(join(CONTRACTS, 'read-v6', 'fixtures', 'valid', name), 'utf8'));
const valid = (route, body) => {
  assert.equal(runtime.validateResponse(route, body), true, `${route} fixture valid`);
  return body;
};
const ALL = () => true;
const WALLET = '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const MANY = '0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a';

test('each read-v6 position is a row: chain and DEX named, its own page, open or closed, its state, token amounts only', () => {
  const body = valid('portfolio', fixture('portfolio.json'));
  const rows = model.positionRows(body, ALL);
  assert.deepEqual(rows.map((row) => row.key), ['4663:4:7', '4663:4:8', '4663:4:9', '4663:4:12', '4663:4:13']);
  const [root, successor, plain, unavailable, unread] = rows;
  assert.equal(root.chain, 'Robinhood Chain');
  assert.equal(root.dexName, 'Uniswap v4');
  assert.equal(root.href, '#/positions/robinhood-v4-7', 'the shared route helper (src/v2in/route.ts)');
  assert.equal(root.tab, 'open');
  assert.equal(root.state, 'in-range');
  assert.equal(successor.state, 'out-of-range');
  assert.equal(root.fee, '0.30%', 'the fee as V1’s rows write it');
  // The chain profile names USDG (6 decimals); MANY is read-v6's untrusted symbol with no decimals: raw units, never guessed.
  assert.deepEqual(root.tokens.map((token) => [token.label, token.decimals, token.symbol]), [['USDG', 6, true], ['MANY', null, true]]);
  assert.deepEqual(root.value.map((amount) => [amount.kind, amount.text, amount.raw]), [['units', '0.029551', '29551'], ['raw', '—', '30447000000000000000']]);
  assert.deepEqual(root.fees.map((amount) => [amount.kind, amount.text]), [['units', '0.0012'], ['zero', '0']], 'a measured zero is a zero');
  // Changed on purpose 2026-10-06 (read-v6 1.1.0-rc.1's qualified USD, rugged97's item 4): a row's value and fees in USD
  // only from a fresh read whose every token held above zero is priced: the fees (0.0012 USDG at the stable's 1), never the
  // value (MANY is priced, but its decimals are unknown); the stale row and the unread ones none. Still no APR in a row.
  assert.deepEqual(rows.map((row) => [row.valueUsd, row.feesUsd]), [[null, '0.001200000000000000'], [null, null], [null, '0.001200000000000000'], [null, null], [null, null]]);
  for (const row of rows) for (const key of Object.keys(row)) assert.doesNotMatch(key, /apr|price/i, key);
  // The vault's automation, as V1's badge: Domino-compound, running (read: not paused, root armed).
  assert.deepEqual(root.vault, { role: 'root', name: 'Domino-compound', word: null, running: true });
  assert.equal(successor.vault.role, 'successor');
  assert.equal(plain.vault, null);
  // A position the index could not read: a dash with the reason, never zeros; listed (not burned), so in Open.
  assert.equal(unavailable.state, 'unread');
  assert.equal(unavailable.value, null);
  assert.equal(unavailable.fees, null);
  assert.equal(unavailable.unread, 'This position can’t be read right now.');
  assert.equal(unread.status, 'not_read');
  assert.equal(unread.unread, 'This position hasn’t been read yet.');
  assert.equal(unread.tab, 'open');
});

test('a stale read carries the stale badge with its age; a chain behind gives its own age to every row of it', () => {
  const body = valid('portfolio', fixture('portfolio.json'));
  const rows = model.positionRows(body, ALL);
  assert.equal(rows.find((row) => row.tokenId === '8').stale, 'updated 10 min ago', 'the position’s own read, 600 s old and stale');
  assert.equal(rows.find((row) => row.tokenId === '7').stale, null, 'a fresh read on a current chain has no badge');
  const behind = valid('portfolio', fixture('portfolio-behind.json'));
  const behindRows = model.positionRows(behind, ALL);
  assert.ok(behindRows.length > 0);
  // Robinhood Chain is behind its head: what is shown is as of its last indexed block, 900 s before the answer.
  for (const row of behindRows) assert.equal(row.stale, 'updated 15 min ago');
});

test('the gate decides the chains, and a Robinhood Chain v4 NFT V1 already lists is shown once, as V1’s row', () => {
  const body = valid('portfolio', fixture('portfolio.json'));
  assert.deepEqual(model.positionRows(body, (chainId) => chainId !== 4663), [], 'a chain the gate keeps off lists nothing');
  const deduped = model.positionRows(body, ALL, ['7', '12']);
  assert.deepEqual(deduped.map((row) => row.tokenId), ['8', '9', '13']);
  // Only the same NFT: the same id on another position manager is another NFT.
  const other = structuredClone(body);
  other.positions[0].positionManager = '0x1111111111111111111111111111111111111111';
  assert.ok(model.positionRows(other, ALL, ['7']).some((row) => row.tokenId === '7'));
});

test('§6.3: a chain out is the partial sentence and never empties the others; each chain’s state before its values', () => {
  const body = valid('portfolio', fixture('portfolio.json'));
  // Changed on purpose 2026-10-06 (the owner: one name for one network): Arbitrum One, as every other screen names it.
  assert.equal(model.partialSentence(body.chains), 'Showing Robinhood Chain and Base. Arbitrum One is unavailable right now.');
  const notes = model.chainNotes(body);
  assert.deepEqual(notes.map((note) => [note.chainId, note.state, note.age]), [[4663, 'current', null], [8453, 'stale', 'updated 6 min ago'], [42161, 'unavailable', null]]);
  assert.equal(model.positionRows(body, ALL).length, 5, 'Arbitrum out leaves Robinhood Chain’s rows');
  const behind = valid('portfolio', fixture('portfolio-behind.json'));
  assert.equal(model.partialSentence(behind.chains), 'Showing Robinhood Chain. Base and Arbitrum One are unavailable right now.');
  const empty = valid('portfolio', fixture('portfolio-empty.json'));
  assert.equal(model.partialSentence(empty.chains), 'Robinhood Chain, Base and Arbitrum One are unavailable right now.');
  assert.deepEqual(model.positionRows(empty, ALL), []);
  const complete = valid('portfolio', fixture('portfolio-complete.json'));
  assert.equal(model.partialSentence(complete.chains), null);
});

test('amounts: units to six significant digits with every digit kept, a measured zero, raw units when decimals are unknown, a dash for none', () => {
  const usdg = { chainId: 4663, address: USDG, label: 'USDG', symbol: true, decimals: 6 };
  const many = { chainId: 4663, address: MANY, label: 'MANY', symbol: true, decimals: null };
  assert.deepEqual(model.amountShown('1234567891', usdg), { kind: 'units', text: '1,234.56', exact: '1,234.567891', raw: '1234567891', token: usdg });
  assert.equal(model.amountShown('0', usdg).kind, 'zero');
  assert.equal(model.amountShown('500', many).kind, 'raw');
  assert.equal(model.amountShown(null, usdg).kind, 'unread');
  assert.equal(model.amountWords('325000', usdg), '0.325 USDG');
  assert.equal(model.amountWords('136000000000000000', many), '136,000,000,000,000,000 raw units of MANY');
  // An untrusted symbol is text: control and bidirectional characters dropped, bounded.
  assert.equal(model.cleanSymbol('US‮DC\u0000'), 'USDC');
  assert.equal(model.cleanSymbol(''), null);
  const named = model.tokenNamer([{ chainId: 8453, address: '0x9999999999999999999999999999999999999999', status: 'available', decimals: 18, symbol: 'W​OW', price: null, priceReason: 'no_qualified_price_source' }]);
  assert.deepEqual([named(8453, '0x9999999999999999999999999999999999999999').label, named(8453, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913').label, named(8453, '0x0000000000000000000000000000000000000000').label], ['WOW', 'USDC', 'ETH']);
  assert.equal(named(42161, '0x8888888888888888888888888888888888888888').label, '0x8888…8888', 'unknown: the short address, decimals unknown');
});

test('receipts: what moved, the fee with its kind, rate, token, amount and deferred part, the gas as stated, Included or Finalized', () => {
  const activity = valid('activity', fixture('activity.json'));
  const portfolio = valid('portfolio', fixture('portfolio.json'));
  const views = model.receiptViews(activity, ALL, portfolio);
  assert.deepEqual(views.map((view) => [view.kind, view.what]), [
    // Changed on purpose 2026-10-05 (0xdecimal's item 8): the fixture's operator returnReserves() is read-v6's own kind,
    // in the words a vault_event with such a ReservesWithdrawn had; the owner's own withdrawal stays a vault event.
    ['reserves_returned', 'Returned to your wallet: 0.0012 USDG'],
    ['vault_event', 'Withdrawn to your wallet: 5,000 raw units of MANY'],
    ['zap_event', 'Unused signatures cancelled'],
    // Changed on purpose 2026-10-06 (the owner's point 5, its review): Auto-exit's own words, as Automate's history says them.
    ['auto_exit_event', 'Auto-exit signature cancelled'],
    ['auto_exit_event', 'Auto-exit turned off'],
    ['auto_exit_event', 'Claimed'],
    ['auto_exit', 'Auto-exit: position #8 withdrawn'],
    ['auto_exit_event', 'Auto-exit turned on for position #8'],
    ['vault_event', 'This position was changed outside Domino. Automation stopped for it.'],
    ['vault_event', 'Automation settings saved: Domino-compound'],
    ['vault_execution', 'Automated run: position #8 opened'],
    ['s1_action', 'Withdrew from position #9'],
    ['s1_action', 'Created position #9'],
    // Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation").
    ['vault_created', 'Automation set up for position #7'],
  ]);
  const byId = Object.fromEntries(views.map((view) => [view.id, view]));
  const create = byId['4663:73392000:6'];
  assert.deepEqual(create.fees, [{ label: 'Domino fee (0.65% of the amount swapped)', kind: 'assisted_swap', rate: '0.65%', value: '0.325 USDG', deferred: null }]);
  assert.deepEqual(create.lines.map((line) => [line.data, line.value]), [
    ['paid-in', '100 USDG'],
    ['swapped', '50 USDG → 49,500,000,000,000,000,000 raw units of MANY'],
    // Signed in the receipt (paid into the pool); said as amounts, in the pool's own order.
    ['added', '49,400,000,000,000 USDG + 49,675,000 raw units of MANY · position #9'],
    ['returned', '100,000,000,000,000,000 raw units of MANY'],
  ]);
  assert.equal(create.amount, '100 USDG');
  assert.equal(create.finalized, true);
  assert.deepEqual(create.gas, { sender: WALLET, gasUsed: '412,345', gasPrice: '0.02 gwei', l1Fee: null });
  const exit = byId['4663:73393000:3'];
  assert.equal(exit.gas, null, 'a receipt that states no gas: none claimed');
  assert.deepEqual(exit.fees, []);
  assert.ok(exit.lines.some((line) => line.data === 'no-fee' && line.value === 'No Domino fee'));
  assert.equal(exit.amount, '0.049 USDG');
  // The automation's 4%, per pool token; the part still owed to the fee recipient is part of the fee, never the owner's.
  const run = byId['4663:73394000:8'];
  assert.deepEqual(run.fees.map((fee) => [fee.label, fee.rate, fee.value, fee.deferred]), [
    ['Automation fee (4%)', '4%', '0.000048 USDG', null],
    ['Automation fee (4%)', '4%', '136,000,000,000,000,000 raw units of MANY', '136,000,000,000,000,000 raw units of MANY'],
  ]);
  assert.equal(run.finalized, true);
  // The liquidity figure is technical: with the receipt's technical details, never a main line.
  assert.deepEqual(run.lines.filter((line) => line.tech), [{ label: 'Liquidity added', value: '500,000,000,000,000,000', data: 'added', tech: true }]);
  assert.deepEqual(run.lines.filter((line) => !line.tech).map((line) => line.label), ['Fees used', 'New position']);
  const autoExit = byId['4663:73398000:6'];
  assert.deepEqual(autoExit.fees.map((fee) => [fee.label, fee.value]), [['Auto-exit fee (0.2%)', '0.000059 USDG']]);
  assert.ok(autoExit.lines.some((line) => line.data === 'reserves-returned' && line.value === '0.000002 USDG'));
  assert.equal(autoExit.finalized, false, 'above the chain’s finalized block: Included, not final yet');
  // The L1 data fee exactly as the receipt states it (OP Stack); never added into a claimed total.
  assert.deepEqual(byId['4663:73401000:0'].gas, { sender: WALLET, gasUsed: '412,345', gasPrice: '0.02 gwei', l1Fee: '0.00000000015 ETH' });
  assert.equal(byId['4663:73399000:0'].amount, '0.029641 USDG');
  // Both tokens of one return: the second as a line of its own.
  assert.deepEqual(byId['4663:73403000:1'].lines, [{ label: 'Also', value: 'Returned to your wallet: 3,000 raw units of MANY', data: 'event' }]);
  const policy = byId['4663:73395000:2'];
  assert.deepEqual(policy.lines.map((line) => line.value), ['Paused by you', 'Auto-exit turned on']);
  assert.deepEqual(model.receiptViews(activity, () => false, portfolio), [], 'a chain the gate keeps off lists nothing');
});

test('rev4 §2.13: a reserves return the automation sent is "Returned to your wallet", never the person’s own withdrawal', () => {
  const activity = structuredClone(fixture('activity.json'));
  const item = activity.items.find((entry) => entry.id === '4663:73395000:2');
  item.events = [{ event: 'ReservesWithdrawn', stateNonce: '9', token: USDG, amount: '5000000' }];
  const operator = structuredClone(item);
  valid('activity', activity);
  assert.equal(model.receiptViews(activity, ALL).find((view) => view.id === item.id).what, 'Withdrawn to your wallet: 5 USDG', 'sent by the owner');
  operator.tx.gas.sender = '0xa9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9';
  activity.items[activity.items.indexOf(item)] = operator;
  valid('activity', activity);
  assert.equal(model.receiptViews(activity, ALL).find((view) => view.id === item.id).what, 'Returned to your wallet: 5 USDG', 'sent by the automation (returnReserves)');
  // A receipt that states no gas names no sender: neither claimed.
  operator.tx.gas = null;
  valid('activity', activity);
  // Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation").
  assert.equal(model.receiptViews(activity, ALL).find((view) => view.id === item.id).what, 'Sent to your wallet from your automation: 5 USDG');
});

// Added 2026-10-06 (the review of the owner's point 5): Auto-exit's own vault (paused, its module on) is said by its root's
// orders, before its custody (an exit disarms the root), and never by a compounding name.
test('a row in Auto-exit\'s own vault: "Auto-exit" while one is on, else Off, Paused or Closed the position', () => {
  const base = valid('portfolio', fixture('portfolio.json'));
  const vaultAt = base.vaults.findIndex((vault) => vault.rootTokenId === '7');
  const rowOf = (vaultFields, mandates) => {
    const body = structuredClone(base);
    const vault = body.vaults[vaultAt];
    Object.assign(vault, { autoExitEnabled: true, pausedBy: 'owner' }, vaultFields);
    if (vault.state.status === 'read') vault.state.paused = true;
    body.mandates = mandates(vault);
    return model.positionRows(body, ALL).find((row) => row.tokenId === '7').vault;
  };
  const order = (vault, fields = {}) => ({ ...structuredClone(base.mandates[0] ?? {}), chainId: vault.chainId, vault: vault.address.toLowerCase(), tokenId: '7', status: 'active', expired: false, blockedBy: [], ...fields });
  assert.ok(base.mandates.length > 0, 'the fixture lists an order to start from');
  assert.deepEqual(rowOf({}, (vault) => [order(vault)]), { role: 'root', name: 'Auto-exit', word: null, running: true });
  assert.deepEqual(rowOf({}, () => []), { role: 'root', name: 'Auto-exit', word: 'Off', running: false }, 'turned off, or none: the vault stays paused with its module on');
  assert.deepEqual(rowOf({}, (vault) => [order(vault, { expired: true })]), { role: 'root', name: 'Auto-exit', word: 'Off', running: false }, 'expired');
  assert.deepEqual(rowOf({}, (vault) => [order(vault, { blockedBy: ['module_disabled'] })]), { role: 'root', name: 'Auto-exit', word: 'Paused', running: false });
  assert.deepEqual(rowOf({ custody: { ...base.vaults[vaultAt].custody, armed: false, reason: 'auto_exit' } }, (vault) => [order(vault, { status: 'executed' })]), { role: 'root', name: 'Auto-exit', word: 'Closed the position', running: false }, 'closed by it: never "Automation off" or a compounding name');
  // Changed on purpose 2026-10-06 (the integration review, rugged-literal #1): a root a Collect fees or an Add liquidity
  // disarmed (read-v6's custody.armed false) with its order unblocked still closes at its range's end: "Auto-exit".
  const disarmed = (reason) => ({ custody: { ...base.vaults[vaultAt].custody, armed: false, reason } });
  for (const reason of ['changed_outside_domino', 'v3_checkpoint_mismatch', 'custody_lost']) {
    assert.deepEqual(rowOf(disarmed(reason), (vault) => [order(vault)]), { role: 'root', name: 'Auto-exit', word: null, running: true }, reason);
  }
  assert.deepEqual(rowOf({}, (vault) => [order(vault, { blockedBy: ['custody_lost'] })]), { role: 'root', name: 'Auto-exit', word: 'Paused', running: false }, 'its approval moved: its order says so');
  // Changed on purpose 2026-10-06 (the integration review, rugged-literal #2): Leave automation (exitAll) pauses the vault,
  // turns its module off and disarms its root (reason 7); it stays Auto-exit's, never "Auto-compound · Automation off".
  const left = { autoExitEnabled: false, pausedBy: 'unknown', ...disarmed('exit_all') };
  assert.deepEqual(rowOf(left, (vault) => [order(vault, { blockedBy: ['module_disabled'] })]), { role: 'root', name: 'Auto-exit', word: 'Paused', running: false });
  assert.deepEqual(rowOf(left, (vault) => [order(vault, { status: 'revoked' })]), { role: 'root', name: 'Auto-exit', word: 'Off', running: false }, 'then turned off');
  // A compounding automation Leave automation ended, with nothing of Auto-exit ever on it, keeps its own name.
  assert.notEqual(rowOf(left, () => []).name, 'Auto-exit');
});
