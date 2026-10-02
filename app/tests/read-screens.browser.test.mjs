/**
 * The read screens (#2 position cards, #3 selectors, #13 figures) in a real
 * browser, behind the real beta gate and its CSP.
 *
 * The fixture build (vite build --mode fixtures) is served through the
 * compiled middleware exactly as read-states.browser.test.mjs serves it. App
 * routes use the build's one scheduled fixture source; every other state is a
 * case in the screens lab, read-lab.html#screens/<case>, with its own source
 * and the real components: the Dashboard lookup, the real create dialog and
 * the real Top pools table. Only which package fixture answers is scripted.
 */
import { jump } from './support/clock.mjs';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { closeBrowser } from './support/close-browser.mjs';
import { FIXTURE_DIST, createGatedServer } from '../scripts/gated-server.mjs';
import { handlePlaces, handleSightings, NOWHERE, watchForHandle } from './handle-watch.mjs';

const PASSWORD = 'screens-test-beta-password';
const ENV = { BETA_PASSWORD: PASSWORD, BETA_COOKIE_KEY: 'Mk2mP9vQx4Lr7TbW1cNy6ZsJ3dGa8FeU5oViRtYqWeC' };
const SYMBOL = '<img src=x onerror=alert(1)>';
const BIG = '57896044618658097711785492504343953926634992332820282019728792003956564819969';
const OWNER = '0x3333333333333333333333333333333333333333';
const TOKEN = '0x1111111111111111111111111111111111111111';
const NATIVE = '0x0000000000000000000000000000000000000000';
const CURSOR = `${'c0ffee'.repeat(10)}c0ff`;
const at = (digit) => `0x${digit.repeat(40)}`;

if (!existsSync(join(FIXTURE_DIST, 'read-lab.html'))) {
  throw new Error('.fixture-dist/read-lab.html is missing. Run `npm run build:fixtures` before this test.');
}

const LAUNCHES = process.env.DOMINO_BROWSER_PATH
  ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }]
  : [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}];

let server;
let origin;
let browser;
let context;

before(async () => {
  server = createGatedServer({ env: ENV, dist: FIXTURE_DIST });
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
  context = await signedIn();
});

after(async () => {
  // Close the listener and keep-alive sockets before waiting for Chromium.
  const serverClosed = server ? new Promise((done, reject) => {
    server.close((error) => error ? reject(error) : done());
    server.closeAllConnections();
  }) : Promise.resolve();
  await Promise.all([serverClosed, closeBrowser(browser)]);
});

/** A browser context holding the beta cookie, recording alerts and CSP violations on every page. */
async function signedIn(viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(() => {
    window.__alerts = [];
    window.alert = (message) => window.__alerts.push(String(message));
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
  });
  const page = await ctx.newPage();
  await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  await page.fill('#password', PASSWORD);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('button[type="submit"]')]);
  await page.close();
  return ctx;
}

/** A page with its own error log. Any uncaught error or console error fails the test that opened it. */
async function tracked(ctx = context) {
  const page = await ctx.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', (error) => errors.push(`uncaught: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('request', (request) => requests.push({ type: request.resourceType(), url: request.url() }));
  page.on('dialog', (dialog) => {
    errors.push(`dialog: ${dialog.message()}`);
    void dialog.dismiss();
  });
  return { page, errors, requests };
}

async function openCase(id, ctx = context) {
  const t = await tracked(ctx);
  await t.page.goto(`${origin}/read-lab.html#screens/${id}`, { waitUntil: 'networkidle' });
  await t.page.locator(`[data-screen-case="${id}"]`).waitFor();
  return t;
}

const caseLog = (page) => page.evaluate(() => window.__screenCase.log);

/** Every file the fixture build emitted, as text, to tell the app's own requests from anything else's. */
const distText = () =>
  [join(FIXTURE_DIST, 'index.html'), join(FIXTURE_DIST, 'read-lab.html'), ...readdirSync(join(FIXTURE_DIST, 'assets')).map((file) => join(FIXTURE_DIST, 'assets', file))]
    .filter((file) => /\.(html|js|css)$/.test(file))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
const quiet = async (page, errors) => {
  assert.deepEqual(errors, [], 'browser errors');
  assert.deepEqual(await page.evaluate(() => window.__csp), [], 'CSP violations');
  assert.deepEqual(await page.evaluate(() => window.__alerts), [], 'alerts');
};

// --- Positions ---------------------------------------------------------------
// Changed on purpose (owner, 2026-09-24): the lookup by typed NFT ids is gone. Positions lists the connected wallet's own
// positions from chain (a build with the wallet; this fixture build has none), and a position's page reads the fees
// relay, which this build does not have: nothing on either route asks the read service, and nothing is kept.

/** The read service's reads the page made, in order. */
const fixtureReads = (page) => page.evaluate(() => (window.__DOMINO_FIXTURE_READS__ ?? []).map((r) => ({ route: r.route, request: r.request })));
/** What the eye gets of an element: its text without the screen-reader-only parts. */
const visibleText = (locator) =>
  locator.evaluate((root) => {
    const copy = root.cloneNode(true);
    for (const hidden of copy.querySelectorAll('.sr-only')) hidden.remove();
    return copy.textContent.replace(/\s+/g, ' ').trim();
  });
/** What the page keeps in the browser. Changed on purpose (owner, 2026-09-26: dark only): the appearance key it once let
 * through is gone with the light theme, so nothing is excused. */
const keptKeys = (page) => page.evaluate(() => Object.keys(localStorage).concat(Object.keys(sessionStorage)));

test('the positions route reads nothing and offers no lookup by NFT id; every request is same-origin or one the app itself names', async () => {
  const { page, errors, requests } = await tracked();
  await page.goto(`${origin}/#/app`, { waitUntil: 'networkidle' });
  await page.locator('[data-owned]').waitFor();
  assert.equal(await page.locator('[data-owned]').getAttribute('data-owned'), 'unavailable', 'a build with no wallet lists nothing');
  await page.waitForTimeout(1000);
  assert.deepEqual((await fixtureReads(page)).filter((r) => r.route === 'nft-positions' || r.route === 'token'), [], 'no NFT read, no token read');
  assert.equal(await page.locator('#nft-ids, #chain-lookup, details[data-lookup-disclosure]').count(), 0, 'no lookup by NFT id');
  assert.doesNotMatch(await page.locator('main').innerText(), /Look up|Position NFTs|NFT ids?\b/i);
  assert.deepEqual(await keptKeys(page), [], 'nothing is kept');

  ownRequestsOnly(requests);
  await quiet(page, errors);
  await page.close();
});

/**
 * Every fetch and XHR is same-origin, with two exceptions, each a GET to
 * DexScreener's public API that names token contract addresses and nothing
 * else: no wallet address, no query, no other path, no other host, no
 * credentials.
 *
 * - 2026-09-12 (approved by the owner): the token artwork resolver's
 *   token-pairs lookup for one token.
 *   (Since 2026-09-24 that same GET also names the pool ids New position asks
 *   the read service to verify: src/lib/read/screens/poolHints.ts; for native
 *   ETH it asks by the zero address, the provider's own name for it.)
 * - 2026-09-25 (added for the owner's request that the Positions Wallet card
 *   list "only the main tokens", by USD value): the card's one price GET, the
 *   provider's `tokens` endpoint for up to 30 held token addresses,
 *   lowercased, sorted and comma-separated (src/lib/tokenArtwork.ts
 *   tokenPrices, src/lib/walletPrices.ts).
 *
 * Any other resource from another host must be one the app itself names:
 * DexScreener's image CDN for the artwork. A host that appears nowhere in the
 * build (a local antivirus injecting its own script into every page, say) is
 * not the app's request. Changed on purpose 2026-09-28 (speed wave, item 35):
 * the fonts are the site's own files (src/styles/fonts.css), so Google Fonts is
 * no longer excused; the build names neither of its hosts, so a request to one
 * would fail here.
 */
const ARTWORK_LOOKUP = /^\/token-pairs\/v1\/robinhood\/0x[0-9a-fA-F]{40}$/;
const WALLET_PRICES = /^\/tokens\/v1\/robinhood\/0x[0-9a-f]{40}(,0x[0-9a-f]{40}){0,29}$/;
function ownRequestsOnly(requests, { walletAddress = null } = {}) {
  const built = distText();
  for (const r of requests) {
    const url = new URL(r.url);
    if (r.type === 'fetch' || r.type === 'xhr') {
      if (url.origin === 'https://api.dexscreener.com') {
        assert.equal(r.type, 'fetch', r.url);
        assert.ok(ARTWORK_LOOKUP.test(url.pathname) || WALLET_PRICES.test(url.pathname), `only the artwork lookup and the Wallet card's price GET may leave the origin: ${r.url}`);
        assert.equal(url.search, '', r.url);
        if (walletAddress) assert.equal(url.pathname.toLowerCase().includes(walletAddress.toLowerCase().slice(2)), false, `the wallet's address never leaves the page: ${r.url}`);
        continue;
      }
      assert.equal(url.origin, origin, r.url);
      continue;
    }
    if (url.origin === origin) continue;
    assert.ok(!/^fonts\.(googleapis|gstatic)\.com$/.test(url.host), `the page asked Google Fonts: ${r.url}`);
    assert.equal(built.includes(url.host), false, `the build itself requests ${r.url}`);
  }
}

