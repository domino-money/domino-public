/**
 * The access gate in a real browser, in front of the real production build.
 *
 * gate.test.mjs proves the middleware's rules one request at a time. This
 * proves the thing a visitor experiences: that the built site cannot be
 * reached without the password, that the password lets you in, that the app
 * then runs under the strict CSP without a single violation, and that
 * signing out closes it again. The middleware is the compiled one, the files
 * are dist, and the server is scripts/gated-server.mjs — the same pieces the
 * deployment uses, minus Cloudflare.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { closeBrowser } from './support/close-browser.mjs';
import { closeContext, leaving, watch } from './page-watch.mjs';
import { DIST, createGatedServer } from '../scripts/gated-server.mjs';
import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';

const { GATE_SCRIPT } = createRequire(import.meta.url)('../.test-build/app/functions/_lib/gate.js');

/** The bytes the server sends for a navigation to `url`, exactly: no browser in between to inject or rewrite anything. */
const pageBytes = (url) =>
  new Promise((done, fail) => {
    httpRequest(url, { headers: { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', Accept: 'text/html' } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => done(body));
    }).on('error', fail).end();
  });

const PASSWORD = 'browser-test-beta-password';
const ENV = { BETA_PASSWORD: PASSWORD, BETA_COOKIE_KEY: 'Hk2mP9vQx4Lr7TbW1cNy6ZsJ3dGa8FeU5oViRtYqWeA' };

if (!existsSync(join(DIST, 'index.html'))) {
  throw new Error('dist/index.html is missing. Run `npm run build` before this test.');
}
// The entry script and stylesheet names are content hashes; read them from the build.
const INDEX = readFileSync(join(DIST, 'index.html'), 'utf8');
const SCRIPT = /src="(\/assets\/[^"]+\.js)"/.exec(INDEX)?.[1];
const STYLE = /href="(\/assets\/[^"]+\.css)"/.exec(INDEX)?.[1];

const LAUNCHES = process.env.DOMINO_BROWSER_PATH
  ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }]
  : [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}];

let server;
let origin;
let browser;

before(async () => {
  assert.ok(SCRIPT && STYLE, 'could not find the built script and stylesheet in dist/index.html');
  server = createGatedServer({ env: ENV });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  for (const options of LAUNCHES) {
    try {
      browser = await chromium.launch(options);
      break;
    } catch {
      // try the next build
    }
  }
  if (!browser) throw new Error('No Chromium build could be launched. Set DOMINO_BROWSER_PATH.');
});

after(async () => {
  await closeBrowser(browser);
  await new Promise((done) => server.close(done));
});

/** A fresh visitor: no cookies, and a log of everything the page reports. */
async function visitor() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  // Per page, and teardown-aware: an ERR_ABORTED of a view this test leaves is the test's doing (page-watch.mjs).
  const { problems } = watch(page, { requests: false, responses: false });
  const log = { errors: problems, responses: [] };
  page.on('response', (response) => {
    if (response.url().startsWith(origin)) log.responses.push({ status: response.status(), path: response.url().slice(origin.length) });
  });
  return { context, page, log };
}

async function signIn(page) {
  await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  await page.fill('#password', PASSWORD);
  leaving(page);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('button[type="submit"]')]);
}

test('a visitor without the password sees only the access page', async () => {
  const { context, page } = await visitor();
  const response = await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  assert.equal(response.status(), 401);
  assert.equal(await page.title(), 'Domino · Access');
  assert.equal(await page.locator('#password').getAttribute('type'), 'password');
  assert.equal(await page.locator('#root').count(), 0, 'the app shell was delivered');
  // Checked on the bytes the server sends, not on the DOM: desktop antivirus
  // suites inject their own <script> into every page, which says nothing
  // about ours. The CSP blocks such injections on the real site anyway.
  // Asked as a page, with node:http: Node's fetch adds its own Sec-Fetch-Mode, which makes any request a non-navigation.
  const raw = await pageBytes(`${origin}/`);
  assert.match(raw, /<title>Domino · Access<\/title>/, 'the access page itself, not the JSON refusal');
  // Changed on purpose 2026-10-01 (platform workstream, D3): one script, which carries the opened link through the
  // login, admitted by the page's CSP by its hash; nothing else.
  assert.deepEqual([...raw.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]), [GATE_SCRIPT], 'the access page ships its one script and no other');
  assert.doesNotMatch(raw, /fonts\.googleapis|fonts\.gstatic/, 'and loads nothing from Google (I5)');
  // 2026-10-03 (the owner: Domino is becoming multi-chain): the page names no chain.
  assert.doesNotMatch(await page.locator('body').innerText(), /robinhood|\bchains?\b/i);
  await closeContext(context);
});

