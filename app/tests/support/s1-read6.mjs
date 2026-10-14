/**
 * TEST-ONLY. read-v6 `1.0.0-rc.1` answers (spec F7 rev2 §6.2) for the S1 browser suites, built on the package's own
 * valid fixtures (api-contracts/read-v6/fixtures/valid) with this suite's wallet, positions, vaults and receipts, and
 * held to the package's validator before any test uses them (`validated`): what the page reads is always an answer the
 * contract accepts. Nothing here reaches a network.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as runtime from '../../../api-contracts/read-v6/runtime.mjs';
import { CONSTANTS } from '../../../api-contracts/read-v6/schema-data.mjs';

const require = createRequire(import.meta.url);
const PORTFOLIO = require('../../../api-contracts/read-v6/fixtures/valid/portfolio.json');
const ACTIVITY = require('../../../api-contracts/read-v6/fixtures/valid/activity.json');
const ZERO = '0x0000000000000000000000000000000000000000';
const clone = (value) => JSON.parse(JSON.stringify(value));
const lower = (value) => String(value).toLowerCase();

/** The three chains, all current (the fixture's Robinhood status, per chain). */
function chains() {
  const current = PORTFOLIO.chains.find((c) => c.status === 'current');
  return [4663, 8453, 42161].map((chainId) => ({ ...clone(current), chainId, deployment: { ...current.deployment, manifestSha256: chainId.toString(16).padStart(64, '0') } }));
}

/**
 * Added 2026-10-14 (package V1's suites): a Chainlink ETH/USD price for a Domino chain's native ETH, read `at` (Unix
 * seconds), in the shape the contract's own rules accept (runtime.mjs tokenPrice and priced: its chain's feed, a round
 * inside the heartbeat, no pool).
 */
export function ethUsdPrice(chainId, usd, at = Math.floor(Date.now() / 1000)) {
  return {
    source: 'chainlink_eth_usd', usd, pool: null, depthUsd: null,
    snapshot: { number: 73_399_900, hash: '0x' + 'de'.repeat(32), timestamp: at },
    ethUsd: { feed: CONSTANTS.priceProfiles[chainId].feed, roundId: '110680464442257320001', updatedAt: at - 60, usd },
  };
}

/** A token as read-v6 names it (symbol untrusted, decimals as read). */
export const indexedToken = (chainId, address, symbol, decimals) => ({ chainId, address: lower(address), status: 'available', decimals, symbol, price: null, priceReason: 'no_qualified_price_source' });

/** A position read live at a block: `custody`, `vault`, fees and principal as given. */
export function livePosition({ chainId = 4663, dex = 4, manager, tokenId, owner, pool, tickLower, tickUpper, liquidity, sqrtPriceX96, tick, feesOwed = ['0', '0'], principal = ['0', '0'], approved = null, subscriber = null, vault = null, stale = false }) {
  return {
    chainId, dex, positionManager: lower(manager), tokenId: String(tokenId), firstSeenBlock: 73_390_000,
    vault: vault ? { address: lower(vault.address), role: vault.role } : null,
    state: {
      status: 'live', snapshot: { number: 73_399_500, hash: '0x' + 'ff'.repeat(32), timestamp: Math.floor(Date.now() / 1000) - 60 },
      freshness: { ageSeconds: 60, status: stale ? 'stale' : 'fresh' }, owner: lower(owner),
      custody: { approved: approved === null ? null : lower(approved), subscriber: dex === 3 ? null : (subscriber === null ? null : lower(subscriber)) },
      pool: { dex, currency0: lower(pool.currency0), currency1: lower(pool.currency1), fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: lower(pool.hooks ?? ZERO) },
      tickLower, tickUpper, liquidity: String(liquidity), sqrtPriceX96: String(sqrtPriceX96), tick,
      inRange: tickLower <= tick && tick < tickUpper, feesOwed: feesOwed.map(String), principalAtSpot: principal.map(String),
    },
  };
}

