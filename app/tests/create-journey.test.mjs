/**
 * The new-position journey's pure state machine (src/lib/create/journey.ts):
 * stages, what each needs before Continue, the transitions, the validation of
 * budget, range and Domino limits, the preview request it would send, the
 * creation gate, and the summary. No React and no reads are involved: the
 * inputs are shaped exactly like the values the read screens hand over.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const journey = require('../.test-build/app/src/lib/create/journey.js');
const { CREATE, allCreateStrings } = require('../.test-build/app/src/lib/create/copy.js');
const slippage = require('../.test-build/app/src/lib/create/slippage.js');
const { SELECTED_POOL_CATALOGUE } = require('../.test-build/app/src/config/selectedPoolCatalogue.js');
// Compiled by tsconfig.consumer-test.json, next to the journey.
const setupDrafts = require('../.test-build/app/src/lib/create/setupDraft.js');

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

test('the amount step shows amounts, never the integers underneath them', () => {
  assert.equal(CREATE.amount.budgetHint(6), 'Up to 6 decimal places.');
  assert.equal(CREATE.amount.budgetHint(null), 'Decimals for this token could not be read.');
  // Raw units are what the request carries, not something to read on screen: the
  // line that printed them was debugging left in the product.
  const amount = readFileSync(new URL('../src/components/create/StageAmount.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(amount, /data-budget-raw|rawUnits/);
  assert.equal(CREATE.amount.rawUnits, undefined);
  assert.equal(CREATE.amount.rawUnitsTitle, undefined);
});

test('slippage is a whole number of basis points from 0 to 9999', () => {
  const v = journey.validateSlippage;
  assert.deepEqual(v('50'), { ok: true, bps: 50 });
  assert.deepEqual(v('0'), { ok: true, bps: 0 });
  assert.deepEqual(v('9999'), { ok: true, bps: 9999 });
  for (const text of ['', '10000', '-1', '1.5', '050', 'abc']) assert.deepEqual(v(text), { ok: false, reason: CREATE.amount.slippageInvalid }, text);
});

test('the slippage track runs 0.1% to 5%, every hundredth of a percent to 1% and every twentieth above it', () => {
  const steps = slippage.SLIPPAGE_STEPS;
  assert.equal(steps[0], 10);
  assert.equal(steps[steps.length - 1], 500);
  for (let i = 1; i < steps.length; i += 1) assert.ok(steps[i] > steps[i - 1], `position ${i} moves to a different value`);
  for (const mark of slippage.SLIPPAGE_MARKS) assert.ok(steps.includes(mark), `${mark} is on the track`);
  assert.deepEqual([10, 11, 99, 100, 105].map((bps) => steps.includes(bps)), [true, true, true, true, true]);
  assert.equal(steps.includes(101), false, 'above 1% the steps are twentieths of a percent');
  // The marks share the half of the track nearest the left, where the tolerances people choose between are.
  assert.deepEqual(slippage.SLIPPAGE_MARKS.map(slippage.slippageIndex), [0, 40, 90]);
  assert.equal(slippage.slippageIndex(500), steps.length - 1);
  assert.equal(slippage.slippageIndex(137), slippage.slippageIndex(135), 'a value between two steps sits on the nearer one');
});

test('slippage is written as a percentage, and kept as the basis points behind it', () => {
  assert.equal(slippage.slippageWritten(50), '0.5%');
  assert.equal(slippage.slippageWritten(37), '0.37%');
  assert.equal(slippage.slippageWritten(10), '0.1%');
  assert.equal(slippage.slippageWritten(500), '5%');
  assert.equal(slippage.slippagePercent(50), '0.5');
  assert.equal(slippage.slippageValue('50'), 50);
  assert.equal(slippage.slippageValue('9999'), 500, 'the track cannot draw more than its end');
  assert.equal(slippage.slippageValue('0'), 10);
  assert.equal(slippage.slippageValue('abc'), 10);
});

test('an exact percentage typed beside the slider becomes whole basis points, or nothing', () => {
  const v = slippage.slippageFromPercent;
  assert.equal(v('0.37'), 37);
  assert.equal(v('0.1'), 10);
  assert.equal(v('0.10'), 10);
  assert.equal(v('1'), 100);
  assert.equal(v('5'), 500);
  assert.equal(v('5.00'), 500);
  // A third decimal place is not a whole basis point, and the ends are the ends.
  for (const text of ['0.375', '0.09', '5.01', '6', '', '.5', '00.5', '-1', '1,5', 'abc']) assert.equal(v(text), null, text);
});

test('the thumb settles on a mark only when it is let go beside one', () => {
  const v = slippage.slippageMark;
  assert.equal(v(47), 50);
  assert.equal(v(54), 50);
  assert.equal(v(55), null, 'further than 0.04% away, what was dragged is what is kept');
  assert.equal(v(50), null, 'already on the mark');
  assert.equal(v(12), 10);
  assert.equal(v(98), 100);
  assert.equal(v(300), null);
});

test('the amount step chooses slippage by dragging, in percent, not in a disclosure', () => {
  const stage = readFileSync(new URL('../src/components/create/StageAmount.tsx', import.meta.url), 'utf8');
  const slider = readFileSync(new URL('../src/components/create/SlippageSlider.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(stage, /<details|dm-flow-disclosure/, 'the slider is on the step, not behind a disclosure');
  assert.match(stage, /<SlippageSlider/);
  assert.match(slider, /type="range"/, 'a real range input: the keyboard, touch and assistive technology all work');
  assert.match(slider, /aria-valuetext/, 'the position says nothing out loud, so the percentage does');
  // The strings the disclosure and the basis-point field used are gone with them.
  assert.equal(CREATE.amount.advanced, undefined);
  assert.equal(CREATE.amount.slippageValue, undefined);
  assert.equal(CREATE.amount.slippageLabel, 'Slippage tolerance');
  assert.match(CREATE.amount.slippageExactInvalid, /^Enter a percentage from 0.1 to 5/);
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

test('Domino limits are checked one by one, each with its own words, within the contract’s bounds', () => {
  const v = journey.validateLimits;
  const ok = v(journey.DEFAULT_LIMITS);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.values, { trigger: 5, overlap: 20, cap: 3 });
  assert.deepEqual(ok.problems, { triggerPercent: null, maxOverlapPercent: null, sequenceCap: null });
  // PolicyValidation.sol: trigger distance and maximum overlap 0 to 2000 bps each, 0 included; 1 to 255 positions counting the root.
  assert.deepEqual(journey.LIMIT_BOUNDS, { trigger: { min: 0, max: 20 }, overlap: { min: 0, max: 20 }, cap: { min: 1, max: 255 } });
  assert.deepEqual(v({ triggerPercent: '2.5', maxOverlapPercent: '0', sequenceCap: '1' }).values, { trigger: 2.5, overlap: 0, cap: 1 });
  assert.deepEqual(v({ triggerPercent: '0', maxOverlapPercent: '0', sequenceCap: '1' }).values, { trigger: 0, overlap: 0, cap: 1 }, 'a 0 bps trigger is valid on chain: the price must reach the ceiling');
  assert.deepEqual(v({ triggerPercent: '0.01', maxOverlapPercent: '19.99', sequenceCap: '254' }).values, { trigger: 0.01, overlap: 19.99, cap: 254 }, 'two decimal places of a percent are whole basis points');
  assert.deepEqual(v({ triggerPercent: '20', maxOverlapPercent: '20', sequenceCap: '255' }).values, { trigger: 20, overlap: 20, cap: 255 });
  const bad = v({ triggerPercent: '20.01', maxOverlapPercent: '21', sequenceCap: '256' });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.problems, { triggerPercent: CREATE.automation.triggerInvalid, maxOverlapPercent: CREATE.automation.overlapInvalid, sequenceCap: CREATE.automation.capInvalid });
  for (const cap of ['0', '1.5', '', '-1', '03', '256', '1000']) assert.equal(v({ ...journey.DEFAULT_LIMITS, sequenceCap: cap }).problems.sequenceCap, CREATE.automation.capInvalid, cap);
  for (const trigger of ['', '5.123', '-5', '5%', '20.01', '50']) assert.equal(v({ ...journey.DEFAULT_LIMITS, triggerPercent: trigger }).problems.triggerPercent, CREATE.automation.triggerInvalid, trigger);
  for (const overlap of ['', '0.001', '-1', '20.5', '50']) assert.equal(v({ ...journey.DEFAULT_LIMITS, maxOverlapPercent: overlap }).problems.maxOverlapPercent, CREATE.automation.overlapInvalid, overlap);
  // The hints and the invalid messages name the same bounds the validator enforces.
  const { trigger, overlap, cap } = journey.LIMIT_BOUNDS;
  assert.ok(CREATE.automation.triggerHint.startsWith(`${trigger.min} to ${trigger.max}.`));
  assert.ok(CREATE.automation.overlapHint.startsWith(`${overlap.min} to ${overlap.max}.`));
  assert.ok(CREATE.automation.capHint.startsWith(`${cap.min} to ${cap.max},`));
  assert.match(CREATE.automation.triggerInvalid, new RegExp(`from ${trigger.min} to ${trigger.max},`));
  assert.match(CREATE.automation.overlapInvalid, new RegExp(`from ${overlap.min} to ${overlap.max},`));
  assert.match(CREATE.automation.capInvalid, new RegExp(`from ${cap.min} to ${cap.max}\\.$`));
});

test('the journey walks forward only through complete stages, back freely, and the rail reopens what was reached', () => {
  let s = ready();
  assert.equal(journey.reachable(s, NOW), 'review', 'nothing after the amount blocks: the deposit amounts wait for nothing and automation defaults to none');
  assert.equal(journey.canOpen('balance', s, NOW), false, 'not reached yet');
  s = journey.next(s, NOW);
  assert.equal(s.stage, 'balance');
  assert.deepEqual(journey.canContinue('balance', s, NOW), { ok: true }, 'the person may continue whether or not an estimate of the amounts is shown');
  s = journey.next(s, NOW);
  assert.equal(s.stage, 'automation');
  s = journey.withAutomation(s, 'domino');
  const broken = journey.withLimits(s, { sequenceCap: '256' });
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

test('the wallet’s balance of each currency goes with the request: a position holds both, and only the service can say the wallet is short of one', () => {
  const s = ready();
  const withBoth = journey.previewRequest(s, { budget0Raw: '7', budget1Raw: '9', nativeBalanceRaw: '7' });
  assert.equal(withBoth.ok, true);
  assert.equal(withBoth.request.budget0Raw, '7');
  assert.equal(withBoth.request.budget1Raw, '9');
  assert.equal(withBoth.request.nativeBalanceRaw, '7');
  // A budget adds fields and changes no choice.
  const { budget0Raw, budget1Raw, nativeBalanceRaw, ...choices } = withBoth.request;
  assert.deepEqual(choices, journey.previewRequest(s).request);
  // One currency read and the other not: one field, never a zero standing in for the one that was not read.
  assert.deepEqual(
    Object.keys(journey.previewRequest(s, { budget1Raw: '9' }).request).filter((key) => key.startsWith('budget')),
    ['budget1Raw'],
  );
  // Nothing read at all is exactly the request that existed before budgets.
  assert.deepEqual(journey.previewRequest(s, {}).request, journey.previewRequest(s).request);
  // A budget never rescues a request the service would not admit.
  assert.deepEqual(journey.previewRequest({ ...s, pool: pool({ hooks: addr('f') }) }, { budget0Raw: '7' }), { ok: false, reason: CREATE.balance.hooks });
});

test('Setup’s draft starts from the same validated choices as the preview request: pool, deposit token, amount, range and slippage, and nothing else (G9)', () => {
  const s = ready();
  const draft = journey.setupDraft(s);
  assert.equal(draft.pool, s.pool, 'the verified pool itself');
  assert.deepEqual({ ...draft, pool: undefined }, { pool: undefined, independent: 0, amountRaw: '500000000000000000', tickLower: -3600, tickUpper: 4080, slippageBps: 50 });
  assert.deepEqual(Object.keys(draft).sort(), ['amountRaw', 'independent', 'pool', 'slippageBps', 'tickLower', 'tickUpper'], 'no budgets or network limits are carried: Setup asks for them');
  // The pool's other currency as the deposit token: its index and its own decimals.
  const two = journey.setupDraft(journey.withBudget(journey.withToken(s, TWO), '1'));
  assert.deepEqual([two.independent, two.amountRaw], [1, '1000000']);
  // What the deposit service does not admit is never carried.
  assert.equal(journey.setupDraft({ ...s, pool: pool({ hooks: addr('f') }) }), null);
  assert.equal(journey.setupDraft({ ...s, pool: pool({ feePips: 8388608, fee: 'Dynamic' }) }), null);
  assert.equal(journey.setupDraft(journey.withBudget(s, '')), null);
  assert.equal(journey.setupDraft(journey.initialState()), null);
});

test('the line under Continue in Setup promises a filled-in Setup only for choices there is a draft to carry, and the link loading in its place promises nothing (G9)', () => {
  const s = ready();
  assert.equal(journey.continueNote(s, true), CREATE.review.setupNote);
  assert.equal(journey.continueNote(s, false), CREATE.review.setupNoteSignedOut);
  for (const other of [pool({ hooks: addr('f') }), pool({ feePips: 8388608, fee: 'Dynamic' })]) {
    const state = { ...s, pool: other };
    assert.equal(journey.setupDraft(state), null, 'Setup’s deposits take neither pool, so nothing is carried');
    for (const signedIn of [true, false]) assert.equal(journey.continueNote(state, signedIn), CREATE.review.setupNoteUnsupported);
  }
  assert.equal(journey.continueNote(journey.withBudget(s, ''), true), CREATE.review.gate, 'no draft for any other reason: the neutral line');
  for (const neutral of [CREATE.review.setupNoteUnsupported, CREATE.review.gate]) assert.doesNotMatch(neutral, /filled in|carr|opens with/i, neutral);
  // While the chunk with the carrying link loads, a plain link stands in for it, carrying nothing: its line is the neutral one.
  const review = readFileSync(new URL('../src/components/create/StageReview.tsx', import.meta.url), 'utf8');
  assert.match(review, /<Suspense fallback=\{<SetupLink note=\{CREATE\.review\.gate\} \/>\}>/);
  assert.doesNotMatch(review, /note=\{CREATE\.review\.setupNote(SignedOut)?\}/, 'the promise is made only where the link carries the choices');
});

// Changed on purpose (owner, 2026-09-19): the Review opened with a green dot
// beside "the pool price is inside this range" — the ordinary case, stated as
// if it were news. The range step had already been reduced the same way: the
// sentence is shown only when the range does NOT hold the price, because that
// position earns no fees until the price moves into it. Nothing green is left
// in the flow.
test('the Review states its range position only when the range misses the price, and never in green', () => {
  const review = readFileSync(new URL('../src/components/create/StageReview.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/styles/flow.css', import.meta.url), 'utf8');
  assert.match(review, /inside === false && usable && \(/, 'the visible line is the out-of-range case only');
  assert.match(review, /inside === true && usable && <span className="sr-only"/, 'the ordinary case is still said to a screen reader');
  assert.doesNotMatch(review, /data-tone=\{inside/, 'no tone is chosen from the position any more');
  assert.doesNotMatch(review, /CREATE\.review\.inRange\s*:/, 'the in-range sentence is never the visible branch');
  assert.doesNotMatch(css, /dm-flow-position\[data-tone="in"\]/, 'the green dot rule is gone, not merely unused');
  assert.doesNotMatch(css, /dm-flow-position[^;]*--money-in/, 'nothing in the line takes the in-the-money colour');
});

// Changed on purpose (owner, 2026-09-19): the Review said the fee twice --
// PoolPair ends in it and a chip repeated it -- and said "Exact amounts are
// calculated in Setup" both above and below the four dashes, which read as two
// different remarks rather than one explanation.
test('the Review says the fee once, and explains the empty deposit rows once', () => {
  const review = readFileSync(new URL('../src/components/create/StageReview.tsx', import.meta.url), 'utf8');
  const balance = readFileSync(new URL('../src/components/create/StageBalance.tsx', import.meta.url), 'utf8');
  assert.match(review, /<PoolPair option=\{pool\} \/>/, 'the pair still carries the fee');
  assert.doesNotMatch(review, /data-fee=/, 'no chip repeats it');
  assert.match(balance, /\{figures && <p className="dm-hint">\{CREATE\.balance\.notEnabled\}<\/p>\}/,
    'the trailing hint appears only under rows that carry numbers');
  // Without figures the section already opens with the same sentence, so the
  // explanation is still on screen exactly once.
  assert.equal(CREATE.balance.titles.off, CREATE.balance.notEnabled);
  assert.match(balance, /data-balance-waiting=\{shown\.status\}>\s*\{shown\.title\}/, 'that opening line is still rendered');
});

test('a pool picked on Setup keeps the carried choices only when it is the pool they were carried for (G9)', () => {
  const draft = journey.setupDraft(ready());
  assert.equal(setupDrafts.carriedFor(draft, null), draft, 'nothing picked yet');
  assert.equal(setupDrafts.carriedFor(draft, { ...pool() }), draft, 'the same pool, read again');
  assert.equal(setupDrafts.carriedFor(draft, pool({ key: id('b') })), null, 'another pool: its token order, amount and ticks would mean something else');
  assert.equal(setupDrafts.carriedFor(null, pool({ key: id('b') })), null);
});

test('carried choices live in memory for the session they were carried under: another session drops them, no session sees nothing (G9)', () => {
  const draft = journey.setupDraft(ready());
  setupDrafts.clearSetupDraft();
  assert.equal(setupDrafts.setupDraftFor('1|uid|0xa'), null, 'nothing carried');
  setupDrafts.putSetupDraft(draft, '1|uid|0xa');
  assert.equal(setupDrafts.setupDraftFor(null), null, 'a page with no session sees nothing');
  assert.equal(setupDrafts.setupDraftFor('1|uid|0xa'), draft, 'the session it was carried under reads it, as often as it renders');
  assert.equal(setupDrafts.setupDraftFor('1|uid|0xa'), draft);
  assert.equal(setupDrafts.setupDraftFor('2|uid|0xa'), null, 'another session never sees it');
  assert.equal(setupDrafts.setupDraftFor('1|uid|0xa'), null, 'and it is gone for good once another session asked');
  setupDrafts.putSetupDraft(draft, '1|uid|0xa');
  setupDrafts.clearSetupDraft();
  assert.equal(setupDrafts.setupDraftFor('1|uid|0xa'), null);
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
  // A 0% trigger waits for the ceiling itself; 20% is the contract's largest overlap.
  assert.deepEqual(journey.successorGeometry({ lower: -3600, upper: 0 }, { trigger: 0, overlap: 20, cap: 255 }, 60), { triggerTick: 0, floorMinTick: -2220, ceilingTick: 4080 });
  // The ceiling is drawn at the default upside; on chain the upside is the sequence's own setting, and the rule says so.
  assert.equal(journey.DEFAULT_UPSIDE_PERCENT, 50);
  // Your sequences asks for the upside with no default; New position only draws its illustration at 50% (docs: automation, Upside).
  assert.ok(CREATE.automation.dominoRules.some((rule) => /ceiling sits above the previous ceiling by the upside you set for the sequence, .*drawn at 50%/.test(rule)));
  assert.ok(CREATE.automation.dominoRules.every((rule) => !/50% by default/.test(rule)), 'no default the sequence screen does not have');
  assert.ok(CREATE.automation.dominoRules.every((rule) => !/ceiling is 50% above/.test(rule)), 'no fixed 50% ceiling');
  assert.match(CREATE.automation.nextRangeNote, /drawn at a 50% upside/);
});

test('the wallet steps are the real ones, in order: each ERC-20 through Permit2, native ETH with the mint and no approval, automation as three owner transactions', () => {
  const erc20 = journey.walletSteps(ready());
  // docs/DIRECT_DEPOSITS.md: an exact approval to Permit2, then a Permit2 allowance for the position manager, currency by currency in pool order, then the mint.
  assert.deepEqual(erc20.map((step) => step.title), [
    'Approve the selected token to Permit2',
    'Allow the position manager to use the selected token through Permit2',
    'Approve the other token to Permit2, if the composition needs it',
    'Allow the position manager to use the other token through Permit2, if the composition needs it',
    'Mint the position NFT to your wallet',
  ]);
  assert.deepEqual(erc20.map((step) => step.token?.address), [addr('1'), addr('1'), addr('2'), addr('2'), undefined]);
  assert.match(erc20[0].detail, /never unlimited/);
  assert.match(erc20[1].detail, /within an hour/);
  // The deposit service prepares currency0 before currency1, whichever of them is deposited.
  const second = journey.walletSteps(journey.withToken(ready(), TWO));
  assert.deepEqual(second.map((step) => step.token?.address), [addr('1'), addr('1'), addr('2'), addr('2'), undefined]);
  assert.equal(second[0].title, 'Approve the other token to Permit2, if the composition needs it');
  assert.equal(second[2].title, 'Approve the selected token to Permit2');
  // Native ETH needs no approval: only the other token goes through Permit2, and the ETH goes with the mint.
  const ethPool = pool({ currencies: [token(ZERO, 18, 'ETH'), token(addr('2'), 6, 'USDG')] });
  const native = journey.walletSteps(journey.withToken(journey.withPool(journey.initialState(), ethPool, NOW), candidate(ZERO, 18)));
  assert.deepEqual(native.map((step) => step.title), [
    'Approve the other token to Permit2, if the composition needs it',
    'Allow the position manager to use the other token through Permit2, if the composition needs it',
    'Mint the position NFT to your wallet',
  ]);
  assert.equal(native[2].token.address, ZERO);
  assert.match(native[2].detail, /Native ETH needs no approval/);
  const nativeOther = journey.walletSteps(journey.withToken(journey.withPool(journey.initialState(), ethPool, NOW), TWO));
  assert.deepEqual(nativeOther.map((step) => step.title), ['Approve the selected token to Permit2', 'Allow the position manager to use the selected token through Permit2', 'Mint the position NFT to your wallet']);
  assert.match(nativeOther[2].detail, /Native ETH needs no approval: if the composition needs it/);
  assert.ok(!native.concat(nativeOther).some((step) => /Approve|Allow/.test(step.title) && step.token?.address === ZERO), 'no approval step names native ETH');
  // finance/sequence.ts: approve only this NFT to its predicted sequence, create the sequence paused, activate it in a separate owner transaction.
  const automated = journey.walletSteps(journey.withAutomation(ready(), 'domino'));
  assert.deepEqual(automated.slice(5).map((step) => step.title), ['Approve this position NFT to its sequence', 'Create the sequence, paused', 'Activate Domino-compound']);
  assert.match(automated[5].detail, /never approval for all NFTs/);
  assert.match(automated[6].detail, /starts paused/);
  // That automation is not connected is the summary's `· not connected` (below) and CREATE.automation.notEnabled, not the step's words.
  assert.equal(automated.at(-1).detail, 'A separate owner transaction, when you choose. Nothing runs before it, and you can pause or revoke it from your wallet.');
  assert.equal(journey.walletSteps(journey.withAutomation(ready(), 'compound')).at(-1).title, 'Activate Auto-compound');
  assert.equal(new Set(automated.map((step) => step.title)).size, automated.length, 'every title is its own list key');
  assert.deepEqual(journey.walletSteps(journey.initialState()), []);
  assert.deepEqual(journey.walletSteps({ ...ready(), pool: pool({ currencies: [token(addr('8')), token(addr('9'))] }) }), [], 'no steps for a pool that does not hold the token');
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
  assert.equal(lines[4].value, 'Domino-compound · trigger 5%, overlap 20%, cap 3 · not connected');
  assert.equal(lines[5].value, CREATE.review.gate);
  assert.equal(journey.positionText(s, NOW), CREATE.review.inRange);
  assert.equal(journey.positionText({ ...s, range: { lower: 60, upper: 120 } }, NOW), CREATE.review.outOfRange);
  assert.match(journey.positionText(s, 300_000), /read more than 5 minutes ago/);
  const text = journey.serialiseSummary(s, NOW);
  // The request is sent for the deposit amounts in wallet builds, never printed: no JSON dump in the summary (G8).
  assert.ok(!text.some((line) => line.startsWith('Request:') || line.includes('"chainId"')), 'no request JSON in the summary');
  assert.ok(text.includes('Deposit amounts: Exact amounts are calculated in Setup, at the price when you sign.'));
  assert.ok(text.includes('Wallet step 1: Approve the selected token to Permit2'));
  assert.ok(text.includes('Wallet step 2: Allow the position manager to use the selected token through Permit2'));
  assert.ok(text.includes('Wallet step 8: Activate Domino-compound'));
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

test('the automation choices carry the approved names, and the service fee keeps the company’s name', () => {
  const { options } = CREATE.automation;
  assert.deepEqual([options.none.title, options.compound.title, options.domino.title], ['Self-managing', 'Auto-compound', 'Domino-compound']);
  assert.equal(CREATE.automation.none, 'Self-managing', 'the summary line says what the step row says');
  assert.equal(CREATE.automation.domino, 'Domino-compound');
  assert.equal(CREATE.automation.dominoRulesHeading, 'How Domino-compound works');
  assert.equal(CREATE.review.automationStepNames.domino, 'Domino-compound');
  assert.match(CREATE.review.feeNotes.service, /Auto-compound or Domino-compound consumes earned fees/);
  assert.equal(CREATE.review.feeLabels.service, 'Domino service fee', 'the fee label names the company, not the product');
  // "sequence" stays where it names the vault or its cap.
  assert.equal(CREATE.automation.cap, 'Positions in the sequence');
  for (const text of allCreateStrings()) assert.doesNotMatch(text, /Domino sequence|No automation|^None$/, text);
});
