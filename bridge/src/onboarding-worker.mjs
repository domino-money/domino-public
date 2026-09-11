import { parseStrictJson, JsonNumber } from './strict-json.mjs';
import { BridgeError, fail, exactOrigin, checkBrowser, jsonContentType, lengthWithin,
  cancelBody, deadline, readText, clientIp } from './worker.mjs';
import { credential } from '../../api-contracts/session-v1/runtime.mjs';
import { CONTRACT_VERSION, ROUTES, ERROR_STATUS_BY_CODE,
  validateRequest, validateResponse, validateError } from '../../api-contracts/onboarding-v1/runtime.mjs';

const PREFIX = '/api/onboarding/v1/';
const HEADER = 'X-Domino-Onboarding-Contract';
const IDENTITIES = new Set(['tokenIn', 'tokenOut', 'poolId', 'currency0', 'currency1', 'hooks', 'independentToken']);
export const ONBOARDING_LIMITS = Object.freeze({ requestBytes: 8192, responseBytes: 128 * 1024,
  cookiesBytes: 8192, bodyMs: 5000, totalMs: 25000, upstreamMs: 20000 });

function config(env) {
  const appOrigin = exactOrigin(env.APP_ORIGIN);
  if (!appOrigin) fail('upstream_unavailable');
  if (env.ONBOARDING_BRIDGE_ENABLED !== 'true') return { appOrigin, enabled: false };
  const gatewayOrigin = exactOrigin(env.ONBOARDING_GATEWAY_ORIGIN);
  const secret = (value) => typeof value === 'string' && /^[\x21-\x7e]{1,1024}$/u.exec(value)?.[0] === value;
  if (!gatewayOrigin || gatewayOrigin === appOrigin || !secret(env.ONBOARDING_ACCESS_CLIENT_ID) ||
      !secret(env.ONBOARDING_ACCESS_CLIENT_SECRET)) fail('upstream_unavailable');
  return { appOrigin, gatewayOrigin, enabled: true,
    clientId: env.ONBOARDING_ACCESS_CLIENT_ID, clientSecret: env.ONBOARDING_ACCESS_CLIENT_SECRET };
}

// Only the session cookie enters this service. The preauth credential and every
// unrelated browser cookie remain outside onboarding's authentication boundary.
function sessionCookie(request) {
  const raw = request.headers.get('Cookie');
  if (raw === null) fail('session_required');
  if (new TextEncoder().encode(raw).length > ONBOARDING_LIMITS.cookiesBytes) fail('invalid_request');
  let value;
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    const name = (index < 0 ? part : part.slice(0, index)).trim();
    if (name !== '__Host-domino-session') continue;
    const candidate = index < 0 ? '' : part.slice(index + 1).trim();
    if (value !== undefined || !credential(candidate)) fail('invalid_request');
    value = candidate;
  }
  if (value === undefined) fail('session_required');
  return value;
}

// Never round a JSON decimal or exponent into an accepted policy integer.
// Monetary amounts remain strings throughout parsing, association and output.
function integerLexemes(value) {
  if (value instanceof JsonNumber) {
    if (!/^-?(0|[1-9][0-9]*)$/u.test(value.source)) throw new SyntaxError('integer_required');
    const number = Number(value.source);
    if (!Number.isSafeInteger(number)) throw new SyntaxError('unsafe_integer');
    return number;
  }
  if (Array.isArray(value)) return value.map(integerLexemes);
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = integerLexemes(value[key]);
  }
  return value;
}

function equivalent(actual, expected, name = '') {
  if (typeof actual === 'string' && typeof expected === 'string' && IDENTITIES.has(name)) {
    return actual.toLowerCase() === expected.toLowerCase();
  }
  if (actual !== null && expected !== null && typeof actual === 'object' && typeof expected === 'object') {
    const keys = Object.keys(actual);
    return keys.length === Object.keys(expected).length && keys.every((key) =>
      Object.hasOwn(expected, key) && equivalent(actual[key], expected[key], key));
  }
  return actual === expected;
}

function associated(body, preview) {
  // Owner is derived by the private backend from the opaque session; the BFF
  // has no browser-supplied account identity to compare or grant authority with.
  for (const [key, value] of Object.entries(preview.request)) {
    if (key === 'owner') continue;
    if (!equivalent(value, Object.hasOwn(body, key) ? body[key] : null, key)) return false;
  }
  const now = Date.now() / 1000;
  return preview.chainId === 4663 && preview.request.chainId === 4663 &&
    preview.requestedAt <= preview.retrievedAt &&
    preview.retrievedAt < preview.expiresAt && preview.requestedAt <= now + 5 &&
    preview.retrievedAt <= now + 5 && preview.expiresAt <= preview.requestedAt + 30;
}

function headersFor(id) {
  return new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    [HEADER]: CONTRACT_VERSION, 'X-Domino-Request-Id': id });
}

function errorResponse(code, id) {
  if (!Object.hasOwn(ERROR_STATUS_BY_CODE, code)) code = 'upstream_unavailable';
  const headers = headersFor(id);
  if (ERROR_STATUS_BY_CODE[code] === 429) headers.set('Retry-After', '60');
  return new Response(JSON.stringify({ error: code }), { status: ERROR_STATUS_BY_CODE[code], headers });
}

