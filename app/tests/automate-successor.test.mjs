// Added 2026-09-24 (DESIGN-V2 §14.2, R-13 / R-18): the guided creation's live successor axis
// (src/lib/automate/successor.ts), the per-field reasons it shows (fieldCheck.ts) and the Automate fee meter's
// local rates (components/automate/feeMeter.ts), pinned against the contract rules and the copy they mirror.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { LOG_TICK, percentOf, signedPercent, successorPlan } = require('../.test-build/app/src/lib/automate/successor.js');
const { fieldCheck } = require('../.test-build/app/src/lib/automate/fieldCheck.js');
const { FEE_BPS } = require('../.test-build/app/src/components/automate/feeMeter.js');
const { CREATE } = require('../.test-build/app/src/lib/create/copy.js');

/** NFT 3135288 on mainnet: USDG / 0xefab…a0a3, tick spacing 9303, ticks 334908 to 353514 (automate.md §2.2). */
const ROOT = { lower: 334908, upper: 353514, spacing: 9303 };
const DEFAULTS = { upside: 50, overlap: 20, trigger: 5, cap: 3 };

test('NFT 3135288 with the default limits: the chain accepts a ceiling at +153.5%, no overlap, and triggers at tick 353001', () => {
  const plan = successorPlan(ROOT, DEFAULTS, false);
  assert.ok(plan);
  const [first] = plan.steps;
  assert.equal(first.anchorTick, 353514, 'the first successor stands on the root ceiling');
  assert.equal(first.ceilingTick, 362817, 'the first spacing tick at least 50% above');
  assert.equal(signedPercent(first.ceiling), '+153.5%');
  assert.equal(first.floorMinTick, 353514, 'a 20% overlap rounds up to the ceiling itself on this spacing');
  assert.equal(signedPercent(first.floorMin), '0%');
  assert.equal(plan.triggerTick, 353001);
  assert.equal(signedPercent(plan.trigger), '−5%');
  assert.equal(signedPercent(plan.floor), '−84.4%', 'the root floor relative to its ceiling');
  assert.equal(plan.steps.length, 2, 'cap 3 = the root and two successors');
  assert.equal(plan.steps[1].anchorTick, 362817, 'each successor stands on the previous ceiling');
  assert.equal(plan.more, 0);
  assert.ok(plan.steps.every((step) => step.feasible));
});

test('the picture is the same in both orientations; only the raw ticks mirror', () => {
  const plain = successorPlan(ROOT, DEFAULTS, false);
  const inverse = successorPlan(ROOT, DEFAULTS, true);
  assert.equal(inverse.steps[0].anchorTick, 334908, 'inverse: the root ceiling is its lower tick');
  assert.equal(inverse.steps[0].ceilingTick, 325605, 'inverse: the successor ceiling is a lower raw tick');
  assert.equal(inverse.steps[0].floorMinTick, 334908);
  assert.equal(inverse.triggerTick, 335421);
  for (const key of ['floor', 'trigger']) assert.equal(signedPercent(inverse[key]), signedPercent(plain[key]), key);
  inverse.steps.forEach((step, index) => {
    for (const key of ['anchor', 'ceiling', 'floorMin']) assert.equal(signedPercent(step[key]), signedPercent(plain.steps[index][key]), `${key} ${index}`);
  });
});

test('limits move the geometry as the contract rules say', () => {
  // A 100% upside: the first spacing tick at least ln(2)/ln(1.0001) = 6931.8 ticks above the ceiling.
  const double = successorPlan(ROOT, { ...DEFAULTS, upside: 100 }, false);
  assert.equal(double.steps[0].ceilingTick, 353514 + 9303);
  assert.ok(percentOf(double.steps[0].ceiling) >= 100);
  // A fine spacing lets the overlap reach down: spacing 60, overlap 20% → the lowest spacing tick within 20% below.
  const fine = successorPlan({ lower: -600, upper: 600, spacing: 60 }, DEFAULTS, false);
  assert.equal(fine.steps[0].floorMinTick, 600 + Math.ceil(Math.log(0.8) / LOG_TICK / 60) * 60);
  assert.ok(percentOf(fine.steps[0].floorMin) >= -20 && percentOf(fine.steps[0].floorMin) < -19);
  assert.ok(percentOf(fine.steps[0].ceiling) >= 50 && percentOf(fine.steps[0].ceiling) < 50.8);
  // No overlap and a zero trigger: the floor is the anchor, the trigger is the ceiling.
  const tight = successorPlan(ROOT, { ...DEFAULTS, overlap: 0, trigger: 0 }, false);
  assert.equal(tight.steps[0].floorMinTick, tight.steps[0].anchorTick);
  assert.equal(tight.triggerTick, 353514);
  // A long sequence draws three successors and counts the rest.
  const long = successorPlan(ROOT, { ...DEFAULTS, cap: 10 }, false);
  assert.equal(long.steps.length, 3);
  assert.equal(long.more, 6);
  // One position is the root alone.
  assert.equal(successorPlan(ROOT, { ...DEFAULTS, cap: 1 }, false).steps.length, 0);
});

test('a successor past the usable ticks is infeasible, and inputs the contract would refuse draw nothing', () => {
  const edge = successorPlan({ lower: 870000, upper: 880000, spacing: 10000 }, DEFAULTS, false);
  assert.equal(edge.steps[0].feasible, false, 'the ceiling cannot rise above the last usable tick');
  assert.equal(successorPlan(ROOT, { ...DEFAULTS, trigger: 21 }, false), null);
  assert.equal(successorPlan(ROOT, { ...DEFAULTS, overlap: Number.NaN }, false), null);
  assert.equal(successorPlan({ ...ROOT, lower: ROOT.upper }, DEFAULTS, false), null);
});

test('signed percentages: one decimal at most, a true minus, no sign on zero', () => {
  assert.equal(signedPercent(0), '0%');
  assert.equal(signedPercent(Math.log(1.5)), '+50%');
  assert.equal(signedPercent(Math.log(0.95)), '−5%');
  assert.equal(signedPercent(Math.log(1 - 0.00001)), '0%');
});

test('each limit field is refused alone, in the creation’s own words', () => {
  assert.equal(fieldCheck('upsidePercent', '50'), null);
  assert.equal(fieldCheck('triggerPercent', '21'), 'Trigger distance is a percentage from 0 to 20, with up to two decimal places.');
  assert.equal(fieldCheck('sequenceCap', '0'), 'The number of positions is a whole number from 1 to 255.');
  assert.equal(fieldCheck('maxGasCostEth', '0'), 'The gas cap per run is an amount of ETH above zero.');
  assert.equal(fieldCheck('minimumIntervalMinutes', '15'), null);
});

test('the Automate fee meter draws the rates the review states (R-18)', () => {
  assert.deepEqual(FEE_BPS, { compound: 200, domino: 400 });
  for (const mode of ['compound', 'domino']) {
    // Changed on purpose 2026-10-01 (audit E4): plain words.
    assert.equal(CREATE.review.serviceFeeValue(mode), `${FEE_BPS[mode] / 100}% of the fees it uses`);
  }
});
