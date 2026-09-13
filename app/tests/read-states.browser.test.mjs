/**
 * What each read state looks like on screen, in a real browser.
 *
 * The fixture build (vite build --mode fixtures) is served through the real
 * beta gate and its CSP, exactly as gate.browser.test.mjs serves dist. The
 * read lab renders every read-v1 fixture case with the app's own components:
 * the Selected pools table and the ticker for market rows, the family panels for
 * the other routes. Each case reads through the real pipeline and the real
 * package runtime; only which fixture answers is scripted.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { leaving, watch } from './page-watch.mjs';
import { FIXTURE_DIST, createGatedServer } from '../scripts/gated-server.mjs';

const PASSWORD = 'browser-test-beta-password';
const ENV = { BETA_PASSWORD: PASSWORD, BETA_COOKIE_KEY: 'Hk2mP9vQx4Lr7TbW1cNy6ZsJ3dGa8FeU5oViRtYqWeA' };
const SYMBOL = '<img src=x onerror=alert(1)>';

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
let page;
const log = { errors: [], dialogs: [] };

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

  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Anything that would run from a symbol, and anything the CSP refuses, is recorded.
  await context.addInitScript(() => {
    window.__alerts = [];
    window.alert = (message) => window.__alerts.push(String(message));
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
  });
  page = await context.newPage();
  // Per page, and teardown-aware: an ERR_ABORTED of a view this test leaves is the test's doing (page-watch.mjs).
  log.errors = watch(page, { requests: false, responses: false }).problems;
  page.on('dialog', (dialog) => {
    log.dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  await page.fill('#password', PASSWORD);
  leaving(page);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('button[type="submit"]')]);
  await page.goto(`${origin}/read-lab.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('[data-case]').length > 0 && document.querySelectorAll('[data-loading]').length === 0, null, {
    timeout: 30_000,
  });
});

after(async () => {
  await browser?.close();
  await new Promise((done) => server.close(done));
});

const section = (id) => page.locator(`[data-case="${id}"]`);

/**
 * The four cells after the pair in a case's single table row, and its ticker APR.
 * The first is the pool's price, its own ratio from chain state, read through
 * `data-pool-price` (it carries no figure attribute); each of the other three
 * holds a figure (`data-metric`) or the pool APR estimate (`data-apr-estimate`).
 * The provider's name is not in a cell but on the row's provenance, which
 * `provenance` reads.
 */
function figures(id) {
  return section(id).evaluate((root) => {
    const [price, ...cells] = Array.from(root.querySelectorAll('tbody tr td')).slice(1, 5);
    const read = (el) => [el?.innerText.replace(/\s/g, '') ?? null, el?.getAttribute('data-metric') ?? el?.getAttribute('data-apr-estimate') ?? null];
    const pool = price?.querySelector('[data-pool-price]');
    return {
      cells: [[pool?.innerText.replace(/\s/g, '') ?? null, pool?.getAttribute('data-pool-price') ?? null], ...cells.map((td) => read(td.querySelector('[data-metric], [data-apr-estimate]')))],
      ticker: read(root.querySelector('.dm-marquee [data-apr-estimate]')),
    };
  });
}

/** The row's provenance, carried as its title and data: the block its pool was verified at, and who reported its figures, dated only by retrieval. */
const provenance = (id) => section(id).locator('tbody tr [data-provenance]').getAttribute('data-provenance');

/** A labelled fact inside a family case: its text and its state. */
function fact(id, label) {
  return section(id).evaluate((root, wanted) => {
    const dt = Array.from(root.querySelectorAll('dt')).find((el) => el.textContent.trim() === wanted);
    const dd = dt?.nextElementSibling;
    return dd ? [dd.innerText.replace(/\s+/g, ' ').trim(), dd.getAttribute('data-fact-state')] : null;
  }, label);
}

