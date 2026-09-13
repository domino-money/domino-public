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
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { TEXT_FILE, findForbidden } from '../scripts/deploy-markers.mjs';
import { apiOf, close, leaving, open as openPage, problemsOf, reload, shown } from './page-watch.mjs';
import { TOGGLE_VIEWPORTS, textUnderToggle } from './toggle-overlap.mjs';

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
};

if (!existsSync(join(DIST, 'index.html'))) {
  throw new Error('dist/index.html is missing. Run `npm run build` before this test.');
}

/** Static file server for dist, with an index fallback so hash routes load. */
function serveDist() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
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
  await browser?.close();
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
 * estimate namespace's capabilities, then the read namespace's. Never a POST
 * when live data is not connected.
 */
const CAPABILITIES = ['GET /api/read/v2/capabilities', 'GET /api/read/v1/capabilities'];

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

/** Home, the three places in the header, the older spellings App.tsx keeps for two of them, and the two pages the menu and the footer add. */
const ROUTES = ['/', '/markets', '/explore', '/pools', '/positions', '/app', '/portfolio', '/new', '/automate', '/settings'];

test('every route in the header renders', async () => {
  for (const [route, expected] of [
    ['/', /Robinhood Chain/],
    ['/markets', /Markets[\s\S]*Selected pools[\s\S]*Search the pool catalogue/],
    [`/markets/0x${'1'.repeat(40)}`, /Markets[\s\S]*Search the pool catalogue/],
    ['/explore', /Markets[\s\S]*Selected pools[\s\S]*Search the pool catalogue/],
    ['/pools', /Markets[\s\S]*Selected pools[\s\S]*Search the pool catalogue/],
    ['/positions', /Positions[\s\S]*Managed positions/],
    ['/app', /Positions[\s\S]*Managed positions/],
    ['/portfolio', /Wallet/],
    ['/new', /New position/],
    ['/automate', /Automate[\s\S]*Auto-compound[\s\S]*Domino sequences/],
    ['/settings', /Appearance|Compound|Capabilities/i],
  ]) {
    const page = await open(route);
    const body = await page.locator('#root').innerText();
    assert.match(body, expected, `route ${route}`);
    assert.ok(body.length > 200, `route ${route} rendered almost nothing`);
    clean(page, `route ${route}`);
    await close(page);
  }
});

