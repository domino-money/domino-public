// crosschain-v1 1.0.0-rc.1 through the authenticated bridge (spec F7 §3.2; added 2026-10-02, the bridge side of S2, open
// point #17): POST /api/crosschain/v1/origins, /quote and /status, a SIWE session and its CSRF token, forwarded to the
// private listener's /internal/crosschain/v1/<route> (backend/crosschain_api.py, 127.0.0.1:8910 behind its own tunnel
// hostname and Access identity). The shared transport is onboarding's, deposit's and position-plan's
// (authenticated-worker.mjs): the browser's session cookie and CSRF header become X-Domino-Session and X-Domino-CSRF, the
// edge's client address X-Domino-Client-Id, and every answer passes the package's runtime (validateRequest,
// validateResponse with its recomputed decision and its pinned-contract steps, validateError) before it reaches the
// browser. The owner is the session's wallet: no request names one, a recipient, a refund address or a fee recipient
// (the package's closed request schemas refuse the fields), and this Worker never calls Relay or Across itself.
//
// Off until CROSSCHAIN_BRIDGE_ENABLED is exactly "true" (route_not_available, no upstream call), with
// CROSSCHAIN_GATEWAY_ORIGIN and the Access pair CROSSCHAIN_ACCESS_CLIENT_ID / _SECRET; an enabled but incomplete
// configuration answers upstream_unavailable before any upstream call.
//
// One addition of this Worker's own, position-plan-worker.mjs's: GET /api/crosschain/v1/capabilities, answered here with
// no upstream call and no session, so the app can ask whether the route is switched on before it offers a deposit from
// another network (app/src/v2/gate.ts, the S2 gate). It never says more than this Worker's own configuration knows:
// which origins and tokens the providers bridge is the listener's answer to `origins`, not this answer's.
import { fail, BridgeError, checkBrowser, exactOrigin } from './worker.mjs';
import { createAuthenticatedWorker } from './authenticated-worker.mjs';
import * as runtime from '../../api-contracts/crosschain-v1/runtime.mjs';

const PREFIX = '/api/crosschain/v1/';
const HEADER = 'X-Domino-Crosschain-Contract';
const ENV = 'CROSSCHAIN';
const CAPABILITIES = `${PREFIX}capabilities`;

// The service's own limits (XC README; backend/crosschain_models.py MAX_BODY and MAX_RESPONSE): a 4 KiB body, an answer
// up to 256 KiB, the listener's 20 s (authenticated_api.TOTAL_SECONDS) for the upstream exchange, and the whole request
// within 25 s (onboarding's budget), under the page's own 27 s (app/src/v2/crosschain/transport.ts
// CROSSCHAIN_TIMEOUT_MS), so this Worker's 504 is what it sees. A quote's 120 s life is the service's, not this
// Worker's: the package's runtime holds expiresAt to requestedAt + quoteLifetimeSeconds, and nothing of it is fixed here.
export const CROSSCHAIN_LIMITS = Object.freeze({ requestBytes: 4096, responseBytes: 256 * 1024,
  cookiesBytes: 8192, bodyMs: 5000, totalMs: 25000, upstreamMs: 20000 });

// Address and hash fields compare without regard to case: the listener echoes what it was sent, and their case never
// changes what they name. Relay's requestId is an opaque string and compares exactly, as every other field does.
const HEX_FIELDS = new Set(['originToken', 'destinationToken', 'depositTxHash']);

/** `echo` (an answer's `request`, without the owner) is the request this browser sent: every field, as it sent it, and nothing else. */
function same(echo, sent, name = '') {
  if (typeof echo === 'string' && typeof sent === 'string' && HEX_FIELDS.has(name)) {
    return echo.toLowerCase() === sent.toLowerCase();
  }
  if (echo !== null && sent !== null && typeof echo === 'object' && typeof sent === 'object') {
    const keys = Object.keys(echo);
    return keys.length === Object.keys(sent).length && keys.every((key) => Object.hasOwn(sent, key) && same(echo[key], sent[key], key));
  }
  return echo === sent;
}

