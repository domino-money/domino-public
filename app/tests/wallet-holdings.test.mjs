// Added 2026-09-25 (owner: the Positions Wallet card lists only the main tokens, largest first, by USD value, "if that
// doesn't cause too much load"): the card's prices (one provider GET per page view at most, memory only) and what it
// shows of a wallet's list (lib/walletPrices.ts, lib/walletHoldings.ts), and the artwork resolver's batch GET and seed.
// Changed on purpose (round 6, 2026-09-27; the owner: convert every token to USD and ALWAYS show the top 3 by value):
// every held token is listed (dust valued, the priceless last), the top 3 are the card, prices are asked for every held
// token at once (30 per GET, the GETs side by side), and the card keeps its last list per address in the browser
// (lib/walletMemory.ts).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { MIN_LIQUIDITY_USD, NATIVE, PRICE_GETS, PRICE_TTL_MS, USDG, WETH, createWalletPrices, quotesFromTokens } = require('../.test-build/app/src/lib/walletPrices.js');
const { PRICED_AT_MOST, PRICED_PER_LOAD, SHOWN_HOLDINGS, WHOLE_LIST, addressesToPrice, isLookAlike, knownHeld, listGap, nextAsk, reconcileWalletRows, symbolReading, totalLeavesOut, totalWithheld, usdValue, walletHoldings, walletSnapshotValid, walletTotalSnapshot } = require('../.test-build/app/src/lib/walletHoldings.js');
const { NO_PRICES, WALLET_MEMORY_ADDRESSES, WALLET_MEMORY_KEY, WALLET_MEMORY_MAX_AGE_MS, WALLET_PRICE_MAX_AGE_MS, bookQuotes, recallWallet, rememberWallet, withAnswer } = require('../.test-build/app/src/lib/walletMemory.js');
const copies = require('../.test-build/app/src/lib/browserCopies.js');
const { PRICE_BATCH, createTokenArtworkResolver } = require('../.test-build/app/src/lib/tokenArtwork.js');

const UFG = '0xefab538cf3c29237a47c6afb145d50ddf204a0a3';
const MANY = '0xa26992c4268a8a78a4d872fe4bdad2ed03ac287d';
const PONS = '0x39dbed3a2bd333467115de45665cc57f813c4571';
const FAKE_PONS = '0x7859f341c798189a1da859947a6eec82d414cdaa';
const FAKE_USDG = '0x3c261bf9087b11bd30861881492ed02e9ad1c7de';
// Changed on purpose 2026-10-04 (the owner's new embedded list): MARLIN, cbBTC and U left the selected pools with their
// pools; beside PONS and USDG the embedded list's tokens are now ORBIO, CASHCAT, UBIK and VIRTUAL.
// Changed on purpose 2026-11-02 (the owner's new embedded list): ORBIO and UBIK left with their pools; beside PONS and
// USDG the embedded list's tokens are now TORCH, CASHCAT, PRIORS and VIRTUAL (and native ETH, which ETH/TORCH names).
const TORCH = '0x000050e18ffa3f8f7ad170eb9cef160eb3ed1111';
const CASHCAT = '0x020bfc650a365f8bb26819deaabf3e21291018b4';
const PRIORS = '0xedbf91223639800bcd5756815caf908df3b890be';
const VIRTUAL = '0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31';
const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const ONE = 10n ** 18n;

test('the updating total is one complete valuation with the original price and balance deadlines', () => {
  const now = 1_800_000_000_000;
  const rows = [row(UFG, 'UFG', '1000'), row(NATIVE, 'ETH', '0.5'), row(USDG, 'USDG', '1', 6)];
  const book = withAnswer(NO_PRICES, { quotes: new Map([[UFG, { usd: '0.003', liquidityUsd: 100_000 }], [WETH, { usd: '2000', liquidityUsd: 1e7 }]]), at: new Map([[UFG, now - 120_000], [WETH, now - 60_000]]) }, now);
  const snapshot = walletTotalSnapshot(rows, book, now, now);
  assert.equal(snapshot.total, 1004n * ONE);
  assert.equal(snapshot.until, now - 120_000 + WALLET_PRICE_MAX_AGE_MS, 'the oldest original price sets the deadline');
  assert.equal(walletTotalSnapshot(rows, book, now + 300_000, now + 300_000).until, snapshot.until, 'a new balance read cannot rejuvenate cached prices');
  assert.equal(walletSnapshotValid(snapshot, [rows[0]], now + 300_000), true, 'a still incomplete page does not alter the saved valuation');
  assert.equal(snapshot.total, 1004n * ONE, 'the snapshot never sums the partial refresh');
  assert.equal(walletSnapshotValid(snapshot, [...rows, row(addr(99), 'NEW', '20')], now + 300_000), false, 'a newly confirmed holding invalidates the earlier total');
  assert.equal(snapshot.holdings.get(rows[0].key).value, 3n * ONE, 'cached rows retain their original complete valuation rather than current price times an old balance');
  assert.equal(walletSnapshotValid(snapshot, [], snapshot.until), false, 'snapshot expires without a successful response');
  assert.equal(walletTotalSnapshot(rows, book, now, snapshot.until), null);
  const stableOnly = walletTotalSnapshot([rows[2]], NO_PRICES, now - WALLET_MEMORY_MAX_AGE_MS + 500, now);
  assert.equal(stableOnly.until, now + 500, 'a fixed-dollar token still expires with its balance');
});

test('a known balance change or zero invalidates an atomic total immediately; old and incomplete valuations cannot start one', () => {
  const now = 1_800_000_000_000;
  const rows = [row(UFG, 'UFG', '1000'), row(USDG, 'USDG', '1', 6)];
  const book = withAnswer(NO_PRICES, { quotes: new Map([[UFG, { usd: '0.003', liquidityUsd: 100_000 }]]), at: new Map() }, now);
  const snapshot = walletTotalSnapshot(rows, book, now, now);
  for (const changed of [row(UFG, 'UFG', '0', 18, 'zero'), row(UFG, 'UFG', '900'), row(UFG, 'UFG', '1100')]) {
    assert.equal(walletSnapshotValid(snapshot, [changed], now + 1), false, 'a changed held balance cannot keep the previous headline');
  }
  assert.equal(walletSnapshotValid(null, rows, now), false, 'cleared receipt evidence cannot resurrect the previous total');
  assert.equal(walletTotalSnapshot([{ ...rows[0], old: true }, rows[1]], book, now, now), null);
  // Changed on purpose 2026-10-14 (incident of 2026-10-13, package D2): a total without UFG's price is shown as the priced
  // tokens' total, saying it leaves one out, so its snapshot is that total and that count. It was no snapshot at all.
  const usdgOnly = walletTotalSnapshot(rows, NO_PRICES, now, now);
  assert.deepEqual([usdgOnly.total, usdgOnly.unpriced], [ONE, 1], 'missing UFG price: the USDG total, with UFG counted as not priced, never as zero');
  const rejected = withAnswer(book, { quotes: new Map([[UFG, { usd: '1', liquidityUsd: 100 }]]), at: new Map() }, now + 1);
  const guarded = walletTotalSnapshot(rows, rejected, now, now + 1);
  assert.deepEqual([guarded.total, guarded.unpriced], [ONE, 1], 'rejected prices preserve their qualification guard: UFG is not valued at them');
  assert.equal(snapshot.unpriced, 0, 'every held token priced: nothing left out');
});

test('partial inventory retains an omitted UFG as last known, never as current USD; confirmed zero removes it', () => {
  const now = 1_800_000_000_000;
  const known = [{ ...row(UFG, 'UFG', '1000000'), pageRetrievedAt: now / 1000 }, { ...row(NATIVE, 'ETH', '1'), pageRetrievedAt: now / 1000 }];
  const fresh = [{ ...row(NATIVE, 'ETH', '0.5'), pageRetrievedAt: now / 1000 + 10 }];
  const merged = reconcileWalletRows(known, fresh, now + 10_000);
  const prices = new Map([[UFG, { usd: '0.003', liquidityUsd: 100_000 }], [WETH, { usd: '2000', liquidityUsd: 1e7 }]]);
  const view = walletHoldings(merged, prices);
  assert.deepEqual(view.all.map((h) => [h.row.token.symbol, h.row.old, h.value]), [['UFG', true, null], ['ETH', false, 1000n * ONE]]);
  assert.equal(totalWithheld({ ...WHOLE_LIST, earlier: true }, view), 'earlier_rows', 'partial live total cannot pass for the whole wallet');
  const spent = reconcileWalletRows(merged, [row(UFG, 'UFG', '0', 18, 'zero')], now + 20_000);
  assert.equal(walletHoldings(spent, prices).all.some((h) => h.row.token.symbol === 'UFG'), false, 'authoritative zero wins immediately');
  assert.equal(reconcileWalletRows(known, [], now + WALLET_MEMORY_MAX_AGE_MS + 1).length, 0, 'unknown balances eventually expire');
  assert.equal(reconcileWalletRows([], fresh, now + WALLET_MEMORY_MAX_AGE_MS + 1, now).length, 0, 'an unchanged snapshot in an open tab expires too');
  assert.equal(totalWithheld({ ...WHOLE_LIST, discoveryMissing: true }, walletHoldings(fresh, prices)), 'inventory_unavailable', 'HTTP 200 without discovery cannot stand for the whole wallet');
});

