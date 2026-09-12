import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'
import { TEXT_FILE, assertDeployable, findForbidden } from './scripts/deploy-markers.mjs'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// `core` points at the workbench's domain modules. They belong to rugged97 and
// are consumed read-only: never copied into app/, never edited from here. A fix
// he makes in web/lib reaches this app without any action on our side.
//
// Those modules live under web/ and import React themselves. Node resolution
// would give them web/node_modules/react while this app renders with
// app/node_modules/react, so a hook called from web/lib would run against a
// second React with a null dispatcher. That is invisible in dev and produces a
// blank production page. React and React DOM are therefore pinned to this
// app's copies for every module in the graph, wherever it sits on disk.
//
// `api-contracts` is rugged97's shared contract packages, consumed the same
// way: types, runtime validators and fixtures, imported in place, never
// copied. src/lib/read/pin.ts records which bytes this build was tested with.
const reactRoot = here('./node_modules/react')
const reactDomRoot = here('./node_modules/react-dom')

/**
 * What each build mode reads and where it may write. Only `--mode` selects
 * it; no environment variable does, so nothing on a build machine can change
 * what a build reads.
 *
 *   production, development   deployable: live reads through the same-origin
 *                             bridge, from the reviewed pool selection
 *                             (src/config/selectedPools.ts). The dev server
 *                             has no /api, so it shows the not-connected state.
 *   fixtures                  the package fixtures through the real pipeline,
 *                             plus the read lab (read-lab.html)
 *   bridge-test               the bridge source, for the package fixture pool
 *                             a local stub serves
 *   wallet-test               the same, plus the wallet session's test probes,
 *                             for the browser tests' fake session service
 *
 * Wallet sign-in itself is not a mode: the deployable modes carry it, because
 * it is part of what the site does. Only its probes are a mode of their own.
 *
 * Only a deployable mode may write to dist, which is what Pages deploys; the
 * guard below refuses any other there. No mode has sample data: there is none.
 */
const MODES = {
  production: { read: 'bridge', pools: 'selected', deployable: true, outDir: 'dist', lab: false, wallet: true, testHooks: false },
  development: { read: 'bridge', pools: 'selected', deployable: true, outDir: 'dist', lab: false, wallet: true, testHooks: false },
  fixtures: { read: 'fixture', pools: 'fixture', deployable: false, outDir: '.fixture-dist', lab: true, wallet: false, testHooks: false },
  'bridge-test': { read: 'bridge', pools: 'fixture', deployable: false, outDir: '.bridge-dist', lab: false, wallet: false, testHooks: false },
  'wallet-test': { read: 'bridge', pools: 'fixture', deployable: false, outDir: '.wallet-test-dist', lab: false, wallet: true, testHooks: true },
} as const

// Every deployable row is checked whichever mode is built, so a production row
// that reads fixtures fails the fixture build too, not only its own. What a
// deployable mode may never be is in scripts/deploy-markers.mjs. The wallet
// session is now part of a deployable row; its test hooks are not, and are
// kept a separate flag precisely so a deployable row cannot carry them.
for (const [name, row] of Object.entries(MODES)) {
  if (row.deployable) assertDeployable(name, row)
}

/**
 * The directory as the file system resolves it: symlinks and junctions
 * followed on the longest part that exists, the rest appended as written.
 */
function onDisk(path: string): string {
  const tail: string[] = []
  let head = path
  while (!existsSync(head)) {
    const parent = dirname(head)
    if (parent === head) return path
    tail.unshift(basename(head))
    head = parent
  }
  return join(realpathSync.native(head), ...tail)
}

/**
 * Windows and macOS file systems ignore case by default, so `--outDir DIST`
 * is the same directory as `dist` there. Compare folded on those platforms.
 */
const foldCase = process.platform === 'win32' || process.platform === 'darwin'

