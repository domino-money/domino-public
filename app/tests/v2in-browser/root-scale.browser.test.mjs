/** A hybrid tablet can change pointer capability without crossing a width breakpoint. Its chart must follow the CSS scale. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as runtime from '../../../api-contracts/position-plan-v1/runtime.mjs';
import { launchBrowser } from '../support/s1-browser.mjs';
import { closeBrowser } from '../support/close-browser.mjs';
import { createV2Chain } from '../support/v2-chain.mjs';
import { indexedToken, livePosition, portfolioOf } from '../support/s1-read6.mjs';
import { openPositionPage } from '../support/position-v2-page.mjs';

const require = createRequire(import.meta.url);
const { sqrtPriceAtTick } = require('../../.test-build/app/src/finance/position.js');
const OWNER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const ZERO = '0x0000000000000000000000000000000000000000';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const MANAGER = '0x7c5f5a4bbd8fd63184577525326123b519429bdc';
const POOL = { dex: 4, currency0: ZERO, currency1: USDC, fee: 500, tickSpacing: 10, hooks: ZERO };
const RANGE = { tickLower: -201060, tickUpper: -197040 };
const TICK = -199020;
const SQRT = sqrtPriceAtTick(TICK);
const LIQUIDITY = 10n ** 15n;
const PRINCIPAL = runtime.amountsForLiquidity(SQRT, runtime.sqrtAtTick(RANGE.tickLower), runtime.sqrtAtTick(RANGE.tickUpper), LIQUIDITY, false);

test('a mounted position SVG tracks fine and coarse pointers at 900px without navigation', async () => {
  const browser = await launchBrowser();
  let session;
  try {
    const chain = createV2Chain({ chainId: 8453, timestamp: Math.floor(Date.now() / 1000), positions: [{ dex: 4, tokenId: 5100001n, pool: POOL, ...RANGE, liquidity: LIQUIDITY, principal: PRINCIPAL, fees: [0n, 0n] }], pools: [{ pool: POOL, sqrtPriceX96: SQRT, tick: TICK, liquidity: 10n ** 16n }] });
    const read6 = { portfolio: portfolioOf({ wallet: OWNER, tokens: [indexedToken(8453, ZERO, 'ETH', 18), indexedToken(8453, USDC, 'USDC', 6)], positions: [livePosition({ chainId: 8453, manager: MANAGER, tokenId: 5100001, owner: OWNER, pool: POOL, ...RANGE, liquidity: LIQUIDITY, sqrtPriceX96: SQRT, tick: TICK, principal: PRINCIPAL })] }) };
    session = await openPositionPage(browser, chain, { hash: '#/positions/base-v4-5100001', read6, viewport: { width: 900, height: 960 } });
    const { page, context } = session;
    await page.locator('[data-position-detail] .dm-chart-layer').first().waitFor();
    const snapshot = () => page.evaluate(() => {
      const svg = document.querySelector('[data-position-detail] .dm-chart-layer');
      return { root: getComputedStyle(document.documentElement).fontSize, fine: matchMedia('(pointer: fine)').matches, coarse: matchMedia('(pointer: coarse)').matches, scale: Number(svg.getAttribute('height')) / svg.viewBox.baseVal.height, width: innerWidth };
    });
    const check = async (expected, fine) => {
      await page.waitForFunction(({ expected, fine }) => {
        const svg = document.querySelector('[data-position-detail] .dm-chart-layer');
        return matchMedia('(pointer: fine)').matches === fine && Math.abs(Number(svg?.getAttribute('height')) / svg?.viewBox.baseVal.height - expected) < 0.001;
      }, { expected, fine });
      const state = await snapshot();
      assert.equal(state.root, fine ? '10.8px' : '16px');
      assert.equal(state.width, 900);
      assert.equal(state.scale, expected);
    };
    await check(0.675, true);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await check(1, false);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await check(0.675, true);
    assert.equal(session.planned.length, 0, 'this display-only check never asks for a financial plan');
  } finally {
    await session?.close();
    await closeBrowser(browser);
  }
});
