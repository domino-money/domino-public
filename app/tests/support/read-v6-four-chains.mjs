/**
 * TEST-ONLY. read-v6 answers as rugged97's read gateway would serve them on day 9 if his read-v6 names Elysium (99901)
 * under the same contract version (added 2026-11-07, the read-v6 version skew; docs/ELYSIUM_DAY9.md "Order"): the
 * package's own valid fixtures with Elysium's entries added, each a copy of a Robinhood Chain entry moved to 99901, so the
 * day-9 package (tests/support/elysium-day9.mjs READ_V6_DAY9, rugged97's runtime over his data as day 9 has it) takes
 * every one of them whole, and today's package (three chains) refuses every one of them whole.
 *
 *   portfolioWithElysium(status, base)
 *                                  portfolio.json (or `base`) and an Elysium chain: 'current' (a copy of Robinhood Chain's status,
 *                                  with a copy of every Robinhood Chain token, vault, position, mandate and credit) or
 *                                  'unavailable' (its deployment not registered yet, nothing read: the likeliest Monday
 *                                  morning), its coverage the four chains' own.
 *   activityWithElysium()          activity.json with a copy of its six newest Robinhood Chain receipts on Elysium
 *                                  (twenty in all, a first page at the default limit), in the answer's own order
 *                                  (newest first; at one time, the higher chain id first).
 *   pageEndingOnElysium()          activity-page.json (asked with a limit of 3) whose last receipt is on Elysium, so its
 *                                  `nextCursor` names 99901, as the reader writes it from a page's last row.
 *   pageWithElysiumInside()        the same page with its middle receipt on Elysium and its cursor still Robinhood
 *                                  Chain's.
 *
 * Pure: every call returns new objects; nothing under api-contracts/ is written.
 */
import { readFileSync } from 'node:fs';

export const ELYSIUM = 99901;
const FIXTURES = new URL('../../../api-contracts/read-v6/fixtures/', import.meta.url);
export const readV6Fixture = (path) => JSON.parse(readFileSync(new URL(path, FIXTURES), 'utf8'));
const copy = (value) => JSON.parse(JSON.stringify(value));
const ROBINHOOD = 4663;
/** A different deployment's record on Elysium (the copy's own, never Robinhood Chain's). */
const ELYSIUM_MANIFEST = '0'.repeat(59) + '99901';

const tokenKey = (t) => `${String(t.chainId).padStart(20, '0')}:${t.address}`;
const byToken = (a, b) => (tokenKey(a) < tokenKey(b) ? -1 : 1);

/** Robinhood Chain's chain status, moved to Elysium (`current`), or Elysium with no deployment registered (`unavailable`). */
function elysiumStatus(body, status) {
  const base = body.chains.find((c) => c.chainId === ROBINHOOD);
  if (status === 'current') {
    return { ...copy(base), chainId: ELYSIUM, deployment: { ...base.deployment, manifestSha256: ELYSIUM_MANIFEST } };
  }
  return { ...copy(base), chainId: ELYSIUM, status: 'unavailable', reason: 'deployment_not_registered', deployment: null,
    finalizedThrough: null, head: null, indexedThrough: null, lagBlocks: null, lagSeconds: null, lastError: null,
    automationHalted: null, operatorsAdmitted: null,
    waitingReasons: { ageSeconds: null, block: null, status: 'not_configured', timestamp: null } };
}

/** A token of Robinhood Chain's, listed on Elysium: no qualified price there (its own profile prices nothing of it). */
const elysiumToken = (t) => ({ ...copy(t), chainId: ELYSIUM, price: null, priceReason: 'no_qualified_price_source' });
const onElysium = (entry) => ({ ...copy(entry), chainId: ELYSIUM });

const coverageOf = (chains) => (chains.every((c) => c.status === 'current') ? 'complete' : 'partial');

export function portfolioWithElysium(status = 'current', base = 'valid/portfolio.json') {
  const body = readV6Fixture(base);
  const chains = [...body.chains, elysiumStatus(body, status)];
  const out = { ...body, chains, coverage: coverageOf(chains) };
  if (status !== 'current') return out;
  const robinhood = (list) => list.filter((entry) => entry.chainId === ROBINHOOD);
  out.tokens = [...body.tokens, ...robinhood(body.tokens).map(elysiumToken)].sort(byToken);
  for (const key of ['vaults', 'positions', 'mandates', 'credits']) out[key] = [...body[key], ...robinhood(body[key]).map(onElysium)];
  return out;
}

/** (timestamp, chain id, block, log index): the order activity lists its receipts in, newest first. */
const itemKey = (item) => [BigInt(item.tx.snapshot.timestamp), BigInt(item.chainId), BigInt(item.tx.snapshot.number), BigInt(item.id.split(':')[2])];
function newestFirst(a, b) {
  const [x, y] = [itemKey(a), itemKey(b)];
  const at = x.findIndex((value, index) => value !== y[index]);
  return at === -1 ? 0 : x[at] > y[at] ? -1 : 1;
}
const receiptOnElysium = (item) => ({ ...onElysium(item), id: `${ELYSIUM}:${item.id.split(':').slice(1).join(':')}` });

export function activityWithElysium() {
  const body = readV6Fixture('valid/activity.json');
  const chains = [...body.chains, elysiumStatus(body, 'current')];
  // Its newest six: twenty receipts, a first page at the default limit (20).
  const robinhood = body.items.filter((item) => item.chainId === ROBINHOOD).slice(0, 6);
  return {
    ...body, chains, coverage: coverageOf(chains),
    tokens: [...body.tokens, ...body.tokens.filter((t) => t.chainId === ROBINHOOD).map(elysiumToken)].sort(byToken),
    items: [...body.items, ...robinhood.map(receiptOnElysium)].sort(newestFirst),
  };
}

function pageWith(index) {
  const body = readV6Fixture('valid/activity-page.json');
  const chains = [...body.chains, elysiumStatus(body, 'current')];
  const items = body.items.map((item, i) => (i === index ? receiptOnElysium(item) : item));
  const last = items.at(-1);
  const nextCursor = `${last.tx.snapshot.timestamp}.${last.chainId}.${last.tx.snapshot.number}.${last.id.split(':')[2]}`;
  return { ...body, chains, coverage: coverageOf(chains), items, nextCursor };
}
export const pageEndingOnElysium = () => pageWith(2);
export const pageWithElysiumInside = () => pageWith(1);
