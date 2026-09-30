// read-v5's runtime against the shared fixtures and the producer's own words.
// fixtures/ is written from backend/featured_contract.py: every valid answer is
// accepted, and every invalid one (the valid `current` answer with one defect,
// named by its file) is refused, with the defect where its name says it is.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CONTRACT_VERSION, CONTRACT_VERSIONS, ENABLED_READS, ERROR_STATUS_BY_CODE, ROUTES,
  matchesRequest, validateError, validateRequest, validateResponse,
} from './runtime.mjs';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const BACKEND = join(import.meta.dirname, '..', '..', 'backend');
const names = (kind) => readdirSync(join(FIXTURES, kind)).filter((name) => name.endsWith('.json')).sort();
const fixture = (kind, name) => JSON.parse(readFileSync(join(FIXTURES, kind, name), 'utf8'));
const accepts = (body) => validateResponse('featured-pools', body);
const CURRENT = fixture('valid', 'current.json');
const edit = (change) => { const body = structuredClone(CURRENT); change(body); return body; };
// The Worker's strict parser builds objects without a prototype.
const bare = (value) => Array.isArray(value) ? value.map(bare)
  : value !== null && typeof value === 'object'
    ? Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bare(item)])))
    : value;

// Where each invalid fixture differs from valid/current.json.
const SYMBOL = /^\/pools\/\d+\/tokens\/[01]\/symbol$/;
const DEFECTS = {
  'bad-policy-version.json': /^\/policyVersion$/,
  'bad-selection-date.json': /^\/selectionDate$/,
  'bidi-symbol.json': SYMBOL,
  'control-symbol.json': SYMBOL,
  'currencies-unsorted.json': /^\/pools\/\d+\/(poolKey\/currency[01]|tokens\/[01]\/(address|symbol|decimals))$/,
  'current-without-pools.json': /^\/pools\/\d+$/,
  'decimals-above-36.json': /^\/pools\/\d+\/tokens\/[01]\/decimals$/,
  'duplicate-pool.json': /^\/pools\/\d+\/poolId$/,
  'dynamic-fee.json': /^\/pools\/\d+\/poolKey\/feeMode$/,
  'effective-before-generated.json': /^\/effectiveAt$/,
  'empty-symbol.json': SYMBOL,
  'execution-available.json': /^\/executionAvailable$/,
  'extra-key.json': /^\/[A-Za-z]+$/,
  'fee-out-of-range.json': /^\/pools\/\d+\/poolKey\/fee_pips$/,
  'generated-after-served.json': /^\/servedAt$/,
  'hooked-pool.json': /^\/pools\/\d+\/poolKey\/hooks$/,
  'integration-class.json': /^\/pools\/\d+\/integrationClass$/,
  'listed-and-withdrawn.json': /^\/withdrawn\/\d+\/poolId$/,
  'long-symbol.json': SYMBOL,
  'missing-key.json': /^\/[A-Za-z]+$/,
  'none-with-pools.json': /^\/status$/,
  // rc.2 (28/09/2026): the two floors and a ranked pool's own figures are never null.
  'null-fresh-apr.json': /^\/pools\/\d+\/rankInputs\/freshApr$/,
  'null-min-tvl.json': /^\/rules\/minTvlUsd$/,
  'null-min-volume.json': /^\/rules\/minVolume24hUsd$/,
  'null-rank-apr.json': /^\/pools\/\d+\/rankInputs\/rankApr$/,
  'null-rank-liquidity.json': /^\/pools\/\d+\/rankInputs\/reportedLiquidityUsd$/,
  'null-rank-volume.json': /^\/pools\/\d+\/rankInputs\/volume24hUsd$/,
  'null-symbol.json': SYMBOL,
  'numeric-apr.json': /^\/pools\/\d+\/rankInputs\/(rank|fresh|prev)Apr$/,
  'numeric-decimal.json': /^\/pools\/\d+\/rankInputs\/(volume24h|reportedLiquidity|referenceDepth)Usd$/,
  'rank-inputs-on-pin.json': /^\/pools\/\d+\/rankInputs$/,
  'ranked-without-rank-inputs.json': /^\/pools\/\d+\/rankInputs$/,
  'served-without-revision.json': /^\/revision$/,
  'short-block-hash.json': /^\/pools\/\d+\/verifiedAt\/hash$/,
  'slot-from-zero.json': /^\/pools\/\d+\/slot$/,
  'slot-gap.json': /^\/pools\/\d+\/slot$/,
  'spaced-symbol.json': SYMBOL,
  'suggested.json': /^\/suggested$/,
  'tick-spacing-too-wide.json': /^\/pools\/\d+\/poolKey\/tick_spacing$/,
  'tick-spacing-zero.json': /^\/pools\/\d+\/poolKey\/tick_spacing$/,
  'token-address-mismatch.json': /^\/pools\/\d+\/tokens\/[01]\/address$/,
  'too-many-pools.json': /^\/pools\/\d+(\/.+)?$/,
  'too-many-withdrawn.json': /^\/withdrawn\/\d+(\/.+)?$/,
  'unknown-identity-source.json': /^\/pools\/\d+\/identitySource$/,
  'unknown-limitation.json': /^\/limitations\/\d+$/,
  'unknown-rank-by.json': /^\/rules\/rankBy$/,
  'unknown-rejection-reason.json': /^\/evaluation\/rejectedByReason\/[^/]+$/,
  'unknown-source.json': /^\/pools\/\d+\/source$/,
  'unknown-status.json': /^\/status$/,
  'unknown-withdrawn-reason.json': /^\/withdrawn\/\d+\/reason$/,
  'upcoming-draft.json': /^\/upcoming$/,
  'uppercase-pool-id.json': /^\/pools\/\d+\/poolId$/,
  'valid-until-before-effective.json': /^\/validUntil$/,
  'wrong-chain.json': /^\/chainId$/,
  'wrong-contract-version.json': /^\/contractVersion$/,
  'wrong-mode.json': /^\/mode$/,
  'wrong-schema-version.json': /^\/schemaVersion$/,
};

