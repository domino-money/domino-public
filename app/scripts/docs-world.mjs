/**
 * The made-up world the docs' pictures are shot in (scripts/docs-shots.mjs), and nothing else: no suite runs it.
 *
 * Domino's own tokens (ETH, WETH, USDG and MARLIN, the ones whose artwork ships in public/tokens/), five pools between
 * them with plausible round figures, and the answers the read service, the featured pools list and the chain give
 * about them. Every answer goes through the unmodified read Worker (bridge/src/worker.mjs) and its contracts'
 * validators, as the browser suites' read stub does (tests/support/read-stub.mjs), so a picture only ever shows what
 * the app can draw from a valid answer. Only the figures are invented; the tokens' addresses are their real ones on
 * Robinhood Chain, so each wears its own artwork.
 *
 * Also here: the price the ETH/USDG 0.30% pool is shown at, tuned so that New position's 1000 USDG asks a short
 * amount of ETH (a person types round amounts), the wallet's positions, sized so that every amount they show is short
 * (2,004.18 USDG and 0.8419 ETH, not 2,003.8 or 18 decimals), the wallet's balances, and a fees history for the Auto-compound
 * position, whose Swaps give its page a Fees earned history and Your APR (the fees pipeline reads them as it reads the
 * chain's) and leave it exactly the fees it shows.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { encodeAbiParameters, keccak256, numberToHex, pad, zeroAddress } from 'viem';
import { createWorker } from '../../bridge/src/worker.mjs';
import * as readV1 from '../../api-contracts/read-v1/runtime.mjs';
import * as readV2 from '../../api-contracts/read-v2/runtime.mjs';
import * as readV5 from '../../api-contracts/read-v5/runtime.mjs';

const require = createRequire(import.meta.url);
const APP = resolve(import.meta.dirname, '..');
const REPO = resolve(APP, '..');
const { sqrtPriceAtTick, presetRange, MIN_TICK, MAX_TICK } = require('../.test-build/app/src/lib/read/screens/poolRange.js');
const { pairedAmount } = require('../.test-build/app/src/lib/create/pairAmount.js');
// Changed on purpose 2026-10-04 (the owner: docs revalidated for V2): lib/fees/replay.ts went with the fees replay
// (9ce0fdad, 2026-10-02: a position's ledger in its place), so it is asked for only when a position's fee history is
// built (feeHistory, for the wallet's position scenes), and the scenes that need none shoot without it.
const replayLib = () => require('../.test-build/app/src/lib/fees/replay.js');
const { principalAt } = require('../.test-build/app/src/components/positions/visual/value.js');
const feesLib = require('../.test-build/app/src/lib/fees/constants.js');

// ---- Tokens and pools -----------------------------------------------------------------------------------------------

const ETH = zeroAddress;
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const MARLIN = '0xab35d04e1ee39c789c4a65d522417b3c7f2e4723';
export const TOKENS = {
  [ETH]: { symbol: 'ETH', decimals: 18 },
  [WETH]: { symbol: 'WETH', decimals: 18 },
  [USDG]: { symbol: 'USDG', decimals: 6 },
  [MARLIN]: { symbol: 'MARLIN', decimals: 18 },
};

/** What New position's amount step is given: this much USDG, and the ETH it asks comes out short (see tunePrice). */
export const DEPOSIT_USDG = '1000';
/** The wallet's balances (Test Wallet A's, in this world only): what New position's amount step shows beside each token. */
const BALANCES = { [ETH]: '1.25', [USDG]: '2500' };

/** A decimal string in a token's raw units: rawOf('2003.85', 6) is 2003850000n. */
export function rawOf(text, decimals) {
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole + fraction.padEnd(decimals, '0').slice(0, decimals));
}

const Q96 = 1n << 96n;

