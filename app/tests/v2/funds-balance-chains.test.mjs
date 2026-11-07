/**
 * Added 2026-10-06 (rugged97's #379, a0ff4e8a: read-v6 1.1.0-rc.1's chain-balances also reads Ethereum (1) and OP Mainnet
 * (10) when a request names them in `tokens`; additive; rollout: reader, then Worker, then app): the bring-funds offer
 * asks them too, and what is pure of it (src/v2/balanceChains.ts, src/v2in/funds/model.ts):
 *   - the two networks from their balance-chain profiles, read at build time: ETH, WETH and USDC, as the contract prices
 *     them and as the wallet's own read reads them;
 *   - the request split: Domino's three exactly as before, and Ethereum and OP Mainnet in a request of their own, only where
 *     crosschain-v1 bridges from, never the destination;
 *   - the holdings merge: either read alone is itself, so a balance chains' read that failed (a Worker that still refuses
 *     them, an answer that cannot be had) leaves Domino's chains intact, and theirs unread, never empty;
 *   - what is held there joins the same logic as Domino's networks: kinds, marks, the discreet line, the networks' buttons,
 *     the choice of what to bring and the token to pay with.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src/';
const model = require(`${BUILD}v2in/funds/model.js`);
const { BALANCE_CHAINS, balanceChain } = require(`${BUILD}v2/balanceChains.js`);
const { CANDIDATE_ORIGINS } = require(`${BUILD}finance/v2/holdings.js`);
const { NETWORK_NAMES } = require(`${BUILD}lib/networkName.js`);
const { REVIEW_GAS_RESERVE_WEI } = require(`${BUILD}lib/create/reviewPlan.js`);
const { FUNDS_ETHEREUM_GAS_RESERVE_WEI } = require(`${BUILD}v2in/funds/constants.js`);

const json = (path) => JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8'));
const fixture = (name) => json(`api-contracts/read-v6/fixtures/valid/${name}.json`);
const PROFILES = { 1: json('api-contracts/v2/balance-chains/ethereum-1.json'), 10: json('api-contracts/v2/balance-chains/optimism-10.json') };

const ZERO = '0x0000000000000000000000000000000000000000';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WALLET = `0x${'ab'.repeat(20)}`;
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH_1 = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USDC_1 = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH_10 = '0x4200000000000000000000000000000000000006';
const USDC_10 = '0x0b2c639c533813f4aa9d7837caf62653d097ff85';
/** OP Mainnet's bridged USDC.e: priced like any other token there, by its pools; never its dollar. */
const USDC_E_10 = '0x7f5c764cbc14f9669b88837ca1490cca17c31607';
const AI = '0x1111111111111111111111111111111111111111';
const PONS = '0x2222222222222222222222222222222222222222';
const E18 = 10n ** 18n;

/** An answer's shape as the model reads it: per chain, each token read (raw, USD) or not (null); a chain null is unavailable. */
function answerOf(chains) {
  return {
    wallet: WALLET,
    coverage: Object.values(chains).every((balances) => balances !== null) ? 'complete' : 'partial',
    totalUsd: null,
    chains: Object.entries(chains).map(([id, balances]) => {
      if (balances === null) return { chainId: Number(id), status: 'unavailable', reason: 'chain_not_configured', snapshot: null, totalUsd: null, balances: [] };
      return {
        chainId: Number(id),
        status: 'current',
        reason: null,
        snapshot: null,
        totalUsd: null,
        balances: Object.entries(balances).map(([address, value]) =>
          value === null ? { address, balanceRaw: null, status: 'unavailable', valueUsd: null, price: null } : { address, balanceRaw: String(value[0]), status: 'read', valueUsd: value[1] ?? null, price: value[2] ? { usd: value[2] } : null },
        ),
      };
    }),
  };
}

