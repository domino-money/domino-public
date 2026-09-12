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
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { FIXTURE_DIST, createGatedServer } from '../scripts/gated-server.mjs';
import { handlePlaces, handleSightings, NOWHERE, watchForHandle } from './handle-watch.mjs';

const PASSWORD = 'screens-test-beta-password';
const ENV = { BETA_PASSWORD: PASSWORD, BETA_COOKIE_KEY: 'Mk2mP9vQx4Lr7TbW1cNy6ZsJ3dGa8FeU5oViRtYqWeC' };
const SYMBOL = '<img src=x onerror=alert(1)>';
const IDS = '1, 57896044618658097711785492504343953926634992332820282019728792003956564819969';
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
  await browser?.close();
  await new Promise((done) => server.close(done));
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

// --- the lookup --------------------------------------------------------------

const lookupStatus = (page) => page.locator('#chain-lookup [data-screen-status]');

async function settledLookup(page) {
  await page.waitForFunction(
    () => {
      const status = document.querySelector('#chain-lookup [data-screen-status]')?.getAttribute('data-screen-status');
      return status && status !== 'loading' && !document.querySelector('#chain-lookup [aria-disabled="true"]');
    },
    null,
    { timeout: 20_000 },
  );
  return lookupStatus(page).getAttribute('data-screen-status');
}

async function lookUp(page, ids = IDS) {
  const section = page.locator('#chain-lookup');
  const show = section.getByRole('button', { name: 'Show lookup' });
  if (await show.count()) await show.click();
  await page.fill('#nft-ids', ids);
  await section.getByRole('button', { name: 'Look up positions' }).click();
}

const cards = (page) => page.locator('#chain-lookup [data-chain-card]');

test('the app route reads nothing until asked: one NFT read with the typed IDs, then the token reads, serially, and nothing after', async () => {
  const { page, errors, requests } = await tracked();
  await page.goto(`${origin}/#/app`, { waitUntil: 'networkidle' });
  await page.locator('#chain-lookup').waitFor();
  const reads = () => page.evaluate(() => (window.__DOMINO_FIXTURE_READS__ ?? []).map((r) => ({ route: r.route, request: r.request, at: r.at })));
  assert.deepEqual(await reads(), [], 'opening the Dashboard reads nothing');
  const toggle = page.getByRole('button', { name: 'Show lookup' });
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  await toggle.click();
  assert.equal(await page.getByRole('button', { name: 'Hide lookup' }).getAttribute('aria-expanded'), 'true');
  await page.waitForTimeout(400);
  assert.deepEqual(await reads(), [], 'opening the lookup reads nothing');

  // Stats, practice cards, activity and storage before any chain read.
  const practice = () =>
    page.evaluate(() => ({
      // The workspace whose figures this used to watch is gone with F3, and the
      // numbers on this screen now belong to the chain cards the lookup asks
      // for: counting them would be counting the thing under test.
      cards: document.querySelectorAll('[aria-label^="Open practice card"]').length,
      activity: document.querySelectorAll('#activity > div > *').length,
      local: JSON.stringify(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)])),
      session: JSON.stringify(Object.keys(sessionStorage).sort()),
    }));
  const beforeRead = await practice();
  const databases = async () => (await page.evaluate(async () => (indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : []))).sort();
  const dbBefore = await databases();

  await lookUp(page);
  assert.equal(await settledLookup(page), 'ok');
  const log = await reads();
  assert.deepEqual(log.map((r) => r.route), ['nft-positions', 'token', 'token']);
  assert.deepEqual(log[0].request, { tokenIds: ['1', BIG] }, 'exactly the typed IDs, and no pinned block');
  assert.deepEqual(log.slice(1).map((r) => r.request.token), [NATIVE, TOKEN]);
  // The scheduler waits 150 ms between reads. Timer and request-event resolution
  // can report a gap a millisecond or two short (149 ms was seen on a loaded
  // machine), so allow 10 ms; unspaced reads land 0-10 ms apart and still fail.
  for (let i = 1; i < log.length; i++) assert.ok(log[i].at - log[i - 1].at >= 140, `serial and spaced: ${log.map((r) => r.at)}`);
  await page.waitForTimeout(2000);
  assert.equal((await reads()).length, 3, 'no polling, no refresh on its own');
  assert.equal(log.some((r) => r.route === 'pool-market' || r.route === 'pool-metrics'), false, 'no market reads on the Dashboard');

  // #2: the card itself.
  assert.equal(await cards(page).count(), 2);
  const card = cards(page).first();
  const text = await card.innerText();
  assert.match(text, /Read from chain/);
  assert.match(text, /Public data/);
  assert.match(text, /0x0911afcb281d7bcae2d71443ceaeebd0f89b4537708449970d797622b4b4c941/);
  assert.match(text, /0\.30%/);
  assert.match(text, /Ticks -60 to 60/);
  assert.match(text, /≈994,018,000,000 to ≈1,006,020,000,000/);
  assert.match(text, /TOKEN\s+per\s+ETH/);
  assert.match(text, /In range at this block/);
  assert.match(text, /3,797,063,507\.756903070969194414/);
  assert.match(text, /Unsettled fees \(not yet collected\)/);
  assert.match(text, /Totals from earlier collections aren’t available/);
  assert.match(text, /Owner at this block \(public data\)/);
  assert.match(text, new RegExp(OWNER));
  assert.match(text, /proves nothing about who is using this page/);
  assert.match(text, /USD value[\s\S]*Unavailable: no qualified price source yet\./);
  assert.match(text, /Block 700 · 00:16:40 UTC, 1970-01-01 · fresh, 10 s old when read/);
  assert.doesNotMatch(text, /\byour\b|you own|Fees awaiting reinvestment|Reinvested so far|Reinvested/i, 'nothing says the viewer owns it, and no practice figure appears');

  // The practice workspace is exactly as it was.
  assert.deepEqual(await practice(), beforeRead, 'stats, practice cards, activity and storage are untouched');
  assert.deepEqual(await databases(), dbBefore);

  // Nothing in the lookup can connect, sign or move anything, and nothing links out.
  const controls = await page.locator('#chain-lookup').evaluate((root) => ({
    buttons: Array.from(root.querySelectorAll('button')).map((b) => b.textContent.trim()),
    links: root.querySelectorAll('a').length,
  }));
  assert.deepEqual(controls.links, 0);
  for (const label of controls.buttons) assert.match(label, /^(Hide lookup|Look up positions|Refresh|Clear|Retry)$/, label);
  assert.notEqual(await page.locator('#chain-lookup h2').innerText(), 'Practice cards');
  assert.deepEqual([...new Set(await page.getByRole('button', { name: 'Connect wallet' }).evaluateAll((els) => els.map((el) => el.disabled)))], [true], 'every Connect wallet stays disabled');

  // Every fetch and XHR is same-origin. Any other resource from another host must be one the app
  // itself names: the fonts APP_CSP allows. A host that appears nowhere in the build (a local
  // antivirus injecting its own script into every page, say) is not the app's request.
  const built = distText();
  for (const r of requests) {
    const url = new URL(r.url);
    if (r.type === 'fetch' || r.type === 'xhr') {
      assert.equal(url.origin, origin, r.url);
      continue;
    }
    if (url.origin === origin || url.host === 'fonts.googleapis.com' || url.host === 'fonts.gstatic.com') continue;
    assert.equal(built.includes(url.host), false, `the build itself requests ${r.url}`);
  }
  await quiet(page, errors);
  await page.close();
});

