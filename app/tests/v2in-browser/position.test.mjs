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
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { decodeFunctionData, parseAbi } from 'viem';
import * as runtime from '../../../api-contracts/position-plan-v1/runtime.mjs';
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
const LOCKED_BASE = 'This opens as soon as Domino\'s service is live on Base.';

/** The "···" menu of the position's row: opened, its entries as `[key, label, disabled]`; left open. */
async function openMenu(detail) {
  const menu = detail.locator('[role="group"][aria-label="Position actions"]');
  await menu.waitFor();
  return { menu, entries: await menu.locator('button[data-position-v2-action]').evaluateAll((all) => all.map((one) => [one.getAttribute('data-position-v2-action'), one.textContent, one.disabled])) };
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
const chainOf = (over = {}) => createV2Chain({ chainId: 8453, timestamp: now(), positions: CHAIN_POSITIONS, pools: [{ pool: POOL, sqrtPriceX96: SQRT, tick: TICK, liquidity: 10n ** 16n }], vaults: [VAULT], ...over });

/** position-plan-v1 as it would answer (tests/support/s1-plans.mjs): an add swaps half the ETH to USDC; a converted exit sells 80% of the ETH. */
function plannerFor({ answers = [] } = {}) {
  return (wire) => {
    const tokenId = BigInt(wire.position.tokenId);
    const held = CHAIN_POSITIONS.find((p) => p.tokenId === tokenId);
    const positionState = { tokenId, manager: V4_PM, ...RANGE, liquidity: LIQUIDITY, feesOwed: [0n, 0n], approved: held?.approved ?? ZERO, subscriber: ZERO };
    const base = { owner: OWNER, zap: ZAP_V4, now: now(), pool: { sqrtPriceX96: SQRT, tick: TICK }, positionPool: POOL, position: positionState };
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
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100001', read6: READ6 });
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
    assert.match(await text(detail.locator('[data-stat="principal"]')), /ETH.*USDC/);
    assert.match(await text(detail.locator('[data-stat="fees"]')), /0\.001\s+ETH.*2\.5\s+USDC/);
    assert.equal(await detail.locator('[data-cell="apr"] [data-figure="none"]').count(), 1, 'no APR without a qualified source: a dash');
    // Changed on purpose 2026-10-03: the price's two sides are the app's one way round (lib/read/orientation.ts), as its
    // figure and the Price range chart are; the tile wrote the pool's order beside it ("1 ETH = 0.000333 USDC").
    // Changed on purpose 2026-10-05 (New position on Base and Arbitrum One): Base's USDC is a quote there as USDG is on
    // Robinhood Chain, so ether is priced in dollars, as Domino V2's review writes it ("1 USDC = 0.00044 ETH" before).
    assert.match(await text(detail.locator('[data-stat="price"]')), /^1 ETH = \S+ USDC$/, 'the price now, in V1\'s own words');
    assert.doesNotMatch(await text(detail), /\$/, 'no USD anywhere');
    // V1's row (review #5): one primary Collect fees, then the "···" menu with the three other actions.
    await detail.locator('[data-position-v2-action="protect"]').waitFor();
    assert.deepEqual(await detail.locator('[data-position-actions] [data-position-v2-action]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-position-v2-action'))), ['collect', 'increase', 'changeRange', 'exit', 'protect']);
    assert.equal(await detail.locator('[data-position-actions] [data-position-v2-actions="live"] [data-position-v2-more]').count(), 1);
    const { menu, entries } = await openMenu(detail);
    assert.deepEqual(entries, [['increase', 'Add liquidity', false], ['changeRange', 'Change range', false], ['exit', 'Withdraw', false], ['protect', 'Stop-loss / take-profit', false]]);
    assert.equal(await menu.locator('[data-position-v2-blocked]').count(), 0, 'nothing blocked: no heading');
    await page.keyboard.press('Escape');
      // Details: the custody, the Uniswap version, and "Domino can manage this position for you when you ask." with Revoke (read through the wallet).
    await detail.locator('[data-position-details] summary').click();
    assert.equal(await text(detail.locator('[data-position-custody]')), 'Your position stays in your wallet.');
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
    assert.match(await text(detail.locator('[data-position-activity-item]')), /Added to a position .* Domino fee 0\.325 USDC 0\.65% of the amount swapped/);
  } finally { await s.close(); }
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
    // The pool and the route's pools: "Uniswap" and the tier, the version only as a title (review #12).
    assert.match(await text(review.locator('[data-position-review-pool]')), /^Pool ETH \/ USDC · Uniswap · 0\.05%$/);
    assert.match(await review.locator('[data-position-review-pool] [title]').getAttribute('title'), /^Uniswap v4 · 0x/);
    assert.match(await text(review.locator('[data-position-route-leg="0"]')), /0\.025 ETH → USDC Expected 57 USDC At least [\d.]+ USDC Uniswap · 0\.05%/);
    assert.doesNotMatch(await text(review.locator('.dm-receipt')), /v4|v3/, 'the version is never text in the review\'s list');
    // The Domino fee (review #16): its label alone, then the amount, then its base on the sub-line.
    assert.match(await text(review.locator('[data-position-fee="charged"]')), /^Domino fee [\d.]+ USDC 0\.65% of 57 USDC swapped As planned; the receipt shows the exact fee\.$/);
    assert.match(await text(review.locator('[data-position-fee-base]')), /^0\.65% of 57 USDC swapped$/);
    assert.match(await text(review.locator('[data-position-smaller]')), /^If the price moves within your slippage, your position can be up to [\d.]+% smaller\. The rest returns to your wallet\.$/);
    assert.ok(await review.locator('[data-position-l1-fee]').count() === 1);
    assert.match(await text(review.locator('[data-position-deadline]')), /\d+ (s|min), then a new quote/);
    assert.match(await text(review), /Paying with ETH needs a direct transaction\./);
    const steps = dialog.locator('[data-position-steps="direct"]');
    assert.deepEqual(await steps.locator('[data-position-step]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-position-step'))), ['approve-nft', 'action']);
    await dialog.locator('[data-position-confirm="approve-nft"]:not([disabled])').click({ timeout: 30_000 });
    await dialog.locator('[data-position-confirm="action"]:not([disabled])').click({ timeout: 30_000 });
    const receipt = dialog.locator('[data-position-receipt]');
    await receipt.waitFor({ timeout: 30_000 });
    assert.deepEqual(await receipt.locator('[data-position-receipt-line]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-position-receipt-line'))).then((lines) => lines.filter((line, i, all) => all.indexOf(line) === i)).then((lines) => lines.filter((line) => ['paid-in', 'swapped', 'fee', 'position-added'].includes(line))), ['paid-in', 'swapped', 'fee', 'position-added']);
    const [approve, add] = chain.sends.map((entry) => entry.tx);
    assert.deepEqual(decodeFunctionData({ abi: NFT, data: approve.data }).args, [ZAP_V4, 5_100_005n], 'the zap approved on this NFT only');
    assert.deepEqual([add.to, add.data.slice(0, 10), BigInt(add.value)], [ZAP_V4, '0x2e563c43', 50_000_000_000_000_000n], 'increase, with the ETH it pays');
    await dialog.locator('[data-position-back]').click();
    await dialog.waitFor({ state: 'detached' });
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

