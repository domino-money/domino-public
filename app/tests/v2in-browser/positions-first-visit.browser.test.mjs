/**
 * Added (2026-10-15, pack 8, task 3): the Positions page's first visit, timed. The owner's public view (#/portfolio/<address>,
 * no wallet, empty storage), as production's baseline measured it (pack8-baseline.md: rows with dollars 1,693 ms, wallet
 * rows 1,590 ms, wallet total 2,831 ms), on wallet-test-v2 with every request the page makes to its own origin held for one
 * round trip (RTT_MS, production's order of magnitude from Brazil) before the test server answers it: the site's read-v6
 * route (capabilities GET, portfolio and activity POSTs), the chain routes over the fake chain (the inventory, the state
 * route), the read Worker (wallet-assets), our DEX edge (the Wallet card's prices), and the app's own scripts.
 *
 * What a first visit waits for is the number of round trips in a row before each figure, so that is what this measures:
 * milliseconds from navigation to (a) the first row's dollar Value, (b) the Wallet card's first priced row, (c) its total.
 * It prints them (`[first visit]`) and checks what this pack changed: the list's own code is asked with the page's (the
 * route's preload table, vite.config.ts ROUTE_MODULES), the portfolio is asked in the same render the list first draws in
 * (src/v2in/lists/hooks.ts useListsGate), and nothing is asked that the page did not ask before (the same requests, once).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { zeroAddress } from 'viem';
import { browserChain, routeChain } from '../support/browser-chain.mjs';
import { closeBrowser } from '../support/close-browser.mjs';
import { createFakeSession } from '../support/fake-session.mjs';
import { createReadStub, FIXTURE_TOKEN } from '../support/read-stub.mjs';
import { launchBrowser } from '../support/s1-browser.mjs';
import { createDexEdgeRoute, createDexUpstream, edgeOnInTestBuild } from '../support/dex-edge-route.mjs';
import { scaleWallet, walletAssetsAnswer } from '../support/wallet-scale.mjs';
import { WALLET_V2_DIST } from '../support/wallet-dist.mjs';
import { createWalletServer } from '../support/wallet-server.mjs';
import * as runtime from '../../../api-contracts/read-v6/runtime.mjs';

const APP = resolve(import.meta.dirname, '../..');
const fixture = (name) => JSON.parse(readFileSync(join(APP, '../api-contracts/read-v6/fixtures/valid', name), 'utf8'));
const EXAMPLE_WALLET = '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1';
const OWNER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const CONTRACT = '1.1.0-rc.1';
const CAPABILITIES = { contractVersion: CONTRACT, dataMode: 'live_read_only', chainIds: [4663, 8453, 42161], enabledReads: ['portfolio', 'activity'], walletAuthentication: false, privateAccounts: false, ownerTransactions: false, automation: false };
const STUB_KEY = { currency0: zeroAddress, currency1: FIXTURE_TOKEN.toLowerCase(), fee: 3000, tickSpacing: 60, hooks: zeroAddress };
/** One round trip, held on every same-origin request before it is answered. */
const RTT_MS = Number(process.env.DOMINO_FIRST_VISIT_RTT ?? 150);
const RUNS = Number(process.env.DOMINO_FIRST_VISIT_RUNS ?? 3);
const about = (route, body) => {
  const answered = JSON.parse(JSON.stringify(body).replaceAll(EXAMPLE_WALLET, OWNER));
  assert.equal(runtime.validateResponse(route, answered), true);
  return answered;
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await closeBrowser(browser); });

