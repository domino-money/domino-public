/**
 * The new-position journey's pure state machine (src/lib/create/journey.ts):
 * stages, what each needs before Continue, the transitions, the validation of
 * budget, range and Domino limits, the preview request it would send, the
 * creation gate, and the summary. No React and no reads are involved: the
 * inputs are shaped exactly like the values the read screens hand over.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const journey = require('../.test-build/app/src/lib/create/journey.js');
const { CREATE, allCreateStrings } = require('../.test-build/app/src/lib/create/copy.js');
const { SELECTED_POOL_CATALOGUE } = require('../.test-build/app/src/config/selectedPoolCatalogue.js');

const ZERO = '0x0000000000000000000000000000000000000000';
const addr = (letter) => `0x${letter.repeat(40)}`;
const id = (letter) => `0x${letter.repeat(64)}`;
/** sqrt(1) × 2^96: tick 0 agrees with it, so the pool price is usable. */
const SQRT_ONE = '79228162514264337593543950336';
const NOW = 0;

const token = (address, decimals = 18, symbol = 'T') => ({ origin: 'read', chainId: 4663, address, symbol, decimals, readStatus: 'available', artwork: null });
const candidate = (address, decimals = 18, extra = {}, symbol = 'T') => ({
  key: address,
  wire: address,
  token: token(address, decimals, symbol),
  kind: address === ZERO ? 'native' : 'erc20_candidate',
  why: null,
  reasonCode: null,
  decimalsUnavailable: decimals === null,
  source: 'pasted',
  balance: null,
  page: null,
  old: false,
  block: 1,
  ...extra,
});
const figure = { state: 'unavailable', provider: 'dexscreener', reason: 'no_provider_figures' };
const pool = (extra = {}) => ({
  key: id('a'),
  kind: 'discovery',
  currencies: [token(addr('1'), 18, 'ONE'), token(addr('2'), 6, 'TWO')],
  fee: '0.30%',
  feePips: 3000,
  tickSpacing: 60,
  tick: 0,
  sqrtPriceX96: SQRT_ONE,
  readAt: 0,
  hooks: ZERO,
  integration: 'hookless_fixed_fee',
  block: 700,
  catalogue: null,
  requestedById: false,
  liquidity: figure,
  volume: figure,
  providerNote: null,
  aprReason: 'reconciled_fee_history_unavailable',
  tokenMetadata: 'available',
  providerConflict: false,
  ...extra,
});

const ONE = candidate(addr('1'), 18, {}, 'ONE');
const TWO = candidate(addr('2'), 6, {}, 'TWO');
const OTHER = candidate(addr('9'), 18);

/** A state at the amount stage with everything before it complete. */
function ready() {
  let s = journey.withToken(journey.initialState(), ONE);
  s = journey.next(s, NOW);
  s = journey.withPool(s, pool(), NOW);
  s = journey.next(s, NOW);
  return journey.withBudget(s, '0.5');
}

test('the six stages, in order, and where the journey starts', () => {
  assert.deepEqual(journey.STAGES, ['token', 'pool', 'amount', 'balance', 'automation', 'review']);
  const s = journey.initialState();
  assert.equal(s.stage, 'token');
  assert.equal(s.furthest, 'token');
  assert.equal(s.automation, 'none');
  assert.deepEqual(s.limits, { triggerPercent: '5', maxOverlapPercent: '20', sequenceCap: '3' });
  assert.equal(s.slippageBps, '50');
});

test('Your token: nothing continues without a selectable token, and the reason says so', () => {
  const s = journey.initialState();
  assert.deepEqual(journey.canContinue('token', s, NOW), { ok: false, reason: CREATE.token.needToken });
  assert.equal(journey.next(s, NOW), s, 'next is a no-op while the stage cannot continue');
  const unreadable = candidate(addr('3'), null, { why: 'unreadable', kind: 'unknown', decimalsUnavailable: true });
  assert.deepEqual(journey.canContinue('token', journey.withToken(s, unreadable), NOW), { ok: false, reason: CREATE.token.notSelectable });
  assert.deepEqual(journey.canContinue('token', journey.withToken(s, ONE), NOW), { ok: true });
});

