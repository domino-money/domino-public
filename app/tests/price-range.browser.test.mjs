/**
 * A position's Price range card at every kind of price (the owner's point 10, 2026-10-03: "Tokens go from $0.001 to
 * $1,000,000 and none of these charts work. Sometimes it sits way down at the bottom, sometimes it doesn't show the
 * history … no beginner will understand it"), on the wallet-test build's position lab (screens/PositionLab.tsx `range`:
 * the card alone, as a position's page draws it, from a position as the page reads one), desktop 1440×900 and phone
 * 390×844, with the pool's stored price history answered by the read service (read-v3 `history`,
 * tests/support/read-stub.mjs over tests/support/price-range-cases.mjs) and without it.
 *
 * On every case: one plain status in words; the band on the plot with both its ends labelled (never the whole plot);
 * the price now's dot whole inside the plot and its chip in the status colour, written as the key figures write it;
 * the labels clear of one another and inside the card; the line of the last 7 days where the history answers (green
 * inside the range, red outside, grey once closed); no sideways scroll on a phone; and the history asked for exactly as
 * the page should (the 7 days, hour by hour, the page's own pair), once. Prints go to DOMINO_CHART_SHOTS when it is set,
 * and to .test-artifacts otherwise.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { closeBrowser } from './support/close-browser.mjs';
import { createFakeSession } from './support/fake-session.mjs';
import { CASES, historyFor, labHash, notBuilt } from './support/price-range-cases.mjs';
import { createReadStub } from './support/read-stub.mjs';
import { createWalletServer, WALLET_DIST } from './support/wallet-server.mjs';

let browser;
before(async () => {
  for (const options of process.env.DOMINO_BROWSER_PATH ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }] : [{ channel: 'msedge' }, { channel: 'chrome' }, { channel: 'chromium' }, {}]) {
    try { browser = await chromium.launch({ ...options, headless: true }); break; } catch {}
  }
  if (!browser) throw new Error('A Chromium browser is required.');
});
after(async () => { await closeBrowser(browser); });

const shots = () => { const dir = process.env.DOMINO_CHART_SHOTS || resolve(import.meta.dirname, '../.test-artifacts'); mkdirSync(dir, { recursive: true }); return dir; };
const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  small: { viewport: { width: 320, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
/** The chart's own room above and under its plot (PriceVsRange.tsx PAD_TOP, PAD_BOTTOM). */
const PAD = { top: 16, bottom: 30 };
const byPool = new Map(Object.values(CASES).map((item) => [item.poolId, item]));
const STATUS = {
  inside: /^Earning fees — the price is inside your range$/,
  under: /^Not earning — the price is below your range$/,
  over: /^Not earning — the price is above your range$/,
  closed: /^Closed — this position no longer earns fees$/,
};
/** Where each case's price is against its range (tests/support/price-range-cases.mjs). */
const WHERE = { closed: 'closed', under: 'under', over: 'over', 'far-over': 'over' };
const whereOf = (name) => WHERE[name] ?? 'inside';

/** The lab served with the read service answering `history` as `answer(item, body)` says (null: read-v3 not listed). */
async function lab(answer) {
  const asked = [];
  const read = answer
    ? createReadStub({
        stored: (route, body) => {
          if (route !== 'history') return JSON.stringify({ error: 'route_not_available' });
          asked.push(body);
          return JSON.stringify(answer(byPool.get(body.poolId), body));
        },
      })
    : createReadStub();
  const fake = createFakeSession();
  const server = createWalletServer({ fake, dist: WALLET_DIST, routes: [(request, url) => read.handle(request, url)] });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  fake.origin = origin;
  return { origin, asked, close: () => server.closeAll() };
}

