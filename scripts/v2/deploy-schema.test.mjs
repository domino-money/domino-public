import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { repoRoot, readJson, canonical, DEPLOY_ORDER } from './deploy.mjs';
import { validateManifest, checkSchema, checkSemantics, isDateTime, MANIFEST_SCHEMA } from './deploy-schema.mjs';

const fixture = () => readJson(join(repoRoot, 'scripts/v2/deploy-fixtures/deployment.fixture.json'));
const mutated = change => { const d = fixture(); change(d); return d; };
const committedManifests = () => [join(repoRoot, 'scripts/v2/deploy-fixtures/deployment.fixture.json'),
  ...readdirSync(join(repoRoot, 'docs/deployments')).filter(d => d.startsWith('v2-')).flatMap(d => readdirSync(join(repoRoot, 'docs/deployments', d))
    .filter(f => f.endsWith('deployment.json')).map(f => join(repoRoot, 'docs/deployments', d, f)))];

test('every committed V2 manifest satisfies the schema file and the semantic rules', () => {
  const files = committedManifests();
  assert(files.length >= 4, 'the local fixture and the three rehearsal manifests');
  for (const file of files) { const m = readJson(file); checkSchema(MANIFEST_SCHEMA, m); validateManifest(m); }
});

test('the validator enforces the schema exactly: each case the schema alone refuses (#306)', () => {
  const receipt = change => d => change(d.deploymentReceipts.registry);
  for (const [label, change] of Object.entries({
    'a numeric gasUsed': receipt(r => { r.gasUsed = 1932617; }),
    'a numeric effectiveGasPrice': receipt(r => { r.effectiveGasPrice = 1; }),
    'a padded gas price': receipt(r => { r.effectiveGasPrice = '01'; }),
    'a receipt key more': receipt(r => { r.status = '0x1'; }),
    'a hex block number': receipt(r => { r.blockNumber = '0x3e8'; }),
    'a numeric release tag': d => { d.releaseTag = 1; },
    'a null release tag': d => { d.releaseTag = null; },
    'no block tag': d => { delete d.verification.blockTag; },
    'a numeric block tag': d => { d.verification.blockTag = 5; },
    'a verification key more': d => { d.verification.signer = d.roles.deployer; },
    'a numeric check time': d => { d.verification.checkedAt = 0; },
    'a check time that is no time': d => { d.verification.checkedAt = 'yesterday'; },
    'a build key more': d => { d.build.solc = '0.8.26'; },
    'a charge currency key more': d => { d.chargeCurrencies[0].symbol = 'USDC'; },
    'an empty native currency': d => { d.chain.nativeCurrency = ''; },
    'a numeric native currency': d => { d.chain.nativeCurrency = 1; },
    'a top-level key more': d => { d.extra = 1; },
    'a float schema version': d => { d.schemaVersion = 1.5; },
    'a boolean schema version': d => { d.schemaVersion = true; },
    'a string chain id': d => { d.chain.chainId = '31337'; },
    'an upper-case hash': d => { d.runtimeCodeHashes.registry = d.runtimeCodeHashes.registry.toUpperCase().replace('0X', '0x'); },
    'a checksummed role': d => { d.roles.governance = '0x' + d.roles.governance.slice(2).toUpperCase(); },
    'a string for source changes': d => { d.build.workingTreeSourceChanges = 'false'; },
    'a source path that climbs': d => { d.build.sourceHashes['src/v2/../Domino.sol'] = '0'.repeat(64); },
    'a source outside v2': d => { d.build.sourceHashes['src/Domino.sol'] = '0'.repeat(64); },
  })) assert.throws(() => validateManifest(mutated(change)), Error, label);
  const prepared = mutated(d => { d.status = 'prepared'; d.verification = null; d.deploymentReceipts = {}; });
  validateManifest(prepared);
  for (const [label, change] of Object.entries({
    'a list of receipts': d => { d.deploymentReceipts = []; },
    'receipts': d => { d.deploymentReceipts = fixture().deploymentReceipts; },
    'a verification': d => { d.verification = fixture().verification; },
  })) { const d = structuredClone(prepared); change(d); assert.throws(() => validateManifest(d), Error, 'prepared with ' + label); }
});

