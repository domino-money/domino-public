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