// 2026-09-25: the same rule on the view where the Wallet card makes its one price GET: an address's Positions page reads
// the address's whole list (both fixture pages, on its own), then asks the provider once, by token addresses only.
// Round 6 (2026-09-27): prices are asked as each page names new tokens, 30 addresses per GET at most (WALLET_PRICES).
test('an address’s Wallet card: its pages are read on their own, then ONE price GET by token addresses leaves the origin, and nothing else', async () => {
  const { page, errors, requests } = await tracked();
  const asked = [];
  await page.route(/^https:\/\/(api|cdn)\.dexscreener\.com\//, (route) => {
    asked.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '[]' });
  });
  await page.goto(`${origin}/#/portfolio/${OWNER}`, { waitUntil: 'networkidle' });
  const card = page.locator('[data-portfolio-tokens]');
  await page.locator('[data-portfolio-tokens][data-wallet-prices="ok"]').waitFor({ timeout: 30_000 });
  assert.equal(await card.getAttribute('data-wallet-pages'), '2');
  const walletReads = (await fixtureReads(page)).filter((r) => r.route === 'wallet-assets');
  assert.equal(walletReads.length, 2, 'page 1, then page 2 with its handle');
  assert.equal(walletReads[1].request.cursor !== undefined, true);
  const prices = asked.filter((url) => new URL(url).pathname.startsWith('/tokens/'));
  assert.deepEqual(prices, [`https://api.dexscreener.com/tokens/v1/robinhood/${TOKEN}`], 'one price GET, for the one token held; native ETH at zero needs none');
  ownRequestsOnly(requests, { walletAddress: OWNER });
  // Changed on purpose (round 6, 2026-09-27; the owner: the Wallet card's tokens took far too long to appear): the card
  // keeps its last list per address in the browser, under one key (src/lib/walletMemory.ts), and draws it at once on the
  // next visit. Public chain and market data only: never the continuation handle.
  // Changed on purpose 2026-10-01 (the chain2 workstream, part B, audit G10): the key names its chain (domino-wallet-v2:4663).
  assert.deepEqual(await keptKeys(page), ['domino-wallet-v2:4663'], 'the card’s one key, and nothing else');
  const kept = await page.evaluate(() => localStorage.getItem('domino-wallet-v2:4663'));
  assert.ok(kept.includes(OWNER.toLowerCase()) && kept.includes(TOKEN.toLowerCase()), 'the address and the token it holds');
  assert.doesNotMatch(kept, /cursor|c0ffee/i, 'no continuation handle');
  // The tests after this one share its browser context and check that their own pages keep nothing: the card's list
  // is let go here, so what they find is theirs.
  await page.evaluate(() => localStorage.removeItem('domino-wallet-v2:4663'));
  await quiet(page, errors);
  await page.close();
});

// Changed on purpose (owner, 2026-09-24): a link with a list of ids used to be looked up on arrival. There is no lookup
// any more: `#/positions/<anything but one id>` is the list, and nothing of the link is read.
test('a link that carries a list of ids is the list: nothing of it is read or kept', async () => {
  const { page, errors } = await tracked();
  await page.goto(`${origin}/#/positions/1,${BIG}`, { waitUntil: 'networkidle' });
  await page.locator('[data-owned]').waitFor();
  assert.equal(await page.locator('[data-position-detail], [data-position-loading], #chain-lookup').count(), 0);
  assert.deepEqual((await fixtureReads(page)).filter((r) => r.route === 'nft-positions'), [], 'no id of the link is read');
  assert.equal(await page.evaluate(() => location.hash), `#/positions/1,${BIG}`, 'the link stays as it was');
  assert.deepEqual(await keptKeys(page), [], 'nothing about the ids is kept');
  await quiet(page, errors);
  await page.close();
});

// Changed on purpose (owner, 2026-09-24): a link with one NFT id is that position's own page (screens/PositionDetail.tsx),
// where Create position lands. It reads the fees relay's /state, never the read service (which may be down); this build
// has no relay, so the page says only, in a title and a data attribute, that the position could not be read.
// Changed on purpose 2026-10-01 (RPC-SPEC P2): the read gateway's row of the NFT is that page's fallback (below).
test('a link with one NFT id opens that position’s own page: no lookup, no read-service read, no Retry, nothing kept', async () => {
  const { page, errors } = await tracked();
  await page.goto(`${origin}/#/positions/${BIG}`, { waitUntil: 'networkidle' });
  await page.locator('[data-position-detail], [data-position-reason], [data-position-loading], [data-empty="position-gone"]').first().waitFor();
  assert.equal(await page.locator('#chain-lookup, [data-owned]').count(), 0, 'the position’s page, not the list');
  assert.equal(await page.locator('main').getByRole('link', { name: 'Positions', exact: true }).first().getAttribute('href'), '#/positions');
  // Changed on purpose 2026-10-01 (RPC-SPEC D2, P2): while the page's own state cannot be read (this build reads no
  // chain, so it answers unavailable), the read gateway's row of that one NFT is the page's fallback (lib/positions/
  // gatewayRow.ts): its nft-positions read of the link's id, once, and the pool's price only for a live NFT. Never a
  // lookup of the wallet, and nothing is drawn that the gateway did not give.
  const gateway = (await fixtureReads(page)).filter((r) => r.route === 'nft-positions' || r.route === 'pool-market');
  const nfts = gateway.filter((r) => r.route === 'nft-positions');
  assert.ok(nfts.length <= 1, `the gateway's row is asked at most once (${nfts.length})`);
  for (const read of nfts) assert.deepEqual(read.request, { tokenIds: [BIG], blockNumber: null }, 'the link’s id alone');
  assert.ok(gateway.filter((r) => r.route === 'pool-market').length <= nfts.length, 'the pool only after its NFT');
  for (const label of await page.locator('main').getByRole('button').allInnerTexts()) assert.doesNotMatch(label, /^(Retry|Refresh|Read again|Look up positions)$/, label);
  assert.deepEqual(await keptKeys(page), [], 'nothing about the id is kept');
  await quiet(page, errors);
  await page.close();
});

test('local states: a full queue and a spent budget have their own words', async () => {
  const flood = await openCase('local.flood');
  await flood.page.waitForFunction(() => document.querySelector('[data-flood-result]')?.textContent);
  assert.equal(await flood.page.locator('[data-flood-result]').innerText(), 'Too many reads queued. Try again in a moment.');
  assert.ok((await caseLog(flood.page)).length <= 12);
  await flood.page.close();
  const budget = await openCase('local.budget');
  await budget.page.waitForFunction(() => document.querySelector('[data-budget-result]')?.textContent, null, { timeout: 5000 });
  assert.equal(await budget.page.locator('[data-budget-result]').innerText(), 'The read took too long and was stopped.');
  await budget.page.close();
});

// --- the selectors ------------------------------------------------------------

const heading = (page) => page.evaluate(() => (document.activeElement?.id === 'step-dialog-title' ? document.activeElement.textContent : `not the heading: ${document.activeElement?.tagName}`));
const dialogOf = (page) => page.locator('[role="dialog"]');

async function openPicker(page) {
  await page.getByRole('button', { name: 'New position' }).click();
  const dialog = dialogOf(page);
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Choose token' }).click();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Choose a token from chain data');
  return dialog;
}

async function check(page, address) {
  await page.fill('#token-address', address);
  await dialogOf(page).getByRole('button', { name: 'Check address' }).click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"] form [aria-disabled="true"]'));
}

const tokenReads = async (page) => (await caseLog(page)).filter((r) => r.route === 'token');

