import { JsonNumber, parseStrictJson } from './strict-json.mjs';
import { CHAIN_ID, CONTRACT_VERSION, ROUTES, isObject, validateRequest } from './request-contract.mjs';
import { ERROR_STATUS_BY_CODE, validateResponse } from '../../api-contracts/read-v1/runtime.mjs';
import {
  CONTRACT_VERSION as V2_CONTRACT_VERSION, ERROR_STATUS_BY_CODE as V2_ERROR_STATUS_BY_CODE,
  validateRequest as validateV2Request, validateResponse as validateV2Response,
} from '../../api-contracts/read-v2/runtime.mjs';
import {
  CONTRACT_VERSION as V3_CONTRACT_VERSION, ERROR_STATUS_BY_CODE as V3_ERROR_STATUS_BY_CODE,
  ROUTES as V3_ROUTES, validateRequest as validateV3Request, validateResponse as validateV3Response,
  matchesRequest as matchesV3Request,
} from '../../api-contracts/read-v3/runtime.mjs';
import {
  CONTRACT_VERSION as V4_CONTRACT_VERSION, ERROR_STATUS_BY_CODE as V4_ERROR_STATUS_BY_CODE,
  ROUTES as V4_ROUTES, validateRequest as validateV4Request,
  validateResponse as validateV4Response, matchesRequest as matchesV4Request,
} from '../../api-contracts/read-v4/runtime.mjs';
import {
  CONTRACT_VERSION as V5_CONTRACT_VERSION, CONTRACT_VERSIONS as V5_CONTRACT_VERSIONS,
  ERROR_STATUS_BY_CODE as V5_ERROR_STATUS_BY_CODE, ROUTES as V5_ROUTES, validateRequest as validateV5Request,
  validateResponse as validateV5Response, matchesRequest as matchesV5Request,
} from '../../api-contracts/read-v5/runtime.mjs';
import {
  CONTRACT_VERSION as V6_CONTRACT_VERSION, CONTRACT_VERSIONS as V6_CONTRACT_VERSIONS, NEXT_VERSION as V6_NEXT_VERSION,
  ERROR_STATUS_BY_CODE as V6_ERROR_STATUS_BY_CODE, ROUTES as V6_ROUTES, NEXT_ROUTES as V6_NEXT_ROUTES,
  validateRequest as validateV6Request, validateResponse as validateV6Response, validateExchange as validateV6Exchange,
} from '../../api-contracts/read-v6/runtime.mjs';
import { CONSTANTS as V6_CONSTANTS } from '../../api-contracts/read-v6/schema-data.mjs';