/** One case on one device: the card, measured. */
async function open(site, name, device, { line = true, spec = {} } = {}) {
  const context = await browser.newContext(DEVICES[device]);
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const item = { ...CASES[name], spec: { ...CASES[name].spec, ...spec } };
  await page.goto(`${site.origin}/${labHash(item)}`);
  const chart = page.locator('[data-range-lab] [data-pvr-where]');
  try { await chart.waitFor({ timeout: 20_000 }); }
  catch (error) {
    await page.screenshot({ path: join(shots(), `price-range-${name}-${device}-failure.png`), fullPage: true });
    throw new Error(`${name}/${device}: ${errors.join('; ') || (await page.locator('body').innerText()).slice(0, 400)}`, { cause: error });
  }
  if (line) await page.locator('[data-range-lab] [data-pvr-line]').waitFor({ timeout: 20_000 });
  else await page.locator('[data-range-lab] [data-pvr-history]:not([data-pvr-history="reading"])').waitFor({ timeout: 20_000 });
  // The first draw's wipe and the chip's pop.
  await page.waitForTimeout(900);
  const measured = await chart.evaluate((root) => {
    const box = (node) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
    const frame = root.querySelector('.dm-pvr');
    const band = root.querySelector('.dm-pvr-band');
    const card = root.closest('section');
    return {
      frame: box(frame),
      band: box(band),
      card: box(card),
      dot: box(root.querySelector('.dm-pvr-now-dot')),
      labels: [...root.querySelectorAll('[data-pvr-end], .dm-pvr-chip')].map((node) => ({ key: node.getAttribute('data-pvr-end') ?? 'now', ...box(node) })),
      edges: [...root.querySelectorAll('.dm-pvr-edge')].map((node) => node.getAttribute('data-edge')),
      lines: [...root.querySelectorAll('.dm-pvr-line')].map((node) => node.getAttribute('data-tone')),
      keys: [...root.querySelectorAll('.dm-pvr-key')].map((node) => node.getAttribute('data-key')),
      where: root.getAttribute('data-pvr-where'),
      chip: root.querySelector('[data-pvr-now]').textContent,
      chipTone: root.querySelector('.dm-pvr-chip').getAttribute('data-tone'),
      says: root.querySelector('.dm-pvr-says').textContent.replace(/\s+/g, ' ').trim(),
      move: root.querySelector('.dm-pvr-move')?.textContent ?? null,
      note: root.querySelector('.dm-pvr-note').textContent,
      text: card.innerText,
      scroll: document.documentElement.scrollWidth,
    };
  });
  return { page, item, measured, errors, close: () => context.close() };
}

/** What every case must show, whatever its price. */
function checkCard({ item, measured: m, errors }, name, device) {
  const what = `${name} on ${device}`;
  assert.deepEqual(errors, [], what);
  const where = whereOf(name);
  assert.equal(m.where, where, what);
  assert.match(m.says, STATUS[where], `${what}: ${m.says}`);
  assert.equal(m.chipTone, where === 'inside' ? 'in' : where === 'closed' ? 'closed' : 'out', `${what}: the chip in the status colour`);
  assert.equal(item.spec.position.status === 'closed', where === 'closed');
  // The plot: the band's own left and right are the plot's.
  const plot = { left: m.band.x, right: m.band.right, top: m.frame.y + PAD.top, bottom: m.frame.bottom - PAD.bottom };
  assert.ok(m.band.h >= 1, `${what}: the band is on the plot (${m.band.h}px)`);
  const finite = m.edges.length === 2;
  if (finite) assert.ok(m.band.h <= (plot.bottom - plot.top) * 0.8, `${what}: the band never fills the plot (${m.band.h} of ${plot.bottom - plot.top})`);
  // The price now's dot, whole inside the plot.
  assert.ok(m.dot.x >= plot.left && m.dot.right <= plot.right, `${what}: the dot inside the plot horizontally (${m.dot.x}..${m.dot.right} in ${plot.left}..${plot.right})`);
  assert.ok(m.dot.y >= plot.top - 1 && m.dot.bottom <= plot.bottom + 1, `${what}: the dot inside the plot vertically (${m.dot.y}..${m.dot.bottom} in ${plot.top}..${plot.bottom})`);
  // The labels: Max, Min and the chip, clear of one another, inside the card.
  const keys = m.labels.map((label) => label.key).sort();
  assert.deepEqual(keys, ['max', 'min', 'now'], `${what}: both ends and the price now are labelled`);
  for (const [index, a] of m.labels.entries()) {
    assert.ok(a.right <= m.card.right + 0.5 && a.x >= m.frame.x, `${what}: ${a.key} inside the card (${a.x}..${a.right}, card to ${m.card.right})`);
    for (const b of m.labels.slice(index + 1)) assert.ok(a.bottom <= b.y + 0.5 || b.bottom <= a.y + 0.5, `${what}: ${a.key} and ${b.key} apart (${a.y}..${a.bottom}, ${b.y}..${b.bottom})`);
  }
  assert.doesNotMatch(m.text, /\de[+-]?\d|NaN|Infinity|undefined/, `${what}: plain figures only`);
  if (device === 'phone') assert.ok(m.scroll <= 390, `${what}: no sideways scroll (${m.scroll}px)`);
}