// Paths (JSON pointers) where two documents differ: changed leaves, added or removed members.
function differences(left, right, path = '', found = []) {
  if (Object.is(left, right)) return found;
  const container = (value) => value !== null && typeof value === 'object';
  if (!container(left) || !container(right) || Array.isArray(left) !== Array.isArray(right)) {
    found.push(path);
    return found;
  }
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) found.push(`${path}/${key}`);
    else differences(left[key], right[key], `${path}/${key}`, found);
  }
  return found;
}

test('every valid fixture is accepted, as parsed JSON and as the Worker parses it', () => {
  assert.deepEqual(names('valid'), ['current-policy-v1.json', 'current.json', 'manual.json', 'none-with-withdrawn.json', 'none.json', 'repaired.json']);
  for (const name of names('valid')) {
    const body = fixture('valid', name);
    assert.equal(accepts(body), true, name);
    assert.equal(accepts(bare(body)), true, `${name} without a prototype`);
    assert.equal(matchesRequest({}, body), true, name);
  }
});

test('every invalid fixture is refused, for the one defect its name states', () => {
  assert.deepEqual(names('invalid'), Object.keys(DEFECTS).sort(), 'a new invalid fixture needs its defect named here');
  for (const name of names('invalid')) {
    const body = fixture('invalid', name);
    const changed = differences(CURRENT, body);
    // The rest of the document is the valid `current` answer, so the refusal is this defect's.
    assert.ok(changed.length > 0, `${name} differs from valid/current.json`);
    for (const path of changed) assert.match(path, DEFECTS[name], `${name} changes ${path}`);
    assert.equal(accepts(body), false, name);
    assert.equal(accepts(bare(body)), false, `${name} without a prototype`);
  }
  assert.ok(fixture('invalid', 'too-many-pools.json').pools.length > 12);
  assert.ok(fixture('invalid', 'too-many-withdrawn.json').withdrawn.length > 24);
});

