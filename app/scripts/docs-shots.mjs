#!/usr/bin/env node
/**
 * The docs' illustrations: screenshots of the app in a made-up world, each cropped to the one block a docs page talks
 * about, framed on the page's own background and written as WebP under public/docs/ with their sizes in
 * src/lib/docs/shots.ts (the docs pages read both).
 *
 * Only made-up data is ever shown. The screens are the builds' own: the production build (dist) for the public
 * screens, and the wallet-test build for the ones a connected wallet sees (its test banner and nothing else hidden by
 * this script's own stylesheet, which only its server serves). Both are served by the browser suites' server
 * (tests/support/wallet-server.mjs) with the fake session service, a fake Robinhood Chain
 * (tests/support/browser-chain.mjs) and Test Wallet A, a public development key that holds nothing on any real
 * network (tests/support/mock-wallet.mjs). The figures, the pools and the read service's answers are the made-up world
 * of scripts/docs-world.mjs: Domino's own tokens with their own artwork, plausible round figures, every answer checked
 * by the read Worker and its contracts. No request leaves this machine except the page's Google Fonts (pass --offline
 * to answer those with nothing; the pictures then use fallback fonts): anything else is refused.
 *
 * Re-run it after any change to a screen the docs show, and on the integrated tree before every preview, so the
 * pictures show the screens that ship. From app/:
 *
 *   npm run build -- --configLoader runner && npm run build:wallet-test-v2 -- --configLoader runner && npm run build:unit && node scripts/docs-shots.mjs --offline
 *
 * then `npm test` (tests/docs.test.mjs checks that every image exists, is used, has its size and its words) and commit
 * public/docs/ with src/lib/docs/shots.ts. Options: --only <id,id> shoots some scenes and keeps the others' files and
 * sizes; --png <dir> also keeps each framed picture as a PNG there; --offline.
 *
 * Every scene is shot twice: in a desktop window (public/docs/<id>.webp) and in a phone's (<id>-phone.webp), which the
 * docs serve under 640 px so a phone reads the words at their own size instead of a desktop crop shrunk to a third.
 *
 * Framing, alike in every picture of a kind, so a page of pictures reads at one size:
 * - The block. A scene names the block it shows, and every block of a kind is the page's content column, one width
 *   (BLOCK): 772 CSS pixels in an 820 px window (an iPad Air held upright, the site's tablet layout), 358 in a 390 px
 *   phone's. Each is drawn exactly as the site draws it in that window. A block of any other width fails its scene.
 * - The scale. Every picture is drawn at twice its CSS size (SCALE) and never resampled: a desktop picture is
 *   (772 + 2 × 32) × 2 = 1672 pixels wide, a phone's (358 + 2 × 16) × 2 = 780, and text is the browser's own pixels.
 *   In the docs' 720 px column a desktop picture reads at 0.86 of its size on the site; in a 375 px phone's 343 px
 *   column a phone picture at 0.88.
 * - The frame. The block's ink (every pixel that is not the page's background) is set on the page's plain background
 *   with the same margin on all four sides: FRAME CSS pixels, 32 around every desktop picture and 16 around every
 *   phone's (a phone's own gutter: the words keep their size), give or take the one pixel an odd width leaves. The
 *   empty padding of a block's last row or the leading above a heading is background, so it is not counted twice.
 *   Nothing around the block is kept, so no neighbour's edge shows. A block taller than a picture may be fails the
 *   scene instead of being cut.
 *
 * Steps find controls by role, accessible name, visible words and the data attributes the browser suites rely on,
 * never by class names. A scene that can no longer find its control fails with its id and the step, and the others
 * are still written; its old pictures are DELETED, so tests/docs.test.mjs fails with "<id>.webp is missing" instead of
 * a stale picture shipping. The process then exits 1.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { zeroAddress } from 'viem';
import { closeBrowser } from '../tests/support/close-browser.mjs';
import { createFakeSession } from '../tests/support/fake-session.mjs';
import { createWalletServer } from '../tests/support/wallet-server.mjs';
import { WALLET_V2_DIST as WALLET_DIST } from '../tests/support/wallet-dist.mjs';
import { ACCOUNTS, installWallets } from '../tests/support/mock-wallet.mjs';
import { browserChain, routeChain } from '../tests/support/browser-chain.mjs';
import { findForbidden } from './deploy-markers.mjs';
import { DEPOSIT_USDG, MAIN_POOL, POOLS, POSITIONS, TOKENS, USDG, checkAnswers, createReadService, poolNamed, rawOf } from './docs-world.mjs';
import { ledgerWorld } from '../tests/support/fees/ledger-world.mjs';
import * as executionRuntime from '../../api-contracts/execution-v1/runtime.mjs';
import * as performanceRuntime from '../../api-contracts/performance-v2/runtime.mjs';

const APP = resolve(import.meta.dirname, '..');
const REPO = resolve(APP, '..');
const OUT = join(APP, 'public/docs');
const SIZES = join(APP, 'src/lib/docs/shots.ts');
/** The production build: the public screens as they ship. */
const SITE_DIST = join(APP, 'dist');
const argv = process.argv.slice(2);
const option = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};
const only = option('only')?.split(',') ?? null;
const keepPng = option('png');
const offline = argv.includes('--offline');

/** CSS pixels of the page's background around every block's ink, on all four sides: one value per kind. */
const FRAME = { desktop: 32, phone: 16 };
/**
 * Every block's width in CSS pixels, one per kind: the content column of the windows below, 820 px (an iPad Air held
 * upright: the site's tablet layout, its 24 px gutters aside) and a 390 px phone (16 px gutters). Narrower than 772,
 * the Markets table's fixed number columns (markets.css) leave its pool names too little room and break them over
 * lines, so every desktop picture is drawn at this one width instead.
 */