test('Ethereum and OP Mainnet from their balance-chain profiles: ETH, WETH and USDC, as the contract prices them and the wallet\'s own read reads them', async () => {
  assert.deepEqual(BALANCE_CHAINS.map((chain) => chain.chainId), [1, 10]);
  // Changed on purpose 2026-10-06 (the review: the Domino V2 family over its budget): the profiles' shape, which
  // src/v2/balanceChains.ts no longer checks at every load, held here against the very files it bundles: a balance chain's
  // kind, chain 1 or 10, ETH native at the zero address (its one native charge currency), WETH among its charge currencies,
  // exactly one stable at rank 1, every address well formed; and its name, the app's one table's (lib/networkName.ts).
  for (const [id, profile] of Object.entries(PROFILES)) {
    assert.deepEqual([profile.kind, profile.chainId, profile.nativeSymbol], ['domino-v2-balance-chain', Number(id), 'ETH'], `${id}: a balance chain, its ETH native`);
    assert.deepEqual([profile.wrappedNative.symbol, profile.wrappedNative.decimals], ['WETH', 18]);
    assert.match(profile.wrappedNative.address, ADDRESS);
    assert.deepEqual(profile.chargeCurrencies.filter((c) => c.native === true).map((c) => [c.address, c.symbol, c.decimals]), [[ZERO, 'ETH', 18]], `${id}: ETH, at the zero address`);
    assert.ok(profile.chargeCurrencies.some((c) => c.native !== true && c.address.toLowerCase() === profile.wrappedNative.address.toLowerCase()), `${id}: WETH among its charge currencies`);
    const stables = profile.chargeCurrencies.filter((c) => c.rank === 1);
    assert.equal(stables.length, 1, `${id}: exactly one stable`);
    assert.notEqual(stables[0].native, true);
    assert.ok(Number.isSafeInteger(stables[0].decimals));
    for (const currency of profile.chargeCurrencies) assert.match(currency.address, ADDRESS);
    assert.equal(model.originName(profile.chainId), profile.name, `${id}: one name, the profile's own`);
  }
  const { CONSTANTS } = await import(new URL('../../../api-contracts/read-v6/schema-data.mjs', import.meta.url).href);
  assert.deepEqual(BALANCE_CHAINS.map((chain) => chain.chainId), CONSTANTS.balanceChainIds.filter((id) => !CONSTANTS.chainIds.includes(id)), 'the contract\'s balance chains, less Domino\'s');
  for (const chain of BALANCE_CHAINS) {
    const profile = PROFILES[chain.chainId];
    const stable = profile.chargeCurrencies.find((c) => c.rank === 1);
    assert.deepEqual(
      chain.tokens.map((t) => [t.address, t.symbol, t.decimals]),
      [[ZERO, 'ETH', 18], [profile.wrappedNative.address.toLowerCase(), 'WETH', 18], [stable.address.toLowerCase(), 'USDC', 6]],
      `${profile.name}: its ETH, WETH and stable, from its profile`,
    );
    // The stable and WETH the contract prices (US$1; Chainlink's ETH/USD) are these.
    assert.equal(chain.stable, CONSTANTS.priceProfiles[chain.chainId].stable);
    assert.equal(chain.wrapped, CONSTANTS.priceProfiles[chain.chainId].wrapped);
    // The wallet's own read there (finance/v2/holdings.ts CANDIDATE_ORIGINS, used when the service has no answer) reads the same.
    assert.deepEqual(CANDIDATE_ORIGINS.find((c) => c.chainId === chain.chainId).tokens.map((t) => ({ ...t })), chain.tokens.map((t) => ({ ...t })), `${profile.name}: one set of tokens`);
    assert.equal(balanceChain(chain.chainId), chain);
  }
  assert.equal([USDC_1, USDC_10].includes(USDC_E_10), false, 'Circle\'s native USDC on OP Mainnet, never the bridged one');
  for (const id of [4663, 8453, 42161, 137]) assert.equal(balanceChain(id), null, `${id} is no balance chain`);
  // One name for one network: the app's one table (lib/networkName.ts, through v2/crosschain/present.ts OWN_NETWORK_NAMES).
  for (const id of [1, 10, 4663, 8453, 42161]) assert.equal(model.originName(id), NETWORK_NAMES[id]);
  assert.deepEqual([1, 10, 4663, 8453, 42161].map(model.originName), ['Ethereum', 'OP Mainnet', 'Robinhood Chain', 'Base', 'Arbitrum One']);
  // The network the offer reads holdings on: Domino's from CANDIDATE_ORIGINS, Ethereum and OP Mainnet from their profiles.
  assert.equal(model.originCandidate(8453), CANDIDATE_ORIGINS.find((c) => c.chainId === 8453));
  assert.deepEqual(model.originCandidate(1), { chainId: 1, name: 'Ethereum', tokens: BALANCE_CHAINS[0].tokens });
  assert.deepEqual(model.originCandidate(10).name, 'OP Mainnet');
  assert.equal(model.originCandidate(137), null);
});

