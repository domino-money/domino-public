import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { historyIsCurrent, historyLoadQuality, HISTORY_CURRENT_MS } = require('../.test-build/app/src/lib/fees/freshness.js');
const { STATE_REFRESH_MS } = require('../.test-build/app/src/lib/fees/constants.js');
const { visibleAmountQuality } = require('../.test-build/app/src/components/positions/valueReadiness.js');

test('current history requires its original chain timestamp to be within two refresh windows', () => {
  const timestamp = 1_800_000_000;
  const view = { phase: 'verified', state: { timestamp } };
  assert.equal(HISTORY_CURRENT_MS, 2 * STATE_REFRESH_MS);
  assert.equal(historyLoadQuality(view, timestamp * 1000), 'current');
  assert.equal(historyIsCurrent(view, timestamp * 1000 + HISTORY_CURRENT_MS), true);
  const staleAt = timestamp * 1000 + HISTORY_CURRENT_MS + 1;
  assert.equal(historyIsCurrent(view, staleAt), false);
  assert.equal(historyLoadQuality(view, staleAt), 'cached');
  assert.equal(historyLoadQuality(view, staleAt + 600_000), 'cached', 'reading the view again never renews its age');
  assert.equal(view.state.timestamp, timestamp);
});

test('a saved replay is never current, and a sampled replay keeps its estimate qualification while recent', () => {
  const timestamp = 1_800_000_000, now = timestamp * 1000 + 5_000;
  for (const savedAt of [now, now - 1]) {
    const cached = { phase: 'cached', state: { timestamp }, savedAt };
    assert.equal(historyIsCurrent(cached, now), false);
    assert.equal(historyLoadQuality(cached, now), 'cached');
  }
  const estimated = { phase: 'estimated', state: { timestamp } };
  assert.equal(historyLoadQuality(estimated, now), 'estimated');
  assert.equal(historyLoadQuality(estimated, now + HISTORY_CURRENT_MS), 'cached');
  for (const phase of ['loading', 'idle', 'unclaimed-only', 'unavailable']) {
    assert.equal(historyIsCurrent({ phase }, now), false);
    assert.equal(historyLoadQuality({ phase }, now), null);
  }
});

test('a future or invalid timestamp cannot turn a reused history into current data', () => {
  for (const timestamp of [1_900_000_000, NaN, Infinity]) {
    assert.equal(historyLoadQuality({ phase: 'verified', state: { timestamp } }, 1_800_000_000_000), 'cached');
  }
});

test('value readiness requires displayed numeric token amounts, including real zero but never raw or missing decimals', () => {
  const amounts = (...kinds) => kinds.map(kind => ({ kind }));
  assert.equal(visibleAmountQuality(amounts('raw', 'unread')), null);
  assert.equal(visibleAmountQuality(amounts('raw', 'raw')), null);
  assert.equal(visibleAmountQuality([]), null);
  assert.equal(visibleAmountQuality(amounts('units', 'raw')), 'partial');
  assert.equal(visibleAmountQuality(amounts('zero', 'unread')), 'partial');
  assert.equal(visibleAmountQuality(amounts('units', 'zero')), 'current');
  assert.equal(visibleAmountQuality(amounts('zero', 'zero')), 'current');
});
