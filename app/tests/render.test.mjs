/**
 * Serves the production build and drives it in a real browser.
 *
 * This exists because `tsc --noEmit && vite build` stayed green while the
 * deployed page rendered nothing: two copies of React ended up in the bundle
 * and the first hook threw. Compilation cannot see that. Only loading the
 * built files can, so every assertion below runs against `dist`, never against
 * the dev server and never against source.
 *
 * The browser is whatever Chromium build the machine already has — Chrome on
 * the CI runner, Edge on a Windows workstation — so no browser download is
 * added to the install.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { closeBrowser } from './support/close-browser.mjs';
import { TEXT_FILE, findForbidden } from '../scripts/deploy-markers.mjs';
import { apiOf, close, dexOf, go, leaving, open as openPage, problemsOf, reload, shown, watch } from './page-watch.mjs';
import { feesAnswer } from './support/fees/stub.mjs';

const DIST = resolve(import.meta.dirname, '../dist');
async function captureUI(page, name, selector, { animations = 'disabled', fullPage = false } = {}) {
  if (!process.env.DOMINO_UI_CAPTURE_DIR) return;
  await mkdir(process.env.DOMINO_UI_CAPTURE_DIR, { recursive: true });
  const target = selector ? page.locator(selector) : page;
  await target.screenshot({ path: join(process.env.DOMINO_UI_CAPTURE_DIR, `${name}.png`), animations, ...(!selector ? { fullPage } : {}) });
}
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  // 2026-09-27: the docs' pictures (public/docs/*.webp), as Pages serves them.
  '.webp': 'image/webp',
};

if (!existsSync(join(DIST, 'index.html'))) {
  throw new Error('dist/index.html is missing. Run `npm run build` before this test.');
}

/** Static file server for dist, with an index fallback so hash routes load. */
function serveDist() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // 2026-09-24 (P6, R-8): the fees relay's routes answer as the test servers' default does (every position
    // not_found), since the production build asks /api/fees/v1/state once a position's read settles.
    if (url.pathname.startsWith('/api/fees/')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const fees = feesAnswer(req.method, url.pathname, Buffer.concat(chunks).toString('utf8')) ?? { status: 404, body: '{"v":1,"error":"bad_request"}' };
      res.writeHead(fees.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(fees.body);
      return;
    }
    let file = normalize(join(DIST, decodeURIComponent(url.pathname)));
    if (!file.startsWith(DIST)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    } catch {
      // Only extension-less paths fall back to the app shell. A missing asset
      // must be a real 404, or a broken image would load as HTML with a 200
      // and the artwork test could never see it.
      if (extname(file)) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      file = join(DIST, 'index.html');
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(res);
  });
}

let server;
let browser;
let origin;

// Chrome ships on the CI image, Edge on a Windows workstation. Set
// DOMINO_BROWSER_PATH to point at any other Chromium build.
const LAUNCHES = process.env.DOMINO_BROWSER_PATH
  ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }]
  : [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}];

before(async () => {
  server = serveDist();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;

  const failures = [];
  for (const options of LAUNCHES) {
    try {
      browser = await chromium.launch(options);
      break;
    } catch (error) {
      failures.push(`${options.channel ?? 'bundled chromium'}: ${String(error).split('\n')[0]}`);
    }
  }
  if (!browser) {
    throw new Error(`No Chromium build could be launched.\n${failures.join('\n')}`);
  }
});

after(async () => {
  await closeBrowser(browser);
  await new Promise((done) => server.close(done));
});

/**
 * A page on `route`, recording every error the browser reports, handed over
 * only once the route shows what it is going to show and its reads are off
 * the wire (page-watch.mjs). The artwork test deliberately probes one
 * missing file; nothing else about it is excused.
 */
const open = (route = '/') => openPage(browser, { origin, route, ignore: (problem) => problem.includes('nosuchtoken') });

/** Nothing the browser reported on this page was the page's own doing. */
const clean = (page, label) => assert.deepEqual(problemsOf(page), [], `${label} reported browser errors`);

/**
 * What a screen that shows the selected pools asks before it reads them: the
 * stored namespace's capabilities, then the legacy read namespace on a site
 * with no /api. Its not_connected answer ends the load, so the estimate
 * namespace is never asked and no data POST is sent.
 */
// Changed on purpose (2026-09-26, featured pools v1 §11.1): the featured list's one POST goes first. With no /api
// behind this server it meets the static index page (not_connected), so the page keeps the embedded list and its
// title, and the capabilities are asked as before.
const FEATURED = 'POST /api/read/v5/featured-pools';
const CAPABILITIES = [FEATURED, 'GET /api/read/v3/capabilities', 'GET /api/read/v1/capabilities'];

test('the built landing page renders its content without a single browser error', async () => {
  const page = await open('/');

  const body = await page.locator('#root').innerText();
  assert.ok(body.length > 500, `the page rendered only ${body.length} characters of text`);
  assert.match(body, /Domino/);
  // The headline proves Home rendered; its funding examples name the supported origin networks separately.
  assert.match(body, /Earn fees\.\s*Keep control\./);

  // The blank-page failure left an empty root behind while the HTML shell and
  // the script both loaded fine, so the text assertion above is the real gate.
  clean(page, 'landing');
  await close(page);
});

test('exactly one React instance rendered the page', async () => {
  // The blank-page failure came from two React copies in one bundle. Each
  // copy stamps DOM nodes with its own random key suffix (__reactFiber$xxxx),
  // so the number of distinct suffixes on the page is the number of Reacts.
  // This asserts in every environment; it does not depend on DevTools.
  const page = await open('/');
  const suffixes = await page.evaluate(() => {
    const found = new Set();
    for (const el of document.querySelectorAll('#root, #root *')) {
      for (const key of Object.keys(el)) {
        const m = /^__reactFiber(\$.+)$/.exec(key);
        if (m) found.add(m[1]);
      }
    }
    return Array.from(found);
  });
  assert.equal(suffixes.length, 1, `React key suffixes on the page: ${JSON.stringify(suffixes)}`);
  clean(page, 'singleton');
  await close(page);
});

/**
 * Home, the three places in the header, the older spellings App.tsx keeps for them, the page the menu and the footer add,
 * the docs with one of their pages, and the owner's two wallet screens. Changed on purpose (2026-09-27, the owner's
 * round 6, point 6): the Settings page is gone; `/settings` stays here as an older spelling, which opens the docs.
 */
const ROUTES = ['/', '/markets', '/explore', '/pools', '/positions', '/app', '/portfolio', '/new', '/automate', '/settings', '/docs', '/docs/non-custodial', '/setup', '/sequence'];

test('every route in the header renders', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  // This route-render check has no data service. Its optional market fallback must be deterministic offline too.
  await context.route('https://api.dexscreener.com/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  for (const [route, expected, settled] of [
    ['/', /Earn fees\.\s*Keep control\./],
    ['/markets', /Markets[\s\S]*Token name or address[\s\S]*Selected pools/],
    [`/markets/0x${'1'.repeat(40)}`, /Markets[\s\S]*Search the pool catalogue/],
    // Changed on purpose 2026-10-01 (audit B8): a pool page with no token, for a pool outside the list, says in plain words
    // how to open it once the list has answered and nothing can verify it by its id (no read service behind this
    // server): no "selected six", no hex id.
    [`/pool/0x${'2'.repeat(64)}`, /Open this pool from Markets[\s\S]*This link doesn’t say which token to check the pool with\./],
    ['/explore', /Markets[\s\S]*Token name or address[\s\S]*Selected pools/],
    ['/pools', /Markets[\s\S]*Token name or address[\s\S]*Selected pools/],
    ['/positions', /Positions[\s\S]*Your positions[\s\S]*Receipts/],
    ['/app', /Positions[\s\S]*Your positions[\s\S]*Receipts/],
    ['/portfolio', /Wallet/],
    ['/new', /New position/],
    ['/automate', /Automate[\s\S]*Auto-compound[\s\S]*Domino-compound/],
    // Changed on purpose (2026-09-27, the owner's round 6, point 6): the Settings page is gone, and an old link to it
    // opens the docs, which say what it said.
    ['/settings', /Docs[\s\S]*What Domino is[\s\S]*Non-custodial/],
    ['/docs', /Docs[\s\S]*What Domino is[\s\S]*Non-custodial/],
    ['/docs/non-custodial', /Non-custodial[\s\S]*On this page/],
    // The owner's wallet screens ship in the deployable build (vite.config.ts MODES: wallet true). Signed out, with no release behind this server and no
    // saved profile, neither offers an owner card with no way into it (changed on purpose, qa:visual dead ends), and Sequence says in one plain line
    // that there is nothing to manage. Each is read once its release has answered. Changed on purpose (Create position): a position is opened from
    // New position's last step, so Setup no longer asks for a wallet to deposit; one line points there instead.
    ['/setup', /Deposits and recovery[\s\S]*Opening a position\? Start with New position\./, '[data-setup-release="unavailable"]'],
    // Changed on purpose (2026-09-24, the owner's simpler automation page): its title is its one action, and without a release it says so.
    // Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, §8): the deployable build carries Domino V2, whose choices never
    // wait for V1's sequence release (its profile ends 2026-10-21 and is not renewed): with none behind this server the page
    // goes on to the wallet's positions, here asking for a wallet, and never says it can't be set up.
    ['/sequence', /Set up automation[\s\S]*Connect your wallet[\s\S]*Your open positions appear here to choose from\./, '[data-sequence-wallet="none"]'],
  ]) {
    const page = await openPage(context, { origin, route });
    if (settled) await page.locator(settled).waitFor({ state: 'attached' });
    const body = await page.locator('#root').innerText();
    assert.match(body, expected, `route ${route}`);
    if (settled) assert.doesNotMatch(body, /owner recovery|Owner controls|\byet\b/i, `route ${route}: no owner card without a release or a saved profile`);
    assert.ok(body.length > 200, `route ${route} rendered almost nothing`);
    clean(page, `route ${route}`);
    await close(page);
  }
});

test('the header names the three places, each at its route, and marks the one that is open', async () => {
  // Markets is lit on its page and its older spellings; Positions on its own, its older spellings and the flow it leads to; Home and the docs light nothing,
  // and so does `/settings`, an older spelling of the docs since the owner removed Settings (2026-09-27, round 6, point 6).
  const LIT = { '/': null, '/markets': 'Markets', '/explore': 'Markets', '/pools': 'Markets', '/positions': 'Positions', '/app': 'Positions', '/portfolio': 'Positions', '/new': 'Positions', '/automate': 'Automate', '/settings': null, '/docs': null, '/docs/non-custodial': null, '/setup': 'Automate', '/sequence': 'Automate' };
  for (const route of ROUTES) {
    const page = await open(route);
    // One nav in the header: the phone list lives in the menu, which renders only when open.
    assert.equal(await page.locator('header nav[aria-label="Main"]').count(), 1, `one main nav on ${route}`);
    const nav = page.locator('header nav[aria-label="Main"]').first();
    const links = await nav.locator('a').evaluateAll((els) => els.map((a) => [a.textContent.trim(), a.getAttribute('href'), a.getAttribute('aria-current')]));
    const current = (name) => (LIT[route] === name ? 'page' : null);
    assert.deepEqual(links, [
      ['Markets', '#/markets', current('Markets')],
      ['Positions', '#/positions', current('Positions')],
      ['Automate', '#/automate', current('Automate')],
    ], `header on ${route}`);
    assert.equal(await page.locator('header .dm-wordmark').getAttribute('aria-current'), route === '/' ? 'page' : null);
    assert.equal(await nav.getAttribute('data-home'), route === '/' ? '' : null);
    clean(page, `header on ${route}`);
    await close(page);
  }
});

test('Home navigation is neutral until hovered or focused, and only the current page stays orange', async () => {
  const page = await openSimulator();
  const nav = page.locator('header nav[aria-label="Main"]');
  const markets = nav.getByRole('link', {name:'Markets',exact:true});
  const positions = nav.getByRole('link', {name:'Positions',exact:true});
  const color = locator => locator.evaluate(el=>getComputedStyle(el).color);
  const neutral = await color(markets);
  assert.equal(await color(positions),neutral);
  assert.equal(await nav.locator('[aria-current="page"]').count(),0);
  await captureUI(page,'navigation-home-neutral','header');
  await markets.hover();
  await page.waitForTimeout(220);
  assert.notEqual(await color(markets),neutral);
  assert.equal(await color(positions),neutral,'hovering one link does not light its neighbors');
  await captureUI(page,'navigation-home-hover','header');
  await page.mouse.move(0,0);
  // Programmatic focus after a pointer action need not match :focus-visible. Exercise an actual keyboard step.
  await markets.focus();
  await page.keyboard.press('Tab');
  assert.equal(await positions.evaluate(el => el === document.activeElement && el.matches(':focus-visible')), true, 'Tab reaches Positions with visible keyboard focus');
  await page.waitForTimeout(220);
  assert.notEqual(await color(positions),neutral,'keyboard focus has the same emphasis');
  assert.equal(await positions.evaluate(el => {
    const style = getComputedStyle(el);
    return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2;
  }), true, 'keyboard focus has an outline as well as a color change');
  await page.keyboard.press('Enter');
  await shown(page,'/positions');
  assert.equal(await positions.getAttribute('aria-current'),'page');
  await page.mouse.move(0,0);
  await page.locator('header .dm-wordmark').focus();
  await page.waitForTimeout(220);
  assert.notEqual(await color(positions),neutral,'selection remains lit away from the pointer');
  assert.equal(await color(markets),neutral);
  await captureUI(page,'navigation-position-selected','header');
  clean(page,'navigation interaction');
  await close(page);
});

test('the mobile Positions screen leads to Markets: reachable, bounded to the viewport, and idle until a read is requested', async () => {
  const page = await open('/app');
  assert.equal(await page.locator('header').getByRole('link', { name: 'Markets', exact: true }).first().getAttribute('href'), '#/markets');
  await page.setViewportSize({ width: 375, height: 812 });
  const entrance = page.locator('main').getByRole('link', { name: 'Markets', exact: true });
  assert.equal(await entrance.isVisible(), true, 'the mobile Positions screen has a visible entrance');
  await entrance.click();
  await page.getByRole('heading', { name: 'Markets', exact: true }).waitFor();
  // The lazy network adapter's fallback already has this heading. Wait for the real table's answer before counting reads.
  await page.waitForFunction(() => document.querySelector('[data-selected-pools] [data-read-status]')?.getAttribute('data-read-status') === 'not_connected');
  await shown(page, '/markets');
  // The selected pools are on the page, so Markets asks the featured list and the capabilities the way the landing does, and posts nothing else.
  const trail = () => [...(apiOf(page).at(-1) ?? [])];
  assert.deepEqual(trail(), CAPABILITIES, 'Markets asks the list and checks each needed namespace once');

  // The main token search is the only text search; typing a Robinhood address reads nothing until it is chosen.
  const address = '0x1111111111111111111111111111111111111111';
  const combobox = page.getByRole('combobox', { name: 'Token name or address' });
  assert.equal(await combobox.isVisible(), true);
  assert.equal(await page.getByRole('combobox', { name: 'Asset', exact: true }).isVisible(), true, 'the token filter remains available');
  assert.equal(await page.getByPlaceholder('Pair', { exact: true }).count(), 0, 'no second text filter beneath Top pools');
  await combobox.fill(address);
  assert.equal(await combobox.inputValue(), address);
  await page.waitForTimeout(300);
  assert.deepEqual(trail(), CAPABILITIES, 'an address in the token search reads nothing until it is chosen');

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `Markets scrolls ${overflow}px sideways at 375px`);
  assert.doesNotMatch(await page.locator('main').innerText(), /\$\s?\d|\b0(?:\.0+)?%/, 'no figures before any answer');
  assert.equal(await page.locator('main [data-metric], main [data-apr-estimate]').count(), 0, 'no figure on Markets before any answer');
  assert.equal(await page.locator('[role="dialog"]').count(), 0, 'nothing opens over the page');
  clean(page, 'mobile Markets');
  await close(page);
});

