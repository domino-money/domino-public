/**
 * The producer pin, checked against the bytes the build imports.
 *
 * src/lib/read/pin.ts records the version and manifest digest of every
 * api-contracts package this app is built against. The app reads those
 * packages in place through the `api-contracts/*` alias, so if a producer
 * change lands in the tree, the digest recomputed here stops matching and CI
 * fails before any screen renders a payload the adapter was not tested with.
 *
 * Line endings matter: a checkout that rewrites manifest.json to CRLF changes
 * its digest and fails this test. That is the correct outcome, not a flake.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as runtime from '../../api-contracts/read-v1/runtime.mjs';

const require = createRequire(import.meta.url);
const { PRODUCER_PIN, ACCEPTED_READ_CONTRACTS, REQUEST_READ_CONTRACT, READ_V2_PIN, READ_V3_PIN, PERFORMANCE_V2_PIN, EXECUTION_V1_PIN } = require('../.test-build/app/src/lib/read/pin.js');

const CONTRACTS = resolve(import.meta.dirname, '../../api-contracts');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('read-v2 estimate pin matches the package and every consumed file', () => {
  const bytes = readFileSync(join(CONTRACTS, 'read-v2', 'manifest.json'));
  const manifest = JSON.parse(bytes);
  assert.equal(sha256(bytes), READ_V2_PIN.manifestSha256);
  assert.equal(manifest.contractVersion, READ_V2_PIN.version);
  for (const file of manifest.files) assert.equal(sha256(readFileSync(join(CONTRACTS, 'read-v2', file.path))), file.sha256, file.path);
});

test('read-v3 stored public read pin matches the package and every consumed file', () => {
  const bytes = readFileSync(join(CONTRACTS, 'read-v3', 'manifest.json'));
  const manifest = JSON.parse(bytes);
  assert.equal(sha256(bytes), READ_V3_PIN.manifestSha256);
  assert.equal(manifest.contractVersion, READ_V3_PIN.version);
  for (const file of manifest.files) assert.equal(sha256(readFileSync(join(CONTRACTS, 'read-v3', file.path))), file.sha256, file.path);
});

test('the pin names exactly the four producer packages', () => {
  assert.deepEqual(Object.keys(PRODUCER_PIN.packages).sort(), ['deposit-v1', 'onboarding-v1', 'read-v1', 'session-v1']);
  assert.match(PRODUCER_PIN.producerCommit, /^[0-9a-f]{40}$/, 'the producer commit must be a full SHA, never a branch name');
});

for (const [name, pinned] of Object.entries(PRODUCER_PIN.packages)) {
  test(`${name}: manifest.json hashes to the pinned SHA-256 and declares the pinned version`, () => {
    const bytes = readFileSync(join(CONTRACTS, name, 'manifest.json'));
    assert.equal(sha256(bytes), pinned.manifestSha256, `${name}/manifest.json drifted from the pin`);
    assert.equal(JSON.parse(bytes.toString('utf8')).contractVersion, pinned.version, `${name} version drifted from the pin`);
  });
}

test('read-v1: every file the manifest lists hashes as listed', () => {
  // The manifest digest alone would let an edited fixture or runtime through
  // if manifest.json itself were left untouched. These are the files the
  // adapter imports and the tests feed it.
  const manifest = JSON.parse(readFileSync(join(CONTRACTS, 'read-v1', 'manifest.json'), 'utf8'));
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 200, 'read-v1 manifest lists its files');
  const drifted = manifest.files
    .filter((file) => sha256(readFileSync(join(CONTRACTS, 'read-v1', file.path))) !== file.sha256)
    .map((file) => file.path);
  assert.deepEqual(drifted, [], `read-v1 files that no longer match their manifest entry: ${drifted.join(', ')}`);
});

test('the runtime, the fixture index and the accepted header all agree with the pin', () => {
  const version = PRODUCER_PIN.packages['read-v1'].version;
  const index = JSON.parse(readFileSync(join(CONTRACTS, 'read-v1', 'fixtures', 'index.json'), 'utf8'));
  assert.equal(runtime.CONTRACT_VERSION, version);
  assert.equal(index.contractVersion, version);
  assert.equal(REQUEST_READ_CONTRACT, version);
  assert.deepEqual([...ACCEPTED_READ_CONTRACTS], [version], 'exactly the pinned candidate is accepted, no range');
});

test('performance-v2 private numeric contract matches every consumed file', () => {
  const bytes = readFileSync(join(CONTRACTS, 'performance-v2', 'manifest.json'));
  const manifest = JSON.parse(bytes);
  assert.equal(sha256(bytes), PERFORMANCE_V2_PIN.manifestSha256);
  assert.equal(manifest.contractVersion, PERFORMANCE_V2_PIN.version);
  for (const file of manifest.files) assert.equal(sha256(readFileSync(join(CONTRACTS, 'performance-v2', file.path))), file.sha256, file.path);
});

test('execution-v1 has an exact version and source artifact manifest pin',()=>{
  const bytes=readFileSync(join(CONTRACTS,'execution-v1','manifest.json'));
  const manifest=JSON.parse(bytes);
  assert.equal(sha256(bytes),EXECUTION_V1_PIN.manifestSha256);
  assert.equal(manifest.contractVersion,EXECUTION_V1_PIN.version);
  for(const file of manifest.files)assert.equal(sha256(readFileSync(join(CONTRACTS,'execution-v1',file.path))),file.sha256,file.path);
});