test('pasting a token address: exact, never trimmed, line breaks refused before the browser flattens them', async () => {
  const { page, errors } = await openCase('create.tokens');
  const dialog = await openPicker(page);
  assert.equal(await heading(page), 'Choose a token from chain data', 'the picker heading takes focus');
  // The note on native and wrapped ETH is folded under its own heading; it is the same note.
  await dialog.locator('details', { hasText: 'About native ETH & wrapped tokens' }).locator('summary').click();
  assert.match(await dialog.innerText(), /Native ETH has the address 0x0000…0000\. Wrapped ETH is a separate ERC-20/);

  for (const pasted of [`${TOKEN}\n`, `${TOKEN}\r\n`, `${TOKEN.slice(0, 20)}\n${TOKEN.slice(20)}`]) {
    await page.fill('#token-address', '');
    await page.locator('#token-address').evaluate((input, text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, pasted);
    assert.match(await dialog.locator('#token-address-error').innerText(), /The pasted text contains a line break\. Paste just the address\./);
  }
  await page.fill('#token-address', `0X${TOKEN.slice(2)}`);
  await dialog.getByRole('button', { name: 'Check address' }).click();
  assert.equal(await page.locator('#token-address').getAttribute('aria-invalid'), 'true');
  assert.match(await dialog.locator('#token-address-error').innerText(), /Addresses start with lowercase 0x\./);
  assert.equal((await tokenReads(page)).length, 0, 'nothing refused was sent');

  const upper = `0x${'A'.repeat(40)}`;
  await check(page, upper);
  const sent = await tokenReads(page);
  assert.deepEqual(sent.map((r) => r.request.token), [upper], 'sent exactly as typed');
  assert.match(await dialog.innerText(), /decimals unavailable/);
  await quiet(page, errors);
  await page.close();
});

test('an HTML-like symbol is only text; unreadable tokens cannot be chosen and say why; ETH and WETH are two rows', async () => {
  const { page, errors } = await openCase('create.tokens');
  const dialog = await openPicker(page);
  for (const address of [at('2'), at('4'), at('5'), at('6'), NATIVE, at('7')]) await check(page, address);
  const probe = await dialog.evaluate((root, symbol) => ({
    literal: root.innerText.includes(symbol),
    injected: root.querySelectorAll('img[src="x"], img[onerror]').length,
    inAttributes: Array.from(root.querySelectorAll('*')).flatMap((node) => Array.from(node.attributes, (a) => a.value)).filter((v) => v.includes(symbol) || v.includes('onerror')),
    isolated: Array.from(root.querySelectorAll('bdi')).some((node) => node.textContent === symbol),
    images: Array.from(root.querySelectorAll('img')).map((img) => img.getAttribute('src')),
  }), SYMBOL);
  assert.equal(probe.literal, true);
  assert.equal(probe.injected, 0);
  assert.deepEqual(probe.inAttributes, []);
  assert.equal(probe.isolated, true);
  assert.ok(probe.images.every((src) => /^\/tokens\/[a-z]+\.(svg|jpg|png)$/.test(src)), `no remote image: ${probe.images}`);

  const rows = await dialog.locator('[data-candidate]').evaluateAll((items) =>
    items.map((li) => {
      const radio = li.querySelector('input[type="radio"]');
      const reasonId = radio.getAttribute('aria-describedby');
      return { address: li.querySelector('[data-address]').textContent, disabled: radio.disabled, reason: reasonId ? document.getElementById(reasonId)?.textContent : null };
    }),
  );
  const row = (address) => rows.find((r) => r.address === address);
  assert.equal(row(at('4')).disabled, true);
  assert.equal(row(at('4')).reason, 'Not selectable: no contract at this address.');
  assert.match(row(at('5')).reason, /couldn’t be read \(RPC error\)/);
  assert.match(row(at('6')).reason, /RPC call hit the gas limit/);
  assert.equal(row(at('2')).disabled, false);
  assert.equal(row(NATIVE).disabled, false);
  assert.equal(row(at('7')).disabled, false);
  assert.notEqual(row(NATIVE).address, row(at('7')).address, 'native ETH and WETH are two rows');
  assert.deepEqual(await page.evaluate(() => window.__alerts), []);
  await quiet(page, errors);
  await page.close();
});

// Restored 2026-10-01 (audit H11, skipped since 2026-09-12): the case typed into #amount, the draft field of #72's
// create flow, and expected Escape and a backdrop click to go back to Pair, as that flow's frame would have. The frame
// never landed; the lab's shell is the shared dialog (lib/useDialog.ts), which closes on Escape and gives focus back to
// what opened it, and Back to pair is the way back. Checked as they are.
test('the picker is a keyboard dialog: contained focus, arrow keys, the filter keeps the choice, Back to pair from the keyboard, Escape closes and gives focus back', async () => {
  const { page, errors } = await openCase('create.tokens');
  const dialog = await openPicker(page);
  assert.equal(await dialog.getByRole('button', { name: 'Use this token' }).isDisabled(), true, 'nothing chosen yet');
  for (const address of [NATIVE, TOKEN, at('4'), at('7')]) await check(page, address);

  const inside = () => page.evaluate(() => document.querySelector('[role="dialog"]').contains(document.activeElement));
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    assert.equal(await inside(), true, `focus escaped after ${i + 1} tabs`);
  }
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Shift+Tab');
    assert.equal(await inside(), true, 'focus escaped backwards');
  }

  const radios = dialog.locator('input[name="token-candidate"]');
  await radios.first().check();
  await page.keyboard.press('ArrowDown');
  const checked = await dialog.locator('input[name="token-candidate"]:checked').evaluate((r) => r.closest('li').querySelector('[data-address]').textContent);
  assert.equal(checked, TOKEN, 'arrow keys move the choice to the next selectable row');
  assert.equal(await dialog.getByRole('button', { name: 'Use this token' }).isDisabled(), false);

  await page.fill('#token-filter', '7777');
  assert.match(await dialog.locator('[data-selected-hidden]').innerText(), /Selected, hidden by the filter:[\s\S]*0x1111/);
  assert.equal(await dialog.getByRole('button', { name: 'Use this token' }).isDisabled(), false, 'a hidden choice is still the choice');
  await page.fill('#token-filter', 'TOKEN');
  assert.match(await dialog.innerText(), /No loaded token has that address\./, 'symbols are never searched');
  await page.fill('#token-filter', '');

  // Back to pair from the keyboard: the dialog stays, the choice not confirmed is let go, the tokens checked stay listed.
  await dialog.getByRole('button', { name: 'Back to pair' }).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.textContent === 'Start with a token you know.');
  assert.equal(await dialog.count(), 1, 'Back to pair goes back to Pair, not out of the dialog');
  await dialog.getByRole('button', { name: 'Choose token' }).click();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Choose a token from chain data');
  assert.equal(await radios.count(), 4, 'the tokens checked before are still listed');
  assert.equal(await dialog.locator('input[name="token-candidate"]:checked').count(), 0, 'a choice never confirmed is not kept');

  await radios.nth(1).check();
  await dialog.getByRole('button', { name: 'Use this token' }).click();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Start with a token you know.');
  const summary = await dialog.locator('[data-chain-selection]').innerText();
  assert.match(summary, /Token: TOKEN · ERC-20 candidate/);
  assert.match(summary, /Not saved/);

  // Escape closes the whole dialog, from Pair as from inside a picker, and gives focus back to what opened it.
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'New position', 'Escape on Pair closes and returns focus');
  await openPicker(page);
  await page.locator('#token-address').focus();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'New position', 'Escape in a picker closes and returns focus');
  await quiet(page, errors);
  await page.close();
});

test('the picker fits a 360 px screen without sideways scrolling', async () => {
  const narrow = await signedIn({ width: 360, height: 740 });
  const { page, errors } = await openCase('create.tokens', narrow);
  const dialog = await openPicker(page);
  for (const address of [NATIVE, at('2')]) await check(page, address);
  // A listed balance as long as a uint256 (the fixture's) wraps between its digit groups instead of pushing the page sideways.
  await dialog.getByRole('button', { name: 'List tokens from a public address' }).click();
  await page.fill('#wallet-address', OWNER);
  await dialog.getByRole('button', { name: 'List tokens', exact: true }).click();
  await dialog.locator('[data-wallet-count]').waitFor();
  await dialog.getByText('Balance:', { exact: false }).first().waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `the page scrolls sideways by ${overflow}px`);
  const dialogOverflow = await dialogOf(page).evaluate((el) => el.scrollWidth - el.clientWidth);
  assert.ok(dialogOverflow <= 0, `the dialog scrolls sideways by ${dialogOverflow}px`);
  await quiet(page, errors);
  await narrow.close();
});