// The producer's vocabulary, read from its source: a value it can write must pass here.
const python = (file) => readFileSync(join(BACKEND, file), 'utf8');
const strings = (text) => [...text.replace(/#.*$/gm, '').matchAll(/'([^']*)'/g)].map((match) => match[1]);
function tuple(file, name) {
  const source = python(file);
  const start = source.indexOf(`\n${name} = (`);
  assert.ok(start >= 0, `${file} defines ${name}`);
  const open = source.indexOf('(', start);
  return strings(source.slice(open + 1, source.indexOf(')', open)));
}
// A model's fields and their annotations, as its class body writes them (one per line).
function fields(file, name) {
  const source = python(file);
  const start = source.indexOf(`\nclass ${name}(`);
  assert.ok(start >= 0, `${file} defines ${name}`);
  const body = source.slice(source.indexOf('\n', start + 1) + 1).split(/\n(?=\S)/)[0];
  return Object.fromEntries([...body.matchAll(/^    ([A-Za-z0-9_]+): (.+)$/gm)].map((match) => [match[1], match[2]]));
}
const nullable = (model) => Object.keys(model).filter((name) => / \| None$/.test(model[name])).sort();
function literal(file, field) {
  const match = python(file).match(new RegExp(`\\b${field}: Literal\\[([^\\]]*)\\]`));
  assert.ok(match, `${file} types ${field}`);
  return strings(match[1]);
}

test('the runtime speaks the producer\'s version, limits and vocabulary', () => {
  const contract = python('featured_contract.py');
  assert.match(contract, new RegExp(`^CONTRACT_VERSION = '${CONTRACT_VERSION.replaceAll('.', '\\.')}'$`, 'm'));
  assert.match(contract, /^MAX_POOLS = 12$/m);
  assert.match(contract, /^MAX_WITHDRAWN = 24$/m);
  assert.match(python('pool_apr.py'), new RegExp(`^METHOD = '${CURRENT.rules.estimateMethod}'$`, 'm'));

  const statuses = tuple('featured_contract.py', 'STATUSES');
  assert.deepEqual(statuses, ['current', 'repaired', 'carried_over', 'manual', 'none']);
  for (const status of statuses.filter((status) => status !== 'none')) {
    assert.equal(accepts(edit((body) => { body.status = status; })), true, status);
  }
  for (const reason of tuple('featured_contract.py', 'WITHDRAW_REASONS')) {
    assert.equal(accepts(edit((body) => { body.withdrawn[0].reason = reason; })), true, reason);
  }
  const limitations = tuple('featured_contract.py', 'LIMITATIONS');
  assert.deepEqual(CURRENT.limitations, limitations);
  for (const limitation of limitations) {
    assert.equal(accepts(edit((body) => { body.limitations = [limitation]; })), true, limitation);
  }
  const reasons = [...tuple('featured_pools.py', 'SAFETY'), ...tuple('featured_pools.py', 'MARKET')];
  assert.equal(reasons.length, 37);
  for (const reason of reasons) {
    assert.equal(accepts(edit((body) => { body.evaluation.rejectedByReason = { [reason]: 1 }; })), true, reason);
  }
  // rc.2: both ways of ranking, and exactly the fields the producer lets be null (that rule off, or not measured).
  const rankBy = python('featured_contract.py').match(/^RANK_BY = \{([^}]*)\}$/m);
  assert.ok(rankBy, 'featured_contract.py defines RANK_BY');
  const ways = strings(rankBy[1]).filter((_, index) => index % 2 === 1);
  assert.deepEqual(ways, ['min_fresh_and_previous_day_feeAprEstimate24hPercent', 'feeAprEstimate24hPercent']);
  for (const way of ways) assert.equal(accepts(edit((body) => { body.rules.rankBy = way; })), true, way);
  const rules = fields('featured_contract.py', 'Rules');
  assert.deepEqual(Object.keys(rules).sort(), Object.keys(CURRENT.rules).sort());
  assert.deepEqual(nullable(rules), ['maxAprPercent', 'maxTurnover24h', 'minPoolAgeHours', 'minReferenceDepthUsd']);
  const inputs = fields('featured_contract.py', 'RankInputs');
  assert.deepEqual(Object.keys(inputs).sort(), Object.keys(CURRENT.pools[1].rankInputs).sort());
  assert.deepEqual(nullable(inputs), ['prevApr', 'referenceDepthUsd']);
  for (const name of Object.keys(rules)) {
    assert.equal(accepts(edit((body) => { body.rules[name] = null; })), nullable(rules).includes(name), `rules.${name} null`);
  }
  for (const name of Object.keys(inputs)) {
    assert.equal(accepts(edit((body) => { body.pools[1].rankInputs[name] = null; })), nullable(inputs).includes(name), `rankInputs.${name} null`);
  }

  const sources = tuple('featured_pools.py', 'SOURCES');
  assert.deepEqual(sources, ['pinned', 'ranked', 'carried', 'fallback', 'manual']);
  for (const source of sources) {
    const body = edit((body) => {
      body.pools[0].source = source;
      body.pools[0].rankInputs = source === 'ranked' ? structuredClone(CURRENT.pools[1].rankInputs) : null;
    });
    assert.equal(accepts(body), true, source);
  }
  for (const source of literal('featured_contract.py', 'identitySource')) {
    assert.equal(accepts(edit((body) => { body.pools[0].identitySource = source; })), true, source);
  }
  for (const source of literal('featured_contract.py', 'ageSource')) {
    assert.equal(accepts(edit((body) => { body.pools[0].ageSource = source; })), true, source);
  }
});

test('the spec\'s validator cases and the handoff\'s amendments', () => {
  const refused = {
    'a dynamic fee flag as fee_pips': (body) => { body.pools[1].poolKey.fee_pips = 0x800000; },
    'equal currencies': (body) => { body.pools[1].poolKey.currency1 = body.pools[1].poolKey.currency0; body.pools[1].tokens[1].address = body.pools[1].poolKey.currency0; },
    'three tokens': (body) => { body.pools[1].tokens.push(structuredClone(body.pools[1].tokens[1])); },
    'a draft in upcoming': (body) => { body.upcoming = { revision: 42, effectiveAt: 1, poolIds: [], entering: [], leaving: [] }; },
    'a fractional slot': (body) => { body.pools[0].slot = 1.5; },
    'negative decimals': (body) => { body.pools[0].tokens[0].decimals = -1; },
    'an unsafe integer time': (body) => { body.servedAt = 2 ** 53; },
    'a fee as text': (body) => { body.pools[0].poolKey.fee_pips = '3000'; },
    'truncated as text': (body) => { body.coverage.truncated = 'true'; },
    'a list size of 13': (body) => { body.rules.size = 13; },
    'eleven coverage pages': (body) => { body.coverage.pages = 11; },
    'a day that does not exist': (body) => { body.selectionDate = '2026-02-29'; },
    'year zero': (body) => { body.selectionDate = '0000-01-01'; },
    'an unpadded month': (body) => { body.selectionDate = '2026-9-26'; },
    'a decimal with a bare point': (body) => { body.rules.minTvlUsd = '1.'; },
    'a decimal in exponent form': (body) => { body.rules.minTvlUsd = '1e3'; },
    'a signed decimal': (body) => { body.rules.minTvlUsd = '-1'; },
    'an APR with a leading zero': (body) => { body.pools[1].rankInputs.rankApr = '01'; },
    'an APR with 19 decimals': (body) => { body.pools[1].rankInputs.rankApr = `1.${'0'.repeat(19)}`; },
    'an uppercase policy': (body) => { body.policyVersion = 'featured-v1:3F9C2A1B7D0E'; },
    'a served list without a listId': (body) => { body.listId = null; },
    'a served list without validUntil': (body) => { body.validUntil = null; },
    'the first listed pool also withdrawn': (body) => { body.withdrawn.push({ poolId: body.pools[0].poolId, reason: 'tvl_collapse', at: 1 }); },
  };
  for (const [name, change] of Object.entries(refused)) assert.equal(accepts(edit(change)), false, name);

  const accepted = {
    // Handoff §2.2: age is a market rule, so any pool may have none.
    'a ranked pool without an age source': (body) => { body.pools[1].ageSource = null; },
    'a stale list (the reader decides)': (body) => { body.servedAt = body.validUntil + 1; },
    'a list served the second it was generated': (body) => { body.servedAt = body.generatedAt; body.effectiveAt = body.generatedAt; },
    'a carried over list': (body) => { body.status = 'carried_over'; },
    'a leap day': (body) => { body.selectionDate = '2024-02-29'; },
    'no evaluation or rules': (body) => { body.evaluation = null; body.rules = null; body.coverage = null; body.window = null; },
    'a decimal with leading zeros': (body) => { body.rules.minTvlUsd = '0250000.50'; },
    'an APR with 18 decimals': (body) => { body.pools[1].rankInputs.rankApr = `1.${'0'.repeat(18)}`; },
    'twelve pools': (body) => {
      for (let slot = 3; slot <= 12; slot++) {
        body.pools.push({ ...structuredClone(body.pools[0]), slot, poolId: `0x${slot.toString(16).padStart(64, '0')}` });
      }
    },
    'twenty-four removals': (body) => {
      for (let index = 1; index < 24; index++) {
        body.withdrawn.push({ poolId: `0x${(1000 + index).toString(16).padStart(64, '0')}`, reason: 'price_fall', at: 1 });
      }
    },
  };
  for (const [name, change] of Object.entries(accepted)) assert.equal(accepts(edit(change)), true, name);
});

test('a symbol is 1 to 32 code points with no whitespace, control, format or lone surrogate', () => {
  const symbol = (value) => accepts(edit((body) => { body.pools[1].tokens[1].symbol = value; }));
  const emoji = '\u{1F600}';
  assert.equal(symbol(emoji.repeat(32)), true, '32 code points in 64 UTF-16 units');
  assert.equal(symbol(emoji.repeat(33)), false);
  assert.equal(symbol('T'.repeat(32)), true);
  assert.equal(symbol('ＴKNB'), true, 'a lookalike is the app\'s check, not the wire\'s');
  for (const unsafe of ['A B', 'A B', 'A B', 'A　B', 'A\u0085B', 'A\u001CB', 'A\tB',
    'A‍B', 'A­B', 'A⁦B', 'A﻿B', 'A\uD800B', 'A\uDC00']) {
    assert.equal(symbol(unsafe), false, JSON.stringify(unsafe));
  }
});

test('a request names nothing; other routes and shapes are refused without throwing', () => {
  assert.equal(validateRequest('featured-pools', {}), true);
  assert.equal(validateRequest('featured-pools', Object.create(null)), true);
  for (const body of [{ poolId: CURRENT.pools[0].poolId }, { route: 'featured-pools' }, [], null, '', 0, undefined]) {
    assert.equal(validateRequest('featured-pools', body), false, JSON.stringify(body));
  }
  assert.equal(validateRequest('overview', {}), false);
  assert.equal(validateResponse('overview', CURRENT), false);
  for (const body of [null, undefined, [], {}, '', 0, true, [CURRENT], { ...CURRENT, pools: null },
    { ...CURRENT, pools: [null] }, { ...CURRENT, withdrawn: {} }, { ...CURRENT, evaluation: { ...CURRENT.evaluation, rejectedByReason: [] } }]) {
    assert.equal(accepts(body), false);
  }
  assert.equal(matchesRequest({}, CURRENT), true);
  assert.equal(matchesRequest({ poolId: CURRENT.pools[0].poolId }, CURRENT), false);
  assert.equal(matchesRequest({}, null), false);
});

// The transition (rugged's handoff of 28/09/2026, §4): the VM serves rc.1 until its step 2, and the Worker and the
// app go first, so both versions pass, each held to its own rules. Step 5 drops rc.1.
test('an rc.1 answer still passes during the transition, held to rc.1\'s rules; no other version does', () => {
  const V1_LIST = fixture('valid', 'current-policy-v1.json');
  // A list chosen under v1 and served in rc.2: the list of the day rugged's reader moves to rc.2.
  assert.equal(V1_LIST.contractVersion, '1.0.0-rc.2');
  assert.equal(V1_LIST.rules.rankBy, 'min_fresh_and_previous_day_feeAprEstimate24hPercent');
  const rc1 = (change = () => {}) => {
    const body = structuredClone(V1_LIST);
    body.contractVersion = '1.0.0-rc.1';
    change(body);
    return body;
  };
  // What rc.1's producer serves today: every rule stated, the lower of two days, every rank input measured.
  assert.equal(accepts(rc1()), true);
  assert.equal(accepts(bare(rc1())), true, 'without a prototype');
  for (const name of ['none.json', 'none-with-withdrawn.json', 'manual.json', 'repaired.json']) {
    const body = fixture('valid', name);
    body.contractVersion = '1.0.0-rc.1';
    if (body.rules) body.rules = structuredClone(V1_LIST.rules);
    for (const item of body.pools) if (item.rankInputs) item.rankInputs = structuredClone(V1_LIST.pools[1].rankInputs);
    assert.equal(accepts(body), true, `${name} as rc.1`);
  }
  // Nothing rc.2 added passes under rc.1.
  const rc2Only = {
    'ranking by today\'s APR': (body) => { body.rules.rankBy = 'feeAprEstimate24hPercent'; },
    'no depth rule': (body) => { body.rules.minReferenceDepthUsd = null; },
    'no APR ceiling': (body) => { body.rules.maxAprPercent = null; },
    'no turnover ceiling': (body) => { body.rules.maxTurnover24h = null; },
    'no age rule': (body) => { body.rules.minPoolAgeHours = null; },
    'no previous-day APR': (body) => { body.pools[1].rankInputs.prevApr = null; },
    'no measured depth': (body) => { body.pools[1].rankInputs.referenceDepthUsd = null; },
  };
  for (const [name, change] of Object.entries(rc2Only)) {
    assert.equal(accepts(rc1(change)), false, `rc.1 with ${name}`);
    assert.equal(accepts(edit(change)), true, `rc.2 with ${name}`);
  }
  // Neither version lets a floor or a ranked pool's own figures go.
  for (const change of [(body) => { body.rules.minVolume24hUsd = null; }, (body) => { body.rules.minTvlUsd = null; },
    (body) => { body.pools[1].rankInputs.rankApr = null; }, (body) => { body.pools[1].rankInputs.freshApr = null; }]) {
    assert.equal(accepts(rc1(change)), false);
    assert.equal(accepts(edit(change)), false);
  }
  for (const version of ['1.0.0-rc.0', '1.0.0-rc.3', '1.0.0', '1.0.0-rc.2 ', ' 1.0.0-rc.1', '1.0.0-RC.2', null, 2]) {
    assert.equal(accepts(edit((body) => { body.contractVersion = version; })), false, JSON.stringify(version));
    assert.equal(accepts(rc1((body) => { body.contractVersion = version; })), false, JSON.stringify(version));
  }
});

test('version, route table and errors follow read-v4', () => {
  assert.equal(CONTRACT_VERSION, '1.0.0-rc.2');
  assert.deepEqual(CONTRACT_VERSIONS, ['1.0.0-rc.1', '1.0.0-rc.2']);
  assert.equal(CONTRACT_VERSIONS.at(-1), CONTRACT_VERSION, 'the version spoken is the newest accepted');
  assert.ok(Object.isFrozen(CONTRACT_VERSIONS));
  assert.deepEqual(ENABLED_READS, ['featured-pools']);
  assert.deepEqual(Object.keys(ROUTES), ['featured-pools']);
  assert.equal(ROUTES['featured-pools'].schemaVersion, 1);
  assert.ok(Object.isFrozen(ROUTES) && Object.isFrozen(ROUTES['featured-pools']) && Object.isFrozen(ENABLED_READS));
  // `none` is a 200; a stored list the producer refuses is a 502; the Worker's off switch is a 404.
  assert.equal(ERROR_STATUS_BY_CODE.upstream_contract_mismatch, 502);
  assert.equal(ERROR_STATUS_BY_CODE.route_not_available, 404);
  assert.equal(validateError(404, { error: 'route_not_available' }), true);
  assert.equal(validateError(200, { error: 'route_not_available' }), false);
  assert.equal(validateError(404, { error: 'route_not_available', detail: 'x' }), false);
});
