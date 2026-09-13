/**
 * The derived onboarding and deposit fixtures (support/derived-corpus.mjs),
 * held to the producer beyond the package runtimes (rugged97 on #38, #40 and
 * #72). The runtimes accepted shapes the producer's Python model refuses or
 * never produces: route pool ids that were not the keccak of their PoolKeys,
 * a fingerprint left from another request, a reorged step keeping its
 * receipt, a confirmation before finality. This file keeps those rules in
 * check:app; `npm run check:producer-fixtures` runs the same bodies through
 * the Python model itself, by hand: it needs the backend's Python
 * dependencies, which the frontend CI job does not install.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build, clone, depositRuntime, depositSource, fixture, onboardingRuntime } from './support/consumer-fakes.mjs';
import { OWNER_CONTROLS, depositCorpus, depositRuleViolations, onboardingCorpus, onboardingPackageResponses } from './support/derived-corpus.mjs';
import { fingerprintOf, poolIdOf } from './support/onboarding-derived.mjs';

const { DERIVED, listBody } = build('deposit/fixtures/derive');

/** Every pool id a preview names, with the PoolKey it must be the keccak of. */
function poolIds(preview) {
  const hops = preview.quote ? preview.quote.routes.flat().map((hop) => [hop.poolId, hop.poolKey]) : [];
  const position = preview.position ? [[preview.position.poolId, preview.position.poolKey]] : [];
  const request = preview.request.poolId ? [[preview.request.poolId, preview.request.poolKey]] : [];
  return [...hops, ...position, ...request];
}

test("the replicas of the producer's pool id and request fingerprint reproduce every package onboarding preview", () => {
  const responses = onboardingPackageResponses();
  assert.equal(responses.length, 6, responses.map((entry) => entry.id).join(', '));
  for (const { id, body } of responses) {
    assert.equal(fingerprintOf(body.preview.request), body.preview.requestFingerprint, `${id} fingerprint`);
    const ids = poolIds(body.preview);
    assert.ok(ids.length > 0, id);
    for (const [poolId, poolKey] of ids) assert.equal(poolIdOf(poolKey), poolId, `${id} pool id`);
  }
});

test('every derived onboarding preview names the pool ids of its PoolKeys and the fingerprint of its own request (rugged97 on #38)', () => {
  const corpus = onboardingCorpus();
  assert.equal(corpus.length, 10);
  for (const { id, route, body } of corpus) {
    assert.ok(onboardingRuntime.validateResponse(route, body), `${id} passes the runtime`);
    assert.equal(body.preview.requestFingerprint, fingerprintOf(body.preview.request), `${id}: requestFingerprint is the producer's hash of its request`);
    for (const [poolId, poolKey] of poolIds(body.preview)) assert.equal(poolId, poolIdOf(poolKey), `${id}: a pool id is keccak256 of its PoolKey`);
  }
});

test('every deposit body the lab serves passes the runtime and the producer rules the runtime does not check (rugged97 on #40 and #72)', () => {
  const corpus = depositCorpus();
  for (const name of Object.keys(DERIVED)) assert.ok(corpus.some((entry) => entry.id === `derived:${name}`), `derived:${name} is in the corpus`);
  assert.ok(corpus.length > Object.keys(DERIVED).length * 2, `${corpus.length} bodies`);
  for (const { id, route, body } of corpus) {
    assert.ok(depositRuntime.validateResponse(route, body), `${id} passes the runtime`);
    assert.deepEqual(depositRuleViolations(route, body), [], id);
  }
  assert.deepEqual([...OWNER_CONTROLS], ['foreign-get', 'foreign-list'], 'only the owner-binding controls are left out');
});

test('the deposit rules catch what rugged97 found, and pass the producer shapes beside them', () => {
  const confirmed = () => clone(fixture('deposit-v1', 'variants/confirmed.json'));
  const step = (body) => body.operation.history.at(-1);

  const reorgedWithReceipt = confirmed();
  reorgedWithReceipt.operation.state = 'attention';
  reorgedWithReceipt.operation.outstanding = true;
  step(reorgedWithReceipt).reconciliationState = 'reorged';
  assert.match(depositRuleViolations('get', reorgedWithReceipt).join(), /a reorged observation carries no receipt/);
  step(reorgedWithReceipt).receipt = null;
  assert.deepEqual(depositRuleViolations('get', reorgedWithReceipt), []);

  const confirmedProvisional = confirmed();
  step(confirmedProvisional).receipt.finality = 'provisional';
  assert.match(depositRuleViolations('get', confirmedProvisional).join(), /confirmed only on a finalized, successful receipt/);

  const aloneInAttention = clone(reorgedWithReceipt);
  aloneInAttention.operation.outstanding = false;
  assert.match(depositRuleViolations('get', aloneInAttention).join(), /needs the newer reservation beside it/);
  const newer = clone(fixture('deposit-v1', 'variants/pending.json')).operation;
  newer.id = '00000000-0000-4000-8000-000000000099';
  assert.deepEqual(depositRuleViolations('list', listBody([newer, aloneInAttention.operation])), [], 'beside the newer reservation it is the producer shape');

  const cancelledEarly = clone(fixture('deposit-v1', 'responses/get.json'));
  cancelledEarly.operation.state = 'cancel_requested';
  assert.match(depositRuleViolations('get', cancelledEarly).join(), /only an operation with an issued step is cancel_requested/);
  assert.deepEqual(depositRuleViolations('get', DERIVED.cancel_requested.build(depositSource)), []);
});
