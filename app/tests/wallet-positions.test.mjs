/**
 * The wallet's Domino positions on the page (src/lib/walletPositions.ts and
 * src/lib/walletCards.ts, 2026-09-24): the endpoint's answer checked field by
 * field, the one request the page makes to it (also answered by the endpoint
 * itself, functions/_lib/walletPositions.ts, over the fake chain of
 * tests/owned-chain.mjs), and the cards the rows and a position's page draw
 * from chain data. Replaces tests/owned-positions.test.mjs with the v1 list,
 * its per-row read-service reads and the browser's memory of created ids.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { KEY, OWNER, POOL, TOKEN, USDG, ZERO, fakeChain, memoryCache, nft, wallet as endpoint } from './owned-chain.mjs';

const require = createRequire(import.meta.url);
const client = require('../.test-build/app/src/lib/walletPositions.js');
const cards = require('../.test-build/app/src/lib/walletCards.js');
const positions = require('../.test-build/app/src/lib/read/screens/positions.js');

const OTHER = '0x3333333333333333333333333333333333333333';
const token = (address, symbol, decimals) => ({ address, symbol, decimals });
/** What removing all of 10^12 liquidity in [-600, 600] pays at tick 0: v4's own figure (functions/_lib/walletPositions.ts). */
const PRINCIPAL = endpoint.principalAt(2n ** 96n, 0, -600, 600, 10n ** 12n).map(String);
/** A USDG pair with a six-decimal token, so a price at tick 0 is 1 and every range end is a price. */
const POSITION = {
  tokenId: '3135288',
  status: 'open',
  poolId: POOL,
  currencies: [token(USDG, 'USDG', 6), token(TOKEN, 'UFG', 6)],
  fee: 3000,
  tickSpacing: 60,
  hooks: ZERO,
  tickLower: -600,
  tickUpper: 600,
  liquidity: '1000000000000',
  sqrtPriceX96: String(2n ** 96n),
  tick: 0,
  unclaimedFees: ['12', '34'],
  principal: PRINCIPAL,
};
const DEPOSIT = {
  operationId: '0x336239417f316789f8c3f88159622ecb6cba1da16a9bd46296de05732d26e887',
  currency0: USDG,
  currency1: '0xca9c78dd337a67f6e0077f65f5e9218719d30edf',
  fee: 80000,
  tickSpacing: 800,
  hooks: ZERO,
  balance0: '100000',
  balance1: '0',
  currencies: [token(USDG, 'USDG', 6), token('0xca9c78dd337a67f6e0077f65f5e9218719d30edf', 'NET', 9)],
};
const REPLY = { owner: OWNER, block: 71733735, positions: [POSITION, { ...POSITION, tokenId: '3000000', status: 'closed', liquidity: '0', principal: ['0', '0'] }], deposits: [DEPOSIT] };
const clone = (value) => JSON.parse(JSON.stringify(value));

test('the endpoint’s answer is taken only when every field is exactly what the endpoint sends, and only for the owner asked about', () => {
  assert.deepEqual(client.parseWalletAnswer(clone(REPLY), OWNER), REPLY);
  assert.deepEqual(client.parseWalletAnswer(clone(REPLY), OWNER.toUpperCase().replace('0X', '0x')), REPLY, 'the address as the wallet reports it, checksummed or not');
  const unread = clone(REPLY);
  Object.assign(unread.positions[0], { sqrtPriceX96: null, tick: null, principal: null, unclaimedFees: null });
  unread.positions[0].currencies[1] = token(TOKEN, null, null);
  assert.deepEqual(client.parseWalletAnswer(clone(unread), OWNER), unread, 'what the chain could not give is null');
  const broken = [
    (r) => (r.owner = OTHER),
    (r) => (r.extra = 1),
    (r) => (r.complete = true),
    (r) => delete r.deposits,
    (r) => (r.block = -1),
    (r) => (r.positions[0].tokenId = '03135288'),
    (r) => (r.positions[0].tokenId = 3135288),
    (r) => (r.positions[1].tokenId = '3135288'),
    (r) => (r.positions[0].status = 'burned'),
    (r) => (r.positions[0].status = 'closed'),
    (r) => (r.positions[1].status = 'open'),
    (r) => (r.positions[0].poolId = POOL.toUpperCase()),
    (r) => (r.positions[0].tickLower = 600),
    (r) => (r.positions[0].tickUpper = 2 ** 23),
    (r) => (r.positions[0].fee = 2 ** 24),
    (r) => (r.positions[0].liquidity = (2n ** 128n).toString()),
    (r) => (r.positions[0].sqrtPriceX96 = null),
    (r) => (r.positions[0].sqrtPriceX96 = '0'),
    (r) => (r.positions[0].unclaimedFees = ['1']),
    (r) => (r.positions[0].principal = ['-1', '0']),
    (r) => (r.positions[0].currencies = [r.positions[0].currencies[0]]),
    (r) => (r.positions[0].currencies[0].decimals = 256),
    (r) => (r.positions[0].currencies[0].symbol = ''),
    (r) => (r.positions[0].extra = 1),
    (r) => (r.deposits[0].currencies[1].address = USDG),
    (r) => (r.deposits[0].balance0 = (2n ** 128n).toString()),
    (r) => (r.positions = Array.from({ length: 101 }, (_, i) => ({ ...POSITION, tokenId: String(i + 1) }))),
    (r) => (r.deposits = Array.from({ length: 9 }, () => DEPOSIT)),
  ];
  for (const [i, change] of broken.entries()) {
    const reply = clone(REPLY);
    change(reply);
    assert.equal(client.parseWalletAnswer(reply, OWNER), null, `case ${i}: ${change}`);
  }
});