test('every form field on every route can be identified by the browser', async () => {
  // Chrome flags fields with neither an id nor a name: autofill and
  // password managers cannot tell them apart.
  for (const route of ROUTES) {
    const page = await open(route);
    const anonymous = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, select, textarea'))
        .filter((el) => !el.id && !el.getAttribute('name'))
        .map((el) => el.outerHTML.slice(0, 120)),
    );
    assert.deepEqual(anonymous, [], `route ${route} has form fields without an id or name`);
    clean(page, `form fields on ${route}`);
    await close(page);
  }
});

test('no dollar figure appears on any route when no read has answered', async () => {
  for (const route of ROUTES) {
    const page = await open(route);
    await page.waitForTimeout(100);
    const text = await page.locator('#root').innerText();
    const found = text.match(/.{0,40}\$\s?\d.{0,20}/)?.[0];
    assert.equal(found, undefined, `route ${route} shows a dollar figure: ${found}`);
    clean(page, `dollars on ${route}`);
    await close(page);
  }
});

test('every token the app shows has real artwork, and an unknown one still gets a disc', async () => {
  // The landing's own marks. A pool row's tokens show a plain disc until their
  // artwork is tied to their address, and no mark may be a lettered fallback.
  const page = await open('/');
  // Let every mark either decode or fall back before looking.
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('img[src*="/tokens/"]')).every((img) => img.complete),
  );

  // The labelled OP Mainnet network mark intentionally uses its initials; it is not a token fallback.
  const opMarks = page.locator('.dm-network-mark[data-network="OP Mainnet"]');
  assert.equal(await opMarks.count(), 2, 'the hero and funding section identify OP Mainnet');
  for (const mark of await opMarks.all()) {
    assert.equal(await mark.getAttribute('aria-hidden'), 'true', 'the neighbouring network name labels the decorative mark');
    assert.equal(await mark.innerText(), 'OP');
    assert.match(await mark.evaluate(el => el.parentElement.textContent), /OP Mainnet/);
  }
  // Every registered token still needs artwork. No other lettered disc is exempt from the fallback guard.
  const discs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('span[aria-hidden="true"]'))
      .filter(el => !el.matches('.dm-network-mark[data-network="OP Mainnet"]'))
      .map((el) => el.textContent.trim())
      .filter((t) => /^[A-Z]{1,3}$/.test(t)),
  );
  assert.deepEqual(discs, [], `lettered discs on screen for: ${discs.join(', ')}`);

  // And every mark actually decoded to pixels, so a 200 for a broken file
  // cannot pass as artwork.
  const images = await page.evaluate(() =>
    Array.from(document.querySelectorAll('img[src*="/tokens/"]')).map((img) => ({
      src: img.getAttribute('src'),
      ok: img.complete && img.naturalWidth > 0,
    })),
  );
  assert.ok(images.length >= 1, `only ${images.length} token marks rendered`);
  const broken = images.filter((i) => !i.ok).map((i) => i.src);
  assert.deepEqual(broken, [], `token marks that failed to decode: ${broken.join(', ')}`);

  // The fallback itself still works for a symbol with no file, and does not
  // break layout or throw.
  const fallback = await page.evaluate(async () => {
    const img = new Image();
    const loaded = await new Promise((r) => { img.onload = () => r(true); img.onerror = () => r(false); img.src = '/tokens/nosuchtoken.svg'; });
    return loaded;
  });
  assert.equal(fallback, false, 'the missing-file path must stay reachable for the fallback to matter');
  clean(page, 'token artwork');
  await close(page);
});

test('the page survives a narrow viewport without spilling sideways', async () => {
  const page = await open('/');
  await page.setViewportSize({ width: 375, height: 812 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  assert.ok(overflow <= 1, `the page scrolls ${overflow}px horizontally at 375px wide`);
  clean(page, 'narrow viewport');
  await close(page);
});

// Changed on purpose 2026-10-03 (the owner: Domino covers more than one network now, and the footer had two things too
// many): the footer holds no control at all (Pause motion is gone; reduced motion still stills the page), no Network
// column, and names no chain. It was the motion control's overlap check (and before that the appearance toggle's).
for (const [width, height] of [[390, 844], [768, 1024], [1280, 800]]) {
  test(`at ${width}x${height} the footer holds the brand and its two link columns, no control and no network`, async () => {
    const page = await open('/');
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(100);
    assert.equal(await page.locator('footer button').count(), 0, 'no control in the footer');
    assert.deepEqual(await page.locator('footer nav').evaluateAll((navs) => navs.map((nav) => nav.getAttribute('aria-label'))), ['Product', 'Guides']);
    for (const name of ['Product', 'Guides']) assert.equal(await page.locator('footer').getByRole('heading', { name, exact: true }).isVisible(), true, 'each group has a visible title');
    assert.doesNotMatch(await page.locator('footer').innerText(), /Network|Robinhood|Pause motion/);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dm-still')), false, 'nothing stills the page by itself');
    clean(page, `footer at ${width}px`);
    await close(page);
  });
}

// Owner, 2026-09-26: dark only. One palette, whatever the system asks for, and nothing to switch it with.
test('the site is dark whatever the system asks for, and offers no light theme', async () => {
  const page = await open('/');
  for (const scheme of ['light', 'dark', 'no-preference']) {
    await page.emulateMedia({ colorScheme: scheme });
    const look = await page.evaluate(() => ({
      scheme: getComputedStyle(document.documentElement).colorScheme,
      page: getComputedStyle(document.documentElement).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
      text: getComputedStyle(document.body).color,
      classes: document.documentElement.className.split(/\s+/).filter((name) => /dark|light|theme/i.test(name)),
      themed: document.documentElement.hasAttribute('data-theme'),
    }));
    assert.deepEqual(look, { scheme: 'dark', page: 'rgb(13, 12, 10)', body: 'rgb(13, 12, 10)', text: 'rgb(247, 241, 234)', classes: [], themed: false }, `system ${scheme}`);
  }
  assert.equal(await page.getByRole('button', { name: /light|dark|appearance|theme/i }).count(), 0, 'no control to change the look');
  clean(page, 'dark only');
  await close(page);
});

test('dist carries no theme switch: no light palette, no theme selector, no stored appearance', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else files.push(join(dir, entry.name));
    }
  };
  walk(DIST);
  const css = files.filter((file) => file.endsWith('.css'));
  assert.ok(css.length >= 1, 'the stylesheet is in dist');
  const text = files.filter((file) => TEXT_FILE.test(file)).map((file) => readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(text, /domino-appearance/, 'nothing reads or writes the old appearance key');
  assert.doesNotMatch(text, /prefers-color-scheme/, 'the system setting is not consulted');
  const styles = css.map((file) => readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(styles, /\.dark\b|\[data-theme|color-scheme:\s*light/, 'no theme selector and no light palette');
  assert.match(styles, /color-scheme:\s*dark/, 'the one palette is dark');
});

// 2026-09-28 (speed wave, item 35): the fonts are the site's own files, the ones Google Fonts served (tests/fonts.test.mjs
// checks the sources). In the build every @font-face points at a woff2 file under /assets/ that dist carries, byte for
// byte one of src/fonts/, never a data: URL (the CSP's font-src is 'self') and never Google; and Home draws its
// text in Geist and its titles in Instrument Serif, from this origin.
test('the fonts are the site’s own files under /assets/, and Home loads them from this origin', async () => {
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const assets = readdirSync(join(DIST, 'assets'));
  const styles = assets.filter((file) => file.endsWith('.css')).map((file) => readFileSync(join(DIST, 'assets', file), 'utf8')).join('\n');
  // 2026-10-01 (platform workstream, F9): and four faces of local fonts matched to them (src/styles/font-fallbacks.css),
  // which load no file.
  const allFaces = styles.match(/@font-face\{[^}]*\}/g) ?? [];
  const local = allFaces.filter((face) => /src:local\(/.test(face));
  assert.equal(local.length, 4, 'the four fallback faces');
  for (const face of local) assert.doesNotMatch(face, /url\(/, 'a fallback face loads nothing');
  const faces = allFaces.filter((face) => !local.includes(face));
  assert.equal(faces.length, 36, 'the 36 rules of src/styles/fonts.css');
  const urls = faces.map((face) => /src:url\((["']?)([^"')]+)\1\)\s*format\(["']?woff2["']?\)/.exec(face)?.[2]);
  for (const url of urls) assert.match(url ?? '', /^\/assets\/[\w-]+\.woff2$/, 'a woff2 file under /assets/');
  const sources = new Set(readdirSync(resolve(DIST, '../src/fonts')).filter((file) => file.endsWith('.woff2')).map((file) => sha(readFileSync(resolve(DIST, '../src/fonts', file)))));
  const files = [...new Set(urls)];
  assert.equal(files.length, 15);
  for (const url of files) assert.ok(sources.has(sha(readFileSync(join(DIST, url)))), `${url} is one of src/fonts/, unchanged`);
  const text = assets.filter((file) => TEXT_FILE.test(file)).map((file) => readFileSync(join(DIST, 'assets', file), 'utf8')).join('\n') + readFileSync(join(DIST, 'index.html'), 'utf8');
  assert.doesNotMatch(text, /fonts\.googleapis\.com|fonts\.gstatic\.com/, 'nothing in the build names Google Fonts');

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const fonts = [];
  page.on('request', (request) => { if (request.resourceType() === 'font') fonts.push(request.url()); });
  await page.goto(`${origin}/#/`, { waitUntil: 'networkidle' });
  await page.locator('#root h1').first().waitFor();
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((face) => face.status === 'loaded').map((face) => `${face.family.replaceAll('"', '')} ${face.style}`);
  });
  assert.ok(loaded.includes('Geist normal'), `Geist is loaded: ${loaded.join(', ')}`);
  assert.ok(loaded.includes('Instrument Serif normal'), `Instrument Serif is loaded: ${loaded.join(', ')}`);
  assert.ok(fonts.length >= 2, `Home fetched its fonts: ${fonts.join(', ')}`);
  for (const url of fonts) assert.ok(url.startsWith(`${origin}/assets/`) && url.endsWith('.woff2'), url);
  await page.close();
});

// ---------------------------------------------------------------------------
// Flow behaviour asked for on #12, exercised through the DOM of the served
// build rather than through the helpers.
// ---------------------------------------------------------------------------

/** Reads a numeric input's value as a number. */
const num = (page, sel) => page.locator(sel).inputValue().then(Number);

/**
 * CSS px per design px on this page (changed on purpose 2026-10-03, the owner: the site looks too big at 100%): the
 * root's font-size over 16 (styles/tokens.css, src/lib/rootScale.ts): compact on a desktop, full size on touch.
 */
const rootScale = (page) => page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize) / 16);

/** Sets a native range input the way a user would, so React sees the change. */
async function setRange(page, selector, value) {
  await page.locator(selector).evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

// Changed on purpose (owner, round 6, 2026-09-27: Home's simulator redone for newcomers): one price control laid over
// one picture, with no chart and no second slider. Pressing anywhere on the picture and dragging moves the price; the
// knob sits under the pointer, a still pointer holds the price still, and the range never moves.
test('dragging the price through the DOM holds a still pointer to a still price, and never moves the range', async () => {
  const page = await openSimulator();
  const stage = page.locator('[data-sim-stage]');
  await stage.scrollIntoViewIfNeeded();
  const box = await stage.boundingBox();
  const band = page.locator('#ranges .dm-sim-band');
  const bandBefore = await band.boundingBox();
  const y = box.y + box.height / 2;

  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  // Move once to the right, then keep the pointer perfectly still while firing more move events.
  const targetX = box.x + box.width * 0.62;
  await page.mouse.move(targetX, y, { steps: 4 });
  const first = await num(page, '#sim-price');
  assert.ok(first > 0, `the price did not follow the pointer (${first})`);
  const seen = [];
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(targetX, y);
    seen.push(await num(page, '#sim-price'));
  }
  const knob = await page.locator('#ranges .dm-sim-knob').boundingBox();
  await page.mouse.up();

  assert.deepEqual(seen, seen.map(() => first), `the price crept under a still pointer: ${seen.join(', ')}`);
  assert.ok(Math.abs(knob.x + knob.width / 2 - targetX) <= 3, `the knob is not under the pointer (${knob.x + knob.width / 2} against ${targetX})`);
  await page.waitForTimeout(50);
  assert.equal(await num(page, '#sim-price'), first, 'the price changed on release');
  assert.deepEqual(await band.boundingBox(), bandBefore, 'the range moved during the gesture');
  // Changed on purpose (review, 2026-09-28): the price went up, so the chip reads a rise in whole percent; at the
  // start it reads "ETH at start price" (the control test pins that), never "0%".
  assert.match(await page.locator('#ranges .dm-sim-chip').innerText(), /^ETH price \+\d+%$/, 'the chip reads a move from the start, in whole percent');
  clean(page, 'price drag');
  await close(page);
});

/** Top of an element relative to the viewport, after the app's own scroll settles. */
async function sectionTop(page, id) {
  await page.waitForTimeout(80);
  return page.evaluate((id) => document.getElementById(id)?.getBoundingClientRect().top ?? null, id);
}

/** A compact page can run out of document below its last section before that section reaches the header. */
async function assertSectionLanded(page, id) {
  await sectionTop(page, id);
  const geometry = await page.evaluate((id) => {
    const target = document.getElementById(id);
    if (!target) return null;
    const top = target.getBoundingClientRect().top;
    const header = document.querySelector('header')?.getBoundingClientRect().height ?? 0;
    const gap = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    return { top, header, viewport: innerHeight, scrollY, maxScroll, expected: Math.min(maxScroll, Math.max(0, top + scrollY - header - gap)) };
  }, id);
  assert.ok(geometry, `#${id} exists`);
  assert.ok(Math.abs(geometry.scrollY - geometry.expected) <= 2, `#${id} did not reach its header offset or the document's scroll limit: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.top >= geometry.header - 1 && geometry.top < geometry.viewport, `#${id} starts visibly below the header: ${JSON.stringify(geometry)}`);
}

test('section links land on their target, across routes and within one route', async () => {
  const page = await open('/');

  // Cross-route to a route with no section: the header's Positions link opens that screen at its top.
  leaving(page);
  await page.locator('header').getByRole('link', { name: 'Positions' }).first().click();
  await page.waitForFunction(() => location.hash === '#/positions');
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => window.scrollY), 0, 'the positions screen did not start at the top');

  // The positions screen leads to Markets; from there the footer's learn link returns to the landing section.
  leaving(page);
  await page.locator('main').getByRole('link', { name: 'Markets', exact: true }).click();
  await page.waitForFunction(() => location.hash === '#/markets');
  await page.getByRole('heading', { name: 'Markets', exact: true }).waitFor();
  leaving(page);
  await page.locator('footer').getByRole('link', { name: 'How it works' }).click();
  await page.waitForFunction(() => location.hash === '#/#learn');
  await assertSectionLanded(page, 'learn');

  // Same route, different section: only the hash section changes.
  await page.evaluate(() => { location.hash = '#/#pools'; });
  await assertSectionLanded(page, 'pools');
  await page.evaluate(() => { location.hash = '#/#ranges'; });
  await assertSectionLanded(page, 'ranges');
  await page.evaluate(() => { location.hash = '#/#learn'; });
  await assertSectionLanded(page, 'learn');

  // A route with no section starts at the top. (Changed on purpose, 2026-09-27: the docs, since Settings is gone.)
  await page.evaluate(() => { location.hash = '#/docs'; });
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => window.scrollY), 0, 'a plain route did not start at the top');
  clean(page, 'section links');
  await close(page);
});

