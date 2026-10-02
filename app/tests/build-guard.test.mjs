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
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { resolveConfig } from 'vite';
import { FORBIDDEN, TEXT_FILE, assertDeployable, findForbidden } from '../scripts/deploy-markers.mjs';

/** The app directory, for the standalone compile the backend suite mirrors. */
const here = fileURLToPath(new URL('..', import.meta.url));

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
  for (const mode of ['fixtures', 'bridge-test', 'wallet-test', 'consumer-test']) assert.ok(GUARDED.some((row) => row.mode === mode), `${mode} is in the matrix`);
  for (const { mode, outDir } of MODES) assert.equal((await resolveFor(mode)).build.outDir, outDir, mode);
});

test('only the consumer-test build compiles in the previews and the deposit lab, and it writes a manifest', async () => {
  for (const mode of ['production', 'development', 'fixtures', 'bridge-test', 'wallet-test']) {
    const config = await resolveFor(mode);
    assert.equal(config.define.__DOMINO_ONBOARDING_PREVIEW__, 'false', `${mode} previews`);
    assert.equal(config.define.__DOMINO_DEPOSIT_LAB__, 'false', `${mode} deposit lab`);
    assert.equal(config.build.manifest, false, `${mode} manifest`);
  }
  const consumer = await resolveFor('consumer-test');
  assert.equal(consumer.define.__DOMINO_ONBOARDING_PREVIEW__, 'true');
  assert.equal(consumer.define.__DOMINO_DEPOSIT_LAB__, 'true');
  assert.equal(consumer.define.__DOMINO_WALLET_SESSION__, 'true', 'the previews need the wallet session');
  assert.equal(consumer.build.manifest, true);
});

test('an unknown build mode is refused', async () => {
  await assert.rejects(resolveFor('consumer-live'), /Unknown mode "consumer-live"/);
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
    // This is one known regular file. On the Windows/OneDrive checkout,
    // Node's rmSync(force) can return without removing it; unlink is exact.
    if (existsSync(copy)) unlinkSync(copy);
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
    // 2026-10-01 (RPC-SPEC §2.8): Domino's own node's token-bearing URL, and the secret's name.
    'https://rpc.domino.money/test-token-0123456789abcdef/',
    'rpc.domino.money/AbCdEfGh01234567',
    'LOCAL_RPC_URL',
  ]) {
    assert.ok(findForbidden(text).length > 0, text);
  }
  for (const text of ['/api/read/v1/capabilities', 'X-Domino-Read-Contract', 'Live data unavailable', 'Selected pools', 'GeckoTerminal', 'provenance.fixture', 'Global Dollar', 'MEMEX', 'Not available in the alpha', 'rpc.domino.money', 'https://rpc.domino.money/', '/api/owned/v2/positions', '/api/chain/v1/simulate']) {
    assert.deepEqual(findForbidden(text), [], text);
  }
  assert.equal(findForbidden('Sample sample SAMPLE sample', 2).length, 2, 'hits are capped per marker');
  assert.ok(FORBIDDEN.length >= 10);
  assert.ok(TEXT_FILE.test('assets/index-abc.js') && TEXT_FILE.test('tokens/usdg.svg') && TEXT_FILE.test('index.html'));
  assert.ok(!TEXT_FILE.test('tokens/marlin.jpg'), 'binary artwork is not scanned as text');
});

// Added 2026-09-20 after the same gap bit twice: tests/finance.browser.test.mjs
// and then rugged's new tests/read-public.browser.test.mjs each listed chrome
// and chromium but not msedge, so on a Windows machine with only Edge every
// case in them failed with "a Chromium browser is required" — a suite that
// reads as broken when only its launch list is short. Any new browser suite
// now has to include the channel or this fails by name.
test('every browser suite offers the msedge channel, so Edge-only machines can run them', () => {
  const dir = new URL('./', import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith('.mjs'));
  const missing = [];
  for (const name of files) {
    const text = readFileSync(new URL(name, dir), 'utf8');
    if (!text.includes('chromium.launch')) continue;
    if (!text.includes("channel: 'msedge'") && !text.includes("'msedge'")) missing.push(name);
  }
  assert.deepEqual(missing, [], `these launch a browser without offering Edge: ${missing.join(', ')}`);
});