function isqrt(n) {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** √(price) × 2⁹⁶ for `price` of currency1 per currency0 in whole tokens (a decimal string). */
function sqrtOfPrice(price, decimals0, decimals1) {
  const [whole, fraction = ''] = price.split('.');
  let num = BigInt(whole + fraction);
  let den = 10n ** BigInt(fraction.length);
  if (decimals1 >= decimals0) num *= 10n ** BigInt(decimals1 - decimals0);
  else den *= 10n ** BigInt(decimals0 - decimals1);
  return isqrt((num << 192n) / den);
}

/** TickMath.getTickAtSqrtPrice: the largest tick whose price is at most `sqrtPriceX96`. */
function tickAt(sqrtPriceX96) {
  let low = MIN_TICK;
  let high = MAX_TICK;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (sqrtPriceAtTick(mid) <= sqrtPriceX96) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * The pools, in the featured list's order (highest estimated APR first). `price` is currency1 per currency0; TVL and
 * volume are the provider's figures, in dollars; `yesterday` the pool's APR the day before, which the list records
 * (featured-policy v2, 2026-09-28: the list ranks by today's APR alone).
 */
const POOL_SPECS = [
  { name: 'ETH/USDG 0.30%', currency0: ETH, currency1: USDG, fee: 3000, tickSpacing: 60, price: '2500', tvl: '2410000', volume: '598200', yesterday: '28.1' },
  { name: 'USDG/MARLIN 0.30%', currency0: USDG, currency1: MARLIN, fee: 3000, tickSpacing: 60, price: '41.2', tvl: '1127000', volume: '268400', yesterday: '27.3' },
  { name: 'USDG/MARLIN 1.00%', currency0: USDG, currency1: MARLIN, fee: 10000, tickSpacing: 200, price: '41.23', tvl: '4618000', volume: '258900', yesterday: '21.9' },
  { name: 'ETH/USDG 0.05%', currency0: ETH, currency1: USDG, fee: 500, tickSpacing: 10, price: '2500.4', tvl: '3864200', volume: '2917500', yesterday: '14.2' },
  { name: 'WETH/USDG 0.05%', currency0: WETH, currency1: USDG, fee: 500, tickSpacing: 10, price: '2499.6', tvl: '846300', volume: '512900', yesterday: '11.9' },
];

const poolIdOf = (key) =>
  keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));

/** The 24h fee APR estimate as the read service writes it (api-contracts/read-v2 runtime's own arithmetic). */
function aprOf(volume, tvl, feePips) {
  const decimal = (value) => {
    const [integer, fraction = ''] = value.split('.');
    return [BigInt(integer + fraction), 10n ** BigInt(fraction.length)];
  };
  const [v, vd] = decimal(volume);
  const [t, td] = decimal(tvl);
  const numerator = v * td * BigInt(feePips) * 1000000n * 36500n * 10n ** 18n;
  const denominator = vd * t * 1000000n * 1000000n;
  let units = numerator / denominator;
  if ((numerator % denominator) * 2n >= denominator) units++;
  const fraction = String(units % 10n ** 18n).padStart(18, '0').replace(/0+$/u, '');
  return `${units / 10n ** 18n}${fraction ? `.${fraction}` : ''}`;
}

/**
 * The ETH/USDG 0.30% pool's price, moved a few ticks at most, where DEPOSIT_USDG in the range New position draws (its
 * standard preset) asks a short amount of ETH: whole ten-thousandths, the last one not zero (0.4522, never 0.452 or 18
 * decimals). pairedAmount (lib/create/pairAmount.ts) is exact integer arithmetic, so the amount the step shows is
 * exactly the one found here. Within one tick the range is fixed and the ETH asked falls as the price rises.
 */
function tunePrice(key, sqrtPriceX96) {
  const amountRaw = String(rawOf(DEPOSIT_USDG, TOKENS[USDG].decimals));
  const step = 10n ** 14n;
  const start = tickAt(sqrtPriceX96);
  for (let away = 0; away < 50; away += 1) {
    for (const tick of away === 0 ? [start] : [start + away, start - away]) {
      const range = presetRange(tick, key.tickSpacing, 'standard');
      const asks = (s) => {
        const out = pairedAmount({ sqrtPriceX96: String(s), tickLower: range.lower, tickUpper: range.upper, independent: 1, amountRaw });
        if (out.kind !== 'amount') throw new Error(`no paired amount at ${s}`);
        return BigInt(out.raw);
      };
      const lowest = sqrtPriceAtTick(tick);
      const highest = sqrtPriceAtTick(tick + 1) - 1n;
      for (let target = ((asks(highest) + step - 1n) / step) * step; target <= asks(lowest); target += step) {
        if ((target / step) % 10n === 0n) continue;
        // The lowest price that asks at most `target`; it asks exactly `target` when a price does.
        let low = lowest;
        let high = highest;
        while (low < high) {
          const mid = (low + high) / 2n;
          if (asks(mid) <= target) high = mid;
          else low = mid + 1n;
        }
        if (asks(low) === target) return low;
      }
    }
  }
  throw new Error(`no price near tick ${start} asks a short amount of ETH for ${DEPOSIT_USDG} USDG`);
}

export const POOLS = POOL_SPECS.map((spec) => {
  const key = { currency0: spec.currency0, currency1: spec.currency1, fee: spec.fee, tickSpacing: spec.tickSpacing, hooks: zeroAddress };
  let sqrtPriceX96 = sqrtOfPrice(spec.price, TOKENS[spec.currency0].decimals, TOKENS[spec.currency1].decimals);
  if (spec === POOL_SPECS[0]) sqrtPriceX96 = tunePrice(key, sqrtPriceX96);
  return { ...spec, key, poolId: poolIdOf(key), sqrtPriceX96, tick: tickAt(sqrtPriceX96), apr: aprOf(spec.volume, spec.tvl, spec.fee) };
});
export const MAIN_POOL = POOLS[0];
const poolById = (id) => POOLS.find((pool) => pool.poolId === String(id).toLowerCase());
export const poolNamed = (name) => POOLS.find((pool) => pool.name === name);

// ---- The wallet's positions -----------------------------------------------------------------------------------------

/**
 * A position in `pool` whose principal at the pool's price reads short amounts: USDG in whole cents and ETH in whole
 * ten-thousandths, the last digit of each not zero (2,004.18 and 0.8419, never 2,003.8 or 18 decimals), each within 2%
 * of `usdg` and `eth`. Its range is the nearest to `around` on the pool's tick spacing that has one, the USDG the
 * nearest to `usdg`, and the liquidity is sized to the USDG. Each amount sits a few units above its short figure, so a
 * unit of rounding either way still reads the same six significant digits (the app's amounts, lib/format/amount.ts).
 */
function positionIn(pool, { usdg, eth, around: [lower, upper] }) {
  const price = pool.sqrtPriceX96;
  const wantUsdg = rawOf(usdg, TOKENS[USDG].decimals);
  const want = rawOf(eth, 18);
  const cent = 10n ** 4n;
  const step = 10n ** 14n;
  const near = (value, target) => (value > target ? value - target : target - value) * 50n <= target;
  const ranges = [];
  for (let i = -40; i <= 40; i += 1) for (let j = -40; j <= 40; j += 1) ranges.push([Math.abs(i) + Math.abs(j), lower + i * pool.tickSpacing, upper + j * pool.tickSpacing]);
  ranges.sort((a, b) => a[0] - b[0]);
  for (const [, tickLower, tickUpper] of ranges) {
    if (!(tickLower < pool.tick && pool.tick < tickUpper)) continue;
    const below = price - sqrtPriceAtTick(tickLower);
    const at = (cents) => {
      const usdgRaw = cents + 3n;
      const liquidity = (usdgRaw * Q96 + below - 1n) / below;
      return { liquidity, principal: principalAt(liquidity, price, pool.tick, tickLower, tickUpper) };
    };
    // Only a range whose ETH for the USDG asked is already within 2% of `eth` is searched.
    if (!near(at(wantUsdg).principal[0], want)) continue;
    for (let k = 0n; k * cent * 50n <= wantUsdg; k += 1n) {
      for (const cents of k === 0n ? [wantUsdg] : [wantUsdg + k * cent, wantUsdg - k * cent]) {
        if ((cents / cent) % 10n === 0n) continue;
        const { liquidity, principal } = at(cents);
        const [amount0, amount1] = principal;
        const rest = amount0 % step;
        if (amount1 !== cents + 3n || rest < 10n ** 9n || rest > 4n * 10n ** 11n || (amount0 / step) % 10n === 0n || !near(amount0, want)) continue;
        return { tickLower, tickUpper, liquidity, principal };
      }
    }
  }
  throw new Error(`no range in ${pool.name} holds short amounts near ${usdg} USDG and ${eth} ETH`);
}

/**
 * The wallet's two open positions. The Auto-compound one earns its fees in the history below (feeHistory), made to
 * leave exactly `fees`: about an 18.4% APR on its value over its 18 days. The plain one's fees are given as they are.
 */
export const POSITIONS = {
  compound: { ...positionIn(MAIN_POOL, { usdg: '2003.85', eth: '0.8421', around: [-201_000, -195_000] }), fees: ['0.0075', '18.53'] },
  plain: { ...positionIn(poolNamed('ETH/USDG 0.05%'), { usdg: '617.65', eth: '0.2731', around: [-199_500, -196_500] }), fees: ['0.0021', '5.65'] },
};

// ---- The read service -----------------------------------------------------------------------------------------------

const GATEWAY = join(REPO, 'api-contracts/read-v1/fixtures/gateway');
const fixture = (name) => JSON.parse(readFileSync(join(GATEWAY, `${name}.json`), 'utf8'));
const V2_TEMPLATE = JSON.parse(readFileSync(join(REPO, 'api-contracts/read-v2/fixtures/producer/pool-market.available.json'), 'utf8'));
const V5_TEMPLATE = JSON.parse(readFileSync(join(REPO, 'api-contracts/read-v5/fixtures/valid/current.json'), 'utf8'));

/** The read answers' clock: now, so no figure is ever drawn as old. */
const NOW = Math.floor(Date.now() / 1000);
/**
 * The chain's head as the read answers and the chain name it: late enough that a position DominoSetupV1 minted
 * LIFE_DAYS ago is after its deployment (functions/_lib/owned.ts SETUP_DEPLOY_BLOCK), at the chain's ten blocks a second.
 */
const HEAD = 85_000_000;
const SNAPSHOT = { hash: `0x${'5e'.repeat(32)}`, number: HEAD, timestamp: NOW - 10 };

const assetOf = (address) => {
  const token = TOKENS[address];
  return {
    address,
    decimals: token.decimals,
    displayUnitsAvailable: true,
    executionAvailable: false,
    kind: address === ETH ? 'native' : 'erc20_candidate',
    metadataIssues: {},
    readStatus: 'available',
    symbol: token.symbol,
  };
};

function verifiedPool(pool) {
  return {
    aprReason: 'reconciled_fee_history_unavailable',
    currencies: [pool.key.currency0, pool.key.currency1],
    currentLpFeePips: pool.fee,
    executionAvailable: false,
    executionReason: 'public_execution_not_implemented',
    feeApr24h: null,
    identityStatus: 'verified_at_block',
    integrationClass: 'hookless_fixed_fee',
    poolId: pool.poolId,
    poolKey: { currency0: pool.key.currency0, currency1: pool.key.currency1, feeMode: 'fixed', fee_pips: pool.fee, hooks: zeroAddress, tick_spacing: pool.tickSpacing },
    protocolFeeRaw: 0,
    snapshot: SNAPSHOT,
    sqrtPriceX96: String(pool.sqrtPriceX96),
    suggested: false,
    suggestionReason: 'metrics_and_policy_not_qualified',
    tick: pool.tick,
  };
}

const sourceUrl = (pool) => `https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${pool.poolId}`;
const cache = { ageSeconds: 0, freshForSeconds: 60, maxStaleSeconds: 300, providerUpdateTimeKnown: false, scope: 'process_local', status: 'miss' };

/** 24 hourly candles of `token`'s USD price in `pool`, drifting to its price now, with the day's volume spread over them. */
function candlesOf(pool, token) {
  const usd = token === USDG ? 1 : token === MARLIN ? 1 / 41.2 : 2500;
  const hour = 3600;
  const last = Math.floor((NOW - 60) / hour) * hour;
  // A calm day that ends at the price now: the last close is the pool's price.
  const shape = (i) => Math.sin(i / 3.4 + 0.6) * 0.007 + Math.sin(i / 1.6 + 1) * 0.0025 - (23 - i) * 0.0004;
  const wave = (i) => shape(i) - shape(23);
  const places = usd >= 100 ? 2 : usd >= 1 ? 4 : 6;
  const fixed = (value) => value.toFixed(places);
  const out = [];
  for (let i = 0; i < 24; i += 1) {
    const open = usd * (1 + wave(i - 1));
    const close = usd * (1 + wave(i));
    const high = Math.max(open, close) * (1 + 0.002 + ((i * 7) % 5) / 1000);
    const low = Math.min(open, close) * (1 - 0.002 - ((i * 3) % 4) / 1000);
    const volume = (Number(pool.volume) / 24) * (0.55 + ((i * 37) % 11) / 10);
    out.push({ closeUsd: fixed(close), closed: i < 23, highUsd: fixed(high), lowUsd: fixed(low), openUsd: fixed(open), startTimestamp: last - (23 - i) * hour, volumeUsd: volume.toFixed(2) });
  }
  return out;
}

/** read-v1 pool-market: the pool, verified at the head, and the provider's figures; with its candles when asked. */
function poolMarket(pool, body = {}) {
  const value = fixture('pool-market.not-requested');
  const data = {
    asOfBlock: null,
    asOfTimestamp: null,
    baseToken: pool.key.currency0 === USDG ? pool.key.currency1 : pool.key.currency0,
    chainId: 4663,
    currencies: [pool.key.currency0, pool.key.currency1],
    dexLabel: 'uniswap-v4-robinhood',
    poolId: pool.poolId,
    providerReported: true,
    quoteToken: pool.key.currency0 === USDG ? pool.key.currency0 : pool.key.currency1,
    reportedLiquidityUsd: pool.tvl,
    retrievedAt: NOW - 5,
    source: 'geckoterminal',
    sourceUrl: sourceUrl(pool),
    volume24hUsd: pool.volume,
  };
  Object.assign(value, { poolId: pool.poolId, snapshot: SNAPSHOT, pool: verifiedPool(pool), market: { cache, data, reason: null, status: 'available' } });
  if (body.includePriceHistory) {
    const token = body.priceToken === 'quote' ? data.quoteToken : data.baseToken;
    const candles = candlesOf(pool, token);
    value.priceHistory = {
      cache,
      data: {
        asOfBlock: null,
        asOfTimestamp: null,
        baseToken: data.baseToken,
        candles,
        chainId: 4663,
        coverage: { closedCandles: 23, complete24h: false, completeness: 'not_established', firstTimestamp: candles[0].startTimestamp, gapsDetected: false, lastTimestamp: candles.at(-1).startTimestamp, requestedLimit: 24, returnedCandles: 24, status: 'provider_reported' },
        currencies: data.currencies,
        currency: token,
        fetchedAt: NOW - 5,
        intervalSeconds: 3600,
        poolId: pool.poolId,
        providerReported: true,
        quoteCurrency: 'usd',
        quoteToken: data.quoteToken,
        retrievedAt: NOW - 5,
        selectedToken: body.priceToken === 'quote' ? 'quote' : 'base',
        source: 'geckoterminal',
        sourceUrl: `${sourceUrl(pool)}/ohlcv/hour?aggregate=1&limit=24&currency=usd&token=${token}`,
      },
      reason: null,
      status: 'available',
    };
  }
  return value;
}

/** read-v2 pool-market: the same market, with the service's estimated APR. */
function poolMarketV2(pool) {
  const market = poolMarket(pool);
  const estimate = structuredClone(V2_TEMPLATE.estimate);
  Object.assign(estimate, {
    feeAprEstimate24hPercent: pool.apr,
    inputs: { currentLpFeePips: pool.fee, protocolFeeRaw: 0, reportedLiquidityUsd: pool.tvl, volume24hUsd: pool.volume },
    poolId: pool.poolId,
    status: 'available',
    reasons: [],
  });
  Object.assign(estimate.provenance, {
    cacheAgeSeconds: 0,
    cacheStatus: 'miss',
    effectiveMarketAgeSeconds: 5,
    evaluatedAt: NOW,
    retrievedAt: NOW - 5,
    snapshot: SNAPSHOT,
    snapshotAgeSeconds: 10,
    sourceUrl: sourceUrl(pool),
  });
  return { chainId: 4663, estimate, executionAvailable: false, market, poolId: pool.poolId, schemaVersion: 1 };
}

/** read-v1 pools: a token's pools as New position lists them, each verified at the head, with the provider's figures. */
function poolsOf(body) {
  const token = String(body.token).toLowerCase();
  const paired = typeof body.pairedToken === 'string' ? body.pairedToken.toLowerCase() : null;
  const asked = Array.isArray(body.poolIds) ? body.poolIds.map((id) => id.toLowerCase()) : null;
  // The pools asked for by id, when any is this world's; a build whose own list names pools of the real chain (the
  // wallet-test build's featured pools) is answered with the token's pools of this world, as its catalogue would.
  const named = asked?.some((id) => poolById(id)) ? asked : null;
  const found = POOLS.filter((pool) => [pool.key.currency0, pool.key.currency1].includes(token) && (!paired || [pool.key.currency0, pool.key.currency1].includes(paired)) && (!named || named.includes(pool.poolId)));
  const value = fixture('pools.success');
  const addresses = [...new Set([token, ...found.flatMap((pool) => [pool.key.currency0, pool.key.currency1])])];
  Object.assign(value, {
    discovery: { ...value.discovery, requestedPoolIds: asked?.length ?? 0, returned: found.length, v4Candidates: found.length },
    pairedToken: paired,
    pools: found.map((pool) => ({
      ...verifiedPool(pool),
      poolKind: 'discovery',
      providerMetrics: { asOfBlock: null, reportedLiquidityUsd: pool.tvl, retrievedAt: NOW - 5, source: 'dexscreener', status: 'external_unreconciled', volume24hUsd: pool.volume },
      tokenMetadataStatus: 'available',
    })),
    selectedToken: token,
    snapshot: SNAPSHOT,
    tokens: addresses.filter((address) => TOKENS[address]).map(assetOf),
  });
  return value;
}

function tokenAnswer(body) {
  const address = String(body.token).toLowerCase();
  if (!TOKENS[address]) return undefined;
  return { ...fixture(address === ETH ? 'token.native' : 'token.success'), asset: assetOf(address), snapshot: SNAPSHOT };
}

/**
 * read-v1 wallet-assets: the wallet's balances of the tokens asked for (BALANCES; none of any other), and ETH, on one
 * last page, as New position's amount step reads them.
 */
function walletAssets(body) {
  const value = fixture('wallet-assets.last-page');
  const asked = (Array.isArray(body.tokens) ? body.tokens : []).map((address) => String(address).toLowerCase()).filter((address) => TOKENS[address]);
  const addresses = [ETH, ...asked.filter((address) => address !== ETH)];
  value.items = addresses.map((address) => ({
    ...assetOf(address),
    amountRaw: String(BALANCES[address] ? rawOf(BALANCES[address], TOKENS[address].decimals) : 0n),
    balanceStatus: 'read_at_block',
    discoveredByProvider: false,
    requestedByAddress: address !== ETH,
  }));
  value.snapshot = SNAPSHOT;
  value.inventory = { ...value.inventory, retrievedAt: NOW - 5 };
  return value;
}

/**
 * read-v5 featured-pools: the five pools as today's list, made at 12:00 UTC the way the service makes it, each with
 * the figures it was ranked by. The template's clock is moved by whole days to today's. Under featured-policy v2
 * (read-v5 rc.2, 2026-09-28) a pool is ranked by today's APR (`rankApr` is `freshApr`), and depth is not measured.
 */
function featuredList() {
  const value = structuredClone(V5_TEMPLATE);
  const day = 86_400;
  const shift = Math.floor((NOW - day / 2) / day) * day + day / 2 - value.effectiveAt;
  for (const field of ['effectiveAt', 'generatedAt', 'validUntil']) value[field] += shift;
  value.window = { start: value.window.start + shift, end: value.window.end + shift };
  value.servedAt = Math.min(value.servedAt + shift, NOW - 60);
  value.selectionDate = new Date(value.effectiveAt * 1000).toISOString().slice(0, 10);
  value.withdrawn = [];
  const verifiedAt = { hash: SNAPSHOT.hash, number: HEAD - 3_600 };
  value.pools = POOLS.map((pool, index) => ({
    ageSource: 'provider_pool_created_at',
    identitySource: 'catalogue_event',
    initializeBlock: 2_580_000 + index * 1_000_000,
    integrationClass: 'hookless_fixed_fee',
    poolId: pool.poolId,
    poolKey: { currency0: pool.key.currency0, currency1: pool.key.currency1, feeMode: 'fixed', fee_pips: pool.fee, hooks: zeroAddress, tick_spacing: pool.tickSpacing },
    rankInputs: {
      evaluatedAt: value.generatedAt + 60,
      freshApr: Number(pool.apr).toFixed(1),
      prevApr: pool.yesterday,
      rankApr: Number(pool.apr).toFixed(1),
      referenceDepthUsd: null,
      reportedLiquidityUsd: pool.tvl,
      volume24hUsd: pool.volume,
    },
    slot: index + 1,
    source: 'ranked',
    tokens: [pool.key.currency0, pool.key.currency1].map((address) => ({ address, decimals: TOKENS[address].decimals, symbol: TOKENS[address].symbol })),
    verifiedAt,
  }));
  return value;
}

const ANSWERS = {
  v1: (route, body) => {
    if (route === 'token') return tokenAnswer(body);
    if (route === 'pools') return poolsOf(body);
    if (route === 'wallet-assets') return walletAssets(body);
    if (route === 'pool-market') {
      const pool = poolById(body.poolId);
      return pool ? poolMarket(pool, body) : undefined;
    }
    return undefined;
  },
  v2: (route, body) => {
    const pool = route === 'pool-market' ? poolById(body.poolId) : undefined;
    return pool ? poolMarketV2(pool) : undefined;
  },
  v5: (route) => (route === 'featured-pools' ? featuredList() : undefined),
};
const RUNTIMES = { v1: readV1, v2: readV2, v5: readV5 };
const VERSIONS = { v1: readV1.CONTRACT_VERSION, v2: readV2.CONTRACT_VERSION, v5: readV5.CONTRACT_VERSION };

/** Every answer this world gives, checked against its contract before any page sees it. */
export function checkAnswers() {
  const problems = [];
  const check = (version, route, value) => {
    if (!RUNTIMES[version].validateResponse(route, value)) problems.push(`${version} ${route}`);
  };
  for (const pool of POOLS) {
    check('v1', 'pool-market', poolMarket(pool));
    check('v1', 'pool-market', poolMarket(pool, { includePriceHistory: true, priceToken: 'base' }));
    check('v2', 'pool-market', poolMarketV2(pool));
  }
  for (const address of Object.keys(TOKENS)) check('v1', 'token', tokenAnswer({ token: address }));
  check('v1', 'pools', poolsOf({ token: USDG }));
  check('v1', 'pools', poolsOf({ token: USDG, maxPools: POOLS.length, poolIds: POOLS.map((pool) => pool.poolId) }));
  check('v1', 'wallet-assets', walletAssets({ tokens: [ETH, USDG] }));
  check('v5', 'featured-pools', featuredList());
  if (problems.length) throw new Error(`the made-up world's answers fail their contracts: ${problems.join(', ')}`);
}

const APP_ORIGIN = 'https://app.test';
const BRIDGE = {
  APP_ORIGIN,
  GATEWAY_ORIGIN: 'https://gateway.test',
  READ_BRIDGE_ENABLED: 'true',
  ENABLED_READS: 'token,pools,pool-market,wallet-assets',
  READ_V2_BRIDGE_ENABLED: 'true',
  ENABLED_V2_READS: 'pool-market',
  READ_V5_BRIDGE_ENABLED: 'true',
  ENABLED_V5_READS: 'featured-pools',
  ACCESS_CLIENT_ID: 'docs-world-client',
  ACCESS_CLIENT_SECRET: 'docs-world-secret',
};

/**
 * The read service of this world, as a wallet-server route: the unmodified read Worker, its gateway answered from the
 * world. A question the world has no answer for is the gateway's 404, which the page shows as it shows any missing read.
 */
export function createReadService() {
  const worker = createWorker({
    getClientIp: () => '198.51.100.44',
    fetch: async (url, init) => {
      const [, version, route] = /\/internal\/read\/(v\d)\/(.+)$/.exec(new URL(url).pathname) ?? [];
      const body = init.body ? JSON.parse(init.body) : {};
      const value = ANSWERS[version]?.(route, body);
      const headers = { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': VERSIONS[version] ?? '' };
      if (value === undefined) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers });
      return new Response(JSON.stringify(value), { status: 200, headers });
    },
  });
  return async (request, url) => {
    if (!url.pathname.startsWith('/api/read/')) return undefined;
    const headers = new Headers(request.headers);
    if (headers.get('origin') === url.origin) headers.set('origin', APP_ORIGIN);
    headers.delete('host');
    const body = request.method === 'GET' ? undefined : await request.text();
    return worker.fetch(new Request(new URL(`${url.pathname}${url.search}`, APP_ORIGIN), { method: request.method, headers, body }), BRIDGE);
  };
}

