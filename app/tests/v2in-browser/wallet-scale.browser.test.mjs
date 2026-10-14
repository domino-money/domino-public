/**
 * The Positions Wallet card for wallets of any size, its DEX reads answered by our edge's real route code
 * (functions/_lib/dexEdge.ts behind the test server, tests/support/dex-edge-route.mjs), incident of 2026-10-13, package
 * D2, 2026-10-14.
 *
 * Reproduction first. Production, 2026-10-14 (public view of the owner's address, no wallet, data centre GRU), on the
 * code of 87c02d6c and again with D1 (35dd586f) deployed: "Wallet value unavailable." with data-wallet-prices="failed",
 * data-wallet-total-withheld="unanswered_prices", 63 held, 5 pages, "81 tokens listed · page 5 of up to 5", the top
 * three rows priced. The same browser had shown the total at 01:45 UTC with about as many tokens. What turns one into
 * the other is what this browser remembers: a token that had a qualified pool at the earlier visit and has none now
 * keeps that price as a hint for a day (lib/walletMemory.ts withAnswer, bookQuotes), the card counts it as unanswered
 * (lib/walletHoldings.ts walletHoldings) and one unanswered token withheld the whole total (totalWithheld). The
 * first case below is that, and fails on 87c02d6c and on 35dd586f; the second (51 tokens, nothing lost) passes there.
 *
 * Every case counts the price asks the load sent to our edge (`tokens/…`, ten tokens each at most) and checks that no
 * batch was asked twice.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { createReadStub } from '../support/read-stub.mjs';
import { createDirectChain } from '../support/v2-direct-chain.mjs';
import { activityOf, indexedToken, livePosition, portfolioOf } from '../support/s1-read6.mjs';
import { launchBrowser } from '../support/s1-browser.mjs';
import { openPositionPage } from '../support/position-v2-page.mjs';
import { closeBrowser } from '../support/close-browser.mjs';
import { createDexEdgeRoute, createDexUpstream, edgeOnInTestBuild } from '../support/dex-edge-route.mjs';
import { PONS, PONS_HOLDING, UFG, USDG, fillerAddress, rememberedWallet, scaleWallet, walletAssetsAnswer } from '../support/wallet-scale.mjs';

const require = createRequire(import.meta.url);
const position = require('../../.test-build/app/src/finance/position.js');
const ZERO = '0x0000000000000000000000000000000000000000';

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await closeBrowser(browser); });

/** The most price asks one load may send: one per ten of the PRICED_PER_LOAD (30) tokens it prices. */
const PRICE_GETS_PER_LOAD = 3;
/**
 * A first visit whose list is slower than the card's first paint (FIRST_PAINT_MS, 1.5 s; seen under machine load): its
 * first pages are priced at the paint and the next ones as they land, ten to an ask, never past 30 tokens nor any twice.
 * 63 held over 5 pages of 16: 13 + 13 + 4 tokens, 2 + 2 + 1 asks.
 */
const PRICE_GETS_SLOW_LIST = 5;
/** The provider's own path, should the page ask it directly (lib/tokenArtwork.ts, only when our edge answered no token). */
const DIRECT = /^https:\/\/api\.dexscreener\.com\/token-pairs\/v1\/robinhood\/(0x[0-9a-f]{40})$/i;

/** The card's state as the page shows it, for the assertions and for the message when one fails. */
const cardState = (page) => page.evaluate(() => {
  const card = document.querySelector('[data-portfolio-tokens]');
  if (!card) return null;
  const attrs = Object.fromEntries([...card.attributes].filter((a) => a.name.startsWith('data-wallet')).map((a) => [a.name, a.value]));
  return {
    attrs,
    total: card.querySelector('[data-wallet-total] .dm-fig-xl')?.textContent ?? null,
    unavailable: card.querySelector('[data-wallet-value-unavailable]') !== null,
    said: card.querySelector('[data-wallet-value-unavailable] .sr-only')?.textContent ?? null,
    note: card.querySelector('[data-wallet-total-note]')?.textContent ?? null,
    count: card.querySelector('.dm-acct-tokens-count')?.textContent ?? null,
    rows: [...card.querySelectorAll('[data-wallet-row]')].slice(0, 3).map((row) => [row.querySelector('.dm-acct-token-name')?.textContent, row.querySelector('[data-usd]')?.textContent ?? null]),
  };
});

