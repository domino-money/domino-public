import { parseStrictJson, JsonNumber } from './strict-json.mjs';
import { BridgeError, fail, exactOrigin, checkBrowser, jsonContentType, lengthWithin,
  cancelBody, deadline, readText, clientIp } from './worker.mjs';
import { CONTRACT_VERSION, ROUTES, ERROR_STATUS_BY_CODE, credential,
  validateRequest, validateEnvelope, validateError } from '../../api-contracts/session-v1/runtime.mjs';

const PREFIX = '/api/session/v1/';
const HEADER = 'X-Domino-Session-Contract';
export const SESSION_LIMITS = Object.freeze({ requestBytes: 8192, responseBytes: 16384, cookiesBytes: 8192, bodyMs: 5000, totalMs: 20000, upstreamMs: 15000 });

function config(env) {
  const appOrigin = exactOrigin(env.APP_ORIGIN);
  if (!appOrigin) fail('upstream_unavailable');
  if (env.SESSION_BRIDGE_ENABLED !== 'true') return { appOrigin, enabled: false };
  const gatewayOrigin = exactOrigin(env.SESSION_GATEWAY_ORIGIN);
  const secret = (value) => typeof value === 'string' && /^[\x21-\x7e]{1,1024}$/u.exec(value)?.[0] === value;
  if (!gatewayOrigin || gatewayOrigin === appOrigin || !secret(env.SESSION_ACCESS_CLIENT_ID) || !secret(env.SESSION_ACCESS_CLIENT_SECRET)) fail('upstream_unavailable');
  return { appOrigin, gatewayOrigin, enabled: true, clientId: env.SESSION_ACCESS_CLIENT_ID, clientSecret: env.SESSION_ACCESS_CLIENT_SECRET };
}

// Parse only our two exact cookie names. Duplicate credentials, quoted values
// and encodings fail closed; unrelated browser cookies never leave the BFF.
function credentials(request) {
  const raw = request.headers.get('Cookie');
  const result = {};
  if (raw === null) return result;
  if (new TextEncoder().encode(raw).length > SESSION_LIMITS.cookiesBytes) fail('invalid_request');
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    const name = (index < 0 ? part : part.slice(0, index)).trim();
    if (!['__Host-domino-preauth', '__Host-domino-session'].includes(name)) continue;
    const key = name.endsWith('preauth') ? 'preauth' : 'session';
    const value = index < 0 ? '' : part.slice(index + 1).trim();
    if (Object.hasOwn(result, key) || !credential(value)) fail('invalid_request');
    result[key] = value;
  }
  return result;
}

function headersFor(id) {
  return new Headers({
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    [HEADER]: CONTRACT_VERSION, 'X-Domino-Request-Id': id,
  });
}

function errorResponse(code, id) {
  if (!Object.hasOwn(ERROR_STATUS_BY_CODE, code)) code = 'upstream_unavailable';
  const headers = headersFor(id);
  if (ERROR_STATUS_BY_CODE[code] === 429) headers.set('Retry-After', '60');
  return new Response(JSON.stringify({ error: code }), { status: ERROR_STATUS_BY_CODE[code], headers });
}

