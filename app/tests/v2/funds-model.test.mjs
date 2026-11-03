/**
 * The inline "Bring {token} from {network}" offer's pure model (src/v2in/funds/model.ts, spec F7 §3.3, §3.4, §3.9): when
 * the amount step offers it (decided [owner, 2026-10-02 evening]: only when the position can't be funded on its chain at
 * all, counting the one-token swap: Review's plan is `short` once an amount is typed, the wallet holds none of either
 * token before; only a token a deposit can deliver there; never on an unread balance), the amount the same position
 * continues with after the fill, where the answers come from (HTTP only, once wired; never test data: the owner,
 * 2026-10-02 night), and the copied form helpers.
 * Changed on purpose 2026-10-06 (the owner's points 1, 2, 4 and 7): nothing before an amount (the discreet line takes its
 * place); the other token's figure from depositPlan's own threshold, never everything held; shortfalls against the
 * balance read; the target rule, the sizing from the quote, the pace of typed quotes, the live line and Other networks.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { runtime } from './support/crosschain.mjs';

const require = createRequire(import.meta.url);
const model = require('../../.test-build/app/src/v2in/funds/model.js');
const { REVIEW_GAS_RESERVE_WEI } = require('../../.test-build/app/src/lib/create/reviewPlan.js');
const plan = require('../../.test-build/app/src/lib/create/depositPlan.js');
const pair = require('../../.test-build/app/src/lib/create/pairAmount.js');
const { sqrtPriceAtTick } = require('../../.test-build/app/src/finance/position.js');

const ETH = '0x0000000000000000000000000000000000000000';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const WETH_RH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TSLA = '0x1234567890abcdef1234567890abcdef12345678';
const token = (address, symbol, decimals) => ({ address, symbol, decimals });
const ETH_USDG = [token(ETH, 'ETH', 18), token(USDG, 'USDG', 6)];

const lacks = (input) => model.lackingTokens({ chainId: 4663, currencies: ETH_USDG, balances: null, plan: null, only: null, independent: null, ...input });
const ONE_ETH = 1_000_000_000_000_000_000n;
const spendableOf = (wei) => (wei > REVIEW_GAS_RESERVE_WEI ? wei - REVIEW_GAS_RESERVE_WEI : 0n);
/** Review's plan shapes (lib/create/depositPlan.ts DepositPlan). */
const SHORT_USDG = { kind: 'short', token: 1, have: 100_000_000n, need: 300_000_000n };
const BOTH = { kind: 'both', amount0: 1n, amount1: 1n };
const SWAP_FROM_ETH = { kind: 'swap', from: 0, deposit: 2n, swap: 1n, receive: 1n };
const SWAP_FROM_USDG = { kind: 'swap', from: 1, deposit: 2n, swap: 1n, receive: 1n };

test('V2 funding uses selected raw inputs: exact shortage first, no invented exchange amount for alternatives', () => {
  const balances = new Map([[ETH, ONE_ETH], [USDG, 100_000_000n], [WETH_RH, 0n]]);
  const inputs = [{ token: USDG, amount: 300_000_000n }];
  const out = model.lackingZapTokens({ chainId: 4663, inputs, balances });
  assert.equal(out[0].token, USDG);
  assert.equal(out[0].shortRaw, 200_000_000n);
  assert.ok(out.length > 1);
  assert.ok(out.slice(1).every((token) => token.shortRaw === null));
  assert.deepEqual(model.lackingZapTokens({ chainId: 4663, inputs: [{ token: USDG, amount: 50_000_000n }], balances }), []);
  assert.deepEqual(model.lackingZapTokens({ chainId: 4663, inputs: null, balances }), []);
});

test('V2 funding never treats an unread input or an unread destination token as zero', () => {
  const inputs = [{ token: USDG, amount: 300_000_000n }];
  assert.deepEqual(model.lackingZapTokens({ chainId: 4663, inputs, balances: new Map([[ETH, ONE_ETH]]) }), []);
  assert.deepEqual(model.lackingZapTokens({ chainId: 4663, inputs, balances: null }), []);
  const onlyRead = model.lackingZapTokens({ chainId: 4663, inputs, balances: new Map([[USDG, 0n]]) });
  assert.equal(onlyRead.length, 1);
  assert.equal(onlyRead[0].token, USDG);
});

test('V2 non-bridgeable input may choose a bridgeable alternative without claiming an equivalent amount', () => {
  const out = model.lackingZapTokens({ chainId: 4663, inputs: [{ token: TSLA, amount: 4n }], balances: new Map([[TSLA, 0n], [USDG, 0n]]) });
  assert.deepEqual(out.map((token) => [token.token, token.shortRaw]), [[USDG, null]]);
});

test('an amount typed: offered only when Review\'s plan is short; the short token first with its shortfall, the other after it with no figure unless one is given', () => {
  const found = lacks({ balances: [ONE_ETH.toString(), '100000000'], plan: SHORT_USDG, independent: 1 });
  assert.deepEqual(found.map((l) => [l.side, l.token, l.symbol, l.decimals, l.haveRaw, l.shortRaw]), [
    [1, USDG, 'USDG', 6, 100_000_000n, 200_000_000n],
    [0, ETH, 'ETH', 18, spendableOf(ONE_ETH), null],
  ]);
});

test('fundable as it is, or through the one-token swap from either token: nothing is offered', () => {
  for (const plan of [BOTH, SWAP_FROM_ETH, SWAP_FROM_USDG]) {
    assert.deepEqual(lacks({ balances: [ONE_ETH.toString(), '0'], plan, independent: 1 }), [], plan.kind);
  }
});

// Changed on purpose 2026-10-06 (the owner's point 1): before an amount the discreet line under the amounts names a holding
// on another network (model.ts bestHolding); the box itself shows only once an amount is typed and Review's plan is short.
test('before an amount: nothing is offered, whatever the wallet holds (the discreet line takes its place)', () => {
  for (const balances of [['0', '0'], [ONE_ETH.toString(), '0'], ['0', '5'], [(REVIEW_GAS_RESERVE_WEI - 1n).toString(), '0']]) {
    assert.deepEqual(lacks({ balances, independent: 1 }), [], JSON.stringify(balances));
  }
});

test('an unread balance offers nothing, even with a short plan: zero is never assumed', () => {
  for (const balances of [null, [ONE_ETH.toString(), null], [null, '0'], [ONE_ETH.toString(), 'not a number']]) {
    assert.deepEqual(lacks({ balances }), []);
    assert.deepEqual(lacks({ balances, plan: SHORT_USDG }), []);
  }
});

