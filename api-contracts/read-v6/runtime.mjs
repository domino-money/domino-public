// read-v6, the Domino V2 wallet reads: the closed schemas (schema-data.mjs,
// generated from backend/v2_read_contract.py) plus every cross-field rule the
// producer's models enforce. A validator accepts exactly what the producer
// accepts; fixtures/ holds both sides to it. No fetch, no wallet, no signing.
import { SCHEMAS, ERRORS, CONSTANTS } from './schema-data.mjs';
import { createContractValidators } from '../shared/closed-schema.mjs';

export const CONTRACT_VERSION = '1.1.0-rc.1';
// 1.2.0-rc.1's window (launch round P3, 4 Nov 2026): it adds position-fees and changes no 1.1.0-rc.1 answer but its
// version. The reader answers each request in the version it names (X-Domino-Read-Contract), so this package's
// version, ROUTES and fixtures/valid stay 1.1.0-rc.1's, what the app and the read Worker read today; an answer may
// carry either version; position-fees, NEXT_ROUTES, is 1.2.0-rc.1's alone (fixtures/1.2.0-rc.1/). Closing the window
// makes NEXT_VERSION this package's.
export const CONTRACT_VERSIONS = Object.freeze([...CONSTANTS.contractVersions]);
export const NEXT_VERSION = CONSTANTS.nextVersion;
export const NEXT_ROUTES = Object.freeze([...CONSTANTS.nextRoutes]);
export const ROUTES = Object.freeze(Object.keys(SCHEMAS).filter((route) => !NEXT_ROUTES.includes(route)));
export const ERROR_STATUS_BY_CODE = Object.freeze({ ...ERRORS });

const ZERO = '0x' + '0'.repeat(40);
const I255 = 1n << 255n;
const CURSOR = /^([0-9]{1,19})\.([1-9][0-9]{0,18})\.([0-9]{1,19})\.([0-9]{1,10})$/u;
const RATES = { assisted_swap: [65], auto_exit: [20], automation: [200, 400, null] };
// `reverted_` and a V2 contract error's name in snake case -> the name.
const ERROR_BY_REASON = Object.freeze(Object.fromEntries(CONSTANTS.v2Errors.map((name) =>
  ['reverted_' + name.replace(/(?<!^)(?=[A-Z])/gu, '_').toLowerCase(), name])));
const errorOf = (reason) => (Object.hasOwn(ERROR_BY_REASON, reason) ? ERROR_BY_REASON[reason] : null);

// Python's str.isprintable: no control, format, surrogate, private-use or
// unassigned code point, and no separator but the ASCII space.
const printable = (text) => [...text].every((ch) => ch === ' ' || !/[\p{C}\p{Z}]/u.test(ch));
const signed = (value) => { const n = BigInt(value); return n >= -I255 && n < I255; };
const kinds = (tariffs, kind) => tariffs.every((t) => t.kind === kind);

function cursorKey(cursor) {
  const match = CURSOR.exec(cursor);
  if (!match) return null;
  const [timestamp, chain, block, index] = match.slice(1).map(BigInt);
  if (!CONSTANTS.chainIds.includes(Number(chain)) || timestamp > (1n << 63n) - 1n || block > (1n << 63n) - 1n ||
      index > (1n << 31n) - 1n) return null;
  return [timestamp, chain, block, index];
}

function chainStatus(c) {
  const indexed = c.indexedThrough !== null;
  if ((c.status === 'current') !== (c.reason === null)) return false;
  if ((c.deployment === null) !== (c.reason === 'deployment_not_registered')) return false;
  if (indexed === ['deployment_not_registered', 'never_indexed'].includes(c.reason)) return false;
  if ((c.lagBlocks === null) !== (!indexed || c.head === null)) return false;
  if ((c.lagSeconds === null) !== (c.lagBlocks === null)) return false;
  if ((c.automationHalted === null) === indexed || (c.operatorsAdmitted === null) === indexed) return false;
  return !(c.finalizedThrough !== null && c.deployment === null);
}

// Qualified USD (0xdecimal's item 4): a wire decimal as an integer of its smallest unit.
const fixed = (text) => BigInt(text.replace('.', ''));

