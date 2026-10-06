/**
 * The bring-funds offer on the balances Domino's service reads (2026-10-06, rugged97's delta of 5 Oct, item 3: read-v6's
 * chain-balances), what is pure of it (src/v2in/funds/model.ts): what is asked (the other networks' ETH, WETH and stable,
 * never the destination's), and an answer read as the wallet's own read gives it (the network's own symbols and decimals,
 * only what is above zero, an unread balance never a zero, a network not read none at all); and New position's USD for a
 * pool on another network at its qualified prices (src/components/create/valuation.ts usdOf, read-v6 1.1.0-rc.1).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src/';
const model = require(`${BUILD}v2in/funds/model.js`);
const { CANDIDATE_ORIGINS } = require(`${BUILD}finance/v2/holdings.js`);
const valuation = require(`${BUILD}components/create/valuation.js`);
const { REVIEW_GAS_RESERVE_WEI } = require(`${BUILD}lib/create/reviewPlan.js`);

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../../api-contracts/read-v6/fixtures/valid/${name}.json`, import.meta.url), 'utf8'));
const ZERO = '0x0000000000000000000000000000000000000000';
const candidate = (chainId) => CANDIDATE_ORIGINS.find((c) => c.chainId === chainId);

// Changed on purpose 2026-10-06 (the owner's point 1): with the destination's own ETH, for "Get gas on {destination}" (§3.9);
// only the networks read-v6 reads (a request naming any other is refused whole: src/v2/read/v6.ts).
// Changed on purpose 2026-10-06 (the owner: AI/PONS short on Robinhood Chain and nothing offered): the destination's WETH
// and stable too, for "Pay with … instead" (what the wallet holds there, and each kind's worth).
test('what is asked: every other network\'s ETH, WETH and stable, then the destination\'s own; only the networks the service reads', async () => {
  const asked = model.balancesRequest(4663);
  assert.deepEqual(asked.map((t) => t.chainId), [8453, 8453, 8453, 42161, 42161, 42161, 4663, 4663, 4663]);
  assert.deepEqual(asked.slice(0, 3).map((t) => t.address), [ZERO, '0x4200000000000000000000000000000000000006', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913']);
  assert.deepEqual(asked.slice(-3), [{ chainId: 4663, address: ZERO }, { chainId: 4663, address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73' }, { chainId: 4663, address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' }]);
  assert.deepEqual(model.balancesRequest(8453).map((t) => t.chainId), [4663, 4663, 4663, 42161, 42161, 42161, 8453, 8453, 8453]);
  assert.deepEqual(model.balancesRequest(1).map((t) => t.chainId), [4663, 4663, 4663, 8453, 8453, 8453, 42161, 42161, 42161], 'never another network');
  const runtime = await import(new URL('../../../api-contracts/read-v6/runtime.mjs', import.meta.url).href);
  for (const destination of [4663, 8453, 42161]) {
    assert.ok(runtime.validateRequest('chain-balances', { wallet: `0x${'ab'.repeat(20)}`, tokens: model.balancesRequest(destination) }), `the contract takes the request for ${destination}`);
  }
  assert.equal(runtime.validateRequest('chain-balances', { wallet: `0x${'ab'.repeat(20)}`, tokens: [{ chainId: 137, address: ZERO }] }), false, 'a network the service does not read is refused whole');
  // Changed on purpose (data) 2026-10-06: read-v6 1.1.0-rc.1's chain-balances also reads Ethereum and OP Mainnet when
  // asked (the owner's decision; reader, then Worker, then app). The contract takes them.
  assert.ok(runtime.validateRequest('chain-balances', { wallet: `0x${'ab'.repeat(20)}`, tokens: [{ chainId: 1, address: ZERO }, { chainId: 10, address: ZERO }] }), 'Ethereum and OP Mainnet, when asked');
  // Changed on purpose 2026-10-06 (rugged97's #379): the app asks them, but in a request of their own (model.ts
  // balanceChainsRequest; tests/v2/funds-balance-chains.test.mjs), never in this one, so a Worker that still refuses them
  // cannot take Domino's three with them: this request stays Domino's three.
  assert.deepEqual([...model.SERVED_BALANCE_CHAINS], [4663, 8453, 42161]);
  assert.ok(model.balanceChainsRequest(4663).every((t) => [1, 10].includes(t.chainId)));
});

test('an answer as the wallet\'s own read: the network\'s own symbols, what is above zero, unread never zero, a network not read none', () => {
  const answer = fixture('chain-balances');
  // Base read: USDC 2.5 and ETH 0.1; its WETH unavailable.
  const base = model.holdingsFromChainBalances(answer, candidate(8453));
  assert.deepEqual(base.holdings.map((h) => [h.token, h.symbol, h.decimals, h.raw]), [[ZERO, 'ETH', 18, 100000000000000000n], ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'USDC', 6, 2500000n]]);
  assert.deepEqual(base.unread, ['WETH']);
  assert.equal(model.holdingsFromChainBalances(answer, candidate(42161)), null, 'Arbitrum One not read: the wallet\'s own read is the way');
  // The answer's own symbol is never shown: a token named otherwise there is still the network's own currency.
  const renamed = structuredClone(answer);
  renamed.chains[1].balances[0].symbol = 'FREE MONEY';
  assert.equal(model.holdingsFromChainBalances(renamed, candidate(8453)).holdings[1].symbol, 'USDC');
  assert.equal(model.totalUsdOn(answer, 8453), null, 'not every balance valued there: no total');
  assert.equal(model.totalUsdOn(fixture('chain-balances-asked'), 8453), '7400.228394');
  assert.equal(model.totalUsdOn(answer, 42161), null);
});

test('New position\'s USD for a pool on another network: its currencies at their qualified prices; one unpriced at the pool\'s own price; none priced is none, never zero', () => {
  const token = (address, symbol, decimals) => ({ origin: 'read', chainId: 8453, address, symbol, decimals, readStatus: 'available', artwork: null });
  const pool = {
    currencies: [token(ZERO, 'ETH', 18), token('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'USDC', 6)],
    sqrtPriceX96: '3926780305788164395585478',
    usdPrices: ['4000.123456780000000000', '1.000000000000000000'],
  };
  // 0.5 ETH and 1,000 USDC: 2,000.06172839 + 1,000.
  assert.equal(valuation.usdOf(pool, [500000000000000000n, 1000000000n]), '3000.061728390000000000');
  assert.equal(valuation.usdOfSide(pool, 1, '2500000'), '2.500000000000000000');
  // Changed on purpose 2026-10-06 (the owner: "USD estimate unavailable" whenever one token of the pair had no qualified
  // price, src/components/create/valuation.ts): a side without a price is valued at this pool's own price in the priced
  // one, then at its price, the rule a USDG pair is valued by. 2.5 USDC here: in ETH at the pool's price, then at ETH's.
  const square = BigInt(pool.sqrtPriceX96) ** 2n;
  const wei = (2_500_000n * (1n << 192n)) / square;
  const usd = (wei * 4_000_123_456_780_000_000_000n) / 10n ** 18n;
  assert.equal(valuation.usdOf({ ...pool, usdPrices: ['4000.123456780000000000', null] }, [0n, 2_500_000n]), `${usd / 10n ** 18n}.${String(usd % 10n ** 18n).padStart(18, '0')}`);
  assert.equal(valuation.usdOf({ ...pool, usdPrices: [null, null] }, [1n, 1n]), null, 'no side priced: no figure at all');
  assert.equal(valuation.usdOf({ ...pool, usdPrices: ['4000.123456780000000000', null] }, [10n ** 18n, 0n]), '4000.123456780000000000', 'a side holding nothing needs no price');
  const { usdPrices, ...plain } = pool;
  assert.equal(usdPrices.length, 2);
  assert.equal(valuation.usdOf(plain, [1n, 1n]), null, 'a pool read through the wallet carries no prices: no USD');
});

// Added 2026-10-06 (the owner's points 1, 3 and 7): what each of Domino's other networks holds to bring, and the one holding
// the discreet line names before an amount is typed.
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const USDC_ARB = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const WETH_ARB = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const WETH_RH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
/** An answer's shape as the model reads it: per chain, each token read (raw, USD) or not (null). */
function answerOf(chains) {
  return {
    chains: Object.entries(chains).map(([id, balances]) => {
      if (balances === null) return { chainId: Number(id), status: 'unavailable', reason: 'chain_read_failed', snapshot: null, totalUsd: null, balances: [] };
      return {
        chainId: Number(id),
        status: 'current',
        reason: null,
        snapshot: null,
        totalUsd: null,
        balances: Object.entries(balances).map(([address, value]) =>
          value === null ? { address, balanceRaw: null, status: 'unavailable', valueUsd: null } : { address, balanceRaw: String(value[0]), status: 'read', valueUsd: value[1] ?? null },
        ),
      };
    }),
  };
}
const ETH_1 = 10n ** 18n;

