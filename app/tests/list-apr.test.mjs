/** Pure list APR presentation: identical detail arithmetic, saved provenance, and how the list asks its ledgers.
 * Changed on purpose 2026-10-02 (RPC-SPEC §11.4): the list asks every open row's ledger, eight ids a request (the fees
 * store's 'list' scope), where a bounded queue warmed a few visible rows one replay at a time; there is no estimate.
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

/** A position's state (USDG its second side, 6 decimals both, price 1) and a history of `hours` hours that earned 1 USDG an hour. */
function drawn(phase, hours = 48) {
  const state = { block: 100, timestamp: T0 + hours * HOUR, unclaimed: [0n, 0n], sqrtPriceX96: Q96, tick: 0, tickLower: -600, tickUpper: 600, liquidity: 10n ** 12n, poolId: `0x${'aa'.repeat(32)}`, owner: '0x1', currencies: [{ address: '0xa', symbol: 'A', decimals: 6 }, { address: USDG, symbol: 'USDG', decimals: 6 }] };
  const earned = [0n, BigInt(hours * 1e6)];
  const points = [{ block: 1, t: T0, earned: [0n, 0n], collected: [0n, 0n], kind: 'opened' }, { block: 100, t: T0 + hours * HOUR, earned, collected: [0n, 0n], kind: 'now' }];
  const history = { mintedAt: { block: 1, timestamp: T0 }, earned, collected: [0n, 0n], points, events: [{ kind: 'mint', block: 1, timestamp: T0, tx: '0x1', fees: [0n, 0n], liquidityDelta: 10n ** 12n }], through: 100 };
  return { phase, state, history };
}

test('the list’s APR is the page’s own: the same history, the same arithmetic, the same words', () => {
  const view = drawn('verified');
  const expected = positionApr(view.history, view.state, 1, 'all');
  assert.equal(expected.ok, true);
  assert.deepEqual(aprOfView(view), { kind: 'rate', text: aprText(expected.rate) });
  assert.equal(aprOfView(view), aprOfView(view), 'worked out once per history');
  // Under six hours: no rate, and the page's own reason.
  assert.deepEqual(aprOfView(drawn('verified', 3)), { kind: 'missing', words: APR_MISSING.short });
  for (const phase of ['idle', 'loading', 'unclaimed-only', 'unavailable']) assert.equal(aprOfView({ phase, state: null, reason: 'rpc_unavailable' }), null);
});

test('a saved history keeps the same calculation but carries its original age and never claims a current rate', () => {
  const view = { ...drawn('cached'), savedAt: (T0 + 49 * HOUR) * 1000, source: 'public-chain-ledger' };
  delete view.state.owner;
  const expected = positionApr(view.history, view.state, 1, 'all');
  assert.equal(expected.ok, true);
  assert.deepEqual(aprOfView(view), { kind: 'rate', text: aprText(expected.rate), saved: { at: view.savedAt, block: view.state.block, timestamp: view.state.timestamp } });
  const short = { ...drawn('cached', 3), savedAt: view.savedAt, source: view.source };
  assert.deepEqual(aprOfView(short), { kind: 'missing', words: `Saved history: ${APR_MISSING.short}. Not current.` });
});

test('each row shows its ledger’s rate, a skeleton while it is read, “not measured” for a ledger that cannot measure it, and a calm dash otherwise', () => {
  const views = new Map([
    ['1', drawn('verified')],
    ['3', { phase: 'idle' }],
    ['4', { phase: 'loading', state: null }],
    ['5', { phase: 'unclaimed-only', state: null, reason: 'not_exact', why: 'manual' }],
    ['7', { phase: 'unclaimed-only', state: null, reason: 'rpc_unavailable' }],
  ]);
  const aprs = rowAprs(['1', '3', '4', '5', '6', '7'], views);
  assert.equal(aprs.get('1').kind, 'rate');
  assert.deepEqual(aprs.get('4'), { kind: 'loading' }, 'row 4: read now');
  // Changed on purpose 2026-10-02 (review of the rules, finding 11): its short word, said beside the dash, not "on its page".
  assert.deepEqual(aprs.get('5'), { kind: 'missing', words: 'Not measured for this position', short: 'not measured' });
  for (const id of ['3', '6', '7']) assert.deepEqual(aprs.get(id), { kind: 'none' }, `row ${id}: a dash`);
  assert.deepEqual([...aprs.keys()], ['1', '3', '4', '5', '6', '7'], 'in the list’s order');
});

test('the wallet’s own open rows ask their ledgers in one subscription of the list; another address’s list asks nothing, and rows only watch', async () => {
  const { readFileSync } = await import('node:fs');
  assert.deepEqual(Object.keys(listApr).sort(), ['aprOfView', 'rowAprs']);
  const source = (path) => readFileSync(new URL(`../src/components/positions/${path}`, import.meta.url), 'utf8');
  for (const path of ['listApr.ts', 'PositionRow.tsx']) assert.doesNotMatch(source(path), /subscribeHistory|useFeeHistor(?:y|ies)\(|IntersectionObserver/, path);
  const owned = source('OwnedPositions.tsx');
  // Changed on purpose 2026-10-01 (audit V7): another address's list (View address) reads no history ahead at all.
  assert.match(owned, /useRowAprs\(measured, !readOnly && fresh && tab === 'open' && !refunding\)/);
  assert.match(owned, /feesStore\.subscribeHistory\(key\.split\(','\), 'list', quiet\)/);
  assert.match(owned, /feesStore\.watch\(/);
  assert.doesNotMatch(owned, /useAprPrefetch|IntersectionObserver/);
});
