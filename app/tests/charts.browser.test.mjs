/**
 * A position's two charts and what its automation did (round 5, 2026-09-27, the owner's points 3, 5 and 10), on the
 * wallet-test build, over the public RPC answered by recorded chains (tests/support/fees/*): the Fees earned card
 * (the collected part and the part still waiting on the chart, Auto-compound's re-adds marked where they happened and
 * summed in one or two plain lines) and the Price range chart (the range as a band, the price over it, the price now
 * and in range or out in words).
 *
 * The automated position is the recording of NFT 2310187 (USDG/UFG 4 %, in range, fourteen days of history with five
 * collect-and-increase transactions), held by a fake Auto-compound vault whose ExecutionCompleted logs sit in four of
 * those five transactions (tests/support/fees/automated-chain.mjs), as an operator's compound leaves them on chain:
 * the oldest as a NET compound (one increase that settles the fees itself, as the owner's first one on NFT 3325113),
 * the others as collect-and-increase pairs; the second stays the owner's own. Each paid the 2 % service fee on what
 * it put back. Its holder is Test Wallet A's address, never the recording's. The plain position is the recording of
 * NFT 3136705 (out of range, nothing collected). Prints go to DOMINO_CHART_SHOTS when it is set (C:/dwt/round5/charts
 * for the owner's review), and to .test-artifacts otherwise.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { routeChain } from './support/browser-chain.mjs';
import { closeBrowser } from './support/close-browser.mjs';
import { createFakeSession } from './support/fake-session.mjs';
import { automatedChain } from './support/fees/automated-chain.mjs';
import { ACCOUNTS, installWallets } from './support/mock-wallet.mjs';
import { ARTWORK } from './support/new-position.mjs';
import { createWalletServer } from './support/wallet-server.mjs';

let browser;
before(async () => {
  for (const options of process.env.DOMINO_BROWSER_PATH ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }] : [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}]) {
    try { browser = await chromium.launch({ ...options, headless: true }); break; } catch {}
  }
  if (!browser) throw new Error('A Chromium browser is required.');
});
after(async () => { await closeBrowser(browser); });

const shots = () => { const dir = process.env.DOMINO_CHART_SHOTS || resolve(import.meta.dirname, '../.test-artifacts'); mkdirSync(dir, { recursive: true }); return dir; };
const DESKTOP = { viewport: { width: 1280, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const VAULT = '0x7a17c0de00000000000000000000000000c0de01';
/** NFT 2310187's collect-and-increase transactions (its recorded settlements), oldest first. */
const PAIRS = [
  '0x3648206ec3', '0x85e4b56105', '0xd2ee9c0a97', '0xd47d72a202', '0x5701d9285a',
];
/** What the product rules keep off these screens (finance.browser.test.mjs FORBIDDEN), and no technical words. */
const FORBIDDEN = /not connected yet|not enabled|coming soon|\bbeta\b|\balpha\b|\bv4\b|sample|practice|tick spacing|liquidity units|sqrt/i;
/** A dollar figure as the card writes it, as a number. */
const dollars = (text) => Number(/\$([\d,]+\.\d+)/.exec(text)[1].replace(/,/g, ''));

/** The recording's full hash of a settlement whose hash starts with `prefix`. */
function txOf(chain, prefix) {
  const found = chain.fixture.expect.events.find((event) => event[2].startsWith(prefix));
  assert.ok(found, prefix);
  return found[2];
}

/** The four automatic compounds of the automated position: every pair but the second, which the owner made; the oldest a NET compound. */
function automated(options = {}) {
  const base = automatedChain('2310187', { vault: VAULT, owner: ACCOUNTS[0].address, executions: [] });
  const executions = PAIRS.filter((_, i) => i !== 1).map((prefix, i) => ({ tx: txOf(base, prefix), net: i === 0 }));
  return automatedChain('2310187', { vault: VAULT, owner: ACCOUNTS[0].address, executions, ...options });
}