test('a network\'s ETH and a balance\'s USD as read; USD summed only when every one is valued', () => {
  const answer = answerOf({ 8453: { [ZERO]: [0n, null], [USDC_BASE]: [5_000_000n, '5.000000'] }, 42161: null });
  assert.equal(model.nativeOn(answer, 8453), 0n, 'read as zero');
  assert.equal(model.nativeOn(answer, 42161), null, 'not read');
  assert.equal(model.nativeOn(answer, 4663), null, 'not asked');
  assert.equal(model.valueUsdOf(answer, 8453, USDC_BASE.toUpperCase().replace('0X', '0x')), '5.000000');
  assert.equal(model.valueUsdOf(answer, 8453, ZERO), null);
  assert.equal(model.sumUsd(['5.000000', '400.012345']), '405.012345');
  assert.equal(model.sumUsd(['2.5', '0.5']), '3');
  assert.equal(model.sumUsd(['1', null]), null, 'one unvalued: no total');
  assert.equal(model.sumUsd([]), '0');
});

test('what can be brought: ETH above the gas Review keeps; a token only where the network\'s ETH was not read as zero', () => {
  const h = (token, raw, symbol = 'X', decimals = 18) => ({ chainId: 8453, chainName: 'Base', token, symbol, decimals, raw });
  const usdc = h(USDC_BASE, 5_000_000n, 'USDC', 6);
  assert.deepEqual(model.usableHoldings([usdc], 0n), { usable: [], gasless: [usdc] }, 'no ETH there: the approval and the deposit could not go');
  assert.deepEqual(model.usableHoldings([usdc], 1n), { usable: [usdc], gasless: [] }, 'any ETH there pays');
  assert.deepEqual(model.usableHoldings([usdc], null), { usable: [usdc], gasless: [] }, 'unread ETH is never a zero');
  const dust = h(ZERO, REVIEW_GAS_RESERVE_WEI, 'ETH');
  assert.deepEqual(model.usableHoldings([dust], dust.raw), { usable: [], gasless: [] }, 'ETH only the gas allowance: nothing to send');
});

