import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { createActivityHistory, compareActivity } = require('../../.test-build/app/src/v2in/lists/activityHistory.js');
const { privateTimes, positionActivity, timelineRows, indexedOperationEvidence } = require('../../.test-build/app/src/v2in/lists/activityModel.js');
const fixture = JSON.parse(readFileSync(new URL('../../../api-contracts/read-v6/fixtures/valid/activity.json', import.meta.url)));
const portfolio = JSON.parse(readFileSync(new URL('../../../api-contracts/read-v6/fixtures/valid/portfolio.json', import.meta.url)));
const wire = JSON.parse(readFileSync(new URL('../../../api-contracts/execution-v1/fixtures/status-wire.json', import.meta.url)));
const wallet = fixture.wallet;
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
const item = (n, extra = {}) => ({ ...structuredClone(fixture.items[0]), id: `4663:${n}:1`, chainId: 4663,
  tx: { ...structuredClone(fixture.items[0].tx), hash: `0x${n.toString(16).padStart(64, '0')}`, snapshot: { number: n, hash: `0x${n.toString(16).padStart(64, '0')}`, timestamp: n }, finality: 'finalized' }, ...extra });
const range = (top, bottom) => Array.from({ length: top - bottom + 1 }, (_, i) => item(top - i));
const viewsOf = items => items.map(event => ({ id: event.id, kind: event.kind, chainId: event.chainId, block: event.tx.snapshot.number, at: event.tx.snapshot.timestamp, hash: event.tx.hash }));
const page = (items, cursor = null, extra = {}) => ({ kind: 'ok', body: { ...structuredClone(fixture), items, nextCursor: cursor, ...extra } });

// Rewritten on purpose 2026-10-14 (incident C2: the 429 on /api/chain/v1/confirmation). This case held the defect: every
// unfinalized receipt read-v6 listed, up to 32 per answer, was handed to the confirmation queue as a new operation, and on
// Robinhood Chain the queue then read each of them from the node until its block was final (about 470 POSTs a receipt, in
// every tab that opened Receipts or a position). A receipt this browser did not send is confirmed because the index holds
// it and final when its own `tx.finality` says so; the queue hears of the index only for an operation this browser sent.
test('read-v6 receipts this browser did not send are never handed to the confirmation queue, on any chain', () => {
  const items = [4663, 8453, 42161].map(chainId => {
    const value = item(20, { chainId }); value.tx.finality = 'unfinalized'; return value;
  });
  const body = { wallet, items: [...items, { ...items[1], id: 'same-transaction-another-log' }] };
  assert.deepEqual(indexedOperationEvidence(wallet.toUpperCase(), body, []), [], 'an unknown unfinalized receipt starts nothing');
  assert.deepEqual(indexedOperationEvidence(`0x${'9'.repeat(40)}`, body, []), [], 'late response from a previous wallet is ignored');
  assert.equal(indexedOperationEvidence(wallet, { wallet, items: range(80, 1) }, []).length, 0, 'already final history needs no watcher');
  const pending = range(80, 1).map(value => ({ ...value, tx: { ...value.tx, finality: 'unfinalized' } }));
  assert.deepEqual(indexedOperationEvidence(wallet, { wallet, items: pending }, []), [], 'eighty of them start nothing either');
  // What this browser sent is the one thing the index may complete: once per transaction, bounded, for this wallet only.
  const own = range(80, 1).map(value => ({ chainId: 4663, wallet, hash: value.tx.hash, blockHash: value.tx.snapshot.hash, block: value.tx.snapshot.number, phase: 'included' }));
  assert.deepEqual(indexedOperationEvidence(wallet, { wallet, items: pending }, own), [], 'its own receipt, listed and not final yet, changes nothing');
  const upgrades = indexedOperationEvidence(wallet.toUpperCase(), { wallet, items: [...range(80, 1), { ...item(80), id: 'same-transaction-another-log' }] }, own);
  assert.equal(upgrades.length, 32, 'the index\'s finality is taken in bounded turns');
  assert.equal(new Set(upgrades.map(op => op.receipt.transactionHash)).size, 32, 'once per transaction');
  assert.ok(upgrades.every(op => op.indexed && op.chainId === 4663 && op.wallet === wallet && op.receipt.state === 'finalized' && !op.tokenIds.length));
  assert.deepEqual(indexedOperationEvidence(`0x${'9'.repeat(40)}`, { wallet, items: range(80, 1) }, own), []);
});