test('Choose a pool: the pool must hold the token; a different token drops the pool, the range and the budget', () => {
  let s = journey.next(journey.withToken(journey.initialState(), ONE), NOW);
  assert.equal(s.stage, 'pool');
  assert.deepEqual(journey.canContinue('pool', s, NOW), { ok: false, reason: CREATE.pool.needPool });
  s = journey.withPool(s, pool(), NOW);
  assert.deepEqual(s.range, { lower: -3600, upper: 4080 }, 'a usable price gets the standard preset on the pool’s spacing');
  assert.deepEqual(journey.canContinue('pool', s, NOW), { ok: true });
  // A pool that does not trade the token cannot be continued with.
  const elsewhere = journey.withPool(s, pool({ key: id('b'), currencies: [token(addr('8')), token(addr('9'))] }), NOW);
  assert.deepEqual(journey.canContinue('pool', elsewhere, NOW), { ok: false, reason: CREATE.pool.poolMismatch });
  // Re-reading the same pool keeps the range; a pool without a usable price gets none.
  const custom = journey.withRange(s, { lower: -600, upper: 600 });
  assert.deepEqual(journey.withPool(custom, pool({ block: 701 }), NOW).range, { lower: -600, upper: 600 });
  assert.equal(journey.withPool(s, pool({ key: id('c'), sqrtPriceX96: '0' }), NOW).range, null);
  // Another token: the pool, the range and the budget go; the same token keeps them.
  const budgeted = journey.withBudget(s, '1.5');
  const switched = journey.withToken(budgeted, OTHER);
  assert.equal(switched.pool, null);
  assert.equal(switched.range, null);
  assert.equal(switched.budget, '');
  const same = journey.withToken(budgeted, TWO);
  assert.equal(same.pool?.key, id('a'), 'the pool holds this token too, so it stays');
  assert.equal(same.budget, '', 'but the budget was in the other token’s units');
  // A second asset narrows; a pool that does not hold it goes.
  assert.equal(journey.withPaired(budgeted, TWO).pool?.key, id('a'));
  assert.equal(journey.withPaired(budgeted, OTHER).pool, null);
  assert.equal(journey.withToken(journey.withPaired(budgeted, TWO), TWO).paired, null, 'the token cannot be its own second asset');
});

test('a deposit budget is converted with the decimals the read returned, exactly, and never guessed', () => {
  const v = journey.validateBudget;
  assert.deepEqual(v('1', null), { ok: false, reason: CREATE.amount.decimalsUnknown });
  assert.deepEqual(v('', 18), { ok: false, reason: CREATE.amount.empty });
  for (const text of ['1,5', '-1', '1e3', '01', '.5', '1.', ' 1', '0x10']) assert.equal(v(text, 18).ok, false, text);
  assert.deepEqual(v('0', 18), { ok: false, reason: CREATE.amount.zero });
  assert.deepEqual(v('0.000', 18), { ok: false, reason: CREATE.amount.zero });
  assert.deepEqual(v('1.0000001', 6), { ok: false, reason: CREATE.amount.tooManyPlaces(6) });
  assert.deepEqual(v('0.001', 18), { ok: true, raw: '1000000000000000' });
  assert.deepEqual(v('1', 6), { ok: true, raw: '1000000' });
  assert.deepEqual(v('2500.25', 6), { ok: true, raw: '2500250000' });
  assert.deepEqual(v('7', 0), { ok: true, raw: '7' });
  assert.deepEqual(v('0.5', 0), { ok: false, reason: CREATE.amount.tooManyPlaces(0) });
  assert.deepEqual(v('115792089237316195423570985008687907853269984665640564039457.584007913129639935', 18), { ok: true, raw: (2n ** 256n - 1n).toString() });
  assert.deepEqual(v('115792089237316195423570985008687907853269984665640564039457.584007913129639936', 18), { ok: false, reason: CREATE.amount.tooLarge });
  // The raw value matches the preview contract's amountRaw pattern.
  assert.match(v('0.001', 18).raw, /^[1-9][0-9]{0,77}$/);
});

test('slippage is a whole number of basis points from 0 to 9999', () => {
  const v = journey.validateSlippage;
  assert.deepEqual(v('50'), { ok: true, bps: 50 });
  assert.deepEqual(v('0'), { ok: true, bps: 0 });
  assert.deepEqual(v('9999'), { ok: true, bps: 9999 });
  for (const text of ['', '10000', '-1', '1.5', '050', 'abc']) assert.deepEqual(v(text), { ok: false, reason: CREATE.amount.slippageInvalid }, text);
});

