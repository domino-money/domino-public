/** Current owner-approved journey: Robinhood only, no example pools; fake-chain live create checks exact consent and calldata. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { decodeFunctionData, parseAbi } from 'viem';
import { closeBrowser } from '../support/close-browser.mjs';
import { openJourney } from '../support/journey-browser.mjs';
import { planAnswer, v4Path, ZERO } from '../support/s1-plans.mjs';
import { launchBrowser } from '../support/s1-browser.mjs';
import { WALLET_V2_DIST } from '../support/wallet-dist.mjs';
import { contractsFor, createV2Chain, poolIdOf } from '../support/v2-chain.mjs';
import { pressContinue } from '../support/new-position.mjs';
import { createReadStub, FIXTURE_POOL, FIXTURE_TOKEN } from '../support/read-stub.mjs';

const require = createRequire(import.meta.url);
const position = require('../../.test-build/app/src/finance/position.js');
const ERC20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
const shots = () => { const dir = resolve(import.meta.dirname, '../../.test-artifacts'); mkdirSync(dir, { recursive: true }); return dir; };

const OWNER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const USDG_RH = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const ZAP_V4 = '0x00000000000000000000000000000000d0d00004';
const POOL_RH = { dex: 4, currency0: ZERO, currency1: USDG_RH, fee: 500, tickSpacing: 10, hooks: ZERO };
const TICK = -199020;
const SQRT = position.sqrtPriceAtTick(TICK);
const now = () => Math.floor(Date.now() / 1000);

/** position-plan-v1 as it would answer a create on Robinhood Chain (tests/support/s1-plans.mjs): 500 of the stable swapped for ETH. */
function robinhoodPlanner(answers = []) {
  return (wire) => {
    if (wire.action !== 'create') return undefined;
    const pays = wire.inputs.some((input) => input.token === USDG_RH);
    const legs = pays ? [{ tokenIn: USDG_RH, tokenOut: ZERO, amountIn: 500_000_000n, expectedOut: 190_000_000_000_000_000n, data: v4Path(POOL_RH) }] : [];
    const body = planAnswer(wire, { owner: OWNER, zap: ZAP_V4, now: now(), pool: { sqrtPriceX96: SQRT, tick: TICK }, legs, nonce: { word: 9, bit: answers.length }, expected: { amounts: [190_000_000_000_000_000n, 490_000_000n], returned: [{ token: USDG_RH, amountRaw: '6750000' }] } });
    answers.push(body);
    return body;
  };
}

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await closeBrowser(browser); });

test('(a) with the gate closed, New position is today\'s journey exactly: no network choice and no zap path', async () => {
  const chain = createV2Chain({ chainId: 4663, timestamp: now() });
  const s = await openJourney(browser, chain, { dist: WALLET_V2_DIST, originOpen: false, connect: false });
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    await page.locator('#create-token-search').waitFor();
    // Give the wrapper time to read the gates: they stay closed.
    await page.waitForTimeout(500);
    assert.equal(await page.locator('[data-network-choice]').count(), 0);
    assert.equal(await page.locator('[data-zap-journey]').count(), 0);
    assert.equal(chain.sends.length, 0);
  } finally { await s.close(); }
});

// 2026-10-05 (the owner: his New position screens, as he built them): as before 2026-10-04's switch.
test('(b) preview keeps Robinhood creation with the advanced finder, without a network picker or invented examples', async () => {
  const chain = createV2Chain({ chainId: 4663, timestamp: now() });
  const s = await openJourney(browser, chain, { dist: WALLET_V2_DIST, connect: false });
  try {
    const page = s.page;
    await page.locator('#create-token-search').waitFor();
    await page.locator('[data-pool-advanced] summary').click();
    await page.locator('[data-network-find-other]').click();
    const zap = page.locator('[data-zap-journey="4663"][data-zap-gate="preview"]');
    await zap.waitFor();
    assert.equal(await zap.locator('[data-pool-finder="3"]').count(), 1);
    assert.equal(await page.locator('[data-network-choice], [data-examples], [data-test-data]').count(), 0);
    assert.equal(await zap.locator('[data-create-position]').count(), 0);
    await zap.locator('[data-network-back-to-list]').click();
    await page.locator('#create-token-search').waitFor();
    assert.equal(await page.locator('[data-zap-journey]').count(), 0);
    assert.equal(chain.sends.length, 0);
    assert.equal(chain.signed.length, 0);
    assert.equal(s.planned.length, 0);
  } finally { await s.close(); }
});

