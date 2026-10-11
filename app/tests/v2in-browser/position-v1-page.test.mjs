/**
 * Domino V2's row on V1's own position page (screens/PositionDetail.tsx's one Domino V2 mount,
 * src/v2in/position/PositionV2Actions.tsx), on the wallet-test-v2 build (V1's wallet-test build with V2 compiled in), the
 * gate open on the test server's origin through the test build's own hook (`window.__dominoV2Test.originOpen`: `preview`,
 * as the preview alias opens it). A Robinhood v4 position V1 reads itself: tests/support/position-chain.mjs is the wallet
 * (Uniswap's PositionManager and StateView with their real runtime code), tests/support/browser-chain.mjs the site's
 * chain routes; connected, not signed in, as V1's position-actions suite opens it.
 *
 *   - V1's actions row keeps exactly its own actions (Automate, Collect fees, Close position), as V1's suites read it,
 *     and ends with Domino's one "···" button (the owner, 2026-10-03: one row, few buttons), whose menu lists Add
 *     liquidity, Change range and Withdraw;
 *   - each runs to its review and says the gate's sentence where the wallet's button would be: an add, a change of range
 *     and a one-token withdrawal show what was chosen and no figure (no plan is asked before the deploy: real data only);
 *     a withdrawal in both tokens reads the position through the wallet, already on the position's chain (Uniswap's code
 *     verified against the chain profile), and shows what it pays, with no Domino fee;
 *   - nothing is sent or signed, and nothing leaves the page's own origin.
 *
 * The wallet answers the two reads Domino V2's direct client adds to V1's (getApproved, subscriber) as the
 * PositionManager does for a position nobody is approved for and nothing subscribes to; everything else is the V1 fake's.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { closeBrowser } from '../support/close-browser.mjs';
import { WALLET_V2_DIST } from '../support/wallet-dist.mjs';

const APP = resolve(import.meta.dirname, '../..');
if (!existsSync(join(WALLET_V2_DIST, 'index.html'))) throw new Error('.wallet-test-v2-dist is missing. Run npm run build:wallet-test-v2 first (npm run test:v2in does).');
if (!existsSync(resolve(APP, '.test-build/app/functions/_middleware.js'))) execFileSync(process.execPath, ['scripts/test.mjs', '--build-only'], { cwd: APP, stdio: 'ignore' });
const { browserChain, poolIdOf, routeChain } = await import('../support/browser-chain.mjs');
const { POSITION_MANAGER, createPositionChain } = await import('../support/position-chain.mjs');
const { createFakeSession } = await import('../support/fake-session.mjs');
const { createWalletServer } = await import('../support/wallet-server.mjs');
const { launchBrowser } = await import('../support/s1-browser.mjs');
const { plainPortfolio } = await import('../support/v2-plain-portfolio.mjs');

const require = createRequire(import.meta.url);
const position = require('../../.test-build/app/src/finance/position.js');
const shots = () => { const dir = process.env.DOMINO_POSITION_SHOTS || resolve(APP, '.test-artifacts'); mkdirSync(dir, { recursive: true }); return dir; };
const text = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();

const OWNER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168', UFG = '0xefab538cf3c29237a47c6afb145d50ddf204a0a3';
const TIMESTAMP = 1_790_000_000;
/** V1's position-actions suite's NFT 3135288 (its pool and range as read on mainnet), this wallet's, with fees earned since its last update. */
const NFT = { tokenId: 3135288n, key: { currency0: USDG, currency1: UFG, fee: 792831, tickSpacing: 9303, hooks: '0x0000000000000000000000000000000000000000' },
  tickLower: 334908, tickUpper: 353514, liquidity: 52252322368158n, sqrtPriceX96: 1975446435897848877405867861624282655n, tick: 340651,
  growthLast: [5n << 128n, 7n << 128n] };
NFT.growthNow = [NFT.growthLast[0] + (1234n << 128n) / NFT.liquidity + 1n, NFT.growthLast[1] + ((5n * 10n ** 17n) << 128n) / NFT.liquidity + 1n];
const FEES = [0, 1].map((i) => position.feesOwed(NFT.growthNow[i], NFT.growthLast[i], NFT.liquidity));
const LOCKED = 'This opens as soon as Domino\'s service is live on Robinhood Chain.';
/** getApproved(uint256), subscriber(uint256): Domino V2's direct client reads both; V1's fake knows neither. */
const ADDED_READS = new Set(['0x081812fc', '0x16a24131']);
const ZERO_WORD = `0x${'0'.repeat(64)}`;

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await closeBrowser(browser); });