test('every footer and navigation link goes somewhere this app has: no "#/" placeholder, no bare "#", no empty target', async () => {
  const page = await open('/');
  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll('footer a, nav a, header a')).map((a) => ({
      text: a.textContent.trim(),
      href: a.getAttribute('href'),
      footer: Boolean(a.closest('footer')),
      overview: Boolean(a.closest('header')) && a.textContent.trim() === 'domino.',
    })),
  );
  assert.ok(links.some((l) => l.footer), 'the footer has links');
  // Changed on purpose (owner, 2026-09-26): Domino's X account is the footer's one link that leaves the app, and only it.
  // It is exactly the confirmed profile, opens in a new tab with no opener and no referrer, and says so to a screen reader.
  const external = await page.evaluate(() =>
    Array.from(document.querySelectorAll('footer a')).filter((a) => !(a.getAttribute('href') ?? '').startsWith('#')).map((a) => ({
      href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel'), label: a.getAttribute('aria-label'), text: a.textContent.trim(),
    })),
  );
  assert.deepEqual(external, [{ href: 'https://x.com/dominomoney', target: '_blank', rel: 'noopener noreferrer', label: 'Domino on X (opens in a new tab)', text: '@dominomoney' }], 'the footer leaves the app only for Domino’s X account');
  // Changed on purpose (2026-09-27, the owner's round 6, point 6): Settings is gone from the footer with its page.
  assert.deepEqual(
    links.filter((l) => l.footer && l.href.startsWith('#')).map((l) => l.text),
    ['Markets', 'Positions', 'Automate', 'New position', 'Docs', 'How it works', 'Ranges', 'Risks'],
    'the footer names the product pages, the docs and the guides on the landing',
  );
  // The routes App.tsx wires, with the older spellings it keeps: `#/explore` and `#/pools` are Markets, `#/app` is Positions.
  // No link names `/settings` any more (2026-09-27): it is only an older spelling of the docs.
  const ROUTES = ['/', '/markets', '/explore', '/pools', '/pool', '/positions', '/app', '/portfolio', '/new', '/automate', '/docs'];
  for (const link of links) {
    if (link.footer && link.href === 'https://x.com/dominomoney') continue
    const label = `${link.footer ? 'footer' : 'header'} link "${link.text}" (${link.href})`;
    assert.ok(link.href !== null && link.href.trim() !== '', `${label} has no target`);
    assert.notEqual(link.href, '#', `${label} goes nowhere`);
    // "#/" is the landing route itself: only the header's wordmark may name it.
    if (link.href === '#/') assert.ok(link.overview, `${label} is a placeholder`);
    assert.ok(link.href.startsWith('#/'), `${label} leaves the app for an unconfirmed destination`);
    const raw = link.href.slice(1);
    const cut = raw.indexOf('#');
    const route = (cut === -1 ? raw : raw.slice(0, cut)) || '/';
    const section = cut === -1 ? '' : raw.slice(cut + 1);
    assert.ok(ROUTES.includes(route), `${label} names no route of this app`);
    if (section) {
      await page.evaluate((hash) => { location.hash = hash; }, link.href);
      await page.waitForFunction((id) => Boolean(document.getElementById(id)), section, { timeout: 5000 }).catch(() => {});
      assert.ok(await page.evaluate((id) => Boolean(document.getElementById(id)), section), `${label} names a section that does not exist`);
    }
  }
  // No other social link, and no legal documents until they exist: neither a link nor a line saying they will come.
  // (2026-09-26: 'X' left this list when the owner confirmed the account; its one link is pinned above.)
  const footer = page.locator('footer');
  for (const name of ['Discord', 'Telegram', 'GitHub', 'Documentation', 'Security', 'Status', 'Fees and profit']) {
    assert.equal(await footer.getByRole('link', { name, exact: true }).count(), 0, `footer still links "${name}"`);
  }
  assert.equal(await footer.getByRole('link', { name: /Terms|Privacy/ }).count(), 0, 'no legal documents are linked');
  assert.doesNotMatch(await footer.innerText(), /Terms of Service|Privacy Policy|pending/i, 'the footer names no legal document that does not exist');
  clean(page, 'footer and navigation links');
  await close(page);
});

// Changed on purpose (owner, round 6, 2026-09-27: Home's simulator redone for newcomers). The one control is a native
// slider on a log scale around the start (lib/scenario.ts SIM): its value moves the knob and the chip, says whether the
// position earns, and splits what it holds between ETH and USDG; a screen reader hears all of it in the value text.
// Changed on purpose (review, 2026-09-28): at the start the chip says "ETH at start price" ("ETH price 0%" can read as
// a price of zero), and the slider's invisible thumb is 44px wide, so its centre, the knob's, runs from 22px in from
// each end.
// Changed on purpose 2026-10-03 (the owner: the site looks too big at 100%; at 80% it looks right): those are 44 and 22
// design px, drawn at the root's scale (styles/tokens.css: 0.8 in this 1280px window), as every length on the page is.
async function openSimulator() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  watch(page);
  // These local UI checks exercise no catalogue figures. Keep unrelated live DEX reads off the network.
  await page.route('https://api.dexscreener.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto(`${origin}/#/`, { waitUntil: 'networkidle' });
  await shown(page, '/');
  await page.locator('#ranges > summary').click();
  await page.locator('#sim-price').waitFor({ state: 'visible' });
  return page;
}

test('the price control maps its value to the knob, its chip, earning or not, and what the position holds', async () => {
  const page = await openSimulator();
  const slider = page.locator('#sim-price');
  await slider.scrollIntoViewIfNeeded();
  await slider.focus();
  assert.deepEqual([await slider.getAttribute('min'), await slider.getAttribute('max'), await slider.getAttribute('step')], ['-1.1', '1.1', '0.01']);
  assert.equal(await page.locator('label[for="sim-price"]').innerText(), 'ETH price, against the start');
  const stage = await page.locator('[data-sim-stage]').boundingBox();
  const scale = await rootScale(page);

  for (const [v, chip, earning, hold, spoken] of [
    [0, 'ETH at start price', 'Inside range', ['53%', '47%'], 'ETH at its start price. Inside range. Trades can earn fees. Example mix by value: 53% ETH and 47% USDG.'],
    [0.3, 'ETH price +23%', 'Inside range', ['28%', '72%'], 'ETH up 23%. Inside range. Trades can earn fees. Example mix by value: 28% ETH and 72% USDG.'],
    [0.85, 'ETH price +80%', 'Above range', ['0%', '100%'], 'ETH up 80%. Above range. No trading fees here. Example mix by value: 0% ETH and 100% USDG.'],
    [-0.8, 'ETH price −43%', 'Below range', ['100%', '0%'], 'ETH down 43%. Below range. No trading fees here. Example mix by value: 100% ETH and 0% USDG.'],
    [-1.1, 'ETH price −53%', 'Below range', ['100%', '0%'], null],
    [1.1, 'ETH price +114%', 'Above range', ['0%', '100%'], null],
  ]) {
    await setRange(page, '#sim-price', v);
    assert.equal(await num(page, '#sim-price'), v, 'the input did not take the value');
    const knob = await page.locator('#ranges .dm-sim-knob').boundingBox();
    const expected = stage.x + 22 * scale + ((v + 1.1) / 2.2) * (stage.width - 44 * scale);
    assert.ok(Math.abs(knob.x + knob.width / 2 - expected) < 1, `knob at ${knob.x + knob.width / 2} for ${v}, expected ${expected}`);
    assert.equal(await page.locator('#ranges .dm-sim-chip').innerText(), chip);
    assert.equal(await page.locator('#ranges .dm-pill').innerText(), earning);
    assert.deepEqual(await page.locator('#ranges .dm-sim-pct').allInnerTexts(), hold);
    if (spoken) assert.equal(await slider.getAttribute('aria-valuetext'), spoken);
  }
  // The keyboard moves it one notch at a time.
  await setRange(page, '#sim-price', 0);
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  assert.equal(await num(page, '#sim-price'), 0.02);
  clean(page, 'price control');
  await close(page);
});

// Added 2026-09-28 (review of round 6): the knob a visitor sees is where the slider's own (invisible) thumb is, over
// the knob's whole column and a finger wide. iOS drags a range input only from a touch that starts inside its thumb,
// and a tap on its track does nothing there, so a thumb that sat anywhere else left the knob dead on an iPhone.
// Chromium shows it this way: a press on the thumb grabs it and leaves the value alone, a press on the track jumps it.
// Changed on purpose 2026-10-03 (the owner: the site looks too big at 100%): the thumb is 44 design px at the root's scale,
// a finger wide on a phone (scale 1) and 35px in a 1280px window (0.8), so the presses beside the knob are at that scale.
test('the simulator’s knob is the slider’s own thumb, top to bottom and a finger wide', async () => {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const page = await openSimulator();
    await page.setViewportSize(viewport);
    await page.evaluate(() => document.getElementById('ranges').scrollIntoView({ block: 'center' }));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(100);
    await setRange(page, '#sim-price', 0);
    const input = await page.locator('#sim-price').boundingBox();
    const knob = await page.locator('#ranges .dm-sim-knob').boundingBox();
    const cx = knob.x + knob.width / 2;
    const scale = await rootScale(page);
    const press = async (x, y) => {
      await setRange(page, '#sim-price', 0);
      await page.mouse.move(x, y);
      await page.mouse.down();
      const value = await num(page, '#sim-price');
      await page.mouse.up();
      return value;
    };
    const top = input.y + 2;
    const bottom = input.y + input.height - 2;
    const middle = knob.y + knob.height / 2;
    for (const y of [top, input.y + input.height / 2, middle, bottom]) {
      for (const dx of [-18, 7, 18].map((design) => design * scale)) {
        assert.equal(await press(cx + dx, y), 0, `${viewport.width}px: a press at ${dx}px from the knob, y ${y}, missed the thumb`);
      }
    }
    assert.ok(knob.y >= top && knob.y + knob.height <= bottom, `${viewport.width}px: the knob (y ${knob.y}) is outside the slider`);
    assert.notEqual(await press(cx + 60 * scale, middle), 0, `${viewport.width}px: a press well off the knob did not move the price`);
    clean(page, `simulator thumb at ${viewport.width}px`);
    await close(page);
  }
});

// The picture starts automatically; the native scrubber still owns exact prices on request.
test('the compact range scene keeps the correct token mix and fixed range without projected earnings', async () => {
  const page = await openSimulator();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const demo = page.locator('[data-sim-example]');
  await demo.scrollIntoViewIfNeeded();
  const band = await demo.locator('.dm-sim-band').boundingBox();
  for (const [state, value, mix] of [
    ['below', -0.8, ['100%', '0%']], ['inside', 0, ['53%', '47%']], ['above', 0.85, ['0%', '100%']],
  ]) {
    await setRange(page, '#sim-price', value);
    assert.equal(await demo.getAttribute('data-sim-state'), state);
    assert.deepEqual(await demo.locator('.dm-sim-pct').allInnerTexts(), mix);
    assert.deepEqual(await demo.locator('.dm-sim-band').boundingBox(), band);
    assert.equal(await demo.getAttribute('data-sim-paid'), '0');
  }
  assert.equal(await demo.locator('details[open]').count(), 0);
  await demo.locator('summary').click();
  assert.match(await demo.locator('details[open]').innerText(), /Outside it, you hold one token and stop earning trading fees/);
  assert.match(await demo.locator('details[open]').innerText(), /can lose value even when it earns fees/);
  await demo.locator('summary').click();
  assert.equal(await demo.locator('button').count(), 0, 'no replay, play, pause, preset or mode buttons');
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), []);
  for (const width of [320, 390, 960, 1280, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    // Chromium can expose the new innerWidth before applying the responsive styles: at 320px the hero still
    // measured its desktop 70.2px font and 337px scroll width until paint, then 50px and 320px. Measure after layout.
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    await setRange(page, '#sim-price', 0);
    const overflow = await page.evaluate(() => ({
      width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      elements: [...document.querySelectorAll('body *')].flatMap(element => {
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.right <= innerWidth) return [];
        return [{ tag: element.tagName, id: element.id, className: element.getAttribute('class'), right: box.right, width: box.width }];
      }).slice(0, 20),
    }));
    if (overflow.scrollWidth > overflow.width && process.env.DOMINO_FAILURE_SHOTS) {
      const directory = resolve(import.meta.dirname, '../.test-artifacts/failures');
      await mkdir(directory, { recursive: true });
      await page.screenshot({ path: join(directory, `home-overflow-${width}.png`), fullPage: true, animations: 'disabled' });
    }
    assert.equal(overflow.scrollWidth <= overflow.width, true, 'no overflow at ' + width + ': ' + JSON.stringify(overflow));
    if (width < 768) {
      const tileHeights = await page.locator('#pools tbody tr').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
      assert.ok(tileHeights.every(height => height < 128), `Home pool tiles do not inherit table cell heights: ${tileHeights}`);
    }
    const box = await demo.boundingBox();
    assert.ok(box.height < (width >= 960 ? 370 : 600), 'the scene stays compact at ' + width + ': ' + box.height);
    await captureUI(page, 'simulator-r3-' + width, '[data-sim-example]');
    if (width !== 960) {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await captureUI(page, 'home-viewport-' + width);
      await captureUI(page, 'home-r3-' + width, undefined, { fullPage: true });
      await captureUI(page, 'hero-r3-' + width, '.dm-hero');
    }
  }
  clean(page, 'compact range scene');
  await close(page);
});