// Added 2026-10-04 (the owner: every function runs on Domino V2's contracts): "New position" beside a pool (Markets, a
// featured row, a pool's page) links #/new/<id>[/<token>]; the zap journey took no link and opened on an empty search.
// It now verifies the linked pool as today's journey does (src/v2in/journey/linkedPool.ts) and opens with it chosen.
test('(b2) a pool’s link opens the zap journey with that pool chosen, verified through the read service first', async () => {
  const read = createReadStub();
  const chain = createV2Chain({ chainId: 4663, timestamp: now() });
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST,
    connect: false,
    hash: `#/new/${FIXTURE_POOL}/${FIXTURE_TOKEN}`,
    routes: [(request, url) => read.handle(request, url) ?? undefined],
    zapOnRobinhood: true,
  });
  try {
    const zap = s.page.locator('[data-zap-journey="4663"][data-zap-gate="preview"]');
    await zap.waitFor();
    const chosen = zap.locator(`[data-chosen-pool="${FIXTURE_POOL}"][data-pool-source="list"]`);
    await chosen.waitFor({ timeout: 30_000 });
    assert.match(await chosen.innerText(), /ETH \/ TOKEN/);
    assert.ok(read.requests.some((request) => request.path.endsWith('/pools')), 'verified by a pools read, never taken from the link alone');
    await zap.locator('[data-zap-continue="pool"]').click();
    await zap.locator('[data-stage="range"]').waitFor();
    assert.equal(chain.sends.length, 0);
    assert.equal(s.planned.length, 0);
  } finally { await s.close(); }
});

