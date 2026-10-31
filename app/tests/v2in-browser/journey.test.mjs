/** Current owner-approved journey: verified networks, no example pools; fake-chain live create checks exact consent and calldata. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { decodeFunctionData, parseAbi } from 'viem';
import { closeBrowser } from '../support/close-browser.mjs';
import { confirmationRoute } from '../support/confirmation-route.mjs';
import { openJourney, WALLET_NAME } from '../support/journey-browser.mjs';
import { planAnswer, v4Path, ZERO } from '../support/s1-plans.mjs';
import { launchBrowser } from '../support/s1-browser.mjs';
import { WALLET_V2_DIST } from '../support/wallet-dist.mjs';
import { contractsFor, createV2Chain, poolIdOf } from '../support/v2-chain.mjs';
import { footerButton, press, pressContinue } from '../support/new-position.mjs';
import { createReadStub, FIXTURE_POOL, FIXTURE_TOKEN, gatewayError } from '../support/read-stub.mjs';
import { createChainReads } from '../support/chain-reads.mjs';
import { activityOf, indexedToken, livePosition, portfolioOf, s1Action } from '../support/s1-read6.mjs';

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
/** What a pool's fee is, every fee chip's title (components/explore/feeMeaning.ts FEE_MEANING, QA round 2, Q28). */
const FEE_MEANING = 'Traders pay this on every swap. People who add money to the pool, you included, share it. It is never taken from your deposit.';
/** Waits until the element in focus matches `selector` (QA round 2 follow-ups, N57 and R18). */
const focusedOn = (page, selector) => page.waitForFunction((css) => document.activeElement?.matches(css) ?? false, selector, { timeout: 10_000 });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** Waits (in real time) until `check()` holds. */
async function until(check, what, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await check()) return;
  assert.fail(`timed out waiting for ${what}`);
}
/** From now on, records whether the position's page ever drew its empty state ("This position isn’t in your wallet’s list."…). */
const watchEmpty = (page) => page.evaluate(() => {
  window.__positionEmpty = false;
  new MutationObserver(() => { if (document.querySelector('[data-empty="position-v2"]:not([data-position-reason="awaiting_index"])')) window.__positionEmpty = true; }).observe(document.body, { childList: true, subtree: true });
});
/** His footer's Back, drawn first in it (components/create/Journey.tsx): shown, or resting (`hidden`). */
const backOf = (page) => page.locator('[data-journey-footer] > button').first();
/** His Review footer's box: Create position's place is its whole width (styles/flow.css). */
const footerBox = (page) => page.locator('[data-stage-card="review"] [data-journey-footer]').boundingBox();
/**
 * The crosschain route's capabilities, live (src/v2/gate.ts s2Gate: S2's word is that route's own, which a suite's server
 * answers): Amount's bring-funds offer is open. Nothing else of that route is answered.
 */
const crosschainLive = (request, url) => (url.pathname === '/api/crosschain/v1/capabilities'
  ? Response.json({ contractVersion: '1.1.0-rc.1', dataMode: 'live', enabledRoutes: ['origins', 'quote', 'status'] }, { headers: { 'X-Domino-Crosschain-Contract': '1.1.0-rc.1' } })
  : undefined);

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
    // Changed 2026-10-06 (review: a flake): the chosen pool's TOKEN mark asks DEX Screener for its artwork, answered here
    // as every other suite answers it; unanswered, the request was refused and failed close() whenever it came in time.
    artwork: true,
  });
  try {
    const zap = s.page.locator('[data-zap-journey="4663"][data-zap-gate="preview"]');
    await zap.waitFor();
    const chosen = zap.locator(`[data-chosen-pool="${FIXTURE_POOL}"][data-pool-source="list"]`);
    await chosen.waitFor({ timeout: 30_000 });
    // Changed on purpose 2026-10-30 (QA round 2, Q24): the pair as its price is written, base then quote (TOKEN priced in
    // ETH on Robinhood Chain, src/v2in/journey/model/price.ts pricedPair), as Markets and the pool page name it.
    assert.match(await chosen.innerText(), /TOKEN \/ ETH/);
    // The pool pair's wrapping (2026-10-06) on the zap path's chosen pool: one line, as before, on a desktop and a phone.
    await s.page.screenshot({ path: join(shots(), 'journey-zap-chosen-1280.png') });
    await s.page.setViewportSize({ width: 390, height: 844 });
    await s.page.waitForTimeout(150);
    await s.page.screenshot({ path: join(shots(), 'journey-zap-chosen-390.png') });
    await s.page.setViewportSize({ width: 1280, height: 1000 });
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
    // Changed on purpose 2026-10-30 (QA round 2, N2): the fee format of every other screen ("0.30%", "1.00%").
    assert.deepEqual(tiers.map((t) => t.trim()), ['0.01%', '0.05%', '0.30%', '1.00%'], 'v4: the four pairs (decision #26)');
    await finder.getByRole('radiogroup', { name: 'Uniswap version' }).getByRole('radio', { name: 'Uniswap v3' }).click();
    const v3Tiers = await finder.getByRole('radiogroup', { name: 'Fee tier' }).getByRole('radio').allInnerTexts();
    assert.deepEqual(v3Tiers.map((t) => t.trim()), ['0.01%', '0.05%', '0.30%', '1.00%'], 'Robinhood Chain\'s extra v3 tiers');
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
    // Added 2026-10-31 (QA round 2 follow-ups, Q28): the zap path's fee chip says what the fee is on hover, as every fee chip.
    assert.equal(await chosen.locator('[data-pool-chips] [data-fee]').getAttribute('title'), FEE_MEANING);
    // Added 2026-10-31 (QA round 2 follow-ups, N57): Change pool by a click leaves the focus on Keep this pool, never on the
    // page's start; Keep this pool brings the same pool back, the focus on its Change pool.
    await chosen.locator('button').click();
    await focusedOn(page, '[data-keep-pool]');
    await zap.locator('[data-keep-pool]').click();
    await chosen.waitFor();
    await focusedOn(page, '[data-chosen-pool] button');
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
    const steps = review.locator('[data-wallet-steps="direct"] [data-wallet-step]');
    await review.locator('[data-wallet-step="approve"][data-step-status="ready"]').waitFor({ timeout: 30_000 });
    // Changed on purpose 2026-10-06 (the owner's point 4: "just a next button", little text): in view, the position, ONE
    // Domino fee line in §2.8's words and ONE network fee line (§2.4: the plan's cost; Robinhood's L1 part a measured 0).
    // Changed on purpose 2026-10-06 (the review of point 4): the position's amounts said as the estimate they are, as
    // today's Review writes them.
    assert.equal(await review.locator('[data-review-amounts]').innerText(), 'About 0.19 ETH + 490 USDG');
    assert.equal(await review.locator('[data-review-inputs]').innerText(), 'You put in 0.1 ETH + 1,000 USDG.');
    assert.equal(await review.locator('[data-review-fee="charged"]').innerText(), 'Domino fee: 3.25 USDG (0.65% of 500 USDG swapped)');
    assert.match(await review.locator('[data-review-fee-amount]').innerText(), /^3\.25 USDG$/);
    assert.equal(await review.locator('[data-review-fee-base]').innerText(), '0.65% of 500 USDG swapped');
    const networkFee = review.locator('[data-review-network-fee]');
    await review.locator('[data-review-network-fee="about"]').waitFor({ timeout: 30_000 });
    // Changed on purpose 2026-10-06 (the review of point 4): the plan's own cost (500,000 gas at the wallet's 0.2 gwei,
    // 0.0001 ETH) and the approval, a transaction of its own (prepared at 600,000 gas, 0.00012 ETH), together.
    // Changed on purpose 2026-10-30 (QA round 2, Q5): in dollars too where the pool prices ETH (ETH/USDG does).
    assert.match(await networkFee.innerText(), /^Network fee: about 0\.00022 ETH(?: \((?:<\$0\.01|\$[\d,]+(?:\.\d+)?)\))?$/);
    if (await networkFee.getAttribute('data-review-network-usd')) assert.match(await networkFee.innerText(), /\(<?\$/);
    assert.equal(await networkFee.getAttribute('data-review-network-wei'), '220000000000000');
    assert.equal(await networkFee.getAttribute('data-review-network-others'), null, 'every approval prepared: no dash');
    assert.equal(await networkFee.getAttribute('data-review-l1-fee'), '0', 'Robinhood Chain: a measured zero, part of the figure');
    // Gone from view: the second "Goes into the position", "As planned…", a fee on each step, a sentence under each step.
    const visible = await review.innerText();
    for (const gone of ['Goes into the position', 'As planned', 'Shown before each step', 'Lets Domino use this exact amount', 'Your position arrives in your wallet. Anything']) assert.ok(!visible.includes(gone), gone);
    assert.equal(await review.locator('[data-step-fee]').count(), 0, 'no network fee on each step');
    assert.deepEqual(await steps.evaluateAll((items) => items.map((item) => item.getAttribute('data-wallet-step'))), ['approve', 'action']);
    assert.deepEqual(await review.locator('.dm-flow-wstep-title').allInnerTexts(), ['Allow 1,000 USDG', 'Create the position'], 'the steps by their titles');
    assert.equal(await review.locator('[data-wallet-step="approve"] .dm-flow-wstep-title > span').getAttribute('title'), 'Allow 1,000 USDG', 'every digit of the amount to allow in its title');
    assert.equal(await review.locator('.dm-flow-wstep-note').count(), 0, 'no line under a step before Create position runs');
    assert.equal(await review.locator('[data-v2-locked]').count(), 0);
    // Added 2026-10-31 (QA round 2 follow-ups, Q28): the headline's fee chip says what the fee is on hover.
    assert.equal(await review.locator('[data-review-headline] [data-fee]').getAttribute('title'), FEE_MEANING);
    // Added 2026-10-31 (QA round 2 follow-ups, Q12): every automation the created view offers, "Automate." on one line.
    const later = zap.locator('[data-review-automate-later]');
    assert.match(await later.innerText(), /^You can add Auto-compound, Domino-compound or Auto-exit after the position is created, from Automate/);
    assert.equal(await later.locator('.whitespace-nowrap a[target="_blank"]').count(), 1, 'the link inside the line kept whole');
    assert.equal(await later.locator('.whitespace-nowrap').evaluate((node) => node.textContent), 'Automate (opens in a new tab).');
    assert.equal(await later.locator('.whitespace-nowrap').evaluate((node) => {
      const box = (text) => { const range = document.createRange(); range.selectNodeContents(text); return range.getBoundingClientRect(); };
      const dot = [...node.childNodes].find((child) => child.nodeType === Node.TEXT_NODE && child.textContent === '.');
      return dot !== undefined && Math.abs(box(dot).top - box(node.querySelector('a').firstChild).top) < 2;
    }), true, 'the period on the link’s line');
    // Everything else under ONE Details, closed; the developer facts only as its data attributes.
    const details = review.locator('[data-review-details]');
    assert.equal(await details.getAttribute('open'), null, 'technical detail stays folded');
    // Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, spec delta §1): §2.9's minimum stays in view, Details
    // closed, never folded with the technical facts.
    const smaller = review.locator('[data-review-smaller]');
    assert.match(await smaller.innerText(), /^If the price moves within your slippage, your position can be up to [\d.]+% smaller\. The rest returns to your wallet\.$/);
    assert.equal(await smaller.isVisible(), true, 'in view with Details closed');
    assert.equal(await details.locator('[data-review-smaller]').count(), 0, 'not in Details');
    assert.equal(await review.locator('details').count(), 1, 'one Details');
    assert.match(await details.getAttribute('data-plan-hash'), /^0x[0-9a-f]{64}$/);
    assert.match(await details.getAttribute('data-routes-hash'), /^0x[0-9a-f]{64}$/);
    assert.equal(await details.getAttribute('data-zap'), ZAP_V4);
    assert.match(await details.getAttribute('data-consent'), /^direct /);
    await page.screenshot({ path: join(shots(), 'journey-robinhood-live-review.png'), fullPage: true });
    await details.locator('summary').click();
    // Added 2026-10-31 (QA round 2 follow-ups, Q24): the contracts in the pair's order, ETH then USDG, as the headline.
    assert.deepEqual((await details.locator('[data-fact="details-tokens"] dd > span').allInnerTexts()).map((text) => text.toLowerCase()), ['eth (native)', USDG_RH]);
    assert.match(await details.locator('[data-fact="route-leg-0"]').innerText(), /500 USDG → ETH[\s\S]*Expected 0\.19 ETH[\s\S]*At least 0\.18905 ETH[\s\S]*Uniswap · 0\.05%/);
    assert.match(await details.locator('[data-fact="review-leftovers"]').innerText(), /6\.75 USDG/);
    assert.match(await details.locator('[data-fact="review-l1-fee"]').innerText(), /^L1 data fee\s+0 ETH$/, 'a measured zero, said as 0 (spec §2.4)');
    assert.equal(await details.locator('[data-fact="review-network-fee"]').count(), 0, 'no ceiling off Base');
    assert.match(await details.locator('[data-fact="review-deadline"]').innerText(), /Good for\s+(2|3) min, then a new quote/);
    assert.equal(await details.locator('[data-review-warning="eth_direct"]').innerText(), 'Paying with ETH needs a direct transaction.', 'rugged’s line, kept, folded');
    const folded = await details.innerText();
    for (const diagnostic of ['Plan hash', 'Route hash', 'Signature nonce', 'Domino contract', 'Consent', 'Gas (L2)', ' wei', 'simulation']) assert.ok(!folded.includes(diagnostic), diagnostic);
    await page.screenshot({ path: join(shots(), 'journey-robinhood-live-review-details.png'), fullPage: true });
    // Create position: the steps in order, each confirmed on the network before the next.
    const create = zap.locator('[data-create-position]:not([disabled])');
    await create.click();
    const created = zap.locator('[data-created-position][data-zap-receipt]');
    await created.waitFor({ timeout: 60_000 });
    assert.match(await created.locator('#created-title').innerText(), /^Position NFT #\d+ is in your wallet\.$/);
    // Added 2026-10-14 (incident C1; the owner's decision D0): its status is "Confirmed" from the block it is in, final or not.
    assert.equal(await created.locator('[data-fact="receipt-state"]:is([data-receipt-state="included"], [data-receipt-state="finalized"]) dd').innerText(), 'Confirmed');
    assert.equal(await created.locator('[data-fact="receipt-fee"]').getAttribute('data-receipt-fee'), '3250000', 'the exact fee, as FeeCharged says it');
    // Changed on purpose 2026-10-06 (the owner's point 4): amounts at most 6 decimals, every digit in the title (spec L1024).
    assert.equal(await created.locator('[data-fact="receipt-fee"] dd span').getAttribute('title'), '3.25 USDG');
    for (const text of await created.locator('[data-receipt] dd').allInnerTexts()) assert.doesNotMatch(text, /\.\d{7,}/, `${text}: at most 6 decimals`);
    assert.equal(await created.locator('[data-fact="receipt-gas"]').getAttribute('data-receipt-gas'), 'available', 'Robinhood Chain: gasUsed × price plus the L1 data fee');
    assert.match(await created.locator('a[data-created-next="position"]').getAttribute('href'), /^#\/positions\/robinhood-v4-\d+$/);
    // Added 2026-10-06 (the review of point 5): Auto-exit beside it, to the same page; the range holds today's price, so
    // it is offered without "Recommended".
    const exit = created.locator('a[data-created-next="autoexit"]');
    await exit.waitFor({ timeout: 30_000 });
    assert.equal(await exit.getAttribute('href'), await created.locator('a[data-created-next="position"]').getAttribute('href'));
    assert.equal(await exit.getAttribute('data-created-recommended'), null);
    assert.match(await exit.innerText(), /Auto-exit[\s\S]*Closes it at the end of its range and sends the tokens to your wallet\.[\s\S]*Turn on/);
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
    // Added 2026-10-06 (the final check's F1/F6, a second look): the zap path's success marks the flow made, as his journey's
    // does: the footer's New position (the hash already open) starts a fresh flow at step 1 instead of doing nothing.
    await page.locator('footer').getByRole('link', { name: 'New position', exact: true }).click();
    await created.waitFor({ state: 'detached', timeout: 10_000 });
    await zap.locator('li[data-step="pool"][data-state="current"]').waitFor({ timeout: 10_000 });
    assert.equal(await page.locator('[data-created-position], li[data-step-done]').count(), 0, 'no success, no step done');
    assert.equal(chain.sends.length, 2, 'nothing more was sent');
    // Added (2026-10-15, pack 8, package R1): the create is a row at once. Robinhood Chain keeps the NFT's hint too (it was
    // Base and Arbitrum One only), and the checked receipt is a row of Receipts before read-v6 lists it, in its words.
    const receipts = await page.evaluate((owner) => JSON.parse(sessionStorage.getItem('domino:session-receipts:v1:' + owner) ?? '[]'), OWNER);
    assert.equal(receipts.length, 1, 'one session receipt');
    const [kept] = receipts;
    assert.deepEqual([kept.chainId, kept.action, kept.dex, kept.wallet, kept.fee], [4663, 'create', 4, OWNER, { token: USDG_RH, amount: '3250000' }]);
    assert.ok(Number.isSafeInteger(kept.at) && kept.at > 0, 'the block\'s time, from the header the money client read');
    const hints = await page.evaluate((owner) => JSON.parse(sessionStorage.getItem('domino:created-positions:v1:' + owner) ?? '[]'), OWNER);
    assert.deepEqual(hints.map((hint) => [hint.chainId, hint.tokenId, hint.hash]), [[4663, kept.tokenId, kept.hash]], 'Robinhood Chain\'s hint, of the same receipt');
    await page.evaluate(() => { location.hash = '#/positions/receipts'; });
    const row = page.locator(`[data-v2-receipt="session:4663:${kept.hash}"]`);
    await row.waitFor({ timeout: 10_000 });
    assert.match(await row.locator('summary').innerText(), new RegExp(`^Created position #${kept.tokenId}`));
    assert.equal(await row.locator('summary .dm-receipt-check[aria-label="Confirmed"]').count(), 1);
    assert.equal(await row.locator('summary time').count(), 1, 'its block\'s time');
    await page.evaluate(() => { location.hash = '#/positions'; });
    await page.locator(`a[data-v2-position-row="4663:${kept.positionManager}:${kept.tokenId}"]`).waitFor({ timeout: 10_000 });
    assert.equal(chain.sends.length, 2, 'nothing more was sent');
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

for (const unavailable of ['closed gate', 'preview gate', 'missing V2 chunk']) {
  test(`the owner's Review with a ${unavailable} never opens the retired creation path`, async () => {
    const chain = createV2Chain({ chainId: 4663, timestamp: now(), balances: { [USDG_RH]: 5_000_000_000n }, pools: [{ pool: POOL_RH, sqrtPriceX96: SQRT, tick: TICK, liquidity: 10n ** 16n }] });
    chain.switchTo(4663);
    const read = createReadStub({ answer: robinhoodRead });
    const retired = [];
    const missing = unavailable === 'missing V2 chunk';
    const s = await openJourney(browser, chain, {
      dist: WALLET_V2_DIST, originOpen: unavailable !== 'closed gate',
      ...(missing ? { live: [4663], contracts: { 4663: contractsFor(4663) }, planner: robinhoodPlanner() } : {}),
      routes: [(request, url) => {
        if (url.pathname.startsWith('/api/setup/v1/')) retired.push(url.pathname);
        return read.handle(request, url) ?? undefined;
      }], artwork: true,
    });
    try {
      let blocked = 0;
      if (missing) await s.context.route(/\/assets\/JourneyCreateV2-[^/]+\.js$/, route => { blocked += 1; return route.abort('failed'); });
      const page = s.page;
      const current = step => page.locator(`li[data-step="${step}"][aria-current="step"]`);
      await page.getByRole('combobox', { name: 'Search a token' }).fill(USDG_RH);
      await page.locator(`[data-token-option="${USDG_RH}"]`).click();
      await page.locator('[data-picker="pool"] input[name="pool-option"]').first().click({ timeout: 30_000 });
      await pressContinue(current('pool'));
      await pressContinue(current('range'));
      await current('amount').locator('[data-pair-balance="ready"]').first().waitFor({ timeout: 30_000 });
      await current('amount').locator('[data-pair-side="1"] input').fill('1000');
      await pressContinue(current('amount'));
      const footer = current('review').locator('[data-journey-footer]');
      const reason = footer.locator('#create-reason');
      await reason.waitFor({ timeout: 30_000 });
      assert.equal(await footer.locator('[data-create-position]').isDisabled(), true);
      assert.equal(await page.locator('[data-create-position="idle"]').count(), 0);
      if (missing) {
        assert.ok(blocked > 0, 'the V2 creation module actually failed to load');
        assert.equal(await reason.innerText(), 'The wallet steps could not load. Reload the page to try again.');
      } else assert.equal(await reason.innerText(), 'New positions on Robinhood Chain aren’t open right now.');
      assert.deepEqual(retired, [], 'no retired setup endpoint is read');
      assert.equal(chain.sends.length, 0, 'no transaction is sent');
      assert.equal(chain.signed.length, 0, 'no signature is requested');
      assert.equal(s.planned.length, 0, 'no plan is requested without the live V2 module and gate');
    } finally { await s.close(); }
  });
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
    await page.locator('[data-picker="pool"] input[name="pool-option"]').first().waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('li[data-step="pool"]').getByRole('combobox', { name: 'Search a token' }).isVisible(), true, 'the labelled field guides the step without a repeated subtitle');
    await page.screenshot({ path: join(shots(), 'journey-owner-step1-pools.png'), fullPage: true, animations: 'disabled' });
    await page.locator('[data-picker="pool"] input[name="pool-option"]').first().click({ timeout: 30_000 });
    await page.locator('[data-chosen-pool]').waitFor();
    // Changed on purpose 2026-10-06 (the owner's point 4): the chosen pool's fee chip carries no "Verified at block" tooltip.
    // Changed on purpose 2026-10-30 (QA round 2, Q28): its one title says what the fee is, as every fee chip does.
    assert.deepEqual(await page.locator('[data-chosen-pool] .dm-chip[title]').evaluateAll((chips) => chips.map((chip) => chip.getAttribute('title'))), ['Traders pay this on every swap. People who add money to the pool, you included, share it. It is never taken from your deposit.']);
    await page.screenshot({ path: join(shots(), 'journey-owner-step1-pool.png'), fullPage: true, animations: 'disabled' });
    const current = (step) => page.locator(`li[data-step="${step}"][aria-current="step"]`);
    await pressContinue(current('pool'));
    await current('range').waitFor();
    assert.equal(await page.locator('aside[data-preview]').count(), 1, 'his preview beside the steps');
    await page.screenshot({ path: join(shots(), 'journey-owner-step2-range.png'), fullPage: true, animations: 'disabled' });
    await pressContinue(current('range'));
    await current('amount').waitFor();
    await page.locator('li[data-step="amount"] [data-pair-balance="ready"]').first().waitFor({ timeout: 30_000 });
    assert.ok(await page.locator('li[data-step="amount"] [data-pair-max]').count() >= 1, 'his wallet balances with Max');
    assert.equal(await page.locator('li[data-step="amount"] .dm-flow-balance-line[title]').count(), 0, 'no tooltip on the balance');
    const field = 'li[data-step="amount"][aria-current="step"] [data-pair-side="1"] input[inputmode="decimal"]';
    await page.locator(field).fill('1000');
    await page.screenshot({ path: join(shots(), 'journey-owner-step3-amount.png'), fullPage: true, animations: 'disabled' });
    await pressContinue(current('amount'));
    // Review: the plan for what his journey chose, then Create position on the new contracts.
    const review = page.locator('[data-stage-card="review"] [data-zap-review="live"][data-zap-review-stage="reviewed"]');
    await review.waitFor({ timeout: 30_000 });
    assert.equal(s.planned.length, 1, 'one plan');
    assert.equal(s.planned[0].action, 'create');
    // Changed on purpose 2026-10-06 (the owner's point 4): his Review on V2 says the fee and the network fee once each.
    await review.locator('[data-wallet-step="approve"][data-step-status="ready"]').waitFor({ timeout: 30_000 });
    assert.equal(await review.locator('[data-review-fee="charged"]').innerText(), 'Domino fee: 3.25 USDG (0.65% of 500 USDG swapped)');
    await review.locator('[data-review-network-fee="about"]').waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('[data-stage-card="review"] [data-review-details]').getAttribute('open'), null);
    await page.screenshot({ path: join(shots(), 'journey-owner-step4-review.png'), fullPage: true, animations: 'disabled' });
    // At a phone's width: the same lines, no sideways scroll.
    await page.setViewportSize({ width: 390, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no horizontal scroll at 390');
    await page.locator('[data-stage-card="review"]').screenshot({ path: join(shots(), 'journey-owner-step4-review-phone.png'), animations: 'disabled' });
    await page.setViewportSize({ width: 1280, height: 1000 });
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
    // Added 2026-10-06 (the final check's F1/F6): Back rests under his created view. A done step reopened leaves it (a second
    // position from the same choices), and Back is there again, as with today's Create position: it stayed hidden there,
    // and in every flow after it, for the rest of the visit.
    assert.equal(await backOf(page).isHidden(), true, 'Back rests once the position exists');
    await press(page.locator('li[data-step="amount"] button.dm-flow-row'));
    await current('amount').waitFor();
    assert.equal(await backOf(page).isVisible(), true, 'Back again on the step reopened');
    assert.equal(await page.locator('[data-created-position]').count(), 0);
  } finally { await s.close(); }
});

/**
 * position-plan-v1 for his ETH/USDG create, each answer held until the test lets it go (`held`), made at that moment
 * with `ages[i]` seconds of its 180-second life already gone.
 */
function heldPlanner({ answers, held, ages }) {
  return (wire) => {
    if (wire.action !== 'create') return undefined;
    return new Promise((resolve) => held.push(() => {
      const legs = [{ tokenIn: USDG_RH, tokenOut: ZERO, amountIn: 500_000_000n, expectedOut: 190_000_000_000_000_000n, data: v4Path(POOL_RH) }];
      const body = planAnswer(wire, { owner: OWNER, zap: ZAP_V4, now: now() - (ages[answers.length] ?? 0), pool: { sqrtPriceX96: SQRT, tick: TICK }, legs, nonce: { word: 9, bit: answers.length }, expected: { amounts: [190_000_000_000_000_000n, 490_000_000n], returned: [{ token: USDG_RH, amountRaw: '6750000' }] } });
      answers.push(body);
      resolve(body);
    }));
  };
}

// Added 2026-10-06 (the owner's point 4: "a small visual cue of what is happening", and "Getting a quote…" said once, not
// three times): while his Review's plan is asked, the amounts are the page's resting bubble and the one line under Create
// position says so; when the same choices are quoted again (this quote ran out before Create position was pressed,
// decision #3), the last review stays on screen, greyed and busy, until the new one replaces it: never a blank.
test('(m) his Review while a quote is asked: a resting bubble and one "Getting a quote…"; asked again for the same choices, the last review stays, greyed', async () => {
  const chain = createV2Chain({ chainId: 4663, timestamp: now(), balances: { [USDG_RH]: 5_000_000_000n }, pools: [{ pool: POOL_RH, sqrtPriceX96: SQRT, tick: TICK, liquidity: 10n ** 16n }] });
  chain.switchTo(4663);
  const read = createReadStub({ answer: robinhoodRead });
  const answers = [];
  const held = [];
  // The first answer is good for 10 s more once it is let go; the second for its whole 3 minutes.
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [4663], contracts: { 4663: contractsFor(4663) }, planner: heldPlanner({ answers, held, ages: [170, 0] }),
    routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true,
  });
  const asked = async (count) => { for (let i = 0; i < 300 && held.length < count; i += 1) await new Promise((done) => setTimeout(done, 100)); assert.equal(held.length, count, 'the plan was asked'); };
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    await page.getByRole('combobox', { name: 'Search a token' }).fill(USDG_RH);
    await page.locator(`[data-token-option="${USDG_RH}"]`).click();
    await page.locator('[data-picker="pool"] input[name="pool-option"]').first().click({ timeout: 30_000 });
    await page.locator('[data-chosen-pool]').waitFor();
    const current = (step) => page.locator(`li[data-step="${step}"][aria-current="step"]`);
    await pressContinue(current('pool'));
    await current('range').waitFor();
    await pressContinue(current('range'));
    await current('amount').waitFor();
    await page.locator('li[data-step="amount"] [data-pair-balance="ready"]').first().waitFor({ timeout: 30_000 });
    await page.locator('li[data-step="amount"][aria-current="step"] [data-pair-side="1"] input[inputmode="decimal"]').fill('1000');
    await pressContinue(current('amount'));
    // The first quote under way: the resting bubble where the amounts go, the headline busy, and one sentence.
    const review = page.locator('[data-stage-card="review"] [data-zap-review="live"]');
    await asked(1);
    await review.locator('[data-review-amounts] .dm-skel').waitFor({ timeout: 30_000 });
    assert.equal(await review.getAttribute('data-zap-review-stage'), 'quoting');
    assert.equal(await review.locator('[data-review-headline]').getAttribute('aria-busy'), 'true');
    assert.equal(await page.getByText(/Getting a (fresh )?quote…/).count(), 1, '"Getting a quote…" said once');
    assert.equal(await page.locator('#create-reason').innerText(), 'Getting a quote…', 'under Create position');
    assert.equal(await review.locator('[data-wallet-steps]').count(), 0, 'no empty list of steps meanwhile');
    await page.screenshot({ path: join(shots(), 'journey-owner-quoting.png'), fullPage: true });
    held.shift()();
    const reviewed = page.locator('[data-stage-card="review"] [data-zap-review="live"][data-zap-review-stage="reviewed"]');
    await reviewed.locator('[data-review-network-fee="about"]').waitFor({ timeout: 30_000 });
    const before = await reviewed.locator('[data-review-amounts]').innerText();
    assert.equal(before, 'About 0.19 ETH + 490 USDG');
    // Near expiry the idle review refreshes itself, without a wallet click or any transaction.
    await asked(1);
    const stale = page.locator('[data-stage-card="review"] [data-zap-review="live"][data-zap-review-stage="quoting"][data-review-stale]');
    await stale.waitFor({ timeout: 30_000 });
    assert.equal(await stale.locator('[data-review-amounts]').innerText(), before, 'the last figures stay on screen');
    assert.equal(await stale.locator('[data-review-headline]').getAttribute('aria-busy'), 'true', 'greyed and busy');
    assert.equal(await stale.locator('[data-review-fee="charged"]').innerText(), 'Domino fee: 3.25 USDG (0.65% of 500 USDG swapped)');
    assert.deepEqual(await stale.locator('.dm-flow-wstep-title').allInnerTexts(), ['Allow 1,000 USDG', 'Create the position'], 'its steps too, by their titles');
    assert.equal(await stale.locator('[data-wallet-steps][aria-busy="true"]').count(), 1);
    assert.equal(await stale.locator('[data-wallet-step][data-step-state="done"]').count(), 0, 'nothing on chain yet: no check');
    // Changed on purpose 2026-10-06 (the review of point 4): one neutral sentence; this quote only ran out.
    assert.equal(await page.locator('#create-reason').innerText(), 'Getting a fresh quote…');
    assert.equal(await page.getByText(/Getting a (fresh )?quote…/).count(), 1, 'said once');
    assert.equal(await page.locator('[data-create-position]').isDisabled(), true, 'nothing to confirm until the new quote is in');
    await page.screenshot({ path: join(shots(), 'journey-owner-requoting.png'), fullPage: true });
    held.shift()();
    await reviewed.locator('[data-review-network-fee="about"]').waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('[data-review-stale]').count(), 0, 'the new review replaced it');
    assert.equal(s.planned.length, 2);
    assert.equal(chain.sends.length, 0, 'nothing was sent: the quote ran out first');
  } finally { await s.close(); }
});

