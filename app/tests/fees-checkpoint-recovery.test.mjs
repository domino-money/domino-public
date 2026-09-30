/** Transient read recovery keeps only completely replayed prefixes; all accounting gates still run. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fixtureRelay, loadCase, quietProbes, stateOfCase } from './support/fees/relay-fixture.mjs';
import { loadPath, pathRelay, pathState } from './support/fees/path-fixture.mjs';

const require = createRequire(import.meta.url);
const { runPipeline } = require('../.test-build/app/src/lib/fees/pipeline.js');
const { BUDGET_BYTES, SPAN_CAP_BYTES, PATH_REFINE_MS } = require('../.test-build/app/src/lib/fees/constants.js');
const BIG = 64 * 1024 * 1024;
const DAY = 864_000;
const quiet = { sleep: async () => {} };
const unavailable = { ok: false, failure: 'unavailable', retryAfterMs: 0 };

function exact() {
  const fixture = loadCase('3136705');
  const makeRelay = (extra = {}) => fixtureRelay(fixture, { maxDays: 1, script: { probe: quietProbes(fixture) }, ...extra });
  return { fixture, makeRelay, run: { id: fixture.id, ...stateOfCase(fixture), budgetBytes: BIG, checkpoint: null } };
}

async function interruptedExact(makeRelay, run, failure = unavailable) {
  const relay = makeRelay();
  const requests = [];
  let completed = 0;
  const result = await runPipeline({ ...quiet, progress: () => completed++, logs: async (request) => {
    requests.push(request);
    // The exact pipeline prefetches the next day before applying this one: fail that pending read.
    if (request.kind === 'swaps' && requests.filter((r) => r.kind === 'swaps').length >= 2) return failure;
    return relay.logs(request);
  } }, run);
  assert.equal(completed, 1);
  assert.deepEqual([result.ok, result.reason, result.later], [false, 'rpc_unavailable', true]);
  assert.ok(result.checkpoint);
  assert.equal(result.checkpoint.bytes, 0, 'the next attempt gets its own byte budget, not a free larger current run');
  assert.equal(result.checkpoint.through, (Math.floor(run.state.block / DAY) * DAY) - 1);
  assert.ok(result.checkpoint.replay.last[0] <= result.checkpoint.through);
  assert.equal(result.prices, null, 'a checkpoint is not a verified display result');
  return { result, requests };
}

test('an exact replay resumes after transient failure at the same or a newer state, equals a cold run, and reads less', async (t) => {
  const { makeRelay, run } = exact();
  const { result: stopped } = await interruptedExact(makeRelay, run);
  const saved = structuredClone(stopped.checkpoint);
  for (const advance of [0, 1]) {
    // The fixture has no events after its captured state; this synthetic next block changes time only.
    const next = { ...run, state: { ...run.state, block: run.state.block + advance, timestamp: run.state.timestamp + advance } };
    const coldRelay = makeRelay();
    const cold = await runPipeline({ ...quiet, logs: coldRelay.logs }, next);
    const warmRelay = makeRelay();
    const warm = await runPipeline({ ...quiet, logs: warmRelay.logs }, { ...next, checkpoint: stopped.checkpoint });
    assert.equal(cold.ok, true, cold.reason);
    assert.equal(warm.ok, true, warm.reason);
    assert.deepEqual(warm.history, cold.history);
    assert.deepEqual(warm.prices, cold.prices);
    assert.deepEqual(stopped.checkpoint, saved, 'the supplied prefix is immutable across retries');
    assert.ok(!warmRelay.requests.some((r) => ['transfer', 'initialize', 'probe', 'swapBefore'].includes(r.kind)));
    assert.ok(warmRelay.requests.filter((r) => r.kind === 'swaps').every((r) => r.day * DAY > saved.through), 'no completed swap day is re-read');
    assert.ok(warmRelay.requests.length < coldRelay.requests.length);
    t.diagnostic(`exact ${advance ? 'new' : 'same'} block: cold ${coldRelay.requests.length} relay requests, resumed ${warmRelay.requests.length}`);
  }
});

test('a price path resumes only after its fully applied span and matches cold history and prices', async (t) => {
  const id = '3202568';
  const fixture = loadPath('path-pons');
  const run = { id, ...pathState(fixture, id), budgetBytes: BIG, checkpoint: null };
  const firstRelay = pathRelay(fixture, id);
  let completed = 0;
  const stopped = await runPipeline({ ...quiet, progress: () => completed++, logs: (request) =>
    request.kind === 'span' && completed >= 2 ? Promise.resolve(unavailable) : firstRelay.logs(request),
  }, run);
  assert.deepEqual([stopped.ok, stopped.reason, stopped.later], [false, 'rpc_unavailable', true]);
  assert.equal(completed, 2);
  assert.ok(stopped.checkpoint.path);
  assert.ok(stopped.checkpoint.through < run.state.block);
  const coldRelay = pathRelay(fixture, id);
  const cold = await runPipeline({ ...quiet, logs: coldRelay.logs }, run);
  const warmRelay = pathRelay(fixture, id);
  const warm = await runPipeline({ ...quiet, logs: warmRelay.logs }, { ...run, checkpoint: stopped.checkpoint });
  assert.equal(cold.ok, true, cold.reason);
  assert.equal(warm.ok, true, warm.reason);
  assert.deepEqual(warm.history, cold.history);
  assert.deepEqual(warm.prices, cold.prices);
  assert.ok(warmRelay.requests.filter((r) => r.kind === 'span').every((r) => r.spans.every(([from]) => from > stopped.checkpoint.through)));
  assert.ok(warmRelay.requests.filter((r) => r.kind === 'settlements' || r.kind === 'modifies').every((r) => (r.from ?? r.spans[0][0]) > stopped.checkpoint.through));
  assert.ok(warmRelay.requests.length < coldRelay.requests.length);
  t.diagnostic(`path: cold ${coldRelay.requests.length} relay requests, resumed ${warmRelay.requests.length}`);
});

test('background refinement never amplifies its byte budget, keeps coherent progress, and foreground resumes to the same verified result', async (t) => {
  const id = '3202568';
  const fixture = loadPath('path-pons');
  const base = { id, ...pathState(fixture, id), checkpoint: null };
  for (const offered of [false, true]) {
    const relay = pathRelay(fixture, id);
    let bytes = 0;
    let extensions = 0;
    const result = await runPipeline({ ...quiet, ...(offered ? { extend: () => extensions++ } : {}), logs: async (request) => {
      assert.ok(bytes < BUDGET_BYTES.list, 'no background read starts after its existing budget is spent');
      const answer = await relay.logs(request);
      if (answer.ok) bytes += answer.bytes;
      return answer;
    } }, { ...base, budgetBytes: BUDGET_BYTES.list });
    assert.deepEqual([result.ok, result.reason, result.later], [false, 'too_much_history', true]);
    assert.equal(extensions, 0, 'a list-sized run is never authorized to extend');
    assert.ok(result.checkpoint && result.checkpoint.through < base.state.block);
    assert.ok(bytes >= BUDGET_BYTES.list && bytes <= BUDGET_BYTES.list + SPAN_CAP_BYTES, 'at most the final bounded span crosses the cap');
    const cold = await runPipeline({ ...quiet, logs: pathRelay(fixture, id).logs }, { ...base, budgetBytes: BIG });
    const resumed = await runPipeline({ ...quiet, logs: pathRelay(fixture, id).logs }, { ...base, budgetBytes: BIG, checkpoint: result.checkpoint });
    assert.equal(resumed.ok, true, resumed.reason);
    assert.deepEqual(resumed.history, cold.history);
    assert.deepEqual(resumed.prices, cold.prices);
    t.diagnostic(`background ${offered ? 'with rejected capability' : 'without capability'}: ${bytes} B, cap ${BUDGET_BYTES.list} B plus one bounded span`);
  }
  const extensions = [];
  const foreground = await runPipeline({ ...quiet, logs: pathRelay(fixture, id).logs, extend: (ms) => extensions.push(ms) }, { ...base, budgetBytes: BUDGET_BYTES.page });
  assert.equal(foreground.ok, true, foreground.reason);
  assert.deepEqual(extensions, [PATH_REFINE_MS], 'foreground retains its explicitly authorized refinement');
});

test('a resumed prefix survives another transient failure before any new progress, but an initial failure keeps nothing', async () => {
  const { makeRelay, run } = exact();
  const { result: stopped } = await interruptedExact(makeRelay, run);
  const again = await runPipeline({ ...quiet, logs: async () => unavailable }, { ...run, checkpoint: stopped.checkpoint });
  assert.equal(again.reason, 'rpc_unavailable');
  assert.deepEqual(again.checkpoint, stopped.checkpoint);
  assert.equal(again.later, true);
  const early = await runPipeline({ ...quiet, logs: async () => unavailable }, run);
  assert.equal(early.reason, 'rpc_unavailable');
  assert.equal(early.checkpoint, null);
  assert.equal(early.later, undefined);
});

test('exhausted rate-limit and lagging-head retries retain only the preceding completed day', async () => {
  const { makeRelay, run } = exact();
  for (const refusal of [
    { ok: false, failure: 'rate_limited', retryAfterMs: 1 },
    { ok: true, value: { v: 1, kind: 'swaps', behind: true }, bytes: 40 },
  ]) {
    const { result } = await interruptedExact(makeRelay, run, refusal);
    const recovered = await runPipeline({ ...quiet, logs: makeRelay().logs }, { ...run, checkpoint: result.checkpoint });
    assert.equal(recovered.ok, true, recovered.reason);
  }
});

test('identity, range, future-block and incoherent replay checkpoints restart rather than trusting the wrong prefix', async () => {
  const { makeRelay, run } = exact();
  const { result: stopped } = await interruptedExact(makeRelay, run);
  const mutations = [
    (cp) => { cp.tokenId = '1'; },
    (cp) => { cp.poolId = `0x${'12'.repeat(32)}`; },
    (cp) => { cp.tickLower += 1; },
    (cp) => { cp.tickUpper += 1; },
    (cp) => { cp.through = run.state.block + 1; },
    (cp) => { cp.replay.last[0] = cp.through + 1; },
    (cp) => { cp.replay.target.tokenId = 1n; },
  ];
  for (const mutate of mutations) {
    const checkpoint = structuredClone(stopped.checkpoint);
    mutate(checkpoint);
    const relay = makeRelay();
    const result = await runPipeline({ ...quiet, logs: relay.logs }, { ...run, checkpoint });
    assert.equal(result.ok, true, result.reason);
    assert.ok(relay.requests.some((r) => r.kind === 'transfer'), 'incompatible prefix ignored');
  }
});

test('checkpoint recovery still checks the current state: a changed fee or price is replay_mismatch without a checkpoint', async () => {
  const { makeRelay, run } = exact();
  const { result: stopped } = await interruptedExact(makeRelay, run);
  for (const state of [
    { ...run.state, unclaimed: [run.state.unclaimed[0] + 1n, run.state.unclaimed[1]] },
    { ...run.state, sqrtPriceX96: run.state.sqrtPriceX96 + 1n },
  ]) {
    const result = await runPipeline({ ...quiet, logs: makeRelay().logs }, { ...run, state, checkpoint: stopped.checkpoint });
    assert.equal(result.reason, 'replay_mismatch');
    assert.equal(result.checkpoint, null);
    assert.equal(result.later, undefined);
  }
});

test('a malformed later unit never saves a partially mutated replay, and a bad request is not a transient checkpoint', async () => {
  const { makeRelay, run } = exact();
  const { result: stopped } = await interruptedExact(makeRelay, run);
  const relay = makeRelay();
  const malformed = await runPipeline({ ...quiet, logs: async (request) => {
    const answer = await relay.logs(request);
    if (request.kind === 'swaps' && answer.ok) {
      const log = answer.value.units[0].logs.find((entry) => entry[2] === 3 && entry[0] > stopped.checkpoint.through);
      assert.ok(log);
      log[5] = '0x01'; // apply() has already updated its last log before dataWords rejects this.
    }
    return answer;
  } }, { ...run, checkpoint: stopped.checkpoint });
  assert.equal(malformed.reason, 'replay_mismatch');
  assert.equal(malformed.checkpoint, null);
  const bad = await runPipeline({ ...quiet, logs: async () => ({ ok: false, failure: 'bad_request', retryAfterMs: 0 }) }, { ...run, checkpoint: stopped.checkpoint });
  assert.equal(bad.reason, 'rpc_unavailable');
  assert.equal(bad.checkpoint, null);
});

test('a shortened day, missing epoch or skipped day cursor cannot be recorded as a complete prefix', async () => {
  const { makeRelay, run } = exact();
  for (const corrupt of ['day', 'epoch', 'cursor']) {
    const relay = makeRelay();
    const result = await runPipeline({ ...quiet, logs: async (request) => {
      const answer = await relay.logs(request);
      if (answer.ok && 'units' in answer.value) {
        if ((corrupt === 'day' && request.kind === 'swaps') || (corrupt === 'epoch' && request.kind === 'pool')) answer.value.units[0].to -= 1;
        if (corrupt === 'cursor' && request.kind === 'swaps') answer.value.next = request.day + answer.value.units.length + 1;
      }
      return answer;
    } }, run);
    assert.equal(result.reason, 'rpc_unavailable');
    assert.equal(result.checkpoint, null);
    assert.equal(result.later, undefined);
  }
});