test('shared decorative motion repeats, rests outside the viewport or hidden tab, and honors reduced motion', async () => {
  const page = await openSimulator();
  const features = page.locator('#funding');
  await features.scrollIntoViewIfNeeded();
  const art = features.locator('.dm-funding-demonstration');
  await page.waitForFunction(() => document.querySelector('.dm-funding-demonstration')?.classList.contains('is-running'));
  assert.ok(await art.evaluate(el => el.getAnimations({ subtree: true }).some(animation => animation.effect.getComputedTiming().iterations === Infinity)), 'the visible funding route has a repeating illustration');
  await art.evaluate(el => { el.getAnimations({ subtree: true })[0].currentTime = 20_000; });
  assert.equal(await art.evaluate(el => el.getAnimations({ subtree: true })[0].playState), 'running', 'continues beyond the old three-cycle stop');
  const reads = structuredClone(apiOf(page));
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => !document.querySelector('.dm-funding-demonstration')?.classList.contains('is-running'));
  assert.equal(await art.evaluate(el => el.getAnimations({ subtree: true })[0].playState), 'paused');
  // The pause settles on the next frame (2026-10-04, PR #335's CI: sampled while still pending, the time moved by 2 µs).
  await page.waitForFunction(() => {
    const animation = document.querySelector('.dm-funding-demonstration')?.getAnimations({ subtree: true })[0];
    return animation?.playState === 'paused' && !animation.pending;
  });
  const paused = await art.evaluate(el => el.getAnimations({ subtree: true })[0].currentTime);
  await page.waitForTimeout(100);
  assert.equal(await art.evaluate(el => el.getAnimations({ subtree: true })[0].currentTime), paused, 'hidden-tab drawing spends no animation time');
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => document.querySelector('.dm-funding-demonstration')?.classList.contains('is-running'));
  assert.ok(await art.evaluate(el => el.getAnimations({ subtree: true })[0].currentTime) >= paused, 'resumes the same timeline instead of restarting it');
  await page.locator('footer').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => !document.querySelector('.dm-funding-demonstration')?.classList.contains('is-running'));
  assert.equal(await art.evaluate(el => el.getAnimations({ subtree: true })[0].playState), 'paused');
  for (const mode of ['compound', 'domino', 'autoexit']) {
    const selector = '#learn [data-feature="' + mode + '"] .dm-automation-story-art';
    const scene = page.locator(selector);
    await scene.scrollIntoViewIfNeeded();
    await page.waitForFunction(selector => document.querySelector(selector)?.classList.contains('is-running'), selector);
    assert.ok(await scene.evaluate(el => el.getAnimations({ subtree: true }).some(animation => animation.effect.getComputedTiming().iterations === Infinity)), mode + ' has a repeating demonstration when visible');
  }
  await features.scrollIntoViewIfNeeded();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await art.evaluate(el => el.getAnimations({ subtree: true }).length), 0);
  assert.equal(await page.locator('#learn .dm-automation-story-art').count(), 3, 'each automation keeps its own demonstration');
  assert.equal(await page.locator('#learn .dm-automation-story-art').evaluateAll(nodes => nodes.every(el => el.getAnimations({ subtree: true }).length === 0)), true);
  assert.deepEqual(apiOf(page), reads, 'decorative loops do not poll for new data');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    await captureUI(page, 'funding-motion-' + width, '#funding');
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1440, height: 960 });
  await go(page, '/automate');
  for (const mode of ['compound', 'domino', 'protection']) {
    const drawing = page.locator(`[data-automation-card="${mode}"] .dm-automation-story-art`);
    await drawing.scrollIntoViewIfNeeded();
    await page.waitForFunction(selector => document.querySelector(selector)?.classList.contains('is-running'), `[data-automation-card="${mode}"] .dm-automation-story-art`);
    assert.ok(await drawing.evaluate(el => el.getAnimations({ subtree: true }).some(animation => animation.effect.getComputedTiming().iterations === Infinity)), 'the same meaningful demonstration continues from Home into Automate');
  }
  await captureUI(page, 'automate-motion-r4-1440', 'main');
  await go(page, '/new');
  const preview = page.locator('.dm-flow-pv-art');
  await preview.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('.dm-flow-pv-art')?.classList.contains('is-running'));
  assert.equal(await preview.locator('.line').first().evaluate(el => getComputedStyle(el).animationIterationCount), 'infinite');
  assert.equal(await page.getByRole('button', { name: /Replay|Watch fees move|Pause motion/ }).count(), 0);
  clean(page, 'shared decorative motion');
  await close(page);
});

test('New position forms one position, while the shared Auto-exit story reaches the limit before returning tokens; both rest accessibly', async () => {
  const page = await openSimulator();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await go(page, '/automate');
  const selector = (kind) => `[data-automation-card="${kind}"] ${kind === 'plain' ? '.dm-position-choice-art' : '.dm-automation-story-art'}`;
  const drawing = (kind) => page.locator(selector(kind));
  // Freeze every moving part on the same timeline. Screenshots must preserve this paused frame:
  // Playwright's usual animations:disabled resets infinite loops to their initial composition.
  const frame = async (kind, fraction) => {
    const art = drawing(kind);
    await art.scrollIntoViewIfNeeded();
    const timing = await art.evaluate(async (node, fraction) => {
      const animations = node.getAnimations({ subtree: true }).filter((animation) => animation instanceof CSSAnimation);
      if (!animations.length) throw new Error('The decorative scene has no CSS timeline');
      const timing = animations.map((animation) => {
        const { duration, delay, iterations } = animation.effect.getTiming();
        animation.pause();
        animation.currentTime = Number(duration) * fraction;
        return { duration, delay, repeats: iterations === Infinity };
      });
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      return timing;
    }, fraction);
    assert.ok(timing.length > 2, `${kind} has its coordinated moving parts`);
    assert.deepEqual([...new Set(timing.map(({ duration }) => duration))], [kind === 'plain' ? 8000 : 11000], 'one duration for every part');
    assert.ok(timing.every(({ repeats }) => repeats), 'the educational scenes keep their coordinated loops');
    return art;
  };
  const picture = (art) => art.evaluate((node) => {
    if (node.classList.contains('dm-automation-story-art')) {
      const style = selector => getComputedStyle(node.querySelector(selector));
      return {
        rangeFill: Number(style('.as-exit-fill').fillOpacity),
        priceRemaining: parseFloat(style('.as-exit-price').strokeDashoffset),
        tokens: [...node.querySelectorAll('.as-exit-hop')].map(token => ({
          opacity: Number(getComputedStyle(token).opacity),
          distance: parseFloat(getComputedStyle(token).offsetDistance),
        })),
        received: [...node.querySelectorAll('.as-wallet-token')].map(token => Number(getComputedStyle(token).opacity)),
      };
    }
    // Interpolated and static CSS colors can serialize differently. Compare their sRGB pixels.
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const paint = (color) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    const inside = (container, token) => {
      const outer = container.getBoundingClientRect();
      const inner = token.getBoundingClientRect();
      const x = (inner.left + inner.right) / 2;
      const y = (inner.top + inner.bottom) / 2;
      return x >= outer.left && x <= outer.right && y >= outer.top && y <= outer.bottom;
    };
    const part = (selector) => getComputedStyle(node.querySelector(selector));
    const creating = node.dataset.choice === 'plain';
    const band = part(creating ? '.choice-create-band' : '.choice-exit-band');
    const tile = part(creating ? '.choice-create-tile' : '.choice-exit-tile');
    const body = part('.t-body');
    const tokens = [...node.querySelectorAll(creating ? '.choice-fund' : '.choice-transfer')];
    return {
      band: {
        fill: paint(band.fill),
        stroke: paint(band.stroke),
        // CSS serializes a solid animated outline as zero lengths and a static one as `none`.
        dash: band.strokeDasharray === 'none' || band.strokeDasharray.split(/[ ,]+/).every((length) => parseFloat(length) === 0) ? 'solid' : band.strokeDasharray,
      },
      tile: { opacity: Number(tile.opacity), fill: paint(body.fill) },
      tokens: tokens.map((token) => ({
        opacity: Number(getComputedStyle(token).opacity),
        distance: parseFloat(getComputedStyle(token).offsetDistance),
        arrived: inside(node.querySelector(creating ? '.choice-create-band' : '.choice-wallet'), token),
      })),
      plus: creating ? Number(part('.choice-create-plus').opacity) : null,
      tip: creating ? null : { opacity: Number(part('.choice-tip').opacity), distance: parseFloat(part('.choice-tip').offsetDistance) },
      wallet: creating ? null : paint(part('.choice-wallet').fill),
      tiles: node.querySelectorAll('.t-body').length,
    };
  });
  let completed;
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 960 });
    const emptyArt = await frame('plain', 0.24);
    const empty = await picture(emptyArt);
    assert.equal(empty.tile.opacity, 0, 'the new position does not exist before funding');
    assert.equal(empty.plus, 1, 'its empty destination has a creation marker');
    assert.equal(empty.tiles, 1, 'two input tokens form exactly one position');
    assert.ok(empty.tokens.every(({ distance, arrived }) => distance === 0 && !arrived), 'tokens begin outside the empty range');
    await captureUI(page, `new-position-empty-${width}`, '[data-automation-card="plain"]', { animations: 'allow' });
    const entering = await picture(await frame('plain', 0.38));
    assert.ok(entering.tokens.every(({ distance }) => distance > 0 && distance < 100), 'both tokens travel into the same position');
    completed = await picture(await frame('plain', 0.70));
    assert.equal(completed.tile.opacity, 1, 'funding creates a fully visible tile');
    assert.equal(completed.plus, 0, 'the creation marker gives way to the position');
    assert.notDeepEqual(empty.band.fill, completed.band.fill, 'the empty band gains its funded fill');
    assert.notEqual(empty.band.dash, completed.band.dash, 'the empty outline becomes a solid position');
    assert.ok(completed.tokens.every(({ distance, arrived }) => distance === 100 && arrived), 'both tokens have arrived inside the single new position');
    await captureUI(page, `new-position-created-${width}`, '[data-automation-card="plain"]', { animations: 'allow' });

    const warm = await picture(await frame('protection', 0.32));
    assert.ok(warm.priceRemaining > 0 && warm.priceRemaining < 100, 'the price moves toward the range boundary');
    assert.ok(warm.tokens.every(({ opacity }) => opacity === 0), 'no withdrawal before the trigger');
    await captureUI(page, `auto-exit-active-${width}`, '[data-automation-card="protection"]', { animations: 'allow' });
    // Price reaches the boundary at 38%; transfer opacity begins interpolating
    // after 40%. Sample that real gap, before either staggered token appears.
    const triggered = await picture(await frame('protection', 0.39));
    assert.equal(triggered.priceRemaining, 0, 'the boundary is reached before any tokens return');
    assert.ok(triggered.tokens.every(({ opacity }) => opacity === 0), 'no transfer is shown ahead of the trigger');
    const closing = await picture(await frame('protection', 0.58));
    assert.ok(closing.rangeFill < warm.rangeFill, 'the whole range fades when it closes');
    assert.ok(closing.tokens.every(({ distance }) => distance > 0 && distance < 100), 'both tokens move from the range toward the wallet');
    await captureUI(page, `auto-exit-closed-${width}`, '[data-automation-card="protection"]', { animations: 'allow' });
    const received = await picture(await frame('protection', 0.82));
    assert.ok(received.rangeFill <= .025, 'the range remains dim after withdrawal');
    assert.ok(received.tokens.every(({ distance }) => distance === 100), 'both tokens complete the path');
    assert.ok(received.received.every(opacity => opacity === 1), 'both received tokens are visible in the wallet');
    await captureUI(page, `auto-exit-returned-${width}`, '[data-automation-card="protection"]', { animations: 'allow' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `no page overflow at ${width}px`);
  }

  // Re-enter to inspect the genuine CSS-controlled timelines, without the manual pause used for phase sampling.
  await page.setViewportSize({ width: 1440, height: 320 });
  await go(page, '/');
  await go(page, '/automate');
  const reads = structuredClone(apiOf(page));
  for (const kind of ['plain', 'protection']) {
    const sceneSelector = selector(kind);
    const art = drawing(kind);
    await art.scrollIntoViewIfNeeded();
    await page.waitForFunction((selector) => document.querySelector(selector)?.classList.contains('is-running'), sceneSelector);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction((selector) => {
      const node = document.querySelector(selector);
      const animations = node?.getAnimations({ subtree: true });
      return !node?.classList.contains('is-running') && animations?.length && animations.every((animation) => animation.playState === 'paused' && !animation.pending);
    }, sceneSelector);
    const paused = await art.evaluate((node) => node.getAnimations({ subtree: true }).map((animation) => animation.currentTime));
    await page.waitForTimeout(100);
    assert.deepEqual(await art.evaluate((node) => node.getAnimations({ subtree: true }).map((animation) => animation.currentTime)), paused, `${kind} spends no timeline time in a hidden tab`);
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction((selector) => document.querySelector(selector)?.classList.contains('is-running'), sceneSelector);
    await page.locator('footer').scrollIntoViewIfNeeded();
    await page.waitForFunction((selector) => {
      const node = document.querySelector(selector);
      return !node?.classList.contains('is-running') && node?.getAnimations({ subtree: true }).every((animation) => animation.playState === 'paused' && !animation.pending);
    }, sceneSelector);
  }
  await page.setViewportSize({ width: 320, height: 960 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const kind of ['plain', 'protection']) {
    assert.equal(await drawing(kind).evaluate((node) => node.getAnimations({ subtree: true }).length), 0, `${kind} has no loops with reduced motion`);
  }
  const stillNew = await picture(drawing('plain'));
  assert.equal(stillNew.tile.opacity, 1);
  assert.equal(stillNew.plus, 0);
  assert.deepEqual(stillNew.band, completed.band, 'the static new-position picture is its completed composition');
  assert.ok(stillNew.tokens.every(({ arrived }) => arrived));
  const stillExit = await picture(drawing('protection'));
  assert.equal(stillExit.priceRemaining, 0, 'the static exit picture reaches the boundary');
  assert.ok(stillExit.rangeFill <= .05, 'the static range is subdued');
  assert.ok(stillExit.received.every(opacity => opacity === 1), 'the static exit picture shows both tokens in the wallet');
  await captureUI(page, 'position-choice-reduced-320', 'main');
  assert.deepEqual(apiOf(page), reads, 'decorative phases do not fetch data');
  clean(page, 'position choice phases');
  await close(page);
});

test('the compact home range scene plays automatically without duplicating automation cards, and stops offscreen or with reduced motion', async () => {
  const page = await openSimulator();
  const demo = page.locator('[data-sim-example]');
  const hero = page.locator('.dm-hero-art');
  assert.equal(await page.getByRole('button', { name: /Replay|Watch fees move|Pause/ }).count(), 0);
  assert.equal(await hero.locator('.dm-sculpture-front').isVisible(), true);
  assert.equal(await hero.locator('.dm-sculpture-front').evaluate(el => getComputedStyle(el).animationIterationCount), 'infinite');
  const reads = structuredClone(apiOf(page));
  await demo.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('[data-sim-example]').dataset.simRunning === 'yes');
  assert.equal(await demo.locator('.dm-vig-compound, .dm-vig-seq').count(), 0, 'automation is explained once in its feature cards, not repeated inside the range example');
  assert.equal(await demo.getAttribute('data-sim-compact'), '', 'Home uses the concise range-only presentation');
  assert.equal(await demo.locator('[aria-live]').count(), 0, 'automatic motion never repeatedly announces changes');
  assert.doesNotMatch(await demo.innerText(), /Interactive example|Example data|Watch fees move/);
  await page.waitForFunction(() => Number(document.getElementById('sim-price').value) > 0.1);
  await page.locator('#sim-price').focus();
  const controlled = await num(page, '#sim-price');
  await page.waitForTimeout(160);
  assert.equal(await num(page, '#sim-price'), controlled, 'focus gives control to the visitor');
  await setRange(page, '#sim-price', 0.5);
  assert.equal(await demo.getAttribute('data-sim-state'), 'inside');
  await setRange(page, '#sim-price', 0.85);
  assert.equal(await demo.locator('.dm-sim-fee-option[data-active]').count(), 0, 'outside the range neither drawing depicts new earned fees');
  assert.equal(await demo.getAttribute('data-sim-state'), 'above');
  assert.deepEqual(await demo.locator('.dm-sim-pct').allInnerTexts(), ['0%', '100%']);
  await setRange(page, '#sim-price', 0);
  await page.locator('#sim-price').blur();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.querySelector('[data-sim-example]').dataset.simRunning === 'no');
  const reduced = await num(page, '#sim-price');
  await page.waitForTimeout(160);
  assert.equal(await num(page, '#sim-price'), reduced);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await hero.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('[data-sim-example]').dataset.simRunning === 'no');
  const outside = await num(page, '#sim-price');
  await page.waitForTimeout(160);
  assert.equal(await num(page, '#sim-price'), outside, 'offscreen work stops');
  assert.equal(await demo.locator('.dm-art').evaluateAll(nodes => nodes.every(el => el.getAnimations({ subtree: true }).every(animation => animation.playState !== 'running'))), true, 'no artwork keeps running outside the viewport');
  assert.deepEqual(apiOf(page), reads, 'all price and compound motion is local');
  clean(page, 'automatic home scene');
  await close(page);
});

