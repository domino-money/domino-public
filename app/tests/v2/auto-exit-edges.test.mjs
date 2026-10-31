/**
 * Added 2026-10-06 (the owner's point 5; rugged97: "this stop loss-take profit product was named wrong. It is AUTO-EXIT.
 * When the price hits the edge of the range we close the position automatically and send the tokens to the wallet. It
 * must be automatic"). Auto-exit's pure parts (src/v2in/autoexit/form.ts, words.ts, card.ts):
 *   - the triggers are the range's edges, exactly sqrtPriceAtTick(tickLower) and sqrtPriceAtTick(tickUpper);
 *   - both while the price is inside the range; only the far edge for a range beside the price (the near one is already
 *     crossed and would fire at once); an edge TickMath cannot reach is left off; no edge without a range and a price;
 *   - the fixed terms: both tokens, 1% slippage, a year;
 *   - the edges said in the app's price words, the falling one first, in either orientation; the one status line;
 *   - the wallet's one live line ("Step 1 of 2 · Sign in your wallet");
 *   - the card's state from read-v6's orders and this page's own registrations: on, paused (its first reason), closed,
 *     off.
 * Changed on purpose 2026-10-06 (the review of point 5): an edge is armed only while the price is strictly short of it
 * (the module fires at the lower trigger at or below it); an end at the usable tick limit of its spacing is never
 * reached, and a full range has nothing to close at; an edge within the 1% band of the price is said; the card's line
 * no longer repeats "Auto-exit on"; the waiting lines and the Positions badge speak Auto-exit's words.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src';
const form = require(`${BUILD}/v2in/autoexit/form.js`);
const words = require(`${BUILD}/v2in/autoexit/words.js`);
const card = require(`${BUILD}/v2in/autoexit/card.js`);
const { sqrtPriceAtTick, MIN_TICK, MAX_TICK } = require(`${BUILD}/lib/read/screens/poolRange.js`);
const { sqrtPriceX96FromPrice, MAX_SQRT_PRICE } = require(`${BUILD}/v2/trigger.js`);

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const ETH = '0x0000000000000000000000000000000000000000';
const ORB = '0x8888888888888888888888888888888888888888';
const NOW = 1_790_870_000;
const DECIMALS = { decimals0: 18, decimals1: 6 };
/** ETH / USDG as the screens name it (tokens in pool order). */
const TOKENS = [{ address: ETH, label: 'ETH', decimals: 18, known: true }, { address: USDG, label: 'USDG', decimals: 6, known: true }];
const at = (price) => sqrtPriceX96FromPrice(price, DECIMALS, 'token1PerToken0').sqrtPriceX96;
/** A range from about 2,000 to 3,000 USDG per ETH, in the pool's ticks (spacing 60): 1,994.25 and 2,998.90 exactly as written. */
const RANGE = { tickLower: -200340, tickUpper: -196260 };

test('the triggers are the range\'s edges, exactly; both while the price is inside the range', () => {
  const check = form.exitEdges(RANGE, at('2500'), 60);
  assert.equal(check.ok, true);
  assert.equal(check.edges.side, 'inside');
  assert.equal(check.edges.triggerBelowSqrtPriceX96, sqrtPriceAtTick(RANGE.tickLower), 'the lower edge, TickMath\'s own integer');
  assert.equal(check.edges.triggerAboveSqrtPriceX96, sqrtPriceAtTick(RANGE.tickUpper));
  // The pool counts a position in range for lower <= price < upper: the lower edge is inside, the upper is not.
  assert.equal(form.priceSide(RANGE, sqrtPriceAtTick(RANGE.tickLower)), 'inside');
  assert.equal(form.priceSide(RANGE, sqrtPriceAtTick(RANGE.tickUpper)), 'above');
});

// Changed on purpose 2026-10-06 (the review of point 5): the module fires at the lower trigger at or below it.
test('a price resting exactly on an edge has reached it: that edge is never armed, the other one is', () => {
  const lower = sqrtPriceAtTick(RANGE.tickLower);
  const upper = sqrtPriceAtTick(RANGE.tickUpper);
  const onLower = form.exitEdges(RANGE, lower, 60);
  assert.deepEqual([onLower.edges.side, onLower.edges.triggerBelowSqrtPriceX96, onLower.edges.triggerAboveSqrtPriceX96], ['inside', 0n, upper], 'in range for the pool, but the lower edge is reached');
  const justAbove = form.exitEdges(RANGE, lower + 1n, 60);
  assert.deepEqual([justAbove.edges.triggerBelowSqrtPriceX96, justAbove.edges.triggerAboveSqrtPriceX96], [lower, upper], 'one unit above it: both');
  const onUpper = form.exitEdges(RANGE, upper, 60);
  assert.deepEqual([onUpper.edges.side, onUpper.edges.triggerBelowSqrtPriceX96, onUpper.edges.triggerAboveSqrtPriceX96], ['above', lower, 0n]);
  const justBelow = form.exitEdges(RANGE, upper - 1n, 60);
  assert.deepEqual([justBelow.edges.triggerBelowSqrtPriceX96, justBelow.edges.triggerAboveSqrtPriceX96], [lower, upper]);
  // The client's own rule is the module's: reached at or past an armed edge, never by an edge that is off.
  const { triggerReached } = require(`${BUILD}/finance/v2/autoExit.js`);
  assert.equal(triggerReached({ triggerBelowSqrtPriceX96: lower, triggerAboveSqrtPriceX96: upper }, lower), true);
  assert.equal(triggerReached({ triggerBelowSqrtPriceX96: lower, triggerAboveSqrtPriceX96: upper }, lower + 1n), false);
  assert.equal(triggerReached({ triggerBelowSqrtPriceX96: lower, triggerAboveSqrtPriceX96: upper }, upper), true);
  assert.equal(triggerReached({ triggerBelowSqrtPriceX96: 0n, triggerAboveSqrtPriceX96: 0n }, 1n), false, 'an edge that is off never fires');
});

test('a range beside the price (a buy or a sell) arms only its far edge: the near one is already crossed', () => {
  const below = form.exitEdges(RANGE, at('1500'), 60);
  assert.deepEqual([below.edges.side, below.edges.triggerBelowSqrtPriceX96, below.edges.triggerAboveSqrtPriceX96], ['below', 0n, sqrtPriceAtTick(RANGE.tickUpper)], 'the price under the range: only the top');
  const above = form.exitEdges(RANGE, at('4000'), 60);
  assert.deepEqual([above.edges.side, above.edges.triggerBelowSqrtPriceX96, above.edges.triggerAboveSqrtPriceX96], ['above', sqrtPriceAtTick(RANGE.tickLower), 0n], 'the price over the range: only the bottom');
});

