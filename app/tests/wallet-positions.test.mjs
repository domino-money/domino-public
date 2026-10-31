/**
 * The wallet's Domino positions on the page (src/lib/walletPositions.ts and
 * src/lib/walletCards.ts, 2026-09-24): the scan's answer checked field by
 * field, the page's read of it, and the cards the rows and a position's page
 * draw from chain data. Replaces tests/owned-positions.test.mjs with the v1
 * list, its per-row read-service reads and the browser's memory of created ids.
 *
 * RPC-SPEC (2026-10-01, the owner's rule: nothing is read from a public RPC): the page asks the site's own route again,
 * POST /api/owned/v2/positions (src/lib/edge/chainRoutes.ts), answered here by tests/support/edge-routes.mjs: the
 * route's contract over the scan of functions/_lib/walletPositions.ts and the fake chain of tests/owned-chain.mjs.
 * From 2026-09-25 to that day the page ran the scan itself against the public RPC.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { decodeFunctionData, toFunctionSelector } from 'viem';
import { KEY, OWNER, POOL, TOKEN, USDG, ZERO, fakeChain, multicallAbi, nft, owned, wallet as endpoint } from './owned-chain.mjs';
import { edgeFetch } from './support/edge-routes.mjs';

const require = createRequire(import.meta.url);
const client = require('../.test-build/app/src/lib/walletPositions.js');
const routes = require('../.test-build/app/src/lib/edge/chainRoutes.js');
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

const never = () => new AbortController().signal;
/** The route's answer for `owner` over `chain`, as the scan's own route gave it before (functions/_lib/walletPositions.ts). */
const routeAnswer = async (chain, owner = OWNER) =>
  (await endpoint.answerWalletPositions(new Request('https://domino.money/api/owned/v2/positions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner }) }), chain.deps)).json();

/**
 * The site's route over `chain` (tests/support/edge-routes.mjs), as the page's client asks it: the `post` the read takes,
 * and every request it sent (its path and init). `options` are edgeRoutes' own (source, log).
 */
function viaEdge(chain, options) {
  const sent = [];
  const answer = edgeFetch(chain.deps, options);
  const fetch = async (path, init) => {
    sent.push({ path, init });
    return answer(path, init);
  };
  return { sent, post: (owner, fresh, options = {}) => routes.postOwnedPositions(owner, fresh, { ...options, fetch }) };
}
/** Runs `run` with the page's own network call answering `answer` (the default client's path); what it was asked. */
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
/** A `post` whose network call answers `response` (a Response, or a function of the request's body). */
const answering = (response) => {
  const sent = [];
  return { sent, post: (owner, fresh, options = {}) => routes.postOwnedPositions(owner, fresh, { ...options, fetch: async (path, init) => (sent.push(JSON.parse(init.body)), typeof response === 'function' ? response(JSON.parse(init.body)) : response.clone()) }) };
};
const reply = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

// Changed on purpose (RPC-SPEC, 2026-10-01): the page asks the site's own route again, which reads Domino's own node at the
// edge. From 2026-09-25 it ran the route's scan itself against the public RPC, which answered 429 to Cloudflare's edge.
test('the page asks the site’s own route: one same-origin POST of the owner, the route’s envelope, the same answer the scan gives', async () => {
  client.forgetWallet();
  const setup = { minted: [{ block: 69_300_000, id: 7 }, { block: 69_400_000, id: 8 }], nfts: { 7: nft(), 8: nft({ liquidity: 0n }) } };
  const chain = fakeChain(setup);
  const edge = viaEdge(chain);
  const result = await client.readWalletPositions(OWNER.toUpperCase().replace('0X', '0x'), never(), edge.post);
  assert.equal(result.ok, true);
  assert.deepEqual(result.answer.positions.map((p) => [p.tokenId, p.status]), [['7', 'open'], ['8', 'closed']], 'open first; a closed one (liquidity 0, NFT kept) is listed as closed');
  assert.deepEqual(result.answer.positions[0].currencies, [token(USDG, 'USDG', 6), token(TOKEN, 'UFG', 18)]);
  assert.deepEqual(result.answer, await routeAnswer(fakeChain(setup)), 'the scan’s answer, field for field');
  // One POST of the wallet, lowercase, to the route's fixed path: this site's cookies, no cache, no redirect.
  assert.equal(edge.sent.length, 1);
  assert.equal(edge.sent[0].path, '/api/owned/v2/positions');
  assert.deepEqual(JSON.parse(edge.sent[0].init.body), { owner: OWNER });
  assert.deepEqual({ ...edge.sent[0].init, body: undefined, signal: undefined }, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: undefined, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: undefined });
  // The edge's scan reads the chain; the page reads nothing of it itself.
  // The route read the chain (its own calls and windows: tests/chain-routes.test.mjs); the page read nothing of it itself.
  assert.ok(chain.log.length > 0 && chain.log.every((call) => ['eth_call', 'eth_getLogs', 'eth_blockNumber'].includes(call.method)), 'the route’s reads, and only reads');
  // No wallet to ask about: nothing is asked.
  for (const owner of ['0x1234', `0x${'0'.repeat(40)}`]) {
    const refused = answering(() => assert.fail('asked the route'));
    assert.deepEqual([await client.readWalletPositions(owner, never(), refused.post), refused.sent.length], [{ ok: false, reason: 'invalid_owner' }, 0], owner);
  }
  // A read the page dropped makes no call at all; one dropped on its way is `aborted`.
  const controller = new AbortController();
  controller.abort();
  const dropped = answering(() => assert.fail('asked the route'));
  assert.deepEqual([await client.readWalletPositions(OWNER, controller.signal, dropped.post), dropped.sent.length], [{ ok: false, reason: 'aborted' }, 0]);
  const leaving = new AbortController();
  const late = answering(() => (leaving.abort(), reply({})));
  assert.deepEqual(await client.readWalletPositions(OWNER, leaving.signal, late.post), { ok: false, reason: 'aborted' });
  client.forgetWallet();
});

// The unreadable-reply-as-429 retry went with lib/chain/browser.ts (RPC-SPEC §3.5 and §7.2): the list reads no RPC.

test('a failed read says why and is asked again: chain_busy while the route or the node rate-limits (with its wait), chain_unavailable otherwise (with the wait when the source is away), never an empty list', async (t) => {
  // (2026-10-15, pack 8, Q3): the jitter's draw held at 0 here, so each wait named is read exactly; tests/jitter.test.mjs
  // shows every such wait spread over a quarter more, never less.
  t.mock.method(Math, 'random', () => 0);
  const NOW = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => NOW);
  // The node refuses the scan's calls: the route's own waits, then 502 chain_busy, Retry-After 12.
  const busy = fakeChain({ script: { eth_call: Array.from({ length: 4 }, () => new Response('', { status: 429 })) } });
  assert.deepEqual(await client.readWalletPositions(OWNER, never(), viaEdge(busy).post), { ok: false, reason: 'chain_busy', retryAt: NOW + 12_000 });
  assert.deepEqual(busy.slept, [1500, 3000, 4500], 'the route’s scan waited between its four tries');
  // The visitor's own limiter (429 with Retry-After), and one with none (the client's five seconds).
  assert.deepEqual(await client.readWalletPositions(OWNER, never(), answering(reply({ error: 'rate_limited' }, 429, { 'Retry-After': '7' })).post), { ok: false, reason: 'chain_busy', retryAt: NOW + 7_000 });
  assert.deepEqual(await client.readWalletPositions(OWNER, never(), answering(reply({ error: 'rate_limited' }, 429)).post), { ok: false, reason: 'chain_busy', retryAt: NOW + 5_000 });
  // The node failing: 502 chain_unavailable with its short wait, asked again on the ladder (no deadline of its own).
  const down = fakeChain({ nonce: 1n, script: { eth_getLogs: [new Response('', { status: 500 })] } });
  assert.deepEqual(await client.readWalletPositions(OWNER, never(), viaEdge(down).post), { ok: false, reason: 'chain_unavailable' });
  const odd = fakeChain({ script: { eth_call: [{ result: 'latest' }] } });
  assert.deepEqual(await client.readWalletPositions(OWNER, never(), viaEdge(odd).post), { ok: false, reason: 'chain_unavailable' }, 'a reply the scan cannot parse');
  // The source away (no node secret, or the node away): 503 with a wait of a minute or more, said with its deadline,
  // bounded to five minutes.
  const off = viaEdge(fakeChain(), { source: () => 'off' });
  assert.deepEqual(await client.readWalletPositions(OWNER, never(), off.post), { ok: false, reason: 'chain_unavailable', retryAt: NOW + 300_000 });
  assert.deepEqual(await client.readWalletPositions(OWNER, never(), answering(reply({ error: 'source_unavailable' }, 503, { 'Retry-After': '60' })).post), { ok: false, reason: 'chain_unavailable', retryAt: NOW + 60_000 });
  assert.deepEqual(await client.readWalletPositions(OWNER, never(), answering(reply({ error: 'source_unavailable' }, 503, { 'Retry-After': '9999' })).post), { ok: false, reason: 'chain_unavailable', retryAt: NOW + client.MAX_REASK_MS });
  // A connection that failed, a route that is not there (an older deployment), anything else: chain_unavailable.
  const failing = { post: (owner, fresh, options = {}) => routes.postOwnedPositions(owner, fresh, { ...options, fetch: async () => { throw new TypeError('Failed to fetch'); } }) };
  assert.deepEqual(await client.readWalletPositions(OWNER, never(), failing.post), { ok: false, reason: 'chain_unavailable' });
  assert.deepEqual(await client.readWalletPositions(OWNER, never(), answering(reply({ error: 'not_found' }, 404)).post), { ok: false, reason: 'chain_unavailable' });
  assert.deepEqual(await client.readWalletPositions(OWNER, never(), async () => { throw new Error('a client that throws'); }), { ok: false, reason: 'chain_unavailable' });
  // Every failure is asked again, after 2, 5 and 10 s and then every 30 s; a dropped read and a bad address are not.
  for (const reason of ['chain_busy', 'chain_unavailable', 'invalid_reply']) assert.equal(client.passingWalletFailure(reason), true, reason);
  for (const reason of ['aborted', 'invalid_owner']) assert.equal(client.passingWalletFailure(reason), false, reason);
  assert.deepEqual([[...client.REASK_MS], client.LATER_MS, client.MAX_REASK_MS], [[2000, 5000, 10000], 30000, 300000]);
  // The answer after a failure is the whole answer: a wallet with nothing is `ready` and empty, and only then.
  assert.deepEqual(await client.readWalletPositions(OWNER, never(), viaEdge(fakeChain()).post), { ok: true, answer: { owner: OWNER, block: 71_700_000, positions: [], deposits: [] } });
  client.forgetWallet();
});

test('the route’s envelope is taken only when every field is exactly what it sends: its answer for the owner asked about, a feature per listed position in order, and checked mint blocks', async () => {
  client.forgetWallet();
  const ENVELOPE = { v: 1, answer: clone(REPLY), automation: { block: REPLY.block, positions: [{ tokenId: '3135288', automation: 'plain' }, { tokenId: '3000000', automation: 'plain' }] }, mints: [{ id: '3135288', block: 70_000_000, tx: `0x${'ab'.repeat(32)}` }], capped: false };
  assert.deepEqual(client.parseOwnedEnvelope(clone(ENVELOPE), OWNER), { answer: REPLY, automation: ENVELOPE.automation, mints: ENVELOPE.mints });
  assert.deepEqual(client.parseOwnedEnvelope({ ...clone(ENVELOPE), automation: null }, OWNER).automation, null, 'no features: the screens ask their own');
  // The features come in the scan's own order (its ids', newest first), not the list's (open first): any order of exactly the listed ids.
  const reordered = clone(ENVELOPE);
  reordered.automation.positions.reverse();
  assert.deepEqual(client.parseOwnedEnvelope(reordered, OWNER).automation, reordered.automation);
  // Mint hints that do not check out (not listed, a malformed id, block or hash) are let go; the list is not.
  const hints = [{ id: '3000000', block: 69_000_000, tx: `0x${'cd'.repeat(32)}` }, { id: '9', block: 1, tx: `0x${'ab'.repeat(32)}` }, { id: '03135288', block: 1, tx: `0x${'ab'.repeat(32)}` }, { id: '3135288', block: 0, tx: `0x${'ab'.repeat(32)}` }, { id: '3135288', block: 1.5, tx: `0x${'ab'.repeat(32)}` }, { id: '3135288', block: 1, tx: '0xab' }, { id: '3135288', block: 1, tx: `0x${'ab'.repeat(32)}`, extra: 1 }];
  assert.deepEqual(client.parseOwnedEnvelope({ ...clone(ENVELOPE), mints: hints }, OWNER).mints, [hints[0]]);
  const broken = [
    (e) => (e.v = 2),
    (e) => delete e.capped,
    (e) => (e.capped = 'no'),
    (e) => (e.extra = 1),
    (e) => (e.answer.owner = '0x3333333333333333333333333333333333333333'),
    (e) => (e.answer.positions[0].status = 'burned'),
    (e) => (e.automation.positions[0].tokenId = '9'),
    (e) => (e.automation.positions[1] = e.automation.positions[0]),
    (e) => e.automation.positions.pop(),
    (e) => e.automation.positions.push({ tokenId: '9', automation: 'plain' }),
    (e) => (e.automation.positions[0].automation = 'compound'),
    (e) => (e.mints = {}),
    (e) => (e.mints = Array.from({ length: 101 }, () => ENVELOPE.mints[0])),
  ];
  for (const [i, change] of broken.entries()) {
    const envelope = clone(ENVELOPE);
    change(envelope);
    assert.equal(client.parseOwnedEnvelope(envelope, OWNER), null, `case ${i}: ${change}`);
    // Through the read: an answer that is not the route's is `invalid_reply`, asked again.
    assert.deepEqual(await client.readWalletPositions(OWNER, never(), answering(reply(envelope)).post), { ok: false, reason: 'invalid_reply' }, `read ${i}`);
  }
  // The scan's bare answer (the route before RPC-SPEC) is not the envelope.
  assert.deepEqual(await client.readWalletPositions(OWNER, never(), answering(reply(clone(REPLY))).post), { ok: false, reason: 'invalid_reply' });
  client.forgetWallet();
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
  // Changed on purpose 2026-10-30 (QA round 2, N2): a price from 1 up has at least two decimals, as V2's Review writes it.
  assert.equal(inside.text, '≈1.00');
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
  // Changed on purpose 2026-10-01 (I6): a day, not a week (lib/browserCopies.ts KEPT_MAX_AGE_MS.owned).
  assert.match(list, /readKept\(copyName\(owner\), KEPT_MAX_AGE_MS\.owned, \(data, at\) => \{\s+const answer = parseWalletAnswer\(data, owner\)\s+return answer\?\.positions\.length \? \{ answer, at \} : null/, 'at most a day old, checked as a chain answer, with a position in it, and dated');
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
 * a document it shows and hides, and node's mock setTimeout. Changed on purpose (RPC-SPEC P1): no `minted` any more;
 * every wallet's list refreshes (until then only one whose minted ids the page's memory held did).
 */
async function loop(t, { every = client.REFRESH_MS, paused, answers = [], prepare = () => undefined } = {}) {
  client.forgetMinted();
  prepare();
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
  const read = async (owner, signal, _post, options = {}) => {
    reads.push({ owner, signal, fresh: options.fresh === true });
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

// Changed on purpose (RPC-SPEC P1, 2026-10-01): from 2026-09-25 the page kept, per wallet and for the visit, the ids
// DominoSetupV1 minted to it and the block it read them at, and (2026-10-01, fees item A24) seeded them from the list's
// own copy, so a later read walked the SetupMinted logs only since then. The route keeps that walk now, per owner, in the
// edge's cache (RPC-SPEC §2.5.1 and D4), so the page keeps no ids: every read is the same POST of the owner, and the read
// after an action asks past the route's answer cache once (`fresh`).
test('the page keeps no minted ids: every read asks the route for the owner alone, and a read after an action asks past its cache once', async (t) => {
  client.forgetWallet();
  assert.equal(client.seedMinted, undefined, 'the list’s copy seeds nothing');
  const chain = fakeChain({ minted: [{ block: 69_300_000, id: 7 }], nfts: { 7: nft() } });
  const edge = viaEdge(chain);
  await client.readWalletPositions(OWNER, never(), edge.post);
  await client.readWalletPositions(OWNER, never(), edge.post, { fresh: true });
  await client.readWalletPositions(OWNER, never(), edge.post, { fresh: false, hold: false, background: true, onRefused: () => assert.fail('no refusal is heard') });
  // The owner alone: how the route finds the ids and keeps the wallet's walk is its own (tests/chain-routes.test.mjs).
  assert.deepEqual(edge.sent.map((one) => JSON.parse(one.init.body)), [{ owner: OWNER }, { owner: OWNER, fresh: true }, { owner: OWNER }]);
  // askWallet's first read is `fresh` when the hook was asked again after an action, and only that one.
  const doc = fakeDocument();
  const before = globalThis.document;
  globalThis.document = doc;
  t.after(() => {
    globalThis.document = before;
    client.forgetWallet();
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const asked = [];
  const read = async (owner, signal, post, options) => (asked.push(options.fresh), { ok: false, reason: 'chain_unavailable' });
  const cancel = client.askWallet(OWNER, { current: null }, () => undefined, null, undefined, read, true, true);
  await settle();
  t.mock.timers.tick(2_000);
  await settle();
  t.mock.timers.tick(5_000);
  await settle();
  cancel();
  assert.deepEqual(asked, [true, false, false]);
  // A first read with no action before it is not fresh.
  asked.length = 0;
  const plain = client.askWallet(OWNER, { current: null }, () => undefined, null, undefined, read);
  await settle();
  plain();
  assert.deepEqual(asked, [false]);
  // The list no longer seeds anything from its copy.
  const list = readFileSync(new URL('../src/components/positions/OwnedPositions.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(list, /seedMinted/);
  assert.match(list, /const \[copy\] = useState\(\(\) => \(readOnly \? null : recall\(owner\)\)\)/);
});

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

test('a hidden tab asks nothing: a refresh due while it is hidden waits and runs once when it is shown again; a paused list is not refreshed, a wallet at the scan’s cap is; the pace is never under 15 s', async (t) => {
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

  // Changed on purpose (RPC-SPEC P1): a wallet the scan stopped at its cap for was never refreshed (each read would have
  // walked its logs from the contract's deployment). The route keeps that walk in its own cache now: it is refreshed too.
  const capped = await loop(t, { answers: [answerAt(100), answerAt(200, { positions: [] })] });
  await capped.pass(30_000);
  assert.deepEqual([capped.reads.length, capped.puts.length], [2, 2]);
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
  // Changed on purpose 2026-10-01 (fees items A8 and A9): each read asked again within the quick waits says it is on its
  // way (a put of its own), and the line says "reading again" only while one is on its way or due within them (10 s at
  // most); once they are spent, the calm line stays through the reads asked every 30 s.
  assert.deepEqual(busy.puts.map((put) => [put.phase, put.reading]), [
    ['retrying', true],
    ['retrying', true], ['retrying', true],
    ['retrying', true], ['retrying', true],
    ['failed', undefined], ['failed', undefined], ['failed', undefined],
  ]);
  assert.deepEqual(busy.puts.map((put) => put.reason), Array(8).fill('chain_busy'));
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
  const s = await loop(t, { every: null, answers: [
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
  // (2026-10-01, fees items A8 and A9: no "reading again" while a rest's deadline over 10 s away is waited out; said again
  // once the read is asked, and over the quick wait after the third.)
  assert.deepEqual(s.puts.map((put) => [put.phase, put.reading]), [['retrying', false], ['retrying', true], ['retrying', false], ['retrying', true], ['retrying', true], ['ready', undefined]]);
  assert.equal(s.shown.current.block, 100);
  s.cancel();
});

test('cancelling a wallet read during an announced cooldown never starts another scan', async (t) => {
  const s = await loop(t, { every: null, answers: [{ ok: false, reason: 'chain_busy', retryAt: Date.now() + 24_000 }, answerAt(100)] });
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
  const s = await loop(t, { every: null, answers: [sharedFailure, answerAt(100)] });
  await s.pass(18_999);
  assert.equal(s.reads.length, 1, 'no scan before the original deadline');
  await s.pass(1);
  assert.equal(s.reads.length, 2, 'the five seconds already elapsed are not waited again');
  assert.equal(s.puts.at(-1).phase, 'ready');
  s.cancel();
});

// RPC-SPEC §3.4 and P1: while the site's chain routes cannot answer (no node secret yet, or the node away: a 503 with a
// wait of a minute or more), the list says so at once with its calm line, over this browser's copy when there is one,
// and asks again when the route's wait is over (at most five minutes), never on the 2/5/10 s ladder. Never "no positions".
test('the source away: the calm line at once, and the next read when the route’s wait is over, at most five minutes; a refresh over an answer waits as long', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const away = () => ({ ok: false, reason: 'chain_unavailable', retryAt: now + 300_000 });
  const s = await loop(t, { every: null, answers: [away, () => ({ ok: false, reason: 'chain_unavailable', retryAt: now + 3_600_000 }), away, answerAt(100)] });
  assert.deepEqual(s.puts.map((put) => put.phase), ['failed'], 'the calm line at once, not the loading rows');
  for (const ms of [2_000, 5_000, 10_000, 30_000]) {
    now += ms;
    await s.pass(ms);
  }
  assert.equal(s.reads.length, 1, 'nothing on the quick ladder, nor every 30 s');
  now += 300_000 - 47_000;
  await s.pass(300_000 - 47_000);
  assert.equal(s.reads.length, 2, 'asked again when the route’s wait is over');
  now += client.MAX_REASK_MS - 1;
  await s.pass(client.MAX_REASK_MS - 1);
  assert.equal(s.reads.length, 2);
  now += 1;
  await s.pass(1);
  assert.equal(s.reads.length, 3, 'a longer wait is bounded to five minutes');
  now += 300_000;
  await s.pass(300_000);
  assert.equal(s.reads.length, 4);
  assert.equal(s.puts.at(-1).phase, 'ready', 'drawn once the route answers');
  assert.ok(s.puts.every((put) => put.phase !== 'ready' || put.answer.positions.length > 0), 'never an empty list before the route answered');
  s.cancel();
  t.mock.timers.reset();
  // With an answer on screen, a refresh that finds the source away keeps it, with no line over it, and waits as long.
  const shown = await loop(t, { answers: [answerAt(100), away, answerAt(200, { deposits: [] })] });
  now += 30_000;
  await shown.pass(30_000);
  assert.deepEqual([shown.reads.length, shown.puts.map((put) => put.phase)], [2, ['ready']]);
  now += 299_999;
  await shown.pass(299_999);
  assert.equal(shown.reads.length, 2, 'not after 60 s: after the route’s own wait');
  now += 1;
  await shown.pass(1);
  assert.equal(shown.reads.length, 3);
  assert.equal(shown.puts.at(-1).answer.block, 200);
  shown.cancel();
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
  // (2026-10-01, fees items A8 and A9: each read asked again within the quick waits also says it is on its way, a put of
  // its own; the calm line then stays through the reads asked every 30 s.)
  assert.deepEqual(failing.puts.map((put) => [put.phase, put.reading]), [['retrying', true], ['retrying', true], ['retrying', true], ['retrying', true], ['retrying', true], ['failed', undefined], ['failed', undefined], ['failed', undefined]]);
  assert.deepEqual(failing.puts.map((put) => put.reason), Array(8).fill('chain_unavailable'));
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
  const first = await withFetch(edgeFetch(chain.deps), () => client.readWalletPositions(OWNER, never()));
  assert.equal(first.result.ok, true);
  assert.deepEqual(first.sent.map((one) => one.url), ['/api/owned/v2/positions'], 'the default client: the route’s fixed path');
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
  await withFetch(edgeFetch(fakeChain(setup).deps), () => client.readWalletPositions(OWNER, never()));
  assert.ok(client.keptPosition('7'));
  // A position Create position made since: not drawn from before it. (Made by another wallet, RPC fix round 2: this
  // wallet's reads are then not held fresh for it in the tests after this one.)
  create.publishCreated('99', '0x00000000000000000000000000000000000000bb');
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

// 2026-09-28 (speed wave B review, item 17): the page's own read of a wallet asks the scan for each position's feature,
// and hands it to the automation view: the badges come with the rows, with no read of their own (the automation's own
// scan: a head and an aggregate3, some 0.6 s later). The scan's half is tests/owned.test.mjs; this is the page's wiring of
// it, which a read that no longer asked for it would leave green. RPC-SPEC: the route's envelope carries them
// (`automation`), from the same scan at the edge.
test('the page’s own read of a wallet carries each position’s feature: its subscriber in the route’s first read, and the automation view ready from it with nothing read', async () => {
  const automation = require('../.test-build/app/src/lib/automationState.js');
  const flags = [globalThis.__DOMINO_DEPLOYABLE__, globalThis.__DOMINO_TEST_HOOKS__];
  // A build that reads the chain: a view with nothing noted would ask the automation's own scan.
  globalThis.__DOMINO_DEPLOYABLE__ = true;
  globalThis.__DOMINO_TEST_HOOKS__ = false;
  client.forgetMinted();
  client.forgetWallet();
  try {
    const chain = fakeChain({ minted: [{ block: 69_300_000, id: 41 }, { block: 69_400_000, id: 42 }], nfts: { 41: nft(), 42: nft({ liquidity: 0n }) } });
    const read = await withFetch(edgeFetch(chain.deps), () => client.readWalletPositions(OWNER, never()));
    assert.equal(read.result.ok, true);
    // The read of the positions (their ownerOf) asks each one's subscriber in the same aggregate3, at the route.
    const subscriber = toFunctionSelector('subscriber(uint256)');
    const ownerOf = toFunctionSelector('ownerOf(uint256)');
    const aggregates = chain.log.filter((call) => call.method === 'eth_call').map((call) => decodeFunctionData({ abi: multicallAbi, data: call.params[0].data }).args[0]);
    for (const id of [41n, 42n]) {
      const mine = (calls) => calls.filter((call) => call.callData.length > 10 && BigInt(`0x${call.callData.slice(10, 74)}`) === id && call.target.toLowerCase() === owned.POSITION_MANAGER).map((call) => call.callData.slice(0, 10));
      const first = aggregates.find((calls) => mine(calls).includes(ownerOf));
      assert.ok(first, `${id}: read`);
      assert.ok(mine(first).includes(subscriber), `${id}: its subscriber in the same read as its owner (${mine(first).join()})`);
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

// RPC fix round 2 (the recheck's findings 5 and 7): the ladder is askWallet's, for every screen and for a list from
// before the owner's own action too, and each wait counts from the answer before it (the screens' timers counted from
// the ask, so a slow scan's answer left the next ask inside the route's 5 s fresh window).
test('a list from before the owner’s action is asked again, fresh, on the ladder, each wait counted from the answer before it; then the usual refresh', async (t) => {
  let release;
  const slow = new Promise((done) => (release = done));
  const { reads, pass, puts, cancel } = await loop(t, {
    // The madeIds of the test after this one are the visit's: this one runs first.
    prepare: () => client.walletChanged(1_000),
    answers: [answerAt(999), async () => (await slow, answerAt(999)), answerAt(1_000)],
  });
  assert.equal(reads.length, 1);
  assert.equal(puts.at(-1).phase, 'ready', 'the answer on hand is drawn meanwhile');
  await pass(5_999);
  assert.equal(reads.length, 1, 'not before 6 s');
  await pass(1);
  assert.deepEqual([reads.length, reads[1].fresh], [2, true]);
  // The second ask's scan takes 8 s: the next wait, 12 s, counts from its answer.
  await pass(8_000);
  release();
  await settle();
  await pass(11_999);
  assert.equal(reads.length, 2, 'not 12 s after the ask, 12 s after its answer');
  await pass(1);
  assert.deepEqual([reads.length, reads[2].fresh], [3, true]);
  // That one is past the action: no ladder step at 24 s, the usual refresh 30 s on, not fresh.
  await pass(24_000);
  assert.equal(reads.length, 3, 'the ladder is over');
  await pass(5_999);
  assert.equal(reads.length, 3);
  await pass(1);
  assert.deepEqual([reads.length, reads[3].fresh], [4, false]);
  cancel();
});

test('the ladder stops after its last step; a reader without the refresh then asks no more', async (t) => {
  const { reads, pass, cancel } = await loop(t, { every: null, prepare: () => client.walletChanged(1_000), answers: [answerAt(999), answerAt(999), answerAt(999), answerAt(999)] });
  for (const ms of client.CREATED_REASK_MS) await pass(ms);
  assert.equal(reads.length, 4, 'the first read and three asks again');
  assert.ok(reads.slice(1).every((read) => read.fresh));
  await pass(120_000);
  assert.equal(reads.length, 4, 'and no more');
  cancel();
});

// 2026-10-02 (review of the RPC switch, findings 8 and 15): the route keeps a wallet's answer at the edge, so the page's
// forgetting its own copies is not enough after the owner's action: the next read, wherever it is asked, asks the route
// fresh, after a Close or a Collect (walletChanged) and after a position Create position made (madeCount). Changed on
// purpose 2026-10-02 (RPC fix round 2): until an answer is past the action (at or past its receipt's block) and lists
// every position this wallet made here; one from a node behind the receipt left the list stale for a minute.
test('the reads after the owner’s action or a position made here ask the route fresh, until an answer past it comes', async () => {
  const create = require('../.test-build/app/src/lib/create/createProgress.js');
  client.forgetMinted();
  const nfts = { 7: nft() };
  const behind = viaEdge(fakeChain({ minted: [{ block: 69_300_000, id: 7 }], nfts }));
  const ahead = viaEdge(fakeChain({ head: 71_700_100, minted: [{ block: 69_300_000, id: 7 }], nfts }));
  const fresh = (edge) => JSON.parse(edge.sent.at(-1).init.body).fresh === true;
  const read = async (edge) => {
    const result = await client.readWalletPositions(OWNER, never(), edge.post);
    assert.equal(result.ok, true);
    return { answer: result.answer, fresh: fresh(edge) };
  };
  assert.deepEqual([(await read(behind)).fresh, (await read(behind)).fresh], [false, false]);
  // A Close or a Collect whose receipt named no block: the next read asks fresh, once.
  client.walletChanged();
  assert.equal(client.wantsFresh(OWNER), true);
  assert.deepEqual([(await read(behind)).fresh, (await read(behind)).fresh], [true, false]);
  // One included at block 71,700,050, past the node's head (71,700,000): its answer is from before the action, so every
  // read asks fresh until one is at or past that block.
  client.walletChanged(71_700_050n);
  const stale = await read(behind);
  assert.deepEqual([stale.fresh, stale.answer.block, client.behindOf(OWNER, stale.answer), client.wantsFresh(OWNER)], [true, 71_700_000, true, true]);
  assert.equal((await read(behind)).fresh, true, 'still fresh');
  const past = await read(ahead);
  assert.deepEqual([past.fresh, past.answer.block, client.behindOf(OWNER, past.answer), client.wantsFresh(OWNER)], [true, 71_700_100, false, false]);
  assert.equal((await read(ahead)).fresh, false, 'settled');
  // A fresh read that fails leaves the next one fresh.
  client.walletChanged();
  const failing = answering(reply({ error: 'chain_unavailable' }, 502, { 'Retry-After': '5' }));
  assert.equal((await client.readWalletPositions(OWNER, never(), failing.post)).ok, false);
  assert.deepEqual(failing.sent, [{ owner: OWNER, fresh: true }]);
  assert.equal((await read(ahead)).fresh, true);
  assert.equal(client.wantsFresh(OWNER), false);
  // A plain forgetting of the page's copies (a test's reset) asks nothing fresh.
  client.forgetWallet();
  assert.equal(client.wantsFresh(OWNER), false);
  // A position this wallet made here: every read fresh while the answer lacks it; one another wallet made is not this
  // list's to wait for (the recheck's finding 7: the ladder ran for any wallet's list).
  const listed = past.answer;
  const lacking = { ...listed, positions: listed.positions.filter((position) => position.tokenId !== '7') };
  create.publishCreated('7', '0x00000000000000000000000000000000000000aa');
  assert.equal(client.behindOf(OWNER, lacking), false, 'made by another wallet');
  assert.deepEqual(create.madeIds(OWNER), []);
  create.publishCreated('4242', OWNER.toUpperCase().replace('0X', '0x'));
  assert.deepEqual(create.madeIds(OWNER), ['4242']);
  assert.equal(client.behindOf(OWNER, listed), true, 'lacks a position it made');
  assert.equal(client.behindOf(OWNER, { ...listed, positions: [...listed.positions, { ...listed.positions[0], tokenId: '4242' }] }), false);
  assert.equal((await read(ahead)).fresh, true);
  assert.equal((await read(ahead)).fresh, true, 'still lacking it: fresh again');
  // The ladder is the read's own now (askWallet), for every screen: none of them runs one of its own.
  for (const file of ['../src/screens/Sequence.tsx', '../src/components/positions/AutomateEntry.tsx', '../src/components/positions/OwnedPositions.tsx']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /useCreatedReask|setAgain/, file);
  }
  assert.match(readFileSync(new URL('../src/screens/PositionDetail.tsx', import.meta.url), 'utf8'), /walletChanged\(included\)/, 'Close and Collect mark the wallet changed, with the receipt’s block');
  assert.match(readFileSync(new URL('../src/components/positions/OwnedPositions.tsx', import.meta.url), 'utf8'), /walletChanged\(included\)/, 'and a held deposit’s refund');
  assert.match(readFileSync(new URL('../src/screens/AdvancedSetup.tsx', import.meta.url), 'utf8'), /walletChanged\(receipt\.blockNumber\)/, 'and Advanced setup’s steps (the recheck’s finding 6)');
  create.publishCreated(null);
  client.forgetMinted();
});
