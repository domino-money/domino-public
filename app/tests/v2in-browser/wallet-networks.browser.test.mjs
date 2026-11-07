/**
 * The Positions Wallet card with the wallet's tokens on Base and Arbitrum One (R-07, 2026-11-06; the owner's replica rule:
 * those networks show what Robinhood Chain shows, only the network changes), on wallet-test-v2 with read-v6's
 * chain-balances scripted (tests/support/wallet-networks.mjs, every answer the contract's): one list and one figure, each
 * row naming its network once there is more than one, the other networks' tokens linked to their pools on Markets, one
 * read asking exactly the networks' own currencies and the tokens of the wallet's positions there; and nothing of theirs
 * (the card exactly Robinhood Chain's) when they hold nothing, or when a network could not be read.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { createReadStub } from '../support/read-stub.mjs';
import { createDirectChain } from '../support/v2-direct-chain.mjs';
import { activityOf, indexedToken, portfolioOf } from '../support/s1-read6.mjs';
import { launchBrowser } from '../support/s1-browser.mjs';
import { openPositionPage } from '../support/position-v2-page.mjs';
import { closeBrowser } from '../support/close-browser.mjs';
import { ZERO, walletBalancesAnswer } from '../support/wallet-networks.mjs';

const require = createRequire(import.meta.url);
const model = require('../../.test-build/app/src/v2in/walletNetworks/model.js');
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const AERO = '0x940181a94a35a4569e4529a3cdfb74e38fd98631';
const ARB_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../api-contracts/read-v1/fixtures/gateway/wallet-assets.last-page.json'), 'utf8'));
const SHOTS = process.env.DOMINO_SHOTS ?? null;

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await closeBrowser(browser); });

/** Robinhood Chain's list: 1 USDG ($1, never asked for a price), or nothing held (`empty`), or `usdgRaw` USDG. */
function walletAnswer(now, empty = false, usdgRaw = '1000000') {
  const body = structuredClone(fixture);
  body.snapshot.timestamp = now;
  body.inventory.retrievedAt = now;
  body.items[1] = { ...body.items[1], address: USDG, symbol: 'USDG', decimals: 6, amountRaw: empty ? '0' : usdgRaw };
  return JSON.stringify(body);
}

/**
 * Positions with the connected wallet, Robinhood Chain's list from the read stub and chain-balances from `balances`
 * (the options of walletBalancesAnswer), each request recorded in `asked`.
 */
async function openCard({ balances = {}, tokens = [], delayMs = 0, robinhoodEmpty = false, usdgRaw } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const chain = createDirectChain({ chainId: 4663, timestamp: now, v4: [] });
  const portfolio = portfolioOf({ wallet: chain.owner, tokens });
  const read6 = { portfolio, activity: activityOf({ wallet: chain.owner }) };
  const read = createReadStub({ reads: 'wallet-assets', answer: (route) => (route === 'wallet-assets' ? walletAnswer(now, robinhoodEmpty, usdgRaw) : undefined) });
  const asked = [];
  const s = await openPositionPage(browser, chain, {
    hash: '#/positions', read6, routes: [read.handle], s1: { directCode: { 4663: chain.codeHashes } },
    prepare: async (context) => {
      await context.exposeFunction('__walletNetworksRead', async (request) => {
        asked.push(request);
        if (delayMs > 0) await new Promise((done) => setTimeout(done, delayMs));
        return { status: 200, body: walletBalancesAnswer(request, balances) };
      });
      // After the page support's own script: chain-balances answered as asked, so the route is named as serving it. And every
      // figure the card's total shows, in order (`window.__walletTotals`).
      await context.addInitScript(() => {
        window.__dominoV2Test.read6['chain-balances'] = (request) => window.__walletNetworksRead(request);
        const totals = window.__walletTotals = [];
        new MutationObserver(() => {
          const text = document.querySelector('[data-portfolio-tokens] [data-wallet-total] .dm-fig-xl')?.textContent ?? null;
          if (text && totals.at(-1) !== text) totals.push(text);
        }).observe(document, { childList: true, subtree: true, characterData: true });
      });
    },
  });
  return { s, chain, asked, portfolio: portfolio.body };
}