test('no edge without a range, a spacing and a price; an end at the usable tick limit of its spacing is never reached; a full range has none', () => {
  assert.deepEqual(form.exitEdges(RANGE, null, 60), { ok: false, problem: 'price_unknown' });
  assert.deepEqual(form.exitEdges(RANGE, 0n, 60), { ok: false, problem: 'price_unknown' });
  assert.deepEqual(form.exitEdges(null, at('2500'), 60), { ok: false, problem: 'range_invalid' });
  for (const spacing of [0, -60, 1.5, 40_000, undefined]) assert.deepEqual(form.exitEdges(RANGE, at('2500'), spacing), { ok: false, problem: 'range_invalid' }, String(spacing));
  for (const range of [{ tickLower: 10, tickUpper: 10 }, { tickLower: 1.5, tickUpper: 60 }, { tickLower: MIN_TICK - 1, tickUpper: 0 }, { tickLower: 0, tickUpper: MAX_TICK + 1 }]) {
    assert.deepEqual(form.exitEdges(range, at('2500'), 60), { ok: false, problem: 'range_invalid' }, JSON.stringify(range));
  }
  // Uniswap's full ranges sit at the spacing-rounded extremes (lib/read/screens/poolRange.ts usableTicks): ±887,270 on
  // 10, ±887,220 on 60, ±887,200 on 200. Neither end is ever reached, whatever the price: nothing to close at.
  for (const [spacing, edge] of [[10, 887_270], [60, 887_220], [200, 887_200], [1, 887_272]]) {
    const range = { tickLower: -edge, tickUpper: edge };
    assert.equal(form.fullRange(range, spacing), true, `spacing ${spacing}`);
    for (const price of [at('2500'), null, sqrtPriceAtTick(0)]) assert.deepEqual(form.exitEdges(range, price, spacing), { ok: false, problem: 'full_range' }, `spacing ${spacing}`);
    // One end at the limit: the other alone, while the price is short of it.
    const toTop = form.exitEdges({ tickLower: -60_000, tickUpper: edge }, sqrtPriceAtTick(0), spacing);
    assert.deepEqual([toTop.edges.triggerBelowSqrtPriceX96, toTop.edges.triggerAboveSqrtPriceX96], [sqrtPriceAtTick(-60_000), 0n], `spacing ${spacing}: the bottom only`);
    const fromBottom = form.exitEdges({ tickLower: -edge, tickUpper: 60_000 }, sqrtPriceAtTick(0), spacing);
    assert.deepEqual([fromBottom.edges.triggerBelowSqrtPriceX96, fromBottom.edges.triggerAboveSqrtPriceX96], [0n, sqrtPriceAtTick(60_000)], `spacing ${spacing}: the top only`);
    // Beside the price with its far end at the limit: the near end is crossed, the far one never reached.
    assert.deepEqual(form.exitEdges({ tickLower: 60_000, tickUpper: edge }, sqrtPriceAtTick(0), spacing), { ok: false, problem: 'edges_unreachable' }, `spacing ${spacing}`);
  }
  assert.equal(form.fullRange({ tickLower: -887_160, tickUpper: 887_220 }, 60), false, 'one spacing short of the bottom: reachable');
  assert.equal(form.fullRange(RANGE, 60), false);
  assert.deepEqual(form.reachableEnds({ tickLower: -887_220, tickUpper: 600 }, 60), { lower: false, upper: true });
  assert.equal(sqrtPriceAtTick(MAX_TICK), MAX_SQRT_PRICE);
});

test('an armed edge within the 1% band of the price is said: the band of the price, as the anchor compares it', () => {
  const lower = sqrtPriceAtTick(RANGE.tickLower);
  const edges = { triggerBelowSqrtPriceX96: lower, triggerAboveSqrtPriceX96: 0n };
  // 99 ticks above the edge is about 0.99% in price: inside the band; 101 ticks, about 1.01%: outside.
  assert.equal(form.nearEdge(edges, sqrtPriceAtTick(RANGE.tickLower + 99), 100), true);
  assert.equal(form.nearEdge(edges, sqrtPriceAtTick(RANGE.tickLower + 101), 100), false);
  assert.equal(form.nearEdge({ triggerBelowSqrtPriceX96: 0n, triggerAboveSqrtPriceX96: sqrtPriceAtTick(RANGE.tickUpper) }, sqrtPriceAtTick(RANGE.tickUpper - 20), 100), true, 'the upper edge 0.2% away');
  assert.equal(form.nearEdge({ triggerBelowSqrtPriceX96: 0n, triggerAboveSqrtPriceX96: 0n }, at('2500'), 100), false, 'nothing armed');
  assert.equal(form.nearEdge(form.exitEdges(RANGE, at('2500'), 60).edges, at('2500'), 100), false, 'both ends far from 2,500');
});

test('the fixed terms: both tokens as withdrawn, 1% on top of the pool fee, valid for a year', () => {
  const { edges } = form.exitEdges(RANGE, at('2500'), 60);
  const terms = form.autoExitTerms(edges, NOW + 0.7);
  assert.deepEqual(terms, {
    triggerBelowSqrtPriceX96: edges.triggerBelowSqrtPriceX96,
    triggerAboveSqrtPriceX96: edges.triggerAboveSqrtPriceX96,
    receiveMode: 0,
    convertTo: ETH,
    maxSlippageBps: 100,
    validUntil: BigInt(NOW + 365 * 86_400),
  });
  assert.ok(Object.isFrozen(terms));
});

test('the edges in the app\'s price words, the falling one first, in either orientation; the one status line', () => {
  const { edges } = form.exitEdges(RANGE, at('2500'), 60);
  const said = words.edgesOf(edges, TOKENS, 'token1PerToken0');
  assert.deepEqual(said.map((edge) => [edge.move, edge.field]), [['falls', 'triggerBelowSqrtPriceX96'], ['rises', 'triggerAboveSqrtPriceX96']]);
  // Changed on purpose 2026-10-30 (QA round 2, N2): the screens' one price rule (src/v2/plan/present.ts priceText), two
  // decimals from 1,000 up, as V2 Review and the position page write the same range ("2,998.9" was six significant digits).
  assert.deepEqual(said.map((edge) => edge.price), ['1,994.25', '2,998.90'], 'two decimals from 1,000 up, as the range is written');
  assert.equal(words.closesAtWords(said, TOKENS, 'token1PerToken0'), '1,994.25 – 2,998.90 USDG per ETH');
  // Changed on purpose 2026-10-06 (the review of point 5): under the card's title "Auto-exit" and its "On" pill.
  assert.equal(words.onLine(said, TOKENS, 'token1PerToken0'), 'Closes at 1,994.25 – 2,998.90 USDG per ETH');
  // The other way round: the upper sqrt price is the lower figure, and it is the one the price "falls" to.
  const inverse = words.edgesOf(edges, TOKENS, 'token0PerToken1');
  assert.deepEqual(inverse.map((edge) => [edge.move, edge.field]), [['falls', 'triggerAboveSqrtPriceX96'], ['rises', 'triggerBelowSqrtPriceX96']]);
  assert.match(words.closesAtWords(inverse, TOKENS, 'token0PerToken1'), /^0\.000333\d* – 0\.0005\d* ETH per USDG$/);
  // One far edge: one price.
  const sell = words.edgesOf(form.exitEdges(RANGE, at('1500'), 60).edges, TOKENS, 'token1PerToken0');
  assert.equal(sell.length, 1);
  assert.equal(words.onLine(sell, TOKENS, 'token1PerToken0'), 'Closes at 2,998.90 USDG per ETH');
  // A token whose decimals are unknown: never a guessed price.
  const unknown = [TOKENS[0], { address: ORB, label: 'ORB', decimals: null, known: false }];
  const blind = words.edgesOf(edges, unknown, 'token1PerToken0');
  assert.deepEqual(blind.map((edge) => edge.price), [null, null]);
  assert.equal(words.closesAtWords(blind, unknown, 'token1PerToken0'), null);
  assert.equal(words.onLine(blind, unknown, 'token1PerToken0'), 'Closes at the ends of your range');
  // Closed: the tokens were sent only when nothing waits to be claimed. Changed on purpose 2026-10-06 (rugged's answer of
  // 7 Oct: only current controls here; execution results belong in Activity, and zero does not prove delivery.
  assert.equal(words.closedLine(false), 'View the result in Activity.');
  assert.equal(words.closedLine(true), 'You have tokens available to claim below.');
  assert.equal(words.receiveWords(0, ETH, TOKENS), 'Both tokens');
  assert.match(words.triggerWords('triggerBelowSqrtPriceX96', edges.triggerBelowSqrtPriceX96, TOKENS, 'token1PerToken0'), /^Closes if the price falls to [\d,.]+ USDG per ETH$/);
});

