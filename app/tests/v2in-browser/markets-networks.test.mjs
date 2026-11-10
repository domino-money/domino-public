import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openJourney } from '../support/journey-browser.mjs';
import { launchBrowser } from '../support/s1-browser.mjs';
import { closeBrowser } from '../support/close-browser.mjs';
import { WALLET_V2_DIST } from '../support/wallet-dist.mjs';
import { contractsFor, createV2Chain, poolIdOf } from '../support/v2-chain.mjs';
import { createReadStub } from '../support/read-stub.mjs';
import { createChainReads } from '../support/chain-reads.mjs';

const ZERO = '0x0000000000000000000000000000000000000000';
// Deliberately the same contract address on both networks: chain identity must survive every screen.
const TOKEN = '0x1111222233334444555566667777888899990000';
const SQRT = 79228162514264337593543950336n;
const POOL = { dex: 4, currency0: ZERO, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: ZERO };
let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await closeBrowser(browser); });

// Added 2026-11-02 (review M1): a "USDC" an attacker deployed on Base, and its pool against CAT.
const FAKE_USDC = '0x9999999999999999999999999999999999999999';
const WARNED_POOL = { dex: 4, currency0: TOKEN, currency1: FAKE_USDC, fee: 3000, tickSpacing: 60, hooks: ZERO };

function readings({ lookalike = false } = {}) {
  const sources = Object.fromEntries([8453, 42161].map(chainId => [chainId, createChainReads({
    chainId,
    tokens: [
      { address: ZERO, symbol: 'ETH', name: 'Ether', decimals: 18, sources: ['profile'] },
      { address: TOKEN, symbol: chainId === 8453 ? 'CAT' : 'ARBCAT', name: 'Network Cat', decimals: 18, sources: ['uniswap_default_list'] },
      ...(lookalike && chainId === 8453 ? [{ address: FAKE_USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6, sources: ['looked_up'] }] : []),
    ],
    pools: [{ pool: POOL, sqrtPriceX96: SQRT, tick: 0, liquidity: 10n ** 18n }, ...(lookalike && chainId === 8453 ? [{ pool: WARNED_POOL, sqrtPriceX96: SQRT, tick: 0, liquidity: 10n ** 18n }] : [])],
  })]));
  return { sources, answer: (route, request) => sources[request.chainId]?.answer(route, request) };
}

/**
 * Added 2026-11-06 (the replica rule): DEX Screener's pairs for CAT on Base, its ETH pool's figures, as the provider names
 * a v4 pool (its id) and native ETH (the zero address).
 */
const CAT_PAIRS = `https://api.dexscreener.com/token-pairs/v1/base/${TOKEN}`;
const catDex = (url) => (url === CAT_PAIRS ? [{ chainId: 'base', dexId: 'uniswap', labels: ['v4'], pairAddress: poolIdOf(POOL), baseToken: { address: TOKEN, symbol: 'CAT' }, quoteToken: { address: ZERO, symbol: 'ETH' }, liquidity: { usd: 250000 }, volume: { h24: 50000 } }] : undefined);

async function markets({ live = [], originOpen = true, failed = false, hash = '#/markets', lookalike = false, dex = null, answer = null, clock = false, routes = [], prepare = null } = {}) {
  const chain = createV2Chain({ chainId: 8453, timestamp: Math.floor(Date.now() / 1000) });
  chain.switchTo(4663);
  const read = createReadStub();
  const chainReads = readings({ lookalike });
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, hash, connect: false, originOpen, live,
    contracts: Object.fromEntries(live.map(id => [id, contractsFor(id)])),
    routes: [...routes, (request, url) => read.handle(request, url) ?? undefined], artwork: true, dex,
    chainReads: { answer: answer ? answer(chainReads) : failed ? () => ({ status: 501, body: { error: 'not_enabled' } }) : chainReads.answer },
    clock, prepare,
  });
  return { ...s, chain, chainReads, read };
}

const noWalletActions = chain => {
  assert.equal(chain.log.some(method => ['eth_requestAccounts', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'personal_sign', 'eth_sendTransaction'].includes(method)), false, 'public discovery never connects, switches or asks the wallet to sign');
  assert.equal(chain.multicalls.length, 0, 'public discovery never falls back to wallet RPC');
  assert.equal(chain.sends.length, 0);
};

async function inspectSizes(page) {
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `network pool view fits ${width}px`);
    if (process.env.DOMINO_UI_CAPTURE_DIR) {
      mkdirSync(process.env.DOMINO_UI_CAPTURE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.DOMINO_UI_CAPTURE_DIR, `markets-base-token-${width}.png`), fullPage: true, animations: 'disabled' });
    }
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
}

