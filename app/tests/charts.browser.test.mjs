/**
 * A position's two charts and what its automation did (round 5, 2026-09-27, the owner's points 3, 5 and 10), on the
 * wallet-test build, the site's own chain routes answered by a fake node (tests/support/browser-chain.mjs routeChain): the
 * Fees earned card (the collected part and the part still waiting on the chart, Auto-compound's re-adds marked where they
 * happened and summed in one or two plain lines) and the Price range chart (the range as a band, the price now and in
 * range or out in words).
 *
 * Changed on purpose 2026-10-02 (RPC-SPEC §11.4, rugged97's rules for the site's token): the history is the position's
 * own ledger (POST /api/fees/v2/ledger: its settlements from its own events and the engine's), not a replay of its pool's
 * swaps, so the positions are tests/support/fees/ledger-world.mjs's: the owner's Auto-compound position as recorded on
 * 2026-09-27 (NFT 3325113, USDG/UFG 4 %, in range, a NET compound and two collect-and-re-add compounds, each paying the
 * 2 % service fee), held by Test Wallet A's address and a test vault; a Domino-compound one; and a plain one with two
 * collects of its owner's, out of range. No time in range and no price line any more: the pool's own history is never
 * read. Prints go to DOMINO_CHART_SHOTS when it is set, and to .test-artifacts otherwise.
 *
 * Changed on purpose 2026-10-02, later (the owner: "the chart had 24 hours, 7 days and all; that went missing"): the
 * period tabs are back, each period from a measured start, read at a past block when the history has none (read-v1
 * `nft-positions` at `blockNumber`, through the site's read bridge: tests/support/read-stub.mjs over the world's
 * pastAnswer, `scenario`'s `past`).
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { routeChain } from './support/browser-chain.mjs';
import { closeBrowser } from './support/close-browser.mjs';
import { createFakeSession } from './support/fake-session.mjs';
import { POOL_MANAGER } from './support/fees/ledger-chain.mjs';
import { HEAD, NOW, OWNER_MINT, OWNER_STEPS, VAULT, ledgerWorld } from './support/fees/ledger-world.mjs';
import { createReadStub, gatewayError } from './support/read-stub.mjs';
import { NODE_LOG_BLOCKS, NODE_LOG_FLOOR } from './support/log-limits.mjs';
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
const ID = '3325113';
const HASH = `#/positions/${ID}`;
const EXECUTION_COMPLETED = '0xa75f5619abce0f39b6b0ace7eb96f20ba345b963b9799beed8451480a406cde0';
/** A pool's own history, which no route reads (rugged97's rule 2): Swap, Initialize, Donate. */
const POOL_HISTORY = ['0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f', '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438', '0x29ef05caaff9404b7cb6d1c0e9bbae9eaa7ab2541feba1a9c4248594c08156cb'];
/** What the product rules keep off these screens (finance.browser.test.mjs FORBIDDEN), and no technical words. */
const FORBIDDEN = /not connected yet|not enabled|coming soon|\bbeta\b|\balpha\b|\bv4\b|sample|practice|tick spacing|liquidity units|sqrt|est\./i;

/** The owner's Auto-compound position, held by Test Wallet A's address. */
const automated = (more = {}) => ledgerWorld({ holder: ACCOUNTS[0].address, ...more });
/** A plain position: its owner collected twice; out of range unless `range` says otherwise (the pool's tick is 334,389). */
const plain = (more = {}) =>
  ledgerWorld({
    holder: ACCOUNTS[0].address,
    vault: null,
    range: [335_200, 339_200],
    steps: [
      { block: 73_468_040, kind: 'collect', fees: [13_102_257n, 1_126_639_544_530_725_964_113n] },
      { block: 73_705_363, kind: 'collect', fees: [4_425_004n, 836_433_380_491_496_904_379n] },
    ],
    ...more,
  });

/** The calls of one POST to the node (a batch or one). */
const callsOf = (init) => [JSON.parse(init.body)].flat();
/** Whether a POST reads the vault's own logs (the record route): every one of its executions' reads. */
const readsVault = (init) => callsOf(init).some((call) => call.method === 'eth_getLogs' && [call.params[0]?.address].flat().some((one) => String(one).toLowerCase() === VAULT));

/**
 * The wallet-test build on `hash`, the site's chain routes answered over `world`'s chain; no other route reads the chain.
 * `past` (2026-10-02, the chart's periods): the site's read bridge lists read-v1 `nft-positions` alone and answers it at a
 * past block from the world (`past(block)`, a JSON text, a Response or a promise of one; `true`: world.pastAnswer), every
 * question kept in `reads`; without it the bridge is not there, as before.
 */