test('(c) Robinhood live fake-chain creation: review, exact approve and create on 0x1237, then receipt', async () => {
  const chain = createV2Chain({ chainId: 4663, timestamp: now(), balances: { [USDG_RH]: 5_000_000_000n }, pools: [{ pool: POOL_RH, sqrtPriceX96: SQRT, tick: TICK, liquidity: 10n ** 16n }] });
  chain.switchTo(4663);
  const answers = [];
  const s = await openJourney(browser, chain, { dist: WALLET_V2_DIST, live: [4663], contracts: { 4663: contractsFor(4663) }, planner: robinhoodPlanner(answers), zapOnRobinhood: true });
  try {
    const page = s.page;
    const zap = page.locator('[data-zap-journey="4663"][data-zap-gate="live"]');
    await zap.waitFor();
    assert.equal(await zap.locator('[data-examples]').count(), 0, 'no test examples under a live gate');
    // Step 1: the pool the person indicates (decision #9: read through the wallet, after the switch to Robinhood Chain).
    const finder = zap.locator('[data-pool-find]');
    await finder.locator('summary').click();
    assert.equal(await finder.getByRole('radiogroup', { name: 'Uniswap version' }).getByRole('radio', { name: 'Uniswap v4' }).getAttribute('aria-checked'), 'true');
    const tiers = await finder.getByRole('radiogroup', { name: 'Fee tier' }).getByRole('radio').allInnerTexts();
    assert.deepEqual(tiers.map((t) => t.trim()), ['0.01%', '0.05%', '0.3%', '1%'], 'v4: the four pairs (decision #26)');
    await finder.getByRole('radiogroup', { name: 'Uniswap version' }).getByRole('radio', { name: 'Uniswap v3' }).click();
    const v3Tiers = await finder.getByRole('radiogroup', { name: 'Fee tier' }).getByRole('radio').allInnerTexts();
    assert.deepEqual(v3Tiers.map((t) => t.trim()), ['0.01%', '0.05%', '0.3%', '1%'], 'Robinhood Chain\'s extra v3 tiers');
    await finder.getByRole('radiogroup', { name: 'Uniswap version' }).getByRole('radio', { name: 'Uniswap v4' }).click();
    await finder.getByRole('radiogroup', { name: 'First token' }).getByRole('radio', { name: 'ETH', exact: true }).click();
    await finder.getByRole('radiogroup', { name: 'Second token' }).getByRole('radio', { name: 'USDG', exact: true }).click();
    await finder.getByRole('radiogroup', { name: 'Fee tier' }).getByRole('radio', { name: '0.05%', exact: true }).click();
    await finder.locator('[data-pool-read]').click();
    const chosen = zap.locator('[data-chosen-pool][data-pool-source="wallet"]');
    await chosen.waitFor({ timeout: 30_000 });
    assert.equal(chain.chainId, 4663, 'switched to Robinhood Chain before anything of Robinhood Chain was read');
    assert.match(await chosen.innerText(), /ETH \/ USDG/);
    assert.match(await chosen.locator('[data-pool-chips]').innerText(), /Robinhood Chain\s*0\.05% fee/);
    await zap.locator('[data-zap-continue="pool"]').click();
    // Step 2: the standard width, on the pool's spacing, written as 1 ETH = … USDG.
    const range = zap.locator('[data-stage="range"]');
    await range.waitFor();
    const [lower, upper] = (await range.getAttribute('data-zap-range')).split(':').map(Number);
    assert.ok(lower % 10 === 0 && upper % 10 === 0 && lower < TICK && upper > TICK);
    assert.match(await range.locator('[data-pool-price-text]').innerText(), /^1 ETH = [\d,.]+ USDG$/);
    await zap.locator('[data-zap-continue="range"]').click();
    // Step 3: both tokens (ETH makes it a direct transaction), 0.5% by default; the warning only above 2%.
    await zap.locator(`[data-zap-amount="${ZERO}"] input`).fill('0.1');
    await zap.locator(`[data-zap-amount="${USDG_RH}"] input`).fill('1000');
    assert.equal(await zap.locator('[data-slippage]').getAttribute('data-slippage'), '50');
    assert.equal(await zap.locator('[data-zap-eth-direct]').innerText(), 'Paying with ETH needs a direct transaction.');
    await zap.locator('[data-zap-continue="amount"]').click();
    // Step 4: the review of the plan (the planner's answer, checked by the package, the app and the zap client).
    const review = zap.locator('[data-zap-review="live"][data-zap-review-stage="reviewed"]');
    await review.waitFor({ timeout: 30_000 });
    assert.equal(await zap.getAttribute('data-create-step'), 'review');
    assert.equal(await zap.locator('.dm-flow-preview').isHidden(), true, 'one review, with no duplicate preview');
    assert.equal(s.planned.length, 1);
    assert.equal(s.planned[0].consent, 'direct', 'native ETH: the direct path (§2.5.4)');
    assert.match(await review.locator('[data-fact="route-leg-0"]').innerText(), /500 USDG → ETH[\s\S]*Expected 0\.19 ETH[\s\S]*At least 0\.18905 ETH[\s\S]*Uniswap · 0\.05%/);
    assert.match(await review.locator('[data-review-fee-amount]').innerText(), /^3\.25 USDG$/);
    assert.equal(await review.locator('[data-review-fee-base]').innerText(), '0.65% of 500 USDG swapped');
    assert.match(await review.locator('[data-review-smaller]').innerText(), /^If the price moves within your slippage, your position can be up to [\d.]+% smaller\. The rest returns to your wallet\.$/);
    assert.match(await review.locator('[data-fact="review-leftovers"]').innerText(), /6\.75 USDG/);
    assert.match(await review.locator('[data-fact="review-deadline"]').innerText(), /Good for\s+(2|3) min, then a new quote/);
    assert.equal(await review.locator('[data-review-warning="eth_direct"]').innerText(), 'Paying with ETH needs a direct transaction.');
    const steps = review.locator('[data-wallet-steps="direct"] [data-wallet-step]');
    await review.locator('[data-wallet-step="approve"][data-step-status="ready"]').waitFor({ timeout: 30_000 });
    assert.deepEqual(await steps.evaluateAll((items) => items.map((item) => item.getAttribute('data-wallet-step'))), ['approve', 'action']);
    assert.match(await review.locator('[data-wallet-step="approve"]').innerText(), /Allow 1,000 USDG/);
    assert.equal(await review.locator('[data-review-details]').getAttribute('open'), null, 'technical detail stays folded');
    assert.equal(await review.locator('[data-v2-locked]').count(), 0);
    await page.screenshot({ path: join(shots(), 'journey-robinhood-live-review.png'), fullPage: true });
    // Create position: the steps in order, each confirmed on the network before the next.
    const create = zap.locator('[data-create-position]:not([disabled])');
    await create.click();
    const created = zap.locator('[data-created-position][data-zap-receipt]');
    await created.waitFor({ timeout: 60_000 });
    assert.match(await created.locator('#created-title').innerText(), /^Position NFT #\d+ is in your wallet\.$/);
    assert.equal(await created.locator('[data-fact="receipt-fee"]').getAttribute('data-receipt-fee'), '3250000', 'the exact fee, as FeeCharged says it');
    assert.equal(await created.locator('[data-fact="receipt-gas"]').getAttribute('data-receipt-gas'), 'available', 'Robinhood Chain: gasUsed × price plus the L1 data fee');
    assert.match(await created.locator('a[data-created-next="position"]').getAttribute('href'), /^#\/positions\/robinhood-v4-\d+$/);
    // Exactly as reviewed: approve(zap, exact) then create, both on Robinhood Chain.
    assert.equal(chain.sends.length, 2);
    const [approve, createTx] = chain.sends.map((entry) => entry.tx);
    assert.deepEqual([approve.to, approve.chainId], [USDG_RH, '0x1237']);
    assert.deepEqual(decodeFunctionData({ abi: ERC20, data: approve.data }).args, [ZAP_V4, 1_000_000_000n], 'the exact amount the zap pulls');
    assert.deepEqual([createTx.to, createTx.data.slice(0, 10), createTx.chainId], [ZAP_V4, '0x0e97b041', '0x1237']);
    assert.equal(BigInt(createTx.value), 100_000_000_000_000_000n, 'the native input as msg.value');
    assert.equal(createTx.data, answers[0].plan.call.data, 'the call data the plan carried, checked and sent as reviewed');
    assert.deepEqual(chain.offChain.filter((m) => m !== 'wallet_getCapabilities'), [], 'nothing of Robinhood Chain asked while the wallet was elsewhere');
    await page.screenshot({ path: join(shots(), 'journey-robinhood-live-created.png'), fullPage: true });
  } finally { await s.close(); }
});

// Added 2026-10-05 (the owner: his New position screens, with Domino V2 connected behind them). The read service lists
// Robinhood's ETH/USDG 0.05% pool (read-v1's own fixtures, its pool made this one), the fake chain holds it, and the gate
// is live: his journey runs every step, then Review asks the plan and Create position runs on the zap.
const READ_FIXTURES = resolve(import.meta.dirname, '../../../api-contracts/read-v1/fixtures/gateway');
const FIXTURE_POOL_ID = JSON.parse(readFileSync(join(READ_FIXTURES, 'pools.success.json'), 'utf8')).pools[0].poolId;
function robinhoodRead(route, body) {
  const name = { 'pool-market': 'pool-market.not-requested', 'wallet-assets': 'wallet-assets.zero', token: body.token === ZERO ? 'token.native' : 'token.success' }[route] ?? `${route}.success`;
  const text = readFileSync(join(READ_FIXTURES, `${name}.json`), 'utf8').replaceAll(FIXTURE_TOKEN, USDG_RH).replaceAll('"TOKEN"', '"USDG"').replaceAll(FIXTURE_POOL_ID, poolIdOf(POOL_RH));
  const answer = JSON.parse(text);
  if (route === 'pools') {
    for (const pool of answer.pools) Object.assign(pool, { currentLpFeePips: 500, tick: TICK, sqrtPriceX96: SQRT.toString(), poolKey: { ...pool.poolKey, fee_pips: 500, tick_spacing: 10 } });
  }
  if (route === 'wallet-assets') {
    for (const item of answer.items) item.amountRaw = item.address === ZERO ? String(10n ** 19n) : String(5_000_000_000n);
  }
  return JSON.stringify(answer);
}

test('(d) the owner’s journey on V2: his steps, his preview and balances, the plan’s review on his Review, approve and create on the zap, then his created view', async () => {
  const chain = createV2Chain({ chainId: 4663, timestamp: now(), balances: { [USDG_RH]: 5_000_000_000n }, pools: [{ pool: POOL_RH, sqrtPriceX96: SQRT, tick: TICK, liquidity: 10n ** 16n }] });
  chain.switchTo(4663);
  const read = createReadStub({ answer: robinhoodRead });
  const answers = [];
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [4663], contracts: { 4663: contractsFor(4663) }, planner: robinhoodPlanner(answers),
    routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true,
  });
  try {
    const page = s.page;
    // His journey, never the zap path's screens, under a live gate.
    await page.locator('[data-create-journey]').waitFor();
    assert.equal(await page.locator('[data-zap-journey]').count(), 0, 'no zap path screens');
    await page.getByRole('combobox', { name: 'Search a token' }).fill(USDG_RH);
    await page.locator(`[data-token-option="${USDG_RH}"]`).click();
    await page.locator('[data-picker="pool"] input[name="pool-option"]').first().click({ timeout: 30_000 });
    await page.locator('[data-chosen-pool]').waitFor();
    const current = (step) => page.locator(`li[data-step="${step}"][aria-current="step"]`);
    await pressContinue(current('pool'));
    await current('range').waitFor();
    assert.equal(await page.locator('aside[data-preview]').count(), 1, 'his preview beside the steps');
    await pressContinue(current('range'));
    await current('amount').waitFor();
    await page.locator('li[data-step="amount"] [data-pair-balance="ready"]').first().waitFor({ timeout: 30_000 });
    assert.ok(await page.locator('li[data-step="amount"] [data-pair-max]').count() >= 1, 'his wallet balances with Max');
    const field = 'li[data-step="amount"][aria-current="step"] [data-pair-side="1"] input[inputmode="decimal"]';
    await page.locator(field).fill('1000');
    await pressContinue(current('amount'));
    // Review: the plan for what his journey chose, then Create position on the new contracts.
    const review = page.locator('[data-stage-card="review"] [data-zap-review="live"][data-zap-review-stage="reviewed"]');
    await review.waitFor({ timeout: 30_000 });
    assert.equal(s.planned.length, 1, 'one plan');
    assert.equal(s.planned[0].action, 'create');
    // Both of the pool's tokens, as his amount step showed them: the 1,000 USDG he typed and the ETH it pairs with.
    assert.deepEqual(s.planned[0].inputs.map((input) => input.token), [ZERO, USDG_RH]);
    assert.equal(s.planned[0].inputs[1].amountRaw, '1000000000', 'the 1,000 USDG he typed');
    assert.ok(BigInt(s.planned[0].inputs[0].amountRaw) > 0n, 'and the ETH it pairs with');
    assert.equal(await page.locator('[data-create-position="idle"]').count(), 0, 'not Domino V1’s Create position');
    await page.locator('[data-create-position="live"]:not([disabled])').click({ timeout: 30_000 });
    await page.locator('[data-created-position]').waitFor({ timeout: 60_000 });
    const createTx = chain.sends.map((entry) => entry.tx).find((tx) => tx.to === ZAP_V4);
    assert.ok(createTx, 'the create went to the zap');
    assert.equal(createTx.data, answers.at(-1).plan.call.data, 'the call data the plan carried');
    assert.equal(await page.locator('a[href^="#/sequence/compound/"]').count() >= 1, true, 'his created view, with what comes next');
  } finally { await s.close(); }
});

