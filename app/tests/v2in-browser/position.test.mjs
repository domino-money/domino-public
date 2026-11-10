/**
 * The position page's Domino V2 integration in a browser (src/v2in/position, 2026-10-02), on the wallet-test-v2 build
 * (V1's wallet-test build with V2 compiled in): a position V1's reads do not cover opens the same page
 * (`#/positions/<chain>-v<dex>-<id>`) from read-v6, with the owner's actions beside its title, each in the page's action
 * dialog, and Domino's approval in Details.
 *
 *   - gate closed: the route is V1's (the list);
 *   - live on a fake Base chain (tests/support/v2-chain.mjs, its zap's set opened through the gate's test hook): the page
 *     from read-v6 (no USD, no APR), one primary Collect fees and the "···" menu (Add liquidity, Change range, Withdraw),
 *     "Domino can manage this position for you when you ask." and "Revoke"; Add liquidity with a swap (review: the fee
 *     and its base, how much smaller, the L1 data fee, the steps); Withdraw in one token (the converted line and its
 *     offers), sent, its receipt from the zap's events;
 *   - under automation: an armed root blocks Change range (the menu says why), its exit names the reserves that stay and
 *     waits for the pause warning; a successor is the vault's (one sentence, no button); a hooked pool is not supported;
 *   - a direct exit to both tokens straight at Uniswap (tests/support/v2-direct-chain.mjs): no Domino fee, its receipt
 *     from Uniswap's logs;
 *   - preview (the gate open, no live set): the same page from read-v6 (real data only, nothing marked as test data);
 *     every action runs to its review with what was chosen and the gate's sentence, no plan is asked, and a wallet on
 *     another chain is never asked to switch for a read.
 * No request leaves the page's own origin, no CSP violation, no page error (tests/support/position-v2-page.mjs close()).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { decodeAbiParameters, decodeFunctionData, encodeFunctionResult, parseAbi } from 'viem';
import * as runtime from '../../../api-contracts/position-plan-v1/runtime.mjs';
import * as readV6 from '../../../api-contracts/read-v6/runtime.mjs';
import { closeBrowser } from '../support/close-browser.mjs';
import { WALLET_V2_DIST } from '../support/wallet-dist.mjs';

const APP = resolve(import.meta.dirname, '../..');
if (!existsSync(join(WALLET_V2_DIST, 'index.html'))) throw new Error('.wallet-test-v2-dist is missing. Run npm run build:wallet-test-v2 first (npm run test:v2in does).');
if (!existsSync(resolve(APP, '.test-build/app/functions/_middleware.js'))) execFileSync(process.execPath, ['scripts/test.mjs', '--build-only'], { cwd: APP, stdio: 'ignore' });
const { planAnswer, v4Path, ZERO } = await import('../support/s1-plans.mjs');
const { activityOf, indexedToken, livePosition, portfolioOf, s1Action, vaultOf } = await import('../support/s1-read6.mjs');
const { launchBrowser } = await import('../support/s1-browser.mjs');
const { createV2Chain } = await import('../support/v2-chain.mjs');
const { createDirectChain } = await import('../support/v2-direct-chain.mjs');
const { openPositionPage } = await import('../support/position-v2-page.mjs');
const { createChainReads } = await import('../support/chain-reads.mjs');
const { FAKE } = await import('../v2/support/plans.mjs');

const require = createRequire(import.meta.url);
const position = require('../../.test-build/app/src/finance/position.js');
const NFT = parseAbi(['function approve(address spender, uint256 tokenId)']);
const shots = () => { const dir = resolve(process.env.DOMINO_POSITION_SHOTS ?? join(APP, '.test-artifacts')); mkdirSync(dir, { recursive: true }); return dir; };

const OWNER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const HOOK = '0x00000000000000000000000000000000000000c0';
const ZAP_V4 = '0x00000000000000000000000000000000d0d00004';
const VAULT = '0x00000000000000000000000000000000000000aa';
const V4_PM = '0x7c5f5a4bbd8fd63184577525326123b519429bdc';
const POOL = { dex: 4, currency0: ZERO, currency1: USDC, fee: 500, tickSpacing: 10, hooks: ZERO };
const TICK = -199020;
const SQRT = position.sqrtPriceAtTick(TICK);
const RANGE = { tickLower: -201060, tickUpper: -197040 };
const LIQUIDITY = 10n ** 15n;
const PRINCIPAL = runtime.amountsForLiquidity(SQRT, runtime.sqrtAtTick(RANGE.tickLower), runtime.sqrtAtTick(RANGE.tickUpper), LIQUIDITY, false);
const now = () => Math.floor(Date.now() / 1000);
const text = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();
/**
 * Added 2026-11-09 (the core-flows fix): the close flow's screens at desktop (1440x900) and phone (390x844) widths, into
 * DOMINO_CLOSE_SHOTS (the integration log's folder) or .test-artifacts; the page goes back to its own size after.
 */
async function closeShot(page, name) {
  const dir = resolve(process.env.DOMINO_CLOSE_SHOTS ?? shots());
  mkdirSync(dir, { recursive: true });
  const before = page.viewportSize();
  for (const [size, viewport] of [['desktop-1440', { width: 1440, height: 900 }], ['phone-390', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(dir, `${name}-${size}.png`) });
  }
  if (before) await page.setViewportSize(before);
}
const LOCKED_BASE = 'This opens as soon as Domino\'s service is live on Base.';

/** The "···" menu of the position's row: opened, its entries as `[key, label, disabled]`; left open. */
async function openMenu(detail) {
  const menu = detail.locator('[role="group"][aria-label="Position actions"]');
  await menu.waitFor();
  return { menu, entries: await menu.locator('button[data-position-v2-action]').evaluateAll((all) => all.map((one) => [one.getAttribute('data-position-v2-action'), one.textContent, one.disabled || one.getAttribute('aria-disabled') === 'true'])) };
}

/** Opens the "···" menu and picks one of its entries (the menu closes on the pick). */
async function pick(detail, key) {
  const { menu } = await openMenu(detail);
  await menu.locator(`button[data-position-v2-action][data-position-v2-action="${key}"]`).click();
}

/** The fake Base chain's positions: one approved to Domino, a vault's armed root, a successor, a hooked one, a plain one. */
const CHAIN_POSITIONS = [
  { dex: 4, tokenId: 5_100_001n, pool: POOL, ...RANGE, liquidity: LIQUIDITY, principal: PRINCIPAL, fees: [10n ** 15n, 2_500_000n], approved: ZAP_V4 },
  { dex: 4, tokenId: 5_100_002n, pool: POOL, ...RANGE, liquidity: LIQUIDITY, principal: PRINCIPAL, fees: [0n, 0n], approved: VAULT },
  { dex: 4, tokenId: 5_100_003n, pool: POOL, ...RANGE, liquidity: LIQUIDITY, principal: [1n, 1n], owner: VAULT },
  { dex: 4, tokenId: 5_100_004n, pool: { ...POOL, hooks: HOOK }, ...RANGE, liquidity: LIQUIDITY, principal: [1n, 1n] },
  { dex: 4, tokenId: 5_100_005n, pool: POOL, ...RANGE, liquidity: LIQUIDITY, principal: PRINCIPAL, fees: [0n, 0n] },
];
const live = (tokenId, over = {}) => livePosition({ chainId: 8453, manager: V4_PM, tokenId, owner: OWNER, pool: POOL, ...RANGE, liquidity: LIQUIDITY, sqrtPriceX96: SQRT, tick: TICK, feesOwed: ['1000000000000000', '2500000'], principal: PRINCIPAL, ...over });
const TOKENS = [indexedToken(8453, ZERO, 'ETH', 18), indexedToken(8453, USDC, 'USDC', 6)];
/** read-v6 on Base: the five positions, and the vault (its root 5100002) with fees waiting to be reinvested. */
const READ6 = {
  portfolio: portfolioOf({
    wallet: OWNER,
    tokens: TOKENS,
    positions: [
      live(5_100_001, { approved: ZAP_V4 }),
      live(5_100_002, { approved: VAULT, subscriber: VAULT, vault: { address: VAULT, role: 'root' } }),
      live(5_100_003, { owner: VAULT, vault: { address: VAULT, role: 'successor' } }),
      live(5_100_004, { pool: { ...POOL, hooks: HOOK } }),
      live(5_100_005),
    ],
    vaults: [vaultOf({ wallet: OWNER, chainId: 8453, address: VAULT, rootTokenId: 5_100_002, pool: POOL, reserves: ['1000000000000000', '2500000'] })],
  }),
  activity: activityOf({ wallet: OWNER, items: [s1Action({ chainId: 8453, wallet: OWNER, zap: ZAP_V4, action: 'increase', tokenId: 5_100_001, previousTokenId: 5_100_001, pool: POOL, inputs: [{ token: USDC, amount: '100000000' }], legs: [{ kind: 'v4_pool', tokenIn: USDC, tokenOut: ZERO, venue: '0x' + '1'.repeat(40), amountIn: '50000000', amountOut: '20000000000000000' }], tariffs: [{ kind: 'assisted_swap', rateBps: 65, token: USDC, amount: '325000', deferred: '0' }] })] }),
};
/**
 * Added 2026-11-06 (review F1, UI-2): read-v6 chain-pools on Base, answered from `pools` as the contract allows
 * (tests/support/chain-reads.mjs), each request kept in `asked`: a `prepare` for openPositionPage. Details' Pool and
 * New position in this pool appear on Base only once this read lists the position's pool.
 */
const basePools = (pools, tokens, asked = []) => async (context) => {
  const reads = createChainReads({ chainId: 8453, tokens, pools });
  await context.exposeFunction('__positionChainPools', (request) => { asked.push(request); return reads.answer('chain-pools', request); });
  await context.addInitScript(() => { window.__dominoV2Test.read6['chain-pools'] = (request) => window.__positionChainPools(request); });
};
const ETH_USDC = [{ address: ZERO, symbol: 'ETH', name: 'Ether', decimals: 18 }, { address: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6 }];
const POOL_LISTED = [{ pool: POOL, sqrtPriceX96: SQRT, tick: TICK, liquidity: 10n ** 18n }];

const chainOf = (over = {}) => createV2Chain({ chainId: 8453, timestamp: now(), positions: CHAIN_POSITIONS, pools: [{ pool: POOL, sqrtPriceX96: SQRT, tick: TICK, liquidity: 10n ** 16n }], vaults: [VAULT], ...over });