// 2026-10-03 (the owner: the access page "lacks life"): its drawing plays on a first visit, a few loops on one timeline,
// then rests; a wrong password brings back a still drawing and one shake of the field; under reduced motion nothing
// moves at all. Nothing it does reaches another host, and the CSP refuses nothing of it.
test('the access page moves a few times on a first visit, then rests, and never where reduced motion is asked', async () => {
  const motion = async (page) =>
    page.evaluate(() =>
      document.getAnimations().map((animation) => {
        const timing = animation.effect.getComputedTiming();
        return { name: animation.animationName, iterations: timing.iterations, end: timing.endTime };
      }),
    );
  const { context, page, log } = await visitor();
  const requested = [];
  page.on('request', (request) => { if (/^https?:/.test(request.url())) requested.push(new URL(request.url()).origin); });
  await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  const first = await motion(page);
  assert.ok(first.some((a) => a.name === 'g-run') && first.some((a) => a.name === 'g-tip-0') && first.some((a) => a.name === 'g-lit'), JSON.stringify(first));
  for (const a of first) {
    assert.ok(Number.isFinite(a.end) && a.iterations <= 3, `${a.name} runs ${a.iterations} times, ending at ${a.end} ms`);
  }
  const loops = first.filter((a) => /^g-(?:run|tip-\d|lit|lit-body|warm)$/.test(a.name));
  assert.equal(new Set(loops.map((a) => a.end)).size, 1, 'every part of the loop ends together, on one timeline');
  assert.deepEqual([...new Set(requested)], [origin], 'nothing from another host');
  assert.deepEqual(log.errors.filter((e) => !/status of 401/.test(e)), [], 'no CSP refusal, no error');
  // A wrong password: the drawing stands still; only the field's one shake plays.
  await page.fill('#password', 'not-the-password');
  leaving(page);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('button[type="submit"]')]);
  const wrong = await motion(page);
  assert.ok(wrong.every((a) => a.name === 'g-shake'), JSON.stringify(wrong));
  await closeContext(context);

  const still = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  const quiet = await still.newPage();
  await quiet.goto(`${origin}/`, { waitUntil: 'networkidle' });
  assert.deepEqual(await motion(quiet), [], 'reduced motion: nothing moves');
  await closeContext(still);
});

// 2026-10-01 (platform workstream, D3): the link a visitor opened is where the password takes them, not Home.
test('the link a visitor opened survives the password, and the access page’s own fonts come from this site', async () => {
  const { context, page, log } = await visitor();
  const fonts = [];
  page.on('request', (request) => { if (request.resourceType() === 'font') fonts.push(request.url()); });
  const response = await page.goto(`${origin}/#/docs/wallet`, { waitUntil: 'networkidle' });
  assert.equal(response.status(), 401);
  assert.deepEqual(fonts.sort(), [`${origin}/__beta/fonts/geist-latin.woff2`, `${origin}/__beta/fonts/instrument-serif-latin.woff2`]);
  assert.equal(await page.locator('#next').inputValue(), '#/docs/wallet', 'the page put the link into the form');
  await page.fill('#password', PASSWORD);
  leaving(page);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('button[type="submit"]')]);
  assert.equal(new URL(page.url()).hash, '#/docs/wallet');
  await page.locator('h1', { hasText: 'Wallet and sign-in' }).waitFor();
  assert.deepEqual(log.errors.filter((e) => !/status of 401/.test(e)), []);
  await closeContext(context);
});

// 2026-10-01 (platform workstream, V5): browsers ask for /favicon.ico on their own, and some without the cookie.
test('the favicon is served to anyone, without the password, and kept a day', async () => {
  const { context } = await visitor();
  const response = await context.request.get(`${origin}/favicon.ico`);
  assert.equal(response.status(), 200);
  assert.equal(response.headers()['cache-control'], 'private, max-age=86400, stale-while-revalidate=604800');
  const bytes = await response.body();
  assert.deepEqual([...bytes.subarray(0, 4)], [0, 0, 1, 0], 'an ICO file');
  await closeContext(context);
});

// Owner, 2026-09-26: dark only. The access page is part of the site: it had a light variant for a system that asked for
// light, and now keeps the app's one dark palette whatever the system asks for.
test('the access page is dark even where the system asks for light', async () => {
  const { context, page } = await visitor();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  const look = await page.evaluate(() => ({
    scheme: getComputedStyle(document.documentElement).colorScheme,
    meta: document.querySelector('meta[name="color-scheme"]')?.getAttribute('content'),
    body: getComputedStyle(document.body).backgroundColor,
    text: getComputedStyle(document.body).color,
  }));
  assert.deepEqual(look, { scheme: 'dark', meta: 'dark', body: 'rgb(13, 10, 8)', text: 'rgb(247, 241, 234)' });
  const raw = await (await fetch(`${origin}/`, { headers: { 'Sec-Fetch-Mode': 'navigate' } })).text();
  assert.doesNotMatch(raw, /prefers-color-scheme|color-scheme:\s*light/, 'no light variant');
  await closeContext(context);
});

