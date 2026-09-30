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
import { decodeFunctionData, toFunctionSelector } from 'viem';
import { KEY, OWNER, POOL, TOKEN, USDG, ZERO, fakeChain, memoryCache, multicallAbi, nft, owned, wallet as endpoint } from './owned-chain.mjs';
import { reachable } from './support/reach.mjs';

const require = createRequire(import.meta.url);
const client = require('../.test-build/app/src/lib/walletPositions.js');
const routingOf = () => require('../.test-build/app/src/lib/chain/browser.js').routing();
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

// Changed on purpose (2026-09-28, the page's fallbacks for an RPC it cannot reach): every stub here is the chain's own
// RPC, there to be reached. The router's reach probe (a no-cors GET, src/lib/chain/failover.ts) is answered as a browser
// answers it for such a server, and is not one of the requests counted; each stub starts with a router that knows
// nothing. tests/rpc-failover.test.mjs has the RPC that cannot be reached.
async function withFetch(answer, run) {
  const sent = [];
  const original = globalThis.fetch;
  routingOf().reset();
  require('../.test-build/app/src/lib/chain/browser.js').resetChainCooldown();
  globalThis.fetch = reachable(async (url, init) => {
    sent.push({ url, init });
    return answer(url, init);
  });
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
  // Changed on purpose 2026-09-28 (speed wave B, items 17 and 23): the head and the owner's nonce in one aggregate3 first (a
  // nonce of 0 is the whole answer), and the page's own read carries each position's subscriber in its first read (the
  // route's does not): still four calls.
  assert.deepEqual(chain.log.map((call) => call.method), ['eth_call', 'eth_getLogs', 'eth_call', 'eth_call'], 'four calls for a wallet with two positions');
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
  const realNow = Date.now;
  let at = realNow();
  let read;
  Date.now = () => at;
  try {
    read = await withFetch((url, init) => (refused++ < 2 ? Promise.reject(new TypeError('Failed to fetch')) : chain.deps.fetch(url, init)), () => client.readWalletPositions(OWNER, never(), { ...chainDeps(), sleep: async (ms) => { slept.push(ms); at += ms; } }));
  } finally { Date.now = realNow; }
  assert.equal(read.result.ok, true, JSON.stringify(read.result));
  assert.deepEqual(slept, [1500, 3000, 4500], 'the bounded retry ladder now respects the six-second shared pause');
  assert.equal(refused, 6, 'only two refused network calls, then the four successful scan calls');
});

