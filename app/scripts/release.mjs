/**
 * Build once, record what was built, deploy exactly that: first to the gated
 * preview, then, unchanged, to production.
 *
 *   npm run release:build          npm run build, then record
 *   node scripts/release.mjs carry <previous dist>
 *                                  between the build and record: the previous
 *                                  release's own files, for tabs still open on it
 *   npm run release:verify         does dist still match the record?
 *   npm run deploy:preview         verify, then upload dist as a preview
 *   npm run deploy                 verify, then upload the same dist as production
 *
 * `record` refuses a dist that carries any forbidden marker
 * (scripts/deploy-markers.mjs), and a checkout with uncommitted changes, so
 * the commit it records, which every deploy passes as --commit-hash, is the
 * one dist was built from. It hashes every file of dist, functions/ and
 * wrangler.toml, plus the few files outside functions/ that wrangler bundles
 * into them (BUNDLED), by SHA-256 over sorted relative paths, into one tree digest and
 * writes .release/manifest.json. `verify` recomputes both and fails on any
 * difference. `deploy` verifies first and uploads ./dist with no build step
 * of its own, so what is deployed is what was recorded. wrangler compiles
 * functions/ at upload, which is why their sources are in the digest.
 * Production is refused unless .release/deployed.json shows the same digest
 * deployed to preview; every deploy appends its record there.
 *
 * Every entry it walks, the input roots (dist, functions/, wrangler.toml)
 * included, must be a regular file or a directory. A symlink, junction,
 * socket, fifo or device is refused by name at record, at verify and so at
 * deploy: wrangler's own Pages walker calls fs.stat, which follows links, so
 * a link left in the tree would upload bytes no digest here ever covered.
 *
 * A local deploy needs `npx wrangler login` in the owner's own terminal, and
 * nothing in this file holds or asks for a credential. No test runs `deploy`:
 * tests/release.test.mjs injects its own runner. One CI job does deploy, and
 * normally to the gated preview after all checks pass on main. PR #393's
 * explicitly authorized release also publishes production from that same
 * recorded digest; other main commits retain preview-only publication. CI
 * authenticates with a scoped CLOUDFLARE_API_TOKEN read from repository
 * secrets at that step, never with a stored login. The manually dispatched
 * read-path release can also publish production, using the same credential
 * and the same recorded digest already uploaded to preview in that job.
 * The project name comes from wrangler.toml, as before.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TEXT_FILE, findForbidden } from './deploy-markers.mjs'

/** The pinned wrangler, fetched by npx at upload time, including preview CI. */
export const WRANGLER = 'wrangler@4.130.0'
/** Pages branch per target: `preview` is the gated preview alias, `main` the production branch. */
const BRANCH = { preview: 'preview', production: 'main' }

const APP = resolve(import.meta.dirname, '..')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/**
 * A path a release may not hold: one that is neither a regular file nor a
 * directory. A symlink, junction, socket, fifo or device answers false to
 * both isFile() and isDirectory(), so a walker that asks only those two
 * questions passes over it in silence, while wrangler's Pages walker calls
 * fs.stat, follows it, and uploads what it points at. Refusing it by name
 * keeps the bytes that are hashed and the bytes that are uploaded one set.
 */
export class UnsupportedEntryError extends Error {
  constructor(path, kind) {
    super(`${path} is ${kind}, not a regular file or directory: a release holds only regular files and directories.`)
    this.name = 'UnsupportedEntryError'
    this.path = path
  }
}

/** What lstat says a path is, for the refusal to name it by. */
function kindOf(stat) {
  if (stat.isSymbolicLink()) return 'a symbolic link or junction'
  if (stat.isSocket()) return 'a socket'
  if (stat.isFIFO()) return 'a fifo'
  if (stat.isBlockDevice()) return 'a block device'
  if (stat.isCharacterDevice()) return 'a character device'
  return 'of an unsupported kind'
}

/** lstat, never stat, so a link is seen as a link and not as what it points at; null when nothing is there. */
function entryStat(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  }
}

/** `stat` back, once `path` is known to be a regular file or a directory; otherwise a refusal naming `path`. */
function regularOnly(root, path, stat) {
  if (stat.isFile() || stat.isDirectory()) return stat
  throw new UnsupportedEntryError(relative(root, path).split(sep).join('/'), kindOf(stat))
}

/**
 * Every file under `dir`, as paths relative to `root` with forward slashes.
 * Every entry met, `dir` itself included, must be a regular file or a
 * directory: anything else is refused, not passed over.
 */