const BLOCK = { desktop: 772, phone: 358 };
/** Device pixels per CSS pixel, for every picture: sharp text, and no picture is ever resampled. */
const SCALE = 2;
/** Every picture's width in pixels (tests/docs.test.mjs holds them too): 1672 on a desktop, 780 on a phone. */
const WIDTH = { desktop: (BLOCK.desktop + 2 * FRAME.desktop) * SCALE, phone: (BLOCK.phone + 2 * FRAME.phone) * SCALE };
/** The most a picture may be tall, in pixels (tests/docs.test.mjs holds it too). */
const MAX_HEIGHT = 2400;
/** WebP quality, highest first: the first that keeps a picture under MAX_BYTES is used. */
const QUALITIES = [0.92, 0.88, 0.84, 0.8, 0.76];
const MAX_BYTES = 150 * 1024;
/** The windows, whose content columns are BLOCK wide: the site's tablet layout (768 to 1023 px), and a phone. */
const DESKTOP = { width: 820, height: 900 };
const PHONE = { width: 390, height: 844 };
/** How far a pixel's colour may be from the page's background and still be background (of 255, per channel). */
const INK = 3;

/**
 * The script's own stylesheet, served only by its server and linked into every page it shoots: the test build's
 * banner is taken away, the page's background is its plain colour (its top glow would show as a band once the
 * picture is framed), and nothing is caught mid-transition or with a caret. Nothing else of a screen is restyled.
 * Changed on purpose 2026-10-03 (the owner: the site looks too big at 100%): the site draws a tablet at 0.9 of its
 * design (styles/tokens.css, the root's font-size); the pictures keep the design's own size, the root at 16 px, so every
 * block is still BLOCK wide and every picture WIDTH pixels.
 */
const SHOT_CSS = `[data-build-banner] { display: none !important; }
html { font-size: 16px !important; }
html, body { background: var(--bg) !important; }
*, *::before, *::after { transition: none !important; caret-color: transparent !important; }
html { scrollbar-width: none; }
`;
const SHOT_CSS_PATH = '/docs-shots.css';

// ---- The made-up world on chain ---------------------------------------------------------------------------------------

const OWNER = ACCOUNTS[0].address.toLowerCase();
const LOW = poolNamed('ETH/USDG 0.05%');
/** The sequence vault of the Auto-compound position: made by Domino's factory, at 2%, running. */
const VAULT = `0x${'5a'.repeat(20)}`;
const IDS = { compound: '4101', plain: '4102', closed: '4088' };
/** A position's fees ready to collect, in raw units: its short figures (docs-world.mjs POSITIONS). */
const feesOf = ({ fees }) => fees.map((text, i) => rawOf(text, i === 0 ? 18 : TOKENS[USDG].decimals));

/**
 * The wallet's positions (docs-world.mjs POSITIONS): an Auto-compound one in ETH/USDG 0.30% (its fees history is the
 * world's, so its page has Your APR), a plain one in ETH/USDG 0.05%, and one closed.
 *
 * Only a scene marked `feesHistory` builds a position ledger, with a recorded fixture mint and exact unsettled fees.
 * The current edge handlers derive the history and APR from it. Other scenes need only pool state and positions.
 */
const NO_HISTORY_HEAD = 85_000_000;
function world(scene) {
  if (!scene.feesHistory) {
    const { compound, plain } = POSITIONS;
    return browserChain({
      head: NO_HISTORY_HEAD,
      timestamp: Math.floor(Date.now() / 1000),
      positions: [
        { tokenId: IDS.compound, holder: OWNER, key: MAIN_POOL.key, tickLower: compound.tickLower, tickUpper: compound.tickUpper, liquidity: compound.liquidity, unclaimed: feesOf(compound), subscriber: VAULT, mintBlock: NO_HISTORY_HEAD - 1_500_000 },
        { tokenId: IDS.plain, holder: OWNER, key: LOW.key, tickLower: plain.tickLower, tickUpper: plain.tickUpper, liquidity: plain.liquidity, unclaimed: feesOf(plain), mintBlock: NO_HISTORY_HEAD - 180_000 },
        { tokenId: IDS.closed, holder: OWNER, key: MAIN_POOL.key, tickLower: -199_800, tickUpper: -196_200, liquidity: 0n, unclaimed: [0n, 0n], mintBlock: NO_HISTORY_HEAD - 1_400_000 },
      ],
      pools: Object.fromEntries(POOLS.map((pool) => [pool.poolId, { sqrtPriceX96: pool.sqrtPriceX96, tick: pool.tick }])),
      tokens: Object.fromEntries(Object.entries(TOKENS).filter(([address]) => address !== zeroAddress)),
      vaults: { [VAULT]: { root: IDS.compound, feeBps: 200, paused: false, valid: true } },
    });
  }
  const { compound, plain } = POSITIONS;
  // The current ledger reader checks this fixture's mint and unclaimed fees through the real edge handlers.
  // No retired pool-wide replay, prewritten APR or fabricated chart is injected into the page.
  const { chain } = ledgerWorld({
    tokenId: BigInt(IDS.compound), holder: OWNER, vault: VAULT,
    key: MAIN_POOL.key,
    range: [compound.tickLower, compound.tickUpper],
    price: { sqrtPriceX96: MAIN_POOL.sqrtPriceX96, tick: MAIN_POOL.tick },
    head: NO_HISTORY_HEAD, now: Math.floor(Date.now() / 1000),
    mint: { block: NO_HISTORY_HEAD - 6_048_000, liquidity: compound.liquidity },
    steps: [], unclaimed: feesOf(compound),
    tokens: Object.fromEntries(Object.entries(TOKENS).filter(([address]) => address !== zeroAddress)),
    extraPositions: [
      { tokenId: IDS.plain, holder: OWNER, key: LOW.key, tickLower: plain.tickLower, tickUpper: plain.tickUpper, liquidity: plain.liquidity, unclaimed: feesOf(plain), mintBlock: NO_HISTORY_HEAD - 180_000 },
      { tokenId: IDS.closed, holder: OWNER, key: MAIN_POOL.key, tickLower: -199_800, tickUpper: -196_200, liquidity: 0n, unclaimed: [0n, 0n], mintBlock: NO_HISTORY_HEAD - 1_400_000 },
    ],
  });
  Object.assign(chain.pools, Object.fromEntries(POOLS.filter((pool) => pool !== MAIN_POOL).map((pool) => [pool.poolId, { sqrtPriceX96: pool.sqrtPriceX96, tick: pool.tick }])));
  return chain;
}