async function listWallet(page) {
  const dialog = await openPicker(page);
  await dialog.getByRole('button', { name: 'List tokens from a public address' }).click();
  await page.fill('#wallet-address', OWNER);
  await dialog.getByRole('button', { name: 'List tokens', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-wallet-pages]'));
  return dialog;
}

const waitIdle = (page) => page.waitForFunction(() => !Array.from(document.querySelectorAll('[data-wallet-candidates] button')).some((b) => b.textContent === 'Loading…'));

test('a public address lists tokens as a public lookup; Load more sends the handle back exactly, and it never reaches the page', async () => {
  const { page, errors } = await tracked();
  await page.addInitScript(watchForHandle, CURSOR.slice(0, 12));
  await page.goto(`${origin}/read-lab.html#screens/create.tokens`, { waitUntil: 'networkidle' });
  await page.locator('[data-screen-case="create.tokens"]').waitFor();
  const dialog = await listWallet(page);
  const wallet = dialog.locator('[data-wallet-candidates]');
  // The handle is live now (the first page's next handle, not yet sent back): look while it exists.
  assert.deepEqual(await handlePlaces(page, CURSOR.slice(0, 12)), NOWHERE, 'the live handle is in the page');
  // The listing says what it is: balances at one block, and no proof of who controls the address, in its title rather than a footnote
  // (changed on purpose: the review of 2026-09-14 moved data-source captions off product screens).
  assert.equal(await wallet.locator('[data-wallet-public-note]').innerText(), 'Find tokens held by a wallet address.');
  const count = wallet.locator('[data-wallet-count]');
  assert.equal(await count.innerText(), '2 tokens listed · page 1 of up to 5');
  assert.match(await count.getAttribute('title'), /Balances read from the chain at one block\. Anyone can see them; they don’t prove who controls the wallet\./);
  assert.doesNotMatch(await wallet.innerText(), /Balances read from the chain|prove who controls|Block \d/, 'no footnote about the data');
  assert.doesNotMatch(await wallet.innerText(), /\byour wallet\b|you own|connected/i, 'a listed address is never called the viewer’s own');
  await wallet.getByRole('button', { name: 'Load more' }).click();
  await waitIdle(page);
  await wallet.locator('[data-wallet-pages="2"] [data-wallet-count]').waitFor();
  // No list is called complete: the last page leaves nothing to press.
  assert.equal(await wallet.getByRole('button', { name: /All pages loaded|Load more/ }).count(), 0);
  const walletReads = (await caseLog(page)).filter((r) => r.route === 'wallet-assets');
  assert.deepEqual(walletReads.map((r) => r.request), [{ wallet: OWNER, autoDiscover: true }, { wallet: OWNER, autoDiscover: true, cursor: CURSOR }]);
  assert.deepEqual(await handlePlaces(page, CURSOR.slice(0, 12)), NOWHERE, 'the continuation handle is somewhere a person or a script can read it');
  assert.deepEqual(await handleSightings(page), [], 'the handle was written into the page at some moment');
  assert.match(await dialog.innerText(), /Balance: /);
  await quiet(page, errors);
  await page.close();
});

test('wallet restarts: once on its own, then left to the person; an empty list asks for token addresses; zero is 0; 5 pages at most', async () => {
  const restart = await openCase('create.walletRestart');
  const d1 = await listWallet(restart.page);
  await d1.getByRole('button', { name: 'Load more' }).click();
  await waitIdle(restart.page);
  assert.match(await d1.innerText(), /The list restarted from the first page\./);
  await restart.page.close();

  const twice = await openCase('create.walletRestartTwice');
  const d2 = await listWallet(twice.page);
  await d2.getByRole('button', { name: 'Load more' }).click();
  await waitIdle(twice.page);
  await d2.getByRole('button', { name: 'Load more' }).click();
  await waitIdle(twice.page);
  assert.match(await d2.innerText(), /The list changed again while restarting\. Restart it when you’re ready\./);
  const before = (await caseLog(twice.page)).length;
  await d2.getByRole('button', { name: 'Restart list' }).click();
  await waitIdle(twice.page);
  assert.equal((await caseLog(twice.page)).length, before + 1, 'one fresh first page, no loop');
  await twice.page.close();

  // The hint says what to do, nothing about the server (changed on purpose: it was a caption about the read service).
  const empty = await openCase('create.walletEmpty');
  const d3 = await listWallet(empty.page);
  assert.equal(await d3.locator('[data-wallet-hint]').innerText(), 'Add token addresses to check their balances.');
  await empty.page.close();

  // Zero balances hold nothing: the rows are listed, and the hint is there too.
  const zero = await openCase('create.walletZero');
  const d4 = await listWallet(zero.page);
  assert.match(await d4.innerText(), /Balance: 0\b/);
  assert.equal(await d4.locator('[data-wallet-hint]').count(), 1);
  await zero.page.close();

  const cap = await openCase('create.walletCap');
  const d5 = await listWallet(cap.page);
  for (let i = 0; i < 5; i++) {
    const more = d5.getByRole('button', { name: 'Load more' });
    if (!(await more.count())) break;
    await more.click();
    await waitIdle(cap.page);
  }
  assert.match(await d5.innerText(), /Showing the first 5 pages\./);
  assert.equal((await caseLog(cap.page)).filter((r) => r.route === 'wallet-assets').length, 5);
  await cap.page.close();
});

async function toPools(page) {
  const dialog = await openPicker(page);
  await check(page, TOKEN);
  await dialog.locator('input[name="token-candidate"]').first().check();
  await dialog.getByRole('button', { name: 'Use this token' }).click();
  await dialog.getByRole('button', { name: 'Choose existing pool' }).click();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Choose an existing pool');
  await page.waitForFunction(() => document.querySelector('[data-picker="pool"]')?.getAttribute('data-pools-state') !== 'loading');
  return dialog;
}

/** The pool list's sources and coverage, folded under the count of verified pools; opened to read. */
async function coverage(dialog) {
  const details = dialog.locator('[data-picker="pool"] details:has([data-pools-coverage])');
  if (!(await details.getAttribute('open'))) await details.locator('summary').click();
  return details.locator('[data-pools-coverage]').innerText();
}

test('existing pools: fee, verification, provenance, attributed figures, no recommendation, and a catalogue that restarts and verifies', async () => {
  const { page, errors } = await openCase('create.pools');
  const dialog = await toPools(page);
  assert.match(await dialog.innerText(), /1 verified pool · partial source coverage/);
  const sources = await coverage(dialog);
  assert.match(sources, /The discovery provider returned 1 candidate \(1 on Uniswap\)\. That covers the provider’s candidates only\./);
  assert.match(sources, /No pool catalogue is configured on this server/);
  const text = await dialog.innerText();
  const option = dialog.locator('[data-pool-option]').first();
  // The pool's details, its provenance among them, are folded under the block it was verified at.
  await option.locator('summary').click();
  const optionText = await option.innerText();
  assert.match(optionText, /0\.30%/);
  assert.match(optionText, /verified at block 700/);
  assert.match(optionText, /Found by provider discovery, verified on chain/);
  // The figures stand alone; who reported them is in the figure's title and in the details below.
  assert.match(optionText, /\$10\.00/);
  assert.match(optionText, /\$1\.2K/);
  assert.doesNotMatch(optionText, /\$10\.00 · Provider/, 'a provider is not a caption beside every number');
  assert.match(optionText, /Provider figures retrieved 00:16:50 UTC, 1970-01-01\. Provider-reported, not reconciled with chain data\./, 'source and age beside the figures');
  assert.doesNotMatch(optionText, /GeckoTerminal|DexScreener/, 'the provider is never named on a screen');
  // Changed on purpose (2026-09-20): this line sat under EVERY row, always the
  // same words, contradicting the estimate printed a few lines above it. The row
  // now carries its outcome on the figure itself, and nothing restates it below.
  assert.doesNotMatch(optionText, /Pool APR unavailable/, 'no constant caveat under the details');
  assert.match(optionText, /Pool APR/, 'the figure itself is still there');
  assert.equal(await option.locator('[data-row-apr]').count(), 1, 'exactly one APR outcome per row');
  assert.doesNotMatch(text, /recommended|top pick|best pool|suggested/i);
  assert.equal(await dialog.locator('[data-new-pool-note] button, [data-new-pool-note] a, [data-new-pool-note] input').count(), 0, 'the new-pool path has no control');

  await dialog.getByRole('button', { name: 'Load catalogue candidates' }).click();
  await page.waitForFunction(() => document.querySelector('[data-catalogue-item]'));
  await dialog.locator('[data-catalogue]').getByRole('button', { name: 'Load more' }).click();
  await page.waitForFunction(() => /changed during the read/.test(document.querySelector('[data-catalogue]')?.textContent ?? ''));
  await dialog.getByRole('button', { name: 'Verify at the latest block' }).click();
  await page.waitForFunction(() => /Verified: listed with the existing pools above/.test(document.querySelector('[data-catalogue]')?.textContent ?? ''));
  assert.equal(await dialog.locator('[data-pool-option]').count(), 1, 'the verified pool is the one already listed: one row, keyed by pool id');

  await option.locator('input[type="radio"]').check();
  await dialog.getByRole('button', { name: 'Use this pool' }).click();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Start with a token you know.');
  assert.match(await dialog.locator('[data-summary="Pool"]').innerText(), /0\.30% · Verified at block 700/);
  await quiet(page, errors);
  await page.close();
});

// Restored 2026-10-01 (audit H11, skipped since 2026-09-12 on an open question about the pools reply's pair echo): the
// screen now refuses a pool that does not hold the chosen token, so the case passes as written.
test('a pools reply whose pool does not hold the chosen token is a wrong answer: nothing to pick, nothing shown from it', async () => {
  const { page, errors } = await openCase('create.poolsForeign');
  const dialog = await toPools(page);
  const text = await dialog.innerText();
  assert.match(text, /Wrong answer/);
  assert.match(text, /The reply was about something other than what was asked, so nothing from it is shown\./);
  assert.equal(await dialog.locator('[data-pool-option]').count(), 0);
  assert.equal(await dialog.locator('input[name="pool-option"]').count(), 0);
  assert.doesNotMatch(text, /0x0911afcb|verified on chain/);
  await quiet(page, errors);
  await page.close();
});

test('rejected candidates are listed but not selectable; an unknown provider or empty list is never proof of no pool', async () => {
  const rejected = await openCase('create.poolsRejected');
  const d1 = await toPools(rejected.page);
  assert.match(await d1.locator('[data-rejected-pools]').innerText(), /Rejected: provider currency mismatch\./);
  assert.equal(await d1.locator('[data-rejected-pools] input').count(), 0);
  assert.equal(await d1.locator('[data-pool-option]').count(), 0);
  await rejected.page.close();

  for (const [id, words] of [
    ['create.poolsProviderUnavailable', /Provider discovery was unavailable \(network unavailable\), so this list may be incomplete\./],
    ['create.poolsMissing', /No verified pool was found in these sources\. That isn’t proof that none exists\./],
    ['create.pools409', /The catalogue changed during the read/],
  ]) {
    const { page } = await openCase(id);
    const dialog = await toPools(page);
    const text = `${await dialog.innerText()}\n${await coverage(dialog)}`;
    assert.match(text, words, id);
    assert.doesNotMatch(text, /no pool exists/i, id);
    await page.close();
  }
});

// --- practice range on a chosen pool (#3 S-PL7) ---------------------------------

async function choosePool(page) {
  const dialog = await toPools(page);
  await dialog.locator('[data-pool-option] input[type="radio"]').first().check();
  await dialog.getByRole('button', { name: 'Use this pool' }).click();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Start with a token you know.');
  return dialog;
}

async function toRange(page) {
  const dialog = await choosePool(page);
  await dialog.getByRole('button', { name: 'Set a range' }).click();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Range on this pool');
  return dialog;
}

const boundTicks = (dialog) => dialog.locator('[data-bound-tick]').evaluateAll((els) => els.map((el) => el.textContent.trim()));
const priceState = (dialog) => dialog.locator('[data-picker="range"]').getAttribute('data-price-state');
/** The width radios marked checked, by their text; exactly one is expected. */
const widthChecked = (dialog) =>
  dialog.locator('[role="radiogroup"] [role="radio"][aria-checked="true"]').allInnerTexts();
const storage = (page) => page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
const FORBIDDEN_CONTROL = /sign|approve|connect|deposit|swap|quote|mint|confirm|execute|buy|sell/i;

test('a chosen pool gets range controls on its read price: presets, steppers and sliders on the tick spacing, and no read, wallet or storage', async () => {
  const { page, errors } = await openCase('create.range');
  const stored = await storage(page);
  const dialog = await toRange(page);
  assert.equal(await heading(page), 'Range on this pool', 'the range view heading takes focus');
  const reads = (await caseLog(page)).length;

  const text = await dialog.innerText();
  // What the view is, in the words over it: a drawing on a read price, and nothing executable.
  assert.match(text, /A range drawn on this pool’s price as read, at one block\. Nothing is quoted, created, approved or signed\./);
  assert.match(text, /Pool price/);
  // Changed on purpose 2026-09-28 (one-sided): the app writes a token's price in ETH (lib/read/orientation.ts), so the
  // view reads TOKEN's price in ETH, Min is TOKEN's lowest price, and each end's tick (data-bound-tick) is the pool's own:
  // the lowest price sits at the pool's upper tick.
  assert.match(await dialog.locator('[data-pool-price-text]').innerText(), /^≈0\.000000000001$/);
  assert.match(text, /ETH per TOKEN/);
  assert.doesNotMatch(text, /· block 700/, 'the block a price was read at is not something to read beside it');
  assert.match(text, /Enter a price and apply, or drag a handle\. Prices snap outward to the pool’s tick spacing\./);
  assert.equal(await priceState(dialog), 'usable');
  // The tick arithmetic behind the range is no longer read on screen: the range is prices and handles.
  assert.equal(await dialog.locator('details:has([data-range-text])').count(), 0);
  assert.doesNotMatch(text, /\$\s?\d|amount|deposit/i, 'no amount and no money: an illustration of a range on a price');

  // The app's "Closer" preset, 0.7× to 1.5× of the pool price, on multiples of 60.
  assert.deepEqual(await boundTicks(dialog), ['3600', '-4080']);
  assert.equal(await dialog.getByRole('radio', { name: /Closer/ }).getAttribute('aria-checked'), 'true');
  // A range that holds the price says so to assistive technology and nothing on
  // screen; the line appears only when the range does not hold it.
  assert.equal(await dialog.locator('[data-range-position="inside"]').getAttribute('data-range-position'), 'inside');
  assert.equal(await dialog.locator('p[data-range-position]').count(), 0, 'nothing to warn about, nothing printed');

  await dialog.getByRole('button', { name: 'Raise the max price by one tick spacing' }).click();
  assert.deepEqual(await boundTicks(dialog), ['3600', '-4140']);
  assert.equal(await dialog.getByRole('radio', { name: 'Custom' }).getAttribute('aria-checked'), 'true');

  // The slider is a real range input on the tick spacing; its spoken value carries no symbol.
  const lower = dialog.locator('#range-lower');
  assert.deepEqual([await lower.getAttribute('step'), await lower.getAttribute('min'), await lower.getAttribute('max')], ['60', '-13920', '13920']);
  await lower.focus();
  await page.keyboard.press('ArrowRight');
  assert.deepEqual(await boundTicks(dialog), ['3540', '-4140']);
  const spoken = await lower.getAttribute('aria-valuetext');
  assert.match(spoken, /^≈[\d,.]+, −[\d.]+% from the pool price, tick 3540$/);
  assert.doesNotMatch(spoken, /TOKEN|ETH/, 'an untrusted symbol never goes into an attribute');
  assert.match(await dialog.locator('[data-range-bound="lower"] .pointer-events-none').innerText(), /^−[\d.]+%$/, 'the handle shows the distance from the pool price');
  // A bound never crosses the other: the lower stops one spacing below the upper.
  await page.keyboard.press('End');
  assert.deepEqual(await boundTicks(dialog), ['-4080', '-4140']);
  assert.equal(await dialog.locator('[data-range-position]').getAttribute('data-range-position'), 'below');
  assert.match(await dialog.locator('[data-range-position]').innerText(), /The pool price at this block is below this range\./);

  await dialog.getByRole('radio', { name: /Wider/ }).click();
  assert.deepEqual(await boundTicks(dialog), ['6960', '-6960']);
  assert.deepEqual(await widthChecked(dialog), ['Wider']);

  for (const name of await dialog.locator('button').allInnerTexts()) assert.doesNotMatch(name, FORBIDDEN_CONTROL, name);
  for (const label of await dialog.locator('button[aria-label]').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))) {
    assert.doesNotMatch(label, FORBIDDEN_CONTROL, label);
  }
  assert.equal(await dialog.locator('a').count(), 0);
  // The two sliders and the two price fields they mirror, and no other input: nothing to type an amount into.
  assert.deepEqual(await dialog.locator('input').evaluateAll((els) => els.map((el) => [el.type, el.id])), [
    ['text', 'range-lower-price'],
    ['range', 'range-lower'],
    ['text', 'range-upper-price'],
    ['range', 'range-upper'],
  ], 'the two sliders and their price fields');
  assert.deepEqual(await dialog.locator('input:not([type="range"])').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label'))), ['Min price input', 'Max price input']);

  await dialog.getByRole('button', { name: 'Use this range' }).click();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Start with a token you know.');
  assert.match(
    await dialog.locator('[data-summary="Range"]').innerText(),
    /^Range: ≈.+ to ≈.+ ETH per TOKEN · ticks -6960 to 6960 · on the price at block 700 · not saved, nothing is created$/,
  );

  // Reopened, the kept range says what it is: Wider, not the default Closer.
  const reopen = async () => {
    await dialog.getByRole('button', { name: 'Change range' }).click();
    await page.waitForFunction(() => document.activeElement?.textContent === 'Range on this pool');
  };
  await reopen();
  assert.deepEqual(await boundTicks(dialog), ['6960', '-6960']);
  assert.deepEqual(await widthChecked(dialog), ['Wider'], 'a kept Wider range reopens as Wider');
  // Back leaves the kept range as it was.
  await dialog.getByRole('button', { name: 'Raise the max price by one tick spacing' }).click();
  assert.deepEqual(await widthChecked(dialog), ['Custom']);
  await dialog.getByRole('button', { name: 'Back to pair' }).click();
  assert.match(await dialog.locator('[data-summary="Range"]').innerText(), /ticks -6960 to 6960/);
  await reopen();
  assert.deepEqual(await widthChecked(dialog), ['Wider'], 'Back dropped the edit, so still Wider');
  // A custom range kept and reopened is Custom, not a preset.
  await dialog.getByRole('button', { name: 'Raise the max price by one tick spacing' }).click();
  await dialog.getByRole('button', { name: 'Use this range' }).click();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Start with a token you know.');
  assert.match(await dialog.locator('[data-summary="Range"]').innerText(), /ticks -7020 to 6960/);
  await reopen();
  assert.deepEqual(await boundTicks(dialog), ['6960', '-7020']);
  assert.deepEqual(await widthChecked(dialog), ['Custom'], 'a kept custom range reopens as Custom');
  await dialog.getByRole('button', { name: 'Back to pair' }).click();

  assert.equal((await caseLog(page)).length, reads, 'range controls read nothing');
  assert.equal(await storage(page), stored, 'nothing stored');
  await quiet(page, errors);
  await page.close();
});