test('with the pool’s stored history: every case draws its band, both ends, the price now inside the plot and the line of the last 7 days', { timeout: 300_000 }, async () => {
  const site = await lab((item, body) => historyFor(item, body, { end: Math.floor(Date.now() / 1000) }));
  try {
    for (const device of Object.keys(DEVICES)) {
      for (const name of Object.keys(CASES)) {
        const card = await open(site, name, device);
        try {
          checkCard(card, name, device);
          const m = card.measured;
          assert.ok(m.lines.length > 0, `${name} on ${device}: the line is drawn`);
          // Green inside the band and red outside it (the same line clipped twice), grey once closed; a key for each colour it has.
          if (name === 'closed') {
            assert.deepEqual([...new Set(m.lines)], ['closed'], 'a closed position’s line is grey');
            assert.deepEqual(m.keys, ['range', 'price']);
          } else {
            assert.deepEqual([...new Set(m.lines)].sort(), ['in', 'out'], name);
            assert.ok(m.keys.includes(whereOf(name) === 'inside' ? 'in' : 'out'), `${name}: ${m.keys}`);
          }
          assert.equal(m.note, 'Last 7 days · Hourly prices');
          await card.page.locator('[data-range-lab] section').screenshot({ path: join(shots(), `price-range-${name}-${device}.png`) });
        } finally { await card.close(); }
      }
    }
    // Asked as the page should: the 7 days, hour by hour, for the page's own priced token, once per page.
    assert.equal(site.asked.length, Object.keys(CASES).length * Object.keys(DEVICES).length);
    for (const body of site.asked) {
      const item = byPool.get(body.poolId);
      assert.deepEqual(body, { poolId: item.poolId, currency: item.base.address, windowSeconds: 604_800, resolutionSeconds: 3_600 });
    }
  } finally { await site.close(); }
});

test('the owner’s cases in words and figures: tiny prices with their zeros counted, huge ones short, the price now as the key figures write it, and how far an out-of-range price must move', { timeout: 120_000 }, async () => {
  const site = await lab((item, body) => historyFor(item, body, { end: Math.floor(Date.now() / 1000) }));
  try {
    const expect = {
      closed: { chip: '0.0₆710148', move: null },
      tiny: { chip: /^0\.0₆71\d+$/, move: null },
      micro: { chip: /^0\.0₁₁3\d+$/, move: null },
      huge: { chip: /^120,3\d\d$/, move: null },
      giant: { chip: /^2\.\d+B$/, move: null },
      under: { chip: /^0\.0025\d*$/, move: /^It must rise 5\d% to come back into your range\.$/ },
      over: { chip: /^0\.0025\d*$/, move: /^It must fall 2\d% to come back into your range\.$/ },
      'far-over': { chip: /^0\.0025\d*$/, move: /^It must fall more than 99% to come back into your range\.$/ },
    };
    for (const [name, want] of Object.entries(expect)) {
      const card = await open(site, name, 'desktop');
      try {
        const m = card.measured;
        if (typeof want.chip === 'string') assert.equal(m.chip, want.chip, name);
        else assert.match(m.chip, want.chip, `${name}: ${m.chip}`);
        if (want.move) assert.match(m.move, want.move, `${name}: ${m.move}`);
        else assert.equal(m.move, null, name);
        // Hovering the line: the hour, the price of one base token in its quote, and in range or out in words.
        const plot = await card.page.locator('[data-range-lab] .dm-pvr').boundingBox();
        await card.page.mouse.move(plot.x + plot.width * 0.4, plot.y + plot.height / 2);
        const tip = card.page.locator('[data-range-lab] .dm-chart-tooltip');
        await tip.waitFor({ timeout: 5_000 });
        assert.match(await tip.innerText(), new RegExp(`^\\d\\d-\\d\\d \\d\\d:\\d\\d UTC\\s+1 ${card.item.base.symbol}\\s+\\S+ ${card.item.quote.symbol}\\s+(Inside|Outside) your range$`));
      } finally { await card.close(); }
    }
  } finally { await site.close(); }
});