// Added 2026-10-06 (rugged's answer of 6 Oct, §4 item 5, and the spec delta of 6 Oct §2: one "Turn on Auto-exit" is the
// §4.7 acknowledgement only with warnings 1 and 2, and 3 on a v3 pool, in view above it; 5 to 7 may stay under Details).
test('the warnings the button accepts stand above it: 1 and 2, and 3 on a v3 pool; 5 and 7 under Details; never 4 (no conversion) or 6 (one per position)', () => {
  const { AUTO_EXIT_TEXT } = require(`${BUILD}/finance/v2/autoExit.js`);
  assert.deepEqual(words.exitWarnings(4), {
    inView: ['autoexit_warning_not_guaranteed', 'autoexit_warning_reference_price'],
    details: ['autoexit_warning_turn_off_pauses', 'autoexit_warning_halt'],
  });
  assert.deepEqual(words.exitWarnings(3), {
    inView: ['autoexit_warning_not_guaranteed', 'autoexit_warning_reference_price', 'autoexit_warning_v3_twap'],
    details: ['autoexit_warning_turn_off_pauses', 'autoexit_warning_halt'],
  });
  // The spec delta of 6 Oct §3's words for 5 and 7.
  assert.equal(AUTO_EXIT_TEXT.autoexit_warning_turn_off_pauses, "Leave automation pauses Auto-exit; it doesn't turn it off for good.");
  assert.equal(AUTO_EXIT_TEXT.autoexit_warning_halt, 'If Domino stops automation for safety, Auto-exit stops too. You can still turn it off and withdraw at any time.');
  assert.equal(AUTO_EXIT_TEXT.autoexit_warning_other_orders, 'If one Auto-exit closes the position, any other on it stays active.');
});

test('the wallet\'s one live line: the step and what it waits for, nothing at rest', () => {
  assert.equal(words.runLine([{ phase: 'idle' }, { phase: 'idle' }]), null);
  assert.equal(words.runLine([{ phase: 'working', note: 'signing' }, { phase: 'idle' }]), 'Step 1 of 2 · Sign in your wallet');
  assert.equal(words.runLine([{ phase: 'signed' }, { phase: 'working', note: 'wallet' }]), 'Step 2 of 2 · Confirm in your wallet');
  assert.equal(words.runLine([{ phase: 'signed' }, { phase: 'sent' }]), 'Step 2 of 2 · Waiting for the network');
  assert.equal(words.runLine([{ phase: 'signed' }, { phase: 'working', note: 'checking' }]), 'Step 2 of 2 · Checking');
  assert.equal(words.runLine([{ phase: 'working', note: 'wallet' }]), 'Confirm in your wallet', 'one step alone has no count');
  assert.equal(words.runLine([{ phase: 'signed' }, { phase: 'finalized' }]), null);
});

/** A read-v6 order of position #7, as the package lists them. */
const order = (fields = {}) => ({
  chainId: 4663, mandateHash: `0x${'ab'.repeat(32)}`, module: '0xm', owner: '0xo', vault: '0xv', vaultIsDomino: true, tokenId: '7', position: 'root', validUntil: NOW + 86_400,
  registered: { hash: `0x${'cd'.repeat(32)}`, snapshot: { hash: `0x${'ef'.repeat(32)}`, number: 1, timestamp: NOW - 100 } },
  status: 'active', expired: false, moduleEnabled: true, blockedBy: [], terms: { triggerBelowSqrtPriceX96: '100', triggerAboveSqrtPriceX96: null, receive: 'both', convertTo: null, maxSlippageBps: 100 },
  revoked: null, executed: null, waiting: null, ...fields,
});

test('the card\'s state: on, paused with its first reason, closed with what it delivered, off; this page\'s registration counts until it is listed', () => {
  assert.deepEqual(card.exitCardState([], []), { kind: 'off' });
  const on = card.exitCardState([order()], []);
  assert.deepEqual(on, { kind: 'on', id: `0x${'ab'.repeat(32)}`, triggers: { below: 100n, above: 0n }, listed: true });
  const paused = card.exitCardState([order({ blockedBy: ['module_disabled', 'automation_halted'] })], []);
  assert.deepEqual([paused.kind, paused.reasons, paused.moduleOff], ['paused', ['mandate_module_off', 'mandate_halted'], true]);
  assert.equal(card.exitCardState([order({ blockedBy: ['custody_unread'] })], []).kind, 'on', 'an unread custody is no reason');
  assert.deepEqual(card.exitCardState([order({ expired: true })], []), { kind: 'off' }, 'expired: off');
  assert.deepEqual(card.exitCardState([order({ status: 'revoked' })], []), { kind: 'off' }, 'turned off');
  const closed = card.exitCardState([order({ status: 'executed', executed: { tx: order().registered, anchorSqrtPriceX96: '9', delivered: ['5', '6'] } })], []);
  assert.deepEqual(closed, { kind: 'closed', id: `0x${'ab'.repeat(32)}`, delivered: [5n, 6n] });
  const mine = [{ chainId: 4663, owner: '0xo', id: `0x${'12'.repeat(32)}`, nonce: 1n, vault: '0xv', tokenId: 7n, registered: true, triggers: { below: 1n, above: 2n } }];
  assert.deepEqual(card.exitCardState([], mine), { kind: 'on', id: `0x${'12'.repeat(32)}`, triggers: { below: 1n, above: 2n }, listed: false });
  assert.equal(card.exitCardState([], [{ ...mine[0], registered: false }]).kind, 'off', 'signed is not on');
  assert.equal(card.exitCardState([order({ status: 'executed' })], mine).kind, 'on', 'a newer one turned on here wins over an old exit');
});

