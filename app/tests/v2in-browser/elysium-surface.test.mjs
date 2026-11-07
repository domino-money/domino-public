/**
 * Elysium's surface in the browser (added 2026-11-06, the Elysium surface): what day 9 draws once rugged97's enabled
 * profile of chain 99901 is in api-contracts/v2/chains, seen today on builds that force the switch on with the synthetic
 * v4-only profile (scripts/build-elysium-test.mjs; the release build ignores that override, tests/elysium-switch.test.mjs).
 * Three builds of wallet-test-v2:
 *   - the usual one (Elysium off, as every build is today): Home, Markets and the docs name no Elysium;
 *   - `-elysium` (live, no bridge serves it, as on day 9): the docs name it everywhere they name the networks, and Home's
 *     "Bring funds from" row and funding scene do not (funds cannot come from it);
 *   - `-elysium-funds` (live, and funds can come from it): Home's row lists it last with its mark, and the funding scene
 *     has a sixth place in the same column, Robinhood Chain staying at its foot.
 * Elysium's mark is the owner's file, public/chains/elysium.png (changed on purpose 2026-11-07: the owner supplied it as
 * a PNG, and the test-only placeholder the forced builds drew until then is gone).
 *
 * DOMINO_ELYSIUM_SHOTS=<dir> keeps pictures of what it checks for the owner (Home, the docs, a network tag list).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { openJourney } from '../support/journey-browser.mjs';
import { launchBrowser } from '../support/s1-browser.mjs';
import { closeBrowser } from '../support/close-browser.mjs';
import { WALLET_V2_DIST } from '../support/wallet-dist.mjs';
import { createV2Chain } from '../support/v2-chain.mjs';
import { createReadStub } from '../support/read-stub.mjs';

const APP = resolve(import.meta.dirname, '../..');
const LIVE_DIST = resolve(APP, '.wallet-test-v2-dist-elysium');
const FUNDS_DIST = resolve(APP, '.wallet-test-v2-dist-elysium-funds');
const SHOTS = process.env.DOMINO_ELYSIUM_SHOTS || null;
for (const dist of [WALLET_V2_DIST, LIVE_DIST, FUNDS_DIST]) {
  if (!existsSync(join(dist, 'index.html'))) throw new Error(`${dist} is missing: run npm run build:wallet-test-v2 and npm run build:wallet-test-v2-elysium first.`);
}

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await closeBrowser(browser); });

async function open(dist, hash, viewport) {
  const chain = createV2Chain({ chainId: 8453, timestamp: Math.floor(Date.now() / 1000) });
  chain.switchTo(4663);
  const read = createReadStub();
  return openJourney(browser, chain, { dist, hash, connect: false, originOpen: true, routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true, ...(viewport ? { viewport } : {}) });
}
const shot = async (target, name) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await target.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled' });
};
/** A chip's network name: its last line (OP Mainnet's mark is the letters "OP"). */
const names = (texts) => texts.map((text) => text.trim().split(/\n/).at(-1).trim());
const heroRow = (page) => page.locator('.dm-hero-funding:not(.dm-hero-networks) li').allInnerTexts().then(names);
const scenePlaces = (page) => page.locator('.dm-funding-networks > span').allInnerTexts().then(names);
const docsText = async (page, slug) => {
  await page.evaluate((to) => { window.location.hash = `#/docs/${to}`; }, slug);
  const article = page.locator('main article').first();
  await page.waitForFunction((to) => window.location.hash === `#/docs/${to}` && document.querySelector('main article h1') !== null, slug);
  await article.waitFor();
  return article.innerText();
};
const FIVE = ['Ethereum', 'Base', 'Arbitrum One', 'OP Mainnet', 'Robinhood Chain'];