function tokenPrice(p) {
  const stable = p.source === 'chain_stable';
  const fromPool = p.source === 'pool';
  if (stable === (p.snapshot !== null) || fromPool !== (p.pool !== null) || fromPool !== (p.depthUsd !== null) ||
    fixed(p.usd) === 0n) return false;
  if (stable && (fixed(p.usd) !== 10n ** 18n || p.ethUsd !== null)) return false;
  if (p.source === 'chainlink_eth_usd' && (p.ethUsd === null || p.ethUsd.usd !== p.usd)) return false;
  if (p.ethUsd !== null && p.ethUsd.updatedAt > p.snapshot.timestamp) return false;
  return !(fromPool && (p.pool.hooks !== ZERO || fixed(p.depthUsd) < fixed(CONSTANTS.priceFloorUsd)));
}

// A token's price or its reason, as its chain's profile allows (v2_read_contract.priced): a Domino chain's, or for
// chain-balances a balance chain's (Ethereum, OP Mainnet), each with its own stable, wrapped token, feed and heartbeat.
// A profile without a feed (`nativePool`) prices the native currency and its wrapped token at that pool alone, and no
// price there carries a feed's round.
function priced(chainId, token, price, reason) {
  if ((price === null) === (reason === null)) return false;
  if (price === null) return true;
  const profile = CONSTANTS.priceProfiles[chainId];
  const eth = [ZERO, profile.wrapped];
  const native = profile.nativePool ?? null;
  if ((price.source === 'chain_stable') !== (token === profile.stable) ||
    (price.source === 'chainlink_eth_usd') !== (native === null && eth.includes(token))) return false;
  if (native !== null && eth.includes(token)) {
    return price.source === 'pool' && price.ethUsd === null && price.pool !== null &&
      Object.keys(native).every((k) => price.pool[k] === native[k]);
  }
  if (price.pool !== null) {
    const pair = [price.pool.currency0, price.pool.currency1];
    const partner = pair[0] === token ? pair[1] : pair[1] === token ? pair[0] : null;
    if (![profile.stable, ...eth].includes(partner) ||
      (price.ethUsd !== null) !== (native === null && eth.includes(partner))) return false;
  }
  return !(price.ethUsd !== null && (price.ethUsd.feed !== profile.feed ||
    price.snapshot.timestamp - price.ethUsd.updatedAt > profile.heartbeatSeconds));
}

function token(t) {
  if (t.symbol !== null && !printable(t.symbol)) return false;
  if (t.status === 'available' && (t.decimals === null || t.symbol === null)) return false;
  return !(['unavailable', 'not_read'].includes(t.status) && (t.decimals !== null || t.symbol !== null));
}

function member(m) {
  const root = m.role === 'root';
  if (root !== (m.parentTokenId === null)) return false;
  if (root ? !['armed', 'disarmed', 'exited'].includes(m.status) : !['active', 'withdrawn', 'exited'].includes(m.status)) {
    return false;
  }
  return (m.status === 'disarmed') === (m.disarmReason !== null);
}

function vaultRead(v) {
  const tokens = [v.pool.currency0, v.pool.currency1].join();
  return v.reserves.map((r) => r.token).join() === tokens &&
    v.members.every((m) => m.lots.map((lot) => lot.token).join() === tokens);
}

function custody(c) {
  if ((c.reason === null) !== (c.source === null) || (c.since !== null) !== (c.source === 'event')) return false;
  return !(c.armed === true && c.source === 'live_read');
}

function waitingReport(r) {
  const read = r.status === 'reporting' || r.status === 'stale';
  if ([r.block, r.timestamp, r.ageSeconds].some((value) => (value !== null) !== read)) return false;
  return !read || (r.status === 'stale') === (r.ageSeconds > CONSTANTS.waitingStaleSeconds);
}

function vault(v) {
  const read = v.state.status === 'read';
  if (read ? v.custody.armed !== v.state.rootArmed : v.custody.armed !== null) return false;
  return (v.pausedBy !== null) === (read && v.state.paused);
}