// Added 2026-10-05 (the owner: "the search on the screen, across the three networks; the results get the network's tag",
// and creating there through Domino V2): his journey on Base, from his search to his created position.
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const POOL_BASE = { dex: 4, currency0: ZERO, currency1: USDC_BASE, fee: 500, tickSpacing: 10, hooks: ZERO };
const TICK_BASE = -198080;
const SQRT_BASE = position.sqrtPriceAtTick(TICK_BASE);
const BASE_V4_PM = require('../../../api-contracts/v2/chains/base-8453.json').uniswap.v4.positionManager.toLowerCase();

/**
 * read-v6 about the wallet on Base, for the position's page New position's success opens (2026-10-06): nothing until the
 * new position is listed (`made` null), then the position, listed as not read yet (as the index first lists one an S1
 * action named) until `made.read`.
 */
const basePortfolio = (made) => portfolioOf({
  wallet: OWNER,
  tokens: [indexedToken(8453, ZERO, 'ETH', 18), indexedToken(8453, USDC_BASE, 'USDC', 6)],
  positions: made ? [{
    ...livePosition({ chainId: 8453, manager: BASE_V4_PM, tokenId: made.tokenId, owner: OWNER, pool: POOL_BASE, tickLower: made.tickLower, tickUpper: made.tickUpper, liquidity: 10n ** 15n, sqrtPriceX96: SQRT_BASE, tick: TICK_BASE }),
    ...(made.read ? {} : { state: { status: 'not_read' } }),
  }] : [],
});

/** position-plan-v1 as it would answer a create on Base: 500 USDC swapped for ETH when the wallet pays USDC. */
function basePlanner(answers = [], { l1Unavailable = false } = {}) {
  return (wire) => {
    if (wire.action !== 'create' || wire.chainId !== 8453) return undefined;
    const pays = wire.inputs.some((input) => input.token === USDC_BASE);
    const legs = pays ? [{ tokenIn: USDC_BASE, tokenOut: ZERO, amountIn: 500_000_000n, expectedOut: 190_000_000_000_000_000n, data: v4Path(POOL_BASE) }] : [];
    // `l1Unavailable` (2026-10-06): the oracle did not answer, so the plan's L1 data fee is unavailable (spec §2.4: never 0).
    const l1 = l1Unavailable ? { l1DataFee: { status: 'unavailable', source: 'op_gas_price_oracle', block: null, weiRaw: null, upperBoundWeiRaw: null, l1GasUnits: null, l2BaseFeeWei: null, transactionBytes: null } } : {};
    const body = planAnswer(wire, { owner: OWNER, zap: ZAP_V4, now: now(), pool: { sqrtPriceX96: SQRT_BASE, tick: TICK_BASE }, legs, nonce: { word: 9, bit: answers.length }, expected: { amounts: [190_000_000_000_000_000n, 490_000_000n], returned: [{ token: USDC_BASE, amountRaw: '6750000' }] }, ...l1 });
    answers.push(body);
    return body;
  };
}

/**
 * Added 2026-10-15 (pack 8, incident C5): how far the clock leaps to reach the one read at finality of a Base action.
 * read-v6 names no finalized mark past the block here (`finalizedThrough` one below it), so the chain's age says when
 * (src/config/receiptSources.ts: twenty minutes on Base), and a read that found it not final yet is made again a minute
 * later at least. On ffbd80ab the created view followed its receipt through the wallet every 5 s, then 15 s, then 30 s,
 * and each step below was met within 30 s of real time; now nothing is read between inclusion and that read.
 */
const FINALITY_LEAP_MS = 21 * 60_000;
const receiptReads = (chain) => chain.log.filter((method) => method === 'eth_getTransactionReceipt').length;
/** Ten minutes after inclusion, with every timer due in them fired once: nothing reads the receipt yet (ffbd80ab's follow did). */
async function quietTenMinutes(page, chain, included) {
  await page.clock.fastForward(10 * 60_000);
  await page.waitForTimeout(1_500);
  assert.equal(receiptReads(chain), included, 'no wallet read between inclusion and finality');
}

for (const outcome of ['reincluded', 'reverted', 'navigation', 'atomic-navigation', 'atomic-reorg', 'atomic-not-included', 'atomic-batch-reverted']) test(`(e) his journey on Base: search, create and verified ${outcome}`, async () => {
  const atomic = outcome.startsWith('atomic');
  const chain = createV2Chain({ chainId: 8453, timestamp: now(), ...(atomic ? { atomic: 'supported', simulateV1: true } : {}), balances: { [USDC_BASE]: 5_000_000_000n }, pools: [{ pool: POOL_BASE, sqrtPriceX96: SQRT_BASE, tick: TICK_BASE, liquidity: 10n ** 18n }] });
  // The wallet starts on Robinhood Chain, as the site's own network.
  chain.switchTo(4663);
  const read = createReadStub({ answer: robinhoodRead });
  const answers = [];
  // read-v6 about the wallet (2026-10-06): the new position listed some seconds after it is made; each answer kept.
  let made = null;
  let receiptStage = 'included', inclusion = null, reorganized = false;
  const activityItems = [];
  const replacementHash = `0x${'cd'.repeat(32)}`;
  const served = [];
  const baseMark = (reply) => {
    const base = reply.body.chains.find(item => item.chainId === 8453);
    if (base?.finalizedThrough) base.finalizedThrough.number = receiptStage === 'finalized' && inclusion ? inclusion.block : 1;
    return reply;
  };
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [8453], contracts: { 8453: contractsFor(8453) }, planner: basePlanner(answers), refresh: true, clock: true,
    intercept: async (method, params) => {
      if (method === 'eth_getBlockByNumber' && params[0] === 'finalized' && receiptStage !== 'finalized') return { result: { number: '0x1', hash: replacementHash } };
      if (atomic && receiptStage === 'reorged' && method === 'eth_getLogs') return { result: [] };
      if (atomic && method === 'wallet_getCallsStatus' && ['not-included', 'batch-reverted'].includes(receiptStage)) {
        const answer = await chain.request(method, params);
        return { result: { ...answer.result, status: receiptStage === 'not-included' ? 400 : 500 } };
      }
      if (reorganized && inclusion && method === 'eth_getBlockByNumber' && params[0] === `0x${inclusion.block.toString(16)}` && receiptStage !== 'included') {
        const answer = await chain.request(method, params);
        return { result: { ...answer.result, hash: replacementHash } };
      }
      if (reorganized && inclusion && method === 'eth_getTransactionReceipt' && params[0] === inclusion.hash && ['reincluded', 'finalized', 'reverted'].includes(receiptStage)) {
        const answer = await chain.request(method, params);
        return { result: { ...answer.result, blockHash: replacementHash, ...(receiptStage === 'reverted' ? { status: '0x0', logs: [] } : {}) } };
      }
      return undefined;
    },
    routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true,
    // Changed on purpose 2026-10-15 (pack 8, incident C5): read-v6's finalized mark for Base agrees with the wallet's own
    // finalized block in every answer (below the action's block until the stage is 'finalized'): the mark is the queue's
    // hint for its one read at finality on every chain now, and the fixtures' own mark (block 73,395,500) said final.
    read6: { portfolio: () => { served.push(made); return baseMark(basePortfolio(made)); }, activity: () => {
      const reply = activityOf({ wallet: OWNER }); reply.body.items = activityItems;
      return baseMark(reply);
    } },
  });
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    assert.equal(await page.locator('[data-zap-journey]').count(), 0, 'his journey, never the zap path\'s screens');
    await page.getByRole('combobox', { name: 'Search a token' }).fill('USDC');
    // Read-only discovery includes Arbitrum One even while its creation gate is not live.
    const hit = page.locator(`[data-token-network-option="8453:${USDC_BASE}"]`);
    await hit.waitFor();
    assert.equal((await hit.locator('[data-chain-chip="8453"]').innerText()).trim(), 'Base');
    assert.equal(await page.locator('[data-token-network-option^="42161:"]').count(), 1);
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
    // Added 2026-10-06 (rugged97's delta of 6 Oct §4: "Sem par: '—' com o motivo"): DEX Screener answered for USDC with no
    // pair for this pool, so its TVL, 24h volume and APR are dashes saying so, in their titles and as each dash's name.
    const unlisted = pools.locator(`li[data-pool-key="${poolIdOf(POOL_BASE)}"]`);
    await unlisted.locator('[data-provider-reason="dexscreener_no_pair"]').nth(1).waitFor();
    assert.deepEqual(await unlisted.locator('[data-provider-figure]').evaluateAll((cells) => cells.map((cell) => [cell.innerText.replace(/\s+/g, ' ').trim(), cell.getAttribute('title'), cell.querySelector('[aria-label]')?.getAttribute('aria-label') ?? null])), [
      ['TVL —', 'DEX Screener doesn’t list this pool.', 'DEX Screener doesn’t list this pool.'],
      ['24h volume —', 'DEX Screener doesn’t list this pool.', 'DEX Screener doesn’t list this pool.'],
    ]);
    assert.equal(await unlisted.locator('[data-row-apr="none"] [title]').getAttribute('title'), 'DEX Screener doesn’t list this pool.');
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
    // Added 2026-10-06 (the owner's point 4): on Base the one network fee line counts the plan's L1 data fee; its ceiling
    // (the oracle's upper bound) and the L1 data fee itself are under Details (spec §2.4).
    const networkFee = review.locator(`[data-review-network-fee="${atomic ? 'upTo' : 'about'}"]`);
    await networkFee.waitFor({ timeout: 30_000 });
    assert.match(await networkFee.innerText(), atomic ? /^Network fee: up to [\d.]+ ETH(?: \((?:<\$0\.01|\$[\d,]+(?:\.\d+)?)\))?$/ : /^Network fee: about [\d.]+ ETH(?: \((?:<\$0\.01|\$[\d,]+(?:\.\d+)?)\))?$/);
    assert.equal(await networkFee.getAttribute('data-review-l1-fee'), '10345963635');
    const details = review.locator('[data-review-details]');
    await details.locator('summary').click();
    // Changed on purpose 2026-10-06 (the review of point 4): the ceiling under a label of its own, never a second "Network
    // fee" beside the one in view, and with the same approval counted, so never below that line's figure.
    if (!atomic) {
      const ceiling = await details.locator('[data-fact="review-network-fee"]').innerText();
      assert.match(ceiling, /^Network fee, at most\s+[\d.]+ ETH$/);
      assert.ok(Number(ceiling.match(/([\d.]+) ETH$/)[1]) >= Number((await networkFee.innerText()).match(/about ([\d.]+) ETH/)[1]), 'the ceiling is never below the figure in view');
    } else assert.equal(await details.locator('[data-fact="review-network-fee"]').count(), 0, 'the batch ceiling is already the visible fee line');
    assert.match(await details.locator('[data-fact="review-l1-fee"]').innerText(), /^L1 data fee\s+0\.00000002 ETH$/, '10,345,963,635 wei, rounded up at 8 decimals');
    assert.equal(await page.locator('[data-create-position="idle"]').count(), 0, 'not Domino V1\'s Create position');
    await page.locator('[data-create-position="live"]:not([disabled])').click({ timeout: 30_000 });
    await page.locator('[data-created-position][data-zap-receipt]').waitFor({ timeout: 60_000 });
    const [approve, createTx] = atomic ? chain.batches[0].calls : chain.sends.map((entry) => entry.tx);
    assert.equal(approve.to, USDC_BASE, 'the exact approval, on Base');
    assert.equal(decodeFunctionData({ abi: ERC20, data: approve.data }).args[0].toLowerCase(), ZAP_V4);
    assert.equal(createTx.to, ZAP_V4, 'the create on Base\'s zap');
    if (atomic) assert.deepEqual([chain.batches.length, chain.chainNow()], [1, 8453], 'one atomic confirmation on Base');
    else assert.deepEqual([approve.chainId, createTx.chainId], ['0x2105', '0x2105']);
    assert.equal(createTx.data, answers.at(-1).plan.call.data, 'the call data the plan carried');
    // The created view is the zap path's (its receipt, its link on Base), never today's Robinhood Chain lists.
    assert.match(await page.locator('a[data-created-next="position"]').getAttribute('href'), /^#\/positions\/base-v4-\d+$/);
    for (const mode of ['compound', 'domino']) {
      const setup = page.locator(`a[data-created-next="${mode}"]`);
      await setup.waitFor();
      assert.match(await setup.getAttribute('href'), new RegExp(`^#/sequence/${mode}/base-v4-\\d+$`), 'each automation keeps the new NFT’s network and protocol');
      assert.match(await setup.innerText(), mode === 'compound' ? /2%/ : /4%/, 'fees remain visible before choosing setup');
    }
    const createdId = await page.locator('[data-created-position]').getAttribute('data-created-position');
    const hints = await page.evaluate(owner => JSON.parse(sessionStorage.getItem('domino:created-positions:v1:' + owner) ?? '[]'), OWNER);
    const hint = hints.find(item => item.tokenId === createdId);
    assert.ok(hint, 'the successful receipt preserves only a discovery hint before the index lists the NFT');
    assert.deepEqual([hint.chainId, hint.dex, hint.positionManager], [8453, 4, BASE_V4_PM]);
    assert.deepEqual(hint.tokens.map(({ address, symbol, decimals }) => [address, symbol, decimals]), [[ZERO, 'ETH', 18], [USDC_BASE, 'USDC', 6]]);
    assert.equal('state' in hint, false, 'a receipt hint cannot provide financial eligibility or invented live state');
    inclusion = hint;
    const sendCount = chain.sends.length, planCount = s.planned.length;
    // Added 2026-10-15 (pack 8, incident C5): from here no receipt is read through the wallet until the one read at
    // finality (the follow of ffbd80ab read it every 5 s, then 15 s, then 30 s, for the twenty minutes Base takes).
    const included = receiptReads(chain);
    if (outcome.endsWith('navigation')) {
      const item = s1Action({ chainId: 8453, wallet: OWNER, zap: ZAP_V4, tokenId: createdId, block: hint.block, pool: POOL_BASE, finalized: false });
      item.tx.hash = hint.hash; item.tx.snapshot.hash = hint.blockHash; item.tx.snapshot.timestamp = now();
      activityItems.push(item);
      made = { tokenId: createdId, tickLower: s.planned.at(-1).tickLower, tickUpper: s.planned.at(-1).tickUpper, read: true };
      await page.locator('a[data-created-next="position"]').click();
      await page.locator(`[data-position-detail][data-position-id="${createdId}"]`).waitFor({ timeout: 30_000 });
      const row = page.locator(`[data-position-activity-item="${item.id}"]`);
      // Rewritten on purpose 2026-10-14 (incident C1; the owner's decision D0): this case held the defect, it waited for
      // the pill "Confirming" on a receipt already in a block. Such a receipt carries the check at once and is "not final
      // yet" only as a fact (data-v2-finality); the proof below still settles that fact without returning to creation.
      await row.locator('summary .dm-receipt-check[aria-label="Confirmed"]').waitFor({ timeout: 30_000 });
      assert.equal(await row.getAttribute('data-v2-finality'), 'included', 'confirmed at inclusion, not final yet');
      assert.equal(await row.locator('text=Confirming').count(), 0, 'no pill for a receipt that is in a block');
      assert.equal(await page.locator('[data-create-journey]').count(), 0, 'the original receipt view is unmounted');
      await quietTenMinutes(page, chain, included);
      receiptStage = 'finalized';
      await page.clock.fastForward(FINALITY_LEAP_MS);
      await page.locator(`[data-position-activity-item="${item.id}"][data-v2-finality="finalized"]`).waitFor({ timeout: 30_000 });
      assert.ok(receiptReads(chain) - included <= 1, 'one receipt read through the wallet, at finality');
      assert.equal(await row.locator('summary .dm-receipt-check[aria-label="Confirmed"]').count(), 1, 'the shared exact receipt proof settles Activity without returning to creation');
      assert.equal(await row.locator('text=Confirming').count(), 0);
      assert.equal(item.tx.finality, 'unfinalized', 'the lagging index did not supply this finality');
      assert.equal(chain.sends.length, sendCount); assert.equal(s.planned.length, planCount);
      assert.deepEqual(chain.offChain, []);
      return;
    }
    reorganized = true;
    receiptStage = 'reorged';
    // Changed on purpose 2026-10-15 (pack 8, incident C5): the block that left the chain is caught at the one read at
    // finality (the follow of ffbd80ab caught it within 5 s, reading every 5 s until final).
    await quietTenMinutes(page, chain, included);
    await page.clock.fastForward(FINALITY_LEAP_MS);
    await page.locator('[data-zap-receipt="pending"]').waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('a[data-created-next]').count(), 0, 'orphaned effects cannot offer position or automation actions');
    assert.deepEqual(await page.evaluate(owner => JSON.parse(sessionStorage.getItem('domino:created-positions:v1:' + owner) ?? '[]'), OWNER), [], 'explicit canonical contradiction removes the creation hint');
    receiptStage = atomic ? outcome === 'atomic-reorg' ? 'reincluded' : outcome.slice(7) : outcome;
    if (['not-included', 'batch-reverted'].includes(receiptStage)) {
      const failedReceipt = page.locator('[data-zap-receipt="not-included"]');
      await failedReceipt.waitFor({ timeout: 30_000 });
      assert.match(await failedReceipt.innerText(), /The wallet batch did not complete\. No position was created\./);
      assert.equal(await page.locator('a[data-created-next]').count(), 0);
      assert.equal(chain.sends.length, sendCount); assert.equal(s.planned.length, planCount);
      assert.deepEqual(await page.evaluate(owner => JSON.parse(sessionStorage.getItem('domino:created-positions:v1:' + owner) ?? '[]'), OWNER), []);
      return;
    }
    if (outcome === 'reverted') {
      const failedReceipt = page.locator('[data-zap-receipt="reverted"]');
      await failedReceipt.waitFor({ timeout: 30_000 });
      assert.match(await failedReceipt.innerText(), /The transaction reverted\. No position was created\./);
      assert.equal(await page.locator('a[data-created-next]').count(), 0);
      assert.equal(chain.sends.length, sendCount, 'a reverted reinclusion never resends the action');
      assert.equal(s.planned.length, planCount, 'the sent review is never silently requoted');
      assert.deepEqual(await page.evaluate(owner => JSON.parse(sessionStorage.getItem('domino:created-positions:v1:' + owner) ?? '[]'), OWNER), []);
      return;
    }
    await page.locator('[data-zap-receipt="included"]').waitFor({ timeout: 30_000 });
    // Added 2026-10-14 (incident C1; the owner's decision D0): in a block with success is "Confirmed" (it was "Included"),
    // and the word stays when the block is final (it turned "Finalized"): finality is a line in Receipts' details.
    assert.equal(await page.locator('[data-fact="receipt-state"][data-receipt-state="included"] dd').innerText(), 'Confirmed');
    const restored = await page.evaluate(owner => JSON.parse(sessionStorage.getItem('domino:created-positions:v1:' + owner) ?? '[]'), OWNER);
    assert.deepEqual([restored[0].tokenId, restored[0].blockHash], [createdId, replacementHash], 'a checked reinclusion restores only the new block evidence');
    receiptStage = 'finalized';
    // C5: the block found again is the queue's; its read at finality comes at once (the action is old enough), or a
    // minute after one that found it not final yet.
    await page.clock.fastForward(FINALITY_LEAP_MS);
    await page.locator('[data-zap-receipt="finalized"]').waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('[data-fact="receipt-state"][data-receipt-state="finalized"] dd').innerText(), 'Confirmed');
    assert.equal(chain.sends.length, sendCount, 'reorg and finality checks never resend the action');
    assert.equal(s.planned.length, planCount, 'the sent review is never silently requoted');
    // Added 2026-10-06 (the final check's F1/F6): Back rests under it, as on Robinhood Chain (test (t) follows it further).
    assert.equal(await backOf(page).isHidden(), true, 'Back rests once the position exists');
    // Added 2026-10-06 (the review of point 5): Auto-exit offered there too, on Base (a range around the price: not
    // "Recommended"); test (e2) follows its link.
    const exit = page.locator('a[data-created-next="autoexit"]');
    await exit.waitFor({ timeout: 30_000 });
    assert.match(await exit.getAttribute('href'), /^#\/positions\/base-v4-\d+$/);
    assert.equal(await exit.getAttribute('data-created-recommended'), null);
    // Added 2026-10-06 (the review of point 5, a second look): the position's link opens its page at once, before read-v6
    // lists it (the index runs behind the chain). The page waits on its loading frame and reads the list again meanwhile,
    // never saying the position isn't listed; this link asks for no dialog.
    const tokenId = await page.locator('[data-created-position]').getAttribute('data-created-position');
    await watchEmpty(page);
    const before = served.length;
    await page.locator('a[data-created-next="position"]').click();
    await page.locator('[data-position-reason="awaiting_index"]').waitFor({ timeout: 30_000 });
    await until(() => served.length >= before + 2, 'the wallet’s list read again');
    made = { tokenId, tickLower: s.planned.at(-1).tickLower, tickUpper: s.planned.at(-1).tickUpper, read: true };
    await page.locator(`[data-position-detail][data-position-id="${tokenId}"]`).waitFor({ timeout: 30_000 });
    assert.equal(await page.evaluate(() => window.__positionEmpty), false, 'never "This position isn’t in your wallet’s list."');
    assert.equal(await page.locator('[data-v2in-dialog="mandate"]').count(), 0, 'no dialog asked for by this link');
  } finally { await s.close(); }
});