test('the request split: Domino\'s three as before; Ethereum and OP Mainnet in a request of their own, where crosschain-v1 bridges from, never the destination', async () => {
  const runtime = await import(new URL('../../../api-contracts/read-v6/runtime.mjs', import.meta.url).href);
  const { CONSTANTS } = await import(new URL('../../../api-contracts/crosschain-v1/schema-data.mjs', import.meta.url).href);
  // Only where crosschain-v1 bridges from: both are networks its origins listing names, Relay and Across pinned there.
  assert.deepEqual([...model.BALANCE_ORIGINS], [1, 10]);
  for (const id of model.BALANCE_ORIGINS) {
    assert.ok(model.BOTH_PINNED_ORIGINS.includes(id), `${id} among Other networks' origins`);
    assert.ok(CONSTANTS.chains[id]?.relay && CONSTANTS.chains[id]?.across, `${id}: both bridges pinned`);
  }
  const elsewhere = [
    { chainId: 1, address: ZERO }, { chainId: 1, address: WETH_1 }, { chainId: 1, address: USDC_1 },
    { chainId: 10, address: ZERO }, { chainId: 10, address: WETH_10 }, { chainId: 10, address: USDC_10 },
  ];
  for (const destination of [4663, 8453, 42161]) {
    const domino = model.balancesRequest(destination);
    const away = model.balanceChainsRequest(destination);
    // Domino's request is exactly what it was: nine tokens, on Domino's three alone.
    assert.equal(domino.length, 9);
    assert.ok(domino.every((t) => [4663, 8453, 42161].includes(t.chainId)), `${destination}: Domino's three only`);
    assert.deepEqual(away, elsewhere, `${destination}: their ETH, WETH and USDC, in that order`);
    assert.ok(!away.some((t) => domino.some((d) => d.chainId === t.chainId)), 'no network in both');
    // Each is a request the contract takes on its own; Domino's never names a balance chain.
    assert.ok(runtime.validateRequest('chain-balances', { wallet: WALLET, tokens: domino }));
    assert.ok(runtime.validateRequest('chain-balances', { wallet: WALLET, tokens: away }));
  }
  // An answer for them is about exactly what was asked, and only when they are named (never by default).
  const answer = structuredClone(fixture('chain-balances-asked-balance-chains'));
  assert.ok(runtime.validateExchange('chain-balances', { wallet: answer.wallet, tokens: [{ chainId: 1, address: USDC_1 }, { chainId: 1, address: ZERO }, { chainId: 10, address: USDC_10 }, { chainId: 10, address: ZERO }] }, answer));
  assert.equal(runtime.validateExchange('chain-balances', { wallet: answer.wallet, tokens: model.balancesRequest(4663) }, answer), false, 'never as an answer to Domino\'s request');
});