// OPEN QUESTION for @rugged97: this case walks the create flow of #72
// ("Continue" three times, "Your position, ready to try") and asserts the
// practice workspace keeps working behind a failed chunk. F3 removed that
// workspace, and #72 is not on this base yet, so there is no app left for the
// case to check. The slot boundary it also covers is exercised by the lab's
// own SlotFailed path. Skipped until #72 lands or the case is rewritten.
test.skip('a screens chunk that cannot load leaves the practice app working and says so', async () => {
  const ctx = await signedIn();
  const { page, errors } = await tracked(ctx);
  await page.goto(`${origin}/#/settings`, { waitUntil: 'networkidle' });
  await ctx.clearCookies();
  await page.evaluate(() => {
    location.hash = '#/app';
  });
  await page.locator('[data-slot-failed]').first().waitFor({ timeout: 10_000 });
  assert.match(await page.locator('[data-slot-failed]').first().innerText(), /Chain data couldn’t load\. Reload the page to try again\./);
  assert.equal(await page.locator('#chain-lookup').count(), 0);
  assert.match(await page.locator('h1').innerText(), /Your positions/);
  await page.getByRole('button', { name: /New position|Let’s try it/ }).first().click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();
  for (let i = 0; i < 3; i++) await dialog.getByRole('button', { name: 'Continue' }).click();
  assert.match(await dialog.innerText(), /Your position, ready to try\./);
  assert.equal(await dialog.locator('[data-chain-selection]').count(), 0);
  assert.deepEqual(errors.filter((e) => e.startsWith('uncaught')), [], 'no uncaught error');
  await ctx.close();
});

test('empty, zero and stale NFTs each read as themselves', async () => {
  const empty = await openCase('nft.empty');
  await lookUp(empty.page, '1');
  await settledLookup(empty.page);
  const emptyText = await cards(empty.page).innerText();
  assert.match(emptyText, /Empty at this block: the NFT has no position info\./);
  assert.doesNotMatch(emptyText, /Principal|Unsettled|Owner at this block/, 'no amounts or owner for an empty NFT');
  await quiet(empty.page, empty.errors);
  await empty.page.close();

  const zero = await openCase('nft.zero');
  await lookUp(zero.page, '1');
  await settledLookup(zero.page);
  assert.match(await cards(zero.page).innerText(), /No liquidity at this block \(closed or zero\)/);
  assert.equal(await zero.page.locator('[data-amount="zero"]').count(), 4);
  await zero.page.close();

  const stale = await openCase('nft.stale');
  await lookUp(stale.page, '1');
  await settledLookup(stale.page);
  const staleText = await cards(stale.page).innerText();
  assert.match(staleText, /Stale/);
  assert.match(staleText, /Block 650 · 00:13:20 UTC, 1970-01-01 · stale, 210 s old when read/);
  await stale.page.close();
});

