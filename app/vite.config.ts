import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'

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
 * Where read data comes from, per build mode. Only `--mode` selects it; no
 * environment variable does, so nothing on a build machine can switch it on.
 *
 *   production, development   today's labelled sample rows, no read code at all
 *   fixtures                  the package fixtures through the real pipeline,
 *                             plus the read lab (read-lab.html)
 *   bridge-test               the same-origin bridge, for a local stub only
 *
 * The read modes write to their own directories. Pages deploys ./dist, and the
 * guard below refuses to put anything but the sample build there.
 */
const MODES = {
  production: { read: 'sample', outDir: 'dist', lab: false },
  development: { read: 'sample', outDir: 'dist', lab: false },
  fixtures: { read: 'fixture', outDir: '.fixture-dist', lab: true },
  'bridge-test': { read: 'bridge', outDir: '.bridge-dist', lab: false },
} as const

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
 * Refuses a fixture or bridge-test build whose output would be deployed: into
 * dist itself, a subdirectory of it (`dist/lab` ships with the site, and so
 * does `dist/..lab`, whose name merely starts with two dots), or the same
 * directory spelled differently (`DIST`, `./dist/`, an absolute path, a
 * symlink or junction). tests/build-guard.test.mjs resolves this config with
 * each of those spellings, for every mode in MODES that has its own directory.
 */
function sampleOnlyInDist(read: string): Plugin {
  return {
    name: 'domino:sample-only-in-dist',
    configResolved(config) {
      if (read !== 'sample' && isWithin(resolve(config.root, config.build.outDir), DEPLOYED_DIR)) {
        throw new Error(`A ${read} build may not write to dist: that directory is what gets deployed.`)
      }
    },
  }
}

export default defineConfig(({ mode }) => {
  if (!Object.hasOwn(MODES, mode)) {
    throw new Error(`Unknown mode "${mode}". Use production, development, fixtures or bridge-test.`)
  }
  const settings = MODES[mode as keyof typeof MODES]
  return {
    plugins: [react(), tailwindcss(), sampleOnlyInDist(settings.read)],
    define: { __DOMINO_READ_MODE__: JSON.stringify(settings.read) },
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