// Added 2026-10-06 (rugged's answer of 6 Oct, §4 item 7 and the spec delta §3: one Auto-exit per position; a second one active
// on the same position executes with value zero when it fires, the operator paying its gas): what Auto-exit's dialog asks
// read-v6 right before the signature.
test('one Auto-exit per position: an active one listed on the position counts, paused too; expired, turned off, closed, another position\'s or another DEX\'s does not', () => {
  const vault = (fields = {}) => ({ chainId: 4663, address: '0xv', dex: 4, ...fields });
  const on = (mandates, vaults = [vault()], { chainId = 4663, tokenId = '7', dex = 4, off } = {}) => card.exitOnPosition({ vaults, mandates }, chainId, tokenId, dex, off);
  assert.equal(on([]), false, 'none listed');
  assert.equal(on([order()]), true, 'an active one in the position\'s vault');
  assert.equal(on([order({ blockedBy: ['module_disabled'] })]), true, 'a paused one still closes the position once unblocked');
  assert.equal(on([order({ blockedBy: ['custody_lost'] })]), true);
  assert.equal(on([order()], []), true, 'its vault not listed: it counts');
  assert.equal(on([order({ vault: '0xV' })], [vault({ dex: 3 })]), false, 'its vault found whatever the case of the address (a v3 one here)');
  assert.equal(on([order({ expired: true })]), false, 'expired: it never executes');
  assert.equal(on([order({ status: 'revoked' })]), false, 'turned off');
  assert.equal(on([order({ status: 'executed' })]), false, 'it closed the position');
  assert.equal(on([order()], [vault()], { off: new Set([`0x${'ab'.repeat(32)}`]) }), false, 'turned off on this page while the index still lists it');
  assert.equal(on([order()], [vault()], { tokenId: '8' }), false, 'another position');
  assert.equal(on([order()], [vault()], { chainId: 8453 }), false, 'another chain');
  assert.equal(on([order()], [vault({ dex: 3 })]), false, 'a v3 NFT with the same number');
  assert.equal(on([order({ status: 'revoked' }), order({ mandateHash: `0x${'cd'.repeat(32)}` })]), true, 'one turned off, a newer one on');
});

// Added 2026-10-06 (rugged's answer of 6 Oct, §4 item 6: read-v6 drops custody_lost only once it reads the position again, up to
// about 30 minutes; "the app keeps 'approved at block X' until positions[].state.snapshot.number ≥ X").
test('an approval given back on this page: custody_lost no longer pauses its Auto-exit while read-v6 read the position before it; read at or after it, read-v6\'s word stands', () => {
  const store = require(`${BUILD}/v2in/automate/store.js`);
  store.forgetAutomationSession();
  const blocked = { reason: 'reverted_automation_unavailable', error: 'AutomationUnavailable', since: NOW - 60, sinceBlock: 1, checkedAt: NOW, checkedBlock: 2, lastRevert: null };
  const lost = (fields = {}) => order({ blockedBy: ['custody_lost'], waiting: blocked, ...fields });
  const position = (number, fields = {}) => ({ chainId: 4663, dex: 4, tokenId: '7', state: number === null ? { status: 'unavailable' } : { status: 'live', snapshot: { number } }, ...fields });
  const body = (positions, mandates = [lost()]) => ({ vaults: [{ chainId: 4663, address: '0xv', dex: 4 }], positions, mandates });
  const at = (chainId, vault, tokenId) => store.approvedAt(store.automationState(), chainId, vault, tokenId);
  const listed = body([position(100)]);
  assert.equal(card.withApprovals(listed, at), listed, 'nothing approved here: the same answer');
  store.rememberApproval(4663, '0xV', 7n, 120n);
  assert.equal(store.approvedAt(store.automationState(), 4663, '0xv', '7'), 120n, 'by chain, vault (any case) and position');
  const shown = card.withApprovals(listed, at);
  assert.deepEqual([shown.mandates[0].blockedBy, shown.mandates[0].waiting], [[], null], 'read before the approval: not paused for it, nor said to wait for it');
  assert.equal(card.exitCardState(listed.mandates, []).kind, 'paused');
  assert.equal(card.exitCardState(shown.mandates, []).kind, 'on');
  assert.deepEqual(card.withApprovals(body([position(120)]), at).mandates[0].blockedBy, ['custody_lost'], 'read at the approval\'s block: read-v6\'s word');
  assert.deepEqual(card.withApprovals(body([position(121)]), at).mandates[0].blockedBy, ['custody_lost'], 'read after it');
  assert.deepEqual(card.withApprovals(body([]), at).mandates[0].blockedBy, [], 'the position not listed: the approval stands');
  assert.deepEqual(card.withApprovals(body([position(null)]), at).mandates[0].blockedBy, [], 'its read unavailable: the approval stands');
  assert.deepEqual(card.withApprovals(body([position(130, { dex: 3 })]), at).mandates[0].blockedBy, [], 'a v3 NFT with the same number says nothing of it');
  // Its other reasons stay, and a waiting record about something else.
  const two = card.withApprovals(body([position(100)], [lost({ blockedBy: ['module_disabled', 'custody_lost'], waiting: { ...blocked, reason: 'trigger_not_reached', error: null } })]), at);
  assert.deepEqual([two.mandates[0].blockedBy, two.mandates[0].waiting?.reason], [['module_disabled'], 'trigger_not_reached']);
  // Another vault's order, another chain's, one not active or not blocked by it: untouched.
  for (const other of [lost({ vault: '0xw' }), lost({ chainId: 8453 }), lost({ status: 'revoked' }), order({ blockedBy: ['module_disabled'] })]) {
    const answer = body([position(100)], [other]);
    assert.equal(card.withApprovals(answer, at), answer, JSON.stringify([other.vault, other.chainId, other.status, other.blockedBy]));
  }
  // The latest approval is kept.
  store.rememberApproval(4663, '0xv', 7n, 110n);
  assert.equal(store.approvedAt(store.automationState(), 4663, '0xv', 7n), 120n);
  store.forgetAutomationSession();
  assert.equal(store.approvedAt(store.automationState(), 4663, '0xv', 7n), null);
});