// ---- The browser and the site -------------------------------------------------------------------------------------

async function launch() {
  const failures = [];
  const launches = process.env.DOMINO_BROWSER_PATH ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }] : [{ channel: 'msedge' }, { channel: 'chrome' }, { channel: 'chromium' }, {}];
  for (const options of launches) {
    try {
      return await chromium.launch({ ...options, headless: true });
    } catch (error) {
      failures.push(String(error).split('\n')[0]);
    }
  }
  throw new Error(`No Chromium build could be launched:\n${failures.join('\n')}`);
}

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

/**
 * The Receipts card's rows, newest first: the fees Auto-compound added back each time, after its 2% service fee. The gross
 * amounts are chosen so that what was added back is short (30.87 USDG, 0.0049 ETH + 10.29 USDG).
 */
const RECEIPTS = [
  { usdg: '31.50' },
  { eth: '0.005', usdg: '10.50' },
  { eth: '0.010', usdg: '12.50' },
  { usdg: '25.50' },
];

/** The private services a signed-in wallet reads on Positions: RECEIPTS as finished runs, and the contract's history fixture. */
function privateRoutes() {
  const statusWire = JSON.parse(readFileSync(join(REPO, 'api-contracts/execution-v1/fixtures/status-wire.json'), 'utf8'));
  const cards = JSON.parse(readFileSync(join(REPO, 'api-contracts/performance-v2/fixtures/responses/cards.json'), 'utf8'));
  const epochs = JSON.parse(readFileSync(join(REPO, 'api-contracts/performance-v2/fixtures/responses/epochs.json'), 'utf8'));
  const reserved = statusWire.responses['status.reserved'].item;
  const hex = (n, bytes) => `0x${n.toString(16).padStart(2, '0').repeat(bytes)}`;
  const items = RECEIPTS.map((gross, n) => {
    const transactionHash = hex(0xab + n, 32);
    // Each token's gross fees, 2% of them to the service, the rest added back.
    const sources = [
      ...(gross.eth ? [[zeroAddress, rawOf(gross.eth, 18)]] : []),
      ...(gross.usdg ? [[USDG, rawOf(gross.usdg, TOKENS[USDG].decimals)]] : []),
    ].map(([currency, raw], i) => ({
      sourceId: hex(0x9a + 2 * n + i, 32),
      currency,
      grossOriginalConsumedRaw: String(raw),
      chargedConsumedRaw: '0',
      serviceFeeRaw: String((raw * 200n) / 10_000n),
      liquidityAddedRaw: String(raw - (raw * 200n) / 10_000n),
      originalAfterRaw: '0',
      chargedAfterRaw: '0',
    }));
    return {
      ...reserved,
      intentId: hex(0x56 + n, 32),
      state: 'reconciled',
      canCancel: false,
      signer: `0x${'57'.repeat(20)}`,
      nonceRaw: String(RECEIPTS.length + 1 - n),
      attempts: [{ ordinal: 0, transactionHash }],
      receipt: {
        transactionHash,
        blockNumberRaw: String(71_699_000 - n * 8_600),
        blockHash: hex(0xcd + n, 32),
        canonical: true,
        finalized: true,
        serviceFeeBps: 200,
        serviceFeeRecipient: `0x${'78'.repeat(20)}`,
        liquidityIncreaseRaw: '1000000',
        fullL2CostWei: null,
        sources,
      },
    };
  });
  const list = { ...statusWire.responses['list.empty'], owner: OWNER, items };
  if (!executionRuntime.validateResponse('list', list)) throw new Error('the made-up receipt does not pass the execution-v1 contract');
  const performance = { 'X-Domino-Performance-Contract': performanceRuntime.CONTRACT_VERSION };
  const execution = { 'X-Domino-Execution-Contract': executionRuntime.CONTRACT_VERSION };
  return async (request, url) => {
    if (url.pathname === SHOT_CSS_PATH) return new Response(SHOT_CSS, { headers: { 'Content-Type': 'text/css; charset=utf-8' } });
    if (url.pathname.startsWith('/api/setup/v1/')) return json({ contractVersion: '1.0.0-rc.1', chainId: 4663, available: false, deployment: null }, 200, { 'X-Domino-Setup-Contract': '1.0.0-rc.1' });
    if (url.pathname.startsWith('/api/execution/v1/')) return url.pathname.endsWith('/availability') ? json({ error: 'route_not_available' }, 404, execution) : json(list, 200, execution);
    if (url.pathname.startsWith('/api/performance/v2/')) {
      const route = url.pathname.split('/').at(-1);
      const value = structuredClone(route === 'epochs' ? epochs : cards);
      value.owner = OWNER;
      return performanceRuntime.validateResponse(route, value) ? json(value, 200, performance) : json({ error: 'route_not_available' }, 404, performance);
    }
    return undefined;
  };
}

/** Requests the pictures may make beyond this machine: the page's fonts, unless --offline. The chain is answered first. */
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

/**
 * A fresh site, browser context and page for one scene, in a desktop window or, with `phone`, a phone's, drawn at
 * SCALE device pixels per CSS pixel.
 */