// Added 2026-09-25. On macOS, branded Chrome starts GoogleUpdater about 20
// seconds after launch, and the updater and the crash handlers keep the pipes
// playwright-core opened for Chrome's output, for up to ten minutes after
// Chrome exits. browser.close() waits for those pipes, so suites whose tests
// had all passed sat there for ten minutes and more. closeBrowser
// (support/close-browser.mjs) stops waiting once the browser is gone, and
// --test-force-exit ends the file, whose event loop the pipes still hold.
// These two keep a new suite from bringing the wait back. The unit run
// (scripts/test.mjs), which also runs local-live-vite, goes without the flag:
// there it would hide handles a unit test leaks.
/** The test files that drive a real browser, by their playwright-core import, and each one's text. */
const BROWSER_SUITES = (() => {
  const dir = new URL('./', import.meta.url);
  const imports = /^import .* from 'playwright-core';?$/m;
  return new Map(readdirSync(dir)
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => [name, readFileSync(new URL(name, dir), 'utf8')])
    .filter(([, text]) => imports.test(text)));
})();

test('every browser suite closes its browsers through closeBrowser, never browser.close() itself', () => {
  assert.ok(BROWSER_SUITES.size >= 14, `only ${BROWSER_SUITES.size} files import playwright-core: the pattern went blind, or suites went away (lower the count)`);
  const direct = [];
  for (const [name, text] of BROWSER_SUITES) {
    const launched = [...text.matchAll(/(\w+) = await chromium\.launch\(/g)].map((match) => match[1]);
    assert.ok(launched.length > 0, `${name} launches a browser this guard cannot follow: assign it as \`name = await chromium.launch(...)\``);
    const closed = launched.some((variable) => new RegExp(`\\b${variable}\\??\\.close\\(`).test(text));
    if (closed || !text.includes("from './support/close-browser.mjs'")) direct.push(name);
  }
  assert.deepEqual(direct, [], `these close a browser without closeBrowser: ${direct.join(', ')}`);
});

test('every node --test that runs a browser suite passes --test-force-exit', () => {
  const suites = [...BROWSER_SUITES.keys()].map((name) => `tests/${name}`);
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  // 2026-10-01 (audit H2): a suite run in parts (tests/support/parts.mjs) runs through its parts' entry files, each of
  // which imports it: an entry file stands for the suite it imports.
  const runs = (word) => {
    if (suites.includes(word)) return [word];
    if (!/^tests\/[\w.-]+\.mjs$/.test(word)) return [];
    const text = readFileSync(new URL(`../${word}`, import.meta.url), 'utf8');
    return [...text.matchAll(/\bimport\('\.\/([\w.-]+\.mjs)'\)/g)].map((match) => `tests/${match[1]}`).filter((file) => suites.includes(file));
  };
  const run = new Set();
  const missing = [];
  for (const [name, script] of Object.entries(scripts)) {
    for (const command of script.split('&&').map((part) => part.trim().split(/\s+/))) {
      if (command[0] !== 'node' || !command.includes('--test')) continue;
      const browsers = command.flatMap(runs);
      for (const file of browsers) run.add(file);
      if (browsers.length > 0 && !command.includes('--test-force-exit')) missing.push(`${name} (${browsers.join(', ')})`);
    }
  }
  assert.deepEqual(missing, [], `these run a browser suite without --test-force-exit: ${missing.join('; ')}`);
  assert.deepEqual(suites.filter((file) => !run.has(file)), [], 'every browser suite runs from a package script');
});

// Added 2026-09-21. rugged's backend suite compiles our wallet SDKs ALONE, with
// plain tsc and no project, to check them against the contracts
// (backend/tests/test_setup_sdk_evm.py and test_sequence_sdk_evm.py). That
// compile sees no ambient declarations, so a build flag taken from
// src/build-flags.d.ts type-checks here and fails there — a frontend change
// breaking his CI, from a file he does not own. Anything these two reach must
// stand on its own.
//
// It EMITS and then RUNS what it emitted under `{"type":"module"}`. A first
// version of this guard only type-checked, and missed the second half: Vite
// resolves `from './pin'` and plain Node ESM does not, so an extensionless
// relative import compiles here and throws ERR_MODULE_NOT_FOUND there. Every
// relative import these two reach needs the extension the emitted file will
// have. Emitting inside .test-build (gitignored) lets Node find viem by
// walking up to app/node_modules, which is what his symlink is for.
// src/ is TypeScript. A compiled .js beside its .ts is not just clutter: Vite
// resolves an extensionless import through `.js` BEFORE `.ts`, so a stale emit
// silently wins over the source it came from, and nothing says so. One reached
// this repo on 2026-09-21, written by `tsc --outDir` when a `--rootDir` it
// could not honour sent the emit next to the source instead.
test('src carries no compiled JavaScript beside its TypeScript', () => {
  const root = resolve(here, 'src');
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : /\.(js|jsx|mjs|cjs)$/.test(entry.name) ? [full] : [];
  });
  const strays = walk(root).map((file) => file.slice(root.length + 1).split(sep).join('/'));
  assert.deepEqual(strays, [], `compiled files under src/: ${strays.join(', ')}`);
});