test('multichain sync: detail updates from the shared portfolio and charts only timestamped observed balances without extra reads', async () => {
  const first = portfolioOf({ wallet: OWNER, tokens: TOKENS, positions: [live(5100001)] });
  const chain = chainOf();
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100001', read6: { portfolio: first, activity: activityOf({ wallet: OWNER }) } });
  try {
    const page = s.page, fees = page.locator('[data-recorded-fees]');
    await page.locator('[data-recorded-fees][data-reading-count="1"]').waitFor();
    await page.evaluate(first => {
      window.__portfolioReads = 0; window.__portfolioAnswer = first;
      window.__dominoV2Test.read6.portfolio = () => { window.__portfolioReads++; return window.__portfolioAnswer; };
    }, first);
    await fees.getByRole('button', { name: 'USDC', exact: true }).click();
    assert.match(await text(fees.locator('.dm-recorded-fees-value')), /^2\.5 USDC$/);
    await page.getByRole('button', { name: 'Expand chart', exact: true }).click();
    await page.getByRole('button', { name: 'Show measured points', exact: true }).click();
    await page.getByRole('tab', { name: 'Price range', exact: true }).click();
    const range = page.locator('[data-pvr-history="recorded"]');
    await range.waitFor();
    assert.equal(await range.getAttribute('data-pvr-opened'), null, 'no invented opening point');
    assert.equal(await range.locator('path.dm-pvr-line').count(), 0, 'isolated measurements are not drawn as a continuous history');
    assert.equal(await page.evaluate(() => window.__portfolioReads), 0, 'chart controls never read the portfolio again');
    const second = structuredClone(first), state = second.body.positions[0].state;
    state.snapshot = { ...state.snapshot, number: state.snapshot.number + 1, timestamp: state.snapshot.timestamp + 60, hash: '0x' + 'ab'.repeat(32) };
    state.feesOwed = ['0', '3750000'];
    state.sqrtPriceX96 = position.sqrtPriceAtTick(TICK + 1).toString(); state.tick = TICK + 1;
    // Changed on purpose 2026-10-14 (incident 2026-10-13, design 2.5, package Q1): focus is no wake (a wallet popup closing
    // fires it); back online is, and wake rounds are at least 10 s apart (src/lib/wake.ts), hence the wait before the next.
    await page.evaluate(answer => { window.__portfolioAnswer = answer; window.dispatchEvent(new Event('online')); }, second);
    const woke = Date.now();
    await page.locator(`[data-position-detail][data-snapshot="${state.snapshot.number}"]`).waitFor();
    await page.waitForFunction(() => document.querySelector('[data-recorded-fees]')?.getAttribute('data-reading-count') === '2');
    const slider = range.getByRole('slider');
    await slider.focus(); await page.keyboard.press('End');
    assert.match(await slider.getAttribute('aria-valuetext'), /inside your range/);
    assert.equal(await slider.getAttribute('aria-valuemax'), '2');
    assert.equal(await range.locator('path.dm-pvr-line').count(), 0, 'there are still no fabricated connecting segments');
    await page.setViewportSize({ width: 320, height: 820 });
    await page.keyboard.press('Home');
    assert.equal(await slider.getAttribute('aria-valuenow'), '1');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '320px has no horizontal page overflow');
    await page.screenshot({ path: join(shots(), 'position-v2-recorded-range-320.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: 'Fees', exact: true }).click();
    assert.match(await text(fees.locator('.dm-recorded-fees-value')), /^3\.75 USDC$/);
    assert.equal(await fees.getByRole('button', { name: 'USDC', exact: true }).getAttribute('aria-pressed'), 'true');
    await fees.getByRole('slider').focus(); await page.keyboard.press('End');
    assert.match(await fees.getByRole('slider').getAttribute('aria-valuetext'), /3\.75 USDC ready to collect/);
    await page.screenshot({ path: join(shots(), 'position-v2-recorded-fees-320.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Collapse chart', exact: true }).click();
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(shots(), 'position-v2-recorded-fees-390.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 960 });
    await page.screenshot({ path: join(shots(), 'position-v2-recorded-fees-desktop.png'), fullPage: true });
    const stale = structuredClone(second); stale.body.positions[0].state.snapshot.number++; stale.body.positions[0].state.freshness.status = 'stale';
    await page.waitForTimeout(Math.max(0, woke + 10_000 - Date.now()));
    await page.evaluate(answer => { window.__portfolioAnswer = answer; window.dispatchEvent(new Event('online')); }, stale);
    await page.locator('[data-recorded-fees][data-stale]').waitFor();
    assert.equal(await fees.getAttribute('data-reading-count'), '2', 'stale responses never add observations');
    assert.equal(s.planned.length, 0);
    assert.equal(chain.sends.length, 0);
  } finally { await s.close(); }
});

test('multichain sync: a restored creation is visible before indexing and reconciles to one exact live position without reloading', async () => {
  const hint = { wallet: OWNER, chainId: 8453, positionManager: V4_PM, dex: 4, tokenId: '5100001', hash: '0x' + 'ab'.repeat(32), block: 73399500,
    blockHash: '0x' + 'ff'.repeat(32), observedAt: Date.now(), fee: 500, tokens: [{ address: ZERO, symbol: 'ETH', decimals: 18 }, { address: USDC, symbol: 'USDC', decimals: 6 }] };
  const s = await openPositionPage(browser, chainOf(), { hash: '#/positions/base-v4-5100001', creations: [hint], read6: { portfolio: portfolioOf({ wallet: OWNER }), activity: activityOf({ wallet: OWNER }) } });
  try {
    const page = s.page;
    await page.locator('[data-position-reason="awaiting_index"]').waitFor();
    // Changed on purpose 2026-10-15 (pack 7, owner: no status notices): the page's title alone, no "Updating position details…".
    assert.doesNotMatch(await text(page.locator('[data-position-reason="awaiting_index"]')), /Updating position details/);
    // Changed on purpose 2026-11-09 (core flows, the owner: nothing may load forever): its loading frame with one line while
    // read-v6 lists it, the list asked again every few seconds meanwhile (src/v2in/lists/newPositionWait.ts); it was the title
    // alone, for good.
    assert.equal(await text(page.locator('[data-position-reason="awaiting_index"] [data-position-adding]')), 'Adding your new position…');
    assert.equal(await page.locator('[data-empty="position-v2"]').count(), 0);
    await page.screenshot({ path: join(shots(), 'core-loading-position-adding-desktop.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(shots(), 'core-loading-position-adding-phone.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 1180, height: 960 });
    await page.evaluate(() => { location.hash = '#/positions'; });
    const link = page.locator('a[href="/positions/base-v4-5100001"]');
    await link.waitFor();
    assert.match(await text(link), /ETH.*USDC/);
    // Changed on purpose 2026-10-15 (pack 7, owner: no status notices): the count only; the one still being checked is data-owned-pending.
    assert.doesNotMatch(await page.locator('[data-owned-status]').innerText(), /still being checked/);
    assert.equal(await page.locator('[data-owned-status]').getAttribute('data-owned-pending'), '1');
    const indexed = portfolioOf({ wallet: OWNER, tokens: TOKENS, positions: [live(5100001)] });
    // Changed on purpose 2026-10-14 (Q1): focus is no wake; back online is (src/lib/wake.ts).
    await page.evaluate(answer => { window.__dominoV2Test.read6.portfolio = () => answer; window.dispatchEvent(new Event('online')); }, indexed);
    await page.waitForFunction(() => !document.querySelector('[data-owned-status]')?.hasAttribute('data-owned-pending'));
    assert.equal(await link.count(), 1, 'the pending hint becomes one live row, never a duplicate');
    assert.deepEqual(await page.evaluate(wallet => JSON.parse(sessionStorage.getItem(`domino:created-positions:v1:${wallet}`)), OWNER), []);
    await link.click();
    await page.locator('[data-position-detail][data-snapshot="73399500"]').waitFor();
    assert.equal(s.planned.length, 0);
  } finally { await s.close(); }
});

// Added 2026-11-09 (core flows, the owner: nothing may load forever). A Base or Arbitrum One position's page whose list only
// fails drew its title alone, for good. It keeps its loading frame while the list is asked again by itself, and after 20 s
// (src/lib/readWait.ts STUCK_MS) its plate says what to do; the page replaces it once the list answers.
test('a position page whose list only fails says what to do after twenty seconds, and the position replaces it', async () => {
  const s = await openPositionPage(browser, chainOf(), { hash: '#/positions/base-v4-5100001', read6: { portfolio: { status: 503, body: { error: 'upstream_unavailable' } }, activity: activityOf({ wallet: OWNER }) },
    prepare: async (context) => { await context.clock.install(); } });
  try {
    const page = s.page;
    await page.locator('[data-position-loading][data-position-reason]').waitFor();
    assert.equal(await page.locator('[data-empty="position-v2"]').count(), 0, 'the loading frame while the first re-asks run');
    await page.clock.fastForward(21_000);
    const plate = page.locator('[data-empty="position-v2"]');
    await plate.waitFor();
    assert.match(await text(plate), /^Position #5100001 Reload the page to see this position\.$/);
    assert.doesNotMatch(await text(page.locator('main')), /couldn’t|could not|can’t be|unavailable|Try again/i);
    await page.screenshot({ path: join(shots(), 'core-loading-position-stuck-desktop.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(shots(), 'core-loading-position-stuck-phone.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 1180, height: 960 });
    const indexed = portfolioOf({ wallet: OWNER, tokens: TOKENS, positions: [live(5100001)] });
    await page.evaluate(answer => { window.__dominoV2Test.read6.portfolio = () => answer; }, indexed);
    await page.clock.fastForward(61_000);
    await page.locator('[data-position-detail][data-position-id="5100001"]').waitFor();
    assert.equal(await plate.count(), 0);
    assert.equal(s.planned.length, 0);
  } finally { await s.close(); }
});

/**
 * position-plan-v1 as it would answer (tests/support/s1-plans.mjs): an add swaps half the ETH to USDC; a converted exit sells
 * 80% of the ETH. `l1Unavailable` (2026-10-06): Base's oracle did not answer, so the plan's L1 data fee is unavailable.
 */
function plannerFor({ answers = [], l1Unavailable = false } = {}) {
  const l1 = l1Unavailable ? { l1DataFee: { status: 'unavailable', source: 'op_gas_price_oracle', block: null, weiRaw: null, upperBoundWeiRaw: null, l1GasUnits: null, l2BaseFeeWei: null, transactionBytes: null } } : {};
  return (wire) => {
    const tokenId = BigInt(wire.position.tokenId);
    const held = CHAIN_POSITIONS.find((p) => p.tokenId === tokenId);
    const positionState = { tokenId, manager: V4_PM, ...RANGE, liquidity: LIQUIDITY, feesOwed: [0n, 0n], approved: held?.approved ?? ZERO, subscriber: ZERO };
    const base = { owner: OWNER, zap: ZAP_V4, now: now(), pool: { sqrtPriceX96: SQRT, tick: TICK }, positionPool: POOL, position: positionState, ...l1 };
    let body;
    if (wire.action === 'increase') {
      const legs = [{ tokenIn: ZERO, tokenOut: USDC, amountIn: 25_000_000_000_000_000n, expectedOut: 57_000_000n, data: v4Path(POOL) }];
      body = planAnswer(wire, { ...base, legs, expected: { amounts: [25_000_000_000_000_000n, 56_600_000n], returned: [] } });
    } else if (wire.action === 'exit') {
      const legs = wire.receive.mode === 'converted' ? [{ tokenIn: ZERO, tokenOut: USDC, amountIn: (PRINCIPAL[0] * 8n) / 10n, expectedOut: 400_000_000n }] : [];
      body = planAnswer(wire, { ...base, legs });
    } else return undefined;
    answers.push(body);
    return body;
  };
}

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await closeBrowser(browser); });

test('(a) with the gate closed the route is V1\'s: a V2 position\'s address shows the list', async () => {
  const s = await openPositionPage(browser, chainOf(), { hash: '#/positions/base-v4-5100001', open: false, live: false, connect: false });
  try {
    const page = s.page;
    await page.locator('h1').first().waitFor({ timeout: 30_000 });
    assert.equal(await text(page.locator('h1').first()), 'Positions');
    assert.equal(await page.locator('[data-position-v2]').count(), 0);
  } finally { await s.close(); }
});

test('(b) live on Base: the same page from read-v6, no USD and no APR; Domino\'s approval in Details, and Revoke sends approve(address(0), tokenId)', async () => {
  const chain = chainOf();
  const asked = [];
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100001', read6: READ6, prepare: basePools(POOL_LISTED, ETH_USDC, asked) });
  try {
    const page = s.page;
    const detail = page.locator('[data-position-detail][data-position-v2="base-v4"][data-position-id="5100001"]');
    await detail.waitFor({ timeout: 30_000 });
    assert.equal(await text(detail.locator('h1')), 'ETH / USDC');
    // The venue and the fee, as V1's page; the Uniswap version only as the chip's title and under Details (review #12).
    assert.match(await text(detail.locator('.dm-pos-chips')), /^Uniswap · 0\.05% fee Base Position #5100001 In range/);
    assert.doesNotMatch(await text(detail), /v4|v3/, 'the version is never text on screen');
    assert.equal(await detail.locator('.dm-pos-chips [title="Uniswap v4"]').count(), 1);
    assert.doesNotMatch(await text(detail), /Test data/, 'real data: nothing marked as test data');
    // Changed on purpose 2026-11-06 (O-07, O-08, O-13; the owner: every chain the same as Robinhood Chain): Robinhood
    // Chain's tiles. With no dollar figure the two token amounts are the tile's figure, and Details holds no copy of them.
    assert.match(await detail.locator('[data-cell="principal"] [data-usd-amounts="principal"]').textContent(), /ETH.*USDC/);
    assert.match(await detail.locator('[data-cell="fees"] [data-usd-amounts="fees"]').textContent(), /0\.001\s+ETH.*2\.5\s+USDC/);
    assert.equal(await detail.locator('[data-position-details] [data-stat="principal"], [data-position-details] [data-stat="fees"]').count(), 0, 'no token amounts in Details, as on Robinhood Chain');
    assert.equal(await detail.locator('[data-position-stats]').getAttribute('title'), null, 'no "Read at block" on the strip');
    // The price tile: Robinhood Chain's range bar, its two ends and whether it earns.
    const range = detail.locator('[data-cell="price"] [data-stat="range"]');
    assert.equal(await range.count(), 1);
    assert.match(await text(range.locator('.dm-pos-span-ends')), /^\S+ Your range \S+$/);
    assert.equal(await range.locator('.sr-only[data-in="true"]').textContent(), 'In range: earning fees');
    assert.equal(await detail.locator('[data-cell="apr"] [data-figure="none"]').count(), 1, 'no APR without a qualified source: a dash');
    assert.equal(await detail.locator('[data-recorded-fees]').count(), 1, "the route does not serve position-fees: the session's readings, as before");
    assert.equal(await detail.locator('[data-position-insights] + .dm-pos-grid').count(), 1, "the charts before the grid of Activity and Details, as Robinhood Chain's page");
    assert.equal(await detail.locator('[data-position-v2-action="collect"]').isDisabled(), false, 'fees to collect: Collect fees on');
    assert.equal(await detail.locator('[data-fees-card]').count(), 0);
    // Changed on purpose 2026-10-03: the price's two sides are the app's one way round (lib/read/orientation.ts), as its
    // figure and the Price range chart are; the tile wrote the pool's order beside it ("1 ETH = 0.000333 USDC").
    // Changed on purpose 2026-10-05 (New position on Base and Arbitrum One): Base's USDC is a quote there as USDG is on
    // Robinhood Chain, so ether is priced in dollars, as Domino V2's review writes it ("1 USDC = 0.00044 ETH" before).
    assert.match(await text(detail.locator('[data-stat="price"]')), /^\S+ USDC per ETH$/, 'the current price with its quote unit, matching the other position pages');
    assert.doesNotMatch(await text(detail), /\$/, 'no USD anywhere');
    // V1's row (review #5): one primary Collect fees, then the "···" menu with the three other actions.
    const automation = detail.locator('[data-automation-control]');
    await automation.waitFor();
    assert.equal(await automation.innerText(), 'Set up automation');
    assert.equal(await automation.getAttribute('data-automation-setup'), '');
    assert.deepEqual(await detail.locator('[data-position-actions] [data-position-v2-action]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-position-v2-action'))), ['collect', 'increase', 'changeRange', 'exit']);
    assert.equal(await detail.locator('[data-position-actions] [data-position-v2-actions="live"] [data-position-v2-more]').count(), 1);
    const { menu, entries } = await openMenu(detail);
    // Changed on purpose 2026-10-06 (the owner's point 5): the protection is named Auto-exit.
    assert.deepEqual(entries, [['increase', 'Add liquidity', false], ['changeRange', 'Change range', false], ['exit', 'Withdraw', false]]);
    assert.equal(await menu.locator('[data-position-v2-blocked]').count(), 0, 'nothing blocked: no heading');
    await page.keyboard.press('Escape');
      // Details: the custody, the Uniswap version, and "Domino can manage this position for you when you ask." with Revoke (read through the wallet).
    await detail.locator('[data-position-details] summary').click();
    // Changed on purpose 2026-11-06 (O-12, O-13): Robinhood Chain's Details. A plain position has no Held line there; the
    // pool's id has its own name, no "Read at block", and New position in this pool by Base's own link.
    assert.equal(await detail.locator('[data-position-custody]').count(), 0, "a plain position: no Held line, as Robinhood Chain's page");
    const facts = await text(detail.locator('[data-position-details] .dm-pos-facts'));
    assert.match(facts, /Pool id 0x/);
    assert.doesNotMatch(facts, /Read at block|Tokens in this position|Fees ready to collect|Fees history/);
    // Changed on purpose 2026-11-06 (review F1, UI-2): once Base's pools read for USDC lists this ETH/USDC pool.
    await detail.locator('[data-position-pool-link]').waitFor({ timeout: 30_000 });
    assert.ok(asked.some((request) => request.chainId === 8453 && request.token === USDC && request.pairedToken === undefined), 'USDC\'s pools read, the one the pool page reads');
    assert.match(await detail.locator('[data-position-new-in-pool]').getAttribute('href'), /^\/new\/network\/8453\/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913\/0x[0-9a-f]{64}$/);
    assert.equal(await text(detail.locator('[data-position-new-in-pool]')), 'New position in this pool');
    // Changed on purpose 2026-11-06 (INT-1): the Pool button, as Robinhood Chain's Details, opens Base's own pool page:
    // the same pool and token as New position's link, the Pool button first.
    const newIn = /^\/new\/network\/8453\/(0x[0-9a-f]{40})\/(0x[0-9a-f]{64})$/.exec(await detail.locator('[data-position-new-in-pool]').getAttribute('href'));
    assert.equal(await detail.locator('[data-position-pool-link]').getAttribute('href'), `/pool/network/8453/${newIn[2]}/${newIn[1]}`);
    assert.equal(await text(detail.locator('[data-position-pool-link]')), 'Pool');
    assert.deepEqual(await detail.locator('.dm-pos-links > a').evaluateAll((links) => links.map((link) => link.hasAttribute('data-position-pool-link') ? 'pool' : 'new')), ['pool', 'new']);
    assert.equal(await text(detail.locator('[data-position-dex]')), 'v4');
    const approval = detail.locator('[data-position-zap-approval="approved"]');
    await approval.waitFor({ timeout: 30_000 });
    assert.match(await text(approval), /Domino can manage this position for you when you ask\. Revoke/);
    await page.screenshot({ path: join(shots(), 'position-v2-base.png'), fullPage: true });
    await approval.locator('[data-position-revoke]').click();
    await detail.locator('[data-position-revoked]').waitFor({ timeout: 30_000 });
    assert.equal(await text(detail.locator('[data-position-revoked]')), 'Domino can no longer manage this position.');
    assert.equal(chain.sends.length, 1);
    const [tx] = chain.sends.map((entry) => entry.tx);
    assert.equal(tx.to, V4_PM);
    assert.deepEqual(decodeFunctionData({ abi: NFT, data: tx.data }).args, [ZERO, 5_100_001n]);
    assert.equal(chain.nft(4, 5_100_001n).approved, ZERO);
    // Activity: the position's own S1 receipts, from read-v6; the fee's label, then its amount and its base (review #16).
    const activity = detail.locator('[data-position-activity-item]').first();
    await activity.waitFor();
    assert.equal(await activity.getByRole('img', { name: 'Confirmed', exact: true }).count(), 1, 'confirmation stays accessible without a text check glued to the title');
    assert.doesNotMatch(await activity.locator('summary').innerText(), /✓/);
    assert.ok(await activity.locator('.dm-rcpt-what').evaluate((node) => parseFloat(getComputedStyle(node).fontSize)) >= 14, 'activity actions remain readable at the compact desktop scale');
    assert.ok(await activity.locator('.dm-activity-time').evaluate((node) => parseFloat(getComputedStyle(node).fontSize)) >= 12, 'activity dates remain readable');
    assert.equal(await activity.locator('details').getAttribute('open'), null, 'technical receipt details start collapsed');
    await activity.locator('summary').click();
    assert.match(await text(activity), /Added to position #5100001/);
    assert.match(await text(activity), /Domino fee \(0\.65% of the amount swapped\).*0\.325 USDC/);
  } finally { await s.close(); }
});

// Added 2026-10-30 (QA round 2, final review pos-connect-flash-1): while the wallet island has not said what it found, the
// page waits in its frame (src/v2in/position/PositionPage.tsx), as the Positions list does (audit C5). A returning owner
// whose wallet reconnects saw a filled "Connect wallet" for that moment, then the page; here the wallet takes 1.5 s to
// answer which accounts it has after the reload, so that moment is long enough to see.
test('(b2) a returning owner’s reload never shows "Connect wallet" while the wallet reconnects; a visitor with no wallet is still asked to connect', async () => {
  let slow = false;
  const intercept = async (method) => {
    if (slow && method === 'eth_accounts') await new Promise((done) => setTimeout(done, 1500));
    return undefined;
  };
  const s = await openPositionPage(browser, chainOf(), { hash: '#/positions/base-v4-5100001', read6: READ6, intercept });
  try {
    const page = s.page;
    const detail = page.locator('[data-position-detail][data-position-v2="base-v4"][data-position-id="5100001"]');
    await detail.waitFor({ timeout: 30_000 });
    await page.addInitScript(() => {
      window.__connectSeen = [];
      window.__waitingSeen = false;
      new MutationObserver(() => {
        if (document.querySelector('[data-position-connect], [data-position-reason="connect_wallet"]')) window.__connectSeen.push(Date.now());
        if (document.querySelector('[data-position-loading]')) window.__waitingSeen = true;
      }).observe(document, { childList: true, subtree: true, attributes: true });
    });
    slow = true;
    await page.reload();
    await page.waitForFunction(() => ['signed_out', 'wrong_network'].includes(window.__dominoSessionProbe?.view().status), null, { timeout: 30_000 });
    await detail.waitFor({ timeout: 30_000 });
    assert.deepEqual(await page.evaluate(() => window.__connectSeen), [], 'no Connect wallet while the wallet was being found');
    assert.equal(await page.evaluate(() => window.__waitingSeen), true, 'the page’s frame waited meanwhile');
  } finally { await s.close(); }
  // No wallet authorizes this site (it lists no account): the island says so, and the page asks to connect, as before.
  const visitor = await openPositionPage(browser, chainOf(), { hash: '#/positions/base-v4-5100001', read6: READ6, connect: false, intercept: (method) => (method === 'eth_accounts' ? { result: [] } : undefined) });
  try {
    const empty = visitor.page.locator('[data-empty="position-v2"][data-position-reason="connect_wallet"]');
    await empty.waitFor({ timeout: 30_000 });
    assert.equal(await empty.locator('[data-position-connect]').count(), 1);
  } finally { await visitor.close(); }
});

test('(c) Add liquidity with a swap: the review shows the route, the fee and its base, how much smaller, the L1 data fee; the steps are the NFT approval and the add', async () => {
  const chain = chainOf();
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100005', read6: READ6, planner: plannerFor() });
  try {
    const page = s.page;
    const detail = page.locator('[data-position-detail][data-position-id="5100005"]');
    await detail.waitFor({ timeout: 30_000 });
    await pick(detail, 'increase');
    const dialog = page.locator('[role="dialog"][data-position-dialog="v2-increase"]');
    await dialog.waitFor();
    assert.equal(await dialog.getAttribute('data-position-gate'), 'live');
    assert.equal(await text(dialog.locator('.dm-receipt-lede')), 'Add more to this position. Domino swaps for you when needed.');
    assert.equal(await text(dialog.locator('[data-position-fees-sent]')), 'Uncollected fees will also be sent to your wallet.');
    // Changed on purpose 2026-10-03 (the owner, point 9): the token to pay with is the chip in the amount panel (a select).
    const chip = dialog.getByRole('combobox', { name: 'Pay with' });
    await chip.click();
    const list = page.getByRole('listbox', { name: 'Pay with' });
    assert.deepEqual(await list.getByRole('option').allInnerTexts(), ['ETH', 'USDC', 'WETH'], 'the pool’s two tokens, then the other one the chain’s profile names');
    // Escape closes the list first, the dialog stays open (src/lib/useDialog.ts).
    await page.keyboard.press('Escape');
    await list.waitFor({ state: 'detached' });
    assert.equal(await dialog.count(), 1, 'the dialog is still open');
    await chip.click();
    await page.getByRole('option', { name: 'ETH', exact: true }).click();
    await dialog.locator(`[data-position-amount="${ZERO}"] input`).fill('0.05');
    await dialog.locator('[data-position-continue="increase"]').click();
    const review = dialog.locator('[data-position-review="increase"]');
    await review.waitFor({ timeout: 30_000 });
    // Changed on purpose 2026-10-06 (the owner's point 4: as New position's Review): in view, the two cards, ONE Domino fee
    // line (§2.8: the amount, then its base in brackets) and ONE network fee line (§2.4: the plan's cost).
    assert.match(await text(review.locator('[data-position-fee="charged"]')), /^Domino fee [\d.]+ USDC \(0\.65% of 57 USDC swapped\)$/);
    assert.match(await text(review.locator('[data-position-fee-base]')), /^0\.65% of 57 USDC swapped$/);
    assert.ok(await review.locator('[data-position-l1-fee]').count() === 1);
    await review.locator('[data-position-network-fee="about"]').waitFor({ timeout: 30_000 });
    // Changed on purpose 2026-10-06 (the review of point 4): the plan's own cost (500,000 gas at the wallet's 0.2 gwei and
    // Base's L1 data fee) and the position's approval, a transaction of its own (600,000 gas and its 7 gwei L1 ceiling).
    assert.equal(await text(review.locator('[data-position-network-fee]')), 'Network fee About 0.00022 ETH');
    assert.equal(await review.locator('[data-position-network-fee]').getAttribute('data-position-network-wei'), String(100_000_000_000_000n + 10_345_963_635n + 120_000_000_000_000n + 7_000_000_000n));
    assert.equal(await review.locator('[data-position-slippage-warning]').count(), 0, 'nothing to warn about at 0.5%');
    assert.doesNotMatch(await text(review.locator('.dm-receipt')), /v4|v3/, 'the version is never text in the review\'s list');
    for (const gone of ['As planned', 'Shown before each step']) assert.ok(!(await text(review)).includes(gone), gone);
    assert.equal(await dialog.locator('[data-position-step-fee]').count(), 0, 'no network fee on each step');
    // Changed on purpose 2026-10-06 (the review of point 4, as New position's steps): no "Waiting" under a step not started.
    await dialog.locator('[data-position-confirm="approve-nft"]:not([disabled])').waitFor({ timeout: 30_000 });
    assert.equal(await dialog.locator('[data-position-steps] .dm-flow-wstep-note').count(), 0, 'titles only until a step is under way');
    // The rest under the one Details, closed; the developer facts only as its data attributes.
    const details = review.locator('[data-position-review-details]');
    assert.equal(await details.getAttribute('open'), null);
    assert.match(await details.getAttribute('data-plan-hash'), /^0x[0-9a-f]{64}$/);
    assert.equal(await details.getAttribute('data-zap'), ZAP_V4);
    await dialog.screenshot({ path: join(shots(), 'position-v2-increase-review.png') });
    await details.locator('summary').click();
    // The pool and the route's pools: "Uniswap" and the tier, the version only as a title (review #12) and under Details.
    assert.match(await text(details.locator('[data-position-review-pool]')), /^Pool ETH \/ USDC · Uniswap · 0\.05%$/);
    assert.match(await details.locator('[data-position-review-pool] [title]').getAttribute('title'), /^Uniswap v4 · 0x/);
    assert.match(await text(details.locator('[data-position-route-leg="0"]')), /0\.025 ETH → USDC Expected 57 USDC At least [\d.]+ USDC Uniswap · 0\.05%/);
    assert.match(await text(details.locator('[data-position-smaller]')), /^If the price moves within your slippage, your position can be up to [\d.]+% smaller\. The rest returns to your wallet\.$/);
    assert.match(await text(details.locator('[data-position-deadline]')), /\d+ (s|min), then a new quote/);
    assert.match(await text(details.locator('[data-position-l1]')), /^L1 data fee [\d.]+ ETH$/);
    // Base's ceiling under a label of its own; the tokens' contracts as New position names them, the version only as data.
    assert.match(await text(details.locator('[data-position-network-ceiling]')), /^Network fee, at most [\d.]+ ETH$/);
    assert.equal(await text(details.locator('[data-position-review-tokens]')), 'Token contracts ETH (native) / 0x8335…2913');
    assert.equal(await details.locator('[data-position-review-tokens] [title]').nth(1).getAttribute('title'), USDC, 'every digit in its title');
    assert.equal(await details.getAttribute('data-dex'), 'v4');
    for (const gone of ['Uniswap version', 'Pool tokens', '0x0000…0000']) assert.ok(!(await text(details)).includes(gone), gone);
    assert.match(await text(details), /Paying with ETH needs a direct transaction\./);
    for (const diagnostic of ['Plan hash', 'Route hash', 'Signature nonce', 'Domino contract', 'Gas (L2)', ' wei', 'Routing']) assert.ok(!(await text(details)).includes(diagnostic), diagnostic);
    await details.scrollIntoViewIfNeeded();
    await details.screenshot({ path: join(shots(), 'position-v2-increase-review-details.png') });
    const steps = dialog.locator('[data-position-steps="direct"]');
    assert.deepEqual(await steps.locator('[data-position-step]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-position-step'))), ['approve-nft', 'action']);
    await dialog.locator('[data-position-confirm="approve-nft"]:not([disabled])').click({ timeout: 30_000 });
    // Added 2026-10-14 (incident C1; the owner's decision D0): a step that is in a block says "Confirmed" under its title
    // (it was "Included", then "Finalized"), and the receipt leads with the same word, final or not.
    assert.equal(await steps.locator('[data-position-step="approve-nft"][data-step-state="done"] .dm-flow-wstep-note').innerText(), 'Confirmed');
    await dialog.locator('[data-position-confirm="action"]:not([disabled])').click({ timeout: 30_000 });
    const receipt = dialog.locator('[data-position-receipt]');
    await receipt.waitFor({ timeout: 30_000 });
    assert.deepEqual(await receipt.locator('[data-position-receipt-line]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-position-receipt-line'))).then((lines) => lines.filter((line, i, all) => all.indexOf(line) === i)).then((lines) => lines.filter((line) => ['paid-in', 'swapped', 'fee', 'position-added'].includes(line))), ['paid-in', 'swapped', 'fee', 'position-added']);
    assert.equal(await receipt.locator(':is([data-position-receipt-state="included"], [data-position-receipt-state="finalized"])[data-state="done"]').innerText(), 'Confirmed');
    const [approve, add] = chain.sends.map((entry) => entry.tx);
    assert.deepEqual(decodeFunctionData({ abi: NFT, data: approve.data }).args, [ZAP_V4, 5_100_005n], 'the zap approved on this NFT only');
    assert.deepEqual([add.to, add.data.slice(0, 10), BigInt(add.value)], [ZAP_V4, '0x2e563c43', 50_000_000_000_000_000n], 'increase, with the ETH it pays');
    await dialog.locator('[data-position-back]').click();
    await dialog.waitFor({ state: 'detached' });
    // Added (2026-10-15, pack 8, package R1): the add is a row of the position's Activity at once, in the indexed row's
    // words, before read-v6 lists it; with the block's own time from the header the money client read.
    const own = page.locator('[data-position-activity] [data-v2-receipt^="session:8453:"]');
    await own.waitFor({ timeout: 10_000 });
    assert.match(await text(own.locator('summary')), /^Added to position #5100005/);
    assert.equal(await own.locator('summary .dm-receipt-check[aria-label="Confirmed"]').count(), 1);
    await own.locator('summary').click();
    assert.match(await text(own), /Paid in 0\.05 ETH/);
    assert.match(await text(own), /Domino fee \(0\.65% of the amount swapped\)/);
  } finally { await s.close(); }
});

// Added 2026-10-06 (the owner's point 4: "a small visual cue of what is happening", never a blank): a quote that ran out
// before the wallet was asked (decision #3) is asked again by itself; meanwhile the dialog keeps the last review on screen,
// greyed and busy, under its one status line, until the new review replaces it.
test('(c2) Add liquidity whose quote ran out: asked again by itself, the last review stays on screen, greyed, under one line', async () => {
  const chain = chainOf();
  const held = [];
  const answers = [];
  // The first answer is good for 10 s more once it is let go; the second for its whole 3 minutes. Each waits for the test.
  const ages = [170, 0];
  const planner = (wire) => (wire.action !== 'increase' ? undefined : new Promise((resolve) => held.push(() => {
    const positionState = { tokenId: BigInt(wire.position.tokenId), manager: V4_PM, ...RANGE, liquidity: LIQUIDITY, feesOwed: [0n, 0n], approved: ZERO, subscriber: ZERO };
    const legs = [{ tokenIn: ZERO, tokenOut: USDC, amountIn: 25_000_000_000_000_000n, expectedOut: 57_000_000n, data: v4Path(POOL) }];
    const body = planAnswer(wire, { owner: OWNER, zap: ZAP_V4, now: now() - (ages[answers.length] ?? 0), pool: { sqrtPriceX96: SQRT, tick: TICK }, positionPool: POOL, position: positionState, legs, expected: { amounts: [25_000_000_000_000_000n, 56_600_000n], returned: [] } });
    answers.push(body);
    resolve(body);
  })));
  const asked = async (count) => { for (let i = 0; i < 300 && held.length < count; i += 1) await new Promise((done) => setTimeout(done, 100)); assert.equal(held.length, count, 'the plan was asked'); };
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100005', read6: READ6, planner });
  try {
    const page = s.page;
    const detail = page.locator('[data-position-detail][data-position-id="5100005"]');
    await detail.waitFor({ timeout: 30_000 });
    await pick(detail, 'increase');
    const dialog = page.locator('[role="dialog"][data-position-dialog="v2-increase"]');
    await dialog.getByRole('combobox', { name: 'Pay with' }).click();
    await page.getByRole('option', { name: 'ETH', exact: true }).click();
    await dialog.locator(`[data-position-amount="${ZERO}"] input`).fill('0.05');
    await dialog.locator('[data-position-continue="increase"]').click();
    await asked(1);
    assert.equal(await text(dialog.locator('[data-position-quoting]')), 'Getting a quote…');
    held.shift()();
    const review = dialog.locator('[data-position-review="increase"]:not([data-position-review-stale])');
    await review.locator('[data-position-network-fee="about"]').waitFor({ timeout: 30_000 });
    const before = await text(review.locator('[data-position-fee="charged"]'));
    await dialog.locator('[data-position-confirm="approve-nft"]:not([disabled])').waitFor({ timeout: 30_000 });
    const expiresAt = answers[0].plan.expiresAt;
    while (Date.now() / 1000 < expiresAt + 0.5) await new Promise((done) => setTimeout(done, 200));
    await dialog.locator('[data-position-confirm="approve-nft"]').click();
    await asked(1);
    const stale = dialog.locator('[data-position-review="increase"][data-position-review-stale]');
    await stale.waitFor({ timeout: 30_000 });
    assert.equal(await stale.getAttribute('aria-busy'), 'true');
    assert.equal(await text(stale.locator('[data-position-fee="charged"]')), before, 'the last figures stay on screen');
    // Changed on purpose 2026-10-06 (the review of point 4): one neutral sentence; this quote only ran out.
    assert.equal(await text(dialog.locator('[data-position-quoting]')), 'Getting a fresh quote…');
    assert.equal(await dialog.getByText(/Getting a (fresh )?quote…/).count(), 1, 'said once');
    await dialog.screenshot({ path: join(shots(), 'position-v2-requoting.png') });
    held.shift()();
    await review.locator('[data-position-network-fee="about"]').waitFor({ timeout: 30_000 });
    assert.equal(await dialog.locator('[data-position-review-stale]').count(), 0, 'the new review replaced it');
    assert.equal(s.planned.length, 2);
    assert.equal(chain.sends.length, 0, 'nothing was sent: the quote ran out first');
  } finally { await s.close(); }
});

// Added 2026-10-06 (the review of point 4): a wallet that batches (EIP-5792) confirms the position's approval and the add
// at once; the review's one network fee line is then the batch's own ceiling, "Up to", and a fresh quote of the same
// choices keeps that figure on screen, greyed, under its one line, until the new review replaces it.
test('(c3) Add liquidity with a wallet that batches: one step, the network fee up to the batch’s ceiling; asked again, the greyed review keeps it', async () => {
  const chain = chainOf({ atomic: 'supported', simulateV1: true });
  const held = [];
  const answers = [];
  // The first answer is good for 10 s more once it is let go; the second for its whole 3 minutes. Each waits for the test.
  const ages = [170, 0];
  const planner = (wire) => (wire.action !== 'increase' ? undefined : new Promise((resolve) => held.push(() => {
    const positionState = { tokenId: BigInt(wire.position.tokenId), manager: V4_PM, ...RANGE, liquidity: LIQUIDITY, feesOwed: [0n, 0n], approved: ZERO, subscriber: ZERO };
    const legs = [{ tokenIn: ZERO, tokenOut: USDC, amountIn: 25_000_000_000_000_000n, expectedOut: 57_000_000n, data: v4Path(POOL) }];
    const body = planAnswer(wire, { owner: OWNER, zap: ZAP_V4, now: now() - (ages[answers.length] ?? 0), pool: { sqrtPriceX96: SQRT, tick: TICK }, positionPool: POOL, position: positionState, legs, expected: { amounts: [25_000_000_000_000_000n, 56_600_000n], returned: [] } });
    answers.push(body);
    resolve(body);
  })));
  const asked = async (count) => { for (let i = 0; i < 300 && held.length < count; i += 1) await new Promise((done) => setTimeout(done, 100)); assert.equal(held.length, count, 'the plan was asked'); };
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100005', read6: READ6, planner });
  try {
    const page = s.page;
    const detail = page.locator('[data-position-detail][data-position-id="5100005"]');
    await detail.waitFor({ timeout: 30_000 });
    await pick(detail, 'increase');
    const dialog = page.locator('[role="dialog"][data-position-dialog="v2-increase"]');
    await dialog.getByRole('combobox', { name: 'Pay with' }).click();
    await page.getByRole('option', { name: 'ETH', exact: true }).click();
    await dialog.locator(`[data-position-amount="${ZERO}"] input`).fill('0.05');
    await dialog.locator('[data-position-continue="increase"]').click();
    await asked(1);
    held.shift()();
    const review = dialog.locator('[data-position-review="increase"]:not([data-position-review-stale])');
    const line = review.locator('[data-position-network-fee="upTo"]');
    await line.waitFor({ timeout: 30_000 });
    const before = await text(line);
    assert.match(before, /^Network fee Up to [\d.]+ ETH$/, 'the batch’s own ceiling: the approval and the add together');
    assert.equal(await dialog.locator('[data-position-steps="batch"] [data-position-step="batch"]').count(), 1, 'one step');
    await dialog.locator('[data-position-confirm="batch"]:not([disabled])').waitFor({ timeout: 30_000 });
    const expiresAt = answers[0].plan.expiresAt;
    while (Date.now() / 1000 < expiresAt + 0.5) await new Promise((done) => setTimeout(done, 200));
    await dialog.locator('[data-position-confirm="batch"]').click();
    await asked(1);
    const stale = dialog.locator('[data-position-review="increase"][data-position-review-stale]');
    await stale.waitFor({ timeout: 30_000 });
    assert.equal(await text(stale.locator('[data-position-network-fee="upTo"]')), before, 'the batch’s figure stays on screen');
    assert.equal(await text(dialog.locator('[data-position-quoting]')), 'Getting a fresh quote…');
    held.shift()();
    await review.locator('[data-position-network-fee="upTo"]').waitFor({ timeout: 30_000 });
    assert.equal(await dialog.locator('[data-position-review-stale]').count(), 0, 'the new review replaced it');
    assert.deepEqual([chain.sends.length, chain.batches.length], [0, 0], 'nothing was sent: the quote ran out first');
  } finally { await s.close(); }
});

// Added 2026-10-06 (the review of point 4, as New position's Review): a slippage above 2% chosen under the form's
// Advanced is said in view on the review, in the spec's words, while the tolerance itself is folded under Details.
test('(c4) Add liquidity at 3% slippage: the review says so in view, in the spec’s words', async () => {
  const chain = chainOf();
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100005', read6: READ6, planner: plannerFor() });
  try {
    const page = s.page;
    const detail = page.locator('[data-position-detail][data-position-id="5100005"]');
    await detail.waitFor({ timeout: 30_000 });
    await pick(detail, 'increase');
    const dialog = page.locator('[role="dialog"][data-position-dialog="v2-increase"]');
    await dialog.getByRole('combobox', { name: 'Pay with' }).click();
    await page.getByRole('option', { name: 'ETH', exact: true }).click();
    await dialog.locator(`[data-position-amount="${ZERO}"] input`).fill('0.05');
    await dialog.locator('[data-position-advanced] > summary').click();
    await dialog.locator('#position-v2-increase-slippage-exact').fill('3');
    await dialog.locator('[data-position-advanced] [data-slippage-warning]').waitFor();
    await dialog.locator('[data-position-continue="increase"]').click();
    const review = dialog.locator('[data-position-review="increase"]');
    await review.locator('[data-position-network-fee="about"]').waitFor({ timeout: 30_000 });
    assert.equal(s.planned[0].slippageBps, 300, 'the plan was asked at 3%');
    assert.equal(await text(review.locator('[data-position-slippage-warning]')), 'High slippage: you may receive noticeably less than quoted.');
    await dialog.screenshot({ path: join(shots(), 'position-v2-increase-review-high-slippage.png') });
    assert.equal(chain.sends.length, 0);
  } finally { await s.close(); }
});

// Added 2026-11-02 (review of the money PRs, M4: a typed "1,250" was 1250, a thousand times the 1.25 that someone who
// writes a decimal comma meant; "0,125" was 125 here, through v2/plan/present.ts parseUnitsText). Add liquidity says what
// the comma needs under the field and asks for nothing; "0,05" is 0.05 ETH in a browser set to Brazilian Portuguese, and
// asks for a dot in one set to English (src/lib/create/typedFigure.ts).
for (const locale of ['pt-BR', 'en-US']) test(`(c4b) Add liquidity in a ${locale} browser: a typed comma is never a thousand times the amount`, async () => {
  const chain = chainOf();
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100005', read6: READ6, planner: plannerFor(), locale });
  try {
    const page = s.page;
    const detail = page.locator('[data-position-detail][data-position-id="5100005"]');
    await detail.waitFor({ timeout: 30_000 });
    await pick(detail, 'increase');
    const dialog = page.locator('[role="dialog"][data-position-dialog="v2-increase"]');
    await dialog.getByRole('combobox', { name: 'Pay with' }).click();
    await page.getByRole('option', { name: 'ETH', exact: true }).click();
    const field = dialog.locator(`[data-position-amount="${ZERO}"] input`);
    const hint = dialog.locator('[data-position-comma-hint]');
    const go = dialog.locator('[data-position-continue="increase"]');
    await field.fill('1,250');
    assert.equal(await text(hint), '1,250 could mean 1.25 or 1250. Type 1.25 or 1250.');
    assert.equal(await go.isDisabled(), true, 'never read as 1250');
    await field.fill('0,05');
    if (locale === 'pt-BR') {
      assert.equal(await hint.count(), 0);
      await go.click();
      await dialog.locator('[data-position-review="increase"] [data-position-network-fee="about"]').waitFor({ timeout: 30_000 });
      assert.deepEqual(s.planned[0].inputs.map((input) => [input.token, String(input.amountRaw)]), [[ZERO, '50000000000000000']], 'the plan was asked for 0.05 ETH');
    } else {
      assert.equal(await text(hint), 'Use a dot for decimals, like 0.5.');
      assert.equal(await go.isDisabled(), true);
      assert.equal(s.planned.length, 0, 'nothing asked for a refused amount');
    }
    assert.equal(chain.sends.length, 0);
  } finally { await s.close(); }
});

// Added 2026-10-06 (the review of point 4, ux #1, as New position's Review): when Base's oracle did not answer, the plan's
// L1 data fee is unavailable; the one network fee line says the rest in one plain clause, never "L1", a 0 or a bare dash in
// view, and Details keeps the L1 data fee's own row.
test('(c5) Add liquidity when the plan could not read Base’s L1 data fee: the network fee line says the rest in words', async () => {
  const chain = chainOf();
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100005', read6: READ6, planner: plannerFor({ l1Unavailable: true }) });
  try {
    const page = s.page;
    const detail = page.locator('[data-position-detail][data-position-id="5100005"]');
    await detail.waitFor({ timeout: 30_000 });
    await pick(detail, 'increase');
    const dialog = page.locator('[role="dialog"][data-position-dialog="v2-increase"]');
    await dialog.getByRole('combobox', { name: 'Pay with' }).click();
    await page.getByRole('option', { name: 'ETH', exact: true }).click();
    await dialog.locator(`[data-position-amount="${ZERO}"] input`).fill('0.05');
    await dialog.locator('[data-position-continue="increase"]').click();
    const review = dialog.locator('[data-position-review="increase"]');
    const line = review.locator('[data-position-network-fee="about"]');
    await line.waitFor({ timeout: 30_000 });
    assert.equal(await line.getAttribute('data-position-l1-fee'), 'unavailable');
    assert.match(await text(line), /^Network fee About [\d.]+ ETH, plus a little more your wallet shows before you confirm$/);
    assert.equal(await line.locator('[data-figure="none"]').count(), 0, 'no bare dash in view');
    await dialog.screenshot({ path: join(shots(), 'position-v2-increase-review-l1-unavailable.png') });
    const details = review.locator('[data-position-review-details]');
    await details.locator('summary').click();
    assert.match(await text(details.locator('[data-position-l1]')), /^L1 data fee —$/);
    assert.equal(chain.sends.length, 0);
  } finally { await s.close(); }
});

// Added 2026-10-06 (the review, money #3, a second look): one amount, one figure in the dialog. What you put in is rounded
// up on the review (it is what the wallet is asked to allow), and the receipt's "Paid in" writes the same amount the same
// way, here with more decimals than the screen shows.
test('(c6) Add liquidity: the receipt’s "Paid in" is the review’s "You put in", one figure for one amount', async () => {
  const chain = chainOf();
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100005', read6: READ6, planner: plannerFor() });
  try {
    const page = s.page;
    const detail = page.locator('[data-position-detail][data-position-id="5100005"]');
    await detail.waitFor({ timeout: 30_000 });
    await pick(detail, 'increase');
    const dialog = page.locator('[role="dialog"][data-position-dialog="v2-increase"]');
    await dialog.getByRole('combobox', { name: 'Pay with' }).click();
    await page.getByRole('option', { name: 'ETH', exact: true }).click();
    await dialog.locator(`[data-position-amount="${ZERO}"] input`).fill('0.0500004');
    await dialog.locator('[data-position-continue="increase"]').click();
    const review = dialog.locator('[data-position-review="increase"]');
    await review.locator('[data-position-network-fee="about"]').waitFor({ timeout: 30_000 });
    assert.equal(await text(review.locator('[data-position-review-inputs]')), 'You put in 0.050001 ETH', 'rounded up');
    await dialog.locator('[data-position-confirm="approve-nft"]:not([disabled])').click({ timeout: 30_000 });
    await dialog.locator('[data-position-confirm="action"]:not([disabled])').click({ timeout: 30_000 });
    const paid = dialog.locator('[data-position-receipt] [data-position-receipt-line="paid-in"]');
    await paid.waitFor({ timeout: 30_000 });
    assert.equal(await text(paid), 'Paid in 0.050001 ETH', 'the review’s own figure');
    assert.equal(BigInt(chain.sends.at(-1).tx.value), 50_000_400_000_000_000n, 'every digit paid, as typed');
  } finally { await s.close(); }
});

test('(d) Withdraw in one token: the converted line and its offers; sent, its receipt carries the Domino fee', async () => {
  const chain = chainOf();
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100001', read6: READ6, planner: plannerFor() });
  try {
    const page = s.page;
    const detail = page.locator('[data-position-detail][data-position-id="5100001"]');
    await detail.waitFor({ timeout: 30_000 });
    await pick(detail, 'exit');
    const dialog = page.locator('[role="dialog"][data-position-dialog="v2-exit"]');
    assert.equal(await text(dialog.locator('[data-position-way-note]')), 'No Domino fee.');
    // Changed on purpose 2026-10-03 (the owner, point 9): what you receive is one choice of three cards, both tokens or either one.
    const receive = dialog.getByRole('radiogroup', { name: 'You receive' });
    assert.deepEqual(await receive.getByRole('radio').allInnerTexts(), ['Both tokens', 'ETH', 'USDC']);
    await receive.getByRole('radio', { name: 'USDC', exact: true }).click();
    assert.equal(await text(dialog.locator('[data-position-way-note]')), 'Domino swaps for you: 0.65% of the amount swapped.');
    await dialog.locator('[data-position-continue="exit"]').click();
    const review = dialog.locator('[data-position-review="exit"]');
    await review.waitFor({ timeout: 30_000 });
    assert.match(await text(review.locator('[data-position-converted] p')), /^At 0\.5% slippage, at least [\d.]+ ETH is converted\. Up to [\d.]+ ETH may come back unconverted\.$/);
    assert.equal(await text(review.locator('[data-position-converted="offer"] [data-position-lower-slippage]')), 'Lower slippage');
    assert.equal(await text(review.locator('[data-position-converted="offer"] [data-position-receive-both]')), 'Receive both tokens');
    assert.match(await text(review.locator('[data-position-fee="charged"]')), /^Domino fee [\d.]+ USDC \(0\.65% of [\d.,]+ USDC swapped\)$/);
    await dialog.screenshot({ path: join(shots(), 'position-v2-exit-review.png') });
    // The minimums under Details (Changed on purpose 2026-10-06, the owner's point 4).
    await review.locator('[data-position-review-details] summary').click();
    assert.match(await text(review.locator('[data-position-at-least]')), /ETH.*USDC/);
    const steps = dialog.locator('[data-position-steps="direct"]');
    assert.deepEqual(await steps.locator('[data-position-step]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-position-step'))), ['action'], 'the zap already holds this NFT\'s approval');
    await dialog.locator('[data-position-confirm="action"]:not([disabled])').click({ timeout: 30_000 });
    const receipt = dialog.locator('[data-position-receipt]');
    await receipt.waitFor({ timeout: 30_000 });
    assert.ok(await receipt.locator('[data-position-receipt-line="fee"]').count() >= 1, 'FeeCharged: the exact Domino fee');
    assert.ok(await receipt.locator('[data-position-receipt-line="position-removed"]').count() >= 1);
    const [exit] = chain.sends.map((entry) => entry.tx);
    assert.deepEqual([exit.to, exit.data.slice(0, 10)], [ZAP_V4, '0xda5951bb']);
  } finally { await s.close(); }
});