/**
 * With nothing read, the six reviewed pools are still listed, from the
 * catalogue's labels alone: every figure cell a dash that says it is
 * unavailable, no `data-metric` and no estimate anywhere, no USD text, and
 * each row's title saying its pool figures are unavailable. Nothing stands in
 * for a figure that was not read.
 */
async function catalogueOnly(page, label) {
  const rows = page.locator('#pools tbody tr');
  assert.equal(await rows.count(), 6, `${label}: the six reviewed pools, listed from the catalogue`);
  assert.equal(await page.locator('#pools tbody tr[data-pool-catalogue]').count(), 6, `${label}: every row is a catalogue row, labels only`);
  assert.equal(await page.locator('#pools tbody [data-metric], #pools tbody [data-apr-estimate]').count(), 0, `${label}: no figure in any cell`);
  for (const row of await rows.all()) {
    // Home puts a small TVL/APR label above the same figure. Inspect the full cell without those decorative labels,
    // including the price and volume kept for the shared table, so no extra or invented value can pass this check.
    const cells = await row.locator('td').evaluateAll((tds) => tds.slice(1, 5).map((td) => {
      const figure = td.cloneNode(true);
      figure.querySelectorAll('.dm-home-pool-label').forEach((label) => label.remove());
      return [figure.textContent.trim(), td.querySelector('[aria-label]')?.getAttribute('aria-label') ?? null];
    }));
    assert.deepEqual(cells, ['Price', 'TVL', '24h volume', 'Pool APR'].map((figure) => ['—', `${figure} unavailable`]), `${label}: every figure is a dash that says so`);
    assert.equal(await row.locator('a').first().getAttribute('title'), 'Listed on Uniswap. Pool figures are unavailable.');
  }
  assert.doesNotMatch(await page.locator('#pools').innerText(), /\$\s?\d/, `${label}: no dollar figure`);
  assert.equal(await page.locator('[data-metric], [data-apr-estimate]').count(), 0, `${label}: no figure anywhere on the landing`);
  // Home displays the selection once. Ticker presentation remains covered in ReadLab without duplicating it here.
  assert.equal(await page.locator('[data-ticker]').count(), 0, `${label}: no duplicate pool ticker on Home`);
  // 2026-09-26 (featured pools v1 §11.2): with no list served, the embedded list in its order under today's title and
  // no Pinned chip; every link names the pool and USDG, the token to verify it with (§11.6). The method line is gone
  // for every list since 2026-09-28 (the owner).
  assert.equal(await page.locator('#pools [data-featured-source]').getAttribute('data-featured-source'), 'bundled', `${label}: the embedded list`);
  assert.equal(await page.locator('#pools h2').first().innerText(), 'Selected pools', `${label}: today's title`);
  assert.deepEqual(await rows.evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-pool-catalogue'))), SELECTED, `${label}: the embedded six, in order`);
  assert.equal(await page.locator('[data-pinned]').count(), 0, `${label}: no Pinned chip`);
  const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  assert.deepEqual(await rows.evaluateAll((trs) => trs.map((tr) => tr.querySelector('a').getAttribute('href'))), SELECTED.map((id) => `#/pool/${id}/${USDG}`), `${label}: row links`);
}

/**
 * Home and Markets show the selected pools and nothing else (the owner's decision on the redesign): how the reads
 * went is only in the table's visually hidden live region, as the state's title, with no panel, Refresh or Retry.
 */
async function quietStatus(page, table, title, label) {
  const status = page.locator(`${table} [data-read-status]`);
  assert.equal(await status.textContent(), title, `${label}: the status is its title alone`);
  assert.deepEqual(
    await status.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return { hidden: box.width <= 1 && box.height <= 1, inside: el.children.length };
    }),
    { hidden: true, inside: 0 },
    `${label}: no status panel`,
  );
  assert.equal(await page.locator(table).getByRole('button', { name: /Refresh|Retry/ }).count(), 0, `${label}: no Refresh or Retry`);
}

test('the landing reads through the bridge, and with no /api behind this server says live data is not connected, with no figure and no Retry; Markets says it the same way', async () => {
  const page = await open('/');
  await page.waitForFunction(() => document.querySelector('#pools [data-read-status]')?.getAttribute('data-read-status') === 'not_connected');
  await quietStatus(page, '#pools', 'Live data unavailable', 'Home');
  await catalogueOnly(page, 'not connected');
  clean(page, 'not connected');
  await close(page);

  const markets = await open('/markets');
  await markets.waitForFunction(() => document.querySelector('[data-selected-pools] [data-read-status]')?.getAttribute('data-read-status') === 'not_connected');
  await quietStatus(markets, '[data-selected-pools]', 'Live data unavailable', 'Markets');
  assert.doesNotMatch(await markets.locator('main').innerText(), /reported by a market data provider and not reconciled|names its source and its age/, 'Markets: no footnote under the table');
  clean(markets, 'Markets not connected');
  await close(markets);
});

// ---------------------------------------------------------------------------
// The deployable build reads live through the same-origin bridge. This server
// has no /api behind it, like a deployment without the forwarder, so the
// landing shows the not-connected state: one GET per needed namespace, no POST and
// no figure. read-states and read-bridge cover the fixture and bridge-test
// builds, and release.browser.test.mjs covers dist behind the gate, with a
// stub bridge.
// ---------------------------------------------------------------------------

const SELECTED = readFileSync(resolve(import.meta.dirname, '../src/config/selectedPools.ts'), 'utf8').match(/0x[0-9a-f]{64}/g);

test('selected pools and New position read their public catalogue; disconnected V2 automation asks no legacy release or wallet data', async () => {
  const seen = [];
  const dex = [];
  for (const route of ROUTES) {
    const page = await open(route).catch((cause) => { throw new Error(`The public-read check could not open ${route}`, { cause }); });
    await reload(page, route).catch((cause) => { throw new Error(`The public-read check could not reload ${route}`, { cause }); });
    seen.push([route, apiOf(page)]);
    dex.push(...dexOf(page));
    clean(page, `requests on ${route}`);
    await close(page);
  }
  // Added 2026-10-01 (audit I3): artwork for a token with none bundled is asked through our own edge, one token a GET,
  // and nothing else of it; never a figure while no read has answered.
  assert.ok(dex.every((request) => /^GET \/api\/read\/dex\/token-pairs\/0x[0-9a-f]{40}$/.test(request)), dex.join(', '));
  // Per document: the first load and the reload each ask the list once and once per namespace, and post nothing else.
  const once = CAPABILITIES;
  assert.deepEqual(seen, [
    ['/', [once, once]],
    ['/markets', [once, once]],
    ['/explore', [once, once]],
    ['/pools', [once, once]],
    ['/positions', [[], []]],
    ['/app', [[], []]],
    ['/portfolio', [[], []]],
    // 2026-09-26: New position asks the featured list once (its pools are named first, and a pool it withdrew is refused from a link).
    ['/new', [[FEATURED], [FEATURED]]],
    ['/automate', [[], []]],
    ['/settings', [[], []]],
    ['/docs', [[], []]],
    ['/docs/non-custodial', [[], []]],
    // The retained setup route reads its public release. V2 automation waits for a wallet and never reads V1's release.
    ['/setup', [['GET /api/setup/v1/release'], ['GET /api/setup/v1/release']]],
    ['/sequence', [[], []]],
  ]);
});

// Changed on purpose (qa:visual, pool page): the header chip said "Uniswap · 0.02%" beside a Fee tier dash, and a "Hourly candles · GeckoTerminal"
// caption sat under the chart heading. Before verification the chip names the protocol only, and the provider is the plot's title and data.
// Changed on purpose (2026-09-27, round 6, the pool page for beginners): one chip, "Uniswap · <fee> fee" once verified;
// the key figures are APR, 24h volume, TVL and Price (the fee is in the chip and the sentence under the name); the chart
// is "Price history", from the pool's own swaps.
test('a pool page that could not be verified states no fee tier, and its chart names the provider only in the plot’s title and data', async () => {
  const page = await open(`/pool/${SELECTED[0]}`);
  await page.locator('[data-pool-verification]:not([data-pool-verification="verifying"])').waitFor();
  assert.deepEqual(await page.locator('main .dm-chip').allInnerTexts(), ['Uniswap'], 'no fee in the chip');
  const main = await page.locator('main').innerText();
  for (const label of ['APR', '24H VOLUME', 'TVL', 'PRICE']) assert.match(main, new RegExp(`${label}\\s+—`), `the ${label} stat is a dash`);
  assert.doesNotMatch(main, /%|GeckoTerminal|Hourly candles/, 'no fee tier and no caption anywhere on the page');
  const plot = page.locator('main .dm-card', { hasText: 'Price history' }).locator('.dm-pool-plot');
  assert.deepEqual([await plot.getAttribute('title'), await plot.getAttribute('data-chart-provider')], ['Prices from swaps on Robinhood Chain.', null]);
  clean(page, 'unverified pool page');
  await close(page);
});

test('the deployable build carries the live read path and the selected pools, nothing of the fixture pipeline, in the entry and the wallet chunk', () => {
  const scripts = readdirSync(join(DIST, 'assets')).filter((file) => file.endsWith('.js'));
  // The entry is the script index.html loads; a lazy chunk can be named
  // index-* too, because the module that opens it is called index.ts.
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  // Changed on purpose 2026-10-01 (platform workstream, F1/F4): the entry is the page's module script; the page also names
  // its stable chunks (modulepreload) and every route's files (the boot script's table).
  const entry = [...html.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="\/assets\/([^"]+)"/g)].map((match) => match[1]);
  const island = scripts.filter((file) => file.startsWith('WalletSessionIsland-'));
  // Wallet sign-in is the one lazily loaded chunk: a visitor who never opens
  // it never downloads it. Anything else split out is a chunk nobody asked for.
  assert.equal(entry.length, 1, `one entry: ${scripts.join(', ')}`);
  assert.equal(island.length, 1, `one wallet chunk: ${scripts.join(', ')}`);
  // Beyond those two, the read screens and the shared read source they use are
  // lazy chunks: loaded when a reader opens the figures or the position
  // lookup, never on first paint. A second entry would be the real regression.
  assert.ok(scripts.length >= 2, `entry and wallet chunk at least: ${scripts.join(', ')}`);
  const code = scripts.map((file) => readFileSync(join(DIST, 'assets', file), 'utf8')).join('\n');
  for (const marker of ['/api/read/v1', 'X-Domino-Read-Contract', 'assertResponse', ...SELECTED]) {
    assert.equal(code.includes(marker), true, `dist lacks ${marker}`);
  }
  // The six reviewed pools (src/config/selectedPools.ts), every one of them in the build.
  assert.equal(SELECTED.length, 6);
  for (const marker of [
    'fixtures/gateway',
    'onerror=alert',
    '0911afcb281d7bcae2d71443ceaeebd0f89b4537708449970d797622b4b4c941',
    'abababababababab',
    'c0ffeec0ffee',
    'Fixture data',
    'Contract fixtures',
    'Fixture build',
    'Not deployable',
    'data-build-banner',
  ]) {
    assert.equal(code.includes(marker), false, `dist contains ${marker}`);
  }
  assert.equal(existsSync(join(DIST, 'read-lab.html')), false, 'the read lab is not part of the deployable build');
});

