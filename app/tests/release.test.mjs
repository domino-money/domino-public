/**
 * scripts/release.mjs against a throwaway app directory: a stable digest,
 * refusal of one changed byte, of a forbidden marker, of a link the digest
 * cannot cover, and of a production deploy preview has not had. wrangler is
 * never started: every deploy here goes to an injected runner, and nothing
 * touches Cloudflare.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { BUNDLED, WRANGLER, deploy, deployCommand, inventory, record, verify } from '../scripts/release.mjs';

/** A stand-in commit for the manifest; never a real one. */
const HEAD = 'test-head';
const now = () => new Date('2026-09-11T12:00:00.000Z');

/**
 * A stand-in for git in the checkout being recorded: HEAD is HEAD, and
 * `tracked` and `untracked` are what status and ls-files print. It keeps the
 * questions it was asked. Every record here goes to one; git never runs.
 */
function fakeGit({ tracked = '', untracked = '', status = 0 } = {}) {
  const asked = [];
  const git = (args) => {
    asked.push(args.join(' '));
    if (status !== 0) return { status, stdout: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${HEAD}\n` };
    if (args[0] === 'status') return { status: 0, stdout: tracked };
    if (args[0] === 'ls-files') return { status: 0, stdout: untracked };
    return { status: 1, stdout: '' };
  };
  git.asked = asked;
  return git;
}

const BASE = {
  'dist/index.html': '<!doctype html><div id="root"></div>',
  'dist/assets/index-a1.js': 'fetch("/api/read/v1/capabilities")',
  'dist/tokens/eth.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'functions/_middleware.ts': 'export const onRequest = () => null',
  'wrangler.toml': 'name = "x"\npages_build_output_dir = "./dist"\n',
};

/** A throwaway app directory with the given files, written in the given order. */
function app(files = BASE) {
  const root = mkdtempSync(join(tmpdir(), 'domino-release-'));
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  for (const [path, text] of Object.entries(files)) put(path, text);
  return { root, put, done: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * A link at `path` pointing at `target`, or false when the platform refuses
 * that link: Windows wants a privilege for a symlink to a file, which these
 * tests must not need, so directories are linked there with an NTFS junction.
 * `type` is ignored off Windows. Link, junction: lstat says the same of both,
 * neither a regular file nor a directory, which is what a release refuses.
 */
function link(target, path, type) {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch (error) {
    if (error.code === 'EPERM' && type === 'file') return false;
    throw error;
  }
}

/**
 * rugged97's added asset: a link under dist to synthetic JS carrying a
 * forbidden marker, which the marker scan never opens while the walker does
 * not count a link as a file. Returns the path the walker meets.
 */
function plantAsset(root) {
  const payload = join(root, '.payload');
  mkdirSync(payload, { recursive: true });
  writeFileSync(join(payload, 'added.js'), 'const notice = "Sample figures for layout"\n');
  if (link(join(payload, 'added.js'), join(root, 'dist', 'added.js'), 'file')) return 'dist/added.js';
  link(payload, join(root, 'dist', 'added'), 'junction');
  return 'dist/added';
}

/** One of the inventory's input roots, replaced by a link to what it held; false, the tree as it was, when the platform refuses that link. */
function linkRoot(root, name, type) {
  const real = join(root, `.real-${name}`);
  renameSync(join(root, name), real);
  if (link(real, join(root, name), type)) return true;
  renameSync(real, join(root, name));
  return false;
}

test('the digest covers dist, functions and wrangler.toml, sorted, and does not depend on when or in what order files were written', () => {
  const a = app();
  const b = app(Object.fromEntries(Object.entries(BASE).reverse()));
  try {
    const one = inventory(a.root);
    assert.match(one.digest, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(one.files), ['dist/assets/index-a1.js', 'dist/index.html', 'dist/tokens/eth.svg', 'functions/_middleware.ts', 'wrangler.toml']);
    assert.equal(inventory(a.root).digest, one.digest, 'the same bytes, the same digest');
    assert.equal(inventory(b.root).digest, one.digest, 'written in another order, the same digest');
    for (const path of ['functions/_middleware.ts', 'wrangler.toml', 'dist/tokens/eth.svg']) {
      b.put(path, `${BASE[path]} `);
      assert.notEqual(inventory(b.root).digest, one.digest, `${path} is covered`);
      b.put(path, BASE[path]);
    }
  } finally {
    a.done();
    b.done();
  }
});

test('record writes the manifest; verify passes on the same bytes and fails on one changed byte, an added file or a removed one', () => {
  const a = app();
  try {
    const manifest = record({ root: a.root, git: fakeGit(), now });
    assert.deepEqual([manifest.gitHead, manifest.builtAt, Object.keys(manifest.files).length], [HEAD, '2026-09-11T12:00:00.000Z', 5]);
    assert.deepEqual(JSON.parse(readFileSync(join(a.root, '.release/manifest.json'), 'utf8')), manifest);
    assert.equal(verify({ root: a.root }).ok, true);

    a.put('dist/assets/index-a1.js', 'fetch("/api/read/v1/capabilitieS")');
    assert.deepEqual(verify({ root: a.root }).problems, ['changed: dist/assets/index-a1.js'], 'one changed byte');
    a.put('dist/assets/index-a1.js', BASE['dist/assets/index-a1.js']);
    assert.equal(verify({ root: a.root }).ok, true, 'restored');

    a.put('dist/extra.txt', 'x');
    assert.deepEqual(verify({ root: a.root }).problems, ['added: dist/extra.txt']);
    unlinkSync(join(a.root, 'dist/extra.txt'));
    unlinkSync(join(a.root, 'dist/tokens/eth.svg'));
    assert.deepEqual(verify({ root: a.root }).problems, ['missing: dist/tokens/eth.svg']);
  } finally {
    a.done();
  }
});

test('a dist carrying a forbidden marker is not recorded, and nothing unrecorded verifies', () => {
  const a = app({ ...BASE, 'dist/assets/index-b2.js': 'notice:"Sample figures for layout"' });
  try {
    assert.throws(() => record({ root: a.root, git: fakeGit(), now }), /must never ship[\s\S]*dist\/assets\/index-b2\.js: sample/);
    assert.equal(existsSync(join(a.root, '.release/manifest.json')), false, 'no manifest written');
    assert.equal(verify({ root: a.root }).ok, false, 'no record, nothing verifies');
    assert.throws(() => record({ root: app({ 'functions/_middleware.ts': 'x' }).root, git: fakeGit(), now }), /dist\/index\.html is missing/);
  } finally {
    a.done();
  }
});

test('a checkout with uncommitted changes is not recorded, so --commit-hash always names the bytes that were built', () => {
  const a = app();
  const manifest = join(a.root, '.release/manifest.json');
  try {
    for (const [git, shown, label] of [
      [fakeGit({ tracked: ' M app/src/App.tsx\n' }), ' M app/src/App.tsx', 'a changed tracked file under app/'],
      [fakeGit({ tracked: 'M  api-contracts/read-v1/runtime.mjs\n' }), 'M  api-contracts/read-v1/runtime.mjs', 'a staged change outside app/ that the build still reads'],
      [fakeGit({ tracked: ' D app/public/_headers\n' }), ' D app/public/_headers', 'a deleted tracked file'],
      [fakeGit({ untracked: 'app/public/extra.svg\n' }), '?? app/public/extra.svg', 'an untracked file under app/, which public/ would ship'],
    ]) {
      assert.throws(() => record({ root: a.root, git, now }), (error) => /uncommitted changes/.test(error.message) && error.message.includes(shown), label);
      assert.equal(existsSync(manifest), false, `${label}: no manifest written`);
      assert.equal(git.asked.includes('rev-parse HEAD'), false, `${label}: no commit named`);
    }
    assert.throws(() => record({ root: a.root, git: fakeGit({ status: 128 }), now }), /git status failed/, 'not a checkout git can read: nothing recorded');
    assert.equal(existsSync(manifest), false);

    const clean = fakeGit();
    assert.equal(record({ root: a.root, git: clean, now }).gitHead, HEAD);
    assert.deepEqual(
      clean.asked,
      ['status --porcelain --untracked-files=no', 'ls-files --others --exclude-standard --full-name', 'rev-parse HEAD'],
      'changed tracked files anywhere in the repository, untracked ones under app/, and only then HEAD',
    );
  } finally {
    a.done();
  }
});

test('a deploy verifies first and runs only the pinned wrangler on ./dist; production waits until preview has had the same digest', () => {
  const a = app();
  const calls = [];
  const run = (args) => (calls.push(args), 0);
  try {
    const manifest = record({ root: a.root, git: fakeGit(), now });
    assert.throws(() => deploy('production', { root: a.root, run, now }), /already deployed to preview/);
    assert.deepEqual(calls, [], 'refused before wrangler ran');

    deploy('preview', { root: a.root, run, now });
    deploy('production', { root: a.root, run, now });
    assert.deepEqual(calls, [
      ['--yes', WRANGLER, 'pages', 'deploy', './dist', '--branch', 'preview', '--commit-hash', HEAD],
      ['--yes', WRANGLER, 'pages', 'deploy', './dist', '--branch', 'main', '--commit-hash', HEAD],
    ]);
    assert.deepEqual(deployCommand('preview', manifest), calls[0]);
    const history = JSON.parse(readFileSync(join(a.root, '.release/deployed.json'), 'utf8'));
    assert.deepEqual(history.map((entry) => [entry.target, entry.digest]), [['preview', manifest.digest], ['production', manifest.digest]]);

    // One changed byte after preview: nothing is deployed anywhere.
    a.put('dist/index.html', `${BASE['dist/index.html']} `);
    assert.throws(() => deploy('production', { root: a.root, run, now }), /not what was recorded/);
    // Rebuilt and recorded again: a new digest, which preview has not had.
    record({ root: a.root, git: fakeGit(), now });
    assert.throws(() => deploy('production', { root: a.root, run, now }), /already deployed to preview/);
    assert.equal(calls.length, 2);

    // wrangler failing records nothing.
    assert.throws(() => deploy('preview', { root: a.root, run: () => 1, now }), /wrangler exited with 1/);
    assert.equal(JSON.parse(readFileSync(join(a.root, '.release/deployed.json'), 'utf8')).length, 2);
    assert.throws(() => deploy('staging', { root: a.root, run, now }), /Unknown target/);
  } finally {
    a.done();
  }
});

test('a tree of plain files records, verifies and deploys; a link added under dist afterwards is refused by name, and nothing more is deployed', () => {
  const a = app();
  const calls = [];
  const run = (args) => (calls.push(args), 0);
  try {
    const manifest = record({ root: a.root, git: fakeGit(), now });
    assert.equal(verify({ root: a.root }).ok, true, 'the happy path: plain files in plain directories');
    deploy('preview', { root: a.root, run, now });
    assert.deepEqual(calls.length, 1, 'the recorded dist went to preview');

    // A link is neither isFile() nor isDirectory(), so hashing and the marker
    // scan both passed over it, while wrangler's walker calls fs.stat, follows
    // it and uploads what it points at. Preview has already had this digest,
    // so what refuses production below is the link, not the preview rule.
    const planted = plantAsset(a.root);
    const checked = verify({ root: a.root });
    assert.equal(checked.ok, false, 'a link in the tree is not the recorded release');
    assert.equal(checked.digest, null, 'and no digest is offered for a tree that cannot be hashed as it will be walked');
    assert.equal(checked.problems.length, 1);
    assert.ok(checked.problems[0].startsWith(planted), `the offending path is named: ${checked.problems[0]}`);
    assert.match(checked.problems[0], /not a regular file or directory/);

    for (const target of ['preview', 'production']) {
      assert.throws(
        () => deploy(target, { root: a.root, run, now }),
        (error) => /not what was recorded/.test(error.message) && error.message.includes(planted),
        `${target} is refused, and says which path did it`,
      );
    }
    assert.equal(calls.length, 1, 'the runner was never invoked again');
    assert.equal(JSON.parse(readFileSync(join(a.root, '.release/deployed.json'), 'utf8')).length, 1, 'and nothing more is recorded as deployed');
    assert.equal(verify({ root: a.root }).manifest.digest, manifest.digest, 'the record itself is untouched');
  } finally {
    a.done();
  }
});

test('a link under dist at record time is refused: no manifest, and the checkout is not even questioned', () => {
  const a = app();
  const git = fakeGit();
  try {
    const planted = plantAsset(a.root);
    assert.throws(
      () => record({ root: a.root, git, now }),
      (error) => error.message.startsWith(planted) && /not a regular file or directory/.test(error.message),
      'record names the link, not the marker it hides',
    );
    assert.equal(existsSync(join(a.root, '.release/manifest.json')), false, 'nothing recorded');
    assert.deepEqual(git.asked, [], 'refused before git was asked anything');
    assert.equal(verify({ root: a.root }).ok, false, 'no record, nothing verifies');
  } finally {
    a.done();
  }
});

test('an input root that is itself a link is refused by name, at record, at verify and so at deploy', () => {
  for (const [name, type] of [
    ['dist', 'junction'],
    ['functions', 'junction'],
    ['wrangler.toml', 'file'],
  ]) {
    const a = app();
    const calls = [];
    const run = (args) => (calls.push(args), 0);
    try {
      const manifest = record({ root: a.root, git: fakeGit(), now });
      // Where the platform refuses a link to a file, the directory roots make the point.
      if (!linkRoot(a.root, name, type)) continue;

      const checked = verify({ root: a.root });
      assert.equal(checked.ok, false, `${name}: a linked root is not the recorded release`);
      assert.ok(checked.problems[0].startsWith(name), `${name}: the offending root is named: ${checked.problems[0]}`);
      assert.throws(() => deploy('preview', { root: a.root, run, now }), (error) => error.message.includes(name), `${name}: deploy refuses`);
      assert.deepEqual(calls, [], `${name}: the runner was not invoked`);

      assert.throws(() => record({ root: a.root, git: fakeGit(), now }), (error) => error.message.startsWith(name), `${name}: record refuses`);
      assert.deepEqual(JSON.parse(readFileSync(join(a.root, '.release/manifest.json'), 'utf8')), manifest, `${name}: the record is untouched`);
    } finally {
      a.done();
    }
  }
});

test('package.json builds once and deploys only what was recorded: no deploy script builds', () => {
  const { scripts } = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'));
  assert.equal(scripts['release:build'], 'npm run build && node scripts/release.mjs record');
  assert.equal(scripts['release:verify'], 'node scripts/release.mjs verify');
  assert.equal(scripts['deploy:preview'], 'node scripts/release.mjs deploy preview');
  assert.equal(scripts.deploy, 'node scripts/release.mjs deploy production');
  for (const name of ['deploy', 'deploy:preview']) assert.doesNotMatch(scripts[name], /build|wrangler/, name);
  assert.equal(WRANGLER, 'wrangler@4.130.0', 'the pin the previous deploy scripts used');
});

test('the README deploys production from the checkout that deployed the preview, whose release record is local, or from a new one after deploy:preview there', () => {
  const readme = readFileSync(resolve(import.meta.dirname, '../README.md'), 'utf8');
  // Compared with its line breaks as spaces: Markdown wraps anywhere.
  const release = readme.slice(readme.indexOf('**Deploying.**'), readme.indexOf('**After every Pages deploy')).replace(/\s+/g, ' ');
  assert.match(release, /Deploy production from the same checkout that deployed the preview\./);
  assert.match(release, /`\.release\/deployed\.json`, is written in that checkout and ignored by git/);
  assert.match(release, /In a new checkout, run `npm run release:build` and `npm run deploy:preview` there first/);
});

// 2026-09-26: the featured pools list's route (functions/api/read/v5/featured-pools.ts)
// is the first Pages Function to import a file from outside functions/, read-v5's
// runtime, and wrangler bundles what it imports at upload. The digest has to cover
// those bytes too, or a record could name a function the deploy does not upload.
test('the digest covers the files outside functions/ that a function imports, and each one is listed', () => {
  const parent = mkdtempSync(join(tmpdir(), 'domino-release-bundled-'));
  const root = join(parent, 'app');
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  // Changed on purpose 2026-10-01 (the chain2 workstream, part B): a bundled file may sit inside the app too (the chain
  // registry, src/config/chain*.ts, and src/lib/chain/csp.ts), so a bundled file is any the inventory lists outside
  // dist/ and functions/ but wrangler.toml.
  const bundledIn = (files) => Object.keys(files).filter((path) => !/^(?:dist|functions)\//.test(path) && path !== 'wrangler.toml');
  try {
    for (const [path, text] of Object.entries(BASE)) put(path, text);
    const without = inventory(root);
    assert.deepEqual(bundledIn(without.files), [], 'absent, nothing is listed');
    for (const path of BUNDLED) put(path, `// ${path}`);
    const one = inventory(root);
    assert.deepEqual(bundledIn(one.files), [...BUNDLED].sort());
    assert.notEqual(one.digest, without.digest);
    for (const path of BUNDLED) {
      put(path, `// ${path} changed`);
      assert.notEqual(inventory(root).digest, one.digest, `${path} is covered`);
      put(path, `// ${path}`);
    }
    assert.equal(inventory(root).digest, one.digest);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }

  // Every value import that leaves functions/, and every import those files make, is in BUNDLED. A TypeScript import
  // names its module without the extension (2026-10-01, the chain2 workstream, part B: the chain registry's).
  const app = resolve(import.meta.dirname, '..');
  const withExtension = (path) => (/\.(?:[cm]?[jt]s|json)$/.test(path) ? path : `${path}.ts`);
  const imports = (file) => [...readFileSync(file, 'utf8').matchAll(/\b(?:import|export)\s+(type\s+)?[^'"`]*?\bfrom\s+'([^']+)'/g)]
    .filter((match) => !match[1] && match[2].startsWith('.')).map((match) => withExtension(resolve(dirname(file), match[2])));
  const walk = (dir) => readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []);
  const functions = join(app, 'functions');
  const outside = new Set();
  const pending = walk(functions).flatMap(imports).filter((target) => !target.startsWith(functions + sep));
  while (pending.length) {
    const target = relative(app, pending.pop()).split(sep).join('/');
    if (outside.has(target)) continue;
    outside.add(target);
    pending.push(...imports(join(app, target)));
  }
  assert.deepEqual([...outside].sort(), [...BUNDLED].sort(), 'functions/ imports from outside itself exactly the listed files');
  assert.deepEqual(bundledIn(inventory(app).files), [...BUNDLED].sort());
});

// 2026-10-01 (platform workstream, D1): an open tab of the previous release finds its files in the new one.
test('carry: the previous release’s own files, reached from its page at any depth, join dist/assets, and nothing else', async () => {
  const { carry } = await import('../scripts/release.mjs');
  const next = app({ ...BASE, 'dist/assets/Shared-s.js': 'x' });
  const previous = app({
    'dist/index.html': '<script type="module" crossorigin src="/assets/index-old.js"></script><link rel="stylesheet" href="/assets/index-old.css">',
    'dist/assets/index-old.js': 'const m=()=>import("./Explore-old.js");new Worker(new URL("/assets/feesReplay.worker-old.js",import.meta.url))',
    'dist/assets/Explore-old.js': 'import"./Shared-s.js";import"./Deep-old.js"',
    'dist/assets/Deep-old.js': 'export const deep=1',
    'dist/assets/Shared-s.js': 'x',
    'dist/assets/index-old.css': '@font-face{src:url(/assets/geist-old.woff2)}',
    'dist/assets/geist-old.woff2': 'wOF2',
    'dist/assets/feesReplay.worker-old.js': 'self.onmessage=()=>{}',
    'dist/assets/Carried-older.js': 'from the release before it, which its page no longer names',
  });
  try {
    const result = carry(join(previous.root, 'dist'), { root: next.root });
    assert.deepEqual(result.carried, ['Deep-old.js', 'Explore-old.js', 'feesReplay.worker-old.js', 'geist-old.woff2', 'index-old.css', 'index-old.js']);
    assert.equal(result.reached, 7, 'Shared-s.js was reached, and is already there with the same bytes');
    const files = readdirSync(join(next.root, 'dist', 'assets')).sort();
    assert.ok(!files.includes('Carried-older.js'), 'what the previous release only carried is not carried again');
    assert.equal(readFileSync(join(next.root, 'dist', 'assets', 'Explore-old.js'), 'utf8'), 'import"./Shared-s.js";import"./Deep-old.js"');
    assert.equal(readFileSync(join(next.root, 'dist', 'index.html'), 'utf8'), BASE['dist/index.html'], 'the new page is untouched');
    // Twice is the same as once, and record covers the carried files.
    assert.deepEqual(carry(join(previous.root, 'dist'), { root: next.root }).carried, []);
    assert.ok(Object.keys(record({ root: next.root, git: fakeGit(), now }).files).includes('dist/assets/Explore-old.js'));

    // A name the new build has with other bytes, or a carried file with a forbidden marker, carries nothing.
    previous.put('dist/assets/Shared-s.js', 'other bytes');
    assert.throws(() => carry(join(previous.root, 'dist'), { root: next.root }), /exists with other bytes/);
    previous.put('dist/assets/Shared-s.js', 'x');
    previous.put('dist/assets/Deep-old.js', 'const banner = "Fixture build"');
    rmSync(join(next.root, 'dist', 'assets', 'Deep-old.js'));
    assert.throws(() => carry(join(previous.root, 'dist'), { root: next.root }), /must never ship/);
    assert.ok(!existsSync(join(next.root, 'dist', 'assets', 'Deep-old.js')), 'nothing was carried');
    assert.throws(() => carry(join(previous.root, 'nope'), { root: next.root }), /not a built dist/);
  } finally {
    next.done();
    previous.done();
  }
});