test('the indexer\'s receipt and verification rules, as backend/v2_manifest.py applies them', () => {
  const blocks = d => Object.values(d.deploymentReceipts);
  for (const [label, change] of Object.entries({
    'a receipt in the genesis block': d => { d.deploymentReceipts.registry.blockNumber = 0; },
    'a zero transaction hash': d => { d.deploymentReceipts.registry.transactionHash = '0x' + '0'.repeat(64); },
    'a zero block hash': d => { d.deploymentReceipts.registry.blockHash = '0x' + '0'.repeat(64); },
    'two hashes for one block': d => { d.deploymentReceipts['zap.v3'].blockNumber = d.deploymentReceipts['zap.v4'].blockNumber; d.deploymentReceipts['zap.v3'].blockHash = '0x' + 'ab'.repeat(32); },
    'a verification before the receipts': d => { d.verification.blockNumber = Math.min(...blocks(d).map(r => r.blockNumber)) - 1; },
    'a verification that disagrees with its block\'s receipt': d => { d.verification.blockNumber = d.deploymentReceipts['zap.v4'].blockNumber; d.verification.blockHash = '0x' + 'cd'.repeat(32); },
    'a zero verification hash': d => { d.verification.blockHash = '0x' + '0'.repeat(64); },
    'a check time without a zone': d => { d.verification.checkedAt = '2026-10-02T12:00:00'; },
    'one transaction for two components': d => { d.deploymentReceipts['zap.v3'].transactionHash = d.deploymentReceipts['zap.v4'].transactionHash; },
    'a receipt for an executor': d => { d.deploymentReceipts['vaultExecutor.v3'] = { ...d.deploymentReceipts.registry }; },
    'a missing receipt': d => { delete d.deploymentReceipts['zap.v4']; },
  })) assert.throws(() => validateManifest(mutated(change)), Error, label);
  // Receipts may share a block, and that block's hash, with the verification.
  validateManifest(mutated(d => {
    const last = d.deploymentReceipts['zap.v4'];
    for (const name of ['zap.v3', 'zap.v4']) Object.assign(d.deploymentReceipts[name], { blockNumber: d.verification.blockNumber, blockHash: d.verification.blockHash });
    assert.ok(last);
  }));
  assert.deepEqual(Object.keys(fixture().deploymentReceipts).sort(), [...DEPLOY_ORDER].sort());
});

test('date-time: RFC 3339 with a zone, a real calendar day, checked field by field', () => {
  for (const value of ['2026-10-02T12:00:00.000Z', '2026-10-02T12:00:00Z', '2026-10-02T12:00:00.123456789Z', '2026-10-02T12:00:00.000+00:00',
    '2026-10-02T12:00:00-03:00', '2028-02-29T00:00:00Z', '2000-02-29T00:00:00Z', '2026-10-02T23:59:59+23:59']) assert(isDateTime(value), value);
  for (const value of ['2026-02-30T00:00:00Z', '2100-02-29T00:00:00Z', '2026-12-31T23:59:60Z', '2026-10-02T24:00:00Z', '2026-13-02T12:00:00Z',
    '2026-10-02T12:00:00+24:00', '2026-10-02T12:00:00+23:60', '2026-10-02T12:60:00Z', '0000-01-01T00:00:00Z', '2026-10-02T12:00:00.Z',
    '2026-10-02T12:00:00+0000', '2026-10-02t12:00:00z', '2026-10-02 12:00:00Z', '2026-10-02T12:00:00.1234567890Z', '2026-10-02T12:00:00',
    '2026-10-02', '٢٠٢٦-10-02T12:00:00Z', '2026-00-10T00:00:00Z', '2026-10-00T00:00:00Z', '2026-10-02T12:00:00Zjunk',
    'x2026-10-02T12:00:00Z', '2026-10-02T12:00:00Z\n', 0, null]) assert(!isDateTime(value), String(value));
});

test('the schema check refuses a keyword it does not implement instead of ignoring it', () => {
  assert.throws(() => checkSchema({ type: 'string', maxLength: 3 }, 'abcd'), /schema_keyword_unsupported: maxLength/);
  assert.throws(() => checkSchema({ oneOf: [{ type: 'string', maxLength: 3 }] }, 'a'), /schema_keyword_unsupported/);
  assert.throws(() => checkSchema({ type: 'string', format: 'email' }, 'a@b'), /manifest_schema_violation: \$ format/);
  checkSchema({ type: 'object', required: ['a'], properties: { a: { const: 1 } }, additionalProperties: false, minProperties: 1 }, { a: 1.0 });
  assert.throws(() => checkSchema({ type: 'object', additionalProperties: false, properties: {} }, { a: 1 }), /additionalProperties a/);
  assert.throws(() => checkSchema({ oneOf: [{ type: 'integer' }, { type: 'number' }] }, 1), /oneOf/);
  assert.throws(() => checkSchema({ type: 'string', minLength: 2 }, '😀'), /minLength/);
});

