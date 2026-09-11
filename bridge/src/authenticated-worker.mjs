import { parseStrictJson, JsonNumber } from './strict-json.mjs';
import { BridgeError, fail, exactOrigin, checkBrowser, jsonContentType, lengthWithin,
  cancelBody, deadline, readText, clientIp } from './worker.mjs';
import { credential } from '../../api-contracts/session-v1/runtime.mjs';

// Shared transport only. Each service supplies its closed contract and identity checks.
export function createAuthenticatedWorker(contract, { fetch: fetchImpl = globalThis.fetch,
  getClientIp = (request) => request.headers.get('CF-Connecting-IP') } = {}) {
  const { PREFIX, HEADER, CONTRACT_VERSION, ROUTES, ERROR_STATUS_BY_CODE,
    validateRequest, validateResponse, validateError } = contract;
  const LIMITS = contract.limits;
function config(env) {
  const appOrigin = exactOrigin(env.APP_ORIGIN);
  if (!appOrigin) fail('upstream_unavailable');
  if (env[contract.envPrefix + '_BRIDGE_ENABLED'] !== 'true') return { appOrigin, enabled: false };
  const gatewayOrigin = exactOrigin(env[contract.envPrefix + '_GATEWAY_ORIGIN']);
  const secret = (value) => typeof value === 'string' && /^[\x21-\x7e]{1,1024}$/u.exec(value)?.[0] === value;
  if (!gatewayOrigin || gatewayOrigin === appOrigin || !secret(env[contract.envPrefix + '_ACCESS_CLIENT_ID']) ||
      !secret(env[contract.envPrefix + '_ACCESS_CLIENT_SECRET'])) fail('upstream_unavailable');
  return { appOrigin, gatewayOrigin, enabled: true,
    clientId: env[contract.envPrefix + '_ACCESS_CLIENT_ID'], clientSecret: env[contract.envPrefix + '_ACCESS_CLIENT_SECRET'] };
}

// Only the session cookie enters this service. The preauth credential and every
// unrelated browser cookie remain outside onboarding's authentication boundary.
function sessionCookie(request) {
  const raw = request.headers.get('Cookie');
  if (raw === null) fail('session_required');
  if (new TextEncoder().encode(raw).length > LIMITS.cookiesBytes) fail('invalid_request');
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
  const remaining = LIMITS.totalMs - (Date.now() - started);
  if (remaining <= 0) fail('request_timeout');
  const scope = deadline(Math.min(LIMITS.upstreamMs, remaining), 'upstream_timeout',
    request.signal, started + LIMITS.totalMs);
  let response;
  try {
    scope.check();
    const pending = Promise.resolve(fetchImpl(`${settings.gatewayOrigin}${contract.internalPrefix}${route}`, {
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
    lengthWithin(response.headers, LIMITS.responseBytes, 'upstream_invalid_response');
    let data;
    try {
      data = integerLexemes(parseStrictJson(await readText(response.body, LIMITS.responseBytes,
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
      if (!valid || !contract.associated(route, body, data)) fail('upstream_contract_mismatch');
      contract.assertFresh(data);
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
        lengthWithin(request.headers, LIMITS.requestBytes, 'request_too_large');
        const scope = deadline(LIMITS.bodyMs, 'request_timeout', request.signal,
          Math.min(started + LIMITS.bodyMs, started + LIMITS.totalMs));
        let text, body;
        try {
          text = await readText(request.body, LIMITS.requestBytes, scope, 'request_too_large');
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