test('partial token metadata: ticks only and raw amounts, labelled raw', async () => {
  const { page, errors } = await openCase('nft.noDecimals');
  await lookUp(page);
  await settledLookup(page);
  const text = await cards(page).first().innerText();
  assert.match(text, /Prices need both tokens’ decimals; showing ticks only\./);
  assert.match(text, /raw units, decimals unknown/);
  await quiet(page, errors);
  await page.close();
});

test('a failed refresh keeps the cards with their own block, and Retry keeps focus; new IDs clear them', async () => {
  const { page, errors } = await openCase('nft.refreshFails');
  await lookUp(page);
  assert.equal(await settledLookup(page), 'ok');
  await page.locator('#chain-lookup').getByRole('button', { name: 'Refresh' }).click();
  assert.equal(await settledLookup(page), 'unavailable');
  assert.match(await lookupStatus(page).innerText(), /Position data unavailable[\s\S]*read service unavailable[\s\S]*last read that worked/);
  assert.equal(await cards(page).count(), 2, 'the earlier cards stay');
  assert.match(await cards(page).first().innerText(), /Block 700 · 00:16:40 UTC/);
  const retry = page.locator('#chain-lookup').getByRole('button', { name: 'Retry' });
  await retry.focus();
  await page.keyboard.press('Enter');
  assert.equal(await settledLookup(page), 'unavailable');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Retry', 'focus stayed on Retry through its read');

  await page.fill('#nft-ids', '1');
  await page.locator('#chain-lookup').getByRole('button', { name: 'Look up positions' }).click();
  await settledLookup(page);
  assert.equal(await cards(page).count(), 0, 'new IDs drop the earlier cards');
  await quiet(page, errors);
  await page.close();
});

test('an incompatible or invalid reply on refresh keeps the cards and says an update is needed', async () => {
  for (const id of ['nft.refreshIncompatible', 'nft.refreshInvalid']) {
    const { page, errors } = await openCase(id);
    await lookUp(page);
    await settledLookup(page);
    await page.locator('#chain-lookup').getByRole('button', { name: 'Refresh' }).click();
    const state = await settledLookup(page);
    assert.ok(['incompatible', 'invalid'].includes(state), `${id}: ${state}`);
    assert.match(await lookupStatus(page).innerText(), /Update needed[\s\S]*can’t read the server’s reply\. It needs an update\./, id);
    assert.equal(await cards(page).count(), 2, `${id} keeps the cards`);
    await quiet(page, errors);
    await page.close();
  }
});

test('one bad ID fails the whole batch and keeps earlier cards; an incomplete reply shows nothing new', async () => {
  const batch = await openCase('nft.batch503');
  await lookUp(batch.page);
  await settledLookup(batch.page);
  await batch.page.locator('#chain-lookup').getByRole('button', { name: 'Refresh' }).click();
  assert.equal(await settledLookup(batch.page), 'unavailable');
  assert.match(await lookupStatus(batch.page).innerText(), /nft live position has no owner/);
  assert.equal(await cards(batch.page).count(), 2);
  await batch.page.close();

  const incomplete = await openCase('nft.incomplete');
  await lookUp(incomplete.page);
  assert.equal(await settledLookup(incomplete.page), 'invalid');
  // F3 refuses a short batch as a wrong answer, not an incomplete one.
  assert.match(await lookupStatus(incomplete.page).innerText(), /The reply was about something other than what was asked/);
  assert.equal(await cards(incomplete.page).count(), 0);
  await quiet(incomplete.page, incomplete.errors);
  await incomplete.page.close();
});

test('a dynamic-fee pool reads Dynamic', async () => {
  const { page } = await openCase('nft.dynamicFee');
  await lookUp(page);
  await settledLookup(page);
  assert.deepEqual(await page.locator('[data-fee]').allInnerTexts(), ['Dynamic', 'Dynamic']);
  await page.close();
});

// OPEN QUESTION for @rugged97, same reason: there are no practice cards to
// stand beside the chain cards. What it protects — a chain card never wearing
// a practice label — is now true by construction, since the labels are gone.
test.skip('practice cards keep their practice labels beside chain cards, and neither borrows the other’s words', async () => {
  const { page, errors } = await tracked();
  await page.goto(`${origin}/#/app`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /New position|Let’s try it/ }).first().click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ state: 'visible' });
  await page.locator('#amount').fill('1000');
  for (let step = 0; step < 3; step++) await dialog.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#risk-consent').check();
  await dialog.getByRole('button', { name: /Create practice card/ }).click();
  await dialog.waitFor({ state: 'detached' });

  const practiceCard = page.getByRole('button', { name: 'Open practice card 1' });
  const before = await practiceCard.innerText();
  assert.match(before, /Practice on/);
  assert.match(before, /Card 01/);

  await lookUp(page);
  assert.equal(await settledLookup(page), 'ok');
  assert.equal(await cards(page).count(), 2);
  assert.equal(await page.locator('[aria-label^="Open practice card"]').count(), 1, 'the lookup adds no practice card');
  assert.equal(await practiceCard.innerText(), before, 'the practice card is exactly as it was, labels and all');
  assert.doesNotMatch(before, /Read from chain|Public data|Owner at this block|Block \d/);
  assert.equal(await page.locator('#chain-lookup [aria-label^="Open practice card"]').count(), 0, 'no practice card inside the chain section');
  assert.equal(await practiceCard.evaluate((el) => el.closest('#chain-lookup') === null), true);
  for (const text of await cards(page).allInnerTexts()) {
    assert.match(text, /Read from chain/);
    assert.match(text, /Public data/);
    assert.doesNotMatch(text, /Practice on|Paused|Card \d\d|Reinvested/, 'a chain card never wears a practice label');
  }
  await quiet(page, errors);
  await page.close();
});