/** Whether `dir` is `root` or anywhere inside it, as the file system sees them. */
export function isWithin(dir: string, root: string): boolean {
  const fold = (p: string) => (foldCase ? onDisk(p).toLowerCase() : onDisk(p))
  const rel = relative(fold(root), fold(dir))
  // Outside means a first segment of exactly `..`. `..lab` is a directory inside root.
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** What Pages deploys: `pages_build_output_dir` in wrangler.toml. */
export const DEPLOYED_DIR = here('./dist')

/**
 * Refuses a build that is not deployable whose output would be deployed: into
 * dist itself, a subdirectory of it (`dist/lab` ships with the site, and so
 * does `dist/..lab`, whose name merely starts with two dots), or the same
 * directory spelled differently (`DIST`, `./dist/`, an absolute path, a
 * symlink or junction). tests/build-guard.test.mjs resolves this config with
 * each of those spellings, for every mode in MODES that has its own directory.
 */
function deployableOnlyInDist(mode: string, deployable: boolean): Plugin {
  return {
    name: 'domino:deployable-only-in-dist',
    configResolved(config) {
      if (!deployable && isWithin(resolve(config.root, config.build.outDir), DEPLOYED_DIR)) {
        throw new Error(`A ${mode} build may not write to dist: that directory is what gets deployed.`)
      }
    },
  }
}

/** Every file under `dir`, at any depth. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]))
}

/**
 * Fails a deployable build that carries anything of sample, practice, fixture
 * or test-only code (scripts/deploy-markers.mjs): first over every script,
 * stylesheet and page Rollup emits, before anything is written, then over the
 * whole output directory once it is, public files included. A failing check
 * fails `vite build`, so npm run build, check:app and CI all enforce it.
 */
function deployableBundleCheck(mode: string, deployable: boolean): Plugin {
  const refuse = (hits: string[]) => {
    throw new Error(`The ${mode} build is deployable and carries what must never ship:\n${hits.join('\n')}`)
  }
  let outDir = ''
  return {
    name: 'domino:deployable-bundle-check',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    generateBundle(_options, bundle) {
      if (!deployable) return
      const hits: string[] = []
      for (const [file, output] of Object.entries(bundle)) {
        if (!TEXT_FILE.test(file)) continue
        const text = output.type === 'chunk' ? output.code : typeof output.source === 'string' ? output.source : new TextDecoder().decode(output.source)
        for (const hit of findForbidden(text)) hits.push(`${file}: ${hit.marker} in "${hit.context}"`)
      }
      if (hits.length > 0) refuse(hits)
    },
    closeBundle() {
      if (!deployable) return
      const hits: string[] = []
      for (const file of filesUnder(outDir)) {
        if (!TEXT_FILE.test(file)) continue
        for (const hit of findForbidden(readFileSync(file, 'utf8'))) hits.push(`${relative(outDir, file)}: ${hit.marker} in "${hit.context}"`)
      }
      if (hits.length > 0) refuse(hits)
    },
  }
}

export default defineConfig(({ mode }) => {
  if (!Object.hasOwn(MODES, mode)) {
    throw new Error(`Unknown mode "${mode}". Use production, development, fixtures, bridge-test or wallet-test.`)
  }
  const settings = MODES[mode as keyof typeof MODES]
  return {
    plugins: [react(), tailwindcss(), deployableOnlyInDist(mode, settings.deployable), deployableBundleCheck(mode, settings.deployable)],
    define: {
      __DOMINO_READ_MODE__: JSON.stringify(settings.read),
      __DOMINO_POOL_SET__: JSON.stringify(settings.pools),
      __DOMINO_DEPLOYABLE__: JSON.stringify(settings.deployable),
      // Wallet sign-in ships; its probes do not. Both are literals, so the
      // chunk behind the first is emitted only where it is true, and the code
      // behind the second disappears from every build but wallet-test.
      __DOMINO_WALLET_SESSION__: JSON.stringify(settings.wallet),
      __DOMINO_TEST_HOOKS__: JSON.stringify(settings.testHooks),
    },
    resolve: {
      dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
      alias: [
        { find: '@', replacement: here('./src') },
        { find: 'core', replacement: here('../web/lib') },
        { find: 'api-contracts', replacement: here('../api-contracts') },
        // Exact matches only, so react-dom/client and react/jsx-runtime still resolve.
        { find: /^react$/, replacement: reactRoot },
        { find: /^react-dom$/, replacement: reactDomRoot },
      ],
    },
    server: {
      port: 5273,
      // Required because `core` and `api-contracts` resolve outside this project root.
      fs: { allow: [here('.'), here('../web'), here('../api-contracts')] },
    },
    build: {
      outDir: settings.outDir,
      emptyOutDir: true,
      rollupOptions: settings.lab ? { input: { main: here('./index.html'), lab: here('./read-lab.html') } } : undefined,
    },
  }
})