test('only a token a deposit can deliver to the chain: its stable, ETH or WETH; a short token it can\'t leaves the other', () => {
  const TSLA_USDG = [token(TSLA, 'TSLA', 18), token(USDG, 'USDG', 6)];
  const SHORT_TSLA = { kind: 'short', token: 0, have: 0n, need: 10n };
  // Short of TSLA, which no deposit delivers: USDG is offered, since the swap can then buy the TSLA; no figure without one given.
  assert.deepEqual(model.lackingTokens({ chainId: 4663, currencies: TSLA_USDG, balances: ['0', '5'], plan: SHORT_TSLA, independent: 0 }).map((l) => [l.token, l.shortRaw]), [[USDG, null]]);
  // With what USDG alone must be (depositPlan's `whole`), the shortfall against the balance read: 120 − 5.
  assert.deepEqual(model.lackingTokens({ chainId: 4663, currencies: TSLA_USDG, balances: ['0', '5'], plan: SHORT_TSLA, independent: 0, wholeOther: 120n }).map((l) => [l.token, l.shortRaw]), [[USDG, 115n]]);
  assert.deepEqual(model.lackingTokens({ chainId: 4663, currencies: [token(WETH_RH, 'WETH', 18), token(TSLA, 'TSLA', 18)], balances: ['0', '0'], plan: { kind: 'short', token: 1, have: 0n, need: 1n }, independent: 1 }).map((l) => l.token), [WETH_RH]);
  assert.deepEqual(model.lackingTokens({ chainId: 4663, currencies: [token(TSLA, 'TSLA', 18), token('0x2234567890abcdef1234567890abcdef12345678', 'X', 18)], balances: ['0', '0'], plan: SHORT_TSLA, independent: 0 }), []);
  // Base's USDC is a destination there, not on Robinhood Chain; an unknown chain offers nothing.
  const SHORT_USDC = { kind: 'short', token: 1, have: 0n, need: 1_000_000n };
  assert.deepEqual(model.lackingTokens({ chainId: 8453, currencies: [token(ETH, 'ETH', 18), token(USDC_BASE, 'USDC', 6)], balances: ['0', '0'], plan: SHORT_USDC, independent: 1 }).map((l) => [l.token, l.symbol]), [[USDC_BASE, 'USDC'], [ETH, 'ETH']]);
  assert.deepEqual(model.lackingTokens({ chainId: 1, currencies: ETH_USDG, balances: ['0', '0'], plan: SHORT_USDC, independent: 1 }), []);
});

test('order: the token the plan is short of first', () => {
  assert.deepEqual(lacks({ balances: ['0', '0'], plan: { kind: 'short', token: 0, have: 0n, need: 1n }, independent: 0 }).map((l) => [l.side, l.shortRaw]), [[0, 1n + REVIEW_GAS_RESERVE_WEI], [1, null]]);
  assert.deepEqual(lacks({ balances: ['0', '0'], plan: { kind: 'short', token: 1, have: 0n, need: 1n }, independent: 1 }).map((l) => l.side), [1, 0]);
});

// Added 2026-10-06 (the owner's point 2b; the study's correction): the shortfall is counted against the balance READ, the
// gas Review keeps added once for native ETH, so a wallet below the allowance is never short of the allowance twice.
test('the shortfall against the balance read: the need, plus Review\'s ETH allowance once, less what is there; never below zero', () => {
  assert.equal(model.stillNeeded(1_000n, 400n, false), 600n);
  assert.equal(model.stillNeeded(1_000n, 4_000n, false), 0n);
  const need = 10n ** 16n;
  assert.equal(model.stillNeeded(need, 0n, true), need + REVIEW_GAS_RESERVE_WEI);
  assert.equal(model.stillNeeded(need, REVIEW_GAS_RESERVE_WEI / 2n, true), need + REVIEW_GAS_RESERVE_WEI / 2n, 'below the allowance: what is there counts, once');
  assert.equal(model.stillNeeded(need, ONE_ETH, true), 0n);
  // The typed ETH: Review's spendable ETH is the balance less the allowance, so bringing the figure covers exactly.
  const typedEth = lacks({ balances: [(REVIEW_GAS_RESERVE_WEI / 2n).toString(), '0'], plan: { kind: 'short', token: 0, have: 0n, need }, independent: 0 })[0];
  assert.equal(spendableOf(REVIEW_GAS_RESERVE_WEI / 2n + typedEth.shortRaw), need);
  // The zap path's exact inputs, counted the same way.
  const zap = model.lackingZapTokens({ chainId: 4663, inputs: [{ token: ETH, amount: need }], balances: new Map([[ETH, 0n], [USDG, 0n]]) });
  assert.equal(zap.find((l) => l.token === ETH).shortRaw, need + REVIEW_GAS_RESERVE_WEI);
});

// The bug of 2026-10-06 (the owner's point 2b): VIRTUAL/WETH on Base, a US$16 position typed in VIRTUAL, the wallet
// holding neither. VIRTUAL cannot be delivered, so WETH is offered: with the figure the plan itself implies, not the
// whole ETH held on another network. Once that much WETH arrives, the same typed amount plans as a swap from WETH.
test('the other token\'s figure is exactly what the plan needs of it: bringing it makes the same typed amount fundable', () => {
  const VIRTUAL = '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b';
  const WETH_BASE = '0x4200000000000000000000000000000000000006';
  // VIRTUAL is currency0 (its address sorts first); 1 VIRTUAL = 0.0004 WETH (price 4e-4: tick ≈ −78240), a ±20% range.
  const tick = -78240;
  const sqrtPriceX96 = sqrtPriceAtTick(tick);
  const terms = { sqrtPriceX96, tickLower: tick - 1800, tickUpper: tick + 1800, feePips: 3000, assistedFeeBps: plan.ASSISTED_SWAP_FEE_BPS, slippageBps: 50 };
  const typed = 16n * 10n ** 18n; // 16 VIRTUAL, about 0.0064 WETH: a small position
  const other = pair.pairedAmount({ sqrtPriceX96: sqrtPriceX96.toString(), tickLower: terms.tickLower, tickUpper: terms.tickUpper, independent: 0, amountRaw: typed.toString() });
  const need0 = typed, need1 = BigInt(other.raw);
  const balances = [0n, 0n];
  const short = plan.depositPlan({ terms, independent: 0, typedRaw: typed, need0, need1, slippageBps: 50, balances });
  assert.equal(short.kind, 'short');
  const whole = plan.wholeFromOther(terms, 0, need0, need1, 50);
  assert.ok(whole > 0n && whole < 10n ** 17n, `about 0.013 WETH, never everything held: ${whole}`);
  const found = model.lackingTokens({ chainId: 8453, currencies: [token(VIRTUAL, 'VIRTUAL', 18), token(WETH_BASE, 'WETH', 18)], balances: ['0', '0'], plan: short, independent: 0, wholeOther: whole });
  assert.deepEqual(found.map((l) => [l.token, l.shortRaw]), [[WETH_BASE, whole]]);
  const after = plan.depositPlan({ terms, independent: 0, typedRaw: typed, need0, need1, slippageBps: 50, balances: [0n, found[0].shortRaw] });
  assert.equal(after.kind, 'swap', 'the same typed amount, funded from what arrived');
  assert.equal(after.from, 1);
  // With some WETH already there, only the rest.
  const some = model.lackingTokens({ chainId: 8453, currencies: [token(VIRTUAL, 'VIRTUAL', 18), token(WETH_BASE, 'WETH', 18)], balances: ['0', (whole / 4n).toString()], plan: short, independent: 0, wholeOther: whole });
  assert.equal(some[0].shortRaw, whole - whole / 4n);
  // wholeFromOther is depositPlan's own threshold: one wei less and the plan is short again.
  assert.equal(plan.depositPlan({ terms, independent: 0, typedRaw: typed, need0, need1, slippageBps: 50, balances: [0n, whole - 1n] }).kind, 'short');
  assert.equal(plan.wholeFromOther({ ...terms, feePips: 1_000_000 }, 0, need0, need1, 50), null, 'nothing can buy it: no figure');
});