// ---- The Auto-compound position's fees history ----------------------------------------------------------------------

/** Blocks per second on Robinhood Chain as the fees pipeline counts them (HOUR_SPAN blocks an hour). */
const BLOCKS_PER_SECOND = feesLib.HOUR_SPAN / 3600;
const DAY = feesLib.DAY_SPAN;
/** The pool's life and the position's, in days: a position this much younger than its pool is read on the price path. */
const POOL_DAYS = 80;
const LIFE_DAYS = 18;

/** A seeded generator (mulberry32), so every run draws the same history. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const word = (value) => pad(numberToHex(BigInt.asUintN(256, BigInt(value))), { size: 32 });
const dataOf = (...words) => `0x${words.map((w) => w.slice(2)).join('')}`;

/**
 * The fees history of the Auto-compound position `tokenId` in ETH/USDG 0.30% (POSITIONS.compound), held by `owner`:
 * minted LIFE_DAYS ago in a pool made POOL_DAYS ago, with a Swap about every hour since, the price wandering around
 * 2,500 USDG per ETH and ending at the pool's price now (MAIN_POOL). The fees it has earned are what the fees
 * pipeline's own replay (lib/fees/replay.ts, the price path) makes of those Swaps, so the page verifies its history
 * against the chain: the position's unclaimed fees and the pool's price are given to the chain from the same replay.
 * `logs` answers browserChain's `history` (eth_getLogs of the PositionManager and the PoolManager), `header` a block's
 * header with its own time.
 *
 * The walk is shaped so that the replay leaves exactly the position's short fees (POSITIONS.compound.fees): its size
 * sets how much the price travels, so both tokens' fees together, and where it starts sets the ETH against the USDG
 * (a price that ends higher than it started paid more of its fees in USDG). Two knobs, two amounts: Newton's method on
 * the replay itself, until each amount sits just above its short figure.
 */