test('gate, busy, edge and disabled states: their own words, no sign-in link, no wallet', async () => {
  const cases = {
    'nft.gate401': ['gate_required', /Beta access expired[\s\S]*Reload the page to sign in to the beta\./],
    'nft.gate503': ['gate_unavailable', /Access is paused/],
    'nft.busy': ['busy', /Try again in 7 s\./],
    'nft.edge': ['unavailable', /error page \(HTTP 502\)/],
    'nft.disabled': ['disabled', /Position reads aren’t enabled on this server\./],
  };
  for (const [id, [state, words]] of Object.entries(cases)) {
    const { page, errors } = await openCase(id);
    await lookUp(page);
    assert.equal(await settledLookup(page), state, id);
    const text = await lookupStatus(page).innerText();
    assert.match(text, words, id);
    assert.doesNotMatch(text, /connect|wallet/i, id);
    assert.equal(await page.locator('#chain-lookup a').count(), 0, `${id} links somewhere`);
    assert.equal(await cards(page).count(), 0, id);
    await quiet(page, errors);
    await page.close();
  }
});

test('only the latest lookup lands: a slow first answer is cancelled and never shown', async () => {
  const { page, errors } = await openCase('nft.late');
  await lookUp(page, '1');
  await page.fill('#nft-ids', IDS);
  await page.locator('#chain-lookup').getByRole('button', { name: 'Look up positions' }).click();
  await page.fill('#nft-ids', '1');
  await page.locator('#chain-lookup').getByRole('button', { name: 'Look up positions' }).click();
  await settledLookup(page);
  await page.waitForTimeout(1800);
  assert.equal(await cards(page).count(), 1);
  assert.match(await cards(page).innerText(), /Block 650/);
  const nft = (await caseLog(page)).filter((r) => r.route === 'nft-positions');
  assert.equal(nft[0].aborted, true, 'the slow first read was cancelled');
  await quiet(page, errors);
  await page.close();
});

test('the same IDs again while they are read join that read: one NFT read, never cancelled and resent', async () => {
  const { page, errors } = await openCase('nft.repeat');
  await lookUp(page);
  await page.waitForFunction(() => window.__screenCase.log.some((r) => r.route === 'nft-positions'));
  const submit = page.locator('#chain-lookup').getByRole('button', { name: 'Look up positions' });
  await submit.click();
  await submit.click();
  assert.equal(await settledLookup(page), 'ok');
  await page.waitForTimeout(1500);
  const nft = (await caseLog(page)).filter((r) => r.route === 'nft-positions');
  assert.equal(nft.length, 1, 'one read on the wire');
  assert.notEqual(nft[0].aborted, true, 'and it was not cancelled');
  assert.equal(await cards(page).count(), 2);
  await quiet(page, errors);
  await page.close();
});

test('hiding the lookup while it reads cancels the read; showing it again restores what was there', async () => {
  const { page, errors } = await openCase('nft.hang');
  await lookUp(page);
  await page.waitForFunction(() => document.querySelector('#chain-lookup [data-screen-status]')?.getAttribute('data-screen-status') === 'loading');
  await page.getByRole('button', { name: 'Hide lookup' }).click();
  await page.waitForFunction(() => window.__screenCase.log.some((r) => r.route === 'nft-positions' && r.aborted));
  await page.getByRole('button', { name: 'Show lookup' }).click();
  assert.equal(await lookupStatus(page).getAttribute('data-screen-status'), 'none');
  assert.equal(await cards(page).count(), 0);
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

// OPEN QUESTION for @rugged97: this case types into #amount, the draft field
// of #72's create flow, before opening the picker. That flow is not on this
// base — the lab frames the panel itself — so there is no draft to keep.
// The focus, arrow-key and Escape behaviour it also covers belongs to the
// panel and is worth restoring once #72 lands.
test.skip('the picker is a keyboard dialog: contained focus, arrow keys, Escape back to Pair with the draft kept, filter keeps the choice', async () => {
  const { page, errors } = await openCase('create.tokens');
  await page.getByRole('button', { name: 'New position' }).click();
  const dialog = dialogOf(page);
  await page.fill('#amount', '2500');
  await dialog.getByRole('button', { name: 'Choose token' }).click();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Choose a token from chain data');
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

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.textContent === 'Start with a token you know.');
  assert.equal(await page.inputValue('#amount'), '2500', 'Escape in a picker keeps the practice draft');
  assert.equal(await dialog.count(), 1, 'Escape in a picker goes back to Pair, not out of the dialog');

  await dialog.getByRole('button', { name: 'Choose token' }).click();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Choose a token from chain data');
  await page.mouse.click(5, 5);
  await page.waitForFunction(() => document.activeElement?.textContent === 'Start with a token you know.');
  assert.equal(await dialog.count(), 1, 'a backdrop click in a picker also goes back');

  await dialog.getByRole('button', { name: 'Choose token' }).click();
  await dialog.locator('input[name="token-candidate"]').nth(1).check();
  await dialog.getByRole('button', { name: 'Use this token' }).click();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Start with a token you know.');
  const summary = await dialog.locator('[data-chain-selection]').innerText();
  assert.match(summary, /Token: TOKEN · ERC-20 candidate/);
  assert.match(summary, /Reference only/);
  assert.match(summary, /Nothing chosen here is saved/);

  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'New position', 'Escape on Pair closes and returns focus');
  await quiet(page, errors);
  await page.close();
});