// Added 2026-10-05 (the owner: "the search on the screen, across the three networks; the results get the network's tag",
// and creating there through Domino V2): his journey on Base, from his search to his created position.
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const POOL_BASE = { dex: 4, currency0: ZERO, currency1: USDC_BASE, fee: 500, tickSpacing: 10, hooks: ZERO };
const TICK_BASE = -198080;
const SQRT_BASE = position.sqrtPriceAtTick(TICK_BASE);

/** position-plan-v1 as it would answer a create on Base: 500 USDC swapped for ETH when the wallet pays USDC. */
function basePlanner(answers = []) {
  return (wire) => {
    if (wire.action !== 'create' || wire.chainId !== 8453) return undefined;
    const pays = wire.inputs.some((input) => input.token === USDC_BASE);
    const legs = pays ? [{ tokenIn: USDC_BASE, tokenOut: ZERO, amountIn: 500_000_000n, expectedOut: 190_000_000_000_000_000n, data: v4Path(POOL_BASE) }] : [];
    const body = planAnswer(wire, { owner: OWNER, zap: ZAP_V4, now: now(), pool: { sqrtPriceX96: SQRT_BASE, tick: TICK_BASE }, legs, nonce: { word: 9, bit: answers.length }, expected: { amounts: [190_000_000_000_000_000n, 490_000_000n], returned: [{ token: USDC_BASE, amountRaw: '6750000' }] } });
    answers.push(body);
    return body;
  };
}