function mandate(m) {
  if ((m.status === 'revoked') !== (m.revoked !== null) || (m.status === 'executed') !== (m.executed !== null)) return false;
  if (m.waiting !== null && m.status !== 'active') return false;
  if ((m.expired && m.status !== 'active') || (m.status !== 'active' && m.blockedBy.length)) return false;
  if (m.vaultIsDomino !== (m.moduleEnabled !== null)) return false;
  const order = CONSTANTS.blockers.filter((b) => m.blockedBy.includes(b));
  if (order.join() !== m.blockedBy.join() || m.expired !== m.blockedBy.includes('expired')) return false;
  if (m.blockedBy.includes('module_disabled') !== (m.moduleEnabled === false && m.status === 'active')) return false;
  if (m.blockedBy.includes('vault_not_domino') !== (!m.vaultIsDomino && m.status === 'active')) return false;
  return m.vaultIsDomino || m.position === 'unknown';
}

function terms(t) {
  if (t.triggerBelowSqrtPriceX96 === null && t.triggerAboveSqrtPriceX96 === null) return false;
  return (t.receive === 'converted') === (t.convertTo !== null);
}

function autoExitEvent(e) {
  const fields = ['mandateHash', 'vault', 'tokenId', 'validUntil', 'nonce', 'token', 'recipient', 'amount'];
  const expected = {
    MandateRegistered: ['mandateHash', 'vault', 'tokenId', 'validUntil'], MandateRevoked: ['mandateHash', 'vault'],
    NonceCancelled: ['nonce'], Claimed: ['token', 'recipient', 'amount'],
  }[e.event];
  return fields.filter((name) => e[name] !== null).join() === expected.join();
}

function envelope(body) {
  if (body.chains.map((c) => c.chainId).join() !== CONSTANTS.chainIds.join()) return false;
  if ((body.coverage === 'complete') !== body.chains.every((c) => c.status === 'current')) return false;
  if (body.limitations.join() !== CONSTANTS.limitations.join()) return false;
  const keys = body.tokens.map((t) => `${String(t.chainId).padStart(20, '0')}:${t.address}`);
  return keys.every((key, index) => index === 0 || key > keys[index - 1]);
}

function portfolio(body) {
  if (!envelope(body)) return false;
  if (body.vaults.some((v) => v.owner !== body.wallet) || body.mandates.some((m) => m.owner !== body.wallet)) return false;
  const reporting = Object.fromEntries(body.chains.map((c) => [c.chainId,
    ['reporting', 'stale'].includes(c.waitingReasons.status)]));
  if ([...body.vaults, ...body.mandates].some((entry) => entry.waiting !== null && !reporting[entry.chainId])) {
    return false;
  }
  const halted = Object.fromEntries(body.chains.map((c) => [c.chainId, c.automationHalted]));
  return body.mandates.every((m) => m.expired === (m.status === 'active' && m.validUntil < body.servedAt) &&
    m.blockedBy.includes('automation_halted') === (m.status === 'active' && m.vaultIsDomino && halted[m.chainId] === true));
}

function activity(body) {
  if (!envelope(body)) return false;
  const ids = body.items.map((item) => item.id);
  if (new Set(ids).size !== ids.length) return false;
  const keys = body.items.map((item) => [BigInt(item.tx.snapshot.timestamp), BigInt(item.chainId),
    BigInt(item.tx.snapshot.number), BigInt(item.id.split(':')[2])]);
  for (let i = 1; i < keys.length; i += 1) {
    const [a, b] = [keys[i - 1], keys[i]];
    const order = a.findIndex((value, index) => value !== b[index]);
    if (order === -1 || a[order] < b[order]) return false;
  }
  const finalized = Object.fromEntries(body.chains.map((c) => [c.chainId, c.finalizedThrough]));
  return body.items.every((item) => {
    const [chain, block] = item.id.split(':');
    const final = finalized[item.chainId];
    return Number(chain) === item.chainId && Number(block) === item.tx.snapshot.number &&
      (item.tx.finality === 'finalized') === (final !== null && item.tx.snapshot.number <= final.number) &&
      !(item.kind === 'reserves_returned' && item.returnedBy === body.wallet); // the owner's own are vault_event
  }) && (body.nextCursor === null || cursorKey(body.nextCursor) !== null);
}