/** The wallet-test build on `hash`, the RPC answered by `chain`; no route of the site reads the chain. */
async function scenario(chain, hash, device = DESKTOP, init = null) {
  const fake = createFakeSession();
  const asked = [];
  const server = createWalletServer({ fake, dist: resolve(import.meta.dirname, '../.wallet-test-dist'), routes: [async (request, url) => {
    if (!/^\/api\/(?:owned|fees|automation)\//.test(url.pathname)) return undefined;
    asked.push(url.pathname);
    return Response.json({ error: 'route_not_available' }, { status: 404 });
  }] });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  fake.origin = origin;
  const context = await browser.newContext(device);
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  const rpc = await routeChain(context, chain);
  const wallet = await installWallets(context);
  const page = await context.newPage();
  if (init) await page.addInitScript(init);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/${hash}`);
  return {
    page,
    asked,
    async close() {
      await context.close();
      await server.closeAll();
      assert.deepEqual(errors, []);
      assert.deepEqual(wallet.state.csp, []);
      assert.deepEqual(rpc.errors, [], 'the public RPC was asked only what it answers');
    },
  };
}

/** Picks a period of the Fees earned card and waits for its chart. */
async function period(card, name) {
  await card.getByRole('radio', { name, exact: true }).or(card.getByRole('tab', { name, exact: true })).first().click();
  await card.locator('.dm-fees-chart').waitFor();
  await card.page().waitForTimeout(700);
}

/**
 * The key figures' Current price figure (`396.786` of "1 USDG = 396.786 UFG"), which the chart's price now repeats
 * exactly. Changed on purpose at the integration (2026-09-27): r5/position writes the page's figures without "≈".
 */
async function headerPrice(page) {
  return (await page.locator('[data-stat="price"] [data-current-price="usable"] .dm-fig-lg').innerText()).trim();
}

/** The Price range card around the chart. */
const rangeCard = (page) => page.locator('section.dm-pos-card:has([data-range])');

test('an automated position: the card says in two lines what Auto-compound put back and how much the position grew, marks each re-add on the chart, and its tooltip says it plainly', async () => {
  const chain = automated();
  const s = await scenario(chain, '#/positions/2310187');
  try {
    const page = s.page;
    await page.locator('[data-position-detail][data-position-id="2310187"]').waitFor({ timeout: 20_000 });
    const card = page.locator('[data-fees-card][data-fees-state="verified"]');
    await card.waitFor({ timeout: 60_000 });
    // The lines come with the card (it waits for the vault's read), never after it.
    const impact = card.locator('[data-automation-impact="compound"]');
    assert.equal(await impact.count(), 1, 'the automation lines are there the moment the card is');
    const added = await impact.locator('[data-impact="added"]').innerText();
    assert.match(added, /^Auto-compound added \$[\d,]+\.\d\d back · 4 times$/, added);
    const grew = await impact.locator('[data-impact="growth"]').innerText();
    assert.match(grew, /^Your position grew \d+\.\d\d% from fees$/, grew);
    // The growth is the vault's liquidity against the owner's: the recording's four automatic increases against its mint
    // and the owner's own increase (tests/automation-impact.test.mjs holds the arithmetic).
    const liquidity = (prefix) => BigInt(chain.fixture.expect.events.find((event) => event[2].startsWith(prefix) && event[0] === 'increase')[4]);
    const auto = PAIRS.filter((_, i) => i !== 1).reduce((sum, prefix) => sum + liquidity(prefix), 0n);
    const own = BigInt(chain.fixture.expect.events[0][4]) + liquidity(PAIRS[1]);
    assert.equal(grew, `Your position grew ${((Number((auto * 1_000_000n) / own) / 1_000_000) * 100).toFixed(2)}% from fees`);
    assert.equal(await impact.locator('[data-impact="opened"]').count(), 0, 'Auto-compound opens no new position');

    // Two small reads of the vault, once: its executions from the NFT's mint to its latest settlement, then the pair's
    // transfers out of it in those executions' blocks (the service fees); no route of the site.
    const blocks = chain.fixture.expect.events.map((event) => event[1]);
    const executed = PAIRS.filter((_, i) => i !== 1).map((prefix) => chain.fixture.expect.events.find((event) => event[2].startsWith(prefix))[1]);
    // Changed on purpose (2026-09-28, hotfix: the chain's RPC serves one filter over 10,000,000 blocks at most, and one with
    // several addresses over 100,000): this record's 11.8 million blocks are two windows, oldest first, and the fees paid
    // over its 8.8 million blocks of executions are asked one currency at a time.
    const window = 10_000_000;
    assert.ok(Math.max(...blocks) - blocks[0] + 1 > window && executed.at(-1) - executed[0] + 1 > 100_000, 'a record past both limits');
    assert.deepEqual(chain.vaultAsked, [
      { fromBlock: blocks[0], toBlock: blocks[0] + window - 1 },
      { fromBlock: blocks[0] + window, toBlock: Math.max(...blocks) },
      { transfers: true, address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', fromBlock: executed[0], toBlock: executed.at(-1) },
      { transfers: true, address: '0xefab538cf3c29237a47c6afb145d50ddf204a0a3', fromBlock: executed[0], toBlock: executed.at(-1) },
    ]);
    assert.deepEqual(s.asked, []);

    // The Activity says which increases were the automation's, with the chart's own mark. Changed on purpose
    // (2026-09-27, r5/position): the position's page lists it in a card of its own after Price range, a re-add is one
    // row, "Fees added back" (its collect and its increase together), and the owner's own increase reads "Added to
    // position" (finance.browser.test.mjs holds every row).
    assert.equal(await card.locator('.dm-fees-act').count(), 0, 'the card lists no activity on the position’s page');
    const activity = page.locator('[data-position-activity]');
    await activity.getByRole('button', { name: /^Show \d+ more$/ }).click();
    assert.deepEqual(await activity.locator('.dm-fees-act[data-auto] .dm-fees-act-verb').allInnerTexts(), ['Fees added back', 'Fees added back', 'Fees added back', 'Fees added back']);
    assert.deepEqual(await activity.locator('.dm-fees-act[data-kind="increase"]:not([data-auto]) .dm-fees-act-verb').allInnerTexts(), ['Added to position']);
    // The NET compound (one increase that settled the fees itself) is one row too, like every re-add (changed on purpose
    // at the integration, 2026-09-27: r5/position's one row per re-add, r5/charts' figure): "Fees added back" with what
    // went back in, the tooltip's own figure (checked below).
    const net = activity.locator(`.dm-fees-act[data-tx="${txOf(chain, PAIRS[0])}"]`);
    assert.deepEqual(await net.evaluateAll((rows) => rows.map((row) => [row.dataset.kind, 'auto' in row.dataset, 'sameTx' in row.dataset])), [['auto', true, false]]);
    assert.equal(await net.locator('.dm-fees-act-verb').innerText(), 'Fees added back');
    const netAdded = dollars(await net.locator('.dm-fees-act-value').innerText());
    assert.ok(netAdded > 0, `${netAdded}`);

    // All: the four re-adds marked, the owner's own collect keeps its pip.
    await period(card, 'All');
    const marks = card.locator('.dm-chart-series .dm-fees-auto');
    assert.equal(await marks.count(), 4);
    assert.ok(await card.locator('.dm-chart-series .dm-pip[data-kind="collect"]').count() >= 1, 'the owner\u2019s own collect keeps its pip');
    assert.equal(await card.locator('.dm-fees-waiting').count(), 1, 'the part still waiting is drawn');
    assert.doesNotMatch(await card.innerText(), FORBIDDEN);
    await page.screenshot({ path: join(shots(), 'desktop-automated-all.png'), fullPage: true });

    // Hovering each re-add: the tooltip says what Auto-compound put back and its fee, plainly; the NET one's figure is
    // the Activity's own, and every fee is the 2 % the contract takes on the gross (2/98 of what went back).
    await card.locator('.dm-fees-chart').scrollIntoViewIfNeeded();
    const tip = card.locator('[data-fees-auto-tip]');
    for (const index of [0, 1]) {
      const box = await marks.nth(index).boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await tip.waitFor({ timeout: 5_000 });
      const said = await tip.innerText();
      assert.match(said, /^Auto-compound added \$[\d,]+\.\d\d back into your position\.\s+Service fee \$[\d,]+\.\d\d$/, 'the fee the vault paid, read from its transfers');
      const [value, fee] = [...said.matchAll(/\$([\d,]+\.\d+)/g)].map((m) => Number(m[1].replace(/,/g, '')));
      if (index === 0) assert.equal(value, netAdded, 'the NET compound: the tooltip and the Activity say the same figure');
      assert.ok(fee / value > 0.017 && fee / value < 0.024, `a 2 % fee: ${fee} on ${value}`);
      if (index === 1) {
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(shots(), 'desktop-automated-tooltip.png'), clip: await card.boundingBox() });
      }
      await page.mouse.move(5, 5);
      await tip.waitFor({ state: 'detached', timeout: 5_000 });
    }

    // 24H: the last day, no re-add in it: no mark, the lines unchanged.
    await period(card, '24H');
    assert.equal(await card.locator('.dm-chart-series .dm-fees-auto').count(), 0);
    assert.match(await impact.innerText(), /4 times/);
    await page.screenshot({ path: join(shots(), 'desktop-automated-24h.png'), fullPage: true });

    // The price range chart: in range, the band and its ends, the price now, in plain words.
    const range = page.locator('[data-pvr-where]');
    await range.waitFor();
    assert.equal(await range.getAttribute('data-pvr-where'), 'inside');
    assert.match(await range.locator('.dm-pvr-says').innerText(), /In range\s+The price is inside your range, so this position is earning fees\./);
    // The only numbers on its axis: the range's two ends and the price now, each as the header writes it.
    assert.equal(await range.locator('[data-pvr-end="max"]').innerText(), '630.981');
    assert.equal(await range.locator('[data-pvr-end="min"]').innerText(), '197.815');
    assert.equal(await range.locator('[data-pvr-now]').innerText(), await headerPrice(page), 'one price now on the screen');
    assert.match(await page.locator('[data-stat="range"]').innerText(), /^197\.815\s+Your range\s+630\.981\s/);
    assert.deepEqual(await range.locator('.dm-pvr-legend > *').allInnerTexts(), ['Your range', 'Price', 'Prices in UFG for 1 USDG']);
    await rangeCard(page).screenshot({ path: join(shots(), 'desktop-price-range-in.png') });
  } finally { await s.close(); }
});

test('an automated position on a phone: the same two lines and marks, the chart and the price range at 390px', async () => {
  const chain = automated();
  const s = await scenario(chain, '#/positions/2310187', PHONE);
  try {
    const page = s.page;
    const card = page.locator('[data-fees-card][data-fees-state="verified"]');
    await card.waitFor({ timeout: 60_000 });
    assert.equal(await card.locator('[data-automation-impact="compound"]').count(), 1);
    await period(card, 'All');
    assert.equal(await card.locator('.dm-chart-series .dm-fees-auto').count(), 4);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= 390, `no sideways scroll: ${width}px`);
    await page.screenshot({ path: join(shots(), 'phone-automated-all.png'), fullPage: true });
    await period(card, '24H');
    await page.screenshot({ path: join(shots(), 'phone-automated-24h.png'), fullPage: true });
    await page.locator('[data-pvr-where]').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('[data-pvr-now]').innerText(), await headerPrice(page));
    await rangeCard(page).screenshot({ path: join(shots(), 'phone-price-range-in.png') });
  } finally { await s.close(); }
});

test('a Domino-compound position: the line says how many next positions it opened and with how much in fees', async () => {
  // The recording's last collect (no increase) as the vault's MINT of a next position, the four pairs as re-adds.
  const base = automatedChain('2310187', { vault: VAULT, executions: [] });
  const mint = base.fixture.expect.events.filter((event) => event[0] === 'collect').at(-1)[2];
  const executions = [...PAIRS.filter((_, i) => i !== 1).map((prefix) => ({ tx: txOf(base, prefix), action: 0 })), { tx: mint, action: 3, destination: '3999999' }];
  const chain = automatedChain('2310187', { vault: VAULT, owner: ACCOUNTS[0].address, feeBps: 400, executions });
  const s = await scenario(chain, '#/positions/2310187');
  try {
    const card = s.page.locator('[data-fees-card][data-fees-state="verified"]');
    await card.waitFor({ timeout: 60_000 });
    const impact = card.locator('[data-automation-impact="domino"]');
    assert.equal(await impact.count(), 1);
    assert.match(await impact.locator('[data-impact="added"]').innerText(), /^Domino-compound added \$[\d,]+\.\d\d back · 4 times$/);
    assert.match(await impact.locator('[data-impact="opened"]').innerText(), /^Domino-compound opened 1 new position with \$[\d,]+\.\d\d of fees$/);
    await period(card, 'All');
    await card.screenshot({ path: join(shots(), 'desktop-domino-card.png') });
  } finally { await s.close(); }
});

/** The plain position: the recording of NFT 3136705, held by Test Wallet A's address, nothing subscribed. */
const plain = (options = {}) => automatedChain('3136705', { owner: ACCOUNTS[0].address, ...options });

test('a plain position: no automation line, no mark and no vault read; the price range says out of range in words', async () => {
  const chain = plain();
  const s = await scenario(chain, '#/positions/3136705');
  try {
    const page = s.page;
    const card = page.locator('[data-fees-card][data-fees-state="verified"]');
    await card.waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1_500);
    assert.equal(await page.locator('[data-automation-impact]').count(), 0);
    assert.equal(await card.locator('.dm-fees-auto').count(), 0);
    const logs = chain.log.filter((call) => call.method === 'eth_getLogs').map((call) => call.params[0].topics?.[0]);
    assert.ok(!logs.flat().includes('0xa75f5619abce0f39b6b0ace7eb96f20ba345b963b9799beed8451480a406cde0'), 'no vault is read for a plain position');
    const range = page.locator('[data-pvr-where]');
    await range.waitFor();
    assert.equal(await range.getAttribute('data-pvr-where'), 'under');
    assert.match(await range.locator('.dm-pvr-says').innerText(), /Out of range\s+The price is under your range, so this position is not earning fees right now\./);
    assert.equal(await range.locator('.dm-pvr-chip:not([data-in])').count(), 1, 'the price now in the out-of-range colour');
    assert.equal(await range.locator('[data-pvr-now]').innerText(), await headerPrice(page), 'one price now on the screen');
    // Just under the range: its floor's number stays readable, clear of the chip's.
    assert.equal(await range.locator('[data-pvr-end="min"]').innerText(), '440.228');
    const [floor, chip] = await Promise.all([range.locator('[data-pvr-end="min"]').boundingBox(), range.locator('[data-pvr-now]').boundingBox()]);
    assert.ok(floor.y + floor.height <= chip.y, `the floor's number sits above the chip (${floor.y + floor.height} <= ${chip.y})`);
    await period(card, 'All');
    await page.screenshot({ path: join(shots(), 'desktop-plain-all.png'), fullPage: true });
    await period(card, '24H');
    await page.screenshot({ path: join(shots(), 'desktop-plain-24h.png'), fullPage: true });
    await rangeCard(page).screenshot({ path: join(shots(), 'desktop-price-range-out.png') });
  } finally { await s.close(); }
  const phone = await scenario(plain(), '#/positions/3136705', PHONE);
  try {
    const card = phone.page.locator('[data-fees-card][data-fees-state="verified"]');
    await card.waitFor({ timeout: 60_000 });
    await period(card, 'All');
    await phone.page.screenshot({ path: join(shots(), 'phone-plain-all.png'), fullPage: true });
    await period(card, '24H');
    await phone.page.screenshot({ path: join(shots(), 'phone-plain-24h.png'), fullPage: true });
    await phone.page.locator('[data-pvr-where]').scrollIntoViewIfNeeded();
    await rangeCard(phone.page).screenshot({ path: join(shots(), 'phone-price-range-out.png') });
  } finally { await phone.close(); }
});

