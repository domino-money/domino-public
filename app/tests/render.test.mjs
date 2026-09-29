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
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { closeBrowser } from './support/close-browser.mjs';
import { TEXT_FILE, findForbidden } from '../scripts/deploy-markers.mjs';
import { apiOf, close, go, leaving, open as openPage, problemsOf, reload, shown } from './page-watch.mjs';
import { CONTROL_VIEWPORTS, MOTION_CONTROL, textUnderMotionControl } from './motion-overlap.mjs';
import { feesAnswer } from './support/fees/stub.mjs';

const DIST = resolve(import.meta.dirname, '../dist');
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
  assert.match(body, /Robinhood Chain/);

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

test('every route in the header renders', async () => {
  for (const [route, expected, settled] of [
    ['/', /Robinhood Chain/],
    ['/markets', /Markets[\s\S]*Selected pools[\s\S]*Search the pool catalogue/],
    [`/markets/0x${'1'.repeat(40)}`, /Markets[\s\S]*Search the pool catalogue/],
    // 2026-09-26 (featured pools v1, kept after review): a pool page with no token, for a pool outside the list, says
    // today's words while the embedded list is on screen.
    [`/pool/0x${'2'.repeat(64)}`, /Open this pool from Markets[\s\S]*is not one of the selected six, and this link names no token to verify it with\./],
    ['/explore', /Markets[\s\S]*Selected pools[\s\S]*Search the pool catalogue/],
    ['/pools', /Markets[\s\S]*Selected pools[\s\S]*Search the pool catalogue/],
    ['/positions', /Positions[\s\S]*Managed positions/],
    ['/app', /Positions[\s\S]*Managed positions/],
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
    ['/setup', /Deposits and recovery[\s\S]*To open a new position, use New position: its last step creates it through your wallet\./, '[data-setup-release="unavailable"]'],
    // Changed on purpose (2026-09-24, the owner's simpler automation page): its title is its one action, and without a release it says so.
    ['/sequence', /Set up automation[\s\S]*Automation can’t be set up here\./, '[data-sequence-release="unavailable"]'],
  ]) {
    const page = await open(route);
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
    clean(page, `header on ${route}`);
    await close(page);
  }
});