test('each network as the short box shows it: what it holds (about how much), only tokens with no ETH, empty (gone), or unread (kept)', () => {
  const answer = answerOf({
    8453: { [ZERO]: [0n, null], [WETH_BASE]: [0n, null], [USDC_BASE]: [5_000_000n, '5.000000'] },
    42161: { [ZERO]: [ETH_1, '4000.000000'], [WETH_ARB]: [0n, null], [USDC_ARB]: [100_000_000n, '100.000000'] },
    4663: { [ZERO]: [0n, null], [WETH_RH]: [0n, null], [USDG]: [0n, null] },
  });
  assert.deepEqual(model.networkHolds(answer, candidate(8453)).state, 'no_gas');
  const arb = model.networkHolds(answer, candidate(42161));
  assert.equal(arb.state, 'holds');
  assert.deepEqual(arb.holdings.map((x) => [x.symbol, x.raw]), [['ETH', ETH_1], ['USDC', 100_000_000n]]);
  // Changed on purpose 2026-10-06 (the integration review): the USD of what can be sent, ETH less the gas Review keeps
  // (0.9995 ETH at US$4,000, and 100 USDC), and the box names those amounts.
  assert.equal(arb.usd, '4098');
  assert.deepEqual(arb.holdings.map(model.holdingText), ['1 ETH', '100 USDC']);
  assert.deepEqual(arb.holdings.map((h) => model.holdingText({ ...h, raw: model.sendable(h) })), ['0.9995 ETH', '100 USDC']);
  assert.deepEqual(model.networkHolds(answer, candidate(4663)), { state: 'empty' });
  assert.deepEqual(model.networkHolds(answerOf({ 42161: null }), candidate(42161)), { state: 'unread' }, 'not read: the button stays');
  assert.deepEqual(model.networkHolds(answerOf({ 42161: { [ZERO]: [0n, null], [WETH_ARB]: null, [USDC_ARB]: [0n, null] } }), candidate(42161)), { state: 'unread' }, 'read in part with nothing found: never empty');
  assert.deepEqual(model.networkHolds(null, candidate(42161)), { state: 'unread' });
  // A balance whose USD is not known: the amounts, no total.
  assert.equal(model.networkHolds(answerOf({ 42161: { [ZERO]: [ETH_1, null], [WETH_ARB]: [0n, null], [USDC_ARB]: [0n, null] } }), candidate(42161)).usd, null);
});

