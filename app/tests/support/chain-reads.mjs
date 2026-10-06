/**
 * TEST-ONLY. read-v6's live chain reads (chain-pools, chain-balances, chain-tokens; api-contracts/read-v6 README "Chain
 * reads") answered for a fake chain (./v2-chain.mjs) on Base or Arbitrum One (Robinhood Chain too since 2026-10-06, for its
 * pairs' prices and the wallet's balances there; and, for chain-balances, Ethereum or OP Mainnet, rugged97's #379): answers
 * the contract accepts, built from the package's own fixtures (their snapshot, their ETH/USD round, the stable at 1) with
 * the test's pools, balances and tokens.
 * `answer(route, request)` is what a browser suite hands to `window.__dominoV2Test.read6` (src/v2in/dataSource.ts); every
 * answer is checked against the package's validators before it is served, so a suite never draws what the contract refuses.
 */
import { readFileSync } from 'node:fs';
import * as runtime from '../../../api-contracts/read-v6/runtime.mjs';
import { poolIdOf } from './v2-chain.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../../api-contracts/read-v6/fixtures/valid/${name}.json`, import.meta.url), 'utf8'));
const POOLS = fixture('chain-pools');
const BALANCES = fixture('chain-balances-asked');
const TOKENS = fixture('chain-tokens-usdc');
const ZERO = '0x0000000000000000000000000000000000000000';
const ETH_PRICE = POOLS.tokens.find((token) => token.symbol === 'ETH').price;
const STABLE_PRICE = POOLS.tokens.find((token) => token.symbol === 'USDC').price;
/**
 * Added 2026-10-06 (rugged97's #379: chain-balances also reads Ethereum and OP Mainnet when a request names them): their
 * profiles (api-contracts/v2/balance-chains), for their stable, their WETH and their Chainlink ETH/USD feed.
 */
const balanceChain = (name) => JSON.parse(readFileSync(new URL(`../../../api-contracts/v2/balance-chains/${name}.json`, import.meta.url), 'utf8'));
const BALANCE_CHAINS = [balanceChain('ethereum-1'), balanceChain('optimism-10')];
const STABLES = {
  4663: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', 8453: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 42161: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  ...Object.fromEntries(BALANCE_CHAINS.map((chain) => [chain.chainId, chain.chargeCurrencies.find((c) => c.rank === 1).address.toLowerCase()])),
};
const WRAPPED = {
  4663: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', 8453: '0x4200000000000000000000000000000000000006', 42161: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
  ...Object.fromEntries(BALANCE_CHAINS.map((chain) => [chain.chainId, chain.wrappedNative.address.toLowerCase()])),
};
/**
 * Added 2026-10-06 (Robinhood Chain's pairs valued in USD): the fixtures' round as Robinhood Chain's own feed reads it (the
 * contract's PRICE_PROFILES: another feed, a heartbeat of 24 h), so its ETH and WETH are priced too.
 * Changed on purpose 2026-10-06 (rugged97's #379): and as Ethereum's and OP Mainnet's own feeds read it (heartbeats of
 * 3,600 s and 1,200 s; the round is a minute old at the fixtures' block), so theirs are priced as well.
 */
const ETH_PRICES = {
  8453: ETH_PRICE,
  4663: { ...ETH_PRICE, ethUsd: { ...ETH_PRICE.ethUsd, feed: '0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9' } },
  ...Object.fromEntries(BALANCE_CHAINS.map((chain) => [chain.chainId, { ...ETH_PRICE, ethUsd: { ...ETH_PRICE.ethUsd, feed: chain.gasPrice.chainlinkEthUsd.proxy.toLowerCase() } }])),
};

/**
 * A token's price as the fixtures' read says it: the stable at 1; ETH and WETH at Base's feed round (the fixtures' chain;
 * on Arbitrum One its feed is another, so there they are unpriced, which a zero balance does not need); any other none.
 * Changed on purpose 2026-10-06: Robinhood Chain too, USDG at 1 and its ETH and WETH at the same round from its own feed.
 */
function priceOf(chainId, address) {
  if (address === ZERO || address === WRAPPED[chainId]) return ETH_PRICES[chainId] ? { price: ETH_PRICES[chainId], priceReason: null } : { price: null, priceReason: 'eth_usd_stale' };
  if (address === STABLES[chainId]) return { price: STABLE_PRICE, priceReason: null };
  return { price: null, priceReason: 'no_pool' };
}

/** USD at 6 decimals, rounded down, of `raw` units at `usd` (18 decimals) per whole token of `decimals`. */
function valueUsd(raw, decimals, usd) {
  const [whole, fraction = ''] = usd.split('.');
  const per = BigInt(whole + fraction.padEnd(18, '0'));
  const micro = (BigInt(raw) * per) / 10n ** BigInt(decimals) / 10n ** 12n;
  return `${micro / 1_000_000n}.${String(micro % 1_000_000n).padStart(6, '0')}`;
}
const sumUsd = (values) => {
  const micro = values.reduce((total, value) => total + BigInt(value.replace('.', '')), 0n);
  return `${micro / 1_000_000n}.${String(micro % 1_000_000n).padStart(6, '0')}`;
};

