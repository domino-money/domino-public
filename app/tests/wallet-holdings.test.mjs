// Added 2026-09-25 (owner: the Positions Wallet card lists only the main tokens, largest first, by USD value, "if that
// doesn't cause too much load"): the card's prices (one provider GET per page view at most, memory only) and what it
// shows of a wallet's list (lib/walletPrices.ts, lib/walletHoldings.ts), and the artwork resolver's batch GET and seed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { MIN_LIQUIDITY_USD, NATIVE, PRICE_TTL_MS, USDG, WETH, createWalletPrices, quotesFromTokens } = require('../.test-build/app/src/lib/walletPrices.js');
const { SHOWN_HOLDINGS, addressesToPrice, isLookAlike, symbolReading, totalWithheld, usdValue, walletHoldings } = require('../.test-build/app/src/lib/walletHoldings.js');
const { PRICE_BATCH, createTokenArtworkResolver } = require('../.test-build/app/src/lib/tokenArtwork.js');

const UFG = '0xefab538cf3c29237a47c6afb145d50ddf204a0a3';
const MANY = '0xa26992c4268a8a78a4d872fe4bdad2ed03ac287d';
const PONS = '0x39dbed3a2bd333467115de45665cc57f813c4571';
const FAKE_PONS = '0x7859f341c798189a1da859947a6eec82d414cdaa';
const FAKE_USDG = '0x3c261bf9087b11bd30861881492ed02e9ad1c7de';
const MARLIN = '0xab35d04e1ee39c789c4a65d522417b3c7f2e4723';
const CBBTC = '0xcec185eb182c47d1ba1efc84e6959e18cd620be4';
const U = '0xce24439f2d9c6a2289f741120fe202248b666666';
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
  assert.deepEqual(seeded, [[WETH, null], [UFG, 'https://cdn.dexscreener.com/cms/images/abcdefghijklmnop?width=64&height=64&quality=85&format=auto']], 'the reply’s artwork goes to the resolver: none for WETH, the one image for UFG');

  now = PRICE_TTL_MS - 1;
  await prices.price([UFG, NATIVE]);
  assert.equal(asked.length, 1, 'kept in memory for the visit: no second GET');

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

  const onlyUsdg = await prices.price([USDG]);
  assert.equal(asked.length, 3, 'USDG alone asks nothing');
  assert.equal(onlyUsdg.quotes.get(USDG).usd, '1');

  const many = Array.from({ length: 45 }, (_, i) => addr(i + 100));
  await prices.price(many);
  assert.equal(asked.at(-1).length, PRICE_BATCH, 'one GET names at most 30 addresses, the most important first');
  assert.deepEqual(asked.at(-1), many.slice(0, 30));
});

test('values: raw × price in exact 10^-18 dollars, rounded down', () => {
  // 1,161,237.362251642889718091 UFG at $0.002975 = $3,454.681152698637596911 (the last digits dropped, never rounded up).
  assert.equal(usdValue('1161237362251642889718091', 18, { usd: '0.002975', liquidityUsd: 1 }), 3454681152698637596911n);
  assert.equal(usdValue('5626125', 6, { usd: '1', liquidityUsd: null }), 5626125000000000000n);
  assert.equal(usdValue('1', null, { usd: '1', liquidityUsd: null }), null);
  assert.equal(usdValue('12.5', 6, { usd: '1', liquidityUsd: null }), null);
});

