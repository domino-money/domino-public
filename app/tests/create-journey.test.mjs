/**
 * The new-position journey's pure state machine (src/lib/create/journey.ts):
 * stages, what each needs before Continue, the transitions, the validation of
 * budget and range, the preview request it would send, the creation gate, and
 * the summary. The journey creates a plain Uniswap position and asks nothing
 * about automation; the Domino limits, their validation and the successor
 * geometry are tested here as the pure helpers Automate reuses. No React and
 * no reads are involved: the inputs are shaped exactly like the values the
 * read screens hand over.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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

test('the five stages, in order, and where the journey starts', () => {
  assert.deepEqual(journey.STAGES, ['token', 'pool', 'amount', 'balance', 'review']);
  const s = journey.initialState();
  assert.equal(s.stage, 'token');
  assert.equal(s.furthest, 'token');
  // The fields Automate starts from, at their defaults; no stage of this journey sets them.
  assert.equal(s.automation, 'none');
  assert.deepEqual(s.limits, { triggerPercent: '5', maxOverlapPercent: '20', sequenceCap: '3' });
  assert.equal(s.slippageBps, '50');
});

// The product's first function is a plain Uniswap position: pair, amount,
// range. Auto-compound and Domino-compound are applied afterwards, from
// Automate, to a position that exists (the owner, 2026-09-22). The stage that
// asked went; the pure helpers Automate reuses stayed.
test('no stage asks about automation: the fields stay at their defaults, Automate’s helpers still set them, and nothing of them reaches the review', () => {
  assert.equal(journey.STAGES.includes('automation'), false);
  const reviewed = journey.next(journey.next(ready(), NOW), NOW);
  assert.equal(reviewed.stage, 'review');
  assert.equal(reviewed.automation, 'none');
  assert.deepEqual(reviewed.limits, journey.DEFAULT_LIMITS);
  // withAutomation and withLimits set their field and change nothing else.
  const domino = journey.withAutomation(ready(), 'domino');
  assert.equal(domino.automation, 'domino');
  assert.deepEqual({ ...domino, automation: 'none' }, ready());
  const limited = journey.withLimits(domino, { sequenceCap: '256' });
  assert.deepEqual(limited.limits, { ...journey.DEFAULT_LIMITS, sequenceCap: '256' });
  assert.deepEqual({ ...limited, limits: journey.DEFAULT_LIMITS }, domino);
  // Neither field gates a stage: a chosen mode with broken limits walks to Review exactly as the defaults do.
  assert.equal(journey.reachable(limited, NOW), 'review');
  assert.equal(journey.next(journey.next(limited, NOW), NOW).stage, 'review');
  // And the review says nothing of them: no summary line, no wallet step, no fee row.
  assert.deepEqual(journey.summaryLines(limited, NOW).map((line) => line.stage), ['token', 'pool', 'amount', 'balance', 'review']);
  assert.deepEqual(journey.walletSteps(limited), journey.walletSteps(ready()));
  assert.deepEqual(journey.feeBases(limited), journey.feeBases(ready()));
  for (const line of journey.serialiseSummary(journey.next(journey.next(limited, NOW), NOW), NOW)) assert.doesNotMatch(line, /automation|compound|service fee|sequence|limits/i, line);
  // The stage's component is gone, and the flow's components read none of the fields.
  assert.equal(existsSync(new URL('../src/components/create/StageAutomation.tsx', import.meta.url)), false);
  // StageBalance went with Review's deposit amounts (owner, 2026-09-22); Create position is read in its place.
  assert.equal(existsSync(new URL('../src/components/create/StageBalance.tsx', import.meta.url)), false);
  for (const name of ['Journey', 'StageReview', 'StepList', 'CreatePosition', 'StageAmount', 'StageToken']) {
    const source = readFileSync(new URL(`../src/components/create/${name}.tsx`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /StageAutomation|automationPill|AutomationSummary|state\.automation|state\.limits|withAutomation|withLimits|validateLimits|successorGeometry|serviceFee/, name);
  }
  const rail = readFileSync(new URL('../src/components/create/StepList.tsx', import.meta.url), 'utf8');
  assert.match(rail, /VISUAL_STEPS: readonly VisualStep\[\] = \['pool', 'range', 'amount', 'review'\]/, 'four steps on the rail');
  // The page says how many steps there are, and no step or stage is named Automation.
  assert.match(CREATE.page.description, /^Four steps\./);
  assert.equal(CREATE.step.automation, undefined);
  assert.equal(CREATE.stage.automation, undefined);
  assert.deepEqual(Object.keys(CREATE.step), ['pool', 'range', 'amount', 'review']);
  assert.deepEqual(Object.keys(CREATE.stage), journey.STAGES);
  // Review's own automation copy went with the section that showed it; Automate keeps the fee's value.
  for (const key of ['serviceFee', 'serviceFeeNote', 'automationApproveStep', 'automationCreateStep', 'automationActivateStep', 'automationStepNames']) assert.equal(CREATE.review[key], undefined, key);
  assert.equal(CREATE.review.serviceFeeValue('domino'), '4% of earned fees consumed', 'screens/Automate.tsx states it');
  assert.doesNotMatch(CREATE.review.stepsNote, /automation|Automate/i, 'the wallet steps are the deposit’s alone');
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
  // Create position opens positions through Domino V1's setup contract, which takes hookless, fixed-fee pools only:
  // any other pool is refused here, at the pool step, with its own sentence, not with a disabled button at Review.
  const hooked = journey.withPool(s, pool({ key: id('d'), hooks: addr('f'), integration: 'requires_separate_adapter' }), NOW);
  assert.deepEqual(journey.canContinue('pool', hooked, NOW), { ok: false, reason: CREATE.pool.unsupportedHooks });
  assert.match(CREATE.pool.unsupportedHooks, /^This pool has hooks, .*Choose another pool\.$/);
  const dynamic = journey.withPool(s, pool({ key: id('e'), feePips: 8388608, fee: 'Dynamic' }), NOW);
  assert.deepEqual(journey.canContinue('pool', dynamic, NOW), { ok: false, reason: CREATE.pool.unsupportedDynamic });
  assert.match(CREATE.pool.unsupportedDynamic, /^This pool has a dynamic fee, .*Choose another pool\.$/);
  // Hooks are said first when a pool has both; neither pool walks on, and the journey never reaches Review with it.
  assert.deepEqual(journey.canContinue('pool', journey.withPool(s, pool({ key: id('f'), hooks: addr('f'), feePips: 8388608 }), NOW), NOW), { ok: false, reason: CREATE.pool.unsupportedHooks });
  for (const refused of [hooked, dynamic]) {
    assert.equal(journey.next(refused, NOW), refused, 'Continue does nothing');
    assert.equal(journey.reachable(journey.withBudget(refused, '0.5'), NOW), 'pool');
  }
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

// The single-token balance line went with components/create/WalletBalance.tsx,
// which nothing had rendered since the amount step began showing both of a
// pool's tokens. Its ten strings went with it; PairedAmounts.tsx keeps the four
// that are still drawn. Pinned so a stale one cannot be reintroduced by habit.
test('the retired single-token balance line left no copy behind', () => {
  for (const key of ['balanceFromListing', 'balanceReading', 'balanceWaiting', 'balanceNotReturned',
    'balanceInvalidAddress', 'balanceRaw', 'balanceZero', 'balanceUnreadable', 'balanceNoDecimals', 'balanceFailed'])
    assert.equal(CREATE.amount[key], undefined, key);
  for (const key of ['maxLabel', 'connectForBalance', 'balanceAt', 'balanceNote'])
    assert.notEqual(CREATE.amount[key], undefined, `${key} is still drawn by PairedAmounts.tsx`);
});

test('slippage is a whole number of basis points inside the product’s bound: 10 to 500, 0.1% to 5%', () => {
  const v = journey.validateSlippage;
  assert.deepEqual(v('50'), { ok: true, bps: 50 });
  assert.deepEqual(v('10'), { ok: true, bps: 10 }, 'the lower end is included');
  assert.deepEqual(v('500'), { ok: true, bps: 500 }, 'the upper end is included');
  for (const text of ['', '0', '9', '501', '9999', '10000', '-1', '1.5', '050', ' 50', '50 ', 'abc']) assert.deepEqual(v(text), { ok: false, reason: CREATE.amount.slippageInvalid }, text);
  assert.equal(CREATE.amount.slippageInvalid, 'Slippage is a whole number of basis points from 10 to 500: 0.1% to 5%.');
});

test('the bound, its presets, default and warning line are one set of numbers, and the backend and both contracts hold the same ends', () => {
  assert.deepEqual([slippage.SLIPPAGE_MIN_BPS, slippage.SLIPPAGE_MAX_BPS], [10, 500]);
  // src/finance/slippage.ts declares the same ends a second time, because the two modules cannot
  // share one in either direction: setup.ts may not import out of src/finance (rugged's
  // test_setup_sdk_evm.py compiles it with --rootDir there), and nothing outside the wallet feature
  // may import into it (session.source-guard.test.mjs). The two copies are pinned to each other here.
  const sdk = require('../.test-build/app/src/finance/slippage.js');
  assert.deepEqual([sdk.SLIPPAGE_MIN_BPS, sdk.SLIPPAGE_MAX_BPS], [slippage.SLIPPAGE_MIN_BPS, slippage.SLIPPAGE_MAX_BPS], 'the SDK copy of the bound is the product bound');
  for (let bps = slippage.SLIPPAGE_MIN_BPS; bps <= slippage.SLIPPAGE_MAX_BPS; bps += 1) {
    assert.equal(sdk.slippageWritten(bps), slippage.slippageWritten(bps), `${bps} is written the same way on both sides`);
  }
  assert.deepEqual([...slippage.SLIPPAGE_PRESETS], [10, 50, 100]);
  assert.equal(slippage.SLIPPAGE_MARKS, slippage.SLIPPAGE_PRESETS, 'the marks on the track are the presets');
  assert.equal(slippage.SLIPPAGE_DEFAULT_BPS, 50);
  assert.equal(journey.DEFAULT_SLIPPAGE_BPS, '50', 'the journey starts at the default');
  assert.equal(slippage.SLIPPAGE_WARN_ABOVE_BPS, 100);
  assert.equal(slippage.slippageWarns(100), false, '1% itself is not warned about');
  assert.equal(slippage.slippageWarns(105), true);
  for (const text of ['10', '250', '500']) assert.equal(slippage.slippageBpsFrom(text), Number(text), text);
  for (const text of ['9', '501', '0', '05', '5.0', '', '+50']) assert.equal(slippage.slippageBpsFrom(text), null, text);
  // The backend's request models and the generated contracts check exactly these ends (backend/onboarding_models.py, Slippage).
  const models = readFileSync(new URL('../../backend/onboarding_models.py', import.meta.url), 'utf8');
  assert.match(models, /^SLIPPAGE_MIN_BPS = 10$/m);
  assert.match(models, /^SLIPPAGE_MAX_BPS = 500$/m);
  assert.match(models, /^Slippage = Annotated\[StrictInt, Field\(ge=SLIPPAGE_MIN_BPS, le=SLIPPAGE_MAX_BPS\)\]$/m);
  for (const path of ['onboarding-v1/schemas/position-preview.request.schema.json', 'onboarding-v1/schemas/swap-preview.request.schema.json']) {
    const schema = JSON.parse(readFileSync(new URL(`../../api-contracts/${path}`, import.meta.url), 'utf8'));
    assert.deepEqual([schema.properties.slippageBps.minimum, schema.properties.slippageBps.maximum], [10, 500], path);
  }
  const create = JSON.parse(readFileSync(new URL('../../api-contracts/deposit-v1/schemas/create.request.schema.json', import.meta.url), 'utf8'));
  const selection = create.$defs.DepositSelection.properties.slippageBps;
  assert.deepEqual([selection.minimum, selection.maximum], [10, 500]);
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

// Changed on purpose (round 6, 2026-09-27, the owner: the technical parts of New position go in a collapsed Advanced):
// the slider, its presets and its exact box are under the amount step's Advanced, closed, with the tolerance in its
// summary (it opens by itself only when the tolerance is already above 1%); Review says the tolerance under its closed
// Details, and the done Amount row says the amounts instead.
test('the amount step chooses slippage by a preset, by dragging or by an exact percent, under a closed Advanced, and the choice is shown again in Review', () => {
  const stage = readFileSync(new URL('../src/components/create/StageAmount.tsx', import.meta.url), 'utf8');
  const slider = readFileSync(new URL('../src/components/create/SlippageSlider.tsx', import.meta.url), 'utf8');
  assert.match(stage, /<details className="dm-details dm-flow-advanced" data-flow-advanced="" open=\{opened \|\| undefined\}>/, 'the slider is behind Advanced');
  assert.match(stage, /const \[opened\] = useState\(\(\) => slippageWarns\(value\)\)/, 'open by itself only above 1%, read once');
  assert.match(stage, /\{CREATE\.amount\.slippageLabel\} \{slippageWritten\(value\)\}/, 'the summary says the tolerance');
  assert.match(stage, /<SlippageSlider/);
  assert.match(slider, /type="range"/, 'a real range input: the keyboard, touch and assistive technology all work');
  assert.match(slider, /aria-valuetext/, 'the position says nothing out loud, so the percentage does');
  assert.match(slider, /<SlippagePresets/, 'the presets are buttons on the step');
  assert.match(slider, /data-slippage-warning/, 'above 1% the step says what that allows');
  const presets = readFileSync(new URL('../src/components/create/SlippagePresets.tsx', import.meta.url), 'utf8');
  assert.match(presets, /aria-pressed=\{preset === value\}/, 'toggle buttons: a value between the presets leaves none pressed');
  const review = readFileSync(new URL('../src/components/create/StageReview.tsx', import.meta.url), 'utf8');
  assert.match(review, /<details className="dm-details dm-flow-advanced" data-review-details="">[\s\S]*data-review-slippage=/, 'Review shows the tolerance under its Details before the wallet is asked for anything');
  assert.match(review, /data-review-slippage-warning/, 'and says, in view, what more than 1% allows');
  // Changed on purpose (2026-09-28, round 6 review): with the tolerance inside Review's closed Details, Review's warning
  // names what the figure is and where it is changed; the amount step keeps its own wording beside its slider.
  assert.match(review, /CREATE\.review\.slippageWarning\(slippageWritten\(slippage\.bps\)\)/);
  assert.doesNotMatch(review, /CREATE\.amount\.slippageWarning/);
  assert.equal(CREATE.review.slippageWarning('3%'),
    'You let prices move up to 3% (Amount › Advanced), more than the usual 1%. The deposit can take up to 3% more of each token, and a swap can return 3% less.');
  const rail = readFileSync(new URL('../src/components/create/StepList.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(rail, /summary\.slippage\(/, 'the done Amount row says the amounts, not the tolerance');
  assert.equal(CREATE.review.slippage('0.5%'), 'Slippage tolerance 0.5%');
  assert.equal(CREATE.review.summary.slippage('0.5%'), 'slippage 0.5%');
  // Setup's draft and its balancing swap take the choice through the same control, and every path applies the one bound: no 9999 and no 1000 left.
  const setup = readFileSync(new URL('../src/screens/Setup.tsx', import.meta.url), 'utf8');
  const advanced = readFileSync(new URL('../src/screens/AdvancedSetup.tsx', import.meta.url), 'utf8');
  const finance = readFileSync(new URL('../src/finance/setup.ts', import.meta.url), 'utf8');
  assert.match(setup, /<SlippageChoice/, 'the draft form offers the presets and the exact box');
  assert.match(setup, /slippageBpsFrom\(form\.slippageBps\)/, 'the draft is created only with a limit inside the bound');
  assert.match(setup, /<AdvancedSetup slippageBps=/, 'the balancing swap starts from the draft’s limit');
  assert.match(advanced, /<SlippageChoice/, 'the swap offers the same control');
  assert.match(finance, /slippageBps < SLIPPAGE_MIN_BPS \|\| slippageBps > SLIPPAGE_MAX_BPS/, 'the wallet client draws the minimum output inside the same bound');
  assert.match(finance, /slippageWritten\(slippageBps\)/, 'and the swap review says the limit it used');
  for (const [name, text] of [['Setup.tsx', setup], ['AdvancedSetup.tsx', advanced], ['finance/setup.ts', finance], ['onboarding/inputs.ts', readFileSync(new URL('../src/onboarding/inputs.ts', import.meta.url), 'utf8')], ['onboarding/swap.ts', readFileSync(new URL('../src/onboarding/swap.ts', import.meta.url), 'utf8')]]) {
    assert.doesNotMatch(text, /9999|slippageBps > 1000|\b1000 basis/, `${name} applies the product’s bound, not the provider’s`);
  }
  assert.match(CREATE.amount.slippageWarning('2%'), /^2% is more than the usual 1%\. The deposit can take up to 2% more of each token/);
  assert.equal(CREATE.amount.advanced, 'Advanced');
  // The basis-point field's string is gone with it.
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
  assert.deepEqual(journey.canContinue('amount', journey.withSlippage(s, '9'), NOW), { ok: false, reason: CREATE.amount.slippageInvalid }, 'below 0.1%');
  assert.deepEqual(journey.canContinue('amount', journey.withSlippage(s, '501'), NOW), { ok: false, reason: CREATE.amount.slippageInvalid }, 'above 5%');
  assert.deepEqual(journey.canContinue('amount', journey.withSlippage(s, '500'), NOW), { ok: true }, '5% itself is allowed');
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
  assert.equal(journey.reachable(s, NOW), 'review', 'nothing after the amount blocks: the deposit amounts wait for nothing');
  assert.equal(journey.canOpen('balance', s, NOW), false, 'not reached yet');
  s = journey.next(s, NOW);
  assert.equal(s.stage, 'balance');
  assert.deepEqual(journey.canContinue('balance', s, NOW), { ok: true }, 'the person may continue whether or not an estimate of the amounts is shown');
  s = journey.next(s, NOW);
  assert.equal(s.stage, 'review', 'the balance stage continues straight to Review: nothing is asked in between');
  assert.equal(s.furthest, 'review');
  assert.deepEqual(journey.canContinue('review', s, NOW), { ok: false, reason: CREATE.review.final });
  assert.equal(journey.next(s, NOW), s, 'review is the last stage');
  // Back keeps everything and the rail may reopen any reached stage.
  const backOnce = journey.back(s);
  assert.equal(backOnce.stage, 'balance');
  assert.equal(backOnce.furthest, 'review');
  assert.equal(backOnce.budget, '0.5');
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
  // The tolerance chosen is the one sent, and nothing outside the bound is sent or carried at all.
  assert.equal(journey.previewRequest(journey.withSlippage(s, '120')).request.slippageBps, 120);
  assert.equal(journey.setupDraft(journey.withSlippage(s, '120')).slippageBps, 120);
  assert.deepEqual(journey.previewRequest(journey.withSlippage(s, '501')), { ok: false, reason: CREATE.amount.slippageInvalid });
  assert.equal(journey.setupDraft(journey.withSlippage(s, '9')), null);
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

test('Review ends on Create position, made in place: no hand-off to Setup, and the control loads lazily behind the wallet flag', () => {
  // setupDraft is what Create position reads: every choice, or null when one is missing or the pool is not one it takes.
  const s = ready();
  assert.ok(journey.setupDraft(s));
  for (const other of [pool({ hooks: addr('f') }), pool({ feePips: 8388608, fee: 'Dynamic' })]) assert.equal(journey.setupDraft({ ...s, pool: other }), null);
  assert.equal(journey.continueNote, undefined, 'no line about carrying choices anywhere');
  for (const key of ['gate', 'gateDetail', 'setup', 'noSetup', 'setupNote', 'setupNoteNotConnected', 'setupNoteUnsupported', 'permitStep', 'otherApproveStep']) assert.equal(CREATE.review[key], undefined, key);
  const review = readFileSync(new URL('../src/components/create/StageReview.tsx', import.meta.url), 'utf8');
  assert.match(review, /module\.CreatePosition/, 'the final control is Create position');
  assert.doesNotMatch(review, /#\/setup|Continue in Setup|SetupLink/, 'nothing on Review sends anyone to Setup');
  assert.match(review, /<Suspense fallback=\{<Unavailable note=\{CREATE\.review\.loading\} \/>\}>/);
  const control = readFileSync(new URL('../src/components/create/CreatePosition.tsx', import.meta.url), 'utf8');
  assert.match(control, /'Create position'/);
  // Changed on purpose (2026-09-24, the three features joined up): the page no longer leaves by itself once the position
  // exists. Create position publishes it (lib/create/createProgress.ts), and Review offers what comes next in its place
  // (CreatedNext.tsx): the position's own page on Positions, or its automation with the position chosen.
  assert.match(control, /publishCreated\(tokenId\.toString\(\)\)/, 'the new position is handed to Review');
  assert.doesNotMatch(control, /window\.location\.hash =/, 'nothing opens another page on its own');
  const next = readFileSync(new URL('../src/components/create/CreatedNext.tsx', import.meta.url), 'utf8');
  assert.match(next, /positionHref\(tokenId\)/, 'the position’s own page (screens/PositionDetail.tsx)');
  assert.match(next, /sequenceHref\(tokenId, key\)/, 'or the automation page with this position and the mode chosen');
  assert.match(review, /\{created && <CreatedNext tokenId=\{created\} \/>\}/);
  // Review of 2026-09-24: the success is not a dead end. New position's own link starts a fresh flow (NewPosition.tsx keys
  // the journey, anew once a position was created), and a done step still reopens: the steps are locked only while
  // Create position is asking the wallet.
  const newPosition = readFileSync(new URL('../src/screens/NewPosition.tsx', import.meta.url), 'utf8');
  // Changed on purpose (round 6, 2026-09-27): the journey also takes the token a pool page's link names (#/new/<id>/<token>).
  assert.equal([...newPosition.matchAll(/<Journey key=\{flow\} poolId=\{poolId\} linkToken=\{linkToken\} \/>/g)].length, 2, 'both ways the page draws the journey are keyed');
  const journeyCode = readFileSync(new URL('../src/components/create/Journey.tsx', import.meta.url), 'utf8');
  assert.match(journeyCode, /<StepList steps=\{steps\} onOpen=\{reopen\} locked=\{creating\} \/>/);
  assert.match(journeyCode, /if \(creating \|\| !canOpen\(target, state, now\)\) return/);
  assert.doesNotMatch(control, /livePort|session\//, 'no sign-in is needed to create a position');
});

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
// PoolPair ends in it and a chip repeated it. Changed again (owner,
// 2026-09-22): the deposit amounts per token, with their dashes and the line
// explaining them, were deleted; Review keeps Your choices and Wallet steps.
test('the Review says the fee once, and keeps only Your choices and Wallet steps: no deposit amounts per token', () => {
  const review = readFileSync(new URL('../src/components/create/StageReview.tsx', import.meta.url), 'utf8');
  assert.match(review, /<PoolPair option=\{pool\} \/>/, 'the pair still carries the fee');
  assert.doesNotMatch(review, /data-fee=/, 'no chip repeats it');
  assert.equal(existsSync(new URL('../src/components/create/StageBalance.tsx', import.meta.url)), false, 'the deposit amounts section is gone');
  const code = review.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /StageBalance|AmountsSection|CREATE\.balance|data-balance|CREATE\.review\.amounts|onboarding|previewRequest/, 'nothing of it is left in Review');
  // Two sections, in this order: the choices, then the wallet steps.
  assert.deepEqual([...review.matchAll(/aria-labelledby="(create-[a-z]+-heading)"/g)].map((match) => match[1]), ['create-choices-heading', 'create-steps-heading']);
  assert.match(review, /\{CREATE\.review\.choices\}[\s\S]*\{CREATE\.review\.steps\}/);
  // Changed on purpose (round 6, 2026-09-27, the owner: New position for people who know nothing about pools): the two sections are
  // named for a beginner: the position, then what the wallet asks.
  assert.equal(CREATE.review.choices, 'Your position');
  assert.equal(CREATE.review.steps, 'In your wallet');
});

test('Review’s wallet steps are the live ones once Create position runs: each marked by its key and state, and a done step is drawn green with a check', () => {
  const review = readFileSync(new URL('../src/components/create/StageReview.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/styles/flow.css', import.meta.url), 'utf8');
  const control = readFileSync(new URL('../src/components/create/CreatePosition.tsx', import.meta.url), 'utf8');
  assert.match(review, /const progress = useCreateProgress\(\)\n\s*const live = progress && progress\.length > 0 \? progress : null/, 'Review reads the steps Create position publishes, and keeps its own plan until there are some');
  assert.match(review, /step\.state === 'waiting' && index !== next \? '' : LIVE_CAPTION\[step\.state\]/, '"Next" under the first waiting step only');
  assert.match(review, /data-wallet-step=\{step\.key\} data-step-state=\{step\.state \?\? undefined\}/);
  assert.match(review, /\{step\.state === 'done' \? '✓' : index \+ 1\}/, 'a done step shows a check in place of its number');
  assert.match(css, /\.dm-flow-wsteps > li\[data-step-state="done"\] \{[^}]*--money-in/, 'a done step is green');
  assert.match(css, /\.dm-flow-wsteps > li\[data-step-state="done"\] \.dm-step-marker \{[^}]*--money-in/);
  // Create position publishes the steps it runs, marks each one as it goes, and never leaves a run's steps behind.
  assert.match(control, /publishCreateProgress\(next\.length > 0 \? next : null\)/, 'an empty list is never published: Review keeps its plan');
  assert.match(control, /mark\(approveKey, 'waiting', gen, true\)/, 'a second approval of the same token opens its step again');
  assert.match(control, /mark\(key, 'done', gen\)/);
  assert.equal((control.match(/publishCreateProgress\(null\)/g) ?? []).length, 2, 'cleared when the wallet changes and when the control goes');
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

test('the automated-signing gate stays off: Domino signs nothing on its own, and Review says the wallet signs each step', () => {
  const gate = journey.createGate();
  assert.equal(gate.enabled, false);
  assert.equal(gate.reason, CREATE.review.final);
  // Changed on purpose (round 6, 2026-09-27, the owner: New position for people who know nothing about pools): one plain sentence.
  assert.equal(gate.reason, 'Press Create position, then confirm each step in your wallet.');
  assert.equal(gate.detail, CREATE.review.stepsNote);
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

test('the wallet steps are the ones Create position asks for, in order: an exact approval per ERC-20, the deposit, the position; native ETH needs no approval; nothing about automation', () => {
  const erc20 = journey.walletSteps(ready());
  // Changed on purpose (round 6, 2026-09-27, the owner: New position for people who know nothing about pools): short titles; a step about one
  // token is drawn with its symbol after the title ("Approve USDG"), and each detail is one short line.
  assert.deepEqual(erc20.map((step) => step.title), ['Approve', 'Approve', 'Deposit both tokens', 'Create the position']);
  // One approval per ERC-20, in pool order, whichever token was typed; the deposit and the mint name no token.
  assert.deepEqual(erc20.map((step) => step.token?.address), [addr('1'), addr('2'), undefined, undefined]);
  assert.deepEqual(journey.walletSteps(journey.withToken(ready(), TWO)).map((step) => step.token?.address), [addr('1'), addr('2'), undefined, undefined]);
  assert.match(erc20[0].detail, /exact amount, never more/);
  assert.match(erc20[2].detail, /Domino’s contract\. You can get them back until the position is created\./);
  assert.match(erc20[3].detail, /arrives in your wallet/);
  // Native ETH needs no approval: it travels with the deposit.
  const ethPool = pool({ currencies: [token(ZERO, 18, 'ETH'), token(addr('2'), 6, 'USDG')] });
  for (const typed of [candidate(ZERO, 18), TWO]) {
    const steps = journey.walletSteps(journey.withToken(journey.withPool(journey.initialState(), ethPool, NOW), typed));
    assert.deepEqual(steps.map((step) => step.title), ['Approve', 'Deposit both tokens', 'Create the position']);
    assert.equal(steps[0].token.address, addr('2'));
  }
  for (const mode of ['compound', 'domino']) assert.deepEqual(journey.walletSteps(journey.withAutomation(ready(), mode)), erc20, mode);
  for (const step of erc20) assert.doesNotMatch(`${step.title} ${step.detail}`, /sequence|compound|automation|service fee|Permit2|Setup opens/i, step.title);
  assert.deepEqual(journey.walletSteps(journey.initialState()), []);
  assert.deepEqual(journey.walletSteps({ ...ready(), pool: pool({ currencies: [token(addr('8')), token(addr('9'))] }) }), [], 'no steps for a pool that does not hold the token');
  // Each step carries the key Create position reports its progress under (lib/create/createProgress.ts), so Review can mark it.
  assert.deepEqual(erc20.map((step) => step.key), [`approve:${addr('1')}`, `approve:${addr('2')}`, 'fund', 'mint']);
  assert.equal(new Set(erc20.map((step) => step.key)).size, erc20.length, 'one key per step');
});

test('with one of the two tokens in the wallet, the steps approve and deposit that token alone, then swap part of it inside the pool, then create the position', () => {
  for (const from of [0, 1]) {
    const steps = journey.walletSteps(ready(), from);
    const held = [addr('1'), addr('2')][from];
    assert.deepEqual(steps.map((step) => step.key), [`approve:${held}`, 'fund', 'swap', 'mint'], `from token ${from}`);
    // Changed on purpose (round 6, 2026-09-27, the owner: New position for people who know nothing about pools):
    assert.deepEqual(steps.map((step) => step.title), ['Approve', 'Deposit', 'Swap part of your deposit', 'Create the position']);
    assert.deepEqual(steps.map((step) => step.token?.address), [held, held, undefined, undefined], 'the approval and the deposit name the token deposited');
    assert.match(steps[1].detail, /You can get it back until the position is created\./);
    assert.doesNotMatch(steps[1].detail, /Native ETH/);
    assert.match(steps[2].detail, /Swaps part of it for the other token in this pool/);
    assert.match(steps[2].detail, /Fee: 0\.65% of the swapped part/, 'the fee as written by default');
  }
  // The fee named is the one handed in: the deployment's own, as Review writes it.
  assert.match(journey.walletSteps(ready(), 0, '0.3%')[2].detail, /Fee: 0\.3% of the swapped part/);
  // Native ETH: no approval, whichever side is swapped from; an ERC-20 deposited alone is still approved exactly.
  const ethPool = pool({ currencies: [token(ZERO, 18, 'ETH'), token(addr('2'), 6, 'USDG')] });
  const eth = journey.withBudget(journey.withToken(journey.withPool(journey.initialState(), ethPool, NOW), TWO), '1');
  assert.deepEqual(journey.walletSteps(eth, 0).map((step) => step.key), ['fund', 'swap', 'mint'], 'ETH alone travels with the deposit');
  assert.equal(journey.walletSteps(eth, 0)[0].token.address, ZERO);
  assert.deepEqual(journey.walletSteps(eth, 1).map((step) => step.key), [`approve:${addr('2')}`, 'fund', 'swap', 'mint']);
  // No token held: the steps as for both tokens; a pool that does not hold the token: none.
  assert.deepEqual(journey.walletSteps(ready(), null), journey.walletSteps(ready()));
  assert.deepEqual(journey.walletSteps({ ...ready(), pool: pool({ currencies: [token(addr('8')), token(addr('9'))] }) }, 0), []);
});

test('the fee bases are the pool’s, the assisted swap’s and gas: a direct deposit carries no Domino service fee', () => {
  const bases = journey.feeBases(ready());
  assert.deepEqual(bases.map((fee) => fee.label), ['Pool trading fee', 'Assisted swap fee', 'Network gas']);
  assert.equal(bases[0].value, '0.30%');
  assert.match(bases[0].note, /Not a charge to you/);
  assert.match(bases[1].value, /0\.65%/);
  assert.equal(bases[2].value, 'Paid by you');
  for (const fee of bases) assert.doesNotMatch(`${fee.label} ${fee.value}`, /service fee|earned fees|compound/i, fee.label);
  // The fee on earned fees is Automate's to state, for the mode it applies; the field changes nothing here.
  for (const mode of ['compound', 'domino']) assert.deepEqual(journey.feeBases(journey.withAutomation(ready(), mode)), bases, mode);
  assert.equal(journey.feeBases(journey.initialState())[0].value, '—');
});

test('the summary says — for what is not chosen and serialises every decision, the gate included', () => {
  const empty = journey.summaryLines(journey.initialState(), NOW);
  assert.deepEqual(empty.map((line) => line.label), ['Token', 'Pool', 'Amount', 'Balance', 'Review']);
  assert.deepEqual(empty.map((line) => line.value), ['—', '—', '—', '—', '—']);
  assert.deepEqual(empty.map((line) => line.done), [false, false, false, false, false]);
  const s = journey.next(journey.next(ready(), NOW), NOW);
  assert.equal(s.stage, 'review');
  const lines = journey.summaryLines(s, NOW);
  assert.equal(lines[0].value, `ONE · ${addr('1').slice(0, 6)}…${addr('1').slice(-4)}`);
  assert.equal(lines[1].value, `ONE/TWO · 0.30% · ${id('a').slice(0, 6)}…${id('a').slice(-4)}`);
  // currency1 per currency0 with the read decimals (18 and 6): 1.0001^tick × 10^12, as the range controls write it.
  assert.equal(lines[2].value, '0.5 ONE · ≈697,689,000,000 to ≈1,503,780,000,000 (ticks -3600 to 4080) · slippage 0.5%');
  assert.equal(journey.summaryLines(journey.withSlippage(s, '250'), NOW)[2].value, '0.5 ONE · ≈697,689,000,000 to ≈1,503,780,000,000 (ticks -3600 to 4080) · slippage 2.5%', 'the summary says the tolerance chosen, not the default');
  assert.equal(lines[3].value, CREATE.balance.notEnabled);
  assert.equal(lines[4].value, CREATE.review.final);
  assert.equal(journey.positionText(s, NOW), CREATE.review.inRange);
  assert.equal(journey.positionText({ ...s, range: { lower: 60, upper: 120 } }, NOW), CREATE.review.outOfRange);
  assert.match(journey.positionText(s, 300_000), /read more than 5 minutes ago/);
  const text = journey.serialiseSummary(s, NOW);
  // The request is sent for the deposit amounts in wallet builds, never printed: no JSON dump in the summary (G8).
  assert.ok(!text.some((line) => line.startsWith('Request:') || line.includes('"chainId"')), 'no request JSON in the summary');
  assert.ok(!text.some((line) => line.startsWith('Deposit amounts')), 'no deposit amounts block: Review is the choices and the wallet steps');
  // Changed on purpose (round 6, 2026-09-27): a step about one token names it after its short title.
  assert.ok(text.includes('Wallet step 1: Approve ONE'));
  assert.ok(text.includes('Wallet step 3: Deposit both tokens'));
  assert.ok(text.includes('Wallet step 4: Create the position'));
  assert.equal(text.filter((line) => line.startsWith('Wallet step')).length, 4, 'two approvals, the deposit and the position, and no more');
  assert.ok(text.includes('Pool trading fee: 0.30%'));
  assert.ok(!text.some((line) => line.startsWith('Domino service fee')), 'no service fee row: a direct deposit carries none');
  assert.equal(text.at(-1), 'Create position: Press Create position, then confirm each step in your wallet.');
  // A one-token deposit in ONE: its approval, its deposit, the swap, the position.
  const swapping = journey.serialiseSummary(s, NOW, 0).filter((line) => line.startsWith('Wallet step'));
  assert.deepEqual(swapping, ['Wallet step 1: Approve ONE', 'Wallet step 2: Deposit ONE', 'Wallet step 3: Swap part of your deposit', 'Wallet step 4: Create the position']);
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
  assert.match(CREATE.balance.notEnabled, /calculated when you create the position/);
  assert.match(CREATE.automation.notEnabled, /^Not connected$/);
});

test('the automation choices carry the approved names, and the service fee keeps the company’s name', () => {
  const { options } = CREATE.automation;
  // Changed on purpose (review of 2026-09-24, the three features): the choice with no automation is named Plain position,
  // as New position's success, Positions, Automate and the docs name it; the app says 'Self-managing' nowhere any more.
  assert.deepEqual([options.none.title, options.compound.title, options.domino.title], ['Plain position', 'Auto-compound', 'Domino-compound']);
  assert.equal(CREATE.automation.none, 'Plain position', 'the summary line says what the option says');
  assert.equal(CREATE.automation.domino, 'Domino-compound');
  assert.equal(CREATE.automation.dominoRulesHeading, 'How Domino-compound works');
  // The docs' fees page draws its service row from these (lib/docs/pages/reference.ts).
  assert.match(CREATE.review.feeValues.service, /^Auto-compound 2%; Domino-compound 4% of earned fees consumed$/);
  assert.equal(CREATE.review.feeLabels.service, 'Domino service fee', 'the fee label names the company, not the product');
  // "sequence" stays where it names the vault or its cap.
  assert.equal(CREATE.automation.cap, 'Positions in the sequence');
  for (const text of allCreateStrings()) assert.doesNotMatch(text, /Domino sequence|No automation|^None$/, text);
});

// Added 2026-09-24 (the owner's one-token deposit into USDG/NET 8%, a pool with nothing in range): Review says a
// pool reports no liquidity before anything is pressed, from the figure it already has and no wallet read. A missing
// figure is never read as zero; Create position checks the pool on chain before anything is deposited.
test('Review warns that a pool reports no liquidity only when its figure is attributed and zero and the plan swaps part of one token', () => {
  const { reviewPlan, swapsInEmptyPool } = require('../.test-build/app/src/lib/create/reviewPlan.js');
  const reported = (raw, zero) => ({ state: 'attributed', value: zero ? '$0' : '$10', raw, zero, provider: 'dexscreener', retrievedAt: 1010, cacheAgeSeconds: null });
  const empty = pool({ liquidity: reported('0.00', true) });
  const swap = { kind: 'swap', from: 0, deposit: 10n, swap: 5n, receive: 5n };
  assert.equal(swapsInEmptyPool(empty, swap), true);
  assert.equal(swapsInEmptyPool(pool({ liquidity: reported('10.00', false) }), swap), false, 'liquidity reported');
  for (const missing of [figure, { state: 'not_reported', provider: 'dexscreener' }, { state: 'rejected', provider: 'dexscreener', reason: 'provider_currency_mismatch' }])
    assert.equal(swapsInEmptyPool(pool({ liquidity: missing }), swap), false, `${missing.state}: nothing is said`);
  assert.equal(swapsInEmptyPool(empty, { kind: 'both', amount0: 1n, amount1: 1n }), false, 'both tokens deposited: nothing is swapped');
  assert.equal(swapsInEmptyPool(empty, { ...swap, swap: 0n }), false, 'the range takes only the token held: nothing is swapped');
  assert.equal(swapsInEmptyPool(empty, null), false, 'balances unknown');
  // Changed on purpose (round 6, 2026-09-27, the owner: plain words): "empty", not "reports no liquidity".
  assert.equal(CREATE.review.emptyPool, 'This pool is empty, so part of your deposit can’t be swapped in it. Add both tokens, or choose another pool.');

  // Review's own reading: 0.5 ONE typed, the wallet holds ONE and no TWO, in a range around the price.
  let s = journey.withToken(journey.initialState(), ONE);
  s = journey.withRange(journey.withBudget(journey.withPool(journey.next(s, NOW), empty, NOW), '0.5'), { lower: -600, upper: 600 });
  const held = [String(10n ** 18n), '0'];
  const read = reviewPlan(s, held);
  assert.equal(read.plan.kind, 'swap');
  assert.equal(read.noLiquidity, true);
  assert.equal(reviewPlan({ ...s, pool: pool() }, held).noLiquidity, false, 'no figure: nothing is said');
  assert.equal(reviewPlan(s, [String(10n ** 18n), String(10n ** 24n)]).noLiquidity, false, 'both tokens at hand');
  assert.equal(reviewPlan(s, null).noLiquidity, false);
});

// Added 2026-09-27 (round 6, the owner: New position opened from a pool page looked different from New position opened
// from Positions). A pool from a link now arrives exactly as a pool chosen from the list does: chosen, with a token an
// amount starts in, and nothing asks which of its tokens is deposited (the amount step takes either).
test('a pool from a link starts from the token it was verified against, else the first readable one, else none', () => {
  const two = pool({ currencies: [token(addr('1'), 18, 'ONE'), token(addr('2'), 6, 'USDG')] });
  assert.equal(journey.linkedDepositToken(two, addr('2')).key, addr('2'), 'the token the link was verified against');
  assert.equal(journey.linkedDepositToken(two, addr('9')).key, addr('1'), 'else the first');
  const partial = pool({ currencies: [token(addr('1'), null, null), token(addr('2'), 6, 'USDG')] });
  assert.equal(journey.linkedDepositToken(partial, addr('1')).key, addr('2'), 'never one whose decimals were not read');
  const gone = pool({ currencies: [{ ...token(addr('1')), readStatus: 'no_contract' }, { ...token(addr('2')), readStatus: 'unavailable' }] });
  assert.equal(journey.linkedDepositToken(gone, addr('1')), null, 'none: the step asks for a token, as before');
  // What Journey does with it: the same state choosing the pool from the list leaves, so step 1 continues at once.
  const start = journey.linkedDepositToken(two, addr('2'));
  const linked = journey.withPool(journey.withToken(journey.initialState(), start), two, NOW);
  assert.deepEqual(journey.canContinue('token', linked, NOW), { ok: true });
  assert.deepEqual(journey.canContinue('pool', linked, NOW), { ok: true });
  const stage = readFileSync(new URL('../src/components/create/StageToken.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(stage, /data-deposit-choice|depositWhich|create-deposit-token/, 'no deposit-token question on step 1');
  const flow = readFileSync(new URL('../src/components/create/Journey.tsx', import.meta.url), 'utf8');
  // Changed on purpose 2026-09-28 (speed wave, study item 31): the rule is one function, asked once before the featured
  // list's first answer (the verification then starts at once) and once after it, which decides.
  assert.match(flow, /const tokenFor = \(linked: Extract<Preselect, \{ ok: true \}>\): AddressKey =>\n\s+!linked\.catalogue && linkToken \? addressKey\(linkToken\) : verificationToken\(linked\)/, 'a pool of neither list is verified with the token its link names');
  assert.match(flow, /const against = linked\.ok \? tokenFor\(linked\) : null/);
  assert.match(flow, /const start = linkedDepositToken\(option, poolHolds\(option, USDG\) \? USDG : against\)/, 'USDG first where the pool holds it');
  assert.equal(CREATE.token.depositWhich, undefined);
  assert.equal(CREATE.token.depositWhichNote, undefined);
});

// Added 2026-09-27 (round 6, the owner: plain words, fewer numbers): New position writes prices as "1 ETH = 2,500 USDG",
// with no "≈", and how far a bound is from today's price as a side and a rounded percentage.
test('plain figures: no ≈ on the steps, and a bound as "30% below today" or "51% above today"', () => {
  const plain = require('../.test-build/app/src/lib/create/plain.js');
  assert.equal(plain.plainFigure('≈1,747.65'), '1,747.65');
  assert.equal(plain.plainFigure('2,499.91'), '2,499.91');
  assert.deepEqual(plain.awayFrom(-3600, 0), { side: 'below', percent: '30%' });
  assert.deepEqual(plain.awayFrom(4080, 0), { side: 'above', percent: '50%' });
  assert.deepEqual(plain.awayFrom(50, 0), { side: 'above', percent: '0.5%' });
  assert.deepEqual(plain.awayFrom(0, 0), { side: 'at', percent: '0%' });
  assert.deepEqual(plain.awayFrom(30_000, 0), { side: 'above', percent: '1,908%' });
  assert.equal(CREATE.amount.below('30%'), '30% below today');
  assert.equal(CREATE.amount.above('51%'), '51% above today');
  // Nothing a person reads on the four steps says "per" or starts with "≈".
  for (const key of ['step', 'token', 'pool', 'amount', 'review']) {
    const walk = (value) => (typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(walk) : []);
    for (const text of walk(CREATE[key])) assert.doesNotMatch(text, /^≈| per [A-Z]/, `${key}: ${text}`);
  }
  const rail = readFileSync(new URL('../src/components/create/StepList.tsx', import.meta.url), 'utf8');
  assert.match(rail, /1 <SymbolText token=\{price\.base\} \/> = \{words\(range\.lower\)\} to \{words\(range\.upper\)\} <SymbolText token=\{price\.quote\} \/>/, 'the done Range row: "1 ETH = 1,747.65 to 3,766.84 USDG"');
  // Added 2026-09-28: the slider's chip and the preview's picture round the distance as the words beside them do, so
  // the page never says "30% below today" beside "−30.1%".
  assert.equal(plain.awayShort(-3600, 0), '−30%');
  assert.equal(plain.awayShort(4080, 0), '+50%');
  assert.equal(plain.awayShort(50, 0), '+0.5%');
  assert.equal(plain.awayShort(0, 0), '0%');
  const preview = readFileSync(new URL('../src/components/create/PositionPreview.tsx', import.meta.url), 'utf8');
  assert.match(preview, /\{awayShort\(lowerTick, poolTick\)\}/);
  assert.doesNotMatch(preview, /fromPoolPrice/);
});

// Added 2026-09-28 (round 6): a Custom price the shared range control refuses is said in the step's words, and a price
// typed the way the page writes one ("1,747.65") is read without its thousands separators.
test('the range step says a refused price in plain words, and reads a grouped price', () => {
  const errors = CREATE.amount.priceErrors;
  assert.equal(errors['Enter a positive decimal price without commas or exponents.'], 'Enter a price as a number, like 2000 or 0.5.');
  assert.equal(errors['Min price must stay below max price.'], CREATE.amount.rangeOrder);
  assert.equal(errors['Max price must stay above min price.'], 'The highest price must stay above the lowest price.');
  for (const text of Object.values(errors)) assert.doesNotMatch(text, /\b(min|max|decimal|exponent)/i, text);
  const step = readFileSync(new URL('../src/components/create/RangeStep.tsx', import.meta.url), 'utf8');
  // Changed on purpose (2026-09-28, round 6 review): the refused price is kept with the tick it was typed for, and said
  // only while Custom is open (finance.browser drives it: it clears on Closer or Wider).
  assert.match(step, /setRefused\(\{ tick, text: CREATE\.amount\.priceErrors\[parsed\.message\] \?\? parsed\.message \}\)/);
  assert.ok(step.includes(String.raw`/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/`), 'only a grouped number loses its commas: "0,5" is still refused');
});

// Added 2026-09-28 (round 6 review): the amount step with no wallet said "Connect a wallet to see your balance." in both
// panels; it is one line under them now. And a one-token plan's other panel keeps what the range pairs with the typed
// amount (what the wallet lacks), not what the swap brings: beside a 2,500 USDG balance, "1,550.92 USDG" read as enough.
test('the amount step asks for a wallet once, and the swapped panel keeps the paired amount', () => {
  const amounts = readFileSync(new URL('../src/components/create/PairedAmounts.tsx', import.meta.url), 'utf8');
  assert.equal(amounts.match(/CREATE\.amount\.connectForBalance/g)?.length, 1);
  const map = amounts.slice(amounts.indexOf('pool.currencies.map('), amounts.indexOf('{disconnected && ('));
  assert.doesNotMatch(map, /connectForBalance/, 'not inside each panel');
  assert.match(amounts, /footer=\{\s*disconnected \? null :/);
  assert.doesNotMatch(amounts, /swap\.receive/, 'the other panel never shows what the swap brings');
  // Added 2026-09-28 (round 6 review): only a derived panel is quieted; the typed one never is (finance.browser drives it).
  assert.match(amounts, /const quiet = swapped !== null && swapped !== independent \? swapped : null/);
  assert.match(amounts, /data-plan-side=\{side === quiet \? 'swapped' : undefined\}/);
});

// Added 2026-09-27 (round 6): Max on native ETH took every wei, and Review, which keeps a gas allowance back, then said
// the wallet was short of the very amount Max had typed. Max now leaves that allowance.
test('Max leaves Review’s gas allowance in the wallet for native ETH, and takes the whole balance of any other token', () => {
  const { maxSpend, REVIEW_GAS_RESERVE_WEI } = require('../.test-build/app/src/lib/create/reviewPlan.js');
  assert.equal(maxSpend(1_250_000_000_000_000_000n, true), 1_250_000_000_000_000_000n - REVIEW_GAS_RESERVE_WEI);
  assert.equal(maxSpend(REVIEW_GAS_RESERVE_WEI, true), 0n, 'nothing to put in once gas is kept');
  assert.equal(maxSpend(2_500_000_000n, false), 2_500_000_000n);
  const { reviewPlan } = require('../.test-build/app/src/lib/create/reviewPlan.js');
  // ETH typed at Max, with USDG to spare: the plan is both tokens, never short.
  const ethPool = pool({ currencies: [token(ZERO, 18, 'ETH'), token(addr('2'), 6, 'USDG')] });
  const balance = 10n ** 18n;
  const typed = maxSpend(balance, true);
  let s = journey.withToken(journey.withPool(journey.initialState(), ethPool, NOW), candidate(ZERO, 18));
  s = journey.withRange(journey.withBudget(s, (Number(typed) / 1e18).toString()), { lower: -600, upper: 600 });
  const plan = reviewPlan(s, [String(balance), String(10n ** 30n)]);
  assert.equal(plan.plan.kind, 'both');
  const components = readFileSync(new URL('../src/components/create/PairedAmounts.tsx', import.meta.url), 'utf8');
  assert.match(components, /maxSpend\(BigInt\(balance\.raw\), currency\.address === NATIVE_CURRENCY\)/);
});
