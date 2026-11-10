/**
 * Pages of their own, in a real browser in front of the real production build (2026-11-07, the owner: Domino in Google,
 * integ-logs/seo/PROPOSAL.md). The server is scripts/gated-server.mjs with the gate open, as domino.money is now: the
 * compiled middleware in front of dist, the same pieces the deployment uses, minus Cloudflare.
 *
 * What a visitor and a crawler see: each address answers with its own head in the raw HTML; every link from before
 * (`/#/markets`, an older name, a section, a wallet app's return link) opens the same screen as before and the address
 * becomes the clean one in place, with no reload and no extra Back entry; the site's links move without a reload, Back,
 * Forward and a reload on a deep address work, a modified click still opens a new tab, and the page's CSP is never broken.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { closeBrowser } from './support/close-browser.mjs';
import { DIST, createGatedServer } from '../scripts/gated-server.mjs';

const require = createRequire(import.meta.url);
const { headTable } = require('../.test-build/app/src/lib/seo/table.js');

if (!existsSync(join(DIST, 'index.html'))) throw new Error('dist/index.html is missing. Run `npm run build` before this test.');

const LAUNCHES = process.env.DOMINO_BROWSER_PATH
  ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }]
  : [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}];

// Changed on purpose 2026-11-09 (Elysium's day 9): the table the build carries in dist's page, which the edge answers each
// page from: Elysium's words once its switch is on (as tests/seo.test.mjs reads it), today's table where none is carried.
const CARRIED = /<script type="application\/json" id="dm-head">([^<]*)<\/script>/.exec(readFileSync(join(DIST, 'index.html'), 'utf8'));
const PAGES = CARRIED ? JSON.parse(CARRIED[1]).pages : headTable().pages;
const TOKEN = `0x${'11'.repeat(20)}`;
const POOL = `0x${'ab'.repeat(32)}`;

let server;
let origin;
let browser;

before(async () => {
  server = createGatedServer({ env: { BETA_GATE: 'off', SEARCH_INDEX: 'on' } });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  for (const options of LAUNCHES) {
    try {
      browser = await chromium.launch(options);
      break;
    } catch {
      // the next build
    }
  }
  if (!browser) throw new Error('No Chromium build could be launched. Set DOMINO_BROWSER_PATH.');
});

after(async () => {
  await closeBrowser(browser);
  await new Promise((done) => server.close(done));
});

/** What the server sends for `path`, exactly, asked as a page (node:http: no browser in between). */
const raw = (path, method = 'GET') =>
  new Promise((done, fail) => {
    httpRequest(`${origin}${path}`, { method, headers: { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', Accept: 'text/html' } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => done({ status: response.statusCode, headers: response.headers, body }));
    }).on('error', fail).end();
  });

const metaOf = (html, attribute, name) => new RegExp(`<meta ${attribute}="${name.replace(/[.:]/g, '\\$&')}" content="([^"]*)" />`).exec(html)?.[1] ?? null;

/** A fresh visitor whose every CSP violation is kept on the page. */
async function visitor(viewport = { width: 1280, height: 860 }) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
  });
  return { context, page: await context.newPage() };
}

const address = (page) => page.evaluate(() => `${location.pathname}${location.search}${location.hash}`);
const titled = (page, title) => page.waitForFunction((want) => document.title === want, title, { timeout: 30_000 });

