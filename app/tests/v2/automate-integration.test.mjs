/**
 * The integrated automation screens' pure parts (src/v2in/automate, src/v2in/autoexit; Domino V2 integration of
 * 2026-10-02; spec F7 rev3/rev4 §2.13, §4, §5.1, §5.2, §5.6, §6.2), on the read-v6 package's own fixtures, each held to
 * the package's validator first:
 *   - a position's vaults come from read-v6's `portfolio.vaults` (rev3: never from the NFT): its root in any state, an
 *     ACTIVE successor; a withdrawn successor's vault is not its own;
 *   - a listed vault's reserves are known only when its state was read (else a dash with the reason), "held" when one is
 *     above zero; "Withdraw to wallet" whenever one is held, in every state; "Return my reserves" only once the root is
 *     closed and no successor is active (rev4 returnReserves); a vault of another wallet offers nothing;
 *   - rev4's waiting reasons are said first, in the exact words;
 *   - the §2.13 hand-over, taken once and only for its vault;
 *   - Set up automation's own decisions: no default mode (#12), the fixed 600 s and 300 s (#27), the vault's flow for
 *     Auto-compound and Domino-compound on the preview too (the owner, 2026-10-02 night), Protection only from its own link;
 *   - Auto-exit's default orientation (the stable's price first) and its terms from the range's edges (Changed on purpose
 *     2026-10-06, the owner's point 5: no price is typed any more).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as runtime from '../../../api-contracts/read-v6/runtime.mjs';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src/v2in';
const portfolio = require(`${BUILD}/automate/portfolio.js`);
const vaultView = require(`${BUILD}/automate/vaultView.js`);
const handoff = require(`${BUILD}/automate/handoff.js`);
const intent = require(`${BUILD}/automate/intent.js`);
const constants = require(`${BUILD}/automate/constants.js`);
const form = require(`${BUILD}/automate/form.js`);
const orientation = require(`${BUILD}/autoexit/orientation.js`);
const exitForm = require(`${BUILD}/autoexit/form.js`);
const exitConstants = require(`${BUILD}/autoexit/constants.js`);

const CONTRACTS = resolve(import.meta.dirname, '../../../api-contracts');
const fixture = (name) => {
  const body = JSON.parse(readFileSync(join(CONTRACTS, 'read-v6', 'fixtures', 'valid', name), 'utf8'));
  assert.equal(runtime.validateResponse('portfolio', body), true, `${name} is a valid portfolio answer`);
  return body;
};
const WALLET = '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1';
const VAULT = '0xa2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2';
const EXITED = '0xa5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5';
const MOVED = '0xa6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const MANY = '0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a';
const NOW = 1_790_424_200;

test('a position\'s vaults come from the listing by owner: its root in any state, an active successor; never a withdrawn one', () => {
  const body = fixture('portfolio.json');
  assert.deepEqual(portfolio.vaultsOfPosition(body, 4663, '7', 4).map((e) => [e.vault.address, e.role]), [[VAULT, 'root']]);
  assert.deepEqual(portfolio.vaultsOfPosition(body, 4663, '8', 4).map((e) => [e.vault.address, e.role]), [[VAULT, 'successor']]);
  // #21's root was withdrawn by its auto-exit (exited), #31's transferred: their vaults stay listed, with their root.
  assert.deepEqual(portfolio.vaultsOfPosition(body, 4663, '21').map((e) => e.vault.address), [EXITED]);
  assert.deepEqual(portfolio.vaultsOfPosition(body, 4663, '31').map((e) => e.vault.address), [MOVED]);
  // #32 was a successor of 0xa6…, withdrawn to the wallet: a plain position again, its old vault not its own.
  assert.deepEqual(portfolio.vaultsOfPosition(body, 4663, '32'), []);
  // Another chain, another DEX: nothing.
  assert.deepEqual(portfolio.vaultsOfPosition(body, 8453, '7'), []);
  assert.deepEqual(portfolio.vaultsOfPosition(body, 4663, '7', 3), []);
});

// Added 2026-11-02 (the money review, M2). A root NFT burned by Change range or a close leaves read-v6's positions while
// its vault stays listed with its reserves. The position page (src/v2in/position/PositionPage.tsx) drew only "This position
// isn't in your wallet's list." on Base, Arbitrum One and Robinhood Chain's v3, with no way to withdraw the reserves or leave
// the automation. It now draws the automation without a position whenever the wallet owns one of the position's vaults.
test('a position the page cannot draw keeps its wallet\'s own vaults, found without the position; never another owner\'s', () => {
  const body = fixture('portfolio.json');
  const own = (answer, wallet, chainId, id, dex) => portfolio.ownVaultsOfPosition(answer, wallet, chainId, id, dex).map((e) => [e.vault.address, e.role]);
  // The root burned: read-v6 no longer lists it, and its vault is still the wallet's.
  const burned = structuredClone(body);
  burned.positions = burned.positions.filter((p) => p.tokenId !== '7');
  assert.equal(burned.positions.some((p) => p.tokenId === '7'), false);
  assert.deepEqual(own(burned, WALLET, 4663, '7', 4), [[VAULT, 'root']]);
  assert.deepEqual(own(body, WALLET.toUpperCase().replace('0X', '0x'), 4663, '7', 4), [[VAULT, 'root']], 'the wallet in any case');
  assert.deepEqual(own(body, WALLET, 4663, '8', 4), [[VAULT, 'successor']]);
  assert.deepEqual(own(body, WALLET, 4663, '21', 4), [[EXITED, 'root']]);
  // A withdrawn successor, another chain, another DEX: none.
  assert.deepEqual(own(body, WALLET, 4663, '32', 4), []);
  assert.deepEqual(own(body, WALLET, 8453, '7', 4), []);
  assert.deepEqual(own(body, WALLET, 4663, '7', 3), []);
  // An answer about another wallet, or a vault of another owner in it: nothing to act on.
  assert.deepEqual(own(body, '0x' + 'c'.repeat(40), 4663, '7', 4), []);
  const foreign = structuredClone(burned);
  foreign.vaults.find((v) => v.address === VAULT).owner = '0x' + 'c'.repeat(40);
  assert.deepEqual(own(foreign, WALLET, 4663, '7', 4), []);
  assert.deepEqual(own(foreign, WALLET, 4663, '21', 4), [[EXITED, 'root']], 'the wallet\'s other vaults unchanged');
  // That vault's owner asking with an answer that is about the first wallet: not this wallet's answer, so nothing.
  assert.deepEqual(own(foreign, '0x' + 'c'.repeat(40), 4663, '7', 4), []);
});

test('reserves: known only from a read state, a dash with the reason otherwise; "held" when one is above zero', () => {
  const body = fixture('portfolio.json');
  const [armed, exited, moved] = [VAULT, EXITED, MOVED].map((address) => body.vaults.find((v) => v.address === address));
  const read = portfolio.listedReserves(armed);
  assert.equal(read.known, true);
  assert.equal(read.held, true);
  assert.deepEqual(read.reserves.map((r) => [r.token, r.total, r.idle]), [[USDG, 1202n, 2n], [MANY, 990n, 0n]]);
  assert.deepEqual(portfolio.listedReserves(exited), { known: false, reason: exited.state.reason });
  assert.deepEqual(portfolio.listedReserves(moved), { known: false, reason: 'not_read' });
});

test('a listed vault as the screens show it: on, off with §5.4\'s reason, the root closed by its auto-exit', () => {
  const body = fixture('portfolio.json');
  const view = (address) => vaultView.vaultViewFromListing(body.vaults.find((v) => v.address === address), body, WALLET, NOW);
  const armed = view(VAULT);
  assert.equal(armed.status, 'on');
  assert.equal(armed.armed, true);
  assert.equal(armed.disarm, null);
  assert.equal(armed.mode, 2);
  assert.equal(armed.rootClosed, false, 'its root position is read live with liquidity');
  assert.deepEqual(armed.successors, [8n]);
  assert.equal(armed.ownedByWallet, true);
  assert.match(armed.waiting.text, /^Waiting until fees cover the network cost · since /);
  const exited = view(EXITED);
  assert.equal(exited.armed, false);
  assert.equal(exited.disarm.reason, 6);
  assert.equal(exited.disarm.text, 'Auto-exit executed.');
  assert.equal(exited.rootClosed, true);
  assert.equal(exited.reserves.known, false);
  const moved = view(MOVED);
  assert.equal(moved.disarm.reason, 1);
  assert.equal(moved.rootClosed, null, 'nothing says whether a transferred root still holds liquidity');
  // The same vault read for another wallet: shown, nothing offered.
  const theirs = vaultView.vaultViewFromListing(body.vaults[0], body, '0x0000000000000000000000000000000000000001', NOW);
  assert.equal(theirs.ownedByWallet, false);
  assert.deepEqual(vaultView.vaultActions(theirs), []);
});

test('rev3/rev4: "Withdraw to wallet" whenever a reserve is held, in every state; "Return my reserves" only with the root closed and no successor active', () => {
  const body = fixture('portfolio.json');
  const base = vaultView.vaultViewFromListing(body.vaults[0], body, WALLET, NOW);
  // §5.6's two recoveries are always the owner's, last, under the page card's Advanced.
  const ADVANCED = ['recover-token', 'recover-position'];
  assert.deepEqual([...vaultView.VAULT_ADVANCED_ACTIONS], ADVANCED);
  // Armed, with a successor: withdraw (and pause, the successor's own withdrawal, leave), never return.
  assert.deepEqual(vaultView.reservesOffer(base), { withdraw: true, returnable: false });
  assert.deepEqual(vaultView.vaultActions(base), ['withdraw', 'pause', 'withdraw-child', 'leave', ...ADVANCED]);
  // The root closed (an S1 exit, or directly on Uniswap) with the successor still active: withdraw only.
  const closed = { ...base, armed: false, status: 'off', rootClosed: true, disarm: { reason: 2, text: '', since: null } };
  assert.deepEqual(vaultView.reservesOffer(closed), { withdraw: true, returnable: false });
  assert.deepEqual(vaultView.vaultActions(closed), ['withdraw', 'withdraw-child', 'leave', ...ADVANCED]);
  // …and once no successor is active: return too. Never the rearm of a closed root, and no successor to withdraw.
  const lone = { ...closed, successors: [] };
  assert.deepEqual(vaultView.reservesOffer(lone), { withdraw: true, returnable: true });
  assert.deepEqual(vaultView.vaultActions(lone), ['withdraw', 'return', 'leave', ...ADVANCED]);
  // A burned root: the same.
  assert.deepEqual(vaultView.vaultActions({ ...lone, disarm: { reason: 3, text: '', since: null } }), ['withdraw', 'return', 'leave', ...ADVANCED]);
  // A paused vault keeps its reserves reachable.
  assert.deepEqual(vaultView.vaultActions({ ...base, status: 'paused', paused: true }), ['withdraw', 'resume', 'withdraw-child', 'leave', ...ADVANCED]);
  // Custody lost on a root that still holds liquidity: the rearm (decision #5), withdraw, leave; nothing to return.
  const lost = { ...base, armed: false, status: 'off', rootClosed: false, successors: [], disarm: { reason: 4, text: '', since: null } };
  assert.deepEqual(vaultView.vaultActions(lost), ['withdraw', 'rearm', 'leave', ...ADVANCED]);
  // Nothing held: no withdraw, no return.
  const empty = { ...lone, reserves: { known: true, list: [], held: false } };
  assert.deepEqual(vaultView.reservesOffer(empty), { withdraw: false, returnable: false });
  // Unread reserves: nothing offered from the listing (the dialog reads the chain itself, under live).
  assert.deepEqual(vaultView.reservesOffer({ ...lone, reserves: { known: false, reason: 'not_read' } }), { withdraw: false, returnable: false });
  // After exitAll on v4: turn it back on (changed on purpose 2026-11-02, the owner), or remove Domino and revoke the
  // approval, while they still link the root to the vault. A root no longer in the wallet: neither.
  const ended = { ...lost, disarm: { reason: 7, text: '', since: null }, reserves: { known: true, list: [], held: false }, links: { subscribed: true, approved: true, ownerHolds: true } };
  assert.deepEqual(vaultView.vaultActions(ended), ['rearm', 'unsubscribe', 'revoke', ...ADVANCED]);
  assert.deepEqual(vaultView.vaultActions({ ...ended, links: { subscribed: true, approved: true, ownerHolds: false } }), ADVANCED);
  // "Turn back on" also resumes only what Leave automation paused: a pause someone made on purpose stays, and Auto-exit's own vault never resumes.
  const restarts = (reason, pausedBy = null, exit = null) => vaultView.restartsAfterLeave({ exit, pausedBy, disarm: { reason, text: '', since: null } });
  assert.equal(restarts(7), true);
  assert.equal(restarts(7, 'you'), true, 'left after pausing it');
  assert.equal(restarts('unknown'), true, 'read right after leaving, before the listing caught up');
  assert.equal(restarts('unknown', 'you'), false);
  assert.equal(restarts('unknown', 'Domino'), false);
  assert.equal(restarts(4), false);
  assert.equal(restarts(7, null, 'off'), false);
  // Another wallet's vault: nothing, the recoveries included.
  assert.deepEqual(vaultView.vaultActions({ ...base, ownedByWallet: false }), []);
});

test('rev4\'s waiting reasons are said first, in the exact words', () => {
  const at = NOW - 180;
  const waiting = (reason, error = null) => ({ reason, error, since: at, sinceBlock: 1, checkedAt: NOW, checkedBlock: 2, lastRevert: null });
  assert.deepEqual(portfolio.waitingWords(waiting('reserves_returnable'), 4663, NOW), { text: 'Your position is closed. Its waiting fees are being returned to your wallet · since 3 min ago', code: 'reserves_returnable' });
  // Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation").
  assert.deepEqual(portfolio.waitingWords(waiting('reserves_unpayable', 'TokenCallFailed'), 4663, NOW), { text: "Your position is closed, but your wallet can't receive one of the tokens. Withdraw it from your automation · since 3 min ago", code: 'reserves_unpayable' });
  assert.equal(portfolio.waitingWords(waiting('root_disarmed'), 4663, NOW), null, 'what the card already says is not said twice');
  assert.match(portfolio.waitingWords(waiting('gas_not_covered'), 4663, NOW).text, /^Waiting until fees cover the network cost/);
  // Added 2026-10-04 (rugged97's delta of 4 Oct §2 items 4 and 5): RootOpen and SuccessorActive are the automatic return
  // waiting its turn, the normal state: no line, whatever the reason says; TwapWindowTooLong waits for a valid reference.
  for (const error of ['RootOpen', 'SuccessorActive']) {
    assert.equal(portfolio.waitingWords(waiting('reserves_held', error), 4663, NOW), null, error);
    assert.equal(portfolio.waitingWords(waiting('gas_not_covered', error), 4663, NOW), null, `${error}, any reason`);
  }
  assert.deepEqual(portfolio.waitingWords(waiting('execution_reverted', 'TwapWindowTooLong'), 4663, NOW), { text: 'Waiting for a valid reference price · since 3 min ago', code: 'TwapWindowTooLong' });
});

test('the §2.13 hand-over is taken once, only for its chain and vault; anything malformed is ignored', () => {
  handoff.offerVault({ chainId: 4663, vault: VAULT.toUpperCase().replace('0X', '0x'), focus: 'reserves' });
  assert.equal(handoff.takeVault(8453, VAULT), null);
  assert.equal(handoff.takeVault(4663, MOVED), null);
  assert.deepEqual(handoff.takeVault(4663, VAULT), { chainId: 4663, vault: VAULT, focus: 'reserves' });
  assert.equal(handoff.takeVault(4663, VAULT), null, 'taken once');
  handoff.offerVault({ chainId: 1, vault: VAULT, focus: 'rearm' });
  handoff.offerVault({ chainId: 4663, vault: '0x12', focus: 'rearm' });
  handoff.offerVault({ chainId: 4663, vault: VAULT, focus: 'withdraw' });
  assert.equal(handoff.waitingVault(), null);
  const heard = [];
  const off = handoff.onVaultOffered((offer) => heard.push(offer.focus));
  handoff.offerVault({ chainId: 4663, vault: VAULT, focus: 'leave' });
  off();
  handoff.offerVault({ chainId: 4663, vault: VAULT, focus: 'rearm' });
  assert.deepEqual(heard, ['leave']);
  assert.equal(handoff.takeVault(4663, VAULT).focus, 'rearm', 'a later offer replaces one not taken');
});

test('Set up automation: no default mode, fixed 600 s and 300 s, the vault\'s three ways while preview (the owner, 2026-10-02 night), Protection only from its link', () => {
  assert.equal(constants.VAULT_DEFAULT_MODE, null);
  assert.equal(constants.VAULT_MINIMUM_INTERVAL_SECONDS, 600);
  assert.equal(constants.VAULT_OBSERVATION_AGE_SECONDS, 300);
  // The vault's flow for all three modes on the preview too (the owner, 2026-10-02 night): no switch to V1's sequence exists any more.
  assert.equal('SETUP_COMPOUNDING_IN_PREVIEW' in constants, false);
  assert.deepEqual(constants.VAULT_PROTECTION_ONLY, { startPaused: true, mode: 1, maxPositions: 1 });
  const fresh = form.defaultSettingsForm();
  assert.equal(fresh.mode, null);
  assert.equal(form.settingsFrom(fresh, 4).ok, false, 'nothing is created before a mode is picked');
  const domino = form.settingsFrom({ ...fresh, mode: 2 }, 4);
  assert.equal(domino.ok, true);
  assert.deepEqual([domino.policy.minimumIntervalSeconds, domino.limits.maxObservationAgeSeconds, domino.limits.maxSlippageBps, domino.limits.maxPriceImpactBps], [600, 300, 100, 100]);
  assert.equal(form.settingsFrom({ ...fresh, mode: 1, maxSlippagePercent: '5.01' }, 4).ok, false, 'the screen\'s 5% cap');
  assert.equal(form.bandWarning('1'), null);
  assert.match(form.bandWarning('1.5'), /^A wider band/);
  assert.match(form.bandWarning('3'), /^Risky/);
  const protection = form.protectionSettings();
  assert.deepEqual([protection.policy.mode, protection.policy.maxPositions, protection.policy.minimumIntervalSeconds], [1, 1, 600]);
  assert.deepEqual(intent.protectionIntent('#/sequence/protection/3409682'), { mode: 'protection', tokenId: '3409682' });
  assert.deepEqual(intent.protectionIntent('#/sequence/protection'), { mode: 'protection', tokenId: null });
  assert.equal(intent.protectionIntent('#/sequence/compound/1'), null);
  assert.deepEqual(intent.protectionIntent('#/sequence/protection/x'), { mode: 'protection', tokenId: null });
});

// Changed on purpose 2026-10-06 (the owner's point 5; rugged97: "when the price hits the edge of the range we close the
// position automatically"): Auto-exit's prices are the range's edges, its other terms fixed (both tokens, decision #19's
// 1%, a year: the app's longest validity, for an autonomous service).
test('Auto-exit reads the stable\'s price first, and signs the range\'s edges with fixed terms', () => {
  const ethUsdg = { currency0: '0x0000000000000000000000000000000000000000', currency1: USDG };
  assert.equal(orientation.defaultOrientation(4663, ethUsdg), 'token1PerToken0', 'USDG per ETH');
  assert.equal(orientation.defaultOrientation(4663, { currency0: USDG, currency1: MANY }), 'token0PerToken1', 'USDG per MANY');
  assert.equal(exitConstants.AUTO_EXIT_DEFAULT_SLIPPAGE_BPS, 100, 'decision #19: 1% by default');
  assert.equal(exitConstants.AUTO_EXIT_DEFAULT_VALIDITY_DAYS, 365);
  assert.equal('AUTO_EXIT_SLIPPAGE_SHORTCUTS_BPS' in exitConstants, false, 'no shortcuts: nothing is typed');
  const range = { tickLower: -201060, tickUpper: -198060 };
  const inside = exitForm.exitEdges(range, 3_700_000_000_000_000_000_000_000n, 60);
  assert.equal(inside.ok, true);
  const terms = exitForm.autoExitTerms(inside.edges, NOW);
  assert.deepEqual([terms.receiveMode, terms.convertTo, terms.maxSlippageBps], [0, '0x0000000000000000000000000000000000000000', 100]);
  assert.equal(terms.validUntil, BigInt(NOW + 365 * 86_400));
});

// Added 2026-10-04 (rugged97's delta of 4 Oct §2 item 1): the address typed for "Send to another address you own".
test('the recipient typed after a refused transfer: a wallet address, never the wallet that refused, the vault or a pool token; nothing said while empty', () => {
  const refused = { owner: WALLET, vault: VAULT, tokens: [USDG, MANY] };
  const other = '0xc3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';
  assert.deepEqual(vaultView.withdrawRecipientInput('', refused), { ok: false, problem: 'empty' });
  assert.deepEqual(vaultView.withdrawRecipientInput('   ', refused), { ok: false, problem: 'empty' });
  assert.deepEqual(vaultView.withdrawRecipientInput(`  ${other.toUpperCase().replace('0X', '0x')} `, refused), { ok: true, address: other }, 'trimmed, any case');
  for (const text of ['0x1234', 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3', `0x${'0'.repeat(40)}`, `${other}00`]) {
    assert.deepEqual(vaultView.withdrawRecipientInput(text, refused), { ok: false, problem: 'address' }, text);
  }
  assert.deepEqual(vaultView.withdrawRecipientInput(WALLET, refused), { ok: false, problem: 'same-wallet' });
  for (const text of [VAULT, USDG, MANY]) assert.deepEqual(vaultView.withdrawRecipientInput(text, refused), { ok: false, problem: 'not-a-wallet' }, text);
  assert.deepEqual(vaultView.withdrawRecipientInput(WALLET, { ...refused, owner: null }), { ok: true, address: WALLET }, 'no session: the client still refuses what is no wallet');
});
