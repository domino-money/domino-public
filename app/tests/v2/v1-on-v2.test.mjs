/**
 * The V2-compiled V1 test harness (Domino V2 integration, 2026-10-02, the base agent's item 3), without a browser:
 *
 *   - wallet-test-v2 is wallet-test with V2 compiled in: the same row but `v2` and its own directory, the same defines
 *     but V2's two; a test build (test hooks on, never deployable, not the site), ignored by git (so by Tailwind's scan);
 *   - scripts/v1-on-v2.mjs runs exactly test:session's and test:finance's browser suites, with --test-force-exit, on that build
 *     (`DOMINO_WALLET_DIST`), with the gate-open preload in every test process (`NODE_OPTIONS=--import=...`);
 *   - tests/support/wallet-dist.mjs takes the wallet-test build by default, the V2 one when asked, and nothing else.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolveConfig } from 'vite';

const APP = resolve(import.meta.dirname, '../..');
const CONFIG = join(APP, 'vite.config.ts');
const resolveFor = (mode) => resolveConfig({ root: APP, configFile: CONFIG, configLoader: 'runner', mode, logLevel: 'silent' }, 'build', mode);
const ROWS = (() => {
  const config = readFileSync(CONFIG, 'utf8');
  return Object.fromEntries([...config.slice(config.indexOf('const MODES'), config.indexOf('} as const')).matchAll(/^\s+'?([a-z0-9-]+)'?: \{(.+)\},?$/gm)].map(([, name, row]) => [name, row]));
})();

test('wallet-test-v2 is wallet-test with V2 compiled in: the same row and defines but V2\'s, its own directory, a test build', async () => {
  const plain = ROWS['wallet-test'].replace("outDir: '.wallet-test-dist'", 'OUT').replace('v2: false', 'V2');
  const v2 = ROWS['wallet-test-v2'].replace("outDir: '.wallet-test-v2-dist'", 'OUT').replace('v2: true', 'V2');
  assert.equal(v2, plain, 'the rows differ only in the directory and V2');
  assert.match(ROWS['wallet-test-v2'], /deployable: false.*testHooks: true.*site: false/);
  const [a, b] = [await resolveFor('wallet-test'), await resolveFor('wallet-test-v2')];
  assert.equal(b.build.outDir, '.wallet-test-v2-dist');
  for (const name of Object.keys(a.define)) {
    if (name === '__DOMINO_V2__' || name === '__DOMINO_V2_FIXTURE_SETS__') assert.deepEqual([a.define[name], b.define[name]], ['false', 'true'], name);
    else assert.equal(b.define[name], a.define[name], name);
  }
  assert.equal(b.define.__DOMINO_TEST_HOOKS__, 'true', 'the gate\'s test hooks are read there');
  assert.ok(b.plugins.some((plugin) => plugin.name === 'domino:v2-build-mark'), 'its page is marked as a V2 build');
  assert.deepEqual(readFileSync(join(APP, '.gitignore'), 'utf8').split(/\r?\n/).filter((line) => line === '.wallet-test-v2-dist/'), ['.wallet-test-v2-dist/']);
  const { scripts } = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'));
  assert.equal(scripts['build:wallet-test-v2'], 'vite build --mode wallet-test-v2');
  assert.equal(scripts['test:v1-on-v2'], 'npm run build:wallet-test-v2 && node scripts/v1-on-v2.mjs');
  assert.equal(scripts['test:v2in'], 'npm run build:wallet-test-v2 && node --test --test-force-exit "tests/v2in-browser/*.test.mjs"');
});

test('scripts/v1-on-v2.mjs runs test:session\'s and test:finance\'s own browser suites on the V2 build, with the gate-open preload', async () => {
  const launcher = await import(pathToFileURL(join(APP, 'scripts/v1-on-v2.mjs')).href);
  const { scripts } = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'));
  const files = (script) => script.split('&&').map((part) => part.trim().split(/\s+/)).filter((part) => part[0] === 'node' && part.includes('--test')).flatMap((part) => part.filter((word) => word.endsWith('.browser.test.mjs')));
  assert.deepEqual(launcher.FAMILIES.session, files(scripts['test:session']));
  assert.deepEqual(launcher.FAMILIES.finance, files(scripts['test:finance']));
  assert.deepEqual(launcher.FAMILIES.session, ['tests/session.browser.test.mjs'], 'the session bundle\'s measured shape is not a V2 build\'s: its browser suite only');
  // Changed on purpose (data) 2026-10-03 (the owner's point 10): the Price range card's own suite joins test:finance.
  assert.ok(launcher.FAMILIES.finance.includes('tests/position-actions.browser.test.mjs') && launcher.FAMILIES.finance.includes('tests/price-range.browser.test.mjs') && launcher.FAMILIES.finance.length === 7);
  const env = launcher.v1OnV2Env({ PATH: 'x', NODE_OPTIONS: '--max-old-space-size=4096' });
  assert.equal(env.DOMINO_WALLET_DIST, '.wallet-test-v2-dist');
  assert.equal(env.NODE_OPTIONS, `--max-old-space-size=4096 --import=${pathToFileURL(join(APP, 'tests/support/v2-gate-open.mjs')).href}`);
  assert.doesNotMatch(env.NODE_OPTIONS.split('--import=')[1], /\s/, 'the preload\'s URL has no space to split on');
  assert.equal(launcher.v1OnV2Env({}).NODE_OPTIONS, `--import=${pathToFileURL(join(APP, 'tests/support/v2-gate-open.mjs')).href}`);
  const source = readFileSync(join(APP, 'scripts/v1-on-v2.mjs'), 'utf8');
  assert.match(source, /spawnSync\(process\.execPath, \['--test', '--test-force-exit', \.\.\.files\]/, 'every run passes --test-force-exit');
  const unknown = spawnSync(process.execPath, ['scripts/v1-on-v2.mjs', 'pages'], { cwd: APP, encoding: 'utf8' });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown family: pages/);
});

test('the suites\' wallet build: wallet-test by default, wallet-test-v2 when asked, nothing else', () => {
  const ask = (value) => spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(pathToFileURL(join(APP, 'tests/support/wallet-dist.mjs')).href)}); console.log(m.WALLET_DIST)`], { cwd: APP, encoding: 'utf8', env: { ...process.env, DOMINO_WALLET_DIST: value } });
  assert.equal(ask('').stdout.trim(), join(APP, '.wallet-test-dist'));
  assert.equal(ask('.wallet-test-dist').stdout.trim(), join(APP, '.wallet-test-dist'));
  assert.equal(ask('.wallet-test-v2-dist').stdout.trim(), join(APP, '.wallet-test-v2-dist'));
  const refused = ask('dist');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /DOMINO_WALLET_DIST may be \.wallet-test-dist or \.wallet-test-v2-dist, not dist/);
  for (const suite of ['tests/charts.browser.test.mjs', 'tests/finance.browser.test.mjs']) {
    const text = readFileSync(join(APP, suite), 'utf8');
    assert.doesNotMatch(text, /\.wallet-test-dist/, `${suite} serves the build wallet-dist.mjs names`);
    if (suite === 'tests/charts.browser.test.mjs') {
      assert.match(text, /dist = WALLET_DIST/, 'chart scenarios default to the admitted wallet build; only explicit before/after capture can override it');
      assert.match(text, /createWalletServer\(\{ fake, dist, routes:/);
    } else assert.match(text, /dist: WALLET_DIST/);
  }
});

// The integrated screens' own browser suites (tests/v2in-browser, `npm run test:v2in`) are held to what tests/build-guard
// holds the top-level suites to: Edge offered for Edge-only machines, browsers closed through closeBrowser (macOS keeps
// Chrome's pipes open for minutes otherwise), and --test-force-exit on the run.
test('the integrated screens\' browser suites offer Edge, close their browsers through closeBrowser, and run with --test-force-exit', () => {
  const dir = join(APP, 'tests/v2in-browser');
  const suites = readdirSync(dir).filter((name) => name.endsWith('.test.mjs'));
  assert.ok(suites.includes('base.test.mjs'), 'the harness\'s own suite is there');
  for (const name of suites) {
    const text = readFileSync(join(dir, name), 'utf8');
    if (!/^import .* from 'playwright-core';?$/m.test(text)) continue;
    assert.ok(text.includes("'msedge'"), `${name} offers the msedge channel`);
    assert.ok(text.includes("from '../support/close-browser.mjs'"), `${name} closes its browsers through closeBrowser`);
    const launched = [...text.matchAll(/(\w+) = await chromium\.launch\(/g)].map((match) => match[1]);
    assert.ok(launched.length > 0, `${name} launches a browser this check can follow: assign it as \`name = await chromium.launch(...)\``);
    for (const variable of launched) assert.doesNotMatch(text, new RegExp(`\\b${variable}\\??\\.close\\(`), `${name} closes ${variable} through closeBrowser, never itself`);
  }
  const { scripts } = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'));
  assert.match(scripts['test:v2in'], /node --test --test-force-exit "tests\/v2in-browser\/\*\.test\.mjs"$/);
});
