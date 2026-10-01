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