// Changed on purpose 2026-10-14 (incident of 2026-10-13, package D2): this case is the incident's cause. A token that lost
// its qualified pool (a price of the last day kept as a hint, none now) counted as unanswered, and one unanswered token
// withheld the whole headline, for a day: production said "Wallet value unavailable." for the owner's 63 tokens. Now the
// headline is the priced tokens' total and says how many held tokens it leaves out; UFG keeps its place and has no USD.
test('a lost qualified price keeps UFG in place with no USD; the headline is the priced tokens’ total and says it leaves UFG out; recovery restores both', () => {
  const now = 1_800_000_000_000;
  const rows = [row(UFG, 'UFG', '1000000'), row(NATIVE, 'ETH', '0.5'), row(USDG, 'USDG', '1', 6)];
  const original = withAnswer(NO_PRICES, { quotes: new Map([[UFG, { usd: '0.003', liquidityUsd: 100_000 }], [WETH, { usd: '2000', liquidityUsd: 1e7 }]]), at: new Map() }, now);
  const lost = withAnswer(original, { quotes: new Map([[UFG, null]]), at: new Map() }, now + 300_000);
  const { quotes, hints } = bookQuotes(lost, now + 300_000);
  const shown = walletHoldings(rows, quotes, hints);
  assert.deepEqual(shown.all.map((h) => h.row.token.symbol), ['UFG', 'ETH', 'USDG']);
  assert.equal(shown.all[0].value, null);
  assert.equal(shown.all[0].due, false, 'a settled missing price does not spin forever');
  assert.equal(shown.unanswered, 1, 'still known as a lost price');
  assert.equal(totalWithheld(WHOLE_LIST, shown), null, 'the headline is shown');
  assert.equal(shown.total, 1001n * ONE, 'ETH and USDG; UFG is not counted at all, at any price');
  assert.deepEqual(totalLeavesOut(WHOLE_LIST, shown), { unpriced: 1, cut: false }, 'and the card says one held token is not priced');
  const storage = memoryStorage();
  rememberWallet(OWNER_A, { at: now + 300_000, whole: true, rows }, lost.prices, storage, now + 300_000);
  const recalled = recallWallet(OWNER_A, now + 301_000, storage);
  assert.equal(recalled.book.prices.get(UFG).hint.at, now, 'ranking evidence keeps its original age across navigation');
  assert.equal(recallWallet(addr(99), now + 301_000, storage), null, 'another wallet inherits nothing');
  assert.equal(bookQuotes(lost, now + WALLET_MEMORY_MAX_AGE_MS + 1).hints.get(UFG) ?? null, null, 'a repeated no-price answer cannot renew an old hint');
  assert.equal(bookQuotes(original, now + WALLET_PRICE_MAX_AGE_MS + 1).quotes.size, 0, 'an open tab also ages prices without a new answer');
  const recovered = withAnswer(lost, { quotes: new Map([[UFG, { usd: '0.002', liquidityUsd: 100_000 }]]), at: new Map() }, now + 310_000);
  const again = bookQuotes(recovered);
  const current = walletHoldings(rows, again.quotes, again.hints);
  assert.equal(totalWithheld(WHOLE_LIST, current), null);
  assert.deepEqual(totalLeavesOut(WHOLE_LIST, current), { unpriced: 0, cut: false });
  assert.equal(current.all[0].value, 2000n * ONE);
  const rejected = walletHoldings(rows, new Map([[UFG, { usd: '0.003', liquidityUsd: 100 }], [WETH, { usd: '2000', liquidityUsd: 1e7 }]]), hints);
  assert.equal(rejected.all[0].value, null, 'a quote rejected by the liquidity guard is not an available value either');
  assert.equal(totalWithheld(WHOLE_LIST, rejected), null);
  assert.equal(totalLeavesOut(WHOLE_LIST, rejected).unpriced, 1);
  const rejectedBook = withAnswer(original, { quotes: new Map([[UFG, { usd: '0.003', liquidityUsd: 100 }]]), at: new Map() }, now + 300_000);
  const rejectedPrices = bookQuotes(rejectedBook);
  const rejectedView = walletHoldings(rows, rejectedPrices.quotes, rejectedPrices.hints);
  assert.equal(rejectedView.all[0].row.token.symbol, 'UFG', 'a rejected replacement price also retains ordering');
  assert.equal(totalWithheld(WHOLE_LIST, rejectedView), null);
  assert.equal(totalLeavesOut(WHOLE_LIST, rejectedView).unpriced, 1);
});

test('writing a partial list cannot rejuvenate an omitted balance or silently mark it current', () => {
  const now = 1_800_000_000_000;
  const earlier = { ...row(UFG, 'UFG', '1000000'), pageRetrievedAt: now / 1000, old: true };
  const storage = memoryStorage();
  const later = now + 12 * 3_600_000;
  rememberWallet(OWNER_A, { at: later, whole: false, rows: [earlier] }, new Map(), storage, later);
  const recalled = recallWallet(OWNER_A, later, storage);
  assert.equal(recalled.rows[0].old, true);
  assert.equal(recalled.rows[0].pageRetrievedAt * 1000, now);
  rememberWallet(OWNER_A, { ...recalled, at: now + WALLET_MEMORY_MAX_AGE_MS }, new Map(), storage, now + WALLET_MEMORY_MAX_AGE_MS);
  assert.equal(recallWallet(OWNER_A, now + WALLET_MEMORY_MAX_AGE_MS + 1, storage).rows.length, 0);
});

/** A provider pair: `base` priced at `usd`, with `liquidity` USD. */
const pair = (base, usd, liquidity, extra = {}) => ({ chainId: 'robinhood', baseToken: { address: base, symbol: 'X' }, quoteToken: { address: USDG }, priceUsd: usd, liquidity: { usd: liquidity }, ...extra });