test('Markets searches names and contracts on every creation network, keeps same-address identities, and hands the token to New position', async () => {
  const s = await markets({ live: [8453, 42161] });
  try {
    const { page, chain, chainReads } = s;
    const search = page.getByRole('combobox', { name: 'Search a token', exact: true });
    await search.fill('Network Cat');
    for (const id of [8453, 42161]) await page.locator(`[data-token-network-option="${id}:${TOKEN}"]`).waitFor();
    assert.equal((await page.locator(`[data-token-network-option="8453:${TOKEN}"] [data-chain-chip]`).innerText()).trim(), 'Base');
    assert.equal((await page.locator(`[data-token-network-option="42161:${TOKEN}"] [data-chain-chip]`).innerText()).trim(), 'Arbitrum One');
    await page.locator(`[data-token-network-option="8453:${TOKEN}"]`).click();
    // Changed on purpose 2026-11-06 (the replica rule): Robinhood Chain's token page: "Token" over the network, the token's
    // card, its pools in the Markets table; each row opens the pool's own page, and nothing opens New position here.
    const view = page.locator('[data-network-token-view="8453"]');
    await view.locator('#stored-token-title').filter({ hasText: 'CAT' }).waitFor();
    assert.equal((await view.locator('h1').innerText()).trim(), 'Token');
    const poolKey = poolIdOf(POOL).toLowerCase();
    const row = view.locator(`[data-pool-row="${poolKey}"]`);
    await row.waitFor({ timeout: 30_000 });
    assert.equal(await row.locator('a.dm-mkt-name').getAttribute('href'), `/pool/network/8453/${poolKey}/${TOKEN}`, 'the row opens the pool page on its network');
    assert.equal(await row.locator('[data-pool-price="usable"]').count(), 1, 'the price column, from the pool’s own state');
    assert.equal(await row.locator('[data-chain-chip="8453"]').innerText(), 'Base');
    assert.equal(await view.locator('input, button[data-open-pool], [data-network-new-position]').count(), 0, 'no deposit selection and no New position on a token page');
    await inspectSizes(page);
    await row.click();
    await page.waitForFunction(expected => location.pathname + location.hash === expected, `/pool/network/8453/${poolKey}/${TOKEN}`);
    const pool = page.locator(`[data-pool-workspace="${poolKey}"][data-pool-network="8453"]`);
    await pool.waitFor({ timeout: 30_000 });
    assert.equal(await pool.locator('[data-new-position]').getAttribute('href'), `/new/network/8453/${TOKEN}/${poolKey}`);
    await page.evaluate(token => { window.location.hash = `#/markets/network/8453/${token}`; }, TOKEN);
    await view.locator('#stored-token-title').filter({ hasText: 'CAT' }).waitFor();
    // A direct chain change with the same contract must immediately drop the old token metadata.
    await page.evaluate(token => { window.location.hash = `#/markets/network/42161/${token}`; }, TOKEN);
    const arbitrum = page.locator('[data-network-token-view="42161"]');
    await arbitrum.locator('#stored-token-title').filter({ hasText: 'ARBCAT' }).waitFor();
    assert.equal(await arbitrum.locator('.dm-mkt-titlebar [data-chain-chip]').innerText(), 'Arbitrum One');
    await arbitrum.locator(`[data-pool-row="${poolKey}"]`).waitFor({ timeout: 30_000 });
    await page.getByRole('navigation', { name: 'Breadcrumb', exact: true }).getByRole('link', { name: 'Markets', exact: true }).click();
    await search.fill(TOKEN);
    for (const id of [8453, 42161]) await page.locator(`[data-token-network-option="${id}:${TOKEN}"]`).waitFor();
    await page.locator(`[data-token-network-option="8453:${TOKEN}"]`).click();
    // New position, from the pool's page, as on Robinhood Chain: that pool proposed and chosen.
    await view.locator(`[data-pool-row="${poolKey}"]`).click();
    await pool.locator('[data-new-position]').click();
    await page.locator('[data-create-journey]').waitFor();
    await page.locator(`[data-chosen-pool="${poolKey}"]`).waitFor({ timeout: 30_000 });
    assert.ok(chainReads.sources[8453].calls.some(call => call.route === 'chain-tokens' && call.request.query === 'Network Cat'));
    assert.ok(chainReads.sources[42161].calls.some(call => call.route === 'chain-tokens' && call.request.query === 'Network Cat'));
    noWalletActions(chain);
  } finally { await s.close(); }
});