test('a range that reaches the pool’s limits: the chart labels no end at 0 or ∞ (never a number in exponent form), and its band runs to the edge', async () => {
  // NFT 3136705's pool spaces its ticks by 400: its usable limits are -887,200 and 887,200.
  for (const [ticks, header, label] of [[[337_200, 887_200], /^440\.228\s+Your range\s+∞\s/, 'upper-limit'], [[-887_200, 887_200], /^0\s+Your range\s+∞\s/, 'full-range']]) {
    const s = await scenario(plain({ range: ticks }), '#/positions/3136705');
    try {
      const page = s.page;
      await page.locator('[data-position-detail][data-position-id="3136705"]').waitFor({ timeout: 20_000 });
      assert.match(await page.locator('[data-stat="range"]').innerText(), header);
      const range = page.locator('[data-pvr-where]');
      await range.waitFor();
      const text = await rangeCard(page).innerText();
      assert.doesNotMatch(text, /\de[+-]\d/, `no exponent: ${text}`);
      assert.equal(await range.locator('[data-pvr-end="max"]').count(), 0, 'no number at ∞');
      if (label === 'full-range') {
        assert.equal(await range.locator('[data-pvr-end]').count(), 0, 'no number at 0 either');
        assert.equal(await range.getAttribute('data-pvr-where'), 'inside');
      } else {
        assert.equal(await range.locator('[data-pvr-end="min"]').innerText(), '440.228');
      }
      // The band runs off the plot where the range does, with no edge line there.
      const plot = await range.locator('.dm-pvr').boundingBox();
      const band = await range.locator('.dm-pvr-band').boundingBox();
      assert.ok(Math.abs(band.y - (plot.y + 12)) <= 1, `the band reaches the plot's top (${band.y} vs ${plot.y + 12})`);
      assert.equal(await range.locator('.dm-pvr-edge').count(), label === 'full-range' ? 0 : 1);
      assert.equal(await range.locator('[data-pvr-now]').innerText(), await headerPrice(page));
      await page.waitForTimeout(900);
      await rangeCard(page).screenshot({ path: join(shots(), `desktop-price-range-${label}.png`) });
    } finally { await s.close(); }
  }
});

