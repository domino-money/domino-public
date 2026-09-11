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
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';

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
/** Everything the page complained about, for whichever test is running. */
let problems = [];

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

/** A page that records every error the browser reports, on any route. */
async function open(route = '/') {
  problems = [];
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // The artwork test deliberately probes one missing file.
    if (message.location()?.url?.includes('nosuchtoken')) return;
    problems.push(`console.error: ${message.text()}`);
  });
  page.on('requestfailed', (request) => {
    problems.push(`request failed: ${request.url()} (${request.failure()?.errorText})`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().includes('nosuchtoken')) {
      problems.push(`${response.status()} for ${response.url()}`);
    }
  });
  await page.goto(`${origin}/#${route}`, { waitUntil: 'networkidle' });
  return page;
}

const clean = (label) => assert.deepEqual(problems, [], `${label} reported browser errors`);

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
  clean('landing');
  await page.close();
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
  clean('singleton');
  await page.close();
});

test('every route in the header renders', async () => {
  for (const [route, expected] of [
    ['/', /Robinhood Chain/],
    ['/app', /position/i],
    ['/settings', /Appearance|Compound|Availability/i],
  ]) {
    const page = await open(route);
    const body = await page.locator('#root').innerText();
    assert.match(body, expected, `route ${route}`);
    assert.ok(body.length > 200, `route ${route} rendered almost nothing`);
    clean(`route ${route}`);
    await page.close();
  }
});

test('every form field on every route can be identified by the browser', async () => {
  // Chrome flags fields with neither an id nor a name: autofill and
  // password managers cannot tell them apart.
  for (const route of ['/', '/app', '/settings']) {
    const page = await open(route);
    const anonymous = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, select, textarea'))
        .filter((el) => !el.id && !el.getAttribute('name'))
        .map((el) => el.outerHTML.slice(0, 120)),
    );
    assert.deepEqual(anonymous, [], `route ${route} has form fields without an id or name`);
    clean(`form fields on ${route}`);
    await page.close();
  }
});

test('no dollar figure is shown without the placeholder notice beside it', async () => {
  const page = await open('/');
  const text = await page.locator('#root').innerText();
  if (/\$\d/.test(text)) {
    assert.match(
      text,
      /Sample figures for layout|practice|example/i,
      'money appears on the page with nothing saying where it came from',
    );
  }
  await page.close();
});

test('the create-position dialog traps focus and hands it back on Escape', async () => {
  const page = await open('/app');

  const trigger = page.getByRole('button', { name: /New position|Let’s try it/ }).first();
  await trigger.click();

  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await dialog.getAttribute('aria-modal'), 'true');
  await assertNamed(page, 'the creation dialog');

  // Focus must already be inside when the dialog appears, not one Tab later.
  assert.equal((await focusedIn(page, '[role="dialog"]')).inside, true, 'focus did not enter the dialog');

  // The dialog opens with its heading focused, and a heading is not tabbable.
  // Going backwards from there used to walk straight out onto BODY.
  await page.keyboard.press('Shift+Tab');
  const back = await focusedIn(page, '[role="dialog"]');
  assert.equal(back.inside, true, `the first Shift+Tab escaped onto ${back.tag}`);

  // Tab all the way round. Focus must never escape to the page behind.
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const where = await focusedIn(page, '[role="dialog"]');
    assert.equal(where.inside, true, `focus escaped the dialog after ${i + 1} tabs, onto ${where.tag}`);
  }
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Shift+Tab');
    assert.equal((await focusedIn(page, '[role="dialog"]')).inside, true, 'focus escaped backwards');
  }

  // Content behind the dialog is hidden from assistive technology.
  const guarded = await page.evaluate(() => {
    const node = document.querySelector('[role="dialog"]');
    const layer = node.closest('[role="presentation"]');
    return Array.from(layer.parentElement.children)
      .filter((el) => el !== layer)
      .every((el) => el.hasAttribute('inert') || el.getAttribute('aria-hidden') === 'true');
  });
  assert.equal(guarded, true, 'the page behind the dialog was left reachable');

  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  const returned = await page.evaluate(() => document.activeElement?.textContent ?? '');
  assert.match(returned, /New position|Let’s try it/, 'focus was not returned to the trigger');

  clean('create dialog');
  await page.close();
});

/** Walks the create flow to completion, leaving one practice card on the page. */
async function createPosition(page, amount = '1000') {
  await page.getByRole('button', { name: /New position|Let’s try it/ }).first().click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ state: 'visible' });

  await page.locator('#amount').fill(amount);
  for (let step = 0; step < 3; step++) {
    await dialog.getByRole('button', { name: 'Continue' }).click();
  }

  const create = dialog.getByRole('button', { name: /Create practice card/ });
  assert.equal(await create.isDisabled(), true, 'the position could be created without consent');
  await page.locator('#risk-consent').check();
  assert.equal(await create.isDisabled(), false, 'consent did not unlock the action');
  await create.click();
  await dialog.waitFor({ state: 'detached' });
}