test('the header names the three places, each at its route, and marks the one that is open', async () => {
  // Markets is lit on its page and its older spellings; Positions on its own, its older spellings and the flow it leads to; Home and Settings light nothing.
  const LIT = { '/': null, '/markets': 'Markets', '/explore': 'Markets', '/pools': 'Markets', '/positions': 'Positions', '/app': 'Positions', '/portfolio': 'Positions', '/new': 'Positions', '/automate': 'Automate', '/settings': null };
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
  // The selected pools are on the page, so Markets asks the capabilities the way the landing does, and posts nothing.
  const trail = () => [...(apiOf(page).at(-1) ?? [])];
  assert.deepEqual(trail(), CAPABILITIES, 'Markets asks the capabilities once and posts nothing');

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

for (const [width, height] of TOGGLE_VIEWPORTS) {
  test(`at ${width}x${height} the appearance toggle never covers text on the landing page, its pools table or the footer, wherever the page is scrolled`, async () => {
    const page = await open('/');
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(100);
    const { hits, seen } = await textUnderToggle(page, ['#pools', 'footer']);
    assert.deepEqual(seen, ['#pools', 'footer'], 'the pools table and the footer are on the landing page');
    assert.deepEqual(hits, [], `the toggle covers text at ${width}x${height}:\n${hits.join('\n')}`);
    // Still reachable and working at this width.
    const toggle = page.locator('button[aria-label^="Switch to"]');
    await toggle.scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => document.documentElement.classList.contains('dark'));
    await toggle.click();
    assert.notEqual(await page.evaluate(() => document.documentElement.classList.contains('dark')), before);
    clean(page, `appearance toggle at ${width}px`);
    await close(page);
  });
}

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

test('dragging the price through the DOM holds a still pointer to a still price, and never moves the range', async () => {
  const page = await open('/');
  const chart = page.getByTestId('range-chart-price');
  await chart.scrollIntoViewIfNeeded();
  const box = await chart.boundingBox();
  const axis = page.locator('[data-range-axis]');
  const rangeBefore = await axis.innerText();
  const y = box.y + box.height / 2;

  await page.mouse.move(box.x + box.width * 0.3, y);
  await page.mouse.down();
  // Move once to the right, then keep the pointer perfectly still while firing more move events.
  const targetX = box.x + box.width * 0.62;
  await page.mouse.move(targetX, y, { steps: 4 });
  const first = await num(page, '#sim-price');
  assert.ok(first > 1, `the price did not follow the pointer (${first})`);
  const seen = [];
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(targetX, y);
    seen.push(await num(page, '#sim-price'));
  }
  await page.mouse.up();

  assert.deepEqual(seen, seen.map(() => first), `the price crept under a still pointer: ${seen.join(', ')}`);
  await page.waitForTimeout(50);
  assert.equal(await num(page, '#sim-price'), first, 'the price changed on release');
  assert.equal(await axis.innerText(), rangeBefore, 'the range moved during the gesture');
  assert.match(await chart.locator('.tnum').first().innerText(), /^\d\.\d\d×$/, 'the marker reads a multiple of the start price');
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

  // A route with no section starts at the top.
  await page.evaluate(() => { location.hash = '#/settings'; });
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
  assert.deepEqual(
    links.filter((l) => l.footer).map((l) => l.text),
    ['Markets', 'Positions', 'Automate', 'New position', 'Settings', 'How it works', 'Ranges explained', 'What Domino does not do'],
    'the footer names the product pages and the guides on the landing',
  );
  // The routes App.tsx wires, with the older spellings it keeps: `#/explore` and `#/pools` are Markets, `#/app` is Positions.
  const ROUTES = ['/', '/markets', '/explore', '/pools', '/pool', '/positions', '/app', '/portfolio', '/new', '/automate', '/settings'];
  for (const link of links) {
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
  // No social icon, and the pending legal documents are text, not links.
  const footer = page.locator('footer');
  for (const name of ['X', 'Discord', 'Telegram', 'GitHub', 'Documentation', 'Security', 'Status', 'Fees and profit']) {
    assert.equal(await footer.getByRole('link', { name, exact: true }).count(), 0, `footer still links "${name}"`);
  }
  assert.equal(await footer.getByRole('link', { name: /Terms|Privacy/ }).count(), 0, 'pending legal documents are not links');
  assert.match(await footer.innerText(), /Terms of Service and Privacy Policy: pending/);
  clean(page, 'footer and navigation links');
  await close(page);
});

test('the price slider maps its value to the thumb label and position', async () => {
  const page = await open('/');
  const slider = page.locator('#sim-price');
  await slider.scrollIntoViewIfNeeded();
  const min = Number(await slider.getAttribute('min'));
  const max = Number(await slider.getAttribute('max'));
  assert.ok(max > min);

  for (const value of [min, (min + max) / 2, max, 1.37]) {
    const v = Math.round(value * 100) / 100;
    await setRange(page, '#sim-price', v);
    const state = await page.evaluate(() => {
      const input = document.getElementById('sim-price');
      const thumb = input.parentElement.querySelector('.pointer-events-none');
      return { value: Number(input.value), label: thumb.textContent.trim(), left: parseFloat(thumb.style.left) };
    });
    assert.equal(state.value, v, 'the input did not take the value');
    const expectedPct = ((v - min) / (max - min)) * 100;
    assert.ok(Math.abs(state.left - expectedPct) < 0.01, `thumb at ${state.left}% for ${v}, expected ${expectedPct}%`);
    assert.match(state.label, /^\d+\.\d{2}×$/, `thumb label "${state.label}" is not a multiple of the start price`);
    assert.equal(Number(state.label.replace('×', '')), v, `thumb label ${state.label} does not match ${v}`);
  }
  clean(page, 'price slider');
  await close(page);
});

/**
 * With nothing read, the six reviewed pools are still listed, from the
 * catalogue's labels alone: every figure cell a dash that says it is
 * unavailable, no `data-metric` and no estimate anywhere, no USD text, and
 * each row saying live pool data is not available. Nothing stands in for a
 * figure that was not read.
 */
async function catalogueOnly(page, label) {
  const rows = page.locator('#pools tbody tr');
  assert.equal(await rows.count(), 6, `${label}: the six reviewed pools, listed from the catalogue`);
  assert.equal(await page.locator('#pools tbody tr[data-pool-catalogue]').count(), 6, `${label}: every row is a catalogue row, labels only`);
  assert.equal(await page.locator('#pools tbody [data-metric], #pools tbody [data-apr-estimate]').count(), 0, `${label}: no figure in any cell`);
  for (const row of await rows.all()) {
    const cells = await row.locator('td').evaluateAll((tds) => tds.slice(1, 5).map((td) => [td.innerText.trim(), td.querySelector('[aria-label]')?.getAttribute('aria-label') ?? null]));
    assert.deepEqual(cells, ['Price', 'TVL', '24h volume', 'Pool APR'].map((figure) => ['—', `${figure} unavailable`]), `${label}: every figure is a dash that says so`);
    assert.equal(await row.locator('a').first().getAttribute('title'), 'Listed on Uniswap. Live pool data is not available yet.');
  }
  assert.doesNotMatch(await page.locator('#pools').innerText(), /\$\s?\d/, `${label}: no dollar figure`);
  assert.equal(await page.locator('[data-metric], [data-apr-estimate]').count(), 0, `${label}: no figure anywhere on the landing`);
  // The strip lists the same six by their labels, an APR dash each and no figure.
  const items = page.locator('.dm-marquee > a[data-pool-catalogue]');
  assert.equal(await items.count(), 6, `${label}: the ticker lists the six catalogue pools`);
  for (const text of await items.allInnerTexts()) assert.match(text, /APR —$/, `${label}: the ticker names no APR`);
  assert.equal(await page.locator('[data-ticker] [data-metric], [data-ticker] [data-apr-estimate]').count(), 0, `${label}: no figure in the ticker`);
  // A fee tier (0.02%) is a label from the catalogue; a dollar figure or an APR percentage would be an invention.
  assert.doesNotMatch(await page.locator('[data-ticker]').innerText(), /\$\s?\d|\d%\s*est/, `${label}: no figure in the ticker`);
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
  await quietStatus(page, '#pools', "Live data isn't connected yet", 'Home');
  await catalogueOnly(page, 'not connected');
  clean(page, 'not connected');
  await close(page);

  const markets = await open('/markets');
  await markets.waitForFunction(() => document.querySelector('[data-selected-pools] [data-read-status]')?.getAttribute('data-read-status') === 'not_connected');
  await quietStatus(markets, '[data-selected-pools]', "Live data isn't connected yet", 'Markets');
  assert.doesNotMatch(await markets.locator('main').innerText(), /reported by GeckoTerminal and not reconciled|names its source and its age/, 'Markets: no footnote under the table');
  clean(markets, 'Markets not connected');
  await close(markets);
});