test('no usable price, no range controls: unknown decimals and a tick that disagrees with the square-root price; partial metadata is said', async () => {
  for (const [id, problem, words] of [
    ['create.rangeNoDecimals', 'decimals_unknown', /A price needs both tokens’ decimals, and at least one couldn’t be read\./],
    ['create.rangeMismatch', 'tick_mismatch', /The pool’s tick and square-root price don’t agree, so neither is used\./],
  ]) {
    const { page, errors } = await openCase(id);
    const dialog = await toRange(page);
    assert.equal(await priceState(dialog), 'unavailable', id);
    const unavailable = dialog.locator('[data-price-unavailable]');
    assert.equal(await unavailable.getAttribute('data-price-unavailable'), problem, id);
    // No panel: the price is a dash, and why is its title (and words for assistive technology only).
    const why = await unavailable.getAttribute('title');
    assert.match(why, /^Pool price unavailable: /, id);
    assert.match(why, words, id);
    assert.match(why, /Range controls need a price read from chain, so this pool has none\.$/, id);
    assert.equal(await unavailable.locator('.sr-only').textContent(), why, id);
    assert.equal(await unavailable.locator('p:not(.sr-only)').innerText(), '—', `${id}: a dash in the price’s place`);
    assert.equal(await dialog.locator('.dm-inset[role="status"], [data-price-unavailable].dm-inset').count(), 0, `${id}: no status panel`);
    assert.equal(await dialog.locator('[data-range-controls], input[type="range"], [data-pool-price-text]').count(), 0, `${id}: no controls and no invented price`);
    assert.doesNotMatch(await dialog.locator('[data-pool-price]').innerText(), /≈/, id);
    assert.equal(await dialog.getByRole('button', { name: 'Use this range' }).isDisabled(), true, id);
    await dialog.getByRole('button', { name: 'Back to pair' }).click();
    assert.equal(await dialog.locator('[data-summary="Range"]').count(), 0, id);
    await quiet(page, errors);
    await page.close();
  }

  const { page, errors } = await openCase('create.rangePartial');
  const dialog = await toRange(page);
  assert.equal(await priceState(dialog), 'partial');
  // Partial metadata is said in the title over both addresses, never in a pill or a coloured line.
  assert.equal(await dialog.locator('[data-price-partial]').getAttribute('title'), 'Token metadata is partial: a symbol may be missing, so both addresses are shown. The price uses the decimals read from chain.');
  assert.doesNotMatch(await dialog.locator('[data-pool-price]').innerHTML(), /money-wait|dm-pill/);
  const partial = await dialog.locator('[data-price-partial]').innerText();
  assert.match(partial, new RegExp(NATIVE));
  assert.match(partial, new RegExp(TOKEN));
  assert.match(partial, /Unknown symbol/);
  assert.equal(await dialog.locator('input[type="range"]').count(), 2, 'a partial price still has controls');
  await quiet(page, errors);
  await page.close();
});

