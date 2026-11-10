/**
 * What the Base/Arbitrum position page draws from read-v6's stored fee history (src/v2in/position/storedFees.ts, added
 * 2026-11-06; the owner: every chain the same as Robinhood Chain): the automation's lines from the settlements an automatic
 * compound made, through Robinhood Chain's own arithmetic (lib/automationImpact.ts), Activity's settlements and their
 * automatic re-adds, the Details' Fees history line, and an NFT that no longer exists. The package's own fixtures.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const stored = require('../../.test-build/app/src/v2in/position/storedFees.js');
const { tokenBook } = require('../../.test-build/app/src/v2in/position/tokens.js');
const { positionFeesView } = require('../../.test-build/app/src/lib/fees/positionFees.js');
const { automationImpact } = require('../../.test-build/app/src/lib/automationImpact.js');
const { valueUnits } = require('../../.test-build/app/src/components/positions/visual/value.js');

// Changed on purpose 2026-11-07 (day-9 rehearsal, finding F8): read-v6's versions are the package's own
// (api-contracts/read-v6/runtime.mjs), never literals, so a day-9 version move needs only docs/ELYSIUM_DAY9.md step 3.
const { NEXT_VERSION } = await import('../../../api-contracts/read-v6/runtime.mjs');
const fixture = (name) => JSON.parse(readFileSync(new URL(`../../../api-contracts/read-v6/fixtures/${NEXT_VERSION}/valid/${name}.json`, import.meta.url), 'utf8'));
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const book = tokenBook(8453, [
  { address: WETH, symbol: 'WETH', decimals: 18, usd: '2500.000000000000000000' },
  { address: USDC, symbol: 'USDC', decimals: 6, usd: '1.000000000000000000' },
]);
const NAMES = { compound: 'Auto-compound', domino: 'Domino-compound' };
const ID = '8453:4:41';
const followed = () => fixture('position-fees').positions[0];
const viewOf = (position) => positionFeesView(position, stored.feeTokenOf(book));

test('the stored settlements stand in for the vault\'s record: each automatic compound once, a re-add into this position', () => {
  const view = viewOf(followed());
  assert.equal(view.phase, 'verified');
  const record = stored.storedRecord(view.history.events, ID);
  const auto = followed().events.filter((event) => event.auto);
  assert.equal(auto.length, 1, 'the fixture has one automatic compound');
  assert.deepEqual(record, { executions: [{ tx: auto[0].tx.toLowerCase(), block: auto[0].block.number, action: 0, destination: ID }], paid: null });
  // Twice the same transaction (a collect and its increase): one execution.
  const twice = stored.storedRecord([...view.history.events, { ...view.history.events.at(-1), kind: 'collect', liquidityDelta: 0n }], ID);
  assert.equal(twice.executions.length, 1);
});

test('the automation\'s lines: Robinhood Chain\'s arithmetic, the fee charged as the answer says it, in USD', () => {
  const position = followed();
  const view = viewOf(position);
  const basis = stored.storedBasis(view.state, book);
  assert.equal(basis.kind, 'usd', 'USDC is $1: the card is in dollars');
  const impact = automationImpact({ tokenId: ID, kind: 'compound', history: view.history, state: view.state, basis, record: stored.storedRecord(view.history.events, ID) });
  assert.equal(impact.adds.length, 1);
  assert.equal(impact.exactFees, true, 'serviceFee is the exact fee: no "≈"');
  const auto = position.events.find((event) => event.auto);
  assert.equal(impact.adds[0].fee, valueUnits(basis, [BigInt(auto.serviceFee[0]), BigInt(auto.serviceFee[1])]));
  // What the liquidity added is worth now, at the pool's price (the fixture's raw price makes it tiny).
  assert.equal(typeof impact.adds[0].value, 'bigint');
  assert.ok(impact.growth > 0 && impact.growth < 1, 'the re-added share against the owner\'s own deposit');
  // Activity's re-adds are the same figures, named.
  const adds = stored.storedAutomaticAdds(view, 'compound', book, NAMES);
  assert.deepEqual(adds, { adds: [{ tx: auto.tx, value: impact.adds[0].value }], by: 'Auto-compound' });
  assert.equal(stored.storedAutomaticAdds(view, 'domino', book, NAMES).by, 'Domino-compound');
  assert.equal(stored.storedAutomaticAdds(view, null, book, NAMES), undefined, 'nothing compounds it: no automatic rows');
});

test('a position minted before Domino\'s first block: what it held there is never counted as an automatic re-add', () => {
  const position = followed();
  const auto = position.events.find((event) => event.auto);
  const floor = { ...position, since: { kind: 'floor', block: { ...position.since.block } }, events: [auto] };
  const view = viewOf(floor);
  assert.equal(view.phase, 'verified');
  const held = view.history.events[0];
  assert.equal(held.tx, '', 'the liquidity held at the floor has no transaction of its own');
  assert.equal(held.liquidityDelta, BigInt(auto.liquidity) - BigInt(auto.liquidityDelta));
  const basis = stored.storedBasis(view.state, book);
  const impact = automationImpact({ tokenId: ID, kind: 'compound', history: view.history, state: view.state, basis, record: stored.storedRecord(view.history.events, ID) });
  assert.equal(impact.adds.length, 1);
  assert.equal(impact.growth, Number((BigInt(auto.liquidityDelta) * 1_000_000n) / held.liquidityDelta) / 1_000_000);
});

test('Activity lists every settlement, outside changes included, newest first; a collect of nothing is no row', () => {
  const view = viewOf(followed());
  const events = stored.storedFeesEvents('41', view, book);
  assert.deepEqual(events.map((event) => event.kind), ['increase', 'collect', 'mint']);
  assert.ok(events.every((event, index) => index === 0 || events[index - 1].timestamp >= event.timestamp));
  assert.equal(events[0].basis.kind, 'usd');
  assert.deepEqual(stored.storedFeesEvents('41', null, book), []);
  assert.deepEqual(stored.storedFeesEvents('41', { phase: 'loading', state: null }, book), []);
  const inexact = viewOf(fixture('position-fees-inexact').positions[0]);
  assert.equal(inexact.phase, 'unclaimed-only');
  assert.ok(stored.storedFeesEvents('41', inexact, book).length > 0, 'a history that is not exact still lists what it found');
});

test('the Details\' Fees history line, and a dash when the history does not measure every settlement', () => {
  const view = viewOf(followed());
  assert.equal(stored.storedHistoryWords(view), `Every settlement of this position from its own events, through block ${view.history.through}, and the fees ready to collect at block ${view.state.block}. Measured at each compound or collect and once an hour; the line between points is a guide, not a measurement.`);
  assert.equal(stored.storedHistoryWords({ phase: 'loading', state: null }), '—');
});

test('an NFT the stored history says is burned: the block it was read through; any other status says nothing', () => {
  const burned = fixture('position-fees-burned').positions[0];
  assert.equal(burned.status, 'burned');
  const at = stored.burnedAt(burned);
  assert.equal(typeof at, 'number');
  assert.equal(at, burned.through?.number ?? [...burned.transfers].reverse().find((t) => /^0x0{40}$/.test(t.toAddress)).block.number);
  assert.equal(stored.burnedAt(followed()), null);
  assert.equal(stored.burnedAt(fixture('position-fees-not-followed').positions[0]), null);
  assert.equal(stored.burnedAt(null), null);
});

test('what compounds a position: the portfolio\'s vault, Auto-compound or Domino-compound; none for Auto-exit\'s own or a vault not read', () => {
  const vault = (overrides = {}) => ({ chainId: 8453, address: '0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2', rootTokenId: '41', autoExitEnabled: false, pausedBy: null, members: [], custody: { reason: null },
    state: { status: 'read', paused: false, policy: { mode: 'simple' } }, ...overrides });
  const position = { chainId: 8453, vault: { address: '0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2', role: 'root' } };
  assert.equal(stored.compoundingKind({ vaults: [vault()], mandates: [] }, position), 'compound');
  assert.equal(stored.compoundingKind({ vaults: [vault({ state: { status: 'read', paused: false, policy: { mode: 'domino' } } })], mandates: [] }, position), 'domino');
  assert.equal(stored.compoundingKind({ vaults: [vault({ autoExitEnabled: true, state: { status: 'read', paused: true, policy: { mode: 'simple' } } })], mandates: [] }, position), null, 'Auto-exit\'s own vault');
  assert.equal(stored.compoundingKind({ vaults: [vault({ state: { status: 'not_read' } })], mandates: [] }, position), null);
  assert.equal(stored.compoundingKind({ vaults: [vault({ chainId: 42161 })], mandates: [] }, position), null, 'another chain\'s vault');
  assert.equal(stored.compoundingKind({ vaults: [vault()], mandates: [] }, { chainId: 8453, vault: null }), null);
});