// Added 2026-10-06 (the review of the owner's point 5; rugged97: "someone makes an LP to buy or sell; when the price hits
// the edge of the range we close the position automatically"): a sell range above today's price on Base. The success
// recommends Auto-exit, and its link opens the position's own page, where Auto-exit's dialog opens by itself once the page
// offers it (lib/automate/autoExitAsk.ts: within two minutes). Changed on purpose 2026-10-06 (the review, a second look):
// read-v6 lists the new position only some seconds after the link is clicked, first as not read yet, as its index runs
// behind the chain; the page waits for it meanwhile.
test('(e2) his journey on Base, a range above the price: the success recommends Auto-exit, and its link opens the position’s page with Auto-exit’s dialog', async () => {
  const chain = createV2Chain({ chainId: 8453, timestamp: now(), balances: { [USDC_BASE]: 5_000_000_000n }, pools: [{ pool: POOL_BASE, sqrtPriceX96: SQRT_BASE, tick: TICK_BASE, liquidity: 10n ** 18n }] });
  chain.switchTo(4663);
  const read = createReadStub({ answer: robinhoodRead });
  // read-v6 about the wallet: nothing until the test lists the new position; each answer kept.
  let made = null;
  const served = [];
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [8453], contracts: { 8453: contractsFor(8453) }, planner: basePlanner([]), refresh: true,
    routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true,
    read6: { portfolio: () => { served.push(made); return basePortfolio(made); }, activity: () => activityOf({ wallet: OWNER }) },
  });
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    await page.getByRole('combobox', { name: 'Search a token' }).fill('USDC');
    await page.locator(`[data-token-network-option="8453:${USDC_BASE}"]`).click({ timeout: 30_000 });
    await page.locator('[data-picker="pool"][data-picker-network="8453"] input[name="pool-option"]').first().click({ timeout: 30_000 });
    await page.locator('[data-chosen-pool]').waitFor();
    const current = (step) => page.locator(`li[data-step="${step}"][aria-current="step"]`);
    await pressContinue(current('pool'));
    await current('range').waitFor();
    // A sell range: its lowest price 1.2 times today's (Custom), so it holds ETH alone and turns into USDC as ETH rises.
    const range = current('range');
    await range.locator('[data-width="custom"]').click();
    const today = Number((await range.locator('[data-pool-price-text]').innerText()).split('=')[1].replace(/[^\d.]/g, ''));
    await range.locator('#range-lower-price').fill(String(Math.round(today * 1.2)));
    await range.locator('#range-lower-price').press('Enter');
    await range.locator('[data-range-position]:not([data-range-position="inside"])').first().waitFor();
    await pressContinue(current('range'));
    await current('amount').waitFor();
    await page.locator('li[data-step="amount"] [data-pair-balance="ready"]').first().waitFor({ timeout: 30_000 });
    await page.locator('li[data-step="amount"][aria-current="step"] [data-pair-side="0"] input[inputmode="decimal"]').fill('0.1');
    await pressContinue(current('amount'));
    await page.locator('[data-stage-card="review"] [data-zap-review="live"][data-zap-review-stage="reviewed"]').waitFor({ timeout: 30_000 });
    const asked = s.planned.at(-1);
    assert.ok(asked.tickLower > TICK_BASE, 'the range sits above today’s price');
    await page.locator('[data-create-position="live"]:not([disabled])').click({ timeout: 30_000 });
    const success = page.locator('[data-created-position][data-zap-receipt]');
    await success.waitFor({ timeout: 60_000 });
    const tokenId = await success.getAttribute('data-created-position');
    // Auto-exit beside the position's link, recommended for a range beside the price.
    const exit = success.locator('a[data-created-next="autoexit"]');
    await exit.waitFor({ timeout: 30_000 });
    assert.equal(await exit.getAttribute('data-created-recommended'), '');
    assert.match(await exit.innerText(), /^Auto-exit · 0\.2% of the position’s value, only if it closes\s+Recommended\s+Closes it at the end of its range and sends the tokens to your wallet\.\s+Turn on$/);
    assert.equal(await exit.getAttribute('href'), `#/positions/base-v4-${tokenId}`);
    await success.screenshot({ path: join(shots(), 'journey-base-created-autoexit.png'), animations: 'disabled' });
    await watchEmpty(page);
    const before = served.length;
    await exit.click();
    // The position's own page, clicked at once: read-v6 does not list the position yet. The page waits on its loading
    // frame and reads the list again every few seconds; listed, then read, it is drawn.
    await page.locator('[data-position-reason="awaiting_index"]').waitFor({ timeout: 30_000 });
    await until(() => served.length >= before + 2, 'the wallet’s list read again');
    made = { tokenId, tickLower: asked.tickLower, tickUpper: asked.tickUpper, read: false };
    await until(() => served.some((one) => one !== null && !one.read), 'the position listed as not read yet');
    made = { ...made, read: true };
    await page.locator(`[data-position-detail][data-position-id="${tokenId}"]`).waitFor({ timeout: 30_000 });
    assert.equal(await page.evaluate(() => window.__positionEmpty), false, 'never "This position isn’t in your wallet’s list." nor "Not read yet"');
    // Auto-exit's dialog, opened by itself: the ask outlived the wait.
    const dialog = page.locator('[data-v2in-dialog="mandate"]');
    await dialog.waitFor({ timeout: 30_000 });
    assert.equal(await dialog.getAttribute('data-mandate-phase'), 'form');
    // A range born beside the price arms only its far end: here the top, as ETH rises through the range.
    const edges = dialog.locator('[data-mandate-edges] [data-mandate-edge]');
    await edges.first().waitFor({ timeout: 30_000 });
    assert.deepEqual(await edges.evaluateAll((items) => items.map((li) => li.getAttribute('data-mandate-trigger'))), ['above']);
    assert.equal(chain.sends.length, 1, 'the create alone: nothing else sent');
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
    // Added 2026-10-06 (the review of point 4): two tokens to allow, each a transaction of its own. Changed on purpose
    // 2026-10-06 (the review of point 4, ux #1): the second approval's fee is read at the review too (reads only), so the
    // one network fee line counts both, with nothing left out and no dash.
    const networkFee = review.locator('[data-review-network-fee="about"]');
    await networkFee.waitFor({ timeout: 30_000 });
    assert.equal(await networkFee.getAttribute('data-review-network-others'), null, 'every approval read at the review');
    assert.match(await networkFee.innerText(), /^Network fee: about [\d.]+ ETH(?: \((?:<\$0\.01|\$[\d,]+(?:\.\d+)?)\))?$/);
    assert.equal(await review.locator('[data-wallet-step="approve"]').count(), 2, 'two approvals');
    await review.locator('[data-review-headline]').screenshot({ path: join(shots(), 'journey-arbitrum-two-approvals.png'), animations: 'disabled' });
    // Changed on purpose 2026-10-06 (the review, money #3): what you put in is the very figure each "Allow" asks for, both
    // rounded up (WETH here has more than 6 decimals).
    const put = await review.locator('[data-review-inputs]').innerText();
    for (const title of await review.locator('[data-wallet-step="approve"] .dm-flow-wstep-title').allInnerTexts()) {
      const [, allowed] = title.match(/^Allow (.+?)(?: for signing)?$/) ?? [];
      assert.ok(allowed && put.includes(allowed), `${put} names ${allowed}, as "${title}" does`);
    }
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
    // Added 2026-10-06 (the final check's F1/F6): Back rests under it, as on Robinhood Chain.
    assert.equal(await backOf(page).isHidden(), true, 'Back rests once the position exists');
    // Changed on purpose 2026-10-06 (the review, money #3, a second look): the receipt's "Paid in", right under that review,
    // is the very figure its "You put in" says (both rounded up), never a second figure for one amount.
    const paid = await page.locator('[data-created-position] [data-fact="receipt-paid-in"] dd').allInnerTexts();
    assert.equal(paid.length, 2, 'what each token paid in');
    const putAfter = await review.locator('[data-review-inputs]').innerText();
    for (const figure of paid) assert.ok(putAfter.includes(figure.trim()), `${putAfter} names ${figure.trim()}, as the receipt does`);
  } finally { await s.close(); }
});

// Added 2026-10-06 (the review of point 4, ux #1, a second look): a wallet that already gave Permit2 its allowances (it
// used Uniswap before) signs once, then creates. No transaction comes before the signature, so no fee can be read at the
// review: the one network fee line says so in words, never a bare dash a touch screen cannot explain.
const PERMIT2_ARB = require('../../../api-contracts/v2/chains/arbitrum-42161.json').permit2.toLowerCase();
test('(f2) Arbitrum One with Permit2 already allowed: one signature, then the create; the network fee said in words, never a dash', async () => {
  const MAX = 2n ** 256n - 1n;
  const chain = createV2Chain({
    chainId: 42161, timestamp: now(), balances: { [WETH_ARB]: 2n * 10n ** 18n, [USDC_ARB]: 5_000_000_000n },
    allowances: [{ token: WETH_ARB, spender: PERMIT2_ARB, amount: MAX }, { token: USDC_ARB, spender: PERMIT2_ARB, amount: MAX }],
    pools: [{ pool: POOL_ARB, sqrtPriceX96: SQRT_BASE, tick: TICK_BASE, liquidity: 10n ** 18n }],
  });
  chain.switchTo(4663);
  const read = createReadStub({ answer: robinhoodRead });
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [8453, 42161], contracts: { 8453: contractsFor(8453), 42161: contractsFor(42161) }, planner: arbitrumPlanner([]),
    routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true,
  });
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    await page.getByRole('combobox', { name: 'Search a token' }).fill('WETH');
    await page.locator(`[data-token-network-option="42161:${WETH_ARB}"]`).click({ timeout: 30_000 });
    await page.locator('[data-picker="pool"][data-picker-network="42161"] input[name="pool-option"]').first().click({ timeout: 30_000 });
    await page.locator('[data-chosen-pool] [data-chain-chip="42161"]').waitFor();
    const current = (step) => page.locator(`li[data-step="${step}"][aria-current="step"]`);
    await pressContinue(current('pool'));
    await current('range').waitFor();
    await pressContinue(current('range'));
    await current('amount').waitFor();
    await page.locator('li[data-step="amount"] [data-pair-balance="ready"]').first().waitFor({ timeout: 30_000 });
    await page.locator('li[data-step="amount"][aria-current="step"] [data-pair-side="1"] input[inputmode="decimal"]').fill('250');
    await pressContinue(current('amount'));
    const review = page.locator('[data-stage-card="review"] [data-zap-review="live"][data-zap-review-stage="reviewed"]');
    await review.locator('[data-wallet-step="sign-permit"][data-step-status="ready"]').waitFor({ timeout: 30_000 });
    assert.deepEqual(await review.locator('[data-wallet-step]').evaluateAll((items) => items.map((item) => item.getAttribute('data-wallet-step'))), ['sign-permit', 'action'], 'no approval: one signature, then the create');
    const networkFee = review.locator('[data-review-network-fee]');
    assert.equal(await networkFee.getAttribute('data-review-network-fee'), 'unknown');
    assert.equal(await networkFee.innerText(), 'Network fee: your wallet shows it before you confirm');
    assert.equal(await review.locator('[data-review-headline] [data-figure="none"]').count(), 0, 'no bare dash in view');
    await review.locator('[data-review-headline]').screenshot({ path: join(shots(), 'journey-arbitrum-permit2-fee-in-words.png'), animations: 'disabled' });
    await page.locator('[data-create-position="live"]:not([disabled])').click({ timeout: 30_000 });
    await page.locator('[data-created-position][data-zap-receipt]').waitFor({ timeout: 60_000 });
    assert.deepEqual(chain.sends.map((entry) => [entry.tx.to, entry.tx.data.slice(0, 10)]), [[ZAP_V3, '0xec627dfe']], 'the create with its Permit2 signature, alone');
  } finally { await s.close(); }
});

// Added 2026-10-06 (rugged97's delta of 5 Oct, items 1-3: read-v6's chain reads): the same journey on Base, read by Domino's
// service. The search finds Base's USDC by its name, its pools and the wallet's balances come from the service with the
// wallet still on Robinhood Chain, and the wallet moves to Base only for the review and the create (spec F7 §1.3).
test('(g) his journey on Base read by Domino\'s service: found by name, pools and balances with the wallet still on Robinhood Chain, moved to Base for the review', async () => {
  const chain = createV2Chain({ chainId: 8453, timestamp: now(), balances: { [USDC_BASE]: 5_000_000_000n }, pools: [{ pool: POOL_BASE, sqrtPriceX96: SQRT_BASE, tick: TICK_BASE, liquidity: 10n ** 18n }] });
  chain.switchTo(4663);
  const reads = createChainReads({
    chainId: 8453,
    tokens: [{ address: ZERO, symbol: 'ETH', name: 'Ether', decimals: 18, sources: ['profile'] }, { address: USDC_BASE, symbol: 'USDC', name: 'USD Coin', decimals: 6, sources: ['profile', 'uniswap_default_list'] }],
    pools: [{ pool: POOL_BASE, sqrtPriceX96: SQRT_BASE, tick: TICK_BASE, liquidity: 10n ** 18n }],
    balances: { [USDC_BASE]: 5_000_000_000n },
  });
  const read = createReadStub({ answer: robinhoodRead });
  const answers = [];
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [8453], contracts: { 8453: contractsFor(8453) }, planner: basePlanner(answers),
    routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true, chainReads: reads,
  });
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    // "coin": a word of USDC's name, which the network's own currencies alone never matched.
    await page.getByRole('combobox', { name: 'Search a token' }).fill('coin');
    const hit = page.locator(`[data-token-network-option="8453:${USDC_BASE}"]`);
    await hit.waitFor({ timeout: 30_000 });
    const usdcMark = async (scope) => {
      const mark = scope.locator('img[src="/tokens/usdc.svg"]').first();
      await mark.waitFor();
      assert.equal(await mark.evaluate(async image => { await image.decode(); return image.naturalWidth > 0; }), true, 'USDC uses its actual bundled logo');
    };
    await usdcMark(hit);
    assert.equal((await hit.locator('[data-chain-chip="8453"]').innerText()).trim(), 'Base');
    assert.ok(reads.calls.some((call) => call.route === 'chain-tokens' && call.request.chainId === 8453 && call.request.query === 'coin'), 'Base searched by Domino\'s service');
    await hit.click();
    const pools = page.locator('[data-picker="pool"][data-picker-network="8453"]');
    await pools.locator('input[name="pool-option"]').first().waitFor({ timeout: 30_000 });
    await usdcMark(pools);
    assert.equal(await pools.locator(`li[data-pool-key="${poolIdOf(POOL_BASE)}"]`).count(), 1, 'Base\'s pool, from the service');
    assert.equal(chain.chainNow(), 4663, 'the wallet stays on Robinhood Chain for the pools');
    assert.equal(chain.multicalls.length, 0, 'nothing read through the wallet');
    await pools.locator('input[name="pool-option"]').first().click();
    await page.locator('[data-chosen-pool]').waitFor();
    await usdcMark(page.locator('[data-chosen-pool]'));
    const current = (step) => page.locator(`li[data-step="${step}"][aria-current="step"]`);
    await pressContinue(current('pool'));
    await current('range').waitFor();
    await pressContinue(current('range'));
    await current('amount').waitFor();
    await page.locator('li[data-step="amount"] [data-pair-balance="ready"]').first().waitFor({ timeout: 30_000 });
    await usdcMark(current('amount'));
    assert.ok(await page.locator('li[data-step="amount"] [data-pair-max]').count() >= 1, 'his Max, from the balances the service read');
    assert.ok(reads.calls.some((call) => call.route === 'chain-balances' && call.request.wallet === OWNER), 'the balances asked of the service');
    assert.equal(chain.chainNow(), 4663, 'and still on Robinhood Chain for the balances');
    assert.equal(chain.log.filter((method) => method === 'wallet_switchEthereumChain').length, 0, 'no switch asked so far');
    await page.locator('li[data-step="amount"][aria-current="step"] [data-pair-side="1"] input[inputmode="decimal"]').fill('1000');
    await pressContinue(current('amount'));
    const review = page.locator('[data-stage-card="review"] [data-zap-review="live"][data-zap-review-stage="reviewed"]');
    await review.waitFor({ timeout: 30_000 });
    await usdcMark(current('review'));
    await page.screenshot({ path: join(shots(), 'journey-usdc-artwork-review.png'), fullPage: true, animations: 'disabled' });
    assert.equal(chain.chainNow(), 8453, 'the wallet moved to Base for the review');
    assert.equal(chain.log.filter((method) => method === 'wallet_switchEthereumChain').length, 1, 'once');
    assert.deepEqual([s.planned[0].action, s.planned[0].chainId], ['create', 8453]);
    assert.equal(s.planned[0].inputs.find((input) => input.token === USDC_BASE)?.amountRaw, '1000000000', 'the 1,000 USDC he typed');
    await page.locator('[data-create-position="live"]:not([disabled])').click({ timeout: 30_000 });
    await page.locator('[data-created-position][data-zap-receipt]').waitFor({ timeout: 60_000 });
    assert.deepEqual(chain.sends.map((entry) => entry.tx.chainId), ['0x2105', '0x2105'], 'the approval and the create, on Base');
    assert.deepEqual(chain.offChain, [], 'nothing of Base asked of the wallet while it was elsewhere');
  } finally { await s.close(); }
});

// Added 2026-10-06 (the owner's point 4, spec §2.4): when Base's oracle did not answer, the plan's L1 data fee is
// unavailable; the one network fee line then shows the L2 part and says the rest, never letting it pass for the whole and
// never a 0, and Details says the L1 data fee is a dash. Changed on purpose 2026-10-06 (the review of point 4, ux #1): the
// rest is one plain clause in view, never "L1 data fee —" (jargon, and a dash a touch screen cannot explain).
test('(n) his Review on Base when the plan could not read the L1 data fee: the network fee line says the rest in words, never a zero', async () => {
  const chain = createV2Chain({ chainId: 8453, timestamp: now(), balances: { [USDC_BASE]: 5_000_000_000n }, pools: [{ pool: POOL_BASE, sqrtPriceX96: SQRT_BASE, tick: TICK_BASE, liquidity: 10n ** 18n }] });
  chain.switchTo(4663);
  const read = createReadStub({ answer: robinhoodRead });
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [8453], contracts: { 8453: contractsFor(8453) }, planner: basePlanner([], { l1Unavailable: true }),
    routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true,
  });
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    await page.getByRole('combobox', { name: 'Search a token' }).fill('USDC');
    await page.locator(`[data-token-network-option="8453:${USDC_BASE}"]`).click({ timeout: 30_000 });
    const pools = page.locator('[data-picker="pool"][data-picker-network="8453"]');
    await pools.locator('input[name="pool-option"]').first().click({ timeout: 30_000 });
    await page.locator('[data-chosen-pool]').waitFor();
    const current = (step) => page.locator(`li[data-step="${step}"][aria-current="step"]`);
    await pressContinue(current('pool'));
    await current('range').waitFor();
    await pressContinue(current('range'));
    await current('amount').waitFor();
    await page.locator('li[data-step="amount"] [data-pair-balance="ready"]').first().waitFor({ timeout: 30_000 });
    await page.locator('li[data-step="amount"][aria-current="step"] [data-pair-side="1"] input[inputmode="decimal"]').fill('1000');
    await pressContinue(current('amount'));
    const review = page.locator('[data-stage-card="review"] [data-zap-review="live"][data-zap-review-stage="reviewed"]');
    const networkFee = review.locator('[data-review-network-fee="about"]');
    await networkFee.waitFor({ timeout: 30_000 });
    assert.equal(await networkFee.getAttribute('data-review-l1-fee'), 'unavailable');
    assert.match(await networkFee.innerText(), /^Network fee: about [\d.]+ ETH(?: \((?:<\$0\.01|\$[\d,]+(?:\.\d+)?)\))?, plus a little more your wallet shows before you confirm$/, 'the L2 part, and the rest in words');
    assert.equal(await networkFee.locator('[data-figure="none"]').count(), 0, 'no bare dash in view');
    assert.doesNotMatch(await review.locator('[data-review-headline]').innerText(), /L1/, 'no "L1" in view');
    await review.locator('[data-review-headline]').screenshot({ path: join(shots(), 'journey-base-l1-unavailable.png'), animations: 'disabled' });
    const details = review.locator('[data-review-details]');
    await details.locator('summary').click();
    assert.match(await details.locator('[data-fact="review-l1-fee"]').innerText(), /^L1 data fee\s+—$/);
    assert.equal(await details.locator('[data-fact="review-network-fee"]').count(), 0, 'no ceiling without the oracle');
    assert.match(await details.getAttribute('data-l1-wei'), /^unavailable op_gas_price_oracle$/);
    assert.equal(chain.sends.length, 0);
  } finally { await s.close(); }
});

// Added 2026-10-06 (the review of point 4, ux #1): a token whose permission must first go back to zero (the wallet gave
// the zap a smaller one before) has its new permission read only once the reset is on chain. The one network fee line
// then says the rest in one plain clause, never "+ other steps —", and Create position waits only while a step is checked.
test('(n2) an approval that waits for a reset to zero: the network fee line says the rest in words, never a dash', async () => {
  const chain = createV2Chain({ chainId: 4663, timestamp: now(), balances: { [USDG_RH]: 5_000_000_000n }, allowances: [{ token: USDG_RH, spender: ZAP_V4, amount: 1n }], pools: [{ pool: POOL_RH, sqrtPriceX96: SQRT, tick: TICK, liquidity: 10n ** 16n }] });
  chain.switchTo(4663);
  const read = createReadStub({ answer: robinhoodRead });
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [4663], contracts: { 4663: contractsFor(4663) }, planner: robinhoodPlanner([]),
    routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true,
  });
  try {
    const page = s.page;
    await toReview(page);
    const review = page.locator('[data-stage-card="review"] [data-zap-review="live"][data-zap-review-stage="reviewed"]');
    await review.locator('[data-wallet-step="approve-reset"][data-step-status="ready"]').waitFor({ timeout: 30_000 });
    assert.deepEqual(await review.locator('[data-wallet-step]').evaluateAll((items) => items.map((item) => item.getAttribute('data-wallet-step'))), ['approve-reset', 'approve', 'action']);
    const networkFee = review.locator('[data-review-network-fee="about"][data-review-network-others="unprepared"]');
    assert.match(await networkFee.innerText(), /^Network fee: about [\d.]+ ETH(?: \((?:<\$0\.01|\$[\d,]+(?:\.\d+)?)\))?, plus a little more your wallet shows before you confirm$/);
    assert.equal(await networkFee.locator('[data-figure="none"]').count(), 0, 'no bare dash in view');
    assert.equal(await page.locator('[data-create-position="live"]').isDisabled(), false, 'the reset is ready to confirm');
    await review.locator('[data-review-headline]').screenshot({ path: join(shots(), 'journey-owner-reset-approval.png'), animations: 'disabled' });
    assert.equal(chain.sends.length, 0);
  } finally { await s.close(); }
});

// Added 2026-10-06 (the review of point 4, a second look): the later approvals' fees are read at the review on the page's
// one zap client, which runs one request at a time. Back, then Continue, while one of those reads is still under way (a
// slow node: held here for 8 s) quotes again on that same client: the new quote waits for that read, and never ends in
// "Another request to your wallet is still open." with nothing open in the wallet.
test('(n3) Back, then Continue, while Review still reads a later approval’s fee: the new quote waits for it, never "Another request to your wallet is still open"', async () => {
  const chain = createV2Chain({ chainId: 4663, timestamp: now(), balances: { [USDG_RH]: 5_000_000_000n }, allowances: [{ token: USDG_RH, spender: ZAP_V4, amount: 1n }], pools: [{ pool: POOL_RH, sqrtPriceX96: SQRT, tick: TICK, liquidity: 10n ** 16n }] });
  chain.switchTo(4663);
  const read = createReadStub({ answer: robinhoodRead });
  // The later approval's fee read: the first allowance read of USDG after the reset's estimate (draftFor's own), held once.
  let estimates = 0;
  let holding = null;
  const intercept = async (method, params) => {
    if (method === 'eth_estimateGas') estimates += 1;
    if (holding === null && estimates === 1 && method === 'eth_call' && params[0]?.to?.toLowerCase() === USDG_RH && params[0]?.data?.startsWith('0xdd62ed3e')) {
      holding = 'held';
      await sleep(8_000);
      holding = 'released';
    }
    return undefined;
  };
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [4663], contracts: { 4663: contractsFor(4663) }, planner: robinhoodPlanner([]), intercept,
    routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true,
  });
  try {
    const page = s.page;
    await toReview(page);
    await until(() => holding === 'held', 'the later approval’s fee read under way');
    const current = (step) => page.locator(`li[data-step="${step}"][aria-current="step"]`);
    await press(footerButton(current('review'), 'Back'));
    await current('amount').waitFor();
    await pressContinue(current('amount'));
    assert.equal(holding, 'held', 'Review again while that read is still under way');
    const review = page.locator('[data-stage-card="review"] [data-zap-review="live"][data-zap-review-stage="reviewed"]');
    await review.locator('[data-wallet-step="approve-reset"][data-step-status="ready"]').waitFor({ timeout: 30_000 });
    assert.equal(holding, 'released', 'the new review waited for that read');
    // Changed on purpose 2026-10-30 (QA round 2, INST-2: plans kept for the same choices): Review reopened with the same
    // choices takes the plan already in (well inside its quote's life), reviewed again at a fresh block once that read was in.
    assert.equal(s.planned.length, 1, 'the same choices: the kept plan, reviewed again, never asked twice');
    assert.equal(await page.locator('[data-zap-review-stage="failed"]').count(), 0);
    assert.equal(await page.getByText(/Another request to your wallet is still open/).count(), 0);
    assert.equal(await page.locator('[data-create-position="live"]').isDisabled(), false, 'the reset is ready to confirm');
    assert.equal(chain.sends.length, 0);
  } finally { await s.close(); }
});

/** His journey on Robinhood Chain, from the search to Review, with 1,000 USDG typed (the steps (d) and (h) take), or `token`. */
async function toReview(page, amount = '1000', token = USDG_RH, stayAtAmount = false) {
  await page.locator('[data-create-journey]').waitFor();
  await page.getByRole('combobox', { name: 'Search a token' }).fill(token);
  await page.locator(`[data-token-option="${token}"]`).click();
  await page.locator('[data-picker="pool"] input[name="pool-option"]').first().click({ timeout: 30_000 });
  await page.locator('[data-chosen-pool]').waitFor();
  const current = (step) => page.locator(`li[data-step="${step}"][aria-current="step"]`);
  await pressContinue(current('pool'));
  await current('range').waitFor();
  await pressContinue(current('range'));
  await current('amount').waitFor();
  await page.locator('li[data-step="amount"] [data-pair-balance="ready"]').first().waitFor({ timeout: 30_000 });
  await page.locator('li[data-step="amount"][aria-current="step"] [data-pair-side="1"] input[inputmode="decimal"]').fill(amount);
  if (!stayAtAmount) await pressContinue(current('amount'));
}

const askedOf = (held) => async (count) => {
  for (let i = 0; i < 300 && held.length < count; i += 1) await new Promise((done) => setTimeout(done, 100));
  assert.equal(held.length, count, 'the plan was asked');
};

// Added 2026-10-06 (the review of point 4): a fresh quote can follow an approval already on chain (the create's own check
// then finds the price moved, src/v2in/journey/run.ts failed()). The greyed review keeps that approval done, never
// redrawn as a step still to do; the new review leaves it out (the permission is given) and asks for the create alone.
test('(o) a fresh quote after the approval went through: the greyed review keeps the approval done, the new one asks for the create alone', async () => {
  const chain = createV2Chain({ chainId: 4663, timestamp: now(), balances: { [USDG_RH]: 5_000_000_000n }, pools: [{ pool: POOL_RH, sqrtPriceX96: SQRT, tick: TICK, liquidity: 10n ** 16n }] });
  chain.switchTo(4663);
  const read = createReadStub({ answer: robinhoodRead });
  const answers = [];
  const held = [];
  // The create's simulation from the wallet, once the approval is on chain: below its minimum, as the zap reverts when
  // the price moved (InsufficientLiquidity(uint128,uint128)); once only.
  let moved = false;
  const intercept = (method, params) => {
    if (moved || method !== 'eth_call' || chain.sends.length !== 1 || !answers[0] || params[0]?.data !== answers[0].plan.call.data) return undefined;
    moved = true;
    return { error: { code: 3, message: 'execution reverted', data: `0xe49b763d${'1'.padStart(64, '0')}${'2'.padStart(64, '0')}` } };
  };
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [4663], contracts: { 4663: contractsFor(4663) }, planner: heldPlanner({ answers, held, ages: [0, 0] }), intercept,
    routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true,
  });
  const asked = askedOf(held);
  try {
    const page = s.page;
    await toReview(page);
    await asked(1);
    held.shift()();
    const reviewed = page.locator('[data-stage-card="review"] [data-zap-review="live"][data-zap-review-stage="reviewed"]');
    await reviewed.locator('[data-wallet-step="approve"][data-step-status="ready"]').waitFor({ timeout: 30_000 });
    await page.locator('[data-create-position="live"]:not([disabled])').click();
    // The approval goes through; the create's own check finds the price moved: the same choices are quoted again.
    await asked(1);
    const stale = page.locator('[data-stage-card="review"] [data-zap-review="live"][data-zap-review-stage="quoting"][data-review-stale]');
    await stale.waitFor({ timeout: 30_000 });
    assert.equal(moved, true, 'the create was checked once the approval was on chain');
    assert.equal(chain.sends.length, 1, 'the approval alone was sent');
    const approve = stale.locator('[data-wallet-step="approve"]');
    assert.equal(await approve.getAttribute('data-step-state'), 'done', 'the approval on chain stays done');
    assert.equal(await approve.locator('.dm-step-marker').innerText(), '✓');
    assert.equal(await stale.locator('[data-wallet-step="action"] .dm-step-marker').innerText(), '2');
    assert.equal(await stale.locator('[data-wallet-step="action"]').getAttribute('data-step-state'), null, 'nothing turns on a greyed review');
    assert.equal(await stale.locator('.dm-flow-wstep-note').count(), 0, 'no live line on a greyed review');
    assert.equal(await page.locator('#create-reason').innerText(), 'Getting a fresh quote…');
    await page.screenshot({ path: join(shots(), 'journey-owner-requoting-after-approval.png'), fullPage: true });
    held.shift()();
    // The new review: the permission is given, so the create alone, and the plan's own cost alone.
    await reviewed.locator('[data-wallet-step="action"][data-step-status="ready"]').waitFor({ timeout: 30_000 });
    assert.deepEqual(await reviewed.locator('[data-wallet-step]').evaluateAll((items) => items.map((item) => item.getAttribute('data-wallet-step'))), ['action']);
    assert.match(await reviewed.locator('[data-review-network-fee="about"]').innerText(), /^Network fee: about 0\.0001 ETH(?: \((?:<\$0\.01|\$[\d,]+(?:\.\d+)?)\))?$/, 'nothing else to send');
    await page.locator('[data-create-position="live"]:not([disabled])').click();
    await page.locator('[data-created-position]').waitFor({ timeout: 60_000 });
    assert.equal(chain.sends.length, 2, 'one approval and one create');
    assert.equal(chain.sends[1].tx.data, answers[1].plan.call.data, 'the create of the new quote');
  } finally { await s.close(); }
});