test('a price read more than 5 minutes ago on the page is marked stale in its title and data only, and the next change to the range reads it again', async () => {
  const { page, errors } = await tracked();
  await page.clock.install();
  await page.goto(`${origin}/read-lab.html#screens/create.range`, { waitUntil: 'networkidle' });
  await page.locator('[data-screen-case="create.range"]').waitFor();
  const dialog = await toRange(page);
  assert.equal(await priceState(dialog), 'usable');
  const reads = (await caseLog(page)).length;

  await jump(page, '04:50');
  assert.equal(await priceState(dialog), 'usable', 'not yet five minutes');
  await jump(page, '00:15');
  await page.waitForFunction(() => document.querySelector('[data-picker="range"]')?.getAttribute('data-price-state') === 'stale');
  assert.equal(await dialog.locator('[data-price-stale]').getAttribute('title'), 'This price was read more than 5 minutes ago on this page, and the pool’s price has probably moved since.');
  assert.match(await dialog.locator('[data-pool-price-text]').innerText(), /^≈0\.000000000001$/, 'the same price, in the same ink');
  assert.doesNotMatch(await dialog.locator('[data-pool-price]').innerHTML(), /money-wait|dm-pill|>Stale</, 'no pill, no colour, no word');
  assert.equal(await dialog.locator('[data-picker="range"] .dm-pill').count(), 0);
  assert.equal(await dialog.getByRole('button', { name: /Refresh|Read the price again/ }).count(), 0, 'no refresh control');
  assert.equal(await dialog.locator('input[type="range"]').count(), 2, 'the controls stay');
  assert.equal((await caseLog(page)).length, reads, 'nothing is read by itself');

  // Choosing a width is the next change to the range: it is drawn at once, and the stale price is read again, once.
  await dialog.getByRole('radio', { name: /Closer/ }).click();
  await page.waitForFunction(() => document.querySelector('[data-picker="range"]')?.getAttribute('data-price-read') === 'ok');
  assert.match(await dialog.locator('[data-pool-price] [role="status"]').textContent(), /^Price read again at block 705\.$/, 'said to assistive technology only');
  assert.equal(await priceState(dialog), 'usable');
  // The lab's second reading moved the price one tick spacing, to tick 60.
  assert.match(await dialog.innerText(), /ETH per TOKEN/);
  assert.deepEqual(await boundTicks(dialog), ['3600', '-4080'], 'the practice range stays');
  assert.deepEqual(await widthChecked(dialog), ['Custom'], 'the kept range is no longer Closer on the moved price');
  const log = await caseLog(page);
  assert.equal(log.length, reads + 1, 'one read, on request');
  assert.deepEqual(log.at(-1).request, { token: TOKEN, maxPools: 1, poolIds: ['0x0911afcb281d7bcae2d71443ceaeebd0f89b4537708449970d797622b4b4c941'] });
  await quiet(page, errors);
  await page.close();
});

test('the range view fits a 360 px screen without sideways scrolling', async () => {
  const narrow = await signedIn({ width: 360, height: 740 });
  const { page, errors } = await openCase('create.range', narrow);
  const dialog = await toRange(page);
  await dialog.locator('#range-upper').focus();
  await page.keyboard.press('End');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `the page scrolls sideways by ${overflow}px`);
  const dialogOverflow = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
  assert.ok(dialogOverflow <= 0, `the dialog scrolls sideways by ${dialogOverflow}px`);
  await quiet(page, errors);
  await narrow.close();
});

test('a wallet reply about another chain lists nothing, with one plain line and its reason only in a title', async () => {
  const { page, errors } = await openCase('create.walletOtherChain');
  const dialog = await listWallet(page);
  await waitIdle(page);
  const listing = dialog.locator('[data-wallet-candidates]');
  const failed = listing.locator('[data-wallet-failed]');
  await failed.waitFor();
  assert.equal(await failed.innerText(), 'No tokens to show.');
  assert.equal(await failed.getAttribute('data-wallet-failed'), 'response_contract');
  assert.match(await failed.getAttribute('title'), /Update needed/);
  assert.doesNotMatch(await visibleText(listing), /Update needed/, 'the reason is not printed');
  assert.equal(await listing.locator('[data-screen-status], .text-money-wait').count(), 0, 'no status panel and no yellow');
  assert.equal(await listing.getByRole('button', { name: 'Retry' }).count(), 0);
  assert.equal(await dialog.locator('[data-candidate]').count(), 0);
  assert.doesNotMatch(await dialog.innerText(), /Balance at the snapshot block/);
  await quiet(page, errors);
  await page.close();
});

// --- attributed figures ----------------------------------------------------------

async function openFigures(page) {
  const button = page.locator('[data-pool-figures]').first();
  await button.click();
  const dialog = page.locator('[data-pool-figures-dialog]');
  await dialog.waitFor();
  await page.waitForFunction(() => document.querySelector('[data-pool-figures-dialog] [data-figures-activity]')?.getAttribute('data-figures-activity') !== 'loading');
  return dialog;
}

/** The Selected pools table with its row on the page: the row appears with its provenance line once the pool's reads are in. */
async function table(page) {
  await page.locator('#root tbody tr').first().waitFor();
  await page.waitForFunction(() => document.querySelector('#root tbody tr [data-provenance]'));
}

test('provider figures carry their source and retrieval on the row; every cell without a number carries its reason; the APR stays unavailable', async () => {
  const { page, errors } = await openCase('figures.provider');
  await table(page);
  const cells = await page.locator('tbody [data-metric], tbody [data-apr-estimate]').evaluateAll((els) =>
    els.map((el) => ({
      text: el.innerText.replace(/\s/g, ''),
      state: el.getAttribute('data-metric') ?? el.getAttribute('data-apr-estimate'),
      title: el.getAttribute('title') ?? el.querySelector('[title]')?.getAttribute('title') ?? null,
    })),
  );
  // F3's read contract carries no 30d volume, so the column that read 'absent' upstream does not exist, and
  // the 24h vol/TVL ratio is no longer a table column (DESIGN.md E.2): it lives in the pool page's details.
  // The price cell before these is the pool's own ratio from chain state and carries no figure attribute.
  assert.deepEqual(cells.map((c) => c.state), ['provider', 'provider', 'unavailable']);
  // The figure alone in its cell; who reported it is on the row's provenance line and in the cell's own title.
  assert.equal(cells[0].text, '$12.3K');
  assert.match(cells[0].title, /^Reported by a market data provider, retrieved \d+ s ago\. Not reconciled by Domino\.$/);
  assert.match(cells[1].title, /^Reported by a market data provider, retrieved \d+ s ago\. Not reconciled by Domino\.$/);
  assert.equal(await page.locator('tbody tr td').nth(1).locator('[data-pool-price]').count(), 1, 'the price is the pool’s own ratio, in its own cell');
  // Every cell showing no number carries its reason.
  for (const cell of cells.filter((c) => ['unavailable', 'absent', 'not-current', 'rejected'].includes(c.state))) assert.ok(cell.title, `${cell.text} carries a reason`);
  // F3's lean table never reads pool-metrics, and the fixture lab has no estimate namespace, so the APR
  // is the estimate cell saying it is not enabled: never a figure, and never borrowed from the qualified field.
  assert.equal(cells[2].text, '—', 'no estimate: the catalogue dash, reason in its title');
  assert.match(cells[2].title, /Pool estimate, not position APR, APY or a return forecast\. Estimated APR is (not enabled on this connection|unavailable; market figures use the supported read connection)\./, 'APR stays unavailable, and says why');
  // The provenance is the row's title and its data, not a line printed under the name.
  const provenance = await page.locator('tbody tr [data-provenance]').getAttribute('data-provenance');
  assert.match(provenance, /^Pool verified on-chain at block 700 · Reported by a market data provider, retrieved \d+ s ago$/, 'source and retrieval age on the row');
  assert.equal(await page.locator('tbody tr [data-provenance]').getAttribute('title'), provenance, 'the same words on hover');
  assert.doesNotMatch(`${provenance} ${cells[0].text}`, /\b(current|live|updated|qualified)\b/i);
  assert.doesNotMatch(provenance, /\$\d|as of|updated at/i, 'the provenance never repeats a figure, nor dates one it cannot date');
  // No caption under the table any more (the owner's decision on the redesign): the APR caveat is the cell's own title, above, and the dialog's, below.
  assert.doesNotMatch(await page.locator('#root').innerText(), /Est\. APR describes a pool, not a position|names its source and its age/);

  const before = (await caseLog(page)).filter((r) => r.route === 'pool-activity').length;
  assert.equal(before, 0, 'no pool-activity read before the dialog opens');
  const dialog = await openFigures(page);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'pool-figures-title');
  const text = await dialog.innerText();
  // Domino's 24h figures, not read for this row: each a dash that says why in its title, never a sentence.
  const history = dialog.locator('[data-figures-qualified="no"]');
  const reasons = await history.locator('dd [title]').evaluateAll((els) => els.map((el) => [el.textContent, el.getAttribute('title')]));
  assert.deepEqual(reasons.map(([dash]) => dash), ['—', '—', '—', '—', '—']);
  assert.deepEqual(reasons.slice(0, 2).map(([, why]) => why), ['Not qualified: the figure shown is the provider’s', 'Not qualified: the figure shown is the provider’s']);
  assert.doesNotMatch(await history.innerText(), /yet|usable|need/i);
  // Who reported the figures and when: the figure's title, not a caption under it.
  assert.match(await dialog.locator('[data-provider-figure="attributed"]').first().getAttribute('title'), /^Reported by a market data provider, retrieved \d\d:\d\d:\d\d UTC, 1970-01-01\. Provider-reported, not reconciled with chain data\.$/);
  assert.match(text, /Pool is 19 s old; the 24h window isn’t complete/);
  // What the estimate is not: its own title, not a closing caption.
  assert.match(await dialog.locator('[data-figures-provider]').evaluate((el) => el.closest('[data-pool-figures-dialog]').querySelector('[data-apr-estimate] [title]').getAttribute('title')), /^Pool estimate, not position APR, APY or a return forecast\./);
  assert.doesNotMatch(text, /Retrieval age isn’t proof of a complete 24h window|Pool APR describes a pool, not a position|Block \d+/, 'no captions about sources under the figures');
  assert.doesNotMatch(await dialog.innerHTML(), /money-wait/);
  assert.equal((await caseLog(page)).filter((r) => r.route === 'pool-activity').length, 1, 'exactly one pool-activity read, after the click');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-pool-figures')), true, 'focus returns to the pool');
  await quiet(page, errors);
  await page.close();
});