async function openScene(browser, scene, phone) {
  const fake = createFakeSession();
  const dist = scene.build === 'wallet' ? WALLET_DIST : SITE_DIST;
  const server = createWalletServer({ fake, dist, routes: [privateRoutes(), createReadService()] });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  fake.origin = origin;
  const viewport = phone ? PHONE : DESKTOP;
  // A phone is a touch screen: no hover, as the site's (hover: none) rules expect.
  const context = await browser.newContext({ viewport, deviceScaleFactor: SCALE, colorScheme: 'dark', reducedMotion: 'reduce', ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  // Nothing leaves this machine but the fonts: any other host (a token artwork provider, an extension's injected
  // script) is refused. Routes registered later are asked first, so the routes below answer the site's chain routes.
  const refused = new Set();
  await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => {
    const url = route.request().url();
    if (FONTS.test(url)) return offline ? route.fulfill({ status: 200, contentType: 'text/css', body: '' }) : route.continue();
    refused.add(new URL(url).host);
    return route.abort('blockedbyclient');
  });
  await routeChain(context, world(scene));
  await installWallets(context);
  // The same preview-only origin gate as the V2 browser suites; no live deployment or execution is enabled.
  await context.addInitScript(() => { window.__dominoV2Test = { originOpen: true }; });
  // Round 6 (2026-09-27): Your positions measures each row's Your APR itself (components/positions/listApr.ts), which a
  // test build does only when asked before the page loads, as the site always does.
  if (scene.listApr) await context.addInitScript(() => { window.__dominoListApr = true; });
  // The script's stylesheet, linked from this server, as soon as each document has a head (the page's CSP allows 'self').
  await context.addInitScript((href) => {
    const link = () => {
      if (document.querySelector(`link[href="${href}"]`)) return;
      const sheet = document.createElement('link');
      sheet.rel = 'stylesheet';
      sheet.href = href;
      document.head.append(sheet);
    };
    if (document.head) link();
    else document.addEventListener('DOMContentLoaded', link);
  }, SHOT_CSS_PATH);
  const page = await context.newPage();
  return {
    page,
    viewport,
    phone,
    async go(hash) {
      await page.goto(`${origin}/${hash}`);
      await page.waitForFunction(() => (document.querySelector('#root')?.children.length ?? 0) > 0);
    },
    async close() {
      await context.close();
      await server.closeAll();
    },
  };
}

const walletDialog = (page) => page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]');

async function connect(page, { signIn = false } = {}) {
  await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
  await page.locator('header [aria-haspopup="dialog"]').click();
  await walletDialog(page).getByRole('button', { name: 'Connect Test Wallet A', exact: true }).click();
  await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
  if (signIn) {
    await walletDialog(page).getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
  }
  await page.keyboard.press('Escape');
  await walletDialog(page).waitFor({ state: 'hidden' });
}