// Added 2026-10-06 (the review of point 4: the short-wallet sentence said once): a wallet that cannot fund the amount
// asks for no quote, and nothing of an earlier review is drawn. Changed on purpose 2026-10-06 (the review of point 4, ux
// #4: an empty review read as broken): the review shows what the position needs, as today's Review does, and says once,
// in view, what the wallet has and the ways on; Create position stays disabled with a short line saying why. Changed on
// purpose 2026-10-06 (the review, a second look): "bring USDG from another network" only where Amount's bring-funds
// offer can bring it (S2 live here, and USDG is a token a deposit delivers); (p2) is the other case.
test('(p) a wallet short of the amount stays at funding; no quote or wallet transaction', async () => {
  const chain = createV2Chain({ chainId: 4663, timestamp: now(), eth: 400_000_000_000_000n, balances: { [USDG_RH]: 100_000_000n }, pools: [{ pool: POOL_RH, sqrtPriceX96: SQRT, tick: TICK, liquidity: 10n ** 16n }] });
  chain.switchTo(4663);
  // The wallet's balances as the read service reports them: 0.0004 ETH (less than Review's gas allowance) and 100 USDG.
  const shortRead = (route, body) => {
    const text = robinhoodRead(route, body);
    if (route !== 'wallet-assets') return text;
    const answer = JSON.parse(text);
    for (const item of answer.items) item.amountRaw = item.address === ZERO ? '400000000000000' : '100000000';
    return JSON.stringify(answer);
  };
  const read = createReadStub({ answer: shortRead });
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [4663], contracts: { 4663: contractsFor(4663) }, planner: robinhoodPlanner([]),
    routes: [crosschainLive, (request, url) => read.handle(request, url) ?? undefined], artwork: true,
  });
  try {
    const page = s.page;
    await toReview(page, '1000', USDG_RH, true);
    const amount = current(page, 'amount');
    await amount.locator('[data-amount-short]').waitFor({ timeout: 30_000 });
    assert.equal(await footerButton(amount, 'Continue').isDisabled(), true);
    assert.equal(await page.locator('#continue-reason').innerText(), 'Choose how to fund this amount below.');
    // QA round 2, N75 (2026-10-30): a field nobody is typing in shows its amount grouped ("1,000"); the amount is the same.
    assert.match(await amount.locator('[data-pair-side="1"] input[inputmode="decimal"]').inputValue(), /^1,?000$/);
    assert.equal(await page.locator('[data-zap-review]').count(), 0);
    assert.equal(s.planned.length, 0, 'no quote asked for a wallet that cannot fund it');
    assert.equal(chain.sends.length, 0);
  } finally { await s.close(); }
});

// Added 2026-10-06 (the review of point 4, ux #4, a second look): a deposit from another network delivers only a network's
// stable, ETH or WETH. A wallet short of any other token is told to add it to the wallet, as today's Review says, never to
// bring it from another network, even with Amount's bring-funds offer open (S2 live, as in (p)).
const POOL_TOKEN = { ...POOL_RH, currency1: FIXTURE_TOKEN };
test('(p2) a wallet short of a token no deposit delivers stays at funding, never promises to bridge that token', async () => {
  const chain = createV2Chain({ chainId: 4663, timestamp: now(), eth: 400_000_000_000_000n, balances: { [FIXTURE_TOKEN]: 100_000_000n }, pools: [{ pool: POOL_TOKEN, sqrtPriceX96: SQRT, tick: TICK, liquidity: 10n ** 16n }] });
  chain.switchTo(4663);
  // The read service's own TOKEN in its ETH / TOKEN pool, at the price (d) uses; the wallet holds 0.0004 ETH and 100 TOKEN.
  const tokenRead = (route, body) => {
    const name = { 'pool-market': 'pool-market.not-requested', 'wallet-assets': 'wallet-assets.zero', token: body.token === ZERO ? 'token.native' : 'token.success' }[route] ?? `${route}.success`;
    const answer = JSON.parse(readFileSync(join(READ_FIXTURES, `${name}.json`), 'utf8').replaceAll(FIXTURE_POOL_ID, poolIdOf(POOL_TOKEN)));
    if (route === 'pools') {
      for (const pool of answer.pools) Object.assign(pool, { currentLpFeePips: 500, tick: TICK, sqrtPriceX96: SQRT.toString(), poolKey: { ...pool.poolKey, fee_pips: 500, tick_spacing: 10 } });
    }
    if (route === 'wallet-assets') {
      for (const item of answer.items) item.amountRaw = item.address === ZERO ? '400000000000000' : '100000000';
    }
    return JSON.stringify(answer);
  };
  const read = createReadStub({ answer: tokenRead });
  let s2Asked = 0;
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [4663], contracts: { 4663: contractsFor(4663) }, planner: robinhoodPlanner([]),
    routes: [(request, url) => { const said = crosschainLive(request, url); if (said) s2Asked += 1; return said; }, (request, url) => read.handle(request, url) ?? undefined], artwork: true,
  });
  try {
    const page = s.page;
    await toReview(page, '1000', FIXTURE_TOKEN, true);
    const amount = current(page, 'amount');
    await amount.locator('[data-amount-short]').waitFor({ timeout: 30_000 });
    assert.equal(await footerButton(amount, 'Continue').isDisabled(), true);
    // QA round 2, N75 (2026-10-30): a field nobody is typing in shows its amount grouped ("1,000"); the amount is the same.
    assert.match(await amount.locator('[data-pair-side="1"] input[inputmode="decimal"]').inputValue(), /^1,?000$/);
    const offers = await page.getByText(/from another network/).allInnerTexts();
    assert.ok(offers.every((line) => !/TOKEN/.test(line)), 'no unsupported token delivery promised');
    assert.ok(s2Asked >= 1);
    assert.equal(s.planned.length, 0);
    assert.equal(chain.sends.length, 0);
  } finally { await s.close(); }
});

// Added 2026-10-06 (the review of point 4): a wallet that batches (EIP-5792) confirms once; the one network fee line is
// then the batch's own ceiling, "up to" (its calls together, the approval in it), and a fresh quote of the same choices
// keeps the greyed batch step and that figure on screen until the new review replaces them.
test('(q) a wallet that batches: one step, the network fee up to the batch’s ceiling; asked again, the greyed review keeps both', async () => {
  const chain = createV2Chain({ chainId: 4663, timestamp: now(), atomic: 'supported', simulateV1: true, balances: { [USDG_RH]: 5_000_000_000n }, pools: [{ pool: POOL_RH, sqrtPriceX96: SQRT, tick: TICK, liquidity: 10n ** 16n }] });
  chain.switchTo(4663);
  const read = createReadStub({ answer: robinhoodRead });
  const answers = [];
  const held = [];
  // The first answer is good for 10 s more once it is let go; the second for its whole 3 minutes.
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [4663], contracts: { 4663: contractsFor(4663) }, planner: heldPlanner({ answers, held, ages: [170, 0] }),
    routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true,
  });
  const asked = askedOf(held);
  try {
    const page = s.page;
    await toReview(page);
    await asked(1);
    assert.equal(s.planned[0].consent, 'direct', 'a batch carries the direct consent (§2.5.4)');
    held.shift()();
    const reviewed = page.locator('[data-stage-card="review"] [data-zap-review="live"][data-zap-review-stage="reviewed"]');
    const line = reviewed.locator('[data-review-network-fee="upTo"]');
    await line.waitFor({ timeout: 30_000 });
    const before = await line.innerText();
    assert.match(before, /^Network fee: up to [\d.]+ ETH(?: \((?:<\$0\.01|\$[\d,]+(?:\.\d+)?)\))?$/, 'the batch’s own ceiling: its calls together');
    assert.deepEqual(await reviewed.locator('[data-wallet-step]').evaluateAll((items) => items.map((item) => item.getAttribute('data-wallet-step'))), ['batch']);
    assert.deepEqual(await reviewed.locator('.dm-flow-wstep-title').allInnerTexts(), ['Approve and create the position, all at once']);
    assert.equal(await page.locator('#create-reason').innerText(), 'Your wallet asks you to confirm once: every step together, or none of them.');
    await page.locator('[data-stage-card="review"]').screenshot({ path: join(shots(), 'journey-owner-batch-review.png'), animations: 'disabled' });
    // Near expiry the idle review refreshes itself, without a wallet click or any transaction.
    await asked(1);
    const stale = page.locator('[data-stage-card="review"] [data-zap-review="live"][data-zap-review-stage="quoting"][data-review-stale]');
    await stale.waitFor({ timeout: 30_000 });
    assert.equal(await stale.locator('[data-review-network-fee="upTo"]').innerText(), before, 'the batch’s figure stays on screen');
    assert.equal(await stale.locator('[data-wallet-steps="batch"][aria-busy="true"] [data-wallet-step="batch"]').count(), 1, 'its one step, greyed');
    assert.equal(await page.locator('#create-reason').innerText(), 'Getting a fresh quote…');
    held.shift()();
    await reviewed.locator('[data-review-network-fee="upTo"]').waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('[data-review-stale]').count(), 0, 'the new review replaced it');
    assert.deepEqual([chain.sends.length, chain.batches.length], [0, 0], 'nothing was sent: the quote ran out first');
  } finally { await s.close(); }
});

// Added 2026-10-06 (the final check's F1/F6): on Base and Arbitrum One his Back stayed shown and enabled under the success;
// pressing it threw away the receipt, View position and Auto-exit's offer, and Continue quoted the same choices again. It
// now rests there as on Robinhood Chain, and the success stays when the wallet disconnects (nothing drawn before a quote
// takes its place). A done step reopened still leaves the success (a second position from the same choices, by design),
// and Back is there again.
test('(t) his journey on Base: once the position exists Back rests under its success, as on Robinhood Chain; a disconnect keeps the success; a done step reopened brings Back again', async () => {
  const chain = createV2Chain({ chainId: 8453, timestamp: now(), balances: { [USDC_BASE]: 5_000_000_000n }, pools: [{ pool: POOL_BASE, sqrtPriceX96: SQRT_BASE, tick: TICK_BASE, liquidity: 10n ** 18n }] });
  chain.switchTo(4663);
  const read = createReadStub({ answer: robinhoodRead });
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [8453], contracts: { 8453: contractsFor(8453) }, planner: basePlanner([]),
    routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true,
  });
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    await page.getByRole('combobox', { name: 'Search a token' }).fill('USDC');
    await page.locator(`[data-token-network-option="8453:${USDC_BASE}"]`).click({ timeout: 30_000 });
    await page.locator('[data-picker="pool"][data-picker-network="8453"] input[name="pool-option"]').first().click({ timeout: 30_000 });
    await page.locator('[data-chosen-pool]').waitFor();
    const current = (step) => page.locator(`li[data-step="${step}"][aria-current="step"]`);
    await pressContinue(current('pool'));
    await current('range').waitFor();
    await pressContinue(current('range'));
    await current('amount').waitFor();
    await page.locator('li[data-step="amount"] [data-pair-balance="ready"]').first().waitFor({ timeout: 30_000 });
    await page.locator('li[data-step="amount"][aria-current="step"] [data-pair-side="1"] input[inputmode="decimal"]').fill('1000');
    await pressContinue(current('amount'));
    await page.locator('[data-stage-card="review"] [data-zap-review="live"][data-zap-review-stage="reviewed"]').waitFor({ timeout: 30_000 });
    assert.equal(await backOf(page).isVisible(), true, 'Back, before Create position');
    await page.locator('[data-create-position="live"]:not([disabled])').click({ timeout: 30_000 });
    const success = page.locator('[data-created-position][data-zap-receipt]');
    await success.waitFor({ timeout: 60_000 });
    await success.locator('a[data-created-next="autoexit"]').waitFor({ timeout: 30_000 });
    assert.equal(await backOf(page).textContent(), 'Back');
    assert.equal(await backOf(page).isHidden(), true, 'Back rests once the position exists');
    await page.locator('[data-stage-card="review"] [data-journey-footer]').screenshot({ path: join(shots(), 'journey-base-created-back-rests.png'), animations: 'disabled' });
    // The wallet disconnected: the success stays, never Connect wallet in its place.
    await page.locator('header [aria-haspopup="dialog"]').click();
    await page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]').getByRole('button', { name: 'Disconnect wallet', exact: true }).click();
    await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    await page.keyboard.press('Escape');
    assert.equal(await success.isVisible(), true, 'the success stays');
    assert.equal(await success.locator('a[data-created-next="position"]').count(), 1);
    assert.equal(await page.locator('[data-create-position="connect"]').count(), 0, 'never Connect wallet in its place');
    assert.equal(await backOf(page).isHidden(), true);
    // A done step reopened leaves the success, as on Robinhood Chain: Back is there again.
    await press(page.locator('li[data-step="amount"] button.dm-flow-row'));
    await current('amount').waitFor();
    assert.equal(await backOf(page).isVisible(), true, 'Back again on the step reopened');
    assert.equal(await page.locator('[data-created-position]').count(), 0);
    assert.equal(chain.sends.length, 2, 'the approval and the create, once');
  } finally { await s.close(); }
});

// Added 2026-10-06 (the final check's F1/F6): on Robinhood Chain Back rested only once the receipt named the new position,
// so a receipt that can't be read exactly left Back shown under the success.
test('(t2) his journey on Robinhood Chain: a receipt that can’t be read exactly still rests Back under the success', async () => {
  const chain = createV2Chain({ chainId: 4663, timestamp: now(), balances: { [USDG_RH]: 5_000_000_000n }, pools: [{ pool: POOL_RH, sqrtPriceX96: SQRT, tick: TICK, liquidity: 10n ** 16n }] });
  chain.switchTo(4663);
  const read = createReadStub({ answer: robinhoodRead });
  // The create's receipt without its events: included, but nothing in it names the new position.
  const intercept = async (method, params) => {
    if (method !== 'eth_getTransactionReceipt') return undefined;
    const reply = await chain.request(method, params);
    return reply?.result?.to?.toLowerCase() === ZAP_V4 ? { result: { ...reply.result, logs: [] } } : undefined;
  };
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [4663], contracts: { 4663: contractsFor(4663) }, planner: robinhoodPlanner([]), intercept,
    // Confirmation is read from the local node now. Apply this scenario's missing events to that node too, rather than
    // returning a complete receipt through the new reader while only the wallet's old reader sees the missing events.
    routes: [confirmationRoute({ request: async (method, params) => (await intercept(method, params)) ?? chain.request(method, params) }), (request, url) => read.handle(request, url) ?? undefined], artwork: true,
  });
  try {
    const page = s.page;
    await toReview(page);
    await page.locator('[data-create-position="live"]:not([disabled])').click({ timeout: 30_000 });
    const success = page.locator('[data-created-position][data-zap-receipt]');
    await success.locator('[data-fact="receipt-unreadable"]').waitFor({ timeout: 60_000 });
    assert.equal(await success.getAttribute('data-created-position'), '', 'the receipt names no position');
    assert.equal(await backOf(page).isHidden(), true, 'Back rests once the position exists, its receipt read or not');
    assert.equal(chain.sends.length, 2);
  } finally { await s.close(); }
});

// Added 2026-10-06 (the final check's F4): with no wallet, his Review showed a lone dash where the amounts go, and nothing
// to connect with under a disabled Create position. It shows what the position takes as typed ("About", as the quoted
// figures are), and Create position's place is Connect wallet, which opens the wallet dialog, as his own control offers.
test('(u) no wallet: his Review shows the amounts as typed, never a lone dash; Connect wallet opens the wallet dialog, and once connected the plan is asked', async () => {
  const chain = createV2Chain({ chainId: 4663, timestamp: now(), balances: { [USDG_RH]: 5_000_000_000n }, pools: [{ pool: POOL_RH, sqrtPriceX96: SQRT, tick: TICK, liquidity: 10n ** 16n }] });
  chain.switchTo(4663);
  const read = createReadStub({ answer: robinhoodRead });
  // No wallet until the person connects one: the wallet names no account before it is asked for one.
  let asked = false;
  const intercept = (method) => {
    if (method === 'eth_requestAccounts' || method === 'wallet_requestPermissions') asked = true;
    return method === 'eth_accounts' && !asked ? { result: [] } : undefined;
  };
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [4663], contracts: { 4663: contractsFor(4663) }, planner: robinhoodPlanner([]), connect: false, intercept,
    routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true,
  });
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    await page.getByRole('combobox', { name: 'Search a token' }).fill(USDG_RH);
    await page.locator(`[data-token-option="${USDG_RH}"]`).click();
    await page.locator('[data-picker="pool"] input[name="pool-option"]').first().click({ timeout: 30_000 });
    await page.locator('[data-chosen-pool]').waitFor();
    const current = (step) => page.locator(`li[data-step="${step}"][aria-current="step"]`);
    await pressContinue(current('pool'));
    await current('range').waitFor();
    await pressContinue(current('range'));
    await current('amount').waitFor();
    await page.locator('li[data-step="amount"] [data-pair-balance="disconnected"]').waitFor({ timeout: 30_000 });
    await page.locator('li[data-step="amount"][aria-current="step"] [data-pair-side="1"] input[inputmode="decimal"]').fill('1000');
    await pressContinue(current('amount'));
    const review = page.locator('[data-stage-card="review"] [data-zap-review="live"]');
    await review.waitFor({ timeout: 30_000 });
    assert.equal(await review.getAttribute('data-zap-review-stage'), 'idle', 'no quote without a wallet');
    assert.match(await review.locator('[data-review-amounts]').innerText(), /^About [\d.,]+ ETH \+ 1,000 USDG$/, 'the amounts as typed, never a lone dash');
    const connect = page.locator('[data-journey-footer] [data-create-position="connect"]');
    assert.equal(await connect.innerText(), 'Connect wallet');
    assert.equal(await connect.isDisabled(), false);
    assert.equal(Math.round((await connect.boundingBox()).width), Math.round((await footerBox(page)).width), 'in Create position’s place');
    // Changed on purpose 2026-10-30 (QA round 2, Q5 and Q31): what follows Connect wallet, under it, and the wallet card
    // titled for it (it read "In your wallet" above a Connect wallet button); the cost in view before any wallet.
    assert.equal(await page.locator('#create-reason').innerText(), 'After connecting, you sign in and confirm each step in your wallet.');
    assert.equal(await page.locator('[data-stage-card="review"] #zap-steps-heading').innerText(), 'Next: connect your wallet');
    assert.equal(await review.locator('[data-review-fee="before"]').innerText(), 'Domino fee: None unless a swap is needed, then 0.65% of the amount swapped');
    assert.equal(await review.locator('[data-review-network-fee="unknown"]').innerText(), 'Network fee: your wallet shows it before you confirm');
    assert.match(await review.locator('[data-review-slippage]').innerText(), /^Slippage tolerance: [\d.]+%$/);
    assert.equal(await page.getByText('Your wallet will ask you to confirm each step.').count(), 0);
    await page.locator('[data-stage-card="review"]').screenshot({ path: join(shots(), 'journey-owner-no-wallet.png'), animations: 'disabled' });
    assert.equal(s.planned.length, 0);
    await press(connect);
    const dialog = page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]');
    await dialog.getByRole('button', { name: `Connect ${WALLET_NAME}`, exact: true }).click();
    await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
    await page.keyboard.press('Escape');
    // Connected (the suite's planner asks no session): his balances read, the plan asked, Create position offered.
    await page.locator('[data-stage-card="review"] [data-zap-review="live"][data-zap-review-stage="reviewed"]').waitFor({ timeout: 30_000 });
    await page.locator('[data-create-position="live"]:not([disabled])').waitFor({ timeout: 30_000 });
    assert.equal(s.planned.length, 1);
    assert.equal(chain.sends.length, 0);
  } finally { await s.close(); }
});

// Added 2026-10-06 (the final check's F4): a wallet connected but not signed in asks no quote (the plan is the signed-in
// wallet's, as on the site: no planner stands in here); his Review showed a lone dash until a quote came after sign-in.
test('(u2) a wallet not signed in: his Review shows the amounts as typed under Sign in, and no plan is asked', async () => {
  const chain = createV2Chain({ chainId: 4663, timestamp: now(), balances: { [USDG_RH]: 5_000_000_000n }, pools: [{ pool: POOL_RH, sqrtPriceX96: SQRT, tick: TICK, liquidity: 10n ** 16n }] });
  chain.switchTo(4663);
  const read = createReadStub({ answer: robinhoodRead });
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [4663], contracts: { 4663: contractsFor(4663) }, planner: null,
    routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true,
  });
  try {
    const page = s.page;
    await toReview(page);
    const signIn = page.locator('[data-journey-footer] [data-create-signin]');
    await signIn.waitFor({ timeout: 30_000 });
    assert.equal(await signIn.innerText(), 'Sign in');
    // In Create position's place: the footer's whole width, never a small button beside Back.
    assert.equal(Math.round((await signIn.boundingBox()).width), Math.round((await footerBox(page)).width), 'Sign in takes Create position’s place');
    assert.equal(await page.locator('#create-reason').innerText(), 'Sign in with your wallet to get the quote. Signing in moves nothing.');
    const review = page.locator('[data-stage-card="review"] [data-zap-review="live"]');
    assert.equal(await review.getAttribute('data-zap-review-stage'), 'idle', 'no quote while signed out');
    assert.match(await review.locator('[data-review-amounts]').innerText(), /^About [\d.,]+ ETH \+ 1,000 USDG$/, 'the amounts as typed, never a lone dash');
    await page.locator('[data-stage-card="review"]').screenshot({ path: join(shots(), 'journey-owner-signed-out.png'), animations: 'disabled' });
    assert.equal(s.planned.length, 0);
  } finally { await s.close(); }
});

// Added 2026-10-06 (the final check's F5): when the wallet's balances of the pool's two tokens could not be read, his Review
// sat on a disabled Create position under "Your wallet will ask you to confirm each step.", and nothing read them again. It
// says so in one line and offers Read again; while they are read, it says that, never that the wallet will ask.
test('(v) unread Amount balances recover automatically, keep the typed quantity and then allow Review', async () => {
  const chain = createV2Chain({ chainId: 4663, timestamp: now(), balances: { [USDG_RH]: 5_000_000_000n }, pools: [{ pool: POOL_RH, sqrtPriceX96: SQRT, tick: TICK, liquidity: 10n ** 16n }] });
  chain.switchTo(4663);
  // The wallet's read fails until the test lets it answer; from then on each answer is held until let go.
  let failing = true;
  const held = [];
  const read = createReadStub({
    answer: (route, body) => {
      if (route !== 'wallet-assets') return robinhoodRead(route, body);
      if (failing) return gatewayError('upstream_unavailable', 503);
      return new Promise((done) => held.push(() => done(robinhoodRead(route, body))));
    },
  });
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [4663], contracts: { 4663: contractsFor(4663) }, planner: robinhoodPlanner([]),
    routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true, clock: true,
  });
  try {
    const page = s.page;
    await toReview(page, '1000', USDG_RH, true);
    const amount = current(page, 'amount');
    // Changed on purpose 2026-10-30 (QA round 2 review, the sweep): a balance not read yet is said as one being checked,
    // never as one that could not be; the failed read shows as the balance's figure dash.
    await amount.locator('[data-pair-balance="ready"] bdi.text-fg-subtle').first().waitFor({ timeout: 30_000 });
    await page.locator('#continue-reason').filter({ hasText: 'Checking your balance…' }).waitFor({ timeout: 30_000 });
    assert.equal(await footerButton(amount, 'Continue').isDisabled(), true);
    assert.equal(s.planned.length, 0);
    failing = false;
    // Changed on purpose 2026-10-30 (launch capacity 9a, its review): while a read that answered nothing holds Continue, the
    // balances are asked again 15 s after the last read, then 30 s (a minute otherwise); 31 s covers both steps.
    await page.clock.fastForward('00:31');
    await until(() => held.length > 0, 'the balances automatically read again');
    while (held.length > 0) held.shift()();
    await until(async () => !(await footerButton(amount, 'Continue').isDisabled()), 'funding ready after recovery');
    // QA round 2, N75 (2026-10-30): a field nobody is typing in shows its amount grouped ("1,000"); the amount is the same.
    assert.match(await amount.locator('[data-pair-side="1"] input[inputmode="decimal"]').inputValue(), /^1,?000$/, 'a retry never changes spending intent');
    await pressContinue(amount);
    await page.locator('[data-stage-card="review"] [data-zap-review-stage="reviewed"]').waitFor({ timeout: 30_000 });
    assert.equal(s.planned.length, 1);
    assert.equal(chain.sends.length, 0);
  } finally { while (held.length > 0) held.shift()(); await s.close(); }
});

// Added 2026-10-06 (the final check's F1/F6, a second look): on Base and Arbitrum One the flow rests on its success, and New
// position's own link (the menu's or the footer's: the very hash already open) did nothing there, where on Robinhood Chain
// it starts a fresh flow; only reopening a done row or leaving the page went on. It now starts one on every network.
test('(t3) his journey on Base: once the position exists, New position from the menu starts a fresh flow at step 1, as on Robinhood Chain', async () => {
  const chain = createV2Chain({ chainId: 8453, timestamp: now(), balances: { [USDC_BASE]: 5_000_000_000n }, pools: [{ pool: POOL_BASE, sqrtPriceX96: SQRT_BASE, tick: TICK_BASE, liquidity: 10n ** 18n }] });
  chain.switchTo(4663);
  const read = createReadStub({ answer: robinhoodRead });
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [8453], contracts: { 8453: contractsFor(8453) }, planner: basePlanner([]),
    routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true,
  });
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    await page.getByRole('combobox', { name: 'Search a token' }).fill('USDC');
    await page.locator(`[data-token-network-option="8453:${USDC_BASE}"]`).click({ timeout: 30_000 });
    await page.locator('[data-picker="pool"][data-picker-network="8453"] input[name="pool-option"]').first().click({ timeout: 30_000 });
    await page.locator('[data-chosen-pool]').waitFor();
    const current = (step) => page.locator(`li[data-step="${step}"][aria-current="step"]`);
    await pressContinue(current('pool'));
    await current('range').waitFor();
    await pressContinue(current('range'));
    await current('amount').waitFor();
    await page.locator('li[data-step="amount"] [data-pair-balance="ready"]').first().waitFor({ timeout: 30_000 });
    await page.locator('li[data-step="amount"][aria-current="step"] [data-pair-side="1"] input[inputmode="decimal"]').fill('1000');
    await pressContinue(current('amount'));
    await page.locator('[data-create-position="live"]:not([disabled])').click({ timeout: 30_000 });
    const success = page.locator('[data-created-position][data-zap-receipt]');
    await success.waitFor({ timeout: 60_000 });
    assert.equal(await backOf(page).isHidden(), true, 'the flow rests on its success');
    assert.equal(await page.evaluate(() => location.hash), '#/new');
    // The menu's New position is the hash already open: it starts again at the first step, with nothing chosen.
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.locator('#site-menu [role="menuitem"]', { hasText: 'New position' }).click();
    await success.waitFor({ state: 'detached', timeout: 10_000 });
    await page.locator('li[data-step="pool"][data-state="current"]').waitFor({ timeout: 10_000 });
    assert.equal(await page.evaluate(() => location.hash), '#/new', 'the same page');
    assert.equal(await page.locator('li[data-step-done], [data-create-position], [data-created-position]').count(), 0, 'no step done, no Create position, no success');
    assert.equal(await page.locator('[data-chosen-pool]').count(), 0, 'nothing chosen');
    assert.equal(chain.sends.length, 2, 'the approval and the create, once: nothing more was sent');
  } finally { await s.close(); }
});