// Added 2026-10-06: Review's terms are exported from one place, so the offer's figure and Review's plan never drift.
test('reviewTerms are the terms reviewPlan plans with', () => {
  const { reviewTerms, reviewPlan } = require('../../.test-build/app/src/lib/create/reviewPlan.js');
  const pool = { currencies: [{ address: ETH, decimals: 18 }, { address: USDG, decimals: 6 }], sqrtPriceX96: sqrtPriceAtTick(-199020).toString(), feePips: 500 };
  const state = { pool, token: null, range: { lower: -201000, upper: -197000 }, slippageBps: '75', budget: '' };
  assert.deepEqual(reviewTerms(state), { sqrtPriceX96: sqrtPriceAtTick(-199020), tickLower: -201000, tickUpper: -197000, feePips: 500, assistedFeeBps: plan.ASSISTED_SWAP_FEE_BPS, slippageBps: 75 });
  assert.equal(reviewTerms({ ...state, range: null }), null);
  assert.equal(reviewTerms({ ...state, slippageBps: '9999' }), null, 'an unusable slippage: no terms, as Review plans nothing');
  assert.equal(typeof reviewPlan, 'function');
});

test('continueWith: the balance read on the chain as the amount field takes it; ETH less the allowance; nothing else', () => {
  assert.deepEqual(model.continueWith('100000000', 6, false), { raw: '100000000', text: '100' });
  assert.deepEqual(model.continueWith('1234500000', 6, false), { raw: '1234500000', text: '1234.5' }, 'no grouping in a field');
  assert.deepEqual(model.continueWith((1_000_000_000_000_000_000n + REVIEW_GAS_RESERVE_WEI).toString(), 18, true), { raw: '1000000000000000000', text: '1' });
  assert.equal(model.continueWith(REVIEW_GAS_RESERVE_WEI.toString(), 18, true), null, 'only the allowance: nothing to use');
  assert.equal(model.continueWith('0', 6, false), null);
  assert.equal(model.continueWith(null, 6, false), null);
  assert.equal(model.continueWith('12', null, false), null, 'decimals never guessed');
  assert.equal(model.continueWith('1e6', 6, false), null);
});

test('the answers come over HTTP only, once wired; the preview gets none (no fixtures, no test data), and never a live chain either until then', () => {
  // The owner, 2026-10-02 night: real data only; where a function cannot run yet it says so (the offer runs locked).
  assert.equal(model.fundsSource('preview', false), null);
  assert.equal(model.fundsSource('preview', true), null, 'wired or not, the preview is never answered from test data');
  assert.equal(model.fundsSource('live', false), null, 'open point #17: a live chain never sees test data');
  assert.equal(model.fundsSource('live', true), 'http');
  assert.equal(model.fundsSource('off', true), null);
});