// Changed on purpose (2026-09-27, the owner's round 6, point 6): the Settings page was useless and connected to nothing, so
// it is gone: its route, its menu entry, its footer link, its screen and its styles. Docs takes its place in the menu, and
// an old `#/settings` link opens the docs, which say what it said (tests/docs.test.mjs checks the words). Its own test,
// which read the build card and the capabilities list, went with it.
test('Settings is gone: an old link opens the docs with no error, and neither the menu nor the footer names it', async () => {
  const page = await open('/settings');
  await page.getByRole('heading', { level: 1, name: 'Docs', exact: true }).waitFor();
  const text = await page.locator('#root').innerText();
  assert.doesNotMatch(text, /\bSettings\b|This build|Capabilities|AUTOMATED SIGNING|WALLET TRANSACTIONS/, 'no word of the old page');
  assert.equal(await page.locator('[data-read-contract]').count(), 0, 'the old build card is not on the page');
  // Nothing lit in the header: the docs are none of the three places.
  assert.equal(await page.locator('header nav[aria-label="Main"] a[aria-current="page"]').count(), 0);
  assert.equal(await page.locator('footer').getByRole('link', { name: 'Settings' }).count(), 0, 'no Settings in the footer');
  assert.equal(await page.locator('a[href="#/settings"]').count(), 0, 'no link names the old route');

  // The menu at a desktop width: New position and Docs, then the guides on Home. Docs is lit on the docs.
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  const items = page.locator('#site-menu [role="menuitem"]');
  await items.first().waitFor();
  const entries = await items.evaluateAll((els) => els.map((a) => [a.textContent.trim(), a.getAttribute('href'), a.getAttribute('aria-current')]));
  assert.deepEqual(entries, [
    ['New position', '#/new', null],
    ['Docs', '#/docs', 'page'],
    ['How it works', '#/#learn', null],
    ['Ranges explained', '#/#ranges', null],
    ['What Domino does not do', '#/#limits', null],
  ]);
  // Each entry wears a mark of its own: the book is the docs'.
  const marks = await items.evaluateAll((els) => els.map((a) => a.querySelector('svg')?.innerHTML ?? ''));
  assert.equal(new Set(marks).size, marks.length, 'no two menu entries share a mark');
  await page.keyboard.press('Escape');

  // Anywhere else, the menu's Docs is not lit, and it opens the docs.
  await page.evaluate(() => { location.hash = '#/automate'; });
  await page.getByRole('heading', { level: 1, name: 'Automate', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  const docs = page.locator('#site-menu [role="menuitem"]', { hasText: 'Docs' });
  assert.equal(await docs.getAttribute('aria-current'), null);
  await docs.click();
  await page.waitForFunction(() => location.hash === '#/docs');
  await page.getByRole('heading', { level: 1, name: 'Docs', exact: true }).waitFor();
  clean(page, 'the old Settings link');
  await close(page);
});

// Three automation choices lead to their guarded flows; creating a plain position remains a secondary entry.
test('Automate connects three visual choices to their guarded flows and keeps exact fees and the plain-position entry', async () => {
  const page = await open('/automate');
  const ways = await Promise.all(['Set up Auto-compound', 'Set up Domino-compound'].map((name) =>
    page.getByRole('link', { name, exact: true }).evaluate((link) => ({ height: link.getBoundingClientRect().height, outline: link.classList.contains('dm-btn--outline'), sm: link.classList.contains('dm-btn--sm') }))));
  assert.deepEqual(ways.map(({ outline, sm }) => [outline, sm]), [[true, false], [true, false]], 'both choices have equal emphasis, neither small');
  assert.equal(ways[0].height, ways[1].height, `the two ways in: ${ways.map(({ height }) => height).join(' vs ')} px`);
  assert.equal(await page.locator('main .dm-inset, main .dm-acct-auto-note').count(), 0, 'no panel under the cards');
  assert.doesNotMatch(await page.locator('main').innerText(), /Setup checks the deployment/, 'no note under the cards');
  // Changed on purpose 2026-10-01 (audit E4, live note L12): plain words, no "consumed", and no promise about the APR.
  assert.deepEqual(await page.locator('main .dm-automation-choice-fee').allInnerTexts(), ['No automation fee', '2% of earned fees used, once', '4% of earned fees used, once', '0.2% of the position, only when it closes']);
  assert.equal(await page.locator('[data-automation-card="compound"] .dm-automation-choice-description').innerText(), 'Adds earned fees back into the same position, in the same range.');
  assert.equal(await page.locator('main .dm-automation-choice-description').count(), 4, 'one short explanation per choice');
  assert.doesNotMatch(await page.locator('main').innerText(), /improving|consumed|hold’s/, 'no broken possessive, no "consumed", no promise');
  const plain = page.locator('main [data-feature="plain"]');
  assert.match(await plain.locator('.dm-automation-choice-body').innerText(), /^New position\s+Choose a pool, add your tokens and start earning fees\.\s+No automation fee\s+New position\s+How it works$/);
  assert.doesNotMatch(await plain.innerText(), /\bfree\b/i, 'no claim that a plain position has no costs');
  assert.deepEqual(await plain.getByRole('link').evaluateAll((links) => links.map((a) => [a.textContent, a.getAttribute('href')])), [['New position', '#/new'], ['How it works', '#/docs/new-position']]);
  assert.deepEqual(await page.locator('main .dm-automation-choice-grid [data-automation-card]').evaluateAll((cards) => cards.map((card) => card.getAttribute('data-automation-card'))), ['compound', 'domino', 'protection']);
  assert.equal(await page.locator('.dm-automation-start [data-automation-card="plain"]').count(), 1, 'plain setup stays available outside the automation comparison');
  assert.equal(await page.locator('.dm-automation-start').evaluate(start => start.nextElementSibling?.classList.contains('dm-automation-choice-grid')), true, 'New position precedes the three automation choices');
  assert.equal(await page.locator('.dm-automation-choice-grid .dm-automation-story-art').count(), 3, 'all three demonstrations stay visible');
  const protection = page.locator('[data-automation-card="protection"]');
  await protection.getByRole('button', { name: 'Unavailable right now', exact: true }).waitFor();
  assert.equal(await protection.getByRole('button').isDisabled(), true, 'a missing execution capability never becomes an actionable Auto-exit entry');
  assert.deepEqual(await protection.getByRole('link').evaluateAll((links) => links.map((a) => a.getAttribute('href'))), ['#/docs/auto-exit'], 'docs stay available without opening an unavailable execution');
  if (process.env.DOMINO_UI_CAPTURE_DIR) {
    for (const width of [320, 390, 1280, 1440]) {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await captureUI(page, 'automate-viewport-' + width);
      await captureUI(page, 'automate-full-' + width, undefined, { fullPage: true });
    }
  }
  clean(page, 'automate');
  await close(page);
});

/** The routes that open Positions, whose list asks for a wallet in its own empty state. */
const POSITIONS_ROUTES = new Set(['/positions', '/app', '/portfolio']);
/**
 * The routes whose page asks for a wallet in its own empty state, and where it says so. Changed on purpose 2026-10-06
 * (rugged's answer of 6 Oct, §8): Set up automation too, which in the deployable build (it carries Domino V2) no longer
 * waits for V1's sequence release, so with no wallet it asks for one, with a Connect wallet that only opens the header's dialog.
 */
const OWN_CONNECT = new Map([...[...POSITIONS_ROUTES].map((route) => [route, '[data-empty="owned-connect"]']), ['/sequence', '[data-sequence-wallet="none"]']]);

test('the wallet control is on every route and ready, no route mentions practice, and nothing is stored', async () => {
  for (const route of ROUTES) {
    const page = await open(route);
    // No wallet is injected in this suite, so the control invites one. It is
    // enabled: sign-in is built into the deployed site now, and opening it
    // signs nothing (tests/session.browser.test.mjs drives the flow itself).
    // One control, in the header, on every route: a second one that signed in
    // would leave the reader guessing which one does. Changed on purpose
    // (owner, 2026-09-24): Positions' own list asks for a wallet in its empty
    // state, with a Connect wallet that only opens the header's dialog.
    if (OWN_CONNECT.has(route)) await page.locator(OWN_CONNECT.get(route)).waitFor();
    const buttons = await page.getByRole('button', { name: 'Connect wallet' }).all();
    assert.equal(buttons.length, OWN_CONNECT.has(route) ? 2 : 1, `Connect wallet on ${route}: found ${buttons.length}`);
    for (const button of buttons) assert.equal(await button.isDisabled(), false, `Connect wallet is disabled on ${route}`);
    assert.equal(await page.locator('header').getByRole('button', { name: 'Connect wallet' }).count(), 1, `the control is not in the header on ${route}`);
    assert.doesNotMatch(await page.locator('#root').innerText(), /practice/i, `practice on ${route}`);
    // Changed on purpose 2026-10-03 (the owner): the footer's Pause motion, the last control clicked here, is gone; the
    // page still stores nothing.
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), [], `${route} stored something`);
    clean(page, `wallet on ${route}`);
    await close(page);
  }
});

test('the landing never shows an invented figure: catalogue labels in every row, not one cell with a value, no placeholder, nothing called a sample', async () => {
  const page = await open('/');
  await page.waitForFunction(() => document.querySelector('#pools [data-read-status]')?.getAttribute('data-read-status') !== 'loading');
  const found = await page.evaluate(() => ({
    rows: document.querySelectorAll('#pools tbody tr').length,
    catalogue: document.querySelectorAll('#pools tbody tr[data-pool-catalogue]').length,
    metrics: document.querySelectorAll('[data-metric]').length,
    estimates: document.querySelectorAll('[data-apr-estimate]').length,
    placeholder: document.querySelectorAll('[data-metric="placeholder"]').length,
    sample: /sample/i.test(document.body.innerText),
    dollars: /\$\s?\d/.test(document.body.innerText),
    // The catalogue's labels (USDG, WETH, MARLIN…) are the reviewed pools' names; an example token would be an invention.
    example: /MEME|Example token/.test(document.body.innerText),
  }));
  assert.deepEqual(found, { rows: 6, catalogue: 6, metrics: 0, estimates: 0, placeholder: 0, sample: false, dollars: false, example: false });
  await catalogueOnly(page, 'landing figures');
  clean(page, 'landing figures');
  await close(page);
});

// ---------------------------------------------------------------------------
// No practice mode: the positions screen is an honest empty state, and the
// explanatory sections stay, in relative terms, saying what is not connected.
// ---------------------------------------------------------------------------

// Changed on purpose (owner, 2026-09-24): Positions lists the connected wallet's positions itself. With no wallet it says
// so in one empty state whose button opens the header's wallet dialog. Later the same day: the lookup by NFT id is gone
// (the owner: typing an NFT id must not exist), and nothing about positions is kept in the browser.
test('the positions screen without a wallet shows one receipts summary, no managed wall or private figures, and a way back to the pools', async () => {
  const page = await open('/app');
  assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), 'Positions');
  // The list arrives with its own chunk: with no wallet it asks for one, and reads nothing.
  const empty = page.locator('[data-empty="owned-connect"]');
  await empty.waitFor();
  assert.equal(await page.locator('[data-owned]').getAttribute('data-owned'), 'no-wallet');
  const receipts = page.locator('section[aria-labelledby="receipts-title"]');
  await receipts.locator('[data-signed-out="no_wallet"]').waitFor();
  const text = await page.locator('#root').innerText();
  assert.match(text, /Your positions\s+Connect a wallet to see your positions\s+Connect wallet/);
  assert.doesNotMatch(text, /Look up|Position NFTs|Enter its ID|NFT ids?\b/i, 'no typed ids asked for, anywhere');
  assert.equal(await page.locator('details[data-lookup-disclosure], #nft-ids, #chain-lookup').count(), 0, 'no lookup by NFT id at all');
  assert.equal(await receipts.getByText('Connect your wallet to see your receipts.', { exact: true }).count(), 1);
  assert.doesNotMatch(text, /Automated positions and activity|Connect your wallet to see your automated positions/);
  assert.equal(await page.locator('[data-automation-cards="integrated"]').count(), 1);
  assert.equal(await receipts.locator('button').count(), 0, 'connecting is the header’s and the list’s own Connect wallet');
  assert.equal(await page.locator('section[aria-labelledby="managed-title"]').count(), 0, 'automation state is integrated into positions, without an empty managed wall');
  assert.equal(await receipts.isVisible(), true);
  // 2026-10-01 (audit D2): with no session there is nothing to list, so See all is not shown (it opened an empty page).
  assert.equal(await page.locator('[data-receipts-all]').isVisible(), false);
  // 2026-09-27 (round 5): the Receipts card is a short Recent list; its See all opens every receipt on a page of its own.
  assert.equal(await page.locator('[data-receipts-all]').getAttribute('href'), '#/positions/receipts');
  assert.doesNotMatch(text, /Canonical receipts|unavailable values|never shown as completed|Sent exactly as typed|checksum|proves nothing/i, 'no caption about data states');
  assert.equal(await page.locator('#portfolio-address-input').getAttribute('title'), 'Sent exactly as typed; a checksum is not required. Viewing an address proves nothing about who controls it.');
  assert.doesNotMatch(text, /practice|reinvested|awaiting|\$\s?\d|[0-9]+%/i);
  assert.equal(await page.locator('[role="dialog"]').count(), 0);
  // Nothing reads on load without a wallet, and the screen shows no figure of its own.
  assert.deepEqual(apiOf(page), [[]], 'the positions screen reads nothing by itself');
  assert.equal(await page.locator('main [data-metric]').count(), 0, 'no figure without a wallet');
  assert.equal(await page.locator('main').getByRole('link', { name: 'Markets', exact: true }).getAttribute('href'), '#/markets');
  // The empty state's Connect wallet is the header's: it opens the same wallet dialog.
  await empty.getByRole('button', { name: 'Connect wallet' }).click();
  await page.locator('[role="dialog"]').first().waitFor();
  assert.equal(await page.locator('header [aria-haspopup="dialog"]').getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape');
  assert.deepEqual(apiOf(page), [[]], 'and connects nothing by itself');
  clean(page, 'positions');
  await close(page);
});

// Added 2026-09-27 (owner, round 5: the receipts ran down the Positions tab forever): every receipt on a page of its own under
// Positions, which the Receipts card's See all opens. Signed out it says how to see them, reads nothing, and keeps
// Positions lit in the header; its one way back is Positions.
// Changed on purpose 2026-10-01 (audit D2): with no session the card's See all is hidden (it opened a page with nothing to
// list), so the page is opened by its address here; with no wallet in this suite, it says to connect one.
test('the receipts page keeps Positions lit, and with no wallet asks for one and reads nothing', async () => {
  const page = await open('/positions');
  await page.locator('section[aria-labelledby="receipts-title"] [data-signed-out="no_wallet"]').waitFor();
  assert.equal(await page.locator('[data-receipts-all]').isVisible(), false, 'no See all with nothing to list');
  await page.evaluate(() => { location.hash = '#/positions/receipts'; });
  await page.waitForFunction(() => location.hash === '#/positions/receipts');
  // The hash changes before the page is drawn, and Positions' own Receipts card says the same sentence: wait for the
  // page's heading first (audit H3; finance.browser read "Positions" there on CI, 2026-09-28).
  await page.getByRole('heading', { level: 1, name: 'Receipts', exact: true }).waitFor();
  await page.getByText('Connect your wallet to see your receipts.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), 'Receipts');
  assert.equal(await page.getByRole('heading', { level: 2, name: 'All receipts' }).count(), 1);
  const nav = await page.locator('header nav[aria-label="Main"] a').evaluateAll((els) => els.map((a) => [a.textContent.trim(), a.getAttribute('aria-current')]));
  assert.deepEqual(nav, [['Markets', null], ['Positions', 'page'], ['Automate', null]]);
  assert.deepEqual(await page.locator('main a').evaluateAll((els) => els.map((a) => [a.textContent.trim(), a.getAttribute('href')])), [['Positions', '#/positions']], 'one way back, and the page does not link itself');
  const text = await page.locator('main').innerText();
  assert.doesNotMatch(text, /Automated positions|Your positions|\$\s?\d|0x[0-9a-fA-F]{4}/, 'the receipts alone (no other card), and no figure or hash signed out');
  assert.equal(await page.getByRole('button', { name: 'Connect wallet' }).count(), 1, 'the header keeps the one wallet control');
  assert.deepEqual(apiOf(page), [[]], 'the receipts page reads nothing by itself');
  clean(page, 'receipts page');
  await close(page);
});

test('Home connects funding, pools, three automations and risks, with the optional range guide in relative terms', async () => {
  const page = await openSimulator();
  const text = await page.locator('#root').innerText();
  for (const heading of [/Earn fees\.\s*Keep control\./, /Start with\s*what you have\./, /Choose what\s*happens next\./, /What is a price range\?/, /Stay informed\.\s*Stay in control\./]) {
    assert.match(text, heading);
  }
  assert.deepEqual(await page.locator('main section[id]').evaluateAll(sections => sections.map(section => section.id)), ['funding', 'pools', 'learn', 'limits'], 'the page follows a readable sequence from funding to managing the position');
  assert.deepEqual(await page.locator('.dm-hero-funding li > span:last-child').allInnerTexts(), ['Ethereum', 'Base', 'Arbitrum One', 'OP Mainnet', 'Robinhood Chain'], 'the hero names all five funding networks');
  assert.deepEqual(await page.locator('#learn article h3').allInnerTexts(), ['Auto-compound', 'Domino-compound', 'Auto-exit']);
  for (const article of await page.locator('#learn article').all()) assert.equal(await article.isVisible(), true, 'each automation is visible without choosing a tab');
  assert.equal(await page.locator('#limits details:not([open])').count(), 4, 'risk explanations stay available without overwhelming the page');
  await page.locator('#limits summary').filter({ hasText: 'Your position can lose value' }).click();
  assert.match(await page.locator('#limits details[open]').innerText(), /be worth less than holding the tokens/);
  assert.doesNotMatch(text, /Built on Uniswap|one tile at a time|Starts paused|Not running|automation is running/i);
  assert.doesNotMatch(text, /Every figure on this page names its source and its age|describes a pool, not a position, and is not a forecast/);
  assert.doesNotMatch(text, /\balpha\b|\bv4\b|not enabled yet|read-only/i, 'no self-description as an alpha, a version or a read-only build');
  // This scene illustrates a token mix, never a forecast of earnings.
  const sim = await page.locator('#ranges').innerText();
  for (const words of [/Your price range/, /Only ETH/, /Your range/, /Only USDG/, /−30%/, /\+50%/, /Start/, /Token mix/, /Inside range/]) assert.match(sim, words);
  assert.doesNotMatch(sim, /×|Closer|Wider|Per sequence|Starts paused|Figures, and the other range|Domino steps in|Stablecoin|Token share|trades have paid/, 'no range switch, jargon or invented trade count');
  assert.equal(await page.locator('#ranges input').count(), 1, 'one control: the price');
  assert.equal(await page.locator('#ranges [data-sim-preset]').count(), 3, 'three price reference markers');
  assert.equal(await page.locator('#ranges details:not([open])').count(), 1, 'extra explanation starts folded away');
  assert.doesNotMatch(sim, /Interactive example|Example data/, 'no persistent example badge');
  assert.doesNotMatch(text, /MEME|Example token/, 'no example token');
  assert.equal(await page.locator('#hero-amount, #amount').count(), 0, 'no amount to type in');
  assert.equal(await page.locator('main').getByRole('link', { name: 'New position', exact: true }).first().getAttribute('href'), '#/new');
  assert.equal(await page.locator('main').getByRole('link', { name: 'Explore markets', exact: true }).first().getAttribute('href'), '#/markets');
  assert.equal(await page.locator('[data-domino-token]').count(), 0, 'no Domino token card on Home');
  assert.doesNotMatch(text, /The Domino token is coming|Ticker, supply and launch date/);
  assert.doesNotMatch(await page.locator('#pools').innerText(), /COMBINED TVL|NETWORK/, 'the six-pool stat strip is gone');
  clean(page, 'Home story and optional range guide');
  await close(page);
});

test('nothing in dist carries a sample, practice, fixture or test-only marker, in any file', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else files.push(join(dir, entry.name));
    }
  };
  walk(DIST);
  const scanned = files.filter((file) => TEXT_FILE.test(file));
  assert.ok(scanned.length >= 4, `scanned ${scanned.length} files`);
  const hits = scanned.flatMap((file) => findForbidden(readFileSync(file, 'utf8')).map((hit) => `${file.slice(DIST.length)}: ${hit.marker} in ${hit.context}`));
  assert.deepEqual(hits, []);
  const text = scanned.map((file) => readFileSync(file, 'utf8')).join('\n');
  assert.equal((text.match(/sample/gi) ?? []).length, 0, 'sample');
  assert.equal((text.match(/practice/gi) ?? []).length, 0, 'practice');
  assert.deepEqual(files.filter((file) => /read-lab|meme/i.test(file.slice(DIST.length))), [], 'no read lab and no example-token artwork');
});

