/**
 * Elysium's money screens in the browser (added 2026-11-07, Elysium's screens; the owner's order of 6 Nov: "everything
 * ready and identical to Robinhood"). Day 9 rehearsed on the build that forces Elysium on (scripts/build-elysium-test.mjs,
 * `.wallet-test-v2-dist-elysium`: the synthetic profile of chain 99901, and read-v6 and position-plan-v1 as rugged97's
 * day-9 versions have them, naming 99901: scripts/elysium-rehearsal.mjs). Every fixture service here answers in those
 * versions' shape and is checked with their runtimes before it is served (tests/support/elysium-day9.mjs), so what each
 * screen draws is what day 9's packages accept. The wallet is a fake chain 99901 (tests/support/v2-chain.mjs), Uniswap v4
 * alone, HYPE native.
 *
 * What each test proves, on Elysium as on Robinhood Chain, Base and Arbitrum One:
 *   - Home: "Open positions on" names the four networks, Elysium last with its own mark; today's build has no such row;
 *   - Markets: the search's Elysium tag with its mark, the network token page, the network pool page with the network's
 *     name and mark, and its New position link;
 *   - New position on Elysium: its v4 pools alone, its amounts read by Domino's service, Max keeping 0.0005 HYPE for the
 *     network fee, the plan's review with the network fee in HYPE, the approval and the create on Elysium's v4 zap;
 *   - the position page: its chips with Elysium's name and mark, Fees earned from position-fees, Collect fees and Close
 *     position, its Details; Positions, Receipts and Activity rows naming Elysium with its mark; Automate's setup and
 *     Auto-exit on Elysium's position; the Wallet card's tokens on Elysium, read apart from Base's and Arbitrum One's;
 *   - a service that does not name 99901 yet: the existing not-available states, never a broken screen, and Base's rows
 *     unchanged beside them.
 *
 * DOMINO_ELYSIUM_SHOTS=<dir> keeps pictures for the owner.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { decodeFunctionData, parseAbi } from 'viem';
import { closeBrowser } from '../support/close-browser.mjs';
import { openJourney } from '../support/journey-browser.mjs';
import { launchBrowser } from '../support/s1-browser.mjs';
import { WALLET_V2_DIST } from '../support/wallet-dist.mjs';
import { contractsFor, createV2Chain, poolIdOf } from '../support/v2-chain.mjs';
import { createReadStub } from '../support/read-stub.mjs';
import { createChainReads } from '../support/chain-reads.mjs';
import { planAnswer, v4Path, ZERO } from '../support/s1-plans.mjs';
import { pressContinue } from '../support/new-position.mjs';
import { ELYSIUM_DAY9_PROFILE as PROFILE, PLAN_DAY9, READ_V6_DAY9 } from '../support/elysium-day9.mjs';
import { ELYSIUM_LIVE_DIST, ELYSIUM_REPO_FUNDS_FROM, ELYSIUM_REPO_FUNDS_TO, ELYSIUM_REPO_LIVE, ELYSIUM_REPO_STAGE } from '../support/elysium-profile.mjs';
import { openPositionPage } from '../support/position-v2-page.mjs';
import { createDirectChain } from '../support/v2-direct-chain.mjs';
import { activityOf, indexedToken, livePosition, portfolioOf, s1Action } from '../support/s1-read6.mjs';
import { walletBalancesAnswer } from '../support/wallet-networks.mjs';

const APP = resolve(import.meta.dirname, '../..');
// Changed on purpose 2026-11-07 (day-9 rehearsal, finding F5): the build that draws Elysium live, the forced one while the
// repository leaves it off, the usual one (rugged97's profile and our pinned record) once it turns it on
// (../support/elysium-profile.mjs); PROFILE follows it.
const LIVE_DIST = ELYSIUM_LIVE_DIST;
for (const dist of [WALLET_V2_DIST, LIVE_DIST]) {
  if (!existsSync(join(dist, 'index.html'))) throw new Error(`${dist} is missing: run npm run build:wallet-test-v2 and npm run build:wallet-test-v2-elysium first.`);
}
const SHOTS = process.env.DOMINO_ELYSIUM_SHOTS || null;
const shot = async (target, name, options = {}) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await target.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled', ...options });
};
const require = createRequire(import.meta.url);
const position = require('../../.test-build/app/src/finance/position.js');
const { fixedFeePercent } = require('../../.test-build/app/src/lib/read/screens/fee.js');
const ERC20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);

const ID = 99901;
const HEX = '0x1863d';
const OWNER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const ZAP_V4 = '0x00000000000000000000000000000000d0d00004';
const lower = (value) => String(value).toLowerCase();
const USDC = lower(PROFILE.chargeCurrencies.find((currency) => currency.rank === 1).address);
const WHYPE = lower(PROFILE.wrappedNative.address);
const V4_PM = lower(PROFILE.uniswap.v4.positionManager);
const CAT = '0x1111222233334444555566667777888899990000';
/**
 * Elysium's HYPE/USDC pool, the one its gas is priced at (the profile's gasPrice.poolNativeUsd). Changed on purpose
 * 2026-11-07 (day-9 rehearsal, finding F5): its stable, fee and tick spacing are the profile's own (500 and 10 on the
 * synthetic one), so the suite stands on the real profile's pool on day 9.
 */
const NATIVE_POOL = PROFILE.gasPrice.poolNativeUsd;
const POOL = { dex: 4, currency0: ZERO, currency1: lower(NATIVE_POOL.stable), fee: NATIVE_POOL.fee, tickSpacing: NATIVE_POOL.tickSpacing, hooks: ZERO };
/** That pool's fee as every chip writes it ("0.05%" on the synthetic profile), for a regular expression. */
const POOL_FEE = fixedFeePercent(POOL.fee).replace('.', '\\.');
const CAT_POOL = { dex: 4, currency0: ZERO, currency1: CAT, fee: 3000, tickSpacing: 60, hooks: ZERO };
/**
 * Added 2026-11-09 (Elysium's day 9, checklist step 6: DEX Screener lists Elysium as `elysium`): its pairs for ECAT, its
 * HYPE pool's figures, as the provider names a v4 pool (its id) and native HYPE (the zero address), as Base's suite does.
 */
