/**
 * Positions for the Price range card's lab (screens/PositionLab.tsx `range`, test builds only), from the owner's point
 * 10 (2026-10-03: "tokens go from $0.001 to $1,000,000 and none of these charts work"): each one a position as a
 * position's page reads one, its ticks computed from the prices the page writes (the app's one way round,
 * lib/read/orientation.ts: "1 BASE = X QUOTE"), so a case says what a person sees. And the pool's stored price history
 * (read-v3 `history`) the chart may draw, as the read service would answer it.
 *
 * Every price here is a plain number of the quote token for one base token, in whole tokens.
 */

import { createRequire } from 'node:module';

// v4-core's TickMath, as the app computes it (the unit build: npm run build:unit), for each case's square-root price.
const { sqrtPriceAtTick } = createRequire(import.meta.url)('../../.test-build/app/src/lib/read/screens/poolRange.js');
const LOG = Math.log(1.0001);
export const OWNER = '0x5555555555555555555555555555555555555555';
const ZERO = '0x0000000000000000000000000000000000000000';
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
export const TOKENS = {
  ETH: { address: ZERO, symbol: 'ETH', decimals: 18 },
  USDG: { address: USDG, symbol: 'USDG', decimals: 6 },
  UFG: { address: '0xefab538cf3c29237a47c6afb145d50ddf204a0a3', symbol: 'UFG', decimals: 18 },
  MANY: { address: '0x7a6d0f3c8a6f0c1b9b0e6f2d3c4b5a6978695a4b', symbol: 'MANY', decimals: 18 },
  WBTC: { address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', symbol: 'WBTC', decimals: 8 },
  USDT: { address: '0x9151434b16b9763660705744891fa906f660ecc5', symbol: 'USDT0', decimals: 6 },
  PEPE: { address: '0x6982508145454ce325ddbe47a25d4ec3d2311933', symbol: 'PEPE', decimals: 18 },
  GOLD: { address: '0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d', symbol: 'GOLD', decimals: 18 },
  DUST: { address: '0xd1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4', symbol: 'DUST', decimals: 9 },
};

/** The app's rule: USDG first, then ETH, then the pool's own order (lib/read/orientation.ts). */
const RANK = { [USDG]: 2, [ZERO]: 1 };
const rank = (token) => RANK[token.address] ?? 0;

/**
 * A pool of `base` and `quote` as the chain orders it (the lower address first), and whether the page reads it the other
 * way round from that order.
 */
function poolOf(base, quote) {
  const [currency0, currency1] = base.address < quote.address ? [base, quote] : [quote, base];
  const inverted = rank(currency0) > rank(currency1);
  const shownBase = inverted ? currency1 : currency0;
  if (shownBase !== base) throw new Error(`the page reads ${base.symbol}/${quote.symbol} as ${shownBase.symbol}'s price`);
  return { currency0, currency1, inverted };
}

/** The pool's own tick (in its order) at which the page writes `price` for one base. */
function tickAt(pool, price) {
  const [d0, d1] = [pool.currency0.decimals, pool.currency1.decimals];
  // currency1 per currency0 = 1.0001^tick × 10^(d0 − d1); read the other way round, its inverse.
  const raw = pool.inverted ? 1 / price : price;
  return Math.log(raw / 10 ** (d0 - d1)) / LOG;
}

const MIN_TICK = -887272;
const MAX_TICK = 887272;

/**
 * A position: `base` priced in `quote` (a name from TOKENS, or a token: address, symbol, decimals), the range from `low`
 * to `high` (0 and Infinity at the pool's limits), the pool's price now `now`; `closed` for one with no liquidity left.
 */
export function rangeCase({ id, base, quote, low, high, now, spacing = 60, closed = false, swing = 0.012 }) {
  const pool = poolOf(typeof base === 'string' ? TOKENS[base] : base, typeof quote === 'string' ? TOKENS[quote] : quote);
  const limit = { min: Math.ceil(MIN_TICK / spacing) * spacing, max: Math.floor(MAX_TICK / spacing) * spacing };
  // The range's ends in the pool's order: a low price of the base is the pool's high tick when read the other way round.
  const end = (price, side) => {
    if (price === 0) return side === 'low' ? (pool.inverted ? limit.max : limit.min) : null;
    if (price === Infinity) return side === 'high' ? (pool.inverted ? limit.min : limit.max) : null;
    return Math.round(tickAt(pool, price) / spacing) * spacing;
  };
  const [a, b] = [end(low, 'low'), end(high, 'high')];
  const [tickLower, tickUpper] = a < b ? [a, b] : [b, a];
  const tick = Math.floor(tickAt(pool, now));
  return {
    id,
    poolId: `0x${id.toString(16).padStart(8, '0').repeat(8)}`,
    pool,
    base: typeof base === 'string' ? TOKENS[base] : base,
    quote: typeof quote === 'string' ? TOKENS[quote] : quote,
    now,
    /** How much its price moves in an hour, as a share of it, in the history drawn for it. */
    swing,
    spec: {
      owner: OWNER,
      openedAt: Math.floor(Date.now() / 1000) - 8 * 86_400,
      closedAt: closed ? Math.floor(Date.now() / 1000) - 3600 : null,
      block: 74_000_000,
      position: {
        tokenId: String(id),
        status: closed ? 'closed' : 'open',
        poolId: `0x${id.toString(16).padStart(8, '0').repeat(8)}`,
        currencies: [pool.currency0, pool.currency1],
        fee: 3000,
        tickSpacing: spacing,
        hooks: ZERO,
        tickLower,
        tickUpper,
        liquidity: closed ? '0' : '1000000000000',
        sqrtPriceX96: sqrtPriceAtTick(tick).toString(),
        tick,
        unclaimedFees: ['0', '0'],
        principal: ['0', '0'],
      },
    },
  };
}

/** The cases, by name: the owner's own ETH/MANY position first. */
export const CASES = {
  // The owner's screenshot: ETH/MANY, closed, the price inside where its range was (0.000000366503 to 0.000000799485).
  closed: rangeCase({ id: 3_401_001, base: 'MANY', quote: 'ETH', low: 3.66503e-7, high: 7.99485e-7, now: 7.10148e-7, spacing: 60, closed: true }),
  // UFG in USDG, 0.0025 inside 0.0018 to 0.0035.
  inside: rangeCase({ id: 3_401_002, base: 'UFG', quote: 'USDG', low: 0.0018, high: 0.0035, now: 0.0025, spacing: 200 }),
  // The range above the price (UFG must rise to reach it).
  under: rangeCase({ id: 3_401_003, base: 'UFG', quote: 'USDG', low: 0.004, high: 0.006, now: 0.0025, spacing: 200 }),
  // The range under the price (UFG must fall to reach it).
  over: rangeCase({ id: 3_401_004, base: 'UFG', quote: 'USDG', low: 0.001, high: 0.0018, now: 0.0025, spacing: 200 }),
  // Far over: the range a hundred times under the price.
  'far-over': rangeCase({ id: 3_401_005, base: 'UFG', quote: 'USDG', low: 0.00001, high: 0.00002, now: 0.0025, spacing: 200 }),
  // Every price: 0 to ∞.
  'full-range': rangeCase({ id: 3_401_006, base: 'UFG', quote: 'USDG', low: 0, high: Infinity, now: 0.0025, spacing: 200 }),
  // One end at the pool's limit: 0 to 0.004, and 0.0018 to ∞.
  'to-zero': rangeCase({ id: 3_401_007, base: 'UFG', quote: 'USDG', low: 0, high: 0.004, now: 0.0025, spacing: 200 }),
  'to-infinity': rangeCase({ id: 3_401_008, base: 'UFG', quote: 'USDG', low: 0.0018, high: Infinity, now: 0.0025, spacing: 200 }),
  // Tiny prices: MANY in ETH, open and inside (1e-7), and a dust token in USDG (1e-12).
  tiny: rangeCase({ id: 3_401_009, base: 'MANY', quote: 'ETH', low: 5.2e-7, high: 9.1e-7, now: 7.10148e-7, spacing: 60 }),
  micro: rangeCase({ id: 3_401_010, base: 'DUST', quote: 'USDG', low: 2.1e-12, high: 5.5e-12, now: 3.2e-12, spacing: 60 }),
  // Huge prices: WBTC in USDG (1e5), and GOLD in PEPE (1e9, two ordinary tokens: the pool's own order).
  huge: rangeCase({ id: 3_401_011, base: 'WBTC', quote: 'USDG', low: 95_000, high: 150_000, now: 120_345, spacing: 60 }),
  giant: rangeCase({ id: 3_401_012, base: 'GOLD', quote: 'PEPE', low: 1.8e9, high: 3.4e9, now: 2.5e9, spacing: 60 }),
  // A stable pair's narrow range: 0.9995 to 1.0005, the price 1.0001, moving as a stable pair moves.
  narrow: rangeCase({ id: 3_401_013, base: 'USDT', quote: 'USDG', low: 0.9995, high: 1.0005, now: 1.0001, spacing: 1, swing: 0.0003 }),
  // A tight range on a token that moves: 0.00248 to 0.00252, a tenth of the week's moves.
  tight: rangeCase({ id: 3_401_015, base: 'UFG', quote: 'USDG', low: 0.00248, high: 0.00252, now: 0.0025, spacing: 10 }),
  // A wide range: a hundredth to a hundred times the price.
  wide: rangeCase({ id: 3_401_014, base: 'UFG', quote: 'USDG', low: 0.000025, high: 0.25, now: 0.0025, spacing: 200 }),
};

/** A decimal string the read-v3 contract accepts (no exponent), to `digits` significant digits. */
export function decimalText(value, digits = 12) {
  if (!(value > 0) || !Number.isFinite(value)) throw new Error(`not a price: ${value}`);
  const exponent = Math.floor(Math.log10(value));
  const places = Math.max(0, digits - 1 - exponent);
  const text = value.toFixed(Math.min(100, places));
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

const HOUR = 3_600;

/** A small deterministic random sequence, so every run draws the same line. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * The pool's stored hourly price history (read-v3 `history`) for `item` over the window asked, as the read service
 * answers it: a walk that ends near the case's price now, `swing` its hourly moves (a share of the price), a candle only
 * for an hour with swaps (`quiet`, the share of hours without any), and `gap` hours not collected (a partial history).
 * `end` is the snapshot's time, in seconds.
 */
export function historyFor(item, body, { end, swing = item.swing ?? 0.012, quiet = 0, gap = null, drift = 0, seed = item.id } = {}) {
  const window = body.windowSeconds ?? 86_400;
  const resolution = body.resolutionSeconds ?? HOUR;
  const start = end - window;
  const next = random(seed);
  const hours = Math.floor(window / resolution);
  // Backwards from the price now: each earlier close a small move away, so the line ends where the page's price is.
  const closes = new Array(hours);
  let price = item.now;
  for (let index = hours - 1; index >= 0; index -= 1) {
    closes[index] = price;
    price = price * Math.exp((next() - 0.5) * 2 * swing - drift);
  }
  const first = Math.floor(start / resolution) * resolution;
  const uncovered = gap ? { startTimestamp: end - gap[0] * resolution, endTimestamp: end - gap[1] * resolution } : null;
  const candles = [];
  for (let index = 0; index < hours; index += 1) {
    const at = first + (index + 1) * resolution;
    if (at >= end) break;
    if (uncovered && at < uncovered.endTimestamp && at + resolution > uncovered.startTimestamp) continue;
    // The newest hour always trades, so the line reaches today.
    if (at + 2 * resolution < end && next() < quiet) continue;
    const close = closes[index];
    const open = closes[Math.max(0, index - 1)];
    const high = Math.max(open, close) * (1 + next() * swing * 0.4);
    const low = Math.min(open, close) * (1 - next() * swing * 0.4);
    const complete = at >= start && at + resolution <= end;
    candles.push({ startTimestamp: at, open: decimalText(open), high: decimalText(high), low: decimalText(low), close: decimalText(close), swapCount: 1 + Math.floor(next() * 9), complete });
  }
  const covered = uncovered
    ? [{ startTimestamp: start, endTimestamp: uncovered.startTimestamp }, { startTimestamp: uncovered.endTimestamp, endTimestamp: end }]
    : [{ startTimestamp: start, endTimestamp: end }];
  return {
    schemaVersion: 1,
    chainId: 4663,
    poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    poolId: body.poolId,
    currency: body.currency,
    quoteCurrency: item.quote.address,
    source: 'robinhood_pool_swap_logs',
    methodology: 'pool_ratio_v1',
    unit: 'quote_per_base',
    status: uncovered ? 'partial' : 'available',
    reason: uncovered ? 'history_acquisition_pending' : null,
    requestedWindow: { startTimestamp: start, endTimestamp: end },
    resolutionSeconds: resolution,
    snapshot: { number: 74_000_000, hash: `0x${'ab'.repeat(32)}`, timestamp: end },
    covered,
    gaps: uncovered ? [uncovered] : [],
    candles: candles.filter((candle) => !candle.complete || covered.some((one) => one.startTimestamp <= candle.startTimestamp && candle.startTimestamp + resolution <= one.endTimestamp)),
    acquisitionAccepted: false,
    executionAvailable: false,
  };
}

/** The read service's answer for a pool whose history is not collected yet. */
export function notBuilt(item, body, { end }) {
  const window = body.windowSeconds ?? 86_400;
  return {
    schemaVersion: 1,
    chainId: 4663,
    poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    poolId: body.poolId,
    currency: body.currency,
    quoteCurrency: item.quote.address,
    source: 'robinhood_pool_swap_logs',
    methodology: 'pool_ratio_v1',
    unit: 'quote_per_base',
    status: 'not_built',
    reason: 'history_acquisition_pending',
    requestedWindow: { startTimestamp: end - window, endTimestamp: end },
    resolutionSeconds: body.resolutionSeconds ?? HOUR,
    snapshot: null,
    covered: [],
    gaps: [],
    candles: [],
    acquisitionAccepted: true,
    executionAvailable: false,
  };
}

/** The lab's address for a case. */
export const labHash = (item) => `#/position-lab/${encodeURIComponent(JSON.stringify({ range: item.spec }))}`;