function listFiles(root, dir) {
  const out = []
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name)
      if (regularOnly(root, path, lstatSync(path)).isDirectory()) walk(path)
      else out.push(relative(root, path).split(sep).join('/'))
    }
  }
  const stat = entryStat(dir)
  if (stat !== null) {
    regularOnly(root, dir, stat)
    walk(dir)
  }
  return out
}

/**
 * The files outside functions/ that a Pages Function imports, which wrangler
 * therefore compiles into the upload, relative to the app. Added 2026-09-26:
 * the featured pools list's route (functions/api/read/v5/featured-pools.ts)
 * checks each list with read-v5's runtime, which takes read-v1's error table.
 * tests/release.test.mjs fails when functions/ imports anything else from
 * outside itself, so no uploaded byte escapes the digest. Added 2026-09-28
 * (speed wave, item 45): the stored history's route (functions/api/read/v3/
 * history.ts) checks each answer with read-v3's runtime, which takes read-v1's
 * and read-v2's. Added 2026-10-01 (the chain2 workstream, part B, audit items
 * G3 and G4): the chain registry's modules (src/config/chain*.ts) and the CSP
 * lists generated from it (src/lib/chain/csp.ts): the middleware builds the
 * page's connect-src from them, and functions/_lib/owned.ts and fees.ts read
 * the chain's id, RPC and contracts there. Pure data and pure helpers. Added
 * 2026-10-02 (review of the RPC switch, finding 1): the second chain's
 * section's mode (src/chains/elysium/mode.ts), whose SECTION_READS decides
 * whether the preview's page CSP names that chain's RPC; it imports nothing
 * at run time. Added 2026-11-07 (Elysium as a fourth V2 chain): Elysium's
 * literals (src/lib/elysiumIdentity.ts), the registry's one import now, so V2's
 * chain list follows the build's switch; literals and the switch's define only,
 * importing nothing (a Function has no define, so it reads Elysium as off).
 * Added 2026-11-07 (edge hardening): read-v6's runtime, its generated schemas
 * and the closed-schema checker they share, which the two chain reads' routes
 * (functions/api/read/v6/chain-pools.ts and chain-tokens.ts) check each answer
 * with before it is kept or served.
 */
export const BUNDLED = Object.freeze([
  '../api-contracts/read-v1/runtime.mjs',
  '../api-contracts/read-v2/runtime.mjs',
  '../api-contracts/read-v3/runtime.mjs',
  '../api-contracts/read-v5/runtime.mjs',
  '../api-contracts/read-v6/runtime.mjs',
  '../api-contracts/read-v6/schema-data.mjs',
  '../api-contracts/shared/closed-schema.mjs',
  'src/chains/elysium/mode.ts',
  'src/config/chainElysium.ts',
  'src/config/chainIdentity.ts',
  'src/config/chainKit.ts',
  'src/config/chainRobinhood.ts',
  'src/config/chains.ts',
  'src/lib/chain/csp.ts',
  'src/lib/elysiumIdentity.ts',
])

/**
 * What a deploy uploads: every file of dist, the Pages Functions wrangler
 * compiles (functions/ and BUNDLED) and wrangler.toml, each with its SHA-256,
 * and one digest over the sorted list. The same bytes give the same digest,
 * whenever and in whatever order they were written.
 */
export function inventory(root = APP) {
  const paths = [...listFiles(root, join(root, 'dist')), ...listFiles(root, join(root, 'functions'))]
  for (const path of ['wrangler.toml', ...BUNDLED]) {
    const stat = entryStat(join(root, path))
    if (stat !== null && regularOnly(root, join(root, path), stat).isFile()) paths.push(path)
  }
  paths.sort()
  const files = Object.fromEntries(paths.map((path) => [path, sha256(readFileSync(join(root, path)))]))
  const digest = sha256(paths.map((path) => `${files[path]}  ${path}\n`).join(''))
  return { digest, files }
}

/** Every forbidden marker in dist's text files, as readable lines. */
export function scanDist(root = APP) {
  const hits = []
  for (const path of listFiles(root, join(root, 'dist'))) {
    if (!TEXT_FILE.test(path)) continue
    for (const hit of findForbidden(readFileSync(join(root, path), 'utf8'))) hits.push(`${path}: ${hit.marker} in "${hit.context}"`)
  }
  return hits
}

const manifestPath = (root) => join(root, '.release', 'manifest.json')
const deployedPath = (root) => join(root, '.release', 'deployed.json')

/** git, run in `root`: its exit status and what it printed. Tests inject their own, so git never runs there. */
function runGit(root) {
  return (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    return { status: result.status ?? 1, stdout: result.stdout ?? '' }
  }
}

