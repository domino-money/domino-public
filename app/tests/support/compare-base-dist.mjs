/**
 * Proves the default build is byte for byte the base branch's: builds the
 * default (production) mode of this tree and of a base commit, then compares
 * every file of the two outputs by sha256. Exits 1 on any difference.
 *
 * Not part of check:app: it needs the base commit in the local history and
 * two production builds. Run it from app/ after `npm test` (which compiles the
 * middleware the builds do not need, but the tree expects):
 *
 *   node tests/support/compare-base-dist.mjs [base-ref]    (default 0805432)
 *
 * The base tree is written with a throwaway index (git read-tree and
 * checkout-index into a temporary directory): no branch is checked out, no
 * worktree is added, and this repository's index is untouched. It builds
 * with this tree's node_modules through junctions, so the script first checks
 * that both lock files are the same at the base. Neither build writes into
 * app/dist. A fresh base tree has no .consumer-test-dist or other build
 * output in it, which matters: the base's .gitignore does not list
 * .consumer-test-dist, and Tailwind would scan a leftover one.
 *
 * The file sits in tests/support, which the default build's Tailwind scan
 * already leaves out, so adding it cannot change the stylesheet it measures.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const APP = resolve(import.meta.dirname, '../..');
const REPO = resolve(APP, '..');
const BASE = process.argv[2] ?? '0805432';
const VITE = join(APP, 'node_modules/vite/bin/vite.js');

const git = (args, env = {}) => execFileSync('git', ['-C', REPO, '-c', 'core.longpaths=true', ...args], { env: { ...process.env, ...env } });

function hashes(dir) {
  const out = new Map();
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.set(relative(dir, path).replaceAll('\\', '/'), createHash('sha256').update(readFileSync(path)).digest('hex'));
    }
  };
  walk(dir);
  return out;
}

function build(appDir, outDir) {
  execFileSync(process.execPath, [VITE, 'build', '--logLevel', 'warn', '--outDir', outDir, '--emptyOutDir'], { cwd: appDir, stdio: 'inherit' });
  return hashes(outDir);
}

const work = mkdtempSync(join(tmpdir(), 'domino-dist-'));
try {
  const baseSha = git(['rev-parse', '--verify', `${BASE}^{commit}`]).toString().trim();
  const headSha = git(['rev-parse', 'HEAD']).toString().trim();
  const dirty = git(['status', '--porcelain', '--', 'app']).toString().trim();

  for (const lock of ['app/package-lock.json', 'web/package-lock.json']) {
    if (!git(['show', `${baseSha}:${lock}`]).equals(readFileSync(join(REPO, lock)))) {
      throw new Error(`${lock} differs at ${BASE}: this tree's node_modules cannot build the base.`);
    }
  }

  const tree = join(work, 'base');
  mkdirSync(tree);
  const index = { GIT_INDEX_FILE: join(work, 'index') };
  git(['read-tree', baseSha], index);
  git(['checkout-index', '--all', `--prefix=${tree.replaceAll('\\', '/')}/`], index);
  for (const dir of ['app', 'web']) {
    if (existsSync(join(REPO, dir, 'node_modules'))) symlinkSync(join(REPO, dir, 'node_modules'), join(tree, dir, 'node_modules'), 'junction');
  }

  const base = build(join(tree, 'app'), join(work, 'base-dist'));
  const head = build(APP, join(work, 'head-dist'));

  const names = [...new Set([...base.keys(), ...head.keys()])].sort();
  let differ = 0;
  for (const name of names) {
    const same = base.get(name) === head.get(name);
    if (!same) differ += 1;
    console.log(`${same ? 'same   ' : 'DIFFERS'}  ${name}  ${(head.get(name) ?? '(missing)').slice(0, 16)}  base ${(base.get(name) ?? '(missing)').slice(0, 16)}`);
  }
  console.log(`\nbase ${BASE} (${baseSha.slice(0, 12)}) vs HEAD ${headSha.slice(0, 12)}${dirty ? ' plus uncommitted app/ changes' : ''}: ${names.length} files, ${differ} differ.`);
  process.exitCode = differ === 0 ? 0 : 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