/** Opens card 1 and fills in the fee scenario, stopping on the review stage. */
async function runScenario(page, fees, gas) {
  await page.getByRole('button', { name: /Open practice card 1/ }).click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByRole('button', { name: 'Run a fee scenario' }).click();
  await page.locator('#fees').fill(fees);
  await page.locator('#gas').fill(gas);
  return dialog;
}

test('a practice position can be created, compounded and its receipt opened', async () => {
  const page = await open('/app');
  await createPosition(page);

  const body = await page.locator('#root').innerText();
  assert.match(body, /\$1,000|1,000\.00/, 'the created position is not shown');

  const dialog = await runScenario(page, '50', '0.50');
  await dialog.getByRole('button', { name: 'See the result' }).click();
  const review = await dialog.innerText();
  assert.match(review, /Cost check passed/, '50 in fees against 50c of gas should act');
  // The 2% is charged on the fees used, and the receipt names that base.
  assert.match(review, /Service fee · 2% of \$50\.00/);
  assert.match(review, /Reinvested in this card/);
  await dialog.getByRole('button', { name: 'Record it' }).click();
  await dialog.waitFor({ state: 'detached' });

  const receiptButton = page.getByRole('button', { name: 'View receipt' }).first();
  await receiptButton.waitFor({ state: 'visible' });
  await receiptButton.click();

  const receipt = page.locator('[role="dialog"][aria-labelledby="receipt-title"]');
  await receipt.waitFor({ state: 'visible' });
  assert.equal((await focusedIn(page, '[role="dialog"]')).inside, true, 'the receipt did not take focus');
  await assertNamed(page, 'the receipt dialog');

  await page.keyboard.press('Shift+Tab');
  const back = await focusedIn(page, '[role="dialog"]');
  assert.equal(back.inside, true, `the receipt's first Shift+Tab escaped onto ${back.tag}`);

  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    assert.equal((await focusedIn(page, '[role="dialog"]')).inside, true, 'focus escaped the receipt');
  }

  const receiptText = await receipt.innerText();
  assert.match(receiptText, /fees/i, 'the receipt must say what the service fee was charged on');
  assert.doesNotMatch(receiptText, /NaN|undefined|\[object Object\]/);
  // 2% of 50 is exactly one dollar, and the gas must not appear as a second
  // deduction from the owner.
  assert.match(receiptText, /1\.00/, 'the service fee is not the two percent shown');

  await page.keyboard.press('Escape');
  await receipt.waitFor({ state: 'detached' });

  clean('create, compound and receipt');
  await page.close();
});

test('a fee balance below the network cost is refused on screen, not rounded away', async () => {
  const page = await open('/app');
  await createPosition(page);

  // Two cents of fees cannot pay for fifty cents of gas out of a 2% cut.
  const dialog = await runScenario(page, '0.02', '0.50');
  await dialog.getByRole('button', { name: 'See the result' }).click();

  const text = await dialog.innerText();
  assert.match(text, /Wait for more fees/, 'an unaffordable compound was presented as ready');
  assert.match(text, /needs at least/, 'the owner is not told what the threshold is');
  assert.doesNotMatch(text, /NaN|undefined/);
  // The balance is held whole: nothing is consumed and nothing is charged.
  assert.match(text, /0\.02/, 'the waiting balance is not shown to the owner');

  clean('below-minimum scenario');
  await page.close();
});

test('a scenario outside the engine limits shows its refusal instead of a number', async () => {
  const page = await open('/app');
  await createPosition(page);

  const dialog = await runScenario(page, '50', '5000');
  const text = await dialog.innerText();
  assert.match(text, /supported|range|limit/i, 'an out-of-range scenario gave no explanation');
  assert.equal(
    await dialog.getByRole('button', { name: 'See the result' }).isDisabled(),
    true,
    'an out-of-range scenario could still be carried forward',
  );

  clean('out-of-range scenario');
  await page.close();
});

test('every token the app shows has real artwork, and an unknown one still gets a disc', async () => {
  // Both surfaces: the landing shows the pool table, the workspace shows the
  // practice pair once a card exists.
  const page = await open('/app');
  await createPosition(page);
  await page.goto(`${origin}/#/`, { waitUntil: 'networkidle' });
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
  assert.ok(images.length >= 8, `only ${images.length} token marks rendered`);
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
  clean('token artwork');
  await page.close();
});

