import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin, type Rollup } from 'vite'
import { PREVIEW_SITE_FORBIDDEN, TEXT_FILE, assertDeployable, findForbidden } from './scripts/deploy-markers.mjs'
import { ROUTES } from './src/routeTable'
import { bootTags, type BootData } from './functions/_lib/boot'

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
 *   preview-v2                the site exactly as production builds it, with
 *                             Domino V2 compiled in: published by hand to the
 *                             preview alias only, never written to dist and
 *                             refused by every release (its page is marked)
 *   wallet-test-v2            wallet-test with Domino V2 compiled in: V1's
 *                             browser suites run on it with V2's gate open on
 *                             the test server's origin, as on the preview
 *                             alias (scripts/v1-on-v2.mjs), and V2's own browser
 *                             suites open its gate through window.__dominoV2Test
 *
 * Wallet sign-in itself is not a mode: the deployable modes carry it, because
 * it is part of what the site does. Only its probes are a mode of their own.
 *
 * Only a deployable mode may write to dist, which is what Pages deploys; the
 * guard below refuses any other there. No mode has sample data: there is none.
 *
 * Changed on purpose (data) 2026-10-02 (Domino V2 integration, the preview-v2 build): a key every row states, `site`:
 * the page is the real site for V1 (real wallets, the reviewed pools, live reads), so `__DOMINO_DEPLOYABLE__` is true
 * there: V1's deployment pin is insisted on (finance/pin.ts), no build banner is drawn, the chain is read
 * (lib/automationState.ts, automationImpact.ts, fees/answers.ts) and the boot script sends the list's first reads. The
 * two deployable modes are the site; so is preview-v2, which is never deployable (it carries V2) and is the site the
 * owner tests V1 on, so V1 there behaves exactly as on domino.money. Domino V2's FIXTURE contract sets are taken by the
 * builds that carry V2 and are not deployable (`__DOMINO_V2_FIXTURE_SETS__`, src/v2/flag.ts), preview-v2 included, up to
 * a review: every send and signature with one is refused outside the test builds (src/finance/v2/liveLock.ts).
 */