function checked(route, request, body) {
  if (!runtime.validateResponse(route, body) || !runtime.validateExchange(route, request, body)) {
    throw new Error(`the test's ${route} answer breaks the contract: ${JSON.stringify(body).slice(0, 400)}`);
  }
  return { status: 200, body };
}

/**
 * The chain reads for one network: `tokens` ({address, symbol, name, decimals}) the search knows, `pools` ({pool,
 * sqrtPriceX96, tick, liquidity}) at its head, the wallet's `balances` ({[address]: raw}). `calls` records each request.
 * Added 2026-10-06: a v3 pool's `address` beside its `pool` (or on it, as before), and a pool's `depthUsd` when its depth
 * was measured.
 */
export function createChainReads({ chainId, tokens = [], pools = [], balances = {} }) {
  const calls = [];
  const meta = new Map(tokens.map((token) => [token.address, token]));
  const live = (address) => {
    const known = meta.get(address);
    return { address, decimals: known?.decimals ?? null, symbol: known?.symbol ?? null, status: known ? 'available' : 'unavailable', ...(known ? priceOf(chainId, address) : { price: null, priceReason: 'decimals_unknown' }) };
  };
  return {
    calls,
    answer(route, request) {
      calls.push({ route, request });
      if (route === 'chain-tokens') {
        if (request.chainId !== chainId) return { status: 200, body: { ...TOKENS, chainId: request.chainId, query: request.query, tokens: [] } };
        const text = String(request.query).toLowerCase();
        const hits = tokens.filter((token) => token.address === text || token.symbol.toLowerCase().includes(text) || (token.name ?? '').toLowerCase().includes(text)).slice(0, request.limit ?? 20);
        return checked(route, request, { ...TOKENS, chainId, query: request.query, tokens: hits.map((token) => ({ address: token.address, symbol: token.symbol, name: token.name ?? null, decimals: token.decimals, sources: token.sources ?? ['uniswap_default_list'] })), truncated: false });
      }
      if (route === 'chain-pools') {
        if (request.chainId !== chainId) return undefined;
        const token = request.token;
        const paired = request.pairedToken ?? null;
        const listed = pools.filter(({ pool }) => [pool.currency0, pool.currency1].includes(token) && (paired === null || [pool.currency0, pool.currency1].includes(paired)));
        const named = [...new Set([token, ...(paired ? [paired] : []), ...listed.flatMap(({ pool }) => [pool.currency0, pool.currency1])])].sort();
        return checked(route, request, {
          ...POOLS, chainId, token, pairedToken: paired,
          tokens: named.map(live),
          pools: listed.map(({ pool, address, sqrtPriceX96, tick, liquidity, depthUsd = null }) => ({
            pool: { dex: pool.dex, currency0: pool.currency0, currency1: pool.currency1, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks },
            id: pool.dex === 4 ? poolIdOf(pool) : null, address: pool.dex === 3 ? (address ?? pool.address) : null,
            sqrtPriceX96: String(sqrtPriceX96), tick, liquidity: String(liquidity), lpFeePips: pool.fee, protocolFee: 0,
            swapFeePips: { zeroForOne: pool.fee, oneForZero: pool.fee },
            market: depthUsd === null ? { status: 'unavailable', reference: null, depthUsd: null, reason: 'pool_depth_unmeasurable' } : { status: 'measured', reference: pool.currency0, depthUsd, reason: null },
          })),
          truncated: false,
        });
      }
      if (route === 'chain-balances') {
        const asked = request.tokens ?? [];
        const chainIds = [...new Set(asked.map((entry) => entry.chainId))].sort((a, b) => a - b);
        const chains = chainIds.map((id) => {
          const rows = asked.filter((entry) => entry.chainId === id).map(({ address }) => {
            const known = meta.get(address);
            const raw = id === chainId ? String(balances[address] ?? 0n) : null;
            const { price, priceReason } = known ? priceOf(id, address) : { price: null, priceReason: 'decimals_unknown' };
            const value = raw !== null && price && known ? valueUsd(raw, known.decimals, price.usd) : null;
            return { address, symbol: known?.symbol ?? null, decimals: known?.decimals ?? null, balanceRaw: raw, status: raw === null ? 'unavailable' : 'read', price, priceReason, valueUsd: value };
          });
          if (id !== chainId) return { chainId: id, status: 'unavailable', reason: 'chain_not_configured', snapshot: null, totalUsd: null, balances: rows };
          const total = rows.every((row) => row.balanceRaw === '0' || row.valueUsd !== null) ? sumUsd(rows.map((row) => row.valueUsd ?? '0.000000')) : null;
          return { chainId: id, status: 'current', reason: null, snapshot: BALANCES.chains[0].snapshot, totalUsd: total, balances: rows };
        });
        const complete = chains.every((chain) => chain.status === 'current');
        const all = chains.every((chain) => chain.totalUsd !== null);
        return checked(route, request, { ...BALANCES, wallet: request.wallet, coverage: complete ? 'complete' : 'partial', chains, totalUsd: all && chains.length > 0 ? sumUsd(chains.map((chain) => chain.totalUsd)) : null });
      }
      return undefined;
    },
  };
}