test('(e) under automation: the armed root blocks Change range (the menu says why) and its exit names the reserves that stay, waiting for the pause warning; a successor is the vault\'s; a hooked pool is not supported', async () => {
  const chain = chainOf();
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100002', read6: READ6, planner: plannerFor() });
  try {
    const page = s.page;
    const root = page.locator('[data-position-detail][data-position-id="5100002"]');
    await root.waitFor({ timeout: 30_000 });
    await root.locator('[data-position-v2-action="protect"]').waitFor();
    assert.equal(await root.locator('[data-position-v2-action="collect"]').isDisabled(), false);
    assert.equal(await root.locator('[data-position-v2-blocked]').count(), 1, 'a disabled action keeps its reason visible');
    // Decision #5: Change range stays listed, disabled, with its reason as the menu's heading.
    const { menu, entries } = await openMenu(root);
    assert.deepEqual(entries, [['increase', 'Add liquidity', false], ['changeRange', 'Change range', true], ['exit', 'Withdraw', false], ['protect', 'Stop-loss / take-profit', false]]);
    // Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation").
    assert.equal(await text(menu.locator('[data-position-v2-blocked]')), 'Change range isn’t available while your automation manages this position.');
    assert.equal(await menu.locator('button[data-position-v2-action][data-position-v2-action="changeRange"]').getAttribute('title'), 'Change range isn’t available while your automation manages this position.');
    await menu.locator('button[data-position-v2-action][data-position-v2-action="exit"]').click();
      const dialog = page.locator('[role="dialog"][data-position-dialog="v2-exit"]');
    assert.equal(await text(dialog.locator('[data-position-root-note]')), 'This pauses automation for this position. You can turn it back on afterwards.');
    await dialog.getByRole('radiogroup', { name: 'You receive' }).getByRole('radio', { name: 'USDC', exact: true }).click();
    await dialog.locator('[data-position-continue="exit"]').click();
    await dialog.locator('[data-position-review="exit"]').waitFor({ timeout: 30_000 });
    // Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation").
    assert.equal(await text(dialog.locator('[data-position-reserves-stay]')), 'Fees waiting to be reinvested stay in your automation: 0.001 ETH + 2.5 USDC. After this, you go straight to withdrawing them to your wallet.');
    assert.equal(await dialog.locator('[data-position-confirm]').isDisabled(), true, 'nothing is prepared before the warning is ticked');
    assert.equal(await text(dialog.locator('[data-position-tick-first]')), 'Tick the box above first.');
    await dialog.locator('[data-position-pause-confirm]').check();
    await dialog.locator('[data-position-confirm="approve-nft"]:not([disabled])').waitFor({ timeout: 30_000 });
    await page.keyboard.press('Escape');
    assert.equal(chain.sends.length, 0, 'nothing sent here');
    // A successor and a hooked position, on their own pages.
    await page.evaluate(() => { location.hash = '#/positions/base-v4-5100003'; });
    const successor = page.locator('[data-position-detail][data-position-id="5100003"]');
    await successor.waitFor({ timeout: 30_000 });
    // Review #6, #13: one sentence in the row, no button and no menu.
    // Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation").
    assert.equal(await text(successor.locator('[data-position-actions] [data-position-v2-blocked="successor"]')), "Your automation holds this position. Withdraw it from your automation on your main position's page first.");
    assert.equal(await successor.locator('[data-position-v2-action], [data-position-v2-more]').count(), 0);
    await page.evaluate(() => { location.hash = '#/positions/base-v4-5100004'; });
    const hooked = page.locator('[data-position-detail][data-position-id="5100004"]');
    await hooked.waitFor({ timeout: 30_000 });
    // Decision #6: Collect fees disabled with the reason as its title; every entry of the menu disabled, the reason its heading.
    assert.equal(await hooked.locator('[data-position-v2-action="collect"]').isDisabled(), true);
    assert.equal(await hooked.locator('[data-position-v2-action="collect"]').getAttribute('title'), "Pools with hooks aren't supported yet.");
    const blocked = await openMenu(hooked);
    assert.deepEqual(blocked.entries.map(([key, , disabled]) => [key, disabled]), [['increase', true], ['changeRange', true], ['exit', true]]);
    assert.equal(await text(blocked.menu.locator('[data-position-v2-blocked]')), "Pools with hooks aren't supported yet.");
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
    await dialog.locator('[data-position-continue="exit"]').click();
    await dialog.locator('[data-position-direct="ready"]').waitFor({ timeout: 30_000 });
    const receive = dialog.locator('[data-position-receive="close"]');
    assert.match(await text(receive), /^You receive .*ETH.*USDC At least .*ETH.*USDC Domino fee No Domino fee Network fee Up to [\d.]+ ETH$/);
    await dialog.locator('[data-position-send="close"]:not([disabled])').click();
    await dialog.locator('[data-position-direct="done"]').waitFor({ timeout: 30_000 });
    assert.match(await text(dialog.locator('[data-position-receipt]')), /Paid by Uniswap .*Domino fee No Domino fee/);
    assert.equal(chain.sends.length, 1);
    assert.equal(chain.sends[0].tx.to, V4_PM);
  } finally { await s.close(); }
});