test('a range is whole ticks on the pool’s spacing, inside v4’s ticks, lower below upper', () => {
  const v = (range) => journey.validateRange(range, pool());
  assert.deepEqual(v(null), { ok: false, reason: CREATE.amount.noRange });
  assert.deepEqual(v({ lower: -60, upper: 60 }), { ok: true });
  assert.deepEqual(v({ lower: -61, upper: 60 }), { ok: false, reason: CREATE.amount.rangeSpacing });
  assert.deepEqual(v({ lower: -0.5, upper: 60 }), { ok: false, reason: CREATE.amount.rangeTicks });
  assert.deepEqual(v({ lower: 60, upper: 60 }), { ok: false, reason: CREATE.amount.rangeOrder });
  assert.deepEqual(v({ lower: 120, upper: 60 }), { ok: false, reason: CREATE.amount.rangeOrder });
  assert.deepEqual(v({ lower: -887280, upper: 60 }), { ok: false, reason: CREATE.amount.rangeBounds });
  assert.deepEqual(v({ lower: -887220, upper: 887220 }), { ok: true });
});

test('Amount and range continues only with a usable price, a converted budget, a valid range and slippage', () => {
  const s = ready();
  assert.equal(s.stage, 'amount');
  assert.deepEqual(journey.canContinue('amount', s, NOW), { ok: true });
  assert.deepEqual(journey.canContinue('amount', journey.withBudget(s, ''), NOW), { ok: false, reason: CREATE.amount.empty });
  assert.deepEqual(journey.canContinue('amount', journey.withRange(s, null), NOW), { ok: false, reason: CREATE.amount.noRange });
  assert.deepEqual(journey.canContinue('amount', journey.withSlippage(s, '12345'), NOW), { ok: false, reason: CREATE.amount.slippageInvalid });
  const noDecimals = journey.withToken(s, candidate(addr('1'), null, { decimalsUnavailable: true }));
  assert.deepEqual(journey.canContinue('amount', journey.withBudget(noDecimals, '1'), NOW), { ok: false, reason: CREATE.amount.decimalsUnknown });
  const unpriced = { ...s, pool: pool({ sqrtPriceX96: '0' }) };
  assert.deepEqual(journey.canContinue('amount', unpriced, NOW), { ok: false, reason: CREATE.amount.priceUnavailable });
});

test('Domino limits are checked one by one, each with its own words', () => {
  const v = journey.validateLimits;
  const ok = v(journey.DEFAULT_LIMITS);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.values, { trigger: 5, overlap: 20, cap: 3 });
  assert.deepEqual(ok.problems, { triggerPercent: null, maxOverlapPercent: null, sequenceCap: null });
  assert.deepEqual(v({ triggerPercent: '2.5', maxOverlapPercent: '0', sequenceCap: '1' }).values, { trigger: 2.5, overlap: 0, cap: 1 });
  assert.deepEqual(v({ triggerPercent: '50', maxOverlapPercent: '50', sequenceCap: '5' }).values, { trigger: 50, overlap: 50, cap: 5 });
  const bad = v({ triggerPercent: '0.05', maxOverlapPercent: '51', sequenceCap: '6' });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.problems, { triggerPercent: CREATE.automation.triggerInvalid, maxOverlapPercent: CREATE.automation.overlapInvalid, sequenceCap: CREATE.automation.capInvalid });
  for (const cap of ['0', '1.5', '', '-1', '03']) assert.equal(v({ ...journey.DEFAULT_LIMITS, sequenceCap: cap }).problems.sequenceCap, CREATE.automation.capInvalid, cap);
  for (const trigger of ['', '5.123', '-5', '5%']) assert.equal(v({ ...journey.DEFAULT_LIMITS, triggerPercent: trigger }).problems.triggerPercent, CREATE.automation.triggerInvalid, trigger);
});