async function scenario(world, hash, device = DESKTOP, init = null, { past = null } = {}) {
  const fake = createFakeSession();
  const asked = [];
  const reads = [];
  const answer = past === true ? (block) => world.pastAnswer(block) : past;
  const read = answer
    ? createReadStub({
        reads: 'nft-positions',
        answer: (route, body) => {
          if (route !== 'nft-positions') return gatewayError('route_not_available', 404);
          reads.push(body);
          return answer(body.blockNumber, body);
        },
      })
    : null;
  const server = createWalletServer({ fake, dist: resolve(import.meta.dirname, '../.wallet-test-dist'), routes: [async (request, url) => {
    if (read && url.pathname.startsWith('/api/read/')) return read.handle(request, url);
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
  const rpc = await routeChain(context, world.chain);
  const wallet = await installWallets(context);
  const page = await context.newPage();
  if (init) await page.addInitScript(init);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/${hash}`);
  return {
    page,
    asked,
    reads,
    async close() {
      await context.close();
      await server.closeAll();
      assert.deepEqual(errors, []);
      assert.deepEqual(wallet.state.csp, []);
      assert.deepEqual(rpc.publicAsked, [], 'no public node is asked');
      assert.deepEqual(rpc.errors, [], 'the node was asked only what it answers');
    },
  };
}

/** Every log read the node answered keeps to rugged97's rules: nothing below the floor, no wide window, no pool history. */
function keptToTheRules(world) {
  assert.ok(world.asked.length > 0);
  for (const filter of world.asked) {
    const what = JSON.stringify(filter);
    assert.ok(filter.from >= NODE_LOG_FLOOR, `below the floor: ${what}`);
    assert.ok(filter.to - filter.from + 1 <= NODE_LOG_BLOCKS, `a window past 1,000,000 blocks: ${what}`);
    if ([filter.address].flat().map((one) => String(one).toLowerCase()).includes(POOL_MANAGER)) assert.equal(filter.from, filter.to, `the PoolManager over more than one block: ${what}`);
    assert.ok(![filter.topics[0]].flat().some((topic) => POOL_HISTORY.includes(topic)), `a pool's history: ${what}`);
  }
}

/**
 * The key figures' Current price figure (`0.00252025` of "1 UFG = 0.00252025 USDG"), which the chart's price now
 * repeats exactly (lib/read/orientation.ts: UFG's price in USDG).
 */
async function headerPrice(page) {
  return (await page.locator('[data-stat="price"] [data-current-price="usable"] .dm-fig-lg').innerText()).trim();
}

/** The Price range card around the chart. */
const rangeCard = (page) => page.locator('section.dm-pos-card:has([data-range])');

/** The growth line's figure from the world's liquidity: the automation's re-adds against the owner's mint. */
function growthOf(steps = OWNER_STEPS) {
  const auto = steps.filter((step) => step.kind === 'net' || step.kind === 'compound').reduce((sum, step) => sum + step.delta, 0n);
  return `Your position grew ${((Number((auto * 1_000_000n) / OWNER_MINT.liquidity) / 1_000_000) * 100).toFixed(2)}% from fees`;
}

test('an automated position: the card says in two lines what Auto-compound put back and how much the position grew, marks each re-add on the chart, and its tooltip says it plainly', async () => {
  const world = automated();
  const s = await scenario(world, HASH, DESKTOP, null, { past: true });
  try {
    const page = s.page;
    await page.locator(`[data-position-detail][data-position-id="${ID}"]`).waitFor({ timeout: 20_000 });
    const card = page.locator('[data-fees-card][data-fees-state="verified"]');
    await card.waitFor({ timeout: 60_000 });
    // The chart is the ledger's; the attribution appears once the vault's record covers its settlements.
    const impact = card.locator('[data-automation-impact="compound"]');
    await impact.locator('[data-impact="added"]').filter({ hasText: /^Auto-compound added \$[\d,]+\.\d\d back · 3 times$/ }).waitFor({ timeout: 20_000 });
    assert.equal(await impact.count(), 1, 'the complete automation attribution is present');
    assert.equal(await impact.locator('[data-impact="growth"]').innerText(), growthOf(), 'the re-adds against the mint');
    assert.equal(await impact.locator('[data-impact="opened"]').count(), 0, 'Auto-compound opens no new position');
    // Every read of the node kept to its rules, and no other route of the site was asked.
    keptToTheRules(world);
    assert.ok(world.asked.some((filter) => [filter.topics[0]].flat().includes(EXECUTION_COMPLETED)), 'the vault’s record was read');
    assert.deepEqual(s.asked, []);

    // Your APR since opened, from the ledger at today's prices; the last 24 hours from the mint, a measured point a day old.
    const apr = page.locator('[data-cell="apr"][data-apr="ready"]');
    await apr.waitFor({ timeout: 10_000 });
    assert.match(await apr.innerText(), /^YOUR APR\s+[\d,]+(\.\d)?%\s+Since opened \(\d+ hours\)\s+Last 24 hours: [\d,]+(\.\d)?%$/);
    assert.doesNotMatch(await apr.innerText(), /est\./);

    // The Activity says which settlements were the automation's: each compound one row, "Fees added back".
    assert.equal(await card.locator('.dm-fees-act').count(), 0, 'the card lists no activity on the position’s page');
    const activity = page.locator('[data-position-activity]');
    await activity.waitFor({ timeout: 10_000 });
    const more = activity.getByRole('button', { name: /^Show \d+ more$/ });
    if (await more.count()) await more.click();
    assert.deepEqual(await activity.locator('.dm-fees-act[data-auto] .dm-fees-act-verb').allInnerTexts(), ['Fees added back', 'Fees added back', 'Fees added back']);
    // The NET compound (one increase that settled the fees itself) is one row too, its value what went back in.
    const net = activity.locator(`.dm-fees-act[data-tx="${world.events.txs[0]}"]`);
    assert.equal(await net.count(), 1);
    assert.equal(await net.locator('.dm-fees-act-verb').innerText(), 'Fees added back');

    // The chart: the three re-adds marked, the part still waiting drawn.
    const marks = card.locator('.dm-fees-auto');
    assert.equal(await marks.count(), 3);
    assert.equal(await card.locator('.dm-fees-waiting').count(), 1, 'the part still waiting is drawn');
    // Changed on purpose 2026-10-02, later (the owner): the period tabs are back. A day old, it offers 24H and All; its 24H
    // starts at the mint, a measured point a day old, so nothing is read for it and nothing is added beside the hero.
    assert.deepEqual(await card.getByRole('radio').allInnerTexts(), ['24H', 'All'], 'its periods');
    assert.equal(await card.getAttribute('data-fees-period'), '24h');
    assert.equal(await card.getAttribute('data-fees-period-state'), 'drawn');
    assert.equal(await card.locator('.dm-fees-delta').count(), 0, 'a period from the mint says nothing the hero does not');
    // Its 24H line from the mint may be filled where it has a long stretch (at most twice); no start is read.
    assert.ok(s.reads.length <= 2 && s.reads.every((body) => body.tokenIds.length === 1 && body.tokenIds[0] === ID), `fills only: ${JSON.stringify(s.reads)}`);
    assert.equal(await card.locator('.dm-fees-tir').count(), 0, 'no time in range');
    assert.doesNotMatch(await card.innerText(), FORBIDDEN);
    await page.screenshot({ path: join(shots(), 'desktop-automated-all.png'), fullPage: true });

    // Hovering each re-add: the tooltip says what Auto-compound put back and the service fee the engine took, plainly.
    await card.locator('.dm-fees-chart').scrollIntoViewIfNeeded();
    const tip = card.locator('[data-fees-auto-tip]');
    for (const index of [0, 1]) {
      const box = await marks.nth(index).boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await tip.waitFor({ timeout: 5_000 });
      const said = await tip.innerText();
      assert.match(said, /^Auto-compound added \$[\d,]+\.\d\d back into your position\.\s+Service fee \$[\d,]+\.\d{2,6}$/, said);
      const [value, fee] = [...said.matchAll(/\$([\d,]+\.\d+)/g)].map((m) => Number(m[1].replace(/,/g, '')));
      assert.ok(value > 0 && fee > 0 && fee < value, `the engine's own service fee: ${fee} on ${value}`);
      if (index === 1) {
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(shots(), 'desktop-automated-tooltip.png'), clip: await card.boundingBox() });
      }
      await page.mouse.move(5, 5);
      await tip.waitFor({ state: 'detached', timeout: 5_000 });
    }

    // The price range chart: in range, the band and its ends, the price now, in plain words; no line of the pool's prices.
    const range = page.locator('[data-pvr-where]');
    await range.waitFor();
    assert.equal(await range.getAttribute('data-pvr-where'), 'inside');
    assert.equal(await range.getAttribute('data-pvr-line'), null, 'no price line: the pool’s own history is never read');
    assert.match(await range.locator('.dm-pvr-says').innerText(), /In range\s+The price is inside your range, so this position is earning fees\./);
    assert.equal(await range.locator('[data-pvr-now]').innerText(), await headerPrice(page), 'one price now on the screen');
    const [low, high] = [await range.locator('[data-pvr-end="min"]').innerText(), await range.locator('[data-pvr-end="max"]').innerText()];
    assert.match(await page.locator('[data-stat="range"]').innerText(), new RegExp(`^${low.replaceAll('.', '[.]')}\\s+Your range\\s+${high.replaceAll('.', '[.]')}\\s`));
    assert.deepEqual(await range.locator('.dm-pvr-legend > *').allInnerTexts(), ['Your range', 'Prices in USDG for 1 UFG']);
    assert.match(await page.locator('[data-stat="price"]').innerText(), /1 UFG =\s+0\.00\d+\s+USDG/);
    await rangeCard(page).screenshot({ path: join(shots(), 'desktop-price-range-in.png') });
  } finally { await s.close(); }
});

test('an automated position on a phone: the same two lines and marks, the chart and the price range at 390px', async () => {
  const s = await scenario(automated(), HASH, PHONE);
  try {
    const page = s.page;
    const card = page.locator('[data-fees-card][data-fees-state="verified"]');
    await card.waitFor({ timeout: 60_000 });
    await card.locator('[data-automation-impact="compound"] [data-impact="added"]').filter({ hasText: /^Auto-compound added \$[\d,]+\.\d\d back · 3 times$/ }).waitFor({ timeout: 20_000 });
    assert.equal(await card.locator('[data-automation-impact="compound"]').count(), 1);
    assert.equal(await card.locator('.dm-fees-auto').count(), 3);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= 390, `no sideways scroll: ${width}px`);
    await page.screenshot({ path: join(shots(), 'phone-automated-all.png'), fullPage: true });
    await page.locator('[data-pvr-where]').scrollIntoViewIfNeeded();
    assert.equal(await page.locator('[data-pvr-now]').innerText(), await headerPrice(page));
    await rangeCard(page).screenshot({ path: join(shots(), 'phone-price-range-in.png') });
  } finally { await s.close(); }
});