// Added 2026-10-06 (the final check's F4, a second look): before a quote has figures, his Review wrote the typed amount and
// its whole paired amount even when the wallet funds the deposit from one token (a USDG-only wallet holds ETH for gas
// alone): about twice the position, under his amount step's row, which writes the amounts after the swap. Both now say the
// same, as his own Review does.
test('(x) a wallet that funds the deposit from one token, not signed in: his Review writes the amounts after the swap, exactly as his amount step\'s row', async () => {
  const chain = createV2Chain({ chainId: 4663, timestamp: now(), eth: 2_000_000_000_000_000n, balances: { [USDG_RH]: 5_000_000_000n }, pools: [{ pool: POOL_RH, sqrtPriceX96: SQRT, tick: TICK, liquidity: 10n ** 16n }] });
  chain.switchTo(4663);
  // The wallet's balances as the read service reports them: 0.002 ETH, for gas, and 5,000 USDG.
  const usdgOnly = (route, body) => {
    const text = robinhoodRead(route, body);
    if (route !== 'wallet-assets') return text;
    const answer = JSON.parse(text);
    for (const item of answer.items) item.amountRaw = item.address === ZERO ? '2000000000000000' : '5000000000';
    return JSON.stringify(answer);
  };
  const read = createReadStub({ answer: usdgOnly });
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [4663], contracts: { 4663: contractsFor(4663) }, planner: null,
    routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true,
  });
  try {
    const page = s.page;
    await toReview(page);
    await page.locator('[data-journey-footer] [data-create-signin]').waitFor({ timeout: 30_000 });
    const review = page.locator('[data-stage-card="review"] [data-zap-review="live"]');
    assert.equal(await review.getAttribute('data-zap-review-stage'), 'idle', 'no quote while signed out');
    const amounts = review.locator('[data-review-amounts]');
    const shown = await amounts.innerText();
    assert.match(shown, /^About [\d.,]+ ETH \+ [\d.,]+ USDG$/);
    assert.doesNotMatch(shown, /\b1,000 USDG/, 'never the 1,000 USDG typed: part of it is swapped for the ETH');
    // Every digit of each side, as his amount step's row holds them (each figure's title, where it cut digits).
    const headline = (await amounts.getAttribute('title')).split(' + ').map((side) => side.split(' ')[0]);
    const row = page.locator('li[data-step="amount"] .dm-flow-row-summary');
    assert.match(await row.innerText(), /^About [\d.,]+ ETH \+ [\d.,]+ USDG$/, 'his row: the amounts after the swap');
    const figures = await row.evaluate((node) => [...node.querySelectorAll(':scope > span')].map((span) => span.title || span.textContent));
    assert.deepEqual(headline, figures, 'Review’s headline is his amount step’s row');
    assert.ok(Number(headline[1].replaceAll(',', '')) < 1000, 'less USDG than typed');
    await page.locator('[data-stage-card="review"]').screenshot({ path: join(shots(), 'journey-owner-signed-out-swap.png'), animations: 'disabled' });
    assert.equal(s.planned.length, 0);
    assert.equal(chain.sends.length, 0);
  } finally { await s.close(); }
});

// Added 2026-10-06 (the final check's F5, a second look): a quote that failed before any review (here the wallet declined
// the switch to Base) left a disabled Create position under "Press Create position to try again.", and nothing on Review
// asked the quote again: only Back then Continue did. The line now says there is no quote yet, and Review again asks one.
// The headline meanwhile writes the amounts as his amount step's row does (the wallet funds the deposit from USDC alone).
test('(w) a quote that failed before any review: never "Press Create position" under a disabled button; Review again asks the quote again', async () => {
  const chain = createV2Chain({ chainId: 8453, timestamp: now(), balances: { [USDC_BASE]: 5_000_000_000n }, pools: [{ pool: POOL_BASE, sqrtPriceX96: SQRT_BASE, tick: TICK_BASE, liquidity: 10n ** 18n }] });
  chain.switchTo(4663);
  const reads = createChainReads({
    chainId: 8453,
    tokens: [{ address: ZERO, symbol: 'ETH', name: 'Ether', decimals: 18, sources: ['profile'] }, { address: USDC_BASE, symbol: 'USDC', name: 'USD Coin', decimals: 6, sources: ['profile', 'uniswap_default_list'] }],
    pools: [{ pool: POOL_BASE, sqrtPriceX96: SQRT_BASE, tick: TICK_BASE, liquidity: 10n ** 18n }],
    balances: { [USDC_BASE]: 5_000_000_000n },
  });
  const read = createReadStub({ answer: robinhoodRead });
  // The wallet declines the first switch to Base (the quote's), then switches.
  let declined = 0;
  const intercept = (method) => {
    if (method !== 'wallet_switchEthereumChain' || declined > 0) return undefined;
    declined += 1;
    return { error: { code: 4001, message: 'User rejected the request.' } };
  };
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [8453], contracts: { 8453: contractsFor(8453) }, planner: basePlanner([]), intercept,
    routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true, chainReads: reads,
  });
  try {
    const page = s.page;
    /** Whether his footer's line asks for a press of a Create position that cannot be pressed. */
    const asksDisabledPress = async () => /Press Create position/.test(await page.locator('#create-reason').innerText()) && (await page.locator('[data-journey-footer] [data-create-position]').isDisabled());
    await page.locator('[data-create-journey]').waitFor();
    await page.getByRole('combobox', { name: 'Search a token' }).fill('coin');
    await page.locator(`[data-token-network-option="8453:${USDC_BASE}"]`).click({ timeout: 30_000 });
    await page.locator('[data-picker="pool"][data-picker-network="8453"] input[name="pool-option"]').first().click({ timeout: 30_000 });
    await page.locator('[data-chosen-pool]').waitFor();
    const current = (step) => page.locator(`li[data-step="${step}"][aria-current="step"]`);
    await pressContinue(current('pool'));
    await current('range').waitFor();
    await pressContinue(current('range'));
    await current('amount').waitFor();
    await page.locator('li[data-step="amount"] [data-pair-balance="ready"]').first().waitFor({ timeout: 30_000 });
    await page.locator('li[data-step="amount"][aria-current="step"] [data-pair-side="1"] input[inputmode="decimal"]').fill('1000');
    await pressContinue(current('amount'));
    const review = page.locator('[data-stage-card="review"] [data-zap-review="live"]');
    await page.locator('[data-stage-card="review"] [data-zap-review="live"][data-zap-review-stage="failed"]').waitFor({ timeout: 30_000 });
    assert.equal(declined, 1, 'the switch to Base declined');
    assert.equal(await review.locator('[role="alert"][data-error-code="user_rejected"]').innerText(), 'Your wallet declined the network switch.', 'said once, in Review’s body');
    const create = page.locator('[data-journey-footer] [data-create-position]');
    assert.equal(await create.isDisabled(), true, 'nothing to press without a quote');
    assert.equal(await page.locator('#create-reason').innerText(), 'No quote yet.');
    assert.equal(await asksDisabledPress(), false, 'never "Press Create position" under a disabled button');
    // The amounts the position would hold, as his amount step's row has them (the deposit from USDC alone, part swapped).
    const headline = (await review.locator('[data-review-amounts]').getAttribute('title')).split(' + ').map((side) => side.split(' ')[0]);
    const row = page.locator('li[data-step="amount"] .dm-flow-row-summary');
    assert.deepEqual(headline, await row.evaluate((node) => [...node.querySelectorAll(':scope > span')].map((span) => span.title || span.textContent)), 'Review’s headline is his amount step’s row');
    const again = page.locator('[data-journey-footer] [data-create-review-again]');
    assert.equal(await again.innerText(), 'Review again');
    assert.equal(Math.round((await again.boundingBox()).width), Math.round((await footerBox(page)).width), 'the footer’s whole width, under the line');
    await page.locator('[data-stage-card="review"]').screenshot({ path: join(shots(), 'journey-base-quote-failed.png'), animations: 'disabled' });
    assert.equal(s.planned.length, 0, 'no plan asked: the wallet stayed on Robinhood Chain');
    // Review again: the same choices quoted again; the wallet switches this time, and Create position can be pressed.
    await press(again);
    await page.locator('[data-stage-card="review"] [data-zap-review="live"][data-zap-review-stage="reviewed"]').waitFor({ timeout: 30_000 });
    await page.locator('[data-create-position="live"]:not([disabled])').waitFor({ timeout: 30_000 });
    assert.equal(await again.count(), 0, 'gone with the failure');
    assert.equal(await review.locator('[role="alert"]').count(), 0, 'the failure is gone');
    assert.equal(await asksDisabledPress(), false);
    assert.equal(chain.chainNow(), 8453, 'the wallet on Base for the review');
    assert.equal(chain.log.filter((method) => method === 'wallet_switchEthereumChain').length, 1, 'the switch the wallet took');
    assert.deepEqual([s.planned.length, s.planned[0].chainId], [1, 8453]);
    assert.equal(chain.sends.length, 0);
  } finally { await s.close(); }
});

// Added 2026-10-06 (the final check's F5, a second look): a step the wallet sent whose outcome this page can't read is
// locked (never offered again from this review: rev2 review F2), so Create position can't be pressed, and the line under it
// said "Press Create position to try again.". It adds nothing there now: the line under it says what happened and the way on.
test('(w2) a step sent whose receipt can’t be read: Create position stays locked, and the line never asks for a press of it', async () => {
  const chain = createV2Chain({ chainId: 4663, timestamp: now(), balances: { [USDG_RH]: 5_000_000_000n }, pools: [{ pool: POOL_RH, sqrtPriceX96: SQRT, tick: TICK, liquidity: 10n ** 16n }] });
  chain.switchTo(4663);
  const read = createReadStub({ answer: robinhoodRead });
  // The approval's receipt comes back in a form nothing can read.
  const intercept = (method) => (method === 'eth_getTransactionReceipt' && chain.sends.length === 1 ? { result: {} } : undefined);
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [4663], contracts: { 4663: contractsFor(4663) }, planner: robinhoodPlanner([]), intercept,
    // The unreadable receipt must also come from the local node, which now follows sent transactions independently of
    // the wallet. A healthy node receipt would legitimately confirm this approval instead of exercising the unknown lock.
    routes: [confirmationRoute({ request: async (method, params) => (await intercept(method, params)) ?? chain.request(method, params) }), (request, url) => read.handle(request, url) ?? undefined], artwork: true,
  });
  try {
    const page = s.page;
    await toReview(page);
    const reviewed = page.locator('[data-stage-card="review"] [data-zap-review="live"][data-zap-review-stage="reviewed"]');
    await reviewed.locator('[data-wallet-step="approve"][data-step-status="ready"]').waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('#create-reason').innerText(), 'Your wallet will ask you to confirm each step.');
    await page.locator('[data-create-position="live"]:not([disabled])').click();
    const said = page.locator('[data-journey-footer] [role="alert"]');
    await said.waitFor({ timeout: 30_000 });
    assert.equal(await said.innerText(), 'Sent to your wallet. Check your wallet’s activity to see how it went: nothing more is sent from here.');
    assert.equal(await page.locator('[data-journey-footer] [data-create-position]').isDisabled(), true, 'never offered again from this review');
    assert.equal(await page.locator('#create-reason').innerText(), '', 'never "Press Create position to try again." under it');
    assert.equal(await page.locator('[data-create-review-again]').count(), 0, 'nothing to quote again: the step may run');
    assert.equal(chain.sends.length, 1, 'the approval alone');
  } finally { await s.close(); }
});

/**
 * Added 2026-10-14 (incident C3: waiting never locks). The confirmation route as a test makes it refuse: by the order each
 * transaction is first asked about (0 the approval, 1 the create), a list of answers taken one per question, or a
 * function of the question (its asks so far and when it was first asked); `hang` answers nothing for 12 s (the page gives
 * up at 10 s). Past the list, or when the function says nothing, the real route answers.
 */
function refusingConfirmation(plan, seen) {
  return async (request, url) => {
    if (url.pathname !== '/api/chain/v1/confirmation') return undefined;
    const body = await request.clone().json().catch(() => null);
    if (!body?.hash) return undefined;
    if (!seen.has(body.hash)) seen.set(body.hash, { index: seen.size, asked: 0, refused: 0, since: Date.now() });
    const entry = seen.get(body.hash);
    entry.asked += 1;
    const step = plan[entry.index];
    const answer = typeof step === 'function' ? step(entry) : step?.[entry.asked - 1];
    if (!answer) return undefined;
    entry.refused += 1;
    if (answer === 'hang') return new Promise((done) => setTimeout(() => done(Response.json({ v: 1, error: 'rpc_unavailable' }, { status: 502 })), 12_000));
    return Response.json({ v: 1, error: answer.error }, { status: answer.status, headers: answer.retryAfter ? { 'Retry-After': String(answer.retryAfter) } : {} });
  };
}

// Added 2026-10-14 (incident C3: waiting never locks; the owner's design §2.1, decision D2). A refused, lost or unanswered
// confirmation read while his approval and his create wait for their blocks locked the step with "Sent to your wallet…",
// although both succeeded, and the second step could not follow. Now a failed read is asked again; after two missed reads
// his own wallet is asked too; after 20 s the step says it is sent and still waiting, with its explorer link; and the step
// goes on by itself when any source answers. Nothing is sent twice.
for (const run of ['refused, lost and unanswered', 'a resting node, then a route that refuses while the wallet cannot read']) test(`(c3) his journey on Robinhood Chain with the confirmation route ${run}: never "Sent to your wallet…", both steps confirmed, his created view`, async () => {
  const chain = createV2Chain({ chainId: 4663, timestamp: now(), balances: { [USDG_RH]: 5_000_000_000n }, pools: [{ pool: POOL_RH, sqrtPriceX96: SQRT, tick: TICK, liquidity: 10n ** 16n }] });
  chain.switchTo(4663);
  const read = createReadStub({ answer: robinhoodRead });
  const seen = new Map();
  const second = run.startsWith('refused');
  const plan = second
    // The approval: a visitor refusal (429, 1 s), then a failure that names no wait (502). The create: nothing for 12 s.
    ? [[{ status: 429, error: 'rate_limited', retryAfter: 1 }, { status: 502, error: 'rpc_unavailable' }], ['hang']]
    // The approval: the node away (503, 60 s). The create: refused (429, 2 s) for its first 24 s.
    : [[{ status: 503, error: 'source_unavailable', retryAfter: 60 }], (entry) => (Date.now() - entry.since < 24_000 ? { status: 429, error: 'rate_limited', retryAfter: 2 } : undefined)];
  // In the second run the wallet cannot read the create's receipt while the route refuses it: only the route ends that wait.
  const blocked = (hash) => !second && seen.get(hash)?.index === 1 && Date.now() - seen.get(hash).since < 24_000;
  const walletReads = [];
  const intercept = (method, params) => {
    if (method === 'eth_getTransactionReceipt') walletReads.push(params[0]);
    return method === 'eth_getTransactionReceipt' && blocked(params[0]) ? { error: { code: -32603, message: 'Internal JSON-RPC error.' } } : undefined;
  };
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [4663], contracts: { 4663: contractsFor(4663) }, planner: robinhoodPlanner([]), intercept,
    routes: [refusingConfirmation(plan, seen), (request, url) => read.handle(request, url) ?? undefined], artwork: true,
  });
  try {
    const page = s.page;
    await toReview(page);
    const reviewed = page.locator('[data-stage-card="review"] [data-zap-review="live"][data-zap-review-stage="reviewed"]');
    await reviewed.locator('[data-wallet-step="approve"][data-step-status="ready"]').waitFor({ timeout: 30_000 });
    await page.evaluate(() => {
      window.__dominoLocked = false;
      new MutationObserver(() => { if (document.body.innerText.includes('Sent to your wallet')) window.__dominoLocked = true; }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await page.locator('[data-create-position="live"]:not([disabled])').click();
    if (!second) {
      // The create still not seen after 20 s: said so, with its explorer page, and read on.
      const note = reviewed.locator('[data-wallet-step="action"][data-step-status="sent"] .dm-flow-wstep-note', { hasText: 'Sent. Still waiting to see it on the network.' });
      await note.waitFor({ timeout: 40_000 });
      const link = reviewed.locator('[data-wallet-step="action"] a[data-step-explorer]');
      assert.match(await link.getAttribute('href'), /\/tx\/0x[0-9a-f]{64}$/);
      assert.equal(await link.innerText(), 'View on the explorer');
    }
    await page.locator('[data-created-position]').waitFor({ timeout: 90_000 });
    assert.equal(await page.evaluate(() => window.__dominoLocked), false, 'never "Sent to your wallet…": no step locked');
    assert.equal(chain.sends.length, 2, 'the approval and the create, each once');
    const [approval, create] = [...seen.values()].sort((a, b) => a.index - b.index);
    assert.ok(approval.refused >= 1 && create.refused >= 1, 'each wait met the refusals');
    if (second) assert.ok(walletReads.length >= 1, 'two missed reads asked the wallet, read-only');
    else assert.ok(create.asked > create.refused, 'the create came through the route once it answered');
  } finally { await s.close(); }
});

// Added 2026-10-06 (the owner's point 3: Base and Arbitrum One came "dry", "like Robinhood Chain"). VIRTUAL on Base, as DEX
// Screener answered for it that day: Uniswap v4 pools by their id, a v3 pool by its address, another exchange beside them,
// and the token's image. chain-pools lists four pools; a v3 and a v4 pool share a pair and a fee.
const VIRTUAL_BASE = '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const V3_VIRTUAL_WETH = '0x9c087eb773291e50cf6c6a90ef0f4500e349b903';
const VIRTUAL_POOLS = {
  eth: { dex: 4, currency0: ZERO, currency1: VIRTUAL_BASE, fee: 3000, tickSpacing: 60, hooks: ZERO },
  wethV4: { dex: 4, currency0: VIRTUAL_BASE, currency1: WETH_BASE, fee: 3000, tickSpacing: 60, hooks: ZERO },
  wethV3: { dex: 3, currency0: VIRTUAL_BASE, currency1: WETH_BASE, fee: 3000, tickSpacing: 60, hooks: ZERO },
  usdc: { dex: 4, currency0: VIRTUAL_BASE, currency1: USDC_BASE, fee: 3000, tickSpacing: 60, hooks: ZERO },
};
const V3_KEY = `0x${'0'.repeat(24)}${V3_VIRTUAL_WETH.slice(2)}`;
const VIRTUAL_IMAGE = 'https://cdn.dexscreener.com/cms/images/virtualprotocolmark';
const MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#1c9aa8"/><circle cx="32" cy="32" r="14" fill="#e8fbfd"/></svg>';
const BASE_TOKENS = [
  { address: ZERO, symbol: 'ETH', name: 'Ether', decimals: 18, sources: ['profile'] },
  { address: WETH_BASE, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, sources: ['profile'] },
  { address: USDC_BASE, symbol: 'USDC', name: 'USD Coin', decimals: 6, sources: ['profile', 'uniswap_default_list'] },
  { address: VIRTUAL_BASE, symbol: 'VIRTUAL', name: 'Virtual Protocol', decimals: 18, sources: ['uniswap_default_list'] },
];
const virtualReads = () => createChainReads({
  chainId: 8453,
  tokens: BASE_TOKENS,
  pools: [
    { pool: VIRTUAL_POOLS.eth, sqrtPriceX96: SQRT_BASE, tick: TICK_BASE, liquidity: 10n ** 18n },
    { pool: VIRTUAL_POOLS.wethV4, sqrtPriceX96: SQRT_BASE, tick: TICK_BASE, liquidity: 10n ** 17n },
    { pool: VIRTUAL_POOLS.wethV3, address: V3_VIRTUAL_WETH, sqrtPriceX96: SQRT_BASE, tick: TICK_BASE, liquidity: 10n ** 19n },
    { pool: VIRTUAL_POOLS.usdc, sqrtPriceX96: SQRT_BASE, tick: TICK_BASE, liquidity: 10n ** 16n },
  ],
});
/** DEX Screener for VIRTUAL on Base: its pairs (Uniswap's and another exchange's) and its image. */
function virtualDex(url) {
  if (url.startsWith(VIRTUAL_IMAGE)) return { image: MARK };
  if (url !== `https://api.dexscreener.com/token-pairs/v1/base/${VIRTUAL_BASE}`) return undefined;
  const pair = (pairAddress, quote, liquidity, volume, labels) => ({ chainId: 'base', dexId: 'uniswap', ...(labels ? { labels } : {}), pairAddress, baseToken: { address: VIRTUAL_BASE, symbol: 'VIRTUAL' }, quoteToken: { address: quote }, liquidity: { usd: liquidity }, volume: { h24: volume }, info: { imageUrl: `${VIRTUAL_IMAGE}?width=800` } });
  return [
    pair(V3_VIRTUAL_WETH, WETH_BASE, 166296.81, 21085.45, ['v3']),
    pair(poolIdOf(VIRTUAL_POOLS.usdc), USDC_BASE, 136159.17, 103475.58, ['v4']),
    pair(poolIdOf(VIRTUAL_POOLS.eth), ZERO, 35138.92, 8844.96, ['v4']),
    { ...pair('0x3f0296bf652e19bca772ec3df08b32732f93014a', WETH_BASE, 381753.71, 2580921.35), dexId: 'aerodrome' },
  ];
}

test('(h) Base like Robinhood Chain: found by name with a pulse while Base is searched, its icon, its pools with TVL, 24h volume and APR, the largest first, one row for a v3 and a v4 pool of one pair and fee', async () => {
  const chain = createV2Chain({ chainId: 8453, timestamp: now() });
  chain.switchTo(4663);
  const reads = virtualReads();
  // Base's search answers once the test has seen the pulse.
  let release = () => {};
  const held = new Promise((done) => { release = done; });
  const chainReads = { calls: reads.calls, answer: async (route, request) => { if (route === 'chain-tokens') await held; return reads.answer(route, request); } };
  const read = createReadStub({ answer: robinhoodRead });
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [8453], contracts: { 8453: contractsFor(8453) }, connect: false,
    routes: [(request, url) => read.handle(request, url) ?? undefined], chainReads, dex: virtualDex,
  });
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    const search = page.getByRole('combobox', { name: 'Search a token' });
    // A word of the token's name, which Robinhood Chain's list does not know: while Base is still searched, the icon
    // pulses and the list says so instead of "no token".
    await search.fill('virtual protocol');
    await page.locator('[data-token-search] .dm-flow-combo[data-searching]').waitFor();
    assert.match(await page.locator('[data-token-search] .dm-flow-combo-icon').getAttribute('class'), /animate-pulse-soft/);
    assert.equal(await page.locator('.dm-flow-listbox-empty').innerText(), 'Searching…');
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shots(), 'journey-base-searching.png') });
    release();
    const hit = page.locator(`[data-token-network-option="8453:${VIRTUAL_BASE}"]`);
    await hit.waitFor();
    await page.locator('[data-token-search] .dm-flow-combo:not([data-searching])').waitFor();
    assert.equal((await hit.locator('[data-chain-chip="8453"]').innerText()).trim(), 'Base');
    // Its symbol: Robinhood Chain's VIRTUAL and Base's are both exact matches, so they are listed together, Robinhood
    // Chain's first, each with its network's tag.
    await search.fill('virtual');
    await hit.waitFor();
    await page.locator('[data-token-search] .dm-flow-combo:not([data-searching])').waitFor();
    // Changed on purpose 2026-10-06 (review: rugged's "virtual"): Robinhood Chain's VIRTUAL (the catalogue's) has no
    // liquidity DEX Screener knows of, so Base's real one goes first, and is the one Enter takes (clearly the real one:
    // its logo, and liquidity where the other has none).
    await page.waitForFunction((first) => document.querySelector('[role="listbox"] [role="option"]')?.getAttribute('data-token-network-option') === first, `8453:${VIRTUAL_BASE}`);
    const order = await page.locator('[role="listbox"] [role="option"]').evaluateAll((options) => options.map((option) => option.getAttribute('data-token-network-option') ?? `rh:${option.querySelector('.dm-flow-hit-name')?.textContent}`));
    assert.deepEqual(order.slice(0, 2), [`8453:${VIRTUAL_BASE}`, 'rh:VIRTUAL']);
    assert.equal(await page.locator('[role="listbox"] [role="option"]').nth(1).locator('[data-token-liquidity="0"]').innerText(), 'No liquidity found');
    await hit.and(page.locator('[data-active]')).waitFor();
    assert.equal(await search.getAttribute('aria-activedescendant'), await hit.getAttribute('id'), 'Enter takes Base’s');
    // Its icon: the token's own image on Base, from DEX Screener, through the same mark Robinhood Chain's tokens use.
    await hit.locator('img[data-token-mark="provider"]').waitFor();
    assert.ok(s.dexAsked.some((url) => url === `https://api.dexscreener.com/token-pairs/v1/base/${VIRTUAL_BASE}`), 'asked by Base’s own name');
    await page.screenshot({ path: join(shots(), 'journey-base-search.png') });
    await hit.click();
    const pools = page.locator('[data-picker="pool"][data-picker-network="8453"]');
    await pools.locator('li[data-pool-key]').first().waitFor({ timeout: 30_000 });
    await pools.locator('[data-row-apr="estimate"]').nth(2).waitFor();
    // The largest reported TVL first; Base's v4 VIRTUAL/WETH pool is the v3 one's twin (one pair, one fee), shown once.
    const keys = await pools.locator('li[data-pool-key]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-pool-key')));
    assert.deepEqual(keys, [V3_KEY, poolIdOf(VIRTUAL_POOLS.usdc), poolIdOf(VIRTUAL_POOLS.eth)]);
    const row = (key) => pools.locator(`li[data-pool-key="${key}"]`);
    const texts = async (key) => (await row(key).locator('[data-provider-figure], [data-row-apr]').allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim());
    assert.deepEqual(await texts(V3_KEY), ['TVL $166.3K', '24h volume $21.1K', 'APR 13.9% est.']);
    assert.deepEqual(await texts(poolIdOf(VIRTUAL_POOLS.usdc)), ['TVL $136.2K', '24h volume $103.5K', 'APR 83.2% est.']);
    assert.deepEqual(await texts(poolIdOf(VIRTUAL_POOLS.eth)), ['TVL $35.1K', '24h volume $8.8K', 'APR 27.6% est.']);
    assert.equal(await row(V3_KEY).locator('[data-provider="dexscreener"][data-provider-figure="attributed"]').count(), 2, 'attributed to the provider, as Robinhood Chain’s are');
    // Changed on purpose 2026-10-06 (rugged97's delta of 6 Oct §4: the provider's number, with its name and the time it
    // was read): DEX Screener named in each figure's title.
    for (const title of await row(V3_KEY).locator('[data-provider-figure]').evaluateAll((cells) => cells.map((cell) => cell.getAttribute('title')))) {
      assert.match(title, /^Reported by DEX Screener, retrieved \d\d:\d\d:\d\d UTC, \d{4}-\d\d-\d\d\. Provider-reported, not reconciled with chain data\.$/);
    }
    // Changed on purpose 2026-10-30 (QA round 2, N105): the APR estimate has every "est." figure's one title; its TVL and
    // 24h volume above still name DEX Screener and when they were read.
    assert.equal(await row(V3_KEY).locator('[data-row-apr="estimate"] [title]').getAttribute('title'), 'Estimate from the last 24 hours of trading fees. Your earnings depend on your price range.');
    assert.match(await row(V3_KEY).innerText(), /VIRTUAL\s*\/\s*WETH/);
    assert.equal(await pools.getByText(/v3|v4/).count(), 0, 'no version jargon');
    assert.equal(chain.multicalls.length, 0, 'nothing read through the wallet');
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(shots(), 'journey-base-pools.png') });
    // A phone: the pair's name wraps instead of being cut. Changed on purpose 2026-10-06 (the review of the next update: from
    // 900 to 1023 px a row read "VIRTUAL /", "ETH", its chips over the figures): at every width a list is drawn at
    // (ROW_WIDTHS), each pair is whole on one line, and each chip inside its row, clear of the figures.
    const cdp = await page.context().newCDPSession(page);
    for (const at of ROW_WIDTHS) {
      await drawnAt(page, cdp, at);
      for (const key of keys) {
        const pair = row(key).locator('.dm-flow-pool-pair');
        assert.ok(await pair.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), `${key} at ${widthName(at)}: the pair is shown whole`);
        assert.equal(await pair.evaluate((node) => Math.round(node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight))), 1, `${key} at ${widthName(at)}: on one line`);
      }
      assert.deepEqual(await chipsOf(pools), keys.map(() => ({ inside: true, clear: true, beside: at.beside })), widthName(at));
    }
    await page.screenshot({ path: join(shots(), 'journey-base-pools-phone.png') });
  } finally { await s.close(); }
});