/** A wallet row as the pager makes it (lib/read/pagers.ts): a read balance in whole units unless `state` says otherwise. */
function row(address, symbol, amount, decimals = 18, state = 'value') {
  const [whole, fraction = ''] = String(amount).split('.');
  const raw = state === 'zero' ? '0' : (BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0')).toString();
  return {
    key: `4663:${address}`,
    token: { origin: 'read', chainId: 4663, address, symbol, decimals, readStatus: 'available', artwork: null },
    amount: { label: 'Balance', text: String(amount), state },
    raw, page: 1, pageRetrievedAt: 0, old: false, via: 'page', block: 1,
  };
}

test('a quote is the most liquid pair on Robinhood naming the token, with a plain positive price and at least $10,000 of liquidity', () => {
  const body = [
    pair(UFG, '0.002975', 165_672.94),
    pair(UFG, '0.0031', 20_000),
    pair(UFG.toUpperCase().replace('0X', '0x'), '9', 9_999.99), // too thin to count, whatever its price
    { ...pair(MANY, '0.0022', 50_000), chainId: 'ethereum' }, // another chain
    { chainId: 'robinhood', baseToken: { address: USDG }, quoteToken: { address: MANY }, priceUsd: '1', liquidity: { usd: 1e6 } }, // MANY as the quote
    pair(PONS, '1e-7', 1e6), // not a plain decimal
    pair(PONS, '-1', 1e6),
    pair(FAKE_PONS, '12', 12.2),
  ];
  const quotes = quotesFromTokens(body, [UFG, MANY, PONS, FAKE_PONS, addr(1)]);
  assert.deepEqual(quotes.get(UFG), { usd: '0.002975', liquidityUsd: 165_672.94 });
  assert.equal(quotes.get(MANY), null, 'an other-chain pair, and a quote-side pair with no priceNative, price nothing');
  assert.equal(quotes.get(PONS), null, 'an exponent or a negative price is none');
  assert.equal(quotes.get(FAKE_PONS), null, 'a pool with $12 in it quotes whatever its creator likes');
  assert.equal(quotes.get(addr(1)), null);
  assert.equal(MIN_LIQUIDITY_USD, 10_000);
  for (const junk of [null, {}, 'x', [null, 1, 'x'], Array(301).fill(pair(UFG, '1', 1e6))]) assert.equal(quotesFromTokens(junk, [UFG]).get(UFG), null);
});

test('a token that is mostly a QUOTE is priced from its most liquid pair: priceUsd / priceNative, the dollar price the provider derived the base’s from', () => {
  const STABLE = addr(30);
  const quote = (base, priceUsd, priceNative, usd, chainId = 'robinhood') => ({ chainId, baseToken: { address: base }, quoteToken: { address: STABLE }, priceUsd, priceNative, liquidity: { usd } });
  const quotes = quotesFromTokens([
    quote(UFG, '0.003', '0.003', 250_000), // UFG at $0.003 and 0.003 STABLE: STABLE is $1
    quote(MANY, '3000', '2', 40_000), // thinner: $1,500 would lose to the deeper pair
    pair(STABLE, '0.97', 20_000), // its own base pair, thinner still
    quote(addr(31), '5', '0', 1e9), // a zero priceNative divides nothing
    quote(addr(32), '5', '1e-3', 1e9), // an exponent is no plain decimal
  ], [STABLE, addr(31)]);
  assert.deepEqual(quotes.get(STABLE), { usd: '1', liquidityUsd: 250_000 }, 'the deepest pair wins, whichever side the token is on');
  assert.deepEqual(quotesFromTokens([quote(MANY, '3000', '2', 40_000), pair(STABLE, '0.97', 20_000)], [STABLE]).get(STABLE), { usd: '1500', liquidityUsd: 40_000 });
  assert.deepEqual(quotesFromTokens([quote(MANY, '1', '3', 40_000)], [STABLE]).get(STABLE), { usd: '0.333333333333333333', liquidityUsd: 40_000 }, 'rounded down to 18 digits');
  assert.equal(quotesFromTokens([quote(MANY, '3000', '2', 9_000)], [STABLE]).get(STABLE), null, 'too thin, on either side');
  assert.equal(quotesFromTokens([quote(MANY, '3000', '2', 1e6, 'ethereum')], [STABLE]).get(STABLE), null, 'another chain');
  assert.equal(quotesFromTokens([quote(MANY, '3000', '0', 1e6), quote(MANY, '3000', '1e-3', 1e6)], [STABLE]).get(STABLE), null);
});

test('prices: USDG is $1 unasked, native ETH is WETH, one GET per set, joined while on the wire, kept for the visit, a failure not kept', async () => {
  const asked = [];
  const seeded = [];
  let now = 0;
  let answer = () => [pair(WETH, '2692.60', 19_361_293), pair(UFG, '0.002975', 165_672, { info: { imageUrl: 'https://cdn.dexscreener.com/cms/images/abcdefghijklmnop?width=800' } })];
  const prices = createWalletPrices({ get: async (list) => (asked.push([...list]), answer()), seed: (a, image) => seeded.push([a, image]), now: () => now });

  const [first, joined] = await Promise.all([prices.price([USDG, NATIVE, UFG]), prices.price([UFG, NATIVE, USDG])]);
  assert.deepEqual(asked, [[WETH, UFG]], 'one GET, for WETH (native ETH) and UFG; USDG is never asked for; a second view of the same set joins it');
  assert.equal(first.failed, false);
  assert.deepEqual(first.quotes.get(USDG), { usd: '1', liquidityUsd: null });
  assert.equal(first.quotes.get(NATIVE).usd, '2692.60');
  assert.equal(first.quotes.get(UFG).usd, '0.002975');
  assert.deepEqual(joined.quotes, first.quotes);
  // Review of round 6 (2026-09-28): each quote comes with the time it was answered, which the card keeps in the browser.
  assert.deepEqual([...first.at], [[USDG, 0], [NATIVE, 0], [UFG, 0]]);
  assert.deepEqual(seeded, [[WETH, null], [UFG, 'https://cdn.dexscreener.com/cms/images/abcdefghijklmnop?width=64&height=64&quality=85&format=auto']], 'the reply’s artwork goes to the resolver: none for WETH, the one image for UFG');

  now = PRICE_TTL_MS - 1;
  const reused = await prices.price([UFG, NATIVE]);
  assert.equal(asked.length, 1, 'kept in memory for the visit: no second GET');
  assert.deepEqual([...reused.at], [[UFG, 0], [NATIVE, 0]], 'an answer reused from memory keeps the time it was answered');

  now = PRICE_TTL_MS + 1;
  answer = () => null;
  const failed = await prices.price([UFG, MANY]);
  assert.equal(failed.failed, true);
  assert.equal(failed.quotes.size, 0, 'nothing stale is served after the memory lapses');
  answer = () => [pair(MANY, '0.0022', 50_000)];
  // Changed on purpose 2026-10-14 (incident of 2026-10-13, package D2): a failed GET is not kept, and its tokens are not
  // sent again before PRICE_TTL_MS: every later ask of the same load (each page of the list, the list settling, a
  // remount) sent the same batch again.
  const soon = await prices.price([UFG, MANY]);
  assert.equal(asked.length, 2, 'a failed GET is not sent again by the next view of the same load');
  assert.equal(soon.quotes.size, 0, 'and its tokens have no price yet');
  now += PRICE_TTL_MS;
  const again = await prices.price([UFG, MANY]);
  assert.equal(asked.length, 3, 'a failed GET is not kept: the next view after PRICE_TTL_MS asks again');
  assert.equal(again.quotes.get(MANY).usd, '0.0022');
  assert.equal(again.quotes.get(UFG), null, 'answered, with no qualified pair');
  // Round 6: a token no pair of the reply names is one the provider does not know: none, so its row asks no GET of its own.
  assert.deepEqual(seeded.slice(-2), [[UFG, null], [MANY, null]]);

  const onlyUsdg = await prices.price([USDG]);
  assert.equal(asked.length, 3, 'USDG alone asks nothing');
  assert.equal(onlyUsdg.quotes.get(USDG).usd, '1');

  // Changed on purpose (round 6): 45 addresses were one GET of the first 30, and the other 15 were never priced (the
  // owner's UFG among them). Now every address is asked, 30 per GET, the GETs side by side.
  const many = Array.from({ length: 45 }, (_, i) => addr(i + 100));
  const before = asked.length;
  let inFlight = 0;
  let most = 0;
  const wide = createWalletPrices({
    get: async (list) => {
      asked.push([...list]);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((done) => setTimeout(done, 5));
      inFlight -= 1;
      return list.map((a) => pair(a, '1', 1e6));
    },
    seed: () => {},
    now: () => now,
  });
  const all = await wide.price(many);
  assert.deepEqual(asked.slice(before), [many.slice(0, PRICE_BATCH), many.slice(PRICE_BATCH)], 'two GETs: 30 addresses, then 15');
  assert.equal(most, 2, 'side by side, not one after the other');
  assert.equal(all.quotes.size, 45, 'every address answered');
  const huge = Array.from({ length: PRICE_BATCH * PRICE_GETS + 7 }, (_, i) => addr(i + 1000));
  const count = asked.length;
  await wide.price(huge);
  assert.equal(asked.length - count, PRICE_GETS, `at most ${PRICE_GETS} GETs for one ask`);
  let halfAsked = 0;
  const halfFailed = createWalletPrices({ get: async (list) => (halfAsked++, list.includes(many[0]) ? null : list.map((a) => pair(a, '1', 1e6))), seed: () => {}, now: () => 0 });
  const partial = await halfFailed.price(many);
  assert.equal(partial.failed, false, 'one GET answered: not a failure');
  assert.equal(partial.quotes.size, 15, 'the failed GET’s 30 stay unanswered');
  // Changed on purpose 2026-10-14 (D2): not asked again in the same load (it was "to be asked again" by the next ask).
  assert.equal((await halfFailed.price(many)).quotes.size, 15);
  assert.equal(halfAsked, 2, 'the failed batch is not sent again before PRICE_TTL_MS');
});

// Round 6 (2026-09-27): the card asks again as each page names new tokens, and a page can land before the prices of the
// page before it. An address already on the wire is waited for, never asked twice; only the new ones go out.
test('prices: an ask naming addresses already on the wire waits for their GET and sends only the new ones', async () => {
  const asked = [];
  const pending = [];
  const prices = createWalletPrices({
    get: (list) => new Promise((done) => {
      asked.push([...list]);
      pending.push(() => done(list.map((a) => pair(a, '2', 1e6))));
    }),
    seed: () => {},
    now: () => 0,
  });
  const first = prices.price([UFG, MANY]);
  const second = prices.price([MANY, UFG, PONS]);
  const third = prices.price([UFG]);
  assert.deepEqual(asked, [[UFG, MANY], [PONS]], 'UFG and MANY once; the second ask sends PONS alone; the third sends nothing');
  for (const answer of pending) answer();
  const [a, b, c] = await Promise.all([first, second, third]);
  assert.deepEqual([...a.quotes.keys()], [UFG, MANY]);
  assert.deepEqual([...b.quotes.keys()], [MANY, UFG, PONS], 'the second ask answered for all three');
  assert.equal(c.quotes.get(UFG).usd, '2');
  assert.ok(!a.failed && !b.failed && !c.failed);
  await prices.price([UFG, MANY, PONS]);
  assert.equal(asked.length, 2, 'answered: kept, nothing asked again');
});

test('prices publish each completed batch without waiting for the slow batch or fabricating its prices', async () => {
  const pending = [];
  const seen = [];
  const addresses = Array.from({ length: 45 }, (_, n) => addr(n + 3000));
  const prices = createWalletPrices({
    get: (list) => new Promise((resolve) => pending.push({ list, resolve })),
    seed: () => {}, now: () => 1000,
  });
  let finished = false;
  const result = prices.price(addresses, { onProgress: (answer) => seen.push(answer) }).then((answer) => { finished = true; return answer; });
  assert.equal(pending.length, 2);
  pending[1].resolve(pending[1].list.map((a) => pair(a, '2', 1e6)));
  await new Promise(setImmediate);
  assert.equal(finished, false);
  assert.equal(seen.at(-1).quotes.size, 15);
  assert.equal(seen.at(-1).quotes.has(addresses[0]), false, 'unanswered is not zero');
  pending[0].resolve(pending[0].list.map((a) => pair(a, '1', 1e6)));
  assert.equal((await result).quotes.size, 45);
  assert.equal(pending.length, 2, 'progress adds no provider calls');
});

test('a partial provider answer prices successful tokens without turning unread tokens into authoritative no-price', async () => {
  const asked = [], seeded = [];
  let now = 1000;
  const prices = createWalletPrices({
    get: async list => {
      asked.push(list);
      return asked.length === 1 ? { pairs: [pair(UFG, '0.003', 100000)], unavailable: [MANY] } : [];
    },
    seed: (address, mark) => seeded.push([address, mark]), now: () => now,
  });
  const first = await prices.price([UFG, MANY]);
  assert.equal(first.quotes.get(UFG).usd, '0.003');
  assert.equal(first.quotes.has(MANY), false, 'a failed token read remains unanswered');
  assert.equal(seeded.some(([address]) => address === MANY), false, 'failure cannot poison the artwork cache either');
  // Changed on purpose 2026-10-14 (incident of 2026-10-13, package D2): the unread token is retried by an ask after
  // PRICE_TTL_MS, not by the next ask of the same load (each page of the list asked it again).
  assert.equal((await prices.price([UFG, MANY])).quotes.has(MANY), false);
  assert.deepEqual(asked, [[UFG, MANY]], 'not retried within the load');
  now += PRICE_TTL_MS - 1;
  assert.equal((await prices.price([UFG, MANY])).quotes.get(UFG).usd, '0.003', 'the answered one is still kept');
  assert.deepEqual(asked, [[UFG, MANY]], 'and the unread one is not retried yet');
  now += 1;
  const second = await prices.price([UFG, MANY]);
  assert.deepEqual(asked, [[UFG, MANY], [UFG, MANY]], 'after PRICE_TTL_MS the unread token is retried, with the answer that lapsed');
  assert.equal(second.quotes.get(MANY), null, 'an answered empty response is authoritative no qualified pair');
});

// Added 2026-10-14 (incident of 2026-10-13, package D1): our edge now answers per token, each with the time it retrieved
// that token's pairs, and keeps an answer up to a day. A price is dated by that retrieval, never by when it reached the
// page (it was `now`, right while the edge kept nothing past five minutes), so the card's own rule (a price counts for an
// hour, lib/walletMemory.ts) reads its true age; and each token is priced from its own pairs alone, so an older answer
// about another token never passes for this one's.
test('prices from our edge’s per-token answer: each priced from its own pairs and dated by its own retrieval; a token with no answer stays unanswered', async () => {
  let now = 10_000_000;
  const asked = [], seeded = [];
  const mark = 'https://cdn.dexscreener.com/cms/images/abcdefghijklmnop?width=800';
  // An answer about UFG just over an hour old lists a UFG / WETH pool far deeper than any pair of WETH's own answer.
  const deep = { chainId: 'robinhood', baseToken: { address: UFG }, quoteToken: { address: WETH }, priceUsd: '0.003', priceNative: '0.000003', liquidity: { usd: 9e9 }, info: { imageUrl: mark } };
  const prices = createWalletPrices({
    get: async (list) => {
      asked.push([...list]);
      return {
        tokens: {
          [UFG]: { pairs: [deep], retrievedAt: now - 3_600_001 },
          [WETH]: { pairs: [pair(WETH, '2692.60', 19_361_293)], retrievedAt: now - 240_000 },
          [MANY]: { pairs: [], retrievedAt: now + 60_000 },
        },
        unavailable: list.filter((address) => ![UFG, WETH, MANY].includes(address)),
      };
    },
    seed: (address, image) => seeded.push([address, image]), now: () => now,
  });
  const first = await prices.price([UFG, NATIVE, MANY, PONS]);
  assert.deepEqual(asked, [[UFG, WETH, MANY, PONS]]);
  assert.equal(first.failed, false);
  assert.deepEqual(first.quotes.get(UFG), { usd: '0.003', liquidityUsd: 9e9 });
  assert.equal(first.at.get(UFG), now - 3_600_001, 'dated by when our edge retrieved it: over an hour ago');
  assert.deepEqual(first.quotes.get(NATIVE), { usd: '2692.60', liquidityUsd: 19_361_293 }, 'WETH from its own pairs, never from the older answer about UFG that names it');
  assert.equal(first.at.get(NATIVE), now - 240_000);
  assert.equal(first.quotes.get(MANY), null, 'the provider lists no pair for it: no qualified price');
  assert.equal(first.at.get(MANY), now, 'a time ahead of the page’s clock is now, never later');
  assert.equal(first.quotes.has(PONS), false, 'no answer for it: no price yet, never "no qualified price"');
  assert.deepEqual(seeded, [[UFG, 'https://cdn.dexscreener.com/cms/images/abcdefghijklmnop?width=64&height=64&quality=85&format=auto'], [WETH, null], [MANY, null]], 'artwork from each token’s own pairs; none for a token no pair names; nothing for the unanswered one');
  // The card's own age rule reads those times: the price over an hour old no longer counts, the four-minute-old one does.
  const book = bookQuotes(withAnswer(NO_PRICES, first, now), now);
  assert.equal(book.quotes.has(UFG), false);
  assert.deepEqual(book.hints.get(UFG), { usd: '0.003', liquidityUsd: 9e9 }, 'it only keeps its row in place');
  assert.equal(book.quotes.get(NATIVE).usd, '2692.60');
  // Kept for the visit from when the page read it, with the time it was retrieved. Changed on purpose 2026-10-14 (D2): the
  // unanswered one is not asked again before PRICE_TTL_MS from when it was sent (it was, by the next ask).
  now += PRICE_TTL_MS - 1;
  const reused = await prices.price([UFG, NATIVE, PONS]);
  assert.deepEqual(asked.slice(1), [], 'nothing is asked again within PRICE_TTL_MS, the token with no answer included');
  assert.equal(reused.quotes.has(PONS), false, 'it has no price yet');
  assert.equal(reused.at.get(UFG), 10_000_000 - 3_600_001, 'an answer reused from memory keeps its retrieval time');
  now += 1;
  await prices.price([UFG]);
  assert.deepEqual(asked.at(-1), [UFG], 'and five minutes after the page read it, it is asked again');
});

// Changed on purpose 2026-10-14 (incident of 2026-10-13, package D2): a GET was aborted when its last consumer left (the
// card left with the page, or mounted again), its answer thrown away, and the next mount sent the same batch again: in
// the browser case of tests/v2in-browser/wallet-scale.browser.test.mjs, leaving Positions twice while the prices were on
// their way sent 18 price GETs, 11 of them a batch already sent. Now a GET once sent runs to its end, whoever still
// waits, and its answer serves the next ask; a consumer that left hears nothing.
test('D2: a GET runs to its end when every consumer leaves; its answer serves the next ask, which sends nothing; no one who left is told', async () => {
  const pending = [];
  const prices = createWalletPrices({
    get: (list, signal) => new Promise((resolve) => pending.push({ list, signal, resolve })),
    seed: () => {}, now: () => 1000,
  });
  const a = new AbortController();
  const b = new AbortController();
  const progress = [];
  const first = prices.price([UFG], { signal: a.signal, onProgress: (answer) => progress.push(answer.quotes.size) });
  const second = prices.price([UFG], { signal: b.signal });
  assert.equal(pending.length, 1);
  a.abort();
  b.abort();
  assert.equal((await first).quotes.size, 0, 'a consumer that left gets what was known when it left');
  await second;
  await new Promise(setImmediate);
  assert.equal(pending[0].signal?.aborted ?? false, false, 'never cancelled because its consumers left');
  const third = prices.price([UFG]);
  assert.equal(pending.length, 1, 'the GET on its way is joined, never sent again');
  pending[0].resolve([pair(UFG, '2', 1e6)]);
  assert.equal((await third).quotes.get(UFG).usd, '2');
  assert.deepEqual(progress, [0], 'no notification after leaving');
  assert.equal((await prices.price([UFG])).quotes.get(UFG).usd, '2', 'kept for the visit');
  assert.equal(pending.length, 1, 'one GET in all');
});

test('provider price transport receives cancellation and does not fetch for an already cancelled consumer', async () => {
  let received;
  let count = 0;
  const resolver = createTokenArtworkResolver({ fetch: async (_url, init) => {
    count++;
    received = init.signal;
    return new Promise((resolve) => init.signal.addEventListener('abort', () => resolve(new Response(null, { status: 503 })), { once: true }));
  } });
  const controller = new AbortController();
  const pending = resolver.tokenPrices([UFG], controller.signal);
  controller.abort();
  assert.equal(received.aborted, true);
  assert.equal(await pending, null);
  assert.equal(await resolver.tokenPrices([UFG], controller.signal), null);
  assert.equal(count, 1);
});

test('values: raw × price in exact 10^-18 dollars, rounded down', () => {
  // 1,161,237.362251642889718091 UFG at $0.002975 = $3,454.681152698637596911 (the last digits dropped, never rounded up).
  assert.equal(usdValue('1161237362251642889718091', 18, { usd: '0.002975', liquidityUsd: 1 }), 3454681152698637596911n);
  assert.equal(usdValue('5626125', 6, { usd: '1', liquidityUsd: null }), 5626125000000000000n);
  assert.equal(usdValue('1', null, { usd: '1', liquidityUsd: null }), null);
  assert.equal(usdValue('12.5', 6, { usd: '1', liquidityUsd: null }), null);
});

// Changed on purpose (round 6, 2026-09-27; the owner: convert every token to USD and ALWAYS show the top 3): the card
// showed the five largest holdings worth $1 or more and left out dust and every token without a price. Now every held
// token is listed: the priced ones by value, dust included, then the ones with no price; the card shows the first 3.
test('the card: every held token, the priced ones by USD value (dust included), then the ones with no price; the top 3 first', () => {
  const quotes = new Map([
    [WETH, { usd: '2692.60', liquidityUsd: 19_361_293 }],
    [UFG, { usd: '0.002975', liquidityUsd: 165_672 }],
    [MANY, { usd: '0.0022', liquidityUsd: 50_000 }],
    [addr(1), { usd: '0.5', liquidityUsd: 1e6 }],
    [addr(2), { usd: '3', liquidityUsd: 1e6 }],
    [addr(3), { usd: '0.001', liquidityUsd: 1e6 }], // dust
    [addr(4), { usd: '10', liquidityUsd: 12_000 }], // worth more than its pair: no price
    [addr(5), { usd: '2', liquidityUsd: 1e6 }],
    [addr(6), null], // answered: no qualified price
    [FAKE_PONS, { usd: '5', liquidityUsd: 1e6 }], // a look-alike, priced or not
    [FAKE_USDG, { usd: '1', liquidityUsd: 1e6 }],
  ]);
  const raw = { ...row(addr(8), 'RAW', '5'), raw: '5', amount: { label: 'Balance', text: '5 (raw units, decimals unknown)', state: 'raw' } };
  raw.token = { ...raw.token, decimals: null };
  const rows = [
    row(NATIVE, 'ETH', '0.0137833'),
    row(USDG, 'USDG', '5.62612', 6),
    row(UFG, 'UFG', '1161237.362251642889718091'),
    row(MANY, 'MANY', '348403.655320152301371392'),
    row(addr(1), 'ONE', '4'),
    row(addr(2), 'TWO', '1'),
    row(addr(3), 'DUST', '999'),
    row(addr(4), 'BIG', '2000'),
    row(addr(5), 'TWO', '0.6'),
    row(addr(6), 'NOPRICE', '1000000'),
    row(addr(7), 'ZERO', '0', 18, 'zero'),
    row(FAKE_PONS, 'P0NS', '2847.09'),
    row(FAKE_USDG, 'USDG', '50'),
    raw,
    { ...row(addr(9), 'GONE', '1'), amount: { label: 'Balance', text: 'Unavailable', state: 'unavailable' } },
  ];
  const view = walletHoldings(rows, new Map([...quotes, [addr(8), null]]));
  const symbols = (list) => list.map((h) => h.row.token.symbol);
  assert.equal(SHOWN_HOLDINGS, 3, 'the owner’s rule: the top 3');
  assert.deepEqual(symbols(view.all), ['UFG', 'MANY', 'ETH', 'USDG', 'TWO', 'ONE', 'TWO', 'DUST', 'BIG', 'NOPRICE', 'RAW'], 'by value, dust too; then the priceless, by symbol');
  assert.deepEqual(symbols(view.all.slice(0, SHOWN_HOLDINGS)), ['UFG', 'MANY', 'ETH']);
  assert.deepEqual(view.all.map((h) => h.value === null), [false, false, false, false, false, false, false, false, true, true, true]);
  assert.equal(view.valued, 8);
  assert.equal(view.all.find((h) => h.row.token.symbol === 'DUST').value, 999n * 10n ** 15n, '$0.999 of dust is valued');
  assert.equal(view.all.find((h) => h.row.token.symbol === 'BIG').quote, null, 'a price worth more than its whole pair is no price');
  assert.deepEqual(view.all.filter((h) => h.twin).map((h) => h.row.token.address), [addr(2), addr(5)], 'two contracts both called TWO are named by their addresses');
  assert.equal(view.total, view.all.reduce((sum, h) => sum + (h.value ?? 0n), 0n));
  assert.ok(view.total > 4000n * ONE && view.total < 5000n * ONE, `total ${view.total}`);
  assert.equal(view.all.find((h) => h.row.token.symbol === 'USDG').row.token.address, USDG, 'only the real USDG');
  assert.ok(!view.all.some((h) => [addr(7), addr(9), FAKE_PONS, FAKE_USDG].includes(h.row.token.address)), 'no zero, no unreadable balance, no look-alike');
  assert.equal(view.unanswered, 0, 'every held token answered, NOPRICE and RAW as unpriced; USDG and a look-alike need no answer');
  assert.equal(walletHoldings(rows, new Map([...quotes].filter(([a]) => a !== addr(6)))).unanswered, 2, 'NOPRICE and RAW never answered');
  assert.equal(walletHoldings([row(NATIVE, 'ETH', '1')], new Map()).unanswered, 1, 'native ETH waits for WETH’s answer');
});

// The owner's wallet on 2026-09-27 (read on chain; DEX Screener's prices that day). The card showed MANY, ETH and SI
// with no total: UFG, his largest holding, was never priced.
test('the owner’s wallet: UFG, MANY and ETH are the top 3, the total counts them all, and nothing is left unanswered', () => {
  const quotes = new Map([
    [WETH, { usd: '2673.70', liquidityUsd: 19_778_723 }],
    [UFG, { usd: '0.002937', liquidityUsd: 164_486 }],
    [MANY, { usd: '0.002452', liquidityUsd: 153_288 }],
    [addr(40), { usd: '0.0002172', liquidityUsd: 48_351 }],
    [addr(41), null],
  ]);
  const rows = [row(NATIVE, 'ETH', '0.003563853376846558'), row(addr(40), 'SI', '8000'), row(MANY, 'MANY', '1045460.368944161998202346'), row(UFG, 'UFG', '903723.358045985292042938'), row(addr(41), 'SCORE', '665444.03'), row(FAKE_USDG, 'USDG', '50')];
  const view = walletHoldings(rows, quotes);
  assert.deepEqual(view.all.slice(0, SHOWN_HOLDINGS).map((h) => h.row.token.symbol), ['UFG', 'MANY', 'ETH']);
  assert.deepEqual(view.all.slice(SHOWN_HOLDINGS).map((h) => h.row.token.symbol), ['SI', 'SCORE'], 'the rest behind Show all, SCORE (a $2 pool) last with no price');
  assert.equal(totalWithheld(WHOLE_LIST, view), null, 'the total is shown');
  assert.ok(view.total > 5228n * ONE && view.total < 5230n * ONE, `total ${view.total}`); // $2,654.24 + $2,563.47 + $9.53 + $1.74
});

// Changed on purpose (round 6): with no prices at all the card showed native ETH, WETH and USDG only. Now it lists
// every held token; USDG is still valued ($1 needs no provider), and the rest follow with no price, in a fixed order.
// Changed on purpose 2026-10-14 (incident of 2026-10-13, package D2): the total is then USDG's, and says it leaves five
// held tokens out; it was no total ("no total claims to be the wallet's value"), which a provider away kept for good.
test('without any price: USDG is still $1, and every other held token follows with no price, the main tokens first', () => {
  const rows = [row(UFG, 'UFG', '1000'), row(addr(1), 'AAA', '5'), row(USDG, 'USDG', '5', 6), row(FAKE_USDG, 'USDG', '50'), row(WETH, 'WETH', '0.5'), row(NATIVE, 'ETH', '0.01'), row(PONS, 'PONS', '3'), row(MANY, 'MANY', '0', 18, 'zero')];
  const view = walletHoldings(rows, new Map());
  assert.deepEqual(view.all.map((h) => [h.row.token.symbol, h.value]), [['USDG', 5n * ONE], ['ETH', null], ['WETH', null], ['PONS', null], ['AAA', null], ['UFG', null]]);
  assert.equal(view.unanswered, 5, 'nothing but USDG answered');
  assert.equal(totalWithheld(WHOLE_LIST, view), null, 'the priced tokens’ total is shown');
  assert.equal(view.total, 5n * ONE, 'USDG alone; no token without a price counted as anything');
  assert.deepEqual(totalLeavesOut(WHOLE_LIST, view), { unpriced: 5, cut: false }, 'and it says five held tokens are not priced');
});

// Review of round 6 (2026-09-28): prices too old to count (hints) give no value and no total, but place the rows by the
// value they last gave, so a wallet whose prices are missing keeps its last known order.
test('hints: a price too old to count places its row by its last value, gives no value, and leaves the price due', () => {
  const rows = [row(addr(1), 'AAA', '5'), row(UFG, 'UFG', '1000000'), row(USDG, 'USDG', '5', 6), row(NATIVE, 'ETH', '0.01'), row(MANY, 'MANY', '10')];
  const hints = new Map([[UFG, { usd: '0.003', liquidityUsd: 165_000 }], [WETH, { usd: '2000', liquidityUsd: 1e7 }], [addr(1), null]]);
  const view = walletHoldings(rows, new Map([[MANY, { usd: '1', liquidityUsd: 1e6 }]]), hints);
  assert.deepEqual(view.all.map((h) => [h.row.token.symbol, h.value, h.rank, h.due]), [
    ['UFG', null, 3000n * ONE, true],
    ['ETH', null, 20n * ONE, true],
    ['MANY', 10n * ONE, 10n * ONE, false],
    ['USDG', 5n * ONE, 5n * ONE, false],
    ['AAA', null, null, true],
  ], 'by value or last value; a token that had no price keeps none');
  assert.equal(view.total, 15n * ONE, 'the total counts fresh prices only');
  assert.equal(view.unanswered, 3);
  const withoutPrice = walletHoldings(rows, new Map([[UFG, null]]), hints).all.find((h) => h.row.token.symbol === 'UFG');
  assert.equal(withoutPrice.value, null, 'an earlier quote never overrules the explicit no-price answer');
  assert.notEqual(withoutPrice.rank, null, 'an earlier quote preserves ordering only');
});

test('look-alikes of the main tokens are recognised however they are spelt; the real ones never are', () => {
  const zwsp = String.fromCharCode(0x200b);
  const cyrillicO = String.fromCharCode(0x041e);
  assert.equal(symbolReading(`PO${zwsp}NS`), 'PONS');
  assert.equal(symbolReading('P0NS'), 'PONS');
  assert.equal(symbolReading(`P${cyrillicO}NS`), 'PONS');
  assert.equal(symbolReading(' u s d g '), 'USDG');
  // Precomposed letters are taken apart (NFKD) and their marks dropped: U with a diaeresis, G with a cedilla (review of 2026-09-25).
  assert.equal(symbolReading(`${String.fromCharCode(0xdc)}SDG`), 'USDG');
  assert.equal(symbolReading(`USD${String.fromCharCode(0x122)}`), 'USDG');
  assert.equal(isLookAlike(row(addr(14), `USD${String.fromCharCode(0x122)}`, '1')), true, 'USD G-cedilla on another contract');
  // Changed on purpose 2026-10-04 (the owner's new embedded list): U left the selected pools; UBIK, one of the new list's
  // tokens, stands where it stood, on another contract and at its own address.
  // Changed on purpose 2026-11-02 (the owner's new embedded list): UBIK left too; PRIORS and TORCH, two of the new list's
  // tokens, stand where it stood.
  for (const [address, symbol] of [[FAKE_PONS, 'P0NS'], [FAKE_USDG, 'USDG'], [addr(9), `PO${zwsp}NS`], [addr(10), 'WETH'], [addr(11), 'eth'], [addr(12), 'PRIORS'], [addr(15), 'TORCH']]) assert.equal(isLookAlike(row(address, symbol, '1')), true, symbol);
  for (const [address, symbol] of [[PONS, 'PONS'], [PRIORS, 'PRIORS'], [TORCH, 'TORCH'], [USDG, 'USDG'], [WETH, 'WETH'], [NATIVE, 'ETH'], [WETH, 'ETH'], [UFG, 'UFG'], [addr(13), null]]) assert.equal(isLookAlike(row(address, symbol, '1')), false, String(symbol));
});

// Added 2026-10-30 (QA round 2, N64): the Wallet card showed an airdropped "USDC 45 = $0.01". Domino knows no USDC, USDT,
// DAI, WBTC or EURC on Robinhood Chain, so a token there calling itself one of them is a look-alike: left out, never priced.
test('a Robinhood Chain token calling itself USDC, USDT, DAI, WBTC or EURC at an address Domino does not know is a look-alike: not listed, never priced', () => {
  const { RESERVED_SYMBOLS } = require('../.test-build/app/src/config/mainTokens.js');
  assert.deepEqual([...RESERVED_SYMBOLS], ['USDC', 'USDT', 'DAI', 'WBTC', 'EURC']);
  assert.ok(Object.isFrozen(RESERVED_SYMBOLS));
  const cyrillicC = String.fromCharCode(0x0421);
  for (const [address, symbol] of [[addr(20), 'USDC'], [addr(21), 'usdt'], [addr(22), 'DAI'], [addr(23), 'WBTC'], [addr(24), 'EURC'], [addr(25), `USD${cyrillicC}`], [addr(26), 'U S D C'], [addr(30), 'DAl'], [addr(31), 'Dai'], [addr(32), 'DA1'], [addr(33), 'U5DT']]) {
    assert.equal(isLookAlike(row(address, symbol, '45')), true, symbol);
  }
  // Another symbol, or a token on another network, is not one. Fixed 2026-10-30 after review: a ticker of plain capitals
  // counts only when it is a reserved one, so DAL (which reads DAI, a small l passing for a capital I) is listed.
  for (const [address, symbol] of [[addr(27), 'USDCX'], [addr(28), 'UFG'], [addr(34), 'DAL']]) assert.equal(isLookAlike(row(address, symbol, '1')), false, symbol);
  const onBase = row(addr(29), 'USDC', '1');
  assert.equal(isLookAlike({ ...onBase, token: { ...onBase.token, chainId: 8453 } }), false, 'USDC on Base');
  // The card: the airdropped USDC is neither listed nor asked a price; the tokens beside it are.
  const rows = [row(addr(20), 'USDC', '45', 6), row(UFG, 'UFG', '1000'), row(USDG, 'USDG', '1', 6)];
  const view = walletHoldings(rows, new Map([[UFG, { usd: '0.003', liquidityUsd: 100_000 }], [addr(20), { usd: '0.0002', liquidityUsd: 50_000 }]]));
  assert.deepEqual(view.all.map((holding) => holding.row.token.symbol), ['UFG', 'USDG']);
  assert.equal(addressesToPrice(rows).includes(addr(20)), false, 'never asked a price');
});

// Changed on purpose (round 6): at most one GET's worth (30) was named, and the rest went unanswered for good.
test('what is priced: only what the wallet holds, WETH and the held selected-pool tokens first, every one of them', () => {
  assert.deepEqual(addressesToPrice([]), []);
  assert.deepEqual(addressesToPrice([row(USDG, 'USDG', '5', 6), row(UFG, 'UFG', '0', 18, 'zero')]), [], 'USDG is $1 and a zero balance needs no price');
  // Changed on purpose (review of 2026-09-25): selected-pool tokens the wallet does not hold are no longer asked for, and neither is a look-alike.
  const asked = addressesToPrice([row(NATIVE, 'ETH', '1'), row(USDG, 'USDG', '5', 6), row(UFG, 'UFG', '10'), row(MANY, 'MANY', '0', 18, 'zero'), row(PONS, 'PONS', '3'), row(FAKE_PONS, 'P0NS', '5'), row(FAKE_USDG, 'USDG', '50')]);
  assert.deepEqual(asked, [WETH, PONS, UFG], 'WETH for native ETH, then the held selected-pool token, then the rest in list order');
  // Changed on purpose 2026-10-04 (the owner's new embedded list): the selected-pool tokens not held are the new list's.
  // Changed on purpose 2026-11-02 (the owner's new embedded list): that list's, TORCH and PRIORS in place of ORBIO and UBIK.
  for (const absent of [USDG, NATIVE, MANY, TORCH, CASHCAT, PRIORS, VIRTUAL, FAKE_PONS, FAKE_USDG]) assert.ok(!asked.includes(absent), absent);
  assert.deepEqual(addressesToPrice([row(WETH, 'WETH', '1'), row(NATIVE, 'ETH', '0', 18, 'zero')]), [WETH], 'WETH held alone is asked once');
  const many = Array.from({ length: 45 }, (_, i) => row(addr(i + 100), `T${i}`, '1'));
  // Changed on purpose 2026-10-04 (the owner's new embedded list): ORBIO, a selected-pool token, last in the list, as MARLIN was.
  // Changed on purpose 2026-10-14 (incident of 2026-10-13, package D2): a load prices PRICED_PER_LOAD (30) tokens, not
  // every held one up to 120; the rest when "Show all" opens, up to PRICED_AT_MOST.
  // Changed on purpose 2026-11-02 (the owner's new embedded list): TORCH, a selected-pool token, last, as ORBIO was.
  const all = addressesToPrice([row(NATIVE, 'ETH', '1'), ...many, row(TORCH, 'TORCH', '2')], { limit: PRICED_AT_MOST });
  assert.equal(all.length, 47, 'every held token, when asked for all: WETH, TORCH and the 45 others');
  assert.deepEqual(all.slice(0, 3), [WETH, TORCH, addr(100)], 'the main tokens the wallet holds come first, wherever the list has them');
  assert.deepEqual(addressesToPrice([row(NATIVE, 'ETH', '1'), ...many, row(TORCH, 'TORCH', '2')]), all.slice(0, PRICED_PER_LOAD), 'a load: the first PRICED_PER_LOAD of the same order');
  assert.equal(PRICED_PER_LOAD, PRICE_BATCH);
  assert.equal(PRICED_AT_MOST, PRICE_BATCH * PRICE_GETS);
  const huge = Array.from({ length: PRICE_BATCH * PRICE_GETS + 10 }, (_, i) => row(addr(i + 1000), `H${i}`, '1'));
  assert.equal(addressesToPrice(huge).length, PRICED_PER_LOAD, 'a load: 30 tokens, whatever the wallet holds');
  assert.equal(addressesToPrice(huge, { limit: PRICED_AT_MOST }).length, PRICE_BATCH * PRICE_GETS, `${PRICE_GETS} GETs’ worth at most`);
});

// Changed on purpose 2026-10-14 (incident of 2026-10-13, package D2): a list cut at the card's page cap, candidates the
// read skipped and held tokens with no price no longer withhold the total; it is then the priced tokens' total and says
// what it leaves out (totalLeavesOut). What puts the balances themselves in doubt still withholds it.
test('the total is withheld only while the balances are in doubt; otherwise it is the priced tokens’ and says what it leaves out', () => {
  const quotes = new Map([[WETH, { usd: '2000', liquidityUsd: 1e7 }], [UFG, { usd: '0.003', liquidityUsd: 165_000 }]]);
  const rows = [row(NATIVE, 'ETH', '0.01'), row(USDG, 'USDG', '5.5', 6), row(UFG, 'UFG', '1000000')];
  const values = walletHoldings(rows, quotes);
  assert.equal(totalWithheld(WHOLE_LIST, values), null, 'whole: the total is shown');
  const cases = [
    [{ reading: true }, 'reading', 'reading'],
    [{ failed: true }, 'read_failed', 'read_failed'],
    [{ morePages: true }, 'more_pages', 'more_pages'],
    [{ capped: true }, 'capped', null],
    [{ unread: 1 }, 'unread_balances', 'unread_balances'],
    [{ earlier: true }, 'earlier_rows', 'earlier_rows'],
    [{ skipped: 7 }, 'skipped_candidates', null],
    [{ discoveryMissing: true }, 'inventory_unavailable', 'inventory_unavailable'],
    [{ capped: true, earlier: true }, 'capped', 'earlier_rows'],
  ];
  for (const [change, gap, withheld] of cases) {
    assert.equal(listGap({ ...WHOLE_LIST, ...change }), gap, gap);
    assert.equal(totalWithheld({ ...WHOLE_LIST, ...change }, values), withheld, `${gap}: ${withheld}`);
  }
  assert.deepEqual(totalLeavesOut({ ...WHOLE_LIST, capped: true }, values), { unpriced: 0, cut: true }, 'a list longer than the card reads: said under the total');
  assert.deepEqual(totalLeavesOut({ ...WHOLE_LIST, skipped: 7 }, values), { unpriced: 0, cut: true });
  assert.equal(listGap(WHOLE_LIST), null);
  const noUfg = walletHoldings(rows, new Map([[WETH, quotes.get(WETH)]]));
  assert.equal(totalWithheld(WHOLE_LIST, noUfg), null, 'UFG never answered: the total of the others is shown');
  assert.equal(noUfg.total, 25n * ONE + ONE / 2n, 'ETH and USDG; UFG counted as nothing, not as zero');
  assert.deepEqual(totalLeavesOut(WHOLE_LIST, noUfg), { unpriced: 1, cut: false }, 'and the card says one held token is not priced');
  // Changed on purpose (round 6): dust is valued now, so a list worth less than a cent in all has no "$0.00" headline.
  assert.equal(totalWithheld(WHOLE_LIST, walletHoldings([row(UFG, 'UFG', '1')], new Map([[UFG, quotes.get(UFG)]]))), 'nothing_valued', 'not a cent: no headline');
  assert.equal(totalWithheld(WHOLE_LIST, walletHoldings([row(UFG, 'UFG', '1')], new Map([[UFG, null]]))), 'nothing_valued', 'nothing priced: no headline');
});

test('the artwork resolver: guarded token-pairs reads for a sorted, deduplicated batch; seeded artwork needs no extra GET', async () => {
  const urls = [];
  const resolver = createTokenArtworkResolver({ now: () => 0, fetch: async (url, init) => {
    urls.push(url);
    assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer'); assert.equal(init.redirect, 'error');
    return new Response('[]', { headers: { 'content-type': 'application/json' } });
  } });
  assert.deepEqual(await resolver.tokenPrices([UFG, MANY.toUpperCase().replace('0X', '0x'), UFG, 'WETH']), []);
  assert.deepEqual(urls, [MANY, UFG].map(token => `https://api.dexscreener.com/token-pairs/v1/robinhood/${token}`));
  assert.equal(await resolver.tokenPrices([]), null, 'nothing to ask: no GET');
  assert.equal(urls.length, 2);

  resolver.seed(4663, UFG, 'https://cdn.dexscreener.com/cms/images/abcdefghijklmnop');
  assert.equal(resolver.peek(4663, UFG), 'https://cdn.dexscreener.com/cms/images/abcdefghijklmnop?width=64&height=64&quality=85&format=auto');
  assert.equal(await resolver.resolve(4663, UFG), resolver.peek(4663, UFG));
  resolver.seed(4663, UFG, null);
  assert.ok(resolver.peek(4663, UFG), 'found artwork is never replaced by a none');
  resolver.seed(4663, MANY, 'https://127.0.0.1/logo.png');
  assert.equal(resolver.peek(4663, MANY), null, 'an unsafe image is none');
  assert.equal(resolver.peek(4663, addr(1)), undefined);
  assert.equal(urls.length, 2, 'seeded artwork asked nothing');
});

// Changed on purpose (round 6, 2026-09-27; the owner: the tokens took far too long to appear): the card now keeps its
// last list per address in this browser (lib/walletMemory.ts), under one key. The prices module and the holdings
// module still keep nothing, and the card itself reaches storage only through walletMemory.ts.
test('the card asks its prices through the artwork client only; only walletMemory.ts keeps anything, under one key', () => {
  for (const file of ['src/lib/walletPrices.ts', 'src/lib/walletHoldings.ts', 'src/components/portfolio/PortfolioTokens.tsx', 'src/lib/walletMemory.ts']) {
    const code = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(code, /\bfetch\(|XMLHttpRequest|sessionStorage|indexedDB|document\.cookie/, file);
    if (file !== 'src/lib/walletMemory.ts') assert.doesNotMatch(code, /localStorage/, file);
  }
  // Changed on purpose 2026-10-01 (the chain2 workstream, part B, audit item G10): the key names its chain.
  assert.equal(WALLET_MEMORY_KEY, 'domino-wallet-v2:4663');
});

// 2026-10-01 (the chain2 workstream, part B, audit item G10): a list kept under the old name is Robinhood Chain's and
// moves to the new one the first time it is read, as it was; a browser that cannot let go of keys copies it.
test('memory: a list kept under the name before moves to the chain\'s name on its first read, and is drawn the same', () => {
  const { LEGACY_WALLET_MEMORY_KEY } = require('../.test-build/app/src/lib/walletMemory.js');
  assert.equal(LEGACY_WALLET_MEMORY_KEY, 'domino-wallet-v1');
  assert.equal(copies.LEGACY_WALLET_MEMORY, LEGACY_WALLET_MEMORY_KEY);
  const rows = [row(UFG, 'UFG', '1')];
  const before = memoryStorage();
  rememberWallet(OWNER_A, { at: 1_000, whole: true, rows }, new Map(), before, 1_000);
  const text = before.map.get(WALLET_MEMORY_KEY);
  const map = new Map([[LEGACY_WALLET_MEMORY_KEY, text]]);
  const old = { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
  assert.deepEqual(recallWallet(OWNER_A, 2_000, old), recallWallet(OWNER_A, 2_000, before), 'drawn as it was');
  assert.deepEqual([...map.keys()], [WALLET_MEMORY_KEY], 'moved: the old name is gone');
  assert.equal(map.get(WALLET_MEMORY_KEY), text, 'the same text');
  // Both kept: the chain's name wins, the old one goes.
  map.set(LEGACY_WALLET_MEMORY_KEY, JSON.stringify({ v: 1, wallets: {} }));
  assert.ok(recallWallet(OWNER_A, 2_000, old));
  assert.deepEqual([...map.keys()], [WALLET_MEMORY_KEY]);
  // A stand-in that cannot remove: copied, drawn the same.
  const copy = memoryStorage();
  copy.map.set(LEGACY_WALLET_MEMORY_KEY, text);
  assert.ok(recallWallet(OWNER_A, 2_000, copy));
  assert.equal(copy.map.get(WALLET_MEMORY_KEY), text);
});

/** A Storage stand-in over a Map. */
const memoryStorage = () => {
  const map = new Map();
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)) };
};
const OWNER_A = '0xf6184f814543b88dd867c34ce6e9f56ab7d18c0a';
/** A held balance whose decimals were not read. */
const rawRow = (address, symbol, raw) => {
  const base = row(address, symbol, '1');
  return { ...base, raw, token: { ...base.token, decimals: null }, amount: { label: 'Balance', text: `${raw} (raw units, decimals unknown)`, state: 'raw' } };
};

