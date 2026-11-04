// position-plan-v1 1.0.0-rc.2 through the authenticated bridge (spec F7 §2.4; added 2026-10-02, the bridge side of
// #308): POST /api/position-plan/v1/plan, a SIWE session and its CSRF token, forwarded to the private listener's
// /internal/position-plan/v1/plan (backend/v2_position_plan_api.py, 127.0.0.1:8911 behind its own tunnel hostname and
// Access identity). The shared transport is onboarding's and deposit's (authenticated-worker.mjs): the browser's
// session cookie and CSRF header become X-Domino-Session and X-Domino-CSRF, the edge's client address
// X-Domino-Client-Id, and every answer passes the package's runtime (validateRequest, validateResponse with its
// checkPlan, validateError) before it reaches the browser. The owner is the session's wallet: no request names one.
//
// Off until POSITION_PLAN_BRIDGE_ENABLED is exactly "true" (route_not_available, no upstream call), with
// POSITION_PLAN_GATEWAY_ORIGIN and the Access pair POSITION_PLAN_ACCESS_CLIENT_ID / _SECRET; an enabled but incomplete
// configuration answers upstream_unavailable before any upstream call.
//
// One addition of this Worker's own: GET /api/position-plan/v1/capabilities, answered here with no upstream call and
// no session, so the app can ask whether the route is switched on before it plans (the read Worker's capabilities, in
// this family's words). It never says more than this Worker's own configuration knows: which chains the listener
// plans for is the listener's (position_plan_chain_unavailable), not this answer's.
import { fail, BridgeError, browserOrigin, exactOrigin, previewOrigins } from './worker.mjs';
import { createAuthenticatedWorker } from './authenticated-worker.mjs';
import * as runtime from '../../api-contracts/position-plan-v1/runtime.mjs';

const PREFIX = '/api/position-plan/v1/';
const HEADER = 'X-Domino-Position-Plan-Contract';
const ENV = 'POSITION_PLAN';
const CAPABILITIES = `${PREFIX}capabilities`;

// The service's own limits (§2.4): an 8 KiB body, an answer up to 384 KiB (v2_position_plan_models.MAX_RESPONSE), the
// listener's 20 s (authenticated_api.TOTAL_SECONDS) for the upstream exchange, and the whole request within 21 s, under
// the page's own 22 s (app/src/v2/plan/httpTransport.ts S1_PLAN_TIMEOUT_MS), so this Worker's 504 is what it sees.
export const POSITION_PLAN_LIMITS = Object.freeze({ requestBytes: 8192, responseBytes: 384 * 1024,
  cookiesBytes: 8192, bodyMs: 5000, totalMs: 21000, upstreamMs: 20000 });

/** The listener's default slippage (v2_position_plan_models.SLIPPAGE_DEFAULT_BPS), echoed when a request leaves it out. */
const SLIPPAGE_DEFAULT_BPS = 50;
// Address fields compare without regard to case: the listener echoes what it was sent, and an address's case never
// changes what it names.
const ADDRESSES = new Set(['token', 'currency0', 'currency1', 'hooks', 'baseToken']);

/**
 * `echo` (a plan's `request`) is the request this browser sent: every field it sent, as it sent it, and every field it
 * left out as null (the listener's model_dump, so `receive: {mode: "both"}` comes back with `token: null`).
 */
function same(echo, sent, name = '') {
  if (typeof echo === 'string' && typeof sent === 'string' && ADDRESSES.has(name)) {
    return echo.toLowerCase() === sent.toLowerCase();
  }
  if (Array.isArray(echo) || Array.isArray(sent)) {
    return Array.isArray(echo) && Array.isArray(sent) && echo.length === sent.length &&
      echo.every((item, index) => same(item, sent[index], name));
  }
  if (echo !== null && sent !== null && typeof echo === 'object' && typeof sent === 'object') {
    return Object.keys(sent).every((key) => Object.hasOwn(echo, key)) &&
      Object.keys(echo).every((key) => same(echo[key], Object.hasOwn(sent, key) ? sent[key] : null, key));
  }
  return echo === sent;
}

/**
 * The plan answers this request. The package's checkPlan already holds the plan to its own echo (chain, action,
 * consent, owner, the struct, the times: expiresAt = requestedAt + 180, deadline = requestedAt + 300); this ties the
 * echo to what the browser actually sent. The owner is the listener's, from the opaque session: this Worker has no
 * account identity to compare it with (onboarding-worker.mjs's rule), and the app checks it against the wallet.
 */
function associated(body, plan) {
  const { owner: _owner, ...echo } = plan.request;
  const sent = { ...body, slippageBps: Object.hasOwn(body, 'slippageBps') ? body.slippageBps : SLIPPAGE_DEFAULT_BPS };
  if (!same(echo, sent)) return false;
  const now = Date.now() / 1000;
  return plan.requestedAt <= now + 5 && plan.retrievedAt <= now + 5;
}

function headersFor(id) {
  return new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    [HEADER]: runtime.CONTRACT_VERSION, 'X-Domino-Request-Id': id });
}

/**
 * Whether the route is on, as authenticated-worker.mjs's config() decides it: the exact "true", and then a gateway
 * origin of its own and the Access pair, or the configuration is broken (upstream_unavailable, as every POST answers).
 * `origins` are the browser origins its POSTs admit: APP_ORIGIN and the listed previews (4 Nov 2026, launch round P3).
 */
function switchedOn(env) {
  const appOrigin = exactOrigin(env.APP_ORIGIN);
  if (!appOrigin) fail('upstream_unavailable');
  const gatewayOrigin = exactOrigin(env[`${ENV}_GATEWAY_ORIGIN`]);
  const origins = [appOrigin, ...previewOrigins(env.PREVIEW_ORIGINS, appOrigin, gatewayOrigin, 'position-plan-bridge')];
  if (env[`${ENV}_BRIDGE_ENABLED`] !== 'true') return { origins, enabled: false };
  const secret = (value) => typeof value === 'string' && /^[\x21-\x7e]{1,1024}$/u.exec(value)?.[0] === value;
  if (!gatewayOrigin || gatewayOrigin === appOrigin || !secret(env[`${ENV}_ACCESS_CLIENT_ID`]) ||
      !secret(env[`${ENV}_ACCESS_CLIENT_SECRET`])) fail('upstream_unavailable');
  return { origins, enabled: true };
}

/** GET capabilities: local, no session, no upstream call. Browser checks as the read Worker's capabilities GET. */
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

export function createPositionPlanWorker(options = {}) {
  const worker = createAuthenticatedWorker({ ...runtime, PREFIX, HEADER, envPrefix: ENV,
    internalPrefix: '/internal/position-plan/v1/', limits: POSITION_PLAN_LIMITS,
    associated: (_route, body, data) => associated(body, data.plan),
    // A plan that is no longer good to sign is never shown (§2.4: preview_expired, quote again).
    assertFresh: (data) => { if (data.plan.expiresAt <= Date.now() / 1000) fail('preview_expired'); },
  }, options);
  return {
    async fetch(request, env = {}) {
      if (new URL(request.url).pathname === CAPABILITIES) return capabilities(request, env);
      return worker.fetch(request, env);
    },
  };
}

export default createPositionPlanWorker();