test('while the history is read the card shows the chain’s unclaimed figure and a calm chart of the drawn one’s size, and the price range its final look at once; both then fill in without a jump', async () => {
  for (const [device, label] of [[DESKTOP, 'desktop'], [PHONE, 'phone']]) {
    const chain = plain();
    // The fees worker's log reads wait until released: the page's own state read (an eth_call) goes through.
    let release;
    const held = new Promise((done) => { release = done; });
    const answer = chain.fetch;
    chain.fetch = async (url, init) => {
      if (/"eth_getLogs"/.test(init.body)) await held;
      return answer(url, init);
    };
    const s = await scenario(chain, '#/positions/3136705', device);
    try {
      const loading = s.page.locator('[data-fees-card][data-fees-state="loading"]');
      await loading.waitFor({ timeout: 20_000 });
      assert.match(await loading.innerText(), /Fees earned[\s\S]*Ready to collect[\s\S]*\$22\.94/, 'the chain’s unclaimed figure, at once, in the key figures’ words (changed on purpose at the integration, 2026-09-27)');
      const skeleton = await loading.locator('.dm-fees-chart-skel').boundingBox();
      // The price range, from the page's own read: the pill, the sentence, the band and the price now, in the chart's
      // final box; no line yet, and nothing of the old preview.
      const range = s.page.locator('[data-pvr-where]');
      await range.waitFor({ timeout: 10_000 });
      assert.equal(await range.getAttribute('data-pvr-line'), null);
      assert.match(await range.locator('.dm-pvr-says').innerText(), /Out of range\s+The price is under your range/);
      assert.equal(await range.locator('[data-pvr-now]').innerText(), await headerPrice(s.page));
      assert.equal(await range.locator('[data-pvr-end="min"]').innerText(), '440.228');
      assert.equal(await rangeCard(s.page).locator('.dm-acct-range-bar, .dm-pos-ends, .dm-pos-preview-wrap').count(), 0);
      const early = await rangeCard(s.page).boundingBox();
      await s.page.waitForTimeout(900);
      await loading.screenshot({ path: join(shots(), `${label}-plain-loading.png`) });
      await rangeCard(s.page).screenshot({ path: join(shots(), `${label}-price-range-early.png`) });
      release();
      const card = s.page.locator('[data-fees-card][data-fees-state="verified"]');
      await card.waitFor({ timeout: 60_000 });
      const drawn = await card.locator('.dm-fees-chart').boundingBox();
      assert.equal(Math.round(drawn.height), Math.round(skeleton.height), 'the chart takes the skeleton’s place at its size');
      await s.page.locator('[data-pvr-where][data-pvr-line]').waitFor({ timeout: 10_000 });
      const late = await rangeCard(s.page).boundingBox();
      assert.equal(Math.round(late.height), Math.round(early.height), 'the price line fills in where the chart already stood');
    } finally { await s.close(); }
  }
});

