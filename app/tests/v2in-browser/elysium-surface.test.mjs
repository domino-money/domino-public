/**
 * Elysium's surface in the browser (added 2026-11-06, the Elysium surface): what day 9 draws once rugged97's enabled
 * profile of chain 99901 is in api-contracts/v2/chains, seen today on builds that force the switch on with the synthetic
 * v4-only profile (scripts/build-elysium-test.mjs; the release build ignores that override, tests/elysium-switch.test.mjs).
 * Three builds of wallet-test-v2:
 *   - the usual one (Elysium before live, as every build is today): changed on purpose 2026-11-07 (Elysium's pre-launch,
 *     the owner's order: Elysium on the site before its network opens), it is in pre-launch (scripts/elysium-switch.mjs
 *     ELYSIUM_OPENS_ON): Home's "Open positions on" row with Elysium's chip, its mark and when it opens, leading to the
 *     docs, and What Domino is's Elysium section; nothing else names Elysium, and nothing asks chain 99901;
 *   - `-elysium` (live, no bridge serves it, as on day 9): the docs name it everywhere they name the networks, and Home's
 *     "Bring funds from" row and funding scene do not (funds cannot come from it); live wins over pre-launch;
 *   - `-elysium-funds` (live, and funds can come from it): Home's row lists it last with its mark, and the funding scene
 *     has a sixth place in the same column, Robinhood Chain staying at its foot.
 * Elysium's mark is the owner's file, public/chains/elysium.png (changed on purpose 2026-11-07: the owner supplied it as
 * a PNG, and the test-only placeholder the forced builds drew until then is gone).
 *
 * The pre-launch date is the visitor's own (src/lib/elysiumOpening.ts): each case sets the browser's time zone and starts
 * Playwright's clock at a chosen moment, and the boundary is crossed in an open page, with no reload.
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
import { createReadStub, FIXTURE_TOKEN } from '../support/read-stub.mjs';
import { choosePool, pressContinue } from '../support/new-position.mjs';
import { elysiumSwitch } from '../../scripts/elysium-switch.mjs';
import { ELYSIUM_LIVE_DIST, ELYSIUM_REPO_FUNDS_FROM, ELYSIUM_REPO_LIVE } from '../support/elysium-profile.mjs';

const APP = resolve(import.meta.dirname, '../..');
// Changed on purpose 2026-11-07 (day-9 rehearsal, finding F5): Elysium live with no bridge is the forced build while the
// repository leaves it off, the usual one (rugged97's profile and our pinned record) once it turns it on. Funds from
// Elysium stay the forced build's alone (no bridge pins it on day 9).
const LIVE_DIST = ELYSIUM_LIVE_DIST;
const FUNDS_DIST = resolve(APP, '.wallet-test-v2-dist-elysium-funds');
const SHOTS = process.env.DOMINO_ELYSIUM_SHOTS || null;
for (const dist of [WALLET_V2_DIST, LIVE_DIST, FUNDS_DIST]) {
  if (!existsSync(join(dist, 'index.html'))) throw new Error(`${dist} is missing: run npm run build:wallet-test-v2 and npm run build:wallet-test-v2-elysium first.`);
}
/** The repository's stage, which the usual build carries (scripts/elysium-switch.mjs): pre-launch today. */
const STAGE = elysiumSwitch({ row: { testHooks: true, deployable: false, site: false }, appRoot: APP }).stage;
const PRELAUNCH = STAGE === 'prelaunch';

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await closeBrowser(browser); });

/** `extra`: more of openJourney's options (timezoneId, clock, reducedMotion, routes, connect, viewport). */
async function open(dist, hash, viewport, extra = {}) {
  const chain = extra.chain ?? createV2Chain({ chainId: 8453, timestamp: Math.floor(Date.now() / 1000) });
  if (!extra.chain) chain.switchTo(4663);
  const read = createReadStub();
  const { chain: _, routes = [], ...rest } = extra;
  const s = await openJourney(browser, chain, { dist, hash, connect: false, originOpen: true, routes: [...routes, (request, url) => read.handle(request, url) ?? undefined], artwork: true, ...(viewport ? { viewport } : {}), ...rest });
  return Object.assign(s, { chain });
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
  await page.waitForFunction((to) => window.location.pathname + location.hash === `/docs/${to}` && document.querySelector('main article h1') !== null, slug);
  await article.waitFor();
  return article.innerText();
};
const FIVE = ['Ethereum', 'Base', 'Arbitrum One', 'OP Mainnet', 'Robinhood Chain'];
const FOUR = ['Robinhood Chain', 'Base', 'Arbitrum One', 'Elysium'];