// wallet-test plus the onboarding previews (#38) at #/live-preview and the
// deposit consumer's fixture lab (#40/#44) at #/deposits, for the browser
// tests' fake services only. No build sends a deposit anywhere, and none
// can: there is no live deposit transport and no wallet send.
// Changed on purpose (data) 2026-10-02 (Domino V2 integration, the base agent's item 6): the old fixture-only `v2-preview`
// mode and its separate #/v2 screens (src/v2ui) are gone: Domino V2 is integrated into the existing screens
// (src/v2in), built for the preview alias by preview-v2 and for the browser suites by wallet-test-v2 and v2-test.
// Changed on purpose 2026-10-04 (the owner: the site runs on Domino V2, deployed and pinned on every chain): production
// and development carry V2 (`v2: true`) with its pinned production manifests only, never its fixture sets.
const MODES = {
  production: { read: 'bridge', pools: 'selected', deployable: true, outDir: 'dist', lab: false, wallet: true, testHooks: false, preview: false, depositLab: false, v2: true, site: true },
  development: { read: 'bridge', pools: 'selected', deployable: true, outDir: 'dist', lab: false, wallet: true, testHooks: false, preview: false, depositLab: false, v2: true, site: true },
  fixtures: { read: 'fixture', pools: 'fixture', deployable: false, outDir: '.fixture-dist', lab: true, wallet: false, testHooks: false, preview: false, depositLab: false, v2: false, site: false },
  'bridge-test': { read: 'bridge', pools: 'fixture', deployable: false, outDir: '.bridge-dist', lab: false, wallet: false, testHooks: false, preview: false, depositLab: false, v2: false, site: false },
  'wallet-test': { read: 'bridge', pools: 'fixture', deployable: false, outDir: '.wallet-test-dist', lab: false, wallet: true, testHooks: true, preview: false, depositLab: false, v2: false, site: false },
  'consumer-test': { read: 'bridge', pools: 'fixture', deployable: false, outDir: '.consumer-test-dist', lab: false, wallet: true, testHooks: true, preview: true, depositLab: true, v2: false, site: false },
  'v2-test': { read: 'bridge', pools: 'fixture', deployable: false, outDir: '.v2-test-dist', lab: false, wallet: true, testHooks: true, preview: false, depositLab: false, v2: true, site: false },
  'preview-v2': { read: 'bridge', pools: 'selected', deployable: false, outDir: '.preview-v2-dist', lab: false, wallet: true, testHooks: false, preview: false, depositLab: false, v2: true, site: true },
  'wallet-test-v2': { read: 'bridge', pools: 'fixture', deployable: false, outDir: '.wallet-test-v2-dist', lab: false, wallet: true, testHooks: true, preview: false, depositLab: false, v2: true, site: false },
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

/**
 * Changed on purpose (data) 2026-10-02 (Domino V2 integration, the preview-v2 build): the site a build that is not
 * deployable still publishes (`site`, preview-v2: the preview alias, real wallets) carries none of what a real site must
 * never carry, whatever else it holds: no local-development boundary, no test hooks, no lab, no node secret, no public
 * RPC (scripts/deploy-markers.mjs PREVIEW_SITE_FORBIDDEN). V2 itself (its screens behind the bare `__DOMINO_V2__` define
 * and the page's V2 mark; no test data: real data only, the owner, 2026-10-02) is what it may carry; it is refused by
 * every release for it. Checked over what Rollup emits and over the whole output directory, as the deployable check is.
 */
function previewSiteBundleCheck(mode: string, active: boolean): Plugin {
  const scan = (text: string) => findForbidden(text).filter((hit) => PREVIEW_SITE_FORBIDDEN.has(hit.marker))
  const refuse = (hits: string[]) => {
    throw new Error(`The ${mode} build is published as the site and carries what a site must never carry:\n${hits.join('\n')}`)
  }
  let outDir = ''
  return {
    name: 'domino:preview-site-bundle-check',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    generateBundle(_options, bundle) {
      if (!active) return
      const hits: string[] = []
      for (const [file, output] of Object.entries(bundle)) {
        if (!TEXT_FILE.test(file)) continue
        const text = output.type === 'chunk' ? output.code : typeof output.source === 'string' ? output.source : new TextDecoder().decode(output.source)
        for (const hit of scan(text)) hits.push(`${file}: ${hit.marker} in "${hit.context}"`)
      }
      if (hits.length > 0) refuse(hits)
    },
    closeBundle() {
      if (!active) return
      const hits: string[] = []
      for (const file of filesUnder(outDir)) {
        if (!TEXT_FILE.test(file)) continue
        for (const hit of scan(readFileSync(file, 'utf8'))) hits.push(`${relative(outDir, file)}: ${hit.marker} in "${hit.context}"`)
      }
      if (hits.length > 0) refuse(hits)
    },
  }
}

/**
 * The modules each route's screen is drawn by, beyond the entry (2026-10-01, platform workstream, F1/F2): the screens
 * are chunks of their own (src/App.tsx). `position` is a position's own page, #/positions/<id>. A module a build does not
 * carry (the wallet's list and the money screens, in a build without the wallet) is passed over. Changed on purpose
 * 2026-10-01 (RPC-SPEC): the wallet's list and a position's page no longer load the chain code (they ask the site's own
 * chain routes, lib/edge/chainRoutes.ts), so its chunk is no longer preloaded for them.
 */
export const ROUTE_MODULES: Readonly<Record<string, readonly string[]>> = {
  // Changed on purpose (2026-10-30, QA round 2, Q2: Markets and New position loaded in two steps, the screen's chunk and
  // then the V2 wrapper it opens lazily and draws in every V2 build, so their pages stood empty for seconds): the wrapper's
  // chunk too, fetched with the route's files, as the positions row does. A build without V2 passes it over.
  markets: ['src/screens/Explore.tsx', 'src/v2in/journey/MarketsNetworks.tsx'],
  pool: ['src/screens/PoolDetail.tsx'],
  // Changed on purpose (2026-10-15, pack 8, the Positions page's first visit): the V2 collection's chunk too (the list
  // every V2 build draws, which OwnedPositions asks for as it loads): fetched with the route's files, not after them,
  // a chain of three round trips made one. A build without V2 carries no such module and passes it over.
  positions: ['src/screens/Positions.tsx', 'src/components/positions/OwnedPositions.tsx', 'src/v2in/lists/OwnedRows.tsx'],
  position: ['src/screens/Positions.tsx', 'src/screens/PositionDetail.tsx'],
  new: ['src/screens/NewPosition.tsx', 'src/v2in/journey/NewPositionV2.tsx'],
  automate: ['src/screens/Automate.tsx'],
  docs: ['src/screens/Docs.tsx'],
  setup: ['src/screens/Setup.tsx'],
  sequence: ['src/screens/Sequence.tsx'],
  // The second chain's section, #/elysium…, has no row (2026-10-01, fix round 1): the same build is served on
  // domino.money, where that route is not found (src/App.tsx ELYSIUM_OPEN), so the page never preloads its chunk there.
  // On the preview alias the app's own loader asks for it when the route opens.
}

/** A module id as a path under app/, with forward slashes. */
const appPath = (id: string | null | undefined) => (id ? relative(here('.'), id).split(sep).join('/') : '')

/**
 * Per route, the files its screen needs that the entry does not load (its chunk, the chunks those import, and the
 * stylesheets of them all), as the page asks for them: `/assets/...`. Empty in the dev server, which has no bundle.
 */
export function routeChunks(bundle: Rollup.OutputBundle | undefined): Record<string, string[]> {
  if (!bundle) return {}
  const chunks = Object.values(bundle).filter((output): output is Rollup.OutputChunk => output.type === 'chunk')
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]))
  const closure = (roots: Rollup.OutputChunk[]) => {
    const found: Rollup.OutputChunk[] = []
    const seen = new Set<string>()
    const visit = (chunk: Rollup.OutputChunk | undefined) => {
      if (!chunk || seen.has(chunk.fileName)) return
      seen.add(chunk.fileName)
      found.push(chunk)
      for (const name of chunk.imports) visit(byName.get(name))
    }
    roots.forEach(visit)
    return found
  }
  const css = (list: Rollup.OutputChunk[]) => list.flatMap((chunk) => [...((chunk as Rollup.OutputChunk & { viteMetadata?: { importedCss: Set<string> } }).viteMetadata?.importedCss ?? [])])
  const initial = closure(chunks.filter((chunk) => chunk.isEntry))
  const loaded = new Set([...initial.map((chunk) => chunk.fileName), ...css(initial)])
  const out: Record<string, string[]> = {}
  for (const [route, modules] of Object.entries(ROUTE_MODULES)) {
    // The chunk that holds the module: its facade, or, where Rollup merged it with modules it shares (no facade), the
    // chunk among whose modules it is.
    const roots = modules.flatMap((module) => chunks.filter((chunk) => chunk.moduleIds.some((id) => appPath(id) === module)))
    const needed = closure(roots)
    const files = [...new Set([...needed.map((chunk) => chunk.fileName), ...css(needed)])].filter((file) => !loaded.has(file))
    if (files.length > 0) out[route] = files.map((file) => `/${file}`)
  }
  return out
}