// Added 2026-10-14 (incident C2): the chain's finalized mark rides in every activity answer the page already reads; the
// history hands each good answer on, so the confirmation queue learns finality without a request of its own.
test('every good activity answer is handed on with its chains; a failed read hands nothing', async () => {
  const time = clock(), heard = [];
  const chains = structuredClone(fixture.chains);
  chains[0].finalizedThrough = { ...chains[0].indexedThrough, number: 4242 };
  let asks = 0;
  const history = createActivityHistory(async (_, request) => {
    asks++;
    if (asks === 2) return { kind: 'unavailable', reason: 'upstream_unavailable' };
    return request.cursor ? page(range(20, 1), null, { chains }) : page(range(40, 21), 'older', { chains: fixture.chains });
  }, time.timers, false, answer => heard.push(answer.chains));
  const stop = history.subscribe(wallet, () => {}); await flush();
  assert.equal(heard.length, 1, 'the head');
  assert.deepEqual(heard[0], fixture.chains);
  history.more(wallet); await flush();
  assert.equal(asks, 2); assert.equal(heard.length, 1, 'a failed page hands nothing');
  await time.tick(5_000);
  assert.equal(asks, 3); assert.equal(heard.length, 2, 'an older page is an answer too');
  assert.equal(heard[1][0].finalizedThrough.number, 4242);
  stop();
});

test('index reconciliation upgrades only a matching included receipt and never overrides account, canonical branch or stronger proof', () => {
  const event = item(20, { chainId: 8453 }), body = { wallet, items: [event] };
  const known = { chainId: 8453, wallet, hash: event.tx.hash, blockHash: event.tx.snapshot.hash, block: 20, phase: 'included' };
  const evidence = indexedOperationEvidence(wallet, body, [known]);
  assert.equal(evidence.length, 1); assert.equal(evidence[0].receipt.state, 'finalized');
  for (const patch of [{ wallet: `0x${'9'.repeat(40)}` }, { block: 19 }, { blockHash: `0x${'f'.repeat(64)}` }, { phase: 'finalized' }, { phase: 'reorged' }]) {
    assert.deepEqual(indexedOperationEvidence(wallet, body, [{ ...known, ...patch }]), []);
  }
  event.tx.finality = 'unfinalized';
  assert.deepEqual(indexedOperationEvidence(wallet, body, [{ ...known, phase: 'finalized' }]), [], 'old response cannot downgrade a finalized receipt');
  assert.deepEqual(indexedOperationEvidence(wallet, body, [known]), [], 'repeated inclusion does not refresh or read again');
});

