/**
 * Your APR on the Your positions table (src/components/positions/listApr.ts, round 6, 2026-09-27: the owner asked for
 * each position's APR on the list). The figure is the page's own (lib/positionApr.ts on the same fees history), shown at
 * once when the fees store holds that history.
 *
 * Changed on purpose (2026-09-28, hotfix: from that morning, for everyone, a position's Fees earned chart and Your APR
 * often did not show, and it took many reloads): the list measures nothing itself any more. Its queue (these tests drove
 * it with a fake store and clock, and with the real store) replayed each open position's history from the list at a
 * page's budget; live, it drew the RPC's refusals of the list's own read, and a history it could not finish stayed the
 * store's answer, so the position's page opened from the list read nothing more until a reload. A row whose page did not
 * draw its history this visit shows the calm dash; nothing asks the fees store for a history from the list.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const listApr = require('../.test-build/app/src/components/positions/listApr.js');
const { aprOfView, rowAprs } = listApr;
const { APR_MISSING, aprText, positionApr } = require('../.test-build/app/src/lib/positionApr.js');

const HOUR = 3_600;
const T0 = 1_790_000_000;
const Q96 = 2n ** 96n;
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

/** A position's state (USDG its second side, 6 decimals both, price 1) and a history of `hours` hours earning 1 USDG an hour. */
function drawn(phase, hours = 48) {
  const state = { block: 100, timestamp: T0 + hours * HOUR, unclaimed: [0n, 0n], sqrtPriceX96: Q96, tick: 0, tickLower: -600, tickUpper: 600, liquidity: 10n ** 12n, poolId: `0x${'aa'.repeat(32)}`, owner: '0x1', currencies: [{ address: '0xa', symbol: 'A', decimals: 6 }, { address: USDG, symbol: 'USDG', decimals: 6 }] };
  const hourly = Array.from({ length: hours }, (_, i) => ({ anchor: i, t: T0 + (i + 1) * HOUR, earned: [0n, BigInt((i + 1) * 1e6)], collected: [0n, 0n], inRangeSeconds: HOUR, sqrtPriceX96Close: Q96, tickClose: 0 }));
  const history = { mintedAt: { block: 1, timestamp: T0 }, earned: [0n, BigInt(hours * 1e6)], collected: [0n, 0n], timeInRange: { inSeconds: hours * HOUR, totalSeconds: hours * HOUR }, hourly, events: [{ kind: 'mint', block: 1, timestamp: T0, tx: '0x1', fees: [0n, 0n], liquidityDelta: 10n ** 12n }], checks: {} };
  return { phase, state, history, prices: { hours: [] } };
}

test('the list’s APR is the page’s own: the same history, the same arithmetic, the same words', () => {
  const view = drawn('verified');
  const expected = positionApr(view.history, view.state, 1, 'all');
  assert.equal(expected.ok, true);
  assert.deepEqual(aprOfView(view), { kind: 'rate', text: aprText(expected.rate), estimated: false });
  assert.equal(aprOfView(view), aprOfView(view), 'worked out once per history');
  assert.deepEqual(aprOfView(drawn('estimated')), { kind: 'rate', text: aprText(expected.rate), estimated: true }, 'a busy pool’s estimate says so');
  // Under six hours: no rate, and the page's own reason.
  assert.deepEqual(aprOfView(drawn('verified', 3)), { kind: 'missing', words: APR_MISSING.short });
  for (const phase of ['idle', 'loading', 'unclaimed-only', 'unavailable']) assert.equal(aprOfView({ phase, state: null, reason: 'rpc_unavailable' }), null);
});

test('each row shows the history its page drew this visit (the fees store’s view), and a calm dash otherwise', () => {
  const views = new Map([['1', drawn('verified')], ['2', drawn('estimated')], ['3', { phase: 'idle' }], ['4', { phase: 'loading', state: null }], ['5', { phase: 'unclaimed-only', state: null, reason: 'too_much_history' }]]);
  const aprs = rowAprs(['1', '2', '3', '4', '5', '6'], views);
  assert.equal(aprs.get('1').kind, 'rate');
  assert.equal(aprs.get('2').estimated, true);
  for (const id of ['3', '4', '5', '6']) assert.deepEqual(aprs.get(id), { kind: 'none' }, `row ${id}: a dash, never a pulse that waits for a measurement`);
  assert.deepEqual([...aprs.keys()], ['1', '2', '3', '4', '5', '6'], 'in the list’s order');
});

test('the list has no measuring queue to start: nothing in listApr.ts or on the list asks the fees store for a history', async () => {
  const { readFileSync } = await import('node:fs');
  assert.deepEqual(Object.keys(listApr).sort(), ['aprOfView', 'rowAprs']);
  const source = (path) => readFileSync(new URL(`../src/components/positions/${path}`, import.meta.url), 'utf8');
  for (const path of ['listApr.ts', 'OwnedPositions.tsx', 'PositionRow.tsx']) {
    assert.doesNotMatch(source(path), /subscribeHistory|useFeeHistor(?:y|ies)\(|createAprQueue|__dominoListApr|IntersectionObserver/, path);
  }
  // The list only watches the store's views (their changes), as the page's own reads fill them.
  assert.match(source('OwnedPositions.tsx'), /feesStore\.watch\(/);
});
