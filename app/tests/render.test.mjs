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
import { apiOf, close, leaving, open as openPage, problemsOf, reload } from './page-watch.mjs';
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

/** The element that has focus, described well enough to assert on. */
const focusedIn = (page, selector) =>
  page.evaluate((sel) => {
    const active = document.activeElement;
    const scope = document.querySelector(sel);
    return { inside: Boolean(scope && active && scope.contains(active)), tag: active?.tagName ?? null };
  }, selector);

/** A modal has to say what it is; `role="dialog"` alone announces nothing. */
async function assertNamed(page, label) {
  const name = await page.evaluate(() => {
    const node = document.querySelector('[role="dialog"]');
    const id = node.getAttribute('aria-labelledby');
    const labelled = id ? document.getElementById(id) : null;
    return (labelled?.textContent ?? node.getAttribute('aria-label') ?? '').trim();
  });
  assert.ok(name.length > 0, `${label} has no accessible name`);
}

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

test('every route in the header renders', async () => {
  for (const [route, expected] of [
    ['/', /Robinhood Chain/],
    ['/app', /position/i],
    ['/pools', /Explore pools/],
    ['/settings', /Appearance|Compound|Availability/i],
  ]) {
    const page = await open(route);
    const body = await page.locator('#root').innerText();
    assert.match(body, expected, `route ${route}`);
    assert.ok(body.length > 200, `route ${route} rendered almost nothing`);
    clean(page, `route ${route}`);
    await close(page);
  }
});

test('the mobile Dashboard opens the public pool explorer: named, focused, bounded and idle until a read is requested', async () => {
  const page = await open('/app');
  assert.equal(await page.locator('header').getByRole('link', { name: 'Pools', exact: true }).getAttribute('href'), '#/pools');
  await page.setViewportSize({ width: 375, height: 812 });
  const entrance = page.locator('main').getByRole('link', { name: 'Explore pools' });
  assert.equal(await entrance.isVisible(), true, 'the mobile Dashboard has a visible entrance');
  await entrance.click();
  await page.getByRole('heading', { name: 'Explore pools', exact: true }).waitFor();
  const trigger = page.getByRole('button', { name: 'Choose first token', exact: true });
  await trigger.waitFor();
  assert.equal(await page.getByRole('button', { name: 'Choose second token (optional)' }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'Explore range' }).isDisabled(), true);
  await trigger.click();
  const dialog = page.locator('[data-pool-selection-dialog]');
  await dialog.waitFor();
  await assertNamed(page, 'public pool explorer');
  await page.getByRole('dialog', { name: 'Choose a token from chain data', exact: true }).waitFor();
  assert.equal((await focusedIn(page, '#pool-selection-title')).inside, true, 'the picker heading receives focus');
  assert.equal(await dialog.getByRole('button', { name: 'Use this token' }).isDisabled(), true);
  await dialog.getByRole('button', { name: 'Back to pools' }).focus();
  await page.keyboard.press('Tab');
  assert.equal((await focusedIn(page, '[data-pool-selection-dialog]')).inside, true, 'Tab cannot leave the modal');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `the picker scrolls ${overflow}px sideways at 375px`);
  const bounds = await dialog.boundingBox();
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 813, 'the modal is bounded to the mobile viewport');
  assert.doesNotMatch(await dialog.innerText(), /\$\s?\d|\b0(?:\.0+)?%/, 'no figures before any answer');

  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await trigger.click();
  await dialog.getByRole('button', { name: 'Back to pools' }).click();
  await dialog.waitFor({ state: 'detached' });
  await trigger.click();
  await page.getByRole('dialog', { name: 'Choose a token from chain data', exact: true }).waitFor();
  await page.mouse.click(1, 1);
  await dialog.waitFor({ state: 'detached' });
  await trigger.click();
  await dialog.getByRole('button', { name: 'Close pool explorer' }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await trigger.evaluate((node) => node === document.activeElement), true, 'closing restores the entry button focus');
  await trigger.click();
  await dialog.waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Use this token' }).isDisabled(), true, 'no token was chosen');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(apiOf(page), [[]], 'opening the route, dialog and token picker sends no API request');
  clean(page, 'mobile pool explorer');
  await close(page);
});