/**
 * Each row's sub-line as drawn (added 2026-11-06, review UI-1): whether its amount and its network are whole (nothing cut
 * by an ellipsis), whether it fits one line, and whether it stays clear of the row's value; and whether the page overflows.
 */
const layoutOf = (page) => page.evaluate(() => ({
  overflow: document.documentElement.scrollWidth > innerWidth,
  rows: [...document.querySelectorAll('[data-portfolio-tokens] [data-wallet-row]')].map((row) => {
    const sub = row.querySelector('.dm-acct-token-sub');
    const units = row.querySelector('.dm-acct-token-units');
    const network = row.querySelector('.dm-acct-token-network');
    const usd = row.querySelector('.dm-acct-token-usd').getBoundingClientRect();
    return {
      units: units.textContent,
      whole: units.scrollWidth <= units.clientWidth && (!network || network.scrollWidth <= network.clientWidth + 0.5),
      oneLine: sub.getBoundingClientRect().height <= parseFloat(getComputedStyle(sub).lineHeight) + 0.5,
      clear: sub.getBoundingClientRect().right <= usd.left + 0.5,
    };
  }),
}));

const rowsOf = (page) => page.evaluate(() => [...document.querySelectorAll('[data-portfolio-tokens] [data-wallet-row]')].map((row) => ({
  token: row.getAttribute('data-wallet-row'),
  chain: row.getAttribute('data-wallet-row-chain'),
  name: row.querySelector('.dm-acct-token-name')?.textContent ?? null,
  href: row.querySelector('a.dm-acct-token-name')?.getAttribute('href') ?? null,
  units: row.querySelector('.dm-acct-token-units')?.textContent ?? null,
  network: row.querySelector('.dm-acct-token-network')?.textContent ?? null,
  usd: row.querySelector('[data-usd]')?.textContent ?? null,
  usdTitle: row.querySelector('[data-usd]')?.getAttribute('title') ?? null,
})));