test('without a history: the band, its ends and the price now as a level across the plot, and one short line says why (not listed, still collected, or a pool the read service keeps none for)', { timeout: 300_000 }, async () => {
  for (const [label, answer, note, spec] of [
    ['not-listed', null, 'Price history isn’t available yet.', {}],
    ['not-built', (item, body) => notBuilt(item, body, { end: Math.floor(Date.now() / 1000) }), 'Price history is still being collected.', {}],
    ['off', (item, body) => historyFor(item, body, { end: Math.floor(Date.now() / 1000) }), 'Price history isn’t available for this pool.', { history: false }],
  ]) {
    const site = await lab(answer);
    try {
      for (const device of Object.keys(DEVICES)) {
        for (const name of label === 'not-listed' ? Object.keys(CASES) : ['inside', 'tiny']) {
          const card = await open(site, name, device, { line: false, spec });
          try {
            checkCard(card, name, device);
            const m = card.measured;
            assert.equal(m.lines.length, 0, `${label} ${name}: no line`);
            assert.equal(m.note, note, `${label} ${name}`);
            // The price now as a level across the plot.
            const level = await card.page.locator('[data-range-lab] .dm-pvr-now-line').boundingBox();
            assert.ok(level.width >= m.band.w - 1, `${label} ${name}: the price now across the plot`);
            if (label === 'not-listed' || name === 'inside') await card.page.locator('[data-range-lab] section').screenshot({ path: join(shots(), `price-range-${name}-${device}-${label}.png`) });
          } finally { await card.close(); }
        }
      }
      if (label === 'off') assert.deepEqual(site.asked, [], 'a pool the read service keeps no history for is never asked about');
    } finally { await site.close(); }
  }
});

test('a partial history breaks its line where hours were not collected, and says so in a few words', { timeout: 120_000 }, async () => {
  const site = await lab((item, body) => historyFor(item, body, { end: Math.floor(Date.now() / 1000), gap: [70, 40], quiet: 0.5 }));
  try {
    for (const device of Object.keys(DEVICES)) {
      const card = await open(site, 'inside', device);
      try {
        checkCard(card, 'inside', device);
        assert.equal(card.measured.note, 'Last 7 days · Some hours are missing.');
        await card.page.locator('[data-range-lab] section').screenshot({ path: join(shots(), `price-range-inside-${device}-partial.png`) });
      } finally { await card.close(); }
    }
  } finally { await site.close(); }
});

test('a newly opened position starts at its mint; unknown mint keeps only the current price at 1440, 390 and 320', { timeout: 120_000 }, async () => {
  const end = Math.floor(Date.now() / 1000);
  const openedAt = end - 6 * 3600 + 137;
  const site = await lab((item, body) => historyFor(item, body, { end }));
  try {
    for (const device of Object.keys(DEVICES)) {
      const recent = await open(site, 'inside', device, { spec: { openedAt } });
      try {
        checkCard(recent, 'inside', device);
        const range = recent.page.locator('[data-pvr-line]');
        assert.equal(Number(await range.getAttribute('data-pvr-start')), openedAt);
        assert.ok(Number(await range.getAttribute('data-pvr-first')) >= openedAt);
        assert.equal(recent.measured.note, 'Since opened · Hourly prices');
        const frame = range.locator('.dm-pvr');
        await frame.focus();
        await recent.page.keyboard.press('Home');
        await range.locator('.dm-chart-tooltip').waitFor();
        await recent.page.keyboard.press('Escape');
        await recent.page.locator('[data-range-lab] h2').click();
        await recent.page.locator('[data-range-lab] section').screenshot({ path: join(shots(), `price-range-recent-${device}.png`) });
      } finally { await recent.close(); }
      const reads = site.asked.length;
      const unknown = await open(site, 'inside', device, { line: false, spec: { openedAt: null } });
      try {
        checkCard(unknown, 'inside', device);
        assert.equal(await unknown.page.locator('[data-pvr-where]').getAttribute('data-pvr-history'), 'unknown_mint');
        assert.equal(unknown.measured.lines.length, 0);
        assert.match(unknown.measured.note, /Opening time isn’t available/);
        assert.equal(site.asked.length, reads, 'unknown mint does not request unrelated pool history');
        await unknown.page.locator('[data-range-lab] section').screenshot({ path: join(shots(), `price-range-unknown-mint-${device}.png`) });
      } finally { await unknown.close(); }
    }
  } finally { await site.close(); }
});