test('a failed read says why and is asked again: chain_busy while the RPC rate-limits (after its own waits), chain_unavailable otherwise, never an empty list', async () => {
  // Changed on purpose 2026-09-28 (speed wave B, item 23): the scan's first call is the head and the nonce's aggregate3, and
  // a wallet whose nonce is 0 reads no log.
  const busy = fakeChain({ script: { eth_call: Array.from({ length: 4 }, () => new Response('', { status: 429 })) } });
  assert.deepEqual(await client.readWalletPositions(OWNER, never(), busy.deps), { ok: false, reason: 'chain_busy' });
  assert.deepEqual(busy.slept, [1500, 3000, 4500], 'the scan’s own waits between its four tries');
  const down = fakeChain({ nonce: 1n, script: { eth_getLogs: [new Response('', { status: 500 })] } });
  assert.deepEqual(await client.readWalletPositions(OWNER, never(), down.deps), { ok: false, reason: 'chain_unavailable' });
  const odd = fakeChain({ script: { eth_call: [{ result: 'latest' }] } });
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
  // Changed on purpose 2026-09-28 (one-sided): USDG is this pool's currency0, and the page writes UFG's price in USDG
  // (lib/read/orientation.ts), so a pool tick under the range (UFG dearer) is a price above it, and the other way round.
  assert.equal(inside.inverted, true);
  assert.equal(at(-700).position, 'above');
  assert.equal(at(600).position, 'below', 'v4 counts the upper tick as outside');
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

// Changed on purpose (2026-09-28, the owner, on his phone: Your positions stayed on its loading rows while the RPC refused
// his address): the list keeps one copy of what the chain last answered, per wallet and chain, through the private cards'
// own helpers (finance/privateCards.ts keep and readKept, versioned, dated and bounded), and draws it while the chain is
// read. Display only: checked field by field by parseWalletAnswer, its positions only, never a held deposit. Still, no
// module of the list or the page names any storage itself, and the memory of created ids is gone.
test('nothing about positions is kept in the browser but the list’s display copy: no module of the list or the page names any storage, and the memory of created ids is gone', () => {
  const src = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
  const list = src('components/positions/OwnedPositions.tsx');
  assert.match(list, /const copyName = \(owner: string\) => `owned\.\$\{CHAIN_ID\}\.\$\{owner\}`/, 'one copy per wallet and chain');
  assert.match(list, /readKept\(copyName\(owner\), 7 \* 86_400_000, \(data, at\) => \{\s+const answer = parseWalletAnswer\(data, owner\)\s+return answer\?\.positions\.length \? \{ answer, at \} : null/, 'at most a week old, checked as a chain answer, with a position in it, and dated');
  // 2026-09-28 (review): a copy's USD figures are its own pool prices, as old as it is. Past the Wallet card's own limit
  // for a price (lib/walletMemory.ts WALLET_PRICE_MAX_AGE_MS, an hour: "an older price gives no value and no total"), its
  // rows are valued at no state (their token amounts only) and the band waits for the chain, as while the list is read.
  const { WALLET_PRICE_MAX_AGE_MS } = require('../.test-build/app/src/lib/walletMemory.js');
  assert.equal(Number(/const PRICED_MS = ([\d_]+)/.exec(list)?.[1].replaceAll('_', '')), WALLET_PRICE_MAX_AGE_MS, 'the Wallet card’s own limit for a price');
  assert.match(list, /useState\(\(\) => !!copy && Date\.now\(\) - copy\.at <= PRICED_MS\)/, 'measured against the copy’s own time');
  assert.match(list, /setTimeout\(\(\) => setValued\(false\), copy\.at \+ PRICED_MS - Date\.now\(\)\)/, 'and no longer valued once that time passes on screen');
  assert.match(list, /state: priced \? walletState\(position, list\.block, owner\) : null/, 'amounts only past it');
  assert.match(list, /\(!tabs \|\| !priced\) && !unread \? <PendingSummary \/>/, 'no total: the band waits for the chain');
  assert.match(list, /keep\(copyName\(owner\), \{ \.\.\.ready, deposits: \[\] \}\)/, 'the chain’s answers only, without their held deposits');
  assert.equal([...list.matchAll(/\bkeep\(/g)].length, 1, 'kept in one place');
  assert.match(list, /else if \(ready\) drop\(copyName\(owner\)\)/, 'and forgotten once the chain says the wallet has none');
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

// 2026-09-27, the owner's OK ("pode fazer") on the study of 7074cbd: Your positions reads itself again every 30 s while
// the tab is visible (src/lib/walletPositions.ts askWallet, useWalletAnswer's `every`), in place. An answer from an older
// block, one that read fewer figures, and one that shows the same are never drawn over the answer on screen; a refresh
// that fails keeps it and is asked again after 60 s, then 120 s, never after the 2/5/10 s ladder; a wallet whose scan is
// not incremental is never refreshed; a hidden tab asks nothing.
test('a refresh is drawn only when it is newer, as complete and different: an older block, fewer figures and the same answer keep the one on screen', () => {
  const next = clone(REPLY);
  next.block += 5;
  assert.equal(client.sameRows(REPLY, next), true, 'the same rows and figures at a later block');
  next.positions[0].unclaimedFees = ['13', '34'];
  assert.equal(client.sameRows(REPLY, next), false, 'a figure changed');
  assert.equal(client.poorer(REPLY, next), false, 'changed figures are no fewer');
  // Each figure the chain may leave unread, lost where the answer on screen had it: a refresh that failed.
  const lost = [
    (r) => Object.assign(r.positions[0], { sqrtPriceX96: null, tick: null, principal: null }),
    (r) => (r.positions[0].unclaimedFees = null),
    (r) => (r.positions[0].principal = null),
    (r) => (r.positions[1].currencies[1] = token(TOKEN, null, 6)),
    (r) => (r.positions[0].currencies[0] = token(USDG, 'USDG', null)),
    (r) => (r.deposits[0].currencies[1] = token(r.deposits[0].currency1, null, null)),
  ];
  for (const [i, change] of lost.entries()) {
    const reply = clone(REPLY);
    change(reply);
    assert.equal(client.poorer(REPLY, reply), true, `case ${i}: ${change}`);
  }
  // Nothing was lost: a new row the chain could not price, a row that was already unread, a row that is gone.
  const unread = clone(REPLY);
  Object.assign(unread.positions[0], { sqrtPriceX96: null, tick: null, principal: null, unclaimedFees: null });
  assert.equal(client.poorer(unread, unread), false, 'still unread is not fewer');
  assert.equal(client.poorer(unread, REPLY), false, 'read now');
  const added = clone(REPLY);
  added.positions.push({ ...clone(POSITION), tokenId: '3200000', sqrtPriceX96: null, tick: null, principal: null, unclaimedFees: null });
  assert.equal(client.poorer(REPLY, added), false, 'a new position read without its price');
  const gone = clone(REPLY);
  gone.positions.pop();
  gone.deposits = [];
  assert.equal(client.poorer(REPLY, gone), false, 'a closed NFT sent away, a deposit refunded');
  assert.deepEqual([client.REFRESH_MS, client.REFRESH_FLOOR_MS, [...client.REFRESH_FAILED_MS]], [30_000, 15_000, [60_000, 120_000]]);
});

/** A document that is shown or hidden as a test says, for the page's visibility rule (lib/read/screens/quietRead.ts). */
function fakeDocument() {
  const doc = new EventTarget();
  doc.hidden = false;
  doc.show = (shown) => {
    doc.hidden = !shown;
    doc.dispatchEvent(new Event('visibilitychange'));
  };
  return doc;
}
/** Lets every settled read's answer reach the loop. */
const settle = () => new Promise((done) => setImmediate(done));
const answerAt = (block, patch = {}) => ({ ok: true, answer: { ...clone(REPLY), block, ...patch } });

/**
 * askWallet over reads a test answers (`answers`, one per read, in order; a function is called with the read's number),
 * a document it shows and hides, and node's mock setTimeout. `minted`: whether the page's memory holds the wallet's
 * minted ids (a real scan of a fake chain puts them there), which is what lets the list refresh at all.
 */
async function loop(t, { every = client.REFRESH_MS, minted = true, paused, answers = [] } = {}) {
  client.forgetMinted();
  if (minted) {
    const chain = fakeChain({ minted: [{ block: 69_300_000, id: 7 }], nfts: { 7: nft() } });
    await withFetch((url, init) => chain.deps.fetch(url, init), () => client.readWalletPositions(OWNER, never()));
  }
  const doc = fakeDocument();
  const before = globalThis.document;
  globalThis.document = doc;
  t.after(() => {
    globalThis.document = before;
    client.forgetMinted();
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reads = [];
  const puts = [];
  const shown = { current: null };
  const read = async (owner, signal) => {
    reads.push({ owner, signal });
    const next = answers.shift();
    return typeof next === 'function' ? next(reads.length) : (next ?? { ok: false, reason: 'chain_unavailable' });
  };
  const cancel = client.askWallet(OWNER, shown, (value) => puts.push(value), every, paused, read);
  await settle();
  /** Moves the clock by `ms` and lets the read it caused settle. */
  const pass = async (ms) => {
    t.mock.timers.tick(ms);
    await settle();
  };
  return { doc, reads, puts, shown, cancel, pass, answers };
}

test('the list refreshes every 30 s after its last read settled: an older block, fewer figures or the same answer draws nothing, and a new one is drawn in place', async (t) => {
  const first = answerAt(100);
  const newer = answerAt(140);
  newer.answer.positions[0].unclaimedFees = ['99', '34'];
  const poorer = answerAt(150);
  poorer.answer.positions[0].unclaimedFees = null;
  const same = answerAt(160);
  same.answer.positions[0].unclaimedFees = ['99', '34'];
  const s = await loop(t, { answers: [first, answerAt(90, { positions: [] }), newer, same, poorer] });
  assert.deepEqual([s.reads.length, s.puts.map((put) => put.phase)], [1, ['ready']]);
  assert.equal(s.shown.current, first.answer);
  await s.pass(29_999);
  assert.equal(s.reads.length, 1, 'not before 30 s');
  await s.pass(1);
  assert.equal(s.reads.length, 2);
  assert.equal(s.puts.length, 1, '(a) an older block (a node behind the head) is not drawn, though it lists nothing');
  await s.pass(30_000);
  assert.equal(s.reads.length, 3, 'and the refresh goes on at its pace');
  assert.deepEqual([s.puts.length, s.puts[1].phase, s.puts[1].answer], [2, 'ready', newer.answer], 'a newer answer is drawn');
  await s.pass(30_000);
  assert.equal(s.reads.length, 4);
  assert.equal(s.puts.length, 2, '(c) the same rows and figures at a later block draw nothing');
  assert.equal(s.shown.current, newer.answer, 'the very object on screen stays');
  await s.pass(30_000);
  assert.equal(s.reads.length, 5);
  assert.equal(s.puts.length, 2, '(b) an answer with fewer figures is not drawn');
  // Taken as a failed refresh: asked again after 60 s, not 30.
  s.answers.push(answerAt(170));
  await s.pass(30_000);
  assert.equal(s.reads.length, 5, 'a refresh that read fewer figures waits 60 s');
  await s.pass(30_000);
  assert.equal(s.reads.length, 6);
  assert.equal(s.puts.at(-1).answer.block, 170);
  // The loop stops with its screen: nothing is asked after the cancel, and the read on its way is dropped.
  s.cancel();
  await s.pass(600_000);
  assert.equal(s.reads.length, 6);
  assert.equal(s.reads.at(-1).signal.aborted, true);
});

test('a refresh that fails keeps the answer on screen and no line over it: asked again after 60 s, then every 120 s, never after 2, 5 or 10 s, and back to 30 s once it answers', async (t) => {
  const s = await loop(t, { answers: [answerAt(100), { ok: false, reason: 'chain_busy' }, { ok: false, reason: 'chain_unavailable' }, { ok: false, reason: 'invalid_reply' }, answerAt(200, { deposits: [] }), answerAt(300)] });
  await s.pass(30_000);
  assert.equal(s.reads.length, 2, 'the first refresh');
  assert.deepEqual(s.puts.map((put) => put.phase), ['ready'], 'a failed refresh draws nothing: no retrying, no failed, no loading');
  // 2, 5 and 10 s after it (17 s in all), then the list's own 30 s: none of them asks.
  for (const ms of [2_000, 3_000, 5_000, 7_000, 13_000]) await s.pass(ms);
  assert.equal(s.reads.length, 2, 'never the quick ladder, and not at the list’s own pace');
  await s.pass(29_999);
  assert.equal(s.reads.length, 2);
  await s.pass(1);
  assert.equal(s.reads.length, 3, 'after 60 s');
  await s.pass(119_999);
  assert.equal(s.reads.length, 3);
  await s.pass(1);
  assert.equal(s.reads.length, 4, 'then after 120 s');
  await s.pass(120_000);
  assert.equal(s.reads.length, 5, 'and 120 s again');
  assert.deepEqual([s.puts.length, s.puts[1].answer.block], [2, 200], 'drawn once it answers');
  await s.pass(30_000);
  assert.equal(s.reads.length, 6, 'at the list’s own pace again');
  assert.equal(s.puts.at(-1).answer.block, 300);
  s.cancel();
});

test('a hidden tab asks nothing: a refresh due while it is hidden waits and runs once when it is shown again; a paused list and a wallet at the scan’s cap are never refreshed; the pace is never under 15 s', async (t) => {
  const s = await loop(t, { answers: [answerAt(100), answerAt(200), answerAt(300)] });
  s.doc.show(false);
  await s.pass(30_000);
  await s.pass(600_000);
  assert.equal(s.reads.length, 1, 'nothing while hidden');
  s.doc.show(true);
  await settle();
  assert.equal(s.reads.length, 2, 'once, when shown again');
  s.doc.show(false);
  s.doc.show(true);
  await settle();
  assert.equal(s.reads.length, 2, 'showing the tab asks nothing more before the next refresh is due');
  await s.pass(30_000);
  assert.equal(s.reads.length, 3);
  s.cancel();
  t.mock.timers.reset();

  // A held deposit's refund on its way: the refresh waits, and goes on once it is over.
  const paused = { current: false };
  const held = await loop(t, { paused, answers: [answerAt(100), answerAt(200)] });
  paused.current = true;
  await held.pass(30_000);
  await held.pass(30_000);
  assert.equal(held.reads.length, 1, 'no refresh while a refund is on its way');
  paused.current = false;
  await held.pass(30_000);
  assert.equal(held.reads.length, 2);
  // A refresh that failed waits for the refund too before it is asked again.
  await held.pass(30_000);
  assert.equal(held.reads.length, 3, 'this one fails');
  paused.current = true;
  await held.pass(60_000);
  await held.pass(30_000);
  assert.equal(held.reads.length, 3, 'its retry waits while a refund is on its way');
  paused.current = false;
  await held.pass(30_000);
  assert.equal(held.reads.length, 4);
  held.cancel();
  t.mock.timers.reset();

  // The pace asked for is never under 15 s.
  const quick = await loop(t, { every: 1_000, answers: [answerAt(100), answerAt(200)] });
  await quick.pass(14_999);
  assert.equal(quick.reads.length, 1);
  await quick.pass(1);
  assert.equal(quick.reads.length, 2);
  quick.cancel();
  t.mock.timers.reset();

  // A wallet the scan stopped at its cap for has no minted ids in the page's memory: each read would scan from the
  // contract's deployment, so it is never refreshed.
  const capped = await loop(t, { minted: false, answers: [answerAt(100)] });
  await capped.pass(600_000);
  assert.deepEqual([capped.reads.length, capped.puts.length], [1, 1]);
  capped.cancel();
});

// 2026-09-28 (the owner, on his phone: Your positions stayed on its loading rows, "Reading your positions from the
// chain…"): a first read the RPC refused (chain_busy) is asked again 2 s later twice (it held every other read of this
// browser meanwhile: lib/chain/browser.ts holdReads, and a refusal rests every lane and the list's APR), then after the
// ladder's 10 s and every 30 s: as many reads as the owner's ladder of 2026-09-25, none of them later. Changed on purpose
// (review, 2026-09-28): 2 s every time, for ever, sent three times the requests while refused, and against a limiter
// that lengthens its refusal at each refused call it never let the list in (tests/chain-priority.test.mjs proves the
// bounded waits do). The card's lines are the same: retrying three times, then the calm one. Any other failure keeps
// the ladder (below).
test('a first read the RPC refused is asked again 2 s later twice, then after 10 s and every 30 s, never more often than the ladder, and drawn once it answers', async (t) => {
  const busy = await loop(t, { answers: Array.from({ length: 6 }, () => ({ ok: false, reason: 'chain_busy' })) });
  for (const [ms, count] of [[2_000, 2], [2_000, 3], [10_000, 4], [30_000, 5], [30_000, 6]]) {
    await busy.pass(ms - 1);
    assert.equal(busy.reads.length, count - 1);
    await busy.pass(1);
    assert.equal(busy.reads.length, count, `read ${count}, ${ms} ms after the one before`);
  }
  assert.deepEqual(busy.puts.map((put) => put.phase), ['retrying', 'retrying', 'retrying', 'failed', 'failed', 'failed']);
  assert.deepEqual(busy.puts.map((put) => put.reason), Array(6).fill('chain_busy'));
  busy.answers.push(answerAt(100));
  await busy.pass(29_999);
  assert.equal(busy.reads.length, 6, 'no read sooner than every 30 s once the ladder is spent');
  await busy.pass(1);
  assert.equal(busy.reads.length, 7);
  assert.equal(busy.puts.at(-1).phase, 'ready');
  busy.cancel();
  // A refusal among other failures: 2 s only where the ladder's second wait (5 s) would be.
  t.mock.timers.reset();
  const mixed = await loop(t, { every: null, answers: [{ ok: false, reason: 'chain_unavailable' }, { ok: false, reason: 'chain_busy' }, { ok: false, reason: 'chain_busy' }, { ok: false, reason: 'chain_busy' }] });
  for (const [ms, count] of [[2_000, 2], [2_000, 3], [10_000, 4], [30_000, 5]]) {
    await mixed.pass(ms - 1);
    assert.equal(mixed.reads.length, count - 1);
    await mixed.pass(1);
    assert.equal(mixed.reads.length, count, `mixed: read ${count}, ${ms} ms after the one before`);
  }
  mixed.cancel();
});

test('an announced page cooldown schedules the next wallet scan at expiry, without spending the retry ladder on local refusals', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const s = await loop(t, { minted: false, every: null, answers: [
    () => ({ ok: false, reason: 'chain_busy', retryAt: now + 24_000 }),
    () => ({ ok: false, reason: 'chain_busy', retryAt: now + 30_000 }),
    () => ({ ok: false, reason: 'chain_busy', retryAt: now + 1_000 }),
    answerAt(100),
  ] });
  for (const [ms, count] of [[24_000, 2], [30_000, 3], [2_000, 4]]) {
    now += ms - 1;
    await s.pass(ms - 1);
    assert.equal(s.reads.length, count - 1, 'no scan during the announced wait or before the two-second minimum');
    now += 1;
    await s.pass(1);
    assert.equal(s.reads.length, count, `scan ${count} at the announced deadline, not after the ladder’s later delay`);
  }
  assert.deepEqual(s.puts.map((put) => put.phase), ['retrying', 'retrying', 'retrying', 'ready']);
  assert.equal(s.shown.current.block, 100);
  s.cancel();
});

test('cancelling a wallet read during an announced cooldown never starts another scan', async (t) => {
  const s = await loop(t, { minted: false, every: null, answers: [{ ok: false, reason: 'chain_busy', retryAt: Date.now() + 24_000 }, answerAt(100)] });
  await s.pass(1_000);
  s.cancel();
  await s.pass(30_000);
  assert.equal(s.reads.length, 1);
  assert.equal(s.puts.at(-1).phase, 'retrying');
});

test('a shared failure read five seconds later keeps its original cooldown deadline instead of restarting the wait', async (t) => {
  const failedAt = Date.now();
  const sharedFailure = { ok: false, reason: 'chain_busy', retryAt: failedAt + 24_000 };
  t.mock.method(Date, 'now', () => failedAt + 5_000);
  const s = await loop(t, { minted: false, every: null, answers: [sharedFailure, answerAt(100)] });
  await s.pass(18_999);
  assert.equal(s.reads.length, 1, 'no scan before the original deadline');
  await s.pass(1);
  assert.equal(s.reads.length, 2, 'the five seconds already elapsed are not waited again');
  assert.equal(s.puts.at(-1).phase, 'ready');
  s.cancel();
});

test('with the refresh off (the picker, the automation page, a position’s page) nothing is read again on its own; a first read that fails is still asked after 2, 5, 10 and then every 30 s', async (t) => {
  const off = await loop(t, { every: null, answers: [answerAt(100)] });
  await off.pass(600_000);
  assert.equal(off.reads.length, 1);
  off.cancel();
  t.mock.timers.reset();
  const failing = await loop(t, { every: null });
  assert.deepEqual(failing.puts.map((put) => put.phase), ['retrying']);
  for (const [ms, count] of [[2_000, 2], [5_000, 3], [10_000, 4], [30_000, 5], [30_000, 6]]) {
    await failing.pass(ms - 1);
    assert.equal(failing.reads.length, count - 1);
    await failing.pass(1);
    assert.equal(failing.reads.length, count, `after ${ms} ms`);
  }
  assert.deepEqual(failing.puts.map((put) => put.phase), ['retrying', 'retrying', 'retrying', 'failed', 'failed', 'failed']);
  assert.deepEqual(failing.puts.map((put) => put.reason), Array(6).fill('chain_unavailable'));
  failing.cancel();
});

// The review of 2026-09-27: the guards are the refresh's only. A reader with it off (the Sequence picker, the automation
// page's useListedPosition) asks again only after an action (`asked` grows), over the answer already on screen: what it
// reads is drawn and ends its reads, as before the refresh, whatever it read. With the guards on, an answer that read
// fewer figures was taken as a failure and asked again after 2, 5 and 10 s, then every 30 s, for ever.
test('with the refresh off, a read asked again over the answer on screen is drawn and ends the reads, even when it read fewer figures, is older or is the same', async (t) => {
  const s = await loop(t, { every: null, answers: [answerAt(100)] });
  assert.deepEqual([s.reads.length, s.puts.length], [1, 1]);
  s.cancel();
  const fewer = answerAt(200);
  fewer.answer.positions[0].unclaimedFees = null;
  const older = answerAt(90);
  older.answer.positions[0].unclaimedFees = ['99', '34'];
  const same = answerAt(300);
  same.answer.positions[0].unclaimedFees = ['99', '34'];
  for (const [label, next] of [['fewer figures', fewer], ['an older block', older], ['the same rows', same]]) {
    const reads = [];
    const puts = [];
    // What useWalletAnswer does when `asked` grows: a new askWallet over the same answer on screen.
    const cancel = client.askWallet(OWNER, s.shown, (value) => puts.push(value), null, undefined, async () => (reads.push(1), next));
    await settle();
    assert.deepEqual(puts, [{ phase: 'ready', answer: next.answer }], `${label}: drawn`);
    assert.equal(s.shown.current, next.answer);
    await s.pass(600_000);
    assert.equal(reads.length, 1, `${label}: and nothing more is asked`);
    cancel();
  }
});

// 2026-09-28 (speed wave B, item 18: every way back to Positions showed its loading rows again, and a position's page scanned
// the wallet again only to decide its Automate): the page's own read of a wallet is kept in its memory for KEPT_MS, drawn
// at once by the next screen that asks (the refresh then asks it as it would have), its rows found by id, and forgotten
// after an action or a position created since.
test('a wallet answer the page read is kept for a minute: the next screen draws it at once and reads nothing, until an action forgets it', async () => {
  const create = require('../.test-build/app/src/lib/create/createProgress.js');
  client.forgetMinted();
  const setup = { minted: [{ block: 69_300_000, id: 7 }], nfts: { 7: nft() } };
  const chain = fakeChain(setup);
  const first = await withFetch((url, init) => chain.deps.fetch(url, init), () => client.readWalletPositions(OWNER, never()));
  assert.equal(first.result.ok, true);
  assert.equal(client.KEPT_MS, 60_000);
  // A position's page finds its row.
  assert.deepEqual([client.keptPosition('7')?.owner, client.keptPosition('7')?.position.tokenId], [OWNER, '7']);
  assert.equal(client.keptPosition('8'), null);
  // The next screen (a picker, a position's page: no refresh) draws it at once and asks nothing.
  const puts = [];
  const none = await withFetch(() => assert.fail('asked the chain'), async () => {
    const cancel = client.askWallet(OWNER, { current: null }, (value) => puts.push(value));
    await new Promise((done) => setTimeout(done, 20));
    cancel();
  });
  assert.deepEqual([none.sent.length, puts.map((put) => put.phase)], [0, ['ready']]);
  assert.equal(puts[0].answer.positions[0].tokenId, '7');
  // After an action (Close, Collect, a refund): forgotten, and read again.
  client.forgetWallet();
  assert.equal(client.keptPosition('7'), null);
  await withFetch((url, init) => fakeChain(setup).deps.fetch(url, init), () => client.readWalletPositions(OWNER, never()));
  assert.ok(client.keptPosition('7'));
  // A position Create position made since: not drawn from before it.
  create.publishCreated('99');
  assert.equal(client.keptPosition('7'), null);
  create.publishCreated(null);
  client.forgetMinted();
});

/** Calls a hook outside a React tree (these tests have no DOM): its effects run at once, and a store is read as it stands. */
function callHook(use) {
  const internals = require('react').__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const before = internals.H;
  internals.H = { useEffect: (effect) => void effect(), useSyncExternalStore: (_subscribe, snapshot) => snapshot() };
  try {
    return use();
  } finally {
    internals.H = before;
  }
}

// 2026-09-28 (speed wave B review, item 17): the page's own read of a wallet (readWalletPositions with no runtime handed
// in) asks the scan for each position's feature, and hands it to the automation view: the badges come with the rows,
// with no read of their own (the automation's own scan: a head and an aggregate3, some 0.6 s later). The scan's half is
// tests/owned.test.mjs; this is the page's wiring of it, which a read that no longer asked for it would leave green.
test('the page’s own read of a wallet carries each position’s feature: its subscriber in the first read, and the automation view ready from it with nothing read', async () => {
  const automation = require('../.test-build/app/src/lib/automationState.js');
  const flags = [globalThis.__DOMINO_DEPLOYABLE__, globalThis.__DOMINO_TEST_HOOKS__];
  // A build that reads the chain: a view with nothing noted would ask the automation's own scan.
  globalThis.__DOMINO_DEPLOYABLE__ = true;
  globalThis.__DOMINO_TEST_HOOKS__ = false;
  client.forgetMinted();
  client.forgetWallet();
  try {
    const chain = fakeChain({ minted: [{ block: 69_300_000, id: 41 }, { block: 69_400_000, id: 42 }], nfts: { 41: nft(), 42: nft({ liquidity: 0n }) } });
    const read = await withFetch((url, init) => chain.deps.fetch(url, init), () => client.readWalletPositions(OWNER, never()));
    assert.equal(read.result.ok, true);
    assert.deepEqual(chain.log.map((call) => call.method), ['eth_call', 'eth_getLogs', 'eth_call', 'eth_call'], 'the list’s own four calls');
    const first = decodeFunctionData({ abi: multicallAbi, data: chain.log[2].params[0].data }).args[0];
    const subscriber = toFunctionSelector('subscriber(uint256)');
    for (const id of [41n, 42n]) {
      const asked = first.filter((call) => BigInt(`0x${call.callData.slice(10)}`) === id && call.target.toLowerCase() === owned.POSITION_MANAGER).map((call) => call.callData.slice(0, 10));
      assert.ok(asked.includes(subscriber), `${id}: its subscriber in the first read (${asked.join()})`);
    }
    // A screen that shows the positions' automation now: ready at once, from the list's read, and nothing asked.
    const shown = await withFetch(
      () => assert.fail('the automation read its own'),
      async () => {
        const views = ['41', '42'].map((id) => callHook(() => automation.useAutomation(id)));
        await new Promise((done) => setTimeout(done, 50));
        return [views, ['41', '42'].map((id) => callHook(() => automation.useAutomation(id)))];
      },
    );
    assert.equal(shown.sent.length, 0, 'no read of its own');
    for (const views of shown.result) assert.deepEqual(views.map((view) => [view.phase, view.state?.tokenId, view.state?.automation]), [['ready', '41', 'plain'], ['ready', '42', 'plain']]);
  } finally {
    [globalThis.__DOMINO_DEPLOYABLE__, globalThis.__DOMINO_TEST_HOOKS__] = flags;
    client.forgetMinted();
    client.forgetWallet();
  }
});
