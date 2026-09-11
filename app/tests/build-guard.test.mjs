/**
 * The deploy guard in vite.config.ts, exercised through Vite itself.
 *
 * Pages deploys whatever sits in `pages_build_output_dir` (./dist). A fixture
 * or bridge-test build written there would ship fixture data, or the bridge
 * source with live reads on, to the closed beta. The guard refuses that.
 *
 * `resolveConfig` loads the real vite.config.ts and runs its configResolved
 * hooks, which is where the guard throws, without bundling or writing a
 * single file. So a guard that stops working fails here and never gets the
 * chance to overwrite dist.
 */
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { resolveConfig } from 'vite';

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
  assert.deepEqual(MODES.filter(({ outDir }) => outDir === 'dist').map(({ mode }) => mode).sort(), ['development', 'production'], 'only the sample builds write to dist');
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

test('the sample build still writes to dist', async () => {
  for (const { mode } of MODES.filter(({ outDir }) => outDir === 'dist')) {
    assert.equal((await resolveFor(mode)).build.outDir, 'dist', mode);
  }
});