const CAT_PAIRS = `https://api.dexscreener.com/token-pairs/v1/elysium/${CAT}`;
const catDex = (url) => (url === CAT_PAIRS ? [{ chainId: 'elysium', dexId: 'uniswap', labels: ['v4'], pairAddress: poolIdOf(CAT_POOL), baseToken: { address: CAT, symbol: 'ECAT' }, quoteToken: { address: ZERO, symbol: 'HYPE' }, liquidity: { usd: 250000 }, volume: { h24: 50000 } }] : undefined);
const TICK = -276330;
const SQRT = position.sqrtPriceAtTick(TICK);
const CAT_SQRT = 79228162514264337593543950336n;
const now = () => Math.floor(Date.now() / 1000);
/** A chip's network name: its last line (OP Mainnet's mark is the letters "OP"). */
const names = (texts) => texts.map((one) => one.trim().split(/\n/).at(-1).trim());
const text = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();
/** What the stylesheet draws before an element: its mark's file. */
const markOf = (locator) => locator.evaluate((node) => getComputedStyle(node, '::before').backgroundImage);
const ELYSIUM_MARK = /\/chains\/elysium\.png/;

/** Domino's service on Elysium: its tokens, its pools and the wallet's balances there, answered as day 9's read-v6 does. */
const elysiumReads = ({ balances = {}, pools = [{ pool: POOL, sqrtPriceX96: SQRT, tick: TICK, liquidity: 10n ** 18n }, { pool: CAT_POOL, sqrtPriceX96: CAT_SQRT, tick: 0, liquidity: 10n ** 18n }] } = {}) => createChainReads({
  chainId: ID,
  contract: READ_V6_DAY9.runtime,
  tokens: [
    { address: ZERO, symbol: 'HYPE', name: 'HYPE', decimals: 18, sources: ['profile'] },
    { address: WHYPE, symbol: 'WHYPE', name: 'Wrapped HYPE', decimals: 18, sources: ['profile'] },
    { address: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6, sources: ['profile', 'uniswap_default_list'] },
    { address: CAT, symbol: 'ECAT', name: 'Elysium Cat', decimals: 18, sources: ['uniswap_default_list'] },
  ],
  pools,
  balances,
});

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await closeBrowser(browser); });

/** A page of `dist` with Elysium's gate live on the fake chain's contracts, the wallet on Robinhood Chain. */
async function open(dist, hash, { reads = elysiumReads(), planner = () => undefined, live = [ID], answer = null, connect = false, balances = {}, eth = 10n ** 19n, dex = null } = {}) {
  const chain = createV2Chain({ chainId: ID, timestamp: now(), eth, balances, pools: [{ pool: POOL, sqrtPriceX96: SQRT, tick: TICK, liquidity: 10n ** 18n }] });
  chain.switchTo(4663);
  const read = createReadStub();
  const s = await openJourney(browser, chain, {
    dist, hash, connect, originOpen: true, live, contracts: Object.fromEntries(live.map((id) => [id, contractsFor(id)])), planner,
    routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true, dex,
    chainReads: { answer: answer ?? ((route, request) => reads.answer(route, request)) },
  });
  return { ...s, chain, reads };
}

// ---------------------------------------------------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------------------------------------------------

// Changed on purpose 2026-11-07 (day-9 rehearsal, finding F3): the usual build's half on its own, skipped once the
// repository turns Elysium on (that build is then the live one, below).
test('Home where Elysium is off (the usual build until day 9): no "Open positions on" row', async (t) => {
  if (ELYSIUM_REPO_LIVE) return t.skip('the repository turns Elysium on: the usual build is live');
  // Changed on purpose 2026-11-07 (Elysium's pre-launch): before the opening the usual build draws the row with Elysium's
  // chip and when it opens; tests/v2in-browser/elysium-surface.test.mjs "Elysium before live" holds that build.
  if (ELYSIUM_REPO_STAGE !== 'off') return t.skip(`the repository's stage is ${ELYSIUM_REPO_STAGE}`);
  const off = await open(WALLET_V2_DIST, '#/', { live: [] });
  try {
    await off.page.locator('.dm-hero-funding li').first().waitFor();
    assert.equal(await off.page.locator('.dm-hero-networks').count(), 0, 'no row today');
    assert.equal(await off.page.locator('.dm-hero-funding').count(), 1, 'Home\'s one row, "Bring funds from", as before');
    assert.doesNotMatch(await off.page.locator('main').innerText(), /Elysium|Open positions on/);
    await shot(off.page.locator('.dm-hero').first(), 'home-hero-today');
  } finally { await off.close(); }
});