// Added 2026-10-14 (incident C3: waiting never locks; screens finish at inclusion). A failed receipt read while a step
// waited for its block locked it with "Sent to your wallet…" although it succeeded, and an Add's second step could not
// follow; once done, the sheet read the receipt again every 1.5 s until the block was final (15 to 20 minutes on Base).
// Now a failed read is asked again, the next step follows, and the done sheet asks nothing more. Change range runs the same
// steps and the same wait (src/v2in/position/run.ts confirm); this suite has no Change range review to drive.
for (const action of ['increase', 'exit']) test(`(c7) ${action === 'increase' ? 'Add liquidity' : 'Withdraw in one token'}: failed receipt reads while its steps wait never lock them, and the done sheet asks nothing more`, async () => {
  // Blocks are never final here, as for the first 15 to 20 minutes on Base.
  const chain = chainOf({ finality: 'lagging' });
  const reads = [], failed = new Map();
  // The first two receipt reads of each transaction fail (a node that did not answer, then one that refused).
  const intercept = (method, params) => {
    if (method !== 'eth_getTransactionReceipt') return undefined;
    reads.push(params[0]);
    const count = (failed.get(params[0]) ?? 0) + 1;
    failed.set(params[0], count);
    return count <= 2 ? { error: { code: count === 1 ? -32603 : 429, message: count === 1 ? 'Internal JSON-RPC error.' : 'Too many requests' } } : undefined;
  };
  const tokenId = action === 'increase' ? '5100005' : '5100001';
  const s = await openPositionPage(browser, chain, { hash: `#/positions/base-v4-${tokenId}`, read6: READ6, planner: plannerFor(), intercept });
  try {
    const page = s.page;
    const detail = page.locator(`[data-position-detail][data-position-id="${tokenId}"]`);
    await detail.waitFor({ timeout: 30_000 });
    await pick(detail, action);
    const dialog = page.locator(`[role="dialog"][data-position-dialog="v2-${action}"]`);
    await dialog.waitFor();
    if (action === 'increase') {
      await dialog.getByRole('combobox', { name: 'Pay with' }).click();
      await page.getByRole('option', { name: 'ETH', exact: true }).click();
      await dialog.locator(`[data-position-amount="${ZERO}"] input`).fill('0.05');
    } else await dialog.getByRole('radiogroup', { name: 'You receive' }).getByRole('radio', { name: 'USDC', exact: true }).click();
    await dialog.locator(`[data-position-continue="${action}"]`).click();
    await dialog.locator(`[data-position-review="${action}"]`).waitFor({ timeout: 30_000 });
    await page.evaluate(() => {
      window.__dominoLocked = false;
      new MutationObserver(() => { if (document.body.innerText.includes('Sent to your wallet')) window.__dominoLocked = true; }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    const steps = action === 'increase' ? ['approve-nft', 'action'] : ['action'];
    for (const step of steps) await dialog.locator(`[data-position-confirm="${step}"]:not([disabled])`).click({ timeout: 30_000 });
    const receipt = dialog.locator('[data-position-receipt]');
    await receipt.waitFor({ timeout: 30_000 });
    assert.equal(await page.evaluate(() => window.__dominoLocked), false, 'never "Sent to your wallet…": no step locked');
    assert.equal(chain.sends.length, steps.length, 'each step sent once');
    assert.ok([...failed.values()].every((count) => count >= 3), 'each step met two failed reads, and was read again');
    const done = reads.length;
    await page.waitForTimeout(30_000);
    assert.equal(reads.length, done, 'the done sheet asks nothing more in 30 s (it read every 1.5 s until the block was final)');
    assert.equal(await receipt.locator(':is([data-position-receipt-state="included"], [data-position-receipt-state="finalized"])[data-state="done"]').innerText(), 'Confirmed');
  } finally { await s.close(); }
});

// Added 2026-10-14 (C3 review). On Base the receipt is read through the wallet: a wallet moved to another network after
// the send failed every read. Before C3 that locked the step; after C3 it waited with nothing to say why. The step now says
// to switch back, and is confirmed once the wallet is back.
test('(c8) Withdraw in one token: the wallet moved to another network while the step waits says to switch back, and the step is confirmed once it is back', async () => {
  const chain = chainOf({ finality: 'lagging' });
  let moved = false;
  // The person switches the wallet to Robinhood Chain the moment the wallet has sent the withdrawal.
  const intercept = async (method, params) => {
    if (method !== 'eth_sendTransaction' || moved) return undefined;
    const reply = await chain.request(method, params);
    moved = true;
    chain.switchTo(4663);
    return reply;
  };
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100001', read6: READ6, planner: plannerFor(), intercept });
  try {
    const page = s.page;
    const detail = page.locator('[data-position-detail][data-position-id="5100001"]');
    await detail.waitFor({ timeout: 30_000 });
    await pick(detail, 'exit');
    const dialog = page.locator('[role="dialog"][data-position-dialog="v2-exit"]');
    await dialog.waitFor();
    await dialog.getByRole('radiogroup', { name: 'You receive' }).getByRole('radio', { name: 'USDC', exact: true }).click();
    await dialog.locator('[data-position-continue="exit"]').click();
    await dialog.locator('[data-position-review="exit"]').waitFor({ timeout: 30_000 });
    await dialog.locator('[data-position-confirm="action"]:not([disabled])').click({ timeout: 30_000 });
    const step = dialog.locator('[data-position-step="action"][data-status="sent"]');
    await step.getByText('Sent. Switch your wallet back to Base to see it.', { exact: true }).waitFor({ timeout: 30_000 });
    assert.equal(await dialog.getByText(/Sent to your wallet/).count(), 0, 'never locked');
    chain.switchTo(8453);
    const receipt = dialog.locator('[data-position-receipt]');
    await receipt.waitFor({ timeout: 60_000 });
    assert.equal(chain.sends.length, 1, 'sent once');
    assert.equal(await receipt.locator(':is([data-position-receipt-state="included"], [data-position-receipt-state="finalized"])[data-state="done"]').innerText(), 'Confirmed');
  } finally { await s.close(); }
});

// Changed on purpose 2026-11-09 (the core-flows fix; the owner: closing a position with automation must be totally easy): a
// withdrawal of an armed root asks for no tick box (the note at the top says it pauses automation), and a position
// Domino-compound holds has Close position, which withdraws it from the automation first, then closes it.
test('(e) under automation: the armed root blocks Change range (the menu says why) and its exit names the reserves that stay, with no tick box; a successor has Close position in two steps; a hooked pool is not supported', async () => {
  const chain = chainOf();
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100002', read6: READ6, planner: plannerFor() });
  try {
    const page = s.page;
    const root = page.locator('[data-position-detail][data-position-id="5100002"]');
    await root.waitFor({ timeout: 30_000 });
    await root.locator('[data-position-v2-action="exit"]').waitFor();
    assert.equal(await root.locator('[data-position-v2-action="collect"]').isDisabled(), false);
    assert.equal(await root.locator('[data-position-v2-blocked]').count(), 0, 'no fixed sentence below the actions');
    // Decision #5: Change range stays listed, unavailable, with its reason on hover, keyboard focus or touch.
    // Changed on purpose
    // 2026-10-06 (the owner's point 5; rugged97: "auto-exit has no fee compounding"): a running Domino-compound is never
    // offered Auto-exit.
    const { menu, entries } = await openMenu(root);
    assert.deepEqual(entries, [['increase', 'Add liquidity', false], ['changeRange', 'Change range', true], ['exit', 'Withdraw', false]]);
    // Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation").
    const rangeButton = menu.locator('[data-position-v2-action="changeRange"]');
    const rangeReason = menu.locator('[data-position-action-reason="changeRange"]');
    assert.equal(await rangeReason.isVisible(), false, 'the reason is quiet until asked for');
    assert.equal(await rangeButton.isDisabled(), true);
    await rangeButton.hover();
    assert.equal(await text(rangeReason), 'Change range isn’t available while your automation manages this position.');
    assert.equal(await rangeReason.isVisible(), true);
    await page.mouse.move(0, 0);
    await rangeButton.focus();
    assert.equal(await rangeReason.isVisible(), true, 'keyboard users get the same reason');
    await page.keyboard.press('Escape');
    assert.equal(await rangeReason.isVisible(), false);
    await page.setViewportSize({ width: 320, height: 900 });
    await rangeButton.dispatchEvent('click');
    assert.equal(await rangeReason.isVisible(), true, 'touch can ask for the reason without starting an action');
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the reason fits on mobile');
    await page.setViewportSize({ width: 1280, height: 1000 });
    await menu.locator('button[data-position-v2-action][data-position-v2-action="exit"]').click();
      const dialog = page.locator('[role="dialog"][data-position-dialog="v2-exit"]');
    assert.equal(await text(dialog.locator('[data-position-root-note]')), 'This pauses automation for this position. You can turn it back on afterwards.');
    await dialog.getByRole('radiogroup', { name: 'You receive' }).getByRole('radio', { name: 'USDC', exact: true }).click();
    await dialog.locator('[data-position-continue="exit"]').click();
    await dialog.locator('[data-position-review="exit"]').waitFor({ timeout: 30_000 });
    // Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation").
    assert.equal(await text(dialog.locator('[data-position-reserves-stay]')), 'Fees waiting to be reinvested stay in your automation: 0.001 ETH + 2.5 USDC. After this, you go straight to withdrawing them to your wallet.');
    // No tick box and no "Tick the box above first.": the step is prepared at once; the note at the top says it pauses.
    await dialog.locator('[data-position-confirm="approve-nft"]:not([disabled])').waitFor({ timeout: 30_000 });
    assert.equal(await dialog.locator('[data-position-pause-confirm], [data-position-tick-first]').count(), 0);
    assert.equal(await dialog.locator('[data-position-pause-line]').count(), 0, 'the top note already says it: never twice');
    await page.keyboard.press('Escape');
    assert.equal(chain.sends.length, 0, 'nothing sent here');
    // A successor and a hooked position, on their own pages.
    await page.evaluate(() => { location.hash = '#/positions/base-v4-5100003'; });
    const successor = page.locator('[data-position-detail][data-position-id="5100003"]');
    await successor.waitFor({ timeout: 30_000 });
    // Changed on purpose 2026-11-09: Close position alone in the row (no Collect fees, no menu), never the sentence that
    // sent the person to another page; its dialog says in one line what happens, and lists its two steps.
    assert.equal(await successor.locator('[data-position-v2-blocked]').count(), 0);
    assert.equal(await successor.locator('[data-position-v2-action], [data-position-v2-more]').count(), 0);
    const closeHeld = successor.locator('[data-position-actions] > [data-position-action="close"]');
    assert.equal(await text(closeHeld), 'Close position');
    await closeHeld.click();
    const held = page.locator('[role="dialog"][data-position-dialog="v2-close"]');
    await held.locator('[data-close-steps]').waitFor({ timeout: 30_000 });
    assert.equal(await text(held.locator('[data-position-close-line="held"]')), 'Domino-compound holds this position. It comes back to your wallet first, then closes.');
    assert.deepEqual(await held.locator('[data-close-step]').evaluateAll((rows) => rows.map((row) => [row.getAttribute('data-close-step'), row.querySelector('.dm-flow-wstep-title').textContent])), [['withdraw-child', 'Withdraw from your automation'], ['close', 'Close position']]);
    assert.equal(await held.locator('[data-position-receive]').count(), 0, 'nothing is read at Uniswap before it is back in the wallet');
    assert.equal(await text(held.locator('[data-close-flow="withdraw-child"]')), 'Close in wallet');
    assert.equal(await held.locator('[data-close-flow="withdraw-child"]').isDisabled(), false, 'one press, never a tick box');
    assert.doesNotMatch(await text(held), /vault|NFT|successor/i);
    await closeShot(page, 'successor-close-review');
    await page.keyboard.press('Escape');
    await held.waitFor({ state: 'detached' });
    await page.evaluate(() => { location.hash = '#/positions/base-v4-5100004'; });
    const hooked = page.locator('[data-position-detail][data-position-id="5100004"]');
    await hooked.waitFor({ timeout: 30_000 });
    // Decision #6: Collect fees disabled with the reason as its title; every entry of the menu disabled, the reason its heading.
    assert.equal(await hooked.locator('[data-position-v2-action="collect"]').isDisabled(), true);
    assert.equal(await hooked.locator('[data-position-v2-action="collect"]').getAttribute('title'), "Pools with hooks aren't supported yet.");
    // Added 2026-10-15: Close position too, as V1's (disabled, the reason its title).
    assert.equal(await hooked.locator('[data-position-action="close"]').isDisabled(), true);
    assert.equal(await hooked.locator('[data-position-action="close"]').getAttribute('title'), "Pools with hooks aren't supported yet.");
    const blocked = await openMenu(hooked);
    assert.deepEqual(blocked.entries.map(([key, , disabled]) => [key, disabled]), [['increase', true], ['changeRange', true], ['exit', true]]);
    assert.equal(await blocked.menu.locator('[data-position-action-reason]:visible').count(), 0);
    await blocked.menu.locator('[data-position-v2-action="increase"]').focus();
    assert.equal(await text(blocked.menu.locator('[data-position-action-reason="increase"]')), "Pools with hooks aren't supported yet.");
    await page.keyboard.press('Escape');
  } finally { await s.close(); }
});

test('(f) Withdraw to both tokens goes straight to Uniswap: no Domino fee, one transaction to the position manager, its receipt from Uniswap\'s logs', async () => {
  const sqrt = position.sqrtPriceAtTick(-199500);
  const V4 = { tokenId: 5_100_001n, pool: { currency0: ZERO, currency1: USDC, fee: 500, tickSpacing: 10 }, ...RANGE, liquidity: LIQUIDITY,
    sqrtPriceX96: sqrt, tick: -199500, growthLast: [5n << 128n, 7n << 128n], growthNow: [(5n << 128n) + (10n ** 12n << 128n) / 10n ** 15n + 1n, (7n << 128n) + (3_000_000n << 128n) / 10n ** 15n + 1n] };
  const chain = createDirectChain({ chainId: 8453, v4: [V4], timestamp: now() });
  const read6 = { portfolio: portfolioOf({ wallet: OWNER, tokens: TOKENS, positions: [live(5_100_001, { sqrtPriceX96: sqrt, tick: -199500 })] }) };
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100001', read6, s1: { directCode: { 8453: chain.codeHashes } } });
  try {
    const page = s.page;
    const detail = page.locator('[data-position-detail][data-position-id="5100001"]');
    await detail.waitFor({ timeout: 30_000 });
    await pick(detail, 'exit');
    const dialog = page.locator('[role="dialog"][data-position-dialog="v2-exit"]');
    // Added 2026-10-30 (QA round 2, WD-MAX, the owner): nothing is typed; the whole position is "Max", chosen already.
    assert.deepEqual(await dialog.locator('.dm-pa-share').getByRole('radio').allInnerTexts(), ['Max', '50%', '25%']);
    assert.equal(await dialog.getByRole('radio', { name: 'Max', exact: true }).getAttribute('aria-checked'), 'true');
    await dialog.locator('[data-position-continue="exit"]').click();
    await dialog.locator('[data-position-direct="ready"]').waitFor({ timeout: 30_000 });
    const receive = dialog.locator('[data-position-receive="close"]');
    assert.match(await text(receive), /^You receive .*ETH.*USDC At least .*ETH.*USDC Domino fee No Domino fee Network fee Up to [\d.]+ ETH$/);
    await dialog.locator('[data-position-send="close"]:not([disabled])').click();
    await dialog.locator('[data-position-direct="done"]').waitFor({ timeout: 30_000 });
    assert.match(await text(dialog.locator('[data-position-receipt]')), /Paid by Uniswap .*Domino fee No Domino fee/);
    // Added 2026-10-14 (incident C1; the owner's decision D0): a direct exit's receipt leads with "Confirmed" too.
    assert.equal(await dialog.locator('[data-position-receipt] [data-position-receipt-state][data-state="done"]').innerText(), 'Confirmed');
    assert.equal(chain.sends.length, 1);
    assert.equal(chain.sends[0].tx.to, V4_PM);
    // Added (2026-10-15, pack 8, package R1): read-v6 lists no exit made straight at Uniswap; its checked receipt is a row
    // of the position's Activity at once, in the indexed exit's words, with what Uniswap paid and "No Domino fee".
    await dialog.locator('[data-position-back], [data-position-done]').first().click().catch(() => page.keyboard.press('Escape'));
    const own = page.locator('[data-position-activity] [data-v2-receipt^="session:8453:"]');
    await own.waitFor({ timeout: 10_000 });
    assert.match(await text(own.locator('summary')), /^Withdrew from position #5100001/);
    await own.locator('summary').click();
    assert.match(await text(own), /Returned to your wallet/);
    assert.match(await text(own), /Domino fee No Domino fee/);
  } finally { await s.close(); }
});

test('(f0) Close position, as on Robinhood (the owner, 2026-10-15): last in the row, opens straight on its review, everything in both tokens straight to Uniswap, the same exit as Withdraw of all', async () => {
  const sqrt = position.sqrtPriceAtTick(-199500);
  // The chain holds twice what read-v6 last said (an automation re-added fees since): Close takes all of it, as V1's does.
  const V4 = { tokenId: 5_100_001n, pool: { currency0: ZERO, currency1: USDC, fee: 500, tickSpacing: 10 }, ...RANGE, liquidity: BigInt(LIQUIDITY) * 2n,
    sqrtPriceX96: sqrt, tick: -199500, growthLast: [5n << 128n, 7n << 128n], growthNow: [(5n << 128n) + (10n ** 12n << 128n) / 10n ** 15n + 1n, (7n << 128n) + (3_000_000n << 128n) / 10n ** 15n + 1n] };
  const chain = createDirectChain({ chainId: 8453, v4: [V4], timestamp: now() });
  const read6 = { portfolio: portfolioOf({ wallet: OWNER, tokens: TOKENS, positions: [live(5_100_001, { sqrtPriceX96: sqrt, tick: -199500 })] }) };
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100001', read6, s1: { directCode: { 8453: chain.codeHashes } } });
  try {
    const page = s.page;
    const detail = page.locator('[data-position-detail][data-position-id="5100001"]');
    await detail.waitFor({ timeout: 30_000 });
    const close = detail.locator('[data-position-actions] > [data-position-action="close"]');
    assert.equal(await text(close), 'Close position');
    assert.equal(await detail.locator('[data-position-actions] > :last-child').getAttribute('data-position-action'), 'close', 'last in the row, as on V1');
    assert.equal(await close.isDisabled(), false);
    await page.screenshot({ path: join(shots(), 'position-v2-close.png') });
    await close.click();
    const dialog = page.locator('[role="dialog"][data-position-dialog="v2-close"]');
    assert.match(await text(dialog), /Your tokens and fees return to your wallet\. The position, now empty, stays in your wallet\./);
    assert.equal(await dialog.locator('[data-position-continue], [data-position-review-back], .dm-pa-share').count(), 0, 'no form: straight on its review');
    await dialog.locator('[data-position-direct="ready"]').waitFor({ timeout: 30_000 });
    // Changed on purpose 2026-11-06 (O-10): Robinhood Chain's Close position says no Domino fee line.
    assert.match(await text(dialog.locator('[data-position-receive="close"]')), /^You receive .*ETH.*USDC At least .*ETH.*USDC Network fee Up to [\d.]+ ETH$/);
    assert.equal(await dialog.locator('[data-close-advanced]').count(), 1, 'its slippage under Advanced');
    const send = dialog.locator('[data-position-send="close"]:not([disabled])');
    assert.equal(await text(send), 'Close in wallet');
    await send.click();
    await dialog.locator('[data-position-direct="done"]').waitFor({ timeout: 30_000 });
    assert.equal(chain.sends.length, 1);
    assert.equal(chain.sends[0].tx.to, V4_PM);
    const [unlock] = decodeFunctionData({ abi: parseAbi(['function modifyLiquidities(bytes unlockData, uint256 deadline)']), data: chain.sends[0].tx.data }).args;
    const [, params] = decodeAbiParameters(position.unlockParameters, unlock);
    assert.equal(decodeAbiParameters(position.decreaseParameters, params[0])[1], BigInt(LIQUIDITY) * 2n, 'everything the chain holds, not the read-v6 figure');
    assert.equal(await dialog.locator('[data-position-rearm]').count(), 0, 'nothing to turn back on after everything left');
  } finally { await s.close(); }
});

test('(f0b) Close position whose read fails: "Try again", as on V1, reads again, never a dead end', async () => {
  const sqrt = position.sqrtPriceAtTick(-199500);
  // Already empty on chain while read-v6 still lists its liquidity: the read refuses, then the chain is read again.
  const V4 = { tokenId: 5_100_001n, pool: { currency0: ZERO, currency1: USDC, fee: 500, tickSpacing: 10 }, ...RANGE, liquidity: 0n,
    sqrtPriceX96: sqrt, tick: -199500, growthLast: [5n << 128n, 7n << 128n], growthNow: [5n << 128n, 7n << 128n] };
  const chain = createDirectChain({ chainId: 8453, v4: [V4], timestamp: now() });
  const read6 = { portfolio: portfolioOf({ wallet: OWNER, tokens: TOKENS, positions: [live(5_100_001, { sqrtPriceX96: sqrt, tick: -199500 })] }) };
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100001', read6, s1: { directCode: { 8453: chain.codeHashes } } });
  try {
    const page = s.page;
    const detail = page.locator('[data-position-detail][data-position-id="5100001"]');
    await detail.waitFor({ timeout: 30_000 });
    await detail.locator('[data-position-actions] > [data-position-action="close"]').click();
    const dialog = page.locator('[role="dialog"][data-position-dialog="v2-close"]');
    await dialog.locator('[data-position-direct="failed"]').waitFor({ timeout: 30_000 });
    const retry = dialog.locator('[data-position-retry]:not([disabled])');
    assert.equal(await text(retry), 'Try again');
    await retry.click();
    await dialog.locator('[data-position-direct="failed"]').waitFor({ timeout: 30_000 });
    assert.equal(chain.sends.length, 0, 'nothing sent');
  } finally { await s.close(); }
});

// Changed on purpose 2026-11-09 (the core-flows fix, item b): the direct actions (Collect fees, Withdraw in both tokens,
// Close position) need no plan, so the planner's preview no longer locks them on a chain that is live: they read and send
// as under `live`. The zap's actions (Add liquidity here) still stop at the gate's sentence, and no plan is asked.
test('(g) preview (the gate open, no live set): the same page from read-v6; the zap\'s actions stop at their review with the gate\'s sentence, the direct ones are never locked by it, and no plan is asked', async () => {
  // The wallet on Robinhood Chain, the position on Base (read-v6's).
  const chain = createV2Chain({ chainId: 4663, timestamp: now() });
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100005', read6: READ6, live: false, script: true });
  try {
    const page = s.page;
    const detail = page.locator('[data-position-detail][data-position-v2="base-v4"][data-position-id="5100005"]');
    await detail.waitFor({ timeout: 30_000 });
    assert.doesNotMatch(await text(detail), /test data|example/i, 'real data only: nothing is marked as test data');
    assert.equal(await detail.locator('[data-position-actions] [data-position-v2-actions="preview"] [data-position-v2-more]').count(), 1);
    await page.screenshot({ path: join(shots(), 'position-v2-preview.png'), fullPage: true });
    // Collect fees opens straight on its review: a direct exit, read through the wallet and offered as under `live`.
    await detail.locator('[data-position-v2-action="collect"]').click();
    const collect = page.locator('[role="dialog"][data-position-dialog="v2-collect"]');
    assert.equal(await collect.getAttribute('data-position-gate'), 'preview');
    await collect.locator('[data-position-direct]').waitFor({ timeout: 30_000 });
    assert.equal(await collect.locator('[data-position-locked], [data-position-request]').count(), 0, 'never the planner\'s sentence on a direct exit');
    assert.equal(await collect.locator('[data-position-send="collect"]').count(), 1, 'its own wallet button');
    await page.keyboard.press('Escape');
    await collect.waitFor({ state: 'detached' });
    // Add liquidity: what was chosen, then the gate's sentence, once; no plan is asked.
    await pick(detail, 'increase');
    const add = page.locator('[role="dialog"][data-position-dialog="v2-increase"]');
    assert.equal(await add.getAttribute('data-position-gate'), 'preview');
    await add.locator(`[data-position-amount="${USDC}"] input`).fill('10');
    await add.locator('[data-position-continue="increase"]').click();
    await add.locator('[data-position-request="increase"]').waitFor({ timeout: 30_000 });
    assert.equal(await text(add.locator('[data-position-request="increase"]')), 'You put in 10 USDC Slippage 0.5%');
    assert.equal(await text(add.locator('[data-position-locked]')), LOCKED_BASE);
    assert.equal(await add.locator('[data-position-locked]').count(), 1, 'the gate\'s sentence once');
    assert.equal(await add.locator('[data-position-confirm], [data-position-preview-note]').count(), 0, 'no wallet step and no second note in the preview');
    await page.keyboard.press('Escape');
    await add.waitFor({ state: 'detached' });
    // Withdraw in both tokens: a direct action too: never locked by the planner's word.
    await pick(detail, 'exit');
    const exit = page.locator('[role="dialog"][data-position-dialog="v2-exit"]');
    assert.equal(await text(exit.locator('[data-position-way-note]')), 'No Domino fee.');
    await exit.locator('[data-position-continue="exit"]').click();
    await exit.locator('[data-position-direct]').waitFor({ timeout: 30_000 });
    assert.equal(await exit.locator('[data-position-locked]').count(), 0);
    assert.equal(await exit.locator('[data-position-send="close"]').count(), 1);
    await page.keyboard.press('Escape');
    await exit.waitFor({ state: 'detached' });
    assert.equal(chain.sends.length, 0, 'nothing sent without a press');
    assert.deepEqual(s.planned, [], 'the preview asks no plan service');
    // A position read-v6 does not list.
    await page.evaluate(() => { location.hash = '#/positions/base-v4-424242'; });
    await page.locator('[data-empty="position-v2"][data-position-reason="position_not_listed"]').waitFor({ timeout: 30_000 });
    assert.match(await text(page.locator('[data-empty="position-v2"]')), /This position isn’t in your wallet’s list\./);
  } finally { await s.close(); }
});

// Changed on purpose 2026-10-06 (the owner's point 5): Auto-exit's edges are the range's. Changed on purpose 2026-10-06
// (the review of point 5): live, the edges a review arms are chosen against the pool's own price, read through the wallet
// (tests/v2in-browser/automate.test.mjs); under the preview, where nothing is armed and no wallet is asked, the page's
// read draws them, a stale one too (marked so), never a dialog waiting for a read that is not coming.
test('V2 Auto-exit on Base, preview: current custody opens the range\'s exact edges; stale custody offers no setup and no wallet is asked to switch', async () => {
  for (const stale of [false, true]) {
    const chain = createV2Chain({ chainId: 4663, timestamp: now() });
    const read6 = { portfolio: portfolioOf({ wallet: OWNER, tokens: TOKENS, positions: [live(5_100_005, { stale })] }) };
    const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100005', read6, live: false, script: true });
    try {
      const page = s.page;
      const detail = page.locator('[data-position-detail][data-position-v2="base-v4"]');
      if (stale) {
        // Changed on purpose 2026-10-15 (pack 7, owner: no status notices): the control names the automation alone; it said "· State unavailable".
        assert.doesNotMatch(await text(detail.locator('[data-automation-control]')), /State unavailable|\bOff\b/);
        assert.equal(await detail.locator('[data-automation-setup]').count(), 0, 'stale custody cannot enable a new automation');
        assert.equal(chain.sends.length, 0);
        continue;
      }
      await detail.locator('[data-automation-setup]').click();
      const setup = page.locator('[data-v2in-setup="preview"][data-sequence-create]');
      await setup.waitFor();
      assert.match(page.url(), /\/sequence\/base-v4-5100005$/);
      await setup.locator('[data-sequence-mode="protection"]').click();
      await setup.locator('[data-sequence-action="protection"]:not([disabled])').click();
      const dialog = page.locator('[data-v2in-dialog="mandate"]');
      await dialog.waitFor();
      // The price (tick -199,020) inside the range (-201,060 to -197,040): both edges, exactly TickMath's integers.
      const edges = dialog.locator('[data-mandate-edges="inside"] [data-mandate-edge]');
      await edges.first().waitFor();
      const exact = await edges.evaluateAll((items) => items.map((li) => [li.getAttribute('data-mandate-trigger'), li.getAttribute('data-exact')]).sort());
      assert.deepEqual(exact, [['above', position.sqrtPriceAtTick(RANGE.tickUpper).toString()], ['below', position.sqrtPriceAtTick(RANGE.tickLower).toString()]]);
      for (const edge of await edges.all()) assert.match(await text(edge), /^[↘↗] (falls|rises) to [\d,.]+ USDC per ETH$/);
      assert.equal(await dialog.locator('[data-mandate-edges]').getAttribute('data-mandate-price'), 'saved', 'setup uses the indexed snapshot in preview, without asking the wallet');
      assert.match(await text(dialog.locator('[data-mandate-now]')), /^Now [\d,.]+$/);
      assert.equal(await dialog.locator('[data-mandate-problem]').count(), 0, 'never "Reading the pool price…" with nothing being read');
      if (!stale) {
        for (const width of [1440, 390, 320]) {
          await page.setViewportSize({ width, height: 960 });
          const overflow = await dialog.evaluate((node) => [node, node.querySelector('.dm-flow-dialog-body')].some((el) => el.scrollWidth > el.clientWidth + 1));
          assert.equal(overflow, false, `Auto-exit at ${width} has no horizontal overflow`);
          await dialog.screenshot({ path: join(shots(), `autoexit-v2-base-${width}-local-fixture.png`), animations: 'disabled' });
        }
      }
      assert.equal(await text(dialog.locator('[data-v2-locked]')), LOCKED_BASE);
      assert.equal(await dialog.locator('[data-mandate-send]').count(), 0);
      assert.equal(chain.sends.length, 0);
      assert.equal(s.planned.length, 0);
      const walletCalls = chain.log.map((item) => typeof item === 'string' ? item : item.method);
      assert.ok(!walletCalls.includes('wallet_switchEthereumChain'), 'a preview Auto-exit never switches the wallet');
      assert.ok(!walletCalls.includes('eth_signTypedData_v4'), 'no signature without a live gate');
    } finally { await s.close(); }
  }
});

// Added 2026-10-06 (rugged97's delta of 5 Oct, item 4: read-v6 1.1.0-rc.1's qualified USD): with its tokens priced, the
// page shows what the position holds and its fees in dollars, as V1's page does, the token amounts under each figure;
// still no APR. Base's ETH at the fixtures' Chainlink round, its USDC at 1.
test('(b3) live on Base with qualified prices: fixed USD figures, token amounts under each, still no APR', async () => {
  const pools = JSON.parse(readFileSync(new URL('../../../api-contracts/read-v6/fixtures/valid/chain-pools.json', import.meta.url), 'utf8'));
  const priced = (token, symbol) => ({ ...token, price: pools.tokens.find((one) => one.symbol === symbol).price, priceReason: null });
  const portfolio = portfolioOf({ wallet: OWNER, tokens: [priced(TOKENS[0], 'ETH'), priced(TOKENS[1], 'USDC')], positions: [live(5_100_001, { approved: ZAP_V4 })] });
  const s = await openPositionPage(browser, chainOf(), { hash: '#/positions/base-v4-5100001', read6: { ...READ6, portfolio } });
  try {
    const detail = s.page.locator('[data-position-detail][data-position-v2="base-v4"][data-position-id="5100001"]');
    await detail.waitFor({ timeout: 30_000 });
    const holds = detail.locator('[data-cell="principal"]');
    await holds.locator('[data-usd="principal"]').waitFor({ timeout: 30_000 });
    assert.match((await holds.locator('[data-usd="principal"]').textContent()).trim(), /^\$[\d,]+(\.\d{2})?$/, 'what it holds, in dollars; read the exact value across its animated digit spans');
    // Changed on purpose 2026-11-06 (O-07): as on Robinhood Chain, the token amounts under a closed "Token amounts" in each
    // tile, the value's with its split bar; Details holds no copy of them.
    const amounts = holds.locator('details.dm-position-figure-detail');
    assert.equal(await text(amounts.locator('summary')), 'Token amounts');
    assert.equal(await amounts.getAttribute('open'), null, 'closed until asked for');
    assert.match(await holds.locator('[data-stat="principal"]').textContent(), /ETH.*USDC/);
    assert.equal(await holds.locator('.dm-pos-split').count(), 1, 'both tokens held: the split bar');
    assert.equal(await detail.locator('[data-position-details] [data-stat="principal"]').count(), 0);
    // 0.001 ETH at $4,000.12 and 2.5 USDC at $1: $6.50.
    assert.equal(await text(detail.locator('[data-cell="fees"] [data-usd="fees"]')), '$6.50');
    assert.equal(await text(detail.locator('[data-cell="fees"] details.dm-position-figure-detail summary')), 'Token amounts');
    assert.match(await detail.locator('[data-cell="fees"] [data-stat="fees"]').textContent(), /0\.001\s+ETH.*2\.5\s+USDC/);
    assert.equal(await detail.locator('[data-cell="apr"] [data-figure="none"]').count(), 1, 'still no APR');
    for (const width of [1280, 390, 320]) {
      await s.page.setViewportSize({ width, height: 960 });
      await s.page.screenshot({ path: join(shots(), `position-base-qualified-page-${width}.png`), fullPage: true, animations: 'disabled' });
      assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `qualified figures fit ${width}px`);
      assert.equal(await holds.locator('.dm-tick-d').evaluateAll((digits) => new Set(digits.map((digit) => Math.round(digit.getBoundingClientRect().top))).size), 1, `the qualified dollar value stays on one line at ${width}px`);
      await detail.screenshot({ path: join(shots(), `position-base-qualified-${width}.png`), animations: 'disabled' });
    }
  } finally { await s.close(); }
});

// Added 2026-11-04 (the owner: every chain the same as Robinhood Chain; docs/v2/V2_FEES.md): read-v6's stored fee history draws
// Robinhood Chain's own card and tile. Without the route, test (b) above: today's page.
test('(b4) live on Base with read-v6\'s stored fee history: Fees earned and Your APR as on Robinhood Chain, in USD', async () => {
  const read = (path) => JSON.parse(readFileSync(new URL(`../../../api-contracts/read-v6/fixtures/${path}`, import.meta.url), 'utf8'));
  const pools = read('valid/chain-pools.json');
  const priced = (token, symbol) => ({ ...token, price: pools.tokens.find((one) => one.symbol === symbol).price, priceReason: null });
  const portfolio = portfolioOf({ wallet: OWNER, tokens: [priced(TOKENS[0], 'ETH'), priced(TOKENS[1], 'USDC')], positions: [live(5_100_001, { approved: ZAP_V4 })] });
  const stored = read(`${readV6.NEXT_VERSION}/valid/position-fees.json`);
  // The fixture's pool price is a raw 2,500; here the page's own pool, at the page's own price.
  const body = { ...stored, positions: [{ ...stored.positions[0], tokenId: '5100001', now: { ...stored.positions[0].now, pool: POOL, sqrtPriceX96: SQRT.toString(), tick: TICK, ...RANGE, inRange: true } }] };
  assert.equal(readV6.validateExchange('position-fees', { chainId: 8453, positions: [{ dex: 4, tokenId: '5100001' }] }, body), true);
  const s = await openPositionPage(browser, chainOf(), { hash: '#/positions/base-v4-5100001', read6: { ...READ6, portfolio, 'position-fees': { status: 200, body } } });
  try {
    const detail = s.page.locator('[data-position-detail][data-position-v2="base-v4"][data-position-id="5100001"]');
    await detail.waitFor({ timeout: 30_000 });
    const card = detail.locator('[data-fees-card][data-fees-state="verified"]');
    await card.waitFor({ timeout: 30_000 });
    assert.equal(await detail.locator('[data-recorded-fees]').count(), 0, 'Robinhood Chain\'s card in place of the session\'s readings');
    assert.equal(await text(card.locator('h2')), 'Fees earned');
    // 0.001193 ETH and 2.841 USDC, at this pool's price and USDC's $1.
    assert.match(await text(card.locator('.dm-fees-hero')), /^\$5\.\d\d/, 'in dollars, at read-v6\'s qualified price');
    assert.equal(await card.locator('.dm-fees-plot').count(), 1, 'its chart is drawn');
    const apr = detail.locator('[data-cell="apr"]');
    assert.equal(await apr.getAttribute('data-apr'), 'ready');
    assert.match(await text(apr), /Your APR.*%/);
    for (const width of [1280, 390, 320]) {
      await s.page.setViewportSize({ width, height: 960 });
      await s.page.screenshot({ path: join(shots(), `position-base-fees-${width}.png`), fullPage: true, animations: 'disabled' });
      assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `the card fits ${width}px`);
    }
    // The Positions list's cell, from the same read: as on Robinhood Chain's rows.
    await s.page.setViewportSize({ width: 1280, height: 960 });
    await s.page.evaluate(() => { location.hash = '#/positions'; });
    const cell = s.page.locator('[data-cell="apr"][data-apr="ready"]').first();
    await cell.waitFor({ timeout: 30_000 });
    assert.match(await text(cell), /Your APR.*%/);
    await s.page.screenshot({ path: join(shots(), 'positions-base-apr-1280.png'), animations: 'disabled' });
  } finally { await s.close(); }
});

// Added 2026-11-06 (O-06, O-11, O-12; the owner: every chain the same as Robinhood Chain): a position a Domino-compound vault
// holds, with read-v6's stored history: the automation's lines and chart marks in the Fees earned card, Activity's
// settlements (outside changes included) with the automatic one named, and the Details' Fees history line.
test('(b5) live on Base with a stored history under Domino-compound: the automation\'s lines, Activity\'s settlements, Fees history in Details', async () => {
  const read = (path) => JSON.parse(readFileSync(new URL(`../../../api-contracts/read-v6/fixtures/${path}`, import.meta.url), 'utf8'));
  const pools = read('valid/chain-pools.json');
  const priced = (token, symbol) => ({ ...token, price: pools.tokens.find((one) => one.symbol === symbol).price, priceReason: null });
  const portfolio = portfolioOf({
    wallet: OWNER, tokens: [priced(TOKENS[0], 'ETH'), priced(TOKENS[1], 'USDC')],
    positions: [live(5_100_001, { approved: VAULT, subscriber: VAULT, vault: { address: VAULT, role: 'root' } })],
    vaults: [vaultOf({ wallet: OWNER, chainId: 8453, address: VAULT, rootTokenId: 5_100_001, pool: POOL })],
  });
  const stored = read(`${readV6.NEXT_VERSION}/valid/position-fees.json`);
  const body = { ...stored, positions: [{ ...stored.positions[0], tokenId: '5100001', now: { ...stored.positions[0].now, pool: POOL, sqrtPriceX96: SQRT.toString(), tick: TICK, ...RANGE, inRange: true } }] };
  assert.equal(readV6.validateExchange('position-fees', { chainId: 8453, positions: [{ dex: 4, tokenId: '5100001' }] }, body), true);
  const auto = body.positions[0].events.find((event) => event.auto);
  const s = await openPositionPage(browser, chainOf(), { hash: '#/positions/base-v4-5100001', read6: { ...READ6, portfolio, activity: activityOf({ wallet: OWNER }), 'position-fees': { status: 200, body } }, prepare: basePools(POOL_LISTED, ETH_USDC) });
  try {
    const detail = s.page.locator('[data-position-detail][data-position-v2="base-v4"][data-position-id="5100001"]');
    await detail.waitFor({ timeout: 30_000 });
    const card = detail.locator('[data-fees-card][data-fees-state="verified"]');
    await card.waitFor({ timeout: 30_000 });
    // Under the card's closed Breakdown, as on Robinhood Chain's page.
    await card.locator('details.dm-position-fee-breakdown > summary').click();
    const impact = card.locator('[data-automation-impact="domino"]');
    await impact.waitFor({ timeout: 30_000 });
    assert.match(await text(impact.locator('[data-impact="added"]')), /^Domino-compound added \$[\d.,]+ back · 1 time$/, 'Robinhood Chain\'s line, from the stored automatic compound');
    assert.equal(await impact.locator('[data-impact="growth"]').count(), 1, 'and how much the position grew from fees');
    // Activity: every stored settlement, the automatic one named, beside Domino's receipts.
    const activity = detail.locator('[data-position-activity]');
    await activity.locator(`[data-position-ledger-transaction="${auto.tx}"]`).waitFor({ timeout: 30_000 });
    assert.match(await text(activity.locator(`[data-position-ledger-transaction="${auto.tx}"]`)), /by Domino-compound/);
    assert.ok(await activity.locator('[data-position-ledger-transaction]').count() >= 2, 'the collect made outside Domino is listed too');
    await detail.locator('[data-position-details] summary').click();
    const facts = await text(detail.locator('[data-position-details] .dm-pos-facts'));
    assert.match(facts, /Fees history Every settlement of this position from its own events, through block \d+, and the fees ready to collect at block \d+\. Measured at each compound or collect and once an hour; the line between points is a guide, not a measurement\./);
    assert.equal(await text(detail.locator('[data-position-custody]')), 'Your automation reinvests this position’s fees. If you change it, move it or approve another app, it stops for this position until you turn it back on.', 'a vault holds it: its Held line, as on Robinhood Chain');
    // Robinhood Chain's links at the foot of Details, inside the card once it has opened (its 0.45 s block-size transition).
    await detail.locator('[data-position-new-in-pool]').waitFor({ timeout: 30_000 });
    await s.page.waitForTimeout(700);
    const link = await detail.locator('[data-position-new-in-pool]').boundingBox();
    const box = await detail.locator('[data-position-details]').boundingBox();
    assert.ok(link && box && link.y + link.height <= box.y + box.height, 'New position in this pool is inside the Details card');
    await s.page.screenshot({ path: join(shots(), 'position-base-automation-1280.png'), fullPage: true, animations: 'disabled' });
  } finally { await s.close(); }
});

// Added 2026-11-06 (review F1, UI-2): a Base v3 WETH/AERO position. WETH sorts first, but Base's pools read for WETH lists
// WETH against USDC only, so a link naming WETH opened "We couldn't find this pool". Details' links name AERO, whose read
// lists the pool, and appear only once that read does; a read that does not list it (no active liquidity there) leaves
// both out, as Robinhood Chain shows none for a pool it cannot open.
test('(b11) a Base WETH/AERO v3 position: Pool and New position name AERO once its pools read lists the pool; neither when it does not', async () => {
  const { v3PoolAddress } = require('../../.test-build/app/src/finance/v2/direct.js');
  const chains = require('../../.test-build/app/src/v2/chains.js');
  const WETH = '0x4200000000000000000000000000000000000006';
  const AERO = '0x940181a94a35a4569e4529a3cdfb74e38fd98631';
  const manager = '0x03a520b32c04bf3beef7beb72e919cf822ed34f1';
  const pool = { dex: 3, currency0: WETH, currency1: AERO, fee: 3000, tickSpacing: 60, hooks: ZERO };
  const address = v3PoolAddress(chains.v2Chain(8453), WETH, AERO, 3000).toLowerCase();
  const word = `0x${address.slice(2).padStart(64, '0')}`;
  const tokens = [{ address: WETH, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 }, { address: AERO, symbol: 'AERO', name: 'Aerodrome', decimals: 18 }];
  const position = livePosition({ chainId: 8453, dex: 3, manager, tokenId: '6238158', owner: OWNER, pool,
    tickLower: -60, tickUpper: 60, liquidity: '1000000000', sqrtPriceX96: String(2n ** 96n), tick: 0,
    principal: ['2000000', '3000000'], feesOwed: ['250000', '500000'] });
  const portfolio = portfolioOf({ wallet: OWNER, tokens: [indexedToken(8453, WETH, 'WETH', 18), indexedToken(8453, AERO, 'AERO', 18)], positions: [position] });
  const chainFor = () => createV2Chain({ chainId: 8453, timestamp: now(), positions: [{ dex: 3, tokenId: 6_238_158n, pool,
    tickLower: -60, tickUpper: 60, liquidity: 1_000_000_000n, principal: [2_000_000n, 3_000_000n], fees: [250_000n, 500_000n] }],
    pools: [{ pool, sqrtPriceX96: 2n ** 96n, tick: 0, liquidity: 1_000_000_000n }] });
  for (const listed of [true, false]) {
    const asked = [];
    const pools = listed ? [{ pool, address, sqrtPriceX96: 2n ** 96n, tick: 0, liquidity: 10n ** 18n }] : [];
    const s = await openPositionPage(browser, chainFor(), { hash: '#/positions/base-v3-6238158', read6: { portfolio, activity: activityOf({ wallet: OWNER }) }, prepare: basePools(pools, tokens, asked) });
    try {
      const detail = s.page.locator('[data-position-detail][data-position-id="6238158"]');
      await detail.waitFor({ timeout: 30_000 });
      await detail.locator('[data-position-details] summary').click();
      for (let wait = 0; wait < 60 && !asked.some((request) => request.token === AERO); wait++) await s.page.waitForTimeout(250);
      assert.ok(asked.some((request) => request.chainId === 8453 && request.token === AERO), 'AERO\'s pools read is asked');
      if (listed) {
        const link = detail.locator('[data-position-pool-link]');
        await link.waitFor({ timeout: 30_000 });
        assert.equal(await link.getAttribute('href'), `/pool/network/8453/${word}/${AERO}`, 'the pool page by AERO, whose read lists the pool');
        assert.equal(await detail.locator('[data-position-new-in-pool]').getAttribute('href'), `/new/network/8453/${AERO}/${word}`);
      } else {
        await s.page.waitForTimeout(1500);
        assert.equal(await detail.locator('[data-position-pool-link], [data-position-new-in-pool]').count(), 0, 'no way to a pool the read does not list');
      }
    } finally { await s.close(); }
  }
});

// Added 2026-11-06 (O-14): an NFT the stored history says is burned, not in the wallet's list: Robinhood Chain's own page.
test('(b6) an NFT read-v6\'s stored history says is burned: "This position NFT no longer exists", as on Robinhood Chain', async () => {
  const burned = JSON.parse(readFileSync(new URL(`../../../api-contracts/read-v6/fixtures/${readV6.NEXT_VERSION}/valid/position-fees-burned.json`, import.meta.url), 'utf8'));
  const body = { ...burned, positions: [{ ...burned.positions[0], tokenId: '5100009' }] };
  assert.equal(readV6.validateExchange('position-fees', { chainId: 8453, positions: [{ dex: 4, tokenId: '5100009' }] }, body), true);
  const s = await openPositionPage(browser, chainOf(), { hash: '#/positions/base-v4-5100009', read6: { ...READ6, 'position-fees': { status: 200, body } } });
  try {
    const gone = s.page.locator('[data-empty="position-gone"][data-position-reason="burned"]');
    await gone.waitFor({ timeout: 30_000 });
    assert.equal(await text(gone.locator('h2, h1, [data-empty-title], .dm-empty-title').first()), 'This position NFT no longer exists');
    assert.match(await text(gone), new RegExp(`NFT #5100009 was not found at block ${burned.positions[0].through.number}\\.`));
    assert.equal(await gone.locator('a[href="/positions"]').count(), 1, 'the way back to Positions');
    assert.doesNotMatch(await text(s.page.locator('main')), /isn’t in your wallet’s list/);
  } finally { await s.close(); }
  // Without the route (today), the same link says what it says today.
  const today = await openPositionPage(browser, chainOf(), { hash: '#/positions/base-v4-5100009', read6: READ6 });
  try {
    await today.page.locator('[data-empty="position-v2"][data-position-reason="position_not_listed"]').waitFor({ timeout: 30_000 });
    assert.equal(await today.page.locator('[data-empty="position-gone"]').count(), 0);
  } finally { await today.close(); }
});

// Added 2026-11-06 (O-09): Robinhood Chain's own rule (components/positions/PositionActions.tsx): nothing to collect, the
// button is off, with why; an empty collect would only cost gas.
test('(b7) Collect fees with nothing to collect is off, with its reason, as on Robinhood Chain', async () => {
  const read6 = { ...READ6, portfolio: portfolioOf({ wallet: OWNER, tokens: TOKENS, positions: [live(5_100_005, { feesOwed: ['0', '0'] })] }) };
  const s = await openPositionPage(browser, chainOf(), { hash: '#/positions/base-v4-5100005', read6 });
  try {
    const detail = s.page.locator('[data-position-detail][data-position-id="5100005"]');
    await detail.waitFor({ timeout: 30_000 });
    const collect = detail.locator('[data-position-v2-action="collect"]');
    assert.equal(await collect.isDisabled(), true);
    assert.equal(await collect.getAttribute('title'), 'No fees to collect yet.');
    assert.equal(await collect.getAttribute('data-position-collect-off'), 'no_fees');
    assert.equal(await detail.locator('[data-position-action="close"]').isDisabled(), false, 'Close position stays on');
    const { entries } = await openMenu(detail);
    assert.deepEqual(entries.map(([key, , disabled]) => [key, disabled]), [['increase', false], ['changeRange', false], ['exit', false]], 'the menu is unchanged');
  } finally { await s.close(); }
  // (Review) Closed, with nothing to collect: Robinhood Chain's own reason, never "yet".
  const closed = { ...READ6, portfolio: portfolioOf({ wallet: OWNER, tokens: TOKENS, positions: [live(5_100_005, { liquidity: 0n, principal: ['0', '0'], feesOwed: ['0', '0'] })] }) };
  const c = await openPositionPage(browser, chainOf(), { hash: '#/positions/base-v4-5100005', read6: closed });
  try {
    const collect = c.page.locator('[data-position-detail][data-position-id="5100005"] [data-position-v2-action="collect"]');
    await collect.waitFor({ timeout: 30_000 });
    assert.equal(await collect.isDisabled(), true);
    assert.equal(await collect.getAttribute('title'), 'This position is closed: it holds no liquidity.');
    assert.equal(await collect.getAttribute('data-position-collect-off'), 'closed');
  } finally { await c.close(); }
});

// Added 2026-11-06 (O-10): Collect fees says what it pays in USD beside "You receive", at read-v6's qualified prices, and no
// Domino fee line, as Robinhood Chain's own dialog.
test('(b8) Collect fees on Base: "You receive" in USD at qualified prices, and no Domino fee line', async () => {
  const pools = JSON.parse(readFileSync(new URL('../../../api-contracts/read-v6/fixtures/valid/chain-pools.json', import.meta.url), 'utf8'));
  const priced = (token, symbol) => ({ ...token, price: pools.tokens.find((one) => one.symbol === symbol).price, priceReason: null });
  const sqrt = position.sqrtPriceAtTick(-199500);
  const V4 = { tokenId: 5_100_001n, pool: { currency0: ZERO, currency1: USDC, fee: 500, tickSpacing: 10 }, ...RANGE, liquidity: LIQUIDITY,
    sqrtPriceX96: sqrt, tick: -199500, growthLast: [5n << 128n, 7n << 128n], growthNow: [(5n << 128n) + (10n ** 12n << 128n) / 10n ** 15n + 1n, (7n << 128n) + (3_000_000n << 128n) / 10n ** 15n + 1n] };
  const chain = createDirectChain({ chainId: 8453, v4: [V4], timestamp: now() });
  const read6 = { portfolio: portfolioOf({ wallet: OWNER, tokens: [priced(TOKENS[0], 'ETH'), priced(TOKENS[1], 'USDC')], positions: [live(5_100_001, { sqrtPriceX96: sqrt, tick: -199500 })] }) };
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100001', read6, s1: { directCode: { 8453: chain.codeHashes } } });
  try {
    const detail = s.page.locator('[data-position-detail][data-position-id="5100001"]');
    await detail.waitFor({ timeout: 30_000 });
    await detail.locator('[data-position-v2-action="collect"]').click();
    const dialog = s.page.locator('[role="dialog"][data-position-dialog="v2-collect"]');
    await dialog.locator('[data-position-direct="ready"]').waitFor({ timeout: 30_000 });
    const usd = dialog.locator('[data-position-receive-usd]');
    // 0.000001 ETH at $4,000.12 and 3 USDC at $1.
    assert.match(await text(usd), /^\$3\.\d\d$/);
    assert.equal(await usd.getAttribute('data-position-receive-usd'), 'qualified-prices');
    assert.equal(await usd.getAttribute('title'), null, 'qualified prices: no title');
    assert.match(await text(dialog.locator('[data-position-receive="collect"]')), /^You receive \$3\.\d\d .*ETH.*USDC Network fee Up to [\d.]+ ETH$/);
    assert.doesNotMatch(await text(dialog), /Domino fee/);
    assert.equal(chain.sends.length, 0, 'nothing sent by reading it');
  } finally { await s.close(); }
});

// Added 2026-11-06 (O-05; the owner: every chain the same as Robinhood Chain, whose page anyone reads): a position opened
// from another address's list (View address), with no wallet connected: its figures, charts and Activity, read from that
// address's portfolio as its list read it; no action, and Robinhood Chain's line saying whose they are.
test('(b9) a position opened from View address, with no wallet: the page as the owner sees it, with no action', async () => {
  const s = await openPositionPage(browser, chainOf(), { hash: `#/portfolio/${OWNER}`, read6: READ6, connect: false, intercept: (method) => (method === 'eth_accounts' ? { result: [] } : undefined) });
  try {
    const link = s.page.locator('a[href="/positions/base-v4-5100001"]').first();
    await link.waitFor({ timeout: 30_000 });
    await link.click();
    const detail = s.page.locator('[data-position-detail][data-position-v2="base-v4"][data-position-id="5100001"]');
    await detail.waitFor({ timeout: 30_000 });
    assert.equal(await detail.getAttribute('data-position-read'), 'viewed');
    assert.match(await detail.locator('[data-cell="principal"] [data-usd-amounts="principal"]').textContent(), /ETH.*USDC/);
    assert.equal(await detail.locator('[data-position-actions], [data-position-v2-action], [data-position-action="close"]').count(), 0, 'no action: they are the owner\'s');
    assert.match(await text(detail.locator('[data-position-owner-only="no-wallet"]')), /^Connect the owner wallet 0x7099…79c8\b.* to collect fees, add or close\.$/);
    await detail.locator('[data-position-activity-item]').first().waitFor({ timeout: 30_000 });
    assert.equal(await s.page.locator('[data-empty="position-v2"]').count(), 0, 'never "Connect wallet" in place of the page');
    assert.equal(await text(s.page.locator('a.dm-pos-back')), 'Positions');
    assert.equal(await s.page.locator('a.dm-pos-back').getAttribute('href'), `/portfolio/${OWNER}`, 'back to the list it was opened from');
  } finally { await s.close(); }
});

// Added 2026-11-06 (O-05, review): the same page with another wallet connected. Robinhood Chain's page draws nothing of the
// owner's automation for anyone else (components/positions/PositionActions.tsx, v2in/automate/PositionAutomation.tsx reads
// the connected wallet's own portfolio there): no Automation control, no Auto-exit card, no permission row, no action.
test('(b10) a position opened from View address, with another wallet connected: no action and none of the owner\'s automation', async () => {
  const OTHER = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
  const answers = { owner: OWNER, portfolio: READ6.portfolio, activity: READ6.activity, otherPortfolio: portfolioOf({ wallet: OTHER, tokens: TOKENS }), otherActivity: activityOf({ wallet: OTHER }) };
  const prepare = (context) => context.addInitScript((given) => {
    const read6 = window.__dominoV2Test.read6;
    const own = (request) => String(request.wallet).toLowerCase() === given.owner;
    read6.portfolio = (request) => (own(request) ? given.portfolio : given.otherPortfolio);
    read6.activity = (request) => (own(request) ? given.activity : given.otherActivity);
  }, answers);
  const intercept = (method) => (method === 'eth_accounts' || method === 'eth_requestAccounts' ? { result: [OTHER] } : undefined);
  const s = await openPositionPage(browser, chainOf(), { hash: `#/portfolio/${OWNER}`, read6: READ6, prepare, intercept });
  try {
    const link = s.page.locator('a[href="/positions/base-v4-5100002"]').first();
    await link.waitFor({ timeout: 30_000 });
    await link.click();
    const detail = s.page.locator('[data-position-detail][data-position-v2="base-v4"][data-position-id="5100002"]');
    await detail.waitFor({ timeout: 30_000 });
    assert.equal(await detail.getAttribute('data-position-read'), 'viewed');
    await s.page.locator('[data-position-owner-only="other-wallet"]').waitFor({ timeout: 30_000 });
    assert.match(await text(detail.locator('[data-position-owner-only]')), /^Only the owner wallet 0x7099…79c8\b.* can collect fees, add or close\.$/);
    await detail.locator('[data-position-activity]').waitFor({ timeout: 30_000 });
    assert.equal(await detail.locator('[data-position-actions], [data-position-v2-action], [data-position-action="close"]').count(), 0, 'no action: they are the owner\'s');
    assert.equal(await detail.locator('[data-v2in-position], [data-automation-control], [data-automation-exit-entry], [data-v2in-exit]').count(), 0, 'none of the owner\'s automation for this wallet');
    await detail.locator('[data-position-details] summary').click();
    assert.equal(await detail.locator('[data-position-zap-approval]').count(), 0, 'no permission read for a position this wallet does not hold');
    // Its Held line speaks to the owner ("Your automation reinvests…"), and Robinhood Chain's Details have none: not here.
    assert.equal(await detail.locator('[data-position-custody]').count(), 0, 'no "Your automation" line on another address\'s position');
    assert.match(await text(detail.locator('[data-position-details] .dm-pos-facts')), /Pool id 0x/);
  } finally { await s.close(); }
});

for (const variant of [
  { name: 'one qualified anchor values a fresh pool without extra transactions', anchor: true, stale: false, usd: true },
  { name: 'no qualified anchor keeps principal and fees in tokens, with a reason', anchor: false, stale: false, usd: false },
  { name: 'a stale pool snapshot never supplies a USD estimate', anchor: true, stale: true, usd: false },
]) test(`pool-price USD: ${variant.name}`, async () => {
  const manager = '0x03a520b32c04bf3beef7beb72e919cf822ed34f1';
  const testToken = '0xb200000000000000000000000000000000000001';
  const pool = { dex: 3, currency0: USDC, currency1: testToken, fee: 3000, tickSpacing: 60, hooks: ZERO };
  const anchor = { ...indexedToken(8453, USDC, 'USDC', 6), ...(variant.anchor ? {
    price: { source: 'chain_stable', usd: '1.000000000000000000', snapshot: null, pool: null, ethUsd: null, depthUsd: null }, priceReason: null,
  } : { priceReason: 'pool_depth_below_floor' }) };
  const unpriced = { ...indexedToken(8453, testToken, 'TEST', 6), priceReason: 'pool_depth_below_floor' };
  // The raw ratio and both decimals are equal, so 1 TEST is exactly 1 USDC. Expected USD is ordinary arithmetic:
  // 2 + 3 = $5 principal; 0.25 + 0.5 = $0.75 fees. This never calls the product's valuation helper.
  const position = livePosition({ chainId: 8453, dex: 3, manager, tokenId: '6238157', owner: OWNER, pool,
    tickLower: -60, tickUpper: 60, liquidity: '1000000000', sqrtPriceX96: String(2n ** 96n), tick: 0,
    principal: ['2000000', '3000000'], feesOwed: ['250000', '500000'], stale: variant.stale });
  if (variant.stale) {
    position.state.snapshot.timestamp = now() - 600;
    position.state.freshness.ageSeconds = 600;
  }
  const portfolio = portfolioOf({ wallet: OWNER, tokens: [anchor, unpriced], positions: [position] });
  const chain = createV2Chain({ chainId: 8453, timestamp: now(), positions: [{ dex: 3, tokenId: 6_238_157n, pool,
    tickLower: -60, tickUpper: 60, liquidity: 1_000_000_000n, principal: [2_000_000n, 3_000_000n], fees: [250_000n, 500_000n] }],
    pools: [{ pool, sqrtPriceX96: 2n ** 96n, tick: 0, liquidity: 1_000_000_000n }] });
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v3-6238157', read6: { portfolio, activity: activityOf({ wallet: OWNER }) } });
  try {
    const detail = s.page.locator('[data-position-detail][data-position-id="6238157"]');
    try { await detail.waitFor(); }
    catch (cause) {
      const diagnostic = await s.page.evaluate(() => ({
        url: location.href, visibility: document.visibilityState,
        session: window.__dominoSessionProbe?.view().status,
        empty: [...document.querySelectorAll('[data-position-reason]')].map(node => ({ reason: node.getAttribute('data-position-reason'), text: node.textContent })),
        loading: document.querySelector('[data-position-loading]')?.textContent ?? null,
        portfolio: window.__dominoV2Test?.read6?.portfolio,
        body: document.body.innerText.slice(0, 3000),
      }));
      await s.page.screenshot({ path: join(shots(), `position-pool-price-${variant.stale ? 'stale' : variant.anchor ? 'anchor' : 'unqualified'}-failure.png`), fullPage: true, animations: 'disabled' });
      throw new Error(`Position fixture did not render: ${JSON.stringify(diagnostic)}`, { cause });
    }
    if (variant.usd) {
      await detail.locator('[data-usd="principal"][data-usd-basis="pool-price"]').waitFor();
      assert.deepEqual(await detail.locator('[data-usd]').allTextContents(), ['$5.00', '$0.75']);
      for (const name of ['principal', 'fees']) {
        const figure = detail.locator(`[data-usd="${name}"]`);
        assert.equal(await figure.getAttribute('data-usd-basis'), 'pool-price');
        assert.match(await figure.getAttribute('title'), /pool price.*USDC.*qualified USD price/i, 'the estimate names both the pool mark and its qualified anchor');
      }
      assert.equal(await detail.locator('[data-cell="apr"] [data-figure="none"]').count(), 1, 'spot valuation does not create APR');
      for (const width of [1280, 390, 320]) {
        await s.page.setViewportSize({ width, height: 960 });
        assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `pool-price USD fits ${width}px`);
        await s.page.screenshot({ path: join(shots(), `position-pool-price-base-${width}.png`), fullPage: true, animations: 'disabled' });
      }
    } else {
      // Rewritten on purpose 2026-10-14 (the incident of 2026-10-13, package V1; the owner: "USD unavailable" must not
      // appear on a position). Both tiles said those words, the amounts closed inside Details. Still no estimate without
      // a basis, and none from a stale reading with nothing kept; the two token amounts are the tiles' figures now, in
      // view, with one short reason.
      await detail.locator('[data-usd-amounts="principal"]').waitFor();
      assert.match(await detail.locator('[data-usd-amounts="principal"]').innerText(), /2\s+USDC\s+3\s+TEST/, 'what it holds, in tokens, in view');
      assert.match(await detail.locator('[data-usd-amounts="fees"]').innerText(), /0\.25\s+USDC\s+0\.5\s+TEST/);
      // Changed on purpose 2026-10-15 (pack 7, owner: no status notices): no short reason under the amounts ("Waiting for a fresh reading", "No reliable USD price"); the tiles keep it as data.
      assert.equal(await detail.locator('[data-usd-why]').count(), 0, 'no reason in view');
      assert.match(await detail.locator('[data-cell="principal"]').getAttribute('data-usd-reason'), variant.stale ? /stale_position_or_chain/ : /pool_depth_below_floor/);
      assert.doesNotMatch(await detail.locator('[data-position-stats]').innerText(), /USD unavailable/i, 'the bare words are gone');
      assert.equal(await detail.locator('[data-usd], [data-usd-snapshot]').count(), 0, 'there is no unqualified estimate or remembered USD value');
      assert.equal(await detail.locator('[data-position-loading], [data-position-overview] [aria-busy="true"]').count(), 0, 'settled unavailable data is not an infinite loader');
      for (const width of [1280, 390, 320]) {
        await s.page.setViewportSize({ width, height: 960 });
        assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `token amounts fit ${width}px`);
      }
    }
    const details = detail.locator('[data-position-details]');
    await details.locator('summary').click();
    // Changed on purpose 2026-11-06 (O-07): the token amounts are the tiles' own (under Token amounts beside a dollar
    // figure), as on Robinhood Chain, and Details holds no copy of them.
    assert.match(await detail.locator('[data-cell="principal"]').locator('[data-stat="principal"], [data-usd-amounts="principal"]').first().textContent(), /2\s+USDC.*3\s+TEST/);
    assert.match(await detail.locator('[data-cell="fees"]').locator('[data-stat="fees"], [data-usd-amounts="fees"]').first().textContent(), /0\.25\s+USDC.*0\.5\s+TEST/);
    assert.equal(await details.locator('[data-stat="principal"], [data-stat="fees"]').count(), 0);
    if (variant.usd) assert.match(await details.innerText(), /pool price/i);
    assert.equal(chain.sends.length, 0, 'reading a pool mark never sends a transaction');
    assert.equal(s.planned.length, 0, 'reading a pool mark never asks for a transaction plan');
  } finally { await s.close(); }
});

