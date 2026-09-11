// Closed session-v1 candidate contract. No financial authority is represented.
export const CONTRACT_VERSION = '2.0.0';
export const ROUTES = Object.freeze(['bootstrap', 'challenge', 'verify', 'me', 'refresh', 'logout']);
export const ERROR_STATUS_BY_CODE = Object.freeze({
  invalid_request: 400, session_required: 401, preauth_required: 401,
  invalid_signature: 401, challenge_invalid: 401,
  origin_not_allowed: 403, csrf_invalid: 403, account_unsupported: 403,
  route_not_available: 404, method_not_allowed: 405, session_exists: 409,
  request_too_large: 413, json_required: 415,
  session_rate_limited: 429, session_capacity_busy: 429,
  upstream_invalid_response: 502, upstream_contract_mismatch: 502,
  session_store_unavailable: 503, account_check_unavailable: 503, upstream_unavailable: 503,
  request_timeout: 504, upstream_timeout: 504,
});

export function keys(value, names) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [null, Object.prototype].includes(Object.getPrototypeOf(value)) &&
    Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
}
const matches = (value, pattern) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
export const credential = (value) => matches(value, /^[A-Za-z0-9_-]{43}$/u);
const challengeId = (value) => matches(value, /^[a-f0-9]{32}$/u);
const message = (value) => typeof value === 'string' && value.length > 0 && value.isWellFormed() && new TextEncoder().encode(value).length <= 2048;
const date = (value) => {
  if (!matches(value, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$/u)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19);
};

export function validateRequest(route, value) {
  if (['bootstrap', 'me', 'refresh', 'logout'].includes(route)) return keys(value, []);
  if (route === 'challenge') return keys(value, ['address', 'chainId']) && value.chainId === 4663 && matches(value.address, /^0x[0-9a-fA-F]{40}$/u);
  if (route === 'verify') return keys(value, ['challengeId', 'message', 'signature']) && challengeId(value.challengeId) && message(value.message) && matches(value.signature, /^0x[0-9a-fA-F]{130}$/u);
  return false;
}

export function validateResponse(route, value) {
  if (route === 'bootstrap') return keys(value, ['status', 'csrfToken', 'expiresAt']) && value.status === 'challenge_required' && credential(value.csrfToken) && date(value.expiresAt);
  if (route === 'challenge') return keys(value, ['challengeId', 'message', 'expiresAt']) && challengeId(value.challengeId) && message(value.message) && date(value.expiresAt);
  if (route === 'logout') return keys(value, ['authenticated']) && value.authenticated === false;
  if (!['verify', 'me', 'refresh'].includes(route)) return false;
  return keys(value, ['authenticated', 'owner', 'expiresAt', 'csrfToken', 'validation']) && value.authenticated === true &&
    keys(value.owner, ['address', 'chainId']) && value.owner.chainId === 4663 && matches(value.owner.address, /^0x[0-9a-f]{40}$/u) &&
    date(value.expiresAt) && credential(value.csrfToken) && keys(value.validation, ['method', 'blockNumber', 'blockHash']) &&
    value.validation.method === 'plain_eoa' && matches(value.validation.blockNumber, /^(?:0|[1-9][0-9]{0,19})$/u) &&
    matches(value.validation.blockHash, /^0x[0-9a-f]{64}$/u);
}

export function validateError(status, value) {
  return keys(value, ['error']) && typeof value.error === 'string' && Object.hasOwn(ERROR_STATUS_BY_CODE, value.error) && ERROR_STATUS_BY_CODE[value.error] === status;
}

// An internal success envelope is stripped at the BFF. Cookie instructions are
// not part of the browser contract and must never be exposed as response JSON.
export function validateEnvelope(route, value) {
  if (!keys(value, ['result', 'credentials']) || !validateResponse(route, value.result)) return false;
  const cookies = value.credentials;
  if (route === 'bootstrap') return keys(cookies, ['preauth']) && credential(cookies.preauth) && cookies.preauth !== value.result.csrfToken;
  if (route === 'verify') return keys(cookies, ['preauth', 'session']) && cookies.preauth === null && credential(cookies.session) && cookies.session !== value.result.csrfToken;
  if (route === 'logout') return keys(cookies, ['preauth', 'session']) && cookies.preauth === null && cookies.session === null;
  return keys(cookies, []);
}
