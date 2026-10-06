/**
 * The crosschain-v1 pin (spec F7 §3.1, §3.2): src/v2/crosschain/version.ts records the version and the SHA-256 of
 * api-contracts/crosschain-v1/manifest.json, and every file the manifest lists still hashes as listed, the way
 * tests/contract-pin.test.mjs checks read-v2. Line endings matter: a checkout that rewrites a file to CRLF changes its
 * digest and fails here. That is the correct outcome, not a flake.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { build, PACKAGE, runtime } from './support/crosschain.mjs';

const { CROSSCHAIN_V1_PIN, CROSSCHAIN_CONTRACT, CROSSCHAIN_HEADER } = build('version');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('manifest.json hashes to the pinned SHA-256 and declares the pinned version, package and status', () => {
  const bytes = readFileSync(join(PACKAGE, 'manifest.json'));
  assert.equal(bytes.includes(13), false, 'manifest.json has LF endings only');
  assert.equal(sha256(bytes), CROSSCHAIN_V1_PIN.manifestSha256, 'crosschain-v1/manifest.json drifted from the pin');
  const manifest = JSON.parse(bytes.toString('utf8'));
  assert.equal(manifest.contract, 'crosschain-v1');
  assert.equal(manifest.contract, CROSSCHAIN_V1_PIN.package);
  assert.equal(manifest.contractVersion, CROSSCHAIN_V1_PIN.version);
  assert.equal(manifest.status, CROSSCHAIN_V1_PIN.status);
  assert.equal(manifest.status, 'candidate_disabled_pending_keys_and_worker', 'the service is still off: no wiring may assume otherwise');
});

test('every file the manifest lists hashes as listed, the shared closed-schema helper included', () => {
  const manifest = JSON.parse(readFileSync(join(PACKAGE, 'manifest.json'), 'utf8'));
  assert.ok(Array.isArray(manifest.files) && manifest.files.length >= 28, 'the manifest lists its files');
  for (const required of ['runtime.mjs', 'runtime.d.mts', 'types.ts', 'schema-data.mjs', '../shared/closed-schema.mjs', 'fixtures/errors.json']) {
    assert.ok(manifest.files.some((file) => file.path === required), `${required} is pinned`);
  }
  const drifted = manifest.files.filter((file) => sha256(readFileSync(join(PACKAGE, file.path))) !== file.sha256).map((file) => file.path);
  assert.deepEqual(drifted, [], `crosschain-v1 files that no longer match their manifest entry: ${drifted.join(', ')}`);
});

// Changed on purpose (data) 2026-10-06: 1.0.0-rc.1 -> 1.1.0-rc.1 (quoting by output; the listener's switch window).
test('the version sent, the version accepted, the runtime and the generated types agree on 1.1.0-rc.1', () => {
  assert.equal(CROSSCHAIN_CONTRACT, '1.1.0-rc.1');
  assert.equal(CROSSCHAIN_V1_PIN.version, CROSSCHAIN_CONTRACT);
  assert.equal(runtime.CONTRACT_VERSION, CROSSCHAIN_CONTRACT);
  assert.match(readFileSync(join(PACKAGE, 'types.ts'), 'utf8'), /export type CrosschainContractVersion = "1\.1\.0-rc\.1";/);
  assert.equal(CROSSCHAIN_HEADER, 'X-Domino-Crosschain-Contract');
  assert.ok(Object.isFrozen(CROSSCHAIN_V1_PIN));
});