test('Markets public discovery works with creation in preview, and a closed origin never offers unavailable networks', async () => {
  const s = await markets();
  try {
    await s.page.getByRole('combobox', { name: 'Search a token', exact: true }).fill('Network Cat');
    await s.page.locator(`[data-token-network-option="8453:${TOKEN}"]`).click();
    await s.page.locator(`[data-network-token-view="8453"] [data-pool-row]`).first().waitFor({ timeout: 30_000 });
    noWalletActions(s.chain);
  } finally { await s.close(); }
  const closed = await markets({ originOpen: false });
  try {
    await closed.page.getByRole('combobox', { name: 'Search a token', exact: true }).fill(TOKEN);
    await closed.page.locator('[role="listbox"]').waitFor();
    assert.equal(await closed.page.locator('[data-token-network-option]').count(), 0);
    await closed.page.evaluate(token => { window.location.hash = `#/markets/network/8453/${token}`; }, TOKEN);
    // Changed on purpose 2026-10-30 (QA round 2, the owner's rule: no "unavailable" line on a read surface): the closed
    // network's state is data only; "Pool discovery is unavailable on this network." is gone.
    await closed.page.locator('[data-network-token-view="8453"] [data-network-token-state="closed"]').waitFor({ state: 'attached' });
    assert.doesNotMatch(await closed.page.locator('main').innerText(), /unavailable/i);
    assert.equal(await closed.page.locator('[data-network-new-position]').count(), 0);
    noWalletActions(closed.chain);
  } finally { await closed.close(); }
});

test('Markets keeps service failure distinct from no pools and never falls back to a live wallet', async () => {
  const s = await markets({ live: [8453, 42161], failed: true });
  try {
    await s.page.evaluate(token => { window.location.hash = `#/markets/network/8453/${token}`; }, TOKEN);
    // (2026-10-15, pack 7 review): the failure settled first; the loading line's words are gone (no status notices), so
    // filtering on them no longer waited for anything. Changed on purpose 2026-10-30 (QA round 2, the owner's rule: no
    // Try again on a read surface): the token is read again on its own, quietly; its failure is data, and the page rests.
    await s.page.locator('[data-network-token-view="8453"] [data-network-token-state]:not([data-network-token-state="reading"]):not([data-network-token-state="checking"])').waitFor({ state: 'attached', timeout: 30_000 });
    assert.equal(await s.page.getByRole('button', { name: /Try again|Retry/ }).count(), 0, 'no Try again on a read surface');
    assert.doesNotMatch(await s.page.locator('main').innerText(), /unavailable|could not be verified/i);
    assert.equal(await s.page.locator('[data-pools-empty]').count(), 0, 'an unavailable lookup is never an empty-pool result');
    assert.equal(await s.page.locator('[data-network-new-position], [data-pool-row]').count(), 0);
    noWalletActions(s.chain);
  } finally { await s.close(); }
});

// Added 2026-11-06 (review UI-3): a Base token page whose pools read fails for good says what Robinhood Chain's token page
// says then (StoredTokenExplorer), with no table; it drew the table with "No pools to show for this token.", as if the token
// had none. A read that answered with no pools keeps that line.
test('a Base token whose pools read fails for good: Robinhood Chain\'s "Reload the page" line, no table; none found keeps its line', async () => {
  const opened = async (s) => {
    const search = s.page.getByRole('combobox', { name: 'Search a token', exact: true });
    await search.fill('Network Cat');
    await s.page.locator(`[data-token-network-option="8453:${TOKEN}"]`).click();
    const view = s.page.locator('[data-network-token-view="8453"]');
    await view.locator('#stored-token-title').filter({ hasText: 'CAT' }).waitFor();
    return view;
  };
  // Every pools read refused for the moment (the reader's own 503): asked again quietly, then given up.
  const down = await markets({ live: [8453, 42161], clock: true, answer: (reads) => (route, request) => (route === 'chain-pools' ? { status: 503, body: { error: 'upstream_unavailable' } } : reads.answer(route, request)) });
  try {
    const view = await opened(down);
    const spent = view.locator('[data-network-token-spent]');
    for (let step = 0; step < 20 && (await spent.count()) === 0; step++) {
      await down.page.clock.fastForward(31_000);
      await down.page.waitForTimeout(250);
    }
    assert.equal(await spent.innerText(), 'Reload the page to see this token’s pools.');
    assert.equal(await spent.getAttribute('data-pools-unavailable'), 'network_search_unavailable', 'the code, as data');
    assert.equal(await view.locator('[data-pools-empty], [data-pool-row], table').count(), 0, 'no table, and never "no pools"');
    assert.doesNotMatch(await view.innerText(), /No pools to show/);
    noWalletActions(down.chain);
  } finally { await down.close(); }
  // A read that answered with no pools: the table's own line, as before.
  const bare = createChainReads({ chainId: 8453, tokens: [{ address: ZERO, symbol: 'ETH', name: 'Ether', decimals: 18, sources: ['profile'] }, { address: TOKEN, symbol: 'CAT', name: 'Network Cat', decimals: 18, sources: ['uniswap_default_list'] }], pools: [] });
  const none = await markets({ live: [8453, 42161], answer: (reads) => (route, request) => (route === 'chain-pools' && request.chainId === 8453 ? bare.answer(route, request) : reads.answer(route, request)) });
  try {
    const view = await opened(none);
    const empty = view.locator('[data-pools-empty]');
    await empty.waitFor({ timeout: 30_000 });
    assert.equal(await empty.innerText(), 'No pools to show for this token.');
    assert.equal(await view.locator('[data-network-token-spent]').count(), 0);
  } finally { await none.close(); }
});

