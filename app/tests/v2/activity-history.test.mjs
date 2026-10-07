import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { createActivityHistory } = require('../../.test-build/app/src/v2in/lists/activityHistory.js');
const { privateTimes, positionActivity, timelineRows } = require('../../.test-build/app/src/v2in/lists/activityModel.js');
const fixture = JSON.parse(readFileSync(new URL('../../../api-contracts/read-v6/fixtures/valid/activity.json', import.meta.url)));
const portfolio = JSON.parse(readFileSync(new URL('../../../api-contracts/read-v6/fixtures/valid/portfolio.json', import.meta.url)));
const wire = JSON.parse(readFileSync(new URL('../../../api-contracts/execution-v1/fixtures/status-wire.json', import.meta.url)));
const wallet = fixture.wallet;
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
const item = (n, extra = {}) => ({ ...structuredClone(fixture.items[0]), id: `4663:${n}:1`, chainId: 4663,
  tx: { ...structuredClone(fixture.items[0].tx), hash: `0x${n.toString(16).padStart(64, '0')}`, snapshot: { number: n, hash: `0x${n.toString(16).padStart(64, '0')}`, timestamp: n }, finality: 'finalized' }, ...extra });
const range = (top, bottom) => Array.from({ length: top - bottom + 1 }, (_, i) => item(top - i));
const page = (items, cursor = null, extra = {}) => ({ kind: 'ok', body: { ...structuredClone(fixture), items, nextCursor: cursor, ...extra } });
function clock() {
  let now = 0, visible = true;
  const jobs = new Set(), wake = new Set();
  return {
    timers: { set(fn, ms) { const job = { fn, at: now + ms }; jobs.add(job); return job; }, clear(job) { jobs.delete(job); }, visible: () => visible,
      onVisible(fn) { wake.add(fn); return () => wake.delete(fn); } },
    async tick(ms) { now += ms; for (const job of [...jobs]) if (job.at <= now) { jobs.delete(job); job.fn(); await flush(); } },
    show(next) { visible = next; if (next) for (const fn of [...wake]) { wake.delete(fn); fn(); } },
  };
}

test('pagination survives navigation, deduplicates operation ids and retains metadata from older pages', async () => {
  const time = clock(), asks = [];
  const oldToken = { ...fixture.tokens[0], address: '0x1212121212121212121212121212121212121212' };
  const history = createActivityHistory(async (_, p) => { asks.push(p); return p.cursor ? page(range(21, 2), null, { tokens: [oldToken] }) : page(range(40, 21), 'older'); }, time.timers, false);
  const stop = history.subscribe(wallet, () => {}); await flush();
  history.more(wallet); await flush();
  assert.equal(history.get(wallet).answer.items.length, 39);
  assert.equal(new Set(history.get(wallet).answer.items.map(x => x.id)).size, 39);
  assert.ok(history.get(wallet).answer.tokens.some(x => x.address === oldToken.address));
  assert.ok(history.get(wallet).answer.tokens.some(x => x.address === fixture.tokens[0].address));
  stop(); const stopAgain = history.subscribe(wallet, () => {}); await flush();
  assert.equal(asks.length, 2, 'overview/full navigation reuses the loaded tail');
  stopAgain();
});

test('a failed older page retains its cursor and retries after the named delay without losing loaded rows', async () => {
  const time = clock(), asks = [];
  const history = createActivityHistory(async (_, p) => { asks.push(p); return asks.length === 1 ? page(range(40, 21), 'older') : asks.length === 2 ? { kind: 'unavailable', reason: 'upstream_unavailable', retryAfterSeconds: 12 } : page(range(20, 1)); }, time.timers, false);
  const stop = history.subscribe(wallet, () => {}); await flush(); history.more(wallet); await flush();
  assert.equal(history.get(wallet).more, true);
  assert.equal(history.get(wallet).loading, false);
  assert.equal(history.get(wallet).answer.items.length, 20);
  history.more(wallet); await flush(); await time.tick(11_999);
  assert.equal(asks.length, 2, 'manual requests cannot bypass Retry-After');
  await time.tick(1);
  assert.equal(asks[2].cursor, 'older');
  assert.equal(history.get(wallet).answer.items.length, 40);
  assert.equal(history.get(wallet).error, null); stop();
});

test('refresh catches a gap larger than one page before joining the preserved older tail', async () => {
  const time = clock(); let round = 0;
  const history = createActivityHistory(async (_, p) => {
    if (!p.cursor) return ++round === 1 ? page(range(40, 21), 'old') : page(range(80, 61), 'gap1');
    return p.cursor === 'old' ? page(range(20, 1)) : p.cursor === 'gap1' ? page(range(60, 41), 'gap2') : page(range(40, 21), 'old');
  }, time.timers, false);
  const stop = history.subscribe(wallet, () => {}); await flush(); history.more(wallet); await flush();
  history.refresh(wallet); await flush(); assert.equal(history.get(wallet).catchingUp, true);
  await time.tick(1000); await time.tick(1000);
  assert.equal(history.get(wallet).catchingUp, false);
  assert.equal(history.get(wallet).more, false);
  assert.deepEqual(history.get(wallet).answer.items.map(x => x.tx.snapshot.number), Array.from({ length: 80 }, (_, i) => 80 - i));
  stop();
});

