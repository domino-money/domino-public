/**
 * The deploy guard in vite.config.ts, exercised through Vite itself.
 *
 * Pages deploys whatever sits in `pages_build_output_dir` (./dist). A fixture
 * or bridge-test build written there would ship fixture data, or a bridge
 * source aimed at a local stub's fixture pool, to the closed beta. The guard
 * refuses that: only the deployable modes may write there.
 *
 * `resolveConfig` loads the real vite.config.ts and runs its configResolved
 * hooks, which is where the guard throws, without bundling or writing a
 * single file. So a guard that stops working fails here and never gets the
 * chance to overwrite dist.
 */
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { resolveConfig } from 'vite';
import { FORBIDDEN, TEXT_FILE, assertDeployable, findForbidden } from '../scripts/deploy-markers.mjs';

const APP = resolve(import.meta.dirname, '..');
const CONFIG = join(APP, 'vite.config.ts');
const REFUSAL = /may not write to dist: that directory is what gets deployed/;

/** The directory Pages deploys, read from wrangler.toml rather than assumed. */
const DEPLOYED = (() => {
  const found = readFileSync(join(APP, 'wrangler.toml'), 'utf8').match(/^pages_build_output_dir\s*=\s*"([^"]+)"/m);
  assert.ok(found, 'wrangler.toml names pages_build_output_dir');
  return resolve(APP, found[1]);
})();

/**
 * Every mode vite.config.ts declares and the directory it writes to, read from
 * its MODES table. A mode added there (wallet-test on #70, consumer-test on
 * #72) joins the matrix below without an edit here; the first test checks
 * that each row read is what the config itself resolves.
 */
const MODES = (() => {
  const table = readFileSync(CONFIG, 'utf8').match(/^const MODES = \{\n([\s\S]*?)\n\} as const$/m);
  assert.ok(table, 'vite.config.ts declares its MODES table');
  return table[1]
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const row = line.match(/^\s+'?([a-z][a-z-]*)'?: \{.*\boutDir: '([^']+)'/);
      assert.ok(row, `a MODES row this test cannot read: ${line.trim()}`);
      return { mode: row[1], outDir: row[2] };
    });
})();
/** Modes with a directory of their own. None of them may write into dist. */
const GUARDED = MODES.filter(({ outDir }) => outDir !== 'dist');

/**
 * Removes a link and never what it points at. rmSync would refuse a junction
 * as a directory, and a recursive removal would empty dist through it.
 */
function dropLink(link) {
  let stat;
  try {
    stat = lstatSync(link);
  } catch {
    return;
  }
  assert.ok(stat.isSymbolicLink(), `${link} is not a link; refusing to remove it`);
  unlinkSync(link);
}

const resolveFor = (mode, outDir) =>
  resolveConfig({ root: APP, configFile: CONFIG, mode, logLevel: 'silent', ...(outDir === undefined ? {} : { build: { outDir } }) }, 'build', mode);

test('the guarded directory is the one Pages deploys', () => {
  assert.equal(DEPLOYED, join(APP, 'dist'));
});

test('the matrix covers every mode the config declares, each as the config resolves it', async () => {
  assert.deepEqual(MODES.filter(({ outDir }) => outDir === 'dist').map(({ mode }) => mode).sort(), ['development', 'production'], 'only the deployable builds write to dist');
  for (const mode of ['fixtures', 'bridge-test']) assert.ok(GUARDED.some((row) => row.mode === mode), `${mode} is in the matrix`);
  for (const { mode, outDir } of MODES) assert.equal((await resolveFor(mode)).build.outDir, outDir, mode);
});

const caseless = process.platform === 'win32' || process.platform === 'darwin';
const INTO_DIST = [
  ['dist', 'dist'],
  ['./dist/', './dist/'],
  ['an absolute path', DEPLOYED],
  ['a subdirectory, which ships with the site', 'dist/lab'],
  ['a path that climbs back into it', '.fixture-dist/../dist/x'],
  // `..lab` is a directory inside dist whose name starts with two dots, not a way out of it.
  ['a subdirectory whose name starts with two dots', 'dist/..lab'],
  ['a subdirectory whose name starts with two dots, as an absolute path', join(DEPLOYED, '..lab')],
  ...(caseless
    ? [
        ['another case, the same directory on this file system', 'DIST'],
        ['a subdirectory whose name starts with two dots, in another case', 'DIST/..lab'],
      ]
    : []),
];