test('each address answers with its own head in the raw HTML: the listed pages, the others, a 404, the 301s, the files', async () => {
  for (const [path, words] of Object.entries(PAGES)) {
    const { status, body, headers } = await raw(path);
    assert.equal(status, 200, path);
    assert.equal(/<title>([^<]*)<\/title>/.exec(body)?.[1], words.title, path);
    assert.equal(metaOf(body, 'name', 'description'), words.description, path);
    assert.equal(/<link rel="canonical" href="([^"]*)" \/>/.exec(body)?.[1], `https://domino.money${path}`, path);
    assert.equal(metaOf(body, 'property', 'og:title'), words.social ?? words.title, path);
    assert.equal(metaOf(body, 'property', 'og:description'), words.description, path);
    assert.equal(metaOf(body, 'property', 'og:url'), `https://domino.money${path}`, path);
    assert.equal(metaOf(body, 'property', 'og:image'), 'https://domino.money/og.png', path);
    assert.doesNotMatch(body, /id="dm-head"/, `${path}: the table stays at the edge`);
    // 127.0.0.1 is not domino.money: noindex stays, search switched on or not.
    assert.equal(headers['x-robots-tag'], 'noindex, nofollow', path);
  }
  const other = await raw(`/pool/${POOL}/${TOKEN}`);
  assert.equal(other.status, 200);
  assert.equal(metaOf(other.body, 'name', 'robots'), 'noindex');
  assert.doesNotMatch(other.body, /rel="canonical"/);
  for (const path of ['/nope', '/docs/nope', '/markets/nope']) assert.equal((await raw(path)).status, 404, path);
  for (const [path, own] of [['/explore', '/markets'], ['/docs/', '/docs'], ['/docs/stop-loss', '/docs/auto-exit'], ['/settings', '/docs']]) {
    const moved = await raw(path);
    assert.deepEqual([moved.status, moved.headers.location], [301, `${origin}${own}`], path);
  }
  const head = await raw('/docs/risks', 'HEAD');
  assert.deepEqual([head.status, head.body], [200, '']);
  const sitemap = await raw('/sitemap.xml');
  assert.equal(sitemap.status, 200);
  // Changed on purpose 2026-11-07 (the owner: a Docs page for Season 1 of points): 30, the docs' Points page among them;
  // the Points page itself stays out of search.
  assert.equal([...sitemap.body.matchAll(/<loc>https:\/\/domino\.money\/[^<]*<\/loc>/g)].length, 30);
  assert.match(sitemap.body, /<loc>https:\/\/domino\.money\/docs\/points<\/loc>/);
  assert.doesNotMatch(sitemap.body, /<loc>https:\/\/domino\.money\/points<\/loc>/);
  assert.equal((await raw('/og.png')).status, 200);
  // robots.txt stays Cloudflare's managed file on domino.money (PROPOSAL.md §5): the site itself serves none.
  assert.equal((await raw('/robots.txt')).status, 404);
});

/** Every link from before, the clean address it becomes, and the tab the screen it opens names. */
const OLD_LINKS = [
  ['/#/', '/', PAGES['/'].title],
  ['/', '/', PAGES['/'].title],
  ['/#/markets', '/markets', 'Markets · Domino'],
  ['/#/explore', '/markets', 'Markets · Domino'],
  ['/#/pools', '/markets', 'Markets · Domino'],
  [`/#/markets/${TOKEN}`, `/markets/${TOKEN}`, 'Token pools · Domino'],
  [`/#/explore/${TOKEN}`, `/explore/${TOKEN}`, 'Token pools · Domino'],
  ['/#/new', '/new', 'New position · Domino'],
  ['/#/positions', '/positions', 'Positions · Domino'],
  ['/#/app', '/positions', 'Positions · Domino'],
  ['/#/portfolio', '/positions', 'Positions · Domino'],
  ['/#/positions/123', '/positions/123', 'Position #123 · Domino'],
  ['/#/positions/receipts', '/positions/receipts', 'Receipts · Domino'],
  ['/#/automate', '/automate', 'Automate · Domino'],
  ['/#/docs', '/docs', 'Docs · Domino'],
  ['/#/settings', '/docs', 'Docs · Domino'],
  ['/#/docs/risks', '/docs/risks', 'Risks · Docs · Domino'],
  ['/#/docs/stop-loss', '/docs/auto-exit', PAGES['/docs/auto-exit'].title],
  ['/#/docs/domino-compounder', '/docs/domino-compound', PAGES['/docs/domino-compound'].title],
  [`/#/pool/${POOL}/${TOKEN}`, `/pool/${POOL}/${TOKEN}`, 'Pool · Domino'],
  ['/#/sequence/compound', '/sequence/compound', 'Set up Auto-compound · Domino'],
  ['/#/setup', '/setup', 'Setup · Domino'],
  // The second chain's section is closed on this origin (src/chains/elysium/mode.ts), so not found, as before.
  ['/#/elysium', '/elysium', 'Page not found · Domino'],
  ['/#/nope', '/nope', 'Page not found · Domino'],
  // A wallet app's return link (components/wallet/WalletSessionDialog.tsx) and a shared link with a tracking query.
  ['/?ref=wallet#/new', '/new?ref=wallet', 'New position · Domino'],
  // Mistyped or crafted with a second slash or a backslash (review 2026-11-07): as a path it names another host, so the
  // address is left as it is. Changed on purpose 2026-11-07 (merge with the launch sweep's not-found rule, App.tsx
  // parseHash): an empty segment names no page, so such a link shows not found, where production showed Home.
  ['/#//markets', '/#//markets', 'Page not found · Domino'],
  ['/#//evil.example/x', '/#//evil.example/x', 'Page not found · Domino'],
  ['/#/\\evil.example', '/#/\\evil.example', 'Page not found · Domino'],
];