test('an automated position fills in without a jump: its lines are in the card the first frame it is drawn, and nothing under them moves after', async () => {
  for (const [device, label] of [[DESKTOP, 'desktop'], [PHONE, 'phone']]) {
    // Every frame, where the chart, the activity and the price range stand, from the first frame the card is drawn.
    const watch = () => {
      window.__frames = [];
      const tick = () => {
        const card = document.querySelector('[data-fees-card][data-fees-state="verified"]');
        if (card) {
          const top = (selector) => { const node = document.querySelector(selector); return node ? Math.round(node.getBoundingClientRect().top + scrollY) : null; };
          window.__frames.push({ impact: !!card.querySelector('[data-automation-impact]'), chart: top('.dm-fees-chart'), activity: top('.dm-fees-activity'), range: top('[data-pvr-where]'), height: Math.round(card.getBoundingClientRect().height) });
        }
        if (window.__frames.length < 90) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    const s = await scenario(automated(), '#/positions/2310187', device, watch);
    try {
      await s.page.waitForFunction(() => window.__frames?.length >= 90, null, { timeout: 90_000 });
      const frames = await s.page.evaluate(() => window.__frames);
      assert.equal(frames[0].impact, true, `${label}: the lines come with the card`);
      const moved = frames.filter((frame) => frame.chart !== frames[0].chart || frame.activity !== frames[0].activity || frame.range !== frames[0].range || frame.height !== frames[0].height);
      assert.deepEqual(moved, [], `${label}: nothing moves after the card is drawn (first ${JSON.stringify(frames[0])})`);
    } finally { await s.close(); }
  }
});