test('Home: where Elysium is served, "Open positions on" names the four networks, Elysium last with its own mark', async () => {
  const s = await open(LIVE_DIST, '#/', { live: [] });
  try {
    const { page } = s;
    const row = page.locator('.dm-hero-networks');
    await row.waitFor();
    assert.equal(await row.getAttribute('aria-label'), 'Networks to open positions on');
    assert.equal(await text(row.locator('> span')), 'Open positions on');
    assert.deepEqual(names(await row.locator('li').allInnerTexts()), ['Robinhood Chain', 'Base', 'Arbitrum One', 'Elysium']);
    for (const href of await row.locator('li a').evaluateAll((links) => links.map((link) => link.getAttribute('href')))) assert.equal(href, '/new');
    const mark = row.locator('li:last-child [data-network="Elysium"] img');
    await page.waitForFunction(() => document.querySelector('.dm-hero-networks li:last-child img')?.complete === true);
    assert.equal(await mark.getAttribute('src'), '/chains/elysium.png');
    assert.ok(await mark.evaluate((image) => image.naturalWidth > 0 && !image.hidden), 'Elysium\'s mark is drawn, its own file');
    // "Bring funds from": Elysium last once funds can come from it (Changed on purpose 2026-11-09 (rugged97's #488: Relay for Elysium)), else what it was.
    assert.deepEqual(names(await page.locator('.dm-hero-funding:not(.dm-hero-networks) li').allInnerTexts()), ['Ethereum', 'Base', 'Arbitrum One', 'OP Mainnet', 'Robinhood Chain', ...(ELYSIUM_REPO_FUNDS_FROM ? ['Elysium'] : [])]);
    // One row gap under "Bring funds from", in the same chips; nothing runs off a phone.
    const [funding, networks] = await page.locator('.dm-hero-funding').evaluateAll((rows) => rows.map((node) => node.getBoundingClientRect().toJSON()));
    assert.ok(networks.top >= funding.bottom && networks.top - funding.bottom <= 16, 'directly under the funding row');
    await shot(page.locator('.dm-hero').first(), 'home-hero-open-positions-elysium');
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Home fits ${width}px`);
    }
    await page.setViewportSize({ width: 390, height: 900 });
    await shot(page.locator('.dm-hero').first(), 'home-hero-open-positions-elysium-390');
    await row.locator('li:last-child a').click();
    await page.waitForFunction(() => window.location.pathname + location.hash === '/new');
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// Markets: search, the network token page, the network pool page
// ---------------------------------------------------------------------------------------------------------------------

test('Markets on Elysium: the search\'s tag with its mark, the token page, and the pool page that says it is Elysium\'s, as Base\'s', async () => {
  const s = await open(LIVE_DIST, '#/markets', { dex: catDex });
  try {
    const { page, chain, reads } = s;
    const search = page.getByRole('combobox', { name: 'Search a token', exact: true });
    // Changed on purpose 2026-11-09 (Elysium's day 9, rugged97's #486: read-v6's chain-tokens names Base and Arbitrum One
    // alone for now): where the package's chain-tokens takes Elysium, a name finds its token there, as on Base; where it
    // does not, a name finds its own currencies (New position's tests below) and any other token is found by its pasted
    // address, named by chain-pools there. Either way the hit is the same row.
    const byName = READ_V6_DAY9.runtime.validateRequest('chain-tokens', { chainId: ID, query: 'Elysium Cat', limit: 8 });
    await search.fill(byName ? 'Elysium Cat' : CAT);
    const hit = page.locator(`[data-token-network-option="${ID}:${CAT}"]`);
    await hit.waitFor({ timeout: 30_000 });
    const tag = hit.locator('[data-chain-chip]');
    assert.equal((await tag.innerText()).trim(), 'Elysium');
    assert.equal(await tag.getAttribute('data-chain-chip'), String(ID));
    assert.match(await markOf(tag), ELYSIUM_MARK, 'its tag drawn from its own file');
    if (byName) assert.ok(reads.calls.some((call) => call.route === 'chain-tokens' && call.request.chainId === ID && call.request.query === 'Elysium Cat'), 'Elysium searched by Domino\'s service');
    else {
      assert.ok(reads.calls.some((call) => call.route === 'chain-pools' && call.request.chainId === ID), 'the pasted address read on Elysium by Domino\'s service');
      assert.ok(!reads.calls.some((call) => call.route === 'chain-tokens' && call.request.chainId === ID), 'chain-tokens is never asked about a chain its package does not name');
    }
    await shot(page.locator('main'), 'markets-search-elysium');
    await hit.click();
    // The token page: "Token" over the network, the token's card, its pools in the Markets table.
    const view = page.locator(`[data-network-token-view="${ID}"]`);
    await view.locator('#stored-token-title').filter({ hasText: 'ECAT' }).waitFor({ timeout: 30_000 });
    assert.equal((await view.locator('h1').innerText()).trim(), 'Token');
    const title = view.locator('.dm-mkt-titlebar [data-chain-chip]');
    assert.equal(await title.innerText(), 'Elysium');
    const key = poolIdOf(CAT_POOL).toLowerCase();
    const row = view.locator(`[data-pool-row="${key}"]`);
    await row.waitFor({ timeout: 30_000 });
    assert.equal(await row.locator('a.dm-mkt-name').getAttribute('href'), `/pool/network/${ID}/${key}/${CAT}`);
    assert.equal(await row.locator(`[data-chain-chip="${ID}"]`).innerText(), 'Elysium');
    assert.equal(await row.locator('[data-pool-price="usable"]').count(), 1, 'its price, from the pool\'s own state');
    // Added 2026-11-09 (Elysium's day 9, checklist step 6): its figures, DEX Screener's under Elysium's own name, as Base's.
    await row.locator('[data-figure-source="discovered"]').first().waitFor({ timeout: 30_000 });
    const rowText = await row.innerText();
    assert.match(rowText, /\$250\.0K/, 'TVL, DEX Screener\'s');
    assert.match(rowText, /\$50\.0K/, '24h volume, DEX Screener\'s');
    assert.match(await row.locator('[data-apr-estimate="fallback"]').innerText(), /% est\.$/, 'the APR marked as an estimate, as Markets marks it');
    assert.ok(s.dexAsked.some((url) => url === CAT_PAIRS), 'asked by Elysium\'s own name');
    await shot(page.locator('main'), 'markets-token-elysium');
    await row.click();
    await page.waitForFunction((expected) => window.location.pathname + location.hash === expected, `/pool/network/${ID}/${key}/${CAT}`);
    // The pool page: its network segment names Elysium with its mark; New position by Elysium's own link.
    const pool = page.locator(`[data-pool-workspace="${key}"][data-pool-network="${ID}"]`);
    await pool.waitFor({ timeout: 30_000 });
    const net = pool.locator(`.dm-pool-chips .dm-fee-net[data-chain-chip="${ID}"]`);
    assert.equal((await net.innerText()).trim(), 'Elysium');
    assert.match(await markOf(net), ELYSIUM_MARK, 'the pool page shows it is Elysium\'s: its name and its mark');
    assert.equal(await pool.locator(`dd[data-chain-chip="${ID}"]`).textContent(), 'Elysium', 'Details name its network');
    // Added 2026-11-09 (Elysium's day 9, checklist step 6): the pool page's figures, as Base's.
    const poolFigures = await pool.locator('[data-pool-figures]').innerText();
    assert.match(poolFigures, /APR[\s\S]*% est\./);
    assert.match(poolFigures, /24h volume[\s\S]*\$50\.0K/);
    assert.match(poolFigures, /TVL[\s\S]*\$250\.0K/);
    // Added 2026-11-07 (review finding P4): its native token is HYPE in Details, never "Native ETH".
    const details = await pool.locator('.dm-pool-kv').textContent();
    assert.match(details, /Native HYPE \(0x0000/);
    assert.doesNotMatch(details, /\bETH\b/);
    assert.equal(await pool.locator('[data-new-position]').getAttribute('href'), `/new/network/${ID}/${CAT}/${key}`);
    await shot(page.locator('main'), 'pool-page-elysium', { fullPage: true });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `the pool page fits ${width}px`);
    }
    await page.setViewportSize({ width: 1280, height: 1000 });
    await pool.locator('[data-new-position]').click();
    await page.locator('[data-create-journey]').waitFor();
    await page.locator(`[data-chosen-pool="${key}"]`).waitFor({ timeout: 30_000 });
    assert.equal(chain.log.some((method) => ['eth_requestAccounts', 'wallet_switchEthereumChain', 'eth_sendTransaction'].includes(method)), false, 'browsing asks the wallet nothing');
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// New position on Elysium
// ---------------------------------------------------------------------------------------------------------------------

/** position-plan-v1 on day 9, as it plans a create on Elysium's HYPE/USDC pool: 500 of its USDC swapped for HYPE. */
function elysiumPlanner(answers = []) {
  return (wire) => {
    if (wire.action !== 'create' || wire.chainId !== ID) return undefined;
    const pays = wire.inputs.some((input) => input.token === USDC);
    const legs = pays ? [{ tokenIn: USDC, tokenOut: ZERO, amountIn: 500_000_000n, expectedOut: 19_000_000_000_000_000_000n, data: v4Path(POOL) }] : [];
    const body = planAnswer(wire, { owner: OWNER, zap: ZAP_V4, now: now(), chains: PLAN_DAY9.CONSTANTS.chains, pool: { sqrtPriceX96: SQRT, tick: TICK }, legs, nonce: { word: 9, bit: answers.length }, expected: { amounts: [19_000_000_000_000_000_000n, 490_000_000n], returned: [{ token: USDC, amountRaw: '6750000' }] } });
    assert.ok(PLAN_DAY9.runtime.validateResponse('plan', body), 'the plan is day 9\'s package\'s');
    answers.push(body);
    return body;
  };
}

test('New position on Elysium: its v4 pools alone, its balances read by Domino\'s service, a review in HYPE, the approval and the create on its v4 zap', async () => {
  const balances = { [USDC]: 5_000_000_000n };
  const reads = elysiumReads({ balances });
  const answers = [];
  const s = await open(LIVE_DIST, '#/new', { reads, planner: elysiumPlanner(answers), connect: true, balances, eth: 2n * 10n ** 18n });
  try {
    const { page, chain } = s;
    await page.locator('[data-create-journey]').waitFor();
    await page.getByRole('combobox', { name: 'Search a token' }).fill('USDC');
    const hit = page.locator(`[data-token-network-option="${ID}:${USDC}"]`);
    await hit.waitFor({ timeout: 30_000 });
    assert.equal((await hit.locator(`[data-chain-chip="${ID}"]`).innerText()).trim(), 'Elysium');
    await hit.click();
    const pools = page.locator(`[data-picker="pool"][data-picker-network="${ID}"]`);
    await pools.locator('input[name="pool-option"]').first().waitFor({ timeout: 30_000 });
    assert.equal(await pools.locator(`li[data-pool-key="${poolIdOf(POOL)}"]`).count(), 1, 'Elysium\'s HYPE/USDC pool, from the service');
    assert.ok(reads.calls.filter((call) => call.route === 'chain-pools').every((call) => call.request.chainId === ID));
    assert.doesNotMatch(await pools.innerText(), /\bv3\b/, 'no v3 pool is offered on a network with v4 alone');
    assert.equal(await pools.locator(`[data-chain-chip="${ID}"]`).first().innerText(), 'Elysium');
    await shot(page.locator('main'), 'new-position-pools-elysium', { fullPage: true });
    assert.equal(chain.chainNow(), 4663, 'the wallet stays on Robinhood Chain for the pools');
    await pools.locator(`li[data-pool-key="${poolIdOf(POOL)}"] input[name="pool-option"]`).click();
    await page.locator('[data-chosen-pool]').waitFor();
    const current = (step) => page.locator(`li[data-step="${step}"][aria-current="step"]`);
    const noEther = async (step) => assert.doesNotMatch(await text(page.locator('[data-create-journey]')), /\b(?:ETH|WETH)\b/, `never Ether on a HYPE network: ${step}`);
    await noEther('pool');
    await pressContinue(current('pool'));
    await current('range').waitFor();
    await noEther('range');
    await pressContinue(current('range'));
    await current('amount').waitFor();
    await page.locator('li[data-step="amount"] [data-pair-balance="ready"]').first().waitFor({ timeout: 30_000 });
    await noEther('amount');
    assert.ok(reads.calls.some((call) => call.route === 'chain-balances' && call.request.wallet === OWNER && call.request.tokens.every((token) => token.chainId === ID)), 'Elysium\'s balances, asked of the service');
    assert.equal(chain.chainNow(), 4663, 'and still on Robinhood Chain for the balances');
    await shot(page.locator('main'), 'new-position-amounts-elysium', { fullPage: true });
    await page.locator('li[data-step="amount"][aria-current="step"] [data-pair-side="1"] input[inputmode="decimal"]').fill('1000');
    await pressContinue(current('amount'));
    const review = page.locator('[data-stage-card="review"] [data-zap-review="live"][data-zap-review-stage="reviewed"]');
    await review.waitFor({ timeout: 30_000 });
    assert.equal(chain.chainNow(), ID, 'the wallet moved to Elysium for the review');
    assert.deepEqual([s.planned[0].action, s.planned[0].chainId], ['create', ID]);
    assert.equal(s.planned[0].inputs.find((input) => input.token === USDC)?.amountRaw, '1000000000', 'the 1,000 USDC typed');
    // The network fee line fills in once the approval's own fee is read ("Checking…" until then).
    await page.waitForFunction(() => /Network fee: about [\d.]+ /.test(document.querySelector('[data-stage-card="review"]')?.textContent ?? ''), null, { timeout: 30_000 });
    const said = await text(page.locator('[data-stage-card="review"]'));
    assert.match(said, /HYPE/, 'the review names HYPE');
    assert.match(said, /Network fee: about [\d.]+ HYPE/, 'the network fee in HYPE');
    await noEther('review');
    await shot(page.locator('main'), 'new-position-review-elysium', { fullPage: true });
    await page.locator('[data-create-position="live"]:not([disabled])').click({ timeout: 30_000 });
    await page.locator('[data-created-position][data-zap-receipt]').waitFor({ timeout: 60_000 });
    assert.deepEqual(chain.sends.map((entry) => entry.tx.chainId), [HEX, HEX], 'the approval and the create, on Elysium');
    const [approve, create] = chain.sends.map((entry) => entry.tx);
    assert.equal(lower(approve.to), USDC);
    assert.deepEqual(decodeFunctionData({ abi: ERC20, data: approve.data }).args.map(lower), [lower(PROFILE.permit2), '1000000000'], 'USDC allowed to Elysium\'s Permit2 for signing');
    assert.equal(lower(create.to), ZAP_V4, 'the create, on Elysium\'s v4 zap');
    assert.deepEqual(chain.offChain, [], 'nothing of Elysium asked of the wallet while it was elsewhere');
    await shot(page.locator('main'), 'new-position-created-elysium', { fullPage: true });
  } finally { await s.close(); }
});

/** New position on Elysium up to its amount step, on the HYPE/USDC pool, with `balances` read by Domino's service. */
async function toAmounts(balances) {
  const s = await open(LIVE_DIST, '#/new', { reads: elysiumReads({ balances }), planner: elysiumPlanner(), connect: true, balances });
  const { page } = s;
  await page.locator('[data-create-journey]').waitFor();
  await page.getByRole('combobox', { name: 'Search a token' }).fill('USDC');
  await page.locator(`[data-token-network-option="${ID}:${USDC}"]`).click({ timeout: 30_000 });
  const pools = page.locator(`[data-picker="pool"][data-picker-network="${ID}"]`);
  await pools.locator(`li[data-pool-key="${poolIdOf(POOL)}"] input[name="pool-option"]`).click({ timeout: 30_000 });
  const current = (step) => page.locator(`li[data-step="${step}"][aria-current="step"]`);
  await pressContinue(current('pool'));
  await current('range').waitFor();
  await pressContinue(current('range'));
  await current('amount').waitFor();
  await page.locator('li[data-step="amount"] [data-pair-balance="ready"]').first().waitFor({ timeout: 30_000 });
  return { ...s, amount: current('amount') };
}

test('New position on Elysium: Max on HYPE keeps 0.0005 HYPE for the network fee, as Max keeps 0.0005 ETH on the Ether networks', async () => {
  const s = await toAmounts({ [ZERO]: 2n * 10n ** 18n, [USDC]: 5_000_000_000n });
  try {
    await s.amount.locator('[data-pair-max="0"]').click();
    assert.equal(await s.amount.locator('[data-pair-side="0"] input[inputmode="decimal"]').inputValue(), '1.9995', 'two HYPE less the 0.0005 HYPE kept');
    assert.match(await text(s.amount), /HYPE/);
    assert.doesNotMatch(await text(s.amount), /\bETH\b/, 'never Ether on a HYPE network');
    assert.equal(s.chain.sends.length, 0);
  } finally { await s.close(); }
});

// Added 2026-11-07 (review finding P1): no funds are brought to Elysium, so a short amount there is never pointed at an
// offer "below" that is not drawn; it says Robinhood Chain's own words (lower it, or add tokens to your wallet).
test('New position on Elysium: a wallet short of the amount is told what Base’s is where funds can be brought there, else to lower it or add tokens', async () => {
  const s = await toAmounts({ [ZERO]: 10n ** 15n, [USDC]: 5_000_000n });
  try {
    const { page } = s;
    await s.amount.locator('[data-pair-side="1"] input[inputmode="decimal"]').fill('1000');
    const short = s.amount.locator('[data-amount-short]');
    await short.waitFor({ timeout: 30_000 });
    // Changed on purpose 2026-11-09 (rugged97's #488: Relay for Elysium): where funds can be brought to Elysium, its short amount says Base's words, pointing at the offer below.
    if (ELYSIUM_REPO_FUNDS_TO) {
      assert.equal(await text(short), 'This amount needs more funds on this network.');
      return;
    }
    assert.match(await text(short), /^Your wallet doesn’t have enough (?:USDC or HYPE|HYPE or USDC) for this amount\. Lower it, or add tokens to your wallet\.$/);
    await page.waitForFunction(() => /\S/.test(document.querySelector('#continue-reason')?.textContent ?? ''), null, { timeout: 30_000 });
    assert.equal(await text(page.locator('#continue-reason')), 'Lower the amount, or add tokens to your wallet.');
    assert.doesNotMatch(await text(page.locator('[data-create-journey]')), /below|needs more funds on this network/, 'nothing is offered below on Elysium');
    assert.equal(await page.locator('[data-funds-offer]').count(), 0, 'and nothing is drawn there');
    await shot(page.locator('main'), 'new-position-short-elysium', { fullPage: true });
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// A position on Elysium: its page, the lists, Automate, the Wallet card
// ---------------------------------------------------------------------------------------------------------------------

const PID = 5_200_001;
/** About 1,000 ticks either side of TICK, on the pool's tick spacing (-277330 and -275330 at a spacing of 10). */
const RANGE = { tickLower: Math.floor((TICK - 1_000) / POOL.tickSpacing) * POOL.tickSpacing, tickUpper: Math.ceil((TICK + 1_000) / POOL.tickSpacing) * POOL.tickSpacing };
const LIQUIDITY = 10n ** 15n;
const PRINCIPAL = PLAN_DAY9.runtime.amountsForLiquidity(SQRT, PLAN_DAY9.runtime.sqrtAtTick(RANGE.tickLower), PLAN_DAY9.runtime.sqrtAtTick(RANGE.tickUpper), LIQUIDITY, false);
const READ6_FIXTURE = (path) => JSON.parse(readFileSync(new URL(`../../../api-contracts/read-v6/fixtures/${path}`, import.meta.url), 'utf8'));
const POOL_PRICES = READ6_FIXTURE('valid/chain-pools.json').tokens;
/** Day 9's prices on Elysium: USDC at $1, HYPE at its native pool alone (the profile's gasPrice pool), $1.25. */
const HYPE_PRICE = { ...POOL_PRICES.find((token) => token.symbol === 'LIVE').price, ethUsd: null, usd: '1.250000000000000000', depthUsd: '50000.000000', pool: { ...READ_V6_DAY9.CONSTANTS.priceProfiles[ID].nativePool } };
const USDC_PRICE = POOL_PRICES.find((token) => token.symbol === 'USDC').price;
const TOKENS = [{ ...indexedToken(ID, ZERO, 'HYPE', 18), price: HYPE_PRICE, priceReason: null }, { ...indexedToken(ID, USDC, 'USDC', 6), price: USDC_PRICE, priceReason: null }];
const livePid = (over = {}) => livePosition({ chainId: ID, manager: V4_PM, tokenId: PID, owner: OWNER, pool: POOL, ...RANGE, liquidity: LIQUIDITY, sqrtPriceX96: SQRT, tick: TICK, feesOwed: ['1000000000000000000', '2500000'], principal: PRINCIPAL, ...over });
const DAY9 = { contract: READ_V6_DAY9 };
const PORTFOLIO = portfolioOf({ wallet: OWNER, tokens: TOKENS, positions: [livePid({ approved: ZAP_V4 })], ...DAY9 });
const ACTIVITY = activityOf({ wallet: OWNER, items: [s1Action({ chainId: ID, wallet: OWNER, zap: ZAP_V4, action: 'create', tokenId: PID, pool: POOL, inputs: [{ token: USDC, amount: '1000000000' }] })], ...DAY9 });
/** read-v6's stored fee history of the position (position-fees, day 9's chain), at this pool's own price. */
function positionFees() {
  // Changed on purpose 2026-11-07 (day-9 rehearsal, finding F8): the package's next version's folder, never a literal.
  const stored = READ6_FIXTURE(`${READ_V6_DAY9.runtime.NEXT_VERSION}/valid/position-fees.json`);
  const body = { ...stored, chainId: ID, positions: [{ ...stored.positions[0], tokenId: String(PID), now: { ...stored.positions[0].now, pool: POOL, sqrtPriceX96: SQRT.toString(), tick: TICK, ...RANGE, inRange: true } }] };
  assert.equal(READ_V6_DAY9.runtime.validateExchange('position-fees', { chainId: ID, positions: [{ dex: 4, tokenId: String(PID) }] }, body), true, 'day 9\'s position-fees, naming Elysium');
  return { status: 200, body };
}
const ALL_SETS = { 4663: contractsFor(4663), 8453: contractsFor(8453), 42161: contractsFor(42161), [ID]: contractsFor(ID) };
/** chain-pools on Elysium for the position's pages (Details' Pool and New position links), answered as day 9's read-v6 does. */
const elysiumPools = (asked = []) => async (context) => {
  const reads = elysiumReads();
  await context.exposeFunction('__elysiumChainPools', (request) => { asked.push(request); return reads.answer('chain-pools', request); });
  await context.addInitScript(() => { window.__dominoV2Test.read6['chain-pools'] = (request) => window.__elysiumChainPools(request); });
};

test('a position on Elysium: its page as Robinhood Chain\'s, Elysium\'s name and mark, Fees earned and APR, its actions; Positions, Receipts and Automate name it', async () => {
  const chain = createV2Chain({ chainId: ID, timestamp: now(), positions: [{ dex: 4, tokenId: BigInt(PID), pool: POOL, ...RANGE, liquidity: LIQUIDITY, principal: PRINCIPAL, fees: [10n ** 18n, 2_500_000n], approved: ZAP_V4 }], pools: [{ pool: POOL, sqrtPriceX96: SQRT, tick: TICK, liquidity: 10n ** 18n }] });
  const asked = [];
  const s = await openPositionPage(browser, chain, { dist: LIVE_DIST, hash: `#/positions/elysium-v4-${PID}`, contracts: ALL_SETS, read6: { portfolio: PORTFOLIO, activity: ACTIVITY, 'position-fees': positionFees() }, prepare: elysiumPools(asked) });
  try {
    const { page } = s;
    const detail = page.locator(`[data-position-detail][data-position-v2="elysium-v4"][data-position-id="${PID}"]`);
    await detail.waitFor({ timeout: 30_000 });
    assert.equal(await text(detail.locator('h1')), 'HYPE / USDC');
    assert.match(await text(detail.locator('.dm-pos-chips')), new RegExp(`^Uniswap · ${POOL_FEE} fee Elysium Position #${PID} In range`));
    const network = detail.locator('[data-position-network="elysium"]');
    assert.equal(await text(network), 'Elysium');
    assert.match(await markOf(network), ELYSIUM_MARK, 'its chip draws Elysium\'s own mark');
    // Fees earned and Your APR, from read-v6's stored history on Elysium, in dollars, as on Robinhood Chain.
    const card = detail.locator('[data-fees-card][data-fees-state="verified"]');
    await card.waitFor({ timeout: 30_000 });
    assert.equal(await text(card.locator('h2')), 'Fees earned');
    assert.match(await text(card.locator('.dm-fees-hero')), /^\$\d/);
    const apr = detail.locator('[data-cell="apr"]');
    await page.waitForFunction(() => document.querySelector('[data-cell="apr"]')?.getAttribute('data-apr') === 'ready', null, { timeout: 30_000 });
    assert.match(await text(apr), /Your APR.*%/);
    // Added 2026-11-09 (Elysium's day 9, the owner: Fees earned's chart as on Base, Arbitrum One and Robinhood Chain): its
    // chart drawn from that stored history, with its periods.
    await card.locator('.dm-fees-chart').waitFor({ timeout: 30_000 });
    assert.match(await card.getAttribute('data-fees-period'), /^(?:24h|7d|all)$/i, 'its period');
    // Its actions, as on every network: Collect fees, the menu, Close position last; automation set up from here.
    assert.deepEqual(await detail.locator('[data-position-actions] [data-position-v2-action]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-position-v2-action'))), ['collect', 'increase', 'changeRange', 'exit']);
    assert.equal(await detail.locator('[data-position-v2-action="collect"]').isDisabled(), false);
    assert.equal(await detail.locator('[data-position-actions] > :last-child').getAttribute('data-position-action'), 'close');
    const automation = detail.locator('[data-automation-control]');
    await automation.waitFor();
    assert.equal(await automation.innerText(), 'Set up automation');
    // Details: Elysium's own pool page and New position in this pool, once its pools read lists the pool; Uniswap v4.
    await detail.locator('[data-position-details] summary').click();
    await detail.locator('[data-position-pool-link]').waitFor({ timeout: 30_000 });
    assert.ok(asked.every((request) => request.chainId === ID));
    assert.match(await detail.locator('[data-position-pool-link]').getAttribute('href'), new RegExp(`^/pool/network/${ID}/0x[0-9a-f]{64}/0x[0-9a-f]{40}$`));
    assert.match(await detail.locator('[data-position-new-in-pool]').getAttribute('href'), new RegExp(`^/new/network/${ID}/0x[0-9a-f]{40}/0x[0-9a-f]{64}$`));
    assert.equal(await text(detail.locator('[data-position-dex]')), 'v4');
    // Its receipt, from read-v6's activity on Elysium.
    await detail.locator('[data-position-activity-item]').first().waitFor({ timeout: 30_000 });
    assert.doesNotMatch(await text(detail), /\b(?:ETH|WETH)\b/, 'never Ether on a HYPE network');
    await shot(page, 'position-page-elysium', { fullPage: true });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `the page fits ${width}px`);
    }
    await page.setViewportSize({ width: 1280, height: 960 });
    // Positions: its row names Elysium with its mark, with its APR, as Robinhood Chain's rows.
    await page.evaluate(() => { location.hash = '#/positions'; });
    const row = page.locator('.dm-collection-network[data-v2-chain="99901"]').first();
    await row.waitFor({ timeout: 30_000 });
    assert.equal(await text(row), 'Elysium');
    assert.match(await markOf(row), ELYSIUM_MARK);
    await page.locator('[data-cell="apr"][data-apr="ready"]').first().waitFor({ timeout: 30_000 });
    await shot(page, 'positions-list-elysium', { fullPage: true });
    // Receipts: its create, on Elysium.
    await page.evaluate(() => { location.hash = '#/positions/receipts'; });
    const receipt = page.locator('li[data-v2-receipt-chain="99901"]').first();
    await receipt.waitFor({ timeout: 30_000 });
    assert.match(await text(receipt), /Elysium/);
    await shot(page, 'receipts-elysium', { fullPage: true });
    // Automate: Auto-exit opens on Elysium's position (v4), and its picker names Elysium.
    await page.evaluate(() => { location.hash = '#/automate'; });
    await page.locator('[data-v2in-protection]').waitFor({ timeout: 30_000 });
    await page.evaluate(() => { location.hash = '#/sequence/protection'; });
    const pick = page.locator(`[data-protection-position]`).filter({ hasText: `#${PID}` });
    await pick.waitFor({ timeout: 30_000 });
    assert.match(await text(pick), /Elysium/);
    // Added 2026-11-07 (review finding P2): its HYPE is never drawn with Ether's picture.
    assert.equal(await pick.locator('img[src*="/tokens/eth.svg"]').count(), 0, 'HYPE takes the plain mark, as on every other Elysium screen');
    await shot(page, 'automate-auto-exit-elysium', { fullPage: true });
  } finally { await s.close(); }
});