function gitHead(git) {
  const result = git(['rev-parse', 'HEAD'])
  if (result.status !== 0) throw new Error('git rev-parse HEAD failed: record from a git checkout.')
  return result.stdout.trim()
}

/**
 * What the checkout holds that its HEAD does not, and a build could have
 * read: changed tracked files anywhere in the repository, staged or not,
 * deletions included (the build reads api-contracts/ too), and untracked
 * files under app/ that git does not ignore, which public/ alone would ship.
 * One line each, as git status writes them.
 */
export function uncommitted(git) {
  const tracked = git(['status', '--porcelain', '--untracked-files=no'])
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--full-name'])
  if (tracked.status !== 0 || untracked.status !== 0) throw new Error('git status failed: record from a git checkout.')
  const lines = (text) => text.split(/\r?\n/).filter((line) => line.trim() !== '')
  return [...lines(tracked.stdout), ...lines(untracked.stdout).map((path) => `?? ${path}`)]
}

/**
 * A tab opened before a release keeps running the old entry, which names the old release's files (2026-10-01, D1). Each
 * file under assets/ is named by its content, so the old ones can sit beside the new ones without colliding, and an
 * open tab finds them instead of a 404 (functions/_middleware.ts). `carry` copies them in: every file under
 * `previous`/assets/ that the previous release itself reaches from its page (its entry, the chunks, styles, fonts and
 * worker those name, at any depth), and nothing else, so a file the release before that carried is not carried again
 * and dist grows by one release at most. Run it between the build and `record`, which then hashes the carried files
 * with the rest:
 *
 *   npm run build && node scripts/release.mjs carry <previous release's dist> && node scripts/release.mjs record
 *
 * Refused: a previous dist without its page, an entry that is not a regular file, a carried name the new build also
 * has with other bytes, and a carried text file that carries a forbidden marker. A file of the same name and bytes is
 * already there and is left alone. The app reloads a tab once into the new release whenever a file is missing all the
 * same (src/lib/staleRelease.ts), so a release built without this step is still safe, only less smooth.
 */
export function carry(previous, { root = APP } = {}) {
  const from = resolve(previous)
  const page = join(from, 'index.html')
  if (!existsSync(page) || !entryStat(join(from, 'assets'))?.isDirectory()) throw new Error(`${from} is not a built dist: it has no index.html and assets/.`)
  if (!existsSync(join(root, 'dist', 'index.html'))) throw new Error('dist/index.html is missing: run `npm run build` first.')
  const names = listFiles(from, join(from, 'assets')).map((path) => path.slice('assets/'.length)).filter((name) => !name.includes('/'))
  const reached = new Set()
  const queue = [readFileSync(page, 'utf8')]
  while (queue.length > 0) {
    const text = queue.pop()
    for (const name of names) {
      if (reached.has(name) || !text.includes(name)) continue
      reached.add(name)
      if (TEXT_FILE.test(name)) queue.push(readFileSync(join(from, 'assets', name), 'utf8'))
    }
  }
  const carried = []
  const hits = []
  for (const name of [...reached].sort()) {
    const bytes = readFileSync(join(from, 'assets', name))
    const target = join(root, 'dist', 'assets', name)
    if (existsSync(target)) {
      if (!readFileSync(target).equals(bytes)) throw new Error(`dist/assets/${name} exists with other bytes than the previous release's: refusing to replace it.`)
      continue
    }
    if (TEXT_FILE.test(name)) for (const hit of findForbidden(bytes.toString('utf8'))) hits.push(`assets/${name}: ${hit.marker} in "${hit.context}"`)
    carried.push({ name, bytes })
  }
  if (hits.length > 0) throw new Error(`the previous release carries what must never ship, so nothing is carried:\n${hits.join('\n')}`)
  mkdirSync(join(root, 'dist', 'assets'), { recursive: true })
  for (const { name, bytes } of carried) writeFileSync(join(root, 'dist', 'assets', name), bytes)
  return { carried: carried.map(({ name }) => name), reached: reached.size }
}