// ---------------------------------------------------------------------------
// The docs at #/docs: every page from the sidebar, section links under the
// header, and the phone layout. tests/docs.test.mjs checks the same pages as
// data; these check what the built pages do.
// ---------------------------------------------------------------------------

/** Every id on the page that appears more than once. */
const duplicateIds = (page) =>
  page.evaluate(() => {
    const seen = new Set();
    const twice = new Set();
    for (const element of document.querySelectorAll('[id]')) {
      if (seen.has(element.id)) twice.add(element.id);
      seen.add(element.id);
    }
    return [...twice];
  });

test('the docs: every page opens from the sidebar with its title and its link marked, lists its own sections, links its neighbours, and never leaves the app', async () => {
  const page = await open('/docs');
  assert.equal(await page.locator('h1').innerText(), 'Docs');
  const sidebar = page.locator('nav[aria-label="Docs"]');
  assert.equal(await sidebar.count(), 1, 'one docs nav');
  const links = await sidebar.locator('a').evaluateAll((anchors) => anchors.map((a) => [a.textContent.trim(), a.getAttribute('href')]));
  assert.deepEqual(links[0], ['Overview', '#/docs'], 'the sidebar starts at the index');
  assert.deepEqual(await sidebar.locator('a[aria-current="page"]').allInnerTexts(), ['Overview']);
  assert.equal(await page.locator('nav[aria-label="On this page"]').count(), 0, 'the index lists pages, not sections');
  const pages = links.slice(1);
  // Changed on purpose 2026-10-01 (the copy workstream): Wallet requests, A pool’s page and Privacy joined the docs.
  // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): Bring funds from another network, Manage a
  // position, Stop-loss / take-profit and Your automation joined them.
  assert.equal(pages.length, 23, `the sidebar lists ${pages.length} pages`);
  const listed = await page.locator('main a[href^="#/docs/"]').evaluateAll((anchors) => [...new Set(anchors.filter((a) => !a.closest('nav[aria-label="Docs"]')).map((a) => a.getAttribute('href')))].sort());
  assert.deepEqual(listed, pages.map(([, href]) => href).sort(), 'the index itself links every page');

  for (const [index, [title, href]] of pages.entries()) {
    assert.match(href, /^#\/docs\/[a-z0-9]+(?:-[a-z0-9]+)*$/, `${title} links ${href}`);
    leaving(page);
    await sidebar.getByRole('link', { name: title, exact: true }).click();
    await page.waitForFunction((hash) => location.hash === hash, href);
    await page.waitForFunction((words) => document.querySelector('h1')?.textContent === words, title);
    assert.equal(await page.locator('h1').count(), 1, `${href} has one h1`);
    assert.deepEqual(await sidebar.locator('a[aria-current="page"]').allInnerTexts(), [title], `${href} marks its own link`);

    const toc = await page.locator('nav[aria-label="On this page"] a').evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href')));
    assert.ok(toc.length >= 2, `${href} lists ${toc.length} sections`);
    for (const link of toc) {
      assert.ok(link.startsWith(`${href}#`), `${href}: ${link} carries the page's own route`);
      assert.equal(await page.evaluate((id) => document.getElementById(id)?.tagName ?? null, link.slice(href.length + 1)), 'SECTION', `${href}: ${link} names a section`);
    }

    const pager = await page.locator('nav[aria-label="Previous and next pages"] a').evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href')));
    assert.deepEqual(pager, [pages[index - 1]?.[1], pages[index + 1]?.[1]].filter(Boolean), `${href}: previous and next are its sidebar neighbours`);
    assert.equal(await page.locator('main a[href^="http"], main a[href="#"]').count(), 0, `${href}: no link leaves the app`);
    assert.equal(await page.locator('[data-metric], [data-apr-estimate]').count(), 0, `${href}: no figure`);
    assert.deepEqual(await duplicateIds(page), [], `${href}: every id is unique`);
  }

  // A slug that names no page shows the index, with no error.
  await go(page, '/docs/constructor');
  assert.equal(await page.locator('h1').innerText(), 'Docs');
  assert.equal(await page.locator('[role="alert"]').count(), 0);
  assert.deepEqual(apiOf(page), [[]], 'the docs read nothing');
  clean(page, 'docs pages');
  await close(page);
});

// 2026-09-27, the owner's point 8: the docs show the app's screens (public/docs/<id>.webp, taken from the test view by
// scripts/docs-shots.mjs) and two drawings. tests/docs.test.mjs checks the files and their words; this, what a reader gets.
test('the docs pictures load from this site at their own size, lazily, with words for a reader who cannot see them, and the drawings draw', async () => {
  const page = await open('/docs/markets');
  const seen = [];
  for (const route of ['/docs/markets', '/docs/new-position', '/docs/positions', '/docs/auto-compound']) {
    if (route !== '/docs/markets') await go(page, route);
    const figures = page.locator('main figure[data-docs-shot]');
    assert.ok((await figures.count()) >= 1, `${route} shows a picture`);
    for (const figure of await figures.all()) {
      const image = figure.locator('img');
      const [src, alt, width, height, loading] = await image.evaluate((element) => [element.getAttribute('src'), element.alt, element.getAttribute('width'), element.getAttribute('height'), element.loading]);
      assert.match(src, /^\/docs\/[a-z0-9-]+\.webp$/, `${route}: ${src} is this site's own file`);
      assert.ok(alt.length >= 30, `${route}: ${src} says what it shows`);
      assert.equal(loading, 'lazy', `${route}: ${src} loads only when it is near`);
      // Its box has the picture's shape before a byte of it arrives, so nothing under it moves.
      const box = await image.boundingBox();
      assert.ok(Math.abs(box.height - (box.width * Number(height)) / Number(width)) <= 1.5, `${route}: ${src} keeps its place (${box.width}×${box.height})`);
      await figure.scrollIntoViewIfNeeded();
      await page.waitForFunction((element) => element.complete && element.naturalWidth > 0, await image.elementHandle(), { timeout: 15_000 });
      assert.deepEqual(await image.evaluate((element) => [element.naturalWidth, element.naturalHeight]), [Number(width), Number(height)], `${route}: ${src} is the size its page says`);
      assert.match(await figure.locator('figcaption').innerText(), /Made-up figures/, `${route}: ${src} says its figures are made up`);
      seen.push(src);
    }
  }
  assert.equal(new Set(seen).size, seen.length, 'no picture twice');
  await go(page, '/docs/what-is-domino');
  const drawings = page.locator('main figure[data-docs-diagram]');
  assert.deepEqual(await drawings.evaluateAll((figures) => figures.map((figure) => figure.getAttribute('data-docs-diagram'))), ['earning', 'three-ways']);
  assert.ok((await page.locator('main figure[data-docs-diagram="earning"] svg[role="img"]').getAttribute('aria-label')).length >= 30, 'the earning drawing is described');
  assert.deepEqual(await page.locator('main [data-docs-diagram="three-ways"] li').evaluateAll((items) => items.map((item) => item.querySelector('p')?.textContent)), ['Plain position', 'Auto-compound', 'Domino-compound']);
  assert.deepEqual(await duplicateIds(page), [], 'every id is unique');
  assert.deepEqual(apiOf(page), [[]], 'the docs read nothing');
  clean(page, 'docs pictures');
  await close(page);
});

// 2026-09-27 (review of 260a76a): a desktop crop shrunk into a phone's column drew its words about 4 px high, so each
// picture has a phone shot, served under 640 px by a <source> that carries its own size.
test('the docs pictures on a phone are their phone shots, sized by their own pixels before they load, and drawn near the size they were shot at', async () => {
  const page = await openPage(browser, { origin, route: '/docs/markets', viewport: { width: 375, height: 812 } });
  const seen = [];
  for (const route of ['/docs/markets', '/docs/new-position', '/docs/positions', '/docs/auto-compound']) {
    if (route !== '/docs/markets') await go(page, route);
    const figures = page.locator('main figure[data-docs-shot]');
    assert.ok((await figures.count()) >= 1, `${route} shows a picture`);
    for (const figure of await figures.all()) {
      const [srcset, media, width, height] = await figure.locator('picture > source').evaluate((element) => [element.getAttribute('srcset'), element.getAttribute('media'), Number(element.getAttribute('width')), Number(element.getAttribute('height'))]);
      assert.match(srcset, /^\/docs\/[a-z0-9-]+-phone\.webp$/, `${route}: ${srcset} is this site's own phone picture`);
      assert.equal(media, '(max-width: 639px)', `${route}: ${srcset} serves a phone`);
      const image = figure.locator('img');
      // The phone shot's shape before a byte of it arrives, from the source's own width and height.
      const box = await image.boundingBox();
      assert.ok(Math.abs(box.height - (box.width * height) / width) <= 1.5, `${route}: ${srcset} keeps its place (${box.width}×${box.height})`);
      await figure.scrollIntoViewIfNeeded();
      await page.waitForFunction((element) => element.complete && element.naturalWidth > 0, await image.elementHandle(), { timeout: 15_000 });
      const [current, natural] = await image.evaluate((element) => [new URL(element.currentSrc).pathname, [element.naturalWidth, element.naturalHeight]]);
      assert.equal(current, srcset, `${route}: the phone picture is the one drawn`);
      assert.deepEqual(natural, [width, height], `${route}: ${srcset} is the size its page says`);
      // Shot in a 390 px window at twice its size: in a 343 px column its words keep most of their size.
      assert.ok(box.width >= (width / 2) * 0.85, `${route}: ${srcset} is drawn ${box.width} px wide, shot at ${width / 2}`);
      seen.push(srcset);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `${route} scrolls ${overflow}px sideways at 375px`);
  }
  assert.equal(new Set(seen).size, seen.length, 'no picture twice');
  assert.deepEqual(apiOf(page), [[]], 'the docs read nothing');
  clean(page, 'docs phone pictures');
  await close(page);
});

test('a docs section lands just under the header: opened directly, from On this page, and clicked again with the hash unchanged', async () => {
  const page = await open('/docs/non-custodial#pause-revoke-withdraw');
  const header = await page.evaluate(() => document.querySelector('header')?.getBoundingClientRect().height ?? 0);
  const lands = async (id, how) => {
    const top = await sectionTop(page, id);
    assert.ok(top !== null && top >= 0 && top <= header + 40, `${how}: #${id} landed at ${top}px, header is ${header}px`);
  };
  await lands('pause-revoke-withdraw', 'opened directly');
  assert.ok(await page.evaluate(() => window.scrollY) > 0, 'the page moved to the section');

  const toc = page.locator('nav[aria-label="On this page"]');
  // Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): the section says Domino's automation; its id stays.
  const operator = toc.getByRole('link', { name: 'What Domino’s automation can and cannot do', exact: true });
  await operator.click();
  await page.waitForFunction(() => location.hash === '#/docs/non-custodial#operator');
  await lands('operator', 'from On this page');
  await page.waitForFunction(() => document.querySelector('nav[aria-label="On this page"] a[aria-current="location"]')?.getAttribute('href') === '#/docs/non-custodial#operator');

  // Back to the top, then the same link: the hash stays as it is, so only the link itself can scroll.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  await operator.click();
  await lands('operator', 'clicked again');
  assert.equal(await page.evaluate(() => location.hash), '#/docs/non-custodial#operator');

  // A link in the prose to another page's section, then a plain docs route, which starts at the top.
  leaving(page);
  await page.locator('main').getByRole('link', { name: 'Signing in', exact: true }).click();
  await page.waitForFunction(() => location.hash === '#/docs/wallet#sign-in');
  await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Wallet and sign-in');
  await lands('sign-in', 'from a link in the prose');
  await go(page, '/docs/fees');
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => window.scrollY), 0, 'a docs page without a section starts at the top');
  clean(page, 'docs section links');
  await close(page);
});

// Educational funding controls explain the existing flows without initiating wallet reads or transfers.
test('Home funding examples preserve consent, show available networks and disclose each automation fee before linking to the existing flows', async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.route('https://api.dexscreener.com/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  const page = await context.newPage();
  watch(page);
  await page.goto(origin + '/#/');
  await shown(page, '/');
  const funding = page.locator('#funding');
  assert.equal(await funding.getByRole('link', { name: 'Find your funds', exact: true }).getAttribute('href'), '#/new');
  assert.equal(await funding.locator('details[open]').count(), 0, 'route conditions start folded');
  assert.equal(await page.locator('#ranges').getAttribute('open'), null, 'the range lesson starts optional');
  assert.equal(await page.getByRole('slider', { name: 'ETH price, against the start' }).isVisible(), false, 'the lesson does not expose a control before it is opened');
  const reads = structuredClone(apiOf(page));
  const across = funding.getByRole('button', { name: 'From another network', exact: true });
  const local = funding.getByRole('button', { name: 'On this network', exact: true });
  assert.equal(await across.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await funding.locator('.dm-funding-networks > span').evaluateAll(nodes => nodes.map(node => [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent).join('').trim())), ['Ethereum', 'Base', 'Arbitrum One', 'OP Mainnet', 'Robinhood Chain']);
  assert.equal(await funding.getByRole('img', { name: 'Tokens from another network are transferred and swapped into the two tokens for your position.', exact: true }).isVisible(), true);
  await local.click();
  assert.equal(await local.getAttribute('aria-pressed'), 'true');
  assert.equal(await across.getAttribute('aria-pressed'), 'false');
  assert.equal(await funding.locator('.dm-funding-networks').innerText(), 'Robinhood Chain');
  assert.equal(await funding.getByRole('img', { name: 'A token in your wallet is swapped into the two tokens for your position.', exact: true }).isVisible(), true);
  assert.match(await funding.innerText(), /Use one supported token for both sides of your pair/);
  assert.match(await funding.innerText(), /You approve each step/);
  await across.click();
  assert.equal(await across.getAttribute('aria-pressed'), 'true');
  await funding.locator('summary').click();
  assert.match(await funding.locator('details').innerText(), /Ethereum, Base, Arbitrum One, OP Mainnet and Robinhood Chain/);
  assert.match(await funding.locator('details').innerText(), /depend on the token and destination/);
  assert.match(await funding.locator('details').innerText(), /Review swaps, transfer costs and network fees before you approve in your wallet/);
  const automations = page.locator('#learn');
  for (const [name, fee, href] of [
    ['Auto-compound', '2% of earned fees used, once. Your original deposit is not charged.', '#/automate'],
    ['Domino-compound', '4% of earned fees used, once. Your original deposit is not charged.', '#/automate'],
    ['Auto-exit', '0.2% of the position, only when it closes.', '#/docs/auto-exit'],
  ]) {
    const card = automations.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
    assert.equal(await card.isVisible(), true, name + ' is presented without a carousel or tab');
    assert.equal(await card.locator('details[open]').count(), 0);
    await card.locator('summary').click();
    assert.equal(await card.locator('details p').innerText(), fee);
    assert.equal(await card.getByRole('link', { name: 'How ' + name + ' works', exact: true }).getAttribute('href'), href);
  }
  assert.deepEqual(apiOf(page), reads, 'switching examples and opening explanations never asks for a balance, route or financial plan');
  await captureUI(page, 'home-funding-details', '#funding');
  await captureUI(page, 'home-automation-details', '#learn');
  leaving(page);
  await funding.getByRole('link', { name: 'Find your funds', exact: true }).click();
  await page.waitForFunction(() => location.hash === '#/new');
  await page.getByRole('heading', { name: 'New position', exact: true }).waitFor();
  await go(page, '/');
  leaving(page);
  await page.locator('#learn').getByRole('link', { name: 'Explore automation', exact: true }).click();
  await page.waitForFunction(() => location.hash === '#/automate');
  await page.locator('[data-automation-card="protection"]').waitFor();
  const docs = page.locator('[data-automation-card="protection"]').getByRole('link', { name: 'How Auto-exit works', exact: true });
  assert.equal(await docs.getAttribute('href'), '#/docs/auto-exit');
  leaving(page);
  await docs.click();
  await page.waitForFunction(() => location.hash === '#/docs/auto-exit');
  await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Auto-exit');
  clean(page, 'Home funding and automation flows');
  await close(page);
});