test('the holdings merge: either read alone is itself; Ethereum\'s and OP Mainnet\'s join Domino\'s; a read of theirs that failed leaves Domino\'s chains intact', () => {
  const domino = fixture('chain-balances');
  const elsewhere = fixture('chain-balances-asked-balance-chains');
  assert.equal(model.mergeBalances(domino, null), domino, 'their read failed or was refused: Domino\'s answer exactly as it was');
  assert.equal(model.mergeBalances(null, elsewhere), elsewhere);
  assert.equal(model.mergeBalances(null, null), null);
  const merged = model.mergeBalances(domino, elsewhere);
  // Changed on purpose 2026-11-07 (review finding C): Domino's networks as the package's default answer lists them (the
  // three today, in this order; rugged97's day-9 fixture names every chain his package names, Elysium too), then theirs.
  assert.deepEqual(domino.chains.slice(0, 3).map((c) => c.chainId), [4663, 8453, 42161]);
  assert.deepEqual(merged.chains.map((c) => c.chainId), [...domino.chains.map((c) => c.chainId), 1, 10], 'Domino\'s networks first, as read, then theirs');
  domino.chains.forEach((chain, index) => assert.equal(merged.chains[index], chain, `${chain.chainId} untouched`));
  assert.equal(merged.totalUsd, null, 'nothing summed across the two reads');
  assert.equal(merged.coverage, 'partial');
  assert.equal(merged.wallet, domino.wallet);
  assert.equal(model.mergeBalances({ ...domino, coverage: 'complete' }, elsewhere).coverage, 'complete');
  // Domino's chains as before.
  const base = model.originCandidate(8453);
  assert.deepEqual(model.holdingsFromChainBalances(merged, base), model.holdingsFromChainBalances(domino, base));
  assert.deepEqual(model.networkHolds(merged, model.originCandidate(42161)), { state: 'unread' }, 'Arbitrum One not read, as before');
  // Theirs, read: Ethereum's USDC and ETH (its WETH not in that answer: unread, never zero).
  const ethereum = model.holdingsFromChainBalances(merged, model.originCandidate(1));
  assert.deepEqual(ethereum.holdings.map((h) => [h.chainId, h.chainName, h.symbol, h.raw]), [[1, 'Ethereum', 'ETH', E18 / 2n], [1, 'Ethereum', 'USDC', 1_250_500_000n]]);
  assert.deepEqual(ethereum.unread, ['WETH']);
  assert.equal(model.networkHolds(merged, model.originCandidate(1)).state, 'holds');
  // Their read failed: unread, never empty; Domino's as read.
  for (const away of [null, fixture('chain-balances-asked-balance-chain-unconfigured')]) {
    const view = model.mergeBalances(domino, away);
    assert.deepEqual(model.networkHolds(view, model.originCandidate(10)), { state: 'unread' }, 'OP Mainnet unread');
    assert.deepEqual(model.holdingsFromChainBalances(view, base), model.holdingsFromChainBalances(domino, base));
  }
  assert.equal(model.networkHolds(model.mergeBalances(domino, fixture('chain-balances-asked-balance-chain-unconfigured')), model.originCandidate(1)).state, 'holds', 'Ethereum read, OP Mainnet not');
});

