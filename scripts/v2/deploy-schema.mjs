/** The V2 deployment manifest: the structural schema (deploy-manifest.schema.json, validated here as a JSON
 * Schema) and the semantic rules. backend/v2_manifest.py `checked_manifest` applies the same rules, one for
 * one; backend/tests/test_v2_manifest.py runs both over the same documents and requires the same verdicts. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CONTRACT_NAMES, DEPLOY_ORDER, POLICIES, ROLE_NAMES, CREATE_X, CREATE_X_CODE_HASH, ENVIRONMENTS, ENABLED_CHAINS,
  precomputeAddresses, checkRoleAddresses, ensure, canonical } from './deploy.mjs';

export const MANIFEST_SCHEMA = JSON.parse(readFileSync(new URL('./deploy-manifest.schema.json', import.meta.url), 'utf8'));
const DEPENDENCIES = ['v3Factory', 'v3PositionManager', 'v3Quoter', 'v3SwapRouter', 'v4PoolManager', 'v4PositionManager',
  'v4StateView', 'v4Quoter', 'universalRouter', 'permit2', 'wrappedNative'];
const BUILD = { version: '0.8.26+commit.8a97fa7a', optimizerRuns: 200, viaIR: true, evmVersion: 'cancun', bytecodeHash: 'none' };
const TOP_LEVEL = ['schemaVersion', 'kind', 'status', 'environment', 'chain', 'sourceCommit', 'releaseTag', 'contractNames',
  'contracts', 'dependencies', 'roles', 'policies', 'chargeCurrencies', 'runtimeCodeHashes', 'createx', 'build',
  'deploymentReceipts', 'verification'];
const RECEIPT_KEYS = ['transactionHash', 'blockNumber', 'blockHash', 'gasUsed', 'effectiveGasPrice'];
const VERIFICATION_KEYS = ['blockNumber', 'blockHash', 'blockTag', 'codeHashes', 'wiring', 'checkedAt'];
const address = x => typeof x === 'string' && /^0x[0-9a-f]{40}$/.test(x);
const hash = x => typeof x === 'string' && /^0x[0-9a-f]{64}$/.test(x);
const hex64 = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
const decimal = x => typeof x === 'string' && /^(0|[1-9][0-9]*)$/.test(x);
/** A JSON integer JavaScript holds exactly (Python: int, 0 <= x < 2**53). */
const integer = x => Number.isSafeInteger(x) && x >= 0;
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const sameKeys = (v, expected) => { const a = Object.keys(v).sort(), b = [...expected].sort(); return a.length === b.length && a.every((k, i) => k === b[i]); };
function keys(v, expected, error) { ensure(plain(v) && sameKeys(v, expected), error); }

/** RFC 3339 date-time with a zone, checked field by field (no library parser: JavaScript's and Python's
 * accept different extensions). Upper-case T and Z, 1 to 9 fraction digits, a real calendar day. */
export function isDateTime(value) {
  const match = typeof value === 'string'
    && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  // A month outside 1-12 has no days, so no day is valid in it.
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  const offset = match[7] === undefined || (Number(match[7]) <= 23 && Number(match[8]) <= 59);
  return year >= 1 && day >= 1 && day <= days && hour <= 23 && minute <= 59 && second <= 59 && offset;
}

const SCHEMA_KEYWORDS = new Set(['$schema', 'title', 'description', 'type', 'const', 'enum', 'pattern', 'minLength', 'format',
  'minimum', 'maximum', 'minItems', 'items', 'properties', 'required', 'additionalProperties', 'minProperties', 'oneOf']);
const TYPES = { object: plain, array: Array.isArray, string: x => typeof x === 'string', boolean: x => typeof x === 'boolean',
  null: x => x === null, integer: Number.isInteger, number: x => typeof x === 'number' && Number.isFinite(x) };