test('Collect fees and Close position on Elysium: straight to Uniswap\'s v4 PositionManager there, the network fee in HYPE', async () => {
  const V4 = { tokenId: BigInt(PID), pool: { currency0: POOL.currency0, currency1: POOL.currency1, fee: POOL.fee, tickSpacing: POOL.tickSpacing }, ...RANGE, liquidity: LIQUIDITY, sqrtPriceX96: SQRT, tick: TICK,
    growthLast: [5n << 128n, 7n << 128n], growthNow: [(5n << 128n) + (10n ** 15n << 128n) / LIQUIDITY + 1n, (7n << 128n) + (3_000_000n << 128n) / LIQUIDITY + 1n] };
  const chain = createDirectChain({ chainId: ID, v4: [V4], timestamp: now() });
  const s = await openPositionPage(browser, chain, { dist: LIVE_DIST, hash: `#/positions/elysium-v4-${PID}`, contracts: ALL_SETS, read6: { portfolio: portfolioOf({ wallet: OWNER, tokens: TOKENS, positions: [livePid()], ...DAY9 }) }, s1: { directCode: { [ID]: chain.codeHashes } } });
  try {
    const { page } = s;
    const detail = page.locator(`[data-position-detail][data-position-id="${PID}"]`);
    await detail.waitFor({ timeout: 30_000 });
    await detail.locator('[data-position-v2-action="collect"]').click();
    const collect = page.locator('[role="dialog"][data-position-dialog="v2-collect"]');
    await collect.locator('[data-position-direct="ready"]').waitFor({ timeout: 30_000 });
    assert.match(await text(collect.locator('[data-position-receive="collect"]')), /^You receive \$[\d.,]+ .*HYPE.*USDC Network fee Up to [\d.]+ HYPE$/);
    assert.doesNotMatch(await text(collect), /Domino fee|\bETH\b/);
    await shot(collect, 'position-collect-elysium');
    await page.keyboard.press('Escape');
    await collect.waitFor({ state: 'detached' });
    const close = detail.locator('[data-position-actions] > [data-position-action="close"]');
    assert.equal(await text(close), 'Close position');
    await close.click();
    const dialog = page.locator('[role="dialog"][data-position-dialog="v2-close"]');
    await dialog.locator('[data-position-direct="ready"]').waitFor({ timeout: 30_000 });
    assert.match(await text(dialog.locator('[data-position-receive="close"]')), /^You receive .*HYPE.*USDC At least .*HYPE.*USDC Network fee Up to [\d.]+ HYPE$/);
    await shot(dialog, 'position-close-elysium');
    await dialog.locator('[data-position-send="close"]:not([disabled])').click();
    await dialog.locator('[data-position-direct="done"]').waitFor({ timeout: 30_000 });
    assert.equal(chain.sends.length, 1);
    assert.equal(lower(chain.sends[0].tx.to), V4_PM, 'to Uniswap\'s v4 PositionManager on Elysium');
    assert.equal(chain.sends[0].tx.chainId, HEX);
  } finally { await s.close(); }
});