test('what is held on Ethereum and OP Mainnet joins the same logic: kinds, marks, the discreet line, the networks and the token to pay with', () => {
  // Kinds and marks by their profiles.
  assert.deepEqual([model.kindOf(1, ZERO), model.kindOf(1, WETH_1), model.kindOf(1, USDC_1.toUpperCase().replace('0X', '0x'))], ['ether', 'ether', 'dollar']);
  assert.deepEqual([model.kindOf(10, ZERO), model.kindOf(10, WETH_10), model.kindOf(10, USDC_10)], ['ether', 'ether', 'dollar']);
  assert.equal(model.kindOf(10, USDC_E_10), null, 'the bridged USDC.e is no dollar there');
  assert.equal(model.kindOf(1, USDC_BASE), null, 'Base\'s USDC is nothing on Ethereum');
  assert.equal(model.kindOf(137, ZERO), null, 'any other network: none');
  assert.deepEqual([model.holdingArtwork(1, ZERO), model.holdingArtwork(10, WETH_10), model.holdingArtwork(1, USDC_1)], ['ETH', 'WETH', null]);
  const pool = [ZERO, USDG]; // ETH / USDG on Robinhood Chain
  // The discreet line: 100 USDC on Ethereum (ETH there for its fee), brought as USDG, named "Ethereum".
  const ethereum = answerOf({ 4663: { [ZERO]: [0n, null] }, 8453: null, 42161: null, 1: { [ZERO]: [E18 / 100n, '40.000000'], [WETH_1]: [0n, null], [USDC_1]: [100_000_000n, '100.000000'] }, 10: null });
  const line = model.bestHolding(ethereum, 4663, pool);
  assert.deepEqual([line.chainId, line.network, line.holding.symbol, line.holding.raw, line.valueUsd, line.target], [1, 'Ethereum', 'USDC', 100_000_000n, '100', USDG]);
  // The most valuable, wherever it is; Domino's network first between two alike.
  const both = (baseUsdc) => answerOf({ 8453: { [ZERO]: [E18 / 100n, null], [USDC_BASE]: [baseUsdc * 1_000_000n, `${baseUsdc}.000000`] }, 1: { [ZERO]: [E18 / 100n, null], [USDC_1]: [100_000_000n, '100.000000'] } });
  assert.equal(model.bestHolding(both(50n), 4663, pool).chainId, 1, 'US$100 on Ethereum before US$50 on Base');
  assert.equal(model.bestHolding(both(100n), 4663, pool).chainId, 8453, 'alike: Base first');
  // A network a held step keeps closed is never named.
  assert.equal(model.bestHolding(ethereum, 4663, pool, new Set([1])), null);
  // No ETH there for the fee: not brought (the line), said under its button (the networks).
  const dry = answerOf({ 1: { [ZERO]: [0n, null], [WETH_1]: [0n, null], [USDC_1]: [100_000_000n, '100.000000'] } });
  assert.equal(model.bestHolding(dry, 4663, pool), null);
  assert.equal(model.networkHolds(dry, model.originCandidate(1)).state, 'no_gas');
  // Read as empty: gone, never named.
  assert.deepEqual(model.networkHolds(answerOf({ 10: { [ZERO]: [0n, null], [WETH_10]: [0n, null], [USDC_10]: [0n, null] } }), model.originCandidate(10)), { state: 'empty' });
  // What can be sent there, as for any network: ETH less the gas Review keeps, at its USD.
  const op = model.networkHolds(answerOf({ 10: { [ZERO]: [E18 / 100n, '40.000000'], [WETH_10]: [0n, null], [USDC_10]: [5_000_000n, '5.000000'] } }), model.originCandidate(10));
  assert.equal(op.state, 'holds');
  assert.deepEqual(op.holdings.map((h) => model.holdingText({ ...h, raw: model.sendable(h) })), [model.holdingText({ token: ZERO, symbol: 'ETH', decimals: 18, raw: E18 / 100n - REVIEW_GAS_RESERVE_WEI }), '5 USDC']);
  // Changed on purpose 2026-10-06 (the review of rugged97's #379: a one click from Ethereum quoted its ETH less the gas
  // Review keeps, which is sized to the rollups' gas): Ethereum's own ETH keeps Ethereum's gas (0.003 ETH) in what can be
  // sent, its USD, the line and the sizing; OP Mainnet, a rollup like Domino's three, keeps the gas Review keeps (above).
  assert.equal(FUNDS_ETHEREUM_GAS_RESERVE_WEI, 3n * 10n ** 15n);
  const mainnet = model.networkHolds(answerOf({ 1: { [ZERO]: [E18 / 100n, '40.000000'], [WETH_1]: [E18 / 100n, '40.000000'], [USDC_1]: [0n, null] } }), model.originCandidate(1));
  assert.deepEqual(mainnet.holdings.map((h) => model.holdingText({ ...h, raw: model.sendable(h) })), ['0.007 ETH', '0.01 WETH'], 'its ETH less its own gas; WETH, a token, all of it');
  assert.equal(mainnet.usd, '68', 'US$28 of the ETH that can be sent, and US$40 of WETH');
  assert.deepEqual([1, 10, 4663, 8453, 42161].map((chainId) => model.sendable({ chainId, token: ZERO, raw: E18 })), [E18 - FUNDS_ETHEREUM_GAS_RESERVE_WEI, ...Array(4).fill(E18 - REVIEW_GAS_RESERVE_WEI)]);
  assert.equal(model.sendable({ chainId: 1, token: ZERO, raw: FUNDS_ETHEREUM_GAS_RESERVE_WEI }), 0n, 'nothing to bring once its gas is kept');
  const thin = answerOf({ 1: { [ZERO]: [FUNDS_ETHEREUM_GAS_RESERVE_WEI, '12.000000'], [WETH_1]: [0n, null], [USDC_1]: [0n, null] } });
  assert.equal(model.bestHolding(thin, 4663, pool), null, 'ETH on Ethereum its own gas takes whole: never named');
  assert.deepEqual(model.networkHolds(thin, model.originCandidate(1)), { state: 'empty' });
  const ether = model.bestHolding(answerOf({ 1: { [ZERO]: [E18 / 10n, '400.000000'], [WETH_1]: [0n, null], [USDC_1]: [0n, null] } }), 4663, pool);
  assert.deepEqual([ether.chainId, ether.holding.raw, model.sendable(ether.holding), ether.valueUsd, ether.target], [1, E18 / 10n, E18 / 10n - FUNDS_ETHEREUM_GAS_RESERVE_WEI, '388', ZERO], 'the line names, and values, what can be sent of it');
  // After an amount: the lack and the holding chosen together, a dollar for the USDG lacking, sized by kind.
  const lack = { side: 1, token: USDG, symbol: 'USDG', decimals: 6, haveRaw: 0n, shortRaw: 50_000_000n };
  const holdings = model.holdingsFromChainBalances(ethereum, model.originCandidate(1)).holdings;
  const choice = model.bringChoice({ lacks: [lack], holdings, destination: 4663, origin: 1, deliverable: pool, prices: model.kindPrices(ethereum) });
  assert.deepEqual([choice.holding.symbol, choice.target], ['USDC', USDG], 'a plain bridge of a dollar');
  // Changed on purpose 2026-10-06 (rugged's delta of 6 Oct §3): the amount is asked by output, as from any network: the
  // need must arrive, the USDC that can be sent is the most to send.
  const request = model.quoteRequestOf({ originChainId: 1, originToken: USDC_1, destinationChainId: 4663, destinationToken: USDG, amountRaw: '50000000', slippageBps: 50, destinationGas: false, maxInputRaw: '100000000' });
  assert.deepEqual([request.amountKind, request.amountRaw, request.maxInputRaw], ['output', '50000000', '100000000'], 'the need, by output, as from any network');
  const listing = { chains: [{ chainId: 1, name: 'Ethereum', tokens: [{ address: USDC_1, symbol: 'USDC', decimals: 6, providers: ['relay', 'across'] }] }] };
  assert.equal(model.holdingFor(holdings, USDG, 4663, 1, listing).token, USDC_1, 'the one the listing bridges');
  // The token to pay with weighs what is held there too: US$500 of USDC on Ethereum against US$40 of ETH here.
  const elsewhere = answerOf({ 4663: { [ZERO]: [E18 / 100n, '40.000000'], [USDG]: [0n, null] }, 1: { [USDC_1]: [500_000_000n, '500.000000'] } });
  assert.equal(model.payToken(4663, [AI, PONS], elsewhere).address, ZERO, 'local spendable ETH takes priority over remote USDC');
  assert.equal(model.payToken(4663, [AI, PONS], answerOf({ 4663: { [ZERO]: [E18 / 100n, '40.000000'], [USDG]: [0n, null] } })).address, ZERO, 'without it, ETH');
  // Their qualified prices count where Domino's networks gave none, after any of Domino's.
  assert.deepEqual(model.kindPrices(answerOf({ 1: { [ZERO]: [E18, '2714.286500', '2714.286500000000000000'] } })), { ether: 2_714_286_500n, dollar: null });
  const merged = model.mergeBalances(answerOf({ 8453: { [ZERO]: [E18, '4000.000000', '4000.000000000000000000'] } }), answerOf({ 1: { [ZERO]: [E18, '2714.286500', '2714.286500000000000000'] } }));
  assert.equal(model.kindPrices(merged).ether, 4_000_000_000n, 'Domino\'s first');
});