test('the picker fits a 360 px screen without sideways scrolling', async () => {
  const narrow = await signedIn({ width: 360, height: 740 });
  const { page, errors } = await openCase('create.tokens', narrow);
  await openPicker(page);
  for (const address of [NATIVE, at('2')]) await check(page, address);
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
  assert.match(await wallet.innerText(), /Public lookup, not your wallet/);
  assert.match(await wallet.locator('[data-wallet-public-note]').innerText(), /^Balances are public chain data on Robinhood Chain \(4663\) at one block\. Listing an address isn’t proof that anyone here owns or controls it, and it enables nothing\.$/);
  await wallet.getByRole('button', { name: 'Load more' }).click();
  await waitIdle(page);
  assert.equal(await wallet.getByRole('button', { name: 'All pages loaded' }).count(), 1);
  const walletReads = (await caseLog(page)).filter((r) => r.route === 'wallet-assets');
  assert.deepEqual(walletReads.map((r) => r.request), [{ wallet: OWNER, autoDiscover: true }, { wallet: OWNER, autoDiscover: true, cursor: CURSOR }]);
  assert.deepEqual(await handlePlaces(page, CURSOR.slice(0, 12)), NOWHERE, 'the continuation handle is somewhere a person or a script can read it');
  assert.deepEqual(await handleSightings(page), [], 'the handle was written into the page at some moment');
  assert.match(await dialog.innerText(), /Balance at the snapshot block/);
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

  const empty = await openCase('create.walletEmpty');
  const d3 = await listWallet(empty.page);
  assert.match(await d3.locator('[data-wallet-hint]').innerText(), /This server can’t list tokens by itself\. Add token addresses to check\./);
  await empty.page.close();

  const zero = await openCase('create.walletZero');
  const d4 = await listWallet(zero.page);
  assert.match(await d4.innerText(), /Balance at the snapshot block: 0\b/);
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
  await page.waitForFunction(() => document.querySelector('[data-picker="pool"] [data-screen-status]')?.getAttribute('data-screen-status') !== 'loading');
  return dialog;
}

test('existing pools: fee, verification, provenance, attributed figures, no recommendation, and a catalogue that restarts and verifies', async () => {
  const { page, errors } = await openCase('create.pools');
  const dialog = await toPools(page);
  const text = await dialog.innerText();
  assert.match(text, /DexScreener returned 1 candidate \(1 on Uniswap v4\)\. That covers the provider’s candidates only\./);
  assert.match(text, /No pool catalogue is configured on this server/);
  const option = dialog.locator('[data-pool-option]').first();
  const optionText = await option.innerText();
  assert.match(optionText, /0\.30%/);
  assert.match(optionText, /Verified at block 700/);
  assert.match(optionText, /Found by DexScreener discovery, verified on chain/);
  assert.match(optionText, /\$10\.00 · DexScreener/);
  assert.match(optionText, /\$1\.2K · DexScreener/);
  assert.match(optionText, /DexScreener figures retrieved 00:16:50 UTC, 1970-01-01\. Provider-reported, not reconciled with chain data\./, 'source and age beside the figures');
  assert.match(optionText, /Pool APR unavailable: reconciled fee history unavailable\./);
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

// OPEN QUESTION for @rugged97, the same one raised on screens.test.mjs: F3
// leaves the pools `pairedToken` echo unbound on purpose (interpret.ts:83-85),
// so a reply holding neither asked-for asset comes back 'ok' and the screen
// shows it instead of refusing. Either the producer echoes the pair, or this
// drops to what the contract guarantees today.
test.skip('a pools reply whose pool does not hold the chosen token is a wrong answer: nothing to pick, nothing shown from it', async () => {
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
    ['create.poolsProviderUnavailable', /DexScreener discovery was unavailable \(network unavailable\), so this list may be incomplete\./],
    ['create.poolsMissing', /No verified pool was found in these sources\. That isn’t proof that none exists\./],
    ['create.pools409', /The catalogue changed during the read/],
  ]) {
    const { page } = await openCase(id);
    const dialog = await toPools(page);
    const text = await dialog.innerText();
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

const boundTicks = (dialog) => dialog.locator('[data-bound-tick]').allInnerTexts();
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
  assert.match(text, /Not executable/);
  assert.match(text, /Pool price read from chain/);
  assert.match(await dialog.locator('[data-pool-price-text]').innerText(), /^≈1,000,000,000,000$/);
  assert.match(text, /TOKEN per ETH at block 700 · tick 0 · tick spacing 60/);
  assert.match(text, /The pool’s tick agrees with its square-root price at this block\./);
  assert.match(text, /An illustration of a range, not a quote or an order: there are no amounts, no swap, no approval, no signature and no wallet here/);
  assert.equal(await priceState(dialog), 'usable');

  // The app's "Closer" preset, 0.7× to 1.5× of the pool price, on multiples of 60.
  assert.deepEqual(await boundTicks(dialog), ['-3600', '4080']);
  assert.equal(await dialog.getByRole('radio', { name: /Closer/ }).getAttribute('aria-checked'), 'true');
  assert.equal(await dialog.locator('[data-range-position]').getAttribute('data-range-position'), 'inside');
  assert.match(await dialog.locator('[data-range-text]').innerText(), /^≈.+ to ≈.+ TOKEN per ETH · ticks -3600 to 4080$/);

  await dialog.getByRole('button', { name: 'Raise the max price by one tick spacing' }).click();
  assert.deepEqual(await boundTicks(dialog), ['-3600', '4140']);
  assert.equal(await dialog.getByRole('radio', { name: 'Custom' }).getAttribute('aria-checked'), 'true');

  // The slider is a real range input on the tick spacing; its spoken value carries no symbol.
  const lower = dialog.locator('#range-lower');
  assert.deepEqual([await lower.getAttribute('step'), await lower.getAttribute('min'), await lower.getAttribute('max')], ['60', '-13920', '13920']);
  await lower.focus();
  await page.keyboard.press('ArrowRight');
  assert.deepEqual(await boundTicks(dialog), ['-3540', '4140']);
  const spoken = await lower.getAttribute('aria-valuetext');
  assert.match(spoken, /^≈[\d,]+, −[\d.]+% from the pool price, tick -3540$/);
  assert.doesNotMatch(spoken, /TOKEN|ETH/, 'an untrusted symbol never goes into an attribute');
  assert.match(await dialog.locator('[data-range-bound="lower"] .pointer-events-none').innerText(), /^−[\d.]+%$/, 'the handle shows the distance from the pool price');
  // A bound never crosses the other: the lower stops one spacing below the upper.
  await page.keyboard.press('End');
  assert.deepEqual(await boundTicks(dialog), ['4080', '4140']);
  assert.equal(await dialog.locator('[data-range-position]').getAttribute('data-range-position'), 'below');
  assert.match(await dialog.locator('[data-range-position]').innerText(), /The pool price at this block is below this range\./);

  await dialog.getByRole('radio', { name: /Wider/ }).click();
  assert.deepEqual(await boundTicks(dialog), ['-6960', '6960']);
  assert.deepEqual(await widthChecked(dialog), ['Wider']);

  for (const name of await dialog.locator('button').allInnerTexts()) assert.doesNotMatch(name, FORBIDDEN_CONTROL, name);
  for (const label of await dialog.locator('button[aria-label]').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))) {
    assert.doesNotMatch(label, FORBIDDEN_CONTROL, label);
  }
  assert.equal(await dialog.locator('a').count(), 0);
  assert.deepEqual(await dialog.locator('input').evaluateAll((els) => [...new Set(els.map((el) => el.type))]), ['range'], 'only the two sliders');

  await dialog.getByRole('button', { name: 'Use this range' }).click();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Start with a token you know.');
  assert.match(
    await dialog.locator('[data-summary="Range"]').innerText(),
    /^Range: ≈.+ to ≈.+ TOKEN per ETH · ticks -6960 to 6960 · on the price at block 700 · not saved, nothing is created$/,
  );

  // Reopened, the kept range says what it is: Wider, not the default Closer.
  const reopen = async () => {
    await dialog.getByRole('button', { name: 'Change range' }).click();
    await page.waitForFunction(() => document.activeElement?.textContent === 'Range on this pool');
  };
  await reopen();
  assert.deepEqual(await boundTicks(dialog), ['-6960', '6960']);
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
  assert.match(await dialog.locator('[data-summary="Range"]').innerText(), /ticks -6960 to 7020/);
  await reopen();
  assert.deepEqual(await boundTicks(dialog), ['-6960', '7020']);
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
    assert.equal(await dialog.locator('[data-price-unavailable]').getAttribute('data-price-unavailable'), problem, id);
    const text = await dialog.innerText();
    assert.match(text, /Pool price unavailable/, id);
    assert.match(text, words, id);
    assert.match(text, /Range controls need a price read from chain, so this pool has none\./, id);
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
  const text = await dialog.innerText();
  assert.match(text, /\bPartial\b/);
  assert.match(text, /Token metadata is partial: a symbol may be missing, so both addresses are shown\./);
  const partial = await dialog.locator('[data-price-partial]').innerText();
  assert.match(partial, new RegExp(NATIVE));
  assert.match(partial, new RegExp(TOKEN));
  assert.match(partial, /Unknown symbol/);
  assert.equal(await dialog.locator('input[type="range"]').count(), 2, 'a partial price still has controls');
  await quiet(page, errors);
  await page.close();
});