/** Records dist as built. Refuses a missing or tainted dist, and a checkout whose commit is not what dist was built from. */
export function record({ root = APP, git = runGit(root), now = () => new Date() } = {}) {
  if (!existsSync(join(root, 'dist', 'index.html'))) throw new Error('dist/index.html is missing: run `npm run build` first.')
  const hits = scanDist(root)
  if (hits.length > 0) throw new Error(`dist carries what must never ship, so it is not recorded:\n${hits.join('\n')}`)
  // Every deploy passes the recorded commit as --commit-hash: it has to name the bytes that were built.
  const changes = uncommitted(git)
  if (changes.length > 0) {
    throw new Error(
      `The checkout has uncommitted changes, so its commit would not name what dist was built from. Commit or discard them, then run \`npm run release:build\` again:\n${changes.join('\n')}`,
    )
  }
  const { digest, files } = inventory(root)
  const manifest = { digest, gitHead: gitHead(git), builtAt: now().toISOString(), files }
  mkdirSync(join(root, '.release'), { recursive: true })
  writeFileSync(manifestPath(root), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

/** Whether dist, functions/ and wrangler.toml are byte for byte what was recorded, and still carry no forbidden marker. */
export function verify({ root = APP } = {}) {
  if (!existsSync(manifestPath(root))) return { ok: false, problems: ['no .release/manifest.json: run `npm run release:build` first'], manifest: null, digest: null }
  const manifest = JSON.parse(readFileSync(manifestPath(root), 'utf8'))
  let now
  try {
    now = inventory(root)
  } catch (error) {
    // A tree a deploy would walk differently than this did: there is no digest to compare, and nothing to deploy.
    if (!(error instanceof UnsupportedEntryError)) throw error
    return { ok: false, problems: [error.message], manifest, digest: null }
  }
  const problems = []
  for (const [path, hash] of Object.entries(manifest.files)) {
    if (!Object.hasOwn(now.files, path)) problems.push(`missing: ${path}`)
    else if (now.files[path] !== hash) problems.push(`changed: ${path}`)
  }
  for (const path of Object.keys(now.files)) if (!Object.hasOwn(manifest.files, path)) problems.push(`added: ${path}`)
  if (problems.length === 0 && now.digest !== manifest.digest) problems.push('the tree digest differs')
  problems.push(...scanDist(root).map((hit) => `forbidden: ${hit}`))
  return { ok: problems.length === 0, problems, manifest, digest: now.digest }
}

/** The one command a deploy runs: the pinned wrangler uploading ./dist as it is, tagged with the recorded commit. */
export function deployCommand(target, manifest) {
  return ['--yes', WRANGLER, 'pages', 'deploy', './dist', '--branch', BRANCH[target], '--commit-hash', manifest.gitHead]
}

function runNpx(args, root) {
  const result = spawnSync('npx', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  return result.status ?? 1
}

/** Verifies, then deploys the recorded dist. Production only after preview has had the same digest. */
export function deploy(target, { root = APP, run = runNpx, now = () => new Date() } = {}) {
  if (!Object.hasOwn(BRANCH, target)) throw new Error(`Unknown target "${target}": use preview or production.`)
  const checked = verify({ root })
  if (!checked.ok) throw new Error(`dist is not what was recorded, so nothing is deployed:\n${checked.problems.join('\n')}`)
  const { manifest } = checked
  const history = existsSync(deployedPath(root)) ? JSON.parse(readFileSync(deployedPath(root), 'utf8')) : []
  if (target === 'production' && !history.some((entry) => entry.target === 'preview' && entry.digest === manifest.digest)) {
    throw new Error(`Production only takes a dist already deployed to preview. Deploy ${manifest.digest} to preview first.`)
  }
  const status = run(deployCommand(target, manifest), root)
  if (status !== 0) throw new Error(`wrangler exited with ${status}; nothing is recorded as deployed.`)
  const entry = { target, digest: manifest.digest, gitHead: manifest.gitHead, deployedAt: now().toISOString() }
  writeFileSync(deployedPath(root), `${JSON.stringify([...history, entry], null, 2)}\n`)
  return entry
}

// Run directly: node scripts/release.mjs carry <previous dist> | record | verify | deploy <preview|production>
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, target] = process.argv.slice(2)
  try {
    if (command === 'carry') {
      if (!target) throw new Error("Usage: node scripts/release.mjs carry <previous release's dist>")
      const { carried, reached } = carry(target)
      console.log(`Carried ${carried.length} of the previous release's ${reached} files into dist/assets/.`)
    } else if (command === 'record') {
      const manifest = record()
      console.log(`Recorded dist ${manifest.digest}: ${Object.keys(manifest.files).length} files at commit ${manifest.gitHead}.`)
    } else if (command === 'verify') {
      const result = verify()
      if (!result.ok) {
        console.error(result.problems.join('\n'))
        process.exit(1)
      }
      console.log(`dist matches the record: ${result.digest}`)
    } else if (command === 'deploy') {
      const entry = deploy(target)
      console.log(`Deployed ${entry.digest} to ${entry.target}.`)
    } else {
      console.error('Usage: node scripts/release.mjs carry <previous dist> | record | verify | deploy <preview|production>')
      process.exit(2)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