// ------------------------------------------------------------ chain reads
const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const ascending = (values) => values.every((value, index) => index === 0 || values[index - 1] < value);
const unique = (values) => new Set(values).size === values.length;

function liveToken(t) {
  if (t.symbol !== null && !printable(t.symbol)) return false;
  return (t.decimals !== null) + (t.symbol !== null) === { available: 2, partial: 1, unavailable: 0 }[t.status];
}

function livePool(p) {
  const v4 = p.pool.dex === 4;
  if (v4 !== (p.id !== null) || v4 === (p.address !== null) || p.pool.hooks !== ZERO) return false;
  if (p.lpFeePips !== p.pool.fee || BigInt(p.liquidity) === 0n || BigInt(p.sqrtPriceX96) === 0n) return false;
  let fees;
  if (v4) {
    const sides = [p.protocolFee & 0xfff, p.protocolFee >> 12];
    if (sides.some((side) => side > 1000)) return false;
    fees = sides.map((side) => (side === 0 ? p.lpFeePips :
      side + p.lpFeePips - Math.floor((side * p.lpFeePips) / 1_000_000)));
  } else {
    if (p.protocolFee > 0xff) return false;
    fees = [p.lpFeePips, p.lpFeePips];
  }
  return p.swapFeePips.zeroForOne === fees[0] && p.swapFeePips.oneForZero === fees[1];
}

function fresh(body) {
  const age = Math.max(0, body.servedAt - body.snapshot.timestamp);
  return body.freshness.ageSeconds === age && (body.freshness.status === 'fresh') === (age <= CONSTANTS.liveFreshSeconds);
}

function chainPools(body) {
  if (!same(body.limitations, CONSTANTS.liveLimitations) || !fresh(body)) return false;
  const addresses = body.tokens.map((t) => t.address);
  if (!ascending(addresses) || !addresses.includes(body.token) || body.pairedToken === body.token ||
    (body.pairedToken !== null && !addresses.includes(body.pairedToken))) return false;
  const keys = new Set();
  for (const item of body.pools) {
    const pair = [item.pool.currency0, item.pool.currency1];
    if (!pair.includes(body.token) || (body.pairedToken !== null && !pair.includes(body.pairedToken))) return false;
    if (!pair.every((currency) => addresses.includes(currency))) return false;
    const key = [item.pool.dex, ...pair, item.pool.fee, item.pool.tickSpacing].join(':');
    if (keys.has(key)) return false;
    keys.add(key);
    const profile = CONSTANTS.priceProfiles[body.chainId];
    const reference = item.market.reference;
    if (reference !== null && (!pair.includes(reference) || reference === body.token ||
      ![profile.stable, ZERO, profile.wrapped].includes(reference))) return false;
  }
  return body.tokens.every((t) => priced(body.chainId, t.address, t.price, t.priceReason));
}

function chainBalances(c) {
  const current = c.status === 'current';
  if (current !== (c.snapshot !== null) || current === (c.reason !== null)) return false;
  if (!current && c.balances.some((b) => b.status !== 'unavailable')) return false;
  if (!unique(c.balances.map((b) => b.address))) return false;
  if (!c.balances.every((b) => priced(c.chainId, b.address, b.price, b.priceReason))) return false;
  const values = c.balances.filter((b) => b.balanceRaw !== '0').map((b) => b.valueUsd);
  return (c.totalUsd !== null) === !values.includes(null) &&
    (c.totalUsd === null || fixed(c.totalUsd) === values.reduce((sum, value) => sum + fixed(value), 0n));
}