async function withFetch(answer, run) {
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url, init });
    return answer(url, init);
  };
  try {
    return { result: await run(), sent };
  } finally {
    globalThis.fetch = original;
  }
}

test('the page asks the endpoint one way only: a same-origin POST of {owner}, no-store, and {owner, fresh} after an action', async () => {
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const ok = await withFetch(() => json(REPLY), () => client.readWalletPositions(OWNER, new AbortController().signal));
  assert.deepEqual(ok.result, { ok: true, answer: REPLY });
  assert.equal(ok.sent.length, 1);
  const [{ url, init }] = ok.sent;
  assert.equal(url, '/api/owned/v2/positions');
  assert.doesNotMatch(url, /0x/i, 'the address is never in the URL');
  assert.deepEqual({ ...init, signal: undefined }, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: OWNER }), credentials: 'same-origin', cache: 'no-store', signal: undefined });
  const fresh = await withFetch(() => json(REPLY), () => client.readWalletPositions(OWNER, new AbortController().signal, true));
  assert.equal(fresh.sent[0].init.body, JSON.stringify({ owner: OWNER, fresh: true }));

  const cases = [
    [() => json({ error: 'chain_busy' }, 502), 'chain_busy'],
    [() => json({ error: 'NOT a code' }, 502), 'http_502'],
    [() => new Response('<!doctype html>', { status: 200 }), 'invalid_reply'],
    [() => new Response('<!doctype html>', { status: 404 }), 'http_404'],
    [() => json({ ...REPLY, owner: OTHER }), 'invalid_reply'],
    [() => Promise.reject(new TypeError('Failed to fetch')), 'unreachable'],
  ];
  for (const [answer, reason] of cases) {
    const { result } = await withFetch(answer, () => client.readWalletPositions(OWNER, new AbortController().signal));
    assert.deepEqual(result, { ok: false, reason }, reason);
  }
  const controller = new AbortController();
  controller.abort();
  const aborted = await withFetch(() => Promise.reject(new DOMException('aborted', 'AbortError')), () => client.readWalletPositions(OWNER, controller.signal));
  assert.deepEqual(aborted.result, { ok: false, reason: 'aborted' });
  for (const reason of ['chain_busy', 'chain_unavailable', 'unreachable', 'http_503']) assert.equal(client.passingWalletFailure(reason), true, reason);
  for (const reason of ['invalid_owner', 'invalid_reply', 'http_404', 'beta_access_required']) assert.equal(client.passingWalletFailure(reason), false, reason);
});