const CONTRACT_HEADER = 'X-Domino-Read-Contract';
// Only the exact public path chooses a protocol. Neither deployment variables
// nor browser payloads can select another upstream path or response validator.
const V1_PROTOCOL = Object.freeze({
  prefix: '/api/read/v1/', upstreamPrefix: '/internal/read/v1/', version: CONTRACT_VERSION,
  enabledFlag: 'READ_BRIDGE_ENABLED', readsFlag: 'ENABLED_READS', routes: ROUTES,
  validateRequest, validateResponse, errors: ERROR_STATUS_BY_CODE,
  matchesRequest: () => true,
});
const V2_PROTOCOL = Object.freeze({
  prefix: '/api/read/v2/', upstreamPrefix: '/internal/read/v2/', version: V2_CONTRACT_VERSION,
  enabledFlag: 'READ_V2_BRIDGE_ENABLED', readsFlag: 'ENABLED_V2_READS',
  routes: Object.freeze({ 'pool-market': Object.freeze({ schemaVersion: 1 }) }),
  validateRequest: validateV2Request, validateResponse: validateV2Response, errors: V2_ERROR_STATUS_BY_CODE,
  matchesRequest: (request, response) => request.poolId === response.poolId,
});
const V3_PROTOCOL = Object.freeze({
  prefix: '/api/read/v3/', upstreamPrefix: '/internal/read/v3/', version: V3_CONTRACT_VERSION,
  enabledFlag: 'READ_V3_BRIDGE_ENABLED', readsFlag: 'ENABLED_V3_READS', routes: V3_ROUTES,
  validateRequest: validateV3Request, validateResponse: validateV3Response, errors: V3_ERROR_STATUS_BY_CODE,
  matchesRequest: (request, response, route) => matchesV3Request(route, request, response),
});
const V4_PROTOCOL = Object.freeze({
  prefix: '/api/read/v4/', upstreamPrefix: '/internal/read/v4/', version: V4_CONTRACT_VERSION,
  enabledFlag: 'READ_V4_BRIDGE_ENABLED', readsFlag: 'ENABLED_V4_READS', routes: V4_ROUTES,
  validateRequest: validateV4Request, validateResponse: validateV4Response,
  errors: V4_ERROR_STATUS_BY_CODE, matchesRequest: matchesV4Request,
});
// The featured pools list (featured-pools v1 §10.3): one stored route whose
// request names nothing, so every visitor asks the same question.
// Since 2026-09-28 (rugged's featured-policy v2 handoff) it speaks rc.2 and still
// takes rc.1, from the browser and from the gateway, while the VM moves to rc.2:
// `versions` is every version accepted, `version` the one this Worker speaks.
const V5_PROTOCOL = Object.freeze({
  prefix: '/api/read/v5/', upstreamPrefix: '/internal/read/v5/', version: V5_CONTRACT_VERSION,
  versions: V5_CONTRACT_VERSIONS,
  enabledFlag: 'READ_V5_BRIDGE_ENABLED', readsFlag: 'ENABLED_V5_READS', routes: V5_ROUTES,
  validateRequest: validateV5Request, validateResponse: validateV5Response,
  errors: V5_ERROR_STATUS_BY_CODE, matchesRequest: matchesV5Request,
});
// Domino V2's wallet reads (read-v6 1.0.0-rc.1, spec F7 §6.2; added 2026-10-02, the bridge side of #305): portfolio
// ({wallet}) and activity ({wallet, limit?, cursor?}), one wallet's V2 state and receipts on Robinhood Chain, Base and
// Arbitrum One. Off until READ_V6_BRIDGE_ENABLED is exactly "true" and ENABLED_V6_READS names its routes; the gateway
// serves them only with --enable-v6 and DOMINO_BRIDGE_V6_READS. Unlike read-v1 to read-v5 an answer covers three
// chains, so it carries `chains` (the runtime checks all three, in order) and no top-level chainId: `chainIds` marks
// that. Its request has integers (activity's `limit`), read from their exact lexemes as read-v3's are. The exchange
// check is the package's own validateExchange: the answer is about the wallet asked for, and a page is no longer than
// asked.
//
// Since 6 Nov 2026 (launch round P3, docs/v2/V2_FEES.md "What the app and the read Worker need"; the read-v6 README's
// "1.2.0-rc.1: position-fees, and its window") it also speaks 1.2.0-rc.1 and takes both versions (`versions`, as
// read-v5's protocol does). 1.2.0-rc.1 adds position-fees (NEXT_ROUTES: Fees earned on Base and Arbitrum One) and
// changes no other answer but its version. Unlike read-v5's window:
//   - each route names the versions it exists in: 1.1.0-rc.1's five in both, position-fees in 1.2.0-rc.1 alone;
//   - a request is read, sent upstream and answered in the version it names, else in its route's first, as the reader
//     and the gateway answer it (backend/v2_read_contract.py answered_version): `answersAsAsked`. A 1.1.0-rc.1 request
//     is so exactly what it was before, and its answer can never be 1.2.0-rc.1's, which today's app refuses;
//   - `version` stays 1.1.0-rc.1: what a capabilities GET naming no version, and a refusal written before a request's
//     version is read, speak, as before. Speaking 1.2.0-rc.1 by default would move those, and every route's upstream
//     call, to a version today's app and today's gateway do not read;
//   - position-fees is not there (404 route_not_available, before any other check, as before 1.2.0-rc.1 existed)
//     unless ENABLED_V6_READS names it and the request is in 1.2.0-rc.1; and the capabilities list only the reads of
//     the version asked, so a 1.1.0-rc.1 page never meets a route it does not know.
const V6_PROTOCOL = Object.freeze({
  prefix: '/api/read/v6/', upstreamPrefix: '/internal/read/v6/', version: V6_CONTRACT_VERSION,
  versions: V6_CONTRACT_VERSIONS, answersAsAsked: true,
  enabledFlag: 'READ_V6_BRIDGE_ENABLED', readsFlag: 'ENABLED_V6_READS',
  routes: Object.freeze(Object.fromEntries([
    ...V6_ROUTES.map((route) => [route, Object.freeze({ schemaVersion: 1, versions: V6_CONTRACT_VERSIONS })]),
    ...V6_NEXT_ROUTES.map((route) => [route, Object.freeze({ schemaVersion: 1, versions: Object.freeze([V6_NEXT_VERSION]) })]),
  ])),
  validateRequest: validateV6Request, validateResponse: validateV6Response, errors: V6_ERROR_STATUS_BY_CODE,
  matchesRequest: (request, response, route) => validateV6Exchange(route, request, response),
  // Changed on purpose 2026-11-07 (Elysium, day 9): the package's own chains (CONSTANTS.chainIds), which its runtime holds
  // every answer to, not the three written out: read-v6 names Elysium (99901) from rugged97's day-9 version, and this
  // Worker's capabilities then say so with no edit here. Today the package's list is the three, in this order.
  chainIds: Object.freeze([...V6_CONSTANTS.chainIds]),
});
export const LIMITS = Object.freeze({ requestBytes: 8192, responseBytes: 1024 * 1024, bodyMs: 5000, totalMs: 20000, upstreamMs: 15000 });