test('each schema keyword, alone: what the manifest schema uses, and nothing else', () => {
  const refuses = (schema, value, keyword) => assert.throws(() => checkSchema(schema, value), new RegExp('manifest_schema_violation: \\S+ ' + keyword));
  for (const [type, good, bad] of [['object', {}, []], ['array', [], {}], ['string', 'a', 1], ['boolean', true, 0], ['null', null, 0],
    ['integer', 1, 1.5], ['number', 1.5, 'x']]) { checkSchema({ type }, good); refuses({ type }, bad, 'type'); }
  checkSchema({ const: { a: [1, true] } }, { a: [1, true] }); refuses({ const: 1 }, 2, 'const');
  checkSchema({ enum: ['a', 'b'] }, 'b'); refuses({ enum: ['a'] }, 'b', 'enum');
  checkSchema({ pattern: '^a+$' }, 'aa'); refuses({ pattern: '^a+$' }, 'ab', 'pattern');
  checkSchema({ minLength: 2 }, 'ab'); refuses({ minLength: 3 }, 'ab', 'minLength');
  checkSchema({ format: 'date-time' }, '2026-10-02T00:00:00Z'); refuses({ format: 'date-time' }, '2026-10-02', 'format');
  refuses({ format: 'email' }, '2026-10-02T00:00:00Z', 'format');
  checkSchema({ minimum: 1 }, 1); refuses({ minimum: 1 }, 0, 'minimum');
  checkSchema({ maximum: 1 }, 1); refuses({ maximum: 1 }, 2, 'maximum');
  checkSchema({ minItems: 1 }, [1]); refuses({ minItems: 2 }, [1], 'minItems');
  checkSchema({ items: { type: 'string' } }, ['a']); refuses({ items: { type: 'string' } }, ['a', 1], 'type');
  refuses({ required: ['a'] }, {}, 'required a');
  checkSchema({ minProperties: 1 }, { a: 1 }); refuses({ minProperties: 1 }, {}, 'minProperties');
  refuses({ properties: { a: { type: 'string' } } }, { a: 1 }, 'type');
  refuses({ additionalProperties: false, properties: { a: {} } }, { a: 1, b: 1 }, 'additionalProperties b');
  checkSchema({ additionalProperties: { type: 'string' } }, { b: 'x' }); refuses({ additionalProperties: { type: 'string' } }, { b: 1 }, 'type');
  checkSchema({ oneOf: [{ type: 'null' }, { type: 'object' }] }, null);
  refuses({ oneOf: [{ type: 'string' }, { type: 'object' }] }, 1, 'oneOf');
  // A keyword applies to its own type only, as JSON Schema says.
  checkSchema({ minLength: 5, pattern: '^x$', minimum: 3, minItems: 2, required: ['a'] }, true);
});