function successResponse(envelope, id) {
  const headers = headersFor(id);
  for (const [name, token] of Object.entries(envelope.credentials)) {
    const maxAge = token === null ? 0 : name === 'preauth' ? 600 : 43200;
    headers.append('Set-Cookie', `__Host-domino-${name}=${token ?? ''}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
  }
  return new Response(JSON.stringify(envelope.result), { headers });
}

async function upstream(request, route, text, settings, fetchImpl, ip, cookies, csrf, started, id) {
  const remaining = SESSION_LIMITS.totalMs - (Date.now() - started);
  if (remaining <= 0) fail('request_timeout');
  const scope = deadline(Math.min(SESSION_LIMITS.upstreamMs, remaining), 'upstream_timeout', request.signal, started + SESSION_LIMITS.totalMs);
  let response;
  try {
    const headers = {
      'Content-Type': 'application/json', [HEADER]: CONTRACT_VERSION,
      'CF-Access-Client-Id': settings.clientId, 'CF-Access-Client-Secret': settings.clientSecret,
      'X-Domino-Client-Id': ip, 'X-Domino-Browser-Origin': settings.appOrigin,
    };
    for (const [name, value] of Object.entries(cookies)) headers[`X-Domino-${name}`] = value;
    if (csrf) headers['X-Domino-CSRF'] = csrf;
    scope.check();
    const pending = Promise.resolve(fetchImpl(`${settings.gatewayOrigin}/internal/session/v1/${route}`, {
      method: 'POST', headers, body: text, redirect: 'manual', signal: scope.signal,
    }));
    pending.then((late) => { if (scope.signal.aborted) cancelBody(late?.body); }, () => {});
    response = await scope.run(pending);
    if (!(response instanceof Response) || response.status >= 300 && response.status < 400 || !jsonContentType(response.headers)) fail('upstream_unavailable');
    if ([401, 403].includes(response.status) && response.headers.get(HEADER) !== CONTRACT_VERSION) fail('upstream_unavailable');
    if (response.headers.get(HEADER) !== CONTRACT_VERSION) fail('upstream_contract_mismatch');
    const encoding = response.headers.get('Content-Encoding');
    if (encoding !== null && encoding !== 'identity') fail('upstream_invalid_response');
    lengthWithin(response.headers, SESSION_LIMITS.responseBytes, 'upstream_invalid_response');
    let data;
    try {
      data = parseStrictJson(await readText(response.body, SESSION_LIMITS.responseBytes, scope, 'upstream_invalid_response'), { numberLexemes: true });
      // Do not let JS rounding turn a fractional/oversized chain selector into
      // Robinhood's integer. The other response fields contain no JSON numbers.
      const chain = data?.result?.owner?.chainId;
      if (chain instanceof JsonNumber && chain.source === '4663') data.result.owner.chainId = 4663;
      scope.check();
    } catch (error) {
      scope.check();
      if (error instanceof BridgeError) throw error;
      fail('upstream_invalid_response');
    }
    if (response.status === 200) {
      if (!validateEnvelope(route, data)) fail('upstream_contract_mismatch');
      const publicJson = JSON.stringify(data.result);
      const privateTokens = [...Object.values(cookies), ...Object.values(data.credentials)].filter((value) => value !== null);
      if (privateTokens.some((value) => publicJson.includes(value)) ||
          Object.values(data.credentials).some((value) => value !== null && value === csrf)) fail('upstream_contract_mismatch');
      scope.check();
      const output = successResponse(data, id);
      scope.check();
      return output;
    }
    if (!validateError(response.status, data)) fail('upstream_unavailable');
    scope.check();
    return errorResponse(data.error, id);
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    if (scope.signal.aborted) throw scope.signal.reason;
    fail('upstream_unavailable');
  } finally { cancelBody(response?.body); scope.dispose(); }
}

export function createSessionWorker({ fetch: fetchImpl = globalThis.fetch,
  getClientIp = (request) => request.headers.get('CF-Connecting-IP') } = {}) {
  return {
    async fetch(request, env = {}) {
      const id = crypto.randomUUID();
      const started = Date.now();
      try {
        const settings = config(env);
        const url = new URL(request.url);
        const route = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : '';
        if (!ROUTES.includes(route) || url.search || url.hash) fail('route_not_available');
        if (request.method !== (route === 'me' ? 'GET' : 'POST')) fail('method_not_allowed');
        checkBrowser(request, settings.appOrigin, route === 'me');
        if (!settings.enabled) fail('route_not_available');
        const requestedVersion = request.headers.get(HEADER);
        if (requestedVersion !== null && requestedVersion !== CONTRACT_VERSION) fail('upstream_contract_mismatch');
        const ip = clientIp(getClientIp(request));
        if (!ip) fail('upstream_unavailable');
        const cookies = credentials(request);
        const csrf = request.headers.get('X-Domino-CSRF');
        if (csrf !== null && !credential(csrf)) fail('csrf_invalid');
        if (['challenge', 'verify', 'refresh', 'logout'].includes(route) && csrf === null) fail('csrf_invalid');
        let text = '{}';
        const encoding = request.headers.get('Content-Encoding');
        if (encoding !== null && encoding !== 'identity') fail('json_required');
        if (route === 'me') {
          lengthWithin(request.headers, 0, 'invalid_request');
          if (request.body !== null || request.headers.has('Transfer-Encoding')) fail('invalid_request');
        } else {
          if (!jsonContentType(request.headers)) fail('json_required');
          lengthWithin(request.headers, SESSION_LIMITS.requestBytes, 'request_too_large');
          const scope = deadline(SESSION_LIMITS.bodyMs, 'request_timeout', request.signal, started + SESSION_LIMITS.totalMs);
          try {
            text = await readText(request.body, SESSION_LIMITS.requestBytes, scope, 'request_too_large');
            const body = parseStrictJson(text, { numberLexemes: true });
            if (route === 'challenge' && body?.chainId instanceof JsonNumber && body.chainId.source === '4663') body.chainId = 4663;
            if (!validateRequest(route, body)) fail('invalid_request');
            scope.check();
          } catch (error) {
            scope.check();
            if (error instanceof BridgeError) throw error;
            fail('invalid_request');
          } finally { scope.dispose(); }
        }
        return await upstream(request, route, text, settings, fetchImpl, ip, cookies, csrf, started, id);
      } catch (error) { return errorResponse(error instanceof BridgeError ? error.code : 'upstream_unavailable', id); }
    },
  };
}

// Requires Cloudflare's trusted Internet ingress metadata and its own Access
// application/Tunnel route. Never mount on an arbitrary header-trusting server.
export default createSessionWorker();
