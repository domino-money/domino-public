import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createLoadTimings, loadScreen, MAX_LOAD_VISITS } = require('../.test-build/app/src/lib/loadTiming.js');

function rig() {
  let now = 100, visible = true;
  const sent = [], removed = [];
  const timings = createLoadTimings({ now: () => now, visible: () => visible, publish: (...args) => sent.push(args), remove: (name) => removed.push(name) });
  return { timings, sent, removed, at: (value) => { now = value; }, visible: (value) => { visible = value; timings.visibility(); } };
}

test('cached, estimated and current UI milestones remain separate and count once per visit', () => {
  const r = rig(), id = r.timings.begin('position');
  r.at(110); r.timings.ready(id, 'chart', 'cached');
  r.at(500); r.timings.ready(id, 'chart', 'estimated');
  r.at(900); r.timings.ready(id, 'chart', 'current');
  r.at(950); r.timings.ready(id, 'chart', 'current');
  assert.deepEqual(r.timings.snapshot()[0].readings.map(({ quality, ms }) => [quality, ms]), [['cached', 10], ['estimated', 400], ['current', 800]]);
  assert.equal(r.sent.length, 3);
});
test('a late answer from another visit cannot improve the next visit and unknown input records nothing', () => {
  const r = rig(), first = r.timings.begin('position');
  r.at(200); r.timings.begin('position');
  r.timings.ready(first, 'apr', 'current');
  r.timings.ready(2, 'wallet-secret', 'current');
  r.timings.ready(2, 'apr', 'invented');
  assert.deepEqual(r.timings.snapshot().map((v) => v.readings), [[], []]);
});
test('missing information stays unmeasured, and backgrounded visits are marked rather than sold as latency', () => {
  const r = rig(), id = r.timings.begin('markets');
  assert.equal(r.sent.length, 0);
  r.visible(false); r.visible(true);
  r.at(200); r.timings.ready(id, 'tvl', 'current');
  const sample = r.timings.snapshot()[0].readings[0];
  assert.equal(sample.backgrounded, true);
  assert.equal(sample.ms, 100);
});
test('route classification never retains token, wallet or NFT values', () => {
  assert.equal(loadScreen('#/positions/12345'), 'position');
  assert.equal(loadScreen('#/positions'), 'positions');
  assert.equal(loadScreen('#/app'), 'positions');
  assert.equal(loadScreen('#/markets/0xsecret'), 'markets');
  assert.equal(loadScreen('#/pool/0xsecret'), 'pool');
  assert.equal(loadScreen('#/#pools'), 'overview');
  assert.equal(loadScreen('#/unknown/0xsecret'), 'other');
  const r = rig(), id = r.timings.begin(loadScreen('#/positions/12345'));
  r.timings.ready(id, 'value', 'current');
  assert.doesNotMatch(JSON.stringify([r.sent, r.timings.snapshot()]), /12345|0xsecret/);
});
test('memory and User Timing entries are bounded and caller mutations cannot alter measurements', () => {
  const r = rig();
  for (let i = 0; i < MAX_LOAD_VISITS + 5; i++) {
    const id = r.timings.begin('markets');
    r.timings.ready(id, 'tvl', 'current');
  }
  assert.equal(r.timings.snapshot().length, MAX_LOAD_VISITS);
  assert.equal(r.removed.length, 5);
  r.timings.snapshot()[0].readings[0].ms = 999;
  assert.equal(r.timings.snapshot()[0].readings[0].ms, 0);
});
test('unsupported diagnostics do not interrupt readiness and invalid clocks are ignored', () => {
  let now = 10;
  const t = createLoadTimings({ now: () => now, visible: () => true, publish: () => { throw new Error('unsupported'); }, remove: () => { throw new Error('unsupported'); } });
  const id = t.begin('pool');
  now = 9; t.ready(id, 'chart', 'current');
  now = NaN; t.ready(id, 'chart', 'current');
  assert.equal(t.snapshot()[0].readings.length, 0);
  now = 12;
  assert.doesNotThrow(() => t.ready(id, 'chart', 'current'));
  assert.equal(t.snapshot()[0].readings[0].ms, 2);
  assert.equal(t.begin('wallet-secret'), 0);
});