/** One first visit: the figures' times (ms from navigation) and every same-origin request, in the order it was asked. */
async function firstVisit() {
  const fake = createFakeSession();
  const chain = browserChain({ positions: [{ tokenId: '3135288', holder: OWNER, key: STUB_KEY, tickLower: -60, tickUpper: 60, liquidity: 2n ** 100n, unclaimed: [633825300114n, 0n] }], tokens: { [FIXTURE_TOKEN.toLowerCase()]: { symbol: 'TOKEN', decimals: 6 } } });
  const wallet = scaleWallet({ held: 5 });
  const upstream = createDexUpstream({ pairsOf: (token) => wallet.pairs.get(token) ?? [] });
  const edge = createDexEdgeRoute(upstream);
  const read = createReadStub({ reads: 'wallet-assets,token,pools,pool-market,nft-positions,catalogue,pool-activity', answer: walletAssetsAnswer(wallet) });
  const activity = { ...fixture('activity.json'), items: [], nextCursor: null };
  const server = createWalletServer({
    fake, dist: WALLET_V2_DIST,
    routes: [
      async (request, url) => {
        if (url.pathname === '/api/position-plan/v1/capabilities') return Response.json({ error: 'not_found' }, { status: 404 });
        if (!url.pathname.startsWith('/api/read/v6/')) return undefined;
        const route = url.pathname.split('/').at(-1);
        const headers = { 'X-Domino-Read-Contract': CONTRACT };
        if (request.method === 'GET' && route === 'capabilities') return Response.json(CAPABILITIES, { headers });
        return Response.json(about(route, route === 'activity' ? activity : fixture('portfolio.json')), { headers });
      },
      edge.handle,
      (request, url) => read.handle(request, url),
    ],
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  fake.origin = origin;
  const context = await browser.newContext({ viewport: { width: 1320, height: 1000 } });
  const asked = [];
  const errors = [];
  try {
    await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await context.route(/^https:\/\/(api\.dexscreener\.com|dd\.dexscreener\.com|cdn\.dexscreener\.com)\//, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await routeChain(context, chain);
    await edgeOnInTestBuild(context, origin);
    // Registered last, so asked first: the round trip, then whichever handler answers it.
    const started = { at: 0 };
    await context.route((url) => url.href.startsWith(origin), async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== '/' || url.search) asked.push({ at: Date.now() - started.at, what: `${route.request().method()} ${url.pathname}` });
      await sleep(RTT_MS);
      await route.fallback();
    });
    await context.addInitScript(() => {
      window.__dominoV2Test = { originOpen: true, backendOn: true };
      const marks = window.__firstVisit = {};
      const watch = () => {
        const at = performance.now();
        // A row's first dollar figure (its Value or its fees): the portfolio's prices met its amounts.
        const value = [...document.querySelectorAll('[data-owned] [data-usd]')].find((cell) => /\$/.test(cell.textContent));
        if (!marks.rows && value) marks.rows = at;
        const row = [...document.querySelectorAll('[data-wallet-row] [data-usd]')].find((cell) => /\$/.test(cell.textContent));
        if (!marks.walletRows && row) marks.walletRows = at;
        const total = document.querySelector('[data-wallet-total] .dm-fig-xl');
        if (!marks.total && total && /\$/.test(total.textContent)) marks.total = at;
      };
      new MutationObserver(watch).observe(document, { childList: true, subtree: true, characterData: true });
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    started.at = Date.now();
    await page.goto(`${origin}/#/portfolio/${OWNER}`);
    await page.waitForFunction(() => window.__firstVisit.rows && window.__firstVisit.walletRows && window.__firstVisit.total, null, { timeout: 30_000 }).catch(async (error) => {
      const seen = await page.evaluate(() => ({ marks: window.__firstVisit, owned: [...document.querySelectorAll('[data-owned] .dm-own-row')].map((row) => row.innerText.replace(/s+/g, ' ') + ' | ' + [...row.querySelectorAll('[data-usd]')].map((c) => c.outerHTML).join(' ')), card: document.querySelector('[data-portfolio-tokens]')?.outerHTML.slice(0, 1500) ?? null }));
      throw new Error(`not every figure was shown: ${JSON.stringify(seen)} · asked ${JSON.stringify(asked.map((one) => one.what))}`, { cause: error });
    });
    const marks = await page.evaluate(() => ({ ...window.__firstVisit }));
    const preloads = await page.evaluate(() => [...document.querySelectorAll('link[rel="modulepreload"]')].map((link) => link.getAttribute('href')));
    return { marks: Object.fromEntries(Object.entries(marks).map(([key, value]) => [key, Math.round(value)])), asked, preloads };
  } finally {
    await context.close();
    await server.closeAll();
    assert.deepEqual(errors, [], 'no page error');
  }
}

test('Positions, first visit of the public view: row dollars, wallet rows and wallet total, timed with one round trip on every request', { timeout: 300_000 }, async () => {
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await firstVisit());
  const timing = Object.fromEntries(['rows', 'walletRows', 'total'].map((key) => [key, median(runs.map((run) => run.marks[key]))]));
  const last = runs.at(-1);
  const order = (what) => last.asked.find((one) => one.what === what)?.at ?? null;
  console.log(`[first visit] RTT ${RTT_MS} ms, median of ${RUNS}: ${JSON.stringify(timing)} · each run ${JSON.stringify(runs.map((run) => run.marks))}`);
  console.log(`[first visit] requests of the last run: ${JSON.stringify(last.asked.filter((one) => one.what.includes('/api/') || /\/assets\/(index|Positions|OwnedPositions|OwnedRows|transports|model)-[^/]*\.js$/.test(one.what)).map((one) => `${one.at} ${one.what}`))}`);
  console.log(`[first visit] read-v6 capabilities asked at ${order('GET /api/read/v6/capabilities')} ms, portfolio at ${order('POST /api/read/v6/portfolio')} ms`);
  for (const key of ['rows', 'walletRows', 'total']) assert.ok(Number.isFinite(timing[key]) && timing[key] > 0, `${key} shown`);
  // The list's own code (the V2 collection's chunk) is asked with the route's, by the boot table, not after them.
  const collection = last.asked.find((one) => /\/assets\/OwnedRows[-.]/.test(one.what));
  assert.ok(collection, 'the collection chunk is asked');
  const screen = last.asked.find((one) => /\/assets\/OwnedPositions[-.]/.test(one.what));
  assert.ok(collection.at < screen.at + RTT_MS / 2, `the collection's chunk is asked with the route's own (${collection.at} ms; OwnedPositions at ${screen.at} ms), not a round trip after it`);
  // Nothing asked twice that the page asked once: one capabilities GET and one portfolio POST for the list.
  assert.equal(last.asked.filter((one) => one.what === 'GET /api/read/v6/capabilities').length, 1);
  assert.equal(last.asked.filter((one) => one.what === 'POST /api/read/v6/portfolio').length, 1);
});