// Added 2026-10-06 (the final check, F2): Leave automation (exitAll) turns the vault's module off and "Turn back on"
// (setExitModule) turns it on, while read-v6's index runs behind the chain. The receipt's ExitModuleSet is recorded and
// applied while the listing of that vault is older than it: the card says the new standing at once, as after a Turn off
// made here, and never offers a step that would stop at "This step is already done.".
test('a module change made on this page: recorded from its receipt, applied to the listed orders while the index has not reached it', () => {
  const store = require(`${BUILD}/v2in/automate/store.js`);
  const ZERO_MODULE = `0x${'0'.repeat(40)}`;
  const setOf = (chainId, vault, listed) => store.exitModuleSet(store.automationState(), chainId, vault, listed);
  const body = (nonce, mandates) => ({ vaults: [{ chainId: 4663, address: '0xV', state: { status: 'read', stateNonce: nonce } }], mandates });
  store.forgetAutomationSession();
  const listed = body('4', [order()]);
  assert.equal(card.withExitModules(listed, setOf), listed, 'nothing done here: the index\'s answer as it is');
  // Leave automation's receipt (exitAll: its events share the one stateNonce it moved the vault to).
  store.recordVaultEvents(4663, '0xv', [
    { address: '0xV', eventName: 'ExitModuleSet', args: { module: ZERO_MODULE, stateNonce: 5n } },
    { address: '0xV', eventName: 'RootDisarmed', args: { reason: 7, stateNonce: 5n } },
    { address: '0xw', eventName: 'ExitModuleSet', args: { module: '0xm', stateNonce: 9n } },
  ]);
  assert.deepEqual(store.exitModuleSet(store.automationState(), 4663, '0xv', 4n), { stateNonce: 5n, module: null });
  assert.deepEqual(store.exitModuleSet(store.automationState(), 4663, '0xv', null), { stateNonce: 5n, module: null }, 'the listing\'s state unread');
  assert.equal(store.exitModuleSet(store.automationState(), 4663, '0xv', 5n), null, 'the index reached it: the listing says it');
  assert.equal(store.exitModuleSet(store.automationState(), 8453, '0xv', 4n), null, 'another chain');
  assert.equal(store.exitModuleSet(store.automationState(), 4663, '0xw', 4n), null, 'another vault\'s log in the receipt is not this vault\'s');
  assert.deepEqual(store.currentEvent(store.automationState(), 4663, '0xv', 5n), { stateNonce: 5n, kind: 'disarmed', reason: 7 }, 'the custody event is still kept apart');
  const left = card.withExitModules(listed, setOf);
  assert.deepEqual([left.mandates[0].blockedBy, left.mandates[0].moduleEnabled], [['module_disabled'], false]);
  const paused = card.exitCardState(left.mandates, []);
  assert.deepEqual([paused.kind, paused.reasons, paused.moduleOff], ['paused', ['mandate_module_off'], true], 'paused, with "Turn back on" beside it');
  assert.deepEqual(card.withExitModules(body('4', [order({ blockedBy: ['expired'] })]), setOf).mandates[0].blockedBy, ['expired', 'module_disabled'], 'in the backend\'s order');
  for (const untouched of [order({ status: 'revoked' }), order({ moduleEnabled: null, vaultIsDomino: false, blockedBy: ['vault_not_domino'] })]) {
    const same = body('4', [untouched]);
    assert.equal(card.withExitModules(same, setOf), same, `${untouched.status}, ${untouched.moduleEnabled}: nothing to apply`);
  }
  const caughtUp = body('5', [order()]);
  assert.equal(card.withExitModules(caughtUp, setOf), caughtUp, 'the index reached it: its own answer');
  // A module-off record stays while the module is off: the card is paused, and says why itself.
  const offRecord = { since: NOW - 840, reason: 'exit_module_not_enabled', error: null };
  assert.equal(card.withExitModules(body('4', [order({ waiting: offRecord })]), setOf).mandates[0].waiting, offRecord);
  // "Turn back on": its receipt replaces the record; the index still lists the pause, and the automation's last record of
  // it. Changed on purpose 2026-10-06 (the final check F2's review): as the automation writes that record, its own check
  // before any try (`exit_module_not_enabled`, no contract error: backend/v2_autoexit.py eligible), or a try the contract
  // refused (`reverted_exit_module_not_enabled`, ExitModuleNotEnabled); either is gone once the module is on again.
  store.recordVaultEvents(4663, '0xv', [{ address: '0xv', eventName: 'ExitModuleSet', args: { module: '0xM', stateNonce: 6n } }]);
  for (const record of [offRecord, { since: NOW - 120, reason: 'reverted_exit_module_not_enabled', error: 'ExitModuleNotEnabled' }]) {
    const stale = body('5', [order({ blockedBy: ['module_disabled'], moduleEnabled: false, waiting: record })]);
    const back = card.withExitModules(stale, setOf);
    assert.deepEqual([back.mandates[0].blockedBy, back.mandates[0].moduleEnabled, back.mandates[0].waiting], [[], true, null], record.reason);
    assert.equal(card.exitCardState(back.mandates, []).kind, 'on', 'on at once: no "Turn back on" left to stop at "already done"');
  }
  const waits = { since: NOW - 120, reason: 'trigger_not_reached', error: null };
  assert.equal(card.withExitModules(body('5', [order({ blockedBy: ['module_disabled'], moduleEnabled: false, waiting: waits })]), setOf).mandates[0].waiting, waits, 'any other record stays');
  const lost = card.withExitModules(body('5', [order({ blockedBy: ['module_disabled', 'custody_lost'], moduleEnabled: false })]), setOf);
  const still = card.exitCardState(lost.mandates, []);
  assert.deepEqual([still.kind, still.reasons, still.moduleOff], ['paused', ['mandate_root_custody_lost'], false], 'the other reason stays, said by itself');
  assert.equal(card.withExitModules(body('5', [order({ module: '0xn' })]), setOf).mandates[0].blockedBy[0], 'module_disabled', 'another module on: not this order\'s (the backend\'s rule)');
  store.forgetAutomationSession();
  assert.equal(store.exitModuleSet(store.automationState(), 4663, '0xv', null), null, 'a fresh start forgets it');
});