// Added 2026-10-31 (QA round 2 follow-ups, R18 and N57): the rows by keyboard. An arrow moved to the next radio and
// chose it at once, the list folded and the focus fell to the page's start; the arrows now move through the rows
// (wrapping) without choosing, Space chooses the row in focus, and the focus lands on the chosen pool's Change pool.
// Change pool by a click leaves the focus on Keep this pool; from the keyboard, on the search.
test('(h4) Base’s rows by keyboard: the arrows move without choosing, Space chooses, and the focus is kept through Change pool', async () => {
  const chain = createV2Chain({ chainId: 8453, timestamp: now() });
  chain.switchTo(4663);
  const read = createReadStub({ answer: robinhoodRead });
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [8453], contracts: { 8453: contractsFor(8453) }, connect: false,
    routes: [(request, url) => read.handle(request, url) ?? undefined], chainReads: virtualReads(), dex: virtualDex,
  });
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    await page.getByRole('combobox', { name: 'Search a token' }).fill('virtual protocol');
    const hit = page.locator(`[data-token-network-option="8453:${VIRTUAL_BASE}"]`);
    await hit.waitFor();
    await page.locator('[data-token-search] .dm-flow-combo:not([data-searching])').waitFor();
    await hit.click();
    const pools = page.locator('[data-picker="pool"][data-picker-network="8453"]');
    const radios = pools.locator('input[name="pool-option"]');
    await radios.nth(2).waitFor({ timeout: 30_000 });
    const keys = await pools.locator('li[data-pool-key]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-pool-key')));
    const at = () => radios.evaluateAll((nodes) => nodes.indexOf(document.activeElement));
    await radios.first().focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    assert.equal(await at(), 2, 'two rows down');
    assert.equal(await page.locator('[data-chosen-pool]').count(), 0, 'an arrow chooses nothing');
    await page.keyboard.press('ArrowDown');
    assert.equal(await at(), 0, 'past the last row, the first');
    await page.keyboard.press('ArrowUp');
    assert.equal(await at(), 2, 'and back up to the last');
    assert.equal(await radios.evaluateAll((nodes) => nodes.filter((node) => node.checked).length), 0, 'still nothing chosen');
    await page.keyboard.press('Space');
    const chosen = page.locator('[data-chosen-pool]');
    await chosen.waitFor();
    assert.equal((await chosen.getAttribute('data-chosen-pool')).toLowerCase(), keys[2].toLowerCase(), 'the row in focus');
    await focusedOn(page, '[data-chosen-pool] button');
    await chosen.locator('button').click();
    await focusedOn(page, '[data-keep-pool]');
    await page.locator('[data-keep-pool]').click();
    await focusedOn(page, '[data-chosen-pool] button');
    await page.keyboard.press('Enter');
    await focusedOn(page, '#create-token-search');
    assert.equal(chain.sends.length, 0);
  } finally { await s.close(); }
});

// Added 2026-10-06 (rugged97's delta of 6 Oct §4: "Com mais de 10 min, não aparece"): Base's rows show DEX Screener's
// figures for ten minutes after they were read, never after. A minute before, VIRTUAL is asked about again, so a fresh
// answer keeps the rows full past the ten minutes; once an answer brings nothing about the pools, their figures go at
// their own ten minutes, each a dash saying so, the APR with them. The page's clock is Playwright's, jumped forward.
test('(h2) Base’s rows: DEX Screener’s figures for ten minutes after they were read, never after; asked again a minute before', async () => {
  const chain = createV2Chain({ chainId: 8453, timestamp: now() });
  chain.switchTo(4663);
  const read = createReadStub({ answer: robinhoodRead });
  const PAIRS = `https://api.dexscreener.com/token-pairs/v1/base/${VIRTUAL_BASE}`;
  // VIRTUAL's pairs while `listed`; after that an answer that names none of them.
  let listed = true;
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [8453], contracts: { 8453: contractsFor(8453) }, connect: false, clock: true,
    routes: [(request, url) => read.handle(request, url) ?? undefined], chainReads: virtualReads(), dex: (url) => (url === PAIRS && !listed ? [] : virtualDex(url)),
  });
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    await page.getByRole('combobox', { name: 'Search a token' }).fill('virtual protocol');
    const hit = page.locator(`[data-token-network-option="8453:${VIRTUAL_BASE}"]`);
    await hit.waitFor();
    await hit.click();
    const pools = page.locator('[data-picker="pool"][data-picker-network="8453"]');
    await pools.locator('[data-row-apr="estimate"]').nth(2).waitFor({ timeout: 30_000 });
    const v3 = pools.locator(`li[data-pool-key="${V3_KEY}"]`);
    const texts = async () => (await v3.locator('[data-provider-figure], [data-row-apr]').allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim());
    const tvlTitle = () => v3.locator('[data-provider-figure]').first().getAttribute('title');
    const asked = () => s.dexAsked.filter((url) => url === PAIRS).length;
    const until = async (done, what) => {
      for (let i = 0; i < 200 && !(await done()); i++) await page.waitForTimeout(50);
      assert.ok(await done(), what);
    };
    assert.deepEqual(await texts(), ['TVL $166.3K', '24h volume $21.1K', 'APR 13.9% est.']);
    const first = await tvlTitle();
    const before = asked();
    // Nine and a half minutes on: asked again (due a minute before the ten), and its answer, read now, is what shows.
    await page.clock.fastForward('09:30');
    await until(() => asked() === before + 1, 'VIRTUAL asked about again before its figures went');
    await until(async () => (await tvlTitle()) !== first, 'the second answer’s time in the title');
    assert.match(await tvlTitle(), /^Reported by DEX Screener, retrieved \d\d:\d\d:\d\d UTC, \d{4}-\d\d-\d\d\./);
    // Ten and a half minutes after the first answer: still figures, the second answer's.
    await page.clock.fastForward('01:00');
    await page.waitForTimeout(300);
    assert.deepEqual(await texts(), ['TVL $166.3K', '24h volume $21.1K', 'APR 13.9% est.'], 'never a dash while a fresh answer stands');
    // The next answer names none of the pools: ten minutes after the second answer its figures go, each a dash saying so.
    listed = false;
    await page.clock.fastForward('08:30');
    await until(() => asked() === before + 2, 'asked again a minute before the second answer’s ten minutes');
    await page.waitForTimeout(300);
    assert.deepEqual(await texts(), ['TVL $166.3K', '24h volume $21.1K', 'APR 13.9% est.'], 'shown until its ten minutes are up');
    await page.clock.fastForward('01:00');
    await v3.locator('[data-provider-reason="dexscreener_too_old"]').nth(1).waitFor();
    assert.deepEqual(await texts(), ['TVL —', '24h volume —', 'APR —']);
    const old = 'DEX Screener’s figures for this pool are more than 10 minutes old.';
    assert.deepEqual(await v3.locator('[data-provider-figure]').evaluateAll((cells) => cells.map((cell) => [cell.getAttribute('title'), cell.querySelector('[aria-label]')?.getAttribute('aria-label') ?? null])), [[old, old], [old, old]]);
    assert.equal(await v3.locator('[data-row-apr="none"] [title]').getAttribute('title'), old);
    assert.equal(await pools.locator('[data-provider-figure="attributed"]').count(), 0, 'no row keeps a figure past its ten minutes');
    // The rows, re-sorted as they came, fade in again (flow.css .dm-flow-pool-rows) before the picture.
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(shots(), 'journey-base-pools-too-old.png') });
  } finally { await s.close(); }
});

// Added 2026-10-06 (rugged97's delta of 6 Oct §4): the pool chosen keeps the figures its row showed, and the preview beside
// the steps shows them for their ten minutes; after them it shows none (components/create/PositionPreview.tsx).
test('(h3) a Base pool chosen: the preview shows its DEX Screener figures for their ten minutes, then none', async () => {
  const chain = createV2Chain({ chainId: 8453, timestamp: now() });
  chain.switchTo(4663);
  const read = createReadStub({ answer: robinhoodRead });
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [8453], contracts: { 8453: contractsFor(8453) }, connect: false, clock: true,
    routes: [(request, url) => read.handle(request, url) ?? undefined], chainReads: virtualReads(), dex: virtualDex,
  });
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    await page.getByRole('combobox', { name: 'Search a token' }).fill('virtual protocol');
    const hit = page.locator(`[data-token-network-option="8453:${VIRTUAL_BASE}"]`);
    await hit.waitFor();
    await hit.click();
    const pools = page.locator('[data-picker="pool"][data-picker-network="8453"]');
    await pools.locator('[data-row-apr="estimate"]').nth(2).waitFor({ timeout: 30_000 });
    await pools.locator(`li[data-pool-key="${V3_KEY}"] input[name="pool-option"]`).click();
    await page.locator(`[data-chosen-pool="${V3_KEY}"]`).waitFor();
    const stats = page.locator('aside[data-preview] .dm-flow-pv-stats');
    // Changed on purpose 2026-10-30 (QA round 2, N52, the owner's option b): the label says it is the pool's yearly fee rate.
    assert.match(await stats.innerText(), /In this pool\s*\$166\.3K[\s\S]*Pool fee rate, yearly\s*13\.9% est\./);
    await page.clock.fastForward('09:30');
    await page.waitForTimeout(300);
    assert.match(await stats.innerText(), /\$166\.3K/, 'shown for its ten minutes');
    await page.clock.fastForward('01:00');
    await stats.waitFor({ state: 'detached' });
    assert.match(await page.locator('aside[data-preview] .dm-flow-pv-pair').innerText(), /VIRTUAL\s*\/\s*WETH/, 'the pool stays, its figures gone');
  } finally { await s.close(); }
});

/** read-v1's answer for a token that has no contract on Robinhood Chain. */
const noContractOnRobinhood = (address) => readFileSync(join(READ_FIXTURES, 'token.missing-contract.json'), 'utf8').replaceAll(FIXTURE_TOKEN, address);
/** read-v1's answer for a token the read could not get through to for the moment (an RPC error): unknown, unread. */
const unreadOnRobinhood = (address) => readFileSync(join(READ_FIXTURES, 'token.unavailable.json'), 'utf8').replaceAll(FIXTURE_TOKEN, address);

test('(i) a pasted address: named on the network where it is a token, left out where it is not, a plain row only where nothing could be read; choosing it reads its pools once', async () => {
  const chain = createV2Chain({ chainId: 8453, timestamp: now() });
  chain.switchTo(4663);
  const reads = virtualReads();
  const arbitrum = createChainReads({ chainId: 42161, tokens: [] });
  const UNREAD = '0x7777777777777777777777777777777777777777';
  const NOWHERE = '0x6666666666666666666666666666666666666666';
  const FLAKY = '0x5555555555555555555555555555555555555555';
  // Either network's read of UNREAD fails for the moment; everything else is answered (VIRTUAL is Base's only).
  const chainReads = {
    calls: reads.calls,
    answer: (route, request) => {
      if (route === 'chain-pools' && request.token === UNREAD) return { status: 503, body: { error: 'upstream_unavailable' } };
      return (request.chainId === 42161 ? arbitrum : reads).answer(route, request);
    },
  };
  const read = createReadStub({
    answer: (route, body) => {
      if (route === 'token' && body.token === FLAKY) return unreadOnRobinhood(body.token);
      return route === 'token' && body.token !== ZERO && body.token !== USDG_RH ? noContractOnRobinhood(body.token) : robinhoodRead(route, body);
    },
  });
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [8453, 42161], contracts: { 8453: contractsFor(8453), 42161: contractsFor(42161) }, connect: false,
    routes: [(request, url) => read.handle(request, url) ?? undefined], chainReads, dex: virtualDex,
  });
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    const search = page.getByRole('combobox', { name: 'Search a token' });
    await search.fill(VIRTUAL_BASE.toUpperCase().replace('0X', '0x'));
    const hit = page.locator(`[data-token-network-option="8453:${VIRTUAL_BASE}"]`);
    await hit.waitFor();
    await page.locator('[data-token-search] .dm-flow-combo:not([data-searching])').waitFor();
    assert.match(await hit.innerText(), /VIRTUAL/, 'named by its symbol');
    assert.equal(await page.locator('[data-token-option], [data-token-network-option^="42161:"]').count(), 0, 'no Robinhood Chain row and no Arbitrum One row: no such token there');
    assert.equal(await page.getByText('Look up this address').count(), 0);
    assert.equal(await hit.getAttribute('data-active'), '', 'the one token named: what Enter takes');
    await page.screenshot({ path: join(shots(), 'journey-paste-named.png') });
    // Nothing named, two networks not read: the plain row on each of them, the way on there.
    await search.fill(UNREAD);
    await page.locator(`[data-token-network-option="8453:${UNREAD}"]`).waitFor();
    await page.locator('[data-token-search] .dm-flow-combo:not([data-searching])').waitFor();
    assert.equal(await page.locator(`[data-token-network-option="42161:${UNREAD}"]`).count(), 1);
    assert.equal(await page.getByText('Look up this address').count(), 2);
    assert.equal(await page.locator('[data-token-option]').count(), 0);
    assert.equal(await page.locator('[role="option"][data-active]').count(), 0, 'two networks to look it up on: Enter waits for the person’s choice');
    // Changed on purpose 2026-10-30 (QA round 2, N98): no metadata and no pool on either network is "No token at this
    // address.", never the networks' token data being "unavailable right now" (the address could not be used anyway).
    await search.fill(NOWHERE);
    await page.locator('.dm-flow-listbox-empty:not([data-searching])').waitFor();
    assert.equal(await page.locator('.dm-flow-listbox-empty').innerText(), 'No token at this address.');
    assert.equal(await page.locator('[data-search-unavailable]').count(), 0);
    // Added 2026-10-06 (review): Robinhood Chain's read could not get through to the address for the moment (an RPC
    // error), and no other network names it: unread, never "no token". Its plain row stays, the way on there.
    await search.fill(FLAKY);
    const flaky = page.locator(`[data-token-option="${FLAKY}"]`);
    await flaky.waitFor();
    await page.locator('[data-token-search] .dm-flow-combo:not([data-searching])').waitFor();
    assert.equal(await flaky.locator('.dm-flow-hit-name').innerText(), 'Look up this address');
    assert.equal(await page.getByText('No token at this address.').count(), 0);
    assert.equal(await page.locator('[data-token-network-option]').count(), 0, 'no token there on Base or Arbitrum One');
    await page.screenshot({ path: join(shots(), 'journey-paste-unread.png') });
    // The named token chosen: its pools come from the answer the search already had.
    await search.fill(VIRTUAL_BASE);
    await hit.click();
    const pools = page.locator('[data-picker="pool"][data-picker-network="8453"]');
    await pools.locator('li[data-pool-key]').first().waitFor({ timeout: 30_000 });
    assert.equal(reads.calls.filter((call) => call.route === 'chain-pools' && call.request.token === VIRTUAL_BASE).length, 1, 'one chain-pools read for the paste and the pools');
  } finally { await s.close(); }
});

test('(j) public discovery stays available while the plan route recovers quietly from a failed capabilities read', async () => {
  const chain = createV2Chain({ chainId: 8453, timestamp: now() });
  chain.switchTo(4663);
  const reads = createChainReads({ chainId: 8453, tokens: BASE_TOKENS });
  const read = createReadStub({ answer: robinhoodRead });
  // Keep execution capabilities unavailable until public discovery has answered; then permit their quiet recovery.
  let asked = 0;
  let recover = false;
  let recovered = false;
  const plan = (request, url) => {
    if (url.pathname !== '/api/position-plan/v1/capabilities') return undefined;
    asked += 1;
    if (!recover) return new Response('{"error":"bridge_unavailable"}', { status: 503, headers: { 'Content-Type': 'application/json' } });
    recovered = true;
    return new Response(JSON.stringify({ contractVersion: '1.0.0-rc.2', dataMode: 'live', enabledRoutes: ['plan'] }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Domino-Position-Plan-Contract': '1.0.0-rc.2' } });
  };
  const s = await openJourney(browser, chain, { dist: WALLET_V2_DIST, connect: false, routes: [plan, (request, url) => read.handle(request, url) ?? undefined], chainReads: reads, artwork: true });
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    await page.getByRole('combobox', { name: 'Search a token' }).fill('usdc');
    // Readable preview networks remain discoverable while execution is unavailable, with their own identities.
    const hit = page.locator(`[data-token-network-option="8453:${USDC_BASE}"]`);
    await hit.waitFor({ timeout: 20_000 });
    assert.equal((await hit.locator('[data-chain-chip="8453"]').innerText()).trim(), 'Base');
    await page.locator('[data-token-search] .dm-flow-combo:not([data-searching])').waitFor();
    assert.deepEqual([8453, 42161].map((chainId) => reads.calls.some((call) => call.route === 'chain-tokens' && call.request.chainId === chainId)), [true, true], 'Base and Arbitrum One both searched');
    assert.ok(asked >= 1, 'execution capabilities failed while public discovery answered');
    assert.equal(recovered, false, 'discovery did not need the execution gate to recover');
    recover = true;
    await until(() => recovered, 'execution capabilities asked again after their quiet wait');
    assert.ok(asked >= 2, 'the plan route’s word asked again');
    assert.ok(await hit.isVisible(), 'the same Base token stays available after recovery');
    assert.deepEqual(s.planned, [], 'search and recovery never request a financial plan');
    assert.equal(chain.log.filter((method) => method === 'wallet_switchEthereumChain').length, 0, 'public discovery never moves the wallet');
  } finally { await s.close(); }
});

// Added 2026-10-31 (QA round 2 follow-ups, R10 and N102): step 1's Top pools are Robinhood Chain's list, so each pool names
// its network from the first paint, on its fee's line; it waited for the other networks' answer, then pushed the fee down a
// line. Once other networks are searched too, the search's placeholder is Markets' own, word for word.
test('(j2) Top pools name Robinhood Chain from the first paint and stay put when the other networks answer; the search says what Markets says', async () => {
  const chain = createV2Chain({ chainId: 8453, timestamp: now() });
  chain.switchTo(4663);
  const reads = createChainReads({ chainId: 8453, tokens: BASE_TOKENS });
  const read = createReadStub({ answer: robinhoodRead });
  // The networks' word is held until the rows have been measured.
  let release = () => {};
  const held = new Promise((done) => { release = done; });
  const plan = async (request, url) => {
    if (url.pathname !== '/api/position-plan/v1/capabilities') return undefined;
    await held;
    return new Response(JSON.stringify({ contractVersion: '1.0.0-rc.2', dataMode: 'live', enabledRoutes: ['plan'] }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Domino-Position-Plan-Contract': '1.0.0-rc.2' } });
  };
  const s = await openJourney(browser, chain, { dist: WALLET_V2_DIST, connect: false, routes: [plan, (request, url) => read.handle(request, url) ?? undefined], chainReads: reads, artwork: true });
  try {
    const page = s.page;
    const top = page.locator('[data-top-pools]');
    await top.waitFor();
    const rows = () => top.locator('li[data-top-pool]').evaluateAll((items) => items.map((item) => {
      const net = item.querySelector('.dm-flow-pool-net');
      const fee = item.querySelector('[data-fee]').getBoundingClientRect();
      const box = item.getBoundingClientRect();
      return { network: net?.textContent ?? null, together: net !== null && Math.abs(net.getBoundingClientRect().top - fee.top) < 2, top: Math.round(box.top), height: Math.round(box.height) };
    }));
    const search = page.locator('#create-token-search');
    assert.equal(await search.getAttribute('placeholder'), 'Name or address, like USDG', 'the other networks not answered yet');
    const before = await rows();
    assert.ok(before.length > 0, 'Top pools drawn');
    assert.deepEqual(before.map((row) => [row.network, row.together]), before.map(() => ['Robinhood Chain', true]), 'each names its network, beside its fee');
    release();
    await page.waitForFunction(() => document.getElementById('create-token-search')?.getAttribute('placeholder') === 'Search a token on any network', undefined, { timeout: 30_000 });
    assert.deepEqual(await rows(), before, 'nothing moved when the other networks answered');
    // Markets' search, with the same networks searched, says the same.
    await page.evaluate(() => { location.hash = '#/markets'; });
    await page.waitForFunction(() => document.getElementById('markets-catalogue-token')?.getAttribute('placeholder') === 'Search a token on any network', undefined, { timeout: 30_000 });
  } finally { release(); await s.close(); }
});

test('(k) a read that failed for the moment is asked again quietly: the name search while its list is open, the pools once before the wallet is ever asked to move', async () => {
  const chain = createV2Chain({ chainId: 8453, timestamp: now() });
  chain.switchTo(4663);
  const reads = virtualReads();
  // Base's search is busy once, and the token's pools are out once; each is answered when asked again.
  const busy = { 'chain-tokens': 1, 'chain-pools': 1 };
  const refused = [];
  const chainReads = {
    calls: reads.calls,
    answer: (route, request) => {
      if (request.chainId === 8453 && busy[route] > 0 && (route === 'chain-tokens' || request.token === VIRTUAL_BASE)) {
        busy[route] -= 1;
        refused.push(route);
        return route === 'chain-tokens' ? { status: 429, body: { error: 'read_capacity_busy' } } : { status: 503, body: { error: 'upstream_unavailable' } };
      }
      return reads.answer(route, request);
    },
  };
  const read = createReadStub({ answer: robinhoodRead });
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [8453], contracts: { 8453: contractsFor(8453) },
    routes: [(request, url) => read.handle(request, url) ?? undefined], chainReads, dex: virtualDex,
  });
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    await page.getByRole('combobox', { name: 'Search a token' }).fill('virtual protocol');
    const hit = page.locator(`[data-token-network-option="8453:${VIRTUAL_BASE}"]`);
    // While the busy read waits to be asked again, Base is still being searched: never a "no token".
    await page.waitForFunction(() => document.querySelectorAll('[data-searching]').length > 0);
    assert.equal(await page.locator('.dm-flow-listbox-empty').innerText(), 'Searching…');
    await hit.waitFor({ timeout: 20_000 });
    assert.deepEqual([8453, 42161].map((chainId) => reads.calls.filter((call) => call.route === 'chain-tokens' && call.request.chainId === chainId && call.request.query === 'virtual protocol').length), [1, 1], 'one successful answer per network: Base after its retry, Arbitrum through public discovery');
    await hit.click();
    const pools = page.locator('[data-picker="pool"][data-picker-network="8453"]');
    await pools.locator('li[data-pool-key]').first().waitFor({ timeout: 30_000 });
    assert.deepEqual(refused, ['chain-tokens', 'chain-pools'], 'each failed once, and was asked again');
    assert.equal(chain.chainNow(), 4663, 'the wallet never asked to move for the pools');
    assert.equal(chain.log.filter((method) => method === 'wallet_switchEthereumChain').length, 0);
    assert.equal(chain.multicalls.length, 0, 'nothing read through the wallet');
  } finally { await s.close(); }
});

// Added 2026-10-06 (review of the same day): the highlight was a place in the list, and a network's answer arriving above
// it moved it, and Enter's choice, to another token.
const VIRTUAL_RH = '0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31';

test('(l) the hit moved to stays highlighted when another network’s answer arrives above it', async () => {
  const chain = createV2Chain({ chainId: 8453, timestamp: now() });
  chain.switchTo(4663);
  const reads = virtualReads();
  let release = () => {};
  const held = new Promise((done) => { release = done; });
  const chainReads = { calls: reads.calls, answer: async (route, request) => { if (route === 'chain-tokens') await held; return reads.answer(route, request); } };
  const read = createReadStub({ answer: robinhoodRead });
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [8453], contracts: { 8453: contractsFor(8453) }, connect: false,
    routes: [(request, url) => read.handle(request, url) ?? undefined], chainReads, dex: virtualDex,
  });
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    const search = page.getByRole('combobox', { name: 'Search a token' });
    await search.fill('virtual');
    // Robinhood Chain's VIRTUAL (the catalogue's) is listed at once, Base still being searched; the person moves to it.
    const home = page.locator(`[data-token-option="${VIRTUAL_RH}"]`);
    await home.locator('[data-token-liquidity="0"]').waitFor();
    await search.press('ArrowDown');
    await home.and(page.locator('[data-active]')).waitFor();
    release();
    const hit = page.locator(`[data-token-network-option="8453:${VIRTUAL_BASE}"]`);
    await hit.waitFor();
    // Base's answer lands above it: the highlight, and so Enter's choice, stay on the row moved to. (QA round 2, N1: groups
    // follow known liquidity, so Base's row goes above once its DEX figures arrive, a moment after the row itself.)
    await page.waitForFunction((want) => document.querySelector('[role="listbox"] [role="option"]')?.getAttribute('data-token-network-option') === want, `8453:${VIRTUAL_BASE}`, { timeout: 5_000 });
    assert.equal(await home.getAttribute('data-active'), '');
    assert.equal(await hit.getAttribute('data-active'), null);
    assert.equal(await search.getAttribute('aria-activedescendant'), await home.getAttribute('id'));
  } finally { await s.close(); }
});

// Added 2026-10-06 (the review of the next update): with Base offered, "eth" highlighted nothing and Enter did nothing, where
// Robinhood Chain's ETH was taken before. Base's own ETH is no rival of Robinhood Chain's own ETH (lib/create/otherChains.ts
// preselectOf), so Enter takes it again. Its rows then name their network on the fee chip's line, the pair on one line.
const READ_V3_FIXTURES = resolve(import.meta.dirname, '../../../api-contracts/read-v3/fixtures');
/** read-v3's stored routes: Robinhood Chain's native ETH for a text it begins with, as the service searches symbols. */
function storedEth(route, body) {
  const base = JSON.parse(readFileSync(join(READ_V3_FIXTURES, `${route}.json`), 'utf8'));
  if (route === 'overview') Object.assign(base, { selectedToken: body.token ?? null, requestedPoolIds: body.poolIds ?? [] });
  if (route !== 'search') return JSON.stringify(base);
  const eth = { ...base.tokens[0], address: ZERO, value: JSON.parse(readFileSync(join(READ_FIXTURES, 'token.native.json'), 'utf8')) };
  return JSON.stringify({ ...base, query: body.query, tokens: 'eth'.startsWith(String(body.query).trim().toLowerCase()) ? [eth] : [] });
}

/** New position with Base offered, the wallet on Robinhood Chain, which lists its ETH and that ETH's ETH/USDG pool. */
async function ethWithBase() {
  const chain = createV2Chain({ chainId: 8453, timestamp: now() });
  chain.switchTo(4663);
  const reads = createChainReads({ chainId: 8453, tokens: BASE_TOKENS });
  // Its pools: Robinhood Chain's ETH/USDG pool, answered about ETH.
  const answer = (route, body) => (route === 'pools' && body.token === ZERO ? JSON.stringify({ ...JSON.parse(robinhoodRead(route, body)), selectedToken: ZERO }) : robinhoodRead(route, body));
  const read = createReadStub({ answer, stored: storedEth });
  // DEX Screener's pairs for Robinhood Chain's ETH as it answered (tests/support/dexscreener-eth.json); nothing for the rest.
  const ethPairs = JSON.parse(readFileSync(resolve(import.meta.dirname, '../support/dexscreener-eth.json'), 'utf8'));
  return openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [8453], contracts: { 8453: contractsFor(8453) }, connect: false,
    routes: [(request, url) => read.handle(request, url) ?? undefined], chainReads: reads, artwork: true,
    dex: (url) => (url === `https://api.dexscreener.com/token-pairs/v1/robinhood/${ZERO}` ? ethPairs : undefined),
  });
}