test('Elysium off (every build today): Home, Markets and the docs name no Elysium', async () => {
  const s = await open(WALLET_V2_DIST, '#/');
  try {
    const { page } = s;
    await page.locator('.dm-hero-funding li').first().waitFor();
    assert.deepEqual(await heroRow(page), FIVE);
    assert.deepEqual(await scenePlaces(page), FIVE);
    assert.equal(await page.locator('.dm-funding-networks[data-places]').count(), 0, 'the scene\'s markup is what it was');
    assert.doesNotMatch(await page.locator('main').innerText(), /Elysium/);
    for (const slug of ['what-is-domino', 'wallet', 'contracts', 'bring-funds']) assert.doesNotMatch(await docsText(page, slug), /Elysium|HYPE/, slug);
    await page.evaluate(() => { window.location.hash = '#/markets'; });
    await page.getByRole('combobox', { name: 'Search a token', exact: true }).waitFor();
    assert.doesNotMatch(await page.locator('main').innerText(), /Elysium/);
  } finally { await s.close(); }
});

test('Elysium live, no bridge for it (day 9): the docs name it beside the other networks; Home\'s funding places do not', async () => {
  const s = await open(LIVE_DIST, '#/');
  try {
    const { page } = s;
    await page.locator('.dm-hero-funding li').first().waitFor();
    assert.deepEqual(await heroRow(page), FIVE, 'funds cannot come from Elysium: Bring funds from does not list it');
    assert.deepEqual(await scenePlaces(page), FIVE);
    const intro = await docsText(page, 'what-is-domino');
    assert.match(intro, /Uniswap positions on Robinhood Chain, Base, Arbitrum One and Elysium/);
    assert.match(await docsText(page, 'wallet'), /Arbitrum One, 42161, and Elysium, 99901/);
    assert.match(await docsText(page, 'bring-funds'), /A position on Elysium uses the tokens already in your wallet on Elysium\./);
    const contracts = await docsText(page, 'contracts');
    assert.match(contracts, /Elysium has Uniswap v4 only, so the Uniswap v3 ones are not on it\./);
    assert.match(contracts, /Elysium, Uniswap v4/);
    assert.match(contracts, /Chain ID 99901/);
    await page.evaluate(() => { window.location.hash = '#/docs/contracts'; });
    await shot(page.locator('main article').first(), 'docs-contracts-elysium');
    await docsText(page, 'what-is-domino');
    await shot(page.locator('main article').first(), 'docs-what-is-domino-elysium');
  } finally { await s.close(); }
});