// Shared, finite and status-specific. Unknown producer failures never reach clients.
export { ERROR_STATUS_BY_CODE };

// Every contract version a protocol takes in X-Domino-Read-Contract: its own, or
// the list it declares (read-v5, during its rc.1 to rc.2 transition).
const acceptedVersions = (protocol) => protocol.versions ?? [protocol.version];

// Whether `route` exists in `version`: the route's own list (read-v6's, during its 1.2.0-rc.1 window), else every
// version its protocol takes, as before.
const routeIn = (protocol, route, version) => protocol.routes[route].versions?.includes(version) ?? true;

// The version a request naming none is read in: its route's first (read-v6's position-fees: 1.2.0-rc.1), else the
// protocol's own, as before.
const firstVersion = (protocol, route) => protocol.routes[route].versions?.[0] ?? protocol.version;

// Whether a path's route is there for this request. A route of a newer version alone (read-v6's position-fees) is not,
// exactly as before that version existed, unless the protocol's reads flag names it and the request names one of its
// versions (or none: its first). Every other route of the protocol is there, as before.
function routeThere(protocol, route, settings, named) {
  if (!Object.hasOwn(protocol.routes, route)) return false;
  if (routeIn(protocol, route, protocol.version)) return true;
  return settings.enabledReads.includes(route) && routeIn(protocol, route, named ?? firstVersion(protocol, route));
}

class BridgeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new BridgeError(code); };

// V3's generated validator consumes JS integers, while the strict parser keeps
// raw number spelling. Convert only exact safe integer lexemes; 24.0, 24e0 and
// values rounded by Number are not equivalent to a strict producer integer.
function safeRequestIntegers(value) {
  if (value instanceof JsonNumber) {
    if (!/^-?(0|[1-9][0-9]*)$/.test(value.source)) fail('invalid_request');
    const number = Number(value.source);
    if (!Number.isSafeInteger(number)) fail('invalid_request');
    return number;
  }
  if (Array.isArray(value)) return value.map(safeRequestIntegers);
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = safeRequestIntegers(value[key]);
  }
  return value;
}

function exactOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.origin === value ? value : null;
  } catch { return null; }
}