test('a Domino-compound position: the chart draws before the vault’s record, then the line says how many next positions it opened and with how much in fees', { timeout: 90_000 }, async () => {
  // The three compounds as re-adds, then a move of the fees to a next position (a MINT whose destination is another NFT).
  const world = automated({ feeBps: 400, steps: [...OWNER_STEPS, { block: 73_900_000, kind: 'domino', fees: [2_000_000n, 400_000_000_000_000_000_000n], destination: 3_999_999n }] });
  // Hold the vault's record, not the ledger: the verified chart must not wait for its attribution.
  let release, started;
  const held = new Promise((done) => { release = done; });
  const recordStarted = new Promise((done) => { started = done; });
  const answer = world.chain.fetch;
  world.chain.fetch = async (url, init) => {
    if (readsVault(init)) {
      started();
      await held;
    }
    return answer(url, init);
  };
  const s = await scenario(world, HASH);
  try {
    const card = s.page.locator('[data-fees-card][data-fees-state="verified"]');
    await Promise.all([card.waitFor({ timeout: 60_000 }), recordStarted]);
    assert.equal(await card.locator('.dm-fees-chart').count(), 1, 'the verified chart does not wait for attribution');
    assert.equal(await card.locator('[data-automation-impact]').count(), 0, 'nothing presented before the record is read');
    release();
    const impact = card.locator('[data-automation-impact="domino"]');
    const added = impact.locator('[data-impact="added"]');
    await added.filter({ hasText: /^Domino-compound added \$[\d,]+\.\d\d back · 3 times$/ }).waitFor({ timeout: 20_000 });
    assert.equal(await impact.count(), 1);
    assert.match(await impact.locator('[data-impact="opened"]').innerText(), /^Domino-compound opened 1 new position with \$[\d,]+\.\d\d of fees$/);
    await card.screenshot({ path: join(shots(), 'desktop-domino-card.png') });
  } finally { release(); await s.close(); }
});