// Added 2026-10-06 (the review of the next update: from 900 to 1023 px, and on a tablet held wide, a row's fee chip lay over
// its figures, while the suites measured 1280 alone). V3 has compact desktop density and a full touch scale. These widths cover
// compact desktop and laptop rows with figures beside the pair; a full-scale touch tablet and phone,
// where the narrower row stacks its figures beneath the pair.
const ROW_WIDTHS = [
  { width: 1280, touch: false, root: '10.8px', beside: true },
  { width: 1000, touch: false, root: '10.8px', beside: true },
  { width: 960, touch: false, root: '10.8px', beside: true },
  { width: 1024, touch: true, root: '16px', beside: false },
  { width: 390, touch: false, root: '16px', beside: false },
];
const widthName = ({ width, touch }) => `${width}px${touch ? ' on a touch screen' : ''}`;
/** The page drawn at one of ROW_WIDTHS (`cdp`: the page's own CDP session, for the browser's touch emulation). */
async function drawnAt(page, cdp, at) {
  // Playwright starts Chromium with a fine pointer, including on a headless Linux runner. Disabling an emulation
  // that was never enabled can restore that host's native pointer (none), discarding Playwright's desktop defaults.
  // Change touch mode only when needed; keep the exact root-size and row-layout assertions below.
  const touchEnabled = await page.evaluate(() => navigator.maxTouchPoints > 0);
  if (touchEnabled !== at.touch) await cdp.send('Emulation.setTouchEmulationEnabled', at.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  await page.setViewportSize({ width: at.width, height: at.width < 768 ? 844 : 1000 });
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), at.touch, `${widthName(at)}: pointer mode`);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize), at.root, widthName(at));
}
/** Each row's chips: inside the row's own label, clear of its figures, of its pair's symbols and of each other; and whether the figures stand beside the pair. */
const chipsOf = (scope) => scope.locator('li[data-pool-key]').evaluateAll((items) => items.map((item) => {
  const box = (node) => node.getBoundingClientRect();
  const meets = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  const head = box(item.querySelector('.dm-mkt-option-head'));
  const figures = box(item.querySelector('.dm-flow-pool-figures'));
  const chips = [...item.querySelectorAll('.dm-chip')].map(box);
  const symbols = [...item.querySelectorAll('.dm-flow-pool-pair bdi')].map(box);
  return {
    inside: chips.every((chip) => chip.left >= head.left - 1 && chip.right <= head.right + 1 && chip.top >= head.top - 1 && chip.bottom <= head.bottom + 1),
    clear: chips.every((chip, at) => !meets(chip, figures) && symbols.every((symbol) => !meets(chip, symbol)) && chips.every((other, to) => to === at || !meets(chip, other))),
    beside: figures.top < head.bottom - 1,
  };
}));

test('(s) "eth" with Base offered: Robinhood Chain’s ETH is highlighted and Enter takes it; its rows keep the pair on one line', async () => {
  const s = await ethWithBase();
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    const search = page.getByRole('combobox', { name: 'Search a token' });
    await search.fill('eth');
    const home = page.locator(`[data-token-option="${ZERO}"]`);
    await home.waitFor();
    await page.locator(`[data-token-network-option="8453:${ZERO}"]`).waitFor();
    await page.locator('[data-token-search] .dm-flow-combo:not([data-searching])').waitFor();
    assert.equal(await page.locator('[role="listbox"] [role="option"]').first().getAttribute('data-token-option'), ZERO, 'Robinhood Chain’s ETH first');
    await home.and(page.locator('[data-active]')).waitFor();
    assert.equal(await search.getAttribute('aria-activedescendant'), await home.getAttribute('id'), 'Enter takes Robinhood Chain’s ETH');
    await search.press('Enter');
    const pools = page.locator('[data-picker="pool"]');
    await pools.locator('li[data-pool-key]').first().waitFor({ timeout: 30_000 });
    // Its rows name their network, Robinhood Chain, with the fee chip beside it on the line under the pair: the pair stays
    // on one line. Changed on purpose 2026-10-06 (the review of the next update): at every width each chip stays inside its
    // row, clear of the figures; where the list is as narrow as a phone's, the row stacks, the fee chip in its corner.
    const rows = () => pools.locator('li[data-pool-key]').evaluateAll((items) => items.map((item) => {
      const pair = item.querySelector('.dm-flow-pool-pair');
      const box = pair.getBoundingClientRect();
      const net = item.querySelector('.dm-flow-pool-net');
      const fee = item.querySelector('[data-fee]').getBoundingClientRect();
      return { pair: pair.textContent, lines: Math.round(box.height / parseFloat(getComputedStyle(pair).lineHeight)), network: net.textContent, together: Math.abs(net.getBoundingClientRect().top - fee.top) < 2 };
    }));
    const cdp = await page.context().newCDPSession(page);
    for (const at of ROW_WIDTHS) {
      await drawnAt(page, cdp, at);
      assert.deepEqual(await rows(), [{ pair: 'ETH / USDG', lines: 1, network: 'Robinhood Chain', together: at.beside }], widthName(at));
      assert.deepEqual(await chipsOf(pools), [{ inside: true, clear: true, beside: at.beside }], widthName(at));
      if (at.width === 1280 || at.width === 960 || at.touch) {
        await page.waitForTimeout(600);
        await page.screenshot({ path: join(shots(), at.touch ? 'journey-robinhood-rows-tablet-1024.png' : at.width === 960 ? 'journey-robinhood-rows-960.png' : 'journey-robinhood-rows-with-networks.png') });
      }
    }
  } finally { await s.close(); }
});

// Added 2026-10-06 (the review of the next update): the zero address pasted with Base offered listed Robinhood Chain's ETH
// and Base's, highlighted neither, and Enter did nothing. A pasted address that is one of Base's own currencies is that
// network's own currency (v2in/journey/otherChains.ts pastedRows), as its name's hit is, so Enter takes Robinhood Chain's.
test('(s2) the zero address pasted with Base offered: Robinhood Chain’s ETH is highlighted and Enter takes it', async () => {
  const s = await ethWithBase();
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    const search = page.getByRole('combobox', { name: 'Search a token' });
    await search.fill(ZERO);
    const home = page.locator(`[data-token-option="${ZERO}"]`);
    await home.waitFor();
    await page.locator(`[data-token-network-option="8453:${ZERO}"]`).waitFor();
    await page.locator('[data-token-search] .dm-flow-combo:not([data-searching])').waitFor();
    assert.equal(await page.locator('[role="listbox"] [role="option"]').first().getAttribute('data-token-option'), ZERO, 'Robinhood Chain’s ETH first');
    await home.and(page.locator('[data-active]')).waitFor();
    assert.equal(await search.getAttribute('aria-activedescendant'), await home.getAttribute('id'), 'Enter takes Robinhood Chain’s ETH');
    await search.press('Enter');
    // Robinhood Chain's ETH chosen: its own pool list, its ETH/USDG pool; not Base's.
    const pools = page.locator('[data-picker="pool"]');
    await pools.locator(`li[data-pool-key="${poolIdOf(POOL_RH)}"]`).waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('[data-picker="pool"][data-picker-network="8453"]').count(), 0);
    assert.match(await pools.locator('li[data-pool-key]').first().innerText(), /ETH\s*\/\s*USDG[\s\S]*Robinhood Chain/);
  } finally { await s.close(); }
});

// Added 2026-10-06 (review of the same day): the pair wraps, but a long symbol was wider than the desktop row's pair column
// and was clipped mid-letter. Each symbol now ends in "…" inside the column: on the rows and the chosen pool, desktop and phone.
// Changed on purpose 2026-10-06 (the review of the next update: a Base row read "VIRTUAL /", "WETH", "Base" at 1280, and
// this symbol was cut there while whole on a phone): a desktop row puts its fee chip beside its network chip, under the
// pair, so the pair has the row's width: this pair is whole and on one line, and the row two lines.
const LONG_BASE = '0x2222222222222222222222222222222222222222';
const LONG_POOL = { dex: 4, currency0: ZERO, currency1: LONG_BASE, fee: 3000, tickSpacing: 60, hooks: ZERO };

test('(r) a long symbol stays inside its pool’s pair, whole or ending in “…”, on the rows and the chosen pool, on a desktop and a phone; a desktop row is two lines', async () => {
  const chain = createV2Chain({ chainId: 8453, timestamp: now() });
  chain.switchTo(4663);
  const reads = createChainReads({
    chainId: 8453,
    tokens: [...BASE_TOKENS, { address: LONG_BASE, symbol: 'FARTCOINWIFHAT', name: 'Fartcoin Wif Hat', decimals: 18, sources: ['uniswap_default_list'] }],
    pools: [{ pool: LONG_POOL, sqrtPriceX96: SQRT_BASE, tick: TICK_BASE, liquidity: 10n ** 18n }],
  });
  const read = createReadStub({ answer: robinhoodRead });
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [8453], contracts: { 8453: contractsFor(8453) }, connect: false,
    routes: [(request, url) => read.handle(request, url) ?? undefined], chainReads: reads, artwork: true,
  });
  // Every symbol of a pair inside the pair's own box, a cut one ending in its ellipsis; `cut`: how many were cut.
  const symbols = (scope) => scope.locator('.dm-flow-pool-pair bdi').evaluateAll((nodes) => nodes.map((bdi) => {
    const pair = bdi.closest('.dm-flow-pool-pair').getBoundingClientRect();
    const box = bdi.getBoundingClientRect();
    const cut = bdi.scrollWidth > bdi.clientWidth + 1;
    return { inside: box.right <= pair.right + 1, cut, ellipsis: getComputedStyle(bdi).textOverflow === 'ellipsis' };
  }));
  const whole = (seen) => seen.every((symbol) => symbol.inside && (!symbol.cut || symbol.ellipsis));
  // Each row's pair in lines, and where its network chip sits: on the fee chip's line, under the pair.
  const layout = (scope) => scope.locator('li[data-pool-key]').evaluateAll((items) => items.map((item) => {
    const pair = item.querySelector('.dm-flow-pool-pair');
    const box = pair.getBoundingClientRect();
    const net = item.querySelector('.dm-flow-pool-net').getBoundingClientRect();
    const fee = item.querySelector('[data-fee]').getBoundingClientRect();
    return { lines: Math.round(box.height / parseFloat(getComputedStyle(pair).lineHeight)), chipsTogether: Math.abs(net.top - fee.top) < 2 && fee.left > net.right, under: net.top >= box.bottom - 1 };
  }));
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    await page.getByRole('combobox', { name: 'Search a token' }).fill('fartcoin');
    const hit = page.locator(`[data-token-network-option="8453:${LONG_BASE}"]`);
    await hit.click();
    const pools = page.locator('[data-picker="pool"][data-picker-network="8453"]');
    await pools.locator('li[data-pool-key]').first().waitFor({ timeout: 30_000 });
    // Changed on purpose 2026-10-06 (the review of the next update): at every width the row draws (ROW_WIDTHS), each chip
    // stays inside the row and clear of the figures; the list as narrow as a phone's stacks its rows as a phone does.
    const cdp = await page.context().newCDPSession(page);
    for (const at of ROW_WIDTHS) {
      await drawnAt(page, cdp, at);
      const rows = await symbols(pools);
      assert.ok(whole(rows), `${widthName(at)}: ${JSON.stringify(rows)}`);
      assert.deepEqual(await chipsOf(pools), [{ inside: true, clear: true, beside: at.beside }], widthName(at));
      if (at.width !== 1280) continue;
      assert.ok(!rows.some((symbol) => symbol.cut), `the desktop row gives the pair the row's width: ${JSON.stringify(rows)}`);
      assert.deepEqual(await layout(pools), [{ lines: 1, chipsTogether: true, under: true }], 'the pair on one line, its network and fee chips on the line under it');
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(shots(), 'journey-long-symbol-1280.png') });
    }
    // The last width is a phone's.
    await page.screenshot({ path: join(shots(), 'journey-long-symbol-390.png') });
    await pools.locator('input[name="pool-option"]').first().click();
    const chosen = page.locator('[data-chosen-pool]');
    await chosen.waitFor();
    assert.ok(whole(await symbols(chosen)));
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(shots(), 'journey-long-symbol-chosen-390.png') });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.waitForTimeout(150);
    assert.ok(whole(await symbols(chosen)));
    await page.screenshot({ path: join(shots(), 'journey-long-symbol-chosen-1280.png') });
  } finally { await s.close(); }
});

// Added 2026-10-06 (the owner, on production's New position, step 3: "USD estimate unavailable" for ETH/CASHCAT, AI/PONS and
// CASHCAT/AI on Robinhood Chain): a pair without USDG is valued at the qualified prices Domino's service reads for its pair
// (read-v6 chain-pools, asked once for the pool chosen, src/v2in/journey/poolPrices.ts): here ETH at Chainlink's ETH/USD, and
// the token, which has none (no deep pool against ETH or the dollar), at the pool's own price in ETH.
const TOKEN_TICK = -138180;
const TOKEN_SQRT = position.sqrtPriceAtTick(TOKEN_TICK);
const POOL_ETH_TOKEN = { dex: 4, currency0: ZERO, currency1: FIXTURE_TOKEN, fee: 3000, tickSpacing: 60, hooks: ZERO };
const RH_TOKENS = [{ address: ZERO, symbol: 'ETH', decimals: 18 }, { address: USDG_RH, symbol: 'USDG', decimals: 6 }, { address: FIXTURE_TOKEN, symbol: 'TOKEN', decimals: 6 }];
/** The read service's own ETH / TOKEN pool (its fixture) at about 1 ETH = 1,000,000 TOKEN; the wallet holds 10 ETH and 5,000,000 TOKEN. */
function ethTokenRead(route, body) {
  const name = { 'pool-market': 'pool-market.not-requested', 'wallet-assets': 'wallet-assets.zero', token: body.token === ZERO ? 'token.native' : 'token.success' }[route] ?? `${route}.success`;
  const answer = JSON.parse(readFileSync(join(READ_FIXTURES, `${name}.json`), 'utf8'));
  if (route === 'pools') for (const pool of answer.pools) Object.assign(pool, { tick: TOKEN_TICK, sqrtPriceX96: TOKEN_SQRT.toString() });
  if (route === 'wallet-assets') for (const item of answer.items) item.amountRaw = item.address === ZERO ? String(10n ** 19n) : String(5n * 10n ** 12n);
  return JSON.stringify(answer);
}
const dollars = (text) => Number(text.replace(/[$,]/g, ''));

test('(y) a Robinhood Chain pair without USDG shows a dollar estimate: ETH at its qualified price, the token at the pool’s own price', async () => {
  const chain = createV2Chain({ chainId: 4663, timestamp: now(), eth: 10n ** 19n, balances: { [FIXTURE_TOKEN]: 5n * 10n ** 12n }, pools: [{ pool: POOL_ETH_TOKEN, sqrtPriceX96: TOKEN_SQRT, tick: TOKEN_TICK, liquidity: 10n ** 16n }] });
  chain.switchTo(4663);
  const reads = createChainReads({ chainId: 4663, tokens: RH_TOKENS, pools: [{ pool: POOL_ETH_TOKEN, sqrtPriceX96: TOKEN_SQRT, tick: TOKEN_TICK, liquidity: 10n ** 16n }] });
  const discovery = new Map([8453, 42161].map((chainId) => [chainId, createChainReads({ chainId })]));
  const chainReads = { answer: (route, request) => (discovery.get(request.chainId) ?? reads).answer(route, request) };
  const read = createReadStub({ answer: ethTokenRead });
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [4663], contracts: { 4663: contractsFor(4663) }, planner: robinhoodPlanner([]),
    routes: [(request, url) => read.handle(request, url) ?? undefined], chainReads, artwork: true,
  });
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    await page.getByRole('combobox', { name: 'Search a token' }).fill(FIXTURE_TOKEN);
    // Public discovery runs on both other networks even while their creation gates are closed.
    // Let it settle before choosing the Robinhood result, rather than racing those reads against the click.
    await until(() => [...discovery.values()].every((remote) => remote.calls.length === 1), 'one address discovery per other network');
    await page.locator('[data-token-search] .dm-flow-combo:not([data-searching])').waitFor();
    await page.locator(`[data-token-option="${FIXTURE_TOKEN}"]`).click();
    await page.locator('[data-picker="pool"] input[name="pool-option"]').first().click({ timeout: 30_000 });
    await page.locator('[data-chosen-pool]').waitFor();
    const current = (step) => page.locator(`li[data-step="${step}"][aria-current="step"]`);
    await pressContinue(current('pool'));
    await current('range').waitFor();
    await pressContinue(current('range'));
    await current('amount').waitFor();
    await page.locator('li[data-step="amount"] [data-pair-balance="ready"]').first().waitFor({ timeout: 30_000 });
    await page.locator('li[data-step="amount"][aria-current="step"] [data-pair-side="1"] input[inputmode="decimal"]').fill('1000000');
    // The amounts' total and each panel's USD, never "USD estimate unavailable".
    const total = page.locator('li[data-step="amount"] [data-amount-total="valued"]');
    await total.waitFor({ timeout: 30_000 });
    const figure = await total.locator('strong').innerText();
    assert.match(figure, /^\$[\d,]+\.\d{2}$/);
    // 1,000,000 TOKEN is about 1 ETH at the pool's price, and the ETH it pairs with about as much again: about $8,000.
    assert.ok(dollars(figure) > 4_000 && dollars(figure) < 20_000, figure);
    for (const side of [0, 1]) assert.match(await page.locator(`li[data-step="amount"] [data-pair-side="${side}"] .dm-flow-amount-usd`).innerText(), /^\$[\d,]+\.\d{2}$/);
    assert.equal(await page.getByText('USD estimate unavailable').count(), 0);
    // One read for the pool chosen, about its own pair; discovery is counted separately with no extra calls allowed.
    assert.deepEqual(reads.calls.filter((call) => call.route === 'chain-pools').map((call) => call.request), [{ chainId: 4663, token: ZERO, pairedToken: FIXTURE_TOKEN }]);
    for (const [chainId, remote] of discovery) assert.deepEqual(remote.calls, [{ route: 'chain-pools', request: { chainId, token: FIXTURE_TOKEN } }], 'one public discovery read per other network, never a pair-price read or a duplicate');
    await page.screenshot({ path: join(shots(), 'journey-robinhood-usd-1280.png'), fullPage: true, animations: 'disabled' });
    assert.equal(chain.sends.length, 0);
  } finally { await s.close(); }
});

// Added 2026-10-06 (rugged's answer of 6 Oct, §1: each visitor's reads have a budget per lane of the reader, whose Retry-After
// is now the real time to the lane's next token; and "don't repeat chain-pools of the same token before 15 s, which is the
// reader's cache"): the pool's prices asked again after a busy reader's 429 no sooner than the Retry-After it named, and that
// answer serving the same pool when New position is opened again a moment later (src/v2in/journey/served.ts chainPoolsOn,
// the reuse Base's and Arbitrum One's rows share): one more chain-pools read, never two.
test('(y2) a busy reader’s Retry-After is waited before the pair’s prices are asked again, and their answer serves the pool chosen again in a New position opened again', async () => {
  const chain = createV2Chain({ chainId: 4663, timestamp: now(), eth: 10n ** 19n, balances: { [FIXTURE_TOKEN]: 5n * 10n ** 12n }, pools: [{ pool: POOL_ETH_TOKEN, sqrtPriceX96: TOKEN_SQRT, tick: TOKEN_TICK, liquidity: 10n ** 16n }] });
  chain.switchTo(4663);
  const reads = createChainReads({ chainId: 4663, tokens: RH_TOKENS, pools: [{ pool: POOL_ETH_TOKEN, sqrtPriceX96: TOKEN_SQRT, tick: TOKEN_TICK, liquidity: 10n ** 16n }] });
  const discovery = new Map([8453, 42161].map((chainId) => [chainId, createChainReads({ chainId })]));
  // Only the selected Robinhood pair is refused. Public pasted-address discovery has its own chain identities.
  const asked = [];
  const chainReads = {
    calls: reads.calls,
    answer: (route, request) => {
      if (route !== 'chain-pools') return reads.answer(route, request);
      if (discovery.has(request.chainId)) return discovery.get(request.chainId).answer(route, request);
      assert.deepEqual(request, { chainId: 4663, token: ZERO, pairedToken: FIXTURE_TOKEN }, 'the timed read is exactly the selected pair');
      asked.push(Date.now());
      return asked.length === 1 ? { status: 429, body: { error: 'read_capacity_busy' }, retryAfter: '6' } : reads.answer(route, request);
    },
  };
  const read = createReadStub({ answer: ethTokenRead });
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [4663], contracts: { 4663: contractsFor(4663) }, planner: robinhoodPlanner([]),
    routes: [(request, url) => read.handle(request, url) ?? undefined], chainReads, artwork: true,
  });
  const choose = async (page) => {
    await page.getByRole('combobox', { name: 'Search a token' }).fill(FIXTURE_TOKEN);
    await page.locator('[data-token-search] .dm-flow-combo:not([data-searching])').waitFor();
    await page.locator(`[data-token-option="${FIXTURE_TOKEN}"]`).click();
    await page.locator('[data-picker="pool"] input[name="pool-option"]').first().click({ timeout: 30_000 });
    await page.locator('[data-chosen-pool]').waitFor();
  };
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    await choose(page);
    await until(() => asked.length >= 2, 'the prices asked again');
    assert.ok(asked[1] - asked[0] >= 6_000, `asked again ${asked[1] - asked[0]} ms after the 429, never under the 6 s it named`);
    // A moment later, New position opened again and the same pool chosen: the answer just read serves it.
    await page.evaluate(() => { location.hash = '#/positions'; });
    await page.getByRole('heading', { level: 1, name: 'Positions', exact: true }).waitFor();
    await page.evaluate(() => { location.hash = '#/new'; });
    await page.locator('[data-create-journey]').waitFor();
    await choose(page);
    await page.waitForTimeout(1_500);
    assert.ok(Date.now() - asked[1] < 20_000, 'still within the 20 s an answer is reused');
    assert.equal(asked.length, 2, 'chain-pools of the same pair is not asked again: one answer serves it');
    assert.deepEqual(reads.calls.filter((call) => call.route === 'chain-pools').map((call) => call.request), [{ chainId: 4663, token: ZERO, pairedToken: FIXTURE_TOKEN }], 'the one answered read, about the pair');
    for (const [chainId, remote] of discovery) assert.deepEqual(remote.calls.map((call) => call.request), [{ chainId, token: FIXTURE_TOKEN }], 'public discovery also reuses its answer: one read per other network across both visits');
  } finally { await s.close(); }
});

