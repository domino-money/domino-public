import { parseStrictJson } from './strict-json.mjs';
import { CHAIN_ID, CONTRACT_VERSION, ROUTES, isObject, validateRequest } from './request-contract.mjs';
import { ERROR_STATUS_BY_CODE, validateResponse } from '../../api-contracts/read-v1/runtime.mjs';

const CONTRACT_HEADER = 'X-Domino-Read-Contract';
const PREFIX = '/api/read/v1/';
export const LIMITS = Object.freeze({ requestBytes: 8192, responseBytes: 1024 * 1024, bodyMs: 5000, totalMs: 20000, upstreamMs: 15000 });

// Shared, finite and status-specific. Unknown producer failures never reach clients.
export { ERROR_STATUS_BY_CODE };

class BridgeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new BridgeError(code); };

function exactOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.origin === value ? value : null;
  } catch { return null; }
}

function config(env) {
  const appOrigin = exactOrigin(env.APP_ORIGIN);
  if (!appOrigin) fail('upstream_unavailable');
  if (env.READ_BRIDGE_ENABLED !== 'true') return { appOrigin, enabledReads: [] };
  const gatewayOrigin = exactOrigin(env.GATEWAY_ORIGIN);
  const enabledReads = typeof env.ENABLED_READS === 'string' && env.ENABLED_READS !== '' ? env.ENABLED_READS.split(',') : [];
  const secret = (value) => typeof value === 'string' && /^[\x21-\x7e]{1,1024}$/.test(value);
  if (!gatewayOrigin || gatewayOrigin === appOrigin || !enabledReads.length ||
      new Set(enabledReads).size !== enabledReads.length || enabledReads.some((route) => !Object.hasOwn(ROUTES, route)) ||
      !secret(env.ACCESS_CLIENT_ID) || !secret(env.ACCESS_CLIENT_SECRET)) fail('upstream_unavailable');
  return { appOrigin, gatewayOrigin, enabledReads, clientId: env.ACCESS_CLIENT_ID, clientSecret: env.ACCESS_CLIENT_SECRET };
}

function checkBrowser(request, appOrigin, capability) {
  const url = new URL(request.url);
  if (url.origin !== appOrigin || (request.headers.has('Host') && request.headers.get('Host') !== url.host)) fail('origin_not_allowed');
  const origin = request.headers.get('Origin');
  if ((!capability || origin !== null) && origin !== appOrigin) fail('origin_not_allowed');
  for (const [header, accepted] of [
    ['Sec-Fetch-Site', ['same-origin']],
    ['Sec-Fetch-Mode', ['cors', 'same-origin']],
    ['Sec-Fetch-Dest', ['empty']],
  ]) {
    const value = request.headers.get(header);
    if (value !== null && !accepted.includes(value)) fail('origin_not_allowed');
  }
  if (request.headers.has('Sec-Fetch-User')) fail('origin_not_allowed');
}

function jsonContentType(headers) {
  return /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(headers.get('Content-Type') ?? '');
}

function lengthWithin(headers, max, code) {
  const length = headers.get('Content-Length');
  if (length === null) return;
  if (!/^(0|[1-9][0-9]*)$/.test(length)) fail(code);
  if (BigInt(length) > BigInt(max)) fail(code);
}

function cancelBody(body) {
  try { Promise.resolve(body?.cancel()).catch(() => {}); } catch { /* Already closed/locked. */ }
}

// Cancellation is raced explicitly: an upstream or test transport cannot extend
// the budget by ignoring AbortSignal. Aborting still reaches the real fetch.
function deadline(milliseconds, code, parentSignal, absoluteLimit = Infinity) {
  const controller = new AbortController();
  const expiresAt = Math.min(Date.now() + milliseconds, absoluteLimit);
  const abort = (reason) => { if (!controller.signal.aborted) controller.abort(reason); };
  const check = () => {
    // Timers cannot run during synchronous parsing or before a fulfilled promise
    // continuation. The absolute clock check closes both gaps.
    if (Date.now() >= expiresAt) abort(new BridgeError(code));
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  const onParentAbort = () => abort(new BridgeError('request_timeout'));
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => abort(new BridgeError(code)), Math.max(0, expiresAt - Date.now()));
  const aborted = new Promise((_, reject) => {
    if (controller.signal.aborted) reject(controller.signal.reason);
    else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  // This scope can fail validation before its first asynchronous operation.
  aborted.catch(() => {});
  return {
    signal: controller.signal,
    expiresAt,
    check,
    async run(operation) {
      const pending = Promise.race([operation, aborted]);
      try {
        check();
        const result = await pending;
        check();
        return result;
      } catch (error) {
        pending.catch(() => {});
        check();
        throw error;
      }
    },
    dispose() { clearTimeout(timer); parentSignal?.removeEventListener('abort', onParentAbort); },
  };
}

async function readText(body, limit, scope, errorCode) {
  scope.check();
  if (!body) return '';
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  let finished = false;
  try {
    while (true) {
      const { done, value } = await scope.run(reader.read());
      if (done) { finished = true; break; }
      if (!(value instanceof Uint8Array)) fail(errorCode);
      size += value.byteLength;
      if (size > limit) fail(errorCode);
      chunks.push(value);
    }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
    scope.check();
    return text;
  } finally {
    if (!finished) {
      try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Best effort. */ }
    }
    reader.releaseLock();
  }
}

function headersFor(requestId, extra = {}) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    [CONTRACT_HEADER]: CONTRACT_VERSION,
    'X-Domino-Request-Id': requestId,
    ...extra,
  };
}

