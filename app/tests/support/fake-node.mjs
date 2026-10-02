/**
 * Domino's own Robinhood Chain node (rugged97's, https://rpc.domino.money/<token>/) as the tests answer it (RPC-SPEC §6):
 * the upstream of functions/_lib/localRpc.ts over a test's fake chain. It answers the transport's own eth_chainId
 * check, eth_simulateV1 through the test's `simulator` (a function of its params, or none: the method is missing), and
 * every other call by the fake chain's own `fetch(RPC_URL, init)` (tests/owned-chain.mjs, tests/support/browser-chain.mjs,
 * tests/support/fees/*), one call at a time, as one JSON-RPC reply, a batch for a batch. A fake chain's own refusal (a
 * 429, an outage) is the node's answer to the whole POST, as nginx in front of it would answer. Not a suite of its own.
 *
 *   fakeNode(deps, { simulator?, chainId?, asked? })   (url, init) => Promise<Response>
 *
 * deps: { fetch(url, init) } (functions/_lib/owned.ts OwnedDeps); `chainId` what eth_chainId answers ('0x1237', Robinhood
 * Chain); `asked` an array that gets the URL of every POST, so a test can check the transport asks the configured node.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const owned = require('../../.test-build/app/functions/_lib/owned.js');

export const ROBINHOOD_CHAIN_ID = '0x1237';

export function fakeNode(deps, { simulator = () => null, chainId = ROBINHOOD_CHAIN_ID, asked = null } = {}) {
  return async (url, init) => {
    asked?.push(url);
    const body = JSON.parse(init.body);
    const calls = Array.isArray(body) ? body : [body];
    const replies = [];
    for (const call of calls) {
      if (call.method === 'eth_chainId') {
        replies.push({ jsonrpc: '2.0', id: call.id, result: chainId });
        continue;
      }
      if (call.method === 'eth_simulateV1') {
        const simulate = simulator?.() ?? null;
        if (!simulate) {
          replies.push({ jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'the method eth_simulateV1 does not exist/is not available' } });
          continue;
        }
        try {
          replies.push({ jsonrpc: '2.0', id: call.id, result: await simulate(call.params) });
        } catch (error) {
          replies.push({ jsonrpc: '2.0', id: call.id, error: { code: typeof error?.code === 'number' ? error.code : -32000, message: String(error?.message ?? 'execution reverted') } });
        }
        continue;
      }
      const response = await deps.fetch(owned.RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: call.id, method: call.method, params: call.params }), signal: init.signal });
      if (response.status !== 200) return response;
      const reply = await response.json();
      replies.push({ ...reply, jsonrpc: '2.0', id: call.id });
    }
    return new Response(JSON.stringify(Array.isArray(body) ? replies : replies[0]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}