/**
 * Opens the public view (#/portfolio/<address>, no wallet) of a wallet of `held` tokens with the page's DEX reads going
 * to our edge's real route code, from a clean browser or from what it remembers (`memory`, the card's own entry).
 */
async function openWallet({ held, zeros = 0, perPage, more = false, bigLate = false, late = [], upstream: upstreamOptions = {}, memory = null }) {
  const now = Math.floor(Date.now() / 1000);
  const chain = createDirectChain({ chainId: 4663, timestamp: now, v4: [] });
  const wallet = scaleWallet({ held, zeros, perPage, more, bigLate, late, now });
  const upstream = createDexUpstream({ pairsOf: (token) => wallet.pairs.get(token) ?? [], ...upstreamOptions });
  const edge = createDexEdgeRoute(upstream);
  const assets = [];
  const read = createReadStub({ reads: 'wallet-assets', answer: walletAssetsAnswer(wallet, (body) => assets.push(body)) });
  const read6 = { portfolio: portfolioOf({ wallet: chain.owner }), activity: activityOf({ wallet: chain.owner }) };
  const s = await openPositionPage(browser, chain, { hash: `#/portfolio/${chain.owner}`, read6, connect: false, routes: [edge.handle, read.handle] });
  // The first load ran on the test build's own resolver (no edge: every price straight to the provider). Leave it before
  // anything is counted, so none of its asks lands in this test's counts, then start over with production's resolver,
  // from a clean slate or from what this browser remembered, written before the page's code runs.
  await s.page.goto('about:blank');
  const rewrites = await edgeOnInTestBuild(s.context, s.origin);
  // The provider asked directly answers as the upstream double does (the same table, refusal and pace), counted apart.
  const direct = [];
  await s.context.route(DIRECT, async (route) => {
    direct.push(route.request().url());
    const answer = await upstream.answer(route.request().url());
    await route.fulfill({ status: answer.status, headers: Object.fromEntries(answer.headers), body: await answer.text() });
  });
  const kept = memory ? JSON.stringify(memory(chain.owner.toLowerCase(), wallet, now * 1000)) : null;
  await s.context.addInitScript((value) => {
    if (sessionStorage.getItem('wallet-scale-seeded')) return;
    sessionStorage.setItem('wallet-scale-seeded', '1');
    localStorage.clear();
    if (value) localStorage.setItem('domino-wallet-v2:4663', value);
  }, kept);
  const fresh = () => {
    edge.asked.length = 0;
    upstream.calls.length = 0;
    assets.length = 0;
    direct.length = 0;
  };
  fresh();
  await s.page.goto(`${s.origin}/#/portfolio/${chain.owner}`);
  assert.equal(rewrites.count, 1, 'the page’s DEX resolver is built as production builds it (our edge first)');
  return { s, page: s.page, chain, wallet, upstream, edge, assets, direct, rewrites, fresh };
}

/** Waits until the list is read to its end and no price is on its way, then a little longer for any late ask. */
async function settled(page, { quietMs = 1500, timeout = 30_000 } = {}) {
  try {
    await page.waitForFunction(() => {
      const card = document.querySelector('[data-portfolio-tokens]');
      return card && card.getAttribute('data-wallet-status') === 'ready' && card.getAttribute('data-wallet-source') === 'read'
        && card.getAttribute('data-wallet-prices') !== 'pending' && card.getAttribute('data-wallet-held') !== null
        && !card.querySelector('[data-wallet-more="reading"]');
    }, null, { timeout });
  } catch (error) {
    throw new Error(`the card did not settle: ${JSON.stringify(await cardState(page))}`, { cause: error });
  }
  await page.waitForTimeout(quietMs);
}

/** What one load cost and showed, as a line for the log and for every assertion's message. */
async function loadReport(w, label) {
  const state = await cardState(w.page);
  const asks = w.edge.priceAsks();
  const repeated = asks.length - new Set(asks.map((one) => `${one.path}:${one.tokens.join(',')}`)).size;
  const tokens = asks.flatMap((one) => one.tokens);
  const report = { state, directUrls: w.direct.map((url) => url.slice(-40)), priceGets: asks.length, asked: tokens.length, askedTwice: tokens.length - new Set(tokens).size, repeated, statuses: asks.map((one) => one.status), pairGets: w.edge.pairAsks().length, upstream: w.upstream.calls.length, direct: w.direct.length, walletAssets: w.assets.length };
  console.log(`[${label}] ${JSON.stringify(report)}`);
  return { ...report, text: JSON.stringify(report) };
}

