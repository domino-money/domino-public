/**
 * The local check that runs before the wallet is shown a sign-in message.
 * The reference case is the package's own challenge fixture, on the reserved
 * https origin the producer issues for; every mutation of it must be refused.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { recoverMessageAddress } from 'viem';
import { FIXTURES, siweMessage } from './support/session-fixtures.mjs';

const require = createRequire(import.meta.url);
const { checkChallengeMessage } = require('../.test-build/app/src/session/siwe.js');

const ORIGIN = 'https://app.example.invalid';
const ADDRESS = FIXTURES.requests.challenge.address;
const { message: MESSAGE, expiresAt: EXPIRES } = FIXTURES.responses.challenge;
const EXPECTED = { origin: ORIGIN, address: ADDRESS, chainId: 4663, expiresAt: EXPIRES };

const check = (message, expected = {}) => checkChallengeMessage(message, { ...EXPECTED, ...expected });
const refused = (message, problem, expected) => assert.deepEqual(check(message, expected), { ok: false, problem });

test('the package fixture message is accepted as issued', () => {
  assert.deepEqual(check(MESSAGE), { ok: true });
  // The helper the fake service uses lays it out byte for byte the same.
  assert.equal(
    siweMessage({ origin: ORIGIN, address: ADDRESS, nonce: 'a'.repeat(32), issuedAt: '2026-09-10T12:00:00Z', expiresAt: EXPIRES }),
    MESSAGE,
  );
});

test("the fixture signature recovers to the fixture address with viem's EIP-191 encoding", async () => {
  // The producer verifies with eth-account; viem encodes the same personal_sign
  // prefix, so a signature the wallet makes through viem is one it accepts.
  const { message, signature } = FIXTURES.requests.verify;
  assert.equal(await recoverMessageAddress({ message, signature }), ADDRESS);
});

test('another origin, domain or URI is refused', () => {
  refused(MESSAGE, 'domain', { origin: 'https://evil.example' });
  refused(MESSAGE.replace('URI: https://app.example.invalid/', 'URI: https://evil.example/'), 'uri');
  refused(MESSAGE.replace('https://app.example.invalid wants', 'app.example.invalid wants'), 'domain');
});

test('another address or chain is refused', () => {
  refused(MESSAGE, 'address', { address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' });
  // Case matters: the line must be EIP-55, as the producer issues it.
  refused(MESSAGE.replace(ADDRESS, ADDRESS.toLowerCase()), 'address');
  refused(MESSAGE.replace('Chain ID: 4663', 'Chain ID: 1'), 'chain');
});

test('a changed statement, version or extra field is refused', () => {
  refused(MESSAGE.replace('does not authorize', 'authorizes'), 'statement');
  refused(MESSAGE.replace('Version: 1', 'Version: 2'), 'version');
  refused(`${MESSAGE}\nResources:\n- https://evil.example/approve`, 'layout');
  refused(MESSAGE.replace('\nIssued At:', '\nRequest ID: 1\nIssued At:'), 'layout');
});

test('CRLF line endings and oversized messages are refused', () => {
  refused(MESSAGE.replaceAll('\n', '\r\n'), 'encoding');
  refused(MESSAGE.replace('a'.repeat(32), 'a'.repeat(64)).padEnd(2100, 'x'), 'too_large');
});

test('the nonce follows the producer grammar: 32 to 64 ASCII letters and digits', () => {
  assert.deepEqual(check(MESSAGE.replace('a'.repeat(32), 'A1'.repeat(32))), { ok: true });
  refused(MESSAGE.replace('a'.repeat(32), 'a'.repeat(31)), 'nonce');
  refused(MESSAGE.replace('a'.repeat(32), `${'a'.repeat(31)}-`), 'nonce');
});

test('timestamps are whole-second UTC instants, and expiry is the response expiry', () => {
  refused(MESSAGE.replace('12:00:00Z', '12:00:00.123Z'), 'issued_at');
  refused(MESSAGE.replace('2026-09-10T12:00:00Z', '2026-02-30T12:00:00Z'), 'issued_at');
  refused(MESSAGE, 'expiration', { expiresAt: '2026-09-10T12:04:00Z' });
});

test('a challenge that lives longer than five minutes, or not at all, is refused', () => {
  const at = (issuedAt, expiresAt) =>
    siweMessage({ origin: ORIGIN, address: ADDRESS, nonce: 'a'.repeat(32), issuedAt, expiresAt });
  refused(at('2026-09-10T12:00:00Z', '2026-09-10T12:05:01Z'), 'lifetime', { expiresAt: '2026-09-10T12:05:01Z' });
  refused(at('2026-09-10T12:00:00Z', '2026-09-10T12:00:00Z'), 'lifetime', { expiresAt: '2026-09-10T12:00:00Z' });
});

test('the check is against the page origin, whatever it is', () => {
  // The browser tests run on http://127.0.0.1:<port>; production is https
  // without a port. The rule is the same: the message must name this page.
  const local = 'http://127.0.0.1:5290';
  const message = siweMessage({ origin: local, address: ADDRESS, nonce: 'a'.repeat(32), issuedAt: '2026-09-10T12:00:00Z', expiresAt: EXPIRES });
  assert.deepEqual(check(message, { origin: local }), { ok: true });
  refused(message, 'domain');
});