/** V1's position page for NFT 3135288 on the V2 build, the gate open (`preview`), the wallet connected and not signed in. */
async function atPage() {
  const chain = createPositionChain(OWNER, { timestamp: TIMESTAMP, positions: [NFT] });
  const rpc = browserChain({
    positions: [{ tokenId: '3135288', holder: OWNER, key: NFT.key, tickLower: NFT.tickLower, tickUpper: NFT.tickUpper, liquidity: NFT.liquidity, unclaimed: FEES }],
    pools: { [poolIdOf(NFT.key)]: { sqrtPriceX96: NFT.sqrtPriceX96, tick: NFT.tick } },
    tokens: { [USDG]: { symbol: 'USDG', decimals: 6 }, [UFG]: { symbol: 'UFG', decimals: 18 } },
  });
  const fake = createFakeSession();
  // The setup contract's release, as V1's position-actions suite answers it (Automate reads it).
  const server = createWalletServer({ fake, dist: WALLET_V2_DIST, routes: [async (request, url) => {
    if (url.pathname !== '/api/setup/v1/release') return undefined;
    return new Response(JSON.stringify(chain.release), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Domino-Setup-Contract': '1.0.0-rc.1' } });
  }] });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  fake.origin = origin;
  const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
  const foreign = [], csp = [], errors = [], added = [];
  // Registered first, so the chain routes' own handlers (registered after) answer theirs: anything else off the origin is refused.
  await context.route((url) => !url.href.startsWith(origin), (route) => {
    foreign.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  // V1's optional token artwork at DEX Screener (src/lib/tokenArtwork.ts), answered as V1's suites answer it: nothing found.
  await context.route(/^https:\/\/(api|cdn)\.dexscreener\.com\//, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  const routed = await routeChain(context, rpc);
  await context.exposeFunction('__dominoV1PageWallet', async (method, params) => {
    const call = method === 'eth_call' ? params?.[0] : null;
    if (call && String(call.to).toLowerCase() === POSITION_MANAGER && ADDED_READS.has(String(call.data ?? call.input ?? '').slice(0, 10))) {
      added.push(String(call.data ?? call.input).slice(0, 10));
      return { result: ZERO_WORD };
    }
    return chain.request(method, params);
  });
  await context.exposeFunction('__dominoV1PageCsp', (line) => csp.push(line));
  await context.addInitScript((portfolio) => {
    window.__dominoV2Test = { originOpen: true, read6: { portfolio } };
    document.addEventListener('securitypolicyviolation', (event) => window.__dominoV1PageCsp(`${event.violatedDirective} ${event.blockedURI}`));
    const provider = {
      async request({ method, params }) {
        const reply = await window.__dominoV1PageWallet(method, params ?? []);
        if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code, data: reply.error.data });
        return reply.result;
      },
      on() { return provider; },
      removeListener() { return provider; },
    };
    const detail = Object.freeze({ info: Object.freeze({ uuid: '8f2a7d1c-0000-4000-8000-0000000000e4', name: 'Position Wallet', icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E', rdns: 'test.wallet.position' }), provider });
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  }, plainPortfolio(rpc, OWNER));
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const s = {
    page, chain, added,
    async close() {
      await context.close();
      await server.closeAll();
      assert.deepEqual(errors, [], 'no page error');
      assert.deepEqual(csp, [], 'no CSP violation');
      assert.deepEqual(foreign, [], 'no request to any host but the page’s own');
      assert.deepEqual(chain.refused, [], 'every method asked is one this wallet answers');
      assert.deepEqual(chain.missing, [], 'every call reached a contract that answers it');
      assert.ok(!chain.log.includes('personal_sign'), 'nothing is signed in');
      assert.deepEqual([routed.errors, routed.refused, routed.missing], [[], [], []], 'the chain routes were asked only what they answer');
    },
  };
  try {
    await page.goto(`${origin}/#/positions/3135288`);
    await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    // The header's Connect wallet, by its name (its `aria-haspopup` trigger is not findable in the V2 test build).
    await page.getByRole('button', { name: /Connect wallet/ }).first().click();
    await page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]').getByRole('button', { name: 'Connect Position Wallet', exact: true }).click();
    await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
    await page.keyboard.press('Escape');
    return s;
  } catch (error) {
    await s.close().catch(() => {});
    throw error;
  }
}

test('(h) V1\'s own page in preview: V1\'s actions row keeps its own actions and ends with Domino\'s "···" menu; each action runs to its review, then the gate\'s sentence; nothing is sent', async () => {
  const s = await atPage();
  try {
    const page = s.page;
    const detail = page.locator('[data-position-detail][data-position-id="3135288"]');
    await detail.waitFor({ timeout: 30_000 });
    const actions = detail.locator('.dm-pos-actions[data-position-actions]');
    const control = detail.locator('[data-automation-control]');
    await control.waitFor({ timeout: 30_000 });
    assert.equal(await control.count(), 1);
    assert.equal(await control.innerText(), 'Set up automation');
    assert.equal(await control.getAttribute('href'), '#/sequence/3135288');
    await actions.locator('[data-position-action="close"]').waitFor({ timeout: 15_000 });
    const more = actions.locator('[data-position-v2-actions="preview"] [data-position-v2-more]');
    await more.waitFor({ timeout: 30_000 });
    // Changed on purpose 2026-10-06 (the owner's point 5): the protection is named Auto-exit.
    assert.deepEqual(await actions.locator('button').allInnerTexts(), ['Collect fees', 'Add liquidity', 'Change range', 'Withdraw', 'Close position']);
    assert.deepEqual([await more.getAttribute('aria-label'), await more.getAttribute('role')], ['Position actions', 'group']);
    assert.equal(await actions.locator('[data-position-v2-action]').count(), 3, 'liquidity actions stay separate from automation');
    for (const button of await actions.locator('button').all()) assert.equal(await button.isVisible(), true);
    const setup = page.locator('[data-v2in-exit="plain"]');
    assert.equal(await setup.isVisible(), false, 'the empty setup card is no longer repeated below the position');
    assert.equal(await detail.locator('[data-position-v2-blocked]').count(), 0, 'nothing is blocked on this position');
    for (const width of [1440,1280,390,320]) {
      await page.setViewportSize({width,height:960});
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (width === 320) {
        const header = await page.evaluate(() => {
          const brand = document.querySelector('.dm-wordmark');
          const wallet = document.querySelector('.dm-wallet-pill');
          return { brandWidth: brand.getBoundingClientRect().width, brandContent: brand.scrollWidth, gap: wallet.getBoundingClientRect().left - brand.getBoundingClientRect().right };
        });
        assert.ok(header.brandContent <= header.brandWidth + 1 && header.gap >= 6, `connected header keeps visible branding clear of the wallet: ${JSON.stringify(header)}`);
      }
      await page.screenshot({path:join(shots(),'position-'+width+'.png'),fullPage:true,animations:'disabled'});
      assert.equal(await detail.locator('[data-cell="price"] .dm-pos-price .dm-fig-lg').evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); return range.getClientRects().length; }), 1, 'current price keeps its exact digits together at '+width);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true,'position fits at '+width);
    }
    await page.setViewportSize({width:1180,height:900});
    assert.equal(await detail.locator('[data-automation-panel]').isVisible(), false, 'plain positions go directly to setup');
    assert.equal(await actions.locator('[data-automate-entry]').count(), 1, 'setup follows Withdraw in the same action bar');
    assert.equal(await actions.locator('[data-position-v2-action="protect"]').count(), 0, 'no duplicate setup entry');
    const toolbar = await actions.locator('[data-position-v2-action="exit"], [data-automation-control]').evaluateAll((all) => all.map((item) => ({ label: item.textContent, height: item.getBoundingClientRect().height, top: item.getBoundingClientRect().top })));
    assert.deepEqual(toolbar.map((item) => item.label), ['Withdraw', 'Set up automation']);
    assert.equal(toolbar[0].height, toolbar[1].height, 'liquidity and automation controls share their height');
    assert.equal(toolbar[0].top, toolbar[1].top, 'setup sits beside Withdraw on desktop');
    /**
     * Opens the "···" menu, checks its entries, picks one (the menu closes on the pick). Changed on purpose 2026-10-04 (the
     * owner: stop-loss and take-profit inside the position): a plain position the wallet holds ends the list with it.
     */
    const pick = async (key) => {
      await actions.locator(`[data-position-v2-action="${key}"]`).click();
    };
    const inspectDialog = async (dialog, name) => {
      for (const width of [1180, 390, 320]) {
        await page.setViewportSize({width, height:900});
        await dialog.screenshot({path:join(shots(), name + '-' + width + '.png'),animations:'disabled'});
        assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, name + ' frame fits at ' + width);
        assert.equal(await dialog.locator('.dm-pa-body').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, name + ' body fits at ' + width);
        const foot = await dialog.locator('.dm-pa-foot').boundingBox();
        assert.ok(foot && foot.y >= 0 && foot.y + foot.height <= 901, name + ' confirmation remains visible at '+width+': '+JSON.stringify(foot));
      }
      await page.setViewportSize({width:1180,height:900});
    };
    for (const key of ['collect','close']) {
      await actions.locator(`[data-position-action="${key}"]`).click();
      const dialog=page.locator(`[role="dialog"][data-position-dialog="${key}"]`);
      await dialog.waitFor();
      await inspectDialog(dialog,key);
      await page.keyboard.press('Escape');
      await dialog.waitFor({state:'detached'});
    }


    // Add liquidity: the review shows what was chosen (no plan is asked before the deploy), then the gate's sentence, once.
    await pick('increase');
    const add = page.locator('[role="dialog"][data-position-dialog="v2-increase"]');
    assert.equal(await add.getAttribute('data-position-gate'), 'preview');
    await inspectDialog(add, 'add-liquidity');
    assert.equal(await text(add.locator('[data-position-fees-sent]')), 'Uncollected fees will also be sent to your wallet.');
    await add.locator('[data-position-amount] input').first().fill('1');
    await add.locator('[data-position-continue="increase"]').click();
    await add.locator('[data-position-request="increase"]').waitFor({ timeout: 30_000 });
    assert.match(await text(add.locator('[data-position-request="increase"]')), /^You put in 1 (USDG|UFG) Slippage 0\.5%$/);
    assert.equal(await text(add.locator('[data-position-locked]')), LOCKED);
    assert.equal(await add.locator('[data-position-locked]').count(), 1, 'the gate\'s sentence once');
    assert.equal(await add.locator('[data-position-confirm], [data-position-send], [data-position-preview-note], [data-position-test-data]').count(), 0, 'no wallet step, no second note and no test data in the preview');
    await inspectDialog(add, 'add-liquidity-review');
    await add.getByRole('button', { name: 'Back', exact: true }).click();
    assert.equal(await add.locator('[data-position-amount] input').first().inputValue(), '1', 'Back preserves the amount without submitting it');
    await add.getByRole('button', { name: 'Close', exact: true }).click();
    await add.waitFor({ state: 'detached' });
    assert.equal(await actions.locator('[data-position-v2-action="increase"]').evaluate(node => node === document.activeElement), true, 'cancel restores focus to the action that opened the sheet');

    // Change range: the same.
    await pick('changeRange');
    const range = page.locator('[role="dialog"][data-position-dialog="v2-changeRange"]');
    await inspectDialog(range, 'change-range');
    assert.match(await text(range.locator('[data-position-price-now]')), /^1 USDG = [\d.]+ UFG$/);
    assert.equal(await range.locator('[data-position-range-result]').getAttribute('data-position-range-result'), 'inside');
    const choices = range.getByRole('radiogroup', { name: 'Price range', exact: true });
    await choices.getByRole('radio', { name: 'Custom', exact: true }).click();
    await range.getByRole('textbox', { name: 'Lowest price', exact: true }).fill('300');
    await range.getByRole('textbox', { name: 'Highest price', exact: true }).fill('200');
    assert.equal(await range.locator('[data-position-continue="changeRange"]').isEnabled(), false, 'reversed custom prices cannot be reviewed');
    await range.getByRole('textbox', { name: 'Lowest price', exact: true }).fill('100');
    await range.getByRole('textbox', { name: 'Highest price', exact: true }).fill('500');
    assert.equal(await range.locator('[data-position-continue="changeRange"]').isEnabled(), true, 'custom prices on the pool spacing can be reviewed');
    await choices.getByRole('radio', { name: 'Medium', exact: true }).click();
    assert.equal(await text(range.locator('.dm-receipt-lede')), 'Changing the range closes this position and opens a new one (new NFT).');
    await range.locator('[data-position-continue="changeRange"]:not([disabled])').click();
    await range.locator('[data-position-request="changeRange"]').waitFor({ timeout: 30_000 });
    assert.match(await text(range.locator('[data-position-request="changeRange"]')), /^Price range 1 USDG = \S+ to \S+ UFG How much All Slippage 0\.5%$/);
    assert.equal(await text(range.locator('[data-position-locked]')), LOCKED);
    await inspectDialog(range, 'change-range-review');
    await range.getByRole('button', { name: 'Back', exact: true }).click();
    assert.equal(await range.getByRole('radio', { name: 'Medium', exact: true }).getAttribute('aria-checked'), 'true', 'Back keeps the chosen range');
    await range.getByRole('button', { name: 'Close', exact: true }).click();
    await range.waitFor({ state: 'detached' });

    // Withdraw in one token: through Domino (its fee said); what was chosen, then the gate's sentence.
    await pick('exit');
    const exit = page.locator('[role="dialog"][data-position-dialog="v2-exit"]');
    await inspectDialog(exit, 'withdraw');
    // Changed on purpose 2026-10-03 (the owner, point 9): what you receive is one choice of three cards, both tokens or either one.
    await exit.getByRole('radiogroup', { name: 'You receive' }).getByRole('radio', { name: 'UFG', exact: true }).click();
    assert.equal(await text(exit.locator('[data-position-way-note]')), 'Domino swaps for you: 0.65% of the amount swapped.');
    await exit.locator('[data-position-continue="exit"]').click();
    await exit.locator('[data-position-request="exit"]').waitFor({ timeout: 30_000 });
    assert.match(await text(exit.locator('[data-position-request="exit"]')), /^How much All Receive (USDG|UFG) Slippage 0\.5%$/);
    assert.equal(await text(exit.locator('[data-position-locked]')), LOCKED);
    await inspectDialog(exit, 'withdraw-one-token-review');
    // Back to the form: in both tokens, straight at Uniswap, the position read through the wallet (already on Robinhood
    // Chain: no switch is asked), no Domino fee.
    await exit.locator('[data-position-review-back]').click();
    await exit.getByRole('radiogroup', { name: 'You receive' }).getByRole('radio', { name: 'Both tokens' }).click();
    assert.equal(await text(exit.locator('[data-position-way-note]')), 'No Domino fee.');
    await exit.locator('[data-position-continue="exit"]').click();
    await exit.locator('[data-position-direct="ready"]').waitFor({ timeout: 30_000 });
    assert.match(await text(exit.locator('[data-position-receive="close"]')), /^You receive 0\.99\d* USDG 325\.70\d* UFG At least 0\.99\d* USDG 32\d\.\d+ UFG Domino fee No Domino fee Network fee Up to [\d.]+ ETH$/, 'principal and fees as the chain has them now');
    assert.equal(await text(exit.locator('[data-position-locked]')), LOCKED);
    assert.equal(await exit.locator('[data-position-send], [data-position-request]').count(), 0, 'no wallet button in the preview; the chain\'s figures, not the request');
    await inspectDialog(exit, 'withdraw-both-review');
    await page.screenshot({ path: join(shots(), 'position-v2-v1-page-withdraw.png') });
    await page.keyboard.press('Escape');
    await exit.waitFor({ state: 'detached' });

    assert.deepEqual(s.chain.sends, [], 'nothing was sent');
    assert.ok(!s.chain.log.includes('eth_sendTransaction'));
    assert.ok(!s.chain.log.includes('wallet_switchEthereumChain'), 'the wallet was never asked to switch chain');
    assert.deepEqual([...new Set(s.added)].sort(), ['0x081812fc', '0x16a24131'], 'the direct client read who may move the NFT and what subscribes to it');
  } finally { await s.close(); }
});