test('every link from before opens the same screen, at its clean address, in place: one history entry, no reload', async () => {
  const { context, page } = await visitor();
  try {
    for (const [link, clean, title] of OLD_LINKS) {
      await page.goto(`${origin}${link}`, { waitUntil: 'domcontentloaded' });
      await titled(page, title);
      assert.equal(await address(page), clean, link);
      // The same document from start to finish: the conversion never reloads.
      assert.equal(await page.evaluate(() => performance.getEntriesByType('navigation').length), 1, link);
    }
    // A fresh tab: the old link takes exactly the entries a clean link takes, its own replaced in place.
    const entries = async (link, title) => {
      const fresh = await context.newPage();
      await fresh.goto(`${origin}${link}`);
      await titled(fresh, title);
      const out = [await address(fresh), await fresh.evaluate(() => history.length)];
      await fresh.close();
      return out;
    };
    const [, clean] = await entries('/docs/risks', 'Risks · Docs · Domino');
    assert.deepEqual(await entries('/#/docs/risks', 'Risks · Docs · Domino'), ['/docs/risks', clean]);
    assert.deepEqual(await page.evaluate(() => window.__csp), [], 'no CSP violation on any screen');
  } finally {
    await context.close();
  }
});

test('a link from before that names another host as a path never stops the app: it draws, nothing is thrown, and the site’s links still move', async () => {
  const { context, page } = await visitor();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  try {
    for (const [link, title] of [['/#//evil', 'Page not found · Domino'], ['/#/\\evil', 'Page not found · Domino'], ['/#//evil.example/x', 'Page not found · Domino'], ['/?ref=1#//markets', 'Page not found · Domino']]) {
      await page.goto(`${origin}${link}`, { waitUntil: 'domcontentloaded' });
      await titled(page, title);
      assert.ok(await page.evaluate(() => document.getElementById('root').childElementCount > 0), `${link}: the app is drawn`);
      assert.equal(await page.evaluate(() => location.origin), origin, `${link}: still this site`);
    }
    // Typed while the app is open: Home, as before, and the header's links still move without a reload.
    await page.goto(`${origin}/markets`);
    await titled(page, 'Markets · Domino');
    await page.evaluate(() => {
      window.__same = 'document';
      location.hash = '#//evil.example/y';
    });
    // Not found, as any address with an empty segment (App.tsx parseHash), and nothing thrown.
    await titled(page, 'Page not found · Domino');
    assert.equal(await address(page), '/markets#//evil.example/y');
    await page.locator('header').getByRole('link', { name: 'Markets', exact: true }).first().click();
    await titled(page, 'Markets · Domino');
    assert.deepEqual([await address(page), await page.evaluate(() => window.__same)], ['/markets', 'document']);
    assert.deepEqual(errors, [], 'no error on the page');
  } finally {
    await context.close();
  }
});