test('(e) his journey on Base: Base\'s USDC in his search with its tag, the wallet moved to Base once, Base\'s pools in his list, his steps, the plan and the create on Base', async () => {
  const chain = createV2Chain({ chainId: 8453, timestamp: now(), balances: { [USDC_BASE]: 5_000_000_000n }, pools: [{ pool: POOL_BASE, sqrtPriceX96: SQRT_BASE, tick: TICK_BASE, liquidity: 10n ** 18n }] });
  // The wallet starts on Robinhood Chain, as the site's own network.
  chain.switchTo(4663);
  const read = createReadStub({ answer: robinhoodRead });
  const answers = [];
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [8453], contracts: { 8453: contractsFor(8453) }, planner: basePlanner(answers),
    routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true,
  });
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    assert.equal(await page.locator('[data-zap-journey]').count(), 0, 'his journey, never the zap path\'s screens');
    await page.getByRole('combobox', { name: 'Search a token' }).fill('USDC');
    // Base's USDC, with Base's tag; Arbitrum One's gate is not live, so it offers nothing.
    const hit = page.locator(`[data-token-network-option="8453:${USDC_BASE}"]`);
    await hit.waitFor();
    assert.equal((await hit.locator('[data-chain-chip="8453"]').innerText()).trim(), 'Base');
    assert.equal(await page.locator('[data-token-network-option^="42161:"]').count(), 0);
    assert.equal(chain.chainNow(), 4663, 'nothing asked of the wallet for a search');
    await hit.click();
    // Base's pools, read through the wallet once it moved to Base, in his list's rows with Base's tag.
    const pools = page.locator('[data-picker="pool"][data-picker-network="8453"]');
    await pools.locator('input[name="pool-option"]').first().waitFor({ timeout: 30_000 });
    assert.equal(chain.chainNow(), 8453, 'the wallet moved to Base');
    assert.deepEqual(chain.offChain, [], 'nothing of Base read before the wallet was on Base');
    assert.equal(chain.multicalls.length, 1, 'the token\'s pools in one read (a second only for v3 pools that exist, and none does here)');
    assert.equal(await pools.locator(`li[data-pool-key="${poolIdOf(POOL_BASE)}"]`).count(), 1, 'the one pool with a price and liquidity');
    assert.equal((await pools.locator('[data-chain-chip="8453"]').first().innerText()).trim(), 'Base');
    assert.equal(await page.locator('[data-pools-unavailable]').count(), 0);
    await pools.locator('input[name="pool-option"]').first().click();
    const chosen = page.locator('[data-chosen-pool]');
    await chosen.waitFor();
    assert.equal((await chosen.locator('[data-chain-chip="8453"]').innerText()).trim(), 'Base');
    const current = (step) => page.locator(`li[data-step="${step}"][aria-current="step"]`);
    await pressContinue(current('pool'));
    await current('range').waitFor();
    await pressContinue(current('range'));
    await current('amount').waitFor();
    // His amount step, with the wallet's balances read on Base.
    await page.locator('li[data-step="amount"] [data-pair-balance="ready"]').first().waitFor({ timeout: 30_000 });
    assert.ok(await page.locator('li[data-step="amount"] [data-pair-max]').count() >= 1, 'his Max, from the balances on Base');
    const field = 'li[data-step="amount"][aria-current="step"] [data-pair-side="1"] input[inputmode="decimal"]';
    await page.locator(field).fill('1000');
    await pressContinue(current('amount'));
    // Review: the plan for Base, then Create position on Base's zap.
    const review = page.locator('[data-stage-card="review"] [data-zap-review="live"][data-zap-review-stage="reviewed"]');
    await review.waitFor({ timeout: 30_000 });
    assert.equal(s.planned.length, 1, 'one plan');
    assert.deepEqual([s.planned[0].action, s.planned[0].chainId], ['create', 8453]);
    assert.deepEqual(s.planned[0].inputs.map((input) => input.token), [ZERO, USDC_BASE]);
    assert.equal(s.planned[0].inputs[1].amountRaw, '1000000000', 'the 1,000 USDC he typed');
    assert.equal(await page.locator('[data-create-position="idle"]').count(), 0, 'not Domino V1\'s Create position');
    await page.locator('[data-create-position="live"]:not([disabled])').click({ timeout: 30_000 });
    await page.locator('[data-created-position][data-zap-receipt]').waitFor({ timeout: 60_000 });
    const [approve, createTx] = chain.sends.map((entry) => entry.tx);
    assert.deepEqual([approve.to, approve.chainId], [USDC_BASE, '0x2105'], 'the exact approval, on Base');
    assert.equal(decodeFunctionData({ abi: ERC20, data: approve.data }).args[0].toLowerCase(), ZAP_V4);
    assert.deepEqual([createTx.to, createTx.chainId], [ZAP_V4, '0x2105'], 'the create on Base\'s zap');
    assert.equal(createTx.data, answers.at(-1).plan.call.data, 'the call data the plan carried');
    // The created view is the zap path's (its receipt, its link on Base), never today's Robinhood Chain lists.
    assert.match(await page.locator('a[data-created-next="position"]').getAttribute('href'), /^#\/positions\/base-v4-\d+$/);
    assert.equal(await page.locator('a[href^="#/sequence/compound/"]').count(), 0);
  } finally { await s.close(); }
});

