/**
 * The Wallet card's tokens on Base and Arbitrum One (R-07, 2026-11-06; the owner's replica rule): which tokens it asks
 * read-v6's chain-balances about (src/v2in/walletNetworks/model.ts), the rows and the sum it takes from a whole answer only, and how
 * Robinhood Chain's card merges them into its one list and its one figure (src/lib/walletNetworks.ts) without changing
 * anything of its own when there is nothing on the other networks.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as runtime from '../../../api-contracts/read-v6/runtime.mjs';
import { ZERO, walletBalancesAnswer } from '../support/wallet-networks.mjs';

const require = createRequire(import.meta.url);
const model = require('../../.test-build/app/src/v2in/walletNetworks/model.js');
const card = require('../../.test-build/app/src/lib/walletNetworks.js');

const WALLET = '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1';
const BASE_WETH = '0x4200000000000000000000000000000000000006';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ARB_WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const ARB_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const AERO = '0x940181a94a35a4569e4529a3cdfb74e38fd98631';
const CENT = 10n ** 16n;
const DOLLAR = 10n ** 18n;
const src = (path) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');

const indexed = (chainId, address, symbol, decimals) => ({ chainId, address, status: 'available', decimals, symbol, price: null, priceReason: 'no_pool' });
const ask = (asked) => ({ wallet: WALLET, tokens: model.balanceRequest(asked) });

test('it asks each network’s own currencies, then its positions’ tokens there, each once, never a look-alike, at most 24', () => {
  const bare = model.walletBalanceTokens(null);
  assert.deepEqual([...model.WALLET_NETWORK_CHAINS], [8453, 42161], 'every V2 network but Robinhood Chain');
  assert.deepEqual(bare.map(({ chainId, address, symbol, decimals }) => [chainId, address, symbol, decimals]), [
    [8453, ZERO, 'ETH', 18], [8453, BASE_WETH, 'WETH', 18], [8453, BASE_USDC, 'USDC', 6],
    [42161, ZERO, 'ETH', 18], [42161, ARB_WETH, 'WETH', 18], [42161, ARB_USDC, 'USDC', 6],
  ]);
  assert.ok(runtime.validateRequest('chain-balances', ask(bare)), 'the request is one the contract takes');
  const portfolio = { tokens: [
    indexed(4663, '0x5fc5360d0400a0fd4f2af552add042d716f1d168', 'USDG', 6), // Robinhood Chain's: its own card reads it
    indexed(8453, BASE_USDC, 'USDC', 6), // already asked
    indexed(8453, AERO.toUpperCase().replace('0X', '0x'), 'AERO', 18),
    indexed(8453, '0x1111111111111111111111111111111111111111', 'USDC', 6), // passes for Base's USDC
    indexed(42161, '0x2222222222222222222222222222222222222222', 'WETH', 18), // passes for Arbitrum One's WETH
    indexed(42161, '0x3333333333333333333333333333333333333333', null, null),
  ] };
  const asked = model.walletBalanceTokens(portfolio);
  assert.deepEqual(asked.slice(6).map(({ chainId, address, symbol, decimals }) => [chainId, address, symbol, decimals]), [
    [8453, AERO, 'AERO', 18], [42161, '0x3333333333333333333333333333333333333333', null, null],
  ]);
  const many = { tokens: Array.from({ length: 40 }, (_, n) => indexed(8453, `0x${(n + 1).toString(16).padStart(40, 'a')}`, `T${n}`, 18)) };
  const capped = model.walletBalanceTokens(many);
  assert.equal(capped.length, 24, 'chain-balances takes 24 a request');
  assert.ok(runtime.validateRequest('chain-balances', ask(capped)));
});

test('a whole answer gives the held tokens by value, the unpriced last, their sum; zero balances are not holdings', () => {
  const asked = model.walletBalanceTokens({ tokens: [indexed(8453, AERO, 'AERO', 18), indexed(42161, '0x4444444444444444444444444444444444444444', 'ODD', 18)] });
  const answer = walletBalancesAnswer(ask(asked), {
    held: { [`8453:${ZERO}`]: 500000000000000000n, [`8453:${BASE_USDC}`]: 25_500000n, [`8453:${AERO}`]: 3n * 10n ** 18n, [`42161:${ARB_WETH}`]: 10n ** 17n, '42161:0x4444444444444444444444444444444444444444': 7n * 10n ** 18n },
    pools: { [`8453:${AERO}`]: '1.250000000000000000' },
    meta: { [`8453:${AERO}`]: { symbol: 'AERO', decimals: 18 }, '42161:0x4444444444444444444444444444444444444444': { symbol: 'ODD', decimals: 18 } },
  });
  const read = model.networkHoldingsOf(answer, asked);
  assert.equal(read.whole, true);
  assert.deepEqual(read.holdings.map((h) => [h.network, h.token.symbol, h.token.decimals, h.raw]), [
    ['Base', 'ETH', 18, '500000000000000000'], ['Arbitrum One', 'WETH', 18, '100000000000000000'], ['Base', 'USDC', 6, '25500000'], ['Base', 'AERO', 18, '3000000000000000000'], ['Arbitrum One', 'ODD', 18, '7000000000000000000'],
  ]);
  // The fixture's ETH round is 4000.12345678: 0.5 ETH is 2000.061728 (micro-dollars, rounded down), 0.1 WETH 400.012345.
  assert.equal(read.holdings[0].value, 2000_061728n * 10n ** 12n);
  assert.equal(read.holdings[3].value, 3_750000n * 10n ** 12n);
  assert.equal(read.holdings[4].value, null, 'no pool: no price, never a zero');
  assert.equal(read.unpriced, 1);
  assert.equal(read.total, (2000_061728n + 400_012345n + 25_500000n + 3_750000n) * 10n ** 12n);
  assert.equal(read.holdings[0].key, `8453:${ZERO}`);
  assert.equal(read.holdings[0].token.chainId, 8453);
  assert.equal(read.holdings[0].priceTitle, 'At $4,000.12 per token, from Chainlink’s ETH/USD price. Indicative, not a quote.');
  assert.equal(read.holdings[2].priceTitle, 'USDC counted at $1.');
  assert.equal(read.holdings[3].priceTitle, 'At $1.25 per token, from its Uniswap pool on Base. Indicative, not a quote.');
  assert.equal(read.holdings[4].priceTitle, null);
});

test('a network that could not be read, or a balance that could not, makes the answer not whole: the card keeps what it had', () => {
  const asked = model.walletBalanceTokens(null);
  const down = model.networkHoldingsOf(walletBalancesAnswer(ask(asked), { held: { [`8453:${ZERO}`]: 10n ** 18n }, down: [42161] }), asked);
  assert.equal(down.whole, false);
  assert.deepEqual(down.holdings.map((h) => h.key), [`8453:${ZERO}`], 'what was read is still read, but never summed alone');
  const unread = model.networkHoldingsOf(walletBalancesAnswer(ask(asked), { unread: [`42161:${ARB_USDC}`] }), asked);
  assert.equal(unread.whole, false);
  const empty = model.networkHoldingsOf(walletBalancesAnswer(ask(asked)), asked);
  assert.deepEqual([empty.whole, empty.holdings.length, empty.total, empty.unpriced], [true, 0, 0n, 0], 'nothing held there: nothing to add');
});

test('an answer older than an action this page saw confirmed there is not taken', () => {
  const asked = model.walletBalanceTokens(null);
  const answer = walletBalancesAnswer(ask(asked), { block: 1000 });
  assert.equal(model.behindBarrier(answer, new Map()), false);
  assert.equal(model.behindBarrier(answer, new Map([[8453, 1000]])), false);
  assert.equal(model.behindBarrier(answer, new Map([[42161, 1001]])), true);
});

test('dollars as read-v6 writes them, in 10^-18', () => {
  assert.equal(model.usdUnits('1357.143250'), 1357_143250n * 10n ** 12n);
  assert.equal(model.usdUnits('0.000000'), 0n);
  assert.equal(model.usdUnits(null), null);
  assert.equal(model.usdUnits('nope'), null);
});

const rh = (rank, name) => ({ rank, name });
const net = (value, key) => ({ key, chainId: 8453, network: 'Base', value });

test('one list: Robinhood Chain’s order kept, the other networks’ merged in by value, the unpriced of each last', () => {
  const own = [rh(5n * DOLLAR, 'A'), rh(2n * DOLLAR, 'B'), rh(null, 'C')];
  assert.deepEqual(card.mergeCardRows(own, []).map((row) => [row.kind, row.holding.name]), [['robinhood', 'A'], ['robinhood', 'B'], ['robinhood', 'C']], 'nothing elsewhere: Robinhood Chain’s list as it was');
  const merged = card.mergeCardRows(own, [net(3n * DOLLAR, 'x'), net(2n * DOLLAR, 'y'), net(null, 'z')]);
  assert.deepEqual(merged.map((row) => (row.kind === 'robinhood' ? row.holding.name : row.holding.key)), ['A', 'x', 'B', 'y', 'C', 'z'], 'an equal value: Robinhood Chain’s first');
});

test('one figure: Robinhood Chain’s unchanged with nothing elsewhere, plus the other networks’ from a whole read only', () => {
  const shown = { total: 100n * DOLLAR, holdPlace: false, withheld: null, unpriced: 2 };
  const off = card.NETWORKS_OFF;
  assert.deepEqual(card.cardTotal(shown, off), { total: 100n * DOLLAR, holdPlace: false, unpriced: 2 });
  assert.deepEqual(card.cardTotal(shown, { state: 'ready', holdings: [], total: 0n, unpriced: 0 }), { total: 100n * DOLLAR, holdPlace: false, unpriced: 2 }, 'nothing held there');
  const failed = { total: null, holdPlace: false, withheld: 'read_failed', unpriced: 0 };
  assert.deepEqual(card.cardTotal(failed, off), { total: null, holdPlace: false, unpriced: 0 });
  const ready = { state: 'ready', holdings: [net(40n * DOLLAR, 'x'), net(null, 'y')], total: 40n * DOLLAR, unpriced: 1 };
  assert.deepEqual(card.cardTotal(shown, ready), { total: 140n * DOLLAR, holdPlace: false, unpriced: 3 });
  assert.deepEqual(card.cardTotal(failed, ready), { total: null, holdPlace: false, unpriced: 1 }, 'no sum across networks without all of them');
  assert.deepEqual(card.cardTotal({ total: null, holdPlace: true, withheld: 'reading', unpriced: 0 }, ready), { total: null, holdPlace: true, unpriced: 1 });
  const nothing = { total: null, holdPlace: false, withheld: 'nothing_valued', unpriced: 0 };
  assert.deepEqual(card.cardTotal(nothing, ready), { total: 40n * DOLLAR, holdPlace: false, unpriced: 1 }, 'nothing priced on Robinhood Chain: the other networks’ figure');
  assert.deepEqual(card.cardTotal(nothing, { ...ready, total: CENT - 1n }), { total: null, holdPlace: false, unpriced: 1 }, 'never a $0.00 headline');
  // Their first read on its way: the figure's place is held, where Robinhood Chain would show or hold one.
  assert.deepEqual(card.cardTotal(shown, { state: 'reading' }), { total: null, holdPlace: true, unpriced: 2 });
  assert.deepEqual(card.cardTotal(nothing, { state: 'reading' }), { total: null, holdPlace: true, unpriced: 0 });
  assert.deepEqual(card.cardTotal(failed, { state: 'reading' }), { total: null, holdPlace: false, unpriced: 0 });
  assert.equal(card.networksText(['Robinhood Chain']), 'Robinhood Chain');
  assert.equal(card.networksText(['Robinhood Chain', 'Base', 'Base']), 'Robinhood Chain and Base');
  assert.equal(card.networksText(['Robinhood Chain', 'Base', 'Arbitrum One']), 'Robinhood Chain, Base and Arbitrum One');
});

test('the card opens the networks only behind the V2 define, and they only read: no plan, no wallet, no send', () => {
  const tokens = src('components/portfolio/PortfolioTokens.tsx');
  assert.match(tokens, /const WalletNetworksWatch = __DOMINO_V2__ \? lazy\(recovering\(\(\) => import\('\.\.\/\.\.\/v2in\/lists\/OwnedRows'\)\.then\(\(module\) => \(\{ default: module\.WalletNetworksWatch \}\)\)/);
  // Part of the lists' chunk, which already carries the portfolio reader and the chain reads: no chunk of its own.
  assert.match(src('v2in/lists/OwnedRows.tsx'), /^export \{ WalletNetworksWatch \} from '\.\.\/walletNetworks\/WalletNetworks'$/m);
  const live = src('v2in/walletNetworks/WalletNetworks.tsx');
  assert.match(live, /readChainBalances\(transports\.read, transports\.readRuntime, wallet, balanceRequest\(asked\)\)/);
  assert.match(live, /routeServes\(await transports\.routeState\('readV6'\), 'chain-balances'\)/, 'asked only while the route serves it');
  for (const file of [live, src('v2in/walletNetworks/model.ts'), src('lib/walletNetworks.ts')]) {
    assert.doesNotMatch(file, /finance\/|wallet\/port|session\/|requestS1Plan|\bplan\b\.|sendTransaction|writeContract|fetch\(/);
  }
  // Robinhood Chain's own reads and prices are untouched: the card still asks the same list and the same prices.
  assert.match(tokens, /createWalletSession\(guarded, \{ wallet: address, tokens, fallbackTokens: SELECTED_TOKENS/);
  assert.match(tokens, /void walletPrices\.price\(asked, \{/);
});