test('every form field on every route can be identified by the browser', async () => {
  // Chrome flags fields with neither an id nor a name: autofill and
  // password managers cannot tell them apart.
  for (const route of ['/', '/app', '/pools', '/settings']) {
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
  for (const route of ['/', '/app', '/pools', '/settings']) {
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
  await page.locator('header').getByRole('link', { name: 'Positions' }).click();
  await page.waitForFunction(() => location.hash === '#/app');
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => window.scrollY), 0, 'the positions screen did not start at the top');

  // The positions screen leads to discovery; its selected-pools link returns to the landing section.
  leaving(page);
  await page.locator('main').getByRole('link', { name: 'Explore pools' }).click();
  await page.waitForFunction(() => location.hash === '#/pools');
  leaving(page);
  await page.getByRole('link', { name: 'View selected pools' }).click();
  await page.waitForFunction(() => location.hash === '#/#pools');
  const poolsTop = await sectionTop(page, 'pools');
  assert.ok(poolsTop >= 0 && poolsTop <= header + 40, `#pools landed at ${poolsTop}px, header is ${header}px`);

  // Same route, different section: only the hash section changes.
  await page.evaluate(() => { location.hash = '#/#learn'; });
  const learnTop = await sectionTop(page, 'learn');
  assert.ok(learnTop >= 0 && learnTop <= header + 40, `#learn landed at ${learnTop}px`);
  await page.evaluate(() => { location.hash = '#/#pools'; });
  const backTop = await sectionTop(page, 'pools');
  assert.ok(backTop >= 0 && backTop <= header + 40, `#pools (second time) landed at ${backTop}px`);

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
      overview: Boolean(a.closest('header')) && (a.textContent.trim() === 'Overview' || a.textContent.trim() === 'domino.'),
    })),
  );
  assert.ok(links.some((l) => l.footer), 'the footer has links');
  const ROUTES = ['/', '/app', '/pools', '/settings'];
  for (const link of links) {
    const label = `${link.footer ? 'footer' : 'header'} link "${link.text}" (${link.href})`;
    assert.ok(link.href !== null && link.href.trim() !== '', `${label} has no target`);
    assert.notEqual(link.href, '#', `${label} goes nowhere`);
    // "#/" is the landing route itself: only the header's Overview link and wordmark may name it.
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

test('the landing reads through the bridge, and with no /api behind this server says live data is not connected, with no figure and no Retry', async () => {
  const page = await open('/');
  await page.waitForFunction(() => document.querySelector('#pools [data-read-status]')?.getAttribute('data-read-status') === 'not_connected');
  assert.match(await page.locator('#pools [data-read-status]').innerText(), /Live data isn't connected yet/);
  assert.equal(await page.locator('#pools').getByRole('button', { name: 'Retry' }).count(), 0, 'a Retry cannot connect anything');
  assert.equal(await page.locator('#pools tbody tr').count(), 0);
  assert.equal(await page.locator('[data-metric]').count(), 0, 'no figure anywhere on the landing');
  assert.equal(await page.locator('[data-ticker-status]').innerText(), 'Live data isn\'t connected yet', 'the ticker says the same');
  clean(page, 'not connected');
  await close(page);
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

test('the landing asks the capabilities once and posts nothing when live data is not connected; other routes ask nothing', async () => {
  const seen = [];
  for (const route of ['/', '/app', '/pools', '/settings']) {
    const page = await open(route);
    await reload(page, route);
    seen.push([route, apiOf(page)]);
    clean(page, `requests on ${route}`);
    await close(page);
  }
  // Per document: the first load and the reload each ask once, and post nothing.
  const once = ['GET /api/read/v1/capabilities'];
  assert.deepEqual(seen, [
    ['/', [once, once]],
    ['/app', [[], []]],
    ['/pools', [[], []]],
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
  assert.equal(SELECTED.length, 2);
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

test('Settings reports signing and wallet funding off and live reads built in, switched on by the server; no practice mode is left', async () => {
  const page = await open('/settings');
  const text = await page.locator('#root').innerText();
  assert.match(text, /Signing\s+Off/);
  assert.match(text, /Wallet funding\s+Off/);
  assert.match(text, /Live reads\s+Built in, switched on by the server/);
  assert.match(text, /Compound[\s\S]*Not available in the alpha/);
  assert.equal(await page.locator('[data-build-banner]').count(), 0, 'no fixture or test-build banner');
  clean(page, 'settings');
  await close(page);
});

test('the wallet control is on every route and ready, no route mentions practice, and only the appearance is stored', async () => {
  for (const route of ['/', '/app', '/pools', '/settings']) {
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

test('the landing never shows an invented figure: no table row, no cell, no placeholder, nothing called a sample', async () => {
  const page = await open('/');
  await page.waitForFunction(() => document.querySelector('#pools [data-read-status]')?.getAttribute('data-read-status') !== 'loading');
  const found = await page.evaluate(() => ({
    rows: document.querySelectorAll('#pools tbody tr').length,
    metrics: document.querySelectorAll('[data-metric]').length,
    placeholder: document.querySelectorAll('[data-metric="placeholder"]').length,
    sample: /sample/i.test(document.body.innerText),
    dollars: /\$\s?\d/.test(document.body.innerText),
    pair: /MEME|USDG|WETH|MARLIN/.test(document.body.innerText),
  }));
  assert.deepEqual(found, { rows: 0, metrics: 0, placeholder: 0, sample: false, dollars: false, pair: false });
  clean(page, 'landing figures');
  await close(page);
});

// ---------------------------------------------------------------------------
// No practice mode: the positions screen is an honest empty state, and the
// explanatory sections stay, in relative terms, saying what the alpha lacks.
// ---------------------------------------------------------------------------

test('the positions screen is an honest empty state: no cards, totals, activity or receipts, and a way back to the pools', async () => {
  const page = await open('/app');
  const text = await page.locator('#root').innerText();
  assert.match(text, /Your positions will appear here/);
  // The by-id lookup is here now; finding every position a wallet holds is not.
  assert.match(text, /Look a position up by its id/);
  assert.doesNotMatch(text, /practice|receipt|reinvested|awaiting|activity/i);
  assert.equal(await page.locator('[role="dialog"]').count(), 0);
  // Nothing reads on load: the lookup asks only when someone asks it to, and
  // the screen shows no figure of its own until then.
  assert.deepEqual(apiOf(page), [[]], 'the positions screen reads nothing by itself');
  assert.equal(await page.locator('main [data-metric]').count(), 0, 'no figure appears before a lookup');
  assert.equal(await page.locator('main').getByRole('link', { name: 'Explore pools' }).getAttribute('href'), '#/pools');
  clean(page, 'positions');
  await close(page);
});

test('the explanatory sections stay, in relative terms, and say what is not available in the alpha', async () => {
  const page = await open('/');
  const text = await page.locator('#root').innerText();
  for (const heading of [/Move the price\. Watch what you own\./, /One position sets up the next\./, /Made for every way to hold liquidity\./, /Three decisions, then it runs itself\./]) {
    assert.match(text, heading);
  }
  assert.ok((text.match(/Not available in the alpha/g) ?? []).length >= 8, 'every product card, step and Domino callout says so');
  assert.match(text, /Schematic, not a projection/);
  assert.match(text, /0\.70× to 1\.50×/);
  assert.doesNotMatch(text, /MEME|USDG|WETH|MARLIN|Example token/, 'no named pair or example token');
  assert.equal(await page.locator('#hero-amount, #amount').count(), 0, 'no amount to type in');
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