test('a plain position: no automation line, no mark and no vault read; the price range says out of range in words', async () => {
  const world = plain();
  const s = await scenario(world, HASH);
  try {
    const page = s.page;
    const card = page.locator('[data-fees-card][data-fees-state="verified"]');
    await card.waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1_500);
    assert.equal(await page.locator('[data-automation-impact]').count(), 0);
    assert.equal(await card.locator('.dm-fees-auto').count(), 0);
    assert.equal(await card.locator('.dm-fees-chart').count(), 1, 'opened, two collects and now: the chart is drawn');
    assert.ok(!world.asked.some((filter) => [filter.topics[0]].flat().includes(EXECUTION_COMPLETED)), 'no vault is read for a plain position');
    keptToTheRules(world);
    const activity = page.locator('[data-position-activity]');
    await activity.waitFor({ timeout: 10_000 });
    assert.equal(await activity.locator('.dm-fees-act[data-auto]').count(), 0);
    assert.equal(await activity.locator('.dm-fees-act[data-kind="collect"]').count(), 2, 'the owner’s two collects');
    const range = page.locator('[data-pvr-where]');
    await range.waitFor();
    // UFG's price in USDG sits over this range (the pool's tick is under its lower one).
    assert.equal(await range.getAttribute('data-pvr-where'), 'over');
    assert.match(await range.locator('.dm-pvr-says').innerText(), /Out of range\s+The price is over your range, so this position is not earning fees right now\./);
    assert.equal(await range.locator('.dm-pvr-chip:not([data-in])').count(), 1, 'the price now in the out-of-range colour');
    assert.equal(await range.locator('[data-pvr-now]').innerText(), await headerPrice(page), 'one price now on the screen');
    // Just over the range: its ceiling's number stays readable, clear of the chip's.
    const [ceiling, chip] = await Promise.all([range.locator('[data-pvr-end="max"]').boundingBox(), range.locator('[data-pvr-now]').boundingBox()]);
    assert.ok(ceiling.y >= chip.y + chip.height, `the ceiling's number sits under the chip (${ceiling.y} >= ${chip.y + chip.height})`);
    await page.screenshot({ path: join(shots(), 'desktop-plain-all.png'), fullPage: true });
    await rangeCard(page).screenshot({ path: join(shots(), 'desktop-price-range-out.png') });
  } finally { await s.close(); }
  const phone = await scenario(plain(), HASH, PHONE);
  try {
    const card = phone.page.locator('[data-fees-card][data-fees-state="verified"]');
    await card.waitFor({ timeout: 60_000 });
    await phone.page.screenshot({ path: join(shots(), 'phone-plain-all.png'), fullPage: true });
    await phone.page.locator('[data-pvr-where]').scrollIntoViewIfNeeded();
    await rangeCard(phone.page).screenshot({ path: join(shots(), 'phone-price-range-out.png') });
  } finally { await phone.close(); }
});

test('a position whose owner added liquidity by hand: Fees ready to collect stays exact, and the card says plainly that Fees earned can’t be measured', async () => {
  const world = plain({ range: [327_200, 339_200], steps: [{ block: 73_468_040, kind: 'increase', delta: 1_000_000_000n }] });
  const s = await scenario(world, HASH);
  try {
    const card = s.page.locator('[data-fees-card][data-fees-state="unclaimed-only"]');
    await card.waitFor({ timeout: 60_000 });
    assert.equal(await card.getAttribute('data-fees-reason'), 'not_exact');
    assert.match(await card.innerText(), /Ready to collect[\s\S]*\$[\d,]+\.\d\d[\s\S]*Fees earned can’t be measured for this position\. Fees ready to collect is exact\./);
    const apr = s.page.locator('[data-cell="apr"]');
    await apr.filter({ hasText: 'Not measured for this position' }).waitFor({ timeout: 10_000 });
    assert.doesNotMatch(await s.page.locator('body').innerText(), /Retry|Try again/);
  } finally { await s.close(); }
});