// Added 2026-10-06 (the final check F2's review): Leave automation made on an earlier visit and indexed, then "Turn back
// on" and "Turn off" made here while the index still lists the pause and the order active. The automation's own word on
// its Auto-exit (its vault's `exit`, which decides its rearm: the card's "Turn on") must say off as the card does, or
// nothing turns Auto-exit on again until a reload; and the automation's record of the module off goes with "Turn back on".
test('an Auto-exit turned off here is listed as turned off until the index says it, for its automation too: "Turn on" is offered again', async () => {
  const store = require(`${BUILD}/v2in/automate/store.js`);
  const vaultView = require(`${BUILD}/v2in/automate/vaultView.js`);
  const { read6Answer, READ6 } = await import('../support/v2-auto-page.mjs');
  // read-v6's own fixture after exitAll: the vault paused, its module off, its root disarmed (exit_all) with the approval
  // still the vault's; the order active, blocked by the module, with the record the automation writes for it.
  const { body: listed } = read6Answer('portfolio', 'portfolio-custody-lost', [], (body) => {
    const v = body.vaults[0];
    v.members = [{ ...v.members[0], status: 'disarmed', disarmReason: 'exit_all' }];
    v.custody = { armed: false, reason: 'exit_all', since: body.mandates[0].registered, source: 'event' };
    Object.assign(v, { autoExitEnabled: false, pausedBy: 'owner', waiting: null });
    Object.assign(v.state, { exitModule: null, paused: true, rootArmed: false, members: v.state.members.slice(0, 1), reserves: v.state.reserves.map((r) => ({ ...r, idle: '0', total: '0' })) });
    body.positions[0].state.custody.approved = v.address;
    body.mandates = [{ ...body.mandates[0], blockedBy: ['module_disabled'], moduleEnabled: false, waiting: { ...body.mandates[0].waiting, reason: 'exit_module_not_enabled', error: null, lastRevert: null } }];
  });
  const id = listed.mandates[0].mandateHash;
  const nonce = BigInt(listed.vaults[0].state.stateNonce);
  const shown = () => card.withExitModules(card.withRevoked(listed, 4663, store.sessionRevoked(store.automationState(), 4663)), (chainId, vault, at) => store.exitModuleSet(store.automationState(), chainId, vault, at));
  const automation = (body) => vaultView.vaultViewFromListing(body.vaults[0], body, READ6.wallet, NOW);
  const ADVANCED = ['recover-token', 'recover-position'];
  store.forgetAutomationSession();
  assert.equal(shown(), listed, 'nothing done here: the index\'s answer as it is');
  assert.equal(card.exitCardState(listed.mandates, []).kind, 'paused');
  assert.equal(automation(listed).exit, 'paused');
  // "Turn back on" (setExitModule(autoExit)): on at once, with nothing left of the module off.
  store.recordVaultEvents(4663, READ6.vault, [{ address: READ6.vault, eventName: 'ExitModuleSet', args: { module: READ6.module, stateNonce: nonce + 1n } }]);
  const back = shown();
  assert.equal(card.exitCardState(back.mandates, []).kind, 'on');
  assert.equal(back.mandates[0].waiting, null, 'no "Waiting" line left from the module off');
  assert.equal(automation(back).exit, 'on');
  assert.deepEqual(vaultView.vaultActions(automation(back)), ADVANCED, 'on: nothing to rearm for, nothing that cuts the position from it');
  // "Turn off" (revokeMandate): the index still lists the order active, and the module as this page set it.
  store.rememberRevoked(4663, id);
  const off = shown();
  assert.deepEqual(card.exitCardState(off.mandates, [], store.sessionRevoked(store.automationState(), 4663)), { kind: 'off' });
  assert.deepEqual([off.mandates[0].status, off.mandates[0].expired, off.mandates[0].blockedBy, off.mandates[0].waiting], ['revoked', false, [], null]);
  assert.equal(automation(off).exit, 'off', 'the automation says what the card says');
  assert.deepEqual(vaultView.vaultActions(automation(off)), ['rearm', 'unsubscribe', 'revoke', ...ADVANCED], 'its rearm (the card\'s "Turn on", Auto-exit\'s dialog next), as once the index lists it');
  // Only an active order turned off here, on this chain: the same answer otherwise.
  assert.equal(card.withRevoked(listed, 8453, new Set([id])), listed, 'another chain');
  assert.equal(card.withRevoked(listed, 4663, new Set()), listed, 'none turned off here');
  const indexed = { ...listed, mandates: [{ ...listed.mandates[0], status: 'revoked', blockedBy: [], waiting: null }] };
  assert.equal(card.withRevoked(indexed, 4663, new Set([id])), indexed, 'the index lists it: its own answer');
  store.forgetAutomationSession();
});

// The plan: "do not offer compounding on an auto-exit position" (rugged97: "auto-exit has no fee compounding").
test('where a position stands with Auto-exit: on while one is active, its vault while only its protection-only vault stays, else none', () => {
  const vault = (fields = {}) => ({ chainId: 4663, address: '0xv', dex: 4, rootTokenId: '7', members: [], autoExitEnabled: true, pausedBy: 'owner', state: { status: 'read', paused: true }, ...fields });
  const body = (vaults, mandates = []) => ({ vaults, mandates });
  const standing = (b, chainId = 4663, tokenId = '7', off) => card.autoExitStanding(b, chainId, tokenId, 4, off);
  assert.equal(standing(body([], [order()])), 'on', 'an active Auto-exit');
  assert.equal(standing(body([vault()], [order()])), 'on', 'an active one in its protection-only vault');
  assert.equal(standing(body([vault()])), 'vault', 'turned off, its protection-only vault stays: turned back on there');
  assert.equal(standing(body([vault()], [order({ status: 'revoked' })])), 'vault');
  assert.equal(standing(body([vault()], [order()]), 4663, '7', new Set([`0x${'ab'.repeat(32)}`])), 'vault', 'turned off in this tab while the index still lists it');
  assert.equal(standing(body([vault({ state: { status: 'read', paused: false } })])), null, 'a running automation is no Auto-exit');
  assert.equal(standing(body([vault({ state: { status: 'unread' }, pausedBy: null })])), null, 'unread and not paused');
  assert.equal(standing(body([vault({ state: { status: 'unread' } })])), 'vault', 'unread, paused by its owner');
  assert.equal(standing(body([vault({ autoExitEnabled: false })])), null, 'paused with auto-exit off: a paused automation');
  assert.equal(standing(body([vault()], [order()]), 8453), null, 'another chain');
  assert.equal(standing(body([vault()], [order()]), 4663, '8'), null, 'another position');
  assert.equal(standing(body([], [order({ expired: true })])), null, 'an expired one');
  assert.equal(standing(body([], [order({ status: 'revoked' })])), null, 'one turned off, no vault');
  // Changed on purpose 2026-10-06 (the integration review, rugged-literal #2): Leave automation (exitAll) pauses the vault and
  // turns its module off; with Auto-exit listed on its root it stays Auto-exit's, so Set up automation offers it no
  // compounding.
  const left = vault({ autoExitEnabled: false, pausedBy: 'unknown' });
  assert.equal(standing(body([left], [order({ blockedBy: ['module_disabled'] })])), 'on', 'paused by Leave automation: still active');
  assert.equal(standing(body([left], [order({ status: 'revoked' })])), 'vault', 'then turned off: still Auto-exit\'s automation');
  assert.equal(standing(body([left])), null, 'nothing of Auto-exit ever listed on it: a paused automation');
  assert.equal(standing(body([left], [order({ tokenId: '8', status: 'revoked' })])), null, 'another position\'s order says nothing of this one');
  // The rule is ./standing.ts exitVaultOf's, written in card.ts (one chunk less): the two always agree.
  const { exitVaultOf } = require(`${BUILD}/v2in/autoexit/standing.js`);
  const shapes = [vault(), left, vault({ state: { status: 'read', paused: false } }), vault({ state: { status: 'unread' }, pausedBy: null }), vault({ state: { status: 'unread' }, autoExitEnabled: false }), vault({ autoExitEnabled: false })];
  const lists = [[], [order({ status: 'revoked' })], [order({ status: 'executed' })], [order({ vault: '0xw', status: 'revoked' })], [order({ chainId: 8453, status: 'revoked' })]];
  for (const shape of shapes) {
    for (const mandates of lists) assert.equal(standing(body([shape], mandates)) === 'vault', exitVaultOf(shape, mandates), JSON.stringify([shape, mandates.map((m) => [m.vault, m.chainId, m.status])]));
  }
});