/** Waits for the page to stop moving: fonts in, entrances played, two quiet frames. */
async function settle(page, ms = 800) {
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(ms);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

/** The closest card-like container of an element: its section or article, else the element itself. */
const container = (locator) => locator.locator('xpath=ancestor-or-self::*[self::section or self::article][1]');

/**
 * The smallest element on the page whose visible words hold every one of `words` (case aside: labels may be drawn in
 * capitals), as a page box; `inside` limits the search to one element's subtree. Screens can be redesigned around a
 * block and it is still found, as long as its words stay.
 */
async function around(page, words, inside = 'body') {
  const box = await page.evaluate(
    ({ words, inside }) => {
      const root = document.querySelector(inside);
      if (!root) return null;
      const needles = words.map((word) => word.toLowerCase());
      let best = null;
      for (const element of [root, ...root.querySelectorAll('*')]) {
        const text = (element.innerText ?? '').toLowerCase();
        if (!needles.every((needle) => text.includes(needle))) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (!best || rect.width * rect.height < best.width * best.height) best = { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height };
      }
      return best;
    },
    { words, inside },
  );
  if (!box) throw new Error(`no block holds: ${words.join(', ')}`);
  return box;
}

/** Waits until every row of the pools table on screen has its figures, its APR last among them. */
async function poolRowsRead(page, rows) {
  await page.waitForFunction(
    ({ rows }) => {
      const table = document.querySelector('section[aria-labelledby="markets-pools-title"] table');
      const read = table ? [...table.querySelectorAll('tbody tr')] : [];
      return read.length === rows && read.every((row) => /\d% est\./.test(row.textContent ?? ''));
    },
    { rows: POOLS.length },
    { timeout: 90_000, polling: 250 },
  );
  void rows;
}

// ---- Scenes -----------------------------------------------------------------------------------------------------------

/**
 * Each scene drives one screen to what a docs page shows, and returns the block to keep: `keep`, the union of its
 * items (a locator, a list of words for around(), or a function of the page giving a box), with `top` and `bottom`
 * moving one edge to another item's; the block must be the content column's width (BLOCK). `build` is the build it
 * is shot in: 'site' (production) or 'wallet' (the wallet-test build, for a connected wallet's screens). `run` is
 * given `phone`, true in the phone's window. `alt` is the picture's plain description; the docs pages read it from
 * shots.ts, so the words travel with the picture. `feesHistory`: the scene reads the Auto-compound position's fee
 * history (world() above).
 */
const SCENES = [
  {
    id: 'markets',
    alt: 'The Markets page: a table of pools, each with its pair, fee, price, TVL, 24-hour volume and APR.',
    build: 'site',
    async run({ page, go }) {
      await go('#/markets');
      await poolRowsRead(page, POOLS.length);
      // 2026-10-01 (the copy workstream): and every row's price, whose token reads may settle after its APR.
      await page.waitForFunction(() => !document.querySelector('section[aria-labelledby="markets-pools-title"] [data-pool-price="loading"]'), null, { timeout: 60_000, polling: 250 });
      await settle(page, 1200);
      // The pools section: its title, the filters and the table. Changed on purpose (2026-09-28, the owner: "Não
      // precisa ter essa descrição"): no line under the title says how the list is made, and a picture that would
      // show one fails its scene, so the docs never show a line the site no longer has.
      const section = page.locator('section[aria-labelledby="markets-pools-title"]');
      if (/ranked daily|not a recommendation/i.test(await section.innerText())) throw new Error('the pools section says how the list is made, under its title');
      return { keep: [section] };
    },
  },
  {
    id: 'pool',
    alt: 'A pool’s page: the pair, its fee and the Create a position button at the top, one sentence on what the pool earns, then its APR, 24-hour volume, TVL and price.',
    build: 'site',
    async run({ page, go }) {
      await go(`#/pool/${MAIN_POOL.poolId}`);
      const workspace = page.locator('[data-pool-workspace]').first();
      await workspace.locator('h1').first().waitFor({ timeout: 30_000 });
      await page.waitForFunction(() => /\d% est\./.test(document.querySelector('[data-pool-workspace]')?.textContent ?? ''), null, { timeout: 60_000 });
      await settle(page, 2000);
      // Round 6 (2026-09-27): the top of the page a beginner reads first: the pair's row with its Create a position
      // button, the sentence on what the pool is and earns, and the key figures under it.
      const head = (p) => around(p, ['ETH / USDG', 'Create a position'], '[data-pool-workspace]');
      return { keep: [head, workspace.locator('[data-pool-intro]'), workspace.locator('[data-pool-figures]')] };
    },
  },
  {
    id: 'new-pool',
    alt: 'New position, step 1: a token is typed, the pools that trade it are listed with their figures, and one of them is chosen.',
    build: 'site',
    async run(scene) {
      await toStage(scene, 'pool', this.build);
      return journeyRegion(scene);
    },
  },
  {
    id: 'new-range',
    alt: 'New position, step 2: today’s price, the choice of how wide the range is, and its lowest and highest price.',
    build: 'site',
    async run(scene) {
      await toStage(scene, 'range', this.build);
      return journeyRegion(scene);
    },
  },
  {
    id: 'new-amount',
    alt: 'New position, step 3: how much of each token goes in, beside the wallet’s balance of each, with the slippage tolerance under Advanced.',
    build: 'wallet',
    async run(scene) {
      await toStage(scene, 'amount', this.build);
      return journeyRegion(scene);
    },
  },
  // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): no 'new-review' scene. It showed Domino V1's
  // review (the deposit into Domino's Setup contract, then the mint), which New position no longer has once Domino's new
  // contracts are live: Create position is then one transaction on them. That review runs only with those contracts
  // live (a V2 build, and a fake V2 deployment such as tests/v2in-browser's), which neither build shot here carries, so
  // it waits for a scene of its own; toStage still drives 'review' for one.
  {
    id: 'positions',
    alt: 'Positions: your positions, one row each, with its pair, whether the price is in range, its value, its fees ready to collect, its own APR and how its fees are used.',
    build: 'wallet',
    listApr: true,
    feesHistory: true,
    async run({ page, go }) {
      await go('#/positions');
      await connect(page);
      // 2026-10-01 (the copy workstream): since the fees workstream's item A18 the list's own reads of Your APR stay within
      // a small budget, which this made-up world's long history is past, so the row shows the figure its page draws this
      // visit (components/positions/listApr.ts), as it does for anyone who opened it: open the page first, then come back.
      await go(`#/positions/${IDS.compound}`);
      await page.waitForFunction(
        (cell) => {
          const apr = document.querySelector(cell);
          return apr?.getAttribute('data-apr') === 'ready' && !/\best\./.test(apr.textContent ?? '');
        },
        `[data-position-detail][data-position-id="${IDS.compound}"] [data-cell="apr"]`,
        { timeout: 120_000, polling: 250 },
      );
      await go('#/positions');
      await page.locator(`[data-position-automation="${IDS.compound}"]`).waitFor({ timeout: 30_000 });
      // Round 6 (2026-09-27): the Auto-compound row's Your APR, from its fees history (the world's), and no row still
      // waiting its turn.
      await page.locator(`[data-position-row="${IDS.compound}"] [data-apr="ready"]`).waitFor({ timeout: 120_000 });
      await page.waitForFunction(() => !document.querySelector('[data-position-row] [data-apr="waiting"]'), null, { timeout: 120_000, polling: 250 });
      await settle(page, 1500);
      return { keep: [container(page.getByRole('heading', { name: 'Your positions', exact: true }))] };
    },
  },
  {
    id: 'position',
    alt: 'A position’s page: the pair and its state, its buttons, then what the position is worth, its fees ready to collect, its own APR and the price against its range.',
    build: 'wallet',
    feesHistory: true,
    async run({ page, go }) {
      await go('#/positions');
      await connect(page);
      await go(`#/positions/${IDS.compound}`);
      const detail = `[data-position-detail][data-position-id="${IDS.compound}"]`;
      await page.locator(detail).waitFor({ timeout: 30_000 });
      await page.getByRole('button', { name: /^Collect fees$/ }).first().waitFor({ timeout: 30_000 });
      // Your APR is worked out from the position's fees ledger, read from the chain after the page's own figures (since
      // 2026-10-02 never an estimate, RPC-SPEC §11.4; the check below stays harmless).
      await page.waitForFunction(
        (cell) => {
          const apr = document.querySelector(cell);
          return apr?.getAttribute('data-apr') === 'ready' && !/\best\./.test(apr.textContent ?? '');
        },
        `${detail} [data-cell="apr"]`,
        { timeout: 120_000, polling: 250 },
      );
      await settle(page, 2000);
      // From the page's title to the end of the key figures that open it (the strip the finance suite reads by
      // data-position-stats); on a page from before that strip, to the end of the figures that name the same things.
      const stats = page.locator(`${detail} [data-position-stats]`);
      const bottom = (await stats.count()) > 0 ? stats.first() : (p) => around(p, ['principal', 'unclaimed', 'range'], detail);
      return { keep: [page.locator(`${detail} h1`).first(), bottom], top: (p) => around(p, ['Collect fees', MAIN_POOL.name.split(' ')[0].replace('/', ' / ')], detail) };
    },
  },
  {
    id: 'automate',
    alt: 'Auto-compound on the Automate page: what it does, its service fee of 2% of the earned fees it uses, and its Set up Auto-compound button.',
    build: 'site',
    async run({ page, go }) {
      await go('#/automate');
      await page.locator('[data-automation-card="domino"]').waitFor();
      await settle(page, 1500);
      // The Auto-compound card alone, which its docs page is about.
      const card = page.locator('[data-automation-card="compound"]');
      return { keep: [(await card.count()) > 0 ? card.first() : page.locator('[data-automation-card]').first()] };
    },
  },
  {
    id: 'receipts',
    alt: 'The Receipts card on Positions, once you sign in: a short row for each time automation added a position’s fees back, with what it added back.',
    build: 'wallet',
    async run({ page, go }) {
      await go('#/positions');
      await connect(page, { signIn: true });
      // A receipt is drawn (the attribute the finance suite reads it by), whatever words its state is given.
      const receipt = page.locator('[data-execution-intent]').first();
      await receipt.waitFor({ timeout: 30_000 });
      await settle(page, 2000);
      // The Receipts card (the section its #receipts-title names), else the card around the first receipt.
      const titled = page.locator('section[aria-labelledby="receipts-title"]');
      const card = (await titled.count()) > 0 ? titled.first() : receipt.locator('xpath=ancestor::section[1]');
      // Its amounts arrive with their tokens' details: every one of them, not a dash.
      await page.waitForFunction(
        (count) => {
          const added = [...document.querySelectorAll('[data-receipt-added]')];
          return added.length === count && added.every((cell) => !(cell.textContent ?? '').includes('—'));
        },
        RECEIPTS.length,
        { timeout: 30_000, polling: 250 },
      );
      return { keep: [card] };
    },
  },
];

/**
 * From #/new to one stage of the journey, the way a person gets there: USDG by name, ETH / USDG 0.30% chosen, then
 * 1000 USDG (the ETH it asks follows). In the wallet build Test Wallet A is connected first, so the amounts stand beside
 * its balances and Review ends with Create position.
 */
async function toStage({ page, go }, stage, build) {
  await go('#/new');
  if (build === 'wallet') await connect(page);
  await page.getByRole('combobox', { name: 'Search a token' }).fill('USDG');
  await page.locator(`[data-token-option="${USDG}"]`).first().click();
  // Every pool that trades it is listed, each with its figures.
  const rows = page.locator('[data-picker="pool"] li[data-pool-option]');
  await page.waitForFunction(
    (count) => {
      const listed = [...document.querySelectorAll('[data-picker="pool"] li[data-pool-option]')];
      return listed.length === count && listed.every((row) => /\d% est\./.test(row.textContent ?? ''));
    },
    POOLS.filter((pool) => [pool.key.currency0, pool.key.currency1].includes(USDG)).length,
    { timeout: 60_000, polling: 250 },
  );
  // The pool the rest of the journey is about, chosen: its row marked and Continue open.
  await rows.filter({ hasText: 'ETH / USDG' }).filter({ hasText: '0.30%' }).locator('input[type="radio"]').click();
  await page.locator('[data-chosen-pool]').waitFor();
  const next = page.locator('[data-journey-footer]').getByRole('button', { name: 'Continue', exact: true });
  if (stage === 'pool') {
    // Chosen, the list folds into the one pool. Opened again, it lists every pool with the chosen one marked, and
    // Continue stays open: the choice the step asks for, made, with the pools it was made from.
    await page.locator('[data-chosen-pool]').getByRole('button', { name: 'Change pool' }).click();
    await page.waitForFunction(
      (count) => {
        const listed = [...document.querySelectorAll('[data-picker="pool"] li[data-pool-option]')];
        return listed.length === count && listed.every((row) => /\d% est\./.test(row.textContent ?? '')) && listed.some((row) => row.querySelector('input[type="radio"]')?.checked);
      },
      POOLS.filter((pool) => [pool.key.currency0, pool.key.currency1].includes(USDG)).length,
      { timeout: 60_000, polling: 250 },
    );
    await page.waitForFunction((button) => button && !button.disabled, await next.elementHandle());
    return settle(page, 1200);
  }
  await next.click();
  await page.locator('[data-stage="range"]').waitFor();
  if (stage !== 'range') {
    await next.click();
    // USDG, the token step 1 chose, so every step's line says "deposit USDG"; the ETH it asks follows (docs-world.mjs
    // tunes the pool's price so it is short).
    await page.locator('[data-pair-side="1"] input[inputmode="decimal"]').fill(DEPOSIT_USDG);
    await page.locator('[data-pair-side="0"] input[inputmode="decimal"]').and(page.locator(':not([value=""])')).waitFor();
    if (build === 'wallet') await page.waitForFunction(() => document.querySelectorAll('[data-pair-balance="ready"]').length === 2, null, { timeout: 30_000 });
    if (stage === 'review') {
      await next.click();
      await page.locator('[data-stage-card="review"]').waitFor();
      if (build === 'wallet') await page.locator('[data-create-position="idle"]:not([disabled])').waitFor({ timeout: 30_000 });
    }
  }
  await settle(page, 1500);
}

/** The card of New position's four steps, whole: the open step and the others around it, on the rail that joins them. */
function journeyRegion({ page }) {
  return { keep: [page.locator('[data-create-journey] ol').first().locator('xpath=..')] };
}

// ---- Framing and writing ----------------------------------------------------------------------------------------------

/** One item's box, in page coordinates. */
async function boxOf(page, item) {
  if (typeof item === 'function') return item(page);
  if (Array.isArray(item)) return around(page, item);
  if ((await item.count()) === 0) throw new Error(`nothing to keep: ${item}`);
  const box = await item.first().boundingBox();
  if (!box) throw new Error(`not drawn: ${item}`);
  return box;
}

/** The block a scene keeps: the union of its items, edges moved as it says, on whole CSS pixels around it. */
async function blockOf(page, region) {
  const boxes = [];
  for (const item of region.keep) boxes.push(await boxOf(page, item));
  const x = Math.min(...boxes.map((b) => b.x));
  let y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  let bottom = Math.max(...boxes.map((b) => b.y + b.height));
  if (region.top) y = (await boxOf(page, region.top)).y;
  if (region.bottom) {
    const box = await boxOf(page, region.bottom);
    bottom = box.y + box.height;
  }
  const left = Math.floor(x);
  const top = Math.floor(y);
  return { x: left, y: top, width: Math.ceil(right) - left, height: Math.ceil(bottom) - top };
}

/**
 * A block's PNG (drawn at SCALE) framed on the page's background: its ink, every pixel not within INK of `background`,
 * with the same margin on all four sides, as near `margin` CSS pixels as the ink allows, in a picture `width` pixels wide;
 * drawn pixel for pixel, never resampled. As WebP at the highest quality of QUALITIES that stays under MAX_BYTES, in the
 * browser's own encoder. The ink must span the block's width to within a few pixels, or the margins would not match
 * the other pictures': the scene fails.
 */
async function frame(browser, png, width, margin, background) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const out = await page.evaluate(
      async ({ src, width, margin, background, ink, qualities, maxBytes }) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        const w = image.naturalWidth;
        const h = image.naturalHeight;
        const source = document.createElement('canvas');
        source.width = w;
        source.height = h;
        const read = source.getContext('2d', { willReadFrequently: true });
        read.drawImage(image, 0, 0);
        const { data } = read.getImageData(0, 0, w, h);
        const [r, g, b] = background.match(/\d+/g).map(Number);
        let left = w;
        let right = -1;
        let top = h;
        let bottom = -1;
        for (let y = 0; y < h; y += 1) {
          for (let x = 0; x < w; x += 1) {
            const i = (y * w + x) * 4;
            if (Math.abs(data[i] - r) <= ink && Math.abs(data[i + 1] - g) <= ink && Math.abs(data[i + 2] - b) <= ink) continue;
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
          }
        }
        if (right < 0) return { error: 'the block is all background' };
        const inkWidth = right - left + 1;
        const inkHeight = bottom - top + 1;
        // One margin on every side: what the width leaves on the left and right, the same above and below.
        const pad = Math.floor((width - inkWidth) / 2);
        if (Math.abs(pad - margin) > 4) return { error: `its ink is ${inkWidth} of the block's ${w} pixels wide, so its margins would be ${pad} pixels, not ${margin}` };
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = inkHeight + 2 * pad;
        const context2d = canvas.getContext('2d');
        context2d.fillStyle = background;
        context2d.fillRect(0, 0, canvas.width, canvas.height);
        context2d.imageSmoothingEnabled = false;
        context2d.drawImage(source, left, top, inkWidth, inkHeight, pad, pad, inkWidth, inkHeight);
        const png = canvas.toDataURL('image/png');
        let encoded = null;
        let quality = null;
        for (const q of qualities) {
          encoded = canvas.toDataURL('image/webp', q);
          quality = q;
          if ((encoded.length - encoded.indexOf(',') - 1) * 0.75 <= maxBytes) break;
        }
        return { data: encoded, png, quality, width: canvas.width, height: canvas.height, margins: [pad, width - pad - inkWidth, pad, pad] };
      },
      { src: `data:image/png;base64,${png.toString('base64')}`, width, margin: margin * SCALE, background, ink: INK, qualities: QUALITIES, maxBytes: MAX_BYTES },
    );
    if (out.error) throw new Error(out.error);
    if (!out.data.startsWith('data:image/webp;base64,')) throw new Error('this browser cannot encode WebP');
    const bytes = Buffer.from(out.data.slice('data:image/webp;base64,'.length), 'base64');
    if (bytes.length > MAX_BYTES) throw new Error(`the picture is ${bytes.length} bytes even at quality ${out.quality}`);
    return { bytes, png: Buffer.from(out.png.slice('data:image/png;base64,'.length), 'base64'), quality: out.quality, width: out.width, height: out.height, margins: out.margins };
  } finally {
    await context.close();
  }
}