function errorResponse(code, requestId, extra) {
  return new Response(JSON.stringify({ error: code }), { status: ERROR_STATUS_BY_CODE[code], headers: headersFor(requestId, extra) });
}

function clientIp(value) {
  if (typeof value !== 'string' || value.length > 45) return null;
  if (/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(value)) {
    return value.split('.').every((part) => Number(part) <= 255) ? value : null;
  }
  if (!/^[0-9a-fA-F:.]+$/.test(value) || !value.includes(':')) return null;
  try { new URL(`https://[${value}]/`); return value; } catch { return null; }
}

function retryAfter(headers) {
  const value = headers.get('Retry-After');
  return /^[0-9]{1,3}$/.test(value ?? '') && Number(value) >= 1 && Number(value) <= 60 ? String(Number(value)) : '1';
}

async function upstreamRead(request, body, route, settings, fetchImpl, trustedIp, started, requestId) {
  const ip = clientIp(trustedIp);
  if (!ip) fail('upstream_unavailable');
  const remaining = LIMITS.totalMs - (Date.now() - started);
  if (remaining <= 0) fail('request_timeout');
  const scope = deadline(Math.min(LIMITS.upstreamMs, remaining), 'upstream_timeout', request.signal, started + LIMITS.totalMs);
  let response;
  try {
    scope.check();
    const pending = Promise.resolve(fetchImpl(`${settings.gatewayOrigin}/internal/read/v1/${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [CONTRACT_HEADER]: CONTRACT_VERSION,
        'CF-Access-Client-Id': settings.clientId,
        'CF-Access-Client-Secret': settings.clientSecret,
        'X-Domino-Client-Id': ip,
      },
      body,
      redirect: 'manual',
      signal: scope.signal,
    }));
    // Close a late body after a transport that ignored cancellation settles.
    pending.then((late) => { if (scope.signal.aborted) cancelBody(late?.body); }, () => {});
    response = await scope.run(pending);
    if (!(response instanceof Response)) fail('upstream_invalid_response');
    if ((response.status >= 300 && response.status <= 399) || response.status === 401 || response.status === 403) fail('upstream_unavailable');
    if (response.status >= 500 && ![502, 503, 504].includes(response.status)) fail('upstream_unavailable');
    // Access/infrastructure can return login HTML with a misleading 200. Inspect
    // media before version negotiation so it remains an availability failure.
    if (!jsonContentType(response.headers)) fail('upstream_unavailable');
    if (response.headers.get(CONTRACT_HEADER) !== CONTRACT_VERSION) fail('upstream_contract_mismatch');
    // Native fetch supplies decoded bytes. Identity is explicit on our gateway;
    // reject encoded responses instead of relying on runtime decoding ambiguity.
    const encoding = response.headers.get('Content-Encoding');
    if (encoding !== null && encoding !== 'identity') fail('upstream_invalid_response');
    lengthWithin(response.headers, LIMITS.responseBytes, 'upstream_invalid_response');
    let text, result;
    try {
      text = await readText(response.body, LIMITS.responseBytes, scope, 'upstream_invalid_response');
      scope.check();
      result = parseStrictJson(text);
      scope.check();
    } catch (error) {
      scope.check();
      if (error instanceof BridgeError) throw error;
      fail('upstream_invalid_response');
    }
    if (response.status === 200) {
      if (!isObject(result) || Object.hasOwn(result, 'error')) fail('upstream_invalid_response');
      if (result.schemaVersion !== ROUTES[route].schemaVersion || result.chainId !== CHAIN_ID) fail('upstream_contract_mismatch');
      const valid = validateResponse(route, result);
      scope.check();
      if (!valid) fail('upstream_contract_mismatch');
      // Both gateway and BFF validate the full pinned response schema. Preserve
      // original JSON bytes/names/numbers, including the gateway's opaque cursor.
      const output = new Response(text, { status: 200, headers: headersFor(requestId) });
      scope.check();
      return output;
    }
    if (!isObject(result) || Object.keys(result).length !== 1 || typeof result.error !== 'string') fail('upstream_invalid_response');
    if (!Object.hasOwn(ERROR_STATUS_BY_CODE, result.error) || ERROR_STATUS_BY_CODE[result.error] !== response.status) fail('upstream_unavailable');
    const output = errorResponse(result.error, requestId, response.status === 429 ? { 'Retry-After': retryAfter(response.headers) } : undefined);
    scope.check();
    return output;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    if (scope.signal.aborted) throw scope.signal.reason;
    fail('upstream_unavailable');
  } finally {
    cancelBody(response?.body);
    scope.dispose();
  }
}

// The only injectable dependency is transport/edge metadata for offline tests.
// Both factory and production entry enforce the same env flags and limits.
export function createWorker({ fetch: fetchImpl = globalThis.fetch, getClientIp = (request) => request.headers.get('CF-Connecting-IP') } = {}) {
  return {
    async fetch(request, env = {}) {
      const requestId = crypto.randomUUID();
      const started = Date.now();
      try {
        const settings = config(env);
        const url = new URL(request.url);
        const route = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : null;
        if (url.search || url.hash || !route || (route !== 'capabilities' && !Object.hasOwn(ROUTES, route))) fail('route_not_available');
        const capability = route === 'capabilities';
        if (request.method !== (capability ? 'GET' : 'POST')) fail('method_not_allowed');
        checkBrowser(request, settings.appOrigin, capability);
        const requestedContract = request.headers.get(CONTRACT_HEADER);
        if (requestedContract !== null && requestedContract !== CONTRACT_VERSION) fail('upstream_contract_mismatch');
        if (capability) {
          const output = new Response(JSON.stringify({
            contractVersion: CONTRACT_VERSION,
            dataMode: settings.enabledReads.length ? 'live_read_only' : 'disabled',
            chainId: CHAIN_ID,
            enabledReads: settings.enabledReads,
            walletAuthentication: false,
            privateAccounts: false,
            ownerTransactions: false,
            automation: false,
          }), { headers: headersFor(requestId) });
          if (Date.now() - started >= LIMITS.totalMs) fail('request_timeout');
          return output;
        }
        if (!settings.enabledReads.includes(route)) fail('route_not_available');
        const encoding = request.headers.get('Content-Encoding');
        if ((encoding !== null && encoding !== 'identity') || !jsonContentType(request.headers)) fail('json_required');
        lengthWithin(request.headers, LIMITS.requestBytes, 'request_too_large');
        const remaining = LIMITS.totalMs - (Date.now() - started);
        if (remaining <= 0) fail('request_timeout');
        const scope = deadline(Math.min(LIMITS.bodyMs, remaining), 'request_timeout', request.signal, started + LIMITS.totalMs);
        let text, body;
        try {
          text = await readText(request.body, LIMITS.requestBytes, scope, 'request_too_large');
          scope.check();
          body = parseStrictJson(text, { numberLexemes: true });
          scope.check();
          const valid = validateRequest(route, body);
          scope.check();
          if (!valid) fail('invalid_request');
        } catch (error) {
          scope.check();
          if (error instanceof BridgeError) throw error;
          fail('invalid_request');
        } finally { scope.dispose(); }
        return await upstreamRead(request, text, route, settings, fetchImpl, getClientIp(request), started, requestId);
      } catch (error) {
        const code = error instanceof BridgeError ? error.code : 'upstream_unavailable';
        return errorResponse(code, requestId);
      }
    },
  };
}

// Cloudflare overwrites CF-Connecting-IP on Internet ingress. Mount this entry
// only on the documented trusted edge; arbitrary Node/HTTP servers cannot prove
// that a same-named header is connection metadata. See ../README.md.
export default createWorker();

// Internal transport primitives shared with the separate session Worker. This
// exports no reader dispatch or service credentials; read routes stay unchanged.
export { BridgeError, fail, exactOrigin, checkBrowser, jsonContentType, lengthWithin,
  cancelBody, deadline, readText, clientIp };
