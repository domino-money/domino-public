/**
 * V1's browser suites on the V2-compiled wallet test build (Domino V2 integration, 2026-10-02, the base agent's item 3).
 *
 * The owner tests V1 on the preview alias, where the site carries V2 (the preview-v2 build) and V2's options appear
 * inside V1's screens. So V1's own suites run again on `wallet-test-v2`, the wallet-test build with V2 compiled in
 * (vite.config.ts MODES), with V2's gate open on the test server's origin in every page they open
 * (tests/support/v2-gate-open.mjs, loaded into each test process), and must pass there as they pass on wallet-test:
 *
 *   session   test:session's browser suite (sign-in, the session, the wallet dialog). test:pages is page-watch and render
 *             over the production dist, which carries no V2, then test:session and test:consumer (the onboarding
 *             previews' own build, which carries no V2): its V2 half is this family.
 *   finance   test:finance's suites (Create position, automation, charts, positions, a position's actions, fluidity).
 *
 * The suites are read from package.json's own test:session and test:finance, so the lists never drift apart: their
 * browser suites (`*.browser.test.mjs`), which check what V1 does. session.bundle.test.mjs is not one: it holds the
 * wallet-test and production bundles to their measured shape (every chunk in a measured closure, the hosts a chunk may
 * name), which a build with V2's chunks in it is not, by design; the production bundle stays held to it by test:session.
 *
 *   npm run test:v1-on-v2                      builds wallet-test-v2, then runs both families
 *   node scripts/v1-on-v2.mjs [session|finance]...   the families named (default: both) on the builds already made
 *
 * `DOMINO_WALLET_DIST=.wallet-test-v2-dist` points the suites' server at the V2 build (tests/support/wallet-dist.mjs).
 * Every node --test run passes --test-force-exit, as every browser suite's does (tests/build-guard.test.mjs).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const APP = resolve(import.meta.dirname, '..')

/** The V2-compiled wallet test build's directory, as tests/support/wallet-dist.mjs takes it. */
export const V2_WALLET_DIST = '.wallet-test-v2-dist'

/** The preload that opens V2's gate in every page a suite opens. */
export const GATE_OPEN = join(APP, 'tests/support/v2-gate-open.mjs')

/** The browser suites a package script's `node --test` runs, in its order. */
export function suitesOf(script) {
  if (typeof script !== 'string') throw new Error('no such package script')
  const files = []
  for (const part of script.split('&&').map((command) => command.trim().split(/\s+/))) {
    if (part[0] !== 'node' || !part.includes('--test')) continue
    files.push(...part.filter((word) => /^tests\/[\w./-]+\.browser\.test\.mjs$/.test(word)))
  }
  if (files.length === 0) throw new Error(`no browser suite in: ${script}`)
  return files
}

const { scripts } = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8'))

/** The V1 families this runs on the V2 build, from package.json's own scripts. */
export const FAMILIES = Object.freeze({
  session: suitesOf(scripts['test:session']),
  finance: suitesOf(scripts['test:finance']),
})

/** The environment the suites run in: the V2 build, and the preload in every test process. */
export function v1OnV2Env(base = process.env) {
  const preload = `--import=${pathToFileURL(GATE_OPEN).href}`
  return { ...base, DOMINO_WALLET_DIST: V2_WALLET_DIST, NODE_OPTIONS: [base.NODE_OPTIONS, preload].filter(Boolean).join(' ') }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const asked = process.argv.slice(2)
  const names = asked.length > 0 ? asked : Object.keys(FAMILIES)
  const unknown = names.filter((name) => !Object.hasOwn(FAMILIES, name))
  if (unknown.length > 0) {
    console.error(`Unknown family: ${unknown.join(', ')}. Use ${Object.keys(FAMILIES).join(' or ')}.`)
    process.exit(2)
  }
  if (!existsSync(join(APP, V2_WALLET_DIST, 'index.html'))) {
    console.error(`${V2_WALLET_DIST} is missing: run npm run build:wallet-test-v2 first (npm run test:v1-on-v2 does).`)
    process.exit(1)
  }
  const files = names.flatMap((name) => FAMILIES[name])
  const result = spawnSync(process.execPath, ['--test', '--test-force-exit', ...files], { cwd: APP, stdio: 'inherit', env: v1OnV2Env() })
  process.exit(result.status ?? 1)
}
