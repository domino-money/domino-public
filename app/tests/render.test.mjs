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
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
  });
  page.on('requestfailed', (request) => {
    problems.push(`request failed: ${request.url()} (${request.failure()?.errorText})`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`${response.status()} for ${response.url()}`);
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

test('React is instantiated exactly once in the built bundle', async () => {
  // The direct form of the bug that produced the blank page. Two copies of the
  // renderer each install their own dispatcher and the first hook reads null.
  const page = await open('/');
  const roots = await page.evaluate(() => {
    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    return hook ? hook.renderers.size : null;
  });
  if (roots !== null) assert.equal(roots, 1, 'more than one React renderer is loaded');
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