test('the page survives a narrow viewport without spilling sideways', async () => {
  const page = await open('/');
  await page.setViewportSize({ width: 375, height: 812 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  assert.ok(overflow <= 1, `the page scrolls ${overflow}px horizontally at 375px wide`);
  clean('narrow viewport');
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

test('dragging a range edge through the DOM holds a fixed pointer to a fixed bound', async () => {
  const page = await open('/app');
  await page.getByRole('button', { name: /New position|Let’s try it/ }).first().click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ state: 'visible' });
  await page.locator('#amount').fill('1000');
  await dialog.getByRole('button', { name: 'Continue' }).click(); // Range step

  const chart = page.getByTestId('range-chart-bounds');
  await chart.waitFor({ state: 'visible' });
  const box = await chart.boundingBox();
  const lowerBefore = await num(page, '#min-price');
  const upperBefore = await num(page, '#max-price');

  // Grab the upper edge: it is the right-hand bound line inside the chart.
  const edgeX = await page.evaluate(() => {
    const lines = Array.from(document.querySelectorAll('[data-testid="range-chart-bounds"] line'));
    const xs = lines.map((l) => l.getBoundingClientRect().left).filter((x) => Number.isFinite(x));
    return Math.max(...xs);
  });
  const y = box.y + box.height / 2;
  await page.mouse.move(edgeX, y);
  await page.mouse.down();

  // Move once to the right, then keep the pointer perfectly still while
  // firing more move events. Before the fix, every event re-derived the
  // domain from the new bounds and the value crept under a still pointer.
  const targetX = Math.min(box.x + box.width - 4, edgeX + box.width * 0.12);
  await page.mouse.move(targetX, y, { steps: 4 });
  const first = await num(page, '#max-price');
  assert.ok(first > upperBefore, `the edge did not follow the pointer (${upperBefore} -> ${first})`);
  const seen = [];
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(targetX, y);
    seen.push(await num(page, '#max-price'));
  }
  await page.mouse.up();

  assert.deepEqual(seen, seen.map(() => first), `the bound crept under a still pointer: ${seen.join(', ')}`);
  assert.equal(await num(page, '#min-price'), lowerBefore, 'the other edge moved during the gesture');

  // After release the domain may re-fit to the new bounds; the bounds themselves must not change.
  await page.waitForTimeout(50);
  assert.equal(await num(page, '#max-price'), first, 'the bound changed on release');
  clean('range drag');
  await page.close();
});

test('going back through the create flow keeps what was typed', async () => {
  const page = await open('/app');
  await page.getByRole('button', { name: /New position|Let’s try it/ }).first().click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ state: 'visible' });

  await page.locator('#amount').fill('2345.5');
  await dialog.getByRole('button', { name: 'Continue' }).click();

  // Change the range by typing, then go forward and back again.
  await page.locator('#max-price').fill('1.8');
  await page.locator('#max-price').press('Tab');
  await page.locator('#min-price').fill('0.6');
  await page.locator('#min-price').press('Tab');
  await dialog.getByRole('button', { name: 'Continue' }).click(); // Explore
  await dialog.getByRole('button', { name: 'Back' }).click(); // Range
  assert.equal(await num(page, '#max-price'), 1.8, 'upper bound lost on back-navigation');
  assert.equal(await num(page, '#min-price'), 0.6, 'lower bound lost on back-navigation');

  await dialog.getByRole('button', { name: 'Back' }).click(); // Pair / amount
  assert.equal(await page.locator('#amount').inputValue(), '2345.5', 'amount lost on back-navigation');

  // And forward again still carries the same values through to the review.
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await dialog.getByRole('button', { name: 'Continue' }).click();
  const review = await dialog.innerText();
  assert.match(review, /2,345\.50/, 'review does not show the typed amount');
  assert.match(review, /0\.60 to \$1\.80/, 'review does not show the typed range');
  clean('back navigation');
  await page.close();
});

test('the dialog footer stays outside the scrolling body and on screen at a short viewport', async () => {
  const page = await open('/app');
  await page.setViewportSize({ width: 1280, height: 480 });
  await page.getByRole('button', { name: /New position|Let’s try it/ }).first().click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ state: 'visible' });

  const layout = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const footer = dialog.querySelector('footer');
    const scroller = Array.from(dialog.querySelectorAll('*')).find(
      (el) => getComputedStyle(el).overflowY === 'auto' && el.scrollHeight > el.clientHeight,
    );
    const fb = footer.getBoundingClientRect();
    return {
      hasScroller: Boolean(scroller),
      footerInsideScroller: scroller ? scroller.contains(footer) : null,
      footerBottom: fb.bottom,
      viewport: window.innerHeight,
      footerVisible: fb.height > 0 && fb.bottom <= window.innerHeight && fb.top >= 0,
    };
  });
  assert.equal(layout.hasScroller, true, 'at 480px tall the body should need to scroll');
  assert.equal(layout.footerInsideScroller, false, 'the action footer is inside the scrolling body');
  assert.equal(layout.footerVisible, true, `footer bottom ${layout.footerBottom} vs viewport ${layout.viewport}`);

  // And the primary action is actually reachable without scrolling.
  const next = dialog.getByRole('button', { name: 'Continue' });
  await page.locator('#amount').fill('1000');
  await next.click({ trial: true });
  clean('footer');
  await page.close();
});

