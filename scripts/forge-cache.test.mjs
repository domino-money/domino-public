import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CACHE_FILE, RECORD_FILE, pruneCache, recordSources } from './forge-cache.mjs';

// A cache in Forge's layout: Lib.sol <- User.sol <- A.t.sol, Lib.sol <- B.t.sol, and Gone.t.sol.
const SOURCES = {
  'src/Lib.sol': ['Lib', 'Old'], 'src/User.sol': ['User'], 'test/A.t.sol': ['ATest'],
  'test/B.t.sol': ['BTest'], 'test/Gone.t.sol': ['GoneTest'], 'src/Alone.sol': ['Alone'],
};
const IMPORTS = { 'src/User.sol': ['src/Lib.sol'], 'test/A.t.sol': ['src/User.sol', 'src/Lib.sol'], 'test/B.t.sol': ['src/Lib.sol'] };
const artifact = (source, name) => `${path.basename(source)}/${name}.json`;

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'domino-forge-cache-'));
  const files = {};
  for (const [source, names] of Object.entries(SOURCES)) {
    mkdirSync(path.dirname(path.join(root, source)), { recursive: true });
    writeFileSync(path.join(root, source), `// ${source} v1\n`);
    const artifacts = {};
    for (const name of names) {
      mkdirSync(path.join(root, 'out', path.basename(source)), { recursive: true });
      writeFileSync(path.join(root, 'out', artifact(source, name)), '{}');
      artifacts[name] = { '0.8.26': { default: { path: artifact(source, name), build_id: 'b' } } };
    }
    files[source] = { contentHash: 'x', sourceName: source, imports: IMPORTS[source] ?? [], artifacts };
  }
  mkdirSync(path.join(root, 'cache'), { recursive: true });
  writeFileSync(path.join(root, CACHE_FILE), JSON.stringify({ paths: { artifacts: 'out' }, files }));
  return root;
}
const has = (root, source, name) => existsSync(path.join(root, 'out', artifact(source, name)));
const cached = root => Object.keys(JSON.parse(readFileSync(path.join(root, CACHE_FILE), 'utf8')).files).sort();

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const CACHE_ACTION = '55cc8345863c7cc4c66a329aec7e433d2d1c52a9';
const ARCH = '${{ runner.arch }}';