/** The JSON Schema keywords the manifest schema uses; any other keyword is refused rather than ignored. */
export function checkSchema(schema, value, path = '$') {
  const fail = keyword => { throw new Error('manifest_schema_violation: ' + path + ' ' + keyword); };
  for (const keyword of Object.keys(schema)) if (!SCHEMA_KEYWORDS.has(keyword)) throw new Error('schema_keyword_unsupported: ' + keyword);
  if (schema.oneOf) {
    const passing = schema.oneOf.filter(option => { try { checkSchema(option, value, path); return true; } catch (error) {
      if (error.message.startsWith('schema_keyword_unsupported')) throw error; return false; } });
    if (passing.length !== 1) fail('oneOf');
  }
  if (Object.hasOwn(schema, 'const') && canonical(value) !== canonical(schema.const)) fail('const');
  if (schema.enum && !schema.enum.some(option => canonical(option) === canonical(value))) fail('enum');
  if (schema.type && !TYPES[schema.type](value)) fail('type');
  if (typeof value === 'string') {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) fail('pattern');
    if (schema.minLength !== undefined && [...value].length < schema.minLength) fail('minLength');
    if (schema.format !== undefined) { if (schema.format !== 'date-time') fail('format'); if (!isDateTime(value)) fail('format'); }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail('minimum');
    if (schema.maximum !== undefined && value > schema.maximum) fail('maximum');
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail('minItems');
    if (schema.items) value.forEach((item, i) => checkSchema(schema.items, item, path + '[' + i + ']'));
  }
  if (plain(value)) {
    for (const name of schema.required ?? []) if (!Object.hasOwn(value, name)) fail('required ' + name);
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) fail('minProperties');
    for (const [name, child] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, name)) checkSchema(schema.properties[name], child, path + '.' + name);
      else if (schema.additionalProperties === false) fail('additionalProperties ' + name);
      else if (plain(schema.additionalProperties)) checkSchema(schema.additionalProperties, child, path + '.' + name);
    }
  }
  return value;
}

/** The schema file, then every semantic rule; returns the manifest or throws a refusal code. */
export function validateManifest(m) {
  checkSchema(MANIFEST_SCHEMA, m);
  return checkSemantics(m);
}