/** Prices as the card holds them: each quote with the time it was answered. */
const stamped = (entries, at) => new Map(entries.map(([address, quote]) => [address, { quote, at }]));

// Changed on purpose (review of round 6, 2026-09-28): each price is kept with the time it was answered, and comes back
// as a book whose `since` says which prices still count.
test('memory: a list read to its end comes back for its address, rows and prices as they were, as rows the card draws the same', () => {
  const storage = memoryStorage();
  const rows = [row(NATIVE, 'ETH', '0.0035'), row(UFG, 'UFG', '903723.358'), rawRow(addr(8), 'RAW', '5')];
  const quotes = new Map([[WETH, { usd: '2673.7', liquidityUsd: 19_778_723.98 }], [UFG, { usd: '0.002937', liquidityUsd: 164_486.3 }], [MANY, { usd: '1', liquidityUsd: 1 }], [addr(8), null]]);
  rememberWallet(OWNER_A.toUpperCase().replace('0X', '0x'), { at: 1_000_000, whole: true, rows }, stamped([...quotes], 990_000), storage, 1_000_000);
  assert.deepEqual([...storage.map.keys()], [WALLET_MEMORY_KEY], 'one key');
  const back = recallWallet(OWNER_A, 1_000_000 + 60_000, storage);
  assert.equal(back.whole, true);
  assert.equal(back.at, 1_000_000);
  assert.deepEqual(back.rows.map((r) => [r.key, r.token.symbol, r.token.decimals, r.raw, r.amount.state, r.amount.text]), [
    [`4663:${NATIVE}`, 'ETH', 18, '3500000000000000', 'value', '0.0035'],
    [`4663:${UFG}`, 'UFG', 18, '903723358000000000000000', 'value', '903,723.358'],
    [`4663:${addr(8)}`, 'RAW', null, '5', 'raw', '5 (raw units, decimals unknown)'],
  ]);
  assert.deepEqual([...back.book.prices], [[WETH, { quote: { usd: '2673.7', liquidityUsd: 19_778_723.98 }, at: 990_000 }], [UFG, { quote: { usd: '0.002937', liquidityUsd: 164_486.3 }, at: 990_000 }], [addr(8), { quote: null, at: 990_000 }]], 'the prices of its own tokens only (MANY is not held), each at its answer time');
  assert.equal(back.book.since, 1_060_000 - WALLET_PRICE_MAX_AGE_MS);
  const { quotes: counted, hints } = bookQuotes(back.book);
  assert.equal(hints.size, 0, 'a minute old: every price counts');
  assert.deepEqual(walletHoldings(back.rows, counted).all.map((h) => [h.row.token.symbol, h.value]), walletHoldings(rows, quotes).all.map((h) => [h.row.token.symbol, h.value]), 'drawn exactly as the list it was');
  assert.equal(recallWallet(addr(77), 1_000_000, storage), null, 'another address has nothing');
});