export function feeHistory({ tokenId, owner, now = NOW }) {
  const key = `${tokenId}|${owner}|${now}`;
  if (!histories.has(key)) histories.set(key, makeHistory({ tokenId, owner, now }));
  return histories.get(key);
}
const histories = new Map();

function makeHistory({ tokenId, owner, now }) {
  const { FeeReplay, Timeline } = replayLib();
  const pool = MAIN_POOL;
  const head = HEAD;
  const timeOf = (block) => now - Math.round((head - block) / BLOCKS_PER_SECOND);
  const initBlock = head - POOL_DAYS * DAY;
  const mintBlock = head - LIFE_DAYS * DAY + 12_345;
  const { tickLower, tickUpper, liquidity } = POSITIONS.compound;
  const poolLiquidity = liquidity * 40n;
  const salt = BigInt(tokenId);
  const hours = Math.floor((head - mintBlock) / feesLib.HOUR_SPAN);
  // One Swap in each hour of the life, somewhere inside it; one more in the last minutes, so the pool is busy now; one before the mint.
  const draw = random(4101);
  const blocks = [mintBlock - 1_800];
  for (let h = 0; h < hours; h += 1) blocks.push(mintBlock + 600 + h * feesLib.HOUR_SPAN + Math.floor(draw() * (feesLib.HOUR_SPAN - 1_200)));
  blocks.push(head - 6_000);
  const shocks = blocks.map(() => {
    // A normal draw (Box–Muller).
    const u = Math.max(draw(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * draw());
  });
  const end = Number(pool.sqrtPriceX96) / Number(Q96);
  /** The walk of √P with steps of `size`, bridged from `from` times the price now to exactly it. */
  const walk = (size, from) => {
    const steps = shocks.map((z) => z * size);
    const total = steps.reduce((a, b) => a + b, 0);
    const start = Math.log(end) + Math.log(Math.sqrt(from));
    let level = 0;
    return steps.map((step, i) => {
      level += step;
      const share = (i + 1) / steps.length;
      return i === steps.length - 1 ? pool.sqrtPriceX96 : BigInt(Math.round(Math.exp(start + (Math.log(end) - start) * share + level - total * share) * Number(Q96)));
    });
  };
  const swapOf = (block, index, price) =>
    [block, index, 3, word(block * 16 + index), [pool.poolId, word(`0x${'7e'.repeat(20)}`)], dataOf(word(0), word(0), word(price), word(poolLiquidity), word(tickAt(price)), word(pool.fee))];
  const build = ([size, from]) => {
    const prices = walk(size, from);
    const swaps = blocks.map((block, i) => swapOf(block, 3, prices[i]));
    const mint = [mintBlock, 2, 1, word(mintBlock * 16 + 2), [pool.poolId, word(feesLib.POSITION_MANAGER)], dataOf(word(tickLower), word(tickUpper), word(liquidity), word(salt))];
    const pool0 = [...swaps.slice(0, 1), mint, ...swaps.slice(1)];
    const grid = [];
    for (let b = Math.floor(blocks[0] / feesLib.HOUR_SPAN) * feesLib.HOUR_SPAN; b <= head; b += feesLib.HOUR_SPAN) grid.push([b, timeOf(b)]);
    grid.push([head, timeOf(head)]);
    const timeline = new Timeline(grid);
    const replay = FeeReplay.start({ tokenId: salt, tickLower, tickUpper, tickSpacing: pool.tickSpacing, fee: pool.fee, path: true, protocolFee: 0 }, 0n, 0);
    for (const log of pool0) replay.apply(log, timeline);
    return { compact: pool0, unclaimed: replay.owed(), price: replay.pool() };
  };
  // Each amount's short figure, and the unit of its sixth significant digit: an amount in [figure, figure + unit / 2)
  // reads the figure, whether the app rounds or cuts it. The aim is a quarter of a unit above it.
  const decimals = [TOKENS[pool.key.currency0].decimals, TOKENS[pool.key.currency1].decimals];
  const goal = POSITIONS.compound.fees.map((text, i) => {
    const figure = rawOf(text, decimals[i]);
    const unit = 10n ** BigInt(Math.max(0, String(figure).length - 6));
    return { figure, unit, aim: Number(figure) + Number(unit) / 4 };
  });
  const reads = (made) => made.unclaimed.every((owed, i) => owed >= goal[i].figure && owed < goal[i].figure + goal[i].unit / 2n);
  let knobs = [0.0035, 0.972];
  let made = build(knobs);
  for (let round = 0; !reads(made); round += 1) {
    if (round === 40) throw new Error(`the fees history cannot be shaped to ${POSITIONS.compound.fees.join(' and ')}: ${made.unclaimed.join(', ')}`);
    const at = made.unclaimed.map(Number);
    const steps = [knobs[0] * 1e-4, 1e-5];
    const moved = steps.map((h, k) => build(knobs.map((value, j) => (j === k ? value + h : value))).unclaimed.map(Number));
    // The Jacobian of the two fees in the two knobs, and the step that closes the gap to the aim.
    const [[a, b], [c, d]] = [0, 1].map((i) => [0, 1].map((k) => (moved[k][i] - at[i]) / steps[k]));
    const [r0, r1] = [goal[0].aim - at[0], goal[1].aim - at[1]];
    const det = a * d - b * c;
    knobs = [knobs[0] + (r0 * d - b * r1) / det, knobs[1] + (a * r1 - c * r0) / det];
    made = build(knobs);
  }
  const TOPICS = [feesLib.TOPIC.Initialize, feesLib.TOPIC.ModifyLiquidity, feesLib.TOPIC.ProtocolFeeUpdated, feesLib.TOPIC.Swap, feesLib.TOPIC.Donate, feesLib.TOPIC.Transfer];
  const rpcOf = ([block, index, event, tx, topics, data]) => ({
    address: event === 5 ? feesLib.POSITION_MANAGER : feesLib.POOL_MANAGER,
    topics: [TOPICS[event], ...topics],
    data,
    blockNumber: numberToHex(block),
    logIndex: numberToHex(index),
    transactionHash: tx,
    blockHash: `0x${'cd'.repeat(32)}`,
    transactionIndex: '0x0',
    removed: false,
  });
  const initialize = [initBlock, 0, 0, word(initBlock * 16), [pool.poolId, word(pool.key.currency0), word(pool.key.currency1)], dataOf(word(pool.fee), word(pool.tickSpacing), word(0), word(sqrtOfPrice('2310', 18, 6)), word(tickAt(sqrtOfPrice('2310', 18, 6))))];
  const transfer = [mintBlock, 1, 5, word(mintBlock * 16 + 2), [word(0), word(owner), word(salt)], '0x'];
  const logs = [initialize, transfer, ...made.compact].map(rpcOf).sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex));
  const match = (want, got) => want == null || (Array.isArray(want) ? want.map((w) => String(w).toLowerCase()).includes(got) : String(want).toLowerCase() === got);
  return {
    head,
    timestamp: timeOf(head),
    mintBlock,
    unclaimed: made.unclaimed,
    sqrtPriceX96: made.price.price,
    tick: made.price.tick,
    /** browserChain's `history`: the logs of these two contracts that match the filter, null for any other contract. */
    logs(filter, from, to) {
      const addresses = (Array.isArray(filter.address) ? filter.address : [filter.address]).map((address) => String(address).toLowerCase());
      if (!addresses.some((address) => address === feesLib.POSITION_MANAGER || address === feesLib.POOL_MANAGER)) return null;
      const topics = filter.topics ?? [];
      return logs.filter((log) => addresses.includes(log.address) && Number(log.blockNumber) >= from && Number(log.blockNumber) <= to && [0, 1, 2, 3].every((i) => match(topics[i], log.topics[i])));
    },
    header: (block) => ({ number: numberToHex(block), timestamp: numberToHex(timeOf(block)), hash: `0x${'4e'.repeat(32)}` }),
  };
}