/**
 * The page's boot script and its table, before the app's own script (functions/_lib/boot.ts): the route's code asked
 * for at once in every build, and, in the build that reads the live list only (`early`), Home's and Markets' first two
 * reads (speed wave, item 10, 2026-09-28; until 2026-10-01 a file of its own, public/early-list.js), and on a first visit
 * the overview of the list's pools once those two answer (audit A7 b, 2026-10-01). The other builds'
 * pages read no list, or read it from a test's own service, which counts every request. The script is the same text in
 * every build, so the page's CSP admits it by its hash; only the data block beside it differs.
 */
function boot(early: boolean): Plugin {
  return {
    name: 'domino:boot',
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        if (!/(^|[\\/])index\.html$/.test(context?.filename ?? 'index.html')) return html
        const data: BootData = { early, pages: ROUTES, chunks: routeChunks(context?.bundle) }
        return html.replace('<script type="module"', `${bootTags(data)}\n    <script type="module"`)
      },
    },
  }
}

/**
 * A build with V2 on scans the integrated V2 modules for its CSS (Domino V2, 2026-10-02). styles/tokens.css keeps
 * `src/v2in` out of Tailwind's scan, so every other build's CSS is byte for byte what it was before V2; only in a build
 * with `__DOMINO_V2__` on is that one line taken out before Tailwind reads the file. A tokens.css without the line fails
 * the build rather than drawing the screens unstyled. Changed on purpose (data) 2026-10-02 (Domino V2 integration, item
 * 6): the old #/v2 screens (src/v2ui) and their line are gone.
 */