// Restored 2026-10-01 (audit H11, skipped since 2026-09-12): 'qualified' and 'reference' came from the pool-metrics read
// F3 dropped from the table's path, so MARKET_CASES has neither and their lab cases draw no row; the qualified figures
// are the pool page's (the pool page test below). The provider's own states, and a failed activity read, are each
// checked here as they read today: the 30d volume column is gone with F3's contract, so a row has two provider cells.
test('stale, expired, missing and zero provider figures, and an activity read that failed, each read as themselves', async () => {
  const cellsOf = (page) => page.locator('tbody [data-metric]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-metric'), e.innerText.replace(/\s+/g, ' ').trim()]));

  const stale = await openCase('figures.stale');
  await table(stale.page);
  assert.deepEqual(await cellsOf(stale.page), [['stale', '$12.3K'], ['stale', '$0.00']], 'a stale figure is still shown, marked stale');
  assert.match(await stale.page.locator('tbody [data-metric]').first().getAttribute('title'), /Stale, not current\.$/);
  const s = await openFigures(stale.page);
  assert.match(await s.innerText(), /Liquidity\s+\$12\.3K\s+Reported by a market data provider, retrieved [^.]*\. This observation is stale\./);
  await stale.page.close();

  const expired = await openCase('figures.expired');
  await table(expired.page);
  assert.deepEqual(await cellsOf(expired.page), [['unavailable', 'Unavailable'], ['unavailable', 'Unavailable']]);
  assert.doesNotMatch(await expired.page.locator('#root').innerText(), /\$12\.3K/, 'an expired figure is never shown');
  await expired.page.close();

  const missing = await openCase('figures.missing');
  await table(missing.page);
  assert.deepEqual(await cellsOf(missing.page), [['absent', 'Not reported by the provider'], ['absent', 'Not reported by the provider']]);
  assert.equal(await missing.page.locator('tbody [data-metric]').first().getAttribute('title'), 'Unavailable: the market data provider reported no value');
  await missing.page.close();

  const zero = await openCase('figures.zero');
  await table(zero.page);
  assert.deepEqual(await cellsOf(zero.page), [['provider', '$0.00'], ['provider', '$0.00']], 'zero is a figure, not a missing one');
  await zero.page.close();

  const unavailable = await openCase('figures.activityUnavailable');
  await table(unavailable.page);
  const u = await openFigures(unavailable.page);
  assert.equal(await u.locator('[data-figures-activity]').getAttribute('data-figures-activity'), 'failed');
  assert.match(await u.innerText(), /Pool activity data unavailable/);
  await unavailable.page.close();
});

// Restored 2026-10-01 (audit H11, skipped since 2026-09-12 on the landing's read sequence): the fixture build's table
// keeps its own fixture pipeline (lib/read/buildMode.ts), so the app's read log holds no table read to count. What the
// case guards stands: nothing reads pool activity until a pool's figures are opened, and opening them reads it once.
test('the fixture landing reads no pool activity until a pool is opened', async () => {
  const { page, errors } = await tracked();
  await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  await page.locator('#pools tbody tr').first().waitFor();
  await page.waitForFunction(() => document.querySelector('#pools tbody tr [data-provenance]'));
  const routes = () => page.evaluate(() => (window.__DOMINO_FIXTURE_READS__ ?? []).map((r) => r.route));
  assert.deepEqual((await routes()).filter((r) => r === 'pool-activity'), [], 'no pool activity while the table is drawn');
  const button = page.locator('#pools [data-pool-figures]');
  assert.equal(await button.count(), 1);
  assert.match(await button.innerText(), /figures/);
  await button.click();
  await page.locator('[data-pool-figures-dialog]').waitFor();
  await page.waitForFunction(() => (window.__DOMINO_FIXTURE_READS__ ?? []).some((r) => r.route === 'pool-activity'));
  assert.equal((await routes()).filter((r) => r === 'pool-activity').length, 1);
  await quiet(page, errors);
  await page.close();
});

test('a dynamic-fee pool reads Dynamic on the Top pools table too', async () => {
  const { page, errors } = await openCase('figures.dynamicFee');
  await table(page);
  const row = await page.locator('tbody tr').first().innerText();
  assert.match(row, /·\s*Dynamic fee/);
  assert.doesNotMatch(row, /838\.8608%|838\.86%|0\.30%/);
  await quiet(page, errors);
  await page.close();
});

test('a Top pools read that outlasts its budget is stopped, and says so in its own words', async () => {
  const { page, errors } = await openCase('figures.budget');
  await page.waitForFunction(() => document.querySelector('#root')?.innerText.includes('Stopped after 60 s, time spent queued included.'), null, { timeout: 5000 });
  assert.doesNotMatch(await page.locator('#root').innerText(), /after \d+ attempts/, 'a time budget is never worded as retries used up');
  assert.equal(await page.locator('tbody [data-metric]').count(), 0, 'no figure from a read that never answered');
  const market = (await caseLog(page)).filter((r) => r.route === 'pool-market');
  assert.equal(market.length, 1);
  assert.equal(market[0].aborted, true, 'the read itself was cancelled, not left running');
  await quiet(page, errors);
  await page.close();
});

// #112 review, P2: the table used to hand the dialog the market as it was when
// the row was clicked, so an open dialog kept the original provider state and
// cache age however long it stayed open — the row said stale while the dialog
// still said `cache 0 s`. The table now holds the pool by key and projects it
// again on every tick, so both age together.
test('the figures dialog ages with the row behind it, and says stale when the row does', async () => {
  const { page, errors } = await tracked();
  await page.clock.install();
  await page.goto(`${origin}/read-lab.html#screens/figures.provider`, { waitUntil: 'networkidle' });
  await page.locator('[data-screen-case="figures.provider"]').waitFor();
  await page.locator('#root tbody tr').first().waitFor();

  const dialog = await openFigures(page);
  assert.equal(await dialog.locator('[data-provider-figure="attributed_stale"]').count(), 0, 'nothing is stale yet');
  // The provenance moved off the line into the figure's title with the rest of the
  // provider captions, and says when the observation was retrieved rather than how
  // long a cache had held it: the age is the retrieval, read against the clock.
  assert.match(await dialog.locator('[data-provider-figure="attributed"]').first().getAttribute('title'), /Reported by a market data provider, retrieved .*not reconciled with chain data\./);
  // The dialog still offers the long provenance to assistive technology; what went
  // is the caption printed beside every number.
  assert.doesNotMatch(await dialog.locator('[data-provider-figure="attributed"]').first().locator('> div').innerText(), /provider|cache 0 s/i, 'no provider caption on the figure line');

  const readsBeforeAge = await caseLog(page);
  // Past the read service's fresh window, with the dialog left open.
  await jump(page, '01:05');
  await page.waitForFunction(() => document.querySelectorAll('[data-pool-figures-dialog] [data-provider-figure="attributed_stale"]').length > 0);
  const aged = await dialog.innerText();
  // The owner's rule: a stale figure reads as the figure, in the same ink; that it is stale is its state and its title.
  const staleFigure = dialog.locator('[data-provider-figure="attributed_stale"]').first();
  assert.match(await staleFigure.getAttribute('title'), /This observation is stale\./, 'the open dialog says stale in the figure’s title');
  assert.match(await staleFigure.locator('> div').innerText(), /^Liquidity\s+\$12\.3K$/, 'and draws the figure as it was, with no stale word and no provider beside it');
  assert.doesNotMatch(await staleFigure.innerHTML(), /money-wait/);
  assert.match(await staleFigure.getAttribute('title'), /This observation is stale\./, 'and the title says so rather than reporting a cache age as if it were current');
  assert.doesNotMatch(aged, /A later refresh failed/i, 'aging alone does not imply a failed refresh');
  assert.deepEqual(await caseLog(page), readsBeforeAge, 'the display clock starts no new read');
  assert.deepEqual(await page.locator('tbody [data-metric="stale"]').count() > 0, true, 'the row behind it says the same');

  await quiet(page, errors);
  await page.close();
});