test('Base and Arbitrum One tokens join the Wallet card: one list by value, each row with its network, one total', { timeout: 90_000 }, async () => {
  const tokens = [indexedToken(8453, AERO, 'AERO', 18)];
  const { s, chain, asked, portfolio } = await openCard({
    tokens,
    // The read lands after Robinhood Chain's own figure is ready: the card's first figure still waits for it.
    delayMs: 1200,
    balances: {
      held: { [`8453:${ZERO}`]: 5n * 10n ** 17n, [`8453:${AERO}`]: 3n * 10n ** 18n, [`42161:${ARB_USDC}`]: 25_500000n },
      pools: { [`8453:${AERO}`]: '1.250000000000000000' },
      meta: { [`8453:${AERO}`]: { symbol: 'AERO', decimals: 18 } },
    },
  });
  try {
    const { page } = s;
    const card = page.locator('[data-portfolio-tokens]');
    await page.waitForFunction(() => document.querySelector('[data-portfolio-tokens]')?.getAttribute('data-wallet-networks-held') === '3' && document.querySelector('[data-wallet-total]'));
    // One read, asking each network's own currencies and the token of the wallet's position on Base.
    assert.equal(asked.length, 1, 'one chain-balances read');
    assert.deepEqual(asked[0], { wallet: chain.owner.toLowerCase(), tokens: model.balanceRequest(model.walletBalanceTokens(portfolio)) });
    assert.deepEqual(asked[0].tokens.map((token) => `${token.chainId}:${token.address}`).at(-1), `8453:${AERO}`);
    // 0.5 ETH at the fixtures' ETH round (4000.12345678) is $2,000.06, then 25.5 USDC, 3 AERO at $1.25, 1 USDG.
    assert.equal(await card.locator('[data-wallet-total] .dm-fig-xl').textContent(), '$2,030.31');
    assert.ok(!(await page.evaluate(() => window.__walletTotals)).includes('$1.00'), 'a first visit never shows Robinhood Chain’s figure alone before the sum');
    assert.match(await card.locator('[data-wallet-total]').getAttribute('title'), /^The sum of the tokens on this card, on Robinhood Chain, Base and Arbitrum One\. Indicative, not a quote\.$/);
    assert.equal(await card.locator('[data-wallet-total-note]').count(), 0, 'every held token priced: no note');
    const shown = await rowsOf(page);
    assert.deepEqual(shown.map((row) => [row.name, row.network, row.usd]), [['ETH', 'Base', '$2,000.06'], ['USDC', 'Arbitrum One', '$25.50'], ['AERO', 'Base', '$3.75']], 'the largest three first');
    assert.equal(shown[0].href, null, 'native ETH has no token page');
    assert.equal(shown[2].href, `#/markets/network/8453/${AERO}`, 'a token’s pools on Markets, on its own network');
    assert.equal(shown[1].href, `#/markets/network/42161/${ARB_USDC}`);
    assert.equal(shown[0].units, '0.5');
    assert.equal(shown[1].usdTitle, 'USDC counted at $1.');
    assert.equal(shown[2].usdTitle, 'At $1.25 per token, from its Uniswap pool on Base. Indicative, not a quote.');
    // Robinhood Chain's USDG is behind Show all, now naming its network as the others do.
    const all = card.locator('[data-wallet-show-all]');
    assert.equal(await all.textContent(), 'Show all 4');
    await all.click();
    const every = await rowsOf(page);
    assert.deepEqual(every.at(-1), { token: USDG, chain: null, name: 'USDG', href: `#/markets/${USDG}`, units: '1', network: 'Robinhood Chain', usd: '$1.00', usdTitle: 'USDG counted at $1.' });
    // Added 2026-11-06 (review of R-07): the network beside the amount, every row clear of its value, down to a 320px phone.
    // Changed on purpose 2026-11-06 (review UI-1): and the amount always whole. These short amounts and their networks share
    // one line on a desktop and a 390px phone; on a 320px phone a network that does not fit goes under its amount.
    for (const width of [1180, 390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      const layout = await layoutOf(page);
      assert.equal(layout.overflow, false, `the card fits ${width}px`);
      assert.ok(layout.rows.every((row) => row.whole && row.clear && (width === 320 || row.oneLine)), `every row's amount and network whole, clear of its value, at ${width}px: ${JSON.stringify(layout.rows)}`);
    }
    await page.setViewportSize({ width: 1280, height: 960 });
    if (SHOTS) {
      // DOMINO_SHOTS=<folder>: the card as drawn, once its figure has settled, for a look at it.
      mkdirSync(SHOTS, { recursive: true });
      await page.waitForTimeout(1200);
      await page.locator('.dm-acct-wallet').screenshot({ path: resolve(SHOTS, 'wallet-networks.png') });
      await page.setViewportSize({ width: 390, height: 900 });
      await page.waitForTimeout(400);
      await page.locator('.dm-acct-wallet').screenshot({ path: resolve(SHOTS, 'wallet-networks-phone.png') });
    }
    assert.equal(chain.sends.length, 0, 'nothing is sent');
  } finally { await s.close(); }
});

// Added 2026-11-06 (review UI-1): real amounts beside a network's name. The name never shrinks, and the amount was the one
// part of the line that could ("1,… · Robinhood Chain" in the 216-230px rail, nothing at all on a 320px phone): every
// amount is now whole at every width, its network beside it where both fit and under it where they do not.
test('long amounts stay whole beside their network, from a 320px phone to a wide desktop', { timeout: 90_000 }, async () => {
  const { s } = await openCard({
    tokens: [indexedToken(8453, AERO, 'AERO', 18)],
    usdgRaw: '1234560000',
    balances: {
      held: { [`8453:${ZERO}`]: 1_234_567n * 10n ** 12n, [`8453:${AERO}`]: 98_765_432n * 10n ** 15n, [`42161:${ARB_USDC}`]: 123_456_780000n },
      pools: { [`8453:${AERO}`]: '1.250000000000000000' },
      meta: { [`8453:${AERO}`]: { symbol: 'AERO', decimals: 18 } },
    },
  });
  try {
    const { page } = s;
    await page.waitForFunction(() => document.querySelector('[data-portfolio-tokens]')?.getAttribute('data-wallet-networks-held') === '3' && document.querySelector('[data-wallet-total]'));
    await page.locator('[data-portfolio-tokens] [data-wallet-show-all]').click();
    for (const width of [1024, 1180, 1280, 1600, 390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      const layout = await layoutOf(page);
      assert.deepEqual(layout.rows.map((row) => row.units), ['98,765.4', '123,457', '1.23457', '1,234.56'], `${width}px: the four amounts`);
      assert.equal(layout.overflow, false, `the card fits ${width}px`);
      assert.ok(layout.rows.every((row) => row.whole && row.clear), `every amount and network whole, clear of its value, at ${width}px: ${JSON.stringify(layout.rows)}`);
    }
    assert.deepEqual((await rowsOf(page)).map((row) => row.network), ['Base', 'Arbitrum One', 'Base', 'Robinhood Chain']);
  } finally { await s.close(); }
});

// Added 2026-11-06 (review of R-07): a card opened again in this page starts from the other networks' last whole read, as
// its own list starts from its memory: back on Positions, its figure is the sum from the first frame, never Robinhood
// Chain's alone for a moment.
test('back on Positions, the card’s first figure is the sum it showed, never Robinhood Chain’s alone', { timeout: 90_000 }, async () => {
  const { s, asked } = await openCard({
    balances: { held: { [`8453:${ZERO}`]: 5n * 10n ** 17n, [`42161:${ARB_USDC}`]: 25_500000n } },
  });
  try {
    const { page } = s;
    const card = page.locator('[data-portfolio-tokens]');
    await page.waitForFunction(() => document.querySelector('[data-portfolio-tokens]')?.getAttribute('data-wallet-networks-held') === '2' && document.querySelector('[data-wallet-total]'));
    const total = await card.locator('[data-wallet-total] .dm-fig-xl').textContent();
    assert.equal(total, '$2,026.56', '0.5 ETH on Base, 25.5 USDC on Arbitrum One and 1 USDG');
    await page.evaluate(() => { location.hash = '#/'; });
    await card.waitFor({ state: 'detached' });
    await page.evaluate(() => { window.__walletTotals.length = 0; location.hash = '#/positions'; });
    await card.locator('[data-wallet-total]').waitFor();
    await page.waitForTimeout(1500);
    assert.deepEqual(await page.evaluate(() => [...window.__walletTotals]), [total], 'one figure on the way back: the sum');
    assert.equal(await card.getAttribute('data-wallet-networks-held'), '2');
    assert.deepEqual((await rowsOf(page)).map((row) => [row.name, row.network]), [['ETH', 'Base'], ['USDC', 'Arbitrum One'], ['USDG', 'Robinhood Chain']]);
    assert.equal(asked.length, 1, 'the page’s read is reused, not asked again');
  } finally { await s.close(); }
});

// Added 2026-11-06 (review of R-07): a wallet with nothing on Robinhood Chain but tokens on Base. Robinhood Chain's own
// list withholds its figure as "nothing valued"; the card's figure is then the other networks' alone, and the list's
// empty line is not drawn under their rows.
test('nothing on Robinhood Chain, tokens on Base: their rows and their total, no empty line', { timeout: 90_000 }, async () => {
  const { s } = await openCard({ robinhoodEmpty: true, balances: { held: { [`8453:${ZERO}`]: 5n * 10n ** 17n } } });
  try {
    const { page } = s;
    const card = page.locator('[data-portfolio-tokens]');
    await page.waitForFunction(() => document.querySelector('[data-portfolio-tokens]')?.getAttribute('data-wallet-networks-held') === '1' && document.querySelector('[data-wallet-total]'));
    assert.equal(await card.locator('[data-wallet-total] .dm-fig-xl').textContent(), '$2,000.06');
    assert.match(await card.locator('[data-wallet-total]').getAttribute('title'), /^The sum of the tokens on this card, on Base\. Indicative, not a quote\.$/);
    assert.deepEqual((await rowsOf(page)).map((row) => [row.name, row.network, row.usd]), [['ETH', 'Base', '$2,000.06']]);
    assert.equal(await card.locator('[data-wallet-empty]').count(), 0, 'no "No tokens listed." under the Base row');
    assert.equal(await card.getAttribute('data-wallet-total-withheld'), null, 'a figure is shown: nothing is said withheld');
  } finally { await s.close(); }
});

// Added 2026-11-06 (review of R-07): the first figure waits for the other networks' first read three seconds at most; a
// slow read never keeps Robinhood Chain's figure off the card longer, and its answer joins the figure when it lands.
test('a slow read of the other networks holds Robinhood Chain’s figure three seconds at most', { timeout: 90_000 }, async () => {
  const { s } = await openCard({ delayMs: 7000, balances: { held: { [`8453:${ZERO}`]: 5n * 10n ** 17n } } });
  try {
    const { page } = s;
    const card = page.locator('[data-portfolio-tokens]');
    await page.waitForFunction(() => document.querySelector('[data-portfolio-tokens] [data-wallet-total] .dm-fig-xl')?.textContent === '$1.00', null, { timeout: 6_500 });
    assert.equal(await card.getAttribute('data-wallet-networks-held'), null, 'shown before the other networks answered');
    await page.waitForFunction(() => document.querySelector('[data-portfolio-tokens]')?.getAttribute('data-wallet-networks-held') === '1', null, { timeout: 15_000 });
    await page.waitForFunction(() => document.querySelector('[data-portfolio-tokens] [data-wallet-total] .dm-fig-xl')?.textContent === '$2,001.06');
    assert.deepEqual(await page.evaluate(() => [...window.__walletTotals]), ['$1.00', '$2,001.06']);
  } finally { await s.close(); }
});

test('nothing held on Base or Arbitrum One: the card is Robinhood Chain’s, with no network named', { timeout: 60_000 }, async () => {
  const { s, asked } = await openCard({});
  try {
    const { page } = s;
    const card = page.locator('[data-portfolio-tokens]');
    await page.waitForFunction(() => document.querySelector('[data-portfolio-tokens]')?.getAttribute('data-wallet-networks') === 'ready' && document.querySelector('[data-wallet-total]'));
    assert.equal(asked.length, 1);
    assert.equal(asked[0].tokens.length, 6, 'each network’s ETH, WETH and USDC');
    assert.equal(await card.locator('[data-wallet-total] .dm-fig-xl').textContent(), '$1.00');
    assert.equal(await card.locator('[data-wallet-total]').getAttribute('title'), 'The sum of the tokens on this card, at provider-reported prices with USDG at $1. Indicative, not a quote.');
    assert.deepEqual((await rowsOf(page)).map((row) => [row.name, row.network]), [['USDG', null]]);
    assert.equal(await card.getAttribute('data-wallet-networks-held'), null);
    assert.equal(await card.locator('[data-wallet-show-all]').count(), 0);
  } finally { await s.close(); }
});

test('a network that could not be read: nothing of the other networks is shown or summed, the card stays Robinhood Chain’s', { timeout: 60_000 }, async () => {
  const { s, asked } = await openCard({ balances: { held: { [`8453:${ZERO}`]: 10n ** 18n }, down: [42161] } });
  try {
    const { page } = s;
    const card = page.locator('[data-portfolio-tokens]');
    await page.waitForFunction(() => document.querySelector('[data-wallet-total]'));
    await page.waitForFunction(() => document.querySelector('[data-portfolio-tokens]')?.getAttribute('data-wallet-networks') === null, null, { timeout: 10_000 });
    assert.ok(asked.length >= 1);
    assert.equal(await card.locator('[data-wallet-total] .dm-fig-xl').textContent(), '$1.00', 'Base’s ETH is not summed without Arbitrum One');
    assert.deepEqual((await rowsOf(page)).map((row) => [row.name, row.network]), [['USDG', null]]);
  } finally { await s.close(); }
});
