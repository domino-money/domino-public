/**
 * TEST-ONLY. read-v6's chain-balances answered for the Wallet card's tokens on Base and Arbitrum One (src/v2in/walletNetworks,
 * R-07, 2026-11-06), on both networks at once: the tokens asked, each network `current` at the package fixture's block
 * unless `down` names it, each balance from `held` (`<chainId>:<address>` → raw, zero otherwise) unless `unread` names it.
 * Prices as the contract's profiles allow them: each network's stable at $1, ETH and WETH at the fixture's ETH/USD round
 * from that network's own feed, any other token at `pools` (`<chainId>:<address>` → USD per whole token, from a pool
 * against WETH) or none. Every answer is checked against the package's validators before it is served.
 */
import { readFileSync } from 'node:fs';
import * as runtime from '../../../api-contracts/read-v6/runtime.mjs';
import { CONSTANTS } from '../../../api-contracts/read-v6/schema-data.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../../api-contracts/read-v6/fixtures/valid/${name}.json`, import.meta.url), 'utf8'));
const BALANCES = fixture('chain-balances-asked');
const BASE = BALANCES.chains[0];
const ETH_PRICE = BASE.balances.find((row) => row.symbol === 'ETH').price;
const POOL_PRICE = BASE.balances.find((row) => row.symbol === 'LIVE').price;
const STABLE_PRICE = fixture('chain-pools').tokens.find((token) => token.symbol === 'USDC').price;
export const ZERO = '0x0000000000000000000000000000000000000000';
/** The snapshot block every network answers at (the fixture's); `snapshot(n)` another one. */
export const SNAPSHOT = BASE.snapshot;

/** The package's own contract. Added 2026-11-07 (Elysium's screens): day 9's (./elysium-day9.mjs READ_V6_DAY9) for Elysium. */
const PACKAGE = Object.freeze({ runtime, CONSTANTS });
/** A native currency priced at its native pool alone (a profile's `nativePool`, Elysium's HYPE on day 9): $1.25 a token. */
const nativePoolPrice = (pool) => ({ ...POOL_PRICE, ethUsd: null, usd: '1.250000000000000000', depthUsd: '50000.000000', pool: { ...pool } });

/** What `token` is worth on `chainId`, as the contract's profile for it allows (or none). */
function priceOf(chainId, address, decimals, pools, constants = CONSTANTS) {
  const profile = constants.priceProfiles[chainId];
  const eth = profile.nativePool ? nativePoolPrice(profile.nativePool) : { ...ETH_PRICE, ethUsd: { ...ETH_PRICE.ethUsd, feed: profile.feed } };
  if (address === profile.stable) return { price: STABLE_PRICE, priceReason: null };
  if (address === ZERO || address === profile.wrapped) return { price: eth, priceReason: null };
  const usd = pools[`${chainId}:${address}`];
  if (usd === undefined) return { price: null, priceReason: decimals === null ? 'decimals_unknown' : 'no_pool' };
  const [a, b] = [profile.wrapped, address].sort();
  return { price: { ...POOL_PRICE, ethUsd: eth.ethUsd, usd, pool: { ...POOL_PRICE.pool, currency0: a, currency1: b } }, priceReason: null };
}

/** USD at 6 decimals, rounded down, of `raw` at `usd` (18 decimals) per whole token of `decimals`. */
function valueUsd(raw, decimals, usd) {
  const [whole, fraction = ''] = usd.split('.');
  const per = BigInt(whole + fraction.padEnd(18, '0').slice(0, 18));
  const micro = (BigInt(raw) * per) / 10n ** BigInt(decimals) / 10n ** 12n;
  return `${micro / 1_000_000n}.${String(micro % 1_000_000n).padStart(6, '0')}`;
}
const sumUsd = (values) => {
  const micro = values.reduce((total, value) => total + BigInt(value.replace('.', '')), 0n);
  return `${micro / 1_000_000n}.${String(micro % 1_000_000n).padStart(6, '0')}`;
};

/**
 * One chain-balances answer for `request` ({wallet, tokens}). `meta` (`<chainId>:<address>` → {symbol, decimals}) is what
 * the chain says of a token besides the networks' own currencies; `block` the snapshot's number (the fixture's otherwise).
 */
export function walletBalancesAnswer(request, { held = {}, unread = [], down = [], pools = {}, meta = {}, block = SNAPSHOT.number, contract = PACKAGE } = {}) {
  const snapshot = { ...SNAPSHOT, number: block };
  // Added 2026-11-07: a HYPE-native network (Elysium) names its own currencies HYPE and WHYPE.
  const own = (chainId, address) => {
    const profile = contract.CONSTANTS.priceProfiles[chainId];
    const hype = chainId === 99901;
    if (address === ZERO) return { symbol: hype ? 'HYPE' : 'ETH', decimals: 18 };
    if (address === profile.wrapped) return { symbol: hype ? 'WHYPE' : 'WETH', decimals: 18 };
    if (address === profile.stable) return { symbol: 'USDC', decimals: 6 };
    return meta[`${chainId}:${address}`] ?? { symbol: null, decimals: null };
  };
  const asked = request.tokens ?? [];
  const chainIds = [...new Set(asked.map((entry) => entry.chainId))].sort((a, b) => a - b);
  const chains = chainIds.map((chainId) => {
    const isDown = down.includes(chainId);
    const rows = asked.filter((entry) => entry.chainId === chainId).map(({ address }) => {
      const key = `${chainId}:${address}`;
      const { symbol, decimals } = own(chainId, address);
      const { price, priceReason } = priceOf(chainId, address, decimals, pools, contract.CONSTANTS);
      if (isDown || unread.includes(key)) return { address, symbol: null, decimals: null, balanceRaw: null, status: 'unavailable', price: null, priceReason: priceReason ?? 'price_read_failed', valueUsd: null };
      const raw = String(held[key] ?? 0n);
      const value = price && decimals !== null ? valueUsd(raw, decimals, price.usd) : null;
      return { address, symbol, decimals, balanceRaw: raw, status: 'read', price: price ? (price.snapshot === null ? price : { ...price, snapshot }) : null, priceReason, valueUsd: value };
    });
    if (isDown) return { chainId, status: 'unavailable', reason: 'chain_read_failed', snapshot: null, totalUsd: null, balances: rows };
    const total = rows.every((row) => row.status === 'read' && (row.balanceRaw === '0' || row.valueUsd !== null)) ? sumUsd(rows.map((row) => row.valueUsd ?? '0.000000')) : null;
    return { chainId, status: 'current', reason: null, snapshot, totalUsd: total, balances: rows };
  });
  const complete = chains.every((chain) => chain.status === 'current');
  const all = chains.length > 0 && chains.every((chain) => chain.totalUsd !== null);
  const body = { ...BALANCES, wallet: request.wallet, coverage: complete ? 'complete' : 'partial', chains, totalUsd: all ? sumUsd(chains.map((chain) => chain.totalUsd)) : null };
  if (!contract.runtime.validateResponse('chain-balances', body) || !contract.runtime.validateExchange('chain-balances', request, body)) {
    throw new Error(`the test's chain-balances answer breaks the contract: ${JSON.stringify(body).slice(0, 600)}`);
  }
  return body;
}
