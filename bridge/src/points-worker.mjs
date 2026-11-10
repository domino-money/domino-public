// points-v1 1.0.0-rc.1 through the authenticated bridge (docs/points/POINTS.md, part 3; 7 Nov 2026): POST
// /api/points/v1/points and /api/points/v1/link, a SIWE session and its CSRF token, forwarded to the private
// listener's /internal/points/v1/<route> (backend/points_api.py, 127.0.0.1:8912 behind its own tunnel hostname and
// Access identity). The shared transport is onboarding's, deposit's and the plan's (authenticated-worker.mjs): the
// browser's session cookie and CSRF header become X-Domino-Session and X-Domino-CSRF, the edge's client address
// X-Domino-Client-Id, and every answer passes the package's runtime (validateRequest, validateResponse,
// validateError) before it reaches the browser. The wallet is the session's: no request names one.
//
// Off until POINTS_BRIDGE_ENABLED is exactly "true" (route_not_available, no upstream call), with
// POINTS_GATEWAY_ORIGIN and the Access pair POINTS_ACCESS_CLIENT_ID / _SECRET; an enabled but incomplete
// configuration answers upstream_unavailable before any upstream call. GET /api/points/v1/capabilities answers here,
// with no session and no upstream call, whether the routes are switched on.
import { fail, BridgeError, browserOrigin, exactOrigin, previewOrigins } from './worker.mjs';
import { createAuthenticatedWorker } from './authenticated-worker.mjs';
import * as runtime from '../../api-contracts/points-v1/runtime.mjs';

const PREFIX = '/api/points/v1/';
const HEADER = 'X-Domino-Points-Contract';
const ENV = 'POINTS';
const CAPABILITIES = `${PREFIX}capabilities`;

// The service's own limits: a 1 KiB body and an 8 KiB answer (points_models.MAX_BODY, MAX_RESPONSE), the listener's
// 20 s (authenticated_api.TOTAL_SECONDS) for the upstream exchange, and the whole request within 21 s.
export const POINTS_LIMITS = Object.freeze({ requestBytes: 1024, responseBytes: 8192,
  cookiesBytes: 8192, bodyMs: 5000, totalMs: 21000, upstreamMs: 20000 });

/**
 * A recorded link names the referrer this browser sent; an existing one names the first, whatever was sent. The
 * referred wallet is the listener's, from the opaque session: the app checks it against the wallet.
 */
function associated(route, body, data) {
  if (route !== 'link') return true;
  return data.status === 'existing' || data.referrer === body.referrer.toLowerCase();
}

function headersFor(id) {
  return new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    [HEADER]: runtime.CONTRACT_VERSION, 'X-Domino-Request-Id': id });
}

/** Whether the routes are on, as authenticated-worker.mjs's config() decides it (the position-plan Worker's rule). */
function switchedOn(env) {
  const appOrigin = exactOrigin(env.APP_ORIGIN);
  if (!appOrigin) fail('upstream_unavailable');
  const gatewayOrigin = exactOrigin(env[`${ENV}_GATEWAY_ORIGIN`]);
  const origins = [appOrigin, ...previewOrigins(env.PREVIEW_ORIGINS, appOrigin, gatewayOrigin, 'points-bridge')];
  if (env[`${ENV}_BRIDGE_ENABLED`] !== 'true') return { origins, enabled: false };
  const secret = (value) => typeof value === 'string' && /^[\x21-\x7e]{1,1024}$/u.exec(value)?.[0] === value;
  if (!gatewayOrigin || gatewayOrigin === appOrigin || !secret(env[`${ENV}_ACCESS_CLIENT_ID`]) ||
      !secret(env[`${ENV}_ACCESS_CLIENT_SECRET`])) fail('upstream_unavailable');
  return { origins, enabled: true };
}

function capabilities(request, env) {
  const id = crypto.randomUUID();
  try {
    const { origins, enabled } = switchedOn(env);
    const url = new URL(request.url);
    if (url.search || url.hash) fail('route_not_available');
    if (request.method !== 'GET') fail('method_not_allowed');
    browserOrigin(request, origins, true);
    const version = request.headers.get(HEADER);
    if (version !== null && version !== runtime.CONTRACT_VERSION) fail('upstream_contract_mismatch');
    return new Response(JSON.stringify({ contractVersion: runtime.CONTRACT_VERSION, dataMode: enabled ? 'live' : 'disabled',
      enabledRoutes: enabled ? [...runtime.ROUTES] : [] }), { status: 200, headers: headersFor(id) });
  } catch (error) {
    const code = error instanceof BridgeError && Object.hasOwn(runtime.ERROR_STATUS_BY_CODE, error.code) ? error.code : 'upstream_unavailable';
    return new Response(JSON.stringify({ error: code }), { status: runtime.ERROR_STATUS_BY_CODE[code], headers: headersFor(id) });
  }
}

export function createPointsWorker(options = {}) {
  const worker = createAuthenticatedWorker({ ...runtime, PREFIX, HEADER, envPrefix: ENV,
    internalPrefix: '/internal/points/v1/', limits: POINTS_LIMITS, associated,
    // Points and links do not expire.
    assertFresh: () => {},
  }, options);
  return {
    async fetch(request, env = {}) {
      if (new URL(request.url).pathname === CAPABILITIES) return capabilities(request, env);
      return worker.fetch(request, env);
    },
  };
}

export default createPointsWorker();