const V2IN_SOURCE_EXCLUSION = /^@source not '\.\.\/v2in';\r?$/m
function v2ScreensCss(): Plugin {
  return {
    name: 'domino:v2-screens-css',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]styles[\\/]tokens\.css$/.test(id.split('?')[0])) return null
      if (!V2IN_SOURCE_EXCLUSION.test(code)) throw new Error('styles/tokens.css no longer keeps src/v2in out of the scan.')
      return { code: code.replace(V2IN_SOURCE_EXCLUSION, ''), map: null }
    },
  }
}

/**
 * Changed on purpose (data) 2026-10-02 (Domino V2 integration, the preview-v2 build): the page of every build that
 * compiles V2 in says so on its root element, `<html data-v2-build="<mode>">`, a marker scripts/deploy-markers.mjs refuses
 * in any release (`V2 build`): a preview-v2 dist copied into dist is never recorded or deployed by scripts/release.mjs,
 * and a deployable build that ever compiled V2 in fails its own bundle check. A page without its root element fails the
 * build rather than going unmarked.
 */
export const V2_BUILD_MARK = 'data-v2-build'
function v2BuildMark(mode: string): Plugin {
  return {
    name: 'domino:v2-build-mark',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (!/<html\b/.test(html)) throw new Error(`The ${mode} page has no <html> element to mark as a V2 build.`)
        return html.replace(/<html\b/, `<html ${V2_BUILD_MARK}="${mode}"`)
      },
    },
  }
}

/**
 * Two chunks that change far less often than the app (2026-10-01, platform workstream, F4), so a returning visitor keeps
 * them across releases instead of downloading them again inside the entry, whose name changes with every app change:
 * React, React DOM and their scheduler (they change only with the lockfile), and the read contracts' runtimes the entry
 * validates every read with (read-v1, v2, v3 and v5; they change only with api-contracts/). Both were in the entry
 * already, so a first visit downloads nothing more; read-v4's runtime, which only lazy screens use, stays out of them.
 */
export function vendorChunk(id: string): string | undefined {
  if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react'
  if (/[\\/]api-contracts[\\/]read-v[1235][\\/]runtime\.mjs$/.test(id)) return 'read-contracts'
  return undefined
}