// Review of round 6 (2026-09-28): the memory kept prices with no time of their own, and each list read wrote them back
// under the list's new time, so the one-week limit never let them go. With the provider down for days, the card showed
// a total at prices from weeks before, as current. A price now counts for an hour after its answer, and no longer.
test('memory: a price counts for an hour after its answer; writing the list back never makes it newer; an older one only keeps its row in place', () => {
  assert.equal(WALLET_PRICE_MAX_AGE_MS, 12 * PRICE_TTL_MS, 'an hour');
  const storage = memoryStorage();
  const T = 1_800_000_000_000;
  const HOUR = WALLET_PRICE_MAX_AGE_MS;
  const rows = [row(NATIVE, 'ETH', '0.01'), row(USDG, 'USDG', '0.5', 6), row(UFG, 'UFG', '1000000'), row(MANY, 'MANY', '1000000'), row(addr(1), 'AAA', '1000'), row(addr(2), 'NOPE', '5')];
  const answered = [[WETH, { usd: '2000', liquidityUsd: 1e7 }], [UFG, { usd: '0.003', liquidityUsd: 165_000 }], [MANY, { usd: '0.002', liquidityUsd: 400_000 }], [addr(1), null], [addr(2), null]];
  const book = withAnswer(NO_PRICES, { quotes: new Map(answered), at: new Map(answered.map(([a]) => [a, T])) }, T);
  assert.equal(book.since, T - HOUR);
  rememberWallet(OWNER_A, { at: T, whole: true, rows }, book.prices, storage, T);

  // Within the hour: every price counts, and the total is the wallet's.
  const soon = recallWallet(OWNER_A, T + HOUR, storage);
  const fresh = bookQuotes(soon.book);
  assert.equal(fresh.quotes.size, 5);
  const freshView = walletHoldings(soon.rows, fresh.quotes, fresh.hints);
  assert.equal(totalWithheld(WHOLE_LIST, freshView), null);
  assert.deepEqual(freshView.all.map((h) => h.row.token.symbol), ['UFG', 'MANY', 'ETH', 'USDG', 'AAA', 'NOPE']);

  // Past the hour: no price counts, so no value and no total; the rows keep their last known order by value, and the
  // unpriced airdrop AAA stays last instead of taking a top-3 place by its name.
  const later = recallWallet(OWNER_A, T + HOUR + 1, storage);
  const { quotes, hints } = bookQuotes(later.book);
  assert.equal(quotes.size, 0, 'a price past its limit is not used');
  assert.equal(hints.size, 5, 'but kept, to place the rows');
  const view = walletHoldings(later.rows, quotes, hints);
  assert.deepEqual(view.all.map((h) => [h.row.token.symbol, h.value === null, h.due]), [['UFG', true, true], ['MANY', true, true], ['ETH', true, true], ['USDG', false, false], ['AAA', true, true], ['NOPE', true, true]]);
  assert.equal(view.valued, 1, 'USDG alone is valued ($1 needs no provider)');
  assert.equal(view.total, ONE / 2n);
  // Changed on purpose 2026-10-14 (incident of 2026-10-13, package D2): no total at old prices, still; the priced tokens'
  // total (USDG's) is shown, and says the five others are not priced. It was no total at all.
  assert.equal(totalWithheld(WHOLE_LIST, view), null, 'no total at old prices: the old prices count for nothing');
  assert.deepEqual(totalLeavesOut(WHOLE_LIST, view), { unpriced: 5, cut: false });
  assert.deepEqual(walletHoldings(later.rows, quotes).all.slice(0, SHOWN_HOLDINGS).map((h) => h.row.token.symbol), ['USDG', 'ETH', 'AAA'], 'what the hints prevent: the airdrop among the top 3');

  // A list read again twelve hours on, while every price GET fails: it is written back under its new time, and each
  // price keeps its own, so it stays too old to count. Changed on purpose 2026-10-01 (I6): the memory keeps a day, not a
  // week (lib/browserCopies.ts), so the reads are hours apart, not days.
  const half = T + 12 * 3_600_000;
  const later30 = T + 30 * 3_600_000;
  rememberWallet(OWNER_A, { at: half, whole: true, rows }, recallWallet(OWNER_A, half, storage).book.prices, storage, half);
  const kept = JSON.parse(storage.map.get(WALLET_MEMORY_KEY)).wallets[OWNER_A];
  assert.equal(kept.at, half, 'the list is the newer read');
  assert.deepEqual(kept.quotes.map((q) => q[3]), [T, T, T, T, T], 'writing back does not refresh a price’s time');
  rememberWallet(OWNER_A, { at: later30, whole: true, rows }, recallWallet(OWNER_A, later30, storage).book.prices, storage, later30);
  assert.deepEqual(JSON.parse(storage.map.get(WALLET_MEMORY_KEY)).wallets[OWNER_A].quotes, [], 'past a day, a price is let go altogether');
  assert.equal(recallWallet(OWNER_A, later30, storage).book.prices.size, 0);

  // A new answer counts from its own time: an answer reused from the visit's memory is not made newer by arriving later.
  const again = withAnswer(later.book, { quotes: new Map([[UFG, { usd: '0.004', liquidityUsd: 165_000 }]]), at: new Map([[UFG, T + HOUR + 500]]) }, T + HOUR + 900);
  assert.deepEqual(again.prices.get(UFG), { quote: { usd: '0.004', liquidityUsd: 165_000 }, at: T + HOUR + 500, hint: { quote: { usd: '0.003', liquidityUsd: 165_000 }, at: T } });
  assert.deepEqual(bookQuotes(again).quotes, new Map([[UFG, { usd: '0.004', liquidityUsd: 165_000 }]]), 'only the new answer counts');
  const older = withAnswer(again, { quotes: new Map([[UFG, { usd: '9', liquidityUsd: 1e6 }]]), at: new Map([[UFG, T]]) }, T + HOUR + 1000);
  assert.equal(older.prices.get(UFG).quote.usd, '0.004', 'an older answer never replaces a newer one');
  assert.equal(withAnswer(NO_PRICES, { quotes: new Map([[UFG, null]]), at: new Map([[UFG, T + 5000]]) }, T).prices.get(UFG).at, T, 'never later than now');
});