test('the page reads exactly what the endpoint sends over the fake chain: the positions it minted, open and closed, with their tokens and deposits; a kept chain_busy, then the answer', async () => {
  const chain = fakeChain({ minted: [{ block: 69_300_000, id: 7 }, { block: 69_400_000, id: 8 }], nfts: { 7: nft(), 8: nft({ liquidity: 0n }) } });
  const { cache } = memoryCache();
  const original = globalThis.fetch;
  const through = (target) => async (url, init) => endpoint.answerWalletPositions(new Request(`https://domino.money${url}`, { method: init.method, headers: init.headers, body: init.body }), target.deps, cache);
  try {
    globalThis.fetch = through(chain);
    const read = await client.readWalletPositions(OWNER, new AbortController().signal);
    assert.equal(read.ok, true);
    assert.deepEqual(read.answer.positions.map((p) => [p.tokenId, p.status]), [['7', 'open'], ['8', 'closed']]);
    assert.deepEqual(read.answer.positions[0].currencies, [token(USDG, 'USDG', 6), token(TOKEN, 'UFG', 18)]);

    const busy = fakeChain({ owner: OTHER, script: { eth_blockNumber: Array.from({ length: 4 }, () => new Response('', { status: 429 })) } });
    globalThis.fetch = through(busy);
    assert.deepEqual(await client.readWalletPositions(OTHER, new AbortController().signal), { ok: false, reason: 'chain_busy' });
    busy.deps.time = 3_000;
    assert.deepEqual(await client.readWalletPositions(OTHER, new AbortController().signal), { ok: false, reason: 'chain_busy' });
    assert.equal(busy.log.length, 4, 'the retry 3 s later read nothing');
    busy.deps.time = 15_000;
    assert.deepEqual(await client.readWalletPositions(OTHER, new AbortController().signal), { ok: true, answer: { owner: OTHER, block: 71_700_000, positions: [], deposits: [] } });
    assert.deepEqual(await client.readWalletPositions(`0x${'0'.repeat(40)}`, new AbortController().signal), { ok: false, reason: 'invalid_owner' });
  } finally {
    globalThis.fetch = original;
  }
});

test('a row’s card comes straight from the chain read: pair, fee, range in prices, in range by v4’s rule, amounts in units, a dash where the chain gave nothing', () => {
  const card = cards.walletCard(POSITION, OWNER.toUpperCase().replace('0X', '0x'));
  assert.equal(card.tokenId, '3135288');
  assert.equal(card.fee, '0.30%');
  assert.equal(card.feePips, 3000);
  assert.deepEqual(card.currencies.map((c) => [c.address, c.symbol, c.decimals]), [[USDG, 'USDG', 6], [TOKEN, 'UFG', 6]]);
  assert.equal(card.owner.address, OWNER);
  assert.deepEqual([card.hasLiquidity, card.inRange, card.liquidityRaw], [true, true, '1000000000000']);
  assert.deepEqual(card.principal.map((a) => [a.raw, a.kind]), PRINCIPAL.map((raw) => [raw, 'units']));
  assert.equal(card.principal[0].text, '29,553', 'six significant digits, never fewer than the whole part');
  assert.deepEqual(card.unsettledFees.map((a) => a.raw), ['12', '34']);
  assert.equal(card.range.fullRange, false);
  assert.equal(card.range.ends.lower.kind, 'price');
  assert.equal(positions.cardPoolUsableForDomino(card), true);
  assert.equal(cards.walletCard({ ...POSITION, tick: 600 }, OWNER).inRange, false, 'the upper tick is outside the range');
  assert.equal(cards.walletCard({ ...POSITION, tick: -600 }, OWNER).inRange, true);
  const closed = cards.walletCard({ ...POSITION, status: 'closed', liquidity: '0', principal: ['0', '0'] }, OWNER);
  assert.deepEqual([closed.hasLiquidity, closed.principal[0].kind], [false, 'zero']);
  const unread = cards.walletCard({ ...POSITION, sqrtPriceX96: null, tick: null, principal: null, unclaimedFees: null }, OWNER);
  assert.deepEqual([...unread.principal, ...unread.unsettledFees].map((a) => [a.kind, a.text, a.raw]), Array(4).fill(['unread', '—', '']));
  assert.equal(unread.inRange, false);
  // A full-range position is 0 to ∞ whatever the decimals; unknown decimals write the other ends as ticks.
  const full = cards.walletCard({ ...POSITION, tickLower: -887220, tickUpper: 887220, currencies: [token(USDG, null, null), token(TOKEN, null, null)] }, OWNER);
  assert.deepEqual([full.range.fullRange, full.range.prices], [true, { lower: '0', upper: '∞' }]);
  const ticks = cards.walletCard({ ...POSITION, currencies: [token(USDG, null, null), token(TOKEN, 'UFG', 18)] }, OWNER);
  assert.deepEqual([ticks.range.ends.lower, ticks.range.prices], [{ kind: 'tick', problem: 'decimals_unknown' }, null]);
  // Only a pool with no hooks and a fixed fee is one Domino can add to.
  assert.equal(positions.cardPoolUsableForDomino(cards.walletCard({ ...POSITION, hooks: `0x${'4a'.repeat(20)}` }, OWNER)), false);
  const dynamic = cards.walletCard({ ...POSITION, fee: 8388608 }, OWNER);
  assert.deepEqual([dynamic.fee, positions.cardPoolUsableForDomino(dynamic)], ['Dynamic', false]);
});