function config(env, protocol) {
  const appOrigin = exactOrigin(env.APP_ORIGIN);
  if (!appOrigin) fail('upstream_unavailable');
  if (env[protocol.enabledFlag] !== 'true') return { appOrigin, enabledReads: [] };
  const gatewayOrigin = exactOrigin(env.GATEWAY_ORIGIN);
  const configuredReads = env[protocol.readsFlag];
  const enabledReads = typeof configuredReads === 'string' && configuredReads !== '' ? configuredReads.split(',') : [];
  const secret = (value) => typeof value === 'string' && /^[\x21-\x7e]{1,1024}$/.test(value);
  if (!gatewayOrigin || gatewayOrigin === appOrigin || !enabledReads.length ||
      new Set(enabledReads).size !== enabledReads.length || enabledReads.some((route) => !Object.hasOwn(protocol.routes, route)) ||
      !secret(env.ACCESS_CLIENT_ID) || !secret(env.ACCESS_CLIENT_SECRET)) fail('upstream_unavailable');
  return { appOrigin, gatewayOrigin, enabledReads, clientId: env.ACCESS_CLIENT_ID, clientSecret: env.ACCESS_CLIENT_SECRET };
}

// Since 4 Nov 2026 (launch round P3, item 7: testing without real money), a private family's Worker (session and the
// authenticated transport) also admits the Pages preview origins PREVIEW_ORIGINS lists, comma-separated, besides
// APP_ORIGIN. Each is one exact origin compared as a whole string: https, a lower-case DNS name and nothing else (no
// port, path, wildcard or IP), the form the listeners' SIWE policy takes (backend/session_siwe.py), at most
// MAX_PREVIEW_ORIGINS, none twice, none APP_ORIGIN and none the Worker's own gateway. Unset or empty lists none, every
// Worker's behaviour before. Why an exact list keeps the boundary: docs/PREVIEW_PUBLIC_READS.md, "Preview origins".
//
// A list that breaks a rule turns preview admission off, and only that (review L3, same day): APP_ORIGIN keeps
// serving, every preview request is refused as an unlisted origin, and each request logs `preview_origins_invalid`
// (wrangler tail; the private Workers keep no logs) until the list is fixed. It used to answer upstream_unavailable to
// production too.
export const MAX_PREVIEW_ORIGINS = 4;
const PREVIEW_ORIGIN = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function previewOrigins(value, appOrigin, gatewayOrigin, service) {
  if (value === undefined || value === '') return [];
  const listed = typeof value === 'string' ? value.split(',') : null;
  // The pattern admits only a URL's own serialized origin (lower case, no port, path, userinfo or trailing dot), so
  // the string compared below is the one a browser sends in Origin for that host.
  if (listed !== null && listed.length <= MAX_PREVIEW_ORIGINS && new Set(listed).size === listed.length &&
      listed.every((origin) => origin.length <= 261 && PREVIEW_ORIGIN.test(origin) && origin !== appOrigin && origin !== gatewayOrigin)) {
    return listed;
  }
  console.error(JSON.stringify({ service, error: 'preview_origins_invalid', previewAdmission: 'off' }));
  return [];
}

// The browser origin a request comes from, when it is one of `origins` (APP_ORIGIN, then any preview origin): the
// request URL's own origin, which the Origin header must name exactly, so a page on one admitted origin can never
// speak for another through a third's host. Returned so the Worker tells its listener which one it admitted
// (X-Domino-Browser-Origin), never a value the browser chose that this check did not compare.
function browserOrigin(request, origins, capability) {
  const url = new URL(request.url);
  if (!origins.includes(url.origin) || (request.headers.has('Host') && request.headers.get('Host') !== url.host)) fail('origin_not_allowed');
  const origin = request.headers.get('Origin');
  if ((!capability || origin !== null) && origin !== url.origin) fail('origin_not_allowed');
  for (const [header, accepted] of [
    ['Sec-Fetch-Site', ['same-origin']],
    ['Sec-Fetch-Mode', ['cors', 'same-origin']],
    ['Sec-Fetch-Dest', ['empty']],
  ]) {
    const value = request.headers.get(header);
    if (value !== null && !accepted.includes(value)) fail('origin_not_allowed');
  }
  if (request.headers.has('Sec-Fetch-User')) fail('origin_not_allowed');
  return url.origin;
}

