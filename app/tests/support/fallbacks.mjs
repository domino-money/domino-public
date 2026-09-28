/**
 * The chain's three public fallbacks as the tests answer them (2026-09-28): each one refuses what it refused when it was
 * measured from a Vivo line that day (src/lib/chain/endpoints.ts), in its own words and statuses, and answers everything
 * else from the test's own chain, as the chain's own RPC would. For the Node suites (a globalThis.fetch stub) and the
 * browser suites (tests/support/browser-chain.mjs routes the three hosts with it). Not a suite of its own.
 *
 * - publicnode: a pruned node. A numbered state read more than 30 blocks below the head, or logs from more than 60
 *   below it: HTTP 403 "Archive requests require a personal token".
 * - ordofi: an archive with slow logs. Over 10,000 blocks of logs: -32005 "the network is busy" (HTTP 200); no
 *   eth_simulateV1 (-32601).
 * - dRPC: no numbered state read at all (HTTP 400 "Unknown state", code 27); over 150 blocks of logs: HTTP 400 "ranges
 *   over 10000 blocks are not supported on free plan", code 35.
 *
 * Every one says it is chain 4663 (eth_chainId) unless `chainId` says otherwise, and `busy` (a set of hosts) makes one
 * answer every other call as ordofi does when it is busy.
 */
export const PUBLICNODE = 'https://robinhood-rpc.publicnode.com';
export const ORDOFI = 'https://rpc.ordofi.network';
export const DRPC = 'https://robinhood.drpc.org';
export const FALLBACK_URLS = [PUBLICNODE, ORDOFI, DRPC];
/** The hosts as the page asks them (fetch adds the slash). */
export const FALLBACK_ROUTE = /^https:\/\/(?:robinhood-rpc\.publicnode\.com|rpc\.ordofi\.network|robinhood\.drpc\.org)\/?$/;

const QUANTITY = /^0x[0-9a-f]+$/i;
const STATE = { eth_call: 1, eth_getBalance: 1, eth_getCode: 1, eth_getStorageAt: 2 };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'access-control-allow-origin': '*' } });

/**
 * What `url` (one of the three) answers to the POST `body` (text), over `own` (the chain's own answer to a body:
 * (body) => Promise<Response>) and `head` (the chain's head). `log` gets every call asked, with its host.
 */
export async function fallbackReply(url, body, { own, head, log = [], chainId = '0x1237', busy = new Set() }) {
  const host = url.replace(/\/$/, '');
  const value = JSON.parse(body);
  const calls = Array.isArray(value) ? value : [value];
  for (const call of calls) log.push({ host, method: call.method, params: call.params });
  const top = typeof head === 'function' ? head() : head;
  const refuse = (status, error) => json(status, Array.isArray(value) ? calls.map((call) => ({ jsonrpc: '2.0', id: call.id, error })) : { jsonrpc: '2.0', id: value.id, error });
  if (calls.length === 1 && calls[0].method === 'eth_chainId') return json(200, { jsonrpc: '2.0', id: calls[0].id, result: chainId });
  if (busy.has(host)) return refuse(200, { code: -32005, message: 'the network is busy, please try again in a moment' });
  for (const call of calls) {
    const at = STATE[call.method] === undefined ? undefined : call.params?.[STATE[call.method]];
    const numbered = typeof at === 'string' && QUANTITY.test(at) ? Number(at) : null;
    const filter = call.method === 'eth_getLogs' ? call.params?.[0] ?? {} : null;
    const from = filter && QUANTITY.test(String(filter.fromBlock)) ? Number(filter.fromBlock) : null;
    const to = filter && QUANTITY.test(String(filter.toBlock)) ? Number(filter.toBlock) : null;
    const span = from !== null && to !== null ? to - from + 1 : 0;
    if (host === PUBLICNODE && ((numbered !== null && numbered < top - 30) || (from !== null && from < top - 60)))
      return refuse(403, { code: -32602, message: 'Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode' });
    if (host === ORDOFI && call.method === 'eth_simulateV1') return refuse(200, { code: -32601, message: 'eth_simulateV1 is not available without an API key on this endpoint' });
    if (host === ORDOFI && span > 10_000) return refuse(200, { code: -32005, message: 'the network is busy, please try again in a moment' });
    if (host === DRPC && numbered !== null) return refuse(400, { message: 'Unknown state. First available state is 1', code: 27 });
    if (host === DRPC && span > 150) return refuse(400, { message: 'ranges over 10000 blocks are not supported on free plan', code: 35 });
  }
  const reply = await own(body);
  return new Response(await reply.text(), { status: reply.status, headers: { 'Content-Type': 'application/json', 'access-control-allow-origin': '*' } });
}