test('the docs on a phone: nothing spills sideways, nothing sticks, the docs menu opens the pages and starts closed on the next one, and On this page opens', async () => {
  const page = await openPage(browser, { origin, route: '/docs', viewport: { width: 375, height: 812 } });
  // 2026-09-27: and the pages with pictures and drawings, which must fit the column too.
  for (const route of ['/docs', '/docs/contracts', '/docs/non-custodial', '/docs/glossary', '/docs/what-is-domino', '/docs/new-position']) {
    if (route !== '/docs') await go(page, route);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `${route} scrolls ${overflow}px sideways at 375px`);
    assert.equal(await page.locator('nav[aria-label="Docs"]').count(), 1, `${route}: one docs nav, inside the menu`);
    assert.equal(await page.locator('nav[aria-label="Docs"]').isVisible(), false, `${route}: the menu starts closed`);
    const sticky = await page.evaluate(() => [...document.querySelectorAll('main *')].filter((element) => ['sticky', 'fixed'].includes(getComputedStyle(element).position)).length);
    assert.equal(sticky, 0, `${route}: nothing in the docs sticks on a phone`);
  }

  await go(page, '/docs/contracts');
  const menu = page.locator('details[data-docs-menu]');
  assert.match(await menu.locator('summary').innerText(), /Reference\s*\/\s*Contracts/);
  await menu.locator('summary').click();
  assert.equal(await menu.evaluate((element) => element.open), true, 'the docs menu opens');
  leaving(page);
  await menu.getByRole('link', { name: 'Fees', exact: true }).click();
  await page.waitForFunction(() => location.hash === '#/docs/fees');
  await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Fees');
  assert.equal(await page.locator('details[data-docs-menu]').evaluate((element) => element.open), false, 'the menu starts closed on the page it opened');
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  // Choosing the page already open changes no route, and still closes the menu.
  const again = page.locator('details[data-docs-menu]');
  await again.locator('summary').click();
  assert.equal(await again.evaluate((element) => element.open), true);
  await again.getByRole('link', { name: 'Fees', exact: true }).click();
  assert.equal(await again.evaluate((element) => element.open), false, 'choosing the open page closes the menu');

  const disclosure = page.locator('details', { has: page.locator('nav[aria-label="On this page"]') });
  assert.equal(await disclosure.count(), 1, 'On this page is a disclosure on a phone');
  assert.equal(await disclosure.evaluate((element) => element.open), false);
  const header = await page.evaluate(() => document.querySelector('header')?.getBoundingClientRect().height ?? 0);
  const landsOnGas = async (how) => {
    const top = await sectionTop(page, 'network-gas');
    assert.ok(top !== null && top >= 0 && top <= header + 40, `${how}: #network-gas landed at ${top}px under a ${header}px header`);
    assert.equal(await disclosure.evaluate((element) => element.open), false, `${how}: choosing a section closes On this page`);
  };
  await disclosure.locator('summary').click();
  assert.equal(await disclosure.evaluate((element) => element.open), true, 'On this page opens');
  await disclosure.getByRole('link', { name: 'Network gas', exact: true }).click();
  await page.waitForFunction(() => location.hash === '#/docs/fees#network-gas');
  await landsOnGas('from the disclosure');
  // The same section again, from the top: no hashchange, and the list closes before the section is measured.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(80);
  await disclosure.locator('summary').click();
  await disclosure.getByRole('link', { name: 'Network gas', exact: true }).click();
  await landsOnGas('the same section again');
  assert.equal(await page.locator('[role="dialog"]').count(), 0, 'nothing opens over the page');
  clean(page, 'docs on a phone');
  await close(page);
});

// ---------------------------------------------------------------------------
// 2026-10-01, platform workstream.
// ---------------------------------------------------------------------------

// Live notes L19: a link that names no page said nothing and showed Home (or Markets) as if it had worked.
test('a route that names no page says so plainly, offers the ways on, and lights nothing in the header', async () => {
  for (const route of ['/nope', '/receipts', '/markets/0xab', '/positionsx/1']) {
    const page = await open(route);
    assert.equal(await page.locator('h1').first().innerText(), 'This page doesn’t exist', route);
    assert.equal(await page.locator('[data-not-found]').count(), 1, route);
    assert.equal(await page.title(), 'Page not found · Domino', route);
    assert.equal(await page.locator('#pools').count(), 0, `${route}: not Home`);
    assert.equal(await page.locator('nav[aria-label="Main"] a[aria-current="page"]').count(), 0, `${route}: nothing lit`);
    const links = await page.locator('main a').evaluateAll((list) => list.map((a) => [a.textContent.trim(), a.getAttribute('href')]));
    assert.deepEqual(links, [['Go to Home', '#/'], ['Explore markets', '#/markets']], route);
    clean(page, route);
    await close(page);
  }
});

// Audit E11 (2026-10-01, the copy workstream): every route was titled "Domino", and a move between routes told a screen
// reader nothing. Each screen names its tab, and a later move is said once in a polite live region outside the app.
test('each route names its tab, gives Home its own name back, and a move to another route is said in a polite region', async () => {
  const page = await open('/markets');
  await page.waitForFunction(() => document.title === 'Markets · Domino');
  assert.equal(await page.locator('[data-route-announcer]').count(), 0, 'the first screen of a visit is not announced: the browser reads its title');
  for (const [route, title] of [['/automate', 'Automate · Domino'], ['/positions', 'Positions · Domino'], ['/new', 'New position · Domino'], ['/docs/privacy', 'Privacy · Domino docs'], ['/', 'Domino']]) {
    await go(page, route);
    await page.waitForFunction((want) => document.title === want, title, { timeout: 10_000 });
  }
  const region = page.locator('[data-route-announcer]');
  assert.equal(await region.count(), 1, 'one region, made once');
  assert.deepEqual(await region.evaluate((node) => [node.getAttribute('aria-live'), node.getAttribute('aria-atomic'), node.className, node.closest('#root') === null]), ['polite', 'true', 'sr-only', true]);
  await page.waitForFunction(() => document.querySelector('[data-route-announcer]')?.textContent === 'Domino');
  // The older docs slug still opens Domino-compound (live note L12).
  await go(page, '/docs/domino-compounder');
  await page.waitForFunction(() => document.title === 'Domino-compound · Domino docs');
  assert.equal(await page.locator('h1').innerText(), 'Domino-compound');
  clean(page, 'tab titles');
  await close(page);
});

// F1/F2/F8: the build writes, beside the page's boot script, each route's files; the script asks for the opened route's
// while the app's own script downloads, and Home asks for none of them.
test('the page asks for the opened route’s code and styles while the app starts; Home loads no screen’s', async () => {
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  const table = JSON.parse(/<script type="application\/json" id="dm-boot">(.*?)<\/script>/.exec(html)[1]);
  assert.equal(table.early, true, 'the deployable build sends Home’s first reads early');
  // Changed on purpose 2026-10-01 (fix round 1): the second chain's section has no row. The same build is served on
  // domino.money, where #/elysium… is not found, so the page never preloads its chunk (vite.config.ts ROUTE_MODULES).
  assert.deepEqual(Object.keys(table.chunks).sort(), ['automate', 'docs', 'markets', 'new', 'pool', 'position', 'positions', 'sequence', 'setup']);
  assert.ok(!html.includes('ElysiumEntry'), 'the page names none of the section’s files');
  assert.match(table.chunks.markets[0], /^\/assets\/Explore-[\w-]+\.js$/);
  // Changed on purpose 2026-10-01 (RPC-SPEC §7.8): a position's page no longer runs the chain code; its first read asks the
  // site's own state route (lib/edge/chainRoutes.ts), so the chain code's chunk is not preloaded for it, nor for the list.
  assert.ok(table.chunks.position.some((file) => /^\/assets\/PositionDetail-/.test(file)), 'a position’s page (F2)');
  for (const route of ['position', 'positions']) assert.ok(!table.chunks[route].some((file) => /^\/assets\/chainCode-/.test(file)), `${route}: no chain code`);
  for (const files of Object.values(table.chunks)) {
    assert.ok(files.some((file) => /^\/assets\/screens-[\w-]+\.css$/.test(file)), 'each screen’s styles come with it');
    for (const file of files) assert.ok(existsSync(join(DIST, file)), file);
  }
  const page = await open('/markets');
  const asked = await page.evaluate(() => [...document.querySelectorAll('link[rel="modulepreload"], link[rel="preload"][as="style"]')].map((link) => link.getAttribute('href')));
  for (const file of table.chunks.markets) assert.ok(asked.includes(file), `${file} asked ahead`);
  clean(page, 'markets');
  await close(page);
  const home = await open('/');
  const screen = /\/assets\/(Explore|PoolDetail|Positions|NewPosition|Automate|Docs|screens)-/;
  const early = await home.evaluate((source) => {
    const pattern = new RegExp(source);
    const prefetched = new Set([...document.querySelectorAll('link[rel="prefetch"]')].map((link) => link.getAttribute('href')));
    return performance.getEntriesByType('resource').map((entry) => new URL(entry.name).pathname).filter((path) => pattern.test(path) && !prefetched.has(path));
  }, screen.source);
  assert.deepEqual(early, [], 'Home loads no screen’s code or styles for its first paint');
  // Once the page has loaded and gone quiet, the main screens' files are fetched at the lowest priority
  // (src/lib/prefetchRoutes.ts), so a first move to one draws at once.
  await home.waitForFunction(() => document.querySelectorAll('link[rel="prefetch"]').length > 0, undefined, { timeout: 20_000 });
  const prefetch = await home.evaluate(() => {
    const load = performance.getEntriesByType('navigation')[0].loadEventEnd;
    return [...document.querySelectorAll('link[rel="prefetch"]')].map((link) => ({ href: link.getAttribute('href'), as: link.getAttribute('as'), crossorigin: link.getAttribute('crossorigin'), load }));
  });
  const wanted = new Set(['markets', 'positions', 'position', 'pool', 'new', 'automate', 'docs'].flatMap((route) => table.chunks[route] ?? []));
  for (const link of prefetch) {
    assert.ok(wanted.has(link.href), `${link.href} is a main screen’s file`);
    assert.equal(link.as, link.href.endsWith('.css') ? 'style' : 'script');
    assert.equal(link.crossorigin, '');
  }
  assert.ok(prefetch.some((link) => screen.test(link.href)), 'the screens’ files are among them');
  const prefetchedAt = await home.evaluate(() => {
    const load = performance.getEntriesByType('navigation')[0].loadEventEnd;
    const hrefs = new Set([...document.querySelectorAll('link[rel="prefetch"]')].map((link) => link.getAttribute('href')));
    return performance.getEntriesByType('resource').filter((entry) => hrefs.has(new URL(entry.name).pathname)).map((entry) => entry.startTime - load);
  });
  for (const after of prefetchedAt) assert.ok(after >= 3_500, `a prefetch began ${Math.round(after)} ms after the page loaded`);
  clean(home, 'home');
  await close(home);
});

// D7: Tab from New position's token search lost the keyboard's place: the list's scrolling box was a Tab stop that
// closed as the input blurred, and focus fell to the end of the page.
test('Tab from New position’s token search moves on to the next control; the list is never a stop', async () => {
  const page = await open('/new');
  const input = page.locator('input[role="combobox"]').first();
  await input.focus();
  await page.keyboard.type('U');
  const list = page.locator('[role="listbox"]').first();
  assert.equal(await list.getAttribute('tabindex'), '-1');
  await page.keyboard.press('Tab');
  const active = await page.evaluate(() => {
    const element = document.activeElement;
    return { body: element === document.body || element === null, inList: Boolean(element?.closest('[role="listbox"]')), tag: element?.tagName ?? null };
  });
  assert.equal(active.body, false, `focus was lost to the page (${active.tag})`);
  assert.equal(active.inList, false, 'focus left the search for the next control, not into the list');
  clean(page, 'new position keyboard');
  await close(page);
});

// 2026-10-01 (the chain2 workstream, part B): the second chain's section is a route of its own, #/elysium…, drawn from a
// chunk only that route opens. Changed on purpose 2026-10-01 (fix round 1): on any origin but the exact preview alias
// and the local development servers (this suite's is 127.0.0.1 on a random port) the route does not exist, like
// domino.money's: the page is Not found, asks for none of the section's code, names no chain and reads nothing of it
// (src/App.tsx ELYSIUM_OPEN). The menu does not link it (the menu's entries are pinned in the Settings test above).
test('#/elysium is not found where the second chain’s section is off: no chunk, no chain named, nothing read', async () => {
  for (const route of ['/elysium', '/elysium/pool/0x4b79c0e837ab70451bc849bf21d9ea3b25b69883', '/elysium/new', '/elysium/receipts']) {
    const page = await open(route);
    await page.locator('[data-not-found]').waitFor();
    assert.equal(await page.locator('[data-chain2-section]').count(), 0, route);
    assert.doesNotMatch(await page.locator('main').innerText(), /Elysium/i, `${route}: no chain named`);
    assert.doesNotMatch(await page.title(), /Elysium/i, `${route}: nor in the tab`);
    assert.equal(await page.locator('header nav[aria-label="Main"] a[aria-current="page"]').count(), 0, `${route}: nothing lit`);
    const loaded = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => new URL(entry.name).pathname));
    assert.ok(!loaded.some((path) => /ElysiumEntry-/.test(path)), `${route}: the section's chunk is never asked for`);
    const asked = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name));
    assert.deepEqual(asked.filter((url) => /kinetiq|elysium\.|\/uniswap-v3\//.test(url)), [], `${route}: nothing of that chain is read`);
    clean(page, route);
    await close(page);
  }
  // Home loads none of it.
  const home = await open('/');
  const homeLoaded = await home.evaluate(() => performance.getEntriesByType('resource').map((entry) => new URL(entry.name).pathname));
  assert.ok(!homeLoaded.some((path) => /ElysiumEntry-/.test(path)), 'Home loads none of the section');
  clean(home, 'home');
  await close(home);
});