// The read Worker and the public families admit APP_ORIGIN alone, as before.
function checkBrowser(request, appOrigin, capability) {
  browserOrigin(request, [appOrigin], capability);
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

// `version` is the contract the reply speaks: the protocol's own, the one the
// browser asked in, or, for a relayed answer, the one the gateway answered in.
function headersFor(requestId, version, extra = {}) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    [CONTRACT_HEADER]: version,
    'X-Domino-Request-Id': requestId,
    ...extra,
  };
}

function errorResponse(code, requestId, protocol, extra, version = protocol.version) {
  return new Response(JSON.stringify({ error: code }), { status: protocol.errors[code], headers: headersFor(requestId, version, extra) });
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

async function upstreamRead(request, body, payload, route, settings, fetchImpl, trustedIp, started, requestId, protocol, version) {
  const ip = clientIp(trustedIp);
  if (!ip) fail('upstream_unavailable');
  const remaining = LIMITS.totalMs - (Date.now() - started);
  if (remaining <= 0) fail('request_timeout');
  const scope = deadline(Math.min(LIMITS.upstreamMs, remaining), 'upstream_timeout', request.signal, started + LIMITS.totalMs);
  let response;
  try {
    scope.check();
    const pending = Promise.resolve(fetchImpl(`${settings.gatewayOrigin}${protocol.upstreamPrefix}${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // read-v6 goes on in the version the request was read in; read-v1 to read-v5 in the protocol's own, as before.
        [CONTRACT_HEADER]: protocol.answersAsAsked ? version : protocol.version,
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
    const answered = response.headers.get(CONTRACT_HEADER);
    if (!acceptedVersions(protocol).includes(answered)) fail('upstream_contract_mismatch');
    // read-v6 answers in the version asked. The gateway writes the refusals it makes before it reads that version (a
    // route it does not serve, a method) in its first, so a refusal may also speak that one; an answer never does.
    if (protocol.answersAsAsked && answered !== version && (response.status === 200 || answered !== protocol.version)) {
      fail('upstream_contract_mismatch');
    }
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
      // A multi-chain protocol (read-v6) names no single chain: its runtime checks every chain the answer carries.
      if (result.schemaVersion !== protocol.routes[route].schemaVersion || (!protocol.chainIds && result.chainId !== CHAIN_ID)) fail('upstream_contract_mismatch');
      // Where two versions pass, the answer names the one its header does.
      if (protocol.versions && result.contractVersion !== answered) fail('upstream_contract_mismatch');
      const valid = protocol.validateResponse(route, result) && protocol.matchesRequest(payload, result, route);
      scope.check();
      if (!valid) fail('upstream_contract_mismatch');
      // Both gateway and BFF validate the full pinned response schema. Preserve
      // original JSON bytes/names/numbers, including the gateway's opaque cursor.
      // Relayed in the version it was answered in: an rc.1 list stays rc.1 (the app takes both).
      const output = new Response(text, { status: 200, headers: headersFor(requestId, answered) });
      scope.check();
      return { response: output, version: answered };
    }
    if (!isObject(result) || Object.keys(result).length !== 1 || typeof result.error !== 'string') fail('upstream_invalid_response');
    if (!Object.hasOwn(protocol.errors, result.error) || protocol.errors[result.error] !== response.status) fail('upstream_unavailable');
    const output = errorResponse(result.error, requestId, protocol, response.status === 429 ? { 'Retry-After': retryAfter(response.headers) } : undefined, version);
    scope.check();
    // The code is already checked against the reviewed table above, so the
    // record can name it without reading the relayed body back.
    return { response: output, reason: result.error };
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
      let protocol = V1_PROTOCOL;
      // The contract this reply speaks, once the browser's header is checked: the one it asked in, else the protocol's.
      let version = null;
      // The raw URL never reaches the record: only a declared route name does.
      let loggedRoute = 'unmatched';
      const finish = (response, reason) => {
        // An upstream-mapped error answers with its own reviewed code in the
        // body's shape; the record names it rather than leaving the line silent.
        console.log(JSON.stringify({
          service: 'read-bridge', requestId, route: loggedRoute,
          contractVersion: version ?? protocol.version,
          // Bounded like the Python hops: a method is short or it is not one.
          method: String(request.method).slice(0, 16),
          status: response.status, durationMs: Date.now() - started,
          ...(reason ? { reason } : {}),
        }));
        return response;
      };
      try {
        const url = new URL(request.url);
        if (url.pathname.startsWith(V6_PROTOCOL.prefix)) protocol = V6_PROTOCOL;
        else if (url.pathname.startsWith(V5_PROTOCOL.prefix)) protocol = V5_PROTOCOL;
        else if (url.pathname.startsWith(V4_PROTOCOL.prefix)) protocol = V4_PROTOCOL;
        else if (url.pathname.startsWith(V3_PROTOCOL.prefix)) protocol = V3_PROTOCOL;
        else if (url.pathname.startsWith(V2_PROTOCOL.prefix)) protocol = V2_PROTOCOL;
        const settings = config(env, protocol);
        const route = url.pathname.startsWith(protocol.prefix) ? url.pathname.slice(protocol.prefix.length) : null;
        const requestedContract = request.headers.get(CONTRACT_HEADER);
        if (url.search || url.hash || !route || (route !== 'capabilities' && !routeThere(protocol, route, settings, requestedContract))) fail('route_not_available');
        const capability = route === 'capabilities';
        loggedRoute = route;
        if (request.method !== (capability ? 'GET' : 'POST')) fail('method_not_allowed');
        checkBrowser(request, settings.appOrigin, capability);
        if (requestedContract !== null && !acceptedVersions(protocol).includes(requestedContract)) fail('upstream_contract_mismatch');
        version = requestedContract ?? (capability ? protocol.version : firstVersion(protocol, route));
        if (capability) {
          // The reads of the version asked: read-v6's 1.1.0-rc.1 capabilities never name position-fees.
          const reads = settings.enabledReads.filter((name) => routeIn(protocol, name, version));
          const output = new Response(JSON.stringify({
            contractVersion: version,
            dataMode: reads.length ? 'live_read_only' : 'disabled',
            // read-v6 reads three chains, so it says which; read-v1 to read-v5 say their one chain, as before.
            ...(protocol.chainIds ? { chainIds: protocol.chainIds } : { chainId: CHAIN_ID }),
            enabledReads: reads,
            walletAuthentication: false,
            privateAccounts: false,
            ownerTransactions: false,
            automation: false,
          }), { headers: headersFor(requestId, version) });
          if (Date.now() - started >= LIMITS.totalMs) fail('request_timeout');
          return finish(output);
        }
        if (!settings.enabledReads.includes(route) || !routeIn(protocol, route, version)) fail('route_not_available');
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
          if (protocol === V3_PROTOCOL || protocol === V6_PROTOCOL) body = safeRequestIntegers(body);
          scope.check();
          const valid = protocol.validateRequest(route, body);
          scope.check();
          if (!valid) fail('invalid_request');
        } catch (error) {
          scope.check();
          if (error instanceof BridgeError) throw error;
          fail('invalid_request');
        } finally { scope.dispose(); }
        const relayed = await upstreamRead(request, text, body, route, settings, fetchImpl, getClientIp(request), started, requestId, protocol, version);
        if (relayed.version) version = relayed.version;
        return finish(relayed.response, relayed.reason);
      } catch (error) {
        const code = error instanceof BridgeError ? error.code : 'upstream_unavailable';
        return finish(errorResponse(code, requestId, protocol, undefined, version ?? protocol.version), code);
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
  cancelBody, deadline, readText, clientIp, previewOrigins, browserOrigin };