test('the form: exact amounts, slippage in the service bounds, destination gas, the request in lowercase', () => {
  assert.equal(model.amountRawOf('100', 6), '100000000');
  assert.equal(model.amountRawOf('0.05', 18), '50000000000000000');
  assert.equal(model.amountRawOf('1.0000001', 6), null, 'more places than the token has');
  assert.equal(model.amountRawOf('0', 6), null);
  // Changed on purpose 2026-10-30 (QA round 2, N99): thousands separators are read as New position's amount step reads
  // them (a funding amount Domino writes itself is grouped); a decimal comma or a minus is refused.
  // Changed on purpose 2026-11-02 (review M4): a one-group "1,000" is refused as ambiguous (1 for someone who writes a
  // decimal comma), and Domino writes its own amounts with no separator (tests/v2/typed-figure.test.mjs).
  assert.equal(model.amountRawOf('1,000', 6), null, 'one group, no dot: 1 or 1000, never guessed');
  assert.equal(model.amountRawOf('1,000,000', 6), '1000000000000');
  assert.equal(model.amountRawOf('1,000.50', 6), '1000500000');
  assert.equal(model.amountRawOf(' 0.5 ', 18), '500000000000000000', 'spaces around it are dropped');
  assert.equal(model.amountRawOf('0,5', 18), null, 'a decimal comma is refused, never read as 5');
  assert.equal(model.amountRawOf('-1', 6), null);
  assert.equal(model.amountRawOf('5', null), '5', 'unknown decimals: raw units only');
  assert.equal(model.amountRawOf('0.5', null), null);
  assert.equal(model.slippageBpsOf('0.5'), 50);
  assert.equal(model.slippageBpsOf('5%'), 500);
  assert.equal(model.slippageBpsOf('0.05'), null);
  assert.equal(model.slippageBpsOf('5.5'), null);
  assert.equal(model.slippageText(50), '0.5');
  assert.equal(model.slippageText(200), '2');
  assert.equal(model.offerDestinationGas(ETH, '0'), null, 'never for a native delivery');
  assert.equal(model.offerDestinationGas(USDG, '0'), 'suggested');
  assert.equal(model.offerDestinationGas(USDG, '1'), null);
  assert.equal(model.offerDestinationGas(USDG, null), 'undecided');
  // Changed on purpose (data) 2026-10-06 (crosschain-v1 1.1.0-rc.1): by exact input, with no cap; the runtime takes it.
  const request = model.quoteRequestOf({ originChainId: 42161, originToken: '0xAF88d065e77c8cC2239327C5EDb3A432268e5831', destinationChainId: 4663, destinationToken: '0x5FC5360D0400a0Fd4f2af552ADD042D716F1d168', amountRaw: '100000000', slippageBps: 50, destinationGas: false });
  assert.deepEqual(request, { originChainId: 42161, originToken: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', destinationChainId: 4663, destinationToken: USDG, amountKind: 'exact_input', amountRaw: '100000000', maxInputRaw: null, slippageBps: 50, destinationGas: false });
  assert.equal(runtime.validateRequest('quote', request), true);
});

test('a failed request: §3.8 words, its code apart, and whether it asks again by itself', () => {
  const off = model.requestFailure({ kind: 'error', code: 'route_not_available', status: 404 }, 1);
  assert.equal(off.featureOff, true);
  assert.equal(off.code, 'route_not_available');
  assert.ok(!off.copy.includes('route_not_available'), 'a code never appears in a sentence');
  assert.equal(model.requestFailure({ kind: 'error', code: 'preview_expired', status: 409 }, 1).requote, true);
  assert.equal(model.requestFailure({ kind: 'error', code: 'provider_rate_limited', status: 429, retryAfterS: 30 }, 1).retryMs, 30_000);
  assert.equal(model.requestFailure({ kind: 'network' }, 3).retryMs, 20_000, 'growing waits, no Retry button');
  assert.equal(model.requestFailure({ kind: 'contract', detail: 'owner' }, 2).retryMs, null);
});

// Added 2026-10-05 (the owner: "it has to happen behind the scenes"): the one click "Bring it from {network}" chooses the
// token and the amount itself (src/v2in/funds/BringFunds.tsx bringFrom over model.ts holdingFor, convertUnits; the amount,
// since 2026-10-06, the service's own by output: below).
test('the one click chooses what to send: the same kind of token first, native ETH before WETH, only what the listing bridges', () => {
  const WETH_BASE = '0x4200000000000000000000000000000000000006';
  const holding = (token, symbol, decimals, raw) => ({ chainId: 8453, chainName: 'Base', token, symbol, decimals, raw });
  const listing = (tokens) => ({ chains: [{ chainId: 8453, name: 'Base', tokens: tokens.map((address) => ({ address, symbol: null, decimals: null, providers: ['relay'] })) }] });
  const all = listing([ETH, WETH_BASE, USDC_BASE]);
  const held = [holding(USDC_BASE, 'USDC', 6, 50_000_000n), holding(WETH_BASE, 'WETH', 18, ONE_ETH), holding(ETH, 'ETH', 18, ONE_ETH)];
  // Ether lacking on Robinhood Chain: Base's ETH, then its WETH, then its dollar.
  assert.equal(model.holdingFor(held, ETH, 4663, 8453, all).token, ETH);
  assert.equal(model.holdingFor(held.filter((h) => h.token !== ETH), ETH, 4663, 8453, all).token, WETH_BASE);
  assert.equal(model.holdingFor([held[0]], ETH, 4663, 8453, all).token, USDC_BASE, 'another kind when that is all there is');
  // The dollar lacking: Base's USDC first, then ether.
  assert.equal(model.holdingFor(held, USDG, 4663, 8453, all).token, USDC_BASE);
  assert.equal(model.holdingFor(held.slice(1), USDG, 4663, 8453, all).token, ETH);
  // Only what the listing bridges, and only a balance above zero.
  assert.equal(model.holdingFor(held, ETH, 4663, 8453, listing([USDC_BASE])).token, USDC_BASE);
  assert.equal(model.holdingFor([holding(ETH, 'ETH', 18, 0n)], ETH, 4663, 8453, all), null);
  assert.equal(model.holdingFor(held, ETH, 4663, 8453, listing([])), null);
});

test('a need in the token sent: converted by decimals, rounded up', () => {
  assert.equal(model.convertUnits(2_100_000_000_000_000n, 18, 18), 2_100_000_000_000_000n);
  assert.equal(model.convertUnits(5_000_000n, 6, 18), 5_000_000_000_000_000_000n, 'more decimals: exact');
  assert.equal(model.convertUnits(1_000_000_000_000_000_001n, 18, 6), 1_000_001n, 'fewer decimals: rounded up, never short');
});

// Added 2026-10-06 (the owner's point 2b): a holding of the kind wanted that covers the need comes before one that does not.
test('the one click prefers a holding that covers the need: a little ETH never stands in for the WETH that covers it', () => {
  const WETH_BASE = '0x4200000000000000000000000000000000000006';
  const holding = (token, symbol, decimals, raw) => ({ chainId: 8453, chainName: 'Base', token, symbol, decimals, raw });
  const all = { chains: [{ chainId: 8453, name: 'Base', tokens: [ETH, WETH_BASE, USDC_BASE].map((address) => ({ address, symbol: null, decimals: null, providers: ['relay'] })) }] };
  const dust = holding(ETH, 'ETH', 18, REVIEW_GAS_RESERVE_WEI + 1000n);
  const weth = holding(WETH_BASE, 'WETH', 18, ONE_ETH);
  assert.equal(model.holdingFor([dust, weth], ETH, 4663, 8453, all).token, ETH, 'with no figure: native first, as before');
  assert.equal(model.holdingFor([dust, weth], ETH, 4663, 8453, all, { raw: 10n ** 16n, decimals: 18 }).token, WETH_BASE, 'the one that covers 0.01 ETH');
  assert.equal(model.holdingFor([holding(ETH, 'ETH', 18, ONE_ETH), weth], ETH, 4663, 8453, all, { raw: 10n ** 16n, decimals: 18 }).token, ETH, 'both cover: native first');
  assert.equal(model.sendable(dust), 1000n, 'native ETH less the gas Review keeps');
  assert.equal(model.sendable(weth), ONE_ETH);
});

test('kinds and the target rule: a dollar to the stable, ether to ETH or WETH, else the other token a deposit delivers', () => {
  const WETH_BASE = '0x4200000000000000000000000000000000000006';
  const ARB_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
  assert.equal(model.kindOf(4663, ETH), 'ether');
  assert.equal(model.kindOf(4663, WETH_RH), 'ether');
  assert.equal(model.kindOf(4663, USDG), 'dollar');
  assert.equal(model.kindOf(8453, USDC_BASE), 'dollar');
  assert.equal(model.kindOf(42161, ARB_USDC.toUpperCase().replace('0X', '0x')), 'dollar', 'any case');
  assert.equal(model.kindOf(8453, USDG), null, 'Robinhood Chain\'s stable is nothing on Base');
  // Changed on purpose 2026-10-06 (rugged97's #379): Ethereum and OP Mainnet have kinds by their balance-chain profiles
  // (tests/v2/funds-balance-chains.test.mjs); any other network none.
  assert.equal(model.kindOf(137, ETH), null, 'another network: neither Domino\'s nor a balance chain');
  assert.equal(model.kindOf(4663, TSLA), null);
  // The pool's tokens a deposit can deliver, in pool order.
  assert.deepEqual(model.deliverableTokens(4663, [ETH, USDG]), [ETH, USDG]);
  assert.deepEqual(model.deliverableTokens(8453, ['0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b', WETH_BASE]), [WETH_BASE], 'VIRTUAL is not deliverable');
  assert.deepEqual(model.deliverableTokens(4663, [TSLA, '0x2234567890abcdef1234567890abcdef12345678']), []);
  assert.equal(model.targetFor('dollar', [ETH, USDG], 4663), USDG);
  assert.equal(model.targetFor('ether', [ETH, USDG], 4663), ETH);
  assert.equal(model.targetFor('dollar', [WETH_BASE], 8453), WETH_BASE, 'no stable in the pool: the other deliverable token');
  assert.equal(model.targetFor(null, [USDG], 4663), USDG);
  assert.equal(model.targetFor('ether', [], 4663), null);
  // After an amount, which lack a network's holdings serve is chosen with the holding itself (model.ts bringChoice, below).
});

// Changed on purpose 2026-10-06 (rugged's delta of 6 Oct §3, crosschain-v1 1.1.0-rc.1): the amount brought is no longer
// sized from two quotes; ONE quote asks by output: what the position lacks must arrive, the coin's sendable balance is the
// most to send. The old sizing (firstAsk, sizeStep, sizeFromQuote, withMargin, winningMinimum, fixedFeeOf) is gone.
test('the one click\'s request: by output, the need in destination units, the sendable balance as the most to send; the runtime takes it', () => {
  const byOutput = model.quoteRequestOf({ originChainId: 8453, originToken: USDC_BASE.toUpperCase().replace('0X', '0x'), destinationChainId: 4663, destinationToken: USDG, amountRaw: '100000000', slippageBps: 50, destinationGas: false, maxInputRaw: '150000000' });
  assert.deepEqual(byOutput, { originChainId: 8453, originToken: USDC_BASE, destinationChainId: 4663, destinationToken: USDG, amountKind: 'output', amountRaw: '100000000', maxInputRaw: '150000000', slippageBps: 50, destinationGas: false });
  assert.equal(runtime.validateRequest('quote', byOutput), true);
  // The package's own request by output (variants/quote.output) is this one, less its owner.
  const { owner, ...recorded } = JSON.parse(readFileSync(new URL('../../../api-contracts/crosschain-v1/fixtures/variants/quote.output.json', import.meta.url), 'utf8')).quote.request;
  assert.ok(owner);
  assert.deepEqual(byOutput, recorded);
  // With "Get gas on {destination}": the same request, Relay adding the gas to what is sent.
  assert.equal(runtime.validateRequest('quote', { ...byOutput, destinationGas: true }), true);
  // Without a cap it is by exact input, as typed amounts, "Other networks" and everything held are.
  assert.deepEqual({ ...model.quoteRequestOf({ ...byOutput, maxInputRaw: undefined }) }, { ...byOutput, amountKind: 'exact_input', maxInputRaw: null });
  for (const name of ['sizeStep', 'firstAsk', 'sizeFromQuote', 'withMargin', 'winningMinimum', 'fixedFeeOf']) assert.equal(model[name], undefined, `${name} is gone`);
  const constants = require('../../.test-build/app/src/v2in/funds/constants.js');
  assert.equal(constants.FUNDS_SIZE_SLACK_BPS, undefined, 'FUNDS_SIZE_SLACK_BPS is gone');
});

test('both bridges above what can be sent: what each needs against the most the wallet may send, in one line', () => {
  const { naming } = require('../../.test-build/app/src/v2/crosschain/present.js');
  const { FUNDS_TEXT } = require('../../.test-build/app/src/v2in/funds/copy.js');
  const recorded = JSON.parse(readFileSync(new URL('../../../api-contracts/crosschain-v1/fixtures/variants/quote.output-above-max.json', import.meta.url), 'utf8')).quote;
  assert.equal(model.aboveMaxOf(recorded, naming(null)), null, 'Across still sends it: no line');
  const both = { ...recorded, decision: null, reason: 'no_quote', steps: [], candidates: recorded.candidates.map((c) => ({ ...c, status: 'input_above_max' })) };
  const above = model.aboveMaxOf(both, naming(null));
  assert.deepEqual(above, { needs: ['Relay needs 100.916974 USDC', 'Across needs 100.902201 USDC'], max: '100.91 USDC' });
  assert.equal(FUNDS_TEXT.aboveMax(above.needs, above.max, 'Base'), 'Relay needs 100.916974 USDC and Across needs 100.902201 USDC; you can send 100.91 USDC from Base.');
  assert.equal(model.aboveMaxOf({ ...both, request: { ...both.request, amountKind: 'exact_input', maxInputRaw: null } }, naming(null)), null, 'never by exact input');
  // Partial capacity is useful only inside a complete funding proposal. No isolated drain-all button is offered.
  const intent = readFileSync(new URL('../../src/v2in/funds/fundingIntent.ts', import.meta.url), 'utf8');
  assert.match(intent, /candidate\.status === 'input_above_max'/, 'only supported priced routes can become partial contributions');
  assert.match(intent, /if \(remaining > 0n\) throw new Error\('funding_quotes_changed'\)/, 'the aggregate must cover the full required net output before it can be returned');
  assert.match(intent, /return fresh\(sized\)/, 'every selected leg must also remain valid for review');
  assert.match(intent, /maxInputRaw: sentRaw\(leg\.quote\)/, 'the reviewed spending amount bounds each later quote');
});

test('a change under Change amount is quoted after a pause, and never more than six times a minute', () => {
  const { FUNDS_TYPED_QUOTE_DEBOUNCE_MS, FUNDS_TYPED_QUOTES_PER_MINUTE } = require('../../.test-build/app/src/v2in/funds/constants.js');
  assert.ok(FUNDS_TYPED_QUOTE_DEBOUNCE_MS >= 800, 'at least 800 ms (the plan)');
  assert.equal(FUNDS_TYPED_QUOTES_PER_MINUTE, 6);
  assert.equal(model.typedQuoteWait([], 100_000), FUNDS_TYPED_QUOTE_DEBOUNCE_MS);
  assert.equal(model.typedQuoteWait([50_000, 60_000, 70_000, 80_000, 90_000], 100_000), FUNDS_TYPED_QUOTE_DEBOUNCE_MS, 'five in the last minute');
  assert.equal(model.typedQuoteWait([50_000, 60_000, 70_000, 80_000, 90_000, 95_000], 100_000), 10_000, 'the sixth: until the oldest drops out');
  assert.equal(model.typedQuoteWait([10_000, 20_000, 30_000, 40_000, 45_000, 50_000], 100_000), FUNDS_TYPED_QUOTE_DEBOUNCE_MS, 'older than a minute: none count');
  // Changed on purpose 2026-10-06 (the review): every quote the page asks counts; one with no pause of its own (a one
  // click's, a new one past the deadline) waits only while the cap holds.
  assert.equal(model.quoteBudgetWait([], 100_000), 0);
  assert.equal(model.quoteBudgetWait([50_000, 60_000, 70_000, 80_000, 90_000], 100_000), 0, 'five in the last minute: at once');
  assert.equal(model.quoteBudgetWait([50_000, 60_000, 70_000, 80_000, 90_000, 95_000], 100_000), 10_000, 'six: until the oldest drops out');
  assert.equal(model.quoteBudgetWait([39_000, 41_000, 60_000, 70_000, 80_000, 90_000, 95_000], 100_000), 1_000, 'one already out of the minute');
});

test('one live line while the wallet works: the step out of how many, in plain words', () => {
  assert.equal(model.runLine(null, true, 'Base'), null);
  assert.equal(model.runLine('switching', true, 'Arbitrum One'), 'Switching to Arbitrum One · confirm in your wallet');
  assert.equal(model.runLine('approval_wallet', true, 'Base'), 'Step 1 of 2 · approve in your wallet');
  assert.equal(model.runLine('approval_sent', true, 'Base'), 'Step 1 of 2 · waiting for the approval…');
  assert.equal(model.runLine('deposit_wallet', true, 'Base'), 'Step 2 of 2 · confirm in your wallet');
  // Changed on purpose 2026-10-06 (the review): one step alone is a sentence of its own, capitalised.
  assert.equal(model.runLine('deposit_wallet', false, 'Base'), 'Confirm in your wallet', 'ETH, or an approval already there: one step');
  assert.equal(model.runLine('approval_skipped', false, 'Base'), 'Getting the deposit ready…');
  assert.equal(model.runLine('approval_skipped', true, 'Base'), 'Step 2 of 2 · getting the deposit ready…');
});

// Added 2026-10-06 (the owner's point 2a): the networks crosschain-v1 pins both Relay and Across on, beyond Domino's own.
test('Other networks: the listing\'s networks with both bridges, one name each, Ethereum and OP Mainnet first; tokens with known decimals, the network\'s own first', async () => {
  const { CONSTANTS } = await import(new URL('../../../api-contracts/crosschain-v1/schema-data.mjs', import.meta.url).href);
  const both = Object.entries(CONSTANTS.chains).filter(([, pins]) => pins.relay && pins.across).map(([id]) => Number(id)).filter((id) => ![4663, 8453, 42161].includes(id)).sort((a, b) => a - b);
  assert.deepEqual([...model.BOTH_PINNED_ORIGINS].sort((a, b) => a - b), both, 'the copy is the package\'s pins');
  const chain = (chainId, name, tokens) => ({ chainId, name, tokens: tokens.map(([address, symbol, decimals]) => ({ address, symbol, decimals, providers: ['relay', 'across'] })) });
  const list = {
    chains: [
      chain(25, 'Cronos', [[ETH, 'CRO', 18]]),
      chain(137, 'Polygon', [['0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', 'USDC', 6], [ETH, 'POL', 18]]),
      chain(10, 'Optimism', [['0x0b2c639c533813f4aa9d7837caf62653d097ff85', 'USDC', 6], [ETH, 'ETH', 18], ['0x4200000000000000000000000000000000000042', 'OP', null]]),
      {
        chainId: 1,
        name: 'Ethereum',
        tokens: [
          { address: '0x5555555555555555555555555555555555555555', symbol: 'SOMI', decimals: 18, providers: ['relay'] },
          { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT', decimals: 6, providers: ['relay'] },
          { address: '0xe343167631d89b6ffc58b88d6b7fb0228795491d', symbol: 'USDG', decimals: 6, providers: ['relay', 'across'] },
          { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6, providers: ['relay', 'across'] },
          { address: '0x4d224452801aced8b2f0aebe155379bb5d594381', symbol: 'APE', decimals: 18, providers: ['relay'] },
          { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', decimals: 18, providers: ['relay'] },
          { address: ETH, symbol: 'ETH', decimals: 18, providers: ['relay'] },
        ],
      },
      chain(42161, 'Arbitrum', [[ETH, 'ETH', 18]]),
      chain(59144, 'Linea', [['0x1111111111111111111111111111111111111111', 'X', null]]),
    ],
  };
  const others = model.otherNetworks(list, 4663);
  assert.deepEqual(others.map((o) => [o.chainId, o.name]), [[1, 'Ethereum'], [10, 'OP Mainnet'], [137, 'Polygon']], 'Relay-only Cronos out; Domino\'s own out; a network with no usable token out');
  assert.deepEqual(others[1].tokens.map((t) => [t.label, t.decimals]), [['ETH', 18], ['USDC', 6]], 'its own currency first; no raw units');
  // Changed on purpose 2026-10-06 (the review: Relay lists up to 32 tokens a network): the network's own currency, WETH,
  // USDC and USDT, and what both bridges list; never SOMI or APE.
  assert.deepEqual(others[0].tokens.map((t) => t.label), ['ETH', 'WETH', 'USDC', 'USDT', 'USDG']);
  assert.deepEqual(model.otherNetworks(list, 1).map((o) => o.chainId), [10, 137], 'never the destination');
});

// Changed on purpose 2026-10-06 (the integration review): the amount sent is rounded UP for the button and "You send", so
// it never says less than the wallet is asked to approve and send.
// Changed on purpose (data) 2026-10-06 (crosschain-v1 1.1.0-rc.1): what is sent is the winner's inputRaw, the amount
// asked while the page asks by exact input; the request's amount only while no candidate won.
test('the wallet steps in words: the amount sent rounded up for the screen, and exact', () => {
  const { naming } = require('../../.test-build/app/src/v2/crosschain/present.js');
  const sending = (request, sent) => ({ request, decision: 'relay', candidates: [{ provider: 'relay', inputRaw: sent }, { provider: 'across', inputRaw: null }] });
  const eth = { originChainId: 42161, originToken: ETH, amountKind: 'exact_input', amountRaw: '99395417139745917', maxInputRaw: null, destinationChainId: 8453, destinationToken: '0x4200000000000000000000000000000000000006' };
  const quote = sending(eth, eth.amountRaw);
  assert.deepEqual(model.stepWords(quote, naming(null)), { origin: 'Arbitrum One', amount: '0.099396 ETH', exact: '0.099395417139745917 ETH', approval: false });
  const usdc = { ...eth, originToken: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', amountRaw: '51000000' };
  assert.deepEqual(model.stepWords(sending(usdc, usdc.amountRaw), naming(null)), { origin: 'Arbitrum One', amount: '51 USDC', exact: '51 USDC', approval: true }, 'nothing dropped: as it is');
  // By output (the offer's follow-up) amountRaw is what must arrive; the button and "You send" say the winner's input.
  const byOutput = sending({ ...usdc, amountKind: 'output', amountRaw: '50000000', maxInputRaw: '60000000' }, '50251001');
  assert.deepEqual(model.stepWords(byOutput, naming(null)), { origin: 'Arbitrum One', amount: '50.251001 USDC', exact: '50.251001 USDC', approval: true });
  assert.equal(model.sentRaw(byOutput), '50251001');
  assert.equal(model.sentRaw({ ...byOutput, decision: null }), '50000000', 'no winner: nothing is sent, the request is shown as asked');
});

// Added 2026-10-06 (the 2026-10-06 study: "Use" resized the position to the whole balance after an arrival): once the
// wallet covers the amount typed, Use keeps it. A short balance never replaces the user's chosen amount.
test('after an arrival, continuation keeps the amount typed once the wallet covers it', () => {
  assert.deepEqual(model.keptAmount(BOTH, 1, ' 50 ', 'USDG'), { side: 1, text: '50', label: '50 USDG' });
  assert.deepEqual(model.keptAmount(SWAP_FROM_ETH, 1, '50', 'USDG'), { side: 1, text: '50', label: '50 USDG' }, 'covered through the swap from what arrived');
  assert.equal(model.keptAmount(SHORT_USDG, 1, '50', 'USDG'), null, 'still short: no continuation or implicit resize');
  assert.equal(model.keptAmount(null, 1, '50', 'USDG'), null, 'balances unread: no claim');
  assert.equal(model.keptAmount(BOTH, null, '50', 'USDG'), null);
  assert.equal(model.keptAmount(BOTH, 1, '  ', 'USDG'), null, 'nothing typed');
  assert.deepEqual(model.keptAmount(BOTH, 0, '0.5', null), { side: 0, text: '0.5', label: '0.5' });
  // Changed on purpose 2026-10-06 (the integration review: "Use 0.012649318273645123 ETH"): the label at six decimals, the
  // text exact; without the decimals, or an amount that is not one, the text as typed.
  assert.deepEqual(model.keptAmount(BOTH, 0, '0.012649318273645123', 'ETH', 18), { side: 0, text: '0.012649318273645123', label: '0.012649 ETH' });
  assert.deepEqual(model.keptAmount(BOTH, 1, '1234.5', 'USDG', 6), { side: 1, text: '1234.5', label: '1,234.5 USDG' });
  assert.deepEqual(model.keptAmount(BOTH, 1, '50', 'USDG', null), { side: 1, text: '50', label: '50 USDG' });
  const status = readFileSync(new URL('../../src/v2in/funds/DepositStatus.tsx', import.meta.url), 'utf8');
  assert.match(status, /balanceState === 'ready' && keep !== null && \(/, 'continuation requires reconciled balances, independent of the active wallet network');
  assert.match(status, /if \(onContinue\) onContinue\(\)\s+else \{ onUse\(keep\.side, keep\.text\); onRemove\(\) \}/, 'the current journey delegates adoption to its guarded handoff; the standalone continuation keeps the typed amount');
  const offer = readFileSync(new URL('../../src/v2in/funds/BringFunds.tsx', import.meta.url), 'utf8');
  const adoption = offer.slice(offer.indexOf('const useArrivedFunds'), offer.indexOf('const changed = intent'));
  assert.match(adoption, /services\.readBalances/, 'the handoff revalidates balances before adopting');
  assert.match(adoption, /else if \(keep\) onUse\(keep\.side, keep\.text\)/, 'adoption preserves the exact selected amount');
  assert.match(adoption, /save\(null\)/, 'adoption retires the active intent');
  assert.doesNotMatch(adoption, /journal\?\.drop|journal\.drop|runDeposit/, 'adoption neither erases transaction references nor sends another deposit');
  assert.doesNotMatch(status, /onUse\(side, amount\.text\)|onUseToken\(startToken|data-funds-use="balance"/, 'arrivals cannot replace the entered quantity with a wallet balance');
  assert.doesNotMatch(status, /switchToChain|own\.balance\(/, 'reading arrivals never moves the wallet');
  const amounts = readFileSync(new URL('../../src/v2in/funds/FundsAmounts.tsx', import.meta.url), 'utf8');
  assert.match(amounts, /keptAmount\(planned\?\.plan \?\? null, independent, state\.budget, independent !== null \? pool\.currencies\[independent\]\.symbol : null, independent !== null \? pool\.currencies\[independent\]\.decimals : null\)/, 'with the typed token\'s decimals');
});

// ---- Added 2026-10-06: the review of 2026-10-06 ---------------------------------------------------------------------
const ARB_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const BASE_WETH = '0x4200000000000000000000000000000000000006';
const onNet = (chainId, tokenAddress, symbol, decimals, raw) => ({ chainId, chainName: 'X', token: tokenAddress, symbol, decimals, raw });
const lackOf = (side, tokenAddress, symbol, decimals, shortRaw) => ({ side, token: tokenAddress, symbol, decimals, haveRaw: 0n, shortRaw });
const NO_PRICES = { ether: null, dollar: null };
/** ETH at US$4,000, a dollar at US$1 (micro-dollars per whole token). */
const PRICES = { ether: 4_000_000_000n, dollar: 1_000_000n };

test('the prices of each kind, as Domino\'s service read them: any network\'s ETH or WETH, any network\'s stable; never an unread network\'s', () => {
  const balance = (address, usd) => ({ address, symbol: null, decimals: null, balanceRaw: '0', status: 'read', price: usd === null ? null : { usd }, priceReason: null, valueUsd: null });
  const answer = {
    chains: [
      { chainId: 42161, status: 'unavailable', balances: [balance(ETH, '9999.0')] },
      { chainId: 8453, status: 'current', balances: [balance(BASE_WETH, '4000.123456780000000000'), balance(USDC_BASE, '1.000000000000000000'), balance(TSLA, '250')] },
    ],
  };
  assert.deepEqual(model.kindPrices(answer), { ether: 4_000_123_456n, dollar: 1_000_000n });
  assert.deepEqual(model.kindPrices(null), NO_PRICES);
  assert.deepEqual(model.kindPrices({ chains: [{ chainId: 8453, status: 'current', balances: [balance(ETH, null)] }] }), NO_PRICES, 'no price: none');
  // 100 USDG at US$1 is 0.025 ETH at US$4,000 (rounded up); without either price, nothing is claimed.
  assert.equal(model.worthIn(100_000_000n, 6, PRICES.dollar, 18, PRICES.ether), 25_000_000_000_000_000n);
  assert.equal(model.worthIn(10n ** 16n, 18, PRICES.ether, 6, PRICES.dollar), 40_000_000n, '0.01 ETH is 40 USDC');
  assert.equal(model.worthIn(1n, 6, PRICES.dollar, 18, null), null);
  assert.equal(model.worthIn(1n, 6, null, 18, PRICES.ether), null);
});

// The review's blocker: a USDG/TSLA pool on Robinhood Chain, 100 USDG typed, only 0.5 ETH held on Base. The page used to
// offer "Bring 0.4995 ETH from Base" for a US$100 position.
test('another kind of token held: the amount asked is about what the position lacks, never the balance, with prices or without', () => {
  const lacks = [lackOf(1, USDG, 'USDG', 6, 100_000_000n)];
  const held = [onNet(8453, ETH, 'ETH', 18, ONE_ETH / 2n)];
  const choice = model.bringChoice({ lacks, holdings: held, destination: 4663, origin: 8453, deliverable: [USDG], prices: PRICES });
  assert.equal(choice.target, USDG);
  assert.equal(choice.holding.token, ETH);
  const available = model.sendable(choice.holding);
  // Changed on purpose 2026-10-06 (rugged's delta of 6 Oct §3): with prices or without, ONE quote by output: 100 USDG must
  // arrive, and at most the ETH that can be sent leaves; the service answers how much ETH that takes.
  const request = model.quoteRequestOf({ originChainId: 8453, originToken: ETH, destinationChainId: 4663, destinationToken: USDG, amountRaw: '100000000', slippageBps: 50, destinationGas: false, maxInputRaw: available.toString() });
  assert.equal(request.amountKind, 'output');
  assert.equal(request.amountRaw, '100000000', 'what the position lacks, never the balance');
  assert.equal(request.maxInputRaw, available.toString());
  assert.equal(runtime.validateRequest('quote', request), true);
});

test('the lack and the holding chosen together: one that covers first, a plain bridge first; native ETH when both cover; the larger when none does', () => {
  const deliverable = [ETH, USDC_BASE];
  const choose = (lacks, holdings, prices = NO_PRICES) => {
    const c = model.bringChoice({ lacks, holdings, destination: 8453, origin: 42161, deliverable, prices });
    return c && [c.lack?.token ?? null, c.holding.token, c.target];
  };
  // The review's case: an ETH/USDC pool on Base, 0.05 ETH typed, nothing there; Arbitrum One holds 0.003 ETH and 1,000 USDC.
  const lacks = [lackOf(0, ETH, 'ETH', 18, 50_500_000_000_000_000n), lackOf(1, USDC_BASE, 'USDC', 6, 260_000_000n)];
  const dustAndDollars = [onNet(42161, ETH, 'ETH', 18, 3_000_000_000_000_000n), onNet(42161, ARB_USDC, 'USDC', 6, 1_000_000_000n)];
  assert.deepEqual(choose(lacks, dustAndDollars), [USDC_BASE, ARB_USDC, USDC_BASE], 'the 1,000 USDC that covers, never the 0.0025 ETH that does not');
  assert.deepEqual(choose(lacks, dustAndDollars, PRICES), [USDC_BASE, ARB_USDC, USDC_BASE]);
  // Both cover: the token Review's plan is short of first; for it, native ETH before WETH (one transaction).
  const plenty = [onNet(42161, ARB_USDC, 'USDC', 6, 1_000_000_000n), onNet(42161, ETH, 'ETH', 18, ONE_ETH)];
  assert.deepEqual(choose(lacks, plenty), [ETH, ETH, ETH]);
  assert.deepEqual(choose([lacks[1], lacks[0]], plenty), [USDC_BASE, ARB_USDC, USDC_BASE], 'the plan short of USDC: USDC');
  const ARB_WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
  assert.deepEqual(choose(lacks.slice(0, 1), [onNet(42161, ARB_WETH, 'WETH', 18, ONE_ETH), onNet(42161, ETH, 'ETH', 18, ONE_ETH)]), [ETH, ETH, ETH], 'ETH before WETH');
  // None covers: the one worth more (the larger position), where the prices say it.
  const little = [onNet(42161, ETH, 'ETH', 18, 20_000_000_000_000_000n), onNet(42161, ARB_USDC, 'USDC', 6, 10_000_000n)];
  assert.deepEqual(choose(lacks, little, PRICES), [ETH, ETH, ETH], 'US$80 of ETH before US$10 of USDC');
  assert.deepEqual(choose(lacks, [onNet(42161, ETH, 'ETH', 18, 1_000_000_000_000_000n), onNet(42161, ARB_USDC, 'USDC', 6, 200_000_000n)], PRICES), [USDC_BASE, ARB_USDC, USDC_BASE], 'US$200 of USDC before US$2 of ETH');
  // Another kind covers where the same kind does not, at the prices read.
  assert.deepEqual(choose(lacks.slice(0, 1), [onNet(42161, ARB_USDC, 'USDC', 6, 1_000_000_000n)], PRICES), [ETH, ARB_USDC, ETH]);
  // A lack with no figure (the zap path's alternatives) comes after any with one, whatever is held.
  const zap = [lackOf(1, USDC_BASE, 'USDC', 6, 50_000_000n), lackOf(0, ETH, 'ETH', 18, null)];
  assert.deepEqual(choose(zap, [onNet(42161, ETH, 'ETH', 18, ONE_ETH)], PRICES), [USDC_BASE, ETH, USDC_BASE]);
  assert.deepEqual(choose(zap.slice(1), [onNet(42161, ETH, 'ETH', 18, ONE_ETH)]), [ETH, ETH, ETH], 'only it: chosen, and the person types the amount');
  // Nothing to send: none.
  assert.equal(choose(lacks, [onNet(42161, ETH, 'ETH', 18, REVIEW_GAS_RESERVE_WEI)]), null, 'only the gas Review keeps');
  assert.equal(choose(lacks, []), null);
});

test('before an amount, a network\'s holding of a pool token\'s kind first, then the one worth more, brought as its own kind', () => {
  const choose = (holdings, deliverable, prices = PRICES) => {
    const c = model.bringChoice({ lacks: [], holdings, destination: 8453, origin: 42161, deliverable, prices });
    return c && [c.lack, c.holding.token, c.target];
  };
  const both = [onNet(42161, ARB_USDC, 'USDC', 6, 50_000_000n), onNet(42161, ETH, 'ETH', 18, ONE_ETH)];
  assert.deepEqual(choose(both, [ETH, USDC_BASE]), [null, ETH, ETH], 'US$4,000 of ETH before US$50 of USDC');
  assert.deepEqual(choose(both, [USDC_BASE]), [null, ARB_USDC, USDC_BASE], 'the dollar, for a pool whose deliverable token is a dollar');
  assert.deepEqual(choose(both, [BASE_WETH]), [null, ETH, BASE_WETH], 'ether, as WETH');
  assert.equal(choose(both, []), null, 'nothing a deposit can deliver there');
});

// Changed on purpose 2026-10-06 (the integration review: one approval left unanswered on Base hid every network for every
// position): every offer is held back only while what the position lacks here may change by itself; any other held step
// closes its own origin alone.
test('the line and the networks are held back while a deposit this page sent is on its way, or a deposit held for this network; a held step closes only its origin', () => {
  const sent = { sentHere: true, hash: '0xaa' };
  const restored = { sentHere: false, hash: '0xbb' };
  assert.equal(model.holdOffers([], new Set(), [], 4663), false);
  assert.equal(model.holdOffers([sent], new Set(), [], 4663), true, 'the balances read are from before it left');
  assert.equal(model.holdOffers([sent], new Set(['0xaa']), [], 4663), false, 'settled: read again, offered again');
  assert.equal(model.holdOffers([restored], new Set(), [], 4663), false, 'read after it left');
  assert.equal(model.holdOffers([restored, sent], new Set(['0xaa']), [], 4663), false);
  const approval = { originChainId: 8453, kind: 'approval', destinationChainId: 4663 };
  const deposit = { originChainId: 8453, kind: 'deposit', destinationChainId: 4663 };
  assert.equal(model.holdOffers([], new Set(), [approval], 4663), false, 'an approval held: nothing can arrive from it');
  assert.equal(model.holdOffers([], new Set(), [deposit], 4663), true, 'a deposit held for this network may still arrive: no second bridge meanwhile');
  assert.equal(model.holdOffers([], new Set(), [deposit], 42161), false, 'one held for another network changes nothing here');
  assert.deepEqual([...model.heldOrigins([approval, { ...deposit, originChainId: 42161, destinationChainId: 8453 }])].sort((a, b) => a - b), [8453, 42161], 'each held step closes its own origin');
  assert.equal(model.heldOrigins([]).size, 0);
  // Added 2026-10-06 (the integration review's second pass): the same rule says what is "On the way" here.
  assert.equal(model.heldMayArrive([deposit], 4663), true);
  assert.equal(model.heldMayArrive([approval], 4663), false, 'an approval: nothing moves');
  assert.equal(model.heldMayArrive([deposit], 42161), false, 'held for another network');
  assert.equal(model.heldMayArrive([], 4663), false);
});

test('the line\'s mark: by address only, the bundled ETH, WETH and USDG; any other a calm disc', () => {
  assert.equal(model.holdingArtwork(42161, ETH), 'ETH');
  assert.equal(model.holdingArtwork(8453, BASE_WETH), 'WETH');
  assert.equal(model.holdingArtwork(4663, WETH_RH), 'WETH');
  assert.equal(model.holdingArtwork(4663, USDG.toUpperCase().replace('0X', '0x')), 'USDG');
  assert.equal(model.holdingArtwork(8453, USDC_BASE), null, 'no bundled USDC: never a file named after a symbol');
  assert.equal(model.holdingArtwork(8453, USDG), null, 'USDG\'s address means nothing on Base');
  // Changed on purpose 2026-10-06 (rugged97's #379): Ethereum's and OP Mainnet's ETH and WETH have their marks too
  // (tests/v2/funds-balance-chains.test.mjs); any other network none.
  assert.equal(model.holdingArtwork(137, ETH), null, 'neither Domino\'s networks nor a balance chain');
});