/**
 * Where the key figures' Current price bar puts the price now (KeyFigures.tsx RangeLine: the range from 5% to 95% of the
 * bar on a log price axis, a price beyond an end at 1.5% or 98.5%), from the prices the page writes: the range's ends
 * and the price now, as `share` of the bar. And the words the Price range card and that bar say it in (PositionRange.tsx
 * rangeWords and CurrentPrice, whose "beyond the drawn axis" is chainCardPrice's bar scale: the range widened by a
 * quarter of its own width on each side).
 */
async function priceOnBar(page) {
  const range = page.locator('[data-pvr-where]');
  await range.waitFor({ timeout: 20_000 });
  const nowText = await headerPrice(page);
  const [min, max, now] = [Number(await range.locator('[data-pvr-end="min"]').innerText()), Number(await range.locator('[data-pvr-end="max"]').innerText()), Number(nowText)];
  const span = Math.log(max / min);
  const share = Math.log(now / min) / span;
  const want = share < 0 ? 0.015 : share > 1 ? 0.985 : 0.05 + 0.9 * share;
  const at = await page.locator('[data-stat="range"] .dm-range-now').evaluate((dot) => parseFloat(dot.style.left) / 100);
  const beyond = Math.log(now / max) > span / 4 || Math.log(min / now) > span / 4;
  const label = await page.locator('[data-stat="range"] [role="img"]').getAttribute('aria-label');
  const words = (await page.locator('[data-range] .dm-acct-range-now').textContent()).replace(/\s+/g, ' ').trim();
  // The price now as a pattern: its point a literal point.
  return { min, max, now, nowText: nowText.replaceAll('.', '[.]'), share, want, at, beyond, label, words };
}

// Added 2026-09-28 (one-sided, review, the owner: "UFG's price is falling, but my position's range is rising"): the dot
// on the Current price bar and the Price range card's words are the app's one way round, UFG's price in USDG, as the
// chart is.
test('the Current price bar puts UFG’s price where the chart does: inside its range where it is; over the range, past its high end; and the words agree', async () => {
  const inRange = await scenario(automated(), HASH);
  try {
    const bar = await priceOnBar(inRange.page);
    assert.ok(bar.share > 0 && bar.share < 1, `UFG inside its range: ${bar.now} in ${bar.min} to ${bar.max}`);
    assert.ok(Math.abs(bar.at - bar.want) < 0.01, `the dot at ${bar.at}, where the chart's prices put it: ${bar.want}`);
    assert.match(bar.words, new RegExp(`^Pool price ≈?${bar.nowText} USDG per UFG at block [0-9]+ · inside this range$`), bar.words);
    assert.match(bar.label, new RegExp(`; pool price ≈?${bar.nowText} at block [0-9]+, inside this range$`), bar.label);
  } finally { await inRange.close(); }
  // Just over its range, then a range far under UFG's price: past the drawn axis, on the high side.
  for (const [range, far] of [[[335_200, 339_200], false], [[341_200, 342_000], true]]) {
    const out = await scenario(plain({ range }), HASH);
    try {
      const bar = await priceOnBar(out.page);
      assert.equal(await out.page.locator('[data-pvr-where]').getAttribute('data-pvr-where'), 'over');
      assert.ok(bar.share > 1, `UFG's price over its range: ${bar.now} over ${bar.max}`);
      assert.equal(bar.beyond, far, `${bar.now} against ${bar.min} to ${bar.max}`);
      assert.ok(Math.abs(bar.at - 0.985) < 0.001, `the dot past the bar's high end: ${bar.at}`);
      const beyond = far ? ', beyond the drawn axis' : '';
      assert.match(bar.words, new RegExp(`^Pool price ≈?${bar.nowText} USDG per UFG at block [0-9]+ · above this range${beyond}$`), bar.words);
      assert.match(bar.label, new RegExp(`; pool price ≈?${bar.nowText} at block [0-9]+, above this range${beyond}$`), bar.label);
    } finally { await out.close(); }
  }
});

test('a range that reaches the pool’s limits: the chart labels no end at 0 or ∞ (never a number in exponent form), and its band runs to the edge', async () => {
  // The pool spaces its ticks by 400: its usable limits are -887,200 and 887,200. UFG's price in USDG, so the pool's upper
  // limit is the range's price 0, and the band runs off the plot's foot.
  for (const [ticks, label] of [[[335_200, 887_200], 'lower-limit'], [[-887_200, 887_200], 'full-range']]) {
    const s = await scenario(plain({ range: ticks }), HASH);
    try {
      const page = s.page;
      await page.locator(`[data-position-detail][data-position-id="${ID}"]`).waitFor({ timeout: 20_000 });
      const range = page.locator('[data-pvr-where]');
      await range.waitFor({ timeout: 20_000 });
      const header = label === 'full-range' ? /^0\s+Your range\s+∞\s/ : new RegExp(`^0\\s+Your range\\s+${(await range.locator('[data-pvr-end="max"]').innerText()).replaceAll('.', '[.]')}\\s`);
      assert.match(await page.locator('[data-stat="range"]').innerText(), header);
      const text = await rangeCard(page).innerText();
      assert.doesNotMatch(text, /\de[+-]\d/, `no exponent: ${text}`);
      assert.equal(await range.locator('[data-pvr-end="min"]').count(), 0, 'no number at 0');
      if (label === 'full-range') {
        assert.equal(await range.locator('[data-pvr-end]').count(), 0, 'no number at ∞ either');
        assert.equal(await range.getAttribute('data-pvr-where'), 'inside');
      }
      // The band runs off the plot where the range does, with no edge line there: its foot at 0, and its top too at ∞.
      const plot = await range.locator('.dm-pvr').boundingBox();
      const band = await range.locator('.dm-pvr-band').boundingBox();
      assert.ok(Math.abs(band.y + band.height - (plot.y + plot.height - 30)) <= 1, `the band reaches the plot's foot (${band.y + band.height} vs ${plot.y + plot.height - 30})`);
      if (label === 'full-range') assert.ok(Math.abs(band.y - (plot.y + 12)) <= 1, `the band reaches the plot's top (${band.y} vs ${plot.y + 12})`);
      assert.equal(await range.locator('.dm-pvr-edge').count(), label === 'full-range' ? 0 : 1);
      assert.equal(await range.locator('[data-pvr-now]').innerText(), await headerPrice(page));
      await page.waitForTimeout(900);
      await rangeCard(page).screenshot({ path: join(shots(), `desktop-price-range-${label}.png`) });
    } finally { await s.close(); }
  }
});