test('the semantic rules stand on their own: each case refused without the schema file', () => {
  const receipt = change => d => change(d.deploymentReceipts.registry);
  const cases = {
    'a top-level key more': d => { d.extra = 1; }, 'another kind': d => { d.kind = 'x'; }, 'another status': d => { d.status = 'deployed'; },
    'another environment': d => { d.environment = 'production'; }, 'a disabled chain outside local tests': d => { d.environment = 'fork-rehearsal'; },
    'a chain key more': d => { d.chain.slug = 'x'; }, 'a zero chain id': d => { d.chain.chainId = 0; }, 'no chain name': d => { d.chain.name = ''; },
    'no native currency': d => { d.chain.nativeCurrency = ''; }, 'a short commit': d => { d.sourceCommit = 'abc'; },
    'a release tag with a path': d => { d.releaseTag = 'v2/x'; }, 'another contract name': d => { d.contractNames.registry = 'X'; },
    'another tariff': d => { d.policies.autoExitFeeBps = 25; }, 'a role missing': d => { delete d.roles.guardian; },
    'a checksummed role': d => { d.roles.guardian = '0x' + d.roles.guardian.slice(2).toUpperCase(); },
    'a placeholder role': d => { d.roles.guardian = '0x' + '1'.repeat(40); }, 'a publisher who operates': d => { d.roles.publisher = d.roles.operator; },
    'an address its salt does not give': d => { d.contracts.registry = '0x' + '9'.repeat(40); },
    'a role that is a component': d => { d.roles.feeRecipient = d.contracts.registry; },
    'a role that is CreateX': d => { d.roles.governance = '0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed'; },
    'a CreateX key more': d => { d.createx.deployer = d.roles.deployer; }, 'an unguarded salt': d => { d.createx.guardedSalts.registry = d.createx.salts.registry; },
    'another CreateX': d => { d.createx.address = '0x' + '4'.repeat(40); },
    'a dependency missing': d => { delete d.dependencies.v4Quoter; }, 'a zero dependency': d => { d.dependencies.permit2 = '0x' + '0'.repeat(40); },
    'a code hash missing': d => { delete d.runtimeCodeHashes['vaultExecutor.v4']; }, 'a zero code hash': d => { d.runtimeCodeHashes.registry = '0x' + '0'.repeat(64); },
    'one charge currency': d => { d.chargeCurrencies = d.chargeCurrencies.slice(0, 1); }, 'a currency key more': d => { d.chargeCurrencies[0].symbol = 'X'; },
    'a rank of zero': d => { d.chargeCurrencies[0].rank = 0; }, 'a currency twice': d => { d.chargeCurrencies.push({ ...d.chargeCurrencies[0] }); },
    'another compiler': d => { d.build.version = '0.8.27'; }, 'a build key more': d => { d.build.solc = 'x'; },
    'a source outside v2': d => { d.build.sourceHashes['src/Domino.sol'] = '0'.repeat(64); },
    'a tree hash that is not the sources': d => { d.build.sourceTreeSha256 = '0'.repeat(64); },
    'a string for source changes': d => { d.build.workingTreeSourceChanges = 'false'; },
    'receipts as a list': d => { d.deploymentReceipts = []; }, 'a receipt missing': d => { delete d.deploymentReceipts['zap.v4']; },
    'a receipt key more': receipt(r => { r.status = '0x1'; }), 'a numeric gas': receipt(r => { r.gasUsed = 1; }),
    'a receipt in the genesis block': receipt(r => { r.blockNumber = 0; }), 'a zero transaction hash': receipt(r => { r.transactionHash = '0x' + '0'.repeat(64); }),
    'a zero block hash': receipt(r => { r.blockHash = '0x' + '0'.repeat(64); }),
    'two hashes for one block': d => { d.deploymentReceipts['zap.v3'].blockNumber = d.deploymentReceipts['zap.v4'].blockNumber; d.deploymentReceipts['zap.v3'].blockHash = '0x' + 'ab'.repeat(32); },
    'one transaction for two components': d => { d.deploymentReceipts['zap.v3'].transactionHash = d.deploymentReceipts['zap.v4'].transactionHash; },
    'no verification': d => { d.verification = null; }, 'a verification key more': d => { d.verification.signer = 'x'; },
    'a numeric block tag': d => { d.verification.blockTag = 5; }, 'unverified code hashes': d => { d.verification.codeHashes = 'x'; },
    'a verification before the receipts': d => { d.verification.blockNumber = 1; },
    'a zero verification hash': d => { d.verification.blockHash = '0x' + '0'.repeat(64); },
    'a check time without a zone': d => { d.verification.checkedAt = '2026-10-02T12:00:00'; },
  };
  checkSemantics(fixture());
  for (const [label, change] of Object.entries(cases)) assert.throws(() => checkSemantics(mutated(change)), Error, label);
  // A source path that is not well-formed text, even with the tree hash JavaScript would compute for it.
  const surrogate = mutated(d => { d.build.sourceHashes['src/v2/\ud800.sol'] = '0'.repeat(64);
    d.build.sourceTreeSha256 = createHash('sha256').update(canonical(d.build.sourceHashes)).digest('hex'); });
  assert.throws(() => checkSemantics(surrogate), /manifest_build_invalid/);
  for (const value of [null, [], 'x', 1]) assert.throws(() => checkSemantics(value), /manifest_fields_invalid/);
});