test('(g) preview (the gate open, no live set): the same page from read-v6, every action to its review with what was chosen and the gate\'s sentence; a wallet on another chain is never asked to switch, and no plan is asked', async () => {
  // The wallet on Robinhood Chain, the position on Base (read-v6's): the direct actions (Collect fees, Withdraw in both
  // tokens) show the request instead of reading the chain through the wallet, which is never asked to switch (review #3).
  const chain = createV2Chain({ chainId: 4663, timestamp: now() });
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100005', read6: READ6, live: false, script: true });
  try {
    const page = s.page;
    const detail = page.locator('[data-position-detail][data-position-v2="base-v4"][data-position-id="5100005"]');
    await detail.waitFor({ timeout: 30_000 });
    assert.doesNotMatch(await text(detail), /test data|example/i, 'real data only: nothing is marked as test data');
    assert.equal(await detail.locator('[data-position-actions] [data-position-v2-actions="preview"] [data-position-v2-more]').count(), 1);
    await page.screenshot({ path: join(shots(), 'position-v2-preview.png'), fullPage: true });
    // Collect fees opens straight on its review: off the position's chain, what was chosen and the gate's sentence.
    await detail.locator('[data-position-v2-action="collect"]').click();
    const collect = page.locator('[role="dialog"][data-position-dialog="v2-collect"]');
    assert.equal(await collect.getAttribute('data-position-gate'), 'preview');
    await collect.locator('[data-position-request="collect"]').waitFor({ timeout: 30_000 });
    // Changed on purpose 2026-10-03 (the owner, point 9): the card names the position (its pair), under the dialog's title.
    assert.equal(await text(collect.locator('[data-position-request="collect"]')), 'Position ETH / USDC');
    assert.equal(await text(collect.locator('[data-position-locked]')), LOCKED_BASE);
    assert.equal(await collect.locator('[data-position-send], [data-position-direct], [data-position-preview-note], [data-position-notice]').count(), 0, 'no wallet button, no chain read, no second note, no failure');
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
    // Withdraw in both tokens: a direct action too; off the position's chain, the request (nothing read, no switch asked).
    await pick(detail, 'exit');
    const exit = page.locator('[role="dialog"][data-position-dialog="v2-exit"]');
    assert.equal(await text(exit.locator('[data-position-way-note]')), 'No Domino fee.');
    await exit.locator('[data-position-continue="exit"]').click();
    await exit.locator('[data-position-request="exit"]').waitFor({ timeout: 30_000 });
    assert.equal(await text(exit.locator('[data-position-request="exit"]')), 'How much All Receive ETH / USDC Slippage 0.5%');
    assert.equal(await text(exit.locator('[data-position-locked]')), LOCKED_BASE);
    assert.equal(await exit.locator('[data-position-send], [data-position-direct]').count(), 0);
    await page.keyboard.press('Escape');
    await exit.waitFor({ state: 'detached' });
    assert.equal(chain.sends.length, 0);
    assert.deepEqual(s.planned, [], 'the preview asks no plan service');
    assert.ok(!chain.log.includes('wallet_switchEthereumChain'), 'the wallet was never asked to switch chain');
    assert.equal(chain.log.filter((method) => method === 'eth_call').length, 0, 'nothing was read through a wallet on another chain');
    // A position read-v6 does not list.
    await page.evaluate(() => { location.hash = '#/positions/base-v4-424242'; });
    await page.locator('[data-empty="position-v2"][data-position-reason="position_not_listed"]').waitFor({ timeout: 30_000 });
    assert.match(await text(page.locator('[data-empty="position-v2"]')), /This position isn’t in your wallet’s list\./);
  } finally { await s.close(); }
});