test('the pool price on a card is the same read’s: checked against its square root, in the card’s decimals, placed against the range', () => {
  const card = cards.walletCard(POSITION, OWNER);
  const at = (tick) => positions.chainPoolPrice(card, { sqrtPriceX96: String(require('../.test-build/app/src/lib/read/screens/poolRange.js').sqrtPriceAtTick(tick)), tick, block: 9 });
  const inside = at(0);
  assert.deepEqual([inside.state, inside.position, inside.block], ['usable', 'inside', 9]);
  assert.equal(inside.text, '≈1');
  assert.equal(at(-700).position, 'below');
  assert.equal(at(600).position, 'above', 'v4 counts the upper tick as outside');
  assert.deepEqual(positions.chainPoolPrice(card, { sqrtPriceX96: String(2n ** 96n), tick: 5000, block: 9 }), { state: 'unavailable', problem: 'tick_mismatch', block: 9 });
  assert.deepEqual(positions.chainPoolPrice(card, { sqrtPriceX96: null, tick: null, block: 9 }), { state: 'unavailable', problem: 'not_initialized', block: 9 });
  const noDecimals = cards.walletCard({ ...POSITION, currencies: [token(USDG, null, null), token(TOKEN, 'UFG', 18)] }, OWNER);
  assert.deepEqual(positions.chainPoolPrice(noDecimals, { sqrtPriceX96: String(2n ** 96n), tick: 0, block: 9 }), { state: 'unavailable', problem: 'decimals_unknown', block: 9 });
});

test('a position’s page reads its /api/fees/v1/state answer as the same WalletPosition: the pool key, the unclaimed fees as the relay computed them, and the principal at its price', () => {
  const state = {
    tokenId: '3135288',
    ok: true,
    owner: OWNER,
    poolId: POOL,
    poolKey: KEY,
    currencies: [token(USDG, 'USDG', 6), token(TOKEN, 'UFG', 6)],
    tickLower: -600,
    tickUpper: 600,
    liquidity: '1000000000000',
    sqrtPriceX96: String(2n ** 96n),
    tick: 0,
    feeGrowthInside0X128: '0',
    feeGrowthInside1X128: '0',
    feeGrowthInside0LastX128: '0',
    feeGrowthInside1LastX128: '0',
    unclaimed0: '12',
    unclaimed1: '34',
  };
  const position = cards.positionOfState(state);
  assert.deepEqual(position, POSITION, 'the page and the list agree on every figure of one read');
  const closed = cards.positionOfState({ ...state, liquidity: '0' });
  assert.deepEqual([closed.status, closed.principal], ['closed', ['0', '0']]);
  // USD is valued at the same read's price, and never without one.
  const valued = cards.walletState(POSITION, 71733735, OWNER);
  assert.deepEqual([valued.block, valued.sqrtPriceX96, valued.tick, valued.liquidity, valued.poolId], [71733735, 2n ** 96n, 0, 10n ** 12n, POOL]);
  assert.equal(cards.walletState({ ...POSITION, sqrtPriceX96: null, tick: null }, 1, OWNER), null);
});

test('nothing about positions is kept in the browser: no module of the list or the page names any storage, and the memory of created ids is gone', () => {
  const src = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
  for (const path of ['lib/walletPositions.ts', 'lib/walletCards.ts', 'components/positions/OwnedPositions.tsx', 'components/positions/PositionRow.tsx', 'screens/Positions.tsx', 'screens/PositionDetail.tsx', 'components/create/CreatePosition.tsx']) {
    assert.doesNotMatch(src(path), /\b(?:localStorage|sessionStorage|indexedDB)\b|positionMemory|rememberCreated|createdPositions|domino\.positions\.created/, path);
  }
  assert.throws(() => src('lib/positionMemory.ts'), /ENOENT/);
  assert.throws(() => src('lib/ownedPositions.ts'), /ENOENT/);
});