test('the card: the five largest holdings worth $1 or more, the rest behind Show N more, a total of them all', () => {
  const quotes = new Map([
    [WETH, { usd: '2692.60', liquidityUsd: 19_361_293 }],
    [UFG, { usd: '0.002975', liquidityUsd: 165_672 }],
    [MANY, { usd: '0.0022', liquidityUsd: 50_000 }],
    [addr(1), { usd: '0.5', liquidityUsd: 1e6 }],
    [addr(2), { usd: '3', liquidityUsd: 1e6 }],
    [addr(3), { usd: '0.001', liquidityUsd: 1e6 }], // dust
    [addr(4), { usd: '10', liquidityUsd: 12_000 }], // worth more than its pair
    [addr(5), { usd: '2', liquidityUsd: 1e6 }],
    [FAKE_PONS, { usd: '5', liquidityUsd: 1e6 }], // a look-alike, priced or not
    [FAKE_USDG, { usd: '1', liquidityUsd: 1e6 }],
  ]);
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
    { ...row(addr(8), 'RAW', '5'), amount: { label: 'Balance', text: '5 (raw units, decimals unknown)', state: 'raw' } },
  ];
  const view = walletHoldings(rows, quotes);
  assert.equal(view.mode, 'values');
  const symbols = (list) => list.map((h) => h.row.token.symbol);
  assert.deepEqual(symbols(view.shown), ['UFG', 'MANY', 'ETH', 'USDG', 'TWO']);
  assert.equal(view.shown.length, SHOWN_HOLDINGS);
  assert.deepEqual(symbols(view.rest), ['ONE', 'TWO'], '$2.00 and $1.20, behind Show N more');
  assert.deepEqual(view.shown.concat(view.rest).filter((h) => h.twin).map((h) => h.row.token.address), [addr(2), addr(5)], 'two contracts both called TWO are named by their addresses');
  assert.equal(view.total, view.shown.concat(view.rest).reduce((sum, h) => sum + h.value, 0n));
  assert.ok(view.total > 4000n * ONE && view.total < 5000n * ONE, `total ${view.total}`);
  assert.equal(view.shown.find((h) => h.row.token.symbol === 'USDG').row.token.address, USDG, 'only the real USDG');
  assert.ok(!view.shown.concat(view.rest).some((h) => [addr(3), addr(4), addr(6), addr(7), addr(8), FAKE_PONS, FAKE_USDG].includes(h.row.token.address)), 'no dust, no unpriced, no zero, no raw, no look-alike, nothing worth more than its pair');
  assert.equal(view.unanswered, 1, 'NOPRICE was never answered (not in the quotes at all); USDG, a look-alike, a zero and a raw balance need no answer');
  assert.equal(walletHoldings(rows, new Map([...quotes, [addr(6), null]])).unanswered, 0, 'answered as unpriced is an answer');
  assert.equal(walletHoldings([row(NATIVE, 'ETH', '1')], new Map()).unanswered, 1, 'native ETH waits for WETH’s answer');
});

test('without prices: native ETH, WETH and USDG only, by their exact addresses, with amounts', () => {
  const rows = [row(UFG, 'UFG', '1000'), row(USDG, 'USDG', '5', 6), row(FAKE_USDG, 'USDG', '50'), row(WETH, 'WETH', '0.5'), row(NATIVE, 'ETH', '0.01'), row(PONS, 'PONS', '0', 18, 'zero')];
  const view = walletHoldings(rows, null);
  assert.equal(view.mode, 'amounts');
  assert.deepEqual(view.shown.map((h) => [h.row.token.address, h.value]), [[NATIVE, null], [WETH, null], [USDG, null]]);
  assert.deepEqual(walletHoldings([row(UFG, 'UFG', '1000')], null).shown, [], 'nothing main held: nothing shown');
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
  for (const [address, symbol] of [[FAKE_PONS, 'P0NS'], [FAKE_USDG, 'USDG'], [addr(9), `PO${zwsp}NS`], [addr(10), 'WETH'], [addr(11), 'eth'], [addr(12), 'U']]) assert.equal(isLookAlike(row(address, symbol, '1')), true, symbol);
  for (const [address, symbol] of [[PONS, 'PONS'], [USDG, 'USDG'], [WETH, 'WETH'], [NATIVE, 'ETH'], [WETH, 'ETH'], [UFG, 'UFG'], [addr(13), null]]) assert.equal(isLookAlike(row(address, symbol, '1')), false, String(symbol));
});

