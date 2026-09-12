/**
 * The session-v1 package as the tests see it: its runtime validators and
 * fixtures, read in place from api-contracts/, plus the SIWE layout the
 * producer issues. Nothing here is copied from the package.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const PACKAGE = resolve(import.meta.dirname, '../../../api-contracts/session-v1');
export const runtime = await import(new URL('../../../api-contracts/session-v1/runtime.mjs', import.meta.url).href);

const read = (path) => JSON.parse(readFileSync(resolve(PACKAGE, path), 'utf8'));
const ROUTES = ['bootstrap', 'challenge', 'verify', 'me', 'refresh', 'logout'];

export const FIXTURES = {
  errors: read('fixtures/errors.json'),
  requests: Object.fromEntries(ROUTES.map((route) => [route, read(`fixtures/requests/${route}.json`)])),
  responses: Object.fromEntries(ROUTES.map((route) => [route, read(`fixtures/responses/${route}.json`)])),
};

export const STATEMENT = 'Sign in to Domino. This request does not authorize transactions or automation.';

/** The EIP-4361 message exactly as backend/session_siwe.py lays it out. */
export function siweMessage({ origin, address, nonce, issuedAt, expiresAt, chainId = 4663 }) {
  return [
    `${origin} wants you to sign in with your Ethereum account:`,
    address,
    '',
    STATEMENT,
    '',
    `URI: ${origin}/`,
    'Version: 1',
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiresAt}`,
  ].join('\n');
}

/** RFC 3339 in whole seconds, the only form the producer issues. */
export const utc = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
