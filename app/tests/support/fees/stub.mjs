/**
 * The fees routes as the test servers answer them by default (2026-09-24, P6; DESIGN-V2 §15.7, R-7, R-8): the builds that
 * ask them (the deployable ones and the wallet test builds) find POST /api/fees/v1/state and /api/fees/v2/ledger answered
 * on every server, every id `not_found`, so no screen draws a history. A suite that needs a position's fees routes the
 * site's chain routes over a fake chain instead (tests/support/browser-chain.mjs routeChain).
 *
 * Changed on purpose 2026-10-02 (RPC-SPEC §11.4): /api/fees/v1/logs is gone with the fees replay; the ledger route is
 * answered in its place.
 *
 * feesDefault takes a Web Request and answers a Response, or undefined for any other path; feesAnswer() is the same for a
 * plain node:http server. Not a suite of its own.
 */
export const FEES_STATE_PATH = '/api/fees/v1/state';
export const FEES_LEDGER_PATH = '/api/fees/v2/ledger';

const json = (body, status = 200) => ({ status, body: JSON.stringify(body) });
const BAD = json({ v: 1, error: 'bad_request' }, 400);

function askedIds(method, text, optional = []) {
  if (method !== 'POST') return null;
  try {
    const body = JSON.parse(text);
    const ids = body?.tokenIds;
    if (!Object.keys(body).every((key) => key === 'tokenIds' || optional.includes(key)) || !Array.isArray(ids) || ids.length < 1 || ids.length > 8 || !ids.every((id) => typeof id === 'string' && /^(?:0|[1-9][0-9]{0,77})$/.test(id))) return null;
    return ids;
  } catch {
    return null;
  }
}

/** { status, body } for a fees path answered with defaults, else undefined. */
export function feesAnswer(method, pathname, text) {
  if (pathname !== FEES_STATE_PATH && pathname !== FEES_LEDGER_PATH) return undefined;
  const ids = askedIds(method, text, pathname === FEES_LEDGER_PATH ? ['fresh'] : []);
  if (!ids) return BAD;
  return json({ v: 1, block: 1, timestamp: 1, positions: ids.map((tokenId) => ({ tokenId, ok: false, reason: 'not_found' })) });
}

const toResponse = (answer) => (answer ? new Response(answer.body, { status: answer.status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }) : undefined);

/** A route for createWalletServer / the gated server: the default fees answers. */
export async function feesDefault(request, url = new URL(request.url)) {
  if (url.pathname !== FEES_STATE_PATH && url.pathname !== FEES_LEDGER_PATH) return undefined;
  return toResponse(feesAnswer(request.method, url.pathname, await request.text()));
}