test('memory: too old, from the future, or not what was kept, it is never drawn; storage that throws is no storage', () => {
  const storage = memoryStorage();
  const rows = [row(UFG, 'UFG', '1')];
  rememberWallet(OWNER_A, { at: 0, whole: true, rows }, new Map(), storage, 0);
  // Changed on purpose 2026-10-01 (I6): a day, not a week; lib/browserCopies.ts names the same key and the same age.
  assert.equal(WALLET_MEMORY_MAX_AGE_MS, 86_400_000);
  assert.equal(WALLET_MEMORY_KEY, copies.WALLET_MEMORY);
  assert.equal(WALLET_MEMORY_MAX_AGE_MS, copies.WALLET_MEMORY_MAX_AGE_MS);
  assert.ok(recallWallet(OWNER_A, WALLET_MEMORY_MAX_AGE_MS, storage), 'a day old: still drawn');
  assert.equal(recallWallet(OWNER_A, WALLET_MEMORY_MAX_AGE_MS + 1, storage), null, 'older than a day: never');
  rememberWallet(OWNER_A, { at: 10_000_000, whole: true, rows }, new Map(), storage, 10_000_000);
  assert.equal(recallWallet(OWNER_A, 10_000_000 - 61_000, storage), null, 'written more than a minute in the future: never');
  const kept = () => ({ v: 1, wallets: { [OWNER_A]: { at: 10_000_000, whole: true, rows: [[UFG, 'UFG', 18, '1', 1]], quotes: [[UFG, '0.003', 165_000, 10_000_000]] } } });
  const tamper = (edit) => {
    const all = kept();
    edit(all.wallets[OWNER_A]);
    storage.setItem(WALLET_MEMORY_KEY, JSON.stringify(all));
    return recallWallet(OWNER_A, 10_000_000, storage);
  };
  assert.ok(tamper(() => {}), 'as kept: drawn');
  for (const [what, edit] of [
    ['a bad address', (w) => { w.rows[0][0] = 'javascript:alert(1)'; }],
    ['a zero balance', (w) => { w.rows[0][3] = '0'; }],
    ['a balance that is not an integer', (w) => { w.rows[0][3] = '1e18'; }],
    ['a long symbol', (w) => { w.rows[0][1] = 'X'.repeat(65); }],
    ['odd decimals', (w) => { w.rows[0][2] = 300; }],
    ['a price with an exponent', (w) => { w.quotes[0][1] = '1e-3'; }],
    ['a zero price', (w) => { w.quotes[0][1] = '0.000'; }],
    ['a liquidity that is not a number', (w) => { w.quotes[0][2] = 'lots'; }],
    ['a price kept without the time it was answered', (w) => { w.quotes[0] = w.quotes[0].slice(0, 3); }],
    ['a price time that is not a time', (w) => { w.quotes[0][3] = 'now'; }],
    ['too many rows', (w) => { w.rows = Array.from({ length: 201 }, () => w.rows[0]); }],
  ]) assert.equal(tamper(edit), null, what);
  storage.setItem(WALLET_MEMORY_KEY, '{not json');
  assert.equal(recallWallet(OWNER_A, 0, storage), null, 'unreadable: nothing');
  const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(recallWallet(OWNER_A, 0, throwing), null);
  assert.doesNotThrow(() => rememberWallet(OWNER_A, { at: 0, whole: true, rows }, new Map(), throwing, 0));
  assert.doesNotThrow(() => rememberWallet(OWNER_A, { at: 0, whole: true, rows }, new Map(), null, 0));
});