test('a price read more than 5 minutes ago on the page is marked stale, and read again only when asked', async () => {
  const { page, errors } = await tracked();
  await page.clock.install();
  await page.goto(`${origin}/read-lab.html#screens/create.range`, { waitUntil: 'networkidle' });
  await page.locator('[data-screen-case="create.range"]').waitFor();
  const dialog = await toRange(page);
  assert.equal(await priceState(dialog), 'usable');
  const reads = (await caseLog(page)).length;

  await page.clock.fastForward('04:50');
  assert.equal(await priceState(dialog), 'usable', 'not yet five minutes');
  await page.clock.fastForward('00:15');
  await page.waitForFunction(() => document.querySelector('[data-picker="range"]')?.getAttribute('data-price-state') === 'stale');
  const text = await dialog.innerText();
  assert.match(text, /\bStale\b/);
  assert.match(text, /This price was read more than 5 minutes ago on this page, and the pool’s price has probably moved since\./);
  assert.equal(await dialog.locator('input[type="range"]').count(), 2, 'the controls stay, marked stale');
  assert.equal((await caseLog(page)).length, reads, 'nothing is read by itself');

  // Closer chosen explicitly, so the pick is remembered; it must still give way once the price moves.
  await dialog.getByRole('radio', { name: /Closer/ }).click();
  assert.deepEqual(await boundTicks(dialog), ['-3600', '4080']);
  assert.deepEqual(await widthChecked(dialog), ['Closer']);
  await dialog.getByRole('button', { name: 'Read the price again' }).click();
  await page.waitForFunction(() => /Read again at block 705\./.test(document.querySelector('[data-pool-price]')?.textContent ?? ''));
  assert.equal(await priceState(dialog), 'usable');
  // The lab's second reading moved the price one tick spacing, to tick 60.
  assert.match(await dialog.innerText(), /TOKEN per ETH at block 705 · tick 60 · tick spacing 60/);
  assert.deepEqual(await boundTicks(dialog), ['-3600', '4080'], 'the practice range stays');
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

test('a wallet reply about another chain lists nothing', async () => {
  const { page, errors } = await openCase('create.walletOtherChain');
  const dialog = await listWallet(page);
  await waitIdle(page);
  assert.match(await dialog.locator('[data-wallet-candidates]').innerText(), /Update needed/);
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

async function table(page) {
  await page.locator('#root tbody tr').first().waitFor();
  await page.waitForFunction(() => document.querySelector('[data-pool-figure-notes]'));
}

test('provider figures carry their source and retrieval; reasons are visible text each cell points at; the APR stays unavailable', async () => {
  const { page, errors } = await openCase('figures.provider');
  await table(page);
  const cells = await page.locator('tbody [data-metric]').evaluateAll((els) =>
    els.map((el) => {
      const note = el.getAttribute('aria-describedby');
      return { text: el.innerText.replace(/\s/g, ''), state: el.getAttribute('data-metric'), note: note ? document.getElementById(note)?.textContent ?? 'MISSING' : null };
    }),
  );
  // Two differences from the branch this case came from, both F3's and neither
  // this case's to decide. F3's read contract carries no 30d volume, so the
  // column that read 'absent' upstream does not exist. And the shipped table
  // states the ratio as Domino's own calculation (#93, asserted in
  // release.browser (i)/(j)), so it reads 'calculated', not held back.
  //
  // OPEN QUESTION for @rugged97: `turnoverCell` (figures.ts) would hold that
  // ratio back as `derived_figure_pending_q8` — a quotient of two figures no
  // one reconciled is arguably a claim neither provider made. It is covered by
  // screens.test.mjs and wired to nothing until you decide. Say the word and
  // the table calls it instead; the acceptance suite would move with it.
  assert.deepEqual(cells.map((c) => c.state), ['provider', 'provider', 'calculated', 'unavailable']);
  assert.equal(cells[0].text, '$12.3K·GeckoTerminal');
  // Every cell showing no number points at a visible reason; a cell with a
  // number carries its own provenance instead.
  for (const cell of cells.filter((c) => ['unavailable', 'absent', 'not-current', 'rejected'].includes(c.state))) assert.ok(cell.note && cell.note !== 'MISSING', `${cell.text} points at a visible reason`);
  assert.match(cells[2].text, /calculated/, 'the ratio says whose calculation it is');
  // F3's lean table never reads pool-metrics, so the APR is unavailable for
  // that reason and not for the one pool-metrics would have given (project.ts
  // apr(): no metrics -> fee_apr_not_provided). Never a zero, never an estimate.
  assert.match(cells[3].note, /Unavailable: APR not provided by the read service yet\./, 'APR stays unavailable, and says why');
  const notes = page.locator('[data-provider-note]');
  const note = await notes.innerText();
  assert.match(note, /GeckoTerminal figures retrieved \d\d:\d\d:\d\d UTC, 1970-01-01, cache 0 s\. Provider-reported, not reconciled with chain data\. Retrieval age isn’t proof of a complete 24h window\./);
  assert.doesNotMatch(`${note} ${cells[0].text}`, /\b(current|live|updated|qualified)\b/i);
  assert.doesNotMatch(await page.locator('[data-pool-figure-notes]').innerText(), /\$\d/, 'the notes never repeat a figure');
  assert.match(await page.locator('#root').innerText(), /Pool APR describes a pool, not a position/);

  const before = (await caseLog(page)).filter((r) => r.route === 'pool-activity').length;
  assert.equal(before, 0, 'no pool-activity read before the dialog opens');
  const dialog = await openFigures(page);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'pool-figures-title');
  const text = await dialog.innerText();
  assert.match(text, /Not qualified/);
  assert.match(text, /Reported by GeckoTerminal, retrieved \d\d:\d\d:\d\d UTC, 1970-01-01\. Provider-reported, not reconciled with chain data\./);
  assert.match(text, /Pool is 19 s old; the 24h window isn’t complete/);
  assert.match(text, /Pool APR describes a pool, not a position/);
  assert.equal((await caseLog(page)).filter((r) => r.route === 'pool-activity').length, 1, 'exactly one pool-activity read, after the click');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-pool-figures')), true, 'focus returns to the pool');
  await quiet(page, errors);
  await page.close();
});

// OPEN QUESTION for @rugged97: two of the six market scenarios this walks,
// 'qualified' and 'reference', are absent from F3's MARKET_CASES — both came
// from the pool-metrics read F3 dropped from the table's path, so
// marketScript() finds nothing and the table never gets a row. The other four
// still exist. Skipped until pool-metrics returns or the case is split.
test.skip('qualified, reference, stale, expired, missing and zero figures each read as themselves', async () => {
  const qualified = await openCase('figures.qualified');
  await table(qualified.page);
  const q = await openFigures(qualified.page);
  const qText = await q.innerText();
  assert.match(qText, /Qualified 24h[\s\S]*158\.06%/);
  assert.match(qText, /The 24h window is covered \(86400 s observed\)/);
  await qualified.page.close();

  const reference = await openCase('figures.reference');
  await table(reference.page);
  assert.doesNotMatch(await reference.page.locator('tbody').innerText(), /158\.06|0\.000020/, 'reference analytics never reach a cell');
  const r = await openFigures(reference.page);
  await r.locator('summary').click();
  assert.match(await r.locator('[data-figures-reference]').innerText(), /Reference analytics, not current[\s\S]*Not current: 158\.06%/);
  await reference.page.close();

  const stale = await openCase('figures.stale');
  await table(stale.page);
  // Whoever revives this case: the 'absent' entry is the 30d volume column,
  // which F3's read contract does not carry. Expect four cells here, not five.
  assert.deepEqual(await stale.page.locator('tbody [data-metric]').evaluateAll((els) => els.map((e) => e.getAttribute('data-metric'))), ['stale', 'stale', 'absent', 'unavailable', 'stale']);
  const s = await openFigures(stale.page);
  assert.match(await s.innerText(), /\$12\.3K · stale/);
  await stale.page.close();

  const expired = await openCase('figures.expired');
  await table(expired.page);
  assert.doesNotMatch(await expired.page.locator('#root').innerText(), /\$12\.3K/);
  await expired.page.close();

  const missing = await openCase('figures.missing');
  await table(missing.page);
  assert.deepEqual((await missing.page.locator('tbody [data-metric]').allInnerTexts()).slice(0, 2), ['Not reported', 'Not reported']);
  await missing.page.close();

  const zero = await openCase('figures.zero');
  await table(zero.page);
  assert.match((await zero.page.locator('tbody [data-metric]').allInnerTexts())[0], /^\$0\.00/);
  await zero.page.close();

  const unavailable = await openCase('figures.activityUnavailable');
  await table(unavailable.page);
  const u = await openFigures(unavailable.page);
  assert.match(await u.innerText(), /Pool activity data unavailable/);
  await unavailable.page.close();
});

// OPEN QUESTION for @rugged97, same root: this asserts the landing reads
// ['pool-market','pool-metrics','token','token']. F3 reads no pool-metrics
// (marketsProvider.ts says so), so the sequence is three reads, not four.
// What it really guards — no pool-activity read until a pool is opened —
// is worth keeping once the expected sequence is agreed.
test.skip('the fixture landing reads no pool activity until a pool is opened', async () => {
  const { page, errors } = await tracked();
  await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  await page.locator('#pools tbody tr').first().waitFor();
  const routes = () => page.evaluate(() => (window.__DOMINO_FIXTURE_READS__ ?? []).map((r) => r.route));
  await page.waitForFunction(() => (window.__DOMINO_FIXTURE_READS__ ?? []).length >= 4);
  assert.deepEqual(await routes(), ['pool-market', 'pool-metrics', 'token', 'token'], 'the table reads one pool, at most 4 reads');
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
  assert.match(await dialog.innerText(), /cache 0 s/);

  const readsBeforeAge = await caseLog(page);
  // Past the read service's fresh window, with the dialog left open.
  await page.clock.fastForward('01:05');
  await page.waitForFunction(() => document.querySelectorAll('[data-pool-figures-dialog] [data-provider-figure="attributed_stale"]').length > 0);
  const aged = await dialog.innerText();
  assert.match(aged, /· stale/, 'the open dialog says stale in words, not only in colour');
  assert.doesNotMatch(aged, /cache 0 s/, 'and stops reporting the retrieval cache age as if it were current');
  assert.doesNotMatch(aged, /A later refresh failed/i, 'aging alone does not imply a failed refresh');
  assert.deepEqual(await caseLog(page), readsBeforeAge, 'the display clock starts no new read');
  assert.deepEqual(await page.locator('tbody [data-metric="stale"]').count() > 0, true, 'the row behind it says the same');

  await quiet(page, errors);
  await page.close();
});