function knownToken(t) {
  if (!printable(t.symbol) || (t.name !== null && !printable(t.name))) return false;
  const order = CONSTANTS.tokenSources;
  return same(t.sources, [...new Set(t.sources)].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
}

// ---------------------------------------------------------- position fees (1.2.0-rc.1)
const ascendingPairs = (pairs) => pairs.every((pair, index) => index === 0 ||
  pairs[index - 1][0] < pair[0] || (pairs[index - 1][0] === pair[0] && pairs[index - 1][1] < pair[1]));
const sameBlock = (a, b) => a.number === b.number && a.hash === b.hash && a.timestamp === b.timestamp;

function feeFollower(f) {
  if ((f.status === 'current') !== (f.reason === null)) return false;
  if ((f.through === null) !== (f.reason === 'fees_not_followed') || (f.status === 'unavailable') !== (f.through === null)) {
    return false;
  }
  if ((f.lagSeconds === null) !== (f.through === null || f.indexedThrough === null)) return false;
  return !(f.through !== null && f.indexedThrough !== null && f.through.number > f.indexedThrough.number);
}

function feeSettlement(e) {
  if ((e.fees === null) !== (e.why !== null) || (e.settled !== null && e.fees === null)) return false;
  if (e.auto !== (e.serviceFee !== null)) return false;
  if (e.logIndexes.at(-1) !== e.logIndex || !e.logIndexes.every((index, i) => i === 0 || e.logIndexes[i - 1] < index)) {
    return false;
  }
  const delta = BigInt(e.liquidityDelta);
  return e.kind === (delta > 0n ? 'increase' : delta < 0n ? 'decrease' : 'collect');
}

function feePoint(p) {
  if (p.hour % 3600 !== 0 || (p.kind === 'day') !== (p.hour % 86400 === 0)) return false;
  if ((p.earned === null) !== (p.settled === null)) return false;
  return p.earned === null || p.earned.every((earned, i) => BigInt(earned) >= BigInt(p.settled[i]));
}

function feeNow(n) {
  const v4 = n.pool.dex === 4;
  if (v4 !== (n.poolId !== null) || v4 === (n.poolAddress !== null) || v4 === (n.tokensOwed !== null)) return false;
  if (n.tickLower >= n.tickUpper || n.inRange !== (n.tickLower <= n.tick && n.tick < n.tickUpper)) return false;
  if ((n.earned === null) !== (n.settled === null) || (n.unsettled === null && n.earned !== null)) return false;
  return n.earned === null ||
    n.earned.every((earned, i) => BigInt(earned) === BigInt(n.settled[i]) + BigInt(n.unsettled[i]));
}

function positionFees(p) {
  const followed = p.status !== 'not_followed';
  const read = p.since !== null || p.events.length > 0 || p.transfers.length > 0 || p.points.length > 0;
  // A position the follower has not joined yet (a pass away) is reading with nothing read.
  if ((p.through === null) !== (p.status === 'not_followed' || (p.status === 'reading' && !read)) ||
    (p.through === null) !== (p.freshness === null)) return false;
  if (!followed && (read || p.why !== null || p.truncated)) return false;
  if ((p.now !== null) !== (p.status === 'following')) return false;
  if ((p.status === 'reading') !== (p.why === 'reading')) return false;
  if (p.status === 'following' || p.status === 'burned') {
    if (p.since === null) return false;
    if (p.exact !== !['same_block', 'liquidity'].includes(p.why) || (p.exact && p.events.some((e) => e.why !== null))) {
      return false;
    }
    if ((p.why === 'before_floor') !== (p.exact && p.since !== null && p.since.kind === 'floor')) return false;
  } else if (p.exact) return false;
  const settlements = p.events.map((e) => [e.block.number, e.logIndex]);
  const moves = p.transfers.map((t) => [t.block.number, t.logIndex]);
  if (!ascendingPairs(settlements) || !ascendingPairs(moves) ||
    !p.points.every((point, i) => i === 0 || p.points[i - 1].block < point.block)) return false;
  if (p.through !== null) {
    const last = p.through.number;
    if (settlements.some(([n]) => n > last) || moves.some(([n]) => n > last) || p.points.some((x) => x.block > last)) {
      return false;
    }
  }
  if (p.since !== null) {
    const first = p.since.block.number;
    if (settlements.some(([n]) => n < first) || p.points.some((x) => x.block < first)) return false;
  }
  if (p.now !== null && (!sameBlock(p.now.snapshot, p.through) || p.now.pool.dex !== p.dex)) return false;
  return !(p.status === 'burned' && (p.transfers.length === 0 || p.transfers.at(-1).toAddress !== ZERO));
}

function positionFeesResponse(b) {
  if (b.limitations.join() !== CONSTANTS.feeLimitations.join()) return false;
  const keys = b.positions.map((p) => `${p.dex}:${p.tokenId}`);
  if (new Set(keys).size !== keys.length) return false;
  const events = Math.floor(CONSTANTS.maxFeeEvents / b.positions.length);
  const points = Math.floor(CONSTANTS.maxFeePoints / b.positions.length);
  if (b.positions.some((p) => p.events.length > events || p.points.length > points)) return false;
  for (const p of b.positions) {
    if (p.through !== null && (b.follower.through === null || p.through.number > b.follower.through.number)) return false;
    if (p.freshness !== null) {
      const age = Math.max(0, b.servedAt - p.through.timestamp);
      if (p.freshness.ageSeconds !== age || (p.freshness.status === 'fresh') !== (age <= CONSTANTS.feeFreshSeconds)) {
        return false;
      }
    }
  }
  return !(b.follower.status === 'unavailable' && b.positions.some((p) => p.status !== 'not_followed'));
}

function semantic(name, value) {
  switch (name) {
    case 'PoolRef': return value.currency0 < value.currency1 && !(value.dex === 3 && value.hooks !== ZERO);
    case 'IndexedToken': return token(value) && priced(value.chainId, value.address, value.price, value.priceReason);
    case 'TokenPrice': return tokenPrice(value);
    case 'PoolMarket': {
      const measured = value.status === 'measured';
      return measured === (value.reference !== null) && measured === (value.depthUsd !== null) &&
        measured !== (value.reason !== null);
    }
    case 'ChainStatus': return chainStatus(value);
    case 'WaitingReport': return waitingReport(value);
    case 'WaitingRevert': return value.error === errorOf(value.reason);
    case 'Waiting': return value.error === errorOf(value.reason) && value.since <= value.checkedAt &&
      value.sinceBlock <= value.checkedBlock;
    case 'Member': return member(value);
    case 'Reserve': return BigInt(value.idle) <= BigInt(value.total);
    case 'VaultRead': return vaultRead(value);
    case 'Custody': return custody(value);
    case 'Vault': return vault(value);
    case 'PositionLive': return value.tickLower < value.tickUpper &&
      value.inRange === (value.tickLower <= value.tick && value.tick < value.tickUpper) &&
      !(value.pool.dex === 3 && value.custody.subscriber !== null);
    case 'Position': return value.state.status !== 'live' || value.state.pool.dex === value.dex;
    case 'MandateTerms': return terms(value);
    case 'Mandate': return mandate(value);
    case 'Tariff': return BigInt(value.deferred) <= BigInt(value.amount) && RATES[value.kind].includes(value.rateBps);
    case 'Step': return signed(value.liquidityDelta) && signed(value.amount0) && signed(value.amount1);
    case 'S1Action': return !(value.tariffs.length && !value.legs.length) && kinds(value.tariffs, 'assisted_swap') &&
      (value.action === 'create') === (value.previousTokenId === null);
    case 'VaultExecution': return (value.action === 'mint') === (value.successor !== null) &&
      kinds(value.tariffs, 'automation');
    case 'AutoExit': return kinds(value.tariffs, 'auto_exit');
    case 'ReservesReturned': return value.tx.gas !== null && value.tx.gas.sender === value.returnedBy &&
      new Set(value.reservesReturned.map((line) => line.token)).size === value.reservesReturned.length;
    case 'AutoExitEvent': return autoExitEvent(value);
    case 'ActivityPageRequest': return value.cursor === undefined || value.cursor === null || cursorKey(value.cursor) !== null;
    case 'PortfolioResponse': return portfolio(value);
    case 'ActivityResponse': return activity(value);
    case 'LiveToken': return liveToken(value);
    case 'LivePool': return livePool(value);
    case 'ChainPoolsResponse': return chainPools(value);
    case 'TokenBalance': {
      const valued = value.balanceRaw !== null && value.decimals !== null && value.price !== null;
      return (value.symbol === null || printable(value.symbol)) &&
        (value.status === 'read') === (value.balanceRaw !== null) && valued === (value.valueUsd !== null) &&
        (!valued || fixed(value.valueUsd) ===
          BigInt(value.balanceRaw) * fixed(value.price.usd) / 10n ** BigInt(value.decimals + 12));
    }
    case 'ChainBalances': return chainBalances(value);
    case 'ChainBalancesResponse': {
      // Chains are summed only when every one has its total (the owner, 2 Oct: §6.3's multi-chain rules).
      const totals = value.chains.map((c) => c.totalUsd);
      return same(value.limitations, CONSTANTS.liveLimitations) && ascending(value.chains.map((c) => c.chainId)) &&
        (value.coverage === 'complete') === value.chains.every((c) => c.status === 'current') &&
        (value.totalUsd !== null) === !totals.includes(null) &&
        (value.totalUsd === null || fixed(value.totalUsd) === totals.reduce((sum, total) => sum + fixed(total), 0n));
    }
    case 'KnownToken': return knownToken(value);
    case 'ChainTokensResponse': return same(value.limitations, CONSTANTS.liveLimitations) &&
      unique(value.tokens.map((t) => t.address));
    case 'ChainPoolsRequest': return value.pairedToken === undefined || value.pairedToken !== value.token;
    case 'ChainBalancesRequest': return value.tokens === undefined || value.tokens === null ||
      unique(value.tokens.map((t) => `${t.chainId}:${t.address}`));
    case 'ChainTokensRequest': return value.query.trim().length > 0 && printable(value.query);
    case 'FeeFollower': return feeFollower(value);
    case 'FeeSettlement': return feeSettlement(value);
    case 'FeeTransfer': return value.fromAddress !== value.toAddress;
    case 'FeePoint': return feePoint(value);
    case 'FeeNow': return feeNow(value);
    case 'FeePositionRef': return BigInt(value.tokenId) !== 0n;
    case 'PositionFees': return positionFees(value);
    case 'PositionFeesResponse': return positionFeesResponse(value);
    case 'PositionFeesRequest': {
      const keys = value.positions.map((p) => `${p.dex}:${p.tokenId}`);
      return new Set(keys).size === keys.length;
    }
    default: return true;
  }
}

const validators = createContractValidators(SCHEMAS, ERROR_STATUS_BY_CODE, semantic);
export const { validateRequest, validateResponse, validateError } = validators;

/** The answer is about what was asked: the wallet, the chain, the token, the query; a page or a search no longer
 * than its limit; balances for exactly the chains and tokens asked: by default every Domino chain's base currencies
 * (CONSTANTS.chainIds), never a balance chain's; Ethereum and OP Mainnet (CONSTANTS.balanceChainIds) only when named. */
export function validateExchange(route, request, response) {
  if (!validateRequest(route, request) || !validateResponse(route, response)) return false;
  if (['portfolio', 'activity', 'chain-balances'].includes(route) && response.wallet !== request.wallet) return false;
  if (route === 'activity') return response.items.length <= (request.limit ?? 20);
  if (route === 'chain-pools') {
    return response.chainId === request.chainId && response.token === request.token &&
      response.pairedToken === (request.pairedToken ?? null);
  }
  if (route === 'chain-tokens') {
    return response.chainId === request.chainId && response.query === request.query &&
      response.tokens.length <= (request.limit ?? 20);
  }
  if (route === 'position-fees') {
    // 1.2.0-rc.1: the chain asked, and each position asked, in the order asked.
    return response.chainId === request.chainId && same(response.positions.map((p) => `${p.dex}:${p.tokenId}`),
      request.positions.map((p) => `${p.dex}:${p.tokenId}`));
  }
  if (route === 'chain-balances') {
    const chains = response.chains.map((c) => c.chainId);
    if (request.tokens === undefined || request.tokens === null) return same(chains, CONSTANTS.chainIds);
    const asked = {};
    for (const t of request.tokens) (asked[t.chainId] ??= []).push(t.address);
    return same(chains, Object.keys(asked).map(Number).sort((a, b) => a - b)) &&
      response.chains.every((c) => same(c.balances.map((b) => b.address), asked[c.chainId]));
  }
  return true;
}
