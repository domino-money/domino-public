/** Test node for the production confirmation route. Reads the scenario's real fake-chain receipts; never sends. */
import { edgeRoutes } from './edge-routes.mjs';

const PATH = '/api/chain/v1/confirmation';
const READS = new Set(['eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByNumber']);

/** A same-origin server route, using answerChainRoute's validation and bounded RPC transport unchanged. */
export function confirmationRoute(chain) {
  const routes = edgeRoutes({
    async fetch(_url, init) {
      const call = JSON.parse(init.body);
      if (!READS.has(call.method)) throw new Error(`Unexpected confirmation method: ${call.method}`);
      const reply = await chain.request(call.method, call.params);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: call.id, ...reply }), { headers: { 'Content-Type': 'application/json' } });
    },
  });
  return (request, url = new URL(request.url)) => url.pathname === PATH ? routes(request) : undefined;
}

/** The closed financial reader over the same real route, with controllable finality for isolated client tests. */
export function confirmationReader(chain, { finalized } = {}) {
  const route = confirmationRoute(chain);
  const ask = async (body) => {
    const response = await route(new Request(`https://edge.test${PATH}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://edge.test', 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify(body),
    }));
    if (!response.ok) throw new Error(`Confirmation route returned ${response.status}`);
    return response.json();
  };
  return {
    async read(hash) { const { transaction, receipt, block } = await ask({ hash }); return { transaction, receipt, block }; },
    finalized: finalized ?? (async () => (await ask({ finality: true })).finalized),
  };
}

/** Overrides only confirmation after routeChain: historical inventory and fees still use their own scenario node. */
export async function routeConfirmation(context, chain) {
  const answer = confirmationRoute(chain);
  await context.route((url) => url.pathname === PATH, async (route) => {
    const asked = route.request();
    const headers = Object.fromEntries(Object.entries(await asked.allHeaders()).filter(([name]) => ['content-type', 'origin', 'sec-fetch-site'].includes(name)));
    const response = await answer(new Request(asked.url(), { method: asked.method(), headers, body: asked.method() === 'POST' ? asked.postData() ?? '' : undefined }));
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
}