// The deployment pin in src/finance/pin.ts is enforced only by a build whose
// `__DOMINO_DEPLOYABLE__` define says true. That is safe exactly while every
// mode writes the define, so a dist always carries a literal and never falls
// through to "absent". Four harnesses compile those SDKs outside Vite and
// would otherwise be refused a contract they deployed themselves.
test('every build writes the deployable define, so no dist can be missing it', () => {
  const config = readFileSync(resolve(here, 'vite.config.ts'), 'utf8');
  assert.match(config, /__DOMINO_DEPLOYABLE__:\s*JSON\.stringify\(settings\.deployable\)/,
    'the define must be written from the mode row, unconditionally');
  const defines = [...config.matchAll(/__DOMINO_DEPLOYABLE__:/g)];
  assert.equal(defines.length, 1, 'one define, so no mode can take a different path to it');
  const modes = config.slice(config.indexOf('const MODES'), config.indexOf('} as const'));
  const rows = [...modes.matchAll(/^\s+'?([a-z-]+)'?:\s*\{(.+)$/gm)];
  assert.ok(rows.length >= 6, `expected the MODES rows to still be one per line: found ${rows.length}`);
  for (const [, name, row] of rows) assert.match(row, /deployable: (true|false)/, `${name} says nothing about being deployable`);
  assert.deepEqual(rows.filter(([, , row]) => /deployable: true/.test(row)).map(([, name]) => name), ['production', 'development']);
});

test('the wallet SDKs compile alone, and the emitted modules load, the way the backend suite does it', async () => {
  const tsc = resolve(here, 'node_modules/typescript/bin/tsc');
  const root = resolve(here, '.test-build/sdk-standalone');
  rmSync(root, { recursive: true, force: true });
  // 2026-09-24: position (the owner's collect and close, finance/position.ts) is held to the same standalone shape.
  for (const entry of ['setup', 'sequence', 'position']) {
    const out = join(root, entry);
    mkdirSync(out, { recursive: true });
    const run = spawnSync(process.execPath, [tsc, resolve(here, `src/finance/${entry}.ts`),
      '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
      '--strict', '--skipLibCheck', '--outDir', out, '--rootDir', resolve(here, 'src/finance')],
      { encoding: 'utf8' });
    assert.equal(run.status, 0, `src/finance/${entry}.ts does not compile on its own:
${run.stdout}${run.stderr}`);
    writeFileSync(join(out, 'package.json'), '{"type":"module"}');
    const loaded = await import(pathToFileURL(join(out, `${entry}.js`)).href)
      .catch((error) => ({ failed: error }));
    assert.equal(loaded.failed, undefined, `${entry}.js does not load under plain Node ESM: ${loaded.failed?.code ?? loaded.failed?.message}`);
  }
  rmSync(root, { recursive: true, force: true });
});