for (const { mode, outDir: own } of GUARDED) {
  for (const [label, outDir] of INTO_DIST) {
    test(`a ${mode} build into ${label} is refused before anything is written`, async () => {
      await assert.rejects(resolveFor(mode, outDir), REFUSAL);
    });
  }

  test(`a ${mode} build through a link to dist is refused`, async (t) => {
    const created = !existsSync(DEPLOYED);
    if (created) mkdirSync(DEPLOYED);
    const link = join(APP, `.guard-link-${mode}`);
    dropLink(link);
    try {
      symlinkSync(DEPLOYED, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (created) rmSync(DEPLOYED, { recursive: true });
      t.skip(`this file system cannot create a link: ${error.code}`);
      return;
    }
    try {
      await assert.rejects(resolveFor(mode, link), REFUSAL);
      await assert.rejects(resolveFor(mode, join(link, 'lab')), REFUSAL);
      await assert.rejects(resolveFor(mode, join(link, '..lab')), REFUSAL);
    } finally {
      dropLink(link);
      if (created) rmSync(DEPLOYED, { recursive: true });
    }
    assert.ok(!existsSync(link), 'the link was removed');
  });

  test(`a ${mode} build to its own directory, or a sibling of dist, resolves`, async () => {
    assert.equal((await resolveFor(mode)).build.outDir, own);
    assert.equal((await resolveFor(mode, 'dist-lab')).build.outDir, 'dist-lab', 'a name that merely starts with dist is not dist');
    assert.equal((await resolveFor(mode, '..lab')).build.outDir, '..lab', 'a sibling of dist named ..lab is outside it');
  });
}

test('the deployable builds still write to dist', async () => {
  for (const { mode } of MODES.filter(({ outDir }) => outDir === 'dist')) {
    assert.equal((await resolveFor(mode)).build.outDir, 'dist', mode);
  }
});

// ---------------------------------------------------------------------------
// What a deployable build is, and what it may never carry.
// ---------------------------------------------------------------------------

test('production and development resolve to live bridge reads of the selected pools, deployable and checked; the test builds do not', async () => {
  for (const mode of ['production', 'development']) {
    const config = await resolveFor(mode);
    assert.deepEqual([config.define.__DOMINO_READ_MODE__, config.define.__DOMINO_POOL_SET__, config.define.__DOMINO_DEPLOYABLE__], ['"bridge"', '"selected"', 'true'], mode);
    assert.ok(config.plugins.some((p) => p.name === 'domino:deployable-bundle-check'), `${mode} runs the bundle check`);
  }
  assert.deepEqual((await resolveFor('fixtures')).define.__DOMINO_READ_MODE__, '"fixture"');
  for (const mode of ['fixtures', 'bridge-test']) {
    const config = await resolveFor(mode);
    assert.deepEqual([config.define.__DOMINO_POOL_SET__, config.define.__DOMINO_DEPLOYABLE__], ['"fixture"', 'false'], mode);
  }
});

test('assertDeployable refuses a deployable mode that reads anything but the bridge and the selection, builds the lab or switches a flag on', () => {
  const good = { read: 'bridge', pools: 'selected', deployable: true, outDir: 'dist', lab: false };
  assert.doesNotThrow(() => assertDeployable('production', good));
  assert.doesNotThrow(() => assertDeployable('production', { ...good, testHooks: false, depositLab: false, preview: null }), 'a flag that is off is fine');
  for (const [label, row, words] of [
    ['sample reads', { ...good, read: 'sample' }, /reads sample, not through the bridge/],
    ['fixture reads', { ...good, read: 'fixture' }, /reads fixture, not through the bridge/],
    ['the fixture pool set', { ...good, pools: 'fixture' }, /fixture pool set/],
    ['the read lab', { ...good, lab: true }, /builds the read lab/],
    ['test hooks', { ...good, testHooks: true }, /switches on testHooks/],
    ['a preview flag', { ...good, preview: true }, /switches on preview/],
    ['the deposit lab', { ...good, depositLab: true }, /switches on depositLab/],
    ['a wallet-test flag', { ...good, 'wallet-test': true }, /switches on wallet-test/],
    ['any other key switched on', { ...good, walletSession: 'on' }, /switches on walletSession/],
  ]) {
    assert.throws(() => assertDeployable('production', row), words, label);
  }
});

test('a deployable row that reads fixtures fails every build, the test builds included, before anything is written', async () => {
  const source = readFileSync(CONFIG, 'utf8');
  const broken = source.replace("production: { read: 'bridge', pools: 'selected'", "production: { read: 'fixture', pools: 'selected'");
  assert.notEqual(broken, source, 'the production row was found and changed');
  const copy = join(APP, '.guard-config-mode.vite.config.ts');
  writeFileSync(copy, broken);
  try {
    for (const mode of ['production', 'bridge-test']) {
      await assert.rejects(
        resolveConfig({ root: APP, configFile: copy, mode, logLevel: 'silent' }, 'build', mode),
        /production mode is deployable and may not: reads fixture, not through the bridge/,
        mode,
      );
    }
  } finally {
    rmSync(copy, { force: true });
  }
  assert.ok(!existsSync(copy), 'the copy was removed');
});

test('the bundle check fails a deployable build on any forbidden marker, lets a clean bundle through, and leaves test builds alone', async () => {
  const plugin = (await resolveFor('production')).plugins.find((p) => p.name === 'domino:deployable-bundle-check');
  const bundle = (files) =>
    Object.fromEntries(Object.entries(files).map(([fileName, text]) => [fileName, fileName.endsWith('.js') ? { type: 'chunk', fileName, code: text } : { type: 'asset', fileName, source: text }]));
  const run = (files) => plugin.generateBundle.call({}, {}, bundle(files));
  assert.doesNotThrow(() => run({ 'assets/index.js': 'fetch("/api/read/v1/capabilities");"Selected pools"', 'index.html': '<div id="root"></div>', 'tokens/marlin.jpg': 'Sample' }));
  for (const [file, text] of [
    ['assets/index.js', 'notice:"Sample figures for layout"'],
    ['assets/index.js', 'localStorage.getItem("domino-practice-v1")'],
    ['assets/index-x.css', '.practice-card{}'],
    ['index.html', '<div data-build-banner="fixture"></div>'],
    ['assets/index.js', '{token:"MEME",stable:"USDG"}'],
    ['assets/index.js', '"0x0911afcb281d7bcae2d71443ceaeebd0f89b4537708449970d797622b4b4c941"'],
    ['assets/index.js', 'window.__DOMINO_TEST_HOOKS__'],
    ['favicon.svg', '<svg><title>Fixture data</title></svg>'],
  ]) {
    assert.throws(() => run({ [file]: text }), /deployable and carries what must never ship/, `${file}: ${text}`);
  }
  const lab = (await resolveFor('fixtures')).plugins.find((p) => p.name === 'domino:deployable-bundle-check');
  assert.doesNotThrow(() => lab.generateBundle.call({}, {}, bundle({ 'assets/lab.js': 'Fixture build: not deployable' })), 'a test build writes elsewhere and is not checked');
});

test('findForbidden: the words and values of sample, practice, fixture and test code, and nothing a live bundle carries', () => {
  for (const text of [
    'Sample data',
    'sampleMarkets',
    'Practice mode',
    'domino-practice-v1',
    'MEME / USDG',
    'Example token',
    'Fixture build: read-v1 contract fixtures',
    'Bridge test build',
    'Not deployable',
    'data-build-banner',
    'Fixture data',
    'Contract fixtures from read-v1',
    'fixtures/gateway/token.success.json',
    '0911AFCB281D7BCAE2D71443CEAEEBD0F89B4537708449970D797622B4B4C941',
    '0xabababababababababab',
    'c0ffeec0ffee',
    '<img src=x onerror=alert(1)>',
    '/read-lab.html',
    'testHooks',
    '__DOMINO_TEST_HOOKS__',
    'depositLab',
  ]) {
    assert.ok(findForbidden(text).length > 0, text);
  }
  for (const text of ['/api/read/v1/capabilities', 'X-Domino-Read-Contract', 'Live data isn\'t connected yet', 'Selected pools', 'GeckoTerminal', 'provenance.fixture', 'Global Dollar', 'MEMEX', 'Not available in the alpha']) {
    assert.deepEqual(findForbidden(text), [], text);
  }
  assert.equal(findForbidden('Sample sample SAMPLE sample', 2).length, 2, 'hits are capped per marker');
  assert.ok(FORBIDDEN.length >= 10);
  assert.ok(TEXT_FILE.test('assets/index-abc.js') && TEXT_FILE.test('tokens/usdg.svg') && TEXT_FILE.test('index.html'));
  assert.ok(!TEXT_FILE.test('tokens/marlin.jpg'), 'binary artwork is not scanned as text');
});