function clock() {
  let now = 0, visible = true;
  const jobs = new Set(), wake = new Set();
  return {
    timers: { now: () => now, set(fn, ms) { const job = { fn, at: now + ms }; jobs.add(job); return job; }, clear(job) { jobs.delete(job); }, visible: () => visible,
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

test('an older-page retry never removes the unfinalized event exactly at its exclusive cursor boundary', async () => {
  const time = clock(); let tailReads = 0;
  const head = structuredClone(fixture.items.slice(0, 5));
  const older = structuredClone(fixture.items.slice(5));
  const boundary = head.at(-1);
  assert.equal(boundary.tx.finality, 'unfinalized');
  const history = createActivityHistory(async (_, request) => !request.cursor ? page(head, 'older')
    : ++tailReads === 1 ? { kind: 'unavailable', reason: 'upstream_unavailable', retryAfterSeconds: 5 } : page(older), time.timers, false);
  const stop = history.subscribe(wallet, () => {}); await flush();
  const initial = history.get(wallet).answer.items.map(item => item.id);
  history.more(wallet); await flush();
  assert.deepEqual(history.get(wallet).answer.items.map(item => item.id), initial);
  await time.tick(5_000);
  const all = history.get(wallet).answer.items.map(item => item.id);
  assert.ok(all.includes(boundary.id), 'the cursor event is outside the reread interval, even when its neighboring log shares the block and tx');
  assert.deepEqual(all, fixture.items.map(item => item.id));
  assert.equal(history.get(wallet).more, false);
  stop();
});

test('backfill continues beyond three pages and a new recent head cannot erase its older join target', async () => {
  const time = clock(), asks = []; let top = 40;
  const history = createActivityHistory(async (_, request) => {
    asks.push(request);
    const high = request.cursor ? Number(request.cursor) : top;
    return page(range(high, Math.max(1, high - 19)), high > 20 ? String(high - 20) : null);
  }, time.timers, true);
  const stop = history.subscribe(wallet, () => {}); await flush();
  history.more(wallet); await flush();
  top = 200; history.refresh(wallet); await flush();
  await time.tick(1_000); await time.tick(1_000); await time.tick(1_000);
  assert.equal(history.get(wallet).catchingUp, true, 'the gap still has more than three pages');
  top = 205; history.refresh(wallet); await flush();
  assert.equal(history.get(wallet).catchingUp, true, 'overlapping the new recent segment does not close the old gap');
  assert.equal(history.get(wallet).answer.items[0].tx.snapshot.number, 205, 'recent reads do not wait for backfill');
  for (let i = 0; i < 12; i++) await time.tick(5_000);
  assert.equal(history.get(wallet).catchingUp, false);
  assert.equal(history.get(wallet).more, false);
  assert.deepEqual(history.get(wallet).answer.items.map(value => value.tx.snapshot.number), Array.from({ length: 205 }, (_, i) => 205 - i));
  const heads = asks.filter(request => !request.cursor).length;
  await time.tick(60_000);
  assert.ok(asks.filter(request => !request.cursor).length > heads, 'the recurring head is still scheduled');
  stop();
});

test('old included receipts outside the first twenty rows reconcile finality and canonical removal without a public RPC', async () => {
  for (const reorganized of [false, true]) {
    const time = clock(); let round = 0;
    const tentative = item(25); tentative.tx.finality = 'unfinalized';
    const history = createActivityHistory(async (_, request) => {
      if (!request.cursor) return ++round === 1 ? page(range(40, 21).map(value => value.id === tentative.id ? tentative : value), '20') : page(range(45, 26), '25');
      return request.cursor === '20' ? page(range(20, 1)) : page(range(25, 6).filter(value => !reorganized || value.id !== tentative.id), '5');
    }, time.timers, true);
    const stop = history.subscribe(wallet, () => {}); await flush(); history.more(wallet); await flush();
    history.refresh(wallet); await flush();
    assert.equal(history.get(wallet).answer.items.find(value => value.id === tentative.id).tx.finality, 'unfinalized');
    await time.tick(1_000);
    const found = history.get(wallet).answer.items.find(value => value.id === tentative.id);
    assert.equal(reorganized ? found === undefined : found?.tx.finality === 'finalized', true);
    stop();
  }
});

test('more than twenty old pending receipts are checked in successive bounded turns instead of starving behind the newest pending group', async () => {
  const time = clock(); let heads = 0;
  const history = createActivityHistory(async (_, request) => {
    if (!request.cursor) heads++;
    const top = request.cursor ? Number(request.cursor) : 100;
    const rows = range(top, Math.max(1, top - 19)).map(value => {
      const block = value.tx.snapshot.number;
      if (block <= 60 && !(heads >= 3 && block <= 40)) value.tx.finality = 'unfinalized';
      return value;
    });
    return page(rows, top > 20 ? String(top - 20) : null);
  }, time.timers, true);
  const stop = history.subscribe(wallet, () => {}); await flush();
  for (let n = 0; n < 4; n++) { history.more(wallet); await flush(); }
  history.refresh(wallet); await flush();
  await time.tick(1000); await time.tick(1000);
  assert.equal(history.get(wallet).answer.items.find(value => value.tx.snapshot.number === 55).tx.finality, 'unfinalized');
  await time.tick(60_000);
  for (let n = 0; n < 5; n++) await time.tick(5_000);
  assert.equal(history.get(wallet).answer.items.find(value => value.tx.snapshot.number === 25).tx.finality, 'finalized', 'the next pending group is reached although the first group stayed included');
  stop();
});

test('a partial head without a next cursor cannot erase an already known older-page path', async () => {
  const time = clock(); let heads = 0;
  const history = createActivityHistory(async (_, request) => {
    if (request.cursor) return page(range(20, 1));
    return ++heads === 1 ? page(range(40, 21), '20') : page([item(40)], null, { coverage: 'partial' });
  }, time.timers, false);
  const stop = history.subscribe(wallet, () => {}); await flush();
  history.refresh(wallet); await flush();
  assert.equal(history.get(wallet).more, true);
  history.more(wallet); await flush();
  assert.equal(history.get(wallet).answer.items.length, 40, 'older history is still reachable after a partial refresh');
  stop();
});

test('a confirmation head preempts a failing old page only after its Retry-After, then paging resumes', async () => {
  const time = clock(), asks = []; let top = 40, failed = false;
  const history = createActivityHistory(async (_, request) => {
    asks.push(request);
    if (request.cursor && !failed) { failed = true; return { kind: 'unavailable', reason: 'upstream_unavailable', retryAfterSeconds: 12 }; }
    return request.cursor ? page(range(20, 1)) : page(range(top, top - 19), '20');
  }, time.timers, false);
  const stop = history.subscribe(wallet, () => {}); await flush(); history.more(wallet); await flush();
  top = 41; history.refresh(wallet, { chainId: 4663, block: 41 }); await flush();
  await time.tick(11_999); assert.equal(asks.length, 2);
  await time.tick(1);
  assert.equal(asks[2].cursor, undefined, 'the due head wins over the failed archive');
  assert.equal(history.get(wallet).answer.items[0].tx.snapshot.number, 41);
  assert.equal(asks[3].cursor, '20', 'the exact failed archive cursor is retained');
  stop();
});

test('confirmed index catch-up is responsive but bounded and honors hidden tabs', async () => {
  const time = clock(); let asks = 0;
  const chains = fixture.chains.map(chain => chain.chainId === 4663 ? { ...chain, indexedThrough: { ...chain.indexedThrough, number: 10 } } : chain);
  const history = createActivityHistory(async () => { asks++; return page([item(10)], null, { chains }); }, time.timers, true);
  const stop = history.subscribe(wallet, () => {}); await flush();
  history.refresh(wallet, { chainId: 4663, block: 20 }); await flush();
  for (let i = 0; i < 5; i++) await time.tick(2_000);
  const bounded = asks;
  await time.tick(2_000); assert.equal(asks, bounded, 'a lagging index does not cause an unlimited fast loop');
  time.show(false); await time.tick(60_000); assert.equal(asks, bounded);
  time.show(true); await flush(); assert.equal(asks, bounded + 1);
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

test('both history and operation rows order numeric log indexes 10 before 2 at the same block', () => {
  const two = item(40, { id: '4663:40:2' });
  const ten = item(40, { id: '4663:40:10' });
  assert.deepEqual([two, ten].sort(compareActivity).map(x => x.id), [ten.id, two.id]);
  assert.deepEqual(timelineRows(viewsOf([two, ten]), []).map(x => x.receipt.id), [ten.id, two.id]);
});

test('setup auxiliary events share one operation; distinct effects in the same transaction survive and gas appears once', () => {
  const created = structuredClone(fixture.items.find(x => x.kind === 'vault_created'));
  const armed = structuredClone(fixture.items.find(x => x.kind === 'vault_event'));
  armed.tx = structuredClone(created.tx); armed.id = `${created.chainId}:${created.tx.snapshot.number}:10`;
  let rows = timelineRows(viewsOf([created, armed]), [], new Map(), [created, armed]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].receipts.length, 2);
  assert.equal(rows[0].showGas, true);
  const run = structuredClone(fixture.items.find(x => x.kind === 'vault_execution'));
  const other = structuredClone(run); other.id = '4663:73394000:10'; other.planHash = '0x' + 'e'.repeat(64);
  rows = timelineRows(viewsOf([run, other]), [], new Map(), [run, other]);
  assert.equal(rows.length, 2, 'a shared tx does not erase a second execution');
  assert.equal(rows.filter(row => row.showGas).length, 1);
  assert.equal(rows[0].receipt.id, other.id);
});

test('private reconciliation requires the same chain, transaction, block, liquidity and exact currency fees', () => {
  const run = structuredClone(fixture.items.find(x => x.kind === 'vault_execution'));
  const signed = { ...wire.responses['status.reserved'].item, state: 'reconciled', receipt: {
    transactionHash: run.tx.hash, blockHash: run.tx.snapshot.hash, blockNumberRaw: String(run.tx.snapshot.number),
    liquidityIncreaseRaw: run.compounded.liquidityAdded, serviceFeeBps: 400,
    sources: run.tariffs.map(fee => ({ currency: fee.token, serviceFeeRaw: fee.amount })),
  } };
  const rows = event => timelineRows(viewsOf([event]), [signed], new Map(), [event]);
  assert.equal(rows(run).length, 1);
  assert.equal(rows(run)[0].evidence.length, 1);
  for (const altered of [
    { ...run, chainId: 8453 },
    { ...run, tx: { ...run.tx, hash: '0x' + 'e'.repeat(64) } },
    { ...run, compounded: { ...run.compounded, liquidityAdded: '1' } },
    { ...run, tariffs: run.tariffs.map((fee, i) => i ? fee : { ...fee, amount: '1' }) },
  ]) assert.equal(rows(altered).length, 2, 'unproven records remain separately inspectable');
});

test('a repeated cursor stops the walk, preserves rows and reports incomplete history', async () => {
  const time = clock(); let asks = 0;
  const history = createActivityHistory(async () => ++asks === 1 ? page([item(3)], 'same') : page([item(2)], 'same'), time.timers, false);
  const stop = history.subscribe(wallet, () => {}); await flush(); history.more(wallet); await flush();
  assert.deepEqual(history.get(wallet).answer.items.map(x => x.tx.snapshot.number), [3, 2]);
  assert.equal(history.get(wallet).more, false);
  assert.equal(history.get(wallet).error.reason, 'pagination_stalled');
  history.more(wallet); await time.tick(60_000);
  assert.equal(asks, 2); stop();
});

test('an expired cursor restarts once with loaded rows intact, then uses the new cursor', async () => {
  const time = clock(), asks = [];
  const history = createActivityHistory(async (_, request) => {
    asks.push(request);
    if (asks.length === 1) return page([item(4)], 'expired');
    if (asks.length === 2) return { kind: 'unavailable', reason: 'invalid_or_expired_cursor' };
    return request.cursor ? page([item(3)]) : page([item(4)], 'fresh');
  }, time.timers, false);
  const stop = history.subscribe(wallet, () => {}); await flush(); history.more(wallet); await flush();
  assert.equal(history.get(wallet).answer.items.length, 1);
  await time.tick(1_000); history.more(wallet); await flush();
  assert.equal(asks[3].cursor, 'fresh');
  assert.deepEqual(history.get(wallet).answer.items.map(x => x.tx.snapshot.number), [4, 3]); stop();
});

test('confirmation during an in-flight head queues a fresh read and does not publish the obsolete reply', async () => {
  const time = clock(); let resolveFirst, asks = 0;
  const history = createActivityHistory(async () => ++asks === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : page([item(9)]), time.timers, false);
  const stop = history.subscribe(wallet, () => {}); await flush(); history.refresh(wallet); resolveFirst(page([item(1)])); await flush();
  assert.equal(asks, 2);
  assert.deepEqual(history.get(wallet).answer.items.map(x => x.tx.snapshot.number), [9]); stop();
});

test('local confirmed closes survive reload by wallet, stay one transaction and never invent native payouts or a date', () => {
  const { createLocalReceiptStore, validLocalClose } = require('../../.test-build/app/src/v2in/lists/localReceipts.js');
  const { v2Chain } = require('../../.test-build/app/src/v2/chains.js');
  const kept = new Map();
  const storage = { getItem: key => kept.get(key) ?? null, setItem: (key, value) => kept.set(key, value) };
  const store = createLocalReceiptStore(storage);
  const receipt = { wallet, chainId: 4663, dex: 4, positionManager: v2Chain(4663).uniswap.v4.positionManager,
    hash: '0x' + 'd'.repeat(64), block: 234, blockHash: '0x' + 'b'.repeat(64), tokenIds: ['7', '8'],
    amounts: [{ token: '0x' + '0'.repeat(40), amount: null }], at: null, state: 'included' };
  assert.equal(validLocalClose(receipt), true);
  store.record(receipt); store.record({ ...receipt, state: 'finalized' });
  assert.equal(store.get(wallet).length, 1);
  assert.equal(store.get(wallet)[0].state, 'finalized');
  const reloaded = createLocalReceiptStore(storage);
  assert.equal(reloaded.get(wallet)[0].amounts[0].amount, null);
  assert.equal(reloaded.get(wallet)[0].at, null);
  assert.equal(reloaded.get('0x' + 'e'.repeat(40)).length, 0);
  assert.equal(validLocalClose({ ...receipt, positionManager: v2Chain(4663).uniswap.v3.positionManager }), false);
  store.record({ ...receipt, block: NaN });
  assert.equal(store.get(wallet).length, 1);
  assert.equal(timelineRows([], [], new Map(), [], reloaded.get(wallet))[0].at, null);
  reloaded.forget(wallet, 4663, receipt.positionManager, receipt.hash);
  assert.equal(reloaded.get(wallet).length, 0, 'a reorg removes the orphaned confirmation');
  assert.equal(createLocalReceiptStore(storage).get(wallet).length, 0, 'the correction survives reload');
});

test('local close and indexed activity correlate only with matching PM, chain, block hash, NFT exits and complete token totals', () => {
  const { publicCloseProves } = require('../../.test-build/app/src/v2in/lists/localReceipts.js');
  const { v2Chain } = require('../../.test-build/app/src/v2/chains.js');
  const event = structuredClone(fixture.items.find(item => item.kind === 's1_action'));
  event.action = 'exit'; event.steps = [{ ...event.steps[0], tokenId: '7', liquidityDelta: '-1' }];
  event.steps[0].pool.dex = 4;
  const token = v2Chain(4663).wrappedNative.address;
  event.refunds = [{ token, amount: '200' }];
  const local = { wallet, chainId: 4663, dex: 4, positionManager: v2Chain(4663).uniswap.v4.positionManager,
    hash: event.tx.hash, block: event.tx.snapshot.number, blockHash: event.tx.snapshot.hash,
    tokenIds: ['7'], amounts: [{ token, amount: '200' }], at: null, state: 'included' };
  assert.equal(publicCloseProves(local, [event]), true);
  assert.equal(timelineRows(viewsOf([event]), [], new Map(), [event], [local]).length, 1);
  for (const changed of [
    { ...local, chainId: 8453 }, { ...local, blockHash: '0x' + 'f'.repeat(64) },
    { ...local, tokenIds: ['8'] }, { ...local, amounts: [{ token, amount: null }] },
    { ...local, amounts: [{ token, amount: '201' }] },
  ]) assert.equal(publicCloseProves(changed, [event]), false);
});