/** A picture's file name, without `.webp`: `<id>`, or `<id>-phone` for the phone's. */
const fileOf = (id, phone) => (phone ? `${id}-phone` : id);

/** One scene in one window: the block, which must be the content column's width, and the page's background colour. */
async function capture(browser, scene, phone) {
  const s = await openScene(browser, scene, phone);
  try {
    const region = await scene.run(s);
    // No hover or focus left over from the steps: a row the pointer rests on is drawn lighter than the others.
    await s.page.mouse.move(0, 0);
    await s.page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
    // The whole page in one frame, so a block below the fold is drawn like the rest, and the header sits at the top.
    const height = await s.page.evaluate(() => document.documentElement.scrollHeight);
    await s.page.setViewportSize({ width: s.viewport.width, height: Math.max(s.viewport.height, height) });
    await s.page.evaluate(() => window.scrollTo(0, 0));
    await settle(s.page, 400);
    const block = await blockOf(s.page, region);
    const want = phone ? BLOCK.phone : BLOCK.desktop;
    // One width for every block of a kind, so every picture of a kind is drawn at one size.
    if (block.width !== want) throw new Error(`the block is ${block.width} CSS pixels wide, not ${want}`);
    const background = await s.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const png = await s.page.screenshot({ clip: block, animations: 'disabled', caret: 'hide' });
    return { block, background, png };
  } finally {
    await s.close();
  }
}