/** The Wallet card on Positions, with read-v6's chain-balances answered as day 9's does (`elysium`: false, refused for 99901). */
async function walletCard({ elysium = true } = {}) {
  const chain = createDirectChain({ chainId: 4663, timestamp: now(), v4: [] });
  const read = createReadStub({ reads: 'wallet-assets', answer: (route) => (route === 'wallet-assets' ? '{}' : undefined) });
  const asked = [];
  const held = { [`${ID}:${ZERO}`]: 4n * 10n ** 18n, [`${ID}:${USDC}`]: 12_000_000n, [`8453:${ZERO}`]: 10n ** 17n };
  const s = await openPositionPage(browser, chain, {
    dist: LIVE_DIST, hash: '#/positions', contracts: ALL_SETS, read6: { portfolio: portfolioOf({ wallet: OWNER, ...DAY9 }), activity: activityOf({ wallet: OWNER, ...DAY9 }) }, routes: [read.handle], s1: { directCode: { 4663: chain.codeHashes } },
    prepare: async (context) => {
      await context.exposeFunction('__elysiumWalletRead', (request) => {
        asked.push(request);
        if (!elysium && request.tokens.some((token) => token.chainId === ID)) return { status: 400, body: { error: 'invalid_request' } };
        return { status: 200, body: walletBalancesAnswer(request, { held, contract: READ_V6_DAY9 }) };
      });
      await context.addInitScript(() => { window.__dominoV2Test.read6['chain-balances'] = (request) => window.__elysiumWalletRead(request); });
    },
  });
  return { s, asked };
}
const cardRows = (page) => page.evaluate(() => [...document.querySelectorAll('[data-portfolio-tokens] [data-wallet-row]')].map((row) => ({
  chain: row.getAttribute('data-wallet-row-chain'), name: row.querySelector('.dm-acct-token-name')?.textContent ?? null, network: row.querySelector('.dm-acct-token-network')?.textContent ?? null,
})));