/** The rules backend/v2_manifest.py `checked_manifest` applies, one for one, without the schema file. */
export function checkSemantics(m) {
  keys(m, TOP_LEVEL, 'manifest_fields_invalid');
  ensure(m.schemaVersion === 1 && m.kind === 'domino-v2-deployment' && ['prepared', 'verified'].includes(m.status), 'manifest_identity_invalid');
  keys(m.chain, ['name', 'chainId', 'nativeCurrency'], 'manifest_chain_invalid');
  ensure(integer(m.chain.chainId) && m.chain.chainId > 0 && typeof m.chain.name === 'string' && m.chain.name.length > 0
    && typeof m.chain.nativeCurrency === 'string' && m.chain.nativeCurrency.length > 0, 'manifest_chain_invalid');
  ensure(ENVIRONMENTS.includes(m.environment), 'manifest_environment_invalid');
  ensure(m.environment === 'local-test' || ENABLED_CHAINS.includes(m.chain.chainId), 'manifest_chain_not_enabled');
  ensure(typeof m.sourceCommit === 'string' && /^[0-9a-f]{40}$/.test(m.sourceCommit)
    && typeof m.releaseTag === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(m.releaseTag), 'manifest_source_invalid');
  ensure(canonical(m.contractNames) === canonical(CONTRACT_NAMES) && canonical(m.policies) === canonical(POLICIES), 'manifest_contracts_or_policy_changed');
  keys(m.roles, ROLE_NAMES, 'manifest_roles_invalid');
  ensure(Object.values(m.roles).every(address), 'manifest_roles_invalid');
  checkRoleAddresses(m.roles);
  const predicted = precomputeAddresses(m.roles.deployer);
  ensure(canonical(m.contracts) === canonical(predicted.contracts), 'manifest_addresses_changed');
  ensure(Object.values(m.roles).every(addr => !Object.values(m.contracts).includes(addr) && addr !== CREATE_X), 'manifest_role_component_conflict');
  keys(m.createx, ['address', 'runtimeCodeHash', 'salts', 'guardedSalts'], 'manifest_createx_invalid');
  ensure(m.createx.address === CREATE_X && m.createx.runtimeCodeHash === CREATE_X_CODE_HASH
    && canonical(m.createx.salts) === canonical(predicted.salts) && canonical(m.createx.guardedSalts) === canonical(predicted.guardedSalts), 'manifest_createx_changed');
  keys(m.dependencies, DEPENDENCIES, 'manifest_dependencies_invalid');
  ensure(Object.values(m.dependencies).every(v => address(v) && BigInt(v) > 0n), 'manifest_dependency_address_invalid');
  keys(m.runtimeCodeHashes, [...Object.keys(CONTRACT_NAMES), ...DEPENDENCIES], 'manifest_codehash_keys_invalid');
  ensure(Object.values(m.runtimeCodeHashes).every(v => hash(v) && BigInt(v) > 0n), 'manifest_codehash_invalid');
  ensure(Array.isArray(m.chargeCurrencies) && m.chargeCurrencies.length >= 2, 'manifest_currencies_invalid');
  for (const currency of m.chargeCurrencies) {
    keys(currency, ['token', 'rank'], 'manifest_currencies_invalid');
    ensure(address(currency.token) && Number.isInteger(currency.rank) && currency.rank > 0 && currency.rank < 256, 'manifest_currencies_invalid');
  }
  ensure(new Set(m.chargeCurrencies.map(v => v.token)).size === m.chargeCurrencies.length, 'manifest_currencies_invalid');
  keys(m.build, [...Object.keys(BUILD), 'sourceTreeSha256', 'workingTreeSourceChanges', 'sourceHashes', 'chainProfileSha256'], 'manifest_build_invalid');
  ensure(Object.entries(BUILD).every(([k, v]) => m.build[k] === v) && hex64(m.build.chainProfileSha256)
    && typeof m.build.workingTreeSourceChanges === 'boolean' && plain(m.build.sourceHashes) && Object.keys(m.build.sourceHashes).length > 0
    && Object.entries(m.build.sourceHashes).every(([p, h]) => p.isWellFormed() && (p.startsWith('src/v2/') || p.startsWith('deploy-fixtures/'))
      && !p.split('/').includes('..') && hex64(h))
    && typeof m.build.sourceTreeSha256 === 'string'
    && m.build.sourceTreeSha256 === createHash('sha256').update(canonical(m.build.sourceHashes)).digest('hex'), 'manifest_build_invalid');
  ensure(plain(m.deploymentReceipts), 'manifest_receipts_invalid');
  if (m.status === 'prepared') { ensure(m.verification === null && Object.keys(m.deploymentReceipts).length === 0, 'manifest_prepared_has_receipts'); return m; }
  keys(m.deploymentReceipts, DEPLOY_ORDER, 'manifest_receipts_incomplete');
  const blocks = new Map();
  for (const receipt of Object.values(m.deploymentReceipts)) {
    keys(receipt, RECEIPT_KEYS, 'manifest_receipt_invalid');
    ensure(hash(receipt.transactionHash) && hash(receipt.blockHash) && integer(receipt.blockNumber)
      && decimal(receipt.gasUsed) && decimal(receipt.effectiveGasPrice), 'manifest_receipt_invalid');
    // No transaction is in the genesis block, no hash is zero, and a block has one hash.
    ensure(receipt.blockNumber >= 1 && BigInt(receipt.transactionHash) !== 0n && BigInt(receipt.blockHash) !== 0n
      && (blocks.get(receipt.blockNumber) ?? receipt.blockHash) === receipt.blockHash, 'manifest_receipt_invalid');
    blocks.set(receipt.blockNumber, receipt.blockHash);
  }
  ensure(new Set(Object.values(m.deploymentReceipts).map(r => r.transactionHash)).size === DEPLOY_ORDER.length, 'manifest_receipt_invalid');
  const v = m.verification;
  keys(v, VERIFICATION_KEYS, 'manifest_verification_invalid');
  ensure(integer(v.blockNumber) && hash(v.blockHash) && typeof v.blockTag === 'string'
    && v.codeHashes === 'exact_precomputed_immutable_runtime' && v.wiring === 'checked', 'manifest_verification_invalid');
  // Verified after the deployment, at a block whose hash the receipts agree with.
  ensure(v.blockNumber >= Math.max(...blocks.keys()) && BigInt(v.blockHash) !== 0n
    && (blocks.get(v.blockNumber) ?? v.blockHash) === v.blockHash, 'manifest_verification_invalid');
  ensure(isDateTime(v.checkedAt), 'manifest_verification_invalid');
  return m;
}
