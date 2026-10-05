/**
 * The inline "Bring {token} from {network}" offer's pure model (src/v2in/funds/model.ts, spec F7 §3.3, §3.4, §3.9): when
 * the amount step offers it (decided [owner, 2026-10-02 evening]: only when the position can't be funded on its chain at
 * all, counting the one-token swap: Review's plan is `short` once an amount is typed, the wallet holds none of either
 * token before; only a token a deposit can deliver there; never on an unread balance), the amount the same position
 * continues with after the fill, where the answers come from (HTTP only, once wired; never test data: the owner,
 * 2026-10-02 night), and the copied form helpers.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const model = require('../../.test-build/app/src/v2in/funds/model.js');
const { REVIEW_GAS_RESERVE_WEI } = require('../../.test-build/app/src/lib/create/reviewPlan.js');

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

test('an amount typed: offered only when Review\'s plan is short; the short token first with its shortfall, the other after it with no figure', () => {
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

test('before an amount: offered only when the wallet holds none of either token; anything to swap from offers nothing', () => {
  assert.deepEqual(lacks({ balances: ['0', '0'], independent: 1 }).map((l) => [l.side, l.token, l.haveRaw, l.shortRaw]), [
    [1, USDG, 0n, null],
    [0, ETH, 0n, null],
  ]);
  assert.deepEqual(lacks({ balances: [ONE_ETH.toString(), '0'], independent: 1 }), [], 'the ETH can be swapped for USDG');
  assert.deepEqual(lacks({ balances: ['0', '5'], independent: 1 }), [], 'some USDG is there');
  // Less ETH than Review's gas allowance is none: nothing to fund with.
  assert.deepEqual(lacks({ balances: [(REVIEW_GAS_RESERVE_WEI - 1n).toString(), '0'] }).map((l) => [l.token, l.haveRaw]), [
    [ETH, 0n],
    [USDG, 0n],
  ]);
});

test('an unread balance offers nothing, even with a short plan: zero is never assumed', () => {
  for (const balances of [null, [ONE_ETH.toString(), null], [null, '0'], [ONE_ETH.toString(), 'not a number']]) {
    assert.deepEqual(lacks({ balances }), []);
    assert.deepEqual(lacks({ balances, plan: SHORT_USDG }), []);
  }
});

test('only a token a deposit can deliver to the chain: its stable, ETH or WETH; a short token it can\'t leaves the other', () => {
  const TSLA_USDG = [token(TSLA, 'TSLA', 18), token(USDG, 'USDG', 6)];
  // Short of TSLA, which no deposit delivers: USDG is offered, since the swap can then buy the TSLA.
  assert.deepEqual(model.lackingTokens({ chainId: 4663, currencies: TSLA_USDG, balances: ['0', '5'], plan: { kind: 'short', token: 0, have: 0n, need: 10n }, only: null, independent: 0 }).map((l) => [l.token, l.shortRaw]), [[USDG, null]]);
  assert.deepEqual(model.lackingTokens({ chainId: 4663, currencies: TSLA_USDG, balances: ['0', '0'], plan: null, only: null, independent: 0 }).map((l) => l.token), [USDG]);
  assert.deepEqual(model.lackingTokens({ chainId: 4663, currencies: [token(WETH_RH, 'WETH', 18), token(TSLA, 'TSLA', 18)], balances: ['0', '0'], plan: null, only: null, independent: null }).map((l) => l.token), [WETH_RH]);
  assert.deepEqual(model.lackingTokens({ chainId: 4663, currencies: [token(TSLA, 'TSLA', 18), token('0x2234567890abcdef1234567890abcdef12345678', 'X', 18)], balances: ['0', '0'], plan: null, only: null, independent: null }), []);
  // Base's USDC is a destination there, not on Robinhood Chain; an unknown chain offers nothing.
  assert.deepEqual(model.lackingTokens({ chainId: 8453, currencies: [token(ETH, 'ETH', 18), token(USDC_BASE, 'USDC', 6)], balances: ['0', '0'], plan: null, only: null, independent: 1 }).map((l) => [l.token, l.symbol]), [[USDC_BASE, 'USDC'], [ETH, 'ETH']]);
  assert.deepEqual(model.lackingTokens({ chainId: 1, currencies: ETH_USDG, balances: ['0', '0'], plan: null, only: null, independent: null }), []);
});

test('order: the token the plan is short of; before an amount, the token a one-sided range takes, else the typed one', () => {
  assert.deepEqual(lacks({ balances: ['0', '0'], plan: { kind: 'short', token: 0, have: 0n, need: 1n }, independent: 1 }).map((l) => [l.side, l.shortRaw]), [[0, 1n], [1, null]]);
  assert.deepEqual(lacks({ balances: ['0', '0'], independent: 1 }).map((l) => l.side), [1, 0]);
  assert.deepEqual(lacks({ balances: ['0', '0'], independent: 0 }).map((l) => l.side), [0, 1]);
  assert.deepEqual(lacks({ balances: ['0', '0'], only: 0, independent: 1 }).map((l) => l.side), [0, 1], 'the range takes ETH alone');
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
  assert.equal(model.amountRawOf('1,000', 6), null);
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
  assert.deepEqual(
    model.quoteRequestOf({ originChainId: 42161, originToken: '0xAF88d065e77c8cC2239327C5EDb3A432268e5831', destinationChainId: 4663, destinationToken: '0x5FC5360D0400a0Fd4f2af552ADD042D716F1d168', amountRaw: '100000000', slippageBps: 50, destinationGas: false }),
    { originChainId: 42161, originToken: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', destinationChainId: 4663, destinationToken: USDG, amountRaw: '100000000', slippageBps: 50, destinationGas: false },
  );
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