test('while the ledger is read the card shows the chain’s unclaimed figure and a calm chart of the drawn one’s size, and the price range its final look at once; the chart then takes its place without a jump', async () => {
  for (const [device, label] of [[DESKTOP, 'desktop'], [PHONE, 'phone']]) {
    const world = plain();
    // The ledger's log reads wait until released: the page's own state read (an eth_call) goes through.
    let release;
    const held = new Promise((done) => { release = done; });
    const answer = world.chain.fetch;
    world.chain.fetch = async (url, init) => {
      if (callsOf(init).some((call) => call.method === 'eth_getLogs')) await held;
      return answer(url, init);
    };
    const s = await scenario(world, HASH, device);
    try {
      const loading = s.page.locator('[data-fees-card][data-fees-state="loading"]');
      await loading.waitFor({ timeout: 20_000 });
      assert.match(await loading.innerText(), /Fees earned[\s\S]*Ready to collect[\s\S]*\$[\d,]+\.\d\d/, 'the chain’s unclaimed figure, at once, in the key figures’ words');
      const skeleton = await loading.locator('.dm-fees-chart-skel').boundingBox();
      // The price range, from the page's own read: the pill, the sentence, the band and the price now, in the chart's
      // final box, and no line (none is ever drawn: the pool's own history is not read).
      const range = s.page.locator('[data-pvr-where]');
      await range.waitFor({ timeout: 10_000 });
      assert.equal(await range.getAttribute('data-pvr-line'), null);
      assert.match(await range.locator('.dm-pvr-says').innerText(), /Out of range\s+The price is over your range/);
      assert.equal(await range.locator('[data-pvr-now]').innerText(), await headerPrice(s.page));
      assert.equal(await rangeCard(s.page).locator('.dm-acct-range-bar, .dm-pos-ends, .dm-pos-preview-wrap').count(), 0);
      const early = await rangeCard(s.page).boundingBox();
      await s.page.waitForTimeout(900);
      await loading.screenshot({ path: join(shots(), `${label}-plain-loading.png`) });
      release();
      const card = s.page.locator('[data-fees-card][data-fees-state="verified"]');
      await card.waitFor({ timeout: 60_000 });
      const drawn = await card.locator('.dm-fees-chart').boundingBox();
      assert.equal(Math.round(drawn.height), Math.round(skeleton.height), 'the chart takes the skeleton’s place at its size');
      await s.page.waitForTimeout(500);
      const late = await rangeCard(s.page).boundingBox();
      assert.equal(Math.round(late.height), Math.round(early.height), 'the price range never moved');
      assert.equal(await range.getAttribute('data-pvr-line'), null);
    } finally { await s.close(); }
  }
});