test('what is priced: only what the wallet holds, WETH and the held selected-pool tokens first, at most one GET’s worth', () => {
  assert.deepEqual(addressesToPrice([]), []);
  assert.deepEqual(addressesToPrice([row(USDG, 'USDG', '5', 6), row(UFG, 'UFG', '0', 18, 'zero')]), [], 'USDG is $1 and a zero balance needs no price');
  // Changed on purpose (review of 2026-09-25): selected-pool tokens the wallet does not hold are no longer asked for, and neither is a look-alike.
  const asked = addressesToPrice([row(NATIVE, 'ETH', '1'), row(USDG, 'USDG', '5', 6), row(UFG, 'UFG', '10'), row(MANY, 'MANY', '0', 18, 'zero'), row(PONS, 'PONS', '3'), row(FAKE_PONS, 'P0NS', '5'), row(FAKE_USDG, 'USDG', '50')]);
  assert.deepEqual(asked, [WETH, PONS, UFG], 'WETH for native ETH, then the held selected-pool token, then the rest in list order');
  for (const absent of [USDG, NATIVE, MANY, MARLIN, CBBTC, U, FAKE_PONS, FAKE_USDG]) assert.ok(!asked.includes(absent), absent);
  assert.deepEqual(addressesToPrice([row(WETH, 'WETH', '1'), row(NATIVE, 'ETH', '0', 18, 'zero')]), [WETH], 'WETH held alone is asked once');
  const many = Array.from({ length: 45 }, (_, i) => row(addr(i + 100), `T${i}`, '1'));
  const capped = addressesToPrice([row(NATIVE, 'ETH', '1'), ...many, row(MARLIN, 'MARLIN', '2')]);
  assert.equal(capped.length, PRICE_BATCH, 'one GET’s worth: the rest go unanswered, and the card withholds its total');
  assert.deepEqual(capped.slice(0, 3), [WETH, MARLIN, addr(100)], 'the main tokens the wallet holds come first, wherever the list has them');
  const view = walletHoldings([row(NATIVE, 'ETH', '1'), ...many, row(MARLIN, 'MARLIN', '2')], new Map(capped.map((address) => [address, null])));
  assert.equal(view.unanswered, 45 + 2 - PRICE_BATCH, 'what the one GET could not name is counted as unanswered');
});

test('the total stands for the wallet only when the list is whole: every page, every balance, every held token answered', () => {
  const quotes = new Map([[WETH, { usd: '2000', liquidityUsd: 1e7 }], [UFG, { usd: '0.003', liquidityUsd: 165_000 }]]);
  const rows = [row(NATIVE, 'ETH', '0.01'), row(USDG, 'USDG', '5.5', 6), row(UFG, 'UFG', '1000000')];
  const whole = { reading: false, morePages: false, capped: false, failed: false, unread: 0, earlier: false, skipped: 0, pricing: false };
  const values = walletHoldings(rows, quotes);
  assert.equal(totalWithheld(whole, values), null, 'whole: the total is shown');
  const cases = [
    [{ reading: true }, 'reading'],
    [{ failed: true }, 'read_failed'],
    [{ morePages: true }, 'more_pages'],
    [{ capped: true }, 'capped'],
    [{ unread: 1 }, 'unread_balances'],
    [{ earlier: true }, 'earlier_rows'],
    [{ skipped: 7 }, 'skipped_candidates'],
    [{ pricing: true }, 'pricing'],
  ];
  for (const [change, reason] of cases) assert.equal(totalWithheld({ ...whole, ...change }, values), reason, reason);
  assert.equal(totalWithheld(whole, walletHoldings(rows, new Map([[WETH, quotes.get(WETH)]]))), 'unanswered_prices', 'UFG never answered: the total would leave it out');
  assert.equal(totalWithheld(whole, walletHoldings(rows, null)), 'no_prices', 'amounts only: no total');
  assert.equal(totalWithheld(whole, walletHoldings([row(UFG, 'UFG', '1')], new Map([[UFG, quotes.get(UFG)]]))), 'nothing_valued', 'nothing worth a dollar: no $0.00 headline');
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

test('the card asks its prices through the artwork client only, and keeps nothing in the browser', () => {
  for (const file of ['src/lib/walletPrices.ts', 'src/lib/walletHoldings.ts', 'src/components/portfolio/PortfolioTokens.tsx']) {
    const code = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(code, /\bfetch\(|XMLHttpRequest|localStorage|sessionStorage|indexedDB/, file);
  }
});