// The owner's point 5: never "order" on screen. The module's own refusals (spec §4.9) in Auto-exit's words, by name.
test('the auto-exit module\'s refusals are said in Auto-exit\'s words; a vault\'s are untouched', () => {
  const { describeError, errorLabels } = require(`${BUILD}/v2in/automate/copy.js`);
  const labels = errorLabels(4663, () => 'ETH');
  const said = (selector, context = 'autoExit') => describeError({ code: 3, message: 'execution reverted', data: selector }, context, labels);
  assert.deepEqual([said('0x6f6ffce9').text, said('0x6f6ffce9').code], ['This Auto-exit is already on.', 'MandateAlreadyRegistered']);
  assert.equal(said('0x1fb09b80').text, 'This signature was already used or cancelled. Sign a new one.');
  assert.equal(said('0x952501f6').text, 'This Auto-exit is no longer on.');
  // InvalidMandate's {reason} is the page's own (a refusal without one says the generic line, as the table does).
  const invalid = describeError({ code: 3, message: 'execution reverted', data: '0x544cad7e' }, 'autoExit', { ...labels, reason: 'its lower price must be below its upper price' });
  assert.equal(invalid.text, "This Auto-exit isn't valid: its lower price must be below its upper price.");
  for (const selector of ['0x6f6ffce9', '0x1fb09b80', '0x952501f6', '0x544cad7e']) assert.doesNotMatch(said(selector).text, /order/i);
  // The same decode outside Auto-exit's dialogs keeps the table's words.
  const { decodeRevertData } = require(`${BUILD}/v2/errors.js`);
  assert.equal(said('0x82b42900', 'vault').text, decodeRevertData('0x82b42900', 'vault', labels).copy, 'a vault’s refusal keeps the table’s words');
  assert.doesNotMatch(said('0x82b42900').text, /order/i);
});

// Added 2026-10-06 (the review of point 5): Auto-exit's own vault is said by its root's orders, never by its pause alone.
test('where the Auto-exit of its own vault stands: on, paused, off after a Turn off or an expiry, closed after an exit; null for any other vault', () => {
  const standing = require(`${BUILD}/v2in/autoexit/standing.js`);
  const vault = (fields = {}) => ({
    chainId: 4663, address: '0xv', dex: 4, rootTokenId: '7', autoExitEnabled: true, pausedBy: 'owner', state: { status: 'read', paused: true },
    custody: { armed: true, reason: null }, members: [{ role: 'root', tokenId: '7', status: 'armed', disarmReason: null }], ...fields,
  });
  const of = (v, orders) => standing.protectionStanding(v, orders);
  assert.equal(of(vault(), [order()]), 'on');
  assert.equal(of(vault(), []), 'off', 'none at all');
  assert.equal(of(vault(), [order({ status: 'revoked' })]), 'off', 'turned off: the vault stays paused with its module on');
  assert.equal(of(vault(), [order({ expired: true })]), 'off', 'expired');
  assert.equal(of(vault(), [order({ blockedBy: ['custody_lost'] })]), 'paused', 'its approval moved');
  // Changed on purpose 2026-10-06 (the integration review, rugged-literal #1): the vault's live `rootArmed` (read-v6's
  // custody.armed) is no reason; any change to the root turns it false (Collect fees, Add liquidity, Leave automation)
  // while the exit, which needs the approval only, can still fire: only the order's own blockedBy (§4.5) pauses it.
  for (const reason of ['changed_outside_domino', 'v3_checkpoint_mismatch', 'exit_all', 'custody_lost']) {
    assert.equal(of(vault({ custody: { armed: false, reason } }), [order()]), 'on', `root disarmed (${reason}), its order unblocked: on`);
  }
  assert.equal(of(vault(), [order({ blockedBy: ['custody_unread'] })]), 'on', 'an unread custody is no reason, as on the card');
  for (const code of ['module_disabled', 'automation_halted', 'custody_lost', 'not_in_vault', 'vault_not_domino']) {
    assert.equal(of(vault(), [order({ blockedBy: [code] })]), 'paused', code);
  }
  // The card says the same codes (../automate/portfolio.ts BLOCKED_TEXT_KEY): the two screens never disagree.
  const { BLOCKED_TEXT_KEY } = require(`${BUILD}/v2in/automate/portfolio.js`);
  assert.deepEqual([...standing.EXIT_BLOCKERS].sort(), Object.keys(BLOCKED_TEXT_KEY).sort());
  assert.equal(of(vault({ custody: { armed: false, reason: 'auto_exit' } }), [order({ status: 'executed' })]), 'closed');
  assert.equal(of(vault({ members: [{ role: 'root', tokenId: '7', status: 'exited', disarmReason: 'auto_exit' }] }), []), 'closed');
  assert.equal(of(vault(), [order({ tokenId: '8' })]), 'off', 'another position\'s order');
  assert.equal(of(vault(), [order({ vault: '0xw' })]), 'off', 'another vault\'s order');
  assert.equal(of(vault({ state: { status: 'read', paused: false } }), [order()]), null, 'running: compounding, not Auto-exit\'s');
  assert.equal(of(vault({ autoExitEnabled: false }), []), null, 'paused with auto-exit off and nothing of Auto-exit listed: a paused automation');
  assert.equal(standing.exitStandingOf(vault({ state: { status: 'read', paused: false } }), [order()]), 'on', 'whatever the listing says of its pause');
  // Changed on purpose 2026-10-06 (the integration review, rugged-literal #2): after Leave automation (exitAll: paused, the
  // module off, the root disarmed with reason 7) the vault stays Auto-exit's while Auto-exit is listed on its root.
  const left = vault({ autoExitEnabled: false, pausedBy: 'unknown', custody: { armed: false, reason: 'exit_all' } });
  assert.equal(of(left, [order({ blockedBy: ['module_disabled'] })]), 'paused', 'its order waits for its module');
  assert.equal(of(left, [order({ status: 'revoked' })]), 'off', 'then turned off');
  assert.equal(of(left, [order({ vault: '0xw' })]), null, 'another vault\'s order says nothing of this one');
  // The chain's own read right after an action on this page stands for the listing's pause and module.
  assert.equal(standing.exitVaultOf(vault(), [], { paused: true, autoExitEnabled: false }), false, 'module off, nothing listed');
  assert.equal(standing.exitVaultOf(vault(), [order({ status: 'revoked' })], { paused: true, autoExitEnabled: false }), true);
  assert.equal(standing.exitVaultOf(vault(), [order()], { paused: false, autoExitEnabled: true }), false, 'running again: compounding');
});