/**
 * The total and the note of a load that priced the tokens it asked, within the per-load bound, asking no batch and no
 * token twice. `gets`: the most asks; a first visit's list may land after the first paint (PRICE_GETS_SLOW_LIST).
 */
function assertBoundedTotal(report, { held, total, priced, gets = PRICE_GETS_PER_LOAD }) {
  const { state, text } = report;
  assert.equal(state.unavailable, false, `the card says "${state.said}": ${text}`);
  assert.equal(state.total, total, `the total of the priced tokens: ${text}`);
  assert.equal(state.attrs['data-wallet-held'], String(held), text);
  assert.equal(state.attrs['data-wallet-priced'], String(priced), text);
  assert.equal(report.repeated, 0, `no price batch asked twice in one load: ${text}`);
  assert.equal(report.askedTwice, 0, `no token asked twice in one load: ${text}`);
  assert.ok(report.priceGets <= gets, `at most ${gets} price asks for a load: ${text}`);
  assert.ok(report.asked <= 30, `at most 30 tokens priced in a load: ${text}`);
  assert.equal(report.direct, 0, `nothing asked of the provider directly: ${text}`);
}

const HOURS = 3_600_000;

test('reproduction (production, 2026-10-14): 63 held tokens over 5 pages, remembered from a visit at which one of them still had a qualified pool, show their total', { timeout: 90_000 }, async () => {
  const w = await openWallet({ held: 63, zeros: 18, memory: (owner, wallet, now) => rememberedWallet(owner, wallet, now - 6.5 * HOURS, { lost: [fillerAddress(10)] }) });
  try {
    await settled(w.page);
    const report = await loadReport(w, 'reproduction 63');
    assert.equal(report.state.attrs['data-wallet-pages'], '5', report.text);
    assert.equal(report.state.count, '81 tokens listed · page 5 of up to 5', report.text);
    assert.deepEqual(report.state.rows, [['UFG', '$2,609.94'], ['AI', '$784.94'], ['SCORE', '$18.58']], report.text);
    assertBoundedTotal(report, { held: 63, total: '$3,421.98', priced: 15 });
    assert.equal(report.state.note, 'Total of priced tokens · 48 not priced', `the total says what it leaves out: ${report.text}`);
    assert.equal(report.state.attrs['data-wallet-total-withheld'], undefined, report.text);
    // The note is one quiet line under the figure, inside the total's own block, at every width; nothing else moves.
    const card = w.page.locator('[data-portfolio-tokens]');
    for (const width of [1180, 390, 320]) {
      await w.page.setViewportSize({ width, height: 960 });
      const layout = await card.evaluate((node) => {
        const figure = node.querySelector('[data-wallet-total] .dm-fig-xl').getBoundingClientRect();
        const note = node.querySelector('[data-wallet-total-note]').getBoundingClientRect();
        const total = node.querySelector('[data-wallet-total]').getBoundingClientRect();
        const firstRow = node.querySelector('[data-wallet-row]').getBoundingClientRect();
        return { below: note.top >= figure.bottom - 0.5, inside: note.bottom <= total.bottom + 0.5, beforeRows: total.bottom <= firstRow.top + 0.5, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.deepEqual(layout, { below: true, inside: true, beforeRows: true, overflow: false }, `the note at ${width}px`);
      const directory = resolve(process.env.DOMINO_POSITION_SHOTS ?? resolve(import.meta.dirname, '../../.test-artifacts'));
      mkdirSync(directory, { recursive: true });
      await card.screenshot({ path: join(directory, `wallet-scale-note-${width}.png`), animations: 'disabled' });
    }
  } finally { await w.s.close(); }
});

test('control (passes on the old code too): 51 held tokens over 5 pages, remembered from a visit at which nothing had a price it has lost, show their total', { timeout: 90_000 }, async () => {
  const w = await openWallet({ held: 51, zeros: 14, perPage: 13, memory: (owner, wallet, now) => rememberedWallet(owner, wallet, now - 6.5 * HOURS) });
  try {
    await settled(w.page);
    const report = await loadReport(w, 'control 51');
    assert.equal(report.state.attrs['data-wallet-pages'], '5', report.text);
    assert.equal(report.state.unavailable, false, report.text);
    assert.equal(report.state.total, '$3,421.98', report.text);
  } finally { await w.s.close(); }
});

for (const [held, zeros, perPage, priced, unpriced, total] of [[5, 0, 16, 5, 0, '$3,421.96'], [51, 14, 13, 15, 36, '$3,421.98'], [63, 18, 16, 15, 48, '$3,421.98']]) {
  test(`a first visit, ${held} held tokens: the total of the priced tokens, at most ${PRICE_GETS_PER_LOAD} price asks (${PRICE_GETS_SLOW_LIST} if the list is slow), none twice`, { timeout: 90_000 }, async () => {
    const w = await openWallet({ held, zeros, perPage });
    try {
      await settled(w.page);
      const report = await loadReport(w, `first visit ${held}`);
      assertBoundedTotal(report, { held, total, priced, gets: PRICE_GETS_SLOW_LIST });
      assert.equal(report.state.note, unpriced === 0 ? null : `Total of priced tokens · ${unpriced} not priced`, `the note, only when the total leaves tokens out: ${report.text}`);
      if (held === 5) assert.equal(report.priceGets, 1, `five tokens, one ask: ${report.text}`);
    } finally { await w.s.close(); }
  });
}

test('a wallet of 700 tokens (a list longer than the card reads): the total of the priced tokens, the same few asks as 30 tokens', { timeout: 90_000 }, async () => {
  const w = await openWallet({ held: 700, perPage: 20, more: true });
  try {
    await settled(w.page);
    const report = await loadReport(w, 'first visit 700');
    assert.equal(report.state.attrs['data-wallet-capped'], '', `read to the card's page cap: ${report.text}`);
    // 5 pages of 20 tokens and native ETH: 101 held; priced: USDG, ETH, UFG, AI, SCORE and the ten dust tokens.
    assertBoundedTotal(report, { held: 101, total: '$3,421.98', priced: 15, gets: PRICE_GETS_SLOW_LIST });
    assert.equal(report.state.note, 'Total of priced tokens · 86 not priced · more not listed', report.text);
    assert.ok(report.upstream <= 31, `our edge asked the provider for no more than the tokens priced: ${report.text}`);
  } finally { await w.s.close(); }
});

test('Show all prices the rest a page at a time; the next load prices the largest holdings first, within the bound', { timeout: 120_000 }, async () => {
  // UFG, the largest holding, is listed after the first 30 held tokens: a first load does not reach it.
  const w = await openWallet({ held: 63, zeros: 18, bigLate: true });
  try {
    await settled(w.page);
    const first = await loadReport(w, 'big late, first load');
    assertBoundedTotal(first, { held: 63, total: '$812.04', priced: 14, gets: PRICE_GETS_SLOW_LIST });
    assert.equal(first.state.note, 'Total of priced tokens · 49 not priced', first.text);
    const card = w.page.locator('[data-portfolio-tokens]');
    await card.locator('[data-wallet-show-all]').click();
    await w.page.waitForFunction(() => document.querySelector('[data-portfolio-tokens]')?.getAttribute('data-wallet-asked') === '62', null, { timeout: 30_000 });
    await settled(w.page);
    const opened = await loadReport(w, 'big late, Show all');
    assert.equal(opened.state.total, '$3,421.98', `Show all priced UFG: ${opened.text}`);
    assert.equal(opened.repeated, 0, `no batch twice: ${opened.text}`);
    assert.ok(opened.priceGets <= 7, `three pages of at most 30, ten to an ask: ${opened.text}`);
    w.fresh();
    await w.page.reload();
    await settled(w.page);
    const next = await loadReport(w, 'big late, next load');
    assertBoundedTotal(next, { held: 63, total: '$3,421.98', priced: 15 });
    assert.equal(next.state.rows[0][0], 'UFG', next.text);
  } finally { await w.s.close(); }
});

// Review of D2 (2026-10-14), its blocking finding: once a load's ask held its 30 tokens it took no other in, so a token
// of Domino's own that the wallet started holding after the ask filled was never priced in that load. A returning
// visitor's remembered list (40 held) fills the ask at once; the list now also holds 1,000 PONS (a selected pool's token,
// $1 in a $50,000 pool) on its last page. On 6156544a: data-wallet-asked 30, PONS never asked, "$3,421.98" with "26 not
// priced". On 87c02d6c (every held token asked, up to 120): PONS priced, $4,421.98. Domino's own held tokens (WETH and
// the selected pools', six today at most) are now asked past the bound: one more ask, for PONS alone.
for (const hours of [0.5, 3]) {
  test(`a returning visitor (remembered ${hours} h ago) now holding a selected pool's token on the list's last page: that token is priced past the bound`, { timeout: 90_000 }, async () => {
    const w = await openWallet({ held: 40, late: [PONS_HOLDING], memory: (owner, wallet, now) => rememberedWallet(owner, wallet, now - hours * HOURS, { without: [PONS] }) });
    try {
      await settled(w.page);
      const report = await loadReport(w, `returning ${hours} h, PONS late`);
      const ponsAsks = w.edge.priceAsks().filter((one) => one.tokens.includes(PONS));
      assert.equal(ponsAsks.length, 1, `PONS asked once: ${report.text}`);
      assert.deepEqual(ponsAsks[0].tokens, [PONS], `on its own, once its page named it: ${report.text}`);
      assert.equal(report.state.attrs['data-wallet-asked'], '31', `the load's 30, and PONS past the bound: ${report.text}`);
      assert.equal(report.state.unavailable, false, report.text);
      assert.deepEqual(report.state.rows, [['UFG', '$2,609.94'], ['PONS', '$1,000.00'], ['AI', '$784.94']], report.text);
      assert.equal(report.state.total, '$4,421.98', `PONS counted: ${report.text}`);
      assert.equal(report.state.note, 'Total of priced tokens · 25 not priced', report.text);
      assert.equal(report.state.attrs['data-wallet-held'], '41', report.text);
      assert.equal(report.state.attrs['data-wallet-priced'], '16', report.text);
      assert.equal(report.repeated, 0, `no price batch asked twice in one load: ${report.text}`);
      assert.ok(report.priceGets <= PRICE_GETS_PER_LOAD + 1, `the load's asks, and one for PONS: ${report.text}`);
      assert.ok(report.asked <= 31, `the load's 30 tokens, and PONS: ${report.text}`);
      assert.equal(report.direct, 0, `nothing asked of the provider directly: ${report.text}`);
    } finally { await w.s.close(); }
  });
}

// The same finding on a card already on screen: its ask full, the read that follows a confirmed action (here a bulk
// close on Positions) names a selected pool's token the wallet did not hold. On 6156544a it stayed unpriced until "Show
// all" or a remount: the load's ask survives the confirmed action's re-read.
test('a card already on screen, its ask full: a selected pool’s token named by the read after a confirmed close is priced', { timeout: 120_000 }, async () => {
  const now = Math.floor(Date.now() / 1000);
  const pool = { dex: 4, currency0: ZERO, currency1: USDG, fee: 500, tickSpacing: 10, hooks: ZERO };
  const range = { tickLower: -201060, tickUpper: -197040 };
  const tick = -199020, sqrtPriceX96 = position.sqrtPriceAtTick(tick), liquidity = 10n ** 15n;
  const v4 = [601001n, 601002n].map((tokenId) => ({ tokenId, pool, ...range, liquidity, sqrtPriceX96, tick, growthLast: [0n, 0n], growthNow: [0n, 0n] }));
  const chain = createDirectChain({ chainId: 4663, timestamp: now, v4 });
  const read6 = { portfolio: portfolioOf({ wallet: chain.owner,
    positions: v4.map((one) => livePosition({ chainId: 4663, manager: chain.at.v4PositionManager, tokenId: one.tokenId, owner: chain.owner, pool, ...range, liquidity, sqrtPriceX96, tick })),
    tokens: [indexedToken(4663, ZERO, 'ETH', 18), indexedToken(4663, USDG, 'USDG', 6)] }), activity: activityOf({ wallet: chain.owner }) };
  // 40 held before the close; after it (from the receipt's block, 0x3000), the same and 1,000 PONS on the last page.
  const beforeClose = scaleWallet({ held: 40, now });
  const afterClose = scaleWallet({ held: 40, late: [PONS_HOLDING], firstBlock: 0x3000, now });
  const upstream = createDexUpstream({ pairsOf: (token) => afterClose.pairs.get(token) ?? [] });
  const edge = createDexEdgeRoute(upstream);
  const read = createReadStub({ reads: 'wallet-assets', answer: walletAssetsAnswer({ pages: { get: (cursor) => (chain.sends.length === 0 ? beforeClose : afterClose).pages.get(cursor) } }) });
  const s = await openPositionPage(browser, chain, { hash: '#/positions', read6, routes: [edge.handle, read.handle], s1: { directCode: { 4663: chain.codeHashes } } });
  try {
    // As openWallet: production's DEX resolver from the next load, and nothing this browser remembered of the card.
    const rewrites = await edgeOnInTestBuild(s.context, s.origin);
    await s.context.route(DIRECT, async (route) => {
      const answer = await upstream.answer(route.request().url());
      await route.fulfill({ status: answer.status, headers: Object.fromEntries(answer.headers), body: await answer.text() });
    });
    await s.context.addInitScript(() => {
      if (sessionStorage.getItem('wallet-scale-seeded')) return;
      sessionStorage.setItem('wallet-scale-seeded', '1');
      localStorage.removeItem('domino-wallet-v2:4663');
    });
    edge.asked.length = 0;
    await s.page.reload();
    assert.equal(rewrites.count, 1, 'the page’s DEX resolver is built as production builds it (our edge first)');
    const { page } = s;
    const card = page.locator('[data-portfolio-tokens]');
    await settled(page);
    const first = await cardState(page);
    assert.deepEqual([first.attrs['data-wallet-held'], first.attrs['data-wallet-asked'], first.total], ['40', '30', '$3,421.98'], `the load's ask is full: ${JSON.stringify(first)}`);
    const asksBefore = edge.priceAsks().length;

    await page.locator('[data-bulk-close-open]').click();
    const dialog = page.locator('[data-bulk-close]');
    for (const choice of await dialog.getByRole('checkbox').all()) await choice.check();
    await dialog.getByRole('button', { name: 'Review 2 positions', exact: true }).click();
    await page.locator('[data-bulk-close="review"]').waitFor();
    await dialog.getByRole('button', { name: 'Close 2 positions', exact: true }).click();
    await page.locator('[data-bulk-close="done"]').waitFor();
    // The read after the receipt has landed (41 held), whether PONS is priced or not (unpriced, it sits behind Show all).
    await page.waitForFunction(() => document.querySelector('[data-portfolio-tokens]')?.getAttribute('data-wallet-held') === '41', null, { timeout: 30_000 });
    await settled(page);
    const state = await cardState(page);
    const ponsAsks = edge.priceAsks().filter((one) => one.tokens.includes(PONS));
    const text = JSON.stringify({ state, asks: edge.priceAsks().map((one) => one.tokens.length) });
    console.log(`[confirmed close, PONS after] ${text}`);
    assert.deepEqual(state.rows, [['UFG', '$2,609.94'], ['PONS', '$1,000.00'], ['AI', '$784.94']], `PONS priced, in the top three: ${text}`);
    assert.equal(state.total, '$4,421.98', `PONS counted: ${text}`);
    assert.equal(state.note, 'Total of priced tokens · 25 not priced', text);
    assert.equal(state.attrs['data-wallet-asked'], '31', `the load's 30, and PONS past the bound: ${text}`);
    assert.equal(ponsAsks.length, 1, `PONS asked once: ${text}`);
    assert.deepEqual(ponsAsks[0].tokens, [PONS], `on its own: ${text}`);
    assert.equal(edge.priceAsks().length, asksBefore + 1, `the close cost one price ask, for PONS: ${text}`);
    assert.equal(chain.sends.length, 1, 'only the fake close transaction was sent');
  } finally { await s.close(); }
});

test('leaving Positions and coming back while the prices are on their way asks no batch twice, and the total shows', { timeout: 90_000 }, async () => {
  const w = await openWallet({ held: 63, zeros: 18, upstream: { delayMs: 900 }, memory: (owner, wallet, now) => rememberedWallet(owner, wallet, now - 6.5 * HOURS) });
  try {
    // The remembered list asks its prices at once; leave while they are on their way, twice, then stay.
    await w.page.waitForFunction(() => document.querySelector('[data-portfolio-tokens]')?.getAttribute('data-wallet-prices') === 'pending');
    for (let i = 0; i < 2; i++) {
      await w.page.evaluate(() => { location.hash = '#/'; });
      await w.page.locator('[data-portfolio-tokens]').waitFor({ state: 'detached' });
      await w.page.waitForTimeout(150);
      await w.page.evaluate((hash) => { location.hash = hash; }, `#/portfolio/${w.chain.owner}`);
      await w.page.locator('[data-portfolio-tokens]').waitFor();
    }
    await settled(w.page, { quietMs: 3000 });
    const report = await loadReport(w, 'leave and return');
    assertBoundedTotal(report, { held: 63, total: '$3,421.98', priced: 15 });
  } finally { await w.s.close(); }
});

test('a provider that refuses: remembered prices of the last hour still make the total, a cold visit totals what it can, and nothing is asked again', { timeout: 120_000 }, async () => {
  const refuse = { status: 429, retryAfter: 60 };
  const warm = await openWallet({ held: 63, zeros: 18, upstream: { refuse }, memory: (owner, wallet, now) => rememberedWallet(owner, wallet, now - 10 * 60_000) });
  try {
    await settled(warm.page);
    const report = await loadReport(warm, 'refused, remembered 10 min ago');
    assert.equal(report.state.unavailable, false, report.text);
    assert.equal(report.state.total, '$3,421.98', `prices of the last hour still count: ${report.text}`);
    assert.equal(report.repeated, 0, report.text);
    assert.ok(report.priceGets <= PRICE_GETS_PER_LOAD, report.text);
    // D1's direct path, taken only when our edge priced no token at all (a decision of its own, D4/D7), stops at the
    // provider's first refusal: its two lanes and one visible mark already on their way at most.
    assert.ok(report.direct <= 3, `the provider's refusal is kept to, not gone around: ${report.text}`);
  } finally { await warm.s.close(); }
  const cold = await openWallet({ held: 63, zeros: 18, upstream: { refuse } });
  try {
    await settled(cold.page);
    const report = await loadReport(cold, 'refused, first visit');
    assert.equal(report.state.unavailable, false, `USDG is $1 without asking: ${report.text}`);
    assert.equal(report.state.total, '$0.50', report.text);
    assert.equal(report.state.note, 'Total of priced tokens · 62 not priced', report.text);
    assert.equal(report.repeated, 0, report.text);
    assert.ok(report.priceGets <= PRICE_GETS_PER_LOAD, report.text);
    // D1's direct path, taken only when our edge priced no token at all (a decision of its own, D4/D7), stops at the
    // provider's first refusal: its two lanes and one visible mark already on their way at most.
    assert.ok(report.direct <= 3, `the provider's refusal is kept to, not gone around: ${report.text}`);
  } finally { await cold.s.close(); }
});

test('a slow provider: the total of what answered in time, the rest not asked again in this load, and the next load priced from our edge', { timeout: 120_000 }, async () => {
  // Our edge asks six tokens at a time and answers each ask after 2.5 s: at 1.6 s a token, six of ten answer in time.
  const w = await openWallet({ held: 63, zeros: 18, upstream: { delayMs: 1600 } });
  try {
    await settled(w.page, { quietMs: 4000, timeout: 60_000 });
    const first = await loadReport(w, 'slow, first load');
    assert.equal(first.state.unavailable, false, first.text);
    assert.notEqual(first.state.total, null, first.text);
    assert.equal(first.repeated, 0, first.text);
    assert.equal(first.askedTwice, 0, first.text);
    assert.ok(first.priceGets <= PRICE_GETS_SLOW_LIST, first.text);
    assert.equal(first.direct, 0, `tokens answered late are not asked of the provider directly: ${first.text}`);
    // The late reads went on behind at our edge and were kept: the next load is priced from them.
    await w.edge.settle();
    w.fresh();
    await w.page.reload();
    await settled(w.page, { quietMs: 2000 });
    const next = await loadReport(w, 'slow, next load');
    assertBoundedTotal(next, { held: 63, total: '$3,421.98', priced: 15 });
  } finally { await w.s.close(); }
});

test('UFG is priced by our edge from the provider’s pairs, as the owner’s card shows it', { timeout: 60_000 }, async () => {
  const w = await openWallet({ held: 5 });
  try {
    await settled(w.page);
    const ufg = w.page.locator(`[data-wallet-row="${UFG}"] [data-usd]`);
    assert.equal(await ufg.textContent(), '$2,609.94');
    assert.match(await ufg.getAttribute('title'), /DEX Screener/);
  } finally { await w.s.close(); }
});