// Added 2026-11-02 (review M1, REVISAO_DINHEIRO_LOGIN.md). A Base link #/new/network/8453/<token>/<pool> opened New position
// with any token chosen and the link's pool chosen as soon as Base's read listed it: an attacker's "USDC", or its pool,
// opened ready to fund with no word about it, where the search lists it with a warning and never chooses it and Robinhood
// Chain's link refuses such a pool (audit I1). Markets' token page offered New position for it, and its pool rows open
// New position with the pool proposed. Now the link's pool is chosen only when none of its tokens passes for Base's own
// (a pool row's link included), the token never, and its page says why and offers nothing to put money in.
test('review M1: a Base link never chooses a token passing for USDC or a pool with one; its Markets page warns and offers no New position', async () => {
  const good = poolIdOf(POOL).toLowerCase(), warned = poolIdOf(WARNED_POOL).toLowerCase();
  const s = await markets({ live: [8453], lookalike: true, hash: `#/new/network/8453/${TOKEN}/${good}` });
  try {
    const { page, chain } = s;
    const warning = 'This isn’t the USDC Domino uses. Adding money to its pools can lose it.';
    // The link's own pool, without a look-alike, is chosen as before: the way in works here.
    await page.locator(`[data-chosen-pool="${good}"]`).waitFor({ timeout: 30_000 });
    // The same token's link proposing the pool against the fake USDC: listed, never chosen, and said.
    await page.evaluate((hash) => { window.location.hash = hash; }, `#/new/network/8453/${TOKEN}/${warned}`);
    await page.reload();
    await page.locator(`[data-picker-network="8453"] [data-pool-key="${warned}"]`).waitFor({ timeout: 30_000 });
    const refused = page.locator('[data-picker-network="8453"] [data-preselect-withdrawn]');
    await refused.waitFor();
    assert.equal(await refused.innerText(), 'For safety, Domino doesn’t open positions in this pool. Choose another pool.');
    assert.equal(await page.locator('[data-chosen-pool]').count(), 0, 'the proposed pool is not chosen');
    assert.equal(await page.getByRole('combobox', { name: 'Search a token', exact: true }).inputValue(), 'CAT', 'the token stays, for another pool');
    // A link to the fake USDC itself: New position never opens with it chosen; the warning, and the way back to the search.
    await page.evaluate((hash) => { window.location.hash = hash; }, `#/new/network/8453/${FAKE_USDC}/${warned}`);
    const handoff = page.locator('[data-network-handoff="unavailable"][data-token-warning="lookalike"]');
    await handoff.waitFor({ timeout: 30_000 });
    assert.equal(await handoff.innerText(), warning);
    assert.equal(await page.locator('[data-create-journey]').count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Search again', exact: true }).count(), 1);
    // Its Markets page: the warning, as Robinhood Chain's token page says it, and no New position or pool to open.
    await page.evaluate((token) => { window.location.hash = `#/markets/network/8453/${token}`; }, FAKE_USDC);
    const page8453 = page.locator('[data-network-token-view="8453"]');
    await page8453.locator('[data-token-warning="lookalike"]').waitFor({ timeout: 30_000 });
    assert.equal(await page8453.locator('[data-token-warning="lookalike"]').innerText(), warning);
    assert.equal(await page.locator('[data-network-new-position]').count(), 0);
    assert.equal(await page.locator('[data-found-pools], button[data-open-pool], [data-pool-row]').count(), 0);
    assert.equal(await page8453.locator('[data-network-token-spent]').count(), 0, 'refused, never "reload to see its pools"');
    // Added 2026-11-06 (the replica rule): the pool against the fake USDC, on its own page, says so first, as Robinhood
    // Chain's pool page says it of such a pool, and offers no way to put money in.
    await page.evaluate(({ warned, token }) => { window.location.hash = `#/pool/network/8453/${warned}/${token}`; }, { warned, token: TOKEN });
    const warnedPool = page.locator(`[data-pool-workspace="${warned}"]`);
    await warnedPool.locator('[data-pool-warning="lookalike"]').waitFor({ timeout: 30_000 });
    assert.equal(await warnedPool.locator('[data-pool-warning="lookalike"]').innerText(), 'This isn’t the USDC Domino uses. Adding money to this pool can lose it.');
    assert.equal(await page.locator('[data-new-position], [data-new-position-again]').count(), 0, 'no Create a position');
    noWalletActions(chain);
  } finally { await s.close(); }
});

// Added 2026-11-06 (the owner's replica rule, O-01 to O-04: Base and Arbitrum are an exact copy of Robinhood Chain's
// screens). A Base pool's page is Robinhood Chain's pool page: its figures from Base's pools read and DEX Screener's
// (TVL, 24h volume, an APR marked "est."), the earnings estimate, the typical range, what Domino can do here, Technical
// details and Create a position; the price history, the recent activity and Domino's own history are left out without a
// word, as no read has them for Base yet. The token page's rows carry the same figures; the search says each hit's
// liquidity as Robinhood Chain's does. Read with one chain-pools answer reused, never through the wallet.
test('replica: a Base pool’s page is Robinhood Chain’s, fed from Base’s reads and DEX Screener; the token page and the search carry the same figures', async () => {
  const s = await markets({ live: [8453, 42161], dex: catDex });
  try {
    const { page, chain, chainReads } = s;
    const poolKey = poolIdOf(POOL).toLowerCase();
    const search = page.getByRole('combobox', { name: 'Search a token', exact: true });
    await search.fill('Network Cat');
    const hit = page.locator(`[data-token-network-option="8453:${TOKEN}"]`);
    await hit.locator('[data-token-liquidity]').waitFor({ timeout: 30_000 });
    assert.equal((await hit.locator('[data-token-liquidity]').innerText()).trim(), '$250.0K liquidity', 'the liquidity line, in Robinhood Chain’s words');
    await hit.click();
    const view = page.locator('[data-network-token-view="8453"]');
    const row = view.locator(`[data-pool-row="${poolKey}"]`);
    await row.locator('[data-figure-source="discovered"]').first().waitFor({ timeout: 30_000 });
    const rowText = await row.innerText();
    assert.match(rowText, /\$250\.0K/, 'TVL, DEX Screener’s');
    assert.match(rowText, /\$50\.0K/, '24h volume, DEX Screener’s');
    assert.match(await row.locator('[data-apr-estimate="fallback"]').innerText(), /% est\.$/, 'the APR marked as an estimate, as Markets marks it');
    // Added 2026-11-06 (review of the replica): the row's figures sheet, as Robinhood Chain's: the same figures, DEX
    // Screener named in Details, no price history block (none exists for Base), and Open pool leads to the pool's page.
    await row.locator('button[data-pool-figures]').click();
    const sheet = page.locator('[data-pool-figures-dialog]');
    await sheet.waitFor({ timeout: 10_000 });
    assert.match(await sheet.locator('[data-figures-summary]').innerText(), /% est\.[\s\S]*\$250\.0K[\s\S]*\$50\.0K/);
    assert.equal(await sheet.locator('.dm-pool-chart, [data-pool-chart-awaiting-source]').count(), 0, 'no price history block in the sheet');
    assert.doesNotMatch(await sheet.innerText(), /Price history/);
    assert.equal((await sheet.locator('[data-chain-chip="8453"]').innerText()).trim(), 'Base');
    await sheet.locator('[data-figures-sources] summary').click();
    assert.match(await sheet.locator('[data-figures-sources]').innerText(), /Data sources\s*DEX Screener, not checked by Domino/);
    assert.equal(await sheet.locator('[data-pool-figures-open]').getAttribute('href'), `/pool/network/8453/${poolKey}/${TOKEN}`, 'Open pool leads to the pool’s own page');
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached', timeout: 10_000 });
    await row.click();
    const pool = page.locator(`[data-pool-workspace="${poolKey}"][data-pool-network="8453"]`);
    await pool.waitFor({ timeout: 30_000 });
    assert.match(await pool.locator('h1').innerText(), /CAT\s*\/\s*ETH/, 'named as its price is written');
    assert.equal(await pool.locator('.dm-pool-chips [data-chain-chip="8453"]').innerText(), 'Base');
    const figures = await pool.locator('[data-pool-figures]').innerText();
    assert.match(figures, /APR[\s\S]*% est\./);
    assert.match(figures, /24h volume[\s\S]*\$50\.0K/);
    assert.match(figures, /TVL[\s\S]*\$250\.0K/);
    assert.equal(await pool.locator('[data-pool-price-now]').count(), 1, 'the pool’s price, from its own state');
    assert.equal(await pool.locator('[data-pool-earnings="ready"]').count(), 1, 'the earnings estimate works on its APR and TVL');
    assert.equal(await pool.locator('[data-pool-automation="available"]').count(), 1);
    assert.equal(await pool.locator('.dm-pool-a-range').count(), 1, 'the typical range');
    assert.equal(await pool.locator('.dm-pool-a-chart, .dm-pool-a-recent, [data-history-apr]').count(), 0, 'no block without data');
    assert.equal(await pool.locator('[data-pool-offlist]').count(), 1, 'Robinhood Chain’s caution for a pool off Domino’s list');
    assert.equal(await pool.locator('[data-new-position]').getAttribute('href'), `/new/network/8453/${TOKEN}/${poolKey}`);
    assert.doesNotMatch(await page.locator('main').innerText(), /unavailable|not available|coming soon|as of/i, 'no notice about what is missing');
    await pool.locator('[data-pool-details] summary').click();
    const details = await pool.locator('[data-pool-details]').innerText();
    assert.match(details, /Network\s*Base/);
    assert.match(details, /Figures from\s*DEX Screener/);
    assert.doesNotMatch(details, /Domino history/);
    assert.match(details, /Estimated APR\s*[\d.]+% est\./, 'the estimate the page shows, never a dash');
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `the Base pool page fits ${width}px`);
      if (process.env.DOMINO_UI_CAPTURE_DIR) {
        mkdirSync(process.env.DOMINO_UI_CAPTURE_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.DOMINO_UI_CAPTURE_DIR, `pool-base-${width}.png`), fullPage: true, animations: 'disabled' });
      }
    }
    await page.setViewportSize({ width: 1280, height: 1000 });
    const pooled = chainReads.sources[8453].calls.filter((call) => call.route === 'chain-pools');
    assert.ok(pooled.length <= 2, `the token's pools read once and reused: ${pooled.length} chain-pools reads`);
    // A pool its network's read does not list: Robinhood Chain's words for a link that names no pool, with the network.
    await page.evaluate(({ token }) => { window.location.hash = `#/pool/network/8453/0x${'ab'.repeat(32)}/${token}`; }, { token: TOKEN });
    await page.locator('[data-pool-network-missing]').waitFor({ timeout: 30_000 });
    assert.match(await page.locator('[data-pool-network-missing]').innerText(), /We couldn’t find this pool[\s\S]*no pool at this link on Base/);
    // A network Domino does not serve is no pool: Robinhood Chain's words for a link that names none.
    await page.evaluate(() => { window.location.hash = `#/pool/network/1/0x${'ab'.repeat(32)}/0x${'11'.repeat(20)}`; });
    await page.locator('main').getByText('That isn’t a pool id', { exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(await page.locator('[data-pool-network-missing], [data-pool-workspace]').count(), 0);
    // Base's rows are never stood in for with Robinhood Chain's figures, nor asked about there (lib/read/useFallback.ts).
    assert.equal(s.dexAsked.some((url) => url.includes('/robinhood/') && url.toLowerCase().includes(TOKEN.slice(2))), false, 'no Robinhood Chain DEX Screener ask for a Base token');
    // Added 2026-11-06 (review of the replica): Robinhood Chain's read service is never asked about a Base pool or token
    // (no market, history, activity, positions or token read for them): it describes Robinhood Chain only.
    const asked = s.read.requests.map((request) => `${request.path} ${request.body ?? ''}`.toLowerCase());
    assert.deepEqual(asked.filter((line) => line.includes(poolKey.slice(2)) || line.includes(TOKEN.slice(2))), [], 'no Robinhood Chain read names the Base pool or token');
    noWalletActions(chain);
  } finally { await s.close(); }
});

