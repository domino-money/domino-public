/**
 * The vault panel's pure parts added for the audit of 2026-10-03 (spec F7 rev4 §4.8, §5.3, §5.4, §5.5, §5.6, §8.2), on
 * the read-v6 package's own fixtures, each held to the package's validator first:
 *   - §5.3's halt banner: the chain's `automationHalted` as the panel reads it, and the spec's exact sentence with the
 *     chain named;
 *   - §5.6's two reserve figures: "Fees collected, not yet reinvested" (`reserves`) and "Not used by automation" (idle);
 *   - §5.5's sequence: root → successors from the listing's history and ledger, each with its state, range and lots;
 *   - §5.4 reason 5: the second sentence only when the data says liquidity was merely added, never otherwise;
 *   - §5.6's recoveries: what the owner types, in the token's units when known, raw units otherwise, nothing from a
 *     malformed field;
 *   - §4.8's claim: the chain's `unclaimed` joined with the index's credits, the chain's figure first;
 *   - §8.2 "Withdraw from vault first" opens the successor's sentence.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as runtime from '../../../api-contracts/read-v6/runtime.mjs';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src';
const portfolio = require(`${BUILD}/v2in/automate/portfolio.js`);
const vaultView = require(`${BUILD}/v2in/automate/vaultView.js`);
const tokens = require(`${BUILD}/v2in/automate/tokens.js`);
const copy = require(`${BUILD}/v2in/automate/copy.js`);
const positionConstants = require(`${BUILD}/v2in/position/constants.js`);
const { VAULT_TEXT } = require(`${BUILD}/finance/v2/vault.js`);
const chains = require(`${BUILD}/v2/chains.js`);

const CONTRACTS = resolve(import.meta.dirname, '../../../api-contracts');
const fixture = (name) => {
  const body = JSON.parse(readFileSync(join(CONTRACTS, 'read-v6', 'fixtures', 'valid', name), 'utf8'));
  assert.equal(runtime.validateResponse('portfolio', body), true, `${name} is a valid portfolio answer`);
  return body;
};
const WALLET = '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1';
const VAULT = '0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2';
const MOVED = '0xa6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const MANY = '0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a';
const ZERO = '0x0000000000000000000000000000000000000000';
const NOW = 1_790_424_200;

test('§5.3: the halt banner reads chains[].automationHalted (null is not known), in the spec\'s exact words, the chain named', () => {
  const body = fixture('portfolio.json');
  assert.equal(portfolio.chainView(body.chains, 4663).halted, false);
  assert.equal(portfolio.chainView(body.chains, 8453).halted, true, 'Base is halted in the fixture');
  assert.equal(portfolio.chainView(body.chains, 42161).halted, null, 'an unavailable chain cannot say');
  for (const chainId of [4663, 8453, 42161]) {
    const name = chains.v2Chain(chainId).name;
    assert.equal(portfolio.haltWords(chainId), `Domino has stopped automation on ${name} for safety. You can still withdraw and manage your positions.`);
    assert.equal(portfolio.haltWords(chainId), VAULT_TEXT.vault_halted.replace('{chain}', name), 'the vault client\'s own sentence');
  }
  assert.doesNotMatch(portfolio.haltWords(8453), /\{chain\}/);
});

test('§5.6 "Reservas na tela": reserves(token) as "Fees collected, not yet reinvested" and the idle part as "Not used by automation", both per pool token', () => {
  const body = fixture('portfolio.json');
  const view = vaultView.vaultViewFromListing(body.vaults.find((v) => v.address === VAULT), body, WALLET, NOW);
  assert.equal(view.reserves.known, true);
  const split = vaultView.splitReserves(view.reserves.list);
  assert.deepEqual(split.collected.map((r) => [r.token, r.amount]), [[USDG, 1202n], [MANY, 990n]]);
  assert.deepEqual(split.idle.map((r) => [r.token, r.amount]), [[USDG, 2n], [MANY, 0n]]);
  // Nothing of `owedFees` is among them: the two figures come only from `total` and `idle`.
  assert.deepEqual(Object.keys(split).sort(), ['collected', 'idle']);
  assert.deepEqual(vaultView.splitReserves([]), { collected: [], idle: [] });
});

test('§5.5: the sequence from the listing, root first, each member\'s state, range (ticks) and two lots; the reference currency kept', () => {
  const body = fixture('portfolio.json');
  const armed = body.vaults.find((v) => v.address === VAULT);
  const members = portfolio.listedMembers(armed);
  assert.deepEqual(members.map((m) => [m.tokenId, m.role, m.state, m.parent]), [[7n, 'root', 'armed', null], [8n, 'successor', 'active', 7n]]);
  assert.deepEqual(members[0].range, { tickLower: -600, tickUpper: 600 });
  assert.deepEqual(members[0].lots.map((lot) => [lot.token, lot.uncharged, lot.charged]), [[USDG, 1200n, 0n], [MANY, 0n, 990n]]);
  assert.deepEqual(members[1].lots.map((lot) => [lot.uncharged, lot.charged]), [[0n, 0n], [0n, 0n]]);
  const view = vaultView.vaultViewFromListing(armed, body, WALLET, NOW);
  assert.equal(view.quoteCurrency, USDG, 'quoteCurrency() from the vault\'s state');
  assert.deepEqual(view.members.map((m) => m.tokenId), [7n, 8n]);
  // The range in the reference currency's orientation: USDG is currency0, so the price of 1 MANY in USDG; MANY's decimals
  // are not read in the fixture, so no price can be written: the ticks stand (never a guess).
  const pair = tokens.poolTokens(chains.v2Chain(4663), view.pool, portfolio.tokenMetaOf(body.tokens, 4663));
  assert.equal(tokens.referenceOrientation(view.pool, view.quoteCurrency), 'token0PerToken1');
  assert.equal(tokens.rangeWords(-600, 600, pair, 'token0PerToken1'), null);
  // A vault whose state was not read: the history alone, no range, no lots; a withdrawn successor says so.
  const moved = portfolio.listedMembers(body.vaults.find((v) => v.address === MOVED));
  assert.deepEqual(moved.map((m) => [m.tokenId, m.role, m.state, m.parent, m.range, m.lots.length]), [[31n, 'root', 'disarmed', null, null, 0], [32n, 'successor', 'withdrawn', 31n, null, 0]]);
  assert.equal(vaultView.vaultViewFromListing(body.vaults.find((v) => v.address === MOVED), body, WALLET, NOW).quoteCurrency, null);
  // The states' words.
  assert.deepEqual(['armed', 'disarmed', 'exited', 'active', 'withdrawn', 'inactive'].map(vaultView.memberStateWords), ['Automation on', 'Automation off', 'Exited', 'Active', 'Withdrawn to your wallet', 'Inactive']);
});

test('§5.4 reason 5: "Domino may turn it back on automatically." only when the data says liquidity was merely added; read-v6 rc.1 never says it', () => {
  assert.equal(vaultView.disarmText(5), 'This position changed outside Domino.');
  assert.equal(vaultView.disarmText(5, null), 'This position changed outside Domino.');
  assert.equal(vaultView.disarmText(5, false), 'This position changed outside Domino.');
  assert.equal(vaultView.disarmText(5, true), `This position changed outside Domino. ${copy.DISARM_5_ADDED}`);
  assert.equal(vaultView.disarmText(2, true), copy.DISARM_TEXT[2], 'the second sentence belongs to reason 5 alone');
  assert.equal(vaultView.disarmText('unknown', true), copy.DISARM_UNKNOWN);
  // From the listing, the sentence is never appended (the fixture's reasons 1 and 6 are untouched either way).
  const body = fixture('portfolio.json');
  for (const vault of body.vaults) {
    const view = vaultView.vaultViewFromListing(vault, body, WALLET, NOW);
    if (view.disarm) assert.doesNotMatch(view.disarm.text, /turn it back on automatically/);
  }
});

test('§5.6 recoveries: a token address and an amount in its units when known (the pool\'s, the chain\'s own), raw units otherwise; a position number above zero', () => {
  const body = fixture('portfolio.json');
  const chain = chains.v2Chain(4663);
  const pair = tokens.poolTokens(chain, { currency0: USDG, currency1: MANY }, portfolio.tokenMetaOf(body.tokens, 4663));
  const input = (token, amount) => vaultView.recoverTokenInput(4663, pair, token, amount);
  assert.deepEqual(input('', ''), { ok: false, token: null, problem: 'empty' });
  assert.deepEqual(input('', '1'), { ok: false, token: null, problem: 'empty' }, 'an empty token field is not a wrong one');
  assert.equal(input('0x12', '1').problem, 'token');
  assert.equal(input('not an address', '').problem, 'token');
  assert.deepEqual([input(USDG, '').ok, input(USDG, '').problem, input(USDG, '').token.label], [false, 'empty', 'USDG']);
  const usdg = input(USDG.toUpperCase().replace('0X', '0x'), '1.5');
  assert.equal(usdg.ok, true);
  assert.deepEqual([usdg.token.address, usdg.token.label, usdg.amount], [USDG, 'USDG', 1_500_000n], 'six decimals, the address lowercased');
  assert.equal(input(USDG, '1.1234567').problem, 'amount', 'more decimals than the token has');
  assert.equal(input(USDG, '0').problem, 'amount');
  assert.equal(input(USDG, '-1').problem, 'amount');
  // MANY's decimals are not read: raw units, whole numbers only.
  const many = input(MANY, '990');
  assert.deepEqual([many.ok, many.amount, many.token.decimals], [true, 990n, null]);
  assert.equal(input(MANY, '9.5').problem, 'amount');
  // A token the pool does not hold, known to the chain profile: native ETH, 18 decimals.
  const eth = input(ZERO, '0.5');
  assert.deepEqual([eth.ok, eth.amount, eth.token.label], [true, 500_000_000_000_000_000n, chain.nativeSymbol]);
  // An unknown token: raw units.
  const other = input('0x9999999999999999999999999999999999999999', '12');
  assert.deepEqual([other.ok, other.amount, other.token.decimals, other.token.label], [true, 12n, null, '0x9999…9999']);
  assert.equal(vaultView.recoverPositionInput(''), null);
  assert.equal(vaultView.recoverPositionInput('0'), null);
  assert.equal(vaultView.recoverPositionInput('1.5'), null);
  assert.equal(vaultView.recoverPositionInput('-3'), null);
  assert.equal(vaultView.recoverPositionInput(' 3409682 '), 3_409_682n);
});

test('§4.8: the chain\'s unclaimed figures join the index\'s credits, the chain\'s first; nothing read leaves the index\'s alone', () => {
  const body = fixture('portfolio.json');
  const indexed = portfolio.creditsOn(body, 4663, '0xa4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4');
  assert.deepEqual(indexed, [{ token: USDG, amount: 294n }]);
  assert.deepEqual(portfolio.mergeCredits(indexed, null), indexed);
  // Read on chain: USDG already claimed (0), MANY newly deferred: the chain's figures win for the tokens it was read for.
  assert.deepEqual(portfolio.mergeCredits(indexed, [{ token: USDG, amount: 0n }, { token: MANY, amount: 5n }]), [{ token: MANY, amount: 5n }]);
  // Read for other tokens only: the index's USDG stays.
  assert.deepEqual(portfolio.mergeCredits(indexed, [{ token: ZERO, amount: 7n }]), [{ token: ZERO, amount: 7n }, { token: USDG, amount: 294n }]);
  // The index off (no credits) and the chain holding something: the claim is offered from the chain alone.
  assert.deepEqual(portfolio.mergeCredits([], [{ token: USDG, amount: 0n }, { token: MANY, amount: 0n }]), []);
  assert.deepEqual(portfolio.mergeCredits([], [{ token: USDG, amount: 3n }, { token: MANY, amount: 0n }]), [{ token: USDG, amount: 3n }]);
});

test('§8.2: a successor\'s sentence says your automation holds it and to withdraw it from your automation first', () => {
  // The position page owns the wording (the review of 2026-10-03, #13): the facts are what is held here.
  // Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation"): the same facts, in those words.
  assert.match(positionConstants.SUCCESSOR_BLOCKED_COPY, /[Ww]ithdraw .*from your automation.* first\./);
  assert.match(positionConstants.SUCCESSOR_BLOCKED_COPY, /held by your automation|[Yy]our automation holds/);
  assert.doesNotMatch(positionConstants.SUCCESSOR_BLOCKED_COPY, /vault/i);
});

test('item 8 (5 Oct): a reserves return someone else sent is in the vault\'s history, in the words its vault_event had', () => {
  const activity = JSON.parse(readFileSync(join(CONTRACTS, 'read-v6', 'fixtures', 'valid', 'activity.json'), 'utf8'));
  assert.equal(runtime.validateResponse('activity', activity), true);
  const history = portfolio.historyOf(activity.items, 4663, VAULT);
  const returned = history.find((item) => item.kind === 'reserves_returned');
  assert.ok(returned, 'the return is the vault\'s');
  const words = portfolio.historyWords(returned, { chain: chains.v2Chain(4663), owner: WALLET, pool: null, meta: () => null });
  assert.equal(words.title, 'Returned to your wallet: 0.0012 USDG');
  assert.equal(words.lines.length, 1);
  assert.match(words.lines[0].value, /^Returned to your wallet: /);
});

test('one automation row per NFT: the current approval wins over index order; older funds remain recoverable', () => {
  const body = fixture('portfolio.json');
  const seed = vaultView.vaultViewFromListing(body.vaults.find((v) => v.address === VAULT), body, WALLET, NOW);
  const old = { ...seed, vault: MOVED, rootClosed: true, armed: false, status: 'off', exit: 'closed', links: { approved: false, subscribed: false, ownerHolds: true } };
  const current = { ...seed, exit: null, rootClosed: false, armed: true, status: 'on', links: { approved: true, subscribed: true, ownerHolds: true }, reserves: { known: true, held: false, list: [] } };
  for (const input of [[old, current], [current, old]]) {
    const rows = vaultView.automatedPositions(input, body);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].current.vault, VAULT);
    assert.equal(rows[0].recovery, true, 'the older closed vault still holds funds');
    assert.equal(rows[0].vaults.length, 2, 'both recovery identities retained');
    assert.equal(vaultView.automationStanding(rows[0].current), 'On');
  }
});

test('automation identity includes network and NFT manager; same token number alone never merges positions', () => {
  const body = fixture('portfolio.json');
  const seed = vaultView.vaultViewFromListing(body.vaults.find((v) => v.address === VAULT), body, WALLET, NOW);
  const views = [seed, { ...seed, dex: seed.dex === 4 ? 3 : 4 }, { ...seed, chainId: 8453 }];
  const rows = vaultView.automatedPositions(views, body);
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((row) => row.key)).size, 3);
});

test('inactive automation is hidden by default only when its known balances and successors are empty', () => {
  const body = fixture('portfolio.json');
  const seed = vaultView.vaultViewFromListing(body.vaults.find((v) => v.address === VAULT), body, WALLET, NOW);
  const closed = { ...seed, status: 'off', armed: false, rootClosed: true, exit: 'closed', successors: [], reserves: { known: true, held: false, list: [] } };
  assert.equal(vaultView.automatedPositions([closed], body)[0].active, false);
  assert.equal(vaultView.automatedPositions([{ ...closed, reserves: { known: false, reason: 'unavailable' } }], body)[0].active, true);
  assert.equal(vaultView.automatedPositions([{ ...closed, reserves: seed.reserves }], body)[0].active, true);
  const pausedClosed = { ...closed, status: 'paused', exit: null };
  assert.equal(vaultView.vaultActions(pausedClosed).includes('resume'), false, 'an empty closed NFT has no resume');
});

test('with no current NFT link, the most recently created setup wins over oldest-first portfolio ordering', () => {
  const body = fixture('portfolio.json');
  const seed = vaultView.vaultViewFromListing(body.vaults.find((v) => v.address === VAULT), body, WALLET, NOW);
  const old = { ...seed, vault: MOVED, links: { approved: null, subscribed: null, ownerHolds: null } };
  const latest = { ...old, vault: VAULT };
  const listing = { ...body, vaults: [{ chainId: 4663, address: MOVED, ownerNonce: '1' }, { chainId: 4663, address: VAULT, ownerNonce: '2' }] };
  assert.equal(vaultView.currentVaultFirst([old, latest], listing)[0].vault, VAULT);
});

test('unread custody or state is unknown, never inferred On or Off', () => {
  const body = fixture('portfolio.json');
  const original = body.vaults.find(v => v.address === VAULT);
  for (const vault of [
    { ...original, custody: { ...original.custody, armed: null } },
    { ...original, state: { status: 'unknown', reason: 'upstream_unavailable' } },
  ]) {
    assert.equal(portfolio.vaultStatus(vault), 'unknown');
    const view = vaultView.vaultViewFromListing(vault, body, WALLET, NOW);
    assert.equal(vaultView.automationStanding(view), 'State unavailable');
  }
});
