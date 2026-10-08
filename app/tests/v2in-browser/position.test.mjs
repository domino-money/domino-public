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
import { decodeFunctionData, encodeFunctionResult, parseAbi } from 'viem';
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
    const activity = detail.locator('[data-position-activity-item]').first();
    await activity.waitFor();
    await activity.locator('summary').click();
    assert.match(await text(activity), /Added to position #5100001/);
    assert.match(await text(activity), /Domino fee \(0\.65% of the amount swapped\).*0\.325 USDC/);
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

test('(e) under automation: the armed root blocks Change range (the menu says why) and its exit names the reserves that stay, waiting for the pause warning; a successor is the vault\'s; a hooked pool is not supported', async () => {
  const chain = chainOf();
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100002', read6: READ6, planner: plannerFor() });
  try {
    const page = s.page;
    const root = page.locator('[data-position-detail][data-position-id="5100002"]');
    await root.waitFor({ timeout: 30_000 });
    await root.locator('[data-position-v2-action="exit"]').waitFor();
    assert.equal(await root.locator('[data-position-v2-action="collect"]').isDisabled(), false);
    assert.equal(await root.locator('[data-position-v2-blocked]').count(), 1, 'a disabled action keeps its reason visible');
    // Decision #5: Change range stays listed, disabled, with its reason as the menu's heading. Changed on purpose
    // 2026-10-06 (the owner's point 5; rugged97: "auto-exit has no fee compounding"): a running Domino-compound is never
    // offered Auto-exit.
    const { menu, entries } = await openMenu(root);
    assert.deepEqual(entries, [['increase', 'Add liquidity', false], ['changeRange', 'Change range', true], ['exit', 'Withdraw', false]]);
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
    // Changed on purpose 2026-10-06 (the review of point 4, ux #1, a second look): with nothing checked yet, no fee is
    // known: the network fee line says so in words, never a bare dash a touch screen cannot explain.
    const unknown = dialog.locator('[data-position-network-fee="unknown"]');
    assert.equal(await text(unknown), 'Network fee Your wallet shows it before you confirm');
    assert.equal(await unknown.locator('[data-figure="none"]').count(), 0, 'no bare dash in view');
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
        assert.match(await text(detail.locator('[data-automation-control]')), /State unavailable/);
        assert.equal(await detail.locator('[data-automation-setup]').count(), 0, 'stale custody cannot enable a new automation');
        assert.equal(chain.sends.length, 0);
        continue;
      }
      await detail.locator('[data-automation-setup]').click();
      const dialog = page.locator('[data-v2in-dialog="mandate"]');
      await dialog.waitFor();
      // The price (tick -199,020) inside the range (-201,060 to -197,040): both edges, exactly TickMath's integers.
      const edges = dialog.locator('[data-mandate-edges="inside"] [data-mandate-edge]');
      await edges.first().waitFor();
      const exact = await edges.evaluateAll((items) => items.map((li) => [li.getAttribute('data-mandate-trigger'), li.getAttribute('data-exact')]).sort());
      assert.deepEqual(exact, [['above', position.sqrtPriceAtTick(RANGE.tickUpper).toString()], ['below', position.sqrtPriceAtTick(RANGE.tickLower).toString()]]);
      for (const edge of await edges.all()) assert.match(await text(edge), /^[↘↗] (falls|rises) to [\d,.]+ USDC per ETH$/);
      assert.equal(await dialog.locator('[data-mandate-edges]').getAttribute('data-mandate-price'), stale ? 'saved' : 'page');
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
test('(b3) live on Base with qualified prices: what it holds and its fees in dollars, the token amounts under them, still no APR', async () => {
  const pools = JSON.parse(readFileSync(new URL('../../../api-contracts/read-v6/fixtures/valid/chain-pools.json', import.meta.url), 'utf8'));
  const priced = (token, symbol) => ({ ...token, price: pools.tokens.find((one) => one.symbol === symbol).price, priceReason: null });
  const portfolio = portfolioOf({ wallet: OWNER, tokens: [priced(TOKENS[0], 'ETH'), priced(TOKENS[1], 'USDC')], positions: [live(5_100_001, { approved: ZAP_V4 })] });
  const s = await openPositionPage(browser, chainOf(), { hash: '#/positions/base-v4-5100001', read6: { ...READ6, portfolio } });
  try {
    const detail = s.page.locator('[data-position-detail][data-position-v2="base-v4"][data-position-id="5100001"]');
    await detail.waitFor({ timeout: 30_000 });
    const holds = detail.locator('[data-cell="principal"]');
    await holds.locator('[data-usd="principal"]').waitFor({ timeout: 30_000 });
    assert.match(await text(holds.locator('[data-usd="principal"]')), /^\$[\d,]+(\.\d{2})?$/, 'what it holds, in dollars');
    assert.match(await text(holds.locator('[data-stat="principal"]')), /ETH.*USDC/, 'its token amounts under the figure');
    // 0.001 ETH at $4,000.12 and 2.5 USDC at $1: $6.50.
    assert.equal(await text(detail.locator('[data-cell="fees"] [data-usd="fees"]')), '$6.50');
    assert.match(await text(detail.locator('[data-cell="fees"] [data-stat="fees"]')), /0\.001\s+ETH.*2\.5\s+USDC/);
    assert.equal(await detail.locator('[data-cell="apr"] [data-figure="none"]').count(), 1, 'still no APR');
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