async function upstream(request, route, text, body, settings, fetchImpl, ip, session, csrf, started, id) {
  const remaining = ONBOARDING_LIMITS.totalMs - (Date.now() - started);
  if (remaining <= 0) fail('request_timeout');
  const scope = deadline(Math.min(ONBOARDING_LIMITS.upstreamMs, remaining), 'upstream_timeout',
    request.signal, started + ONBOARDING_LIMITS.totalMs);
  let response;
  try {
    scope.check();
    const pending = Promise.resolve(fetchImpl(`${settings.gatewayOrigin}/internal/onboarding/v1/${route}`, {
      method: 'POST', redirect: 'manual', signal: scope.signal, body: text,
      headers: { 'Content-Type': 'application/json', [HEADER]: CONTRACT_VERSION,
        'CF-Access-Client-Id': settings.clientId, 'CF-Access-Client-Secret': settings.clientSecret,
        'X-Domino-Client-Id': ip, 'X-Domino-Browser-Origin': settings.appOrigin,
        'X-Domino-Session': session, 'X-Domino-CSRF': csrf },
    }));
    pending.then((late) => { if (scope.signal.aborted) cancelBody(late?.body); }, () => {});
    response = await scope.run(pending);
    if (!(response instanceof Response) || response.status >= 300 && response.status < 400 ||
        !jsonContentType(response.headers)) fail('upstream_unavailable');
    if ([401, 403].includes(response.status) && response.headers.get(HEADER) !== CONTRACT_VERSION) fail('upstream_unavailable');
    if (response.headers.get(HEADER) !== CONTRACT_VERSION) fail('upstream_contract_mismatch');
    const encoding = response.headers.get('Content-Encoding');
    if (encoding !== null && encoding !== 'identity') fail('upstream_invalid_response');
    lengthWithin(response.headers, ONBOARDING_LIMITS.responseBytes, 'upstream_invalid_response');
    let data;
    try {
      data = integerLexemes(parseStrictJson(await readText(response.body, ONBOARDING_LIMITS.responseBytes,
        scope, 'upstream_invalid_response'), { numberLexemes: true }));
      scope.check();
    } catch (error) {
      scope.check();
      if (error instanceof BridgeError) throw error;
      fail('upstream_invalid_response');
    }
    if (response.status === 200) {
      const valid = validateResponse(route, data);
      scope.check();
      if (!valid || !associated(body, data.preview)) fail('upstream_contract_mismatch');
      if (data.preview.expiresAt <= Date.now() / 1000) fail('preview_expired');
      const publicJson = JSON.stringify(data);
      scope.check();
      // Serialization canonicalizes escaped input too. None of the credential
      // values, including printable service secrets, may escape through fields.
      if ([session, csrf, settings.clientId, settings.clientSecret].some((secret) =>
        publicJson.includes(JSON.stringify(secret).slice(1, -1)))) fail('upstream_contract_mismatch');
      scope.check();
      const output = new Response(publicJson, { status: 200, headers: headersFor(id) });
      scope.check();
      return output;
    }
    const validError = validateError(response.status, data);
    scope.check();
    if (!validError) fail('upstream_unavailable');
    return errorResponse(data.error, id);
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    if (scope.signal.aborted) throw scope.signal.reason;
    fail('upstream_unavailable');
  } finally { cancelBody(response?.body); scope.dispose(); }
}

export function createOnboardingWorker({ fetch: fetchImpl = globalThis.fetch,
  getClientIp = (request) => request.headers.get('CF-Connecting-IP') } = {}) {
  return {
    async fetch(request, env = {}) {
      const id = crypto.randomUUID(), started = Date.now();
      try {
        const settings = config(env);
        const url = new URL(request.url);
        const route = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : '';
        if (!ROUTES.includes(route) || url.search || url.hash) fail('route_not_available');
        if (request.method !== 'POST') fail('method_not_allowed');
        checkBrowser(request, settings.appOrigin, false);
        if (!settings.enabled) fail('route_not_available');
        const version = request.headers.get(HEADER);
        if (version !== null && version !== CONTRACT_VERSION) fail('upstream_contract_mismatch');
        const session = sessionCookie(request), csrf = request.headers.get('X-Domino-CSRF');
        if (!credential(csrf)) fail('csrf_invalid');
        const ip = clientIp(getClientIp(request));
        if (!ip) fail('upstream_unavailable');
        const encoding = request.headers.get('Content-Encoding');
        if (encoding !== null && encoding !== 'identity' || !jsonContentType(request.headers)) fail('json_required');
        lengthWithin(request.headers, ONBOARDING_LIMITS.requestBytes, 'request_too_large');
        const scope = deadline(ONBOARDING_LIMITS.bodyMs, 'request_timeout', request.signal,
          Math.min(started + ONBOARDING_LIMITS.bodyMs, started + ONBOARDING_LIMITS.totalMs));
        let text, body;
        try {
          text = await readText(request.body, ONBOARDING_LIMITS.requestBytes, scope, 'request_too_large');
          body = integerLexemes(parseStrictJson(text, { numberLexemes: true }));
          if (!validateRequest(route, body)) fail('invalid_request');
          scope.check();
        } catch (error) {
          scope.check();
          if (error instanceof BridgeError) throw error;
          fail('invalid_request');
        } finally { scope.dispose(); }
        return await upstream(request, route, text, body, settings, fetchImpl, ip, session, csrf, started, id);
      } catch (error) { return errorResponse(error instanceof BridgeError ? error.code : 'upstream_unavailable', id); }
    },
  };
}

// Only the reviewed Cloudflare Internet ingress can supply authoritative client
// metadata. This entry has no deployment route, signer or transaction behavior.
export default createOnboardingWorker();
