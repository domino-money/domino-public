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

async function markets({ live = [], originOpen = true, failed = false, hash = '#/markets', lookalike = false } = {}) {
  const chain = createV2Chain({ chainId: 8453, timestamp: Math.floor(Date.now() / 1000) });
  chain.switchTo(4663);
  const read = createReadStub();
  const chainReads = readings({ lookalike });
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, hash, connect: false, originOpen, live,
    contracts: Object.fromEntries(live.map(id => [id, contractsFor(id)])),
    routes: [(request, url) => read.handle(request, url) ?? undefined], artwork: true,
    chainReads: { answer: failed ? () => ({ status: 501, body: { error: 'not_enabled' } }) : chainReads.answer },
  });
  return { ...s, chain, chainReads };
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
    await page.locator('[data-network-token-view="8453"] h1').filter({ hasText: 'CAT' }).waitFor();
    const pools = page.locator('[data-picker-network="8453"]');
    await pools.locator('[data-pool-key]').waitFor({ timeout: 30_000 });
    // Changed on purpose 2026-10-30 (QA round 2, N5, the owner's yes): each row opens New position on its network with
    // that pool proposed (a button that says so), never a deposit selection here.
    assert.equal(await pools.locator('input').count(), 0, 'Markets rows compare verified pools without a dead deposit selection');
    assert.ok(await pools.locator('button[data-open-pool]').count() > 0, 'each row opens New position with its pool');
    assert.match(await pools.locator('button[data-open-pool]').first().textContent(), /Create a position in this pool/, 'the row says where it leads');
    assert.equal(await page.locator('[data-network-new-position]').getAttribute('href'), `#/new/network/8453/${TOKEN}`);
    await inspectSizes(page);
    const poolKey = await pools.locator('[data-pool-key]').first().getAttribute('data-pool-key');
    await pools.locator('button[data-open-pool]').first().click();
    await page.waitForFunction(expected => window.location.hash === expected, `#/new/network/8453/${TOKEN}/${poolKey}`);
    await page.evaluate(token => { window.location.hash = `#/markets/network/8453/${token}`; }, TOKEN);
    await page.locator('[data-network-token-view="8453"] h1').filter({ hasText: 'CAT' }).waitFor();
    // A direct chain change with the same contract must immediately drop the old token metadata.
    await page.evaluate(token => { window.location.hash = `#/markets/network/42161/${token}`; }, TOKEN);
    await page.locator('[data-network-token-view="42161"] h1').filter({ hasText: 'ARBCAT' }).waitFor();
    assert.equal(await page.locator('[data-network-token-view="42161"] header [data-chain-chip]').innerText(), 'Arbitrum One');
    await page.locator('[data-picker-network="42161"] [data-pool-key]').waitFor({ timeout: 30_000 });
    await page.getByRole('navigation', { name: 'Breadcrumb', exact: true }).getByRole('link', { name: 'Markets', exact: true }).click();
    await search.fill(TOKEN);
    for (const id of [8453, 42161]) await page.locator(`[data-token-network-option="${id}:${TOKEN}"]`).waitFor();
    await page.locator(`[data-token-network-option="8453:${TOKEN}"]`).click();
    await page.locator('[data-network-new-position]').click();
    await page.locator('[data-create-journey]').waitFor();
    await page.locator('[data-picker-network="8453"] [data-pool-key]').waitFor({ timeout: 30_000 });
    assert.equal(await page.getByRole('combobox', { name: 'Search a token', exact: true }).inputValue(), 'CAT');
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
    await s.page.locator('[data-picker-network="8453"] [data-pool-key]').waitFor({ timeout: 30_000 });
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
    assert.equal(await s.page.locator('[data-network-new-position]').count(), 0);
    noWalletActions(s.chain);
  } finally { await s.close(); }
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
    assert.equal(await page.locator('[data-found-pools], button[data-open-pool]').count(), 0);
    assert.equal(await page8453.locator('[data-network-token-spent]').count(), 0, 'refused, never "reload to see its pools"');
    noWalletActions(chain);
  } finally { await s.close(); }
});