// --- markets-snapshot listed in the figures lab (G2 through the real table) -------

test('with markets-snapshot listed, a current stored row is the row: one snapshot read, its tokens, and no market read; the dialog still reads activity only when opened', async () => {
  const { page, errors } = await openCase('figures.snapshot');
  await table(page);
  await page.locator('tbody tr[data-row-source="markets-snapshot"]').waitFor();
  assert.deepEqual((await caseLog(page)).map((r) => r.route), ['markets-snapshot', 'token', 'token'], 'no pool-market and no pool-metrics: neither is needed or listed');
  assert.deepEqual((await caseLog(page))[0].request, { poolIds: ['0x0911afcb281d7bcae2d71443ceaeebd0f89b4537708449970d797622b4b4c941'] });
  const cells = await page.locator('tbody [data-metric]').evaluateAll((els) => els.map((el) => [el.innerText, el.getAttribute('data-metric'), el.getAttribute('title')]));
  assert.deepEqual(cells.map(([text, state]) => [text, state]), [['$12.3K', 'provider'], ['$0.00', 'provider']]);
  for (const [, , title] of cells) assert.match(title, /^Reported by a market data provider, retrieved \d+ s ago\. Not reconciled by Domino\.$/);
  assert.doesNotMatch(await page.locator('tbody').innerText(), /snapshot|stored/i, 'where the row came from is data, never words');
  await openFigures(page);
  assert.equal((await caseLog(page)).filter((r) => r.route === 'pool-activity').length, 1, 'one pool-activity read, after the click');
  await quiet(page, errors);
  await page.close();
});

test('with markets-snapshot listed, a store served past its 300 s keeps the row in place while the pool’s own read replaces it', async () => {
  const { page, errors } = await openCase('figures.snapshotStale');
  await table(page);
  await page.locator('tbody tr[data-row-source="pool-market"]').waitFor();
  assert.deepEqual((await caseLog(page)).map((r) => r.route), ['markets-snapshot', 'token', 'token', 'pool-market']);
  assert.deepEqual((await caseLog(page)).at(-1).request, { poolId: '0x0911afcb281d7bcae2d71443ceaeebd0f89b4537708449970d797622b4b4c941', includePriceHistory: false });
  assert.equal(await page.locator('tbody tr').count(), 1, 'one row throughout');
  assert.doesNotMatch(await page.locator('tbody').innerText(), /snapshot|stored|stale/i);
  await quiet(page, errors);
  await page.close();
});

// --- the pool page in the fixture build (G1, G11, G14 and the clean states) -------------

test('the pool page reads its figures, Domino’s 24h history and its chain activity by itself, one after another, and shows no status, no retry, no footnote and no yellow', async () => {
  const { page, errors } = await tracked();
  const POOL = '0x0911afcb281d7bcae2d71443ceaeebd0f89b4537708449970d797622b4b4c941';
  await page.goto(`${origin}/#/pool/${POOL}/${TOKEN}`, { waitUntil: 'networkidle' });
  const workspace = page.locator(`[data-pool-workspace="${POOL}"]`);
  await workspace.waitFor({ timeout: 20_000 });
  // Changed on purpose (2026-09-27, round 6, the pool page for beginners): the activity figures, the pool's details and
  // the APR's method are parts of one closed Details card at the end of the page.
  await workspace.locator('[data-pool-details] > summary').click();
  await page.locator('[data-pool-activity="ok"]').waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => document.querySelector('[data-pool-figures] [data-metric="qualified"]'));
  const routes = await page.evaluate(() => (window.__DOMINO_FIXTURE_READS__ ?? []).map((r) => [r.route, r.request]));
  const pageReads = routes.slice(routes.findIndex(([route]) => route === 'pools'));
  assert.deepEqual(pageReads, [
    ['pools', { token: TOKEN, maxPools: 1, poolIds: [POOL] }],
    ['pool-market', { poolId: POOL, includePriceHistory: false }],
    ['pool-metrics', { poolId: POOL }],
    ['pool-activity', { poolId: POOL }],
  ], 'the fixture build lists pool-metrics and pool-activity; it lists no snapshot and no positions, so neither is read');

  const figures = workspace.locator('[data-pool-figures]');
  const stats = await figures.locator('dl > div').evaluateAll((divs) => divs.map((div) => [div.querySelector('dt').innerText.trim(), div.querySelector('dd').innerText.trim()]));
  // Changed on purpose (2026-09-27, round 6): what the pool earns first, then how busy and how big it is, then its
  // price; the fee is in the chip and the sentence under the name.
  assert.deepEqual(stats.map(([label]) => label), ['APR', '24H VOLUME', 'TVL', '24H FEES', 'PRICE'], 'Domino’s 24h fees beside the figures, and its APR where the estimate would be');
  // Changed on purpose 2026-10-01 (integration pass 3, after audit E21): the APR as the one APR rule writes it, whole from 100%.
  assert.deepEqual(stats.slice(0, 4).map(([, value]) => value), ['158%', '$0.000029', '$0.000020', '<$0.000001'], 'the qualified figures take precedence over the provider’s');
  assert.match(await figures.innerText(), /Domino history/);
  assert.equal(await workspace.locator('[data-pool-positions]').count(), 0, 'no positions section where pool-positions is not listed');

  // The activity card: turnover, LP fees and LP assets in each token's units; no USD and no APR in it.
  const activity = await page.locator('[data-activity-amounts]').evaluate((table) => Array.from(table.querySelectorAll('tr'), (tr) => Array.from(tr.children, (cell) => cell.textContent.trim())));
  // Changed on purpose 2026-10-01 (integration pass 3, after audit E7): an amount under a millionth of a token reads as one
  // (lib/read/screens/figures.ts DUST), its every digit kept for the cell's title.
  assert.deepEqual(activity, [['Figure', 'ETH', 'TOKEN'], ['Turnover (24h)', '0.0000289269', '1,635,670'], ['LP fees (24h)', '<0.000001', '300'], ['LP assets', '<0.000001', '20,025,853']]);
  assert.doesNotMatch(await page.locator('[data-pool-activity]').innerText(), /\$|APR/);

  // G14: the protocol fee per direction, and Domino's APR where the fixed "unavailable" line was.
  const details = workspace.locator('[data-pool-details]');
  assert.match(await details.locator('[data-protocol-fee]').innerText(), /Protocol fee\s+None/);
  // Changed on purpose 2026-10-01 (integration pass 3, after audit E21): the one APR rule, whole percents from 100%.
  assert.match(await details.locator('[data-history-apr]').innerText(), /Pool APR, Domino history\s+158%/);
  assert.equal(await details.locator('[data-apr-estimate]').getAttribute('data-apr-estimate'), 'unavailable');
  assert.equal(await details.locator('[data-apr-estimate] [data-apr-figure]').innerText(), '—', 'no estimate here: a neutral dash');
  assert.match(await details.locator('[data-apr-estimate] [data-apr-figure]').getAttribute('title'), /^Pool estimate, not position APR, APY or a return forecast\. Estimated APR is (not enabled on this connection|unavailable; market figures use the supported read connection)\.$/);

  // Clean: nothing on the page says how a read went, and nothing offers to read again.
  const main = await page.locator('main').innerText();
  assert.doesNotMatch(main, /Read activity|Read market data again|Verify again|Refresh price|Read again|Retry|One read, when you ask|coming later|isn’t available here|not enabled/i);
  assert.doesNotMatch(main, /Provider market observation|Retrieved \d\d:\d\d UTC|No USD volume or APR comes from this read/, 'no footnotes about sources');
  // Changed on purpose (qa:visual): no caption under the chart heading; who reports the candles is the plot's title and data.
  const chart = page.locator('[data-pool-chart]');
  assert.doesNotMatch(await chart.innerText(), /GeckoTerminal|market data provider|in US dollars/i, 'no caption under the chart heading');
  const plot = chart.locator('.dm-pool-plot');
  assert.deepEqual([await plot.getAttribute('data-chart-provider'), await plot.getAttribute('title')], ['GeckoTerminal', 'Hourly candles reported by a market data provider.']);
  for (const name of await page.locator('main button').allInnerTexts()) assert.doesNotMatch(name, /again|retry|refresh/i, name);
  assert.equal(await page.locator('main .dm-inset[role="status"]').count(), 0, 'no status panel');
  // The range slider's own handle ring is a design accent of the shared PriceSlider, not a state; everything the page reads is checked.
  for (const part of ['[data-pool-figures]', '[data-pool-activity]', '[data-pool-price-now]', '.dm-card:has([data-protocol-fee])']) assert.doesNotMatch(await page.locator(part).innerHTML(), /money-wait/, `no yellow in ${part}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `the pool page scrolls sideways by ${overflow}px`);
  await quiet(page, errors);
  await page.close();
});