test('the journey walks forward only through complete stages, back freely, and the rail reopens what was reached', () => {
  let s = ready();
  assert.equal(journey.reachable(s, NOW), 'review', 'nothing after the amount blocks: the preview is not enabled and automation defaults to none');
  assert.equal(journey.canOpen('balance', s, NOW), false, 'not reached yet');
  s = journey.next(s, NOW);
  assert.equal(s.stage, 'balance');
  assert.deepEqual(journey.canContinue('balance', s, NOW), { ok: true }, 'the person may continue past the preview that is not enabled');
  s = journey.next(s, NOW);
  assert.equal(s.stage, 'automation');
  s = journey.withAutomation(s, 'domino');
  const broken = journey.withLimits(s, { sequenceCap: '9' });
  assert.deepEqual(journey.canContinue('automation', broken, NOW), { ok: false, reason: CREATE.automation.limitsInvalid });
  assert.equal(journey.next(broken, NOW), broken);
  s = journey.next(s, NOW);
  assert.equal(s.stage, 'review');
  assert.equal(s.furthest, 'review');
  assert.deepEqual(journey.canContinue('review', s, NOW), { ok: false, reason: CREATE.review.gate });
  assert.equal(journey.next(s, NOW), s, 'review is the last stage');
  // Back keeps everything and the rail may reopen any reached stage.
  const backOnce = journey.back(s);
  assert.equal(backOnce.stage, 'automation');
  assert.equal(backOnce.furthest, 'review');
  assert.equal(backOnce.automation, 'domino');
  assert.equal(journey.goTo(backOnce, 'token', NOW).stage, 'token');
  assert.equal(journey.goTo(backOnce, 'review', NOW).stage, 'review');
  assert.equal(journey.back(journey.initialState()).stage, 'token');
  // Dropping the pool from the token stage closes the later stages again.
  const reopened = journey.withToken(journey.goTo(backOnce, 'token', NOW), OTHER);
  assert.equal(journey.reachable(reopened, NOW), 'pool');
  assert.equal(journey.canOpen('amount', reopened, NOW), false);
  assert.equal(journey.canOpen('pool', reopened, NOW), true);
  assert.equal(journey.goTo(reopened, 'review', NOW), reopened, 'a stage beyond what the state allows stays closed');
});

test('the preview request is shaped as onboarding-v1’s position-preview request, from validated values only', () => {
  const s = ready();
  const formed = journey.previewRequest(s);
  assert.equal(formed.ok, true);
  assert.deepEqual(formed.request, {
    chainId: 4663,
    poolId: id('a'),
    poolKey: { currency0: addr('1'), currency1: addr('2'), fee_pips: 3000, tick_spacing: 60, hooks: ZERO },
    independentToken: addr('1'),
    amountRaw: '500000000000000000',
    tickLower: -3600,
    tickUpper: 4080,
    slippageBps: 50,
  });
  assert.deepEqual(Object.keys(formed.request).sort(), ['amountRaw', 'chainId', 'independentToken', 'poolId', 'poolKey', 'slippageBps', 'tickLower', 'tickUpper'], 'nothing optional is invented: no budgets, no native balance, no gas reserve');
  // The other currency as the deposit token: its own decimals.
  const two = journey.withBudget(journey.withToken(s, TWO), '1');
  assert.equal(journey.previewRequest(two).request.independentToken, addr('2'));
  assert.equal(journey.previewRequest(two).request.amountRaw, '1000000');
  // What the service does not admit is said, not sent.
  assert.deepEqual(journey.previewRequest({ ...s, pool: pool({ hooks: addr('f') }) }), { ok: false, reason: CREATE.balance.hooks });
  assert.deepEqual(journey.previewRequest({ ...s, pool: pool({ feePips: 8388608, fee: 'Dynamic' }) }), { ok: false, reason: CREATE.balance.dynamicFee });
  assert.deepEqual(journey.previewRequest(journey.initialState()), { ok: false, reason: CREATE.balance.incomplete });
  assert.deepEqual(journey.previewRequest(journey.withBudget(s, '')), { ok: false, reason: CREATE.amount.empty });
});

test('the creation gate is off, from the build’s signing flag, with its reason', () => {
  const gate = journey.createGate();
  assert.equal(gate.enabled, false);
  assert.equal(gate.reason, 'Deposits are made in Setup, one reviewed wallet step at a time.');
  assert.match(gate.detail, /Signing stays in Setup/);
});