// Added 2026-10-05 (the owner: "and if he wants to build on Arbitrum, the same thing"): his journey on Arbitrum One, in a
// v3 pool, with both networks offered.
const WETH_ARB = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const USDC_ARB = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const ZAP_V3 = '0x00000000000000000000000000000000d0d00003';
const POOL_ARB = { dex: 3, currency0: WETH_ARB, currency1: USDC_ARB, fee: 500, tickSpacing: 10, hooks: ZERO };

/** position-plan-v1 as it would answer a create on Arbitrum One that the wallet funds with both tokens: no swap. */
function arbitrumPlanner(answers = []) {
  return (wire) => {
    if (wire.action !== 'create' || wire.chainId !== 42161) return undefined;
    const body = planAnswer(wire, { owner: OWNER, zap: ZAP_V3, now: now(), pool: { sqrtPriceX96: SQRT_BASE, tick: TICK_BASE }, legs: [], nonce: { word: 9, bit: answers.length }, expected: { amounts: [10n ** 17n, 250_000_000n], returned: [] } });
    answers.push(body);
    return body;
  };
}

test('(f) his journey on Arbitrum One: both networks in his search, each with its tag; Arbitrum One\'s WETH, its v3 pool, the plan and the create on Arbitrum One', async () => {
  const chain = createV2Chain({ chainId: 42161, timestamp: now(), balances: { [WETH_ARB]: 2n * 10n ** 18n, [USDC_ARB]: 5_000_000_000n }, pools: [{ pool: POOL_ARB, sqrtPriceX96: SQRT_BASE, tick: TICK_BASE, liquidity: 10n ** 18n }] });
  chain.switchTo(4663);
  const read = createReadStub({ answer: robinhoodRead });
  const answers = [];
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [8453, 42161], contracts: { 8453: contractsFor(8453), 42161: contractsFor(42161) }, planner: arbitrumPlanner(answers),
    routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true,
  });
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    await page.getByRole('combobox', { name: 'Search a token' }).fill('WETH');
    const base = page.locator('[data-token-network-option="8453:0x4200000000000000000000000000000000000006"]');
    const arbitrum = page.locator(`[data-token-network-option="42161:${WETH_ARB}"]`);
    await arbitrum.waitFor();
    assert.equal((await base.locator('[data-chain-chip]').innerText()).trim(), 'Base');
    assert.equal((await arbitrum.locator('[data-chain-chip]').innerText()).trim(), 'Arbitrum One');
    await arbitrum.click();
    const pools = page.locator('[data-picker="pool"][data-picker-network="42161"]');
    await pools.locator('input[name="pool-option"]').first().waitFor({ timeout: 30_000 });
    assert.equal(chain.chainNow(), 42161, 'the wallet moved to Arbitrum One');
    assert.deepEqual(chain.offChain, [], 'nothing of Arbitrum One read before the wallet was on Arbitrum One');
    assert.equal(chain.multicalls.length, 2, 'two reads: every pool asked, then the v3 pool that exists');
    const row = pools.locator('li[data-pool-key]');
    assert.equal(await row.count(), 1);
    assert.match(await row.getAttribute('data-pool-key'), /^0x0{24}[0-9a-f]{40}$/, 'a v3 pool keyed by its address');
    assert.equal((await row.locator('[data-chain-chip="42161"]').innerText()).trim(), 'Arbitrum One');
    await pools.locator('input[name="pool-option"]').first().click();
    await page.locator('[data-chosen-pool] [data-chain-chip="42161"]').waitFor();
    const current = (step) => page.locator(`li[data-step="${step}"][aria-current="step"]`);
    await pressContinue(current('pool'));
    await current('range').waitFor();
    await pressContinue(current('range'));
    await current('amount').waitFor();
    await page.locator('li[data-step="amount"] [data-pair-balance="ready"]').first().waitFor({ timeout: 30_000 });
    const field = 'li[data-step="amount"][aria-current="step"] [data-pair-side="1"] input[inputmode="decimal"]';
    await page.locator(field).fill('250');
    await pressContinue(current('amount'));
    const review = page.locator('[data-stage-card="review"] [data-zap-review="live"][data-zap-review-stage="reviewed"]');
    await review.waitFor({ timeout: 30_000 });
    assert.deepEqual([s.planned[0].action, s.planned[0].chainId, s.planned[0].pool.dex], ['create', 42161, 3]);
    assert.deepEqual(s.planned[0].inputs.map((input) => input.token), [WETH_ARB, USDC_ARB], 'both of the pool\'s tokens, as his amount step showed them');
    await page.locator('[data-create-position="live"]:not([disabled])').click({ timeout: 30_000 });
    await page.locator('[data-created-position][data-zap-receipt]').waitFor({ timeout: 60_000 });
    const txs = chain.sends.map((entry) => entry.tx);
    assert.ok(txs.every((tx) => tx.chainId === '0xa4b1'), 'every step on Arbitrum One');
    assert.deepEqual(txs.slice(0, -1).map((tx) => tx.to).sort(), [WETH_ARB, USDC_ARB].sort(), 'an exact approval of each token');
    assert.equal(txs.at(-1).to, ZAP_V3, 'the create on Arbitrum One\'s v3 zap');
    // Two tokens to pull: the client takes one Permit2 signature for both (createWithPermit), else the direct create.
    assert.ok(['0x0e97b041', '0xec627dfe'].includes(txs.at(-1).data.slice(0, 10)), 'create, or create with its Permit2 signature');
    assert.match(await page.locator('a[data-created-next="position"]').getAttribute('href'), /^#\/positions\/arbitrum-v3-\d+$/);
  } finally { await s.close(); }
});