test('the built files themselves cannot be fetched without the password', async () => {
  // Fetched with the browser context's own HTTP client, which carries the
  // visitor's cookies. Not from inside the access page: its CSP forbids
  // fetch() entirely, which is correct and would make this test pass for the
  // wrong reason.
  const { context } = await visitor();
  for (const path of [SCRIPT, STYLE, '/tokens/usdg.svg', '/favicon.svg', '/index.html', '/api/read/v1/pools']) {
    const response = await context.request.get(`${origin}${path}`);
    assert.equal(response.status(), 401, `${path} answered ${response.status()}`);
    assert.equal(await response.text(), '{"error":"beta_access_required"}', `${path} leaked content`);
  }
  await closeContext(context);
});

test('the access page cannot call anything, even from its own origin', async () => {
  const { context, page } = await visitor();
  await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  const outcome = await page.evaluate(async () => {
    try {
      await fetch('/api/read/v1/pools');
      return 'allowed';
    } catch {
      return 'blocked';
    }
  });
  assert.equal(outcome, 'blocked', "the access page's CSP should forbid fetch()");
  await closeContext(context);
});

test('a wrong password keeps the visitor out and says so', async () => {
  const { context, page } = await visitor();
  await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  await page.fill('#password', 'not-the-password');
  leaving(page);
  await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
  assert.match(await page.locator('[role="alert"]').innerText(), /didn’t work/);
  assert.equal(await page.locator('#password').getAttribute('aria-invalid'), 'true');
  assert.deepEqual(await context.cookies(), [], 'a wrong password must not set any cookie');
  await closeContext(context);
});

test('the right password opens the full app, which runs under the CSP without a violation', async () => {
  const { context, page, log } = await visitor();
  await signIn(page);

  const text = await page.locator('#root').innerText();
  assert.ok(text.length > 500, `the app rendered only ${text.length} characters`);
  // Changed on purpose 2026-10-03 (the owner: Domino covers more than one network): Home's headline, not a chain's name.
  assert.match(text, /Earn fees on your tokens/);

  const [cookie] = await context.cookies();
  assert.equal(cookie.name, '__Host-domino-beta');
  assert.equal(cookie.httpOnly, true, 'script must not be able to read the access cookie');
  assert.equal(cookie.secure, true);
  assert.equal(cookie.sameSite, 'Lax');
  assert.equal(await page.evaluate(() => document.cookie), '', 'the access cookie is visible to script');

  // The only failure allowed is the 401 the access page itself answered with
  // before signing in. Anything else — a blocked asset, a CSP refusal, an
  // uncaught error — fails the test.
  const failures = log.responses.filter((r) => r.status >= 400 && r.path !== '/');
  assert.deepEqual(failures, [], `requests failed after sign-in: ${JSON.stringify(failures)}`);
  const violations = log.errors.filter((e) => !/status of 401/.test(e));
  assert.deepEqual(violations, [], 'the app reported errors under the gate');
  await closeContext(context);
});

test('the whole workspace works behind the gate, not only the landing', async () => {
  const { context, page, log } = await visitor();
  await signIn(page);
  // The docs too: the index and a long page of static copy, under the real CSP.
  for (const route of ['/app', '/settings', '/docs', '/docs/non-custodial']) {
    await page.evaluate((r) => { location.hash = `#${r}`; }, route);
    await page.waitForTimeout(150);
    assert.ok((await page.locator('#root').innerText()).length > 200, `${route} rendered almost nothing`);
  }
  assert.equal(await page.locator('h1').first().innerText(), 'Non-custodial', 'the docs page rendered behind the gate');
  const images = await page.evaluate(() =>
    Array.from(document.querySelectorAll('img[src*="/tokens/"]')).filter((i) => i.complete && i.naturalWidth === 0).length,
  );
  assert.equal(images, 0, 'token images failed to load behind the gate');
  assert.deepEqual(log.errors.filter((e) => !/status of 401/.test(e)), []);
  await closeContext(context);
});

test('signing out closes the site again', async () => {
  const { context, page } = await visitor();
  await signIn(page);
  const status = await page.evaluate(async () => (await fetch('/__beta/logout', { method: 'POST', redirect: 'manual' })).type);
  assert.ok(['opaqueredirect', 'basic'].includes(status));
  const response = await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  assert.equal(response.status(), 401, 'the app was still reachable after signing out');
  assert.equal(await page.locator('#password').count(), 1);
  await closeContext(context);
});

test('a cookie from one browser does not work after the password is rotated', async () => {
  const { context, page } = await visitor();
  await signIn(page);
  const [cookie] = await context.cookies();

  const rotated = createGatedServer({ env: { ...ENV, BETA_PASSWORD: 'rotated-beta-password-2026' } });
  await new Promise((done) => rotated.listen(0, '127.0.0.1', done));
  const other = `http://127.0.0.1:${rotated.address().port}`;
  const second = await browser.newContext();
  await second.addCookies([{ ...cookie, domain: '127.0.0.1', url: undefined, path: '/' }]);
  const tab = await second.newPage();
  const response = await tab.goto(`${other}/`, { waitUntil: 'networkidle' });
  assert.equal(response.status(), 401, 'an old cookie still opened the site after rotation');
  await closeContext(second);
  await new Promise((done) => rotated.close(done));
  await closeContext(context);
});