test('the successor geometry follows the agreed rule on the pool’s spacing, or says it is infeasible', () => {
  const limits = { trigger: 5, overlap: 20, cap: 3 };
  assert.deepEqual(journey.successorGeometry({ lower: -3600, upper: 0 }, limits, 60), { triggerTick: -513, floorMinTick: -2220, ceilingTick: 4080 });
  // Ceiling 50% above the upper bound, rounded up to the spacing; the floor's lowest tick rounded up, never below the overlap bound.
  assert.deepEqual(journey.successorGeometry({ lower: 0, upper: 6000 }, { trigger: 5, overlap: 5, cap: 3 }, 10), { triggerTick: 5487, floorMinTick: 5490, ceilingTick: 10060 });
  assert.equal(journey.successorGeometry({ lower: 887100, upper: 887220 }, { trigger: 5, overlap: 0, cap: 3 }, 60), null, 'at the top of the tick space the floor cannot sit below a ceiling');
});

test('the wallet steps describe approve and mint in order, native ETH without an approval, automation as not enabled', () => {
  const erc20 = journey.walletSteps(ready());
  assert.deepEqual(erc20.map((step) => step.title), [
    'Approve the selected token for the position manager',
    'Approve the other token, if the composition needs it',
    'Mint the position NFT to your wallet',
  ]);
  assert.equal(erc20[0].token.address, addr('1'));
  assert.equal(erc20[1].token.address, addr('2'));
  const native = journey.withToken(journey.withPool(journey.initialState(), pool({ currencies: [token(ZERO, 18, 'ETH'), token(addr('2'), 6, 'USDG')] }), NOW), candidate(ZERO, 18));
  assert.equal(journey.walletSteps(native)[0].title, 'Send native ETH with the mint');
  const automated = journey.withAutomation(ready(), 'domino');
  assert.equal(journey.walletSteps(automated).at(-1).title, 'Grant Domino its fee-only permission');
  // The step says what the permission is; that automation is not connected is the summary's `· not connected` (below) and CREATE.automation.notEnabled.
  assert.equal(journey.walletSteps(automated).at(-1).detail, 'A separate permission over earned fees only, revocable by you.');
  assert.deepEqual(journey.walletSteps(journey.initialState()), []);
});

test('the fee bases stay apart: the pool’s LP fee and Domino’s 2% of consumed earned fees', () => {
  const bases = journey.feeBases(ready());
  assert.deepEqual(bases.map((fee) => fee.label), ['Pool trading fee', 'Domino service fee', 'Assisted swap fee', 'Network gas']);
  assert.equal(bases[0].value, '0.30%');
  assert.equal(bases[1].value, '2% of earned fees consumed');
  assert.match(bases[1].note, /Never on principal/);
  assert.match(bases[2].value, /0\.65%/);
  assert.equal(journey.feeBases(journey.initialState())[0].value, '—');
});

test('the summary says — for what is not chosen and serialises every decision, the gate included', () => {
  const empty = journey.summaryLines(journey.initialState(), NOW);
  assert.deepEqual(empty.map((line) => line.value), ['—', '—', '—', '—', '—', '—']);
  assert.deepEqual(empty.map((line) => line.done), [false, false, false, false, false, false]);
  let s = journey.withAutomation(journey.next(journey.next(ready(), NOW), NOW), 'domino');
  s = journey.next(s, NOW);
  const lines = journey.summaryLines(s, NOW);
  assert.equal(lines[0].value, `ONE · ${addr('1').slice(0, 6)}…${addr('1').slice(-4)}`);
  assert.equal(lines[1].value, `ONE/TWO · 0.30% · ${id('a').slice(0, 6)}…${id('a').slice(-4)}`);
  // currency1 per currency0 with the read decimals (18 and 6): 1.0001^tick × 10^12, as the range controls write it.
  assert.equal(lines[2].value, '0.5 ONE · ≈697,689,000,000 to ≈1,503,780,000,000 (ticks -3600 to 4080)');
  assert.equal(lines[3].value, CREATE.balance.notEnabled);
  assert.equal(lines[4].value, 'Domino · trigger 5%, overlap 20%, cap 3 · not connected');
  assert.equal(lines[5].value, CREATE.review.gate);
  assert.equal(journey.positionText(s, NOW), CREATE.review.inRange);
  assert.equal(journey.positionText({ ...s, range: { lower: 60, upper: 120 } }, NOW), CREATE.review.outOfRange);
  assert.match(journey.positionText(s, 300_000), /read more than 5 minutes ago/);
  const text = journey.serialiseSummary(s, NOW);
  assert.ok(text.some((line) => line.startsWith('Request: {"chainId":4663')));
  assert.ok(text.includes('Deposit amounts: Exact amounts are calculated in Setup, at the price when you sign.'));
  assert.ok(text.includes('Wallet step 1: Approve the selected token for the position manager'));
  assert.ok(text.includes('Pool trading fee: 0.30%'));
  assert.ok(text.includes('Domino service fee: 2% of earned fees consumed'));
  assert.equal(text.at(-1), 'Create position: disabled — Deposits are made in Setup, one reviewed wallet step at a time.');
});