test('the lab renders every fixture case behind the gate, under the CSP, without an error', async () => {
  const count = await page.locator('[data-case]').count();
  // 26 market scenarios, 59 gateway fixtures across the nine routes, 5 pagination and restart cases.
  assert.equal(count, 90, `rendered ${count} cases`);
  assert.equal(await page.locator('[data-case^="market-"]').count(), 26);
  assert.deepEqual(await page.evaluate(() => window.__csp), [], 'CSP violations');
  // The only failure allowed is the access page's own 401 before signing in.
  assert.deepEqual(log.errors.filter((e) => !/status of 401/.test(e)), []);
  assert.match(await page.locator('[data-build-banner="fixture"]').innerText(), /not deployable/);
});

test('market rows: every observation reaches the table and the ticker as itself, and the APR is never a figure', async () => {
  const unavailable = ['Unavailable', 'unavailable'];
  const apr = ['Est.APRunavailable', 'unavailable'];
  // The pool's price comes from the verified pool itself (ETH 18 and TOKEN 6 decimals at tick 0), whatever the provider said.
  const price = ['≈1,000,000,000,000TOKENperETH', 'usable'];
  // The figure alone in its cell: who reported it is on the row's provenance line, checked below.
  const provider = [price, ['$12.3K', 'provider'], ['$0.00', 'provider'], unavailable];
  const rejected = [price, ['Unavailable', 'rejected'], ['Unavailable', 'rejected'], unavailable];
  const blank = [price, unavailable, unavailable, unavailable];
  const expected = {
    provider,
    zero: [price, ['$0.00', 'provider'], ['$0.00', 'provider'], unavailable],
    missing: [price, ['NotreportedbyGeckoTerminal', 'absent'], ['NotreportedbyGeckoTerminal', 'absent'], unavailable],
    // A stale figure has no "· stale" beside it (the owner's decision on the redesign): its state and its title say so, below.
    stale: [price, ['$12.3K', 'stale'], ['$0.00', 'stale'], unavailable],
    expired: blank,
    'rejected-currencies': rejected,
    'rejected-dex': rejected,
    timeout: blank,
    'rate-limited': blank,
    'retry-recovers': provider,
    // The symbol is untrusted text: literal in the price's unit too.
    'untrusted-symbol': [[`≈1,000,000,000,000${SYMBOL.replace(/\s/g, '')}perETH`, 'usable'], ...provider.slice(1)],
  };
  const reported = /^Pool verified on-chain at block 700 · Reported by GeckoTerminal, retrieved \d+ s ago$/;
  for (const [id, cells] of Object.entries(expected)) {
    assert.deepEqual(await figures(`market-${id}`), { cells, ticker: apr }, `market-${id}`);
    assert.equal(await section(`market-${id}`).locator('[data-read-status]').getAttribute('data-read-status'), 'none', id);
    // A shown value names its provider and its retrieval in its title; a ratio would name Domino's calculation from the provider's figures.
    const titles = await section(`market-${id}`).locator('tbody [data-metric="provider"], tbody [data-metric="calculated"]').evaluateAll((els) => els.map((el) => [el.getAttribute('data-metric'), el.getAttribute('title')]));
    for (const [state, title] of titles) {
      assert.match(title, state === 'calculated' ? /^Calculated by Domino from GeckoTerminal's reported 24h volume and TVL, retrieved \d+ s ago\. Those figures are not reconciled by Domino\.$/ : /^Reported by GeckoTerminal, retrieved \d+ s ago\. Not reconciled by Domino\.$/, `${id}: ${state}`);
    }
  }
  const staleTitles = await section('market-stale').locator('tbody [data-metric="stale"]').evaluateAll((els) => els.map((el) => el.getAttribute('title')));
  assert.equal(staleTitles.length, 2, 'both provider figures are stale');
  for (const title of staleTitles) assert.match(title, /^Reported by GeckoTerminal, retrieved \d+ s ago\. Not reconciled by Domino\. Stale, not current\.$/, 'a stale figure says so in its title');
  // Never-displayed values are absent from the whole case, not just from their cell.
  for (const id of ['expired', 'rejected-currencies', 'rejected-dex', 'timeout']) {
    assert.doesNotMatch(await section(`market-${id}`).innerText(), /\$12\.3K/, `${id} shows the provider figure`);
  }
  // The APR says why it is unavailable; each row names the block its pool was verified at, and
  // dates GeckoTerminal's figures only by when they were retrieved, never "as of" or "updated at".
  assert.match(await section('market-provider').locator('tbody td').nth(4).locator('[data-apr-estimate] [title]').getAttribute('title'), /^Estimated from GeckoTerminal’s reported 24h volume and current TVL using the current fixed LP fee\. Unreconciled, without full-day coverage; excludes rewards, gas, service fees and price changes\. Pool estimate, not position APR, APY or a return forecast\. Estimated APR is (not enabled on this connection|unavailable; market figures use the supported read connection)\.$/);
  for (const id of ['provider', 'zero', 'missing', 'retry-recovers', 'untrusted-symbol']) assert.match(await provenance(`market-${id}`), reported, id);
  assert.match(await provenance('market-stale'), /^Pool verified on-chain at block 700 · Reported by GeckoTerminal, retrieved (6\d|[7-9]\d|1[01]\d) s ago · stale$/);
  assert.equal(await provenance('market-expired'), 'Pool verified on-chain at block 700 · GeckoTerminal figures unavailable: provider unavailable', 'no figure, so no age');
  assert.equal(await provenance('market-rejected-currencies'), 'Pool verified on-chain at block 700 · GeckoTerminal figures rejected: provider data did not match this pool');
  for (const id of Object.keys(expected)) assert.doesNotMatch(await section(`market-${id}`).innerText(), /as of|updated at/i, `${id} dates a figure it cannot date`);
});

test('an HTML-like token symbol renders as literal text, and nothing runs', async () => {
  for (const id of ['market-untrusted-symbol', 'family-token.untrusted-symbol']) {
    const root = section(id);
    assert.ok((await root.innerText()).includes(SYMBOL), `${id} does not show the symbol as text`);
    const probe = await root.evaluate((el, symbol) => ({
      injected: el.querySelectorAll('img[src="x"], img[onerror]').length,
      inAttributes: Array.from(el.querySelectorAll('*')).flatMap((node) => Array.from(node.attributes, (a) => a.value)).filter((v) => v.includes(symbol) || v.includes('onerror')),
      isolated: Array.from(el.querySelectorAll('bdi')).some((node) => node.textContent === symbol),
      artwork: Array.from(el.querySelectorAll('img')).map((img) => img.getAttribute('src')),
    }), SYMBOL);
    assert.equal(probe.injected, 0, `${id} created an element from the symbol`);
    assert.deepEqual(probe.inAttributes, [], `${id} put the symbol into an attribute`);
    assert.equal(probe.isolated, true, `${id} does not isolate the symbol in <bdi>`);
    assert.ok(probe.artwork.every((src) => /^\/tokens\/[a-z]+\.(svg|jpg|png)$/.test(src)), `${id} artwork ${probe.artwork}`);
  }
  assert.deepEqual(await page.evaluate(() => window.__alerts), []);
  assert.deepEqual(log.dialogs, []);
});

test('a bidi, zero-width and markup symbol is isolated and cut short, not laid out across the row', async () => {
  const shape = await section('market-hostile-symbol').evaluate((root) => {
    const bdi = Array.from(root.querySelectorAll('tbody bdi')).find((node) => node.textContent.includes('looking-long-symbol'));
    return { tag: bdi?.tagName, clipped: bdi.scrollWidth > bdi.clientWidth, width: bdi.getBoundingClientRect().width, markup: root.querySelectorAll('tbody b').length };
  });
  assert.equal(shape.tag, 'BDI');
  assert.equal(shape.markup, 0, 'the <b> in the symbol became an element');
  assert.equal(shape.clipped, true, 'a long symbol is truncated');
  assert.ok(shape.width < 160, `the symbol takes ${shape.width}px`);
});

test('table-wide states: one polite status line, the right words, and not a single row', async () => {
  const cases = {
    gate401: ['gate_required', /Beta access needed/],
    gate503: ['gate_unavailable', /Access is paused/],
    edge502: ['unavailable', /error page \(HTTP 502\)/],
    access: ['access_required', /access check/],
    'header-missing': ['incompatible', /did not say which contract/],
    'header-rc2': ['incompatible', /expects 1\.1\.0-rc\.3/],
    invalid: ['invalid', /did not match the read contract/],
    busy: ['busy', /Try again in 7 s/],
    transient: ['unavailable', /Temporarily unavailable[\s\S]*answered: read service unavailable/],
    'not-connected': ['not_connected', /Live data isn't connected yet/],
    'not-found': ['not_connected', /Live data isn't available on this address/],
    'no-forwarder': ['not_connected', /Live data isn't connected yet/],
    'route-disabled': ['disabled', /Live data is switched off for now/],
  };
  for (const [id, [state, words]] of Object.entries(cases)) {
    const root = section(`market-${id}`);
    const status = root.locator('[role="status"][aria-live="polite"]');
    assert.equal(await status.getAttribute('data-read-status'), state, id);
    assert.match(await status.innerText(), words, id);
    assert.equal(await root.locator('tbody tr').count(), 0, `${id} rendered rows`);
    assert.equal(await root.locator('[data-metric]').count(), 0, `${id} rendered figures`);
  }
  // Live data not connected, or switched off: a Retry cannot change that, and the ticker says the same words.
  for (const id of ['not-connected', 'not-found', 'no-forwarder', 'route-disabled']) {
    const root = section(`market-${id}`);
    assert.equal(await root.getByRole('button', { name: 'Retry' }).count(), 0, `${id} offers a Retry`);
    const title = await root.locator('[data-read-status] p').first().innerText();
    assert.equal(await root.locator('[data-ticker-status]').innerText(), title, `${id}: the ticker disagrees with the table`);
  }
  const signIn = section('market-gate401').getByRole('link', { name: 'Sign in again' });
  assert.equal(await signIn.getAttribute('href'), '/', 'the way back is this site’s own root');
  assert.equal(await section('market-gate401').getByRole('button', { name: 'Retry' }).count(), 0, 'retrying without access cannot help');
});

test('Retry keeps focus while the read keeps failing', async () => {
  const root = section('market-transient');
  const retry = root.getByRole('button', { name: 'Retry' });
  await retry.click();
  await root.getByRole('button', { name: 'Retry' }).waitFor();
  const focused = await root.evaluate((el) => ({ inside: el.contains(document.activeElement), text: document.activeElement?.textContent }));
  assert.deepEqual(focused, { inside: true, text: 'Retry' });
  assert.equal(await root.locator('[data-read-status]').getAttribute('data-read-status'), 'unavailable');
});

test('family panels keep zero, unknown, partial, stale, unavailable and rejected apart', async () => {
  const cases = [
    ['family-token.zero-decimals', 'Decimals', ['0', 'zero']],
    ['family-token.native', 'Decimals', ['18', 'value']],
    ['family-token.missing-decimals', 'Decimals', ['Units unknown: RPC error', 'partial']],
    ['family-token.metadata-reverted', 'Decimals', ['Units unknown: RPC call reverted', 'partial']],
    ['family-token.missing-contract', 'Decimals', ['No contract at this address', 'absent']],
    ['family-token.call-gas-limit', 'Decimals', ['Unavailable: RPC call hit the gas limit', 'unavailable']],
    ['family-pool-market.success', '24h coverage', ['Not established', 'partial']],
    ['family-pool-market.success', 'Latest hour', ['Still open (inferred from the backend clock)', 'partial']],
    ['family-pool-market.not-requested', 'Price history', ['Not requested', 'absent']],
    ['family-pool-market.stale', 'Liquidity', ['$12.3K · stale', 'stale']],
    ['family-pool-market.expired', 'Liquidity', ['Unavailable', 'unavailable']],
    ['family-pool-market.rejected-currencies', 'Liquidity', ['Rejected, not shown', 'rejected']],
    ['family-pool-market.zero', 'Liquidity', ['$0.00', 'zero']],
    ['family-pool-market.missing', 'Liquidity', ['Not reported', 'absent']],
    ['family-pool-metrics.qualified', 'Fee APR', ['158.06%', 'value']],
    ['family-pool-metrics.reference-analytics', 'Fee APR', ['Reference analytics, not current: 158.06%', 'not-current']],
    ['family-pool-metrics.stale', 'Fee APR', ['158.06% · stale', 'stale']],
    ['family-pool-metrics.partial', 'Fee APR', ['Not established: pool younger than the 24h window', 'partial']],
    ['family-pool-metrics.qualified', '24h LP fees', ['<$0.000001', 'value']],
    ['family-pool-activity.partial', '24h window', ['Partial: pool younger than the window (19 s observed)', 'partial']],
    ['family-pool-activity.unavailable', 'LP fees', ['Unavailable: fee ledger catching up', 'unavailable']],
    ['family-pool-positions.unavailable', 'Position accounting', ['Unavailable: position ledger catching up', 'unavailable']],
    ['family-pool-positions.success', 'NFT owner', ['Owner not resolved', 'absent']],
    ['family-nft-positions.empty', 'Position', ['Position empty at snapshot', 'absent']],
    ['family-nft-positions.zero', 'Liquidity', ['0 (raw units)', 'zero']],
    ['family-nft-positions.stale', 'Snapshot', ['Stale, 210 s old', 'stale']],
    ['family-pools.provider-unavailable', 'Discovery (DexScreener)', ['Partial list: network unavailable', 'partial']],
    ['family-pools.zero-and-missing-metrics', 'Liquidity (DexScreener, not reconciled)', ['Not reported', 'absent']],
    ['family-pools.zero-and-missing-metrics', '24h volume (DexScreener, not reconciled)', ['$0.00', 'zero']],
  ];
  for (const [id, label, want] of cases) assert.deepEqual(await fact(id, label), want, `${id} ${label}`);
  assert.doesNotMatch(await section('family-pool-market.expired').innerText(), /\$12\.3K/);
  assert.match(await section('family-pool-market.expired').innerText(), /301 s \(not a usable observation\)/);
  assert.match(await section('family-pools.rejected-candidate').innerText(), /1 candidate rejected and not listed/);
  assert.match(await section('family-catalogue.empty').innerText(), /No candidates in the configured interval/);
  assert.match(await section('family-wallet-assets.partial-metadata').innerText(), /raw units, decimals unknown/);
  assert.match(await section('family-pools.revision-changed').innerText(), /asked again once/);
});

test('Load more sends the handle back exactly, keeps focus, and the handle never reaches the page', async () => {
  const root = section('family-wallet-assets.pages');
  const more = root.getByRole('button', { name: 'Load more' });
  await more.click();
  await root.locator('[data-pages="2"]').waitFor();
  // The second page only answers the exact handle; anything else would render the bridge's refusal.
  assert.equal(await root.locator('[data-read-state="request_rejected"]').count(), 0);
  assert.equal(await root.getByRole('button', { name: 'All pages loaded' }).count(), 1);
  assert.equal(await root.evaluate((el) => el.contains(document.activeElement) && document.activeElement.tagName), 'BUTTON', 'focus stayed on the button');
  assert.match(await root.locator('[role="status"]').innerText(), /more loaded/);
  const leaks = await page.evaluate(() => {
    const places = [document.documentElement.outerHTML, location.href, JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })];
    return places.filter((text) => text.includes('c0ffee')).length;
  });
  assert.equal(leaks, 0, 'the continuation handle is somewhere a person or a script can read it');

  const expired = section('family-wallet-assets.cursor-expired');
  await expired.getByRole('button', { name: 'Load more' }).click();
  await expired.getByText('restarted from the first page', { exact: false }).first().waitFor();

  const catalogue = section('family-catalogue.pages');
  await catalogue.getByRole('button', { name: 'Load more' }).click();
  await catalogue.locator('[data-pages="2"]').waitFor();
  const changed = section('family-catalogue.revision-changed');
  await changed.getByRole('button', { name: 'Load more' }).click();
  await changed.getByText('restarted from the first page', { exact: false }).first().waitFor();
  assert.deepEqual(log.errors.filter((e) => !/status of 401/.test(e)), []);
});

test('the fixture landing is the real app, labelled as fixture data by its banner and its ticker; the table’s fixture notice is the lab’s', async () => {
  const landing = await context.newPage();
  await landing.goto(`${origin}/`, { waitUntil: 'networkidle' });
  await landing.locator('#pools tbody tr').first().waitFor();
  const text = await landing.locator('#pools').innerText();
  assert.match(text, /Selected pools/);
  assert.match(text, /\$12\.3K/);
  // Home's table shows the pools and their figures and nothing else (the owner's decision on the redesign), so the
  // fixture build is labelled by its banner and its ticker there, and the notice stays in the read lab.
  assert.doesNotMatch(text, /Fixture data|Contract fixtures from read-v1/);
  assert.equal(await landing.locator('[data-build-banner="fixture"]').count(), 1);
  assert.match(await landing.locator('[data-build-banner="fixture"]').innerText(), /read-v1 contract fixtures[\s\S]*not deployable/);
  // textContent: the tag is set in capitals by the stylesheet, and innerText follows that.
  assert.equal(await landing.locator('[data-ticker] [title="Contract fixtures, not observations"]').textContent(), 'Fixture');
  await landing.close();
  const lab = await section('market-provider').innerText();
  assert.match(lab, /Fixture data/);
  assert.match(lab, /Contract fixtures from read-v1 1\.1\.0-rc\.3/);
});

test('Refresh keeps keyboard focus through its read; it is busy, never unmounted, while the read runs', async () => {
  const id = 'market-provider';
  const root = section(id);
  await root.getByRole('button', { name: 'Refresh', exact: true }).focus();
  await root.evaluate((el) => {
    window.__focusTrace = [];
    const note = () => {
      const active = document.activeElement;
      window.__focusTrace.push(!active || active === document.body ? 'BODY' : active.textContent);
    };
    window.__focusObserver = new MutationObserver(note);
    window.__focusObserver.observe(el, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  await page.keyboard.press('Enter');
  await page.waitForFunction((caseId) => {
    const r = document.querySelector(`[data-case="${caseId}"]`);
    return window.__focusTrace.length > 0 && r.querySelector('[data-read-status]').getAttribute('data-read-status') === 'none' && !r.querySelector('[aria-disabled="true"]');
  }, id, { timeout: 10_000 });
  const trace = await page.evaluate(() => {
    window.__focusObserver.disconnect();
    return [...new Set(window.__focusTrace)];
  });
  assert.ok(!trace.includes('BODY'), `focus fell to the page during Refresh: ${trace}`);
  assert.ok(trace.includes('Refreshing…'), `Refresh was not shown busy while its read ran: ${trace}`);
  assert.deepEqual(await root.evaluate((el) => [el.contains(document.activeElement), document.activeElement?.textContent]), [true, 'Refresh']);
  assert.deepEqual(await figures(id), {
    cells: [['≈1,000,000,000,000TOKENperETH', 'usable'], ['$12.3K', 'provider'], ['$0.00', 'provider'], ['Unavailable', 'unavailable']],
    ticker: ['Est.APRunavailable', 'unavailable'],
  });
  assert.match(await provenance(id), /^Pool verified on-chain at block 700 · Reported by GeckoTerminal, retrieved \d+ s ago$/, 'the provider is still named after the refresh');
});

test('with no pools selected the table says so, reads nothing and offers nothing to refresh', async () => {
  const root = section('market-no-pools');
  assert.equal(await root.locator('tbody tr').count(), 0);
  assert.match(await root.locator('[data-empty="no-pools"]').innerText(), /No pools selected yet/);
  assert.equal(await root.locator('[data-read-status]').getAttribute('data-read-status'), 'none');
  assert.equal(await root.locator('[data-ticker-status]').innerText(), 'No pools selected yet');
  assert.equal(await root.getByRole('button', { name: 'Refresh' }).count(), 0);
});
