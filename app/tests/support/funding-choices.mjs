/** Real Journey pool selection with deterministic local and remote wallet funds. No live service or wallet. */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { openFundingPage, USDG, ZERO, ARB_USDC, createChainReads, chainReads, together } from './funds-browser.mjs';
import { FIXTURE_TOKEN } from './read-stub.mjs';
import { poolIdOf } from './v2-chain.mjs';
import { pressContinue } from './new-position.mjs';

const require = createRequire(import.meta.url);
const { sqrtPriceAtTick } = require('../../.test-build/app/src/finance/position.js');
export const VIRTUAL = '0x9999999999999999999999999999999999999999';
export const OTHER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const tokens = [
  { address: ZERO, symbol: 'ETH', decimals: 18 }, { address: USDG, symbol: 'USDG', decimals: 6 },
  { address: VIRTUAL, symbol: 'VIRTUAL', decimals: 6 }, { address: OTHER, symbol: 'OTHER', decimals: 6 },
  { address: WETH, symbol: 'WETH', decimals: 18 },
];
const fixture = (name) => JSON.parse(readFileSync(new URL(`../../../api-contracts/read-v1/fixtures/gateway/${name}.json`, import.meta.url), 'utf8').replaceAll(FIXTURE_TOKEN, USDG).replaceAll('"TOKEN"', '"USDG"'));
const base = fixture('pools.success');
const makePool = (currency0, currency1, fee, tick) => {
  const pool = { dex: 4, currency0, currency1, fee, tickSpacing: 60, hooks: ZERO };
  return { ...base.pools[0], poolId: poolIdOf(pool), currencies: [currency0, currency1], currentLpFeePips: fee,
    poolKey: { ...base.pools[0].poolKey, currency0, currency1, fee_pips: fee }, tick, sqrtPriceX96: sqrtPriceAtTick(tick).toString() };
};
export const choicePools = [
  makePool(ZERO, USDG, 3000, -193380), makePool(USDG, VIRTUAL, 3000, 0),
  makePool(USDG, OTHER, 10000, 0), makePool(WETH, USDG, 3000, -193380),
  makePool(VIRTUAL, OTHER, 3000, 0),
];
export const amountStep = (page) => page.locator('li[data-step="amount"][aria-current="step"]');
export const typeSide = (page, side, text) => amountStep(page).locator(`[data-pair-side="${side}"] input[inputmode="decimal"]`).fill(text);

export async function changeFundingPool(page, index) {
  await page.locator('li[data-step="pool"] button').first().click();
  await page.getByRole('button', { name: 'Change pool', exact: true }).click();
  await page.locator(`[data-picker="pool"] [data-pool-key="${choicePools[index].poolId}"] input[name="pool-option"]`).click();
  await page.locator('[data-chosen-pool]').waitFor();
  await pressContinue(page.locator('li[data-step="pool"][aria-current="step"]'));
  await pressContinue(page.locator('li[data-step="range"][aria-current="step"]'));
  await amountStep(page).waitFor();
  await amountStep(page).locator('[data-pair-balance="ready"]').first().waitFor();
}

export async function openFundingChoice(browser, { poolIndex = 0, eth = 10n ** 18n, weth = 0n, searchToken = USDG, ...options } = {}) {
  const amounts = { [ZERO]: eth, [WETH]: weth };
  const metadata = (token) => ({ ...base.tokens[0], ...token, kind: token.address === ZERO ? 'native' : 'erc20_candidate' });
  const readReply = (route, request) => {
    if (route === 'token') return JSON.stringify({ ...fixture('token.success'), asset: metadata(tokens.find((token) => token.address === request.token)) });
    if (route === 'pools') {
      const listed = choicePools.filter((pool) => pool.currencies.includes(request.token));
      return JSON.stringify({ ...base, selectedToken: request.token, pools: listed, tokens: tokens.map(metadata),
        discovery: { ...base.discovery, returned: listed.length, v4Candidates: listed.length } });
    }
    if (route === 'wallet-assets') {
      const body = fixture('wallet-assets.zero');
      const model = body.items.find((token) => token.address === USDG);
      return JSON.stringify({ ...body, items: tokens.map((token) => ({ ...model, ...token, kind: token.address === ZERO ? 'native' : 'erc20_candidate', amountRaw: String(amounts[token.address] ?? 0n) })) });
    }
    return undefined;
  };
  const local = createChainReads({ chainId: 4663, tokens, balances: amounts });
  const chosen = choicePools.filter((pool) => pool.currencies.includes(searchToken))[poolIndex];
  return openFundingPage(browser, { bridge: true, localLive: true, readReply, searchToken, poolKey: chosen.poolId,
    ethWei: eth, balances: { native: { 4663: eth }, tokens: { [`4663:${WETH}`]: { balance: weth, decimals: 18 } } },
    served: together(local, chainReads(42161, ARB_USDC, 100_000_000n, 10n ** 17n)), ...options });
}
