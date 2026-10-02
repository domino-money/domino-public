// read-v6, the Domino V2 wallet reads: the closed schemas (schema-data.mjs,
// generated from backend/v2_read_contract.py) plus every cross-field rule the
// producer's models enforce. A validator accepts exactly what the producer
// accepts; fixtures/ holds both sides to it. No fetch, no wallet, no signing.
import { SCHEMAS, ERRORS, CONSTANTS } from './schema-data.mjs';
import { createContractValidators } from '../shared/closed-schema.mjs';

export const CONTRACT_VERSION = '1.0.0-rc.1';
export const ROUTES = Object.freeze(Object.keys(SCHEMAS));
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
      (item.tx.finality === 'finalized') === (final !== null && item.tx.snapshot.number <= final.number);
  }) && (body.nextCursor === null || cursorKey(body.nextCursor) !== null);
}

function semantic(name, value) {
  switch (name) {
    case 'PoolRef': return value.currency0 < value.currency1 && !(value.dex === 3 && value.hooks !== ZERO);
    case 'IndexedToken': return token(value);
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
    case 'AutoExitEvent': return autoExitEvent(value);
    case 'ActivityPageRequest': return value.cursor === undefined || value.cursor === null || cursorKey(value.cursor) !== null;
    case 'PortfolioResponse': return portfolio(value);
    case 'ActivityResponse': return activity(value);
    default: return true;
  }
}

const validators = createContractValidators(SCHEMAS, ERROR_STATUS_BY_CODE, semantic);
export const { validateRequest, validateResponse, validateError } = validators;

/** The answer is about the wallet asked for, and a page is no longer than asked. */
export function validateExchange(route, request, response) {
  if (!validateRequest(route, request) || !validateResponse(route, response)) return false;
  if (response.wallet !== request.wallet) return false;
  return route !== 'activity' || response.items.length <= (request.limit ?? 20);
}