test('empty and filtered pages retain a path onward; errors never masquerade as an exhausted history', async () => {
  const time = clock(); let asks = 0;
  const history = createActivityHistory(async () => ++asks === 1 ? page([], 'next') : page([item(1)]), time.timers, false);
  const stop = history.subscribe(wallet, () => {}); await flush();
  assert.equal(history.get(wallet).more, true); history.more(wallet); await flush();
  assert.equal(history.get(wallet).answer.items.length, 1); stop();
});

test('an exceptional rejection clears loading and is retried; hidden views and other wallets stay isolated', async () => {
  const time = clock(), asks = []; let fail = true;
  const history = createActivityHistory(async (owner) => { asks.push(owner); if (fail) { fail = false; throw Error('offline'); } return page([item(owner === wallet ? 4 : 9)], null, { wallet: owner }); }, time.timers, false);
  const stop = history.subscribe(wallet, () => {}); await flush();
  assert.equal(history.get(wallet).loading, false); await time.tick(5000);
  time.show(false); const other = '0x2222222222222222222222222222222222222222'; const stopOther = history.subscribe(other, () => {}); await flush();
  assert.equal(history.get(other).answer, null); assert.equal(asks.length, 2);
  time.show(true); await flush(); assert.equal(history.get(other).answer.wallet, other);
  assert.equal(history.get(wallet).answer.items[0].tx.snapshot.number, 4); stop(); stopOther();
});

test('a complete empty refresh removes old unfinalized records, but a partial answer cannot erase them', async () => {
  for (const coverage of ['complete', 'partial']) {
    const time = clock(); let count = 0;
    const tentative = item(2); tentative.tx.finality = 'unfinalized';
    const history = createActivityHistory(async () => ++count === 1 ? page([tentative]) : page([], null, { coverage }), time.timers, false);
    const stop = history.subscribe(wallet, () => {}); await flush(); history.refresh(wallet); await flush();
    assert.equal(history.get(wallet).answer.items.length, coverage === 'complete' ? 0 : 1); stop();
  }
});

test('private dates require the exact confirmed chain, block number and block hash; cancellations stay outside timeline', () => {
  const base = { ...wire.responses['status.reserved'].item, state: 'reconciled', receipt: { transactionHash: '0x' + '1'.repeat(64), blockNumberRaw: '1234', blockHash: '0x' + '2'.repeat(64) } };
  const evidence = item(Number(base.receipt.blockNumberRaw));
  evidence.tx.snapshot.hash = base.receipt.blockHash;
  const times = privateTimes([base], [evidence]);
  assert.equal(times.get(base.intentId), evidence.tx.snapshot.timestamp);
  assert.equal(privateTimes([base], [{ ...evidence, chainId: 8453 }]).size, 0);
  const wrongHash = structuredClone(evidence); wrongHash.tx.snapshot.hash = '0x' + 'f'.repeat(64);
  assert.equal(privateTimes([base], [wrongHash]).size, 0);
  const cancelled = { ...base, intentId: 'cancelled', state: 'cancelled', receipt: null };
  const rows = timelineRows([], [base, base, cancelled]);
  assert.equal(rows.length, 1); assert.equal(rows[0].at, null);
});

test('a nonempty partial refresh preserves unfinalized events of unavailable or behind chains', async () => {
  for (const status of ['unavailable', 'stale']) {
    const time = clock(); let count = 0;
    const tentative = item(10); tentative.tx.finality = 'unfinalized';
    const chains = fixture.chains.map(chain => chain.chainId === 4663 ? { ...chain, status } : chain);
    const history = createActivityHistory(async () => ++count === 1 ? page([tentative]) : page([item(2)], null, { chains, coverage: 'partial' }), time.timers, false);
    const stop = history.subscribe(wallet, () => {}); await flush(); history.refresh(wallet); await flush();
    assert.ok(history.get(wallet).answer.items.some(row => row.id === tentative.id)); stop();
  }
});

test('four overview rows are a single total; same-transaction distinct public operations are retained', () => {
  const views = Array.from({ length: 5 }, (_, i) => ({ id: `4663:${10-i}:1`, at: 10-i, hash: 'same-tx' }));
  const privateItem = wire.responses['status.reserved'].item;
  const all = timelineRows(views, [privateItem]);
  assert.equal(all.length, 6); assert.equal(all.slice(0, 4).length, 4);
  assert.equal(all.at(-1).at, null); assert.equal(all.filter(x => x.kind === 'public').length, 5);
});

test('position history includes compound, exit and settings by proven chain/DEX/vault identity, including historical receipts', () => {
  const target = { chainId: 4663, dex: 4, tokenId: '8' };
  const found = positionActivity(fixture.items, target, portfolio);
  assert.ok(found.some(x => x.kind === 'vault_execution'));
  assert.ok(found.some(x => x.kind === 'auto_exit'));
  assert.ok(found.some(x => x.kind === 'vault_event'));
  assert.ok(found.some(x => x.kind === 'auto_exit_event' && x.event === 'MandateRevoked'));
  assert.equal(found.some(x => x.kind === 'zap_event'), false, 'wallet-wide nonce invalidation is not falsely assigned to the NFT');
  assert.equal(positionActivity(fixture.items, { ...target, chainId: 8453 }, portfolio).length, 0);
  assert.equal(positionActivity(fixture.items, { ...target, dex: 3 }, portfolio).length, 0);
  const withoutPortfolio = positionActivity(fixture.items, { ...target, tokenId: '7' }, null);
  assert.ok(withoutPortfolio.some(x => x.kind === 'vault_event'), 'old creation receipt establishes the vault identity without the bounded portfolio');
});