// Added 2026-10-06 (the integration review, rugged-literal #1): Auto-exit's own automation by where its Auto-exit stands.
test('Auto-exit\'s own automation never offers to cut its position from it while its Auto-exit is on or paused; its rearm only where it can be the fix', () => {
  const vaultView = require(`${BUILD}/v2in/automate/vaultView.js`);
  const ADVANCED = ['recover-token', 'recover-position'];
  const reason = (n) => ({ reason: n, text: '', since: null });
  const view = (fields = {}) => ({
    source: 'listing', chainId: 4663, vault: '0xv', dex: 4, owner: '0xo', ownedByWallet: true, rootTokenId: 7n, pool: null, mode: 1, policy: null, limits: null,
    status: 'off', pausedBy: null, armed: false, disarm: reason(2), rootClosed: false, successors: [], members: [], quoteCurrency: null,
    reserves: { known: true, list: [], held: false }, waiting: null, autoExitEnabled: true, paused: true, exit: 'on',
    links: { subscribed: true, approved: true, ownerHolds: true }, ...fields,
  });
  // On, its root disarmed by a Collect fees (reason 2): nothing about custody (the exit needs the approval only).
  assert.deepEqual(vaultView.vaultActions(view()), ADVANCED, 'never Revoke approval, which would stop the exit');
  // Paused: its approval lost, or its module off after Leave automation (reason 7): the rearm, never Remove or Revoke.
  assert.deepEqual(vaultView.vaultActions(view({ exit: 'paused', disarm: reason(4), links: { subscribed: true, approved: false, ownerHolds: true } })), ['rearm', ...ADVANCED]);
  assert.deepEqual(vaultView.vaultActions(view({ exit: 'paused', disarm: reason(7) })), ['rearm', ...ADVANCED]);
  // Off: the rearm as the first part of turning it on again (after Leave automation too), and what still links it.
  assert.deepEqual(vaultView.vaultActions(view({ exit: 'off', disarm: reason(7) })), ['rearm', 'unsubscribe', 'revoke', ...ADVANCED]);
  // Closed by it: no rearm (reason 6); the links it left may go.
  assert.deepEqual(vaultView.vaultActions(view({ exit: 'closed', rootClosed: true, disarm: reason(6) })), ['unsubscribe', 'revoke', ...ADVANCED]);
  // Armed: never Pause or Resume (it stays paused: resuming would reinvest), Leave automation kept.
  assert.deepEqual(vaultView.vaultActions(view({ armed: true, disarm: null, status: 'protection' })), ['leave', ...ADVANCED]);
  assert.deepEqual(vaultView.vaultActions(view({ armed: true, disarm: null, status: 'paused', autoExitEnabled: false, exit: 'paused' })), ['leave', ...ADVANCED]);
  // Any other vault keeps its own: Leave automation's reason 7 has no rearm there.
  assert.deepEqual(vaultView.vaultActions(view({ exit: null, disarm: reason(7) })), ['unsubscribe', 'revoke', ...ADVANCED]);
  // Auto-exit's own is the view's word, its module on or off.
  assert.equal(vaultView.protectionVault(view({ autoExitEnabled: false })), true);
  assert.equal(vaultView.protectionVault(view({ exit: null })), false);
});

// Added 2026-10-06 (the integration review, money #4): the module has no latch, so an end the price passed while Auto-exit
// was paused closes the position on the next pass; both ways back on read the pool's price first.
test('turning a paused Auto-exit back on reads the pool\'s price first: an end it reached, by the module\'s own rule', async () => {
  const { edgePassed, EDGE_PASSED, PAST_EDGE_TEXT } = require(`${BUILD}/v2in/autoexit/turnBackOn.js`);
  const lower = sqrtPriceAtTick(RANGE.tickLower);
  const upper = sqrtPriceAtTick(RANGE.tickUpper);
  const reader = (price, status = null) => {
    const asked = [];
    return {
      asked,
      autoExit: {
        readPoolPrice: async (dex, tokenId) => { asked.push(['price', dex, tokenId]); return { sqrtPriceX96: price }; },
        status: async (id) => { asked.push(['status', id]); return status; },
      },
    };
  };
  const order = { id: `0x${'ab'.repeat(32)}`, triggers: { below: lower, above: upper } };
  assert.equal(await edgePassed(reader(at('2500')), order, 4, 7n), false, 'inside the range');
  assert.equal(await edgePassed(reader(lower + 1n), order, 4, 7n), false, 'one unit above the lower end');
  assert.equal(await edgePassed(reader(lower), order, 4, 7n), true, 'on the lower end: reached');
  assert.equal(await edgePassed(reader(at('1500')), order, 4, 7n), true, 'under the range');
  const r = reader(at('4000'));
  assert.equal(await edgePassed(r, order, 3, 9n), true, 'over the range');
  assert.deepEqual(r.asked, [['price', 3, 9n]], 'the pool of this very position, by its DEX');
  assert.equal(await edgePassed(reader(at('1500')), { ...order, triggers: { below: 0n, above: upper } }, 4, 7n), false, 'a far end alone (a range beside the price): the near side reaches nothing');
  // Ends unread: the order's own record on chain says them; one no longer active passes nothing, and no price is read.
  const unread = { id: order.id, triggers: null };
  const record = { triggerBelowSqrtPriceX96: lower, triggerAboveSqrtPriceX96: upper };
  const known = reader(at('1500'), { status: 'active', record });
  assert.equal(await edgePassed(known, unread, 4, 7n), true);
  assert.deepEqual(known.asked.map(([what]) => what), ['status', 'price']);
  const gone = reader(at('1500'), { status: 'revoked', record });
  assert.equal(await edgePassed(gone, unread, 4, 7n), false);
  assert.deepEqual(gone.asked.map(([what]) => what), ['status']);
  assert.equal(EDGE_PASSED, 'exit_edge_passed');
  assert.match(PAST_EDGE_TEXT, /^The price is already past the end of your range\. Turning Auto-exit back on closes this position at today's price, with the 0\.2% fee\.$/);
});

test('the waiting lines an Auto-exit can show speak Auto-exit\'s words; the rest are the spec\'s', () => {
  const { waitingWords } = require(`${BUILD}/v2in/automate/portfolio.js`);
  const { AUTO_EXIT_WAITING_TEXT } = require(`${BUILD}/v2in/automate/copy.js`);
  const waiting = (fields) => ({ since: NOW - 120, reason: 'blocked', error: null, ...fields });
  // Changed on purpose 2026-10-06 (the final check, F8): the pause by its cause, never "turned off" beside "Turn off".
  assert.equal(waitingWords(waiting({ error: 'ExitModuleNotEnabled' }), 4663, NOW, null, AUTO_EXIT_WAITING_TEXT).text, "Paused: your automation doesn't allow Auto-exit right now · since 2 min ago");
  assert.equal(waitingWords(waiting({ reason: 'trigger_not_reached' }), 4663, NOW, null, AUTO_EXIT_WAITING_TEXT).text, 'Waiting for the price to reach the end of your range · since 2 min ago');
  assert.equal(waitingWords(waiting({ error: 'TriggerNotReached' }), 4663, NOW, null, AUTO_EXIT_WAITING_TEXT).code, 'TriggerNotReached');
  assert.match(waitingWords(waiting({ error: 'ExitModuleNotEnabled' }), 4663, NOW).text, /^Paused: auto-exit is turned off for your automation/, 'elsewhere, the table\'s words');
  assert.match(waitingWords(waiting({ error: 'SpotOutsideBand' }), 4663, NOW, null, AUTO_EXIT_WAITING_TEXT).text, /^Waiting: the pool price is too far from the reference price · since/);
  for (const text of Object.values(AUTO_EXIT_WAITING_TEXT)) assert.doesNotMatch(text, /order|trigger|turned off/i);
});