test('the mobile Positions screen leads to Markets: reachable, bounded to the viewport, and idle until a read is requested', async () => {
  const page = await open('/app');
  assert.equal(await page.locator('header').getByRole('link', { name: 'Markets', exact: true }).first().getAttribute('href'), '#/markets');
  await page.setViewportSize({ width: 375, height: 812 });
  const entrance = page.locator('main').getByRole('link', { name: 'Markets', exact: true });
  assert.equal(await entrance.isVisible(), true, 'the mobile Positions screen has a visible entrance');
  await entrance.click();
  await page.getByRole('heading', { name: 'Markets', exact: true }).waitFor();
  await shown(page, '/markets');
  // The selected pools are on the page, so Markets asks the featured list and the capabilities the way the landing does, and posts nothing else.
  const trail = () => [...(apiOf(page).at(-1) ?? [])];
  assert.deepEqual(trail(), CAPABILITIES, 'Markets asks the list and checks each needed namespace once');

  // A pair-name filter that no selected pool matches: nothing is read to decide.
  const address = '0x1111111111111111111111111111111111111111';
  const search = page.locator('#markets-search');
  assert.equal(await search.isVisible(), true);
  await search.fill(address);
  await page.waitForTimeout(300);
  assert.deepEqual(trail(), CAPABILITIES, 'filtering the selected pools reads nothing');

  // The empty state offers the token search, already holding that address, and it reads nothing until a token is chosen.
  const combobox = page.getByRole('combobox', { name: 'Token name or address' });
  await combobox.waitFor();
  assert.equal(await combobox.inputValue(), address, 'the token search starts from the address typed as a pair name');
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

  // Nothing on screen may be a lettered fallback: every registered symbol has
  // a file. The fallback exists for symbols we have not registered, not for
  // the ones the app itself chooses to display.
  const discs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('span[aria-hidden="true"]'))
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

// Changed on purpose (owner, 2026-09-26: dark only): this was the appearance toggle's check, and the toggle is gone with
// the light theme. The footer's motion control, which sat beside it, keeps the same protection, and nothing else is there.
for (const [width, height] of CONTROL_VIEWPORTS) {
  test(`at ${width}x${height} the footer's motion control is its only control and never covers text on the landing page, its pools table or the footer, wherever the page is scrolled`, async () => {
    const page = await open('/');
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(100);
    const { hits, seen } = await textUnderMotionControl(page, ['#pools', 'footer']);
    assert.deepEqual(seen, ['#pools', 'footer'], 'the pools table and the footer are on the landing page');
    assert.deepEqual(hits, [], `the motion control covers text at ${width}x${height}:\n${hits.join('\n')}`);
    assert.deepEqual(await page.locator('footer button').allInnerTexts(), ['Pause motion'], 'the footer holds one control, and no appearance toggle');
    // Still reachable and working at this width.
    const control = page.locator('footer').getByRole('button', { name: MOTION_CONTROL });
    await control.scrollIntoViewIfNeeded();
    await control.click();
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dm-still')), true, 'Pause motion stills the page');
    assert.equal(await control.innerText(), 'Resume motion');
    clean(page, `motion control at ${width}px`);
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
    assert.deepEqual(look, { scheme: 'dark', page: 'rgb(13, 10, 8)', body: 'rgb(13, 10, 8)', text: 'rgb(247, 241, 234)', classes: [], themed: false }, `system ${scheme}`);
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
  const faces = styles.match(/@font-face\{[^}]*\}/g) ?? [];
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
  const page = await open('/');
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

test('section links land on their target, across routes and within one route', async () => {
  const page = await open('/');
  const header = await page.evaluate(() => document.querySelector('header')?.getBoundingClientRect().height ?? 0);

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
  const learnTop = await sectionTop(page, 'learn');
  assert.ok(learnTop >= 0 && learnTop <= header + 40, `#learn landed at ${learnTop}px, header is ${header}px`);

  // Same route, different section: only the hash section changes.
  await page.evaluate(() => { location.hash = '#/#pools'; });
  const poolsTop = await sectionTop(page, 'pools');
  assert.ok(poolsTop >= 0 && poolsTop <= header + 40, `#pools landed at ${poolsTop}px`);
  await page.evaluate(() => { location.hash = '#/#ranges'; });
  const rangesTop = await sectionTop(page, 'ranges');
  assert.ok(rangesTop >= 0 && rangesTop <= header + 40, `#ranges landed at ${rangesTop}px`);
  await page.evaluate(() => { location.hash = '#/#learn'; });
  const backTop = await sectionTop(page, 'learn');
  assert.ok(backTop >= 0 && backTop <= header + 40, `#learn (second time) landed at ${backTop}px`);

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
    ['Markets', 'Positions', 'Automate', 'New position', 'Docs', 'How it works', 'Ranges explained', 'What Domino does not do'],
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
test('the price control maps its value to the knob, its chip, earning or not, and what the position holds', async () => {
  const page = await open('/');
  const slider = page.locator('#sim-price');
  await slider.scrollIntoViewIfNeeded();
  assert.deepEqual([await slider.getAttribute('min'), await slider.getAttribute('max'), await slider.getAttribute('step')], ['-1.1', '1.1', '0.01']);
  assert.equal(await page.locator('label[for="sim-price"]').innerText(), 'ETH price, against the start');
  const stage = await page.locator('[data-sim-stage]').boundingBox();

  for (const [v, chip, earning, hold, spoken] of [
    [0, 'ETH at start price', 'Earning fees', ['53%', '47%'], 'ETH at its start price. Earning fees. You hold 53% ETH and 47% USDG.'],
    [0.3, 'ETH price +23%', 'Earning fees', ['28%', '72%'], 'ETH up 23%. Earning fees. You hold 28% ETH and 72% USDG.'],
    [0.85, 'ETH price +80%', 'Not earning', ['0%', '100%'], 'ETH up 80%. Not earning. You hold 0% ETH and 100% USDG.'],
    [-0.8, 'ETH price −43%', 'Not earning', ['100%', '0%'], 'ETH down 43%. Not earning. You hold 100% ETH and 0% USDG.'],
    [-1.1, 'ETH price −53%', 'Not earning', ['100%', '0%'], null],
    [1.1, 'ETH price +114%', 'Not earning', ['0%', '100%'], null],
  ]) {
    await setRange(page, '#sim-price', v);
    assert.equal(await num(page, '#sim-price'), v, 'the input did not take the value');
    const knob = await page.locator('#ranges .dm-sim-knob').boundingBox();
    const expected = stage.x + 22 + ((v + 1.1) / 2.2) * (stage.width - 44);
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
test('the simulator’s knob is the slider’s own thumb, top to bottom and a finger wide', async () => {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const page = await open('/');
    await page.setViewportSize(viewport);
    await page.evaluate(() => document.getElementById('ranges').scrollIntoView({ block: 'center' }));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(100);
    await setRange(page, '#sim-price', 0);
    const input = await page.locator('#sim-price').boundingBox();
    const knob = await page.locator('#ranges .dm-sim-knob').boundingBox();
    const cx = knob.x + knob.width / 2;
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
      for (const dx of [-18, 7, 18]) {
        assert.equal(await press(cx + dx, y), 0, `${viewport.width}px: a press at ${dx}px from the knob, y ${y}, missed the thumb`);
      }
    }
    assert.ok(knob.y >= top && knob.y + knob.height <= bottom, `${viewport.width}px: the knob (y ${knob.y}) is outside the slider`);
    assert.notEqual(await press(cx + 60, middle), 0, `${viewport.width}px: a press well off the knob did not move the price`);
    clean(page, `simulator thumb at ${viewport.width}px`);
    await close(page);
  }
});

// Added 2026-09-27 (owner, round 6): the illustration's trades pay the position only while the price is in its range,
// and stop the moment it leaves; stilled motion leaves the count out altogether.
test('trades pay the simulated position only while the price is in its range, and stilled motion leaves the count out', async () => {
  const page = await open('/');
  const slider = page.locator('#sim-price');
  await page.evaluate(() => document.getElementById('ranges').scrollIntoView({ block: 'center' }));
  const paid = () => page.locator('#ranges [data-sim-paid]').getAttribute('data-sim-paid').then(Number);
  await page.waitForFunction(() => Number(document.querySelector('#ranges [data-sim-paid]')?.getAttribute('data-sim-paid')) >= 1, null, { timeout: 5000 });
  assert.match(await page.locator('#ranges .dm-sim-paid').innerText(), /^\d+ trades? (has|have) paid you a fee$/);
  await setRange(page, '#sim-price', 0.85);
  const stopped = await paid();
  await page.waitForTimeout(1800);
  assert.equal(await paid(), stopped, 'no trade pays a position whose price is above its range');
  assert.equal(await page.locator('#ranges .dm-sim-fee').count(), 0, 'no fee rises while it is out of range');
  // Out of range the count never reads as earning under "Not earning": it says the trades paid before the price left.
  assert.match(await page.locator('#ranges .dm-sim-paid').innerText(), /^\d+ trades? paid you a fee before the price left$/);
  await setRange(page, '#sim-price', 0.1);
  await page.waitForFunction((from) => Number(document.querySelector('#ranges [data-sim-paid]')?.getAttribute('data-sim-paid')) > from, stopped, { timeout: 5000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#ranges .dm-sim-paid').waitFor({ state: 'detached' });
  assert.equal(await slider.count(), 1, 'the control stays');
  clean(page, 'simulated trades');
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
    const cells = await row.locator('td').evaluateAll((tds) => tds.slice(1, 5).map((td) => [td.innerText.trim(), td.querySelector('[aria-label]')?.getAttribute('aria-label') ?? null]));
    assert.deepEqual(cells, ['Price', 'TVL', '24h volume', 'Pool APR'].map((figure) => ['—', `${figure} unavailable`]), `${label}: every figure is a dash that says so`);
    assert.equal(await row.locator('a').first().getAttribute('title'), 'Listed on Uniswap. Pool figures are unavailable.');
  }
  assert.doesNotMatch(await page.locator('#pools').innerText(), /\$\s?\d/, `${label}: no dollar figure`);
  assert.equal(await page.locator('[data-metric], [data-apr-estimate]').count(), 0, `${label}: no figure anywhere on the landing`);
  // The strip lists the same six by their labels, an APR dash each and no figure: the one label a read row
  // without an estimate has too, so nothing changes words as rows land.
  const items = page.locator('.dm-marquee > a[data-pool-catalogue]');
  assert.equal(await items.count(), 6, `${label}: the ticker lists the six catalogue pools`);
  for (const text of await items.allInnerTexts()) assert.match(text, /Est\. APR —$/, `${label}: the ticker names no APR`);
  assert.equal(await page.locator('[data-ticker] [data-metric], [data-ticker] [data-apr-estimate]').count(), 0, `${label}: no figure in the ticker`);
  // A fee tier (0.02%) is a label from the catalogue; a dollar figure or an APR percentage would be an invention.
  assert.doesNotMatch(await page.locator('[data-ticker]').innerText(), /\$\s?\d|\d%\s*est/, `${label}: no figure in the ticker`);
  // 2026-09-26 (featured pools v1 §11.2): with no list served, the embedded list in its order under today's title and
  // no Pinned chip; every link names the pool and USDG, the token to verify it with (§11.6). The method line is gone
  // for every list since 2026-09-28 (the owner).
  assert.equal(await page.locator('#pools [data-featured-source]').getAttribute('data-featured-source'), 'bundled', `${label}: the embedded list`);
  assert.equal(await page.locator('#pools h2').first().innerText(), 'Selected pools', `${label}: today's title`);
  assert.deepEqual(await rows.evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-pool-catalogue'))), SELECTED, `${label}: the embedded six, in order`);
  assert.equal(await page.locator('[data-pinned]').count(), 0, `${label}: no Pinned chip`);
  const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  assert.deepEqual(await rows.evaluateAll((trs) => trs.map((tr) => tr.querySelector('a').getAttribute('href'))), SELECTED.map((id) => `#/pool/${id}/${USDG}`), `${label}: row links`);
  assert.deepEqual(await items.evaluateAll((as) => as.map((a) => a.getAttribute('href'))), SELECTED.map((id) => `#/pool/${id}/${USDG}`), `${label}: ticker links`);
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

test('selected pool screens ask the featured list, check each needed namespace once and post nothing else when disconnected; New position asks the list; owner screens ask only their release; other routes ask nothing', async () => {
  const seen = [];
  for (const route of ROUTES) {
    const page = await open(route);
    await reload(page, route);
    seen.push([route, apiOf(page)]);
    clean(page, `requests on ${route}`);
    await close(page);
  }
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
    // Each owner screen reads its public release profile once per document, a GET with no wallet and no session.
    ['/setup', [['GET /api/setup/v1/release'], ['GET /api/setup/v1/release']]],
    ['/sequence', [['GET /api/setup/v1/sequence-release'], ['GET /api/setup/v1/sequence-release']]],
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
  const entry = scripts.filter((file) => html.includes(file));
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

// Changed on purpose (qa:visual, Automate): the info panel under the two cards is gone, and the cards' ways in are one size, outline beside filled.
test('Automate shows the plain position, then its two cards and nothing under them, and each card’s way in is the same size', async () => {
  const page = await open('/automate');
  const ways = await Promise.all(['Set up Auto-compound', 'Set up Domino-compound'].map((name) =>
    page.getByRole('link', { name, exact: true }).evaluate((link) => ({ height: link.getBoundingClientRect().height, outline: link.classList.contains('dm-btn--outline'), sm: link.classList.contains('dm-btn--sm') }))));
  assert.deepEqual(ways.map(({ outline, sm }) => [outline, sm]), [[true, false], [false, false]], 'outline beside filled, neither small');
  assert.equal(ways[0].height, ways[1].height, `the two ways in: ${ways.map(({ height }) => height).join(' vs ')} px`);
  assert.equal(await page.locator('main .dm-inset, main .dm-acct-auto-note').count(), 0, 'no panel under the cards');
  assert.doesNotMatch(await page.locator('main').innerText(), /Setup checks the deployment/, 'no note under the cards');
  assert.equal(await page.locator('[data-automation-card="compound"] .dm-acct-auto-fee dd').innerText(), '2% of earned fees consumed, once');
  assert.equal(await page.locator('[data-automation-card="domino"] .dm-acct-auto-fee dd').innerText(), '4% of earned fees consumed, once');
  // 2026-09-24 (the three features): the plain position leads the page, one line and one way in, New position, before the
  // two automations that start from it.
  const plain = page.locator('main [data-feature="plain"]');
  assert.match(await plain.innerText(), /^Plain position\s+Fees wait in the position until you collect them\.\s+New position$/);
  assert.deepEqual(await plain.getByRole('link').evaluateAll((links) => links.map((a) => [a.textContent, a.getAttribute('href')])), [['New position', '#/new']]);
  assert.deepEqual(await page.locator('main [data-feature="plain"], main [data-automation-card]').evaluateAll((cards) => cards.map((card) => card.getAttribute('data-feature') ?? card.getAttribute('data-automation-card'))), ['plain', 'compound', 'domino']);
  clean(page, 'automate');
  await close(page);
});

/** The routes that open Positions, whose list asks for a wallet in its own empty state. */
const POSITIONS_ROUTES = new Set(['/positions', '/app', '/portfolio']);

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
    if (POSITIONS_ROUTES.has(route)) await page.locator('[data-empty="owned-connect"]').waitFor();
    const buttons = await page.getByRole('button', { name: 'Connect wallet' }).all();
    assert.equal(buttons.length, POSITIONS_ROUTES.has(route) ? 2 : 1, `Connect wallet on ${route}: found ${buttons.length}`);
    for (const button of buttons) assert.equal(await button.isDisabled(), false, `Connect wallet is disabled on ${route}`);
    assert.equal(await page.locator('header').getByRole('button', { name: 'Connect wallet' }).count(), 1, `the control is not in the header on ${route}`);
    assert.doesNotMatch(await page.locator('#root').innerText(), /practice/i, `practice on ${route}`);
    // Changed on purpose (owner, 2026-09-26: dark only): the appearance, the one thing kept here, is gone with the light
    // theme. The footer's remaining control, Pause motion, is used instead, and it is kept in memory only.
    await page.locator('footer').getByRole('button', { name: 'Pause motion', exact: true }).click();
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
test('the positions screen is an honest empty state: no cards, totals or private figures, a sign-in for the managed side, and a way back to the pools', async () => {
  const page = await open('/app');
  assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), 'Positions');
  // The list arrives with its own chunk: with no wallet it asks for one, and reads nothing.
  const empty = page.locator('[data-empty="owned-connect"]');
  await empty.waitFor();
  assert.equal(await page.locator('[data-owned]').getAttribute('data-owned'), 'no-wallet');
  const text = await page.locator('#root').innerText();
  assert.match(text, /Your positions\s+Connect a wallet to see your positions\s+Connect wallet/);
  assert.doesNotMatch(text, /Look up|Position NFTs|Enter its ID|NFT ids?\b/i, 'no typed ids asked for, anywhere');
  assert.equal(await page.locator('details[data-lookup-disclosure], #nft-ids, #chain-lookup').count(), 0, 'no lookup by NFT id at all');
  // The managed side asks for a wallet session and shows nothing private without one.
  // Changed on purpose (owner, 2026-09-27, round 5: plain words for people new to pools): the two sign-in sentences and the
  // two lines under the titles say what is there, with no "private", "execution" or "sequences".
  assert.match(text, /Sign in with your wallet to see your automated positions\./);
  assert.match(text, /Sign in with your wallet to see your receipts\./);
  // Changed on purpose (qa:visual, Positions): one plain line under Managed positions and Receipts, and no hint under the Wallet field.
  // The state rules those captions printed are titles now.
  assert.match(text, /Managed positions[\s\S]*Last 24 hours[\s\S]*How your automated positions did in the last 24 hours\./);
  assert.match(text, /Receipts[\s\S]*See all[\s\S]*What automation did for your positions\./);
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
test('the receipts page opens from the Receipts card, keeps Positions lit, and signed out asks for a sign-in and reads nothing', async () => {
  const page = await open('/positions');
  await page.locator('[data-receipts-all]').click();
  await page.waitForFunction(() => location.hash === '#/positions/receipts');
  await page.getByText('Sign in with your wallet to see your receipts.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), 'Receipts');
  assert.equal(await page.getByRole('heading', { level: 2, name: 'All receipts' }).count(), 1);
  const nav = await page.locator('header nav[aria-label="Main"] a').evaluateAll((els) => els.map((a) => [a.textContent.trim(), a.getAttribute('aria-current')]));
  assert.deepEqual(nav, [['Markets', null], ['Positions', 'page'], ['Automate', null]]);
  assert.deepEqual(await page.locator('main a').evaluateAll((els) => els.map((a) => [a.textContent.trim(), a.getAttribute('href')])), [['Positions', '#/positions']], 'one way back, and the page does not link itself');
  const text = await page.locator('main').innerText();
  assert.doesNotMatch(text, /Managed positions|Your positions|\$\s?\d|0x[0-9a-fA-F]{4}/, 'the receipts alone (no other card), and no figure or hash signed out');
  assert.equal(await page.getByRole('button', { name: 'Connect wallet' }).count(), 1, 'the header keeps the one wallet control');
  assert.deepEqual(apiOf(page), [[]], 'the receipts page reads nothing by itself');
  clean(page, 'receipts page');
  await close(page);
});

test('the explanatory sections stay, in relative terms, and say plainly what is not enabled', async () => {
  const page = await open('/');
  const text = await page.locator('#root').innerText();
  // Home: the hero, the feature cards and the pools; below them how it works, the range simulator, what Domino does not do.
  for (const heading of [/Earn fees on your tokens, on your own terms\./, /Pick a pool\. Set a range\. Decide what happens to the fees\./, /Move the price\. Watch what you own\./, /What Domino does not do\./]) {
    assert.match(text, heading);
  }
  // The Uniswap strip, the old headlines and the simulator's explanation are gone (owner, 2026-09-14).
  assert.doesNotMatch(text, /Built on Uniswap|Put fees to work|one tile at a time|Choose what fees do|A position opened at the start price/);
  // The landing page describes owner-scoped availability without claiming the service is on or off for everyone.
  // Changed on purpose (owner, round 6, 2026-09-27): the simulator names the automation in one plain line and wears no
  // pill, so the two automation feature cards say it (the How it works step is counted below).
  assert.ok((text.match(/Per sequence/g) ?? []).length >= 2, 'the feature cards say so');
  assert.equal(await page.locator('.dm-features .dm-pill', { hasText: 'Per sequence' }).count(), 2, 'Auto-compound and Domino-compound wear ROADMAP’s pill');
  assert.equal(await page.locator('#learn .dm-pill', { hasText: 'Per sequence' }).count(), 1, 'the Automation step of How it works wears ROADMAP’s pill');
  assert.doesNotMatch(text, /Not running|automation is running/i);
  // The pools card has no caption any more (the owner's decision on the redesign): each figure names its source and age in its own title.
  assert.doesNotMatch(text, /Every figure on this page names its source and its age|describes a pool, not a position, and is not a forecast/);
  // The product describes itself as the product, never as an unfinished one.
  assert.doesNotMatch(text, /\balpha\b|\bv4\b|not enabled yet|read-only/i, 'no self-description as an alpha, a version or a read-only build');
  assert.doesNotMatch(text, /Made for every way to hold liquidity|One position sets up the next/, 'no product cards, no Domino sequence');
  // Changed on purpose (owner, round 6, 2026-09-27: "remove the jargon"): the simulator's range reads as a move from the
  // start, −30% to +50%, with the three zones named in plain words; no multiple, no range switch, no figure list, no
  // pill, and the automation in one line.
  const sim = await page.locator('#ranges').innerText();
  for (const words of [/Only ETH/, /Your range/, /Only USDG/, /−30%/, /\+50%/, /Start/, /What you hold/, /Auto-compound adds them back into your position/, /Domino-compound uses them to open your next range a step higher/]) {
    assert.match(sim, words);
  }
  assert.doesNotMatch(sim, /×|Closer|Wider|Per sequence|Figures, and the other range|Domino steps in|Stablecoin|Token share/, 'no multiple, range switch, figure list, pill or old wording');
  assert.equal(await page.locator('#ranges input').count(), 1, 'one control: the price');
  assert.equal(await page.locator('#ranges details, #ranges button, #ranges [role="radiogroup"]').count(), 0, 'nothing folded away and no second control');
  assert.doesNotMatch(text, /MEME|Example token/, 'no example token');
  assert.equal(await page.locator('#hero-amount, #amount').count(), 0, 'no amount to type in');
  // The hero's two ways in.
  assert.equal(await page.locator('main').getByRole('link', { name: 'New position', exact: true }).first().getAttribute('href'), '#/new');
  assert.equal(await page.locator('main').getByRole('link', { name: 'Explore markets', exact: true }).first().getAttribute('href'), '#/markets');
  // No Domino token card on Home any more (owner, 2026-09-14).
  assert.equal(await page.locator('[data-domino-token]').count(), 0, 'no Domino token card on Home');
  assert.doesNotMatch(text, /The Domino token is coming|Ticker, supply and launch date/);
  assert.doesNotMatch(await page.locator('#pools').innerText(), /COMBINED TVL|NETWORK/, 'the six-pool stat strip is gone');
  clean(page, 'explanatory sections');
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
  assert.equal(pages.length, 16, `the sidebar lists ${pages.length} pages`);
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
  const operator = toc.getByRole('link', { name: 'What the operator can and cannot do', exact: true });
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

test('the Non-custodial card on Home opens the custody page of the docs', async () => {
  const page = await open('/');
  // Scoped to the card: the footer also has a "How it works" link, to the landing section.
  const link = page.locator('main article', { hasText: 'Non-custodial' }).getByRole('link', { name: 'How it works', exact: true });
  assert.equal(await link.getAttribute('href'), '#/docs/non-custodial');
  leaving(page);
  await link.click();
  await page.waitForFunction(() => location.hash === '#/docs/non-custodial');
  await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Non-custodial');
  clean(page, 'home custody card');
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