/** One scene in one window: the framed picture as WebP, with its size. */
async function shoot(browser, scene, phone) {
  const shot = await capture(browser, scene, phone);
  const kind = phone ? 'phone' : 'desktop';
  const out = await frame(browser, shot.png, WIDTH[kind], FRAME[kind], shot.background);
  if (out.height > MAX_HEIGHT) throw new Error(`${fileOf(scene.id, phone)} would be ${out.height} pixels tall (at most ${MAX_HEIGHT}): show a smaller block`);
  if (keepPng) {
    mkdirSync(keepPng, { recursive: true });
    writeFileSync(join(keepPng, `${fileOf(scene.id, phone)}.png`), out.png);
  }
  return out;
}

const ENTRY = /'([a-z0-9-]+)': \{ width: (\d+), height: (\d+), (?:phone: \{ width: (\d+), height: (\d+) \}, )?alt: '((?:[^'\\]|\\.)*)' \}/g;

/** shots.ts as it stands, so an --only run keeps the other scenes' entries. */
function previousSizes() {
  if (!existsSync(SIZES)) return {};
  const text = readFileSync(SIZES, 'utf8');
  const found = {};
  for (const match of text.matchAll(ENTRY)) {
    found[match[1]] = { width: Number(match[2]), height: Number(match[3]), alt: match[6].replace(/\\'/g, "'") };
    if (match[4]) found[match[1]].phone = { width: Number(match[4]), height: Number(match[5]) };
  }
  return found;
}

function writeSizes(entries) {
  const quote = (text) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const lines = Object.keys(entries)
    .sort((a, b) => SCENES.findIndex((s) => s.id === a) - SCENES.findIndex((s) => s.id === b))
    .map((id) => {
      const { width, height, phone, alt } = entries[id];
      return `  '${id}': { width: ${width}, height: ${height}, ${phone ? `phone: { width: ${phone.width}, height: ${phone.height} }, ` : ''}alt: ${quote(alt)} },`;
    });
  writeFileSync(
    SIZES,
    `/**
 * The docs' screenshots (public/docs/<id>.webp, and <id>-phone.webp for a phone's screen): each one's size in pixels
 * and its plain description. Written by scripts/docs-shots.mjs, which takes the pictures from the app's own builds in
 * a made-up world. Do not edit by hand: re-run the script (its header has the command), and commit this file with the images.
 */
export const SHOTS = {
${lines.join('\n')}
} as const satisfies Record<string, Shot>

/** A picture's size in pixels (twice its CSS size, for sharp text), its phone picture's, and its plain description. */
export interface Shot {
  readonly width: number
  readonly height: number
  readonly phone?: { readonly width: number; readonly height: number }
  readonly alt: string
}

export type ShotId = keyof typeof SHOTS
`,
  );
}

async function main() {
  for (const [dist, command] of [[SITE_DIST, 'npm run build'], [WALLET_DIST, 'npm run build:wallet-test-v2']]) {
    if (!existsSync(join(dist, 'index.html'))) throw new Error(`${dist} is missing: run \`${command}\` first.`);
  }
  // Every answer of the made-up world passes its contract, or nothing is shot.
  checkAnswers();
  // The read Worker logs every request it serves; the run prints one line per scene instead.
  const log = console.log;
  console.log = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('{"service":"read-bridge"')) return;
    log(...args);
  };
  mkdirSync(OUT, { recursive: true });
  const sizes = previousSizes();
  const browser = await launch();
  const failed = [];
  const kib = (bytes) => (bytes.length / 1024).toFixed(0);
  try {
    for (const scene of SCENES) {
      if (only && !only.includes(scene.id)) continue;
      const started = Date.now();
      try {
        for (const phone of [false, true]) if (findForbidden(`docs/${fileOf(scene.id, phone)}.webp`).length) throw new Error(`the file name ${fileOf(scene.id, phone)} carries a build marker`);
        const desktop = await shoot(browser, scene, false);
        const phone = await shoot(browser, scene, true);
        writeFileSync(join(OUT, `${fileOf(scene.id, false)}.webp`), desktop.bytes);
        writeFileSync(join(OUT, `${fileOf(scene.id, true)}.webp`), phone.bytes);
        sizes[scene.id] = { width: desktop.width, height: desktop.height, phone: { width: phone.width, height: phone.height }, alt: scene.alt };
        const margins = (shot) => shot.margins.join('/');
        log(`ok   ${scene.id}: ${desktop.width}×${desktop.height}, ${kib(desktop.bytes)} KiB at ${desktop.quality}, margins ${margins(desktop)}; phone ${phone.width}×${phone.height}, ${kib(phone.bytes)} KiB at ${phone.quality}, margins ${margins(phone)} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
      } catch (error) {
        failed.push(scene.id);
        // A picture of a screen that no longer looks like it must not ship: the docs checks fail until it is shot again.
        for (const phone of [false, true]) rmSync(join(OUT, `${fileOf(scene.id, phone)}.webp`), { force: true });
        log(`FAIL ${scene.id}: ${String(error?.message ?? error).split('\n')[0]}`);
      }
    }
  } finally {
    await closeBrowser(browser);
    writeSizes(sizes);
  }
  if (failed.length) {
    log(`${failed.length} scene(s) failed: ${failed.join(', ')}. Their pictures were deleted; fix the scene and run it again with --only ${failed.join(',')}.`);
    process.exitCode = 1;
  }
}

// Run as a script; imported (a probe, a test), it only lends its scenes and helpers.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

export { SCENES, launch, openScene, blockOf, settle, connect };