test('the discreet line: one holding, same kind as a pool token first, then the most valuable; nothing when every network read is empty', () => {
  const pool = [ZERO, USDG]; // ETH / USDG on Robinhood Chain: both deliverable
  const answer = answerOf({
    8453: { [ZERO]: [ETH_1 / 10n, '400.000000'], [WETH_BASE]: [0n, null], [USDC_BASE]: [5_000_000n, '5.000000'] },
    42161: { [ZERO]: [ETH_1 / 1000n, '4.000000'], [WETH_ARB]: [0n, null], [USDC_ARB]: [100_000_000n, '100.000000'] },
    4663: { [ZERO]: [0n, null] },
  });
  const best = model.bestHolding(answer, 4663, pool);
  // Changed on purpose 2026-10-06 (the integration review): valued as what can be sent (0.0995 ETH at US$4,000).
  assert.deepEqual([best.chainId, best.network, best.holding.symbol, best.holding.raw, best.valueUsd, best.target], [8453, 'Base', 'ETH', ETH_1 / 10n, '398', ZERO], 'the most valuable, brought as ETH');
  // VIRTUAL / WETH on Base: only WETH is deliverable, so a dollar holding is brought as WETH, after any ether.
  const virtual = ['0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b', WETH_BASE];
  const usdcOnly = answerOf({ 42161: { [ZERO]: [1n, null], [WETH_ARB]: [0n, null], [USDC_ARB]: [100_000_000n, '100.000000'] }, 8453: { [ZERO]: [0n, null] } });
  const line = model.bestHolding(usdcOnly, 8453, model.deliverableTokens(8453, virtual));
  assert.deepEqual([line.chainId, line.holding.symbol, line.target], [42161, 'USDC', WETH_BASE]);
  // Too little to bring (under US$1), only the gas allowance, or no ETH for a token: nothing.
  assert.equal(model.bestHolding(answerOf({ 42161: { [ZERO]: [0n, null], [WETH_ARB]: [0n, null], [USDC_ARB]: [500_000n, '0.500000'] } }), 4663, pool), null);
  assert.equal(model.bestHolding(answerOf({ 42161: { [ZERO]: [REVIEW_GAS_RESERVE_WEI, '2.000000'] } }), 4663, pool), null);
  assert.equal(model.bestHolding(answerOf({ 42161: { [ZERO]: [0n, null], [USDC_ARB]: [100_000_000n, '100.000000'] } }), 4663, pool), null);
  // Never the destination's own holdings; nothing when the pool has no token a deposit delivers; unread is not a holding.
  assert.equal(model.bestHolding(answerOf({ 4663: { [ZERO]: [ETH_1, '4000.000000'] } }), 4663, pool), null);
  assert.equal(model.bestHolding(answer, 4663, []), null);
  assert.equal(model.bestHolding(answerOf({ 8453: null, 42161: null }), 4663, pool), null);
  // An unvalued holding still counts (its price may be stale), after valued ones.
  const unvalued = model.bestHolding(answerOf({ 42161: { [ZERO]: [ETH_1, null], [USDC_ARB]: [100_000_000n, '100.000000'] } }), 4663, [ZERO]);
  assert.deepEqual([unvalued.holding.symbol, unvalued.target], ['ETH', ZERO], 'ETH to ETH first: the same kind');
});