export default defineConfig(({ mode, command }) => {
  // A local-live server is created only by the guarded native launcher. It
  // must never become an alternate build output or an ordinary Vite listener.
  const localLive = mode === 'local-live'
  if (localLive && command === 'build') throw new Error('local-live is serve-only and cannot be built or released.')
  if (!localLive && !Object.hasOwn(MODES, mode)) {
    throw new Error(`Unknown mode "${mode}". Use production, development, fixtures, bridge-test, wallet-test, consumer-test, v2-test, preview-v2 or wallet-test-v2.`)
  }
  // Changed on purpose (data) 2026-10-02 (Domino V2 integration): local-live is development's row served locally, and
  // not the site (`site: false`): its V1 stays what it was.
  const settings = localLive
    ? { ...MODES.development, deployable: false, wallet: false, site: false }
    : MODES[mode as keyof typeof MODES]
  // The page is the real site for V1 (the MODES note): the deployable builds, and preview-v2.
  const site = settings.deployable || settings.site
  return {
    // Changed on purpose 2026-10-04 (the owner: the site runs on Domino V2): a deployable build carries V2's screens but
    // never the V2 build mark, which marks the builds that take V2's test data (preview-v2, the test builds) and which
    // every release refuses.
    plugins: [react(), ...(settings.v2 ? [v2ScreensCss(), ...(settings.deployable ? [] : [v2BuildMark(mode)])] : []), tailwindcss(), boot(!localLive && site && settings.pools === 'selected'), ...(localLive ? [{ name: 'domino:local-live-launcher-only', configResolved(config: { server: { middlewareMode: unknown } }) { if (!config.server.middlewareMode) throw new Error('Use npm run dev:live; local-live requires the guarded launcher.') } }] : [deployableOnlyInDist(mode, settings.deployable)]), deployableBundleCheck(mode, settings.deployable), previewSiteBundleCheck(mode, !localLive && !settings.deployable && settings.site)],
    define: {
      __DOMINO_READ_MODE__: JSON.stringify(settings.read),
      __DOMINO_POOL_SET__: JSON.stringify(settings.pools),
      // Changed on purpose (data) 2026-10-02 (Domino V2 integration): true where the page is the real site for V1, the
      // deployable builds and preview-v2 (`site`); written for every mode, so no dist can be missing it.
      __DOMINO_DEPLOYABLE__: JSON.stringify(settings.deployable || settings.site),
      // Wallet sign-in ships; its probes do not. Both are literals, so the
      // chunk behind the first is emitted only where it is true, and the code
      // behind the second disappears from every build but wallet-test.
      __DOMINO_WALLET_SESSION__: JSON.stringify(settings.wallet),
      __DOMINO_TEST_HOOKS__: JSON.stringify(settings.testHooks),
      __DOMINO_LOCAL_LIVE__: JSON.stringify(localLive),
      // The onboarding previews (#38) and the deposit consumer's fixture lab
      // (#40/#44): true only in consumer-test. Literals, so the screens behind
      // them, their validators, fixtures and copy leave every other build,
      // including the one that deploys.
      __DOMINO_ONBOARDING_PREVIEW__: JSON.stringify(settings.preview),
      __DOMINO_DEPOSIT_LAB__: JSON.stringify(settings.depositLab),
      // Domino V2 (spec F7): true in the builds that carry it. Changed on purpose 2026-10-04 (the owner: the site runs on
      // V2): the deployable builds too. A literal, so V2's screens and clients leave every build without it.
      __DOMINO_V2__: JSON.stringify(settings.v2),
      // Changed on purpose (data) 2026-10-02 (Domino V2 integration): whether the build takes V2's FIXTURE contract sets
      // (src/v2/flag.ts): the builds that carry V2 and are not deployable. Written for every mode.
      __DOMINO_V2_FIXTURE_SETS__: JSON.stringify(settings.v2 && !settings.deployable),
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
      // The consumer-test build records which chunk holds which module, so
      // tests/consumer.bundle.test.mjs can scan the preview and deposit chunks
      // and prove neither reaches the build that deploys.
      manifest: settings.preview || settings.depositLab,
      // The site's fonts (src/styles/fonts.css, 2026-09-28) are always files of their own under /assets/, never data:
      // URLs: the page's CSP admits fonts from 'self' only (functions/_middleware.ts APP_CSP). Every other asset keeps
      // Vite's default 4 KiB rule.
      assetsInlineLimit: (file: string) => (file.endsWith('.woff2') ? false : undefined),
      rollupOptions: {
        ...(settings.lab ? { input: { main: here('./index.html'), lab: here('./read-lab.html') } } : {}),
        output: { manualChunks: vendorChunk },
      },
    },
  }
})