function jobSteps(text, id) {
  const match = new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [a-z_]+:|$(?![\\s\\S]))`, 'm').exec(text);
  assert.ok(match, `missing ${id} job`);
  return match[1].split(/^      - /m).slice(1);
}

function architectureBoundaries(text) {
  const caches = text.split(/^      - /m).filter(step => /^        uses: actions\/cache(?:\/restore)?@/m.test(step));
  assert.equal(caches.length, 3, 'backend fixtures, deployment test compile and contract parts have explicit caches');
  for (const step of caches) {
    const key = /^          key: (.+)$/m.exec(step)?.[1];
    assert.ok(key?.includes('${{ runner.os }}') && key.includes(ARCH) && key.includes('hashFiles('), 'every compilation key pins OS, architecture and inputs');
    const prefixes = /^          restore-keys: \|\n((?:            .+\n)+)/m.exec(step)?.[1].trim().split('\n') ?? [];
    for (const prefix of prefixes) assert.ok(prefix.includes(ARCH) && prefix.includes('hashFiles('), 'no fallback can cross architectures or compiler settings');
  }
}

function backendSnapshotBoundary(text) {
  const steps = jobSteps(text, 'backend');
  const at = needle => {
    const found = steps.findIndex(step => step.includes(needle));
    assert.ok(found >= 0, `missing backend step: ${needle}`);
    return found;
  };
  const restore = at(`uses: actions/cache/restore@${CACHE_ACTION}`);
  const record = at('name: Record the sources of the completed backend fixture builds\n');
  const save = at(`uses: actions/cache/save@${CACHE_ACTION}`);
  assert.match(steps[restore], /^        id: forge_cache$/m);
  for (const name of [
    'Build contract artifacts for backend EVM tests',
    'Build and qualify the V4 execution fixture',
    'Build and qualify swap reinvestment and legacy charged balances',
    'Build public V1 contracts and prove equivalence to the internal V4 bases',
    'Independently reproduce the reviewed release artifact manifest',
    'Build the V2 contracts the backend EVM tests deploy',
  ]) {
    const build = at(`name: ${name}\n`);
    assert.ok(restore < build && build < record, 'every fixture build/qualification must finish before recording');
  }
  assert.match(steps[record], /^        run: node scripts\/forge-cache\.mjs record$/m);
  assert.doesNotMatch(steps[record], /^        if:/m, 'record only after all preceding steps succeed');
  assert.ok(record < save && save < at('name: Check staging catalogue inventory in a disposable cluster\n'), 'save the completed compilation before PostgreSQL tests');
  assert.ok(save < at('run: python -m unittest discover -s backend/tests -v\n'), 'later backend failures cannot prevent the completed compilation from being saved');
  assert.match(steps[save], /^        if: steps\.forge_cache\.outputs\.cache-hit != 'true'$/m, 'save misses only, under the default success condition');
  assert.match(steps[save], /^          key: \$\{\{ steps\.forge_cache\.outputs\.cache-primary-key \}\}$/m);
  const paths = step => /^          path: \|\n((?:            .+\n)+)/m.exec(step)?.[1];
  assert.equal(paths(steps[restore]), '            contracts/cache\n            contracts/out\n');
  assert.equal(paths(steps[save]), paths(steps[restore]), 'save the exact restored fixture tree');
  // Compilation reuse never skips these independent deployment/release checks.
  for (const name of ['Verify unsigned financial deployment tooling on disposable EVM', 'Verify V2 unsigned CREATE3 deployment tooling offline', 'Reproduce the V2 release artifact manifest']) {
    assert.ok(save < at(`name: ${name}\n`));
  }
}

test('an unchanged checkout keeps every artifact', () => {
  const root = fixture();
  try {
    assert.equal(recordSources(root), 6);
    assert.deepEqual(pruneCache(root), []);
    assert.deepEqual(cached(root), Object.keys(SOURCES).sort());
    assert.ok(has(root, 'src/Lib.sol', 'Old') && has(root, 'test/Gone.t.sol', 'GoneTest'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a changed source drops itself and every importer; a removed one drops its artifacts', () => {
  const root = fixture();
  try {
    recordSources(root);
    writeFileSync(path.join(root, 'src/Lib.sol'), '// src/Lib.sol v2, without Old\n');
    rmSync(path.join(root, 'test/Gone.t.sol'));
    assert.deepEqual(pruneCache(root), ['src/Lib.sol', 'src/User.sol', 'test/A.t.sol', 'test/B.t.sol', 'test/Gone.t.sol']);
    assert.deepEqual(cached(root), ['src/Alone.sol']);
    for (const [source, names] of Object.entries(SOURCES))
      for (const name of names) assert.equal(has(root, source, name), source === 'src/Alone.sol', `${source}:${name}`);
    assert.equal(existsSync(path.join(root, 'out/Gone.t.sol')), false, 'empty artifact folders go too');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a cache that was never recorded, or pruned without a new record, starts cold', () => {
  const root = fixture();
  try {
    recordSources(root);
    pruneCache(root);
    assert.equal(existsSync(path.join(root, RECORD_FILE)), false, 'prune consumes the record');
    assert.equal(pruneCache(root), null);
    assert.equal(existsSync(path.join(root, 'out')) || existsSync(path.join(root, 'cache')), false);
    assert.equal(pruneCache(root), null, 'and nothing restored is a cold start too');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the record covers only sources present in the checkout', () => {
  const root = fixture();
  try {
    rmSync(path.join(root, 'test/Gone.t.sol'));
    assert.equal(recordSources(root), 5);
    const record = JSON.parse(readFileSync(path.join(root, RECORD_FILE), 'utf8'));
    assert.equal(record['test/Gone.t.sol'], undefined);
    assert.match(record['src/Lib.sol'], /^[0-9a-f]{64}$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('compilation caches and every fallback are architecture and input qualified', () => {
  architectureBoundaries(workflow);
  assert.throws(() => architectureBoundaries(workflow.replaceAll(`-${ARCH}`, '')), /pins OS, architecture and inputs/);
  const fallback = '            forge-legacy-${{ runner.os }}-${{ hashFiles(\'contracts/foundry.toml\') }}-\n';
  assert.throws(() => architectureBoundaries(workflow.replace('          restore-keys: |\n', `          restore-keys: |\n${fallback}`)), /fallback can cross/);
});

test('backend fixture compilation is recorded and saved before later tests, only after successful qualifications', () => {
  backendSnapshotBoundary(workflow);
  assert.throws(() => backendSnapshotBoundary(workflow.replace('        if: steps.forge_cache.outputs.cache-hit != \'true\'', '        if: always()')), /save misses only/);
  assert.throws(() => backendSnapshotBoundary(workflow.replace('name: Build and qualify the V4 execution fixture\n', 'name: Skip the fixture qualification\n')), /missing backend step/);
  const save = jobSteps(workflow, 'backend').find(step => step.includes(`uses: actions/cache/save@${CACHE_ACTION}`));
  const moved = workflow.replace(`      - ${save}`, '').replace('      - name: Stop isolated database\n', `      - ${save}      - name: Stop isolated database\n`);
  assert.throws(() => backendSnapshotBoundary(moved), /before PostgreSQL tests/);
});