test('an automated position fills in without a jump: its chart draws before attribution and the reserved lines keep everything below stable', { timeout: 120_000 }, async () => {
  for (const [device, label] of [[DESKTOP, 'desktop'], [PHONE, 'phone']]) {
    // Capture the whole staged arrival. The sequence is already known; its record waits.
    const watch = () => {
      window.__frames = [];
      const tick = () => {
        const card = document.querySelector('[data-fees-card][data-fees-state="verified"]');
        if (card) {
          const top = (selector) => { const node = document.querySelector(selector); return node ? Math.round(node.getBoundingClientRect().top + scrollY) : null; };
          window.__frames.push({ impact: !!card.querySelector('[data-automation-impact]'), chart: top('.dm-fees-chart'), activity: top('[data-position-activity]'), range: top('[data-pvr-where]'), height: Math.round(card.getBoundingClientRect().height) });
        }
        if (!window.__stopFrames && window.__frames.length < 5000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    const world = automated();
    let release, started;
    const held = new Promise((done) => { release = done; });
    const recordStarted = new Promise((done) => { started = done; });
    const answer = world.chain.fetch;
    world.chain.fetch = async (url, init) => {
      if (readsVault(init)) {
        started();
        await held;
      }
      return answer(url, init);
    };
    // 2026-10-02 (the chart's periods): with the site's read bridge listing read-v1 nft-positions, as deployed, so the
    // card's period tabs are there from its first frame (without it they are offered until the check says otherwise).
    const s = await scenario(world, HASH, device, watch, { past: true });
    try {
      await Promise.all([
        s.page.waitForFunction(() => window.__frames?.length >= 10, null, { timeout: 60_000 }),
        recordStarted,
      ]);
      const card = s.page.locator('[data-fees-card][data-fees-state="verified"]');
      assert.equal(await card.locator('.dm-fees-chart').count(), 1, `${label}: the chart does not wait for attribution`);
      assert.equal(await card.locator('[data-automation-impact]').count(), 0, `${label}: no incomplete totals`);
      assert.equal(await card.locator('.dm-fees-impact-slot[data-kind="compound"]').count(), 1, `${label}: the known sequence reserves its lines`);
      release();
      const impact = card.locator('[data-automation-impact="compound"]');
      await impact.locator('[data-impact="added"]').filter({ hasText: /^Auto-compound added \$[\d,]+\.\d\d back · 3 times$/ }).waitFor({ timeout: 20_000 });
      assert.equal(await impact.locator('[data-impact="growth"]').innerText(), growthOf());
      await s.page.waitForFunction(() => window.__frames.filter((frame) => frame.impact).length >= 90, null, { timeout: 10_000 });
      await s.page.evaluate(() => { window.__stopFrames = true; });
      const frames = await s.page.evaluate(() => window.__frames);
      assert.equal(frames[0].impact, false, `${label}: the chart was drawn before its complementary read`);
      assert.equal(frames.at(-1).impact, true, `${label}: capture includes completed attribution`);
      const moved = frames.filter((frame) => frame.chart !== frames[0].chart || frame.range !== frames[0].range || frame.height !== frames[0].height);
      assert.deepEqual(moved, [], `${label}: chart, range and card never move during attribution (first ${JSON.stringify(frames[0])})`);
      // Activity appears only once its automation labels are known. From its first appearance onward its anchor stays.
      const activityTops = frames.map((frame) => frame.activity).filter((top) => top !== null);
      assert.ok(activityTops.length > 0, `${label}: activity eventually appears`);
      assert.equal(new Set(activityTops).size, 1, `${label}: visible activity never moves`);
    } finally { release(); await s.close(); }
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 2026-10-02, later (the owner: "the chart had 24 hours, 7 days and all; that went missing"): the periods are back, each
// from a measured start; one the history lacks is read at a past block (src/lib/fees/pastReads.ts), on its period's grid.
// ---------------------------------------------------------------------------------------------------------------------

/** The owner's position eight days on: its settlements all more than a week old, so a day and a week back need a read. */
const LONG = { head: HEAD + 8 * 864_000, now: NOW + 8 * 86_400 };
const DAY_GRID = 36_000;
const WEEK_GRID = 216_000;
/** The plot's box under the card's period (the chart, its skeleton or its quiet line). */
const plotBox = async (card) => card.locator('.dm-fees-body > :last-child').boundingBox();

test('a position eight days old: 24H, 7D, 30D and All; 7D first, its start read at a past block while the chart keeps its box, then its line and what it earned since; Your APR’s last 24 hours from the day’s read; four reads, none for a start again on a reload', { timeout: 120_000 }, async () => {
  const world = automated(LONG);
  // The first read waits until the test lets it go: the card's figures are exact meanwhile, the plot a skeleton.
  let release;
  const held = new Promise((done) => { release = done; });
  let first = true;
  const s = await scenario(world, HASH, DESKTOP, null, {
    past: async (block) => {
      if (first) { first = false; await held; }
      return world.pastAnswer(block);
    },
  });
  try {
    const page = s.page;
    const card = page.locator('[data-fees-card][data-fees-state="verified"]');
    await card.waitFor({ timeout: 60_000 });
    assert.deepEqual(await card.getByRole('radio').allInnerTexts(), ['24H', '7D', '30D', 'All']);
    assert.equal(await card.getAttribute('data-fees-period'), '7d', 'past 36 hours: 7D first');
    await page.locator('[data-fees-card][data-fees-period="7d"][data-fees-period-state="reading"] [data-fees-plot="reading"] .dm-fees-chart-skel').waitFor({ timeout: 20_000 });
    assert.match(await card.locator('.dm-fees-hero').innerText(), /\$[\d,]+\.\d\d/, 'the hero is exact while the start is read');
    const skeleton = await plotBox(card);
    assert.equal(await card.locator('.dm-fees-delta').count(), 0);
    release();
    await page.locator('[data-fees-card][data-fees-period="7d"][data-fees-period-state="drawn"] .dm-fees-chart').waitFor({ timeout: 20_000 });
    const drawn = await plotBox(card);
    assert.ok(Math.abs(drawn.height - skeleton.height) <= 4, `the chart takes the skeleton's box: ${drawn.height} vs ${skeleton.height}`);
    // Its start: a read on the 7D grid, a week back.
    const week = Number(await card.getAttribute('data-fees-period-from'));
    assert.equal(week % WEEK_GRID, 0, `on the 7D grid: ${week}`);
    const age = (LONG.now - world.timeAt(week)) / 86_400;
    assert.ok(age >= 7 && age <= 7.5, `a week back: ${age} days`);
    assert.ok(s.reads.some((body) => body.blockNumber === week && body.tokenIds.length === 1 && body.tokenIds[0] === ID), 'one id, at that block');
    // What it earned since then, beside the hero, and where that is measured from.
    const delta = card.locator('.dm-fees-delta');
    assert.match((await delta.innerText()).replace(/\s+/g, ''), /^\+\$[\d,]+\.\d\d$/);
    assert.match(await delta.getAttribute('title'), new RegExp(`^Earned since \\d\\d-\\d\\d \\d\\d:\\d\\d UTC \\(7 days\\), measured at block ${week}$`));
    // Your APR: the last 24 hours from the day's read, which its line names.
    const day = page.locator('[data-cell="apr"][data-apr="ready"] [data-apr-day]');
    await day.waitFor({ timeout: 20_000 });
    assert.match(await day.innerText(), /^Last 24 hours: [\d,]+(\.\d)?%$/);
    const dayBlock = Number((await day.getAttribute('title')).match(/block (\d+)/)[1]);
    assert.equal(dayBlock % DAY_GRID, 0, `on the 24H grid: ${dayBlock}`);
    assert.match(await day.getAttribute('title'), /^Measured from \d\d-\d\d \d\d:\d\d UTC, block \d+, to now \(2[45] hours\)$/);
    // Each period without a jump: the plot keeps its box; 24H from the day's read, 30D and All from the mint.
    const tab = (name) => card.getByRole('radio', { name, exact: true });
    await tab('24H').click();
    await page.locator(`[data-fees-card][data-fees-period="24h"][data-fees-period-state="drawn"][data-fees-period-from="${dayBlock}"] .dm-fees-chart`).waitFor({ timeout: 10_000 });
    assert.match(await card.locator('.dm-fees-delta').getAttribute('title'), /\(2[45] hours\), measured at block \d+$/);
    assert.ok(Math.abs((await plotBox(card)).height - drawn.height) <= 4, '24H: no jump');
    for (const name of ['30D', 'All']) {
      await tab(name).click();
      const period = name === '30D' ? '30d' : 'all';
      await page.locator(`[data-fees-card][data-fees-period="${period}"][data-fees-period-state="drawn"] .dm-fees-chart`).waitFor({ timeout: 10_000 });
      assert.equal(await card.locator('.dm-fees-delta').count(), 0, `${name} starts at the mint: nothing beside the hero`);
      assert.ok(Math.abs((await plotBox(card)).height - drawn.height) <= 4, `${name}: no jump`);
    }
    assert.doesNotMatch(await card.innerText(), FORBIDDEN);
    await tab('7D').click();
    await card.locator('.dm-fees-chart').waitFor();
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(shots(), 'desktop-automated-7d.png'), fullPage: true });
    // The week's fills join (six seconds apart), then nothing more: two starts and two fills.
    await page.waitForTimeout(15_000);
    const cold = s.reads.map((body) => body.blockNumber);
    assert.ok(cold.length <= 4, `at most four reads on a cold view: ${cold}`);
    assert.ok(cold.includes(week) && cold.includes(dayBlock));
    assert.ok(cold.every((block) => Number.isSafeInteger(block) && block < LONG.head));
    keptToTheRules(world);
    assert.deepEqual(s.asked, []);
    // A reload: both starts are kept points, drawn with no read for them; at most one more fill of the week.
    await page.reload();
    const again = page.locator('[data-fees-card][data-fees-state="verified"]');
    await again.waitFor({ timeout: 60_000 });
    assert.equal(await again.getAttribute('data-fees-period-state'), 'drawn', 'the 7D start is a kept point');
    await page.locator('[data-cell="apr"][data-apr="ready"] [data-apr-day]').waitFor({ timeout: 20_000 });
    await page.waitForTimeout(8_000);
    const warm = s.reads.slice(cold.length).map((body) => body.blockNumber);
    assert.ok(!warm.includes(week) && !warm.includes(dayBlock), `no start read again: ${warm}`);
    assert.ok(warm.length <= 1, `at most one more fill: ${warm}`);
  } finally { release(); await s.close(); }
});

test('a start that cannot be read: the period says so in one calm line, its tabs stay, All is drawn, nothing beside the hero, and no Retry', { timeout: 90_000 }, async () => {
  const world = automated(LONG);
  const s = await scenario(world, HASH, DESKTOP, null, { past: () => gatewayError('upstream_unavailable', 503) });
  try {
    const page = s.page;
    const card = page.locator('[data-fees-card][data-fees-state="verified"]');
    await card.waitFor({ timeout: 60_000 });
    const quiet = page.locator('[data-fees-card][data-fees-period="7d"][data-fees-period-state="unavailable"] [data-fees-quiet="period_unavailable"]');
    await quiet.waitFor({ timeout: 30_000 });
    assert.equal((await quiet.innerText()).trim(), 'This period can’t be read right now. Fees earned above is exact.');
    assert.equal(await card.locator('.dm-fees-delta').count(), 0);
    assert.deepEqual(await card.getByRole('radio').allInnerTexts(), ['24H', '7D', '30D', 'All'], 'the tabs stay');
    assert.match(await card.locator('.dm-fees-hero').innerText(), /\$[\d,]+\.\d\d/, 'the hero is exact');
    await card.getByRole('radio', { name: 'All', exact: true }).click();
    await page.locator('[data-fees-card][data-fees-period="all"][data-fees-period-state="drawn"] .dm-fees-chart').waitFor({ timeout: 10_000 });
    // Your APR has no last 24 hours without a point a day old, and says nothing about it.
    const apr = page.locator('[data-cell="apr"][data-apr="ready"]');
    await apr.waitFor({ timeout: 10_000 });
    assert.equal(await apr.locator('[data-apr-day]').count(), 0);
    assert.doesNotMatch(await page.locator('body').innerText(), /Retry|Try again/);
    assert.ok(s.reads.length >= 1 && s.reads.every((body) => body.tokenIds.length === 1));
  } finally { await s.close(); }
});