/** A vault of `wallet` with its root, read, armed or not, holding `reserves` ([total0, total1] in the pool's order). */
export function vaultOf({ wallet, chainId = 4663, address, rootTokenId, pool, reserves = ['0', '0'], armed = true }) {
  const template = clone(PORTFOLIO.vaults[0]);
  const tokens = [lower(pool.currency0), lower(pool.currency1)];
  const state = {
    ...template.state,
    pool: { dex: pool.dex, currency0: tokens[0], currency1: tokens[1], fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: lower(pool.hooks ?? ZERO) },
    quoteCurrency: tokens[1],
    rootArmed: armed,
    members: [{ ...template.state.members[0], tokenId: String(rootTokenId), successorTokenId: null, lots: tokens.map((token) => ({ token, charged: '0', uncharged: '0' })) }],
    reserves: tokens.map((token, i) => ({ token, total: String(reserves[i]), idle: '0' })),
  };
  return {
    ...template, chainId, dex: pool.dex, address: lower(address), owner: lower(wallet), rootTokenId: String(rootTokenId), state,
    custody: armed ? { armed: true, reason: null, since: null, source: null } : { armed: false, reason: 'changed_outside_domino', since: template.created, source: 'event' },
    members: [{ disarmReason: armed ? null : 'changed_outside_domino', parentTokenId: null, role: 'root', status: armed ? 'armed' : 'disarmed', tokenId: String(rootTokenId) }],
    waiting: null,
  };
}

/** The wallet's portfolio: positions, tokens (sorted as the contract requires) and vaults; no mandates, no credits. */
export function portfolioOf({ wallet, positions = [], tokens = [], vaults = [] }) {
  const body = clone(PORTFOLIO);
  body.wallet = lower(wallet);
  body.servedAt = Math.floor(Date.now() / 1000);
  body.chains = chains();
  body.coverage = 'complete';
  body.tokens = [...tokens].sort((a, b) => (`${String(a.chainId).padStart(20, '0')}:${a.address}` < `${String(b.chainId).padStart(20, '0')}:${b.address}` ? -1 : 1));
  body.positions = positions;
  body.vaults = vaults;
  body.mandates = [];
  body.credits = [];
  body.truncated = { mandates: false, positions: false, vaults: false };
  return validated('portfolio', body);
}

/** An S1 receipt as read-v6 lists it (an `s1_action` item). */
export function s1Action({ chainId = 4663, block = 73_393_000, logIndex = 3, wallet, zap, action = 'create', tokenId, previousTokenId = null, pool, inputs = [], legs = [], tariffs = [], refunds = [], finalized = true }) {
  const item = clone(ACTIVITY.items.find((i) => i.kind === 's1_action'));
  return {
    ...item, id: `${chainId}:${block}:${logIndex}`, chainId, zap: lower(zap), action, owner: lower(wallet), recipient: lower(wallet),
    tokenId: String(tokenId), previousTokenId: action === 'create' ? null : String(previousTokenId ?? tokenId), liquidity: '1000000000000000',
    inputs, legs, tariffs, refunds: refunds.map((r) => ({ ...r, recipient: lower(wallet) })),
    steps: [{ tokenId: String(tokenId), pool: { dex: pool.dex, currency0: lower(pool.currency0), currency1: lower(pool.currency1), fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: lower(pool.hooks ?? ZERO) }, liquidityDelta: '1000000000000000', amount0: '-1', amount1: '-1' }],
    tx: { ...item.tx, finality: finalized ? 'finalized' : 'unfinalized', snapshot: { ...item.tx.snapshot, number: block } },
  };
}

/** The wallet's receipts page. */
export function activityOf({ wallet, items = [] }) {
  const body = clone(ACTIVITY);
  body.wallet = lower(wallet);
  body.servedAt = Math.floor(Date.now() / 1000);
  body.chains = chains().map((c) => ({ ...c, finalizedThrough: { ...c.finalizedThrough, number: 73_395_500 } }));
  body.coverage = 'complete';
  body.tokens = [];
  body.items = items;
  body.nextCursor = null;
  return validated('activity', body);
}

function validated(route, body) {
  assert.ok(runtime.validateResponse(route, body), `the ${route} answer the suite built is the contract's`);
  return { status: 200, body };
}