test('memory: four addresses at most, the most recently read kept', () => {
  const storage = memoryStorage();
  for (let i = 1; i <= WALLET_MEMORY_ADDRESSES + 2; i++) rememberWallet(addr(500 + i), { at: i * 1000, whole: false, rows: [row(UFG, 'UFG', String(i))] }, new Map(), storage, i * 1000);
  const kept = Object.keys(JSON.parse(storage.map.get(WALLET_MEMORY_KEY)).wallets);
  assert.equal(kept.length, WALLET_MEMORY_ADDRESSES);
  assert.deepEqual(kept.sort(), [addr(503), addr(504), addr(505), addr(506)].sort(), 'the two oldest let go');
  assert.equal(recallWallet(addr(506), 6000, storage).rows[0].raw, String(6n * ONE));
  assert.equal(recallWallet(addr(506), 6000, storage).whole, false);
});

// Added 2026-10-14 (incident of 2026-10-13, package D2). Production showed "Wallet value unavailable." for the owner's 63
// held tokens with data-wallet-total-withheld="unanswered_prices": one held token that had a qualified pool at an
// earlier visit of the day and has none now, its old price kept as a hint for a day, counted as unanswered, and one
// unanswered token withheld the whole total. These cases state the cause and the new rules.
test('D2, the cause: one held token that lost its qualified pool no longer withholds the total of 62 others; the card says it is not priced', () => {
  const T = 1_800_000_000_000;
  const rows = [row(NATIVE, 'ETH', '0.002'), row(USDG, 'USDG', '0.5', 6), row(UFG, 'UFG', '1000000'), row(addr(10), 'THIN', '2')];
  for (let i = 0; i < 59; i++) rows.push(row(addr(200 + i), `N${i}`, '2'));
  // Remembered from a visit 6.5 hours ago: UFG, WETH and THIN priced (THIN in a $12,000 pool), the others with none.
  const others = rows.slice(4).map((r) => [r.token.address, null]);
  const earlier = withAnswer(NO_PRICES, { quotes: new Map([[UFG, { usd: '0.00260994', liquidityUsd: 150_000 }], [WETH, { usd: '4000', liquidityUsd: 5e6 }], [addr(10), { usd: '5', liquidityUsd: 12_000 }], ...others]), at: new Map() }, T - 6.5 * 3_600_000);
  // Now: THIN's pool holds $500, which does not qualify; every other answer as before.
  const now = withAnswer(earlier, { quotes: new Map([[UFG, { usd: '0.00260994', liquidityUsd: 150_000 }], [WETH, { usd: '4000', liquidityUsd: 5e6 }], [addr(10), null], ...others]), at: new Map() }, T);
  const { quotes, hints } = bookQuotes(now, T);
  const view = walletHoldings(rows, quotes, hints);
  assert.equal(view.all.length, 63);
  assert.equal(view.unanswered, 1, 'THIN: a lost price, as on production');
  assert.equal(totalWithheld(WHOLE_LIST, view), null, 'was "unanswered_prices": "Wallet value unavailable."');
  assert.equal(view.total, 261_844n * 10n ** 16n, 'UFG $2,609.94, ETH $8.00 and USDG $0.50: $2,618.44; THIN and the others count for nothing');
  assert.deepEqual(totalLeavesOut(WHOLE_LIST, view), { unpriced: 60, cut: false });
  assert.deepEqual(view.all.slice(0, 4).map((h) => [h.row.token.symbol, h.value === null]), [['UFG', false], ['THIN', true], ['ETH', false], ['USDG', false]], 'THIN keeps its place by its last value ($10), with no USD');
});