// ---------------------------------------------------------------------------
// The deployable build reads live through the same-origin bridge. This server
// has no /api behind it, like a deployment without the forwarder, so the
// landing shows the not-connected state: one capabilities GET, no POST and
// no figure. read-states and read-bridge cover the fixture and bridge-test
// builds, and release.browser.test.mjs covers dist behind the gate, with a
// stub bridge.
// ---------------------------------------------------------------------------

const SELECTED = readFileSync(resolve(import.meta.dirname, '../src/config/selectedPools.ts'), 'utf8').match(/0x[0-9a-f]{64}/g);

test('the screens that show the selected pools ask the capabilities once and post nothing when live data is not connected; every other route asks nothing', async () => {
  const seen = [];
  for (const route of ROUTES) {
    const page = await open(route);
    await reload(page, route);
    seen.push([route, apiOf(page)]);
    clean(page, `requests on ${route}`);
    await close(page);
  }
  // Per document: the first load and the reload each ask once per namespace, and post nothing.
  const once = CAPABILITIES;
  assert.deepEqual(seen, [
    ['/', [once, once]],
    ['/markets', [once, once]],
    ['/explore', [once, once]],
    ['/pools', [once, once]],
    ['/positions', [[], []]],
    ['/app', [[], []]],
    ['/portfolio', [[], []]],
    ['/new', [[], []]],
    ['/automate', [[], []]],
    ['/settings', [[], []]],
  ]);
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

test('Settings distinguishes disconnected automation from separately reviewed wallet transactions, and live reads built in, switched on by the server; no practice mode is left', async () => {
  const page = await open('/settings');
  const text = await page.locator('#root').innerText();
  // The stat labels are set in capitals by the stylesheet, and innerText follows that.
  assert.match(text, /AUTOMATED SIGNING\s+Not connected/);
  assert.match(text, /WALLET TRANSACTIONS\s+Built in; each step reviewed in wallet/);
  assert.match(text, /Nothing in this build signs a transaction, grants a spending permission or moves funds; a wallet connection only proves an address\./);
  assert.match(text, /Live reads are built in and switched on by the read service, never here\./);
  assert.match(text, /Compound[\s\S]*Not connected/);
  assert.match(text, /Fee-balancing swaps[\s\S]*Not connected/);
  assert.match(text, /Wallet permissions[\s\S]*Sign-in proves your address[\s\S]*Not connected/);
  assert.doesNotMatch(text, /Enabled\b/, 'nothing is reported as enabled');
  assert.equal(await page.locator('[data-build-banner]').count(), 0, 'no fixture or test-build banner');
  clean(page, 'settings');
  await close(page);
});

test('the wallet control is on every route and ready, no route mentions practice, and only the appearance is stored', async () => {
  for (const route of ROUTES) {
    const page = await open(route);
    // No wallet is injected in this suite, so the control invites one. It is
    // enabled: sign-in is built into the deployed site now, and opening it
    // signs nothing (tests/session.browser.test.mjs drives the flow itself).
    // One way in, in the header, on every route: a second control would leave
    // the reader guessing which one signs them in.
    const buttons = await page.getByRole('button', { name: 'Connect wallet' }).all();
    assert.equal(buttons.length, 1, `expected one Connect wallet on ${route}, found ${buttons.length}`);
    assert.equal(await buttons[0].isDisabled(), false, `Connect wallet is disabled on ${route}`);
    assert.equal(await page.locator('header').getByRole('button', { name: 'Connect wallet' }).count(), 1, `the control is not in the header on ${route}`);
    assert.doesNotMatch(await page.locator('#root').innerText(), /practice/i, `practice on ${route}`);
    await page.getByRole('button', { name: /Switch to (light|dark) appearance/ }).click();
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), ['domino-appearance'], `${route} stored something besides the appearance`);
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

test('the positions screen is an honest empty state: no cards, totals or private figures, a sign-in for the managed side, and a way back to the pools', async () => {
  const page = await open('/app');
  assert.equal(await page.getByRole('heading', { level: 1 }).innerText(), 'Positions');
  // The lookup card arrives with the read screens' chunk.
  await page.getByText('Look up a position NFT', { exact: true }).waitFor();
  const text = await page.locator('#root').innerText();
  assert.match(text, /Look up a position NFT/);
  // The by-id lookup is here now; finding every position a wallet holds is not.
  assert.match(text, /Enter its id above/);
  // The managed side asks for a wallet session and shows nothing private without one.
  assert.match(text, /Sign in with your wallet to view private history/);
  assert.match(text, /Sign in with your wallet to view private execution receipts/);
  assert.doesNotMatch(text, /practice|reinvested|awaiting|\$\s?\d|[0-9]+%/i);
  assert.equal(await page.locator('[role="dialog"]').count(), 0);
  // Nothing reads on load: the lookup asks only when someone asks it to, and
  // the screen shows no figure of its own until then.
  assert.deepEqual(apiOf(page), [[]], 'the positions screen reads nothing by itself');
  assert.equal(await page.locator('main [data-metric]').count(), 0, 'no figure appears before a lookup');
  assert.equal(await page.locator('main').getByRole('link', { name: 'Markets', exact: true }).getAttribute('href'), '#/markets');
  clean(page, 'positions');
  await close(page);
});

test('the explanatory sections stay, in relative terms, and say plainly what is not enabled', async () => {
  const page = await open('/');
  const text = await page.locator('#root').innerText();
  // The Overview leads with the pools; below them: how it works, the range simulator, what Domino does not do.
  for (const heading of [/Pick a pool\. Set a range\. Choose what fees do\./, /Move the price\. Watch what you own\./, /What Domino does not do\./, /Built on Uniswap/]) {
    assert.match(text, heading);
  }
  // Automation is not connected, and every place that describes it says so in those words; the marketing cards that only said so are gone.
  assert.ok((text.match(/Not connected/g) ?? []).length >= 2, 'the upkeep step and the Domino hand-off say so');
  // The pools card has no caption any more (the owner's decision on the redesign): each figure names its source and age in its own title.
  assert.doesNotMatch(text, /Every figure on this page names its source and its age|describes a pool, not a position, and is not a forecast/);
  // The product describes itself as the product, never as an unfinished one.
  assert.doesNotMatch(text, /\balpha\b|\bv4\b|not enabled yet|read-only/i, 'no self-description as an alpha, a version or a read-only build');
  assert.doesNotMatch(text, /Made for every way to hold liquidity|One position sets up the next/, 'no product cards, no Domino sequence');
  assert.match(text, /0\.70× to 1\.50×/);
  assert.doesNotMatch(text, /MEME|Example token/, 'no example token');
  assert.equal(await page.locator('#hero-amount, #amount').count(), 0, 'no amount to type in');
  // The hero's two ways in, and the Domino token's place above the table, where a
  // count of the selected pools used to sit: there will not be only six pools.
  assert.equal(await page.locator('main').getByRole('link', { name: 'New position', exact: true }).first().getAttribute('href'), '#/new');
  assert.equal(await page.locator('main').getByRole('link', { name: 'Explore markets', exact: true }).first().getAttribute('href'), '#/markets');
  // The stat labels are set in capitals by the stylesheet, and innerText follows that.
  const token = await page.locator('[data-domino-token]').innerText();
  assert.match(token, /The Domino token is coming\.[\s\S]*TICKER[\s\S]*SUPPLY[\s\S]*LAUNCH/);
  assert.doesNotMatch(token, /\$|\d/, 'nothing about the token is known, so no figure is invented for it');
  assert.equal(await page.locator('[data-domino-token]').count(), 1);
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