test('V2 protection uses the same read-v6 snapshot on Base, preserves stale prices, and never asks an off-chain wallet to switch just to edit', async () => {
  for (const stale of [false, true]) {
    const chain = createV2Chain({ chainId: 4663, timestamp: now() });
    const read6 = { portfolio: portfolioOf({ wallet: OWNER, tokens: TOKENS, positions: [live(5_100_005, { stale })] }) };
    const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100005', read6, live: false, script: true });
    try {
      const page = s.page;
      const detail = page.locator('[data-position-detail][data-position-v2="base-v4"]');
      await detail.locator('[data-position-v2-action="protect"]').click();
      const dialog = page.locator('[data-v2in-dialog="mandate"]');
      await dialog.locator(`[data-mandate-reference="${stale ? 'saved' : 'current'}"]`).waitFor();
      assert.equal(await dialog.locator('[data-mandate-reference]').getAttribute('data-price-block'), '73399500');
      assert.notEqual(await dialog.locator('[data-mandate-current-price]').innerText(), '—');
      assert.equal(await dialog.locator('[data-mandate-shortcut="falls-10"]').isDisabled(), stale);
      if (!stale) {
        await dialog.locator('[data-mandate-shortcut="falls-10"]').click();
        await dialog.locator('[data-mandate-shortcut="rises-20"]').click();
        assert.match(await dialog.locator('[data-mandate-distance="falls"]').innerText(), /−10%/);
        assert.match(await dialog.locator('[data-mandate-distance="rises"]').innerText(), /\+20%/);
        for (const width of [1440, 390, 320]) {
          await page.setViewportSize({ width, height: 960 });
          const overflow = await dialog.evaluate((node) => [node, node.querySelector('.dm-flow-dialog-body')].some((el) => el.scrollWidth > el.clientWidth + 1));
          assert.equal(overflow, false, `protection at ${width} has no horizontal overflow`);
          await dialog.screenshot({ path: join(shots(), `protection-v2-selected-${width}-local-fixture.png`), animations: 'disabled' });
        }
      } else {
        await dialog.locator('[data-mandate-input="falls"]').fill('2000');
      }
      await dialog.locator('[data-mandate-review]').click();
      await page.locator('[data-v2in-dialog="mandate"] [data-mandate-terms]').waitFor();
      assert.equal(await dialog.locator('[data-v2-locked]').innerText(), LOCKED_BASE);
      assert.equal(await dialog.locator('[data-mandate-send]').isDisabled(), true);
      assert.equal(chain.sends.length, 0);
      assert.equal(s.planned.length, 0);
      const walletCalls = chain.log.map((item) => typeof item === 'string' ? item : item.method);
      assert.ok(!walletCalls.includes('wallet_switchEthereumChain'), 'editing a preview exit never switches the wallet');
      assert.ok(!walletCalls.includes('eth_signTypedData_v4'), 'no signature without a live gate and explicit consent');
    } finally { await s.close(); }
  }
});
