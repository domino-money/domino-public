/**
 * The wallet's Domino positions on the page (src/lib/walletPositions.ts and
 * src/lib/walletCards.ts, 2026-09-24): the scan's answer checked field by
 * field, the page's own read of the chain (2026-09-25: the scan of
 * functions/_lib/walletPositions.ts run by the page against the public RPC,
 * over the fake chain of tests/owned-chain.mjs, the same answer the route
 * gives), and the cards the rows and a position's page draw from chain data.
 * Replaces tests/owned-positions.test.mjs with the v1 list, its per-row
 * read-service reads and the browser's memory of created ids.
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
    // 2026-09-25: the scan reads the owner's 128 most recent setup operations (8 before): no more deposits than that.
    (r) => (r.deposits = Array.from({ length: 129 }, () => DEPOSIT)),
  ];
  for (const [i, change] of broken.entries()) {
    const reply = clone(REPLY);
    change(reply);
    assert.equal(client.parseWalletAnswer(reply, OWNER), null, `case ${i}: ${change}`);
  }
});

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const never = () => new AbortController().signal;
/** The route's answer for `owner` over `chain`: what POST /api/owned/v2/positions gives. */
const routeAnswer = async (chain, owner = OWNER) =>
  (await endpoint.answerWalletPositions(new Request('https://domino.money/api/owned/v2/positions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner }) }), chain.deps)).json();

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

// Changed on purpose (2026-09-25): the public RPC answers 429 to every call from Cloudflare's edge, so the page no
// longer asks POST /api/owned/v2/positions: it runs the route's own scan against the RPC itself.
test('the page reads the chain itself: the scan’s fixed calls, POSTed to the public RPC with no credentials and no referrer, and the same answer the route gives', async () => {
  const setup = { minted: [{ block: 69_300_000, id: 7 }, { block: 69_400_000, id: 8 }], nfts: { 7: nft(), 8: nft({ liquidity: 0n }) } };
  const chain = fakeChain(setup);
  const { result, sent } = await withFetch((url, init) => chain.deps.fetch(url, init), () => client.readWalletPositions(OWNER.toUpperCase().replace('0X', '0x'), never()));
  assert.equal(result.ok, true);
  assert.deepEqual(result.answer.positions.map((p) => [p.tokenId, p.status]), [['7', 'open'], ['8', 'closed']], 'open first; a closed one (liquidity 0, NFT kept) is listed as closed');
  assert.deepEqual(result.answer.positions[0].currencies, [token(USDG, 'USDG', 6), token(TOKEN, 'UFG', 18)]);
  assert.deepEqual(result.answer, await routeAnswer(fakeChain(setup)), 'the route’s answer, field for field');
  assert.deepEqual(chain.log.map((call) => call.method), ['eth_blockNumber', 'eth_getLogs', 'eth_call', 'eth_call'], 'four calls for a wallet with two positions');
  for (const { url, init } of sent) {
    assert.equal(url, RPC);
    assert.deepEqual({ ...init, body: undefined, signal: undefined }, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: undefined, signal: undefined, credentials: 'omit', referrerPolicy: 'no-referrer' });
  }
  // No wallet to ask about: nothing is asked.
  for (const owner of ['0x1234', `0x${'0'.repeat(40)}`]) {
    const refused = await withFetch(() => assert.fail('asked the chain'), () => client.readWalletPositions(owner, never()));
    assert.deepEqual([refused.result, refused.sent.length], [{ ok: false, reason: 'invalid_owner' }, 0], owner);
  }
  // A read the page dropped makes no call at all.
  const controller = new AbortController();
  controller.abort();
  const dropped = await withFetch(() => assert.fail('asked the chain'), () => client.readWalletPositions(OWNER, controller.signal));
  assert.deepEqual([dropped.result, dropped.sent.length], [{ ok: false, reason: 'aborted' }, 0]);
});

// 2026-09-25: the RPC's own 429 carries `access-control-allow-origin: *,*`, which a browser refuses: the page sees a
// TypeError, never the status. The page's runtime asks such a call once more after REASK_UNREADABLE_MS (the RPC lifts
// a refusal within half a second once the address is quiet), and only a second unreadable reply is that rate limit, so
// the scan waits and asks again.
test('a reply the browser cannot read is asked once more at once, then taken as the RPC’s 429: waited out and asked again; a time-out stays a time-out', async () => {
  const { chainDeps, REASK_UNREADABLE_MS } = require('../.test-build/app/src/lib/chain/browser.js');
  assert.equal(REASK_UNREADABLE_MS, 400);
  const deps = chainDeps();
  const unreadable = await withFetch(() => Promise.reject(new TypeError('Failed to fetch')), () => deps.fetch(RPC, { method: 'POST', body: '{}' }));
  assert.equal(unreadable.result.status, 429);
  assert.equal(unreadable.sent.length, 2, 'asked once more before it counts as a 429');
  let first = true;
  const lifted = await withFetch(() => (first ? ((first = false), Promise.reject(new TypeError('Failed to fetch'))) : Promise.resolve(new Response('{}', { status: 200 }))), () => deps.fetch(RPC, { method: 'POST', body: '{}' }));
  assert.deepEqual([lifted.result.status, lifted.sent.length], [200, 2], 'a refusal lifted by then is no 429 at all');
  const timeout = new DOMException('The operation timed out.', 'TimeoutError');
  await assert.rejects(withFetch(() => Promise.reject(timeout), () => deps.fetch(RPC, { method: 'POST', body: '{}' })), (error) => error === timeout);
  await assert.rejects(deps.fetch('https://example.com', { method: 'POST' }), TypeError, 'no other URL, not even through the runtime');
  // Through the scan: two unreadable replies (one call, asked twice), then the chain; the scan's own wait between them.
  const chain = fakeChain({ minted: [{ block: 69_300_000, id: 7 }], nfts: { 7: nft() } });
  let refused = 0;
  const slept = [];
  const read = await withFetch((url, init) => (refused++ < 2 ? Promise.reject(new TypeError('Failed to fetch')) : chain.deps.fetch(url, init)), () => client.readWalletPositions(OWNER, never(), { ...chainDeps(), sleep: async (ms) => void slept.push(ms) }));
  assert.equal(read.result.ok, true, JSON.stringify(read.result));
  assert.deepEqual(slept, [1500], 'waited as for a 429');
});

test('a failed read says why and is asked again: chain_busy while the RPC rate-limits (after its own waits), chain_unavailable otherwise, never an empty list', async () => {
  const busy = fakeChain({ script: { eth_blockNumber: Array.from({ length: 4 }, () => new Response('', { status: 429 })) } });
  assert.deepEqual(await client.readWalletPositions(OWNER, never(), busy.deps), { ok: false, reason: 'chain_busy' });
  assert.deepEqual(busy.slept, [1500, 3000, 4500], 'the scan’s own waits between its four tries');
  const down = fakeChain({ script: { eth_getLogs: [new Response('', { status: 500 })] } });
  assert.deepEqual(await client.readWalletPositions(OWNER, never(), down.deps), { ok: false, reason: 'chain_unavailable' });
  const odd = fakeChain({ script: { eth_blockNumber: [{ result: 'latest' }] } });
  assert.deepEqual(await client.readWalletPositions(OWNER, never(), odd.deps), { ok: false, reason: 'chain_unavailable' }, 'a reply the scan cannot parse');
  // Every failure of the chain is asked again, after 2, 5 and 10 s and then every 30 s; a dropped read and a bad address are not.
  for (const reason of ['chain_busy', 'chain_unavailable', 'invalid_reply']) assert.equal(client.passingWalletFailure(reason), true, reason);
  for (const reason of ['aborted', 'invalid_owner']) assert.equal(client.passingWalletFailure(reason), false, reason);
  assert.deepEqual([[...client.REASK_MS], client.LATER_MS], [[2000, 5000, 10000], 30000]);
  // The answer after a failure is the whole answer: a wallet with nothing is `ready` and empty, and only then.
  const empty = fakeChain();
  assert.deepEqual(await client.readWalletPositions(OWNER, never(), empty.deps), { ok: true, answer: { owner: OWNER, block: 71_700_000, positions: [], deposits: [] } });
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
  // 2026-09-24 (the three features): the position page's Automate check and the ids Create position made during a visit
  // (kept in the module's memory only, for one fresh list read) are held to the same rule.
  for (const path of ['lib/walletPositions.ts', 'lib/walletCards.ts', 'components/positions/OwnedPositions.tsx', 'components/positions/PositionRow.tsx', 'screens/Positions.tsx', 'screens/PositionDetail.tsx', 'components/create/CreatePosition.tsx', 'components/positions/AutomateEntry.tsx', 'lib/create/createProgress.ts', 'screens/NewPosition.tsx']) {
    assert.doesNotMatch(src(path), /\b(?:localStorage|sessionStorage|indexedDB)\b|positionMemory|rememberCreated|createdPositions|domino\.positions\.created/, path);
  }
  assert.throws(() => src('lib/positionMemory.ts'), /ENOENT/);
  assert.throws(() => src('lib/ownedPositions.ts'), /ENOENT/);
});

// 2026-09-25: the public RPC refuses a visitor's next reads after a costly log scan (a scan of millions of blocks, from
// the contract's deployment, measured that day: the next eth_call answered 429 and the list took 5.9 s). The page keeps,
// per wallet and for the visit only, the ids DominoSetupV1 minted to it and the block it read them at: a later read of
// the same wallet reads the logs only from shortly before that block, and every position's state again at its own head,
// so a close and a new mint since both show at once.
test('a later read of the same wallet reads the logs only since shortly before the earlier one, and every state again at its own head', async () => {
  client.forgetMinted();
  const FIRST = 71_700_000;
  const NEXT = FIRST + 5_000;
  const first = fakeChain({ head: FIRST, minted: [{ block: 69_300_000, id: 7 }], nfts: { 7: nft() } });
  const one = await withFetch((url, init) => first.deps.fetch(url, init), () => client.readWalletPositions(OWNER, never()));
  assert.deepEqual(one.result.answer.positions.map((p) => [p.tokenId, p.status]), [['7', 'open']]);
  const ranges = (chain) => chain.log.filter((call) => call.method === 'eth_getLogs').map((call) => [Number(call.params[0].fromBlock), Number(call.params[0].toBlock)]);
  assert.deepEqual(ranges(first), [[69_249_061, FIRST]], 'the first read scans from the contract’s deployment');
  // Since then: 7 was closed, and 9 was minted.
  const next = fakeChain({ head: NEXT, minted: [{ block: 69_300_000, id: 7 }, { block: FIRST + 100, id: 9 }], nfts: { 7: nft({ liquidity: 0n }), 9: nft() } });
  const two = await withFetch((url, init) => next.deps.fetch(url, init), () => client.readWalletPositions(OWNER, never()));
  assert.deepEqual(ranges(next), [[FIRST - endpoint.REREAD_BLOCKS + 1, NEXT]], 'only the logs since shortly before the first read’s block');
  assert.deepEqual(two.result.answer.positions.map((p) => [p.tokenId, p.status]), [['9', 'open'], ['7', 'closed']], 'the new mint and the close, at once');
  assert.equal(two.result.answer.block, NEXT);
  // A read handed its own runtime (a test's, or the route's) keeps nothing and scans in full.
  const full = fakeChain({ head: NEXT, minted: [{ block: 69_300_000, id: 7 }, { block: FIRST + 100, id: 9 }], nfts: { 7: nft({ liquidity: 0n }), 9: nft() } });
  await client.readWalletPositions(OWNER, never(), full.deps);
  assert.deepEqual(ranges(full), [[69_249_061, NEXT]]);
  client.forgetMinted();
});
