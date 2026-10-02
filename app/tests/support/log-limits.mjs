/**
 * The chain RPC's eth_getLogs limits, as its gateway answers them since 2026-09-28 (functions/_lib/owned.ts
 * LOG_BLOCKS_ONE and LOG_BLOCKS_MANY; measured live that evening, the refusal at once, before any node): a filter may span
 * 10,000,000 blocks at most, and 100,000 when any of its places (the address, or one topic) holds several values; a list
 * of one value counts as one. The fake chains of the tests answer the same refusal, word for word, so every read of the
 * page is checked against it. Not a suite of its own.
 */
export const LOG_BLOCKS_ONE = 10_000_000;
export const LOG_BLOCKS_MANY = 100_000;

const several = (value) => Array.isArray(value) && value.length > 1;

/** The gateway's refusal of `filter` (an eth_getLogs filter as the page sends it), or null when it is allowed. */
export function logLimitError(filter) {
  const from = Number(filter.fromBlock);
  const to = Number(filter.toBlock);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from) return null;
  const many = several(filter.address) || (filter.topics ?? []).some(several);
  const allowed = many ? LOG_BLOCKS_MANY : LOG_BLOCKS_ONE;
  const spans = to - from + 1;
  if (spans <= allowed) return null;
  return { code: -32602, message: `query spans ${spans} blocks (${from} to ${to}), but only ${allowed} are allowed for this request; narrow the block range${many ? ', or send one value per position' : ''}` };
}

/**
 * Domino's own node (rugged97's, 2026-10-02, RUGGED_RPC_SITE_2026-10-02.md), which the site's chain routes read: no block
 * ceiling, only its 30 s time-out. The fakes that stand for it (tests/support/browser-chain.mjs, tests/owned-chain.mjs)
 * refuse, so a test fails, what the routes' transport must never send it (functions/_lib/localRpc.ts): a window wider than
 * its LOCAL_RPC_LOG_BLOCKS (10,000,000 since the review of the rules, 2026-10-02; 1,000,000 before), a log read below the
 * floor (block 69,249,061, rule 3), and a PoolManager read of more than one block (rule 2). The error's words are the
 * test's, not the node's.
 */
export const NODE_LOG_BLOCKS = 10_000_000;
export const NODE_LOG_FLOOR = 69_249_061;
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';

/** What the routes' transport must never ask Domino's node (null when `filter` is fine). */
export function nodeLogError(filter) {
  const from = Number(filter.fromBlock);
  const to = Number(filter.toBlock);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from) return null;
  const addresses = [filter.address].flat().map((one) => String(one).toLowerCase());
  if (from < NODE_LOG_FLOOR) return { code: -32099, message: `test: a log read below the floor (${from} to ${to})` };
  if (to - from + 1 > NODE_LOG_BLOCKS) return { code: -32099, message: `test: a window of ${to - from + 1} blocks (${from} to ${to})` };
  if (addresses.includes(POOL_MANAGER) && to !== from) return { code: -32099, message: `test: the PoolManager's logs over ${to - from + 1} blocks (${from} to ${to})` };
  return null;
}