// Added 2026-11-07 (the live site that day: Base USDC's and Arbitrum One WETH's WETH/USDC rows had dashes for TVL, 24h
// volume and APR). DEX Screener lists 30 pairs a token, not ranked by liquidity, and those tokens' 30 named none of the
// pools their pages list. Here the page's DEX resolver is built as production builds it (our edge first), behind our
// edge's real route code (tests/support/dex-edge-route.mjs), over a provider whose 30 pairs for CAT name none of CAT's
// pools: the rows they leave out are asked of our edge by their own names, once, and the token page, the figures sheet,
// the pool's page and New position's list show DEX Screener's own figures where the dashes were. The provider is never
// asked from the page.
test('the 30-pair cap: a Base pool CAT’s 30 pairs leave out is asked of our edge by its id; its row, sheet, page and New position’s list show DEX Screener’s figures', async () => {
  const { createDexEdgeRoute, createDexUpstream, edgeOnInTestBuild } = await import('../support/dex-edge-route.mjs');
  const poolKey = poolIdOf(POOL).toLowerCase();
  // CAT's 30 pairs: other exchanges, other tokens, never CAT's Uniswap pool.
  const thirty = Array.from({ length: 30 }, (_, i) => ({
    chainId: 'base', dexId: 'aerodrome', pairAddress: `0x${(i + 1).toString(16).padStart(40, 'a')}`, baseToken: { address: TOKEN, symbol: 'CAT' },
    quoteToken: { address: `0x${(i + 1).toString(16).padStart(40, 'b')}`, symbol: `T${i}` }, liquidity: { usd: 1000 + i }, volume: { h24: 10 },
  }));
  const upstream = createDexUpstream({ byUrl: (url) => {
    if (url === `https://api.dexscreener.com/token-pairs/v1/base/${TOKEN}`) return thirty;
    if (url === `https://api.dexscreener.com/latest/dex/pairs/base/${poolKey}`) {
      return { schemaVersion: '1.0.0', pairs: [{ chainId: 'base', dexId: 'uniswap', labels: ['v4'], pairAddress: poolKey, baseToken: { address: TOKEN, symbol: 'CAT' }, quoteToken: { address: ZERO, symbol: 'ETH' }, liquidity: { usd: 250000 }, volume: { h24: 50000 } }], pair: null };
    }
    return url.startsWith('https://api.dexscreener.com/latest/dex/pairs/') ? { schemaVersion: '1.0.0', pairs: null, pair: null } : undefined;
  } });
  const edge = createDexEdgeRoute(upstream);
  let rewrites = null;
  const s = await markets({ live: [8453, 42161], routes: [edge.handle], hash: `#/markets/network/8453/${TOKEN}`, prepare: async (context, origin) => { rewrites = await edgeOnInTestBuild(context, origin); } });
  try {
    const { page, chain } = s;
    const view = page.locator('[data-network-token-view="8453"]');
    const row = view.locator(`[data-pool-row="${poolKey}"]`);
    await row.locator('[data-figure-source="discovered"]').first().waitFor({ timeout: 30_000 });
    assert.equal(rewrites.count, 1, 'the page’s DEX resolver is built as production builds it (our edge first)');
    const rowText = await row.innerText();
    assert.match(rowText, /\$250\.0K/, 'TVL, DEX Screener’s, where the dash was');
    assert.match(rowText, /\$50\.0K/, '24h volume, DEX Screener’s');
    assert.match(await row.locator('[data-apr-estimate="fallback"]').innerText(), /% est\.$/, 'and the APR worked out from them');
    const report = () => JSON.stringify({ asked: edge.asked, upstream: upstream.calls, direct: s.dexAsked });
    assert.deepEqual(edge.asked.filter((one) => one.kind === 'pairs').map((one) => [one.path, one.tokens, one.status]), [['dex2', [poolKey], 200]], `one ask of our edge, by the pool’s id: ${report()}`);
    assert.ok(upstream.calls.includes(`https://api.dexscreener.com/latest/dex/pairs/base/${poolKey}`), report());
    // The figures sheet: the same figures.
    await row.locator('button[data-pool-figures]').click();
    const sheet = page.locator('[data-pool-figures-dialog]');
    await sheet.waitFor({ timeout: 10_000 });
    assert.match(await sheet.locator('[data-figures-summary]').innerText(), /% est\.[\s\S]*\$250\.0K[\s\S]*\$50\.0K/);
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached', timeout: 10_000 });
    // The pool's page: the same figures, its earnings estimate on them.
    await row.click();
    const pool = page.locator(`[data-pool-workspace="${poolKey}"][data-pool-network="8453"]`);
    await pool.waitFor({ timeout: 30_000 });
    await pool.locator('[data-pool-earnings="ready"]').waitFor({ timeout: 30_000 });
    const figures = await pool.locator('[data-pool-figures]').innerText();
    assert.match(figures, /APR[\s\S]*% est\./);
    assert.match(figures, /24h volume[\s\S]*\$50\.0K/);
    assert.match(figures, /TVL[\s\S]*\$250\.0K/);
    assert.doesNotMatch(figures, /no recent fee rate/i);
    // New position's list on Base: the pool's row with the same figures.
    await pool.locator('[data-new-position]').click();
    await page.locator(`[data-chosen-pool="${poolKey}"]`).waitFor({ timeout: 30_000 });
    await page.locator(`[data-chosen-pool="${poolKey}"]`).getByRole('button', { name: 'Change pool', exact: true }).click();
    const listed = page.locator(`[data-picker="pool"][data-picker-network="8453"] li[data-pool-key="${poolKey}"]`);
    await listed.locator('[data-provider-figure="attributed"]').first().waitFor({ timeout: 30_000 });
    assert.deepEqual(await listed.locator('[data-provider-figure]').evaluateAll((cells) => cells.map((cell) => [cell.getAttribute('data-provider'), cell.innerText.replace(/\s+/g, ' ').trim()])), [
      ['dexscreener', 'TVL $250.0K'],
      ['dexscreener', '24h volume $50.0K'],
    ]);
    await edge.settle();
    // Asked once for every screen (a name is not asked again within a minute), and never of the provider by the page.
    assert.equal(upstream.calls.filter((url) => url.includes('/latest/dex/pairs/')).length, 1, report());
    assert.deepEqual(s.dexAsked, [], `the provider is never asked from the page: ${report()}`);
    assert.ok(edge.asked.every((one) => one.path === 'dex2' && one.status === 200), report());
    noWalletActions(chain);
  } finally { await s.close(); }
});

