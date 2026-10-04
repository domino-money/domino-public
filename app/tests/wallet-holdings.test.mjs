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
const { SHOWN_HOLDINGS, WHOLE_LIST, addressesToPrice, isLookAlike, listGap, symbolReading, totalWithheld, usdValue, walletHoldings } = require('../.test-build/app/src/lib/walletHoldings.js');
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
const ORBIO = '0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3';
const CASHCAT = '0x020bfc650a365f8bb26819deaabf3e21291018b4';
const UBIK = '0x812486eaea648819853f8e372dc9f1516c7868bd';
const VIRTUAL = '0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31';
const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const ONE = 10n ** 18n;

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
  const again = await prices.price([UFG, MANY]);
  assert.equal(asked.length, 3, 'a failed GET is not kept: the next view asks again');
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
  const halfFailed = createWalletPrices({ get: async (list) => (list.includes(many[0]) ? null : list.map((a) => pair(a, '1', 1e6))), seed: () => {}, now: () => 0 });
  const partial = await halfFailed.price(many);
  assert.equal(partial.failed, false, 'one GET answered: not a failure');
  assert.equal(partial.quotes.size, 15, 'the failed GET’s 30 stay unanswered, to be asked again');
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

test('prices abort only when the last joined consumer leaves and reject late cancelled answers', async () => {
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
  await first;
  await new Promise(setImmediate);
  assert.equal(pending[0].signal.aborted, false, 'the second consumer still needs the request');
  b.abort();
  await second;
  await new Promise(setImmediate);
  assert.equal(pending[0].signal.aborted, true);
  const third = prices.price([UFG]);
  assert.equal(pending.length, 2, 'cancelled read is not joined again');
  pending[0].resolve([pair(UFG, '99', 1e6)]);
  await new Promise(setImmediate);
  assert.deepEqual(progress, [0], 'no notification after leaving');
  pending[1].resolve([pair(UFG, '2', 1e6)]);
  assert.equal((await third).quotes.get(UFG).usd, '2');
  assert.equal((await prices.price([UFG])).quotes.get(UFG).usd, '2', 'late cancelled data did not populate cache');
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
test('without any price: USDG is still $1, and every other held token follows with no price, the main tokens first', () => {
  const rows = [row(UFG, 'UFG', '1000'), row(addr(1), 'AAA', '5'), row(USDG, 'USDG', '5', 6), row(FAKE_USDG, 'USDG', '50'), row(WETH, 'WETH', '0.5'), row(NATIVE, 'ETH', '0.01'), row(PONS, 'PONS', '3'), row(MANY, 'MANY', '0', 18, 'zero')];
  const view = walletHoldings(rows, new Map());
  assert.deepEqual(view.all.map((h) => [h.row.token.symbol, h.value]), [['USDG', 5n * ONE], ['ETH', null], ['WETH', null], ['PONS', null], ['AAA', null], ['UFG', null]]);
  assert.equal(view.unanswered, 5, 'nothing but USDG answered');
  assert.equal(totalWithheld(WHOLE_LIST, view), 'unanswered_prices', 'no total claims to be the wallet’s value');
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
  assert.deepEqual(walletHoldings(rows, new Map([[UFG, null]]), hints).all.find((h) => h.row.token.symbol === 'UFG').rank, null, 'a fresh answer of no price overrules an old price');
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
  for (const [address, symbol] of [[FAKE_PONS, 'P0NS'], [FAKE_USDG, 'USDG'], [addr(9), `PO${zwsp}NS`], [addr(10), 'WETH'], [addr(11), 'eth'], [addr(12), 'UBIK']]) assert.equal(isLookAlike(row(address, symbol, '1')), true, symbol);
  for (const [address, symbol] of [[PONS, 'PONS'], [UBIK, 'UBIK'], [USDG, 'USDG'], [WETH, 'WETH'], [NATIVE, 'ETH'], [WETH, 'ETH'], [UFG, 'UFG'], [addr(13), null]]) assert.equal(isLookAlike(row(address, symbol, '1')), false, String(symbol));
});

// Changed on purpose (round 6): at most one GET's worth (30) was named, and the rest went unanswered for good.
test('what is priced: only what the wallet holds, WETH and the held selected-pool tokens first, every one of them', () => {
  assert.deepEqual(addressesToPrice([]), []);
  assert.deepEqual(addressesToPrice([row(USDG, 'USDG', '5', 6), row(UFG, 'UFG', '0', 18, 'zero')]), [], 'USDG is $1 and a zero balance needs no price');
  // Changed on purpose (review of 2026-09-25): selected-pool tokens the wallet does not hold are no longer asked for, and neither is a look-alike.
  const asked = addressesToPrice([row(NATIVE, 'ETH', '1'), row(USDG, 'USDG', '5', 6), row(UFG, 'UFG', '10'), row(MANY, 'MANY', '0', 18, 'zero'), row(PONS, 'PONS', '3'), row(FAKE_PONS, 'P0NS', '5'), row(FAKE_USDG, 'USDG', '50')]);
  assert.deepEqual(asked, [WETH, PONS, UFG], 'WETH for native ETH, then the held selected-pool token, then the rest in list order');
  // Changed on purpose 2026-10-04 (the owner's new embedded list): the selected-pool tokens not held are the new list's.
  for (const absent of [USDG, NATIVE, MANY, ORBIO, CASHCAT, UBIK, VIRTUAL, FAKE_PONS, FAKE_USDG]) assert.ok(!asked.includes(absent), absent);
  assert.deepEqual(addressesToPrice([row(WETH, 'WETH', '1'), row(NATIVE, 'ETH', '0', 18, 'zero')]), [WETH], 'WETH held alone is asked once');
  const many = Array.from({ length: 45 }, (_, i) => row(addr(i + 100), `T${i}`, '1'));
  // Changed on purpose 2026-10-04 (the owner's new embedded list): ORBIO, a selected-pool token, last in the list, as MARLIN was.
  const all = addressesToPrice([row(NATIVE, 'ETH', '1'), ...many, row(ORBIO, 'ORBIO', '2')]);
  assert.equal(all.length, 47, 'every held token: WETH, ORBIO and the 45 others');
  assert.deepEqual(all.slice(0, 3), [WETH, ORBIO, addr(100)], 'the main tokens the wallet holds come first, wherever the list has them');
  const huge = Array.from({ length: PRICE_BATCH * PRICE_GETS + 10 }, (_, i) => row(addr(i + 1000), `H${i}`, '1'));
  assert.equal(addressesToPrice(huge).length, PRICE_BATCH * PRICE_GETS, `${PRICE_GETS} GETs’ worth at most`);
});

test('the total stands for the wallet only when the list is whole: every page, every balance, every held token answered', () => {
  const quotes = new Map([[WETH, { usd: '2000', liquidityUsd: 1e7 }], [UFG, { usd: '0.003', liquidityUsd: 165_000 }]]);
  const rows = [row(NATIVE, 'ETH', '0.01'), row(USDG, 'USDG', '5.5', 6), row(UFG, 'UFG', '1000000')];
  const values = walletHoldings(rows, quotes);
  assert.equal(totalWithheld(WHOLE_LIST, values), null, 'whole: the total is shown');
  const cases = [
    [{ reading: true }, 'reading'],
    [{ failed: true }, 'read_failed'],
    [{ morePages: true }, 'more_pages'],
    [{ capped: true }, 'capped'],
    [{ unread: 1 }, 'unread_balances'],
    [{ earlier: true }, 'earlier_rows'],
    [{ skipped: 7 }, 'skipped_candidates'],
  ];
  for (const [change, reason] of cases) {
    assert.equal(listGap({ ...WHOLE_LIST, ...change }), reason, reason);
    assert.equal(totalWithheld({ ...WHOLE_LIST, ...change }, values), reason, reason);
  }
  assert.equal(listGap(WHOLE_LIST), null);
  assert.equal(totalWithheld(WHOLE_LIST, walletHoldings(rows, new Map([[WETH, quotes.get(WETH)]]))), 'unanswered_prices', 'UFG never answered: the total would leave it out');
  // Changed on purpose (round 6): dust is valued now, so a list worth less than a cent in all has no "$0.00" headline.
  assert.equal(totalWithheld(WHOLE_LIST, walletHoldings([row(UFG, 'UFG', '1')], new Map([[UFG, quotes.get(UFG)]]))), 'nothing_valued', 'not a cent: no headline');
  assert.equal(totalWithheld(WHOLE_LIST, walletHoldings([row(UFG, 'UFG', '1')], new Map([[UFG, null]]))), 'nothing_valued', 'nothing priced: no headline');
});

test('the artwork resolver: one guarded tokens GET for a sorted, deduplicated batch; seeded artwork is served without a GET', async () => {
  const urls = [];
  const resolver = createTokenArtworkResolver({ now: () => 0, fetch: async (url, init) => {
    urls.push(url);
    assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer'); assert.equal(init.redirect, 'error');
    return new Response('[]', { headers: { 'content-type': 'application/json' } });
  } });
  assert.deepEqual(await resolver.tokenPrices([UFG, MANY.toUpperCase().replace('0X', '0x'), UFG, 'WETH']), []);
  assert.deepEqual(urls, [`https://api.dexscreener.com/tokens/v1/robinhood/${[MANY, UFG].join(',')}`]);
  assert.equal(await resolver.tokenPrices([]), null, 'nothing to ask: no GET');
  assert.equal(urls.length, 1);

  resolver.seed(4663, UFG, 'https://cdn.dexscreener.com/cms/images/abcdefghijklmnop');
  assert.equal(resolver.peek(4663, UFG), 'https://cdn.dexscreener.com/cms/images/abcdefghijklmnop?width=64&height=64&quality=85&format=auto');
  assert.equal(await resolver.resolve(4663, UFG), resolver.peek(4663, UFG));
  resolver.seed(4663, UFG, null);
  assert.ok(resolver.peek(4663, UFG), 'found artwork is never replaced by a none');
  resolver.seed(4663, MANY, 'https://127.0.0.1/logo.png');
  assert.equal(resolver.peek(4663, MANY), null, 'an unsafe image is none');
  assert.equal(resolver.peek(4663, addr(1)), undefined);
  assert.equal(urls.length, 1, 'seeded artwork asked nothing');
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
  assert.equal(totalWithheld(WHOLE_LIST, view), 'unanswered_prices', 'no total at old prices');
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
  assert.deepEqual(again.prices.get(UFG), { quote: { usd: '0.004', liquidityUsd: 165_000 }, at: T + HOUR + 500 });
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
