import { fail } from './worker.mjs';
import { createAuthenticatedWorker } from './authenticated-worker.mjs';
import * as runtime from '../../api-contracts/onboarding-v1/runtime.mjs';

const PREFIX = '/api/onboarding/v1/';
const HEADER = 'X-Domino-Onboarding-Contract';
const IDENTITIES = new Set(['tokenIn', 'tokenOut', 'poolId', 'currency0', 'currency1', 'hooks', 'independentToken']);
export const ONBOARDING_LIMITS = Object.freeze({ requestBytes: 8192, responseBytes: 128 * 1024,
  cookiesBytes: 8192, bodyMs: 5000, totalMs: 25000, upstreamMs: 20000 });

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

export function createOnboardingWorker(options = {}) {
  return createAuthenticatedWorker({ ...runtime, PREFIX, HEADER,
    envPrefix: 'ONBOARDING', internalPrefix: '/internal/onboarding/v1/', limits: ONBOARDING_LIMITS,
    associated: (_route, body, data) => associated(body, data.preview),
    assertFresh: (data) => { if (data.preview.expiresAt <= Date.now() / 1000) fail('preview_expired'); },
  }, options);
}

export default createOnboardingWorker();