test('a verified pool’s two currencies become candidates, by address, with the read’s decimals and status', () => {
  const [one, two] = journey.candidatesFromPool(pool({ currencies: [token(ZERO, 18, 'ETH'), token(addr('2'), null, null)] }));
  assert.equal(one.key, ZERO);
  assert.equal(one.kind, 'native');
  assert.equal(one.why, null);
  assert.equal(one.decimalsUnavailable, false);
  assert.equal(one.block, 700);
  assert.equal(two.key, addr('2'));
  assert.equal(two.kind, 'erc20_candidate');
  assert.equal(two.decimalsUnavailable, true, 'partial metadata: selectable, decimals unavailable');
  const [, gone] = journey.candidatesFromPool(pool({ currencies: [token(addr('1')), { ...token(addr('2')), readStatus: 'no_contract' }] }));
  assert.equal(gone.why, 'no_contract');
  assert.equal(gone.kind, 'unknown');
  assert.equal(journey.poolHolds(pool(), addr('1')), true);
  assert.equal(journey.poolHolds(pool(), addr('9')), false);
  assert.equal(journey.otherCurrency(pool(), addr('1')).address, addr('2'));
  assert.equal(journey.otherCurrency(pool(), addr('9')), null);
});

test('the pool id in the link is untrusted: exactly a pool id or nothing, verified against USDG', () => {
  assert.deepEqual(journey.preselectFrom(''), { ok: false, reason: 'empty' });
  for (const bad of ['abc', id('a').slice(0, 65), `${id('a')}0`, id('a').toUpperCase().replace('0X', '0x ') , 'javascript:alert(1)']) assert.deepEqual(journey.preselectFrom(bad), { ok: false, reason: 'malformed' }, bad);
  const upper = journey.preselectFrom(`0x${'AB'.repeat(32)}`);
  assert.equal(upper.ok, true);
  assert.equal(upper.key, `0x${'ab'.repeat(32)}`);
  assert.equal(upper.catalogue, null);
  assert.equal(journey.verificationToken(upper), journey.USDG);
  const featured = journey.preselectFrom(SELECTED_POOL_CATALOGUE[0].poolId);
  assert.equal(featured.catalogue.poolId, SELECTED_POOL_CATALOGUE[0].poolId);
  assert.equal(journey.verificationToken(featured), journey.USDG);
  const withAddresses = SELECTED_POOL_CATALOGUE.find((entry) => entry.addresses);
  assert.equal(journey.verificationToken(journey.preselectFrom(withAddresses.poolId)), withAddresses.addresses[1]);
  assert.equal(journey.USDG, '0x5fc5360d0400a0fd4f2af552add042d716f1d168');
});

test('the copy never promises, never names a sample or a fixture, and never links anywhere', () => {
  const strings = allCreateStrings();
  assert.ok(strings.length > 80);
  for (const text of strings) {
    assert.doesNotMatch(text, /sample|practice|\bMEME\b|Example token|Fixture data/i, text);
    assert.doesNotMatch(text, /https?:\/\//, text);
    assert.doesNotMatch(text, /guarantee|risk-free|will earn/i, text);
  }
  assert.match(CREATE.balance.notEnabled, /calculated in Setup/);
  assert.match(CREATE.automation.notEnabled, /^Not connected$/);
});