test('D2, what a load prices: Domino’s tokens, then the largest remembered holdings, then the list, the remembered no-market ones last; 30 at most', () => {
  const T = 1_800_000_000_000;
  const rows = [row(addr(1), 'AAA', '1'), row(addr(2), 'NOPE', '1'), row(UFG, 'UFG', '1000000'), row(addr(3), 'BBB', '1'), row(PONS, 'PONS', '3'), row(MANY, 'MANY', '1000'), row(NATIVE, 'ETH', '0.01'), row(USDG, 'USDG', '1', 6)];
  assert.deepEqual(addressesToPrice(rows), [WETH, PONS, addr(1), addr(2), UFG, addr(3), MANY], 'nothing remembered: Domino’s tokens, then list order');
  // Remembered: UFG worth $3,000, MANY $2 (two hours ago, so only a hint), NOPE with no qualified price.
  const book = withAnswer(withAnswer(NO_PRICES, { quotes: new Map([[MANY, { usd: '0.002', liquidityUsd: 50_000 }]]), at: new Map() }, T - 2 * 3_600_000),
    { quotes: new Map([[UFG, { usd: '0.003', liquidityUsd: 165_000 }], [addr(2), null]]), at: new Map() }, T - 60_000);
  assert.deepEqual(addressesToPrice(rows, { book, now: T }), [WETH, PONS, UFG, MANY, addr(1), addr(3), addr(2)], 'the largest remembered holdings next, by value; the no-market one last');
  assert.deepEqual(addressesToPrice(rows, { book, now: T, limit: 3 }), [WETH, PONS, UFG]);
  // 5, 51, 63 and 700 held tokens: a load prices min(held, 30).
  for (const held of [5, 51, 63, 700]) {
    const wallet = Array.from({ length: held }, (_, i) => row(addr(5000 + i), `W${i}`, '1'));
    assert.equal(addressesToPrice(wallet).length, Math.min(held, PRICED_PER_LOAD), `${held} held`);
  }
});

test('D2, one load’s asks: chosen once the list names 30 or is read, never taken back, 30 more per "Show all" step; 5, 51, 63 and 700 tokens', () => {
  assert.deepEqual(nextAsk([], [addr(1), addr(2), addr(3)], 2), [addr(1), addr(2)]);
  assert.deepEqual(nextAsk([addr(9)], [addr(1), addr(9), addr(2)], 3), [addr(9), addr(1), addr(2)], 'what was asked stays first, in its order');
  assert.deepEqual(nextAsk([addr(9), addr(8)], [addr(1)], 2), [addr(9), addr(8)], 'full: nothing more, nothing taken back');
  // The card's load, page by page (20 tokens a page, as the read service lists them, 5 pages at most), for every size.
  for (const held of [5, 51, 63, 700]) {
    const tokens = Array.from({ length: held }, (_, i) => row(addr(7000 + i), `P${i}`, '1'));
    const pages = Math.min(5, Math.ceil(held / 20));
    let asked = [];
    let sends = 0;
    for (let page = 1; page <= pages; page++) {
      const order = addressesToPrice(tokens.slice(0, page * 20), { limit: PRICED_AT_MOST });
      const settled = page === pages;
      const next = settled || order.length >= PRICED_PER_LOAD ? nextAsk(asked, order, PRICED_PER_LOAD) : asked;
      if (next.length > asked.length) sends += 1;
      asked = next;
    }
    assert.equal(asked.length, Math.min(held, PRICED_PER_LOAD), `${held} held: ${asked.length} priced in the load`);
    assert.equal(sends, 1, `${held} held: one ask of the prices in the whole load, so ${Math.ceil(asked.length / 10)} GETs of ten at our edge`);
    // "Show all": 30 more each time the page before is answered, up to PRICED_AT_MOST.
    const all = addressesToPrice(tokens.slice(0, pages * 20), { limit: PRICED_AT_MOST });
    let bound = PRICED_PER_LOAD;
    while (all.length > asked.length && bound < PRICED_AT_MOST) {
      bound += PRICED_PER_LOAD;
      asked = nextAsk(asked, all, bound);
    }
    assert.equal(asked.length, Math.min(held, 100), `${held} held, Show all opened: every listed token priced (the list reads 100 at most)`);
  }
});

// Review of D2 (2026-10-14), its blocking finding: a full ask took no token in, so a token of Domino's own that the wallet
// started holding after the load's ask filled (on a page the remembered list did not have, or brought by a collect or a
// withdraw into the card on screen) was never priced in the load. Domino's own held tokens are now asked past the bound.
test('D2 review: Domino’s own held tokens are asked past a full ask, each once; a token Domino does not know still waits for "Show all"', () => {
  assert.deepEqual(knownHeld([]), []);
  assert.deepEqual(knownHeld([row(USDG, 'USDG', '5', 6), row(UFG, 'UFG', '1'), row(PONS, 'PONS', '0', 18, 'zero'), row(FAKE_PONS, 'P0NS', '5')]), [],
    'USDG is $1, a zero balance and a look-alike need no price, and UFG is not one of Domino’s');
  assert.deepEqual(knownHeld([row(VIRTUAL, 'VIRTUAL', '1'), row(UFG, 'UFG', '1'), row(PONS, 'PONS', '3'), row(NATIVE, 'ETH', '1'), row(WETH, 'WETH', '2')]), [WETH, PONS, VIRTUAL],
    'WETH once (for native ETH too), then the selected pools’ tokens, in that order');
  assert.deepEqual(knownHeld([row(NATIVE, 'ETH', '1'), row(PONS, 'PONS', '3')]), addressesToPrice([row(NATIVE, 'ETH', '1'), row(PONS, 'PONS', '3')]), 'the same tokens a load asks first');
  // A remembered list of 40 fills the load's 30 at once; the list's last page then names a token Domino does not know
  // and 1,000 PONS.
  const remembered = Array.from({ length: 40 }, (_, i) => row(addr(8000 + i), `R${i}`, '1'));
  const ask = (asked, rows, bound = PRICED_PER_LOAD) => nextAsk(asked, addressesToPrice(rows, { limit: PRICED_AT_MOST }), bound, knownHeld(rows));
  const first = ask([], remembered);
  assert.deepEqual(first, remembered.slice(0, PRICED_PER_LOAD).map((r) => r.token.address));
  const now = [...remembered, row(addr(9000), 'LATE', '1'), row(PONS, 'PONS', '1000')];
  assert.deepEqual(nextAsk(first, addressesToPrice(now, { limit: PRICED_AT_MOST }), PRICED_PER_LOAD), first, 'without `always`, as on 6156544a: PONS was never asked in the load');
  const later = ask(first, now);
  assert.deepEqual(later, [...first, PONS], 'what was asked, in its order, then PONS past the bound');
  assert.deepEqual(ask(later, now), later, 'asked once: the next render adds nothing');
  // Native ETH arrives too (a withdraw from an ETH pool): WETH, once, after PONS.
  const withEth = [...now, row(NATIVE, 'ETH', '0.5')];
  assert.deepEqual(ask(later, withEth), [...later, WETH]);
  assert.deepEqual(ask(ask(later, withEth), [...withEth, row(WETH, 'WETH', '1')]), [...later, WETH], 'WETH held as well as native ETH: still once');
  // "Show all": the next page of PRICED_PER_LOAD reaches LATE; nothing asked is taken back.
  const opened = ask(ask(later, withEth), withEth, PRICED_PER_LOAD * 2);
  assert.deepEqual(opened.slice(0, PRICED_PER_LOAD + 2), [...later, WETH]);
  assert.ok(opened.includes(addr(9000)), 'Show all prices LATE');
  assert.equal(opened.length, 43, 'every held token, priced once: 40 remembered, LATE, PONS and WETH');
});

test('D2, prices: a load of 30 is one wire; after a refusal nothing is asked again within PRICE_TTL_MS; a slow GET is joined, never sent twice', async () => {
  let now = 0;
  const sent = [];
  let reply = (list) => list.map((a) => pair(a, '1', 1e6));
  const prices = createWalletPrices({ get: async (list) => (sent.push([...list]), reply(list)), seed: () => {}, now: () => now });
  const thirty = Array.from({ length: 30 }, (_, i) => addr(8000 + i));
  assert.equal((await prices.price(thirty)).quotes.size, 30);
  assert.equal(sent.length, 1, 'one wire for the load’s 30 tokens (our edge is asked ten to a GET: three)');
  // The provider refuses (our edge answers nothing, or every token missing): nothing kept, nothing asked again soon.
  now += PRICE_TTL_MS;
  reply = () => null;
  const refused = await prices.price(thirty);
  assert.equal(refused.failed, true);
  for (let i = 0; i < 5; i++) await prices.price(thirty);
  assert.equal(sent.length, 2, 'every later ask of the load sends nothing');
  // A slow provider: the GET is on its way when the next asks come and when its consumer leaves; all join it.
  now += PRICE_TTL_MS;
  let release;
  reply = (list) => new Promise((done) => { release = () => done(list.map((a) => pair(a, '2', 1e6))); });
  const leaving = new AbortController();
  const first = prices.price(thirty, { signal: leaving.signal });
  leaving.abort();
  await first;
  const second = prices.price(thirty);
  const third = prices.price(thirty.slice(0, 10));
  assert.equal(sent.length, 3, 'one GET, joined by every later ask');
  release();
  assert.equal((await second).quotes.size, 30);
  assert.equal((await third).quotes.get(thirty[0]).usd, '2');
});

test('D2, the valuation kept for a refresh: the priced tokens’ total with its count, but none while a price too old to count waits for its answer', () => {
  const T = 1_800_000_000_000;
  const rows = [row(UFG, 'UFG', '1000000'), row(USDG, 'USDG', '1', 6), row(addr(3), 'NONE', '5')];
  const fresh = withAnswer(NO_PRICES, { quotes: new Map([[UFG, { usd: '0.003', liquidityUsd: 165_000 }], [addr(3), null]]), at: new Map() }, T);
  const kept = walletTotalSnapshot(rows, fresh, T, T);
  assert.deepEqual([kept.total, kept.unpriced], [3001n * ONE, 1], 'NONE has no market: left out, and counted as left out');
  // Two hours on, nothing answered since: UFG's price only places its row. A kept valuation of USDG alone would show $1
  // while the next answer brings UFG back: none is kept, and the card holds the total's place until the answer.
  assert.equal(walletTotalSnapshot(rows, fresh, T + 2 * 3_600_000, T + 2 * 3_600_000), null);
  // UFG lost its pool (answered, no qualified price): the priced tokens' total is the one shown, and the one kept.
  const lost = withAnswer(fresh, { quotes: new Map([[UFG, null]]), at: new Map() }, T + 60_000);
  const after = walletTotalSnapshot(rows, lost, T + 60_000, T + 60_000);
  assert.deepEqual([after.total, after.unpriced], [ONE, 2]);
});