// Changed on purpose 2026-11-07 (day-9 rehearsal, finding F3): skipped once the repository turns Elysium on, since the
// usual build is then the live one. Changed on purpose 2026-11-07 (Elysium's pre-launch): the stage with no opening day
// written (ELYSIUM_OPENS_ON null) alone; while a day is written, the usual build is in pre-launch (the test below).
test('Elysium off (no opening day written, not live): Home, Markets and the docs name no Elysium', async (t) => {
  if (ELYSIUM_REPO_LIVE) return t.skip('the repository turns Elysium on: the usual build is live');
  if (STAGE !== 'off') return t.skip(`the repository's stage is ${STAGE}`);
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

/** Home's "Open positions on" chips: each one's name, link, tag and accessible name. */
const positionChips = (page) => page.locator('.dm-hero-networks li').evaluateAll((items) => items.map((item) => {
  const link = item.querySelector('a');
  return { name: link.querySelector(':scope > span:not(.dm-network-mark):not(.dm-hero-when)')?.textContent ?? null, href: link.getAttribute('href'), when: link.querySelector('.dm-hero-when')?.textContent ?? null, label: link.getAttribute('aria-label') };
}));
const elysiumTag = (page) => page.locator('.dm-hero-networks .dm-hero-when');
const DATED = 'Elysium, Kinetiq’s network built on Hyperliquid, is the next network on Domino. It opens on November 9.';
const UNDATED = 'Elysium, Kinetiq’s network built on Hyperliquid, is the next network on Domino.';
const SECTION = [
  'Once Domino opens there, Elysium works like Robinhood Chain: its pools in Markets, New position, Positions and Automate. Its pools are Uniswap v4 only, and its network fee, called gas, is paid in HYPE.',
  'Domino does not bring funds from another network to Elysium: a position there uses the tokens already in your wallet on Elysium.',
];
/** The docs' Elysium section's paragraphs, as drawn. */
const sectionParagraphs = (page) => page.locator('section#elysium p').allInnerTexts().then((texts) => texts.map((text) => text.trim()));
/** Text of `main` outside Home's "Open positions on" row. */
const mainOutsideRow = (page) => page.locator('main').evaluate((main) => {
  const copy = main.cloneNode(true);
  for (const row of copy.querySelectorAll('.dm-hero-networks')) row.remove();
  return copy.textContent;
});
const opensAt = (zone, iso) => ({ timezoneId: zone, clock: { time: new Date(iso) } });

test('Elysium before live (every build today): Home\'s "Open positions on" row with Elysium\'s chip and when it opens, the docs\' Elysium section, and nothing else names it', async (t) => {
  if (ELYSIUM_REPO_LIVE) return t.skip('the repository turns Elysium on: the usual build is live');
  if (!PRELAUNCH) return t.skip(`the repository's stage is ${STAGE}`);
  // 7 Nov, 23:00 in the visitor's own time (UTC-12): before the opening day.
  const s = await open(WALLET_V2_DIST, '#/', null, opensAt('Etc/GMT+12', '2026-11-08T11:00:00Z'));
  try {
    const { page } = s;
    await page.locator('.dm-hero-networks li').first().waitFor();
    assert.equal((await page.locator('.dm-hero-networks > span').innerText()).trim(), 'Open positions on');
    const chips = await positionChips(page);
    assert.deepEqual(chips.map((chip) => chip.name), FOUR);
    assert.deepEqual(chips.slice(0, 3).map((chip) => [chip.href, chip.when, chip.label]), [['/new', null, null], ['/new', null, null], ['/new', null, null]], 'the three networks lead to New position, as live');
    assert.deepEqual(chips[3], { name: 'Elysium', href: '/docs/what-is-domino#elysium', when: 'Opens Nov 9', label: 'Elysium, Opens Nov 9' });
    assert.equal(await page.locator('.dm-hero-networks [data-elysium-when="dated"]').count(), 1);
    assert.equal(await page.getByRole('link', { name: 'Elysium, Opens Nov 9', exact: true }).count(), 1, 'its accessible name');
    // The owner's mark on its white disc, drawn as the file is: loaded, never dimmed or filtered, nor anything around it.
    await page.waitForFunction(() => document.querySelector('.dm-hero-networks img')?.complete === true);
    const mark = await page.locator('.dm-hero-networks img').evaluate((image) => {
      const chain = [];
      for (let node = image; node && !node.matches('ul'); node = node.parentElement) chain.push({ tag: node.tagName, opacity: getComputedStyle(node).opacity, filter: getComputedStyle(node).filter, blend: getComputedStyle(node).mixBlendMode });
      return { src: image.getAttribute('src'), width: image.naturalWidth, hidden: image.hidden, chain };
    });
    assert.deepEqual([mark.src, mark.width, mark.hidden], ['/chains/elysium.png', 128, false]);
    for (const node of mark.chain) assert.deepEqual([node.opacity, node.filter, node.blend], ['1', 'none', 'normal'], node.tag);
    // Bring funds from keeps the five, and the funding scene its five places: no bridge serves Elysium.
    assert.deepEqual(await heroRow(page), FIVE);
    assert.deepEqual(await scenePlaces(page), FIVE);
    assert.equal(await page.locator('.dm-funding-networks[data-places]').count(), 0, 'the scene\'s markup is what it was');
    assert.doesNotMatch(await mainOutsideRow(page), /Elysium|HYPE/, 'Home names Elysium in its row alone');
    await shot(page.locator('.dm-hero').first(), 'home-hero-elysium-prelaunch');
    // The docs: What Domino is names it in its last section alone; the other pages as today.
    for (const slug of ['wallet', 'contracts', 'bring-funds']) assert.doesNotMatch(await docsText(page, slug), /Elysium|HYPE/, slug);
    await docsText(page, 'what-is-domino');
    assert.deepEqual(await sectionParagraphs(page), [DATED, ...SECTION]);
    const rest = await page.locator('main article').evaluate((article) => {
      const copy = article.cloneNode(true);
      for (const node of copy.querySelectorAll('section#elysium, .dm-docs-toc-menu')) node.remove();
      return copy.textContent;
    });
    assert.doesNotMatch(rest, /Elysium|HYPE/, 'What Domino is names Elysium in its section alone');
    await page.evaluate(() => { window.location.hash = '#/markets'; });
    await page.getByRole('combobox', { name: 'Search a token', exact: true }).waitFor();
    assert.doesNotMatch(await page.locator('main').innerText(), /Elysium/);
  } finally { await s.close(); }
});

test('Elysium live, no bridge for it (day 9): the docs name it beside the other networks; Home\'s funding places do not', async (t) => {
  // Changed on purpose 2026-11-09 (rugged97's #488: Relay for Elysium): the repository's own build takes funds from Elysium
  // once its bridge is pinned, and the test below holds Home and the docs then.
  if (ELYSIUM_REPO_FUNDS_FROM) return t.skip('the repository pins a bridge for Elysium: the funds-on test below holds Home and the docs');
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

// ---------------------------------------------------------------------------------------------------------------------
// Added 2026-11-07 (Elysium's pre-launch): the date is the visitor's own, the boundary crossed without a reload, live wins,
// the keyboard and motion, a missing mark, and nothing asks chain 99901.
// ---------------------------------------------------------------------------------------------------------------------

/** Where an open page crosses into the opening day: a minute before local midnight at each end of the world. */
const EDGES = [['Pacific/Kiritimati', '2026-11-08T09:59:00Z'], ['Etc/GMT+12', '2026-11-09T11:59:00Z']];

for (const [zone, moment] of EDGES) test(`the date leaves by itself at local midnight in an open page (${zone}): "Opens Nov 9" becomes "Opens next", and the docs' dated sentence goes, with no reload`, async (t) => {
  if (!PRELAUNCH) return t.skip(`the repository's stage is ${STAGE}`);
  const home = await open(WALLET_V2_DIST, '#/', null, opensAt(zone, moment));
  try {
    const { page } = home;
    await elysiumTag(page).waitFor();
    assert.equal(await elysiumTag(page).innerText(), 'Opens Nov 9');
    const navigations = await page.evaluate(() => { window.__sameDocument = 'kept'; return performance.getEntriesByType('navigation').length; });
    await page.clock.fastForward(120_000);
    await page.waitForFunction(() => document.querySelector('.dm-hero-networks [data-elysium-when]')?.getAttribute('data-elysium-when') === 'next');
    assert.equal(await elysiumTag(page).innerText(), 'Opens next');
    assert.equal(await page.getByRole('link', { name: 'Elysium, Opens next', exact: true }).count(), 1);
    assert.deepEqual(await page.evaluate(() => [window.__sameDocument, performance.getEntriesByType('navigation').length]), ['kept', navigations], 'the same page, never reloaded');
  } finally { await home.close(); }
  const docs = await open(WALLET_V2_DIST, '#/docs/what-is-domino#elysium', null, opensAt(zone, moment));
  try {
    const { page } = docs;
    await page.locator('section#elysium').waitFor();
    await page.locator('section#elysium').scrollIntoViewIfNeeded();
    assert.deepEqual(await sectionParagraphs(page), [DATED, ...SECTION]);
    await page.evaluate(() => { window.__sameDocument = 'kept'; });
    await page.clock.fastForward(120_000);
    await page.waitForFunction(() => !document.querySelector('section#elysium p')?.textContent.includes('It opens on'));
    assert.deepEqual(await sectionParagraphs(page), [UNDATED, ...SECTION], 'the sentence goes, the rest of the paragraph stays');
    assert.equal(await page.evaluate(() => window.__sameDocument), 'kept');
  } finally { await docs.close(); }
});

for (const zone of ['Etc/GMT+12', 'Pacific/Kiritimati']) test(`after the opening day, a fresh load (${zone}): "Opens next", no dated sentence, and no "Nov 9" anywhere in the page`, async (t) => {
  if (!PRELAUNCH) return t.skip(`the repository's stage is ${STAGE}`);
  const s = await open(WALLET_V2_DIST, '#/', null, opensAt(zone, '2026-11-12T12:00:00Z'));
  try {
    const { page } = s;
    await elysiumTag(page).waitFor();
    assert.equal(await elysiumTag(page).innerText(), 'Opens next');
    assert.equal(await page.locator('.dm-hero-networks [data-elysium-when="next"]').count(), 1);
    const PASSED = /\bNov(?:ember)? 9\b/;
    const everything = () => page.evaluate(() => [document.documentElement.outerHTML, document.title, ...[...document.querySelectorAll('*')].flatMap((node) => [...node.attributes].filter((attribute) => attribute.name.startsWith('aria-') || attribute.name === 'title').map((attribute) => attribute.value))].join('\n'));
    assert.doesNotMatch(await everything(), PASSED, 'Home');
    await shot(page.locator('.dm-hero').first(), `home-hero-elysium-after-day-${zone.replace(/\W+/g, '-')}`);
    await docsText(page, 'what-is-domino');
    assert.deepEqual(await sectionParagraphs(page), [UNDATED, ...SECTION]);
    assert.doesNotMatch(await everything(), PASSED, 'the docs');
  } finally { await s.close(); }
});

test('the docs before the opening day: the section word for word, "On this page" ending with Elysium, and Home\'s chip landing on its heading by keyboard', async (t) => {
  if (!PRELAUNCH) return t.skip(`the repository's stage is ${STAGE}`);
  const s = await open(WALLET_V2_DIST, '#/', { width: 1440, height: 900 }, opensAt('UTC', '2026-11-08T12:00:00Z'));
  try {
    const { page } = s;
    const chip = page.getByRole('link', { name: 'Elysium, Opens Nov 9', exact: true });
    await chip.waitFor();
    await chip.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.location.pathname + window.location.hash === '/docs/what-is-domino#elysium');
    const heading = page.locator('section#elysium > h2');
    await heading.waitFor();
    assert.equal((await heading.innerText()).trim(), 'Elysium');
    await page.waitForFunction(() => { const box = document.querySelector('section#elysium > h2')?.getBoundingClientRect(); return box !== undefined && box.top >= 0 && box.bottom <= innerHeight; });
    assert.deepEqual(await sectionParagraphs(page), [DATED, ...SECTION]);
    const toc = await page.locator('.dm-docs-toc-link').allInnerTexts();
    assert.equal(toc.map((text) => text.trim()).filter(Boolean).at(-1), 'Elysium', 'On this page ends with Elysium');
    const links = await page.locator('section#elysium a').evaluateAll((anchors) => anchors.map((anchor) => [anchor.textContent, anchor.getAttribute('href')]));
    assert.deepEqual(links, [['Markets', '/docs/markets'], ['New position', '/docs/new-position'], ['Positions', '/docs/positions'], ['bring funds from another network', '/docs/bring-funds']]);
    await shot(page.locator('section#elysium'), 'docs-what-is-domino-elysium-section-prelaunch');
  } finally { await s.close(); }
});

test('live wins over pre-launch: the live build (made with the opening day still written) has no tag, its Elysium chip opens New position, and the docs no Elysium section', async () => {
  const s = await open(LIVE_DIST, '#/', null, opensAt('UTC', '2026-11-08T12:00:00Z'));
  try {
    const { page } = s;
    await page.locator('.dm-hero-networks li').first().waitFor();
    const chips = await positionChips(page);
    assert.deepEqual(chips.map((chip) => [chip.name, chip.href, chip.when, chip.label]), FOUR.map((name) => [name, '/new', null, null]));
    assert.equal(await page.locator('.dm-hero-when, [data-elysium-when]').count(), 0);
    await shot(page.locator('.dm-hero').first(), 'home-hero-elysium-live');
    await docsText(page, 'what-is-domino');
    assert.equal(await page.locator('section#elysium').count(), 0);
    assert.doesNotMatch(await page.locator('main article').innerText(), /the next network on Domino|It opens on/);
  } finally { await s.close(); }
});

test('the keyboard reaches Elysium\'s chip from Arbitrum One, its focus ring follows the pill, and under reduced motion nothing in the row moves', async (t) => {
  if (!PRELAUNCH) return t.skip(`the repository's stage is ${STAGE}`);
  const s = await open(WALLET_V2_DIST, '#/', { width: 1440, height: 900 }, { ...opensAt('UTC', '2026-11-08T12:00:00Z'), reducedMotion: 'reduce' });
  try {
    const { page } = s;
    const arbitrum = page.locator('.dm-hero-networks li').nth(2).locator('a');
    await arbitrum.waitFor();
    await arbitrum.focus();
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const link = document.activeElement;
      const item = link.closest('li');
      const a = link.getBoundingClientRect(), b = item.getBoundingClientRect();
      const style = getComputedStyle(link);
      return { label: link.getAttribute('aria-label'), visible: link.matches(':focus-visible'), ring: style.outlineStyle !== 'none' || style.boxShadow !== 'none', fills: Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1, radius: style.borderRadius };
    });
    assert.deepEqual([focused.label, focused.visible, focused.ring, focused.fills], ['Elysium, Opens Nov 9', true, true, true], JSON.stringify(focused));
    await shot(page.locator('.dm-hero-networks'), 'home-row-elysium-focus');
    // Changed on purpose 2026-11-07 (merge of the pre-launch with day 9): the site's reduced-motion rule turns every
    // transition into 0.01 ms, which can still read as "running" in the instant after a style read; motion is anything longer.
    const moving = await page.locator('.dm-hero-networks').evaluate((row) => row.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running' && Number(animation.effect?.getTiming().duration) > 1).length);
    assert.equal(moving, 0, 'no running animation in the row under reduced motion');
  } finally { await s.close(); }
});

test('a mark that does not load: the image hides, as for every network\'s file, and the name and the tag stay', async (t) => {
  if (!PRELAUNCH) return t.skip(`the repository's stage is ${STAGE}`);
  const missing = (request, url) => (url.pathname === '/chains/elysium.png' ? new Response('', { status: 404 }) : undefined);
  const s = await open(WALLET_V2_DIST, '#/', null, { ...opensAt('UTC', '2026-11-08T12:00:00Z'), routes: [missing] });
  try {
    const { page } = s;
    await page.waitForFunction(() => document.querySelector('.dm-hero-networks img')?.hidden === true);
    const chips = await positionChips(page);
    assert.deepEqual(chips.at(-1), { name: 'Elysium', href: '/docs/what-is-domino#elysium', when: 'Opens Nov 9', label: 'Elysium, Opens Nov 9' });
    assert.equal(await page.locator('.dm-hero-networks li:last-child img').isVisible(), false);
  } finally { await s.close(); }
});

// 8.6: one pass per screen, each settled, no loop. What is recorded: every request the page makes (its URL and body),
// every WebSocket frame, and the wallet's JSON-RPC (the fake chain's `asked`).
test('before live, nothing asks chain 99901: Home, the docs, Markets, New position\'s first three steps, Positions, Automate, the wallet dialog and the menu', async (t) => {
  if (!PRELAUNCH) return t.skip(`the repository's stage is ${STAGE}`);
  const chain = createV2Chain({ chainId: 4663, timestamp: Math.floor(Date.now() / 1000), balances: { [FIXTURE_TOKEN]: 5_000_000n } });
  chain.switchTo(4663);
  const seen = [];
  const s = await open(WALLET_V2_DIST, '#/', { width: 1440, height: 900 }, { chain, connect: true, ...opensAt('UTC', '2026-11-08T12:00:00Z') });
  try {
    const { page } = s;
    page.on('request', (request) => seen.push(`${request.method()} ${request.url()} ${request.postData() ?? ''}`));
    page.on('websocket', (socket) => {
      seen.push(`WS ${socket.url()}`);
      socket.on('framesent', (frame) => seen.push(`WS> ${frame.payload}`));
      socket.on('framereceived', (frame) => seen.push(`WS< ${frame.payload}`));
    });
    const settle = () => page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    const go = async (hash, ready) => {
      await page.evaluate((to) => { window.location.hash = to; }, hash);
      await ready();
      await settle();
    };
    await page.reload();
    await page.locator('.dm-hero-networks li').first().waitFor();
    await settle();
    for (const slug of ['what-is-domino', 'wallet', 'contracts', 'bring-funds']) await go(`#/docs/${slug}`, () => page.locator('main article h1').waitFor());
    await go('#/markets', () => page.getByRole('combobox', { name: 'Search a token', exact: true }).waitFor());
    await page.getByRole('combobox', { name: 'Search a token', exact: true }).fill('USD');
    await settle();
    // New position: the pool, the range and the amount steps.
    await go('#/new', () => page.locator('[data-create-journey]').waitFor());
    await choosePool(page);
    const current = (step) => page.locator(`li[data-step="${step}"][aria-current="step"]`);
    await pressContinue(current('pool'));
    await current('range').waitFor();
    await pressContinue(current('range'));
    await current('amount').waitFor();
    await settle();
    await go('#/positions', () => page.locator('main h1').first().waitFor());
    await go('#/automate', () => page.locator('main h1').first().waitFor());
    await page.locator('header [aria-haspopup="dialog"]').click();
    await page.locator('[role="dialog"]').first().waitFor();
    await settle();
    await page.keyboard.press('Escape');
    // The ≡ menu: open, and still without the old testnet section's entry (src/chains/elysium stays off).
    await page.locator('header').getByRole('button', { name: 'Menu', exact: true }).click();
    const items = page.locator('#site-menu');
    await items.waitFor();
    assert.doesNotMatch(await items.innerText(), /Elysium/);
    await settle();
    await page.keyboard.press('Escape');
    assert.ok(seen.length > 10, `${seen.length} requests recorded`);
    const wallet = chain.asked.map(({ method, params }) => `${method} ${JSON.stringify(params)}`);
    assert.ok(wallet.length > 0, 'the wallet was asked');
    for (const line of [...seen, ...wallet]) assert.doesNotMatch(line, /99901|0x1863d/i, line.slice(0, 300));
    const elysiumUrls = seen.filter((line) => /elysium/i.test(line.split(' ')[1] ?? '')).map((line) => new URL(line.split(' ')[1]).pathname);
    assert.deepEqual([...new Set(elysiumUrls)], ['/chains/elysium.png'], 'the mark is the one Elysium address asked');
    assert.ok(!chain.asked.some(({ method, params }) => /wallet_(?:switch|add)EthereumChain/.test(method) && /0x1863d/i.test(JSON.stringify(params))));
    // openJourney's close() also holds that no request left the page's origin but the artwork it answers itself.
  } finally { await s.close(); }
});
