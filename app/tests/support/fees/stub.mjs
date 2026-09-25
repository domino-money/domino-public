/**
 * The fees relay as the test servers answer it (2026-09-24, P6; DESIGN-V2
 * §15.7, R-7, R-8): the builds that ask it (the deployable ones and the
 * wallet test builds) find POST /api/fees/v1/state answered on every server.
 *
 * - feesDefault: every id `not_found`, so no screen draws a history and
 *   /logs is never asked; an unexpected /logs is a 502 the page watch reports.
 * - feesFixtureRoute(ids): the recorded answers of tests/support/fees/*.json.gz
 *   for those real position NFTs (one per request: each was recorded at its own
 *   block), so a suite can open a verified history, e.g. #/positions/3136705.
 *
 * Both take a Web Request and answer a Response, or undefined for any other
 * path; feesAnswer() is the same for a plain node:http server. Not a suite of
 * its own.
 */
import { fixtureRelay, loadCase } from './relay-fixture.mjs';

export const FEES_STATE_PATH = '/api/fees/v1/state';
export const FEES_LOGS_PATH = '/api/fees/v1/logs';

const json = (body, status = 200) => ({ status, body: JSON.stringify(body) });
const BAD = json({ v: 1, error: 'bad_request' }, 400);

function stateIds(method, text) {
  if (method !== 'POST') return null;
  try {
    const body = JSON.parse(text);
    const ids = body?.tokenIds;
    if (Object.keys(body).join() !== 'tokenIds' || !Array.isArray(ids) || ids.length < 1 || ids.length > 8 || !ids.every((id) => typeof id === 'string' && /^(?:0|[1-9][0-9]{0,77})$/.test(id))) return null;
    return ids;
  } catch {
    return null;
  }
}

/** { status, body } for a fees path answered with defaults, else undefined. */
export function feesAnswer(method, pathname, text) {
  if (pathname === FEES_STATE_PATH) {
    const ids = stateIds(method, text);
    if (!ids) return BAD;
    return json({ v: 1, block: 1, timestamp: 1, positions: ids.map((tokenId) => ({ tokenId, ok: false, reason: 'not_found' })) });
  }
  if (pathname === FEES_LOGS_PATH) return json({ v: 1, error: 'rpc_unavailable' }, 502);
  return undefined;
}

const toResponse = (answer) => (answer ? new Response(answer.body, { status: answer.status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }) : undefined);

/** A route for createWalletServer / the gated server: the default fees answers. */
export async function feesDefault(request, url = new URL(request.url)) {
  if (url.pathname !== FEES_STATE_PATH && url.pathname !== FEES_LOGS_PATH) return undefined;
  return toResponse(feesAnswer(request.method, url.pathname, await request.text()));
}

/** A route answering the recorded /state and relay units of `ids`; any other id is not_found. */
export function feesFixtureRoute(ids = ['3136705']) {
  const relays = new Map(ids.map((id) => [id, fixtureRelay(loadCase(id))]));
  return async (request, url = new URL(request.url)) => {
    if (url.pathname === FEES_STATE_PATH) {
      const asked = stateIds(request.method, await request.text());
      if (!asked) return toResponse(BAD);
      const known = asked.filter((id) => relays.has(id));
      const base = known.length ? loadCase(known[0]).state : { block: 1, timestamp: 1 };
      return toResponse(json({ v: 1, block: base.block, timestamp: base.timestamp, positions: asked.map((tokenId) => (relays.has(tokenId) ? loadCase(tokenId).state.positions[0] : { tokenId, ok: false, reason: 'not_found' })) }));
    }
    if (url.pathname === FEES_LOGS_PATH) {
      let body;
      try {
        body = JSON.parse(await request.text());
      } catch {
        return toResponse(BAD);
      }
      // A relay unit request names a token id (transfer) or a pool id: answer from the case that has it.
      const relay = body.kind === 'transfer' ? relays.get(body.tokenId) : [...relays.entries()].find(([id]) => loadCase(id).state.positions[0].poolId === body.poolId)?.[1] ?? (body.kind === 'headers' ? relays.values().next().value : undefined);
      if (!relay) return toResponse(json({ v: 1, error: 'rpc_unavailable' }, 502));
      const answer = await relay.logs(body);
      return toResponse(answer.ok ? json(answer.value) : json({ v: 1, error: 'rpc_unavailable' }, 502));
    }
    return undefined;
  };
}