// Added 2026-10-06 (the integration review, money #2): "You have 0.0006 ETH on Base (about $1.62)" quoted 0.0001 ETH. The
// line's floor and its USD are of what the click brings, native ETH less the gas Review keeps.
test('the discreet line weighs what can be sent: ETH just above the gas Review keeps is too little; the networks a held step closes are left out', () => {
  const pool = [ZERO, USDG];
  // 0.0006 ETH at US$2,700 (US$1.62): 0.0001 ETH can be sent, US$0.27.
  assert.equal(model.bestHolding(answerOf({ 8453: { [ZERO]: [600_000_000_000_000n, '1.620000'] } }), 4663, pool), null);
  assert.equal(model.bestHolding(answerOf({ 8453: { [ZERO]: [REVIEW_GAS_RESERVE_WEI + 10_000_000_000n, '1.350027'] } }), 4663, pool), null, '0.00050001 ETH: dust');
  // Unvalued there, but ETH is priced on another network read: weighed at that price, still dust.
  const priced = answerOf({ 8453: { [ZERO]: [600_000_000_000_000n, null] }, 42161: { [WETH_ARB]: [0n, '0.000000'] } });
  priced.chains.find((c) => c.chainId === 42161).balances[0].price = { usd: '2700.000000000000000000' };
  assert.equal(model.bestHolding(priced, 4663, pool), null, 'weighed at the price read elsewhere');
  // Changed on purpose 2026-10-06 (the integration review's second pass): with no price read anywhere, a kind's own floor:
  // ether under the gas Review keeps, and under a dollar of a stable, is too little too (never shown).
  assert.equal(model.bestHolding(answerOf({ 8453: { [ZERO]: [600_000_000_000_000n, null] } }), 4663, pool), null, 'unpriced 0.0006 ETH: 0.0001 can be sent');
  assert.equal(model.bestHolding(answerOf({ 8453: { [ZERO]: [REVIEW_GAS_RESERVE_WEI + 10_000_000_000n, null] } }), 4663, pool), null, 'unpriced 0.00050001 ETH');
  assert.equal(model.bestHolding(answerOf({ 42161: { [WETH_ARB]: [10n ** 12n, null] } }), 4663, pool), null, 'unpriced WETH dust');
  assert.equal(model.bestHolding(answerOf({ 42161: { [USDC_ARB]: [999_999n, null] } }), 4663, pool), null, 'unpriced, less than a dollar');
  const unpriced = model.bestHolding(answerOf({ 8453: { [ZERO]: [2n * REVIEW_GAS_RESERVE_WEI, null] } }), 4663, pool);
  assert.deepEqual([unpriced.chainId, model.holdingText({ ...unpriced.holding, raw: model.sendable(unpriced.holding) }), unpriced.valueUsd], [8453, '0.0005 ETH', null], 'as much as the gas Review keeps: named, with no USD');
  assert.equal(model.bestHolding(answerOf({ 42161: { [USDC_ARB]: [1_000_000n, null] } }), 4663, pool).holding.symbol, 'USDC', 'a dollar');
  // Enough: named as what can be sent, at that part's USD.
  const line = model.bestHolding(answerOf({ 8453: { [ZERO]: [10_500_000_000_000_000n, '28.350000'] } }), 4663, pool);
  assert.equal(line.valueUsd, '27', '0.01 ETH of the 0.0105 held, at US$2,700');
  assert.equal(model.holdingText({ ...line.holding, raw: model.sendable(line.holding) }), '0.01 ETH');
  // A network a held step keeps closed is never named; another one is.
  const both = answerOf({ 8453: { [USDC_BASE]: [500_000_000n, '500.000000'] }, 42161: { [USDC_ARB]: [100_000_000n, '100.000000'] } });
  assert.equal(model.bestHolding(both, 4663, pool).chainId, 8453);
  assert.equal(model.bestHolding(both, 4663, pool, new Set([8453])).chainId, 42161);
  assert.equal(model.bestHolding(both, 4663, pool, new Set([8453, 42161])), null);
});