// Added 2026-10-06 (the owner, on production's New position: AI/PONS and CASHCAT/AI short on Robinhood Chain, and no offer to
// bring anything, since neither token is one a deposit from another network delivers): where the offer would be, ONE line
// names the token to pay with instead (src/v2in/funds/PayWith.tsx); chosen, the step draws that token's one panel
// (src/components/create/PairedAmounts.tsx), and the plan asks exactly that one other token (position-plan-v1: "the pool's
// tokens, or exactly one other token").
const OTHER = '0x2222222222222222222222222222222222222222';
const POOL_PAIR = { dex: 4, currency0: FIXTURE_TOKEN, currency1: OTHER, fee: 3000, tickSpacing: 60, hooks: ZERO };
// About 1 TOKEN (6 decimals) = 1 OTHER (18 decimals).
const PAIR_TICK = 276300;
const PAIR_SQRT = position.sqrtPriceAtTick(PAIR_TICK);
const payTokens = (symbol) => [...RH_TOKENS, { address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', symbol: 'WETH', decimals: 18 }, { address: OTHER, symbol, decimals: 18 }];
/**
 * The read service's TOKEN in a TOKEN / OTHER pool (its own fixture, made this pool); the wallet holds 100 TOKEN and no OTHER.
 * Changed on purpose 2026-10-06 (the review's long symbols): OTHER's symbol as the test names it.
 */
const pairRead = (symbol) => (route, body) => {
  const name = { 'pool-market': 'pool-market.not-requested', 'wallet-assets': 'wallet-assets.zero', token: body.token === ZERO ? 'token.native' : 'token.success' }[route] ?? `${route}.success`;
  const answer = JSON.parse(readFileSync(join(READ_FIXTURES, `${name}.json`), 'utf8').replaceAll(FIXTURE_POOL_ID, poolIdOf(POOL_PAIR)));
  const other = (entry, extra = {}) => ({ ...entry, address: OTHER, symbol, decimals: 18, ...extra });
  if (route === 'pools') {
    const token = answer.tokens.find((entry) => entry.address === FIXTURE_TOKEN);
    answer.tokens = [token, other(token)];
    for (const pool of answer.pools) Object.assign(pool, { currencies: [FIXTURE_TOKEN, OTHER], tick: PAIR_TICK, sqrtPriceX96: PAIR_SQRT.toString(), poolKey: { ...pool.poolKey, currency0: FIXTURE_TOKEN, currency1: OTHER } });
  }
  if (route === 'wallet-assets') {
    const token = { ...answer.items.find((item) => item.address === FIXTURE_TOKEN), amountRaw: '100000000' };
    answer.items = [token, other(token, { amountRaw: '0' })];
  }
  return JSON.stringify(answer);
};
/** position-plan-v1 for a create paid in ETH alone: about half of it swapped for each of the pool's tokens. */
function payPlanner(answers = []) {
  return (wire) => {
    if (wire.action !== 'create') return undefined;
    // What is swapped leaves the 0.65% Domino fee on it in the zap (FeeNotBacked otherwise), as the service plans it.
    const paid = (BigInt(wire.inputs[0].amountRaw) * 10_000n) / 10_065n;
    const legs = [
      { tokenIn: ZERO, tokenOut: FIXTURE_TOKEN, amountIn: paid / 2n, expectedOut: 500_000_000n, data: v4Path({ ...POOL_PAIR, currency0: ZERO, currency1: FIXTURE_TOKEN }) },
      { tokenIn: ZERO, tokenOut: OTHER, amountIn: paid - paid / 2n, expectedOut: 500n * 10n ** 18n, data: v4Path({ ...POOL_PAIR, currency0: ZERO, currency1: OTHER }) },
    ];
    const body = planAnswer(wire, { owner: OWNER, zap: ZAP_V4, now: now(), pool: { sqrtPriceX96: PAIR_SQRT, tick: PAIR_TICK }, legs, nonce: { word: 9, bit: answers.length }, expected: { amounts: [495_000_000n, 495n * 10n ** 18n] } });
    answers.push(body);
    return body;
  };
}
/**
 * The owner's journey on TOKEN / OTHER, 1,000 TOKEN typed with 100 TOKEN and no OTHER in the wallet: short, nothing to bring.
 * Changed on purpose 2026-10-06 (the review): `s2` false leaves the crosschain route unserved (S2's gate not live), and
 * `symbol` names OTHER.
 * Changed on purpose 2026-10-06 (the review of rugged97's #379): `elsewhere(request)` answers, when the suite hands it in,
 * the service's read of Ethereum and OP Mainnet (a request of its own); `reads` records Domino's alone then.
 */
async function shortOfPair(ethWei, planner, { s2 = true, symbol = 'OTHER', elsewhere = null } = {}) {
  const chain = createV2Chain({ chainId: 4663, timestamp: now(), eth: ethWei, balances: { [FIXTURE_TOKEN]: 100_000_000n }, pools: [{ pool: POOL_PAIR, sqrtPriceX96: PAIR_SQRT, tick: PAIR_TICK, liquidity: 10n ** 16n }] });
  chain.switchTo(4663);
  const own = createChainReads({ chainId: 4663, tokens: payTokens(symbol), balances: { [ZERO]: ethWei } });
  const away = (route, request) => route === 'chain-balances' && request.tokens?.some((t) => t.chainId === 1 || t.chainId === 10);
  const reads = elsewhere === null ? own : { calls: own.calls, answer: (route, request) => (away(route, request) ? elsewhere(request) : own.answer(route, request)) };
  const read = createReadStub({ answer: pairRead(symbol) });
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, live: [4663], contracts: { 4663: contractsFor(4663) }, planner,
    routes: [...(s2 ? [crosschainLive] : []), (request, url) => read.handle(request, url) ?? undefined], chainReads: reads, artwork: true,
  });
  const page = s.page;
  try {
    await page.locator('[data-create-journey]').waitFor();
    await page.getByRole('combobox', { name: 'Search a token' }).fill(FIXTURE_TOKEN);
    await page.locator(`[data-token-option="${FIXTURE_TOKEN}"]`).click();
    await page.locator('[data-picker="pool"] input[name="pool-option"]').first().click({ timeout: 30_000 });
    await page.locator('[data-chosen-pool]').waitFor();
    await pressContinue(current(page, 'pool'));
    await current(page, 'range').waitFor();
    await pressContinue(current(page, 'range'));
    await current(page, 'amount').waitFor();
    await page.locator('li[data-step="amount"] [data-pair-balance="ready"]').first().waitFor({ timeout: 30_000 });
    await page.locator('li[data-step="amount"][aria-current="step"] [data-pair-side="0"] input[inputmode="decimal"]').fill('1000');
    await page.locator('[data-amount-short]').waitFor({ timeout: 30_000 });
  } catch (error) {
    await s.close().catch(() => {});
    throw error;
  }
  return { s, chain, reads, page };
}
const current = (page, step) => page.locator(`li[data-step="${step}"][aria-current="step"]`);
/** Desktop and phone widths, with no sideways scroll; then back to the scenario's desktop. */
async function bothWidths(page, name) {
  for (const width of [1440, 1280, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `${name}: no horizontal scroll at ${width}`);
    await page.screenshot({ path: join(shots(), `${name}-${width}.png`), fullPage: true, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.waitForTimeout(150);
}
const words = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();

test('(z) a pair nothing can bring, the wallet short and holding ETH: one line "Pay with ETH instead", its one panel, and Review plans exactly [ETH]', async () => {
  const { s, chain, reads, page } = await shortOfPair(2n * 10n ** 18n, payPlanner([]));
  try {
    // Where the offer would be, one line: no box, no network to bring from (neither token is one a deposit delivers).
    const line = page.locator(`button[data-pay-with="${ZERO}"]`);
    await line.waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('[data-pay-with]').count(), 1, 'at most one line');
    assert.equal(await page.locator('[data-funds-offer]').count(), 0, 'no offer to bring TOKEN or OTHER');
    assert.equal(await words(line), 'Use your ETH on Robinhood Chain Convert to TOKEN and OTHER. Use ETH');
    assert.ok(reads.calls.some((call) => call.route === 'chain-balances'), 'what the wallet holds, as Domino’s service read it');
    await bothWidths(page, 'journey-pay-with-line');
    await line.click();
    // The one panel: ETH's, with its balance, Max and its USD value; the pool's own panels rest; the way back.
    const panel = page.locator(`[data-pay-with-amount="${ZERO}"]`);
    await panel.waitFor();
    assert.equal(await page.locator('[data-paired-amounts]').count(), 0, 'the pool’s two panels rest');
    assert.equal(await page.locator('li[data-step="amount"] .dm-flow-lead').innerText(), 'Pay with ETH. Domino swaps it for the pool’s tokens.');
    await panel.locator('[data-pair-balance="ready"]').waitFor({ timeout: 30_000 });
    assert.equal(await words(panel.locator('.dm-flow-balance-line')), 'Balance: 2');
    assert.equal(await panel.locator('[data-pair-max="pay"]').count(), 1);
    assert.equal(await words(panel.locator('[data-pay-with-back]')), 'Use TOKEN and OTHER instead');
    await panel.locator('#create-amount-pay').fill('0.5');
    assert.match(await panel.locator('.dm-flow-amount-usd').innerText(), /^\$2,000\.\d{2}$/, 'its USD value at ETH’s qualified price');
    assert.equal(await page.locator('[data-funds-offer]').count(), 0, 'covered: nothing to bring');
    await bothWidths(page, 'journey-pay-with-panel');
    // The way back keeps the pool's tokens as typed; and forth again.
    await panel.locator('[data-pay-with-back]').click();
    await page.locator('[data-paired-amounts]').waitFor();
    // QA round 2, N75 (2026-10-30): a field nobody is typing in shows its amount grouped ("1,000"); the amount is the same.
    assert.match(await page.locator('li[data-step="amount"] [data-pair-side="0"] input[inputmode="decimal"]').inputValue(), /^1,?000$/);
    await page.locator(`button[data-pay-with="${ZERO}"]`).click({ timeout: 30_000 });
    await panel.locator('#create-amount-pay').fill('0.5');
    // Continue works as today; Review asks the plan for exactly the one other token, and shows it with its swaps.
    await pressContinue(current(page, 'amount'));
    const review = page.locator('[data-stage-card="review"] [data-zap-review="live"][data-zap-review-stage="reviewed"]');
    await review.waitFor({ timeout: 30_000 });
    assert.equal(s.planned.length, 1, 'one plan');
    assert.deepEqual(s.planned[0].inputs, [{ token: ZERO, amountRaw: '500000000000000000' }], 'exactly [ETH]');
    assert.equal(s.planned[0].consent, 'direct', 'native ETH: the direct path');
    assert.equal(await review.locator('[data-review-inputs]').innerText(), 'You put in 0.5 ETH.');
    assert.equal(await review.locator('[data-review-amounts]').innerText(), 'About 495 TOKEN + 495 OTHER');
    await review.locator('[data-review-fee="charged"]').waitFor();
    // Its one wallet step ready, its network fee read: the plan holds as reviewed (no error under it).
    await review.locator('[data-review-network-fee="about"]').waitFor({ timeout: 30_000 });
    assert.deepEqual(await review.locator('.dm-flow-wstep-title').allInnerTexts(), ['Create the position'], 'ETH needs no approval');
    // The step's row says what was paid.
    assert.equal(await words(page.locator('li[data-step="amount"] .dm-flow-row-summary')), '0.5 ETH');
    await page.screenshot({ path: join(shots(), 'journey-pay-with-review-1280.png'), fullPage: true, animations: 'disabled' });
    assert.equal(chain.sends.length, 0);
  } finally { await s.close(); }
});

test('(z2) paying with ETH the wallet lacks too: the offer to bring ETH from another network, sized for what is missing', async () => {
  const { s, chain, page } = await shortOfPair(10n ** 15n, payPlanner([]));
  try {
    await page.locator(`button[data-pay-with="${ZERO}"]`).click({ timeout: 30_000 });
    const panel = page.locator(`[data-pay-with-amount="${ZERO}"]`);
    await panel.locator('[data-pair-balance="ready"]').waitFor({ timeout: 30_000 });
    await panel.locator('#create-amount-pay').fill('0.5');
    const offer = page.locator(`[data-funds-offer][data-funds-token="${ZERO}"]`);
    await offer.waitFor({ timeout: 30_000 });
    assert.equal(await words(offer.locator('[data-funds-title]')), 'Find funds for this position');
    // 0.5 ETH and the gas Review keeps, less the 0.0001 ETH there.
    assert.equal(await offer.locator('[data-funds-lack]').getAttribute('data-funds-lack-raw'), '499500000000000000');
    assert.equal(await footerButton(current(page, 'amount'), 'Continue').isDisabled(), true);
    await bothWidths(page, 'journey-pay-with-bring');
    assert.equal(s.planned.length, 0, 'no plan before Continue');
    assert.equal(chain.sends.length, 0);
  } finally { await s.close(); }
});

// Added 2026-10-06 (the review of 2026-10-06): the line and the panel never wait on S2. With the crosschain route unserved
// (S2's gate not live) the line is still there, from what Domino's service read under the network's S1 gate, and its panel
// keeps its balance; and with the wallet locked or gone in the middle of it, the panel and its way back stay, drawn by the
// step itself, with the amount as typed.
test('(z3) S2 not live: the line and the panel all the same; the wallet gone, the panel and its way back stay', async () => {
  const { s, chain, reads, page } = await shortOfPair(2n * 10n ** 18n, payPlanner([]), { s2: false });
  try {
    const line = page.locator(`button[data-pay-with="${ZERO}"]`);
    await line.waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('[data-funds-offer]').count(), 0, 'no offer without S2');
    assert.equal(await words(line), 'Use your ETH on Robinhood Chain Convert to TOKEN and OTHER. Use ETH');
    assert.ok(reads.calls.some((call) => call.route === 'chain-balances'), 'read under the S1 gate');
    await line.click();
    const panel = page.locator(`[data-pay-with-amount="${ZERO}"]`);
    await panel.locator('[data-pair-balance="ready"]').waitFor({ timeout: 30_000 });
    assert.equal(await words(panel.locator('.dm-flow-balance-line')), 'Balance: 2');
    await panel.locator('#create-amount-pay').fill('0.5');
    // The wallet disconnected: the panel, its amount and its way back stay; only the balance line goes.
    await page.locator('header [aria-haspopup="dialog"]').click();
    await page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]').getByRole('button', { name: 'Disconnect wallet', exact: true }).click();
    await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    await page.keyboard.press('Escape');
    await panel.locator('.dm-flow-balance').waitFor({ state: 'detached', timeout: 30_000 });
    assert.equal(await panel.locator('#create-amount-pay').inputValue(), '0.5');
    assert.equal(await words(panel.locator('[data-pay-with-back]')), 'Use TOKEN and OTHER instead');
    assert.equal(await page.locator('[data-paired-amounts]').count(), 0);
    await panel.locator('[data-pay-with-back]').click();
    await page.locator('[data-paired-amounts]').waitFor();
    assert.equal(chain.sends.length, 0);
  } finally { await s.close(); }
});

// Added 2026-10-06 (the review of rugged97's #379: the token to pay with waited for Ethereum's and OP Mainnet's read, and
// failed with it): the line comes from Domino's read alone while theirs is still out; theirs, once back, only adds what is
// held there, and the line names USDG once the dollars held there are worth more than the ETH here.
test('(z5) Ethereum and OP Mainnet never hold local payment back or replace it with remote wealth', async () => {
  const USDC_1 = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const WETH_1 = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
  let release = () => {};
  const out = new Promise((done) => { release = done; });
  const asked = [];
  // US$20,000 of USDC on Ethereum, against 2 ETH (about US$8,000) here.
  const ethereum = createChainReads({ chainId: 1, tokens: [{ address: ZERO, symbol: 'ETH', decimals: 18 }, { address: WETH_1, symbol: 'WETH', decimals: 18 }, { address: USDC_1, symbol: 'USDC', decimals: 6 }], balances: { [USDC_1]: 20_000_000_000n } });
  const elsewhere = async (request) => {
    asked.push(request);
    await out;
    return ethereum.answer('chain-balances', request);
  };
  const { s, chain, reads, page } = await shortOfPair(2n * 10n ** 18n, payPlanner([]), { elsewhere });
  try {
    const line = page.locator('button[data-pay-with]');
    await line.waitFor({ timeout: 15_000 });
    assert.equal(await line.getAttribute('data-pay-with'), ZERO);
    assert.equal(await words(line), 'Use your ETH on Robinhood Chain Convert to TOKEN and OTHER. Use ETH', 'from Domino’s read alone');
    assert.ok(reads.calls.some((call) => call.route === 'chain-balances'), 'Domino’s three read');
    assert.ok(asked.length >= 1 && asked.every((request) => request.tokens.every((t) => t.chainId === 1 || t.chainId === 10)), 'Ethereum and OP Mainnet asked, in a request of their own');
    assert.equal(ethereum.calls.length, 0, 'and not answered yet');
    release();
    await page.waitForFunction(() => true);
    await page.waitForTimeout(250);
    assert.equal(await page.locator('button[data-pay-with]').count(), 1, 'one preferred action');
    assert.equal(await page.locator('button[data-pay-with]').getAttribute('data-pay-with'), ZERO, 'local ETH stays preferred after remote USDC arrives');
    assert.equal(chain.sends.length, 0);
  } finally {
    release();
    await s.close();
  }
});

// Added 2026-10-06 (the review of 2026-10-06: a 50-character symbol pushed the line and the way back out of a phone's width;
// the read contracts carry 40 at most, the longest drawn here): the pool's symbols are cut at 24 characters with "…", as
// everywhere else, and nothing scrolls sideways at 390.
test('(z4) a 40-character symbol: the line and the way back stay inside a phone’s width, the symbol cut with “…”', async () => {
  const symbol = 'ULTRALONGSYMBOL'.repeat(2) + 'NOSPACEHER';
  const { s, chain, page } = await shortOfPair(2n * 10n ** 18n, payPlanner([]), { symbol });
  try {
    const line = page.locator(`button[data-pay-with="${ZERO}"]`);
    await line.waitFor({ timeout: 30_000 });
    const cut = line.locator('.dm-funds-line-usd bdi').last();
    assert.equal(await cut.textContent(), symbol, 'the whole symbol is in the element');
    assert.equal(await cut.evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === 'ellipsis'), true, 'cut with “…”');
    await bothWidths(page, 'journey-pay-with-long-symbol-line');
    await line.click();
    const back = page.locator('[data-pay-with-back]');
    await back.waitFor();
    assert.equal(await back.locator('bdi').last().evaluate((el) => getComputedStyle(el).textOverflow), 'ellipsis');
    await bothWidths(page, 'journey-pay-with-long-symbol-panel');
    assert.equal(chain.sends.length, 0);
  } finally { await s.close(); }
});


test('(z6) a delayed recommendation cannot replace an already chosen ETH amount or its balance', async () => {
  const USDC_1 = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  let release = () => {};
  const out = new Promise((done) => { release = done; });
  const ethereum = createChainReads({ chainId: 1, tokens: [{ address: ZERO, symbol: 'ETH', decimals: 18 }, { address: USDC_1, symbol: 'USDC', decimals: 6 }], balances: { [USDC_1]: 20_000_000_000n } });
  const elsewhere = async (request) => { await out; return ethereum.answer('chain-balances', request); };
  const { s, chain, page } = await shortOfPair(2n * 10n ** 18n, payPlanner([]), { elsewhere });
  try {
    await page.locator('button[data-pay-with="' + ZERO + '"]').click({ timeout: 30_000 });
    const panel = page.locator('[data-pay-with-amount="' + ZERO + '"]');
    await panel.locator('[data-pair-balance="ready"]').waitFor({ timeout: 30_000 });
    await panel.locator('#create-amount-pay').fill('0.5');
    release();
    await page.waitForTimeout(300);
    assert.equal(await panel.locator('#create-amount-pay').inputValue(), '0.5');
    assert.equal(await words(panel.locator('.dm-flow-balance-line')), 'Balance: 2');
    assert.equal(await page.locator('[data-pay-with-amount]').getAttribute('data-pay-with-amount'), ZERO);
    await pressContinue(current(page, 'amount'));
    await page.locator('[data-zap-review-stage="reviewed"]').waitFor({ timeout: 30_000 });
    assert.deepEqual(s.planned[0].inputs, [{ token: ZERO, amountRaw: '500000000000000000' }]);
    assert.equal(chain.sends.length, 0);
  } finally { release(); await s.close(); }
});


test('(g2) automatic balance recovery never switches the wallet away from another network', async () => {
  const chain = createV2Chain({ chainId: 8453, timestamp: now(), balances: { [USDC_BASE]: 5_000_000_000n }, pools: [{ pool: POOL_BASE, sqrtPriceX96: SQRT_BASE, tick: TICK_BASE, liquidity: 10n ** 18n }] });
  chain.switchTo(4663);
  const own = createChainReads({ chainId: 8453, tokens: [{ address: ZERO, symbol: 'ETH', decimals: 18 }, { address: USDC_BASE, symbol: 'USDC', decimals: 6 }], pools: [{ pool: POOL_BASE, sqrtPriceX96: SQRT_BASE, tick: TICK_BASE, liquidity: 10n ** 18n }], balances: { [USDC_BASE]: 5_000_000_000n } });
  // Changed on purpose 2026-10-30 (launch capacity 9a, its review): the service refuses the balances from the start, so the
  // first read answers nothing; a background read that reads nothing keeps the balances it had (below).
  let failing = true;
  let refused = 0;
  const chainReads = { answer: (route, request) => {
    if (route === 'chain-balances' && failing) { refused++; return { status: 404, body: { error: 'route_not_available' } }; }
    return own.answer(route, request);
  } };
  const read = createReadStub({ answer: robinhoodRead });
  const s = await openJourney(browser, chain, { dist: WALLET_V2_DIST, live: [8453], contracts: { 8453: contractsFor(8453) }, planner: basePlanner([]), routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true, clock: true, chainReads });
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    await page.getByRole('combobox', { name: 'Search a token' }).fill('USDC');
    await page.locator('[data-token-network-option="8453:' + USDC_BASE + '"]').click({ timeout: 30_000 });
    await page.locator('[data-picker="pool"][data-picker-network="8453"] input[name="pool-option"]').first().click({ timeout: 30_000 });
    await page.locator('[data-chosen-pool]').waitFor();
    await pressContinue(current(page, 'pool'));
    await pressContinue(current(page, 'range'));
    const amount = current(page, 'amount');
    await amount.locator('[data-pair-balance="ready"]').first().waitFor({ timeout: 30_000 });
    const field = amount.locator('[data-pair-side="1"] input[inputmode="decimal"]');
    await field.fill('1000');
    await until(() => refused > 0, 'the first read tried the service');
    // Changed on purpose 2026-10-30 (QA round 2 review, the sweep): a balance not read yet is said as one being checked,
    // never as one that could not be; the failed read shows as the balance's figure dash.
    await amount.locator('[data-pair-balance="ready"] bdi.text-fg-subtle').first().waitFor({ timeout: 30_000 });
    await page.locator('#continue-reason').filter({ hasText: 'Checking your balance…' }).waitFor({ timeout: 30_000 });
    assert.equal(chain.chainNow(), 4663);
    assert.equal(chain.log.filter((method) => method === 'wallet_switchEthereumChain').length, 0);
    assert.match(await field.inputValue(), /^1,?000$/);
    assert.equal(await footerButton(amount, 'Continue').isDisabled(), true);
    failing = false;
    // While a read that answered nothing holds Continue, the balances are asked again 15 s after the last read, then 30 s.
    await page.clock.fastForward('00:31');
    await until(async () => !(await footerButton(amount, 'Continue').isDisabled()), 'the next service read recovers');
    assert.match(await field.inputValue(), /^1,?000$/);
    // A background read (every minute) that the service refuses keeps the balances on screen and Continue as it is.
    failing = true;
    const refusedBefore = refused;
    await page.clock.fastForward('01:01');
    await until(() => refused > refusedBefore, 'the background read tried the service');
    await amount.locator('[data-pair-balance="ready"]:not([data-pair-refreshing])').first().waitFor({ timeout: 30_000 });
    assert.equal(await amount.locator('[data-pair-balance="ready"] bdi.text-fg-subtle').count(), 0);
    assert.equal(await footerButton(amount, 'Continue').isDisabled(), false);
    assert.match(await field.inputValue(), /^1,?000$/);
    assert.equal(chain.chainNow(), 4663);
    assert.equal(chain.log.filter((method) => method === 'wallet_switchEthereumChain').length, 0);
    assert.equal(chain.sends.length, 0);
  } finally { await s.close(); }
});

test('(g3) a price crossing the range keeps the typed token visible and waits for an explicit change', async () => {
  const pool = { pool: POOL_BASE, sqrtPriceX96: SQRT_BASE, tick: TICK_BASE, liquidity: 10n ** 18n };
  const chain = createV2Chain({ chainId: 8453, timestamp: now(), balances: { [USDC_BASE]: 5_000_000_000n }, pools: [pool] });
  chain.switchTo(4663);
  const reads = createChainReads({ chainId: 8453, tokens: [{ address: ZERO, symbol: 'ETH', decimals: 18 }, { address: USDC_BASE, symbol: 'USDC', decimals: 6 }], pools: [pool], balances: { [USDC_BASE]: 5_000_000_000n } });
  const read = createReadStub({ answer: robinhoodRead });
  const s = await openJourney(browser, chain, { dist: WALLET_V2_DIST, live: [8453], contracts: { 8453: contractsFor(8453) }, planner: basePlanner([]), routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true, clock: true, chainReads: reads });
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    await page.getByRole('combobox', { name: 'Search a token' }).fill('USDC');
    await page.locator('[data-token-network-option="8453:' + USDC_BASE + '"]').click({ timeout: 30_000 });
    await page.locator('[data-picker="pool"][data-picker-network="8453"] input[name="pool-option"]').first().click({ timeout: 30_000 });
    await page.locator('[data-chosen-pool]').waitFor();
    await pressContinue(current(page, 'pool'));
    await pressContinue(current(page, 'range'));
    const amount = current(page, 'amount');
    await amount.locator('[data-pair-balance="ready"]').first().waitFor({ timeout: 30_000 });
    const field = amount.locator('[data-pair-side="1"] input[inputmode="decimal"]');
    await field.fill('1000');
    await until(async () => !(await footerButton(amount, 'Continue').isDisabled()), 'the original amount is ready');
    pool.tick = TICK_BASE - 20_000;
    pool.sqrtPriceX96 = String(position.sqrtPriceAtTick(pool.tick));
    // Changed on purpose 2026-10-30 (launch capacity, item 9a): Amount's reads are asked again every minute, no longer every 30 s.
    await page.clock.fastForward('01:01');
    await until(async () => (await page.locator('#continue-reason').textContent())?.includes('range'), 'the moved price asks for an explicit range or token change');
    assert.equal(await field.isVisible(), true);
    assert.match(await field.inputValue(), /^1,?000$/);
    assert.equal(await footerButton(amount, 'Continue').isDisabled(), true);
    assert.equal(s.planned.length, 0);
    assert.equal(chain.log.filter((method) => method === 'wallet_switchEthereumChain').length, 0);
    assert.equal(chain.sends.length, 0);
  } finally { await s.close(); }
});


test('public discovery: a preview finds Base tokens by name and address, and a network handoff never reuses another chain', async () => {
  const chain = createV2Chain({ chainId: 8453, timestamp: now() });
  chain.switchTo(4663);
  const reads = virtualReads();
  const arbitrum = createChainReads({ chainId: 42161, tokens: [] });
  const read = createReadStub({ answer: (route, body) => route === 'token' && body.token !== ZERO && body.token !== USDG_RH ? noContractOnRobinhood(body.token) : robinhoodRead(route, body) });
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, connect: false, live: [],
    routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true,
    chainReads: { answer: (route, request) => (request.chainId === 42161 ? arbitrum : reads).answer(route, request) },
  });
  try {
    const page = s.page;
    await page.locator('[data-create-journey]').waitFor();
    const search = page.getByRole('combobox', { name: 'Search a token', exact: true });
    await search.fill('Virtual Protocol');
    const hit = page.locator('[data-token-network-option="8453:' + VIRTUAL_BASE + '"]');
    await hit.waitFor({ timeout: 30_000 });
    assert.match(await hit.innerText(), /VIRTUAL/);
    await search.fill(VIRTUAL_BASE);
    await hit.waitFor({ timeout: 30_000 });
    await page.locator('[data-token-search] .dm-flow-combo:not([data-searching])').waitFor();
    assert.equal(await page.locator('[data-token-option], [data-token-network-option^="42161:"]').count(), 0);
    await hit.click();
    await page.locator('[data-picker-network="8453"] [data-pool-key]').first().waitFor({ timeout: 30_000 });
    // Changed on purpose 2026-10-30 (QA round 2 sweep): a closed network in the gate's own words.
    assert.match(await page.locator('[data-network-creation="unavailable"]').innerText(), /New positions on Base aren’t open right now\. You can still explore its pools\./);
    await page.evaluate(token => { window.location.hash = '#/new/network/8453/' + token; }, VIRTUAL_BASE);
    await page.locator('[data-picker-network="8453"] [data-pool-key]').first().waitFor({ timeout: 30_000 });
    assert.equal(await search.inputValue(), 'VIRTUAL');
    await page.evaluate(token => { window.location.hash = '#/new/network/42161/' + token; }, VIRTUAL_BASE);
    await page.locator('[data-network-handoff="unavailable"]').waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('[data-picker-network="8453"]').count(), 0, 'the old Base pools are gone on a same-address chain change');
    assert.equal(await page.locator('[data-create-journey]').count(), 0, 'an unread Arbitrum token never falls back to Robinhood');
    assert.ok(reads.calls.some(call => call.route === 'chain-tokens' && call.request.query === 'Virtual Protocol'));
    assert.ok(arbitrum.calls.some(call => call.route === 'chain-pools' && call.request.token === VIRTUAL_BASE));
    assert.equal(chain.chainNow(), 4663);
    assert.equal(chain.multicalls.length, 0);
    assert.equal(chain.log.filter(method => ['eth_requestAccounts', 'wallet_requestPermissions', 'wallet_switchEthereumChain'].includes(method)).length, 0);
    assert.equal(chain.signed.length, 0);
    assert.equal(chain.sends.length, 0);
    assert.equal(s.planned.length, 0);
  } finally { await s.close(); }
});

test('public discovery: preview pool selection reaches a locked review without planning, signing or moving the wallet', async () => {
  const chain = createV2Chain({ chainId: 8453, timestamp: now(), balances: { [ZERO]: 10n ** 18n, [USDC_BASE]: 5_000_000_000n } });
  chain.switchTo(4663);
  const reads = createChainReads({
    chainId: 8453,
    tokens: BASE_TOKENS,
    pools: [{ pool: POOL_BASE, sqrtPriceX96: SQRT_BASE, tick: TICK_BASE, liquidity: 10n ** 18n }],
    balances: { [ZERO]: 10n ** 18n, [USDC_BASE]: 5_000_000_000n },
  });
  const arbitrum = createChainReads({ chainId: 42161, tokens: [] });
  const read = createReadStub({ answer: robinhoodRead });
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, hash: '#/new/network/8453/' + USDC_BASE, live: [],
    routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true,
    chainReads: { answer: (route, request) => (request.chainId === 42161 ? arbitrum : reads).answer(route, request) },
  });
  try {
    const page = s.page;
    const current = step => page.locator('li[data-step="' + step + '"][aria-current="step"]');
    await page.locator('[data-picker-network="8453"] input[name="pool-option"]').first().click({ timeout: 30_000 });
    await page.locator('[data-network-creation="unavailable"]').waitFor();
    await pressContinue(current('pool'));
    await pressContinue(current('range'));
    await current('amount').waitFor();
    await page.locator('li[data-step="amount"] [data-pair-balance="ready"]').first().waitFor({ timeout: 30_000 });
    await current('amount').locator('[data-pair-side="1"] input[inputmode="decimal"]').fill('1000');
    await pressContinue(current('amount'));
    const closed = page.locator('[data-create-position="closed"]');
    await closed.waitFor({ timeout: 30_000 });
    assert.equal(await closed.isDisabled(), true);
    assert.match(await page.locator('#create-reason').innerText(), /Base/);
    assert.equal(await page.locator('[data-create-position="live"]').count(), 0);
    assert.equal(s.planned.length, 0, 'public reads do not call the position planner');
    assert.equal(chain.chainNow(), 4663, 'preview cannot switch the wallet');
    assert.equal(chain.log.filter(method => method === 'wallet_switchEthereumChain').length, 0);
    assert.equal(chain.signed.length, 0);
    assert.equal(chain.sends.length, 0);
  } finally { await s.close(); }
});