test('the Wallet card on Elysium: its HYPE and USDC with their network named, read apart from Base\'s and Arbitrum One\'s', async () => {
  const { s, asked } = await walletCard();
  try {
    const { page } = s;
    await page.waitForFunction(() => document.querySelectorAll('[data-portfolio-tokens] [data-wallet-row-chain="99901"]').length >= 2, null, { timeout: 30_000 });
    const rows = await cardRows(page);
    assert.deepEqual(rows.filter((row) => row.chain === String(ID)).map((row) => [row.name, row.network]), [['USDC', 'Elysium'], ['HYPE', 'Elysium']], 'by value: 12 USDC, then 4 HYPE at $1.25');
    assert.ok(rows.some((row) => row.chain === '8453' && row.name === 'ETH'), 'Base\'s ETH beside them');
    assert.match(await markOf(page.locator('[data-portfolio-tokens] .dm-acct-token-network[data-v2-chain="99901"]').first()), ELYSIUM_MARK);
    // Two reads: Base's and Arbitrum One's tokens in one, Elysium's in one of their own.
    assert.deepEqual(asked.map((request) => [...new Set(request.tokens.map((token) => token.chainId))]).sort(), [[8453, 42161], [ID]].sort());
    await shot(page.locator('[data-portfolio-tokens]'), 'wallet-card-elysium');
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// A service that does not name 99901 yet: the existing not-available states
// ---------------------------------------------------------------------------------------------------------------------

test('a service that does not name Elysium yet: no Elysium hit, its token page rests, the Wallet card keeps Base\'s rows, nothing broken', async () => {
  const base = createChainReads({ chainId: 8453, tokens: [{ address: ZERO, symbol: 'ETH', name: 'Ether', decimals: 18, sources: ['profile'] }, { address: CAT, symbol: 'CAT', name: 'Elysium Cat', decimals: 18, sources: ['uniswap_default_list'] }], pools: [{ pool: CAT_POOL, sqrtPriceX96: CAT_SQRT, tick: 0, liquidity: 10n ** 18n }] });
  // The Worker before day 9: any read that names 99901 is refused as its schema refuses it.
  const refused = { status: 400, body: { error: 'invalid_request' } };
  const answer = (route, request) => (request.chainId === ID || (request.tokens ?? []).some((token) => token.chainId === ID) ? refused : base.answer(route, request));
  const s = await open(LIVE_DIST, '#/markets', { answer });
  try {
    const { page } = s;
    await page.getByRole('combobox', { name: 'Search a token', exact: true }).fill('Elysium Cat');
    await page.locator(`[data-token-network-option="8453:${CAT}"]`).waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1_500);
    assert.equal(await page.locator(`[data-token-network-option^="${ID}:"]`).count(), 0, 'no Elysium hit');
    assert.doesNotMatch(await page.locator('main').innerText(), /unavailable|error|went wrong/i, 'no notice: the search lists what it has');
    // Elysium's token page: resting, as a network whose pools could not be read rests; no table and no New position.
    await page.evaluate((token) => { window.location.hash = `#/markets/network/99901/${token}`; }, CAT);
    await page.locator(`[data-network-token-view="${ID}"] [data-network-token-state]`).waitFor({ state: 'attached', timeout: 30_000 });
    assert.equal(await page.locator('[data-network-new-position], [data-pool-row]').count(), 0);
    assert.doesNotMatch(await page.locator('main').innerText(), /unavailable|error|went wrong/i);
  } finally { await s.close(); }
  const card = await walletCard({ elysium: false });
  try {
    const { page } = card.s;
    await page.waitForFunction(() => document.querySelector('[data-portfolio-tokens] [data-wallet-row-chain="8453"]') !== null, null, { timeout: 30_000 });
    await page.waitForTimeout(1_500);
    const rows = await cardRows(page);
    assert.equal(rows.some((row) => row.chain === String(ID)), false, 'no Elysium row while its read is refused');
    assert.ok(rows.some((row) => row.chain === '8453' && row.name === 'ETH'), 'Base\'s rows exactly as they are');
  } finally { await card.s.close(); }
});

test('New position on Elysium: its pool finder offers Uniswap v4 alone, Elysium\'s own currencies and v4\'s fee tiers', async () => {
  const s = await open(LIVE_DIST, '#/new', { reads: elysiumReads({ balances: { [USDC]: 5_000_000_000n } }), connect: true });
  try {
    const { page } = s;
    await page.locator('[data-create-journey]').waitFor();
    await page.getByRole('combobox', { name: 'Search a token' }).fill('USDC');
    await page.locator(`[data-token-network-option="${ID}:${USDC}"]`).click({ timeout: 30_000 });
    await page.locator(`[data-picker="pool"][data-picker-network="${ID}"] input[name="pool-option"]`).first().waitFor({ timeout: 30_000 });
    await page.locator('[data-pool-advanced] summary').click();
    // Added 2026-11-07 (review finding P5): "Create a new pool (advanced)" names no version to pick there either.
    const advanced = await text(page.locator('[data-pool-advanced]'));
    assert.match(advanced, /pick its two tokens and the fee, and Domino reads it through your wallet\./);
    assert.doesNotMatch(advanced, /the Uniswap version/);
    assert.equal(await page.locator('[data-network-find-other="4663"]').count(), 0, 'not Robinhood Chain\'s finder');
    await page.locator(`[data-network-find-other="${ID}"]`).click();
    const zap = page.locator(`[data-zap-journey="${ID}"][data-zap-gate="live"]`);
    await zap.waitFor();
    const finder = zap.locator('[data-pool-find]');
    // No version to pick there, so its line names none.
    assert.match(await text(zap), /Pick two tokens and the fee\. The pool is read through your wallet\./);
    assert.doesNotMatch(await text(zap), /the Uniswap version/);
    const version = finder.getByRole('radiogroup', { name: 'Uniswap version' });
    assert.equal(await version.getByRole('radio', { name: 'Uniswap v3' }).count(), 0, 'no Uniswap v3 on Elysium');
    const tokens = (await finder.getByRole('radiogroup', { name: 'First token' }).getByRole('radio').allInnerTexts()).map((one) => one.trim());
    assert.ok(['HYPE', 'USDC'].every((symbol) => tokens.includes(symbol)), `Elysium's own currencies: ${tokens}`);
    assert.ok(!tokens.some((symbol) => /^W?ETH$|^USDG$/.test(symbol)), `never another network's: ${tokens}`);
    const tiers = (await finder.getByRole('radiogroup', { name: 'Fee tier' }).getByRole('radio').allInnerTexts()).map((one) => one.trim());
    assert.ok(tiers.length > 0 && !['0.02%', '0.03%', '0.04%'].some((tier) => tiers.includes(tier)), `v4's tiers, never Base's extra v3 ones: ${tiers}`);
    await shot(page.locator('main'), 'new-position-finder-elysium', { fullPage: true });
  } finally { await s.close(); }
});