// Added 2026-11-07: the pools asked by name are asked again beside their token a minute before their figures would age
// (components/read/screens/PoolPicker.tsx useNetworkPools), so the row keeps its figures past ten minutes and never shows
// the "more than 10 minutes old" dash in between.
test('the 30-pair cap: a pool asked by name is asked again a minute before its figures would age, and keeps them', async () => {
  const { createDexEdgeRoute, createDexUpstream, edgeOnInTestBuild } = await import('../support/dex-edge-route.mjs');
  const poolKey = poolIdOf(POOL).toLowerCase();
  const upstream = createDexUpstream({ byUrl: (url) => {
    if (url === `https://api.dexscreener.com/token-pairs/v1/base/${TOKEN}`) return [];
    if (url === `https://api.dexscreener.com/latest/dex/pairs/base/${poolKey}`) {
      return { schemaVersion: '1.0.0', pairs: [{ chainId: 'base', dexId: 'uniswap', labels: ['v4'], pairAddress: poolKey, baseToken: { address: TOKEN, symbol: 'CAT' }, quoteToken: { address: ZERO, symbol: 'ETH' }, liquidity: { usd: 250000 }, volume: { h24: 50000 } }], pair: null };
    }
    return undefined;
  } });
  const edge = createDexEdgeRoute(upstream);
  const s = await markets({ live: [8453, 42161], routes: [edge.handle], hash: `#/markets/network/8453/${TOKEN}`, clock: true, prepare: async (context, origin) => { await edgeOnInTestBuild(context, origin); } });
  try {
    const { page } = s;
    const row = page.locator(`[data-network-token-view="8453"] [data-pool-row="${poolKey}"]`);
    await row.locator('[data-figure-source="discovered"]').first().waitFor({ timeout: 30_000 });
    const byName = () => edge.asked.filter((one) => one.kind === 'pairs').length;
    assert.equal(byName(), 1);
    // Nine minutes and ten seconds on: asked again, by its name, before its figures are ten minutes old.
    await page.clock.fastForward(9 * 60_000 + 10_000);
    for (let step = 0; step < 40 && byName() < 2; step++) await page.waitForTimeout(100);
    assert.equal(byName(), 2, JSON.stringify(edge.asked));
    // Past the first figures' ten minutes: the row still shows DEX Screener's figures, never the "too old" dash.
    await page.clock.fastForward(60_000);
    await page.waitForTimeout(500);
    assert.match(await row.innerText(), /\$250\.0K[\s\S]*\$50\.0K/);
    assert.equal(await row.locator('[data-provider-reason="dexscreener_too_old"], [title*="more than 10 minutes old"]').count(), 0);
    assert.deepEqual(s.dexAsked, [], 'the provider is never asked from the page');
  } finally { await s.close(); }
});