test('Elysium live with funds from it: Home lists it last with its own mark, and the funding scene takes a sixth place above Robinhood Chain', async () => {
  const s = await open(FUNDS_DIST, '#/');
  try {
    const { page } = s;
    await page.locator('.dm-hero-funding li').first().waitFor();
    assert.deepEqual(await heroRow(page), [...FIVE, 'Elysium']);
    // Its mark is its own file, served at /chains/elysium.png (the owner's), drawn and never another's.
    const mark = page.locator('.dm-hero-funding:not(.dm-hero-networks) li:last-child [data-network="Elysium"] img');
    await page.waitForFunction(() => document.querySelector('.dm-hero-funding:not(.dm-hero-networks) li:last-child img')?.complete === true);
    assert.equal(await mark.getAttribute('src'), '/chains/elysium.png');
    assert.ok(await mark.evaluate((image) => image.naturalWidth > 0 && !image.hidden), 'the mark is drawn');
    await shot(page.locator('.dm-hero').first(), 'home-hero-bring-funds-elysium');
    // The scene: six places, Elysium fifth, Robinhood Chain at the foot, each chip inside the scene and none on another.
    const funding = page.locator('#funding');
    await funding.scrollIntoViewIfNeeded();
    assert.deepEqual(await scenePlaces(page), ['Ethereum', 'Base', 'Arbitrum One', 'OP Mainnet', 'Elysium', 'Robinhood Chain']);
    assert.equal(await page.locator('.dm-funding-networks').getAttribute('data-places'), '6');
    const boxes = await page.locator('.dm-funding-networks > span').evaluateAll((chips) => chips.map((chip) => chip.getBoundingClientRect().toJSON()));
    const scene = await page.locator('.dm-funding-scene').evaluate((node) => node.getBoundingClientRect().toJSON());
    for (let index = 1; index < boxes.length; index += 1) assert.ok(boxes[index].top >= boxes[index - 1].bottom, `place ${index} sits below place ${index - 1}`);
    assert.ok(boxes.at(-1).bottom <= scene.bottom + 0.5, 'the sixth place stays inside the scene');
    // Each place lights its own route: six routes, the chosen one lit.
    assert.equal(await page.locator('.dm-funding-route').count(), 6);
    await page.locator('.dm-funding-networks > span', { hasText: 'Elysium' }).click();
    assert.equal(await page.locator('.dm-funding-networks > span', { hasText: 'Elysium' }).getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('.dm-funding-route-4').getAttribute('class'), /is-lit/);
    await shot(funding.locator('.dm-funding-card'), 'home-funding-scene-elysium');
    // On this network: Robinhood Chain alone at the column's foot, the five others dimmed above it, its route lit.
    await page.getByRole('button', { name: 'On this network', exact: true }).click();
    assert.equal((await page.locator('.dm-funding-current').innerText()).trim(), 'Robinhood Chain');
    assert.equal(await page.locator('.dm-funding-ghosts > span').count(), 5);
    const current = await page.locator('.dm-funding-current').evaluate((node) => node.getBoundingClientRect().toJSON());
    assert.ok(Math.abs(current.bottom - boxes.at(-1).bottom) < 1, 'the current network keeps the foot of the column');
    assert.match(await page.locator('.dm-funding-route-5').getAttribute('class'), /is-lit/);
    await page.getByRole('button', { name: 'From another network', exact: true }).click();
    assert.match(await page.locator('.dm-funding-details').innerText({ timeout: 5000 }).catch(() => ''), /Networks and transfers/);
    assert.match(await page.locator('.dm-funding-details p').textContent(), /Domino checks Ethereum, Base, Arbitrum One, OP Mainnet, Robinhood Chain and Elysium\./);
    // Phones and the compact form: the chips wrap, nothing runs off the page.
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Home fits ${width}px`);
    }
    await page.setViewportSize({ width: 1280, height: 1000 });
    assert.match(await docsText(page, 'bring-funds'), /Domino checks supported balances on Robinhood Chain, Ethereum, Base, Arbitrum One, OP Mainnet and Elysium/);
  } finally { await s.close(); }
});

test('a network tag drawn from Elysium\'s own file: the Markets stylesheet draws it beside the three networks\' marks (a preview of the search\'s tags)', async () => {
  // Elysium's hits reach the search once the money screens' pass adds chain 99901 to V2's chain list (src/v2/chains.ts);
  // their tags are TokenSearch's NetworkTag, `data-chain-chip` with lib/chainMarks.ts chainMarkProps (unit-tested). Here the
  // same markup in the live build's Markets page shows what the stylesheet draws for each network.
  const s = await open(LIVE_DIST, '#/markets');
  try {
    const { page } = s;
    await page.getByRole('combobox', { name: 'Search a token', exact: true }).waitFor();
    await page.evaluate(() => {
      const host = document.querySelector('.dm-v3-market-search');
      const list = document.createElement('div');
      list.className = 'dm-flow-hit';
      list.dataset.elysiumPreview = '';
      list.style.cssText = 'display:flex;gap:0.5rem;align-items:center;margin-top:1rem';
      for (const [chainId, name, file] of [[4663, 'Robinhood Chain'], [8453, 'Base'], [42161, 'Arbitrum One'], [99901, 'Elysium', '/chains/elysium.png']]) {
        const chip = document.createElement('span');
        chip.className = 'dm-chip shrink-0';
        chip.dataset.chainChip = String(chainId);
        if (file) { chip.dataset.chainMark = ''; chip.style.setProperty('--dm-chain-mark', `url("${file}")`); }
        chip.textContent = name;
        list.append(chip);
      }
      host.append(list);
    });
    const marks = await page.locator('[data-elysium-preview] [data-chain-chip]').evaluateAll((chips) => chips.map((chip) => getComputedStyle(chip, '::before').backgroundImage));
    assert.match(marks[3], /\/chains\/elysium\.png/, 'Elysium is drawn from its own file');
    for (const drawn of marks.slice(0, 3)) assert.doesNotMatch(drawn, /elysium/);
    assert.equal(new Set(marks).size, 4, 'four networks, four marks: never another network\'s');
    assert.equal(await page.evaluate(async () => (await fetch('/chains/elysium.png')).headers.get('content-type')), 'image/png');
    await shot(page.locator('[data-elysium-preview]'), 'markets-network-tags-elysium');
  } finally { await s.close(); }
});