// Rewritten on purpose 2026-10-14 (package V1): the two tiles said "USD unavailable"; they show the position's token
// amounts now, with one short reason, and the full sentence in their title and in Details.
test('a completed unqualified USD read shows the token amounts and explains the missing price without a permanent loading skeleton', async () => {
  const pools = JSON.parse(readFileSync(new URL('../../../api-contracts/read-v6/fixtures/valid/chain-pools.json', import.meta.url), 'utf8'));
  const tokens = TOKENS.map(token => ({ ...token, price: null, priceReason: 'pool_depth_below_floor' }));
  const portfolio = portfolioOf({ wallet: OWNER, tokens, positions: [live(5_100_001)] });
  const chain = chainOf();
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100001', read6: { ...READ6, portfolio } });
  try {
    const detail = s.page.locator('[data-position-detail]');
    const figures = detail.locator('[data-usd-amounts]');
    await figures.first().waitFor();
    assert.equal(await figures.count(), 2);
    assert.match(await detail.locator('[data-usd-amounts="principal"]').innerText(), /ETH[\s\S]*USDC/);
    assert.match(await detail.locator('[data-usd-amounts="fees"]').innerText(), /0\.001\s+ETH\s+2\.5\s+USDC/);
    // Changed on purpose 2026-10-15 (pack 7, owner: no status notices): no short reason under the amounts, and none in their title or in Details.
    assert.equal(await detail.locator('[data-usd-why]').count(), 0);
    assert.doesNotMatch(await detail.locator('[data-position-stats]').innerText(), /USD unavailable|No reliable USD price/i);
    for (const figure of await figures.all()) {
      assert.equal(await figure.getAttribute('title'), null);
      assert.equal(await figure.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)', 'a completed read is not styled as a loading skeleton');
    }
    assert.equal(await detail.locator('[data-position-loading], [data-position-overview] [aria-busy="true"]').count(), 0);
    const details = detail.locator('[data-position-details]');
    await details.locator('summary').click();
    assert.doesNotMatch(await details.innerText(), /price source has not verified enough liquidity for a USD estimate/);
    // Changed on purpose 2026-11-06 (O-07): no copy of the tiles' token amounts in Details, as on Robinhood Chain.
    assert.equal(await details.locator('[data-stat="principal"], [data-stat="fees"]').count(), 0);
    for (const width of [1280, 390, 320]) {
      await s.page.setViewportSize({ width, height: 960 });
      assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `token amounts fit ${width}px`);
      assert.equal(await figures.evaluateAll(nodes => nodes.every(node => node.scrollWidth <= node.clientWidth + 1)), true, `the amounts fit their tiles at ${width}px`);
      await s.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await s.page.screenshot({ path: join(shots(), `position-usd-unavailable-${width}.png`), fullPage: true, animations: 'disabled' });
    }
    const recovered = structuredClone(portfolio);
    recovered.body.tokens = TOKENS.map(token => ({ ...token, price: pools.tokens.find(one => one.symbol === token.symbol).price, priceReason: null }));
    await s.page.evaluate(answer => {
      window.__dominoV2Test.read6.portfolio = () => answer;
      window.dispatchEvent(new Event('online'));
    }, recovered);
    await detail.locator('[data-cell="principal"] [data-usd="principal"]').waitFor();
    assert.equal(await figures.count(), 0, 'a later qualified response replaces the unavailable state');
    assert.equal(await text(detail.locator('[data-cell="fees"] [data-usd="fees"]')), '$6.50');
    assert.equal(chain.sends.length, 0, 'reading a missing price never sends a transaction');
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------
// Added 2026-10-06 (the integration review's second pass, rugged-literal #1): the root of Auto-exit's own automation with
// its Auto-exit on. Its exit needs the position's approval alone: an action that keeps it (Collect fees, Withdraw to both
// tokens) pauses nothing, and one that moves it to the zap (Add liquidity on v4) pauses Auto-exit, said in its own words.
// ---------------------------------------------------------------------------

/** read-v6 with `vault` made Auto-exit's own (paused, its module on) and an Auto-exit on its root `tokenId`, nothing blocking it. */
function withAutoExit(answer, { vault, tokenId }) {
  const body = structuredClone(answer.body);
  const listed = body.vaults.find((one) => one.address === vault);
  Object.assign(listed, { pausedBy: 'owner', autoExitEnabled: true });
  Object.assign(listed.state, { paused: true, exitModule: FAKE.autoExit.toLowerCase() });
  const [order] = JSON.parse(readFileSync(new URL('../../../api-contracts/read-v6/fixtures/valid/portfolio.json', import.meta.url), 'utf8')).mandates;
  const terms = { triggerBelowSqrtPriceX96: String(position.sqrtPriceAtTick(RANGE.tickLower)), triggerAboveSqrtPriceX96: String(position.sqrtPriceAtTick(RANGE.tickUpper)), receive: 'both', convertTo: null, maxSlippageBps: 100 };
  body.mandates = [{ ...order, chainId: 8453, vault, tokenId: String(tokenId), owner: OWNER, module: FAKE.autoExit.toLowerCase(), status: 'active', expired: false, blockedBy: [], validUntil: now() + 365 * 86_400, terms }];
  assert.ok(readV6.validateResponse('portfolio', body), 'the answer the suite built is the contract\'s');
  return { ...answer, body };
}

/** The runtime code tests/support/v2-chain.mjs gives the two vault factories, whose hashes are the contracts set's. */
const FACTORY_CODE = { [FAKE.vaultFactoryV3.toLowerCase()]: '0x600560d0d0', [FAKE.vaultFactoryV4.toLowerCase()]: '0x600660d0d0' };
const VAULT_ABI = require('../../../api-contracts/v2/abi/IDominoVault.json').abi;
const FACTORY_ABI = require('../../../api-contracts/v2/abi/IDominoVaultFactory.json').abi;

/** On the direct chain, at the wallet: `vault` is a Domino vault whose armed root is the v4 position `tokenId` (`asked`: its reads). */
const vaultOnChain = (vault, tokenId, asked = []) => (method, params) => {
  if (method === 'eth_getCode' && FACTORY_CODE[String(params[0]).toLowerCase()]) return { result: FACTORY_CODE[String(params[0]).toLowerCase()] };
  if (method !== 'eth_call') return undefined;
  const to = String(params[0].to).toLowerCase();
  const data = params[0].data ?? params[0].input;
  if (FACTORY_CODE[to]) return { result: encodeFunctionResult({ abi: FACTORY_ABI, functionName: 'isVault', result: String(decodeFunctionData({ abi: FACTORY_ABI, data }).args[0]).toLowerCase() === vault }) };
  if (to !== vault) return undefined;
  const { functionName } = decodeFunctionData({ abi: VAULT_ABI, data });
  asked.push(functionName);
  if (functionName === 'root') return { result: encodeFunctionResult({ abi: VAULT_ABI, functionName, result: { dex: 4, positionManager: V4_PM, tokenId } }) };
  if (functionName === 'rootArmed') return { result: encodeFunctionResult({ abi: VAULT_ABI, functionName, result: true }) };
  return undefined;
};

// Added 2026-11-09 (the core-flows fix; the owner: "if you have a position with Auto-compound or any active automation you
// must turn it off first, then you can close the position, and this must be totally easy for the user"): an automation's
// main position closes in one guided flow: one line says closing turns its automation off (the vault never refuses its
// owner's exit, so no step of its own and no tick box), its step list shows the close and, while the automation holds its
// fees, Withdraw to wallet after it; one press, one transaction to Uniswap. On this fake chain the automation cannot be
// read after the close, so its last step is left to the automation's card (the hand-over of before), and the dialog ends.
test('(f0c) Close position of an automation\'s main position: one line, no tick box, its steps listed, one transaction to Uniswap', async () => {
  const sqrt = position.sqrtPriceAtTick(-199500);
  const V4 = { tokenId: 5_100_002n, pool: { currency0: ZERO, currency1: USDC, fee: 500, tickSpacing: 10 }, ...RANGE, liquidity: BigInt(LIQUIDITY),
    sqrtPriceX96: sqrt, tick: -199500, growthLast: [5n << 128n, 7n << 128n], growthNow: [5n << 128n, 7n << 128n], approved: VAULT, subscriber: VAULT };
  const chain = createDirectChain({ chainId: 8453, v4: [V4], timestamp: now() });
  const read6 = { portfolio: portfolioOf({ wallet: OWNER, tokens: TOKENS,
    positions: [live(5_100_002, { sqrtPriceX96: sqrt, tick: -199500, approved: VAULT, subscriber: VAULT, vault: { address: VAULT, role: 'root' } })],
    vaults: [vaultOf({ wallet: OWNER, chainId: 8453, address: VAULT, rootTokenId: 5_100_002, pool: POOL, reserves: ['1000000000000000', '2500000'] })] }) };
  const asked = [];
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100002', read6, s1: { directCode: { 8453: chain.codeHashes } }, intercept: vaultOnChain(VAULT, 5_100_002n, asked) });
  try {
    const page = s.page;
    const detail = page.locator('[data-position-detail][data-position-id="5100002"]');
    await detail.waitFor({ timeout: 30_000 });
    await detail.locator('[data-position-actions] > [data-position-action="close"]').click();
    const dialog = page.locator('[role="dialog"][data-position-dialog="v2-close"]');
    await dialog.locator('[data-position-direct="ready"]').waitFor({ timeout: 30_000 });
    assert.match(await text(dialog.locator('[data-position-close-line="turns-off"]')), /^Closing also turns off (Auto-compound|Domino-compound) for this position\.$/);
    assert.deepEqual(await dialog.locator('[data-close-step]').evaluateAll((rows) => rows.map((row) => [row.getAttribute('data-close-step'), row.querySelector('.dm-flow-wstep-title').textContent])), [['close', 'Close position'], ['return-reserves', 'Withdraw to wallet']]);
    assert.equal(await dialog.locator('[data-position-pause-confirm], [data-position-root-note], [data-position-reserves-stay], [data-position-warning]').count(), 0, 'one line: no tick box, no second note');
    assert.ok(asked.includes('rootArmed'), 'the chain was asked whether its automation runs');
    const send = dialog.locator('[data-position-send="close"]');
    assert.equal(await text(send), 'Close in wallet');
    assert.equal(await send.isDisabled(), false, 'never held for a tick box');
    assert.doesNotMatch(await text(dialog), /vault|NFT|successor/i);
    await closeShot(page, 'root-close-review');
    await send.click();
    await dialog.locator('[data-position-direct="done"]').waitFor({ timeout: 30_000 });
    assert.equal(chain.sends.length, 1, 'one transaction, sent with no acknowledgement first');
    assert.equal(chain.sends[0].tx.to, V4_PM);
    assert.equal(chain.v4Position(5_100_002n).liquidity, 0n);
    await dialog.locator('[data-position-back]').waitFor({ timeout: 30_000 });
    await closeShot(page, 'root-close-done');
  } finally { await s.close(); }
});

test('(e2) Auto-exit on: Add liquidity on v4 moves the approval its exit needs, so its review asks for a tick in Auto-exit\'s words; never the automation\'s pause note', async () => {
  const chain = chainOf();
  const read6 = { ...READ6, portfolio: withAutoExit(READ6.portfolio, { vault: VAULT, tokenId: 5_100_002 }) };
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100002', read6, planner: plannerFor() });
  try {
    const page = s.page;
    const root = page.locator('[data-position-detail][data-position-id="5100002"]');
    await root.waitFor({ timeout: 30_000 });
    await root.locator('[data-automation-control]').click();
    await page.locator('[data-v2in-exit][data-exit-state="on"]').waitFor({ timeout: 30_000 });
    assert.equal(await page.getByRole('dialog').count(), 1, 'management uses the standard popup');
    await page.keyboard.press('Escape');
    await page.locator('[data-automation-management]').waitFor({ state: 'detached' });
    await pick(root, 'increase');
    const dialog = page.locator('[role="dialog"][data-position-dialog="v2-increase"]');
    await dialog.waitFor();
    assert.equal(await dialog.locator('[data-position-root-note]').count(), 0, 'not "This pauses automation…": only a moved approval pauses Auto-exit');
    await dialog.getByRole('combobox', { name: 'Pay with' }).click();
    await page.getByRole('option', { name: 'ETH', exact: true }).click();
    await dialog.locator(`[data-position-amount="${ZERO}"] input`).fill('0.05');
    await dialog.locator('[data-position-continue="increase"]').click();
    await dialog.locator('[data-position-review="increase"]').waitFor({ timeout: 30_000 });
    const tick = dialog.locator('[data-position-pause-confirm]');
    await tick.waitFor({ timeout: 30_000 });
    assert.equal(await text(dialog.locator('label.dm-pa-tick:has([data-position-pause-confirm])')), 'This pauses Auto-exit until you approve this position again.');
    assert.equal(await dialog.locator('[data-position-confirm]:not([disabled])').count(), 0, 'nothing prepared before the tick');
    await tick.check();
    await dialog.locator('[data-position-confirm="approve-nft"]:not([disabled])').waitFor({ timeout: 30_000 });
    await dialog.screenshot({ path: join(shots(), 'position-v2-autoexit-increase-tick.png') });
    await page.keyboard.press('Escape');
    assert.equal(chain.sends.length, 0, 'nothing sent here');
  } finally { await s.close(); }
});

test('(e3) Auto-exit on, its root disarmed by an earlier change: Add liquidity on v4 still moves its approval, so this dialog asks the tick itself, then offers "Approve again"', async () => {
  // An earlier Collect fees disarmed the root (rootArmed false): the zap client asks for no pause, Auto-exit still pauses.
  const chain = chainOf({ disarmed: [VAULT] });
  const read6 = { ...READ6, portfolio: withAutoExit(READ6.portfolio, { vault: VAULT, tokenId: 5_100_002 }) };
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100002', read6, planner: plannerFor() });
  try {
    const page = s.page;
    const root = page.locator('[data-position-detail][data-position-id="5100002"]');
    await root.waitFor({ timeout: 30_000 });
    await pick(root, 'increase');
    const dialog = page.locator('[role="dialog"][data-position-dialog="v2-increase"]');
    await dialog.waitFor();
    await dialog.getByRole('combobox', { name: 'Pay with' }).click();
    await page.getByRole('option', { name: 'ETH', exact: true }).click();
    await dialog.locator(`[data-position-amount="${ZERO}"] input`).fill('0.05');
    await dialog.locator('[data-position-continue="increase"]').click();
    await dialog.locator('[data-position-review="increase"]').waitFor({ timeout: 30_000 });
    const tick = dialog.locator('[data-position-pause-confirm]');
    await tick.waitFor({ timeout: 30_000 });
    assert.equal(await text(dialog.locator('label.dm-pa-tick:has([data-position-pause-confirm])')), 'This pauses Auto-exit until you approve this position again.');
    assert.equal(await text(dialog.locator('[data-position-tick-first]')), 'Tick the box above first.');
    // Its step is ready (the zap client holds nothing back here), and still not offered before the tick.
    await dialog.locator('[data-position-step="approve-nft"][data-status="ready"]').waitFor({ timeout: 30_000 });
    assert.equal(await dialog.locator('[data-position-confirm="approve-nft"]').isDisabled(), true, 'held until the tick');
    await tick.check();
    await dialog.locator('[data-position-confirm="approve-nft"]:not([disabled])').click({ timeout: 30_000 });
    await dialog.locator('[data-position-confirm="action"]:not([disabled])').click({ timeout: 30_000 });
    await dialog.locator('[data-position-receipt]').waitFor({ timeout: 30_000 });
    const rearm = dialog.locator('[data-position-rearm]');
    assert.equal(await text(rearm), 'Approve again', 'the approval back to Auto-exit, offered after');
    assert.equal(await rearm.getAttribute('data-position-rearm'), VAULT);
    assert.equal(chain.sends.length, 2, 'the zap\'s approval and the add');
    await dialog.locator('[data-position-back]').click();
    await dialog.waitFor({ state: 'detached' });
  } finally { await s.close(); }
});

test('(f2) Auto-exit on: Collect fees straight at Uniswap keeps the approval its exit needs: no pause note, no tick, nothing offered after', async () => {
  const sqrt = position.sqrtPriceAtTick(-199500);
  const V4 = { tokenId: 5_100_001n, pool: { currency0: ZERO, currency1: USDC, fee: 500, tickSpacing: 10 }, ...RANGE, liquidity: LIQUIDITY, approved: VAULT, subscriber: VAULT,
    sqrtPriceX96: sqrt, tick: -199500, growthLast: [5n << 128n, 7n << 128n], growthNow: [(5n << 128n) + (10n ** 12n << 128n) / 10n ** 15n + 1n, (7n << 128n) + (3_000_000n << 128n) / 10n ** 15n + 1n] };
  const chain = createDirectChain({ chainId: 8453, v4: [V4], timestamp: now() });
  const base = portfolioOf({
    wallet: OWNER, tokens: TOKENS,
    positions: [live(5_100_001, { sqrtPriceX96: sqrt, tick: -199500, approved: VAULT, subscriber: VAULT, vault: { address: VAULT, role: 'root' } })],
    vaults: [vaultOf({ wallet: OWNER, chainId: 8453, address: VAULT, rootTokenId: 5_100_001, pool: POOL })],
  });
  const read6 = { portfolio: withAutoExit(base, { vault: VAULT, tokenId: 5_100_001 }) };
  const asked = [];
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100001', read6, s1: { directCode: { 8453: chain.codeHashes } }, intercept: vaultOnChain(VAULT, 5_100_001n, asked) });
  try {
    const page = s.page;
    const detail = page.locator('[data-position-detail][data-position-id="5100001"]');
    await detail.waitFor({ timeout: 30_000 });
    await detail.locator('[data-position-v2-action="collect"]').click();
    const dialog = page.locator('[role="dialog"][data-position-dialog="v2-collect"]');
    await dialog.locator('[data-position-direct="ready"]').waitFor({ timeout: 30_000 });
    assert.deepEqual([...new Set(asked)], ['root', 'rootArmed'], 'read on chain as its automation\'s armed root, whose pause the compounding automations ask a tick for');
    assert.equal(await dialog.locator('[data-position-root-note], [data-position-pause-confirm], [data-position-warning="automation"]').count(), 0, 'nothing here pauses Auto-exit');
    assert.doesNotMatch(await text(dialog), /pauses/);
    await dialog.locator('[data-position-send="collect"]:not([disabled])').click();
    await dialog.locator('[data-position-direct="done"]').waitFor({ timeout: 30_000 });
    assert.equal(chain.sends.length, 1);
    assert.equal(chain.sends[0].tx.to, V4_PM);
    assert.equal(chain.v4Position(5_100_001n).approved, VAULT, 'the approval its exit needs, still its automation\'s');
    assert.equal(await dialog.locator('[data-position-rearm]').count(), 0, 'nothing to turn back on: Auto-exit stays on');
    await dialog.screenshot({ path: join(shots(), 'position-v2-autoexit-collect-done.png') });
  } finally { await s.close(); }
});