/**
 * The answer is about this request. The package's runtime already holds each answer to its own echo (the quote's
 * decision, steps and times; the status report's state, transition and recovery); this ties the echo to what the
 * browser actually sent, and keeps a service clock from the future out. The owner is the listener's, from the opaque
 * session: this Worker has no account identity to compare it with (onboarding-worker.mjs's rule), and the app checks it
 * against the connected wallet (app/src/v2/crosschain/client.ts).
 */
function associated(route, body, data) {
  const now = Date.now() / 1000;
  if (route === 'origins') {
    const { origins } = data;
    return origins.destinationChainId === body.destinationChainId &&
      origins.destinationToken.toLowerCase() === body.destinationToken.toLowerCase() && origins.retrievedAt <= now + 5;
  }
  if (route === 'quote') {
    const { owner: _owner, ...echo } = data.quote.request;
    return same(echo, body) && data.quote.requestedAt <= now + 5 && data.quote.retrievedAt <= now + 5;
  }
  const { owner: _owner, ...echo } = data.status.request;
  return same(echo, body) && data.status.checkedAt <= now + 5;
}

function headersFor(id) {
  return new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    [HEADER]: runtime.CONTRACT_VERSION, 'X-Domino-Request-Id': id });
}

/**
 * Whether the route is on, as authenticated-worker.mjs's config() decides it: the exact "true", and then a gateway
 * origin of its own and the Access pair, or the configuration is broken (upstream_unavailable, as every POST answers).
 */
function switchedOn(env) {
  const appOrigin = exactOrigin(env.APP_ORIGIN);
  if (!appOrigin) fail('upstream_unavailable');
  if (env[`${ENV}_BRIDGE_ENABLED`] !== 'true') return { appOrigin, enabled: false };
  const gatewayOrigin = exactOrigin(env[`${ENV}_GATEWAY_ORIGIN`]);
  const secret = (value) => typeof value === 'string' && /^[\x21-\x7e]{1,1024}$/u.exec(value)?.[0] === value;
  if (!gatewayOrigin || gatewayOrigin === appOrigin || !secret(env[`${ENV}_ACCESS_CLIENT_ID`]) ||
      !secret(env[`${ENV}_ACCESS_CLIENT_SECRET`])) fail('upstream_unavailable');
  return { appOrigin, enabled: true };
}

/** GET capabilities: local, no session, no upstream call. Browser checks as the read Worker's capabilities GET. */
function capabilities(request, env) {
  const id = crypto.randomUUID();
  try {
    const { appOrigin, enabled } = switchedOn(env);
    const url = new URL(request.url);
    if (url.search || url.hash) fail('route_not_available');
    if (request.method !== 'GET') fail('method_not_allowed');
    checkBrowser(request, appOrigin, true);
    const version = request.headers.get(HEADER);
    if (version !== null && version !== runtime.CONTRACT_VERSION) fail('upstream_contract_mismatch');
    return new Response(JSON.stringify({
      contractVersion: runtime.CONTRACT_VERSION,
      dataMode: enabled ? 'live' : 'disabled',
      enabledRoutes: enabled ? [...runtime.ROUTES] : [],
    }), { status: 200, headers: headersFor(id) });
  } catch (error) {
    const code = error instanceof BridgeError && Object.hasOwn(runtime.ERROR_STATUS_BY_CODE, error.code) ? error.code : 'upstream_unavailable';
    return new Response(JSON.stringify({ error: code }), { status: runtime.ERROR_STATUS_BY_CODE[code], headers: headersFor(id) });
  }
}

export function createCrosschainWorker(options = {}) {
  const worker = createAuthenticatedWorker({ ...runtime, PREFIX, HEADER, envPrefix: ENV,
    internalPrefix: '/internal/crosschain/v1/', limits: CROSSCHAIN_LIMITS,
    associated,
    // A quote that is no longer good to send is never shown (§3.8: preview_expired, quote again). A listing and a status
    // report do not expire.
    assertFresh: (data) => { if (data.quote !== undefined && data.quote.expiresAt <= Date.now() / 1000) fail('preview_expired'); },
  }, options);
  return {
    async fetch(request, env = {}) {
      if (new URL(request.url).pathname === CAPABILITIES) return capabilities(request, env);
      return worker.fetch(request, env);
    },
  };
}

export default createCrosschainWorker();