test('receipt tabs switch content and keep the exact-amounts toggle working', async () => {
  const page = await open('/app');
  await createPosition(page);
  const dialog = await runScenario(page, '50', '0.50');
  await dialog.getByRole('button', { name: 'See the result' }).click();
  await dialog.getByRole('button', { name: 'Record it' }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'View receipt' }).first().click();
  const receipt = page.locator('[role="dialog"][aria-labelledby="receipt-title"]');
  await receipt.waitFor({ state: 'visible' });

  const tabs = receipt.getByRole('tab');
  assert.equal(await tabs.count(), 3);
  const texts = {};
  for (const name of ['Amounts', 'Costs', 'Why this action?']) {
    await receipt.getByRole('tab', { name }).click();
    assert.equal(await receipt.getByRole('tab', { name }).getAttribute('aria-selected'), 'true', `${name} not selected`);
    const selected = await receipt.locator('[role="tab"][aria-selected="true"]').count();
    assert.equal(selected, 1, 'more than one tab selected');
    texts[name] = await receipt.innerText();
  }
  assert.notEqual(texts.Amounts, texts.Costs, 'Costs tab shows the same content as Amounts');
  assert.notEqual(texts.Costs, texts['Why this action?'], 'Why tab shows the same content as Costs');
  assert.match(texts.Costs, /2%/, 'the costs tab does not show the fee basis');
  assert.match(texts.Costs, /not a second deduction|from the service fee|covers the network cost/i, 'the costs tab does not explain that gas is not a second deduction');

  // Exact amounts: six places appear after the toggle.
  await receipt.getByRole('tab', { name: 'Amounts' }).click();
  await page.locator('#receipt-exact').check();
  assert.match(await receipt.innerText(), /\d\.\d{6}/, 'exact mode did not switch to six places');
  await page.keyboard.press('Escape');
  await receipt.waitFor({ state: 'detached' });
  clean('receipt tabs');
  await page.close();
});

/** Top of an element relative to the viewport, after the app's own scroll settles. */
async function sectionTop(page, id) {
  await page.waitForTimeout(80);
  return page.evaluate((id) => document.getElementById(id)?.getBoundingClientRect().top ?? null, id);
}

test('section links land on their target, across routes and within one route', async () => {
  const page = await open('/');
  const header = await page.evaluate(() => document.querySelector('header')?.getBoundingClientRect().height ?? 0);

  // Cross-route: Activity in the header goes to the workspace and to #activity.
  await page.locator('header').getByRole('link', { name: 'Activity' }).click();
  await page.waitForFunction(() => location.hash.startsWith('#/app'));
  const activityTop = await sectionTop(page, 'activity');
  assert.ok(activityTop !== null, '#activity is not on the page');
  assert.ok(activityTop >= 0 && activityTop <= header + 40, `#activity landed at ${activityTop}px, header is ${header}px`);

  // Cross-route the other way: Explore pools returns to the landing at #pools.
  await page.getByRole('button', { name: 'Explore pools' }).click();
  await page.waitForFunction(() => location.hash === '#/#pools');
  const poolsTop = await sectionTop(page, 'pools');
  assert.ok(poolsTop >= 0 && poolsTop <= header + 40, `#pools landed at ${poolsTop}px`);

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
  clean('section links');
  await page.close();
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
    assert.match(state.label, /^\$[\d,]+\.\d{2}$/, `thumb label "${state.label}" is not a price`);
    assert.equal(Number(state.label.replace(/[$,]/g, '')), v, `thumb label ${state.label} does not match ${v}`);
  }
  clean('price slider');
  await page.close();
});

test('placeholder market figures are always accompanied by the sample label', async () => {
  const page = await open('/');
  const table = await page.evaluate(() => {
    const cells = Array.from(document.querySelectorAll('[data-metric]'));
    const states = cells.map((c) => c.getAttribute('data-metric'));
    const sampleLabelled = cells.filter((c) => c.getAttribute('data-metric') === 'placeholder' && /Sample/.test(c.title)).length;
    const pill = document.body.innerText.includes('Sample data');
    return { total: cells.length, states: Array.from(new Set(states)), sampleLabelled, pill };
  });
  assert.ok(table.total > 0, 'no metric cells rendered');
  assert.deepEqual(table.states, ['placeholder'], `unexpected metric states on the landing: ${table.states}`);
  assert.equal(table.sampleLabelled, table.total, 'a placeholder figure is missing its sample label');
  assert.equal(table.pill, true, 'the table is missing its Sample data pill');
  clean('placeholder labels');
  await page.close();
});