test('a section link from before lands on its section: Home’s and a docs page’s, on a computer and a phone', async () => {
  for (const viewport of [{ width: 1280, height: 860 }, { width: 390, height: 844 }]) {
    const { context, page } = await visitor(viewport);
    try {
      for (const [link, clean, id] of [['/#/#learn', '/#learn', 'learn'], ['/#/docs/fees#network-gas', '/docs/fees#network-gas', 'network-gas'], ['/docs/fees#network-gas', '/docs/fees#network-gas', 'network-gas']]) {
        await page.goto(`${origin}${link}`);
        await page.waitForFunction((section) => {
          const target = document.getElementById(section);
          return target !== null && window.scrollY > 0 && Math.abs(target.getBoundingClientRect().top) < 300;
        }, id, { timeout: 30_000 });
        assert.equal(await address(page), clean, `${link} at ${viewport.width} px`);
      }
    } finally {
      await context.close();
    }
  }
});

test('the site’s links move without a reload; Back, Forward and a reload on a deep address work; a modified click opens a new tab', async () => {
  const { context, page } = await visitor();
  try {
    await page.goto(`${origin}/`);
    await titled(page, PAGES['/'].title);
    await page.evaluate(() => {
      window.__same = 'document';
    });
    const before = await page.evaluate(() => history.length);
    const markets = page.locator('header').getByRole('link', { name: 'Markets', exact: true }).first();
    assert.equal(await markets.getAttribute('href'), '/markets', 'a clean link, which a crawler follows');
    await markets.click();
    await titled(page, 'Markets · Domino');
    assert.deepEqual([await address(page), await page.evaluate(() => [window.__same, history.length])], ['/markets', ['document', before + 1]], 'one entry, the same document');
    await page.goBack();
    await titled(page, PAGES['/'].title);
    assert.deepEqual([await address(page), await page.evaluate(() => window.__same)], ['/', 'document']);
    await page.goForward();
    await titled(page, 'Markets · Domino');
    assert.equal(await address(page), '/markets');
    // A link from before typed or followed while the app is open.
    await page.evaluate(() => {
      location.hash = '#/docs';
    });
    await titled(page, 'Docs · Domino');
    assert.deepEqual([await address(page), await page.evaluate(() => window.__same)], ['/docs', 'document']);
    // A docs page, then a section of it from its own contents.
    await page.locator('main').getByRole('link', { name: 'Fees', exact: true }).first().click();
    await titled(page, PAGES['/docs/fees'].title);
    assert.equal(await address(page), '/docs/fees');
    const toc = page.locator('nav[aria-label="On this page"] a').nth(1);
    const href = await toc.getAttribute('href');
    assert.match(href, /^\/docs\/fees#[a-z0-9-]+$/);
    await toc.click();
    await page.waitForFunction((want) => `${location.pathname}${location.hash}` === want, href);
    assert.equal(await page.evaluate(() => window.__same), 'document');
    // A reload on a deep address opens it again.
    await page.reload();
    await titled(page, PAGES['/docs/fees'].title);
    assert.equal(await address(page), href);
    // Ctrl+click: the browser's own new tab, at the clean address.
    const link = page.locator('header').getByRole('link', { name: 'Markets', exact: true }).first();
    const [tab] = await Promise.all([context.waitForEvent('page'), link.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] })]);
    await tab.waitForLoadState('domcontentloaded');
    assert.equal(new URL(tab.url()).pathname, '/markets');
    await titled(tab, 'Markets · Domino');
    assert.equal(await address(page), href, 'the open tab stays where it was');
    assert.deepEqual(await page.evaluate(() => window.__csp), []);
  } finally {
    await context.close();
  }
});

test('an address the app has nothing at shows the same "This page doesn’t exist" screen, as a 404', async () => {
  const { context, page } = await visitor();
  try {
    const response = await page.goto(`${origin}/nope`);
    assert.equal(response.status(), 404);
    await titled(page, 'Page not found · Domino');
    assert.equal(await address(page), '/nope');
    await page.locator('main').getByRole('link', { name: 'Go to Home' }).click();
    await titled(page, PAGES['/'].title);
    assert.equal(await address(page), '/');
  } finally {
    await context.close();
  }
});
